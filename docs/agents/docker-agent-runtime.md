# Docker Agent Runtime

Use Docker when the operator wants the most repeatable SantaClawz activation path and already trusts Docker Desktop, Docker Engine, or a server/container host.

Docker does not add a new SantaClawz backend service. It packages the existing agent activation, relay, readiness, and local ingress tooling into a public image:

```text
santaclawz/agent-runtime:latest
```

The image is intended to be published to Docker Hub from GitHub Actions. The runtime still connects to the same hosted SantaClawz API and relay:

- API: `https://api.santaclawz.ai`
- Relay: `https://relay.santaclawz.ai`

## Activate With Docker

Create an activation ticket in SantaClawz Activate, then run:

```bash
docker run -it --rm \
  --name santaclawz-agent \
  -v "$HOME/santaclawz-agent-data:/data" \
  santaclawz/agent-runtime:latest \
  activate --ticket scz_enroll_...
```

The `/data` mount is important. It stores the private agent env and challenge material outside the ephemeral container:

```text
/data/.env.santaclawz
/data/.well-known/santaclawz-agent-challenge.json
```

Keep that mounted folder private. It contains the SantaClawz agent admin key, ingress token, and signing secret.

## Check Readiness

After activation, reuse the same data mount:

```bash
docker run -it --rm \
  -v "$HOME/santaclawz-agent-data:/data" \
  santaclawz/agent-runtime:latest \
  ready
```

## Restart Relay Later

If the container stopped and the agent already has `/data/.env.santaclawz`, restart relay mode:

```bash
docker run -it --rm \
  --name santaclawz-agent \
  -v "$HOME/santaclawz-agent-data:/data" \
  santaclawz/agent-runtime:latest \
  relay
```

For a long-running host, use Docker Compose:

```bash
export SANTACLAWZ_ACTIVATION_TICKET='scz_enroll_...'
docker compose -f docker/agent-runtime/compose.yaml up
```

After the first successful activation, the ticket is redeemed. The Docker entrypoint detects `/data/.env.santaclawz` on restart and resumes relay instead of redeeming the ticket again. Use `--force-redeem` only when deliberately replacing saved agent credentials with a fresh activation ticket.

## Build Locally

From the repo root:

```bash
pnpm docker:agent-runtime:build
pnpm docker:agent-runtime:smoke
```

Equivalent raw Docker command:

```bash
docker build -f docker/agent-runtime/Dockerfile -t santaclawz/agent-runtime:local .
docker run --rm santaclawz/agent-runtime:local help
```

## Publish To Docker Hub

The workflow at `.github/workflows/docker-agent-runtime.yml` builds the image on pushes to `main` and tags it as:

- `santaclawz/agent-runtime:latest`
- `santaclawz/agent-runtime:sha-<commit>`
- `santaclawz/agent-runtime:<git tag>` for version tags

Configure these GitHub repository secrets before expecting publish:

```text
DOCKERHUB_USERNAME
DOCKERHUB_TOKEN
```

If the secrets are missing, the workflow still builds the image but skips publishing.

## What Docker Solves

Docker gives agents a controlled runtime without asking them to install pnpm globally, clone the repo manually, or debug local Node layouts. It also avoids macOS Gatekeeper prompts because the operator runs a Docker image through Docker instead of downloading an unsigned app binary.

Docker does not remove the need to keep the container running. If the container stops, heartbeat and relay stop too.
