# Platform Credits And Stripe

SantaClawz can support two buyer payment experiences:

1. **Base USDC direct pay** for protocol-native x402 settlement.
2. **Platform credits** for retail buyers who want to top up once and spend down a balance.

The credit path should not replace x402/Base. It should wrap it with a friendlier buyer account and settlement abstraction.

## Product Goal

Buyers should be able to:

- top up credits with Stripe Checkout
- see one simple credit balance
- spend credits on agent work
- receive the same artifact, proof, and completion receipts
- let SantaClawz settle sellers through the appropriate rail

Agents should still see deterministic work, payment, and proof state. The buyer funding source should not change the runtime contract.

## Recommended Architecture

Use the same split that worked in the local Magic City research:

- Stripe = retail money movement
- platform credits = buyer-facing spending balance
- SantaClawz ledger = credit locks, releases, refunds, and fee accounting
- x402/Base USDC = protocol-native agent settlement rail
- Zeko = authorization, proof, and settlement truth

Short version:

- Stripe funds buyer credits.
- Credits authorize SantaClawz work.
- SantaClawz records a Zeko-backed payment authorization.
- Seller settlement remains auditable and idempotent.

## Core Credit Ledger

Credits should be integer accounting units, never floats.

Suggested fields:

- `creditAccountId`
- `ownerKind`: `human`, `buyer-agent`, `operator`, `team`
- `ownerId`
- `availableCredits`
- `lockedCredits`
- `totalDepositedCredits`
- `totalSpentCredits`
- `totalRefundedCredits`
- `creditScale`
- `createdAtIso`
- `updatedAtIso`

Keep `creditScale` stable once production balances exist.

## Stripe Top-Up Flow

1. Buyer selects a credit pack.
2. SantaClawz creates a Stripe Checkout Session.
3. Checkout metadata binds:
   - `creditAccountId`
   - `requesterId`
   - `amountCredits`
   - `idempotencyKey`
4. Stripe webhook confirms `checkout.session.completed`.
5. SantaClawz credits the account exactly once using the Stripe event id.
6. SantaClawz optionally writes a Zeko-backed `payment_authorization:user_wallet_topup` or `credit_topup_confirmed` statement.

Required protections:

- verify Stripe webhook signatures
- process every Stripe event id at most once
- reject invalid or missing `amountCredits`
- record chargeback/refund events as negative credit adjustments
- keep live Stripe keys only in host secrets

## Spending Credits On Agent Work

Credit spend should mirror x402 job lifecycle:

1. Buyer creates a task, quote, or procurement intent.
2. SantaClawz calculates the credit cost.
3. SantaClawz locks credits before work starts.
4. Seller runtime executes the job.
5. On successful return, SantaClawz settles locked credits into platform/seller accounting.
6. On failure/timeout/refund, SantaClawz releases or refunds locked credits according to policy.

Each spend must be keyed by:

- `creditSpendId`
- `requestId` or `intentId`
- `creditAccountId`
- `sellerAgentId`
- `amountCredits`
- `policyDigestSha256`
- `idempotencyKey`

## Zeko Authorization Statement

Every material credit movement should be exportable as a deterministic proof statement:

```json
{
  "schemaVersion": "santaclawz-credit-authorization/1.0",
  "statementKind": "credit_spend_authorized",
  "creditSpendId": "credit_spend_...",
  "requestId": "hire_...",
  "creditAccountDigestSha256": "...",
  "sellerAgentId": "agent_...",
  "amountCredits": "250",
  "amountUsdAtomic": "250000",
  "asset": "USDC",
  "chainId": 8453,
  "policyDigestSha256": "...",
  "idempotencyKey": "...",
  "expiresAtIso": "2026-05-27T20:00:00.000Z"
}
```

Zeko does not need to be the retail checkout UI. It proves that the authorization, settlement, refund, or payout state existed and matched policy.

## Seller Settlement

There are two viable V1 settlement approaches:

- **Credits as platform balance:** buyer pays Stripe, SantaClawz later settles seller through USDC or another payout rail.
- **Credits as prepaid x402 budget:** buyer credits authorize an x402/Base payment from a platform-managed settlement wallet.

Both need strict caps and idempotency. If a managed wallet is used, never execute a seller payout unless the credit spend authorization exists, is unexpired, unexecuted, and policy-valid.

## UI Guidance

The retail `/hire` surface should show:

- “Base USDC” as the live direct-pay rail.
- “Platform credits” as the friendlier top-up/spend-down rail when enabled.
- Simple language: top up, spend, receive, verify.
- Proof details as a receipt, not the main form.

Avoid making retail buyers understand x402, atomic USDC units, Zeko roots, or facilitator payloads before they get a result. Show those details after routing/payment as verifiable receipts.

## Environment Variables

When implemented, the credit rail should use host secrets for:

- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `CLAWZ_CREDITS_PER_USD`
- `CLAWZ_CREDIT_SCALE`
- `CLAWZ_DEFAULT_TOPUP_CREDITS`
- `CLAWZ_CREDIT_SPEND_MAX_USD`
- `CLAWZ_CREDIT_SETTLEMENT_WALLET_PRIVATE_KEY` if managed settlement is enabled

Do not enable managed seller settlement until replay protection, idempotency, confirmation handling, and refund paths have tests.
