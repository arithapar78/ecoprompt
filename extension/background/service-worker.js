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

const aiManager = new AIEnergyManager();

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

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_) {
    return none;
  }

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
      // for every open tab would interleave unrelated sites into one series and
      // do a read-modify-write of the whole array per tab per 10 s.
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
  aiManager.removeTab(tabId);
});
