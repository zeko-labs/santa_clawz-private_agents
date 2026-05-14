export type ClawzPlatformPaymentStatus = "unknown" | "authorized" | "settled" | "paid" | "failed" | "refunded";
export type ClawzPlatformSettlementStatus = "unknown" | "authorized" | "settled" | "failed" | "refunded";
export type ClawzPlatformRelayDeliveryStatus =
  | "not_confirmed"
  | "not_attempted"
  | "forwarded"
  | "recorded"
  | "failed"
  | "return_rejected";
export type ClawzPlatformAgentExecutionStatus =
  | "not_confirmed"
  | "not_started"
  | "running"
  | "completed"
  | "failed"
  | "worker_completed_return_rejected";

export interface ClawzRetryablePlatformFailure {
  ok: false;
  code: "relay_unavailable_retryable";
  retryable: true;
  status: number;
  requestMethod?: string;
  requestUrl?: string;
  paymentStatus: ClawzPlatformPaymentStatus;
  settlementStatus: ClawzPlatformSettlementStatus;
  relayDeliveryStatus: ClawzPlatformRelayDeliveryStatus;
  agentExecutionStatus: ClawzPlatformAgentExecutionStatus;
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
  paymentStatus?: ClawzPlatformPaymentStatus;
  settlementStatus?: ClawzPlatformSettlementStatus;
  relayDeliveryStatus?: ClawzPlatformRelayDeliveryStatus;
  agentExecutionStatus?: ClawzPlatformAgentExecutionStatus;
}): ClawzRetryablePlatformFailure {
  const responsePreview = input.responseText?.trim().slice(0, 1000);
  return {
    ok: false,
    code: "relay_unavailable_retryable",
    retryable: true,
    status: input.status,
    ...(input.requestMethod ? { requestMethod: input.requestMethod } : {}),
    ...(input.requestUrl ? { requestUrl: input.requestUrl } : {}),
    paymentStatus: input.paymentStatus ?? "unknown",
    settlementStatus: input.settlementStatus ?? "unknown",
    relayDeliveryStatus: input.relayDeliveryStatus ?? "not_confirmed",
    agentExecutionStatus: input.agentExecutionStatus ?? "not_confirmed",
    error:
      "SantaClawz could not confirm this job yet. The relay is temporarily unavailable. Wait until service is restored, then retry with the same payment payload so we can safely resume without duplicating payment.",
    ...(responsePreview ? { responsePreview } : {})
  };
}

export function throwRetryablePlatformFailure(input: {
  status: number;
  responseText?: string | null;
  requestMethod?: string;
  requestUrl?: string;
  paymentStatus?: ClawzPlatformPaymentStatus;
  settlementStatus?: ClawzPlatformSettlementStatus;
  relayDeliveryStatus?: ClawzPlatformRelayDeliveryStatus;
  agentExecutionStatus?: ClawzPlatformAgentExecutionStatus;
}): never {
  throw new ClawzRetryablePlatformError(createRetryablePlatformFailure(input));
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
