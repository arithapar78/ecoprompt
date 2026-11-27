# EcoPrompt Desktop

Mac + Windows app (Tauri 2). Separate product from the Chrome extension in `../extension/` (never edit the extension from here).

## Setup (Mac)

```sh
# Rust (once)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup target add aarch64-apple-darwin x86_64-apple-darwin   # for universal builds

cd desktop
npm install
```

Requires Node 20+ and Xcode Command Line Tools (`xcode-select --install`).

## Run

```sh
npm run tauri dev        # first run compiles ~345 crates (about 1 min)
```

## Icons

```sh
npm run tauri icon ../extension/assets/logo.png
```

Windows builds run through GitHub Actions (added in Phase 4).

## Optimizer sync and tests

```sh
npm run sync:optimizer   # copy extension/lib optimizer into src/vendor/optimizer (never hand-edit)
npm test                 # parity test: vendored copy vs extension originals
node ../extension/test/optimizer-test.js   # extension's own tests (run from repo root: node extension/test/optimizer-test.js)
```

## Tray and quick optimize

- Runs from the menu bar / tray. Closing the window hides it; Quit is in the tray menu. On Mac the Dock icon stays by default so the app is always reachable (Settings can hide it).
- Default shortcut `Cmd+Shift+E` (Mac) / `Ctrl+Shift+E` (Windows); change it under Settings in the main window. Stored in `settings.json` in the app config dir.
- Flow: Rust reads the clipboard, asks the (hidden) webview to run the rules optimizer, writes the result back, shows a toast with Undo (30 s). Clipboard only: no keystroke simulation, so no Accessibility permission.
- Logs: `~/Library/Logs/com.learntav.ecoprompt/`. `ECOPROMPT_DEBUG=1` for debug level. Prompt text is never logged.
- Rust tests: `cd src-tauri && cargo test`. Tray icon source: `node scripts/make-tray-icon.mjs`.

## Energy monitor

- `src-tauri/src/energy_model.rs` holds every constant and the formulas (header comment). Estimate only: `P_idle + cpu_util × (P_max − P_idle)`; apps get a share of the dynamic part by CPU share.
- `ai_apps.rs` maps process names to groups (exact match on the normalized name; macOS `… Helper (…)` processes roll up to the parent).
- `monitor.rs` samples every 30 s (CPU + process list only). Window hidden → still samples, doesn't push to the webview.
- History: `history.json` (2,880-entry ring, extension-compatible `{ts, watts, site}` + `apps`) and `daily.json` (90 days, Wh per group) in the app data dir (Mac: `~/Library/Application Support/com.learntav.ecoprompt/`). Flushed at most once a minute and on quit, always atomically (temp + rename).
- Mac laptops on battery also show "measured (battery)" from `ioreg` (no sudo). macOS refreshes that reading roughly once a minute, so it repeats across 30 s samples.
- Idle/Max watts are editable under Settings.

## Build and release

```sh
npm run check:versions                       # package.json / tauri.conf.json / Cargo.toml / Cargo.lock must agree
npm run version:set -- 0.2.0                 # change the version everywhere (package.json is the source)
npm run tauri build -- --target universal-apple-darwin
# -> src-tauri/target/universal-apple-darwin/release/bundle/dmg/EcoPrompt_<version>_universal.dmg
```

- Building the DMG from a terminal that cannot control Finder fails at "AppleEvent timed out". Run with `CI=true npm run tauri build -- …`; this only skips the DMG window layout.
- Windows builds only through GitHub Actions: `.github/workflows/desktop-release.yml` (repo root).
- **Release flow:** bump the version (`npm run version:set -- X.Y.Z`), `npm run check:versions`, commit, then `git tag desktop-vX.Y.Z && git push origin desktop-vX.Y.Z`. The workflow creates a draft release, builds the Mac `.dmg` and Windows `-setup.exe` + `.msi`, uploads `SHA256SUMS.txt`, checks the assets, and **publishes** the release. A version with a hyphen (e.g. `0.2.0-beta`) is published as a prerelease, which the website ignores. Re-pushing the same tag cleans up any stale draft first.
- Builds are unsigned: see [docs/INSTALL-UNSIGNED.md](docs/INSTALL-UNSIGNED.md).

## Tests

```sh
npm test                        # optimizer parity (vendored vs extension) + log-privacy
(cd src-tauri && cargo test)    # energy model, apps, history, atomic write, battery parser, quick-optimize
node ../extension/test/optimizer-test.js   # from the repo root: node extension/test/optimizer-test.js
```

## Debugging

Hidden diagnostics panel: **Cmd/Ctrl+Shift+D** (version, optimizer commit, energy constants, last 10 samples, own CPU, last 20 log lines, "Copy diagnostics"). Full guide, log paths and a symptom table: [docs/DEBUGGING.md](docs/DEBUGGING.md).
