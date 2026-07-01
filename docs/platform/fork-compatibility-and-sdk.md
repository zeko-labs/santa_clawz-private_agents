# SantaClawz Fork Compatibility and SDK Model

This document describes how SantaClawz should be forked, white-labeled, and redistributed without breaking the economics or trust model of the shared Zeko protocol layer.

## Core rule

Forks should be allowed.
Free-riding on the shared protocol should not.

So the recommended compatibility model is:

- SantaClawz protocol fee configured by `CLAWZ_PROTOCOL_OWNER_FEE_BPS`
- current public deployment target: `10` bps, or `0.1%`
- current published recipient and fee schedule: [`docs/legal/protocol-fee-schedule.md`](../legal/protocol-fee-schedule.md)
- `0%` to `3%` optional deployer / UI fee
- `4%` total maximum fee stack

That creates a clear split:

- SantaClawz keeps the shared trust, proof, and routing layer funded
- downstream deployers still have room to monetize their own distribution

## What “compatible” should mean

A fork or white-label deployment should only describe itself as SantaClawz-compatible if it preserves all three rules:

1. protocol fee bps is explicit in the x402 plan/fee preview and comes from `CLAWZ_PROTOCOL_OWNER_FEE_BPS`
2. `deployer fee <= 300 bps`
3. `protocol fee + deployer fee <= 400 bps`

This is a docs-level policy now and should later become an SDK/runtime compatibility check. Agents and forks should not infer the live protocol fee from code fallbacks.

## Why this fee stack is good

If the protocol fee can be removed:

- the shared Zeko proof and routing layer becomes hard to sustain
- every fork captures value while the base protocol captures none

If downstream deployers cannot add a fee:

- distribution incentives weaken
- white-label or vertical marketplace operators are pushed to fork harder

The configured protocol fee plus up to 3% deployer fee model is the middle ground:

- strong enough to fund the protocol
- flexible enough to support downstream growth
- simple enough for buyers to understand

## Protocol boundary

The protocol layer should own:

- proof surface
- compatibility rules
- SantaClawz protocol fee env policy
- settlement model metadata
- canonical fee-preview math

The downstream deployer layer should own:

- branding
- UI and distribution
- optional deployer fee
- vertical-specific packaging and curation

That boundary should stay explicit:

- the SantaClawz protocol fee lives in core SantaClawz runtime code and is configured by `CLAWZ_PROTOCOL_OWNER_FEE_BPS`
- optional deployer/UI fee lives in the SDK and downstream frontend layer

## SDK recommendation

SantaClawz should package the shared intelligence layer so forks do not need to reimplement it.

### Package roles

- `@clawz/agent-sdk`
  - fetch agent profiles
  - fetch proof bundles
  - verify proof surface data
  - inspect x402 plans
  - inspect protocol fee previews
  - overlay deployer/UI fee previews
  - validate protocol and deployer fee compatibility
- future `@clawz/protocol-sdk`
  - only if the repo later wants a lower-level protocol utility package separate from the consumer SDK

### What the SDK should make easy

A deployer should be able to:

1. point at a SantaClawz-compatible agent surface
2. fetch proof + payment metadata
3. verify the fee stack is valid
4. render the gross amount, seller net, protocol fee, and deployer fee consistently
5. detect when a fork is no longer compatible

## GitHub-first packaging

For now, this should live in the repo and in docs, even if the polished SDK surface lands later.

That means:

- keep the package directories visible in `packages/`
- document the intended export surface
- document the compatibility rules
- document the fee stack clearly enough that forks copy the right model by default

## Recommended next implementation steps

1. Keep the env-configured SantaClawz protocol fee in the shared x402 reserve-release path, with SantaClawz taking that fee at reservation time before seller escrow release/refund.
2. Add deployer fee schema and validation helpers.
3. Export those helpers from a protocol SDK package.
4. Make the SDK expose a single compatibility check for downstream platforms.
5. Add fork-facing examples that show:
   - no deployer fee
   - a `0.1% + 2%` stack
   - a rejection case above `4%`
