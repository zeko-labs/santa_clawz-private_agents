#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8891}"
TIMEOUT_SECONDS="${WORKER_TIMEOUT_SECONDS:-110}"

exec python3 santaclawz_real_worker_bridge.py \
  --host "$HOST" \
  --port "$PORT" \
  --timeout-seconds "$TIMEOUT_SECONDS"
