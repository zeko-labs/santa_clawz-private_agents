import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";

import { AccountUpdate, Mina, PrivateKey } from "o1js";

import { SocialAnchorKernel } from "../dist/contracts/src/social/SocialAnchorKernel.js";
import { loadLocalEnv } from "../dist/contracts/src/shared/load-env.js";
import { normalizeGraphqlEndpoint } from "../dist/contracts/src/shared/network.js";

await loadLocalEnv(process.cwd());

const deployerPrivateKey = process.env.DEPLOYER_PRIVATE_KEY?.trim();
if (!deployerPrivateKey) {
  throw new Error("DEPLOYER_PRIVATE_KEY missing from packages/contracts/.env");
}

const deployer = PrivateKey.fromBase58(deployerPrivateKey);
const socialAnchorKey = PrivateKey.random();
const socialAnchorPublicKey = socialAnchorKey.toPublicKey();
const networkId = process.env.ZEKO_NETWORK_ID ?? "testnet";
const mina = normalizeGraphqlEndpoint(process.env.ZEKO_GRAPHQL ?? "https://testnet.zeko.io/graphql");
const archive = normalizeGraphqlEndpoint(process.env.ZEKO_ARCHIVE ?? "https://archive.testnet.zeko.io/graphql");
const fee = process.env.TX_FEE ?? "100000000";

Mina.setActiveInstance(Mina.Network({ networkId, mina, archive }));

async function fetchAccountViaGraphql(publicKey) {
  const response = await fetch(mina, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: "query Account($pk: PublicKey!) { account(publicKey: $pk) { publicKey balance { total } } }",
      variables: { pk: publicKey }
    })
  });
  if (!response.ok) {
    throw new Error(`Unable to query ${mina}: HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(payload.errors[0]?.message ?? "GraphQL account query failed.");
  }
  return payload.data?.account ?? null;
}

const deployerPublicKey = deployer.toPublicKey();
const deployerAccount = await fetchAccountViaGraphql(deployerPublicKey.toBase58());
if (!deployerAccount) {
  throw new Error(`Deployer account missing: ${deployerPublicKey.toBase58()}`);
}

console.log(
  JSON.stringify(
    {
      phase: "prepared",
      networkId,
      mina,
      archive,
      fee,
      deployerPublicKey: deployerPublicKey.toBase58(),
      socialAnchorPublicKey: socialAnchorPublicKey.toBase58()
    },
    null,
    2
  )
);

await SocialAnchorKernel.compile();

const tx = await Mina.transaction({ sender: deployerPublicKey, fee }, async () => {
  AccountUpdate.fundNewAccount(deployerPublicKey);
  const zkapp = new SocialAnchorKernel(socialAnchorPublicKey);
  zkapp.deploy();
});
await tx.prove();
const pending = await tx.sign([deployer, socialAnchorKey]).send();
const txHash =
  typeof pending === "object" && pending !== null && "hash" in pending && typeof pending.hash === "string"
    ? pending.hash
    : undefined;

const deploymentsDir = join(process.cwd(), "deployments");
await mkdir(deploymentsDir, { recursive: true });
const privatePath = join(deploymentsDir, "latest-social-anchor-testnet.private.json");
const publicPath = join(deploymentsDir, "latest-social-anchor-testnet.json");
const deployment = {
  label: "SocialAnchorKernel",
  networkId,
  mina,
  archive,
  fee,
  deployerPublicKey: deployerPublicKey.toBase58(),
  socialAnchorPublicKey: socialAnchorPublicKey.toBase58(),
  socialAnchorPrivateKey: socialAnchorKey.toBase58(),
  txHash: txHash ?? null,
  generatedAtIso: new Date().toISOString(),
  fundedNewAccount: true
};

await writeFile(privatePath, `${JSON.stringify(deployment, null, 2)}\n`, "utf8");
await chmod(privatePath, 0o600);
await writeFile(publicPath, `${JSON.stringify({ ...deployment, socialAnchorPrivateKey: "[redacted]" }, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      phase: "deployed",
      networkId,
      socialAnchorPublicKey: deployment.socialAnchorPublicKey,
      txHash: deployment.txHash,
      publicPath,
      privatePath,
      renderEnv: {
        CLAWZ_SOCIAL_ANCHOR_PUBLIC_KEY: deployment.socialAnchorPublicKey,
        SOCIAL_ANCHOR_PRIVATE_KEY_SOURCE: privatePath,
        CLAWZ_SOCIAL_ANCHOR_SUBMITTER_PRIVATE_KEY: "use DEPLOYER_PRIVATE_KEY"
      }
    },
    null,
    2
  )
);
