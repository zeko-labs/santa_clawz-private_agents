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

const BOOLEAN_FLAGS = new Set(["help", "allow-real-money", "json", "dry-run", "activate-if-needed"]);
const HIRE_TASK_PROMPT_MAX_LENGTH = 2000;
const HIRE_REQUESTER_CONTACT_MAX_LENGTH = 240;
const HIRE_REQUEST_BODY_MAX_BYTES = 32 * 1024;
const DEFAULT_OUTPUT_DIR = ".clawz-data/buyer-runs";
const DEFAULT_RECOVERY_POLL_MS = 120_000;
const RECOVERY_POLL_INTERVAL_MS = 3_000;

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
  --requester-contact buyer-agent:local
  --max-usd 1.00                     Required local budget guard.
  --wallet-env ./buyer.env           Env file containing BUYER_PRIVATE_KEY, BUYER_BASE_PRIVATE_KEY, or X402_BUYER_PRIVATE_KEY.
  --payment-payload-file ./payload.json
  --service agent_job_pack           Service key when payload file contains multiple payloads.
  --output-dir .clawz-data/buyer-runs
  --payment-requirement-out ./requirement.json
  --activate-if-needed               If seller env is provided, run seller readiness/probe before retrying preflight.
  --seller-env-file .env.santaclawz  Seller env for --activate-if-needed.
  --local-hire-url http://127.0.0.1:8797/hire
  --dry-run                          Force dry-run even when --allow-real-money is present.
  --allow-real-money                 Required before signing/submitting a paid payload.
  --json
`);
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
    args[key] = value;
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

async function requestJson(url, init = {}) {
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (!isRetryablePlatformTransportError(error)) throw error;
    return {
      ok: false,
      status: 0,
      payload: createRetryablePlatformFailure(0, error instanceof Error ? error.message : String(error), {
        code: "platform_unavailable_retryable",
        operation: init.method ?? "GET"
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
          operation: init.method ?? "GET"
        })
      : { error: text.slice(0, 1000) };
  }
  return { ok: response.ok, status: response.status, payload };
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
  const jobCompleted =
    workCompleted &&
    (settlementStatus === "settled" || settlementStatus === "authorized" || settlementStatus === "not_required");
  const acceptedPendingResult =
    responseOk &&
    relayDeliveryStatus === "acknowledged" &&
    agentExecutionStatus === "running_or_unknown";
  return {
    ok: jobCompleted,
    code: jobCompleted
      ? "paid_execution_completed"
      : acceptedPendingResult
        ? "job_running_or_return_timeout"
        : "paid_execution_not_completed",
    paymentStatus: paymentStatus || "unknown",
    settlementStatus,
    relayDeliveryStatus,
    agentExecutionStatus,
    completionMode: jobCompleted ? (settlementStatus === "settled" ? "inline_settled" : "inline_return_verified") : "none",
    retryable: paymentAccepted && agentExecutionStatus !== "completed",
    nextAction: jobCompleted ? "none" : acceptedPendingResult ? "poll_state_or_resume_same_payment" : "inspect_payment_or_execution_state",
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
  if (typeof payload?.stateUrl === "string" && payload.stateUrl.trim()) {
    return payload.stateUrl.trim();
  }
  const statePath = payload?.paidExecution?.jobWorkspace?.statePath;
  if (typeof statePath === "string" && statePath.trim()) {
    return statePath.startsWith("http") ? statePath : `${apiBase}${statePath}`;
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
  const failed = checks.failed === true;
  const completed =
    !failed &&
    (
      currentPhase === "return_verified" ||
      currentPhase === "artifact_delivered" ||
      currentPhase === "buyer_verified" ||
      currentPhase === "buyer_accepted" ||
      (
        agentExecutionStatus === "completed" &&
        ["forwarded", "recorded", "reconciled_completed"].includes(relayDeliveryStatus) &&
        (proofStatus === "return_validated" || proofStatus === "anchored_or_attested")
      )
    );
  return {
    completed,
    failed,
    currentPhase,
    paymentStatus: typeof lifecycle.paymentStatus === "string" ? lifecycle.paymentStatus : "unknown",
    settlementStatus: typeof lifecycle.settlementStatus === "string" ? lifecycle.settlementStatus : "unknown",
    relayDeliveryStatus: relayDeliveryStatus || "unknown",
    agentExecutionStatus: agentExecutionStatus || "unknown",
    proofStatus: proofStatus || "unknown",
    artifactDeliveryStatus: typeof lifecycle.artifactDeliveryStatus === "string" ? lifecycle.artifactDeliveryStatus : "unknown"
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

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return filePath;
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
    `--max-usd ${JSON.stringify(String(args["max-usd"]))}`
  ].join(" ");
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}

const apiBase = normalizeBaseUrl(String(args["api-base"] ?? process.env.CLAWZ_API_BASE ?? "https://api.santaclawz.ai").trim());
const agentId = parseAgentId(args.agent ?? args["agent-id"] ?? args["hire-url"]);
const taskPrompt = String(args.prompt ?? args.task ?? "").trim();
const requesterContact = String(args["requester-contact"] ?? "buyer-agent:local").trim();
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

const planResponse = await requestJson(planUrl);
if (!planResponse.ok) {
  const output = {
    ok: false,
    code: "x402_plan_unavailable",
    agentId,
    status: planResponse.status,
    response: planResponse.payload
  };
  writeJson(path.join(runDir, "buyer-run.json"), output);
  console.log(JSON.stringify(output, null, 2));
  process.exit(1);
}

async function preflightHire() {
  const body = {
    taskPrompt,
    requesterContact
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
  maxUsd,
  priceUsd: priceUsd === null ? null : formatUsd(priceUsd),
  pricingMode: planResponse.payload?.pricingMode ?? planResponse.payload?.paymentProfile?.pricingMode ?? "unknown",
  preflightStatus: preflight.status,
  manifestDir: runDir,
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
      : "Ask the seller/operator to run: pnpm seller:ready -- --env-file .env.santaclawz --json",
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

let paymentPayload = null;
if (args["payment-payload-file"]) {
  paymentPayload = normalizePaymentPayloadFromFile(readJsonFile(String(args["payment-payload-file"]), "payment payload"), {
    service: typeof args.service === "string" ? args.service : ""
  });
} else if (args["wallet-env"]) {
  const privateKey = buyerPrivateKeyFromEnv(String(args["wallet-env"]));
  const account = privateKeyToAccount(privateKey);
  paymentPayload = await buildFeeSplitPaymentPayload({
    paymentRequirement,
    sessionId: String(paymentRequirement.sessionId ?? planResponse.payload?.sessionId ?? ""),
    payer: account.address,
    account
  });
  writeJson(path.join(runDir, "payment-payload.json"), paymentPayload);
} else {
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
  paymentPayload
};
const submit = await requestJson(hireUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(submitBody)
});
const paymentPayloadDigestSha256 = digestJson(paymentPayload);
const submittedRequestId =
  submit.payload?.requestId ??
  submit.payload?.paidExecution?.requestId ??
  paymentPayload.requestId ??
  paymentRequirement.requestId ??
  null;
const paymentStateUrl = `${apiBase}/api/x402/payment-state?paymentPayloadDigestSha256=${paymentPayloadDigestSha256}`;
const fallbackResultStateUrl = submittedRequestId
  ? `${apiBase}/api/executions/${encodeURIComponent(submittedRequestId)}/state`
  : null;
const resultStateUrl = stateUrlFromSubmitPayload(submit.payload, fallbackResultStateUrl);
if (!submit.ok && submit.payload?.retryable === true) {
  const retryable = createRetryablePlatformFailure(submit.status, submit.payload.responsePreview ?? submit.payload.error ?? "", {
    code: "post_payment_state_unavailable_retryable",
    paymentStatus: "authorized",
    settlementStatus: "unknown",
    relayDeliveryStatus: "not_confirmed",
    agentExecutionStatus: "not_confirmed",
    paymentPayloadDigestSha256,
    ...(submittedRequestId ? { requestId: submittedRequestId } : {}),
    paymentStateUrl,
    ...(resultStateUrl ? { resultStateUrl } : {}),
    safeToRetrySamePayload: true
  });
  const output = {
    ...retryable,
    paid: true,
    status: submit.status,
    agentId,
    priceUsd: baseOutput.priceUsd,
    manifestDir: runDir,
    response: submit.payload
  };
  writeJson(path.join(runDir, "buyer-run.json"), output);
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = 1;
  process.exit();
}
const summary = paidExecutionSummary(submit.ok, submit.payload);
const recoveryPoll = summary.code === "job_running_or_return_timeout"
  ? await pollRecoverableExecutionState(resultStateUrl)
  : null;
const recoveredSummary = recoveryPoll?.recovered
  ? {
      ok: true,
      code: "paid_execution_recovered",
      completionMode: "recovered_return_verified",
      retryable: false,
      nextAction: "none",
      paymentStatus: recoveryPoll.completion.paymentStatus,
      settlementStatus: recoveryPoll.completion.settlementStatus,
      relayDeliveryStatus: recoveryPoll.completion.relayDeliveryStatus,
      agentExecutionStatus: recoveryPoll.completion.agentExecutionStatus,
      proofStatus: recoveryPoll.completion.proofStatus,
      artifactDeliveryStatus: recoveryPoll.completion.artifactDeliveryStatus
    }
  : null;
const output = {
  ...(recoveredSummary ?? summary),
  paid: true,
  status: submit.status,
  agentId,
  priceUsd: baseOutput.priceUsd,
  paymentPayloadDigestSha256,
  requestId: submittedRequestId,
  stateUrl: resultStateUrl,
  paymentStateUrl,
  manifestDir: runDir,
  ...(recoveryPoll ? { recoveryPoll } : {}),
  response: submit.payload
};
writeJson(path.join(runDir, "buyer-run.json"), output);
console.log(JSON.stringify(output, null, 2));
if (!output.ok) {
  process.exitCode = 1;
}
