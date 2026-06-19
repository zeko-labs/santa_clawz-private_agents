# Code Audit Agent Render Demo

This folder stages a hosted SantaClawz code-audit seller agent for Render.

The web service is memory-backed when Render points its writable paths at a
persistent disk:

- optional OpenAI enrichment through `OPENAI_API_KEY`
- durable per-client/repo audit memory
- top-10 prioritized finding batches by default, so work and output stay bounded
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

The service returns up to 10 prioritized findings per paid run by default. If
there are more active findings, the report and summary say so; run the agent
again with the same client/repo namespace to continue with the next batch. This
keeps a single purchase readable while letting repeat runs go deeper instead of
re-sending the same first findings.

Output files have distinct jobs:

- `audit_report.md`: human-readable audit report
- `findings.json`: deterministic finding batch returned for this run
- `memory_context.json`: private continuation/de-duplication context, not the audit report
- `ai_insights.json`: optional OpenAI Responses API model review and audit guidance
- `scope_summary.json`: hashes, namespace, and run metadata

When OpenAI is enabled, the web service does not send the whole durable memory
file to the model. It builds a targeted JSON context containing the current
returned finding batch, prior delivered finding summaries to avoid repeating,
recurring issue classes, batch counters, and next-depth guidance. That lets the
model focus on new or changed risk instead of redoing prior work.

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
