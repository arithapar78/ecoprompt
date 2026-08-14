// content/content-script.js
// Role: collect lightweight page metrics and push them to the service worker.
//
// Design principle: this is a SAMPLER, not an instrument. A page's mutation rate
// and node count change on the order of seconds, so there is no accuracy reason
// to listen continuously to a signal we only report every 30 s. Every mechanism
// below is duty-cycled or visibility-gated to match observation cost to what the
// reported number actually needs.
//
// Safety rules:
//   - The MutationObserver is the dominant cost of this script, and the callback
//     body is irrelevant to that: observe(subtree:true) makes Blink allocate a
//     MutationRecord for every childList change in the document and schedule a
//     microtask, all before our callback runs. So we duty-cycle it (see below)
//     rather than trying to make the callback cheap.
//   - Nothing observes anything until after the `load` event. document_idle
//     fires before most SPA hydration and lazy content, i.e. during the busiest
//     phase of load, which is exactly when we must not add work.
//   - document.all.length is NOT O(1) — HTMLAllCollection.length is backed by a
//     cache invalidated by any DOM mutation, so on a mutating page each read is
//     a full tree traversal. It is called at most once per report cycle, and
//     never from inside the mutation callback.
//   - getContext() is NEVER called on a page-owned canvas: a canvas's context
//     type is permanent, so probing for WebGL would permanently deny the page
//     its own getContext('2d'). Canvas size is used as a read-only proxy.
//   - All sends are fire-and-forget; errors are silently ignored.

(function () {

  // ── Sampling cadence ───────────────────────────────────────────────────────
  // Every timing constant lives here so the whole duty cycle is tunable in one
  // place. Observer live fraction = SAMPLE_WINDOW_MS / SAMPLE_PERIOD_MS ≈ 6.7%.

  // The observer's time budget per period is fixed at
  // SAMPLE_WINDOW_MS × SAMPLES_PER_PERIOD = 2000 ms in 30 000 ms ≈ 6.7%.
  //
  // How that budget is DIVIDED decides accuracy and costs nothing to change.
  // One 2000 ms window sampling a 10s-on/20s-off streaming page is a coin flip:
  // it reads either the peak or zero. Ten 200 ms windows at independent phases
  // average toward the truth. Measured in test/sampling-fidelity.js over 40
  // random phase seeds, at an identical 2000 ms budget:
  //     1 × 2000 ms → worst error 45.6%      8 × 250 ms → 8.9%
  //     4 ×  500 ms → worst error 24.5%     10 × 200 ms → 5.1%  ← chosen
  // Bias is ~0% at every setting; this is variance reduction, not more observing.

  /** How long the MutationObserver stays connected per sampling window. */
  const SAMPLE_WINDOW_MS = 200;

  /** Number of sampling windows per period. */
  const SAMPLES_PER_PERIOD = 10;

  /** Length of one sampling period (windows are spread across it). */
  const SAMPLE_PERIOD_MS = 30000;

  /** How often metrics are sent to the service worker. */
  const REPORT_PERIOD_MS = 30000;

  /** Delay after `load` before the first sampling window opens. */
  const SETTLE_DELAY_MS = 3000;

  /** A tab hidden longer than this stops being "recently visible". */
  const RECENT_VISIBLE_MS = 60000;

  /** Throttle for the video/canvas element check. */
  const ELEMENT_CHECK_INTERVAL_MS = 5000;

  /** Resource-timing buffer size, so the buffered replay isn't truncated. */
  const RESOURCE_BUFFER_SIZE = 1000;

  // A canvas at least this large implies real rendering work rather than a
  // 1×1 tracking pixel or an offscreen sprite sheet.
  const LARGE_CANVAS_W = 300;
  const LARGE_CANVAS_H = 150;

  // ── Debug kill switch ──────────────────────────────────────────────────────
  // Set chrome.storage.local.ecoDisableParts to 'observer' | 'perf' | 'timers'
  // | 'all' to disable a subsystem, then reload the page. Used to bisect which
  // subsystem is responsible when the extension breaks a site.

  const disabled = { observer: false, perf: false, timers: false };

  function readKillSwitch() {
    return new Promise((resolve) => {
      if (!chrome.runtime?.id || !chrome.storage?.local) return resolve();
      try {
        chrome.storage.local.get('ecoDisableParts', (res) => {
          // Accessing lastError suppresses the "unchecked runtime.lastError" log.
          void chrome.runtime.lastError;
          const v = res && res.ecoDisableParts;
          const parts = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
          for (const p of parts) {
            if (p === 'all') { disabled.observer = disabled.perf = disabled.timers = true; }
            else if (p in disabled) disabled[p] = true;
          }
          resolve();
        });
      } catch (_) { resolve(); }
    });
  }

  // ── Mutation tracking (duty-cycled) ────────────────────────────────────────
  // The observer runs in short windows instead of continuously. mutationsPerSec
  // is computed from the records seen in a window and HELD between windows, so
  // the reported value is a recent sample rather than a running total.

  // estimateWatts() clamps mutation rate here. Each window's rate is capped
  // BEFORE being averaged, matching how the old 1 s counter capped each sample —
  // averaging first and capping once under-reports pages whose peaks exceed it.
  const MAX_MUTATIONS_PER_SEC = 200;

  let recordsInWindow = 0;
  let mutationsPerSec = 0;      // reported value, held between report ticks
  let windowOpen = false;
  let windowTimer = null;
  let periodTimer = null;

  // Window rates collected since the last report, averaged when it fires.
  let periodSum = 0;
  let periodCount = 0;

  const mutationObserver = new MutationObserver((records) => {
    recordsInWindow += records.length;
    // Element-type flags are refreshed here, throttled and deferred to idle.
    scheduleElementCheck();
  });

  const OBSERVER_OPTS = {
    childList: true,
    subtree: true,
    // attributes: false — intentionally omitted; cuts callback volume on
    //   frameworks that update dozens of attributes per render cycle.
    // Narrowing the subtree is not an option: node count and mutation rate are
    // whole-page metrics. Duty cycling is the only real lever on this cost.
  };

  /** True when a sampling window is allowed to open right now. */
  function canSample() {
    return !disabled.observer && document.visibilityState === 'visible';
  }

  function openWindow() {
    if (windowOpen || !canSample()) return;
    recordsInWindow = 0;
    try {
      mutationObserver.observe(document.documentElement, OBSERVER_OPTS);
    } catch (_) {
      return; // documentElement gone (rare teardown race)
    }
    windowOpen = true;
    windowTimer = setTimeout(closeWindow, SAMPLE_WINDOW_MS);
  }

  function closeWindow() {
    if (!windowOpen) return;
    mutationObserver.disconnect();
    windowOpen = false;
    if (windowTimer !== null) { clearTimeout(windowTimer); windowTimer = null; }
    periodSum += Math.min(
      recordsInWindow / (SAMPLE_WINDOW_MS / 1000),
      MAX_MUTATIONS_PER_SEC
    );
    periodCount++;
  }

  /**
   * Schedule this period's windows by stratified random sampling: the period is
   * split into SAMPLES_PER_PERIOD equal slots and one window is placed at a
   * random phase inside each slot.
   *
   * Stratification matters. A FIXED phase aliases against a periodic page — if
   * the page's burst period divides ours, every window lands in the same part of
   * the cycle forever, reporting either the peak or zero as though it were the
   * whole story. Pure random phases fix the aliasing but can clump; one window
   * per slot keeps them spread while staying unbiased.
   */
  function planPeriod() {
    const slot = SAMPLE_PERIOD_MS / SAMPLES_PER_PERIOD;
    for (let i = 0; i < SAMPLES_PER_PERIOD; i++) {
      const offset = i * slot + Math.random() * (slot - SAMPLE_WINDOW_MS);
      const id = setTimeout(() => {
        pendingWindows.delete(id);
        openWindow();
      }, offset);
      pendingWindows.add(id);
    }
  }

  /** Timers for windows scheduled but not yet opened, so they can be cancelled. */
  const pendingWindows = new Set();

  function clearPendingWindows() {
    for (const id of pendingWindows) clearTimeout(id);
    pendingWindows.clear();
  }

  function startSampling() {
    if (periodTimer !== null || disabled.observer) return;
    planPeriod();
    periodTimer = setInterval(planPeriod, SAMPLE_PERIOD_MS);
  }

  function stopSampling() {
    if (periodTimer !== null) { clearInterval(periodTimer); periodTimer = null; }
    clearPendingWindows();
    closeWindow();
  }

  // ── Element-type flags ────────────────────────────────────────────────────
  // querySelector is a full tree walk on pages with no <video>/<canvas>, so the
  // check is throttled to once per 5 s and deferred to idle time.

  let hasVideo = false;
  let hasCanvas = false;
  let hasLargeCanvas = false;
  let elementCheckTimer = null;

  const whenIdle =
    typeof requestIdleCallback === 'function'
      ? (fn) => requestIdleCallback(fn)
      : (fn) => setTimeout(fn, 500);

  function scheduleElementCheck() {
    // Trailing-edge throttle: the first mutation after a quiet period arms the
    // timer, and every mutation in the next 5 s is absorbed by it for free.
    if (elementCheckTimer !== null) return;
    elementCheckTimer = setTimeout(() => {
      elementCheckTimer = null;
      whenIdle(updateElementFlags);
    }, ELEMENT_CHECK_INTERVAL_MS);
  }

  function updateElementFlags() {
    // Video: only care if one is actually playing.
    const videoEl = document.querySelector('video');
    hasVideo = videoEl !== null && !videoEl.paused;

    // Canvas: presence flags potential rendering work. Size stands in for how
    // much — reading width/height is safe, whereas getContext() would
    // permanently fix the canvas's context type and break the page.
    const canvasEl = document.querySelector('canvas');
    hasCanvas = canvasEl !== null;
    hasLargeCanvas =
      canvasEl !== null &&
      canvasEl.width >= LARGE_CANVAS_W &&
      canvasEl.height >= LARGE_CANVAS_H;
  }

  // ── Network tracking ──────────────────────────────────────────────────────
  // Registered only after `load`, with buffered:true — one batch delivery of
  // everything that happened during load, then streaming for later resources.
  // Registering earlier would fire our callback for every resource completing
  // during load, for a number we only report every 30 s.

  let transferKB = 0;

  // Cheap, no callbacks, and must run before resources start completing so the
  // buffered replay isn't truncated on ad-heavy pages (default is 250).
  try { performance.setResourceTimingBufferSize(RESOURCE_BUFFER_SIZE); } catch (_) {}

  function startPerfObserver() {
    if (disabled.perf || typeof PerformanceObserver === 'undefined') return;
    try {
      const perfObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          // encodedBodySize is compressed wire size; 0 means served from cache.
          if (entry.encodedBodySize > 0) {
            transferKB += entry.encodedBodySize / 1024;
          }
        }
      });
      perfObserver.observe({ type: 'resource', buffered: true });
    } catch (_) {
      // Some contexts (e.g. sandboxed iframes) may reject the observe call.
    }
  }

  // ── Collect and send ──────────────────────────────────────────────────────

  let lastVisibleAt = document.visibilityState === 'visible' ? Date.now() : 0;
  let reportTimer = null;

  function collectMetrics() {
    return {
      // Full tree traversal, cached until the next mutation — call sparingly.
      // Read exactly once per report cycle, never inside the mutation callback.
      domNodes: document.all.length,

      // Held from the most recent sampling window.
      mutationsPerSec,

      // Cumulative KB transferred since page load (passive accumulation).
      transferKB: Math.round(transferKB * 10) / 10,

      // Element-type flags maintained by the mutation-driven checker above.
      hasVideo,
      hasCanvas,
      hasLargeCanvas,
    };
  }

  /**
   * Report only when someone can actually see the reading. The service worker
   * persists history for the active focused tab only, so reporting from a
   * hidden or unfocused tab is pure waste — it wakes the worker for nothing.
   */
  function shouldReport() {
    if (document.visibilityState !== 'visible') return false;
    if (document.hasFocus()) return true;
    return Date.now() - lastVisibleAt < RECENT_VISIBLE_MS;
  }

  function sendMetrics() {
    if (!shouldReport()) return;
    // Guard against the extension being reloaded/updated while this content
    // script is still alive — chrome.runtime.sendMessage throws synchronously
    // with "Extension context invalidated" in that case.
    if (!chrome.runtime?.id) return;
    const metrics = collectMetrics();
    try {
      chrome.runtime.sendMessage({ type: 'PAGE_METRICS', metrics }).catch(() => {});
    } catch (_) {}
  }

  /**
   * Fired by the report timer: average this period's window rates into the
   * reported figure, then send.
   *
   * Averaging several short windows is what makes a burst visible without
   * observing continuously — a single window per period is a coin flip on a
   * streaming page (see test/sampling-fidelity.js). If no window closed this
   * period (e.g. the tab just became visible), the previous value is held.
   */
  function onReportTick() {
    if (periodCount > 0) {
      mutationsPerSec = periodSum / periodCount;
      periodSum = 0;
      periodCount = 0;
    }
    sendMetrics();
  }

  function startReporting() {
    if (reportTimer !== null || disabled.timers) return;
    reportTimer = setInterval(onReportTick, REPORT_PERIOD_MS);
  }

  function stopReporting() {
    if (reportTimer !== null) { clearInterval(reportTimer); reportTimer = null; }
  }

  // Background tabs must generate zero messages and zero timers — previously
  // only the observer stopped, so every background tab still woke the service
  // worker on its own schedule.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopSampling();
      stopReporting();
    } else {
      lastVisibleAt = Date.now();
      startSampling();
      // Send once immediately so the popup is never stale, then resume.
      sendMetrics();
      startReporting();
    }
  });

  // ── Startup ───────────────────────────────────────────────────────────────
  // Zero main-thread work between document_idle and load: everything below is
  // armed only after `load`, and then only once the browser is idle.

  function begin() {
    updateElementFlags();
    startPerfObserver();
    if (document.visibilityState === 'visible') {
      startSampling();
      startReporting();
      // First reading shortly after the settle delay, so the popup has data
      // without waiting a full report period.
      setTimeout(sendMetrics, SAMPLE_WINDOW_MS + 500);
    }
  }

  function afterLoad() {
    // `load` plus an idle callback: never contend with the page's own tail-end
    // work, and never observe during hydration.
    whenIdle(() => setTimeout(begin, SETTLE_DELAY_MS));
  }

  readKillSwitch().then(() => {
    if (document.readyState === 'complete') afterLoad();
    else window.addEventListener('load', afterLoad, { once: true });
  });

})();
