#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8891}"
TIMEOUT_SECONDS="${WORKER_TIMEOUT_SECONDS:-110}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REQUIREMENTS_FILE="$APP_DIR/requirements.txt"

cd "$APP_DIR"

if ! python3 -c 'import eth_account' >/dev/null 2>&1; then
  echo "eth-account missing; installing Job Pack Python requirements..." >&2
  python3 -m pip install -r "$REQUIREMENTS_FILE"
fi

python3 -c 'import eth_account' >/dev/null

exec python3 santaclawz_real_worker_bridge.py \
  --host "$HOST" \
  --port "$PORT" \
  --timeout-seconds "$TIMEOUT_SECONDS"
