//! Device class + (macOS only) the real total draw while on battery.
//! `ioreg -rn AppleSmartBattery` needs no sudo. `InstantAmperage` is a signed
//! value printed as an unsigned 64-bit number, so a discharge of -483 mA shows
//! as 18446744073709551133.

use crate::energy_model::DeviceClass;

#[derive(Debug, PartialEq, serde::Serialize)]
pub struct Reading {
    pub voltage_mv: f64,
    pub amperage_ma: i64,
    pub external_connected: bool,
}

impl Reading {
    /// Real system draw in watts, only while discharging on battery.
    pub fn discharge_watts(&self) -> Option<f64> {
        if self.external_connected || self.amperage_ma >= 0 {
            return None;
        }
        let w = self.voltage_mv * (-self.amperage_ma) as f64 / 1_000_000.0;
        (w.is_finite() && w > 0.0 && w < crate::energy_model::MAX_SANE_WATTS).then_some(w)
    }
}

/// Only top-level keys (line starts with the key): nested copies such as the
/// ones inside BatteryData sit on one long line and don't match.
fn field<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let prefix = format!("\"{key}\" = ");
    text.lines().find_map(|l| l.trim_start().strip_prefix(prefix.as_str()).map(str::trim))
}

pub fn parse_ioreg(text: &str) -> Option<Reading> {
    let voltage_mv: f64 = field(text, "Voltage")?.parse().ok()?;
    let raw: u64 = field(text, "InstantAmperage")?.parse().ok()?;
    let external_connected = field(text, "ExternalConnected")? == "Yes";
    Some(Reading { voltage_mv, amperage_ma: raw as i64, external_connected })
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
    }"#;

    #[test]
    fn parses_signed_amperage_and_top_level_voltage_only() {
        let r = parse_ioreg(SAMPLE).unwrap();
        assert_eq!(r.voltage_mv, 12108.0); // not the nested 12113
        assert_eq!(r.amperage_ma, -483);
        assert!(!r.external_connected);
        let w = r.discharge_watts().unwrap();
        assert!((w - 5.848).abs() < 0.01, "{w}");
        assert_eq!(field(SAMPLE, "BatteryInstalled"), Some("Yes"));
    }

    #[test]
    fn no_reading_when_plugged_in_or_charging() {
        assert_eq!(Reading { voltage_mv: 12000.0, amperage_ma: -500, external_connected: true }.discharge_watts(), None);
        assert_eq!(Reading { voltage_mv: 12000.0, amperage_ma: 800, external_connected: false }.discharge_watts(), None);
    }

    #[test]
    fn garbage_input_gives_none() {
        assert_eq!(parse_ioreg("nothing here"), None);
        assert_eq!(parse_ioreg("\"Voltage\" = abc\n\"InstantAmperage\" = 1\n\"ExternalConnected\" = No"), None);
    }
}
