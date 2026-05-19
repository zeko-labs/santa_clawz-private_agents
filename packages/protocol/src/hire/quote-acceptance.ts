import type { AgentPaymentRail, ExecutionIntentSettlementModel } from "../runtime/console-state.js";

export const SANTACLAWZ_QUOTE_ACCEPTANCE_WALLET_PROOF_SCHEME = "eip191-personal-sign" as const;

export interface SantaClawzQuoteAcceptanceMessageInput {
  agentId: string;
  requestId: string;
  buyerWallet: string;
  acceptedAmountUsd: string;
  acceptedQuoteDigestSha256: string;
  maxAmountUsd?: string;
  rail: AgentPaymentRail;
  settlementModel: ExecutionIntentSettlementModel;
  buyerAgentId?: string;
}

export interface SantaClawzQuoteAcceptanceWalletProof {
  scheme: typeof SANTACLAWZ_QUOTE_ACCEPTANCE_WALLET_PROOF_SCHEME;
  message: string;
  signature: string;
  signedAtIso?: string;
}

export function buildSantaClawzQuoteAcceptanceMessage(input: SantaClawzQuoteAcceptanceMessageInput): string {
  return [
    "SantaClawz quote acceptance",
    `agentId: ${input.agentId}`,
    `requestId: ${input.requestId}`,
    `buyerWallet: ${input.buyerWallet}`,
    `acceptedAmountUsd: ${input.acceptedAmountUsd}`,
    `acceptedQuoteDigestSha256: ${input.acceptedQuoteDigestSha256}`,
    `maxAmountUsd: ${input.maxAmountUsd?.trim() || "-"}`,
    `rail: ${input.rail}`,
    `settlementModel: ${input.settlementModel}`,
    `buyerAgentId: ${input.buyerAgentId?.trim() || "-"}`
  ].join("\n");
}
