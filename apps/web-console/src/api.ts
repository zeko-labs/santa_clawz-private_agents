import type {
  AgentBoardMessageType,
  AgentBoardPostResult,
  AgentBoardState,
  AgentProfileState,
  AgentRuntimeAvailabilityState,
  AgentRuntimeHeartbeatState,
  AgentRuntimeStatus,
  AgentRegistryEntry,
  ConsoleStateResponse,
  HireRequestReceipt,
  PaymentLedgerState,
  PrivacyApprovalRecord,
  SocialAnchorBatchExport,
  SocialAnchorQueueState,
  TrustModeId
} from "@clawz/protocol";

const LOCAL_INDEXER_BASE = "http://127.0.0.1:4318";
const DEFAULT_ZEKO_FAUCET_UI_URL = "https://faucet.zeko.io";
const DEFAULT_ZEKO_FAUCET_CLAIM_API_URL = "https://api.faucet.zeko.io/claim";
const ADMIN_KEY_SESSION_PREFIX = "clawz-admin-key:session:";
const ADMIN_KEY_AGENT_PREFIX = "clawz-admin-key:agent:";
type LiveFlowKind = "first-turn" | "next-turn" | "abort-turn" | "refund-turn" | "revoke-disclosure";

function isRetryablePlatformStatus(status: number) {
  return status === 502 || status === 503 || status === 504;
}

function createRetryablePlatformFailure(status: number, responseText: string, operation = "platform_request"): Record<string, unknown> {
  const responsePreview = responseText.trim().slice(0, 1000);
  return {
    ok: false,
    code: operation === "public_agent_message" ? "platform_unavailable_retryable" : "relay_unavailable_retryable",
    retryable: true,
    status,
    operation,
    ...(operation === "public_agent_message"
      ? {
          messageAccepted: false,
          proofIntent: "unknown",
          anchorStatus: "not_started"
        }
      : {}),
    paymentStatus: "unknown",
    settlementStatus: "unknown",
    relayDeliveryStatus: "not_confirmed",
    agentExecutionStatus: "not_confirmed",
    error: operation === "public_agent_message"
      ? "SantaClawz could not confirm whether this public message was accepted because the platform returned a retryable availability error. Retry with the same client message id when available."
      : "SantaClawz could not confirm this job yet. The relay is temporarily unavailable. Wait until service is restored, then retry with the same payment payload so we can safely resume without duplicating payment.",
    ...(responsePreview ? { responsePreview } : {})
  };
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function resolveApiBase() {
  if (typeof window !== "undefined") {
    const { hostname, port, protocol, host } = window.location;
    if ((hostname === "127.0.0.1" || hostname === "localhost") && port === "4173") {
      return LOCAL_INDEXER_BASE;
    }
    if (
      hostname === "santaclawz.ai" ||
      hostname === "www.santaclawz.ai" ||
      hostname.endsWith(".vercel.app")
    ) {
      return `${protocol}//${host}`;
    }
  }

  const configuredBase =
    typeof import.meta.env.VITE_CLAWZ_API_BASE_URL === "string"
      ? import.meta.env.VITE_CLAWZ_API_BASE_URL.trim()
      : "";
  if (configuredBase.length > 0) {
    return normalizeBaseUrl(configuredBase);
  }

  if (typeof window !== "undefined") {
    const { protocol, host } = window.location;
    return `${protocol}//${host}`;
  }

  return LOCAL_INDEXER_BASE;
}

const API_BASE = resolveApiBase();

type AdminKeyContext = {
  sessionId?: string;
  agentId?: string;
};

export class ApiError extends Error {
  data: Record<string, unknown> | undefined;

  constructor(message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.data = data;
  }
}

export function getApiBase() {
  return API_BASE;
}

function resolveOptionalUrl(value: string | undefined, fallback: string) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? normalizeBaseUrl(trimmed) : fallback;
}

export function getZekoFaucetConfig() {
  return {
    uiUrl: resolveOptionalUrl(import.meta.env.VITE_ZEKO_FAUCET_UI_URL, DEFAULT_ZEKO_FAUCET_UI_URL),
    claimApiUrl: resolveOptionalUrl(import.meta.env.VITE_ZEKO_FAUCET_CLAIM_API_URL, DEFAULT_ZEKO_FAUCET_CLAIM_API_URL)
  };
}

function buildPath(path: string, sessionId?: string, agentId?: string) {
  if (!sessionId && !agentId) {
    return path;
  }

  const params = new URLSearchParams();
  if (sessionId) {
    params.set("sessionId", sessionId);
  }
  if (agentId) {
    params.set("agentId", agentId);
  }
  return `${path}?${params.toString()}`;
}

export interface RunLiveFlowOptions {
  flowKind?: LiveFlowKind;
  sessionId?: string;
  turnId?: string;
  sourceTurnId?: string;
  sourceDisclosureId?: string;
  abortReason?: string;
  revocationReason?: string;
  refundAmountMina?: string;
}

function adminSessionStorageKey(sessionId: string) {
  return `${ADMIN_KEY_SESSION_PREFIX}${sessionId}`;
}

function adminAgentStorageKey(agentId: string) {
  return `${ADMIN_KEY_AGENT_PREFIX}${agentId}`;
}

function canUseStorage() {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

export function getStoredAdminKey(sessionId?: string, agentId?: string) {
  if (!canUseStorage()) {
    return "";
  }
  if (agentId) {
    const byAgent = window.localStorage.getItem(adminAgentStorageKey(agentId));
    if (byAgent?.trim()) {
      return byAgent.trim();
    }
  }
  if (sessionId) {
    const bySession = window.localStorage.getItem(adminSessionStorageKey(sessionId));
    if (bySession?.trim()) {
      return bySession.trim();
    }
  }
  return "";
}

export function storeAdminKey(adminKey: string, sessionId?: string, agentId?: string) {
  if (!canUseStorage()) {
    return;
  }
  const normalized = adminKey.trim();
  if (!normalized) {
    return;
  }
  if (sessionId) {
    window.localStorage.setItem(adminSessionStorageKey(sessionId), normalized);
  }
  if (agentId) {
    window.localStorage.setItem(adminAgentStorageKey(agentId), normalized);
  }
}

function captureAdminAccess(payload: unknown) {
  if (typeof payload !== "object" || payload === null) {
    return;
  }

  const response = payload as {
    agentId?: unknown;
    adminAccess?: { issuedAdminKey?: unknown };
    session?: { sessionId?: unknown };
  };

  if (typeof response.adminAccess?.issuedAdminKey !== "string") {
    return;
  }

  storeAdminKey(
    response.adminAccess.issuedAdminKey,
    typeof response.session?.sessionId === "string" ? response.session.sessionId : undefined,
    typeof response.agentId === "string" ? response.agentId : undefined
  );
}

function buildAdminContext(sessionId?: string, agentId?: string): AdminKeyContext | undefined {
  const context: AdminKeyContext = {
    ...(sessionId ? { sessionId } : {}),
    ...(agentId ? { agentId } : {})
  };
  return Object.keys(context).length > 0 ? context : undefined;
}

function normalizeConsoleStateResponse(payload: ConsoleStateResponse): ConsoleStateResponse {
  const availability: AgentProfileState["availability"] =
    payload.profile?.availability === "archived" ||
    payload.profile?.availability === "suspended" ||
    payload.profile?.availability === "blocked"
      ? payload.profile.availability
      : "active";
  const normalizedProfile = {
    ...payload.profile,
    availability,
    ...(typeof payload.profile?.archivedAtIso === "string" && payload.profile.archivedAtIso.trim().length > 0
      ? { archivedAtIso: payload.profile.archivedAtIso }
      : {}),
    missionAuthOverlay: payload.profile?.missionAuthOverlay ?? {
      enabled: false,
      status: "disabled" as const,
      scopeHints: []
    },
    socialAnchorPolicy: payload.profile?.socialAnchorPolicy ?? {
      mode: "shared-batched" as const
    },
    runtimeDelivery: payload.profile?.runtimeDelivery ?? {
      mode: "santaclawz-relay" as const
    }
  };
  return {
    ...payload,
    adminAccess: payload.adminAccess ?? {
      requiresAdminKey: false,
      hasAdminAccess: true
    },
    socialAnchorQueue: payload.socialAnchorQueue
      ? {
          ...payload.socialAnchorQueue,
          items: payload.socialAnchorQueue.items.map((item) => ({
            ...item,
            anchorMode: item.anchorMode ?? "shared-batched"
          })),
          recentBatches: payload.socialAnchorQueue.recentBatches.map((batch) => ({
            ...batch,
            anchorMode: batch.anchorMode ?? "shared-batched"
          }))
        }
      : {
          pendingCount: 0,
          submittedCount: 0,
          retryingCount: 0,
          confirmedCount: 0,
          failedCount: 0,
          anchoredCount: 0,
          items: [],
          recentBatches: []
        },
    profile: normalizedProfile,
    ownership: payload.ownership ?? {
      status: "unverified",
      legacyRegistration: false,
      canReclaim: false
    }
  };
}

export interface OwnershipChallengeIssueResponse extends ConsoleStateResponse {
  issuedOwnershipChallenge: {
    challengeId: string;
    challengePath: string;
    challengeUrl: string;
    verificationMethod: "well-known-http";
    issuedAtIso: string;
    expiresAtIso: string;
    challengeToken: string;
    challengeResponseJson: string;
  };
}

export interface EnrollmentTicketResponse {
  ticket: string;
  ticketId: string;
  issuedAtIso: string;
  expiresAtIso: string;
  reservedSessionId: string;
  reservedAgentId: string;
  publicAgentUrl: string;
  publicHireUrl: string;
  challengePath: string;
  enrollmentChallenge: {
    schemaVersion: "santaclawz-enrollment-ticket/1.0";
    ticketId: string;
    ticketDigestSha256: string;
    challengePath: string;
    publicAgentUrl: string;
    publicHireUrl: string;
  };
}

async function request<T>(path: string, init?: RequestInit, adminContext?: AdminKeyContext): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  const method = String(init?.method ?? "GET").toUpperCase();
  const hasBody = init?.body !== undefined && init.body !== null;
  if (!headers.has("content-type") && (hasBody || (method !== "GET" && method !== "HEAD"))) {
    headers.set("content-type", "application/json");
  }
  const adminKey = getStoredAdminKey(adminContext?.sessionId, adminContext?.agentId);
  if (adminKey) {
    headers.set("x-clawz-admin-key", adminKey);
  }

  let response: Response | undefined;
  const attempts = method === "GET" || method === "HEAD" ? 3 : 1;
  let lastNetworkError: unknown;
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeoutId = controller && !init?.signal
        ? window.setTimeout(() => {
            controller.abort();
          }, 10_000)
        : null;
      try {
        response = await fetch(`${API_BASE}${path}`, {
          headers,
          ...init,
          cache: init?.cache ?? "no-store",
          ...(controller && !init?.signal ? { signal: controller.signal } : {})
        });
        break;
      } catch (error) {
        lastNetworkError = error;
        if (attempt < attempts) {
          await new Promise((resolve) => window.setTimeout(resolve, 650));
        }
      } finally {
        if (timeoutId) {
          window.clearTimeout(timeoutId);
        }
      }
    }
  } catch (error) {
    lastNetworkError = error;
  }
  if (!response) {
    const message = lastNetworkError instanceof Error ? lastNetworkError.message : "Network request failed.";
    throw new Error(
      `SantaClawz could not reach ${API_BASE}${path}. Check that the Render backend is live and CORS allows this domain. (${message})`
    );
  }

  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    let payload: Record<string, unknown> | null = null;
    try {
      payload = responseText ? (JSON.parse(responseText) as Record<string, unknown>) : null;
    } catch (_error) {
      payload = isRetryablePlatformStatus(response.status)
        ? createRetryablePlatformFailure(response.status, responseText, path.includes("/messages") ? "public_agent_message" : "platform_request")
        : null;
    }
    throw new ApiError(
      typeof payload?.error === "string" ? payload.error : `Request failed: ${response.status}`,
      payload ?? undefined
    );
  }

  const payload = (await response.json()) as T;
  captureAdminAccess(payload);
  return payload;
}

export function fetchConsoleState(sessionId?: string, agentId?: string): Promise<ConsoleStateResponse> {
  return request<ConsoleStateResponse>(
    buildPath("/api/console/state", sessionId, agentId),
    undefined,
    buildAdminContext(sessionId, agentId)
  ).then(normalizeConsoleStateResponse);
}

export function fetchAgentRegistry(): Promise<AgentRegistryEntry[]> {
  return request<AgentRegistryEntry[]>("/api/agents");
}

export function fetchAgentBoardMessages(input: {
  agentId?: string;
  threadId?: string;
  limit?: number;
} = {}): Promise<AgentBoardState> {
  const params = new URLSearchParams();
  if (input.agentId) {
    params.set("agentId", input.agentId);
  }
  if (input.threadId) {
    params.set("threadId", input.threadId);
  }
  if (typeof input.limit === "number") {
    params.set("limit", String(input.limit));
  }
  return request<AgentBoardState>(`/api/agent-messages${params.toString() ? `?${params.toString()}` : ""}`);
}

export function fetchPaymentLedger(input: {
  agentId?: string;
  sessionId?: string;
  limit?: number;
} = {}): Promise<PaymentLedgerState> {
  const params = new URLSearchParams();
  if (input.agentId) {
    params.set("agentId", input.agentId);
  }
  if (input.sessionId) {
    params.set("sessionId", input.sessionId);
  }
  if (typeof input.limit === "number") {
    params.set("limit", String(input.limit));
  }
  return request<PaymentLedgerState>(`/api/payments${params.toString() ? `?${params.toString()}` : ""}`);
}

export function fetchPublicSocialAnchors(input: { limit?: number } = {}): Promise<SocialAnchorQueueState> {
  const params = new URLSearchParams();
  if (typeof input.limit === "number") {
    params.set("limit", String(input.limit));
  }
  return request<SocialAnchorQueueState>(`/api/social/anchors/public${params.toString() ? `?${params.toString()}` : ""}`);
}

export function postAgentBoardMessage(
  agentId: string,
  input: {
    messageType?: AgentBoardMessageType;
    body: string;
    topicTags?: string[];
    threadId?: string;
    parentMessageId?: string;
    outputDigestSha256?: string;
    sessionId?: string;
  }
): Promise<AgentBoardPostResult> {
  return request<AgentBoardPostResult>(
    `/api/agents/${encodeURIComponent(agentId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify(input)
    },
    buildAdminContext(input.sessionId, agentId)
  );
}

export function fetchAgentRuntimeAvailability(agentId: string): Promise<AgentRuntimeAvailabilityState> {
  return request<AgentRuntimeAvailabilityState>(`/api/agents/${encodeURIComponent(agentId)}/availability`);
}

export function postAgentRuntimeHeartbeat(
  agentId: string,
  input: {
    sessionId?: string;
    status?: AgentRuntimeStatus;
    ttlSeconds?: number;
    note?: string;
  } = {}
): Promise<AgentRuntimeHeartbeatState> {
  return request<AgentRuntimeHeartbeatState>(
    `/api/agents/${encodeURIComponent(agentId)}/heartbeat`,
    {
      method: "POST",
      body: JSON.stringify(input)
    },
    buildAdminContext(input.sessionId, agentId)
  );
}

export function checkMissionAuthOverlay(input: {
  missionAuthOverlay: AgentProfileState["missionAuthOverlay"];
}): Promise<{ missionAuthOverlay: AgentProfileState["missionAuthOverlay"] }> {
  return request<{ missionAuthOverlay: AgentProfileState["missionAuthOverlay"] }>("/api/mission-auth/check", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function checkAndSaveMissionAuthOverlay(input: {
  missionAuthOverlay: AgentProfileState["missionAuthOverlay"];
  sessionId?: string;
  agentId?: string;
}): Promise<ConsoleStateResponse> {
  return request<ConsoleStateResponse>(
    "/api/mission-auth/check",
    {
      method: "POST",
      body: JSON.stringify(input)
    },
    buildAdminContext(input.sessionId, input.agentId)
  ).then(normalizeConsoleStateResponse);
}

export function registerAgent(input: {
  agentName: string;
  representedPrincipal?: string;
  headline: string;
  publicClawzUrl?: string;
  openClawUrl: string;
  payoutWallets?: AgentProfileState["payoutWallets"];
  missionAuthOverlay?: AgentProfileState["missionAuthOverlay"];
  paymentProfile?: AgentProfileState["paymentProfile"];
  socialAnchorPolicy?: AgentProfileState["socialAnchorPolicy"];
  trustModeId?: TrustModeId;
  preferredProvingLocation?: AgentProfileState["preferredProvingLocation"];
}): Promise<ConsoleStateResponse> {
  return request<ConsoleStateResponse>("/api/console/register", {
    method: "POST",
    body: JSON.stringify(input)
  }).then(normalizeConsoleStateResponse);
}

export function createEnrollmentTicket(input: {
  agentName: string;
  representedPrincipal?: string;
  headline: string;
  urlReservationSalt?: string;
  openClawUrl?: string;
  runtimeDelivery?: AgentProfileState["runtimeDelivery"];
  payoutWallets?: AgentProfileState["payoutWallets"];
  missionAuthOverlay?: AgentProfileState["missionAuthOverlay"];
  paymentProfile?: AgentProfileState["paymentProfile"];
  socialAnchorPolicy?: AgentProfileState["socialAnchorPolicy"];
  trustModeId?: TrustModeId;
  preferredProvingLocation?: AgentProfileState["preferredProvingLocation"];
}): Promise<EnrollmentTicketResponse> {
  return request<EnrollmentTicketResponse>("/api/enrollment/tickets", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function submitHireRequest(
  agentId: string,
  input: {
    taskPrompt: string;
    requesterContact: string;
    budgetMina?: string;
  }
): Promise<HireRequestReceipt> {
  return request<HireRequestReceipt>(`/api/agents/${encodeURIComponent(agentId)}/hire`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function fetchSocialAnchorQueue(sessionId?: string, agentId?: string): Promise<SocialAnchorQueueState> {
  return request<SocialAnchorQueueState>(
    buildPath("/api/social/anchors", sessionId, agentId),
    undefined,
    buildAdminContext(sessionId, agentId)
  );
}

export function fetchSocialAnchorBatchExport(sessionId?: string, agentId?: string): Promise<SocialAnchorBatchExport> {
  return request<SocialAnchorBatchExport>(
    buildPath("/api/social/anchors/export", sessionId, agentId),
    undefined,
    buildAdminContext(sessionId, agentId)
  );
}

export function settleSocialAnchorBatch(input: {
  sessionId?: string;
  agentId?: string;
  limit?: number;
  txHash?: string;
  operatorNote?: string;
}): Promise<SocialAnchorQueueState> {
  return request<SocialAnchorQueueState>(
    "/api/social/anchors/settle",
    {
      method: "POST",
      body: JSON.stringify(input)
    },
    buildAdminContext(input.sessionId, input.agentId)
  );
}

export function commitSocialAnchorBatch(input: {
  sessionId?: string;
  agentId?: string;
  limit?: number;
  txHash?: string;
  expectedBatchId?: string;
  expectedRootDigestSha256?: string;
  operatorNote?: string;
}): Promise<SocialAnchorQueueState> {
  return request<SocialAnchorQueueState>(
    "/api/social/anchors/commit",
    {
      method: "POST",
      body: JSON.stringify(input)
    },
    buildAdminContext(input.sessionId, input.agentId)
  );
}

export function runLiveSessionTurnFlow(
  options: RunLiveFlowOptions | LiveFlowKind = "first-turn"
): Promise<ConsoleStateResponse> {
  const payload = typeof options === "string" ? { flowKind: options } : { flowKind: "first-turn" as const, ...options };

  return request<ConsoleStateResponse>("/api/zeko/session-turn/run", {
    method: "POST",
    body: JSON.stringify(payload)
  }, buildAdminContext(payload.sessionId)).then(normalizeConsoleStateResponse);
}

export function updateTrustMode(modeId: TrustModeId, sessionId?: string): Promise<ConsoleStateResponse> {
  return request<ConsoleStateResponse>(buildPath("/api/console/trust-mode", sessionId), {
    method: "POST",
    body: JSON.stringify({
      modeId,
      ...(sessionId ? { sessionId } : {})
    })
  }, buildAdminContext(sessionId)).then(normalizeConsoleStateResponse);
}

export function updateAgentProfile(
  profile: AgentProfileState,
  sessionId?: string
): Promise<ConsoleStateResponse> {
  return request<ConsoleStateResponse>(buildPath("/api/console/profile", sessionId), {
    method: "POST",
    body: JSON.stringify({
      ...profile,
      ...(sessionId ? { sessionId } : {})
    })
  }, buildAdminContext(sessionId)).then(normalizeConsoleStateResponse);
}

export function setAgentArchiveStatus(
  agentId: string,
  archived: boolean,
  sessionId?: string
): Promise<ConsoleStateResponse> {
  return request<ConsoleStateResponse>(`/api/agents/${encodeURIComponent(agentId)}/archive`, {
    method: "POST",
    body: JSON.stringify({
      archived,
      ...(sessionId ? { sessionId } : {})
    })
  }, buildAdminContext(sessionId, agentId)).then(normalizeConsoleStateResponse);
}

export function issueOwnershipChallenge(sessionId?: string, agentId?: string): Promise<OwnershipChallengeIssueResponse> {
  return request<OwnershipChallengeIssueResponse>(
    buildPath("/api/ownership/challenge", sessionId, agentId),
    {
      method: "POST",
      body: JSON.stringify({
        ...(sessionId ? { sessionId } : {}),
        ...(agentId ? { agentId } : {})
      })
    },
    buildAdminContext(sessionId, agentId)
  ).then((payload) => ({
    ...normalizeConsoleStateResponse(payload),
    ownership: normalizeConsoleStateResponse(payload).ownership,
    issuedOwnershipChallenge: payload.issuedOwnershipChallenge
  }));
}

export function verifyOwnershipChallenge(sessionId?: string, agentId?: string): Promise<ConsoleStateResponse> {
  return request<ConsoleStateResponse>(
    buildPath("/api/ownership/verify", sessionId, agentId),
    {
      method: "POST",
      body: JSON.stringify({
        ...(sessionId ? { sessionId } : {}),
        ...(agentId ? { agentId } : {})
      })
    },
    buildAdminContext(sessionId, agentId)
  ).then(normalizeConsoleStateResponse);
}

export function sponsorWallet(
  amountMina = "0.10",
  sessionId?: string,
  purpose?: "onboarding" | "top-up" | "publish"
): Promise<ConsoleStateResponse> {
  return request<ConsoleStateResponse>(buildPath("/api/wallet/sponsor", sessionId), {
    method: "POST",
    body: JSON.stringify({
      amountMina,
      ...(purpose ? { purpose } : {}),
      ...(sessionId ? { sessionId } : {})
    })
  }, buildAdminContext(sessionId)).then(normalizeConsoleStateResponse);
}

export function prepareRecoveryKit(sessionId?: string): Promise<ConsoleStateResponse> {
  return request<ConsoleStateResponse>(buildPath("/api/wallet/recovery/prepare", sessionId), {
    method: "POST",
    body: JSON.stringify(sessionId ? { sessionId } : {})
  }, buildAdminContext(sessionId)).then(normalizeConsoleStateResponse);
}

export function approvePrivacyException(
  exceptionId: string,
  actorId = "guardian_compliance",
  actorRole: PrivacyApprovalRecord["actorRole"] = "compliance-reviewer",
  note = "Approved from the ClawZ console.",
  sessionId?: string
): Promise<ConsoleStateResponse> {
  return request<ConsoleStateResponse>(buildPath(`/api/privacy-exceptions/${exceptionId}/approve`, sessionId), {
    method: "POST",
    body: JSON.stringify({
      actorId,
      actorRole,
      note,
      ...(sessionId ? { sessionId } : {})
    })
  }).then(normalizeConsoleStateResponse);
}
