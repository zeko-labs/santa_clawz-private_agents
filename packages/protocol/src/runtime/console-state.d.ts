import type { ArtifactVisibility, PrivacyPreset, PrivacyProvingLocation } from "../privacy/types.js";
export type TrustModeId = "fast" | "private" | "verified" | "team-governed";
export interface TrustModeCard {
    id: TrustModeId;
    label: string;
    blurb: string;
    preset: PrivacyPreset;
    operatorVisible: boolean;
    providerVisible: boolean;
    proofLevel: "signed" | "rooted" | "proof-backed";
    maxSpendMina: string;
    retention: string;
    defaultArtifactVisibility: ArtifactVisibility;
    defaultProvingLocation: PrivacyProvingLocation;
    supportedProvingLocations: PrivacyProvingLocation[];
    stripe: string[];
}
export interface GhostStep {
    id: string;
    summary: string;
    capabilityClass: string;
    externalHost?: string;
    requiresApproval: boolean;
    expandsVisibility: boolean;
}
export interface GhostRunPlan {
    mode: TrustModeId;
    estimatedSpendMina: string;
    steps: GhostStep[];
    visibilitySummary: string[];
    privacyExceptionsRequired: boolean;
}
export interface GuardianRecord {
    guardianId: string;
    label: string;
    role: "security" | "legal" | "compliance" | "admin";
    status: "active" | "invited";
}
export interface RecoveryKitState {
    status: "not-prepared" | "sealed" | "rotating";
    guardiansRequired: number;
    bundleManifestId?: string;
    sealedAtIso?: string;
    lastRotationAtIso?: string;
}
export interface GovernancePolicy {
    requiredApprovals: number;
    reviewAudience: string;
    autoExpiryHours: number;
}
export interface ShadowWalletState {
    walletId: string;
    publicKey: string;
    deviceStatus: "device-bound" | "recoverable" | "rotating";
    sponsorStatus: "active" | "paused";
    sponsoredBudgetMina: string;
    sponsoredRemainingMina: string;
    trustModeId: TrustModeId;
    guardians: GuardianRecord[];
    recovery: RecoveryKitState;
    governancePolicy: GovernancePolicy;
}
export interface PrivacyApprovalRecord {
    actorId: string;
    actorRole: "operator" | "tenant-admin" | "compliance-reviewer" | "workspace-member";
    approvedAtIso: string;
    note: string;
}
export interface PrivacyExceptionQueueItem {
    id: string;
    sessionId: string;
    turnId: string;
    title: string;
    audience: string;
    duration: string;
    scope: string;
    reason: string;
    severity: "low" | "medium" | "high";
    status: "pending" | "approved" | "expired";
    requiredApprovals: number;
    approvals: PrivacyApprovalRecord[];
    expiresAtIso: string;
}
export interface TimeMachineEntry {
    id: string;
    label: string;
    outcome: string;
    note: string;
    occurredAtIso: string;
}
export interface SessionSummary {
    sessionId: string;
    eventCount: number;
    turnCount: number;
    privacyExceptionCount: number;
    sealedArtifactCount: number;
    focusSource?: "requested" | "live-flow" | "latest-indexed" | "stored-default";
    knownSessionIds?: string[];
    lastEventAtIso?: string;
}
export interface ArtifactSummary {
    manifestId: string;
    artifactClass: string;
    visibility: ArtifactVisibility;
    createdAtIso: string;
    payloadDigest: string;
}
export type ZekoDeploymentMode = "local-runtime" | "planned-testnet" | "testnet-live";
export interface ZekoContractDeployment {
    label: string;
    status: "deployed" | "skipped" | "unavailable";
    address?: string;
    txHash?: string;
    fundedNewAccount?: boolean;
    secretSource?: "env" | "keychain";
}
export interface ZekoWitnessPlanSummary {
    scenarioId?: string;
    preparedContractCalls: number;
    preparedProofCalls: number;
    liveFlowMethods: string[];
}
export interface ZekoDeploymentState {
    chain: "zeko";
    networkId: string;
    mode: ZekoDeploymentMode;
    graphqlEndpoint: string;
    archiveEndpoint: string;
    deployerPublicKey?: string;
    generatedAtIso?: string;
    contracts: ZekoContractDeployment[];
    witnessPlan: ZekoWitnessPlanSummary;
    privacyGrade: "pilot-grade" | "production-grade";
    keyManagement: "durable-local-file-backed" | "external-kms-backed" | "in-memory-default-export";
    privacyNote: string;
}
export interface LiveSessionTurnFlowStep {
    label: string;
    contractAddress: string;
    txHash: string;
    changedSlots: number[];
    occurredAtIso?: string;
}
export interface LiveFlowTurnTarget {
    sessionId: string;
    turnId: string;
    latestEventType: string;
    lastOccurredAtIso?: string;
    latestDisclosureId?: string;
    spentMina?: string;
    refundedMina?: string;
    canStartNextTurn: boolean;
    canAbort: boolean;
    canRefund: boolean;
    canRevokeDisclosure: boolean;
}
export interface LiveFlowDisclosureTarget {
    disclosureId: string;
    sessionId: string;
    turnId: string;
    grantedAtIso?: string;
    revokedAtIso?: string;
    active: boolean;
}
export interface LiveFlowTargets {
    turns: LiveFlowTurnTarget[];
    disclosures: LiveFlowDisclosureTarget[];
}
export interface LiveSessionTurnFlowState {
    flowKind?: "first-turn" | "next-turn" | "abort-turn" | "refund-turn" | "revoke-disclosure";
    scenarioId: string;
    sessionId: string;
    turnId: string;
    sourceTurnId?: string;
    sourceDisclosureId?: string;
    abortReason?: string;
    revocationReason?: string;
    refundAmountMina?: string;
    status: "idle" | "queued" | "running" | "succeeded" | "failed";
    stepCount: number;
    totalSteps: number;
    steps: LiveSessionTurnFlowStep[];
    completedStepLabels: string[];
    reportType?: "live-session-turn-flow";
    generatedAtIso?: string;
    requestedAtIso?: string;
    lastStartedAtIso?: string;
    lastFinishedAtIso?: string;
    currentStepLabel?: string;
    resumeFromStepLabel?: string;
    lastError?: string;
    attemptCount?: number;
    resumeAvailable?: boolean;
    jobId?: string;
    reportPath?: string;
    witnessPlanPath?: string;
}
export interface ConsoleStateResponse {
    wallet: ShadowWalletState;
    trustModes: TrustModeCard[];
    ghostRun: GhostRunPlan;
    privacyExceptions: PrivacyExceptionQueueItem[];
    timeMachine: TimeMachineEntry[];
    session: SessionSummary;
    artifacts: ArtifactSummary[];
    deployment: ZekoDeploymentState;
    liveFlowTargets: LiveFlowTargets;
    liveFlow: LiveSessionTurnFlowState;
}
export declare const TRUST_MODE_PRESETS: TrustModeCard[];
