//! Energy model. ALL tunable numbers live in this file.
//!
//! Neither macOS nor Windows exposes per-app watts without admin rights
//! (`powermetrics` needs sudo), so v0.1 ESTIMATES:
//!
//!   system_watts  = P_idle + cpu_util * (P_max - P_idle)         cpu_util in 0..1
//!   dynamic_watts = cpu_util * (P_max - P_idle)
//!   app_watts     = dynamic_watts * (app_cpu / total_cpu)        idle is NOT attributed to apps
//!   Wh per sample = watts * SAMPLE_INTERVAL_S / 3600             (`wh_for_sample`, the only place)
//!
//! `cpu_util` is total CPU utilization; `app_cpu` / `total_cpu` are the sums of
//! per-process CPU% for that app / for all processes.
//!
//! These are rough, device-class-level figures, not measurements. The UI labels
//! them "estimate". On a Mac laptop on battery the app also reads the real
//! total system power (see `battery.rs`) and logs measured/estimate so the
//! constants can be re-tuned (see docs/ENERGY-CALIBRATION.md).

/// Sampling period. MUST match the extension's `REPORT_PERIOD_MS` (30000 ms)
/// and `SAMPLE_INTERVAL_S` in extension/lib/storage.js.
pub const SAMPLE_INTERVAL_S: u64 = 30;

/// Readings above this are dropped as nonsense. Same as the extension's
/// `MAX_SANE_WATTS`.
pub const MAX_SANE_WATTS: f64 = 2000.0;

/// Laptop defaults. Source: CALIBRATED ON ONE MACHINE, a MacBook Pro 14" (Mac15,7,
/// 12-core M3 Pro, display on) running on battery, 2026-11-27. Total system power
/// came from the SMC's `PowerTelemetryData.SystemLoad` while holding 0..12 SIMD-heavy
/// workers (`desktop/scripts/calibrate-energy.sh`; method and data in
/// `desktop/docs/ENERGY-CALIBRATION.md`). Measured: about 5-6 W at light use
/// (10-15% CPU), about 16 W at 44%, about 24 W at 73% and above. Best fit with a
/// physical idle floor: 5 W idle, 32 W max. That cut the fit error against the old
/// 4 W / 40 W defaults from about 4.5-6.3 W to about 3.2 W on that machine.
///
/// Limits: one machine, so other laptops (thin Intel ultrabooks, big workstations)
/// will differ; and power depends on how hard the work is, not only how busy the
/// CPU is (the same 30-40% utilization measured both 7 W and 16 W), so any
/// utilization-only model carries a few watts of error. Users can override both
/// numbers in Settings.
pub const LAPTOP_IDLE_W: f64 = 5.0;
pub const LAPTOP_MAX_W: f64 = 32.0;

/// Desktop defaults. Source: the Phase 3 build spec (typical mid-range tower
/// without a heavy GPU load; not measured here).
pub const DESKTOP_IDLE_W: f64 = 30.0;
pub const DESKTOP_MAX_W: f64 = 150.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceClass {
    Laptop,
    Desktop,
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct Params {
    pub idle: f64,
    pub max: f64,
}

pub fn defaults(class: DeviceClass) -> Params {
    match class {
        DeviceClass::Laptop => Params { idle: LAPTOP_IDLE_W, max: LAPTOP_MAX_W },
        DeviceClass::Desktop => Params { idle: DESKTOP_IDLE_W, max: DESKTOP_MAX_W },
    }
}

/// Settings may override either constant. Invalid combos fall back to defaults.
pub fn resolve(class: DeviceClass, idle: Option<f64>, max: Option<f64>) -> Params {
    let d = defaults(class);
    let p = Params { idle: idle.unwrap_or(d.idle), max: max.unwrap_or(d.max) };
    if validate(p).is_ok() { p } else { d }
}

pub fn validate(p: Params) -> Result<(), String> {
    if !(p.idle.is_finite() && p.max.is_finite()) || p.idle < 0.0 {
        return Err("Watts must be positive numbers.".into());
    }
    if p.max <= p.idle {
        return Err("Max watts must be greater than idle watts.".into());
    }
    if p.max > MAX_SANE_WATTS {
        return Err(format!("Max watts can't exceed {MAX_SANE_WATTS}."));
    }
    Ok(())
}

fn clamp_util(u: f64) -> f64 {
    if u.is_finite() { u.clamp(0.0, 1.0) } else { 0.0 }
}

pub fn system_watts(cpu_util: f64, p: Params) -> f64 {
    p.idle + dynamic_watts(cpu_util, p)
}

pub fn dynamic_watts(cpu_util: f64, p: Params) -> f64 {
    clamp_util(cpu_util) * (p.max - p.idle)
}

/// An app's share of the dynamic watts. Zero if nothing is using the CPU.
pub fn app_watts(dynamic: f64, app_cpu: f64, total_cpu: f64) -> f64 {
    if total_cpu <= 0.0 || !app_cpu.is_finite() { 0.0 } else { dynamic * (app_cpu / total_cpu).clamp(0.0, 1.0) }
}

/// The ONLY watts -> Wh conversion in the app.
pub fn wh_for_sample(watts: f64) -> f64 {
    watts * SAMPLE_INTERVAL_S as f64 / 3600.0
}

#[cfg(test)]
mod tests {
    use super::*;

    const L: Params = Params { idle: 4.0, max: 40.0 };

    #[test]
    fn system_watts_endpoints_and_midpoint() {
        assert_eq!(system_watts(0.0, L), 4.0);
        assert_eq!(system_watts(1.0, L), 40.0);
        assert_eq!(system_watts(0.5, L), 22.0);
    }

    #[test]
    fn utilization_is_clamped_and_nan_safe() {
        assert_eq!(system_watts(-1.0, L), 4.0);
        assert_eq!(system_watts(7.0, L), 40.0);
        assert_eq!(system_watts(f64::NAN, L), 4.0);
    }

    #[test]
    fn app_share_excludes_idle_and_sums_to_dynamic() {
        let dynamic = dynamic_watts(0.5, L); // 18 W
        let a = app_watts(dynamic, 150.0, 200.0);
        let b = app_watts(dynamic, 50.0, 200.0);
        assert!((a - 13.5).abs() < 1e-9);
        assert!((b - 4.5).abs() < 1e-9);
        assert!((a + b - dynamic).abs() < 1e-9);
        assert_eq!(app_watts(dynamic, 10.0, 0.0), 0.0);
    }

    #[test]
    fn wh_conversion() {
        // 120 W for 30 s = 1 Wh.
        assert!((wh_for_sample(120.0) - 1.0).abs() < 1e-12);
        assert_eq!(wh_for_sample(0.0), 0.0);
    }

    #[test]
    fn defaults_per_class_and_resolve_fallback() {
        assert_eq!(defaults(DeviceClass::Laptop), Params { idle: 5.0, max: 32.0 });
        assert_eq!(defaults(DeviceClass::Desktop), Params { idle: 30.0, max: 150.0 });
        assert_eq!(resolve(DeviceClass::Laptop, Some(5.0), Some(60.0)), Params { idle: 5.0, max: 60.0 });
        // max <= idle is rejected -> defaults
        assert_eq!(resolve(DeviceClass::Laptop, Some(50.0), Some(10.0)), defaults(DeviceClass::Laptop));
        assert!(validate(Params { idle: 1.0, max: 5000.0 }).is_err());
    }
}
