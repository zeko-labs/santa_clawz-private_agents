import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";

import {
  type AgentBoardMessageType,
  type AgentPaymentRail,
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
  type PrivacyApprovalRecord,
  type SantaClawzArtifactDeliveryPreference,
  type SantaClawzJobPrivacyPreference,
  type SantaClawzQuoteAcceptanceWalletProof,
  type TrustModeId,
  type WitnessPlanLike,
  verifyAgentProofBundle
} from "@clawz/protocol";

import {
  ClawzControlPlane,
  DuplicatePublicClawzUrlError,
  SelfServeSocialAnchoringDisabledError,
  type CreateExecutionIntentOptions,
  type CreateProcurementIntentOptions,
  type ExecutionIntentTransitionOptions
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
  buildAgentX402Headers,
  parseAgentX402PaymentPayload,
  buildAgentX402RuntimeContext,
  buildQuoteIntentX402RuntimeContext,
  buildAgentX402PaymentRequiredPreview,
  buildAgentX402PlanWithNetworkQuotes,
  settleAgentX402Payment,
  verifyAgentX402Payment
} from "./x402-adapter.js";

const app = express();
const expressRaw = (express as unknown as { raw(options?: unknown): unknown }).raw;
const appWithRouteMiddleware = app as unknown as { post(path: string, ...handlers: unknown[]): void };
const securityConfig = resolveSecurityConfig();
const HIRE_REQUEST_BODY_MAX_BYTES = 32 * 1024;
const HIRE_TASK_PROMPT_MAX_LENGTH = 2000;
const HIRE_REQUESTER_CONTACT_MAX_LENGTH = 240;
const CONSOLE_STATE_CACHE_TTL_MS = Math.max(
  0,
  Math.trunc(Number(process.env.CLAWZ_CONSOLE_STATE_CACHE_TTL_MS ?? "0"))
);
const startedAtIso = new Date().toISOString();
const startedAtMs = Date.now();

const consoleStateCache = new Map<string, {
  expiresAtMs: number;
  payload: unknown;
}>();

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
  params: Params;
  query: ReqQuery;
  header(name: string): string | undefined;
}

interface IndexerResponse<ResBody = unknown> {
  end(): IndexerResponse<ResBody>;
  json(body: ResBody | unknown): IndexerResponse<ResBody>;
  set(name: string, value: string): IndexerResponse<ResBody>;
  send(body: string | Buffer): IndexerResponse<ResBody>;
  status(code: number): IndexerResponse<ResBody>;
  type(contentType: string): IndexerResponse<ResBody>;
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
      typedResponse.status(400).json({
        error: error instanceof Error ? error.message : "Request failed."
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
app.use(express.json({ limit: "64kb" }));

const clawzDataDir = process.env.CLAWZ_DATA_DIR?.trim() || path.join(process.cwd(), ".clawz-data");
const controlPlane = await ClawzControlPlane.boot(clawzDataDir);
controlPlane.startSharedSocialAnchorDrainer();
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
  socialAnchorPolicy?: unknown;
  trustModeId?: unknown;
  preferredProvingLocation?: unknown;
};
type EnrollmentTicketRedeemBody = {
  ticket?: unknown;
  openClawUrl?: unknown;
  runtimeIngressUrl?: unknown;
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
  jobPrivacy?: unknown;
  activityPrivacy?: unknown;
  artifactDelivery?: unknown;
  paymentPayload?: unknown;
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
  jobPrivacy?: unknown;
  artifactDelivery?: unknown;
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

function cacheKeyDigest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function idempotencyKeyHeader(request: IndexerRequest) {
  return optionalString(request.header("idempotency-key") ?? request.header("x-idempotency-key"));
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
        jobPrivacy: body.jobPrivacy,
        activityPrivacy: body.activityPrivacy,
        artifactDelivery: body.artifactDelivery,
        paymentPayload: body.paymentPayload
      }
    : {};
}

function parseProcurementIntentBody(body: unknown, idempotencyKey?: string): CreateProcurementIntentOptions {
  const value = isRecord(body) ? body as ProcurementIntentBody : {};
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
    ...(parseJobPrivacyPreference(value.jobPrivacy) ? { jobPrivacy: parseJobPrivacyPreference(value.jobPrivacy)! } : {}),
    ...(parseArtifactDeliveryPreference(value.artifactDelivery)
      ? { artifactDelivery: parseArtifactDeliveryPreference(value.artifactDelivery)! }
      : {})
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

function parseAgentHeartbeatRequest(body: unknown): AgentHeartbeatRequestBody {
  return isRecord(body)
    ? {
        sessionId: body.sessionId,
        status: body.status,
        ttlSeconds: body.ttlSeconds,
        note: body.note,
        relayAgentProtocolVersion: body.relayAgentProtocolVersion,
        relayAgentBuild: body.relayAgentBuild,
        relayAgentFeatures: body.relayAgentFeatures
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

function commaSet(value: string | undefined) {
  return new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
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
  for (const word of words) {
    tags.add(word.replace(/-/g, "_"));
  }
  return Array.from(tags).slice(0, 24);
}

function pricingReadinessNotes(input: {
  pricingMode: Awaited<ReturnType<typeof controlPlane.listRegisteredAgents>>[number]["pricingMode"];
  quoteReady: boolean;
  paidExecutionReady: boolean;
}) {
  if (input.pricingMode === "fixed-exact") {
    return input.paidExecutionReady ? ["fixed-paid-execution-ready"] : ["fixed-paid-execution-not-ready"];
  }
  if (input.pricingMode === "quote-required") {
    return [
      input.quoteReady ? "quote-intake-ready" : "quote-intake-not-ready",
      input.paidExecutionReady ? "quote-payment-required-before-execution" : "quote-intake-only"
    ];
  }
  return input.paidExecutionReady ? ["free-test-ready"] : ["free-test-not-ready"];
}

async function agentDirectoryEntry(baseUrl: string, agent: Awaited<ReturnType<typeof controlPlane.listRegisteredAgents>>[number]) {
  let plan: Awaited<ReturnType<typeof buildX402PlanFromOptions>>["plan"] | undefined;
  try {
    plan = (await buildX402PlanFromOptions(baseUrl, { agentId: agent.agentId })).plan;
  } catch {
    plan = undefined;
  }
  const quoteReady = agent.paymentProfileReady && agent.pricingMode === "quote-required";
  const paidExecutionReady =
    agent.pricingMode === "free-test" ||
    (agent.paymentProfileReady && agent.paidJobsEnabled && (agent.pricingMode === "fixed-exact" || agent.pricingMode === "quote-required"));
  const pricingReadiness = pricingReadinessNotes({ pricingMode: agent.pricingMode, quoteReady, paidExecutionReady });
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
    paidExecutionProven: agent.readiness?.paidExecutionProven === true,
    needsUpgrade: agent.readiness?.needsUpgrade === true,
    ...(agent.readiness?.upgradeReasons?.length ? { upgradeReasons: agent.readiness.upgradeReasons } : {}),
    ...(agent.readiness?.readinessWarnings?.length ? { readinessWarnings: agent.readiness.readinessWarnings } : {}),
    capabilityTags,
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
    readiness: {
      online: agent.runtimeStatus === "live",
      paymentsReady: agent.paymentProfileReady,
      quoteReady,
      paidExecutionReady,
      paidExecutionProven: agent.readiness?.paidExecutionProven === true,
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

function setHeaders(response: IndexerResponse, headers: Record<string, string>) {
  for (const [name, value] of Object.entries(headers)) {
    response.set(name, value);
  }
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
  const paymentPayloadDigestSha256 =
    queryString(query, "paymentPayloadDigestSha256") ??
    queryString(query, "paymentPayloadDigest") ??
    queryString(query, "payloadDigest");
  return {
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(quoteIntentId ? { quoteIntentId } : {}),
    ...(hireRequestId ? { hireRequestId } : {}),
    ...(paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256 } : {}),
    ...(limit ? { limit: Number.parseInt(limit, 10) } : {})
  };
}

function paymentStateRetryEndpoint(input: {
  apiBase: string;
  intentId?: string;
  requestId?: string;
  agentId?: string;
  paymentPayloadDigestSha256?: string;
}) {
  if (input.intentId) {
    return `${input.apiBase}/api/x402/quote-intent?${new URLSearchParams({ intentId: input.intentId }).toString()}`;
  }
  if (input.agentId) {
    return `${input.apiBase}/api/agents/${encodeURIComponent(input.agentId)}/hire`;
  }
  if (input.paymentPayloadDigestSha256) {
    return `${input.apiBase}/api/x402/payment-state?${new URLSearchParams({ paymentPayloadDigestSha256: input.paymentPayloadDigestSha256 }).toString()}`;
  }
  if (input.requestId) {
    return `${input.apiBase}/api/executions/${encodeURIComponent(input.requestId)}/state`;
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
  const latestLedger = entries[0];
  const intentId = input.intentId ?? latestLedger?.quoteIntentId;
  const requestId = input.requestId ?? latestLedger?.hireRequestId;
  const intent = await optionalExecutionIntentResult(intentId);
  const hireRequest = await optionalHireRequest(
    requestId ?? (isRecord(intent) && isRecord(intent.latestExecution) && typeof intent.latestExecution.requestId === "string"
      ? intent.latestExecution.requestId
      : undefined)
  );
  const resolvedRequestId = hireRequest?.requestId ?? requestId;
  const paymentPayloadDigestSha256 = input.paymentPayloadDigestSha256 ?? latestLedger?.paymentPayloadDigestSha256;
  const retryEndpoint = paymentStateRetryEndpoint({
    apiBase: input.apiBase,
    ...(intentId ? { intentId } : {}),
    ...(resolvedRequestId ? { requestId: resolvedRequestId } : {}),
    ...(latestLedger?.agentId ? { agentId: latestLedger.agentId } : {}),
    ...(paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256 } : {})
  });
  const stateEndpoint = resolvedRequestId
    ? `${input.apiBase}/api/executions/${encodeURIComponent(resolvedRequestId)}/state`
    : intentId
      ? `${input.apiBase}/api/execution/intents/${encodeURIComponent(intentId)}`
      : paymentPayloadDigestSha256
        ? `${input.apiBase}/api/x402/payment-state?${new URLSearchParams({ paymentPayloadDigestSha256 }).toString()}`
        : undefined;
  const latestLifecycle = latestLedger?.lifecycleStatus;
  const paymentAuthorized =
    latestLedger?.paymentStatus === "authorization_verified" ||
    latestLedger?.paymentStatus === "payment_verified" ||
    latestLedger?.paymentStatus === "settled" ||
    latestLedger?.paymentStatus === "already_settled" ||
    latestLedger?.paymentStatus === "execution_completed";
  const terminal =
    latestLifecycle?.completionStatus === "completed" ||
    latestLifecycle?.completionStatus === "failed" ||
    latestLifecycle?.completionStatus === "return_rejected" ||
    (isRecord(intent) && isRecord(intent.intent) && (intent.intent.status === "settled" || intent.intent.status === "refunded"));
  const needsAttention = latestLifecycle?.needsAttention === true || latestLedger?.paymentStatus === "settlement_failed";
  const nextAction = terminal
    ? "result_lookup"
    : latestLedger?.settlementRecovery?.canRetrySettlement
      ? "retry_settlement_same_payload"
      : resolvedRequestId
        ? "poll_execution_state"
        : paymentAuthorized
          ? "retry_same_payment_payload"
          : "submit_or_resubmit_payment_payload";
  return {
    schemaVersion: "santaclawz-x402-payment-state/1.0",
    ok: true,
    generatedAtIso: new Date().toISOString(),
    lookup: {
      ...(input.ledgerId ? { ledgerId: input.ledgerId } : {}),
      ...(intentId ? { intentId } : {}),
      ...(resolvedRequestId ? { requestId: resolvedRequestId } : {}),
      ...(paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256 } : {})
    },
    payment: {
      entries,
      ...(latestLedger ? { latestLedger } : {}),
      ledgerEntryCount: entries.length
    },
    ...(intent ? { intent } : {}),
    ...(hireRequest ? { execution: hireRequest } : {}),
    retryResume: {
      safeToRetrySamePayload: Boolean(paymentPayloadDigestSha256 && !terminal),
      nextAction,
      terminal: Boolean(terminal),
      needsAttention,
      ...(retryEndpoint ? { retryEndpoint } : {}),
      ...(stateEndpoint ? { stateEndpoint } : {}),
      guidance: terminal
        ? "This payment path reached a terminal state. Read the result/artifact state before creating another payment."
        : paymentPayloadDigestSha256
          ? "Retry or resume with the exact same signed x402 payment payload. Do not ask the buyer to sign a new payment until this state says it failed or expired."
          : "No signed payment payload digest was found yet. Submit the signed x402 payload once, then use this endpoint to resume safely."
    }
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

async function fetchBaseRelayerTransactions(input: {
  address: string;
  apiKey: string;
  apiUrl?: string;
  startBlock?: string;
  endBlock?: string;
  sort?: "asc" | "desc";
}) {
  const url = new URL(input.apiUrl ?? "https://api.basescan.org/api");
  url.searchParams.set("module", "account");
  url.searchParams.set("action", "txlist");
  url.searchParams.set("address", input.address);
  url.searchParams.set("startblock", input.startBlock ?? "0");
  url.searchParams.set("endblock", input.endBlock ?? "99999999");
  url.searchParams.set("sort", input.sort ?? "desc");
  url.searchParams.set("apikey", input.apiKey);
  const response = await fetch(url);
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
  return result.filter(isRecord);
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

app.get("/version", route((_request, response) => {
  response.json({
    ok: true,
    service: "clawz-indexer",
    version: deploymentVersion()
  });
}));

app.get("/ready", route(async (_request, response) => {
  try {
    const deployment = await controlPlane.getDeploymentState();
    const checks = [
      {
        label: "control-plane",
        ok: true
      },
      {
        label: "privacy-runtime",
        ok: deployment.keyManagement !== "in-memory-default-export",
        detail: deployment.keyManagement
      },
      {
        label: "api-auth",
        ok: !securityConfig.apiAuthRequired || securityConfig.apiKeyConfigured,
        detail: securityConfig.apiAuthRequired ? "required" : "not-required"
      },
      {
        label: "cors",
        ok: !securityConfig.productionMode || securityConfig.allowedOrigins !== "*",
        detail: securityConfig.allowedOrigins === "*" ? "*" : securityConfig.allowedOrigins.join(",")
      },
      {
        label: "zeko-deployment",
        ok: deployment.mode !== "local-runtime",
        detail: deployment.mode
      }
    ];
    const payload = {
      ok: checks.every((check) => check.ok),
      service: "clawz-indexer",
      generatedAtIso: new Date().toISOString(),
      version: deploymentVersion(),
      security: publicSecurityStatus(securityConfig),
      deployment: {
        mode: deployment.mode,
        networkId: deployment.networkId,
        keyManagement: deployment.keyManagement,
        privacyGrade: deployment.privacyGrade
      },
      checks
    };

    response.status(payload.ok ? 200 : 503).json(payload);
  } catch (error) {
    response.status(503).json({
      ok: false,
      service: "clawz-indexer",
      error: error instanceof Error ? error.message : "Unable to evaluate readiness."
    });
  }
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
    const cached = CONSOLE_STATE_CACHE_TTL_MS > 0 ? consoleStateCache.get(cacheKey) : undefined;
    if (cached && cached.expiresAtMs > Date.now()) {
      response.set("x-santaclawz-cache", "hit");
      response.json(cached.payload);
      return;
    }
    const payload = await controlPlane.getConsoleState(
      sessionId
        ? { sessionId, ...(adminKey ? { adminKey } : {}) }
        : agentId
          ? { agentId, ...(adminKey ? { adminKey } : {}) }
          : { ...(adminKey ? { adminKey } : {}) }
    );
    if (CONSOLE_STATE_CACHE_TTL_MS > 0) {
      consoleStateCache.set(cacheKey, {
        expiresAtMs: Date.now() + CONSOLE_STATE_CACHE_TTL_MS,
        payload
      });
      if (consoleStateCache.size > 80) {
        const nowMs = Date.now();
        for (const [key, entry] of consoleStateCache.entries()) {
          if (entry.expiresAtMs <= nowMs || consoleStateCache.size > 80) {
            consoleStateCache.delete(key);
          }
        }
      }
    }
    response.set("x-santaclawz-cache", "miss");
    response.json(payload);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load console state."
    });
  }
}));

app.get("/api/agents", route(async (_request, response) => {
  response.json(await controlPlane.listRegisteredAgents());
}));

app.get("/api/agents/search", route(async (request, response) => {
  try {
    const q = queryString(request.query, "q")?.toLowerCase();
    const pricingModes = commaSet(queryString(request.query, "pricingMode"));
    const rails = commaSet(queryString(request.query, "rail"));
    const deliveryModes = commaSet(queryString(request.query, "deliveryMode"));
    const privacyModes = commaSet(queryString(request.query, "privacyMode"));
    const hireable = queryBoolean(request.query, "hireable");
    const online = queryBoolean(request.query, "online");
    const paymentsReady = queryBoolean(request.query, "paymentsReady");
    const quoteReady = queryBoolean(request.query, "quoteReady");
    const paidExecutionReady = queryBoolean(request.query, "paidExecutionReady");
    const rawLimit = queryString(request.query, "limit");
    const limit = rawLimit ? Math.max(1, Math.min(Number.parseInt(rawLimit, 10), 100)) : 50;
    const baseUrl = getBaseUrl(request);
    const agents = await Promise.all((await controlPlane.listRegisteredAgents()).map((agent) => agentDirectoryEntry(baseUrl, agent)));
    const filtered = agents.filter((agent) => {
      if (q) {
        const haystack = [
          agent.agentId,
          agent.agentName,
          agent.representedPrincipal,
          agent.headline,
          ...(agent.capabilityTags ?? [])
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
    const [consoleState, availability, scannerHealth] = await Promise.all([
      controlPlane.getConsoleState({ agentId }),
      controlPlane.getAgentRuntimeAvailability({ agentId }),
      artifactStore.scannerHealth()
    ]);
    const plan = (await buildX402PlanFromOptions(baseUrl, { agentId })).plan;
    const pricingMode = consoleState.profile.paymentProfile.pricingMode;
    const quoteReady = consoleState.paymentProfileReady && pricingMode === "quote-required";
    const paidExecutionReady =
      pricingMode === "free-test" ||
      (consoleState.paymentProfileReady && consoleState.paidJobsEnabled && (pricingMode === "fixed-exact" || pricingMode === "quote-required"));
    const pricingReadiness = pricingReadinessNotes({ pricingMode, quoteReady, paidExecutionReady });
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
      paidExecutionProven: consoleState.readiness?.paidExecutionProven === true,
      needsUpgrade: consoleState.readiness?.needsUpgrade === true,
      ...(consoleState.readiness?.upgradeReasons?.length ? { upgradeReasons: consoleState.readiness.upgradeReasons } : {}),
      ...(consoleState.readiness?.readinessWarnings?.length ? { readinessWarnings: consoleState.readiness.readinessWarnings } : {}),
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
        anchoredSocialFactCount: (await controlPlane.listRegisteredAgents()).find((agent) => agent.agentId === agentId)?.anchoredSocialFactCount ?? 0
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
    const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
    const outputDigest =
      queryString(request.query, "outputDigestSha256") ?? queryString(request.query, "outputDigest");
    response.json(
      await controlPlane.listAgentBoardMessages({
        ...(queryString(request.query, "agentId") ? { agentId: queryString(request.query, "agentId")! } : {}),
        ...(queryString(request.query, "threadId") ? { threadId: queryString(request.query, "threadId")! } : {}),
        ...(queryString(request.query, "topic") ? { topic: queryString(request.query, "topic")! } : {}),
        ...(queryString(request.query, "topicTag") ? { topic: queryString(request.query, "topicTag")! } : {}),
        ...(queryString(request.query, "capability") ? { capability: queryString(request.query, "capability")! } : {}),
        ...(outputDigest ? { outputDigestSha256: outputDigest } : {}),
        ...(typeof limit === "number" && Number.isFinite(limit) ? { limit } : {})
      })
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load public agent messages."
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

app.get("/api/executions/:requestId/state", route(async (request, response) => {
  try {
    const requestId = request.params.requestId;
    if (!requestId) {
      response.status(400).json({ error: "requestId is required." });
      return;
    }
    const token = tokenQuery(request);
    const adminKey = adminKeyHeader(request);
    const [hireRequest, collaboration, paymentLedger, artifactReceipts] = await Promise.all([
      controlPlane.getHireRequest(requestId),
      controlPlane.getJobCollaboration({
        requestId,
        ...(token ? { token } : {}),
        ...(adminKey ? { adminKey } : {})
      }),
      controlPlane.listPaymentLedger({ hireRequestId: requestId, limit: 5 }),
      artifactStore.receiptsForRequest(requestId)
    ]);
    const latestLedger = paymentLedger.entries[0];
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
    const artifactDelivered =
      Boolean(hireRequest.protocolReturn?.verifiedOutput?.artifactManifestUrl) ||
      Boolean(hireRequest.protocolReturn?.verifiedOutput?.artifactBundleDigestSha256) ||
      artifactReceipts.length > 0;
    const buyerVerified = latestReceipt?.digestVerified === true || latestReceipt?.buyerScanStatus === "passed";
    const buyerAccepted =
      latestReceipt?.buyerAcceptanceStatus === "accepted" ||
      (collaboration.currentStage?.stage === "review" && collaboration.currentStage.status === "accepted") ||
      collaboration.currentStage?.stage === "final";
    const paymentStatus =
      operational?.paymentStatus === "settled" ||
      latestLedger?.paymentStatus === "settled" ||
      latestLedger?.paymentStatus === "already_settled"
        ? "settled"
        : operational?.paymentStatus === "authorized" || latestLedger?.paymentStatus === "authorization_verified"
          ? "authorized"
          : operational?.paymentStatus ?? "not_started";
    const settlementStatus = operational?.settlementStatus ?? "not_attempted";
    const relayDeliveryStatus = operational?.relayDeliveryStatus ?? "not_attempted";
    const agentExecutionStatus = operational?.agentExecutionStatus ?? hireRequest.status;
    const paymentSettled = paymentStatus === "settled";
    const relayDelivered = relayDeliveryStatus === "forwarded" || relayDeliveryStatus === "recorded";
    const agentStarted =
      relayDelivered ||
      agentExecutionStatus === "submitted" ||
      agentExecutionStatus === "quoted" ||
      agentExecutionStatus === "completed" ||
      agentExecutionStatus === "failed" ||
      agentExecutionStatus === "worker_completed_return_rejected";
    const agentCompleted = agentExecutionStatus === "completed" || agentExecutionStatus === "worker_completed_return_rejected";
    const hasFailure =
      settlementStatus === "failed" ||
      relayDeliveryStatus === "failed" ||
      relayDeliveryStatus === "return_rejected" ||
      agentExecutionStatus === "failed" ||
      agentExecutionStatus === "worker_completed_return_rejected" ||
      proofStatus === "return_rejected" ||
      Boolean(hireRequest.deliveryError || hireRequest.returnValidationError || latestLedger?.errorMessage);
    const knownBlockers = [
      ...(hireRequest.deliveryError ? [hireRequest.deliveryError] : []),
      ...(hireRequest.returnValidationError ? [hireRequest.returnValidationError] : []),
      ...(latestLedger?.errorMessage ? [latestLedger.errorMessage] : [])
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
          : artifactDelivered
            ? "Execution completed and artifact delivery is recorded; buyer verification and acceptance are still pending."
            : agentCompleted && !hasFailure
              ? "Execution completed and proof/return state is recorded; no artifact delivery receipt has been recorded yet."
              : hasFailure
                ? "Execution has a failure or rejected return that needs attention."
                : "Execution is still in progress."
    };
    response.json({
      schemaVersion: "santaclawz-execution-state/1.0",
      ok: true,
      generatedAtIso: new Date().toISOString(),
      requestId,
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
                  : operational?.relayDeliveryStatus === "forwarded" || operational?.relayDeliveryStatus === "recorded"
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
        artifactDeliveryStatus: artifactDelivered ? "delivered" : "not_delivered",
        buyerVerificationStatus: buyerVerified ? "verified" : latestReceipt?.buyerScanStatus === "failed" ? "failed" : "not_verified",
        buyerAcceptanceStatus: buyerAccepted ? "accepted" : latestReceipt?.buyerAcceptanceStatus ?? "pending",
        narrative: lifecycleNarrative
      },
      relayTrace: hireRequest.relayTrace ?? [],
      lifecycleNarrative,
      lifecycleChecks: {
        paymentSettled,
        relayDelivered,
        agentStarted,
        agentCompleted,
        proofVerified: proofStatus === "return_validated" || proofStatus === "anchored_or_attested",
        artifactDelivered,
        buyerVerified,
        buyerAccepted,
        failed: hasFailure,
        terminal: buyerAccepted || hasFailure
      },
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
        ledgerEntries: paymentLedger.entries,
        ...(latestLedger ? { latestLedger } : {})
      },
      workspace: {
        currentStage: collaboration.currentStage,
        stageCount: collaboration.stages.length,
        messageCount: collaboration.messages.length,
        stages: collaboration.stages,
        messages: collaboration.messages
      },
      knownBlockers
    });
  } catch (error) {
    response.status(403).json({
      error: error instanceof Error ? error.message : "Unable to load execution state."
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
  response.json({
    ok: true,
    artifact: await artifactStore.manifest(artifactId, token)
  });
}));

app.get("/api/artifacts/:artifactId/download", route(async (request, response) => {
  const artifactId = request.params.artifactId;
  const token = tokenQuery(request);
  if (!artifactId || !token) {
    response.status(400).json({ error: "artifactId and token are required." });
    return;
  }

  const manifest = await artifactStore.manifest(artifactId, token);
  if (manifest.safety.status === "buyer_scan_required" && !queryFlag(request, "acceptRisk")) {
    response.status(409).json({
      ok: false,
      code: "buyer_scan_required",
      retryable: false,
      artifact: manifest,
      buyerMessage:
        "This artifact was delivered in private encrypted mode. Add acceptRisk=true only after the buyer agrees to decrypt and scan locally before opening."
    });
    return;
  }

  const artifact = await artifactStore.read(artifactId, token);
  response
    .set("content-type", artifact.metadata.contentType)
    .set("content-disposition", contentDispositionAttachment(artifact.metadata.filename))
    .set("x-santaclawz-artifact-digest-sha256", artifact.metadata.digestSha256)
    .send(artifact.body);
}));

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
      ...(typeof body.outputDigestSha256 === "string" ? { outputDigestSha256: body.outputDigestSha256 } : {})
    });
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

    response.json(await controlPlane.getAgentRuntimeAvailability({ agentId }));
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
    const { plan } = await buildX402PlanFromQuery(request);
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

    const { plan } = await buildX402PlanFromOptions(getBaseUrl(request), { agentId });
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
    response.json(await buildX402PaymentStateResponse({
      apiBase: getBaseUrl(request),
      ...(ledgerId ? { ledgerId } : {}),
      ...(intentId ? { intentId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256 } : {})
    }));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load x402 payment state."
    });
  }
}));

app.get("/api/payments", route(async (request, response) => {
  try {
    response.json(await controlPlane.listPaymentLedger(paymentLedgerListOptionsFromQuery(request.query)));
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

const handleX402Reconciliation = route(async (_request, response) => {
  const initialLedger = await controlPlane.listPaymentLedger({ limit: 500 });
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
  if (relayerAddress && basescanApiKey) {
    const transactions = await fetchBaseRelayerTransactions({
      address: relayerAddress,
      apiKey: basescanApiKey,
      ...(process.env.CLAWZ_BASESCAN_API_URL ? { apiUrl: process.env.CLAWZ_BASESCAN_API_URL } : {})
    });
    for (const tx of transactions) {
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
  const ledger = await controlPlane.listPaymentLedger({ limit: 500 });
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
    totalLedgerEntryCount: ledger.totalLedgerEntryCount,
    orphanSettlementCount: orphanEntries.length,
    paidButIncompleteCount: incompleteEntries.length,
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
        paymentAuthorized: false
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

    const responseStatus =
      (paidExecution.operationalStatus?.relayDeliveryStatus === "failed" && paidExecution.status === "submitted") ||
      paidExecution.operationalStatus?.relayDeliveryStatus === "return_rejected"
        ? 202
        : 200;
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
      nextAction: finalIntent.status === "settled" || finalIntent.status === "executed" ? "result_lookup" : "poll_execution",
      intent: finalIntent,
      requestId: responsePaidExecution.requestId,
      requestType: responsePaidExecution.requestType,
      paymentStatus: responsePaidExecution.paymentStatus,
      settlementStatus: responsePaidExecution.operationalStatus?.settlementStatus ?? (settlement ? "settled" : "authorized"),
      relayDeliveryStatus: responsePaidExecution.operationalStatus?.relayDeliveryStatus ?? "not_confirmed",
      agentExecutionStatus: responsePaidExecution.operationalStatus?.agentExecutionStatus ?? "not_confirmed",
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

app.post("/api/console/profile", route(async (request, response) => {
  const body = parseProfileRequest(request.body ?? null);
  const sessionId = optionalString(body.sessionId) ?? queryString(request.query, "sessionId");
  const payoutWallets = parsePayoutWallets(body.payoutWallets);
  const missionAuthOverlay = parseMissionAuthOverlay(body.missionAuthOverlay);
  const paymentProfile = parsePaymentProfile(body.paymentProfile);
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
    response.status(400).json({ error: "agentId is required." });
    return;
  }

  const body = parseHireRequest(request.body ?? null);
  try {
    if (Buffer.byteLength(JSON.stringify(request.body ?? {}), "utf8") > HIRE_REQUEST_BODY_MAX_BYTES) {
      response.status(413).json({ error: "Hire request body is too large." });
      return;
    }
    const taskPrompt = typeof body.taskPrompt === "string" ? body.taskPrompt.trim() : "";
    const requesterContact = typeof body.requesterContact === "string" ? body.requesterContact.trim() : "";
    const jobPrivacy = parseJobPrivacyPreference(body.jobPrivacy ?? body.activityPrivacy);
    const artifactDelivery = parseArtifactDeliveryPreference(body.artifactDelivery);
    if (taskPrompt.length > HIRE_TASK_PROMPT_MAX_LENGTH) {
      response.status(400).json({ error: `taskPrompt must be ${HIRE_TASK_PROMPT_MAX_LENGTH} characters or less.` });
      return;
    }
    if (requesterContact.length > HIRE_REQUESTER_CONTACT_MAX_LENGTH) {
      response.status(400).json({ error: `requesterContact must be ${HIRE_REQUESTER_CONTACT_MAX_LENGTH} characters or less.` });
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
        }
      | undefined;
    let paymentPayloadForDeferredSettlement: Record<string, unknown> | undefined;
    let runtimeForDeferredSettlement: ReturnType<typeof buildAgentX402RuntimeContext> | undefined;
    let authorizationLedgerId: string | undefined;

    const quoteRequestMode =
      consoleState.paymentsEnabled &&
      consoleState.profile.paymentProfile.pricingMode === "quote-required";
    if (quoteRequestMode) {
      const bodyRecord = body as Record<string, unknown>;
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

    if (consoleState.paymentsEnabled && !quoteRequestMode) {
      const runtime = buildAgentX402RuntimeContext({
        baseUrl: getBaseUrl(request),
        plan,
        serviceNetworkId: consoleState.deployment.networkId
      });
      if (!consoleState.paidJobsEnabled || !runtime) {
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
        response.status(402).json(paymentSettlementFailureBody(new Error(verification.error ?? "x402 authorization was not valid."), {
          agentId,
          paymentAuthorized: false
        }));
        return;
      }
      setHeaders(response, verification.headers);
      const paymentPayloadDigestSha256 = jsonDigestSha256(paymentPayload);
      const paymentLedgerEntry = await recordX402PaymentLedgerAuthorization({
        agentId,
        sessionId: consoleState.session.sessionId,
        pricingMode: consoleState.profile.paymentProfile.pricingMode,
        railPlan: verification.rail,
        verification,
        paymentPayload,
        authorizationId: paymentPayloadDigestSha256,
        ...(verification.rail.amountUsd ? { amountUsd: verification.rail.amountUsd } : {}),
        ...(consoleState.protocolOwnerFeePolicy.enabled
          ? { protocolFeeBps: consoleState.protocolOwnerFeePolicy.feeBps }
          : {})
      });
      paymentAuthorization = {
        status: "authorized",
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
        let settlement: Awaited<ReturnType<typeof settleAgentX402Payment>>;
        let settledLedger: Awaited<ReturnType<typeof recordX402PaymentLedgerSettlement>>;
        try {
          settlement = await settleAgentX402Payment({
            runtime: runtimeForDeferredSettlement,
            paymentPayload: paymentPayloadForDeferredSettlement
          });
          settledLedger = await recordX402PaymentLedgerSettlement({
            agentId,
            sessionId: consoleState.session.sessionId,
            pricingMode: consoleState.profile.paymentProfile.pricingMode,
            railPlan: settlement.rail,
            settlement,
            paymentPayload: paymentPayloadForDeferredSettlement,
            ...(paymentAuthorization.authorizationId ? { authorizationId: paymentAuthorization.authorizationId } : {}),
            ...(settlement.rail.amountUsd ? { amountUsd: settlement.rail.amountUsd } : {}),
            ...(consoleState.protocolOwnerFeePolicy.enabled
              ? { protocolFeeBps: consoleState.protocolOwnerFeePolicy.feeBps }
              : {})
          });
          await controlPlane.markHireRequestPaymentSettled({
            requestId: hireReceipt.requestId,
            ...(settledLedger.settlementReference ? { settlementReference: settledLedger.settlementReference } : {}),
            ...(settledLedger.sellerSettlementTxHash ? { sellerSettlementTxHash: settledLedger.sellerSettlementTxHash } : {}),
            ...(settledLedger.protocolFeeTxHash ? { protocolFeeTxHash: settledLedger.protocolFeeTxHash } : {}),
            transactionHashes: settledLedger.transactionHashes,
            paymentResponseDigestSha256: jsonDigestSha256(settlement.paymentResponse)
          });
        } catch (error) {
          await controlPlane.recordPaymentLedgerSettlementFailure({
            ...(authorizationLedgerId ? { ledgerId: authorizationLedgerId } : {}),
            errorMessage: errorMessage(error, "Unable to settle x402 payment."),
            settlementRetryable: isRetryableSettlementError(error)
          });
          response.status(202).json(paymentSettlementFailureBody(error, {
            agentId,
            paidExecution: hireReceipt,
            paymentAuthorized: true,
            paymentSettled: false,
            payment: {
              ...hireReceipt.payment,
              status: "authorized",
              ledgerId: authorizationLedgerId,
              transactionHashes: []
            }
          }));
          return;
        }
        response.json({
          ...hireReceipt,
          paymentStatus: "settled",
          operationalStatus: hireReceipt.operationalStatus
            ? {
                ...hireReceipt.operationalStatus,
                paymentStatus: "settled",
                settlementStatus: "settled"
              }
            : hireReceipt.operationalStatus,
          payment: {
            ...hireReceipt.payment,
            status: "settled",
            ledgerId: settledLedger.ledgerId,
            ...(settledLedger.settlementReference ? { settlementReference: settledLedger.settlementReference } : {}),
            ...(settledLedger.sellerSettlementTxHash ? { sellerSettlementTxHash: settledLedger.sellerSettlementTxHash } : {}),
            ...(settledLedger.protocolFeeTxHash ? { protocolFeeTxHash: settledLedger.protocolFeeTxHash } : {}),
            transactionHashes: settledLedger.transactionHashes
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
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to submit hire request."
    });
  }
});

app.post("/api/agents/:agentId/hire", handleAgentHireRequest);
app.post("/agent/:agentId/hire", handleAgentHireRequest);

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
  parseBoundedIntegerEnv("CLAWZ_AGENT_RELAY_RESPONSE_TIMEOUT_MS", 120_000, 15_000, 180_000);
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
};

type RelayRateLimitBucket = {
  count: number;
  resetAtMs: number;
};

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
    return new Promise<{
      statusCode: number;
      body: string;
      deliveryTarget: string;
      relayMessageId: string;
      relayTrace?: HireRelayTraceStep[];
    }>((resolve, reject) => {
      const trace: HireRelayTraceStep[] = [];
      const timeout = setTimeout(() => {
        this.pending.delete(messageId);
        const error = new Error("Timed out waiting for agent relay response.") as Error & { relayTrace?: HireRelayTraceStep[] };
        trace.push({
          step: "relay_returned",
          status: "failed",
          occurredAtIso: new Date().toISOString(),
          relayMessageId: messageId,
          detail: "Timed out waiting for agent relay response."
        });
        error.relayTrace = trace;
        reject(error);
      }, RELAY_RESPONSE_TIMEOUT_MS);
      this.pending.set(messageId, { resolve, reject, timeout, trace });
      try {
        this.sendJson({
          type: "hire_request",
          messageId,
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
      return;
    }
    const step = message.step === "received_by_worker" ? "received_by_worker" : undefined;
    if (!step) {
      return;
    }
    pending.trace.push({
      step,
      status: message.status === "failed" ? "failed" : "completed",
      occurredAtIso: typeof message.occurredAtIso === "string" ? message.occurredAtIso : new Date().toISOString(),
      relayMessageId: messageId,
      detail: [
        typeof message.detail === "string" ? message.detail : "",
        typeof message.relayAgentProtocolVersion === "string" ? message.relayAgentProtocolVersion : "",
        typeof message.relayAgentBuild === "string" ? `build ${message.relayAgentBuild.slice(0, 12)}` : "",
        typeof message.localHireTimeoutMs === "number" ? `timeout ${message.localHireTimeoutMs}ms` : ""
      ].filter(Boolean).join("; ")
    });
  }

  handleResponse(message: Record<string, unknown>) {
    const messageId = typeof message.messageId === "string" ? message.messageId : "";
    const pending = this.pending.get(messageId);
    if (!pending) {
      return;
    }
    this.pending.delete(messageId);
    clearTimeout(pending.timeout);
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
      status: statusCode >= 200 && statusCode < 300 ? "completed" : "failed",
      occurredAtIso: new Date().toISOString(),
      relayMessageId: messageId,
      detail: [
        `relay status ${statusCode}`,
        workerStatusCode !== undefined ? `worker status ${workerStatusCode}` : "",
        workerResponseBytes !== undefined ? `worker bytes ${workerResponseBytes}` : "",
        relayBodyBytes !== undefined ? `relay bytes ${relayBodyBytes}` : ""
      ].filter(Boolean).join("; ")
    });
    pending.trace.push({
      step: "relay_returned",
      status: "completed",
      occurredAtIso: new Date().toISOString(),
      relayMessageId: messageId
    });
    pending.resolve({
      statusCode,
      body,
      deliveryTarget: `santaclawz-relay://agent/${encodeURIComponent(this.agentId)}`,
      relayMessageId: messageId,
      ...(workerStatusCode !== undefined ? { workerStatusCode } : {}),
      ...(workerResponseBytes !== undefined ? { workerResponseBytes } : {}),
      ...(workerResponseDigestSha256 ? { workerResponseDigestSha256 } : {}),
      ...(relayBodyBytes !== undefined ? { relayBodyBytes } : {}),
      ...(relayBodyDigestSha256 ? { relayBodyDigestSha256 } : {}),
      relayTrace: pending.trace
    });
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
      } catch {
        this.invalidJsonFrames += 1;
        console.error(JSON.stringify({
          event: "relay_invalid_json",
          agentId: this.agentId,
          connectionId: this.connectionId,
          payloadBytes: payload.length,
          payloadDigestSha256: createHash("sha256").update(payload.toString("base64")).digest("hex"),
          payloadPreview: payload.toString("utf8").slice(0, 200),
          invalidJsonFrames: this.invalidJsonFrames
        }));
        if (this.invalidJsonFrames >= 3) {
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
    connection.terminate("Relay heartbeat is stale.");
    return false;
  }

  statusFor(agentId: string) {
    const connections = this.cleanupConnections(agentId);
    const connection = this.activeConnection(agentId);
    const connected = Boolean(connection && connection.isFresh());
    if (connection && !connected) {
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
      connection.handleResponse(message);
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
          ...(typeof message.outputDigestSha256 === "string" ? { outputDigestSha256: message.outputDigestSha256 } : {})
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
