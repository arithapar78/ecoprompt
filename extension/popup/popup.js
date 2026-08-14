// popup/popup.js
// Role: handle view switching, live energy display, and the prompt optimizer UI.

// ── Theme (light / dark) ───────────────────────────────────────────────────────

let isDark = true;

function applyTheme(dark) {
  isDark = dark;
  document.body.classList.toggle('light', !dark);
  // Both moon and sun SVGs live in the button; CSS shows one per theme.
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  const t1 = document.getElementById('theme-toggle');
  const t2 = document.getElementById('theme-toggle-2');
  if (t1) t1.title = label;
  if (t2) t2.title = label;
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

const WIDTHS = [380, 460, 560, 640];
let widthIdx = 1; // default: 460px

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
  // Mounted lazily on first switch, so opening the popup on the dashboard
  // costs nothing. mountOptimizer() is defined further down.
  mountOptimizer();
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

  setEnergyDisplay(totalWatts, ai);
}

/**
 * Render the live figures. Device and datacenter costs are ADDITIVE: the shown
 * watts / CO2 / water are the frontend estimate plus the backend inference share.
 *
 * @param {number|null} watts - total (frontend + backend)
 * @param {object|null} ai    - cached AI info from the service worker
 */
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

  const aiWatts       = ai?.aiWatts ?? 0;
  const aiCo2GPerHr   = ai?.aiCo2GPerHr ?? 0;
  const aiWaterLPerHr = ai?.aiWaterLPerHr ?? 0;

  // Device-side share only — the backend share is added separately below and
  // carries its own provider-specific grid and water factors.
  const frontendWatts = Math.max(0, watts - aiWatts);

  // Backend water is metered in litres; the display is in US gallons.
  const L_TO_GAL = 0.264;

  const co2GPerHr   = (frontendWatts / 1000) * 386  + aiCo2GPerHr;
  const waterGalPerHr = (frontendWatts / 1000) * 0.13 + aiWaterLPerHr * L_TO_GAL;

  if (ai?.modelName) {
    aiModelEl.textContent = ai.modelName;
    aiWattsEl.textContent =
      `+${aiWatts.toFixed(1)} W · +${aiCo2GPerHr.toFixed(1)} g/hr · ` +
      `+${(aiWaterLPerHr * L_TO_GAL).toFixed(4)} gal/hr backend`;
    aiInfoEl.classList.remove('hidden');
  } else {
    aiInfoEl.classList.add('hidden');
  }

  document.querySelector('.bulbs-value').textContent =
    (watts / 6).toFixed(3);

  document.querySelector('.water-value').textContent = waterGalPerHr.toFixed(4);

  document.querySelector('.co2-value').textContent = co2GPerHr.toFixed(3);
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
// All optimizer behaviour — input, token count, metrics, output, Copy, and the
// backend event — lives in lib/optimizer-ui.js, which the Settings page mounts
// too. Do not reimplement any of it here: two copies is exactly the drift this
// module exists to prevent.

let optimizerUI = null;

function mountOptimizer() {
  if (optimizerUI) return;
  const mount = document.getElementById('optimizer-mount');
  if (mount && window.EcoPromptOptimizerUI) {
    optimizerUI = window.EcoPromptOptimizerUI.mount(mount, { variant: 'popup' });
  }
}

document.getElementById('open-fullpage').addEventListener('click', (e) => {
  e.preventDefault();
  // openOptionsPage() cannot carry a fragment, so open the options URL directly
  // to land on the optimizer tab.
  chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#optimizer') });
  window.close();
});
