//! System energy monitor: samples CPU every 30 s, estimates watts per app group
//! (see energy_model.rs), keeps history in memory, and flushes to disk at most
//! once per minute and on quit.
//!
//! Cost discipline: only CPU + the process list are refreshed (no disks,
//! networks or components). The first reading after startup is discarded for
//! history; CPU usage is the average since the previous refresh.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, Manager};

use crate::ai_apps::{self, Kind};
use crate::battery;
use crate::energy_model::{self as model, DeviceClass, Params, SAMPLE_INTERVAL_S};
use crate::history::{self, AppWatts, Entry, Store};

const FLUSH_EVERY: Duration = Duration::from_secs(60);
/// Wait before the first (display-only) reading so CPU deltas are meaningful.
const WARMUP: Duration = Duration::from_secs(2);

#[derive(Serialize, Clone, Debug)]
pub struct AppRow {
    pub group: String,
    pub watts: f64,
    pub kind: Kind,
}

#[derive(Serialize, Clone, Debug)]
pub struct Snapshot {
    pub ts: i64,
    pub system_watts: f64,
    pub cpu_pct: f64,
    pub device_class: DeviceClass,
    pub params: Params,
    pub top_apps: Vec<AppRow>,
    pub ai_watts_now: f64,
    pub browser_watts_now: f64,
    pub today_wh: f64,
    pub ai_today_wh: f64,
    pub browser_today_wh: f64,
    /// Real draw from the battery (Mac laptop, discharging), if available.
    pub battery_watts: Option<f64>,
    pub own_cpu_pct: f64,
    pub own_cpu_avg_pct: f64,
    /// True for the display-only first reading (not stored in history).
    pub warmup: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct RawProc {
    pub name: String,
    pub cpu_pct: f64,
}

/// One sampling tick as measured, for the debug panel. No prompt or clipboard data.
#[derive(Serialize, Clone, Debug)]
pub struct RawSample {
    pub ts: i64,
    pub total_cpu_pct: f64,
    pub watts: f64,
    pub top_processes: Vec<RawProc>,
    pub battery_watts: Option<f64>,
    pub stored: bool,
}

const RAW_KEEP: usize = 10;

pub struct Monitor {
    pub raw: Mutex<std::collections::VecDeque<RawSample>>,
    pub store: Mutex<Store>,
    latest: Mutex<Option<Snapshot>>,
    class: DeviceClass,
    last_flush: Mutex<Instant>,
    own_cpu: Mutex<(f64, u64)>, // (sum of % readings, count)
}

impl Monitor {
    pub fn new(dir: &std::path::Path) -> Self {
        let class = battery::detect_device_class();
        log::info!("device class: {:?}", class);
        Self {
            raw: Mutex::new(std::collections::VecDeque::new()),
            store: Mutex::new(Store::load(dir)),
            latest: Mutex::new(None),
            class,
            last_flush: Mutex::new(Instant::now()),
            own_cpu: Mutex::new((0.0, 0)),
        }
    }

    pub fn class(&self) -> DeviceClass {
        self.class
    }

    pub fn latest(&self) -> Option<Snapshot> {
        self.latest.lock().unwrap().clone()
    }

    pub fn raw_samples(&self) -> Vec<RawSample> {
        self.raw.lock().unwrap().iter().cloned().collect()
    }

    pub fn history(&self) -> Vec<Entry> {
        self.store.lock().unwrap().ring.to_vec()
    }

    pub fn flush(&self) {
        match self.store.lock().unwrap().flush() {
            Ok(()) => *self.last_flush.lock().unwrap() = Instant::now(),
            Err(e) => log::error!("history flush failed: {e}"),
        }
    }

    fn maybe_flush(&self) {
        if self.last_flush.lock().unwrap().elapsed() >= FLUSH_EVERY {
            self.flush();
        }
    }
}

fn day_key(ts_ms: i64) -> String {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_millis_opt(ts_ms)
        .single()
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "unknown".into())
}

fn sum_by_kind(rows: &[(String, f64)], kind: Kind) -> f64 {
    rows.iter().filter(|(g, _)| ai_apps::kind_of_group(g) == kind).map(|(_, v)| v).sum()
}

fn take_sample(app: &AppHandle, mon: &Monitor, sys: &mut System, own_pid: Option<sysinfo::Pid>, store: bool) {
    sys.refresh_cpu_usage();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cpu());

    let util = sys.global_cpu_usage() as f64 / 100.0;
    let procs: Vec<(String, f64)> = sys
        .processes()
        .values()
        .map(|p| (p.name().to_string_lossy().into_owned(), p.cpu_usage() as f64))
        .collect();
    let mut groups = ai_apps::aggregate(procs.iter().map(|(n, c)| (n.as_str(), *c)));
    // Total CPU the OS reports, in the same units as per-process % (100 = one core).
    let ncpu = sys.cpus().len().max(1) as f64;
    ai_apps::add_unattributed(&mut groups, util * ncpu * 100.0);
    let total_cpu: f64 = groups.iter().map(|g| g.cpu).sum();

    let settings = crate::settings::load(&crate::settings_path(app));
    let params = model::resolve(mon.class, settings.energy_idle_w, settings.energy_max_w);
    let system_watts = model::system_watts(util, params);
    if system_watts > model::MAX_SANE_WATTS {
        return;
    }
    let dynamic = model::dynamic_watts(util, params);

    let rows: Vec<AppRow> = groups
        .iter()
        .map(|g| AppRow { group: g.group.clone(), watts: model::app_watts(dynamic, g.cpu, total_cpu), kind: g.kind })
        .collect();

    let own_cpu_pct = own_pid.and_then(|p| sys.process(p)).map(|p| p.cpu_usage() as f64).unwrap_or(0.0);
    let own_avg = {
        let mut o = mon.own_cpu.lock().unwrap();
        if store {
            o.0 += own_cpu_pct;
            o.1 += 1;
        }
        if o.1 == 0 { own_cpu_pct } else { o.0 / o.1 as f64 }
    };

    let battery_watts = battery::measured_watts();
    if let Some(m) = battery_watts {
        log::info!(
            "battery cross-check: measured {:.2} W vs estimate {:.2} W (ratio {:.2}) at cpu {:.1}%",
            m, system_watts, m / system_watts, util * 100.0
        );
    }

    let ts = chrono::Utc::now().timestamp_millis();
    {
        let mut top = procs.clone();
        top.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let mut raw = mon.raw.lock().unwrap();
        raw.push_back(RawSample {
            ts,
            total_cpu_pct: util * 100.0,
            watts: system_watts,
            top_processes: top.into_iter().take(5).map(|(name, cpu_pct)| RawProc { name, cpu_pct }).collect(),
            battery_watts,
            stored: store,
        });
        while raw.len() > RAW_KEEP {
            raw.pop_front();
        }
    }
    let day = day_key(ts);
    let pairs: Vec<(String, f64)> = rows.iter().map(|r| (r.group.clone(), model::wh_for_sample(r.watts))).collect();

    let (today_wh, ai_today_wh, browser_today_wh) = {
        let mut st = mon.store.lock().unwrap();
        if store {
            st.ring.push(Entry {
                ts,
                watts: system_watts,
                site: rows.first().map(|r| r.group.clone()),
                apps: rows.iter().take(5).map(|r| AppWatts { group: r.group.clone(), watts: r.watts }).collect(),
            });
            history::accrue(&mut st.daily, &day, &pairs);
        }
        let d = st.daily.get(&day).cloned().unwrap_or_default();
        let by: Vec<(String, f64)> = d.by_site.into_iter().collect();
        (d.wh_total, sum_by_kind(&by, Kind::Ai), sum_by_kind(&by, Kind::Browser))
    };

    let w: Vec<(String, f64)> = rows.iter().map(|r| (r.group.clone(), r.watts)).collect();
    let snap = Snapshot {
        ts,
        system_watts,
        cpu_pct: util * 100.0,
        device_class: mon.class,
        params,
        ai_watts_now: sum_by_kind(&w, Kind::Ai),
        browser_watts_now: sum_by_kind(&w, Kind::Browser),
        top_apps: rows.into_iter().take(8).collect(),
        today_wh,
        ai_today_wh,
        browser_today_wh,
        battery_watts,
        own_cpu_pct,
        own_cpu_avg_pct: own_avg,
        warmup: !store,
    };
    log::debug!(
        "sample: cpu {:.1}% -> {:.2} W, top {:?}, own cpu {:.2}% (avg {:.2}%)",
        snap.cpu_pct, snap.system_watts, snap.top_apps.first().map(|a| (&a.group, a.watts)), own_cpu_pct, own_avg
    );
    *mon.latest.lock().unwrap() = Some(snap.clone());

    if store {
        mon.maybe_flush();
    }
    // Hidden window: keep sampling, but don't push to the webview.
    let visible = app.get_webview_window("main").and_then(|w| w.is_visible().ok()).unwrap_or(false);
    if visible {
        let _ = app.emit_to("main", "energy-sample", snap);
    }
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mon = app.state::<Monitor>();
        let mut sys = match System::new() {
            Ok(s) => s,
            Err(e) => {
                log::error!("system monitor unavailable: {e}");
                return;
            }
        };
        let own_pid = sysinfo::get_current_pid().ok();
        // Prime: the first CPU reading after startup is always 0.
        sys.refresh_cpu_usage();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cpu());
        std::thread::sleep(WARMUP);
        take_sample(&app, &mon, &mut sys, own_pid, false);
        loop {
            std::thread::sleep(Duration::from_secs(SAMPLE_INTERVAL_S));
            take_sample(&app, &mon, &mut sys, own_pid, true);
        }
    });
}
