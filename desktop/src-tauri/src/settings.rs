//! Small JSON settings file in the OS config dir (no network, no telemetry).

use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

pub const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+E";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Settings {
    pub shortcut: String,
    /// Energy model overrides; None = device-class default.
    pub energy_idle_w: Option<f64>,
    pub energy_max_w: Option<f64>,
    /// Verbose logging (also forced on by ECOPROMPT_DEBUG=1). Never logs prompt text.
    pub debug_logging: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { shortcut: DEFAULT_SHORTCUT.into(), energy_idle_w: None, energy_max_w: None, debug_logging: false }
    }
}

pub fn load(path: &Path) -> Settings {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, s: &Settings) -> std::io::Result<()> {
    crate::fsutil::write_atomic(path, &serde_json::to_vec_pretty(s)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_corrupt_file_gives_defaults() {
        let dir = std::env::temp_dir().join(format!("eco-settings-{}", std::process::id()));
        let p = dir.join("settings.json");
        assert_eq!(load(&p), Settings::default());
        fs::create_dir_all(&dir).unwrap();
        fs::write(&p, "{not json").unwrap();
        assert_eq!(load(&p), Settings::default());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn roundtrip() {
        let dir = std::env::temp_dir().join(format!("eco-settings-rt-{}", std::process::id()));
        let p = dir.join("settings.json");
        let s = Settings { shortcut: "Alt+Shift+O".into(), energy_idle_w: Some(5.0), energy_max_w: None, debug_logging: true };
        save(&p, &s).unwrap();
        assert_eq!(load(&p), s);
        assert!(!dir.join("settings.json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
