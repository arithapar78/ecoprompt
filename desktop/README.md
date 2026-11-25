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

- Runs from the menu bar / tray. Closing the window hides it; Quit is in the tray menu.
- Default shortcut `Cmd+Shift+E` (Mac) / `Ctrl+Shift+E` (Windows); change it under Settings in the main window. Stored in `settings.json` in the app config dir.
- Flow: Rust reads the clipboard, asks the (hidden) webview to run the rules optimizer, writes the result back, shows a toast with Undo (30 s). Clipboard only: no keystroke simulation, so no Accessibility permission.
- Logs: `~/Library/Logs/com.learntav.ecoprompt/`. `ECOPROMPT_DEBUG=1` for debug level. Prompt text is never logged.
- Rust tests: `cd src-tauri && cargo test`. Tray icon source: `node scripts/make-tray-icon.mjs`.
