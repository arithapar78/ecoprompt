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

## Desktop app (`desktop/`)

**The extension's MVP scope rules above do NOT apply to `desktop/`.** It is a separate product (Tauri 2, Mac + Windows) in its own folder. Never modify `extension/` from desktop work.

**Run / test / build** (details in `desktop/README.md`):

```sh
cd desktop && npm install
npm run tauri dev                          # dev window
npm test                                   # optimizer parity + log-privacy (node)
(cd src-tauri && cargo test)               # Rust tests
npm run check:versions                     # package.json / tauri.conf.json / Cargo.toml / Cargo.lock agree
CI=true npm run tauri build -- --target universal-apple-darwin   # Mac .dmg (CI=true skips Finder DMG styling)
```

**Layout**

| Path | Role |
|---|---|
| `desktop/src/` | Plain HTML/CSS/JS, no framework or bundler. `engine.js` is the single optimizer interface (`engine: 'rules'` today; the seam for a future `'local-llm'`) |
| `desktop/src/vendor/optimizer/` | **Vendored copy** of `extension/lib/{prompt-rules-db,token-counter,prompt-optimizer,prompt-generator}.js`. Never edit by hand |
| `desktop/src-tauri/src/energy_model.rs` | **Every energy constant and the formulas.** Estimate only; `SAMPLE_INTERVAL_S` (30) must match the extension's `REPORT_PERIOD_MS`. Laptop defaults (5 W idle, 32 W max) are calibrated on one MacBook; method, data and limits in `desktop/docs/ENERGY-CALIBRATION.md`, re-runnable with `desktop/scripts/calibrate-energy.sh` |
| `desktop/src-tauri/src/ai_apps.rs` | Process name to group table (exact match on normalized name; Mac helper processes roll up) |
| `desktop/src-tauri/src/monitor.rs` | 30 s sampler (CPU + processes only), battery cross-check (Mac laptops on battery: `SystemLoad` from `ioreg`, because `InstantAmperage` reads 0 under load), raw samples for the debug panel |
| `desktop/src-tauri/src/history.rs`, `fsutil.rs` | Ring buffer + daily rollup, and the one atomic-write function (every file write goes through it) |
| `desktop/src-tauri/src/quick.rs` | Quick-optimize decisions, Undo slot, and the only builders of log text derived from the clipboard |
| `desktop/src-tauri/src/lib.rs` | Tray, hotkey, toast window, commands, diagnostics. Mac behavior: closing the window hides it and the Dock icon STAYS by default (opt-in Settings checkbox `hide_dock_when_closed` makes it menu-bar only), macOS `Reopen` and the single-instance plugin bring the window back, first launch shows a welcome toast |

**Sync-optimizer rule.** The desktop optimizer must give byte-identical results to the extension. Change the optimizer only in `extension/lib/`, commit it, then run `npm run sync:optimizer` in `desktop/` (it refuses to run if those files have uncommitted changes) and `npm test`. `SYNC.json` records the source commit and SHA-256s.

**History and data.** `history.json` (ring of 2,880 entries `{ts, watts, site, apps}`, same shape as the extension plus `apps`) and `daily.json` (90 days, Wh per group, `{whTotal, bySite}`) live in the OS app data dir (Mac: `~/Library/Application Support/com.learntav.ecoprompt/`). Memory-buffered; flushed at most once a minute and on quit; atomic writes. Wh per sample is computed only by `energy_model::wh_for_sample`.

**Rules that must not break**
- No telemetry from the desktop app, and no automatic network calls. The only request is the user-clicked "Check for updates" (GET of `latest.json` from the GitHub release).
- Never log prompt or clipboard text (lengths and counts only). `desktop/test/log-privacy.test.mjs` and `quick::tests` enforce it.
- Quick optimize is clipboard-only: never simulate keystrokes (that needs Mac Accessibility permission).
- Energy figures are estimates and must be labelled as such in the UI.

**Debugging:** `desktop/docs/DEBUGGING.md`. Hidden debug panel: Cmd/Ctrl+Shift+D.

**Release flow.** `npm run version:set -- X.Y.Z` (package.json is the version source), commit, then `git tag desktop-vX.Y.Z && git push origin desktop-vX.Y.Z`. `.github/workflows/desktop-release.yml` builds the Mac universal `.dmg` and Windows NSIS `-setup.exe` + `.msi`, creates a draft GitHub Release with `SHA256SUMS.txt`, checks the assets, then **publishes** it automatically (a hyphenated version is published as a prerelease). Builds are unsigned (`desktop/docs/INSTALL-UNSIGNED.md`). The download buttons on learntav.com are live (`COMING_SOON` is `false` in `Website/assets/js/ecoprompt-download.js`, a separate repo, `arithapar78/learntav`) and always offer the newest published `desktop-v*` release, so a release needs no website change.

**Repo note.** This repo is now `arithapar78/ecoprompt` on GitHub (the old `power-tracker-v3` name redirects).
