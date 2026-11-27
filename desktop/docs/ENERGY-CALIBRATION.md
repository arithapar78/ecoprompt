# Energy model calibration

EcoPrompt Desktop **estimates** power; it does not measure it per app. This document records how the laptop defaults in `src-tauri/src/energy_model.rs` were chosen and how to re-check them.

## The model

```
system_watts = P_idle + cpu_util x (P_max - P_idle)
app_watts    = (cpu_util x (P_max - P_idle)) x (app CPU share)     # idle is not attributed to apps
```

## Measuring real power on a Mac laptop (no sudo)

`ioreg -rn AppleSmartBattery` exposes `PowerTelemetryData.SystemLoad` (milliwatts, total system power). Findings from testing on a MacBook Pro 14" (Mac15,7, 12-core M3 Pro):

- `SystemLoad` is the usable source. **`InstantAmperage` reads exactly 0 while the CPU is busy** (the voltage keeps moving), so voltage x amperage fails under load. The app now prefers `SystemLoad` and falls back to amperage.
- Both update only about every 10-60 s, so single readings lag. SystemLoad sometimes reads 0 (a telemetry miss): ignore zeros.
- Verified on battery only. It has not been checked while plugged in, so the app only shows the measured figure on battery.

## Calibration run (2026-11-27)

`scripts/calibrate-energy.sh`: N SIMD-heavy workers (`openssl speed -evp sha256`) per level, readings every ~3 s after a 20 s settle, on battery, display on. Level means, zeros dropped:

| Workers | Busy CPU | Measured system power |
|---:|---:|---:|
| 0 (normal apps) | 14% | 6.0 W |
| 2 | 25% | 5.3 W (lagging reading; see below) |
| 4 | 44% | 16.0 W |
| 6 | 55% | 19.7 W |
| 9 | 73% | 24.3 W |
| 12 | 81% | 23.4 W |

An earlier test with a trivial loop (`yes`) on all 12 cores drew only about 13-15 W at 100% CPU, against about 31 W for a heavy SIMD workload at 100%. **The same CPU percentage can mean 7 W or 16 W depending on how hard the work is**, which no utilization-only model can capture.

## Result

| Defaults | RMS error vs the measurements |
|---|---|
| old: idle 4 W, max 40 W | about 4.5-6.3 W |
| **new: idle 5 W, max 32 W** | **about 3.2 W** |

The unconstrained best straight line has an unphysical idle near 0-1 W (the curve is not linear), so the defaults use the best fit with a physical idle floor.

## Limits (read before trusting the numbers)

- **One machine.** Other laptops (thin Intel ultrabooks, large workstations) will differ. Settings lets users override both numbers.
- Heavy and light work at the same utilization differ by a factor of 2 or more, so expect a few watts of error.
- The 12-worker level only reached 81% busy and the 2-worker point lagged the previous level, so the top of the range is the least certain part.
- Desktop defaults (30 W idle, 150 W max) are still unmeasured spec figures.

## Re-running it

Unplug the charger, then `scripts/calibrate-energy.sh my-mac.csv` (about 9 minutes, pins the CPU). Compare the level means to the table above and adjust `LAPTOP_IDLE_W` / `LAPTOP_MAX_W`.
