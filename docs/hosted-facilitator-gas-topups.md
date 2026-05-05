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

If the relayer or fee wallet holds USDC, SantaClawz can top up native gas by swapping USDC to WETH through Uniswap V3 and unwrapping WETH to native ETH.

Payment floors are optional. Leave the floor env vars unset if the facilitator/provider supports true tiny payments and you want SantaClawz to accept them.

The repo includes an ops script:

```bash
pnpm top-up:facilitator-gas -- \
  --rail base \
  --swap-usdc 5 \
  --min-native-eth 0.003
```

The command is dry-run by default. To broadcast:

```bash
pnpm top-up:facilitator-gas -- \
  --rail base \
  --swap-usdc 5 \
  --min-native-eth 0.003 \
  --execute
```

## Required Env

Base:

```bash
X402_BASE_RPC_URL=https://...
X402_BASE_RELAYER_PRIVATE_KEY=0x...
CLAWZ_BASE_FACILITATOR_GAS_TOPUP_SWAP_USDC=5
CLAWZ_BASE_FACILITATOR_GAS_TOPUP_MIN_NATIVE_ETH=0.003
```

Ethereum:

```bash
X402_ETHEREUM_RPC_URL=https://...
X402_ETHEREUM_RELAYER_PRIVATE_KEY=0x...
CLAWZ_ETHEREUM_FACILITATOR_GAS_TOPUP_SWAP_USDC=25
CLAWZ_ETHEREUM_FACILITATOR_GAS_TOPUP_MIN_NATIVE_ETH=0.03
```

Optional shared knobs:

```bash
CLAWZ_FACILITATOR_GAS_TOPUP_SLIPPAGE_BPS=100
CLAWZ_FACILITATOR_GAS_TOPUP_POOL_FEE=500
CLAWZ_X402_HOSTED_FACILITATOR_MIN_PAYMENT_USD=
```

## Safety Rules

- The script does nothing if native gas is already above the threshold.
- The script quotes Uniswap V3 before swapping and applies a slippage floor.
- The script requires `--execute` before broadcasting transactions.
- The relayer still needs enough native ETH to pay for approve/swap gas; if it is completely empty, manually seed it first.
- Keep the relayer hot wallet low-balance and refill intentionally.

## Default Addresses

Base mainnet:

- USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- WETH: `0x4200000000000000000000000000000000000006`
- Uniswap V3 `SwapRouter02`: `0x2626664c2603336E57B271c5C0b26F421741e481`
- Uniswap V3 `QuoterV2`: `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`

Ethereum mainnet:

- USDC: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
- WETH: `0xC02aaA39b223FE8D0A0e5C4F27ead9083C756Cc2`
- Uniswap V3 `SwapRouter02`: `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`
- Uniswap V3 `QuoterV2`: `0x61fFE014bA17989E743c5F6cB21bF9697530B21e`

These addresses should be rechecked against Uniswap's official deployment docs before production changes.

## Product Boundary

This top-up script solves facilitator gas funding.

It does not, by itself, collect a SantaClawz fee from a one-leg direct seller payment. If SantaClawz needs enforceable fee collection without escrow, that requires either a separate platform fee payment leg or a higher-level billing/accounting model.
