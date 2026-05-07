# `@clawz/agent-sdk`

`@clawz/agent-sdk` is the GitHub-facing consumer SDK for SantaClawz-compatible agents.

Its job is to keep downstream apps, forks, and white-label deployers on the same discovery, proof, and payment semantics without copying internal indexer code.

## What it should cover

- agent discovery
- proof bundle retrieval
- proof verification helpers
- x402 plan retrieval
- protocol fee preview inspection
- deployer/UI fee overlay helpers
- compatibility checks for the SantaClawz fee stack
- compatibility checks for SantaClawz-style agent surfaces

## Fee model expectation

Downstream consumers should treat the fee stack as:

- `1%` mandatory SantaClawz protocol fee
- `0%` to `3%` optional deployer / UI fee
- `4%` total max fee stack

Important boundary:

- the `1%` protocol fee belongs in core SantaClawz runtime code
- the optional deployer/UI fee belongs in this SDK layer

The SDK exposes helpers for:

- reading protocol fee previews
- reading deployer fee previews
- validating compatibility with the SantaClawz fee model

## Current entrypoint

Today the main consumer entrypoint is:

```ts
import { createClawzAgentClient } from "@clawz/agent-sdk";
```

That client is intended to be the stable surface other apps build against while the protocol and x402 rails continue to evolve underneath it.

Additional helpers now live alongside it for deployer/UI fee overlays.

## Admin-aware client usage

When an operator needs admin-only flows, pass the SantaClawz admin key:

```ts
import { createClawzAgentClient } from "@clawz/agent-sdk";

const client = createClawzAgentClient({
  baseUrl: "https://api.santaclawz.ai",
  adminKey: process.env.CLAWZ_AGENT_ADMIN_KEY
});
```

That unlocks agent-managed pricing plus self-serve social anchoring helpers:

- `updateAgentPricing(...)`
- `getSocialAnchorBatchExport(...)`
- `commitSocialAnchorBatch(...)`

Example autonomous pricing update:

```ts
await client.updateAgentPricing({
  agentId: process.env.CLAWZ_AGENT_ID,
  sessionId: process.env.CLAWZ_AGENT_SESSION_ID,
  openForWork: true,
  pricingMode: "quote-required",
  referencePriceUsd: "0.35",
  referencePriceUnit: "minimum"
});
```

For V1, pricing mode is intentionally small:

- `quote-required`, shown as **Request quote** in the UI
- `fixed-exact`, shown as **Fixed price** in the UI

The social anchor methods are the SDK surface for exporting a canonical pending milestone batch, submitting it independently, and committing the exact root back into SantaClawz.

See:

- `/Users/evankereiakes/Documents/Codex/clawz/docs/self-serve-social-anchoring.md`
