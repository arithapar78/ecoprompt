// Hidden diagnostics panel (Cmd/Ctrl+Shift+D). Shows what the Rust side measured
// plus the vendored optimizer's source commit, and can copy it all as JSON to
// paste into a bug report. It never contains prompt or clipboard text.

import { log } from './log.js';

const $ = (id) => document.getElementById(id);
const tauri = window.__TAURI__;

async function collect() {
  const diag = tauri ? await tauri.core.invoke('get_diagnostics') : { note: 'not running inside the desktop app' };
  let optimizer = null;
  try {
    const sync = await (await fetch('vendor/optimizer/SYNC.json')).json();
    optimizer = { source_commit: sync.sourceCommit, synced_at: sync.syncedAt };
  } catch (_) { /* leave null */ }
  return { ...diag, vendored_optimizer: optimizer };
}

const fmt = (n, d = 1) => (typeof n === 'number' ? n.toFixed(d) : '—');

function render(d) {
  const em = d.energy_model || {};
  const lines = [];
  lines.push(`EcoPrompt ${d.app_version ?? '?'} · ${d.os ?? '?'} ${d.arch ?? ''} · device: ${d.device_class ?? '?'}`);
  lines.push(`optimizer source commit: ${d.vendored_optimizer?.source_commit ?? 'unknown'}`);
  lines.push(`shortcut: ${d.shortcut ?? '?'} · debug logging: ${d.debug_logging}`);
  lines.push('');
  lines.push('ENERGY MODEL (estimate)');
  lines.push(`  in use:   idle ${em.in_use?.idle} W, max ${em.in_use?.max} W`);
  lines.push(`  defaults: idle ${em.defaults?.idle} W, max ${em.defaults?.max} W`);
  lines.push(`  sample every ${em.sample_interval_s} s · sanity cap ${em.max_sane_watts} W`);
  lines.push('');
  lines.push(`OWN CPU: ${fmt(d.own_cpu_pct, 2)}% now, ${fmt(d.own_cpu_avg_pct, 2)}% average (percent of one core)`);
  lines.push(`BATTERY RAW: ${d.battery_raw ? JSON.stringify(d.battery_raw) : 'n/a (not a Mac laptop, or not readable)'}`);
  lines.push('');
  lines.push(`LAST ${(d.raw_samples || []).length} SAMPLES`);
  for (const s of d.raw_samples || []) {
    const top = (s.top_processes || []).map((p) => `${p.name} ${fmt(p.cpu_pct)}%`).join(', ');
    lines.push(`  ${new Date(s.ts).toLocaleTimeString()}  cpu ${fmt(s.total_cpu_pct)}%  ${fmt(s.watts, 2)} W${s.battery_watts != null ? `  battery ${fmt(s.battery_watts, 2)} W` : ''}${s.stored ? '' : '  (warm-up)'}`);
    lines.push(`      top: ${top}`);
  }
  lines.push('');
  lines.push(`LOG (last ${(d.log_tail || []).length} lines) — ${d.log_dir ?? 'n/a'}`);
  for (const l of d.log_tail || []) lines.push('  ' + l);
  return lines.join('\n');
}

export function initDebug() {
  const panel = $('debug-panel');
  const body = $('debug-body');
  const toggle = $('debug-toggle');
  let opener = null;
  let current = null;

  async function open() {
    opener = document.activeElement;
    panel.hidden = false;
    body.textContent = 'Loading…';
    try {
      current = await collect();
      body.textContent = render(current);
      toggle.checked = !!current.debug_logging;
    } catch (e) {
      body.textContent = 'Could not load diagnostics: ' + e;
      log.error('diagnostics failed: ' + e);
    }
    $('debug-close').focus();
  }
  function close() {
    panel.hidden = true;
    if (opener && opener.focus) opener.focus();
  }

  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      panel.hidden ? open() : close();
    } else if (e.key === 'Escape' && !panel.hidden) {
      close();
    }
  });
  $('debug-close').addEventListener('click', close);

  $('debug-copy').addEventListener('click', async () => {
    const btn = $('debug-copy');
    const text = JSON.stringify(current ?? (await collect()), null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.append(ta); ta.select();
      try { document.execCommand('copy'); } catch (__) { /* nothing more to try */ }
      ta.remove();
    }
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy diagnostics'; }, 1400);
  });

  toggle.addEventListener('change', async () => {
    try {
      await tauri.core.invoke('set_debug_logging', { enabled: toggle.checked });
      current = await collect();
      body.textContent = render(current);
    } catch (e) {
      log.error('toggle debug logging failed: ' + e);
    }
  });
}
