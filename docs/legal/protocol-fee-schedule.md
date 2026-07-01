# SantaClawz Protocol Fee Schedule

Effective date: 2026-06-30

This document is the Published SantaClawz Protocol Fee Schedule referenced by the Business Source License Additional Use Grant for `packages/contracts`.

This initial schedule reflects the current public SantaClawz runtime fee policy as of 2026-06-30. The protocol fee schedule should stay harmonized with the SantaClawz runtime configuration used in production deployments. If Render or another deployment environment is updated, update this file in the same release window.

## Current Schedule

Paid Workflows owe the greater of:

- `10` basis points (`0.1%`) of the gross paid workflow amount; or
- `$0.002` USD where the hosted EVM x402 path applies the network facilitation minimum.

The current runtime env equivalents are:

```bash
CLAWZ_PROTOCOL_OWNER_FEE_ENABLED=true
CLAWZ_PROTOCOL_OWNER_FEE_BPS=10
CLAWZ_PROTOCOL_OWNER_FEE_APPLIES_TO=santaclawz-marketplace
CLAWZ_X402_MIN_NETWORK_FACILITATION_FEE_USD=0.002
```

## Protocol Fee Recipients

EVM rails:

```text
Base USDC:     0xF787fF44c5e80c8165e1B4FB156411e2d42c91B2
Ethereum USDC: 0xF787fF44c5e80c8165e1B4FB156411e2d42c91B2
```

Runtime env equivalents:

```bash
CLAWZ_PROTOCOL_FEE_BASE_RECIPIENT=0xF787fF44c5e80c8165e1B4FB156411e2d42c91B2
CLAWZ_PROTOCOL_FEE_ETHEREUM_RECIPIENT=0xF787fF44c5e80c8165e1B4FB156411e2d42c91B2
```

Zeko-native fee recipient:

```text
Not published yet. Use a separate commercial agreement or published successor schedule before operating paid Zeko-native settlement workflows.
```

## Deployer Or Frontend Fees

Downstream deployers may add a deployer, frontend, or UI distribution fee if it remains compatible with the SantaClawz fee model:

- deployer/frontend fee: up to `300` basis points (`3%`)
- total fee stack: up to `400` basis points (`4%`)
- SantaClawz protocol fee must remain explicit in buyer-visible fee previews
- deployer/frontend fees must not hide, replace, misdirect, or reduce the SantaClawz protocol fee

## Paid Workflow Scope

Paid Workflow has the meaning given in the `packages/contracts` Business Source License Additional Use Grant. In short, it is any workflow using the Licensed Work where any party receives or expects to receive economic consideration, directly or indirectly, for agent work, task execution, coordination, routing, verification, settlement, delivery, compute, data, access, or related services.

Economic consideration includes crypto, stablecoins, fiat, credits, subscriptions, prepaid balances, tokens, rewards, revenue share, off-chain invoices, or bundled commercial fees, whether or not the payment is visible on-chain.

Workflows that are non-commercial, local development, testing, or educational do not create a protocol fee obligation under the Additional Use Grant.

## Change Policy

Fee recipient addresses, supported rails, and fee amounts may change over time. Operators should pin the schedule version they rely on and review this file before production deployment.

When the schedule changes, SantaClawz should update:

- this file
- `docs/legal/protocol-fee-schedule.json`
- runtime deployment envs
- buyer-visible fee previews where applicable
- any release notes announcing the change
