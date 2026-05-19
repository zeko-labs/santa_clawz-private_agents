import { execSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Mina, PrivateKey, fetchAccount } from "o1js";
import { loadLocalEnv } from "./shared/load-env.js";
import { normalizeGraphqlEndpoint } from "./shared/network.js";

type SecretResolution = {
  value: string | null;
  source: "env" | "keychain" | null;
};

type ArtifactStatus = {
  path: string;
  present: boolean;
  detail?: string;
};

type AccountStatus = {
  label: string;
  address: string | null;
  secretSource?: "env" | "keychain";
  present: boolean;
  funded?: boolean;
  note?: string;
};

type CompileManifest = {
  generatedAt?: string;
  contracts?: string[];
  proofs?: string[];
  witnessPlanPath?: string;
};

type WitnessPlanManifest = {
  scenarioId?: string;
  contracts?: unknown[];
  proofs?: unknown[];
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

async function inspectArtifact(path: string, formatter?: (contents: string) => string): Promise<ArtifactStatus> {
  try {
    await access(path);
    if (!formatter) {
      return {
        path,
        present: true
      };
    }

    const contents = await readFile(path, "utf8");
    return {
      path,
      present: true,
      detail: formatter(contents)
    };
  } catch {
    return {
      path,
      present: false
    };
  }
}

function querySequencerPk(endpoint: string): {
  ok: boolean;
  endpoint: string;
  sequencerPk?: string;
  note?: string;
} {
  const payload = JSON.stringify({
    query: "query SequencerPK { sequencerPk }"
  }).replace(/'/g, "'\"'\"'");

  try {
    const out = execSync(
      `curl -sS --max-time 20 ${endpoint} -H 'content-type: application/json' --data '${payload}'`,
      {
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const response = JSON.parse(out.toString()) as {
      data?: { sequencerPk?: string };
      errors?: Array<{ message?: string }>;
    };
    const sequencerPk = response.data?.sequencerPk;
    if (!sequencerPk) {
      return {
        ok: false,
        endpoint,
        note:
          response.errors?.map((entry) => entry.message).filter(Boolean).join("; ") ||
          "GraphQL query returned no sequencer public key."
      };
    }

    return {
      ok: true,
      endpoint,
      sequencerPk
    };
  } catch (error) {
    return {
      ok: false,
      endpoint,
      note: error instanceof Error ? error.message : "Unable to query testnet endpoint."
    };
  }
}

async function inspectAccountStatus(
  label: string,
  envName: string,
  keychainService: string
): Promise<AccountStatus> {
  const resolved = getSecret(envName, keychainService);
  if (!resolved.value) {
    return {
      label,
      address: null,
      present: false,
      note: `${envName} or ${keychainService} not set`
    };
  }

  const publicKey = PrivateKey.fromBase58(resolved.value).toPublicKey();
  const address = publicKey.toBase58();
  const account = await fetchAccount({ publicKey });

  return {
    label,
    address,
    present: true,
    funded: !account.error,
    ...(resolved.source ? { secretSource: resolved.source } : {}),
    ...(account.error ? { note: "Account not found on configured network yet." } : {})
  };
}

async function main() {
  await loadLocalEnv(process.cwd());

  const mina = normalizeGraphqlEndpoint(process.env.ZEKO_GRAPHQL ?? "https://testnet.zeko.io/graphql");
  const archive = normalizeGraphqlEndpoint(process.env.ZEKO_ARCHIVE ?? "https://archive.testnet.zeko.io/graphql");
  const networkId = process.env.ZEKO_NETWORK_ID ?? "testnet";

  const network = Mina.Network({
    networkId: networkId as never,
    mina,
    archive
  });
  Mina.setActiveInstance(network);

  const artifactsDir = join(process.cwd(), "artifacts");
  const compileManifestPath = join(artifactsDir, "latest-compile.json");
  const witnessPlanPath = join(artifactsDir, "deployment-witness-plan.json");

  const compileManifest = await inspectArtifact(compileManifestPath, (contents) => {
    const parsed = JSON.parse(contents) as CompileManifest;
    return `${parsed.contracts?.length ?? 0} contracts, ${parsed.proofs?.length ?? 0} proofs${
      parsed.generatedAt ? `, generated ${parsed.generatedAt}` : ""
    }`;
  });

  const witnessPlan = await inspectArtifact(witnessPlanPath, (contents) => {
    const parsed = JSON.parse(contents) as WitnessPlanManifest;
    return `${parsed.contracts?.length ?? 0} contract calls, ${parsed.proofs?.length ?? 0} proofs${
      parsed.scenarioId ? `, scenario ${parsed.scenarioId}` : ""
    }`;
  });

  const chain = querySequencerPk(mina);

  const deployer = await inspectAccountStatus(
    "Deployer",
    "DEPLOYER_PRIVATE_KEY",
    "ZekoAI_SUBMITTER_PRIVATE_KEY"
  );

  const kernels = await Promise.all([
    inspectAccountStatus("RegistryKernel", "REGISTRY_PRIVATE_KEY", "ClawZ_REGISTRY_PRIVATE_KEY"),
    inspectAccountStatus("SessionKernel", "SESSION_PRIVATE_KEY", "ClawZ_SESSION_PRIVATE_KEY"),
    inspectAccountStatus("TurnKernel", "TURN_PRIVATE_KEY", "ClawZ_TURN_PRIVATE_KEY"),
    inspectAccountStatus("ApprovalKernel", "APPROVAL_PRIVATE_KEY", "ClawZ_APPROVAL_PRIVATE_KEY"),
    inspectAccountStatus("DisclosureKernel", "DISCLOSURE_PRIVATE_KEY", "ClawZ_DISCLOSURE_PRIVATE_KEY"),
    inspectAccountStatus("EscrowKernel", "ESCROW_PRIVATE_KEY", "ClawZ_ESCROW_PRIVATE_KEY")
  ]);

  const blockers = [
    ...(chain.ok ? [] : ["Zeko GraphQL endpoint is not responding with a sequencer public key."]),
    ...(compileManifest.present ? [] : ["Missing compile artifact: packages/contracts/artifacts/latest-compile.json"]),
    ...(witnessPlan.present ? [] : ["Missing witness plan: packages/contracts/artifacts/deployment-witness-plan.json"]),
    ...(deployer.present ? [] : ["Missing deployer private key or keychain secret."]),
    ...(deployer.present && deployer.funded === false ? ["Deployer account is not funded or not present on testnet."] : []),
    ...kernels
      .filter((entry) => !entry.present)
      .map((entry) => `Missing contract private key for ${entry.label}.`)
  ];

  const summary = {
    networkId,
    graphqlEndpoint: mina,
    archiveEndpoint: archive,
    chain,
    artifacts: [compileManifest, witnessPlan],
    deployer,
    kernels,
    ready: blockers.length === 0,
    blockers
  };

  console.log(JSON.stringify(summary, null, 2));

  if (blockers.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
