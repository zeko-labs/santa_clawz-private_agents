# Production Hardening

ClawZ is safe to run locally by default, but an exposed enterprise operator should run with explicit production controls.

## Required Runtime Controls

```bash
NODE_ENV=production
CLAWZ_RUNTIME_ENV=production
CLAWZ_REGULATED_ENTERPRISE=true
CLAWZ_DATA_DIR=/var/lib/clawz
CLAWZ_REQUIRE_API_AUTH=true
CLAWZ_API_KEY_SHA256=<sha256-of-operator-api-key>
CLAWZ_ALLOWED_ORIGINS=https://console.example.com
CLAWZ_PUBLIC_PROOF_SURFACE=discovery-only
CLAWZ_PRIVACY_GATEWAY_ATTESTED_EXTERNAL_HSM=true
```

`CLAWZ_API_KEYS` is supported for local/operator convenience, but production deployments should prefer `CLAWZ_API_KEY_SHA256` so plaintext API keys are not stored in process configuration.

## Public Onboarding Mode

For `santaclawz.ai`, prefer a narrow browser-onboarding carve-out instead of disabling API auth globally:

```bash
CLAWZ_REQUIRE_API_AUTH=true
CLAWZ_PUBLIC_ONBOARDING=true
CLAWZ_ALLOWED_ORIGINS=https://santaclawz.ai
```

That keeps operator and ingestion routes protected while allowing the public site to call only the onboarding surface:

- `GET /api/console/state`
- `POST /api/console/trust-mode`
- `POST /api/wallet/sponsor`
- `GET /api/wallet/sponsor/queue`
- `POST /api/wallet/recovery/prepare`
- `POST /api/zeko/session-turn/run`
- `POST /api/zeko/flow/run`

Everything else under `/api/` and `/mcp` continues to require an API key.

For the current SantaClawz public site rollout, keep proving on the client:

```bash
CLAWZ_PRIVACY_PROVING_LOCATION=client
```

Do not set `CLAWZ_SERVER_PROVER_URL` for this deployment.

## Programmable Privacy

SantaClawz treats the proving boundary as policy, not a hidden implementation detail:

- `CLAWZ_PRIVACY_PROVING_LOCATION=client`
  - default and recommended for user-data privacy because prompts, files, and private workspace context stay on the operator machine before only commitments leave the device
- `CLAWZ_PRIVACY_PROVING_LOCATION=server`
  - use when sensitive application context belongs to the backend and the server is the intended trust boundary
- `CLAWZ_PRIVACY_PROVING_LOCATION=sovereign-rollup`
  - use when enterprise workloads must prove inside a private Zeko rollup boundary

Advertise server and sovereign availability with:

```bash
CLAWZ_SERVER_PROVER_URL=https://prover.example.com
CLAWZ_SOVEREIGN_ROLLUP_ENABLED=true
CLAWZ_SOVEREIGN_ROLLUP_ENDPOINT=https://rollup.example.com
CLAWZ_SOVEREIGN_ROLLUP_STACK=docker-compose-phala
```

The proof surface will publish the selected location plus the available options so counterparties can verify the privacy boundary that governed the run.

For the sovereign-rollup operator path, reference the Zeko docs:

- <https://docs.zeko.io/operators/guides/rollup-on-phala>
- <https://docs.zeko.io/architecture/technical-architecture>

## External KMS Mode

Use external KMS mode when ClawZ is backing regulated or multi-tenant workloads. The included `@clawz/privacy-gateway` service implements the KMS contract and, in regulated mode, delegates root-key derivation to an external HSM/KMS service so root key material is never loaded into the ClawZ process:

```bash
CLAWZ_KEY_BROKER_MODE=external-kms-backed
CLAWZ_KMS_ENDPOINT=https://privacy-gateway.example.com
CLAWZ_KMS_API_KEY=<kms-service-token>
```

The KMS endpoint must implement:

- `POST /tenant-key` with `{ "tenantId": "..." }`
- `POST /workspace-key` with `{ "tenantId": "...", "workspaceId": "..." }`
- response body `{ "keyBase64": "<32-byte-base64-key>" }`
- optional bearer auth from `CLAWZ_KMS_API_KEY`

The indexer keeps wrapped data-key records durably, but the workspace wrapping key is sourced through this KMS boundary instead of local master-key files.

Deploy the enterprise KMS bridge first:

```bash
CLAWZ_ENTERPRISE_KMS_PROVIDER_MODE=command-adapter
CLAWZ_ENTERPRISE_KMS_COMMAND="node /opt/clawz/scripts/example-hsm-command.mjs"
CLAWZ_ENTERPRISE_KMS_API_KEY=<enterprise-kms-token>
CLAWZ_DATA_DIR=/var/lib/clawz
pnpm start:enterprise-kms
```

Then deploy the privacy gateway with:

```bash
CLAWZ_REGULATED_ENTERPRISE=true
CLAWZ_PRIVACY_GATEWAY_KEY_PROVIDER=external-hsm-derive
CLAWZ_PRIVACY_GATEWAY_HSM_ENDPOINT=https://enterprise-kms.example.com
CLAWZ_PRIVACY_GATEWAY_HSM_API_KEY=<enterprise-kms-token>
CLAWZ_PRIVACY_GATEWAY_API_KEY=<gateway-service-token>
CLAWZ_DATA_DIR=/var/lib/clawz
pnpm start:privacy-gateway
```

Keep the gateway private whenever possible. If it must be reachable over the public internet, put it behind TLS, provider firewall rules, and a long random bearer token.

For paid public agents, do not expose the raw agent runtime directly. Put an OpenClaw hire ingress in front of it, require the SantaClawz `CLAWZ_AGENT_INGRESS_TOKEN`, verify HMAC signature headers with `CLAWZ_AGENT_SIGNING_SECRET`, keep a replay cache of `request_id` values, and enforce local model/API spend limits before invoking paid tools.

The enterprise KMS bridge speaks to the privacy gateway using:

- `POST /derive-key` with `{ "derivation": "clawz/privacy-gateway/v1", "label": "tenant", "tenantId": "..." }`
- `POST /derive-key` with `{ "derivation": "clawz/privacy-gateway/v1", "label": "workspace", "tenantId": "...", "workspaceId": "..." }`
- response body `{ "keyBase64": "<32-byte-base64-key>", "keyVersion": "...", "auditId": "...", "provider": "..." }`
- bearer auth from `CLAWZ_PRIVACY_GATEWAY_HSM_API_KEY`

The bridge can be backed by an operator-owned command adapter or by another internal HTTP forwarder, so AWS KMS, GCP Cloud KMS, Azure Managed HSM, Vault Transit, or an internal custody service can sit behind it without changing ClawZ.

## Object Store Mode

For production retention and backup workflows, place sealed blobs behind an internal object-store gateway:

```bash
CLAWZ_BLOB_STORE_MODE=http-object-store
CLAWZ_BLOB_STORE_ENDPOINT=https://privacy-gateway.example.com
CLAWZ_BLOB_STORE_API_KEY=<object-store-token>
```

The object-store gateway must implement:

- `PUT /objects/:key` to write JSON objects
- `GET /objects/:key` to read JSON objects
- `DELETE /objects/:key` to delete JSON objects
- `GET /objects?prefix=<prefix>` returning `{ "keys": ["..."] }`

Local file-backed blob storage remains supported for single-node operators when `CLAWZ_DATA_DIR` points to a durable, encrypted volume.

The bundled privacy gateway implements the object-store contract using a private durable filesystem mount. This is intentionally simple: it gives operators a production-separable privacy boundary now, while still letting a cloud object-store proxy replace the storage backend without changing the indexer.

## Public Proof Surface

`CLAWZ_PUBLIC_PROOF_SURFACE=discovery-only` is the enterprise default: other agents can discover the ClawZ proof protocol without receiving full session proof bundles anonymously.

Use `full` only for demos or intentionally public proof services. Use `disabled` for private deployments where even discovery should require an API key.

## Preflight

Run this before exposing an operator:

```bash
pnpm preflight:production
```

The preflight checks API auth, CORS, key-management mode, data-dir configuration, deployment artifacts, witness-plan integrity, and secret-file permissions.

After deploying the privacy gateway and before switching the indexer to it, run:

```bash
CLAWZ_PRIVACY_GATEWAY_ENDPOINT=https://privacy-gateway.example.com \
CLAWZ_PRIVACY_GATEWAY_API_KEY=<gateway-service-token> \
pnpm check:privacy-gateway -- --require-external-hsm
```

This writes, lists, reads, and deletes a disposable preflight object, verifies both KMS key endpoints return 32-byte keys, and confirms `/health` reports `keyProvider=external-hsm-derive` with `rootKeyMaterialInProcess=false`.

For local developer rehearsal of the same regulated chain, run:

```bash
pnpm smoke:regulated-local
```
