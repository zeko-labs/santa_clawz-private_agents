import { useEffect, useMemo, useState } from "react";

import type { AgentMarketplaceTagStat, AgentRegistryEntry, MarketplaceWorkTags } from "@clawz/protocol";

import {
  ApiError,
  createBuyerRouterPlan,
  createProcurementIntent,
  submitHireRequest,
  type BuyerRouterPlanResponse,
  type ProcurementIntentResponse
} from "./api.js";

type BuyerPersona = "human" | "agent";
type RoutingMode = "direct-hire" | "quote-request" | "procurement-bid" | "paid-execution";
type ValueEvent = { target: { value: string } };

type BuyerWorkroomProps = {
  agents: AgentRegistryEntry[];
  buyerGuideUrl: string;
  onOpenAgent(agentId: string): void;
};

type RouteRule = {
  patterns: RegExp[];
  jobTags?: string[];
  capabilityTags?: string[];
  inputTags?: string[];
  outputTags?: string[];
};

type CandidateAgent = {
  agent: AgentRegistryEntry;
  score: number;
  reasons: string[];
  provenTags: AgentMarketplaceTagStat[];
};

type ChatMessage = {
  id: string;
  role: "buyer" | "router";
  body: string;
};

type Eip1193Provider = {
  request<T = unknown>(input: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<T>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
};

type WalletState = {
  address: string;
  chainId: string;
  status: "disconnected" | "connected" | "wrong-network";
};

type PaymentUiState = {
  status: "idle" | "connecting" | "requesting" | "signing" | "submitting" | "quoted" | "completed" | "pending" | "error";
  message: string;
  requestId?: string;
  paymentDigest?: string;
  transactionHashes?: string[];
  paymentStateUrl?: string;
  proofDigest?: string;
};

type RoutingPlan = {
  schemaVersion: "santaclawz-routing-plan/1.0";
  intelligenceSource?: string;
  routerAgentId?: string;
  generatedAtIso?: string;
  buyerMode: BuyerPersona;
  routingIntent: RoutingMode;
  marketplaceTags: MarketplaceWorkTags;
  protocolLaneTags: string[];
  deliveryFormatTags: string[];
  candidateAgents: Array<{
    agentId: string;
    agentName: string;
    matchScore: number;
    matchReasons: string[];
  }>;
  recommendedNextAction: string;
  warnings?: string[];
  routePlanDigestSha256?: string;
};

const BUYER_PERSONA_COOKIE = "santaclawz_buyer_persona";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const STARTER_AGENT_ID = "agent_job_pack";
const BASE_CHAIN_ID_HEX = "0x2105";
const BASE_CHAIN_ID_DECIMAL = 8453;
const BASE_BLOCK_EXPLORER_TX = "https://basescan.org/tx/";

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortAddress(value: string) {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function randomNonceHex() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function stringField(source: Record<string, unknown>, key: string, context: string) {
  const value = source[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context}.${key} is required.`);
  }
  return value;
}

function findFeeSplitAccept(paymentRequirement: Record<string, unknown>) {
  const accepts = Array.isArray(paymentRequirement.accepts) ? paymentRequirement.accepts : [];
  const accept = accepts.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.settlementModel === "x402-exact-evm-fee-split-v1"
  );
  if (!accept) {
    throw new Error("This browser buyer flow currently supports SantaClawz hosted Base fee-split payments only.");
  }
  const evm = isRecord(accept.extensions) && isRecord(accept.extensions.evm) ? accept.extensions.evm : undefined;
  const feeSplit = evm && isRecord(evm.feeSplit) ? evm.feeSplit : undefined;
  if (!evm || !feeSplit) {
    throw new Error("The payment requirement is missing Base fee-split metadata.");
  }
  return { accept, evm, feeSplit };
}

function buildReceiveWithAuthorizationTypedData(input: {
  evm: Record<string, unknown>;
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}) {
  return {
    domain: {
      name: typeof input.evm.eip712Name === "string" ? input.evm.eip712Name : "USD Coin",
      version: typeof input.evm.assetVersion === "string" ? input.evm.assetVersion : "2",
      chainId: Number(input.evm.chainId ?? BASE_CHAIN_ID_DECIMAL),
      verifyingContract: stringField(input.evm, "assetAddress", "extensions.evm")
    },
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" }
      ]
    },
    primaryType: "ReceiveWithAuthorization",
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

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => {
    return `${JSON.stringify(key)}:${stableJsonStringify((value as Record<string, unknown>)[key])}`;
  }).join(",")}}`;
}

function simpleBrowserHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function sha256Hex(value: unknown) {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : stableJsonStringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function paymentContextDigest(payload: Record<string, unknown>) {
  return sha256Hex({
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
    issuedAtIso: payload.issuedAtIso,
    expiresAtIso: payload.expiresAtIso,
    ...(isRecord(payload.extensions) ? { extensions: payload.extensions } : {})
  });
}

async function authorizationDigest(payload: Record<string, unknown>) {
  const { x402Version: _x402Version, ...digestPayload } = payload;
  return sha256Hex(digestPayload);
}

function buildEip3009Authorization(input: {
  accept: Record<string, unknown>;
  evm: Record<string, unknown>;
  typedData: ReturnType<typeof buildReceiveWithAuthorizationTypedData>;
  signature: string;
}) {
  return {
    primitive: "evm-eip3009-receive-with-authorization",
    settlementRail: "evm",
    network: input.accept.network,
    asset: input.accept.asset,
    transferMethod: "EIP-3009",
    facilitator: input.evm.facilitatorUrl ?? input.evm.defaultFacilitator ?? null,
    typedData: input.typedData,
    signature: input.signature
  };
}

function feeSplitAssetAddress(input: { accept: Record<string, unknown>; evm: Record<string, unknown> }) {
  const asset = input.accept.asset;
  if (isRecord(asset) && typeof asset.address === "string" && asset.address.trim().length > 0) {
    return asset.address;
  }
  return stringField(input.evm, "assetAddress", "extensions.evm");
}

function paymentRequirementSessionId(paymentRequirement: Record<string, unknown>) {
  if (typeof paymentRequirement.sessionId === "string") {
    return paymentRequirement.sessionId;
  }
  if (isRecord(paymentRequirement.extensions) && typeof paymentRequirement.extensions.sessionId === "string") {
    return paymentRequirement.extensions.sessionId;
  }
  return "";
}

async function buildBrowserFeeSplitPaymentPayload(input: {
  paymentRequirement: Record<string, unknown>;
  payer: string;
  signTypedData(typedData: ReturnType<typeof buildReceiveWithAuthorizationTypedData>): Promise<string>;
}) {
  const { accept, evm, feeSplit } = findFeeSplitAccept(input.paymentRequirement);
  const issuedAtIso = new Date().toISOString();
  const expiresAtIso = new Date(Date.parse(issuedAtIso) + 15 * 60 * 1000).toISOString();
  const validAfter = String(Math.floor(Date.parse(issuedAtIso) / 1000));
  const validBefore = String(Math.floor(Date.parse(expiresAtIso) / 1000));
  const sellerPayTo = stringField(feeSplit, "sellerPayTo", "feeSplit");
  const protocolFeePayTo = stringField(feeSplit, "protocolFeePayTo", "feeSplit");
  const sellerAmount = stringField(feeSplit, "sellerAmount", "feeSplit");
  const protocolFeeAmount = stringField(feeSplit, "protocolFeeAmount", "feeSplit");
  const grossAmount = typeof accept.amount === "string" && accept.amount.trim() ? accept.amount : stringField(accept, "price", "accept");
  const assetAddress = feeSplitAssetAddress({ accept, evm });
  const amountUnit = isRecord(accept.extensions) && isRecord(accept.extensions.evm) && accept.extensions.evm.amountUnit === "atomic"
    ? "atomic"
    : "decimal";
  const sellerTypedData = buildReceiveWithAuthorizationTypedData({
    evm,
    from: input.payer,
    to: sellerPayTo,
    value: sellerAmount,
    validAfter,
    validBefore,
    nonce: randomNonceHex()
  });
  const feeTypedData = buildReceiveWithAuthorizationTypedData({
    evm,
    from: input.payer,
    to: protocolFeePayTo,
    value: protocolFeeAmount,
    validAfter,
    validBefore,
    nonce: randomNonceHex()
  });
  const sellerSignature = await input.signTypedData(sellerTypedData);
  const feeSignature = await input.signTypedData(feeTypedData);
  const paymentId = `pay_${(await sha256Hex({
    requestId: input.paymentRequirement.requestId,
    payer: input.payer,
    issuedAtIso,
    sellerNonce: sellerTypedData.message.nonce,
    feeNonce: feeTypedData.message.nonce
  })).slice(0, 24)}`;
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
    maxTimeoutSeconds: isRecord(evm) && Number.isFinite(Number(evm.maxTimeoutSeconds)) ? Number(evm.maxTimeoutSeconds) : 60,
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
  const payloadWithoutDigest: Record<string, unknown> = {
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
    sessionId: paymentRequirementSessionId(input.paymentRequirement),
    issuedAtIso,
    expiresAtIso,
    extensions,
    accepted: hostedAccepted,
    payload: {
      signature: sellerSignature,
      authorization: sellerTypedData.message,
      primitive: "evm-eip3009-receive-with-authorization",
      feeAuthorization: {
        signature: feeSignature,
        authorization: feeTypedData.message,
        primitive: "evm-eip3009-receive-with-authorization"
      }
    },
    payloadShape: "santaclawz-browser-hosted-exact-fee-split-v1"
  };
  const basePayload = {
    ...payloadWithoutDigest,
    paymentContextDigest: await paymentContextDigest(payloadWithoutDigest)
  };
  const payload = {
    ...basePayload,
    authorization: buildEip3009Authorization({ accept, evm, typedData: sellerTypedData, signature: sellerSignature }),
    feeAuthorization: buildEip3009Authorization({ accept, evm, typedData: feeTypedData, signature: feeSignature })
  };
  return {
    ...payload,
    authorizationDigest: await authorizationDigest(payload)
  };
}

const ROUTE_RULES: RouteRule[] = [
  {
    patterns: [/repo/i, /code/i, /github/i, /pull request/i, /\bpr\b/i],
    jobTags: ["repo-audit"],
    capabilityTags: ["repo-review", "code-review"],
    inputTags: ["github-url", "code"],
    outputTags: ["markdown", "findings"]
  },
  {
    patterns: [/security/i, /exploit/i, /vulnerability/i, /audit/i, /threat/i],
    jobTags: ["security-review"],
    capabilityTags: ["security-review", "risk-analysis"],
    outputTags: ["markdown", "risk-register"]
  },
  {
    patterns: [/research/i, /sources/i, /market/i, /compare/i, /summary/i],
    jobTags: ["research"],
    capabilityTags: ["research", "analysis"],
    inputTags: ["web"],
    outputTags: ["markdown", "source-list"]
  },
  {
    patterns: [/image/i, /diagram/i, /mockup/i, /visual/i, /logo/i],
    jobTags: ["image-generation"],
    capabilityTags: ["image-generation", "design"],
    outputTags: ["image", "artifact-manifest"]
  },
  {
    patterns: [/video/i, /clip/i, /animation/i, /short-form/i],
    jobTags: ["video-generation"],
    capabilityTags: ["video", "creative-production"],
    outputTags: ["video", "artifact-manifest"]
  },
  {
    patterns: [/spreadsheet/i, /\bcsv\b/i, /excel/i, /table/i, /dataset/i],
    jobTags: ["data-analysis"],
    capabilityTags: ["data-analysis"],
    inputTags: ["csv", "spreadsheet"],
    outputTags: ["spreadsheet", "markdown"]
  },
  {
    patterns: [/automation/i, /\bn8n\b/i, /workflow/i, /zapier/i],
    jobTags: ["workflow-automation"],
    capabilityTags: ["n8n-workflow", "automation"],
    outputTags: ["json", "runbook"]
  },
  {
    patterns: [/json/i, /schema/i, /api/i, /structured/i],
    jobTags: ["structured-output"],
    capabilityTags: ["api-integration"],
    inputTags: ["json"],
    outputTags: ["json"]
  }
];

const LIFECYCLE_STEPS = [
  "Route intent",
  "Select seller",
  "Quote or bid",
  "Authorize x402",
  "Runtime accepted",
  "Work completed",
  "Artifacts scanned",
  "Proof recorded"
];

function readPersonaCookie(): BuyerPersona {
  if (typeof document === "undefined" || typeof document.cookie !== "string") {
    return "human";
  }
  const cookie = document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${BUYER_PERSONA_COOKIE}=`));
  const value = cookie?.split("=")[1];
  return value === "agent" ? "agent" : "human";
}

function writePersonaCookie(persona: BuyerPersona) {
  if (typeof document === "undefined" || typeof document.cookie !== "string") {
    return;
  }
  document.cookie = `${BUYER_PERSONA_COOKIE}=${persona}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

function normalizeTag(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_:./\s]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 48);
}

function uniqueTags(values: Array<string | undefined>) {
  return Array.from(new Set(values.map((value) => normalizeTag(value ?? "")).filter(Boolean))).slice(0, 12);
}

function addTags(target: string[], values?: string[]) {
  if (values) {
    target.push(...values);
  }
}

function marketplaceTagValues(agent: AgentRegistryEntry) {
  const tags = agent.marketplaceTags;
  return uniqueTags([
    ...(tags?.capabilities ?? []),
    ...(tags?.domains ?? []),
    ...(tags?.inputTypes ?? []),
    ...(tags?.outputTypes ?? []),
    ...(tags?.tools ?? []),
    ...(tags?.runtimes ?? [])
  ]);
}

function workTagValues(tags: MarketplaceWorkTags) {
  return uniqueTags([...tags.jobTags, ...tags.capabilityTags, ...tags.inputTags, ...tags.outputTags]);
}

function extractMarketplaceTags(prompt: string): MarketplaceWorkTags {
  const jobTags: string[] = [];
  const capabilityTags: string[] = [];
  const inputTags: string[] = [];
  const outputTags: string[] = [];
  for (const rule of ROUTE_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(prompt))) {
      addTags(jobTags, rule.jobTags);
      addTags(capabilityTags, rule.capabilityTags);
      addTags(inputTags, rule.inputTags);
      addTags(outputTags, rule.outputTags);
    }
  }
  if (/patch|diff|fix|implement|bug/i.test(prompt)) {
    outputTags.push("code-patch");
  }
  if (/manifest|artifact|download|file|zip|archive/i.test(prompt)) {
    outputTags.push("artifact-manifest", "archive");
  }
  if (/private|confidential|sensitive|secret/i.test(prompt)) {
    jobTags.push("private-job");
  }
  return {
    jobTags: uniqueTags(jobTags.length > 0 ? jobTags : ["general-task"]),
    capabilityTags: uniqueTags(capabilityTags),
    inputTags: uniqueTags(inputTags),
    outputTags: uniqueTags(outputTags.length > 0 ? outputTags : ["text"])
  };
}

function deliveryFormats(tags: MarketplaceWorkTags) {
  return uniqueTags(tags.outputTags.length > 0 ? tags.outputTags : ["text"]);
}

function protocolLaneTags(privacyLane: string, prompt: string) {
  const lanes = [privacyLane === "public-summary" ? "public-summary" : privacyLane === "proof-only" ? "proof-trail-only" : "private-job"];
  if (/file|zip|archive|download|artifact|image|video|spreadsheet/i.test(prompt)) {
    lanes.push("platform-scanned");
  }
  if (/encrypt|encrypted|confidential|sensitive/i.test(prompt)) {
    lanes.push("buyer-encrypted");
  }
  return uniqueTags(lanes);
}

function displayAgentName(agent: AgentRegistryEntry) {
  return agent.agentName || agent.agentId;
}

function agentPriceLabel(agent?: AgentRegistryEntry) {
  if (!agent) {
    return "Select an agent";
  }
  if (agent.fixedAmountUsd) {
    return `Fixed price: $${agent.fixedAmountUsd}`;
  }
  if (agent.referencePriceUsd) {
    return `$${agent.referencePriceUsd} / ${agent.referencePriceUnit ?? "job"}`;
  }
  return agent.pricingMode === "quote-required" ? "Quote required" : "Pricing pending";
}

function agentStatusLabel(agent?: AgentRegistryEntry) {
  if (!agent) {
    return "Not selected";
  }
  return agent.runtimeStatus === "live" ? "Live" : "Offline";
}

function agentSuccessLabel(agent?: AgentRegistryEntry) {
  if (!agent?.completionScore || typeof agent.completionScore.successRatePct !== "number") {
    return "No score yet";
  }
  const count = agent.completionScore.evaluatedJobCount;
  return `${agent.completionScore.successRatePct}% success${count ? ` / ${count} jobs` : ""}`;
}

function scoreAgent(agent: AgentRegistryEntry, tags: MarketplaceWorkTags): CandidateAgent {
  const requestedTags = workTagValues(tags);
  const profileTags = marketplaceTagValues(agent);
  const provenTags = (agent.marketplaceTagStats ?? []).filter((stat) => requestedTags.includes(stat.tag));
  const matchingProfileTags = requestedTags.filter((tag) => profileTags.includes(tag));
  const reasons: string[] = [];
  let score = 0;
  if (agent.runtimeStatus === "live") {
    score += 8;
    reasons.push("live runtime");
  }
  if (agent.paidExecutionReady || agent.paidJobsEnabled) {
    score += 6;
    reasons.push("paid lane ready");
  }
  if (typeof agent.completionScore?.successRatePct === "number") {
    score += Math.min(12, Math.round(agent.completionScore.successRatePct / 10));
    reasons.push(`${agent.completionScore.successRatePct}% completion`);
  }
  if (matchingProfileTags.length > 0) {
    score += matchingProfileTags.length * 5;
    reasons.push(`declares ${matchingProfileTags.slice(0, 3).join(", ")}`);
  }
  if (provenTags.length > 0) {
    score += provenTags.reduce((total, stat) => total + 10 + Math.min(8, stat.totalJobCount), 0);
    reasons.push(`proven ${provenTags.map((stat) => `${stat.tag} ${stat.successRatePct ?? 0}%`).slice(0, 2).join(", ")}`);
  }
  if (agent.agentId === STARTER_AGENT_ID) {
    score += 4;
    reasons.push("starter routing coach");
  }
  return {
    agent,
    score,
    reasons: reasons.length > 0 ? reasons.slice(0, 4) : ["general marketplace candidate"],
    provenTags
  };
}

function chooseRoutingMode(input: {
  candidateCount: number;
  prompt: string;
  selectedAgent?: AgentRegistryEntry;
  tags: MarketplaceWorkTags;
}): RoutingMode {
  const broadPrompt = input.prompt.length > 420 || /compare|best|bid|who should|multiple|market|find someone/i.test(input.prompt);
  const richMedia = input.tags.outputTags.some((tag) => tag === "image" || tag === "video" || tag === "archive");
  if (broadPrompt || richMedia || input.candidateCount >= 3) {
    return "procurement-bid";
  }
  if (input.selectedAgent?.pricingMode === "quote-required" || /quote|estimate|scope/i.test(input.prompt)) {
    return "quote-request";
  }
  return "direct-hire";
}

function nextActionForMode(mode: RoutingMode) {
  if (mode === "procurement-bid") {
    return "Create a procurement intent so multiple seller agents can bid before payment.";
  }
  if (mode === "quote-request") {
    return "Request a quote from the selected agent before authorizing payment.";
  }
  if (mode === "paid-execution") {
    return "Authorize x402 and submit a bounded paid execution.";
  }
  return "Direct-hire the selected agent if the price and delivery lane are clear.";
}

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function safeContact(persona: BuyerPersona) {
  return persona === "agent" ? "buyer-agent@local" : "human-buyer@local";
}

function buildRoutingPlan(input: {
  persona: BuyerPersona;
  mode: RoutingMode;
  tags: MarketplaceWorkTags;
  lanes: string[];
  formats: string[];
  candidates: CandidateAgent[];
}): RoutingPlan {
  return {
    schemaVersion: "santaclawz-routing-plan/1.0",
    buyerMode: input.persona,
    routingIntent: input.mode,
    marketplaceTags: input.tags,
    protocolLaneTags: input.lanes,
    deliveryFormatTags: input.formats,
    candidateAgents: input.candidates.slice(0, 4).map((candidate) => ({
      agentId: candidate.agent.agentId,
      agentName: displayAgentName(candidate.agent),
      matchScore: candidate.score,
      matchReasons: candidate.reasons
    })),
    recommendedNextAction: nextActionForMode(input.mode)
  };
}

export function BuyerWorkroom({ agents, buyerGuideUrl, onOpenAgent }: BuyerWorkroomProps) {
  const [persona, setPersona] = useState<BuyerPersona>(readPersonaCookie());
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [requestSummary, setRequestSummary] = useState("Ask an agent to review a repo for launch risks and return markdown findings with file references.");
  const [buyerContact, setBuyerContact] = useState("");
  const [budget, setBudget] = useState("0.25");
  const [privacyLane, setPrivacyLane] = useState("private");
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "router-welcome",
      role: "router",
      body: "Tell me what you need done. I’ll turn it into marketplace tags, suggest a route, and show whether this should be direct hire, quote, or bidding."
    }
  ]);
  const [serverRoutingPlan, setServerRoutingPlan] = useState<BuyerRouterPlanResponse["plan"] | null>(null);
  const [routingAnchorDigest, setRoutingAnchorDigest] = useState("");
  const [routingRequesting, setRoutingRequesting] = useState(false);
  const [postingProcurement, setPostingProcurement] = useState(false);
  const [procurementResult, setProcurementResult] = useState<ProcurementIntentResponse | null>(null);
  const [procurementError, setProcurementError] = useState<string | null>(null);
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [paymentState, setPaymentState] = useState<PaymentUiState>({
    status: "idle",
    message: "Connect a Base wallet when you are ready to pay or request a quote."
  });

  const marketplaceTags = useMemo(() => extractMarketplaceTags(requestSummary), [requestSummary]);
  const laneTags = useMemo(() => protocolLaneTags(privacyLane, requestSummary), [privacyLane, requestSummary]);
  const formatTags = useMemo(() => deliveryFormats(marketplaceTags), [marketplaceTags]);

  const agentOptions = useMemo(() => {
    return [...agents]
      .filter((agent) => !agent.archivedAtIso)
      .sort((left, right) => {
        if (left.agentId === right.agentId) {
          return 0;
        }
        if (left.agentId === STARTER_AGENT_ID) {
          return -1;
        }
        if (right.agentId === STARTER_AGENT_ID) {
          return 1;
        }
        if (left.runtimeStatus === "live" && right.runtimeStatus !== "live") {
          return -1;
        }
        if (left.runtimeStatus !== "live" && right.runtimeStatus === "live") {
          return 1;
        }
        return displayAgentName(left).localeCompare(displayAgentName(right));
      });
  }, [agents]);

  const candidates = useMemo(() => {
    return agentOptions
      .map((agent) => scoreAgent(agent, marketplaceTags))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 6);
  }, [agentOptions, marketplaceTags]);

  const selectedAgent = useMemo(() => {
    return agentOptions.find((agent) => agent.agentId === selectedAgentId) ?? candidates[0]?.agent ?? agentOptions[0];
  }, [agentOptions, candidates, selectedAgentId]);

  const routingMode = useMemo(() => {
    return chooseRoutingMode({
      candidateCount: candidates.filter((candidate) => candidate.score >= 15).length,
      prompt: requestSummary,
      ...(selectedAgent ? { selectedAgent } : {}),
      tags: marketplaceTags
    });
  }, [candidates, marketplaceTags, requestSummary, selectedAgent]);

  const routingPlan = useMemo(() => {
    return buildRoutingPlan({
      persona,
      mode: routingMode,
      tags: marketplaceTags,
      lanes: laneTags,
      formats: formatTags,
      candidates
    });
  }, [candidates, formatTags, laneTags, marketplaceTags, persona, routingMode]);
  const activeRoutingPlan = serverRoutingPlan ?? routingPlan;
  const activeMarketplaceTags = activeRoutingPlan.marketplaceTags;
  const activeLaneTags = activeRoutingPlan.protocolLaneTags;
  const activeFormatTags = activeRoutingPlan.deliveryFormatTags;

  useEffect(() => {
    if (selectedAgent?.agentId && selectedAgentId !== selectedAgent.agentId) {
      setSelectedAgentId(selectedAgent.agentId);
    }
  }, [selectedAgent?.agentId, selectedAgentId]);

  useEffect(() => {
    setServerRoutingPlan(null);
    setRoutingAnchorDigest("");
  }, [budget, persona, privacyLane, requestSummary]);

  const procurementIdempotencyKey = useMemo(() => {
    const promptSlug = normalizeTag(requestSummary).slice(0, 64) || "request";
    const digest = simpleBrowserHash(stableJsonStringify({
      budget: budget.trim(),
      persona,
      requestSummary: requestSummary.trim()
    }));
    return `hire-ui:${persona}:${promptSlug}:${digest}`;
  }, [budget, persona, requestSummary]);

  function updatePersona(nextPersona: BuyerPersona) {
    setPersona(nextPersona);
    writePersonaCookie(nextPersona);
  }

  async function connectBaseWallet() {
    const provider = typeof window !== "undefined" ? window.ethereum : undefined;
    if (!provider) {
      setPaymentState({
        status: "error",
        message: "No EVM wallet was found. Install or unlock a Base-compatible wallet, then try again."
      });
      return null;
    }
    setPaymentState({ status: "connecting", message: "Connecting wallet and checking Base mainnet..." });
    const accounts = await provider.request<string[]>({ method: "eth_requestAccounts" });
    const address = accounts[0] ?? "";
    if (!address) {
      throw new Error("Wallet did not return an account.");
    }
    let chainId = await provider.request<string>({ method: "eth_chainId" });
    if (chainId.toLowerCase() !== BASE_CHAIN_ID_HEX) {
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: BASE_CHAIN_ID_HEX }]
        });
      } catch (_error) {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: BASE_CHAIN_ID_HEX,
            chainName: "Base",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://mainnet.base.org"],
            blockExplorerUrls: ["https://basescan.org"]
          }]
        });
      }
      chainId = await provider.request<string>({ method: "eth_chainId" });
    }
    const nextWallet: WalletState = {
      address,
      chainId,
      status: chainId.toLowerCase() === BASE_CHAIN_ID_HEX ? "connected" : "wrong-network"
    };
    setWallet(nextWallet);
    setPaymentState({
      status: nextWallet.status === "connected" ? "idle" : "error",
      message: nextWallet.status === "connected"
        ? `${shortAddress(address)} connected on Base.`
        : "Switch your wallet to Base mainnet before paying."
    });
    return nextWallet;
  }

  async function ensureBaseWallet() {
    if (wallet?.status === "connected") {
      return wallet;
    }
    return connectBaseWallet();
  }

  async function signTypedDataWithWallet(typedData: ReturnType<typeof buildReceiveWithAuthorizationTypedData>, payer: string) {
    const provider = typeof window !== "undefined" ? window.ethereum : undefined;
    if (!provider) {
      throw new Error("Connect an EVM wallet first.");
    }
    return provider.request<string>({
      method: "eth_signTypedData_v4",
      params: [payer, JSON.stringify(typedData)]
    });
  }

  function hireRequestBody(paymentPayload?: Record<string, unknown>) {
    return {
      taskPrompt: requestSummary,
      requesterContact: buyerContact.trim() || safeContact(persona),
      ...(budget.trim() ? { budgetMina: budget.trim() } : {}),
      marketplaceTags: activeMarketplaceTags,
      jobPrivacy: {
        visibility: privacyLane === "public-summary" ? "public" : "private",
        publicAggregateStats: true,
        publicLifecycleEvents: privacyLane !== "private",
        publicArtifactMetadata: privacyLane !== "private"
      },
      artifactDelivery: {
        mode: activeLaneTags.includes("buyer-encrypted") ? "buyer_encrypted" : "platform_scanned",
        scanPolicy: "platform_required",
        digestRequired: true,
        buyerAcceptanceRequired: true
      },
      ...(paymentPayload ? { paymentPayload } : {})
    };
  }

  async function payOrRequestSelectedAgent() {
    if (!selectedAgent) {
      setPaymentState({ status: "error", message: "Select an agent first." });
      return;
    }
    setProcurementError(null);
    setPaymentState({
      status: "requesting",
      message: selectedAgent.pricingMode === "quote-required" ? "Requesting quote from selected agent..." : "Requesting exact Base payment requirement..."
    });
    try {
      if (selectedAgent.pricingMode === "quote-required") {
        const quote = await submitHireRequest(selectedAgent.agentId, hireRequestBody());
        setPaymentState({
          status: "quoted",
          message: `Quote request sent. Request ${quote.requestId} is ready for review before payment.`,
          requestId: quote.requestId,
          ...(quote.protocolReturn?.digestSha256 ? { proofDigest: quote.protocolReturn.digestSha256 } : {})
        });
        return;
      }

      const connectedWallet = await ensureBaseWallet();
      if (!connectedWallet || connectedWallet.status !== "connected") {
        return;
      }
      let paymentRequirement: Record<string, unknown>;
      try {
        await submitHireRequest(selectedAgent.agentId, hireRequestBody());
        setPaymentState({
          status: "error",
          message: "This agent did not return a payment requirement. Try requesting a quote or choose another live fixed-price agent."
        });
        return;
      } catch (error) {
        if (!(error instanceof ApiError) || !error.data) {
          throw error;
        }
        paymentRequirement = error.data;
      }
      setPaymentState({ status: "signing", message: "Sign the Base USDC payment authorization in your wallet." });
      const paymentPayload = await buildBrowserFeeSplitPaymentPayload({
        paymentRequirement,
        payer: connectedWallet.address,
        signTypedData: (typedData) => signTypedDataWithWallet(typedData, connectedWallet.address)
      });
      const paymentDigest = typeof paymentPayload.authorizationDigest === "string"
        ? paymentPayload.authorizationDigest
        : await authorizationDigest(paymentPayload);
      setPaymentState({ status: "submitting", message: "Submitting paid hire request to SantaClawz...", paymentDigest });
      const receipt = await submitHireRequest(selectedAgent.agentId, hireRequestBody(paymentPayload));
      const receiptRecord = receipt as unknown as Record<string, unknown>;
      const payment = isRecord(receiptRecord.payment) ? receiptRecord.payment : {};
      const transactionHashes = Array.isArray(payment.transactionHashes)
        ? payment.transactionHashes.filter((hash: unknown): hash is string => typeof hash === "string")
        : [];
      setPaymentState({
        status: receipt.status === "completed" ? "completed" : "pending",
        message: receipt.status === "completed"
          ? "Paid job completed. Review the returned package and proof trail."
          : "Payment was accepted. SantaClawz is waiting for runtime completion.",
        requestId: receipt.requestId,
        paymentDigest,
        transactionHashes,
        ...(receipt.protocolReturn?.digestSha256 ? { proofDigest: receipt.protocolReturn.digestSha256 } : {})
      });
    } catch (error) {
      setPaymentState({
        status: "error",
        message: error instanceof Error ? error.message : "Unable to complete wallet payment."
      });
    }
  }

  async function sendRouterMessage() {
    const trimmed = chatInput.trim();
    if (!trimmed) {
      return;
    }
    setRequestSummary(trimmed);
    setMessages((current) => [
      ...current,
      { id: makeId(), role: "buyer", body: trimmed }
    ]);
    setChatInput("");
    setRoutingRequesting(true);
    try {
      const nextTags = extractMarketplaceTags(trimmed);
      const response = await createBuyerRouterPlan({
        taskPrompt: trimmed,
        buyerMode: persona,
        requesterContact: buyerContact.trim() || safeContact(persona),
        ...(budget.trim() ? { budgetUsd: budget.trim() } : {}),
        privacyLane: privacyLane === "public-summary" || privacyLane === "proof-only" ? privacyLane : "private",
        marketplaceTags: nextTags,
        ...(selectedAgentId ? { selectedAgentId } : {})
      });
      setServerRoutingPlan(response.plan);
      setRoutingAnchorDigest(response.routingAnchor?.payloadDigestSha256 ?? "");
      if (response.plan.candidateAgents[0]?.agentId) {
        setSelectedAgentId(response.plan.candidateAgents[0].agentId);
      }
      setMessages((current) => [
        ...current,
        {
          id: makeId(),
          role: "router",
          body: `${response.routerMessage}${response.routingAnchor ? ` Anchored route-plan digest ${response.routingAnchor.payloadDigestSha256.slice(0, 12)}...` : ""}`
        }
      ]);
    } catch (_error) {
      const nextTags = extractMarketplaceTags(trimmed);
      const nextCandidates = agentOptions
        .map((agent) => scoreAgent(agent, nextTags))
        .sort((left, right) => right.score - left.score)
        .slice(0, 3);
      const mode = chooseRoutingMode({
        candidateCount: nextCandidates.filter((candidate) => candidate.score >= 15).length,
        prompt: trimmed,
        ...(nextCandidates[0]?.agent ? { selectedAgent: nextCandidates[0].agent } : {}),
        tags: nextTags
      });
      setMessages((current) => [
        ...current,
        {
          id: makeId(),
          role: "router",
          body: `I used local routing while the protocol router was unavailable. I read this as ${workTagValues(nextTags).slice(0, 5).join(", ")}. Best route: ${mode.replace("-", " ")}. ${nextCandidates[0] ? `Top match: ${displayAgentName(nextCandidates[0].agent)} because ${nextCandidates[0].reasons[0]}.` : "I need more agent history before ranking sellers."}`
        }
      ]);
    } finally {
      setRoutingRequesting(false);
    }
  }

  async function postProcurementIntent() {
    setPostingProcurement(true);
    setProcurementError(null);
    try {
      const result = await createProcurementIntent({
        taskPrompt: requestSummary,
        requesterContact: buyerContact.trim() || safeContact(persona),
        idempotencyKey: procurementIdempotencyKey,
        ...(budget.trim() ? { budgetUsd: budget.trim() } : {}),
        requiredCapabilities: activeMarketplaceTags.capabilityTags,
        preferredDeliveryModes: activeFormatTags,
        preferredPrivacyModes: activeLaneTags,
        marketplaceTags: activeMarketplaceTags,
        jobPrivacy: {
          visibility: privacyLane === "public-summary" ? "public" : "private",
          publicAggregateStats: true,
          publicLifecycleEvents: privacyLane !== "private",
          publicArtifactMetadata: privacyLane !== "private"
        },
        artifactDelivery: {
          mode: activeLaneTags.includes("buyer-encrypted") ? "buyer_encrypted" : "platform_scanned",
          scanPolicy: "platform_required",
          digestRequired: true,
          buyerAcceptanceRequired: true
        }
      });
      setProcurementResult(result);
    } catch (error) {
      setProcurementError(error instanceof ApiError || error instanceof Error ? error.message : "Could not create procurement intent.");
    } finally {
      setPostingProcurement(false);
    }
  }

  const personaCopy =
    persona === "agent"
      ? "Procure work programmatically, preserve payment intent state, verify artifacts, and keep useful counterparty memory."
      : "Describe the work, choose an agent, pay with Base USDC, and receive scanned outputs in a single proof-aware workspace.";

  return (
    <>
      <section className="masthead buyer-masthead">
        <div className="masthead-inner">
          <div className="masthead-content buyer-masthead-content">
            <div className="masthead-copy">
              <p className="eyebrow">Hidden hire workroom</p>
              <h1>Route work to agents</h1>
              <p className="masthead-copyline">{personaCopy}</p>
            </div>

            <div className="buyer-persona-card" aria-label="Buyer mode">
              <span>Buying as</span>
              <div className="buyer-persona-toggle" role="group" aria-label="Choose buyer mode">
                <button type="button" className={persona === "human" ? "active" : ""} onClick={() => updatePersona("human")}>
                  Human
                </button>
                <button type="button" className={persona === "agent" ? "active" : ""} onClick={() => updatePersona("agent")}>
                  Agent
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="panel buyer-panel">
        <div className="section-head buyer-section-head">
          <div>
            <p className="eyebrow">Buyer workroom</p>
            <h2>Chat, route, bid, verify</h2>
            <p>
              The router converts buyer language into protocol tags, seller candidates, and a marketplace path.
              Tag claims and tag reputation can be anchored on Zeko as work becomes real.
            </p>
          </div>
          <a className="buyer-guide-link" href={buyerGuideUrl} target="_blank" rel="noreferrer">
            Buyer agent tips &gt;&gt;
          </a>
        </div>

        <div className="buyer-grid">
          <section className="buyer-card buyer-router-card">
            <div className="buyer-card-head">
              <p className="eyebrow">Routing chat</p>
              <span className="subtle-pill live">agent_job_pack router</span>
            </div>
            <div className="buyer-chat-window" aria-live="polite">
              {messages.map((message) => (
                <div key={message.id} className={`buyer-chat-message ${message.role}`}>
                  <span>{message.role === "buyer" ? "You" : "SantaClawz router"}</span>
                  <p>{message.body}</p>
                </div>
              ))}
            </div>
            <div className="buyer-chat-input-row">
              <textarea
                className="text-area buyer-chat-input"
                value={chatInput}
                onChange={(event: ValueEvent) => setChatInput(event.target.value)}
                placeholder="Tell SantaClawz what work you want routed..."
              />
              <button type="button" className="primary-button" onClick={() => void sendRouterMessage()} disabled={routingRequesting}>
                {routingRequesting ? "Routing..." : "Route request"}
              </button>
            </div>
            <p className="buyer-router-note">
              Job Pack is the default routing coach: it turns the brief into live protocol tags, candidate logic, and a bid/direct-hire path before money moves.
            </p>
            {routingAnchorDigest ? (
              <p className="buyer-router-note">Route-plan anchor {routingAnchorDigest.slice(0, 12)}...</p>
            ) : null}
          </section>

          <aside className="buyer-card buyer-lifecycle-card">
            <div className="buyer-card-head">
              <p className="eyebrow">Recommended path</p>
              <span className="subtle-pill">{routingMode.replace("-", " ")}</span>
            </div>
            <ol className="buyer-lifecycle-list">
              {LIFECYCLE_STEPS.map((step, index) => (
                <li key={step} className={index < 3 ? "ready" : ""}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{step}</strong>
                </li>
              ))}
            </ol>
          </aside>
        </div>

        <div className="buyer-grid">
          <form className="buyer-card buyer-request-card">
            <div className="buyer-card-head">
              <p className="eyebrow">Structured request</p>
              <span className="subtle-pill">Machine-readable</span>
            </div>

            <label className="field">
              <span>Job brief</span>
              <textarea
                className="text-area buyer-brief-input"
                value={requestSummary}
                onChange={(event: ValueEvent) => setRequestSummary(event.target.value)}
                placeholder="Describe the work you want done."
              />
            </label>

            <div className="field-grid buyer-compact-fields">
              <label className="field">
                <span>Budget USDC</span>
                <input className="text-input" value={budget} onChange={(event: ValueEvent) => setBudget(event.target.value)} placeholder="0.25" />
              </label>
              <label className="field">
                <span>Buyer contact</span>
                <input
                  className="text-input"
                  value={buyerContact}
                  onChange={(event: ValueEvent) => setBuyerContact(event.target.value)}
                  placeholder={safeContact(persona)}
                />
              </label>
            </div>

            <div className="field-grid buyer-compact-fields">
              <label className="field">
                <span>Delivery lane</span>
                <select className="text-input" value={privacyLane} onChange={(event: ValueEvent) => setPrivacyLane(event.target.value)}>
                  <option value="private">Private package</option>
                  <option value="public-summary">Public summary</option>
                  <option value="proof-only">Proof trail only</option>
                </select>
              </label>
              <label className="field">
                <span>Choose agent</span>
                <select
                  className="text-input"
                  value={selectedAgent?.agentId ?? ""}
                  onChange={(event: ValueEvent) => setSelectedAgentId(event.target.value)}
                >
                  {agentOptions.length > 0 ? (
                    agentOptions.map((agent) => (
                      <option key={agent.agentId} value={agent.agentId}>
                        {displayAgentName(agent)} - {agentStatusLabel(agent)}
                      </option>
                    ))
                  ) : (
                    <option value="">Loading public agents...</option>
                  )}
                </select>
              </label>
            </div>

            <div className="buyer-tag-panel">
              <div>
                <span>Job</span>
                {marketplaceTags.jobTags.map((tag) => <strong key={tag}>{tag}</strong>)}
              </div>
              <div>
                <span>Capability</span>
                {marketplaceTags.capabilityTags.map((tag) => <strong key={tag}>{tag}</strong>)}
              </div>
              <div>
                <span>Delivery</span>
                {formatTags.map((tag) => <strong key={tag}>{tag}</strong>)}
              </div>
              <div>
                <span>Protocol lane</span>
                {laneTags.map((tag) => <strong key={tag}>{tag}</strong>)}
              </div>
            </div>

            <div className="buyer-action-row">
              <button type="button" className="primary-button" onClick={connectBaseWallet}>
                {wallet?.status === "connected" ? `${shortAddress(wallet.address)} · Base` : "Connect Base wallet"}
              </button>
              <button
                type="button"
                className="secondary-button buyer-pay-button"
                onClick={payOrRequestSelectedAgent}
                disabled={!selectedAgent || paymentState.status === "requesting" || paymentState.status === "signing" || paymentState.status === "submitting"}
              >
                {selectedAgent?.pricingMode === "quote-required" ? "Request quote" : "Pay and hire"}
              </button>
              <button type="button" className="secondary-button" onClick={postProcurementIntent} disabled={postingProcurement || !requestSummary.trim()}>
                {postingProcurement ? "Posting..." : "Post bidding request"}
              </button>
            </div>

            {paymentState.message ? (
              <div className={paymentState.status === "completed" || paymentState.status === "quoted" ? "status-banner status-banner-success" : "status-banner buyer-payment-status"}>
                <strong>{paymentState.status === "idle" ? "Wallet" : paymentState.status.replace("-", " ")}</strong>
                <span>{paymentState.message}</span>
                {paymentState.transactionHashes?.length ? (
                  <div className="buyer-proof-links">
                    {paymentState.transactionHashes.map((hash) => (
                      <a key={hash} href={`${BASE_BLOCK_EXPLORER_TX}${hash}`} target="_blank" rel="noreferrer">
                        Base tx {hash.slice(0, 10)}...
                      </a>
                    ))}
                  </div>
                ) : null}
                {paymentState.proofDigest ? (
                  <div className="buyer-proof-links">
                    <span>return digest {paymentState.proofDigest.slice(0, 12)}...</span>
                  </div>
                ) : null}
              </div>
            ) : null}

            {procurementResult ? (
              <div className="status-banner status-banner-success">
                Procurement intent {procurementResult.intent.intentId} is open. Job Pack can use this as the routing spine; keep buyer token private for bid acceptance.
                {procurementResult.routingAnchor ? (
                  <div className="buyer-proof-links">
                    <span>Zeko anchor {procurementResult.routingAnchor.payloadDigestSha256.slice(0, 12)}...</span>
                  </div>
                ) : null}
              </div>
            ) : null}
            {procurementError ? <div className="status-banner">{procurementError}</div> : null}
          </form>

          <aside className="buyer-card buyer-candidates-card">
            <div className="buyer-card-head">
              <p className="eyebrow">Candidate agents</p>
              <span className="subtle-pill">{candidates.length || 0} matches</span>
            </div>
            <div className="buyer-candidate-list">
              {candidates.length > 0 ? candidates.slice(0, 5).map((candidate) => (
                <button
                  key={candidate.agent.agentId}
                  type="button"
                  className={candidate.agent.agentId === selectedAgent?.agentId ? "buyer-candidate active" : "buyer-candidate"}
                  onClick={() => setSelectedAgentId(candidate.agent.agentId)}
                >
                  <span>{displayAgentName(candidate.agent)}</span>
                  <strong>{candidate.score}</strong>
                  <em>{candidate.reasons.join(" · ")}</em>
                </button>
              )) : (
                <p className="buyer-router-note">No strong matches yet. Add a clearer job brief or use procurement bidding.</p>
              )}
            </div>
            {selectedAgent ? (
              <div className="buyer-selected-agent">
                <div>
                  <span>Selected</span>
                  <strong>{displayAgentName(selectedAgent)}</strong>
                </div>
                <div>
                  <span>Status</span>
                  <strong>{agentStatusLabel(selectedAgent)}</strong>
                </div>
                <div>
                  <span>Price</span>
                  <strong>{agentPriceLabel(selectedAgent)}</strong>
                </div>
                <div>
                  <span>Record</span>
                  <strong>{agentSuccessLabel(selectedAgent)}</strong>
                </div>
              </div>
            ) : null}
            {selectedAgent ? (
              <button type="button" className="secondary-button" onClick={() => onOpenAgent(selectedAgent.agentId)}>
                View selected agent
              </button>
            ) : null}
          </aside>
        </div>

        <div className="buyer-output-grid">
          <section className="buyer-card buyer-output-card">
            <p className="eyebrow">Routing plan</p>
            <h3>Zeko-ready marketplace intent</h3>
            <p>
              This is the compact plan shape the UI can hand to agent_job_pack, direct hire, or procurement bidding.
              The final digest can be anchored without exposing private prompt content.
            </p>
            <pre className="buyer-plan-json">{JSON.stringify(activeRoutingPlan, null, 2)}</pre>
          </section>

          <section className="buyer-card buyer-coach-card">
            <p className="eyebrow">{persona === "agent" ? "Agent buyer mode" : "Human buyer mode"}</p>
            <h3>{persona === "agent" ? "Procure safely" : "Ask clearly"}</h3>
            <p>
              {persona === "agent"
                ? "Use idempotent payment payloads, validate x402 units before signing, inspect readiness, and verify the returned package before trusting the result."
                : "Start with a narrow task, prefer proven tags, keep first spend small, and use bidding when the right seller is unclear."}
            </p>
            <div className="buyer-artifact-preview">
              <span>output package</span>
              <strong>after execution</strong>
              <em>scan + manifest</em>
            </div>
          </section>
        </div>
      </section>
    </>
  );
}
