import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Mina, PublicKey, fetchAccount } from "o1js";

import { ApprovalKernel } from "./approval/ApprovalKernel.js";
import { DisclosureKernel } from "./disclosure/DisclosureKernel.js";
import { EscrowKernel } from "./escrow/EscrowKernel.js";
import { RegistryKernel } from "./registry/RegistryKernel.js";
import { loadLocalEnv } from "./shared/load-env.js";
import { normalizeGraphqlEndpoint } from "./shared/network.js";
import { SessionKernel } from "./session/SessionKernel.js";
import { TurnKernel } from "./turn/TurnKernel.js";

interface DeploymentManifestFile {
  networkId?: string;
  mina?: string;
  archive?: string;
  results: Array<{
    label?: string;
    address?: string | null;
  }>;
}

interface VerificationKeyDriftCheck {
  label: string;
  address: string;
  localVkHash: string;
  onchainVkHash: string | null;
  matches: boolean;
}

interface CompileResultLike {
  verificationKey: {
    hash: {
      toString(): string;
    };
  };
}

interface FetchedZkappAccountLike {
  zkapp?: {
    verificationKey?: {
      hash?: {
        toString(): string;
      };
    };
  };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function main() {
  await loadLocalEnv(process.cwd());

  const deploymentPath = join(process.cwd(), "deployments", "latest-testnet.json");
  const deployment = await readJson<DeploymentManifestFile>(deploymentPath);
  const networkId = deployment.networkId ?? process.env.ZEKO_NETWORK_ID ?? "testnet";
  const mina = normalizeGraphqlEndpoint(deployment.mina ?? process.env.ZEKO_GRAPHQL ?? "https://testnet.zeko.io/graphql");
  const archive = normalizeGraphqlEndpoint(
    deployment.archive ?? process.env.ZEKO_ARCHIVE ?? "https://archive.testnet.zeko.io/graphql"
  );

  Mina.setActiveInstance(
    Mina.Network({
      networkId: networkId as never,
      mina,
      archive
    })
  );

  const targets = [
    ["RegistryKernel", RegistryKernel],
    ["SessionKernel", SessionKernel],
    ["TurnKernel", TurnKernel],
    ["ApprovalKernel", ApprovalKernel],
    ["DisclosureKernel", DisclosureKernel],
    ["EscrowKernel", EscrowKernel]
  ] as const;

  const checks: VerificationKeyDriftCheck[] = [];

  for (const [label, kernel] of targets) {
    const address = deployment.results.find((entry) => entry.label === label)?.address;
    if (!address) {
      throw new Error(`Missing deployed address for ${label}`);
    }

    const { verificationKey } = (await kernel.compile()) as CompileResultLike;
    const account = await fetchAccount({ publicKey: PublicKey.fromBase58(address) });
    const onchainVkHash = (account.account as FetchedZkappAccountLike | undefined)?.zkapp?.verificationKey?.hash?.toString() ?? null;
    checks.push({
      label,
      address,
      localVkHash: verificationKey.hash.toString(),
      onchainVkHash,
      matches: onchainVkHash === verificationKey.hash.toString()
    });
  }

  const result = {
    networkId,
    graphqlEndpoint: mina,
    archiveEndpoint: archive,
    allMatch: checks.every((check) => check.matches),
    checks
  };

  console.log(JSON.stringify(result, null, 2));

  if (!result.allMatch) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
