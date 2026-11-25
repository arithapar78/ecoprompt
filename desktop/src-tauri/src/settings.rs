//! Small JSON settings file in the OS config dir (no network, no telemetry).

use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

pub const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+E";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Settings {
    pub shortcut: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self { shortcut: DEFAULT_SHORTCUT.into() }
    }
}

pub fn load(path: &Path) -> Settings {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Atomic write: temp file in the same dir, then rename.
pub fn save(path: &Path, s: &Settings) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(s)?)?;
    fs::rename(&tmp, path)
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
        let s = Settings { shortcut: "Alt+Shift+O".into() };
        save(&p, &s).unwrap();
        assert_eq!(load(&p), s);
        assert!(!p.with_extension("json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
