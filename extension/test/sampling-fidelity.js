// extension/test/sampling-fidelity.js
// Proof harness for the duty-cycled mutation sampler. Run with:
//   node extension/test/sampling-fidelity.js
//
// Question this answers: duty-cycling the MutationObserver cuts its cost by
// ~93%, but does it change the WATTS THE USER SEES? Cheap sampling that reports
// a different number is not a win, it is a regression.
//
// Method: generate synthetic mutation timelines and run each through three
// estimators — GROUND TRUTH (what the page actually did), OLD (continuous
// observer, 1 s counter flush, 10 s reports) and NEW (stratified duty-cycled
// windows, 30 s reports) — feeding all of them through the real estimateWatts().
// The assertion is NEW vs TRUTH; OLD is shown for reference.
//
// Because the new sampler's window phases are random, every profile is run
// across many seeds and judged on its WORST case, not a lucky single run.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── Load the real estimator, the way the service worker does ─────────────────

const LIB = path.join(__dirname, '..', 'lib');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(LIB, 'energy-estimator.js'), 'utf8') +
  '\n;globalThis.__exports = { estimateWatts };',
  sandbox
);
const { estimateWatts } = sandbox.__exports;

// ── Cadence constants — must mirror content/content-script.js ────────────────

// The observer's time budget per report period is fixed at
// SAMPLE_WINDOW_MS × SAMPLES_PER_PERIOD = 2000 ms in 30 000 ms ≈ 6.7% duty cycle.
//
// How that budget is DIVIDED decides accuracy, and costs nothing to change.
// One 2000 ms window sampling a 10s-on/20s-off page is a coin flip: it reads
// either the peak or zero, giving up to ±45% error. Ten 200 ms windows at
// independent phases average toward the truth. Measured over 40 random phase
// seeds, at an identical 2000 ms budget:
//
//   1 × 2000 ms  → worst error 45.6%
//   4 ×  500 ms  → worst error 24.5%
//   8 ×  250 ms  → worst error  8.9%
//  10 ×  200 ms  → worst error  5.1%   ← chosen
//
// Bias is ~0% at every setting, so this is variance reduction only — NOT a step
// back toward continuous observation. The observer runs for exactly as long.
const SAMPLE_WINDOW_MS   = 200;
const SAMPLES_PER_PERIOD = 10;
const SAMPLE_PERIOD_MS   = 30000;
const REPORT_PERIOD_MS   = 30000;

const OLD_FLUSH_MS  = 1000;    // old: mutationsPerSec reset every 1 s
const OLD_REPORT_MS = 10000;   // old: sent every 10 s

const TICK_MS  = 100;                    // simulation resolution
const RUN_MS   = 10 * 60 * 1000;         // 10 minutes of simulated time

// estimateWatts() clamps mutationsPerSec at this value. The clamp is why a
// window's rate must be capped BEFORE it is averaged into the reported figure:
// the old continuous counter clipped every 1 s sample independently, so a
// 300 mut/s burst contributed 200, not 300. Averaging first and clipping once
// loses that, and under-reports any page whose peaks exceed the cap.
const MAX_MUTATIONS_PER_SEC = 200;

// Other metrics are held constant per profile so the ONLY variable under test
// is how mutation rate is sampled.
const BASE_METRICS = {
  domNodes: 2500,
  transferKB: 1800,
  hasVideo: false,
  hasCanvas: false,
  hasLargeCanvas: false,
};

// ── Timeline profiles ────────────────────────────────────────────────────────
// Each returns the instantaneous mutations/sec at time t (ms).

const PROFILES = [
  {
    name: 'idle page',
    metrics: { ...BASE_METRICS, domNodes: 800, transferKB: 300 },
    rate: () => 0,
  },
  {
    name: 'steady feed',
    metrics: { ...BASE_METRICS },
    // Gentle sine around 25 mut/s — always active, never bursty.
    rate: (t) => 25 + 8 * Math.sin(t / 20000),
  },
  {
    name: 'bursty streaming',
    metrics: { ...BASE_METRICS, domNodes: 4000, transferKB: 900 },
    // ChatGPT-like: 10 s of 300 mut/s, then 20 s quiet. This is the profile a
    // naive 2 s-in-30 s duty cycle can miss entirely.
    rate: (t) => ((t % 30000) < 10000 ? 300 : 0),
  },
  {
    name: 'video page',
    metrics: { ...BASE_METRICS, domNodes: 1500, transferKB: 12000, hasVideo: true },
    // Low DOM churn; the watt total is dominated by the video term.
    rate: () => 4,
  },
  {
    name: 'spiky ad-heavy',
    metrics: { ...BASE_METRICS, domNodes: 6000, transferKB: 5200, hasCanvas: true },
    // Short violent spikes every ~7 s against a low baseline.
    rate: (t) => ((t % 7000) < 400 ? 220 : 6),
  },
];

// ── Deterministic RNG ────────────────────────────────────────────────────────
// Seeded so the suite is reproducible; the production code uses Math.random().

let _seed = 0x2f6e2b1;
function rand() {
  _seed ^= _seed << 13; _seed >>>= 0;
  _seed ^= _seed >> 17;
  _seed ^= _seed << 5;  _seed >>>= 0;
  return _seed / 0x100000000;
}
function setSeed(n) { _seed = (0x2f6e2b1 ^ ((n + 1) * 0x9e3779b1)) >>> 0 || 1; }

// ── Simulators ───────────────────────────────────────────────────────────────

/** Mutations occurring in [t, t+TICK_MS), from an instantaneous rate. */
function mutationsInTick(rateFn, t) {
  return (rateFn(t) * TICK_MS) / 1000;
}

/**
 * GROUND TRUTH: what the page actually did. The mean mutation rate over each
 * report interval, capped the way estimateWatts() caps it. This is the number
 * both samplers are trying to estimate.
 *
 * Note this is NOT simply "the old behaviour" — see runOld's caveat below.
 */
function runTruth(profile) {
  const samples = [];
  const stepMs = REPORT_PERIOD_MS;
  for (let start = 0; start < RUN_MS; start += stepMs) {
    let sum = 0;
    for (let t = start; t < start + stepMs; t += TICK_MS) {
      // Cap per second of real time, as the old 1 s counter did.
      sum += Math.min(profile.rate(t), MAX_MUTATIONS_PER_SEC) * TICK_MS / 1000;
    }
    samples.push({
      watts: estimateWatts({
        ...profile.metrics,
        mutationsPerSec: sum / (stepMs / 1000),
      }),
      intervalS: stepMs / 1000,
    });
  }
  return samples;
}

/**
 * OLD behaviour: observer always connected, counter flushed every 1 s into
 * mutationsPerSec, metrics sent every 10 s.
 *
 * CAVEAT — this is a reference, not a target. The old sampler reports the
 * instantaneous rate from the single second preceding each 10 s report, so it
 * is itself badly aliased: against the 30 s bursty profile it samples
 * 300, 0, 0, 300, 0, 0 … forever, because 10 s divides the burst period. Its
 * agreement with truth on that profile is a coincidence of phase, not accuracy.
 * Matching it exactly would mean reproducing that bug.
 */
function runOld(profile) {
  let counter = 0;
  let mutationsPerSec = 0;
  const samples = [];

  for (let t = 0; t < RUN_MS; t += TICK_MS) {
    counter += mutationsInTick(profile.rate, t);

    if ((t + TICK_MS) % OLD_FLUSH_MS === 0) {
      mutationsPerSec = counter;
      counter = 0;
    }
    if ((t + TICK_MS) % OLD_REPORT_MS === 0) {
      samples.push({
        watts: estimateWatts({ ...profile.metrics, mutationsPerSec }),
        intervalS: OLD_REPORT_MS / 1000,
      });
    }
  }
  return samples;
}

/**
 * NEW behaviour: SAMPLES_PER_PERIOD short observer windows per period, placed by
 * stratified random sampling (one window per equal slot, at a random phase
 * inside that slot). Window rates are capped then averaged at report time.
 *
 * Stratification matters: pure random phases can clump, and any FIXED phase
 * aliases against a periodic page — if the burst period divides ours, every
 * window lands in the same part of the cycle forever.
 */
function runNew(profile) {
  let mutationsPerSec = 0;   // reported value, held between report ticks
  let windowUntil = -1;
  let windowAccum = 0;

  // Window start offsets within the current report period, randomized so the
  // sampler never stays locked to a periodic page rhythm.
  let schedule = [];
  let scheduleBase = -1;

  // Windows completed since the last report, averaged at report time.
  let periodSum = 0;
  let periodCount = 0;

  const samples = [];

  /** Pick SAMPLES_PER_PERIOD random, non-overlapping-ish offsets in a period. */
  function planPeriod(base) {
    scheduleBase = base;
    const slot = SAMPLE_PERIOD_MS / SAMPLES_PER_PERIOD;
    schedule = [];
    for (let i = 0; i < SAMPLES_PER_PERIOD; i++) {
      // One window per equal slot, at a random phase inside that slot. This is
      // stratified sampling: it keeps the windows spread across the period
      // (unlike pure random, which can clump) while staying unbiased.
      schedule.push(base + i * slot + rand() * (slot - SAMPLE_WINDOW_MS));
    }
  }

  planPeriod(0);

  for (let t = 0; t < RUN_MS; t += TICK_MS) {
    if (t >= scheduleBase + SAMPLE_PERIOD_MS) planPeriod(scheduleBase + SAMPLE_PERIOD_MS);

    // Open a window when the clock reaches a scheduled offset.
    if (schedule.length && t >= schedule[0] && t >= windowUntil) {
      schedule.shift();
      windowAccum = 0;
      windowUntil = t + SAMPLE_WINDOW_MS;
    }

    // Accumulate only while a window is open — outside a window the observer is
    // disconnected and these mutations are never seen.
    if (t < windowUntil) {
      windowAccum += mutationsInTick(profile.rate, t);
      if (t + TICK_MS >= windowUntil) {
        // Cap per window, matching how the old 1 s counter capped each sample.
        periodSum += Math.min(windowAccum / (SAMPLE_WINDOW_MS / 1000), MAX_MUTATIONS_PER_SEC);
        periodCount++;
      }
    }

    if ((t + TICK_MS) % REPORT_PERIOD_MS === 0) {
      if (periodCount > 0) mutationsPerSec = periodSum / periodCount;
      periodSum = 0;
      periodCount = 0;

      samples.push({
        watts: estimateWatts({ ...profile.metrics, mutationsPerSec }),
        intervalS: REPORT_PERIOD_MS / 1000,
      });
    }
  }
  return samples;
}

// ── Metrics over a run ───────────────────────────────────────────────────────

const meanWatts = (s) => s.reduce((a, x) => a + x.watts, 0) / s.length;
const totalWh   = (s) => s.reduce((a, x) => a + x.watts * (x.intervalS / 3600), 0);

function pctDiff(a, b) {
  if (a === 0 && b === 0) return 0;
  if (a === 0) return Infinity;
  return ((b - a) / a) * 100;
}

// ── Run ──────────────────────────────────────────────────────────────────────

const TOLERANCE_PCT = 10;

// The window phases are random in production, so a single run can pass by luck.
// Every profile is run across many independent phase seeds and judged on its
// WORST case, not its average.
const SEEDS = 40;

console.log('\n  Sampling fidelity — duty-cycled observer vs ground truth\n');
console.log(`  ${RUN_MS / 60000} min simulated per profile · ${SAMPLES_PER_PERIOD} × ${SAMPLE_WINDOW_MS}ms windows per ${SAMPLE_PERIOD_MS / 1000}s period`);
console.log(`  observer duty cycle: ~${((SAMPLE_WINDOW_MS * SAMPLES_PER_PERIOD / SAMPLE_PERIOD_MS) * 100).toFixed(1)}% · worst case over ${SEEDS} phase seeds`);
console.log(`  assertion: NEW within ±${TOLERANCE_PCT}% of TRUTH (mean W and total Wh)`);
console.log(`  OLD shown for reference only — it is itself an aliased sampler.\n`);

let failures = 0;
const rows = [];

for (const profile of PROFILES) {
  const truthS = runTruth(profile);
  const oldS   = runOld(profile);

  const tMean = meanWatts(truthS), oMean = meanWatts(oldS);
  const tWh   = totalWh(truthS);

  let worstMean = 0, worstWh = 0, sumMean = 0, nMeanLast = 0;

  for (let s = 0; s < SEEDS; s++) {
    setSeed(s);
    const newS = runNew(profile);
    const nMean = meanWatts(newS);
    const dMean = pctDiff(tMean, nMean);
    const dWh   = pctDiff(tWh, totalWh(newS));

    if (Math.abs(dMean) > Math.abs(worstMean)) worstMean = dMean;
    if (Math.abs(dWh)   > Math.abs(worstWh))   worstWh   = dWh;
    sumMean += nMean;
    nMeanLast = nMean;
  }

  const nMean = sumMean / SEEDS;               // mean across seeds, for display
  const dOldMean = pctDiff(tMean, oMean);

  const ok = Math.abs(worstMean) < TOLERANCE_PCT && Math.abs(worstWh) < TOLERANCE_PCT;
  if (!ok) failures++;

  rows.push({
    name: profile.name, tMean, oMean, nMean,
    dOldMean, dNewMean: worstMean, dNewWh: worstWh, ok,
  });
}

// ── Table ────────────────────────────────────────────────────────────────────

const nameW = Math.max(...rows.map(r => r.name.length), 8);
const line = '  ' + '─'.repeat(nameW + 66);

console.log(line);
console.log(
  `  ${'profile'.padEnd(nameW)} │ ${'truth W'.padStart(8)} ${'old W'.padStart(8)} ${'new W'.padStart(8)} │ ` +
  `${'old Δ'.padStart(8)} ${'new Δ'.padStart(8)} ${'Wh Δ'.padStart(8)} │`
);
console.log(line);
for (const r of rows) {
  const f = (v) => `${(v >= 0 ? '+' : '') + v.toFixed(1)}%`.padStart(8);
  console.log(
    `  ${r.name.padEnd(nameW)} │ ${r.tMean.toFixed(3).padStart(8)} ${r.oMean.toFixed(3).padStart(8)} ` +
    `${r.nMean.toFixed(3).padStart(8)} │ ${f(r.dOldMean)} ${f(r.dNewMean)} ${f(r.dNewWh)} │ ${r.ok ? '✓' : '✗'}`
  );
}
console.log(line);
console.log('');
console.log('  "old Δ" is the PREVIOUS build\'s error against the same truth — where it');
console.log('  is large, the new sampler is more accurate, not less.\n');

// ── Verdict ──────────────────────────────────────────────────────────────────

if (failures) {
  console.error(`FAILED — ${failures} of ${rows.length} profiles exceeded ±${TOLERANCE_PCT}%\n`);
  process.exit(1);
}
console.log(`PASSED — all ${rows.length} profiles within ±${TOLERANCE_PCT}% of ground truth\n`);
