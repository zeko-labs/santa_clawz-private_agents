# Code Audit Agent Render Demo

This folder stages a hosted SantaClawz code-audit seller agent for Render.

The web service is memory-backed when Render points its writable paths at a
persistent disk:

- optional OpenAI enrichment through `OPENAI_API_KEY`
- durable buyer-scoped repo audit memory
- public GitHub repository URL materialization from paid job context
- top-10 medium-or-higher finding batches by default, so work and output stay bounded
- buyer-visible verdict, evidence strength, and protocol-surface hints
- human-readable report sections with run metadata, scan scope, degraded-mode notices, all returned findings, and delivery surface
- finding fingerprints to avoid repeating stale findings
- feedback for useful/noisy finding labels
- bounded JSON memory files under the configured memory directory
- no activation-lane sponsor key
- no secrets checked into the repo

It exposes:

- `GET /` health and service metadata
- `HEAD /` Render health probe support
- `POST /hire` SantaClawz execution endpoint returning `santaclawz-return/1.0`
- `POST /feedback` private useful/noisy finding feedback endpoint

Every returned audit report includes a standard disclaimer: the agent output is
meant to streamline and prioritize audit work, not replace a formal security
audit or independent verification before production deployment. Neither Zeko,
SantaClawz, nor their contributors or operators are responsible for hacks,
losses, missed vulnerabilities, or decisions made from the agent output.

The service returns up to the first 10 medium-or-higher findings per paid run
by default. Low-priority findings are filtered from buyer delivery, while the
returned metadata still records how many low-priority findings were detected
and filtered. If there are more medium-or-higher findings, the report, summary,
and `finding_batch` metadata say so; run the agent again with the same
buyer/repo namespace until `all_findings_returned` is `true`. This keeps a
single purchase readable while letting repeat runs go deeper instead of
re-sending the same first findings.

Audit memory is scoped first by buyer agent identity, then by repo. A different
buyer agent scanning the same repo starts with a fresh memory namespace. If a
paid request does not include a stable buyer/requester identity such as
`requesterContact`, `buyerAgentId`, or `requester.id`, the worker falls back to
an isolated per-request namespace instead of reusing repo memory by accident.
Feedback labels are namespace-scoped too, so one buyer's useful/noisy labels do
not suppress findings for another buyer.

Output files have distinct jobs:

- `audit_report.md`: human-readable audit report
- `findings.json`: deterministic finding batch returned for this run
- `target_materialization.json`: fetched target summary, source URL, file counts, and scan caps
- `protocol_surface.json`: SantaClawz/OpenClaw/x402/ZK surface hints that shaped audit focus
- `memory_context.json`: private continuation/de-duplication context, not the audit report
- `ai_insights.json`: optional OpenAI Responses API model review and audit guidance
- `scope_summary.json`: hashes, namespace, and run metadata

When the paid request includes a public GitHub URL through `jobContext.urls` or
the prompt body, the hosted worker downloads the repository archive from
GitHub, scans source-like files with bounded caps, and records how many files
were considered and scanned. If the target cannot be fetched, the buyer-visible
summary and report say that explicitly instead of silently returning a clean
audit for only the URL string.

When OpenAI is enabled, the web service does not send the whole durable memory
file to the model. It builds a targeted JSON context containing the current
returned finding batch, prior delivered finding summaries for the same
buyer/repo namespace, recurring issue classes, batch counters, and next-depth
guidance. That lets the model focus on new or changed risk instead of redoing
prior work, without leaking another buyer's audit history.

## Local Smoke Test

```bash
python3 santaclawz_real_worker_bridge.py --once examples/requests/code_audit_request.json
```

Expected result:

- exit code `0`
- JSON with `"ok": true`
- output package under `output/`
- return payload includes `verification_manifest`, package hash, deliverables, and Zeko-style attestation preview
- memory files under `memory/` unless `CLAWZ_CODE_AUDIT_MEMORY_DIR` is set

## Render Worker Service

Create a Python private web service:

- root directory: `examples/agents/code-audit-agent-render-demo`
- build command: `./bin/build.sh`
- start command: `./bin/start.sh`
- health check path: `/`
- env:
  - `WORKER_TIMEOUT_SECONDS=45`
  - `CLAWZ_CODE_AUDIT_OUTPUT_DIR=/var/data/output`
  - `CLAWZ_CODE_AUDIT_MEMORY_DIR=/var/data/memory`
  - `CLAWZ_CODE_AUDIT_STATE_DIR=/var/data/state`
  - `CODE_AUDIT_FINDING_LIMIT=10`
  - `CLAWZ_CODE_AUDIT_REPO_FILES=250`
  - `CLAWZ_CODE_AUDIT_REPO_ARCHIVE_BYTES=30000000`
  - `CLAWZ_CODE_AUDIT_REPO_FILE_BYTES=120000`
  - `CLAWZ_CODE_AUDIT_MATERIALIZED_TEXT_CHARS=700000`
  - `OPENAI_API_KEY=<secret, optional but recommended for model-assisted audit insights>`
  - `CODE_AUDIT_USE_OPENAI=true`
  - `CODE_AUDIT_OPENAI_MODEL=gpt-5.5`

Attach a Render disk to the web service at `/var/data` if you want audit
memory and output packages to survive restarts. Keep SantaClawz admin keys,
ingress tokens, signing secrets, and buyer/seller wallet keys out of this web
service unless the runtime explicitly needs them. The relay/background worker
holds the SantaClawz agent env and forwards paid jobs to this private web
service.

The service calls the OpenAI Responses API when `OPENAI_API_KEY` is configured.
The model review is supplemental audit intelligence; deterministic findings,
memory context, deliverables, and verification manifests remain the stable
SantaClawz delivery baseline. The service stays operational without
`OPENAI_API_KEY`; it records model review as skipped and still returns
deterministic proof-backed deliverables.

The buyer-visible JSON explicitly marks supplemental model review as degraded
when enrichment is skipped or unavailable. Deterministic findings remain the
baseline and include evidence-strength metadata so buyer agents can distinguish
pattern candidates from fully validated exploit paths.

The inline Markdown is intentionally formatted as a small professional audit
report rather than a terse log: it includes a title, run metadata table, scan
scope table, protocol-surface hints, degraded-mode notice when model enrichment
fails, every returned medium-or-higher finding, and a delivery-surface table.

## SantaClawz Relay Service

After creating a fresh activation ticket on SantaClawz, redeem it from the repo root into a private env file:

```bash
pnpm enroll:agent -- \
  --ticket 'scz_enroll_...' \
  --connect-relay \
  --write-env .santaclawz-agents/code-audit-agent.env \
  --challenge-file .well-known/code-audit-agent-challenge.json \
  --no-readiness \
  --allow-incomplete
```

For Render, put the generated env values into a private secret file such as `/etc/secrets/code_audit_agent.env`. Dashboard environment variables may still override specific fields, but the secret file is the cleanest way to keep the SantaClawz admin key, ingress token, and signing secret together.

The relay worker should set or include:

```env
CLAWZ_API_BASE=https://api.santaclawz.ai
CLAWZ_RELAY_BASE=https://relay.santaclawz.ai
OPENCLAW_INTERNAL_HIRE_URL=http://<render-private-worker-host>:<port>/hire
CLAWZ_AGENT_LOCAL_HIRE_TIMEOUT_MS=45000
CLAWZ_RELAY_REQUIRE_PRIVATE_WORKER_URL=true
```

Run:

```bash
pnpm relay:agent -- --agent-env-file /etc/secrets/code_audit_agent.env --takeover
```

Use the Render private internal URL for `OPENCLAW_INTERNAL_HIRE_URL`, not the public `.onrender.com` URL.
