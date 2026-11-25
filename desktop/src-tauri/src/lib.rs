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
    log::debug!("quick-optimize request {} ({} chars)", id, text.chars().count());
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
    log::debug!(
        "quick-optimize result {}: {} -> {} chars, {} tokens saved",
        id,
        original.chars().count(),
        optimized.chars().count(),
        tokens_saved
    );
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

fn settings_path(app: &AppHandle) -> std::path::PathBuf {
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
    settings::save(&settings_path(&app), &settings::Settings { shortcut: accelerator })
        .map_err(|e| format!("Couldn't save settings: {e}"))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let debug = std::env::var("ECOPROMPT_DEBUG").map(|v| v == "1").unwrap_or(false);
    let level = if debug { log::LevelFilter::Debug } else { log::LevelFilter::Info };

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(level)
                .max_file_size(1_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_clipboard_manager::init())
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
            set_shortcut
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
