//! History ring buffer + daily rollup. Same shapes as the extension
//! (extension/lib/storage.js) so the two can be synced later:
//!   history entry: { ts (ms), watts, site }  + desktop-only `apps` (top 5)
//!   daily[YYYY-MM-DD]: { whTotal, bySite: { group: Wh } }
//! Everything lives in memory; `Store::flush` writes atomically (see fsutil).

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::fsutil::write_atomic;

/// 24 h at 30 s sampling. Same as the extension's `MAX_ENTRIES`.
pub const MAX_ENTRIES: usize = 2880;
/// Daily rollup retention.
pub const DAILY_DAYS: usize = 90;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AppWatts {
    pub group: String,
    pub watts: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    pub ts: i64,
    pub watts: f64,
    pub site: Option<String>,
    #[serde(default)]
    pub apps: Vec<AppWatts>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Day {
    #[serde(rename = "whTotal")]
    pub wh_total: f64,
    #[serde(rename = "bySite")]
    pub by_site: BTreeMap<String, f64>,
}

pub type Daily = BTreeMap<String, Day>;

/// Fixed-capacity buffer: oldest entries drop first.
#[derive(Debug, Default)]
pub struct Ring {
    cap: usize,
    items: VecDeque<Entry>,
}

impl Ring {
    #[cfg(test)]
    pub fn new(cap: usize) -> Self {
        Self { cap, items: VecDeque::new() }
    }
    pub fn from_vec(cap: usize, mut v: Vec<Entry>) -> Self {
        if v.len() > cap {
            v.drain(..v.len() - cap);
        }
        Self { cap, items: v.into() }
    }
    pub fn push(&mut self, e: Entry) {
        self.items.push_back(e);
        while self.items.len() > self.cap {
            self.items.pop_front();
        }
    }
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.items.len()
    }
    pub fn to_vec(&self) -> Vec<Entry> {
        self.items.iter().cloned().collect()
    }
}

/// Drop rollup days beyond the retention window (keys sort chronologically).
pub fn prune_daily(daily: &mut Daily, keep: usize) {
    while daily.len() > keep {
        let first = daily.keys().next().cloned().unwrap();
        daily.remove(&first);
    }
}

pub fn accrue(daily: &mut Daily, day_key: &str, group_wh: &[(String, f64)]) {
    let day = daily.entry(day_key.to_string()).or_default();
    for (group, wh) in group_wh {
        if wh.is_finite() && *wh > 0.0 {
            day.wh_total += wh;
            *day.by_site.entry(group.clone()).or_insert(0.0) += wh;
        }
    }
    prune_daily(daily, DAILY_DAYS);
}

pub struct Store {
    pub ring: Ring,
    pub daily: Daily,
    history_path: PathBuf,
    daily_path: PathBuf,
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path, what: &str) -> T {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            log::warn!("{what} is unreadable ({e}); starting empty");
            T::default()
        }),
        Err(_) => T::default(),
    }
}

impl Store {
    pub fn load(dir: &Path) -> Self {
        let history_path = dir.join("history.json");
        let daily_path = dir.join("daily.json");
        let entries: Vec<Entry> = read_json(&history_path, "history.json");
        let mut daily: Daily = read_json(&daily_path, "daily.json");
        prune_daily(&mut daily, DAILY_DAYS);
        log::info!("loaded {} history entries, {} daily rows", entries.len(), daily.len());
        Self { ring: Ring::from_vec(MAX_ENTRIES, entries), daily, history_path, daily_path }
    }

    pub fn flush(&self) -> std::io::Result<()> {
        write_atomic(&self.history_path, &serde_json::to_vec(&self.ring.to_vec())?)?;
        write_atomic(&self.daily_path, &serde_json::to_vec(&self.daily)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(ts: i64) -> Entry {
        Entry { ts, watts: 5.0, site: Some("Chrome".into()), apps: vec![] }
    }

    #[test]
    fn ring_buffer_is_capped_and_drops_oldest() {
        let mut r = Ring::new(MAX_ENTRIES);
        for i in 0..(MAX_ENTRIES as i64 + 120) {
            r.push(entry(i));
        }
        assert_eq!(r.len(), MAX_ENTRIES);
        let v = r.to_vec();
        assert_eq!(v.first().unwrap().ts, 120);
        assert_eq!(v.last().unwrap().ts, MAX_ENTRIES as i64 + 119);
    }

    #[test]
    fn loading_an_oversized_file_trims_to_cap() {
        let v: Vec<Entry> = (0..(MAX_ENTRIES as i64 + 10)).map(entry).collect();
        let r = Ring::from_vec(MAX_ENTRIES, v);
        assert_eq!(r.len(), MAX_ENTRIES);
        assert_eq!(r.to_vec()[0].ts, 10);
    }

    #[test]
    fn daily_accrues_and_prunes_to_90_days() {
        let mut d = Daily::new();
        accrue(&mut d, "2026-01-01", &[("Chrome".into(), 1.5), ("Claude".into(), 0.5)]);
        accrue(&mut d, "2026-01-01", &[("Chrome".into(), 1.0)]);
        assert_eq!(d["2026-01-01"].wh_total, 3.0);
        assert_eq!(d["2026-01-01"].by_site["Chrome"], 2.5);
        for i in 0..100 {
            accrue(&mut d, &format!("2026-03-{:02}-{i}", 1), &[("x".into(), 1.0)]);
        }
        assert_eq!(d.len(), DAILY_DAYS);
    }

    #[test]
    fn entry_matches_extension_shape_and_reads_old_files_without_apps() {
        let json = serde_json::to_value(entry(1)).unwrap();
        assert!(json.get("ts").is_some() && json.get("watts").is_some() && json.get("site").is_some());
        let old: Entry = serde_json::from_str(r#"{"ts":1,"watts":2.5,"site":null}"#).unwrap();
        assert!(old.apps.is_empty() && old.site.is_none());
        let day = serde_json::to_value(Day::default()).unwrap();
        assert!(day.get("whTotal").is_some() && day.get("bySite").is_some());
    }

    #[test]
    fn flush_then_load_roundtrips_and_survives_a_stale_temp_file() {
        let dir = std::env::temp_dir().join(format!("eco-hist-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut s = Store::load(&dir);
        s.ring.push(entry(42));
        accrue(&mut s.daily, "2026-02-02", &[("Arc".into(), 2.0)]);
        s.flush().unwrap();
        // A crash mid-flush would leave a truncated temp file; it must not matter.
        std::fs::write(dir.join("history.json.tmp"), b"[{\"ts\":").unwrap();
        let again = Store::load(&dir);
        assert_eq!(again.ring.to_vec(), vec![entry(42)]);
        assert_eq!(again.daily["2026-02-02"].by_site["Arc"], 2.0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_history_starts_empty_instead_of_crashing() {
        let dir = std::env::temp_dir().join(format!("eco-hist-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("history.json"), b"{nope").unwrap();
        assert_eq!(Store::load(&dir).ring.len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
