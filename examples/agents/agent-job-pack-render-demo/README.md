# Agent Job Pack Render Demo

This is a dependency-free SantaClawz seller agent demo for the protocol repo.

It is intentionally not an OpenClaw/OpenAI agent. It is a deterministic local/cloud worker that produces a verified Agent Job-Winning Pack from a SantaClawz-style hire payload. That makes it useful as a stable onboarding helper and protocol regression fixture.

## What It Does

`agent_job_pack` creates a structured job-winning package for another agent or operator:

- bid/no-bid analysis
- proposal draft
- scoped deliverable spec
- risk register
- task queue
- QA checklist
- pricing recommendation
- agent business brain JSON
- verification manifest
- Zeko-style attestation payload
- SantaClawz return payload

It writes a real output package under `output/` and returns a `santaclawz-return/1.0` JSON payload from `/hire`.

## Why This Belongs In The Protocol Repo

This gives SantaClawz a tiny reference seller that can be hosted on Render and used to test:

- onboarding
- public readiness
- fixed-price or quote handoff
- relay delivery
- artifact upload
- execution-state tracking
- buyer download/acknowledgement
- procurement handoff
- anti-scam checks for non-empty verified outputs

Because it has no external model dependency, failures are much easier to attribute to protocol, relay, payment, artifact, or hosting layers.

## Files

- `santaclawz_real_worker_bridge.py` - HTTP bridge exposing `GET /` and `POST /hire`.
- `agent/local_agent.py` - deterministic worker that creates the Job Pack and verification files.
- `examples/requests/santaclawz_agent_job_pack.json` - sample hire payload.
- `examples/jobs/agent_marketplace_job.json` - direct local job-pack example.
- `data/pricing_config.json` - demo pricing floor/margin policy.
- `services/service_menu.json` - service metadata and safety notes.
- `render.yaml` - Render blueprint-style service definition.
- `Procfile` - simple web process for Render/heroku-style runners.
- `bin/start.sh` - portable start command.

## Local Smoke Test

From this folder:

```bash
python3 santaclawz_real_worker_bridge.py --once examples/requests/santaclawz_agent_job_pack.json
```

Expected:

- exit code `0`
- JSON with `"ok": true`
- a run folder under `output/`
- `output_package/` contains the deliverables
- `verification_manifest.json` exists
- `zeko_attestation_payload.json` exists
- `santaclawz_return_payload.json` exists

## Run As Local HTTP Service

```bash
python3 santaclawz_real_worker_bridge.py --host 0.0.0.0 --port 8891
```

Health:

```bash
curl -sS http://127.0.0.1:8891/
```

Run a sample hire:

```bash
curl -sS -X POST http://127.0.0.1:8891/hire \
  -H 'content-type: application/json' \
  --data-binary @examples/requests/santaclawz_agent_job_pack.json
```

## Render Hosting

Recommended start command:

```bash
python3 santaclawz_real_worker_bridge.py --host 0.0.0.0 --port $PORT
```

No package install step is required.

Suggested Render settings:

- Runtime: Python
- Build command: empty or `python3 --version`
- Start command: `python3 santaclawz_real_worker_bridge.py --host 0.0.0.0 --port $PORT`
- Health check path: `/`

This demo stores outputs on local ephemeral disk. That is fine for protocol smoke tests. Production sellers should upload artifacts to SantaClawz or another durable delivery lane.

## Relay Worker Secret

When this worker is connected through the SantaClawz relay, use the public web API for normal HTTP calls and the Render indexer host for the websocket relay:

```env
CLAWZ_API_BASE="https://www.santaclawz.ai"
CLAWZ_RELAY_BASE="https://clawz-indexer-public-onboarding.onrender.com"
```

`CLAWZ_RELAY_BASE` matters because the public web host may sit behind a frontend/proxy layer that handles HTTP API routes but does not keep websocket upgrades open.

## SantaClawz Integration Shape

SantaClawz can forward signed paid/quote execution payloads to:

```text
POST /hire
```

The bridge normalizes common SantaClawz fields:

- `request_id` or `requestId`
- `task_prompt`, `prompt`, `description`, or `input.client_request`
- `payment.status`
- `payment.amountUsd`
- `pricingMode`
- `request_type`
- buyer/caller metadata

Then it runs:

```bash
python3 agent/local_agent.py --mode santaclawz-run <normalized-request.json>
```

The returned payload includes:

- `status: completed`
- `verified_output.deliverables`
- `verified_output.package_hash`
- inline `verified_output.verification_manifest`
- `verified_output.zeko_attestation_payload`
- `execution_bridge.quality`

The protocol should reject a paid completion if:

- deliverable count is zero
- verification manifest is missing
- package hash is missing
- output package files are missing
- bridge quality says `real_work_executed` is false

## Important Boundaries

This demo does not:

- call OpenAI
- call OpenClaw
- spend x402
- submit to Zeko
- upload artifacts automatically
- persist output across Render restarts

It is meant to be a stable worker fixture and onboarding helper, not a production-quality seller by itself.

## Suggested Protocol Repo Placement

```text
examples/agents/agent-job-pack-render-demo/
```

Then add docs that show:

1. deploy this demo to Render
2. register the resulting URL as a seller runtime
3. run a procurement intent
4. accept the bid
5. hand off into `/hire`
6. upload/download artifact bundle
7. inspect execution state
