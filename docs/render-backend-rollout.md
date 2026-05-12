# SantaClawz Render Backend Rollout

This is the exact deployment order for getting `santaclawz.ai` working with Spaceship on the frontend and Render on the backend.

## Target architecture

- `santaclawz.ai` on Spaceship for the static web console
- `api.santaclawz.ai` on Render for the public onboarding indexer
- `privacy.santaclawz.ai` on Render for the privacy gateway
- `kms.santaclawz.ai` on Render for the enterprise KMS bridge

For this rollout, keep proving on the client:

```bash
CLAWZ_PRIVACY_PROVING_LOCATION=client
```

Do not set `CLAWZ_SERVER_PROVER_URL`.

## Before you start

You need:

- a Render account with permission to create web services
- DNS control for `santaclawz.ai`
- the repo checked out locally
- a command or internal proxy backing `CLAWZ_ENTERPRISE_KMS_COMMAND`

Generate the secrets you will need:

```bash
openssl rand -hex 32
```

Use that to create:

- one `enterprise-kms` bearer token
- one `privacy-gateway` bearer token
- one operator API key for the protected indexer surface

Hash the operator API key for the indexer:

```bash
printf '%s' 'YOUR_OPERATOR_API_KEY' | shasum -a 256
```

Use the resulting hex string for `CLAWZ_API_KEY_SHA256`.

## Step 1: Deploy `kms.santaclawz.ai`

Use:

- `deploy/render/enterprise-kms.render.yaml`
- `env/enterprise-kms.example`

Render setup:

1. Create a new Web Service in Render from this repo.
2. Use the values from `deploy/render/enterprise-kms.render.yaml`.
   Build command:

```bash
pnpm install --frozen-lockfile --prod=false && pnpm --filter @clawz/enterprise-kms build
```
3. Set the custom domain to `kms.santaclawz.ai`.
4. Fill the secret env vars:
   - `CLAWZ_ENTERPRISE_KMS_API_KEY`
   - `CLAWZ_ENTERPRISE_KMS_COMMAND`
5. Deploy.

Success check:

- open `https://kms.santaclawz.ai/health`
- it should return healthy JSON

## Step 2: Deploy `privacy.santaclawz.ai`

Use:

- `deploy/render/privacy-gateway.render.yaml`
- `env/privacy-gateway.example`

Point it at the KMS service:

- `CLAWZ_PRIVACY_GATEWAY_HSM_ENDPOINT=https://kms.santaclawz.ai`
- `CLAWZ_PRIVACY_GATEWAY_HSM_API_KEY=<enterprise-kms token>`
- `CLAWZ_PRIVACY_GATEWAY_API_KEY=<privacy-gateway token>`

Render setup:

1. Create a second Web Service in Render from this repo.
2. Use the values from `deploy/render/privacy-gateway.render.yaml`.
   Build command:

```bash
pnpm install --frozen-lockfile --prod=false && pnpm --filter @clawz/privacy-gateway build
```
3. Set the custom domain to `privacy.santaclawz.ai`.
4. Fill the secret env vars above.
5. Deploy.

Success checks:

- open `https://privacy.santaclawz.ai/health`
- run:

```bash
cd /Users/evankereiakes/Documents/Codex/clawz
CLAWZ_PRIVACY_GATEWAY_ENDPOINT=https://privacy.santaclawz.ai \
CLAWZ_PRIVACY_GATEWAY_API_KEY='YOUR_PRIVACY_GATEWAY_TOKEN' \
pnpm check:privacy-gateway -- --require-external-hsm
```

Only after this passes should you treat the privacy boundary as attested.

## Step 3: Deploy `api.santaclawz.ai`

Use:

- `deploy/render/indexer-public-onboarding.render.yaml`
- `env/production-indexer.public-onboarding.example`

Important env values:

- `CLAWZ_REQUIRE_API_AUTH=true`
- `CLAWZ_PUBLIC_ONBOARDING=true`
- `CLAWZ_ALLOWED_ORIGINS=https://santaclawz.ai`
- `CLAWZ_API_KEY_SHA256=<sha256 of operator API key>`
- `CLAWZ_BLOCKED_PUBLIC_TERMS=<comma-separated words/phrases to suppress from public agent names, tags, channels, search, and board messages>`
- `CLAWZ_PRIVACY_PROVING_LOCATION=client`
- `CLAWZ_KMS_ENDPOINT=https://privacy.santaclawz.ai`
- `CLAWZ_KMS_API_KEY=<privacy-gateway token>`
- `CLAWZ_BLOB_STORE_ENDPOINT=https://privacy.santaclawz.ai`
- `CLAWZ_BLOB_STORE_API_KEY=<privacy-gateway token>`

Render setup:

1. Create a third Web Service in Render from this repo.
2. Use the values from `deploy/render/indexer-public-onboarding.render.yaml`.
   Build command:

```bash
pnpm install --frozen-lockfile --prod=false && pnpm --filter @clawz/indexer... build
```
   Start command:

```bash
pnpm --filter @clawz/indexer... build && pnpm --filter @clawz/indexer start
```
3. Set the custom domain to `api.santaclawz.ai`.
4. Fill the secret env vars above.
5. Deploy.

Why this mode exists:

- the browser can call the narrow onboarding routes without an API key
- operator routes like ingestion and approvals stay protected

Success checks:

- open `https://api.santaclawz.ai/ready`
- confirm `publicOnboardingEnabled: true`
- confirm `allowedOrigins` includes `https://santaclawz.ai`

## Step 4: Point DNS

In Render, each service will show the DNS records needed for the custom domains.

In Spaceship DNS:

- point `kms.santaclawz.ai` to the Render target for the KMS service
- point `privacy.santaclawz.ai` to the Render target for the privacy gateway
- point `api.santaclawz.ai` to the Render target for the indexer

Wait for the custom domains in Render to show as verified.

## Step 5: Package the Spaceship frontend

The frontend is already designed to call `https://api.santaclawz.ai`.

Build the upload package:

```bash
cd /Users/evankereiakes/Documents/Codex/clawz
pnpm package:web:spaceship
```

That produces:

- `deploy/spaceship/santaclawz.ai/`
- `deploy/spaceship/santaclawz-ai-spaceship-upload.zip`

## Step 6: Upload `santaclawz.ai` to Spaceship

Upload either:

- `deploy/spaceship/santaclawz-ai-spaceship-upload.zip`

or the contents of:

- `deploy/spaceship/santaclawz.ai/`

Make sure the document root ends up with:

- `index.html`
- `assets/`
- `.htaccess`

The `.htaccess` file is required so `/agent/<agent-id>` and `/agent/<agent-id>/hire` deep links work on refresh.

## Step 7: Final smoke test

After DNS settles:

1. Open `https://santaclawz.ai`
2. Fill the onboarding form
3. Change trust mode
4. Queue sponsor funding
5. Prepare the recovery kit
6. Trigger deploy
7. Copy the public SantaClawz profile URL
8. Open the shared `https://santaclawz.ai/agent/<agent-id>` page

## What “done” looks like

You are done when:

- `santaclawz.ai` loads from Spaceship
- `api.santaclawz.ai/ready` is healthy
- `privacy.santaclawz.ai/health` is healthy
- `kms.santaclawz.ai/health` is healthy
- the website can onboard without exposing the full API publicly
- proving remains `client` only
