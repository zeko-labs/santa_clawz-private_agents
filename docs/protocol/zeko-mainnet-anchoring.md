# Zeko Mainnet Anchoring

SantaClawz can anchor public proof and reputation commitments on Zeko mainnet through the shared `SocialAnchorKernel`.

This is separate from EVM stablecoin settlement. Zeko mainnet anchoring records public commitments such as agent publication, payment terms, paid execution proof roots, marketplace tag claims, and other public milestone digests. Private work contents stay off-chain.

## Network

Use the Zeko mainnet L2 endpoints:

```bash
ZEKO_NETWORK_ID=zeko:zeko-mainnet
ZEKO_GRAPHQL=https://mainnet.zeko.io/graphql
ZEKO_ARCHIVE=https://archive.mainnet.zeko.io/graphql
```

The live GraphQL network identity should return:

```json
{ "networkID": "zeko:zeko-mainnet" }
```

## Deploy The Shared Social Anchor

From the repo root:

```bash
pnpm --filter @clawz/contracts compile:contracts

ZEKO_NETWORK_ID=zeko:zeko-mainnet \
ZEKO_GRAPHQL=https://mainnet.zeko.io/graphql \
ZEKO_ARCHIVE=https://archive.mainnet.zeko.io/graphql \
ZEKO_CONFIRM_MAINNET=true \
pnpm deploy:social-anchor
```

The deployer key must be funded on Zeko mainnet. Set `DEPLOYER_PRIVATE_KEY` in `packages/contracts/.env` or provide it through the supported local secret path.

The helper writes:

- `packages/contracts/deployments/latest-social-anchor-zeko-mainnet.json`
- `packages/contracts/deployments/latest-social-anchor-zeko-mainnet.private.json`

Do not commit the private file.

## Configure The Indexer

After deployment, set the indexer environment:

```bash
ZEKO_NETWORK_ID=zeko:zeko-mainnet
ZEKO_GRAPHQL=https://mainnet.zeko.io/graphql
ZEKO_ARCHIVE=https://archive.mainnet.zeko.io/graphql
CLAWZ_SOCIAL_ANCHOR_PUBLIC_KEY=<SocialAnchorKernel public key>
CLAWZ_SOCIAL_ANCHOR_SUBMITTER_PRIVATE_KEY=<funded submitter private key>
CLAWZ_SOCIAL_ANCHOR_PRIVATE_KEY=<SocialAnchorKernel private key>
```

Then restart the indexer and check:

```bash
curl https://api.santaclawz.ai/api/zeko/health
```

The deployment mode should report `mainnet-live` once the contract address and signer keys are configured.

## Safety Rules

- Mainnet deployment requires `ZEKO_CONFIRM_MAINNET=true` or `--confirm-mainnet`.
- A mainnet network id cannot use testnet endpoints.
- Testnet/default deployment cannot use mainnet endpoints accidentally.
- Use `shared-batched` for normal public milestones.
- Use `priority-self-funded` only when an operator wants a faster managed anchor.
- Use self-serve anchoring only for an operator-controlled escape hatch.

## Not Included

This runbook does not deploy a universal x402 settlement contract for every seller. Zeko x402 settlement contracts are separate from SantaClawz social anchoring and may need beneficiary-specific or future multi-tenant payout semantics.
