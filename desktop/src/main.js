import { optimize } from './engine.js';

const TOKEN_DEBOUNCE_MS = 150;
const COPY_FEEDBACK_MS = 1400;

const $ = (id) => document.getElementById(id);
const input = $('input');
const optimizeBtn = $('optimize');
const copyBtn = $('copy');
let lastOptimized = '';
let debounceId = null;
let copyTimer = null;

$('kbd').textContent = navigator.platform.toUpperCase().includes('MAC') ? '⌘↵' : 'Ctrl+↵';

// Same conversions and rounding as the extension's lib/optimizer-ui.js.
function formatSavings(s) {
  const wh = s.energySavedWh;
  return {
    energy: wh < 0.001 ? (wh * 1000).toFixed(4) : wh.toFixed(6),
    unit: wh < 0.001 ? 'µWh' : 'Wh',
    water: (s.waterSavedLiters * 1000).toFixed(4),
    co2: (s.co2SavedGrams * 1000).toFixed(3),
  };
}

input.addEventListener('input', () => {
  clearTimeout(debounceId);
  debounceId = setTimeout(() => { $('live-tokens').textContent = countTokens(input.value); }, TOKEN_DEBOUNCE_MS);
});

async function onOptimize() {
  const original = input.value.trim();
  if (!original) return;
  optimizeBtn.disabled = true;
  try {
    const { optimized, savings: s } = await optimize(original);
    lastOptimized = optimized;
    $('output').textContent = optimized;
    $('tok-before').textContent = s.originalTokens;
    $('tok-after').textContent = s.optimizedTokens;
    $('tok-saved').textContent = s.tokensSaved;
    $('reduction').textContent = `${s.percentReduction}%`;
    $('words-removed').textContent = `${s.wordsRemoved} words`;
    const f = formatSavings(s);
    $('energy').textContent = f.energy;
    $('energy-unit').textContent = f.unit;
    $('water').textContent = f.water;
    $('co2').textContent = f.co2;
    $('result').classList.remove('hidden');
  } finally {
    optimizeBtn.disabled = false;
  }
}
optimizeBtn.addEventListener('click', onOptimize);
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onOptimize(); }
});

copyBtn.addEventListener('click', async () => {
  if (!lastOptimized) return;
  try { await navigator.clipboard.writeText(lastOptimized); }
  catch (_) { /* Phase 2 moves clipboard to the Tauri plugin */ }
  copyBtn.textContent = 'Copied';
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { copyBtn.textContent = 'Copy'; }, COPY_FEEDBACK_MS);
});
