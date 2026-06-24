#!/usr/bin/env python3
"""Render-ready SantaClawz code-audit web service.

This service accepts a SantaClawz /hire payload, produces a private code-audit
report, and returns a santaclawz-return/1.0 package with digest-addressed
deliverables. It keeps durable buyer-scoped repo memory when configured with a
persistent memory directory, while staying deterministic if model access is not
available.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import io
import json
import os
import pathlib
import re
import secrets
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request
import zipfile
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
CODE_AUDIT_RULESET_VERSION = "code-audit-ruleset/1.4"
CODE_AUDIT_SCAN_PROFILE = "hosted-standard-prioritized-bounded"
MAX_TEXT_CHARS = 120_000
MAX_MATERIALIZED_TEXT_CHARS = env_int("CLAWZ_CODE_AUDIT_MATERIALIZED_TEXT_CHARS", 900000, minimum=50000, maximum=2_000_000)
MAX_REPO_ARCHIVE_BYTES = env_int("CLAWZ_CODE_AUDIT_REPO_ARCHIVE_BYTES", 30_000_000, minimum=1_000_000, maximum=100_000_000)
MAX_REPO_FILES_SCANNED = env_int("CLAWZ_CODE_AUDIT_REPO_FILES", 400, minimum=10, maximum=1000)
MAX_REPO_FILE_BYTES = env_int("CLAWZ_CODE_AUDIT_REPO_FILE_BYTES", 120000, minimum=2000, maximum=500000)
MAX_GITHUB_TARGET_BYTES = env_int("CLAWZ_CODE_AUDIT_GITHUB_TARGET_BYTES", 500000, minimum=20000, maximum=2_000_000)
MAX_MODEL_TEXT_CHARS = env_int("CLAWZ_CODE_AUDIT_MODEL_TEXT_CHARS", 24000, minimum=2000, maximum=60000)
MAX_MEMORY_RUNS_PER_NAMESPACE = 40
MAX_MEMORY_FINDINGS_PER_NAMESPACE = 200
MAX_OPENAI_MEMORY_FINDINGS = 12
BUYER_VISIBLE_TEXT_SOFT_LIMIT = 7600
MIN_HOSTED_FINDING_LIMIT = 10
MAX_FINDING_LIMIT = env_int("CLAWZ_CODE_AUDIT_MAX_FINDING_LIMIT", 25, minimum=MIN_HOSTED_FINDING_LIMIT, maximum=100)
FINDING_LIMIT = env_int(
    "CODE_AUDIT_FINDING_LIMIT",
    env_int("CLAWZ_CODE_AUDIT_FINDING_LIMIT", MIN_HOSTED_FINDING_LIMIT, minimum=MIN_HOSTED_FINDING_LIMIT, maximum=MAX_FINDING_LIMIT),
    minimum=MIN_HOSTED_FINDING_LIMIT,
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
SOURCE_EXTENSIONS = {
    ".c",
    ".cc",
    ".cpp",
    ".css",
    ".go",
    ".h",
    ".hpp",
    ".html",
    ".ini",
    ".java",
    ".js",
    ".jsx",
    ".json",
    ".mjs",
    ".php",
    ".py",
    ".rb",
    ".rs",
    ".sh",
    ".sol",
    ".sql",
    ".svelte",
    ".toml",
    ".ts",
    ".tsx",
    ".vue",
    ".xml",
    ".yaml",
    ".yml",
}
HIGH_SIGNAL_FILE_NAMES = {
    ".env",
    ".env.example",
    ".env.local",
    "Dockerfile",
    "Makefile",
    "Procfile",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "pyproject.toml",
    "requirements.txt",
    "poetry.lock",
    "cargo.toml",
    "go.mod",
    "go.sum",
}
HIGH_SIGNAL_PATH_TOKENS = {
    "admin",
    "api",
    "auth",
    "bridge",
    "checkout",
    "crypto",
    "decrypt",
    "encrypt",
    "facilitator",
    "hire",
    "kms",
    "middleware",
    "payment",
    "permission",
    "policy",
    "private",
    "relay",
    "route",
    "secret",
    "security",
    "server",
    "session",
    "settlement",
    "token",
    "upload",
    "wallet",
    "webhook",
    "worker",
    "x402",
}
SKIP_PATH_PARTS = {
    ".git",
    ".next",
    ".turbo",
    ".venv",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "vendor",
}


class WorkerError(Exception):
    def __init__(self, message: str, status_code: int = 500, code: str = "code_audit_worker_failed") -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code


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


def extract_urls(value: Any, *, depth: int = 0) -> list[str]:
    if depth > 6:
        return []
    urls: list[str] = []
    if isinstance(value, str):
        urls.extend(re.findall(r"https?://[^\s<>'\")\]]+", value))
    elif isinstance(value, list):
        for item in value[:100]:
            urls.extend(extract_urls(item, depth=depth + 1))
    elif isinstance(value, dict):
        for item in value.values():
            urls.extend(extract_urls(item, depth=depth + 1))
    deduped: list[str] = []
    seen: set[str] = set()
    for url in urls:
        cleaned = url.rstrip(".,;:")
        if cleaned not in seen:
            seen.add(cleaned)
            deduped.append(cleaned)
    return deduped


def parse_github_target_url(url: str) -> dict[str, str] | None:
    parsed = urllib.parse.urlparse(url)
    host = parsed.netloc.lower()
    if host not in {"github.com", "www.github.com"}:
        return None
    if parsed.scheme != "https":
        return None
    parts = [part for part in parsed.path.split("/") if part]
    if not parts:
        return None
    owner = parts[0]
    repo = parts[1] if len(parts) >= 2 else ""
    if repo.endswith(".git"):
        repo = repo[:-4]
    if not re.match(r"^[A-Za-z0-9_.-]+$", owner) or (repo and not re.match(r"^[A-Za-z0-9_.-]+$", repo)):
        return None
    target: dict[str, str] = {
        "owner": owner,
        "repo": repo,
        "ref": "",
        "path": "",
        "materialized_as": "page_text",
        "url": url,
    }
    if len(parts) == 2:
        target["materialized_as"] = "repo_archive"
        return target
    if len(parts) < 3:
        return target
    action = parts[2]
    if action in {"tree", "commit"} and len(parts) >= 4:
        target["materialized_as"] = "repo_archive"
        target["ref"] = "/".join(parts[3:])
        return target
    target["materialized_as"] = "page_text"
    target["path"] = "/".join(parts[2:] if len(parts) >= 2 else parts)
    return target


def fetch_limited_bytes(url: str, *, max_bytes: int, timeout: int = 20, accept: str = "application/zip,application/octet-stream,*/*") -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "accept": accept,
            "user-agent": "santaclawz-code-audit-agent/1.2",
        },
    )
    chunks: list[bytes] = []
    total = 0
    with urllib.request.urlopen(request, timeout=timeout) as response:
        while True:
            chunk = response.read(128 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise WorkerError(f"fetched GitHub target exceeded {max_bytes} bytes", 413)
            chunks.append(chunk)
    return b"".join(chunks)


def decode_web_text(data: bytes) -> str:
    return data.decode("utf-8", errors="replace")


def html_to_text(value: str) -> str:
    value = re.sub(r"(?is)<script\b[^>]*>.*?</script>", " ", value)
    value = re.sub(r"(?is)<style\b[^>]*>.*?</style>", " ", value)
    value = re.sub(r"(?s)<[^>]+>", " ", value)
    value = html.unescape(value)
    lines = [re.sub(r"\s+", " ", line).strip() for line in value.splitlines()]
    return "\n".join(line for line in lines if line)


def materialize_github_page_target(target: dict[str, str]) -> dict[str, Any]:
    errors: list[str] = []
    try:
        data = fetch_limited_bytes(
            target["url"],
            max_bytes=MAX_GITHUB_TARGET_BYTES,
            accept="text/plain,text/html,application/json,*/*",
        )
        text = html_to_text(decode_web_text(data))
    except urllib.error.HTTPError as exc:
        errors.append(f"{target['url']} -> HTTP {exc.code}")
        text = ""
        data = b""
    except Exception as exc:
        errors.append(f"{target['url']} -> {str(exc)[:160]}")
        text = ""
        data = b""
    skipped_counts = {
        "unsupported_path_or_extension": 0,
        "scan_file_limit": 0,
        "file_size_limit": 0,
        "binary_or_empty": 0 if text.strip() else 1,
    }
    files = []
    if text.strip():
        clipped = text[:MAX_GITHUB_TARGET_BYTES]
        files.append(
            {
                "path": f"github-page-{short_digest(target['url'], 8)}.txt",
                "bytes": len(clipped.encode("utf-8")),
                "sha256": hashlib.sha256(clipped.encode("utf-8")).hexdigest(),
                "line_count": clipped.count("\n") + 1,
                "content": clipped,
            }
        )
    return {
        "kind": "github_page_text",
        "materialized_as": "page_text",
        "source_url": target["url"],
        "fetch_url": target["url"],
        "owner": target["owner"],
        "repo": target["repo"],
        "ref": target.get("ref", ""),
        "path": target.get("path", ""),
        "status": "materialized" if files else "failed",
        "content_type": "text/html",
        "fetched_bytes": len(data),
        "scan_profile": CODE_AUDIT_SCAN_PROFILE,
        "ruleset_version": CODE_AUDIT_RULESET_VERSION,
        "files_seen": 1,
        "files_considered": 1,
        "files_scanned": len(files),
        "files_skipped": skipped_counts,
        "scan_truncated": len(text) > MAX_GITHUB_TARGET_BYTES,
        "max_target_bytes": MAX_GITHUB_TARGET_BYTES,
        "errors": errors[-5:],
        "files": files,
    }


def github_archive_candidates(target: dict[str, str]) -> list[str]:
    owner = urllib.parse.quote(target["owner"], safe="")
    repo = urllib.parse.quote(target["repo"], safe="")
    candidates: list[str] = []
    ref = target.get("ref", "").strip()
    if ref:
        quoted_ref = urllib.parse.quote(ref, safe="/")
        candidates.extend(
            [
                f"https://codeload.github.com/{owner}/{repo}/zip/refs/heads/{quoted_ref}",
                f"https://codeload.github.com/{owner}/{repo}/zip/{quoted_ref}",
            ]
        )
    candidates.extend(
        [
            f"https://codeload.github.com/{owner}/{repo}/zip/HEAD",
            f"https://codeload.github.com/{owner}/{repo}/zip/refs/heads/main",
            f"https://codeload.github.com/{owner}/{repo}/zip/refs/heads/master",
        ]
    )
    deduped: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if candidate not in seen:
            seen.add(candidate)
            deduped.append(candidate)
    return deduped


def should_scan_repo_path(path: str) -> bool:
    parts = [part for part in path.split("/") if part]
    if any(part in SKIP_PATH_PARTS for part in parts):
        return False
    suffix = pathlib.PurePosixPath(path).suffix.lower()
    if suffix in SOURCE_EXTENSIONS:
        return True
    return pathlib.PurePosixPath(path).name in {"Dockerfile", "Makefile", "Procfile"}


def scan_priority(path: str) -> int:
    pure = pathlib.PurePosixPath(path)
    lower_path = path.lower()
    name = pure.name
    lowered_name = name.lower()
    if name in HIGH_SIGNAL_FILE_NAMES or lowered_name in HIGH_SIGNAL_FILE_NAMES:
        return 0
    if any(token in lower_path for token in HIGH_SIGNAL_PATH_TOKENS):
        return 1
    if pure.suffix.lower() in {".sol", ".ts", ".tsx", ".js", ".mjs", ".py", ".go", ".rs"}:
        return 2
    if any(part in {"test", "tests", "__tests__", "spec", "fixtures", "docs"} for part in lower_path.split("/")):
        return 4
    return 3


def line_for_offset(text: str, offset: int) -> int:
    return text.count("\n", 0, max(0, offset)) + 1


def strip_archive_root(path: str) -> str:
    parts = [part for part in path.split("/") if part]
    if len(parts) > 1:
        return "/".join(parts[1:])
    return path


def decode_source_bytes(data: bytes) -> str:
    if b"\x00" in data[:4096]:
        return ""
    return data.decode("utf-8", errors="replace")


def materialize_github_target(target: dict[str, str]) -> dict[str, Any]:
    materialized_as = target.get("materialized_as", "repo_archive")
    if materialized_as == "page_text":
        return materialize_github_page_target(target)

    errors: list[str] = []
    archive_bytes: bytes | None = None
    archive_url = ""
    for candidate in github_archive_candidates(target):
        try:
            archive_bytes = fetch_limited_bytes(candidate, max_bytes=MAX_REPO_ARCHIVE_BYTES)
            archive_url = candidate
            break
        except urllib.error.HTTPError as exc:
            errors.append(f"{candidate} -> HTTP {exc.code}")
        except Exception as exc:
            errors.append(f"{candidate} -> {str(exc)[:160]}")
    if archive_bytes is None:
        page_target = {**target, "materialized_as": "page_text"}
        page_result = materialize_github_page_target(page_target)
        page_result["archive_errors"] = errors[-5:]
        return page_result

    files: list[dict[str, Any]] = []
    considered = 0
    seen_files = 0
    skipped_counts = {
        "unsupported_path_or_extension": 0,
        "scan_file_limit": 0,
        "file_size_limit": 0,
        "binary_or_empty": 0,
    }
    truncated = False
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        scan_candidates: list[tuple[int, str, zipfile.ZipInfo]] = []
        for info in archive.infolist():
            if info.is_dir():
                continue
            seen_files += 1
            path = strip_archive_root(info.filename)
            if not path or not should_scan_repo_path(path):
                skipped_counts["unsupported_path_or_extension"] += 1
                continue
            considered += 1
            scan_candidates.append((scan_priority(path), path, info))
        scan_candidates.sort(key=lambda item: (item[0], item[1]))
        for _, path, info in scan_candidates:
            if len(files) >= MAX_REPO_FILES_SCANNED:
                truncated = True
                skipped_counts["scan_file_limit"] += 1
                continue
            if info.file_size > MAX_REPO_FILE_BYTES:
                skipped_counts["file_size_limit"] += 1
                continue
            data = archive.read(info)
            text = decode_source_bytes(data)
            if not text.strip():
                skipped_counts["binary_or_empty"] += 1
                continue
            files.append(
                {
                    "path": path,
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "line_count": text.count("\n") + 1,
                    "content": text,
                }
            )
    return {
        "kind": "github_repo_archive",
        "materialized_as": materialized_as,
        "source_url": target["url"],
        "archive_url": archive_url,
        "owner": target["owner"],
        "repo": target["repo"],
        "ref": target.get("ref", ""),
        "status": "materialized",
        "archive_bytes": len(archive_bytes),
        "scan_profile": CODE_AUDIT_SCAN_PROFILE,
        "ruleset_version": CODE_AUDIT_RULESET_VERSION,
        "files_seen": seen_files,
        "files_considered": considered,
        "files_scanned": len(files),
        "files_skipped": skipped_counts,
        "scan_truncated": truncated,
        "max_files_scanned": MAX_REPO_FILES_SCANNED,
        "files": files,
    }


def materialize_external_targets(payload: dict[str, Any]) -> dict[str, Any]:
    urls = extract_urls(payload)
    github_targets: list[dict[str, str]] = []
    seen: set[str] = set()
    for url in urls:
        target = parse_github_target_url(url)
        if not target:
            continue
        key = f"{target['owner']}/{target['repo']}:{target.get('materialized_as', '')}:{target.get('ref', '')}:{target.get('path', '')}"
        if key in seen:
            continue
        seen.add(key)
        github_targets.append(target)
    targets = [materialize_github_target(target) for target in github_targets[:2]]
    files = [file for target in targets for file in as_list(target.get("files")) if isinstance(file, dict)]
    status = "not_requested"
    if targets:
        status = "materialized" if files else "failed"
    materialized_as_values = sorted(
        {
            str(target.get("materialized_as") or "page_text")
            for target in targets
            if isinstance(target, dict)
        }
    )
    return {
        "schema_version": "code-audit-target-materialization/1.0",
        "status": status,
        "urls": urls,
        "github_target_count": len(github_targets),
        "github_materialized_as": materialized_as_values,
        "targets": [
            {
                key: value
                for key, value in target.items()
                if key != "files"
            }
            for target in targets
        ],
        "files": files,
        "files_scanned": len(files),
        "scan_profile": CODE_AUDIT_SCAN_PROFILE,
        "ruleset_version": CODE_AUDIT_RULESET_VERSION,
        "files_considered": sum(int(target.get("files_considered", 0) or 0) for target in targets),
        "files_seen": sum(int(target.get("files_seen", 0) or 0) for target in targets),
        "files_skipped": {
            "unsupported_path_or_extension": sum(
                int(as_dict(target.get("files_skipped")).get("unsupported_path_or_extension", 0) or 0)
                for target in targets
            ),
            "scan_file_limit": sum(
                int(as_dict(target.get("files_skipped")).get("scan_file_limit", 0) or 0)
                for target in targets
            ),
            "file_size_limit": sum(
                int(as_dict(target.get("files_skipped")).get("file_size_limit", 0) or 0)
                for target in targets
            ),
            "binary_or_empty": sum(
                int(as_dict(target.get("files_skipped")).get("binary_or_empty", 0) or 0)
                for target in targets
            ),
        },
        "scan_truncated": any(bool(target.get("scan_truncated")) for target in targets),
    }


def require_public_github_target(materialized: dict[str, Any]) -> None:
    urls = [str(url) for url in as_list(materialized.get("urls"))]
    github_like_urls = [
        url for url in urls
        if urllib.parse.urlparse(url).netloc.lower() in {"github.com", "www.github.com"}
    ]
    github_target_count = int(materialized.get("github_target_count", 0) or 0)
    if github_target_count <= 0:
        if github_like_urls:
            raise WorkerError(
                "Hosted code audit requires a public https://github.com/... URL with a valid GitHub path.",
                400,
                "invalid_input",
            )
        raise WorkerError(
            "Hosted code audit requires a public https://github.com/... URL. Inline snippets, prose, uploaded files, and non-GitHub URLs are invalid for this agent.",
            400,
            "missing_required_input",
        )
    if materialized.get("status") == "materialized" and int(materialized.get("files_scanned", 0) or 0) > 0:
        return
    errors = []
    for target in as_list(materialized.get("targets")):
        if isinstance(target, dict):
            errors.extend(str(error) for error in as_list(target.get("errors")))
    if any("exceeded" in error.lower() for error in errors):
        raise WorkerError(
            "The public GitHub target is too large for this hosted fixed-price audit. Use a smaller GitHub target or a custom deep-audit agent.",
            413,
            "input_too_large",
        )
    raise WorkerError(
        "The provided GitHub URL could not be fetched or had no useful content to scan. Confirm it is public and reachable, then retry with a GitHub URL.",
        422,
        "input_unavailable",
    )


def nested_string(*values: Any, default: str = "") -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return default


def labeled_string(candidates: list[tuple[str, Any]]) -> tuple[str, str]:
    for label, value in candidates:
        if isinstance(value, str) and value.strip():
            return value.strip(), label
    return "", ""


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


def github_repo_id_from_payload(payload: dict[str, Any]) -> str:
    for url in extract_urls(payload):
        target = parse_github_target_url(url)
        if not target:
            continue
        repo_id = f"github:{target['owner']}/{target['repo']}" if target.get("repo") else f"github:url:{short_digest(url, 16)}"
        if target.get("ref"):
            repo_id = f"{repo_id}@{target['ref']}"
        return repo_id
    return ""


def extract_namespace(payload: dict[str, Any], normalized: dict[str, Any]) -> dict[str, Any]:
    input_block = as_dict(payload.get("input") or payload.get("job") or payload.get("request"))
    requester = as_dict(payload.get("requester") or payload.get("buyer") or input_block.get("requester"))
    nested_buyer_identity = find_nested_string(
        payload,
        {
            "buyer_agent_id",
            "buyeragentid",
            "buyer_id",
            "buyerid",
            "requester_agent_id",
            "requesteragentid",
            "requester_contact",
            "requestercontact",
        },
    )
    buyer_identity, buyer_identity_source = labeled_string(
        [
            ("payload.buyerAgentId", payload.get("buyerAgentId")),
            ("payload.buyer_agent_id", payload.get("buyer_agent_id")),
            ("payload.buyerId", payload.get("buyerId")),
            ("payload.buyer_id", payload.get("buyer_id")),
            ("input.buyerAgentId", input_block.get("buyerAgentId")),
            ("input.buyer_agent_id", input_block.get("buyer_agent_id")),
            ("input.buyerId", input_block.get("buyerId")),
            ("input.buyer_id", input_block.get("buyer_id")),
            ("requester.agentId", requester.get("agentId")),
            ("requester.agent_id", requester.get("agent_id")),
            ("requester.id", requester.get("id")),
            ("requester.name", requester.get("name")),
            ("payload.requesterContact", payload.get("requesterContact")),
            ("payload.requester_contact", payload.get("requester_contact")),
            ("input.requesterContact", input_block.get("requesterContact")),
            ("input.requester_contact", input_block.get("requester_contact")),
            ("nested.buyer_identity", nested_buyer_identity),
        ]
    )
    if buyer_identity:
        buyer_scope_id = f"buyer-{short_digest(buyer_identity, 16)}"
        buyer_scope_mode = "buyer_agent"
    else:
        buyer_scope_id = f"isolated-{short_digest(normalized['request_id'] + normalized['raw_body_digest_sha256'], 16)}"
        buyer_identity_source = "isolated_request_fallback"
        buyer_scope_mode = "isolated_request"
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
    if not repo_id:
        repo_id = github_repo_id_from_payload(payload)
    project_id = nested_string(
        input_block.get("project"),
        input_block.get("project_id"),
        input_block.get("projectId"),
        payload.get("project"),
        default=find_nested_string(payload, {"project", "project_id", "projectid"}),
    )
    if not repo_id:
        repo_id = f"repo-{short_digest(normalized['text_digest_sha256'], 10)}"
    namespace_key = safe_slug(f"{buyer_scope_id}-{repo_id}-{project_id}", "default")
    return {
        "schema_version": "code-audit-namespace/1.1",
        "client_id": buyer_scope_id,
        "buyer_scope": {
            "id": buyer_scope_id,
            "mode": buyer_scope_mode,
            "identity_present": bool(buyer_identity),
            "identity_source": buyer_identity_source,
        },
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
        default="Review the submitted public GitHub target for security and correctness issues.",
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
    ("critical", r"\b(private[_-]?key|mnemonic|seed[_-]?phrase)\b\s*[:=]\s*[\"'][^\"'\n]{16,}[\"']", "Private key or seed material may be hardcoded.", "Remove private key material from source and rotate exposed credentials."),
    ("high", r"subprocess\.(Popen|run|call)|child_process\.(exec|spawn)", "Shell/process execution path detected.", "Guard command construction, sanitize arguments, and avoid shell=True."),
    ("high", r"verify\s*=\s*False|rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED", "TLS verification bypass detected.", "Do not disable TLS verification in production paths."),
    ("high", r"pickle\.loads?|yaml\.load\s*\(", "Unsafe deserialization pattern detected.", "Use safe parsers and trusted schemas."),
    ("high", r"\.innerHTML\s*=|dangerouslySetInnerHTML", "Potential unsafe HTML sink detected.", "Avoid raw HTML sinks or prove strict sanitization before rendering untrusted content."),
    ("high", r"payment[_-]?status[\"']?\s*[:=]\s*[\"']?(quote_requested|authorized)|settlement[_-]?status[\"']?\s*[:=]\s*[\"']?authorized", "Payment lifecycle state requires settlement validation.", "Ensure paid execution is gated on the intended authorization, settlement, or escrow invariant."),
    ("high", r"\btx\.origin\b", "Solidity authorization may depend on tx.origin.", "Use msg.sender and explicit role checks instead of tx.origin authorization."),
    ("high", r"\bdelegatecall\s*\(", "Delegatecall usage detected.", "Constrain delegatecall targets and storage assumptions or avoid delegatecall in privileged paths."),
    ("high", r"\bselfdestruct\s*\(", "Selfdestruct usage detected.", "Avoid selfdestruct unless the contract lifecycle and upgrade path are formally constrained."),
    ("high", r"(Access-Control-Allow-Origin\s*[:=]\s*[\"']\*|allow_origins\s*=\s*\[[^\]]*[\"']\*[\"']|cors\s*\(\s*\{[^}\n]{0,400}origin\s*:\s*[\"']\*)", "Permissive CORS policy detected.", "Restrict browser origins and credentials to explicit trusted domains."),
    ("high", r"(sendFile|send_file|readFileSync|readFile|writeFileSync|writeFile|open\s*\()[^;\n]{0,180}(req\.|request\.|params|query|body|path)", "Filesystem access appears derived from request input.", "Normalize and allow-list file paths before reading or writing files from buyer/user input."),
    ("high", r"(fetch|axios\.(get|post|request)|requests\.(get|post|request)|urllib\.request\.urlopen)[^;\n]{0,180}(req\.|request\.|params|query|body|url)", "Outbound request appears derived from user input.", "Validate and allow-list outbound hosts to avoid SSRF and metadata-service access."),
    ("medium", r"SELECT\s+.*\+|query\s*\(.*\+", "Possible SQL/string query construction.", "Use parameterized queries and typed query builders."),
    ("medium", r"\b(password|api[_-]?key|secret|token|private[_-]?key)\b\s*[:=]\s*[\"'][^\"'\n]{12,}[\"']", "Possible hardcoded secret detected.", "Keep secrets out of source, logs, prompts, and public artifacts."),
    ("medium", r"(console\.log|print|logger\.\w+)\s*\([^;\n]*(password|secret|token|private[_-]?key|api[_-]?key)", "Sensitive value may be logged.", "Remove secret-bearing logs or redact sensitive fields before logging."),
    ("medium", r"(createHash\s*\(\s*[\"'](md5|sha1)[\"']|\b(md5|sha1)\s*\()", "Weak hash primitive detected.", "Use SHA-256 or a purpose-built password/key derivation primitive as appropriate."),
    ("medium", r"(Math\.random|random\.random)\s*\([^;\n]*(token|secret|password|key|nonce|session)|(token|secret|password|key|nonce|session)[^;\n]{0,80}(Math\.random|random\.random)", "Non-cryptographic randomness may protect a sensitive value.", "Use a cryptographically secure random source for tokens, keys, nonces, and sessions."),
    ("medium", r"(csrf\s*:\s*false|disableCSRF|csrfProtection\s*=\s*False)", "CSRF protection appears disabled.", "Require CSRF or equivalent origin/session protections for browser-authenticated mutation routes."),
    ("medium", r"(safeToRetryFreshPayment|freshPaymentSafe)[\"']?\s*[:=]\s*true", "Fresh-payment retry flag may be too permissive.", "Only allow fresh payment when the canonical payment state is terminal no-charge and buyer delivery is absent."),
    ("medium", r"(payment-state|paymentState|execution-state|executionState)[^;\n]{0,240}(console/state|consoleState|debug state|diagnostic)", "Buyer safety state may be coupled to diagnostic state.", "Keep payment-state as the fast canonical buyer-safety projection and move heavy diagnostics to separate endpoints."),
    ("medium", r"(buyer[_-]?visible[_-]?outputs|artifact[_-]?manifest[_-]?url|deliveryReceipt)[^;\n]{0,240}(optional|best[-_ ]effort|TODO|FIXME|missing)", "Buyer delivery guarantee may be optional or incomplete.", "Paid execution should return buyer-visible output or a valid artifact manifest before seller success is credited."),
    ("medium", r"\b(TODO|FIXME|HACK)\b", "Unresolved implementation marker detected.", "Track and resolve before production release."),
    ("low", r"console\.log|print\s*\(", "Debug logging detected.", "Confirm logs cannot expose private inputs or credentials."),
]


SEVERITY_SCORE = {"critical": 4, "high": 3, "medium": 2, "low": 1, "none": 0}
RETURNED_FINDING_SEVERITIES = {"critical", "high", "medium"}
RETURNED_SEVERITY_THRESHOLD = "medium"


PROTOCOL_SURFACE_PATTERNS: list[tuple[str, str, list[str], list[str]]] = [
    (
        "santaclawz_paid_delivery",
        "SantaClawz paid delivery / buyer-visible return surface",
        [r"santaclawz-return", r"verified_output", r"buyer[_-]?visible[_-]?outputs", r"artifact[_-]?manifest", r"deliveryReceipt"],
        ["Validate completed return package shape.", "Confirm buyer-visible output or artifact manifest exists before seller credit."],
    ),
    (
        "x402_payment_state",
        "x402 payment, settlement, and same-payload recovery surface",
        [r"\bx402\b", r"payment-state", r"paymentState", r"settlement", r"idempotency", r"same[-_ ]payload"],
        ["Separate authorization from settlement.", "Make same-payload recovery explicit and avoid fresh payment until terminal no-charge."],
    ),
    (
        "relay_runtime_lifecycle",
        "Relay, worker, heartbeat, and runtime lifecycle surface",
        [r"relay", r"heartbeat", r"/hire\b", r"worker", r"runtime", r"availability"],
        ["Check relay freshness before signing.", "Do not attribute pre-worker relay failures to the seller."],
    ),
    (
        "openclaw_runtime",
        "OpenClaw runtime integration surface",
        [r"openclaw", r"OPENCLAW", r"modelReachable", r"sourceToolsExecuted"],
        ["Confirm OpenClaw runs under the supervised runtime, not just locally.", "Check source/tool execution when the service promises sourced output."],
    ),
    (
        "zko1js_proof_stack",
        "ZK/o1js proof and commitment surface",
        [r"\bo1js\b", r"\bMina\b", r"\bZkProgram\b", r"\bProvable\b", r"proof[_-]?root", r"commitment"],
        ["Validate proof inputs, public outputs, and commitment/reputation boundaries.", "Separate proof metadata from private payload disclosure."],
    ),
]


def finding_fingerprint(finding: dict[str, Any]) -> str:
    snippets = "|".join(str(item) for item in as_list(finding.get("evidence_snippets"))[:2])
    basis = {
        "severity": finding.get("severity"),
        "title": finding.get("title"),
        "recommendation": finding.get("recommendation"),
        "snippet_digest": short_digest(snippets, 20),
    }
    return canonical_digest(basis)[:24]


def stable_finding_id(fingerprint: str) -> str:
    suffix = re.sub(r"[^a-f0-9]", "", fingerprint.lower())[:12]
    return f"SC-AUDIT-{suffix.upper()}" if suffix else "SC-AUDIT-UNKNOWN"


def is_likely_rule_self_match(snippet: str, title: str, recommendation: str) -> bool:
    lowered = snippet.lower()
    title_key = title.lower().rstrip(".")
    recommendation_key = recommendation.lower().rstrip(".")[:48]
    return title_key in lowered or (len(recommendation_key) > 20 and recommendation_key in lowered)


def scan_units_from_target(normalized: dict[str, Any], materialized: dict[str, Any]) -> list[dict[str, str]]:
    units: list[dict[str, str]] = []
    total_chars = 0
    for file in as_list(materialized.get("files")):
        if not isinstance(file, dict):
            continue
        content = first_string(file.get("content"), default="")
        if not content:
            continue
        if total_chars >= MAX_MATERIALIZED_TEXT_CHARS:
            break
        remaining = MAX_MATERIALIZED_TEXT_CHARS - total_chars
        clipped = content[:remaining]
        total_chars += len(clipped)
        units.append({"path": first_string(file.get("path"), default="repo-file"), "content": clipped})
    if units:
        return units
    return [{"path": "submitted_payload", "content": normalized["text"]}]


def audit_units(units: list[dict[str, str]]) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    for severity, pattern, title, recommendation in AUDIT_RULES:
        locations: list[dict[str, Any]] = []
        match_count = 0
        for unit in units:
            text = unit.get("content", "")
            path = unit.get("path", "submitted_payload")
            for match in re.finditer(pattern, text, flags=re.IGNORECASE | re.MULTILINE):
                start = max(0, match.start() - 80)
                end = min(len(text), match.end() + 80)
                snippet = re.sub(r"\s+", " ", text[start:end]).strip()[:240]
                if is_likely_rule_self_match(snippet, title, recommendation):
                    continue
                match_count += 1
                if len(locations) < 8:
                    locations.append(
                        {
                            "path": path,
                            "line": line_for_offset(text, match.start()),
                            "snippet": snippet,
                        }
                    )
        if match_count <= 0:
            continue
        finding = {
            "id": f"CAD-{len(findings) + 1:03d}",
            "severity": severity,
            "category": slug(title),
            "title": title,
            "match_count": match_count,
            "locations": locations,
            "evidence_snippets": [
                f"{item['path']}:{item['line']} - {item['snippet']}"
                for item in locations[:3]
            ],
            "recommendation": recommendation,
        }
        finding["fingerprint"] = finding_fingerprint(finding)
        finding["stable_id"] = stable_finding_id(str(finding["fingerprint"]))
        findings.append(finding)
    plain_http_count = 0
    plain_http_locations: list[dict[str, Any]] = []
    for unit in units:
        text = unit.get("content", "")
        path = unit.get("path", "submitted_payload")
        lowered = text.lower()
        plain_http_count += lowered.count("http://")
        for match in re.finditer(r"http://", text, flags=re.IGNORECASE):
            if len(plain_http_locations) >= 8:
                break
            start = max(0, match.start() - 80)
            end = min(len(text), match.end() + 80)
            plain_http_locations.append(
                {
                    "path": path,
                    "line": line_for_offset(text, match.start()),
                    "snippet": re.sub(r"\s+", " ", text[start:end]).strip()[:240],
                }
            )
    if plain_http_count > 0:
        finding = {
            "id": f"CAD-{len(findings) + 1:03d}",
            "severity": "low",
            "category": "plain-http-reference-detected",
            "title": "Plain HTTP reference detected.",
            "match_count": plain_http_count,
            "locations": plain_http_locations,
            "evidence_snippets": [
                f"{item['path']}:{item['line']} - {item['snippet']}"
                for item in plain_http_locations[:3]
            ],
            "recommendation": "Prefer HTTPS endpoints unless an internal/private network policy explicitly allows HTTP.",
        }
        finding["fingerprint"] = finding_fingerprint(finding)
        finding["stable_id"] = stable_finding_id(str(finding["fingerprint"]))
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


def audit_text(text: str) -> dict[str, Any]:
    return audit_units([{"path": "submitted_payload", "content": text}])


def detect_protocol_surfaces(
    normalized: dict[str, Any],
    materialized: dict[str, Any],
    scan_units: list[dict[str, str]],
) -> dict[str, Any]:
    unit_hits: list[dict[str, Any]] = []
    total_chars = 0
    for unit in scan_units:
        text = unit.get("content", "")
        if not text:
            continue
        total_chars += len(text)
        lowered = text.lower()
        path = unit.get("path", "submitted_payload")
        for surface_id, label, patterns, focus in PROTOCOL_SURFACE_PATTERNS:
            hits = 0
            matched_patterns: list[str] = []
            for pattern in patterns:
                count = len(re.findall(pattern, lowered, flags=re.IGNORECASE | re.MULTILINE))
                if count:
                    hits += count
                    matched_patterns.append(pattern)
            if hits:
                unit_hits.append(
                    {
                        "surface": surface_id,
                        "label": label,
                        "path": path,
                        "hit_count": hits,
                        "matched_pattern_count": len(matched_patterns),
                        "audit_focus": focus,
                    }
                )
    by_surface: dict[str, dict[str, Any]] = {}
    for hit in unit_hits:
        surface_id = str(hit["surface"])
        record = by_surface.setdefault(
            surface_id,
            {
                "surface": surface_id,
                "label": hit["label"],
                "hit_count": 0,
                "paths": [],
                "audit_focus": hit["audit_focus"],
            },
        )
        record["hit_count"] += int(hit.get("hit_count", 0) or 0)
        if len(record["paths"]) < 8 and hit.get("path") not in record["paths"]:
            record["paths"].append(hit.get("path"))
    detected = sorted(by_surface.values(), key=lambda item: int(item.get("hit_count", 0) or 0), reverse=True)
    return {
        "schema_version": "code-audit-protocol-surface/1.0",
        "detected": detected,
        "detected_surface_ids": [str(item.get("surface")) for item in detected],
        "detected_count": len(detected),
        "target_status": materialized.get("status"),
        "scanned_chars": total_chars,
        "input_digest_sha256": normalized.get("text_digest_sha256"),
        "guidance": (
            "Detected surfaces are audit-priority hints. They do not prove a vulnerability by themselves; "
            "returned findings still carry deterministic evidence and a validation status."
        ),
    }


def attach_evidence_strength(finding: dict[str, Any]) -> dict[str, Any]:
    severity = str(finding.get("severity", "")).lower()
    match_count = int(finding.get("match_count", 0) or 0)
    location_count = len(as_list(finding.get("locations")))
    confidence = "medium"
    if severity in {"critical", "high"} and match_count >= 2 and location_count >= 1:
        confidence = "high"
    elif match_count <= 0 or location_count <= 0:
        confidence = "low"
    finding["evidence_strength"] = {
        "classification": "deterministic_pattern_candidate",
        "confidence": confidence,
        "reachability_proven": False,
        "buyer_note": (
            "This finding is backed by deterministic pattern evidence. Validate source/sink reachability, "
            "trust boundary, and runtime configuration before treating it as fully exploited."
        ),
    }
    return finding


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


def namespace_feedback_title_sets(record: dict[str, Any]) -> tuple[set[str], set[str]]:
    accepted: set[str] = set()
    rejected: set[str] = set()
    for item in as_list(record.get("feedback")):
        if not isinstance(item, dict):
            continue
        title = first_string(item.get("title"), item.get("finding_title"), default="")
        if not title:
            continue
        label = first_string(item.get("label"), item.get("outcome"), default="").lower()
        if label in {"accepted", "useful", "resolved"}:
            accepted.add(title.lower())
        elif label in {"rejected", "noisy", "false_positive"}:
            rejected.add(title.lower())
    return accepted, rejected


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
    accepted_titles, rejected_titles = namespace_feedback_title_sets(record)
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
        finding["stable_id"] = finding.get("stable_id") or stable_finding_id(fingerprint)
        finding["memory"] = {
            "status": "repeat" if occurrence_count > 0 else "new",
            "prior_count": occurrence_count,
            "delivered_before": delivered_count > 0,
            "delivered_count": delivered_count,
            "first_seen_at": prior.get("first_seen_at"),
            "last_delivered_at": prior.get("last_delivered_at"),
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
    reportable = [
        item for item in active
        if str(item.get("severity", "")).lower() in RETURNED_FINDING_SEVERITIES
    ]
    low_priority_filtered_count = max(0, len(active) - len(reportable))
    fresh = [item for item in reportable if not as_dict(item.get("memory")).get("delivered_before")]
    repeats = [item for item in reportable if as_dict(item.get("memory")).get("delivered_before")]
    selected = (fresh + repeats)[:FINDING_LIMIT]
    selected_fresh_count = sum(1 for item in selected if not as_dict(item.get("memory")).get("delivered_before"))
    selected_repeat_count = len(selected) - selected_fresh_count
    deferred_count = max(0, len(reportable) - len(selected))
    has_more_findings = deferred_count > 0
    completion_hint = (
        "Keep running this audit with the same buyer identity and repo namespace "
        "until all_findings_returned is true."
        if has_more_findings
        else "No new medium-or-higher findings were found for this buyer/repo namespace; repeated findings are returned for continuity."
        if selected and selected_fresh_count == 0 and selected_repeat_count > 0
        else "All medium-or-higher findings currently detected for this buyer/repo namespace have been returned."
    )
    for index, finding in enumerate(selected, start=1):
        memory = as_dict(finding.get("memory"))
        attach_evidence_strength(finding)
        finding["is_new_for_namespace"] = not memory.get("delivered_before")
        finding["stable_id"] = finding.get("stable_id") or stable_finding_id(str(finding.get("fingerprint", "")))
        finding["delivery"] = {
            "status": "returned",
            "batch_position": index,
            "batch_limit": FINDING_LIMIT,
            "total_reportable_findings": len(reportable),
            "returned_severity_threshold": RETURNED_SEVERITY_THRESHOLD,
            "is_final_batch": not has_more_findings,
            "is_new_for_namespace": finding["is_new_for_namespace"],
            "prior_delivery_count": memory.get("delivered_count", 0),
        }
    highest = "none"
    if selected:
        highest = max(selected, key=lambda item: SEVERITY_SCORE.get(str(item.get("severity")), 0)).get("severity", "none")
    return {
        **findings,
        "schema_version": "code-audit-findings/1.2",
        "finding_count": len(selected),
        "returned_finding_count": len(selected),
        "total_active_finding_count": len(reportable),
        "total_detected_finding_count": len(active),
        "low_priority_filtered_count": low_priority_filtered_count,
        "deferred_count": deferred_count,
        "has_more_findings": has_more_findings,
        "all_findings_returned": not has_more_findings,
        "finding_limit": FINDING_LIMIT,
        "returned_severity_threshold": RETURNED_SEVERITY_THRESHOLD,
        "returned_severities": sorted(RETURNED_FINDING_SEVERITIES, key=lambda item: SEVERITY_SCORE[item], reverse=True),
        "memory_batch": {
            "dedupe_enabled": True,
            "new_findings_returned": selected_fresh_count,
            "repeated_findings_returned": selected_repeat_count,
            "reportable_new_findings": len(fresh),
            "reportable_repeated_findings": len(repeats),
            "reason_repeated": (
                "no_new_medium_or_higher_findings_available_repeated_for_continuity"
                if selected and selected_fresh_count == 0 and selected_repeat_count > 0
                else ""
            ),
            "has_more_findings": has_more_findings,
            "next_cursor": f"batch_after_{len(selected)}" if has_more_findings else None,
        },
        "next_batch_hint": (
            f"This run returned the first {len(selected)} of {len(reportable)} medium-or-higher findings. "
            "Keep running the audit with the same buyer identity and repo namespace until all_findings_returned is true."
            if has_more_findings
            else ""
        ),
        "completion_hint": completion_hint,
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
            "stable_id": finding.get("stable_id") or stable_finding_id(fingerprint),
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
        "total_detected_finding_count": findings.get("total_detected_finding_count"),
        "low_priority_filtered_count": findings.get("low_priority_filtered_count"),
        "deferred_count": findings.get("deferred_count", 0),
        "has_more_findings": findings.get("has_more_findings"),
        "all_findings_returned": findings.get("all_findings_returned"),
        "finding_fingerprints": [finding.get("fingerprint") for finding in as_list(findings.get("findings"))[:12]],
        "stable_finding_ids": [finding.get("stable_id") for finding in as_list(findings.get("findings"))[:12]],
        "memory_batch": findings.get("memory_batch"),
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
                "stable_id": item.get("stable_id"),
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


def compact_target_materialization(materialized: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": materialized.get("schema_version", "code-audit-target-materialization/1.0"),
        "status": materialized.get("status"),
        "scan_profile": materialized.get("scan_profile", CODE_AUDIT_SCAN_PROFILE),
        "ruleset_version": materialized.get("ruleset_version", CODE_AUDIT_RULESET_VERSION),
        "github_target_count": materialized.get("github_target_count", 0),
        "github_materialized_as": as_list(materialized.get("github_materialized_as")),
        "files_seen": materialized.get("files_seen", 0),
        "files_scanned": materialized.get("files_scanned", 0),
        "files_considered": materialized.get("files_considered", 0),
        "files_skipped": as_dict(materialized.get("files_skipped")),
        "scan_truncated": materialized.get("scan_truncated", False),
        "targets": as_list(materialized.get("targets")),
        "urls": as_list(materialized.get("urls"))[:10],
    }


def audit_verdict(
    findings: dict[str, Any],
    materialized: dict[str, Any],
    ai_insights: dict[str, Any],
    protocol_surface: dict[str, Any],
) -> dict[str, Any]:
    target_summary = compact_target_materialization(materialized)
    returned_count = int(findings.get("returned_finding_count", findings.get("finding_count", 0)) or 0)
    highest = str(findings.get("highest_severity") or "none").lower()
    target_status = str(target_summary.get("status") or "not_requested")
    model_status = str(ai_insights.get("status") or "skipped")
    if returned_count <= 0:
        verdict = "no_medium_or_higher_findings_in_bounded_pass"
        recommended_next_action = "If this was expected to be a deep audit, rerun with a narrower target or higher-context prompt."
    elif highest in {"critical", "high"}:
        verdict = "actionable_high_risk_findings_returned"
        recommended_next_action = "Fix or triage the highest-severity findings first, then rerun with the same buyer/repo namespace."
    else:
        verdict = "actionable_medium_findings_returned"
        recommended_next_action = "Review the returned findings, fix confirmed issues, then rerun to continue the memory-backed batch."
    confidence = "medium"
    if target_status == "failed":
        confidence = "low"
    elif model_status == "completed" and returned_count > 0 and not target_summary.get("scan_truncated"):
        confidence = "high" if highest in {"critical", "high"} else "medium"
    if findings.get("has_more_findings"):
        recommended_next_action += " More reportable findings remain in this bounded batch queue."
    return {
        "schema_version": "code-audit-verdict/1.0",
        "verdict": verdict,
        "confidence": confidence,
        "scope": "bounded_hosted_audit_pass",
        "scope_note": (
            "This is a hosted fixed-price audit pass over a materialized public GitHub target. "
            "It is stronger than a plain template response, but it is not a full manual audit."
        ),
        "recommended_next_action": recommended_next_action,
        "highest_severity": highest,
        "returned_finding_count": returned_count,
        "target_status": target_status,
        "model_enrichment_status": model_status,
        "protocol_surface_count": protocol_surface.get("detected_count", 0),
        "protocol_surface_ids": protocol_surface.get("detected_surface_ids", []),
    }


def markdown_cell(value: Any) -> str:
    text = str(value if value is not None else "")
    text = text.replace("\n", " ").replace("|", "\\|").strip()
    return text if text else "-"


def markdown_table(rows: list[tuple[str, Any]]) -> list[str]:
    lines = ["| Field | Value |", "|---|---|"]
    for key, value in rows:
        lines.append(f"| {markdown_cell(key)} | {markdown_cell(value)} |")
    return lines


def yes_no(value: Any) -> str:
    return "yes" if bool(value) else "no"


def finding_primary_location(finding: dict[str, Any]) -> str:
    location = as_dict(as_list(finding.get("locations"))[0] if as_list(finding.get("locations")) else {})
    if not location:
        return "not available"
    path = first_string(location.get("path"), default="unknown")
    line = location.get("line")
    return f"`{path}:{line}`" if line else f"`{path}`"


def finding_evidence_summary(finding: dict[str, Any]) -> list[str]:
    summaries: list[str] = []
    for location in as_list(finding.get("locations"))[:3]:
        if not isinstance(location, dict):
            continue
        path = first_string(location.get("path"), default="unknown")
        line = location.get("line")
        snippet = first_string(location.get("snippet"), default="")
        snippet_words = snippet.split()
        clipped = " ".join(snippet_words[:18])
        if len(snippet_words) > 18:
            clipped += " ..."
        label = f"`{path}:{line}`" if line else f"`{path}`"
        summaries.append(f"{label} matched deterministic evidence{f': {clipped}' if clipped else ''}.")
    return summaries


def compact_inline_text(value: Any, *, max_chars: int = 220) -> str:
    text = re.sub(r"\s+", " ", first_string(value, default="")).strip()
    if len(text) <= max_chars:
        return text
    return text[: max(0, max_chars - 1)].rstrip() + "..."


def compact_evidence_summary(finding: dict[str, Any]) -> str:
    summary = finding_evidence_summary(finding)
    if summary:
        return compact_inline_text(summary[0], max_chars=260)
    evidence = as_list(finding.get("evidence_snippets"))
    if evidence:
        return compact_inline_text(evidence[0], max_chars=260)
    return "Structured evidence is included in the JSON result."


def render_buyer_finding_section(index: int, finding: dict[str, Any]) -> list[str]:
    novelty = "New" if finding.get("is_new_for_namespace") else "Repeated"
    stable_id = finding.get("stable_id") or finding.get("id") or "finding"
    evidence = as_dict(finding.get("evidence_strength"))
    buyer_note = compact_inline_text(evidence.get("buyer_note"), max_chars=220)
    lines = [
        "",
        f"### {index}. {stable_id} - {novelty} - {str(finding.get('severity', 'unknown')).title()}",
        "",
        f"**Title:** {compact_inline_text(finding.get('title', 'Finding'), max_chars=180)}",
        "",
        f"**Primary location:** {finding_primary_location(finding)}",
        "",
        f"**Evidence:** {compact_evidence_summary(finding)}",
        "",
        f"**Recommendation:** {compact_inline_text(finding.get('recommendation', ''), max_chars=260)}",
        "",
        (
            f"**Classification:** {evidence.get('classification', 'deterministic_pattern_candidate')} / "
            f"{evidence.get('confidence', 'medium')}; reachability proven: {yes_no(evidence.get('reachability_proven', False))}; "
            f"matches: {finding.get('match_count', 0)}."
        ),
    ]
    if buyer_note:
        lines.extend(["", f"**Validation note:** {buyer_note}"])
    return lines


def compact_location_for_buyer(location: Any) -> dict[str, Any]:
    item = as_dict(location)
    output: dict[str, Any] = {
        "path": first_string(item.get("path"), default="unknown"),
    }
    if item.get("line") is not None:
        output["line"] = item.get("line")
    snippet = compact_inline_text(item.get("snippet"), max_chars=100)
    if snippet:
        output["snippet"] = snippet
    return output


def compact_finding_for_buyer_json(finding: dict[str, Any]) -> dict[str, Any]:
    evidence_strength = as_dict(finding.get("evidence_strength"))
    return {
        "id": finding.get("stable_id") or finding.get("id"),
        "severity": finding.get("severity"),
        "title": compact_inline_text(finding.get("title"), max_chars=150),
        "confidence": evidence_strength.get("confidence", "medium"),
        "evidence_strength": {
            "classification": evidence_strength.get("classification", "deterministic_pattern_candidate"),
            "confidence": evidence_strength.get("confidence", "medium"),
            "reachability_proven": bool(evidence_strength.get("reachability_proven", False)),
        },
        "is_new_for_namespace": finding.get("is_new_for_namespace") is True,
        "prior_delivery_count": as_dict(finding.get("delivery")).get("prior_delivery_count", 0),
        "match_count": finding.get("match_count", 0),
        "primary_location": compact_location_for_buyer(as_list(finding.get("locations"))[0] if as_list(finding.get("locations")) else {}),
        "evidence_summary": compact_inline_text(compact_evidence_summary(finding), max_chars=140),
        "recommendation": compact_inline_text(finding.get("recommendation"), max_chars=150),
    }


def compact_protocol_surface_for_buyer(protocol_surface: dict[str, Any]) -> dict[str, Any]:
    return {
        "detected_count": protocol_surface.get("detected_count", 0),
        "detected_surface_ids": as_list(protocol_surface.get("detected_surface_ids"))[:8],
        "detected": [
            {
                "surface": item.get("surface"),
                "label": item.get("label"),
                "hit_count": item.get("hit_count", 0),
            }
            for item in as_list(protocol_surface.get("detected"))[:6]
            if isinstance(item, dict)
        ],
    }


def report_sections_projection(findings: dict[str, Any], buyer_summary_markdown: str = "") -> dict[str, Any]:
    finding_count = len([item for item in as_list(findings.get("findings")) if isinstance(item, dict)])
    markdown_count = len(re.findall(r"^###\s+\d+\.", buyer_summary_markdown, flags=re.MULTILINE)) if buyer_summary_markdown else finding_count
    markdown_complete = markdown_count == finding_count
    return {
        "human_markdown_findings_count": markdown_count,
        "human_markdown_expected_findings_count": finding_count,
        "json_findings_count": finding_count,
        "markdown_complete": markdown_complete,
        "markdown_inline_limit_chars": BUYER_VISIBLE_TEXT_SOFT_LIMIT,
        "json_complete": True,
    }


def render_buyer_summary(
    normalized: dict[str, Any],
    findings: dict[str, Any],
    memory_context: dict[str, Any],
    materialized: dict[str, Any],
    ai_insights: dict[str, Any],
    protocol_surface: dict[str, Any],
    verdict: dict[str, Any],
) -> str:
    target_summary = compact_target_materialization(materialized)
    target_status = str(target_summary.get("status") or "not_requested")
    memory_batch = as_dict(findings.get("memory_batch"))
    skipped = as_dict(target_summary.get("files_skipped"))
    skipped_total = sum(int(value or 0) for value in skipped.values())
    returned = [finding for finding in as_list(findings.get("findings")) if isinstance(finding, dict)]
    detected_surfaces = as_list(protocol_surface.get("detected"))
    target_urls = as_list(target_summary.get("urls"))
    materialized_as = as_list(target_summary.get("github_materialized_as"))
    primary_target = target_urls[0] if target_urls else "public GitHub URL"
    returned_count = int(findings.get("returned_finding_count", findings.get("finding_count", len(returned))) or 0)
    active_count = int(findings.get("total_active_finding_count", findings.get("finding_count", len(returned))) or 0)
    detected_count = int(findings.get("total_detected_finding_count", active_count) or 0)
    model_notes_available = ai_insights.get("status") == "completed"
    review_mode = "deterministic scan + model notes" if model_notes_available else "deterministic scan"
    memory_batch_new = as_dict(findings.get("memory_batch")).get("new_findings_returned", 0)
    memory_batch_repeated = as_dict(findings.get("memory_batch")).get("repeated_findings_returned", 0)
    lines = [
        "# SantaClawz Agent Code Audit Report",
        "",
        f"**{str(verdict.get('verdict', 'completed')).replace('_', ' ').title()}.**",
        "",
        compact_inline_text(verdict.get("recommended_next_action"), max_chars=320),
        "",
        "## Run Metadata",
        "",
        *markdown_table(
            [
                ("Audit status", "completed"),
                ("Ruleset", target_summary.get("ruleset_version", CODE_AUDIT_RULESET_VERSION)),
                ("Target", primary_target),
                ("Materialized as", ", ".join(str(item) for item in materialized_as) or "github_url"),
                ("Findings returned", f"{returned_count} of {active_count} medium-or-higher"),
                ("Total detected", detected_count),
                ("New vs repeated", f"{memory_batch_new} new, {memory_batch_repeated} repeated"),
                ("Prior namespace runs", memory_context.get("namespace_run_count", 0)),
                ("Review mode", review_mode),
                ("Delivery", "Inline Markdown + inline structured JSON"),
            ]
        ),
        "",
        "## Scan Scope",
        "",
        *markdown_table(
            [
                ("Target materialization", target_status),
                ("Scan mode", f"deterministic rules{' + private model enrichment' if OPENAI_ENABLED else ''}"),
                ("Files considered", target_summary.get("files_considered", 0)),
                ("Files scanned", target_summary.get("files_scanned", 0)),
                ("Skipped after filtering", skipped_total),
                ("Scan truncated", yes_no(target_summary.get("scan_truncated", False))),
            ]
        ),
    ]
    if skipped_total:
        lines.extend(
            [
                "",
                "Skipped files: "
                + ", ".join(f"`{key}`={value}" for key, value in skipped.items() if int(value or 0) > 0)
                + ".",
            ]
        )
    if detected_surfaces:
        lines.extend(["", "## Protocol Surfaces Detected", ""])
        surface_summary = []
        for item in detected_surfaces[:5]:
            if isinstance(item, dict):
                surface_summary.append(f"**{item.get('label', item.get('surface'))}** ({item.get('hit_count', 0)})")
        lines.append("; ".join(surface_summary) + ".")
    else:
        lines.extend(["", "## Protocol Surfaces Detected", "", "No SantaClawz/OpenClaw/x402/ZK-specific protocol surface was detected in the scanned material."])
    if ai_insights.get("status") == "completed":
        model_items = [item for item in as_list(ai_insights.get("audit_insights")) if isinstance(item, dict)]
        if model_items:
            lines.extend(["", "## Additional Model Notes", ""])
            for item in model_items[:5]:
                title = first_string(item.get("title"), default="Model insight")
                severity = first_string(item.get("severity"), default="informational").upper()
                recommendation = first_string(item.get("recommendation"), default="")
                lines.append(f"- **{severity}:** {title}{f' - {recommendation}' if recommendation else ''}")
    if target_status == "failed":
        lines.extend(
            [
                "",
                "## Target Fetch Notice",
                "",
                "The requested source target could not be fetched, so this hosted agent rejects the job instead of auditing prompt text only.",
            ]
        )
    lines.extend(
        [
            "",
            "## Findings",
            "",
            (
                f"This run returned {returned_count} "
                f"of {active_count} "
                f"{findings.get('returned_severity_threshold', RETURNED_SEVERITY_THRESHOLD)}-or-higher findings. "
                f"Low-priority filtered: {findings.get('low_priority_filtered_count', 0)}."
            ),
        ]
    )
    if findings.get("has_more_findings"):
        lines.append(str(findings.get("next_batch_hint") or "Run again with the same namespace to continue the finding batch."))
    else:
        lines.append(str(findings.get("completion_hint") or "All returned-scope findings have been returned."))
    if memory_batch_repeated:
        lines.extend(
            [
                "",
                (
                    "Repeated findings are previously seen issue fingerprints for this buyer/repo namespace. "
                    "They still count as completed audit work; they just tell the buyer there may be no new issues in this batch."
                ),
            ]
        )
    tail = [
        "",
        "## Delivery Surface",
        "",
        *markdown_table(
            [
                ("Inline Markdown", "yes"),
                ("Inline structured JSON", "yes"),
                ("Downloadable artifact", "no"),
                ("Internal verified package", "yes"),
            ]
        ),
        "",
        "The structured JSON output is the machine-readable companion. The internal package contains the full hashed report and findings files; buyer-downloadable artifact upload is not exposed by this hosted agent yet.",
        "",
        f"Input digest: `{normalized['text_digest_sha256']}`.",
    ]
    included = 0
    if returned:
        for index, finding in enumerate(returned, start=1):
            section = render_buyer_finding_section(index, finding)
            projected = "\n".join([*lines, *section, *tail])
            if len(projected) <= BUYER_VISIBLE_TEXT_SOFT_LIMIT or included == 0:
                lines.extend(section)
                included += 1
                continue
            break
        if included < len(returned):
            lines.extend(
                [
                    "",
                    (
                        f"**Inline Markdown note:** {included} of {len(returned)} findings fit in the buyer-visible "
                        "Markdown envelope. The structured JSON companion and internal package carry the returned batch."
                    ),
                ]
            )
    else:
        lines.append("No medium-or-higher deterministic findings were returned in this batch.")
    lines.extend(tail)
    return "\n".join(lines)


def render_report(
    normalized: dict[str, Any],
    findings: dict[str, Any],
    memory_context: dict[str, Any],
    ai_insights: dict[str, Any],
    materialized: dict[str, Any],
    protocol_surface: dict[str, Any],
    verdict: dict[str, Any],
) -> str:
    target_summary = compact_target_materialization(materialized)
    lines = [
        "# SantaClawz Agent Code Audit Report",
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
        f"- Buyer verdict: {str(verdict.get('verdict', 'completed')).replace('_', ' ')}",
        f"- Recommended next action: {verdict.get('recommended_next_action', '')}",
        f"- Scope note: {verdict.get('scope_note', '')}",
        f"- Findings returned this run: {findings['finding_count']} of {findings.get('total_active_finding_count', findings['finding_count'])} medium-or-higher findings",
        f"- Total deterministic findings detected: {findings.get('total_detected_finding_count', findings.get('total_active_finding_count', findings['finding_count']))}",
        f"- Low-priority findings filtered from buyer delivery: {findings.get('low_priority_filtered_count', 0)}",
        f"- Highest severity: {findings['highest_severity']}",
        f"- Returned severity threshold: {findings.get('returned_severity_threshold', RETURNED_SEVERITY_THRESHOLD)}",
        f"- Ruleset: {target_summary.get('ruleset_version', CODE_AUDIT_RULESET_VERSION)}",
        f"- Scan profile: {target_summary.get('scan_profile', CODE_AUDIT_SCAN_PROFILE)}",
        f"- Batch limit: {findings.get('finding_limit', FINDING_LIMIT)} findings per run",
        f"- Deferred findings for a follow-up run: {findings.get('deferred_count', 0)}",
        f"- All medium-or-higher findings returned: {findings.get('all_findings_returned', False)}",
        f"- Input digest: `{normalized['text_digest_sha256']}`",
        f"- Buyer/repo namespace: `{as_dict(normalized.get('namespace')).get('namespace_key', 'default')}`",
        f"- Prior namespace runs: {memory_context.get('namespace_run_count', 0)}",
        f"- Target materialization: {target_summary.get('status')}",
        f"- Files scanned: {target_summary.get('files_scanned', 0)} of {target_summary.get('files_considered', 0)} considered",
        f"- Files seen in archive: {target_summary.get('files_seen', 0)}",
        f"- Files skipped by reason: {json.dumps(target_summary.get('files_skipped', {}), sort_keys=True)}",
        "",
        "## Target",
        "",
        f"- Status: {target_summary.get('status')}",
        f"- GitHub targets: {target_summary.get('github_target_count', 0)}",
        f"- Files scanned: {target_summary.get('files_scanned', 0)}",
        f"- Files considered: {target_summary.get('files_considered', 0)}",
        f"- Files seen: {target_summary.get('files_seen', 0)}",
        f"- Files skipped: {json.dumps(target_summary.get('files_skipped', {}), sort_keys=True)}",
        f"- Scan truncated: {target_summary.get('scan_truncated', False)}",
        "",
    ]
    for target in as_list(target_summary.get("targets")):
        if isinstance(target, dict):
            lines.append(
                f"- {target.get('kind', 'target')}: {target.get('source_url', '')} "
                f"({target.get('status', 'unknown')})"
            )
    detected_surfaces = as_list(protocol_surface.get("detected"))
    lines.extend(["", "## Protocol Surface Hints", ""])
    if detected_surfaces:
        lines.append("Detected protocol/runtime surfaces that shaped audit focus:")
        lines.append("")
        for item in detected_surfaces[:8]:
            if not isinstance(item, dict):
                continue
            lines.append(f"- {item.get('label', item.get('surface'))}: {item.get('hit_count', 0)} signal hits")
            for focus in as_list(item.get("audit_focus"))[:3]:
                lines.append(f"  - {focus}")
        lines.append("")
        lines.append(str(protocol_surface.get("guidance") or ""))
    else:
        lines.append("No SantaClawz/OpenClaw/x402/ZK-specific protocol surface was detected in the scanned material.")
    lines.extend(
        [
        "",
        "## Batch Behavior",
        "",
        (
            f"This run returns up to the first {findings.get('finding_limit', FINDING_LIMIT)} medium-or-higher findings "
            "so the audit stays bounded. Low-priority findings are filtered from buyer delivery. "
            "Run the same agent again with the same buyer identity and repo namespace until "
            "`all_findings_returned` is `true`."
        ),
        "",
        findings.get("completion_hint", ""),
        "",
        "## Memory Context",
        "",
        f"- Known finding fingerprints for this namespace: {memory_context.get('known_finding_count', 0)}",
        f"- Recent completed runs tracked: {len(as_list(memory_context.get('recent_runs')))}",
        f"- This batch new findings: {as_dict(findings.get('memory_batch')).get('new_findings_returned', 0)}",
        f"- This batch repeated findings: {as_dict(findings.get('memory_batch')).get('repeated_findings_returned', 0)}",
        f"- Repeat reason: {as_dict(findings.get('memory_batch')).get('reason_repeated') or 'none'}",
        "",
        ]
    )
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
        lines.extend(["## Additional Model Notes", ""])
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
        lines.extend(["## Review Mode", "", "Deterministic scan completed. Optional model notes were not included for this run.", ""])
    lines.extend(
        [
        "## Findings",
        "",
        ]
    )
    if not findings["findings"]:
        lines.append("No medium-or-higher deterministic findings were returned in this batch.")
    for finding in findings["findings"]:
        memory_status = as_dict(finding.get("memory")).get("status", "new")
        prior_count = as_dict(finding.get("memory")).get("prior_count", 0)
        lines.extend(
            [
                f"### {finding.get('stable_id', finding['id'])} - {finding['title']}",
                "",
                f"- Legacy batch ID: {finding['id']}",
                f"- Severity: {finding['severity']}",
                f"- Matches: {finding['match_count']}",
                f"- New for namespace: {bool(finding.get('is_new_for_namespace'))}",
                f"- Memory status: {memory_status} (prior count: {prior_count})",
                f"- Fingerprint: `{finding.get('fingerprint', '')}`",
                f"- Evidence type: {as_dict(finding.get('evidence_strength')).get('classification', 'deterministic_pattern_candidate')}",
                f"- Reachability proven: {as_dict(finding.get('evidence_strength')).get('reachability_proven', False)}",
                f"- Recommendation: {finding['recommendation']}",
                "",
            ]
        )
        buyer_note = as_dict(finding.get("evidence_strength")).get("buyer_note")
        if buyer_note:
            lines.extend([f"- Validation note: {buyer_note}", ""])
        for location in as_list(finding.get("locations"))[:5]:
            if isinstance(location, dict):
                lines.append(f"- Location: `{location.get('path')}:{location.get('line')}`")
        if finding.get("locations"):
            lines.append("")
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


def buyer_structured_result(
    normalized: dict[str, Any],
    findings: dict[str, Any],
    memory_context: dict[str, Any],
    materialized: dict[str, Any],
    ai_insights: dict[str, Any],
    package_hash: str,
    protocol_surface: dict[str, Any],
    verdict: dict[str, Any],
    buyer_summary_markdown: str,
) -> dict[str, Any]:
    target_summary = compact_target_materialization(materialized)
    target_urls = as_list(target_summary.get("urls"))
    materialized_as = as_list(target_summary.get("github_materialized_as"))
    report_sections = report_sections_projection(findings, buyer_summary_markdown)
    compact_verdict = {
        "verdict": verdict.get("verdict"),
        "highest_severity": verdict.get("highest_severity"),
        "returned_finding_count": verdict.get("returned_finding_count"),
        "recommended_next_action": compact_inline_text(verdict.get("recommended_next_action"), max_chars=260),
    }
    model_notes_available = ai_insights.get("status") == "completed"
    return {
        "schema_version": "code-audit-buyer-result/1.0",
        "report_version": "hosted-code-audit-report/1.0",
        "audit_status": "completed",
        "execution_mode": "standard_memory_backed_hosted_code_audit",
        "request_id": normalized["request_id"],
        "input_digest_sha256": normalized["text_digest_sha256"],
        "package_hash": package_hash,
        "verdict": compact_verdict,
        "delivery_surface": {
            "inline_markdown": True,
            "inline_structured_json": True,
            "downloadable_artifacts": False,
            "internal_verified_package": True,
        },
        "target": {
            "url": target_urls[0] if target_urls else "",
            "status": target_summary.get("status"),
            "materialized_as": materialized_as[0] if materialized_as else "",
            "files_considered": target_summary.get("files_considered", 0),
            "files_scanned": target_summary.get("files_scanned", 0),
            "scan_truncated": target_summary.get("scan_truncated", False),
            "ruleset_version": target_summary.get("ruleset_version", CODE_AUDIT_RULESET_VERSION),
        },
        "review_mode": {
            "mode": "deterministic_scan_plus_model_notes" if model_notes_available else "deterministic_scan",
            "deterministic_scan_completed": True,
            "memory_dedupe_completed": True,
            "model_notes_available": model_notes_available,
            "model_notes_status": ai_insights.get("status"),
            "model": ai_insights.get("model"),
        },
        "report_sections": report_sections,
        "protocol_surface": compact_protocol_surface_for_buyer(protocol_surface),
        "memory": {
            "prior_namespace_runs": memory_context.get("namespace_run_count", 0),
            "known_finding_count": memory_context.get("known_finding_count", 0),
            "new_finding_count": as_dict(findings.get("memory_batch")).get("new_findings_returned", 0),
            "repeated_finding_count": as_dict(findings.get("memory_batch")).get("repeated_findings_returned", 0),
            "has_more_findings": findings.get("has_more_findings"),
        },
        "batch": {
            "returned_finding_count": findings.get("returned_finding_count"),
            "total_active_finding_count": findings.get("total_active_finding_count"),
            "total_detected_finding_count": findings.get("total_detected_finding_count"),
            "highest_severity": findings.get("highest_severity"),
            "low_priority_filtered_count": findings.get("low_priority_filtered_count"),
            "deferred_count": findings.get("deferred_count"),
            "has_more_findings": findings.get("has_more_findings"),
            "all_findings_returned": findings.get("all_findings_returned"),
            "returned_severity_threshold": findings.get("returned_severity_threshold"),
        },
        "findings": [compact_finding_for_buyer_json(finding) for finding in as_list(findings.get("findings")) if isinstance(finding, dict)],
    }


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


def source_excerpt_for_model(units: list[dict[str, str]], findings: dict[str, Any]) -> str:
    priority_paths: list[str] = []
    for finding in as_list(findings.get("findings")):
        if not isinstance(finding, dict):
            continue
        for location in as_list(finding.get("locations")):
            if isinstance(location, dict) and location.get("path"):
                priority_paths.append(str(location["path"]))
    seen: set[str] = set()
    excerpts: list[str] = []
    for unit in units:
        path = unit.get("path", "submitted_payload")
        if path in seen:
            continue
        if priority_paths and path not in priority_paths and len(excerpts) >= 4:
            continue
        seen.add(path)
        content = unit.get("content", "")
        if not content.strip():
            continue
        excerpts.append(f"## {path}\n{content[:4000]}")
        if len("\n\n".join(excerpts)) >= MAX_MODEL_TEXT_CHARS:
            break
    return "\n\n".join(excerpts)[:MAX_MODEL_TEXT_CHARS]


def build_openai_audit_context(
    normalized: dict[str, Any],
    findings: dict[str, Any],
    memory_context: dict[str, Any],
    materialized: dict[str, Any],
    protocol_surface: dict[str, Any],
) -> dict[str, Any]:
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
            "total_detected_finding_count": findings.get("total_detected_finding_count"),
            "low_priority_filtered_count": findings.get("low_priority_filtered_count"),
            "deferred_count": findings.get("deferred_count"),
            "returned_severity_threshold": findings.get("returned_severity_threshold"),
            "has_more_findings": findings.get("has_more_findings"),
            "all_findings_returned": findings.get("all_findings_returned"),
            "next_batch_hint": findings.get("next_batch_hint"),
            "completion_hint": findings.get("completion_hint"),
        },
        "target_materialization": compact_target_materialization(materialized),
        "protocol_surface": protocol_surface,
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


def call_openai_for_insights(
    normalized: dict[str, Any],
    findings: dict[str, Any],
    memory_context: dict[str, Any],
    materialized: dict[str, Any],
    scan_units: list[dict[str, str]],
    protocol_surface: dict[str, Any],
) -> dict[str, Any]:
    openai_context = build_openai_audit_context(normalized, findings, memory_context, materialized, protocol_surface)
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
        "pay special attention to detected SantaClawz, OpenClaw, x402, and ZK/proof surfaces, "
        "call out likely false positives, and suggest what to inspect in the next paid run.\n\n"
        f"Client request:\n{normalized['client_request'][:3000]}\n\n"
        f"Submitted text excerpt:\n{normalized['text'][:6000]}\n\n"
        f"Materialized source excerpt:\n{source_excerpt_for_model(scan_units, findings)}\n\n"
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
    materialized = materialize_external_targets(payload)
    require_public_github_target(materialized)
    run_dir = DEFAULT_OUTPUT_ROOT / f"{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d-%H%M%S')}-{slug(normalized['request_id'])}"
    package_dir = run_dir / "output_package"
    package_dir.mkdir(parents=True, exist_ok=False)

    memory = load_memory()
    memory_context = compact_memory_context(memory, as_dict(normalized["namespace"]))
    scan_units = scan_units_from_target(normalized, materialized)
    raw_findings = audit_units(scan_units)
    memory_ranked_findings = apply_memory_to_findings(raw_findings, memory, as_dict(normalized["namespace"]))
    findings = select_findings_for_delivery(memory_ranked_findings)
    protocol_surface = detect_protocol_surfaces(normalized, materialized, scan_units)
    ai_insights = call_openai_for_insights(normalized, findings, memory_context, materialized, scan_units, protocol_surface)
    verdict = audit_verdict(findings, materialized, ai_insights, protocol_surface)
    report = render_report(normalized, findings, memory_context, ai_insights, materialized, protocol_surface, verdict)
    target_summary = compact_target_materialization(materialized)
    summary = render_buyer_summary(normalized, findings, memory_context, materialized, ai_insights, protocol_surface, verdict)

    files = [
        ("audit_report.md", report, "text/markdown"),
        ("findings.json", json.dumps(findings, indent=2, sort_keys=True) + "\n", "application/json"),
        ("memory_context.json", json.dumps(memory_context, indent=2, sort_keys=True) + "\n", "application/json"),
        ("ai_insights.json", json.dumps(ai_insights, indent=2, sort_keys=True) + "\n", "application/json"),
        ("protocol_surface.json", json.dumps(protocol_surface, indent=2, sort_keys=True) + "\n", "application/json"),
        (
            "target_materialization.json",
            json.dumps(target_summary, indent=2, sort_keys=True) + "\n",
            "application/json",
        ),
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
                    "total_detected_finding_count": findings.get("total_detected_finding_count"),
                    "low_priority_filtered_count": findings.get("low_priority_filtered_count"),
                    "deferred_count": findings.get("deferred_count"),
                    "returned_severity_threshold": findings.get("returned_severity_threshold"),
                    "returned_severities": findings.get("returned_severities"),
                    "memory_batch": findings.get("memory_batch"),
                    "has_more_findings": findings.get("has_more_findings"),
                    "all_findings_returned": findings.get("all_findings_returned"),
                    "completion_hint": findings.get("completion_hint"),
                    "protocol_surface": protocol_surface,
                    "verdict": verdict,
                    "target_materialization": target_summary,
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
    structured_buyer_result = buyer_structured_result(
        normalized,
        findings,
        memory_context,
        materialized,
        ai_insights,
        package_hash,
        protocol_surface,
        verdict,
        summary,
    )
    structured_buyer_result_text = json.dumps(structured_buyer_result, sort_keys=True, separators=(",", ":")) + "\n"
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
            "external_targets_materialized",
            "durable_memory_context_applied",
            "learning_update_written",
            "deliverables_hashed",
            "protocol_surface_hints_recorded",
            "manifest_written",
            "santaclawz_return_payload_written",
        ],
        "target_materialization": target_summary,
        "model_enrichment_status": ai_insights.get("status"),
        "protocol_surface": protocol_surface,
        "verdict": verdict,
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
            "total_detected_finding_count": findings.get("total_detected_finding_count"),
            "low_priority_filtered_count": findings.get("low_priority_filtered_count"),
            "deferred_count": findings.get("deferred_count"),
            "finding_limit": findings.get("finding_limit"),
            "returned_severity_threshold": findings.get("returned_severity_threshold"),
            "returned_severities": findings.get("returned_severities"),
            "memory_batch": findings.get("memory_batch"),
            "has_more_findings": findings.get("has_more_findings"),
            "all_findings_returned": findings.get("all_findings_returned"),
            "completion_hint": findings.get("completion_hint"),
            "highest_severity": findings["highest_severity"],
            "target_files_scanned": target_summary.get("files_scanned", 0),
            "target_status": target_summary.get("status"),
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
        "target_materialization": target_summary,
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
            "protocol_surface": protocol_surface,
            "verdict": verdict,
            "target_materialization": target_summary,
            "delivery_surface": {
                "inline_markdown": True,
                "inline_structured_json": True,
                "downloadable_artifacts": False,
                "internal_verified_package": True,
            },
            "finding_batch": {
                "returned_finding_count": findings.get("returned_finding_count"),
                "total_active_finding_count": findings.get("total_active_finding_count"),
                "total_detected_finding_count": findings.get("total_detected_finding_count"),
                "low_priority_filtered_count": findings.get("low_priority_filtered_count"),
                "deferred_count": findings.get("deferred_count"),
                "finding_limit": findings.get("finding_limit"),
                "returned_severity_threshold": findings.get("returned_severity_threshold"),
                "returned_severities": findings.get("returned_severities"),
                "memory_batch": findings.get("memory_batch"),
                "has_more_findings": findings.get("has_more_findings"),
                "all_findings_returned": findings.get("all_findings_returned"),
                "next_batch_hint": findings.get("next_batch_hint"),
                "completion_hint": findings.get("completion_hint"),
            },
            "deliverables": deliverables,
            "buyer_visible_outputs": [
                {
                    "name": "code-audit-summary.md",
                    "content_type": "text/markdown",
                    "text": summary,
                    "sha256": sha256_text(summary),
                },
                {
                    "name": "code-audit-result.json",
                    "content_type": "application/json",
                    "text": structured_buyer_result_text,
                    "sha256": sha256_text(structured_buyer_result_text),
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
        "total_detected_finding_count": findings.get("total_detected_finding_count"),
        "low_priority_filtered_count": findings.get("low_priority_filtered_count"),
        "deferred_count": findings.get("deferred_count"),
        "finding_limit": findings.get("finding_limit"),
        "returned_severity_threshold": findings.get("returned_severity_threshold"),
        "has_more_findings": findings.get("has_more_findings"),
        "all_findings_returned": findings.get("all_findings_returned"),
        "memory": learning_update,
        "target_materialization": target_summary,
        "model_enrichment_status": ai_insights.get("status"),
        "protocol_surface": protocol_surface,
        "verdict": verdict,
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
            "verdict": verdict.get("verdict"),
            "target_status": target_summary.get("status"),
            "target_files_scanned": target_summary.get("files_scanned", 0),
        }
    )
    return return_payload, quality


def log_event(event: dict[str, Any]) -> None:
    event.setdefault("created_at", now_iso())
    print(json.dumps(event, sort_keys=True), file=sys.stderr, flush=True)


def failure_payload(message: str, status_code: int, request_id: str | None = None, code: str = "code_audit_worker_failed") -> dict[str, Any]:
    return {
        "schema_version": "santaclawz-return/1.0",
        "request_id": request_id,
        "status": "failed",
        "return_channel": "santaclawz",
        "agent_private": True,
        "error": {
            "code": code,
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
    if not namespace_key:
        raise WorkerError("namespace_key is required so feedback stays scoped to one buyer/repo namespace", 400)
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
    memory["updated_at"] = now_iso()
    write_json_atomic(memory_path(), memory)
    namespace_file = namespace_memory_path(namespace_key)
    record = read_json(namespace_file, {})
    if not isinstance(record, dict):
        record = {}
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
        "namespace_memory_path": str(namespace_file),
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
            self.write_response(exc.status_code, failure_payload(str(exc), exc.status_code, request_id, exc.code))
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
