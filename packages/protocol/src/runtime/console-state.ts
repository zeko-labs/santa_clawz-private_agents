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

export interface SponsorQueueJob {
  jobId: string;
  sessionId: string;
  amountMina: string;
  purpose: "onboarding" | "top-up" | "publish";
  status: "queued" | "running" | "succeeded" | "failed";
  requestedAtIso: string;
  startedAtIso?: string;
  finishedAtIso?: string;
  txHash?: string;
  note?: string;
  lastError?: string;
}

export interface SponsorQueueState {
  status: "idle" | "queued" | "running" | "failed";
  autoSponsorEnabled: boolean;
  pendingCount: number;
  activeJobId?: string;
  items: SponsorQueueJob[];
}

export interface AgentPayoutWallets {
  zeko?: string;
  base?: string;
  ethereum?: string;
}

export type AgentPaymentRail = "base-usdc" | "ethereum-usdc" | "zeko-native";
export type AgentPricingMode = "fixed-exact" | "quote-required" | "free-test";
export type AgentSettlementTrigger = "upfront" | "on-proof";
export type AgentReferencePriceUnit = "minimum" | "agent-minute" | "compute-unit";
export type ProtocolOwnerFeeApplicability = "santaclawz-marketplace";
export type ProtocolOwnerFeeSettlementModel = "split-release-v1" | "fee-on-reserve-v1";

export interface ProtocolOwnerFeePolicy {
  enabled: boolean;
  feeBps: number;
  settlementModel: ProtocolOwnerFeeSettlementModel;
  appliesTo: ProtocolOwnerFeeApplicability[];
  recipientByRail: Partial<Record<AgentPaymentRail, string>>;
}

export interface AgentFeePreview {
  rail: AgentPaymentRail;
  grossAmountUsd?: string;
  sellerNetAmountUsd?: string;
  protocolFeeAmountUsd?: string;
  nominalProtocolFeeAmountUsd?: string;
  networkFacilitationFeeAmountUsd?: string;
  feeBasis?: "protocol-bps" | "network-facilitation-minimum";
  gasEstimate?: {
    gasUnits: string;
    gasPriceWei: string;
    nativeAmount: string;
    nativeSymbol: "ETH";
    nativeUsdPrice?: string;
    source: string;
  };
  sellerPayTo?: string;
  protocolFeeRecipient?: string;
  feeBps: number;
}

export type AgentMissionAuthProviderHint = "auth0" | "okta" | "custom-oidc";
export type AgentMissionAuthOverlayStatus = "disabled" | "configured" | "verified";

export interface AgentMissionAuthOverlay {
  enabled: boolean;
  status: AgentMissionAuthOverlayStatus;
  authorityBaseUrl?: string;
  providerHint?: AgentMissionAuthProviderHint;
  scopeHints: string[];
  protocol?: "zk-mission-auth";
  authorityName?: string;
  discoveryUrl?: string;
  jwksUrl?: string;
  providersUrl?: string;
  verifyCheckpointUrl?: string;
  exportBundleUrl?: string;
  supportedProviders?: string[];
  lastVerifiedAtIso?: string;
}

export interface AgentPaymentProfile {
  enabled: boolean;
  supportedRails: AgentPaymentRail[];
  defaultRail?: AgentPaymentRail;
  pricingMode: AgentPricingMode;
  fixedAmountUsd?: string;
  maxAmountUsd?: string;
  quoteUrl?: string;
  referencePriceUsd?: string;
  referencePriceUnit?: AgentReferencePriceUnit;
  settlementTrigger: AgentSettlementTrigger;
  baseFacilitatorUrl?: string;
  ethereumFacilitatorUrl?: string;
  baseEscrowContract?: string;
  ethereumEscrowContract?: string;
  paymentNotes?: string;
}

export interface AgentOwnershipChallengeState {
  challengeId: string;
  challengePath: string;
  challengeUrl: string;
  verificationMethod: "well-known-http";
  issuedAtIso: string;
  expiresAtIso: string;
}

export interface AgentOwnershipVerificationState {
  challengeId: string;
  challengePath: string;
  challengeUrl: string;
  verificationMethod: "well-known-http" | "santaclawz-relay-ticket";
  verifiedAtIso: string;
  verifiedPublicClawzUrl: string;
  challengeResponseDigestSha256: string;
  attestationDigestSha256: string;
  reclaimedAtIso?: string;
}

export interface AgentOwnershipState {
  status: "unverified" | "challenge-issued" | "verified" | "legacy-unverified";
  legacyRegistration: boolean;
  canReclaim: boolean;
  challenge?: AgentOwnershipChallengeState;
  verification?: AgentOwnershipVerificationState;
}

export type SocialAnchorCandidateKind =
  | "agent-registered"
  | "ownership-verified"
  | "agent-published"
  | "payment-terms-live"
  | "hire-request-submitted"
  | "quote-returned"
  | "quote-accepted"
  | "paid-execution-completed"
  | "free-test-completed"
  | "hire-request-failed"
  | "execution-intent-created"
  | "execution-intent-approved"
  | "execution-intent-executed"
  | "execution-intent-settled"
  | "execution-intent-refunded"
  | "agent-message-posted"
  | "operator-dispatch";

export type AgentSocialAnchorMode = "shared-batched" | "priority-self-funded";

export interface AgentSocialAnchorPolicy {
  mode: AgentSocialAnchorMode;
}

export type SocialAnchorCandidateStatus = "pending" | "submitted" | "retrying" | "confirmed" | "failed";
export type SocialAnchorBatchStatus = "submitted" | "retrying" | "confirmed" | "failed";

export interface SocialAnchorCandidate {
  candidateId: string;
  sessionId: string;
  agentId: string;
  anchorMode: AgentSocialAnchorMode;
  kind: SocialAnchorCandidateKind;
  title: string;
  summary: string;
  occurredAtIso: string;
  payloadDigestSha256: string;
  status: SocialAnchorCandidateStatus;
  batchId?: string;
  batchRootDigestSha256?: string;
  batchAnchorField?: string;
  batchItemIndex?: number;
  batchItemCount?: number;
  submittedAtIso?: string;
  confirmedAtIso?: string;
  failedAtIso?: string;
  anchoredAtIso?: string;
  contractAddress?: string;
  txHash?: string;
  submitAttemptCount?: number;
  lastAnchorError?: string;
  nextRetryAtIso?: string;
}

export interface SocialAnchorBatch {
  batchId: string;
  sessionId: string;
  agentId: string;
  anchorMode: AgentSocialAnchorMode;
  networkId: string;
  itemCount: number;
  candidateKinds: SocialAnchorCandidateKind[];
  rootDigestSha256: string;
  status: SocialAnchorBatchStatus;
  createdAtIso: string;
  submittedAtIso?: string;
  confirmedAtIso?: string;
  failedAtIso?: string;
  settledAtIso: string;
  anchorField?: string;
  contractAddress?: string;
  txHash?: string;
  submitFeeRaw?: string;
  submitFee?: string;
  submitFeeSource?: string;
  submitAttemptCount?: number;
  retryCount?: number;
  lastCheckedAtIso?: string;
  observedAtIso?: string;
  observedAnchorField?: string;
  lastAnchorError?: string;
  nextRetryAtIso?: string;
  candidateIds?: string[];
  operatorNote?: string;
}

export interface SocialAnchorBatchExportItem {
  candidateId: string;
  kind: SocialAnchorCandidateKind;
  occurredAtIso: string;
  payloadDigestSha256: string;
}

export interface SocialAnchorBatchExport {
  batchId: string;
  sessionId: string;
  agentId: string;
  anchorMode: AgentSocialAnchorMode;
  networkId: string;
  rootDigestSha256: string;
  anchorField: string;
  itemCount: number;
  candidateKinds: SocialAnchorCandidateKind[];
  items: SocialAnchorBatchExportItem[];
  contractAddress?: string;
}

export interface SocialAnchorQueueState {
  pendingCount: number;
  submittedCount: number;
  retryingCount: number;
  confirmedCount: number;
  failedCount: number;
  anchoredCount: number;
  latestRootDigestSha256?: string;
  latestSubmittedRootDigestSha256?: string;
  lastConfirmedAtIso?: string;
  lastSettledAtIso?: string;
  lastError?: string;
  lastErrorAtIso?: string;
  operatorAlerts?: string[];
  items: SocialAnchorCandidate[];
  recentBatches: SocialAnchorBatch[];
}

export type AgentBoardMessageType = "dispatch" | "question" | "reply" | "output";
export type AgentBoardMessageVisibility = "public";
export type AgentBoardMessageModerationStatus = "visible" | "hidden" | "flagged";

export interface AgentBoardMessage {
  schemaVersion: "santaclawz-agent-message/1.0";
  messageId: string;
  threadId: string;
  parentMessageId?: string;
  agentId: string;
  sessionId: string;
  agentName: string;
  representedPrincipal?: string;
  messageType: AgentBoardMessageType;
  body: string;
  topicTags: string[];
  capabilityTags?: string[];
  visibility: AgentBoardMessageVisibility;
  moderationStatus: AgentBoardMessageModerationStatus;
  createdAtIso: string;
  updatedAtIso: string;
  bodyDigestSha256: string;
  messageDigestSha256: string;
  outputDigestSha256?: string;
  anchorCandidateId?: string;
  anchorStatus?: SocialAnchorCandidateStatus;
  batchRootDigestSha256?: string;
  batchTxHash?: string;
}

export interface AgentBoardThread {
  threadId: string;
  rootMessageId: string;
  agentIds: string[];
  agentNames: string[];
  topicTags: string[];
  capabilityTags?: string[];
  messageCount: number;
  latestMessageAtIso: string;
  latestMessageDigestSha256: string;
}

export interface AgentBoardState {
  schemaVersion: "santaclawz-agent-board/1.0";
  generatedAtIso: string;
  totalVisibleMessages: number;
  messages: AgentBoardMessage[];
  threads: AgentBoardThread[];
}

export interface AgentProfileState {
  agentName: string;
  representedPrincipal: string;
  headline: string;
  openClawUrl: string;
  runtimeDelivery: {
    mode: "santaclawz-relay" | "self-hosted";
    runtimeIngressUrl?: string;
  };
  availability: "active" | "archived";
  archivedAtIso?: string;
  payoutWallets: AgentPayoutWallets;
  missionAuthOverlay: AgentMissionAuthOverlay;
  paymentProfile: AgentPaymentProfile;
  socialAnchorPolicy: AgentSocialAnchorPolicy;
  preferredProvingLocation: PrivacyProvingLocation;
}

export interface AgentRegistryEntry {
  agentId: string;
  sessionId: string;
  networkId: string;
  agentName: string;
  representedPrincipal: string;
  headline: string;
  publicAgentUrl?: string;
  publicHireUrl?: string;
  openClawUrl: string;
  runtimeDeliveryMode?: "santaclawz-relay" | "self-hosted";
  serviceKey: string;
  trustModeId: TrustModeId;
  trustModeLabel: string;
  proofLevel: "signed" | "rooted" | "proof-backed";
  preferredProvingLocation: PrivacyProvingLocation;
  paymentsEnabled: boolean;
  protocolOwnerFeeBps?: number;
  protocolFeeApplies?: boolean;
  paymentRail?: AgentPaymentRail;
  pricingMode: AgentPricingMode;
  fixedAmountUsd?: string;
  referencePriceUsd?: string;
  referencePriceUnit?: AgentReferencePriceUnit;
  settlementTrigger: AgentSettlementTrigger;
  payoutAddressConfigured: boolean;
  paymentProfileReady: boolean;
  paidJobsEnabled: boolean;
  missionAuthVerified: boolean;
  ownershipVerified: boolean;
  availability: AgentProfileState["availability"];
  archivedAtIso?: string;
  runtimeStatus: AgentRuntimeStatus;
  runtimeStatusUpdatedAtIso?: string;
  lastHeartbeatAtIso?: string;
  runtimeStatusReason?: string;
  readiness?: AgentReadinessState;
  published: boolean;
  pendingSocialAnchorCount: number;
  anchoredSocialFactCount: number;
  lastSocialAnchorAtIso?: string;
  lastUpdatedAtIso?: string;
}

export interface HireRequestReceipt {
  requestId: string;
  agentId: string;
  sessionId: string;
  networkId: string;
  submittedAtIso: string;
  requestType: "quote_intake" | "paid_execution" | "free_test";
  pricingMode: AgentPricingMode;
  paymentStatus: "quote_requested" | "settled" | "paid" | "escrowed" | "free_test";
  settledAmountUsd?: string;
  status: "submitted" | "quoted" | "completed" | "failed";
  deliveryTarget: string;
  deliveryStatus?: "forwarded" | "recorded";
  deliveryError?: string;
  operationalStatus?: HireOperationalStatus;
  ingress?: {
    url: string;
    requestId: string;
    timestamp: string;
    bodyDigestSha256: string;
    responseStatusCode?: number;
    signatureHeader: "X-SantaClawz-Signature";
  };
  protocolReturn?: {
    schemaVersion: "santaclawz-return/1.0";
    status: "quoted" | "completed" | "failed";
    digestSha256: string;
    quote?: {
      amountUsd: string;
      currency: "USDC";
      expiresAtIso: string;
      summary: string;
    };
    verifiedOutput?: {
      packageHash: string;
      deliverableCount: number;
      filesProducedCount?: number;
      checksPerformedCount?: number;
      verificationManifestDigestSha256?: string;
      zekoAttestationIncluded: boolean;
    };
    execution?: {
      runtimeStatus: "completed";
      executionMode?: string;
      realWorkExecuted?: boolean;
      buyerVisible?: boolean;
      marketplaceCompletionCredit?: boolean;
      deliverableCount: number;
      filesProducedCount: number;
      checksPerformedCount: number;
      verificationManifestPresent: boolean;
      zekoAttestationIncluded: boolean;
      completionClassification:
        | "agent_completed_verified"
        | "agent_completed_unverified"
        | "agent_completed_empty"
        | "demo_completion";
    };
    incidentId?: string;
  };
  payment?: {
    status: "quote_requested" | "settled" | "paid" | "escrowed" | "free_test";
    rail?: string;
    amountUsd?: string;
    authorizationId?: string;
    settlementReference?: string;
    ledgerId?: string;
    sellerSettlementTxHash?: string;
    protocolFeeTxHash?: string;
    transactionHashes?: string[];
  };
  paidJobsEnabled: boolean;
}

export interface HireOperationalStatus {
  paymentStatus: "not_required" | "quote_requested" | "free_test" | "settled" | "failed";
  settlementStatus: "not_required" | "not_attempted" | "settled" | "failed" | "pending";
  relayDeliveryStatus: "not_attempted" | "forwarded" | "recorded" | "failed";
  agentExecutionStatus: "not_started" | "submitted" | "quoted" | "completed" | "failed";
}

export type ExecutionIntentStatus = "pending" | "approved" | "executed" | "settled" | "refunded";
export type ExecutionIntentSettlementModel = "upfront-x402" | "reserve-release-escrow";
export type ExecutionIntentTransitionType = "created" | "approved" | "executed" | "settled" | "refunded";

export interface ExecutionIntentLifecycleEntry {
  transitionId: string;
  transitionType: ExecutionIntentTransitionType;
  fromStatus?: ExecutionIntentStatus;
  toStatus: ExecutionIntentStatus;
  occurredAtIso: string;
  transitionDigestSha256: string;
  previousTransitionDigestSha256?: string;
  reference?: string;
  evidenceDigestSha256?: string;
  note?: string;
  anchorCandidateId?: string;
}

export interface ExecutionIntentRecord {
  schemaVersion: "santaclawz-execution-intent/1.0";
  intentId: string;
  requestId?: string;
  agentId: string;
  sessionId: string;
  networkId: string;
  rail: AgentPaymentRail;
  settlementModel: ExecutionIntentSettlementModel;
  status: ExecutionIntentStatus;
  pricingMode: AgentPricingMode;
  paymentStatus: "settled" | "paid" | "escrowed";
  grossAmountUsd: string;
  sellerNetAmountUsd?: string;
  protocolFeeAmountUsd?: string;
  protocolFeeRecipient?: string;
  buyerWallet?: string;
  sellerWallet?: string;
  escrowContract?: string;
  paymentAuthorizationDigestSha256?: string;
  executionDigestSha256?: string;
  settlementDigestSha256?: string;
  refundDigestSha256?: string;
  stableIntentDigestSha256: string;
  latestTransitionDigestSha256: string;
  lifecycle: ExecutionIntentLifecycleEntry[];
  createdAtIso: string;
  updatedAtIso: string;
  approvedAtIso?: string;
  executedAtIso?: string;
  settledAtIso?: string;
  refundedAtIso?: string;
  anchorCandidateIds: string[];
}

export interface ExecutionIntentState {
  schemaVersion: "santaclawz-execution-intents/1.0";
  generatedAtIso: string;
  totalIntentCount: number;
  pendingCount: number;
  approvedCount: number;
  executedCount: number;
  settledCount: number;
  refundedCount: number;
  intents: ExecutionIntentRecord[];
}

export type PaymentLedgerStatus =
  | "payment_challenged"
  | "payment_submitted"
  | "payment_verified"
  | "seller_settled"
  | "protocol_fee_settled"
  | "settled"
  | "partially_settled"
  | "already_settled"
  | "settlement_failed"
  | "execution_forwarded"
  | "execution_completed"
  | "execution_failed"
  | "return_rejected"
  | "unmatched_relayer_transaction";

export interface PaymentLedgerEntry {
  ledgerId: string;
  createdAtIso: string;
  updatedAtIso: string;
  agentId: string;
  sessionId: string;
  quoteIntentId?: string;
  hireRequestId?: string;
  x402RequestId?: string;
  resource?: string;
  pricingMode: AgentPricingMode;
  rail: AgentPaymentRail;
  networkId: string;
  assetSymbol: string;
  assetAddress?: string;
  amountUsd: string;
  sellerPayTo?: string;
  protocolFeeRecipient?: string;
  protocolFeeBps?: number;
  sellerNetAmountUsd?: string;
  protocolFeeAmountUsd?: string;
  paymentPayloadDigestSha256?: string;
  paymentRequirementDigestSha256?: string;
  authorizationId?: string;
  settlementReference?: string;
  sellerSettlementTxHash?: string;
  protocolFeeTxHash?: string;
  transactionHashes: string[];
  facilitatorUrl?: string;
  facilitatorResponseDigestSha256?: string;
  facilitatorResponseSummary?: Record<string, unknown>;
  paymentStatus: PaymentLedgerStatus;
  executionStatus?: "not_started" | "submitted" | "forwarded" | "completed" | "failed";
  returnStatus?: "none" | "accepted" | "rejected";
  errorCode?: string;
  errorMessage?: string;
}

export interface PaymentLedgerState {
  schemaVersion: "santaclawz-payment-ledger/1.0";
  generatedAtIso: string;
  totalLedgerEntryCount: number;
  entries: PaymentLedgerEntry[];
}

export type AgentRuntimeStatus = "live" | "waiting" | "offline";

export interface AgentRuntimeHeartbeatState {
  agentId: string;
  sessionId: string;
  status: AgentRuntimeStatus;
  checkedAtIso: string;
  ttlSeconds: number;
  lastHeartbeatAtIso?: string;
  staleAtIso?: string;
  reason?: string;
  note?: string;
}

export interface AgentRuntimeAvailabilityState {
  agentId: string;
  sessionId: string;
  openClawUrl: string;
  runtimeDeliveryMode?: "santaclawz-relay" | "self-hosted";
  checkedAtIso: string;
  reachable: boolean;
  status: "online" | "offline" | "not-configured" | "check-disabled";
  runtimeStatus: AgentRuntimeStatus;
  heartbeat: AgentRuntimeHeartbeatState;
  readiness?: AgentReadinessState;
  httpStatus?: number;
  reason?: string;
}

export interface AgentReadinessState {
  relayConnected: boolean;
  heartbeatLive: boolean;
  runtimeReachable: boolean;
  workerReachable: boolean;
  paymentReady: boolean;
  published: boolean;
  hireable: boolean;
  lastJobStatus?: "none" | "submitted" | "quoted" | "completed" | "failed";
  blockers: string[];
}

export interface AdminAccessState {
  requiresAdminKey: boolean;
  hasAdminAccess: boolean;
  keyHint?: string;
  issuedAdminKey?: string;
}

export interface IngressAccessState {
  hasIngressToken: boolean;
  hasSigningSecret?: boolean;
  tokenHint?: string;
  signingSecretHint?: string;
  issuedIngressToken?: string;
  issuedSigningSecret?: string;
}

export interface ConsoleStateResponse {
  agentId: string;
  published: boolean;
  paymentsEnabled: boolean;
  paymentProfileReady: boolean;
  payoutAddressConfigured: boolean;
  paidJobsEnabled: boolean;
  readiness?: AgentReadinessState;
  protocolOwnerFeePolicy: ProtocolOwnerFeePolicy;
  adminAccess: AdminAccessState;
  ingressAccess?: IngressAccessState;
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
  sponsorQueue: SponsorQueueState;
  socialAnchorQueue: SocialAnchorQueueState;
  profile: AgentProfileState;
  ownership: AgentOwnershipState;
}

export type AgentX402SettlementRail = "evm" | "zeko";
export type AgentX402ExecutionMode = "settle-first" | "reserve-release";

export interface AgentX402RailPlan {
  rail: AgentPaymentRail;
  settlementRail: AgentX402SettlementRail;
  networkId: string;
  assetSymbol: string;
  assetDecimals: number;
  assetStandard: "erc20" | "native";
  assetAddress?: string;
  builderHint: string;
  facilitatorMode: string;
  settlementModel: string;
  executionMode: AgentX402ExecutionMode;
  payTo?: string;
  beneficiaryAddress?: string;
  settlementContractAddress?: string;
  facilitatorUrl?: string;
  amountUsd?: string;
  maxAmountUsd?: string;
  ready: boolean;
  missing: string[];
  notes: string[];
}

export interface AgentX402Plan {
  serviceId: string;
  agentId: string;
  sessionId: string;
  published: boolean;
  paymentsEnabled: boolean;
  paymentProfileReady: boolean;
  payoutAddressConfigured: boolean;
  pricingMode: AgentPricingMode;
  settlementTrigger: AgentSettlementTrigger;
  defaultRail?: AgentPaymentRail;
  quoteUrl?: string;
  referencePriceUsd?: string;
  referencePriceUnit?: AgentReferencePriceUnit;
  paymentNotes?: string;
  protocolOwnerFeePolicy?: ProtocolOwnerFeePolicy;
  feePreviewByRail?: AgentFeePreview[];
  proofBundleUrl: string;
  verifyProofUrl: string;
  catalogPreviewUrl: string;
  resourcePreviewUrl: string;
  verifyPaymentUrl: string;
  settlePaymentUrl: string;
  rails: AgentX402RailPlan[];
}

export const TRUST_MODE_PRESETS: TrustModeCard[] = [
  {
    id: "fast",
    label: "Fast",
    blurb: "For low-risk drafting and internal synthesis with minimal friction.",
    preset: "convenient",
    operatorVisible: true,
    providerVisible: true,
    proofLevel: "signed",
    maxSpendMina: "0.08",
    retention: "24h checkpoint",
    defaultArtifactVisibility: "user-visible",
    defaultProvingLocation: "client",
    supportedProvingLocations: ["client", "server", "sovereign-rollup"],
    stripe: ["Visible to your workspace", "Provider approved", "Quick retention"]
  },
  {
    id: "private",
    label: "Private",
    blurb: "Default mode for day-to-day work with sealed outputs and bounded disclosure.",
    preset: "private",
    operatorVisible: false,
    providerVisible: false,
    proofLevel: "rooted",
    maxSpendMina: "0.18",
    retention: "72h zero-retention",
    defaultArtifactVisibility: "operator-blind",
    defaultProvingLocation: "client",
    supportedProvingLocations: ["client", "server", "sovereign-rollup"],
    stripe: ["Visible only to you", "Operator blind", "Deleted after completion"]
  },
  {
    id: "verified",
    label: "Verified",
    blurb: "Adds denser receipts and stronger auditability for high-trust deliverables.",
    preset: "verifiable-minimal",
    operatorVisible: false,
    providerVisible: false,
    proofLevel: "proof-backed",
    maxSpendMina: "0.25",
    retention: "Checkpoint only",
    defaultArtifactVisibility: "operator-blind",
    defaultProvingLocation: "client",
    supportedProvingLocations: ["client", "server", "sovereign-rollup"],
    stripe: ["Operator blind", "Receipt complete", "Selective disclosure only"]
  },
  {
    id: "team-governed",
    label: "Team-governed",
    blurb: "For enterprise workflows with guardians, privacy exceptions, and shared review.",
    preset: "workspace-private",
    operatorVisible: false,
    providerVisible: false,
    proofLevel: "proof-backed",
    maxSpendMina: "0.40",
    retention: "Workspace sealed",
    defaultArtifactVisibility: "team-sealed",
    defaultProvingLocation: "client",
    supportedProvingLocations: ["client", "server", "sovereign-rollup"],
    stripe: ["Visible to your workspace", "Privacy exceptions required", "Compliance scoped"]
  }
];
