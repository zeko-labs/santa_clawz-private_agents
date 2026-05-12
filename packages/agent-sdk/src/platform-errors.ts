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
    paymentStatus: input.paymentStatus ?? "unknown",
    settlementStatus: input.settlementStatus ?? "unknown",
    relayDeliveryStatus: input.relayDeliveryStatus ?? "not_confirmed",
    agentExecutionStatus: input.agentExecutionStatus ?? "not_confirmed",
    error:
      "SantaClawz relay is temporarily unavailable and the payment or delivery state could not be confirmed. Retry with the same idempotent payment payload.",
    ...(responsePreview ? { responsePreview } : {})
  };
}

export function throwRetryablePlatformFailure(input: {
  status: number;
  responseText?: string | null;
  paymentStatus?: ClawzPlatformPaymentStatus;
  settlementStatus?: ClawzPlatformSettlementStatus;
  relayDeliveryStatus?: ClawzPlatformRelayDeliveryStatus;
  agentExecutionStatus?: ClawzPlatformAgentExecutionStatus;
}): never {
  throw new ClawzRetryablePlatformError(createRetryablePlatformFailure(input));
}
