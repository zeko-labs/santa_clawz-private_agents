export type ClawzPlatformPaymentStatus = "unknown" | "authorized" | "settled" | "paid" | "failed" | "refunded";
export type ClawzPlatformSettlementStatus = "unknown" | "authorized" | "settled" | "failed" | "refunded";
export type ClawzPlatformRelayDeliveryStatus =
  | "not_confirmed"
  | "not_attempted"
  | "forwarded"
  | "recorded"
  | "acknowledged"
  | "failed"
  | "return_rejected"
  | "reconciled_completed";
export type ClawzPlatformAgentExecutionStatus =
  | "not_confirmed"
  | "not_started"
  | "submitted"
  | "running"
  | "running_or_unknown"
  | "completed"
  | "failed"
  | "late_completion_available"
  | "worker_completed_return_rejected";

export interface ClawzRetryablePlatformFailure {
  ok: false;
  code: "relay_unavailable_retryable" | "post_payment_state_unavailable_retryable" | "platform_unavailable_retryable";
  retryable: true;
  status: number;
  requestMethod?: string;
  requestUrl?: string;
  operation?: string;
  messageAccepted?: boolean;
  proofIntent?: "unknown" | "per_message" | "aggregate" | "agent_chatter";
  anchorStatus?: "not_started" | "unknown" | "pending" | "submitted" | "retrying" | "confirmed" | "failed" | "expired_not_anchored" | "aggregate_anchored" | "not_proof_requested";
  paymentStatus: ClawzPlatformPaymentStatus;
  settlementStatus: ClawzPlatformSettlementStatus;
  relayDeliveryStatus: ClawzPlatformRelayDeliveryStatus;
  agentExecutionStatus: ClawzPlatformAgentExecutionStatus;
  paymentPayloadDigestSha256?: string;
  requestId?: string;
  paymentStateUrl?: string;
  resultStateUrl?: string;
  safeToRetrySamePayload?: boolean;
  doNotCreateNewPayment?: boolean;
  error: string;
  responsePreview?: string;
}

export class ClawzRetryablePlatformError extends Error {
  readonly failure: ClawzRetryablePlatformFailure;

  constructor(failure: ClawzRetryablePlatformFailure) {
    super(failure.error);
    this.name = "ClawzRetryablePlatformError";
    this.failure = failure;
  }
}

export function isRetryablePlatformStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

export function createRetryablePlatformFailure(input: {
  status: number;
  responseText?: string | null;
  requestMethod?: string;
  requestUrl?: string;
  code?: ClawzRetryablePlatformFailure["code"];
  operation?: string;
  messageAccepted?: boolean;
  proofIntent?: ClawzRetryablePlatformFailure["proofIntent"];
  anchorStatus?: ClawzRetryablePlatformFailure["anchorStatus"];
  paymentStatus?: ClawzPlatformPaymentStatus;
  settlementStatus?: ClawzPlatformSettlementStatus;
  relayDeliveryStatus?: ClawzPlatformRelayDeliveryStatus;
  agentExecutionStatus?: ClawzPlatformAgentExecutionStatus;
  paymentPayloadDigestSha256?: string;
  requestId?: string;
  paymentStateUrl?: string;
  resultStateUrl?: string;
  safeToRetrySamePayload?: boolean;
  doNotCreateNewPayment?: boolean;
  error?: string;
}): ClawzRetryablePlatformFailure {
  const responsePreview = input.responseText?.trim().slice(0, 1000);
  const code = input.code ?? "relay_unavailable_retryable";
  return {
    ok: false,
    code,
    retryable: true,
    status: input.status,
    ...(input.requestMethod ? { requestMethod: input.requestMethod } : {}),
    ...(input.requestUrl ? { requestUrl: input.requestUrl } : {}),
    ...(input.operation ? { operation: input.operation } : {}),
    ...(typeof input.messageAccepted === "boolean" ? { messageAccepted: input.messageAccepted } : {}),
    ...(input.proofIntent ? { proofIntent: input.proofIntent } : {}),
    ...(input.anchorStatus ? { anchorStatus: input.anchorStatus } : {}),
    paymentStatus: input.paymentStatus ?? "unknown",
    settlementStatus: input.settlementStatus ?? "unknown",
    relayDeliveryStatus: input.relayDeliveryStatus ?? "not_confirmed",
    agentExecutionStatus: input.agentExecutionStatus ?? "not_confirmed",
    ...(input.paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256: input.paymentPayloadDigestSha256 } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.paymentStateUrl ? { paymentStateUrl: input.paymentStateUrl } : {}),
    ...(input.resultStateUrl ? { resultStateUrl: input.resultStateUrl } : {}),
    ...(typeof input.safeToRetrySamePayload === "boolean" ? { safeToRetrySamePayload: input.safeToRetrySamePayload } : {}),
    ...(typeof input.doNotCreateNewPayment === "boolean" ? { doNotCreateNewPayment: input.doNotCreateNewPayment } : {}),
    error:
      input.error ??
      (code === "post_payment_state_unavailable_retryable"
        ? "SantaClawz could not confirm post-payment execution state yet. Retry the same state lookup after service recovery; do not create a new payment or hire request."
        : code === "platform_unavailable_retryable"
          ? "SantaClawz platform availability was interrupted before the operation returned typed JSON. Retry the same idempotent operation after service recovery."
        : "SantaClawz could not confirm this job yet. The relay is temporarily unavailable. Wait until service is restored, then retry with the same payment payload so we can safely resume without duplicating payment."),
    ...(responsePreview ? { responsePreview } : {})
  };
}

export function throwRetryablePlatformFailure(input: {
  status: number;
  responseText?: string | null;
  requestMethod?: string;
  requestUrl?: string;
  code?: ClawzRetryablePlatformFailure["code"];
  operation?: string;
  messageAccepted?: boolean;
  proofIntent?: ClawzRetryablePlatformFailure["proofIntent"];
  anchorStatus?: ClawzRetryablePlatformFailure["anchorStatus"];
  paymentStatus?: ClawzPlatformPaymentStatus;
  settlementStatus?: ClawzPlatformSettlementStatus;
  relayDeliveryStatus?: ClawzPlatformRelayDeliveryStatus;
  agentExecutionStatus?: ClawzPlatformAgentExecutionStatus;
  paymentPayloadDigestSha256?: string;
  requestId?: string;
  paymentStateUrl?: string;
  resultStateUrl?: string;
  safeToRetrySamePayload?: boolean;
  doNotCreateNewPayment?: boolean;
  error?: string;
}): never {
  throw new ClawzRetryablePlatformError(createRetryablePlatformFailure(input));
}

export function isRetryablePlatformTransportError(error: unknown): boolean {
  const maybeError = error as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown } | undefined;
  const code = typeof maybeError?.code === "string" ? maybeError.code : "";
  const cause = maybeError?.cause as { code?: unknown; message?: unknown } | undefined;
  const causeCode = typeof cause?.code === "string" ? cause.code : "";
  const text = [
    typeof maybeError?.name === "string" ? maybeError.name : "",
    typeof maybeError?.message === "string" ? maybeError.message : "",
    typeof cause?.message === "string" ? cause.message : "",
    code,
    causeCode
  ].join(" ").toLowerCase();
  return /fetch failed|networkerror|enotfound|eai_again|econnreset|econnrefused|etimedout|socket hang up|temporarily unavailable|dns/.test(text);
}

export function isClawzRetryablePlatformError(error: unknown): error is ClawzRetryablePlatformError {
  return error instanceof ClawzRetryablePlatformError;
}

export interface ClawzRetryOptions {
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  onRetry?: (input: { attempt: number; delayMs: number; error: ClawzRetryablePlatformError }) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number, options: Required<Pick<ClawzRetryOptions, "initialDelayMs" | "maxDelayMs" | "jitterRatio">>): number {
  const exponential = Math.min(options.maxDelayMs, options.initialDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = exponential * options.jitterRatio * Math.random();
  return Math.round(exponential + jitter);
}

export async function withClawzPlatformRetry<T>(
  operation: () => Promise<T>,
  options: ClawzRetryOptions = {}
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 5));
  const delayOptions = {
    initialDelayMs: Math.max(0, options.initialDelayMs ?? 1000),
    maxDelayMs: Math.max(0, options.maxDelayMs ?? 30_000),
    jitterRatio: Math.max(0, options.jitterRatio ?? 0.2)
  };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isClawzRetryablePlatformError(error) || attempt >= attempts) {
        throw error;
      }
      const delayMs = retryDelayMs(attempt, delayOptions);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }

  return operation();
}
