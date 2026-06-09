import express from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";

import {
  type AgentBoardMessage,
  type AgentMessageEnvelope,
  type AgentBoardMessageType,
  type AgentBoardState,
  type AgentMarketplaceTags,
  type AgentPaymentRail,
  type AgentActivationLaneAttemptStatus,
  type AgentActivationProbeClassification,
  type AgentProfileState,
  type AgentRuntimeStatus,
  type AgentX402RailPlan,
  assertClawzJsonRpcRequest,
  buildProofVerificationResponse,
  type ClawzAgentDiscoveryDocument,
  type ClawzAgentProofBundle,
  type ClawzAgentProofVerificationRequest,
  type ClawzAgentProofVerificationResponse,
  type ConsoleStateResponse,
  type ExecutionIntentSettlementModel,
  type ExecutionIntentStatus,
  type HireRelayTraceStep,
  type MarketplaceWorkTags,
  type PaymentLedgerEntry,
  type PaymentLedgerState,
  type PrivacyApprovalRecord,
  type SantaClawzArtifactDeliveryPreference,
  type SantaClawzContextFailureCode,
  type SantaClawzContextInputField,
  type SantaClawzContextRequirements,
  type SantaClawzJobContext,
  type SantaClawzJobPrivacyPreference,
  type SocialAnchorCandidateKind,
  type SantaClawzQuoteAcceptanceWalletProof,
  reduceSantaClawzPaidLifecycle,
  type TrustModeId,
  type WitnessPlanLike,
  type WorkshopReceiptLedgerState,
  verifyAgentProofBundle
} from "@clawz/protocol";

import {
  ClawzControlPlane,
  DuplicatePublicClawzUrlError,
  SelfServeSocialAnchoringDisabledError,
  type CreateBuyerRouterPlanOptions,
  type CreateExecutionIntentOptions,
  type CreateProcurementIntentOptions,
  type ExecutionIntentTransitionOptions,
  type HostedWorkspaceIdentityProvider,
  type RecordActivationLaneAttemptOptions,
  type UpsertHostedWorkspaceRunOptions
} from "./control-plane.js";
import { ArtifactSafetyError, ArtifactScanUnavailableError, ArtifactStore } from "./artifact-store.js";
import { buildAgentProofBundle, buildDiscoveryDocument, buildMcpToolDefinitions } from "./interop.js";
import {
  apiAuthMiddleware,
  publicSecurityStatus,
  resolveSecurityConfig,
  securityMiddleware
} from "./security.js";
import {
  buildAgentX402Catalog,
  buildAgentX402CatalogPreview,
  buildActivationLaneX402RuntimeContext,
  buildAgentX402Headers,
  parseAgentX402PaymentPayload,
  buildAgentX402RuntimeContext,
  buildQuoteIntentX402RuntimeContext,
  buildAgentX402PaymentRequiredPreview,
  buildAgentX402PlanWithNetworkQuotes,
  startNetworkFacilitationFeeMonitor,
  settleAgentX402Payment,
  verifyAgentX402Payment
} from "./x402-adapter.js";

const app = express();
const expressRaw = (express as unknown as { raw(options?: unknown): unknown }).raw;
const appWithRouteMiddleware = app as unknown as {
  head(path: string, ...handlers: unknown[]): void;
  post(path: string, ...handlers: unknown[]): void;
};
const securityConfig = resolveSecurityConfig();
const HIRE_REQUEST_BODY_MAX_BYTES = 32 * 1024;
const HIRE_TASK_PROMPT_MAX_LENGTH = 2000;
const HIRE_REQUESTER_CONTACT_MAX_LENGTH = 240;
const HIRE_REQUEST_LIMITS = Object.freeze({
  taskPromptMaxChars: HIRE_TASK_PROMPT_MAX_LENGTH,
  requesterContactMaxChars: HIRE_REQUESTER_CONTACT_MAX_LENGTH,
  bodyMaxBytes: HIRE_REQUEST_BODY_MAX_BYTES
});
const EVM_RECONCILIATION_FETCH_TIMEOUT_MS = 30_000;
const MAX_EVM_RECONCILIATION_LOOKBACK_BLOCKS = 250_000;
const CONSOLE_STATE_CACHE_TTL_MS = Math.max(
  0,
  Math.trunc(Number(process.env.CLAWZ_CONSOLE_STATE_CACHE_TTL_MS ?? "2000"))
);
const CONSOLE_STATE_CACHE_MAX_ENTRIES = Math.max(
  10,
  Math.trunc(Number(process.env.CLAWZ_CONSOLE_STATE_CACHE_MAX_ENTRIES ?? "120"))
);
const PAYMENT_LEDGER_CACHE_TTL_MS = Math.max(
  0,
  Math.trunc(Number(process.env.CLAWZ_PAYMENT_LEDGER_CACHE_TTL_MS ?? "5000"))
);
const PAYMENT_LEDGER_CACHE_MAX_ENTRIES = Math.max(
  10,
  Math.trunc(Number(process.env.CLAWZ_PAYMENT_LEDGER_CACHE_MAX_ENTRIES ?? "80"))
);
const ARTIFACT_DOWNLOAD_READ_BUDGET_MS = 5000;
const X402_PLAN_COLD_READ_BUDGET_MS = 3000;
const X402_PAYMENT_STATE_COLD_READ_BUDGET_MS = 3000;
const PUBLIC_MARKETPLACE_SNAPSHOT_CACHE_TTL_MS = Math.max(
  0,
  Math.trunc(Number(process.env.CLAWZ_PUBLIC_MARKETPLACE_SNAPSHOT_CACHE_TTL_MS ?? "10000"))
);
const PUBLIC_READ_CACHE_TTL_MS = Math.max(
  0,
  Math.trunc(Number(process.env.CLAWZ_PUBLIC_READ_CACHE_TTL_MS ?? "5000"))
);
const PUBLIC_READ_CACHE_MAX_ENTRIES = Math.max(
  10,
  Math.trunc(Number(process.env.CLAWZ_PUBLIC_READ_CACHE_MAX_ENTRIES ?? "120"))
);
const HOT_READ_STALE_WHILE_REVALIDATE_MS = 60_000;
const HOT_READ_PRODUCER_CONCURRENCY = Math.max(
  1,
  Math.trunc(Number(process.env.CLAWZ_HOT_READ_PRODUCER_CONCURRENCY ?? "2"))
);
const HOT_READ_PRODUCER_QUEUE_MAX = Math.max(
  4,
  Math.trunc(Number(process.env.CLAWZ_HOT_READ_PRODUCER_QUEUE_MAX ?? "24"))
);
const CRITICAL_HOT_READ_PRODUCER_CONCURRENCY = Math.max(
  1,
  Math.trunc(Number(process.env.CLAWZ_CRITICAL_HOT_READ_PRODUCER_CONCURRENCY ?? "2"))
);
const CRITICAL_HOT_READ_PRODUCER_QUEUE_MAX = Math.max(
  4,
  Math.trunc(Number(process.env.CLAWZ_CRITICAL_HOT_READ_PRODUCER_QUEUE_MAX ?? "24"))
);
const PUBLIC_READ_RATE_LIMIT_WINDOW_MS = Math.max(
  10_000,
  Math.trunc(Number(process.env.CLAWZ_PUBLIC_READ_RATE_LIMIT_WINDOW_MS ?? "60000"))
);
const PUBLIC_READ_RATE_LIMIT_MAX_COST = Math.max(
  60,
  Math.trunc(Number(process.env.CLAWZ_PUBLIC_READ_RATE_LIMIT_MAX_COST ?? "240"))
);
const PUBLIC_READ_FIRST_PARTY_RATE_LIMIT_MAX_COST = Math.max(
  PUBLIC_READ_RATE_LIMIT_MAX_COST,
  Math.trunc(Number(process.env.CLAWZ_PUBLIC_READ_FIRST_PARTY_RATE_LIMIT_MAX_COST ?? "1200"))
);
const PROTOCOL_READ_RATE_LIMIT_MAX_COST = 1200;
const RUNTIME_READ_RATE_LIMIT_MAX_COST = 600;
const PUBLIC_READ_FIRST_PARTY_ORIGINS = new Set(
  (process.env.CLAWZ_PUBLIC_READ_FIRST_PARTY_ORIGINS ?? "https://www.santaclawz.ai,https://santaclawz.ai")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean)
);
const USD_MICRO_SCALE = 1_000_000n;
const ACTIVATION_LANE_DEFAULT_MIN_USD = "0.002";
const ACTIVATION_LANE_DEFAULT_EPSILON_USD = "0.000001";
const ACTIVATION_LANE_DEFAULT_INTERVAL_SECONDS = 30;
const startedAtIso = new Date().toISOString();
const startedAtMs = Date.now();
const PUBLIC_SOCIAL_ANCHOR_FEED_KINDS: SocialAnchorCandidateKind[] = [
  "agent-registered",
  "marketplace-tags-declared",
  "ownership-verified",
  "agent-published",
  "payment-terms-live",
  "hire-request-submitted",
  "quote-returned",
  "quote-accepted",
  "paid-execution-completed",
  "free-test-completed",
  "hire-request-failed",
  "execution-intent-created",
  "execution-intent-approved",
  "execution-intent-executed",
  "execution-intent-settled",
  "execution-intent-refunded",
  "operator-dispatch"
];

type HotReadCacheStatus = "hit" | "stale" | "refreshing" | "inflight" | "miss";
type HotReadCacheEntry = {
  expiresAtMs: number;
  retainedUntilMs: number;
  payload: unknown;
};
type HotReadInflightEntry = {
  epoch: number;
  promise: Promise<unknown>;
};
type HotReadProducerTask = () => void;
type HotReadProducerLane = "public" | "critical";
type HotReadProducerQueueState = {
  active: number;
  queued: HotReadProducerTask[];
  concurrency: number;
  maxQueued: number;
  label: HotReadProducerLane;
};

const consoleStateCache = new Map<string, HotReadCacheEntry>();
const consoleStateInflight = new Map<string, HotReadInflightEntry>();
const paymentLedgerCache = new Map<string, HotReadCacheEntry>();
const paymentLedgerInflight = new Map<string, HotReadInflightEntry>();
const x402PaymentStateCache = new Map<string, HotReadCacheEntry>();
const x402PaymentStateInflight = new Map<string, HotReadInflightEntry>();
const publicMarketplaceSnapshotCache = new Map<string, HotReadCacheEntry>();
const publicMarketplaceSnapshotInflight = new Map<string, HotReadInflightEntry>();
const publicReadCache = new Map<string, HotReadCacheEntry>();
const publicReadInflight = new Map<string, HotReadInflightEntry>();
const publicReadRateLimitBuckets = new Map<string, {
  resetAtMs: number;
  cost: number;
}>();
let consoleStateCacheEpoch = 0;
let paymentLedgerCacheEpoch = 0;
let publicMarketplaceSnapshotCacheEpoch = 0;
let publicReadCacheEpoch = 0;
const publicHotReadProducerQueue: HotReadProducerQueueState = {
  active: 0,
  queued: [],
  concurrency: HOT_READ_PRODUCER_CONCURRENCY,
  maxQueued: HOT_READ_PRODUCER_QUEUE_MAX,
  label: "public"
};
const criticalHotReadProducerQueue: HotReadProducerQueueState = {
  active: 0,
  queued: [],
  concurrency: CRITICAL_HOT_READ_PRODUCER_CONCURRENCY,
  maxQueued: CRITICAL_HOT_READ_PRODUCER_QUEUE_MAX,
  label: "critical"
};

function hotReadQueueForLane(lane: HotReadProducerLane): HotReadProducerQueueState {
  return lane === "critical" ? criticalHotReadProducerQueue : publicHotReadProducerQueue;
}

function drainHotReadProducerQueue(queue: HotReadProducerQueueState) {
  while (queue.active < queue.concurrency) {
    const task = queue.queued.shift();
    if (!task) {
      return;
    }
    task();
  }
}

function runBoundedHotReadProducer<T>(
  producer: () => Promise<T>,
  lane: HotReadProducerLane = "public"
): Promise<T> {
  const queue = hotReadQueueForLane(lane);
  return new Promise((resolve, reject) => {
    const run = () => {
      queue.active += 1;
      Promise.resolve()
        .then(producer)
        .then(resolve, reject)
        .finally(() => {
          queue.active = Math.max(0, queue.active - 1);
          drainHotReadProducerQueue(queue);
        });
    };

    if (queue.active < queue.concurrency) {
      run();
      return;
    }

    if (queue.queued.length >= queue.maxQueued) {
      reject(new Error(`${queue.label}_hot_read_queue_saturated`));
      return;
    }

    queue.queued.push(run);
  });
}

function clearConsoleStateCache() {
  consoleStateCacheEpoch += 1;
  paymentLedgerCacheEpoch += 1;
  publicMarketplaceSnapshotCacheEpoch += 1;
  publicReadCacheEpoch += 1;
  consoleStateCache.clear();
  consoleStateInflight.clear();
  paymentLedgerCache.clear();
  paymentLedgerInflight.clear();
  x402PaymentStateCache.clear();
  x402PaymentStateInflight.clear();
  publicMarketplaceSnapshotCache.clear();
  publicMarketplaceSnapshotInflight.clear();
  publicReadCache.clear();
  publicReadInflight.clear();
}

function agentIdFromHeartbeatPath(pathname: string) {
  const match = /^\/api\/agents\/([^/]+)\/heartbeat$/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

function invalidateCachesAfterWrite(pathname: string) {
  const heartbeatAgentId = agentIdFromHeartbeatPath(pathname);
  if (heartbeatAgentId) {
    publicReadCache.delete(`agent-availability:${heartbeatAgentId}`);
    publicReadInflight.delete(`agent-availability:${heartbeatAgentId}`);
    return;
  }
  clearConsoleStateCache();
}

function invalidateAgentRuntimeStatusCaches(agentId: string) {
  if (!agentId) {
    return;
  }
  clearConsoleStateCache();
  publicReadCache.delete(`agent-availability:${agentId}`);
  publicReadInflight.delete(`agent-availability:${agentId}`);
}

function hotReadRetainedUntilMs(ttlMs: number, nowMs = Date.now()) {
  return nowMs + Math.max(ttlMs, HOT_READ_STALE_WHILE_REVALIDATE_MS);
}

function setHotReadCacheEntry(
  cache: Map<string, HotReadCacheEntry>,
  cacheKey: string,
  ttlMs: number,
  payload: unknown,
  nowMs = Date.now()
) {
  cache.set(cacheKey, {
    expiresAtMs: nowMs + ttlMs,
    retainedUntilMs: hotReadRetainedUntilMs(ttlMs, nowMs),
    payload
  });
}

function launchHotReadRefresh<T>(input: {
  cacheKey: string;
  cacheEpoch: number;
  cache: Map<string, HotReadCacheEntry>;
  inflight: Map<string, HotReadInflightEntry>;
  ttlMs: number;
  producer: () => Promise<T>;
  currentCacheEpoch: () => number;
  prune: () => void;
  lane?: HotReadProducerLane;
}) {
  const payloadPromise = runBoundedHotReadProducer(input.producer, input.lane)
    .then((payload) => {
      if (input.ttlMs > 0 && input.cacheEpoch === input.currentCacheEpoch()) {
        setHotReadCacheEntry(input.cache, input.cacheKey, input.ttlMs, payload);
        input.prune();
      }
      return payload;
    });
  const finalPromise = payloadPromise.finally(() => {
    if (input.inflight.get(input.cacheKey)?.promise === finalPromise) {
      input.inflight.delete(input.cacheKey);
    }
  });
  input.inflight.set(input.cacheKey, { epoch: input.cacheEpoch, promise: finalPromise });
  finalPromise.catch((error) => {
    console.warn(JSON.stringify({
      event: "hot_read_cache_refresh_failed",
      cacheKey: input.cacheKey,
      error: errorMessage(error, "Hot read cache refresh failed.")
    }));
  });
  return finalPromise;
}

async function cachedHotRead<T>(input: {
  cacheKey: string;
  cacheEpoch: number;
  cache: Map<string, HotReadCacheEntry>;
  inflight: Map<string, HotReadInflightEntry>;
  ttlMs: number;
  producer: () => Promise<T>;
  currentCacheEpoch: () => number;
  prune: () => void;
  lane?: HotReadProducerLane;
}): Promise<{ payload: T; cacheStatus: HotReadCacheStatus }> {
  const nowMs = Date.now();
  const cached = input.ttlMs > 0 ? input.cache.get(input.cacheKey) : undefined;
  if (cached && cached.expiresAtMs > nowMs) {
    return { payload: cached.payload as T, cacheStatus: "hit" };
  }
  const inflight = input.inflight.get(input.cacheKey);
  if (cached && cached.retainedUntilMs > nowMs) {
    if (!inflight || inflight.epoch !== input.cacheEpoch) {
      launchHotReadRefresh(input);
      return { payload: cached.payload as T, cacheStatus: "refreshing" };
    }
    return { payload: cached.payload as T, cacheStatus: "stale" };
  }
  if (inflight && inflight.epoch === input.cacheEpoch) {
    return { payload: await inflight.promise as T, cacheStatus: "inflight" };
  }
  const payload = await launchHotReadRefresh(input);
  return { payload: payload as T, cacheStatus: "miss" };
}

function pruneConsoleStateCache(nowMs = Date.now()) {
  for (const [key, entry] of consoleStateCache.entries()) {
    if (entry.retainedUntilMs <= nowMs) {
      consoleStateCache.delete(key);
    }
  }
  while (consoleStateCache.size > CONSOLE_STATE_CACHE_MAX_ENTRIES) {
    const oldest = consoleStateCache.keys().next();
    if (oldest.done) {
      break;
    }
    consoleStateCache.delete(oldest.value);
  }
}

function prunePaymentLedgerCache(nowMs = Date.now()) {
  for (const [key, entry] of paymentLedgerCache.entries()) {
    if (entry.retainedUntilMs <= nowMs) {
      paymentLedgerCache.delete(key);
    }
  }
  while (paymentLedgerCache.size > PAYMENT_LEDGER_CACHE_MAX_ENTRIES) {
    const oldest = paymentLedgerCache.keys().next();
    if (oldest.done) {
      break;
    }
    paymentLedgerCache.delete(oldest.value);
  }
}

function pruneX402PaymentStateCache(nowMs = Date.now()) {
  for (const [key, entry] of x402PaymentStateCache.entries()) {
    if (entry.retainedUntilMs <= nowMs) {
      x402PaymentStateCache.delete(key);
    }
  }
  while (x402PaymentStateCache.size > PAYMENT_LEDGER_CACHE_MAX_ENTRIES) {
    const oldest = x402PaymentStateCache.keys().next();
    if (oldest.done) {
      break;
    }
    x402PaymentStateCache.delete(oldest.value);
  }
}

function prunePublicReadCache(nowMs = Date.now()) {
  for (const [key, entry] of publicReadCache.entries()) {
    if (entry.retainedUntilMs <= nowMs) {
      publicReadCache.delete(key);
    }
  }
  while (publicReadCache.size > PUBLIC_READ_CACHE_MAX_ENTRIES) {
    const oldest = publicReadCache.keys().next();
    if (oldest.done) {
      break;
    }
    publicReadCache.delete(oldest.value);
  }
}

async function cachedPublicRead<T>(
  cacheKey: string,
  producer: () => Promise<T>,
  lane: HotReadProducerLane = "public"
): Promise<{ payload: T; cacheStatus: HotReadCacheStatus }> {
  return cachedHotRead({
    cacheKey,
    cacheEpoch: publicReadCacheEpoch,
    cache: publicReadCache,
    inflight: publicReadInflight,
    ttlMs: PUBLIC_READ_CACHE_TTL_MS,
    producer,
    currentCacheEpoch: () => publicReadCacheEpoch,
    prune: prunePublicReadCache,
    lane
  });
}

type PublicReadRouteClass = "browse" | "protocol" | "runtime";

function publicReadRoutePolicy(pathname: string, method: string): { cost: number; routeClass: PublicReadRouteClass } {
  const browse = (cost: number) => ({ cost, routeClass: "browse" as const });
  const protocol = (cost: number) => ({ cost, routeClass: "protocol" as const });
  const runtime = (cost: number) => ({ cost, routeClass: "runtime" as const });
  if (method !== "GET") {
    return browse(0);
  }
  if (pathname === "/health" || pathname === "/ready" || pathname === "/version") {
    return browse(0);
  }
  if (
    pathname === "/api/x402/plan" ||
    pathname === "/api/x402/payment-state" ||
    pathname === "/api/x402/proof" ||
    pathname === "/.well-known/x402.json" ||
    /^\/api\/agents\/[^/]+\/x402-plan$/.test(pathname)
  ) {
    return protocol(1);
  }
  if (
    /^\/api\/agents\/[^/]+\/ready$/.test(pathname) ||
    /^\/api\/agents\/[^/]+\/availability$/.test(pathname) ||
    /^\/api\/agents\/[^/]+\/relay-status$/.test(pathname)
  ) {
    return runtime(1);
  }
  if (pathname === "/api/public/marketplace-snapshot") {
    return browse(2);
  }
  if (pathname === "/api/payments") {
    return browse(20);
  }
  if (pathname === "/api/console/state") {
    return browse(30);
  }
  if (
    pathname === "/api/agents" ||
    pathname === "/api/agent-messages" ||
    pathname === "/api/workshop/receipt-ledger" ||
    /^\/api\/workshops\/[^/]+\/(messages|state)(\/[^/]+)?$/.test(pathname) ||
    /^\/api\/social\/anchors\/anchor_[^/]+$/.test(pathname) ||
    pathname === "/api/social/anchors/public"
  ) {
    return browse(10);
  }
  if (pathname === "/api/agents/search") {
    return browse(5);
  }
  if (/^\/api\/agents\/[^/]+\/payments$/.test(pathname)) {
    return browse(20);
  }
  return browse(0);
}

function publicReadRateLimitMaxCost(routeClass: PublicReadRouteClass, request: Pick<IndexerRequest, "header">): number {
  if (routeClass === "protocol") {
    return PROTOCOL_READ_RATE_LIMIT_MAX_COST;
  }
  if (routeClass === "runtime") {
    return RUNTIME_READ_RATE_LIMIT_MAX_COST;
  }
  return isFirstPartyBrowserRead(request)
    ? PUBLIC_READ_FIRST_PARTY_RATE_LIMIT_MAX_COST
    : PUBLIC_READ_RATE_LIMIT_MAX_COST;
}

function hasApiCredential(request: Pick<IndexerRequest, "header">): boolean {
  return Boolean(
    request.header("authorization") ||
    request.header("x-api-key") ||
    request.header("x-clawz-admin-key") ||
    request.header("x-santaclawz-activation-lane-key")
  );
}

function publicReadClientKey(request: Pick<IndexerRequest, "header" | "ip">): string {
  const forwardedFor = request.header("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.header("x-real-ip")?.trim();
  return forwardedFor || realIp || request.ip || "unknown";
}

function originFromHeader(value: string | undefined): string {
  if (!value) {
    return "";
  }
  try {
    return new URL(value).origin.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function isFirstPartyBrowserRead(request: Pick<IndexerRequest, "header">): boolean {
  const userAgent = request.header("user-agent") ?? "";
  if (!/mozilla|chrome|safari|firefox|edg/i.test(userAgent) || /bot|crawler|spider|urllib|curl|python|node/i.test(userAgent)) {
    return false;
  }
  const origin = originFromHeader(request.header("origin"));
  const refererOrigin = originFromHeader(request.header("referer"));
  return PUBLIC_READ_FIRST_PARTY_ORIGINS.has(origin) || PUBLIC_READ_FIRST_PARTY_ORIGINS.has(refererOrigin);
}

function prunePublicReadRateLimitBuckets(nowMs = Date.now()) {
  for (const [key, bucket] of publicReadRateLimitBuckets.entries()) {
    if (bucket.resetAtMs <= nowMs) {
      publicReadRateLimitBuckets.delete(key);
    }
  }
}

interface PublicReadRateLimitRequest extends IndexerRequest {
  method: string;
  path?: string;
  originalUrl?: string;
}

interface PublicReadRateLimitResponse extends IndexerResponse {
  setHeader?(name: string, value: string): void;
}

function publicReadRateLimitMiddleware(request: unknown, response: unknown, next: () => void) {
  const typedRequest = request as PublicReadRateLimitRequest;
  const typedResponse = response as PublicReadRateLimitResponse;
  const pathname = typedRequest.path ?? typedRequest.originalUrl?.split("?")[0] ?? "";
  const { cost, routeClass } = publicReadRoutePolicy(pathname, typedRequest.method);
  if (cost <= 0 || hasApiCredential(typedRequest)) {
    next();
    return;
  }

  const nowMs = Date.now();
  prunePublicReadRateLimitBuckets(nowMs);
  const key = `${routeClass}:${publicReadClientKey(typedRequest)}`;
  const existing = publicReadRateLimitBuckets.get(key);
  const bucket = existing && existing.resetAtMs > nowMs
    ? existing
    : { resetAtMs: nowMs + PUBLIC_READ_RATE_LIMIT_WINDOW_MS, cost: 0 };
  bucket.cost += cost;
  publicReadRateLimitBuckets.set(key, bucket);
  const maxCost = publicReadRateLimitMaxCost(routeClass, typedRequest);
  if (bucket.cost <= maxCost) {
    next();
    return;
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAtMs - nowMs) / 1000));
  typedResponse.set?.("Retry-After", String(retryAfterSeconds));
  typedResponse.set?.("X-SantaClawz-RateLimit-Cost", String(cost));
  typedResponse.set?.("X-SantaClawz-RateLimit-Class", routeClass);
  typedResponse.set?.("X-SantaClawz-RateLimit-Limit", String(maxCost));
  typedResponse.set?.("X-SantaClawz-RateLimit-Remaining", "0");
  typedResponse.status(429).json({
    ok: false,
    code: "public_read_rate_limited",
    rateLimitClass: routeClass,
    retryable: true,
    retryAfterSeconds,
    error: "SantaClawz public read capacity is busy. Please retry shortly."
  });
}

function deploymentVersion() {
  return {
    commitSha:
      process.env.RENDER_GIT_COMMIT ??
      process.env.COMMIT_SHA ??
      process.env.GIT_COMMIT ??
      process.env.SOURCE_VERSION ??
      "unknown",
    renderServiceId: process.env.RENDER_SERVICE_ID,
    renderServiceName: process.env.RENDER_SERVICE_NAME,
    nodeEnv: process.env.NODE_ENV,
    runtimeEnv: process.env.CLAWZ_RUNTIME_ENV,
    apiFeatures: [
      "late_completion_endpoint",
      "state_path_workspace",
      "late_ws_hire_response_recovery",
      "post_ack_timeout_reconcilable"
    ],
    startedAtIso,
    uptimeSeconds: Math.max(0, Math.round((Date.now() - startedAtMs) / 1000))
  };
}

interface IndexerRequest<
  Params extends Record<string, string> = Record<string, string>,
  ReqBody = unknown,
  ReqQuery extends Record<string, unknown> = Record<string, unknown>
> {
  body: ReqBody;
  ip?: string;
  method: string;
  params: Params;
  query: ReqQuery;
  header(name: string): string | undefined;
}

interface IndexerResponse<ResBody = unknown> {
  end(): IndexerResponse<ResBody>;
  json(body: ResBody | unknown): IndexerResponse<ResBody>;
  set(name: string, value: string): IndexerResponse<ResBody>;
  send(body?: string | Buffer): IndexerResponse<ResBody>;
  status(code: number): IndexerResponse<ResBody>;
  type(contentType: string): IndexerResponse<ResBody>;
}
interface CacheInvalidationRequest {
  method: string;
  originalUrl?: string;
  path?: string;
}
interface CacheInvalidationResponse {
  statusCode: number;
  on(eventName: "finish", handler: () => void): void;
}

function route<
  Params extends Record<string, string> = Record<string, string>,
  ReqBody = unknown,
  ReqQuery extends Record<string, unknown> = Record<string, unknown>
>(
  handler: (
    request: IndexerRequest<Params, ReqBody, ReqQuery>,
    response: IndexerResponse
  ) => void | Promise<void>
) {
  return (request: unknown, response: unknown, next?: (error: unknown) => void) => {
    const typedResponse = response as IndexerResponse & { headersSent?: boolean };
    Promise.resolve(
      handler(
        request as IndexerRequest<Params, ReqBody, ReqQuery>,
        typedResponse
      )
    ).catch((error) => {
      if (typedResponse.headersSent) {
        if (typeof next === "function") {
          next(error);
        }
        return;
      }
      const hotReadQueueSaturated = isHotReadQueueSaturationError(error);
      typedResponse.status(hotReadQueueSaturated ? 503 : 400).json({
        ...(hotReadQueueSaturated
          ? {
              ok: false,
              code: "read_capacity_temporarily_unavailable",
              retryable: true,
              recommendedPollAfterMs: 2000
            }
          : {}),
        error: errorMessage(error, "Request failed.")
      });
    });
  };
}

app.use(securityMiddleware(securityConfig));
app.options(
  "*",
  route((_request, response) => {
    response.status(204).end();
  })
);
app.use(apiAuthMiddleware(securityConfig));
app.use(publicReadRateLimitMiddleware);
app.use(express.json({ limit: "64kb" }));
app.use((request: CacheInvalidationRequest, response: CacheInvalidationResponse, next: () => void) => {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    next();
    return;
  }
  response.on("finish", () => {
    if (response.statusCode >= 200 && response.statusCode < 400) {
      invalidateCachesAfterWrite(request.path ?? request.originalUrl?.split("?")[0] ?? "");
    }
  });
  next();
});

const clawzDataDir = process.env.CLAWZ_DATA_DIR?.trim() || path.join(process.cwd(), ".clawz-data");
const controlPlane = await ClawzControlPlane.boot(clawzDataDir);
controlPlane.startSharedSocialAnchorDrainer();
startNetworkFacilitationFeeMonitor();
const artifactStore = new ArtifactStore(process.env.CLAWZ_ARTIFACT_STORE_DIR?.trim() || path.join(clawzDataDir, "artifacts"));
await artifactStore.ensureDirs();
void artifactStore.cleanupExpired().catch((error) => {
  console.error(`Artifact cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
});
const artifactCleanupInterval = setInterval(() => {
  void artifactStore.cleanupExpired().catch((error) => {
    console.error(`Artifact cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}, 6 * 60 * 60 * 1000);
const artifactCleanupIntervalWithUnref = artifactCleanupInterval as unknown as { unref?: () => void };
artifactCleanupIntervalWithUnref.unref?.();
const REGISTRATION_WINDOW_MS = 15 * 60 * 1000;
const REGISTRATION_LIMIT = 5;
const registrationAttempts = new Map<string, { count: number; resetAt: number }>();
const QUOTE_ACCEPT_WINDOW_MS = 5 * 60 * 1000;
const QUOTE_ACCEPT_LIMIT_PER_AGENT = 24;
const QUOTE_ACCEPT_LIMIT_PER_BUYER_AGENT = 24;
const QUOTE_ACCEPT_LIMIT_PER_BUYER_WALLET = 12;
const QUOTE_ACCEPT_LIMIT_PER_IP = 60;
const quoteAcceptAttempts = new Map<string, { count: number; resetAt: number }>();
const LIVE_FLOW_KINDS = ["first-turn", "next-turn", "abort-turn", "refund-turn", "revoke-disclosure"] as const;
type LiveFlowKind = (typeof LIVE_FLOW_KINDS)[number];
type TrustModeRequestBody = { modeId?: unknown; sessionId?: unknown };
type RegisterAgentRequestBody = {
  agentName?: unknown;
  representedPrincipal?: unknown;
  headline?: unknown;
  urlReservationSalt?: unknown;
  publicClawzUrl?: unknown;
  openClawUrl?: unknown;
  runtimeDelivery?: unknown;
  payoutAddress?: unknown;
  payoutWallets?: unknown;
  missionAuthOverlay?: unknown;
  paymentProfile?: unknown;
  marketplaceTags?: unknown;
  contextRequirements?: unknown;
  socialAnchorPolicy?: unknown;
  trustModeId?: unknown;
  preferredProvingLocation?: unknown;
};
type EnrollmentTicketRedeemBody = {
  ticket?: unknown;
  openClawUrl?: unknown;
  runtimeIngressUrl?: unknown;
};
type CoordinationSetupTicketClaimBody = {
  ticket?: unknown;
  agentId?: unknown;
};
type ProfileRequestBody = {
  agentName?: unknown;
  representedPrincipal?: unknown;
  headline?: unknown;
  publicClawzUrl?: unknown;
  openClawUrl?: unknown;
  runtimeDelivery?: unknown;
  payoutAddress?: unknown;
  payoutWallets?: unknown;
  missionAuthOverlay?: unknown;
  paymentProfile?: unknown;
  marketplaceTags?: unknown;
  contextRequirements?: unknown;
  socialAnchorPolicy?: unknown;
  preferredProvingLocation?: unknown;
  sessionId?: unknown;
};
type MissionAuthOverlayRequestBody = {
  missionAuthOverlay?: unknown;
  sessionId?: unknown;
  agentId?: unknown;
};
type OwnershipActionRequestBody = {
  sessionId?: unknown;
  agentId?: unknown;
};
type HireRequestBody = {
  taskPrompt?: unknown;
  budgetMina?: unknown;
  requesterContact?: unknown;
  marketplaceTags?: unknown;
  jobContext?: unknown;
  context?: unknown;
  jobPrivacy?: unknown;
  activityPrivacy?: unknown;
  artifactDelivery?: unknown;
  paymentPayload?: unknown;
  activationLane?: unknown;
  activation_lane?: unknown;
  activationProbe?: unknown;
  activation_probe?: unknown;
  sellerReadinessTest?: unknown;
  seller_readiness_test?: unknown;
};
type ArtifactReceiptBody = {
  deliveryMode?: unknown;
  transport?: unknown;
  scanPolicy?: unknown;
  buyerAcceptanceRequired?: unknown;
  filename?: unknown;
  contentType?: unknown;
  artifactDigestSha256?: unknown;
  artifactSizeBytes?: unknown;
  artifactUrl?: unknown;
  deliveryChannel?: unknown;
  sellerDeliveryReceipt?: unknown;
  sellerSignature?: unknown;
  deliveredAtIso?: unknown;
};
type ArtifactReceiptAcknowledgementBody = {
  accepted?: unknown;
  note?: unknown;
  bytesReceivedByBuyer?: unknown;
  digestVerified?: unknown;
  buyerScanStatus?: unknown;
};
type JobMessageBody = {
  authorRole?: unknown;
  body?: unknown;
  stage?: unknown;
  artifactDigestSha256?: unknown;
};
type JobStageBody = {
  authorRole?: unknown;
  stage?: unknown;
  status?: unknown;
  label?: unknown;
  note?: unknown;
  artifactDigestSha256?: unknown;
};
type LateHireCompletionBody = {
  statusCode?: unknown;
  body?: unknown;
  bodyBase64?: unknown;
  bodyEncoding?: unknown;
  relayMessageId?: unknown;
  requestBodyDigestSha256?: unknown;
  workerStatusCode?: unknown;
  workerResponseBytes?: unknown;
  workerResponseDigestSha256?: unknown;
  relayBodyBytes?: unknown;
  relayBodyDigestSha256?: unknown;
  source?: unknown;
};
type QuoteAcceptRequestBody = {
  buyerAgentId?: unknown;
  buyerWallet?: unknown;
  buyerWalletProof?: unknown;
  acceptedAmountUsd?: unknown;
  acceptedQuoteDigestSha256?: unknown;
  maxAmountUsd?: unknown;
  rail?: unknown;
  settlementModel?: unknown;
};
type AgentHeartbeatRequestBody = {
  sessionId?: unknown;
  status?: unknown;
  ttlSeconds?: unknown;
  note?: unknown;
  relayAgentProtocolVersion?: unknown;
  relayAgentBuild?: unknown;
  relayAgentFeatures?: unknown;
  relayAgentWorkerRoutes?: unknown;
  relayAgentWorkerWarnings?: unknown;
  relayAgentWorkerTiming?: unknown;
  paidExecutionProbe?: unknown;
};
type SponsorRequestBody = { amountMina?: unknown; sessionId?: unknown; purpose?: unknown };
type RecoveryRequestBody = { sessionId?: unknown };
type PrivacyExceptionApprovalBody = {
  actorRole?: unknown;
  actorId?: unknown;
  note?: unknown;
  sessionId?: unknown;
};
type ProcurementIntentBody = {
  idempotencyKey?: unknown;
  taskPrompt?: unknown;
  requesterContact?: unknown;
  budgetUsd?: unknown;
  deadlineIso?: unknown;
  bidWindowClosesAtIso?: unknown;
  requiredCapabilities?: unknown;
  preferredDeliveryModes?: unknown;
  preferredPrivacyModes?: unknown;
  marketplaceTags?: unknown;
  jobContext?: unknown;
  context?: unknown;
  jobPrivacy?: unknown;
  artifactDelivery?: unknown;
};
type BuyerRouterPlanBody = {
  taskPrompt?: unknown;
  buyerMode?: unknown;
  requesterContact?: unknown;
  budgetUsd?: unknown;
  privacyLane?: unknown;
  marketplaceTags?: unknown;
  selectedAgentId?: unknown;
};
type HostedWorkspaceEmailCodeBody = {
  orgName?: unknown;
  workspaceDomain?: unknown;
  email?: unknown;
  challengeId?: unknown;
  code?: unknown;
};
type HostedWorkspaceRunBody = {
  orgName?: unknown;
  workspaceDomain?: unknown;
  workspaceSessionToken?: unknown;
  identityProvider?: unknown;
  projectName?: unknown;
  goal?: unknown;
  threadId?: unknown;
  swarmId?: unknown;
  requesterContact?: unknown;
  budgetUsd?: unknown;
  privacyMode?: unknown;
  requiredCapabilities?: unknown;
  selectedAgentIds?: unknown;
  toolTouchpoints?: unknown;
  manifest?: unknown;
  procurementIntentId?: unknown;
};
type ProcurementBidBody = {
  idempotencyKey?: unknown;
  agentId?: unknown;
  amountUsd?: unknown;
  summary?: unknown;
  estimatedDeliveryIso?: unknown;
  deliveryModes?: unknown;
  privacyModes?: unknown;
};
type ProcurementDeclineBody = {
  idempotencyKey?: unknown;
  agentId?: unknown;
  reason?: unknown;
};
type ProcurementAcceptBody = {
  bidId?: unknown;
  token?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLiveFlowKind(value: string): value is LiveFlowKind {
  return LIVE_FLOW_KINDS.includes(value as LiveFlowKind);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function queryString(query: unknown, key: string): string | undefined {
  if (!isRecord(query)) {
    return undefined;
  }

  return typeof query[key] === "string" && query[key].trim().length > 0 ? query[key].trim() : undefined;
}

function adminKeyHeader(request: IndexerRequest) {
  return optionalString(request.header("x-clawz-admin-key"));
}

function workshopTokenHeader(request: IndexerRequest) {
  return optionalString(request.header("x-santaclawz-workshop-token"));
}

function cacheKeyDigest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function idempotencyKeyHeader(request: IndexerRequest) {
  return optionalString(request.header("idempotency-key") ?? request.header("x-idempotency-key"));
}

function bearerTokenHeader(request: IndexerRequest) {
  const authorization = request.header("authorization");
  const bearerPrefix = "bearer ";
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith(bearerPrefix)) {
    return authorization.slice(bearerPrefix.length).trim();
  }
  return undefined;
}

function activationLaneTokenHeader(request: IndexerRequest) {
  return optionalString(request.header("x-santaclawz-activation-lane-key")) ?? bearerTokenHeader(request);
}

function workspaceSessionTokenHeader(request: IndexerRequest) {
  return optionalString(request.header("x-santaclawz-workspace-session")) ?? bearerTokenHeader(request);
}

function activationLaneToken() {
  return optionalString(process.env.CLAWZ_ACTIVATION_LANE_TOKEN ?? process.env.CLAWZ_AGENT_JOB_PACK_ACTIVATION_TOKEN);
}

function requireActivationLaneAccess(request: IndexerRequest, response: IndexerResponse) {
  const configuredToken = activationLaneToken();
  if (!configuredToken) {
    response.status(503).json({
      ok: false,
      code: "activation_lane_not_configured",
      error: "SantaClawz activation lane is not configured on this deployment."
    });
    return false;
  }
  if (activationLaneTokenHeader(request) !== configuredToken) {
    response.status(401).json({
      ok: false,
      code: "activation_lane_auth_required",
      error: "Activation lane access requires the hosted Job Pack activation token."
    });
    return false;
  }
  return true;
}

function parseUsdMicros(value: string | undefined, fallback: string) {
  const normalized = (value ?? fallback).trim();
  const match = /^([0-9]+)(?:\.([0-9]{1,6}))?$/.exec(normalized);
  if (!match) {
    return parseUsdMicros(fallback, "0");
  }
  const whole = BigInt(match[1] ?? "0") * USD_MICRO_SCALE;
  const fractional = BigInt((match[2] ?? "").padEnd(6, "0"));
  return whole + fractional;
}

function formatUsdMicros(value: bigint) {
  const whole = value / USD_MICRO_SCALE;
  const fraction = value % USD_MICRO_SCALE;
  const fractionText = fraction.toString().padStart(6, "0").replace(/0+$/, "");
  return fractionText.length > 0 ? `${whole}.${fractionText}` : whole.toString();
}

function activationLaneAmountUsd() {
  const explicit = optionalString(process.env.CLAWZ_ACTIVATION_LANE_AMOUNT_USD);
  if (explicit) {
    return formatUsdMicros(parseUsdMicros(explicit, "0.002001"));
  }
  const minimum = parseUsdMicros(
    process.env.CLAWZ_MIN_PAID_JOB_AMOUNT_USD ?? process.env.CLAWZ_ACTIVATION_LANE_MIN_USD,
    ACTIVATION_LANE_DEFAULT_MIN_USD
  );
  const epsilon = parseUsdMicros(process.env.CLAWZ_ACTIVATION_LANE_EPSILON_USD, ACTIVATION_LANE_DEFAULT_EPSILON_USD);
  return formatUsdMicros(minimum + epsilon);
}

function activationLaneRetrySeconds() {
  const rawValue = Number.parseInt(process.env.CLAWZ_ACTIVATION_LANE_RETRY_SECONDS ?? "3600", 10);
  return Number.isFinite(rawValue) ? Math.max(60, rawValue) : 3600;
}

function activationLaneIntervalSeconds() {
  const rawValue = Number.parseInt(
    process.env.CLAWZ_ACTIVATION_LANE_INTERVAL_SECONDS ?? String(ACTIVATION_LANE_DEFAULT_INTERVAL_SECONDS),
    10
  );
  return Number.isFinite(rawValue) ? Math.max(5, rawValue) : ACTIVATION_LANE_DEFAULT_INTERVAL_SECONDS;
}

function parseActivationLaneAttemptStatus(value: unknown): AgentActivationLaneAttemptStatus {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    normalized === "candidate_seen" ||
    normalized === "challenge_ok" ||
    normalized === "paid_probe_started" ||
    normalized === "paid_probe_completed" ||
    normalized === "payment_failed" ||
    normalized === "seller_failed" ||
    normalized === "platform_failed" ||
    normalized === "preview_only" ||
    normalized === "unknown_failed"
  ) {
    return normalized;
  }
  return "unknown_failed";
}

function parseActivationProbeClassification(value: unknown): AgentActivationProbeClassification | undefined {
  return value === "payment" || value === "platform" || value === "seller" || value === "unknown" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function tokenQuery(request: IndexerRequest) {
  return queryString(request.query, "token");
}

function queryFlag(request: IndexerRequest, key: string) {
  const value = queryString(request.query, key);
  return value === "1" || value === "true" || value === "yes";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? value.split(",").map((item) => item.trim()).filter(Boolean)
      : [];
}

function parseAgentMarketplaceTags(value: unknown): Partial<AgentMarketplaceTags> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const tags: Partial<AgentMarketplaceTags> = {};
  if ("capabilities" in value) tags.capabilities = stringArray(value.capabilities);
  if ("domains" in value) tags.domains = stringArray(value.domains);
  if ("inputTypes" in value) tags.inputTypes = stringArray(value.inputTypes);
  if ("outputTypes" in value) tags.outputTypes = stringArray(value.outputTypes);
  if ("tools" in value) tags.tools = stringArray(value.tools);
  if ("runtimes" in value) tags.runtimes = stringArray(value.runtimes);
  return Object.keys(tags).length > 0 ? tags : undefined;
}

function parseMarketplaceWorkTags(value: unknown): Partial<MarketplaceWorkTags> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    jobTags: stringArray(value.jobTags),
    capabilityTags: stringArray(value.capabilityTags),
    inputTags: stringArray(value.inputTags),
    outputTags: stringArray(value.outputTags)
  };
}

function parseContextRequirements(value: unknown): Partial<SantaClawzContextRequirements> | undefined {
  return isRecord(value) ? value as Partial<SantaClawzContextRequirements> : undefined;
}

function parseJobContext(value: unknown): SantaClawzJobContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const stringValue = (input: unknown, maxLength: number) =>
    typeof input === "string" && input.trim().length > 0 ? input.trim().slice(0, maxLength) : undefined;
  const urlValues = [
    ...(Array.isArray(value.urls) ? value.urls : []),
    value.url,
    value.artifactUrl
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  const urls = Array.from(new Set(urlValues.map((item) => item.trim().slice(0, 2048)))).slice(0, 12);
  const text = stringValue(value.text, 12000) ?? stringValue(value.inputText, 12000) ?? stringValue(value.diffText, 12000);
  const rawAttachments = Array.isArray(value.attachments) ? value.attachments : [];
  const attachments = rawAttachments
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .slice(0, 16)
    .map((item) => {
      const rawKind = typeof item.kind === "string" ? item.kind : "";
      const kind =
        rawKind === "document" || rawKind === "image" || rawKind === "structured_data"
          ? rawKind
          : "file";
      const digestSha256 = stringValue(item.digestSha256, 80)?.toLowerCase();
      const sizeBytes = typeof item.sizeBytes === "number" && Number.isFinite(item.sizeBytes) && item.sizeBytes >= 0
        ? Math.floor(item.sizeBytes)
        : undefined;
      return {
        kind,
        ...(stringValue(item.name, 160) ? { name: stringValue(item.name, 160)! } : {}),
        ...(stringValue(item.url, 2048) ? { url: stringValue(item.url, 2048)! } : {}),
        ...(stringValue(item.uploadId, 160) ? { uploadId: stringValue(item.uploadId, 160)! } : {}),
        ...(digestSha256 && /^[a-f0-9]{64}$/.test(digestSha256) ? { digestSha256 } : {}),
        ...(stringValue(item.contentType, 120) ? { contentType: stringValue(item.contentType, 120)! } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {})
      } satisfies NonNullable<SantaClawzJobContext["attachments"]>[number];
    });
  const artifactDigestSha256 = stringValue(value.artifactDigestSha256, 80)?.toLowerCase();
  const legacyAttachment =
    stringValue(value.artifactUploadId, 160) || stringValue(value.artifactUrl, 2048) || artifactDigestSha256
      ? {
          kind: "file" as const,
          ...(stringValue(value.artifactUrl, 2048) ? { url: stringValue(value.artifactUrl, 2048)! } : {}),
          ...(stringValue(value.artifactUploadId, 160) ? { uploadId: stringValue(value.artifactUploadId, 160)! } : {}),
          ...(artifactDigestSha256 && /^[a-f0-9]{64}$/.test(artifactDigestSha256) ? { digestSha256: artifactDigestSha256 } : {})
        }
      : undefined;
  const structuredData =
    value.structuredData !== undefined && Buffer.byteLength(JSON.stringify(value.structuredData), "utf8") <= 12000
      ? value.structuredData
      : undefined;
  const context: SantaClawzJobContext = {
    ...(urls.length > 0 ? { urls } : {}),
    ...(text ? { text } : {}),
    ...(attachments.length > 0 || legacyAttachment ? { attachments: [...attachments, ...(legacyAttachment ? [legacyAttachment] : [])] } : {}),
    ...(structuredData !== undefined ? { structuredData } : {}),
    ...(stringValue(value.note, 1000) ? { note: stringValue(value.note, 1000)! } : {})
  };
  return Object.keys(context).length > 0 ? context : undefined;
}

const CONTEXT_INPUT_FIELD_SET = new Set<SantaClawzContextInputField>([
  "url",
  "text",
  "document",
  "image",
  "file",
  "structured_data"
]);

function jobContextHasField(context: SantaClawzJobContext | undefined, field: SantaClawzContextInputField): boolean {
  if (!context) {
    return false;
  }
  if (field === "url") {
    return Boolean(context.urls?.length) || Boolean(context.attachments?.some((item) => item.url));
  }
  if (field === "text") {
    return typeof context.text === "string" && context.text.trim().length > 0;
  }
  if (field === "file") {
    return Boolean(context.attachments?.length);
  }
  if (field === "document" || field === "image") {
    return Boolean(context.attachments?.some((item) => item.kind === field));
  }
  if (field === "structured_data") {
    return context.structuredData !== undefined || Boolean(context.attachments?.some((item) => item.kind === "structured_data"));
  }
  return false;
}

function evaluateContextRequirements(
  requirements: SantaClawzContextRequirements | undefined,
  context: SantaClawzJobContext | undefined
) {
  const missing = (requirements?.hardRequirements ?? [])
    .map((requirement) => {
      const anyOf = (requirement.anyOf ?? []).filter((field) => CONTEXT_INPUT_FIELD_SET.has(field));
      const allOf = (requirement.allOf ?? []).filter((field) => CONTEXT_INPUT_FIELD_SET.has(field));
      const anySatisfied = anyOf.length === 0 || anyOf.some((field) => jobContextHasField(context, field));
      const allSatisfied = allOf.every((field) => jobContextHasField(context, field));
      if (anySatisfied && allSatisfied) {
        return undefined;
      }
      return {
        key: requirement.key,
        ...(requirement.label ? { label: requirement.label } : {}),
        ...(anyOf.length > 0 ? { anyOf } : {}),
        ...(allOf.length > 0 ? { allOf } : {}),
        ...(requirement.buyerMessage ? { buyerMessage: requirement.buyerMessage } : {}),
        missingCode: requirement.missingCode ?? "missing_required_input" as SantaClawzContextFailureCode
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  return {
    ok: missing.length === 0,
    missing
  };
}

function requestBaseUrl(request: IndexerRequest) {
  const configured = process.env.CLAWZ_SITE_BASE?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  const proto = request.header("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  const host = request.header("x-forwarded-host")?.split(",")[0]?.trim() || request.header("host")?.trim();
  if (host) {
    return `${proto}://${host}`.replace(/\/+$/, "");
  }
  return "https://santaclawz.ai";
}

function contentDispositionAttachment(filename: string) {
  const safe = filename.replace(/["\\\r\n]/g, "_");
  return `attachment; filename="${safe}"`;
}

function artifactDigestHeader(digestSha256: string) {
  return `sha-256=${Buffer.from(digestSha256, "hex").toString("base64")}`;
}

function artifactAccessFailurePayload(artifactId: string, error: unknown) {
  const message = errorMessage(error, "Artifact is not available.");
  const expired = /expired/i.test(message);
  return {
    ok: false,
    code: expired ? "artifact_expired" : "artifact_not_found_or_unauthorized",
    retryable: false,
    artifactId,
    buyerMessage: expired
      ? "This artifact link has expired. Ask the seller for a fresh artifact receipt or manifest."
      : "SantaClawz could not authorize this artifact link. Check the artifact URL and token.",
    error: message
  };
}

function parseArtifactRangeHeader(rangeHeader: string | undefined, totalBytes: number) {
  if (!rangeHeader) {
    return undefined;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return null;
  }
  const [, startRaw = "", endRaw = ""] = match;
  if (!startRaw && !endRaw) {
    return null;
  }
  let start: number;
  let end: number;
  if (!startRaw) {
    const suffixLength = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(0, totalBytes - suffixLength);
    end = totalBytes - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    end = endRaw ? Number.parseInt(endRaw, 10) : totalBytes - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= totalBytes) {
    return null;
  }
  return {
    start,
    end: Math.min(end, totalBytes - 1)
  };
}

function requestIdentity(request: IndexerRequest) {
  const forwarded = request.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  const realIp = request.header("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }
  return request.ip?.trim() || "unknown";
}

function enforceRegistrationRateLimit(request: IndexerRequest) {
  const identity = requestIdentity(request);
  const now = Date.now();
  const existing = registrationAttempts.get(identity);
  if (!existing || existing.resetAt <= now) {
    registrationAttempts.set(identity, {
      count: 1,
      resetAt: now + REGISTRATION_WINDOW_MS
    });
    return;
  }

  if (existing.count >= REGISTRATION_LIMIT) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    const error = new Error("Too many registration attempts. Try again in a few minutes.");
    (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds = retryAfterSeconds;
    throw error;
  }

  existing.count += 1;
  registrationAttempts.set(identity, existing);
}

function consumeQuoteAcceptRateLimit(key: string, limit: number) {
  const now = Date.now();
  const existing = quoteAcceptAttempts.get(key);
  if (!existing || existing.resetAt <= now) {
    quoteAcceptAttempts.set(key, {
      count: 1,
      resetAt: now + QUOTE_ACCEPT_WINDOW_MS
    });
    return;
  }

  if (existing.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    const error = new Error("Too many quote acceptance attempts. Try again in a few minutes.");
    (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds = retryAfterSeconds;
    throw error;
  }

  existing.count += 1;
  quoteAcceptAttempts.set(key, existing);
  if (quoteAcceptAttempts.size > 5000) {
    for (const [bucketKey, bucket] of quoteAcceptAttempts.entries()) {
      if (bucket.resetAt <= now) {
        quoteAcceptAttempts.delete(bucketKey);
      }
    }
  }
}

function enforceQuoteAcceptRateLimit(request: IndexerRequest, input: {
  agentId: string;
  buyerAgentId?: string;
  buyerWallet?: string;
}) {
  consumeQuoteAcceptRateLimit(`quote-agent:${input.agentId}`, QUOTE_ACCEPT_LIMIT_PER_AGENT);
  consumeQuoteAcceptRateLimit(`quote-ip:${requestIdentity(request)}`, QUOTE_ACCEPT_LIMIT_PER_IP);
  if (input.buyerAgentId?.trim()) {
    consumeQuoteAcceptRateLimit(`quote-buyer-agent:${input.buyerAgentId.trim().slice(0, 96)}`, QUOTE_ACCEPT_LIMIT_PER_BUYER_AGENT);
  }
  if (input.buyerWallet?.trim()) {
    consumeQuoteAcceptRateLimit(`quote-buyer-wallet:${input.buyerWallet.trim().toLowerCase()}`, QUOTE_ACCEPT_LIMIT_PER_BUYER_WALLET);
  }
}

function parsePayoutWallets(value: unknown): AgentProfileState["payoutWallets"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    ...(typeof value.zeko === "string" ? { zeko: value.zeko } : {}),
    ...(typeof value.base === "string" ? { base: value.base } : {}),
    ...(typeof value.ethereum === "string" ? { ethereum: value.ethereum } : {})
  };
}

function parseArtifactDeliveryPreference(value: unknown): SantaClawzArtifactDeliveryPreference | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const allowedModes = new Set([
    "platform_scanned",
    "buyer_encrypted",
    "direct_receipt",
    "external_reference",
    "agent_inbox",
    "streaming"
  ]);
  const mode = typeof value.mode === "string" && allowedModes.has(value.mode) ? value.mode as SantaClawzArtifactDeliveryPreference["mode"] : undefined;
  if (!mode) {
    throw new Error("artifactDelivery.mode must be platform_scanned, buyer_encrypted, direct_receipt, external_reference, agent_inbox, or streaming.");
  }
  const scanPolicies = new Set(["platform_required", "buyer_required", "external_unverified", "external_verified", "none"]);
  const scanPolicy =
    typeof value.scanPolicy === "string" && scanPolicies.has(value.scanPolicy)
      ? value.scanPolicy as NonNullable<SantaClawzArtifactDeliveryPreference["scanPolicy"]>
      : typeof value.scan_policy === "string" && scanPolicies.has(value.scan_policy)
        ? value.scan_policy as NonNullable<SantaClawzArtifactDeliveryPreference["scanPolicy"]>
        : undefined;
  const encryptionScheme = typeof value.encryptionScheme === "string"
    ? value.encryptionScheme.trim().slice(0, 40)
    : typeof value.encryption_scheme === "string"
      ? value.encryption_scheme.trim().slice(0, 40)
      : undefined;
  const buyerPublicKey = typeof value.buyerPublicKey === "string"
    ? value.buyerPublicKey.trim().slice(0, 512)
    : typeof value.buyer_public_key === "string"
      ? value.buyer_public_key.trim().slice(0, 512)
      : undefined;
  const acceptedFormatsSource = Array.isArray(value.acceptedFormats)
    ? value.acceptedFormats
    : Array.isArray(value.accepted_formats)
      ? value.accepted_formats
      : undefined;
  const acceptedFormats = acceptedFormatsSource
    ?.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 24))
    .slice(0, 8);
  const localScanRequired =
    typeof value.localScanRequired === "boolean"
      ? value.localScanRequired
      : typeof value.local_scan_required === "boolean"
        ? value.local_scan_required
        : mode === "buyer_encrypted";
  const transport =
    typeof value.transport === "string"
      ? value.transport.trim().slice(0, 80)
      : undefined;
  const buyerInboxUrl =
    typeof value.buyerInboxUrl === "string"
      ? value.buyerInboxUrl.trim().slice(0, 512)
      : typeof value.buyer_inbox_url === "string"
        ? value.buyer_inbox_url.trim().slice(0, 512)
        : undefined;

  if (mode === "buyer_encrypted" && !buyerPublicKey) {
    throw new Error("artifactDelivery.buyerPublicKey is required for buyer_encrypted delivery.");
  }

  return {
    mode,
    ...(scanPolicy ? { scanPolicy } : {}),
    digestRequired: typeof value.digestRequired === "boolean" ? value.digestRequired : true,
    buyerAcceptanceRequired:
      typeof value.buyerAcceptanceRequired === "boolean"
        ? value.buyerAcceptanceRequired
        : typeof value.buyer_acceptance_required === "boolean"
          ? value.buyer_acceptance_required
          : mode !== "platform_scanned",
    ...(encryptionScheme ? { encryptionScheme } : {}),
    ...(buyerPublicKey ? { buyerPublicKey } : {}),
    ...(acceptedFormats && acceptedFormats.length > 0 ? { acceptedFormats } : {}),
    localScanRequired,
    ...(transport ? { transport } : {}),
    ...(buyerInboxUrl ? { buyerInboxUrl } : {})
  };
}

function parseJobPrivacyPreference(value: unknown): SantaClawzJobPrivacyPreference | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const visibility = value.visibility === "private" ? "private" : value.visibility === "public" ? "public" : undefined;
  if (!visibility) {
    throw new Error("jobPrivacy.visibility must be public or private.");
  }
  const publicAggregateStats = true;
  const publicLifecycleEvents =
    typeof value.publicLifecycleEvents === "boolean"
      ? value.publicLifecycleEvents
      : typeof value.public_lifecycle_events === "boolean"
        ? value.public_lifecycle_events
        : visibility === "public";
  const publicArtifactMetadata =
    typeof value.publicArtifactMetadata === "boolean"
      ? value.publicArtifactMetadata
      : typeof value.public_artifact_metadata === "boolean"
        ? value.public_artifact_metadata
        : visibility === "public";
  const note = typeof value.note === "string" ? value.note.trim().slice(0, 240) : undefined;

  return {
    visibility,
    publicAggregateStats,
    publicLifecycleEvents,
    publicArtifactMetadata,
    ...(note ? { note } : {})
  };
}

function parsePaymentProfile(value: unknown): Partial<AgentProfileState["paymentProfile"]> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    ...(Array.isArray(value.supportedRails)
      ? {
          supportedRails: value.supportedRails.filter(
            (rail): rail is AgentProfileState["paymentProfile"]["supportedRails"][number] =>
              rail === "base-usdc" || rail === "ethereum-usdc" || rail === "zeko-native"
          )
        }
      : {}),
    ...(value.defaultRail === "base-usdc" || value.defaultRail === "ethereum-usdc" || value.defaultRail === "zeko-native"
      ? { defaultRail: value.defaultRail }
      : {}),
    ...(value.pricingMode === "fixed-exact" ||
    value.pricingMode === "quote-required" ||
    value.pricingMode === "free-test"
      ? { pricingMode: value.pricingMode }
      : {}),
    ...(typeof value.fixedAmountUsd === "string" ? { fixedAmountUsd: value.fixedAmountUsd } : {}),
    ...(typeof value.maxAmountUsd === "string" ? { maxAmountUsd: value.maxAmountUsd } : {}),
    ...(typeof value.quoteUrl === "string" ? { quoteUrl: value.quoteUrl } : {}),
    ...(typeof value.referencePriceUsd === "string" ? { referencePriceUsd: value.referencePriceUsd } : {}),
    ...(value.referencePriceUnit === "minimum" ||
    value.referencePriceUnit === "agent-minute" ||
    value.referencePriceUnit === "compute-unit"
      ? { referencePriceUnit: value.referencePriceUnit }
      : {}),
    ...(value.settlementTrigger === "upfront" || value.settlementTrigger === "on-proof"
      ? { settlementTrigger: value.settlementTrigger }
      : {}),
    ...(typeof value.baseFacilitatorUrl === "string" ? { baseFacilitatorUrl: value.baseFacilitatorUrl } : {}),
    ...(typeof value.ethereumFacilitatorUrl === "string"
      ? { ethereumFacilitatorUrl: value.ethereumFacilitatorUrl }
      : {}),
    ...(typeof value.baseEscrowContract === "string" ? { baseEscrowContract: value.baseEscrowContract } : {}),
    ...(typeof value.ethereumEscrowContract === "string"
      ? { ethereumEscrowContract: value.ethereumEscrowContract }
      : {}),
    ...(typeof value.paymentNotes === "string" ? { paymentNotes: value.paymentNotes } : {})
  };
}

function parseMissionAuthOverlay(value: unknown): Partial<AgentProfileState["missionAuthOverlay"]> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    ...(value.status === "disabled" || value.status === "configured" || value.status === "verified"
      ? { status: value.status }
      : {}),
    ...(typeof value.authorityBaseUrl === "string" ? { authorityBaseUrl: value.authorityBaseUrl } : {}),
    ...(value.providerHint === "auth0" || value.providerHint === "okta" || value.providerHint === "custom-oidc"
      ? { providerHint: value.providerHint }
      : {}),
    ...(Array.isArray(value.scopeHints)
      ? {
          scopeHints: value.scopeHints.filter((scope): scope is string => typeof scope === "string")
        }
      : {})
  };
}

function parseSocialAnchorPolicy(value: unknown): Partial<AgentProfileState["socialAnchorPolicy"]> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return value.mode === "shared-batched" || value.mode === "priority-self-funded"
    ? { mode: value.mode }
    : undefined;
}

function parseExecutionIntentRail(value: unknown): AgentPaymentRail | undefined {
  return value === "base-usdc" || value === "ethereum-usdc" || value === "zeko-native" ? value : undefined;
}

function parseExecutionIntentSettlementModel(value: unknown): ExecutionIntentSettlementModel | undefined {
  return value === "upfront-x402" || value === "reserve-release-escrow" ? value : undefined;
}

function parseExecutionIntentStatus(value: unknown): ExecutionIntentStatus | undefined {
  return value === "pending" ||
    value === "approved" ||
    value === "executed" ||
    value === "settled" ||
    value === "refunded"
    ? value
    : undefined;
}

function parseExecutionIntentCreateRequest(value: unknown): CreateExecutionIntentOptions {
  const body = isRecord(value) ? value : {};
  const paymentStatus =
    body.paymentStatus === "authorized" ||
    body.paymentStatus === "settled" ||
    body.paymentStatus === "paid" ||
    body.paymentStatus === "escrowed"
      ? body.paymentStatus
      : undefined;
  return {
    ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
    ...(typeof body.agentId === "string" ? { agentId: body.agentId } : {}),
    ...(typeof body.requestId === "string" ? { requestId: body.requestId } : {}),
    ...(parseExecutionIntentRail(body.rail) ? { rail: parseExecutionIntentRail(body.rail)! } : {}),
    ...(parseExecutionIntentSettlementModel(body.settlementModel)
      ? { settlementModel: parseExecutionIntentSettlementModel(body.settlementModel)! }
      : {}),
    ...(paymentStatus ? { paymentStatus } : {}),
    grossAmountUsd: typeof body.grossAmountUsd === "string" ? body.grossAmountUsd : "",
    ...(typeof body.sellerNetAmountUsd === "string" ? { sellerNetAmountUsd: body.sellerNetAmountUsd } : {}),
    ...(typeof body.protocolFeeAmountUsd === "string" ? { protocolFeeAmountUsd: body.protocolFeeAmountUsd } : {}),
    ...(typeof body.protocolFeeRecipient === "string" ? { protocolFeeRecipient: body.protocolFeeRecipient } : {}),
    ...(typeof body.buyerWallet === "string" ? { buyerWallet: body.buyerWallet } : {}),
    ...(typeof body.sellerWallet === "string" ? { sellerWallet: body.sellerWallet } : {}),
    ...(typeof body.escrowContract === "string" ? { escrowContract: body.escrowContract } : {}),
    ...(typeof body.paymentAuthorizationDigestSha256 === "string"
      ? { paymentAuthorizationDigestSha256: body.paymentAuthorizationDigestSha256 }
      : {}),
    ...(typeof body.note === "string" ? { note: body.note } : {})
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isHotReadQueueSaturationError(error: unknown): boolean {
  return error instanceof Error && /hot_read_queue_saturated/.test(error.message);
}

function isRetryableSettlementError(error: unknown): boolean {
  const text = errorMessage(error, String(error ?? "")).toLowerCase();
  return (
    text.includes("replacement transaction underpriced") ||
    text.includes("nonce too low") ||
    text.includes("transaction underpriced") ||
    text.includes("already known") ||
    text.includes("settlement_pending") ||
    text.includes("temporarily unavailable") ||
    text.includes("timeout") ||
    text.includes("rate limit") ||
    text.includes("429") ||
    text.includes("502") ||
    text.includes("503") ||
    text.includes("504")
  );
}

function isExpiredPaymentPayloadError(error: unknown): boolean {
  return /expired|validbefore|valid before|authorization is no longer valid/i.test(errorMessage(error, String(error ?? "")));
}

function paymentSettlementFailureBody(error: unknown, extra: Record<string, unknown> = {}) {
  return {
    error: errorMessage(error, "Unable to settle x402 payment."),
    operationalStatus: {
      paymentStatus: "failed",
      settlementStatus: "failed",
      relayDeliveryStatus: "not_attempted",
      agentExecutionStatus: "not_started"
    },
    retryable: isRetryableSettlementError(error),
    ...extra
  };
}

function relayDeliveryFailureBody(error: unknown, extra: Record<string, unknown> = {}) {
  const payment = isRecord(extra.payment) ? extra.payment : undefined;
  const paymentStatus = payment?.status === "authorized" ? "authorized" : payment?.status === "settled" ? "settled" : "unknown";
  const retryable = isRetryableSettlementError(error);
  return {
    error: errorMessage(error, "Unable to deliver paid execution to the agent runtime."),
    ...(retryable
      ? {
          code: "relay_unavailable_retryable",
          retryable: true
        }
      : {}),
    operationalStatus: {
      paymentStatus,
      settlementStatus: paymentStatus === "authorized" ? "authorized" : paymentStatus === "settled" ? "settled" : "unknown",
      relayDeliveryStatus: "failed",
      agentExecutionStatus: "not_started"
    },
    ...extra
  };
}

function parseExecutionIntentTransitionRequest(value: unknown): Omit<ExecutionIntentTransitionOptions, "intentId"> {
  const body = isRecord(value) ? value : {};
  const evidenceDigestSha256 =
    typeof body.evidenceDigestSha256 === "string"
      ? body.evidenceDigestSha256
      : typeof body.paymentAuthorizationDigestSha256 === "string"
        ? body.paymentAuthorizationDigestSha256
        : typeof body.executionDigestSha256 === "string"
          ? body.executionDigestSha256
          : typeof body.settlementDigestSha256 === "string"
            ? body.settlementDigestSha256
            : typeof body.refundDigestSha256 === "string"
              ? body.refundDigestSha256
              : undefined;
  return {
    ...(typeof body.reference === "string" ? { reference: body.reference } : {}),
    ...(evidenceDigestSha256 ? { evidenceDigestSha256 } : {}),
    ...(typeof body.note === "string" ? { note: body.note } : {})
  };
}

function parseQuoteAcceptRequest(value: unknown) {
  const body = isRecord(value) ? value : {};
  const buyerWalletProof: Partial<SantaClawzQuoteAcceptanceWalletProof> | undefined = isRecord(body.buyerWalletProof)
    ? {
        ...(body.buyerWalletProof.scheme === "eip191-personal-sign" ? { scheme: "eip191-personal-sign" as const } : {}),
        ...(typeof body.buyerWalletProof.message === "string" ? { message: body.buyerWalletProof.message } : {}),
        ...(typeof body.buyerWalletProof.signature === "string" ? { signature: body.buyerWalletProof.signature } : {}),
        ...(typeof body.buyerWalletProof.signedAtIso === "string" ? { signedAtIso: body.buyerWalletProof.signedAtIso } : {})
      }
    : undefined;
  return {
    ...(typeof body.buyerAgentId === "string" ? { buyerAgentId: body.buyerAgentId } : {}),
    ...(typeof body.buyerWallet === "string" ? { buyerWallet: body.buyerWallet } : {}),
    ...(buyerWalletProof ? { buyerWalletProof } : {}),
    acceptedAmountUsd: typeof body.acceptedAmountUsd === "string" ? body.acceptedAmountUsd : "",
    acceptedQuoteDigestSha256:
      typeof body.acceptedQuoteDigestSha256 === "string" ? body.acceptedQuoteDigestSha256 : "",
    ...(typeof body.maxAmountUsd === "string" ? { maxAmountUsd: body.maxAmountUsd } : {}),
    ...(parseExecutionIntentRail(body.rail) ? { rail: parseExecutionIntentRail(body.rail)! } : {}),
    ...(parseExecutionIntentSettlementModel(body.settlementModel)
      ? { settlementModel: parseExecutionIntentSettlementModel(body.settlementModel)! }
      : {})
  };
}

function parseRuntimeDelivery(value: unknown): Partial<AgentProfileState["runtimeDelivery"]> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const mode =
    value.mode === "self-hosted" || value.mode === "santaclawz-relay"
      ? value.mode
      : undefined;
  if (!mode) {
    return undefined;
  }
  const runtimeRoutes = isRecord(value.runtimeRoutes)
    ? {
        ...(typeof value.runtimeRoutes.quote_intake === "string" && value.runtimeRoutes.quote_intake.trim().length > 0
          ? { quote_intake: value.runtimeRoutes.quote_intake.trim().slice(0, 280) }
          : {}),
        ...(typeof value.runtimeRoutes.paid_execution === "string" && value.runtimeRoutes.paid_execution.trim().length > 0
          ? { paid_execution: value.runtimeRoutes.paid_execution.trim().slice(0, 280) }
          : {})
      }
    : undefined;
  return {
    mode,
    ...(typeof value.runtimeIngressUrl === "string" && value.runtimeIngressUrl.trim().length > 0
      ? { runtimeIngressUrl: value.runtimeIngressUrl.trim() }
      : {}),
    ...(runtimeRoutes && Object.keys(runtimeRoutes).length > 0 ? { runtimeRoutes } : {})
  };
}

function parseTrustModeRequest(body: unknown): TrustModeRequestBody {
  return isRecord(body)
    ? {
        modeId: body.modeId,
        sessionId: body.sessionId
      }
    : {};
}

function parseRegisterAgentRequest(body: unknown): RegisterAgentRequestBody {
  return isRecord(body)
    ? {
        agentName: body.agentName,
        representedPrincipal: body.representedPrincipal,
        headline: body.headline,
        urlReservationSalt: body.urlReservationSalt,
        publicClawzUrl: body.publicClawzUrl,
        openClawUrl: body.openClawUrl,
        runtimeDelivery: body.runtimeDelivery,
        payoutAddress: body.payoutAddress,
        payoutWallets: body.payoutWallets,
        missionAuthOverlay: body.missionAuthOverlay,
        paymentProfile: body.paymentProfile,
        marketplaceTags: body.marketplaceTags,
        contextRequirements: body.contextRequirements,
        socialAnchorPolicy: body.socialAnchorPolicy,
        trustModeId: body.trustModeId,
        preferredProvingLocation: body.preferredProvingLocation
      }
    : {};
}

function parseEnrollmentTicketRedeemRequest(body: unknown): EnrollmentTicketRedeemBody {
  return isRecord(body)
    ? {
        ticket: body.ticket,
        openClawUrl: body.openClawUrl,
        runtimeIngressUrl: body.runtimeIngressUrl
      }
    : {};
}

function registerOptionsFromBody(body: RegisterAgentRequestBody): Parameters<typeof controlPlane.registerAgent>[0] {
  const payoutWallets = parsePayoutWallets(body.payoutWallets);
  const missionAuthOverlay = parseMissionAuthOverlay(body.missionAuthOverlay);
  const paymentProfile = parsePaymentProfile(body.paymentProfile);
  const marketplaceTags = parseAgentMarketplaceTags(body.marketplaceTags);
  const contextRequirements = parseContextRequirements(body.contextRequirements);
  const runtimeDelivery = parseRuntimeDelivery(body.runtimeDelivery);
  const socialAnchorPolicy = parseSocialAnchorPolicy(body.socialAnchorPolicy);
  const trustModeId: TrustModeId | undefined =
    body.trustModeId === "fast" ||
    body.trustModeId === "private" ||
    body.trustModeId === "verified" ||
    body.trustModeId === "team-governed"
      ? body.trustModeId
      : undefined;
  const preferredProvingLocation =
    body.preferredProvingLocation === "client" ||
    body.preferredProvingLocation === "server" ||
    body.preferredProvingLocation === "sovereign-rollup"
      ? body.preferredProvingLocation
      : undefined;

  return {
    agentName: typeof body.agentName === "string" ? body.agentName : "",
    headline: typeof body.headline === "string" ? body.headline : "",
    ...(typeof body.urlReservationSalt === "string" ? { urlReservationSalt: body.urlReservationSalt } : {}),
    openClawUrl:
      typeof body.publicClawzUrl === "string"
        ? body.publicClawzUrl
        : typeof body.openClawUrl === "string"
          ? body.openClawUrl
          : "",
    ...(typeof body.payoutAddress === "string" ? { payoutAddress: body.payoutAddress } : {}),
    ...(payoutWallets ? { payoutWallets } : {}),
    ...(missionAuthOverlay ? { missionAuthOverlay } : {}),
    ...(paymentProfile ? { paymentProfile } : {}),
    ...(marketplaceTags ? { marketplaceTags } : {}),
    ...(contextRequirements ? { contextRequirements } : {}),
    ...(runtimeDelivery ? { runtimeDelivery } : {}),
    ...(socialAnchorPolicy ? { socialAnchorPolicy } : {}),
    ...(typeof body.representedPrincipal === "string" ? { representedPrincipal: body.representedPrincipal } : {}),
    ...(trustModeId ? { trustModeId } : {}),
    ...(preferredProvingLocation ? { preferredProvingLocation } : {})
  };
}

function enrollmentTicketOptionsFromBody(body: RegisterAgentRequestBody): Parameters<typeof controlPlane.issueEnrollmentTicket>[0] {
  return registerOptionsFromBody(body);
}

function parseProfileRequest(body: unknown): ProfileRequestBody {
  return isRecord(body)
    ? {
        agentName: body.agentName,
        representedPrincipal: body.representedPrincipal,
        headline: body.headline,
        publicClawzUrl: body.publicClawzUrl,
        openClawUrl: body.openClawUrl,
        runtimeDelivery: body.runtimeDelivery,
        payoutAddress: body.payoutAddress,
        payoutWallets: body.payoutWallets,
        missionAuthOverlay: body.missionAuthOverlay,
        paymentProfile: body.paymentProfile,
        marketplaceTags: body.marketplaceTags,
        contextRequirements: body.contextRequirements,
        socialAnchorPolicy: body.socialAnchorPolicy,
        preferredProvingLocation: body.preferredProvingLocation,
        sessionId: body.sessionId
      }
    : {};
}

function parseMissionAuthOverlayRequest(body: unknown): MissionAuthOverlayRequestBody {
  return isRecord(body)
    ? {
        missionAuthOverlay: body.missionAuthOverlay,
        sessionId: body.sessionId,
        agentId: body.agentId
      }
    : {};
}

function parseOwnershipActionRequest(body: unknown): OwnershipActionRequestBody {
  return isRecord(body)
    ? {
        sessionId: body.sessionId,
        agentId: body.agentId
      }
    : {};
}

function parseHireRequest(body: unknown): HireRequestBody {
  return isRecord(body)
    ? {
        taskPrompt: body.taskPrompt,
        budgetMina: body.budgetMina,
        requesterContact: body.requesterContact,
        marketplaceTags: body.marketplaceTags,
        jobContext: body.jobContext,
        context: body.context,
        jobPrivacy: body.jobPrivacy,
        activityPrivacy: body.activityPrivacy,
        artifactDelivery: body.artifactDelivery,
        paymentPayload: body.paymentPayload,
        activationLane: body.activationLane,
        activation_lane: body.activation_lane,
        activationProbe: body.activationProbe,
        activation_probe: body.activation_probe,
        sellerReadinessTest: body.sellerReadinessTest,
        seller_readiness_test: body.seller_readiness_test
      }
    : {};
}

function parseProcurementIntentBody(body: unknown, idempotencyKey?: string): CreateProcurementIntentOptions {
  const value = isRecord(body) ? body as ProcurementIntentBody : {};
  const marketplaceTags = parseMarketplaceWorkTags(value.marketplaceTags);
  const jobContext = parseJobContext(value.jobContext ?? value.context);
  return {
    ...(idempotencyKey ? { idempotencyKey } : typeof value.idempotencyKey === "string" ? { idempotencyKey: value.idempotencyKey } : {}),
    taskPrompt: typeof value.taskPrompt === "string" ? value.taskPrompt : "",
    requesterContact: typeof value.requesterContact === "string" ? value.requesterContact : "",
    ...(typeof value.budgetUsd === "string" ? { budgetUsd: value.budgetUsd } : {}),
    ...(typeof value.deadlineIso === "string" ? { deadlineIso: value.deadlineIso } : {}),
    ...(typeof value.bidWindowClosesAtIso === "string" ? { bidWindowClosesAtIso: value.bidWindowClosesAtIso } : {}),
    requiredCapabilities: stringArray(value.requiredCapabilities),
    preferredDeliveryModes: stringArray(value.preferredDeliveryModes),
    preferredPrivacyModes: stringArray(value.preferredPrivacyModes),
    ...(marketplaceTags ? { marketplaceTags } : {}),
    ...(jobContext ? { jobContext } : {}),
    ...(parseJobPrivacyPreference(value.jobPrivacy) ? { jobPrivacy: parseJobPrivacyPreference(value.jobPrivacy)! } : {}),
    ...(parseArtifactDeliveryPreference(value.artifactDelivery)
      ? { artifactDelivery: parseArtifactDeliveryPreference(value.artifactDelivery)! }
      : {})
  };
}

function parseHostedWorkspaceIdentityProvider(value: unknown): HostedWorkspaceIdentityProvider {
  return value === "google" || value === "operator-managed" ? value : "email-code";
}

function parseWorkspacePrivacyMode(value: unknown): UpsertHostedWorkspaceRunOptions["privacyMode"] {
  return value === "public-summary" ||
    value === "recipient-encrypted" ||
    value === "local-private" ||
    value === "digest-only"
    ? value
    : "digest-only";
}

function parseHostedWorkspaceRunBody(body: unknown, workspaceSessionToken: string): UpsertHostedWorkspaceRunOptions {
  const value = isRecord(body) ? body as HostedWorkspaceRunBody : {};
  const budgetUsd = optionalString(value.budgetUsd);
  const procurementIntentId = optionalString(value.procurementIntentId);
  return {
    orgName: optionalString(value.orgName) ?? "",
    workspaceDomain: optionalString(value.workspaceDomain) ?? "",
    workspaceSessionToken,
    identityProvider: parseHostedWorkspaceIdentityProvider(value.identityProvider),
    projectName: optionalString(value.projectName) ?? "",
    goal: optionalString(value.goal) ?? "",
    threadId: optionalString(value.threadId) ?? "",
    swarmId: optionalString(value.swarmId) ?? "",
    requesterContact: optionalString(value.requesterContact) ?? "",
    ...(budgetUsd ? { budgetUsd } : {}),
    privacyMode: parseWorkspacePrivacyMode(value.privacyMode),
    requiredCapabilities: stringArray(value.requiredCapabilities),
    selectedAgentIds: stringArray(value.selectedAgentIds),
    toolTouchpoints: stringArray(value.toolTouchpoints),
    ...(isRecord(value.manifest) ? { manifest: value.manifest } : {}),
    ...(procurementIntentId ? { procurementIntentId } : {})
  };
}

function parseBuyerRouterPlanBody(body: unknown): CreateBuyerRouterPlanOptions {
  const value = isRecord(body) ? body as BuyerRouterPlanBody : {};
  const marketplaceTags = parseMarketplaceWorkTags(value.marketplaceTags);
  return {
    taskPrompt: typeof value.taskPrompt === "string" ? value.taskPrompt : "",
    ...(value.buyerMode === "agent" || value.buyerMode === "human" ? { buyerMode: value.buyerMode } : {}),
    ...(typeof value.requesterContact === "string" ? { requesterContact: value.requesterContact } : {}),
    ...(typeof value.budgetUsd === "string" ? { budgetUsd: value.budgetUsd } : {}),
    ...(value.privacyLane === "private" || value.privacyLane === "proof-only" || value.privacyLane === "public-summary"
      ? { privacyLane: value.privacyLane }
      : {}),
    ...(marketplaceTags ? { marketplaceTags } : {}),
    ...(typeof value.selectedAgentId === "string" ? { selectedAgentId: value.selectedAgentId } : {})
  };
}

function parseArtifactReceiptBody(body: unknown): ArtifactReceiptBody {
  return isRecord(body)
    ? {
        deliveryMode: body.deliveryMode,
        transport: body.transport,
        scanPolicy: body.scanPolicy,
        buyerAcceptanceRequired: body.buyerAcceptanceRequired,
        filename: body.filename,
        contentType: body.contentType,
        artifactDigestSha256: body.artifactDigestSha256,
        artifactSizeBytes: body.artifactSizeBytes,
        artifactUrl: body.artifactUrl,
        deliveryChannel: body.deliveryChannel,
        sellerDeliveryReceipt: body.sellerDeliveryReceipt,
        sellerSignature: body.sellerSignature,
        deliveredAtIso: body.deliveredAtIso
      }
    : {};
}

function parseArtifactReceiptAcknowledgementBody(body: unknown): ArtifactReceiptAcknowledgementBody {
  return isRecord(body)
    ? {
        accepted: body.accepted,
        note: body.note,
        bytesReceivedByBuyer: body.bytesReceivedByBuyer,
        digestVerified: body.digestVerified,
        buyerScanStatus: body.buyerScanStatus
      }
    : {};
}

function parseJobMessageBody(body: unknown): JobMessageBody {
  return isRecord(body)
    ? {
        authorRole: body.authorRole,
        body: body.body,
        stage: body.stage,
        artifactDigestSha256: body.artifactDigestSha256
      }
    : {};
}

function parseJobStageBody(body: unknown): JobStageBody {
  return isRecord(body)
    ? {
        authorRole: body.authorRole,
        stage: body.stage,
        status: body.status,
        label: body.label,
        note: body.note,
        artifactDigestSha256: body.artifactDigestSha256
      }
    : {};
}

function parseLateHireCompletionBody(body: unknown): LateHireCompletionBody {
  return isRecord(body)
    ? {
        statusCode: body.statusCode,
        body: body.body,
        bodyBase64: body.bodyBase64,
        bodyEncoding: body.bodyEncoding,
        relayMessageId: body.relayMessageId,
        requestBodyDigestSha256: body.requestBodyDigestSha256,
        workerStatusCode: body.workerStatusCode,
        workerResponseBytes: body.workerResponseBytes,
        workerResponseDigestSha256: body.workerResponseDigestSha256,
        relayBodyBytes: body.relayBodyBytes,
        relayBodyDigestSha256: body.relayBodyDigestSha256,
        source: body.source
      }
    : {};
}

function boundedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function validSha256(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : undefined;
}

function lateCompletionResponseText(body: LateHireCompletionBody) {
  if (body.bodyEncoding === "base64" && typeof body.bodyBase64 === "string") {
    return Buffer.from(body.bodyBase64, "base64").toString("utf8");
  }
  if (typeof body.body === "string") {
    return body.body;
  }
  return "";
}

function parseAgentHeartbeatRequest(body: unknown): AgentHeartbeatRequestBody {
  return isRecord(body)
    ? {
        sessionId: body.sessionId,
        status: body.status,
        ttlSeconds: body.ttlSeconds,
        note: body.note,
        relayAgentProtocolVersion: body.relayAgentProtocolVersion,
        relayAgentBuild: body.relayAgentBuild,
        relayAgentFeatures: body.relayAgentFeatures,
        relayAgentWorkerRoutes: body.relayAgentWorkerRoutes,
        relayAgentWorkerWarnings: body.relayAgentWorkerWarnings,
        relayAgentWorkerTiming: body.relayAgentWorkerTiming,
        paidExecutionProbe: body.paidExecutionProbe
      }
    : {};
}

function parseAgentRuntimeStatus(value: unknown): AgentRuntimeStatus | undefined {
  return value === "live" || value === "waiting" || value === "offline" ? value : undefined;
}

function parseSponsorRequest(body: unknown): SponsorRequestBody {
  return isRecord(body)
    ? {
        amountMina: body.amountMina,
        sessionId: body.sessionId,
        purpose: body.purpose
      }
    : {};
}

function parseRecoveryRequest(body: unknown): RecoveryRequestBody {
  return isRecord(body)
    ? {
        sessionId: body.sessionId
      }
    : {};
}

function parsePrivacyExceptionApproval(body: unknown): PrivacyExceptionApprovalBody {
  return isRecord(body)
    ? {
        actorRole: body.actorRole,
        actorId: body.actorId,
        note: body.note,
        sessionId: body.sessionId
      }
    : {};
}

function parseLiveFlowRequest(body: unknown): {
  flowKind?: LiveFlowKind;
  sessionId?: string;
  turnId?: string;
  sourceTurnId?: string;
  sourceDisclosureId?: string;
  abortReason?: string;
  revocationReason?: string;
  refundAmountMina?: string;
} {
  if (!isRecord(body)) {
    return {};
  }

  const rawFlowKind = optionalString(body.flowKind);
  if (rawFlowKind && !isLiveFlowKind(rawFlowKind)) {
    throw new Error(`Unsupported live flow kind: ${rawFlowKind}`);
  }
  const flowKind = rawFlowKind && isLiveFlowKind(rawFlowKind) ? rawFlowKind : undefined;
  const sessionId = optionalString(body.sessionId);
  const turnId = optionalString(body.turnId);
  const sourceTurnId = optionalString(body.sourceTurnId);
  const sourceDisclosureId = optionalString(body.sourceDisclosureId);
  const abortReason = optionalString(body.abortReason);
  const revocationReason = optionalString(body.revocationReason);
  const refundAmountMina = optionalString(body.refundAmountMina);

  return {
    ...(flowKind ? { flowKind } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(sourceTurnId ? { sourceTurnId } : {}),
    ...(sourceDisclosureId ? { sourceDisclosureId } : {}),
    ...(abortReason ? { abortReason } : {}),
    ...(revocationReason ? { revocationReason } : {}),
    ...(refundAmountMina ? { refundAmountMina } : {})
  };
}

function getBaseUrl(request: IndexerRequest): string {
  const forwardedProto = request.header("x-forwarded-proto");
  const protocol = typeof forwardedProto === "string" && forwardedProto.length > 0 ? forwardedProto : "http";
  const host = request.header("host") ?? "127.0.0.1";
  return `${protocol}://${host}`;
}

async function buildInteropSnapshot(request: IndexerRequest) {
  const baseUrl = getBaseUrl(request);
  return buildInteropSnapshotFromQuery(baseUrl, request.query);
}

async function buildInteropSnapshotFromQuery(baseUrl: string, query: unknown) {
  const sessionId = queryString(query, "sessionId");
  const turnId = queryString(query, "turnId");
  const consoleState = await controlPlane.getConsoleState(sessionId ? { sessionId } : {});
  const resolvedSessionId = consoleState.session.sessionId;
  const [events, sessionView] = await Promise.all([
    controlPlane.listEvents({ sessionId: resolvedSessionId }),
    controlPlane.getSession(resolvedSessionId)
  ]);

  if (turnId && !sessionView.turns.includes(turnId)) {
    throw new Error(`Unknown turn for session ${resolvedSessionId}: ${turnId}`);
  }

  return {
    baseUrl,
    sessionId: resolvedSessionId,
    turnId,
    consoleState,
    events,
    sessionView
  };
}

async function buildX402PlanFromOptions(
  baseUrl: string,
  options: {
    sessionId?: string;
    agentId?: string;
  } = {}
) {
  const consoleState = await controlPlane.getConsoleState(options);
  return {
    consoleState,
    plan: await buildAgentX402PlanWithNetworkQuotes({
      baseUrl,
      consoleState
    })
  };
}

function paymentStateLookupFromQuery(query: unknown) {
  const ledgerId = queryString(query, "ledgerId");
  const intentId = queryString(query, "intentId") ?? queryString(query, "quoteIntentId");
  const requestId = queryString(query, "requestId") ?? queryString(query, "hireRequestId");
  const paymentPayloadDigestSha256 =
    validSha256(queryString(query, "paymentPayloadDigestSha256")) ??
    validSha256(queryString(query, "paymentPayloadDigest")) ??
    validSha256(queryString(query, "payloadDigest"));
  if (!ledgerId && !intentId && !requestId && !paymentPayloadDigestSha256) {
    return undefined;
  }
  return {
    ...(ledgerId ? { ledgerId } : {}),
    ...(intentId ? { intentId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256 } : {})
  };
}

async function buyerPaymentSafetyForPlan(input: {
  apiBase: string;
  lookup?: ReturnType<typeof paymentStateLookupFromQuery>;
}) {
  if (!input.lookup) {
    return undefined;
  }
  const lookupRecord = Object.fromEntries(
    Object.entries(input.lookup).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  const cacheKey = `payment-safety:${input.apiBase}:${lookupRecord.ledgerId ?? ""}:${lookupRecord.intentId ?? ""}:${lookupRecord.requestId ?? ""}:${lookupRecord.paymentPayloadDigestSha256 ?? ""}`;
  const { payload: paymentState } = await cachedX402PaymentState({
    cacheKey,
    lookup: lookupRecord,
    producer: () =>
      buildX402PaymentStateResponse({
        apiBase: input.apiBase,
        ...input.lookup
      })
  });
  const paymentStateRecord = paymentState as Record<string, unknown>;
  const paymentBlock = isRecord(paymentStateRecord.payment) ? paymentStateRecord.payment : undefined;
  const latestLedger = isRecord(paymentBlock?.latestLedger)
    ? paymentBlock.latestLedger
    : undefined;
  const retryResume: Record<string, unknown> = isRecord(paymentStateRecord.retryResume)
    ? paymentStateRecord.retryResume
    : {};
  const terminal = retryResume.terminal === true;
  const safeToRetrySamePayload = retryResume.safeToRetrySamePayload === true;
  const paymentPayloadRetryRejected = retryResume.paymentPayloadRetryRejected === true;
  const unresolved = !terminal;
  const blockingPaymentPayloadDigestSha256 =
    typeof paymentState.lookup?.paymentPayloadDigestSha256 === "string"
      ? paymentState.lookup.paymentPayloadDigestSha256
      : typeof latestLedger?.paymentPayloadDigestSha256 === "string"
        ? latestLedger.paymentPayloadDigestSha256
        : undefined;
  const blockingRequestId =
    typeof paymentState.lookup?.requestId === "string"
      ? paymentState.lookup.requestId
      : typeof latestLedger?.hireRequestId === "string"
        ? latestLedger.hireRequestId
        : undefined;
  const safeNextAction =
    typeof retryResume.nextAction === "string"
      ? retryResume.nextAction
      : unresolved
        ? "poll_or_reconcile_existing_payment"
        : "fresh_payment_allowed";
  const terminalReason =
    typeof retryResume.terminalReason === "string" ? retryResume.terminalReason : undefined;
  const refundOrNoChargeStatus =
    typeof retryResume.refundOrNoChargeStatus === "string" ? retryResume.refundOrNoChargeStatus : undefined;
  const paymentStateUrl = paymentStateRetryEndpoint({
    apiBase: input.apiBase,
    ...(paymentState.lookup?.intentId ? { intentId: paymentState.lookup.intentId } : {}),
    ...(blockingRequestId ? { requestId: blockingRequestId } : {}),
    ...(typeof latestLedger?.agentId === "string" ? { agentId: latestLedger.agentId } : {}),
    ...(blockingPaymentPayloadDigestSha256 ? { paymentPayloadDigestSha256: blockingPaymentPayloadDigestSha256 } : {})
  }) ?? `${input.apiBase}/api/x402/payment-state`;
  return {
    schemaVersion: "santaclawz-buyer-payment-safety/1.0" as const,
    scoped: true as const,
    freshPaymentSafeForBuyer: terminal,
    safeToRetrySamePayload,
    safeToCreateNewPayment: terminal,
    safeNextAction,
    terminal,
    unresolved,
    humanOrPlatformInterventionRequired: unresolved && !safeToRetrySamePayload,
    paymentStateUrl,
    ...(typeof retryResume.stateEndpoint === "string" ? { stateEndpoint: retryResume.stateEndpoint } : {}),
    ...(blockingPaymentPayloadDigestSha256 ? { blockingPaymentPayloadDigestSha256 } : {}),
    ...(blockingRequestId ? { blockingRequestId } : {}),
    ...(typeof latestLedger?.ledgerId === "string" ? { blockingLedgerId: latestLedger.ledgerId } : {}),
    ...(terminalReason ? { terminalReason } : {}),
    ...(refundOrNoChargeStatus ? { refundOrNoChargeStatus } : {}),
    ...(unresolved
      ? {
          blockerCode: paymentPayloadRetryRejected
            ? "existing_payment_payload_not_retryable"
            : "existing_non_terminal_payment"
        }
      : {}),
    guidance: terminal
      ? "The referenced payment path is terminal. A buyer may create a fresh payment for a new job if the agent is otherwise hireable."
      : "This buyer has an unresolved payment path. Do not create a fresh payment until payment-state or execution-state reaches a terminal outcome."
  };
}

async function attachBuyerPaymentSafetyToPlan(input: {
  apiBase: string;
  query: unknown;
  plan: Awaited<ReturnType<typeof buildX402PlanFromOptions>>["plan"];
}) {
  const buyerPaymentSafety = await buyerPaymentSafetyForPlan({
    apiBase: input.apiBase,
    lookup: paymentStateLookupFromQuery(input.query)
  });
  return buyerPaymentSafety ? { ...input.plan, buyerPaymentSafety } : input.plan;
}

type X402PlanResponse = Awaited<ReturnType<typeof buildX402PlanFromOptions>>["plan"];

function decorateX402PlanResponse(
  payload: X402PlanResponse,
  cacheStatus: HotReadCacheStatus
): X402PlanResponse & {
  stateFreshness: "fresh" | "stale";
  projectionSource: HotReadCacheStatus;
  planProjectionPending: boolean;
} {
  const stale = cacheStatus === "stale" || cacheStatus === "refreshing";
  return {
    ...payload,
    stateFreshness: stale ? "stale" : "fresh",
    projectionSource: cacheStatus,
    planProjectionPending: stale
  };
}

function x402PlanTemporarilyUnavailable(input: {
  apiBase: string;
  cacheKey: string;
  agentId?: string | undefined;
  sessionId?: string | undefined;
  error?: unknown;
}) {
  return {
    schemaVersion: "santaclawz-x402-plan/1.0",
    ok: false,
    code: "x402_plan_temporarily_unavailable",
    retryable: true,
    generatedAtIso: new Date().toISOString(),
    apiBase: input.apiBase,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    cacheKey: input.cacheKey,
    stateFreshness: "unavailable",
    projectionSource: "temporarily_unavailable",
    planProjectionPending: true,
    paymentRequested: false,
    safeToCreateNewPayment: false,
    safeToRetrySamePayload: false,
    recommendedPollAfterMs: 2000,
    guidance:
      "The x402 payment plan is temporarily unavailable. Do not sign or submit payment from this response; retry the same plan request after service recovery.",
    error: errorMessage(input.error, "x402 plan read exceeded the protocol read budget.")
  };
}

function commaSet(value: string | undefined) {
  return new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

function marketplaceTagSet(value: string | undefined) {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) =>
        item
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-_:./\s]/g, "")
          .replace(/\s+/g, "-")
          .slice(0, 64)
      )
      .filter(Boolean)
  );
}

function queryBoolean(query: unknown, key: string): boolean | undefined {
  const value = queryString(query, key)?.toLowerCase();
  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }
  if (value === "false" || value === "0" || value === "no") {
    return false;
  }
  return undefined;
}

function queryBoundedInteger(query: unknown, key: string, fallback: number, min: number, max: number) {
  const rawValue = queryString(query, key);
  const parsed = rawValue ? Number.parseInt(rawValue, 10) : fallback;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(parsed, max));
}

function supportedDeliveryLanes() {
  return [
    {
      mode: "platform_scanned",
      scanPolicy: "platform_required",
      digestRequired: true,
      buyerAcceptanceRequired: false,
      platformContentVisibility: "plaintext_during_platform_scan"
    },
    {
      mode: "buyer_encrypted",
      scanPolicy: "buyer_required",
      digestRequired: true,
      buyerAcceptanceRequired: true,
      platformContentVisibility: "ciphertext_only"
    },
    {
      mode: "direct_receipt",
      scanPolicy: "buyer_required",
      digestRequired: true,
      buyerAcceptanceRequired: true,
      platformContentVisibility: "receipt_only_no_bytes"
    },
    {
      mode: "external_reference",
      scanPolicy: "external_unverified",
      digestRequired: true,
      buyerAcceptanceRequired: true,
      platformContentVisibility: "receipt_only_no_bytes"
    }
  ];
}

function supportedPrivacyModes() {
  return [
    {
      mode: "public",
      lifecycleVisibility: "public_job_activity",
      aggregateStats: true,
      anonymousAnchoring: false
    },
    {
      mode: "private",
      lifecycleVisibility: "anonymized_activity_anchor",
      aggregateStats: true,
      anonymousAnchoring: true
    },
    {
      mode: "buyer_encrypted",
      lifecycleVisibility: "anonymized_activity_anchor",
      aggregateStats: true,
      platformContentVisibility: "ciphertext_only"
    }
  ];
}

function hireRequestLimits() {
  return { ...HIRE_REQUEST_LIMITS };
}

function hireRequestErrorBody(code: string, error: string, extra: Record<string, unknown> = {}) {
  return {
    ok: false,
    code,
    error,
    retryable: false,
    limits: hireRequestLimits(),
    ...extra
  };
}

function hireRequestFailureBody(error: unknown) {
  const message = error instanceof Error ? error.message : "Unable to submit hire request.";
  if (/taskPrompt must be/i.test(message)) {
    return hireRequestErrorBody("task_prompt_too_long", message);
  }
  if (/requesterContact must be/i.test(message)) {
    return hireRequestErrorBody("requester_contact_too_long", message);
  }
  if (/artifactDelivery\./i.test(message) || /^artifactDelivery\.mode/i.test(message)) {
    return hireRequestErrorBody("artifact_delivery_invalid", message);
  }
  if (/jobPrivacy\./i.test(message)) {
    return hireRequestErrorBody("job_privacy_invalid", message);
  }
  if (/taskPrompt and requesterContact are required/i.test(message)) {
    return hireRequestErrorBody("task_prompt_or_requester_contact_missing", message);
  }
  return hireRequestErrorBody("hire_request_invalid", message);
}

function costEstimateFromPlan(plan: Awaited<ReturnType<typeof buildX402PlanFromOptions>>["plan"]) {
  return {
    pricingMode: plan.pricingMode,
    ...(plan.defaultRail ? { defaultRail: plan.defaultRail } : {}),
    ...(plan.referencePriceUsd ? { referencePriceUsd: plan.referencePriceUsd } : {}),
    ...(plan.referencePriceUnit ? { referencePriceUnit: plan.referencePriceUnit } : {}),
    feePreviewByRail: (plan.feePreviewByRail ?? []).map((preview) => ({
      rail: preview.rail,
      grossAmountUsd: preview.grossAmountUsd,
      sellerNetAmountUsd: preview.sellerNetAmountUsd,
      protocolFeeAmountUsd: preview.protocolFeeAmountUsd,
      protocolFeeRecipient: preview.protocolFeeRecipient,
      feeBps: preview.feeBps,
      ...(preview.networkFacilitationFeeAmountUsd
        ? { networkFacilitationFeeAmountUsd: preview.networkFacilitationFeeAmountUsd }
        : {})
    })),
    rails: plan.rails.map((rail) => ({
      rail: rail.rail,
      networkId: rail.networkId,
      assetSymbol: rail.assetSymbol,
      ...(rail.amountUsd ? { estimatedTotalCostUsd: rail.amountUsd } : {})
    }))
  };
}

function normalizedAgentMarketplaceTags(input?: Partial<AgentMarketplaceTags>): AgentMarketplaceTags {
  return {
    capabilities: Array.isArray(input?.capabilities) ? input.capabilities : [],
    domains: Array.isArray(input?.domains) ? input.domains : [],
    inputTypes: Array.isArray(input?.inputTypes) ? input.inputTypes : [],
    outputTypes: Array.isArray(input?.outputTypes) ? input.outputTypes : [],
    tools: Array.isArray(input?.tools) ? input.tools : [],
    runtimes: Array.isArray(input?.runtimes) ? input.runtimes : []
  };
}

function agentMarketplaceTagValues(input?: Partial<AgentMarketplaceTags>): string[] {
  const tags = normalizedAgentMarketplaceTags(input);
  return [
    ...tags.capabilities,
    ...tags.domains,
    ...tags.inputTypes,
    ...tags.outputTypes,
    ...tags.tools,
    ...tags.runtimes
  ];
}

function agentCapabilityTags(
  agent: Awaited<ReturnType<typeof controlPlane.listRegisteredAgents>>[number],
  entry: { quoteReady: boolean; paidExecutionReady: boolean }
) {
  const words = `${agent.agentId} ${agent.agentName} ${agent.headline} ${agent.representedPrincipal}`
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((word) => word.length >= 3 && word.length <= 32);
  const tags = new Set<string>([
    "artifact_delivery",
    "platform_scanned",
    "buyer_encrypted",
    "direct_receipt",
    "external_reference",
    "private_jobs",
    "procurement_bid",
    "direct_hire",
    "fixed_offer"
  ]);
  if (entry.quoteReady) {
    tags.add("quote_request");
    tags.add("quote_intake");
  }
  if (entry.paidExecutionReady) {
    tags.add("paid_execution");
  }
  for (const tag of agentMarketplaceTagValues(agent.marketplaceTags)) {
    tags.add(tag);
  }
  for (const word of words) {
    tags.add(word.replace(/-/g, "_"));
  }
  return Array.from(tags).slice(0, 24);
}

function pricingReadinessNotes(input: {
  pricingMode: Awaited<ReturnType<typeof controlPlane.listRegisteredAgents>>[number]["pricingMode"];
  quoteReady: boolean;
  paidExecutionReady: boolean;
  paidExecutionProven?: boolean;
}) {
  if (input.pricingMode === "fixed-exact") {
    if (input.paidExecutionReady) {
      return ["fixed-paid-execution-ready"];
    }
    return input.paidExecutionProven === false ? ["paid-execution-not-proven"] : ["fixed-paid-execution-not-ready"];
  }
  if (input.pricingMode === "quote-required") {
    return [
      input.quoteReady ? "quote-intake-ready" : "quote-intake-not-ready",
      input.paidExecutionReady
        ? "quote-payment-required-before-execution"
        : input.paidExecutionProven === false
          ? "paid-execution-not-proven"
          : "quote-intake-only"
    ];
  }
  return input.paidExecutionReady ? ["free-test-ready"] : ["free-test-not-ready"];
}

function paidExecutionProvenFromReadiness(readiness?: { paidExecutionProven?: boolean }) {
  return readiness?.paidExecutionProven === true;
}

function paidExecutionProbeRequiredBody(input: {
  agentId?: string;
  intent?: unknown;
  plan?: unknown;
}) {
  const publicProbeAmountUsd = activationLaneAmountUsd();
  return {
    ok: false,
    code: "paid_execution_probe_required",
    retryable: false,
    paymentRequested: false,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.intent ? { intent: input.intent } : {}),
    ...(input.plan ? { plan: input.plan } : {}),
    error:
      "This agent has payments configured, but paid execution is not proven yet. Run a bounded paid activation probe, use the hosted Job Pack helper, or run seller:ready before normal buyers pay.",
    statusTags: ["Pending"],
    nextAction: "run_paid_activation_probe_or_seller_ready",
    activationMethods: {
      publicPaidProbe: {
        available: true,
        query: "activationProbe=true",
        body: { activationProbe: true },
        amountUsd: publicProbeAmountUsd,
        purpose:
          "Any funded buyer/operator can run this tiny paid proving job. It is marked as an activation probe, not normal marketplace work."
      },
      sellerReadinessTest: {
        available: true,
        query: "sellerReadinessTest=true",
        body: { sellerReadinessTest: true },
        amountUsd: publicProbeAmountUsd,
        purpose:
          "After activation, any funded buyer/operator can run this tiny seller practice job to verify the v1.1 paid route and buyer-visible return package without affecting marketplace success score."
      },
      hostedJobPack: {
        available: true,
        purpose:
          "The hosted agent_job_pack can run the same tiny paid proving job as a helper for agents that do not have a funded buyer wallet yet."
      },
      sellerReady: {
        command: "pnpm seller:ready -- --env-file .env.santaclawz --json",
        purpose: "Seller operators can prove their own runtime locally, then rerun readiness."
      }
    },
    operationalStatus: {
      paymentStatus: "not_attempted",
      settlementStatus: "not_attempted",
      relayDeliveryStatus: "not_attempted",
      agentExecutionStatus: "not_started"
    }
  };
}

function compactPaymentLedgerEntryForPublicSnapshot(entry: PaymentLedgerEntry): PaymentLedgerEntry {
  return {
    ledgerId: entry.ledgerId,
    createdAtIso: entry.createdAtIso,
    updatedAtIso: entry.updatedAtIso,
    agentId: entry.agentId,
    sessionId: entry.sessionId,
    ...(entry.quoteIntentId ? { quoteIntentId: entry.quoteIntentId } : {}),
    ...(entry.hireRequestId ? { hireRequestId: entry.hireRequestId } : {}),
    ...(entry.resource ? { resource: entry.resource } : {}),
    pricingMode: entry.pricingMode,
    rail: entry.rail,
    networkId: entry.networkId,
    assetSymbol: entry.assetSymbol,
    amountUsd: entry.amountUsd,
    ...(entry.sellerNetAmountUsd ? { sellerNetAmountUsd: entry.sellerNetAmountUsd } : {}),
    ...(entry.protocolFeeAmountUsd ? { protocolFeeAmountUsd: entry.protocolFeeAmountUsd } : {}),
    ...(entry.settlementReference ? { settlementReference: entry.settlementReference } : {}),
    ...(entry.sellerSettlementTxHash ? { sellerSettlementTxHash: entry.sellerSettlementTxHash } : {}),
    ...(entry.protocolFeeTxHash ? { protocolFeeTxHash: entry.protocolFeeTxHash } : {}),
    transactionHashes: entry.transactionHashes.slice(0, 3),
    paymentStatus: entry.paymentStatus,
    ...(entry.executionStatus ? { executionStatus: entry.executionStatus } : {}),
    ...(entry.returnStatus ? { returnStatus: entry.returnStatus } : {}),
    ...(entry.lifecycleStatus ? { lifecycleStatus: entry.lifecycleStatus } : {}),
    ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
    ...(entry.errorMessage ? { errorMessage: entry.errorMessage.slice(0, 240) } : {}),
    ...(entry.settlementRecovery ? { settlementRecovery: entry.settlementRecovery } : {})
  };
}

function isActivationProbePaymentEntry(entry: PaymentLedgerEntry) {
  const resource = entry.resource ?? "";
  if (
    resource.includes("/api/activation-lane/") ||
    resource.includes("activationLane=true") ||
    resource.includes("activationProbe=true") ||
    resource.includes("sellerReadinessTest=true") ||
    resource.includes("sellerTest=true")
  ) {
    return true;
  }
  return parseUsdMicros(entry.amountUsd, "0") === parseUsdMicros(activationLaneAmountUsd(), "0");
}

function compactPaymentLedgerForPublicSnapshot(ledger: PaymentLedgerState): PaymentLedgerState {
  const entries = ledger.entries
    .filter((entry) => !isActivationProbePaymentEntry(entry))
    .map(compactPaymentLedgerEntryForPublicSnapshot);
  return {
    ...ledger,
    entries,
    totalLedgerEntryCount: Math.max(entries.length, ledger.summary?.completedPaymentCount ?? 0)
  };
}

async function agentDirectoryEntry(baseUrl: string, agent: Awaited<ReturnType<typeof controlPlane.listRegisteredAgents>>[number]) {
  let plan: Awaited<ReturnType<typeof buildX402PlanFromOptions>>["plan"] | undefined;
  try {
    plan = (await buildX402PlanFromOptions(baseUrl, { agentId: agent.agentId })).plan;
  } catch {
    plan = undefined;
  }
  const quoteReady = agent.quoteReady ?? (agent.paymentProfileReady && agent.pricingMode === "quote-required");
  const paidExecutionProven = paidExecutionProvenFromReadiness(agent.readiness);
  const paidExecutionReady =
    agent.paidExecutionReady ??
    (agent.pricingMode === "free-test" ||
      (agent.paymentProfileReady &&
        agent.paidJobsEnabled &&
        paidExecutionProven &&
        (agent.pricingMode === "fixed-exact" || agent.pricingMode === "quote-required")));
  const pricingReadiness = pricingReadinessNotes({
    pricingMode: agent.pricingMode,
    quoteReady,
    paidExecutionReady,
    ...(agent.pricingMode === "fixed-exact" || agent.pricingMode === "quote-required" ? { paidExecutionProven } : {})
  });
  const capabilityTags = agentCapabilityTags(agent, { quoteReady, paidExecutionReady });
  return {
    schemaVersion: "santaclawz-agent-directory-entry/1.0",
    agentId: agent.agentId,
    sessionId: agent.sessionId,
    agentName: agent.agentName,
    representedPrincipal: agent.representedPrincipal,
    headline: agent.headline,
    publicAgentUrl: agent.publicAgentUrl,
    publicHireUrl: agent.publicHireUrl,
    runtimeDeliveryMode: agent.runtimeDeliveryMode,
    availability: agent.availability,
    online: agent.runtimeStatus === "live" || agent.readiness?.relayConnected === true || agent.readiness?.heartbeatLive === true,
    published: agent.published,
    hireable: agent.readiness?.hireable === true,
    paymentsReady: agent.paymentProfileReady,
    quoteReady,
    paidExecutionReady,
    paidExecutionProven,
    needsUpgrade: agent.readiness?.needsUpgrade === true,
    ...(agent.readiness?.upgradeReasons?.length ? { upgradeReasons: agent.readiness.upgradeReasons } : {}),
    ...(agent.readiness?.readinessWarnings?.length ? { readinessWarnings: agent.readiness.readinessWarnings } : {}),
    capabilityTags,
    marketplaceTags: normalizedAgentMarketplaceTags(agent.marketplaceTags),
    marketplaceTagStats: agent.marketplaceTagStats ?? [],
    pricing: {
      pricingMode: agent.pricingMode,
      paymentsEnabled: agent.paymentsEnabled,
      paidJobsEnabled: agent.paidJobsEnabled,
      paymentProfileReady: agent.paymentProfileReady,
      payoutAddressConfigured: agent.payoutAddressConfigured,
      settlementTrigger: agent.settlementTrigger,
      ...(agent.paymentRail ? { defaultRail: agent.paymentRail } : {}),
      ...(agent.fixedAmountUsd ? { fixedAmountUsd: agent.fixedAmountUsd } : {}),
      ...(agent.referencePriceUsd ? { referencePriceUsd: agent.referencePriceUsd } : {}),
      ...(agent.referencePriceUnit ? { referencePriceUnit: agent.referencePriceUnit } : {}),
      ...(plan ? { costEstimate: costEstimateFromPlan(plan) } : {})
    },
    limits: hireRequestLimits(),
    readiness: {
      online: agent.runtimeStatus === "live",
      paymentsReady: agent.paymentProfileReady,
      quoteReady,
      paidExecutionReady,
      paidExecutionProven,
      needsUpgrade: agent.readiness?.needsUpgrade === true,
      ...(agent.readiness?.upgradeReasons?.length ? { upgradeReasons: agent.readiness.upgradeReasons } : {}),
      ...(agent.readiness?.readinessWarnings?.length ? { readinessWarnings: agent.readiness.readinessWarnings } : {}),
      relayConnected: agent.readiness?.relayConnected === true,
      heartbeatLive: agent.readiness?.heartbeatLive === true,
      runtimeReachable: agent.readiness?.runtimeReachable === true,
      workerReachable: agent.readiness?.workerReachable === true,
      lastHeartbeatAtIso: agent.lastHeartbeatAtIso,
      lastJobStatus: agent.readiness?.lastJobStatus ?? "none",
      pricingReadiness,
      knownBlockers: [
        ...(agent.readiness?.blockers ?? []),
        ...(paidExecutionReady ? [] : pricingReadiness.filter((note) => note.endsWith("not-ready") || note === "quote-intake-only"))
      ]
    },
    deliveryLanes: supportedDeliveryLanes(),
    privacyModes: supportedPrivacyModes(),
    reputation: {
      proofLevel: agent.proofLevel,
      proofScorePct: agent.proofLevel === "proof-backed" ? 100 : agent.proofLevel === "rooted" ? 80 : 60,
      completionScore: agent.completionScore,
      jobActivityStats: agent.jobActivityStats,
      anchoredSocialFactCount: agent.anchoredSocialFactCount,
      pendingSocialAnchorCount: agent.pendingSocialAnchorCount,
      ...(agent.lastSocialAnchorAtIso ? { lastSocialAnchorAtIso: agent.lastSocialAnchorAtIso } : {})
    }
  };
}

async function cachedRegisteredAgents() {
  return cachedPublicRead("agents-registry", () => controlPlane.listRegisteredAgents());
}

async function cachedAgentDirectoryEntries(baseUrl: string) {
  return cachedPublicRead(
    `agent-directory:${baseUrl}`,
    async () => Promise.all((await controlPlane.listRegisteredAgents()).map((agent) => agentDirectoryEntry(baseUrl, agent)))
  );
}

function setHeaders(response: IndexerResponse, headers: Record<string, string>) {
  for (const [name, value] of Object.entries(headers)) {
    response.set(name, value);
  }
}

function platformApiKeyHeader(request: IndexerRequest) {
  const explicit = request.header("x-api-key");
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim();
  }
  const authorization = request.header("authorization");
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("bearer ".length).trim();
  }
  return undefined;
}

function isPlatformApiKeyAuthorized(request: IndexerRequest) {
  const apiKey = platformApiKeyHeader(request);
  if (!apiKey || securityConfig.apiKeyHashes.length === 0) {
    return false;
  }
  const presented = Buffer.from(createHash("sha256").update(apiKey).digest("hex"), "hex");
  return securityConfig.apiKeyHashes.some((expectedHash) => {
    if (!/^[a-f0-9]{64}$/i.test(expectedHash)) return false;
    const expected = Buffer.from(expectedHash, "hex");
    return expected.length === presented.length && timingSafeEqual(presented, expected);
  });
}

async function buildQuoteIntentRuntime(baseUrl: string, intentId: string) {
  const context = await controlPlane.quotePaymentContextForIntent(intentId);
  const runtime = await buildQuoteIntentX402RuntimeContext({
    baseUrl,
    consoleState: context.consoleState,
    serviceNetworkId: context.consoleState.deployment.networkId,
    intentId: context.intent.intentId,
    rail: context.intent.rail,
    amountUsd: context.intent.grossAmountUsd
  });
  return {
    ...context,
    runtime
  };
}

function jsonDigestSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function paymentLedgerListOptionsFromQuery(query: unknown) {
  const limit = queryString(query, "limit");
  const agentId = queryString(query, "agentId");
  const sessionId = queryString(query, "sessionId");
  const quoteIntentId = queryString(query, "quoteIntentId") ?? queryString(query, "intentId");
  const hireRequestId = queryString(query, "hireRequestId") ?? queryString(query, "requestId");
  const x402RequestId = queryString(query, "x402RequestId");
  const paymentPayloadDigestSha256 =
    queryString(query, "paymentPayloadDigestSha256") ??
    queryString(query, "paymentPayloadDigest") ??
    queryString(query, "payloadDigest");
  const scoped = Boolean(agentId || sessionId || quoteIntentId || hireRequestId || x402RequestId || paymentPayloadDigestSha256);
  const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
  const boundedLimit = typeof parsedLimit === "number" && Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(parsedLimit, scoped ? 500 : 100))
    : undefined;
  return {
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(quoteIntentId ? { quoteIntentId } : {}),
    ...(hireRequestId ? { hireRequestId } : {}),
    ...(x402RequestId ? { x402RequestId } : {}),
    ...(paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256 } : {}),
    ...(boundedLimit !== undefined ? { limit: boundedLimit } : {})
  };
}

function paymentStateRetryEndpoint(input: {
  apiBase: string;
  ledgerId?: string;
  settlementCanRetry?: boolean;
  intentId?: string;
  requestId?: string;
  agentId?: string;
  paymentPayloadDigestSha256?: string;
}) {
  if (input.settlementCanRetry && input.ledgerId) {
    return `${input.apiBase}/api/x402/settlement-retry?${new URLSearchParams({ ledgerId: input.ledgerId }).toString()}`;
  }
  if (input.intentId) {
    return `${input.apiBase}/api/x402/quote-intent?${new URLSearchParams({ intentId: input.intentId }).toString()}`;
  }
  if (input.paymentPayloadDigestSha256) {
    return `${input.apiBase}/api/x402/payment-state?${new URLSearchParams({ paymentPayloadDigestSha256: input.paymentPayloadDigestSha256 }).toString()}`;
  }
  if (input.requestId) {
    return `${input.apiBase}/api/executions/${encodeURIComponent(input.requestId)}/state`;
  }
  if (input.agentId) {
    return `${input.apiBase}/api/agents/${encodeURIComponent(input.agentId)}/hire`;
  }
  return undefined;
}

async function optionalExecutionIntentResult(intentId: string | undefined) {
  if (!intentId) return undefined;
  try {
    return await controlPlane.getExecutionIntentResult(intentId);
  } catch {
    return undefined;
  }
}

async function optionalHireRequest(requestId: string | undefined) {
  if (!requestId) return undefined;
  try {
    return await controlPlane.getHireRequest(requestId);
  } catch {
    return undefined;
  }
}

function hireRequestHasPostAckRelayTimeout(hireRequest: Awaited<ReturnType<typeof optionalHireRequest>>): boolean {
  return Boolean(
    hireRequest &&
      !hireRequest.protocolReturn &&
      !hireRequest.returnValidationError &&
      (
        hireRequest.deliveryReceipt?.errorCode === "relay_return_timeout_after_worker_ack" ||
        ((hireRequest.relayTrace ?? []).some((entry) =>
          (entry.step === "worker_ack" || entry.step === "received_by_worker") && entry.status === "completed"
        ) &&
          hireRequest.deliveryReceipt?.stage === "relay_timeout")
      )
  );
}

function hireRequestRelayReachedWorker(hireRequest: Awaited<ReturnType<typeof optionalHireRequest>>): boolean {
  return Boolean(
    hireRequest?.relayTrace?.some((entry) =>
      entry.status === "completed" &&
        (
          entry.step === "received_by_worker" ||
          entry.step === "worker_ack" ||
          entry.step === "worker_completed" ||
          entry.step === "hire_response_prepared"
        )
    )
  );
}

function ledgerHasSettledPayment(entry: PaymentLedgerEntry | undefined): boolean {
  return Boolean(
    entry &&
      (
        entry.paymentStatus === "settled" ||
        entry.paymentStatus === "already_settled" ||
        Boolean(entry.sellerSettlementTxHash) ||
        Boolean(entry.protocolFeeTxHash) ||
        entry.transactionHashes.length > 0
      )
  );
}

function protocolReturnHasBuyerDelivery(protocolReturn: unknown): boolean {
  if (!isRecord(protocolReturn) || protocolReturn.status !== "completed") return false;
  const verifiedOutput = isRecord(protocolReturn.verifiedOutput) ? protocolReturn.verifiedOutput : undefined;
  if (!verifiedOutput) return false;
  const buyerVisibleOutputs = Array.isArray(verifiedOutput.buyerVisibleOutputs)
    ? verifiedOutput.buyerVisibleOutputs
    : [];
  const readableInlineOutput = buyerVisibleOutputs.some(
    (entry) => isRecord(entry) && typeof entry.text === "string" && entry.text.trim().length > 0
  );
  const deliverableReferenceCount =
    typeof verifiedOutput.deliverableReferenceCount === "number" && Number.isFinite(verifiedOutput.deliverableReferenceCount)
      ? verifiedOutput.deliverableReferenceCount
      : 0;
  return Boolean(
    readableInlineOutput ||
      deliverableReferenceCount > 0 ||
      (typeof verifiedOutput.artifactManifestUrl === "string" && verifiedOutput.artifactManifestUrl.trim().length > 0) ||
      (typeof verifiedOutput.artifactBundleDigestSha256 === "string" && /^[a-f0-9]{64}$/i.test(verifiedOutput.artifactBundleDigestSha256))
  );
}

function projectedPaymentStatusForAcceptedReturn(entry: PaymentLedgerEntry): PaymentLedgerEntry["paymentStatus"] {
  if (entry.paymentStatus === "settlement_failed") {
    return "settlement_failed";
  }
  if (ledgerHasSettledPayment(entry)) {
    if (
      entry.paymentStatus === "settled" ||
      entry.paymentStatus === "already_settled" ||
      entry.paymentStatus === "seller_settled" ||
      entry.paymentStatus === "protocol_fee_settled" ||
      entry.paymentStatus === "partially_settled"
    ) {
      return entry.paymentStatus;
    }
    return "settled";
  }
  return "execution_completed";
}

function projectPaymentLedgerEntryFromCanonicalExecution(
  entry: PaymentLedgerEntry | undefined,
  hireRequest: Awaited<ReturnType<typeof optionalHireRequest>>
): PaymentLedgerEntry | undefined {
  if (!entry || !hireRequest || !protocolReturnHasBuyerDelivery(hireRequest.protocolReturn) || hireRequest.returnValidationError) {
    return entry;
  }
  return {
    ...entry,
    hireRequestId: hireRequest.requestId,
    paymentStatus: projectedPaymentStatusForAcceptedReturn(entry),
    executionStatus: "completed",
    returnStatus: "accepted"
  };
}

function paymentLedgerEntryHasAcceptedBuyerDelivery(
  entry: PaymentLedgerEntry | undefined,
  hireRequest: Awaited<ReturnType<typeof optionalHireRequest>>
): boolean {
  return Boolean(
    entry?.hireRequestId &&
      entry.executionStatus === "completed" &&
      entry.returnStatus === "accepted" &&
      (
        protocolReturnHasBuyerDelivery(hireRequest?.protocolReturn) ||
        isRecord(entry.deliveryReceipt)
      )
  );
}

async function buildX402PaymentStateResponse(input: {
  apiBase: string;
  ledgerId?: string;
  intentId?: string;
  requestId?: string;
  paymentPayloadDigestSha256?: string;
}) {
  const ledgerEntry = input.ledgerId ? await controlPlane.getPaymentLedgerEntry(input.ledgerId) : undefined;
  const paymentLedger = await controlPlane.listPaymentLedger({
    ...(input.intentId ? { quoteIntentId: input.intentId } : {}),
    ...(input.requestId ? { hireRequestId: input.requestId } : {}),
    ...(input.paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256: input.paymentPayloadDigestSha256 } : {}),
    limit: 10
  });
  const entries = ledgerEntry
    ? [
        ledgerEntry,
        ...paymentLedger.entries.filter((entry) => entry.ledgerId !== ledgerEntry.ledgerId)
      ]
    : paymentLedger.entries;
  const rawLatestLedger = entries[0];
  const intentId = input.intentId ?? rawLatestLedger?.quoteIntentId;
  const requestId = input.requestId ?? rawLatestLedger?.hireRequestId;
  const intent = await optionalExecutionIntentResult(intentId);
  const hireRequest = await optionalHireRequest(
    requestId ?? (isRecord(intent) && isRecord(intent.latestExecution) && typeof intent.latestExecution.requestId === "string"
      ? intent.latestExecution.requestId
      : undefined)
  );
  const latestLedger = projectPaymentLedgerEntryFromCanonicalExecution(rawLatestLedger, hireRequest);
  const projectedEntries = entries.map((entry) =>
    latestLedger && entry.ledgerId === latestLedger.ledgerId ? latestLedger : entry
  );
  const resolvedRequestId = hireRequest?.requestId ?? requestId;
  const paymentPayloadDigestSha256 = input.paymentPayloadDigestSha256 ?? latestLedger?.paymentPayloadDigestSha256;
  const stateEndpoint = resolvedRequestId
    ? `${input.apiBase}/api/executions/${encodeURIComponent(resolvedRequestId)}/state${
        paymentPayloadDigestSha256
          ? `?${new URLSearchParams({ paymentPayloadDigestSha256 }).toString()}`
          : ""
      }`
    : intentId
      ? `${input.apiBase}/api/execution/intents/${encodeURIComponent(intentId)}`
      : paymentPayloadDigestSha256
        ? `${input.apiBase}/api/x402/payment-state?${new URLSearchParams({ paymentPayloadDigestSha256 }).toString()}`
        : undefined;
  const latestLifecycle = latestLedger?.lifecycleStatus;
  const postAckPending = hireRequestHasPostAckRelayTimeout(hireRequest);
  const payloadExpiredForRetry = latestLedger?.errorCode === "payment_payload_expired_for_retry";
  const paymentSettled = ledgerHasSettledPayment(latestLedger);
  const returnAccepted = latestLedger?.returnStatus === "accepted";
  const expiredAuthorizationNoChargeTerminal =
    Boolean(payloadExpiredForRetry && postAckPending && latestLedger && !paymentSettled && !returnAccepted);
  const paymentAuthorized =
    latestLedger?.paymentStatus === "authorization_verified" ||
    latestLedger?.paymentStatus === "payment_verified" ||
    latestLedger?.paymentStatus === "settled" ||
    latestLedger?.paymentStatus === "already_settled" ||
    latestLedger?.paymentStatus === "execution_completed";
  const terminal =
    expiredAuthorizationNoChargeTerminal ||
    (!postAckPending &&
      (
        latestLifecycle?.completionStatus === "completed" ||
        latestLifecycle?.completionStatus === "failed" ||
        latestLifecycle?.completionStatus === "return_rejected" ||
        (isRecord(intent) && isRecord(intent.intent) && (intent.intent.status === "settled" || intent.intent.status === "refunded"))
      ));
  const needsAttention =
    !expiredAuthorizationNoChargeTerminal &&
    !postAckPending &&
    (latestLifecycle?.needsAttention === true || latestLedger?.paymentStatus === "settlement_failed");
  const paymentRetrySafety = paymentPayloadRetrySafety({
    paymentPayloadDigestSha256,
    terminal,
    latestLedger
  });
  const { payloadRetryRejected, safeToRetrySamePayload } = paymentRetrySafety;
  const latestLedgerRecord = isRecord(latestLedger) ? latestLedger : undefined;
  const ledgerSettlementStatus = paymentSettled
    ? "settled"
    : latestLedger?.paymentStatus === "settlement_failed"
      ? "failed"
    : typeof latestLedgerRecord?.settlementStatus === "string"
      ? latestLedgerRecord.settlementStatus
      : undefined;
  const paymentStatePaymentStatus = paymentSettled
    ? "settled"
    : latestLedger?.paymentStatus === "settlement_failed"
      ? "settlement_failed"
      : paymentAuthorized
        ? "authorized"
        : latestLedger?.paymentStatus ?? "unknown";
  const paymentStateSettlementStatus = ledgerSettlementStatus ?? (paymentAuthorized ? "authorized" : "not_attempted");
  const paymentStateProofStatus =
    hireRequest?.returnValidationError || latestLedger?.returnStatus === "rejected"
      ? "return_rejected"
      : hireRequest?.protocolReturn?.verifiedOutput || latestLedger?.returnStatus === "accepted"
        ? "return_validated"
        : "not_started";
  const paymentStateRelayDeliveryStatus =
    hireRequest?.operationalStatus?.relayDeliveryStatus ?? hireRequest?.deliveryStatus ?? "not_attempted";
  const paymentStateAgentExecutionStatus =
    hireRequest?.operationalStatus?.agentExecutionStatus ??
    latestLedger?.executionStatus ??
    hireRequest?.status ??
    "not_started";
  const paymentStateWorkerReached = hireRequestRelayReachedWorker(hireRequest);
  const paymentStateRelayFailedBeforeWorkerAck = Boolean(
    paymentStateRelayDeliveryStatus === "failed" && !paymentStateWorkerReached
  );
  const paymentStateBuyerDeliveryAvailable = protocolReturnHasBuyerDelivery(hireRequest?.protocolReturn);
  const paymentStateSellerCompleted = Boolean(
    paymentStateBuyerDeliveryAvailable ||
      latestLedger?.returnStatus === "accepted" ||
      (
        hireRequest?.status === "completed" &&
        hireRequest.protocolReturn?.status === "completed" &&
        paymentStateProofStatus !== "return_rejected"
      )
  );
  const paymentStateSellerFailure = Boolean(
    !paymentStateRelayFailedBeforeWorkerAck &&
      (
        paymentStateProofStatus === "return_rejected" ||
        latestLedger?.executionStatus === "failed" ||
        paymentStateAgentExecutionStatus === "failed" ||
        paymentStateAgentExecutionStatus === "worker_completed_return_rejected"
      )
  );
  const protocolLifecycle = reduceSantaClawzPaidLifecycle({
    paymentStatus: latestLedger?.paymentStatus,
    settlementStatus: paymentStateSettlementStatus,
    relayDeliveryStatus: paymentStateRelayDeliveryStatus,
    agentExecutionStatus: paymentStateAgentExecutionStatus,
    proofStatus: paymentStateProofStatus,
    sellerExecutionCompleted: paymentStateSellerCompleted,
    buyerDeliveryAvailable: paymentStateBuyerDeliveryAvailable,
    buyerComplete: paymentStateBuyerDeliveryAvailable,
    paymentAuthorized,
    paymentSettled,
    hasFailure: paymentStateSellerFailure,
    returnRejected: paymentStateProofStatus === "return_rejected",
    expiredAuthorizationNoCharge: expiredAuthorizationNoChargeTerminal,
    safeToRetrySamePayload,
    paymentPayloadRetryRejected: payloadRetryRejected,
    platformTimedOutAfterWorkerAck: postAckPending,
    platformFailure: Boolean(
      paymentAuthorized &&
        !postAckPending &&
        (paymentStateRelayFailedBeforeWorkerAck || paymentStateRelayDeliveryStatus === "failed") &&
        !paymentStateSellerCompleted &&
        !paymentStateSellerFailure
    )
  });
  const safeToCreateNewPayment = latestLedger
    ? protocolLifecycle.buyerAnswer.canCreateFreshPayment
    : false;
  const canonicalSafeToRetrySamePayload = latestLedger
    ? protocolLifecycle.buyerAnswer.canRetrySamePaymentPayload
    : safeToRetrySamePayload;
  const retryResumeTerminal = latestLedger
    ? protocolLifecycle.terminal
    : false;
  const nextAction = retryResumeActionForLifecycle({
    lifecycle: protocolLifecycle,
    expiredAuthorizationNoChargeTerminal,
    payloadRetryRejected,
    postAckPending,
    ...(resolvedRequestId ? { resolvedRequestId } : {}),
    settlementCanRetry: latestLedger?.settlementRecovery?.canRetrySettlement,
    paymentAuthorized
  });
  const settlementCanRetry = latestLedger?.settlementRecovery?.canRetrySettlement === true;
  const retryGuidance = retryResumeGuidanceForLifecycle({
    lifecycle: protocolLifecycle,
    expiredAuthorizationNoChargeTerminal,
    payloadRetryRejected,
    ...(paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256 } : {}),
    safeToRetrySamePayload: canonicalSafeToRetrySamePayload
  });
  const partyFinality = lifecyclePartyFinality({
    lifecycle: protocolLifecycle,
    paymentSettled
  });
  const settlementCompletionRequired = Boolean(
    latestLedger &&
      protocolLifecycle.operatorObligation === "settle_payment" &&
      paymentStateBuyerDeliveryAvailable &&
      paymentAuthorized &&
      !paymentSettled
  );
  const settlementActionEndpoint =
    settlementCanRetry || settlementCompletionRequired
      ? paymentStateRetryEndpoint({
          apiBase: input.apiBase,
          ...(latestLedger?.ledgerId ? { ledgerId: latestLedger.ledgerId } : {}),
          settlementCanRetry: true,
          ...(intentId ? { intentId } : {}),
          ...(resolvedRequestId ? { requestId: resolvedRequestId } : {}),
          ...(latestLedger?.agentId ? { agentId: latestLedger.agentId } : {}),
          ...(paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256 } : {})
        })
      : undefined;
  const retryEndpoint = settlementActionEndpoint ?? paymentStateRetryEndpoint({
    apiBase: input.apiBase,
    ...(latestLedger?.ledgerId ? { ledgerId: latestLedger.ledgerId } : {}),
    ...(intentId ? { intentId } : {}),
    ...(resolvedRequestId ? { requestId: resolvedRequestId } : {}),
    ...(latestLedger?.agentId ? { agentId: latestLedger.agentId } : {}),
    ...(paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256 } : {})
  });
  const canonicalExecution = hireRequest
    ? {
        ...hireRequest,
        operationalStatus: {
          ...(hireRequest.operationalStatus ?? {}),
          paymentStatus: paymentStatePaymentStatus,
          settlementStatus: paymentStateSettlementStatus
        }
      }
    : undefined;
  const stateProjectionUpdatedAtIso = new Date().toISOString();
  const ledgerUpdatedAtIso = latestLedger?.updatedAtIso;
  const sourceFreshnessMs = sourceFreshnessMsFromIso(ledgerUpdatedAtIso, stateProjectionUpdatedAtIso);
  return {
    schemaVersion: "santaclawz-x402-payment-state/1.0",
    ok: true,
    generatedAtIso: stateProjectionUpdatedAtIso,
    stateProjectionUpdatedAtIso,
    ...(ledgerUpdatedAtIso ? { ledgerUpdatedAtIso } : {}),
    ...(sourceFreshnessMs !== undefined ? { sourceFreshnessMs } : {}),
    sourceFreshness: {
      stateProjectionUpdatedAtIso,
      ...(ledgerUpdatedAtIso ? { ledgerUpdatedAtIso } : {}),
      ...(sourceFreshnessMs !== undefined ? { sourceFreshnessMs } : {}),
      ...(hireRequest?.submittedAtIso ? { executionSubmittedAtIso: hireRequest.submittedAtIso } : {}),
      paymentStateCanonicalForRetrySafety: true,
      expectedConsistency:
        "payment-state is canonical for retry safety; execution-state can expose buyer delivery or finality first during settlement convergence"
    },
    lookup: {
      ...(input.ledgerId ? { ledgerId: input.ledgerId } : {}),
      ...(intentId ? { intentId } : {}),
      ...(resolvedRequestId ? { requestId: resolvedRequestId } : {}),
      ...(paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256 } : {})
    },
    payment: {
      entries: projectedEntries,
      ...(latestLedger ? { latestLedger } : {}),
      ledgerEntryCount: projectedEntries.length
    },
    protocolLifecycle,
    protocolState: protocolLifecycle.protocolState,
    buyerAction: protocolLifecycle.buyerAction,
    sellerOutcome: protocolLifecycle.sellerOutcome,
    operatorObligation: protocolLifecycle.operatorObligation,
    ...lifecycleFinalityFields(protocolLifecycle),
    partyFinality,
    paymentStatus: paymentStatePaymentStatus,
    settlementStatus: paymentStateSettlementStatus,
    ...(intent ? { intent } : {}),
    ...(canonicalExecution ? { execution: canonicalExecution } : {}),
    retryResume: {
      safeToRetrySamePayload: canonicalSafeToRetrySamePayload,
      safeToCreateNewPayment,
      ...(postAckPending && !payloadRetryRejected
        ? {
            retryMode: "same_payment_payload_only",
            safeToRetrySamePaymentPayload: canonicalSafeToRetrySamePayload,
            workerAcknowledged: true,
            lateCompletionSupported: true,
            resultMayStillArrive: true
          }
        : {}),
      nextAction,
      terminal: retryResumeTerminal,
      needsAttention,
      ...(expiredAuthorizationNoChargeTerminal
        ? {
            terminalReason: "payment_payload_expired_no_charge",
            refundOrNoChargeStatus: "no_charge_authorization_expired",
            paymentPayloadExpiredForRetry: true,
            paymentPayloadRetryRejected: true,
            safeToRetrySamePaymentPayload: false
          }
        : {}),
      ...(payloadRetryRejected
        ? {
            ...(payloadExpiredForRetry ? { paymentPayloadExpiredForRetry: true } : {}),
            paymentPayloadRetryRejected: true,
            retryMode: expiredAuthorizationNoChargeTerminal
              ? "fresh_payment_allowed_after_expired_authorization"
              : "poll_or_reconcile_existing_payment",
            safeToRetrySamePaymentPayload: false,
            humanOrPlatformInterventionRequired: expiredAuthorizationNoChargeTerminal ? false : !resolvedRequestId
          }
        : {}),
      ...(retryEndpoint ? { retryEndpoint } : {}),
      ...(settlementActionEndpoint
        ? {
            settlementRecovery: {
              actor: "platform_or_buyer_agent_with_original_payload",
              action: settlementCompletionRequired ? "complete_settlement_same_payload" : "retry_settlement_same_payload",
              status: settlementCompletionRequired ? "pending_settlement" : "retryable_settlement_failure",
              retryEndpoint: settlementActionEndpoint,
              requiresOriginalPaymentPayload: true,
              doNotCreateNewPayment: true,
              freshPaymentForbidden: true,
              buyerAction: protocolLifecycle.buyerAction,
              settlementOwner: "platform",
              settlementQueued: settlementCompletionRequired,
              recommendedPollAfterMs: 2000,
              ...(settlementCompletionRequired ? { reason: "buyer_delivery_recorded_before_settlement" } : {})
            }
          }
        : {}),
      ...(stateEndpoint ? { stateEndpoint } : {}),
      guidance: retryGuidance
    }
  };
}

type X402PaymentStateResponse = Awaited<ReturnType<typeof buildX402PaymentStateResponse>>;

type X402PaymentStateCacheStatus = HotReadCacheStatus | "temporarily_unavailable";

function withColdReadBudget<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutErrorCode = "x402_payment_state_cold_read_timeout"
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(timeoutErrorCode)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function decorateX402PaymentStateResponse(
  payload: X402PaymentStateResponse,
  cacheStatus: X402PaymentStateCacheStatus
): X402PaymentStateResponse & {
  stateFreshness: "fresh" | "stale";
  projectionSource: X402PaymentStateCacheStatus;
  stateProjectionPending: boolean;
} {
  const stale = cacheStatus === "stale" || cacheStatus === "refreshing";
  return {
    ...payload,
    stateFreshness: stale ? "stale" : "fresh",
    projectionSource: cacheStatus,
    stateProjectionPending: stale || payload.statePollingRequired === true
  };
}

function x402PaymentStateTemporarilyUnavailable(input: {
  lookup: Record<string, string>;
  cacheKey: string;
  error?: unknown;
}) {
  const generatedAtIso = new Date().toISOString();
  return {
    schemaVersion: "santaclawz-x402-payment-state/1.0",
    ok: false,
    code: "payment_state_temporarily_unavailable",
    retryable: true,
    generatedAtIso,
    stateFreshness: "unavailable",
    projectionSource: "temporarily_unavailable",
    stateProjectionPending: true,
    lookup: input.lookup,
    cacheKey: input.cacheKey,
    safeToCreateNewPayment: false,
    safeToRetrySamePayload: false,
    retryResume: {
      nextAction: "poll_payment_state",
      terminal: false,
      safeToCreateNewPayment: false,
      safeToRetrySamePayload: false,
      doNotCreateNewPayment: true,
      recommendedPollAfterMs: 2000,
      guidance:
        "Payment state is temporarily unavailable. Do not create a fresh payment; poll this endpoint again or recover with the same saved payment payload after service recovery."
    },
    error: errorMessage(input.error, "Payment state read exceeded the protocol read budget.")
  };
}

async function cachedX402PaymentState(input: {
  cacheKey: string;
  lookup: Record<string, string>;
  producer: () => Promise<X402PaymentStateResponse>;
}): Promise<{
  payload: ReturnType<typeof x402PaymentStateTemporarilyUnavailable> | ReturnType<typeof decorateX402PaymentStateResponse>;
  cacheStatus: X402PaymentStateCacheStatus;
  statusCode?: number;
}> {
  const nowMs = Date.now();
  const cached = PAYMENT_LEDGER_CACHE_TTL_MS > 0 ? x402PaymentStateCache.get(input.cacheKey) : undefined;
  if (cached && cached.expiresAtMs > nowMs) {
    return {
      payload: decorateX402PaymentStateResponse(cached.payload as X402PaymentStateResponse, "hit"),
      cacheStatus: "hit"
    };
  }
  const inflight = x402PaymentStateInflight.get(input.cacheKey);
  if (cached && cached.retainedUntilMs > nowMs) {
    if (!inflight || inflight.epoch !== paymentLedgerCacheEpoch) {
      launchHotReadRefresh({
        cacheKey: input.cacheKey,
        cacheEpoch: paymentLedgerCacheEpoch,
        cache: x402PaymentStateCache,
        inflight: x402PaymentStateInflight,
        ttlMs: PAYMENT_LEDGER_CACHE_TTL_MS,
        producer: input.producer,
        currentCacheEpoch: () => paymentLedgerCacheEpoch,
        prune: pruneX402PaymentStateCache,
        lane: "critical"
      });
      return {
        payload: decorateX402PaymentStateResponse(cached.payload as X402PaymentStateResponse, "refreshing"),
        cacheStatus: "refreshing"
      };
    }
    return {
      payload: decorateX402PaymentStateResponse(cached.payload as X402PaymentStateResponse, "stale"),
      cacheStatus: "stale"
    };
  }
  const coldRead =
    inflight && inflight.epoch === paymentLedgerCacheEpoch
      ? inflight.promise as Promise<X402PaymentStateResponse>
      : launchHotReadRefresh({
          cacheKey: input.cacheKey,
          cacheEpoch: paymentLedgerCacheEpoch,
          cache: x402PaymentStateCache,
          inflight: x402PaymentStateInflight,
          ttlMs: PAYMENT_LEDGER_CACHE_TTL_MS,
          producer: input.producer,
          currentCacheEpoch: () => paymentLedgerCacheEpoch,
          prune: pruneX402PaymentStateCache,
          lane: "critical"
        });
  try {
    const payload = await withColdReadBudget(coldRead, X402_PAYMENT_STATE_COLD_READ_BUDGET_MS);
    return {
      payload: decorateX402PaymentStateResponse(payload, inflight ? "inflight" : "miss"),
      cacheStatus: inflight ? "inflight" : "miss"
    };
  } catch (error) {
    return {
      payload: x402PaymentStateTemporarilyUnavailable({
        lookup: input.lookup,
        cacheKey: input.cacheKey,
        error
      }),
      cacheStatus: "temporarily_unavailable",
      statusCode: 503
    };
  }
}

function sourceFreshnessMsFromIso(sourceUpdatedAtIso: string | undefined, generatedAtIso: string) {
  if (!sourceUpdatedAtIso) {
    return undefined;
  }
  const sourceMs = Date.parse(sourceUpdatedAtIso);
  const generatedMs = Date.parse(generatedAtIso);
  if (!Number.isFinite(sourceMs) || !Number.isFinite(generatedMs)) {
    return undefined;
  }
  return Math.max(0, generatedMs - sourceMs);
}

function paymentPayloadRetrySafety(input: {
  paymentPayloadDigestSha256?: string | undefined;
  terminal?: boolean | undefined;
  latestLedger?: Pick<PaymentLedgerEntry, "errorCode"> | undefined;
}) {
  const payloadExpiredForRetry = input.latestLedger?.errorCode === "payment_payload_expired_for_retry";
  const payloadRetryRejected =
    payloadExpiredForRetry ||
    input.latestLedger?.errorCode === "payment_payload_retry_failed" ||
    input.latestLedger?.errorCode === "x402_payload_shape_invalid" ||
    input.latestLedger?.errorCode === "x402_signature_verification_failed";
  return {
    payloadExpiredForRetry,
    payloadRetryRejected,
    safeToRetrySamePayload: Boolean(input.paymentPayloadDigestSha256 && !input.terminal && !payloadRetryRejected)
  };
}

function retryResumeActionForLifecycle(input: {
  lifecycle: ReturnType<typeof reduceSantaClawzPaidLifecycle>;
  expiredAuthorizationNoChargeTerminal: boolean;
  payloadRetryRejected: boolean;
  postAckPending: boolean;
  resolvedRequestId?: string | undefined;
  settlementCanRetry?: boolean | undefined;
  paymentAuthorized: boolean;
}) {
  if (input.lifecycle.buyerAction === "view_delivery") {
    return "view_delivery";
  }
  if (input.lifecycle.buyerAction === "stop_and_contact_operator") {
    return "stop_and_contact_operator";
  }
  if (input.lifecycle.buyerAction === "create_fresh_payment") {
    return input.expiredAuthorizationNoChargeTerminal
      ? "create_new_payment_or_retry_job"
      : "create_fresh_payment";
  }
  if (input.payloadRetryRejected && input.resolvedRequestId) {
    return "poll_execution_state";
  }
  if (input.payloadRetryRejected) {
    return "inspect_payment_state";
  }
  if (input.postAckPending) {
    return "poll_execution_state";
  }
  if (input.settlementCanRetry) {
    return "retry_settlement_same_payload";
  }
  if (input.resolvedRequestId) {
    return "poll_execution_state";
  }
  return input.paymentAuthorized ? "retry_same_payment_payload" : "submit_or_resubmit_payment_payload";
}

function retryResumeGuidanceForLifecycle(input: {
  lifecycle: ReturnType<typeof reduceSantaClawzPaidLifecycle>;
  expiredAuthorizationNoChargeTerminal: boolean;
  payloadRetryRejected: boolean;
  paymentPayloadDigestSha256?: string | undefined;
  safeToRetrySamePayload: boolean;
}) {
  if (input.lifecycle.buyerAction === "view_delivery") {
    if (input.lifecycle.protocolState === "DELIVERED_SETTLEMENT_FAILED_REQUIRES_RECONCILIATION") {
      return "Delivery is available. Do not retry payment and do not create a new payment. Settlement failed and requires SantaClawz reconciliation.";
    }
    return input.lifecycle.operatorObligation === "settle_payment"
      ? "Delivery is available. Do not retry payment and do not create a new payment. Read the result state while SantaClawz settles or reconciles the authorized payment."
      : "Delivery is available. Read the result state. Do not retry payment and do not create a new payment for this job.";
  }
  if (input.expiredAuthorizationNoChargeTerminal) {
    return "The signed x402 authorization expired before settlement and no accepted buyer delivery is recorded. Treat this payment path as no-charge terminal; a buyer may create a fresh payment for a new attempt.";
  }
  if (input.lifecycle.buyerAction === "stop_and_contact_operator") {
    return "This payment path needs platform reconciliation. Do not retry payment and do not create a new payment until canonical state changes.";
  }
  if (input.payloadRetryRejected) {
    return "This signed x402 payload cannot be retried for verification. Do not create a new payment while canonical state is non-terminal; poll the execution/payment state or escalate reconciliation.";
  }
  if (input.safeToRetrySamePayload && input.paymentPayloadDigestSha256) {
    return "Retry or resume with the exact same signed x402 payment payload. Do not ask the buyer to sign a new payment until this state says it failed or expired.";
  }
  if (input.paymentPayloadDigestSha256) {
    return "A signed payment payload exists, but this state does not allow retrying it. Poll the result/payment state and do not create a fresh payment.";
  }
  return "No signed payment payload digest was found yet. Submit the signed x402 payload once, then use this endpoint to resume safely.";
}

function lifecyclePartyFinality(input: {
  lifecycle: ReturnType<typeof reduceSantaClawzPaidLifecycle>;
  paymentSettled: boolean;
  buyerAccepted?: boolean | undefined;
}) {
  return {
    buyerTerminal: input.lifecycle.buyerAnswer.hasBuyerDelivery || input.lifecycle.terminal,
    sellerTerminal:
      input.lifecycle.sellerOutcome === "completed" ||
      input.lifecycle.sellerOutcome === "failed" ||
      input.lifecycle.sellerOutcome === "not_at_fault",
    paymentTerminal:
      input.paymentSettled ||
      input.lifecycle.protocolState === "EXPIRED_NO_CHARGE" ||
      input.lifecycle.protocolState === "SELLER_FAILED_NO_SETTLEMENT",
    operatorTerminal: input.lifecycle.operatorObligation === "none",
    ...(typeof input.buyerAccepted === "boolean" ? { buyerAccepted: input.buyerAccepted } : {})
  };
}

function lifecycleFinalityFields(lifecycle: ReturnType<typeof reduceSantaClawzPaidLifecycle>) {
  return {
    paymentFinality: lifecycle.paymentFinality,
    paymentFinalityPending: lifecycle.paymentFinalityPending,
    statePollingRequired: lifecycle.statePollingRequired,
    ...(typeof lifecycle.recommendedPollAfterMs === "number"
      ? { recommendedPollAfterMs: lifecycle.recommendedPollAfterMs }
      : {})
  };
}

function redactLatestPaymentLedger(entry: unknown) {
  if (!isRecord(entry)) return undefined;
  const lifecycleStatus = isRecord(entry.lifecycleStatus) ? entry.lifecycleStatus : undefined;
  const settlementRecovery = isRecord(entry.settlementRecovery) ? entry.settlementRecovery : undefined;
  const settlementFailureReason =
    typeof settlementRecovery?.settlementFailureReason === "string"
      ? settlementRecovery.settlementFailureReason
      : typeof entry.errorMessage === "string"
        ? entry.errorMessage
        : "";
  const settlementFailureLooksRetryable =
    /timeout|temporarily unavailable|rate limit|429|502|503|504|nonce|already known|underpriced|settlement_pending/i.test(
      settlementFailureReason
    );
  const settlementRetryable = Boolean(settlementRecovery?.settlementRetryable === true || settlementFailureLooksRetryable);
  return {
    ...(typeof entry.ledgerId === "string" ? { ledgerId: entry.ledgerId } : {}),
    ...(typeof entry.agentId === "string" ? { agentId: entry.agentId } : {}),
    ...(typeof entry.sessionId === "string" ? { sessionId: entry.sessionId } : {}),
    ...(typeof entry.hireRequestId === "string" ? { hireRequestId: entry.hireRequestId } : {}),
    ...(typeof entry.quoteIntentId === "string" ? { quoteIntentId: entry.quoteIntentId } : {}),
    ...(typeof entry.x402RequestId === "string" ? { x402RequestId: entry.x402RequestId } : {}),
    ...(typeof entry.paymentPayloadDigestSha256 === "string" ? { paymentPayloadDigestSha256: entry.paymentPayloadDigestSha256 } : {}),
    ...(typeof entry.paymentRequirementDigestSha256 === "string" ? { paymentRequirementDigestSha256: entry.paymentRequirementDigestSha256 } : {}),
    ...(typeof entry.rail === "string" ? { rail: entry.rail } : {}),
    ...(typeof entry.networkId === "string" ? { networkId: entry.networkId } : {}),
    ...(typeof entry.assetSymbol === "string" ? { assetSymbol: entry.assetSymbol } : {}),
    ...(typeof entry.amountUsd === "string" ? { amountUsd: entry.amountUsd } : {}),
    ...(typeof entry.paymentStatus === "string" ? { paymentStatus: entry.paymentStatus } : {}),
    ...(typeof entry.executionStatus === "string" ? { executionStatus: entry.executionStatus } : {}),
    ...(typeof entry.returnStatus === "string" ? { returnStatus: entry.returnStatus } : {}),
    ...(typeof entry.settlementStatus === "string" ? { settlementStatus: entry.settlementStatus } : {}),
    ...(settlementRecovery
      ? {
          settlementRecovery: {
            settlementRetryable,
            canRetrySettlement: settlementRetryable,
            ...(settlementFailureReason ? { settlementFailureReason } : {}),
            nextSettlementAction: settlementRetryable ? "retry_settlement" : (
              typeof settlementRecovery.nextSettlementAction === "string" ? settlementRecovery.nextSettlementAction : "manual_review"
            ),
            ...(typeof settlementRecovery.retryEndpoint === "string" ? { retryEndpoint: settlementRecovery.retryEndpoint } : {})
          }
        }
      : {}),
    ...(lifecycleStatus
      ? {
          lifecycleStatus: {
            ...(typeof lifecycleStatus.paymentStatus === "string" ? { paymentStatus: lifecycleStatus.paymentStatus } : {}),
            ...(typeof lifecycleStatus.settlementStatus === "string" ? { settlementStatus: lifecycleStatus.settlementStatus } : {}),
            ...(typeof lifecycleStatus.relayDeliveryStatus === "string" ? { relayDeliveryStatus: lifecycleStatus.relayDeliveryStatus } : {}),
            ...(typeof lifecycleStatus.agentExecutionStatus === "string" ? { agentExecutionStatus: lifecycleStatus.agentExecutionStatus } : {}),
            ...(typeof lifecycleStatus.completionStatus === "string" ? { completionStatus: lifecycleStatus.completionStatus } : {}),
            ...(typeof lifecycleStatus.needsAttention === "boolean" ? { needsAttention: lifecycleStatus.needsAttention } : {})
          }
        }
      : {})
  };
}

function redactX402PaymentStateResponse(payload: X402PaymentStateResponse) {
  const payloadRecord = payload as Record<string, unknown>;
  const payment = isRecord(payload.payment) ? payload.payment : undefined;
  const latestLedger = redactLatestPaymentLedger(payment?.latestLedger);
  const execution = isRecord(payload.execution) ? payload.execution : undefined;
  const operationalStatus = isRecord(execution?.operationalStatus) ? execution.operationalStatus : undefined;
  const protocolLifecycle = isRecord(payload.protocolLifecycle) ? payload.protocolLifecycle : undefined;
  return {
    schemaVersion: payload.schemaVersion,
    ok: payload.ok,
    generatedAtIso: payload.generatedAtIso,
    ...(typeof payload.stateProjectionUpdatedAtIso === "string" ? { stateProjectionUpdatedAtIso: payload.stateProjectionUpdatedAtIso } : {}),
    ...(typeof payload.ledgerUpdatedAtIso === "string" ? { ledgerUpdatedAtIso: payload.ledgerUpdatedAtIso } : {}),
    ...(typeof payload.sourceFreshnessMs === "number" ? { sourceFreshnessMs: payload.sourceFreshnessMs } : {}),
    ...(isRecord(payload.sourceFreshness) ? { sourceFreshness: payload.sourceFreshness } : {}),
    ...(typeof payloadRecord.stateFreshness === "string" ? { stateFreshness: payloadRecord.stateFreshness } : {}),
    ...(typeof payloadRecord.projectionSource === "string" ? { projectionSource: payloadRecord.projectionSource } : {}),
    ...(typeof payloadRecord.stateProjectionPending === "boolean" ? { stateProjectionPending: payloadRecord.stateProjectionPending } : {}),
    lookup: payload.lookup,
    redacted: true,
    ...(protocolLifecycle ? { protocolLifecycle } : {}),
    ...(typeof payload.protocolState === "string" ? { protocolState: payload.protocolState } : {}),
    ...(typeof payload.buyerAction === "string" ? { buyerAction: payload.buyerAction } : {}),
    ...(typeof payload.sellerOutcome === "string" ? { sellerOutcome: payload.sellerOutcome } : {}),
    ...(typeof payload.operatorObligation === "string" ? { operatorObligation: payload.operatorObligation } : {}),
    ...(typeof payload.paymentFinality === "string" ? { paymentFinality: payload.paymentFinality } : {}),
    ...(typeof payload.paymentFinalityPending === "boolean" ? { paymentFinalityPending: payload.paymentFinalityPending } : {}),
    ...(typeof payload.statePollingRequired === "boolean" ? { statePollingRequired: payload.statePollingRequired } : {}),
    ...(typeof payload.recommendedPollAfterMs === "number" ? { recommendedPollAfterMs: payload.recommendedPollAfterMs } : {}),
    ...(typeof payload.paymentStatus === "string" ? { paymentStatus: payload.paymentStatus } : {}),
    ...(typeof payload.settlementStatus === "string" ? { settlementStatus: payload.settlementStatus } : {}),
    ...(isRecord(payload.partyFinality) ? { partyFinality: payload.partyFinality } : {}),
    payment: {
      ledgerEntryCount: typeof payment?.ledgerEntryCount === "number" ? payment.ledgerEntryCount : 0,
      ...(latestLedger ? { latestLedger } : {})
    },
    ...(execution
      ? {
          execution: {
            ...(typeof execution.requestId === "string" ? { requestId: execution.requestId } : {}),
            ...(typeof execution.agentId === "string" ? { agentId: execution.agentId } : {}),
            ...(typeof execution.sessionId === "string" ? { sessionId: execution.sessionId } : {}),
            ...(typeof execution.status === "string" ? { status: execution.status } : {}),
            ...(operationalStatus
              ? {
                  operationalStatus: {
                    ...(typeof operationalStatus.paymentStatus === "string" ? { paymentStatus: operationalStatus.paymentStatus } : {}),
                    ...(typeof operationalStatus.settlementStatus === "string" ? { settlementStatus: operationalStatus.settlementStatus } : {}),
                    ...(typeof operationalStatus.relayDeliveryStatus === "string" ? { relayDeliveryStatus: operationalStatus.relayDeliveryStatus } : {}),
                    ...(typeof operationalStatus.agentExecutionStatus === "string" ? { agentExecutionStatus: operationalStatus.agentExecutionStatus } : {})
                  }
                }
              : {})
          }
        }
      : {}),
    retryResume: payload.retryResume
  };
}

function isEvmTransactionHash(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^0x[a-fA-F0-9]{64}$/.test(value) &&
    value.toLowerCase() !== `0x${"0".repeat(64)}`
  );
}

async function recordX402PaymentLedgerSettlement(input: {
  agentId: string;
  sessionId: string;
  pricingMode: AgentProfileState["paymentProfile"]["pricingMode"];
  railPlan: AgentX402RailPlan;
  settlement: Awaited<ReturnType<typeof settleAgentX402Payment>>;
  paymentPayload: Record<string, unknown>;
  authorizationId?: string;
  quoteIntentId?: string;
  amountUsd?: string;
  sellerNetAmountUsd?: string;
  protocolFeeAmountUsd?: string;
  protocolFeeRecipient?: string;
  protocolFeeBps?: number;
}) {
  const paymentRequired = isRecord(input.settlement.paymentRequired) ? input.settlement.paymentRequired : {};
  const settlementEvents = input.settlement.settlementEvents;
  const x402RequestId = optionalString(paymentRequired.id);
  const resource = optionalString(paymentRequired.resource);
  return controlPlane.recordPaymentLedgerSettlement({
    agentId: input.agentId,
    sessionId: input.sessionId,
    ...(input.quoteIntentId ? { quoteIntentId: input.quoteIntentId } : {}),
    ...(x402RequestId ? { x402RequestId } : {}),
    ...(resource ? { resource } : {}),
    pricingMode: input.pricingMode,
    rail: input.railPlan.rail,
    networkId: input.railPlan.networkId,
    assetSymbol: input.railPlan.assetSymbol,
    ...(input.railPlan.assetAddress ? { assetAddress: input.railPlan.assetAddress } : {}),
    amountUsd: input.amountUsd ?? input.railPlan.amountUsd ?? "0",
    ...(input.railPlan.payTo ? { sellerPayTo: input.railPlan.payTo } : {}),
    ...(input.protocolFeeRecipient ? { protocolFeeRecipient: input.protocolFeeRecipient } : {}),
    ...(typeof input.protocolFeeBps === "number" ? { protocolFeeBps: input.protocolFeeBps } : {}),
    ...(input.sellerNetAmountUsd ? { sellerNetAmountUsd: input.sellerNetAmountUsd } : {}),
    ...(input.protocolFeeAmountUsd ? { protocolFeeAmountUsd: input.protocolFeeAmountUsd } : {}),
    paymentPayloadDigestSha256: jsonDigestSha256(input.paymentPayload),
    paymentRequirementDigestSha256: jsonDigestSha256(paymentRequired),
    ...(input.authorizationId ? { authorizationId: input.authorizationId } : {}),
    ...(settlementEvents.settlementReference ? { settlementReference: settlementEvents.settlementReference } : {}),
    ...(settlementEvents.sellerSettlementTxHash ? { sellerSettlementTxHash: settlementEvents.sellerSettlementTxHash } : {}),
    ...(settlementEvents.protocolFeeTxHash ? { protocolFeeTxHash: settlementEvents.protocolFeeTxHash } : {}),
    transactionHashes: settlementEvents.transactionHashes,
    ...(input.railPlan.facilitatorUrl ? { facilitatorUrl: input.railPlan.facilitatorUrl } : {}),
    facilitatorResponseDigestSha256: jsonDigestSha256(input.settlement.remoteSettlement),
    facilitatorResponseSummary: input.settlement.remoteSettlement
  });
}

async function recordX402PaymentLedgerAuthorization(input: {
  agentId: string;
  sessionId: string;
  pricingMode: AgentProfileState["paymentProfile"]["pricingMode"];
  railPlan: AgentX402RailPlan;
  verification: Awaited<ReturnType<typeof verifyAgentX402Payment>>;
  paymentPayload: Record<string, unknown>;
  authorizationId?: string;
  quoteIntentId?: string;
  amountUsd?: string;
  sellerNetAmountUsd?: string;
  protocolFeeAmountUsd?: string;
  protocolFeeRecipient?: string;
  protocolFeeBps?: number;
}) {
  const paymentRequired = isRecord(input.verification.paymentRequired) ? input.verification.paymentRequired : {};
  const x402RequestId = optionalString(paymentRequired.id);
  const resource = optionalString(paymentRequired.resource);
  return controlPlane.recordPaymentLedgerSettlement({
    agentId: input.agentId,
    sessionId: input.sessionId,
    ...(input.quoteIntentId ? { quoteIntentId: input.quoteIntentId } : {}),
    ...(x402RequestId ? { x402RequestId } : {}),
    ...(resource ? { resource } : {}),
    pricingMode: input.pricingMode,
    rail: input.railPlan.rail,
    networkId: input.railPlan.networkId,
    assetSymbol: input.railPlan.assetSymbol,
    ...(input.railPlan.assetAddress ? { assetAddress: input.railPlan.assetAddress } : {}),
    amountUsd: input.amountUsd ?? input.railPlan.amountUsd ?? "0",
    ...(input.railPlan.payTo ? { sellerPayTo: input.railPlan.payTo } : {}),
    ...(input.protocolFeeRecipient ? { protocolFeeRecipient: input.protocolFeeRecipient } : {}),
    ...(typeof input.protocolFeeBps === "number" ? { protocolFeeBps: input.protocolFeeBps } : {}),
    ...(input.sellerNetAmountUsd ? { sellerNetAmountUsd: input.sellerNetAmountUsd } : {}),
    ...(input.protocolFeeAmountUsd ? { protocolFeeAmountUsd: input.protocolFeeAmountUsd } : {}),
    paymentPayloadDigestSha256: jsonDigestSha256(input.paymentPayload),
    paymentRequirementDigestSha256: jsonDigestSha256(paymentRequired),
    ...(input.authorizationId ? { authorizationId: input.authorizationId } : {}),
    transactionHashes: [],
    ...(input.railPlan.facilitatorUrl ? { facilitatorUrl: input.railPlan.facilitatorUrl } : {}),
    facilitatorResponseDigestSha256: jsonDigestSha256(input.verification.remoteVerification ?? input.verification.localVerification),
    facilitatorResponseSummary: {
      source: "x402-authorization-verify",
      localVerification: input.verification.localVerification,
      ...(input.verification.remoteVerification ? { remoteVerification: input.verification.remoteVerification } : {})
    },
    paymentStatus: "authorization_verified"
  });
}

async function settleCompletedAgentHirePayment(input: {
  agentId: string;
  sessionId: string;
  pricingMode: AgentProfileState["paymentProfile"]["pricingMode"];
  runtime: Parameters<typeof settleAgentX402Payment>[0]["runtime"];
  paymentPayload: Record<string, unknown>;
  requestId: string;
  authorizationId?: string;
  ledgerId?: string;
  amountUsd?: string;
  protocolFeeBps?: number;
}) {
  const settlement = await settleAgentX402Payment({
    runtime: input.runtime,
    paymentPayload: input.paymentPayload
  });
  const amountUsd = input.amountUsd ?? settlement.rail.amountUsd;
  const settledLedger = await recordX402PaymentLedgerSettlement({
    agentId: input.agentId,
    sessionId: input.sessionId,
    pricingMode: input.pricingMode,
    railPlan: settlement.rail,
    settlement,
    paymentPayload: input.paymentPayload,
    ...(input.authorizationId ? { authorizationId: input.authorizationId } : {}),
    ...(amountUsd ? { amountUsd } : {}),
    ...(typeof input.protocolFeeBps === "number" ? { protocolFeeBps: input.protocolFeeBps } : {})
  });
  await controlPlane.markHireRequestPaymentSettled({
    requestId: input.requestId,
    ...(settledLedger.settlementReference ? { settlementReference: settledLedger.settlementReference } : {}),
    ...(settledLedger.sellerSettlementTxHash ? { sellerSettlementTxHash: settledLedger.sellerSettlementTxHash } : {}),
    ...(settledLedger.protocolFeeTxHash ? { protocolFeeTxHash: settledLedger.protocolFeeTxHash } : {}),
    transactionHashes: settledLedger.transactionHashes,
    paymentResponseDigestSha256: jsonDigestSha256(settlement.paymentResponse)
  });
  return { settlement, settledLedger };
}

async function settleCompletedAgentHirePaymentOutcome(input: Parameters<typeof settleCompletedAgentHirePayment>[0]): Promise<
  | { status: "settled"; result: Awaited<ReturnType<typeof settleCompletedAgentHirePayment>> }
  | { status: "failed"; error: unknown }
> {
  try {
    return {
      status: "settled",
      result: await settleCompletedAgentHirePayment(input)
    };
  } catch (error) {
    await controlPlane.recordPaymentLedgerSettlementFailure({
      ...(input.ledgerId ? { ledgerId: input.ledgerId } : {}),
      errorMessage: errorMessage(error, "Unable to settle x402 payment."),
      settlementRetryable: isRetryableSettlementError(error)
    });
    console.warn(JSON.stringify({
      event: "x402_background_settlement_failed",
      agentId: input.agentId,
      requestId: input.requestId,
      ...(input.ledgerId ? { ledgerId: input.ledgerId } : {}),
      retryable: isRetryableSettlementError(error),
      error: errorMessage(error, "Unable to settle x402 payment.")
    }));
    return { status: "failed", error };
  }
}

async function fetchBaseRelayerTransactions(input: {
  address: string;
  apiKey: string;
  apiUrl?: string;
  startBlock?: string;
  endBlock?: string;
  sort?: "asc" | "desc";
}) {
  const transactions: Record<string, unknown>[] = [];
  const offset = 1000;
  for (let page = 1; page <= 100; page += 1) {
    const url = new URL(input.apiUrl ?? "https://api.basescan.org/api");
    url.searchParams.set("module", "account");
    url.searchParams.set("action", "txlist");
    url.searchParams.set("address", input.address);
    url.searchParams.set("startblock", input.startBlock ?? "0");
    url.searchParams.set("endblock", input.endBlock ?? "99999999");
    url.searchParams.set("page", page.toString());
    url.searchParams.set("offset", offset.toString());
    url.searchParams.set("sort", input.sort ?? "desc");
    url.searchParams.set("apikey", input.apiKey);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(EVM_RECONCILIATION_FETCH_TIMEOUT_MS)
    });
    if (!response.ok) {
      throw new Error(`BaseScan reconciliation request failed with HTTP ${response.status}.`);
    }
    const payload = await response.json() as unknown;
    if (!isRecord(payload)) {
      throw new Error("BaseScan reconciliation returned an invalid response.");
    }
    const result = payload.result;
    if (!Array.isArray(result)) {
      const message = typeof payload.message === "string" ? payload.message : "unknown BaseScan response";
      throw new Error(`BaseScan reconciliation did not return a transaction list: ${message}`);
    }
    const pageTransactions = result.filter(isRecord);
    transactions.push(...pageTransactions);
    if (pageTransactions.length < offset) {
      break;
    }
  }
  return transactions;
}

async function fetchBaseTransactionReceipt(txHash: string): Promise<Record<string, unknown> | undefined> {
  const receipt = await baseRpcCall<Record<string, unknown> | null>("eth_getTransactionReceipt", [txHash]);
  return isRecord(receipt) ? receipt : undefined;
}

interface BaseRelayerSellerPayoutTransfer {
  key: string;
  transactionHash: string;
  blockNumber?: number;
  logIndex?: string;
  agentId: string;
  sessionId: string;
  agentName: string;
  payoutWallet: string;
  valueAtomic: string;
}

function parseBaseRelayerSellerPayoutTransfers(input: {
  receipt: Record<string, unknown>;
  payoutWalletsByAddress: Map<string, { agentId: string; sessionId: string; agentName: string; payoutWallet: string }>;
}): BaseRelayerSellerPayoutTransfer[] {
  const logs = Array.isArray(input.receipt.logs) ? input.receipt.logs.filter(isRecord) : [];
  const transfers: BaseRelayerSellerPayoutTransfer[] = [];
  for (const log of logs) {
    const address = typeof log.address === "string" ? log.address.toLowerCase() : "";
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (
      address !== BASE_USDC_ADDRESS.toLowerCase() ||
      (typeof topics[0] === "string" ? topics[0].toLowerCase() : "") !== EVM_TRANSFER_TOPIC
    ) {
      continue;
    }
    const to = evmAddressFromTopic(topics[2]);
    const recipient = to ? input.payoutWalletsByAddress.get(to) : undefined;
    const data = typeof log.data === "string" ? log.data : "";
    const transactionHash = typeof log.transactionHash === "string" ? log.transactionHash : "";
    if (!recipient || !data || !isEvmTransactionHash(transactionHash)) {
      continue;
    }
    const blockHex = typeof log.blockNumber === "string" ? log.blockNumber : "";
    const logIndex = typeof log.logIndex === "string" ? log.logIndex : undefined;
    const valueAtomic = BigInt(data).toString();
    transfers.push({
      key: `${transactionHash.toLowerCase()}:${to}:${logIndex ?? transfers.length.toString()}`,
      transactionHash,
      ...(blockHex ? { blockNumber: Number.parseInt(blockHex, 16) } : {}),
      ...(logIndex ? { logIndex } : {}),
      ...recipient,
      valueAtomic
    });
  }
  return transfers;
}

interface BaseUsdcTransferLog {
  transactionHash: string;
  blockNumber: number;
  valueAtomic: string;
  occurredAtIso: string;
}

const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const EVM_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function evmAddressTopic(address: string | undefined): string | undefined {
  const trimmed = address?.trim().toLowerCase();
  if (!trimmed || !/^0x[a-f0-9]{40}$/.test(trimmed)) {
    return undefined;
  }
  return `0x${trimmed.slice(2).padStart(64, "0")}`;
}

function evmAddressFromTopic(topic: unknown): string | undefined {
  if (typeof topic !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(topic)) {
    return undefined;
  }
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function usdAmountFromUsdcAtomic(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = value % 1_000_000n;
  if (fraction === 0n) {
    return whole.toString();
  }
  return `${whole}.${fraction.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

function remoteVerificationForLedger(entry: PaymentLedgerEntry): Record<string, unknown> | undefined {
  const summary = entry.facilitatorResponseSummary;
  return isRecord(summary?.remoteVerification) ? summary.remoteVerification : undefined;
}

function feeSplitForLedger(entry: PaymentLedgerEntry): Record<string, unknown> | undefined {
  const remoteVerification = remoteVerificationForLedger(entry);
  return isRecord(remoteVerification?.feeSplit) ? remoteVerification.feeSplit : undefined;
}

function stringRecordValue(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isSponsoredBudgetSettlementFailure(entry: PaymentLedgerEntry): boolean {
  return (
    entry.paymentStatus === "settlement_failed" &&
    entry.rail === "base-usdc" &&
    entry.networkId === "eip155:8453" &&
    entry.executionStatus === "completed" &&
    entry.returnStatus === "accepted" &&
    typeof entry.errorMessage === "string" &&
    entry.errorMessage.includes("sponsored budget")
  );
}

async function baseRpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const rpcUrl = process.env.CLAWZ_BASE_RPC_URL?.trim() || "https://mainnet.base.org";
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(EVM_RECONCILIATION_FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    })
  });
  if (!response.ok) {
    throw new Error(`Base RPC ${method} failed with HTTP ${response.status}.`);
  }
  const payload = await response.json() as unknown;
  if (!isRecord(payload)) {
    throw new Error(`Base RPC ${method} returned an invalid response.`);
  }
  if (isRecord(payload.error)) {
    const message = typeof payload.error.message === "string" ? payload.error.message : JSON.stringify(payload.error);
    throw new Error(`Base RPC ${method} failed: ${message}`);
  }
  return payload.result as T;
}

async function fetchBaseUsdcTransferLogs(input: {
  fromTopic: string;
  toTopic: string;
  lookbackBlocks: number;
}): Promise<BaseUsdcTransferLog[]> {
  const latestHex = await baseRpcCall<string>("eth_blockNumber", []);
  const latestBlock = Number.parseInt(latestHex, 16);
  const lookbackBlocks = Math.min(input.lookbackBlocks, MAX_EVM_RECONCILIATION_LOOKBACK_BLOCKS);
  const startBlock = Math.max(0, latestBlock - lookbackBlocks);
  const step = 9999;
  const rawLogs: Record<string, unknown>[] = [];
  for (let fromBlock = startBlock; fromBlock <= latestBlock; fromBlock += step + 1) {
    const toBlock = Math.min(latestBlock, fromBlock + step);
    const result = await baseRpcCall<unknown[]>("eth_getLogs", [
      {
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
        address: BASE_USDC_ADDRESS,
        topics: [
          EVM_TRANSFER_TOPIC,
          input.fromTopic,
          input.toTopic
        ]
      }
    ]);
    rawLogs.push(...result.filter(isRecord));
  }
  const parsedLogs: Array<Omit<BaseUsdcTransferLog, "occurredAtIso"> & { blockHex: string }> = [];
  for (const log of rawLogs) {
    const transactionHash = typeof log.transactionHash === "string" ? log.transactionHash : "";
    const blockHex = typeof log.blockNumber === "string" ? log.blockNumber : "";
    const data = typeof log.data === "string" ? log.data : "";
    if (!isEvmTransactionHash(transactionHash) || !blockHex || !data) {
      continue;
    }
    const blockNumber = Number.parseInt(blockHex, 16);
    parsedLogs.push({
      transactionHash,
      blockNumber,
      valueAtomic: BigInt(data).toString(),
      blockHex
    });
  }
  const blockTimestamps = new Map(await Promise.all(
    Array.from(new Map(parsedLogs.map((log) => [log.blockNumber, log.blockHex])).entries()).map(async ([blockNumber, blockHex]) => {
      const block = await baseRpcCall<Record<string, unknown>>("eth_getBlockByNumber", [blockHex, false]);
      const timestampHex = typeof block.timestamp === "string" ? block.timestamp : "0x0";
      return [blockNumber, new Date(Number(BigInt(timestampHex)) * 1000).toISOString()] as const;
    })
  ));
  return parsedLogs.map(({ blockHex: _blockHex, ...log }) => ({
    ...log,
    occurredAtIso: blockTimestamps.get(log.blockNumber) ?? new Date(0).toISOString()
  }));
}

async function reconcileSponsoredBudgetSettlementFailures(input: {
  entries: PaymentLedgerEntry[];
  commit: boolean;
  lookbackBlocks: number;
  matchBeforeMs: number;
  matchAfterMs: number;
}) {
  const candidates = input.entries.filter(isSponsoredBudgetSettlementFailure);
  const byRoute = new Map<string, {
    payerTopic: string;
    sellerTopic: string;
    protocolTopic: string;
    sellerLogs?: BaseUsdcTransferLog[];
    protocolLogs?: BaseUsdcTransferLog[];
  }>();
  for (const entry of candidates) {
    const remoteVerification = remoteVerificationForLedger(entry);
    const feeSplit = feeSplitForLedger(entry);
    const payerTopic = evmAddressTopic(stringRecordValue(remoteVerification, "payer"));
    const sellerTopic = evmAddressTopic(stringRecordValue(feeSplit, "sellerPayTo") ?? entry.sellerPayTo);
    const protocolTopic = evmAddressTopic(stringRecordValue(feeSplit, "protocolFeePayTo") ?? entry.protocolFeeRecipient);
    if (!payerTopic || !sellerTopic || !protocolTopic) {
      continue;
    }
    const key = `${payerTopic}:${sellerTopic}:${protocolTopic}`;
    byRoute.set(key, { payerTopic, sellerTopic, protocolTopic });
  }
  for (const route of byRoute.values()) {
    route.sellerLogs = await fetchBaseUsdcTransferLogs({
      fromTopic: route.payerTopic,
      toTopic: route.sellerTopic,
      lookbackBlocks: input.lookbackBlocks
    });
    route.protocolLogs = await fetchBaseUsdcTransferLogs({
      fromTopic: route.payerTopic,
      toTopic: route.protocolTopic,
      lookbackBlocks: input.lookbackBlocks
    });
  }

  const usedSellerTransactions = new Set<string>();
  const matches = [];
  for (const entry of [...candidates].sort((left, right) => Date.parse(left.updatedAtIso) - Date.parse(right.updatedAtIso))) {
    const remoteVerification = remoteVerificationForLedger(entry);
    const feeSplit = feeSplitForLedger(entry);
    const payerTopic = evmAddressTopic(stringRecordValue(remoteVerification, "payer"));
    const sellerTopic = evmAddressTopic(stringRecordValue(feeSplit, "sellerPayTo") ?? entry.sellerPayTo);
    const protocolTopic = evmAddressTopic(stringRecordValue(feeSplit, "protocolFeePayTo") ?? entry.protocolFeeRecipient);
    const sellerAmount = stringRecordValue(feeSplit, "sellerAmount");
    const protocolFeeAmount = stringRecordValue(feeSplit, "protocolFeeAmount");
    const route = payerTopic && sellerTopic && protocolTopic
      ? byRoute.get(`${payerTopic}:${sellerTopic}:${protocolTopic}`)
      : undefined;
    const candidateTimeMs = Date.parse(entry.updatedAtIso);
    const sellerMatch = route?.sellerLogs
      ?.filter((log) => (
        log.valueAtomic === sellerAmount &&
        !usedSellerTransactions.has(log.transactionHash.toLowerCase()) &&
        Date.parse(log.occurredAtIso) >= candidateTimeMs - input.matchBeforeMs &&
        Date.parse(log.occurredAtIso) <= candidateTimeMs + input.matchAfterMs
      ))
      .sort((left, right) => Math.abs(Date.parse(left.occurredAtIso) - candidateTimeMs) - Math.abs(Date.parse(right.occurredAtIso) - candidateTimeMs))[0];
    const protocolMatch = sellerMatch
      ? route?.protocolLogs
        ?.filter((log) => (
          log.valueAtomic === protocolFeeAmount &&
          Math.abs(log.blockNumber - sellerMatch.blockNumber) <= 1
        ))
        .sort((left, right) => {
          const leftSameTx = left.transactionHash.toLowerCase() === sellerMatch.transactionHash.toLowerCase();
          const rightSameTx = right.transactionHash.toLowerCase() === sellerMatch.transactionHash.toLowerCase();
          if (leftSameTx !== rightSameTx) {
            return leftSameTx ? -1 : 1;
          }
          return Math.abs(left.blockNumber - sellerMatch.blockNumber) - Math.abs(right.blockNumber - sellerMatch.blockNumber);
        })[0]
      : undefined;
    if (!sellerMatch || !protocolMatch) {
      matches.push({
        ledgerId: entry.ledgerId,
        requestId: entry.hireRequestId,
        matched: false,
        reason: "no_onchain_transfer_match"
      });
      continue;
    }
    usedSellerTransactions.add(sellerMatch.transactionHash.toLowerCase());
    const match = {
      ledgerId: entry.ledgerId,
      requestId: entry.hireRequestId,
      matched: true,
      ledgerUpdatedAtIso: entry.updatedAtIso,
      sellerSettlementTxHash: sellerMatch.transactionHash,
      sellerSettlementBlock: sellerMatch.blockNumber,
      sellerSettlementAtIso: sellerMatch.occurredAtIso,
      protocolFeeTxHash: protocolMatch.transactionHash,
      protocolFeeBlock: protocolMatch.blockNumber,
      protocolFeeAtIso: protocolMatch.occurredAtIso
    };
    if (input.commit) {
      await controlPlane.reconcilePaymentLedgerSettlement({
        ledgerId: entry.ledgerId,
        settlementReference: sellerMatch.transactionHash,
        sellerSettlementTxHash: sellerMatch.transactionHash,
        protocolFeeTxHash: protocolMatch.transactionHash,
        transactionHashes: [sellerMatch.transactionHash, protocolMatch.transactionHash],
        evidence: {
          source: "base_rpc_usdc_transfer_logs",
          priorErrorCode: entry.errorCode,
          priorErrorMessage: entry.errorMessage,
          sellerSettlementBlock: sellerMatch.blockNumber,
          protocolFeeBlock: protocolMatch.blockNumber
        }
      });
      if (entry.hireRequestId) {
        await controlPlane.markHireRequestPaymentSettled({
          requestId: entry.hireRequestId,
          settlementReference: sellerMatch.transactionHash,
          sellerSettlementTxHash: sellerMatch.transactionHash,
          protocolFeeTxHash: protocolMatch.transactionHash,
          transactionHashes: [sellerMatch.transactionHash, protocolMatch.transactionHash]
        });
      }
    }
    matches.push(match);
  }
  return {
    candidateCount: candidates.length,
    matchedCount: matches.filter((match) => match.matched).length,
    reconciledCount: input.commit ? matches.filter((match) => match.matched).length : 0,
    matches
  };
}

async function reconcileBaseSellerPayoutRollup(input: {
  transactions: Record<string, unknown>[];
  commit: boolean;
}) {
  const payoutWallets = await controlPlane.listBasePayoutWallets();
  const payoutWalletsByAddress = new Map(
    payoutWallets.map((record) => [record.payoutWallet.toLowerCase(), record])
  );
  const transfers: BaseRelayerSellerPayoutTransfer[] = [];
  const hashes = input.transactions
    .map((tx) => typeof tx.hash === "string" ? tx.hash : "")
    .filter(isEvmTransactionHash);
  const batchSize = 20;
  for (let index = 0; index < hashes.length; index += batchSize) {
    const receipts = await Promise.all(
      hashes.slice(index, index + batchSize).map((hash) => fetchBaseTransactionReceipt(hash))
    );
    for (const receipt of receipts) {
      if (!receipt) {
        continue;
      }
      transfers.push(...parseBaseRelayerSellerPayoutTransfers({
        receipt,
        payoutWalletsByAddress
      }));
    }
  }
  const uniqueTransfers = Array.from(new Map(transfers.map((transfer) => [transfer.key, transfer])).values());
  const completedBaseSellerPayoutAtomic = uniqueTransfers.reduce(
    (total, transfer) => total + BigInt(transfer.valueAtomic),
    0n
  );
  const completedBaseSellerPayoutUsd = usdAmountFromUsdcAtomic(completedBaseSellerPayoutAtomic);
  const allTimeStats = input.commit
    ? await controlPlane.reconcileBasePaymentLedgerRollup({
        completedBasePaymentCount: uniqueTransfers.length,
        completedBaseSellerPayoutUsd,
        countedPaymentKeys: uniqueTransfers.map((transfer) => transfer.key)
      })
    : undefined;
  const byAgent = Array.from(uniqueTransfers.reduce((agents, transfer) => {
    const current = agents.get(transfer.agentId) ?? {
      agentId: transfer.agentId,
      sessionId: transfer.sessionId,
      agentName: transfer.agentName,
      payoutWallet: transfer.payoutWallet,
      completedBasePaymentCount: 0,
      completedBaseSellerPayoutAtomic: 0n
    };
    current.completedBasePaymentCount += 1;
    current.completedBaseSellerPayoutAtomic += BigInt(transfer.valueAtomic);
    agents.set(transfer.agentId, current);
    return agents;
  }, new Map<string, {
    agentId: string;
    sessionId: string;
    agentName: string;
    payoutWallet: string;
    completedBasePaymentCount: number;
    completedBaseSellerPayoutAtomic: bigint;
  }>()).values()).map((agent) => ({
    agentId: agent.agentId,
    sessionId: agent.sessionId,
    agentName: agent.agentName,
    payoutWallet: agent.payoutWallet,
    completedBasePaymentCount: agent.completedBasePaymentCount,
    completedBaseSellerPayoutUsd: usdAmountFromUsdcAtomic(agent.completedBaseSellerPayoutAtomic)
  })).sort((left, right) => Number.parseFloat(right.completedBaseSellerPayoutUsd) - Number.parseFloat(left.completedBaseSellerPayoutUsd));
  return {
    payoutWalletCount: payoutWallets.length,
    relayerTransactionCount: input.transactions.length,
    matchedSellerPayoutTransferCount: uniqueTransfers.length,
    completedBaseSellerPayoutUsd,
    commit: input.commit,
    ...(allTimeStats ? { allTimeStats } : {}),
    byAgent,
    sampleTransfers: uniqueTransfers.slice(0, 25).map((transfer) => ({
      transactionHash: transfer.transactionHash,
      agentId: transfer.agentId,
      agentName: transfer.agentName,
      payoutWallet: transfer.payoutWallet,
      amountUsd: usdAmountFromUsdcAtomic(BigInt(transfer.valueAtomic)),
      ...(transfer.blockNumber ? { blockNumber: transfer.blockNumber } : {}),
      ...(transfer.logIndex ? { logIndex: transfer.logIndex } : {})
    }))
  };
}

async function buildX402PlanFromQuery(request: IndexerRequest) {
  const sessionId = queryString(request.query, "sessionId");
  const agentId = queryString(request.query, "agentId");
  return buildX402PlanFromOptions(getBaseUrl(request), {
    ...(sessionId ? { sessionId } : {}),
    ...(agentId ? { agentId } : {})
  });
}

async function ensureAgentOnlineForPayment(response: IndexerResponse, consoleState: ConsoleStateResponse): Promise<boolean> {
  const agentAvailability = await controlPlane.getAgentRuntimeAvailability({
    sessionId: consoleState.session.sessionId
  });
  const heartbeatLive = agentAvailability.readiness?.heartbeatLive === true || agentAvailability.heartbeat.status === "live";
  const staleAtMs = agentAvailability.heartbeat.staleAtIso ? Date.parse(agentAvailability.heartbeat.staleAtIso) : NaN;
  const heartbeatNearStale = Number.isFinite(staleAtMs) && staleAtMs - Date.now() < 5000;

  if (agentAvailability.reachable && heartbeatLive && !heartbeatNearStale) {
    return true;
  }

  response.status(503).json({
    ok: false,
    code: "agent_runtime_unavailable_retryable",
    retryable: true,
    paymentRequested: false,
    paymentStatus: "unknown",
    settlementStatus: "unknown",
    relayDeliveryStatus: "not_confirmed",
    agentExecutionStatus: "not_confirmed",
    error: "Agent runtime is unavailable or heartbeat is stale; payment not requested.",
    agentAvailability
  });
  return false;
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return (await response.json()) as T;
}

async function fetchDiscoveryDocument(baseUrl: string, sessionId?: string): Promise<ClawzAgentDiscoveryDocument> {
  const candidates = ["/.well-known/agent-interop.json", "/.well-known/clawz-agent.json"];
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  for (const candidate of candidates) {
    const url = new URL(`${normalizedBaseUrl}${candidate}`);
    if (sessionId) {
      url.searchParams.set("sessionId", sessionId);
    }

    try {
      return await fetchJson<ClawzAgentDiscoveryDocument>(url.toString());
    } catch (error) {
      if (!(error instanceof Error) || !error.message.endsWith(": 404")) {
        throw error;
      }
    }
  }

  throw new Error(`Unable to locate a ClawZ discovery document at ${normalizedBaseUrl}.`);
}

async function buildLocalInteropArtifacts(baseUrl: string, sessionId?: string, turnId?: string) {
  const snapshot = await buildInteropSnapshotFromQuery(baseUrl, {
    ...(sessionId ? { sessionId } : {}),
    ...(turnId ? { turnId } : {})
  });
  const discovery = buildDiscoveryDocument({
    baseUrl: snapshot.baseUrl,
    consoleState: snapshot.consoleState,
    sessionId: snapshot.sessionId
  });
  const bundle = buildAgentProofBundle({
    baseUrl: snapshot.baseUrl,
    consoleState: snapshot.consoleState,
    sessionView: snapshot.sessionView,
    events: snapshot.events,
    sessionId: snapshot.sessionId,
    ...(snapshot.turnId ? { turnId: snapshot.turnId } : {})
  });

  return {
    snapshot,
    discovery,
    bundle
  };
}

function parseVerificationRequest(value: unknown): ClawzAgentProofVerificationRequest {
  if (!isRecord(value)) {
    return {};
  }

  const url = optionalString(value.url);
  const sessionId = optionalString(value.sessionId);
  const turnId = optionalString(value.turnId);
  const bundle = isRecord(value.bundle) ? (value.bundle as unknown as ClawzAgentProofBundle) : undefined;
  const discovery = isRecord(value.discovery)
    ? (value.discovery as unknown as ClawzAgentDiscoveryDocument)
    : undefined;
  const witnessPlan = isRecord(value.witnessPlan)
    ? (value.witnessPlan as unknown as WitnessPlanLike)
    : undefined;

  return {
    ...(url ? { url } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(bundle ? { bundle } : {}),
    ...(discovery ? { discovery } : {}),
    ...(witnessPlan ? { witnessPlan } : {})
  };
}

async function verifyInteropProof(
  input: ClawzAgentProofVerificationRequest,
  localBaseUrl: string
): Promise<ClawzAgentProofVerificationResponse> {
  if (input.bundle) {
    const report = verifyAgentProofBundle(input.bundle, {
      ...(input.discovery ? { discovery: input.discovery } : {}),
      ...(input.witnessPlan ? { witnessPlan: input.witnessPlan } : {})
    });

    return buildProofVerificationResponse({
      source: {
        mode: "bundle",
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        discoveryProvided: Boolean(input.discovery),
        witnessPlanProvided: Boolean(input.witnessPlan)
      },
      bundle: input.bundle,
      report,
      ...(input.discovery ? { discovery: input.discovery } : {})
    });
  }

  if (input.url) {
    const baseUrl = normalizeBaseUrl(input.url);
    const discovery = input.discovery ?? (await fetchDiscoveryDocument(baseUrl, input.sessionId));
    const proofUrl = new URL(`${baseUrl}/api/interop/agent-proof`);
    if (input.sessionId) {
      proofUrl.searchParams.set("sessionId", input.sessionId);
    }
    if (input.turnId) {
      proofUrl.searchParams.set("turnId", input.turnId);
    }
    const bundle = await fetchJson<ClawzAgentProofBundle>(proofUrl.toString());
    const report = verifyAgentProofBundle(bundle, {
      discovery,
      ...(input.witnessPlan ? { witnessPlan: input.witnessPlan } : {})
    });

    return buildProofVerificationResponse({
      source: {
        mode: "live-url",
        baseUrl,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        discoveryProvided: true,
        witnessPlanProvided: Boolean(input.witnessPlan)
      },
      bundle,
      report,
      discovery
    });
  }

  const local = await buildLocalInteropArtifacts(localBaseUrl, input.sessionId, input.turnId);
  const report = verifyAgentProofBundle(local.bundle, {
    discovery: local.discovery,
    ...(input.witnessPlan ? { witnessPlan: input.witnessPlan } : {})
  });

  return buildProofVerificationResponse({
    source: {
      mode: "self",
      baseUrl: local.snapshot.baseUrl,
      sessionId: local.snapshot.sessionId,
      ...(local.snapshot.turnId ? { turnId: local.snapshot.turnId } : {}),
      discoveryProvided: true,
      witnessPlanProvided: Boolean(input.witnessPlan)
    },
    bundle: local.bundle,
    report,
    discovery: local.discovery
  });
}

app.get("/health", route((_request, response) => {
  response.json({
    ok: true,
    service: "clawz-indexer",
    version: deploymentVersion()
  });
}));

app.get("/", route((_request, response) => {
  response.json({
    ok: true,
    service: "clawz-indexer",
    version: deploymentVersion()
  });
}));

app.get("/version", route((_request, response) => {
  response.json({
    ok: true,
    service: "clawz-indexer",
    version: deploymentVersion()
  });
}));

app.get("/ready", route((_request, response) => {
  const checks = [
    {
      label: "process",
      ok: true
    },
    {
      label: "api-auth",
      ok: !securityConfig.apiAuthRequired || securityConfig.apiKeyConfigured,
      detail: securityConfig.apiAuthRequired ? "required" : "not-required"
    }
  ];
  response.json({
    ok: true,
    service: "clawz-indexer",
    generatedAtIso: new Date().toISOString(),
    version: deploymentVersion(),
    security: publicSecurityStatus(securityConfig),
    checks
  });
}));

const handleDiscoveryDocument = route(async (request, response) => {
  try {
    const snapshot = await buildInteropSnapshot(request);
    response.json(
      buildDiscoveryDocument({
        baseUrl: snapshot.baseUrl,
        consoleState: snapshot.consoleState,
        sessionId: snapshot.sessionId
      })
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to build discovery document."
    });
  }
});

app.get("/.well-known/clawz-agent.json", handleDiscoveryDocument);
app.get("/.well-known/agent-interop.json", handleDiscoveryDocument);
app.get("/.well-known/x402.json", route(async (request, response) => {
  try {
    const { consoleState, plan } = await buildX402PlanFromQuery(request);
    const runtime = buildAgentX402RuntimeContext({
      baseUrl: getBaseUrl(request),
      plan,
      serviceNetworkId: consoleState.deployment.networkId
    });
    response.json(runtime ? buildAgentX402Catalog(runtime) : buildAgentX402CatalogPreview({
      serviceNetworkId: consoleState.deployment.networkId,
      plan
    }));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to build x402 catalog preview."
    });
  }
}));

app.get("/api/events", route(async (request, response) => {
  const sessionId = queryString(request.query, "sessionId");
  const turnId = queryString(request.query, "turnId");
  response.json(
    await controlPlane.listEvents({
      ...(sessionId ? { sessionId } : {}),
      ...(turnId ? { turnId } : {})
    })
  );
}));

app.get("/api/sessions/:sessionId", route(async (request, response) => {
  const sessionId = request.params.sessionId;
  if (!sessionId) {
    response.status(400).json({ error: "sessionId is required." });
    return;
  }

  response.json(await controlPlane.getSession(sessionId));
}));

app.get("/api/turns/:turnId/replay", route(async (request, response) => {
  const turnId = request.params.turnId;
  if (!turnId) {
    response.status(400).json({ error: "turnId is required." });
    return;
  }

  response.json(await controlPlane.getTurnReplay(turnId));
}));

app.get("/api/privacy-exceptions", route(async (request, response) => {
  response.json(await controlPlane.listPrivacyExceptions(queryString(request.query, "sessionId")));
}));

app.get("/api/console/state", route(async (request, response) => {
  try {
    const sessionId = queryString(request.query, "sessionId");
    const agentId = queryString(request.query, "agentId");
    const adminKey = adminKeyHeader(request);
    const cacheKey = [
      "console-state",
      sessionId ? `session:${sessionId}` : "",
      agentId ? `agent:${agentId}` : "",
      adminKey ? `admin:${cacheKeyDigest(adminKey)}` : "public"
    ].join("|");
    const consoleStateOptions = sessionId
      ? { sessionId, ...(adminKey ? { adminKey } : {}) }
      : agentId
        ? { agentId, ...(adminKey ? { adminKey } : {}) }
        : { ...(adminKey ? { adminKey } : {}) };
    const { payload, cacheStatus } = await cachedHotRead({
      cacheKey,
      cacheEpoch: consoleStateCacheEpoch,
      cache: consoleStateCache,
      inflight: consoleStateInflight,
      ttlMs: CONSOLE_STATE_CACHE_TTL_MS,
      producer: () => controlPlane.getConsoleState(consoleStateOptions),
      currentCacheEpoch: () => consoleStateCacheEpoch,
      prune: pruneConsoleStateCache
    });
    response.set("x-santaclawz-cache", cacheStatus);
    response.json(payload);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load console state."
    });
  }
}));

app.get("/api/agents", route(async (_request, response) => {
  const { payload, cacheStatus } = await cachedRegisteredAgents();
  response.set("x-santaclawz-cache", cacheStatus);
  response.json(payload);
}));

app.get("/api/public/marketplace-snapshot", route(async (request, response) => {
  try {
    const cacheKey = "public-marketplace-snapshot";
    const { payload, cacheStatus } = await cachedHotRead({
      cacheKey,
      cacheEpoch: publicMarketplaceSnapshotCacheEpoch,
      cache: publicMarketplaceSnapshotCache,
      inflight: publicMarketplaceSnapshotInflight,
      ttlMs: PUBLIC_MARKETPLACE_SNAPSHOT_CACHE_TTL_MS,
      producer: async () => {
        const [agents, agentBoard, paymentLedger, publicSocialAnchorQueue] = await Promise.all([
          controlPlane.listRegisteredAgents(),
          controlPlane.listAgentBoardMessages({ limit: 100 }),
          controlPlane.listPaymentLedger({ limit: 100 }),
          controlPlane.getSocialAnchorQueueState(undefined, {
            itemLimit: 100,
            batchLimit: 6,
            statuses: ["confirmed"],
            kinds: PUBLIC_SOCIAL_ANCHOR_FEED_KINDS
          })
        ]);
        return {
        schemaVersion: "santaclawz-public-marketplace-snapshot/1.0",
        ok: true,
        generatedAtIso: new Date().toISOString(),
        agentSummary: {
          totalAgentCount: agents.length,
          onlineAgentCount: agents.filter((agent) => agent.readiness?.heartbeatLive === true).length,
          forHireAgentCount: agents.filter((agent) => agent.readiness?.hireable === true && agent.paidExecutionReady).length
        },
        agentBoard,
        paymentLedger: compactPaymentLedgerForPublicSnapshot(paymentLedger),
        publicSocialAnchorQueue
        };
      },
      currentCacheEpoch: () => publicMarketplaceSnapshotCacheEpoch,
      prune: () => {
        while (publicMarketplaceSnapshotCache.size > 1) {
          const oldest = publicMarketplaceSnapshotCache.keys().next();
          if (oldest.done) break;
          publicMarketplaceSnapshotCache.delete(oldest.value);
        }
      }
    });
    response.set("x-santaclawz-cache", cacheStatus);
    response.json(payload);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load public marketplace snapshot."
    });
  }
}));

app.get("/api/agents/search", route(async (request, response) => {
  try {
    const q = queryString(request.query, "q")?.toLowerCase();
    const pricingModes = commaSet(queryString(request.query, "pricingMode"));
    const rails = commaSet(queryString(request.query, "rail"));
    const deliveryModes = commaSet(queryString(request.query, "deliveryMode"));
    const privacyModes = commaSet(queryString(request.query, "privacyMode"));
    const marketplaceTags = marketplaceTagSet(queryString(request.query, "tag"));
    const hireable = queryBoolean(request.query, "hireable");
    const online = queryBoolean(request.query, "online");
    const paymentsReady = queryBoolean(request.query, "paymentsReady");
    const quoteReady = queryBoolean(request.query, "quoteReady");
    const paidExecutionReady = queryBoolean(request.query, "paidExecutionReady");
    const rawLimit = queryString(request.query, "limit");
    const limit = rawLimit ? Math.max(1, Math.min(Number.parseInt(rawLimit, 10), 100)) : 50;
    const baseUrl = getBaseUrl(request);
    const { payload: agents, cacheStatus } = await cachedAgentDirectoryEntries(baseUrl);
    response.set("x-santaclawz-cache", cacheStatus);
    const filtered = agents.filter((agent) => {
      const tagValues = agentMarketplaceTagValues(agent.marketplaceTags);
      if (q) {
        const haystack = [
          agent.agentId,
          agent.agentName,
          agent.representedPrincipal,
          agent.headline,
          ...(agent.capabilityTags ?? []),
          ...tagValues
        ].join(" ").toLowerCase();
        if (!haystack.includes(q)) {
          return false;
        }
      }
      if (pricingModes.size > 0 && !pricingModes.has(agent.pricing.pricingMode)) {
        return false;
      }
      if (rails.size > 0 && (!agent.pricing.defaultRail || !rails.has(agent.pricing.defaultRail))) {
        return false;
      }
      if (deliveryModes.size > 0 && !agent.deliveryLanes.some((lane) => deliveryModes.has(lane.mode))) {
        return false;
      }
      if (privacyModes.size > 0 && !agent.privacyModes.some((mode) => privacyModes.has(mode.mode))) {
        return false;
      }
      if (marketplaceTags.size > 0) {
        const agentTags = new Set([
          ...(agent.capabilityTags ?? []),
          ...tagValues
        ]);
        if (![...marketplaceTags].some((tag) => agentTags.has(tag))) {
          return false;
        }
      }
      if (hireable !== undefined && agent.hireable !== hireable) {
        return false;
      }
      if (online !== undefined && agent.online !== online) {
        return false;
      }
      if (paymentsReady !== undefined && agent.paymentsReady !== paymentsReady) {
        return false;
      }
      if (quoteReady !== undefined && agent.quoteReady !== quoteReady) {
        return false;
      }
      if (paidExecutionReady !== undefined && agent.paidExecutionReady !== paidExecutionReady) {
        return false;
      }
      return true;
    });
    response.json({
      schemaVersion: "santaclawz-agent-directory-search/1.0",
      ok: true,
      generatedAtIso: new Date().toISOString(),
      cacheStatus,
      totalMatchingAgents: filtered.length,
      agents: filtered.slice(0, limit)
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to search agents."
    });
  }
}));

app.get("/api/agents/:agentId/ready", route(async (request, response) => {
  try {
    const agentId = request.params.agentId;
    if (!agentId) {
      response.status(400).json({ error: "agentId is required." });
      return;
    }
    const baseUrl = getBaseUrl(request);
    const verifyAvailability = queryBoolean(request.query, "verifyAvailability") === true;
    const [consoleState, availability, scannerHealth] = await Promise.all([
      controlPlane.getConsoleState({ agentId }),
      controlPlane.getAgentRuntimeAvailability({ agentId, verifyReachability: verifyAvailability }),
      artifactStore.scannerHealth()
    ]);
    const plan = (await buildX402PlanFromOptions(baseUrl, { agentId })).plan;
    const pricingMode = consoleState.profile.paymentProfile.pricingMode;
    const quoteReady = consoleState.paymentProfileReady && pricingMode === "quote-required";
    const paidExecutionProven = paidExecutionProvenFromReadiness(consoleState.readiness);
    const paidExecutionReady =
      pricingMode === "free-test" ||
      (consoleState.paymentProfileReady &&
        consoleState.paidJobsEnabled &&
        paidExecutionProven &&
        (pricingMode === "fixed-exact" || pricingMode === "quote-required"));
    const pricingReadiness = pricingReadinessNotes({
      pricingMode,
      quoteReady,
      paidExecutionReady,
      ...(pricingMode === "fixed-exact" || pricingMode === "quote-required" ? { paidExecutionProven } : {})
    });
    const relayAgentWorkerWarnings = availability.heartbeat.relayAgentWorkerWarnings ?? [];
    const relayAgentWorkerTiming = availability.heartbeat.relayAgentWorkerTiming;
    response.json({
      schemaVersion: "santaclawz-agent-readiness/1.0",
      ok: true,
      generatedAtIso: new Date().toISOString(),
      agentId: consoleState.agentId,
      sessionId: consoleState.session.sessionId,
      online: availability.runtimeStatus === "live",
      paymentsReady: consoleState.paymentProfileReady,
      quoteReady,
      paidExecutionReady,
      paidExecutionProven,
      ...(consoleState.readiness?.paidExecutionProvenAt ? { paidExecutionProvenAt: consoleState.readiness.paidExecutionProvenAt } : {}),
      ...(consoleState.readiness?.paidExecutionProvenBy ? { paidExecutionProvenBy: consoleState.readiness.paidExecutionProvenBy } : {}),
      ...(consoleState.readiness?.lastProvenBuild ? { lastProvenBuild: consoleState.readiness.lastProvenBuild } : {}),
      needsUpgrade: consoleState.readiness?.needsUpgrade === true,
      ...(consoleState.readiness?.upgradeReasons?.length ? { upgradeReasons: consoleState.readiness.upgradeReasons } : {}),
      ...(consoleState.readiness?.readinessWarnings?.length ? { readinessWarnings: consoleState.readiness.readinessWarnings } : {}),
      ...(consoleState.readiness?.readinessNotes?.length ? { readinessNotes: consoleState.readiness.readinessNotes } : {}),
      ...(consoleState.activationProbes ? { activationProbes: consoleState.activationProbes } : {}),
      runtimeRoutes: {
        mode: consoleState.profile.runtimeDelivery.mode,
        ...(consoleState.profile.runtimeDelivery.runtimeIngressUrl
          ? { default: consoleState.profile.runtimeDelivery.runtimeIngressUrl }
          : {}),
        ...(consoleState.profile.runtimeDelivery.runtimeRoutes?.quote_intake
          ? { quote_intake: consoleState.profile.runtimeDelivery.runtimeRoutes.quote_intake }
          : {}),
        ...(consoleState.profile.runtimeDelivery.runtimeRoutes?.paid_execution
          ? { paid_execution: consoleState.profile.runtimeDelivery.runtimeRoutes.paid_execution }
          : {})
      },
      limits: hireRequestLimits(),
      deliveryLanes: supportedDeliveryLanes(),
      scannerReady: scannerHealth.reachable,
      scanner: {
        scanner: scannerHealth.scanner,
        target: scannerHealth.target,
        reachable: scannerHealth.reachable,
        ...(scannerHealth.error ? { error: scannerHealth.error } : {})
      },
      privacyModes: supportedPrivacyModes(),
      lastHeartbeatAtIso: availability.heartbeat.lastHeartbeatAtIso,
      ...(availability.heartbeat.relayAgentWorkerRoutes ? { relayAgentWorkerRoutes: availability.heartbeat.relayAgentWorkerRoutes } : {}),
      ...(relayAgentWorkerWarnings.length ? { relayAgentWorkerWarnings } : {}),
      ...(availability.heartbeat.paidExecutionProbe ? { paidExecutionProbe: availability.heartbeat.paidExecutionProbe } : {}),
      executionTiming: {
        executionMode: relayAgentWorkerTiming?.executionMode ?? "sync",
        platformRelayTimeoutMs: RELAY_RESPONSE_TIMEOUT_MS,
        platformRelayTimeoutSeconds: Math.round(RELAY_RESPONSE_TIMEOUT_MS / 1000),
        ...(typeof relayAgentWorkerTiming?.localHireTimeoutMs === "number"
          ? {
              agentLocalHireTimeoutMs: relayAgentWorkerTiming.localHireTimeoutMs,
              agentLocalHireTimeoutSeconds: Math.round(relayAgentWorkerTiming.localHireTimeoutMs / 1000)
            }
          : {}),
        ...(typeof relayAgentWorkerTiming?.maxLocalHireTimeoutMs === "number"
          ? { maxAgentLocalHireTimeoutMs: relayAgentWorkerTiming.maxLocalHireTimeoutMs }
          : {})
      },
      lastJobStatus: consoleState.readiness?.lastJobStatus ?? "none",
      pricingReadiness,
      knownBlockers: [
        ...(consoleState.readiness?.blockers ?? []),
        ...(paidExecutionReady ? [] : pricingReadiness.filter((note) => note.endsWith("not-ready") || note === "quote-intake-only")),
        ...(scannerHealth.reachable ? [] : ["artifact-scanner-unavailable"]),
        ...(relayAgentWorkerWarnings.some((warning) => warning.startsWith("public_render_worker_url"))
          ? ["relay-worker-public-render-url"]
          : []),
        ...(relayAgentWorkerWarnings.some((warning) => warning.startsWith("env_overrides_secret_file"))
          ? ["relay-env-overrides-secret-file"]
          : [])
      ],
      readiness: consoleState.readiness,
      availability,
      pricing: {
        pricingMode,
        paymentsEnabled: consoleState.paymentsEnabled,
        paidJobsEnabled: consoleState.paidJobsEnabled,
        paymentProfileReady: consoleState.paymentProfileReady,
        payoutAddressConfigured: consoleState.payoutAddressConfigured,
        settlementTrigger: consoleState.profile.paymentProfile.settlementTrigger,
        ...(consoleState.profile.paymentProfile.defaultRail ? { defaultRail: consoleState.profile.paymentProfile.defaultRail } : {}),
        ...(consoleState.profile.paymentProfile.fixedAmountUsd ? { fixedAmountUsd: consoleState.profile.paymentProfile.fixedAmountUsd } : {}),
        ...(consoleState.profile.paymentProfile.referencePriceUsd ? { referencePriceUsd: consoleState.profile.paymentProfile.referencePriceUsd } : {}),
        ...(consoleState.profile.paymentProfile.referencePriceUnit ? { referencePriceUnit: consoleState.profile.paymentProfile.referencePriceUnit } : {}),
        costEstimate: costEstimateFromPlan(plan)
      },
      reputation: {
        completionScore: consoleState.completionScore,
        jobActivityStats: consoleState.jobActivityStats,
        anchoredSocialFactCount: (await cachedRegisteredAgents()).payload.find((agent) => agent.agentId === agentId)?.anchoredSocialFactCount ?? 0
      }
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load agent readiness."
    });
  }
}));

app.get("/api/agent-messages", route(async (request, response) => {
  try {
    const rawLimit = queryString(request.query, "limit");
    const agentId = queryString(request.query, "agentId");
    const threadId = queryString(request.query, "threadId");
    const topic = queryString(request.query, "topic") ?? queryString(request.query, "topicTag");
    const capability = queryString(request.query, "capability");
    const outputDigest =
      queryString(request.query, "outputDigestSha256") ?? queryString(request.query, "outputDigest");
    const scoped = Boolean(
      agentId ||
      threadId ||
      topic ||
      capability ||
      outputDigest
    );
    const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
    const limit = typeof parsedLimit === "number" && Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(parsedLimit, scoped ? 200 : 100))
      : undefined;
    const options = {
      ...(agentId ? { agentId } : {}),
      ...(threadId ? { threadId } : {}),
      ...(topic ? { topic } : {}),
      ...(capability ? { capability } : {}),
      ...(outputDigest ? { outputDigestSha256: outputDigest } : {}),
      ...(typeof limit === "number" && Number.isFinite(limit) ? { limit } : {})
    };
    const { payload, cacheStatus } = await cachedPublicRead(
      `agent-messages:${JSON.stringify(options)}`,
      () => controlPlane.listAgentBoardMessages(options)
    );
    response.set("x-santaclawz-cache", cacheStatus);
    response.json(payload);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load public agent messages."
    });
  }
}));

function buildWorkshopReceiptCommitment(message: AgentBoardMessage) {
  const commitmentPayload = {
    schemaVersion: "santaclawz-workshop-public-receipt-commitment/1.0",
    receiptId: message.messageId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    ...(message.swarmId ? { swarmId: message.swarmId } : {}),
    receiptType: message.messageType,
    createdAtIso: message.createdAtIso,
    updatedAtIso: message.updatedAtIso,
    ...(message.anchorCandidateId ? { anchorCandidateId: message.anchorCandidateId } : {}),
    ...(message.anchorStatus ? { anchorStatus: message.anchorStatus } : {}),
    ...(message.proofIntent ? { proofIntent: message.proofIntent } : {}),
    ...(message.requestedProofIntent ? { requestedProofIntent: message.requestedProofIntent } : {}),
    ...(message.proofAdmissionReason ? { proofAdmissionReason: message.proofAdmissionReason } : {}),
    ...(message.batchRootDigestSha256 ? { batchRootDigestSha256: message.batchRootDigestSha256 } : {}),
    ...(message.batchTxHash ? { batchTxHash: message.batchTxHash } : {})
  };
  return createHash("sha256").update(JSON.stringify(commitmentPayload), "utf8").digest("hex");
}

function buildWorkshopReceiptLedger(messages: AgentBoardState): WorkshopReceiptLedgerState {
  const receipts = messages.messages.map((message: AgentBoardMessage) => ({
    schemaVersion: "santaclawz-workshop-receipt/1.0" as const,
    receiptId: message.messageId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    ...(message.swarmId ? { swarmId: message.swarmId } : {}),
    receiptType: message.messageType,
    createdAtIso: message.createdAtIso,
    updatedAtIso: message.updatedAtIso,
    receiptCommitmentSha256: buildWorkshopReceiptCommitment(message),
    ...(message.anchorCandidateId ? { anchorCandidateId: message.anchorCandidateId } : {}),
    ...(message.anchorStatus ? { anchorStatus: message.anchorStatus } : {}),
    ...(message.anchorFailureCode ? { anchorFailureCode: message.anchorFailureCode } : {}),
    ...(message.anchorFailureReason ? { anchorFailureReason: message.anchorFailureReason } : {}),
    ...(message.anchorExpiredAtIso ? { anchorExpiredAtIso: message.anchorExpiredAtIso } : {}),
    ...(message.anchorLastAttemptAtIso ? { anchorLastAttemptAtIso: message.anchorLastAttemptAtIso } : {}),
    ...(typeof message.anchorRetryCount === "number" ? { anchorRetryCount: message.anchorRetryCount } : {}),
    ...(message.proofIntent ? { proofIntent: message.proofIntent } : {}),
    ...(message.requestedProofIntent ? { requestedProofIntent: message.requestedProofIntent } : {}),
    ...(message.proofAdmissionReason ? { proofAdmissionReason: message.proofAdmissionReason } : {}),
    ...(message.batchRootDigestSha256 ? { batchRootDigestSha256: message.batchRootDigestSha256 } : {}),
    ...(message.batchTxHash ? { batchTxHash: message.batchTxHash } : {})
  }));
  return {
    schemaVersion: "santaclawz-workshop-receipt-ledger/1.0",
    generatedAtIso: messages.generatedAtIso,
    publicDisclosure: "proof-receipts-only",
    totalReceiptCount: messages.totalVisibleMessages,
    receipts
  };
}

function buildWorkshopTraceReadUrls(baseUrl: string, message: AgentBoardMessage, workshopId = message.swarmId ?? message.threadId) {
  const encodedWorkshopId = encodeURIComponent(workshopId);
  const receiptParams = new URLSearchParams(
    message.swarmId ? { swarmId: message.swarmId } : { threadId: message.threadId }
  );
  return {
    messages: `${baseUrl}/api/workshops/${encodedWorkshopId}/messages`,
    state: `${baseUrl}/api/workshops/${encodedWorkshopId}/state`,
    receiptLedger: `${baseUrl}/api/workshop/receipt-ledger?${receiptParams.toString()}`,
    message: `${baseUrl}/api/workshops/${encodedWorkshopId}/messages/${encodeURIComponent(message.messageId)}`
  };
}

app.get("/api/workshop/receipt-ledger", route(async (request, response) => {
  try {
    const rawLimit = queryString(request.query, "limit");
    const threadId = queryString(request.query, "threadId");
    const swarmId = queryString(request.query, "swarmId");
    if (!threadId && !swarmId) {
      response.status(400).json({ error: "threadId or swarmId is required." });
      return;
    }
    const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
    const limit = typeof parsedLimit === "number" && Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(parsedLimit, 200))
      : 100;
    const options = {
      ...(threadId ? { threadId } : {}),
      ...(swarmId ? { swarmId } : {}),
      includeWorkshopCoordination: true,
      limit
    };
    const { payload, cacheStatus } = await cachedPublicRead(
      `workshop-receipt-ledger:${JSON.stringify(options)}`,
      () => controlPlane.listAgentBoardMessages(options)
    );
    response.set("x-santaclawz-cache", cacheStatus);
    response.json(buildWorkshopReceiptLedger(payload));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load workshop receipt ledger."
    });
  }
}));

app.get("/api/workshops/:workshopId/messages", route(async (request, response) => {
  try {
    const workshopId = request.params.workshopId?.trim();
    if (!workshopId) {
      response.status(400).json({ error: "workshopId is required." });
      return;
    }
    const rawLimit = queryString(request.query, "limit");
    const messageId = queryString(request.query, "messageId");
    const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
    const limit = typeof parsedLimit === "number" && Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(parsedLimit, 200))
      : 100;
    const options = {
      workshopId,
      ...(messageId ? { messageId } : {}),
      limit
    };
    const { payload, cacheStatus } = await cachedPublicRead(
      `workshop-messages:${JSON.stringify(options)}`,
      () => controlPlane.listWorkshopMessages(options)
    );
    response.set("x-santaclawz-cache", cacheStatus);
    response.json(payload);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load workshop messages."
    });
  }
}));

app.get("/api/workshops/:workshopId/messages/:messageId", route(async (request, response) => {
  try {
    const workshopId = request.params.workshopId?.trim();
    const messageId = request.params.messageId?.trim();
    if (!workshopId || !messageId) {
      response.status(400).json({ error: "workshopId and messageId are required." });
      return;
    }
    const { payload, cacheStatus } = await cachedPublicRead(
      `workshop-message:${workshopId}:${messageId}`,
      () => controlPlane.listWorkshopMessages({ workshopId, messageId, limit: 1 })
    );
    response.set("x-santaclawz-cache", cacheStatus);
    if (payload.totalMessageCount < 1) {
      response.status(404).json({ error: "Workshop message was not found." });
      return;
    }
    response.json(payload);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load workshop message."
    });
  }
}));

app.get("/api/workshops/:workshopId/state", route(async (request, response) => {
  try {
    const workshopId = request.params.workshopId?.trim();
    if (!workshopId) {
      response.status(400).json({ error: "workshopId is required." });
      return;
    }
    const { payload, cacheStatus } = await cachedPublicRead(
      `workshop-state:${workshopId}`,
      () => controlPlane.getWorkshopState({ workshopId })
    );
    response.set("x-santaclawz-cache", cacheStatus);
    response.json(payload);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load workshop state."
    });
  }
}));

app.get("/api/execution/intents", route(async (request, response) => {
  try {
    const rawLimit = queryString(request.query, "limit");
    const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
    response.json(
      await controlPlane.listExecutionIntents({
        ...(queryString(request.query, "sessionId") ? { sessionId: queryString(request.query, "sessionId")! } : {}),
        ...(queryString(request.query, "agentId") ? { agentId: queryString(request.query, "agentId")! } : {}),
        ...(parseExecutionIntentStatus(queryString(request.query, "status"))
          ? { status: parseExecutionIntentStatus(queryString(request.query, "status"))! }
          : {}),
        ...(typeof limit === "number" && Number.isFinite(limit) ? { limit } : {})
      })
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to list execution intents."
    });
  }
}));

app.get("/api/execution/intents/:intentId", route(async (request, response) => {
  try {
    const intentId = request.params.intentId;
    if (!intentId) {
      response.status(400).json({ error: "intentId is required." });
      return;
    }
    response.json(await controlPlane.getExecutionIntentResult(intentId));
  } catch (error) {
    response.status(404).json({
      error: error instanceof Error ? error.message : "Unable to get execution intent."
    });
  }
}));

app.get("/api/execution-intents/:intentId", route(async (request, response) => {
  try {
    const intentId = request.params.intentId;
    if (!intentId) {
      response.status(400).json({ error: "intentId is required." });
      return;
    }
    response.json(await controlPlane.getExecutionIntentResult(intentId));
  } catch (error) {
    response.status(404).json({
      error: error instanceof Error ? error.message : "Unable to get execution intent."
    });
  }
}));

app.get("/api/executions/:requestId", route(async (request, response) => {
  try {
    const requestId = request.params.requestId;
    if (!requestId) {
      response.status(400).json({ error: "requestId is required." });
      return;
    }
    response.json({
      ok: true,
      request: await controlPlane.getHireRequest(requestId)
    });
  } catch (error) {
    response.status(404).json({
      error: error instanceof Error ? error.message : "Unable to get execution request."
    });
  }
}));

app.post("/api/executions/:requestId/reconcile-worker-return", route(async (request, response) => {
  try {
    const requestId = request.params.requestId;
    if (!requestId) {
      response.status(400).json({ error: "requestId is required." });
      return;
    }
    response.json(await controlPlane.reconcileWorkerReturn({
      requestId,
      ...(adminKeyHeader(request) ? { adminKey: adminKeyHeader(request)! } : {}),
      returnPayload: request.body ?? null
    }));
  } catch (error) {
    response.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to reconcile worker return."
    });
  }
}));

app.get("/api/executions/:requestId/collaboration", route(async (request, response) => {
  try {
    const requestId = request.params.requestId;
    if (!requestId) {
      response.status(400).json({ error: "requestId is required." });
      return;
    }
    response.json({
      ok: true,
      collaboration: await controlPlane.getJobCollaboration({
        requestId,
        ...(tokenQuery(request) ? { token: tokenQuery(request)! } : {}),
        ...(adminKeyHeader(request) ? { adminKey: adminKeyHeader(request)! } : {})
      })
    });
  } catch (error) {
    response.status(403).json({
      error: error instanceof Error ? error.message : "Unable to load job collaboration."
    });
  }
}));

app.post("/api/executions/:requestId/messages", route(async (request, response) => {
  try {
    const requestId = request.params.requestId;
    if (!requestId) {
      response.status(400).json({ error: "requestId is required." });
      return;
    }
    const body = parseJobMessageBody(request.body ?? null);
    response.json({
      ok: true,
      collaboration: await controlPlane.postJobMessage({
        requestId,
        ...(tokenQuery(request) ? { token: tokenQuery(request)! } : {}),
        ...(adminKeyHeader(request) ? { adminKey: adminKeyHeader(request)! } : {}),
        ...(typeof body.authorRole === "string" ? { authorRole: body.authorRole as never } : {}),
        body: typeof body.body === "string" ? body.body : "",
        ...(typeof body.stage === "string" ? { stage: body.stage as never } : {}),
        ...(typeof body.artifactDigestSha256 === "string" ? { artifactDigestSha256: body.artifactDigestSha256 } : {})
      })
    });
  } catch (error) {
    response.status(403).json({
      error: error instanceof Error ? error.message : "Unable to post job message."
    });
  }
}));

app.post("/api/executions/:requestId/stages", route(async (request, response) => {
  try {
    const requestId = request.params.requestId;
    if (!requestId) {
      response.status(400).json({ error: "requestId is required." });
      return;
    }
    const body = parseJobStageBody(request.body ?? null);
    response.json({
      ok: true,
      collaboration: await controlPlane.postJobStage({
        requestId,
        ...(tokenQuery(request) ? { token: tokenQuery(request)! } : {}),
        ...(adminKeyHeader(request) ? { adminKey: adminKeyHeader(request)! } : {}),
        ...(typeof body.authorRole === "string" ? { authorRole: body.authorRole as never } : {}),
        stage: typeof body.stage === "string" ? body.stage as never : "in_progress",
        status: typeof body.status === "string" ? body.status as never : "active",
        ...(typeof body.label === "string" ? { label: body.label } : {}),
        ...(typeof body.note === "string" ? { note: body.note } : {}),
        ...(typeof body.artifactDigestSha256 === "string" ? { artifactDigestSha256: body.artifactDigestSha256 } : {})
      })
    });
  } catch (error) {
    response.status(403).json({
      error: error instanceof Error ? error.message : "Unable to post job stage."
    });
  }
}));

app.post("/api/executions/:requestId/late-completion", route(async (request, response) => {
  const requestId = request.params.requestId;
  if (!requestId) {
    response.status(400).json({ ok: false, code: "request_id_required", error: "requestId is required." });
    return;
  }
  const adminKey = adminKeyHeader(request);
  if (!adminKey) {
    response.status(401).json({ ok: false, code: "admin_key_required", error: "x-clawz-admin-key is required." });
    return;
  }
  const body = parseLateHireCompletionBody(request.body ?? null);
  const responseText = lateCompletionResponseText(body);
  if (!responseText.trim()) {
    response.status(400).json({ ok: false, code: "return_body_required", error: "Late completion body is required." });
    return;
  }
  try {
    const hireRequest = await controlPlane.recordLateHireCompletion({
      requestId,
      adminKey,
      ...(boundedNumber(body.statusCode) ? { statusCode: boundedNumber(body.statusCode)! } : {}),
      body: responseText,
      ...(typeof body.relayMessageId === "string" ? { relayMessageId: body.relayMessageId.slice(0, 120) } : {}),
      ...(validSha256(body.requestBodyDigestSha256) ? { requestBodyDigestSha256: validSha256(body.requestBodyDigestSha256)! } : {}),
      ...(boundedNumber(body.workerStatusCode) ? { workerStatusCode: boundedNumber(body.workerStatusCode)! } : {}),
      ...(boundedNumber(body.workerResponseBytes) !== undefined ? { workerResponseBytes: boundedNumber(body.workerResponseBytes)! } : {}),
      ...(validSha256(body.workerResponseDigestSha256) ? { workerResponseDigestSha256: validSha256(body.workerResponseDigestSha256)! } : {}),
      ...(boundedNumber(body.relayBodyBytes) !== undefined ? { relayBodyBytes: boundedNumber(body.relayBodyBytes)! } : {}),
      ...(validSha256(body.relayBodyDigestSha256) ? { relayBodyDigestSha256: validSha256(body.relayBodyDigestSha256)! } : {}),
      ...(typeof body.source === "string" ? { source: body.source.slice(0, 80) } : {})
    });
    response.json({
      ok: true,
      requestId: hireRequest.requestId,
      status: hireRequest.status,
      operationalStatus: hireRequest.operationalStatus,
      protocolReturn: hireRequest.protocolReturn
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to record late completion.";
    const unknownRequest = /unknown execution request/i.test(message);
    response.status(unknownRequest ? 409 : 400).json({
      ok: false,
      code: unknownRequest ? "execution_request_not_persisted_yet" : "late_completion_rejected",
      retryable: unknownRequest,
      error: message
    });
  }
}));

app.get("/api/executions/:requestId/state", route(async (request, response) => {
  try {
    const requestedRequestId = request.params.requestId;
    if (!requestedRequestId) {
      response.status(400).json({ error: "requestId is required." });
      return;
    }
    const token = tokenQuery(request);
    const adminKey = adminKeyHeader(request);
    const recoveryPaymentPayloadDigestSha256 =
      validSha256(queryString(request.query, "paymentPayloadDigestSha256")) ??
      validSha256(queryString(request.query, "paymentPayloadDigest")) ??
      validSha256(queryString(request.query, "payloadDigest"));
    const directHireRequest = await optionalHireRequest(requestedRequestId);
    const hireIdAliasPaymentLedger = directHireRequest
      ? undefined
      : await controlPlane.listPaymentLedger({ hireRequestId: requestedRequestId, limit: 5 });
    const x402IdAliasPaymentLedger =
      directHireRequest || (hireIdAliasPaymentLedger?.entries.length ?? 0) > 0
        ? undefined
        : await controlPlane.listPaymentLedger({ x402RequestId: requestedRequestId, limit: 5 });
    const aliasPaymentLedger =
      hireIdAliasPaymentLedger && hireIdAliasPaymentLedger.entries.length > 0
        ? hireIdAliasPaymentLedger
        : x402IdAliasPaymentLedger ?? hireIdAliasPaymentLedger;
    const aliasHireRequestId = aliasPaymentLedger?.entries.find((entry) => entry.hireRequestId)?.hireRequestId;
    const hireRequest = directHireRequest ?? (aliasHireRequestId ? await optionalHireRequest(aliasHireRequestId) : undefined);
    const apiBase = getBaseUrl(request);
    if (!hireRequest) {
      const latestAliasLedger = aliasPaymentLedger?.entries[0];
      const paymentPayloadDigestSha256 = latestAliasLedger?.paymentPayloadDigestSha256;
      const aliasRetrySafety = paymentPayloadRetrySafety({
        paymentPayloadDigestSha256,
        latestLedger: latestAliasLedger
      });
      const aliasProtocolLifecycle = latestAliasLedger
        ? reduceSantaClawzPaidLifecycle({
            paymentStatus: latestAliasLedger.paymentStatus,
            agentExecutionStatus: latestAliasLedger.executionStatus ?? "not_started",
            sellerExecutionCompleted: latestAliasLedger.returnStatus === "accepted",
            paymentAuthorized:
              latestAliasLedger.paymentStatus === "authorization_verified" ||
              latestAliasLedger.paymentStatus === "payment_verified" ||
              latestAliasLedger.paymentStatus === "settled" ||
              latestAliasLedger.paymentStatus === "already_settled" ||
              latestAliasLedger.paymentStatus === "execution_completed",
            paymentSettled: ledgerHasSettledPayment(latestAliasLedger),
            hasFailure: latestAliasLedger.executionStatus === "failed" || latestAliasLedger.returnStatus === "rejected",
            returnRejected: latestAliasLedger.returnStatus === "rejected",
            safeToRetrySamePayload: aliasRetrySafety.safeToRetrySamePayload,
            paymentPayloadRetryRejected: aliasRetrySafety.payloadRetryRejected,
            platformFailure: true
          })
        : undefined;
      const canonicalStateUrl = aliasHireRequestId
        ? `${apiBase}/api/executions/${encodeURIComponent(aliasHireRequestId)}/state`
        : undefined;
      const paymentStateUrl = paymentPayloadDigestSha256
        ? `${apiBase}/api/x402/payment-state?${new URLSearchParams({ paymentPayloadDigestSha256 }).toString()}`
        : `${apiBase}/api/x402/payment-state?${new URLSearchParams({ requestId: requestedRequestId }).toString()}`;
      response.status(latestAliasLedger ? 409 : 404).json({
        ok: false,
        code: latestAliasLedger ? "execution_state_pending_reconciliation" : "execution_request_unknown",
        retryable: Boolean(latestAliasLedger),
        requestedRequestId,
        ids: {
          requestedRequestId,
          ...(aliasHireRequestId ? { hireRequestId: aliasHireRequestId, executionRequestId: aliasHireRequestId } : {}),
          ...(latestAliasLedger?.x402RequestId ? { x402RequestId: latestAliasLedger.x402RequestId } : {}),
          ...(latestAliasLedger?.ledgerId ? { ledgerId: latestAliasLedger.ledgerId } : {}),
          ...(paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256 } : {})
        },
        ...(canonicalStateUrl ? { canonicalStateUrl, stateUrl: canonicalStateUrl } : {}),
        paymentStateUrl,
        ...(aliasProtocolLifecycle
          ? {
              protocolLifecycle: aliasProtocolLifecycle,
              protocolState: aliasProtocolLifecycle.protocolState,
              buyerAction: aliasProtocolLifecycle.buyerAction,
              sellerOutcome: aliasProtocolLifecycle.sellerOutcome,
              operatorObligation: aliasProtocolLifecycle.operatorObligation,
              ...lifecycleFinalityFields(aliasProtocolLifecycle)
            }
          : {}),
        safeToRetrySamePayload: aliasRetrySafety.safeToRetrySamePayload,
        ...(aliasRetrySafety.payloadRetryRejected
          ? {
              ...(aliasRetrySafety.payloadExpiredForRetry ? { paymentPayloadExpiredForRetry: true } : {}),
              paymentPayloadRetryRejected: true,
              retryMode: "poll_or_reconcile_existing_payment",
              doNotCreateNewPayment: true
            }
          : {}),
        safeToCreateNewPayment: false,
        error: latestAliasLedger
          ? "Payment state exists, but the execution request is not fully persisted yet. Poll paymentStateUrl or canonicalStateUrl before creating a new payment."
          : "Unknown execution request. Check the payment state endpoint with a payment payload digest or x402 request id if this followed a paid submit."
      });
      return;
    }
    const requestId = hireRequest.requestId;
    const [paymentLedger, artifactReceipts] = await Promise.all([
      controlPlane.listPaymentLedger({ hireRequestId: requestId, limit: 5 }),
      artifactStore.receiptsForRequest(requestId)
    ]);
    const latestLedger = paymentLedger.entries[0];
    const paymentPayloadDigestMatches = Boolean(
      recoveryPaymentPayloadDigestSha256 &&
        paymentLedger.entries.some((entry) => entry.paymentPayloadDigestSha256 === recoveryPaymentPayloadDigestSha256)
    );
    const workspaceCredentialProvided = Boolean(token || adminKey);
    const paymentPayloadDigestSha256 = latestLedger?.paymentPayloadDigestSha256;
    const stateUrl = `${apiBase}/api/executions/${encodeURIComponent(requestId)}/state${
      paymentPayloadDigestSha256
        ? `?${new URLSearchParams({ paymentPayloadDigestSha256 }).toString()}`
        : ""
    }`;
    const paymentStateUrl = paymentPayloadDigestSha256
      ? `${apiBase}/api/x402/payment-state?${new URLSearchParams({ paymentPayloadDigestSha256 }).toString()}`
      : `${apiBase}/api/x402/payment-state?${new URLSearchParams({ requestId }).toString()}`;
    const recoveryRetrySafety = paymentPayloadRetrySafety({
      paymentPayloadDigestSha256,
      latestLedger
    });
    if (!workspaceCredentialProvided && !paymentPayloadDigestMatches) {
      response.status(403).json({
        ok: false,
        code: "execution_state_recovery_credential_required",
        retryable: false,
        requestedRequestId,
        ids: {
          requestedRequestId,
          executionRequestId: requestId,
          hireRequestId: requestId
        },
        paymentStateUrl: paymentPayloadDigestSha256 ? undefined : paymentStateUrl,
        stateAccess: {
          modes: ["job_access_token", "seller_admin_key", "payment_payload_digest"],
          acceptedQuery: "paymentPayloadDigestSha256",
          guidance: "Fetch /api/x402/payment-state with the saved payment payload digest, then poll the returned stateEndpoint."
        },
        safeToRetrySamePayload: recoveryRetrySafety.safeToRetrySamePayload,
        ...(recoveryRetrySafety.payloadRetryRejected
          ? {
              ...(recoveryRetrySafety.payloadExpiredForRetry ? { paymentPayloadExpiredForRetry: true } : {}),
              paymentPayloadRetryRejected: true,
              retryMode: "poll_or_reconcile_existing_payment",
              doNotCreateNewPayment: true
            }
          : {}),
        safeToCreateNewPayment: false,
        error: "Execution state requires a job token, seller admin key, or matching payment payload digest."
      });
      return;
    }
    let collaboration: Awaited<ReturnType<ClawzControlPlane["getJobCollaboration"]>> = {
      requestId,
      agentId: hireRequest.agentId,
      sessionId: hireRequest.sessionId,
      currentStage: null,
      stages: [],
      messages: []
    };
    let stateAccessMode: "workspace" | "payment_digest_recovery" = paymentPayloadDigestMatches ? "payment_digest_recovery" : "workspace";
    if (workspaceCredentialProvided) {
      try {
        collaboration = await controlPlane.getJobCollaboration({
          requestId,
          ...(token ? { token } : {}),
          ...(adminKey ? { adminKey } : {})
        });
        stateAccessMode = "workspace";
      } catch (error) {
        if (!paymentPayloadDigestMatches) {
          throw error;
        }
      }
    }
    const latestReceipt = artifactReceipts[0];
    const operational = hireRequest.operationalStatus;
    const proofStatus =
      hireRequest.returnValidationError || latestLedger?.returnStatus === "rejected"
        ? "return_rejected"
        : hireRequest.protocolReturn?.verifiedOutput
          ? hireRequest.protocolReturn.verifiedOutput.zekoAttestationIncluded
            ? "anchored_or_attested"
            : "return_validated"
          : "not_started";
    const verifiedOutput = hireRequest.protocolReturn?.verifiedOutput;
    const artifactDelivered =
      Boolean(verifiedOutput?.artifactManifestUrl) ||
      Boolean(verifiedOutput?.artifactBundleDigestSha256) ||
      artifactReceipts.length > 0;
    const buyerVisibleOutputCount = verifiedOutput?.buyerVisibleOutputs?.length ?? 0;
    const inlineOutputAvailable = buyerVisibleOutputCount > 0;
    const buyerDownloadableArtifactCount = artifactReceipts.length;
    const buyerVisibleInlineOutputCount = buyerVisibleOutputCount;
    const verifiedOutputDeliverableCount = verifiedOutput?.deliverableCount ?? 0;
    const filesProducedCount = verifiedOutput?.filesProducedCount ?? 0;
    const internalPackageOnly = verifiedOutputDeliverableCount > 0 && inlineOutputAvailable && !artifactDelivered;
    const buyerDeliveryAvailable = inlineOutputAvailable || artifactDelivered;
    const buyerDeliveryStatus = inlineOutputAvailable
      ? "inline_available"
      : artifactDelivered
        ? "artifact_available"
        : "missing";
    const buyerVerified = latestReceipt?.digestVerified === true || latestReceipt?.buyerScanStatus === "passed";
    const buyerAccepted =
      latestReceipt?.buyerAcceptanceStatus === "accepted" ||
      (collaboration.currentStage?.stage === "review" && collaboration.currentStage.status === "accepted") ||
      collaboration.currentStage?.stage === "final";
    const ledgerPaymentSettled = ledgerHasSettledPayment(latestLedger);
    const paymentStatus =
      ledgerPaymentSettled ||
      operational?.paymentStatus === "settled" ||
      latestLedger?.paymentStatus === "settled" ||
      latestLedger?.paymentStatus === "already_settled"
        ? "settled"
        : operational?.paymentStatus === "authorized" || latestLedger?.paymentStatus === "authorization_verified"
          ? "authorized"
          : operational?.paymentStatus ?? "not_started";
    const settlementStatus = ledgerPaymentSettled
      ? "settled"
      : latestLedger?.paymentStatus === "settlement_failed"
        ? "failed"
        : operational?.settlementStatus ?? "not_attempted";
    const relayDeliveryStatus = operational?.relayDeliveryStatus ?? "not_attempted";
    const agentExecutionStatus = operational?.agentExecutionStatus ?? hireRequest.status;
    const postAckRelayTimeout = hireRequestHasPostAckRelayTimeout(hireRequest);
    const acceptedPendingResult =
      postAckRelayTimeout &&
      !hireRequest.protocolReturn &&
      !hireRequest.returnValidationError &&
      (
        (relayDeliveryStatus === "acknowledged" &&
          (agentExecutionStatus === "running_or_unknown" || agentExecutionStatus === "worker_completed_return_processing")) ||
        (relayDeliveryStatus === "failed" && agentExecutionStatus === "submitted") ||
        (relayDeliveryStatus === "failed" && hireRequest.status === "submitted")
      );
    const paymentSettled = paymentStatus === "settled";
    const paymentAuthorizedForLifecycle =
      paymentStatus === "authorized" ||
      paymentStatus === "settled" ||
      latestLedger?.paymentStatus === "authorization_verified" ||
      latestLedger?.paymentStatus === "payment_verified" ||
      latestLedger?.paymentStatus === "settled" ||
      latestLedger?.paymentStatus === "already_settled" ||
      latestLedger?.paymentStatus === "execution_completed";
    const relayDelivered =
      relayDeliveryStatus === "forwarded" ||
      relayDeliveryStatus === "recorded" ||
      relayDeliveryStatus === "acknowledged" ||
      relayDeliveryStatus === "reconciled_completed";
    const agentStarted =
      relayDelivered ||
      agentExecutionStatus === "submitted" ||
      agentExecutionStatus === "running_or_unknown" ||
      agentExecutionStatus === "worker_completed_return_processing" ||
      agentExecutionStatus === "quoted" ||
      agentExecutionStatus === "completed" ||
      agentExecutionStatus === "failed" ||
      agentExecutionStatus === "late_completion_available" ||
      agentExecutionStatus === "worker_completed_return_rejected";
    const agentCompleted = agentExecutionStatus === "completed" || agentExecutionStatus === "worker_completed_return_rejected";
    const proofVerified = proofStatus === "return_validated" || proofStatus === "anchored_or_attested";
    const returnVerified = agentCompleted && proofVerified && latestLedger?.returnStatus !== "rejected";
    const buyerComplete = returnVerified && buyerDeliveryAvailable;
    const expiredAuthorizationNoChargeTerminal =
      Boolean(
        latestLedger?.errorCode === "payment_payload_expired_for_retry" &&
        postAckRelayTimeout &&
        !ledgerHasSettledPayment(latestLedger) &&
        latestLedger?.returnStatus !== "accepted"
      );
    const staleDeliveryFailureAfterReturn =
      returnVerified &&
      !hireRequest.returnValidationError &&
      relayDeliveryStatus !== "return_rejected" &&
      agentExecutionStatus !== "worker_completed_return_rejected";
    const staleLedgerErrorAfterReturn =
      staleDeliveryFailureAfterReturn &&
      Boolean(latestLedger?.errorMessage) &&
      latestLedger?.returnStatus !== "rejected";
    const hasFailure =
      (!returnVerified && settlementStatus === "failed") ||
      (!acceptedPendingResult && relayDeliveryStatus === "failed" && !staleDeliveryFailureAfterReturn) ||
      relayDeliveryStatus === "return_rejected" ||
      agentExecutionStatus === "failed" ||
      agentExecutionStatus === "worker_completed_return_rejected" ||
      proofStatus === "return_rejected" ||
      Boolean(
        (!acceptedPendingResult && hireRequest.deliveryError && !staleDeliveryFailureAfterReturn) ||
        hireRequest.returnValidationError ||
        (!acceptedPendingResult && latestLedger?.errorMessage && !staleLedgerErrorAfterReturn)
      );
    const knownBlockers = [
      ...(!acceptedPendingResult && hireRequest.deliveryError && !staleDeliveryFailureAfterReturn ? [hireRequest.deliveryError] : []),
      ...(hireRequest.returnValidationError ? [hireRequest.returnValidationError] : []),
      ...(!acceptedPendingResult && latestLedger?.errorMessage && !staleLedgerErrorAfterReturn ? [latestLedger.errorMessage] : [])
    ];
    const lifecycleNarrative = {
      execution:
        agentCompleted && !hasFailure
          ? "completed"
          : agentStarted
            ? "in_progress"
            : paymentSettled || paymentStatus === "authorized"
              ? "waiting_for_agent"
              : "waiting_for_payment",
      artifactDelivery: artifactDelivered
        ? "delivered_or_receipt_recorded"
        : "not_delivered",
      buyerDelivery: buyerDeliveryAvailable
        ? buyerDeliveryStatus
        : "missing",
      buyerAcceptance: buyerAccepted
        ? "accepted"
        : latestReceipt?.buyerAcceptanceStatus === "rejected"
          ? "rejected"
          : latestReceipt?.buyerAcceptanceStatus === "not_required"
            ? "not_required"
            : "pending",
      summary: buyerAccepted
        ? "Execution completed, artifact delivery is recorded, and buyer accepted the work."
        : buyerVerified
          ? "Execution completed, artifact delivery is recorded, and buyer verification passed; buyer acceptance is still pending."
          : buyerDeliveryAvailable
            ? "Execution completed and buyer delivery is available; buyer verification and acceptance may still be pending."
            : agentCompleted && !hasFailure
              ? "Seller execution completed and proof/return state is recorded; no buyer-readable output or artifact delivery has been recorded yet."
              : acceptedPendingResult
                ? "Execution was acknowledged by the worker and is pending result reconciliation; buyers should poll state or resume with the same payment payload."
              : hasFailure
                ? "Execution has a failure or rejected return that needs attention."
                : "Execution is still in progress."
    };
    const buyerCompletionStatus = buyerComplete
      ? "buyer_complete"
      : expiredAuthorizationNoChargeTerminal
        ? "payment_expired_no_charge"
      : returnVerified && buyerDeliveryAvailable
        ? "buyer_delivery_available"
        : returnVerified
          ? "seller_completed_delivery_pending"
          : acceptedPendingResult
            ? "worker_acknowledged_pending_reconciliation"
            : hasFailure
              ? "failed"
              : "in_progress";
    const platformReconciliationStatus = returnVerified
      ? "seller_return_recorded"
      : expiredAuthorizationNoChargeTerminal
        ? "terminal_payment_expired_no_charge"
      : acceptedPendingResult
        ? "pending_worker_return_or_late_completion"
        : hasFailure
          ? "failed_or_rejected"
          : "pending";
    const executionRetrySafety = paymentPayloadRetrySafety({
      paymentPayloadDigestSha256,
      terminal: buyerAccepted || hasFailure || expiredAuthorizationNoChargeTerminal,
      latestLedger
    });
    const paymentRecoveryBlocked =
      acceptedPendingResult &&
      executionRetrySafety.payloadRetryRejected &&
      !executionRetrySafety.safeToRetrySamePayload;
    const paymentRecoveryMissingBuyerDelivery =
      paymentRecoveryBlocked &&
      !buyerDeliveryAvailable;
    const protocolSellerFailure =
      proofStatus === "return_rejected" ||
      agentExecutionStatus === "failed" ||
      agentExecutionStatus === "worker_completed_return_rejected" ||
      Boolean(hireRequest.returnValidationError);
    const protocolLifecycle = reduceSantaClawzPaidLifecycle({
      paymentStatus: latestLedger?.paymentStatus ?? paymentStatus,
      settlementStatus,
      relayDeliveryStatus,
      agentExecutionStatus,
      proofStatus,
      sellerExecutionCompleted: returnVerified,
      buyerDeliveryAvailable,
      buyerComplete,
      buyerAccepted,
      paymentAuthorized: paymentAuthorizedForLifecycle,
      paymentSettled,
      hasFailure: protocolSellerFailure,
      returnRejected: proofStatus === "return_rejected",
      expiredAuthorizationNoCharge: expiredAuthorizationNoChargeTerminal,
      safeToRetrySamePayload: executionRetrySafety.safeToRetrySamePayload,
      paymentPayloadRetryRejected: executionRetrySafety.payloadRetryRejected,
      platformTimedOutAfterWorkerAck: acceptedPendingResult || postAckRelayTimeout,
      platformFailure: Boolean(
        !acceptedPendingResult &&
          relayDeliveryStatus === "failed" &&
          !returnVerified &&
          proofStatus !== "return_rejected" &&
          agentExecutionStatus !== "failed" &&
          agentExecutionStatus !== "worker_completed_return_rejected"
      )
    });
    const partyFinality = lifecyclePartyFinality({
      lifecycle: protocolLifecycle,
      paymentSettled,
      buyerAccepted
    });
    const stateProjectionUpdatedAtIso = new Date().toISOString();
    const ledgerUpdatedAtIso = latestLedger?.updatedAtIso;
    const sourceFreshnessMs = sourceFreshnessMsFromIso(ledgerUpdatedAtIso, stateProjectionUpdatedAtIso);
    response.json({
      schemaVersion: "santaclawz-execution-state/1.0",
      ok: true,
      generatedAtIso: stateProjectionUpdatedAtIso,
      stateProjectionUpdatedAtIso,
      ...(ledgerUpdatedAtIso ? { ledgerUpdatedAtIso } : {}),
      ...(sourceFreshnessMs !== undefined ? { sourceFreshnessMs } : {}),
      sourceFreshness: {
        stateProjectionUpdatedAtIso,
        ...(ledgerUpdatedAtIso ? { ledgerUpdatedAtIso } : {}),
        ...(sourceFreshnessMs !== undefined ? { sourceFreshnessMs } : {}),
        executionSubmittedAtIso: hireRequest.submittedAtIso,
        paymentStateCanonicalForRetrySafety: true,
        expectedConsistency:
          "execution-state exposes buyer delivery and proof progress; payment-state remains canonical for retry safety during settlement convergence"
      },
      ids: {
        requestedRequestId,
        executionRequestId: requestId,
        hireRequestId: requestId,
        ...(latestLedger?.x402RequestId ? { x402RequestId: latestLedger.x402RequestId } : {}),
        ...(latestLedger?.ledgerId ? { ledgerId: latestLedger.ledgerId } : {}),
        ...(paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256 } : {})
      },
      requestId,
      requestedRequestId,
      stateUrl,
      paymentStateUrl,
      stateAccess: {
        mode: stateAccessMode,
        redacted: stateAccessMode === "payment_digest_recovery",
        credential: stateAccessMode === "payment_digest_recovery" ? "paymentPayloadDigestSha256" : "workspace_token_or_admin_key"
      },
      protocolLifecycle,
      protocolState: protocolLifecycle.protocolState,
      buyerAction: protocolLifecycle.buyerAction,
      sellerOutcome: protocolLifecycle.sellerOutcome,
      operatorObligation: protocolLifecycle.operatorObligation,
      ...lifecycleFinalityFields(protocolLifecycle),
      partyFinality,
      agentId: hireRequest.agentId,
      sessionId: hireRequest.sessionId,
      requestType: hireRequest.requestType,
      pricingMode: hireRequest.pricingMode,
      currentPhase:
        buyerAccepted
          ? "buyer_accepted"
          : buyerVerified
            ? "buyer_verified"
            : artifactDelivered
              ? "artifact_delivered"
              : proofStatus === "return_validated" || proofStatus === "anchored_or_attested"
                ? "return_verified"
                : operational?.agentExecutionStatus === "completed"
                  ? "agent_completed"
                    : operational?.relayDeliveryStatus === "forwarded" ||
                        operational?.relayDeliveryStatus === "recorded" ||
                        operational?.relayDeliveryStatus === "acknowledged" ||
                        operational?.relayDeliveryStatus === "reconciled_completed"
                    ? "relay_delivered"
                    : paymentStatus === "settled"
                      ? "payment_settled"
                      : paymentStatus === "authorized"
                        ? "payment_authorized"
                        : "created",
      lifecycle: {
        paymentStatus,
        settlementStatus,
        relayDeliveryStatus,
        agentExecutionStatus,
        proofStatus,
        sellerExecutionCompleted: returnVerified,
        buyerComplete,
        buyerCompletionStatus,
        platformReconciliationStatus,
        buyerDeliveryStatus,
        buyerDeliveryAvailable,
        buyerVisibleOutputCount,
        buyerVisibleInlineOutputCount,
        buyerDownloadableArtifactCount,
        artifactReceiptCount: artifactReceipts.length,
        verifiedOutputDeliverableCount,
        filesProducedCount,
        internalPackageOnly,
        buyerDeliveryBlocker: paymentRecoveryMissingBuyerDelivery ? "authorized_payment_missing_buyer_delivery" : undefined,
        artifactDeliveryStatus: artifactDelivered ? "delivered" : "not_delivered",
        artifactDeliveryAvailable: artifactDelivered,
        buyerVerificationStatus: buyerVerified ? "verified" : latestReceipt?.buyerScanStatus === "failed" ? "failed" : "not_verified",
        buyerAcceptanceStatus: buyerAccepted ? "accepted" : latestReceipt?.buyerAcceptanceStatus ?? "pending",
        sellerReputationImpact:
          hasFailure && !staleDeliveryFailureAfterReturn
            ? "seller_failure"
            : returnVerified && !buyerDeliveryAvailable
              ? "none_until_delivery_fault_attributed"
              : "none",
        narrative: lifecycleNarrative
      },
      relayTrace: hireRequest.relayTrace ?? [],
      lifecycleNarrative,
      lifecycleChecks: {
        paymentSettled,
        relayDelivered,
        agentStarted,
        agentCompleted,
        proofVerified,
        sellerExecutionCompleted: returnVerified,
        buyerComplete,
        buyerDeliveryAvailable,
        artifactDelivered,
        buyerVerified,
        buyerAccepted,
        failed: hasFailure,
        terminal: protocolLifecycle.terminal || buyerAccepted || hasFailure || expiredAuthorizationNoChargeTerminal,
        protocolTerminal: protocolLifecycle.terminal,
        ...(expiredAuthorizationNoChargeTerminal ? { paymentPathTerminal: true } : {})
      },
      ...(acceptedPendingResult
        ? {
            agentNextAction: expiredAuthorizationNoChargeTerminal
              ? "create_new_payment_or_retry_job"
              : executionRetrySafety.payloadRetryRejected
              ? "poll_state_or_escalate_payment_recovery"
              : "poll_state_or_resume_same_payment",
            retryMode: expiredAuthorizationNoChargeTerminal
              ? "fresh_payment_allowed_after_expired_authorization"
              : executionRetrySafety.payloadRetryRejected
              ? "poll_or_reconcile_existing_payment"
              : "same_payment_payload_only",
            safeToRetrySamePayload: executionRetrySafety.safeToRetrySamePayload,
            safeToRetrySamePaymentPayload: executionRetrySafety.safeToRetrySamePayload,
            safeToCreateNewPayment: expiredAuthorizationNoChargeTerminal,
            doNotCreateNewPayment: !expiredAuthorizationNoChargeTerminal,
            ...(expiredAuthorizationNoChargeTerminal
              ? {
                  terminalReason: "payment_payload_expired_no_charge",
                  refundOrNoChargeStatus: "no_charge_authorization_expired"
                }
              : {}),
            ...(executionRetrySafety.payloadRetryRejected
              ? {
                  ...(executionRetrySafety.payloadExpiredForRetry ? { paymentPayloadExpiredForRetry: true } : {}),
                  paymentPayloadRetryRejected: true,
                  humanOrPlatformInterventionRequired: expiredAuthorizationNoChargeTerminal ? false : true,
                  reason: expiredAuthorizationNoChargeTerminal
                    ? "payment_payload_expired_no_charge"
                    : paymentRecoveryMissingBuyerDelivery
                    ? "authorized_payment_missing_buyer_delivery"
                    : "payment_payload_retry_rejected_non_terminal",
                  reconciliation: {
                    status: expiredAuthorizationNoChargeTerminal
                      ? "terminal_no_charge"
                      : "operator_reconciliation_required",
                    reason: expiredAuthorizationNoChargeTerminal
                      ? "payment_payload_expired_no_charge"
                      : paymentRecoveryMissingBuyerDelivery
                      ? "authorized_payment_missing_buyer_delivery"
                      : "payment_payload_retry_rejected_non_terminal",
                    paymentStateUrl,
                    stateUrl
                  }
                }
              : {}),
            workerAcknowledged: true,
            lateCompletionSupported: true,
            resultMayStillArrive: true,
            lateCompletion: {
              supported: true,
              backupExpected: true,
              lastKnownEndpointHealthy: "unknown"
            }
          }
        : {}),
      privacy: {
        jobVisibility: hireRequest.jobPrivacy?.visibility ?? "public",
        publicAggregateStats: true,
        publicLifecycleEvents: hireRequest.jobPrivacy?.publicLifecycleEvents ?? hireRequest.jobPrivacy?.visibility !== "private",
        publicArtifactMetadata: hireRequest.jobPrivacy?.publicArtifactMetadata ?? hireRequest.jobPrivacy?.visibility !== "private",
        activityAnchorMode: hireRequest.jobPrivacy?.visibility === "private" ? "anonymous" : "public"
      },
      delivery: {
        deliveryTarget: hireRequest.deliveryTarget,
        deliveryStatus: hireRequest.deliveryStatus ?? "not_attempted",
        artifactDelivery: hireRequest.artifactDelivery,
        protocolVerifiedOutput: hireRequest.protocolReturn?.verifiedOutput,
        artifactReceipts,
        ...(latestReceipt ? { latestReceipt } : {})
      },
      payment: {
        requestPaymentStatus: hireRequest.paymentStatus,
        ...(stateAccessMode === "payment_digest_recovery"
          ? {
              ledgerEntryCount: paymentLedger.entries.length,
              ...(latestLedger ? { latestLedger: redactLatestPaymentLedger(latestLedger) } : {})
            }
          : {
              ledgerEntries: paymentLedger.entries,
              ...(latestLedger ? { latestLedger } : {})
            })
      },
      workspace: {
        access: stateAccessMode === "payment_digest_recovery" ? "redacted_payment_digest_recovery" : "workspace",
        currentStage: collaboration.currentStage,
        stageCount: collaboration.stages.length,
        messageCount: collaboration.messages.length,
        stages: stateAccessMode === "payment_digest_recovery" ? [] : collaboration.stages,
        messages: stateAccessMode === "payment_digest_recovery" ? [] : collaboration.messages
      },
      knownBlockers
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load execution state.";
    const unknownRequest = /unknown execution request/i.test(message);
    response.status(unknownRequest ? 404 : 403).json({
      ok: false,
      code: unknownRequest ? "execution_request_unknown" : "execution_state_access_rejected",
      retryable: false,
      error: message
    });
  }
}));

app.get("/api/procurement/intents", route(async (request, response) => {
  try {
    const status = queryString(request.query, "status");
    const limit = queryString(request.query, "limit");
    response.json(await controlPlane.listProcurementIntents({
      ...(status === "open" || status === "awarded" || status === "closed" || status === "cancelled" ? { status } : {}),
      ...(limit ? { limit: Number.parseInt(limit, 10) } : {})
    }));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to list procurement intents."
    });
  }
}));

app.post("/api/workspaces/auth/email-code", route(async (request, response) => {
  try {
    const body = (isRecord(request.body) ? request.body : {}) as HostedWorkspaceEmailCodeBody;
    response.json(await controlPlane.requestHostedWorkspaceEmailCode({
      orgName: optionalString(body.orgName) ?? "",
      workspaceDomain: optionalString(body.workspaceDomain) ?? "",
      email: optionalString(body.email) ?? ""
    }));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to request workspace email code."
    });
  }
}));

app.post("/api/workspaces/auth/email-code/verify", route(async (request, response) => {
  try {
    const body = (isRecord(request.body) ? request.body : {}) as HostedWorkspaceEmailCodeBody;
    response.json(await controlPlane.verifyHostedWorkspaceEmailCode({
      challengeId: optionalString(body.challengeId) ?? "",
      email: optionalString(body.email) ?? "",
      code: optionalString(body.code) ?? ""
    }));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to verify workspace email code."
    });
  }
}));

app.get("/api/workspaces/runs", route(async (request, response) => {
  try {
    const workspaceSessionToken = workspaceSessionTokenHeader(request);
    if (!workspaceSessionToken) {
      response.status(401).json({
        error: "Workspace session token is required.",
        code: "workspace_session_required"
      });
      return;
    }
    const workspaceId = queryString(request.query, "workspaceId");
    const limit = queryString(request.query, "limit");
    response.json(await controlPlane.listHostedWorkspaceRuns({
      workspaceSessionToken,
      ...(workspaceId ? { workspaceId } : {}),
      ...(limit ? { limit: Number.parseInt(limit, 10) } : {})
    }));
  } catch (error) {
    response.status(403).json({
      error: error instanceof Error ? error.message : "Unable to list workspace runs."
    });
  }
}));

app.post("/api/workspaces/runs", route(async (request, response) => {
  try {
    const workspaceSessionToken = workspaceSessionTokenHeader(request);
    if (!workspaceSessionToken) {
      response.status(401).json({
        error: "Workspace session token is required.",
        code: "workspace_session_required"
      });
      return;
    }
    response.json(await controlPlane.upsertHostedWorkspaceRun(parseHostedWorkspaceRunBody(request.body ?? null, workspaceSessionToken)));
  } catch (error) {
    response.status(403).json({
      error: error instanceof Error ? error.message : "Unable to save workspace run."
    });
  }
}));

app.get("/api/workspaces/runs/:runId", route(async (request, response) => {
  try {
    const workspaceSessionToken = workspaceSessionTokenHeader(request);
    if (!workspaceSessionToken) {
      response.status(401).json({
        error: "Workspace session token is required.",
        code: "workspace_session_required"
      });
      return;
    }
    const runId = request.params.runId;
    if (!runId) {
      response.status(400).json({ error: "runId is required." });
      return;
    }
    response.json(await controlPlane.getHostedWorkspaceRun(runId, { workspaceSessionToken }));
  } catch (error) {
    response.status(403).json({
      error: error instanceof Error ? error.message : "Unable to load workspace run."
    });
  }
}));

app.post("/api/buyer-router/plan", route(async (request, response) => {
  try {
    response.json(await controlPlane.createBuyerRouterPlan(parseBuyerRouterPlanBody(request.body ?? null)));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to create buyer route plan."
    });
  }
}));

app.post("/api/procurement/intents", route(async (request, response) => {
  try {
    response.json(await controlPlane.createProcurementIntent(parseProcurementIntentBody(request.body ?? null, idempotencyKeyHeader(request))));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to create procurement intent."
    });
  }
}));

app.get("/api/procurement/intents/:intentId", route(async (request, response) => {
  try {
    const intentId = request.params.intentId;
    if (!intentId) {
      response.status(400).json({ error: "intentId is required." });
      return;
    }
    response.json(await controlPlane.getProcurementIntent(intentId, {
      ...(tokenQuery(request) ? { token: tokenQuery(request)! } : {})
    }));
  } catch (error) {
    response.status(404).json({
      error: error instanceof Error ? error.message : "Unable to load procurement intent."
    });
  }
}));

app.post("/api/procurement/intents/:intentId/bids", route(async (request, response) => {
  try {
    const intentId = request.params.intentId;
    const body = (isRecord(request.body) ? request.body : {}) as ProcurementBidBody;
    if (!intentId) {
      response.status(400).json({ error: "intentId is required." });
      return;
    }
    response.json(await controlPlane.submitProcurementBid({
      intentId,
      agentId: typeof body.agentId === "string" ? body.agentId : "",
      ...(idempotencyKeyHeader(request) ? { idempotencyKey: idempotencyKeyHeader(request)! } : typeof body.idempotencyKey === "string" ? { idempotencyKey: body.idempotencyKey } : {}),
      amountUsd: typeof body.amountUsd === "string" ? body.amountUsd : "",
      summary: typeof body.summary === "string" ? body.summary : "",
      ...(adminKeyHeader(request) ? { adminKey: adminKeyHeader(request)! } : {}),
      ...(typeof body.estimatedDeliveryIso === "string" ? { estimatedDeliveryIso: body.estimatedDeliveryIso } : {}),
      deliveryModes: stringArray(body.deliveryModes),
      privacyModes: stringArray(body.privacyModes)
    }));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to submit procurement bid."
    });
  }
}));

app.post("/api/procurement/intents/:intentId/decline", route(async (request, response) => {
  try {
    const intentId = request.params.intentId;
    const body = (isRecord(request.body) ? request.body : {}) as ProcurementDeclineBody;
    if (!intentId) {
      response.status(400).json({ error: "intentId is required." });
      return;
    }
    response.json(await controlPlane.declineProcurementIntent({
      intentId,
      agentId: typeof body.agentId === "string" ? body.agentId : "",
      ...(idempotencyKeyHeader(request) ? { idempotencyKey: idempotencyKeyHeader(request)! } : typeof body.idempotencyKey === "string" ? { idempotencyKey: body.idempotencyKey } : {}),
      ...(adminKeyHeader(request) ? { adminKey: adminKeyHeader(request)! } : {}),
      ...(typeof body.reason === "string" ? { reason: body.reason } : {})
    }));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to decline procurement intent."
    });
  }
}));

app.post("/api/procurement/intents/:intentId/accept", route(async (request, response) => {
  try {
    const intentId = request.params.intentId;
    const body = (isRecord(request.body) ? request.body : {}) as ProcurementAcceptBody;
    if (!intentId) {
      response.status(400).json({ error: "intentId is required." });
      return;
    }
    response.json(await controlPlane.acceptProcurementBid({
      intentId,
      bidId: typeof body.bidId === "string" ? body.bidId : "",
      ...(typeof body.token === "string" ? { token: body.token } : tokenQuery(request) ? { token: tokenQuery(request)! } : {})
    }));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to accept procurement bid."
    });
  }
}));

appWithRouteMiddleware.post(
  "/api/executions/:requestId/artifacts",
  expressRaw({
    type: "application/octet-stream",
    limit: process.env.CLAWZ_ARTIFACT_MAX_BYTES?.trim() || "25mb"
  }),
  route(async (request, response) => {
    const requestId = request.params.requestId;
    if (!requestId) {
      response.status(400).json({ error: "requestId is required." });
      return;
    }
    if (!(request.body instanceof Uint8Array)) {
      response.status(415).json({ error: "Upload artifacts as application/octet-stream." });
      return;
    }

    const hireRequest = await controlPlane.assertHireArtifactUploadAccess(requestId, adminKeyHeader(request));
    const artifactBody = Buffer.from(request.body);
    const filename = queryString(request.query, "filename") ?? optionalString(request.header("x-clawz-artifact-filename"));
    const contentType =
      queryString(request.query, "contentType") ??
      optionalString(request.header("x-clawz-artifact-content-type")) ??
      optionalString(request.header("content-type"));
    const deliveryMode =
      queryString(request.query, "deliveryMode") ??
      queryString(request.query, "privacyMode") ??
      optionalString(request.header("x-clawz-artifact-delivery-mode")) ??
      hireRequest.artifactDelivery?.mode;
    let artifact;
    try {
      artifact = await artifactStore.create({
        requestId: hireRequest.requestId,
        ...(filename ? { filename } : {}),
        ...(contentType ? { contentType } : {}),
        ...(deliveryMode ? { deliveryMode: deliveryMode === "buyer_encrypted" ? "buyer_encrypted" : "platform_scanned" } : {}),
        body: artifactBody,
        baseUrl: requestBaseUrl(request)
      });
    } catch (error) {
      if (error instanceof ArtifactSafetyError) {
        response.status(400).json({
          ok: false,
          code: "artifact_safety_blocked",
          safetyCode: error.report.code ?? "blocked_by_static_policy",
          safetyCodes: error.report.codes ?? (error.report.code ? [error.report.code] : ["blocked_by_static_policy"]),
          retryable: false,
          safety: error.report,
          buyerMessage: error.report.buyerMessage,
          sellerMessage: error.report.sellerMessage
        });
        return;
      }
      if (error instanceof ArtifactScanUnavailableError) {
        response.status(503).json({
          ok: false,
          code: "artifact_scan_unavailable_retryable",
          retryable: true,
          safety: error.report,
          buyerMessage: error.report.buyerMessage,
          sellerMessage: error.report.sellerMessage
        });
        return;
      }
      throw error;
    }

    response.json({
      ok: true,
      artifact,
      buyerMessage: artifact.safety.buyerMessage,
      sellerMessage: artifact.safety.sellerMessage,
      verifiedOutputPatch: {
        artifact_manifest_url: artifact.artifactManifestUrl,
        artifact_bundle_digest_sha256: artifact.artifactBundleDigestSha256
      }
    });
  })
);

app.post("/api/executions/:requestId/artifact-receipts", route(async (request, response) => {
  const requestId = request.params.requestId;
  if (!requestId) {
    response.status(400).json({ error: "requestId is required." });
    return;
  }
  const hireRequest = await controlPlane.assertHireArtifactUploadAccess(requestId, adminKeyHeader(request));
  const body = parseArtifactReceiptBody(request.body ?? null);
  const deliveryMode =
    body.deliveryMode === "external_reference" ? "external_reference" :
    body.deliveryMode === "direct_receipt" ? "direct_receipt" :
    undefined;
  if (!deliveryMode) {
    response.status(400).json({ error: "deliveryMode must be direct_receipt or external_reference." });
    return;
  }
  const transport =
    body.transport === "buyer_agent_inbox" || body.transport === "external_url" || body.transport === "out_of_band" || body.transport === "custom"
      ? body.transport
      : undefined;
  const scanPolicy =
    body.scanPolicy === "buyer_required" ||
    body.scanPolicy === "external_unverified" ||
    body.scanPolicy === "external_verified" ||
    body.scanPolicy === "none"
      ? body.scanPolicy
      : undefined;
  const filename = typeof body.filename === "string" ? body.filename : "";
  const artifactDigestSha256 = typeof body.artifactDigestSha256 === "string" ? body.artifactDigestSha256 : "";
  const artifactSizeBytes =
    typeof body.artifactSizeBytes === "number"
      ? body.artifactSizeBytes
      : typeof body.artifactSizeBytes === "string"
        ? Number.parseInt(body.artifactSizeBytes, 10)
        : 0;
  const receipt = await artifactStore.createReceipt({
    requestId: hireRequest.requestId,
    deliveryMode,
    ...(transport ? { transport } : {}),
    ...(scanPolicy ? { scanPolicy } : {}),
    ...(typeof body.buyerAcceptanceRequired === "boolean" ? { buyerAcceptanceRequired: body.buyerAcceptanceRequired } : {}),
    filename,
    ...(typeof body.contentType === "string" ? { contentType: body.contentType } : {}),
    artifactDigestSha256,
    artifactSizeBytes,
    ...(typeof body.artifactUrl === "string" ? { artifactUrl: body.artifactUrl } : {}),
    ...(typeof body.deliveryChannel === "string" ? { deliveryChannel: body.deliveryChannel } : {}),
    ...(typeof body.sellerDeliveryReceipt === "string" ? { sellerDeliveryReceipt: body.sellerDeliveryReceipt } : {}),
    ...(typeof body.sellerSignature === "string" ? { sellerSignature: body.sellerSignature } : {}),
    ...(typeof body.deliveredAtIso === "string" ? { deliveredAtIso: body.deliveredAtIso } : {}),
    baseUrl: requestBaseUrl(request)
  });
  response.json({
    ok: true,
    ...receipt,
    buyerMessage:
      deliveryMode === "external_reference"
        ? "SantaClawz recorded an external artifact reference. Verify the digest after download; platform scan status depends on the receipt scan policy."
        : "SantaClawz recorded bilateral delivery metadata. Verify the digest and acknowledge only after the buyer receives the bytes.",
    sellerMessage: "Artifact delivery receipt recorded. SantaClawz has not hosted these bytes on the platform lane."
  });
}));

app.get("/api/artifacts/:artifactId/manifest", route(async (request, response) => {
  const artifactId = request.params.artifactId;
  const token = tokenQuery(request);
  if (!artifactId || !token) {
    response.status(400).json({ error: "artifactId and token are required." });
    return;
  }
  let artifact;
  try {
    artifact = await artifactStore.manifest(artifactId, token);
  } catch (error) {
    response.status(/expired/i.test(errorMessage(error, "")) ? 410 : 404).json(artifactAccessFailurePayload(artifactId, error));
    return;
  }
  response
    .set("cache-control", "private, max-age=30")
    .set("x-santaclawz-artifact-digest-sha256", artifact.digestSha256)
    .set("x-santaclawz-artifact-bytes", String(artifact.plaintextBytes))
    .json({
      ok: true,
      artifact,
      artifactState: artifact.artifactState,
      recommendedPollAfterMs: artifact.transport?.recommendedPollAfterMs ?? 2000
    });
}));

app.get("/api/artifacts/:artifactId/status", route(async (request, response) => {
  const artifactId = request.params.artifactId;
  const token = tokenQuery(request);
  if (!artifactId || !token) {
    response.status(400).json({ error: "artifactId and token are required." });
    return;
  }
  let artifact;
  try {
    artifact = await artifactStore.manifest(artifactId, token);
  } catch (error) {
    response.status(/expired/i.test(errorMessage(error, "")) ? 410 : 404).json(artifactAccessFailurePayload(artifactId, error));
    return;
  }
  response.json({
    ok: true,
    artifactId,
    requestId: artifact.requestId,
    artifactState: artifact.artifactState,
    transport: artifact.transport,
    scanStatus: artifact.safety.status,
    expectedDigestSha256: artifact.digestSha256,
    expectedBytes: artifact.plaintextBytes,
    recommendedPollAfterMs: artifact.transport?.recommendedPollAfterMs ?? 2000
  });
}));

const artifactDownloadHandler = route(async (request, response) => {
  const artifactId = request.params.artifactId;
  const token = tokenQuery(request);
  if (!artifactId || !token) {
    response.status(400).json({ error: "artifactId and token are required." });
    return;
  }

  let manifest;
  try {
    manifest = await artifactStore.manifest(artifactId, token);
  } catch (error) {
    response.status(/expired/i.test(errorMessage(error, "")) ? 410 : 404).json(artifactAccessFailurePayload(artifactId, error));
    return;
  }
  if (manifest.safety.status === "buyer_scan_required" && !queryFlag(request, "acceptRisk")) {
    response.status(409).json({
      ok: false,
      code: "buyer_scan_required",
      retryable: false,
      artifact: manifest,
      artifactState: manifest.artifactState,
      expectedDigestSha256: manifest.digestSha256,
      expectedBytes: manifest.plaintextBytes,
      buyerMessage:
        "This artifact was delivered in private encrypted mode. Add acceptRisk=true only after the buyer agrees to decrypt and scan locally before opening."
    });
    return;
  }

  const artifactRead = await withColdReadBudget((async () => {
    return {
      kind: "artifact" as const,
      artifact: await artifactStore.read(artifactId, token)
    };
  })(), ARTIFACT_DOWNLOAD_READ_BUDGET_MS, "artifact_download_read_timeout").catch((error) => ({
    kind: "temporarily_unavailable" as const,
    error
  }));

  if (artifactRead.kind === "temporarily_unavailable") {
    response.status(503).json({
      ok: false,
      code: "artifact_download_temporarily_unavailable",
      retryable: true,
      artifactId,
      stateFreshness: "unavailable",
      deliveryProjectionPending: true,
      artifactState: {
        ...manifest.artifactState,
        downloadStatus: "temporarily_unavailable",
        downloadAvailable: false,
        downloadRetryable: true,
        recommendedPollAfterMs: 2000
      },
      expectedDigestSha256: manifest.digestSha256,
      expectedBytes: manifest.plaintextBytes,
      recommendedPollAfterMs: 2000,
      buyerMessage:
        "SantaClawz could not prepare this artifact download within the protocol read budget. Retry the same artifact URL; do not request or pay for duplicate work.",
      error: errorMessage(artifactRead.error, "Artifact download read exceeded the protocol read budget.")
    });
    return;
  }

  const artifact = artifactRead.artifact;
  const range = parseArtifactRangeHeader(optionalString(request.header("range")), artifact.body.length);
  if (range === null) {
    response
      .status(416)
      .set("accept-ranges", "bytes")
      .set("content-range", `bytes */${artifact.body.length}`)
      .json({
        ok: false,
        code: "artifact_range_not_satisfiable",
        retryable: false,
        artifactId,
        expectedDigestSha256: artifact.metadata.digestSha256,
        expectedBytes: artifact.body.length
      });
    return;
  }
  const body = range ? artifact.body.subarray(range.start, range.end + 1) : artifact.body;
  const statusCode = range ? 206 : 200;
  response
    .status(statusCode)
    .set("content-type", artifact.metadata.contentType)
    .set("content-disposition", contentDispositionAttachment(artifact.metadata.filename))
    .set("content-length", String(body.length))
    .set("accept-ranges", "bytes")
    .set("digest", artifactDigestHeader(artifact.metadata.digestSha256))
    .set("x-santaclawz-artifact-digest-sha256", artifact.metadata.digestSha256)
    .set("x-santaclawz-artifact-bytes", String(artifact.metadata.plaintextBytes));
  if (range) {
    response.set("content-range", `bytes ${range.start}-${range.end}/${artifact.body.length}`);
  }
  response.send(request.method === "HEAD" ? undefined : body);
});

app.get("/api/artifacts/:artifactId/download", artifactDownloadHandler);
appWithRouteMiddleware.head("/api/artifacts/:artifactId/download", artifactDownloadHandler);

app.get("/api/artifact-receipts/:receiptId", route(async (request, response) => {
  const receiptId = request.params.receiptId;
  const token = tokenQuery(request);
  if (!receiptId || !token) {
    response.status(400).json({ error: "receiptId and token are required." });
    return;
  }
  response.json({
    ok: true,
    receipt: await artifactStore.receipt(receiptId, token)
  });
}));

app.post("/api/artifact-receipts/:receiptId/acknowledge", route(async (request, response) => {
  const receiptId = request.params.receiptId;
  const token = tokenQuery(request);
  if (!receiptId || !token) {
    response.status(400).json({ error: "receiptId and token are required." });
    return;
  }
  const body = parseArtifactReceiptAcknowledgementBody(request.body ?? null);
  if (typeof body.accepted !== "boolean") {
    response.status(400).json({ error: "accepted must be true or false." });
    return;
  }
  const buyerScanStatus =
    body.buyerScanStatus === "not_scanned" ||
    body.buyerScanStatus === "passed" ||
    body.buyerScanStatus === "failed" ||
    body.buyerScanStatus === "not_required"
      ? body.buyerScanStatus
      : undefined;
  response.json({
    ok: true,
    receipt: await artifactStore.acknowledgeReceipt(receiptId, token, {
      accepted: body.accepted,
      ...(typeof body.note === "string" ? { note: body.note } : {}),
      ...(typeof body.bytesReceivedByBuyer === "boolean" ? { bytesReceivedByBuyer: body.bytesReceivedByBuyer } : {}),
      ...(typeof body.digestVerified === "boolean" ? { digestVerified: body.digestVerified } : {}),
      ...(buyerScanStatus ? { buyerScanStatus } : {})
    })
  });
}));

app.post("/api/execution/intents", route(async (request, response) => {
  try {
    response.json(await controlPlane.createExecutionIntent(parseExecutionIntentCreateRequest(request.body ?? null)));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to create execution intent."
    });
  }
}));

app.post("/api/execution/intents/:intentId/approve", route(async (request, response) => {
  try {
    const intentId = request.params.intentId;
    if (!intentId) {
      response.status(400).json({ error: "intentId is required." });
      return;
    }
    response.json(
      await controlPlane.approveExecutionIntent({
        intentId,
        ...parseExecutionIntentTransitionRequest(request.body ?? null)
      })
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to approve execution intent."
    });
  }
}));

app.post("/api/execution/intents/:intentId/execute", route(async (request, response) => {
  try {
    const intentId = request.params.intentId;
    if (!intentId) {
      response.status(400).json({ error: "intentId is required." });
      return;
    }
    response.json(
      await controlPlane.executeExecutionIntent({
        intentId,
        ...parseExecutionIntentTransitionRequest(request.body ?? null)
      })
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to mark execution intent executed."
    });
  }
}));

app.post("/api/execution/intents/:intentId/settle", route(async (request, response) => {
  try {
    const intentId = request.params.intentId;
    if (!intentId) {
      response.status(400).json({ error: "intentId is required." });
      return;
    }
    response.json(
      await controlPlane.settleExecutionIntent({
        intentId,
        ...parseExecutionIntentTransitionRequest(request.body ?? null)
      })
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to settle execution intent."
    });
  }
}));

app.post("/api/execution/intents/:intentId/refund", route(async (request, response) => {
  try {
    const intentId = request.params.intentId;
    if (!intentId) {
      response.status(400).json({ error: "intentId is required." });
      return;
    }
    response.json(
      await controlPlane.refundExecutionIntent({
        intentId,
        ...parseExecutionIntentTransitionRequest(request.body ?? null)
      })
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to refund execution intent."
    });
  }
}));

app.post("/api/agents/:agentId/quotes/:requestId/accept", route(async (request, response) => {
  try {
    const agentId = request.params.agentId;
    const requestId = request.params.requestId;
    if (!agentId || !requestId) {
      response.status(400).json({ error: "agentId and requestId are required." });
      return;
    }
    const body = parseQuoteAcceptRequest(request.body ?? null);
    enforceQuoteAcceptRateLimit(request, {
      agentId,
      ...(body.buyerAgentId ? { buyerAgentId: body.buyerAgentId } : {}),
      ...(body.buyerWallet ? { buyerWallet: body.buyerWallet } : {})
    });
    const intent = await controlPlane.acceptQuoteForPayment({
      agentId,
      requestId,
      ...body
    });
    const context = await buildQuoteIntentRuntime(getBaseUrl(request), intent.intentId);
    if (!context.runtime) {
      const refundedIntent = await controlPlane.refundExecutionIntent({
        intentId: intent.intentId,
        evidenceDigestSha256: intent.stableIntentDigestSha256,
        note: "Quote acceptance rejected because the selected rail could not emit a live x402 challenge."
      });
      response.status(400).json({
        error: "Selected quote payment rail cannot emit a live x402 challenge yet.",
        intent: refundedIntent
      });
      return;
    }
    setHeaders(response, buildAgentX402Headers({ paymentRequired: context.runtime.paymentRequired }));
    response.status(402).json({
      ok: true,
      intent,
      paymentRequirement: context.runtime.paymentRequired
    });
  } catch (error) {
    const retryAfterSeconds =
      error instanceof Error && "retryAfterSeconds" in error
        ? (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds
        : undefined;
    if (retryAfterSeconds) {
      response.set("retry-after", String(retryAfterSeconds));
      response.status(429).json({
        error: error instanceof Error ? error.message : "Too many quote acceptance attempts."
      });
      return;
    }
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to accept quote."
    });
  }
}));

app.post("/api/agents/:agentId/messages", route(async (request, response) => {
  try {
    const agentId = request.params.agentId;
    if (!agentId) {
      response.status(400).json({ error: "agentId is required." });
      return;
    }

    const body = isRecord(request.body) ? request.body : {};
    const result = await controlPlane.postAgentBoardMessage({
      agentId,
      ...(adminKeyHeader(request) ? { adminKey: adminKeyHeader(request)! } : {}),
      ...(workshopTokenHeader(request) ? { workshopToken: workshopTokenHeader(request)! } : {}),
      ...(typeof body.messageType === "string" ? { messageType: body.messageType as AgentBoardMessageType } : {}),
      ...(typeof body.body === "string" ? { body: body.body } : { body: "" }),
      ...(Array.isArray(body.topicTags) ? { topicTags: body.topicTags.filter((value): value is string => typeof value === "string") } : {}),
      ...(Array.isArray(body.capabilityTags)
        ? { capabilityTags: body.capabilityTags.filter((value): value is string => typeof value === "string") }
        : {}),
      ...(typeof body.threadId === "string" ? { threadId: body.threadId } : {}),
      ...(typeof body.parentMessageId === "string" ? { parentMessageId: body.parentMessageId } : {}),
      ...(typeof body.proofIntent === "string"
        ? { proofIntent: body.proofIntent as "per_message" | "aggregate" | "agent_chatter" | "display_only" }
        : {}),
      ...(typeof body.swarmId === "string" ? { swarmId: body.swarmId } : {}),
      ...(typeof body.outputDigestSha256 === "string" ? { outputDigestSha256: body.outputDigestSha256 } : {}),
      ...(typeof body.clientMessageId === "string" ? { clientMessageId: body.clientMessageId } : {}),
      ...(typeof body.txHash === "string" ? { txHash: body.txHash } : {}),
      ...(typeof body.batchTxHash === "string" ? { txHash: body.batchTxHash } : {})
    });
    if (result.workshopTrace) {
      response.json({
        ...result,
        workshopTrace: {
          ...result.workshopTrace,
          readUrls: buildWorkshopTraceReadUrls(
            requestBaseUrl(request),
            result.postedMessage,
            result.workshopTrace.workshopId
          )
        }
      });
      return;
    }
    response.json(result);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to post public agent message."
    });
  }
}));

app.get("/api/agents/:agentId/availability", route(async (request, response) => {
  try {
    const agentId = request.params.agentId;
    if (!agentId) {
      response.status(400).json({ error: "agentId is required." });
      return;
    }

    const { payload, cacheStatus } = await cachedPublicRead(
      `agent-availability:${agentId}`,
      () => controlPlane.getAgentRuntimeLeaseAvailability({ agentId })
    );
    response.set("x-santaclawz-cache", cacheStatus);
    response.json(payload);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to check agent availability."
    });
  }
}));

app.post("/api/agents/:agentId/heartbeat", route(async (request, response) => {
  try {
    const agentId = request.params.agentId;
    if (!agentId) {
      response.status(400).json({ error: "agentId is required." });
      return;
    }

    const body = parseAgentHeartbeatRequest(request.body ?? null);
    const status = parseAgentRuntimeStatus(body.status);
    const ttlSeconds =
      typeof body.ttlSeconds === "number"
        ? body.ttlSeconds
        : typeof body.ttlSeconds === "string"
          ? Number.parseInt(body.ttlSeconds, 10)
          : undefined;
    response.json(
      await controlPlane.recordAgentRuntimeHeartbeat({
        agentId,
        ...(typeof body.sessionId === "string" && body.sessionId.trim().length > 0
          ? { sessionId: body.sessionId.trim() }
          : {}),
        ...(status ? { status } : {}),
        ...(typeof ttlSeconds === "number" && Number.isFinite(ttlSeconds) ? { ttlSeconds } : {}),
        ...(typeof body.note === "string" && body.note.trim().length > 0 ? { note: body.note.trim() } : {}),
        ...(typeof body.relayAgentProtocolVersion === "string" && body.relayAgentProtocolVersion.trim().length > 0
          ? { relayAgentProtocolVersion: body.relayAgentProtocolVersion.trim() }
          : {}),
        ...(typeof body.relayAgentBuild === "string" && body.relayAgentBuild.trim().length > 0
          ? { relayAgentBuild: body.relayAgentBuild.trim() }
          : {}),
        ...(Array.isArray(body.relayAgentFeatures)
          ? { relayAgentFeatures: body.relayAgentFeatures.filter((value): value is string => typeof value === "string") }
          : {}),
        ...(body.relayAgentWorkerRoutes && typeof body.relayAgentWorkerRoutes === "object" && !Array.isArray(body.relayAgentWorkerRoutes)
          ? { relayAgentWorkerRoutes: body.relayAgentWorkerRoutes as Record<string, string> }
          : {}),
        ...(Array.isArray(body.relayAgentWorkerWarnings)
          ? { relayAgentWorkerWarnings: body.relayAgentWorkerWarnings.filter((value): value is string => typeof value === "string") }
          : {}),
        ...(body.relayAgentWorkerTiming && typeof body.relayAgentWorkerTiming === "object" && !Array.isArray(body.relayAgentWorkerTiming)
          ? { relayAgentWorkerTiming: body.relayAgentWorkerTiming as Record<string, unknown> }
          : {}),
        ...(body.paidExecutionProbe && typeof body.paidExecutionProbe === "object" && !Array.isArray(body.paidExecutionProbe)
          ? { paidExecutionProbe: body.paidExecutionProbe as Record<string, unknown> }
          : {}),
        ...(adminKeyHeader(request) ? { adminKey: adminKeyHeader(request)! } : {})
      })
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to record agent heartbeat."
    });
  }
}));

app.post("/api/mission-auth/check", route(async (request, response) => {
  try {
    const parsed = parseMissionAuthOverlayRequest(request.body);
    const sessionId = optionalString(parsed.sessionId) ?? queryString(request.query, "sessionId");
    const agentId = optionalString(parsed.agentId) ?? queryString(request.query, "agentId");
    const adminKey = adminKeyHeader(request);
    const missionAuthOverlay = parseMissionAuthOverlay(parsed.missionAuthOverlay);

    if (sessionId || agentId) {
      response.json(
        await controlPlane.verifyMissionAuthOverlay({
          ...(sessionId ? { sessionId } : {}),
          ...(agentId ? { agentId } : {}),
          ...(missionAuthOverlay ? { missionAuthOverlay } : {}),
          ...(adminKey ? { adminKey } : {})
        })
      );
      return;
    }

    response.json({
      missionAuthOverlay: await controlPlane.checkMissionAuthOverlay(missionAuthOverlay)
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to verify the mission auth overlay."
    });
  }
}));

app.get("/api/x402/plan", route(async (request, response) => {
  try {
    const sessionId = queryString(request.query, "sessionId") ?? "";
    const agentId = queryString(request.query, "agentId") ?? "";
    const apiBase = getBaseUrl(request);
    const cacheKey = `x402-plan:${apiBase}:session:${sessionId}:agent:${agentId}`;
    const planRead = await withColdReadBudget(
      cachedPublicRead(cacheKey, async () => (await buildX402PlanFromQuery(request)).plan, "critical"),
      X402_PLAN_COLD_READ_BUDGET_MS,
      "x402_plan_cold_read_timeout"
    ).catch((error) => ({ error }));
    if ("error" in planRead) {
      response.set("x-santaclawz-cache", "temporarily_unavailable");
      response.status(503).json(x402PlanTemporarilyUnavailable({
        apiBase,
        cacheKey,
        ...(agentId ? { agentId } : {}),
        ...(sessionId ? { sessionId } : {}),
        error: planRead.error
      }));
      return;
    }
    const cacheStatus = planRead.cacheStatus;
    const basePlan = decorateX402PlanResponse(planRead.payload, cacheStatus);
    const plan = await attachBuyerPaymentSafetyToPlan({
      apiBase,
      query: request.query,
      plan: basePlan as X402PlanResponse
    });
    response.set("x-santaclawz-cache", cacheStatus);
    response.json(plan);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to build x402 plan."
    });
  }
}));

app.get("/api/agents/:agentId/x402-plan", route(async (request, response) => {
  try {
    const agentId = request.params.agentId;
    if (!agentId) {
      response.status(400).json({ error: "agentId is required." });
      return;
    }

    const apiBase = getBaseUrl(request);
    const cacheKey = `agent-x402-plan:${apiBase}:${agentId}`;
    const planRead = await withColdReadBudget(
      cachedPublicRead(cacheKey, async () => (await buildX402PlanFromOptions(apiBase, { agentId })).plan, "critical"),
      X402_PLAN_COLD_READ_BUDGET_MS,
      "x402_plan_cold_read_timeout"
    ).catch((error) => ({ error }));
    if ("error" in planRead) {
      response.set("x-santaclawz-cache", "temporarily_unavailable");
      response.status(503).json(x402PlanTemporarilyUnavailable({
        apiBase,
        cacheKey,
        agentId,
        error: planRead.error
      }));
      return;
    }
    const cacheStatus = planRead.cacheStatus;
    const basePlan = decorateX402PlanResponse(planRead.payload, cacheStatus);
    const plan = await attachBuyerPaymentSafetyToPlan({
      apiBase,
      query: request.query,
      plan: basePlan as X402PlanResponse
    });
    response.set("x-santaclawz-cache", cacheStatus);
    response.json(plan);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to build agent x402 plan."
    });
  }
}));

app.post("/api/agents/:agentId/readiness/refresh", route(async (request, response) => {
  const body = isRecord(request.body) ? request.body : {};
  try {
    const agentId = request.params.agentId;
    if (!agentId) {
      response.status(400).json({ error: "agentId is required." });
      return;
    }
    response.json(
      await controlPlane.refreshSellerReadiness({
        agentId,
        ...(optionalString(body.sessionId) ? { sessionId: optionalString(body.sessionId)! } : {}),
        ...(typeof body.publish === "boolean" ? { publish: body.publish } : {}),
        ...(typeof body.localOnly === "boolean" ? { localOnly: body.localOnly } : {}),
        ...(typeof body.verifyAvailability === "boolean" ? { verifyAvailability: body.verifyAvailability } : {}),
        ...(typeof body.operatorNote === "string" ? { operatorNote: body.operatorNote } : {}),
        ...(adminKeyHeader(request) ? { adminKey: adminKeyHeader(request)! } : {})
      })
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to refresh seller readiness."
    });
  }
}));

app.get("/api/agents/:agentId/payments", route(async (request, response) => {
  try {
    const agentId = request.params.agentId;
    if (!agentId) {
      response.status(400).json({ error: "agentId is required." });
      return;
    }
    response.json(await controlPlane.listPaymentLedger({
      ...paymentLedgerListOptionsFromQuery(request.query),
      agentId
    }));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to list agent payments."
    });
  }
}));

app.get("/api/x402/payment-state", route(async (request, response) => {
  try {
    const ledgerId = queryString(request.query, "ledgerId");
    const intentId = queryString(request.query, "intentId") ?? queryString(request.query, "quoteIntentId");
    const requestId = queryString(request.query, "requestId") ?? queryString(request.query, "hireRequestId");
    const paymentPayloadDigestSha256 =
      queryString(request.query, "paymentPayloadDigestSha256") ??
      queryString(request.query, "paymentPayloadDigest") ??
      queryString(request.query, "payloadDigest");
    if (!ledgerId && !intentId && !requestId && !paymentPayloadDigestSha256) {
      response.status(400).json({
        error: "Provide ledgerId, intentId, requestId, or paymentPayloadDigestSha256."
      });
      return;
    }
    const lookup = {
      ...(ledgerId ? { ledgerId } : {}),
      ...(intentId ? { intentId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256 } : {})
    };
    const cacheKey = [
      "x402-payment-state",
      ledgerId ? `ledger:${ledgerId}` : "",
      intentId ? `intent:${intentId}` : "",
      requestId ? `request:${requestId}` : "",
      paymentPayloadDigestSha256 ? `digest:${paymentPayloadDigestSha256}` : ""
    ].join("|");
    const { payload, cacheStatus, statusCode } = await cachedX402PaymentState({
      cacheKey,
      lookup,
      producer: () => buildX402PaymentStateResponse({
      apiBase: getBaseUrl(request),
      ...(ledgerId ? { ledgerId } : {}),
      ...(intentId ? { intentId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256 } : {})
      })
    });
    response.set("x-santaclawz-cache", cacheStatus);
    const publicPayload =
      isRecord(payload) && payload.ok === false
        ? payload
        : isPlatformApiKeyAuthorized(request)
          ? payload
          : redactX402PaymentStateResponse(payload as X402PaymentStateResponse);
    response.status(statusCode ?? 200).json(publicPayload);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load x402 payment state."
    });
  }
}));

app.get("/api/payments", route(async (request, response) => {
  try {
    const options = paymentLedgerListOptionsFromQuery(request.query);
    const cacheKey = [
      "payments",
      options.agentId ? `agent:${options.agentId}` : "",
      options.sessionId ? `session:${options.sessionId}` : "",
      options.quoteIntentId ? `intent:${options.quoteIntentId}` : "",
      options.hireRequestId ? `hire:${options.hireRequestId}` : "",
      options.paymentPayloadDigestSha256 ? `digest:${options.paymentPayloadDigestSha256}` : "",
      `limit:${options.limit ?? 100}`
    ].join("|");
    const { payload, cacheStatus } = await cachedHotRead({
      cacheKey,
      cacheEpoch: paymentLedgerCacheEpoch,
      cache: paymentLedgerCache,
      inflight: paymentLedgerInflight,
      ttlMs: PAYMENT_LEDGER_CACHE_TTL_MS,
      producer: () => controlPlane.listPaymentLedger(options),
      currentCacheEpoch: () => paymentLedgerCacheEpoch,
      prune: prunePaymentLedgerCache
    });
    response.set("x-santaclawz-cache", cacheStatus);
    response.json(payload);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to list payments."
    });
  }
}));

app.get("/api/sessions/:sessionId/payments", route(async (request, response) => {
  try {
    const sessionId = request.params.sessionId;
    if (!sessionId) {
      response.status(400).json({ error: "sessionId is required." });
      return;
    }
    const limit = queryString(request.query, "limit");
    response.json(await controlPlane.listPaymentLedger({
      sessionId,
      ...(limit ? { limit: Number.parseInt(limit, 10) } : {})
    }));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to list session payments."
    });
  }
}));

app.get("/api/payments/:ledgerId", route(async (request, response) => {
  try {
    const ledgerId = request.params.ledgerId;
    if (!ledgerId) {
      response.status(400).json({ error: "ledgerId is required." });
      return;
    }
    const entry = await controlPlane.getPaymentLedgerEntry(ledgerId);
    if (!entry) {
      response.status(404).json({ error: "Payment ledger entry not found." });
      return;
    }
    response.json(entry);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load payment ledger entry."
    });
  }
}));

app.get("/api/admin/artifacts/scanner-health", route(async (_request, response) => {
  const health = await artifactStore.scannerHealth();
  response.status(health.reachable ? 200 : 503).json({
    ok: health.reachable,
    code: health.reachable ? "artifact_scanner_reachable" : "artifact_scanner_unavailable",
    retryable: !health.reachable,
    ...health
  });
}));

app.get("/api/artifacts/scanner-readiness", route(async (_request, response) => {
  const health = await artifactStore.scannerHealth();
  response.status(health.reachable ? 200 : 503).json({
    schemaVersion: "santaclawz-artifact-scanner-readiness/1.0",
    ok: health.reachable,
    code: health.reachable ? "artifact_scanner_reachable" : "artifact_scanner_unavailable",
    retryable: !health.reachable,
    scannerReady: health.reachable,
    scanner: health.scanner,
    target: health.target,
    configured: health.configured,
    checkedAtIso: new Date().toISOString(),
    durationMs: health.durationMs,
    ...(health.error ? { reason: health.error } : {})
  });
}));

app.get("/api/admin/x402/ledger", route(async (request, response) => {
  try {
    response.json(await controlPlane.listPaymentLedger(paymentLedgerListOptionsFromQuery(request.query)));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to list x402 payment ledger."
    });
  }
}));

const handleX402Reconciliation = route(async (request, response) => {
  const agentId = queryString(request.query, "agentId");
  const commit =
    queryString(request.query, "commit") === "true" ||
    (isRecord(request.body) && request.body.commit === true);
  const sponsoredBudgetMode =
    queryString(request.query, "sponsoredBudget") === "true" ||
    (isRecord(request.body) && request.body.sponsoredBudget === true);
  const payoutRollupMode =
    queryString(request.query, "payoutRollup") === "true" ||
    (isRecord(request.body) && request.body.payoutRollup === true);
  const requestedLookbackBlocks =
    Number.parseInt(queryString(request.query, "lookbackBlocks") ?? "", 10) ||
    (isRecord(request.body) && typeof request.body.lookbackBlocks === "number" ? request.body.lookbackBlocks : undefined) ||
    100_000;
  const lookbackBlocks = Math.min(requestedLookbackBlocks, MAX_EVM_RECONCILIATION_LOOKBACK_BLOCKS);
  const initialLedger = await controlPlane.listPaymentLedger({
    ...(agentId ? { agentId } : {}),
    limit: 500
  });
  const settledTxHashes = new Set<string>();
  for (const entry of initialLedger.entries) {
    for (const hash of entry.transactionHashes) {
      settledTxHashes.add(hash.toLowerCase());
    }
  }
  const relayerAddress =
    process.env.CLAWZ_X402_BASE_RELAYER_ADDRESS?.trim() ??
    process.env.CLAWZ_BASE_RELAYER_ADDRESS?.trim() ??
    "";
  const basescanApiKey = process.env.CLAWZ_BASESCAN_API_KEY?.trim() ?? process.env.BASESCAN_API_KEY?.trim() ?? "";
  const backfilledHashes: string[] = [];
  let relayerTransactions: Record<string, unknown>[] = [];
  if (relayerAddress && basescanApiKey) {
    relayerTransactions = await fetchBaseRelayerTransactions({
      address: relayerAddress,
      apiKey: basescanApiKey,
      ...(process.env.CLAWZ_BASESCAN_API_URL ? { apiUrl: process.env.CLAWZ_BASESCAN_API_URL } : {})
    });
    for (const tx of relayerTransactions) {
      const hash = tx.hash;
      if (!isEvmTransactionHash(hash) || settledTxHashes.has(hash.toLowerCase())) {
        continue;
      }
      backfilledHashes.push(hash);
      settledTxHashes.add(hash.toLowerCase());
      await controlPlane.recordPaymentLedgerSettlement({
        agentId: "unmatched-base-relayer",
        sessionId: "unmatched-base-relayer",
        pricingMode: "fixed-exact",
        rail: "base-usdc",
        networkId: "eip155:8453",
        assetSymbol: "USDC",
        amountUsd: "0",
        authorizationId: hash,
        settlementReference: hash,
        transactionHashes: [hash],
        paymentStatus: "unmatched_relayer_transaction",
        facilitatorResponseSummary: {
          source: "basescan-account-txlist",
          hash,
          ...(typeof tx.blockNumber === "string" ? { blockNumber: tx.blockNumber } : {}),
          ...(typeof tx.timeStamp === "string" ? { timeStamp: tx.timeStamp } : {}),
          ...(typeof tx.nonce === "string" ? { nonce: tx.nonce } : {}),
          ...(typeof tx.from === "string" ? { from: tx.from } : {}),
          ...(typeof tx.to === "string" ? { to: tx.to } : {}),
          ...(typeof tx.value === "string" ? { value: tx.value } : {}),
          ...(typeof tx.gasUsed === "string" ? { gasUsed: tx.gasUsed } : {}),
          ...(typeof tx.isError === "string" ? { isError: tx.isError } : {})
        }
      });
    }
  }
  const ledger = await controlPlane.listPaymentLedger({
    ...(agentId ? { agentId } : {}),
    limit: 500
  });
  const orphanEntries = [];
  const incompleteEntries = [];
  for (const entry of ledger.entries) {
    if (!entry.hireRequestId && entry.transactionHashes.length > 0) {
      orphanEntries.push(entry);
    }
    if (
      entry.transactionHashes.length > 0 &&
      entry.executionStatus !== "completed" &&
      entry.paymentStatus !== "execution_completed"
    ) {
      incompleteEntries.push(entry);
    }
  }
  const sponsoredBudgetReconciliation = sponsoredBudgetMode
    ? await reconcileSponsoredBudgetSettlementFailures({
        entries: ledger.entries,
        commit,
        lookbackBlocks,
        matchBeforeMs: 5 * 60 * 1000,
        matchAfterMs: 10 * 60 * 1000
      })
    : undefined;
  const basePayoutRollupReconciliation =
    payoutRollupMode && relayerTransactions.length > 0
      ? await reconcileBaseSellerPayoutRollup({
          transactions: relayerTransactions,
          commit
        })
      : undefined;
  response.json({
    ok: true,
    mode: relayerAddress && basescanApiKey ? "basescan-backfill" : "ledger-local-summary",
    note: relayerAddress && basescanApiKey
      ? "BaseScan relayer transactions were compared against the SantaClawz payment ledger and unmatched hashes were backfilled."
      : "Set CLAWZ_X402_BASE_RELAYER_ADDRESS and CLAWZ_BASESCAN_API_KEY to backfill relayer transactions from BaseScan.",
    relayerAddress: relayerAddress || null,
    backfilledTransactionHashCount: backfilledHashes.length,
    backfilledTransactionHashes: backfilledHashes.slice(0, 50),
    trackedTransactionHashCount: settledTxHashes.size,
    ...(agentId ? { agentId } : {}),
    commit,
    totalLedgerEntryCount: ledger.totalLedgerEntryCount,
    orphanSettlementCount: orphanEntries.length,
    paidButIncompleteCount: incompleteEntries.length,
    ...(sponsoredBudgetReconciliation ? { sponsoredBudgetReconciliation } : {}),
    ...(basePayoutRollupReconciliation ? { basePayoutRollupReconciliation } : {}),
    orphanSettlements: orphanEntries.slice(0, 50),
    paidButIncomplete: incompleteEntries.slice(0, 50)
  });
});

app.post("/api/admin/x402/reconcile", handleX402Reconciliation);
app.post("/api/admin/x402/reconciliation", handleX402Reconciliation);

app.post("/api/x402/quote-intent", route(async (request, response) => {
  try {
    const intentId = queryString(request.query, "intentId");
    if (!intentId) {
      response.status(400).json({ error: "intentId is required." });
      return;
    }

    const context = await buildQuoteIntentRuntime(getBaseUrl(request), intentId);
    if (!context.runtime) {
      response.status(402).json({
        error: "No live exact x402 rail is configured for this accepted quote.",
        intent: context.intent
      });
      return;
    }
    if (!paidExecutionProvenFromReadiness(context.consoleState.readiness)) {
      response.status(409).json(paidExecutionProbeRequiredBody({ intent: context.intent }));
      return;
    }

    const paymentHeaderValue = request.header("payment-signature");
    const paymentPayload = parseAgentX402PaymentPayload({
      ...(paymentHeaderValue ? { headerValue: paymentHeaderValue } : {}),
      body: request.body ?? null
    });

    if (!paymentPayload) {
      setHeaders(response, buildAgentX402Headers({ paymentRequired: context.runtime.paymentRequired }));
      response.status(402).json(context.runtime.paymentRequired);
      return;
    }

    let verification: Awaited<ReturnType<typeof verifyAgentX402Payment>>;
    try {
      verification = await verifyAgentX402Payment({
        runtime: context.runtime,
        paymentPayload
      });
    } catch (error) {
      response.status(400).json(paymentSettlementFailureBody(error, { intent: context.intent }));
      return;
    }
    if (!verification.ok) {
      response.status(402).json(paymentSettlementFailureBody(new Error(verification.error ?? "x402 authorization was not valid."), {
        intent: context.intent,
        paymentAuthorized: false,
        ...(verification.errorCode ? { errorCode: verification.errorCode } : {}),
        ...(verification.remoteVerification ? { facilitatorDiagnostics: verification.remoteVerification } : {})
      }));
      return;
    }
    setHeaders(response, verification.headers);
    const paymentPayloadDigestSha256 = jsonDigestSha256(paymentPayload);
    const authorizationLedgerEntry = await recordX402PaymentLedgerAuthorization({
      agentId: context.intent.agentId,
      sessionId: context.intent.sessionId,
      pricingMode: context.intent.pricingMode,
      railPlan: verification.rail,
      verification,
      paymentPayload,
      authorizationId: intentId,
      quoteIntentId: intentId,
      amountUsd: context.intent.grossAmountUsd,
      ...(context.intent.sellerNetAmountUsd ? { sellerNetAmountUsd: context.intent.sellerNetAmountUsd } : {}),
      ...(context.intent.protocolFeeAmountUsd ? { protocolFeeAmountUsd: context.intent.protocolFeeAmountUsd } : {}),
      ...(context.intent.protocolFeeRecipient ? { protocolFeeRecipient: context.intent.protocolFeeRecipient } : {}),
      ...(typeof context.consoleState.protocolOwnerFeePolicy.feeBps === "number"
        ? { protocolFeeBps: context.consoleState.protocolOwnerFeePolicy.feeBps }
        : {})
    });
    const approvedIntent =
      context.intent.status === "pending"
        ? await controlPlane.approveExecutionIntent({
            intentId,
            reference: `x402:quote-intent-authorized:${authorizationLedgerEntry.ledgerId}`,
            evidenceDigestSha256: paymentPayloadDigestSha256,
            note: "Accepted quote x402 payment authorization verified. Settlement is deferred until valid completion."
          })
        : context.intent.status === "approved" || context.intent.status === "executed" || context.intent.status === "settled"
          ? context.intent
          : undefined;

    if (!approvedIntent) {
      response.status(400).json({
        error: `Cannot settle quote intent ${intentId} from ${context.intent.status}.`,
        intent: context.intent
      });
      return;
    }

    if (approvedIntent.status === "executed" || approvedIntent.status === "settled") {
      response.json({
        ...(await controlPlane.getExecutionIntentResult(intentId)),
        idempotent: true,
        nextAction: "result_lookup",
        ...(approvedIntent.status === "settled" ? { terminal: true } : {}),
        payment: {
          status: approvedIntent.status === "settled" ? "settled" : "authorized",
          ledgerId: authorizationLedgerEntry.ledgerId,
          transactionHashes: authorizationLedgerEntry.transactionHashes
        }
      });
      return;
    }

    let paidExecution: Awaited<ReturnType<typeof controlPlane.submitHireRequest>>;
    try {
      paidExecution = await controlPlane.submitHireRequest({
        agentId: context.intent.agentId,
        taskPrompt: context.quoteRequest.taskPrompt,
        requesterContact: context.quoteRequest.requesterContact,
        ...(context.quoteRequest.budgetMina ? { budgetMina: context.quoteRequest.budgetMina } : {}),
        ...(context.quoteRequest.marketplaceTags ? { marketplaceTags: context.quoteRequest.marketplaceTags } : {}),
        ...(context.quoteRequest.jobContext ? { jobContext: context.quoteRequest.jobContext } : {}),
        ...(context.quoteRequest.jobPrivacy ? { jobPrivacy: context.quoteRequest.jobPrivacy } : {}),
        ...(context.quoteRequest.artifactDelivery ? { artifactDelivery: context.quoteRequest.artifactDelivery } : {}),
        paymentAuthorization: {
          status: "authorized",
          rail: verification.rail.rail,
          amountUsd: context.intent.grossAmountUsd,
          authorizationId: intentId,
          quoteRequestId: context.quoteRequest.requestId,
          ...(context.quoteRequest.protocolReturn?.digestSha256
            ? { acceptedQuoteDigestSha256: context.quoteRequest.protocolReturn.digestSha256 }
            : {}),
          ledgerId: authorizationLedgerEntry.ledgerId,
          paymentPayloadDigestSha256,
          paymentAuthorizationDigestSha256: paymentPayloadDigestSha256
        }
      });
    } catch (error) {
      response.status(400).json(relayDeliveryFailureBody(error, {
        intent: approvedIntent,
        payment: {
          status: "authorized",
          ledgerId: authorizationLedgerEntry.ledgerId,
          transactionHashes: []
        }
      }));
      return;
    }
    let settlement: Awaited<ReturnType<typeof settleAgentX402Payment>> | undefined;
    let settlementLedgerEntry = authorizationLedgerEntry;
    let paymentResponseDigestSha256: string | undefined;
    if (paidExecution.protocolReturn?.status === "completed") {
      try {
        settlement = await settleAgentX402Payment({
          runtime: context.runtime,
          paymentPayload
        });
        paymentResponseDigestSha256 = jsonDigestSha256(settlement.paymentResponse);
        settlementLedgerEntry = await recordX402PaymentLedgerSettlement({
          agentId: context.intent.agentId,
          sessionId: context.intent.sessionId,
          pricingMode: context.intent.pricingMode,
          railPlan: settlement.rail,
          settlement,
          paymentPayload,
          authorizationId: intentId,
          quoteIntentId: intentId,
          amountUsd: context.intent.grossAmountUsd,
          ...(context.intent.sellerNetAmountUsd ? { sellerNetAmountUsd: context.intent.sellerNetAmountUsd } : {}),
          ...(context.intent.protocolFeeAmountUsd ? { protocolFeeAmountUsd: context.intent.protocolFeeAmountUsd } : {}),
          ...(context.intent.protocolFeeRecipient ? { protocolFeeRecipient: context.intent.protocolFeeRecipient } : {}),
          ...(typeof context.consoleState.protocolOwnerFeePolicy.feeBps === "number"
            ? { protocolFeeBps: context.consoleState.protocolOwnerFeePolicy.feeBps }
            : {})
        });
        await controlPlane.markHireRequestPaymentSettled({
          requestId: paidExecution.requestId,
          ...(settlementLedgerEntry.settlementReference ? { settlementReference: settlementLedgerEntry.settlementReference } : {}),
          ...(settlementLedgerEntry.sellerSettlementTxHash ? { sellerSettlementTxHash: settlementLedgerEntry.sellerSettlementTxHash } : {}),
          ...(settlementLedgerEntry.protocolFeeTxHash ? { protocolFeeTxHash: settlementLedgerEntry.protocolFeeTxHash } : {}),
          transactionHashes: settlementLedgerEntry.transactionHashes,
          paymentResponseDigestSha256
        });
      } catch (error) {
        await controlPlane.recordPaymentLedgerSettlementFailure({
          ledgerId: authorizationLedgerEntry.ledgerId,
          errorMessage: errorMessage(error, "Unable to settle x402 payment."),
          settlementRetryable: isRetryableSettlementError(error)
        });
        response.status(202).json(paymentSettlementFailureBody(error, {
          intent: approvedIntent,
          paidExecution,
          paymentAuthorized: true,
          paymentSettled: false,
          payment: {
            status: "authorized",
            ledgerId: authorizationLedgerEntry.ledgerId,
            transactionHashes: []
          }
        }));
        return;
      }
    }
    const executedIntent =
      paidExecution.protocolReturn?.status === "completed" || paidExecution.protocolReturn?.status === "failed"
        ? await controlPlane.executeExecutionIntent({
            intentId,
            reference: paidExecution.requestId,
            ...(paidExecution.protocolReturn.digestSha256 ? { evidenceDigestSha256: paidExecution.protocolReturn.digestSha256 } : {}),
            note: paidExecution.protocolReturn.status === "completed"
              ? "Paid execution returned a completion package."
              : "Paid execution returned a failure package."
          })
        : approvedIntent;
    const finalIntent =
      paidExecution.protocolReturn?.status === "completed" && settlement && paymentResponseDigestSha256
        ? await controlPlane.settleExecutionIntent({
            intentId,
            reference: settlement.settlementEvents.settlementReference ?? paidExecution.requestId,
            evidenceDigestSha256: paymentResponseDigestSha256,
            note: "x402 quote payment settled after valid paid execution completion."
          })
        : executedIntent;

    const responsePaidExecution = settlement
      ? {
          ...paidExecution,
          paymentStatus: "settled",
          operationalStatus: paidExecution.operationalStatus
            ? {
                ...paidExecution.operationalStatus,
                paymentStatus: "settled",
                settlementStatus: "settled"
              }
            : paidExecution.operationalStatus,
          payment: {
            ...paidExecution.payment,
            status: "settled",
            ledgerId: settlementLedgerEntry.ledgerId,
            ...(settlementLedgerEntry.settlementReference ? { settlementReference: settlementLedgerEntry.settlementReference } : {}),
            ...(settlementLedgerEntry.sellerSettlementTxHash ? { sellerSettlementTxHash: settlementLedgerEntry.sellerSettlementTxHash } : {}),
            ...(settlementLedgerEntry.protocolFeeTxHash ? { protocolFeeTxHash: settlementLedgerEntry.protocolFeeTxHash } : {}),
            transactionHashes: settlementLedgerEntry.transactionHashes
      }
        }
      : paidExecution;
    const acceptedPendingResult =
      responsePaidExecution.deliveryReceipt?.errorCode === "relay_return_timeout_after_worker_ack" &&
      (
        (responsePaidExecution.operationalStatus?.relayDeliveryStatus === "acknowledged" &&
          (
            responsePaidExecution.operationalStatus?.agentExecutionStatus === "running_or_unknown" ||
            responsePaidExecution.operationalStatus?.agentExecutionStatus === "worker_completed_return_processing"
          )) ||
        (responsePaidExecution.operationalStatus?.relayDeliveryStatus === "failed" &&
          responsePaidExecution.operationalStatus?.agentExecutionStatus === "submitted") ||
        (responsePaidExecution.operationalStatus?.relayDeliveryStatus === "failed" &&
          responsePaidExecution.status === "submitted")
      );
    const responseStatus =
      acceptedPendingResult ||
      (responsePaidExecution.operationalStatus?.relayDeliveryStatus === "failed" && responsePaidExecution.status === "submitted") ||
      responsePaidExecution.operationalStatus?.relayDeliveryStatus === "return_rejected"
        ? 202
        : 200;
    const stateUrl =
      `${getBaseUrl(request)}/api/executions/${encodeURIComponent(responsePaidExecution.requestId)}/state` +
      (responsePaidExecution.jobWorkspace?.token ? `?token=${encodeURIComponent(responsePaidExecution.jobWorkspace.token)}` : "");
    const paymentStateUrl =
      `${getBaseUrl(request)}/api/x402/payment-state?paymentPayloadDigestSha256=${encodeURIComponent(paymentPayloadDigestSha256)}`;
    if (responsePaidExecution.requestType !== "paid_execution") {
      response.status(409).json({
        ok: false,
        code: "quote_paid_execution_routing_failed",
        retryable: false,
        error:
          "Accepted quote payment did not produce a paid_execution request. Retry using /api/x402/quote-intent with the accepted quote intent id.",
        intent: finalIntent,
        paidExecution: responsePaidExecution,
        operationalStatus: {
          paymentStatus: responsePaidExecution.paymentStatus,
          settlementStatus: responsePaidExecution.operationalStatus?.settlementStatus ?? "unknown",
          relayDeliveryStatus: responsePaidExecution.operationalStatus?.relayDeliveryStatus ?? "not_confirmed",
          agentExecutionStatus: responsePaidExecution.operationalStatus?.agentExecutionStatus ?? "not_confirmed"
        }
      });
      return;
    }
    response.status(responseStatus).json({
      ok: true,
      idempotent: context.intent.status !== "pending",
      nextAction: acceptedPendingResult
        ? "poll_state_or_resume_same_payment"
        : finalIntent.status === "settled" || finalIntent.status === "executed"
          ? "result_lookup"
          : "poll_execution",
      intent: finalIntent,
      requestId: responsePaidExecution.requestId,
      requestType: responsePaidExecution.requestType,
      paymentStatus: responsePaidExecution.paymentStatus,
      settlementStatus: responsePaidExecution.operationalStatus?.settlementStatus ?? (settlement ? "settled" : "authorized"),
      relayDeliveryStatus: responsePaidExecution.operationalStatus?.relayDeliveryStatus ?? "not_confirmed",
      agentExecutionStatus: responsePaidExecution.operationalStatus?.agentExecutionStatus ?? "not_confirmed",
      paymentPayloadDigestSha256,
      stateUrl,
      paymentStateUrl,
      ...(acceptedPendingResult
        ? {
            code: "job_running_or_return_timeout",
            errorCode: responsePaidExecution.deliveryReceipt?.errorCode ?? "relay_return_timeout_after_worker_ack",
            retryMode: "same_payment_payload_only",
            safeToRetrySamePayload: true,
            safeToRetrySamePaymentPayload: true,
            safeToCreateNewPayment: false,
            doNotCreateNewPayment: true,
            workerAcknowledged: true,
            workerCompletedReturnProcessing:
              responsePaidExecution.operationalStatus?.agentExecutionStatus === "worker_completed_return_processing",
            lateCompletionSupported: true,
            lateCompletionEndpointHealthy: "unknown",
            resultMayStillArrive: true
          }
        : {}),
      payment: {
        ...(settlement?.paymentResponse ?? {}),
        status: settlement ? "settled" : "authorized",
        ledgerId: settlementLedgerEntry.ledgerId,
        ...(settlementLedgerEntry.sellerSettlementTxHash
          ? { sellerSettlementTxHash: settlementLedgerEntry.sellerSettlementTxHash }
          : {}),
        ...(settlementLedgerEntry.protocolFeeTxHash
          ? { protocolFeeTxHash: settlementLedgerEntry.protocolFeeTxHash }
          : {}),
        transactionHashes: settlementLedgerEntry.transactionHashes
      },
      paidExecution: responsePaidExecution
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to settle quote intent x402 payment."
    });
  }
}));

app.get("/api/x402/proof", route(async (request, response) => {
  try {
    const snapshot = await buildInteropSnapshot(request);
    const plan = await buildAgentX402PlanWithNetworkQuotes({
      baseUrl: snapshot.baseUrl,
      consoleState: snapshot.consoleState
    });
    const runtime = buildAgentX402RuntimeContext({
      baseUrl: snapshot.baseUrl,
      plan,
      serviceNetworkId: snapshot.consoleState.deployment.networkId
    });

    if (!runtime) {
      response.status(402).json(buildAgentX402PaymentRequiredPreview({
        serviceNetworkId: snapshot.consoleState.deployment.networkId,
        plan
      }));
      return;
    }
    if (!(await ensureAgentOnlineForPayment(response, snapshot.consoleState))) {
      return;
    }

    const paymentHeaderValue = request.header("payment-signature");
    const paymentPayload = parseAgentX402PaymentPayload({
      ...(paymentHeaderValue ? { headerValue: paymentHeaderValue } : {}),
      body: request.body ?? null
    });

    if (!paymentPayload) {
      setHeaders(
        response,
        buildAgentX402Headers({
          paymentRequired: runtime.paymentRequired
        })
      );
      response.status(402).json(runtime.paymentRequired);
      return;
    }

    const settlement = await settleAgentX402Payment({
      runtime,
      paymentPayload
    });
    const paymentLedgerEntry = await recordX402PaymentLedgerSettlement({
      agentId: plan.agentId,
      sessionId: plan.sessionId,
      pricingMode: snapshot.consoleState.profile.paymentProfile.pricingMode,
      railPlan: settlement.rail,
      settlement,
      paymentPayload,
      ...(settlement.settlementEvents.settlementReference
        ? { authorizationId: settlement.settlementEvents.settlementReference }
        : {}),
      ...(settlement.rail.amountUsd ? { amountUsd: settlement.rail.amountUsd } : {}),
      ...(snapshot.consoleState.protocolOwnerFeePolicy.enabled
        ? { protocolFeeBps: snapshot.consoleState.protocolOwnerFeePolicy.feeBps }
        : {})
    });
    setHeaders(response, settlement.headers);
    response.json({
      ok: true,
      paid: true,
      payment: {
        ...settlement.paymentResponse,
        ledgerId: paymentLedgerEntry.ledgerId,
        transactionHashes: paymentLedgerEntry.transactionHashes
      },
      bundle: buildAgentProofBundle({
        baseUrl: snapshot.baseUrl,
        consoleState: snapshot.consoleState,
        sessionView: snapshot.sessionView,
        events: snapshot.events,
        sessionId: snapshot.sessionId,
        ...(snapshot.turnId ? { turnId: snapshot.turnId } : {})
      })
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to build x402 payment resource."
    });
  }
}));

app.post("/api/x402/verify", route(async (_request, response) => {
  try {
    const { consoleState, plan } = await buildX402PlanFromQuery(_request);
    const runtime = buildAgentX402RuntimeContext({
      baseUrl: getBaseUrl(_request),
      plan,
      serviceNetworkId: consoleState.deployment.networkId
    });
    if (!runtime) {
      response.status(501).json({
        ok: false,
        previewOnly: true,
        error: "No live exact-price x402 rail is configured for this agent yet."
      });
      return;
    }
    if (!(await ensureAgentOnlineForPayment(response, consoleState))) {
      return;
    }

    const paymentHeaderValue = _request.header("payment-signature");
    const paymentPayload = parseAgentX402PaymentPayload({
      ...(paymentHeaderValue ? { headerValue: paymentHeaderValue } : {}),
      body: _request.body ?? null
    });
    if (!paymentPayload) {
      response.status(400).json({ error: "PAYMENT-SIGNATURE header or paymentPayload body is required." });
      return;
    }

    const verification = await verifyAgentX402Payment({
      runtime,
      paymentPayload
    });
    setHeaders(response, verification.headers);
    response.status(verification.ok ? 200 : 402).json(verification);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to verify x402 payment."
    });
  }
}));

app.post("/api/x402/settlement-retry", route(async (request, response) => {
  try {
    const body = isRecord(request.body) ? request.body : {};
    const ledgerId = queryString(request.query, "ledgerId") ?? optionalString(body.ledgerId);
    const requestId =
      queryString(request.query, "requestId") ??
      queryString(request.query, "hireRequestId") ??
      optionalString(body.requestId) ??
      optionalString(body.hireRequestId);
    const paymentPayloadDigestSha256 =
      validSha256(queryString(request.query, "paymentPayloadDigestSha256")) ??
      validSha256(queryString(request.query, "paymentPayloadDigest")) ??
      validSha256(queryString(request.query, "payloadDigest")) ??
      validSha256(optionalString(body.paymentPayloadDigestSha256)) ??
      validSha256(optionalString(body.paymentPayloadDigest));
    const paymentHeaderValue = request.header("payment-signature");
    const paymentPayload = parseAgentX402PaymentPayload({
      ...(paymentHeaderValue ? { headerValue: paymentHeaderValue } : {}),
      body: request.body ?? null
    });
    const ledgerEntry =
      ledgerId
        ? await controlPlane.getPaymentLedgerEntry(ledgerId)
        : (await controlPlane.listPaymentLedger({
            ...(requestId ? { hireRequestId: requestId } : {}),
            ...(paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256 } : {}),
            limit: 1
          })).entries[0];
    if (!ledgerEntry) {
      response.status(404).json({
        ok: false,
        code: "settlement_retry_ledger_not_found",
        error: "No x402 ledger entry matched this settlement retry request."
      });
      return;
    }
    const stateLookup = {
      ledgerId: ledgerEntry.ledgerId,
      ...(ledgerEntry.paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256: ledgerEntry.paymentPayloadDigestSha256 } : {})
    };
    if (!paymentPayload) {
      response.status(400).json({
        ok: false,
        code: "payment_payload_required_for_settlement_retry",
        error: "Settlement retry requires the original signed x402 payment payload. Do not create a new payment.",
        requiresOriginalPaymentPayload: true,
        doNotCreateNewPayment: true,
        ...(ledgerEntry.paymentPayloadDigestSha256
          ? { expectedPaymentPayloadDigestSha256: ledgerEntry.paymentPayloadDigestSha256 }
          : {})
      });
      return;
    }
    const completedHire = ledgerEntry.hireRequestId
      ? await optionalHireRequest(ledgerEntry.hireRequestId)
      : undefined;
    const canonicalLedgerEntry = projectPaymentLedgerEntryFromCanonicalExecution(ledgerEntry, completedHire) ?? ledgerEntry;
    const sellerReturnAccepted = paymentLedgerEntryHasAcceptedBuyerDelivery(canonicalLedgerEntry, completedHire);
    if (!sellerReturnAccepted || !canonicalLedgerEntry.hireRequestId) {
      response.status(409).json({
        ok: false,
        code: "settlement_retry_requires_accepted_delivery",
        error: "Settlement retry is only allowed after the seller return is accepted and buyer delivery exists.",
        paymentState: await buildX402PaymentStateResponse({ apiBase: getBaseUrl(request), ...stateLookup })
      });
      return;
    }
    const retryPayloadDigestSha256 = jsonDigestSha256(paymentPayload);
    if (
      ledgerEntry.paymentPayloadDigestSha256 &&
      retryPayloadDigestSha256 !== ledgerEntry.paymentPayloadDigestSha256
    ) {
      response.status(409).json({
        ok: false,
        code: "settlement_retry_payload_digest_mismatch",
        error: "Settlement retry must use the same signed x402 payment payload as the original authorization.",
        requiresOriginalPaymentPayload: true,
        doNotCreateNewPayment: true,
        expectedPaymentPayloadDigestSha256: ledgerEntry.paymentPayloadDigestSha256,
        actualPaymentPayloadDigestSha256: retryPayloadDigestSha256
      });
      return;
    }
    if (ledgerHasSettledPayment(canonicalLedgerEntry)) {
      response.json({
        ok: true,
        idempotent: true,
        status: "settled",
        code: "settlement_already_recorded",
        doNotCreateNewPayment: true,
        paymentState: await buildX402PaymentStateResponse({ apiBase: getBaseUrl(request), ...stateLookup })
      });
      return;
    }
    const { consoleState, plan } = await buildX402PlanFromOptions(getBaseUrl(request), {
      agentId: ledgerEntry.agentId
    });
    const runtime = buildAgentX402RuntimeContext({
      baseUrl: getBaseUrl(request),
      plan,
      serviceNetworkId: consoleState.deployment.networkId
    });
    if (!runtime) {
      response.status(501).json({
        ok: false,
        code: "settlement_retry_runtime_unavailable",
        error: "No live exact-price x402 rail is configured for this agent."
      });
      return;
    }
    const outcome = await settleCompletedAgentHirePaymentOutcome({
      agentId: ledgerEntry.agentId,
      sessionId: ledgerEntry.sessionId,
      pricingMode: ledgerEntry.pricingMode,
      runtime,
      paymentPayload,
      requestId: canonicalLedgerEntry.hireRequestId,
      authorizationId: ledgerEntry.authorizationId ?? retryPayloadDigestSha256,
      ledgerId: ledgerEntry.ledgerId,
      amountUsd: ledgerEntry.amountUsd,
      ...(typeof ledgerEntry.protocolFeeBps === "number" ? { protocolFeeBps: ledgerEntry.protocolFeeBps } : {})
    });
    const paymentState = await buildX402PaymentStateResponse({ apiBase: getBaseUrl(request), ...stateLookup });
    if (outcome.status === "settled") {
      response.json({
        ok: true,
        status: "settled",
        code: "settlement_retry_settled",
        idempotent: true,
        paymentState
      });
      return;
    }
    response.status(isRetryableSettlementError(outcome.error) ? 503 : 409).json({
      ok: false,
      status: "settlement_failed",
      code: isRetryableSettlementError(outcome.error)
        ? "settlement_retry_failed_retryable"
        : "settlement_retry_failed_terminal",
      retryable: isRetryableSettlementError(outcome.error),
      error: errorMessage(outcome.error, "Unable to settle x402 payment."),
      paymentState
    });
  } catch (error) {
    response.status(400).json({
      ok: false,
      code: "settlement_retry_failed",
      error: errorMessage(error, "Unable to retry x402 settlement.")
    });
  }
}));

app.post("/api/x402/settle", route(async (_request, response) => {
  try {
    const { consoleState, plan } = await buildX402PlanFromQuery(_request);
    const runtime = buildAgentX402RuntimeContext({
      baseUrl: getBaseUrl(_request),
      plan,
      serviceNetworkId: consoleState.deployment.networkId
    });
    if (!runtime) {
      response.status(501).json({
        ok: false,
        previewOnly: true,
        error: "No live exact-price x402 rail is configured for this agent yet."
      });
      return;
    }
    if (!(await ensureAgentOnlineForPayment(response, consoleState))) {
      return;
    }

    const paymentHeaderValue = _request.header("payment-signature");
    const paymentPayload = parseAgentX402PaymentPayload({
      ...(paymentHeaderValue ? { headerValue: paymentHeaderValue } : {}),
      body: _request.body ?? null
    });
    if (!paymentPayload) {
      response.status(400).json({ error: "PAYMENT-SIGNATURE header or paymentPayload body is required." });
      return;
    }

    const settlement = await settleAgentX402Payment({
      runtime,
      paymentPayload
    });
    const paymentLedgerEntry = await recordX402PaymentLedgerSettlement({
      agentId: plan.agentId,
      sessionId: plan.sessionId,
      pricingMode: consoleState.profile.paymentProfile.pricingMode,
      railPlan: settlement.rail,
      settlement,
      paymentPayload,
      ...(settlement.settlementEvents.settlementReference
        ? { authorizationId: settlement.settlementEvents.settlementReference }
        : {}),
      ...(settlement.rail.amountUsd ? { amountUsd: settlement.rail.amountUsd } : {}),
      ...(consoleState.protocolOwnerFeePolicy.enabled
        ? { protocolFeeBps: consoleState.protocolOwnerFeePolicy.feeBps }
        : {})
    });
    setHeaders(response, settlement.headers);
    response.json({
      ...settlement,
      paymentLedger: paymentLedgerEntry,
      paymentResponse: {
        ...settlement.paymentResponse,
        ledgerId: paymentLedgerEntry.ledgerId,
        transactionHashes: paymentLedgerEntry.transactionHashes
      }
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to settle x402 payment."
    });
  }
}));

app.get("/api/zeko/deployment", route(async (_request, response) => {
  response.json(await controlPlane.getDeploymentState());
}));

app.get("/api/zeko/health", route(async (_request, response) => {
  response.json(await controlPlane.getZekoHealthState());
}));

app.post("/api/zeko/session-turn/run", route(async (request, response) => {
  try {
    response.json(await controlPlane.runLiveSessionTurnFlow(parseLiveFlowRequest(request.body), adminKeyHeader(request)));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to execute live Zeko session flow."
    });
  }
}));

app.post("/api/zeko/flow/run", route(async (request, response) => {
  try {
    response.json(await controlPlane.runLiveSessionTurnFlow(parseLiveFlowRequest(request.body), adminKeyHeader(request)));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to execute live Zeko flow."
    });
  }
}));

app.get("/api/interop/agent-proof", route(async (request, response) => {
  try {
    const snapshot = await buildInteropSnapshot(request);
    response.json(
      buildAgentProofBundle({
        baseUrl: snapshot.baseUrl,
        consoleState: snapshot.consoleState,
        sessionView: snapshot.sessionView,
        events: snapshot.events,
        sessionId: snapshot.sessionId,
        ...(snapshot.turnId ? { turnId: snapshot.turnId } : {})
      })
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to build agent proof bundle."
    });
  }
}));

app.get("/api/interop/verify", route(async (request, response) => {
  try {
    const sessionId = queryString(request.query, "sessionId");
    const turnId = queryString(request.query, "turnId");
    response.json(
      await verifyInteropProof(
        {
          ...(sessionId ? { sessionId } : {}),
          ...(turnId ? { turnId } : {})
        },
        getBaseUrl(request)
      )
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to verify agent proof bundle."
    });
  }
}));

app.post("/api/interop/verify", route(async (request, response) => {
  try {
    response.json(await verifyInteropProof(parseVerificationRequest(request.body ?? null), getBaseUrl(request)));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to verify agent proof bundle."
    });
  }
}));

app.post("/mcp", route(async (request, response) => {
  try {
    const rpc = assertClawzJsonRpcRequest(request.body ?? null);

    if (rpc.method === "tools/list") {
      response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          tools: buildMcpToolDefinitions()
        }
      });
      return;
    }

    const params = isRecord(rpc.params) ? rpc.params : {};
    const name = params.name;
    const args = isRecord(params.arguments) ? params.arguments : {};

    if (name === "get_agent_discovery") {
      const snapshot = await buildInteropSnapshotFromQuery(getBaseUrl(request), {
        ...(typeof args.sessionId === "string" ? { sessionId: args.sessionId } : {})
      });
      const discovery = buildDiscoveryDocument({
        baseUrl: snapshot.baseUrl,
        consoleState: snapshot.consoleState,
        sessionId: snapshot.sessionId
      });
      response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(discovery, null, 2)
            }
          ],
          structuredContent: discovery
        }
      });
      return;
    }

    if (name === "get_agent_proof_bundle") {
      const snapshot = await buildInteropSnapshotFromQuery(getBaseUrl(request), {
        ...(typeof args.sessionId === "string" ? { sessionId: args.sessionId } : {}),
        ...(typeof args.turnId === "string" ? { turnId: args.turnId } : {})
      });
      const bundle = buildAgentProofBundle({
        baseUrl: snapshot.baseUrl,
        consoleState: snapshot.consoleState,
        sessionView: snapshot.sessionView,
        events: snapshot.events,
        sessionId: snapshot.sessionId,
        ...(snapshot.turnId ? { turnId: snapshot.turnId } : {})
      });
      response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(bundle, null, 2)
            }
          ],
          structuredContent: bundle
        }
      });
      return;
    }

    if (name === "verify_agent_proof") {
      const verification = await verifyInteropProof(parseVerificationRequest(args), getBaseUrl(request));
      response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(verification, null, 2)
            }
          ],
          structuredContent: verification
        }
      });
      return;
    }

    if (name === "get_zeko_deployment") {
      const deployment = await controlPlane.getDeploymentState();
      response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(deployment, null, 2)
            }
          ],
          structuredContent: deployment
        }
      });
      return;
    }

    response.status(404).json({
      jsonrpc: "2.0",
      id: rpc.id,
      error: {
        code: -32601,
        message: `Unknown tool: ${String(name)}`
      }
    });
  } catch (error) {
    response.status(400).json({
      jsonrpc: "2.0",
      id: isRecord(request.body) && "id" in request.body ? (request.body as Record<string, unknown>).id ?? null : null,
      error: {
        code: -32600,
        message: error instanceof Error ? error.message : "Invalid MCP request."
      }
    });
  }
}));

app.post("/api/console/trust-mode", route(async (request, response) => {
  const body = parseTrustModeRequest(request.body ?? null);
  const nextMode = body.modeId;
  const sessionId = optionalString(body.sessionId) ?? queryString(request.query, "sessionId");
  if (
    nextMode !== "fast" &&
    nextMode !== "private" &&
    nextMode !== "verified" &&
    nextMode !== "team-governed"
  ) {
    response.status(400).json({
      error: "modeId is required."
    });
    return;
  }

  try {
    response.json(await controlPlane.setTrustMode(nextMode as TrustModeId, sessionId, adminKeyHeader(request)));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to update trust mode."
    });
  }
}));

app.post("/api/console/register", route(async (request, response) => {
  const body = parseRegisterAgentRequest(request.body ?? null);

  try {
    enforceRegistrationRateLimit(request);
    response.json(await controlPlane.registerAgent(registerOptionsFromBody(body)));
  } catch (error) {
    if (error instanceof DuplicatePublicClawzUrlError) {
      response.status(409).json({
        error: error.message,
        code: "publicclawz_url_registered",
        agentId: error.existingAgentId,
        canReclaim: error.canReclaim
      });
      return;
    }
    const retryAfterSeconds =
      error instanceof Error && "retryAfterSeconds" in error
        ? (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds
        : undefined;
    if (retryAfterSeconds) {
      response.set("retry-after", String(retryAfterSeconds));
      response.status(429).json({
        error: error instanceof Error ? error.message : "Too many registration attempts."
      });
      return;
    }
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to register agent."
    });
  }
}));

app.post("/api/enrollment/tickets", route(async (request, response) => {
  const body = parseRegisterAgentRequest(request.body ?? null);

  try {
    enforceRegistrationRateLimit(request);
    response.json(await controlPlane.issueEnrollmentTicket(enrollmentTicketOptionsFromBody(body)));
  } catch (error) {
    if (error instanceof DuplicatePublicClawzUrlError) {
      response.status(409).json({
        error: error.message,
        code: "publicclawz_url_registered",
        agentId: error.existingAgentId,
        canReclaim: error.canReclaim
      });
      return;
    }
    const retryAfterSeconds =
      error instanceof Error && "retryAfterSeconds" in error
        ? (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds
        : undefined;
    if (retryAfterSeconds) {
      response.set("retry-after", String(retryAfterSeconds));
      response.status(429).json({
        error: error instanceof Error ? error.message : "Too many enrollment ticket attempts."
      });
      return;
    }
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to create enrollment ticket."
    });
  }
}));

app.post("/api/enrollment/redeem", route(async (request, response) => {
  const body = parseEnrollmentTicketRedeemRequest(request.body ?? null);
  const ticket = optionalString(body.ticket);
  const openClawUrl = optionalString(body.runtimeIngressUrl) ?? optionalString(body.openClawUrl);
  if (!ticket) {
    response.status(400).json({ error: "ticket is required." });
    return;
  }

  try {
    response.json(await controlPlane.redeemEnrollmentTicket(ticket, { ...(openClawUrl ? { openClawUrl } : {}) }));
  } catch (error) {
    if (error instanceof DuplicatePublicClawzUrlError) {
      response.status(409).json({
        error: error.message,
        code: "publicclawz_url_registered",
        agentId: error.existingAgentId,
        canReclaim: error.canReclaim
      });
      return;
    }
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to redeem enrollment ticket."
    });
  }
}));

async function issueWorkshopSetupTicket(request: IndexerRequest, response: IndexerResponse) {
  const body = isRecord(request.body) ? request.body : {};
  try {
    response.json(await controlPlane.issueCoordinationSetupTicket({ manifest: body.manifest }));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to create workshop setup ticket."
    });
  }
}

async function claimWorkshopSetupTicket(request: IndexerRequest, response: IndexerResponse) {
  const body = (isRecord(request.body) ? request.body : {}) as CoordinationSetupTicketClaimBody;
  const ticket = optionalString(body.ticket);
  const agentId = optionalString(body.agentId);
  if (!ticket) {
    response.status(400).json({ error: "ticket is required." });
    return;
  }
  if (!agentId) {
    response.status(400).json({ error: "agentId is required." });
    return;
  }

  try {
    response.json(await controlPlane.claimCoordinationSetupTicket({ ticket, agentId }));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to claim workshop setup ticket."
    });
  }
}

app.post("/api/workshop/envelopes", route(async (request, response) => {
  const body = isRecord(request.body) ? request.body : {};
  const agentId = optionalString(body.agentId);
  const workshopToken = workshopTokenHeader(request);
  if (!agentId) {
    response.status(400).json({ error: "agentId is required." });
    return;
  }
  if (!workshopToken) {
    response.status(401).json({ error: "Workshop access token is required." });
    return;
  }
  if (!isRecord(body.envelope)) {
    response.status(400).json({ error: "envelope is required." });
    return;
  }

  try {
    response.json(await controlPlane.postWorkshopPrivateEnvelope({
      agentId,
      workshopToken,
      envelope: body.envelope as unknown as AgentMessageEnvelope
    }));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to post workshop private envelope."
    });
  }
}));

app.get("/api/workshop/envelopes", route(async (request, response) => {
  const agentId = queryString(request.query, "agentId");
  const threadId = queryString(request.query, "threadId");
  const channelId = queryString(request.query, "channelId");
  const rawLimit = queryString(request.query, "limit");
  const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
  const workshopToken = workshopTokenHeader(request);
  if (!agentId) {
    response.status(400).json({ error: "agentId is required." });
    return;
  }
  if (!workshopToken) {
    response.status(401).json({ error: "Workshop access token is required." });
    return;
  }

  try {
    response.json(await controlPlane.listWorkshopPrivateEnvelopes({
      agentId,
      workshopToken,
      ...(threadId ? { threadId } : {}),
      ...(channelId ? { channelId } : {}),
      ...(typeof parsedLimit === "number" && Number.isFinite(parsedLimit) ? { limit: parsedLimit } : {})
    }));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to read workshop private envelopes."
    });
  }
}));

app.get("/api/workshop/setup-tickets/:ticketId/status", route(async (request, response) => {
  const ticketId = request.params.ticketId;
  const ticket = queryString(request.query, "ticket");
  if (!ticketId) {
    response.status(400).json({ error: "ticketId is required." });
    return;
  }
  if (!ticket) {
    response.status(400).json({ error: "ticket is required." });
    return;
  }
  try {
    response.json(await controlPlane.getCoordinationSetupTicketStatus({ ticketId, ticket }));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to read workshop setup ticket status."
    });
  }
}));

app.post("/api/workshop/setup-tickets", route(issueWorkshopSetupTicket));
app.post("/api/workshop/setup-tickets/claim", route(claimWorkshopSetupTicket));
app.post("/api/coordination/setup-tickets", route(issueWorkshopSetupTicket));
app.post("/api/coordination/setup-tickets/claim", route(claimWorkshopSetupTicket));

app.post("/api/console/profile", route(async (request, response) => {
  const body = parseProfileRequest(request.body ?? null);
  const sessionId = optionalString(body.sessionId) ?? queryString(request.query, "sessionId");
  const payoutWallets = parsePayoutWallets(body.payoutWallets);
  const missionAuthOverlay = parseMissionAuthOverlay(body.missionAuthOverlay);
  const paymentProfile = parsePaymentProfile(body.paymentProfile);
  const marketplaceTags = parseAgentMarketplaceTags(body.marketplaceTags);
  const contextRequirements = parseContextRequirements(body.contextRequirements);
  const runtimeDelivery = parseRuntimeDelivery(body.runtimeDelivery);
  const socialAnchorPolicy = parseSocialAnchorPolicy(body.socialAnchorPolicy);
  const preferredProvingLocation =
    body.preferredProvingLocation === "client" ||
    body.preferredProvingLocation === "server" ||
    body.preferredProvingLocation === "sovereign-rollup"
      ? body.preferredProvingLocation
      : undefined;
  const profile: Parameters<typeof controlPlane.updateAgentProfile>[1] = {
    ...(typeof body.agentName === "string" ? { agentName: body.agentName } : {}),
    ...(typeof body.representedPrincipal === "string" ? { representedPrincipal: body.representedPrincipal } : {}),
    ...(typeof body.headline === "string" ? { headline: body.headline } : {}),
    ...(typeof body.publicClawzUrl === "string"
      ? { openClawUrl: body.publicClawzUrl }
      : typeof body.openClawUrl === "string"
        ? { openClawUrl: body.openClawUrl }
        : {}),
    ...(payoutWallets ? { payoutWallets } : {}),
    ...(missionAuthOverlay ? { missionAuthOverlay } : {}),
    ...(paymentProfile ? { paymentProfile } : {}),
    ...(marketplaceTags ? { marketplaceTags } : {}),
    ...(contextRequirements ? { contextRequirements } : {}),
    ...(runtimeDelivery ? { runtimeDelivery } : {}),
    ...(socialAnchorPolicy ? { socialAnchorPolicy } : {}),
    ...(typeof body.payoutAddress === "string"
      ? {
          payoutWallets: {
            ...(payoutWallets ?? {}),
            base: body.payoutAddress
          }
        }
      : {}),
    ...(preferredProvingLocation ? { preferredProvingLocation } : {})
  };
  response.json(await controlPlane.updateAgentProfile(sessionId, profile, adminKeyHeader(request)));
}));

app.post("/api/ownership/challenge", route(async (request, response) => {
  const body = parseOwnershipActionRequest(request.body ?? null);
  try {
    const sessionId = optionalString(body.sessionId) ?? queryString(request.query, "sessionId");
    const agentId = optionalString(body.agentId) ?? queryString(request.query, "agentId");
    const adminKey = adminKeyHeader(request);
    const result = await controlPlane.issueOwnershipChallenge({
      ...(sessionId ? { sessionId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(adminKey ? { adminKey } : {})
    });
    response.json({
      ...result.state,
      issuedOwnershipChallenge: result.issuedOwnershipChallenge
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to issue ownership challenge."
    });
  }
}));

app.post("/api/ownership/verify", route(async (request, response) => {
  const body = parseOwnershipActionRequest(request.body ?? null);
  try {
    const sessionId = optionalString(body.sessionId) ?? queryString(request.query, "sessionId");
    const agentId = optionalString(body.agentId) ?? queryString(request.query, "agentId");
    const adminKey = adminKeyHeader(request);
    response.json(
      await controlPlane.verifyOwnershipChallenge({
        ...(sessionId ? { sessionId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(adminKey ? { adminKey } : {})
      })
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to verify ownership challenge."
    });
  }
}));

app.post("/api/ownership/reclaim", route(async (request, response) => {
  const body = parseOwnershipActionRequest(request.body ?? null);
  try {
    const sessionId = optionalString(body.sessionId) ?? queryString(request.query, "sessionId");
    const agentId = optionalString(body.agentId) ?? queryString(request.query, "agentId");
    const adminKey = adminKeyHeader(request);
    response.json(
      await controlPlane.verifyOwnershipChallenge({
        ...(sessionId ? { sessionId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(adminKey ? { adminKey } : {})
      })
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to reclaim agent ownership."
    });
  }
}));

const handleAgentHireRequest = route(async (request, response) => {
  const agentId = request.params.agentId;
  if (!agentId) {
    response.status(400).json(hireRequestErrorBody("agent_id_required", "agentId is required."));
    return;
  }

  const body = parseHireRequest(request.body ?? null);
  try {
    if (Buffer.byteLength(JSON.stringify(request.body ?? {}), "utf8") > HIRE_REQUEST_BODY_MAX_BYTES) {
      response.status(413).json(hireRequestErrorBody("hire_request_body_too_large", "Hire request body is too large."));
      return;
    }
    const bodyRecord = body as Record<string, unknown>;
    const activationLaneRequested =
      queryBoolean(request.query, "activationLane") === true ||
      bodyRecord.activationLane === true ||
      bodyRecord.activation_lane === true;
    const publicActivationProbeRequested =
      queryBoolean(request.query, "activationProbe") === true ||
      bodyRecord.activationProbe === true ||
      bodyRecord.activation_probe === true;
    const sellerReadinessTestRequested =
      queryBoolean(request.query, "sellerReadinessTest") === true ||
      queryBoolean(request.query, "sellerTest") === true ||
      bodyRecord.sellerReadinessTest === true ||
      bodyRecord.seller_readiness_test === true;
    const activationProbeRequested = activationLaneRequested || publicActivationProbeRequested || sellerReadinessTestRequested;
    if (activationLaneRequested && !requireActivationLaneAccess(request, response)) {
      return;
    }
    const activationAmountUsd = activationProbeRequested ? activationLaneAmountUsd() : undefined;
    const taskPrompt =
      typeof body.taskPrompt === "string" && body.taskPrompt.trim().length > 0
        ? body.taskPrompt.trim()
        : sellerReadinessTestRequested
          ? "SantaClawz seller readiness test. Return a compact v1.1 buyer-visible package with a short answer, verification manifest, and delivery summary proving paid execution works end-to-end."
          : activationProbeRequested
          ? "SantaClawz paid activation probe. Return a compact buyer-visible package proving this agent can receive paid work, complete it, and return delivery."
          : "";
    const requesterContact =
      typeof body.requesterContact === "string" && body.requesterContact.trim().length > 0
        ? body.requesterContact.trim()
        : activationLaneRequested
          ? "agent_job_pack@santaclawz.ai"
          : sellerReadinessTestRequested
            ? "seller_readiness_test@santaclawz.ai"
          : publicActivationProbeRequested
            ? "buyer_activation_probe@santaclawz.ai"
          : "";
    const jobPrivacy = parseJobPrivacyPreference(body.jobPrivacy ?? body.activityPrivacy);
    const artifactDelivery = parseArtifactDeliveryPreference(body.artifactDelivery);
    const marketplaceTags = parseMarketplaceWorkTags(body.marketplaceTags);
    const jobContext = parseJobContext(body.jobContext ?? body.context);
    if (taskPrompt.length > HIRE_TASK_PROMPT_MAX_LENGTH) {
      response.status(400).json(hireRequestErrorBody(
        "task_prompt_too_long",
        `taskPrompt must be ${HIRE_TASK_PROMPT_MAX_LENGTH} characters or less.`,
        { actualChars: taskPrompt.length }
      ));
      return;
    }
    if (requesterContact.length > HIRE_REQUESTER_CONTACT_MAX_LENGTH) {
      response.status(400).json(hireRequestErrorBody(
        "requester_contact_too_long",
        `requesterContact must be ${HIRE_REQUESTER_CONTACT_MAX_LENGTH} characters or less.`,
        { actualChars: requesterContact.length }
      ));
      return;
    }

    const { consoleState, plan } = await buildX402PlanFromOptions(getBaseUrl(request), { agentId });
    const published = plan.published;
    if (consoleState.profile.availability !== "active") {
      response.status(400).json({ error: "This agent is archived or inactive on SantaClawz and is not accepting new hire requests." });
      return;
    }
    if (consoleState.ownership.status !== "verified") {
      response.status(400).json({ error: "This agent must verify control of its PublicClawz endpoint before it can accept public hire requests." });
      return;
    }
    if (!published) {
      response.status(400).json({ error: "This agent needs to publish on Zeko before it can accept hire requests." });
      return;
    }
    let paymentAuthorization:
      | {
          status: "authorized" | "settled";
          rail?: string;
          amountUsd?: string;
          authorizationId?: string;
          ledgerId?: string;
          settlementEvents?: {
            sellerSettlementTxHash?: string;
            protocolFeeTxHash?: string;
            transactionHashes?: string[];
          };
          settlementReference?: string;
          paymentPayloadDigestSha256?: string;
          paymentAuthorizationDigestSha256?: string;
          paymentResponseDigestSha256?: string;
          activationLane?: boolean;
          publicActivationProbe?: boolean;
          sellerReadinessTest?: boolean;
        }
      | undefined;
    let paymentPayloadForDeferredSettlement: Record<string, unknown> | undefined;
    let runtimeForDeferredSettlement: ReturnType<typeof buildAgentX402RuntimeContext> | undefined;
    let authorizationLedgerId: string | undefined;

    const quoteRequestMode =
      consoleState.paymentsEnabled &&
      consoleState.profile.paymentProfile.pricingMode === "quote-required" &&
      !activationProbeRequested;
    if (activationProbeRequested && !consoleState.paymentsEnabled) {
      response.status(400).json({
        ok: false,
        code: "activation_probe_requires_payments",
        retryable: false,
        paymentRequested: false,
        error: "Paid activation probes require the agent to configure payments first.",
        nextAction: "configure_payments_then_retry_activation_probe",
        operationalStatus: {
          paymentStatus: "not_configured",
          settlementStatus: "not_attempted",
          relayDeliveryStatus: "not_attempted",
          agentExecutionStatus: "not_started"
        }
      });
      return;
    }
    if (quoteRequestMode) {
      const quotePaymentIntentId =
        queryString(request.query, "intentId") ||
        (typeof bodyRecord.intentId === "string" ? bodyRecord.intentId.trim() : "") ||
        (typeof bodyRecord.quoteIntentId === "string" ? bodyRecord.quoteIntentId.trim() : "");
      const paymentHeaderValue = request.header("payment-signature");
      const quotePaymentPayload = parseAgentX402PaymentPayload({
        ...(paymentHeaderValue ? { headerValue: paymentHeaderValue } : {}),
        body: request.body ?? null
      });
      if (quotePaymentIntentId || quotePaymentPayload) {
        response.status(400).json({
          ok: false,
          code: "quote_payment_requires_quote_intent_endpoint",
          retryable: false,
          error:
            "Quote-required agents use /hire for quote intake only. Submit accepted quote payments to /api/x402/quote-intent?intentId=exec_... so SantaClawz can run paid_execution.",
          nextAction: "pay_accepted_quote_intent",
          quoteIntentEndpoint: quotePaymentIntentId
            ? `/api/x402/quote-intent?intentId=${encodeURIComponent(quotePaymentIntentId)}`
            : "/api/x402/quote-intent?intentId=exec_...",
          operationalStatus: {
            paymentStatus: "unknown",
            settlementStatus: "not_attempted",
            relayDeliveryStatus: "not_attempted",
            agentExecutionStatus: "not_started"
          }
        });
        return;
      }
    }
    if (!activationProbeRequested) {
      const contextCheck = evaluateContextRequirements(consoleState.profile.contextRequirements, jobContext);
      if (!contextCheck.ok) {
        const firstMissing = contextCheck.missing[0];
        response.status(400).json(hireRequestErrorBody(
          firstMissing?.missingCode ?? "missing_required_input",
          firstMissing?.buyerMessage ??
            "This seller requires more buyer context before SantaClawz can submit the job.",
          {
            paymentRequested: false,
            nextAction: "provide_required_context",
            acceptedContextFields: Array.from(CONTEXT_INPUT_FIELD_SET),
            missingRequirements: contextCheck.missing,
            jobContextShape: {
              urls: ["https://example.com/source-or-reference"],
              text: "Plain text input or instructions that do not fit in taskPrompt.",
              attachments: [
                {
                  kind: "document",
                  url: "https://example.com/input.pdf",
                  digestSha256: "optional sha256 digest"
                }
              ],
              structuredData: { key: "value" }
            },
            operationalStatus: {
              paymentStatus: "not_required",
              settlementStatus: "not_attempted",
              relayDeliveryStatus: "not_attempted",
              agentExecutionStatus: "not_started"
            }
          }
        ));
        return;
      }
    }

    if (consoleState.paymentsEnabled && (!quoteRequestMode || activationProbeRequested)) {
      const runtime = activationProbeRequested
        ? await buildActivationLaneX402RuntimeContext({
            baseUrl: getBaseUrl(request),
            consoleState,
            serviceNetworkId: consoleState.deployment.networkId,
            agentId,
            amountUsd: activationAmountUsd ?? "0.002001"
          })
        : buildAgentX402RuntimeContext({
            baseUrl: getBaseUrl(request),
            plan,
            serviceNetworkId: consoleState.deployment.networkId
          });
      if ((!activationProbeRequested && !consoleState.paidJobsEnabled) || !runtime) {
        response.status(402).json({
          ok: false,
          paymentRequested: false,
          error: "This agent has payments turned on, but paid jobs are not live yet.",
          plan
        });
        return;
      }
      if (!(await ensureAgentOnlineForPayment(response, consoleState))) {
        return;
      }
      if (!activationProbeRequested && !paidExecutionProvenFromReadiness(consoleState.readiness)) {
        response.status(409).json(paidExecutionProbeRequiredBody({ agentId, plan }));
        return;
      }

      const paymentHeaderValue = request.header("payment-signature");
      const paymentPayload = parseAgentX402PaymentPayload({
        ...(paymentHeaderValue ? { headerValue: paymentHeaderValue } : {}),
        body: request.body ?? null
      });

      if (!paymentPayload) {
        setHeaders(response, buildAgentX402Headers({ paymentRequired: runtime.paymentRequired }));
        response.status(402).json(runtime.paymentRequired);
        return;
      }

      const paymentPayloadDigestSha256 = jsonDigestSha256(paymentPayload);
      let verification: Awaited<ReturnType<typeof verifyAgentX402Payment>>;
      try {
        verification = await verifyAgentX402Payment({
          runtime,
          paymentPayload
        });
      } catch (error) {
        response.status(400).json(paymentSettlementFailureBody(error, { agentId }));
        return;
      }
      if (!verification.ok) {
        const existingPaymentState = await buildX402PaymentStateResponse({
          apiBase: getBaseUrl(request),
          paymentPayloadDigestSha256
        });
        const existingLedger = isRecord(existingPaymentState.payment) && isRecord(existingPaymentState.payment.latestLedger)
          ? existingPaymentState.payment.latestLedger
          : undefined;
        if (existingLedger && typeof existingLedger.ledgerId === "string") {
          const verificationError = new Error(verification.error ?? "x402 authorization was not valid.");
          const retryableVerificationError = isRetryableSettlementError(verificationError);
          await controlPlane.annotatePaymentLedgerPayloadRetryFailure({
            ledgerId: existingLedger.ledgerId,
            errorMessage: errorMessage(verificationError, "x402 authorization was not valid."),
            errorCode: isExpiredPaymentPayloadError(verificationError)
              ? "payment_payload_expired_for_retry"
              : retryableVerificationError
                ? verification.errorCode ?? "x402_retryable_verification_failed"
                : "payment_payload_retry_failed"
          });
          const reconciledPaymentState = await buildX402PaymentStateResponse({
            apiBase: getBaseUrl(request),
            paymentPayloadDigestSha256
          });
          response.status(202).json({
            ok: false,
            code: isExpiredPaymentPayloadError(verificationError)
              ? "payment_payload_expired_existing_state"
              : retryableVerificationError
                ? "payment_payload_retryable_existing_state"
                : "payment_payload_retry_failed_existing_state",
            retryable: retryableVerificationError,
            paymentPayloadDigestSha256,
            error: errorMessage(verificationError, "x402 authorization was not valid."),
            nextAction: "inspect_payment_or_execution_state",
            paymentStateUrl:
              `${getBaseUrl(request)}/api/x402/payment-state?paymentPayloadDigestSha256=${encodeURIComponent(paymentPayloadDigestSha256)}`,
            retryResume: reconciledPaymentState.retryResume,
            operationalStatus: isRecord(reconciledPaymentState.execution) && isRecord(reconciledPaymentState.execution.operationalStatus)
              ? reconciledPaymentState.execution.operationalStatus
              : {
                  paymentStatus: "unknown",
                  settlementStatus: "unknown",
                  relayDeliveryStatus: "unknown",
                  agentExecutionStatus: "unknown"
                },
            paymentState: reconciledPaymentState
          });
          return;
        }
        response.status(402).json(paymentSettlementFailureBody(new Error(verification.error ?? "x402 authorization was not valid."), {
          agentId,
          paymentAuthorized: false,
          paymentPayloadDigestSha256,
          ...(verification.errorCode ? { errorCode: verification.errorCode } : {}),
          ...(verification.remoteVerification ? { facilitatorDiagnostics: verification.remoteVerification } : {})
        }));
        return;
      }
      setHeaders(response, verification.headers);
      const paymentLedgerEntry = await recordX402PaymentLedgerAuthorization({
        agentId,
        sessionId: consoleState.session.sessionId,
        pricingMode: activationProbeRequested ? "fixed-exact" : consoleState.profile.paymentProfile.pricingMode,
        railPlan: verification.rail,
        verification,
        paymentPayload,
        authorizationId: paymentPayloadDigestSha256,
        ...(verification.rail.amountUsd ? { amountUsd: verification.rail.amountUsd } : {}),
        ...(consoleState.protocolOwnerFeePolicy.enabled
          ? { protocolFeeBps: consoleState.protocolOwnerFeePolicy.feeBps }
          : {})
      });
      if (
        paymentLedgerEntry.hireRequestId &&
        paymentLedgerEntry.executionStatus === "completed" &&
        paymentLedgerEntry.returnStatus === "accepted" &&
        paymentLedgerEntry.transactionHashes.length === 0
      ) {
        const completedHire = await controlPlane.getHireRequest(paymentLedgerEntry.hireRequestId);
        if (completedHire.protocolReturn?.status === "completed") {
          const buyerDeliveryAvailable = protocolReturnHasBuyerDelivery(completedHire.protocolReturn);
          const returnValidated = Boolean(completedHire.protocolReturn?.verifiedOutput);
          if (buyerDeliveryAvailable) {
            void settleCompletedAgentHirePaymentOutcome({
              agentId,
              sessionId: consoleState.session.sessionId,
              pricingMode: activationProbeRequested ? "fixed-exact" : consoleState.profile.paymentProfile.pricingMode,
              runtime,
              paymentPayload,
              requestId: completedHire.requestId,
              authorizationId: paymentPayloadDigestSha256,
              ledgerId: paymentLedgerEntry.ledgerId,
              ...(verification.rail.amountUsd ? { amountUsd: verification.rail.amountUsd } : {}),
              ...(consoleState.protocolOwnerFeePolicy.enabled
                ? { protocolFeeBps: consoleState.protocolOwnerFeePolicy.feeBps }
                : {})
            });
          }
          const protocolLifecycle = reduceSantaClawzPaidLifecycle({
            paymentStatus: "authorization_verified",
            settlementStatus: "authorized",
            relayDeliveryStatus: completedHire.operationalStatus?.relayDeliveryStatus,
            agentExecutionStatus: completedHire.operationalStatus?.agentExecutionStatus,
            proofStatus: returnValidated ? "return_validated" : "not_started",
            sellerExecutionCompleted: returnValidated,
            buyerDeliveryAvailable,
            buyerComplete: false,
            paymentAuthorized: true,
            paymentSettled: false
          });
          response.status(202).json({
            ...completedHire,
            ok: protocolLifecycle.buyerAnswer.hasBuyerDelivery,
            code: protocolLifecycle.protocolState === "DELIVERED_AWAITING_SETTLEMENT"
              ? "paid_execution_delivery_available_settlement_pending"
              : protocolLifecycle.protocolState === "DELIVERED_SETTLEMENT_FAILED_REQUIRES_RECONCILIATION"
                ? "paid_execution_delivery_available_settlement_reconcile"
              : protocolLifecycle.protocolState === "PLATFORM_FAILED_RECONCILE"
                ? "paid_execution_delivery_reconciliation_required"
                : "paid_execution_state_recorded",
            idempotent: true,
            resumedFromPaymentPayload: true,
            retryable: false,
            nextAction: protocolLifecycle.buyerAction,
            protocolLifecycle,
            protocolState: protocolLifecycle.protocolState,
            buyerAction: protocolLifecycle.buyerAction,
            sellerOutcome: protocolLifecycle.sellerOutcome,
            operatorObligation: protocolLifecycle.operatorObligation,
            ...lifecycleFinalityFields(protocolLifecycle),
            buyerDeliveryAvailable: protocolLifecycle.buyerAnswer.hasBuyerDelivery,
            buyerComplete: protocolLifecycle.buyerAnswer.hasBuyerDelivery,
            sellerReputationImpact: protocolLifecycle.sellerAnswer.reputationImpact,
            safeToCreateNewPayment: protocolLifecycle.buyerAnswer.canCreateFreshPayment,
            safeToRetrySamePayload: protocolLifecycle.buyerAnswer.canRetrySamePaymentPayload,
            safeToRetrySamePaymentPayload: protocolLifecycle.buyerAnswer.canRetrySamePaymentPayload,
            doNotCreateNewPayment: !protocolLifecycle.buyerAnswer.canCreateFreshPayment,
            paymentPayloadDigestSha256,
            stateUrl: `${getBaseUrl(request)}/api/executions/${encodeURIComponent(completedHire.requestId)}/state`,
            paymentStateUrl:
              `${getBaseUrl(request)}/api/x402/payment-state?paymentPayloadDigestSha256=${encodeURIComponent(paymentPayloadDigestSha256)}`,
            paymentStatus: "authorized",
            operationalStatus: completedHire.operationalStatus
              ? {
                  ...completedHire.operationalStatus,
                  paymentStatus: "authorized",
                  settlementStatus:
                    protocolLifecycle.protocolState === "DELIVERED_SETTLEMENT_FAILED_REQUIRES_RECONCILIATION"
                      ? "failed"
                      : "authorized"
                }
              : completedHire.operationalStatus,
            payment: {
              ...completedHire.payment,
              status: "authorized",
              ledgerId: paymentLedgerEntry.ledgerId,
              transactionHashes: []
            }
          });
          return;
        }
      }
      paymentAuthorization = {
        status: "authorized",
        ...(activationProbeRequested ? { activationLane: true } : {}),
        ...(publicActivationProbeRequested || sellerReadinessTestRequested ? { publicActivationProbe: true } : {}),
        ...(sellerReadinessTestRequested ? { sellerReadinessTest: true } : {}),
        rail: verification.rail.rail,
        ...(verification.rail.amountUsd ? { amountUsd: verification.rail.amountUsd } : {}),
        authorizationId: paymentPayloadDigestSha256,
        ledgerId: paymentLedgerEntry.ledgerId,
        paymentPayloadDigestSha256,
        paymentAuthorizationDigestSha256: paymentPayloadDigestSha256
      };
      paymentPayloadForDeferredSettlement = paymentPayload;
      runtimeForDeferredSettlement = runtime;
      authorizationLedgerId = paymentLedgerEntry.ledgerId;
    }

    try {
      const hireReceipt = await controlPlane.submitHireRequest({
        agentId,
        taskPrompt,
        requesterContact,
        ...(typeof body.budgetMina === "string" ? { budgetMina: body.budgetMina } : {}),
        ...(marketplaceTags ? { marketplaceTags } : {}),
        ...(jobContext ? { jobContext } : {}),
        ...(jobPrivacy ? { jobPrivacy } : {}),
        ...(artifactDelivery ? { artifactDelivery } : {}),
        ...(paymentAuthorization ? { paymentAuthorization } : {})
      });
      if (
        paymentAuthorization &&
        paymentPayloadForDeferredSettlement &&
        runtimeForDeferredSettlement &&
        hireReceipt.protocolReturn?.status === "completed"
      ) {
        const paymentPayloadDigestSha256 =
          paymentAuthorization.paymentPayloadDigestSha256 ??
          paymentAuthorization.paymentAuthorizationDigestSha256 ??
          paymentAuthorization.authorizationId;
        const stateUrl =
          `${getBaseUrl(request)}/api/executions/${encodeURIComponent(hireReceipt.requestId)}/state` +
          (hireReceipt.jobWorkspace?.token ? `?token=${encodeURIComponent(hireReceipt.jobWorkspace.token)}` : "");
        const paymentStateUrl = paymentPayloadDigestSha256
          ? `${getBaseUrl(request)}/api/x402/payment-state?paymentPayloadDigestSha256=${encodeURIComponent(paymentPayloadDigestSha256)}`
          : undefined;
        const buyerDeliveryAvailable = protocolReturnHasBuyerDelivery(hireReceipt.protocolReturn);
        const returnValidated = Boolean(hireReceipt.protocolReturn?.verifiedOutput);
        if (buyerDeliveryAvailable) {
          void settleCompletedAgentHirePaymentOutcome({
            agentId,
            sessionId: consoleState.session.sessionId,
            pricingMode: activationProbeRequested ? "fixed-exact" : consoleState.profile.paymentProfile.pricingMode,
            runtime: runtimeForDeferredSettlement,
            paymentPayload: paymentPayloadForDeferredSettlement,
            requestId: hireReceipt.requestId,
            ...(paymentAuthorization.authorizationId ? { authorizationId: paymentAuthorization.authorizationId } : {}),
            ...(authorizationLedgerId ? { ledgerId: authorizationLedgerId } : {}),
            ...(paymentAuthorization.amountUsd ? { amountUsd: paymentAuthorization.amountUsd } : {}),
            ...(consoleState.protocolOwnerFeePolicy.enabled
              ? { protocolFeeBps: consoleState.protocolOwnerFeePolicy.feeBps }
              : {})
          });
        }
        const protocolLifecycle = reduceSantaClawzPaidLifecycle({
          paymentStatus: "authorization_verified",
          settlementStatus: "authorized",
          relayDeliveryStatus: hireReceipt.operationalStatus?.relayDeliveryStatus,
          agentExecutionStatus: hireReceipt.operationalStatus?.agentExecutionStatus,
          proofStatus: returnValidated ? "return_validated" : "not_started",
          sellerExecutionCompleted: returnValidated,
          buyerDeliveryAvailable,
          buyerComplete: false,
          paymentAuthorized: true,
          paymentSettled: false
        });
        const code =
          protocolLifecycle.protocolState === "DELIVERED_AWAITING_SETTLEMENT"
            ? "paid_execution_delivery_available_settlement_pending"
            : protocolLifecycle.protocolState === "DELIVERED_SETTLEMENT_FAILED_REQUIRES_RECONCILIATION"
              ? "paid_execution_delivery_available_settlement_reconcile"
            : protocolLifecycle.protocolState === "PLATFORM_FAILED_RECONCILE"
              ? "paid_execution_delivery_reconciliation_required"
              : "paid_execution_state_recorded";
        response.status(202).json({
          ...hireReceipt,
          ok: protocolLifecycle.buyerAnswer.hasBuyerDelivery,
          code,
          retryable: false,
          nextAction: protocolLifecycle.buyerAction,
          protocolLifecycle,
          protocolState: protocolLifecycle.protocolState,
          buyerAction: protocolLifecycle.buyerAction,
          sellerOutcome: protocolLifecycle.sellerOutcome,
          operatorObligation: protocolLifecycle.operatorObligation,
          ...lifecycleFinalityFields(protocolLifecycle),
          buyerDeliveryAvailable: protocolLifecycle.buyerAnswer.hasBuyerDelivery,
          buyerComplete: protocolLifecycle.buyerAnswer.hasBuyerDelivery,
          sellerReputationImpact: protocolLifecycle.sellerAnswer.reputationImpact,
          safeToCreateNewPayment: protocolLifecycle.buyerAnswer.canCreateFreshPayment,
          safeToRetrySamePayload: protocolLifecycle.buyerAnswer.canRetrySamePaymentPayload,
          safeToRetrySamePaymentPayload: protocolLifecycle.buyerAnswer.canRetrySamePaymentPayload,
          doNotCreateNewPayment: !protocolLifecycle.buyerAnswer.canCreateFreshPayment,
          ...(paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256 } : {}),
          stateUrl,
          ...(paymentStateUrl ? { paymentStateUrl } : {}),
          paymentStatus: "authorized",
          operationalStatus: hireReceipt.operationalStatus
            ? {
                ...hireReceipt.operationalStatus,
                paymentStatus: "authorized",
                settlementStatus: protocolLifecycle.protocolState === "DELIVERED_SETTLEMENT_FAILED_REQUIRES_RECONCILIATION"
                  ? "failed"
                  : "authorized"
              }
            : hireReceipt.operationalStatus,
          payment: {
            ...hireReceipt.payment,
            status: "authorized",
            ledgerId: authorizationLedgerId,
            transactionHashes: []
          }
        });
        return;
      }
      response.status(paymentAuthorization && hireReceipt.status !== "completed" ? 202 : 200).json({
        ...hireReceipt,
        ...(paymentAuthorization && authorizationLedgerId
          ? {
              payment: {
                ...hireReceipt.payment,
                status: "authorized",
                ledgerId: authorizationLedgerId,
                transactionHashes: []
              }
            }
          : {})
      });
    } catch (error) {
      if (paymentAuthorization) {
        response.status(400).json(relayDeliveryFailureBody(error, {
          agentId,
          payment: {
            status: paymentAuthorization.status,
            ...(paymentAuthorization.rail ? { rail: paymentAuthorization.rail } : {}),
            ...(paymentAuthorization.amountUsd ? { amountUsd: paymentAuthorization.amountUsd } : {}),
            ...(paymentAuthorization.authorizationId ? { authorizationId: paymentAuthorization.authorizationId } : {}),
            ...(paymentAuthorization.settlementReference
              ? { settlementReference: paymentAuthorization.settlementReference }
              : {}),
            ...(paymentAuthorization.ledgerId ? { ledgerId: paymentAuthorization.ledgerId } : {}),
            ...(paymentAuthorization.settlementEvents?.transactionHashes?.length
              ? { transactionHashes: paymentAuthorization.settlementEvents.transactionHashes }
              : {})
          }
        }));
        return;
      }
      throw error;
    }
  } catch (error) {
    response.status(400).json(hireRequestFailureBody(error));
  }
});

app.post("/api/agents/:agentId/hire", handleAgentHireRequest);
app.post("/agent/:agentId/hire", handleAgentHireRequest);
app.post("/api/activation-lane/agents/:agentId/hire", (request, response) => {
  request.query = {
    ...request.query,
    activationLane: "true"
  };
  handleAgentHireRequest(request, response);
});

app.post("/api/activation-lane/attempts", route(async (request, response) => {
  if (!requireActivationLaneAccess(request, response)) {
    return;
  }
  const body = isRecord(request.body) ? request.body : {};
  const agentId = optionalString(body.agentId);
  if (!agentId) {
    response.status(400).json({
      ok: false,
      code: "activation_lane_agent_id_required",
      error: "agentId is required."
    });
    return;
  }
  const sessionId = optionalString(body.sessionId);
  const classification = parseActivationProbeClassification(body.classification);
  const mode = optionalString(body.mode);
  const httpStatus = optionalNumber(body.httpStatus ?? body.statusCode);
  const requestId = optionalString(body.requestId);
  const ledgerId = optionalString(body.ledgerId);
  const paymentPayloadDigestSha256 = optionalString(body.paymentPayloadDigestSha256);
  const responseDigestSha256 = optionalString(body.responseDigestSha256);
  const error = optionalString(body.error);
  const occurredAtIso = optionalString(body.occurredAtIso);
  const attemptOptions: RecordActivationLaneAttemptOptions = {
    agentId,
    ...(sessionId ? { sessionId } : {}),
    status: parseActivationLaneAttemptStatus(body.status),
    ...(classification ? { classification } : {}),
    ...(typeof body.ok === "boolean" ? { ok: body.ok } : {}),
    ...(mode ? { mode } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(requestId ? { requestId } : {}),
    ...(ledgerId ? { ledgerId } : {}),
    ...(paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256 } : {}),
    ...(responseDigestSha256 ? { responseDigestSha256 } : {}),
    ...(error ? { error } : {}),
    ...(occurredAtIso ? { occurredAtIso } : {})
  };
  try {
    const attempt = await controlPlane.recordActivationLaneAttempt(attemptOptions);
    clearConsoleStateCache();
    response.json({
      ok: true,
      attempt
    });
  } catch (error) {
    response.status(400).json({
      ok: false,
      code: "activation_lane_attempt_rejected",
      error: errorMessage(error, "Unable to record activation-lane attempt.")
    });
  }
}));

app.get("/api/activation-lane/candidates", route(async (request, response) => {
  if (!requireActivationLaneAccess(request, response)) {
    return;
  }

  const limit = queryBoundedInteger(request.query, "limit", 20, 1, 100);
  const amountUsd = activationLaneAmountUsd();
  const retryAfterSeconds = activationLaneRetrySeconds();
  const intervalSeconds = activationLaneIntervalSeconds();
  const baseUrl = getBaseUrl(request);
  const requestedAgentId = queryString(request.query, "agentId");
  const force = queryBoolean(request.query, "force") === true;
  const includeDiagnostics =
    queryBoolean(request.query, "includeDiagnostics") === true ||
    queryBoolean(request.query, "diagnostics") === true ||
    queryBoolean(request.query, "includeIneligible") === true;
  const { candidates: allCandidates, diagnostics } = await controlPlane.listActivationLaneCandidates({
    amountUsd,
    baseUrl,
    force,
    limit: requestedAgentId ? 100 : limit,
    retryAfterSeconds,
    includeDiagnostics
  });
  const candidates = requestedAgentId
    ? allCandidates.filter((candidate) => candidate.agentId === requestedAgentId).slice(0, limit)
    : allCandidates.slice(0, limit);

  response.json({
    ok: true,
    lane: "activation_lane",
    amountUsd,
    intervalSeconds,
    retryAfterSeconds,
    total: candidates.length,
    candidates,
    ...(includeDiagnostics
      ? {
          diagnostics: {
            pollPolicy: {
              intervalSeconds,
              retryAfterSeconds,
              candidateLimit: limit
            },
            totalRegisteredMatching: diagnostics?.totalObservedHeartbeats ?? 0,
            totalAwaitingPaidExecutionProof: diagnostics?.totalObservedHeartbeats ?? 0,
            totalQuoteRequiredAwaitingActivation: 0,
            ...(diagnostics
              ? {
                  ...diagnostics,
                  totalQueued: diagnostics.totalObservedHeartbeats
                }
              : {
                  totalObservedHeartbeats: 0,
                  totalQueued: 0,
                  totalEligible: candidates.length,
                  totalExcluded: 0,
                  excludedAgents: []
                })
          }
        }
      : {})
  });
}));

app.post("/api/agents/:agentId/archive", route(async (request, response) => {
  const agentId = request.params.agentId;
  if (!agentId) {
    response.status(400).json({ error: "agentId is required." });
    return;
  }

  const body = isRecord(request.body) ? request.body : {};
  try {
    response.json(
      await controlPlane.setAgentArchiveStatus({
        agentId,
        archived: typeof body.archived === "boolean" ? body.archived : true,
        ...(typeof body.sessionId === "string" && body.sessionId.trim().length > 0
          ? { sessionId: body.sessionId.trim() }
          : {}),
        ...(adminKeyHeader(request) ? { adminKey: adminKeyHeader(request)! } : {})
      })
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to update agent archive status."
    });
  }
}));

app.post("/api/admin/agents/:agentId/moderation", route(async (request, response) => {
  const agentId = request.params.agentId;
  if (!agentId) {
    response.status(400).json({ error: "agentId is required." });
    return;
  }

  const body = isRecord(request.body) ? request.body : {};
  const availability =
    body.availability === "active" || body.availability === "suspended" || body.availability === "blocked"
      ? body.availability
      : undefined;
  if (!availability) {
    response.status(400).json({ error: "availability must be active, suspended, or blocked." });
    return;
  }

  try {
    response.json(
      await controlPlane.setAgentPlatformModerationStatus({
        agentId,
        availability,
        ...(typeof body.sessionId === "string" && body.sessionId.trim().length > 0
          ? { sessionId: body.sessionId.trim() }
          : {}),
        ...(typeof body.reason === "string" && body.reason.trim().length > 0
          ? { reason: body.reason.trim() }
          : {})
      })
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to update agent moderation status."
    });
  }
}));

app.delete("/api/admin/agents/:agentId", route(async (request, response) => {
  const agentId = request.params.agentId;
  if (!agentId) {
    response.status(400).json({ error: "agentId is required." });
    return;
  }

  const body = isRecord(request.body) ? request.body : {};
  try {
    response.json(
      await controlPlane.deleteAgentRegistration({
        agentId,
        ...(typeof body.sessionId === "string" && body.sessionId.trim().length > 0
          ? { sessionId: body.sessionId.trim() }
          : {}),
        ...(typeof body.reason === "string" && body.reason.trim().length > 0
          ? { reason: body.reason.trim() }
          : {})
      })
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to delete agent registration."
    });
  }
}));

app.get("/api/social/anchors", route(async (request, response) => {
  const sessionId = queryString(request.query, "sessionId");
  const agentId = queryString(request.query, "agentId");
  if (!sessionId && !agentId) {
    response.status(400).json({ error: "sessionId or agentId is required." });
    return;
  }

  try {
    response.json(
      await controlPlane.getOwnedSocialAnchorQueueState({
        ...(sessionId ? { sessionId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(adminKeyHeader(request) ? { adminKey: adminKeyHeader(request)! } : {})
      })
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load social anchor queue."
    });
  }
}));

app.get("/api/social/anchors/public", route(async (request, response) => {
  const limit = queryBoundedInteger(request.query, "limit", 100, 1, 100);
  const { payload, cacheStatus } = await cachedPublicRead(
    `social-anchors-public:${limit}`,
    () => controlPlane.getSocialAnchorQueueState(undefined, {
      itemLimit: limit,
      batchLimit: 20,
      statuses: ["confirmed"],
      kinds: PUBLIC_SOCIAL_ANCHOR_FEED_KINDS
    })
  );
  response.set("x-santaclawz-cache", cacheStatus);
  response.json(payload);
}));

app.get("/api/social/anchors/export", route(async (request, response) => {
  const sessionId = queryString(request.query, "sessionId");
  const agentId = queryString(request.query, "agentId");
  if (!sessionId && !agentId) {
    response.status(400).json({ error: "sessionId or agentId is required." });
    return;
  }

  try {
    response.json(
      await controlPlane.exportSocialAnchorBatch({
        ...(sessionId ? { sessionId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(adminKeyHeader(request) ? { adminKey: adminKeyHeader(request)! } : {})
      })
    );
  } catch (error) {
    response.status(error instanceof SelfServeSocialAnchoringDisabledError ? 403 : 400).json({
      error: error instanceof Error ? error.message : "Unable to export social anchor batch."
    });
  }
}));

app.get("/api/social/anchors/:anchorCandidateId", route(async (request, response) => {
  const anchorCandidateId = request.params.anchorCandidateId;
  if (!anchorCandidateId) {
    response.status(400).json({ error: "anchorCandidateId is required." });
    return;
  }

  try {
    const { payload, cacheStatus } = await cachedPublicRead(
      `social-anchor-candidate:${anchorCandidateId}`,
      () => controlPlane.getSocialAnchorCandidate(anchorCandidateId)
    );
    response.set("x-santaclawz-cache", cacheStatus);
    response.json(payload);
  } catch (error) {
    response.status(404).json({
      error: error instanceof Error ? error.message : "Unable to load social anchor candidate."
    });
  }
}));

app.post("/api/social/anchors/settle", route(async (request, response) => {
  const body = isRecord(request.body) ? request.body : {};
  try {
    const sessionId = optionalString(body.sessionId) ?? queryString(request.query, "sessionId");
    const agentId = optionalString(body.agentId) ?? queryString(request.query, "agentId");
    response.json(
      await controlPlane.settleSocialAnchorBatch({
        ...(sessionId ? { sessionId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
        ...(typeof body.localOnly === "boolean" ? { localOnly: body.localOnly } : {}),
        ...(typeof body.txHash === "string" ? { txHash: body.txHash } : {}),
        ...(typeof body.operatorNote === "string" ? { operatorNote: body.operatorNote } : {}),
        ...(adminKeyHeader(request) ? { adminKey: adminKeyHeader(request)! } : {})
      })
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to settle social anchor batch."
    });
  }
}));

app.post("/api/social/anchors/commit", route(async (request, response) => {
  const body = isRecord(request.body) ? request.body : {};
  try {
    const sessionId = optionalString(body.sessionId) ?? queryString(request.query, "sessionId");
    const agentId = optionalString(body.agentId) ?? queryString(request.query, "agentId");
    response.json(
      await controlPlane.commitExternalSocialAnchorBatch({
        ...(sessionId ? { sessionId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
        ...(typeof body.txHash === "string" ? { txHash: body.txHash } : {}),
        ...(typeof body.expectedBatchId === "string" ? { expectedBatchId: body.expectedBatchId } : {}),
        ...(typeof body.expectedRootDigestSha256 === "string"
          ? { expectedRootDigestSha256: body.expectedRootDigestSha256 }
          : {}),
        ...(typeof body.operatorNote === "string" ? { operatorNote: body.operatorNote } : {}),
        ...(adminKeyHeader(request) ? { adminKey: adminKeyHeader(request)! } : {})
      })
    );
  } catch (error) {
    response.status(error instanceof SelfServeSocialAnchoringDisabledError ? 403 : 400).json({
      error: error instanceof Error ? error.message : "Unable to commit external social anchor batch."
    });
  }
}));

app.post("/api/wallet/sponsor", route(async (request, response) => {
  const body = parseSponsorRequest(request.body ?? null);
  const resolvedSessionId = optionalString(body.sessionId) ?? queryString(request.query, "sessionId");
  response.json(
    await controlPlane.sponsorWallet({
      ...(adminKeyHeader(request) ? { adminKey: adminKeyHeader(request)! } : {}),
      ...(typeof body.amountMina === "string" ? { amountMina: body.amountMina } : {}),
      ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
      ...(body.purpose === "onboarding" || body.purpose === "top-up" || body.purpose === "publish"
        ? { purpose: body.purpose }
        : {})
    })
  );
}));

app.get("/api/wallet/sponsor/queue", route(async (request, response) => {
  response.json(await controlPlane.listSponsorQueue(queryString(request.query, "sessionId")));
}));

app.post("/api/wallet/recovery/prepare", route(async (request, response) => {
  const body = parseRecoveryRequest(request.body ?? null);
  response.json(
    await controlPlane.prepareRecoveryKit(
      optionalString(body.sessionId) ?? queryString(request.query, "sessionId"),
      adminKeyHeader(request)
    )
  );
}));

app.post(
  "/api/privacy-exceptions/:id/approve",
  route(async (request, response) => {
    const body = parsePrivacyExceptionApproval(request.body ?? null);
    const exceptionId = request.params.id;
    if (!exceptionId) {
      response.status(400).json({ error: "privacy exception id is required." });
      return;
    }

    const rawActorRole = body.actorRole;
    const actorRole: PrivacyApprovalRecord["actorRole"] | undefined =
      rawActorRole === "operator" ||
      rawActorRole === "tenant-admin" ||
      rawActorRole === "compliance-reviewer" ||
      rawActorRole === "workspace-member"
        ? rawActorRole
        : undefined;

    try {
      response.json(
        await controlPlane.approvePrivacyException(
          exceptionId,
          typeof body.actorId === "string" ? body.actorId : undefined,
          actorRole,
          typeof body.note === "string" ? body.note : undefined,
          optionalString(body.sessionId) ?? queryString(request.query, "sessionId")
        )
      );
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : "Unable to approve privacy exception."
      });
    }
  })
);

app.post("/api/events/ingest", route(async (request, response) => {
  try {
    const event = await controlPlane.ingestEvent(request.body ?? null);
    response.status(202).json({
      accepted: true,
      event
    });
  } catch (error) {
    response.status(400).json({
      accepted: false,
      error: error instanceof Error ? error.message : "Invalid event payload."
    });
  }
}));

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function parseBoundedIntegerEnv(name: string, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(parsed, max));
}

const RELAY_RESPONSE_TIMEOUT_MS =
  parseBoundedIntegerEnv("CLAWZ_AGENT_RELAY_RESPONSE_TIMEOUT_MS", 120_000, 15_000, 300_000);
const RELAY_MESSAGE_MAX_BYTES = 192 * 1024;
const RELAY_HEARTBEAT_GRACE_MS =
  Number.parseInt(process.env.CLAWZ_AGENT_RELAY_HEARTBEAT_GRACE_MS ?? "", 10) || 45_000;
const RELAY_STALE_SWEEP_MS = Math.max(250, Math.min(10_000, Math.floor(RELAY_HEARTBEAT_GRACE_MS / 3)));
const RELAY_POST_MESSAGE_WINDOW_MS =
  Number.parseInt(process.env.CLAWZ_AGENT_RELAY_POST_MESSAGE_WINDOW_MS ?? "", 10) || 60_000;
const RELAY_POST_MESSAGE_LIMIT_PER_AGENT =
  Number.parseInt(process.env.CLAWZ_AGENT_RELAY_POST_MESSAGE_LIMIT_PER_AGENT ?? "", 10) || 12;
const RELAY_POST_MESSAGE_LIMIT_PER_OPERATOR =
  Number.parseInt(process.env.CLAWZ_AGENT_RELAY_POST_MESSAGE_LIMIT_PER_OPERATOR ?? "", 10) || 40;
const RELAY_POST_MESSAGE_LIMIT_PER_SWARM =
  Number.parseInt(process.env.CLAWZ_AGENT_RELAY_POST_MESSAGE_LIMIT_PER_SWARM ?? "", 10) || 60;

function websocketAcceptKey(key: string) {
  return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

function encodeWebSocketFrame(opcode: number, payload: Buffer) {
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
  const header = Buffer.alloc(headerLength);
  header[0] = 0x80 | opcode;
  if (length < 126) {
    header[1] = length;
  } else if (length <= 0xffff) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function printableFramePreview(value: string, maxLength = 80) {
  return value
    .slice(0, maxLength)
    .replace(/[^\t\n\r -~]/g, "�");
}

function extractAdminKeyFromUpgrade(request: IncomingMessage) {
  const direct = request.headers["x-clawz-admin-key"];
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }
  const authorization = request.headers.authorization;
  const bearerPrefix = "bearer ";
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith(bearerPrefix)) {
    return authorization.slice(bearerPrefix.length).trim();
  }
  return undefined;
}

type RelayPendingRequest = {
  resolve(value: {
    statusCode: number;
    body: string;
    deliveryTarget: string;
    relayMessageId: string;
    requestId?: string;
    requestBodyDigestSha256?: string;
    workerStatusCode?: number;
    workerResponseBytes?: number;
    workerResponseDigestSha256?: string;
    relayBodyBytes?: number;
    relayBodyDigestSha256?: string;
    relayTrace?: HireRelayTraceStep[];
  }): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
  trace: HireRelayTraceStep[];
  requestId?: string;
  requestBodyDigestSha256?: string;
};

type RelayRateLimitBucket = {
  count: number;
  resetAtMs: number;
};

function relayRequestIdFromSignedBody(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    const direct = parsed.request_id ?? parsed.requestId;
    return typeof direct === "string" && direct.trim().length > 0 ? direct.trim().slice(0, 96) : undefined;
  } catch {
    return undefined;
  }
}

class RelayMessageRateLimiter {
  private readonly buckets = new Map<string, RelayRateLimitBucket>();

  assertAllowed(input: {
    agentId: string;
    operatorKey: string;
    swarmId?: string;
  }) {
    const operatorDigest = createHash("sha256").update(input.operatorKey).digest("hex").slice(0, 24);
    this.consume(`agent:${input.agentId}`, RELAY_POST_MESSAGE_LIMIT_PER_AGENT);
    this.consume(`operator:${operatorDigest}`, RELAY_POST_MESSAGE_LIMIT_PER_OPERATOR);
    if (input.swarmId) {
      this.consume(`swarm:${input.swarmId}`, RELAY_POST_MESSAGE_LIMIT_PER_SWARM);
    }
  }

  private consume(key: string, limit: number) {
    const nowMs = Date.now();
    const existing = this.buckets.get(key);
    const bucket =
      existing && existing.resetAtMs > nowMs
        ? existing
        : {
            count: 0,
            resetAtMs: nowMs + RELAY_POST_MESSAGE_WINDOW_MS
          };
    bucket.count += 1;
    this.buckets.set(key, bucket);
    if (bucket.count > limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAtMs - nowMs) / 1000));
      throw new Error(`Relay post_message rate limit exceeded. Retry after ${retryAfterSeconds}s.`);
    }

    if (this.buckets.size > 2000) {
      for (const [bucketKey, value] of this.buckets.entries()) {
        if (value.resetAtMs <= nowMs) {
          this.buckets.delete(bucketKey);
        }
      }
    }
  }
}

class AgentRelayConnection {
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, RelayPendingRequest>();
  private readonly recentlyResolvedMessageIds = new Set<string>();
  private closed = false;
  private lastHeartbeatAtMs = Date.now();
  private invalidJsonFrames = 0;
  readonly connectedAtIso = new Date().toISOString();

  constructor(
    readonly connectionId: string,
    readonly agentId: string,
    readonly sessionId: string,
    readonly adminKey: string,
    private readonly socket: Socket,
    private readonly onMessage: (message: unknown) => void,
    private readonly onClose: () => void
  ) {
    socket.on("data", (chunk) => {
      this.receive(chunk);
    });
    socket.on("close", () => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.rejectPending("Relay connection closed.");
      this.onClose();
    });
    socket.on("error", () => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.rejectPending("Relay connection errored.");
      this.onClose();
    });
  }

  get connected() {
    return !this.socket.destroyed;
  }

  get heartbeatAgeMs() {
    return Date.now() - this.lastHeartbeatAtMs;
  }

  get pendingCount() {
    return this.pending.size;
  }

  get remoteAddress() {
    return (this.socket as unknown as { remoteAddress?: string }).remoteAddress;
  }

  markHeartbeat() {
    this.lastHeartbeatAtMs = Date.now();
  }

  isFresh(nowMs = Date.now()) {
    return this.connected && nowMs - this.lastHeartbeatAtMs <= RELAY_HEARTBEAT_GRACE_MS;
  }

  sendJson(payload: unknown) {
    if (!this.connected) {
      throw new Error("Relay connection is closed.");
    }
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    this.socket.write(encodeWebSocketFrame(0x1, body));
  }

  sendPong(payload: Buffer) {
    if (this.connected) {
      this.socket.write(encodeWebSocketFrame(0xA, payload));
    }
  }

  close(code = 1000, reason = "closing") {
    if (!this.connected) {
      return;
    }
    const reasonBuffer = Buffer.from(reason.slice(0, 120), "utf8");
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    this.socket.write(encodeWebSocketFrame(0x8, payload));
    this.socket.end();
  }

  terminate(reason = "Relay heartbeat stale.") {
    if (!this.connected) {
      return;
    }
    this.rejectPending(reason);
    this.socket.destroy();
  }

  async deliverHire(input: {
    signedRequest: {
      ingressUrl: string;
      requestKind: string;
      body: string;
      bodyDigestSha256: string;
      headers: Record<string, string>;
    };
  }) {
    const messageId = `relay_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
    const requestId = relayRequestIdFromSignedBody(input.signedRequest.body);
    const requestBodyDigestSha256 = input.signedRequest.bodyDigestSha256;
    return new Promise<{
      statusCode: number;
      body: string;
      deliveryTarget: string;
      relayMessageId: string;
      requestId?: string;
      requestBodyDigestSha256?: string;
      relayTrace?: HireRelayTraceStep[];
    }>((resolve, reject) => {
      const trace: HireRelayTraceStep[] = [];
      const timeout = setTimeout(() => {
        this.pending.delete(messageId);
        const sawWorker = trace.some((entry) => entry.step === "worker_ack" || entry.step === "received_by_worker");
        const error = new Error(
          sawWorker
            ? "Timed out waiting for agent relay response after worker acknowledgement."
            : "Timed out waiting for agent relay response."
        ) as Error & {
          code?: string;
          relayTrace?: HireRelayTraceStep[];
          relayMessageId?: string;
          requestId?: string;
          requestBodyDigestSha256?: string;
          platformRelayTimeoutMs?: number;
        };
        error.code = sawWorker ? "relay_return_timeout_after_worker_ack" : "relay_return_timeout";
        error.relayMessageId = messageId;
        if (requestId) {
          error.requestId = requestId;
        }
        error.requestBodyDigestSha256 = requestBodyDigestSha256;
        error.platformRelayTimeoutMs = RELAY_RESPONSE_TIMEOUT_MS;
        trace.push({
          step: "relay_returned",
          status: "failed",
          occurredAtIso: new Date().toISOString(),
          relayMessageId: messageId,
          ...(requestId ? { requestId } : {}),
          requestBodyDigestSha256,
          platformTimeoutMs: RELAY_RESPONSE_TIMEOUT_MS,
          detail: [
            error.message,
            `code ${error.code}`,
            requestId ? `request ${requestId}` : "",
            `platform timeout ${RELAY_RESPONSE_TIMEOUT_MS}ms`
          ].filter(Boolean).join("; ")
        });
        error.relayTrace = trace;
        reject(error);
      }, RELAY_RESPONSE_TIMEOUT_MS);
      this.pending.set(messageId, {
        resolve,
        reject,
        timeout,
        trace,
        ...(requestId ? { requestId } : {}),
        requestBodyDigestSha256
      });
      try {
        this.sendJson({
          type: "hire_request",
          messageId,
          ...(requestId ? { requestId } : {}),
          requestBodyDigestSha256,
          request: {
            method: "POST",
            url: input.signedRequest.ingressUrl,
            requestKind: input.signedRequest.requestKind,
            headers: input.signedRequest.headers,
            body: input.signedRequest.body,
            bodyDigestSha256: input.signedRequest.bodyDigestSha256
          }
        });
        trace.push({
          step: "sent_to_relay",
          status: "completed",
          occurredAtIso: new Date().toISOString(),
          relayMessageId: messageId,
          detail: input.signedRequest.requestKind
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(messageId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  handleAck(message: Record<string, unknown>) {
    const messageId = typeof message.messageId === "string" ? message.messageId : "";
    const pending = this.pending.get(messageId);
    if (!pending) {
      return;
    }
    pending.trace.push({
      step: "worker_ack",
      status: "completed",
      occurredAtIso: typeof message.receivedAtIso === "string" ? message.receivedAtIso : new Date().toISOString(),
      relayMessageId: messageId,
      detail: [
        typeof message.localHireUrl === "string" ? message.localHireUrl : "worker acknowledged relay hire request",
        typeof message.relayAgentProtocolVersion === "string" ? message.relayAgentProtocolVersion : "",
        typeof message.relayAgentBuild === "string" ? `build ${message.relayAgentBuild.slice(0, 12)}` : ""
      ].filter(Boolean).join("; ")
    });
  }

  handleProgress(message: Record<string, unknown>) {
    const messageId = typeof message.messageId === "string" ? message.messageId : "";
    const pending = this.pending.get(messageId);
    if (!pending) {
      console.error(JSON.stringify({
        event: "relay_worker_progress_without_pending_request",
        agentId: this.agentId,
        connectionId: this.connectionId,
        messageId,
        requestId: typeof message.requestId === "string" ? message.requestId.slice(0, 96) : undefined,
        step: typeof message.step === "string" ? message.step.slice(0, 96) : undefined
      }));
      return;
    }
    const step = [
      "received_by_worker",
      "worker_http_request_started",
      "worker_http_response_received",
      "worker_return_parse_started",
      "worker_return_json_parse_completed",
      "worker_return_schema_validation_completed",
      "relay_response_compacted",
      "worker_return_parse_completed",
      "hire_response_prepared"
    ].includes(String(message.step))
      ? message.step as HireRelayTraceStep["step"]
      : undefined;
    if (!step) {
      return;
    }
    const requestId = typeof message.requestId === "string" && message.requestId.trim().length > 0
      ? message.requestId.trim().slice(0, 96)
      : pending.requestId;
    const requestBodyDigestSha256 =
      typeof message.requestBodyDigestSha256 === "string" && /^[a-f0-9]{64}$/i.test(message.requestBodyDigestSha256)
        ? message.requestBodyDigestSha256.toLowerCase()
        : pending.requestBodyDigestSha256;
    const workerStatusCode = typeof message.workerStatusCode === "number" && Number.isFinite(message.workerStatusCode)
      ? Math.round(message.workerStatusCode)
      : undefined;
    const workerResponseBytes = typeof message.workerResponseBytes === "number" && Number.isFinite(message.workerResponseBytes)
      ? Math.round(message.workerResponseBytes)
      : undefined;
    const workerResponseDigestSha256 =
      typeof message.workerResponseDigestSha256 === "string" && /^[a-f0-9]{64}$/i.test(message.workerResponseDigestSha256)
        ? message.workerResponseDigestSha256.toLowerCase()
        : undefined;
    const relayBodyBytes = typeof message.relayBodyBytes === "number" && Number.isFinite(message.relayBodyBytes)
      ? Math.round(message.relayBodyBytes)
      : undefined;
    const relayBodyDigestSha256 =
      typeof message.relayBodyDigestSha256 === "string" && /^[a-f0-9]{64}$/i.test(message.relayBodyDigestSha256)
        ? message.relayBodyDigestSha256.toLowerCase()
        : undefined;
    const elapsedMs = typeof message.elapsedMs === "number" && Number.isFinite(message.elapsedMs)
      ? Math.round(message.elapsedMs)
      : undefined;
    const localTimeoutMs = typeof message.localHireTimeoutMs === "number" && Number.isFinite(message.localHireTimeoutMs)
      ? Math.round(message.localHireTimeoutMs)
      : undefined;
    pending.trace.push({
      step,
      status: message.status === "failed" ? "failed" : "completed",
      occurredAtIso: typeof message.occurredAtIso === "string" ? message.occurredAtIso : new Date().toISOString(),
      relayMessageId: messageId,
      ...(requestId ? { requestId } : {}),
      ...(requestBodyDigestSha256 ? { requestBodyDigestSha256 } : {}),
      ...(workerStatusCode !== undefined ? { workerStatusCode } : {}),
      ...(workerResponseBytes !== undefined ? { workerResponseBytes } : {}),
      ...(workerResponseDigestSha256 ? { workerResponseDigestSha256 } : {}),
      ...(relayBodyBytes !== undefined ? { relayBodyBytes } : {}),
      ...(relayBodyDigestSha256 ? { relayBodyDigestSha256 } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(localTimeoutMs !== undefined ? { localTimeoutMs } : {}),
      platformTimeoutMs: RELAY_RESPONSE_TIMEOUT_MS,
      detail: [
        typeof message.detail === "string" ? message.detail : "",
        typeof message.relayAgentProtocolVersion === "string" ? message.relayAgentProtocolVersion : "",
        typeof message.relayAgentBuild === "string" ? `build ${message.relayAgentBuild.slice(0, 12)}` : "",
        localTimeoutMs !== undefined ? `timeout ${localTimeoutMs}ms` : "",
        workerStatusCode !== undefined ? `worker status ${workerStatusCode}` : "",
        workerResponseBytes !== undefined ? `worker bytes ${workerResponseBytes}` : "",
        relayBodyBytes !== undefined ? `relay bytes ${relayBodyBytes}` : ""
      ].filter(Boolean).join("; ")
    });
    const preparedResponseBody =
      typeof message.preparedResponseBodyBase64 === "string" && message.preparedResponseBodyBase64.trim().length > 0
        ? Buffer.from(message.preparedResponseBodyBase64, "base64").toString("utf8").slice(0, RELAY_MESSAGE_MAX_BYTES)
        : undefined;
    const preparedResponseDigestSha256 = preparedResponseBody
      ? createHash("sha256").update(preparedResponseBody).digest("hex")
      : undefined;
    const preparedDigestFromMessage = validSha256(message.preparedResponseBodyDigestSha256);
    const preparedDigestMatches =
      Boolean(preparedResponseBody) &&
      (!relayBodyDigestSha256 || relayBodyDigestSha256 === preparedResponseDigestSha256) &&
      (!preparedDigestFromMessage || preparedDigestFromMessage === preparedResponseDigestSha256);
    if (preparedResponseBody) {
      console.error(JSON.stringify({
        event: "relay_hire_response_prepared_progress_received",
        agentId: this.agentId,
        connectionId: this.connectionId,
        messageId,
        requestId,
        step,
        preparedResponseBodyBytes: Buffer.byteLength(preparedResponseBody, "utf8"),
        preparedResponseDigestSha256,
        preparedDigestFromMessage,
        relayBodyDigestSha256,
        preparedDigestMatches,
        pendingFound: true
      }));
    }
    if (
      preparedResponseBody &&
      preparedDigestMatches
    ) {
      if (step !== "hire_response_prepared" && !pending.trace.some((entry) => entry.step === "hire_response_prepared")) {
        pending.trace.push({
          step: "hire_response_prepared",
          status: "completed",
          occurredAtIso: new Date().toISOString(),
          relayMessageId: messageId,
          ...(requestId ? { requestId } : {}),
          ...(requestBodyDigestSha256 ? { requestBodyDigestSha256 } : {}),
          ...(workerStatusCode !== undefined ? { workerStatusCode } : {}),
          ...(workerResponseBytes !== undefined ? { workerResponseBytes } : {}),
          ...(workerResponseDigestSha256 ? { workerResponseDigestSha256 } : {}),
          ...(relayBodyBytes !== undefined ? { relayBodyBytes } : {}),
          ...(relayBodyDigestSha256 ? { relayBodyDigestSha256 } : {}),
          ...(elapsedMs !== undefined ? { elapsedMs } : {}),
          ...(localTimeoutMs !== undefined ? { localTimeoutMs } : {}),
          platformTimeoutMs: RELAY_RESPONSE_TIMEOUT_MS,
          detail: `prepared response carried by ${step} progress frame`
        });
      }
      this.handleResponse({
        type: "hire_response",
        messageId,
        ...(requestId ? { requestId } : {}),
        ...(requestBodyDigestSha256 ? { requestBodyDigestSha256 } : {}),
        statusCode: typeof message.preparedResponseStatusCode === "number" && Number.isFinite(message.preparedResponseStatusCode)
          ? Math.round(message.preparedResponseStatusCode)
          : workerStatusCode ?? 200,
        bodyBase64: Buffer.from(preparedResponseBody, "utf8").toString("base64"),
        bodyEncoding: "base64",
        ...(workerStatusCode !== undefined ? { workerStatusCode } : {}),
        ...(workerResponseBytes !== undefined ? { workerResponseBytes } : {}),
        ...(workerResponseDigestSha256 ? { workerResponseDigestSha256 } : {}),
        ...(relayBodyBytes !== undefined ? { relayBodyBytes } : {}),
        ...(relayBodyDigestSha256 ? { relayBodyDigestSha256 } : {})
      });
    } else if (preparedResponseBody) {
      console.error(JSON.stringify({
        event: "relay_hire_response_prepared_progress_rejected",
        agentId: this.agentId,
        connectionId: this.connectionId,
        messageId,
        requestId,
        step,
        preparedResponseDigestSha256,
        preparedDigestFromMessage,
        relayBodyDigestSha256,
        reason: "prepared_response_digest_mismatch"
      }));
    }
  }

  handleResponse(message: Record<string, unknown>) {
    const messageId = typeof message.messageId === "string" ? message.messageId : "";
    const pending = this.pending.get(messageId);
    if (!pending) {
      return this.recentlyResolvedMessageIds.has(messageId);
    }
    if (messageId) {
      this.recentlyResolvedMessageIds.add(messageId);
      const forgetResolvedMessageId = setTimeout(() => {
        this.recentlyResolvedMessageIds.delete(messageId);
      }, Math.max(10_000, RELAY_RESPONSE_TIMEOUT_MS));
      (forgetResolvedMessageId as unknown as { unref?: () => void }).unref?.();
    }
    this.pending.delete(messageId);
    clearTimeout(pending.timeout);
    const responseRequestId = typeof message.requestId === "string" && message.requestId.trim().length > 0
      ? message.requestId.trim().slice(0, 96)
      : pending.requestId;
    const requestIdMismatched = Boolean(
      pending.requestId &&
        responseRequestId &&
        pending.requestId !== responseRequestId
    );
    const statusCode = typeof message.statusCode === "number" && Number.isFinite(message.statusCode)
      ? Math.round(message.statusCode)
      : 502;
    const body =
      message.bodyEncoding === "base64" && typeof message.bodyBase64 === "string"
        ? Buffer.from(message.bodyBase64, "base64").toString("utf8").slice(0, RELAY_MESSAGE_MAX_BYTES)
        : typeof message.body === "string"
          ? message.body.slice(0, RELAY_MESSAGE_MAX_BYTES)
          : "";
    const workerStatusCode = typeof message.workerStatusCode === "number" && Number.isFinite(message.workerStatusCode)
      ? Math.round(message.workerStatusCode)
      : undefined;
    const workerResponseBytes = typeof message.workerResponseBytes === "number" && Number.isFinite(message.workerResponseBytes)
      ? Math.round(message.workerResponseBytes)
      : undefined;
    const workerResponseDigestSha256 =
      typeof message.workerResponseDigestSha256 === "string" && /^[a-f0-9]{64}$/i.test(message.workerResponseDigestSha256)
        ? message.workerResponseDigestSha256.toLowerCase()
        : undefined;
    const relayBodyBytes = typeof message.relayBodyBytes === "number" && Number.isFinite(message.relayBodyBytes)
      ? Math.round(message.relayBodyBytes)
      : undefined;
    const relayBodyDigestSha256 =
      typeof message.relayBodyDigestSha256 === "string" && /^[a-f0-9]{64}$/i.test(message.relayBodyDigestSha256)
        ? message.relayBodyDigestSha256.toLowerCase()
        : undefined;
    pending.trace.push({
      step: "worker_completed",
      status: statusCode >= 200 && statusCode < 300 && !requestIdMismatched ? "completed" : "failed",
      occurredAtIso: new Date().toISOString(),
      relayMessageId: messageId,
      ...(responseRequestId ? { requestId: responseRequestId } : {}),
      ...(pending.requestBodyDigestSha256 ? { requestBodyDigestSha256: pending.requestBodyDigestSha256 } : {}),
      ...(workerStatusCode !== undefined ? { workerStatusCode } : {}),
      ...(workerResponseBytes !== undefined ? { workerResponseBytes } : {}),
      ...(workerResponseDigestSha256 ? { workerResponseDigestSha256 } : {}),
      ...(relayBodyBytes !== undefined ? { relayBodyBytes } : {}),
      ...(relayBodyDigestSha256 ? { relayBodyDigestSha256 } : {}),
      platformTimeoutMs: RELAY_RESPONSE_TIMEOUT_MS,
      detail: [
        `relay status ${statusCode}`,
        responseRequestId ? `request ${responseRequestId}` : "",
        requestIdMismatched ? `request mismatch expected ${pending.requestId}` : "",
        workerStatusCode !== undefined ? `worker status ${workerStatusCode}` : "",
        workerResponseBytes !== undefined ? `worker bytes ${workerResponseBytes}` : "",
        relayBodyBytes !== undefined ? `relay bytes ${relayBodyBytes}` : ""
      ].filter(Boolean).join("; ")
    });
    pending.trace.push({
      step: requestIdMismatched ? "hire_response_rejected_by_api" : "hire_response_acknowledged_by_api",
      status: requestIdMismatched ? "failed" : "completed",
      occurredAtIso: new Date().toISOString(),
      relayMessageId: messageId,
      ...(responseRequestId ? { requestId: responseRequestId } : {}),
      ...(pending.requestBodyDigestSha256 ? { requestBodyDigestSha256: pending.requestBodyDigestSha256 } : {}),
      ...(relayBodyBytes !== undefined ? { relayBodyBytes } : {}),
      ...(relayBodyDigestSha256 ? { relayBodyDigestSha256 } : {}),
      platformTimeoutMs: RELAY_RESPONSE_TIMEOUT_MS,
      detail: requestIdMismatched ? `request mismatch expected ${pending.requestId}` : "hire_response received and correlated"
    });
    pending.trace.push({
      step: "relay_returned",
      status: "completed",
      occurredAtIso: new Date().toISOString(),
      relayMessageId: messageId,
      ...(responseRequestId ? { requestId: responseRequestId } : {}),
      ...(pending.requestBodyDigestSha256 ? { requestBodyDigestSha256: pending.requestBodyDigestSha256 } : {}),
      platformTimeoutMs: RELAY_RESPONSE_TIMEOUT_MS
    });
    pending.resolve({
      statusCode,
      body,
      deliveryTarget: `santaclawz-relay://agent/${encodeURIComponent(this.agentId)}`,
      relayMessageId: messageId,
      ...(responseRequestId ? { requestId: responseRequestId } : {}),
      ...(pending.requestBodyDigestSha256 ? { requestBodyDigestSha256: pending.requestBodyDigestSha256 } : {}),
      ...(workerStatusCode !== undefined ? { workerStatusCode } : {}),
      ...(workerResponseBytes !== undefined ? { workerResponseBytes } : {}),
      ...(workerResponseDigestSha256 ? { workerResponseDigestSha256 } : {}),
      ...(relayBodyBytes !== undefined ? { relayBodyBytes } : {}),
      ...(relayBodyDigestSha256 ? { relayBodyDigestSha256 } : {}),
      relayTrace: pending.trace
    });
    return true;
  }

  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let offset = 2;
      let payloadLength = second & 0x7f;
      if (payloadLength === 126) {
        if (this.buffer.length < offset + 2) {
          return;
        }
        payloadLength = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.buffer.length < offset + 8) {
          return;
        }
        const bigLength = this.buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(RELAY_MESSAGE_MAX_BYTES)) {
          this.close(1009, "message too large");
          return;
        }
        payloadLength = Number(bigLength);
        offset += 8;
      }
      const maskOffset = offset;
      if (masked) {
        offset += 4;
      }
      if (payloadLength > RELAY_MESSAGE_MAX_BYTES) {
        this.close(1009, "message too large");
        return;
      }
      if (this.buffer.length < offset + payloadLength) {
        return;
      }
      const mask = masked ? this.buffer.subarray(maskOffset, maskOffset + 4) : undefined;
      const frame = this.buffer.subarray(offset, offset + payloadLength);
      this.buffer = this.buffer.subarray(offset + payloadLength);
      const payload = Buffer.from(frame);
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] = payload[index]! ^ mask[index % 4]!;
        }
      }
      if (opcode === 0x8) {
        const closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        const closeReason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "closed";
        this.rejectPending(`Relay socket closed with code=${closeCode} reason=${closeReason || "closed"}.`);
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.sendPong(payload);
        continue;
      }
      if (opcode !== 0x1) {
        continue;
      }
      try {
        this.onMessage(JSON.parse(payload.toString("utf8")));
        this.invalidJsonFrames = 0;
      } catch (error) {
        this.invalidJsonFrames += 1;
        let decoded = "";
        let utf8Decoded = true;
        try {
          decoded = new TextDecoder("utf-8", { fatal: true }).decode(payload);
        } catch {
          utf8Decoded = false;
          decoded = payload.toString("utf8");
        }
        const activePending = [...this.pending.entries()].map(([messageId, pending]) => ({
          messageId,
          ...(pending.requestId ? { requestId: pending.requestId } : {}),
          requestBodyDigestSha256: pending.requestBodyDigestSha256,
          lastStep: pending.trace.at(-1)?.step,
          sawWorker: pending.trace.some((entry) =>
            entry.step === "worker_ack" ||
            entry.step === "received_by_worker" ||
            entry.step === "worker_return_parse_completed" ||
            entry.step === "hire_response_prepared"
          )
        }));
        const workerReached = activePending.some((entry) => entry.sawWorker);
        console.error(JSON.stringify({
          event: "relay_invalid_json",
          agentId: this.agentId,
          connectionId: this.connectionId,
          opcode,
          payloadBytes: payload.length,
          payloadDigestSha256: createHash("sha256").update(payload.toString("base64")).digest("hex"),
          utf8Decoded,
          payloadFirst80: printableFramePreview(decoded, 80),
          payloadLast80: printableFramePreview(decoded.slice(Math.max(0, decoded.length - 80)), 80),
          invalidJsonFrames: this.invalidJsonFrames,
          parseError: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
          activePending
        }));
        if (this.invalidJsonFrames >= 3) {
          if (workerReached) {
            console.error(JSON.stringify({
              event: "relay_repeated_invalid_json_after_worker_progress",
              agentId: this.agentId,
              connectionId: this.connectionId,
              invalidJsonFrames: this.invalidJsonFrames,
              activePending
            }));
            continue;
          }
          this.rejectPending("Relay sent repeated invalid JSON while SantaClawz was waiting for the agent response.");
          this.close(1003, "repeated invalid json");
        }
        return;
      }
    }
  }

  private rejectPending(message: string) {
    for (const [messageId, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      this.pending.delete(messageId);
    }
  }
}

class AgentRelayHub {
  private readonly connectionsByAgent = new Map<string, AgentRelayConnection[]>();
  private readonly staleSweepInterval: ReturnType<typeof setInterval>;
  private readonly messageRateLimiter = new RelayMessageRateLimiter();

  constructor(private readonly plane: ClawzControlPlane) {
    this.staleSweepInterval = setInterval(() => {
      this.closeStaleConnections();
    }, RELAY_STALE_SWEEP_MS);
    (this.staleSweepInterval as unknown as { unref?: () => void }).unref?.();
  }

  isConnected(agentId: string) {
    const connection = this.activeConnection(agentId);
    if (!connection) {
      return false;
    }
    if (connection.isFresh()) {
      return true;
    }
    invalidateAgentRuntimeStatusCaches(agentId);
    connection.terminate("Relay heartbeat is stale.");
    return false;
  }

  statusFor(agentId: string) {
    const connections = this.cleanupConnections(agentId);
    const connection = this.activeConnection(agentId);
    const connected = Boolean(connection && connection.isFresh());
    if (connection && !connected) {
      invalidateAgentRuntimeStatusCaches(agentId);
      connection.terminate("Relay heartbeat is stale.");
    }
    return {
      agentId,
      connected,
      status: connected ? "connected" : "waiting",
      checkedAtIso: new Date().toISOString(),
      activeConnectionId: connection?.connectionId ?? null,
      activeConnectedAtIso: connection?.connectedAtIso ?? null,
      connectionCount: connections.length,
      freshConnectionCount: connections.filter((candidate) => candidate.isFresh()).length,
      connections: connections.map((candidate) => ({
        connectionId: candidate.connectionId,
        connectedAtIso: candidate.connectedAtIso,
        heartbeatAgeMs: candidate.heartbeatAgeMs,
        pendingCount: candidate.pendingCount,
        fresh: candidate.isFresh(),
        remoteAddress: candidate.remoteAddress ?? null
      })),
      reason: connected
        ? "SantaClawz relay has an active fresh websocket connection."
        : "SantaClawz relay is waiting for a fresh agent websocket connection."
    };
  }

  async deliverHire(input: {
    agentId: string;
    sessionId: string;
    signedRequest: {
      ingressUrl: string;
      requestKind: string;
      body: string;
      bodyDigestSha256: string;
      headers: Record<string, string>;
    };
  }) {
    const connection = this.activeConnection(input.agentId);
    if (!connection?.connected) {
      throw new Error("SantaClawz relay is waiting for this agent to connect.");
    }
    if (!connection.isFresh()) {
      connection.terminate("Relay heartbeat is stale.");
      throw new Error("SantaClawz relay heartbeat is stale; waiting for the agent to reconnect.");
    }
    return connection.deliverHire({ signedRequest: input.signedRequest });
  }

  private closeStaleConnections() {
    const nowMs = Date.now();
    for (const [agentId, connections] of this.connectionsByAgent.entries()) {
      for (const connection of connections) {
        if (!connection.isFresh(nowMs)) {
          invalidateAgentRuntimeStatusCaches(agentId);
          connection.terminate("Relay heartbeat is stale.");
        }
      }
      this.cleanupConnections(agentId);
    }
  }

  private cleanupConnections(agentId: string) {
    const connections = this.connectionsByAgent.get(agentId) ?? [];
    const active = connections.filter((connection) => connection.connected);
    if (active.length === 0) {
      this.connectionsByAgent.delete(agentId);
      return [];
    }
    this.connectionsByAgent.set(agentId, active);
    return active;
  }

  private activeConnection(agentId: string) {
    const connections = this.cleanupConnections(agentId);
    const fresh = connections.filter((connection) => connection.isFresh());
    fresh.sort((left, right) => {
      if (left.pendingCount !== right.pendingCount) {
        return left.pendingCount - right.pendingCount;
      }
      return right.connectedAtIso.localeCompare(left.connectedAtIso);
    });
    return fresh[0];
  }

  async handleUpgrade(request: IncomingMessage, socket: Socket) {
    const baseUrl = `http://${request.headers.host ?? "localhost"}`;
    const url = new URL(request.url ?? "/", baseUrl);
    if (url.pathname !== "/api/agent-relay/connect") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = request.headers["sec-websocket-key"];
    const agentId = url.searchParams.get("agentId")?.trim() ?? "";
    const adminKey = extractAdminKeyFromUpgrade(request);
    if (typeof key !== "string" || key.length === 0 || !agentId || !adminKey) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    let auth: Awaited<ReturnType<ClawzControlPlane["authenticateAgentRelayConnection"]>>;
    try {
      auth = await this.plane.authenticateAgentRelayConnection({ agentId, adminKey });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /admin key|unauthorized|unknown agent|missing/i.test(message) ? "401 Unauthorized" : "409 Conflict";
      console.error(JSON.stringify({
        event: "relay_handshake_rejected",
        agentId,
        status,
        error: message
      }));
      socket.write(
        [
          `HTTP/1.1 ${status}`,
          "content-type: application/json",
          "cache-control: no-store",
          "connection: close",
          "\r\n",
          JSON.stringify({ ok: false, code: "relay_handshake_rejected", error: message })
        ].join("\r\n")
      );
      socket.destroy();
      return;
    }
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${websocketAcceptKey(key)}`,
        "\r\n"
      ].join("\r\n")
    );
    const existing = this.cleanupConnections(agentId);
    let connection!: AgentRelayConnection;
    const connectionId = `relay_conn_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
    connection = new AgentRelayConnection(
      connectionId,
      auth.agentId,
      auth.sessionId,
      adminKey,
      socket,
      (message) => {
        void this.handleMessage(connection, message);
      },
      () => {
        invalidateAgentRuntimeStatusCaches(agentId);
        const remaining = this.cleanupConnections(agentId).filter((candidate) => candidate !== connection);
        if (remaining.length > 0) {
          this.connectionsByAgent.set(agentId, remaining);
        } else {
          this.connectionsByAgent.delete(agentId);
          void this.plane.recordAgentRuntimeHeartbeat({
            agentId,
            sessionId: auth.sessionId,
            adminKey,
            status: "waiting",
            ttlSeconds: 30,
            note: "SantaClawz relay disconnected."
          }).catch(() => undefined);
        }
      }
    );
    connection.markHeartbeat();
    this.connectionsByAgent.set(agentId, [...existing, connection]);
    invalidateAgentRuntimeStatusCaches(agentId);
    if (existing.length > 0) {
      console.error(JSON.stringify({
        event: "relay_additional_connection",
        agentId,
        connectionId,
        existingConnectionIds: existing.map((candidate) => candidate.connectionId),
        note: "Accepted additional relay connection without evicting the existing socket. Delivery will use the freshest connection with the fewest pending jobs."
      }));
    }
    void this.plane.recordAgentRuntimeHeartbeat({
      agentId,
      sessionId: auth.sessionId,
      adminKey,
      status: "live",
      ttlSeconds: 30,
      note: "SantaClawz relay connected."
    }).catch((error) => {
      console.error(JSON.stringify({
        event: "relay_connected_heartbeat_record_failed",
        agentId,
        connectionId,
        error: error instanceof Error ? error.message : String(error)
      }));
    });
    connection.sendJson({
      type: "relay_ready",
      agentId: auth.agentId,
      sessionId: auth.sessionId,
      serviceKey: auth.serviceKey,
      connectionId
    });
  }

  private async handleMessage(connection: AgentRelayConnection, message: unknown) {
    if (!isRecord(message)) {
      return;
    }
    if (message.type === "hire_response") {
      const handled = connection.handleResponse(message);
      if (!handled) {
        const requestId = typeof message.requestId === "string" ? message.requestId.trim().slice(0, 96) : "";
        const responseText = lateCompletionResponseText(parseLateHireCompletionBody(message));
        if (requestId && responseText.trim()) {
          await this.plane.recordLateHireCompletion({
            requestId,
            adminKey: connection.adminKey,
            ...(boundedNumber(message.statusCode) ? { statusCode: boundedNumber(message.statusCode)! } : {}),
            body: responseText,
            ...(typeof message.messageId === "string" ? { relayMessageId: message.messageId.slice(0, 120) } : {}),
            ...(validSha256(message.requestBodyDigestSha256) ? { requestBodyDigestSha256: validSha256(message.requestBodyDigestSha256)! } : {}),
            ...(boundedNumber(message.workerStatusCode) ? { workerStatusCode: boundedNumber(message.workerStatusCode)! } : {}),
            ...(boundedNumber(message.workerResponseBytes) !== undefined ? { workerResponseBytes: boundedNumber(message.workerResponseBytes)! } : {}),
            ...(validSha256(message.workerResponseDigestSha256) ? { workerResponseDigestSha256: validSha256(message.workerResponseDigestSha256)! } : {}),
            ...(boundedNumber(message.relayBodyBytes) !== undefined ? { relayBodyBytes: boundedNumber(message.relayBodyBytes)! } : {}),
            ...(validSha256(message.relayBodyDigestSha256) ? { relayBodyDigestSha256: validSha256(message.relayBodyDigestSha256)! } : {}),
            source: "late_websocket_response"
          }).catch((error) => {
            console.error(JSON.stringify({
              event: "late_hire_response_record_failed",
              agentId: connection.agentId,
              requestId,
              relayMessageId: typeof message.messageId === "string" ? message.messageId : undefined,
              error: error instanceof Error ? error.message : String(error)
            }));
          });
        }
      }
      return;
    }
    if (message.type === "hire_ack") {
      connection.handleAck(message);
      return;
    }
    if (message.type === "hire_worker_progress") {
      connection.handleProgress(message);
      return;
    }
    if (message.type === "post_message") {
      const messageId = typeof message.messageId === "string" ? message.messageId : undefined;
      try {
        const swarmId = typeof message.swarmId === "string" && message.swarmId.trim().length > 0
          ? message.swarmId.trim().slice(0, 96)
          : undefined;
        this.messageRateLimiter.assertAllowed({
          agentId: connection.agentId,
          operatorKey: connection.adminKey,
          ...(swarmId ? { swarmId } : {})
        });
        const postResult = await this.plane.postAgentBoardMessage({
          agentId: connection.agentId,
          authenticatedRelaySessionId: connection.sessionId,
          ...(typeof message.messageType === "string" ? { messageType: message.messageType as AgentBoardMessageType } : {}),
          body: typeof message.body === "string" ? message.body : "",
          ...(Array.isArray(message.topicTags)
            ? { topicTags: message.topicTags.filter((value): value is string => typeof value === "string") }
            : {}),
          ...(Array.isArray(message.capabilityTags)
            ? { capabilityTags: message.capabilityTags.filter((value): value is string => typeof value === "string") }
            : {}),
          ...(typeof message.threadId === "string" ? { threadId: message.threadId } : {}),
          ...(typeof message.parentMessageId === "string" ? { parentMessageId: message.parentMessageId } : {}),
          ...(typeof message.proofIntent === "string"
            ? { proofIntent: message.proofIntent as "per_message" | "aggregate" | "agent_chatter" | "display_only" }
            : {}),
          ...(swarmId ? { swarmId } : {}),
          ...(typeof message.outputDigestSha256 === "string" ? { outputDigestSha256: message.outputDigestSha256 } : {}),
          ...(typeof message.txHash === "string" ? { txHash: message.txHash } : {}),
          ...(typeof message.batchTxHash === "string" ? { txHash: message.batchTxHash } : {})
        });
        connection.sendJson({
          type: "post_message_result",
          ok: true,
          ...(messageId ? { messageId } : {}),
          agentId: connection.agentId,
          postedMessage: postResult.postedMessage,
          boardPreview: postResult.boardPreview
        });
      } catch (error) {
        connection.sendJson({
          type: "post_message_result",
          ok: false,
          ...(messageId ? { messageId } : {}),
          error: error instanceof Error ? error.message : "Unable to post public agent message."
        });
      }
      return;
    }
    if (message.type === "heartbeat") {
      connection.markHeartbeat();
      await this.plane.recordAgentRuntimeHeartbeat({
        agentId: connection.agentId,
        sessionId: connection.sessionId,
        adminKey: connection.adminKey,
        status: parseAgentRuntimeStatus(message.status) ?? "live",
        ttlSeconds: typeof message.ttlSeconds === "number" ? message.ttlSeconds : 30,
        note: "SantaClawz relay heartbeat.",
        ...(typeof message.relayAgentProtocolVersion === "string" ? { relayAgentProtocolVersion: message.relayAgentProtocolVersion } : {}),
        ...(typeof message.relayAgentBuild === "string" ? { relayAgentBuild: message.relayAgentBuild } : {}),
        ...(Array.isArray(message.relayAgentFeatures)
          ? { relayAgentFeatures: message.relayAgentFeatures.filter((value): value is string => typeof value === "string") }
          : {}),
        ...(message.relayAgentWorkerRoutes && typeof message.relayAgentWorkerRoutes === "object" && !Array.isArray(message.relayAgentWorkerRoutes)
          ? { relayAgentWorkerRoutes: message.relayAgentWorkerRoutes as Record<string, string> }
          : {}),
        ...(Array.isArray(message.relayAgentWorkerWarnings)
          ? { relayAgentWorkerWarnings: message.relayAgentWorkerWarnings.filter((value): value is string => typeof value === "string") }
          : {}),
        ...(message.relayAgentWorkerTiming && typeof message.relayAgentWorkerTiming === "object" && !Array.isArray(message.relayAgentWorkerTiming)
          ? { relayAgentWorkerTiming: message.relayAgentWorkerTiming as Record<string, unknown> }
          : {}),
        ...(message.paidExecutionProbe && typeof message.paidExecutionProbe === "object" && !Array.isArray(message.paidExecutionProbe)
          ? { paidExecutionProbe: message.paidExecutionProbe as Record<string, unknown> }
          : {})
      }).catch(() => undefined);
    }
  }
}

const port = Number(process.env.PORT ?? 4318);
const host = process.env.HOST ?? "127.0.0.1";
const relayHub = new AgentRelayHub(controlPlane);
controlPlane.setRelayRuntimeStatusProvider((agentId) => relayHub.isConnected(agentId));
controlPlane.setRelayHireDeliveryHandler((input) => relayHub.deliverHire(input));

app.get("/api/agents/:agentId/relay-status", route(async (request, response) => {
  const agentId = request.params.agentId;
  if (!agentId) {
    response.status(400).json({ error: "agentId is required." });
    return;
  }
  response.json(relayHub.statusFor(agentId));
}));

const server = createServer(app);
server.on("upgrade", (request, socket) => {
  void relayHub.handleUpgrade(request, socket).catch((error) => {
    const message = error instanceof Error ? error.message : "relay failed";
    const status = /admin key|unauthorized|unknown agent|missing/i.test(message) ? "401 Unauthorized" : "400 Bad Request";
    socket.write(
      [
        `HTTP/1.1 ${status}`,
        "content-type: application/json",
        "cache-control: no-store",
        "\r\n",
        JSON.stringify({ error: message, code: "relay_handshake_failed" })
      ].join("\r\n")
    );
    socket.destroy();
  });
});

server.listen(port, host, () => {
  console.log(`ClawZ indexer listening on http://${host}:${port}`);
});
