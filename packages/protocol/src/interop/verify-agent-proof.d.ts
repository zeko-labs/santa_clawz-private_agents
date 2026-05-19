import type { AgentAuthorityClaim, AgentPaymentClaim, AgentPrivacyClaim, AgentRepresentationClaim, ClawzAgentDiscoveryDocument, ClawzAgentProofBundle } from "./agent-proof.js";
export interface VerificationCheck {
    label: string;
    ok: boolean;
    expected?: string;
    actual?: string;
    note?: string;
}
export interface WitnessPlanLike {
    scenarioId?: string;
    contracts?: Array<{
        kernel?: string;
        method?: string;
    }>;
}
export interface WitnessPlanCoverageResult {
    ok: boolean;
    scenarioId?: string;
    covered: string[];
    missing: string[];
}
export interface AgentProofVerificationReport {
    ok: boolean;
    serviceId: string;
    bundleDigestSha256: string;
    checks: VerificationCheck[];
    witnessPlanCoverage?: WitnessPlanCoverageResult;
}
export interface AgentTrustQuestionAnswer {
    represents: {
        serviceId: string;
        agentId: string;
        principalType: AgentRepresentationClaim["representedPrincipal"]["type"];
        publicKey: string;
        walletId: string;
        tenantId: string;
        workspaceId: string;
    };
    authority: {
        sessionId: string;
        turnId?: string;
        trustModeId: AgentAuthorityClaim["trustModeId"];
        proofLevel: AgentAuthorityClaim["proofLevel"];
        allowedActions: AgentAuthorityClaim["allowedActions"];
        allowedExternalHosts: string[];
        approvalsRequired: number;
        activePrivacyExceptionCount: number;
    };
    payment: {
        settlementAsset: AgentPaymentClaim["settlementAsset"];
        settlementModel: AgentPaymentClaim["settlementModel"];
        spendModel: AgentPaymentClaim["spendModel"];
        payeeKey: string;
        sponsoredBudgetMina: string;
        sponsoredRemainingMina: string;
    };
    privacy: {
        preset: AgentPrivacyClaim["preset"];
        proofLevel: AgentPrivacyClaim["proofLevel"];
        defaultArtifactVisibility: AgentPrivacyClaim["defaultArtifactVisibility"];
        disclosureClass: AgentPrivacyClaim["disclosureClass"];
        retentionProfile: AgentPrivacyClaim["retentionPolicy"]["profile"];
        sealedArtifactCount: number;
        selectedProvingLocation: AgentPrivacyClaim["programmablePrivacy"]["selectedLocation"];
        availableProvingLocations: AgentPrivacyClaim["programmablePrivacy"]["options"][number]["location"][];
    };
    origin: {
        proofCount: number;
        hosts: string[];
        verifierSystems: string[];
        rootedProofs: Array<{
            originProofId: string;
            host: string;
            verifierSystem: string;
            expiresAtIso: string;
        }>;
    };
}
export interface ClawzAgentProofVerificationRequest {
    url?: string;
    sessionId?: string;
    turnId?: string;
    bundle?: ClawzAgentProofBundle;
    discovery?: ClawzAgentDiscoveryDocument;
    witnessPlan?: WitnessPlanLike;
}
export interface ClawzAgentProofVerificationResponse {
    ok: boolean;
    source: {
        mode: "self" | "live-url" | "bundle";
        baseUrl?: string;
        sessionId?: string;
        turnId?: string;
        discoveryProvided: boolean;
        witnessPlanProvided: boolean;
    };
    summary: {
        protocol: ClawzAgentProofBundle["protocol"];
        serviceId: string;
        generatedAtIso: string;
        bundleDigestSha256: string;
    };
    question: AgentTrustQuestionAnswer;
    report: AgentProofVerificationReport;
    discovery?: ClawzAgentDiscoveryDocument;
}
export declare function summarizeAgentProofBundle(bundle: ClawzAgentProofBundle): AgentTrustQuestionAnswer;
export declare function buildProofVerificationResponse(input: {
    source: ClawzAgentProofVerificationResponse["source"];
    bundle: ClawzAgentProofBundle;
    report: AgentProofVerificationReport;
    discovery?: ClawzAgentDiscoveryDocument;
}): ClawzAgentProofVerificationResponse;
export declare function verifyWitnessPlanCoverage(bundle: ClawzAgentProofBundle, witnessPlan: WitnessPlanLike): WitnessPlanCoverageResult;
export declare function verifyAgentProofBundle(bundle: ClawzAgentProofBundle, options?: {
    discovery?: ClawzAgentDiscoveryDocument;
    witnessPlan?: WitnessPlanLike;
}): AgentProofVerificationReport;
