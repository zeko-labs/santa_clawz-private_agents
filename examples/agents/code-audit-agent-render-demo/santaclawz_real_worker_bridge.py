#!/usr/bin/env python3
"""Render-ready deterministic SantaClawz code-audit worker.

This worker is intentionally stateless. It accepts a SantaClawz /hire payload,
derives a small private code-audit report from the submitted text/files, and
returns a santaclawz-return/1.0 package with digest-addressed deliverables.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import secrets
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parent
DEFAULT_OUTPUT_ROOT = pathlib.Path(os.environ.get("CLAWZ_CODE_AUDIT_OUTPUT_DIR", str(ROOT / "output"))).expanduser()
DEFAULT_TIMEOUT_SECONDS = 45
MAX_TEXT_CHARS = 120_000


class WorkerError(Exception):
    def __init__(self, message: str, status_code: int = 500) -> None:
        super().__init__(message)
        self.status_code = status_code


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def stable_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def canonical_digest(value: Any) -> str:
    return sha256_text(stable_json(value))


def slug(value: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in value)
    return "-".join(part for part in cleaned.split("-") if part)[:96] or "request"


def write_json(path: pathlib.Path, payload: dict[str, Any]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    path.write_text(text, encoding="utf-8")
    return sha256_text(text)


def write_text(path: pathlib.Path, text: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return sha256_text(text)


def first_string(*values: Any, default: str = "") -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return default


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def collect_text(value: Any, *, depth: int = 0) -> list[tuple[str, str]]:
    if depth > 5:
        return []
    chunks: list[tuple[str, str]] = []
    if isinstance(value, str):
        if value.strip():
            chunks.append(("text", value[:MAX_TEXT_CHARS]))
    elif isinstance(value, list):
        for index, item in enumerate(value[:50]):
            for name, text in collect_text(item, depth=depth + 1):
                chunks.append((f"{index}:{name}", text))
    elif isinstance(value, dict):
        for key, item in value.items():
            lower = str(key).lower()
            if any(token in lower for token in ["code", "source", "file", "snippet", "diff", "content", "request", "brief", "prompt"]):
                for name, text in collect_text(item, depth=depth + 1):
                    chunks.append((f"{key}:{name}", text))
            elif depth < 2:
                chunks.extend(collect_text(item, depth=depth + 1))
    return chunks


def normalize_request(payload: dict[str, Any], raw_body: str) -> dict[str, Any]:
    input_block = as_dict(payload.get("input") or payload.get("job") or payload.get("request"))
    request_id = first_string(
        payload.get("request_id"),
        payload.get("requestId"),
        input_block.get("request_id"),
        default=f"code-audit-{secrets.token_hex(6)}",
    )
    title = first_string(
        input_block.get("title"),
        payload.get("title"),
        input_block.get("service"),
        default="Code audit request",
    )
    client_request = first_string(
        input_block.get("client_request"),
        input_block.get("brief"),
        input_block.get("prompt"),
        payload.get("brief"),
        payload.get("prompt"),
        default="Review the submitted code or technical material for security and correctness issues.",
    )
    text_chunks = collect_text(payload)
    if not text_chunks:
        text_chunks = [("client_request", client_request)]
    merged_text = "\n\n".join(f"## {name}\n{text}" for name, text in text_chunks)
    return {
        "request_id": request_id,
        "title": title,
        "client_request": client_request,
        "raw_body_digest_sha256": sha256_text(raw_body),
        "text": merged_text[:MAX_TEXT_CHARS],
        "text_digest_sha256": sha256_text(merged_text[:MAX_TEXT_CHARS]),
    }


AUDIT_RULES: list[tuple[str, str, str, str]] = [
    ("critical", r"\beval\s*\(|exec\s*\(|Function\s*\(", "Dynamic code execution detected.", "Avoid runtime code execution on untrusted input."),
    ("high", r"subprocess\.(Popen|run|call)|child_process\.(exec|spawn)", "Shell/process execution path detected.", "Guard command construction, sanitize arguments, and avoid shell=True."),
    ("high", r"verify\s*=\s*False|rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED", "TLS verification bypass detected.", "Do not disable TLS verification in production paths."),
    ("high", r"pickle\.loads?|yaml\.load\s*\(", "Unsafe deserialization pattern detected.", "Use safe parsers and trusted schemas."),
    ("medium", r"SELECT\s+.*\+|query\s*\(.*\+", "Possible SQL/string query construction.", "Use parameterized queries and typed query builders."),
    ("medium", r"password|api[_-]?key|secret|token|private[_-]?key", "Secret-sensitive terms detected in submitted material.", "Keep secrets out of source, logs, prompts, and public artifacts."),
    ("medium", r"TODO|FIXME|HACK", "Unresolved implementation marker detected.", "Track and resolve before production release."),
    ("low", r"console\.log|print\s*\(", "Debug logging detected.", "Confirm logs cannot expose private inputs or credentials."),
]


def audit_text(text: str) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    lowered = text.lower()
    for severity, pattern, title, recommendation in AUDIT_RULES:
        matches = list(re.finditer(pattern, text, flags=re.IGNORECASE | re.MULTILINE))
        if not matches:
            continue
        snippets = []
        for match in matches[:3]:
            start = max(0, match.start() - 80)
            end = min(len(text), match.end() + 80)
            snippets.append(re.sub(r"\s+", " ", text[start:end]).strip()[:240])
        findings.append(
            {
                "id": f"CAD-{len(findings) + 1:03d}",
                "severity": severity,
                "title": title,
                "match_count": len(matches),
                "evidence_snippets": snippets,
                "recommendation": recommendation,
            }
        )
    if "http://" in lowered:
        findings.append(
            {
                "id": f"CAD-{len(findings) + 1:03d}",
                "severity": "low",
                "title": "Plain HTTP reference detected.",
                "match_count": lowered.count("http://"),
                "evidence_snippets": [],
                "recommendation": "Prefer HTTPS endpoints unless an internal/private network policy explicitly allows HTTP.",
            }
        )
    severity_order = {"critical": 4, "high": 3, "medium": 2, "low": 1}
    highest = "none"
    if findings:
        highest = max(findings, key=lambda item: severity_order.get(str(item["severity"]), 0))["severity"]
    return {
        "schema_version": "code-audit-findings/1.0",
        "finding_count": len(findings),
        "highest_severity": highest,
        "findings": findings,
    }


def render_report(normalized: dict[str, Any], findings: dict[str, Any]) -> str:
    lines = [
        "# Code Audit Report",
        "",
        f"Request: `{normalized['request_id']}`",
        f"Generated: {now_iso()}",
        "",
        "## Scope",
        "",
        normalized["client_request"][:1500],
        "",
        "## Summary",
        "",
        f"- Findings: {findings['finding_count']}",
        f"- Highest severity: {findings['highest_severity']}",
        f"- Input digest: `{normalized['text_digest_sha256']}`",
        "",
        "## Findings",
        "",
    ]
    if not findings["findings"]:
        lines.append("No deterministic rule findings were detected in the submitted material.")
    for finding in findings["findings"]:
        lines.extend(
            [
                f"### {finding['id']} - {finding['title']}",
                "",
                f"- Severity: {finding['severity']}",
                f"- Matches: {finding['match_count']}",
                f"- Recommendation: {finding['recommendation']}",
                "",
            ]
        )
        for snippet in finding.get("evidence_snippets", []):
            lines.extend([f"> {snippet}", ""])
    lines.extend(
        [
            "## Verification",
            "",
            "This hosted worker returns digest-addressed artifacts and does not require model/API secrets.",
            "The report is deterministic for the submitted payload and current rule set.",
            "",
        ]
    )
    return "\n".join(lines)


def run_worker(payload: dict[str, Any], raw_body: str) -> tuple[dict[str, Any], dict[str, Any]]:
    normalized = normalize_request(payload, raw_body)
    created_at = now_iso()
    run_dir = DEFAULT_OUTPUT_ROOT / f"{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d-%H%M%S')}-{slug(normalized['request_id'])}"
    package_dir = run_dir / "output_package"
    package_dir.mkdir(parents=True, exist_ok=False)

    findings = audit_text(normalized["text"])
    report = render_report(normalized, findings)
    summary = (
        f"Deterministic code audit completed. Findings: {findings['finding_count']}; "
        f"highest severity: {findings['highest_severity']}. Input digest: {normalized['text_digest_sha256']}."
    )

    files = [
        ("audit_report.md", report, "text/markdown"),
        ("findings.json", json.dumps(findings, indent=2, sort_keys=True) + "\n", "application/json"),
        (
            "scope_summary.json",
            json.dumps(
                {
                    "schema_version": "code-audit-scope/1.0",
                    "request_id": normalized["request_id"],
                    "title": normalized["title"],
                    "input_digest_sha256": normalized["text_digest_sha256"],
                    "raw_body_digest_sha256": normalized["raw_body_digest_sha256"],
                    "submitted_text_chars": len(normalized["text"]),
                    "created_at": created_at,
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            "application/json",
        ),
    ]

    deliverables: list[dict[str, Any]] = []
    file_hashes: dict[str, str] = {}
    for name, contents, content_type in files:
        digest = write_text(package_dir / name, contents)
        file_hashes[name] = digest
        deliverables.append(
            {
                "name": name,
                "path": str(package_dir / name),
                "sha256": digest,
                "content_type": content_type,
                "size_bytes": len(contents.encode("utf-8")),
            }
        )

    package_hash = sha256_text(stable_json(file_hashes))
    manifest = {
        "schema_version": "santaclawz-verification-manifest/1.0",
        "request_id": normalized["request_id"],
        "created_at": created_at,
        "agent": "code-audit-agent-render-demo",
        "input_digest_sha256": normalized["raw_body_digest_sha256"],
        "package_hash": package_hash,
        "checks_performed": [
            "deterministic_code_audit_rules_applied",
            "deliverables_hashed",
            "manifest_written",
            "santaclawz_return_payload_written",
        ],
        "files_produced": [
            {
                "name": item["name"],
                "sha256": item["sha256"],
                "content_type": item["content_type"],
                "size_bytes": item["size_bytes"],
            }
            for item in deliverables
        ],
        "finding_summary": {
            "finding_count": findings["finding_count"],
            "highest_severity": findings["highest_severity"],
        },
    }
    verification_manifest_digest_sha256 = canonical_digest(manifest)
    zeko_attestation = {
        "schema_version": "santaclawz-zk-attestation-preview/1.1",
        "request_id": normalized["request_id"],
        "package_hash": package_hash,
        "verification_manifest_digest_sha256": verification_manifest_digest_sha256,
        "generated_at": created_at,
    }
    receipt = {
        "schema_version": "santaclawz-run-receipt/1.0",
        "request_id": normalized["request_id"],
        "status": "completed",
        "run_dir": str(run_dir),
        "package_hash": package_hash,
        "created_at": created_at,
    }

    write_json(run_dir / "verification_manifest.json", manifest)
    write_json(run_dir / "zeko_attestation_payload.json", zeko_attestation)
    write_json(run_dir / "run_receipt.json", receipt)

    return_payload = {
        "schema_version": "santaclawz-return/1.0",
        "request_id": normalized["request_id"],
        "status": "completed",
        "return_channel": "santaclawz",
        "agent_private": True,
        "execution_mode": "deterministic-hosted-code-audit",
        "real_work_executed": True,
        "buyer_visible": True,
        "completed_at": created_at,
        "verified_output": {
            "package_hash": package_hash,
            "hash_algorithm": "sha256",
            "verification_manifest": manifest,
            "verification_manifest_digest_sha256": verification_manifest_digest_sha256,
            "zeko_attestation": zeko_attestation,
            "deliverables": deliverables,
            "buyer_visible_outputs": [
                {
                    "name": "code-audit-summary.md",
                    "content_type": "text/markdown",
                    "text": summary,
                    "sha256": sha256_text(summary),
                }
            ],
        },
        "zeko_attestation_payload": zeko_attestation,
    }
    write_json(run_dir / "santaclawz_return_payload.json", return_payload)

    quality = {
        "schema_version": "santaclawz-real-worker-quality/1.0",
        "run_dir": str(run_dir),
        "checked_at": now_iso(),
        "real_work_executed": True,
        "deliverable_count": len(deliverables),
        "package_hash": package_hash,
        "highest_severity": findings["highest_severity"],
        "finding_count": findings["finding_count"],
    }
    log_event(
        {
            "type": "code-audit-worker-completed",
            "request_id": normalized["request_id"],
            "deliverable_count": len(deliverables),
            "package_hash": package_hash,
            "finding_count": findings["finding_count"],
            "highest_severity": findings["highest_severity"],
        }
    )
    return return_payload, quality


def log_event(event: dict[str, Any]) -> None:
    event.setdefault("created_at", now_iso())
    print(json.dumps(event, sort_keys=True), file=sys.stderr, flush=True)


def failure_payload(message: str, status_code: int, request_id: str | None = None) -> dict[str, Any]:
    return {
        "schema_version": "santaclawz-return/1.0",
        "request_id": request_id,
        "status": "failed",
        "return_channel": "santaclawz",
        "agent_private": True,
        "error": {
            "code": "code_audit_worker_failed",
            "message": message,
            "status_code": status_code,
        },
        "verified_output": {
            "deliverables": [],
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
        body = stable_json(payload).encode("utf-8")
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
                "service": "santaclawz-code-audit-worker",
                "schema_version": "santaclawz-code-audit-worker/1.0",
                "hireEndpoint": "/hire",
                "state": "stateless",
                "usesModelSecrets": False,
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
            if not isinstance(payload, dict):
                raise WorkerError("hire payload must be a JSON object", 400)
            request_id = first_string(request_id, payload.get("request_id"), payload.get("requestId"), default="")
            log_event(
                {
                    "type": "code-audit-worker-received",
                    "request_id": request_id,
                    "body_bytes": len(body_bytes),
                    "body_sha256": sha256_text(raw_body),
                }
            )
            return_payload, _quality = run_worker(payload, raw_body)
            self.write_response(200, return_payload)
        except WorkerError as exc:
            log_event({"type": "code-audit-worker-failed", "request_id": request_id, "error": str(exc), "status_code": exc.status_code})
            self.write_response(exc.status_code, failure_payload(str(exc), exc.status_code, request_id))
        except Exception as exc:
            log_event({"type": "code-audit-worker-unhandled-error", "request_id": request_id, "error": str(exc), "trace": traceback.format_exc(limit=6)})
            self.write_response(500, failure_payload("unhandled code audit worker error", 500, request_id))


def run_once(path: pathlib.Path) -> int:
    payload = json.loads(path.read_text(encoding="utf-8"))
    raw_body = stable_json(payload)
    return_payload, quality = run_worker(payload, raw_body)
    print(json.dumps({"ok": True, "request_id": return_payload.get("request_id"), "quality": quality}, indent=2, sort_keys=True))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8892")))
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--once", type=pathlib.Path)
    args = parser.parse_args()
    if args.once:
        return run_once(args.once)
    Handler.timeout_seconds = args.timeout_seconds
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log_event({"type": "code-audit-worker-started", "host": args.host, "port": args.port, "output_root": str(DEFAULT_OUTPUT_ROOT)})
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
