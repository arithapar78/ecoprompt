// Energy tab: renders snapshots and history pushed from the Rust monitor.
// The estimate math lives in Rust (energy_model.rs); this file only displays.

const $ = (id) => document.getElementById(id);
const tauri = window.__TAURI__;
const BUCKET_MIN = 15;              // chart bar width
const DAY_MS = 24 * 3600 * 1000;

let history = [];
let chartTimer = null;

const fmtW = (w) => (w < 10 ? w.toFixed(1) : Math.round(w).toString());
const fmtWh = (v) => (v < 10 ? v.toFixed(2) : v.toFixed(1));

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Average watts per 15-minute bucket across the last 24 h.
function bucketize(entries, now = Date.now()) {
  const n = (24 * 60) / BUCKET_MIN;
  const start = now - DAY_MS;
  const sums = new Array(n).fill(0);
  const counts = new Array(n).fill(0);
  for (const e of entries) {
    if (e.ts < start || e.ts > now) continue;
    const i = Math.min(n - 1, Math.floor(((e.ts - start) / DAY_MS) * n));
    sums[i] += e.watts;
    counts[i]++;
  }
  return sums.map((s, i) => (counts[i] ? s / counts[i] : null));
}

function drawChart() {
  const canvas = $('e-chart');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const bars = bucketize(history);
  const vals = bars.filter((v) => v !== null);
  const text = cssVar('--eco-text-3');
  ctx.font = '11px -apple-system, "Segoe UI", sans-serif';
  ctx.fillStyle = text;

  if (!vals.length) {
    ctx.textAlign = 'center';
    ctx.fillText('History appears after the first 30-second sample.', w / 2, h / 2);
    return;
  }
  const padL = 30, padB = 18, padT = 6;
  const plotW = w - padL, plotH = h - padB - padT;
  const max = Math.max(...vals) * 1.15 || 1;
  const bw = plotW / bars.length;

  ctx.strokeStyle = cssVar('--eco-border');
  ctx.textAlign = 'right';
  for (const f of [0, 0.5, 1]) {
    const y = padT + plotH * (1 - f);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.fillText(fmtW(max * f), padL - 4, y + 4);
  }
  ctx.fillStyle = cssVar('--eco-accent');
  bars.forEach((v, i) => {
    if (v === null) return;
    const bh = Math.max(1, (v / max) * plotH);
    ctx.fillRect(padL + i * bw + 0.5, padT + plotH - bh, Math.max(1, bw - 1), bh);
  });
  ctx.fillStyle = text;
  ctx.textAlign = 'left';
  ctx.fillText('24 h ago', padL, h - 4);
  ctx.textAlign = 'right';
  ctx.fillText('now', w, h - 4);
}

function renderSnapshot(s) {
  if (!s) return;
  $('e-watts').textContent = fmtW(s.system_watts);
  $('e-sub').textContent =
    `${s.cpu_pct.toFixed(0)}% CPU · ${s.device_class} defaults ${s.params.idle}–${s.params.max} W · estimate`;
  const b = $('e-battery');
  if (s.battery_watts != null) {
    b.hidden = false;
    b.textContent = `Measured (battery): ${s.battery_watts.toFixed(1)} W`;
  } else {
    b.hidden = true;
  }
  $('e-today').textContent = fmtWh(s.today_wh);
  $('e-ai-today').textContent = fmtWh(s.ai_today_wh);
  $('e-br-today').textContent = fmtWh(s.browser_today_wh);

  const list = $('e-apps');
  const max = Math.max(...s.top_apps.map((a) => a.watts), 0.001);
  list.replaceChildren(...s.top_apps.map((a) => {
    const li = document.createElement('li');
    li.className = 'app';
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('span');
    name.textContent = a.group;
    if (a.kind === 'ai') {
      const t = document.createElement('span');
      t.className = 'tag';
      t.textContent = 'AI';
      name.append(t);
    }
    const val = document.createElement('span');
    val.textContent = `${a.watts.toFixed(2)} W`;
    row.append(name, val);
    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.style.width = `${Math.max(2, (a.watts / max) * 100)}%`;
    li.append(row, bar);
    return li;
  }));
  if (!s.warmup) {
    history.push({ ts: s.ts, watts: s.system_watts });
    if (history.length > 2880) history.shift();
  }
  scheduleChart();
}

function scheduleChart() {
  if (chartTimer) return;
  chartTimer = requestAnimationFrame(() => { chartTimer = null; if (!$('view-energy').hidden) drawChart(); });
}

async function refresh() {
  history = await tauri.core.invoke('get_history');
  renderSnapshot(await tauri.core.invoke('get_energy_snapshot'));
  scheduleChart();
}

export function initEnergy() {
  if (!tauri) return;
  const { invoke } = tauri.core;
  tauri.event.listen('energy-sample', (e) => renderSnapshot(e.payload));
  window.addEventListener('focus', refresh);
  window.addEventListener('resize', scheduleChart);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', scheduleChart);

  // Tabs
  const tabs = [['tab-optimizer', 'view-optimizer'], ['tab-energy', 'view-energy']];
  function select(id) {
    for (const [t, v] of tabs) {
      const on = t === id;
      $(t).setAttribute('aria-selected', String(on));
      $(t).tabIndex = on ? 0 : -1;
      $(v).hidden = !on;
    }
    if (id === 'tab-energy') refresh();
  }
  for (const [t] of tabs) $(t).addEventListener('click', () => select(t));
  $('tab-optimizer').parentElement.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = document.activeElement.id === 'tab-optimizer' ? 'tab-energy' : 'tab-optimizer';
    select(next); $(next).focus();
  });

  // Export
  $('e-export').addEventListener('click', async () => {
    const msg = $('e-export-msg');
    try {
      const path = await invoke('export_history');
      msg.classList.remove('error');
      msg.textContent = path ? `Saved to ${path}` : '';
    } catch (err) {
      msg.classList.add('error');
      msg.textContent = String(err);
    }
  });

  // Energy model settings
  const idle = $('p-idle'), max = $('p-max'), pmsg = $('p-msg');
  const say = (t, err = false) => { pmsg.textContent = t; pmsg.classList.toggle('error', err); };
  const fill = (p) => { idle.value = p.idle; max.value = p.max; };
  invoke('get_energy_snapshot').then((s) => { if (s) fill(s.params); });
  const num = (el) => (el.value === '' ? null : Number(el.value));
  $('p-save').addEventListener('click', async () => {
    try { fill(await invoke('set_energy_params', { idle: num(idle), max: num(max) })); say('Saved. Applies from the next sample.'); }
    catch (err) { say(String(err), true); }
  });
  $('p-reset').addEventListener('click', async () => {
    try { fill(await invoke('set_energy_params', { idle: null, max: null })); say('Back to defaults.'); }
    catch (err) { say(String(err), true); }
  });
}
