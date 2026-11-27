# Debugging EcoPrompt Desktop

Logging and diagnostics are built in. Start with the debug panel and the log file, then read code.

## Where things live

| What | macOS | Windows |
|---|---|---|
| Log files (5 x 1 MB, rotated) | `~/Library/Logs/com.learntav.ecoprompt/EcoPrompt.log` | `%LOCALAPPDATA%\com.learntav.ecoprompt\logs\EcoPrompt.log` |
| History (`history.json`, `daily.json`) | `~/Library/Application Support/com.learntav.ecoprompt/` | `%APPDATA%\com.learntav.ecoprompt\` |
| Settings (`settings.json`) | `~/Library/Application Support/com.learntav.ecoprompt/` | `%APPDATA%\com.learntav.ecoprompt\` |

These come from Tauri 2's path resolver (`app_log_dir`, `app_data_dir`, `app_config_dir`) and the bundle identifier `com.learntav.ecoprompt`. Rust and the webview write to the same file.

## Logging

- Default level `info`. Set the environment variable `ECOPROMPT_DEBUG=1`, or turn on **Debug logging** in the debug panel, for `debug`.
- The logger is built at `debug` and gated by the global `log` max level (`apply_log_level` in `src-tauri/src/lib.rs`), so the panel toggle takes effect immediately.
- **Prompt text and clipboard contents are never logged.** Only lengths, token counts and timings. Two tests enforce this:
  - `node test/log-privacy.test.mjs` runs `optimize()` with canary prompts and fails if any text appears in the console or Tauri-forwarded logs.
  - `cargo test` (`quick::tests::log_lines_never_contain_the_clipboard_text`) does the same for the quick-optimize log lines.
- In JS use `src/log.js`, never `console.*` directly, so everything lands in the one file.

## Debug panel

Open it with **Cmd/Ctrl+Shift+D** in the main window. It shows the app version, the vendored optimizer's source commit (from `SYNC.json`), OS and device class, the energy model constants in use and the defaults, the app's own CPU %, raw battery values (Mac laptops), the last 10 samples (total CPU %, top 5 processes, computed watts), and the last 20 log lines. **Copy diagnostics** copies all of it as JSON (no prompts). Paste that into a bug report.

## Where to look when something breaks

| Symptom | First thing to check | Likely fix |
|---|---|---|
| Blank white window in dev | Webview devtools (right-click, Inspect, in dev builds) console | Wrong `frontendDist` in `tauri.conf.json`, or a script 404 |
| `window.EcoPromptOptimizer is undefined` | Script order in `index.html`; network panel for 404s | Classic scripts must load in order (rules-db, token-counter, optimizer, generator), before app JS |
| "not allowed" / command or plugin call rejected | Terminal running `tauri dev`, and devtools console | Tauri 2 capabilities: add the permission to `src-tauri/capabilities/*.json` (JS logging needs `log:default`) |
| Hotkey does nothing | Log for "could not register shortcut" | Another app owns the combo; pick another in Settings |
| Clipboard read returns empty | Log entry "quick-optimize skipped" | Clipboard has non-text (image or file) |
| CPU shows 0% always | Debug panel raw samples | The first `sysinfo` read is discarded; samples come every 30 s |
| Watts look way too high or low | Debug panel constants and the battery cross-check lines in the log (`measured vs estimate`) | Tune `P_idle`/`P_max` in `energy_model.rs`, note the source, or override in Settings |
| A process shows up only in "Other" for one sample | Expected | `sysinfo` reports 0% for a process it sees for the first time; the unclaimed CPU goes to Other |
| "Measured (battery)" missing | Debug panel, battery raw | Only shown on a Mac laptop running on battery (plugged in hides it). The value is `PowerTelemetryData.SystemLoad` (falls back to voltage x amperage; `InstantAmperage` reads 0 under load). It refreshes only every ~10-60 s, so it repeats across samples, and an occasional 0 is ignored. See `docs/ENERGY-CALIBRATION.md` |
| "I launched it and nothing happened" / "is it running?" (Mac) | Activity Monitor for `EcoPrompt`; the log file | EcoPrompt is a menu-bar app: closing its window hides it, and the icon sits at the right of the menu bar. A crowded menu bar can hide the icon behind the camera notch. Opening EcoPrompt again from Applications (or clicking its Dock icon) brings the window back (`RunEvent::Reopen`); a second copy never starts (single-instance). The log shows "reopen requested" or "second launch: showing the running app" |
| Tray icon invisible on Mac | Icon file used | Must be a template image (monochrome, transparent): `icons/tray/tray-template.png`, regenerate with `node scripts/make-tray-icon.mjs` |
| History lost after crash | `history.json` and any `.tmp` beside it | Atomic write not used everywhere; check the flush-on-quit path. A `kill -9` can lose up to one minute of samples (flush interval) |
| Mac says app "is damaged" | Downloaded build, not local | Unsigned plus quarantine attribute. For your own testing only: `xattr -cr /Applications/EcoPrompt.app`. Users follow `INSTALL-UNSIGNED.md` |
| `tauri build` fails at the DMG step with "AppleEvent timed out" | Terminal can't control Finder | Build with `CI=true`; it only skips the DMG window layout. GitHub runners set it already |
| Windows build fails on Mac | n/a | Expected. Use the GitHub Actions workflow |
| Release workflow fails | Actions log, the failing step | Missing Rust target, wrong tag pattern, tag not equal to `desktop-v<version>`, or `GITHUB_TOKEN` permissions (`contents: write`) |
| Download page buttons go to 404 | Network tab, the `releases` response | Release is still a draft, the repo is private, or the asset names don't match `\.dmg$` / `-setup\.exe$` |
| Download page still says "Coming soon" | `COMING_SOON` in `Website/assets/js/ecoprompt-download.js` | Set it to `false` after the first release is **published** |
| Website change not showing live | GitHub Pages build status | Pages cache; hard refresh. Confirm the push reached the branch Pages serves |

## How to debug (process, every time)

1. **Reproduce first.** Write down the exact steps and what you expected. If you can't reproduce it, say so; don't fix blind.
2. **Read the logs and the debug panel** before reading code.
3. **Isolate:** Rust or webview? Make the smallest test that fails (a `cargo test` or a `node` test) before changing app code.
4. **One change at a time**, then re-run the test. If a fix doesn't work, revert it before trying the next idea.
5. **Report the cause, not just the fix:** what broke, why, the evidence, and the test that now covers it.
6. If you're stuck after 3 attempts on the same issue, stop and say what you tried and what you think is going on.

## Things learned while building

- **"web content process terminated" at startup is benign.** With `--hidden` the debug log shows it twice, but the hidden webview still answers quick-optimize and forwards its logs (tested with the window hidden).
- **Processes first seen between two samples read 0% CPU** in `sysinfo`. The monitor therefore uses the OS's total CPU as the denominator and gives unclaimed CPU to "Other" (`ai_apps::add_unattributed`), so watts stay conserved.
- **Run a test app from a script that outlives it.** A background app started from a short-lived shell can be killed when that shell's tool call ends, which looks like an unexplained app exit.
- **Draft GitHub releases can't be fetched by tag.** The release workflow creates the draft first (one job) and passes its numeric id to the build jobs and the checksum job.
- **The repo was renamed** to `arithapar78/ecoprompt`. The old `power-tracker-v3` URL works through a redirect, but code should use the new name.
- **`releases/latest` can return a non-desktop release** if the extension ever publishes one here. The download page lists releases and picks the newest published `desktop-v*`.
- **Rust edition 2024 reserves `gen`** as a keyword; don't use it as an identifier.
- **BSD `sed` (macOS) has no `\b`.** Use Python or `perl` for word-boundary edits in scripts.
