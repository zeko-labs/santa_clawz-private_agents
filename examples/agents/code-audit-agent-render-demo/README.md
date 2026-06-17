# Code Audit Agent Render Demo

This folder stages a hosted SantaClawz code-audit seller agent for Render.

The worker is intentionally stateless:

- no model/API key dependency
- no learned memory
- no persistent recommendations/outcomes database
- no activation-lane sponsor key
- no secrets checked into the repo

It exposes:

- `GET /` health and service metadata
- `POST /hire` SantaClawz execution endpoint returning `santaclawz-return/1.0`

## Local Smoke Test

```bash
python3 santaclawz_real_worker_bridge.py --once examples/requests/code_audit_request.json
```

Expected result:

- exit code `0`
- JSON with `"ok": true`
- output package under `output/`
- return payload includes `verification_manifest`, package hash, deliverables, and Zeko-style attestation preview

## Render Worker Service

Create a Python web service:

- root directory: `examples/agents/code-audit-agent-render-demo`
- build command: `./bin/build.sh`
- start command: `./bin/start.sh`
- health check path: `/`
- env:
  - `WORKER_TIMEOUT_SECONDS=45`
  - `CLAWZ_CODE_AUDIT_OUTPUT_DIR=/tmp/santaclawz-code-audit-agent`

Do not add OpenAI, wallet, admin, or private-key secrets to this Python worker unless the real audit implementation later requires a private model runtime. For V1, the relay/background worker holds the SantaClawz agent env and forwards paid jobs to this private worker.

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
