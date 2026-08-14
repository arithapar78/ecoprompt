#!/usr/bin/env bash
# perf/measure.sh — median TBT/LCP across N runs, per profile, per page.
#
# Fills in sections 3.1 and 3.2 of BASELINE.md. Single runs are noise; this
# takes the median of RUNS (default 11).
#
# Requires: npx (Node). Lighthouse is fetched on demand by npx.
#
# Usage:
#   perf/measure.sh clean            # clean profile
#   perf/measure.sh ext              # extension profile
#   RUNS=5 perf/measure.sh ext       # fewer runs while iterating
#
# The extension profile must already have extension/ loaded unpacked, and
# Lighthouse must run against that same --user-data-dir.

set -euo pipefail

PROFILE="${1:-clean}"
RUNS="${RUNS:-11}"
OUT="$(cd "$(dirname "$0")" && pwd)/results"
mkdir -p "$OUT"

case "$PROFILE" in
  clean) USER_DIR=/tmp/eco-clean ;;
  ext)   USER_DIR=/tmp/eco-ext ;;
  *) echo "usage: $0 [clean|ext]" >&2; exit 2 ;;
esac

# Page 1 is the reported failure (Google Slides). A signed-out Slides URL still
# exercises the same hydration path; use a real deck URL if you have one.
PAGES=(
  "https://docs.google.com/presentation/"
  "https://chatgpt.com"
  "https://www.theverge.com"
  "https://en.wikipedia.org/wiki/Chrome"
  "https://example.com"
)

# median of stdin numbers
median() { sort -n | awk '{a[NR]=$1} END{ if(NR==0){print "n/a"; exit} print (NR%2) ? a[(NR+1)/2] : (a[NR/2]+a[NR/2+1])/2 }'; }

echo "profile=$PROFILE runs=$RUNS user-data-dir=$USER_DIR"
printf '%-46s %10s %10s\n' "page" "TBT(ms)" "LCP(ms)"

for url in "${PAGES[@]}"; do
  tbts=""; lcps=""
  for i in $(seq 1 "$RUNS"); do
    json="$OUT/$(echo "$url" | tr -c 'a-zA-Z0-9' '_')-$PROFILE-$i.json"
    npx --yes lighthouse "$url" \
      --quiet --output=json --output-path="$json" \
      --only-categories=performance \
      --chrome-flags="--user-data-dir=$USER_DIR --no-first-run --disable-background-networking" \
      >/dev/null 2>&1 || { echo "  run $i failed for $url" >&2; continue; }

    tbts+="$(node -e "const r=require('$json');console.log(r.audits['total-blocking-time'].numericValue)")"$'\n'
    lcps+="$(node -e "const r=require('$json');console.log(r.audits['largest-contentful-paint'].numericValue)")"$'\n'
  done

  mt=$(printf '%s' "$tbts" | grep -v '^$' | median)
  ml=$(printf '%s' "$lcps" | grep -v '^$' | median)
  printf '%-46s %10.0f %10.0f\n' "$url" "$mt" "$ml"
done

echo
echo "Raw reports in $OUT. Paste medians into perf/BASELINE.md §3.1/§3.2."
echo "NOTE: Lighthouse cannot measure the SW lifecycle (§3.5), storage writes"
echo "      (§3.6) or background-tab traffic (§3.7) — do those by hand."
