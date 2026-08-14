# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Loading the Extension

There is no build step. Load `extension/` directly as an unpacked extension in Chrome at `chrome://extensions` → "Load unpacked". After any file change, click the refresh icon on the extension card.

## Architecture

This is a Manifest V3 Chrome extension with no external dependencies or bundler.

**Data flow for energy display:**
1. `content/content-script.js` runs on every page and samples DOM/network/media metrics, then posts them to the service worker via `chrome.runtime.sendMessage`. Reporting is **visibility-gated**: nothing is sent unless the tab is visible AND focused (or was visible in the last 60s), and both the sampler and the report timer stop entirely while the tab is hidden. Background tabs generate zero messages and zero timers.
2. `background/service-worker.js` receives metrics, calls `estimateWatts()` for frontend cost, then calls `resolveAIWatts()` to detect the AI platform and compute backend inference cost. Tab URL/title come from an in-memory cache fed by `tabs.onUpdated`/`onActivated`, not a `chrome.tabs.get` per message. The sum (`totalWatts`) is stored in `tabTotalWatts[tabId]` and appended via `appendWatts()`.
3. `popup/popup.js` polls `GET_METRICS` every 5s and displays `totalWatts` directly — it uses the service worker's pre-computed value, not its own local estimate.
4. `options/options.html` (the settings/history page) requests `GET_HISTORY` and renders the stored array as a bar chart.

**Storage writes are buffered.** `appendWatts` does NOT read-modify-write `chrome.storage.local`. The ring buffer lives in memory in the worker, mirrors to `chrome.storage.session` on every append (cheap, survives worker restarts), and is flushed to `chrome.storage.local` at most once per minute by the `ecoFlushHistory` alarm, plus once on `runtime.onSuspend`. On startup it hydrates from `session` if present, else `local`. This is what lets the service worker sleep between reports.

**Key coupling:** The popup's displayed watts and the history graph must show the same number. The graph reads from `wattsHistory` in storage, which is written by the service worker using the same `totalWatts` value the popup shows.

**AI watts calculation:** `AIEnergyManager.energyToWatts()` converts accumulated Wh to an instantaneous watt figure by dividing by session duration. This value grows small as the session lengthens (energy is spread over more hours). If the tab has been open a long time, `aiWatts` will approach 0 even for active AI sites — this is intentional.

## File Roles

| File | Role |
|---|---|
| `background/service-worker.js` | Receives metrics, computes totals, owns storage writes, tab metadata cache, per-site disable list |
| `content/content-script.js` | Passive metric collection only — no energy math. Duty-cycled sampler; see "Sampling" below |
| `lib/energy-estimator.js` | Frontend heuristic: DOM + mutations + network + media → watts (0.1–5 W range) |
| `lib/ai-energy-database.js` | AI site detection patterns + `AIEnergyManager` class |
| `lib/storage.js` | `appendWatts` / `readHistory` / `clearHistory` against `chrome.storage.local` |
| `lib/optimizer-ui.js` | **Shared** optimizer UI mounted by BOTH popup and Settings page — input, metrics, output, Copy, backend event. One implementation, two mount points |
| `lib/optimizer-ui.css` | Styles for the above; no hardcoded colors, only `--eco-*` vars bridged from `popup.css` / `options.css` |
| `popup/popup.js` | Reads `totalWatts` from SW; does NOT re-estimate. Mounts `optimizer-ui` lazily |
| `options/options.js` | Reads history array, renders canvas bar chart, computes Current/Avg/Peak stats, mounts `optimizer-ui` lazily on the `#optimizer` tab |
| `test/sampling-fidelity.js` | Proves the duty-cycled sampler tracks ground truth within ±10% across 5 page profiles |
| `perf/BASELINE.md` | Performance measurement protocol + results table (browser numbers must be filled in by hand) |

## Constants to Know

- Light bulb comparison: **6 W** (not 60 W)
- History cap: `MAX_ENTRIES` = 2880 entries (~24 h at 30s sampling)
- Storage keys: `'wattsHistory'` (ring buffer), `'wattsDaily'` (rollup)
- History entry shape: `{ ts: number, watts: number, site: string|null }`
- `energyPerQuery` values are in **Wh** (watt-hours), not watts
- `SAMPLE_INTERVAL_S` = 30 in `lib/storage.js` — **must match** the content script's `REPORT_PERIOD_MS`, since it converts a watt sample into Wh
- `MAX_SANE_WATTS` = 2000 — readings above this are dropped

### Sampling (content script)

All cadence constants live in one block at the top of `content/content-script.js`:

- `REPORT_PERIOD_MS` = 30000 — how often metrics are sent (**was 10s**)
- `SAMPLE_WINDOW_MS` = 200, `SAMPLES_PER_PERIOD` = 10, `SAMPLE_PERIOD_MS` = 30000
- `SETTLE_DELAY_MS` = 3000 — nothing observes until `load` + idle + this delay

The MutationObserver is **duty-cycled**, not continuous: 10 × 200 ms windows per
30 s ≈ 6.7% live. Window phases are **randomized** (stratified: one per equal
slot) — a fixed phase aliases against periodic pages, which is how a streaming
page can read as either its peak or zero. Each window's rate is capped at 200
*before* averaging, matching how the old 1s counter capped each sample.

Splitting the budget into many short windows rather than one long one is what
makes this accurate; it costs the same observer time. See the table in
`test/sampling-fidelity.js` — 1 × 2000 ms gives 45.6% worst-case error,
10 × 200 ms gives 5.1%. Run `node extension/test/sampling-fidelity.js` after
changing any of these.

## Scope Constraints (from SKILL.md)

Do not add: premium access, full analytics dashboard, OODA agent, pattern recognition, notifications, website integration, export/import, or advanced settings. MVP only.
