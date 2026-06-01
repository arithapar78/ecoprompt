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

// ── Data loading ────────────────────────────────────────────────────────────

async function loadAndRender() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
  const history = response?.history ?? [];

  if (history.length === 0) {
    document.getElementById('chart').classList.add('hidden');
    document.getElementById('empty-msg').classList.remove('hidden');
    setStats(null);
    return;
  }

  document.getElementById('chart').classList.remove('hidden');
  document.getElementById('empty-msg').classList.add('hidden');
  setStats(history);
  drawChart(history);
}

// ── Stats ───────────────────────────────────────────────────────────────────

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

// ── Site colours ────────────────────────────────────────────────────────────

const SITE_COLORS = {
  openai:     '#10a37f',
  anthropic:  '#d4651f',
  google:     '#4285f4',
  stability:  '#7c3aed',
  mistral:    '#f59e0b',
  cohere:     '#ec4899',
  huggingface:'#f97316',
  together:   '#06b6d4',
  replicate:  '#6366f1',
};

function siteColor(site) {
  return SITE_COLORS[site] ?? '#888';
}

// ── Chart ───────────────────────────────────────────────────────────────────

function drawChart(history) {
  const canvas = document.getElementById('chart');
  const ctx    = canvas.getContext('2d');

  const dpr  = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width  = Math.round(rect.width  * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;

  const pl = PADDING.left, pr = PADDING.right;
  const pt = PADDING.top,  pb = PADDING.bottom;
  const chartW = W - pl - pr;
  const chartH = H - pt - pb;

  ctx.clearRect(0, 0, W, H);

  const peak = Math.max(...history.map((e) => e.watts));
  const yMax = peak > 0 ? peak * 1.2 : 1;
  const n    = history.length;

  ctx.font      = '10px -apple-system, sans-serif';
  ctx.textAlign = 'right';

  for (let i = 0; i <= 4; i++) {
    const wVal = (peak * i) / 4;
    const yPx  = pt + chartH - (i / 4) * chartH;

    ctx.strokeStyle = CHART.grid;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(pl, yPx);
    ctx.lineTo(W - pr, yPx);
    ctx.stroke();

    ctx.fillStyle = CHART.gridLabel;
    ctx.fillText(wVal.toFixed(1), pl - 6, yPx + 3.5);
  }

  const points = history.map((entry, i) => ({
    x: pl + (n > 1 ? (i / (n - 1)) * chartW : chartW / 2),
    y: pt + chartH - (entry.watts / yMax) * chartH,
    watts: entry.watts,
    site: entry.site,
    ts: entry.ts,
  }));

  const grad = ctx.createLinearGradient(0, pt, 0, pt + chartH);
  grad.addColorStop(0, CHART.fillTop);
  grad.addColorStop(1, CHART.fillBottom);

  ctx.beginPath();
  ctx.moveTo(points[0].x, pt + chartH);
  points.forEach((p) => ctx.lineTo(p.x, p.y));
  ctx.lineTo(points[points.length - 1].x, pt + chartH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  function drawLine(lineWidth, strokeStyle, shadowBlur, shadowColor) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const cur  = points[i];
      const cpx  = (prev.x + cur.x) / 2;
      ctx.bezierCurveTo(cpx, prev.y, cpx, cur.y, cur.x, cur.y);
    }
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth   = lineWidth;
    ctx.lineJoin    = 'round';
    ctx.shadowBlur  = shadowBlur;
    ctx.shadowColor = shadowColor;
    ctx.stroke();
    ctx.shadowBlur  = 0;
  }

  drawLine(6,  CHART.lineGlow, 0, 'transparent');
  drawLine(2,  CHART.line,     8, CHART.lineGlow);

  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle   = siteColor(p.site) !== '#888' ? siteColor(p.site) : CHART.dotFill;
    ctx.strokeStyle = CHART.dotStroke;
    ctx.lineWidth   = 2;
    ctx.shadowBlur  = 6;
    ctx.shadowColor = CHART.lineGlow;
    ctx.fill();
    ctx.shadowBlur  = 0;
    ctx.stroke();
  }

  ctx.fillStyle = CHART.timeLabel;
  ctx.textAlign = 'center';
  ctx.font      = '10px -apple-system, sans-serif';
  const labelCount = Math.min(n, 5);
  for (let i = 0; i < labelCount; i++) {
    const idx   = Math.round((i / (labelCount - 1 || 1)) * (n - 1));
    const label = new Date(history[idx].ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    ctx.fillText(label, points[idx].x, H - 8);
  }

  const sites = [...new Set(history.map((e) => e.site).filter(Boolean))];
  if (sites.length > 0) {
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
}

// ── Clear / Refresh buttons ─────────────────────────────────────────────────

document.getElementById('clear-btn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
  await loadAndRender();
});

document.getElementById('refresh-btn').addEventListener('click', () => {
  loadAndRender();
});

// ── Init ────────────────────────────────────────────────────────────────────

(async () => {
  const { ecoPromptTheme } = await chrome.storage.local.get('ecoPromptTheme');
  applyTheme(ecoPromptTheme !== 'light');
  loadAndRender();
})();
