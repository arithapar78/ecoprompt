# EcoPrompt — performance baseline

Status: **protocol filled in, numbers not yet collected.**

The code changes in Package 1 are complete and the accuracy proof
(`extension/test/sampling-fidelity.js`) passes, but the browser-side numbers in
this file require driving Chrome with two profiles. Run the protocol below and
fill the empty cells; nothing else in the repo depends on them.

Every "after" row should be measured on the **same machine, same day, same
network** as its "before" row. Cross-machine comparisons are noise.

---

## 1. Setup

Two Chrome profiles, both otherwise free of extensions:

```bash
# Clean profile
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --user-data-dir=/tmp/eco-clean --no-first-run

# Extension profile — load extension/ unpacked at chrome://extensions
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --user-data-dir=/tmp/eco-ext --no-first-run
```

Test pages:

| # | URL | Why |
|---|---|---|
| 1 | `https://docs.google.com/presentation/` | **The reported failure.** Canvas + heavy hydration. |
| 2 | `https://chatgpt.com` (mid-stream) | Bursty mutations — the profile the sampler is tuned for. |
| 3 | a heavy news site | Ad-heavy, many resources. |
| 4 | `https://en.wikipedia.org/wiki/Chrome` | Large static DOM, low churn. |
| 5 | `https://example.com` | Floor — measures pure injection cost. |

## 2. Per-page protocol

1. DevTools → Performance → record a cold reload (**disable cache**), stop at
   load + 10 s.
2. Record **TBT**, **LCP**, main-thread **Scripting** ms, and the summed
   self-time of frames in the extension's isolated world.
3. `chrome://tracing` (categories `extensions`, `v8`, `devtools.timeline`) →
   find `ScriptInjection::InjectJS`, `v8.compile`, `v8.run` for the content
   script. Record compile + run ms.
4. **11 runs per page per profile; report medians.** Single runs are noise.
   `perf/measure.sh` automates this via Lighthouse and prints the medians.
5. `chrome://extensions` → service worker → after 60 s idle with 10 tabs open,
   record whether it reads `active` or `inactive`.

## 3. Results — fill these in

### 3.1 Total Blocking Time (median of 11, ms)

Acceptance: **extension − clean < 30 ms on every page.**

| Page | Clean | Ext (before) | Δ before | Ext (after) | Δ after | Pass? |
|---|---|---|---|---|---|---|
| Google Slides | | | | | | |
| chatgpt.com | | | | | | |
| news site | | | | | | |
| wikipedia.org | | | | | | |
| example.com | | | | | | |

### 3.2 LCP (median of 11, ms)

| Page | Clean | Ext (before) | Ext (after) |
|---|---|---|---|
| Google Slides | | | |
| chatgpt.com | | | |
| news site | | | |
| wikipedia.org | | | |
| example.com | | | |

### 3.3 Content-script main-thread self-time

Acceptance: **< 5 ms during load**, **< 1 ms/s steady state** on a streaming page.

| Page | Before (load) | After (load) | Before (ms/s steady) | After (ms/s steady) |
|---|---|---|---|---|
| Google Slides | | | | |
| chatgpt.com | | | | |

### 3.4 Injection cost (chrome://tracing, ms)

| Page | v8.compile | v8.run | InjectJS |
|---|---|---|---|
| Google Slides | | | |
| example.com | | | |

### 3.5 Service worker lifecycle

| Check | Before | After |
|---|---|---|
| State after 60 s idle, 10 tabs | | |
| Restarts observed in 5 min idle | | |

### 3.6 Storage writes

Acceptance: **≤ 1 write/min total** (was ~6/min/tab).

Count with a temporary counter in `flushToLocal()`, or watch
`chrome.storage.local` in DevTools.

| Metric | Before | After |
|---|---|---|
| `storage.local` writes/min (1 active tab) | | |
| `storage.local` writes/min (10 tabs, 1 active) | | |

### 3.7 Background-tab traffic

Acceptance: **zero** messages and zero timers from hidden tabs.

| Check | Before | After |
|---|---|---|
| `PAGE_METRICS` from a hidden tab in 2 min | | |

---

## 4. Isolating the Google Slides failure

The kill switch is built in. In the **extension** profile, with Slides open and
console + network recording **before** navigation:

```js
// Run in the service-worker console, then reload the page under test.
chrome.storage.local.set({ ecoDisableParts: 'observer' })  // then 'perf', 'timers', 'all'
chrome.storage.local.remove('ecoDisableParts')             // restore
```

Record which single value makes the page load:

| `ecoDisableParts` | Slides loads? | Notes |
|---|---|---|
| (unset — current build) | | |
| `observer` | | |
| `perf` | | |
| `timers` | | |
| `all` | | |

Also classify the failure mode:

- Page JS exception → capture the stack. The content script runs in an isolated
  world and cannot touch page objects, so a page-side throw means we caused it
  **indirectly** (timing, resource starvation, main-thread contention).
- Request timeout / aborted resource → contention or timing, not API
  interference.

**Prior hypothesis (to confirm or refute, not to assume):** the continuous
`MutationObserver` on `document.documentElement` with `subtree: true`. Slides
re-renders its editor surface constantly, and the old code began observing at
`document_idle` — i.e. straight through Slides' heaviest hydration phase. Blink
allocates a `MutationRecord` per childList change and schedules a microtask
*before* our callback runs, so the cost is paid whether or not the callback does
anything. The new build does not observe until after `load` + idle + 3 s, which
would fix this mechanism if it is the cause.

If `observer` alone does **not** fix it, say so in the report and record what
did — do not report a cause that was not isolated.
