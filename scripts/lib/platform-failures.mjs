export function isRetryablePlatformStatus(status) {
  return status === 502 || status === 503 || status === 504;
}

export function createRetryablePlatformFailure(status, responseText, overrides = {}) {
  const responsePreview = responseText?.trim().slice(0, 1000);
  const code = overrides.code ?? "relay_unavailable_retryable";
  return {
    ok: false,
    code,
    retryable: true,
    status,
    paymentStatus: overrides.paymentStatus ?? "unknown",
    settlementStatus: overrides.settlementStatus ?? "unknown",
    relayDeliveryStatus: overrides.relayDeliveryStatus ?? "not_confirmed",
    agentExecutionStatus: overrides.agentExecutionStatus ?? "not_confirmed",
    error:
      overrides.error ??
      (code === "post_payment_state_unavailable_retryable"
        ? "SantaClawz could not confirm post-payment execution state yet. Retry the same state lookup after service recovery; do not create a new payment or hire request."
        : "SantaClawz relay is temporarily unavailable and the payment or delivery state could not be confirmed. Retry with the same idempotent payment payload."),
    ...(responsePreview ? { responsePreview } : {})
  };
}

export function isRetryablePlatformTransportError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  const causeCode = typeof error?.cause?.code === "string" ? error.cause.code : "";
  const text = [
    typeof error?.name === "string" ? error.name : "",
    typeof error?.message === "string" ? error.message : "",
    typeof error?.cause?.message === "string" ? error.cause.message : "",
    code,
    causeCode
  ].join(" ").toLowerCase();
  return /fetch failed|networkerror|enotfound|eai_again|econnreset|econnrefused|etimedout|socket hang up|temporarily unavailable|dns/.test(text);
}
