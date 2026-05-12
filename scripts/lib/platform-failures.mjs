export function isRetryablePlatformStatus(status) {
  return status === 502 || status === 503 || status === 504;
}

export function createRetryablePlatformFailure(status, responseText, overrides = {}) {
  const responsePreview = responseText?.trim().slice(0, 1000);
  return {
    ok: false,
    code: "relay_unavailable_retryable",
    retryable: true,
    status,
    paymentStatus: overrides.paymentStatus ?? "unknown",
    settlementStatus: overrides.settlementStatus ?? "unknown",
    relayDeliveryStatus: overrides.relayDeliveryStatus ?? "not_confirmed",
    agentExecutionStatus: overrides.agentExecutionStatus ?? "not_confirmed",
    error:
      overrides.error ??
      "SantaClawz relay is temporarily unavailable and the payment or delivery state could not be confirmed. Retry with the same idempotent payment payload.",
    ...(responsePreview ? { responsePreview } : {})
  };
}
