// content/content-script.js
// Role: collect lightweight page metrics and push them to the service worker.
// Safety rules:
//   - No repeated full-DOM traversals; node count is sampled once per send cycle
//     using a single cheap property (document.all.length) instead of querySelectorAll.
//   - MutationObserver only watches childList (structural changes), not attributes,
//     to avoid firing on every class/style tweak in reactive frameworks.
//   - Element-type flags (video, canvas) are resolved once at startup and refreshed
//     only after structural DOM changes, throttled to once per 5 s and deferred to
//     requestIdleCallback so the check never competes with the page's own work.
//   - getContext() is NEVER called on a page-owned canvas: a canvas's context type
//     is permanent, so probing for WebGL would permanently deny the page its own
//     getContext('2d'). Canvas size is used as a read-only proxy instead.
//   - Network bytes accumulate passively via PerformanceObserver — no active polling.
//   - All sends are fire-and-forget; errors are silently ignored.

(function () {

  // ── Mutation tracking ──────────────────────────────────────────────────────
  // Track structural DOM changes only (childList). Skipping attribute observation
  // avoids a flood of callbacks on pages that animate via class/style changes.

  let mutationCount = 0;
  let mutationsPerSec = 0;

  const mutationObserver = new MutationObserver((records) => {
    mutationCount += records.length;

    // Re-check element-type flags only when the structure actually changed.
    scheduleElementCheck();
  });

  const OBSERVER_OPTS = {
    childList: true,
    subtree: true,
    // attributes: false — intentionally omitted; cuts callback volume dramatically
    //   on reactive frameworks that update dozens of attributes per render cycle.
  };

  let observing = false;

  function startObserving() {
    if (observing) return;
    mutationObserver.observe(document.documentElement, OBSERVER_OPTS);
    observing = true;
  }

  function stopObserving() {
    if (!observing) return;
    mutationObserver.disconnect();
    observing = false;
  }

  // Background tabs still fire mutations (timers, streamed responses) but nobody
  // is looking at the reading, so drop the observer entirely while hidden.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopObserving();
    else startObserving();
  });

  if (document.visibilityState !== 'hidden') startObserving();

  // Flush mutation count once per second. Simple counter reset — no iteration.
  setInterval(() => {
    mutationsPerSec = mutationCount;
    mutationCount = 0;
  }, 1000);

  // ── Element-type flags ────────────────────────────────────────────────────
  // Resolved once at startup, then refreshed after structural DOM changes — but
  // at most once per 5 s, and only while the browser is idle. querySelector is a
  // full tree walk on pages that have no <video>/<canvas>, so on a streaming page
  // (ChatGPT tokens, infinite feeds) an unthrottled check is constant jank.

  const ELEMENT_CHECK_INTERVAL_MS = 5000;

  // A canvas at least this large implies real rendering work rather than a
  // 1×1 tracking pixel or an offscreen sprite sheet.
  const LARGE_CANVAS_W = 300;
  const LARGE_CANVAS_H = 150;

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
    // much — reading width/height is safe, whereas getContext() would permanently
    // fix the canvas's context type and break the page's own rendering.
    const canvasEl = document.querySelector('canvas');
    hasCanvas = canvasEl !== null;
    hasLargeCanvas =
      canvasEl !== null &&
      canvasEl.width >= LARGE_CANVAS_W &&
      canvasEl.height >= LARGE_CANVAS_H;
  }

  // Run once at startup.
  updateElementFlags();

  // ── Network tracking ──────────────────────────────────────────────────────
  // PerformanceObserver accumulates bytes passively as resources load.
  // No polling needed — the observer fires only when new resources complete.

  let transferKB = 0;

  if (typeof PerformanceObserver !== 'undefined') {
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

  function collectMetrics() {
    return {
      // document.all.length is a cheap O(1) browser-internal counter —
      // faster than querySelectorAll('*').length which does a full tree walk.
      domNodes: document.all.length,

      // Mutations per second from the rolling counter above.
      mutationsPerSec,

      // Cumulative KB transferred since page load (passive accumulation).
      transferKB: Math.round(transferKB * 10) / 10,

      // Element-type flags maintained by the mutation-driven checker above.
      hasVideo,
      hasCanvas,
      hasLargeCanvas,
    };
  }

  function sendMetrics() {
    // Guard against the extension being reloaded/updated while this content
    // script is still alive — chrome.runtime.sendMessage throws synchronously
    // with "Extension context invalidated" in that case.
    if (!chrome.runtime?.id) return;
    const metrics = collectMetrics();
    try {
      chrome.runtime.sendMessage({ type: 'PAGE_METRICS', metrics }).catch(() => {});
    } catch (_) {}
  }

  // Send once on load (after a short delay so the page has started rendering),
  // then every 10 seconds. 10 s is frequent enough for a live display while
  // being far below any perceptible performance impact.
  setTimeout(sendMetrics, 1500);
  setInterval(sendMetrics, 10000);

})();
