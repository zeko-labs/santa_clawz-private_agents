#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8892}"
TIMEOUT_SECONDS="${WORKER_TIMEOUT_SECONDS:-45}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$APP_DIR"

exec python3 santaclawz_real_worker_bridge.py \
  --host "$HOST" \
  --port "$PORT" \
  --timeout-seconds "$TIMEOUT_SECONDS"
