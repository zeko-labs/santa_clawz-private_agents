import {
  type AgentPaymentRail,
  type AgentPricingMode,
  type AgentReferencePriceUnit,
  type AgentProfileState,
  summarizeAgentProofBundle,
  type AgentX402Plan,
  type AgentProofVerificationReport,
  type AgentTrustQuestionAnswer,
  type ClawzAgentDiscoveryDocument,
  type ClawzAgentProofBundle,
  type ClawzAgentProofVerificationRequest,
  type ClawzAgentProofVerificationResponse,
  type ClawzMcpToolDefinition,
  type ConsoleStateResponse,
  type HireRequestReceipt,
  type SocialAnchorBatchExport,
  type SocialAnchorQueueState,
  type WitnessPlanLike,
  verifyAgentProofBundle
} from "@clawz/protocol";

interface JsonRpcSuccess<T> {
  jsonrpc: "2.0";
  id: string | number | null;
  result: {
    content?: Array<{
      type?: string;
      text?: string;
    }>;
    structuredContent?: T;
    tools?: ClawzMcpToolDefinition[];
  };
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
  };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

export interface ClawzAgentClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  adminKey?: string;
}

export interface ClawzProofQuery {
  sessionId?: string;
  turnId?: string;
}

export interface LocalAgentVerificationResult {
  discovery: ClawzAgentDiscoveryDocument;
  bundle: ClawzAgentProofBundle;
  report: AgentProofVerificationReport;
  question: AgentTrustQuestionAnswer;
}

export interface ClawzX402PlanQuery {
  sessionId?: string;
  agentId?: string;
}

export interface ClawzSocialAnchorQuery {
  sessionId?: string;
  agentId?: string;
}

export interface ClawzAgentPricingUpdate {
  sessionId?: string;
  agentId?: string;
  openForWork?: boolean;
  pricingMode?: AgentPricingMode;
  defaultRail?: Extract<AgentPaymentRail, "base-usdc" | "ethereum-usdc">;
  basePayoutAddress?: string;
  ethereumPayoutAddress?: string;
  fixedPriceUsd?: string;
  referencePriceUsd?: string;
  referencePriceUnit?: AgentReferencePriceUnit;
  paymentNotes?: string;
}

export interface ClawzAgentArchiveUpdate {
  sessionId?: string;
  agentId: string;
  archived?: boolean;
}

export interface ClawzHireRequestInput {
  agentId: string;
  taskPrompt: string;
  requesterContact: string;
  budgetMina?: string;
  paymentPayload?: Record<string, unknown>;
}

export interface ClawzEnrollmentTicketInput {
  agentName: string;
  headline: string;
  representedPrincipal?: string;
  urlReservationSalt?: string;
  runtimeDelivery?: AgentProfileState["runtimeDelivery"];
  openClawUrl?: string;
  payoutWallets?: AgentProfileState["payoutWallets"];
  missionAuthOverlay?: AgentProfileState["missionAuthOverlay"];
  paymentProfile?: AgentProfileState["paymentProfile"];
  socialAnchorPolicy?: AgentProfileState["socialAnchorPolicy"];
  preferredProvingLocation?: AgentProfileState["preferredProvingLocation"];
}

export interface ClawzEnrollmentTicket {
  ticket: string;
  ticketId: string;
  issuedAtIso: string;
  expiresAtIso: string;
  reservedSessionId: string;
  reservedAgentId: string;
  publicAgentUrl: string;
  publicHireUrl: string;
  challengePath: string;
  enrollmentCommand: string;
  enrollmentChallenge: {
    schemaVersion: "santaclawz-enrollment-ticket/1.0";
    ticketId: string;
    ticketDigestSha256: string;
    challengePath: string;
    publicAgentUrl: string;
    publicHireUrl: string;
  };
}

let nextRpcId = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function extractErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  return typeof payload.error === "string" && payload.error.trim().length > 0 ? payload.error : null;
}

function withQuery(baseUrl: string, route: string, query?: Record<string, string | undefined>): string {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}${route}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value) {
        url.searchParams.set(key, value);
      }
    }
  }
  return url.toString();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildOpenClawEnrollmentCommand(ticket: Pick<ClawzEnrollmentTicket, "ticket">, input: ClawzEnrollmentTicketInput): string {
  const runtimeIngressUrl = input.runtimeDelivery?.runtimeIngressUrl?.trim();
  return [
    "pnpm enroll:openclaw --",
    `--ticket ${shellQuote(ticket.ticket)}`,
    "--serve",
    input.runtimeDelivery?.mode === "self-hosted" && runtimeIngressUrl
      ? `--runtime-ingress-url ${shellQuote(runtimeIngressUrl)}`
      : "--connect-relay",
    "--write-env .env.santaclawz",
    "--challenge-file .well-known/santaclawz-agent-challenge.json"
  ].join(" ");
}

function parseJsonRpcStructuredContent<T>(payload: JsonRpcResponse<T>): T {
  if ("error" in payload) {
    throw new Error(payload.error.message);
  }

  if (payload.result.structuredContent !== undefined) {
    return payload.result.structuredContent;
  }

  const firstText = payload.result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text;
  if (!firstText) {
    throw new Error("MCP response did not include structured content.");
  }

  return JSON.parse(firstText) as T;
}

export class ClawzAgentClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly adminKey: string | undefined;

  constructor(options: ClawzAgentClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.adminKey = options.adminKey?.trim() ? options.adminKey.trim() : undefined;
  }

  private async readJson<T>(url: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers ?? {});
    if (this.adminKey && !headers.has("x-clawz-admin-key")) {
      headers.set("x-clawz-admin-key", this.adminKey);
    }
    const response = await this.fetchImpl(url, {
      ...init,
      headers
    });
    if (!response.ok) {
      let detail: string | null = null;
      try {
        const payload = (await response.json()) as unknown;
        detail = extractErrorMessage(payload);
      } catch (_error) {
        try {
          const bodyText = await response.text();
          detail = bodyText.trim().length > 0 ? bodyText.trim() : null;
        } catch (_nestedError) {
          detail = null;
        }
      }
      throw new Error(detail ?? `Request failed for ${url}: ${response.status}`);
    }

    return (await response.json()) as T;
  }

  private async readDiscoveryFallback(sessionId?: string): Promise<ClawzAgentDiscoveryDocument> {
    const candidates = ["/.well-known/agent-interop.json", "/.well-known/clawz-agent.json"];

    for (const candidate of candidates) {
      try {
        return await this.readJson<ClawzAgentDiscoveryDocument>(
          withQuery(this.baseUrl, candidate, {
            ...(sessionId ? { sessionId } : {})
          })
        );
      } catch (error) {
        if (!(error instanceof Error) || !error.message.endsWith(": 404")) {
          throw error;
        }
      }
    }

    throw new Error(`Unable to locate a ClawZ discovery document at ${this.baseUrl}.`);
  }

  private async postJson<T>(route: string, body: unknown): Promise<T> {
    return this.readJson<T>(withQuery(this.baseUrl, route), {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
  }

  private async callMcp<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const payload = await this.postJson<JsonRpcResponse<T>>("/mcp", {
      jsonrpc: "2.0",
      id: nextRpcId++,
      method: "tools/call",
      params: {
        name,
        arguments: args
      }
    });

    return parseJsonRpcStructuredContent(payload);
  }

  async listTools(): Promise<ClawzMcpToolDefinition[]> {
    const payload = await this.postJson<JsonRpcResponse<{ tools: ClawzMcpToolDefinition[] }>>("/mcp", {
      jsonrpc: "2.0",
      id: nextRpcId++,
      method: "tools/list"
    });

    if ("error" in payload) {
      throw new Error(payload.error.message);
    }

    return payload.result.tools ?? payload.result.structuredContent?.tools ?? [];
  }

  async getDiscovery(input: { sessionId?: string } = {}): Promise<ClawzAgentDiscoveryDocument> {
    return this.readDiscoveryFallback(input.sessionId);
  }

  async getProofBundle(input: ClawzProofQuery = {}): Promise<ClawzAgentProofBundle> {
    return this.readJson<ClawzAgentProofBundle>(
      withQuery(this.baseUrl, "/api/interop/agent-proof", {
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {})
      })
    );
  }

  async getVerification(
    input: ClawzAgentProofVerificationRequest = {}
  ): Promise<ClawzAgentProofVerificationResponse> {
    return this.postJson<ClawzAgentProofVerificationResponse>("/api/interop/verify", input);
  }

  async getX402Plan(input: ClawzX402PlanQuery = {}): Promise<AgentX402Plan> {
    if (input.agentId) {
      return this.readJson<AgentX402Plan>(
        withQuery(this.baseUrl, `/api/agents/${encodeURIComponent(input.agentId)}/x402-plan`)
      );
    }

    return this.readJson<AgentX402Plan>(
      withQuery(this.baseUrl, "/api/x402/plan", {
        ...(input.sessionId ? { sessionId: input.sessionId } : {})
      })
    );
  }

  async submitHireRequest(input: ClawzHireRequestInput): Promise<HireRequestReceipt> {
    const agentId = input.agentId.trim();
    if (!agentId) {
      throw new Error("submitHireRequest requires agentId.");
    }
    const taskPrompt = input.taskPrompt.trim();
    const requesterContact = input.requesterContact.trim();
    if (!taskPrompt || !requesterContact) {
      throw new Error("submitHireRequest requires taskPrompt and requesterContact.");
    }

    return this.readJson<HireRequestReceipt>(
      withQuery(this.baseUrl, `/api/agents/${encodeURIComponent(agentId)}/hire`),
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          taskPrompt,
          requesterContact,
          ...(input.budgetMina?.trim() ? { budgetMina: input.budgetMina.trim() } : {}),
          ...(input.paymentPayload ? { paymentPayload: input.paymentPayload } : {})
        })
      }
    );
  }

  async createEnrollmentTicket(input: ClawzEnrollmentTicketInput): Promise<ClawzEnrollmentTicket> {
    const agentName = input.agentName.trim();
    const headline = input.headline.trim();
    if (!agentName || !headline) {
      throw new Error("createEnrollmentTicket requires agentName and headline.");
    }

    const ticket = await this.postJson<Omit<ClawzEnrollmentTicket, "enrollmentCommand">>("/api/enrollment/tickets", {
      agentName,
      headline,
      ...(input.representedPrincipal?.trim() ? { representedPrincipal: input.representedPrincipal.trim() } : {}),
      ...(input.urlReservationSalt?.trim() ? { urlReservationSalt: input.urlReservationSalt.trim() } : {}),
      ...(input.runtimeDelivery ? { runtimeDelivery: input.runtimeDelivery } : {}),
      ...(input.openClawUrl?.trim() ? { openClawUrl: input.openClawUrl.trim() } : {}),
      ...(input.payoutWallets ? { payoutWallets: input.payoutWallets } : {}),
      ...(input.missionAuthOverlay ? { missionAuthOverlay: input.missionAuthOverlay } : {}),
      ...(input.paymentProfile ? { paymentProfile: input.paymentProfile } : {}),
      ...(input.socialAnchorPolicy ? { socialAnchorPolicy: input.socialAnchorPolicy } : {}),
      ...(input.preferredProvingLocation ? { preferredProvingLocation: input.preferredProvingLocation } : {})
    });

    return {
      ...ticket,
      enrollmentCommand: buildOpenClawEnrollmentCommand(ticket, input)
    };
  }

  async getSocialAnchorBatchExport(input: ClawzSocialAnchorQuery = {}): Promise<SocialAnchorBatchExport> {
    return this.readJson<SocialAnchorBatchExport>(
      withQuery(this.baseUrl, "/api/social/anchors/export", {
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {})
      })
    );
  }

  async commitSocialAnchorBatch(
    input: ClawzSocialAnchorQuery & {
      txHash: string;
      expectedBatchId?: string;
      expectedRootDigestSha256?: string;
      operatorNote?: string;
    }
  ): Promise<SocialAnchorQueueState> {
    return this.postJson<SocialAnchorQueueState>("/api/social/anchors/commit", input);
  }

  async updateAgentPricing(input: ClawzAgentPricingUpdate): Promise<ConsoleStateResponse> {
    if (!this.adminKey) {
      throw new Error("updateAgentPricing requires an adminKey from the agent's private .env.santaclawz file.");
    }
    const pricingMode =
      input.pricingMode ??
      (input.fixedPriceUsd?.trim()
        ? "fixed-exact"
        : input.referencePriceUsd?.trim()
          ? "quote-required"
          : undefined);
    const paymentProfile: Record<string, unknown> = {
      ...(pricingMode === "free-test"
        ? { enabled: false }
        : typeof input.openForWork === "boolean"
          ? { enabled: input.openForWork }
          : {}),
      ...(pricingMode ? { pricingMode } : {}),
      ...(input.defaultRail ? { defaultRail: input.defaultRail, supportedRails: [input.defaultRail] } : {}),
      ...(input.fixedPriceUsd ? { fixedAmountUsd: input.fixedPriceUsd } : {}),
      ...(input.referencePriceUsd ? { referencePriceUsd: input.referencePriceUsd } : {}),
      ...(input.referencePriceUnit ? { referencePriceUnit: input.referencePriceUnit } : {}),
      ...(input.paymentNotes ? { paymentNotes: input.paymentNotes } : {}),
      settlementTrigger: "upfront"
    };
    return this.readJson<ConsoleStateResponse>(
      withQuery(this.baseUrl, "/api/console/profile", {
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {})
      }),
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.agentId ? { agentId: input.agentId } : {}),
          ...(input.basePayoutAddress || input.ethereumPayoutAddress
            ? {
                payoutWallets: {
                  ...(input.basePayoutAddress ? { base: input.basePayoutAddress } : {}),
                  ...(input.ethereumPayoutAddress ? { ethereum: input.ethereumPayoutAddress } : {})
                }
              }
            : {}),
          paymentProfile
        })
      }
    );
  }

  async setAgentArchiveStatus(input: ClawzAgentArchiveUpdate): Promise<ConsoleStateResponse> {
    if (!this.adminKey) {
      throw new Error("setAgentArchiveStatus requires an adminKey from the agent's private .env.santaclawz file.");
    }
    const agentId = input.agentId.trim();
    if (!agentId) {
      throw new Error("setAgentArchiveStatus requires agentId.");
    }

    return this.readJson<ConsoleStateResponse>(
      withQuery(this.baseUrl, `/api/agents/${encodeURIComponent(agentId)}/archive`),
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          archived: input.archived !== false
        })
      }
    );
  }

  async archiveAgent(input: Omit<ClawzAgentArchiveUpdate, "archived">): Promise<ConsoleStateResponse> {
    return this.setAgentArchiveStatus({ ...input, archived: true });
  }

  async restoreAgent(input: Omit<ClawzAgentArchiveUpdate, "archived">): Promise<ConsoleStateResponse> {
    return this.setAgentArchiveStatus({ ...input, archived: false });
  }

  async getDeployment(): Promise<unknown> {
    return this.readJson(withQuery(this.baseUrl, "/api/zeko/deployment"));
  }

  async getZekoHealth(): Promise<unknown> {
    return this.readJson(withQuery(this.baseUrl, "/api/zeko/health"));
  }

  async getAgentDiscoveryViaMcp(input: { sessionId?: string } = {}): Promise<ClawzAgentDiscoveryDocument> {
    return this.callMcp<ClawzAgentDiscoveryDocument>("get_agent_discovery", {
      ...(input.sessionId ? { sessionId: input.sessionId } : {})
    });
  }

  async getAgentProofBundleViaMcp(input: ClawzProofQuery = {}): Promise<ClawzAgentProofBundle> {
    return this.callMcp<ClawzAgentProofBundle>("get_agent_proof_bundle", {
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {})
    });
  }

  async verifyAgentProofViaMcp(
    input: ClawzAgentProofVerificationRequest = {}
  ): Promise<ClawzAgentProofVerificationResponse> {
    return this.callMcp<ClawzAgentProofVerificationResponse>("verify_agent_proof", input as Record<string, unknown>);
  }

  async verifyLiveProof(
    input: ClawzProofQuery & {
      witnessPlan?: WitnessPlanLike;
    } = {}
  ): Promise<LocalAgentVerificationResult> {
    const [discovery, bundle] = await Promise.all([
      this.getDiscovery({
        ...(input.sessionId ? { sessionId: input.sessionId } : {})
      }),
      this.getProofBundle(input)
    ]);
    const report = verifyAgentProofBundle(bundle, {
      discovery,
      ...(input.witnessPlan ? { witnessPlan: input.witnessPlan } : {})
    });

    return {
      discovery,
      bundle,
      report,
      question: summarizeAgentProofBundle(bundle)
    };
  }
}

export function createClawzAgentClient(options: ClawzAgentClientOptions) {
  return new ClawzAgentClient(options);
}

export async function verifyRemoteClawzAgent(
  options: ClawzAgentClientOptions &
    ClawzProofQuery & {
      witnessPlan?: WitnessPlanLike;
    }
): Promise<LocalAgentVerificationResult> {
  const client = createClawzAgentClient(options);
  return client.verifyLiveProof({
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.turnId ? { turnId: options.turnId } : {}),
    ...(isRecord(options.witnessPlan) ? { witnessPlan: options.witnessPlan as WitnessPlanLike } : {})
  });
}
