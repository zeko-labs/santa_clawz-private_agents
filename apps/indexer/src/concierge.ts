// SPDX-License-Identifier: Apache-2.0
//
// Concierge integration helpers are intentionally permissively licensed so
// trusted frontends can embed SantaClawz discovery, routing, and checkout
// flows without inheriting the protected hosted indexer license.

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { AgentRegistryEntry, MarketplaceWorkTags } from "@clawz/protocol";

export interface ConciergeIntegratorConfig {
  integratorId: string;
  integratorName: string;
  apiKeySha256: string;
  allowedOrigins: string[];
  subscriptionStatus: "active" | "paused" | "sandbox";
  routerAgentId?: string;
  preferredAgentIds: string[];
  payoutWallet?: string;
  maxRequestChars: number;
  maxCandidates: number;
}

export interface ConciergePublicIntegrator {
  integratorId: string;
  integratorName: string;
  subscriptionStatus: ConciergeIntegratorConfig["subscriptionStatus"];
  allowedOrigins: string[];
  routerAgentId?: string;
  preferredAgentIds: string[];
  payoutWallet?: string;
  feeModel: {
    type: "subscription";
    perTransactionIntegratorFee: false;
  };
  limits: {
    maxRequestChars: number;
    maxCandidates: number;
  };
}

export interface ConciergeSessionPayload {
  schemaVersion: "santaclawz-concierge-session/1.0";
  sessionId: string;
  integratorId: string;
  integratorName: string;
  buyerWallet?: string;
  allowedOrigins: string[];
  taskPromptDigestSha256: string;
  routePlanDigestSha256: string;
  selectedAgentId?: string;
  candidateAgentIds: string[];
  preferredAgentIds: string[];
  maxUsd?: string;
  createdAtIso: string;
  expiresAtIso: string;
  paymentModel: {
    buyerPaysSellerDirectly: true;
    settlement: "existing-santaclawz-x402";
    integratorFeeSettlement: "none-v1-subscription";
  };
}

export interface ConciergeSignedSession {
  payload: ConciergeSessionPayload;
  signature: string;
  token: string;
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function timingSafeHexEqual(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) {
    return false;
  }
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function base64UrlToBuffer(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized.padEnd(normalized.length + paddingLength, "="), "base64");
}

function parseBase64UrlJson(value: string): unknown {
  return JSON.parse(base64UrlToBuffer(value).toString("utf8"));
}

function hmacSignature(secret: string, payloadPart: string) {
  return createHmac("sha256", secret).update(payloadPart).digest("hex");
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean).slice(0, 50);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 50);
  }
  return [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function integerField(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizeIntegrator(value: unknown): ConciergeIntegratorConfig | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const integratorId = optionalString(record.integratorId ?? record.id);
  const apiKeySha256 =
    optionalString(record.apiKeySha256 ?? record.api_key_sha256) ??
    (optionalString(record.apiKey ?? record.api_key) ? sha256Hex(optionalString(record.apiKey ?? record.api_key)!) : undefined);
  if (!integratorId || !apiKeySha256 || !/^[a-f0-9]{64}$/i.test(apiKeySha256)) {
    return undefined;
  }
  const subscriptionStatus =
    record.subscriptionStatus === "paused" || record.subscriptionStatus === "sandbox"
      ? record.subscriptionStatus
      : "active";
  return {
    integratorId,
    integratorName: optionalString(record.integratorName ?? record.name) ?? integratorId,
    apiKeySha256: apiKeySha256.toLowerCase(),
    allowedOrigins: stringArray(record.allowedOrigins ?? record.allowed_origins),
    subscriptionStatus,
    ...(optionalString(record.routerAgentId ?? record.router_agent_id) ? { routerAgentId: optionalString(record.routerAgentId ?? record.router_agent_id)! } : {}),
    preferredAgentIds: stringArray(record.preferredAgentIds ?? record.preferred_agent_ids),
    ...(optionalString(record.payoutWallet ?? record.payout_wallet) ? { payoutWallet: optionalString(record.payoutWallet ?? record.payout_wallet)! } : {}),
    maxRequestChars: integerField(record.maxRequestChars ?? record.max_request_chars, 2000, 80, 4000),
    maxCandidates: integerField(record.maxCandidates ?? record.max_candidates, 8, 1, 20)
  };
}

export function conciergeIntegratorsFromEnv(env: Record<string, string | undefined> = process.env): ConciergeIntegratorConfig[] {
  const configs: ConciergeIntegratorConfig[] = [];
  const rawJson = optionalString(env.CLAWZ_CONCIERGE_INTEGRATORS_JSON);
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      const values = Array.isArray(parsed) ? parsed : [parsed];
      for (const value of values) {
        const config = normalizeIntegrator(value);
        if (config) {
          configs.push(config);
        }
      }
    } catch {
      // Ignore malformed config here; the endpoint will simply have no integrators.
    }
  }

  const single = normalizeIntegrator({
    integratorId: env.CLAWZ_CONCIERGE_TRUSTED_INTEGRATOR_ID,
    integratorName: env.CLAWZ_CONCIERGE_TRUSTED_INTEGRATOR_NAME,
    apiKeySha256: env.CLAWZ_CONCIERGE_TRUSTED_INTEGRATOR_API_KEY_SHA256,
    apiKey: env.CLAWZ_CONCIERGE_TRUSTED_INTEGRATOR_API_KEY,
    allowedOrigins: env.CLAWZ_CONCIERGE_TRUSTED_INTEGRATOR_ALLOWED_ORIGINS,
    routerAgentId: env.CLAWZ_CONCIERGE_TRUSTED_ROUTER_AGENT_ID,
    preferredAgentIds: env.CLAWZ_CONCIERGE_TRUSTED_PREFERRED_AGENT_IDS,
    payoutWallet: env.CLAWZ_CONCIERGE_TRUSTED_PAYOUT_WALLET,
    maxRequestChars: env.CLAWZ_CONCIERGE_MAX_REQUEST_CHARS,
    maxCandidates: env.CLAWZ_CONCIERGE_MAX_CANDIDATES
  });
  if (single && !configs.some((config) => config.integratorId === single.integratorId)) {
    configs.push(single);
  }

  return configs;
}

export function publicConciergeIntegrator(config: ConciergeIntegratorConfig): ConciergePublicIntegrator {
  return {
    integratorId: config.integratorId,
    integratorName: config.integratorName,
    subscriptionStatus: config.subscriptionStatus,
    allowedOrigins: config.allowedOrigins,
    ...(config.routerAgentId ? { routerAgentId: config.routerAgentId } : {}),
    preferredAgentIds: config.preferredAgentIds,
    ...(config.payoutWallet ? { payoutWallet: config.payoutWallet } : {}),
    feeModel: {
      type: "subscription",
      perTransactionIntegratorFee: false
    },
    limits: {
      maxRequestChars: config.maxRequestChars,
      maxCandidates: config.maxCandidates
    }
  };
}

export function authenticateConciergeIntegrator(input: {
  apiKey?: string;
  origin?: string;
  integrators?: ConciergeIntegratorConfig[];
}): { ok: true; integrator: ConciergeIntegratorConfig } | { ok: false; status: number; error: string; code: string } {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    return { ok: false, status: 401, code: "concierge_api_key_required", error: "Concierge API key is required." };
  }
  const presentedHash = sha256Hex(apiKey);
  const integrator = (input.integrators ?? conciergeIntegratorsFromEnv()).find((candidate) =>
    timingSafeHexEqual(candidate.apiKeySha256, presentedHash)
  );
  if (!integrator) {
    return { ok: false, status: 401, code: "concierge_api_key_rejected", error: "Concierge API key was rejected." };
  }
  if (integrator.subscriptionStatus === "paused") {
    return { ok: false, status: 403, code: "concierge_subscription_paused", error: "Concierge integration is paused." };
  }
  const origin = input.origin?.trim();
  if (origin && integrator.allowedOrigins.length > 0 && !integrator.allowedOrigins.includes(origin)) {
    return { ok: false, status: 403, code: "concierge_origin_rejected", error: "This origin is not allowed for the Concierge integration." };
  }
  return { ok: true, integrator };
}

export function conciergeSessionSecret(env: Record<string, string | undefined> = process.env) {
  return (
    optionalString(env.CLAWZ_CONCIERGE_SESSION_SECRET) ??
    optionalString(env.CLAWZ_ADMIN_API_KEY) ??
    "santaclawz-local-concierge-session-secret"
  );
}

export function signConciergeSession(payload: ConciergeSessionPayload, secret = conciergeSessionSecret()): ConciergeSignedSession {
  const payloadPart = base64UrlJson(payload);
  const signature = hmacSignature(secret, payloadPart);
  return {
    payload,
    signature,
    token: `${payloadPart}.${signature}`
  };
}

export function verifyConciergeSession(token: string, secret = conciergeSessionSecret()) {
  const [payloadPart, signature] = token.split(".");
  if (!payloadPart || !signature) {
    throw new Error("Concierge session token is malformed.");
  }
  const expected = hmacSignature(secret, payloadPart);
  const presentedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (presentedBuffer.length !== expectedBuffer.length || !timingSafeEqual(presentedBuffer, expectedBuffer)) {
    throw new Error("Concierge session signature was rejected.");
  }
  const payload = parseBase64UrlJson(payloadPart);
  if (!payload || typeof payload !== "object") {
    throw new Error("Concierge session payload is malformed.");
  }
  const record = payload as ConciergeSessionPayload;
  if (record.schemaVersion !== "santaclawz-concierge-session/1.0") {
    throw new Error("Concierge session schema is not supported.");
  }
  if (Date.parse(record.expiresAtIso) <= Date.now()) {
    throw new Error("Concierge session is expired.");
  }
  return record;
}

export function createConciergeSession(input: {
  integrator: ConciergeIntegratorConfig;
  taskPrompt: string;
  routePlanDigestSha256: string;
  candidateAgentIds: string[];
  buyerWallet?: string;
  selectedAgentId?: string;
  maxUsd?: string;
  ttlSeconds?: number;
}) {
  const createdAtIso = new Date().toISOString();
  const ttlSeconds = Math.max(60, Math.min(3600, Math.trunc(input.ttlSeconds ?? 15 * 60)));
  const expiresAtIso = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  return signConciergeSession({
    schemaVersion: "santaclawz-concierge-session/1.0",
    sessionId: `concierge_${randomUUID()}`,
    integratorId: input.integrator.integratorId,
    integratorName: input.integrator.integratorName,
    ...(input.buyerWallet ? { buyerWallet: input.buyerWallet } : {}),
    allowedOrigins: input.integrator.allowedOrigins,
    taskPromptDigestSha256: sha256Hex(input.taskPrompt.trim()),
    routePlanDigestSha256: input.routePlanDigestSha256,
    ...(input.selectedAgentId ? { selectedAgentId: input.selectedAgentId } : {}),
    candidateAgentIds: input.candidateAgentIds,
    preferredAgentIds: input.integrator.preferredAgentIds,
    ...(input.maxUsd ? { maxUsd: input.maxUsd } : {}),
    createdAtIso,
    expiresAtIso,
    paymentModel: {
      buyerPaysSellerDirectly: true,
      settlement: "existing-santaclawz-x402",
      integratorFeeSettlement: "none-v1-subscription"
    }
  });
}

export function conciergeAgentSummary(
  apiBaseUrl: string,
  agent: AgentRegistryEntry,
  preferredAgentIds: string[] = [],
  webBaseUrl = apiBaseUrl
) {
  return {
    agentId: agent.agentId,
    agentName: agent.agentName,
    headline: agent.headline,
    representedPrincipal: agent.representedPrincipal,
    publicProfileUrl: `${webBaseUrl}/agent/${encodeURIComponent(agent.agentId)}`,
    publicHireUrl: `${apiBaseUrl}/api/agents/${encodeURIComponent(agent.agentId)}/hire`,
    pricingMode: agent.pricingMode,
    ...(agent.fixedAmountUsd ? { fixedAmountUsd: agent.fixedAmountUsd } : {}),
    ...(agent.referencePriceUsd ? { referencePriceUsd: agent.referencePriceUsd } : {}),
    ...(agent.referencePriceUnit ? { referencePriceUnit: agent.referencePriceUnit } : {}),
    runtimeStatus: agent.runtimeStatus,
    published: agent.published,
    ownershipVerified: agent.ownershipVerified,
    paidJobsEnabled: agent.paidJobsEnabled,
    paidExecutionReady: agent.paidExecutionReady === true,
    quoteReady: agent.quoteReady === true,
    forHire: Boolean(agent.paidJobsEnabled || agent.quoteReady),
    preferredByIntegrator: preferredAgentIds.includes(agent.agentId),
    marketplaceTags: agent.marketplaceTags,
    ...(agent.completionScore ? { completionScore: agent.completionScore } : {}),
    ...(agent.jobActivityStats ? { jobActivityStats: agent.jobActivityStats } : {})
  };
}

export function parseConciergeMarketplaceTags(value: unknown): Partial<MarketplaceWorkTags> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    jobTags: stringArray(record.jobTags),
    capabilityTags: stringArray(record.capabilityTags),
    inputTags: stringArray(record.inputTags),
    outputTags: stringArray(record.outputTags)
  };
}
