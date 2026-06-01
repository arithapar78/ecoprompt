// options/options.js
// Role: load watt history and render the stats + line chart.
//
// Chart logic:
//   - X axis: time. Points are spread evenly across canvas width proportional
//     to their actual timestamps so gaps are visible.
//   - Y axis: watts. Range is 0 → max(watts) padded by 20%, so the line
//     never touches the top edge.
//   - Drawn with native canvas 2D — no library needed.
//   - A thin grid of horizontal guide lines is drawn at 25% intervals.

const PADDING = { top: 16, right: 16, bottom: 32, left: 44 };

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

  // ── Horizontal grid lines + Y labels ─────────────────────────────────────
  ctx.font      = '10px -apple-system, sans-serif';
  ctx.textAlign = 'right';

  for (let i = 0; i <= 4; i++) {
    const wVal = (peak * i) / 4;
    const yPx  = pt + chartH - (i / 4) * chartH;

    ctx.strokeStyle = '#e8e8e8';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(pl, yPx);
    ctx.lineTo(W - pr, yPx);
    ctx.stroke();

    ctx.fillStyle = '#999';
    ctx.fillText(wVal.toFixed(1), pl - 4, yPx + 3);
  }

  // ── Compute point coordinates ─────────────────────────────────────────────
  const points = history.map((entry, i) => ({
    x: pl + (n > 1 ? (i / (n - 1)) * chartW : chartW / 2),
    y: pt + chartH - (entry.watts / yMax) * chartH,
    watts: entry.watts,
    site: entry.site,
    ts: entry.ts,
  }));

  // ── Filled area under the line ────────────────────────────────────────────
  const grad = ctx.createLinearGradient(0, pt, 0, pt + chartH);
  grad.addColorStop(0, 'rgba(52, 168, 83, 0.25)');
  grad.addColorStop(1, 'rgba(52, 168, 83, 0.02)');

  ctx.beginPath();
  ctx.moveTo(points[0].x, pt + chartH);
  points.forEach((p) => ctx.lineTo(p.x, p.y));
  ctx.lineTo(points[points.length - 1].x, pt + chartH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // ── Line ──────────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur  = points[i];
    const cpx  = (prev.x + cur.x) / 2;
    ctx.bezierCurveTo(cpx, prev.y, cpx, cur.y, cur.x, cur.y);
  }
  ctx.strokeStyle = '#34a853';
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';
  ctx.stroke();

  // ── Data points ───────────────────────────────────────────────────────────
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fillStyle   = siteColor(p.site) !== '#888' ? siteColor(p.site) : '#34a853';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth   = 1.5;
    ctx.fill();
    ctx.stroke();
  }

  // ── X axis time labels ────────────────────────────────────────────────────
  ctx.fillStyle = '#999';
  ctx.textAlign = 'center';
  ctx.font      = '10px -apple-system, sans-serif';
  const labelCount = Math.min(n, 5);
  for (let i = 0; i < labelCount; i++) {
    const idx   = Math.round((i / (labelCount - 1 || 1)) * (n - 1));
    const label = new Date(history[idx].ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    ctx.fillText(label, points[idx].x, H - 6);
  }

  // ── Legend ────────────────────────────────────────────────────────────────
  const sites = [...new Set(history.map((e) => e.site).filter(Boolean))];
  if (sites.length > 0) {
    ctx.textAlign = 'left';
    ctx.font      = '9px -apple-system, sans-serif';
    let lx = pl;
    for (const site of sites) {
      ctx.fillStyle = siteColor(site);
      ctx.beginPath();
      ctx.arc(lx + 4, pt - 4, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#666';
      ctx.fillText(site, lx + 12, pt - 1);
      lx += ctx.measureText(site).width + 24;
    }
  }
}

// ── Clear button ────────────────────────────────────────────────────────────

document.getElementById('clear-btn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
  await loadAndRender();
});

// ── Refresh button ───────────────────────────────────────────────────────────

document.getElementById('refresh-btn').addEventListener('click', () => {
  loadAndRender();
});

// ── Init ────────────────────────────────────────────────────────────────────

loadAndRender();
