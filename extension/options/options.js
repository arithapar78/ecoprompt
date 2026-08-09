// options/options.js
// Role: tab navigation, watt history rendering, stats + line chart.

const PADDING = { top: 20, right: 20, bottom: 36, left: 48 };

const CHART_DARK = {
  grid:        'rgba(255,255,255,0.05)',
  gridLabel:   '#555f72',
  line:        '#3ecf8e',
  lineGlow:    'rgba(62,207,142,0.5)',
  fillTop:     'rgba(62,207,142,0.18)',
  fillBottom:  'rgba(62,207,142,0.01)',
  dotFill:     '#3ecf8e',
  dotStroke:   '#0f1117',
  timeLabel:   '#555f72',
};

const CHART_LIGHT = {
  grid:        'rgba(0,0,0,0.07)',
  gridLabel:   '#9ca3af',
  line:        '#27a96c',
  lineGlow:    'rgba(39,169,108,0.4)',
  fillTop:     'rgba(39,169,108,0.14)',
  fillBottom:  'rgba(39,169,108,0.01)',
  dotFill:     '#27a96c',
  dotStroke:   '#f4f6fa',
  timeLabel:   '#9ca3af',
};

let isDark = true;
let CHART = CHART_DARK;

// ── Theme ───────────────────────────────────────────────────────────────────

function applyTheme(dark) {
  isDark = dark;
  CHART = dark ? CHART_DARK : CHART_LIGHT;
  document.body.classList.toggle('light', !dark);
  document.getElementById('theme-toggle').textContent = dark ? '🌙' : '☀️';
}

function toggleTheme() {
  const next = !isDark;
  applyTheme(next);
  chrome.storage.local.set({ ecoPromptTheme: next ? 'dark' : 'light' });
  loadAndRender();
}

document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

// ── Tab navigation ──────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById('tab-' + target).classList.remove('hidden');
  });
});

// ── View state ──────────────────────────────────────────────────────────────

// 'day'  — raw watt samples from the ring buffer
// 'week' — per-day Wh totals from the rollup
let range = 'day';

// ── Data loading ────────────────────────────────────────────────────────────

async function loadAndRender() {
  const chartEl = document.getElementById('chart');
  const emptyEl = document.getElementById('empty-msg');

  if (range === 'week') {
    const response = await chrome.runtime.sendMessage({ type: 'GET_DAILY' });
    const days = toDaySeries(response?.daily ?? {});

    setStatLabels('week');

    if (days.length === 0) {
      chartEl.classList.add('hidden');
      emptyEl.classList.remove('hidden');
      setDailyStats(null);
      return;
    }

    chartEl.classList.remove('hidden');
    emptyEl.classList.add('hidden');
    setDailyStats(days);
    drawDailyChart(days);
    return;
  }

  const response = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
  const history = response?.history ?? [];

  setStatLabels('day');

  if (history.length === 0) {
    chartEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    setStats(null);
    return;
  }

  chartEl.classList.remove('hidden');
  emptyEl.classList.add('hidden');
  setStats(history);
  drawChart(history);
}

/**
 * Flatten the rollup map into the last 7 calendar days, oldest first.
 * Days with no samples are included as zero so gaps stay visible.
 *
 * @param {Object<string, {whTotal:number, bySite:Object<string,number>}>} daily
 * @returns {Array<{ day: string, whTotal: number, bySite: object }>}
 */
function toDaySeries(daily) {
  if (Object.keys(daily).length === 0) return [];

  const out = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const m   = String(d.getMonth() + 1).padStart(2, '0');
    const dd  = String(d.getDate()).padStart(2, '0');
    const key = `${d.getFullYear()}-${m}-${dd}`;
    const entry = daily[key];
    out.push({
      day: key,
      whTotal: entry?.whTotal ?? 0,
      bySite:  entry?.bySite  ?? {},
    });
  }
  return out;
}

// ── Stats ───────────────────────────────────────────────────────────────────

function setStatLabels(mode) {
  const week = mode === 'week';
  document.getElementById('stat-current-label').textContent = week ? 'Today' : 'Current';
  document.getElementById('stat-avg-label').textContent     = week ? 'Daily Avg' : 'Average';
  document.getElementById('stat-peak-label').textContent    = week ? 'Busiest Day' : 'Peak';
  const unit = week ? 'Wh' : 'W';
  document.getElementById('stat-current-unit').textContent = unit;
  document.getElementById('stat-avg-unit').textContent     = unit;
  document.getElementById('stat-peak-unit').textContent    = unit;
  document.getElementById('chart-range').textContent =
    week ? 'Last 7 days · Wh per day' : 'Live samples · watts';
}

function setStats(history) {
  const currentEl = document.getElementById('stat-current');
  const avgEl     = document.getElementById('stat-avg');
  const peakEl    = document.getElementById('stat-peak');

  if (!history || history.length === 0) {
    currentEl.textContent = '—';
    avgEl.textContent     = '—';
    peakEl.textContent    = '—';
    return;
  }

  const watts = history.map((e) => e.watts);
  const current = watts[watts.length - 1];
  const avg  = watts.reduce((s, v) => s + v, 0) / watts.length;
  const peak = Math.max(...watts);

  currentEl.textContent = current.toFixed(2);
  avgEl.textContent     = avg.toFixed(2);
  peakEl.textContent    = peak.toFixed(2);
}

function setDailyStats(days) {
  const currentEl = document.getElementById('stat-current');
  const avgEl     = document.getElementById('stat-avg');
  const peakEl    = document.getElementById('stat-peak');

  if (!days || days.length === 0) {
    currentEl.textContent = '—';
    avgEl.textContent     = '—';
    peakEl.textContent    = '—';
    return;
  }

  const totals = days.map((d) => d.whTotal);
  currentEl.textContent = totals[totals.length - 1].toFixed(1);
  avgEl.textContent     = (totals.reduce((s, v) => s + v, 0) / totals.length).toFixed(1);
  peakEl.textContent    = Math.max(...totals).toFixed(1);
}

// ── Site colours ────────────────────────────────────────────────────────────

const SITE_COLORS = {
  openai:     '#10a37f',
  anthropic:  '#d4651f',
  google:     '#4285f4',
  deepseek:   '#7c3aed',
  meta:       '#0668e1',
  grok:       '#e5e7eb',
  perplexity: '#20808d',
  copilot:    '#f59e0b',
  huggingface:'#f97316',
  together:   '#06b6d4',
  replicate:  '#6366f1',
};

/**
 * Stable colour for any site label. Known AI platforms keep their brand colour;
 * everything else (plain hostnames) hashes to a fixed hue, so a given site is
 * always the same colour across reloads and never collapses to a shared grey.
 *
 * @param {string|null} site
 * @returns {string} CSS colour
 */
function siteColor(site) {
  if (!site) return isDark ? '#8b93a7' : '#9ca3af';
  if (SITE_COLORS[site]) return SITE_COLORS[site];

  let hash = 0;
  for (let i = 0; i < site.length; i++) {
    hash = (hash * 31 + site.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return isDark ? `hsl(${hue}, 62%, 62%)` : `hsl(${hue}, 58%, 45%)`;
}

// ── Chart ───────────────────────────────────────────────────────────────────

// Samples arrive every 10 s; a gap wider than 3 sample intervals means the tab
// was closed or unfocused, so the line breaks rather than bridging dead time.
const SAMPLE_INTERVAL_MS = 10000;
const GAP_THRESHOLD_MS   = SAMPLE_INTERVAL_MS * 3;

/** Set up the canvas backing store for the current DPR and return its geometry. */
function prepareCanvas() {
  const canvas = document.getElementById('chart');
  const ctx    = canvas.getContext('2d');

  const dpr  = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width  = Math.round(rect.width  * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = rect.width, H = rect.height;
  return {
    ctx, W, H,
    pl: PADDING.left, pr: PADDING.right,
    pt: PADDING.top,  pb: PADDING.bottom,
    chartW: W - PADDING.left - PADDING.right,
    chartH: H - PADDING.top  - PADDING.bottom,
  };
}

/** Horizontal gridlines plus their value labels, both scaled to yMax. */
function drawGrid(g, yMax, format) {
  const { ctx, W, pl, pr, pt, chartH } = g;
  ctx.font      = '10px -apple-system, sans-serif';
  ctx.textAlign = 'right';

  for (let i = 0; i <= 4; i++) {
    // Label from yMax, the same scale the points are plotted against — using
    // the raw peak here made every label read ~20% low.
    const val = (yMax * i) / 4;
    const yPx = pt + chartH - (i / 4) * chartH;

    ctx.strokeStyle = CHART.grid;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(pl, yPx);
    ctx.lineTo(W - pr, yPx);
    ctx.stroke();

    ctx.fillStyle = CHART.gridLabel;
    ctx.fillText(format(val), pl - 6, yPx + 3.5);
  }
}

/** Legend swatches along the top edge, wrapping is not needed at these counts. */
function drawLegend(g, sites) {
  if (sites.length === 0) return;
  const { ctx, pl, pt } = g;
  ctx.textAlign = 'left';
  ctx.font      = '9px -apple-system, sans-serif';
  let lx = pl;
  for (const site of sites) {
    ctx.fillStyle = siteColor(site);
    ctx.beginPath();
    ctx.arc(lx + 4, pt - 6, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = CHART.gridLabel;
    ctx.fillText(site, lx + 12, pt - 3);
    lx += ctx.measureText(site).width + 24;
  }
}

function drawChart(history) {
  const g = prepareCanvas();
  const { ctx, W, H, pl, pt, chartW, chartH } = g;

  ctx.clearRect(0, 0, W, H);

  const peak = Math.max(...history.map((e) => e.watts));
  const yMax = peak > 0 ? peak * 1.2 : 1;
  const n    = history.length;

  drawGrid(g, yMax, (v) => v.toFixed(1));

  // X is proportional to real elapsed time, so a 5-minute gap reads as five
  // times the width of a 10-second one and matches the time axis below.
  const t0 = history[0].ts;
  const t1 = history[n - 1].ts;
  const span = t1 - t0;
  const xFor = (ts) => (span > 0 ? pl + ((ts - t0) / span) * chartW : pl + chartW / 2);

  const points = history.map((entry) => ({
    x: xFor(entry.ts),
    y: pt + chartH - (entry.watts / yMax) * chartH,
    watts: entry.watts,
    site: entry.site ?? 'unknown',
    ts: entry.ts,
  }));

  // One polyline per site. A single line through every entry would zigzag
  // between unrelated sites whenever the user switches tabs.
  const bySite = new Map();
  for (const p of points) {
    if (!bySite.has(p.site)) bySite.set(p.site, []);
    bySite.get(p.site).push(p);
  }

  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';

  for (const [site, pts] of bySite) {
    const color = siteColor(site);

    // Straight segments, no bezier: smoothing overshoots on sparse noisy data
    // and invents peaks that were never sampled.
    ctx.beginPath();
    let penDown = false;
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const gap = i > 0 && cur.ts - pts[i - 1].ts > GAP_THRESHOLD_MS;
      if (!penDown || gap) {
        ctx.moveTo(cur.x, cur.y);
        penDown = true;
      } else {
        ctx.lineTo(cur.x, cur.y);
      }
    }
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.stroke();

    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fillStyle   = color;
      ctx.strokeStyle = CHART.dotStroke;
      ctx.lineWidth   = 1.5;
      ctx.fill();
      ctx.stroke();
    }
  }

  // Time axis, positioned by the same timestamp mapping as the points.
  ctx.fillStyle = CHART.timeLabel;
  ctx.textAlign = 'center';
  ctx.font      = '10px -apple-system, sans-serif';
  const labelCount = Math.min(n, 5);
  for (let i = 0; i < labelCount; i++) {
    const idx   = Math.round((i / (labelCount - 1 || 1)) * (n - 1));
    const label = new Date(history[idx].ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    ctx.fillText(label, xFor(history[idx].ts), H - 8);
  }

  drawLegend(g, [...bySite.keys()]);
}

/**
 * Week view: stacked per-site Wh bars, one column per calendar day.
 * @param {Array<{day:string, whTotal:number, bySite:object}>} days
 */
function drawDailyChart(days) {
  const g = prepareCanvas();
  const { ctx, W, H, pl, pt, chartW, chartH } = g;

  ctx.clearRect(0, 0, W, H);

  const peak = Math.max(...days.map((d) => d.whTotal));
  const yMax = peak > 0 ? peak * 1.2 : 1;

  drawGrid(g, yMax, (v) => v.toFixed(0));

  const sites = [...new Set(days.flatMap((d) => Object.keys(d.bySite)))];

  const slot     = chartW / days.length;
  const barW     = Math.min(slot * 0.6, 48);
  const baseline = pt + chartH;

  days.forEach((d, i) => {
    const cx = pl + slot * (i + 0.5);
    let yCursor = baseline;

    // Stack the day's sites so column height still equals whTotal.
    for (const site of sites) {
      const wh = d.bySite[site] ?? 0;
      if (wh <= 0) continue;
      const h = (wh / yMax) * chartH;
      ctx.fillStyle = siteColor(site);
      ctx.fillRect(cx - barW / 2, yCursor - h, barW, h);
      yCursor -= h;
    }

    ctx.fillStyle = CHART.timeLabel;
    ctx.textAlign = 'center';
    ctx.font      = '10px -apple-system, sans-serif';
    const [, mm, dd] = d.day.split('-');
    ctx.fillText(`${mm}/${dd}`, cx, H - 8);
  });

  drawLegend(g, sites);
}

// ── Clear / Refresh buttons ─────────────────────────────────────────────────

document.getElementById('clear-btn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
  await loadAndRender();
});

document.getElementById('refresh-btn').addEventListener('click', () => {
  loadAndRender();
});

// ── Day / Week range toggle ─────────────────────────────────────────────────

const dayBtn  = document.getElementById('range-day-btn');
const weekBtn = document.getElementById('range-week-btn');

function setRange(next) {
  range = next;
  dayBtn.classList.toggle('active',  next === 'day');
  weekBtn.classList.toggle('active', next === 'week');
  loadAndRender();
}

dayBtn.addEventListener('click',  () => setRange('day'));
weekBtn.addEventListener('click', () => setRange('week'));

// ── Init ────────────────────────────────────────────────────────────────────

(async () => {
  const { ecoPromptTheme } = await chrome.storage.local.get('ecoPromptTheme');
  applyTheme(ecoPromptTheme !== 'light');
  loadAndRender();
})();
