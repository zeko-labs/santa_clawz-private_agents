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
    ...(overrides.operation ? { operation: overrides.operation } : {}),
    ...(typeof overrides.messageAccepted === "boolean" ? { messageAccepted: overrides.messageAccepted } : {}),
    ...(overrides.proofIntent ? { proofIntent: overrides.proofIntent } : {}),
    ...(overrides.anchorStatus ? { anchorStatus: overrides.anchorStatus } : {}),
    paymentStatus: overrides.paymentStatus ?? "unknown",
    settlementStatus: overrides.settlementStatus ?? "unknown",
    relayDeliveryStatus: overrides.relayDeliveryStatus ?? "not_confirmed",
    agentExecutionStatus: overrides.agentExecutionStatus ?? "not_confirmed",
    ...(overrides.paymentPayloadDigestSha256 ? { paymentPayloadDigestSha256: overrides.paymentPayloadDigestSha256 } : {}),
    ...(overrides.requestId ? { requestId: overrides.requestId } : {}),
    ...(overrides.paymentStateUrl ? { paymentStateUrl: overrides.paymentStateUrl } : {}),
    ...(overrides.resultStateUrl ? { resultStateUrl: overrides.resultStateUrl } : {}),
    ...(typeof overrides.safeToRetrySamePayload === "boolean" ? { safeToRetrySamePayload: overrides.safeToRetrySamePayload } : {}),
    error:
      overrides.error ??
      (code === "post_payment_state_unavailable_retryable"
        ? "SantaClawz could not confirm post-payment execution state yet. Retry the same state lookup after service recovery; do not create a new payment or hire request."
        : code === "platform_unavailable_retryable"
          ? "SantaClawz platform availability was interrupted before the operation returned typed JSON. Retry the same idempotent operation after service recovery."
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
  return /abort|aborted|timeout|timed out|fetch failed|networkerror|enotfound|eai_again|econnreset|econnrefused|etimedout|socket hang up|temporarily unavailable|dns/.test(text);
}
