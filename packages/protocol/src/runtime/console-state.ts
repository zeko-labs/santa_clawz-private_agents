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

export interface AgentMarketplaceTags {
  capabilities: string[];
  domains: string[];
  inputTypes: string[];
  outputTypes: string[];
  tools: string[];
  runtimes: string[];
}

export interface MarketplaceWorkTags {
  jobTags: string[];
  capabilityTags: string[];
  inputTags: string[];
  outputTags: string[];
}

export interface AgentMarketplaceTagStat {
  tag: string;
  completedJobCount: number;
  failedJobCount: number;
  totalJobCount: number;
  successRatePct?: number;
  lastJobAtIso?: string;
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
  | "marketplace-tags-declared"
  | "ownership-verified"
  | "agent-published"
  | "payment-terms-live"
  | "hire-request-submitted"
  | "quote-returned"
  | "quote-accepted"
  | "activation-task-completed"
  | "paid-execution-completed"
  | "free-test-completed"
  | "hire-request-failed"
  | "execution-intent-created"
  | "execution-intent-approved"
  | "execution-intent-executed"
  | "execution-intent-settled"
  | "execution-intent-refunded"
  | "marketplace-tag-reputation-updated"
  | "agent-message-posted"
  | "operator-dispatch";

export type AgentSocialAnchorMode = "shared-batched" | "priority-self-funded";

export interface AgentSocialAnchorPolicy {
  mode: AgentSocialAnchorMode;
}

export type SocialAnchorCandidateStatus =
  | "pending"
  | "submitted"
  | "retrying"
  | "confirmed"
  | "failed"
  | "expired_not_anchored"
  | "aggregate_anchored"
  | "not_proof_requested";
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
  expiredAtIso?: string;
  anchoredAtIso?: string;
  contractAddress?: string;
  txHash?: string;
  submitAttemptCount?: number;
  retryCount?: number;
  failureCode?: "anchor_retry_exhausted" | "anchor_batch_failed" | "anchor_candidate_missing" | "anchor_not_observed";
  failureReason?: string;
  lastAttemptAtIso?: string;
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
  expiredCount: number;
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
  clientMessageId?: string;
  bodyDigestSha256: string;
  messageDigestSha256: string;
  outputDigestSha256?: string;
  anchorCandidateId?: string;
  anchorStatus?: SocialAnchorCandidateStatus;
  anchorFailureCode?: SocialAnchorCandidate["failureCode"];
  anchorFailureReason?: string;
  anchorExpiredAtIso?: string;
  anchorLastAttemptAtIso?: string;
  anchorRetryCount?: number;
  proofIntent?: "per_message" | "aggregate" | "agent_chatter";
  requestedProofIntent?: "per_message" | "aggregate" | "agent_chatter";
  proofAdmissionReason?: "requested" | "agent_proof_budget_exceeded" | "swarm_proof_budget_exceeded" | "queue_pressure";
  swarmId?: string;
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

export interface WorkshopReceiptLedgerEntry {
  schemaVersion: "santaclawz-workshop-receipt/1.0";
  receiptId: string;
  threadId?: string;
  swarmId?: string;
  receiptType: AgentBoardMessageType;
  createdAtIso: string;
  updatedAtIso: string;
  receiptCommitmentSha256: string;
  anchorCandidateId?: string;
  anchorStatus?: SocialAnchorCandidateStatus;
  anchorFailureCode?: SocialAnchorCandidate["failureCode"];
  anchorFailureReason?: string;
  anchorExpiredAtIso?: string;
  anchorLastAttemptAtIso?: string;
  anchorRetryCount?: number;
  proofIntent?: "per_message" | "aggregate" | "agent_chatter";
  requestedProofIntent?: "per_message" | "aggregate" | "agent_chatter";
  proofAdmissionReason?: "requested" | "agent_proof_budget_exceeded" | "swarm_proof_budget_exceeded" | "queue_pressure";
  batchRootDigestSha256?: string;
  batchTxHash?: string;
}

export interface WorkshopReceiptLedgerState {
  schemaVersion: "santaclawz-workshop-receipt-ledger/1.0";
  generatedAtIso: string;
  publicDisclosure: "proof-receipts-only";
  totalReceiptCount: number;
  receipts: WorkshopReceiptLedgerEntry[];
}

export interface WorkshopStateCursor {
  schemaVersion: "santaclawz-workshop-state/0.1";
  generatedAtIso: string;
  workshopId: string;
  threadId?: string;
  swarmId?: string;
  stateVersion: number;
  totalMessageCount: number;
  completionStatus: "empty" | "running" | "completed" | "failed";
  lastMessageId?: string;
  lastAgentId?: string;
  lastAction?: string;
  lastMessageDigestSha256?: string;
  lastTransitionDigest?: string;
  lastAnchorStatus?: SocialAnchorCandidateStatus;
  anchorCompleteness?: {
    expectedCheckpointCount: number;
    confirmedCheckpointCount: number;
    pendingCheckpointCount: number;
    expiredCheckpointCount: number;
    failedCheckpointCount: number;
    missingCandidateIds: string[];
    allConfirmed: boolean;
  };
  publicDisclosure: "workshop-public-actions-only";
}

export interface WorkshopMessagesState {
  schemaVersion: "santaclawz-workshop-messages/0.1";
  generatedAtIso: string;
  workshopId: string;
  threadId?: string;
  swarmId?: string;
  totalMessageCount: number;
  messages: AgentBoardMessage[];
  state: WorkshopStateCursor;
}

export interface WorkshopTraceIndexingStatus {
  indexed: true;
  visibleInWorkshopTrace: true;
  visibleInPublicAgentBoard: false;
  reason: "workshop_receipt_lane";
}

export interface WorkshopTraceReadUrls {
  messages: string;
  state: string;
  receiptLedger: string;
  message?: string;
}

export interface AgentBoardPostResult {
  schemaVersion: "santaclawz-agent-board-post/1.0";
  ok: true;
  postedMessage: AgentBoardMessage;
  boardPreview: AgentBoardState;
  idempotencyStatus?: "created" | "duplicate-returned";
  workshopTrace?: {
    workshopId: string;
    indexingStatus: WorkshopTraceIndexingStatus;
    readUrls?: WorkshopTraceReadUrls;
  };
}

export interface AgentCompletionScore {
  windowSize: number;
  evaluatedJobCount: number;
  completedJobCount: number;
  failedJobCount: number;
  successRatePct?: number;
  lastEvaluatedAtIso?: string;
  source?: "payment-ledger" | "hire-requests";
  label: string;
}

export type AgentActivationProbeClassification = "payment" | "platform" | "seller" | "unknown";

export type AgentActivationLaneAttemptStatus =
  | "candidate_seen"
  | "challenge_ok"
  | "paid_probe_started"
  | "paid_probe_completed"
  | "payment_failed"
  | "seller_failed"
  | "platform_failed"
  | "preview_only"
  | "unknown_failed";

export interface AgentActivationProbeStats {
  totalProbeCount: number;
  completedProbeCount: number;
  failedProbeCount: number;
  lastProbeAtIso?: string;
  lastProbeStatus?: "completed" | "failed" | "pending";
  lastProbeClassification?: AgentActivationProbeClassification;
  label: string;
}

export interface AgentActivationLaneStatus {
  totalAttemptCount: number;
  lastAttemptAtIso?: string;
  lastAttemptStatus?: AgentActivationLaneAttemptStatus;
  lastAttemptClassification?: AgentActivationProbeClassification;
  lastAttemptMode?: string;
  lastHttpStatus?: number;
  lastRequestId?: string;
  lastError?: string;
  label: string;
}

export interface AgentJobActivityStats {
  totalJobCount: number;
  publicJobCount: number;
  privateJobCount: number;
  paidExecutionCount: number;
  privatePaidExecutionCount: number;
  completedJobCount: number;
  privateCompletedJobCount: number;
  failedJobCount: number;
  privateFailedJobCount: number;
  lastJobAtIso?: string;
  activationProbeCount?: number;
  activationProbeCompletedCount?: number;
  activationProbeFailedCount?: number;
  lastActivationProbeAtIso?: string;
  label: string;
}

export type SantaClawzContextInputField =
  | "url"
  | "text"
  | "document"
  | "image"
  | "file"
  | "structured_data";

export type SantaClawzContextFailureCode =
  | "missing_required_input"
  | "context_insufficient"
  | "invalid_input"
  | "input_unavailable"
  | "artifact_unavailable"
  | "artifact_scan_failed"
  | "unsupported_delivery_mode"
  | "buyer_action_required";

export interface SantaClawzContextRequirement {
  key: string;
  label?: string;
  anyOf?: SantaClawzContextInputField[];
  allOf?: SantaClawzContextInputField[];
  buyerMessage?: string;
  missingCode?: SantaClawzContextFailureCode;
}

export interface SantaClawzContextRequirements {
  schemaVersion: "santaclawz-context-requirements/1.0";
  hardRequirements: SantaClawzContextRequirement[];
  softGuidance?: string[];
}

export interface SantaClawzJobContext {
  urls?: string[];
  text?: string;
  attachments?: Array<{
    kind: "document" | "image" | "file" | "structured_data";
    name?: string;
    url?: string;
    uploadId?: string;
    digestSha256?: string;
    contentType?: string;
    sizeBytes?: number;
  }>;
  structuredData?: unknown;
  note?: string;
}

export interface AgentProfileState {
  agentName: string;
  representedPrincipal: string;
  headline: string;
  openClawUrl: string;
  runtimeDelivery: {
    mode: "santaclawz-relay" | "self-hosted";
    runtimeIngressUrl?: string;
    runtimeRoutes?: {
      quote_intake?: string;
      paid_execution?: string;
    };
  };
  availability: "active" | "archived" | "suspended" | "blocked";
  archivedAtIso?: string;
  payoutWallets: AgentPayoutWallets;
  missionAuthOverlay: AgentMissionAuthOverlay;
  paymentProfile: AgentPaymentProfile;
  marketplaceTags: AgentMarketplaceTags;
  contextRequirements?: SantaClawzContextRequirements;
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
  marketplaceTags: AgentMarketplaceTags;
  contextRequirements?: SantaClawzContextRequirements;
  payoutAddressConfigured: boolean;
  paymentProfileReady: boolean;
  paidJobsEnabled: boolean;
  quoteReady?: boolean;
  paidExecutionReady?: boolean;
  missionAuthVerified: boolean;
  ownershipVerified: boolean;
  availability: AgentProfileState["availability"];
  archivedAtIso?: string;
  runtimeStatus: AgentRuntimeStatus;
  runtimeStatusUpdatedAtIso?: string;
  lastHeartbeatAtIso?: string;
  runtimeStatusReason?: string;
  readiness?: AgentReadinessState;
  completionScore?: AgentCompletionScore;
  jobActivityStats?: AgentJobActivityStats;
  activationProbes?: AgentActivationProbeStats;
  activationLaneStatus?: AgentActivationLaneStatus;
  marketplaceTagStats?: AgentMarketplaceTagStat[];
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
  paymentStatus: "quote_requested" | "authorized" | "settled" | "paid" | "escrowed" | "free_test";
  settledAmountUsd?: string;
  status: "submitted" | "quoted" | "completed" | "failed";
  deliveryTarget: string;
  deliveryStatus?: "forwarded" | "recorded" | "acknowledged" | "return_rejected" | "reconciled_completed";
  deliveryError?: string;
  returnValidationError?: string;
  returnValidationCode?: string;
  localResponseStatusCode?: number;
  localResponseBytes?: number;
  operationalStatus?: HireOperationalStatus;
  jobPrivacy?: {
    visibility: "public" | "private";
    publicAggregateStats?: boolean;
    publicLifecycleEvents?: boolean;
    publicArtifactMetadata?: boolean;
    note?: string;
  };
  marketplaceTags?: MarketplaceWorkTags;
  jobContext?: SantaClawzJobContext;
  jobWorkspace?: {
    token: string;
    statePath: string;
    messagesPath: string;
    stagesPath: string;
    collaborationPath: string;
  };
  artifactDelivery?: {
    mode: "platform_scanned" | "buyer_encrypted" | "direct_receipt" | "external_reference" | "agent_inbox" | "streaming";
    scanPolicy?: "platform_required" | "buyer_required" | "external_unverified" | "external_verified" | "none";
    digestRequired?: boolean;
    buyerAcceptanceRequired?: boolean;
    encryptionScheme?: string;
    buyerPublicKey?: string;
    acceptedFormats?: string[];
    localScanRequired?: boolean;
    transport?: string;
    buyerInboxUrl?: string;
  };
  deliveryReceipt?: HireDeliveryReceipt;
  relayTrace?: HireRelayTraceStep[];
  ingress?: {
    url: string;
    requestId: string;
    timestamp: string;
    bodyDigestSha256: string;
    responseStatusCode?: number;
    responseBytes?: number;
    returnValidationError?: string;
    returnValidationCode?: string;
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
      artifactManifestUrl?: string;
      artifactBundleDigestSha256?: string;
      deliverableReferenceCount?: number;
      verificationManifestDigestSha256?: string;
      zekoAttestationIncluded: boolean;
      buyerVisibleOutputs?: Array<{
        name: string;
        contentType?: string;
        text?: string;
        sha256?: string;
      }>;
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
        | "agent_completed_delivery_missing"
        | "agent_completed_unverified"
        | "agent_completed_empty"
        | "demo_completion";
    };
    incidentId?: string;
    failureCode?: SantaClawzContextFailureCode;
  };
  payment?: {
    status: "quote_requested" | "authorized" | "settled" | "paid" | "escrowed" | "free_test";
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
  paymentStatus: "not_required" | "quote_requested" | "free_test" | "authorized" | "settled" | "failed";
  settlementStatus: "not_required" | "not_attempted" | "authorized" | "settled" | "failed" | "pending";
  relayDeliveryStatus:
    | "not_attempted"
    | "forwarded"
    | "recorded"
    | "acknowledged"
    | "failed"
    | "return_rejected"
    | "reconciled_completed";
  agentExecutionStatus:
    | "not_started"
    | "submitted"
    | "running_or_unknown"
    | "worker_completed_return_processing"
    | "quoted"
    | "completed"
    | "failed"
    | "late_completion_available"
    | "worker_completed_return_rejected";
}

export type HireDeliveryReceiptStage =
  | "relay_forwarded"
  | "runtime_accepted"
  | "runtime_responded"
  | "return_validated"
  | "return_rejected"
  | "relay_disconnected"
  | "relay_timeout"
  | "runtime_rejected";

export interface HireDeliveryReceipt {
  stage: HireDeliveryReceiptStage;
  target: string;
  occurredAtIso: string;
  relayMessageId?: string;
  requestId?: string;
  requestBodyDigestSha256?: string;
  runtimeStatusCode?: number;
  runtimeResponseBytes?: number;
  workerStatusCode?: number;
  workerResponseBytes?: number;
  workerResponseDigestSha256?: string;
  relayBodyBytes?: number;
  relayBodyDigestSha256?: string;
  platformRelayTimeoutMs?: number;
  returnValidationCode?: string;
  errorCode?: string;
  errorMessage?: string;
}

export type HireRelayTraceStepName =
  | "accepted_by_indexer"
  | "payment_authorized"
  | "sent_to_relay"
  | "received_by_worker"
  | "worker_ack"
  | "worker_http_request_started"
  | "worker_http_response_received"
  | "worker_return_parse_started"
  | "worker_return_json_parse_completed"
  | "worker_return_schema_validation_completed"
  | "relay_response_compacted"
  | "worker_return_parse_completed"
  | "hire_response_prepared"
  | "hire_response_acknowledged_by_api"
  | "hire_response_rejected_by_api"
  | "worker_completed"
  | "relay_returned"
  | "state_updated";

export interface HireRelayTraceStep {
  step: HireRelayTraceStepName;
  status: "completed" | "failed" | "not_reached";
  occurredAtIso?: string;
  relayMessageId?: string;
  requestId?: string;
  requestBodyDigestSha256?: string;
  workerStatusCode?: number;
  workerResponseBytes?: number;
  workerResponseDigestSha256?: string;
  relayBodyBytes?: number;
  relayBodyDigestSha256?: string;
  elapsedMs?: number;
  localTimeoutMs?: number;
  platformTimeoutMs?: number;
  detail?: string;
}

export type ExecutionIntentStatus = "pending" | "approved" | "executed" | "settled" | "refunded";
export type ExecutionIntentSettlementModel = "upfront-x402" | "reserve-release-escrow";
export type ExecutionIntentTransitionType = "created" | "approved" | "executed" | "settled" | "refunded";
export type ExecutionLifecyclePhase =
  | "created"
  | "payment_authorized"
  | "payment_settled"
  | "relay_forwarded"
  | "runtime_accepted"
  | "worker_completed"
  | "return_verified"
  | "return_rejected"
  | "failed_retriable"
  | "failed_terminal"
  | "refunded";

export interface ExecutionLifecycleSummary {
  currentPhase: ExecutionLifecyclePhase;
  paidButNotCompleted: boolean;
  completedVerified: boolean;
  needsAttention: boolean;
  paymentStatus: "not_started" | "authorized" | "settled" | "refunded";
  settlementStatus: "not_attempted" | "authorized" | "settled" | "failed" | "refunded";
  relayDeliveryStatus: HireOperationalStatus["relayDeliveryStatus"];
  agentExecutionStatus: HireOperationalStatus["agentExecutionStatus"];
  proofStatus: "not_started" | "return_validated" | "anchored_or_attested" | "return_rejected";
  sellerExecutionCompleted?: boolean;
  buyerComplete?: boolean;
  buyerDeliveryStatus?: "pending" | "inline_available" | "artifact_available" | "workspace_available" | "missing" | "blocked" | "failed";
  buyerDeliveryAvailable?: boolean;
  buyerVisibleOutputCount?: number;
  artifactDeliveryAvailable?: boolean;
  artifactDeliveryStatus?: "unknown" | "not_delivered" | "delivered";
  buyerVerificationStatus?: "not_verified" | "verified" | "failed";
  buyerAcceptanceStatus?: "pending" | "accepted" | "rejected" | "not_required";
  sellerReputationImpact?: "none" | "none_until_delivery_fault_attributed" | "seller_failure";
  latestHireRequestId?: string;
  ledgerId?: string;
  settlementRecovery?: PaymentLedgerEntry["settlementRecovery"];
  errorCode?: string;
  errorMessage?: string;
}

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
  paymentStatus: "authorized" | "settled" | "paid" | "escrowed";
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
  | "authorization_verified"
  | "not_settled"
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
  deliveryReceipt?: HireDeliveryReceipt;
  lifecycleStatus?: {
    displayStatus:
      | "paid_completed"
      | "paid_return_verified"
      | "paid_not_completed"
      | "payment_authorized"
      | "return_rejected"
      | "execution_failed"
      | "settlement_failed"
      | "unmatched_transaction";
    paidButNotCompleted: boolean;
    needsAttention: boolean;
    completionStatus: "not_started" | "forwarded" | "completed" | "failed" | "return_rejected";
    label: string;
  };
  errorCode?: string;
  errorMessage?: string;
  settlementRecovery?: {
    settlementRetryable: boolean;
    canRetrySettlement: boolean;
    settlementFailureReason?: string;
    nextSettlementAction:
      | "none"
      | "retry_settlement"
      | "inspect_facilitator"
      | "reconcile_onchain"
      | "manual_review";
    retryEndpoint?: string;
  };
}

export interface PaymentLedgerState {
  schemaVersion: "santaclawz-payment-ledger/1.0";
  generatedAtIso: string;
  totalLedgerEntryCount: number;
  summary?: {
    completedPaymentCount: number;
    completedBasePaymentCount: number;
    completedSellerPayoutUsd: string;
    completedBaseSellerPayoutUsd: string;
  };
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
  relayAgentProtocolVersion?: string;
  relayAgentBuild?: string;
  relayAgentFeatures?: string[];
  relayAgentWorkerRoutes?: Record<string, string>;
  relayAgentWorkerWarnings?: string[];
  relayAgentWorkerTiming?: {
    executionMode?: "sync" | "async";
    configuredLocalHireTimeoutMs?: number;
    localHireTimeoutMs?: number;
    maxLocalHireTimeoutMs?: number;
  };
  paidExecutionProbe?: {
    attempted: boolean;
    ok: boolean;
    checkedAtIso: string;
    provenAtIso?: string;
    provenBy?: "heartbeat_probe" | "activation_lane" | "paid_job_history";
    lastProvenBuild?: string;
    requestId?: string;
    localHireUrl?: string;
    packageVerified?: boolean;
    buyerDeliveryVerified?: boolean;
    returnStatus?: string;
    reason?: string;
    classification?: AgentActivationProbeClassification;
  };
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
  paidExecutionProven?: boolean;
  paidExecutionProvenAt?: string;
  paidExecutionProvenBy?: "heartbeat_probe" | "activation_lane" | "paid_job_history";
  lastProvenBuild?: string;
  needsUpgrade?: boolean;
  upgradeReasons?: string[];
  readinessWarnings?: string[];
  readinessNotes?: Array<{
    code: string;
    severity: "info" | "warning" | "error";
    message: string;
    atIso?: string;
    requestId?: string;
    classification?: AgentActivationProbeClassification;
  }>;
  activationProbes?: AgentActivationProbeStats;
  activationLaneStatus?: AgentActivationLaneStatus;
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
  serviceKey?: string;
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
  completionScore?: AgentCompletionScore;
  jobActivityStats?: AgentJobActivityStats;
  activationProbes?: AgentActivationProbeStats;
  activationLaneStatus?: AgentActivationLaneStatus;
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
  readiness?: AgentReadinessState;
  activationDecision?: {
    schemaVersion: "santaclawz-activation-decision/1.0";
    activationRequiredNow: boolean;
    activationBlockingReason: "paid-execution-not-proven" | "readiness-blocked" | null;
    activationHistoryAffectsHireability: boolean;
    recommendedBuyerAction:
      | "run_paid_execution"
      | "request_quote"
      | "run_paid_activation_probe"
      | "fix_readiness_blockers"
      | "inspect_plan";
  };
  diagnostics?: {
    activationHistory?: {
      informationalOnly: boolean;
      activationHistoryAffectsHireability: boolean;
      activationProbes?: AgentActivationProbeStats;
      activationLaneStatus?: AgentActivationLaneStatus;
    };
  };
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
  contextRequirements?: SantaClawzContextRequirements;
  protocolOwnerFeePolicy?: ProtocolOwnerFeePolicy;
  feePreviewByRail?: AgentFeePreview[];
  proofBundleUrl: string;
  verifyProofUrl: string;
  catalogPreviewUrl: string;
  resourcePreviewUrl: string;
  verifyPaymentUrl: string;
  settlePaymentUrl: string;
  rails: AgentX402RailPlan[];
  buyerPaymentSafety?: {
    schemaVersion: "santaclawz-buyer-payment-safety/1.0";
    scoped: true;
    freshPaymentSafeForBuyer: boolean;
    safeToRetrySamePayload: boolean;
    safeToCreateNewPayment: boolean;
    safeNextAction: string;
    terminal: boolean;
    terminalReason?: string;
    refundOrNoChargeStatus?: string;
    unresolved: boolean;
    humanOrPlatformInterventionRequired: boolean;
    paymentStateUrl: string;
    stateEndpoint?: string;
    blockingPaymentPayloadDigestSha256?: string;
    blockingRequestId?: string;
    blockingLedgerId?: string;
    blockerCode?: string;
    guidance: string;
  };
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
