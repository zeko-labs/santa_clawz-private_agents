import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import {
  type AgentBoardMessageType,
  type AgentPaymentRail,
  type AgentProfileState,
  type AgentRuntimeStatus,
  assertClawzJsonRpcRequest,
  buildProofVerificationResponse,
  type ClawzAgentDiscoveryDocument,
  type ClawzAgentProofBundle,
  type ClawzAgentProofVerificationRequest,
  type ClawzAgentProofVerificationResponse,
  type ConsoleStateResponse,
  type ExecutionIntentSettlementModel,
  type ExecutionIntentStatus,
  type PrivacyApprovalRecord,
  type TrustModeId,
  type WitnessPlanLike,
  verifyAgentProofBundle
} from "@clawz/protocol";

import {
  ClawzControlPlane,
  DuplicatePublicClawzUrlError,
  SelfServeSocialAnchoringDisabledError,
  type CreateExecutionIntentOptions,
  type ExecutionIntentTransitionOptions
} from "./control-plane.js";
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
const securityConfig = resolveSecurityConfig();
const HIRE_REQUEST_BODY_MAX_BYTES = 32 * 1024;
const HIRE_TASK_PROMPT_MAX_LENGTH = 2000;
const HIRE_REQUESTER_CONTACT_MAX_LENGTH = 240;

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
  send(body: string): IndexerResponse<ResBody>;
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

const controlPlane = await ClawzControlPlane.boot(process.env.CLAWZ_DATA_DIR?.trim() || undefined);
controlPlane.startSharedSocialAnchorDrainer();
const REGISTRATION_WINDOW_MS = 15 * 60 * 1000;
const REGISTRATION_LIMIT = 5;
const registrationAttempts = new Map<string, { count: number; resetAt: number }>();
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
  paymentPayload?: unknown;
};
type QuoteAcceptRequestBody = {
  buyerAgentId?: unknown;
  buyerWallet?: unknown;
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
};
type SponsorRequestBody = { amountMina?: unknown; sessionId?: unknown; purpose?: unknown };
type RecoveryRequestBody = { sessionId?: unknown };
type PrivacyExceptionApprovalBody = {
  actorRole?: unknown;
  actorId?: unknown;
  note?: unknown;
  sessionId?: unknown;
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
    body.paymentStatus === "settled" || body.paymentStatus === "paid" || body.paymentStatus === "escrowed"
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
  return {
    ...(typeof body.buyerAgentId === "string" ? { buyerAgentId: body.buyerAgentId } : {}),
    ...(typeof body.buyerWallet === "string" ? { buyerWallet: body.buyerWallet } : {}),
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
  return {
    mode,
    ...(typeof value.runtimeIngressUrl === "string" && value.runtimeIngressUrl.trim().length > 0
      ? { runtimeIngressUrl: value.runtimeIngressUrl.trim() }
      : {})
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
        paymentPayload: body.paymentPayload
      }
    : {};
}

function parseAgentHeartbeatRequest(body: unknown): AgentHeartbeatRequestBody {
  return isRecord(body)
    ? {
        sessionId: body.sessionId,
        status: body.status,
        ttlSeconds: body.ttlSeconds,
        note: body.note
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

  if (agentAvailability.reachable) {
    return true;
  }

  response.status(503).json({
    ok: false,
    paymentRequested: false,
    error: "Agent endpoint is offline; payment not requested.",
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
    service: "clawz-indexer"
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
    response.json(
      await controlPlane.getConsoleState(
        sessionId
          ? { sessionId, ...(adminKey ? { adminKey } : {}) }
          : agentId
            ? { agentId, ...(adminKey ? { adminKey } : {}) }
            : { ...(adminKey ? { adminKey } : {}) }
      )
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load console state."
    });
  }
}));

app.get("/api/agents", route(async (_request, response) => {
  response.json(await controlPlane.listRegisteredAgents());
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
    const intent = await controlPlane.acceptQuoteForPayment({
      agentId,
      requestId,
      ...parseQuoteAcceptRequest(request.body ?? null)
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
    response.json(
      await controlPlane.postAgentBoardMessage({
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
        ...(typeof body.outputDigestSha256 === "string" ? { outputDigestSha256: body.outputDigestSha256 } : {})
      })
    );
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

    const settlement = await settleAgentX402Payment({
      runtime: context.runtime,
      paymentPayload
    });
    setHeaders(response, settlement.headers);
    const remoteSettlement = isRecord(settlement.remoteSettlement) ? settlement.remoteSettlement : {};
    const settlementReference = [
      settlement.paymentResponse?.settlementReference,
      remoteSettlement.transaction,
      remoteSettlement.txHash,
      remoteSettlement.transactionHash,
      remoteSettlement.id
    ].find((value): value is string => typeof value === "string" && value.length > 0);
    const paymentPayloadDigestSha256 = jsonDigestSha256(paymentPayload);
    const paymentResponseDigestSha256 = jsonDigestSha256(settlement.paymentResponse);
    const approvedIntent = await controlPlane.approveExecutionIntent({
      intentId,
      reference: settlementReference ?? "x402:quote-intent-settled",
      evidenceDigestSha256: paymentPayloadDigestSha256,
      note: "Accepted quote x402 payment settled."
    });
    const paidExecution = await controlPlane.submitHireRequest({
      agentId: context.intent.agentId,
      taskPrompt: context.quoteRequest.taskPrompt,
      requesterContact: context.quoteRequest.requesterContact,
      ...(context.quoteRequest.budgetMina ? { budgetMina: context.quoteRequest.budgetMina } : {}),
      paymentAuthorization: {
        status: "settled",
        rail: settlement.rail.rail,
        amountUsd: context.intent.grossAmountUsd,
        authorizationId: intentId,
        ...(settlementReference ? { settlementReference } : {}),
        paymentPayloadDigestSha256,
        paymentResponseDigestSha256
      }
    });
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
      paidExecution.protocolReturn?.status === "completed"
        ? await controlPlane.settleExecutionIntent({
            intentId,
            reference: settlementReference ?? paidExecution.requestId,
            evidenceDigestSha256: paymentResponseDigestSha256,
            note: "Upfront x402 quote payment settled and paid execution completed."
          })
        : executedIntent;

    response.json({
      ok: true,
      intent: finalIntent,
      payment: settlement.paymentResponse,
      paidExecution
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
    setHeaders(response, settlement.headers);
    response.json({
      ok: true,
      paid: true,
      payment: settlement.paymentResponse,
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
    setHeaders(response, settlement.headers);
    response.json(settlement);
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
    if (consoleState.profile.availability === "archived") {
      response.status(400).json({ error: "This agent is archived on SantaClawz and is not accepting new hire requests." });
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
          status: "settled";
          rail?: string;
          amountUsd?: string;
          authorizationId?: string;
          settlementReference?: string;
          paymentPayloadDigestSha256?: string;
          paymentResponseDigestSha256?: string;
        }
      | undefined;

    const quoteRequestMode =
      consoleState.paymentsEnabled &&
      consoleState.profile.paymentProfile.pricingMode === "quote-required";

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

      const settlement = await settleAgentX402Payment({
        runtime,
        paymentPayload
      });
      setHeaders(response, settlement.headers);
      const remoteSettlement = isRecord(settlement.remoteSettlement) ? settlement.remoteSettlement : {};
      const settlementReference = [
        settlement.paymentResponse?.settlementReference,
        remoteSettlement.transaction,
        remoteSettlement.txHash,
        remoteSettlement.transactionHash,
        remoteSettlement.id
      ].find((value): value is string => typeof value === "string" && value.length > 0);
      paymentAuthorization = {
        status: "settled",
        rail: settlement.rail.rail,
        ...(settlement.rail.amountUsd ? { amountUsd: settlement.rail.amountUsd } : {}),
        ...(settlementReference ? { settlementReference, authorizationId: settlementReference } : {}),
        paymentPayloadDigestSha256: jsonDigestSha256(paymentPayload),
        paymentResponseDigestSha256: jsonDigestSha256(settlement.paymentResponse)
      };
    }

    response.json(
      await controlPlane.submitHireRequest({
        agentId,
        taskPrompt,
        requesterContact,
        ...(typeof body.budgetMina === "string" ? { budgetMina: body.budgetMina } : {}),
        ...(paymentAuthorization ? { paymentAuthorization } : {})
      })
    );
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
const RELAY_RESPONSE_TIMEOUT_MS = 15_000;
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
  resolve(value: { statusCode: number; body: string; deliveryTarget: string }): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
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

  constructor(
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
    return new Promise<{ statusCode: number; body: string; deliveryTarget: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new Error("Timed out waiting for agent relay response."));
      }, RELAY_RESPONSE_TIMEOUT_MS);
      this.pending.set(messageId, { resolve, reject, timeout });
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
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(messageId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
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
    const body = typeof message.body === "string" ? message.body.slice(0, RELAY_MESSAGE_MAX_BYTES) : "";
    pending.resolve({
      statusCode,
      body,
      deliveryTarget: `santaclawz-relay://agent/${encodeURIComponent(this.agentId)}`
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
        this.close(1003, "invalid json");
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
  private readonly connectionsByAgent = new Map<string, AgentRelayConnection>();
  private readonly staleSweepInterval: ReturnType<typeof setInterval>;
  private readonly messageRateLimiter = new RelayMessageRateLimiter();

  constructor(private readonly plane: ClawzControlPlane) {
    this.staleSweepInterval = setInterval(() => {
      this.closeStaleConnections();
    }, RELAY_STALE_SWEEP_MS);
    (this.staleSweepInterval as unknown as { unref?: () => void }).unref?.();
  }

  isConnected(agentId: string) {
    const connection = this.connectionsByAgent.get(agentId);
    if (!connection) {
      return false;
    }
    if (connection.isFresh()) {
      return true;
    }
    connection.terminate("Relay heartbeat is stale.");
    return false;
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
    const connection = this.connectionsByAgent.get(input.agentId);
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
    for (const connection of this.connectionsByAgent.values()) {
      if (!connection.isFresh(nowMs)) {
        connection.terminate("Relay heartbeat is stale.");
      }
    }
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
    const auth = await this.plane.authenticateAgentRelayConnection({ agentId, adminKey });
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${websocketAcceptKey(key)}`,
        "\r\n"
      ].join("\r\n")
    );
    const existing = this.connectionsByAgent.get(agentId);
    existing?.close(1012, "new relay connection");
    let connection!: AgentRelayConnection;
    connection = new AgentRelayConnection(
      auth.agentId,
      auth.sessionId,
      adminKey,
      socket,
      (message) => {
        void this.handleMessage(connection, message);
      },
      () => {
        if (this.connectionsByAgent.get(agentId) === connection) {
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
    this.connectionsByAgent.set(agentId, connection);
    await this.plane.recordAgentRuntimeHeartbeat({
      agentId,
      sessionId: auth.sessionId,
      adminKey,
      status: "live",
      ttlSeconds: 30,
      note: "SantaClawz relay connected."
    });
    connection.sendJson({
      type: "relay_ready",
      agentId: auth.agentId,
      sessionId: auth.sessionId,
      serviceKey: auth.serviceKey
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
        const board = await this.plane.postAgentBoardMessage({
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
          ...(typeof message.outputDigestSha256 === "string" ? { outputDigestSha256: message.outputDigestSha256 } : {})
        });
        connection.sendJson({
          type: "post_message_result",
          ok: true,
          ...(messageId ? { messageId } : {}),
          agentId: connection.agentId,
          postedMessage: board.messages[0] ?? null
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
        note: "SantaClawz relay heartbeat."
      }).catch(() => undefined);
    }
  }
}

const port = Number(process.env.PORT ?? 4318);
const host = process.env.HOST ?? "127.0.0.1";
const relayHub = new AgentRelayHub(controlPlane);
controlPlane.setRelayRuntimeStatusProvider((agentId) => relayHub.isConnected(agentId));
controlPlane.setRelayHireDeliveryHandler((input) => relayHub.deliverHire(input));

const server = createServer(app);
server.on("upgrade", (request, socket) => {
  void relayHub.handleUpgrade(request, socket).catch((error) => {
    socket.write(`HTTP/1.1 400 Bad Request\r\ncontent-type: text/plain\r\n\r\n${error instanceof Error ? error.message : "relay failed"}`);
    socket.destroy();
  });
});

server.listen(port, host, () => {
  console.log(`ClawZ indexer listening on http://${host}:${port}`);
});
