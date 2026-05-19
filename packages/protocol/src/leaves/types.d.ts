import type { DangerClass } from "../privacy/types.js";
export type Fieldish = string;
export interface AgentLeaf {
    agentId: string;
    ownerKey: string;
    manifestHash: Fieldish;
    pricingHash: Fieldish;
    policyClassHash: Fieldish;
    stakeAmount: Fieldish;
    status: "active" | "disabled" | "pending";
    metadataHash: Fieldish;
}
export interface CapabilityLeaf {
    capabilityId: string;
    pluginId: string;
    manifestHash: Fieldish;
    ioSchemaHash: Fieldish;
    policyClassHash: Fieldish;
    priceModelHash: Fieldish;
    stakeAmount: Fieldish;
    status: "active" | "disabled" | "pending";
}
export interface SessionHeaderLeaf {
    sessionId: string;
    tenantId: string;
    agentId: string;
    routingPolicyHash: Fieldish;
    keyRefHash: Fieldish;
    createdAtSlot: string;
    channelBindingHash: Fieldish;
}
export interface TurnHeaderLeaf {
    turnId: string;
    sessionId: string;
    leaseId: string;
    workerId: string;
    inputMessageRoot: Fieldish;
    budgetReservationHash: Fieldish;
    approvalBundleHash: Fieldish;
    startedAtSlot: string;
}
export interface ApprovalLeaf {
    approvalId: string;
    turnId: string;
    requesterKey: string;
    workerId: string;
    policyHash: Fieldish;
    dangerClass: DangerClass;
    scopeHash: Fieldish;
    privacyExceptionHash?: Fieldish;
    expiresAtSlot: string;
}
export interface BudgetReservationLeaf {
    reservationId: string;
    turnId: string;
    payerKey: string;
    maxSpend: Fieldish;
    refundAddress: string;
    nullifier: Fieldish;
}
export interface DisclosureLeaf {
    disclosureId: string;
    sessionId: string;
    requestorKey: string;
    artifactRef: Fieldish;
    scopeHash: Fieldish;
    legalBasisHash: Fieldish;
    expiresAtSlot: string;
    audienceHash: Fieldish;
}
export interface OriginProofLeaf {
    originProofId: string;
    sessionId: string;
    turnId: string;
    stepId: string;
    hostHash: Fieldish;
    requestTemplateHash: Fieldish;
    responseBodyDigest: Fieldish;
    extractedFactDigest: Fieldish;
    verifierKeyHash: Fieldish;
    attestedAtSlot: string;
    expiresAtSlot: string;
}
