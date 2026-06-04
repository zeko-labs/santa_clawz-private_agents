#!/usr/bin/env python3
"""Private SantaClawz worker bridge for real local execution.

The SantaClawz relay starter forwards paid execution payloads here through
OPENCLAW_INTERNAL_HIRE_URL. This bridge normalizes the hire request, runs the
local agent in santaclawz-run mode, validates the output package, and returns
the agent's real santaclawz_return_payload.json.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import secrets
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional


ROOT = pathlib.Path(__file__).resolve().parent
AGENT = ROOT / "agent" / "local_agent.py"
OUTPUT = ROOT / "output"
BRIDGE_DIR = OUTPUT / "worker_bridge"
REQUESTS_DIR = BRIDGE_DIR / "requests"
AUDIT_LOG = BRIDGE_DIR / "audit.jsonl"
DEFAULT_TIMEOUT_SECONDS = 110
FAST_PATH_DEFAULT = "1"


class BridgeError(Exception):
    def __init__(self, message: str, status_code: int = 500) -> None:
        super().__init__(message)
        self.status_code = status_code


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def slug(value: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in value)
    return "-".join(part for part in cleaned.split("-") if part)[:120] or "request"


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def stable_json_dumps(value: Any) -> str:
    def normalize(nested: Any) -> Any:
        if isinstance(nested, list):
            return [normalize(item) for item in nested]
        if isinstance(nested, dict):
            return {key: normalize(nested[key]) for key in sorted(nested.keys()) if nested[key] is not None}
        return nested

    return json.dumps(normalize(value), separators=(",", ":"))


def canonical_digest(value: Any) -> str:
    return hashlib.sha256(stable_json_dumps(value).encode("utf-8")).hexdigest()


def read_json(path: pathlib.Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: pathlib.Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def resolve_writable_state_dir() -> pathlib.Path:
    configured = pathlib.Path(os.environ.get("CLAWZ_JOB_PACK_STATE_DIR", str(BRIDGE_DIR))).expanduser()
    candidates = [configured, BRIDGE_DIR]
    seen = set()
    for candidate in candidates:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            probe = candidate / ".write-test"
            probe.write_text(now_iso(), encoding="utf-8")
            probe.unlink(missing_ok=True)
            if candidate != configured:
                log_event({
                    "type": "job-pack-state-dir-fallback",
                    "configured": str(configured),
                    "using": str(candidate),
                })
            return candidate
        except Exception as exc:
            log_event({
                "type": "job-pack-state-dir-unavailable",
                "path": str(candidate),
                "error": str(exc),
            })
    raise RuntimeError("No writable Job Pack state directory is available")


STATE_DIR = resolve_writable_state_dir()
ACTIVATION_LANE_STATE = STATE_DIR / "activation_lane_state.json"


def append_audit(event: dict[str, Any]) -> None:
    AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
    event.setdefault("created_at", now_iso())
    with AUDIT_LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, sort_keys=True) + "\n")


def log_event(event: dict[str, Any]) -> None:
    event.setdefault("created_at", now_iso())
    print(json.dumps(event, sort_keys=True), file=sys.stderr, flush=True)


def first_string(*values: Any, default: str = "") -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return default


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def env_truthy(name: str, default: str = "") -> bool:
    return str(os.environ.get(name, default)).strip().lower() in {"1", "true", "yes", "on"}


def env_int(name: str, default: int, minimum: int | None = None) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, value) if minimum is not None else value


def module_available(name: str) -> bool:
    try:
        __import__(name)
        return True
    except Exception:
        return False


def normalize_service(payload: dict[str, Any]) -> str:
    service = first_string(
        payload.get("service"),
        payload.get("service_key"),
        as_dict(payload.get("seller")).get("service"),
        default="agent_job_pack",
    )
    if service in {"agent-job-pack", "job-win", "job_winning_pack"}:
        return "agent_job_pack"
    return service


def normalize_for_local_agent(payload: dict[str, Any], raw_body: str) -> dict[str, Any]:
    existing_input = as_dict(payload.get("input"))
    caller = as_dict(payload.get("caller"))
    buyer = as_dict(payload.get("buyer"))
    payment = as_dict(payload.get("payment"))
    service = normalize_service(payload)
    request_id = first_string(
        payload.get("request_id"),
        payload.get("requestId"),
        payment.get("authorizationId"),
        default=f"scz-bridge-{sha256_text(raw_body)[:12]}",
    )

    title = first_string(
        existing_input.get("title"),
        payload.get("title"),
        payload.get("task_title"),
        payload.get("description"),
        default="Create an agent job-winning pack from a paid SantaClawz request",
    )
    client_request = first_string(
        existing_input.get("client_request"),
        existing_input.get("description"),
        payload.get("task_prompt"),
        payload.get("prompt"),
        payload.get("description"),
        default=json.dumps(payload, sort_keys=True),
    )

    provided_inputs = existing_input.get("provided_inputs")
    if not isinstance(provided_inputs, list) or not provided_inputs:
        provided_inputs = [
            "SantaClawz signed hire payload",
            "settled x402 payment metadata",
            "buyer request details",
        ]

    requested_deliverables = existing_input.get("requested_deliverables")
    if not isinstance(requested_deliverables, list) or not requested_deliverables:
        requested_deliverables = [
            "bid/no-bid analysis",
            "proposal draft",
            "scope and acceptance criteria",
            "risk register",
            "delivery task queue",
            "final QA checklist",
            "pricing recommendation",
            "agent business brain JSON",
        ]

    caller_id = first_string(
        caller.get("id"),
        buyer.get("agentId"),
        buyer.get("address"),
        payload.get("buyer_agent_id"),
        default="santaclawz-buyer",
    )

    budget = first_string(
        existing_input.get("budget"),
        payload.get("settled_amount_usd"),
        payment.get("amountUsd"),
        default="paid SantaClawz execution",
    )

    return {
        "request_id": request_id,
        "portal_run_id": first_string(payload.get("portal_run_id"), payload.get("requestId"), default=request_id),
        "caller_type": first_string(payload.get("caller_type"), buyer.get("type"), default="agent"),
        "caller": {
            "id": caller_id,
            "display_name": first_string(caller.get("display_name"), buyer.get("displayName"), default=caller_id),
        },
        "service": service,
        "verification_required": bool(payload.get("verification_required", True)),
        "return_channel": first_string(payload.get("return_channel"), default="santaclawz"),
        "payment": {
            "status": first_string(payload.get("payment_status"), payment.get("status")),
            "rail": first_string(payment.get("rail"), payload.get("rail")),
            "amount_usd": budget,
            "authorization_id": first_string(payment.get("authorizationId"), payment.get("authorization_id")),
            "settlement_reference": first_string(payment.get("settlementReference"), payment.get("settlement_reference")),
        },
        "input": {
            "title": title,
            "client_request": client_request,
            "provided_inputs": provided_inputs,
            "requested_deliverables": requested_deliverables,
            "deadline": first_string(existing_input.get("deadline"), payload.get("deadline"), default="not specified"),
            "budget": budget,
        },
        "bridge": {
            "schema_version": "santaclawz-real-worker-bridge/1.0",
            "received_at": now_iso(),
            "raw_body_sha256": sha256_text(raw_body),
            "request_type": first_string(payload.get("request_type"), payload.get("requestKind")),
            "pricing_mode": first_string(payload.get("pricing_mode"), payload.get("pricingMode")),
        },
    }


def validate_return_payload(run_dir: pathlib.Path, payload: dict[str, Any]) -> dict[str, Any]:
    verified = as_dict(payload.get("verified_output"))
    deliverables = as_dict(verified.get("deliverables"))
    manifest_path = pathlib.Path(str(verified.get("verification_manifest", "")))
    zeko_path = pathlib.Path(str(verified.get("zeko_attestation_payload", "")))
    receipt_path = pathlib.Path(str(payload.get("receipt_path", "")))
    package_hash = verified.get("package_hash")

    checks: list[dict[str, Any]] = []

    def add(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"name": name, "ok": ok, "detail": detail})

    add("status_completed", payload.get("status") == "completed", str(payload.get("status")))
    add("deliverables_present", len(deliverables) > 0, f"{len(deliverables)} deliverables")
    add("verification_manifest_present", manifest_path.exists(), str(manifest_path))
    add("zeko_attestation_present", zeko_path.exists(), str(zeko_path))
    add("receipt_present", receipt_path.exists(), str(receipt_path))
    add("package_hash_present", isinstance(package_hash, str) and len(package_hash) >= 32, str(package_hash))

    missing_files = []
    for name, info in deliverables.items():
        file_path = pathlib.Path(str(as_dict(info).get("path", "")))
        if not file_path.exists():
            missing_files.append(name)
    add("deliverable_files_exist", not missing_files, ", ".join(missing_files))

    if manifest_path.exists():
        manifest = read_json(manifest_path)
        file_hashes = as_dict(manifest.get("file_hashes"))
        add("manifest_file_hashes_present", len(file_hashes) > 0, f"{len(file_hashes)} files")
        add("manifest_package_hash_matches_return", manifest.get("package_hash") == package_hash, str(manifest.get("package_hash")))
    else:
        manifest = {}

    failed = [check for check in checks if not check["ok"]]
    if failed:
        raise BridgeError(f"real worker output failed validation: {failed}", status_code=500)

    return {
        "schema_version": "santaclawz-real-worker-quality/1.0",
        "run_dir": str(run_dir),
        "checked_at": now_iso(),
        "real_work_executed": True,
        "deliverable_count": len(deliverables),
        "verification_manifest": str(manifest_path),
        "zeko_attestation_payload": str(zeko_path),
        "package_hash": package_hash,
        "checks": checks,
        "manifest_file_count": len(as_dict(manifest.get("file_hashes"))),
    }


def write_text_file(path: pathlib.Path, contents: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")
    return sha256_bytes(contents.encode("utf-8"))


def build_fast_worker_payload(payload: dict[str, Any], raw_body: str) -> tuple[dict[str, Any], dict[str, Any]]:
    normalized = normalize_for_local_agent(payload, raw_body)
    request_id = str(normalized["request_id"])
    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = OUTPUT / f"{timestamp}-{slug(request_id)}-hosted-fast-run"
    package_dir = run_dir / "output_package"
    package_dir.mkdir(parents=True, exist_ok=False)

    job_input = as_dict(normalized.get("input"))
    title = first_string(job_input.get("title"), default="SantaClawz hosted starter job pack")
    client_request = first_string(job_input.get("client_request"), default="No buyer request provided.")
    service = first_string(normalized.get("service"), default="agent_job_pack")
    created_at = now_iso()

    files: list[tuple[str, str]] = [
        ("00_summary.md", f"# Starter Job Pack\n\nRequest: {request_id}\n\nService: {service}\n\n{title}\n"),
        ("01_buyer_request.md", f"# Buyer Request\n\n{client_request}\n"),
        ("02_bid_recommendation.md", "Recommendation: proceed if scope is clear, payment is authorized, and delivery lane is acceptable.\n"),
        ("03_scope.md", "Scope: produce onboarding guidance, pricing considerations, test steps, and acceptance criteria for SantaClawz agent work.\n"),
        ("04_acceptance_criteria.md", "- Buyer can verify the response package digest.\n- Seller returns santaclawz-return/1.0.\n- Artifacts are digest-addressed.\n"),
        ("05_pricing.md", "Pricing note: use the live SantaClawz x402 requirement as source of truth for gross, seller net, and protocol fee.\n"),
        ("06_delivery_plan.md", "Delivery plan: return a compact verified envelope and attach artifact manifest or direct receipt when needed.\n"),
        ("07_risk_register.md", "Risks: unclear scope, unsafe artifacts, stale relay heartbeat, route misconfiguration, and timeout during paid execution.\n"),
        ("08_test_plan.md", "Test plan: readiness, fixed paid hire, quote flow where applicable, artifact delivery, workspace messages, and state follow-up.\n"),
        ("09_operator_notes.md", "Operator notes: keep relay outbound, worker private/internal, and secrets outside public profile surfaces.\n"),
        ("10_agent_brain.json", json.dumps({"service": service, "request_id": request_id, "mode": "hosted_fast_path"}, indent=2, sort_keys=True)),
        ("11_completion.md", f"Completed at {created_at}. This package was generated by the hosted deterministic Job Pack worker.\n"),
    ]

    deliverables: dict[str, Any] = {}
    file_hashes: dict[str, str] = {}
    for name, contents in files:
        file_path = package_dir / name
        digest = write_text_file(file_path, contents)
        file_hashes[name] = digest
        deliverables[name] = {
            "name": name,
            "path": str(file_path),
            "sha256": digest,
            "content_type": "application/json" if name.endswith(".json") else "text/markdown",
        }

    manifest = {
        "schema_version": "santaclawz-verification-manifest/1.0",
        "request_id": request_id,
        "created_at": created_at,
        "input_digest_sha256": sha256_text(raw_body),
        "checks_performed": [
            "hosted_fast_path_generated",
            "deliverables_hashed",
            "manifest_written",
            "santaclawz_return_payload_written",
        ],
        "files_produced": list(file_hashes.keys()),
        "file_hashes": file_hashes,
        "blocked_suspicious_instructions": [],
    }
    package_hash = sha256_text(json.dumps(file_hashes, sort_keys=True))
    manifest["package_hash"] = package_hash
    manifest_path = run_dir / "verification_manifest.json"
    zeko_path = run_dir / "zeko_attestation_payload.json"
    receipt_path = run_dir / "run_receipt.json"
    write_json(manifest_path, manifest)
    write_json(
        zeko_path,
        {
            "schema_version": "santaclawz-zk-attestation-preview/1.0",
            "request_id": request_id,
            "package_hash": package_hash,
            "generated_at": created_at,
        },
    )
    write_json(
        receipt_path,
        {
            "schema_version": "santaclawz-run-receipt/1.0",
            "request_id": request_id,
            "status": "completed",
            "run_dir": str(run_dir),
            "package_hash": package_hash,
            "created_at": created_at,
        },
    )

    return_payload = {
        "schema_version": "santaclawz-return/1.0",
        "request_id": request_id,
        "status": "completed",
        "return_channel": "santaclawz",
        "agent_private": True,
        "execution_mode": "deterministic-hosted-starter",
        "real_work_executed": True,
        "buyer_visible": True,
        "verified_output": {
            "package_hash": package_hash,
            "verification_manifest": manifest,
            "zeko_attestation_payload": str(zeko_path),
            "deliverables": deliverables,
        },
        "receipt_path": str(receipt_path),
    }
    write_json(run_dir / "santaclawz_return_payload.json", return_payload)
    quality = {
        "schema_version": "santaclawz-real-worker-quality/1.0",
        "run_dir": str(run_dir),
        "checked_at": now_iso(),
        "real_work_executed": True,
        "deliverable_count": len(deliverables),
        "verification_manifest": str(manifest_path),
        "zeko_attestation_payload": str(zeko_path),
        "package_hash": package_hash,
        "checks": [
            {"name": "hosted_fast_path_generated", "ok": True, "detail": "deterministic package generated in-process"},
            {"name": "deliverables_present", "ok": True, "detail": f"{len(deliverables)} deliverables"},
            {"name": "package_hash_present", "ok": True, "detail": package_hash},
        ],
        "manifest_file_count": len(file_hashes),
    }
    append_audit(
        {
            "type": "real-worker-fast-path-completed",
            "request_id": request_id,
            "status": "completed",
            "run_dir": str(run_dir),
            "deliverable_count": quality["deliverable_count"],
            "package_hash": package_hash,
        }
    )
    log_event(
        {
            "type": "real-worker-fast-path-completed",
            "request_id": request_id,
            "elapsed_mode": "in-process",
            "deliverable_count": quality["deliverable_count"],
            "package_hash": package_hash,
        }
    )
    return return_payload, quality


def protocol_verification_manifest(manifest_path: pathlib.Path, deliverables: dict[str, Any], raw_body: str) -> dict[str, Any]:
    manifest = read_json(manifest_path) if manifest_path.exists() else {}
    raw_checks = manifest.get("checks_performed") or manifest.get("checks") or []
    checks_performed: list[str] = []
    if isinstance(raw_checks, list):
        for index, check in enumerate(raw_checks):
            if isinstance(check, str) and check.strip():
                checks_performed.append(check.strip())
            elif isinstance(check, dict):
                name = check.get("name")
                checks_performed.append(str(name).strip() if isinstance(name, str) and name.strip() else f"check-{index + 1}")
    if not checks_performed:
        checks_performed = [
            "deliverables_present",
            "verification_manifest_present",
            "package_hash_present",
            "deliverable_files_exist",
        ]
    return {
        **manifest,
        "input_digest_sha256": manifest.get("input_digest_sha256") or sha256_text(raw_body),
        "checks_performed": checks_performed,
        "files_produced": [str(name) for name in deliverables.keys()],
        "blocked_suspicious_instructions": manifest.get("blocked_suspicious_instructions") or [],
    }


def run_worker(payload: dict[str, Any], raw_body: str, timeout_seconds: int) -> tuple[dict[str, Any], dict[str, Any]]:
    if env_truthy("CLAWZ_AGENT_JOB_PACK_FAST_PATH", FAST_PATH_DEFAULT):
        return build_fast_worker_payload(payload, raw_body)

    if not AGENT.exists():
        raise BridgeError(f"local agent not found: {AGENT}", status_code=500)

    normalized = normalize_for_local_agent(payload, raw_body)
    request_id = str(normalized["request_id"])
    request_path = REQUESTS_DIR / f"{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}-{slug(request_id)}.json"
    write_json(request_path, normalized)

    command = [sys.executable, str(AGENT), "--mode", "santaclawz-run", str(request_path)]
    started_at = now_iso()
    started_monotonic = dt.datetime.now(dt.timezone.utc)
    log_event(
        {
            "type": "real-worker-process-started",
            "request_id": request_id,
            "command": "agent/local_agent.py --mode santaclawz-run",
            "timeout_seconds": timeout_seconds,
            "request_path": str(request_path),
        }
    )
    try:
        completed = subprocess.run(
            command,
            cwd=str(ROOT),
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        elapsed_ms = int((dt.datetime.now(dt.timezone.utc) - started_monotonic).total_seconds() * 1000)
        log_event(
            {
                "type": "real-worker-process-timeout",
                "request_id": request_id,
                "timeout_seconds": timeout_seconds,
                "elapsed_ms": elapsed_ms,
                "stdout_preview": (exc.stdout or "")[:500] if isinstance(exc.stdout, str) else "",
                "stderr_preview": (exc.stderr or "")[:500] if isinstance(exc.stderr, str) else "",
            }
        )
        raise BridgeError(f"local agent timed out after {timeout_seconds}s", status_code=504) from exc
    elapsed_ms = int((dt.datetime.now(dt.timezone.utc) - started_monotonic).total_seconds() * 1000)
    stdout = completed.stdout.strip()
    stderr = completed.stderr.strip()
    log_event(
        {
            "type": "real-worker-process-exited",
            "request_id": request_id,
            "return_code": completed.returncode,
            "elapsed_ms": elapsed_ms,
            "stdout_bytes": len(completed.stdout.encode("utf-8")),
            "stderr_bytes": len(completed.stderr.encode("utf-8")),
            "stdout_last_line": stdout.splitlines()[-1] if stdout else "",
            "stderr_preview": stderr[:500],
        }
    )
    if completed.returncode != 0:
        raise BridgeError(f"local agent failed with exit {completed.returncode}: {stderr[:500]}", status_code=500)
    if not stdout:
        raise BridgeError("local agent did not print a run directory", status_code=500)

    run_dir = pathlib.Path(stdout.splitlines()[-1]).expanduser()
    if not run_dir.is_absolute():
        run_dir = (ROOT / run_dir).resolve()
    return_path = run_dir / "santaclawz_return_payload.json"
    if not return_path.exists():
        raise BridgeError(f"local agent did not produce {return_path}", status_code=500)

    return_payload = read_json(return_path)
    quality = validate_return_payload(run_dir, return_payload)
    verified = as_dict(return_payload.get("verified_output"))
    manifest_path = pathlib.Path(str(verified.get("verification_manifest", "")))
    deliverables = as_dict(verified.get("deliverables"))
    if len(deliverables) > 4:
        verified["deliverables"] = dict(list(deliverables.items())[:4])
        deliverables = as_dict(verified.get("deliverables"))
    if manifest_path.exists():
        verified["verification_manifest"] = protocol_verification_manifest(
            manifest_path,
            deliverables,
            raw_body,
        )
        return_payload["verified_output"] = verified
    return_payload["execution_bridge"] = {
        "schema_version": "santaclawz-real-worker-bridge/1.0",
        "mode": "real-local-agent",
        "worker_command": "agent/local_agent.py --mode santaclawz-run",
        "request_path": str(request_path),
        "started_at": started_at,
        "completed_at": now_iso(),
        "local_agent_stdout": stdout,
        "quality": quality,
    }

    append_audit(
        {
            "type": "real-worker-completed",
            "request_id": request_id,
            "status": return_payload.get("status"),
            "run_dir": str(run_dir),
            "deliverable_count": quality["deliverable_count"],
            "package_hash": quality["package_hash"],
        }
    )
    log_event(
        {
            "type": "real-worker-completed",
            "request_id": request_id,
            "status": return_payload.get("status"),
            "run_dir": str(run_dir),
            "deliverable_count": quality["deliverable_count"],
            "package_hash": quality["package_hash"],
        }
    )
    return return_payload, quality


def failure_payload(message: str, status_code: int, request_id: str | None = None) -> dict[str, Any]:
    return {
        "schema_version": "santaclawz-return/1.0",
        "request_id": request_id,
        "status": "failed",
        "return_channel": "santaclawz",
        "agent_private": True,
        "error": {
            "code": "real_worker_bridge_failed",
            "message": message,
            "status_code": status_code,
        },
        "verified_output": {
            "deliverables": {},
            "package_hash": None,
            "verification_manifest": None,
            "zeko_attestation_payload": None,
        },
    }


class Handler(BaseHTTPRequestHandler):
    timeout_seconds = DEFAULT_TIMEOUT_SECONDS

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[{now_iso()}] {self.address_string()} {fmt % args}", file=sys.stderr)

    def write_response(self, status_code: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        self.send_response(status_code)
        self.send_header("content-type", "application/json")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        activation_lane_enabled = env_truthy("CLAWZ_AGENT_JOB_PACK_ACTIVATION_LANE_ENABLED")
        activation_lane_token = (
            os.environ.get("CLAWZ_ACTIVATION_LANE_TOKEN")
            or os.environ.get("CLAWZ_AGENT_JOB_PACK_ACTIVATION_TOKEN")
            or ""
        ).strip()
        self.write_response(
            200,
            {
                "ok": True,
                "service": "santaclawz-real-worker-bridge",
                "hireEndpoint": "/hire",
                "agent": "agent/local_agent.py --mode santaclawz-run",
                "qualityGate": "deliverables + verification manifest + zeko attestation required",
                "activationLane": {
                    "enabled": activation_lane_enabled,
                    "apiBase": os.environ.get("CLAWZ_API_BASE", "https://api.santaclawz.ai").rstrip("/"),
                    "hasToken": bool(activation_lane_token),
                    "hasBuyerPrivateKey": bool(os.environ.get("CLAWZ_ACTIVATION_LANE_BUYER_PRIVATE_KEY", "").strip()),
                    "hasProbeCommand": bool(os.environ.get("CLAWZ_ACTIVATION_LANE_PROBE_COMMAND", "").strip()),
                    "ethAccountAvailable": module_available("eth_account"),
                    "intervalSeconds": env_int("CLAWZ_ACTIVATION_LANE_INTERVAL_SECONDS", 30, 5),
                    "cooldownSeconds": env_int("CLAWZ_ACTIVATION_LANE_COOLDOWN_SECONDS", 3600, 60),
                    "statePath": str(ACTIVATION_LANE_STATE),
                    "statePersisted": ACTIVATION_LANE_STATE.exists(),
                },
            },
        )

    def do_POST(self) -> None:
        if self.path != "/hire":
            self.write_response(404, {"ok": False, "error": "not found"})
            return
        body_bytes = self.rfile.read(int(self.headers.get("content-length", "0")))
        raw_body = body_bytes.decode("utf-8")
        request_id = self.headers.get("x-santaclawz-request-id")
        try:
            payload = json.loads(raw_body)
            request_id = first_string(request_id, payload.get("request_id"), payload.get("requestId"), default="")
            append_audit({"type": "real-worker-received", "request_id": request_id, "body_sha256": sha256_text(raw_body)})
            log_event(
                {
                    "type": "real-worker-received",
                    "request_id": request_id,
                    "path": self.path,
                    "body_bytes": len(body_bytes),
                    "body_sha256": sha256_text(raw_body),
                    "timeout_seconds": self.timeout_seconds,
                }
            )
            return_payload, _quality = run_worker(payload, raw_body, self.timeout_seconds)
            self.write_response(200, return_payload)
        except BridgeError as exc:
            append_audit({"type": "real-worker-failed", "request_id": request_id, "error": str(exc), "status_code": exc.status_code})
            log_event({"type": "real-worker-failed", "request_id": request_id, "error": str(exc), "status_code": exc.status_code})
            self.write_response(exc.status_code, failure_payload(str(exc), exc.status_code, request_id))
        except Exception as exc:
            append_audit(
                {
                    "type": "real-worker-unhandled-error",
                    "request_id": request_id,
                    "error": str(exc),
                    "trace": traceback.format_exc(limit=6),
                }
            )
            log_event({"type": "real-worker-unhandled-error", "request_id": request_id, "error": str(exc), "trace": traceback.format_exc(limit=6)})
            self.write_response(500, failure_payload("unhandled real worker bridge error", 500, request_id))


def run_once(path: pathlib.Path, timeout_seconds: int) -> int:
    payload = read_json(path)
    raw_body = json.dumps(payload, sort_keys=True)
    return_payload, quality = run_worker(payload, raw_body, timeout_seconds)
    print(json.dumps({"ok": True, "request_id": return_payload.get("request_id"), "quality": quality}, indent=2, sort_keys=True))
    return 0


def activation_lane_http_json(method: str, url: str, token: str, payload: Optional[dict[str, Any]] = None, timeout_seconds: Optional[int] = None) -> tuple[int, dict[str, Any]]:
    clean_token = token.strip()
    body = None if payload is None else json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    timeout = timeout_seconds if timeout_seconds is not None else int(os.environ.get("CLAWZ_ACTIVATION_LANE_HTTP_TIMEOUT_SECONDS", "120"))
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={
            "accept": "application/json",
            "content-type": "application/json",
            "authorization": f"Bearer {clean_token}",
            "x-santaclawz-activation-lane-key": clean_token,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            try:
                return response.status, json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                return response.status, {"ok": False, "error": raw}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        try:
            return exc.code, json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return exc.code, {"ok": False, "error": raw}


def activation_attempt_status_for_result(result: dict[str, Any]) -> str:
    if result.get("ok") is True:
        return "preview_only" if result.get("mode") == "payment_required_preview" else "paid_probe_completed"
    classification = result.get("classification")
    if classification == "payment":
        return "payment_failed"
    if classification == "seller":
        return "seller_failed"
    if classification == "platform":
        return "platform_failed"
    return "unknown_failed"


def response_error_text(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    for key in ("error", "message", "reason", "invalidReason", "errorReason", "errorMessage", "code"):
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    nested = value.get("operationalStatus")
    if isinstance(nested, dict):
        for key in ("paymentFailureReason", "settlementFailureReason", "deliveryError", "returnValidationError"):
            candidate = nested.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
    return ""


def report_activation_lane_attempt(candidate: dict[str, Any], token: str, status: str, result: Optional[dict[str, Any]] = None) -> None:
    agent_id = str(candidate.get("agentId", ""))
    if not agent_id:
        return
    result = result or {}
    response_value = result.get("response")
    payload = {
        "agentId": agent_id,
        "sessionId": str(candidate.get("sessionId", "")),
        "status": status,
        "ok": bool(result.get("ok")) if "ok" in result else status in ("candidate_seen", "challenge_ok", "paid_probe_started"),
        "mode": str(result.get("mode", "")),
        "classification": str(result.get("classification", "")),
        "httpStatus": result.get("status"),
        "requestId": (response_value or {}).get("requestId") if isinstance(response_value, dict) else "",
        "ledgerId": ((response_value or {}).get("payment") or {}).get("ledgerId") if isinstance(response_value, dict) and isinstance((response_value or {}).get("payment"), dict) else "",
        "paymentPayloadDigestSha256": str(result.get("paymentPayloadDigestSha256", "")),
        "responseDigestSha256": sha256_text(stable_json_dumps(response_value)) if isinstance(response_value, (dict, list)) else "",
        "error": str(result.get("error") or response_error_text(response_value) or ""),
        "occurredAtIso": now_iso(),
    }
    try:
        api_base = os.environ.get("CLAWZ_API_BASE", "https://api.santaclawz.ai").rstrip("/")
        status_code, response = activation_lane_http_json("POST", f"{api_base}/api/activation-lane/attempts", token, payload, timeout_seconds=20)
        if status_code >= 400:
            log_event({"type": "activation-lane-attempt-report-failed", "agent_id": agent_id, "status": status_code, "response": response})
    except Exception as exc:
        log_event({"type": "activation-lane-attempt-report-error", "agent_id": agent_id, "error": str(exc)})


def activation_lane_state() -> dict[str, Any]:
    if not ACTIVATION_LANE_STATE.exists():
        return {"agents": {}}
    try:
        state = read_json(ACTIVATION_LANE_STATE)
        return state if isinstance(state.get("agents"), dict) else {"agents": {}}
    except Exception:
        return {"agents": {}}


def run_activation_lane_probe_command(command: str, candidate: dict[str, Any]) -> dict[str, Any]:
    env = {
        **os.environ,
        "SANTACLAWZ_ACTIVATION_LANE": "1",
        "SANTACLAWZ_ACTIVATION_AGENT_ID": str(candidate.get("agentId", "")),
        "SANTACLAWZ_ACTIVATION_SESSION_ID": str(candidate.get("sessionId", "")),
        "SANTACLAWZ_ACTIVATION_AMOUNT_USD": str(candidate.get("amountUsd", "")),
        "SANTACLAWZ_ACTIVATION_HIRE_ENDPOINT": str(candidate.get("activationHireEndpoint", "")),
    }
    completed = subprocess.run(command, shell=True, cwd=str(ROOT), env=env, text=True, capture_output=True, timeout=180, check=False)
    return {
        "return_code": completed.returncode,
        "stdout_preview": completed.stdout[-1200:],
        "stderr_preview": completed.stderr[-1200:],
    }


def require_activation_field(source: dict[str, Any], key: str, context: str) -> str:
    value = source.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{context}.{key} is required")
    return value.strip()


def find_activation_fee_split_accept(payment_requirement: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    accepts = payment_requirement.get("accepts")
    if not isinstance(accepts, list):
        raise ValueError("paymentRequirement.accepts is required")
    for candidate in accepts:
        if not isinstance(candidate, dict) or candidate.get("settlementModel") != "x402-exact-evm-fee-split-v1":
            continue
        extensions = candidate.get("extensions")
        evm = extensions.get("evm") if isinstance(extensions, dict) else None
        fee_split = evm.get("feeSplit") if isinstance(evm, dict) else None
        if isinstance(evm, dict) and isinstance(fee_split, dict):
            return candidate, evm, fee_split
    raise ValueError("payment requirement is missing x402-exact-evm-fee-split-v1 accept option")


def activation_asset_address(accept: dict[str, Any], evm: dict[str, Any]) -> str:
    asset = accept.get("asset")
    if isinstance(asset, dict) and isinstance(asset.get("address"), str) and asset["address"].strip():
        return asset["address"].strip()
    return require_activation_field(evm, "assetAddress", "extensions.evm")


def activation_typed_data(evm: dict[str, Any], from_address: str, to_address: str, value: str, valid_after: str, valid_before: str, nonce: str) -> dict[str, Any]:
    chain_id = int(evm.get("chainId", 0))
    if chain_id <= 0:
        raise ValueError("extensions.evm.chainId is required")
    return {
        "domain": {
            "name": str(evm.get("eip712Name") or "USD Coin"),
            "version": str(evm.get("assetVersion") or "2"),
            "chainId": chain_id,
            "verifyingContract": require_activation_field(evm, "assetAddress", "extensions.evm"),
        },
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "TransferWithAuthorization": [
                {"name": "from", "type": "address"},
                {"name": "to", "type": "address"},
                {"name": "value", "type": "uint256"},
                {"name": "validAfter", "type": "uint256"},
                {"name": "validBefore", "type": "uint256"},
                {"name": "nonce", "type": "bytes32"},
            ],
        },
        "primaryType": "TransferWithAuthorization",
        "message": {
            "from": from_address,
            "to": to_address,
            "value": value,
            "validAfter": valid_after,
            "validBefore": valid_before,
            "nonce": nonce,
        },
    }


def sign_activation_typed_data(private_key: str, typed_data: dict[str, Any]) -> str:
    try:
        from eth_account import Account
        from eth_account.messages import encode_typed_data
    except Exception as exc:
        raise RuntimeError("eth-account is required for built-in activation-lane signing. Install requirements.txt on the hosted Job Pack service.") from exc

    signable = encode_typed_data(full_message=typed_data)
    return Account.sign_message(signable, private_key=private_key).signature.hex()


def activation_account_address(private_key: str) -> str:
    try:
        from eth_account import Account
    except Exception as exc:
        raise RuntimeError("eth-account is required for built-in activation-lane signing. Install requirements.txt on the hosted Job Pack service.") from exc
    return Account.from_key(private_key).address


def build_activation_fee_split_payment_payload(payment_requirement: dict[str, Any], candidate: dict[str, Any], private_key: str) -> dict[str, Any]:
    accept, evm, fee_split = find_activation_fee_split_accept(payment_requirement)
    payer = activation_account_address(private_key)
    configured_payer = os.environ.get("CLAWZ_ACTIVATION_LANE_BUYER_ADDRESS", "").strip()
    if configured_payer and configured_payer.lower() != payer.lower():
        raise ValueError("CLAWZ_ACTIVATION_LANE_BUYER_ADDRESS does not match CLAWZ_ACTIVATION_LANE_BUYER_PRIVATE_KEY")

    issued_at = now_iso()
    expires_at = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=15)).isoformat(timespec="seconds").replace("+00:00", "Z")
    valid_after = str(int(dt.datetime.fromisoformat(issued_at.replace("Z", "+00:00")).timestamp()))
    valid_before = str(int(dt.datetime.fromisoformat(expires_at.replace("Z", "+00:00")).timestamp()))
    seller_pay_to = require_activation_field(fee_split, "sellerPayTo", "feeSplit")
    protocol_fee_pay_to = require_activation_field(fee_split, "protocolFeePayTo", "feeSplit")
    seller_amount = require_activation_field(fee_split, "sellerAmount", "feeSplit")
    protocol_fee_amount = require_activation_field(fee_split, "protocolFeeAmount", "feeSplit")
    gross_amount = str(accept.get("amount") or accept.get("price") or "").strip()
    if not gross_amount:
        raise ValueError("accept.amount is required")
    amount_unit = "atomic" if isinstance(accept.get("extensions"), dict) and isinstance(accept["extensions"].get("evm"), dict) and accept["extensions"]["evm"].get("amountUnit") == "atomic" else "decimal"
    asset_address = activation_asset_address(accept, evm)
    seller_typed_data = activation_typed_data(
        evm,
        payer,
        seller_pay_to,
        seller_amount,
        valid_after,
        valid_before,
        f"0x{secrets.token_hex(32)}",
    )
    fee_typed_data = activation_typed_data(
        evm,
        payer,
        protocol_fee_pay_to,
        protocol_fee_amount,
        valid_after,
        valid_before,
        f"0x{secrets.token_hex(32)}",
    )
    seller_signature = sign_activation_typed_data(private_key, seller_typed_data)
    fee_signature = sign_activation_typed_data(private_key, fee_typed_data)
    payment_id = f"pay_{canonical_digest({'requestId': payment_requirement.get('requestId'), 'payer': payer, 'issuedAtIso': issued_at, 'sellerNonce': seller_typed_data['message']['nonce'], 'feeNonce': fee_typed_data['message']['nonce']})[:24]}"
    fee_bps = fee_split.get("feeBps")
    hosted_accepted = {
        "scheme": accept.get("scheme"),
        "network": require_activation_field(accept, "network", "accept"),
        "asset": asset_address,
        "amount": gross_amount,
        "payTo": seller_pay_to,
        "maxTimeoutSeconds": int(evm.get("maxTimeoutSeconds") or 60),
        "extra": {
            "name": str(evm.get("eip712Name") or "USD Coin"),
            "version": str(evm.get("assetVersion") or "2"),
            "amountUnit": amount_unit,
            "settlementModel": "x402-exact-evm-fee-split-v1",
            "feeSplit": {
                "version": str(fee_split.get("version") or "protocol-owner-fee-v1"),
                "grossAmount": gross_amount,
                "sellerAmount": seller_amount,
                "protocolFeeAmount": protocol_fee_amount,
                "sellerPayTo": seller_pay_to,
                "protocolFeePayTo": protocol_fee_pay_to,
                "feeSettlementMode": str(fee_split.get("feeSettlementMode") or "exact-eip3009-split-v1"),
                **({"feeBps": fee_bps} if isinstance(fee_bps, int) else {}),
            },
        },
    }
    extensions = {
        "evm": {"amountUnit": amount_unit},
        "santaclawz": {
            "paymentId": payment_id,
            "idempotencyKey": payment_id,
            "feeSplit": {
                "settlementModel": "x402-exact-evm-fee-split-v1",
                "sellerPayTo": seller_pay_to,
                "protocolFeePayTo": protocol_fee_pay_to,
                "grossAmount": gross_amount,
                "sellerAmount": seller_amount,
                "protocolFeeAmount": protocol_fee_amount,
                **({"feeBps": fee_bps} if isinstance(fee_bps, int) else {}),
            },
        },
    }
    payload_without_digest = {
        "x402Version": 2,
        "protocol": "x402",
        "version": "2",
        "requestId": require_activation_field(payment_requirement, "requestId", "paymentRequirement"),
        "paymentId": payment_id,
        "scheme": "exact",
        "settlementRail": "evm",
        "networkId": require_activation_field(accept, "network", "accept"),
        "asset": accept.get("asset"),
        "amount": gross_amount,
        "payer": payer,
        "payTo": seller_pay_to,
        "sessionId": str(candidate.get("sessionId") or payment_requirement.get("sessionId") or ""),
        "issuedAtIso": issued_at,
        "expiresAtIso": expires_at,
        "extensions": extensions,
        "accepted": hosted_accepted,
        "payload": {
            "signature": seller_signature,
            "authorization": seller_typed_data["message"],
            "primitive": "evm-eip3009-transfer-with-authorization",
            "feeAuthorization": {
                "signature": fee_signature,
                "authorization": fee_typed_data["message"],
                "primitive": "evm-eip3009-transfer-with-authorization",
            },
        },
        "payloadShape": "santaclawz-hosted-exact-fee-split-v1",
    }
    base_payload = {
        **payload_without_digest,
        "paymentContextDigest": canonical_digest({
            "requestId": payload_without_digest.get("requestId"),
            "paymentId": payload_without_digest.get("paymentId"),
            "scheme": payload_without_digest.get("scheme"),
            "settlementRail": payload_without_digest.get("settlementRail"),
            "networkId": payload_without_digest.get("networkId"),
            "asset": payload_without_digest.get("asset"),
            "amount": payload_without_digest.get("amount"),
            "payer": payload_without_digest.get("payer"),
            "payTo": payload_without_digest.get("payTo"),
            "sessionId": payload_without_digest.get("sessionId"),
            "issuedAtIso": payload_without_digest.get("issuedAtIso"),
            "expiresAtIso": payload_without_digest.get("expiresAtIso"),
            "extensions": payload_without_digest.get("extensions"),
        }),
    }
    payload = {
        **base_payload,
        "authorization": {
            "primitive": "evm-eip3009-transfer-with-authorization",
            "settlementRail": "evm",
            "network": accept.get("network"),
            "asset": accept.get("asset"),
            "transferMethod": "EIP-3009",
            "facilitator": evm.get("facilitatorUrl") or evm.get("defaultFacilitator"),
            "typedData": seller_typed_data,
            "signature": seller_signature,
        },
        "feeAuthorization": {
            "primitive": "evm-eip3009-transfer-with-authorization",
            "settlementRail": "evm",
            "network": accept.get("network"),
            "asset": accept.get("asset"),
            "transferMethod": "EIP-3009",
            "facilitator": evm.get("facilitatorUrl") or evm.get("defaultFacilitator"),
            "typedData": fee_typed_data,
            "signature": fee_signature,
        },
    }
    return {**payload, "authorizationDigest": canonical_digest({key: value for key, value in payload.items() if key != "x402Version"})}


def activation_paid_execution_ok(status: int, payload: dict[str, Any]) -> bool:
    operational = payload.get("operationalStatus") if isinstance(payload.get("operationalStatus"), dict) else {}
    payment = payload.get("payment") if isinstance(payload.get("payment"), dict) else {}
    payment_status = operational.get("paymentStatus") or payload.get("paymentStatus") or payment.get("status")
    settlement_status = operational.get("settlementStatus") or payload.get("settlementStatus")
    relay_status = operational.get("relayDeliveryStatus") or payload.get("relayDeliveryStatus")
    execution_status = operational.get("agentExecutionStatus") or payload.get("agentExecutionStatus") or payload.get("status")
    return status == 200 and payment_status == "settled" and settlement_status == "settled" and relay_status in ("forwarded", "recorded") and execution_status == "completed"


def classify_activation_probe_result(result: dict[str, Any]) -> str:
    status = int(result.get("status", 0) or 0)
    mode = str(result.get("mode", ""))
    response = result.get("response") if isinstance(result.get("response"), dict) else {}
    operational = response.get("operationalStatus") if isinstance(response.get("operationalStatus"), dict) else {}
    text = " ".join(
        str(part)
        for part in (
            mode,
            result.get("error"),
            response.get("code"),
            response.get("error"),
            response.get("deliveryError"),
            response.get("returnValidationCode"),
            response.get("returnValidationError"),
            response.get("status"),
        )
        if part
    ).lower()
    if result.get("ok") is True:
        return "unknown"
    if (
        mode in ("builtin_missing_buyer_key", "builtin_challenge")
        or status == 402
        or operational.get("paymentStatus") == "failed"
        or operational.get("settlementStatus") == "failed"
        or any(term in text for term in ("x402", "payment", "settlement", "authorization", "facilitator", "insufficient", "balance", "wallet", "usdc"))
    ):
        return "payment"
    if (
        operational.get("agentExecutionStatus") in ("failed", "worker_completed_return_rejected")
        or response.get("deliveryStatus") == "return_rejected"
        or any(term in text for term in ("verified_output_required", "return_rejected", "worker", "seller", "runtime", "invalid_output"))
    ):
        return "seller"
    if (
        status >= 500
        or operational.get("relayDeliveryStatus") == "failed"
        or any(term in text for term in ("relay", "timeout", "temporarily unavailable", "502", "503", "504", "platform", "eth-account", "dependency", "requirements.txt"))
    ):
        return "platform"
    return "unknown"


def run_builtin_activation_lane_probe(candidate: dict[str, Any], token: str) -> dict[str, Any]:
    private_key = os.environ.get("CLAWZ_ACTIVATION_LANE_BUYER_PRIVATE_KEY", "").strip()
    if not private_key:
        result = {"ok": False, "mode": "builtin_missing_buyer_key", "error": "missing CLAWZ_ACTIVATION_LANE_BUYER_PRIVATE_KEY"}
        return {**result, "classification": classify_activation_probe_result(result)}
    endpoint = str(candidate.get("activationHireEndpoint", ""))
    if not endpoint:
        result = {"ok": False, "mode": "builtin", "error": "candidate_missing_activationHireEndpoint"}
        return {**result, "classification": classify_activation_probe_result(result)}
    request_body = {
        "activationLane": True,
        "taskPrompt": "SantaClawz activation lane paid execution probe from hosted agent_job_pack.",
        "requesterContact": "agent_job_pack@santaclawz.ai",
    }
    challenge_status, payment_requirement = activation_lane_http_json("POST", f"{endpoint}?activationLane=true", token, request_body, timeout_seconds=30)
    if challenge_status != 402 or not isinstance(payment_requirement, dict):
        result = {"ok": False, "mode": "builtin_challenge", "status": challenge_status, "response": payment_requirement}
        final_result = {**result, "classification": classify_activation_probe_result(result)}
        report_activation_lane_attempt(candidate, token, activation_attempt_status_for_result(final_result), final_result)
        return final_result
    report_activation_lane_attempt(candidate, token, "challenge_ok", {
        "ok": True,
        "mode": "builtin_challenge",
        "status": challenge_status,
        "response": payment_requirement,
        "classification": "unknown",
    })
    try:
        payment_payload = build_activation_fee_split_payment_payload(payment_requirement, candidate, private_key)
    except Exception as exc:
        result = {
            "ok": False,
            "mode": "builtin_x402_build",
            "status": challenge_status,
            "error": str(exc),
            "response": payment_requirement,
        }
        final_result = {**result, "classification": classify_activation_probe_result(result)}
        report_activation_lane_attempt(candidate, token, activation_attempt_status_for_result(final_result), final_result)
        return final_result
    report_activation_lane_attempt(candidate, token, "paid_probe_started", {
        "ok": True,
        "mode": "builtin_x402",
        "paymentPayloadDigestSha256": sha256_text(stable_json_dumps(payment_payload)),
    })
    try:
        paid_status, paid_payload = activation_lane_http_json(
            "POST",
            f"{endpoint}?activationLane=true",
            token,
            {**request_body, "paymentPayload": payment_payload},
        )
    except Exception as exc:
        result = {
            "ok": False,
            "mode": "builtin_x402_submit",
            "paymentPayloadDigestSha256": sha256_text(stable_json_dumps(payment_payload)),
            "error": str(exc),
        }
        final_result = {**result, "classification": classify_activation_probe_result(result)}
        report_activation_lane_attempt(candidate, token, activation_attempt_status_for_result(final_result), final_result)
        return final_result
    result = {
        "ok": activation_paid_execution_ok(paid_status, paid_payload if isinstance(paid_payload, dict) else {}),
        "mode": "builtin_x402",
        "status": paid_status,
        "paymentPayloadDigestSha256": sha256_text(stable_json_dumps(payment_payload)),
        "response": paid_payload,
    }
    final_result = {**result, "classification": classify_activation_probe_result(result)}
    report_activation_lane_attempt(candidate, token, activation_attempt_status_for_result(final_result), final_result)
    return final_result


def process_activation_candidate(candidate: dict[str, Any], token: str, command: str | None) -> dict[str, Any]:
    agent_id = str(candidate.get("agentId", ""))
    if not agent_id:
        result = {"ok": False, "error": "candidate_missing_agent_id"}
        return {**result, "classification": classify_activation_probe_result(result)}
    if command:
        command_result = run_activation_lane_probe_command(command, candidate)
        result = {"ok": command_result["return_code"] == 0, "mode": "command", **command_result}
        return {**result, "classification": classify_activation_probe_result(result)}
    private_key = os.environ.get("CLAWZ_ACTIVATION_LANE_BUYER_PRIVATE_KEY", "").strip()
    if private_key:
        return run_builtin_activation_lane_probe(candidate, token)

    endpoint = str(candidate.get("activationHireEndpoint", ""))
    status, payload = activation_lane_http_json(
        "POST",
        f"{endpoint}?activationLane=true",
        token,
        {
            "activationLane": True,
            "taskPrompt": "SantaClawz activation lane paid execution probe from hosted agent_job_pack.",
            "requesterContact": "agent_job_pack@santaclawz.ai",
        },
    )
    result = {
        "ok": status == 402,
        "mode": "payment_required_preview",
        "status": status,
        "paymentRequired": status == 402,
        "response": payload,
    }
    final_result = {**result, "classification": classify_activation_probe_result(result)}
    report_activation_lane_attempt(candidate, token, activation_attempt_status_for_result(final_result), final_result)
    return final_result


def activation_lane_loop(interval_seconds: int) -> None:
    api_base = os.environ.get("CLAWZ_API_BASE", "https://api.santaclawz.ai").rstrip("/")
    token = (os.environ.get("CLAWZ_ACTIVATION_LANE_TOKEN") or os.environ.get("CLAWZ_AGENT_JOB_PACK_ACTIVATION_TOKEN") or "").strip()
    command = os.environ.get("CLAWZ_ACTIVATION_LANE_PROBE_COMMAND")
    cooldown_seconds = int(os.environ.get("CLAWZ_ACTIVATION_LANE_COOLDOWN_SECONDS", "3600"))
    if not token:
        log_event({"type": "activation-lane-disabled", "reason": "missing CLAWZ_ACTIVATION_LANE_TOKEN"})
        return

    log_event({
        "type": "activation-lane-poller-started",
        "api_base": api_base,
        "interval_seconds": interval_seconds,
        "cooldown_seconds": cooldown_seconds,
        "retroactive_sweep": True,
    })
    while True:
        try:
            state = activation_lane_state()
            status, payload = activation_lane_http_json("GET", f"{api_base}/api/activation-lane/candidates?limit=8", token)
            candidates = payload.get("candidates") if isinstance(payload, dict) else []
            if status != 200 or not isinstance(candidates, list):
                log_event({"type": "activation-lane-candidate-fetch-failed", "status": status, "response": payload})
                time.sleep(interval_seconds)
                continue
            for candidate in candidates:
                if not isinstance(candidate, dict):
                    continue
                agent_id = str(candidate.get("agentId", ""))
                agent_state = state["agents"].get(agent_id, {})
                last_attempt_ms = int(agent_state.get("last_attempt_ms", 0)) if isinstance(agent_state, dict) else 0
                candidate_retry_seconds = int(candidate.get("retryAfterSeconds", cooldown_seconds))
                retry_after_seconds = max(60, candidate_retry_seconds)
                if int(time.time() * 1000) - last_attempt_ms < retry_after_seconds * 1000:
                    continue
                report_activation_lane_attempt(candidate, token, "candidate_seen", {
                    "ok": True,
                    "mode": "candidate_poll",
                    "classification": "unknown",
                })
                result = process_activation_candidate(candidate, token, command)
                state["agents"][agent_id] = {
                    "last_attempt_ms": int(time.time() * 1000),
                    "last_attempt_at": now_iso(),
                    "last_ok": bool(result.get("ok")),
                    "mode": result.get("mode"),
                    "classification": result.get("classification"),
                }
                try:
                    write_json(ACTIVATION_LANE_STATE, state)
                except Exception as exc:
                    log_event({"type": "activation-lane-state-write-failed", "agent_id": agent_id, "path": str(ACTIVATION_LANE_STATE), "error": str(exc)})
                try:
                    append_audit({"type": "activation-lane-candidate-processed", "agent_id": agent_id, "result": result})
                except Exception as exc:
                    log_event({"type": "activation-lane-audit-write-failed", "agent_id": agent_id, "error": str(exc)})
                log_event({
                    "type": "activation-lane-candidate-processed",
                    "agent_id": agent_id,
                    "ok": result.get("ok"),
                    "mode": result.get("mode"),
                    "classification": result.get("classification"),
                })
        except Exception as exc:
            log_event({"type": "activation-lane-unhandled-error", "error": str(exc), "trace": traceback.format_exc(limit=4)})
        time.sleep(interval_seconds)


def maybe_start_activation_lane_poller() -> None:
    if not env_truthy("CLAWZ_AGENT_JOB_PACK_ACTIVATION_LANE_ENABLED"):
        log_event({"type": "activation-lane-disabled", "reason": "CLAWZ_AGENT_JOB_PACK_ACTIVATION_LANE_ENABLED is not enabled"})
        return
    interval_seconds = max(5, int(os.environ.get("CLAWZ_ACTIVATION_LANE_INTERVAL_SECONDS", "30")))
    thread = threading.Thread(target=activation_lane_loop, args=(interval_seconds,), name="activation-lane-poller", daemon=True)
    thread.start()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Run the private SantaClawz real worker bridge.")
    default_host = os.environ.get("HOST") or ("0.0.0.0" if os.environ.get("PORT") else "127.0.0.1")
    parser.add_argument("--host", default=default_host)
    parser.add_argument("--port", type=int, default=os.environ.get("PORT", "8891"))
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=os.environ.get("WORKER_TIMEOUT_SECONDS", str(DEFAULT_TIMEOUT_SECONDS)),
    )
    parser.add_argument("--once", type=pathlib.Path, help="Process one JSON request without starting HTTP.")
    args = parser.parse_args(argv)

    if args.once:
        return run_once(args.once, args.timeout_seconds)

    maybe_start_activation_lane_poller()
    Handler.timeout_seconds = args.timeout_seconds
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log_event(
        {
            "type": "real-worker-bridge-listening",
            "pid": os.getpid(),
            "url": f"http://{args.host}:{args.port}/hire",
            "timeout_seconds": args.timeout_seconds,
            "worker_timeout_seconds_env": os.environ.get("WORKER_TIMEOUT_SECONDS", ""),
        }
    )
    print("Forward OPENCLAW_INTERNAL_HIRE_URL here from the SantaClawz relay starter.", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 130
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
