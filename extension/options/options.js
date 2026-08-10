// options/options.js
// Role: controller for the Settings page — tab navigation, view state, data
// fetching, stats, and wiring the chart layer in chart.js to the DOM.
//
// All chart math and painting lives in chart.js (global `EcoChart`); this file
// owns state, storage, events, and the HTML legend/tooltip.

const C = window.EcoChart;

// ── View state ──────────────────────────────────────────────────────────────

let isDark = true;
let chartType = 'line';   // 'line' | 'bar' | 'pie'
let chartRange = 'day';   // 'day'  | 'week'

// Log scale: null means "decide automatically from the data"; true/false is a
// user override that sticks until the range or type changes.
let logScale = null;
let logUserSet = false;

// Series hidden via legend clicks, keyed by site key.
const hiddenSeries = new Set();

// Latest hit-test index from the last paint, for tooltip lookups.
let currentHits = [];

// Monotonic render token. Every async render captures the value at entry and
// bails if a newer render started meanwhile, so a slow Day fetch can never
// paint over a Week chart that was requested after it.
let renderToken = 0;

// ── Theme ───────────────────────────────────────────────────────────────────

function applyTheme(dark) {
  isDark = dark;
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
    if (target === 'history') loadAndRender();
  });
});

// ── Mock fixtures (dev only) ────────────────────────────────────────────────
// Enabled only by an explicit ?mock=<scenario> on the options page URL, so it
// can never affect a normal install.

const MOCK = new URLSearchParams(location.search).get('mock');

function buildMock(name) {
  const now = Date.now();
  const H = (ts, watts, site) => ({ ts, watts, site });
  const hist = [];
  const daily = {};
  const dayKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const addDaily = (ts, site, wh) => {
    const k = dayKey(ts);
    daily[k] = daily[k] ?? { whTotal: 0, bySite: {} };
    daily[k].whTotal += wh;
    daily[k].bySite[site] = (daily[k].bySite[site] ?? 0) + wh;
  };

  switch (name) {
    case 'empty':
      break;

    case 'single':
      hist.push(H(now, 3.2, 'github.com'));
      addDaily(now, 'github.com', 0.009);
      break;

    case 'mixed': {
      // 2 h: one AI site at ~47 W plus two normal sites at 1–5 W.
      for (let i = 0; i < 720; i++) {
        const ts = now - (720 - i) * 10000;
        const pick = i % 3;
        if (pick === 0) hist.push(H(ts, 47 + Math.sin(i / 9) * 1.6, 'openai'));
        else if (pick === 1) hist.push(H(ts, 2.1 + Math.sin(i / 5) * 0.7, 'github.com'));
        else hist.push(H(ts, 4.4 + Math.cos(i / 7) * 0.9, 'news.ycombinator.com'));
      }
      for (let d = 4; d >= 0; d--) {
        const ts = now - d * 86400000;
        addDaily(ts, 'openai', 30 + d * 4);
        addDaily(ts, 'github.com', 1.6 + d * 0.2);
        addDaily(ts, 'news.ycombinator.com', 3.1);
      }
      break;
    }

    case 'outlier': {
      for (let i = 0; i < 200; i++) {
        const ts = now - (200 - i) * 10000;
        hist.push(H(ts, 2.4 + Math.sin(i / 6) * 0.5, 'github.com'));
      }
      hist.push(H(now - 900000, 476, 'deepseek'));
      for (let d = 3; d >= 0; d--) {
        addDaily(now - d * 86400000, 'github.com', 2.2);
      }
      addDaily(now, 'deepseek', 61);
      break;
    }

    case 'full': {
      const sites = ['openai', 'anthropic', 'github.com', 'news.ycombinator.com', 'youtube.com', null];
      for (let i = 0; i < 2880; i++) {
        const ts = now - (2880 - i) * 10000;
        const s = sites[i % sites.length];
        const base = s === 'openai' ? 47 : s === 'anthropic' ? 60 : s === 'youtube.com' ? 6 : 2.5;
        hist.push(H(ts, base + Math.sin(i / 11) * (base * 0.12), s));
      }
      for (let d = 9; d >= 0; d--) {
        const ts = now - d * 86400000;
        for (const s of sites) addDaily(ts, s ?? 'unknown', 4 + Math.abs(Math.sin(d + (s ? s.length : 1))) * 22);
      }
      break;
    }

    case 'gaps': {
      // 20 min of samples, a 40-min unfocused gap, then 20 min more.
      for (let i = 0; i < 120; i++) hist.push(H(now - 4800000 + i * 10000, 3.1, 'github.com'));
      for (let i = 0; i < 120; i++) hist.push(H(now - 1200000 + i * 10000, 4.4, 'github.com'));
      addDaily(now, 'github.com', 0.9);
      break;
    }

    case 'oneday': {
      for (let i = 0; i < 60; i++) hist.push(H(now - (60 - i) * 10000, 3.3, 'openai'));
      addDaily(now, 'openai', 18.5);
      addDaily(now, 'github.com', 2.4);
      break;
    }
  }
  return { history: hist, daily };
}

// ── Data access ─────────────────────────────────────────────────────────────

async function fetchHistory() {
  if (MOCK) return buildMock(MOCK).history;
  const res = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
  return res?.history ?? [];
}

async function fetchDaily() {
  if (MOCK) return buildMock(MOCK).daily;
  const res = await chrome.runtime.sendMessage({ type: 'GET_DAILY' });
  return res?.daily ?? {};
}

// ── Stats ───────────────────────────────────────────────────────────────────

// Beyond this the newest sample no longer describes "now", so Current is shown
// as stale rather than as a confidently wrong number.
const STALE_AFTER_MS = 60000;

function setStatLabels(mode) {
  const week = mode === 'week';
  document.getElementById('stat-current-label').textContent = week ? 'Today' : 'Current';
  document.getElementById('stat-avg-label').textContent     = week ? 'Daily Avg' : 'Average';
  document.getElementById('stat-peak-label').textContent    = week ? 'Busiest Day' : 'Peak';
  const unit = week ? 'Wh' : 'W';
  document.getElementById('stat-current-unit').textContent = unit;
  document.getElementById('stat-avg-unit').textContent     = unit;
  document.getElementById('stat-peak-unit').textContent    = unit;
}

function setStats({ current, avg, peak, staleMs }) {
  const currentEl = document.getElementById('stat-current');
  const unitEl    = document.getElementById('stat-current-unit');

  if (current == null) {
    currentEl.textContent = '—';
    unitEl.textContent = staleMs != null ? 'stale' : unitEl.textContent;
    unitEl.classList.toggle('stale', staleMs != null);
  } else {
    currentEl.textContent = current;
    unitEl.classList.remove('stale');
  }

  document.getElementById('stat-avg').textContent  = avg  ?? '—';
  document.getElementById('stat-peak').textContent = peak ?? '—';
}

function dayStats(history) {
  if (history.length === 0) return { current: null, avg: null, peak: null };
  const sorted = [...history].sort((a, b) => a.ts - b.ts);
  const newest = sorted[sorted.length - 1];
  const age = Date.now() - newest.ts;
  const watts = sorted.map((e) => e.watts);
  return {
    // Stale readings are withheld: the newest sample belongs to whichever tab
    // last held focus, so after a minute it is not "current" in any useful sense.
    current: age > STALE_AFTER_MS ? null : newest.watts.toFixed(2),
    staleMs: age > STALE_AFTER_MS ? age : null,
    avg:  (watts.reduce((s, v) => s + v, 0) / watts.length).toFixed(2),
    peak: Math.max(...watts).toFixed(2),
  };
}

function weekStats(cols) {
  if (cols.length === 0) return { current: null, avg: null, peak: null };
  const totals = cols.map((c) => c.total);
  return {
    current: totals[totals.length - 1].toFixed(1),
    avg:  (totals.reduce((s, v) => s + v, 0) / totals.length).toFixed(1),
    peak: Math.max(...totals).toFixed(1),
  };
}

// ── Legend (HTML, below the canvas — never painted onto it) ─────────────────

function renderLegend(entries) {
  const el = document.getElementById('chart-legend');
  el.innerHTML = '';
  if (entries.length === 0) return;

  for (const e of entries) {
    const hidden = hiddenSeries.has(e.key);
    const item = document.createElement('button');
    item.type = 'button';
    item.classList.add('legend-item');
    if (hidden) item.classList.add('off');
    item.setAttribute('aria-pressed', String(!hidden));
    item.title = hidden ? `Show ${e.label}` : `Hide ${e.label}`;

    const dot = document.createElement('span');
    dot.className = 'legend-dot';
    dot.style.background = e.color;

    const text = document.createElement('span');
    text.textContent = e.label;

    item.append(dot, text);
    item.addEventListener('click', () => {
      if (hiddenSeries.has(e.key)) hiddenSeries.delete(e.key);
      else hiddenSeries.add(e.key);
      loadAndRender();
    });
    el.appendChild(item);
  }
}

// ── Tooltip ─────────────────────────────────────────────────────────────────

const canvasEl  = document.getElementById('chart');
const tooltipEl = document.getElementById('chart-tooltip');

function showTooltip(hit, mx, my) {
  const parts = [`<span class="tt-site"><span class="tt-dot" style="background:${hit.color}"></span>${escapeHtml(hit.label)}</span>`];

  if (hit.isPie) {
    parts.push(`<span class="tt-val">${hit.value.toFixed(1)} Wh · ${(hit.share * 100).toFixed(1)}%</span>`);
  } else {
    parts.push(`<span class="tt-val">${formatTooltipValue(hit.value)} ${hit.unit}</span>`);
    if (hit.ts) parts.push(`<span class="tt-ts">${hit.tsFormat(hit.ts)}</span>`);
  }

  tooltipEl.innerHTML = parts.join('');
  tooltipEl.classList.remove('hidden');

  // Keep the tooltip inside the wrapper.
  const wrap = document.getElementById('chart-wrap').getBoundingClientRect();
  const tw = tooltipEl.offsetWidth, th = tooltipEl.offsetHeight;
  let x = mx + 14, y = my - th - 10;
  if (x + tw > wrap.width) x = mx - tw - 14;
  if (y < 0) y = my + 16;
  tooltipEl.style.left = Math.max(0, x) + 'px';
  tooltipEl.style.top  = Math.max(0, y) + 'px';
}

function formatTooltipValue(v) {
  if (v >= 1000) return (v / 1000).toFixed(2) + 'k';
  if (v >= 100)  return v.toFixed(0);
  if (v >= 10)   return v.toFixed(1);
  return v.toFixed(2);
}

function hideTooltip() {
  tooltipEl.classList.add('hidden');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

canvasEl.addEventListener('mousemove', (ev) => {
  // Mouse position in CSS pixels relative to the canvas box — the same space
  // the hit index was built in, so no canvas re-read is needed.
  const r = canvasEl.getBoundingClientRect();
  const mx = ev.clientX - r.left;
  const my = ev.clientY - r.top;
  const hit = C.hitTest(currentHits, mx, my);
  if (hit) showTooltip(hit, mx, my);
  else hideTooltip();
});

canvasEl.addEventListener('mouseleave', hideTooltip);

// ── Time formatting ─────────────────────────────────────────────────────────

const fmtClock = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtHour = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: 'numeric' });
const fmtDay = (ts) => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

// ── Scale helpers ───────────────────────────────────────────────────────────

function resolveLog(values) {
  if (logUserSet) return !!logScale;
  const auto = C.shouldAutoLog(values);
  logScale = auto;
  document.getElementById('log-toggle').checked = auto;
  return auto;
}

function setScaleBadge(active) {
  document.getElementById('scale-badge').classList.toggle('hidden', !active);
}

// ── Render ──────────────────────────────────────────────────────────────────

function showEmpty(show) {
  document.getElementById('empty-msg').classList.toggle('hidden', !show);
  document.getElementById('chart-wrap').classList.toggle('hidden', show);
}

function setNote(text) {
  const el = document.getElementById('chart-note');
  el.textContent = text ?? '';
  el.classList.toggle('hidden', !text);
}

async function loadAndRender() {
  const token = ++renderToken;

  setStatLabels(chartRange);
  document.getElementById('log-toggle-wrap').classList.toggle('hidden', chartType === 'pie');

  const [history, daily] = await Promise.all([
    chartRange === 'day' || chartType === 'pie' ? fetchHistory() : Promise.resolve([]),
    chartRange === 'week' ? fetchDaily() : Promise.resolve({}),
  ]);

  // A newer render started while we were awaiting — drop this one entirely
  // rather than painting stale data over it.
  if (token !== renderToken) return;

  hideTooltip();

  if (chartRange === 'day') renderDay(history, token);
  else renderWeek(daily, history, token);
}

function renderDay(history, token) {
  if (history.length === 0) {
    showEmpty(true);
    setStats({ current: null, avg: null, peak: null });
    renderLegend([]);
    setNote(null);
    setScaleBadge(false);
    currentHits = C.drawEmptyGrid(canvasEl, isDark);
    return;
  }
  showEmpty(false);
  setStats(dayStats(history));

  const keys = [...new Set(history.map((e) => C.siteKey(e.site)))];
  const legend = keys.map((k) => ({ key: k, label: C.siteLabel(k), color: C.siteColor(k, isDark) }));

  // AI backend energy is a per-model constant upstream, not a measurement.
  // Say so rather than letting a flat line read as observed behaviour.
  const hasAI = keys.some((k) => k !== '__unknown__' && C.siteLabel(k) !== k);
  setNote(hasAI ? 'Backend AI energy is modeled per query, not measured.' : null);

  if (chartType === 'pie') {
    renderPie(C.whBySiteFromHistory(history), legend, token);
    return;
  }

  if (chartType === 'bar') {
    const hours = C.hourlyWh(history);
    const columns = hours.map((h) => {
      const segments = [];
      let acc = 0;
      for (const [key, wh] of h.bySite) {
        if (hiddenSeries.has(key)) continue;
        segments.push({ key, label: C.siteLabel(key), value: wh, stackBottom: acc, stackTop: acc + wh });
        acc += wh;
      }
      return { ts: h.ts, segments, total: acc };
    }).filter((c) => c.segments.length > 0);

    const max = columns.length ? Math.max(...columns.map((c) => c.total)) : 0;
    // Stacked bars are read column-to-column, so the totals are the comparison.
    const useLog = resolveLog(columns.map((c) => [c.total]));
    setScaleBadge(useLog);

    if (max <= 0) { currentHits = C.drawEmptyGrid(canvasEl, isDark); renderLegend(legend); return; }

    currentHits = C.drawBars(canvasEl, {
      columns, max, unit: 'Wh', tsFormat: fmtHour,
    }, { isDark, log: useLog });
    renderLegend(legend);
    document.getElementById('chart-range').textContent = 'Wh per hour (while browsing)';
    return;
  }

  // Line
  const { series, t0, t1, bucketMs } = C.bucketHistory(history);
  const visible = series.filter((s) => !hiddenSeries.has(s.key));
  const max = visible.length
    ? Math.max(...visible.flatMap((s) => s.buckets.map((b) => b.max)))
    : 0;
  // Grouped per site: a low-wattage site next to an AI site is what decides the
  // scale, not the spread within any one series.
  const useLog = resolveLog(visible.map((s) => s.buckets.map((b) => b.mean)));
  setScaleBadge(useLog);

  currentHits = C.drawLine(canvasEl, {
    series: visible.map((s) => ({
      key: s.key,
      label: C.siteLabel(s.key),
      visible: true,
      points: s.buckets.map((b) => ({ ts: b.ts, value: b.mean, min: b.min, max: b.max, n: b.n })),
    })),
    max, t0, t1,
    gapMs: Math.max(C.GAP_THRESHOLD_MS, bucketMs * 1.5),
    hasBand: true,
    unit: 'W',
    stamps: [t0, t1],
    tsFormat: fmtClock,
  }, { isDark, log: useLog });

  renderLegend(legend);
  document.getElementById('chart-range').textContent =
    `Watts · ${fmtClock(t0)}–${fmtClock(t1)}`;
  void token;
}

function renderWeek(daily, history, token) {
  const cols = C.dailyColumns(daily);

  if (cols.length === 0) {
    showEmpty(true);
    setStats({ current: null, avg: null, peak: null });
    renderLegend([]);
    setNote(null);
    setScaleBadge(false);
    currentHits = C.drawEmptyGrid(canvasEl, isDark);
    return;
  }
  showEmpty(false);
  setStats(weekStats(cols));

  const keys = [...new Set(cols.flatMap((c) => [...c.bySite.keys()]))];
  const legend = keys.map((k) => ({ key: k, label: C.siteLabel(k), color: C.siteColor(k, isDark) }));
  const hasAI = keys.some((k) => k !== '__unknown__' && C.siteLabel(k) !== k);
  setNote(hasAI ? 'Backend AI energy is modeled per query, not measured.' : null);

  if (chartType === 'pie') {
    renderPie(C.whBySiteFromDaily(daily), legend, token);
    return;
  }

  if (chartType === 'bar') {
    const columns = cols.map((c) => {
      const segments = [];
      let acc = 0;
      for (const [key, wh] of c.bySite) {
        if (hiddenSeries.has(key) || wh <= 0) continue;
        segments.push({ key, label: C.siteLabel(key), value: wh, stackBottom: acc, stackTop: acc + wh });
        acc += wh;
      }
      return { ts: c.ts, segments, total: acc };
    });

    const max = Math.max(0, ...columns.map((c) => c.total));
    const useLog = resolveLog(columns.map((c) => [c.total]));
    setScaleBadge(useLog);

    if (max <= 0) { currentHits = C.drawEmptyGrid(canvasEl, isDark); renderLegend(legend); return; }

    currentHits = C.drawBars(canvasEl, {
      columns, max, unit: 'Wh', tsFormat: fmtDay,
    }, { isDark, log: useLog });
    renderLegend(legend);
    document.getElementById('chart-range').textContent = 'Wh (while browsing) · per day';
    return;
  }

  // Line: one series per site plus a bold total.
  const series = keys.filter((k) => !hiddenSeries.has(k)).map((k) => ({
    key: k,
    label: C.siteLabel(k),
    visible: true,
    points: cols.map((c) => ({ ts: c.ts, value: c.bySite.get(k) ?? 0, min: 0, max: 0, n: 1 })),
  }));
  if (series.length > 1) {
    series.push({
      key: '__total__',
      label: 'Total',
      visible: true,
      points: cols.map((c) => ({
        ts: c.ts,
        value: [...c.bySite.entries()].reduce((s, [k, v]) => s + (hiddenSeries.has(k) ? 0 : v), 0),
        min: 0, max: 0, n: 1,
      })),
    });
  }

  const max = Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.value)));
  // The synthetic total line is excluded: it is by construction the largest
  // series and would bias the ratio toward log on every multi-site week.
  const useLog = resolveLog(
    series.filter((s) => s.key !== '__total__').map((s) => s.points.map((p) => p.value)),
  );
  setScaleBadge(useLog);

  currentHits = C.drawLine(canvasEl, {
    series, max,
    t0: cols[0].ts,
    t1: cols[cols.length - 1].ts,
    // One column per calendar day; nothing should ever break between them.
    gapMs: 86400000 * 1.5,
    hasBand: false,
    unit: 'Wh',
    stamps: cols.map((c) => c.ts),
    tsFormat: fmtDay,
  }, { isDark, log: useLog });

  renderLegend(legend);
  document.getElementById('chart-range').textContent = 'Wh (while browsing) · per day';
  void history;
}

function renderPie(whMap, legend, token) {
  for (const k of hiddenSeries) whMap.delete(k);
  const { slices, total } = C.pieSlices(whMap);

  if (total <= 0) {
    showEmpty(true);
    renderLegend(legend);
    currentHits = C.drawEmptyGrid(canvasEl, isDark);
    return;
  }
  showEmpty(false);
  setScaleBadge(false);

  currentHits = C.drawPie(canvasEl, { slices, total }, { isDark });
  renderLegend(legend);
  document.getElementById('chart-range').textContent =
    `Wh share by site · ${chartRange === 'day' ? 'recent buffer' : 'per day rollup'}`;
  void token;
}

// ── Controls ────────────────────────────────────────────────────────────────

function persist() {
  chrome.storage.local.set({
    ecoPromptChartType:  chartType,
    ecoPromptChartRange: chartRange,
  });
}

function syncToggles() {
  document.querySelectorAll('[data-type]').forEach((b) => {
    const on = b.dataset.type === chartType;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('[data-range]').forEach((b) => {
    const on = b.dataset.range === chartRange;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
}

function setType(next) {
  if (next === chartType) return;
  chartType = next;
  logUserSet = false;          // let the new view pick its own scale
  syncToggles();
  persist();
  loadAndRender();
}

function setRange(next) {
  if (next === chartRange) return;
  chartRange = next;
  logUserSet = false;
  syncToggles();
  persist();
  loadAndRender();
}

/** Arrow-key navigation within a role="tablist" group. */
function wireTablist(selector, apply) {
  const group = document.querySelectorAll(selector);
  group.forEach((btn) => {
    btn.addEventListener('click', () => apply(btn));
    btn.addEventListener('keydown', (ev) => {
      const items = [...group];
      const i = items.indexOf(btn);
      let next = null;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = items[(i + 1) % items.length];
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = items[(i - 1 + items.length) % items.length];
      else if (ev.key === 'Home') next = items[0];
      else if (ev.key === 'End') next = items[items.length - 1];
      if (next) {
        ev.preventDefault();
        next.focus();
        apply(next);
      }
    });
  });
}

wireTablist('[data-type]',  (b) => setType(b.dataset.type));
wireTablist('[data-range]', (b) => setRange(b.dataset.range));

document.getElementById('log-toggle').addEventListener('change', (ev) => {
  logScale = ev.target.checked;
  logUserSet = true;
  loadAndRender();
});

document.getElementById('refresh-btn').addEventListener('click', () => loadAndRender());

document.getElementById('clear-btn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
  hiddenSeries.clear();
  await loadAndRender();
});

// ── Resize ──────────────────────────────────────────────────────────────────

let resizeTimer = null;
const ro = new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => loadAndRender(), 150);
});
ro.observe(document.getElementById('chart-wrap'));

// ── Init ────────────────────────────────────────────────────────────────────

(async () => {
  const stored = await chrome.storage.local.get([
    'ecoPromptTheme', 'ecoPromptChartType', 'ecoPromptChartRange',
  ]);
  applyTheme(stored.ecoPromptTheme !== 'light');
  if (['line', 'bar', 'pie'].includes(stored.ecoPromptChartType)) chartType = stored.ecoPromptChartType;
  if (['day', 'week'].includes(stored.ecoPromptChartRange))       chartRange = stored.ecoPromptChartRange;
  syncToggles();
  loadAndRender();
})();
