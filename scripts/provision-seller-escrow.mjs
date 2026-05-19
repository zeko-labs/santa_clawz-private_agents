import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_X402_REPO_DIR = path.resolve(SCRIPT_DIR, "../../zeko-x402");
const DEFAULT_API_BASE = process.env.CLAWZ_API_BASE_URL?.trim() || "http://127.0.0.1:4318";

const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ETHEREUM_MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

function normalizeBaseUrl(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function optionalEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function requiredEnv(...names) {
  const value = optionalEnv(...names);
  if (!value) {
    throw new Error(`Missing required env var: ${names.join(" or ")}`);
  }
  return value;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function printHelp() {
  console.log(`Usage:
  pnpm provision:seller-escrow -- --rail base --session-id session_agent_... --admin-key sck_...
  pnpm provision:seller-escrow -- --rail ethereum --agent-id my-agent--session_agent_... --admin-key sck_...

Options:
  --rail base|ethereum        Which mainnet rail to provision. Defaults to base.
  --session-id <id>           Session to attach the escrow to.
  --agent-id <id>             Agent id to resolve back to a session.
  --admin-key <key>           SantaClawz admin key used to attach the escrow to the profile.
  --api-base-url <url>        SantaClawz API base. Defaults to CLAWZ_API_BASE_URL or http://127.0.0.1:4318.
  --x402-repo-dir <path>      Path to the local x402-zeko repo. Defaults to ../zeko-x402.
  --attach false              Deploy only; do not write the escrow address back to the agent profile.
  --help                      Show this message.
`);
}

function railConfig(rail) {
  if (rail === "ethereum") {
    return {
      rail,
      networkLabel: "ethereum-mainnet",
      rpcUrl: optionalEnv("X402_ETHEREUM_MAINNET_RPC_URL") ?? "https://ethereum-rpc.publicnode.com",
      deployerPrivateKey: requiredEnv(
        "X402_ETHEREUM_MAINNET_DEPLOYER_PRIVATE_KEY",
        "X402_ETHEREUM_RELAYER_PRIVATE_KEY",
        "X402_EVM_RELAYER_PRIVATE_KEY"
      ),
      usdcAddress: optionalEnv("X402_ETHEREUM_MAINNET_USDC_ADDRESS") ?? ETHEREUM_MAINNET_USDC,
      adminAddress: requiredEnv("X402_ETHEREUM_MAINNET_ESCROW_ADMIN"),
      releaserAddress: requiredEnv("X402_ETHEREUM_MAINNET_ESCROW_RELEASER"),
      paymentProfileField: "ethereumEscrowContract"
    };
  }

  return {
    rail: "base",
    networkLabel: "base-mainnet",
    rpcUrl: optionalEnv("X402_BASE_MAINNET_RPC_URL") ?? "https://mainnet.base.org",
    deployerPrivateKey: requiredEnv(
      "X402_BASE_MAINNET_DEPLOYER_PRIVATE_KEY",
      "X402_BASE_RELAYER_PRIVATE_KEY",
      "X402_EVM_RELAYER_PRIVATE_KEY"
    ),
    usdcAddress: optionalEnv("X402_BASE_MAINNET_USDC_ADDRESS") ?? BASE_MAINNET_USDC,
    adminAddress: requiredEnv("X402_BASE_MAINNET_ESCROW_ADMIN"),
    releaserAddress: requiredEnv("X402_BASE_MAINNET_ESCROW_RELEASER"),
    paymentProfileField: "baseEscrowContract"
  };
}

async function run(command, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    maxBuffer: 1024 * 1024 * 20,
    ...options
  });
  return { stdout, stderr };
}

async function ensureCompiled(x402RepoDir) {
  await run("pnpm", ["build:evm-contracts"], {
    cwd: x402RepoDir,
    env: process.env
  });
}

function deploymentSnippet(config) {
  return `
    import { createPublicClient, createWalletClient, formatUnits, getAddress, http } from "viem";
    import { privateKeyToAccount } from "viem/accounts";
    import { ${config.rail === "ethereum" ? "mainnet" : "base"} as chain } from "viem/chains";
    import { loadCompiledArtifact } from "./scripts/lib/compile-evm-contracts.mjs";

    const artifact = await loadCompiledArtifact("X402BaseUSDCReserveEscrowV4");
    const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
    const publicClient = createPublicClient({ chain, transport: http(process.env.RPC_URL) });
    const walletClient = createWalletClient({ account: deployer, chain, transport: http(process.env.RPC_URL) });
    const balance = await publicClient.getBalance({ address: deployer.address });
    if (balance === 0n) {
      throw new Error(\`Deployer \${deployer.address} has 0 native gas on ${config.networkLabel}\`);
    }
    const hash = await walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: [
        getAddress(process.env.USDC_ADDRESS),
        getAddress(process.env.ESCROW_ADMIN),
        getAddress(process.env.ESCROW_RELEASER)
      ]
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(JSON.stringify({
      network: "${config.networkLabel}",
      deployer: deployer.address,
      deployerNativeBalance: formatUnits(balance, 18),
      transactionHash: hash,
      contractAddress: receipt.contractAddress,
      usdcAddress: getAddress(process.env.USDC_ADDRESS),
      escrowAdmin: getAddress(process.env.ESCROW_ADMIN),
      escrowReleaser: getAddress(process.env.ESCROW_RELEASER)
    }));
  `;
}

async function deployEscrow(x402RepoDir, config) {
  const { stdout } = await run(
    "node",
    ["--input-type=module", "-e", deploymentSnippet(config)],
    {
      cwd: x402RepoDir,
      env: {
        ...process.env,
        DEPLOYER_PRIVATE_KEY: config.deployerPrivateKey,
        RPC_URL: config.rpcUrl,
        USDC_ADDRESS: config.usdcAddress,
        ESCROW_ADMIN: config.adminAddress,
        ESCROW_RELEASER: config.releaserAddress
      }
    }
  );

  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const payload = JSON.parse(lines.at(-1));
  if (!payload.contractAddress || !payload.transactionHash) {
    throw new Error("Escrow deployment did not return the expected contract metadata.");
  }
  return payload;
}

async function resolveSessionId(apiBase, sessionId, agentId, adminKey) {
  if (sessionId) {
    return sessionId;
  }
  if (!agentId) {
    return undefined;
  }

  const response = await fetch(
    `${normalizeBaseUrl(apiBase)}/api/console/state?agentId=${encodeURIComponent(agentId)}`,
    {
      headers: adminKey ? { "x-clawz-admin-key": adminKey } : {}
    }
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(typeof payload?.error === "string" ? payload.error : `Unable to resolve agent ${agentId}.`);
  }
  const payload = await response.json();
  return payload?.session?.sessionId;
}

async function attachEscrowToProfile(apiBase, config, sessionId, adminKey, contractAddress) {
  const response = await fetch(`${normalizeBaseUrl(apiBase)}/api/console/profile`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(adminKey ? { "x-clawz-admin-key": adminKey } : {})
    },
    body: JSON.stringify({
      sessionId,
      paymentProfile: {
        [config.paymentProfileField]: contractAddress
      }
    })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(
      typeof payload?.error === "string"
        ? payload.error
        : `Unable to attach ${config.rail} escrow to the agent profile.`
    );
  }

  return response.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === "true") {
    printHelp();
    return;
  }
  const rail = (args.rail ?? "base").trim().toLowerCase();
  const apiBase = args["api-base-url"] ? normalizeBaseUrl(args["api-base-url"]) : DEFAULT_API_BASE;
  const adminKey = typeof args["admin-key"] === "string" ? args["admin-key"].trim() : "";
  const x402RepoDir = path.resolve(args["x402-repo-dir"] ?? process.env.CLAWZ_X402_REPO_DIR ?? DEFAULT_X402_REPO_DIR);
  const config = railConfig(rail);

  await ensureCompiled(x402RepoDir);
  const deployment = await deployEscrow(x402RepoDir, config);

  console.log(
    JSON.stringify(
      {
        provisionedEscrow: {
          rail: config.rail,
          network: config.networkLabel,
          contractAddress: deployment.contractAddress,
          transactionHash: deployment.transactionHash
        }
      },
      null,
      2
    )
  );

  const sessionId = await resolveSessionId(apiBase, args["session-id"], args["agent-id"], adminKey);
  const shouldAttach =
    (typeof args.attach === "string" ? args.attach !== "false" : true) &&
    sessionId &&
    adminKey.length > 0;

  if (shouldAttach) {
    await attachEscrowToProfile(apiBase, config, sessionId, adminKey, deployment.contractAddress);
    console.log(
      JSON.stringify(
        {
          attachedToAgent: {
            sessionId,
            rail: config.rail,
            paymentProfileField: config.paymentProfileField,
            contractAddress: deployment.contractAddress
          }
        },
        null,
        2
      )
    );
  } else if (sessionId && adminKey.length === 0) {
    console.log(
      JSON.stringify(
        {
          nextStep: `Re-run with --admin-key to attach ${deployment.contractAddress} to session ${sessionId}.`
        },
        null,
        2
      )
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
