import { optimize } from './engine.js';
import { initEnergy } from './energy.js';
import { initDebug } from './debug.js';

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

// ── Tauri bridge: quick optimize + settings (no-ops when run in a plain browser)
const tauri = window.__TAURI__;
if (tauri) {
  const { listen } = tauri.event;
  const { invoke } = tauri.core;

  // Rust owns the hotkey/clipboard/toast; it asks this webview to do the text
  // work (the optimizer is JS) and sends the answer back. Never log the text.
  listen('quick-optimize', async (e) => {
    const { id, text } = e.payload;
    const { optimized, savings } = await optimize(text);
    await invoke('quick_optimize_result', {
      id, optimized, tokensSaved: savings.tokensSaved, percent: savings.percentReduction,
    });
  });

  const shortcutInput = $('shortcut');
  const shortcutMsg = $('shortcut-msg');
  const recordBtn = $('shortcut-record');
  const IS_MAC = navigator.platform.toUpperCase().includes('MAC');

  const pretty = (a) => a.replace('CommandOrControl', IS_MAC ? '⌘' : 'Ctrl').replaceAll('+', ' + ');
  const say = (text, error = false) => {
    shortcutMsg.textContent = text;
    shortcutMsg.classList.toggle('error', error);
  };

  let current = '';
  invoke('get_settings').then((s) => {
    current = s.shortcut;
    shortcutInput.value = pretty(current);
    if (IS_MAC) {
      $('dock-setting').hidden = false;
      $('hide-dock').checked = !!s.hide_dock_when_closed;
    }
  });
  $('hide-dock').addEventListener('change', async (e) => {
    try { await invoke('set_hide_dock', { enabled: e.target.checked }); }
    catch (err) { e.target.checked = !e.target.checked; }
  });

  listen('shortcut-error', (e) => {
    $('settings').open = true;
    say(e.payload, true);
  });

  // Turn a keydown into a Tauri accelerator string, e.g. "CommandOrControl+Shift+E".
  function toAccelerator(e) {
    const mods = [];
    if (e.metaKey || e.ctrlKey) mods.push('CommandOrControl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    let key = null;
    if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
    else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
    else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
    if (!key || !mods.length) return null;
    return [...mods, key].join('+');
  }

  let recording = false;
  function stopRecording() {
    recording = false;
    shortcutInput.classList.remove('recording');
    recordBtn.textContent = 'Change';
    shortcutInput.value = pretty(current);
  }
  recordBtn.addEventListener('click', () => {
    if (recording) return stopRecording();
    recording = true;
    shortcutInput.classList.add('recording');
    shortcutInput.value = 'Press new keys…';
    recordBtn.textContent = 'Cancel';
    say('');
  });
  window.addEventListener('keydown', async (e) => {
    if (!recording) return;
    e.preventDefault();
    if (e.key === 'Escape') return stopRecording();
    const accel = toAccelerator(e);
    if (!accel) { say('Use Cmd/Ctrl or Alt with a letter, number or F-key.', true); return; }
    try {
      await invoke('set_shortcut', { accelerator: accel });
      current = accel;
      say('Saved.');
    } catch (err) {
      say(String(err), true);
    }
    stopRecording();
  }, true);
}

initEnergy();
initDebug();
