import {
  buildSantaClawzQuoteAcceptanceMessage,
  type AgentPaymentRail,
  type ExecutionIntentRecord,
  type HireRequestReceipt,
  type SantaClawzQuoteAcceptanceMessageInput,
  type SantaClawzQuoteAcceptanceWalletProof
} from "@clawz/protocol";

export interface ClawzQuotePaymentClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface ClawzQuoteHireInput {
  agentId: string;
  taskPrompt: string;
  requesterContact: string;
  budgetMina?: string;
}

export interface ClawzQuoteAcceptanceInput {
  agentId: string;
  requestId: string;
  buyerAgentId?: string;
  buyerWallet?: string;
  buyerWalletProof?: SantaClawzQuoteAcceptanceWalletProof;
  acceptedAmountUsd: string;
  acceptedQuoteDigestSha256: string;
  maxAmountUsd?: string;
  rail?: Extract<AgentPaymentRail, "base-usdc" | "ethereum-usdc">;
  settlementModel?: "upfront-x402" | "reserve-release-escrow";
}

export interface ClawzQuotePaymentRequestInput {
  hire: ClawzQuoteHireInput;
  buyerAgentId?: string;
  buyerWallet?: string;
  buyerWalletProof?: SantaClawzQuoteAcceptanceWalletProof;
  maxAmountUsd?: string;
  rail?: Extract<AgentPaymentRail, "base-usdc" | "ethereum-usdc">;
  settlementModel?: "upfront-x402" | "reserve-release-escrow";
}

export interface ClawzQuoteAcceptanceResponse {
  ok: true;
  intent: ExecutionIntentRecord;
  paymentRequirement: Record<string, unknown>;
}

export interface ClawzQuoteIntentSettlementResponse {
  ok: true;
  intent: ExecutionIntentRecord;
  payment?: Record<string, unknown>;
  paidExecution?: HireRequestReceipt;
}

export interface ClawzQuotePaymentPreparation {
  quote: HireRequestReceipt;
  acceptedQuote: ClawzQuoteAcceptanceResponse;
  intentId: string;
  paymentRequirement: Record<string, unknown>;
  settle(paymentPayload: Record<string, unknown>): Promise<ClawzQuoteIntentSettlementResponse>;
}

export interface ClawzQuoteAcceptanceWalletProofInput extends SantaClawzQuoteAcceptanceMessageInput {
  signMessage(message: string): Promise<string> | string;
  signedAtIso?: string;
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function extractErrorMessage(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const error = (payload as { error?: unknown }).error;
  return typeof error === "string" && error.trim().length > 0 ? error : null;
}

async function readJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  acceptedStatuses: number[] = []
): Promise<T> {
  const response = await fetchImpl(url, init);
  if (!response.ok && !acceptedStatuses.includes(response.status)) {
    let detail: string | null = null;
    try {
      detail = extractErrorMessage(await response.json());
    } catch (_error) {
      detail = await response.text().catch(() => null);
    }
    throw new Error(detail?.trim() || `Request failed for ${url}: ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function buildClawzQuoteAcceptanceWalletProof(
  input: ClawzQuoteAcceptanceWalletProofInput
): Promise<SantaClawzQuoteAcceptanceWalletProof> {
  const message = buildSantaClawzQuoteAcceptanceMessage(input);
  return {
    scheme: "eip191-personal-sign",
    message,
    signature: await input.signMessage(message),
    ...(input.signedAtIso ? { signedAtIso: input.signedAtIso } : {})
  };
}

export function createClawzQuotePaymentClient(options: ClawzQuotePaymentClientOptions) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;

  async function requestQuote(input: ClawzQuoteHireInput): Promise<HireRequestReceipt> {
    const agentId = input.agentId.trim();
    if (!agentId) {
      throw new Error("requestQuote requires agentId.");
    }
    return readJson<HireRequestReceipt>(
      fetchImpl,
      `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskPrompt: input.taskPrompt,
          requesterContact: input.requesterContact,
          ...(input.budgetMina?.trim() ? { budgetMina: input.budgetMina.trim() } : {})
        })
      }
    );
  }

  async function acceptQuote(input: ClawzQuoteAcceptanceInput): Promise<ClawzQuoteAcceptanceResponse> {
    const agentId = input.agentId.trim();
    const requestId = input.requestId.trim();
    if (!agentId || !requestId) {
      throw new Error("acceptQuote requires agentId and requestId.");
    }
    return readJson<ClawzQuoteAcceptanceResponse>(
      fetchImpl,
      `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/quotes/${encodeURIComponent(requestId)}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(input.buyerAgentId?.trim() ? { buyerAgentId: input.buyerAgentId.trim() } : {}),
          ...(input.buyerWallet?.trim() ? { buyerWallet: input.buyerWallet.trim() } : {}),
          ...(input.buyerWalletProof ? { buyerWalletProof: input.buyerWalletProof } : {}),
          acceptedAmountUsd: input.acceptedAmountUsd,
          acceptedQuoteDigestSha256: input.acceptedQuoteDigestSha256,
          ...(input.maxAmountUsd?.trim() ? { maxAmountUsd: input.maxAmountUsd.trim() } : {}),
          ...(input.rail ? { rail: input.rail } : {}),
          ...(input.settlementModel ? { settlementModel: input.settlementModel } : {})
        })
      },
      [402]
    );
  }

  async function settleQuoteIntent(input: {
    intentId: string;
    paymentPayload: Record<string, unknown>;
  }): Promise<ClawzQuoteIntentSettlementResponse> {
    const intentId = input.intentId.trim();
    if (!intentId) {
      throw new Error("settleQuoteIntent requires intentId.");
    }
    return readJson<ClawzQuoteIntentSettlementResponse>(
      fetchImpl,
      `${baseUrl}/api/x402/quote-intent?${new URLSearchParams({ intentId }).toString()}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentPayload: input.paymentPayload })
      }
    );
  }

  async function requestQuotePayment(input: ClawzQuotePaymentRequestInput): Promise<ClawzQuotePaymentPreparation> {
    const quote = await requestQuote(input.hire);
    if (quote.status !== "quoted" || quote.protocolReturn?.status !== "quoted" || !quote.protocolReturn.quote) {
      throw new Error("requestQuotePayment expected the agent to return a quote.");
    }
    const acceptedQuote = await acceptQuote({
      agentId: input.hire.agentId,
      requestId: quote.requestId,
      ...(input.buyerAgentId?.trim() ? { buyerAgentId: input.buyerAgentId.trim() } : {}),
      ...(input.buyerWallet?.trim() ? { buyerWallet: input.buyerWallet.trim() } : {}),
      ...(input.buyerWalletProof ? { buyerWalletProof: input.buyerWalletProof } : {}),
      acceptedAmountUsd: quote.protocolReturn.quote.amountUsd,
      acceptedQuoteDigestSha256: quote.protocolReturn.digestSha256,
      ...(input.maxAmountUsd?.trim() ? { maxAmountUsd: input.maxAmountUsd.trim() } : {}),
      ...(input.rail ? { rail: input.rail } : {}),
      ...(input.settlementModel ? { settlementModel: input.settlementModel } : {})
    });
    return {
      quote,
      acceptedQuote,
      intentId: acceptedQuote.intent.intentId,
      paymentRequirement: acceptedQuote.paymentRequirement,
      settle: (paymentPayload: Record<string, unknown>) =>
        settleQuoteIntent({
          intentId: acceptedQuote.intent.intentId,
          paymentPayload
        })
    };
  }

  return {
    requestQuote,
    acceptQuote,
    settleQuoteIntent,
    requestQuotePayment
  };
}
