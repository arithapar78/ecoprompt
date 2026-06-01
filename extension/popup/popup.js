// popup/popup.js
// Role: handle view switching, live energy display, and the prompt optimizer UI.

// ── Theme (light / dark) ───────────────────────────────────────────────────────

let isDark = true;

function applyTheme(dark) {
  isDark = dark;
  document.body.classList.toggle('light', !dark);
  const icon = dark ? '🌙' : '☀️';
  const t1 = document.getElementById('theme-toggle');
  const t2 = document.getElementById('theme-toggle-2');
  if (t1) t1.textContent = icon;
  if (t2) t2.textContent = icon;
}

function toggleTheme() {
  const next = !isDark;
  applyTheme(next);
  chrome.storage.local.set({ ecoPromptTheme: next ? 'dark' : 'light' });
}

(async () => {
  const { ecoPromptTheme } = await chrome.storage.local.get('ecoPromptTheme');
  applyTheme(ecoPromptTheme !== 'light');
})();

document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
document.getElementById('theme-toggle-2').addEventListener('click', toggleTheme);

// ── Width resizing ─────────────────────────────────────────────────────────────

const WIDTHS = [300, 380, 480, 580];
let widthIdx = 1; // default: 380px

function applyWidth() {
  document.body.style.width = WIDTHS[widthIdx] + 'px';
}

function onGrow()   { if (widthIdx < WIDTHS.length - 1) { widthIdx++; applyWidth(); } }
function onShrink() { if (widthIdx > 0)                 { widthIdx--; applyWidth(); } }

document.getElementById('grow-btn').addEventListener('click',    onGrow);
document.getElementById('shrink-btn').addEventListener('click',  onShrink);
document.getElementById('grow-btn-2').addEventListener('click',  onGrow);
document.getElementById('shrink-btn-2').addEventListener('click',onShrink);

// ── View switching ─────────────────────────────────────────────────────────────

const viewDashboard = document.getElementById('view-dashboard');
const viewOptimizer = document.getElementById('view-optimizer');

document.getElementById('open-optimizer-btn').addEventListener('click', () => {
  viewDashboard.classList.add('hidden');
  viewOptimizer.classList.remove('hidden');
});

document.getElementById('open-history-btn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById('back-btn').addEventListener('click', () => {
  viewOptimizer.classList.add('hidden');
  viewDashboard.classList.remove('hidden');
});

// ── Energy dashboard ───────────────────────────────────────────────────────────

async function refreshDashboard() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const response = await chrome.runtime.sendMessage({
    type: 'GET_METRICS',
    tabId: tab.id,
  });

  const metrics = response?.metrics;
  const ai      = response?.ai ?? null;
  const swTotal = response?.totalWatts ?? null;

  if (!metrics) {
    setEnergyDisplay(null, null);
    return;
  }

  let totalWatts;
  if (swTotal !== null) {
    totalWatts = swTotal;
  } else {
    const frontendWatts = estimateWatts(metrics);
    const aiWatts = ai?.aiWatts ?? 0;
    totalWatts = frontendWatts + aiWatts;
  }

  console.log('[EcoPrompt popup] totalWatts:', totalWatts.toFixed(4), '| aiWatts:', (ai?.aiWatts ?? 0).toFixed(4));

  setEnergyDisplay(totalWatts, ai);
}

function setEnergyDisplay(watts, ai) {
  const energyEl  = document.querySelector('.energy-value');
  const aiInfoEl  = document.getElementById('ai-info');
  const aiModelEl = document.getElementById('ai-model-label');
  const aiWattsEl = document.getElementById('ai-watts-label');

  if (watts === null) {
    energyEl.innerHTML = '… <span class="energy-unit">W</span>';
    aiInfoEl.classList.add('hidden');
    return;
  }

  energyEl.innerHTML = `${watts.toFixed(2)} <span class="energy-unit">W</span>`;

  if (ai?.modelName) {
    aiModelEl.textContent = ai.modelName;
    aiWattsEl.textContent = `+${(ai.aiWatts ?? 0).toFixed(3)} W backend`;
    aiInfoEl.classList.remove('hidden');
  } else {
    aiInfoEl.classList.add('hidden');
  }

  document.querySelector('.bulbs-value').textContent =
    (watts / 6).toFixed(3);

  // gallons/hr = (watts / 1000) * 0.13
  document.querySelector('.water-value').textContent =
    ((watts / 1000) * 0.13).toFixed(4);

  // g/hr = (watts / 1000) * 386
  document.querySelector('.co2-value').textContent =
    ((watts / 1000) * 386).toFixed(3);
}

refreshDashboard();
setInterval(refreshDashboard, 5000);

// Initialize analytics consent to true on first install (can be changed later)
(async () => {
  const result = await chrome.storage.local.get("ecoPromptAnalyticsConsent");
  if (typeof result.ecoPromptAnalyticsConsent === "undefined") {
    await chrome.storage.local.set({ ecoPromptAnalyticsConsent: true });
    console.log("[EcoPrompt Analytics] Consent initialized to true (first install)");
  }
})();

// ── Prompt optimizer ───────────────────────────────────────────────────────────

// Live token counter while the user types
const originalPromptEl = document.getElementById('original-prompt');
const originalTokensEl = document.getElementById('original-tokens');

originalPromptEl.addEventListener('input', () => {
  const tokens = countTokens(originalPromptEl.value);
  originalTokensEl.textContent = tokens;
});

// ── Optimize button ────────────────────────────────────────────────────────────

document.getElementById('optimize-btn').addEventListener('click', async () => {
  const original = originalPromptEl.value.trim();
  if (!original) return;

  const { optimized, stats } = window.EcoPromptOptimizer.getOptimizationStats(original);

  // Display optimized text
  document.getElementById('optimized-prompt').textContent = optimized;

  // Token stats (kept for backwards compatibility with existing IDs)
  document.getElementById('stat-original').textContent  = stats.originalTokens;
  document.getElementById('stat-optimized').textContent = stats.optimizedTokens;
  document.getElementById('stat-saved').textContent     = stats.tokensSaved;

  // New word / reduction stats
  document.getElementById('stat-words-removed').textContent =
    `${stats.wordsRemoved} words`;
  document.getElementById('stat-reduction').textContent =
    `${stats.percentReduction}%`;

  // Environmental savings
  // Energy: show in µWh if < 1 Wh, else Wh
  const energyWh = stats.energySavedWh;
  document.getElementById('stat-energy').textContent =
    energyWh < 0.001
      ? (energyWh * 1000).toFixed(4)   // µWh
      : energyWh.toFixed(6);           // Wh

  // Water: convert liters → mL for readability at these small scales
  const waterMl = stats.waterSavedLiters * 1000;
  document.getElementById('stat-water').textContent = waterMl.toFixed(4);

  // CO2: convert grams → mg for readability
  const co2Mg = stats.co2SavedGrams * 1000;
  document.getElementById('stat-co2').textContent = co2Mg.toFixed(3);

  document.getElementById('result-card').classList.remove('hidden');

  if (window.ecoTrackPromptOptimization) {
    await window.ecoTrackPromptOptimization({
      originalPrompt: original,
      optimizedPrompt: optimized,
      optimizationMode: "balanced",
      platform: "EcoPrompt",
      source: "prompt-generator-widget"
    });
  }
});
