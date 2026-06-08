#!/usr/bin/env bash
set -euo pipefail

# Example durable local launcher for several enrolled SantaClawz agents.
# Copy this file before editing. Do not commit private env files or logs.

ROOT_DIR="${ROOT_DIR:-$(pwd)}"
AGENT_ENV_DIR="${AGENT_ENV_DIR:-${ROOT_DIR}/.santaclawz-agents}"
RELAY_BASE="${CLAWZ_RELAY_BASE:-https://relay.santaclawz.ai}"
LOG_DIR="${LOG_DIR:-${ROOT_DIR}/.santaclawz-logs}"

mkdir -p "${LOG_DIR}"

# name:env-file:worker-port
AGENTS=(
  "alpha:${AGENT_ENV_DIR}/alpha.env.santaclawz:9041"
  "beta:${AGENT_ENV_DIR}/beta.env.santaclawz:9042"
  "gamma:${AGENT_ENV_DIR}/gamma.env.santaclawz:9043"
  "delta:${AGENT_ENV_DIR}/delta.env.santaclawz:9044"
)

start_agent() {
  local name="$1"
  local env_file="$2"
  local worker_port="$3"
  local worker_session="scz_${name}_worker"
  local relay_session="scz_${name}_relay"

  if [[ ! -f "${env_file}" ]]; then
    echo "missing env file for ${name}: ${env_file}" >&2
    exit 1
  fi

  # Replace this worker command with the agent's actual /hire worker.
  screen -dmS "${worker_session}" bash -lc \
    "cd '${ROOT_DIR}' && echo 'TODO: replace this placeholder with the ${name} worker listening on ${worker_port}' > '${LOG_DIR}/${name}.worker.log'; sleep infinity"

  screen -dmS "${relay_session}" bash -lc \
    "cd '${ROOT_DIR}' && pnpm relay:agent -- --agent-env-file '${env_file}' --relay-base '${RELAY_BASE}' --local-hire-url 'http://127.0.0.1:${worker_port}/hire' --takeover > '${LOG_DIR}/${name}.relay.log' 2>&1"

  echo "started ${name}: worker session ${worker_session}, relay session ${relay_session}"
}

stop_agent() {
  local name="$1"
  screen -S "scz_${name}_relay" -X quit 2>/dev/null || true
  screen -S "scz_${name}_worker" -X quit 2>/dev/null || true
  echo "stopped ${name}"
}

case "${1:-start}" in
  start)
    for spec in "${AGENTS[@]}"; do
      IFS=":" read -r name env_file worker_port <<< "${spec}"
      start_agent "${name}" "${env_file}" "${worker_port}"
    done
    ;;
  stop)
    for spec in "${AGENTS[@]}"; do
      IFS=":" read -r name _env_file _worker_port <<< "${spec}"
      stop_agent "${name}"
    done
    ;;
  status)
    screen -ls
    ;;
  *)
    echo "Usage: $0 [start|stop|status]" >&2
    exit 1
    ;;
esac
