// background/service-worker.js
// Role: receive metrics from content scripts, store latest per tab, persist watt history.
// Also detects AI sites and folds backend AI energy into the total watt reading.

importScripts(
  '../lib/energy-estimator.js',
  '../lib/storage.js',
  '../lib/ai-energy-database.js',
);

// ── State ──────────────────────────────────────────────────────────────────

// tabMetrics maps tabId -> latest raw metrics from content script (in-memory)
const tabMetrics = {};

// tabAI maps tabId -> { detection result, watts, modelKey } (in-memory)
const tabAI = {};

// tabTotalWatts maps tabId -> last computed totalWatts (frontend + backend AI)
const tabTotalWatts = {};

// Track when each tab was first seen so we can estimate session duration
const tabStartTime = {};

// tabInfo maps tabId -> { url, title }, kept fresh from tab events so the
// message path never has to await chrome.tabs.get. That call was made on every
// single PAGE_METRICS message; it is now a cache-miss fallback only.
const tabInfo = {};

const aiManager = new AIEnergyManager();

// ── Storage flush scheduling ───────────────────────────────────────────────
// History lives in memory + storage.session and is written through to
// storage.local on this alarm (see lib/storage.js). onSuspend catches the
// worker being torn down between alarms.

chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_PERIOD_MIN });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM) flushToLocal();
});

chrome.runtime.onSuspend.addListener(() => {
  flushToLocal();
});

// ── Per-site disable list ──────────────────────────────────────────────────
// User-editable escape hatch: hostnames in ecoDisabledSites never get the
// content script. Applied by re-registering the manifest-declared script with
// an updated excludeMatches, so a site that the extension breaks can be opted
// out without uninstalling.

const CONTENT_SCRIPT_ID = 'eco-metrics';

/** Turn stored hostnames into match patterns. */
function siteToPatterns(host) {
  const clean = String(host).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!clean || clean.includes('*')) return [];
  return [`https://${clean}/*`, `http://${clean}/*`,
          `https://*.${clean}/*`, `http://*.${clean}/*`];
}

async function applyDisabledSites() {
  let sites = [];
  try {
    const { ecoDisabledSites } = await chrome.storage.local.get('ecoDisabledSites');
    if (Array.isArray(ecoDisabledSites)) sites = ecoDisabledSites;
  } catch (_) { return; }

  const excludeMatches = sites.flatMap(siteToPatterns);

  try {
    const registered = await chrome.scripting.getRegisteredContentScripts({
      ids: [CONTENT_SCRIPT_ID],
    });
    const update = {
      id: CONTENT_SCRIPT_ID,
      matches: ['http://*/*', 'https://*/*'],
      excludeMatches: excludeMatches.length ? excludeMatches : undefined,
      js: ['content/content-script.js'],
      runAt: 'document_idle',
      allFrames: false,
    };
    if (registered.length) {
      await chrome.scripting.updateContentScripts([update]);
    } else {
      await chrome.scripting.registerContentScripts([update]);
    }
  } catch (_) {
    // Registration can fail if the manifest-declared script owns the id on some
    // Chrome versions; the manifest entry stays active either way.
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ecoDisabledSites) applyDisabledSites();
});

chrome.runtime.onStartup.addListener(applyDisabledSites);
chrome.runtime.onInstalled.addListener(applyDisabledSites);

// ── Tab metadata cache ─────────────────────────────────────────────────────

function cacheTab(tab) {
  if (!tab || tab.id == null) return;
  tabInfo[tab.id] = { url: tab.url, title: tab.title };
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
    cacheTab(tab);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(cacheTab).catch(() => {});
});

/** Cached {url, title} for a tab, falling back to a live lookup on a miss. */
async function getTabInfo(tabId) {
  const cached = tabInfo[tabId];
  if (cached && cached.url) return cached;
  try {
    const tab = await chrome.tabs.get(tabId);
    cacheTab(tab);
    return { url: tab.url, title: tab.title };
  } catch (_) {
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Hostname without a leading "www.", used to label non-AI sites in history. */
function siteLabelFor(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return null;
  }
}

/**
 * Look up the tab's URL and title, run AI detection, and return the backend
 * energy/water/carbon for that tab. Returns zeros (and the bare hostname as
 * `site`) if it is not a known AI site.
 *
 * @param {number} tabId
 * @returns {Promise<{ aiWatts: number, aiWaterLPerHr: number, aiCo2GPerHr: number,
 *                     modelKey: string|null, modelName: string|null,
 *                     platform: string|null, site: string|null }>}
 */
async function resolveAIWatts(tabId) {
  const none = {
    aiWatts: 0, aiWaterLPerHr: 0, aiCo2GPerHr: 0,
    modelKey: null, modelName: null, platform: null, site: null,
  };

  const tab = await getTabInfo(tabId);
  if (!tab) return none;

  const site = siteLabelFor(tab.url);

  // Run detection using URL + page title (no DOM access needed)
  const detection = aiManager.detectAIModel(tab.url, tab.title);
  if (!detection) return { ...none, site };

  // Duration since the tab was first seen in this session
  const startTime  = tabStartTime[tabId] || Date.now();
  const durationMs = Date.now() - startTime;

  // Compute energy; convert a single query's cost to watts (not the session total,
  // which would spike on first tick and decay to near-zero after a long session).
  const { queries, energyWh } = aiManager.computeEnergy(detection.modelKey, durationMs);
  const perQueryWh = energyWh / Math.max(1, queries);
  const aiWatts = aiManager.energyToWatts(perQueryWh, durationMs);

  // Water and carbon come from the same per-query figure, scaled by the
  // provider's datacenter multipliers.
  const { waterLPerHr, co2GPerHr } = aiManager.hourlyFootprint(detection.modelKey);

  aiManager.updateTabUsage(tabId, {
    modelKey: detection.modelKey,
    queries,
    energyWh,
  });

  return {
    aiWatts,
    aiWaterLPerHr: waterLPerHr,
    aiCo2GPerHr:   co2GPerHr,
    modelKey:  detection.modelKey,
    modelName: detection.model?.name ?? null,
    platform:  detection.platform,
    // Prefer the platform name ("openai") over the raw host for AI sites, so
    // chatgpt.com and chat.openai.com share one series in the history chart.
    site: detection.platform,
  };
}

// ── Message handler ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Content script pushes page metrics.
  if (message.type === 'PAGE_METRICS' && sender.tab?.id != null) {
    const tabId = sender.tab.id;

    // Record first-seen time for duration estimation
    if (!tabStartTime[tabId]) tabStartTime[tabId] = Date.now();

    tabMetrics[tabId] = message.metrics;

    // Compute frontend watts, then fold in AI backend watts asynchronously.
    const frontendWatts = estimateWatts(message.metrics);

    resolveAIWatts(tabId).then((ai) => {
      const totalWatts = frontendWatts + ai.aiWatts;

      // Cache for GET_METRICS on every tab, so the popup works wherever it opens.
      tabAI[tabId] = {
        aiWatts:       ai.aiWatts,
        aiWaterLPerHr: ai.aiWaterLPerHr,
        aiCo2GPerHr:   ai.aiCo2GPerHr,
        frontendWatts,
        modelKey:  ai.modelKey,
        modelName: ai.modelName,
        platform:  ai.platform,
      };
      tabTotalWatts[tabId] = totalWatts;

      // Persist only the tab the user is actually looking at. Writing history
      // for every open tab would interleave unrelated sites into one series.
      // The content script already gates on visibility, but it allows a
      // 60 s "recently visible" grace window, so the focus check still matters.
      // appendWatts only touches memory + storage.session; the write through to
      // storage.local happens on the flush alarm.
      if (sender.tab.active) {
        chrome.windows.get(sender.tab.windowId)
          .then((win) => {
            if (win.focused) appendWatts(totalWatts, ai.site);
          })
          .catch(() => {});
      }
    });

    sendResponse({ ok: true });
  }

  // Popup requests the latest metrics for a given tab.
  if (message.type === 'GET_METRICS') {
    const metrics     = tabMetrics[message.tabId] ?? null;
    const ai          = tabAI[message.tabId] ?? null;
    const totalWatts  = tabTotalWatts[message.tabId] ?? null;
    sendResponse({ metrics, ai, totalWatts });
  }

  // Options page requests full history.
  if (message.type === 'GET_HISTORY') {
    readHistory().then((history) => sendResponse({ history }));
    return true; // keep channel open for async response
  }

  // Options page requests the daily rollup (Week view).
  if (message.type === 'GET_DAILY') {
    readDaily().then((daily) => sendResponse({ daily }));
    return true;
  }

  // Options page requests history to be cleared.
  if (message.type === 'CLEAR_HISTORY') {
    clearHistory().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ── Tab lifecycle ──────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabMetrics[tabId];
  delete tabAI[tabId];
  delete tabTotalWatts[tabId];
  delete tabStartTime[tabId];
  delete tabInfo[tabId];
  aiManager.removeTab(tabId);
});
