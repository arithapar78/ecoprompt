#!/bin/bash
# Measures this Mac's real total system power at several CPU load levels, so the
# energy model constants in src-tauri/src/energy_model.rs can be checked or re-tuned.
#
# macOS laptops only. MUST run on battery (unplug first). Takes about 9 minutes and
# pins the CPU, so don't use the machine meanwhile. No sudo needed.
#
# Usage:  scripts/calibrate-energy.sh [output.csv]
# Then see docs/ENERGY-CALIBRATION.md for how to read the result.
set -u
OUT="${1:-energy-calibration.csv}"

if [ "$(uname)" != "Darwin" ]; then echo "macOS only."; exit 1; fi
if ! ioreg -rn AppleSmartBattery | grep -q '"BatteryInstalled" = Yes'; then echo "No battery found: laptops only."; exit 1; fi
if ioreg -rn AppleSmartBattery | grep -q '"ExternalConnected" = Yes'; then echo "Unplug the charger and run again (must run on battery)."; exit 1; fi
command -v openssl >/dev/null || { echo "openssl not found."; exit 1; }

NCPU=$(sysctl -n hw.ncpu)
LEVELS="0 $((NCPU/6)) $((NCPU/3)) $((NCPU/2)) $((NCPU*3/4)) $NCPU"
echo "Cores: $NCPU. Load levels (workers): $LEVELS. Output: $OUT"
echo "level,t,util_pct,systemload_mw,external" > "$OUT"

cleanup() { pkill -x openssl 2>/dev/null; }
trap cleanup EXIT INT TERM

# SystemLoad (mW) is the SMC's total system power; it updates only every ~10-60 s,
# and sometimes reads 0 (ignore zeros when analysing).
read_power() { ioreg -rn AppleSmartBattery | awk '
  /"SystemLoad"=/ { match($0, /"SystemLoad"=[0-9]+/); s=substr($0,RSTART,RLENGTH); sub(/.*=/,"",s); v=s }
  /^ *"ExternalConnected" =/ { e=$3 }
  END { printf "%s,%s", v, e }'; }

for N in $LEVELS; do
  echo "level: $N workers"
  # SIMD-heavy work. (A trivial loop like `yes` draws far less power at the same CPU%.)
  for i in $(seq 1 "$N"); do ( openssl speed -evp sha256 -bytes 8192 -seconds 80 >/dev/null 2>&1 & ); done
  sleep 20   # let the telemetry catch up
  for k in $(seq 1 18); do
    util=$(top -l 2 -s 1 -n 0 | grep "CPU usage" | tail -1 | awk '{gsub("%","",$3); gsub("%","",$5); print $3+$5}')
    echo "$N,$k,$util,$(read_power)" >> "$OUT"
    sleep 2
  done
  cleanup; sleep 25   # cool-down
done
echo "Done: $OUT"
