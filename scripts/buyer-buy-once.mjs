#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { privateKeyToAccount } from "viem/accounts";

import { canonicalDigest } from "../packages/protocol/src/hashing/digest.js";
import { normalizeBaseUrl } from "./lib/santaclawz-readiness.mjs";
import {
  createRetryablePlatformFailure,
  isRetryablePlatformStatus,
  isRetryablePlatformTransportError
} from "./lib/platform-failures.mjs";

const BOOLEAN_FLAGS = new Set([
  "help",
  "allow-real-money",
  "json",
  "dry-run",
  "activate-if-needed",
  "activation-probe",
  "paid-activation-probe",
  "seller-readiness-test",
  "seller-test"
]);
const HIRE_TASK_PROMPT_MAX_LENGTH = 2000;
const HIRE_REQUESTER_CONTACT_MAX_LENGTH = 240;
const HIRE_REQUEST_BODY_MAX_BYTES = 32 * 1024;
const DEFAULT_OUTPUT_DIR = ".clawz-data/buyer-runs";
const DEFAULT_RECOVERY_POLL_MS = 120_000;
const RECOVERY_POLL_INTERVAL_MS = 3_000;
const UPGRADE_GUIDE_DOC = "docs/start-here/agent-upgrade-guide.md";

function printCliError(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({
    ok: false,
    code: "buyer_buy_once_failed",
    message
  }, null, 2));
}

process.on("uncaughtException", (error) => {
  printCliError(error);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  printCliError(error);
  process.exit(1);
});

function printUsage() {
  console.error(`Usage:
  pnpm buyer:buy-once -- \\
    --agent agent_job_pack--session_agent_... \\
    --prompt "Return a short verified answer." \\
    --max-usd 1.00

Dry-run is the default. It discovers price, preflights /hire, writes the x402 requirement,
and prints the exact next command before anything can spend funds.

To submit one real fixed-price paid hire:
  pnpm buyer:buy-once -- \\
    --agent agent_job_pack--session_agent_... \\
    --prompt "Return a short verified answer." \\
    --max-usd 1.00 \\
    --wallet-env ./buyer.env \\
    --allow-real-money

Options:
  --api-base https://api.santaclawz.ai
  --agent <agent-id-or-url>          Agent id, profile URL, or programmatic hire URL.
  --agent-id <agent-id>              Alias for --agent.
  --prompt "Buyer task"              Buyer task prompt.
  --task "Buyer task"                Alias for --prompt.
  --url https://example.com/input    Structured buyer context URL. Repeat or comma-separate.
  --job-context-json '{"urls":["https://..."]}'
  --job-context-file ./job-context.json
  --requester-contact buyer-agent:local
  --max-usd 1.00                     Required local budget guard.
  --wallet-env ./buyer.env           Env file containing BUYER_PRIVATE_KEY, BUYER_BASE_PRIVATE_KEY, or X402_BUYER_PRIVATE_KEY.
  --payment-payload-file ./payload.json
  --service agent_job_pack           Service key when payload file contains multiple payloads.
  --output-dir .clawz-data/buyer-runs
  --payment-requirement-out ./requirement.json
  --activation-probe                 Run a tiny paid proving job for an unproven seller.
  --seller-readiness-test            Run a tiny post-activation seller practice job that does not affect success score.
  --activate-if-needed               If seller env is provided, run seller readiness/probe before retrying preflight.
  --seller-env-file .env.santaclawz  Seller env for --activate-if-needed.
  --local-hire-url http://127.0.0.1:8797/hire
  --dry-run                          Force dry-run even when --allow-real-money is present.
  --allow-real-money                 Required before signing/submitting a paid payload.
  --json

Env:
  CLAWZ_API_FETCH_TIMEOUT_MS          Timeout for ordinary API reads. Default 10000.
  CLAWZ_PAID_SUBMIT_FETCH_TIMEOUT_MS  Timeout for paid submit POST. Default 20000.
`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function upgradeGuideHint(envFile = ".env.santaclawz") {
  const normalizedEnvFile = String(envFile || ".env.santaclawz").trim() || ".env.santaclawz";
  return {
    doc: UPGRADE_GUIDE_DOC,
    command: `pnpm agent:upgrade-guide -- --env-file ${shellQuote(normalizedEnvFile)}`,
    purpose: "Update seller runtime code, rerun readiness, and prove buyer-visible delivery before paid work."
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    if (key === "url" && args[key] !== undefined) {
      args[key] = Array.isArray(args[key]) ? [...args[key], value] : [args[key], value];
    } else {
      args[key] = value;
    }
    index += 1;
  }
  return args;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stringListFromArg(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringListFromArg(item));
  }
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sanitizeJobContext(value) {
  if (!isRecord(value)) {
    return {};
  }
  const urls = Array.isArray(value.urls)
    ? value.urls.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
    : [];
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.filter(isRecord).slice(0, 20).map((item) => ({
        kind: ["document", "image", "file", "structured_data"].includes(String(item.kind))
          ? String(item.kind)
          : "file",
        ...(typeof item.name === "string" && item.name.trim() ? { name: item.name.trim().slice(0, 160) } : {}),
        ...(typeof item.url === "string" && item.url.trim() ? { url: item.url.trim().slice(0, 2048) } : {}),
        ...(typeof item.uploadId === "string" && item.uploadId.trim() ? { uploadId: item.uploadId.trim().slice(0, 160) } : {}),
        ...(typeof item.digestSha256 === "string" && /^[a-f0-9]{64}$/i.test(item.digestSha256.trim())
          ? { digestSha256: item.digestSha256.trim().toLowerCase() }
          : {}),
        ...(typeof item.contentType === "string" && item.contentType.trim() ? { contentType: item.contentType.trim().slice(0, 120) } : {}),
        ...(Number.isFinite(item.sizeBytes) ? { sizeBytes: Number(item.sizeBytes) } : {})
      }))
    : [];
  const context = {
    ...(urls.length ? { urls } : {}),
    ...(typeof value.text === "string" && value.text.trim() ? { text: value.text.trim().slice(0, 12000) } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(value.structuredData !== undefined ? { structuredData: value.structuredData } : {}),
    ...(typeof value.note === "string" && value.note.trim() ? { note: value.note.trim().slice(0, 1000) } : {})
  };
  return Object.keys(context).length ? context : {};
}

function buildJobContext(args) {
  const fromFile = args["job-context-file"]
    ? readJsonFile(String(args["job-context-file"]), "job context")
    : {};
  const fromJson = args["job-context-json"]
    ? JSON.parse(String(args["job-context-json"]))
    : {};
  const urls = [
    ...stringListFromArg(args.url),
    ...stringListFromArg(args.urls)
  ];
  const context = {
    ...sanitizeJobContext(fromFile),
    ...sanitizeJobContext(fromJson)
  };
  if (urls.length) {
    context.urls = [...(Array.isArray(context.urls) ? context.urls : []), ...urls].slice(0, 20);
  }
  return Object.keys(context).length ? context : undefined;
}

function jobContextHasField(context, field) {
  if (!context) return false;
  if (field === "url") return Boolean(context.urls?.length) || Boolean(context.attachments?.some((item) => item?.url));
  if (field === "text") return typeof context.text === "string" && context.text.trim().length > 0;
  if (field === "file") return Boolean(context.attachments?.length);
  if (field === "document" || field === "image") return Boolean(context.attachments?.some((item) => item?.kind === field));
  if (field === "structured_data") return context.structuredData !== undefined || Boolean(context.attachments?.some((item) => item?.kind === "structured_data"));
  return false;
}

function missingContextRequirements(requirements, context) {
  if (!isRecord(requirements) || !Array.isArray(requirements.hardRequirements)) {
    return [];
  }
  return requirements.hardRequirements
    .filter(isRecord)
    .map((requirement) => {
      const anyOf = Array.isArray(requirement.anyOf) ? requirement.anyOf.map(String) : [];
      const allOf = Array.isArray(requirement.allOf) ? requirement.allOf.map(String) : [];
      const anySatisfied = anyOf.length === 0 || anyOf.some((field) => jobContextHasField(context, field));
      const allSatisfied = allOf.every((field) => jobContextHasField(context, field));
      return anySatisfied && allSatisfied ? null : requirement;
    })
    .filter(Boolean);
}

function readEnvFile(filePath) {
  const out = {};
  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    out[key] = rawValue.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return out;
}

function normalizePrivateKey(value) {
  const trimmed = String(value ?? "").trim();
  if (/^0x[a-f0-9]{64}$/i.test(trimmed)) return trimmed;
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return `0x${trimmed}`;
  return "";
}

function buyerPrivateKeyFromEnv(filePath) {
  const env = readEnvFile(filePath);
  const privateKey = normalizePrivateKey(
    env.BUYER_PRIVATE_KEY ?? env.BUYER_BASE_PRIVATE_KEY ?? env.X402_BUYER_PRIVATE_KEY ?? env.EVM_PRIVATE_KEY ?? env.PRIVATE_KEY
  );
  if (!privateKey) {
    throw new Error(`${filePath} must contain BUYER_PRIVATE_KEY, BUYER_BASE_PRIVATE_KEY, X402_BUYER_PRIVATE_KEY, EVM_PRIVATE_KEY, or PRIVATE_KEY.`);
  }
  return privateKey;
}

function parseAgentId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter(Boolean);
    const apiAgentIndex = segments.findIndex((segment) => segment === "agents");
    if (apiAgentIndex >= 0 && segments[apiAgentIndex + 1]) {
      return decodeURIComponent(segments[apiAgentIndex + 1]);
    }
    const profileIndex = segments.findIndex((segment) => segment === "agent");
    if (profileIndex >= 0 && segments[profileIndex + 1]) {
      return decodeURIComponent(segments[profileIndex + 1]);
    }
  } catch {
    return raw;
  }
  return raw;
}

function isX402PaymentPayload(value) {
  return (
    isRecord(value) &&
    value.protocol === "x402" &&
    typeof value.networkId === "string" &&
    typeof value.settlementRail === "string" &&
    typeof value.payTo === "string"
  );
}

function normalizePaymentPayloadFromFile(paymentPayloadFile, options = {}) {
  const service = typeof options.service === "string" ? options.service.trim() : "";
  if (isX402PaymentPayload(paymentPayloadFile)) return paymentPayloadFile;
  if (isRecord(paymentPayloadFile) && isX402PaymentPayload(paymentPayloadFile.paymentPayload)) {
    return paymentPayloadFile.paymentPayload;
  }
  if (!isRecord(paymentPayloadFile)) {
    throw new Error("Payment payload file must contain a raw x402 payload, { paymentPayload }, or a service-keyed payload object.");
  }
  if (service) {
    const selected = paymentPayloadFile[service];
    if (isX402PaymentPayload(selected)) return selected;
    if (isRecord(selected) && isX402PaymentPayload(selected.paymentPayload)) return selected.paymentPayload;
    throw new Error(`Service key '${service}' does not contain a valid x402 payment payload.`);
  }
  const candidates = Object.entries(paymentPayloadFile).filter(([, value]) => {
    return isX402PaymentPayload(value) || (isRecord(value) && isX402PaymentPayload(value.paymentPayload));
  });
  if (candidates.length === 1) {
    const [, value] = candidates[0];
    return isX402PaymentPayload(value) ? value : value.paymentPayload;
  }
  if (candidates.length > 1) {
    throw new Error(`Payment payload file contains multiple service-keyed x402 payloads. Pass --service. Available: ${candidates.map(([key]) => key).join(", ")}`);
  }
  throw new Error("Payment payload file does not contain a valid x402 payload.");
}

function firstX402Accept(payload) {
  return (
    payload?.accepts?.[0] ??
    payload?.paymentRequired?.accepts?.[0] ??
    payload?.paymentRequirements?.accepts?.[0] ??
    payload?.requirements?.accepts?.[0] ??
    payload?.routes?.[0]?.accepts?.[0] ??
    payload?.paymentRequirement?.accepts?.[0]
  );
}

function findPaymentRequirement(value) {
  if (!isRecord(value)) return null;
  if (value.protocol === "x402" && Array.isArray(value.accepts)) return value;
  const directCandidates = [
    value.paymentRequirement,
    value.paymentRequired,
    value.paymentRequirements,
    value.requirements,
    isRecord(value.response) ? value.response.paymentRequirement : undefined
  ];
  for (const candidate of directCandidates) {
    const found = findPaymentRequirement(candidate);
    if (found) return found;
  }
  for (const item of Object.values(value)) {
    const found = findPaymentRequirement(item);
    if (found) return found;
  }
  return null;
}

function sameAddress(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function sameAsset(left, right) {
  if (isRecord(left) && isRecord(right)) {
    return left.symbol === right.symbol &&
      left.decimals === right.decimals &&
      (left.standard ?? null) === (right.standard ?? null) &&
      sameAddress(left.address, right.address);
  }
  return left === right;
}

function matchingAccept(requirement, payload) {
  return Array.isArray(requirement?.accepts)
    ? requirement.accepts.find((option) => (
        isRecord(option) &&
        option.scheme === payload.scheme &&
        option.settlementRail === payload.settlementRail &&
        option.network === payload.networkId &&
        sameAsset(option.asset, payload.asset) &&
        String(option.amount ?? option.price ?? "") === String(payload.amount ?? "") &&
        sameAddress(option.payTo, payload.payTo)
      ))
    : null;
}

function isAtomicAmount(value) {
  return typeof value === "string" && /^[0-9]+$/.test(value) && BigInt(value) > 0n;
}

function authorizationDigest(payload) {
  const {
    authorizationDigest: _authorizationDigest,
    x402Version: _x402Version,
    ...digestPayload
  } = payload;
  return canonicalDigest(digestPayload).sha256Hex;
}

function validatePaymentPayload(input) {
  const errors = [];
  const { paymentRequirement, paymentPayload } = input;
  if (paymentPayload.protocol !== "x402") errors.push("paymentPayload.protocol must be 'x402'.");
  if (paymentPayload.settlementRail !== "evm") errors.push("paymentPayload.settlementRail must be 'evm'.");
  if (!isAtomicAmount(paymentPayload.amount)) errors.push("paymentPayload.amount must be an atomic token-unit string.");
  if (!isRecord(paymentPayload.authorization)) errors.push("paymentPayload.authorization is required.");
  if (typeof paymentPayload.authorization?.signature !== "string") errors.push("paymentPayload.authorization.signature is required.");
  if (!/^[a-f0-9]{64}$/i.test(String(paymentPayload.authorizationDigest ?? ""))) {
    errors.push("paymentPayload.authorizationDigest must be a 64-character hex digest.");
  } else if (paymentPayload.authorizationDigest !== authorizationDigest(paymentPayload)) {
    errors.push("paymentPayload.authorizationDigest does not match the canonical payload digest.");
  }
  const accept = matchingAccept(paymentRequirement, paymentPayload);
  if (!accept) errors.push("Payment payload does not match any advertised payment requirement accept option.");
  const feeSplit = isRecord(accept?.extensions?.evm?.feeSplit) ? accept.extensions.evm.feeSplit : null;
  if (feeSplit && !isRecord(paymentPayload.feeAuthorization)) {
    errors.push("paymentPayload.feeAuthorization is required for exact fee-split payments.");
  }
  return {
    ok: errors.length === 0,
    errors
  };
}

function stringField(source, key, context) {
  const value = source[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context}.${key} is required.`);
  }
  return value;
}

function findFeeSplitAccept(paymentRequirement) {
  const accepts = Array.isArray(paymentRequirement.accepts) ? paymentRequirement.accepts : [];
  const accept = accepts.find((candidate) => isRecord(candidate) && candidate.settlementModel === "x402-exact-evm-fee-split-v1");
  if (!accept) throw new Error("Payment requirement does not include an x402-exact-evm-fee-split-v1 accept option.");
  const evm = isRecord(accept.extensions) && isRecord(accept.extensions.evm) ? accept.extensions.evm : undefined;
  const feeSplit = evm && isRecord(evm.feeSplit) ? evm.feeSplit : undefined;
  if (!evm || !feeSplit) throw new Error("Fee-split x402 accept option is missing extensions.evm.feeSplit.");
  return { accept, evm, feeSplit };
}

function randomNonceHex() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function buildTransferWithAuthorizationTypedData(input) {
  const chainId = Number(input.evm.chainId);
  if (!Number.isFinite(chainId)) {
    throw new Error("Fee-split x402 accept option is missing extensions.evm.chainId.");
  }
  return {
    domain: {
      name: typeof input.evm.eip712Name === "string" ? input.evm.eip712Name : "USD Coin",
      version: typeof input.evm.assetVersion === "string" ? input.evm.assetVersion : "2",
      chainId,
      verifyingContract: stringField(input.evm, "assetAddress", "extensions.evm")
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" }
      ]
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: input.from,
      to: input.to,
      value: input.value,
      validAfter: input.validAfter,
      validBefore: input.validBefore,
      nonce: input.nonce
    }
  };
}

function feeSplitAssetAddress(input) {
  const asset = input.accept.asset;
  if (isRecord(asset) && typeof asset.address === "string" && asset.address.trim().length > 0) {
    return asset.address;
  }
  return stringField(input.evm, "assetAddress", "extensions.evm");
}

function paymentContextDigest(payload) {
  return canonicalDigest({
    requestId: payload.requestId,
    paymentId: payload.paymentId,
    scheme: payload.scheme ?? "exact",
    settlementRail: payload.settlementRail,
    networkId: payload.networkId,
    asset: payload.asset,
    amount: payload.amount,
    payer: payload.payer,
    payTo: payload.payTo,
    sessionId: payload.sessionId,
    ...(typeof payload.turnId === "string" && payload.turnId.length > 0 ? { turnId: payload.turnId } : {}),
    issuedAtIso: payload.issuedAtIso,
    expiresAtIso: payload.expiresAtIso,
    ...(isRecord(payload.extensions) ? { extensions: payload.extensions } : {})
  }).sha256Hex;
}

function buildEip3009Authorization(input) {
  return {
    primitive: "evm-eip3009-transfer-with-authorization",
    settlementRail: "evm",
    network: input.accept.network,
    asset: input.accept.asset,
    transferMethod: "EIP-3009",
    facilitator: input.evm.facilitatorUrl ?? input.evm.defaultFacilitator ?? null,
    typedData: input.typedData,
    signature: input.signature
  };
}

async function buildFeeSplitPaymentPayload(input) {
  const { accept, evm, feeSplit } = findFeeSplitAccept(input.paymentRequirement);
  const issuedAtIso = new Date().toISOString();
  const expiresAtIso = new Date(Date.parse(issuedAtIso) + 15 * 60 * 1000).toISOString();
  const validAfter = String(Math.floor(Date.parse(issuedAtIso) / 1000));
  const validBefore = String(Math.floor(Date.parse(expiresAtIso) / 1000));
  const sellerPayTo = stringField(feeSplit, "sellerPayTo", "feeSplit");
  const protocolFeePayTo = stringField(feeSplit, "protocolFeePayTo", "feeSplit");
  const sellerAmount = stringField(feeSplit, "sellerAmount", "feeSplit");
  const protocolFeeAmount = stringField(feeSplit, "protocolFeeAmount", "feeSplit");
  const grossAmount = String(accept.amount ?? accept.price ?? "");
  if (!grossAmount) throw new Error("accept.amount is required.");
  const assetAddress = feeSplitAssetAddress({ accept, evm });
  const amountUnit = isRecord(accept.extensions) && isRecord(accept.extensions.evm) && accept.extensions.evm.amountUnit === "atomic"
    ? "atomic"
    : "decimal";
  const sellerTypedData = buildTransferWithAuthorizationTypedData({
    evm,
    from: input.payer,
    to: sellerPayTo,
    value: sellerAmount,
    validAfter,
    validBefore,
    nonce: randomNonceHex()
  });
  const feeTypedData = buildTransferWithAuthorizationTypedData({
    evm,
    from: input.payer,
    to: protocolFeePayTo,
    value: protocolFeeAmount,
    validAfter,
    validBefore,
    nonce: randomNonceHex()
  });
  const [sellerSignature, feeSignature] = await Promise.all([
    input.account.signTypedData(sellerTypedData),
    input.account.signTypedData(feeTypedData)
  ]);
  const paymentId = `pay_${canonicalDigest({
    requestId: input.paymentRequirement.requestId,
    payer: input.payer,
    issuedAtIso,
    sellerNonce: sellerTypedData.message.nonce,
    feeNonce: feeTypedData.message.nonce
  }).sha256Hex.slice(0, 24)}`;
  const extensions = {
    evm: { amountUnit },
    santaclawz: {
      paymentId,
      idempotencyKey: paymentId,
      feeSplit: {
        settlementModel: "x402-exact-evm-fee-split-v1",
        sellerPayTo,
        protocolFeePayTo,
        grossAmount,
        sellerAmount,
        protocolFeeAmount,
        ...(Number.isInteger(feeSplit.feeBps) ? { feeBps: feeSplit.feeBps } : {})
      }
    }
  };
  const hostedAccepted = {
    scheme: accept.scheme,
    network: stringField(accept, "network", "accept"),
    asset: assetAddress,
    amount: grossAmount,
    payTo: sellerPayTo,
    maxTimeoutSeconds: Number.isFinite(Number(evm.maxTimeoutSeconds)) ? Number(evm.maxTimeoutSeconds) : 60,
    extra: {
      name: typeof evm.eip712Name === "string" ? evm.eip712Name : "USD Coin",
      version: typeof evm.assetVersion === "string" ? evm.assetVersion : "2",
      amountUnit,
      settlementModel: "x402-exact-evm-fee-split-v1",
      feeSplit: {
        version: typeof feeSplit.version === "string" ? feeSplit.version : "protocol-owner-fee-v1",
        grossAmount,
        sellerAmount,
        protocolFeeAmount,
        sellerPayTo,
        protocolFeePayTo,
        feeSettlementMode: typeof feeSplit.feeSettlementMode === "string" ? feeSplit.feeSettlementMode : "exact-eip3009-split-v1",
        ...(Number.isInteger(feeSplit.feeBps) ? { feeBps: feeSplit.feeBps } : {})
      }
    }
  };
  const hostedPayload = {
    signature: sellerSignature,
    authorization: sellerTypedData.message,
    primitive: "evm-eip3009-transfer-with-authorization",
    feeAuthorization: {
      signature: feeSignature,
      authorization: feeTypedData.message,
      primitive: "evm-eip3009-transfer-with-authorization"
    }
  };
  const payloadWithoutDigest = {
    x402Version: 2,
    protocol: "x402",
    version: "2",
    requestId: stringField(input.paymentRequirement, "requestId", "paymentRequirement"),
    paymentId,
    scheme: "exact",
    settlementRail: "evm",
    networkId: stringField(accept, "network", "accept"),
    asset: accept.asset,
    amount: grossAmount,
    payer: input.payer,
    payTo: sellerPayTo,
    sessionId: input.sessionId,
    issuedAtIso,
    expiresAtIso,
    extensions,
    accepted: hostedAccepted,
    payload: hostedPayload,
    payloadShape: "santaclawz-hosted-exact-fee-split-v1"
  };
  const basePayload = {
    ...payloadWithoutDigest,
    paymentContextDigest: paymentContextDigest(payloadWithoutDigest)
  };
  const payload = {
    ...basePayload,
    authorization: buildEip3009Authorization({
      accept,
      evm,
      typedData: sellerTypedData,
      signature: sellerSignature
    }),
    feeAuthorization: buildEip3009Authorization({
      accept,
      evm,
      typedData: feeTypedData,
      signature: feeSignature
    })
  };
  return {
    ...payload,
    authorizationDigest: authorizationDigest(payload)
  };
}

function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function decimalStringToNumber(value) {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

function usdFromAtomic(value, decimals = 6) {
  if (!/^[0-9]+$/.test(String(value ?? ""))) return null;
  const raw = BigInt(String(value));
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const fraction = raw % divisor;
  const padded = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return Number(`${whole.toString()}${padded ? `.${padded}` : ""}`);
}

function priceUsdFromSources(plan, paymentRequirement, accept) {
  const candidates = [
    plan?.fixedAmountUsd,
    plan?.costEstimate?.rails?.[0]?.estimatedTotalCostUsd,
    plan?.rails?.[0]?.estimatedTotalCostUsd,
    plan?.rails?.[0]?.amountUsd,
    paymentRequirement?.amountUsd,
    paymentRequirement?.priceUsd,
    accept?.amountUsd,
    accept?.priceUsd
  ];
  for (const candidate of candidates) {
    const n = decimalStringToNumber(candidate);
    if (n !== null && n > 0) return n;
  }
  const amount = accept?.amount ?? accept?.price;
  const decimals = isRecord(accept?.asset) && Number.isInteger(accept.asset.decimals) ? accept.asset.decimals : 6;
  return usdFromAtomic(amount, decimals);
}

function formatUsd(value) {
  return Number.isFinite(value) ? value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") : "unknown";
}

function boundedIntegerEnv(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

const API_FETCH_TIMEOUT_MS = boundedIntegerEnv("CLAWZ_API_FETCH_TIMEOUT_MS", 10_000, 1_000, 120_000);
const PAID_SUBMIT_FETCH_TIMEOUT_MS = boundedIntegerEnv("CLAWZ_PAID_SUBMIT_FETCH_TIMEOUT_MS", 20_000, 5_000, 120_000);

async function requestJson(url, init = {}, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : API_FETCH_TIMEOUT_MS;
  const fetchInit = {
    ...init,
    ...(!init.signal && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? { signal: AbortSignal.timeout(timeoutMs) }
      : {})
  };
  let response;
  try {
    response = await fetch(url, fetchInit);
  } catch (error) {
    if (!isRetryablePlatformTransportError(error)) throw error;
    return {
      ok: false,
      status: 0,
      payload: createRetryablePlatformFailure(0, error instanceof Error ? error.message : String(error), {
        code: "platform_unavailable_retryable",
        operation: init.method ?? "GET",
        transportTimeoutMs: timeoutMs
      })
    };
  }
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = isRetryablePlatformStatus(response.status)
      ? createRetryablePlatformFailure(response.status, text, {
          code: "platform_unavailable_retryable",
          operation: init.method ?? "GET",
          transportTimeoutMs: timeoutMs
        })
      : { error: text.slice(0, 1000) };
  }
  return { ok: response.ok, status: response.status, payload };
}

function paidSubmitJson(url, init) {
  return requestJson(url, init, { timeoutMs: PAID_SUBMIT_FETCH_TIMEOUT_MS });
}

function firstRecord(...values) {
  return values.find((value) => isRecord(value)) ?? {};
}

function arrayValue(source, key) {
  return isRecord(source) && Array.isArray(source[key]) ? source[key] : [];
}

function stringValue(source, key) {
  return isRecord(source) && typeof source[key] === "string" ? source[key] : "";
}

function ledgerPaymentSettled(ledger) {
  return (
    stringValue(ledger, "paymentStatus") === "settled" ||
    stringValue(ledger, "paymentStatus") === "already_settled" ||
    Boolean(
      stringValue(ledger, "sellerSettlementTxHash") ||
      stringValue(ledger, "protocolFeeTxHash") ||
      stringValue(ledger, "settlementReference") ||
      arrayValue(ledger, "transactionHashes").length > 0
    )
  );
}

function buyerDeliveryProjection(payload) {
  const response = isRecord(payload?.response) ? payload.response : payload;
  const protocolReturn = firstRecord(response?.protocolReturn, payload?.protocolReturn);
  const verifiedOutput = firstRecord(
    protocolReturn.verifiedOutput,
    protocolReturn.verified_output,
    response?.verifiedOutput,
    response?.verified_output,
    response?.delivery?.protocolVerifiedOutput,
    payload?.verifiedOutput,
    payload?.verified_output
  );
  const delivery = firstRecord(response?.delivery, payload?.delivery);
  const lifecycle = firstRecord(response?.lifecycle, payload?.lifecycle);
  const lifecycleChecks = firstRecord(response?.lifecycleChecks, payload?.lifecycleChecks);
  const workspace = firstRecord(response?.workspace, payload?.workspace);
  const artifactReceipts = arrayValue(delivery, "artifactReceipts");
  const buyerVisibleOutputs = [
    ...arrayValue(verifiedOutput, "buyerVisibleOutputs"),
    ...arrayValue(verifiedOutput, "buyer_visible_outputs")
  ].filter((entry) => isRecord(entry));
  const inlineOutputCount = buyerVisibleOutputs.filter((entry) =>
    typeof entry.text === "string" && entry.text.trim().length > 0
  ).length;
  const artifactManifestUrl =
    stringValue(verifiedOutput, "artifactManifestUrl") ||
    stringValue(verifiedOutput, "artifact_manifest_url");
  const artifactBundleDigestSha256 =
    stringValue(verifiedOutput, "artifactBundleDigestSha256") ||
    stringValue(verifiedOutput, "artifact_bundle_digest_sha256");
  const artifactReceiptCount = artifactReceipts.length;
  const workspaceMessageCount = typeof workspace.messageCount === "number" ? workspace.messageCount : 0;
  const artifactAvailable = Boolean(artifactManifestUrl || artifactBundleDigestSha256 || artifactReceiptCount > 0);
  const inlineAvailable = inlineOutputCount > 0;
  const workspaceAvailable = workspaceMessageCount > 0 && (
    stringValue(lifecycle, "buyerAcceptanceStatus") === "accepted" ||
    stringValue(response, "currentPhase") === "buyer_accepted"
  );
  const buyerDeliveryStatus = inlineAvailable
    ? "inline_available"
    : artifactAvailable
      ? "artifact_available"
      : workspaceAvailable
        ? "workspace_available"
        : lifecycleChecks.failed === true
          ? "failed"
          : "missing";
  return {
    buyerDeliveryStatus,
    buyerDeliveryAvailable: inlineAvailable || artifactAvailable || workspaceAvailable,
    buyerVisibleOutputCount: buyerVisibleOutputs.length,
    inlineOutputCount,
    artifactDeliveryAvailable: artifactAvailable,
    artifactDeliveryStatus:
      stringValue(lifecycle, "artifactDeliveryStatus") ||
      (artifactAvailable ? "delivered" : "not_delivered"),
    artifactReceiptCount,
    buyerVerificationStatus: stringValue(lifecycle, "buyerVerificationStatus") || "not_verified",
    buyerAcceptanceStatus: stringValue(lifecycle, "buyerAcceptanceStatus") || "pending"
  };
}

function buyerVisibleOutputTexts(payload) {
  const response = isRecord(payload?.response) ? payload.response : payload;
  const protocolReturn = firstRecord(response?.protocolReturn, payload?.protocolReturn);
  const verifiedOutput = firstRecord(
    protocolReturn.verifiedOutput,
    protocolReturn.verified_output,
    response?.verifiedOutput,
    response?.verified_output,
    response?.delivery?.protocolVerifiedOutput,
    payload?.verifiedOutput,
    payload?.verified_output
  );
  return [
    ...arrayValue(verifiedOutput, "buyerVisibleOutputs"),
    ...arrayValue(verifiedOutput, "buyer_visible_outputs")
  ]
    .filter((entry) => isRecord(entry) && typeof entry.text === "string" && entry.text.trim().length > 0)
    .map((entry) => entry.text.trim());
}

function writeBuyerOutputFile(runDir, payload) {
  const outputs = buyerVisibleOutputTexts(payload);
  if (outputs.length === 0) {
    return "";
  }
  const filePath = path.join(runDir, "buyer-output.md");
  writeFileSync(filePath, `${outputs.join("\n\n---\n\n")}\n`, { mode: 0o600 });
  return filePath;
}

function paidExecutionSummary(responseOk, payload) {
  const operational = isRecord(payload?.operationalStatus) ? payload.operationalStatus : {};
  const payment = isRecord(payload?.payment) ? payload.payment : {};
  const stringFrom = (source, key) => (isRecord(source) && typeof source[key] === "string" ? source[key] : "");
  const paymentStatus = stringFrom(operational, "paymentStatus") || stringFrom(payload, "paymentStatus") || stringFrom(payment, "status");
  const settlementStatus = stringFrom(operational, "settlementStatus") || stringFrom(payload, "settlementStatus") || "unknown";
  const relayDeliveryStatus = stringFrom(operational, "relayDeliveryStatus") || stringFrom(payload, "relayDeliveryStatus") || "not_confirmed";
  const agentExecutionStatus =
    stringFrom(operational, "agentExecutionStatus") || stringFrom(payload, "agentExecutionStatus") || stringFrom(payload, "status") || "not_confirmed";
  const paymentAccepted = ["authorized", "settled", "paid", "escrowed", "execution_completed"].includes(paymentStatus);
  const workCompleted =
    responseOk &&
    paymentAccepted &&
    ["forwarded", "recorded", "reconciled_completed"].includes(relayDeliveryStatus) &&
    agentExecutionStatus === "completed";
  const sellerExecutionCompleted = workCompleted;
  const buyerDelivery = buyerDeliveryProjection(payload);
  const buyerComplete = sellerExecutionCompleted && buyerDelivery.buyerDeliveryAvailable;
  const acceptedPendingResult =
    responseOk &&
    relayDeliveryStatus === "acknowledged" &&
    agentExecutionStatus === "running_or_unknown";
  const sellerFault =
    agentExecutionStatus === "failed" ||
    relayDeliveryStatus === "return_rejected" ||
    stringFrom(payload, "returnValidationError") ||
    stringFrom(payload, "returnValidationCode");
  const outputUnavailable = sellerExecutionCompleted && !buyerDelivery.buyerDeliveryAvailable;
  return {
    ok: buyerComplete,
    code: buyerComplete
      ? "paid_execution_buyer_complete"
      : outputUnavailable
        ? "paid_execution_output_unavailable"
      : acceptedPendingResult
        ? "job_running_or_return_timeout"
        : "paid_execution_not_completed",
    paymentStatus: paymentStatus || "unknown",
    settlementStatus,
    relayDeliveryStatus,
    agentExecutionStatus,
    sellerExecutionCompleted,
    buyerComplete,
    ...buyerDelivery,
    sellerReputationImpact: sellerFault
      ? "seller_failure"
      : outputUnavailable
        ? "none_until_delivery_fault_attributed"
        : "none",
    completionMode: buyerComplete
      ? (settlementStatus === "settled" ? "buyer_delivery_settled" : "buyer_delivery_return_verified")
      : sellerExecutionCompleted
        ? "seller_return_verified_buyer_delivery_missing"
        : "none",
    retryable: paymentAccepted && agentExecutionStatus !== "completed",
    nextAction: buyerComplete
      ? "view_delivery"
      : outputUnavailable
        ? "inspect_buyer_delivery_or_artifact_state"
        : acceptedPendingResult
          ? "poll_state_or_resume_same_payment"
          : "inspect_payment_or_execution_state",
    ...(outputUnavailable ? { upgradeGuide: upgradeGuideHint() } : {}),
    ...(acceptedPendingResult
      ? {
          safeToRetrySamePayload: true,
          doNotCreateNewPayment: true
        }
      : {})
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stateUrlFromSubmitPayload(payload, fallbackUrl) {
  const statePath =
    payload?.jobWorkspace?.statePath ??
    payload?.paidExecution?.jobWorkspace?.statePath;
  if (typeof statePath === "string" && statePath.trim()) {
    return statePath.startsWith("http") ? statePath : `${apiBase}${statePath}`;
  }
  const stateUrl = typeof payload?.stateUrl === "string" ? payload.stateUrl.trim() : "";
  if (stateUrl && /[?&]token=/.test(stateUrl)) {
    return stateUrl;
  }
  if (stateUrl && !fallbackUrl) {
    return stateUrl;
  }
  return fallbackUrl;
}

function recoveredCompletionFromState(payload) {
  const lifecycle = isRecord(payload?.lifecycle) ? payload.lifecycle : {};
  const checks = isRecord(payload?.lifecycleChecks) ? payload.lifecycleChecks : {};
  const currentPhase = typeof payload?.currentPhase === "string" ? payload.currentPhase : "";
  const relayDeliveryStatus = typeof lifecycle.relayDeliveryStatus === "string" ? lifecycle.relayDeliveryStatus : "";
  const agentExecutionStatus = typeof lifecycle.agentExecutionStatus === "string" ? lifecycle.agentExecutionStatus : "";
  const proofStatus = typeof lifecycle.proofStatus === "string" ? lifecycle.proofStatus : "";
  const buyerDelivery = buyerDeliveryProjection(payload);
  const sellerExecutionCompleted =
    agentExecutionStatus === "completed" &&
    ["forwarded", "recorded", "reconciled_completed"].includes(relayDeliveryStatus) &&
    (proofStatus === "return_validated" || proofStatus === "anchored_or_attested");
  const failed = checks.failed === true;
  const returnVerified =
    !failed &&
    (
      currentPhase === "artifact_delivered" ||
      currentPhase === "buyer_verified" ||
      currentPhase === "buyer_accepted" ||
      currentPhase === "return_verified" ||
      sellerExecutionCompleted
    );
  const completed = returnVerified && buyerDelivery.buyerDeliveryAvailable;
  const outputUnavailable = returnVerified && !buyerDelivery.buyerDeliveryAvailable;
  return {
    completed,
    sellerExecutionCompleted: returnVerified,
    buyerComplete: completed,
    outputUnavailable,
    failed,
    currentPhase,
    paymentStatus: typeof lifecycle.paymentStatus === "string" ? lifecycle.paymentStatus : "unknown",
    settlementStatus: typeof lifecycle.settlementStatus === "string" ? lifecycle.settlementStatus : "unknown",
    relayDeliveryStatus: relayDeliveryStatus || "unknown",
    agentExecutionStatus: agentExecutionStatus || "unknown",
    proofStatus: proofStatus || "unknown",
    ...buyerDelivery
  };
}

async function pollRecoverableExecutionState(stateUrl, maxMs = DEFAULT_RECOVERY_POLL_MS) {
  if (!stateUrl) {
    return { recovered: false, reason: "missing_state_url" };
  }
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt <= maxMs) {
    const state = await requestJson(stateUrl);
    last = state;
    if ((state.status === 401 || state.status === 403) && !/[?&]token=/.test(stateUrl)) {
      return {
        recovered: false,
        terminal: false,
        elapsedMs: Date.now() - startedAt,
        reason: "state_url_requires_token",
        lastStatus: state.status,
        lastPayload: state.payload
      };
    }
    if (state.ok) {
      const completion = recoveredCompletionFromState(state.payload);
      if (completion.completed) {
        return {
          recovered: true,
          elapsedMs: Date.now() - startedAt,
          state: state.payload,
          completion
        };
      }
      if (completion.failed) {
        return {
          recovered: false,
          terminal: true,
          elapsedMs: Date.now() - startedAt,
          state: state.payload,
          completion
        };
      }
      if (completion.outputUnavailable) {
        return {
          recovered: false,
          terminal: true,
          elapsedMs: Date.now() - startedAt,
          reason: "paid_execution_output_unavailable",
          state: state.payload,
          completion
        };
      }
    }
    await sleep(RECOVERY_POLL_INTERVAL_MS);
  }
  return {
    recovered: false,
    elapsedMs: Date.now() - startedAt,
    lastStatus: last?.status,
    lastPayload: last?.payload
  };
}

function recoveredSummaryFromRecoveryPoll(recoveryPoll, sellerEnvFile = ".env.santaclawz") {
  return recoveryPoll?.recovered
    ? {
        ok: true,
        code: "paid_execution_buyer_complete",
        completionMode: "recovered_buyer_delivery_available",
        retryable: false,
        nextAction: "view_delivery",
        paymentStatus: recoveryPoll.completion.paymentStatus,
        settlementStatus: recoveryPoll.completion.settlementStatus,
        relayDeliveryStatus: recoveryPoll.completion.relayDeliveryStatus,
        agentExecutionStatus: recoveryPoll.completion.agentExecutionStatus,
        proofStatus: recoveryPoll.completion.proofStatus,
        sellerExecutionCompleted: recoveryPoll.completion.sellerExecutionCompleted,
        buyerComplete: recoveryPoll.completion.buyerComplete,
        buyerDeliveryStatus: recoveryPoll.completion.buyerDeliveryStatus,
        buyerDeliveryAvailable: recoveryPoll.completion.buyerDeliveryAvailable,
        buyerVisibleOutputCount: recoveryPoll.completion.buyerVisibleOutputCount,
        artifactDeliveryAvailable: recoveryPoll.completion.artifactDeliveryAvailable,
        artifactDeliveryStatus: recoveryPoll.completion.artifactDeliveryStatus,
        buyerVerificationStatus: recoveryPoll.completion.buyerVerificationStatus,
        buyerAcceptanceStatus: recoveryPoll.completion.buyerAcceptanceStatus,
        sellerReputationImpact: "none"
      }
    : recoveryPoll?.completion?.outputUnavailable
      ? {
          ok: false,
          code: "paid_execution_output_unavailable",
          completionMode: "seller_return_verified_buyer_delivery_missing",
          retryable: false,
          nextAction: "inspect_buyer_delivery_or_artifact_state",
          paymentStatus: recoveryPoll.completion.paymentStatus,
          settlementStatus: recoveryPoll.completion.settlementStatus,
          relayDeliveryStatus: recoveryPoll.completion.relayDeliveryStatus,
          agentExecutionStatus: recoveryPoll.completion.agentExecutionStatus,
          proofStatus: recoveryPoll.completion.proofStatus,
          sellerExecutionCompleted: recoveryPoll.completion.sellerExecutionCompleted,
          buyerComplete: false,
          buyerDeliveryStatus: recoveryPoll.completion.buyerDeliveryStatus,
          buyerDeliveryAvailable: false,
          buyerVisibleOutputCount: recoveryPoll.completion.buyerVisibleOutputCount,
          artifactDeliveryAvailable: recoveryPoll.completion.artifactDeliveryAvailable,
          artifactDeliveryStatus: recoveryPoll.completion.artifactDeliveryStatus,
          buyerVerificationStatus: recoveryPoll.completion.buyerVerificationStatus,
          buyerAcceptanceStatus: recoveryPoll.completion.buyerAcceptanceStatus,
          sellerReputationImpact: "none_until_delivery_fault_attributed",
          upgradeGuide: upgradeGuideHint(sellerEnvFile)
        }
      : null;
}

function retryResumeFromPaymentState(payload) {
  return isRecord(payload?.retryResume) ? payload.retryResume : {};
}

function paymentStateAllowsSamePayloadRetry(payload) {
  const retryResume = retryResumeFromPaymentState(payload);
  return retryResume.safeToRetrySamePayload === true &&
    retryResume.safeToCreateNewPayment !== true &&
    retryResume.terminal !== true;
}

function paymentStateLookupRequestId(payload) {
  const lookup = isRecord(payload?.lookup) ? payload.lookup : {};
  const execution = isRecord(payload?.execution) ? payload.execution : {};
  const latestLedger = isRecord(payload?.payment?.latestLedger) ? payload.payment.latestLedger : {};
  return stringValue(lookup, "requestId") ||
    stringValue(execution, "requestId") ||
    stringValue(latestLedger, "hireRequestId") ||
    "";
}

function stateUrlFromPaymentState(payload, paymentPayloadDigestSha256) {
  const retryResume = retryResumeFromPaymentState(payload);
  const endpoint = stringValue(retryResume, "stateEndpoint");
  if (endpoint) {
    return endpoint.startsWith("http") ? endpoint : `${apiBase}${endpoint}`;
  }
  const requestId = paymentStateLookupRequestId(payload);
  if (!requestId) {
    return "";
  }
  const query = paymentPayloadDigestSha256
    ? `?${new URLSearchParams({ paymentPayloadDigestSha256 }).toString()}`
    : "";
  return `${apiBase}/api/executions/${encodeURIComponent(requestId)}/state${query}`;
}

function recoveredSummaryFromPaymentState(paymentStatePayload, paymentPayloadDigestSha256) {
  const lifecycle = firstRecord(paymentStatePayload?.protocolLifecycle, paymentStatePayload);
  const buyerAnswer = firstRecord(lifecycle.buyerAnswer, paymentStatePayload?.buyerAnswer);
  const protocolState = stringValue(lifecycle, "protocolState") || stringValue(paymentStatePayload, "protocolState");
  const buyerAction = stringValue(lifecycle, "buyerAction") || stringValue(paymentStatePayload, "buyerAction");
  const sellerOutcome = stringValue(lifecycle, "sellerOutcome") || stringValue(paymentStatePayload, "sellerOutcome");
  const operatorObligation = stringValue(lifecycle, "operatorObligation") || stringValue(paymentStatePayload, "operatorObligation");
  const execution = isRecord(paymentStatePayload?.execution) ? paymentStatePayload.execution : paymentStatePayload;
  const buyerDelivery = buyerDeliveryProjection(execution);
  const buyerDeliveryAvailable = buyerAnswer.hasBuyerDelivery === true || buyerDelivery.buyerDeliveryAvailable;
  if (!buyerDeliveryAvailable || (protocolState !== "DELIVERED_SETTLED" && buyerAction !== "view_delivery")) {
    return null;
  }
  const latestLedger = isRecord(paymentStatePayload?.payment?.latestLedger) ? paymentStatePayload.payment.latestLedger : {};
  const paymentSettled =
    protocolState === "DELIVERED_SETTLED" ||
    ledgerPaymentSettled(latestLedger) ||
    stringValue(paymentStatePayload, "settlementStatus") === "settled";
  const settlementFailed =
    stringValue(paymentStatePayload, "settlementStatus") === "failed" ||
    stringValue(latestLedger, "paymentStatus") === "settlement_failed";
  return {
    ok: true,
    code: paymentSettled
      ? "paid_execution_buyer_complete"
      : "paid_execution_delivery_available_settlement_pending",
    completionMode: paymentSettled
      ? "recovered_from_payment_state"
      : "recovered_delivery_settlement_pending",
    retryable: false,
    nextAction: "view_delivery",
    protocolState,
    buyerAction,
    sellerOutcome: sellerOutcome || "completed",
    operatorObligation: operatorObligation || (paymentSettled ? "none" : "settle_payment"),
    paymentStatus: paymentSettled
      ? "settled"
      : stringValue(latestLedger, "paymentStatus") || stringValue(paymentStatePayload, "paymentStatus") || "authorized",
    settlementStatus: paymentSettled
      ? "settled"
      : settlementFailed
        ? "failed"
        : stringValue(paymentStatePayload, "settlementStatus") || "authorized",
    relayDeliveryStatus: "forwarded",
    agentExecutionStatus: "completed",
    sellerExecutionCompleted: true,
    buyerComplete: true,
    ...buyerDelivery,
    buyerDeliveryAvailable: true,
    sellerReputationImpact: "none",
    requestId: paymentStateLookupRequestId(paymentStatePayload),
    stateUrl: stateUrlFromPaymentState(paymentStatePayload, paymentPayloadDigestSha256)
  };
}

async function enrichRecoveredSummaryFromExecutionState(recovered) {
  if (!recovered?.stateUrl) {
    return { recovered };
  }
  const executionStateResponse = await requestJson(recovered.stateUrl);
  if (!executionStateResponse.ok) {
    return {
      recovered,
      executionStateResponse
    };
  }
  const completion = recoveredCompletionFromState(executionStateResponse.payload);
  if (!completion.buyerDeliveryAvailable) {
    return {
      recovered,
      executionStateResponse
    };
  }
  return {
    recovered: {
      ...recovered,
      paymentStatus: completion.paymentStatus,
      settlementStatus: completion.settlementStatus,
      relayDeliveryStatus: completion.relayDeliveryStatus,
      agentExecutionStatus: completion.agentExecutionStatus,
      proofStatus: completion.proofStatus,
      buyerDeliveryStatus: completion.buyerDeliveryStatus,
      buyerDeliveryAvailable: completion.buyerDeliveryAvailable,
      buyerVisibleOutputCount: completion.buyerVisibleOutputCount,
      inlineOutputCount: completion.inlineOutputCount,
      artifactDeliveryAvailable: completion.artifactDeliveryAvailable,
      artifactDeliveryStatus: completion.artifactDeliveryStatus,
      buyerVerificationStatus: completion.buyerVerificationStatus,
      buyerAcceptanceStatus: completion.buyerAcceptanceStatus
    },
    executionStateResponse
  };
}

function recoveredPaymentStateOutput(input) {
  return {
    ...input.recovered,
    paid: true,
    status: input.paymentStateResponse.status,
    agentId: input.agentId,
    ids: {
      ...input.executionIds,
      ...(input.recovered.requestId
        ? {
            hireRequestId: input.recovered.requestId,
            executionRequestId: input.recovered.requestId
          }
        : {})
    },
    priceUsd: input.priceUsd,
    manifestDir: input.runDir,
    ...(input.paymentPayloadPath ? { paymentPayloadPath: input.paymentPayloadPath } : {}),
    paymentPayloadDigestSha256: input.paymentPayloadDigestSha256,
    stateUrl: input.recovered.stateUrl || input.resultStateUrl,
    paymentStateUrl: input.paymentStateUrl,
    recoveryMode: "payment_state_digest_after_submit_timeout",
    ...(input.buyerOutputPath ? { buyerOutputPath: input.buyerOutputPath } : {}),
    paymentState: input.paymentStateResponse.payload,
    ...(input.executionStateResponse?.ok
      ? { executionState: input.executionStateResponse.payload }
      : input.executionStateResponse
        ? {
            executionStateRecovery: {
              ok: false,
              status: input.executionStateResponse.status,
              payload: input.executionStateResponse.payload
            }
          }
        : {}),
    response: input.response
  };
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

async function pollRecoverablePaymentState(paymentStateUrl, paymentPayloadDigestSha256, maxMs = DEFAULT_RECOVERY_POLL_MS) {
  if (!paymentStateUrl) {
    return { recovered: false, reason: "missing_payment_state_url" };
  }
  const startedAt = Date.now();
  let last = null;
  let attempts = 0;
  while (Date.now() - startedAt <= maxMs) {
    attempts += 1;
    const paymentStateResponse = await requestJson(paymentStateUrl);
    last = paymentStateResponse;
    if (paymentStateResponse.ok) {
      const recovered = recoveredSummaryFromPaymentState(
        paymentStateResponse.payload,
        paymentPayloadDigestSha256
      );
      if (recovered?.ok === true) {
        return {
          recovered: true,
          elapsedMs: Date.now() - startedAt,
          attempts,
          paymentStateResponse,
          recoveredSummary: recovered
        };
      }
    }
    await sleep(RECOVERY_POLL_INTERVAL_MS);
  }
  return {
    recovered: false,
    elapsedMs: Date.now() - startedAt,
    attempts,
    lastStatus: last?.status,
    lastPayload: last?.payload,
    paymentStateResponse: last
  };
}

function writePaymentRecoveryInstructions(input) {
  return writeJson(path.join(input.runDir, "recovery-next-steps.json"), {
    schemaVersion: "santaclawz-buyer-recovery/1.0",
    generatedAtIso: new Date().toISOString(),
    code: input.code,
    paymentPayloadDigestSha256: input.paymentPayloadDigestSha256,
    paymentStateUrl: input.paymentStateUrl,
    ...(input.resultStateUrl ? { resultStateUrl: input.resultStateUrl } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    safety: {
      safeToCreateNewPayment: false,
      safeToRetrySamePaymentPayload: true
    },
    nextAction: "poll_payment_state",
    guidance: "Do not create a fresh payment for this job. Poll payment-state with the saved digest, or retry the same idempotent payment payload after service recovery."
  });
}

async function recoverRetryablePaidSubmitFailure(input) {
  const paymentStatePoll = await pollRecoverablePaymentState(
    input.paymentStateUrl,
    input.paymentPayloadDigestSha256
  );
  const postSubmitPaymentState = paymentStatePoll.paymentStateResponse;
  if (paymentStatePoll.recovered === true && paymentStatePoll.recoveredSummary?.ok === true) {
    const enrichedRecovery = await enrichRecoveredSummaryFromExecutionState(paymentStatePoll.recoveredSummary);
    const buyerOutputPath = enrichedRecovery.executionStateResponse?.ok
      ? writeBuyerOutputFile(input.runDir, enrichedRecovery.executionStateResponse.payload) ||
        writeBuyerOutputFile(input.runDir, postSubmitPaymentState.payload)
      : writeBuyerOutputFile(input.runDir, postSubmitPaymentState.payload);
    const output = recoveredPaymentStateOutput({
      recovered: enrichedRecovery.recovered,
      paymentStateResponse: postSubmitPaymentState,
      executionStateResponse: enrichedRecovery.executionStateResponse,
      agentId: input.agentId,
      executionIds: input.executionIds,
      priceUsd: input.priceUsd,
      runDir: input.runDir,
      paymentPayloadPath: input.paymentPayloadPath,
      paymentPayloadDigestSha256: input.paymentPayloadDigestSha256,
      paymentStateUrl: input.paymentStateUrl,
      resultStateUrl: input.resultStateUrl,
      buyerOutputPath,
      response: input.submit.payload
    });
    return { exitCode: 0, output };
  }

  const recoveryFilePath = writePaymentRecoveryInstructions({
    runDir: input.runDir,
    code: "recovery_pending_state_unknown",
    paymentPayloadDigestSha256: input.paymentPayloadDigestSha256,
    paymentStateUrl: input.paymentStateUrl,
    resultStateUrl: input.resultStateUrl,
    requestId: input.submittedRequestId
  });
  const retryable = createRetryablePlatformFailure(
    input.submit.status,
    input.submit.payload.responsePreview ?? input.submit.payload.error ?? "",
    {
      code: "recovery_pending_state_unknown",
      paymentStatus: "authorized",
      settlementStatus: "unknown",
      relayDeliveryStatus: "not_confirmed",
      agentExecutionStatus: "not_confirmed",
      paymentPayloadDigestSha256: input.paymentPayloadDigestSha256,
      ...(input.submittedRequestId ? { requestId: input.submittedRequestId } : {}),
      paymentStateUrl: input.paymentStateUrl,
      ...(input.resultStateUrl ? { resultStateUrl: input.resultStateUrl } : {}),
      safeToRetrySamePayload: true
    }
  );
  return {
    exitCode: 1,
    output: {
      ...retryable,
      paid: true,
      status: input.submit.status,
      agentId: input.agentId,
      ids: input.executionIds,
      priceUsd: input.priceUsd,
      manifestDir: input.runDir,
      ...(input.paymentPayloadPath ? { paymentPayloadPath: input.paymentPayloadPath } : {}),
      recoveryMode: input.recoveryMode,
      safeNextAction: "poll_payment_state",
      safeToCreateNewPayment: false,
      recoveryFilePath,
      paymentStateRecovery: {
        recovered: false,
        elapsedMs: paymentStatePoll.elapsedMs,
        attempts: paymentStatePoll.attempts,
        lastStatus: paymentStatePoll.lastStatus
      },
      ...(input.existingPaymentState ? { existingPaymentState: input.existingPaymentState } : {}),
      postSubmitPaymentState: postSubmitPaymentState?.payload ?? paymentStatePoll.lastPayload,
      response: input.submit.payload
    }
  };
}

function runSellerReadiness(args, apiBase) {
  const sellerEnvFile = String(args["seller-env-file"] ?? "").trim();
  if (!sellerEnvFile) {
    return {
      ok: false,
      code: "seller_env_required",
      message: "--activate-if-needed requires --seller-env-file so the buyer tool can run the seller paid-execution probe."
    };
  }
  const childArgs = ["scripts/seller-ready.mjs", "--env-file", sellerEnvFile, "--api-base", apiBase, "--json"];
  if (args["local-hire-url"]) childArgs.push("--local-hire-url", String(args["local-hire-url"]));
  childArgs.push("--allow-incomplete");
  const result = spawnSync(process.execPath, childArgs, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8"
  });
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    payload = null;
  }
  return {
    ok: result.status === 0 && Boolean(payload?.paidExecutionProven ?? payload?.checks?.paidExecutionProven ?? payload?.hireable),
    status: result.status,
    readiness: payload,
    stderr: result.stderr.trim()
  };
}

function nextCommandBase(args, agentId, taskPrompt) {
  return [
    "pnpm buyer:buy-once --",
    `--agent ${JSON.stringify(agentId)}`,
    `--prompt ${JSON.stringify(taskPrompt)}`,
    ...stringListFromArg(args.url).map((url) => `--url ${JSON.stringify(url)}`),
    ...(args["job-context-file"] ? [`--job-context-file ${JSON.stringify(String(args["job-context-file"]))}`] : []),
    ...(args["job-context-json"] ? [`--job-context-json ${JSON.stringify(String(args["job-context-json"]))}`] : []),
    ...(args["activation-probe"] || args["paid-activation-probe"] ? ["--activation-probe"] : []),
    `--max-usd ${JSON.stringify(String(args["max-usd"]))}`
  ].join(" ");
}

function normalizeBuyerApiBase(value) {
  const normalized = normalizeBaseUrl(value);
  try {
    const url = new URL(normalized);
    if (
      url.hostname === "santaclawz.ai" ||
      url.hostname === "www.santaclawz.ai" ||
      url.hostname === "santaclawz-web.vercel.app"
    ) {
      return "https://api.santaclawz.ai";
    }
  } catch {
    return normalized;
  }
  return normalized;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}

const apiBase = normalizeBuyerApiBase(String(args["api-base"] ?? process.env.CLAWZ_API_BASE ?? "https://api.santaclawz.ai").trim());
const agentId = parseAgentId(args.agent ?? args["agent-id"] ?? args["hire-url"]);
const taskPrompt = String(args.prompt ?? args.task ?? "").trim();
const requesterContact = String(args["requester-contact"] ?? "buyer-agent:local").trim();
const jobContext = buildJobContext(args);
const sellerReadinessTestRequested = Boolean(args["seller-readiness-test"] || args["seller-test"]);
const activationProbeRequested = Boolean(args["activation-probe"] || args["paid-activation-probe"] || sellerReadinessTestRequested);
const maxUsd = decimalStringToNumber(args["max-usd"]);
const outputDir = String(args["output-dir"] ?? DEFAULT_OUTPUT_DIR).trim();
const dryRun = Boolean(args["dry-run"]) || !args["allow-real-money"];
if (!agentId) throw new Error("--agent or --agent-id is required.");
if (!taskPrompt) throw new Error("--prompt or --task is required.");
if (maxUsd === null) throw new Error("--max-usd is required and must be a number.");
if (taskPrompt.length > HIRE_TASK_PROMPT_MAX_LENGTH) {
  throw new Error(`--prompt is ${taskPrompt.length} characters; fixed-price hire requests currently allow ${HIRE_TASK_PROMPT_MAX_LENGTH}. Use quote/procurement/workspace for longer specs.`);
}
if (requesterContact.length > HIRE_REQUESTER_CONTACT_MAX_LENGTH) {
  throw new Error(`--requester-contact is ${requesterContact.length} characters; SantaClawz allows ${HIRE_REQUESTER_CONTACT_MAX_LENGTH}.`);
}

const runId = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${agentId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48)}`;
const runDir = path.join(outputDir, runId);
const hireUrl = `${apiBase}/api/agents/${encodeURIComponent(agentId)}/hire`;
const planUrl = `${apiBase}/api/agents/${encodeURIComponent(agentId)}/x402-plan`;
const suppliedPaymentPayloadPath = args["payment-payload-file"] ? String(args["payment-payload-file"]) : null;
const suppliedPaymentPayload = suppliedPaymentPayloadPath
  ? normalizePaymentPayloadFromFile(readJsonFile(suppliedPaymentPayloadPath, "payment payload"), {
      service: typeof args.service === "string" ? args.service : ""
    })
  : null;
const suppliedPaymentPayloadDigestSha256 = suppliedPaymentPayload ? digestJson(suppliedPaymentPayload) : "";
const suppliedPaymentStateUrl = suppliedPaymentPayloadDigestSha256
  ? `${apiBase}/api/x402/payment-state?paymentPayloadDigestSha256=${suppliedPaymentPayloadDigestSha256}`
  : "";
let suppliedPaymentState = null;

const planResponse = await requestJson(planUrl);
if (!planResponse.ok) {
  if (suppliedPaymentPayload && !dryRun) {
    suppliedPaymentState = await requestJson(suppliedPaymentStateUrl);
  }
  if (suppliedPaymentPayload && !dryRun && paymentStateAllowsSamePayloadRetry(suppliedPaymentState?.payload)) {
    const submitBody = {
      taskPrompt,
      requesterContact,
      ...(sellerReadinessTestRequested ? { sellerReadinessTest: true } : activationProbeRequested ? { activationProbe: true } : {}),
      ...(jobContext ? { jobContext } : {}),
      paymentPayload: suppliedPaymentPayload
    };
    const submit = await paidSubmitJson(hireUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(submitBody)
    });
    const submittedRequestId =
      submit.payload?.requestId ??
      submit.payload?.paidExecution?.requestId ??
      null;
    const x402RequestId = suppliedPaymentPayload.requestId ?? null;
    const submittedHireRequestId =
      submit.payload?.paidExecution?.requestId ??
      submit.payload?.hireRequestId ??
      (typeof submittedRequestId === "string" && submittedRequestId.startsWith("hire_") ? submittedRequestId : null);
    const fallbackResultStateUrl = submittedRequestId
      ? `${apiBase}/api/executions/${encodeURIComponent(submittedRequestId)}/state`
      : null;
    const resultStateUrl = stateUrlFromSubmitPayload(submit.payload, fallbackResultStateUrl);
    const executionIds = {
      ...(x402RequestId ? { x402RequestId } : {}),
      ...(submittedHireRequestId ? { hireRequestId: submittedHireRequestId, executionRequestId: submittedHireRequestId } : {}),
      ...(submittedRequestId ? { submittedRequestId } : {}),
      paymentPayloadDigestSha256: suppliedPaymentPayloadDigestSha256
    };
    if (!submit.ok && submit.payload?.retryable === true) {
      const recovery = await recoverRetryablePaidSubmitFailure({
        submit,
        agentId,
        executionIds,
        priceUsd: null,
        runDir,
        paymentPayloadPath: suppliedPaymentPayloadPath,
        paymentPayloadDigestSha256: suppliedPaymentPayloadDigestSha256,
        paymentStateUrl: suppliedPaymentStateUrl,
        resultStateUrl,
        submittedRequestId,
        existingPaymentState: suppliedPaymentState?.payload,
        recoveryMode: "same_payment_payload_without_plan"
      });
      const output = recovery.output;
      writeJson(path.join(runDir, "buyer-run.json"), output);
      console.log(JSON.stringify(output, null, 2));
      process.exitCode = recovery.exitCode;
      process.exit();
    }
    const summary = paidExecutionSummary(submit.ok, submit.payload);
    const recoveryPoll = summary.code === "job_running_or_return_timeout"
      ? await pollRecoverableExecutionState(resultStateUrl)
      : null;
    const recoveredSummary = recoveredSummaryFromRecoveryPoll(recoveryPoll, args["seller-env-file"] ?? ".env.santaclawz");
    const buyerOutputPath = writeBuyerOutputFile(runDir, submit.payload);
    const output = {
      ...(recoveredSummary ?? summary),
      paid: true,
      status: submit.status,
      agentId,
      priceUsd: null,
      paymentPayloadDigestSha256: suppliedPaymentPayloadDigestSha256,
      requestId: submittedRequestId,
      ids: executionIds,
      stateUrl: resultStateUrl,
      paymentStateUrl: suppliedPaymentStateUrl,
      manifestDir: runDir,
      paymentPayloadPath: suppliedPaymentPayloadPath,
      ...(buyerOutputPath ? { buyerOutputPath } : {}),
      recoveryMode: "same_payment_payload_without_plan",
      recoveryReason: "x402_plan_unavailable_existing_payload_retry_safe",
      existingPaymentState: suppliedPaymentState.payload,
      ...(recoveryPoll ? { recoveryPoll } : {}),
      response: submit.payload
    };
    writeJson(path.join(runDir, "buyer-run.json"), output);
    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) {
      process.exitCode = 1;
    }
    process.exit();
  }
  const output = {
    ok: false,
    code: "x402_plan_unavailable",
    agentId,
    status: planResponse.status,
    ...(suppliedPaymentPayloadDigestSha256
      ? {
          paymentPayloadDigestSha256: suppliedPaymentPayloadDigestSha256,
          paymentStateUrl: suppliedPaymentStateUrl,
          existingPaymentState: suppliedPaymentState?.payload ?? null,
          safeToRetrySamePayload: paymentStateAllowsSamePayloadRetry(suppliedPaymentState?.payload)
        }
      : {}),
    response: planResponse.payload
  };
  writeJson(path.join(runDir, "buyer-run.json"), output);
  console.log(JSON.stringify(output, null, 2));
  process.exit(1);
}

const missingContext = activationProbeRequested
  ? []
  : missingContextRequirements(planResponse.payload?.contextRequirements, jobContext);
if (missingContext.length > 0) {
  const output = {
    ok: false,
    code: "missing_required_input",
    message: "Seller requires structured buyer context before payment. Add --url, --job-context-json, or --job-context-file and retry.",
    agentId,
    hireUrl,
    planUrl,
    requesterContact,
    prompt: taskPrompt,
    maxUsd,
    manifestDir: runDir,
    contextRequirements: planResponse.payload.contextRequirements,
    missingRequirements: missingContext,
    jobContextShape: {
      urls: ["https://example.com/source-or-reference"],
      text: "Plain text input that does not fit in taskPrompt.",
      attachments: [{ kind: "document", url: "https://example.com/input.pdf", digestSha256: "optional sha256 digest" }],
      structuredData: { key: "value" }
    }
  };
  writeJson(path.join(runDir, "buyer-run.json"), output);
  console.log(JSON.stringify(output, null, 2));
  process.exit(1);
}

async function preflightHire() {
  const body = {
    taskPrompt,
    requesterContact,
    ...(sellerReadinessTestRequested ? { sellerReadinessTest: true } : activationProbeRequested ? { activationProbe: true } : {}),
    ...(jobContext ? { jobContext } : {})
  };
  const requestBodyBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (requestBodyBytes > HIRE_REQUEST_BODY_MAX_BYTES) {
    throw new Error(`Fixed-price hire request body is ${requestBodyBytes} bytes; SantaClawz allows ${HIRE_REQUEST_BODY_MAX_BYTES}.`);
  }
  return requestJson(hireUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

let preflight = await preflightHire();
let activationProbe = null;
if (preflight.status === 409 && preflight.payload?.code === "paid_execution_probe_required" && args["activate-if-needed"]) {
  activationProbe = runSellerReadiness(args, apiBase);
  if (activationProbe.ok) {
    preflight = await preflightHire();
  }
}

const paymentRequirement = findPaymentRequirement(preflight.payload);
const accept = paymentRequirement ? firstX402Accept(paymentRequirement) : firstX402Accept(preflight.payload);
const priceUsd = priceUsdFromSources(planResponse.payload, paymentRequirement, accept);
const baseOutput = {
  agentId,
  hireUrl,
  planUrl,
  requesterContact,
  prompt: taskPrompt,
  ...(jobContext ? { jobContext } : {}),
  ...(sellerReadinessTestRequested ? { sellerReadinessTest: true } : activationProbeRequested ? { activationProbe: true } : {}),
  maxUsd,
  priceUsd: priceUsd === null ? null : formatUsd(priceUsd),
  pricingMode: planResponse.payload?.pricingMode ?? planResponse.payload?.paymentProfile?.pricingMode ?? "unknown",
  preflightStatus: preflight.status,
  manifestDir: runDir,
  upgradeGuide: upgradeGuideHint(args["seller-env-file"] ?? ".env.santaclawz"),
  ...(activationProbe ? { activationProbe } : {})
};

if (priceUsd !== null && priceUsd > maxUsd) {
  const output = {
    ok: false,
    code: "price_exceeds_max_usd",
    message: `Seller price ${formatUsd(priceUsd)} exceeds local max ${formatUsd(maxUsd)}.`,
    ...baseOutput
  };
  writeJson(path.join(runDir, "buyer-run.json"), output);
  console.log(JSON.stringify(output, null, 2));
  process.exit(1);
}

if (preflight.status === 409 && preflight.payload?.code === "paid_execution_probe_required") {
  const output = {
    ok: false,
    code: "paid_execution_probe_required",
    message: "Seller is payment-ready, but paid execution is not proven yet.",
    nextCommand: args["seller-env-file"]
      ? `${nextCommandBase(args, agentId, taskPrompt)} --activate-if-needed --seller-env-file ${JSON.stringify(String(args["seller-env-file"]))}`
      : `${nextCommandBase({ ...args, "activation-probe": true }, agentId, taskPrompt)} --wallet-env ./buyer.env --allow-real-money`,
    sellerOperatorCommand: "pnpm seller:ready -- --env-file .env.santaclawz --json",
    ...baseOutput,
    response: preflight.payload
  };
  writeJson(path.join(runDir, "buyer-run.json"), output);
  console.log(JSON.stringify(output, null, 2));
  process.exit(1);
}

if (!paymentRequirement || !accept) {
  const code = preflight.payload?.requestType === "quote_intake" || preflight.payload?.pricingMode === "quote-required"
    ? "seller_requires_quote"
    : "payment_requirement_not_found";
  const output = {
    ok: false,
    code,
    message: code === "seller_requires_quote"
      ? "Seller is quote-required. Use procurement/quote flow, then pay the accepted quote."
      : "Preflight did not return a fixed-price x402 payment requirement.",
    ...baseOutput,
    response: preflight.payload
  };
  writeJson(path.join(runDir, "buyer-run.json"), output);
  console.log(JSON.stringify(output, null, 2));
  process.exit(1);
}

const requirementPath = String(args["payment-requirement-out"] ?? path.join(runDir, "payment-requirement.json"));
writeJson(requirementPath, paymentRequirement);
writeJson(path.join(runDir, "preflight.json"), {
  ...baseOutput,
  paymentRequirement,
  response: preflight.payload
});

if (dryRun) {
  const output = {
    ok: true,
    paid: false,
    dryRun: true,
    code: "payment_required",
    message: "Fixed-price x402 requirement found. No payment was signed or submitted.",
    paymentRequirementFound: true,
    paymentRequirementPath: requirementPath,
    nextCommand: `${nextCommandBase(args, agentId, taskPrompt)} --wallet-env ./buyer.env --allow-real-money`,
    ...baseOutput
  };
  writeJson(path.join(runDir, "buyer-run.json"), output);
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

let paymentPayload = suppliedPaymentPayload;
let paymentPayloadPath = suppliedPaymentPayloadPath;
if (!paymentPayload && args["wallet-env"]) {
  const privateKey = buyerPrivateKeyFromEnv(String(args["wallet-env"]));
  const account = privateKeyToAccount(privateKey);
  paymentPayload = await buildFeeSplitPaymentPayload({
    paymentRequirement,
    sessionId: String(paymentRequirement.sessionId ?? planResponse.payload?.sessionId ?? ""),
    payer: account.address,
    account
  });
  paymentPayloadPath = writeJson(path.join(runDir, "payment-payload.json"), paymentPayload);
}
if (!paymentPayload) {
  const output = {
    ok: false,
    code: "signed_payment_payload_required",
    message: "--allow-real-money requires either --wallet-env to sign once or --payment-payload-file to submit a pre-signed payload.",
    paymentRequirementPath: requirementPath,
    ...baseOutput
  };
  writeJson(path.join(runDir, "buyer-run.json"), output);
  console.log(JSON.stringify(output, null, 2));
  process.exit(1);
}

const validation = validatePaymentPayload({ paymentRequirement, paymentPayload });
if (!validation.ok) {
  const output = {
    ok: false,
    code: "invalid_payment_payload",
    message: "Signed x402 payment payload does not match the fixed-price requirement.",
    validation,
    paymentRequirementPath: requirementPath,
    ...baseOutput
  };
  writeJson(path.join(runDir, "buyer-run.json"), output);
  console.log(JSON.stringify(output, null, 2));
  process.exit(1);
}

const submitBody = {
  taskPrompt,
  requesterContact,
  ...(sellerReadinessTestRequested ? { sellerReadinessTest: true } : activationProbeRequested ? { activationProbe: true } : {}),
  ...(jobContext ? { jobContext } : {}),
  paymentPayload
};
const submit = await paidSubmitJson(hireUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(submitBody)
});
const paymentPayloadDigestSha256 = digestJson(paymentPayload);
const submittedRequestId =
  submit.payload?.requestId ??
  submit.payload?.paidExecution?.requestId ??
  null;
const x402RequestId = paymentRequirement.requestId ?? paymentPayload.requestId ?? null;
const submittedHireRequestId =
  submit.payload?.paidExecution?.requestId ??
  submit.payload?.hireRequestId ??
  (typeof submittedRequestId === "string" && submittedRequestId.startsWith("hire_") ? submittedRequestId : null);
const paymentStateUrl = `${apiBase}/api/x402/payment-state?paymentPayloadDigestSha256=${paymentPayloadDigestSha256}`;
const fallbackResultStateUrl = submittedRequestId
  ? `${apiBase}/api/executions/${encodeURIComponent(submittedRequestId)}/state`
  : null;
const resultStateUrl = stateUrlFromSubmitPayload(submit.payload, fallbackResultStateUrl);
const executionIds = {
  ...(x402RequestId ? { x402RequestId } : {}),
  ...(submittedHireRequestId ? { hireRequestId: submittedHireRequestId, executionRequestId: submittedHireRequestId } : {}),
  ...(submittedRequestId ? { submittedRequestId } : {}),
  paymentPayloadDigestSha256
};
if (!submit.ok && submit.payload?.retryable === true) {
  const recovery = await recoverRetryablePaidSubmitFailure({
    submit,
    agentId,
    executionIds,
    priceUsd: baseOutput.priceUsd,
    runDir,
    paymentPayloadPath,
    paymentPayloadDigestSha256,
    paymentStateUrl,
    resultStateUrl,
    submittedRequestId,
    recoveryMode: "payment_state_digest_after_submit_timeout"
  });
  const output = recovery.output;
  writeJson(path.join(runDir, "buyer-run.json"), output);
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = recovery.exitCode;
  process.exit();
}
const summary = paidExecutionSummary(submit.ok, submit.payload);
const recoveryPoll = summary.code === "job_running_or_return_timeout"
  ? await pollRecoverableExecutionState(resultStateUrl)
  : null;
const recoveredSummary = recoveredSummaryFromRecoveryPoll(recoveryPoll, args["seller-env-file"] ?? ".env.santaclawz");
const buyerOutputPath = writeBuyerOutputFile(runDir, submit.payload);
const output = {
  ...(recoveredSummary ?? summary),
  paid: true,
  status: submit.status,
  agentId,
  priceUsd: baseOutput.priceUsd,
  paymentPayloadDigestSha256,
  requestId: submittedRequestId,
  ids: executionIds,
  stateUrl: resultStateUrl,
  paymentStateUrl,
  manifestDir: runDir,
  ...(buyerOutputPath ? { buyerOutputPath } : {}),
  ...(recoveryPoll ? { recoveryPoll } : {}),
  response: submit.payload
};
writeJson(path.join(runDir, "buyer-run.json"), output);
console.log(JSON.stringify(output, null, 2));
if (!output.ok) {
  process.exitCode = 1;
}
