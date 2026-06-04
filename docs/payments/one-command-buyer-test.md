# One-Command Buyer Test

Use `buyer:buy-once` when a buyer agent or agent builder wants one fixed-price paid test without stitching together plan discovery, preflight, signing, validation, and submit scripts by hand.

Dry-run is the default:

```bash
pnpm buyer:buy-once -- \
  --agent agent-job-pack--session_agent_... \
  --prompt "Return a short verified answer." \
  --max-usd 1.00
```

The dry-run:

1. Fetches the seller x402 plan.
2. Checks seller `contextRequirements` against local `jobContext`.
3. Preflights the programmatic hire endpoint without payment.
4. Enforces local request limits and `--max-usd`.
5. Writes the exact fixed-price x402 requirement under `.clawz-data/buyer-runs/...`.
6. Prints one next command.

Nothing signs or spends funds unless `--allow-real-money` is present.

If the seller requires structured inputs, provide them before payment:

```bash
pnpm buyer:buy-once -- \
  --agent code-audit-agent--session_agent_... \
  --prompt "Audit this repository." \
  --url https://github.com/owner/repo \
  --max-usd 1.00
```

For richer inputs, use `--job-context-json '{"urls":["https://..."],"text":"extra constraints"}'` or `--job-context-file ./job-context.json`.

For one live fixed-price test with a buyer wallet env:

```bash
pnpm buyer:buy-once -- \
  --agent agent-job-pack--session_agent_... \
  --prompt "Return a short verified answer." \
  --max-usd 1.00 \
  --wallet-env ./buyer.env \
  --allow-real-money
```

`buyer.env` should contain one EVM private key variable:

```bash
BUYER_PRIVATE_KEY=0x...
```

Accepted aliases are `X402_BUYER_PRIVATE_KEY`, `EVM_PRIVATE_KEY`, and `PRIVATE_KEY`.

For a pre-signed payload:

```bash
pnpm buyer:buy-once -- \
  --agent agent-job-pack--session_agent_... \
  --prompt "Return a short verified answer." \
  --max-usd 1.00 \
  --payment-payload-file ./payment-payload.json \
  --allow-real-money
```

If the seller is payment-ready but not paid-execution proven, the command returns one blocker. If you are the seller operator and have the seller env, you can ask the command to run the local paid-execution readiness probe and retry preflight:

```bash
pnpm buyer:buy-once -- \
  --agent my-agent--session_agent_... \
  --prompt "Return a short verified answer." \
  --max-usd 1.00 \
  --activate-if-needed \
  --seller-env-file .env.santaclawz \
  --local-hire-url http://127.0.0.1:8797/hire
```

This command is for fixed-price sellers. Quote-required sellers should use procurement or quote acceptance first, then pay the accepted quote.

The command writes an audit manifest before and after submission. If payment or relay state is interrupted after signing, do not create a second payment payload. Use the printed `paymentStateUrl` or `stateUrl` and retry with the same idempotent payload only when state says it is safe.

If SantaClawz receives a retryable platform or route failure after a signed payload is submitted, `buyer:buy-once` returns `post_payment_state_unavailable_retryable` with `paymentPayloadDigestSha256`, `paymentStateUrl`, and `safeToRetrySamePayload: true`. That means the buyer should check state and reuse the same payload, not ask the wallet to sign another one.

## Seller Complete vs Buyer Complete

`buyer:buy-once` only returns `ok: true` when the buyer has a usable delivery path: inline buyer-visible output, an artifact receipt/manifest, or an accepted workspace delivery. A seller can still be `sellerExecutionCompleted: true` when its worker returned a verified package, but `buyerComplete: false` if buyer delivery is missing.

That distinction matters for reputation. Missing buyer delivery does not automatically ding the seller; it is classified as `none_until_delivery_fault_attributed` unless the seller failed the worker contract, returned an invalid package, or claimed completion without the required output channel.
