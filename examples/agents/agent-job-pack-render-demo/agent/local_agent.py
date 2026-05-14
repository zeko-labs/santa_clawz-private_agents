#!/usr/bin/env python3
"""Local service-agent runner.

This is intentionally dependency-free so OpenClaw can call it from a sandbox.
It routes a job request to a service playbook and produces a reviewable work plan.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import pathlib
import re
import sys
from dataclasses import dataclass
from typing import Any, Optional


ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "output"
SERVICES_DIR = ROOT / "services"
DATA_DIR = ROOT / "data"
LEARNING_STATE_PATH = DATA_DIR / "learning_state.json"
RECOMMENDATION_LOG_PATH = DATA_DIR / "recommendations.jsonl"
OUTCOME_LOG_PATH = DATA_DIR / "outcomes.jsonl"
PRICING_CONFIG_PATH = DATA_DIR / "pricing_config.json"
PACKAGE_FILES = [
    "agent_brief.md",
    "agent_business_brain.json",
    "bid_analysis.md",
    "deliverable_spec.json",
    "integration_handoff.json",
    "learning_feedback.json",
    "pricing_recommendation.md",
    "risk_register.json",
    "task_queue.json",
    "qa_checklist.md",
    "proposal_draft.md",
    "client_reply.md",
]


@dataclass(frozen=True)
class Service:
    key: str
    title: str
    best_for: str
    inputs: list[str]
    human_deliverables: list[str]
    agent_deliverables: list[str]
    approval_gates: list[str]


SERVICES: dict[str, Service] = {
    "agent_job_pack": Service(
        key="agent_job_pack",
        title="Agent Job-Winning Pack",
        best_for="agents deciding whether to bid on marketplace jobs and needing scoped, executable delivery plans",
        inputs=["job listing", "buyer goal", "deadline", "budget if available"],
        human_deliverables=[
            "bid/no-bid rationale",
            "proposal draft",
            "scope summary",
            "delivery plan",
            "QA checklist",
        ],
        agent_deliverables=[
            "bid analysis",
            "machine-readable deliverable spec",
            "risk register",
            "acceptance criteria",
            "task queue",
            "proposal draft",
            "QA checklist",
        ],
        approval_gates=["human approves bid/application"],
    ),
    "spreadsheet_cleanup": Service(
        key="spreadsheet_cleanup",
        title="Spreadsheet Cleanup",
        best_for="messy CSV/XLSX files, duplicate rows, inconsistent columns, formatting, and summary tabs",
        inputs=["source spreadsheet", "definition of clean", "required output format"],
        human_deliverables=[
            "data quality notes",
            "cleaning plan",
            "change log",
            "final spreadsheet checklist",
        ],
        agent_deliverables=[
            "schema map with normalized column names and types",
            "validation rules as JSON",
            "dedupe key strategy",
            "replayable cleaning recipe",
            "machine-readable change manifest",
        ],
        approval_gates=["confirm destructive changes before editing source data"],
    ),
    "ai_career_readiness": Service(
        key="ai_career_readiness",
        title="AI Career Readiness Pack",
        best_for="people preparing for AI-shaped jobs who need role targeting, resume positioning, training recommendations, and proof-of-work artifacts",
        inputs=["resume", "target role", "current skills", "time budget", "job examples if available"],
        human_deliverables=[
            "AI-era career positioning summary",
            "Resume and LinkedIn targeting plan",
            "role-specific skills gap map",
            "30-day training roadmap",
            "proof-of-work project brief",
            "certificate of completion recommendation",
        ],
        agent_deliverables=[
            "career profile JSON",
            "target role fit matrix",
            "skills gap map",
            "training recommendation plan",
            "portfolio project spec",
            "verification rubric",
        ],
        approval_gates=["human confirms resume facts and career claims are truthful"],
    ),
    "pitch_deck_review": Service(
        key="pitch_deck_review",
        title="Pitch Deck Review",
        best_for="startup decks, narrative clarity, investor readiness, and slide-by-slide critique",
        inputs=["deck file or slide text", "company stage", "target audience", "fundraising goal if relevant"],
        human_deliverables=[
            "executive summary",
            "slide-by-slide critique",
            "missing proof points",
            "rewrite suggestions",
        ],
        agent_deliverables=[
            "slide inventory as JSON",
            "claim-risk register",
            "investor objection list with evidence gaps",
            "rewrite task queue by slide",
            "deck scoring rubric",
        ],
        approval_gates=["human approves any investor-facing claims before delivery"],
    ),
    "resume_review": Service(
        key="resume_review",
        title="Resume Review",
        best_for="resume clarity, role targeting, ATS readability, and accomplishment bullets",
        inputs=["resume", "target role", "target companies or industry", "optional job description"],
        human_deliverables=[
            "resume diagnosis",
            "priority edits",
            "rewritten bullets",
            "ATS/readability checklist",
        ],
        agent_deliverables=[
            "resume fact inventory",
            "job-description keyword map",
            "truth-preserving bullet rewrite candidates",
            "ATS issue list as JSON",
            "application customization checklist",
        ],
        approval_gates=["human confirms all rewritten claims are truthful"],
    ),
    "ai_training_course": Service(
        key="ai_training_course",
        title="AI Training Course",
        best_for="beginner workshops, team enablement, prompt practice, and lightweight curriculum design",
        inputs=["audience", "duration", "tools allowed", "learning objectives"],
        human_deliverables=[
            "lesson outline",
            "hands-on exercises",
            "facilitator notes",
            "assessment rubric",
        ],
        agent_deliverables=[
            "modular lesson graph",
            "exercise prompts with expected outputs",
            "grading rubric as JSON",
            "learner state model",
            "course adaptation rules",
        ],
        approval_gates=["human verifies tool recommendations and policy-sensitive examples"],
    ),
    "reminder_bot": Service(
        key="reminder_bot",
        title="Reminder Bot",
        best_for="personal reminders, recurring check-ins, follow-ups, and accountability nudges",
        inputs=["reminder text", "schedule", "channel", "timezone"],
        human_deliverables=[
            "reminder schedule",
            "confirmation message",
            "failure/skip behavior",
            "privacy notes",
        ],
        agent_deliverables=[
            "canonical reminder spec",
            "timezone-normalized schedule",
            "idempotency key strategy",
            "notification template set",
            "escalation and snooze policy",
        ],
        approval_gates=["human approves external messages or calendar writes"],
    ),
}


DEFAULT_PRICING_CONFIG: dict[str, Any] = {
    "schema_version": "pricing-config/1.0",
    "currency": "USD",
    "target_margin_min": 0.5,
    "target_margin_max": 1.0,
    "platform_fee_rate": 0.01,
    "santaclawz_protocol_fee_bps": 100,
    "network_facilitation_fee_usd": 0.05,
    "settlement_model": "fee-on-reserve-v1",
    "default_rail": "base-usdc",
    "reserve_release_models": {
        "base-usdc": "x402-base-usdc-reserve-release-v4",
        "ethereum-usdc": "x402-ethereum-mainnet-usdc-reserve-release-v4",
    },
    "pricing_mode": {
        "agent_job_pack": "quote-required",
        "ai_career_readiness": "quote-required",
        "spreadsheet_cleanup": "fixed-exact",
        "pitch_deck_review": "quote-required",
        "resume_review": "fixed-exact",
        "ai_training_course": "quote-required",
        "reminder_bot": "fixed-exact",
    },
    "compute_cost_per_minute_usd": 0.003,
    "default_model_cost_per_1k_tokens_usd": 0.01,
    "risk_buffer_rate": 0.15,
    "minimum_price_usd": {
        "agent_job_pack": 0.5,
        "ai_career_readiness": 49.0,
        "spreadsheet_cleanup": 39.0,
        "pitch_deck_review": 79.0,
        "resume_review": 49.0,
        "ai_training_course": 149.0,
        "reminder_bot": 5.0,
    },
    "estimated_minutes": {
        "agent_job_pack": {"low": 8, "medium": 15, "high": 30},
        "ai_career_readiness": {"low": 20, "medium": 45, "high": 90},
        "spreadsheet_cleanup": {"low": 20, "medium": 60, "high": 120},
        "pitch_deck_review": {"low": 30, "medium": 75, "high": 150},
        "resume_review": {"low": 20, "medium": 45, "high": 90},
        "ai_training_course": {"low": 45, "medium": 120, "high": 240},
        "reminder_bot": {"low": 5, "medium": 15, "high": 30},
    },
    "estimated_model_tokens": {
        "agent_job_pack": {"low": 8000, "medium": 18000, "high": 40000},
        "ai_career_readiness": {"low": 12000, "medium": 30000, "high": 70000},
        "spreadsheet_cleanup": {"low": 10000, "medium": 25000, "high": 60000},
        "pitch_deck_review": {"low": 18000, "medium": 45000, "high": 100000},
        "resume_review": {"low": 10000, "medium": 24000, "high": 55000},
        "ai_training_course": {"low": 18000, "medium": 50000, "high": 120000},
        "reminder_bot": {"low": 3000, "medium": 7000, "high": 15000},
    },
}


ALIASES = {
    "agent": "agent_job_pack",
    "agent job": "agent_job_pack",
    "job-winning": "agent_job_pack",
    "proposal": "agent_job_pack",
    "bid": "agent_job_pack",
    "marketplace": "agent_job_pack",
    "spreadsheet": "spreadsheet_cleanup",
    "csv": "spreadsheet_cleanup",
    "excel": "spreadsheet_cleanup",
    "career": "ai_career_readiness",
    "job training": "ai_career_readiness",
    "training recommendation": "ai_career_readiness",
    "certification": "ai_career_readiness",
    "linkedin": "ai_career_readiness",
    "deck": "pitch_deck_review",
    "pitch": "pitch_deck_review",
    "slides": "pitch_deck_review",
    "resume": "resume_review",
    "cv": "resume_review",
    "course": "ai_training_course",
    "training": "ai_training_course",
    "lesson": "ai_training_course",
    "reminder": "reminder_bot",
    "followup": "reminder_bot",
    "follow-up": "reminder_bot",
}


def slugify(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "job"


def load_job(path: pathlib.Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("Job file must contain a JSON object.")
    return data


def infer_service(job: dict[str, Any]) -> Service:
    requested = str(job.get("service", "")).strip().lower()
    if requested in SERVICES:
        return SERVICES[requested]
    if requested in ALIASES:
        return SERVICES[ALIASES[requested]]

    text = " ".join(str(job.get(field, "")) for field in ("title", "summary", "client_request", "service"))
    text = text.lower()
    for alias, key in ALIASES.items():
        if alias in text:
            return SERVICES[key]
    return SERVICES["spreadsheet_cleanup"]


def missing_inputs(job: dict[str, Any], service: Service) -> list[str]:
    provided = {str(item).lower() for item in job.get("provided_inputs", []) if item}
    request_text = json.dumps(job, sort_keys=True).lower()
    missing = []
    for item in service.inputs:
        simple = item.split()[0].lower()
        if item.lower() not in provided and simple not in request_text:
            missing.append(item)
    return missing


def render_plan(job: dict[str, Any], service: Service) -> str:
    now = dt.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M %Z")
    title = job.get("title") or service.title
    client = job.get("client") or "Unknown client"
    request = job.get("client_request") or job.get("summary") or "No request text provided."
    missing = missing_inputs(job, service)

    lines = [
        f"# {title}",
        "",
        f"- Created: {now}",
        f"- Client: {client}",
        f"- Routed service: {service.title}",
        f"- Best for: {service.best_for}",
        "",
        "## Client Request",
        "",
        str(request).strip(),
        "",
        "## Intake Check",
        "",
    ]

    if missing:
        lines.extend(f"- Missing: {item}" for item in missing)
    else:
        lines.append("- All core inputs appear to be present.")

    lines.extend(
        [
            "",
            "## Human Deliverable Path",
            "",
            *[f"- {item}" for item in service.human_deliverables],
            "",
            "## Agent Deliverable Path",
            "",
            *[f"- {item}" for item in service.agent_deliverables],
            "",
            "## Work Plan",
            "",
            "1. Confirm scope, deadline, and success criteria.",
            "2. Inspect source material and list assumptions.",
            "3. Produce the first-pass deliverable in a separate working copy.",
            "4. Run a quality check against the service checklist.",
            "5. Ask for human approval before submitting to the client or platform.",
            "",
            "## Approval Gates",
            "",
            *[f"- {gate}" for gate in service.approval_gates],
            "- human approves final delivery",
            "",
            "## Suggested Client Reply",
            "",
            suggested_reply(service, missing),
            "",
        ]
    )
    return "\n".join(lines)


def job_text(job: dict[str, Any]) -> str:
    return str(job.get("client_request") or job.get("summary") or "").strip()


def job_title(job: dict[str, Any], service: Service) -> str:
    return str(job.get("title") or service.title).strip()


def list_value(job: dict[str, Any], key: str) -> list[str]:
    value = job.get(key, [])
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def infer_buyer_type(job: dict[str, Any]) -> str:
    explicit = str(job.get("buyer_type", "")).lower().strip()
    if explicit in {"agent", "human"}:
        return explicit
    text = json.dumps(job, sort_keys=True).lower()
    agent_terms = ["agent", "seekclaw", "marketplace", "credits", "apply", "proposal", "bid"]
    return "agent" if any(term in text for term in agent_terms) else "human"


def infer_complexity(job: dict[str, Any], service: Service) -> str:
    text = job_text(job)
    requested = list_value(job, "requested_deliverables")
    score = len(text) // 450 + len(requested)
    if job.get("budget"):
        score += 1
    if job.get("deadline"):
        score += 1
    if score >= 5:
        return "high"
    if score >= 2:
        return "medium"
    return "low"


def job_fingerprint(job: dict[str, Any], service: Service) -> str:
    raw = "|".join(
        [
            service.key,
            str(job.get("source", "")),
            job_title(job, service),
            job_text(job),
        ]
    ).lower()
    return slugify(raw)[:96]


def extract_learning_tags(job: dict[str, Any], service: Service) -> list[str]:
    text = json.dumps(job, sort_keys=True).lower()
    tags = [f"service:{service.key}", f"buyer:{infer_buyer_type(job)}"]
    if job.get("source"):
        tags.append(f"source:{slugify(str(job['source']))}")
    keyword_tags = {
        "budget": ["budget", "credits", "$"],
        "deadline": ["deadline", "urgent", "hours", "tomorrow"],
        "spreadsheet": ["csv", "xlsx", "excel", "sheets", "spreadsheet"],
        "deck": ["deck", "slides", "investor", "fundraising", "series a"],
        "resume": ["resume", "cv", "ats", "job description"],
        "career": ["career", "linkedin", "job training", "certification", "portfolio"],
        "qa": ["qa", "acceptance criteria", "test", "checklist"],
        "proposal": ["bid", "proposal", "apply", "marketplace"],
        "automation": ["bot", "workflow", "automation", "integration"],
    }
    for tag, terms in keyword_tags.items():
        if any(term in text for term in terms):
            tags.append(f"topic:{tag}")
    return unique_items(tags)


def default_learning_state() -> dict[str, Any]:
    return {
        "schema_version": "learning-state/1.0",
        "updated_at": None,
        "global": {"recommendations": 0, "outcomes": 0, "wins": 0, "losses": 0},
        "tags": {},
        "services": {},
        "sources": {},
        "notes": [],
    }


def load_learning_state() -> dict[str, Any]:
    if not LEARNING_STATE_PATH.exists():
        return default_learning_state()
    try:
        with LEARNING_STATE_PATH.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except json.JSONDecodeError:
        return default_learning_state()
    if not isinstance(data, dict):
        return default_learning_state()
    state = default_learning_state()
    state.update(data)
    return state


def save_learning_state(state: dict[str, Any]) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    state["updated_at"] = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    write_json(LEARNING_STATE_PATH, state)


def load_pricing_config() -> dict[str, Any]:
    if not PRICING_CONFIG_PATH.exists():
        DATA_DIR.mkdir(exist_ok=True)
        write_json(PRICING_CONFIG_PATH, DEFAULT_PRICING_CONFIG)
        return json.loads(json.dumps(DEFAULT_PRICING_CONFIG))
    try:
        with PRICING_CONFIG_PATH.open("r", encoding="utf-8") as handle:
            loaded = json.load(handle)
    except json.JSONDecodeError:
        return json.loads(json.dumps(DEFAULT_PRICING_CONFIG))
    config = json.loads(json.dumps(DEFAULT_PRICING_CONFIG))
    if isinstance(loaded, dict):
        for key, value in loaded.items():
            if isinstance(value, dict) and isinstance(config.get(key), dict):
                config[key].update(value)
            else:
                config[key] = value
    return config


def nested_lookup(config: dict[str, Any], section: str, service: Service, complexity: str, fallback: float) -> float:
    value = config.get(section, {})
    if isinstance(value, dict):
        service_value = value.get(service.key, {})
        if isinstance(service_value, dict):
            raw = service_value.get(complexity)
            if isinstance(raw, (int, float)):
                return float(raw)
    return fallback


def estimate_job_cost(job: dict[str, Any], service: Service, complexity: str, config: dict[str, Any]) -> dict[str, Any]:
    minutes = nested_lookup(config, "estimated_minutes", service, complexity, 30.0)
    tokens = nested_lookup(config, "estimated_model_tokens", service, complexity, 20000.0)
    token_cost = (tokens / 1000.0) * float(config.get("default_model_cost_per_1k_tokens_usd", 0.01))
    compute_cost = minutes * float(config.get("compute_cost_per_minute_usd", 0.003))
    subtotal = token_cost + compute_cost
    buffer = subtotal * float(config.get("risk_buffer_rate", 0.15))
    platform_fee_rate = float(config.get("platform_fee_rate", 0.01))
    return {
        "estimated_minutes": round(minutes, 2),
        "estimated_model_tokens": int(tokens),
        "model_api_cost_usd": round(token_cost, 4),
        "compute_cost_usd": round(compute_cost, 4),
        "risk_buffer_usd": round(buffer, 4),
        "platform_fee_rate": platform_fee_rate,
        "estimated_direct_cost_usd": round(subtotal + buffer, 4),
    }


def parse_price_usd(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value).replace(",", "").lower()
    match = re.search(r"[-+]?\d+(?:\.\d+)?", text)
    if not match:
        return None
    amount = float(match.group(0))
    if "cent" in text and amount > 1:
        return amount / 100.0
    return amount


def service_minimum_price(config: dict[str, Any], service: Service) -> float:
    minimums = config.get("minimum_price_usd", {})
    if isinstance(minimums, dict) and isinstance(minimums.get(service.key), (int, float)):
        return float(minimums[service.key])
    return 9.0


def service_pricing_mode(config: dict[str, Any], service: Service) -> str:
    modes = config.get("pricing_mode", {})
    if isinstance(modes, dict) and str(modes.get(service.key) or "").strip():
        return str(modes[service.key]).strip()
    return "quote-required"


def onchain_fee_preview(gross_amount_usd: float, config: dict[str, Any]) -> dict[str, Any]:
    fee_bps = int(config.get("santaclawz_protocol_fee_bps", 100))
    protocol_fee = gross_amount_usd * fee_bps / 10000.0
    network_fee = float(config.get("network_facilitation_fee_usd", 0.05))
    effective_fee = max(protocol_fee, network_fee)
    fee_basis = "protocol-bps" if protocol_fee >= network_fee else "network-facilitation-minimum"
    seller_net = gross_amount_usd - effective_fee
    rail = str(config.get("default_rail", "base-usdc"))
    models = config.get("reserve_release_models", {})
    reserve_release_model = models.get(rail) if isinstance(models, dict) else None
    pricing_commitment = {
        "currency": str(config.get("currency", "USD")),
        "default_rail": rail,
        "gross_amount_usd": round(gross_amount_usd, 2),
        "network_facilitation_fee_usd": round(network_fee, 4),
        "protocol_fee_bps": fee_bps,
        "settlement_model": str(config.get("settlement_model", "fee-on-reserve-v1")),
    }
    material = json.dumps(pricing_commitment, sort_keys=True).encode("utf-8")
    return {
        "settlement_model": pricing_commitment["settlement_model"],
        "reserve_release_model": reserve_release_model,
        "default_rail": rail,
        "protocol_fee_bps": fee_bps,
        "protocol_fee_amount_usd": round(protocol_fee, 4),
        "network_facilitation_fee_amount_usd": round(network_fee, 4),
        "effective_fee_amount_usd": round(effective_fee, 4),
        "fee_basis": fee_basis,
        "gross_amount_usd": round(gross_amount_usd, 2),
        "seller_net_amount_usd": round(seller_net, 2),
        "pricing_commitment_sha256": hashlib.sha256(material).hexdigest(),
        "pricing_commitment": pricing_commitment,
    }


def seller_net_for_price(price_usd: float, config: dict[str, Any]) -> float:
    return float(onchain_fee_preview(price_usd, config)["seller_net_amount_usd"])


def price_for_margin(direct_cost: float, target_margin: float, minimum: float, config: dict[str, Any]) -> float:
    candidate = max(minimum, direct_cost * (1 + target_margin))
    for _ in range(8):
        net = seller_net_for_price(candidate, config)
        required_net = direct_cost * (1 + target_margin)
        if net >= required_net:
            return candidate
        candidate += required_net - net
    return candidate


def agent_pricing_command(service: Service, pricing: dict[str, Any]) -> str:
    mode = str(pricing.get("pricing_mode") or "quote-required")
    rail = str(pricing.get("onchain_settlement", {}).get("default_rail") or "base-usdc")
    if mode == "fixed-exact":
        return (
            "pnpm agent:pricing -- --env-file .env.santaclawz --open-for-work "
            f"--pricing-mode fixed-exact --fixed-price-usd {pricing['selected_price_usd']} "
            f"--default-rail {rail}"
        )
    return (
        "pnpm agent:pricing -- --env-file .env.santaclawz --open-for-work "
        f"--pricing-mode quote-required --reference-price-usd {pricing['recommended_prices']['target_price_usd']} "
        f"--reference-price-unit minimum --default-rail {rail}"
    )


def build_pricing_recommendation(job: dict[str, Any], service: Service, complexity: str, state: dict[str, Any]) -> dict[str, Any]:
    config = load_pricing_config()
    cost = estimate_job_cost(job, service, complexity, config)
    direct_cost = float(cost["estimated_direct_cost_usd"])
    target_min = float(config.get("target_margin_min", 0.5))
    target_max = float(config.get("target_margin_max", 1.0))
    minimum = service_minimum_price(config, service)
    pricing_mode = service_pricing_mode(config, service)

    floor_price = price_for_margin(direct_cost, target_min, minimum, config)
    target_price = price_for_margin(direct_cost, (target_min + target_max) / 2, minimum, config)
    premium_price = price_for_margin(direct_cost, target_max, minimum, config)
    offered = parse_price_usd(job.get("budget") or job.get("price") or job.get("amount_usd"))
    effective = offered if offered is not None else target_price
    onchain = onchain_fee_preview(effective, config)
    net_after_fee = float(onchain["seller_net_amount_usd"])
    gross_margin = (net_after_fee - direct_cost) / max(0.01, direct_cost)

    warnings = []
    if offered is None:
        warnings.append("No buyer price detected; quote before execution.")
    if gross_margin < target_min:
        warnings.append("Offered or selected price is below the 50% minimum margin target.")
    if gross_margin < 0:
        warnings.append("Do not run: estimated direct cost is higher than net revenue.")
    if net_after_fee <= 0:
        warnings.append("Do not run: onchain/network facilitation fee would consume the full payment.")
    if pricing_mode == "quote-required":
        warnings.append("Production listing should use quote_intake first, then paid_execution after exact quote settlement.")

    service_stats = state.get("services", {}).get(service.key, {})
    historical_margin = service_stats.get("avg_margin")
    if isinstance(historical_margin, (int, float)) and historical_margin < target_min:
        warnings.append("Historical margin for this service is below target; raise price or narrow scope.")

    return {
        "schema_version": "pricing-recommendation/1.0",
        "currency": str(config.get("currency", "USD")),
        "pricing_mode": pricing_mode,
        "canonical_hire_fields": {
            "quote_intake": {
                "request_type": "quote_intake",
                "pricing_mode": "quote-required",
                "payment_status": "quote_requested",
                "paid_or_escrowed": False,
            },
            "paid_execution": {
                "request_type": "paid_execution",
                "pricing_mode": "fixed-exact",
                "payment_status": "settled|paid|escrowed",
                "paid_or_escrowed": True,
                "settled_amount_usd": round(effective, 2),
                "rail": onchain["default_rail"],
            },
        },
        "target_margin_range": {"min": target_min, "max": target_max},
        "cost_estimate": cost,
        "recommended_prices": {
            "floor_price_usd": round(floor_price, 2),
            "target_price_usd": round(target_price, 2),
            "premium_price_usd": round(premium_price, 2),
        },
        "buyer_offered_price_usd": round(offered, 2) if offered is not None else None,
        "selected_price_usd": round(effective, 2),
        "estimated_net_after_platform_fee_usd": round(net_after_fee, 2),
        "estimated_seller_net_after_onchain_fee_usd": round(net_after_fee, 2),
        "onchain_settlement": onchain,
        "estimated_margin_ratio": round(gross_margin, 3),
        "estimated_margin_percent": round(gross_margin * 100, 1),
        "pricing_decision": "safe_to_run" if gross_margin >= target_min else "raise_price_or_decline",
        "warnings": warnings,
        "auto_update_policy": "recommend_only_human_approves_live_price",
    }


def build_business_brain(job: dict[str, Any], service: Service, spec: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    pricing = spec["pricing"]
    fit_score = int(spec["bid_recommendation"]["fit_score"])
    margin = float(pricing["estimated_margin_ratio"])
    should_bid = spec["bid_recommendation"]["decision"] == "bid" and pricing["pricing_decision"] == "safe_to_run"
    warnings = list(pricing.get("warnings", []))
    if fit_score < 75:
        warnings.append("Fit score is below strong-bid threshold; clarify scope before committing.")
    return {
        "schema_version": "agent-business-brain/1.0",
        "created_at": spec["created_at"],
        "service_key": service.key,
        "job_id": spec["job_id"],
        "decision": {
            "should_bid": should_bid,
            "should_run_now": should_bid and not high_severity_risk(spec["risks"]),
            "recommended_action": "bid_and_run_after_payment" if should_bid else "clarify_raise_price_or_decline",
            "confidence": "high" if fit_score >= 80 and margin >= 0.5 else "medium" if fit_score >= 60 else "low",
        },
        "pricing": pricing,
        "learning": {
            "outcomes_logged": state.get("global", {}).get("outcomes", 0),
            "recommendations_logged": state.get("global", {}).get("recommendations", 0),
            "signals_used": spec["learning"]["signals"],
            "next_feedback_needed": [
                "whether the bid won",
                "final paid amount",
                "actual API/compute cost if known",
                "delivery accepted/disputed/refunded",
                "lesson learned",
            ],
        },
        "warnings": warnings,
    }


def append_jsonl(path: pathlib.Path, record: dict[str, Any]) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def update_counter(bucket: dict[str, Any], outcome: str, value: float) -> None:
    bucket["seen"] = int(bucket.get("seen", 0)) + 1
    if outcome in {"won", "delivered", "paid", "accepted"}:
        bucket["wins"] = int(bucket.get("wins", 0)) + 1
    if outcome in {"lost", "declined", "disputed", "refunded"}:
        bucket["losses"] = int(bucket.get("losses", 0)) + 1
    bucket["value"] = float(bucket.get("value", 0.0)) + value
    wins = int(bucket.get("wins", 0))
    losses = int(bucket.get("losses", 0))
    bucket["win_rate"] = round(wins / max(1, wins + losses), 3)


def update_profit_counter(bucket: dict[str, Any], revenue: float, cost: float) -> None:
    if revenue <= 0 and cost <= 0:
        return
    bucket["revenue"] = round(float(bucket.get("revenue", 0.0)) + revenue, 4)
    bucket["cost"] = round(float(bucket.get("cost", 0.0)) + cost, 4)
    margin_value = revenue - cost
    bucket["profit"] = round(float(bucket.get("profit", 0.0)) + margin_value, 4)
    priced_seen = int(bucket.get("priced_seen", 0)) + 1
    bucket["priced_seen"] = priced_seen
    margin_ratio = margin_value / max(0.01, cost) if cost else 0.0
    previous = float(bucket.get("avg_margin", 0.0))
    bucket["avg_margin"] = round(((previous * (priced_seen - 1)) + margin_ratio) / priced_seen, 3)


def learning_adjustment(job: dict[str, Any], service: Service, state: dict[str, Any]) -> dict[str, Any]:
    tags = extract_learning_tags(job, service)
    signals = []
    adjustment = 0

    service_stats = state.get("services", {}).get(service.key, {})
    source_key = slugify(str(job.get("source") or "local"))
    source_stats = state.get("sources", {}).get(source_key, {})

    for label, stats, weight in [
        (f"service:{service.key}", service_stats, 10),
        (f"source:{source_key}", source_stats, 6),
    ]:
        seen = int(stats.get("seen", 0))
        win_rate = float(stats.get("win_rate", 0.0))
        if seen >= 3:
            delta = round((win_rate - 0.5) * weight)
            adjustment += delta
            signals.append({"signal": label, "seen": seen, "win_rate": win_rate, "score_delta": delta})

    for tag in tags:
        stats = state.get("tags", {}).get(tag, {})
        seen = int(stats.get("seen", 0))
        win_rate = float(stats.get("win_rate", 0.0))
        if seen >= 2:
            delta = round((win_rate - 0.5) * 5)
            adjustment += delta
            signals.append({"signal": tag, "seen": seen, "win_rate": win_rate, "score_delta": delta})

    return {
        "score_delta": max(-15, min(15, adjustment)),
        "tags": tags,
        "signals": signals,
        "learning_state_available": bool(state.get("global", {}).get("outcomes")),
    }


def bid_recommendation(job: dict[str, Any], service: Service, missing: list[str], state: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    request = job_text(job).lower()
    red_flags = risk_flags(job, service, missing)
    state = state or load_learning_state()
    learned = learning_adjustment(job, service, state)
    positive_terms = [
        service.key.replace("_", " "),
        "deliverables",
        "budget",
        "credits",
        "deadline",
        "csv",
        "deck",
        "resume",
        "analysis",
        "checklist",
    ]
    fit_score = 60
    fit_score += min(25, sum(5 for term in positive_terms if term in request or term in json.dumps(job).lower()))
    fit_score -= min(30, len(red_flags) * 8)
    fit_score -= min(20, len(missing) * 5)
    fit_score += int(learned["score_delta"])
    fit_score = max(0, min(100, fit_score))

    if fit_score >= 75 and not high_severity_risk(red_flags):
        decision = "bid"
    elif fit_score >= 55:
        decision = "clarify_then_bid"
    else:
        decision = "decline_or_request_scope_change"

    return {
        "decision": decision,
        "fit_score": fit_score,
        "learning_adjustment": learned,
        "rationale": [
            f"Routed to {service.title}, which matches the requested work.",
            "The job is concrete enough to scope." if len(missing) <= 1 else "Several core inputs need clarification before committing.",
            "No blocking safety issue detected." if not high_severity_risk(red_flags) else "A blocking risk needs human review before bidding.",
        ],
    }


def high_severity_risk(flags: list[dict[str, str]]) -> bool:
    return any(flag.get("severity") == "high" for flag in flags)


def risk_flags(job: dict[str, Any], service: Service, missing: list[str]) -> list[dict[str, str]]:
    text = json.dumps(job, sort_keys=True).lower()
    flags: list[dict[str, str]] = []
    blocked_terms = [
        ("impersonat", "Requests involving impersonation are not allowed."),
        ("fake", "Requests to fabricate facts or credentials are not allowed."),
        ("password", "Credential sharing or account access needs explicit human approval and safer handling."),
        ("guarantee", "Outcome guarantees are risky and should be avoided."),
        ("without approval", "External actions without approval are not allowed."),
    ]
    for term, reason in blocked_terms:
        if term in text:
            severity = "high" if term in {"impersonat", "fake", "password"} else "medium"
            flags.append({"severity": severity, "risk": reason})

    if missing:
        flags.append({"severity": "medium", "risk": "Missing inputs may cause rework or delivery dispute."})
    if service.key == "resume_review":
        flags.append({"severity": "medium", "risk": "Resume edits must preserve truthful candidate facts."})
    if service.key == "ai_career_readiness":
        flags.append({"severity": "medium", "risk": "Career recommendations should not guarantee hiring outcomes or certify skills not directly verified."})
    if service.key == "pitch_deck_review":
        flags.append({"severity": "medium", "risk": "Investor-facing claims need evidence and human approval."})
    if service.key == "agent_job_pack":
        flags.append({"severity": "medium", "risk": "Bid should not be submitted until the human operator approves scope and price."})
    return flags


def acceptance_criteria(service: Service, missing: list[str]) -> list[str]:
    criteria = [
        "All stated client deliverables are addressed.",
        "Assumptions and missing inputs are listed explicitly.",
        "Final output is reviewable before external submission.",
        "No claims are invented or materially changed without approval.",
    ]
    criteria.extend(f"Includes agent artifact: {item}." for item in service.agent_deliverables[:3])
    if missing:
        criteria.append("Clarifying questions are answered before final delivery.")
    return criteria


def build_deliverable_spec(job: dict[str, Any], service: Service) -> dict[str, Any]:
    state = load_learning_state()
    missing = missing_inputs(job, service)
    bid = bid_recommendation(job, service, missing, state)
    complexity = infer_complexity(job, service)
    pricing = build_pricing_recommendation(job, service, complexity, state)
    approval_gates = unique_items([*service.approval_gates, "human approves bid/application", "human approves final delivery"])
    return {
        "schema_version": "agent-deliverable-pack/1.0",
        "package_type": "job_winning_pack",
        "job_id": job_fingerprint(job, service),
        "created_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "job": {
            "title": job_title(job, service),
            "client": job.get("client") or "Unknown client",
            "source": job.get("source") or "local",
            "deadline": job.get("deadline"),
            "budget": job.get("budget"),
            "buyer_type": infer_buyer_type(job),
            "request": job_text(job),
        },
        "routing": {
            "service_key": service.key,
            "service_title": service.title,
            "complexity": complexity,
            "best_for": service.best_for,
        },
        "bid_recommendation": bid,
        "pricing": pricing,
        "learning": {
            "tags": bid["learning_adjustment"]["tags"],
            "signals": bid["learning_adjustment"]["signals"],
            "recommendations_logged": state.get("global", {}).get("recommendations", 0),
            "outcomes_logged": state.get("global", {}).get("outcomes", 0),
        },
        "scope": {
            "in_scope": service.agent_deliverables,
            "human_facing_outputs": service.human_deliverables,
            "out_of_scope": scope_exclusions(service),
            "missing_inputs": missing,
        },
        "risks": risk_flags(job, service, missing),
        "acceptance_criteria": acceptance_criteria(service, missing),
        "approval_gates": approval_gates,
    }


def unique_items(items: list[str]) -> list[str]:
    seen = set()
    unique = []
    for item in items:
        normalized = item.lower().strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            unique.append(item)
    return unique


def scope_exclusions(service: Service) -> list[str]:
    common = [
        "external submission without human approval",
        "credential handling",
        "billing or accepting platform terms on the user's behalf",
    ]
    service_specific = {
        "spreadsheet_cleanup": ["tax, legal, or investment advice", "overwriting source files"],
        "ai_career_readiness": ["guaranteeing interviews or jobs", "issuing accredited credentials", "fabricating portfolio or resume claims"],
        "agent_job_pack": ["submitting bids without approval", "accepting platform terms", "guaranteeing job win rate"],
        "pitch_deck_review": ["inventing traction metrics", "securities-law advice", "fundraising guarantees"],
        "resume_review": ["fabricating experience", "guaranteeing interviews", "submitting applications without approval"],
        "ai_training_course": ["credentialed certification claims", "policy evasion training"],
        "reminder_bot": ["medical adherence guarantees", "unconsented messages"],
    }
    return [*common, *service_specific.get(service.key, [])]


def build_task_queue(job: dict[str, Any], service: Service) -> dict[str, Any]:
    missing = missing_inputs(job, service)
    tasks = [
        {
            "id": "T1",
            "title": "Confirm bid decision",
            "owner": "agent",
            "status": "ready",
            "depends_on": [],
            "instructions": "Use deliverable_spec.bid_recommendation to decide whether to bid, clarify, or decline.",
            "done_when": "A bid decision and rationale are recorded.",
        },
        {
            "id": "T2",
            "title": "Resolve missing inputs",
            "owner": "agent",
            "status": "blocked" if missing else "ready",
            "depends_on": ["T1"],
            "instructions": "Ask only the clarifying questions needed to remove delivery risk.",
            "done_when": "All required inputs are present or explicitly marked as assumptions.",
        },
        {
            "id": "T3",
            "title": "Draft proposal",
            "owner": "agent",
            "status": "ready",
            "depends_on": ["T1"],
            "instructions": "Use proposal_draft.md as the base proposal and adapt it to the platform.",
            "done_when": "Proposal is concise, scoped, and ready for human approval.",
        },
        {
            "id": "T4",
            "title": f"Produce {service.title.lower()} agent artifacts",
            "owner": "agent",
            "status": "pending",
            "depends_on": ["T2", "T3"],
            "instructions": "Create the structured deliverables listed in deliverable_spec.scope.in_scope.",
            "done_when": "Every in-scope agent artifact exists and is internally consistent.",
        },
        {
            "id": "T5",
            "title": "Run final QA",
            "owner": "agent",
            "status": "pending",
            "depends_on": ["T4"],
            "instructions": "Use qa_checklist.md and record any unresolved risks.",
            "done_when": "All acceptance criteria are satisfied or exceptions are documented.",
        },
        {
            "id": "T6",
            "title": "Request human approval",
            "owner": "human",
            "status": "pending",
            "depends_on": ["T5"],
            "instructions": "Ask for approval before applying, submitting, messaging, billing, or publishing.",
            "done_when": "Human approval is captured.",
        },
    ]
    return {
        "schema_version": "task-queue/1.0",
        "job_title": job_title(job, service),
        "tasks": tasks,
    }


def render_agent_brief(job: dict[str, Any], service: Service, spec: dict[str, Any]) -> str:
    missing = spec["scope"]["missing_inputs"]
    bid = spec["bid_recommendation"]
    risks = spec["risks"]
    lines = [
        f"# Agent Brief: {job_title(job, service)}",
        "",
        f"- Service: {service.title}",
        f"- Buyer type: {spec['job']['buyer_type']}",
        f"- Recommendation: {bid['decision']}",
        f"- Fit score: {bid['fit_score']}/100",
        f"- Complexity: {spec['routing']['complexity']}",
        "",
        "## Job Request",
        "",
        job_text(job) or "No request text provided.",
        "",
        "## Why This Is Worth Bidding",
        "",
        *[f"- {item}" for item in bid["rationale"]],
        "",
        "## Missing Inputs",
        "",
    ]
    lines.extend([f"- {item}" for item in missing] if missing else ["- None detected."])
    lines.extend(
        [
            "",
            "## Agent-Facing Deliverables",
            "",
            *[f"- {item}" for item in service.agent_deliverables],
            "",
            "## Risk Register",
            "",
        ]
    )
    if risks:
        lines.extend(f"- {flag['severity']}: {flag['risk']}" for flag in risks)
    else:
        lines.append("- No material risk detected.")
    lines.extend(
        [
            "",
            "## Business Brain",
            "",
            f"- Pricing decision: {spec['pricing']['pricing_decision']}",
            f"- Recommended target price: ${spec['pricing']['recommended_prices']['target_price_usd']}",
            f"- Estimated margin: {spec['pricing']['estimated_margin_percent']}%",
            f"- Run now: {'yes' if spec['pricing']['pricing_decision'] == 'safe_to_run' and bid['decision'] == 'bid' else 'no, clarify price or scope first'}",
        ]
    )
    pricing_warnings = spec["pricing"].get("warnings") or []
    if pricing_warnings:
        lines.extend(["", "## Pricing Warnings", "", *[f"- {warning}" for warning in pricing_warnings]])
    lines.extend(
        [
            "",
            "## Acceptance Criteria",
            "",
            *[f"- {item}" for item in spec["acceptance_criteria"]],
            "",
            "## Operator Note",
            "",
            "This package is designed for another agent to consume. Keep final submission gated on human approval.",
            "",
        ]
    )
    return "\n".join(lines)


def render_qa_checklist(job: dict[str, Any], service: Service, spec: dict[str, Any]) -> str:
    checks = [
        "The bid decision matches the known scope and risk level.",
        "The proposal does not promise unsupported outcomes.",
        "All missing inputs are asked as concise clarifying questions.",
        "Every acceptance criterion in deliverable_spec.json is checked.",
        "All generated facts are traceable to provided source material or marked as assumptions.",
        "No external action is taken before human approval.",
    ]
    checks.extend(f"The package includes {item}." for item in PACKAGE_FILES if item != "qa_checklist.md")
    lines = [
        f"# QA Checklist: {job_title(job, service)}",
        "",
        "## Required Checks",
        "",
        *[f"- [ ] {check}" for check in checks],
        "",
        "## Service-Specific Checks",
        "",
        *[f"- [ ] {criterion}" for criterion in spec["acceptance_criteria"]],
        "",
        "## Approval",
        "",
        "- [ ] Human approved bid/application.",
        "- [ ] Human approved final delivery.",
        "",
    ]
    return "\n".join(lines)


def render_bid_analysis(job: dict[str, Any], service: Service, spec: dict[str, Any]) -> str:
    bid = spec["bid_recommendation"]
    pricing = spec["pricing"]
    risks = spec["risks"]
    lines = [
        f"# Bid Analysis: {job_title(job, service)}",
        "",
        f"- Decision: {bid['decision']}",
        f"- Fit score: {bid['fit_score']}/100",
        f"- Pricing decision: {pricing['pricing_decision']}",
        f"- Target price: ${pricing['recommended_prices']['target_price_usd']}",
        f"- Estimated margin: {pricing['estimated_margin_percent']}%",
        f"- Delivery posture: scoped, reviewable, approval-gated",
        "",
        "## Rationale",
        "",
        *[f"- {item}" for item in bid["rationale"]],
        "",
        "## Win Themes",
        "",
        "- Emphasize structured delivery rather than generic advice.",
        "- Name the acceptance criteria before work begins.",
        "- Promise a transparent risk register and QA checklist.",
        "- Keep investor-facing, resume-facing, or client-facing claims evidence-gated.",
        "",
        "## Risks To Mention Or Internally Track",
        "",
    ]
    if risks:
        lines.extend(f"- {flag['severity']}: {flag['risk']}" for flag in risks)
    else:
        lines.append("- No material risks detected.")
    lines.extend(
        [
            "",
            "## Bid Conditions",
            "",
            "- The client provides necessary source files and context.",
            "- Any external submission waits for human approval.",
            "- Any unsupported claim is marked as an assumption or removed.",
            "",
        ]
    )
    return "\n".join(lines)


def render_pricing_recommendation(job: dict[str, Any], service: Service, spec: dict[str, Any]) -> str:
    pricing = spec["pricing"]
    cost = pricing["cost_estimate"]
    prices = pricing["recommended_prices"]
    onchain = pricing["onchain_settlement"]
    lines = [
        f"# Pricing Recommendation: {job_title(job, service)}",
        "",
        f"- Service: {service.title}",
        f"- Complexity: {spec['routing']['complexity']}",
        f"- SantaClawz pricing mode: {pricing['pricing_mode']}",
        f"- Pricing decision: {pricing['pricing_decision']}",
        f"- Selected price: ${pricing['selected_price_usd']}",
        f"- Estimated seller net after onchain fee: ${pricing['estimated_seller_net_after_onchain_fee_usd']}",
        f"- Estimated direct cost: ${cost['estimated_direct_cost_usd']}",
        f"- Estimated margin: {pricing['estimated_margin_percent']}%",
        "",
        "## SantaClawz Onchain Settlement",
        "",
        f"- Settlement model: {onchain['settlement_model']}",
        f"- Reserve-release model: {onchain['reserve_release_model']}",
        f"- Default rail: {onchain['default_rail']}",
        f"- Gross amount: ${onchain['gross_amount_usd']}",
        f"- Seller net amount: ${onchain['seller_net_amount_usd']}",
        f"- Protocol owner fee: {onchain['protocol_fee_bps']} bps (${onchain['protocol_fee_amount_usd']})",
        f"- Network facilitation fee estimate: ${onchain['network_facilitation_fee_amount_usd']}",
        f"- Effective fee basis: {onchain['fee_basis']}",
        f"- Pricing commitment SHA-256: {onchain['pricing_commitment_sha256']}",
        "",
        "## Listing Update Command",
        "",
        "```zsh",
        agent_pricing_command(service, pricing),
        "```",
        "",
        "## Recommended Price Band",
        "",
        f"- Floor price: ${prices['floor_price_usd']} (minimum 50% margin target)",
        f"- Target price: ${prices['target_price_usd']}",
        f"- Premium price: ${prices['premium_price_usd']} (100% margin target)",
        "",
        "## Cost Assumptions",
        "",
        f"- Estimated model tokens: {cost['estimated_model_tokens']}",
        f"- Model/API cost: ${cost['model_api_cost_usd']}",
        f"- Estimated compute minutes: {cost['estimated_minutes']}",
        f"- Compute cost: ${cost['compute_cost_usd']}",
        f"- Risk buffer: ${cost['risk_buffer_usd']}",
        f"- Platform fee rate compatibility field: {round(cost['platform_fee_rate'] * 100, 2)}%",
        "",
        "## Warnings",
        "",
    ]
    warnings = pricing.get("warnings") or []
    lines.extend([f"- {warning}" for warning in warnings] if warnings else ["- None."])
    lines.extend(
        [
            "",
            "## Pricing Update Rule",
            "",
            "Recommend a price increase when seller net after onchain/network fee is below 50% margin, historical service margin is below 50%, or actual cost exceeds estimate.",
            "Do not update live pricing automatically; require operator approval before changing SantaClawz listing prices.",
            "",
        ]
    )
    return "\n".join(lines)


def build_learning_feedback(job: dict[str, Any], service: Service, spec: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": "learning-feedback/1.0",
        "job_id": spec["job_id"],
        "service_key": service.key,
        "created_at": spec["created_at"],
        "record_outcome_template": {
            "job_id": spec["job_id"],
            "service": service.key,
            "source": spec["job"]["source"],
            "outcome": "won|lost|delivered|paid|accepted|declined|disputed|refunded",
            "revenue": spec["pricing"]["selected_price_usd"],
            "estimated_cost_usd": spec["pricing"]["cost_estimate"]["estimated_direct_cost_usd"],
            "actual_cost_usd": None,
            "learning_tags": spec["learning"]["tags"],
            "lesson": "What changed the win/loss, scope, cost, or delivery quality?",
        },
        "pricing_warning_triggers": [
            "estimated margin below 50%",
            "actual cost exceeds estimate",
            "service average margin below 50%",
            "refund/dispute outcome",
            "three losses for the same tag/source",
        ],
        "self_learning_loop": [
            "Log recommendation before run.",
            "Log outcome after bid/delivery.",
            "Update win/loss and margin counters by service, source, and tags.",
            "Use counters to adjust future fit scores and pricing warnings.",
            "Recommend, but do not autonomously publish, price changes.",
        ],
    }


def render_proposal_draft(job: dict[str, Any], service: Service, spec: dict[str, Any]) -> str:
    missing = spec["scope"]["missing_inputs"]
    lines = [
        f"# Proposal Draft: {job_title(job, service)}",
        "",
        "I can take this on and deliver it as a structured, reviewable package with clear acceptance criteria and a final QA pass.",
        "",
        "## Scope",
        "",
        *[f"- {item}" for item in spec["scope"]["in_scope"]],
        "",
        "## Process",
        "",
        "1. Confirm source materials, constraints, and success criteria.",
        "2. Produce the structured working artifacts.",
        "3. Check the work against the acceptance criteria.",
        "4. Deliver the final package with assumptions, risks, and unresolved questions clearly marked.",
        "",
        "## Acceptance Criteria",
        "",
        *[f"- {item}" for item in spec["acceptance_criteria"]],
        "",
    ]
    if missing:
        lines.extend(
            [
                "## Clarifying Questions",
                "",
                *[f"- Please confirm: {item}." for item in missing],
                "",
            ]
        )
    lines.extend(
        [
            "## Delivery Note",
            "",
            "I will avoid inventing facts, will mark assumptions explicitly, and will ask for approval before any external submission.",
            "",
        ]
    )
    return "\n".join(lines)


def render_client_reply(job: dict[str, Any], service: Service, spec: dict[str, Any]) -> str:
    missing = spec["scope"]["missing_inputs"]
    bid = spec["bid_recommendation"]
    if bid["decision"] == "decline_or_request_scope_change":
        opening = "Thanks for the context. I can help if we narrow the scope and resolve a few risks first."
    elif bid["decision"] == "clarify_then_bid":
        opening = f"I can help with this {service.title.lower()} job. I want to clarify a couple of details before I commit to the final scope."
    else:
        opening = f"I can help with this {service.title.lower()} job and can deliver a structured, reviewable package."

    lines = [
        f"# Client Reply Draft: {job_title(job, service)}",
        "",
        opening,
        "",
    ]
    if missing:
        lines.extend(
            [
                "Before I start, please confirm:",
                "",
                *[f"- {item}" for item in missing],
                "",
            ]
        )
    lines.extend(
        [
            "Proposed deliverables:",
            "",
            *[f"- {item}" for item in spec["scope"]["in_scope"][:6]],
            "",
            "I will keep the work in a separate draft, document assumptions, and ask for approval before anything is submitted externally.",
            "",
        ]
    )
    return "\n".join(lines)


def write_json(path: pathlib.Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def package_hash(file_hashes: dict[str, str]) -> str:
    material = json.dumps(file_hashes, sort_keys=True).encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def build_integration_handoff(job: dict[str, Any], service: Service, spec: dict[str, Any], package_dir: pathlib.Path) -> dict[str, Any]:
    return {
        "schema_version": "integration-handoff/1.0",
        "created_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "job_id": spec["job_id"],
        "package_dir": str(package_dir),
        "santaclawz": {
            "role": "private_agent_invocation_and_verified_output_portal",
            "status": "ready_for_adapter",
            "source": spec["job"]["source"],
            "requires_human_approval_before_submit": True,
            "next_local_command": f"python3 integrations/santaclawz_adapter.py prepare-proposal {package_dir / 'deliverable_spec.json'} {package_dir}",
        },
        "zeko": {
            "role": "verification_and_attestation_adapter",
            "status": "ready_for_local_attestation",
            "raw_client_data_policy": "keep_local",
            "requires_signature_before_submission": True,
            "next_local_command": f"python3 integrations/zeko_adapter.py attest {package_dir}",
        },
        "business_brain": {
            "pricing_recommendation": str(package_dir / "pricing_recommendation.md"),
            "machine_readable_decision": str(package_dir / "agent_business_brain.json"),
            "operator_rule": "Only run paid jobs when selected price clears the 50% minimum margin target, unless the operator approves an exception.",
        },
        "learning": {
            "recommendation_logged": True,
            "record_outcome_command": "python3 agent/local_agent.py --mode record-outcome path/to/outcome.json",
            "tags": spec["learning"]["tags"],
        },
    }


def write_agent_package(
    job_path: pathlib.Path,
    job: dict[str, Any],
    service: Service,
    package_dir: Optional[pathlib.Path] = None,
) -> pathlib.Path:
    OUTPUT_DIR.mkdir(exist_ok=True)
    if package_dir is None:
        stem = slugify(job_path.stem)
        timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        package_dir = OUTPUT_DIR / f"{timestamp}-{stem}-agent-pack"
    package_dir.mkdir(parents=True, exist_ok=False)

    spec = build_deliverable_spec(job, service)
    state = load_learning_state()
    business_brain = build_business_brain(job, service, spec, state)
    queue = build_task_queue(job, service)
    (package_dir / "agent_brief.md").write_text(render_agent_brief(job, service, spec), encoding="utf-8")
    write_json(package_dir / "agent_business_brain.json", business_brain)
    (package_dir / "bid_analysis.md").write_text(render_bid_analysis(job, service, spec), encoding="utf-8")
    write_json(package_dir / "deliverable_spec.json", spec)
    write_json(package_dir / "integration_handoff.json", build_integration_handoff(job, service, spec, package_dir))
    write_json(package_dir / "learning_feedback.json", build_learning_feedback(job, service, spec))
    (package_dir / "pricing_recommendation.md").write_text(render_pricing_recommendation(job, service, spec), encoding="utf-8")
    write_json(package_dir / "risk_register.json", {"schema_version": "risk-register/1.0", "risks": spec["risks"]})
    write_json(package_dir / "task_queue.json", queue)
    (package_dir / "qa_checklist.md").write_text(render_qa_checklist(job, service, spec), encoding="utf-8")
    (package_dir / "proposal_draft.md").write_text(render_proposal_draft(job, service, spec), encoding="utf-8")
    (package_dir / "client_reply.md").write_text(render_client_reply(job, service, spec), encoding="utf-8")
    log_recommendation(job, service, spec, package_dir)
    return package_dir


def normalize_santaclawz_request(request: dict[str, Any]) -> dict[str, Any]:
    payload = request.get("input", {})
    if not isinstance(payload, dict):
        raise ValueError("SantaClawz request input must be a JSON object.")
    caller = request.get("caller", {})
    caller_id = caller.get("id") if isinstance(caller, dict) else None
    requested_deliverables = payload.get("requested_deliverables") or request.get("requested_deliverables") or []
    return {
        "title": payload.get("title") or request.get("title") or f"SantaClawz run {request.get('request_id', 'request')}",
        "client": caller_id or request.get("client") or "santaclawz-caller",
        "source": "santaclawz",
        "buyer_type": request.get("caller_type") or payload.get("buyer_type") or "agent",
        "service": request.get("service") or payload.get("service") or "agent_job_pack",
        "client_request": payload.get("client_request") or payload.get("description") or request.get("description") or "",
        "provided_inputs": payload.get("provided_inputs", []),
        "requested_deliverables": requested_deliverables,
        "deadline": payload.get("deadline") or request.get("deadline"),
        "budget": payload.get("budget") or request.get("budget"),
        "santaclawz": {
            "request_id": request.get("request_id"),
            "portal_run_id": request.get("portal_run_id"),
            "return_channel": request.get("return_channel") or "santaclawz",
            "verification_required": bool(request.get("verification_required", True)),
        },
    }


def create_verification_manifest(run_request: dict[str, Any], package_dir: pathlib.Path) -> dict[str, Any]:
    file_hashes = {}
    for path in sorted(package_dir.iterdir()):
        if path.is_file():
            file_hashes[path.name] = sha256_file(path)
    return {
        "schema_version": "verification-manifest/1.0",
        "created_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "request_id": run_request.get("request_id"),
        "verification_required": bool(run_request.get("verification_required", True)),
        "package_dir": str(package_dir),
        "package_hash": package_hash(file_hashes),
        "file_hashes": file_hashes,
        "privacy_policy": "Raw private inputs stay local unless explicitly approved for portal return.",
        "verified_output_policy": "SantaClawz can verify package_hash and file_hashes; Zeko can attest the same hash set.",
    }


def create_zeko_attestation_payload(manifest: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": "zeko-attestation/1.0",
        "created_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "network": "zeko",
        "request_id": manifest.get("request_id"),
        "package_hash": manifest["package_hash"],
        "file_hashes": manifest["file_hashes"],
        "requires_signature": True,
        "requires_submission_approval": True,
        "privacy_note": "Submit hashes and structured metadata only; keep raw caller data local.",
    }


def create_run_receipt(
    run_request: dict[str, Any],
    job: dict[str, Any],
    service: Service,
    run_dir: pathlib.Path,
    package_dir: pathlib.Path,
    manifest: dict[str, Any],
    zeko_payload_path: pathlib.Path,
) -> dict[str, Any]:
    spec_path = package_dir / "deliverable_spec.json"
    spec = json.loads(spec_path.read_text(encoding="utf-8")) if spec_path.exists() else {}
    return {
        "schema_version": "santaclawz-run-receipt/1.0",
        "request_id": run_request.get("request_id"),
        "status": "completed",
        "created_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "agent": {
            "name": "Local Services Agent",
            "private": True,
            "service": service.key,
            "service_title": service.title,
        },
        "caller": {
            "type": run_request.get("caller_type"),
            "return_channel": run_request.get("return_channel") or "santaclawz",
        },
        "run_dir": str(run_dir),
        "output_package": str(package_dir),
        "verification": {
            "verification_manifest": str(run_dir / "verification_manifest.json"),
            "package_hash": manifest["package_hash"],
            "zeko_attestation_payload": str(zeko_payload_path),
            "verified_output_ready": True,
        },
        "recommendation": spec.get("bid_recommendation", {}),
        "approval_gates": spec.get("approval_gates", []),
    }


def create_santaclawz_return_payload(
    run_request: dict[str, Any],
    receipt: dict[str, Any],
    manifest: dict[str, Any],
    package_dir: pathlib.Path,
) -> dict[str, Any]:
    deliverables = {}
    for name in PACKAGE_FILES:
        path = package_dir / name
        if path.exists():
            deliverables[name] = {
                "path": str(path),
                "sha256": manifest["file_hashes"].get(name),
            }
    return {
        "schema_version": "santaclawz-return/1.0",
        "request_id": run_request.get("request_id"),
        "status": receipt["status"],
        "return_channel": run_request.get("return_channel") or "santaclawz",
        "agent_private": True,
        "verified_output": {
            "package_hash": manifest["package_hash"],
            "verification_manifest": receipt["verification"]["verification_manifest"],
            "zeko_attestation_payload": receipt["verification"]["zeko_attestation_payload"],
            "deliverables": deliverables,
        },
        "human_approval_required_for_external_actions": True,
        "receipt_path": str(pathlib.Path(receipt["run_dir"]) / "run_receipt.json"),
    }


def write_santaclawz_run(request_path: pathlib.Path, run_request: dict[str, Any]) -> pathlib.Path:
    OUTPUT_DIR.mkdir(exist_ok=True)
    request_id = str(run_request.get("request_id") or request_path.stem)
    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = OUTPUT_DIR / f"{timestamp}-{slugify(request_id)}-santaclawz-run"
    package_dir = run_dir / "output_package"
    run_dir.mkdir(parents=True, exist_ok=False)

    job = normalize_santaclawz_request(run_request)
    service = infer_service(job)
    write_json(run_dir / "normalized_job.json", job)
    write_agent_package(request_path, job, service, package_dir=package_dir)

    manifest = create_verification_manifest(run_request, package_dir)
    write_json(run_dir / "verification_manifest.json", manifest)

    zeko_payload_path = run_dir / "zeko_attestation_payload.json"
    write_json(zeko_payload_path, create_zeko_attestation_payload(manifest))

    receipt = create_run_receipt(run_request, job, service, run_dir, package_dir, manifest, zeko_payload_path)
    write_json(run_dir / "run_receipt.json", receipt)
    write_json(run_dir / "santaclawz_return_payload.json", create_santaclawz_return_payload(run_request, receipt, manifest, package_dir))
    return run_dir


def log_recommendation(job: dict[str, Any], service: Service, spec: dict[str, Any], package_dir: pathlib.Path) -> None:
    state = load_learning_state()
    global_stats = state.setdefault("global", {})
    global_stats["recommendations"] = int(global_stats.get("recommendations", 0)) + 1
    save_learning_state(state)
    append_jsonl(
        RECOMMENDATION_LOG_PATH,
        {
            "created_at": spec["created_at"],
            "job_id": spec["job_id"],
            "service_key": service.key,
            "source": spec["job"]["source"],
            "title": spec["job"]["title"],
            "decision": spec["bid_recommendation"]["decision"],
            "fit_score": spec["bid_recommendation"]["fit_score"],
            "pricing_decision": spec["pricing"]["pricing_decision"],
            "selected_price_usd": spec["pricing"]["selected_price_usd"],
            "estimated_direct_cost_usd": spec["pricing"]["cost_estimate"]["estimated_direct_cost_usd"],
            "estimated_margin_percent": spec["pricing"]["estimated_margin_percent"],
            "pricing_warnings": spec["pricing"]["warnings"],
            "learning_tags": spec["learning"]["tags"],
            "package_dir": str(package_dir),
        },
    )


def parse_credit_value(value: Any) -> float:
    if value is None:
        return 0.0
    match = re.search(r"[-+]?\d+(?:\.\d+)?", str(value).replace(",", ""))
    return float(match.group(0)) if match else 0.0


def record_outcome(outcome: dict[str, Any]) -> pathlib.Path:
    service_key = str(outcome.get("service") or "agent_job_pack")
    service = SERVICES.get(service_key, SERVICES["agent_job_pack"])
    source = slugify(str(outcome.get("source") or "local"))
    result = str(outcome.get("outcome") or outcome.get("result") or "").lower().strip()
    if result not in {"won", "lost", "delivered", "paid", "accepted", "declined", "disputed", "refunded"}:
        raise ValueError("Outcome must be one of: won, lost, delivered, paid, accepted, declined, disputed, refunded.")

    value = parse_credit_value(outcome.get("value_credits") or outcome.get("budget") or outcome.get("revenue"))
    revenue_usd = parse_price_usd(outcome.get("revenue_usd") or outcome.get("revenue") or outcome.get("paid_amount_usd")) or value
    cost_usd = parse_price_usd(outcome.get("actual_cost_usd") or outcome.get("estimated_cost_usd") or outcome.get("cost_usd")) or 0.0
    tags = list_value(outcome, "learning_tags")
    if not tags:
        tags = extract_learning_tags(outcome, service)

    state = load_learning_state()
    global_stats = state.setdefault("global", {})
    global_stats["outcomes"] = int(global_stats.get("outcomes", 0)) + 1
    if result in {"won", "delivered", "paid", "accepted"}:
        global_stats["wins"] = int(global_stats.get("wins", 0)) + 1
    if result in {"lost", "declined", "disputed", "refunded"}:
        global_stats["losses"] = int(global_stats.get("losses", 0)) + 1

    service_bucket = state.setdefault("services", {}).setdefault(service.key, {})
    source_bucket = state.setdefault("sources", {}).setdefault(source, {})
    update_counter(service_bucket, result, value)
    update_profit_counter(service_bucket, revenue_usd, cost_usd)
    update_counter(source_bucket, result, value)
    update_profit_counter(source_bucket, revenue_usd, cost_usd)
    for tag in tags:
        tag_bucket = state.setdefault("tags", {}).setdefault(tag, {})
        update_counter(tag_bucket, result, value)
        update_profit_counter(tag_bucket, revenue_usd, cost_usd)

    margin_ratio = (revenue_usd - cost_usd) / max(0.01, cost_usd) if cost_usd else None
    if margin_ratio is not None and margin_ratio < 0.5:
        state.setdefault("notes", []).append(
            {
                "created_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
                "job_id": outcome.get("job_id"),
                "lesson": f"Pricing warning: margin {round(margin_ratio * 100, 1)}% was below the 50% target. Recommend raising price or narrowing scope.",
            }
        )

    if outcome.get("lesson"):
        state.setdefault("notes", []).append(
            {
                "created_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
                "job_id": outcome.get("job_id"),
                "lesson": str(outcome["lesson"]),
            }
        )
        state["notes"] = state["notes"][-50:]

    save_learning_state(state)
    record = {
        "created_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "job_id": outcome.get("job_id"),
        "service_key": service.key,
        "source": source,
        "outcome": result,
        "value_credits": value,
        "revenue_usd": revenue_usd,
        "cost_usd": cost_usd,
        "margin_ratio": round(margin_ratio, 3) if margin_ratio is not None else None,
        "learning_tags": tags,
        "lesson": outcome.get("lesson"),
    }
    append_jsonl(OUTCOME_LOG_PATH, record)
    return OUTCOME_LOG_PATH


def render_learning_insights() -> str:
    state = load_learning_state()
    global_stats = state.get("global", {})
    lines = [
        "# Learning Insights",
        "",
        f"- Recommendations logged: {global_stats.get('recommendations', 0)}",
        f"- Outcomes logged: {global_stats.get('outcomes', 0)}",
        f"- Wins: {global_stats.get('wins', 0)}",
        f"- Losses: {global_stats.get('losses', 0)}",
        "",
        "## Pricing Health",
        "",
    ]
    service_items = sorted(state.get("services", {}).items(), key=lambda item: item[0])
    if service_items:
        for service_key, stats in service_items:
            avg_margin = stats.get("avg_margin")
            if isinstance(avg_margin, (int, float)):
                status = "raise price or narrow scope" if avg_margin < 0.5 else "healthy"
                lines.append(
                    f"- {service_key}: avg_margin={round(avg_margin * 100, 1)}% revenue={stats.get('revenue', 0)} cost={stats.get('cost', 0)} status={status}"
                )
    else:
        lines.append("- No priced outcomes yet.")
    lines.extend(
        [
            "",
            "## Strongest Signals",
            "",
        ]
    )
    tag_items = sorted(
        state.get("tags", {}).items(),
        key=lambda item: (float(item[1].get("win_rate", 0)), int(item[1].get("seen", 0))),
        reverse=True,
    )
    if tag_items:
        for tag, stats in tag_items[:10]:
            lines.append(f"- {tag}: win_rate={stats.get('win_rate', 0)} seen={stats.get('seen', 0)} value={stats.get('value', 0)}")
    else:
        lines.append("- No outcome-backed signals yet.")
    lines.extend(["", "## Notes", ""])
    notes = state.get("notes", [])
    if notes:
        lines.extend(f"- {note.get('lesson')}" for note in notes[-10:])
    else:
        lines.append("- Record outcomes to teach the agent what actually wins.")
    return "\n".join(lines) + "\n"


def suggested_reply(service: Service, missing: list[str]) -> str:
    if missing:
        missing_text = ", ".join(missing)
        return (
            f"I can help with {service.title.lower()}. Before I start, please send: "
            f"{missing_text}. Once I have that, I will return a scoped plan and the first reviewable deliverable."
        )
    return (
        f"I can help with {service.title.lower()}. I will first produce a scoped work plan, "
        "then a reviewable draft, and I will ask for approval before anything is submitted externally."
    )


def write_output(job_path: pathlib.Path, content: str) -> pathlib.Path:
    OUTPUT_DIR.mkdir(exist_ok=True)
    stem = slugify(job_path.stem)
    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    output_path = OUTPUT_DIR / f"{timestamp}-{stem}.md"
    output_path.write_text(content, encoding="utf-8")
    return output_path


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Route and plan a local services-agent job.")
    parser.add_argument("job", type=pathlib.Path, nargs="?", help="Path to a JSON job request or outcome record.")
    parser.add_argument(
        "--mode",
        choices=["plan", "agent-pack", "santaclawz-run", "record-outcome", "insights"],
        default="plan",
        help="Output a plan, create an agent pack, run a SantaClawz portal request, record an outcome, or summarize learning.",
    )
    args = parser.parse_args(argv)

    try:
        if args.mode == "insights":
            OUTPUT_DIR.mkdir(exist_ok=True)
            output_path = OUTPUT_DIR / f"{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}-learning-insights.md"
            output_path.write_text(render_learning_insights(), encoding="utf-8")
        elif args.mode == "record-outcome":
            if not args.job:
                raise ValueError("record-outcome mode requires an outcome JSON file.")
            outcome = load_job(args.job)
            output_path = record_outcome(outcome)
        elif args.mode == "santaclawz-run":
            if not args.job:
                raise ValueError("santaclawz-run mode requires a SantaClawz request JSON file.")
            run_request = load_job(args.job)
            output_path = write_santaclawz_run(args.job, run_request)
        else:
            if not args.job:
                raise ValueError(f"{args.mode} mode requires a job JSON file.")
            job = load_job(args.job)
            service = infer_service(job)
            if args.mode == "agent-pack":
                output_path = write_agent_package(args.job, job, service)
            else:
                content = render_plan(job, service)
                output_path = write_output(args.job, content)
    except Exception as exc:
        print(f"local-agent error: {exc}", file=sys.stderr)
        return 1

    print(output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
