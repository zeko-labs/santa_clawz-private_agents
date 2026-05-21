# Deployment Checklist

## Contracts

Before touching testnet from a fresh machine, run:

```bash
pnpm doctor
pnpm doctor:testnet
```

1. Copy `packages/contracts/.env.example` to a local `.env`.
2. Fill in `DEPLOYER_PRIVATE_KEY`, or store the same value in the macOS Keychain service `ZekoAI_SUBMITTER_PRIVATE_KEY`.
3. Generate one private key for each kernel you want to deploy, or store them in the matching Keychain services:
   `ClawZ_REGISTRY_PRIVATE_KEY`,
   `ClawZ_SESSION_PRIVATE_KEY`,
   `ClawZ_TURN_PRIVATE_KEY`,
   `ClawZ_APPROVAL_PRIVATE_KEY`,
   `ClawZ_DISCLOSURE_PRIVATE_KEY`,
   `ClawZ_ESCROW_PRIVATE_KEY`.
4. Ensure the deployer key is funded on Zeko testnet and `ZEKO_GRAPHQL` points at the intended endpoint.
5. Compile contracts:

```bash
pnpm --filter @clawz/contracts compile:contracts
```

That compile step now also writes:

- `packages/contracts/artifacts/latest-compile.json`
- `packages/contracts/artifacts/deployment-witness-plan.json`

Use those artifacts as the preflight source of truth for the exact kernel calls and proof inputs you expect to submit once Zeko testnet is available again.

6. Run the machine-checked preflight:

```bash
pnpm --filter @clawz/contracts preflight:testnet
```

That preflight checks:

- live GraphQL reachability
- compile artifact presence
- deployment witness-plan presence
- deployer secret presence and onchain account visibility
- kernel key presence and expected zkApp addresses

7. Check deployed verification keys against the current local build:

```bash
pnpm --filter @clawz/contracts check:vk-drift
```

If any kernel reports a mismatch, redeploy before trusting a live-flow failure as a witness bug.

8. Deploy the kernels:

```bash
pnpm --filter @clawz/contracts deploy:testnet
```

That deploy step writes:

- `packages/contracts/deployments/latest-testnet.json`
- `packages/contracts/deployments/latest-witness-plan.json`

The deployment witness-plan file is the portable handoff artifact for moving from this machine into the actual deployment environment.
Runtime session-turn submissions are written separately to `packages/contracts/deployments/latest-runtime-session-turn-plan.json` so the live-flow runner does not overwrite the deploy-time kernel witness plan.

### macOS Keychain example

```bash
security add-generic-password -U -a "$USER" -s ZekoAI_SUBMITTER_PRIVATE_KEY -w 'YOUR_FUNDED_DEPLOYER_KEY'
security add-generic-password -U -a "$USER" -s ClawZ_REGISTRY_PRIVATE_KEY -w 'YOUR_REGISTRY_KEY'
security add-generic-password -U -a "$USER" -s ClawZ_SESSION_PRIVATE_KEY -w 'YOUR_SESSION_KEY'
security add-generic-password -U -a "$USER" -s ClawZ_TURN_PRIVATE_KEY -w 'YOUR_TURN_KEY'
security add-generic-password -U -a "$USER" -s ClawZ_APPROVAL_PRIVATE_KEY -w 'YOUR_APPROVAL_KEY'
security add-generic-password -U -a "$USER" -s ClawZ_DISCLOSURE_PRIVATE_KEY -w 'YOUR_DISCLOSURE_KEY'
security add-generic-password -U -a "$USER" -s ClawZ_ESCROW_PRIVATE_KEY -w 'YOUR_ESCROW_KEY'
```

### Local runtime

After `pnpm build`, you can run the starter stack locally with:

```bash
pnpm start:indexer
pnpm start:web
```

Default local endpoints:

- web console: `http://127.0.0.1:4173`
- indexer: `http://127.0.0.1:4318`

Before exposing the indexer outside localhost, run:

```bash
pnpm preflight:production
```

That production preflight requires API authentication, a concrete CORS allowlist, non-ephemeral key management, deployment artifacts, and an intact deployment witness plan.

For production privacy infrastructure, deploy `apps/enterprise-kms` first, then `apps/privacy-gateway`, and then set the indexer to use it:

```bash
CLAWZ_REGULATED_ENTERPRISE=true
CLAWZ_KEY_BROKER_MODE=external-kms-backed
CLAWZ_KMS_ENDPOINT=https://privacy-gateway.example.com
CLAWZ_BLOB_STORE_MODE=http-object-store
CLAWZ_BLOB_STORE_ENDPOINT=https://privacy-gateway.example.com
CLAWZ_PRIVACY_GATEWAY_ATTESTED_EXTERNAL_HSM=true
```

Validate the deployed gateway with `pnpm check:privacy-gateway -- --require-external-hsm` before cutting traffic over.

## Privacy foundation

ClawZ now defaults to durable local file-backed tenant keys, wrapped-key persistence, and sealed blob manifests.
For enterprise or regulated deployment, upgrade that same interface boundary to:

- a real KMS or HSM-backed key broker
- object-storage-backed sealed blob storage
- durable indexer persistence
- audited provider routing policies
- privacy exception review workflow

Useful local/runtime controls:

- `CLAWZ_DATA_DIR` to move all indexer state, sealed blobs, and wrapped-key records onto a durable mounted volume
- `CLAWZ_KEY_BROKER_MODE=external-kms-backed` and `CLAWZ_KMS_ENDPOINT` to source workspace wrapping keys from an external KMS service
- `CLAWZ_BLOB_STORE_MODE=http-object-store` and `CLAWZ_BLOB_STORE_ENDPOINT` to persist sealed blob objects through an internal object-store gateway
- `CLAWZ_KEY_BROKER_DIR` to move the durable key-broker state out of the default `.clawz-data/kms`
- `CLAWZ_KEY_BROKER_MODE=in-memory-default-export` only for ephemeral testing

## Suggested first deployment

- `RegistryKernel`
- `SessionKernel`
- `TurnKernel`
- `ApprovalKernel`
- `DisclosureKernel`
- `EscrowKernel`

That set is enough to support:

- session identity
- turn ordering
- privacy exceptions
- selective disclosure
- budget reservation and refund
