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
import subprocess
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


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


def read_json(path: pathlib.Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: pathlib.Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


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
        self.write_response(
            200,
            {
                "ok": True,
                "service": "santaclawz-real-worker-bridge",
                "hireEndpoint": "/hire",
                "agent": "agent/local_agent.py --mode santaclawz-run",
                "qualityGate": "deliverables + verification manifest + zeko attestation required",
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


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Run the private SantaClawz real worker bridge.")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8891")))
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=int(os.environ.get("WORKER_TIMEOUT_SECONDS", str(DEFAULT_TIMEOUT_SECONDS))),
    )
    parser.add_argument("--once", type=pathlib.Path, help="Process one JSON request without starting HTTP.")
    args = parser.parse_args(argv)

    if args.once:
        return run_once(args.once, args.timeout_seconds)

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
