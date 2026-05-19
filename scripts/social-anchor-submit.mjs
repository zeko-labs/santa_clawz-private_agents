import { createClawzAgentClient } from "../packages/agent-sdk/dist/index.js";
import { submitSocialAnchorBatchOnZeko } from "../packages/contracts/dist/contracts/src/shared/social-anchor-live.js";

const DEFAULT_API_BASE = process.env.CLAWZ_API_BASE?.trim() || "https://api.santaclawz.ai";
const DEFAULT_NETWORK_ID = process.env.ZEKO_NETWORK_ID?.trim() || "testnet";
const DEFAULT_MINA = process.env.ZEKO_GRAPHQL?.trim() || "https://testnet.zeko.io/graphql";
const DEFAULT_ARCHIVE = process.env.ZEKO_ARCHIVE?.trim() || "https://archive.testnet.zeko.io/graphql";
const TESTNET_SELF_SERVE_OVERRIDE = process.env.CLAWZ_ALLOW_TESTNET_SELF_SERVE_SOCIAL_ANCHOR?.trim().toLowerCase();
const ALLOW_TESTNET_SELF_SERVE =
  TESTNET_SELF_SERVE_OVERRIDE === "1" ||
  TESTNET_SELF_SERVE_OVERRIDE === "true" ||
  TESTNET_SELF_SERVE_OVERRIDE === "yes";

function isMainnetNetworkId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized.includes("mainnet") && !normalized.includes("testnet");
}

function printUsage() {
  console.error(`Usage:
  pnpm social-anchor:submit -- \\
    --session-id session_agent_... | --agent-id agent_... \\
    --admin-key sck_... \\
    [--api-base https://api.santaclawz.ai] \\
    [--submitter-private-key EKF...] \\
    [--social-anchor-private-key EKF...] \\
    [--social-anchor-public-key B62...] \\
    [--network-id testnet] \\
    [--mina https://testnet.zeko.io/graphql] \\
    [--archive https://archive.testnet.zeko.io/graphql] \\
    [--fee 100000000] \\
    [--json]`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    if (key === "json" || key === "help") {
      args[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function normalizeBaseUrl(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printUsage();
  process.exit(0);
}

const sessionId = typeof args["session-id"] === "string" ? args["session-id"].trim() : undefined;
const agentId = typeof args["agent-id"] === "string" ? args["agent-id"].trim() : undefined;
const adminKey =
  (typeof args["admin-key"] === "string" ? args["admin-key"].trim() : undefined) ??
  process.env.CLAWZ_ADMIN_KEY?.trim();
const apiBase = normalizeBaseUrl(typeof args["api-base"] === "string" ? args["api-base"].trim() : DEFAULT_API_BASE);
const submitterPrivateKey =
  (typeof args["submitter-private-key"] === "string" ? args["submitter-private-key"].trim() : undefined) ??
  process.env.CLAWZ_SOCIAL_ANCHOR_SUBMITTER_PRIVATE_KEY?.trim() ??
  process.env.DEPLOYER_PRIVATE_KEY?.trim();
const socialAnchorPrivateKey =
  (typeof args["social-anchor-private-key"] === "string" ? args["social-anchor-private-key"].trim() : undefined) ??
  process.env.SOCIAL_ANCHOR_PRIVATE_KEY?.trim() ??
  process.env.CLAWZ_SOCIAL_ANCHOR_PRIVATE_KEY?.trim();
const socialAnchorPublicKey =
  (typeof args["social-anchor-public-key"] === "string" ? args["social-anchor-public-key"].trim() : undefined) ??
  process.env.CLAWZ_SOCIAL_ANCHOR_PUBLIC_KEY?.trim();
const networkId = typeof args["network-id"] === "string" ? args["network-id"].trim() : DEFAULT_NETWORK_ID;
const mina = typeof args.mina === "string" ? args.mina.trim() : DEFAULT_MINA;
const archive = typeof args.archive === "string" ? args.archive.trim() : DEFAULT_ARCHIVE;
const fee = typeof args.fee === "string" ? args.fee.trim() : process.env.TX_FEE?.trim();

if (!sessionId && !agentId) {
  printUsage();
  throw new Error("Pass --session-id or --agent-id.");
}

if (!adminKey) {
  throw new Error("Pass --admin-key or set CLAWZ_ADMIN_KEY.");
}

if (!submitterPrivateKey) {
  throw new Error("Pass --submitter-private-key or set CLAWZ_SOCIAL_ANCHOR_SUBMITTER_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY.");
}

if (!socialAnchorPrivateKey) {
  throw new Error("Pass --social-anchor-private-key or set SOCIAL_ANCHOR_PRIVATE_KEY.");
}

const client = createClawzAgentClient({
  baseUrl: apiBase,
  adminKey
});

const batch = await client.getSocialAnchorBatchExport({
  ...(sessionId ? { sessionId } : {}),
  ...(agentId ? { agentId } : {})
});

if (!ALLOW_TESTNET_SELF_SERVE && !isMainnetNetworkId(batch.networkId)) {
  throw new Error(
    `Self-serve social anchoring is disabled for ${batch.networkId}. Use the shared batch on testnet, or set CLAWZ_ALLOW_TESTNET_SELF_SERVE_SOCIAL_ANCHOR=true for a local dev override.`
  );
}

const submission = await submitSocialAnchorBatchOnZeko({
  batchId: batch.batchId,
  sessionId: batch.sessionId,
  rootDigestSha256: batch.rootDigestSha256,
  submitterPrivateKey,
  socialAnchorPrivateKey,
  ...(socialAnchorPublicKey ?? batch.contractAddress ? { socialAnchorPublicKey: socialAnchorPublicKey ?? batch.contractAddress } : {}),
  networkId,
  mina,
  archive,
  ...(fee ? { fee } : {})
});

const queue = await client.commitSocialAnchorBatch({
  sessionId: batch.sessionId,
  agentId: batch.agentId,
  txHash: submission.txHash,
  expectedBatchId: batch.batchId,
  expectedRootDigestSha256: batch.rootDigestSha256,
  operatorNote: "Committed from self-serve anchor submitter"
});

const result = {
  apiBase,
  sessionId: batch.sessionId,
  agentId: batch.agentId,
  anchorMode: batch.anchorMode,
  batchId: batch.batchId,
  rootDigestSha256: batch.rootDigestSha256,
  anchorField: submission.anchorField,
  txHash: submission.txHash,
  contractAddress: submission.contractAddress,
  submitFee: submission.submitFee,
  submitFeeSource: submission.submitFeeSource,
  attemptCount: submission.attemptCount,
  pendingCount: queue.pendingCount,
  anchoredCount: queue.anchoredCount
};

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Anchored social batch ${result.batchId}`);
  console.log(`Agent ID: ${result.agentId}`);
  console.log(`Session ID: ${result.sessionId}`);
  console.log(`Mode: ${result.anchorMode}`);
  console.log(`Root: ${result.rootDigestSha256}`);
  console.log(`Anchor field: ${result.anchorField}`);
  console.log(`Tx: ${result.txHash}`);
  console.log(`Contract: ${result.contractAddress}`);
  console.log(`Submit fee: ${result.submitFee} (${result.submitFeeSource})`);
  console.log(`Attempts: ${result.attemptCount}`);
  console.log(`Remaining pending milestones: ${result.pendingCount}`);
}
