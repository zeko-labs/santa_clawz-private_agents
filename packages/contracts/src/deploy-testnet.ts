import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AccountUpdate, Mina, PrivateKey, fetchAccount } from "o1js";

import { ApprovalKernel } from "./approval/ApprovalKernel.js";
import { DisclosureKernel } from "./disclosure/DisclosureKernel.js";
import { EscrowKernel } from "./escrow/EscrowKernel.js";
import { RegistryKernel } from "./registry/RegistryKernel.js";
import { loadLocalEnv } from "./shared/load-env.js";
import { normalizeGraphqlEndpoint } from "./shared/network.js";
import { SessionKernel } from "./session/SessionKernel.js";
import { buildDeploymentWitnessPlan } from "./shared/witness-builders.js";
import { SocialAnchorKernel } from "./social/SocialAnchorKernel.js";
import { TurnKernel } from "./turn/TurnKernel.js";

type DeployTarget = {
  label: string;
  privateKeyEnv: string;
  keychainService: string;
  contractClass:
    | typeof RegistryKernel
    | typeof SessionKernel
    | typeof TurnKernel
    | typeof ApprovalKernel
    | typeof DisclosureKernel
    | typeof EscrowKernel
    | typeof SocialAnchorKernel;
};

type SecretResolution = {
  value: string | null;
  source: "env" | "keychain" | null;
};

type DeploySummary = {
  label: string;
  address: string | null;
  status: "deployed" | "skipped";
  reason?: string;
  txHash?: string;
  fundedNewAccount?: boolean;
  secretSource?: "env" | "keychain";
};

function getKeychainSecret(service: string): SecretResolution {
  try {
    const out = execSync(`security find-generic-password -a "$USER" -s "${service}" -w`, {
      stdio: ["ignore", "pipe", "ignore"]
    });
    const value = out.toString().trim();
    return {
      value: value || null,
      source: value ? "keychain" : null
    };
  } catch {
    return {
      value: null,
      source: null
    };
  }
}

function getSecret(envName: string, keychainService?: string): SecretResolution {
  const value = process.env[envName]?.trim();
  if (value) {
    return {
      value,
      source: "env"
    };
  }

  return keychainService
    ? getKeychainSecret(keychainService)
    : {
        value: null,
        source: null
      };
}

function requireSecret(envName: string, keychainService?: string): string {
  const { value } = getSecret(envName, keychainService);
  if (!value) {
    throw new Error(`Missing required secret: ${envName}${keychainService ? ` or keychain ${keychainService}` : ""}`);
  }
  return value;
}

async function deployContract(
  target: DeployTarget,
  deployer: PrivateKey,
  fee: string
) : Promise<DeploySummary> {
  const resolved = getSecret(target.privateKeyEnv, target.keychainService);
  if (!resolved.value) {
    const reason = `${target.privateKeyEnv} or ${target.keychainService} not set`;
    console.log(`Skipping ${target.label}: ${reason}`);
    return {
      label: target.label,
      address: null,
      status: "skipped",
      reason
    };
  }

  const zkappKey = PrivateKey.fromBase58(resolved.value);
  const zkappAddress = zkappKey.toPublicKey();
  const address = zkappAddress.toBase58();
  const existing = await fetchAccount({ publicKey: zkappAddress });
  const fundedNewAccount = Boolean(existing.error);

  console.log(`Compiling ${target.label} using ${resolved.source} key material...`);
  await target.contractClass.compile();

  console.log(`Deploying ${target.label} to ${address}`);
  const tx = await Mina.transaction({ sender: deployer.toPublicKey(), fee }, async () => {
    if (fundedNewAccount) {
      AccountUpdate.fundNewAccount(deployer.toPublicKey());
    }
    const zkapp = new target.contractClass(zkappAddress);
    zkapp.deploy();
  });

  await tx.prove();
  const pending = await tx.sign([deployer, zkappKey]).send();
  const txHash =
    typeof pending === "object" &&
    pending !== null &&
    "hash" in pending &&
    typeof (pending as { hash?: unknown }).hash === "string"
      ? ((pending as { hash: string }).hash)
      : undefined;

  return {
    label: target.label,
    address,
    status: "deployed",
    fundedNewAccount,
    ...(txHash ? { txHash } : {}),
    ...(resolved.source ? { secretSource: resolved.source } : {})
  };
}

async function writeDeploymentManifest(payload: {
  networkId: string;
  mina: string;
  archive: string;
  fee: string;
  deployer: string;
  generatedAt: string;
  results: DeploySummary[];
}) {
  const deploymentsDir = join(process.cwd(), "deployments");
  await mkdir(deploymentsDir, { recursive: true });

  const latestPath = join(deploymentsDir, "latest-testnet.json");
  const witnessPlanPath = join(deploymentsDir, "latest-witness-plan.json");
  const witnessPlan = buildDeploymentWitnessPlan();
  await writeFile(witnessPlanPath, `${JSON.stringify(witnessPlan, null, 2)}\n`, "utf8");
  await writeFile(
    latestPath,
    `${JSON.stringify(
      {
        ...payload,
        witnessPlanPath,
        preparedContractCalls: witnessPlan.contracts.length,
        preparedProofCalls: witnessPlan.proofs.length
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log(`Wrote deployment manifest to ${latestPath}`);
  console.log(`Wrote deployment witness plan to ${witnessPlanPath}`);
}

async function main() {
  await loadLocalEnv(process.cwd());

  const deployer = PrivateKey.fromBase58(requireSecret("DEPLOYER_PRIVATE_KEY", "ZekoAI_SUBMITTER_PRIVATE_KEY"));
  const mina = normalizeGraphqlEndpoint(process.env.ZEKO_GRAPHQL ?? "https://testnet.zeko.io/graphql");
  const archive = normalizeGraphqlEndpoint(process.env.ZEKO_ARCHIVE ?? "https://archive.testnet.zeko.io/graphql");
  const networkId = process.env.ZEKO_NETWORK_ID ?? "testnet";
  const network = Mina.Network({
    networkId: networkId as never,
    mina,
    archive
  });
  Mina.setActiveInstance(network);

  const fee = process.env.TX_FEE ?? "200000000";
  const deployerPublicKey = deployer.toPublicKey().toBase58();
  const deployerAccount = await fetchAccount({ publicKey: deployer.toPublicKey() });

  console.log(`Deploying to network ${networkId}`);
  console.log(`GraphQL endpoint: ${mina}`);
  console.log(`Archive endpoint: ${archive}`);
  console.log(`Deployer public key: ${deployerPublicKey}`);
  if (deployerAccount.error) {
    throw new Error(`Deployer account not found on ${networkId}: ${deployerPublicKey}`);
  }

  const targets: DeployTarget[] = [
    {
      label: "RegistryKernel",
      privateKeyEnv: "REGISTRY_PRIVATE_KEY",
      keychainService: "ClawZ_REGISTRY_PRIVATE_KEY",
      contractClass: RegistryKernel
    },
    {
      label: "SessionKernel",
      privateKeyEnv: "SESSION_PRIVATE_KEY",
      keychainService: "ClawZ_SESSION_PRIVATE_KEY",
      contractClass: SessionKernel
    },
    {
      label: "TurnKernel",
      privateKeyEnv: "TURN_PRIVATE_KEY",
      keychainService: "ClawZ_TURN_PRIVATE_KEY",
      contractClass: TurnKernel
    },
    {
      label: "ApprovalKernel",
      privateKeyEnv: "APPROVAL_PRIVATE_KEY",
      keychainService: "ClawZ_APPROVAL_PRIVATE_KEY",
      contractClass: ApprovalKernel
    },
    {
      label: "DisclosureKernel",
      privateKeyEnv: "DISCLOSURE_PRIVATE_KEY",
      keychainService: "ClawZ_DISCLOSURE_PRIVATE_KEY",
      contractClass: DisclosureKernel
    },
    {
      label: "EscrowKernel",
      privateKeyEnv: "ESCROW_PRIVATE_KEY",
      keychainService: "ClawZ_ESCROW_PRIVATE_KEY",
      contractClass: EscrowKernel
    },
    {
      label: "SocialAnchorKernel",
      privateKeyEnv: "SOCIAL_ANCHOR_PRIVATE_KEY",
      keychainService: "ClawZ_SOCIAL_ANCHOR_PRIVATE_KEY",
      contractClass: SocialAnchorKernel
    }
  ];

  const results: DeploySummary[] = [];
  for (const target of targets) {
    results.push(await deployContract(target, deployer, fee));
  }

  await writeDeploymentManifest({
    networkId,
    mina,
    archive,
    fee,
    deployer: deployerPublicKey,
    generatedAt: new Date().toISOString(),
    results
  });

  console.log(JSON.stringify(results, null, 2));
  console.log("Deployment flow complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
