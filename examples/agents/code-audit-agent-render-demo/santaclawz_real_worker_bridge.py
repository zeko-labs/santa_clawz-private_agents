#!/usr/bin/env python3
"""Render-ready SantaClawz code-audit web service.

This service accepts a SantaClawz /hire payload, produces a private code-audit
report, and returns a santaclawz-return/1.0 package with digest-addressed
deliverables. It keeps durable per-client/repo memory when configured with a
persistent memory directory, while staying deterministic if model access is not
available.
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
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parent
FALSE_ENV_VALUES = {"0", "false", "no", "off"}


def env_int(name: str, default: int, *, minimum: int | None = None, maximum: int | None = None) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


DEFAULT_OUTPUT_ROOT = pathlib.Path(os.environ.get("CLAWZ_CODE_AUDIT_OUTPUT_DIR", str(ROOT / "output"))).expanduser()
DEFAULT_MEMORY_ROOT = pathlib.Path(os.environ.get("CLAWZ_CODE_AUDIT_MEMORY_DIR", str(ROOT / "memory"))).expanduser()
DEFAULT_STATE_ROOT = pathlib.Path(os.environ.get("CLAWZ_CODE_AUDIT_STATE_DIR", str(ROOT / "state"))).expanduser()
DEFAULT_TIMEOUT_SECONDS = 45
MAX_TEXT_CHARS = 120_000
MAX_MODEL_TEXT_CHARS = env_int("CLAWZ_CODE_AUDIT_MODEL_TEXT_CHARS", 24000, minimum=2000, maximum=60000)
MAX_MEMORY_RUNS_PER_NAMESPACE = 40
MAX_MEMORY_FINDINGS_PER_NAMESPACE = 200
MAX_OPENAI_MEMORY_FINDINGS = 12
MAX_FINDING_LIMIT = env_int("CLAWZ_CODE_AUDIT_MAX_FINDING_LIMIT", 25, minimum=1, maximum=100)
FINDING_LIMIT = env_int(
    "CODE_AUDIT_FINDING_LIMIT",
    env_int("CLAWZ_CODE_AUDIT_FINDING_LIMIT", 10, minimum=1, maximum=MAX_FINDING_LIMIT),
    minimum=1,
    maximum=MAX_FINDING_LIMIT,
)
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.environ.get(
    "CODE_AUDIT_OPENAI_MODEL",
    os.environ.get("CLAWZ_CODE_AUDIT_OPENAI_MODEL", os.environ.get("OPENAI_MODEL", "gpt-5.5")),
).strip()
OPENAI_ENABLE_VALUE = os.environ.get("CODE_AUDIT_USE_OPENAI", os.environ.get("CLAWZ_CODE_AUDIT_ENABLE_OPENAI", "true"))
OPENAI_ENABLED = bool(OPENAI_API_KEY) and OPENAI_ENABLE_VALUE.lower() not in FALSE_ENV_VALUES
STANDARD_AUDIT_DISCLAIMER = (
    "This agent output is intended to streamline and prioritize the audit process. "
    "It does not replace a formal security audit, independent verification, or "
    "professional review before production deployment. Neither Zeko, SantaClawz, "
    "nor their contributors or operators are responsible for hacks, losses, missed "
    "vulnerabilities, or decisions made from this output."
)


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


def short_digest(value: str, length: int = 16) -> str:
    return sha256_text(value)[:length]


def slug(value: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in value)
    return "-".join(part for part in cleaned.split("-") if part)[:96] or "request"


def safe_slug(value: str, fallback: str = "default") -> str:
    output = slug(value)
    return output if output else fallback


def read_json(path: pathlib.Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return fallback
    except Exception:
        return fallback


def write_json_atomic(path: pathlib.Path, payload: dict[str, Any]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    temp_path = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    temp_path.write_text(text, encoding="utf-8")
    temp_path.replace(path)
    return sha256_text(text)


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


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


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


def nested_string(*values: Any, default: str = "") -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return default


def find_nested_string(value: Any, keys: set[str], *, depth: int = 0) -> str:
    if depth > 4:
        return ""
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).lower() in keys and isinstance(item, str) and item.strip():
                return item.strip()
        for item in value.values():
            found = find_nested_string(item, keys, depth=depth + 1)
            if found:
                return found
    if isinstance(value, list):
        for item in value[:20]:
            found = find_nested_string(item, keys, depth=depth + 1)
            if found:
                return found
    return ""


def extract_namespace(payload: dict[str, Any], normalized: dict[str, Any]) -> dict[str, Any]:
    input_block = as_dict(payload.get("input") or payload.get("job") or payload.get("request"))
    requester = as_dict(payload.get("requester") or payload.get("buyer") or input_block.get("requester"))
    client_id = nested_string(
        input_block.get("client_id"),
        input_block.get("clientId"),
        input_block.get("tenant"),
        input_block.get("organization"),
        payload.get("client_id"),
        payload.get("clientId"),
        requester.get("id"),
        requester.get("name"),
        payload.get("requester_contact"),
        payload.get("requesterContact"),
        default=find_nested_string(payload, {"client_id", "clientid", "tenant", "organization", "org_id", "orgid"}),
    )
    repo_id = nested_string(
        input_block.get("repo"),
        input_block.get("repo_id"),
        input_block.get("repoId"),
        input_block.get("repository"),
        input_block.get("repository_url"),
        input_block.get("repositoryUrl"),
        payload.get("repo"),
        payload.get("repository"),
        default=find_nested_string(payload, {"repo", "repo_id", "repoid", "repository", "repository_url", "repositoryurl"}),
    )
    project_id = nested_string(
        input_block.get("project"),
        input_block.get("project_id"),
        input_block.get("projectId"),
        payload.get("project"),
        default=find_nested_string(payload, {"project", "project_id", "projectid"}),
    )
    if not client_id:
        client_id = f"client-{short_digest(normalized['title'] + normalized['raw_body_digest_sha256'], 10)}"
    if not repo_id:
        repo_id = f"repo-{short_digest(normalized['text_digest_sha256'], 10)}"
    namespace_key = safe_slug(f"{client_id}-{repo_id}-{project_id}", "default")
    return {
        "schema_version": "code-audit-namespace/1.0",
        "client_id": client_id,
        "repo_id": repo_id,
        "project_id": project_id,
        "namespace_key": namespace_key,
    }


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
    normalized = {
        "request_id": request_id,
        "title": title,
        "client_request": client_request,
        "raw_body_digest_sha256": sha256_text(raw_body),
        "text": merged_text[:MAX_TEXT_CHARS],
        "text_digest_sha256": sha256_text(merged_text[:MAX_TEXT_CHARS]),
    }
    normalized["namespace"] = extract_namespace(payload, normalized)
    return normalized


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


SEVERITY_SCORE = {"critical": 4, "high": 3, "medium": 2, "low": 1, "none": 0}


def finding_fingerprint(finding: dict[str, Any]) -> str:
    snippets = "|".join(str(item) for item in as_list(finding.get("evidence_snippets"))[:2])
    basis = {
        "severity": finding.get("severity"),
        "title": finding.get("title"),
        "recommendation": finding.get("recommendation"),
        "snippet_digest": short_digest(snippets, 20),
    }
    return canonical_digest(basis)[:24]


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
        finding = {
            "id": f"CAD-{len(findings) + 1:03d}",
            "severity": severity,
            "category": slug(title),
            "title": title,
            "match_count": len(matches),
            "evidence_snippets": snippets,
            "recommendation": recommendation,
        }
        finding["fingerprint"] = finding_fingerprint(finding)
        findings.append(finding)
    if "http://" in lowered:
        finding = {
            "id": f"CAD-{len(findings) + 1:03d}",
            "severity": "low",
            "category": "plain-http-reference-detected",
            "title": "Plain HTTP reference detected.",
            "match_count": lowered.count("http://"),
            "evidence_snippets": [],
            "recommendation": "Prefer HTTPS endpoints unless an internal/private network policy explicitly allows HTTP.",
        }
        finding["fingerprint"] = finding_fingerprint(finding)
        findings.append(finding)
    highest = "none"
    if findings:
        highest = max(findings, key=lambda item: SEVERITY_SCORE.get(str(item["severity"]), 0))["severity"]
    return {
        "schema_version": "code-audit-findings/1.0",
        "finding_count": len(findings),
        "highest_severity": highest,
        "findings": findings,
    }


def empty_memory() -> dict[str, Any]:
    return {
        "schema_version": "code-audit-memory/0.2",
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "total_runs": 0,
        "accepted": [],
        "rejected": [],
        "namespaces": {},
    }


def memory_path() -> pathlib.Path:
    return DEFAULT_MEMORY_ROOT / "audit_memory.json"


def namespace_memory_path(namespace_key: str) -> pathlib.Path:
    return DEFAULT_MEMORY_ROOT / "namespaces" / safe_slug(namespace_key) / "memory.json"


def load_memory() -> dict[str, Any]:
    memory = read_json(memory_path(), empty_memory())
    if not isinstance(memory, dict):
        memory = empty_memory()
    memory.setdefault("schema_version", "code-audit-memory/0.2")
    memory.setdefault("created_at", now_iso())
    memory.setdefault("updated_at", now_iso())
    memory.setdefault("total_runs", int(memory.get("runs", 0) or 0))
    memory.setdefault("accepted", [])
    memory.setdefault("rejected", [])
    memory.setdefault("namespaces", {})
    return memory


def rejected_finding_titles(memory: dict[str, Any]) -> set[str]:
    rejected: set[str] = set()
    for item in as_list(memory.get("rejected")):
        if isinstance(item, str):
            rejected.add(item.strip().lower())
        elif isinstance(item, dict):
            title = first_string(item.get("title"), item.get("finding_title"), default="")
            if title:
                rejected.add(title.lower())
    return rejected


def accepted_finding_titles(memory: dict[str, Any]) -> set[str]:
    accepted: set[str] = set()
    for item in as_list(memory.get("accepted")):
        if isinstance(item, str):
            accepted.add(item.strip().lower())
        elif isinstance(item, dict):
            title = first_string(item.get("title"), item.get("finding_title"), default="")
            if title:
                accepted.add(title.lower())
    return accepted


def namespace_record(memory: dict[str, Any], namespace: dict[str, Any]) -> dict[str, Any]:
    namespaces = as_dict(memory.setdefault("namespaces", {}))
    key = namespace["namespace_key"]
    record = as_dict(namespaces.get(key))
    if not record:
        record = {
            "schema_version": "code-audit-namespace-memory/0.1",
            "namespace": namespace,
            "run_count": 0,
            "created_at": now_iso(),
            "updated_at": now_iso(),
            "completed_runs": [],
            "finding_fingerprints": {},
            "recurring_categories": {},
            "last_depth_plan": [],
        }
        namespaces[key] = record
    record["namespace"] = namespace
    record.setdefault("completed_runs", [])
    record.setdefault("finding_fingerprints", {})
    record.setdefault("recurring_categories", {})
    record.setdefault("last_depth_plan", [])
    return record


def apply_memory_to_findings(findings: dict[str, Any], memory: dict[str, Any], namespace: dict[str, Any]) -> dict[str, Any]:
    record = namespace_record(memory, namespace)
    known = as_dict(record.get("finding_fingerprints"))
    rejected_titles = rejected_finding_titles(memory)
    accepted_titles = accepted_finding_titles(memory)
    active: list[dict[str, Any]] = []
    suppressed: list[dict[str, Any]] = []
    for finding in as_list(findings.get("findings")):
        if not isinstance(finding, dict):
            continue
        title = str(finding.get("title", "")).lower()
        fingerprint = str(finding.get("fingerprint") or finding_fingerprint(finding))
        prior = as_dict(known.get(fingerprint))
        occurrence_count = int(prior.get("count", 0) or 0)
        delivered_count = int(prior.get("delivered_count", occurrence_count) or 0)
        finding["fingerprint"] = fingerprint
        finding["memory"] = {
            "status": "repeat" if occurrence_count > 0 else "new",
            "prior_count": occurrence_count,
            "delivered_before": delivered_count > 0,
            "delivered_count": delivered_count,
            "accepted_pattern": title in accepted_titles,
            "rejected_pattern": title in rejected_titles,
        }
        if title in rejected_titles:
            suppressed.append(finding)
            continue
        active.append(finding)
    active.sort(
        key=lambda item: (
            SEVERITY_SCORE.get(str(item.get("severity")), 0),
            1 if as_dict(item.get("memory")).get("status") == "new" else 0,
            int(item.get("match_count", 0) or 0),
        ),
        reverse=True,
    )
    highest = "none"
    if active:
        highest = max(active, key=lambda item: SEVERITY_SCORE.get(str(item.get("severity")), 0)).get("severity", "none")
    return {
        **findings,
        "schema_version": "code-audit-findings/1.1",
        "finding_count": len(active),
        "highest_severity": highest,
        "findings": active,
        "suppressed_findings": suppressed,
        "suppressed_count": len(suppressed),
    }


def select_findings_for_delivery(findings: dict[str, Any]) -> dict[str, Any]:
    active = [item for item in as_list(findings.get("findings")) if isinstance(item, dict)]
    fresh = [item for item in active if not as_dict(item.get("memory")).get("delivered_before")]
    repeats = [item for item in active if as_dict(item.get("memory")).get("delivered_before")]
    selected = (fresh + repeats)[:FINDING_LIMIT]
    deferred_count = max(0, len(active) - len(selected))
    for index, finding in enumerate(selected, start=1):
        finding["delivery"] = {
            "status": "returned",
            "batch_position": index,
            "batch_limit": FINDING_LIMIT,
            "prior_delivery_count": as_dict(finding.get("memory")).get("delivered_count", 0),
        }
    highest = "none"
    if selected:
        highest = max(selected, key=lambda item: SEVERITY_SCORE.get(str(item.get("severity")), 0)).get("severity", "none")
    return {
        **findings,
        "schema_version": "code-audit-findings/1.2",
        "finding_count": len(selected),
        "returned_finding_count": len(selected),
        "total_active_finding_count": len(active),
        "deferred_count": deferred_count,
        "has_more_findings": deferred_count > 0,
        "finding_limit": FINDING_LIMIT,
        "next_batch_hint": (
            "Run the audit again with the same client/repo namespace to continue with the next prioritized findings."
            if deferred_count > 0
            else ""
        ),
        "highest_severity": highest,
        "findings": selected,
    }


def depth_plan_from_memory(record: dict[str, Any], findings: dict[str, Any]) -> list[str]:
    categories = as_dict(record.get("recurring_categories"))
    sorted_categories = sorted(categories.items(), key=lambda item: int(as_dict(item[1]).get("count", 0) or 0), reverse=True)
    plan: list[str] = []
    for category, data in sorted_categories[:3]:
        title = first_string(as_dict(data).get("title"), default=category.replace("-", " ")).rstrip(".")
        plan.append(f"Re-check recurring area: {title}.")
    for finding in as_list(findings.get("findings"))[:3]:
        if as_dict(finding.get("memory")).get("status") == "new":
            title = str(finding.get("title", "finding")).rstrip(".")
            plan.append(f"Follow up on new {finding.get('severity')} finding: {title}.")
    if not plan:
        plan.append("No recurring issue class yet; continue broad baseline coverage.")
    return plan[:5]


def update_memory_after_run(memory: dict[str, Any], normalized: dict[str, Any], findings: dict[str, Any], package_hash: str) -> dict[str, Any]:
    namespace = as_dict(normalized.get("namespace"))
    record = namespace_record(memory, namespace)
    now = now_iso()
    memory["schema_version"] = "code-audit-memory/0.2"
    memory["updated_at"] = now
    memory["total_runs"] = int(memory.get("total_runs", 0) or 0) + 1
    memory["runs"] = memory["total_runs"]
    record["updated_at"] = now
    record["run_count"] = int(record.get("run_count", 0) or 0) + 1
    record["last_request_id"] = normalized["request_id"]
    record["last_input_digest_sha256"] = normalized["text_digest_sha256"]
    record["last_package_hash"] = package_hash
    known = as_dict(record.setdefault("finding_fingerprints", {}))
    categories = as_dict(record.setdefault("recurring_categories", {}))
    for finding in as_list(findings.get("findings")):
        fingerprint = str(finding.get("fingerprint") or finding_fingerprint(finding))
        category = str(finding.get("category") or slug(str(finding.get("title", ""))))
        prior = as_dict(known.get(fingerprint))
        prior_delivered_count = int(prior.get("delivered_count", prior.get("count", 0)) or 0)
        known[fingerprint] = {
            "fingerprint": fingerprint,
            "title": finding.get("title"),
            "category": category,
            "severity": finding.get("severity"),
            "recommendation": finding.get("recommendation"),
            "count": int(prior.get("count", 0) or 0) + 1,
            "delivered_count": prior_delivered_count + 1,
            "first_seen_at": prior.get("first_seen_at") or now,
            "last_seen_at": now,
            "first_delivered_at": prior.get("first_delivered_at") or now,
            "last_delivered_at": now,
            "last_request_id": normalized["request_id"],
        }
        category_record = as_dict(categories.get(category))
        categories[category] = {
            "title": finding.get("title"),
            "severity": finding.get("severity"),
            "count": int(category_record.get("count", 0) or 0) + 1,
            "last_seen_at": now,
        }
    if len(known) > MAX_MEMORY_FINDINGS_PER_NAMESPACE:
        kept = sorted(known.values(), key=lambda item: str(as_dict(item).get("last_seen_at", "")), reverse=True)[:MAX_MEMORY_FINDINGS_PER_NAMESPACE]
        record["finding_fingerprints"] = {str(item["fingerprint"]): item for item in kept if isinstance(item, dict) and item.get("fingerprint")}
    run_summary = {
        "request_id": normalized["request_id"],
        "created_at": now,
        "input_digest_sha256": normalized["text_digest_sha256"],
        "package_hash": package_hash,
        "finding_count": findings["finding_count"],
        "highest_severity": findings["highest_severity"],
        "finding_limit": findings.get("finding_limit"),
        "total_active_finding_count": findings.get("total_active_finding_count"),
        "deferred_count": findings.get("deferred_count", 0),
        "finding_fingerprints": [finding.get("fingerprint") for finding in as_list(findings.get("findings"))[:12]],
    }
    completed_runs = as_list(record.setdefault("completed_runs", []))
    completed_runs.append(run_summary)
    record["completed_runs"] = completed_runs[-MAX_MEMORY_RUNS_PER_NAMESPACE:]
    record["last_depth_plan"] = depth_plan_from_memory(record, findings)
    write_json_atomic(memory_path(), memory)
    write_json_atomic(namespace_memory_path(namespace["namespace_key"]), record)
    return {
        "schema_version": "code-audit-learning-update/1.0",
        "memory_path": str(memory_path()),
        "namespace_memory_path": str(namespace_memory_path(namespace["namespace_key"])),
        "namespace_key": namespace["namespace_key"],
        "namespace_run_count": record["run_count"],
        "total_runs": memory["total_runs"],
        "depth_plan": record["last_depth_plan"],
    }


def compact_memory_context(memory: dict[str, Any], namespace: dict[str, Any]) -> dict[str, Any]:
    record = namespace_record(memory, namespace)
    known = as_dict(record.get("finding_fingerprints"))
    known_recent = sorted(
        [item for item in known.values() if isinstance(item, dict)],
        key=lambda item: str(
            as_dict(item).get("last_delivered_at")
            or as_dict(item).get("last_seen_at")
            or as_dict(item).get("first_seen_at")
            or ""
        ),
        reverse=True,
    )[:MAX_OPENAI_MEMORY_FINDINGS]
    recurring = sorted(
        as_dict(record.get("recurring_categories")).values(),
        key=lambda item: int(as_dict(item).get("count", 0) or 0),
        reverse=True,
    )[:5]
    return {
        "schema_version": "code-audit-memory-context/1.0",
        "namespace": namespace,
        "total_runs": int(memory.get("total_runs", 0) or 0),
        "namespace_run_count": int(record.get("run_count", 0) or 0),
        "known_finding_count": len(known),
        "recent_runs": as_list(record.get("completed_runs"))[-5:],
        "recent_delivered_findings": [
            {
                "fingerprint": item.get("fingerprint"),
                "title": item.get("title"),
                "severity": item.get("severity"),
                "category": item.get("category"),
                "delivered_count": item.get("delivered_count", item.get("count", 0)),
                "last_delivered_at": item.get("last_delivered_at", item.get("last_seen_at")),
            }
            for item in known_recent
        ],
        "recurring_categories": recurring,
        "depth_plan": as_list(record.get("last_depth_plan")),
    }


def render_report(normalized: dict[str, Any], findings: dict[str, Any], memory_context: dict[str, Any], ai_insights: dict[str, Any]) -> str:
    lines = [
        "# Code Audit Report",
        "",
        f"Request: `{normalized['request_id']}`",
        f"Generated: {now_iso()}",
        "",
        "## Disclaimer",
        "",
        STANDARD_AUDIT_DISCLAIMER,
        "",
        "## Scope",
        "",
        normalized["client_request"][:1500],
        "",
        "## Summary",
        "",
        f"- Findings returned this run: {findings['finding_count']} of {findings.get('total_active_finding_count', findings['finding_count'])}",
        f"- Highest severity: {findings['highest_severity']}",
        f"- Batch limit: {findings.get('finding_limit', FINDING_LIMIT)} findings per run",
        f"- Deferred findings for a follow-up run: {findings.get('deferred_count', 0)}",
        f"- Input digest: `{normalized['text_digest_sha256']}`",
        f"- Client/repo namespace: `{as_dict(normalized.get('namespace')).get('namespace_key', 'default')}`",
        f"- Prior namespace runs: {memory_context.get('namespace_run_count', 0)}",
        "",
        "## Batch Behavior",
        "",
        (
            f"This run returns up to {findings.get('finding_limit', FINDING_LIMIT)} prioritized findings so the audit stays bounded. "
            "Run the same agent again with the same client/repo namespace to continue with the next batch."
        ),
        "",
        "## Memory Context",
        "",
        f"- Known finding fingerprints for this namespace: {memory_context.get('known_finding_count', 0)}",
        f"- Recent completed runs tracked: {len(as_list(memory_context.get('recent_runs')))}",
        "",
    ]
    depth_plan = as_list(memory_context.get("depth_plan"))
    if depth_plan:
        lines.extend(["Next-depth plan:", ""])
        for item in depth_plan[:5]:
            lines.append(f"- {item}")
        lines.append("")
    recurring = as_list(memory_context.get("recurring_categories"))
    if recurring:
        lines.extend(["Recurring issue classes:", ""])
        for item in recurring[:5]:
            if isinstance(item, dict):
                lines.append(f"- {item.get('title', 'Issue class')} ({item.get('count', 0)} observations)")
        lines.append("")
    if ai_insights.get("status") == "completed":
        lines.extend(["## Model Review", ""])
        model_findings = as_list(ai_insights.get("audit_insights"))
        if model_findings:
            lines.append("Model-assisted audit insights:")
            lines.append("")
            for item in model_findings[:5]:
                if isinstance(item, dict):
                    title = first_string(item.get("title"), default="Model insight")
                    severity = first_string(item.get("severity"), default="informational")
                    rationale = first_string(item.get("rationale"), item.get("reason"), default="")
                    lines.append(f"- {severity}: {title}{f' - {rationale}' if rationale else ''}")
            lines.append("")
        for item in as_list(ai_insights.get("prioritized_notes"))[:8]:
            lines.append(f"- {item}")
        if ai_insights.get("next_run_focus"):
            lines.extend(["", f"Suggested next-run focus: {ai_insights['next_run_focus']}", ""])
    elif ai_insights.get("status") in {"skipped", "error"}:
        lines.extend(["## Model Review", "", f"Model enrichment: {ai_insights.get('status')} ({ai_insights.get('reason', 'not available')}).", ""])
    lines.extend(
        [
        "## Findings",
        "",
        ]
    )
    if not findings["findings"]:
        lines.append("No deterministic rule findings were detected in the submitted material.")
    for finding in findings["findings"]:
        memory_status = as_dict(finding.get("memory")).get("status", "new")
        prior_count = as_dict(finding.get("memory")).get("prior_count", 0)
        lines.extend(
            [
                f"### {finding['id']} - {finding['title']}",
                "",
                f"- Severity: {finding['severity']}",
                f"- Matches: {finding['match_count']}",
                f"- Memory status: {memory_status} (prior count: {prior_count})",
                f"- Fingerprint: `{finding.get('fingerprint', '')}`",
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
            "This hosted code audit service returns digest-addressed artifacts and can enrich analysis with a private model when configured.",
            "The deterministic rule output, memory context, deliverables, and verification manifest are hashed for SantaClawz delivery.",
            "",
        ]
    )
    return "\n".join(lines)


def finding_for_model(finding: dict[str, Any]) -> dict[str, Any]:
    memory = as_dict(finding.get("memory"))
    return {
        "id": finding.get("id"),
        "severity": finding.get("severity"),
        "title": finding.get("title"),
        "category": finding.get("category"),
        "fingerprint": finding.get("fingerprint"),
        "match_count": finding.get("match_count"),
        "memory_status": memory.get("status"),
        "prior_count": memory.get("prior_count", 0),
        "delivered_before": memory.get("delivered_before", False),
        "recommendation": finding.get("recommendation"),
        "evidence_snippets": as_list(finding.get("evidence_snippets"))[:2],
    }


def build_openai_audit_context(normalized: dict[str, Any], findings: dict[str, Any], memory_context: dict[str, Any]) -> dict[str, Any]:
    current_fingerprints = {
        str(finding.get("fingerprint"))
        for finding in as_list(findings.get("findings"))
        if isinstance(finding, dict) and finding.get("fingerprint")
    }
    prior_delivered = [
        item
        for item in as_list(memory_context.get("recent_delivered_findings"))
        if isinstance(item, dict) and str(item.get("fingerprint")) not in current_fingerprints
    ][:MAX_OPENAI_MEMORY_FINDINGS]
    return {
        "schema_version": "code-audit-openai-context/1.0",
        "purpose": "Target the model pass to this run without repeating prior delivered audit work.",
        "repeat_policy": (
            "Do not restate prior delivered findings. If a current returned finding was delivered before, "
            "only add value when there is changed evidence, a sharper exploit path, a false-positive concern, "
            "or a better remediation."
        ),
        "namespace": as_dict(normalized.get("namespace")),
        "batch": {
            "finding_limit": findings.get("finding_limit"),
            "returned_finding_count": findings.get("returned_finding_count"),
            "total_active_finding_count": findings.get("total_active_finding_count"),
            "deferred_count": findings.get("deferred_count"),
            "has_more_findings": findings.get("has_more_findings"),
            "next_batch_hint": findings.get("next_batch_hint"),
        },
        "current_returned_findings": [
            finding_for_model(finding)
            for finding in as_list(findings.get("findings"))
            if isinstance(finding, dict)
        ],
        "prior_delivered_findings_to_avoid_repeating": prior_delivered,
        "recurring_issue_classes": as_list(memory_context.get("recurring_categories"))[:5],
        "next_depth_plan": as_list(memory_context.get("depth_plan"))[:5],
        "recent_run_count_for_namespace": memory_context.get("namespace_run_count", 0),
        "known_finding_count_for_namespace": memory_context.get("known_finding_count", 0),
    }


def extract_response_text(payload: dict[str, Any]) -> str:
    direct = payload.get("output_text")
    if isinstance(direct, str) and direct.strip():
        return direct
    parts: list[str] = []
    for item in as_list(payload.get("output")):
        if not isinstance(item, dict):
            continue
        for content in as_list(item.get("content")):
            if not isinstance(content, dict):
                continue
            text = content.get("text")
            if isinstance(text, str) and text.strip():
                parts.append(text)
                continue
            value = content.get("value")
            if isinstance(value, str) and value.strip():
                parts.append(value)
    return "\n".join(parts).strip()


def call_openai_for_insights(normalized: dict[str, Any], findings: dict[str, Any], memory_context: dict[str, Any]) -> dict[str, Any]:
    openai_context = build_openai_audit_context(normalized, findings, memory_context)
    context_digest = canonical_digest(openai_context)
    if not OPENAI_ENABLED:
        return {
            "schema_version": "code-audit-ai-insights/1.0",
            "status": "skipped",
            "reason": "OPENAI_API_KEY not configured or model enrichment disabled",
            "api": "responses",
            "model": OPENAI_MODEL,
            "openai_context_schema_version": openai_context["schema_version"],
            "openai_context_digest_sha256": context_digest,
        }
    prompt = (
        "Review the submitted code and the deterministic findings as a private code-audit model pass. "
        "Do not invent file paths, payment facts, proof facts, or inaccessible source files. "
        "Use the targeted audit context JSON to avoid repeating prior delivered work. "
        "Only revisit prior delivered findings if the submitted text materially changes the risk. "
        "Identify security-relevant insights from the supplied text, prioritize the returned batch, "
        "call out likely false positives, and suggest what to inspect in the next paid run.\n\n"
        f"Client request:\n{normalized['client_request'][:3000]}\n\n"
        f"Submitted text excerpt:\n{normalized['text'][:MAX_MODEL_TEXT_CHARS]}\n\n"
        f"Targeted audit context JSON:\n{stable_json(openai_context)}\n\n"
        "Return JSON with keys: audit_insights (array of objects with severity, title, rationale, "
        "recommendation, confidence), prioritized_notes (array of strings), next_run_focus (string), "
        "memory_updates (array of concise strings), risk_confidence (low|medium|high)."
    )
    request_payload = {
        "model": OPENAI_MODEL,
        "instructions": (
            "You write concise private code-audit intelligence for a SantaClawz hosted agent. "
            "Output only valid JSON. Treat deterministic findings as the proof-backed baseline and "
            "your model review as supplemental audit guidance."
        ),
        "input": prompt,
        "max_output_tokens": 2200,
        "text": {"format": {"type": "json_object"}},
    }
    request = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=stable_json(request_payload).encode("utf-8"),
        headers={
            "authorization": f"Bearer {OPENAI_API_KEY}",
            "content-type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
        content = extract_response_text(payload)
        parsed = json.loads(content)
        return {
            "schema_version": "code-audit-ai-insights/1.0",
            "status": "completed",
            "api": "responses",
            "model": OPENAI_MODEL,
            "openai_context_schema_version": openai_context["schema_version"],
            "openai_context_digest_sha256": context_digest,
            "audit_insights": [
                {
                    "severity": first_string(as_dict(item).get("severity"), default="informational"),
                    "title": first_string(as_dict(item).get("title"), default="Model insight")[:160],
                    "rationale": first_string(as_dict(item).get("rationale"), as_dict(item).get("reason"), default="")[:700],
                    "recommendation": first_string(as_dict(item).get("recommendation"), default="")[:700],
                    "confidence": first_string(as_dict(item).get("confidence"), default="medium"),
                }
                for item in as_list(parsed.get("audit_insights"))[:8]
                if isinstance(item, dict)
            ],
            "prioritized_notes": [str(item)[:500] for item in as_list(parsed.get("prioritized_notes"))[:8]],
            "next_run_focus": first_string(parsed.get("next_run_focus"), default=""),
            "memory_updates": [str(item)[:500] for item in as_list(parsed.get("memory_updates"))[:8]],
            "risk_confidence": first_string(parsed.get("risk_confidence"), default="medium"),
        }
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8")[:300]
        except Exception:
            detail = str(exc)[:300]
        return {
            "schema_version": "code-audit-ai-insights/1.0",
            "status": "error",
            "reason": f"OpenAI Responses API HTTP {exc.code}: {detail}",
            "api": "responses",
            "model": OPENAI_MODEL,
            "openai_context_schema_version": openai_context["schema_version"],
            "openai_context_digest_sha256": context_digest,
        }
    except (urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError) as exc:
        return {
            "schema_version": "code-audit-ai-insights/1.0",
            "status": "error",
            "reason": str(exc)[:300],
            "api": "responses",
            "model": OPENAI_MODEL,
            "openai_context_schema_version": openai_context["schema_version"],
            "openai_context_digest_sha256": context_digest,
        }


def run_worker(payload: dict[str, Any], raw_body: str) -> tuple[dict[str, Any], dict[str, Any]]:
    normalized = normalize_request(payload, raw_body)
    created_at = now_iso()
    run_dir = DEFAULT_OUTPUT_ROOT / f"{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d-%H%M%S')}-{slug(normalized['request_id'])}"
    package_dir = run_dir / "output_package"
    package_dir.mkdir(parents=True, exist_ok=False)

    memory = load_memory()
    memory_context = compact_memory_context(memory, as_dict(normalized["namespace"]))
    raw_findings = audit_text(normalized["text"])
    memory_ranked_findings = apply_memory_to_findings(raw_findings, memory, as_dict(normalized["namespace"]))
    findings = select_findings_for_delivery(memory_ranked_findings)
    ai_insights = call_openai_for_insights(normalized, findings, memory_context)
    report = render_report(normalized, findings, memory_context, ai_insights)
    summary = (
        f"Memory-backed code audit completed. Returned {findings['finding_count']} "
        f"of {findings.get('total_active_finding_count', findings['finding_count'])} prioritized findings; "
        f"highest severity: {findings['highest_severity']}; "
        f"prior namespace runs: {memory_context.get('namespace_run_count', 0)}. "
        f"{findings.get('next_batch_hint') + ' ' if findings.get('has_more_findings') else ''}"
        f"Input digest: {normalized['text_digest_sha256']}."
    )

    files = [
        ("audit_report.md", report, "text/markdown"),
        ("findings.json", json.dumps(findings, indent=2, sort_keys=True) + "\n", "application/json"),
        ("memory_context.json", json.dumps(memory_context, indent=2, sort_keys=True) + "\n", "application/json"),
        ("ai_insights.json", json.dumps(ai_insights, indent=2, sort_keys=True) + "\n", "application/json"),
        (
            "scope_summary.json",
            json.dumps(
                {
                    "schema_version": "code-audit-scope/1.0",
                    "request_id": normalized["request_id"],
                    "title": normalized["title"],
                    "namespace": normalized["namespace"],
                    "input_digest_sha256": normalized["text_digest_sha256"],
                    "raw_body_digest_sha256": normalized["raw_body_digest_sha256"],
                    "submitted_text_chars": len(normalized["text"]),
                    "finding_limit": findings.get("finding_limit"),
                    "returned_finding_count": findings.get("returned_finding_count"),
                    "total_active_finding_count": findings.get("total_active_finding_count"),
                    "deferred_count": findings.get("deferred_count"),
                    "has_more_findings": findings.get("has_more_findings"),
                    "memory_root": str(DEFAULT_MEMORY_ROOT),
                    "state_root": str(DEFAULT_STATE_ROOT),
                    "model_enrichment_status": ai_insights.get("status"),
                    "disclaimer": STANDARD_AUDIT_DISCLAIMER,
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
    learning_update = update_memory_after_run(memory, normalized, findings, package_hash)
    manifest = {
        "schema_version": "santaclawz-verification-manifest/1.0",
        "request_id": normalized["request_id"],
        "created_at": created_at,
        "agent": "hosted-code-audit-agent",
        "input_digest_sha256": normalized["raw_body_digest_sha256"],
        "package_hash": package_hash,
        "checks_performed": [
            "deterministic_code_audit_rules_applied",
            "durable_memory_context_applied",
            "learning_update_written",
            "deliverables_hashed",
            "manifest_written",
            "santaclawz_return_payload_written",
        ],
        "model_enrichment_status": ai_insights.get("status"),
        "memory": {
            "namespace_key": learning_update["namespace_key"],
            "namespace_run_count": learning_update["namespace_run_count"],
            "total_runs": learning_update["total_runs"],
        },
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
            "returned_finding_count": findings.get("returned_finding_count"),
            "total_active_finding_count": findings.get("total_active_finding_count"),
            "deferred_count": findings.get("deferred_count"),
            "finding_limit": findings.get("finding_limit"),
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
        "memory": learning_update,
    }

    write_json(run_dir / "verification_manifest.json", manifest)
    write_json(run_dir / "zeko_attestation_payload.json", zeko_attestation)
    write_json(run_dir / "learning_update.json", learning_update)
    write_json(run_dir / "run_receipt.json", receipt)
    write_json_atomic(DEFAULT_STATE_ROOT / "last_run.json", receipt)

    return_payload = {
        "schema_version": "santaclawz-return/1.0",
        "request_id": normalized["request_id"],
        "status": "completed",
        "return_channel": "santaclawz",
        "agent_private": True,
        "execution_mode": "memory-backed-hosted-code-audit",
        "real_work_executed": True,
        "buyer_visible": True,
        "completed_at": created_at,
        "disclaimer": STANDARD_AUDIT_DISCLAIMER,
        "verified_output": {
            "package_hash": package_hash,
            "hash_algorithm": "sha256",
            "disclaimer": STANDARD_AUDIT_DISCLAIMER,
            "verification_manifest": manifest,
            "verification_manifest_digest_sha256": verification_manifest_digest_sha256,
            "zeko_attestation": zeko_attestation,
            "memory_context": {
                "namespace_key": learning_update["namespace_key"],
                "namespace_run_count": learning_update["namespace_run_count"],
                "total_runs": learning_update["total_runs"],
                "depth_plan": learning_update["depth_plan"],
            },
            "model_enrichment_status": ai_insights.get("status"),
            "finding_batch": {
                "returned_finding_count": findings.get("returned_finding_count"),
                "total_active_finding_count": findings.get("total_active_finding_count"),
                "deferred_count": findings.get("deferred_count"),
                "finding_limit": findings.get("finding_limit"),
                "has_more_findings": findings.get("has_more_findings"),
                "next_batch_hint": findings.get("next_batch_hint"),
            },
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
        "returned_finding_count": findings.get("returned_finding_count"),
        "total_active_finding_count": findings.get("total_active_finding_count"),
        "deferred_count": findings.get("deferred_count"),
        "memory": learning_update,
        "model_enrichment_status": ai_insights.get("status"),
    }
    log_event(
        {
            "type": "code-audit-worker-completed",
            "request_id": normalized["request_id"],
            "deliverable_count": len(deliverables),
            "package_hash": package_hash,
            "finding_count": findings["finding_count"],
            "highest_severity": findings["highest_severity"],
            "namespace_key": learning_update["namespace_key"],
            "namespace_run_count": learning_update["namespace_run_count"],
            "model_enrichment_status": ai_insights.get("status"),
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


def apply_feedback(payload: dict[str, Any]) -> dict[str, Any]:
    memory = load_memory()
    namespace_key = first_string(payload.get("namespace_key"), payload.get("namespace"), default="")
    title = first_string(payload.get("title"), payload.get("finding_title"), default="")
    fingerprint = first_string(payload.get("fingerprint"), default="")
    label = first_string(payload.get("label"), payload.get("outcome"), default="").lower()
    note = first_string(payload.get("note"), default="")
    if label not in {"accepted", "useful", "rejected", "noisy", "false_positive", "resolved"}:
        raise WorkerError("feedback label must be accepted, useful, rejected, noisy, false_positive, or resolved", 400)
    bucket = "accepted" if label in {"accepted", "useful", "resolved"} else "rejected"
    entry = {
        "schema_version": "code-audit-feedback/1.0",
        "created_at": now_iso(),
        "label": label,
        "namespace_key": namespace_key,
        "title": title,
        "fingerprint": fingerprint,
        "note": note,
    }
    items = as_list(memory.setdefault(bucket, []))
    items.append(entry)
    memory[bucket] = items[-200:]
    memory["updated_at"] = now_iso()
    write_json_atomic(memory_path(), memory)
    if namespace_key:
        namespace_file = namespace_memory_path(namespace_key)
        record = read_json(namespace_file, {})
        if isinstance(record, dict):
            feedback = as_list(record.setdefault("feedback", []))
            feedback.append(entry)
            record["feedback"] = feedback[-200:]
            record["updated_at"] = now_iso()
            write_json_atomic(namespace_file, record)
    return {
        "ok": True,
        "schema_version": "code-audit-feedback-response/1.0",
        "bucket": bucket,
        "label": label,
        "memory_path": str(memory_path()),
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

    def do_HEAD(self) -> None:
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        self.write_response(
            200,
            {
                "ok": True,
                "service": "santaclawz-code-audit-worker",
                "schema_version": "santaclawz-code-audit-worker/1.1",
                "hireEndpoint": "/hire",
                "feedbackEndpoint": "/feedback",
                "state": "memory-backed",
                "usesModelSecrets": OPENAI_ENABLED,
                "model": OPENAI_MODEL if OPENAI_ENABLED else None,
                "outputRoot": str(DEFAULT_OUTPUT_ROOT),
                "memoryRoot": str(DEFAULT_MEMORY_ROOT),
                "stateRoot": str(DEFAULT_STATE_ROOT),
                "qualityGate": "deliverables + verification manifest + zeko attestation required",
            },
        )

    def do_POST(self) -> None:
        if self.path not in {"/hire", "/feedback"}:
            self.write_response(404, {"ok": False, "error": "not found"})
            return
        body_bytes = self.rfile.read(int(self.headers.get("content-length", "0")))
        raw_body = body_bytes.decode("utf-8")
        request_id = self.headers.get("x-santaclawz-request-id")
        try:
            payload = json.loads(raw_body)
            if not isinstance(payload, dict):
                raise WorkerError("hire payload must be a JSON object", 400)
            if self.path == "/feedback":
                self.write_response(200, apply_feedback(payload))
                return
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
