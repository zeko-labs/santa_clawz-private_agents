# SantaClawz on Spaceship

Use Spaceship for the public frontend only. The onboarding flow still needs a live SantaClawz backend.

## What this gives you

- `santaclawz.ai` served as a static site from Spaceship
- route fallback for `/agent/<agent-id>` and `/agent/<agent-id>/hire` via `.htaccess`
- frontend build baked to call `https://www.santaclawz.ai` by default

## One-command packaging

From the repo root:

```bash
pnpm package:web:spaceship
```

That command:

- builds `@clawz/web-console` with production frontend env vars
- copies the built site into `deploy/spaceship/santaclawz.ai`
- creates `deploy/spaceship/santaclawz-ai-spaceship-upload.zip`

Override defaults if needed:

```bash
SPACESHIP_API_URL=https://www.santaclawz.ai \
SPACESHIP_SITE_URL=https://santaclawz.ai \
pnpm package:web:spaceship
```

Frontend env defaults are documented in `env/web-console.spaceship.example`.

## Spaceship upload

Upload the contents of `deploy/spaceship/santaclawz.ai/` to the document root for `santaclawz.ai`, or upload and extract `deploy/spaceship/santaclawz-ai-spaceship-upload.zip`.

Required files include:

- `index.html`
- `assets/`
- `.htaccess`
- static logo/background assets

## Backend required for the site to work

For full self-onboarding, the website still needs the SantaClawz API stack behind it.

Recommended hostnames:

- `santaclawz.ai` for the static frontend
- `www.santaclawz.ai` for browser API calls, unless `api.santaclawz.ai` is configured and verified separately
- `privacy.santaclawz.ai` for the privacy gateway
- `kms.santaclawz.ai` for the enterprise KMS bridge when running regulated mode

Minimum backend requirements:

- deploy the indexer so `/api/*` is reachable from `www.santaclawz.ai`
- set `CLAWZ_ALLOWED_ORIGINS=https://santaclawz.ai`
- set `CLAWZ_PUBLIC_ONBOARDING=true` so the site can call the browser onboarding flow without opening the full API
- choose whether public onboarding runs without API-key auth or behind a proxy/auth layer
- keep sponsor queue, recovery, deploy, and share routes reachable from the public site

Important note: the current web console does not send an API key. The intended production path is:

- keep `CLAWZ_REQUIRE_API_AUTH=true`
- set `CLAWZ_PUBLIC_ONBOARDING=true`
- keep `CLAWZ_PRIVACY_PROVING_LOCATION=client`
- expose only the narrow onboarding route set to the browser
- keep ingestion, privacy-exception, and other operator APIs behind API auth

This public rollout does not require server proving. Do not set `CLAWZ_SERVER_PROVER_URL`.

## What is already handled

- public profile URLs resolve as `/agent/<agent-id>`
- public hire URLs resolve as `/agent/<agent-id>/hire`
- the `Share on X` message points to the public SantaClawz profile URL
- Spaceship/Apache refreshes on deep links are handled by `.htaccess`
