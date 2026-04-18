#!/usr/bin/env bash
# Export all Tiled .tmj maps to the Bomberman JSON format + public/maps/.
#
# Usage:
#   ./export-maps.sh                 # all .tmj files in src/shared/maps/
#   ./export-maps.sh main_map        # just main_map.tmj (name without extension)
#   ./export-maps.sh main_map custom_map1   # multiple by name
#
# Each run invokes: npx tsx tools/tiled-to-roombov.ts <path>

set -euo pipefail

MAPS_DIR="src/shared/maps"
CONVERTER="tools/tiled-to-roombov.ts"

if [[ ! -f "$CONVERTER" ]]; then
  echo "error: converter not found at $CONVERTER — run from repo root" >&2
  exit 1
fi

# Build the list of .tmj files to process.
targets=()
if [[ $# -eq 0 ]]; then
  # No args — pick up every .tmj in MAPS_DIR.
  while IFS= read -r -d '' f; do
    targets+=("$f")
  done < <(find "$MAPS_DIR" -maxdepth 1 -name '*.tmj' -print0)
else
  for name in "$@"; do
    # Accept either "main_map" or "src/shared/maps/main_map.tmj".
    if [[ -f "$name" ]]; then
      targets+=("$name")
    elif [[ -f "$MAPS_DIR/${name}.tmj" ]]; then
      targets+=("$MAPS_DIR/${name}.tmj")
    else
      echo "error: cannot find '$name' or '$MAPS_DIR/${name}.tmj'" >&2
      exit 1
    fi
  done
fi

if [[ ${#targets[@]} -eq 0 ]]; then
  echo "no .tmj files found in $MAPS_DIR"
  exit 0
fi

echo "exporting ${#targets[@]} map(s):"
for tmj in "${targets[@]}"; do
  echo "  → $tmj"
  npx tsx "$CONVERTER" "$tmj"
done

echo "done."
