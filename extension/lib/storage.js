// lib/storage.js
// Role: read and write watt history in chrome.storage.local.
//
// Two keys are maintained side by side:
//
//   'wattsHistory' — raw ring buffer, Array of { ts, watts, site }
//     ts    — Unix timestamp in milliseconds (Date.now())
//     watts — estimated watt value at that moment (float, 2 dp)
//     site  — platform name ('openai') or bare hostname ('github.com'), or null
//     Kept in chronological order (oldest first), capped at MAX_ENTRIES.
//     At 10-second sampling of the active tab: 2880 entries ≈ 8 hours.
//
//   'wattsDaily' — rollup for long-range trends, keyed 'YYYY-MM-DD':
//     { whTotal: number, bySite: { [site]: wh } }
//     The ring buffer alone can't answer "last week", so each append also
//     accrues its sample's energy here, where it survives buffer eviction.

const STORAGE_KEY = 'wattsHistory';
const DAILY_KEY   = 'wattsDaily';

const MAX_ENTRIES = 2880;

// Seconds of wall-clock each sample represents (content script cadence).
const SAMPLE_INTERVAL_S = 10;

// Days of rollup to retain; older keys are pruned on write.
const DAILY_RETENTION_DAYS = 30;

// Upper bound on a believable reading. Backend inference dominates the total —
// a DeepSeek-R1 session amortizes to several hundred watts — so this has to sit
// well above the frontend-only range or legitimate AI readings get dropped and
// the graph appears frozen.
const MAX_SANE_WATTS = 2000;

/** Local calendar date as 'YYYY-MM-DD' (not UTC — rollups are user-facing). */
function dayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Append a watt reading to history, trimming oldest entries if over the cap,
 * and accrue the sample's energy into the daily rollup.
 * @param {number} watts
 * @param {string} [site] - platform name (e.g. 'openai'), hostname, or null
 * @returns {Promise<void>}
 */
async function appendWatts(watts, site = null) {
  if (!Number.isFinite(watts) || watts < 0 || watts > MAX_SANE_WATTS) return;

  const ts = Date.now();
  const data = await chrome.storage.local.get([STORAGE_KEY, DAILY_KEY]);

  const history = data[STORAGE_KEY] ?? [];
  history.push({ ts, watts, site });

  // Trim from the front to stay within the cap.
  if (history.length > MAX_ENTRIES) {
    history.splice(0, history.length - MAX_ENTRIES);
  }

  // Energy this sample represents: W x hours = Wh.
  const wh = watts * (SAMPLE_INTERVAL_S / 3600);
  const daily = data[DAILY_KEY] ?? {};
  const key = dayKey(ts);
  const today = daily[key] ?? { whTotal: 0, bySite: {} };

  today.whTotal += wh;
  const siteKey = site ?? 'unknown';
  today.bySite[siteKey] = (today.bySite[siteKey] ?? 0) + wh;
  daily[key] = today;

  pruneDaily(daily, ts);

  await chrome.storage.local.set({ [STORAGE_KEY]: history, [DAILY_KEY]: daily });
}

/** Drop rollup days older than the retention window (mutates in place). */
function pruneDaily(daily, nowTs) {
  const cutoff = dayKey(nowTs - DAILY_RETENTION_DAYS * 86400000);
  for (const key of Object.keys(daily)) {
    if (key < cutoff) delete daily[key];   // 'YYYY-MM-DD' sorts chronologically
  }
}

/**
 * Read the full watt history array, dropping entries outside the believable
 * range (corrupt values left by earlier versions of the watt calculation).
 * @returns {Promise<Array<{ ts: number, watts: number, site: string|null }>>}
 */
async function readHistory() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const history = data[STORAGE_KEY] ?? [];
  return history.filter(e => Number.isFinite(e.watts) && e.watts <= MAX_SANE_WATTS);
}

/**
 * Read the daily rollup map, keyed 'YYYY-MM-DD'.
 * @returns {Promise<Object<string, { whTotal: number, bySite: Object<string, number> }>>}
 */
async function readDaily() {
  const data = await chrome.storage.local.get(DAILY_KEY);
  return data[DAILY_KEY] ?? {};
}

/**
 * Clear all stored history, including daily rollups.
 * @returns {Promise<void>}
 */
async function clearHistory() {
  await chrome.storage.local.remove([STORAGE_KEY, DAILY_KEY]);
}
