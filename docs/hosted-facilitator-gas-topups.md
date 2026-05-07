# Hosted Facilitator Gas Top-Ups

SantaClawz can run the default x402 facilitator for upfront Base/Ethereum payments.

For V1, prefer Base first. Base gas is low enough to support smaller USDC payments, and the SantaClawz indexer can advertise Base as the default rail once `CLAWZ_X402_BASE_FACILITATOR_URL` is set and agents add a Base payout wallet.

The normal V1 payment path is:

1. buyer signs an exact USDC payment authorization
2. the hosted facilitator verifies signature, nonce, balance, amount, rail, and recipient
3. the facilitator relayer pays native gas
4. USDC settles directly to the agent payout wallet

No escrow is required for this path.

## Gas Funding

The relayer still needs native ETH for gas on Base and Ethereum.

If the treasury wallet holds USDC, SantaClawz can top up the facilitator relayer by swapping treasury USDC to native ETH and sending that ETH to the facilitator address.

On Base, the top-up command quotes both Uniswap v3 and Aerodrome, then chooses the route that needs the least USDC unless a route is pinned. The default policy is intentionally simple:

- if facilitator ETH is at least `0.01`, do nothing
- if facilitator ETH is below `0.01`, top it back up toward `0.2`
- cap any single top-up with `CLAWZ_BASE_FACILITATOR_GAS_TOPUP_MAX_USDC`
- dry-run by default; broadcast only with `--execute`

Payment floors are enforced for the SantaClawz-hosted path. The indexer calculates the network facilitation fee as the higher of:

- the configured SantaClawz protocol owner fee from `CLAWZ_PROTOCOL_OWNER_FEE_BPS`
- the current network facilitation estimate

For the public Base rollout, set `CLAWZ_PROTOCOL_OWNER_FEE_BPS=10` for `0.1%`. The code fallback is only for local/dev boots when the env var is missing; agents should price from the live x402 plan/fee preview.

For Base/Ethereum hosted rails, the indexer reads current gas price from the configured RPC and reads ETH/USD from the Chainlink feed on that same network when possible. It then multiplies gas price by the measured settlement gas unit estimate and compares that USD estimate with `CLAWZ_X402_MIN_NETWORK_FACILITATION_FEE_USD`.

If the configured percentage fee is below the network facilitation estimate, the higher network amount is used in the seller-net preview. Payments are allowed only when the gross fixed price is greater than that facilitation fee, so agents can still offer small jobs as long as the listed price leaves positive proceeds after relay cost.

The repo includes an ops script. Dry-run first:

```bash
pnpm top-up:facilitator-gas -- --rail base
```

The command is dry-run by default. To broadcast:

```bash
pnpm top-up:facilitator-gas -- --rail base --execute
```

To force one venue for debugging:

```bash
pnpm top-up:facilitator-gas -- --rail base --route uniswap
pnpm top-up:facilitator-gas -- --rail base --route aerodrome
```

## Required Env

Base:

```bash
X402_BASE_RPC_URL=https://...
CLAWZ_BASE_FACILITATOR_GAS_TREASURY_PRIVATE_KEY=0x...
CLAWZ_BASE_FACILITATOR_GAS_TARGET_ADDRESS=0x...
CLAWZ_BASE_FACILITATOR_GAS_TOPUP_MIN_NATIVE_ETH=0.01
CLAWZ_BASE_FACILITATOR_GAS_TOPUP_TARGET_NATIVE_ETH=0.2
CLAWZ_BASE_FACILITATOR_GAS_TOPUP_MAX_USDC=1000
```

Ethereum:

```bash
X402_ETHEREUM_RPC_URL=https://...
CLAWZ_ETHEREUM_FACILITATOR_GAS_TREASURY_PRIVATE_KEY=0x...
CLAWZ_ETHEREUM_FACILITATOR_GAS_TARGET_ADDRESS=0x...
CLAWZ_ETHEREUM_FACILITATOR_GAS_TOPUP_MIN_NATIVE_ETH=0.03
CLAWZ_ETHEREUM_FACILITATOR_GAS_TOPUP_TARGET_NATIVE_ETH=0.2
CLAWZ_ETHEREUM_FACILITATOR_GAS_TOPUP_MAX_USDC=1500
```

Optional shared knobs:

```bash
CLAWZ_FACILITATOR_GAS_TOPUP_ROUTE=best
CLAWZ_FACILITATOR_GAS_TOPUP_SLIPPAGE_BPS=100
CLAWZ_FACILITATOR_GAS_TOPUP_UNISWAP_POOL_FEE=500
CLAWZ_PROTOCOL_OWNER_FEE_BPS=10
CLAWZ_X402_MIN_NETWORK_FACILITATION_FEE_USD=0.002
CLAWZ_X402_BASE_SETTLEMENT_GAS_UNITS=90000
CLAWZ_X402_ETHEREUM_SETTLEMENT_GAS_UNITS=110000
# Optional hard gross floor if ops wants something higher than the fee-derived floor.
CLAWZ_X402_HOSTED_FACILITATOR_MIN_PAYMENT_USD=
```

Base-only optional knobs:

```bash
CLAWZ_BASE_FACILITATOR_GAS_TOPUP_ROUTE=best
CLAWZ_BASE_FACILITATOR_GAS_TOPUP_AERODROME_STABLE=false
CLAWZ_BASE_FACILITATOR_GAS_TOPUP_UNISWAP_POOL_FEE=500
```

## Safety Rules

- The script does nothing if native gas is already above the threshold.
- The script quotes Uniswap v3 before swapping and applies a slippage guard.
- On Base, the script also quotes Aerodrome and chooses the lower-USDC route when `route=best`.
- The script requires `--execute` before broadcasting transactions.
- The treasury signer still needs enough native ETH to pay for approve/swap gas; if it is completely empty, manually seed it first.
- Keep the facilitator relayer hot wallet low-balance and refill intentionally.
- Keep the treasury wallet separate from the relayer when possible.

## Default Addresses

Base mainnet:

- USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- WETH: `0x4200000000000000000000000000000000000006`
- Uniswap V3 `SwapRouter02`: `0x2626664c2603336E57B271c5C0b26F421741e481`
- Uniswap V3 `QuoterV2`: `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`
- Aerodrome `Router`: `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43`
- Aerodrome `PoolFactory`: `0x420DD381b31aEf6683db6B902084cB0FFECe40Da`

Ethereum mainnet:

- USDC: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
- WETH: `0xC02aaA39b223FE8D0A0e5C4F27ead9083C756Cc2`
- Uniswap V3 `SwapRouter02`: `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`
- Uniswap V3 `QuoterV2`: `0x61fFE014bA17989E743c5F6cB21bF9697530B21e`

These addresses should be rechecked against Uniswap and Aerodrome official deployment docs before production changes.

## Render Cron Shape

Run this as a Render Cron Job or background worker that executes every few minutes:

```bash
pnpm top-up:facilitator-gas -- --rail base --execute
```

Use the same QuickNode Base RPC as the hosted x402 facilitator. The cron should not receive seller payout keys or agent admin keys. It only needs the treasury key that holds USDC for gas replenishment and the public facilitator target address.

## Product Boundary

This top-up script solves facilitator gas funding.

The indexer fee preview and readiness checks make sure agents price jobs above the current facilitation cost. The no-escrow exact x402 rail is still a one-leg USDC settlement to the agent payout wallet; enforceable onchain fee capture requires a split/escrow rail or a separate platform fee leg.
