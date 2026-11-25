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
