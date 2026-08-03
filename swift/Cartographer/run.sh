#!/bin/bash
# Launch Cartographer with voice.
#
#   ./run.sh              talk to it (mic)
#   ./run.sh --demo       self-driving: connects and types a seed idea for you
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

[ -n "${COSMO_API_KEY:-}" ] || { echo "set COSMO_API_KEY first"; exit 1; }

[ -d "$ROOT/build/Cartographer.app" ] || "$ROOT/bundle.sh"

if [ "${1:-}" = "--demo" ]; then
  export CARTO_AUTOSTART=1
  export CARTO_SEED="I want to start a small weekend bakery. I'm torn between sourdough bread and laminated pastries. Bread needs a big oven and long overnight proofs, pastry needs a sheeter and a cold room. Money is the real constraint, and I only have Saturdays and Sundays."
fi

exec "$ROOT/build/Cartographer.app/Contents/MacOS/Cartographer"
