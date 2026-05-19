# Interop Proof Surface

ClawZ now exposes a deterministic proof surface for the agent-to-agent question:

> Who does this agent represent, what is it allowed to do, and how does it get paid?

## Endpoints

- `GET /.well-known/agent-interop.json`
  - canonical discovery document for the proof surface
- `GET /.well-known/clawz-agent.json`
  - discovery document for the proof surface
- `GET /api/interop/agent-proof`
  - returns the current proof bundle for the active session
- `GET /api/interop/verify`
  - verifies the locally focused session/turn proof bundle and returns a deterministic report
- `POST /api/interop/verify`
  - verifies a provided bundle or a remote ClawZ URL and returns the same deterministic report
- `POST /mcp`
  - JSON-RPC / MCP-style transport for discovery and proof retrieval

## Proof claims

Each bundle includes four explicit claim groups:

- `representation`
  - the shadow-wallet principal, service id, plugin id, capability id, and proof capability manifest
- `authority`
  - trust mode, proof level, allowed actions, allowed hosts, governance policy, and active privacy exceptions
- `payment`
  - spend model, payment rail, sponsored budget, remaining budget, and latest settlement evidence
- `privacy`
  - visibility default, provider class, disclosure class, retention policy, sealed artifact count, and programmable proving policy

Each claim is stable-JSON hashed with SHA-256 and field-chunked so another agent can reproduce the
same digest offline. The full bundle also carries:

- `evidence`
  - the concrete objects used to support the claims
- `trustAnchors`
  - canonical digest verification plus the mapped Zeko kernel path
- `bundleDigest`
  - the digest of the complete proof bundle

The programmable proving policy is explicit in both the discovery document and the proof bundle:

- `client`
  - default path for user-data privacy
- `server`
  - backend proving for application-data privacy
- `sovereign-rollup`
  - private Zeko rollup proving for regulated enterprise privacy

## MCP-style methods

`POST /mcp` supports:

- `tools/list`
- `tools/call` with `get_agent_discovery`
- `tools/call` with `get_agent_proof_bundle`
- `tools/call` with `verify_agent_proof`

## SDK

ClawZ now ships a consumer SDK at `@clawz/agent-sdk` so another agent runtime can:

- discover the well-known interop surface
- fetch proof bundles
- verify bundles locally with canonical digests
- ask a ClawZ verifier endpoint to verify local or remote bundles
- speak the MCP transport without rebuilding request envelopes

Example:

```ts
import { createClawzAgentClient } from "@clawz/agent-sdk";

const client = createClawzAgentClient({ baseUrl: "http://127.0.0.1:4318" });
const proof = await client.getProofBundle();
const verified = await client.verifyLiveProof();
```

## Standalone verifier

You can independently verify a live ClawZ instance or a saved bundle:

```bash
pnpm verify:proof -- --url http://127.0.0.1:4318
```

JSON report:

```bash
pnpm verify:proof -- --url http://127.0.0.1:4318 --json
```

Saved bundle:

```bash
pnpm verify:proof -- --bundle ./agent-proof.json --discovery ./clawz-agent.json
```

By default the verifier also looks for the local deployment witness plan at:

- `packages/contracts/artifacts/deployment-witness-plan.json`

That lets it confirm the bundle's claimed Zeko kernel path is already covered by the prepared
deployment artifact, even while testnet is down.

## Verification model

The immediate trustless property is reproducibility:

1. Fetch the discovery document and proof bundle.
2. Recompute the digest of every evidence object.
3. Recompute each claim digest.
4. Recompute the top-level `bundleDigest`.
5. Compare those results with the bundle payload.

The Zeko-native trust path is already mapped in `trustAnchors.verificationMaterial`, so the same
claim categories can be bound to registry, approval, disclosure, escrow, and turn-finalization
kernels once the chain is live.
