import { type CanonicalDigest } from "../hashing/digest.js";
import type { CapabilityManifest } from "../manifests/capability-manifest.js";
import type { ArtifactVisibility, PrivacyPreset, ProgrammablePrivacyPolicy } from "../privacy/types.js";
import type { ToolReceipt } from "../receipts/tool-receipt.js";
import type { RetentionPolicy } from "../retention/types.js";
import type { GovernancePolicy, TrustModeId, ZekoDeploymentMode } from "../runtime/console-state.js";
import type { StableJsonValue } from "../serialization/stable-json.js";
export interface InteropEvidenceObject {
    kind: "capability-manifest" | "console-state" | "deployment" | "session" | "event" | "privacy-exception" | "artifact" | "receipt" | "origin-proof";
    id: string;
    route: string;
    object: StableJsonValue;
    digest: CanonicalDigest;
    occurredAtIso?: string;
}
export interface AgentRepresentationClaim {
    serviceId: string;
    agentId: string;
    representedPrincipal: {
        type: "workspace-shadow-wallet";
        publicKey: string;
        walletId: string;
        tenantId: string;
        workspaceId: string;
    };
    proofCapability: {
        pluginId: string;
        capabilityId: string;
        manifest: CapabilityManifest;
        manifestDigest: CanonicalDigest;
    };
    claimDigest: CanonicalDigest;
}
export interface AllowedActionClaim {
    capabilityClass: string;
    summary: string;
    requiresApproval: boolean;
    expandsVisibility: boolean;
    externalHost?: string;
}
export interface AgentAuthorityClaim {
    sessionId: string;
    turnId?: string;
    trustModeId: TrustModeId;
    proofLevel: "signed" | "rooted" | "proof-backed";
    allowedActions: AllowedActionClaim[];
    allowedExternalHosts: string[];
    approvalPolicy: GovernancePolicy;
    privacyBoundary: {
        preset: PrivacyPreset;
        operatorVisible: boolean;
        providerVisible: boolean;
        externalHostsAllowed: boolean;
        defaultArtifactVisibility: ArtifactVisibility;
        privacyExceptionsRequired: boolean;
        retentionPolicy: RetentionPolicy;
    };
    activePrivacyExceptions: Array<{
        exceptionId: string;
        audience: string;
        scope: string;
        status: "pending" | "approved" | "expired";
        approvalsObserved: number;
        approvalsRequired: number;
        expiresAtIso: string;
    }>;
    claimDigest: CanonicalDigest;
}
export interface AgentPaymentClaim {
    settlementAsset: "MINA";
    settlementModel: "sponsored-shadow-wallet" | "reserve-settle-refund";
    payeeKey: string;
    spendModel: CapabilityManifest["spendModel"];
    sponsoredBudgetMina: string;
    sponsoredRemainingMina: string;
    latestCreditDeposit?: {
        eventId: string;
        amountMina: string;
        occurredAtIso: string;
    };
    latestTurnSettlement?: {
        eventId: string;
        turnId: string;
        reservedMina?: string;
        spentMina?: string;
        refundedMina?: string;
        occurredAtIso: string;
    };
    claimDigest: CanonicalDigest;
}
export interface AgentPrivacyClaim {
    preset: PrivacyPreset;
    proofLevel: "signed" | "rooted" | "proof-backed";
    defaultArtifactVisibility: ArtifactVisibility;
    providerClass: CapabilityManifest["providerClass"];
    disclosureClass: CapabilityManifest["disclosureClass"];
    retentionPolicy: RetentionPolicy;
    sealedArtifactCount: number;
    programmablePrivacy: ProgrammablePrivacyPolicy;
    claimDigest: CanonicalDigest;
}
export interface ZkTlsOriginProof {
    originProofId: string;
    sessionId: string;
    turnId: string;
    stepId: string;
    host: string;
    method: "GET" | "POST";
    requestTemplateHash: string;
    requestHeaderAllowlistHash: string;
    responseStatus: number;
    responseHeaderDigest: string;
    responseBodyDigest: string;
    extractedFactDigest: string;
    selectiveRevealDigest?: string;
    verifierKeyHash: string;
    verifierSystem: string;
    attestedAtIso: string;
    expiresAtIso: string;
    disclosureClass: "self-only" | "team" | "compliance" | "custom";
    rawTranscriptManifestId?: string;
}
export interface ClawzTrustAnchor {
    type: "canonical-digest" | "zeko-kernel-path" | "zktls-verifier";
    chain: "zeko" | "offchain";
    networkId: string;
    verificationMaterial: string[];
    note: string;
}
export interface ClawzAgentProofBundle {
    protocol: "clawz-agent-proof";
    version: "0.1";
    serviceId: string;
    generatedAtIso: string;
    network: {
        chain: "zeko";
        networkId: string;
        mode: ZekoDeploymentMode;
        graphqlEndpoint: string;
        archiveEndpoint: string;
    };
    discoveryUrl: string;
    representation: AgentRepresentationClaim;
    authority: AgentAuthorityClaim;
    payment: AgentPaymentClaim;
    privacy: AgentPrivacyClaim;
    originProofs?: ZkTlsOriginProof[];
    exampleToolReceipt?: ToolReceipt;
    evidence: InteropEvidenceObject[];
    trustAnchors: ClawzTrustAnchor[];
    bundleDigest: CanonicalDigest;
}
export interface DiscoveryCapability {
    capabilityId: string;
    pluginId: string;
    name: string;
    description: string;
    spendModel: CapabilityManifest["spendModel"];
    approvalClass: string;
    manifestDigest: CanonicalDigest;
}
export interface ClawzAgentDiscoveryDocument {
    protocol: "clawz-agent-proof";
    version: "0.1";
    serviceId: string;
    title: string;
    summary: string;
    focusedSessionId: string;
    network: {
        chain: "zeko";
        networkId: string;
        mode: ZekoDeploymentMode;
        graphqlEndpoint: string;
        archiveEndpoint: string;
    };
    endpoints: {
        discovery: string;
        proofBundle: string;
        verify: string;
        mcp: string;
        events: string;
        consoleState: string;
        deployment: string;
        privacyExceptions: string;
    };
    answersQuestion: string;
    proofClaims: Array<"representation" | "authority" | "payment" | "privacy" | "origin">;
    programmablePrivacy: ProgrammablePrivacyPolicy;
    capabilities: DiscoveryCapability[];
    supportedMcpTools: string[];
}
export interface ClawzMcpToolDefinition {
    name: string;
    description: string;
    inputSchema: StableJsonValue;
}
export interface ClawzJsonRpcRequest {
    jsonrpc: "2.0";
    id: string | number | null;
    method: "tools/list" | "tools/call";
    params?: Record<string, unknown>;
}
export declare function isClawzJsonRpcRequest(value: unknown): value is ClawzJsonRpcRequest;
export declare function assertClawzJsonRpcRequest(value: unknown): ClawzJsonRpcRequest;
export declare function buildOriginProofCommitment(proof: ZkTlsOriginProof): StableJsonValue;
export declare function buildOriginProofRoot(originProofs: ZkTlsOriginProof[]): CanonicalDigest;
