// options/chart.js
// Role: pure chart layer — data shaping, scales, drawing, hit-testing.
//
// Everything here is a pure function of (data, options) except the draw calls,
// which paint a canvas and return a hit-test index. No storage access, no
// messaging, no global state: options.js owns all of that.
//
// Units note: the ring buffer stores WATTS (instantaneous), the daily rollup
// stores WATT-HOURS (accumulated energy). Shares and totals are only ever
// computed in Wh — averaging watts across series with different sample counts
// would weight a 10-second visit the same as a 3-hour one.

(function (global) {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  // Nominal sampling cadence of the content script.
  const SAMPLE_INTERVAL_MS = 10000;

  // A wall-clock gap wider than this means the tab lost focus; the line breaks
  // rather than bridging dead time.
  const GAP_THRESHOLD_MS = SAMPLE_INTERVAL_MS * 3;

  // Upper bound on how much wall-clock a single sample may be credited with.
  // appendWatts assumes a flat 10 s per sample, but appends stop entirely when
  // the window loses focus — so a sample sitting before a 40-minute gap must not
  // be billed for those 40 minutes. Clamping to 30 s keeps idle time uncredited.
  const MAX_SAMPLE_WEIGHT_MS = 30000;

  // Auto-engage log scale once the dynamic range gets wide enough that a linear
  // axis would flatten the smaller series onto the baseline.
  //
  // The ratio is measured between the largest and smallest *typical* value
  // (per-series median), not between global extremes: a single spike in an
  // otherwise flat series says nothing about whether the axis is readable,
  // whereas one series sitting an order of magnitude under another does.
  const LOG_SCALE_RATIO = 20;

  // Day-view line is downsampled to at most this many buckets.
  const MAX_BUCKETS = 120;

  // Pie slices below this share are folded into "Other".
  const PIE_OTHER_THRESHOLD = 0.02;

  // Label shown for entries whose site could not be determined upstream
  // (a failed chrome.tabs.get stores site: null).
  const UNKNOWN_LABEL = 'Other / system pages';

  // Known AI platform keys → display names. Anything else is a bare hostname
  // and is shown as-is, so three upstream naming schemes read as one.
  const PLATFORM_NAMES = {
    openai:      'OpenAI',
    anthropic:   'Anthropic',
    google:      'Google',
    deepseek:    'DeepSeek',
    meta:        'Meta',
    grok:        'Grok',
    perplexity:  'Perplexity',
    copilot:     'Copilot',
    huggingface: 'Hugging Face',
    together:    'Together',
    replicate:   'Replicate',
  };

  // Brand colors. Light-mode variants are clamped for contrast — several brand
  // hues (grok's near-white especially) are invisible on a light background.
  const SITE_COLORS = {
    openai:      { dark: '#10a37f', light: '#0b7d61' },
    anthropic:   { dark: '#d4651f', light: '#a84e13' },
    google:      { dark: '#4285f4', light: '#2b62c4' },
    deepseek:    { dark: '#7c3aed', light: '#5b21b6' },
    meta:        { dark: '#0668e1', light: '#054fa8' },
    grok:        { dark: '#c9cedb', light: '#5b6478' },
    perplexity:  { dark: '#20808d', light: '#156069' },
    copilot:     { dark: '#f59e0b', light: '#a96a04' },
    huggingface: { dark: '#f97316', light: '#c2540a' },
    together:    { dark: '#06b6d4', light: '#0e7f95' },
    replicate:   { dark: '#6366f1', light: '#4348c7' },
  };

  // ── Site identity ─────────────────────────────────────────────────────────

  /** Stable key for a site value, collapsing null/'' to one bucket. */
  function siteKey(site) {
    return site == null || site === '' ? '__unknown__' : site;
  }

  /** Human-readable label for a site key. */
  function siteLabel(key) {
    if (key === '__unknown__') return UNKNOWN_LABEL;
    return PLATFORM_NAMES[key] ?? key;
  }

  /**
   * Stable color for a site key. Known platforms use their brand color (clamped
   * per theme); unknown hostnames hash to a fixed hue so a site keeps its color
   * across reloads.
   */
  function siteColor(key, isDark) {
    if (key === '__unknown__') return isDark ? '#8b93a7' : '#6b7280';

    const brand = SITE_COLORS[key];
    if (brand) return isDark ? brand.dark : brand.light;

    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) | 0;
    }
    const hue = Math.abs(hash) % 360;
    return isDark ? `hsl(${hue}, 62%, 62%)` : `hsl(${hue}, 58%, 38%)`;
  }

  // ── Wh weighting ──────────────────────────────────────────────────────────

  /**
   * Assign each sample the wall-clock span it actually represents: the gap to
   * the next sample, clamped to [0, 30 s]. This is what makes Wh figures honest
   * across focus gaps — a hardcoded 10 s per sample would credit a 40-minute
   * unfocused gap as continuous usage.
   *
   * A gap wider than GAP_THRESHOLD_MS means the tab stopped reporting, so the
   * sample before it is credited only its nominal interval rather than the full
   * clamp. Otherwise a break in coverage would *increase* the computed energy,
   * which is the opposite of what the gap means.
   *
   * The final sample has no successor, so it also gets the nominal interval.
   *
   * @param {Array<{ts:number, watts:number, site:string|null}>} history
   * @returns {Array<{ts:number, watts:number, key:string, wh:number, weightMs:number}>}
   */
  function weightSamples(history) {
    const sorted = [...history].sort((a, b) => a.ts - b.ts);
    return sorted.map((e, i) => {
      const next = sorted[i + 1];
      const rawGap = next ? next.ts - e.ts : SAMPLE_INTERVAL_MS;
      const weightMs =
        rawGap > GAP_THRESHOLD_MS
          ? SAMPLE_INTERVAL_MS
          : Math.max(0, Math.min(rawGap, MAX_SAMPLE_WEIGHT_MS));
      return {
        ts: e.ts,
        watts: e.watts,
        key: siteKey(e.site),
        weightMs,
        wh: e.watts * (weightMs / 3600000),
      };
    });
  }

  /** Sum Wh per site key from weighted samples. */
  function whBySiteFromHistory(history) {
    const out = new Map();
    for (const s of weightSamples(history)) {
      out.set(s.key, (out.get(s.key) ?? 0) + s.wh);
    }
    return out;
  }

  /** Sum Wh per site key from the daily rollup (used as-is; can't recompute). */
  function whBySiteFromDaily(daily) {
    const out = new Map();
    for (const day of Object.values(daily)) {
      for (const [site, wh] of Object.entries(day.bySite ?? {})) {
        const k = siteKey(site === 'unknown' ? null : site);
        out.set(k, (out.get(k) ?? 0) + wh);
      }
    }
    return out;
  }

  // ── Nice numbers ──────────────────────────────────────────────────────────

  /** Round up to the nearest 1 / 2 / 2.5 / 5 x 10^n. */
  function niceNum(range) {
    if (!(range > 0)) return 1;
    const exp  = Math.floor(Math.log10(range));
    const frac = range / Math.pow(10, exp);
    let nice;
    if (frac <= 1)      nice = 1;
    else if (frac <= 2) nice = 2;
    else if (frac <= 2.5) nice = 2.5;
    else if (frac <= 5) nice = 5;
    else                nice = 10;
    return nice * Math.pow(10, exp);
  }

  /**
   * Build linear ticks from 0 to at least max, using a nice step.
   * Guarantees unique, evenly spaced values.
   */
  function linearTicks(max, targetCount = 4) {
    if (!(max > 0)) return [0];
    const step = niceNum(max / targetCount);
    const ticks = [];
    for (let v = 0; v <= max * 1.0000001 + step * 0.5; v += step) {
      ticks.push(Math.round(v / step) * step);   // kill float drift
      if (ticks.length > 12) break;
    }
    return ticks;
  }

  /** Decade ticks spanning [min, max] for a log axis. */
  function logTicks(min, max) {
    const lo = Math.floor(Math.log10(Math.max(min, 1e-6)));
    const hi = Math.ceil(Math.log10(Math.max(max, 1e-6)));
    const ticks = [];
    for (let e = lo; e <= hi; e++) ticks.push(Math.pow(10, e));
    return ticks;
  }

  /**
   * Adaptive value formatting. Chosen per-axis from the largest tick so every
   * label on one axis shares a format.
   */
  function formatValue(v, axisMax) {
    const scale = axisMax ?? v;
    if (scale >= 1000) {
      const k = v / 1000;
      return (k >= 10 ? k.toFixed(0) : k.toFixed(1)) + 'k';
    }
    if (scale >= 100) return v.toFixed(0);
    if (scale >= 10)  return v.toFixed(0);
    return v.toFixed(1);
  }

  /** Format a tick list, bumping precision until all labels are unique. */
  function formatTicks(ticks) {
    const max = Math.max(...ticks);
    for (let extra = 0; extra <= 3; extra++) {
      const labels = ticks.map((t) => {
        if (max >= 1000) {
          const k = t / 1000;
          return (extra === 0 ? (k >= 10 ? k.toFixed(0) : k.toFixed(1)) : k.toFixed(1 + extra)) + 'k';
        }
        const base = max >= 10 ? 0 : 1;
        return t.toFixed(base + extra);
      });
      if (new Set(labels).size === labels.length) return labels;
    }
    return ticks.map(String);
  }

  // ── Scale ─────────────────────────────────────────────────────────────────

  /**
   * Build a value→pixel scale.
   * Log mode maps onto log10 with a floor, so zero and tiny values stay on-canvas.
   */
  function makeScale({ max, log, top, height }) {
    if (log) {
      const hi = Math.max(max, 10);
      const loExp = -1;                          // floor at 0.1
      const hiExp = Math.ceil(Math.log10(hi));
      const span = hiExp - loExp;
      return {
        log: true,
        max: Math.pow(10, hiExp),
        toY(v) {
          if (!(v > 0)) return top + height;
          const e = Math.log10(v);
          const t = (e - loExp) / span;
          return top + height - Math.min(1, Math.max(0, t)) * height;
        },
      };
    }
    const hi = max > 0 ? max : 1;
    return {
      log: false,
      max: hi,
      toY(v) {
        const t = hi > 0 ? v / hi : 0;
        return top + height - Math.min(1, Math.max(0, t)) * height;
      },
    };
  }

  /** Median of a non-empty numeric array. */
  function median(values) {
    const s = [...values].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /**
   * Should log scale auto-engage?
   *
   * @param {number[]|number[][]} input - flat values, or one array per series.
   *
   * When given series groups, the ratio is taken between the largest and
   * smallest per-series median. That is the comparison a reader actually makes:
   * one site sitting an order of magnitude below another is what gets flattened
   * onto the baseline, whereas a lone spike in an otherwise flat series says
   * nothing about whether the axis is readable.
   */
  function shouldAutoLog(input) {
    if (!Array.isArray(input) || input.length === 0) return false;

    const isGrouped = Array.isArray(input[0]);
    const levels = isGrouped
      ? input
          .map((g) => g.filter((v) => v > 0))
          .filter((g) => g.length > 0)
          .map(median)
      : input.filter((v) => v > 0);

    if (levels.length < 2) return false;
    const max = Math.max(...levels);
    const min = Math.min(...levels);
    return min > 0 && max / min >= LOG_SCALE_RATIO;
  }

  // ── Aggregation ───────────────────────────────────────────────────────────

  /**
   * Downsample history into at most MAX_BUCKETS equal-width time buckets per
   * site, carrying mean/min/max so spikes survive the reduction.
   *
   * @returns {{ series: Array<{key, buckets: Array}>, t0: number, t1: number, bucketMs: number }}
   */
  function bucketHistory(history, maxBuckets = MAX_BUCKETS) {
    if (history.length === 0) return { series: [], t0: 0, t1: 0, bucketMs: SAMPLE_INTERVAL_MS };

    const sorted = [...history].sort((a, b) => a.ts - b.ts);
    const t0 = sorted[0].ts;
    const t1 = sorted[sorted.length - 1].ts;
    const span = t1 - t0;

    // One bucket per sample interval, capped — never finer than the data.
    const bucketMs = Math.max(SAMPLE_INTERVAL_MS, Math.ceil(span / maxBuckets) || SAMPLE_INTERVAL_MS);

    const bySite = new Map();
    for (const e of sorted) {
      const key = siteKey(e.site);
      if (!bySite.has(key)) bySite.set(key, new Map());
      const buckets = bySite.get(key);
      const idx = span === 0 ? 0 : Math.floor((e.ts - t0) / bucketMs);
      const b = buckets.get(idx) ?? { idx, sum: 0, n: 0, min: Infinity, max: -Infinity, ts: t0 + idx * bucketMs };
      b.sum += e.watts;
      b.n   += 1;
      b.min  = Math.min(b.min, e.watts);
      b.max  = Math.max(b.max, e.watts);
      buckets.set(idx, b);
    }

    const series = [...bySite.entries()].map(([key, buckets]) => ({
      key,
      buckets: [...buckets.values()]
        .sort((a, b) => a.idx - b.idx)
        .map((b) => ({ ...b, mean: b.sum / b.n })),
    }));

    return { series, t0, t1, bucketMs };
  }

  /**
   * Wh per hour bucket, stacked by site. Only hours containing data are emitted,
   * so unfocused stretches leave gaps rather than zero-height bars.
   */
  function hourlyWh(history) {
    const weighted = weightSamples(history);
    const hours = new Map();
    for (const s of weighted) {
      const h = Math.floor(s.ts / 3600000) * 3600000;
      if (!hours.has(h)) hours.set(h, { ts: h, bySite: new Map(), total: 0 });
      const bucket = hours.get(h);
      bucket.bySite.set(s.key, (bucket.bySite.get(s.key) ?? 0) + s.wh);
      bucket.total += s.wh;
    }
    return [...hours.values()].sort((a, b) => a.ts - b.ts);
  }

  // Storage retains 30 days; showing more would only add empty columns.
  const MAX_DAY_COLUMNS = 30;

  /**
   * Daily rollup → ordered columns spanning the days that actually have data,
   * with interior days filled in so a missing day reads as a real gap.
   *
   * Never pads to a fixed 7: one day of data yields exactly one column, so a
   * fresh install looks new rather than broken. The span ends at the later of
   * today and the newest stored day (clock skew can put entries ahead of now),
   * and is capped at MAX_DAY_COLUMNS from the end so a stale entry months back
   * cannot stretch the axis into a wall of blanks.
   */
  function dailyColumns(daily) {
    const keys = Object.keys(daily)
      .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && (daily[k]?.whTotal ?? 0) >= 0)
      .sort();
    if (keys.length === 0) return [];

    const parse = (k) => {
      const [y, m, d] = k.split('-').map(Number);
      return new Date(y, m - 1, d);
    };
    const fmt = (dt) =>
      `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const newest = parse(keys[keys.length - 1]);
    const end = newest > today ? newest : today;

    // Walk back from `end` to the first day with data, bounded by the cap.
    const start = parse(keys[0]);
    const earliest = new Date(end);
    earliest.setDate(earliest.getDate() - (MAX_DAY_COLUMNS - 1));
    const from = start > earliest ? start : earliest;

    const cols = [];
    for (let dt = new Date(from); dt <= end; dt.setDate(dt.getDate() + 1)) {
      const key = fmt(dt);
      const entry = daily[key];
      const bySite = new Map();
      for (const [site, wh] of Object.entries(entry?.bySite ?? {})) {
        const k = siteKey(site === 'unknown' ? null : site);
        bySite.set(k, (bySite.get(k) ?? 0) + wh);
      }
      cols.push({ day: key, ts: new Date(dt).getTime(), bySite, total: entry?.whTotal ?? 0 });
    }
    return cols;
  }

  /** Build pie slices (descending, <2% folded into Other) from a Wh map. */
  function pieSlices(whMap) {
    const entries = [...whMap.entries()].filter(([, wh]) => wh > 0).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, wh]) => s + wh, 0);
    if (total <= 0) return { slices: [], total: 0 };

    const slices = [];
    let otherWh = 0;
    for (const [key, wh] of entries) {
      if (wh / total < PIE_OTHER_THRESHOLD && entries.length > 1) otherWh += wh;
      else slices.push({ key, label: siteLabel(key), wh, share: wh / total });
    }
    if (otherWh > 0) {
      slices.push({ key: '__other__', label: 'Other', wh: otherWh, share: otherWh / total });
    }
    return { slices, total };
  }

  // ── Canvas plumbing ───────────────────────────────────────────────────────

  const PADDING = { top: 16, right: 16, bottom: 34, left: 52 };

  /**
   * Size the backing store to the element's CSS box at the current DPR and
   * return the drawing geometry in CSS pixels.
   */
  function prepareCanvas(canvas) {
    const ctx  = canvas.getContext('2d');
    const dpr  = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    const W = Math.max(1, Math.round(rect.width));
    const H = Math.max(1, Math.round(rect.height));

    canvas.width  = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    return {
      ctx, W, H,
      left: PADDING.left,
      top: PADDING.top,
      width:  Math.max(1, W - PADDING.left - PADDING.right),
      height: Math.max(1, H - PADDING.top  - PADDING.bottom),
    };
  }

  /** Theme-dependent chrome colors. */
  function chartTheme(isDark) {
    return {
      grid:      isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)',
      axis:      isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.16)',
      label:     isDark ? '#8b93a7' : '#6b7280',
      faint:     isDark ? '#555f72' : '#9ca3af',
      dotStroke: isDark ? '#181c27' : '#ffffff',
      total:     isDark ? '#f0f2f7' : '#111827',
    };
  }

  /** Horizontal gridlines + value labels, drawn from the scale's own ticks. */
  function drawGrid(g, theme, ticks, labels) {
    const { ctx, left, top, width, height } = g;
    ctx.save();
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    ticks.forEach((t, i) => {
      const y = t.y;
      ctx.strokeStyle = i === 0 ? theme.axis : theme.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, Math.round(y) + 0.5);
      ctx.lineTo(left + width, Math.round(y) + 0.5);
      ctx.stroke();

      ctx.fillStyle = theme.label;
      ctx.fillText(labels[i], left - 8, y);
    });
    ctx.restore();
    void top; void height;
  }

  /** Build tick descriptors (value + pixel y) for a scale. */
  function buildTicks(scale, g) {
    const values = scale.log
      ? logTicks(0.1, scale.max)
      : linearTicks(scale.max);
    const labels = formatTicks(values);
    const ticks  = values.map((v) => ({ v, y: scale.toY(v) }));
    return { ticks, labels };
  }

  /** X-axis time labels, positioned by the same mapping as the data. */
  function drawTimeAxis(g, theme, stamps, xFor, fmt) {
    if (stamps.length === 0) return;
    const { ctx, H, left, width } = g;
    ctx.save();
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = theme.faint;
    ctx.textBaseline = 'alphabetic';

    // Space labels so they never collide at narrow widths.
    const maxLabels = Math.max(2, Math.min(6, Math.floor(width / 90)));
    const step = Math.max(1, Math.ceil(stamps.length / maxLabels));

    for (let i = 0; i < stamps.length; i += step) {
      const x = xFor(stamps[i]);
      ctx.textAlign = i === 0 ? 'left' : 'center';
      const clamped = Math.min(Math.max(x, left), left + width);
      ctx.fillText(fmt(stamps[i]), clamped, H - 10);
    }
    ctx.restore();
  }

  // ── Line chart ────────────────────────────────────────────────────────────

  /**
   * Day line: watts over time, one series per site, bucketed with a min/max band.
   * Week line: Wh per day, one series per site plus a bold total.
   *
   * @returns {Array} hit-test index: { x, y, r, label, value, unit, ts, color }
   */
  function drawLine(canvas, model, opts) {
    const { isDark, log } = opts;
    const g = prepareCanvas(canvas);
    const theme = chartTheme(isDark);
    const { ctx, left, top, width, height } = g;
    const hits = [];

    const scale = makeScale({ max: model.max, log, top, height });
    const { ticks, labels } = buildTicks(scale, g);
    drawGrid(g, theme, ticks, labels);

    // X mapping. A zero span (single sample, or all-identical timestamps) would
    // divide by zero, so every point collapses to the left edge instead of the
    // centre — and single points are drawn as markers below regardless.
    const span = model.t1 - model.t0;
    const xFor = (ts) => (span > 0 ? left + ((ts - model.t0) / span) * width : left);

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap  = 'round';

    for (const s of model.series) {
      if (!s.visible) continue;
      const color = siteColor(s.key, isDark);

      // Min/max band (Day only) — keeps spikes visible after downsampling.
      if (model.hasBand && s.points.some((p) => p.max > p.min)) {
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = color;
        ctx.beginPath();
        let runStart = 0;
        for (let i = 0; i < s.points.length; i++) {
          const p = s.points[i];
          const brk = i > 0 && p.ts - s.points[i - 1].ts > model.gapMs;
          if (i === 0 || brk) {
            if (brk) closeBand(ctx, s.points, runStart, i - 1, xFor, scale);
            runStart = i;
            ctx.moveTo(xFor(p.ts), scale.toY(p.max));
            continue;
          }
          ctx.lineTo(xFor(p.ts), scale.toY(p.max));
        }
        closeBand(ctx, s.points, runStart, s.points.length - 1, xFor, scale);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Mean line, straight segments, broken across gaps.
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < s.points.length; i++) {
        const p = s.points[i];
        const brk = i > 0 && p.ts - s.points[i - 1].ts > model.gapMs;
        const x = xFor(p.ts), y = scale.toY(p.value);
        if (!pen || brk) { ctx.moveTo(x, y); pen = true; }
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = s.key === '__total__' ? 2.5 : 1.75;
      ctx.stroke();

      // Markers only where a point stands alone — an isolated sample would
      // otherwise draw a zero-length line and render as nothing at all.
      for (let i = 0; i < s.points.length; i++) {
        const p = s.points[i];
        const prevFar = i === 0 || p.ts - s.points[i - 1].ts > model.gapMs;
        const nextFar = i === s.points.length - 1 || s.points[i + 1].ts - p.ts > model.gapMs;
        // A point with no neighbour within the gap threshold would draw as a
        // zero-length line, i.e. nothing — so it gets an explicit marker.
        const solo = prevFar && nextFar;
        const x = xFor(p.ts), y = scale.toY(p.value);
        if (solo) {
          ctx.beginPath();
          ctx.arc(x, y, 2.6, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.strokeStyle = theme.dotStroke;
          ctx.lineWidth = 1.2;
          ctx.fill();
          ctx.stroke();
        }
        hits.push({
          x, y, r: 7,
          label: s.label, color,
          value: p.value, unit: model.unit, ts: p.ts,
          tsFormat: model.tsFormat,
        });
      }
    }
    ctx.restore();

    drawTimeAxis(g, theme, model.stamps, xFor, model.tsFormat);
    return hits;
  }

  /**
   * Close a min/max band segment by walking back along the min edge from
   * endIdx to startIdx, so each unbroken run becomes its own filled polygon.
   */
  function closeBand(ctx, points, startIdx, endIdx, xFor, scale) {
    for (let j = endIdx; j >= startIdx; j--) {
      ctx.lineTo(xFor(points[j].ts), scale.toY(points[j].min));
    }
  }

  // ── Bar chart ─────────────────────────────────────────────────────────────

  /**
   * Stacked bars: Wh per hour (Day) or per day (Week), stacked by site.
   * Only columns containing data are passed in, so empty hours leave real gaps.
   */
  function drawBars(canvas, model, opts) {
    const { isDark, log } = opts;
    const g = prepareCanvas(canvas);
    const theme = chartTheme(isDark);
    const { ctx, left, top, width, height } = g;
    const hits = [];

    const scale = makeScale({ max: model.max, log, top, height });
    const { ticks, labels } = buildTicks(scale, g);
    drawGrid(g, theme, ticks, labels);

    const n = model.columns.length;
    if (n === 0) return hits;

    const slot = width / n;
    const barW = Math.max(2, Math.min(slot * 0.68, 46));
    const baseY = top + height;

    model.columns.forEach((col, i) => {
      const cx = left + slot * (i + 0.5);

      for (const seg of col.segments) {
        if (seg.value <= 0) continue;
        // Stack in pixel space from the running cumulative totals, so segment
        // boundaries stay exact under both linear and log scales. Floored at
        // 1 px so small contributors never vanish entirely.
        const segTop = scale.toY(seg.stackTop);
        const segBot = scale.toY(seg.stackBottom);
        const h = Math.max(1, segBot - segTop);
        const y = Math.min(segBot - h, baseY - h);

        ctx.fillStyle = siteColor(seg.key, isDark);
        ctx.fillRect(cx - barW / 2, y, barW, h);

        hits.push({
          x: cx, y: y + h / 2, r: Math.max(barW / 2, 8),
          label: seg.label, color: siteColor(seg.key, isDark),
          value: seg.value, unit: model.unit, ts: col.ts,
          tsFormat: model.tsFormat,
        });
      }
    });

    drawTimeAxis(g, theme, model.columns.map((c) => c.ts), (ts) => {
      const i = model.columns.findIndex((c) => c.ts === ts);
      return left + slot * (i + 0.5);
    }, model.tsFormat);

    return hits;
  }

  // ── Pie chart ─────────────────────────────────────────────────────────────

  /**
   * Donut of Wh share by site, sorted descending with sub-2% folded into Other.
   * Thin slices get leader lines instead of inline labels.
   */
  function drawPie(canvas, model, opts) {
    const { isDark } = opts;
    const g = prepareCanvas(canvas);
    const theme = chartTheme(isDark);
    const { ctx, W, H } = g;
    const hits = [];

    const slices = model.slices.filter((s) => s.visible !== false);
    const total = slices.reduce((s, x) => s + x.wh, 0);
    if (total <= 0) return hits;

    const cx = W / 2;
    const cy = H / 2 + 2;
    const R  = Math.max(30, Math.min(W, H) / 2 - 30);
    const rInner = R * 0.58;

    ctx.save();

    // A single series would render as a degenerate 360° wedge with a seam, so
    // draw it as a clean full ring instead.
    if (slices.length === 1) {
      const s = slices[0];
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.arc(cx, cy, rInner, 0, Math.PI * 2, true);
      ctx.fillStyle = siteColor(s.key, isDark);
      ctx.fill();
      hits.push({
        x: cx, y: cy - (R + rInner) / 2, r: (R - rInner) / 2,
        label: s.label, color: siteColor(s.key, isDark),
        value: s.wh, unit: 'Wh', share: 1, isPie: true,
      });
    } else {
      let a0 = -Math.PI / 2;
      for (const s of slices) {
        const share = s.wh / total;
        const a1 = a0 + share * Math.PI * 2;
        const color = s.key === '__other__' ? (isDark ? '#6b7280' : '#9ca3af') : siteColor(s.key, isDark);

        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R, a0, a1);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();

        const mid = (a0 + a1) / 2;
        hits.push({
          x: cx + Math.cos(mid) * (R * 0.75),
          y: cy + Math.sin(mid) * (R * 0.75),
          r: Math.max(10, R * 0.25),
          label: s.label, color, value: s.wh, unit: 'Wh', share, isPie: true,
        });
        a0 = a1;
      }

      // Punch the donut hole.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(cx, cy, rInner, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';

      // Labels: inline for fat slices, leader lines for thin ones.
      ctx.font = '10px -apple-system, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      let b0 = -Math.PI / 2;
      for (const s of slices) {
        const share = s.wh / total;
        const mid = b0 + (share * Math.PI * 2) / 2;
        b0 += share * Math.PI * 2;
        const text = `${s.label} · ${s.wh.toFixed(1)} Wh · ${(share * 100).toFixed(1)}%`;

        if (share >= 0.08) {
          const lx = cx + Math.cos(mid) * (R * 0.78);
          const ly = cy + Math.sin(mid) * (R * 0.78);
          ctx.textAlign = 'center';
          ctx.fillStyle = pieLabelInk(isDark);
          ctx.fillText(`${(share * 100).toFixed(0)}%`, lx, ly);
        } else {
          const ex = cx + Math.cos(mid) * (R + 8);
          const ey = cy + Math.sin(mid) * (R + 8);
          const right = Math.cos(mid) >= 0;
          const tx = right ? Math.min(ex + 26, W - 4) : Math.max(ex - 26, 4);
          ctx.strokeStyle = theme.faint;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(mid) * R, cy + Math.sin(mid) * R);
          ctx.lineTo(ex, ey);
          ctx.lineTo(tx, ey);
          ctx.stroke();
          ctx.textAlign = right ? 'left' : 'right';
          ctx.fillStyle = theme.label;
          ctx.fillText(text, right ? tx + 3 : tx - 3, ey);
        }
      }
    }

    // Centre total.
    ctx.textAlign = 'center';
    ctx.fillStyle = theme.total;
    ctx.font = '600 17px -apple-system, system-ui, sans-serif';
    ctx.fillText(formatValue(total, total), cx, cy - 5);
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = theme.faint;
    ctx.fillText('Wh total', cx, cy + 12);

    ctx.restore();
    return hits;
  }

  function pieLabelInk(isDark) {
    return isDark ? 'rgba(15,17,23,0.88)' : 'rgba(255,255,255,0.95)';
  }

  /** Empty state: axis baseline at zero, no fabricated ceiling. */
  function drawEmptyGrid(canvas, isDark) {
    const g = prepareCanvas(canvas);
    const theme = chartTheme(isDark);
    const { ctx, left, top, width, height } = g;
    ctx.save();
    ctx.strokeStyle = theme.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, Math.round(top + height) + 0.5);
    ctx.lineTo(left + width, Math.round(top + height) + 0.5);
    ctx.stroke();
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = theme.label;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('0', left - 8, top + height);
    ctx.restore();
    return [];
  }

  /** Nearest hit within its own radius, or null. */
  function hitTest(hits, mx, my) {
    let best = null, bestD = Infinity;
    for (const h of hits) {
      const dx = mx - h.x, dy = my - h.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= h.r && d < bestD) { best = h; bestD = d; }
    }
    return best;
  }

  global.EcoChart = {
    SAMPLE_INTERVAL_MS, GAP_THRESHOLD_MS, MAX_SAMPLE_WEIGHT_MS, MAX_BUCKETS,
    PADDING,
    siteKey, siteLabel, siteColor,
    weightSamples, whBySiteFromHistory, whBySiteFromDaily,
    niceNum, linearTicks, logTicks, formatValue, formatTicks,
    makeScale, shouldAutoLog, median,
    bucketHistory, hourlyWh, dailyColumns, pieSlices,
    prepareCanvas, chartTheme, drawLine, drawBars, drawPie, drawEmptyGrid, hitTest,
  };

})(typeof window !== 'undefined' ? window : globalThis);
