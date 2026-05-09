import type { AgentPaymentRail, AgentPricingMode } from "../runtime/console-state.js";

export const SANTACLAWZ_HIRE_REQUEST_SCHEMA_VERSION = "santaclawz-request/1.0" as const;

export type SantaClawzHireRequestType = "quote_intake" | "paid_execution" | "free_test";
export type SantaClawzHirePaymentStatus = "quote_requested" | "settled" | "paid" | "escrowed" | "free_test";

const SERVICE_KEY_PATTERN = /^[a-z0-9][a-z0-9_:-]{0,79}$/;

export interface SantaClawzHireServiceIdentity {
  service: string;
  service_key: string;
}

export interface SantaClawzHireProtocolFields {
  request_type: SantaClawzHireRequestType;
  pricing_mode: AgentPricingMode;
  payment_status: SantaClawzHirePaymentStatus;
  settled_amount_usd?: string;
}

export interface SantaClawzHirePaymentPolicy extends SantaClawzHireProtocolFields {
  paid_or_escrowed: boolean;
  rail?: AgentPaymentRail;
}

export function paymentStatusForHireRequest(input: {
  requestType: SantaClawzHireRequestType;
  paymentStatus?: string;
}): SantaClawzHirePaymentStatus {
  if (input.requestType === "quote_intake") {
    return "quote_requested";
  }
  if (input.requestType === "free_test") {
    return "free_test";
  }
  if (input.paymentStatus === "paid" || input.paymentStatus === "escrowed") {
    return input.paymentStatus;
  }
  if (input.paymentStatus === "settled") {
    return "settled";
  }
  throw new Error("paid_execution requires payment_status=settled, paid, or escrowed.");
}

export function assertValidSantaClawzHireServiceIdentity(identity: SantaClawzHireServiceIdentity): void {
  if (!SERVICE_KEY_PATTERN.test(identity.service_key)) {
    throw new Error("hire request service_key is invalid.");
  }
  if (identity.service !== identity.service_key) {
    throw new Error("hire request service must match service_key.");
  }
}

export function assertValidSantaClawzHirePolicy(policy: SantaClawzHirePaymentPolicy): void {
  if (policy.request_type === "quote_intake") {
    if (policy.pricing_mode !== "quote-required") {
      throw new Error("quote_intake requires pricing_mode=quote-required.");
    }
    if (policy.payment_status !== "quote_requested") {
      throw new Error("quote_intake requires payment_status=quote_requested.");
    }
    if (policy.paid_or_escrowed) {
      throw new Error("quote_intake must set paid_or_escrowed=false.");
    }
    if (policy.settled_amount_usd) {
      throw new Error("quote_intake must not include settled_amount_usd.");
    }
    return;
  }

  if (policy.request_type === "free_test") {
    if (policy.pricing_mode !== "free-test") {
      throw new Error("free_test requires pricing_mode=free-test.");
    }
    if (policy.payment_status !== "free_test") {
      throw new Error("free_test requires payment_status=free_test.");
    }
    if (policy.paid_or_escrowed) {
      throw new Error("free_test must set paid_or_escrowed=false.");
    }
    if (policy.settled_amount_usd) {
      throw new Error("free_test must not include settled_amount_usd.");
    }
    if (policy.rail) {
      throw new Error("free_test must not include a payment rail.");
    }
    return;
  }

  if (policy.pricing_mode !== "fixed-exact") {
    throw new Error("paid_execution requires pricing_mode=fixed-exact.");
  }
  if (!["settled", "paid", "escrowed"].includes(policy.payment_status)) {
    throw new Error("paid_execution requires payment_status=settled, paid, or escrowed.");
  }
  if (!policy.paid_or_escrowed) {
    throw new Error("paid_execution must set paid_or_escrowed=true.");
  }
  if (!policy.settled_amount_usd) {
    throw new Error("paid_execution requires settled_amount_usd.");
  }
  if (!policy.rail) {
    throw new Error("paid_execution requires a payment rail.");
  }
}
