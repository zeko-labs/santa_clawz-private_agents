#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${SANTACLAWZ_DATA_DIR:-/data}"
ENV_FILE="${SANTACLAWZ_ENV_FILE:-${DATA_DIR}/.env.santaclawz}"
CHALLENGE_FILE="${SANTACLAWZ_CHALLENGE_FILE:-${DATA_DIR}/.well-known/santaclawz-agent-challenge.json}"
RELAY_BASE="${CLAWZ_RELAY_BASE:-https://relay.santaclawz.ai}"

usage() {
  cat <<'USAGE'
SantaClawz agent runtime container

Usage:
  santaclawz-agent activate --ticket scz_enroll_...
  santaclawz-agent relay
  santaclawz-agent ready
  santaclawz-agent shell

Data:
  Mount a persistent volume at /data. The container writes:
    /data/.env.santaclawz
    /data/.well-known/santaclawz-agent-challenge.json
  If /data/.env.santaclawz already exists, activate resumes relay instead of
  redeeming the one-time ticket again. Pass --force-redeem only when replacing
  the saved agent credentials deliberately.

Examples:
  docker run -it --rm \
    -v "$HOME/santaclawz-agent-data:/data" \
    santaclawz/agent-runtime:latest \
    activate --ticket scz_enroll_...

  docker run -it --rm \
    -v "$HOME/santaclawz-agent-data:/data" \
    santaclawz/agent-runtime:latest \
    ready
USAGE
}

has_flag() {
  local wanted="$1"
  shift
  for value in "$@"; do
    [[ "$value" == "$wanted" ]] && return 0
  done
  return 1
}

mkdir -p "$DATA_DIR" "$(dirname "$CHALLENGE_FILE")"

command="${1:-help}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "$command" in
  activate)
    enroll_args=("$@")
    force_redeem="false"
    if has_flag "--force-redeem" "${enroll_args[@]}"; then
      force_redeem="true"
      temp_args=()
      for arg in "${enroll_args[@]}"; do
        [[ "$arg" != "--force-redeem" ]] && temp_args+=("$arg")
      done
      enroll_args=("${temp_args[@]}")
      unset temp_args
    fi

    if [[ -f "$ENV_FILE" && "$force_redeem" != "true" ]]; then
      echo "[SantaClawz] Existing ${ENV_FILE} found; resuming relay instead of redeeming the one-time ticket again."
      exec pnpm relay:agent -- --env-file "$ENV_FILE" --serve --takeover
    fi

    if ! has_flag "--write-env" "${enroll_args[@]}" && ! has_flag "--env-file" "${enroll_args[@]}" && ! has_flag "--agent-env-file" "${enroll_args[@]}"; then
      enroll_args+=("--write-env" "$ENV_FILE")
    fi

    if ! has_flag "--challenge-file" "${enroll_args[@]}"; then
      enroll_args+=("--challenge-file" "$CHALLENGE_FILE")
    fi

    if ! has_flag "--serve" "${enroll_args[@]}" && ! has_flag "--local-hire-url" "${enroll_args[@]}"; then
      enroll_args+=("--serve")
    fi

    if ! has_flag "--runtime-ingress-url" "${enroll_args[@]}" && ! has_flag "--connect-relay" "${enroll_args[@]}"; then
      enroll_args+=("--connect-relay")
    fi

    if has_flag "--connect-relay" "${enroll_args[@]}" && ! has_flag "--relay-base" "${enroll_args[@]}"; then
      enroll_args+=("--relay-base" "$RELAY_BASE")
    fi

    exec pnpm enroll:agent -- "${enroll_args[@]}"
    ;;
  relay)
    exec pnpm relay:agent -- --env-file "$ENV_FILE" --serve --takeover "$@"
    ;;
  ready|seller-ready)
    exec pnpm seller:ready -- --env-file "$ENV_FILE" --json "$@"
    ;;
  shell|bash)
    exec bash "$@"
    ;;
  pnpm|node)
    exec "$command" "$@"
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    exec "$command" "$@"
    ;;
esac
