import {
  buildSantaClawzQuoteAcceptanceMessage,
  canonicalDigest,
  type AgentPaymentRail,
  type ExecutionIntentRecord,
  type HireRequestReceipt,
  type SantaClawzQuoteAcceptanceMessageInput,
  type SantaClawzQuoteAcceptanceWalletProof
} from "@clawz/protocol";

import { isRetryablePlatformStatus, isRetryablePlatformTransportError, throwRetryablePlatformFailure } from "./platform-errors.js";

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
  buildFeeSplitPaymentPayload(
    input: Omit<ClawzFeeSplitPaymentPayloadInput, "paymentRequirement" | "sessionId">
  ): Promise<Record<string, unknown>>;
  settle(paymentPayload: Record<string, unknown>): Promise<ClawzQuoteIntentSettlementResponse>;
}

export interface ClawzQuoteAcceptanceWalletProofInput extends SantaClawzQuoteAcceptanceMessageInput {
  signMessage(message: string): Promise<string> | string;
  signedAtIso?: string;
}

export interface ClawzTypedDataSignerInput {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface ClawzFeeSplitPaymentPayloadInput {
  paymentRequirement: Record<string, unknown>;
  sessionId: string;
  payer: string;
  signTypedData(input: ClawzTypedDataSignerInput): Promise<string> | string;
  paymentId?: string;
  issuedAtIso?: string;
  expiresAtIso?: string;
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (isRetryablePlatformTransportError(error)) {
      throwRetryablePlatformFailure({
        status: 0,
        responseText: error instanceof Error ? error.message : String(error),
        requestMethod: init.method ?? "GET",
        requestUrl: url
      });
    }
    throw error;
  }
  const responseText = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(responseText) as unknown;
  } catch (_error) {
    payload = undefined;
  }

  if (!response.ok && !acceptedStatuses.includes(response.status)) {
    if (payload === undefined && isRetryablePlatformStatus(response.status)) {
      throwRetryablePlatformFailure({
        status: response.status,
        responseText,
        requestMethod: init.method ?? "GET",
        requestUrl: url
      });
    }
    const detail = extractErrorMessage(payload) ?? responseText;
    throw new Error(detail.trim() || `Request failed for ${url}: ${response.status}`);
  }

  if (payload === undefined) {
    throw new Error(`Request failed for ${url}: response was not valid JSON`);
  }
  return payload as T;
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

function randomNonceHex() {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Fee-split x402 signing requires globalThis.crypto.getRandomValues for EIP-3009 nonces.");
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
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
    throw new Error("Payment requirement does not include an x402-exact-evm-fee-split-v1 accept option.");
  }
  const evm = isRecord(accept.extensions) && isRecord(accept.extensions.evm) ? accept.extensions.evm : undefined;
  const feeSplit = evm && isRecord(evm.feeSplit) ? evm.feeSplit : undefined;
  if (!evm || !feeSplit) {
    throw new Error("Fee-split x402 accept option is missing extensions.evm.feeSplit.");
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

function paymentContextDigest(payload: Record<string, unknown>) {
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

function authorizationDigest(payload: Record<string, unknown>) {
  const { x402Version: _x402Version, ...digestPayload } = payload;
  return canonicalDigest(digestPayload).sha256Hex;
}

function buildEip3009Authorization(input: {
  accept: Record<string, unknown>;
  evm: Record<string, unknown>;
  typedData: ClawzTypedDataSignerInput;
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

export async function buildClawzFeeSplitExactPaymentPayload(
  input: ClawzFeeSplitPaymentPayloadInput
): Promise<Record<string, unknown>> {
  const { accept, evm, feeSplit } = findFeeSplitAccept(input.paymentRequirement);
  const issuedAtIso = input.issuedAtIso ?? new Date().toISOString();
  const expiresAtIso = input.expiresAtIso ?? new Date(Date.parse(issuedAtIso) + 15 * 60 * 1000).toISOString();
  const validAfter = String(Math.floor(Date.parse(issuedAtIso) / 1000));
  const validBefore = String(Math.floor(Date.parse(expiresAtIso) / 1000));
  const sellerPayTo = stringField(feeSplit, "sellerPayTo", "feeSplit");
  const protocolFeePayTo = stringField(feeSplit, "protocolFeePayTo", "feeSplit");
  const sellerAmount = stringField(feeSplit, "sellerAmount", "feeSplit");
  const protocolFeeAmount = stringField(feeSplit, "protocolFeeAmount", "feeSplit");
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
  const [sellerSignature, feeSignature] = await Promise.all([
    input.signTypedData(sellerTypedData),
    input.signTypedData(feeTypedData)
  ]);
  const paymentId = input.paymentId ?? `pay_${canonicalDigest({
    requestId: input.paymentRequirement.requestId,
    payer: input.payer,
    issuedAtIso,
    sellerNonce: sellerTypedData.message.nonce,
    feeNonce: feeTypedData.message.nonce
  }).sha256Hex.slice(0, 24)}`;
  const extensions = {
    santaclawz: {
      paymentId,
      idempotencyKey: paymentId,
      feeSplit: {
        settlementModel: "x402-exact-evm-fee-split-v1",
        sellerPayTo,
        protocolFeePayTo,
        sellerAmount,
        protocolFeeAmount
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
    amount: accept.amount ?? accept.price,
    payer: input.payer,
    payTo: accept.payTo,
    sessionId: input.sessionId,
    issuedAtIso,
    expiresAtIso,
    extensions
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
      buildFeeSplitPaymentPayload: (feeSplitInput: Omit<ClawzFeeSplitPaymentPayloadInput, "paymentRequirement" | "sessionId">) =>
        buildClawzFeeSplitExactPaymentPayload({
          ...feeSplitInput,
          paymentRequirement: acceptedQuote.paymentRequirement,
          sessionId: acceptedQuote.intent.sessionId
        }),
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
