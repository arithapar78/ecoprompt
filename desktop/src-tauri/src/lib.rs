mod ai_apps;
mod battery;
mod energy_model;
mod fsutil;
mod history;
mod monitor;
mod quick;
mod settings;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const TOAST_MS: u64 = 6_000;
/// If the webview doesn't answer a quick-optimize request in this long, give up.
const OPTIMIZER_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Default)]
struct AppState {
    undo: Mutex<quick::UndoSlot>,
    /// (request id, original text) of the quick-optimize awaiting the webview.
    pending: Mutex<Option<(u64, String)>>,
    next_id: AtomicU64,
    toast_gen: AtomicU64,
    shortcut: Mutex<String>,
}

// ── Windows ──────────────────────────────────────────────────────────────────

fn show_main(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn hide_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    // Hide the Dock icon while only the tray is visible.
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

fn create_toast_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, "toast", WebviewUrl::App("toast.html".into()))
        .title("EcoPrompt toast")
        .inner_size(340.0, 84.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .focusable(false)
        .shadow(true)
        .build()
}

/// Show a small toast near the top-right of the primary monitor.
fn toast(app: &AppHandle, message: &str, undo: bool) {
    let Some(w) = app.get_webview_window("toast") else {
        log::warn!("toast window missing; message dropped");
        return;
    };
    let _ = app.emit_to("toast", "toast", json!({ "message": message, "undo": undo }));
    if let Ok(Some(m)) = w.primary_monitor() {
        let scale = m.scale_factor();
        let (mx, my) = (m.position().x, m.position().y);
        let x = mx + m.size().width as i32 - ((340.0 + 16.0) * scale) as i32;
        let y = my + (40.0 * scale) as i32;
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }
    let _ = w.show();

    let state = app.state::<AppState>();
    let generation = state.toast_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(TOAST_MS));
        // A newer toast owns the window now: leave it.
        if app.state::<AppState>().toast_gen.load(Ordering::SeqCst) == generation {
            if let Some(w) = app.get_webview_window("toast") {
                let _ = w.hide();
            }
        }
    });
}

// ── Quick optimize ───────────────────────────────────────────────────────────
// Rust owns clipboard + hotkey + toast. The optimizer is JS, so the hidden main
// webview does the actual text work and reports back via
// `quick_optimize_result`. Future input methods only need to call this flow.

fn quick_optimize(app: &AppHandle) {
    let clip = app.clipboard().read_text().ok();
    let text = match quick::classify(clip.as_deref()) {
        Ok(t) => t.to_string(),
        Err(msg) => {
            log::info!("quick-optimize skipped: {}", msg);
            toast(app, &msg, false);
            return;
        }
    };
    let state = app.state::<AppState>();
    let id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    log::debug!("{}", quick::describe_request(id, &text));
    *state.pending.lock().unwrap() = Some((id, text.clone()));

    if app.emit_to("main", "quick-optimize", json!({ "id": id, "text": text })).is_err() {
        log::error!("could not reach the optimizer webview");
    }

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(OPTIMIZER_TIMEOUT);
        let state = app.state::<AppState>();
        let mut pending = state.pending.lock().unwrap();
        if matches!(*pending, Some((pid, _)) if pid == id) {
            *pending = None;
            drop(pending);
            log::error!("optimizer webview did not answer request {}", id);
            toast(&app, "Optimizer didn't respond. Open EcoPrompt and try again.", false);
        }
    });
}

#[tauri::command]
fn quick_optimize_result(
    app: AppHandle,
    state: tauri::State<AppState>,
    id: u64,
    optimized: String,
    tokens_saved: u32,
    percent: u32,
) {
    let original = match state.pending.lock().unwrap().take() {
        Some((pid, original)) if pid == id => original,
        other => {
            // Stale or timed-out request: put back whatever was pending.
            *state.pending.lock().unwrap() = other;
            return;
        }
    };
    log::debug!("{}", quick::describe_result(id, &original, &optimized, tokens_saved));
    match quick::decide(&original, &optimized, tokens_saved, percent) {
        quick::Outcome::AlreadyLean => toast(&app, "Already lean", false),
        quick::Outcome::Replace { message } => {
            if let Err(e) = app.clipboard().write_text(optimized) {
                log::error!("clipboard write failed: {}", e);
                toast(&app, "Couldn't write to the clipboard.", false);
                return;
            }
            state.undo.lock().unwrap().store(original, Instant::now());
            toast(&app, &message, true);
        }
    }
}

#[tauri::command]
fn undo_quick(app: AppHandle, state: tauri::State<AppState>) {
    let restored = state.undo.lock().unwrap().take_fresh(Instant::now());
    match restored {
        Some(original) => match app.clipboard().write_text(original) {
            Ok(()) => toast(&app, "Restored your original text.", false),
            Err(e) => {
                log::error!("undo clipboard write failed: {}", e);
                toast(&app, "Couldn't restore the clipboard.", false);
            }
        },
        None => toast(&app, "Nothing to undo (30 s window passed).", false),
    }
}

// ── Shortcut ─────────────────────────────────────────────────────────────────

fn register_shortcut(app: &AppHandle, accel: &str) -> Result<(), String> {
    let new: Shortcut = accel.parse().map_err(|e| format!("Invalid shortcut: {e}"))?;
    let gs = app.global_shortcut();
    let state = app.state::<AppState>();
    let old = state.shortcut.lock().unwrap().clone();
    if !old.is_empty() {
        if let Ok(old_sc) = old.parse::<Shortcut>() {
            let _ = gs.unregister(old_sc);
        }
    }
    match gs.register(new) {
        Ok(()) => {
            *state.shortcut.lock().unwrap() = accel.to_string();
            log::info!("registered global shortcut {}", accel);
            Ok(())
        }
        Err(e) => {
            log::error!("could not register shortcut {}: {}", accel, e);
            // Put the previous one back so the user isn't left with none.
            if let Ok(old_sc) = old.parse::<Shortcut>() {
                if gs.register(old_sc).is_err() {
                    state.shortcut.lock().unwrap().clear();
                }
            }
            Err(format!("{accel} is already in use by another app. Pick a different shortcut."))
        }
    }
}

pub(crate) fn settings_path(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("settings.json")
}

#[tauri::command]
fn get_settings(app: AppHandle) -> settings::Settings {
    settings::load(&settings_path(&app))
}

#[tauri::command]
fn set_shortcut(app: AppHandle, accelerator: String) -> Result<(), String> {
    register_shortcut(&app, &accelerator)?;
    let path = settings_path(&app);
    let mut s = settings::load(&path);
    s.shortcut = accelerator;
    settings::save(&path, &s).map_err(|e| format!("Couldn't save settings: {e}"))
}

// ── Energy commands ──────────────────────────────────────────────────────────

#[tauri::command]
fn get_energy_snapshot(mon: tauri::State<monitor::Monitor>) -> Option<monitor::Snapshot> {
    mon.latest()
}

#[tauri::command]
fn get_history(mon: tauri::State<monitor::Monitor>) -> Vec<history::Entry> {
    mon.history()
}

/// `None` for either value = back to the device-class default.
#[tauri::command]
fn set_energy_params(
    app: AppHandle,
    mon: tauri::State<monitor::Monitor>,
    idle: Option<f64>,
    max: Option<f64>,
) -> Result<energy_model::Params, String> {
    let d = energy_model::defaults(mon.class());
    energy_model::validate(energy_model::Params { idle: idle.unwrap_or(d.idle), max: max.unwrap_or(d.max) })?;
    let path = settings_path(&app);
    let mut s = settings::load(&path);
    s.energy_idle_w = idle;
    s.energy_max_w = max;
    settings::save(&path, &s).map_err(|e| format!("Couldn't save settings: {e}"))?;
    Ok(energy_model::resolve(mon.class(), idle, max))
}

// ── Debug panel ──────────────────────────────────────────────────────────────

fn debug_wanted(app: &AppHandle) -> bool {
    std::env::var("ECOPROMPT_DEBUG").map(|v| v == "1").unwrap_or(false)
        || settings::load(&settings_path(app)).debug_logging
}

/// The logger is built at Debug; this global max level is what actually gates it,
/// so it can be flipped at runtime.
fn apply_log_level(debug: bool) {
    log::set_max_level(if debug { log::LevelFilter::Debug } else { log::LevelFilter::Info });
}

#[tauri::command]
fn set_debug_logging(app: AppHandle, enabled: bool) -> Result<(), String> {
    let path = settings_path(&app);
    let mut s = settings::load(&path);
    s.debug_logging = enabled;
    settings::save(&path, &s).map_err(|e| format!("Couldn't save settings: {e}"))?;
    apply_log_level(debug_wanted(&app));
    log::info!("debug logging {}", if enabled { "on" } else { "off" });
    Ok(())
}

fn tail_lines(text: &str, n: usize) -> Vec<String> {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(n)..].iter().map(|l| l.to_string()).collect()
}

/// Everything the debug panel shows, as JSON. Never contains prompts or clipboard text.
#[tauri::command]
fn get_diagnostics(app: AppHandle, mon: tauri::State<monitor::Monitor>) -> serde_json::Value {
    let log_dir = app.path().app_log_dir().ok();
    let log_tail = log_dir
        .as_ref()
        .and_then(|d| std::fs::read_to_string(d.join(format!("{}.log", app.package_info().name))).ok())
        .map(|t| tail_lines(&t, 20))
        .unwrap_or_default();
    let class = mon.class();
    let s = settings::load(&settings_path(&app));
    let latest = mon.latest();
    json!({
        "app_version": app.package_info().version.to_string(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "device_class": class,
        "energy_model": {
            "in_use": energy_model::resolve(class, s.energy_idle_w, s.energy_max_w),
            "defaults": energy_model::defaults(class),
            "sample_interval_s": energy_model::SAMPLE_INTERVAL_S,
            "max_sane_watts": energy_model::MAX_SANE_WATTS,
            "user_override": { "idle": s.energy_idle_w, "max": s.energy_max_w },
        },
        "debug_logging": debug_wanted(&app),
        "shortcut": s.shortcut,
        "own_cpu_pct": latest.as_ref().map(|l| l.own_cpu_pct),
        "own_cpu_avg_pct": latest.as_ref().map(|l| l.own_cpu_avg_pct),
        "battery_raw": battery::raw_reading(),
        "raw_samples": mon.raw_samples(),
        "log_dir": log_dir.map(|d| d.display().to_string()),
        "log_tail": log_tail,
    })
}

/// Opens a save dialog and writes the history as JSON. Returns the chosen path,
/// or None if the user cancelled.
#[tauri::command]
async fn export_history(app: AppHandle, mon: tauri::State<'_, monitor::Monitor>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(path) = app
        .dialog()
        .file()
        .set_file_name("ecoprompt-history.json")
        .add_filter("JSON", &["json"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let json = serde_json::to_vec_pretty(&mon.history()).map_err(|e| e.to_string())?;
    fsutil::write_atomic(&path, &json).map_err(|e| format!("Couldn't write the file: {e}"))?;
    Ok(Some(path.display().to_string()))
}

// ── Tray ─────────────────────────────────────────────────────────────────────

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open EcoPrompt", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "Quick optimize clipboard", true, None::<&str>)?;
    let undo = MenuItem::with_id(app, "undo", "Undo last quick optimize", true, None::<&str>)?;
    let login = CheckMenuItem::with_id(
        app,
        "login",
        "Start at login",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &quick, &undo, &login, &PredefinedMenuItem::separator(app)?, &quit],
    )?;

    let icon = Image::from_bytes(include_bytes!("../icons/tray/tray-template.png"))?;
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(true) // macOS: monochrome template image
        .tooltip("EcoPrompt")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "quick" => quick_optimize(app),
            "undo" => undo_quick(app.clone(), app.state::<AppState>()),
            "login" => {
                let want = !app.autolaunch().is_enabled().unwrap_or(false);
                let res = if want { app.autolaunch().enable() } else { app.autolaunch().disable() };
                if let Err(e) = res {
                    log::error!("autostart change failed: {}", e);
                }
                let _ = login.set_checked(app.autolaunch().is_enabled().unwrap_or(false));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

// ── App ──────────────────────────────────────────────────────────────────────

// TODO(updater): auto-update needs signing keys (tauri-plugin-updater + a
// minisign keypair). When added, the endpoint is the latest GitHub release of
// arithapar78/ecoprompt: .../releases/latest/download/latest.json
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Debug)
                .max_file_size(1_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        quick_optimize(app);
                    }
                })
                .build(),
        )
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            quick_optimize_result,
            undo_quick,
            get_settings,
            set_shortcut,
            get_energy_snapshot,
            get_history,
            get_diagnostics,
            set_debug_logging,
            set_energy_params,
            export_history
        ])
        .on_window_event(|window, event| {
            // Closing the main window hides it; the app keeps running in the tray.
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    hide_main(window.app_handle());
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            apply_log_level(debug_wanted(&handle));
            let data_dir = handle.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("ecoprompt"));
            app.manage(monitor::Monitor::new(&data_dir));
            monitor::spawn(handle.clone());
            create_toast_window(&handle)?;
            build_tray(&handle)?;

            let accel = settings::load(&settings_path(&handle)).shortcut;
            if let Err(msg) = register_shortcut(&handle, &accel) {
                toast(&handle, &msg, false);
                show_main(&handle);
                let _ = handle.emit_to("main", "shortcut-error", msg);
            }

            if std::env::args().any(|a| a == "--hidden") {
                hide_main(&handle);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Flush buffered history on quit (it is otherwise written once a minute).
            if let tauri::RunEvent::Exit = event {
                if let Some(mon) = app.try_state::<monitor::Monitor>() {
                    mon.flush();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::tail_lines;

    #[test]
    fn tail_returns_last_n_lines() {
        let t = (1..=30).map(|i| format!("l{i}")).collect::<Vec<_>>().join("\n");
        let v = tail_lines(&t, 20);
        assert_eq!((v.len(), v[0].as_str(), v[19].as_str()), (20, "l11", "l30"));
        assert_eq!(tail_lines("a\nb", 20), vec!["a", "b"]);
        assert!(tail_lines("", 20).is_empty());
    }
}
