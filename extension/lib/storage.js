// lib/storage.js
// Role: read and write watt history, with an in-memory ring buffer in front of
// chrome.storage.local.
//
// Write strategy (why it is not a plain read-modify-write):
//   The old appendWatts read the entire history array out of chrome.storage.local,
//   pushed one entry, and wrote the whole array back — per report, forever.
//   Serializing a 2880-entry array every few seconds is real disk and
//   browser-process churn for one appended number.
//
//   Instead:
//     - the ring buffer lives IN MEMORY in the service worker;
//     - every append mirrors to chrome.storage.session (in-memory, cheap; it
//       survives worker restarts and nothing else, which is exactly the
//       durability we need to let the worker sleep);
//     - chrome.storage.local is flushed at most once per FLUSH_PERIOD_MIN via
//       chrome.alarms, plus once on runtime.onSuspend.
//   On startup we hydrate from session if present, else from local.
//
// Two keys are maintained side by side:
//
//   'wattsHistory' — raw ring buffer, Array of { ts, watts, site }
//     ts    — Unix timestamp in milliseconds (Date.now())
//     watts — estimated watt value at that moment (float, 2 dp)
//     site  — platform name ('openai') or bare hostname ('github.com'), or null
//     Kept in chronological order (oldest first), capped at MAX_ENTRIES.
//
//   'wattsDaily' — rollup for long-range trends, keyed 'YYYY-MM-DD':
//     { whTotal: number, bySite: { [site]: wh } }
//     The ring buffer alone can't answer "last week", so each append also
//     accrues its sample's energy here, where it survives buffer eviction.

const STORAGE_KEY = 'wattsHistory';
const DAILY_KEY   = 'wattsDaily';

const MAX_ENTRIES = 2880;

// Seconds of wall-clock each sample represents — must match the content
// script's REPORT_PERIOD_MS. Used to convert a watt sample into energy (Wh).
const SAMPLE_INTERVAL_S = 30;

// Days of rollup to retain; older keys are pruned on write.
const DAILY_RETENTION_DAYS = 30;

// How often the in-memory buffer is flushed to chrome.storage.local.
const FLUSH_PERIOD_MIN = 1;
const FLUSH_ALARM = 'ecoFlushHistory';

// Upper bound on a believable reading. Backend inference dominates the total —
// a DeepSeek-R1 session amortizes to several hundred watts — so this has to sit
// well above the frontend-only range or legitimate AI readings get dropped and
// the graph appears frozen.
const MAX_SANE_WATTS = 2000;

// ── In-memory state ────────────────────────────────────────────────────────

/** @type {Array<{ts:number, watts:number, site:string|null}>|null} */
let memHistory = null;
/** @type {Object<string, {whTotal:number, bySite:Object<string,number>}>|null} */
let memDaily = null;

/** Set when memory has changes not yet written to chrome.storage.local. */
let dirty = false;

/** Guards against two concurrent hydrations racing. */
let hydrating = null;

/** Local calendar date as 'YYYY-MM-DD' (not UTC — rollups are user-facing). */
function dayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Load the ring buffer into memory. Prefers chrome.storage.session (written on
 * every append, so it is the freshest) and falls back to chrome.storage.local
 * (written at most once a minute) on a cold start.
 */
async function hydrate() {
  if (memHistory !== null) return;
  if (hydrating) return hydrating;

  hydrating = (async () => {
    let history = null;
    let daily = null;

    try {
      const s = await chrome.storage.session.get([STORAGE_KEY, DAILY_KEY]);
      if (Array.isArray(s[STORAGE_KEY])) history = s[STORAGE_KEY];
      if (s[DAILY_KEY] && typeof s[DAILY_KEY] === 'object') daily = s[DAILY_KEY];
    } catch (_) {
      // storage.session unavailable — fall through to local.
    }

    if (history === null || daily === null) {
      const l = await chrome.storage.local.get([STORAGE_KEY, DAILY_KEY]);
      if (history === null) history = Array.isArray(l[STORAGE_KEY]) ? l[STORAGE_KEY] : [];
      if (daily === null) daily = (l[DAILY_KEY] && typeof l[DAILY_KEY] === 'object') ? l[DAILY_KEY] : {};
    }

    memHistory = history;
    memDaily = daily;
  })();

  try { await hydrating; } finally { hydrating = null; }
}

/**
 * Append a watt reading to history, trimming oldest entries if over the cap,
 * and accrue the sample's energy into the daily rollup.
 *
 * Writes to memory + chrome.storage.session synchronously-ish; chrome.storage.local
 * is written by flushToLocal() on the alarm.
 *
 * @param {number} watts
 * @param {string} [site] - platform name (e.g. 'openai'), hostname, or null
 * @returns {Promise<void>}
 */
async function appendWatts(watts, site = null) {
  if (!Number.isFinite(watts) || watts < 0 || watts > MAX_SANE_WATTS) return;

  await hydrate();

  const ts = Date.now();
  memHistory.push({ ts, watts, site });

  // Trim from the front to stay within the cap.
  if (memHistory.length > MAX_ENTRIES) {
    memHistory.splice(0, memHistory.length - MAX_ENTRIES);
  }

  // Energy this sample represents: W x hours = Wh.
  const wh = watts * (SAMPLE_INTERVAL_S / 3600);
  const key = dayKey(ts);
  const today = memDaily[key] ?? { whTotal: 0, bySite: {} };

  today.whTotal += wh;
  const siteKey = site ?? 'unknown';
  today.bySite[siteKey] = (today.bySite[siteKey] ?? 0) + wh;
  memDaily[key] = today;

  pruneDaily(memDaily, ts);

  dirty = true;

  // Mirror to session storage: in-memory in the browser process, so this is
  // cheap, and it is what lets the worker be killed between reports without
  // losing the buffer.
  try {
    await chrome.storage.session.set({
      [STORAGE_KEY]: memHistory,
      [DAILY_KEY]:   memDaily,
    });
  } catch (_) {}
}

/** Drop rollup days older than the retention window (mutates in place). */
function pruneDaily(daily, nowTs) {
  const cutoff = dayKey(nowTs - DAILY_RETENTION_DAYS * 86400000);
  for (const key of Object.keys(daily)) {
    if (key < cutoff) delete daily[key];   // 'YYYY-MM-DD' sorts chronologically
  }
}

/**
 * Write the in-memory buffer through to chrome.storage.local. No-op when
 * nothing changed since the last flush, so an idle browser does zero disk I/O.
 * @returns {Promise<boolean>} true if a write actually happened
 */
async function flushToLocal() {
  if (!dirty || memHistory === null) return false;
  dirty = false;
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY]: memHistory,
      [DAILY_KEY]:   memDaily,
    });
    return true;
  } catch (_) {
    dirty = true;   // let the next alarm retry
    return false;
  }
}

/**
 * Read the full watt history array, dropping entries outside the believable
 * range (corrupt values left by earlier versions of the watt calculation).
 * @returns {Promise<Array<{ ts: number, watts: number, site: string|null }>>}
 */
async function readHistory() {
  await hydrate();
  return memHistory.filter(e => Number.isFinite(e.watts) && e.watts <= MAX_SANE_WATTS);
}

/**
 * Read the daily rollup map, keyed 'YYYY-MM-DD'.
 * @returns {Promise<Object<string, { whTotal: number, bySite: Object<string, number> }>>}
 */
async function readDaily() {
  await hydrate();
  return memDaily;
}

/**
 * Clear all stored history, including daily rollups, in memory and both stores.
 * @returns {Promise<void>}
 */
async function clearHistory() {
  memHistory = [];
  memDaily = {};
  dirty = false;
  await chrome.storage.local.remove([STORAGE_KEY, DAILY_KEY]);
  try { await chrome.storage.session.remove([STORAGE_KEY, DAILY_KEY]); } catch (_) {}
}
