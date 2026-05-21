#!/usr/bin/env bash
set -euo pipefail

DEFAULT_REPO_URL="https://github.com/zeko-labs/santa_clawz-private_agents.git"
DEFAULT_DIR="${HOME}/santaclawz-agent"
DEFAULT_RELAY_BASE="https://relay.santaclawz.ai"
CHALLENGE_FILE=".well-known/santaclawz-agent-challenge.json"

ticket=""
target_dir="${SANTACLAWZ_AGENT_DIR:-$DEFAULT_DIR}"
repo_url="${SANTACLAWZ_AGENT_REPO_URL:-$DEFAULT_REPO_URL}"
relay_base="${SANTACLAWZ_RELAY_BASE:-$DEFAULT_RELAY_BASE}"
runtime_ingress_url=""
skip_install="false"
no_enroll="false"
dry_run="false"

usage() {
  cat <<'USAGE'
SantaClawz agent activation bootstrap

Usage:
  bash activate-agent.sh --ticket scz_enroll_...

What this script checks:
  1. If the current folder is already a SantaClawz agent repo, it uses it.
  2. Otherwise it uses the default folder: ~/santaclawz-agent
  3. If ~/santaclawz-agent does not exist, it clones the repo there.

It does not scan your whole computer.

Options:
  --ticket <ticket>              Required activation ticket.
  --dir <path>                   Override default folder. Default: ~/santaclawz-agent
  --repo-url <url>               Override repo URL.
  --relay-base <url>             Override relay URL.
  --runtime-ingress-url <url>    Use self-hosted runtime URL instead of SantaClawz relay.
  --skip-install                 Skip pnpm install.
  --no-enroll                    Clone/install only; do not run activation.
  --dry-run                      Print the plan and command without changing anything.
  -h, --help                     Show this help.
USAGE
}

log() {
  printf '[SantaClawz] %s\n' "$*"
}

die() {
  printf '[SantaClawz] error: %s\n' "$*" >&2
  exit 1
}

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

is_santaclawz_repo() {
  local dir="$1"
  [[ -f "$dir/package.json" ]] || return 1
  grep -q '"enroll:agent"' "$dir/package.json" 2>/dev/null || return 1
}

package_manager_pnpm_version() {
  [[ -f package.json ]] || return 1
  sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([^"]*\)".*/\1/p' package.json | head -n 1
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return 0
  fi

  if ! command -v corepack >/dev/null 2>&1; then
    die "pnpm is required, and Corepack is not available. Install pnpm or install Node.js with Corepack, then rerun."
  fi

  local pnpm_version
  pnpm_version="$(package_manager_pnpm_version || true)"
  if [[ -z "$pnpm_version" ]]; then
    pnpm_version="9.15.0"
  fi

  log "pnpm is not installed; trying Corepack to activate pnpm@$pnpm_version."
  corepack enable || log "Corepack enable failed or needs permissions; trying Corepack prepare anyway."
  corepack prepare "pnpm@$pnpm_version" --activate || die "Could not activate pnpm with Corepack. Install pnpm, then rerun."

  command -v pnpm >/dev/null 2>&1 || die "Corepack completed, but pnpm is still unavailable on PATH. Restart the shell or install pnpm, then rerun."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ticket)
      [[ $# -ge 2 ]] || die "--ticket requires a value"
      ticket="$2"
      shift 2
      ;;
    --dir)
      [[ $# -ge 2 ]] || die "--dir requires a value"
      target_dir="$2"
      shift 2
      ;;
    --repo-url)
      [[ $# -ge 2 ]] || die "--repo-url requires a value"
      repo_url="$2"
      shift 2
      ;;
    --relay-base)
      [[ $# -ge 2 ]] || die "--relay-base requires a value"
      relay_base="$2"
      shift 2
      ;;
    --runtime-ingress-url)
      [[ $# -ge 2 ]] || die "--runtime-ingress-url requires a value"
      runtime_ingress_url="$2"
      shift 2
      ;;
    --skip-install)
      skip_install="true"
      shift
      ;;
    --no-enroll)
      no_enroll="true"
      shift
      ;;
    --dry-run)
      dry_run="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[[ -n "$ticket" || "$no_enroll" == "true" ]] || die "--ticket is required"

if is_santaclawz_repo "$PWD"; then
  repo_dir="$PWD"
  log "Using current SantaClawz agent repo: $repo_dir"
else
  repo_dir="$target_dir"
  log "Current folder is not a SantaClawz agent repo."
  log "Using default/check folder: $repo_dir"
fi

if [[ "$dry_run" == "true" ]]; then
  log "Dry run only. No files will be changed."
fi

if [[ ! -d "$repo_dir" ]]; then
  log "Repo folder does not exist; will clone $repo_url"
  if [[ "$dry_run" != "true" ]]; then
    command -v git >/dev/null 2>&1 || die "git is required"
    git clone "$repo_url" "$repo_dir"
  fi
elif ! is_santaclawz_repo "$repo_dir"; then
  die "$repo_dir exists but does not look like a SantaClawz agent repo. Pass --dir to choose another folder."
else
  log "Repo folder already exists."
fi

if [[ "$dry_run" != "true" ]]; then
  cd "$repo_dir"
else
  log "Would enter: $repo_dir"
fi

if [[ "$dry_run" != "true" && -d .git ]]; then
  if git diff --quiet && git diff --cached --quiet; then
    log "Updating existing repo with git pull --ff-only."
    git pull --ff-only || log "Could not fast-forward; continuing with existing checkout."
  else
    log "Local repo has uncommitted changes; skipping git pull."
  fi
fi

if [[ "$skip_install" != "true" ]]; then
  log "Installing dependencies with pnpm."
  if [[ "$dry_run" != "true" ]]; then
    ensure_pnpm
    pnpm install --frozen-lockfile || pnpm install
  fi
else
  log "Skipping dependency install."
fi

activation_args=(
  "enroll:agent"
  "--"
  "--ticket" "$ticket"
  "--serve"
)

if [[ -n "$runtime_ingress_url" ]]; then
  activation_args+=("--runtime-ingress-url" "$runtime_ingress_url")
else
  activation_args+=("--connect-relay" "--relay-base" "$relay_base")
fi

activation_args+=("--write-env" ".env.santaclawz" "--challenge-file" "$CHALLENGE_FILE")

printf '[SantaClawz] Activation command:\n  pnpm'
for arg in "${activation_args[@]}"; do
  printf ' %s' "$(shell_quote "$arg")"
done
printf '\n'

if [[ "$no_enroll" == "true" ]]; then
  log "Clone/install complete. Skipping activation because --no-enroll was provided."
  exit 0
fi

if [[ "$dry_run" == "true" ]]; then
  log "Dry run complete. Activation was not started."
  exit 0
fi

log "Starting activation. Keep this process running to keep the relay online."
ensure_pnpm
exec pnpm "${activation_args[@]}"
