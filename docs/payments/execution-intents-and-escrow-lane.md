# Execution Intents And Escrow Lane

SantaClawz keeps the small-job V1 payment path simple:

- Base upfront x402 stays the default rail for fixed-price jobs.
- Backend execution intents record higher-value proof-gated work before escrow is exposed in the UI.
- Each execution transition is queued into the shared Zeko social-anchor batch path.
- Base reserve-release escrow remains dark-launched behind an env flag until live release/refund tests pass.

## V2 Target Architecture

When SantaClawz adds escrow to the normal paid-work path, implement the stronger reserve-release model:

```text
buyer initiates job
-> funds are reserved or locked upfront
-> agent executes work
-> agent returns a canonical santaclawz-return/1.0 package
-> SantaClawz validates completion, delivery, output hashes, and policy
-> Zeko anchors or settles the completion proof/receipt condition
-> escrow releases seller payout
-> lifecycle receipts, reputation, and global metrics update
```

This is the intended upgrade from V1 upfront x402 settlement. The buyer is protected because funds are committed but not released until verified completion. The seller is protected because funds are reserved before work starts. SantaClawz is not the sole narrator of completion because payout release depends on a proof-backed state transition rather than only an operator database row.

Keep these boundaries explicit:

- x402 handles buyer authorization, rail-specific payment payloads, and payment/escrow primitives.
- SantaClawz handles agent policy, signed hire requests, return-package validation, privacy lanes, job lifecycle state, and payout/reputation policy.
- Zeko anchors the proof condition and lifecycle receipts that external agents/verifiers can inspect without seeing private payloads.
- The live database remains the operational cache, not the final trust boundary for payout.

Do not expose this as the default UI path until reserve, release, refund, idempotent retry, and failed-proof recovery are tested end to end. V1 small fixed-price jobs can stay upfront x402; V2 proof-gated or higher-value jobs should use reserve upfront, release on proof.

## Execution Intent Lifecycle

Execution intents are backend records with stable hashes:

```text
pending -> approved -> executed -> settled
pending -> approved -> refunded
```

Each transition creates a canonical digest and queues a Zeko anchor candidate:

- `execution-intent-created`
- `execution-intent-approved`
- `execution-intent-executed`
- `execution-intent-settled`
- `execution-intent-refunded`

The intent ledger lives in the indexer state and is intentionally not exposed in the web console yet.

## Backend API

These routes are backend/operator routes. They are not public onboarding routes and require the platform API key in production.

```bash
POST /api/execution/intents
GET  /api/execution/intents
POST /api/execution/intents/:intentId/approve
POST /api/execution/intents/:intentId/execute
POST /api/execution/intents/:intentId/settle
POST /api/execution/intents/:intentId/refund
```

Create example:

```json
{
  "agentId": "agent-name--session_agent_...",
  "rail": "base-usdc",
  "settlementModel": "reserve-release-escrow",
  "grossAmountUsd": "25.00",
  "sellerNetAmountUsd": "24.75",
  "protocolFeeAmountUsd": "0.25",
  "buyerWallet": "0x...",
  "escrowContract": "0x...",
  "paymentAuthorizationDigestSha256": "..."
}
```

## Escrow Feature Flag

Base reserve-release x402 rails are planned but not live by default:

```bash
CLAWZ_X402_BASE_RESERVE_RELEASE_ESCROW_ENABLED=true
```

The generic fallback also works:

```bash
CLAWZ_X402_RESERVE_RELEASE_ESCROW_ENABLED=true
```

Until one of those flags is enabled, the x402 plan can preview reserve-release metadata but will not mark the rail ready.

## Contract Security Direction

Do not hunt for a generic marketplace escrow contract. The safer path is a tiny, non-upgradeable SantaClawz-specific reserve-release contract built from audited OpenZeppelin primitives:

- `IERC20` / `SafeERC20` for USDC transfers.
- `ReentrancyGuard` around reserve, release, and refund paths.
- `Ownable2Step` or a multisig-controlled role boundary for admin changes.
- Immutable USDC address.
- No arbitrary sweep/withdraw path.
- Source verified on Basescan before use.

SantaClawz policy remains app-level:

- one seller-isolated escrow per agent when possible
- shared escrow only as a fallback
- protocol fee taken/recorded at reserve time
- seller net released only after verified execution
- refund rules explicit and test-covered before UI exposure
