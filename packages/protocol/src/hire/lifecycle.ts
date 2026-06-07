export const SANTACLAWZ_PAID_LIFECYCLE_REDUCER_SCHEMA_VERSION = "santaclawz-paid-lifecycle-reducer/0.4" as const;

export type SantaClawzPaidProtocolState =
  | "AWAITING_PAYMENT"
  | "AUTHORIZED_WAITING_FOR_DELIVERY"
  | "DELIVERED_AWAITING_SETTLEMENT"
  | "DELIVERED_SETTLED"
  | "SELLER_FAILED_NO_SETTLEMENT"
  | "PLATFORM_FAILED_RECONCILE"
  | "EXPIRED_NO_CHARGE";

export type SantaClawzBuyerAction =
  | "submit_payment"
  | "poll_or_wait"
  | "retry_same_payment_payload"
  | "view_delivery"
  | "create_fresh_payment"
  | "stop_and_contact_operator";

export type SantaClawzSellerOutcome =
  | "not_started"
  | "pending"
  | "completed"
  | "completed_delivery_pending"
  | "failed"
  | "not_at_fault";

export type SantaClawzOperatorObligation =
  | "none"
  | "persist_buyer_delivery"
  | "settle_payment"
  | "reconcile_platform_state"
  | "refund_or_clear_payment";

export interface SantaClawzPaidLifecycleReducerInput {
  paymentStatus?: string | undefined;
  settlementStatus?: string | undefined;
  relayDeliveryStatus?: string | undefined;
  agentExecutionStatus?: string | undefined;
  proofStatus?: string | undefined;
  sellerExecutionCompleted?: boolean | undefined;
  buyerDeliveryAvailable?: boolean | undefined;
  buyerComplete?: boolean | undefined;
  buyerAccepted?: boolean | undefined;
  paymentAuthorized?: boolean | undefined;
  paymentSettled?: boolean | undefined;
  hasFailure?: boolean | undefined;
  returnRejected?: boolean | undefined;
  expiredAuthorizationNoCharge?: boolean | undefined;
  safeToRetrySamePayload?: boolean | undefined;
  paymentPayloadRetryRejected?: boolean | undefined;
  platformTimedOutAfterWorkerAck?: boolean | undefined;
  platformFailure?: boolean | undefined;
}

export interface SantaClawzPaidLifecycleProjection {
  schemaVersion: typeof SANTACLAWZ_PAID_LIFECYCLE_REDUCER_SCHEMA_VERSION;
  protocolState: SantaClawzPaidProtocolState;
  terminal: boolean;
  buyerAction: SantaClawzBuyerAction;
  sellerOutcome: SantaClawzSellerOutcome;
  operatorObligation: SantaClawzOperatorObligation;
  buyerAnswer: {
    canCreateFreshPayment: boolean;
    canRetrySamePaymentPayload: boolean;
    shouldWait: boolean;
    hasBuyerDelivery: boolean;
  };
  sellerAnswer: {
    completedValidWork: boolean;
    failedWork: boolean;
    reputationImpact: "none" | "none_until_delivery_fault_attributed" | "seller_failure";
  };
  operatorAnswer: {
    reconciliationRequired: boolean;
    reason?: string;
  };
}

function normalizeLifecycleStatus(value: string | undefined) {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function isOneOf(value: string | undefined, values: readonly string[]) {
  const normalized = normalizeLifecycleStatus(value);
  return Boolean(normalized && values.includes(normalized));
}

export function reduceSantaClawzPaidLifecycle(
  input: SantaClawzPaidLifecycleReducerInput
): SantaClawzPaidLifecycleProjection {
  const paymentSettled = Boolean(
    input.paymentSettled ||
      isOneOf(input.paymentStatus, ["settled", "already_settled"]) ||
      isOneOf(input.settlementStatus, ["settled"])
  );
  const paymentAuthorized = Boolean(
    input.paymentAuthorized ||
      paymentSettled ||
      isOneOf(input.paymentStatus, ["authorized", "authorization_verified", "payment_verified"]) ||
      isOneOf(input.settlementStatus, ["authorized"])
  );
  const returnRejected = Boolean(
    input.returnRejected ||
      isOneOf(input.proofStatus, ["return_rejected"]) ||
      isOneOf(input.relayDeliveryStatus, ["return_rejected"]) ||
      isOneOf(input.agentExecutionStatus, ["worker_completed_return_rejected"])
  );
  const sellerFailure = Boolean(
    input.hasFailure || returnRejected || isOneOf(input.agentExecutionStatus, ["failed"])
  );
  const platformFailure = Boolean(
    input.platformFailure ||
      (isOneOf(input.relayDeliveryStatus, ["failed"]) && !input.platformTimedOutAfterWorkerAck && !sellerFailure)
  );
  const buyerDeliveryAvailable = Boolean(input.buyerDeliveryAvailable || input.buyerComplete);
  const sellerCompleted = Boolean(
    input.sellerExecutionCompleted ||
      input.buyerComplete ||
      (isOneOf(input.agentExecutionStatus, ["completed"]) &&
        isOneOf(input.proofStatus, ["return_validated", "anchored_or_attested"]))
  );
  const canRetrySamePaymentPayload = Boolean(
    input.safeToRetrySamePayload && !input.paymentPayloadRetryRejected && !input.expiredAuthorizationNoCharge
  );

  if (input.expiredAuthorizationNoCharge) {
    return paidLifecycleProjection({
      protocolState: "EXPIRED_NO_CHARGE",
      terminal: true,
      buyerAction: "create_fresh_payment",
      sellerOutcome: "not_at_fault",
      operatorObligation: "none",
      canCreateFreshPayment: true,
      canRetrySamePaymentPayload: false,
      shouldWait: false,
      hasBuyerDelivery: false,
      completedValidWork: false,
      failedWork: false,
      reputationImpact: "none"
    });
  }

  if (buyerDeliveryAvailable && paymentSettled) {
    return paidLifecycleProjection({
      protocolState: "DELIVERED_SETTLED",
      terminal: true,
      buyerAction: "view_delivery",
      sellerOutcome: "completed",
      operatorObligation: "none",
      canCreateFreshPayment: true,
      canRetrySamePaymentPayload: false,
      shouldWait: false,
      hasBuyerDelivery: true,
      completedValidWork: true,
      failedWork: false,
      reputationImpact: "none"
    });
  }

  if (buyerDeliveryAvailable && sellerCompleted && !paymentSettled) {
    return paidLifecycleProjection({
      protocolState: "DELIVERED_AWAITING_SETTLEMENT",
      terminal: false,
      buyerAction: "view_delivery",
      sellerOutcome: "completed",
      operatorObligation: "settle_payment",
      canCreateFreshPayment: false,
      canRetrySamePaymentPayload: false,
      shouldWait: false,
      hasBuyerDelivery: true,
      completedValidWork: true,
      failedWork: false,
      reputationImpact: "none",
      reconciliationReason: "buyer_delivery_recorded_before_settlement"
    });
  }

  if (sellerCompleted && !buyerDeliveryAvailable) {
    return paidLifecycleProjection({
      protocolState: "PLATFORM_FAILED_RECONCILE",
      terminal: false,
      buyerAction: "stop_and_contact_operator",
      sellerOutcome: "completed_delivery_pending",
      operatorObligation: "persist_buyer_delivery",
      canCreateFreshPayment: false,
      canRetrySamePaymentPayload: false,
      shouldWait: false,
      hasBuyerDelivery: false,
      completedValidWork: true,
      failedWork: false,
      reputationImpact: "none_until_delivery_fault_attributed",
      reconciliationReason: "seller_completed_without_buyer_delivery"
    });
  }

  if (sellerFailure) {
    return paidLifecycleProjection({
      protocolState: paymentSettled ? "PLATFORM_FAILED_RECONCILE" : "SELLER_FAILED_NO_SETTLEMENT",
      terminal: !paymentSettled,
      buyerAction: paymentSettled ? "stop_and_contact_operator" : "create_fresh_payment",
      sellerOutcome: "failed",
      operatorObligation: paymentSettled ? "refund_or_clear_payment" : "none",
      canCreateFreshPayment: !paymentSettled,
      canRetrySamePaymentPayload: false,
      shouldWait: false,
      hasBuyerDelivery: false,
      completedValidWork: false,
      failedWork: true,
      reputationImpact: "seller_failure",
      reconciliationReason: paymentSettled ? "seller_failed_after_payment_settlement" : undefined
    });
  }

  if (platformFailure) {
    return paidLifecycleProjection({
      protocolState: "PLATFORM_FAILED_RECONCILE",
      terminal: false,
      buyerAction: "stop_and_contact_operator",
      sellerOutcome: "not_at_fault",
      operatorObligation: "reconcile_platform_state",
      canCreateFreshPayment: false,
      canRetrySamePaymentPayload: false,
      shouldWait: false,
      hasBuyerDelivery: false,
      completedValidWork: false,
      failedWork: false,
      reputationImpact: "none",
      reconciliationReason: "platform_delivery_or_state_failure"
    });
  }

  if (paymentAuthorized) {
    return paidLifecycleProjection({
      protocolState: "AUTHORIZED_WAITING_FOR_DELIVERY",
      terminal: false,
      buyerAction: canRetrySamePaymentPayload ? "retry_same_payment_payload" : "poll_or_wait",
      sellerOutcome: "pending",
      operatorObligation: input.platformTimedOutAfterWorkerAck ? "reconcile_platform_state" : "none",
      canCreateFreshPayment: false,
      canRetrySamePaymentPayload,
      shouldWait: !canRetrySamePaymentPayload,
      hasBuyerDelivery: false,
      completedValidWork: false,
      failedWork: false,
      reputationImpact: "none",
      reconciliationReason: input.platformTimedOutAfterWorkerAck ? "worker_acknowledged_but_buyer_delivery_pending" : undefined
    });
  }

  return paidLifecycleProjection({
    protocolState: "AWAITING_PAYMENT",
    terminal: false,
    buyerAction: "submit_payment",
    sellerOutcome: "not_started",
    operatorObligation: "none",
    canCreateFreshPayment: true,
    canRetrySamePaymentPayload: false,
    shouldWait: false,
    hasBuyerDelivery: false,
      completedValidWork: false,
      failedWork: false,
      reputationImpact: "none"
  });
}

function paidLifecycleProjection(input: {
  protocolState: SantaClawzPaidProtocolState;
  terminal: boolean;
  buyerAction: SantaClawzBuyerAction;
  sellerOutcome: SantaClawzSellerOutcome;
  operatorObligation: SantaClawzOperatorObligation;
  canCreateFreshPayment: boolean;
  canRetrySamePaymentPayload: boolean;
  shouldWait: boolean;
  hasBuyerDelivery: boolean;
  completedValidWork: boolean;
  failedWork: boolean;
  reputationImpact: SantaClawzPaidLifecycleProjection["sellerAnswer"]["reputationImpact"];
  reconciliationReason?: string | undefined;
}): SantaClawzPaidLifecycleProjection {
  return {
    schemaVersion: SANTACLAWZ_PAID_LIFECYCLE_REDUCER_SCHEMA_VERSION,
    protocolState: input.protocolState,
    terminal: input.terminal,
    buyerAction: input.buyerAction,
    sellerOutcome: input.sellerOutcome,
    operatorObligation: input.operatorObligation,
    buyerAnswer: {
      canCreateFreshPayment: input.canCreateFreshPayment,
      canRetrySamePaymentPayload: input.canRetrySamePaymentPayload,
      shouldWait: input.shouldWait,
      hasBuyerDelivery: input.hasBuyerDelivery
    },
    sellerAnswer: {
      completedValidWork: input.completedValidWork,
      failedWork: input.failedWork,
      reputationImpact: input.reputationImpact
    },
    operatorAnswer: {
      reconciliationRequired: input.operatorObligation !== "none",
      ...(input.reconciliationReason ? { reason: input.reconciliationReason } : {})
    }
  };
}
