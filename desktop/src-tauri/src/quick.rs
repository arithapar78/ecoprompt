//! Quick-optimize decision logic. Pure functions, no Tauri types, so it is
//! unit-testable. NEVER log clipboard text from here: lengths and counts only.

use std::time::{Duration, Instant};

/// Clipboards longer than this are ignored (characters, not bytes).
pub const MAX_CHARS: usize = 20_000;
/// How long Undo can restore the original clipboard text.
pub const UNDO_WINDOW: Duration = Duration::from_secs(30);

/// Why the clipboard can't be optimized. The string is the toast text.
pub fn classify(clip: Option<&str>) -> Result<&str, String> {
    match clip {
        None => Err("Clipboard has no text to optimize.".into()),
        Some(t) if t.trim().is_empty() => Err("Clipboard is empty.".into()),
        Some(t) if t.chars().count() > MAX_CHARS => Err(format!(
            "Clipboard text is too long (over {} characters).",
            MAX_CHARS
        )),
        Some(t) => Ok(t),
    }
}

/// "CommandOrControl+Shift+E" -> "⌘⇧E" on Mac, "Ctrl+Shift+E" elsewhere.
pub fn pretty_shortcut(accel: &str, mac: bool) -> String {
    let parts: Vec<String> = accel
        .split('+')
        .map(|p| match (p, mac) {
            ("CommandOrControl" | "CmdOrCtrl", true) => "\u{2318}".to_string(),
            ("CommandOrControl" | "CmdOrCtrl", false) => "Ctrl".to_string(),
            ("Command" | "Cmd" | "Super", true) => "\u{2318}".to_string(),
            ("Alt" | "Option", true) => "\u{2325}".to_string(),
            ("Shift", true) => "\u{21E7}".to_string(),
            ("Control" | "Ctrl", true) => "\u{2303}".to_string(),
            (other, _) => other.to_string(),
        })
        .collect();
    if mac { parts.concat() } else { parts.join("+") }
}

/// Shown once, the first time the app is launched.
pub fn welcome_message(accel: &str, mac: bool) -> String {
    format!(
        "EcoPrompt is running in your {}. Copy text, press {}, then paste.",
        if mac { "menu bar" } else { "system tray" },
        pretty_shortcut(accel, mac)
    )
}

/// Shown the first time the main window is closed in a session.
pub fn close_hint(mac: bool, dock_visible: bool) -> String {
    if mac && dock_visible {
        "EcoPrompt is still running. Click its Dock or menu bar icon to reopen.".to_string()
    } else {
        format!(
            "EcoPrompt is still running in the {}. Click its icon to reopen or quit.",
            if mac { "menu bar" } else { "system tray" }
        )
    }
}

/// Log lines for quick-optimize. They take the text only to COUNT it: lengths and
/// token counts go in the log, never the text itself (see the privacy test).
pub fn describe_request(id: u64, text: &str) -> String {
    format!("quick-optimize request {} ({} chars)", id, text.chars().count())
}

pub fn describe_result(id: u64, original: &str, optimized: &str, tokens_saved: u32) -> String {
    format!(
        "quick-optimize result {}: {} -> {} chars, {} tokens saved",
        id,
        original.chars().count(),
        optimized.chars().count(),
        tokens_saved
    )
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// Optimizer changed nothing: leave the clipboard alone.
    AlreadyLean,
    /// Write `optimized` to the clipboard and show `message`.
    Replace { message: String },
}

pub fn decide(original: &str, optimized: &str, tokens_saved: u32, percent: u32) -> Outcome {
    if optimized == original || optimized.trim().is_empty() {
        Outcome::AlreadyLean
    } else {
        Outcome::Replace {
            message: format!(
                "Optimized: {} tokens saved ({}%). Paste to use.",
                tokens_saved, percent
            ),
        }
    }
}

/// Holds the original clipboard text so Undo can restore it.
#[derive(Default)]
pub struct UndoSlot {
    entry: Option<(String, Instant)>,
}

impl UndoSlot {
    pub fn store(&mut self, original: String, now: Instant) {
        self.entry = Some((original, now));
    }

    /// Returns the original if still within the window. Always clears the slot.
    pub fn take_fresh(&mut self, now: Instant) -> Option<String> {
        let (text, at) = self.entry.take()?;
        (now.duration_since(at) <= UNDO_WINDOW).then_some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_and_messages_read_naturally() {
        assert_eq!(pretty_shortcut("CommandOrControl+Shift+E", true), "\u{2318}\u{21E7}E");
        assert_eq!(pretty_shortcut("CommandOrControl+Shift+E", false), "Ctrl+Shift+E");
        assert_eq!(pretty_shortcut("Alt+Shift+O", true), "\u{2325}\u{21E7}O");
        assert_eq!(pretty_shortcut("CommandOrControl+F5", false), "Ctrl+F5");
        assert_eq!(
            welcome_message("CommandOrControl+Shift+E", true),
            "EcoPrompt is running in your menu bar. Copy text, press \u{2318}\u{21E7}E, then paste."
        );
        assert!(welcome_message("CommandOrControl+Shift+E", false).contains("system tray"));
        assert!(close_hint(true, false).contains("menu bar") && close_hint(false, false).contains("system tray"));
        assert!(close_hint(true, true).contains("Dock"));
        // Dock wording only applies on a Mac.
        assert!(!close_hint(false, true).contains("Dock"));
    }

    #[test]
    fn log_lines_never_contain_the_clipboard_text() {
        let original = "CANARY-secret-prompt-9f3a please summarize my private notes";
        let optimized = "CANARY-secret-prompt-9f3a summarize private notes";
        let lines = [
            describe_request(7, original),
            describe_result(7, original, optimized, 4),
            classify(Some(&"x".repeat(MAX_CHARS + 1))).unwrap_err(),
            classify(Some("   ")).unwrap_err(),
        ];
        for line in lines {
            assert!(!line.contains("CANARY"), "log line leaked text: {line}");
            assert!(!line.contains("private notes"), "log line leaked text: {line}");
        }
        assert_eq!(describe_request(7, "héllo"), "quick-optimize request 7 (5 chars)");
    }

    #[test]
    fn classify_rejects_missing_empty_and_long() {
        assert!(classify(None).is_err());
        assert!(classify(Some("")).is_err());
        assert!(classify(Some("  \n\t ")).is_err());
        let long = "a".repeat(MAX_CHARS + 1);
        assert!(classify(Some(&long)).unwrap_err().contains("too long"));
        let ok = "a".repeat(MAX_CHARS);
        assert!(classify(Some(&ok)).is_ok());
    }

    #[test]
    fn classify_counts_chars_not_bytes() {
        // 20,000 two-byte chars = 40,000 bytes but exactly at the limit.
        let s = "é".repeat(MAX_CHARS);
        assert!(classify(Some(&s)).is_ok());
    }

    #[test]
    fn decide_already_lean_when_unchanged() {
        assert_eq!(decide("Sort list.", "Sort list.", 0, 0), Outcome::AlreadyLean);
        assert_eq!(decide("x", "  ", 1, 100), Outcome::AlreadyLean);
    }

    #[test]
    fn decide_replace_message() {
        assert_eq!(
            decide("long text", "short", 42, 31),
            Outcome::Replace { message: "Optimized: 42 tokens saved (31%). Paste to use.".into() }
        );
    }

    #[test]
    fn undo_restores_within_window_only() {
        let t0 = Instant::now();
        let mut s = UndoSlot::default();
        s.store("orig".into(), t0);
        assert_eq!(s.take_fresh(t0 + Duration::from_secs(29)).as_deref(), Some("orig"));
        // Taken once: gone.
        assert_eq!(s.take_fresh(t0 + Duration::from_secs(29)), None);

        s.store("orig".into(), t0);
        assert_eq!(s.take_fresh(t0 + Duration::from_secs(31)), None);
    }
}
