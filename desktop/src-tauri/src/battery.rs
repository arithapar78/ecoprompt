//! Device class + (macOS only) the real total system power while on battery.
//! `ioreg -rn AppleSmartBattery` needs no sudo.
//!
//! Preferred source: `PowerTelemetryData.SystemLoad` (milliwatts, total system
//! power). Fallback: voltage x `InstantAmperage`. `InstantAmperage` is a signed
//! value printed as an unsigned 64-bit number (a discharge of -483 mA shows as
//! 18446744073709551133), and it is UNRELIABLE under load: measured reading exactly
//! 0 while the CPU was busy, with the voltage still moving. SystemLoad kept
//! working. Both refresh only every ~10-60 s, and SystemLoad occasionally reads 0
//! (a telemetry miss), which is treated as "no reading".

use crate::energy_model::DeviceClass;

#[derive(Debug, PartialEq, serde::Serialize)]
pub struct Reading {
    pub voltage_mv: f64,
    pub amperage_ma: i64,
    pub external_connected: bool,
    /// `PowerTelemetryData.SystemLoad`, if present and non-zero.
    pub system_load_mw: Option<u64>,
}

impl Reading {
    /// Real total system power in watts, only while running on battery (the case
    /// that has been verified against a real machine).
    pub fn discharge_watts(&self) -> Option<f64> {
        if self.external_connected {
            return None;
        }
        let sane = |w: f64| (w.is_finite() && w > 0.0 && w < crate::energy_model::MAX_SANE_WATTS).then_some(w);
        if let Some(w) = self.system_load_mw.and_then(|mw| sane(mw as f64 / 1000.0)) {
            return Some(w);
        }
        if self.amperage_ma >= 0 {
            return None;
        }
        sane(self.voltage_mv * (-self.amperage_ma) as f64 / 1_000_000.0)
    }
}

/// Only top-level keys (line starts with the key): nested copies such as the
/// ones inside BatteryData sit on one long line and don't match.
fn field<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let prefix = format!("\"{key}\" = ");
    text.lines().find_map(|l| l.trim_start().strip_prefix(prefix.as_str()).map(str::trim))
}

/// `"SystemLoad"=7644` inside the one-line `PowerTelemetryData = {...}` block. The
/// leading quote keeps it from matching `"AccumulatedSystemLoad"=` or
/// `"SystemLoadAccumulatorCount"=`.
fn system_load_mw(text: &str) -> Option<u64> {
    let key = "\"SystemLoad\"=";
    let rest = &text[text.find(key)? + key.len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u64>().ok().filter(|&mw| mw > 0)
}

pub fn parse_ioreg(text: &str) -> Option<Reading> {
    let voltage_mv: f64 = field(text, "Voltage")?.parse().ok()?;
    let raw: u64 = field(text, "InstantAmperage")?.parse().ok()?;
    let external_connected = field(text, "ExternalConnected")? == "Yes";
    Some(Reading { voltage_mv, amperage_ma: raw as i64, external_connected, system_load_mw: system_load_mw(text) })
}

#[cfg(target_os = "macos")]
fn ioreg() -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/ioreg").args(["-rn", "AppleSmartBattery"]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn detect_device_class() -> DeviceClass {
    #[cfg(target_os = "macos")]
    {
        if ioreg().is_some_and(|t| field(&t, "BatteryInstalled") == Some("Yes")) {
            return DeviceClass::Laptop;
        }
    }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
        let mut s: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
        // BatteryFlag 128 = no system battery; 255 = unknown.
        if unsafe { GetSystemPowerStatus(&mut s) } != 0 && s.BatteryFlag != 128 && s.BatteryFlag != 255 {
            return DeviceClass::Laptop;
        }
    }
    #[cfg(target_os = "linux")]
    {
        if std::fs::read_dir("/sys/class/power_supply")
            .map(|d| d.flatten().any(|e| e.file_name().to_string_lossy().starts_with("BAT")))
            .unwrap_or(false)
        {
            return DeviceClass::Laptop;
        }
    }
    DeviceClass::Desktop
}

/// Raw battery numbers for the debug panel (Mac laptops only).
pub fn raw_reading() -> Option<Reading> {
    #[cfg(target_os = "macos")]
    {
        return parse_ioreg(&ioreg()?);
    }
    #[allow(unreachable_code)]
    None
}

/// Measured total watts, if this is a Mac laptop currently discharging.
pub fn measured_watts() -> Option<f64> {
    #[cfg(target_os = "macos")]
    {
        let text = ioreg()?;
        return match parse_ioreg(&text) {
            Some(r) => r.discharge_watts(),
            None => {
                static ONCE: std::sync::Once = std::sync::Once::new();
                ONCE.call_once(|| log::warn!("could not parse ioreg battery output; cross-check hidden"));
                None
            }
        };
    }
    #[allow(unreachable_code)]
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
    +-o AppleSmartBattery  <class AppleSmartBattery>
    {
      "BatteryData" = {"CellVoltage"=(4036,4035,4036),"Voltage"=12113,"X"=1}
      "ExternalConnected" = No
      "InstantAmperage" = 18446744073709551133
      "BatteryInstalled" = Yes
      "Voltage" = 12108
      "PowerTelemetryData" = {"AccumulatedSystemLoad"=335138207,"SystemLoad"=7644,"SystemLoadAccumulatorCount"=146030,"BatteryPower"=18446744073709543972}
    }"#;

    #[test]
    fn parses_signed_amperage_and_top_level_voltage_only() {
        let r = parse_ioreg(SAMPLE).unwrap();
        assert_eq!(r.voltage_mv, 12108.0); // not the nested 12113
        assert_eq!(r.amperage_ma, -483);
        assert!(!r.external_connected);
        assert_eq!(r.system_load_mw, Some(7644)); // not the accumulator or its count
        // SystemLoad is preferred over voltage x amperage (which would give 5.85 W).
        assert!((r.discharge_watts().unwrap() - 7.644).abs() < 1e-9);
        assert_eq!(field(SAMPLE, "BatteryInstalled"), Some("Yes"));
    }

    fn reading(amperage_ma: i64, external_connected: bool, system_load_mw: Option<u64>) -> Reading {
        Reading { voltage_mv: 12000.0, amperage_ma, external_connected, system_load_mw }
    }

    #[test]
    fn no_reading_when_plugged_in_or_charging() {
        assert_eq!(reading(-500, true, Some(9000)).discharge_watts(), None);
        assert_eq!(reading(800, false, None).discharge_watts(), None);
    }

    #[test]
    fn works_when_amperage_reads_zero_under_load() {
        // Observed on a real MacBook: InstantAmperage = 0 while all cores were busy.
        let r = reading(0, false, Some(24_300));
        assert!((r.discharge_watts().unwrap() - 24.3).abs() < 1e-9);
    }

    #[test]
    fn zero_or_missing_system_load_falls_back_to_amperage() {
        let w = reading(-500, false, None).discharge_watts().unwrap();
        assert!((w - 6.0).abs() < 1e-9); // 12 V x 0.5 A
        assert_eq!(reading(-500, false, Some(0)).discharge_watts(), reading(-500, false, None).discharge_watts());
        assert_eq!(reading(0, false, None).discharge_watts(), None);
    }

    #[test]
    fn system_load_key_does_not_match_look_alikes() {
        assert_eq!(system_load_mw("\"AccumulatedSystemLoad\"=999,\"SystemLoadAccumulatorCount\"=5"), None);
        assert_eq!(system_load_mw("\"SystemLoad\"=0,"), None);
        assert_eq!(system_load_mw("\"SystemLoad\"=1234}"), Some(1234));
    }

    #[test]
    fn garbage_input_gives_none() {
        assert_eq!(parse_ioreg("nothing here"), None);
        assert_eq!(parse_ioreg("\"Voltage\" = abc\n\"InstantAmperage\" = 1\n\"ExternalConnected\" = No"), None);
    }
}
