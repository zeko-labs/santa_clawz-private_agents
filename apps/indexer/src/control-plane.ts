import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAddress, verifyMessage } from "viem";

import { createSealedBlobStore, type SealedBlobStore } from "@clawz/blob-store";
import {
  buildSocialAnchorBatchRootField,
  readSocialAnchorKernelStateOnZeko,
  submitSocialAnchorBatchOnZeko
} from "@clawz/contracts";
import { createTenantKeyBroker, type TenantKeyBrokerRuntimeDescriptor, TenantKeyBroker } from "@clawz/key-broker";
import {
  SANTACLAWZ_HIRE_REQUEST_SCHEMA_VERSION,
  SANTACLAWZ_QUOTE_ACCEPTANCE_WALLET_PROOF_SCHEME,
  assertValidSantaClawzHireServiceIdentity,
  assertValidSantaClawzHirePolicy,
  buildSantaClawzQuoteAcceptanceMessage,
  buildJobPackBuyerRoutePlan,
  canonicalDigest,
  paymentStatusForHireRequest,
  type AgentPaymentRail,
  type AgentRuntimeHeartbeatState,
  type AgentRuntimeStatus,
  type AgentRuntimeAvailabilityState,
  type AgentRegistryEntry,
  type ExecutionIntentLifecycleEntry,
  type ExecutionLifecycleSummary,
  type ExecutionIntentRecord,
  type ExecutionIntentSettlementModel,
  type ExecutionIntentState,
  type ExecutionIntentStatus,
  type ExecutionIntentTransitionType,
  type JobPackBuyerRouterMode,
  type AgentOwnershipChallengeState,
  type AgentOwnershipState,
  type AgentOwnershipVerificationState,
  type AgentBoardMessage,
  type AgentBoardMessageType,
  type AgentBoardPostResult,
  type AgentBoardState,
  type AgentBoardThread,
  type AgentCompletionScore,
  type AgentJobActivityStats,
  type AgentMarketplaceTagStat,
  type AgentMarketplaceTags,
  type AgentProfileState,
  type AgentReadinessState,
  type HireDeliveryReceipt,
  type HireRelayTraceStep,
  type HireRequestReceipt,
  type SponsorQueueJob,
  type SponsorQueueState,
  TRUST_MODE_PRESETS,
  assertClawzEvent,
  sampleRetentionPolicy,
  type ArtifactSummary,
  type ClawzEvent,
  type ConsoleStateResponse,
  type SantaClawzHireRequestType,
  type LiveFlowDisclosureTarget,
  type LiveSessionTurnFlowState,
  type LiveFlowTargets,
  type LiveFlowTurnTarget,
  type PaymentLedgerEntry,
  type PaymentLedgerState,
  type PaymentLedgerStatus,
  type PrivacyApprovalRecord,
  type PrivacyExceptionQueueItem,
  type MarketplaceWorkTags,
  type SocialAnchorBatch,
  type SocialAnchorBatchExport,
  type SocialAnchorCandidate,
  type SocialAnchorCandidateKind,
  type SocialAnchorCandidateStatus,
  type SocialAnchorQueueState,
  type SantaClawzQuoteAcceptanceWalletProof,
  type SantaClawzArtifactDeliveryPreference,
  type SantaClawzJobPrivacyPreference,
  type ShadowWalletState,
  type TrustModeId,
  type ZekoContractDeployment,
  type ZekoDeploymentState
} from "@clawz/protocol";
import { buildGhostRunPlan } from "@clawz/worker-runtime";

import { ReplayMaterializer } from "./materializer.js";
import { buildProtocolOwnerFeePolicyFromEnv } from "./protocol-owner-fee.js";
import { sampleEvents } from "./sample-data.js";

const DEFAULT_TENANT_ID = "tenant_acme";
const DEFAULT_WORKSPACE_ID = "workspace_blue";
const DEFAULT_SESSION_ID = "session_demo_enterprise";
const DEFAULT_TURN_ID = "turn_0011";
const PUBLICCLAWZ_OWNERSHIP_CHALLENGE_PATH = "/.well-known/santaclawz-agent-challenge.json";
const OWNERSHIP_CHALLENGE_TTL_MS = 15 * 60 * 1000;
const AGENT_RUNTIME_CHECK_TIMEOUT_MS = 5000;
const AGENT_RUNTIME_HEARTBEAT_DEFAULT_TTL_SECONDS = 30;
const AGENT_RUNTIME_HEARTBEAT_MIN_TTL_SECONDS = 10;
const AGENT_RUNTIME_HEARTBEAT_MAX_TTL_SECONDS = 300;
const AGENT_RUNTIME_HEARTBEAT_WRITE_MIN_INTERVAL_MS = integerEnv("CLAWZ_AGENT_HEARTBEAT_WRITE_MIN_INTERVAL_MS", 5000);
const HIRE_REQUEST_SCHEMA_VERSION = SANTACLAWZ_HIRE_REQUEST_SCHEMA_VERSION;
const HIRE_RETURN_SCHEMA_VERSION = "santaclawz-return/1.0";
const HIRE_INGRESS_TIMEOUT_MS = 10_000;
const HIRE_INGRESS_RETURN_MAX_BYTES = 128 * 1024;
const HIRE_TASK_PROMPT_MAX_LENGTH = 2000;
const HIRE_REQUESTER_CONTACT_MAX_LENGTH = 240;
const AGENT_BOARD_MESSAGE_MAX_LENGTH = 1200;
const AGENT_BOARD_TOPIC_MAX_COUNT = 5;
const AGENT_BOARD_TOPIC_MAX_LENGTH = 40;
const AGENT_BOARD_CAPABILITY_MAX_COUNT = 8;
const AGENT_BOARD_CAPABILITY_MAX_LENGTH = 64;
const BLOCKED_PUBLIC_TERMS_ENV = "CLAWZ_BLOCKED_PUBLIC_TERMS";
const EXECUTION_INTENT_SCHEMA_VERSION = "santaclawz-execution-intent/1.0";
const FREE_TEST_HIRE_WINDOW_MS = 10 * 60 * 1000;
const FREE_TEST_HIRE_LIMIT_PER_AGENT =
  Number.parseInt(process.env.CLAWZ_FREE_TEST_AGENT_HIRE_LIMIT_PER_10M ?? "", 10) || 10;
const FREE_TEST_HIRE_LIMIT_GLOBAL =
  Number.parseInt(process.env.CLAWZ_FREE_TEST_GLOBAL_HIRE_LIMIT_PER_10M ?? "", 10) || 50;
const MAINNET_FREE_TEST_HIRE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAINNET_FREE_TEST_LIMIT_PER_AGENT_WITH_PAYOUT =
  Number.parseInt(process.env.CLAWZ_MAINNET_FREE_TEST_AGENT_HIRE_LIMIT_PER_DAY ?? "", 10) || 2;
const MAINNET_FREE_TEST_LIMIT_PER_AGENT_WITHOUT_PAYOUT =
  Number.parseInt(process.env.CLAWZ_MAINNET_FREE_TEST_AGENT_NO_PAYOUT_LIMIT_PER_DAY ?? "", 10) || 1;
const MAINNET_FREE_TEST_LIMIT_GLOBAL =
  Number.parseInt(process.env.CLAWZ_MAINNET_FREE_TEST_GLOBAL_HIRE_LIMIT_PER_DAY ?? "", 10) || 20;
const ENROLLMENT_TICKET_TTL_MS = 15 * 60 * 1000;
const ENROLLMENT_TICKET_SCHEMA_VERSION = "santaclawz-enrollment-ticket/1.0";
const JOB_COMPLETION_SCORE_WINDOW_SIZE = 100;
const JOB_COMPLETION_STALE_MS = 30 * 60 * 1000;
const HIRE_REQUEST_GLOBAL_RECENT_RETAIN_LIMIT = parseBoundedIntegerEnv(
  "CLAWZ_HIRE_REQUEST_GLOBAL_RECENT_RETAIN_LIMIT",
  10_000,
  200,
  100_000
);
const HIRE_REQUEST_PER_AGENT_PAID_RETAIN_LIMIT = parseBoundedIntegerEnv(
  "CLAWZ_HIRE_REQUEST_PER_AGENT_PAID_RETAIN_LIMIT",
  JOB_COMPLETION_SCORE_WINDOW_SIZE,
  JOB_COMPLETION_SCORE_WINDOW_SIZE,
  1_000
);
const HIRE_REQUEST_GLOBAL_SAFETY_RETAIN_LIMIT = parseBoundedIntegerEnv(
  "CLAWZ_HIRE_REQUEST_GLOBAL_SAFETY_RETAIN_LIMIT",
  100_000,
  HIRE_REQUEST_GLOBAL_RECENT_RETAIN_LIMIT,
  1_000_000
);
type LiveFlowKind = "first-turn" | "next-turn" | "abort-turn" | "refund-turn" | "revoke-disclosure";
type HireIngressRequestKind = SantaClawzHireRequestType;
type SocialAnchorQueueStateOptions = {
  itemLimit?: number;
  batchLimit?: number;
  statuses?: SocialAnchorCandidateStatus[];
  kinds?: SocialAnchorCandidateKind[];
};
type HireCompletionClassification =
  | "agent_completed_verified"
  | "agent_completed_unverified"
  | "agent_completed_empty"
  | "demo_completion";
type RuntimeDeliveryMode = AgentProfileState["runtimeDelivery"]["mode"];
interface SignedHireIngressRequest {
  ingressUrl: string;
  requestKind: HireIngressRequestKind;
  body: string;
  bodyDigestSha256: string;
  headers: Record<string, string>;
}
type RelayRuntimeStatusProvider = (agentId: string) => boolean;
type RelayHireDeliveryHandler = (input: {
  agentId: string;
  sessionId: string;
  signedRequest: SignedHireIngressRequest;
}) => Promise<{
  statusCode: number;
  body: string;
  deliveryTarget: string;
  relayMessageId?: string;
  workerStatusCode?: number;
  workerResponseBytes?: number;
  workerResponseDigestSha256?: string;
  relayBodyBytes?: number;
  relayBodyDigestSha256?: string;
  relayTrace?: HireRelayTraceStep[];
}>;

const LIVE_FLOW_METHODS: Record<LiveFlowKind, readonly string[]> = {
  "first-turn": [
    "SessionKernel.createSession",
    "TurnKernel.acquireLease",
    "ApprovalKernel.requestApproval",
    "ApprovalKernel.grantApproval",
    "EscrowKernel.reserveBudget",
    "TurnKernel.beginTurn",
    "TurnKernel.commitOutput",
    "EscrowKernel.settleTurn",
    "TurnKernel.finalizeTurn",
    "DisclosureKernel.grantDisclosure"
  ],
  "next-turn": [
    "SessionKernel.checkpointSession",
    "TurnKernel.acquireLease",
    "ApprovalKernel.requestApproval",
    "ApprovalKernel.grantApproval",
    "EscrowKernel.reserveBudget",
    "TurnKernel.beginTurn",
    "TurnKernel.commitOutput",
    "EscrowKernel.settleTurn",
    "TurnKernel.finalizeTurn",
    "DisclosureKernel.grantDisclosure"
  ],
  "abort-turn": ["ApprovalKernel.requestPrivacyException", "TurnKernel.abortTurn"],
  "refund-turn": ["EscrowKernel.refundTurn"],
  "revoke-disclosure": ["DisclosureKernel.revokeDisclosure"]
} as const;

const ALL_LIVE_FLOW_METHODS = Array.from(
  new Set(Object.values(LIVE_FLOW_METHODS).flatMap((methods) => methods))
);

interface ConsolePersistenceState {
  schemaVersion: 6;
  currentSessionId: string;
  activeMode: TrustModeId;
  wallet: ShadowWalletState;
  privacyExceptions: PrivacyExceptionQueueItem[];
  agentIdsBySession: Record<string, string>;
  profilesBySession: Record<string, AgentProfileState>;
  adminKeysBySession: Record<string, SessionAdminAccessRecord>;
  ingressSecretsBySession: Record<string, SessionIngressSecretRecord>;
  ownershipBySession: Record<string, SessionOwnershipRecord>;
  publishedSessionsBySession: Record<string, PublishedSessionRecord>;
  deletedAgentRegistrationsBySession: Record<string, DeletedAgentRegistrationRecord>;
  enrollmentTicketsById: Record<string, EnrollmentTicketRecord>;
}

interface SessionAdminAccessRecord {
  keyHash: string;
  keyHint: string;
  issuedAtIso: string;
}

interface DeletedAgentRegistrationRecord {
  agentId: string;
  deletedAtIso: string;
  reason: string;
}

interface PublishedSessionRecord {
  publishedAtIso: string;
  source: "live-flow" | "social-anchor" | "readiness-refresh" | "migration";
  batchId?: string;
  rootDigestSha256?: string;
}

interface SessionIngressSecretRecord {
  token: string;
  tokenHint: string;
  signingSecret: string;
  signingSecretHint: string;
  serviceKey?: string;
  issuedAtIso: string;
}

interface SessionOwnershipChallengeRecord extends AgentOwnershipChallengeState {
  challengeToken: string;
}

interface SessionOwnershipRecord {
  status: AgentOwnershipState["status"];
  legacyRegistration: boolean;
  canReclaim: boolean;
  challenge?: SessionOwnershipChallengeRecord;
  verification?: AgentOwnershipVerificationState;
}

interface EnrollmentTicketRecord {
  ticketId: string;
  ticketHash: string;
  issuedAtIso: string;
  expiresAtIso: string;
  status: "pending" | "redeemed";
  reservedSessionId: string;
  reservedAgentId: string;
  publicAgentUrl: string;
  publicHireUrl: string;
  profile: RegisterAgentOptions;
  redeemedAtIso?: string;
  redeemedSessionId?: string;
  redeemedAgentId?: string;
}

export class DuplicatePublicClawzUrlError extends Error {
  existingAgentId: string;
  canReclaim: boolean;

  constructor(message: string, existingAgentId: string, canReclaim: boolean) {
    super(message);
    this.name = "DuplicatePublicClawzUrlError";
    this.existingAgentId = existingAgentId;
    this.canReclaim = canReclaim;
  }
}

export class SelfServeSocialAnchoringDisabledError extends Error {
  constructor(message = "Self-serve social anchoring is disabled on testnet deployments.") {
    super(message);
    this.name = "SelfServeSocialAnchoringDisabledError";
  }
}

class HireReturnValidationError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "HireReturnValidationError";
  }
}

interface OwnershipChallengeIssueResult {
  state: ConsoleStateResponse;
  issuedOwnershipChallenge: {
    challengeId: string;
    challengePath: string;
    challengeUrl: string;
    verificationMethod: "well-known-http";
    issuedAtIso: string;
    expiresAtIso: string;
    challengeToken: string;
    challengeResponseJson: string;
  };
}

interface DeploymentManifestFile {
  networkId?: string;
  mina?: string;
  archive?: string;
  fee?: string;
  deployer?: string;
  generatedAt?: string;
  witnessPlanPath?: string;
  preparedContractCalls?: number;
  preparedProofCalls?: number;
  results?: Array<{
    label?: string;
    address?: string | null;
    status?: string;
    txHash?: string;
    fundedNewAccount?: boolean;
    secretSource?: "env" | "keychain";
  }>;
}

interface WitnessPlanFile {
  scenarioId?: string;
  contracts?: Array<{
    kernel?: string;
    method?: string;
  }>;
  proofs?: unknown[];
}

interface LiveSessionTurnFlowReportFile {
  scenarioId?: string;
  sessionId?: string;
  turnId?: string;
  generatedAtIso?: string;
  reportType?: "live-session-turn-flow";
  steps?: Array<{
    label?: string;
    kernel?: string;
    method?: string;
    contractAddress?: string;
    txHash?: string;
    changedSlots?: number[];
    occurredAtIso?: string;
    args?: Record<string, string>;
    handles?: Record<string, string>;
  }>;
}

interface LiveSessionTurnFlowStatusFile {
  status: LiveSessionTurnFlowState["status"];
  flowKind?: LiveFlowKind;
  jobId?: string;
  scenarioId?: string;
  trustModeId?: TrustModeId;
  sessionId?: string;
  turnId?: string;
  sourceTurnId?: string;
  sourceDisclosureId?: string;
  abortReason?: string;
  revocationReason?: string;
  refundAmountMina?: string;
  baseSlot?: string;
  requestedAtIso?: string;
  lastStartedAtIso?: string;
  lastFinishedAtIso?: string;
  currentStepLabel?: string;
  completedStepLabels?: string[];
  totalSteps?: number;
  attemptCount?: number;
  resumeAvailable?: boolean;
  lastError?: string;
  witnessPlanPath?: string;
  reportPath?: string;
}

interface LiveSessionTurnRuntimeInput {
  jobId: string;
  flowKind?: LiveFlowKind;
  scenarioId?: string;
  sessionId: string;
  turnId: string;
  sourceTurnId?: string;
  sourceDisclosureId?: string;
  abortReason?: string;
  revocationReason?: string;
  refundAmountMina?: string;
  tenantId: string;
  workspaceId: string;
  walletId: string;
  walletPublicKey: string;
  requestorKey?: string;
  workerId: string;
  baseSlot: string;
  trustModeId: TrustModeId;
  trustModeMaxSpendMina: string;
  sponsoredRemainingMina: string;
  requestedSpendMina?: string;
  defaultArtifactVisibility: (typeof TRUST_MODE_PRESETS)[number]["defaultArtifactVisibility"];
  operatorVisible: boolean;
  providerVisible: boolean;
  proofLevel: (typeof TRUST_MODE_PRESETS)[number]["proofLevel"];
  guardians: ShadowWalletState["guardians"];
  governancePolicy: ShadowWalletState["governancePolicy"];
  privacyExceptions: PrivacyExceptionQueueItem[];
}

interface LiveFlowRunOptions {
  flowKind?: LiveFlowKind;
  sessionId?: string;
  turnId?: string;
  sourceTurnId?: string;
  sourceDisclosureId?: string;
  abortReason?: string;
  revocationReason?: string;
  refundAmountMina?: string;
}

interface SponsorWalletOptions {
  amountMina?: string;
  adminKey?: string;
  sessionId?: string;
  purpose?: SponsorQueueJob["purpose"];
}

interface SocialAnchorQueueFile {
  items: SocialAnchorCandidate[];
  batches: SocialAnchorBatch[];
  lastError?: string;
  lastErrorAtIso?: string;
  lastErrorContext?: string;
}

interface AgentBoardFile {
  messages: AgentBoardMessage[];
}

interface SocialAnchorSettleOptions {
  sessionId?: string;
  agentId?: string;
  limit?: number;
  txHash?: string;
  expectedBatchId?: string;
  expectedRootDigestSha256?: string;
  localOnly?: boolean;
  operatorNote?: string;
  adminKey?: string;
}

interface SellerReadinessRefreshOptions {
  sessionId?: string;
  agentId?: string;
  publish?: boolean;
  localOnly?: boolean;
  verifyAvailability?: boolean;
  operatorNote?: string;
  adminKey?: string;
}

interface SocialAnchorExportOptions {
  sessionId?: string;
  agentId?: string;
  limit?: number;
  adminKey?: string;
}

interface AgentBoardListOptions {
  agentId?: string;
  threadId?: string;
  topic?: string;
  capability?: string;
  outputDigestSha256?: string;
  limit?: number;
}

interface AgentBoardPostOptions {
  agentId: string;
  adminKey?: string;
  authenticatedRelaySessionId?: string;
  messageType?: AgentBoardMessageType;
  body: string;
  topicTags?: string[];
  capabilityTags?: string[];
  threadId?: string;
  parentMessageId?: string;
  outputDigestSha256?: string;
  proofIntent?: "per_message" | "aggregate" | "agent_chatter" | "display_only";
  swarmId?: string;
}

type AgentBoardProofIntent = "per_message" | "aggregate" | "agent_chatter";
type AgentBoardProofAdmissionReason = NonNullable<AgentBoardMessage["proofAdmissionReason"]>;

type AgentAvailabilityState = AgentProfileState["availability"];

interface AdminAgentModerationOptions {
  agentId?: string;
  sessionId?: string;
  availability: Extract<AgentAvailabilityState, "active" | "suspended" | "blocked">;
  reason?: string;
}

interface ZekoSocialAnchorHealth {
  networkId: string;
  graphqlEndpoint: string;
  archiveEndpoint: string;
  contractConfigured: boolean;
  submitterConfigured: boolean;
  signerConfigured: boolean;
  canAutoAnchorSharedBatches: boolean;
  pendingCount: number;
  submittedCount: number;
  retryingCount: number;
  confirmedCount: number;
  failedCount: number;
  latestObservedRoot?: string;
  latestObservedDigest?: string;
  latestObservedBatchCount?: string;
  latestObservedAtIso?: string;
  latestConfirmedRootDigestSha256?: string;
  lastSuccessfulAnchorAtIso?: string;
  lastError?: string;
  lastErrorAtIso?: string;
  alerts: string[];
  recentBatches: SocialAnchorBatch[];
}

interface ZekoHealthState {
  chain: "zeko";
  networkId: string;
  mode: ZekoDeploymentState["mode"];
  generatedAtIso: string;
  socialAnchor: ZekoSocialAnchorHealth;
}

interface RegisterAgentOptions {
  agentName: string;
  representedPrincipal?: string;
  headline: string;
  urlReservationSalt?: string;
  openClawUrl?: string;
  runtimeDelivery?: Partial<AgentProfileState["runtimeDelivery"]>;
  payoutWallets?: AgentProfileState["payoutWallets"];
  missionAuthOverlay?: Partial<AgentProfileState["missionAuthOverlay"]>;
  paymentProfile?: Partial<AgentProfileState["paymentProfile"]>;
  marketplaceTags?: Partial<AgentMarketplaceTags>;
  socialAnchorPolicy?: Partial<AgentProfileState["socialAnchorPolicy"]>;
  payoutAddress?: string;
  trustModeId?: TrustModeId;
  preferredProvingLocation?: AgentProfileState["preferredProvingLocation"];
}

interface EnrollmentTicketIssueResult {
  ticket: string;
  ticketId: string;
  issuedAtIso: string;
  expiresAtIso: string;
  reservedSessionId: string;
  reservedAgentId: string;
  publicAgentUrl: string;
  publicHireUrl: string;
  challengePath: string;
  enrollmentChallenge: {
    schemaVersion: typeof ENROLLMENT_TICKET_SCHEMA_VERSION;
    ticketId: string;
    ticketDigestSha256: string;
    challengePath: string;
    publicAgentUrl: string;
    publicHireUrl: string;
  };
}

interface EnrollmentTicketRedeemResult extends ConsoleStateResponse {
  issuedOwnershipChallenge?: OwnershipChallengeIssueResult["issuedOwnershipChallenge"];
}

interface OwnershipActionOptions {
  sessionId?: string;
  agentId?: string;
  adminKey?: string;
}

interface AgentArchiveOptions {
  sessionId?: string;
  agentId?: string;
  archived: boolean;
  adminKey?: string;
}

interface DeleteAgentRegistrationOptions {
  sessionId?: string;
  agentId?: string;
  reason?: string;
}

type AgentProfileInput = Partial<
  Omit<AgentProfileState, "paymentProfile" | "socialAnchorPolicy" | "missionAuthOverlay" | "runtimeDelivery" | "marketplaceTags">
> & {
  missionAuthOverlay?: Partial<AgentProfileState["missionAuthOverlay"]>;
  paymentProfile?: Partial<AgentProfileState["paymentProfile"]>;
  runtimeDelivery?: Partial<AgentProfileState["runtimeDelivery"]>;
  marketplaceTags?: Partial<AgentMarketplaceTags>;
  socialAnchorPolicy?: Partial<AgentProfileState["socialAnchorPolicy"]>;
  payoutAddress?: unknown;
};

interface SubmitHireRequestOptions {
  agentId: string;
  taskPrompt: string;
  budgetMina?: string;
  requesterContact: string;
  marketplaceTags?: Partial<MarketplaceWorkTags>;
  jobPrivacy?: SantaClawzJobPrivacyPreference;
  artifactDelivery?: SantaClawzArtifactDeliveryPreference;
  paymentAuthorization?: HirePaymentAuthorization;
}

interface AcceptQuoteForPaymentOptions {
  agentId: string;
  requestId: string;
  buyerAgentId?: string;
  buyerWallet?: string;
  buyerWalletProof?: Partial<SantaClawzQuoteAcceptanceWalletProof>;
  acceptedAmountUsd: string;
  acceptedQuoteDigestSha256: string;
  maxAmountUsd?: string;
  rail?: AgentPaymentRail;
  settlementModel?: ExecutionIntentSettlementModel;
}

interface QuotePaymentContext {
  intent: ExecutionIntentRecord;
  quoteRequest: HireRequestRecord;
  consoleState: ConsoleStateResponse;
}

interface HirePaymentAuthorization {
  status: "not-required" | "authorized" | "settled";
  activationLane?: boolean;
  rail?: string;
  amountUsd?: string;
  authorizationId?: string;
  ledgerId?: string;
  settlementEvents?: {
    sellerSettlementTxHash?: string;
    protocolFeeTxHash?: string;
    transactionHashes?: string[];
  };
  quoteRequestId?: string;
  executionRequestId?: string;
  acceptedQuoteDigestSha256?: string;
  settlementReference?: string;
  paymentPayloadDigestSha256?: string;
  paymentAuthorizationDigestSha256?: string;
  paymentResponseDigestSha256?: string;
}

interface AgentRuntimeAvailabilityOptions {
  sessionId?: string;
  agentId?: string;
}

interface AgentRuntimeReachabilityState {
  agentId: string;
  sessionId: string;
  openClawUrl: string;
  runtimeDeliveryMode: NonNullable<AgentRuntimeAvailabilityState["runtimeDeliveryMode"]>;
  checkedAtIso: string;
  reachable: boolean;
  status: AgentRuntimeAvailabilityState["status"];
  httpStatus?: number;
  reason?: string;
}

interface AgentRuntimeHeartbeatRecord {
  agentId: string;
  sessionId: string;
  status: AgentRuntimeStatus;
  receivedAtIso: string;
  ttlSeconds: number;
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
    requestId?: string;
    localHireUrl?: string;
    packageVerified?: boolean;
    returnStatus?: string;
    reason?: string;
  };
}

interface AgentRuntimeHeartbeatFile {
  heartbeats: AgentRuntimeHeartbeatRecord[];
}

interface AgentRuntimeHeartbeatOptions extends AgentRuntimeAvailabilityOptions {
  status?: AgentRuntimeStatus;
  ttlSeconds?: number;
  note?: string;
  adminKey?: string;
  relayAgentProtocolVersion?: string;
  relayAgentBuild?: string;
  relayAgentFeatures?: string[];
  relayAgentWorkerRoutes?: Record<string, string>;
  relayAgentWorkerWarnings?: string[];
  relayAgentWorkerTiming?: Record<string, unknown>;
  paidExecutionProbe?: Record<string, unknown>;
}

interface ConsoleStateOptions {
  adminKey?: string;
  sessionId?: string;
  agentId?: string;
  exposeIssuedAdminKey?: string;
  exposeIssuedIngressToken?: string;
  exposeIssuedSigningSecret?: string;
}

interface EventListOptions {
  sessionId?: string;
  turnId?: string;
}

interface ResolvedSessionFocus {
  sessionId: string;
  focusSource: "requested" | "live-flow" | "latest-indexed" | "stored-default";
  knownSessionIds: string[];
  trustModeId: TrustModeId;
}

interface LiveSessionTurnFlowModule {
  executeLiveSessionTurnFlow: (options?: {
    workspaceRoot?: string;
    sessionId?: string;
    turnId?: string;
    witnessPlanPath?: string;
    reportPath?: string;
    runtimeInput?: LiveSessionTurnRuntimeInput;
    resume?: boolean;
    onStep?: (step: NonNullable<LiveSessionTurnFlowReportFile["steps"]>[number]) => Promise<void> | void;
  }) => Promise<LiveSessionTurnFlowReportFile>;
}

interface SponsorQueueFile {
  jobs: SponsorQueueJob[];
}

interface HireRequestRecord {
  requestId: string;
  agentId: string;
  sessionId: string;
  networkId: string;
  submittedAtIso: string;
  requestType: HireRequestReceipt["requestType"];
  pricingMode: HireRequestReceipt["pricingMode"];
  paymentStatus: HireRequestReceipt["paymentStatus"];
  settledAmountUsd?: string;
  status: HireRequestReceipt["status"];
  taskPrompt: string;
  budgetMina?: string;
  requesterContact: string;
  jobAccessTokenHashSha256?: string;
  marketplaceTags?: MarketplaceWorkTags;
  jobPrivacy?: SantaClawzJobPrivacyPreference;
  artifactDelivery?: SantaClawzArtifactDeliveryPreference;
  deliveryTarget: string;
  deliveryStatus?: "forwarded" | "recorded" | "return_rejected";
  deliveryError?: string;
  returnValidationError?: string;
  returnValidationCode?: string;
  localResponseStatusCode?: number;
  localResponseBytes?: number;
  operationalStatus?: HireRequestReceipt["operationalStatus"];
  deliveryReceipt?: HireDeliveryReceipt;
  relayTrace?: HireRelayTraceStep[];
  ingressBodyDigestSha256?: string;
  ingressResponseStatusCode?: number;
  protocolReturn?: HireRequestReceipt["protocolReturn"];
  payment?: HirePaymentAuthorization;
}

interface PaymentLedgerFile {
  entries: PaymentLedgerEntry[];
}

interface PaymentLedgerSettlementInput {
  agentId: string;
  sessionId: string;
  quoteIntentId?: string;
  x402RequestId?: string;
  resource?: string;
  pricingMode: AgentProfileState["paymentProfile"]["pricingMode"];
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
  transactionHashes?: string[];
  facilitatorUrl?: string;
  facilitatorResponseDigestSha256?: string;
  facilitatorResponseSummary?: Record<string, unknown>;
  paymentStatus?: PaymentLedgerStatus;
  errorCode?: string;
  errorMessage?: string;
  settlementRetryable?: boolean;
}

interface PaymentLedgerSettlementReconciliationInput {
  ledgerId: string;
  settlementReference?: string;
  sellerSettlementTxHash?: string;
  protocolFeeTxHash?: string;
  transactionHashes?: string[];
  evidence?: Record<string, unknown>;
}

interface PaymentLedgerListOptions {
  agentId?: string;
  sessionId?: string;
  quoteIntentId?: string;
  hireRequestId?: string;
  paymentPayloadDigestSha256?: string;
  limit?: number;
}

function buildHireOperationalStatus(input: {
  requestType: HireRequestReceipt["requestType"];
  paymentStatus: HireRequestReceipt["paymentStatus"];
  deliveryStatus?: "forwarded" | "recorded" | "return_rejected";
  deliveryFailed?: boolean;
  returnRejected?: boolean;
  hireStatus: HireRequestReceipt["status"];
}): NonNullable<HireRequestReceipt["operationalStatus"]> {
  const paymentStatus =
    input.paymentStatus === "authorized"
      ? "authorized"
      : input.paymentStatus === "settled" || input.paymentStatus === "paid" || input.paymentStatus === "escrowed"
      ? "settled"
      : input.paymentStatus === "quote_requested"
        ? "quote_requested"
        : "free_test";
  return {
    paymentStatus,
    settlementStatus:
      input.requestType === "paid_execution"
        ? input.paymentStatus === "authorized"
          ? "authorized"
          : "settled"
        : input.requestType === "quote_intake"
          ? "not_attempted"
          : "not_required",
    relayDeliveryStatus: input.returnRejected
      ? "return_rejected"
      : input.deliveryFailed
        ? "failed"
        : input.deliveryStatus ?? "not_attempted",
    agentExecutionStatus:
      input.returnRejected
        ? "worker_completed_return_rejected"
        : input.deliveryFailed && input.requestType === "paid_execution" && input.hireStatus === "submitted"
        ? "submitted"
        : input.hireStatus
  };
}

function relayTraceFromError(error: unknown): HireRelayTraceStep[] | undefined {
  const trace = (error as { relayTrace?: unknown })?.relayTrace;
  if (!Array.isArray(trace)) {
    return undefined;
  }
  return trace.filter((entry): entry is HireRelayTraceStep => {
    return Boolean(entry && typeof entry === "object" && typeof entry.step === "string" && typeof entry.status === "string");
  });
}

function mergeHireRelayTrace(input: {
  submittedAtIso: string;
  paymentStatus: HireRequestReceipt["paymentStatus"];
  requestUpdatedAtIso?: string;
  relayTrace?: HireRelayTraceStep[];
  deliveryFailed?: boolean;
  deliveryStatus?: HireRequestReceipt["deliveryStatus"];
  completed?: boolean;
}): HireRelayTraceStep[] {
  const trace: HireRelayTraceStep[] = [
    {
      step: "accepted_by_indexer",
      status: "completed",
      occurredAtIso: input.submittedAtIso
    }
  ];
  if (input.paymentStatus === "authorized" || input.paymentStatus === "settled" || input.paymentStatus === "paid" || input.paymentStatus === "escrowed") {
    trace.push({
      step: "payment_authorized",
      status: "completed",
      occurredAtIso: input.submittedAtIso
    });
  }
  trace.push(...(input.relayTrace ?? []));
  if (!trace.some((entry) => entry.step === "sent_to_relay")) {
    trace.push({
      step: "sent_to_relay",
      status: input.deliveryFailed ? "failed" : input.deliveryStatus ? "completed" : "not_reached",
      occurredAtIso: input.requestUpdatedAtIso ?? input.submittedAtIso
    });
  }
  if (!trace.some((entry) => entry.step === "worker_ack")) {
    trace.push({
      step: "worker_ack",
      status: input.deliveryFailed ? "not_reached" : input.deliveryStatus ? "completed" : "not_reached"
    });
  }
  if (!trace.some((entry) => entry.step === "worker_completed")) {
    trace.push({
      step: "worker_completed",
      status: input.completed ? "completed" : input.deliveryFailed ? "not_reached" : "not_reached"
    });
  }
  if (!trace.some((entry) => entry.step === "relay_returned")) {
    trace.push({
      step: "relay_returned",
      status: input.deliveryFailed ? "failed" : input.deliveryStatus ? "completed" : "not_reached",
      occurredAtIso: input.requestUpdatedAtIso ?? input.submittedAtIso
    });
  }
  trace.push({
    step: "state_updated",
    status: "completed",
    occurredAtIso: input.requestUpdatedAtIso ?? new Date().toISOString()
  });
  return trace;
}

interface HireRequestFile {
  requests: HireRequestRecord[];
  jobActivityStatsBySessionId?: Record<string, AgentJobActivityStats>;
}

type JobStageStatus = "pending" | "active" | "blocked" | "completed" | "accepted" | "revision_requested";
type JobStageKind =
  | "procurement"
  | "intake"
  | "quote"
  | "accepted"
  | "in_progress"
  | "draft"
  | "delivery"
  | "review"
  | "final"
  | "closed";
type JobMessageAuthorRole = "buyer" | "seller" | "system";

interface JobStageRecord {
  stageId: string;
  requestId: string;
  agentId: string;
  sessionId: string;
  stage: JobStageKind;
  status: JobStageStatus;
  label: string;
  note?: string;
  artifactDigestSha256?: string;
  createdAtIso: string;
  updatedAtIso: string;
  authorRole: JobMessageAuthorRole;
}

interface JobMessageRecord {
  messageId: string;
  requestId: string;
  agentId: string;
  sessionId: string;
  authorRole: JobMessageAuthorRole;
  body: string;
  createdAtIso: string;
  messageDigestSha256: string;
  stage?: JobStageKind;
  artifactDigestSha256?: string;
}

interface JobCollaborationFile {
  stages: JobStageRecord[];
  messages: JobMessageRecord[];
}

interface JobWorkspaceInput {
  requestId: string;
  token: string;
}

interface JobMessagePostOptions {
  requestId: string;
  token?: string;
  adminKey?: string;
  authorRole?: JobMessageAuthorRole;
  body: string;
  stage?: string;
  artifactDigestSha256?: string;
}

interface JobStagePostOptions {
  requestId: string;
  token?: string;
  adminKey?: string;
  authorRole?: JobMessageAuthorRole;
  stage: string;
  status: string;
  label?: string;
  note?: string;
  artifactDigestSha256?: string;
}

interface ExecutionIntentFile {
  intents: ExecutionIntentRecord[];
}

export interface CreateExecutionIntentOptions {
  sessionId?: string;
  agentId?: string;
  requestId?: string;
  rail?: AgentPaymentRail;
  settlementModel?: ExecutionIntentSettlementModel;
  paymentStatus?: ExecutionIntentRecord["paymentStatus"];
  grossAmountUsd: string;
  sellerNetAmountUsd?: string;
  protocolFeeAmountUsd?: string;
  protocolFeeRecipient?: string;
  buyerWallet?: string;
  sellerWallet?: string;
  escrowContract?: string;
  paymentAuthorizationDigestSha256?: string;
  note?: string;
}

export interface ExecutionIntentTransitionOptions {
  intentId: string;
  reference?: string;
  evidenceDigestSha256?: string;
  note?: string;
}

interface ExecutionIntentListOptions {
  sessionId?: string;
  agentId?: string;
  status?: ExecutionIntentStatus;
  limit?: number;
}

type ProcurementIntentStatus = "open" | "awarded" | "closed" | "cancelled";
type ProcurementBidStatus = "submitted" | "accepted" | "rejected";

interface ProcurementBidRecord {
  bidId: string;
  agentId: string;
  sessionId: string;
  idempotencyKeyHashSha256?: string;
  amountUsd: string;
  pricingMode: AgentProfileState["paymentProfile"]["pricingMode"];
  summary: string;
  estimatedDeliveryIso?: string;
  deliveryModes: string[];
  privacyModes: string[];
  createdAtIso: string;
  updatedAtIso: string;
  status: ProcurementBidStatus;
}

interface ProcurementDeclineRecord {
  agentId: string;
  sessionId: string;
  idempotencyKeyHashSha256?: string;
  reason?: string;
  createdAtIso: string;
}

interface ProcurementIntentRecord {
  schemaVersion: "santaclawz-procurement-intent/1.0";
  intentId: string;
  status: ProcurementIntentStatus;
  taskPrompt: string;
  requesterContact: string;
  budgetUsd?: string;
  deadlineIso?: string;
  bidWindowClosesAtIso?: string;
  requiredCapabilities: string[];
  preferredDeliveryModes: string[];
  preferredPrivacyModes: string[];
  marketplaceTags?: MarketplaceWorkTags;
  jobPrivacy?: SantaClawzJobPrivacyPreference;
  artifactDelivery?: SantaClawzArtifactDeliveryPreference;
  createdAtIso: string;
  updatedAtIso: string;
  buyerTokenHashSha256: string;
  createIdempotencyKeyHashSha256?: string;
  bids: ProcurementBidRecord[];
  declines: ProcurementDeclineRecord[];
  selectedBidId?: string;
  selectedAgentId?: string;
  award?: {
    awardedAtIso: string;
    publicHireUrl: string;
    hireApiPath: string;
    suggestedHireBody: {
      taskPrompt: string;
      requesterContact: string;
      jobPrivacy?: SantaClawzJobPrivacyPreference;
      artifactDelivery?: SantaClawzArtifactDeliveryPreference;
    };
  };
}

interface ProcurementIntentFile {
  intents: ProcurementIntentRecord[];
}

export interface CreateProcurementIntentOptions {
  taskPrompt: string;
  requesterContact: string;
  idempotencyKey?: string;
  budgetUsd?: string;
  deadlineIso?: string;
  bidWindowClosesAtIso?: string;
  requiredCapabilities?: string[];
  preferredDeliveryModes?: string[];
  preferredPrivacyModes?: string[];
  marketplaceTags?: Partial<MarketplaceWorkTags>;
  jobPrivacy?: SantaClawzJobPrivacyPreference;
  artifactDelivery?: SantaClawzArtifactDeliveryPreference;
}

export type BuyerRouterMode = JobPackBuyerRouterMode;

export interface CreateBuyerRouterPlanOptions {
  taskPrompt: string;
  buyerMode?: "human" | "agent";
  requesterContact?: string;
  budgetUsd?: string;
  privacyLane?: "private" | "proof-only" | "public-summary";
  marketplaceTags?: Partial<MarketplaceWorkTags>;
  selectedAgentId?: string;
}

export interface SubmitProcurementBidOptions {
  intentId: string;
  agentId: string;
  adminKey?: string;
  idempotencyKey?: string;
  amountUsd: string;
  summary: string;
  estimatedDeliveryIso?: string;
  deliveryModes?: string[];
  privacyModes?: string[];
}

export interface DeclineProcurementIntentOptions {
  intentId: string;
  agentId: string;
  adminKey?: string;
  idempotencyKey?: string;
  reason?: string;
}

export interface AcceptProcurementBidOptions {
  intentId: string;
  bidId: string;
  token?: string;
}

function isLiveFlowKind(value: string): value is LiveFlowKind {
  return value in LIVE_FLOW_METHODS;
}

function isTrustModeId(value: string): value is TrustModeId {
  return TRUST_MODE_PRESETS.some((mode) => mode.id === value);
}

function findWorkspaceRoot(startDir: string): string {
  let current = startDir;

  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return startDir;
    }
    current = parent;
  }
}

function toNanomina(value: string): bigint {
  const [whole = "0", fractional = ""] = value.split(".");
  return BigInt(whole) * 1_000_000_000n + BigInt((fractional + "000000000").slice(0, 9));
}

function fromNanomina(value: bigint): string {
  const whole = value / 1_000_000_000n;
  const fractional = `${value % 1_000_000_000n}`.padStart(9, "0").replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole.toString();
}

function addMina(left: string, right: string): string {
  return fromNanomina(toNanomina(left) + toNanomina(right));
}

function subtractMina(left: string, right: string): string {
  const result = toNanomina(left) - toNanomina(right);
  return fromNanomina(result >= 0n ? result : 0n);
}

function plusHours(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 60 * 60 * 1000).toISOString();
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface MutableLiveFlowTurnTarget extends LiveFlowTurnTarget {
  finalized: boolean;
  aborted: boolean;
  leased: boolean;
  started: boolean;
}

function buildWalletState(nowIso: string): ShadowWalletState {
  return {
    walletId: "shadow_wallet_acme_primary",
    publicKey: "B62qshadowwallet000000000000000000000000000000000000000000000000",
    deviceStatus: "device-bound",
    sponsorStatus: "active",
    sponsoredBudgetMina: "0.50",
    sponsoredRemainingMina: "0.50",
    trustModeId: "private",
    guardians: [
      {
        guardianId: "guardian_security",
        label: "Security Lead",
        role: "security",
        status: "active"
      },
      {
        guardianId: "guardian_legal",
        label: "Legal Counsel",
        role: "legal",
        status: "active"
      },
      {
        guardianId: "guardian_compliance",
        label: "Compliance Reviewer",
        role: "compliance",
        status: "active"
      }
    ],
    recovery: {
      status: "not-prepared",
      guardiansRequired: 2,
      lastRotationAtIso: nowIso
    },
    governancePolicy: {
      requiredApprovals: 2,
      reviewAudience: "Security + Compliance",
      autoExpiryHours: 24
    }
  };
}

function buildPrivacyApproval(actorId: PrivacyApprovalRecord["actorId"], actorRole: PrivacyApprovalRecord["actorRole"], note: string, approvedAtIso: string): PrivacyApprovalRecord {
  return {
    actorId,
    actorRole,
    note,
    approvedAtIso
  };
}

function buildPrivacyExceptions(nowIso: string): PrivacyExceptionQueueItem[] {
  return [
    {
      id: "privacy_exception_001",
      sessionId: DEFAULT_SESSION_ID,
      turnId: DEFAULT_TURN_ID,
      title: "Reveal one operator-blind artifact for incident review",
      audience: "Compliance reviewer",
      duration: "24h",
      scope: "One screenshot and one tool receipt",
      reason: "Investigate anomalous outbound host access without opening the full transcript.",
      severity: "high",
      status: "approved",
      requiredApprovals: 2,
      approvals: [
        buildPrivacyApproval("guardian_security", "workspace-member", "Security approved limited disclosure.", nowIso),
        buildPrivacyApproval("guardian_compliance", "compliance-reviewer", "Compliance approved 24h review window.", nowIso)
      ],
      expiresAtIso: plusHours(nowIso, 24)
    },
    {
      id: "privacy_exception_002",
      sessionId: DEFAULT_SESSION_ID,
      turnId: DEFAULT_TURN_ID,
      title: "Allow redacted remote provider fallback",
      audience: "Approved remote model",
      duration: "This turn only",
      scope: "Redacted prompt fields and citation digests",
      reason: "Local sealed provider is saturated and the task can safely route in digest mode.",
      severity: "medium",
      status: "pending",
      requiredApprovals: 2,
      approvals: [buildPrivacyApproval("guardian_security", "workspace-member", "Safe only if payload remains redacted.", nowIso)],
      expiresAtIso: plusHours(nowIso, 4)
    }
  ];
}

function buildDefaultState(nowIso: string): ConsolePersistenceState {
  return {
    schemaVersion: 6,
    currentSessionId: DEFAULT_SESSION_ID,
    activeMode: "private",
    wallet: buildWalletState(nowIso),
    privacyExceptions: buildPrivacyExceptions(nowIso),
    agentIdsBySession: {
      [DEFAULT_SESSION_ID]: buildStableAgentId("SantaClawz Operator", DEFAULT_SESSION_ID)
    },
    profilesBySession: {
      [DEFAULT_SESSION_ID]: buildDefaultProfile("private")
    },
    adminKeysBySession: {},
    ingressSecretsBySession: {},
    ownershipBySession: {
      [DEFAULT_SESSION_ID]: buildDefaultOwnershipRecord(true)
    },
    publishedSessionsBySession: {},
    deletedAgentRegistrationsBySession: {},
    enrollmentTicketsById: {}
  };
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "agent";
}

function buildStableAgentId(agentName: string, sessionId: string): string {
  return `${slugify(agentName)}--${sessionId}`;
}

function normalizeUrlReservationSalt(value: string | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[a-f0-9]{12}$/.test(normalized) ? normalized : undefined;
}

function serviceKeySlug(value: string): string {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "agent";
}

function normalizeRuntimeDelivery(input: Partial<AgentProfileState["runtimeDelivery"]> | undefined, fallback?: AgentProfileState["runtimeDelivery"]): AgentProfileState["runtimeDelivery"] {
  const rawMode = input?.mode ?? fallback?.mode ?? "santaclawz-relay";
  const mode: RuntimeDeliveryMode = rawMode === "self-hosted" ? "self-hosted" : "santaclawz-relay";
  const runtimeIngressUrl =
    typeof input?.runtimeIngressUrl === "string" && input.runtimeIngressUrl.trim().length > 0
      ? input.runtimeIngressUrl.trim().slice(0, 280)
      : typeof fallback?.runtimeIngressUrl === "string" && fallback.runtimeIngressUrl.trim().length > 0
        ? fallback.runtimeIngressUrl.trim().slice(0, 280)
        : undefined;
  const runtimeRoutes = {
    ...(typeof input?.runtimeRoutes?.quote_intake === "string" && input.runtimeRoutes.quote_intake.trim().length > 0
      ? { quote_intake: input.runtimeRoutes.quote_intake.trim().slice(0, 280) }
      : typeof fallback?.runtimeRoutes?.quote_intake === "string" && fallback.runtimeRoutes.quote_intake.trim().length > 0
        ? { quote_intake: fallback.runtimeRoutes.quote_intake.trim().slice(0, 280) }
        : {}),
    ...(typeof input?.runtimeRoutes?.paid_execution === "string" && input.runtimeRoutes.paid_execution.trim().length > 0
      ? { paid_execution: input.runtimeRoutes.paid_execution.trim().slice(0, 280) }
      : typeof fallback?.runtimeRoutes?.paid_execution === "string" && fallback.runtimeRoutes.paid_execution.trim().length > 0
        ? { paid_execution: fallback.runtimeRoutes.paid_execution.trim().slice(0, 280) }
        : {})
  };

  return {
    mode,
    ...(mode === "self-hosted" && runtimeIngressUrl ? { runtimeIngressUrl } : {}),
    ...(Object.keys(runtimeRoutes).length > 0 ? { runtimeRoutes } : {})
  };
}

function isRelayDeliveryProfile(profile: Pick<AgentProfileState, "runtimeDelivery">) {
  return profile.runtimeDelivery.mode === "santaclawz-relay";
}

function relayDeliveryTargetForAgent(agentId: string) {
  return `santaclawz-relay://agent/${encodeURIComponent(agentId)}`;
}

function serviceKeyForAgent(profile: Pick<AgentProfileState, "agentName" | "openClawUrl" | "runtimeDelivery">, agentId: string): string {
  if (isRelayDeliveryProfile(profile)) {
    return serviceKeySlug(profile.agentName || agentId.split("--")[0] || agentId);
  }

  try {
    const url = new URL(profile.openClawUrl);
    const pathSegments = url.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    const servicePathSegment = pathSegments.at(-1) === "hire" ? pathSegments.at(-2) : pathSegments.at(-1);
    if (servicePathSegment) {
      return serviceKeySlug(servicePathSegment);
    }
  } catch {
    // Fall back to the public profile name when the URL is not parseable yet.
  }

  return serviceKeySlug(profile.agentName || agentId.split("--")[0] || agentId);
}

function enrolledServiceKeyForAgent(
  ingressRecord: SessionIngressSecretRecord | undefined,
  profile: Pick<AgentProfileState, "agentName" | "openClawUrl" | "runtimeDelivery">,
  agentId: string
): string {
  return ingressRecord?.serviceKey ?? serviceKeyForAgent(profile, agentId);
}

function buildAdminKey() {
  return `sck_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function buildIngressToken() {
  return `sc_ing_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function buildIngressSigningSecret() {
  return `sc_sig_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function buildEnrollmentTicketId() {
  return `enr_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function buildEnrollmentTicketSecret() {
  return `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
}

function buildEnrollmentTicketToken(ticketId: string, secret: string) {
  return `scz_enroll_${ticketId}_${secret}`;
}

function parseEnrollmentTicketToken(ticket: string) {
  const normalized = ticket.trim();
  const match = /^scz_enroll_(enr_[a-f0-9]{20})_([a-f0-9]{64})$/i.exec(normalized);
  if (!match) {
    throw new Error("Enrollment ticket is malformed.");
  }
  return {
    ticket: normalized,
    ticketId: match[1]!,
    secret: match[2]!
  };
}

function adminKeyHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function adminKeyHint(value: string) {
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function ingressTokenHint(value: string) {
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function timingSafeEqualHex(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function looksLikeEvmAddress(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

function looksLikeZekoAddress(value: string) {
  return /^B62[a-zA-Z0-9]{20,}$/.test(value.trim());
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".local") ||
    normalized.startsWith("10.") ||
    normalized.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)
  );
}

function isPlaceholderHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "example.com" ||
    normalized === "example.org" ||
    normalized === "example.net" ||
    normalized.endsWith(".example.com") ||
    normalized.endsWith(".example.org") ||
    normalized.endsWith(".example.net") ||
    normalized.includes("your-openclaw-agent") ||
    normalized.includes("your-agent-domain")
  );
}

function normalizeComparableUrl(rawUrl: string) {
  const parsed = new URL(rawUrl);
  const protocol = parsed.protocol.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  const port =
    (protocol === "https:" && parsed.port === "443") || (protocol === "http:" && parsed.port === "80")
      ? ""
      : parsed.port;
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return `${protocol}//${hostname}${port ? `:${port}` : ""}${pathname}${parsed.search}`;
}

function normalizeHostedServiceBaseUrl(rawUrl: string, label: string) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (_error) {
    throw new Error(`${label} must be a valid URL.`);
  }

  const isProductionValidation = process.env.NODE_ENV === "production";
  const usesSecureProtocol = parsed.protocol === "https:";
  const isLocalHttp = parsed.protocol === "http:" && isPrivateHostname(parsed.hostname) && !isProductionValidation;

  if (!usesSecureProtocol && !isLocalHttp) {
    throw new Error(`${label} must use https in public deployments.`);
  }
  if (isProductionValidation && isPrivateHostname(parsed.hostname)) {
    throw new Error(`${label} must be publicly reachable.`);
  }
  if (isPlaceholderHostname(parsed.hostname)) {
    throw new Error(`${label} still looks like placeholder copy.`);
  }

  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname === "/" ? "" : pathname}`;
}

function shouldCheckAgentRuntimeReachability() {
  if (process.env.CLAWZ_VALIDATE_AGENT_URLS === "false") {
    return false;
  }
  return process.env.NODE_ENV === "production" || process.env.CLAWZ_VALIDATE_AGENT_URLS === "true";
}

function hostedServiceUrlFor(baseUrl: string, relativePath: string) {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedPath = relativePath.replace(/^\/+/, "");
  return new URL(normalizedPath, normalizedBase).toString();
}

function publicSiteBase() {
  return (process.env.CLAWZ_SITE_BASE?.trim() || "https://santaclawz.ai").replace(/\/+$/, "");
}

function publicAgentUrlFor(agentId: string) {
  return `${publicSiteBase()}/agent/${encodeURIComponent(agentId)}`;
}

function publicAgentHireUrlFor(agentId: string) {
  return `${publicAgentUrlFor(agentId)}/hire`;
}

async function fetchJsonWithTimeout<T>(url: string, label: string, timeoutMs = 8000): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json,text/plain,*/*"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "network request failed";
    throw new Error(`${label} could not be reached (${message}).`);
  }

  if (!response.ok) {
    throw new Error(`${label} returned ${response.status}.`);
  }

  try {
    return (await response.json()) as T;
  } catch (_error) {
    throw new Error(`${label} did not return valid JSON.`);
  }
}

function buildDefaultProfile(trustModeId: TrustModeId): AgentProfileState {
  const trustMode = TRUST_MODE_PRESETS.find((mode) => mode.id === trustModeId) ?? TRUST_MODE_PRESETS[0]!;
  return {
    agentName: "SantaClawz Operator",
    representedPrincipal: "",
    headline: "Private, verifiable agent work on Zeko.",
    openClawUrl: "",
    runtimeDelivery: {
      mode: "santaclawz-relay"
    },
    availability: "active",
    payoutWallets: {},
    missionAuthOverlay: {
      enabled: false,
      status: "disabled",
      scopeHints: []
    },
    paymentProfile: {
      enabled: false,
      supportedRails: ["base-usdc"],
      defaultRail: "base-usdc",
      pricingMode: "quote-required",
      referencePriceUnit: "minimum",
      settlementTrigger: "upfront"
    },
    marketplaceTags: emptyAgentMarketplaceTags(),
    socialAnchorPolicy: {
      mode: "shared-batched"
    },
    preferredProvingLocation: trustMode.defaultProvingLocation
  };
}

function emptyAgentMarketplaceTags(): AgentMarketplaceTags {
  return {
    capabilities: [],
    domains: [],
    inputTypes: [],
    outputTypes: [],
    tools: [],
    runtimes: []
  };
}

function buildDefaultOwnershipRecord(legacyRegistration: boolean): SessionOwnershipRecord {
  return {
    status: legacyRegistration ? "legacy-unverified" : "unverified",
    legacyRegistration,
    canReclaim: legacyRegistration
  };
}

function asPublicOwnershipState(record: SessionOwnershipRecord, openClawUrl: string): AgentOwnershipState {
  const activeChallenge =
    record.challenge && Date.parse(record.challenge.expiresAtIso) > Date.now()
      ? {
          challengeId: record.challenge.challengeId,
          challengePath: record.challenge.challengePath,
          challengeUrl: record.challenge.challengeUrl,
          verificationMethod: record.challenge.verificationMethod,
          issuedAtIso: record.challenge.issuedAtIso,
          expiresAtIso: record.challenge.expiresAtIso
        }
      : undefined;

  return {
    status:
      record.status === "challenge-issued" && !activeChallenge
        ? record.legacyRegistration
          ? "legacy-unverified"
          : "unverified"
        : record.status,
    legacyRegistration: record.legacyRegistration,
    canReclaim: record.canReclaim,
    ...(activeChallenge ? { challenge: activeChallenge } : {}),
    ...(record.verification ? { verification: record.verification } : {})
  };
}

function ownershipChallengeUrlFor(openClawUrl: string) {
  return new URL(PUBLICCLAWZ_OWNERSHIP_CHALLENGE_PATH, openClawUrl).toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function assertStringValue(record: Record<string, unknown>, key: string, context: string): string {
  const value = stringValue(record, key);
  if (!value) {
    throw new Error(`${context} must include ${key}.`);
  }
  return value;
}

function assertUsdAmount(value: string, context: string) {
  if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(value)) {
    throw new Error(`${context} must be a decimal USD amount string.`);
  }
}

function usdAmountAtomic(value: string): bigint {
  assertUsdAmount(value, "USD amount");
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function assertSha256Hex(value: string, context: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${context} must be a lowercase sha256 hex digest.`);
  }
}

function isTransactionHash(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^0x[a-fA-F0-9]{64}$/.test(value) &&
    value.toLowerCase() !== `0x${"0".repeat(64)}`
  );
}

function uniqueTransactionHashes(...groups: Array<readonly string[] | undefined>): string[] {
  const hashes = new Set<string>();
  for (const group of groups) {
    for (const hash of group ?? []) {
      if (isTransactionHash(hash)) {
        hashes.add(hash);
      }
    }
  }
  return [...hashes];
}

function inferPaymentLedgerSettlementStatus(input: {
  paymentStatus?: PaymentLedgerStatus;
  sellerSettlementTxHash?: string;
  protocolFeeTxHash?: string;
  transactionHashes?: string[];
}): PaymentLedgerStatus {
  if (input.paymentStatus) {
    return input.paymentStatus;
  }
  if (input.sellerSettlementTxHash && input.protocolFeeTxHash) {
    return "settled";
  }
  if (input.sellerSettlementTxHash) {
    return "seller_settled";
  }
  if (input.protocolFeeTxHash) {
    return "protocol_fee_settled";
  }
  if ((input.transactionHashes ?? []).length > 0) {
    return "settled";
  }
  return "payment_verified";
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    const maybeCode = error as { code?: string };
    if (maybeCode.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown) {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
}

function buildDefaultSponsorQueue(): SponsorQueueFile {
  return {
    jobs: []
  };
}

function buildDefaultHireRequestFile(): HireRequestFile {
  return {
    requests: [],
    jobActivityStatsBySessionId: {}
  };
}

function buildDefaultJobCollaborationFile(): JobCollaborationFile {
  return {
    stages: [],
    messages: []
  };
}

function buildDefaultPaymentLedgerFile(): PaymentLedgerFile {
  return {
    entries: []
  };
}

function buildDefaultExecutionIntentFile(): ExecutionIntentFile {
  return {
    intents: []
  };
}

function buildDefaultProcurementIntentFile(): ProcurementIntentFile {
  return {
    intents: []
  };
}

function buildDefaultSocialAnchorQueueFile(): SocialAnchorQueueFile {
  return {
    items: [],
    batches: []
  };
}

function buildDefaultAgentBoardFile(): AgentBoardFile {
  return {
    messages: []
  };
}

function isSocialAnchorCandidateStatus(value: unknown): value is SocialAnchorCandidate["status"] {
  return (
    value === "pending" ||
    value === "submitted" ||
    value === "retrying" ||
    value === "confirmed" ||
    value === "failed" ||
    value === "expired_not_anchored" ||
    value === "aggregate_anchored" ||
    value === "not_proof_requested"
  );
}

function activeSocialAnchorStatus(status: SocialAnchorCandidate["status"]) {
  return status === "pending" || status === "submitted" || status === "retrying";
}

function retainSocialAnchorItems(items: SocialAnchorCandidate[]) {
  const sorted = [...items].sort((left, right) => right.occurredAtIso.localeCompare(left.occurredAtIso));
  const active = sorted.filter((item) => activeSocialAnchorStatus(item.status));
  const terminal = sorted.filter((item) => !activeSocialAnchorStatus(item.status)).slice(0, 2000);
  return [...active, ...terminal];
}

function integerEnv(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : fallback;
}

function parseBoundedIntegerEnv(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function sanitizeAgentBoardProofIntent(value: unknown): AgentBoardProofIntent {
  if (value === "aggregate") {
    return "aggregate";
  }
  if (value === "agent_chatter" || value === "display_only") {
    return "agent_chatter";
  }
  return "per_message";
}

const AGENT_BOARD_PER_MESSAGE_PROOF_WINDOW_MS = 60_000;
const AGENT_BOARD_PER_AGENT_PROOF_BUDGET = integerEnv("CLAWZ_AGENT_BOARD_PER_AGENT_PROOF_BUDGET", 20);
const AGENT_BOARD_PER_SWARM_PROOF_BUDGET = integerEnv("CLAWZ_AGENT_BOARD_PER_SWARM_PROOF_BUDGET", 8);
const AGENT_BOARD_PROOF_QUEUE_SOFT_LIMIT = integerEnv("CLAWZ_AGENT_BOARD_PROOF_QUEUE_SOFT_LIMIT", 450);

function resolveAgentBoardProofAdmission(input: {
  requestedProofIntent: AgentBoardProofIntent;
  agentId: string;
  messageType: AgentBoardMessageType;
  swarmId?: string;
  outputDigestSha256?: string;
  createdAtIso: string;
  board: AgentBoardFile;
  queue: SocialAnchorQueueFile;
}): {
  proofIntent: AgentBoardProofIntent;
  proofAdmissionReason: AgentBoardProofAdmissionReason;
} {
  if (input.requestedProofIntent !== "per_message") {
    return {
      proofIntent: input.requestedProofIntent,
      proofAdmissionReason: "requested"
    };
  }

  const importantMessage = input.messageType === "output" || Boolean(input.outputDigestSha256);
  if (importantMessage) {
    return {
      proofIntent: "per_message",
      proofAdmissionReason: "requested"
    };
  }

  const activeQueueDepth = input.queue.items.filter((item) => activeSocialAnchorStatus(item.status)).length;
  if (activeQueueDepth >= AGENT_BOARD_PROOF_QUEUE_SOFT_LIMIT) {
    return {
      proofIntent: "aggregate",
      proofAdmissionReason: "queue_pressure"
    };
  }

  const cutoffMs = Date.parse(input.createdAtIso) - AGENT_BOARD_PER_MESSAGE_PROOF_WINDOW_MS;
  const recentPerMessagePosts = input.board.messages.filter((message) => {
    if (message.agentId !== input.agentId || message.proofIntent !== "per_message") {
      return false;
    }
    return Date.parse(message.createdAtIso) >= cutoffMs;
  });
  if (recentPerMessagePosts.length >= AGENT_BOARD_PER_AGENT_PROOF_BUDGET) {
    return {
      proofIntent: "aggregate",
      proofAdmissionReason: "agent_proof_budget_exceeded"
    };
  }

  if (input.swarmId) {
    const recentSwarmPosts = recentPerMessagePosts.filter((message) => message.swarmId === input.swarmId);
    if (recentSwarmPosts.length >= AGENT_BOARD_PER_SWARM_PROOF_BUDGET) {
      return {
        proofIntent: "aggregate",
        proofAdmissionReason: "swarm_proof_budget_exceeded"
      };
    }
  }

  return {
    proofIntent: "per_message",
    proofAdmissionReason: "requested"
  };
}

function isSocialAnchorBatchStatus(value: unknown): value is SocialAnchorBatch["status"] {
  return value === "submitted" || value === "retrying" || value === "confirmed" || value === "failed";
}

function normalizeSocialAnchorCandidate(item: SocialAnchorCandidate): SocialAnchorCandidate {
  const legacyStatus = (item.status as string | undefined) === "anchored" ? "confirmed" : item.status;
  const status = isSocialAnchorCandidateStatus(legacyStatus) ? legacyStatus : "pending";
  return {
    ...item,
    status,
    ...(status === "confirmed" && item.anchoredAtIso && !item.confirmedAtIso ? { confirmedAtIso: item.anchoredAtIso } : {})
  };
}

function normalizeSocialAnchorBatch(batch: SocialAnchorBatch): SocialAnchorBatch {
  const legacyStatus = (batch.status as string | undefined) === "anchored" ? "confirmed" : batch.status;
  const status = isSocialAnchorBatchStatus(legacyStatus) ? legacyStatus : "confirmed";
  const settledAtIso = batch.settledAtIso ?? batch.confirmedAtIso ?? batch.submittedAtIso ?? batch.createdAtIso;
  return {
    ...batch,
    status,
    settledAtIso,
    submittedAtIso: batch.submittedAtIso ?? batch.createdAtIso ?? settledAtIso,
    ...(status === "confirmed" && !batch.confirmedAtIso ? { confirmedAtIso: settledAtIso } : {})
  };
}

function socialAnchorStatusCounts(items: SocialAnchorCandidate[]) {
  return {
    pendingCount: items.filter((item) => item.status === "pending").length,
    submittedCount: items.filter((item) => item.status === "submitted").length,
    retryingCount: items.filter((item) => item.status === "retrying").length,
    confirmedCount: items.filter((item) => item.status === "confirmed").length,
    failedCount: items.filter((item) => item.status === "failed").length
  };
}

function executionIntentStatusCounts(intents: ExecutionIntentRecord[]) {
  return {
    pendingCount: intents.filter((intent) => intent.status === "pending").length,
    approvedCount: intents.filter((intent) => intent.status === "approved").length,
    executedCount: intents.filter((intent) => intent.status === "executed").length,
    settledCount: intents.filter((intent) => intent.status === "settled").length,
    refundedCount: intents.filter((intent) => intent.status === "refunded").length
  };
}

function hasActiveSocialAnchorBatch(queue: SocialAnchorQueueFile): boolean {
  return queue.batches.some((batch) => batch.status === "submitted" || batch.status === "retrying");
}

function isSocialAnchorBatchRetryDue(batch: SocialAnchorBatch, nowMs = Date.now()): boolean {
  if (!batch.nextRetryAtIso) {
    return true;
  }
  const retryAtMs = Date.parse(batch.nextRetryAtIso);
  return Number.isNaN(retryAtMs) || retryAtMs <= nowMs;
}

function socialAnchorErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Unknown social anchor error");
}

function buildDefaultRuntimeHeartbeatFile(): AgentRuntimeHeartbeatFile {
  return {
    heartbeats: []
  };
}

function titleForSocialAnchorKind(kind: SocialAnchorCandidateKind) {
  switch (kind) {
    case "agent-registered":
      return "Agent registered";
    case "marketplace-tags-declared":
      return "Marketplace tags declared";
    case "ownership-verified":
      return "Ownership verified";
    case "agent-published":
      return "Published on Zeko";
    case "payment-terms-live":
      return "Payment terms live";
    case "hire-request-submitted":
      return "Hire request received";
    case "quote-returned":
      return "Quote returned";
    case "quote-accepted":
      return "Quote accepted";
    case "paid-execution-completed":
      return "Paid execution completed";
    case "free-test-completed":
      return "Free test completed";
    case "hire-request-failed":
      return "Hire request failed";
    case "execution-intent-created":
      return "Execution intent created";
    case "execution-intent-approved":
      return "Execution intent approved";
    case "execution-intent-executed":
      return "Execution intent executed";
    case "execution-intent-settled":
      return "Execution intent settled";
    case "execution-intent-refunded":
      return "Execution intent refunded";
    case "marketplace-tag-reputation-updated":
      return "Tag reputation updated";
    case "agent-message-posted":
      return "Public agent message posted";
    case "operator-dispatch":
      return "Operator dispatch updated";
  }
}

function isMainnetNetwork(deployment: Pick<ZekoDeploymentState, "networkId" | "mode">): boolean {
  const networkId = deployment.networkId.toLowerCase();
  if (deployment.mode === "local-runtime" || deployment.mode === "planned-testnet" || deployment.mode === "testnet-live") {
    return false;
  }
  return networkId.includes("mainnet") && !networkId.includes("testnet");
}

function networkIdLooksMainnet(deployment: Pick<ZekoDeploymentState, "networkId">): boolean {
  const networkId = (process.env.CLAWZ_NETWORK_ID ?? process.env.ZEKO_NETWORK_ID ?? deployment.networkId).toLowerCase();
  return networkId.includes("mainnet") && !networkId.includes("testnet");
}

function normalizePublicModerationText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function blockedPublicTerms(): string[] {
  return Array.from(
    new Set(
      (process.env[BLOCKED_PUBLIC_TERMS_ENV] ?? "")
        .split(",")
        .map((term) => normalizePublicModerationText(term))
        .filter((term) => term.length > 0)
    )
  );
}

function findBlockedPublicTerm(values: Array<string | undefined>): string | undefined {
  const terms = blockedPublicTerms();
  if (terms.length === 0) {
    return undefined;
  }

  const haystack = normalizePublicModerationText(values.filter(Boolean).join(" "));
  if (!haystack) {
    return undefined;
  }
  const paddedHaystack = ` ${haystack} `;
  return terms.find((term) => paddedHaystack.includes(` ${term} `));
}

function hasBlockedPublicTerm(values: Array<string | undefined>): boolean {
  return Boolean(findBlockedPublicTerm(values));
}

function assertNoBlockedPublicTerms(label: string, values: Array<string | undefined>) {
  const term = findBlockedPublicTerm(values);
  if (term) {
    throw new Error(`${label} contains a blocked public term. Choose safer public wording before publishing to SantaClawz.`);
  }
}

function envFlagEnabled(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function allowTestnetSelfServeSocialAnchor(): boolean {
  return envFlagEnabled("CLAWZ_ALLOW_TESTNET_SELF_SERVE_SOCIAL_ANCHOR");
}

function requireQuoteBuyerWalletProof(): boolean {
  return envFlagEnabled("CLAWZ_REQUIRE_QUOTE_BUYER_WALLET_PROOF");
}

function isPrivateHireRequest(request: Pick<HireRequestRecord, "jobPrivacy">) {
  return request.jobPrivacy?.visibility === "private";
}

function shouldPublishDetailedHireLifecycle(jobPrivacy?: SantaClawzJobPrivacyPreference) {
  return jobPrivacy?.visibility !== "private";
}

function toSnakeJobPrivacy(jobPrivacy: SantaClawzJobPrivacyPreference) {
  return {
    visibility: jobPrivacy.visibility,
    public_aggregate_stats: true,
    public_lifecycle_events: jobPrivacy.publicLifecycleEvents ?? jobPrivacy.visibility === "public",
    public_artifact_metadata: jobPrivacy.publicArtifactMetadata ?? jobPrivacy.visibility === "public",
    ...(jobPrivacy.note ? { note: jobPrivacy.note } : {})
  };
}

function lastHireStatusForSession(
  hireRequests: HireRequestFile,
  sessionId: string,
  options: { includePrivate?: boolean } = {}
): AgentReadinessState["lastJobStatus"] {
  const latest = hireRequests.requests
    .filter((request) => request.sessionId === sessionId && (options.includePrivate !== false || !isPrivateHireRequest(request)))
    .sort((left, right) => right.submittedAtIso.localeCompare(left.submittedAtIso))[0];
  return latest?.status ?? "none";
}

function paidExecutionTerminalOutcome(request: HireRequestRecord, nowMs = Date.now()): "completed" | "failed" | "pending" {
  if (request.requestType !== "paid_execution") {
    return "pending";
  }
  if (request.status === "completed" && request.protocolReturn?.status === "completed") {
    return request.protocolReturn.execution?.completionClassification === "agent_completed_verified"
      ? "completed"
      : "failed";
  }
  if (
    request.status === "failed" ||
    request.protocolReturn?.status === "failed" ||
    request.deliveryStatus === "return_rejected" ||
    request.operationalStatus?.relayDeliveryStatus === "failed" ||
    request.operationalStatus?.relayDeliveryStatus === "return_rejected" ||
    request.operationalStatus?.agentExecutionStatus === "failed" ||
    request.operationalStatus?.agentExecutionStatus === "worker_completed_return_rejected"
  ) {
    return "failed";
  }

  const submittedAtMs = Date.parse(request.submittedAtIso);
  if (!Number.isNaN(submittedAtMs) && nowMs - submittedAtMs >= JOB_COMPLETION_STALE_MS) {
    return "failed";
  }
  return "pending";
}

function hasVerifiedPaidExecutionForSession(
  hireRequests: HireRequestFile,
  sessionId: string,
  options: { includePrivate?: boolean } = {}
) {
  return hireRequests.requests.some(
    (request) =>
      request.sessionId === sessionId &&
      (options.includePrivate !== false || !isPrivateHireRequest(request)) &&
      request.requestType === "paid_execution" &&
      paidExecutionTerminalOutcome(request) === "completed"
  );
}

function hireRequestRetentionKey(request: HireRequestRecord) {
  return `${request.sessionId}:${request.requestId}`;
}

function retainHireRequests(requests: HireRequestRecord[]) {
  const sorted = [...requests].sort((left, right) => right.submittedAtIso.localeCompare(left.submittedAtIso));
  const retainedKeys = new Set(sorted.slice(0, HIRE_REQUEST_GLOBAL_RECENT_RETAIN_LIMIT).map(hireRequestRetentionKey));
  const paidRetainedBySessionId = new Map<string, number>();

  for (const request of sorted) {
    if (request.requestType !== "paid_execution") {
      continue;
    }
    const retainedCount = paidRetainedBySessionId.get(request.sessionId) ?? 0;
    if (retainedCount >= HIRE_REQUEST_PER_AGENT_PAID_RETAIN_LIMIT) {
      continue;
    }
    retainedKeys.add(hireRequestRetentionKey(request));
    paidRetainedBySessionId.set(request.sessionId, retainedCount + 1);
  }

  return sorted
    .filter((request) => retainedKeys.has(hireRequestRetentionKey(request)))
    .slice(0, HIRE_REQUEST_GLOBAL_SAFETY_RETAIN_LIMIT);
}

function buildAgentCompletionScore(
  hireRequests: HireRequestFile,
  sessionId: string,
  nowMs = Date.now()
): AgentCompletionScore {
  const evaluated = hireRequests.requests
    .filter((request) => request.sessionId === sessionId && request.requestType === "paid_execution")
    .sort((left, right) => right.submittedAtIso.localeCompare(left.submittedAtIso))
    .map((request) => ({
      request,
      outcome: paidExecutionTerminalOutcome(request, nowMs)
    }))
    .filter((entry) => entry.outcome !== "pending")
    .slice(0, JOB_COMPLETION_SCORE_WINDOW_SIZE);
  const completedJobCount = evaluated.filter((entry) => entry.outcome === "completed").length;
  const failedJobCount = evaluated.filter((entry) => entry.outcome === "failed").length;
  const evaluatedJobCount = evaluated.length;
  const successRatePct =
    evaluatedJobCount > 0 ? Math.round((completedJobCount / evaluatedJobCount) * 100) : undefined;
  const lastEvaluatedAtIso = evaluated[0]?.request.submittedAtIso;

  return {
    windowSize: JOB_COMPLETION_SCORE_WINDOW_SIZE,
    evaluatedJobCount,
    completedJobCount,
    failedJobCount,
    ...(successRatePct !== undefined ? { successRatePct } : {}),
    ...(lastEvaluatedAtIso ? { lastEvaluatedAtIso } : {}),
    label:
      successRatePct === undefined
        ? "No paid jobs yet"
        : `${completedJobCount}/${evaluatedJobCount} completed`
  };
}

function buildAgentJobActivityStatsLabel(
  stats: Pick<AgentJobActivityStats, "totalJobCount" | "privateJobCount" | "paidExecutionCount" | "privatePaidExecutionCount" | "completedJobCount">
) {
  return stats.totalJobCount === 0
    ? "No SantaClawz jobs yet"
    : stats.paidExecutionCount === 0
      ? `No paid jobs yet${stats.privateJobCount > 0 ? `, ${stats.privateJobCount} private` : ""}`
      : `${stats.completedJobCount}/${stats.paidExecutionCount} paid jobs completed${stats.privatePaidExecutionCount > 0 ? `, ${stats.privatePaidExecutionCount} private` : ""}`;
}

function emptyAgentJobActivityStats(): AgentJobActivityStats {
  const stats: AgentJobActivityStats = {
    totalJobCount: 0,
    publicJobCount: 0,
    privateJobCount: 0,
    paidExecutionCount: 0,
    privatePaidExecutionCount: 0,
    completedJobCount: 0,
    privateCompletedJobCount: 0,
    failedJobCount: 0,
    privateFailedJobCount: 0,
    label: "No SantaClawz jobs yet"
  };
  return stats;
}

function incrementAgentJobActivityStats(
  current: AgentJobActivityStats | undefined,
  request: HireRequestRecord,
  nowMs = Date.now()
): AgentJobActivityStats {
  const privateJob = isPrivateHireRequest(request);
  const paidExecution = request.requestType === "paid_execution";
  const paidOutcome = paidExecution ? paidExecutionTerminalOutcome(request, nowMs) : "pending";
  const next: AgentJobActivityStats = {
    ...(current ?? emptyAgentJobActivityStats()),
    totalJobCount: (current?.totalJobCount ?? 0) + 1,
    publicJobCount: (current?.publicJobCount ?? 0) + (privateJob ? 0 : 1),
    privateJobCount: (current?.privateJobCount ?? 0) + (privateJob ? 1 : 0),
    paidExecutionCount: (current?.paidExecutionCount ?? 0) + (paidExecution ? 1 : 0),
    privatePaidExecutionCount: (current?.privatePaidExecutionCount ?? 0) + (paidExecution && privateJob ? 1 : 0),
    completedJobCount: (current?.completedJobCount ?? 0) + (paidOutcome === "completed" ? 1 : 0),
    privateCompletedJobCount: (current?.privateCompletedJobCount ?? 0) + (paidOutcome === "completed" && privateJob ? 1 : 0),
    failedJobCount: (current?.failedJobCount ?? 0) + (paidOutcome === "failed" ? 1 : 0),
    privateFailedJobCount: (current?.privateFailedJobCount ?? 0) + (paidOutcome === "failed" && privateJob ? 1 : 0),
    lastJobAtIso: request.submittedAtIso,
    label: ""
  };
  return {
    ...next,
    label: buildAgentJobActivityStatsLabel(next)
  };
}

function buildAgentJobActivityStats(
  hireRequests: HireRequestFile,
  sessionId: string,
  nowMs = Date.now()
): AgentJobActivityStats {
  const persisted = hireRequests.jobActivityStatsBySessionId?.[sessionId];
  if (persisted) {
    return persisted;
  }

  const requests = hireRequests.requests
    .filter((request) => request.sessionId === sessionId)
    .sort((left, right) => right.submittedAtIso.localeCompare(left.submittedAtIso));
  const privateRequests = requests.filter(isPrivateHireRequest);
  const paidRequests = requests.filter((request) => request.requestType === "paid_execution");
  const paidRequestOutcomes = paidRequests.map((request) => ({
    request,
    outcome: paidExecutionTerminalOutcome(request, nowMs)
  }));
  const completedPaidRequests = paidRequestOutcomes.filter((entry) => entry.outcome === "completed");
  const failedPaidRequests = paidRequestOutcomes.filter((entry) => entry.outcome === "failed");
  const privatePaidRequests = paidRequests.filter(isPrivateHireRequest);
  const stats: AgentJobActivityStats = {
    totalJobCount: requests.length,
    publicJobCount: requests.length - privateRequests.length,
    privateJobCount: privateRequests.length,
    paidExecutionCount: paidRequests.length,
    privatePaidExecutionCount: privatePaidRequests.length,
    completedJobCount: completedPaidRequests.length,
    privateCompletedJobCount: completedPaidRequests.filter((entry) => isPrivateHireRequest(entry.request)).length,
    failedJobCount: failedPaidRequests.length,
    privateFailedJobCount: failedPaidRequests.filter((entry) => isPrivateHireRequest(entry.request)).length,
    ...(requests[0]?.submittedAtIso ? { lastJobAtIso: requests[0].submittedAtIso } : {}),
    label: ""
  };
  return {
    ...stats,
    label: buildAgentJobActivityStatsLabel(stats)
  };
}

function buildAgentMarketplaceTagStats(
  hireRequests: HireRequestFile,
  sessionId: string,
  nowMs = Date.now()
): AgentMarketplaceTagStat[] {
  const statsByTag = new Map<string, AgentMarketplaceTagStat>();
  const requests = hireRequests.requests
    .filter((request) =>
      request.sessionId === sessionId &&
      request.requestType === "paid_execution" &&
      shouldPublishDetailedHireLifecycle(request.jobPrivacy)
    );

  for (const request of requests) {
    const outcome = paidExecutionTerminalOutcome(request, nowMs);
    if (outcome === "pending") {
      continue;
    }
    for (const tag of marketplaceWorkTagValues(request.marketplaceTags)) {
      const current = statsByTag.get(tag) ?? {
        tag,
        completedJobCount: 0,
        failedJobCount: 0,
        totalJobCount: 0
      };
      const nextCompletedCount = current.completedJobCount + (outcome === "completed" ? 1 : 0);
      const nextTotalCount = current.totalJobCount + 1;
      const successRatePct = Math.round((nextCompletedCount / nextTotalCount) * 100);
      const next: AgentMarketplaceTagStat = {
        ...current,
        completedJobCount: nextCompletedCount,
        failedJobCount: current.failedJobCount + (outcome === "failed" ? 1 : 0),
        totalJobCount: nextTotalCount,
        successRatePct,
        lastJobAtIso: current.lastJobAtIso && current.lastJobAtIso > request.submittedAtIso
          ? current.lastJobAtIso
          : request.submittedAtIso
      };
      statsByTag.set(tag, next);
    }
  }

  return Array.from(statsByTag.values())
    .sort((left, right) => {
      const byCount = right.totalJobCount - left.totalJobCount;
      if (byCount !== 0) {
        return byCount;
      }
      const bySuccess = (right.successRatePct ?? -1) - (left.successRatePct ?? -1);
      if (bySuccess !== 0) {
        return bySuccess;
      }
      return left.tag.localeCompare(right.tag);
    })
    .slice(0, 24);
}

function buildAgentReadinessState(input: {
  profile: AgentProfileState;
  ownership: AgentOwnershipState;
  published: boolean;
  relayConnected: boolean;
  runtimeReachable: boolean;
  heartbeat: AgentRuntimeHeartbeatState;
  paymentReady: boolean;
  paidExecutionProvenByHistory?: boolean;
  lastJobStatus?: AgentReadinessState["lastJobStatus"];
}): AgentReadinessState {
  const heartbeatLive = input.heartbeat.status === "live";
  const workerReachable = input.runtimeReachable;
  const blockers: string[] = [];
  if (input.profile.availability === "archived") {
    blockers.push("archived");
  }
  if (input.profile.availability === "suspended") {
    blockers.push("platform-suspended");
  }
  if (input.profile.availability === "blocked") {
    blockers.push("platform-blocked");
  }
  if (input.ownership.status !== "verified") {
    blockers.push("ownership-unverified");
  }
  if (!input.published) {
    blockers.push("not-published");
  }
  if (isRelayDeliveryProfile(input.profile) && !input.relayConnected) {
    blockers.push("relay-disconnected");
  }
  if (!heartbeatLive) {
    blockers.push("heartbeat-not-live");
  }
  if (!input.runtimeReachable) {
    blockers.push("runtime-unreachable");
  }
  if (!workerReachable) {
    blockers.push("worker-unreachable");
  }
  if (!input.paymentReady) {
    blockers.push("payment-not-ready");
  }
  const fixedPaidMode = input.profile.paymentProfile.pricingMode === "fixed-exact";
  const paidMode = fixedPaidMode || input.profile.paymentProfile.pricingMode === "quote-required";
  const relayPaidWorkerUnverified =
    fixedPaidMode &&
    isRelayDeliveryProfile(input.profile) &&
    input.relayConnected &&
    heartbeatLive &&
    !input.heartbeat.relayAgentWorkerTiming;
  if (relayPaidWorkerUnverified) {
    blockers.push("worker-readiness-unverified");
  }
  const paidExecutionProven = paidMode
    ? input.heartbeat.paidExecutionProbe?.ok === true || input.paidExecutionProvenByHistory === true
    : undefined;
  const upgradeReasons = [
    ...(paidMode && !paidExecutionProven ? ["paid-execution-not-proven"] : []),
    ...(relayPaidWorkerUnverified ? ["missing-current-relay-timing"] : [])
  ];
  const needsUpgrade = paidMode && upgradeReasons.length > 0;
  const readinessWarnings = paidMode && !input.heartbeat.relayAgentWorkerTiming && !relayPaidWorkerUnverified
    ? ["missing-current-relay-timing"]
    : [];

  return {
    relayConnected: input.relayConnected,
    heartbeatLive,
    runtimeReachable: input.runtimeReachable,
    workerReachable,
    paymentReady: input.paymentReady,
    published: input.published,
    hireable: blockers.length === 0 && !needsUpgrade,
    ...(paidExecutionProven !== undefined ? { paidExecutionProven } : {}),
    ...(needsUpgrade ? { needsUpgrade, upgradeReasons } : {}),
    ...(readinessWarnings.length ? { readinessWarnings } : {}),
    lastJobStatus: input.lastJobStatus ?? "none",
    blockers
  };
}

async function assertQuoteBuyerWalletProof(input: {
  agentId: string;
  requestId: string;
  buyerAgentId?: string;
  buyerWallet?: string;
  acceptedAmountUsd: string;
  acceptedQuoteDigestSha256: string;
  maxAmountUsd?: string;
  rail: AgentPaymentRail;
  settlementModel: ExecutionIntentSettlementModel;
  proof?: Partial<SantaClawzQuoteAcceptanceWalletProof>;
}) {
  const buyerWallet = input.buyerWallet?.trim();
  if (!buyerWallet) {
    if (input.proof || requireQuoteBuyerWalletProof()) {
      throw new Error("Quote buyer wallet proof requires buyerWallet.");
    }
    return;
  }
  if (!input.proof) {
    if (requireQuoteBuyerWalletProof()) {
      throw new Error("buyerWalletProof is required before creating a quote payment intent.");
    }
    return;
  }
  if (input.proof.scheme !== SANTACLAWZ_QUOTE_ACCEPTANCE_WALLET_PROOF_SCHEME) {
    throw new Error("buyerWalletProof.scheme must be eip191-personal-sign.");
  }
  if (!input.proof.signature?.trim()) {
    throw new Error("buyerWalletProof.signature is required.");
  }
  const expectedMessage = buildSantaClawzQuoteAcceptanceMessage({
    agentId: input.agentId,
    requestId: input.requestId,
    buyerWallet,
    acceptedAmountUsd: input.acceptedAmountUsd,
    acceptedQuoteDigestSha256: input.acceptedQuoteDigestSha256,
    ...(input.maxAmountUsd?.trim() ? { maxAmountUsd: input.maxAmountUsd.trim() } : {}),
    rail: input.rail,
    settlementModel: input.settlementModel,
    ...(input.buyerAgentId?.trim() ? { buyerAgentId: input.buyerAgentId.trim().slice(0, 96) } : {})
  });
  if (input.proof.message !== expectedMessage) {
    throw new Error("buyerWalletProof.message does not match the accepted quote.");
  }
  const ok = await verifyMessage({
    address: getAddress(buyerWallet),
    message: expectedMessage,
    signature: input.proof.signature.trim() as `0x${string}`
  });
  if (!ok) {
    throw new Error("buyerWalletProof.signature was not produced by buyerWallet.");
  }
}

function effectiveSocialAnchorMode(
  mode: AgentProfileState["socialAnchorPolicy"]["mode"],
  deployment: Pick<ZekoDeploymentState, "networkId" | "mode">
): AgentProfileState["socialAnchorPolicy"]["mode"] {
  if (mode === "priority-self-funded" && (isMainnetNetwork(deployment) || allowTestnetSelfServeSocialAnchor())) {
    return "priority-self-funded";
  }
  return "shared-batched";
}

function sanitizePayoutWalletValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 180) : undefined;
}

function sanitizeUsdAmount(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 40) : undefined;
}

function sanitizeUrl(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 280) : undefined;
}

function sanitizePaymentNotes(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 280) : undefined;
}

function sanitizeEvmContractAddress(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 80) : undefined;
}

function sanitizeMissionScopeHints(input: unknown, fallback: string[] = []): string[] {
  const source = Array.isArray(input) ? input : fallback;
  return Array.from(
    new Set(
      source
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().slice(0, 120))
        .filter((value) => value.length > 0)
    )
  ).slice(0, 12);
}

function sanitizeAgentBoardTopicTags(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return Array.from(
    new Set(
      input
        .filter((value): value is string => typeof value === "string")
        .map((value) =>
          value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9-_\s]/g, "")
            .replace(/\s+/g, "-")
            .slice(0, AGENT_BOARD_TOPIC_MAX_LENGTH)
        )
        .filter((value) => value.length > 0 && !hasBlockedPublicTerm([value]))
    )
  ).slice(0, AGENT_BOARD_TOPIC_MAX_COUNT);
}

function sanitizeAgentBoardCapabilityTags(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return Array.from(
    new Set(
      input
        .filter((value): value is string => typeof value === "string")
        .map((value) =>
          value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9-_:./\s]/g, "")
            .replace(/\s+/g, "-")
            .slice(0, AGENT_BOARD_CAPABILITY_MAX_LENGTH)
        )
        .filter((value) => value.length > 0 && !hasBlockedPublicTerm([value]))
    )
  ).slice(0, AGENT_BOARD_CAPABILITY_MAX_COUNT);
}

function sanitizeAgentBoardFilterTag(value: unknown, maxLength = AGENT_BOARD_CAPABILITY_MAX_LENGTH): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_:./\s]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, maxLength);
  return normalized.length > 0 && !hasBlockedPublicTerm([normalized]) ? normalized : undefined;
}

function sanitizeMarketplaceTagList(input: unknown): string[] {
  return sanitizeAgentBoardCapabilityTags(input);
}

function sanitizeAgentMarketplaceTags(
  input: Partial<AgentMarketplaceTags> | undefined,
  fallback: AgentMarketplaceTags
): AgentMarketplaceTags {
  if (!input) {
    return {
      capabilities: [...fallback.capabilities],
      domains: [...fallback.domains],
      inputTypes: [...fallback.inputTypes],
      outputTypes: [...fallback.outputTypes],
      tools: [...fallback.tools],
      runtimes: [...fallback.runtimes]
    };
  }

  return {
    capabilities: Array.isArray(input.capabilities) ? sanitizeMarketplaceTagList(input.capabilities) : fallback.capabilities,
    domains: Array.isArray(input.domains) ? sanitizeMarketplaceTagList(input.domains) : fallback.domains,
    inputTypes: Array.isArray(input.inputTypes) ? sanitizeMarketplaceTagList(input.inputTypes) : fallback.inputTypes,
    outputTypes: Array.isArray(input.outputTypes) ? sanitizeMarketplaceTagList(input.outputTypes) : fallback.outputTypes,
    tools: Array.isArray(input.tools) ? sanitizeMarketplaceTagList(input.tools) : fallback.tools,
    runtimes: Array.isArray(input.runtimes) ? sanitizeMarketplaceTagList(input.runtimes) : fallback.runtimes
  };
}

function emptyMarketplaceWorkTags(): MarketplaceWorkTags {
  return {
    jobTags: [],
    capabilityTags: [],
    inputTags: [],
    outputTags: []
  };
}

function sanitizeMarketplaceWorkTags(input: Partial<MarketplaceWorkTags> | undefined): MarketplaceWorkTags {
  if (!input) {
    return emptyMarketplaceWorkTags();
  }
  return {
    jobTags: sanitizeMarketplaceTagList(input.jobTags),
    capabilityTags: sanitizeMarketplaceTagList(input.capabilityTags),
    inputTags: sanitizeMarketplaceTagList(input.inputTags),
    outputTags: sanitizeMarketplaceTagList(input.outputTags)
  };
}

function marketplaceWorkTagsAreEmpty(tags: MarketplaceWorkTags): boolean {
  return tags.jobTags.length === 0 && tags.capabilityTags.length === 0 && tags.inputTags.length === 0 && tags.outputTags.length === 0;
}

function marketplaceWorkTagValues(tags: MarketplaceWorkTags | undefined): string[] {
  if (!tags) {
    return [];
  }
  return Array.from(new Set([
    ...(Array.isArray(tags.jobTags) ? tags.jobTags : []),
    ...(Array.isArray(tags.capabilityTags) ? tags.capabilityTags : []),
    ...(Array.isArray(tags.inputTags) ? tags.inputTags : []),
    ...(Array.isArray(tags.outputTags) ? tags.outputTags : [])
  ]));
}

function agentMarketplaceTagValues(tags: AgentMarketplaceTags | undefined): string[] {
  if (!tags) {
    return [];
  }
  return Array.from(new Set([
    ...(Array.isArray(tags.capabilities) ? tags.capabilities : []),
    ...(Array.isArray(tags.domains) ? tags.domains : []),
    ...(Array.isArray(tags.inputTypes) ? tags.inputTypes : []),
    ...(Array.isArray(tags.outputTypes) ? tags.outputTypes : []),
    ...(Array.isArray(tags.tools) ? tags.tools : []),
    ...(Array.isArray(tags.runtimes) ? tags.runtimes : [])
  ]));
}

function agentMarketplaceTagsAreEmpty(tags: AgentMarketplaceTags | undefined): boolean {
  return agentMarketplaceTagValues(tags).length === 0;
}

function marketplaceTagsDigest(tags: AgentMarketplaceTags | MarketplaceWorkTags | undefined): string | undefined {
  if (!tags) {
    return undefined;
  }
  return canonicalDigest(tags).sha256Hex;
}

function sanitizeAgentBoardMessageType(value: unknown): AgentBoardMessageType {
  return value === "question" || value === "reply" || value === "output" ? value : "dispatch";
}

function sanitizeJobMessageBody(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("message body is required.");
  }
  return trimmed.slice(0, 4000);
}

function sanitizeJobNote(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 1200) : undefined;
}

function sanitizeJobStage(value: unknown): JobStageKind {
  return value === "procurement" ||
    value === "intake" ||
    value === "quote" ||
    value === "accepted" ||
    value === "in_progress" ||
    value === "draft" ||
    value === "delivery" ||
    value === "review" ||
    value === "final" ||
    value === "closed"
    ? value
    : "in_progress";
}

function sanitizeJobStageStatus(value: unknown): JobStageStatus {
  return value === "pending" ||
    value === "active" ||
    value === "blocked" ||
    value === "completed" ||
    value === "accepted" ||
    value === "revision_requested"
    ? value
    : "active";
}

function sanitizeJobStageDescriptor(stageValue: unknown, statusValue: unknown): { stage: JobStageKind; status: JobStageStatus } {
  if (typeof stageValue === "string") {
    const [stagePart, statusPart] = stageValue.split("/", 2).map((part) => part.trim()).filter(Boolean);
    return {
      stage: sanitizeJobStage(stagePart),
      status: statusPart ? sanitizeJobStageStatus(statusPart) : sanitizeJobStageStatus(statusValue)
    };
  }
  return {
    stage: sanitizeJobStage(stageValue),
    status: sanitizeJobStageStatus(statusValue)
  };
}

function sanitizeJobAuthorRole(value: unknown, fallback: JobMessageAuthorRole): JobMessageAuthorRole {
  return value === "buyer" || value === "seller" || value === "system" ? value : fallback;
}

function normalizeOptionalSha256(value?: string) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("artifactDigestSha256 must be a 64-character hex SHA-256 digest.");
  }
  return normalized;
}

function sanitizeOptionalBoardId(value: unknown, prefix: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().slice(0, 96);
  return normalized.startsWith(prefix) ? normalized : undefined;
}

function sanitizeMissionAuthOverlay(
  input: Partial<AgentProfileState["missionAuthOverlay"]> | undefined,
  fallback: AgentProfileState["missionAuthOverlay"],
  options: { trustVerifiedInput?: boolean } = {}
): AgentProfileState["missionAuthOverlay"] {
  const enabled = typeof input?.enabled === "boolean" ? input.enabled : fallback.enabled;
  const authorityBaseUrl = sanitizeUrl(input?.authorityBaseUrl) ?? sanitizeUrl(fallback.authorityBaseUrl);
  const providerHint =
    input?.providerHint === "auth0" || input?.providerHint === "okta" || input?.providerHint === "custom-oidc"
      ? input.providerHint
      : fallback.providerHint;
  const scopeHints = sanitizeMissionScopeHints(input?.scopeHints, fallback.scopeHints);
  const authorityChanged = authorityBaseUrl !== sanitizeUrl(fallback.authorityBaseUrl);
  const enabledChanged = enabled !== fallback.enabled;
  const trustVerifiedInput =
    Boolean(options.trustVerifiedInput) &&
    enabled &&
    input?.status === "verified" &&
    input.protocol === "zk-mission-auth" &&
    Boolean(authorityBaseUrl);
  const preserveVerifiedState = trustVerifiedInput || (!authorityChanged && !enabledChanged && fallback.status === "verified");
  const verifiedSource = trustVerifiedInput ? input : fallback;

  return {
    enabled,
    status: !enabled ? "disabled" : preserveVerifiedState ? "verified" : "configured",
    ...(authorityBaseUrl ? { authorityBaseUrl } : {}),
    ...(providerHint ? { providerHint } : {}),
    scopeHints,
    ...(preserveVerifiedState && verifiedSource.protocol ? { protocol: verifiedSource.protocol } : {}),
    ...(preserveVerifiedState && verifiedSource.authorityName ? { authorityName: verifiedSource.authorityName } : {}),
    ...(preserveVerifiedState && verifiedSource.discoveryUrl ? { discoveryUrl: verifiedSource.discoveryUrl } : {}),
    ...(preserveVerifiedState && verifiedSource.jwksUrl ? { jwksUrl: verifiedSource.jwksUrl } : {}),
    ...(preserveVerifiedState && verifiedSource.providersUrl ? { providersUrl: verifiedSource.providersUrl } : {}),
    ...(preserveVerifiedState && verifiedSource.verifyCheckpointUrl
      ? { verifyCheckpointUrl: verifiedSource.verifyCheckpointUrl }
      : {}),
    ...(preserveVerifiedState && verifiedSource.exportBundleUrl ? { exportBundleUrl: verifiedSource.exportBundleUrl } : {}),
    ...(preserveVerifiedState && verifiedSource.supportedProviders ? { supportedProviders: verifiedSource.supportedProviders } : {}),
    ...(preserveVerifiedState && verifiedSource.lastVerifiedAtIso ? { lastVerifiedAtIso: verifiedSource.lastVerifiedAtIso } : {})
  };
}

function sanitizeSocialAnchorPolicy(
  input: Partial<AgentProfileState["socialAnchorPolicy"]> | undefined,
  fallback: AgentProfileState["socialAnchorPolicy"]
): AgentProfileState["socialAnchorPolicy"] {
  return {
    mode:
      input?.mode === "priority-self-funded" || input?.mode === "shared-batched"
        ? input.mode
        : fallback.mode
  };
}

function sanitizePayoutWallets(
  input: Partial<AgentProfileState["payoutWallets"]> | undefined,
  fallback: AgentProfileState["payoutWallets"],
  legacyPayoutAddress?: unknown
): AgentProfileState["payoutWallets"] {
  const zeko = sanitizePayoutWalletValue(input?.zeko) ?? sanitizePayoutWalletValue(fallback.zeko);
  const base =
    sanitizePayoutWalletValue(input?.base) ??
    sanitizePayoutWalletValue(legacyPayoutAddress) ??
    sanitizePayoutWalletValue(fallback.base);
  const ethereum = sanitizePayoutWalletValue(input?.ethereum) ?? sanitizePayoutWalletValue(fallback.ethereum);

  return {
    ...(zeko ? { zeko } : {}),
    ...(base ? { base } : {}),
    ...(ethereum ? { ethereum } : {})
  };
}

function hasPayoutAddress(profile: AgentProfileState): boolean {
  return Object.values(profile.payoutWallets).some((value) => typeof value === "string" && value.trim().length > 0);
}

function facilitatorUrlForRail(
  profile: AgentProfileState,
  rail: AgentProfileState["paymentProfile"]["supportedRails"][number]
): string | undefined {
  if (rail === "base-usdc") {
    return sanitizeUrl(profile.paymentProfile.baseFacilitatorUrl) ?? sanitizeUrl(process.env.CLAWZ_X402_BASE_FACILITATOR_URL);
  }
  if (rail === "ethereum-usdc") {
    return (
      sanitizeUrl(profile.paymentProfile.ethereumFacilitatorUrl) ??
      sanitizeUrl(process.env.CLAWZ_X402_ETHEREUM_FACILITATOR_URL)
    );
  }
  return undefined;
}

function sanitizePaymentProfile(
  input: Partial<AgentProfileState["paymentProfile"]> | undefined,
  fallback: AgentProfileState["paymentProfile"]
): AgentProfileState["paymentProfile"] {
  const supportedRails = Array.from(
    new Set(
      (Array.isArray(input?.supportedRails) ? input.supportedRails : fallback.supportedRails).filter(
        (rail): rail is AgentProfileState["paymentProfile"]["supportedRails"][number] =>
          rail === "base-usdc" || rail === "ethereum-usdc" || rail === "zeko-native"
      )
    )
  );
  const normalizedRails: AgentProfileState["paymentProfile"]["supportedRails"] =
    supportedRails.length > 0 ? supportedRails : ["base-usdc"];
  const defaultRail =
    (input?.defaultRail && normalizedRails.includes(input.defaultRail) ? input.defaultRail : undefined) ??
    (fallback.defaultRail && normalizedRails.includes(fallback.defaultRail) ? fallback.defaultRail : undefined) ??
    normalizedRails[0];
  const pricingMode =
    input?.pricingMode === "fixed-exact" || input?.pricingMode === "quote-required" || input?.pricingMode === "free-test"
      ? input.pricingMode
      : fallback.pricingMode === "fixed-exact" ||
          fallback.pricingMode === "quote-required" ||
          fallback.pricingMode === "free-test"
        ? fallback.pricingMode
        : "quote-required";
  const settlementTrigger =
    input?.settlementTrigger === "upfront" || input?.settlementTrigger === "on-proof"
      ? input.settlementTrigger
      : fallback.settlementTrigger;
  const fixedAmountUsd =
    pricingMode === "fixed-exact"
      ? sanitizeUsdAmount(input?.fixedAmountUsd) ?? sanitizeUsdAmount(fallback.fixedAmountUsd)
      : undefined;
  const quoteUrl =
    pricingMode === "quote-required"
      ? sanitizeUrl(input?.quoteUrl) ?? sanitizeUrl(fallback.quoteUrl)
      : undefined;
  const referencePriceUsd =
    pricingMode === "quote-required"
      ? sanitizeUsdAmount(input?.referencePriceUsd) ?? sanitizeUsdAmount(fallback.referencePriceUsd)
      : undefined;
  const referencePriceUnit =
    input?.referencePriceUnit === "minimum" ||
    input?.referencePriceUnit === "agent-minute" ||
    input?.referencePriceUnit === "compute-unit"
      ? input.referencePriceUnit
      : fallback.referencePriceUnit;

  return {
    enabled: pricingMode === "free-test" ? false : typeof input?.enabled === "boolean" ? input.enabled : fallback.enabled,
    supportedRails: normalizedRails,
    ...(defaultRail ? { defaultRail } : {}),
    pricingMode,
    ...(fixedAmountUsd ? { fixedAmountUsd } : {}),
    ...(quoteUrl ? { quoteUrl } : {}),
    ...(referencePriceUsd ? { referencePriceUsd } : {}),
    ...(pricingMode === "quote-required" && referencePriceUnit ? { referencePriceUnit } : {}),
    settlementTrigger,
    ...(sanitizeUrl(input?.baseFacilitatorUrl) ?? sanitizeUrl(fallback.baseFacilitatorUrl)
      ? {
          baseFacilitatorUrl:
            sanitizeUrl(input?.baseFacilitatorUrl) ?? sanitizeUrl(fallback.baseFacilitatorUrl)!
        }
      : {}),
    ...(sanitizeUrl(input?.ethereumFacilitatorUrl) ?? sanitizeUrl(fallback.ethereumFacilitatorUrl)
      ? {
          ethereumFacilitatorUrl:
            sanitizeUrl(input?.ethereumFacilitatorUrl) ?? sanitizeUrl(fallback.ethereumFacilitatorUrl)!
        }
      : {}),
    ...(sanitizeEvmContractAddress(input?.baseEscrowContract) ?? sanitizeEvmContractAddress(fallback.baseEscrowContract)
      ? {
          baseEscrowContract:
            sanitizeEvmContractAddress(input?.baseEscrowContract) ??
            sanitizeEvmContractAddress(fallback.baseEscrowContract)!
        }
      : {}),
    ...(sanitizeEvmContractAddress(input?.ethereumEscrowContract) ??
    sanitizeEvmContractAddress(fallback.ethereumEscrowContract)
      ? {
          ethereumEscrowContract:
            sanitizeEvmContractAddress(input?.ethereumEscrowContract) ??
            sanitizeEvmContractAddress(fallback.ethereumEscrowContract)!
        }
      : {}),
    ...(sanitizePaymentNotes(input?.paymentNotes) ?? sanitizePaymentNotes(fallback.paymentNotes)
      ? { paymentNotes: sanitizePaymentNotes(input?.paymentNotes) ?? sanitizePaymentNotes(fallback.paymentNotes)! }
      : {})
  };
}

function payoutWalletForRail(profile: AgentProfileState, rail: AgentProfileState["paymentProfile"]["supportedRails"][number]): string | undefined {
  if (rail === "base-usdc") {
    return profile.payoutWallets.base;
  }
  if (rail === "ethereum-usdc") {
    return profile.payoutWallets.ethereum;
  }
  return profile.payoutWallets.zeko;
}

function isQuotedPricingMode(mode: AgentProfileState["paymentProfile"]["pricingMode"]) {
  return mode === "quote-required";
}

function isFreeTestPricingMode(mode: AgentProfileState["paymentProfile"]["pricingMode"]) {
  return mode === "free-test";
}

function hasReadyPaymentProfile(profile: AgentProfileState): boolean {
  if (isFreeTestPricingMode(profile.paymentProfile.pricingMode)) {
    return true;
  }
  if (!profile.paymentProfile.enabled) {
    return false;
  }
  const selectedRail = profile.paymentProfile.defaultRail ?? profile.paymentProfile.supportedRails[0];
  if (!selectedRail || !payoutWalletForRail(profile, selectedRail)) {
    return false;
  }
  if (selectedRail === "zeko-native") {
    return false;
  }
  if (!facilitatorUrlForRail(profile, selectedRail)) {
    return false;
  }
  if (profile.paymentProfile.pricingMode === "fixed-exact") {
    return typeof profile.paymentProfile.fixedAmountUsd === "string" && profile.paymentProfile.fixedAmountUsd.trim().length > 0;
  }
  if (isQuotedPricingMode(profile.paymentProfile.pricingMode)) {
    return true;
  }
  return true;
}

function isArchivedProfile(profile: AgentProfileState): boolean {
  return profile.availability !== "active";
}

function computePaidJobsEnabled(
  profile: AgentProfileState,
  published: boolean,
  deployment: Pick<ZekoDeploymentState, "networkId" | "mode">
): boolean {
  return (
    !isArchivedProfile(profile) &&
    published &&
    profile.paymentProfile.pricingMode === "fixed-exact" &&
    hasReadyPaymentProfile(profile) &&
    (!isMainnetNetwork(deployment) || hasPayoutAddress(profile))
  );
}

interface FreeTestQuotaPolicy {
  windowMs: number;
  perAgentLimit: number;
  globalLimit: number;
  windowLabel: string;
}

function freeTestQuotaPolicyFor(input: {
  deployment: Pick<ZekoDeploymentState, "networkId">;
  profile: AgentProfileState;
}): FreeTestQuotaPolicy {
  if (!networkIdLooksMainnet(input.deployment)) {
    return {
      windowMs: FREE_TEST_HIRE_WINDOW_MS,
      perAgentLimit: FREE_TEST_HIRE_LIMIT_PER_AGENT,
      globalLimit: FREE_TEST_HIRE_LIMIT_GLOBAL,
      windowLabel: "10 minutes"
    };
  }

  if (!envFlagEnabled("CLAWZ_MAINNET_FREE_TEST_ENABLED")) {
    throw new Error(
      "Free-test mode is disabled on mainnet by default. Use paid x402 or explicitly enable CLAWZ_MAINNET_FREE_TEST_ENABLED with tight quotas."
    );
  }

  return {
    windowMs: MAINNET_FREE_TEST_HIRE_WINDOW_MS,
    perAgentLimit: hasPayoutAddress(input.profile)
      ? MAINNET_FREE_TEST_LIMIT_PER_AGENT_WITH_PAYOUT
      : MAINNET_FREE_TEST_LIMIT_PER_AGENT_WITHOUT_PAYOUT,
    globalLimit: MAINNET_FREE_TEST_LIMIT_GLOBAL,
    windowLabel: "24 hours"
  };
}

function assertFreeTestHireQuota(
  hireRequests: HireRequestFile,
  agentId: string,
  policy: FreeTestQuotaPolicy,
  nowMs: number
): void {
  const windowStartMs = nowMs - policy.windowMs;
  const recentFreeTestRequests = hireRequests.requests.filter((request) => {
    if (request.requestType !== "free_test") {
      return false;
    }
    const submittedAtMs = Date.parse(request.submittedAtIso);
    return !Number.isNaN(submittedAtMs) && submittedAtMs >= windowStartMs;
  });
  const recentForAgent = recentFreeTestRequests.filter((request) => request.agentId === agentId);
  if (recentForAgent.length >= policy.perAgentLimit) {
    throw new Error(
      `Free-test limit reached for this agent. Try again shortly or switch to paid work. Limit: ${policy.perAgentLimit} requests per ${policy.windowLabel}.`
    );
  }
  if (recentFreeTestRequests.length >= policy.globalLimit) {
    throw new Error(
      `SantaClawz free-test capacity is temporarily full. Try again shortly. Limit: ${policy.globalLimit} free-test requests per ${policy.windowLabel}.`
    );
  }
}

function hasConfirmedSocialAnchorKind(
  items: SocialAnchorCandidate[],
  sessionId: string,
  kind: SocialAnchorCandidateKind
): boolean {
  return items.some((item) => item.sessionId === sessionId && item.kind === kind && item.status === "confirmed");
}

function hasConfirmedZekoPublication(items: SocialAnchorCandidate[], sessionId: string): boolean {
  return (
    hasConfirmedSocialAnchorKind(items, sessionId, "agent-published") ||
    (
      hasConfirmedSocialAnchorKind(items, sessionId, "agent-registered") &&
      hasConfirmedSocialAnchorKind(items, sessionId, "ownership-verified")
    )
  );
}

function isSessionPublishedOnZeko(input: {
  liveFlowTargets: LiveFlowTargets;
  socialAnchorQueueFile: SocialAnchorQueueFile;
  sessionId: string;
  durablePublished?: boolean;
}): boolean {
  return (
    input.durablePublished === true ||
    input.liveFlowTargets.turns.some((target) => target.sessionId === input.sessionId) ||
    hasConfirmedZekoPublication(input.socialAnchorQueueFile.items, input.sessionId)
  );
}

export class ClawzControlPlane {
  private readonly statePath: string;
  private readonly eventsPath: string;
  private readonly workspaceRoot: string;
  private readonly deploymentManifestPath: string;
  private readonly deploymentWitnessPlanPath: string;
  private readonly legacyWitnessPlanPath: string;
  private readonly liveFlowReportPath: string;
  private readonly liveFlowPlanPath: string;
  private readonly liveFlowStatusPath: string;
  private readonly sponsorQueuePath: string;
  private readonly hireRequestPath: string;
  private readonly jobCollaborationPath: string;
  private readonly paymentLedgerPath: string;
  private readonly executionIntentPath: string;
  private readonly procurementIntentPath: string;
  private readonly socialAnchorQueuePath: string;
  private readonly agentBoardPath: string;
  private readonly runtimeHeartbeatPath: string;
  private readonly keyBroker: TenantKeyBroker;
  private readonly keyBrokerRuntime: TenantKeyBrokerRuntimeDescriptor;
  private readonly blobStore: SealedBlobStore;
  private liveFlowRunPromise: Promise<ConsoleStateResponse> | null = null;
  private sponsorQueueRunPromise: Promise<void> | null = null;
  private sharedSocialAnchorRunPromise: Promise<void> | null = null;
  private sharedSocialAnchorIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private readonly sharedSocialAnchorIntervalMs: number;
  private readonly prioritySocialAnchorRuns = new Map<string, Promise<void>>();
  private agentBoardMutationLock: Promise<void> = Promise.resolve();
  private relayRuntimeStatusProvider: RelayRuntimeStatusProvider | undefined;
  private relayHireDeliveryHandler: RelayHireDeliveryHandler | undefined;

  constructor(private readonly baseDir: string) {
    this.workspaceRoot = findWorkspaceRoot(path.dirname(fileURLToPath(import.meta.url)));
    this.statePath = path.join(baseDir, "state", "console.json");
    this.eventsPath = path.join(baseDir, "state", "events.json");
    this.deploymentManifestPath = path.join(this.workspaceRoot, "packages", "contracts", "deployments", "latest-testnet.json");
    this.deploymentWitnessPlanPath = path.join(this.workspaceRoot, "packages", "contracts", "deployments", "latest-witness-plan.json");
    this.legacyWitnessPlanPath = path.join(this.workspaceRoot, "packages", "contracts", "artifacts", "deployment-witness-plan.json");
    this.liveFlowReportPath = path.join(this.workspaceRoot, "packages", "contracts", "deployments", "latest-session-turn-flow.json");
    this.liveFlowPlanPath = path.join(
      this.workspaceRoot,
      "packages",
      "contracts",
      "deployments",
      "latest-runtime-session-turn-plan.json"
    );
    this.liveFlowStatusPath = path.join(baseDir, "state", "live-session-turn-flow.json");
    this.sponsorQueuePath = path.join(baseDir, "state", "wallet-sponsor-queue.json");
    this.hireRequestPath = path.join(baseDir, "state", "hire-requests.json");
    this.jobCollaborationPath = path.join(baseDir, "state", "job-collaboration.json");
    this.paymentLedgerPath = path.join(baseDir, "state", "payment-ledger.json");
    this.executionIntentPath = path.join(baseDir, "state", "execution-intents.json");
    this.procurementIntentPath = path.join(baseDir, "state", "procurement-intents.json");
    this.socialAnchorQueuePath = path.join(baseDir, "state", "social-anchor-queue.json");
    this.agentBoardPath = path.join(baseDir, "state", "agent-message-board.json");
    this.runtimeHeartbeatPath = path.join(baseDir, "state", "agent-runtime-heartbeats.json");
    const configuredSharedAnchorIntervalMs = Number(process.env.CLAWZ_SHARED_SOCIAL_ANCHOR_INTERVAL_MS ?? "10000");
    this.sharedSocialAnchorIntervalMs = Number.isFinite(configuredSharedAnchorIntervalMs)
      ? Math.max(1000, Math.min(configuredSharedAnchorIntervalMs, 60000))
      : 10000;
    this.keyBroker = createTenantKeyBroker({
      baseDir: path.join(baseDir, "kms"),
      wrappedKeyDir: path.join(baseDir, "kms", "wrapped-keys")
    });
    this.keyBrokerRuntime = this.keyBroker.getRuntimeDescriptor();
    this.blobStore = createSealedBlobStore({
      baseDir: path.join(baseDir, "blobs"),
      keyBroker: this.keyBroker
    });
  }

  static async boot(baseDir = path.join(process.cwd(), ".clawz-data")): Promise<ClawzControlPlane> {
    const controlPlane = new ClawzControlPlane(baseDir);
    await controlPlane.ensureBootstrapped();
    return controlPlane;
  }

  setRelayRuntimeStatusProvider(provider: RelayRuntimeStatusProvider) {
    this.relayRuntimeStatusProvider = provider;
  }

  setRelayHireDeliveryHandler(handler: RelayHireDeliveryHandler) {
    this.relayHireDeliveryHandler = handler;
  }

  startSharedSocialAnchorDrainer(): void {
    if (this.sharedSocialAnchorIntervalHandle) {
      return;
    }

    this.sharedSocialAnchorIntervalHandle = setInterval(() => {
      void this.runSharedSocialAnchorBatchCycle();
    }, this.sharedSocialAnchorIntervalMs);
    const intervalHandleWithUnref = this.sharedSocialAnchorIntervalHandle as { unref?: () => void } | null;
    intervalHandleWithUnref?.unref?.();

    void this.runSharedSocialAnchorBatchCycle();
  }

  private async ensureDirs() {
    await mkdir(path.join(this.baseDir, "state"), { recursive: true, mode: 0o700 });
    await this.blobStore.ensureDirs();
  }

  private async loadState(): Promise<ConsolePersistenceState> {
    await this.ensureDirs();
    const state = await readJsonFile<ConsolePersistenceState>(this.statePath);
    if (state) {
      const resolvedProfiles =
        state.profilesBySession && Object.keys(state.profilesBySession).length > 0
          ? state.profilesBySession
          : {
              [state.currentSessionId]: buildDefaultProfile(state.activeMode)
            };
      const migratedState: ConsolePersistenceState = {
        ...state,
        schemaVersion: 6,
        agentIdsBySession:
          state.agentIdsBySession && Object.keys(state.agentIdsBySession).length > 0
            ? state.agentIdsBySession
            : Object.fromEntries(
                Object.entries(resolvedProfiles).map(([sessionId, profile]) => [sessionId, buildStableAgentId(profile.agentName, sessionId)])
              ),
        profilesBySession: resolvedProfiles,
        adminKeysBySession: state.adminKeysBySession ?? {},
        ingressSecretsBySession: state.ingressSecretsBySession ?? {},
        ownershipBySession:
          state.ownershipBySession && Object.keys(state.ownershipBySession).length > 0
            ? Object.fromEntries(
                Object.entries(resolvedProfiles).map(([sessionId, profile]) => [
                  sessionId,
                  state.ownershipBySession?.[sessionId] ?? buildDefaultOwnershipRecord(true)
                ])
              )
            : Object.fromEntries(
                Object.entries(resolvedProfiles).map(([sessionId]) => [sessionId, buildDefaultOwnershipRecord(true)])
              ),
        publishedSessionsBySession: state.publishedSessionsBySession ?? {},
        deletedAgentRegistrationsBySession: state.deletedAgentRegistrationsBySession ?? {},
        enrollmentTicketsById: state.enrollmentTicketsById ?? {}
      };
      if (
        state.schemaVersion !== 6 ||
        !state.agentIdsBySession ||
        Object.keys(state.agentIdsBySession).length === 0 ||
        !state.profilesBySession ||
        Object.keys(state.profilesBySession).length === 0 ||
        !state.adminKeysBySession ||
        !state.ingressSecretsBySession ||
        !state.ownershipBySession ||
        !state.publishedSessionsBySession ||
        !state.deletedAgentRegistrationsBySession ||
        !state.enrollmentTicketsById
      ) {
        await this.saveState(migratedState);
      }
      return migratedState;
    }

    const fallback = buildDefaultState(new Date().toISOString());
    await this.saveState(fallback);
    return fallback;
  }

  private async saveState(state: ConsolePersistenceState) {
    await this.ensureDirs();
    await writeJsonFile(this.statePath, state);
  }

  private async markSessionPublished(input: {
    sessionId: string;
    publishedAtIso: string;
    source: PublishedSessionRecord["source"];
    batchId?: string;
    rootDigestSha256?: string;
  }): Promise<void> {
    const state = await this.loadState();
    const existing = state.publishedSessionsBySession[input.sessionId];
    if (existing) {
      return;
    }
    await this.saveState({
      ...state,
      publishedSessionsBySession: {
        ...state.publishedSessionsBySession,
        [input.sessionId]: {
          publishedAtIso: input.publishedAtIso,
          source: input.source,
          ...(input.batchId ? { batchId: input.batchId } : {}),
          ...(input.rootDigestSha256 ? { rootDigestSha256: input.rootDigestSha256 } : {})
        }
      }
    });
  }

  private socialAnchorBatchPublishesAgent(batch: Pick<SocialAnchorBatch, "candidateKinds">): boolean {
    return (
      batch.candidateKinds.includes("agent-published") ||
      (batch.candidateKinds.includes("agent-registered") && batch.candidateKinds.includes("ownership-verified"))
    );
  }

  private async ensureAgentPublishedAnchorCandidate(state: ConsolePersistenceState, sessionId: string): Promise<{
    created: boolean;
    alreadyPublished: boolean;
  }> {
    const queue = await this.loadSocialAnchorQueueFile();
    const existingPublishedCandidate = queue.items.find(
      (item) => item.sessionId === sessionId && item.kind === "agent-published"
    );
    if (existingPublishedCandidate?.status === "confirmed") {
      await this.markSessionPublished({
        sessionId,
        publishedAtIso: existingPublishedCandidate.confirmedAtIso ?? existingPublishedCandidate.anchoredAtIso ?? existingPublishedCandidate.occurredAtIso,
        source: "migration",
        ...(existingPublishedCandidate.batchId ? { batchId: existingPublishedCandidate.batchId } : {}),
        ...(existingPublishedCandidate.batchRootDigestSha256
          ? { rootDigestSha256: existingPublishedCandidate.batchRootDigestSha256 }
          : {})
      });
      return { created: false, alreadyPublished: true };
    }
    if (
      existingPublishedCandidate &&
      (existingPublishedCandidate.status === "pending" ||
        existingPublishedCandidate.status === "submitted" ||
        existingPublishedCandidate.status === "retrying")
    ) {
      return { created: false, alreadyPublished: false };
    }

    const ownership = this.ownershipForSession(state, sessionId);
    if (ownership.status !== "verified") {
      throw new Error("Verify control of the PublicClawz agent URL before publishing on Zeko.");
    }
    const agentId = this.agentIdForSession(state, sessionId);
    const profile = this.profileForSession(state, sessionId);
    await this.enqueueSocialAnchorCandidate({
      sessionId,
      kind: "agent-published",
      summary: `${profile.agentName} published on Zeko and is now visible in Explore.`,
      occurredAtIso: new Date().toISOString(),
      payload: {
        agentId,
        networkId: (await this.getDeploymentState()).networkId,
        source: "seller-readiness-refresh"
      }
    });
    return { created: true, alreadyPublished: false };
  }

  private async loadEvents(): Promise<ClawzEvent[]> {
    await this.ensureDirs();
    const events = await readJsonFile<ClawzEvent[]>(this.eventsPath);
    return events ?? [];
  }

  private async loadDeploymentManifest(): Promise<DeploymentManifestFile | undefined> {
    return readJsonFile<DeploymentManifestFile>(this.deploymentManifestPath);
  }

  private async loadWitnessPlan(manifest?: DeploymentManifestFile): Promise<WitnessPlanFile | undefined> {
    const candidates = [
      typeof manifest?.witnessPlanPath === "string" ? manifest.witnessPlanPath : undefined,
      this.deploymentWitnessPlanPath,
      this.legacyWitnessPlanPath
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
      const plan = await readJsonFile<WitnessPlanFile>(candidate);
      if (plan) {
        return plan;
      }
    }

    return undefined;
  }

  private async loadLiveFlowReport(): Promise<LiveSessionTurnFlowReportFile | undefined> {
    return readJsonFile<LiveSessionTurnFlowReportFile>(this.liveFlowReportPath);
  }

  private async loadLiveFlowStatus(): Promise<LiveSessionTurnFlowStatusFile | undefined> {
    await this.ensureDirs();
    return readJsonFile<LiveSessionTurnFlowStatusFile>(this.liveFlowStatusPath);
  }

  private async saveLiveFlowStatus(status: LiveSessionTurnFlowStatusFile) {
    await this.ensureDirs();
    await writeJsonFile(this.liveFlowStatusPath, status);
  }

  private async loadSponsorQueueFile(): Promise<SponsorQueueFile> {
    await this.ensureDirs();
    const queue = await readJsonFile<SponsorQueueFile>(this.sponsorQueuePath);
    if (queue?.jobs) {
      return queue;
    }

    const fallback = buildDefaultSponsorQueue();
    await this.saveSponsorQueueFile(fallback);
    return fallback;
  }

  private async saveSponsorQueueFile(queue: SponsorQueueFile) {
    await this.ensureDirs();
    await writeJsonFile(this.sponsorQueuePath, queue);
  }

  private async loadHireRequestFile(): Promise<HireRequestFile> {
    await this.ensureDirs();
    const file = await readJsonFile<HireRequestFile>(this.hireRequestPath);
    if (file?.requests) {
      return {
        ...file,
        requests: retainHireRequests(file.requests),
        jobActivityStatsBySessionId: file.jobActivityStatsBySessionId ?? {}
      };
    }

    const fallback = buildDefaultHireRequestFile();
    await this.saveHireRequestFile(fallback);
    return fallback;
  }

  private async saveHireRequestFile(file: HireRequestFile) {
    await this.ensureDirs();
    await writeJsonFile(this.hireRequestPath, {
      ...file,
      requests: retainHireRequests(file.requests),
      jobActivityStatsBySessionId: file.jobActivityStatsBySessionId ?? {}
    });
  }

  private async loadJobCollaborationFile(): Promise<JobCollaborationFile> {
    await this.ensureDirs();
    const file = await readJsonFile<JobCollaborationFile>(this.jobCollaborationPath);
    if (file?.stages && file?.messages) {
      return {
        stages: file.stages.filter((stage) => stage.stageId && stage.requestId && stage.agentId && stage.sessionId),
        messages: file.messages.filter((message) => message.messageId && message.requestId && message.agentId && message.sessionId)
      };
    }

    const fallback = buildDefaultJobCollaborationFile();
    await this.saveJobCollaborationFile(fallback);
    return fallback;
  }

  private async saveJobCollaborationFile(file: JobCollaborationFile) {
    await this.ensureDirs();
    await writeJsonFile(this.jobCollaborationPath, file);
  }

  private async loadPaymentLedgerFile(): Promise<PaymentLedgerFile> {
    await this.ensureDirs();
    const file = await readJsonFile<PaymentLedgerFile>(this.paymentLedgerPath);
    if (file?.entries) {
      return {
        entries: file.entries.filter((entry) => entry.ledgerId && entry.agentId && entry.sessionId)
      };
    }

    const fallback = buildDefaultPaymentLedgerFile();
    await this.savePaymentLedgerFile(fallback);
    return fallback;
  }

  private async savePaymentLedgerFile(file: PaymentLedgerFile) {
    await this.ensureDirs();
    await writeJsonFile(this.paymentLedgerPath, file);
  }

  private async loadExecutionIntentFile(): Promise<ExecutionIntentFile> {
    await this.ensureDirs();
    const file = await readJsonFile<ExecutionIntentFile>(this.executionIntentPath);
    if (file?.intents) {
      return {
        intents: file.intents.filter((intent) => intent.intentId && intent.agentId && intent.sessionId)
      };
    }

    const fallback = buildDefaultExecutionIntentFile();
    await this.saveExecutionIntentFile(fallback);
    return fallback;
  }

  private async saveExecutionIntentFile(file: ExecutionIntentFile) {
    await this.ensureDirs();
    await writeJsonFile(this.executionIntentPath, file);
  }

  private async loadProcurementIntentFile(): Promise<ProcurementIntentFile> {
    await this.ensureDirs();
    const file = await readJsonFile<ProcurementIntentFile>(this.procurementIntentPath);
    if (file?.intents) {
      return {
        intents: file.intents.filter((intent) => intent.intentId && intent.taskPrompt && intent.requesterContact)
      };
    }

    const fallback = buildDefaultProcurementIntentFile();
    await this.saveProcurementIntentFile(fallback);
    return fallback;
  }

  private async saveProcurementIntentFile(file: ProcurementIntentFile) {
    await this.ensureDirs();
    await writeJsonFile(this.procurementIntentPath, file);
  }

  private async loadSocialAnchorQueueFile(): Promise<SocialAnchorQueueFile> {
    await this.ensureDirs();
    const file = await readJsonFile<SocialAnchorQueueFile>(this.socialAnchorQueuePath);
    if (file?.items && file?.batches) {
      return {
        items: file.items.map((item) =>
          normalizeSocialAnchorCandidate({
            ...item,
            anchorMode: item.anchorMode ?? "shared-batched"
          })
        ),
        batches: file.batches.map((batch) =>
          normalizeSocialAnchorBatch({
            ...batch,
            sessionId: batch.sessionId ?? "",
            agentId: batch.agentId ?? "",
            anchorMode: batch.anchorMode ?? "shared-batched"
          })
        ),
        ...(file.lastError ? { lastError: file.lastError } : {}),
        ...(file.lastErrorAtIso ? { lastErrorAtIso: file.lastErrorAtIso } : {}),
        ...(file.lastErrorContext ? { lastErrorContext: file.lastErrorContext } : {})
      };
    }

    const fallback = buildDefaultSocialAnchorQueueFile();
    await this.saveSocialAnchorQueueFile(fallback);
    return fallback;
  }

  private async saveSocialAnchorQueueFile(file: SocialAnchorQueueFile) {
    await this.ensureDirs();
    await writeJsonFile(this.socialAnchorQueuePath, file);
  }

  private async loadAgentBoardFile(): Promise<AgentBoardFile> {
    await this.ensureDirs();
    const file = await readJsonFile<AgentBoardFile>(this.agentBoardPath);
    if (file?.messages) {
      return {
        messages: file.messages.filter((message) => message.messageId && message.threadId && message.agentId)
      };
    }

    const fallback = buildDefaultAgentBoardFile();
    await this.saveAgentBoardFile(fallback);
    return fallback;
  }

  private async saveAgentBoardFile(file: AgentBoardFile) {
    await this.ensureDirs();
    await writeJsonFile(this.agentBoardPath, file);
  }

  private async withAgentBoardMutationLock<T>(mutation: () => Promise<T>): Promise<T> {
    const previous = this.agentBoardMutationLock;
    let release: () => void = () => {};
    this.agentBoardMutationLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await mutation();
    } finally {
      release();
    }
  }

  private async loadRuntimeHeartbeatFile(): Promise<AgentRuntimeHeartbeatFile> {
    await this.ensureDirs();
    const file = await readJsonFile<AgentRuntimeHeartbeatFile>(this.runtimeHeartbeatPath);
    if (file?.heartbeats) {
      return {
        heartbeats: file.heartbeats.filter((record) => record.agentId && record.sessionId)
      };
    }

    const fallback = buildDefaultRuntimeHeartbeatFile();
    await this.saveRuntimeHeartbeatFile(fallback);
    return fallback;
  }

  private async saveRuntimeHeartbeatFile(file: AgentRuntimeHeartbeatFile) {
    await this.ensureDirs();
    await writeJsonFile(this.runtimeHeartbeatPath, file);
  }

  private configuredSocialAnchorContractAddress(deployment: Pick<ZekoDeploymentState, "contracts">) {
    return (
      deployment.contracts.find((contract) => contract.label === "SocialAnchorKernel" && contract.address)?.address ??
      (typeof process.env.CLAWZ_SOCIAL_ANCHOR_PUBLIC_KEY === "string" &&
      process.env.CLAWZ_SOCIAL_ANCHOR_PUBLIC_KEY.trim().length > 0
        ? process.env.CLAWZ_SOCIAL_ANCHOR_PUBLIC_KEY.trim()
        : undefined)
    );
  }

  private socialAnchorSubmitterConfigured(): boolean {
    return (
      (typeof process.env.CLAWZ_SOCIAL_ANCHOR_SUBMITTER_PRIVATE_KEY === "string" &&
        process.env.CLAWZ_SOCIAL_ANCHOR_SUBMITTER_PRIVATE_KEY.trim().length > 0) ||
      (typeof process.env.DEPLOYER_PRIVATE_KEY === "string" && process.env.DEPLOYER_PRIVATE_KEY.trim().length > 0)
    );
  }

  private socialAnchorSignerConfigured(): boolean {
    return (
      (typeof process.env.SOCIAL_ANCHOR_PRIVATE_KEY === "string" && process.env.SOCIAL_ANCHOR_PRIVATE_KEY.trim().length > 0) ||
      (typeof process.env.CLAWZ_SOCIAL_ANCHOR_PRIVATE_KEY === "string" &&
        process.env.CLAWZ_SOCIAL_ANCHOR_PRIVATE_KEY.trim().length > 0)
    );
  }

  private canAutoAnchorSharedBatches(deployment: Pick<ZekoDeploymentState, "contracts">): boolean {
    return Boolean(
      this.configuredSocialAnchorContractAddress(deployment) &&
        this.socialAnchorSubmitterConfigured() &&
        this.socialAnchorSignerConfigured()
    );
  }

  private socialAnchorRetryConfig() {
    const parsePositiveIntegerEnv = (value: string | undefined, maximum: number) => {
      if (typeof value !== "string" || value.trim().length === 0) {
        return undefined;
      }
      const parsed = Number.parseInt(value.trim(), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return undefined;
      }
      return Math.min(parsed, maximum);
    };
    return {
      maxAttempts: parsePositiveIntegerEnv(process.env.CLAWZ_SOCIAL_ANCHOR_MAX_SEND_ATTEMPTS, 5) ?? 3,
      retryDelayMs: parsePositiveIntegerEnv(process.env.CLAWZ_SOCIAL_ANCHOR_RETRY_DELAY_MS, 30_000) ?? 30_000,
      confirmationWaitMs: parsePositiveIntegerEnv(process.env.CLAWZ_SOCIAL_ANCHOR_CONFIRMATION_WAIT_MS, 60_000) ?? 10_000
    };
  }

  private async submitSocialAnchorBatchToZeko(options: {
    batchId: string;
    sessionId: string;
    rootDigestSha256: string;
    deployment: Pick<ZekoDeploymentState, "networkId" | "graphqlEndpoint" | "archiveEndpoint" | "contracts">;
  }) {
    const retryConfig = this.socialAnchorRetryConfig();
    const submitterPrivateKey =
      (typeof process.env.CLAWZ_SOCIAL_ANCHOR_SUBMITTER_PRIVATE_KEY === "string" &&
      process.env.CLAWZ_SOCIAL_ANCHOR_SUBMITTER_PRIVATE_KEY.trim().length > 0
        ? process.env.CLAWZ_SOCIAL_ANCHOR_SUBMITTER_PRIVATE_KEY.trim()
        : undefined) ??
      (typeof process.env.DEPLOYER_PRIVATE_KEY === "string" && process.env.DEPLOYER_PRIVATE_KEY.trim().length > 0
        ? process.env.DEPLOYER_PRIVATE_KEY.trim()
        : undefined);
    if (!submitterPrivateKey) {
      throw new Error(
        "Set CLAWZ_SOCIAL_ANCHOR_SUBMITTER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY to anchor social batches on Zeko."
      );
    }

    const socialAnchorPrivateKey =
      (typeof process.env.SOCIAL_ANCHOR_PRIVATE_KEY === "string" && process.env.SOCIAL_ANCHOR_PRIVATE_KEY.trim().length > 0
        ? process.env.SOCIAL_ANCHOR_PRIVATE_KEY.trim()
        : undefined) ??
      (typeof process.env.CLAWZ_SOCIAL_ANCHOR_PRIVATE_KEY === "string" &&
      process.env.CLAWZ_SOCIAL_ANCHOR_PRIVATE_KEY.trim().length > 0
        ? process.env.CLAWZ_SOCIAL_ANCHOR_PRIVATE_KEY.trim()
        : undefined);
    if (!socialAnchorPrivateKey) {
      throw new Error("Set SOCIAL_ANCHOR_PRIVATE_KEY to anchor social batches on Zeko.");
    }

    return submitSocialAnchorBatchOnZeko({
      batchId: options.batchId,
      sessionId: options.sessionId,
      rootDigestSha256: options.rootDigestSha256,
      submitterPrivateKey,
      socialAnchorPrivateKey,
      ...(this.configuredSocialAnchorContractAddress(options.deployment)
        ? { socialAnchorPublicKey: this.configuredSocialAnchorContractAddress(options.deployment)! }
        : {}),
      networkId: options.deployment.networkId,
      mina: options.deployment.graphqlEndpoint,
      archive: options.deployment.archiveEndpoint,
      ...(typeof process.env.TX_FEE === "string" && process.env.TX_FEE.trim().length > 0
        ? { fee: process.env.TX_FEE.trim() }
        : {}),
      maxAttempts: retryConfig.maxAttempts,
      retryDelayMs: retryConfig.retryDelayMs,
      confirmationWaitMs: retryConfig.confirmationWaitMs
    });
  }

  private async observeSocialAnchorKernel(
    deployment: Pick<ZekoDeploymentState, "networkId" | "graphqlEndpoint" | "archiveEndpoint" | "contracts">
  ) {
    const socialAnchorPublicKey = this.configuredSocialAnchorContractAddress(deployment);
    if (!socialAnchorPublicKey) {
      return undefined;
    }

    return readSocialAnchorKernelStateOnZeko({
      socialAnchorPublicKey,
      networkId: deployment.networkId,
      mina: deployment.graphqlEndpoint,
      archive: deployment.archiveEndpoint
    });
  }

  private async recordSocialAnchorQueueError(error: unknown, context: string): Promise<void> {
    const queue = await this.loadSocialAnchorQueueFile();
    await this.saveSocialAnchorQueueFile({
      ...queue,
      lastError: socialAnchorErrorMessage(error).slice(0, 500),
      lastErrorAtIso: new Date().toISOString(),
      lastErrorContext: context
    });
  }

  private clearSocialAnchorQueueError(queue: SocialAnchorQueueFile): SocialAnchorQueueFile {
    const { lastError: _lastError, lastErrorAtIso: _lastErrorAtIso, lastErrorContext: _lastErrorContext, ...rest } = queue;
    return rest;
  }

  private async saveEvents(events: ClawzEvent[]) {
    await this.ensureDirs();
    await writeJsonFile(this.eventsPath, events);
  }

  private async appendEvent(type: ClawzEvent["type"], payload: Record<string, unknown>, occurredAtIso = new Date().toISOString()) {
    const events = await this.loadEvents();
    const nextEvent: ClawzEvent = {
      id: `evt_${String(events.length + 1).padStart(4, "0")}`,
      type,
      occurredAtIso,
      payload
    };
    events.push(nextEvent);
    await this.saveEvents(events);
    return nextEvent;
  }

  private applyFocusedSession(
    state: ConsolePersistenceState,
    sessionId: string,
    trustModeId = state.activeMode
  ): ConsolePersistenceState {
    return {
      ...state,
      currentSessionId: sessionId,
      activeMode: trustModeId,
      wallet: {
        ...state.wallet,
        trustModeId
      }
    };
  }

  private profileForSession(state: ConsolePersistenceState, sessionId: string, trustModeId = state.activeMode): AgentProfileState {
    return this.sanitizeProfileInput(
      trustModeId,
      state.profilesBySession[sessionId] ?? {},
      buildDefaultProfile(trustModeId),
      { trustVerifiedMissionAuthInput: true }
    );
  }

  private agentIdForSession(state: ConsolePersistenceState, sessionId: string, trustModeId = state.activeMode): string {
    return (
      state.agentIdsBySession[sessionId] ??
      buildStableAgentId(this.profileForSession(state, sessionId, trustModeId).agentName, sessionId)
    );
  }

  private buildAgentRuntimeHeartbeatState(input: {
    state: ConsolePersistenceState;
    sessionId: string;
    trustModeId?: TrustModeId;
    record?: AgentRuntimeHeartbeatRecord;
  }, checkedAtIso = new Date().toISOString()): AgentRuntimeHeartbeatState {
    const agentId = this.agentIdForSession(input.state, input.sessionId, input.trustModeId ?? input.state.activeMode);
    const record = input.record;
    if (!record) {
      return {
        agentId,
        sessionId: input.sessionId,
        status: "waiting",
        checkedAtIso,
        ttlSeconds: AGENT_RUNTIME_HEARTBEAT_DEFAULT_TTL_SECONDS,
        reason: "No heartbeat received yet."
      };
    }

    const ttlSeconds = Math.max(
      AGENT_RUNTIME_HEARTBEAT_MIN_TTL_SECONDS,
      Math.min(record.ttlSeconds, AGENT_RUNTIME_HEARTBEAT_MAX_TTL_SECONDS)
    );
    const heartbeatMs = Date.parse(record.receivedAtIso);
    const staleAtMs = Number.isFinite(heartbeatMs)
      ? heartbeatMs + ttlSeconds * 1000
      : Date.parse(checkedAtIso);
    const staleAtIso = new Date(staleAtMs).toISOString();
    const isStale = record.status === "live" && staleAtMs <= Date.parse(checkedAtIso);
    const status: AgentRuntimeStatus =
      record.status === "offline" ? "offline" : isStale || record.status === "waiting" ? "waiting" : "live";
    const reason =
      status === "offline"
        ? record.note ?? "Agent reported offline."
        : isStale
          ? "Heartbeat stale."
          : status === "waiting"
            ? record.note ?? "Agent is waiting for its next live heartbeat."
            : record.note ?? "Recent heartbeat received.";

    return {
      agentId,
      sessionId: input.sessionId,
      status,
      checkedAtIso,
      ttlSeconds,
      lastHeartbeatAtIso: record.receivedAtIso,
      staleAtIso,
      reason,
      ...(record.note ? { note: record.note } : {}),
      ...(record.relayAgentProtocolVersion ? { relayAgentProtocolVersion: record.relayAgentProtocolVersion } : {}),
      ...(record.relayAgentBuild ? { relayAgentBuild: record.relayAgentBuild } : {}),
      ...(record.relayAgentFeatures?.length ? { relayAgentFeatures: record.relayAgentFeatures } : {}),
      ...(record.relayAgentWorkerRoutes ? { relayAgentWorkerRoutes: record.relayAgentWorkerRoutes } : {}),
      ...(record.relayAgentWorkerWarnings?.length ? { relayAgentWorkerWarnings: record.relayAgentWorkerWarnings } : {}),
      ...(record.relayAgentWorkerTiming ? { relayAgentWorkerTiming: record.relayAgentWorkerTiming } : {}),
      ...(record.paidExecutionProbe ? { paidExecutionProbe: record.paidExecutionProbe } : {})
    };
  }

  private ownershipRecordForSession(state: ConsolePersistenceState, sessionId: string): SessionOwnershipRecord {
    return state.ownershipBySession[sessionId] ?? buildDefaultOwnershipRecord(true);
  }

  private ownershipForSession(state: ConsolePersistenceState, sessionId: string): AgentOwnershipState {
    return asPublicOwnershipState(
      this.ownershipRecordForSession(state, sessionId),
      this.profileForSession(state, sessionId).openClawUrl
    );
  }

  private resolveSessionIdFromAgentId(state: ConsolePersistenceState, agentId: string): string | undefined {
    return Object.entries(state.agentIdsBySession).find(
      ([sessionId, value]) => !state.deletedAgentRegistrationsBySession[sessionId] && value === agentId
    )?.[0];
  }

  private resolveOwnedSessionId(
    state: ConsolePersistenceState,
    options: Pick<OwnershipActionOptions, "sessionId" | "agentId">,
    fallbackSessionId = state.currentSessionId
  ): string {
    const sessionIdFromAgentId = options.agentId ? this.resolveSessionIdFromAgentId(state, options.agentId) : undefined;
    if (options.agentId && !sessionIdFromAgentId) {
      throw new Error(`Unknown agent: ${options.agentId}`);
    }

    if (options.sessionId && sessionIdFromAgentId && options.sessionId !== sessionIdFromAgentId) {
      throw new Error("The provided agentId does not match the provided sessionId.");
    }

    const sessionId = options.sessionId ?? sessionIdFromAgentId ?? fallbackSessionId;
    if (!sessionId) {
      throw new Error("Unknown agent or session.");
    }

    return sessionId;
  }

  private hasAdminAccess(state: ConsolePersistenceState, sessionId: string, adminKey?: string) {
    const record = state.adminKeysBySession[sessionId];
    if (!record) {
      return true;
    }

    const normalizedAdminKey = typeof adminKey === "string" ? adminKey.trim() : "";
    return normalizedAdminKey.length > 0 && timingSafeEqualHex(record.keyHash, adminKeyHash(normalizedAdminKey));
  }

  private buildAdminAccessState(
    state: ConsolePersistenceState,
    sessionId: string,
    adminKey?: string,
    issuedAdminKey?: string
  ): ConsoleStateResponse["adminAccess"] {
    const record = state.adminKeysBySession[sessionId];
    const normalizedAdminKey = typeof adminKey === "string" ? adminKey.trim() : "";
    const hasAdminAccess =
      !record ||
      (normalizedAdminKey.length > 0 && timingSafeEqualHex(record.keyHash, adminKeyHash(normalizedAdminKey)));

    return {
      requiresAdminKey: Boolean(record),
      hasAdminAccess,
      ...(record?.keyHint ? { keyHint: record.keyHint } : {}),
      ...(issuedAdminKey ? { issuedAdminKey } : {})
    };
  }

  private buildIngressAccessState(
    state: ConsolePersistenceState,
    sessionId: string,
    issuedIngressToken?: string,
    issuedSigningSecret?: string
  ): NonNullable<ConsoleStateResponse["ingressAccess"]> {
    const record = state.ingressSecretsBySession[sessionId];
    return {
      hasIngressToken: Boolean(record),
      hasSigningSecret: Boolean(record?.signingSecret),
      ...(record?.serviceKey ? { serviceKey: record.serviceKey } : {}),
      ...(record?.tokenHint ? { tokenHint: record.tokenHint } : {}),
      ...(record?.signingSecretHint ? { signingSecretHint: record.signingSecretHint } : {}),
      ...(issuedIngressToken ? { issuedIngressToken } : {}),
      ...(issuedSigningSecret ? { issuedSigningSecret } : {})
    };
  }

  private assertAdminAccess(state: ConsolePersistenceState, sessionId: string, adminKey?: string) {
    const record = state.adminKeysBySession[sessionId];
    if (!record) {
      return;
    }

    if (!adminKey?.trim()) {
      throw new Error("Admin key required to manage this registered agent.");
    }
    if (!this.hasAdminAccess(state, sessionId, adminKey)) {
      throw new Error("Admin key was rejected for this agent.");
    }
  }

  private async assertAgentProfileIsValid(
    state: ConsolePersistenceState,
    profile: AgentProfileState,
    sessionIdToIgnore?: string
  ) {
    assertNoBlockedPublicTerms("Public agent profile", [
      profile.agentName,
      profile.representedPrincipal,
      profile.headline,
      serviceKeySlug(profile.agentName),
      profile.openClawUrl,
      ...agentMarketplaceTagValues(profile.marketplaceTags)
    ]);

    if (profile.openClawUrl.trim().length > 0) {
      const normalizedPublicClawzUrl = this.validatePublicClawzUrl(profile.openClawUrl);
      for (const [knownSessionId, knownProfile] of Object.entries(state.profilesBySession)) {
        if (knownSessionId === sessionIdToIgnore || knownProfile.openClawUrl.trim().length === 0) {
          continue;
        }
        let normalizedKnownUrl: string;
        try {
          normalizedKnownUrl = normalizeComparableUrl(knownProfile.openClawUrl);
        } catch (error) {
          continue;
        }
        if (normalizedKnownUrl === normalizedPublicClawzUrl) {
          const existingAgentId = state.agentIdsBySession[knownSessionId] ?? knownSessionId;
          const ownership = this.ownershipRecordForSession(state, knownSessionId);
          throw new DuplicatePublicClawzUrlError(
            ownership.status === "verified"
              ? "That PublicClawz agent URL is already registered and ownership has already been verified."
              : "That PublicClawz agent URL is already registered. Verify control of the existing agent record to reclaim it.",
            existingAgentId,
            ownership.status !== "verified"
          );
        }
      }
    }

    if (profile.payoutWallets.base && !looksLikeEvmAddress(profile.payoutWallets.base)) {
      throw new Error("Base payout wallet must be a valid EVM address.");
    }
    if (profile.payoutWallets.ethereum && !looksLikeEvmAddress(profile.payoutWallets.ethereum)) {
      throw new Error("Ethereum payout wallet must be a valid EVM address.");
    }
    if (profile.payoutWallets.zeko && !looksLikeZekoAddress(profile.payoutWallets.zeko)) {
      throw new Error("Zeko payout wallet must look like a valid Mina address.");
    }
    if (profile.paymentProfile.enabled) {
      const defaultRail = profile.paymentProfile.defaultRail ?? profile.paymentProfile.supportedRails[0] ?? "base-usdc";
      const requiredWallet =
        defaultRail === "ethereum-usdc"
          ? profile.payoutWallets.ethereum?.trim()
          : profile.payoutWallets.base?.trim();
      if (!requiredWallet) {
        throw new Error(
          defaultRail === "ethereum-usdc"
            ? "Ethereum payout wallet is required when Open for work is on."
            : "Base payout wallet is required when Open for work is on."
        );
      }

      if (profile.paymentProfile.pricingMode === "fixed-exact") {
        if (!profile.paymentProfile.fixedAmountUsd?.trim()) {
          throw new Error("Fixed price is required when Open for work is on.");
        }
        assertUsdAmount(profile.paymentProfile.fixedAmountUsd, "Fixed price");
      } else if (profile.paymentProfile.pricingMode === "quote-required") {
        if (profile.paymentProfile.referencePriceUsd?.trim()) {
          assertUsdAmount(profile.paymentProfile.referencePriceUsd, "Reference price");
        }
      }
    }

    if (profile.paymentProfile.baseFacilitatorUrl) {
      this.validatePublicHttpsUrl(profile.paymentProfile.baseFacilitatorUrl, "Base facilitator URL");
    }
    if (profile.paymentProfile.ethereumFacilitatorUrl) {
      this.validatePublicHttpsUrl(profile.paymentProfile.ethereumFacilitatorUrl, "Ethereum facilitator URL");
    }
    if (profile.paymentProfile.baseEscrowContract && !looksLikeEvmAddress(profile.paymentProfile.baseEscrowContract)) {
      throw new Error("Base escrow contract must be a valid EVM address.");
    }
    if (
      profile.paymentProfile.ethereumEscrowContract &&
      !looksLikeEvmAddress(profile.paymentProfile.ethereumEscrowContract)
    ) {
      throw new Error("Ethereum escrow contract must be a valid EVM address.");
    }
    if (profile.missionAuthOverlay.authorityBaseUrl) {
      this.validateMissionAuthBaseUrl(profile.missionAuthOverlay.authorityBaseUrl);
    }
  }

  private validatePublicHttpsUrl(rawUrl: string, label: string) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch (error) {
      throw new Error(`${label} must be a valid URL.`);
    }

    if (parsed.protocol !== "https:") {
      throw new Error(`${label} must use https.`);
    }
    if (isPrivateHostname(parsed.hostname)) {
      throw new Error(`${label} must be publicly reachable.`);
    }
  }

  private validatePublicClawzUrl(rawUrl: string) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch (error) {
      throw new Error("PublicClawz agent URL must be a valid URL.");
    }

    const isProductionValidation = process.env.NODE_ENV === "production";
    const usesSecureProtocol = parsed.protocol === "https:";
    const isLocalHttp = parsed.protocol === "http:" && isPrivateHostname(parsed.hostname) && !isProductionValidation;

    if (!usesSecureProtocol && !isLocalHttp) {
      throw new Error("PublicClawz agent URL must use https in public deployments.");
    }
    if (isProductionValidation && isPrivateHostname(parsed.hostname)) {
      throw new Error("PublicClawz agent URL must be publicly reachable.");
    }
    if (isPlaceholderHostname(parsed.hostname)) {
      throw new Error("PublicClawz agent URL still looks like placeholder copy.");
    }

    return normalizeComparableUrl(parsed.toString());
  }

  private validateMissionAuthBaseUrl(rawUrl: string) {
    return normalizeHostedServiceBaseUrl(rawUrl, "Mission auth authority URL");
  }

  async checkMissionAuthOverlay(
    input: Partial<AgentProfileState["missionAuthOverlay"]> | undefined
  ): Promise<AgentProfileState["missionAuthOverlay"]> {
    const fallback = buildDefaultProfile("private").missionAuthOverlay;
    const draft = sanitizeMissionAuthOverlay(input, fallback);
    if (!draft.enabled) {
      throw new Error("Turn on the enterprise auth overlay first.");
    }
    if (!draft.authorityBaseUrl) {
      throw new Error("Add the public mission auth authority URL first.");
    }

    const authorityBaseUrl = this.validateMissionAuthBaseUrl(draft.authorityBaseUrl);
    const discoveryUrl = hostedServiceUrlFor(authorityBaseUrl, "/.well-known/agent-authorization.json");
    const discovery = await fetchJsonWithTimeout<Record<string, unknown>>(
      discoveryUrl,
      "Mission auth discovery document"
    );
    if (discovery.protocol !== "zk-mission-auth") {
      throw new Error("Mission auth discovery must advertise protocol zk-mission-auth.");
    }

    const endpoints = isRecord(discovery.endpoints) ? discovery.endpoints : {};
    const jwksUrl =
      typeof endpoints.missionAuthorityJwks === "string" && endpoints.missionAuthorityJwks.trim().length > 0
        ? endpoints.missionAuthorityJwks.trim()
        : hostedServiceUrlFor(authorityBaseUrl, "/.well-known/mission-authority-jwks.json");
    const jwks = await fetchJsonWithTimeout<Record<string, unknown>>(jwksUrl, "Mission authority JWKS");
    if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
      throw new Error("Mission authority JWKS did not include any signing keys.");
    }

    const providersUrl =
      typeof endpoints.oauthProviders === "string" && endpoints.oauthProviders.trim().length > 0
        ? endpoints.oauthProviders.trim()
        : undefined;
    let supportedProviders: string[] | undefined;
    if (providersUrl) {
      try {
        const providers = await fetchJsonWithTimeout<Record<string, unknown>>(providersUrl, "Mission auth providers");
        if (Array.isArray(providers.providers)) {
          supportedProviders = Array.from(
            new Set(
              providers.providers
                .map((provider) => {
                  if (typeof provider === "string") {
                    return provider.trim();
                  }
                  if (isRecord(provider) && typeof provider.provider === "string") {
                    return provider.provider.trim();
                  }
                  return "";
                })
                .filter((provider) => provider.length > 0)
            )
          ).slice(0, 8);
        }
      } catch (_error) {
        supportedProviders = undefined;
      }
    }

    return {
      ...draft,
      enabled: true,
      status: "verified",
      authorityBaseUrl,
      protocol: "zk-mission-auth",
      ...(typeof discovery.name === "string" && discovery.name.trim().length > 0
        ? { authorityName: discovery.name.trim().slice(0, 160) }
        : {}),
      discoveryUrl,
      jwksUrl,
      ...(providersUrl ? { providersUrl } : {}),
      ...(typeof endpoints.verifyCheckpoint === "string" && endpoints.verifyCheckpoint.trim().length > 0
        ? { verifyCheckpointUrl: endpoints.verifyCheckpoint.trim() }
        : {}),
      ...(typeof endpoints.exportBundle === "string" && endpoints.exportBundle.trim().length > 0
        ? { exportBundleUrl: endpoints.exportBundle.trim() }
        : {}),
      ...(supportedProviders && supportedProviders.length > 0 ? { supportedProviders } : {}),
      lastVerifiedAtIso: new Date().toISOString()
    };
  }

  private async validatePublicClawzAgentHealth(rawUrl: string) {
    if (process.env.CLAWZ_VALIDATE_AGENT_URLS === "false" || process.env.NODE_ENV !== "production") {
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 5000);

    try {
      const response = await fetch(rawUrl, {
        method: "GET",
        headers: {
          accept: "application/json,text/plain,*/*"
        },
        redirect: "follow",
        signal: controller.signal
      });

      if (
        !response.ok &&
        response.status !== 401 &&
        response.status !== 403 &&
        response.status !== 405
      ) {
        throw new Error(`received ${response.status}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "network request failed";
      throw new Error(`PublicClawz agent URL did not respond cleanly (${message}).`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async checkPublicClawzAgentReachability(input: {
    state: ConsolePersistenceState;
    sessionId: string;
    profile: AgentProfileState;
    trustModeId?: TrustModeId;
  }): Promise<AgentRuntimeReachabilityState> {
    const checkedAtIso = new Date().toISOString();
    const openClawUrl = input.profile.openClawUrl.trim();
    const agentId = this.agentIdForSession(input.state, input.sessionId, input.trustModeId ?? input.state.activeMode);

    if (!openClawUrl) {
      return {
        agentId,
        sessionId: input.sessionId,
        openClawUrl,
        runtimeDeliveryMode: input.profile.runtimeDelivery.mode,
        checkedAtIso,
        reachable: false,
        status: "not-configured",
        reason: "This agent has no PublicClawz URL configured."
      };
    }

    if (isRelayDeliveryProfile(input.profile)) {
      const connected = this.relayRuntimeStatusProvider?.(agentId) ?? false;
      return {
        agentId,
        sessionId: input.sessionId,
        openClawUrl,
        runtimeDeliveryMode: input.profile.runtimeDelivery.mode,
        checkedAtIso,
        reachable: connected,
        status: connected ? "online" : "offline",
        reason: connected
          ? "SantaClawz relay has an active outbound agent connection."
          : "SantaClawz relay is waiting for this agent to connect."
      };
    }

    try {
      this.validatePublicClawzUrl(openClawUrl);
    } catch (error) {
      return {
        agentId,
        sessionId: input.sessionId,
        openClawUrl,
        runtimeDeliveryMode: input.profile.runtimeDelivery.mode,
        checkedAtIso,
        reachable: false,
        status: "offline",
        reason: error instanceof Error ? error.message : "The PublicClawz URL is not valid."
      };
    }

    if (!shouldCheckAgentRuntimeReachability()) {
      return {
        agentId,
        sessionId: input.sessionId,
        openClawUrl,
        runtimeDeliveryMode: input.profile.runtimeDelivery.mode,
        checkedAtIso,
        reachable: true,
        status: "check-disabled",
        reason: "Runtime reachability checks are disabled in this environment."
      };
    }

    try {
      const response = await fetch(openClawUrl, {
        method: "GET",
        headers: {
          accept: "application/json,text/plain,*/*"
        },
        redirect: "follow",
        signal: AbortSignal.timeout(AGENT_RUNTIME_CHECK_TIMEOUT_MS)
      });
      const reachable = response.ok || response.status === 401 || response.status === 403 || response.status === 405;

      return {
        agentId,
        sessionId: input.sessionId,
        openClawUrl,
        runtimeDeliveryMode: input.profile.runtimeDelivery.mode,
        checkedAtIso,
        reachable,
        status: reachable ? "online" : "offline",
        httpStatus: response.status,
        ...(reachable
          ? { reason: response.ok ? "PublicClawz agent endpoint responded." : `PublicClawz agent endpoint responded with ${response.status}.` }
          : { reason: `PublicClawz agent endpoint returned ${response.status}.` })
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "network request failed";
      return {
        agentId,
        sessionId: input.sessionId,
        openClawUrl,
        runtimeDeliveryMode: input.profile.runtimeDelivery.mode,
        checkedAtIso,
        reachable: false,
        status: "offline",
        reason: `PublicClawz agent endpoint could not be reached (${message}).`
      };
    }
  }

  private assertAgentRuntimeReachable(availability: Pick<AgentRuntimeAvailabilityState, "reachable" | "reason">) {
    if (availability.reachable) {
      return;
    }

    throw new Error(
      `This agent appears offline. SantaClawz will not request payment or submit a hire until the PublicClawz endpoint is reachable. ${availability.reason ?? ""}`.trim()
    );
  }

  private hireIngressUrlFor(openClawUrl: string): string {
    const url = new URL(openClawUrl);
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    url.pathname = normalizedPath.endsWith("/hire")
      ? normalizedPath
      : `${normalizedPath.length > 0 ? normalizedPath : ""}/hire`;
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  private buildSignedHireIngressRequest(input: {
    ingressRecord: SessionIngressSecretRecord;
    sessionId: string;
    agentId: string;
    profile: AgentProfileState;
    requestId: string;
    submittedAtIso: string;
    taskPrompt: string;
    requesterContact: string;
    budgetMina?: string;
    marketplaceTags?: MarketplaceWorkTags;
    jobPrivacy?: SantaClawzJobPrivacyPreference;
    artifactDelivery?: SantaClawzArtifactDeliveryPreference;
    paymentAuthorization: HirePaymentAuthorization;
  }): SignedHireIngressRequest {
    const ingressUrl = isRelayDeliveryProfile(input.profile)
      ? relayDeliveryTargetForAgent(input.agentId)
      : this.hireIngressUrlFor(input.profile.openClawUrl);
    const requestType: HireIngressRequestKind = isFreeTestPricingMode(input.profile.paymentProfile.pricingMode)
      ? "free_test"
      : isQuotedPricingMode(input.profile.paymentProfile.pricingMode) &&
          input.paymentAuthorization.status === "not-required"
        ? "quote_intake"
        : "paid_execution";
    const paymentStatus = paymentStatusForHireRequest({
      requestType,
      paymentStatus: input.paymentAuthorization.status
    });
    const settledAmountUsd = requestType === "paid_execution" ? input.paymentAuthorization.amountUsd : undefined;
    assertValidSantaClawzHirePolicy({
      request_type: requestType,
      pricing_mode: input.profile.paymentProfile.pricingMode,
      payment_status: paymentStatus,
      paid_or_escrowed: requestType === "paid_execution" && input.paymentAuthorization.status !== "not-required",
      ...(settledAmountUsd ? { settled_amount_usd: settledAmountUsd } : {}),
      ...(requestType === "paid_execution" &&
      (input.paymentAuthorization.rail === "base-usdc" ||
      input.paymentAuthorization.rail === "ethereum-usdc" ||
      input.paymentAuthorization.rail === "zeko-native")
        ? { rail: input.paymentAuthorization.rail }
        : {})
    });
    const serviceKey = enrolledServiceKeyForAgent(input.ingressRecord, input.profile, input.agentId);
    assertValidSantaClawzHireServiceIdentity({
      service: serviceKey,
      service_key: serviceKey
    });
    const envelope = {
      schema_version: HIRE_REQUEST_SCHEMA_VERSION,
      request_id: input.requestId,
      agent_id: input.agentId,
      session_id: input.sessionId,
      caller_type: "human",
      service: serviceKey,
      service_key: serviceKey,
      verification_required: true,
      return_channel: "santaclawz",
      request_type: requestType,
      ...(requestType === "paid_execution" && input.paymentAuthorization.activationLane
        ? {
            activation_lane: true,
            activation_lane_id: "agent_job_pack"
          }
        : {}),
      pricing_mode: input.profile.paymentProfile.pricingMode,
      payment_status: paymentStatus,
      ...(settledAmountUsd ? { settled_amount_usd: settledAmountUsd } : {}),
      ...(requestType === "paid_execution" && input.paymentAuthorization.quoteRequestId
        ? { quote_request_id: input.paymentAuthorization.quoteRequestId }
        : {}),
      ...(requestType === "paid_execution" && input.paymentAuthorization.authorizationId
        ? { intent_id: input.paymentAuthorization.authorizationId }
        : {}),
      ...(requestType === "paid_execution" ? { execution_request_id: input.requestId } : {}),
      ...(requestType === "paid_execution" && input.paymentAuthorization.acceptedQuoteDigestSha256
        ? { accepted_quote_digest_sha256: input.paymentAuthorization.acceptedQuoteDigestSha256 }
        : {}),
      paid_or_escrowed: requestType === "paid_execution" && input.paymentAuthorization.status !== "not-required",
      payment: {
        status: paymentStatus,
        ...(requestType === "paid_execution" && input.paymentAuthorization.rail
          ? { rail: input.paymentAuthorization.rail }
          : {}),
        ...(requestType === "paid_execution" && input.paymentAuthorization.amountUsd
          ? { amount_usd: input.paymentAuthorization.amountUsd }
          : {}),
        ...(requestType === "paid_execution" && input.paymentAuthorization.authorizationId
          ? { authorization_id: input.paymentAuthorization.authorizationId }
          : {}),
        ...(requestType === "paid_execution" && input.paymentAuthorization.activationLane
          ? {
              activation_lane: true,
              activation_lane_id: "agent_job_pack"
            }
          : {}),
        ...(requestType === "paid_execution" && input.paymentAuthorization.quoteRequestId
          ? { quote_request_id: input.paymentAuthorization.quoteRequestId }
          : {}),
        ...(requestType === "paid_execution" ? { execution_request_id: input.requestId } : {}),
        ...(requestType === "paid_execution" && input.paymentAuthorization.acceptedQuoteDigestSha256
          ? { accepted_quote_digest_sha256: input.paymentAuthorization.acceptedQuoteDigestSha256 }
          : {}),
        ...(requestType === "paid_execution" && input.paymentAuthorization.settlementReference
          ? { settlement_reference: input.paymentAuthorization.settlementReference }
          : {}),
        ...(requestType === "paid_execution" && input.paymentAuthorization.paymentPayloadDigestSha256
          ? { payment_payload_digest_sha256: input.paymentAuthorization.paymentPayloadDigestSha256 }
          : {}),
        ...(requestType === "paid_execution" && input.paymentAuthorization.paymentResponseDigestSha256
          ? { payment_response_digest_sha256: input.paymentAuthorization.paymentResponseDigestSha256 }
          : {})
      },
      input: {
        title: input.taskPrompt.split(/\r?\n/)[0]?.trim().slice(0, 120) || "SantaClawz hire request",
        client_request: input.taskPrompt,
        requester_contact: input.requesterContact,
        ...(input.marketplaceTags && !marketplaceWorkTagsAreEmpty(input.marketplaceTags)
          ? {
              marketplace_tags: {
                job_tags: input.marketplaceTags.jobTags,
                capability_tags: input.marketplaceTags.capabilityTags,
                input_tags: input.marketplaceTags.inputTags,
                output_tags: input.marketplaceTags.outputTags
              }
            }
          : {}),
        ...(input.jobPrivacy ? { activity_privacy: toSnakeJobPrivacy(input.jobPrivacy) } : {}),
        ...(input.artifactDelivery
          ? {
              artifact_delivery: {
                mode: input.artifactDelivery.mode,
                ...(input.artifactDelivery.encryptionScheme
                  ? { encryption_scheme: input.artifactDelivery.encryptionScheme }
                  : {}),
                ...(input.artifactDelivery.buyerPublicKey
                  ? { buyer_public_key: input.artifactDelivery.buyerPublicKey }
                  : {}),
                ...(input.artifactDelivery.acceptedFormats?.length
                  ? { accepted_formats: input.artifactDelivery.acceptedFormats }
                  : {}),
                local_scan_required: input.artifactDelivery.localScanRequired ?? input.artifactDelivery.mode === "buyer_encrypted",
                ...(input.artifactDelivery.scanPolicy
                  ? { scan_policy: input.artifactDelivery.scanPolicy }
                  : {}),
                digest_required: input.artifactDelivery.digestRequired ?? true,
                buyer_acceptance_required:
                  input.artifactDelivery.buyerAcceptanceRequired ?? input.artifactDelivery.mode !== "platform_scanned",
                ...(input.artifactDelivery.transport ? { transport: input.artifactDelivery.transport } : {}),
                ...(input.artifactDelivery.buyerInboxUrl ? { buyer_inbox_url: input.artifactDelivery.buyerInboxUrl } : {})
              }
            }
          : {}),
        provided_inputs: [],
        requested_deliverables: [],
        ...(input.budgetMina ? { budget: input.budgetMina } : {})
      }
    };
    const body = JSON.stringify(envelope);
    const bodyDigestSha256 = sha256Hex(body);
    const signaturePayload = `${input.submittedAtIso}.${input.requestId}.${bodyDigestSha256}`;
    const signature = createHmac("sha256", input.ingressRecord.signingSecret).update(signaturePayload).digest("hex");

    return {
      ingressUrl,
      requestKind: requestType,
      body,
      bodyDigestSha256,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.ingressRecord.token}`,
        "x-santaclawz-request-id": input.requestId,
        "x-santaclawz-timestamp": input.submittedAtIso,
        "x-santaclawz-body-sha256": bodyDigestSha256,
        "x-santaclawz-signature": `v1=${signature}`
      }
    };
  }

  private parseHireIngressProtocolReturn(input: {
    responseText: string;
    requestId: string;
    requestKind: HireIngressRequestKind;
  }): HireRequestReceipt["protocolReturn"] | undefined {
    const reject = (message: string, code = "return_schema_rejected"): never => {
      throw new HireReturnValidationError(message, code);
    };
    const trimmedResponseText = input.responseText.trim();
    if (trimmedResponseText.length === 0) {
      return undefined;
    }
    if (Buffer.byteLength(input.responseText, "utf8") > HIRE_INGRESS_RETURN_MAX_BYTES) {
      reject("Public hire ingress returned a protocol response that is too large.", "return_too_large");
    }
    if (!trimmedResponseText.startsWith("{")) {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmedResponseText);
    } catch {
      reject("Public hire ingress returned invalid JSON.", "return_parse_failed");
    }
    if (!isRecord(parsed) || parsed.schema_version === undefined) {
      return undefined;
    }
    if (parsed.schema_version !== HIRE_RETURN_SCHEMA_VERSION) {
      reject("Public hire ingress returned an unsupported SantaClawz return schema.");
    }

    const returnedRequestId = assertStringValue(parsed, "request_id", "SantaClawz return package");
    if (returnedRequestId !== input.requestId) {
      reject("Public hire ingress returned a SantaClawz package for the wrong request_id.");
    }
    if (parsed.agent_private !== true) {
      reject("SantaClawz return package must set agent_private=true.");
    }

    const rawStatus = assertStringValue(parsed, "status", "SantaClawz return package");
    if (rawStatus !== "quoted" && rawStatus !== "completed" && rawStatus !== "failed") {
      reject("SantaClawz return package has an unsupported status.");
    }
    const status = rawStatus as "quoted" | "completed" | "failed";
    if (input.requestKind === "quote_intake" && status === "completed") {
      reject("Quote intake cannot return completed paid execution.");
    }
    if (input.requestKind === "paid_execution" && status === "quoted") {
      reject("Paid execution cannot return quote-only status.");
    }
    if (input.requestKind === "free_test" && status === "quoted") {
      reject("Free-test execution cannot return quote-only status.");
    }

    const digestSha256 = sha256Hex(input.responseText);
    if (status === "quoted") {
      const quote = parsed.quote;
      if (!isRecord(quote)) {
        reject("Quoted SantaClawz return package must include quote.");
      }
      const quoteRecord = quote as Record<string, unknown>;
      const amountUsd = assertStringValue(quoteRecord, "amount_usd", "SantaClawz quote");
      assertUsdAmount(amountUsd, "SantaClawz quote amount_usd");
      if (quoteRecord.currency !== "USDC") {
        reject("SantaClawz quote currency must be USDC.");
      }
      const expiresAtIso = assertStringValue(quoteRecord, "expires_at_iso", "SantaClawz quote");
      if (Number.isNaN(Date.parse(expiresAtIso))) {
        reject("SantaClawz quote expires_at_iso must be an ISO date-time.");
      }
      const summary = assertStringValue(quoteRecord, "summary", "SantaClawz quote");
      return {
        schemaVersion: HIRE_RETURN_SCHEMA_VERSION,
        status,
        digestSha256,
        quote: {
          amountUsd,
          currency: "USDC",
          expiresAtIso,
          summary
        }
      };
    }

    if (status === "completed") {
      const verifiedOutput = parsed.verified_output;
      if (!isRecord(verifiedOutput)) {
        reject("Completed SantaClawz return package must include verified_output.");
      }
      const verifiedOutputRecord = verifiedOutput as Record<string, unknown>;
      const packageHash = assertStringValue(verifiedOutputRecord, "package_hash", "SantaClawz verified_output");
      assertSha256Hex(packageHash, "SantaClawz verified_output package_hash");
      if (verifiedOutputRecord.hash_algorithm !== "sha256") {
        reject("SantaClawz verified_output hash_algorithm must be sha256.");
      }
      const verificationManifest = verifiedOutputRecord.verification_manifest;
      if (!isRecord(verificationManifest)) {
        reject("SantaClawz verified_output must include verification_manifest.");
      }
      const verificationManifestRecord = verificationManifest as Record<string, unknown>;
      assertSha256Hex(
        assertStringValue(verificationManifestRecord, "input_digest_sha256", "SantaClawz verification_manifest"),
        "SantaClawz verification_manifest input_digest_sha256"
      );
      if (!Array.isArray(verificationManifestRecord.checks_performed)) {
        reject("SantaClawz verification_manifest checks_performed must be an array.");
      }
      if (!Array.isArray(verificationManifestRecord.files_produced)) {
        reject("SantaClawz verification_manifest files_produced must be an array.");
      }
      if (!Array.isArray(verificationManifestRecord.blocked_suspicious_instructions)) {
        reject("SantaClawz verification_manifest blocked_suspicious_instructions must be an array.");
      }
      if (!Array.isArray(verifiedOutputRecord.deliverables)) {
        reject("SantaClawz verified_output deliverables must be an array.");
      }
      const checksPerformed = verificationManifestRecord.checks_performed as unknown[];
      const filesProduced = verificationManifestRecord.files_produced as unknown[];
      const deliverables = verifiedOutputRecord.deliverables as unknown[];
      const checksPerformedCount = checksPerformed.length;
      const filesProducedCount = filesProduced.length;
      const deliverableCount = deliverables.length;
      for (const [index, deliverable] of deliverables.entries()) {
        if (!isRecord(deliverable)) {
          reject(`SantaClawz verified_output deliverable ${index} must be an object.`);
        }
        const deliverableRecord = deliverable as Record<string, unknown>;
        assertStringValue(deliverableRecord, "name", `SantaClawz verified_output deliverable ${index}`);
        assertSha256Hex(
          assertStringValue(deliverableRecord, "sha256", `SantaClawz verified_output deliverable ${index}`),
          `SantaClawz verified_output deliverable ${index} sha256`
        );
      }
      const executionMode =
        typeof parsed.execution_mode === "string" && parsed.execution_mode.trim().length > 0
          ? parsed.execution_mode.trim().slice(0, 120)
          : undefined;
      const realWorkExecuted =
        typeof parsed.real_work_executed === "boolean" ? parsed.real_work_executed : undefined;
      const buyerVisible = typeof parsed.buyer_visible === "boolean" ? parsed.buyer_visible : undefined;
      const marketplaceCompletionCredit =
        typeof parsed.marketplace_completion_credit === "boolean" ? parsed.marketplace_completion_credit : undefined;
      const manifestMode =
        typeof verificationManifestRecord.mode === "string" ? verificationManifestRecord.mode.trim().toLowerCase() : "";
      const zekoAttestationIncluded =
        isRecord(verifiedOutputRecord.zeko_attestation) || isRecord(parsed.zeko_attestation_payload);
      const artifactManifestUrl =
        typeof verifiedOutputRecord.artifact_manifest_url === "string" && verifiedOutputRecord.artifact_manifest_url.trim().length > 0
          ? verifiedOutputRecord.artifact_manifest_url.trim().slice(0, 2048)
          : undefined;
      const artifactBundleDigestSha256 =
        typeof verifiedOutputRecord.artifact_bundle_digest_sha256 === "string" &&
        /^[a-f0-9]{64}$/i.test(verifiedOutputRecord.artifact_bundle_digest_sha256)
          ? verifiedOutputRecord.artifact_bundle_digest_sha256.toLowerCase()
          : undefined;
      const buyerVisibleOutputs = Array.isArray(verifiedOutputRecord.buyer_visible_outputs)
        ? verifiedOutputRecord.buyer_visible_outputs
            .filter((entry): entry is Record<string, unknown> => isRecord(entry))
            .slice(0, 10)
            .map((entry, index) => ({
              name:
                typeof entry.name === "string" && entry.name.trim().length > 0
                  ? entry.name.trim().slice(0, 240)
                  : `output-${index + 1}`,
              ...(typeof entry.content_type === "string" && entry.content_type.trim().length > 0
                ? { contentType: entry.content_type.trim().slice(0, 120) }
                : {}),
              ...(typeof entry.text === "string" && entry.text.trim().length > 0
                ? { text: entry.text.slice(0, 8000) }
                : {}),
              ...(typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/i.test(entry.sha256)
                ? { sha256: entry.sha256.toLowerCase() }
                : {})
            }))
        : undefined;
      const completionClassification: HireCompletionClassification =
        executionMode === "demo-complete" ||
        manifestMode === "demo" ||
        realWorkExecuted === false ||
        marketplaceCompletionCredit === false
          ? "demo_completion"
          : deliverableCount === 0
            ? "agent_completed_empty"
            : checksPerformedCount === 0 || filesProducedCount === 0
              ? "agent_completed_unverified"
              : "agent_completed_verified";
      return {
        schemaVersion: HIRE_RETURN_SCHEMA_VERSION,
        status,
        digestSha256,
        verifiedOutput: {
          packageHash,
          deliverableCount,
          filesProducedCount,
          checksPerformedCount,
          ...(artifactManifestUrl ? { artifactManifestUrl } : {}),
          ...(artifactBundleDigestSha256 ? { artifactBundleDigestSha256 } : {}),
          verificationManifestDigestSha256: canonicalDigest(verificationManifestRecord).sha256Hex,
          zekoAttestationIncluded,
          ...(buyerVisibleOutputs && buyerVisibleOutputs.length > 0 ? { buyerVisibleOutputs } : {})
        },
        execution: {
          runtimeStatus: "completed",
          ...(executionMode ? { executionMode } : {}),
          ...(typeof realWorkExecuted === "boolean" ? { realWorkExecuted } : {}),
          ...(typeof buyerVisible === "boolean" ? { buyerVisible } : {}),
          ...(typeof marketplaceCompletionCredit === "boolean" ? { marketplaceCompletionCredit } : {}),
          deliverableCount,
          filesProducedCount,
          checksPerformedCount,
          verificationManifestPresent: true,
          zekoAttestationIncluded,
          completionClassification
        }
      };
    }

    return {
      schemaVersion: HIRE_RETURN_SCHEMA_VERSION,
      status,
      digestSha256,
      incidentId: assertStringValue(parsed, "incident_id", "Failed SantaClawz return package")
    };
  }

  private ingressSecretRecordForSession(state: ConsolePersistenceState, sessionId: string): SessionIngressSecretRecord {
    const record = state.ingressSecretsBySession[sessionId];
    if (record?.token && record.signingSecret) {
      return record;
    }
    throw new Error(
      "This agent is missing current SantaClawz ingress credentials. Re-enroll or rotate ingress credentials before accepting public hires."
    );
  }

  private async forwardHireRequestToIngress(input: {
    ingressRecord: SessionIngressSecretRecord;
    sessionId: string;
    agentId: string;
    profile: AgentProfileState;
    requestId: string;
    submittedAtIso: string;
    taskPrompt: string;
    requesterContact: string;
    budgetMina?: string;
    jobPrivacy?: SantaClawzJobPrivacyPreference;
    artifactDelivery?: SantaClawzArtifactDeliveryPreference;
    paymentAuthorization: HirePaymentAuthorization;
  }) {
    const signedRequest = this.buildSignedHireIngressRequest(input);
    if (process.env.CLAWZ_HIRE_FORWARDING_ENABLED === "false") {
      return {
        deliveryStatus: "recorded" as const,
        deliveryReceipt: this.buildHireDeliveryReceipt({
          stage: "runtime_accepted",
          target: signedRequest.ingressUrl
        }),
        requestKind: signedRequest.requestKind,
        ingressUrl: signedRequest.ingressUrl,
        bodyDigestSha256: signedRequest.bodyDigestSha256
      };
    }

    const relayResponse = isRelayDeliveryProfile(input.profile)
      ? await this.forwardHireRequestToRelay({
          agentId: input.agentId,
          sessionId: input.sessionId,
          signedRequest
        }).catch((error: unknown) => ({
          deliveryFailed: true as const,
          deliveryError: error instanceof Error ? error.message : String(error),
          deliveryTarget: `santaclawz-relay://agent/${encodeURIComponent(input.agentId)}`,
          ...(relayTraceFromError(error) ? { relayTrace: relayTraceFromError(error) } : {})
        }))
      : undefined;

    if (relayResponse && "deliveryFailed" in relayResponse) {
      const relayError = relayResponse.deliveryError;
      const stage: HireDeliveryReceipt["stage"] = /timed out|timeout/i.test(relayError)
        ? "relay_timeout"
        : "relay_disconnected";
      return {
        requestAccepted: true as const,
        deliveryFailed: true as const,
        deliveryError: relayError,
        deliveryStatus: undefined,
        deliveryReceipt: this.buildHireDeliveryReceipt({
          stage,
          target: relayResponse.deliveryTarget,
          errorMessage: relayError
        }),
        requestKind: signedRequest.requestKind,
        ingressUrl: relayResponse.deliveryTarget,
        bodyDigestSha256: signedRequest.bodyDigestSha256,
        ...("relayTrace" in relayResponse && relayResponse.relayTrace ? { relayTrace: relayResponse.relayTrace } : {})
      };
    }

    const response = relayResponse
      ? {
          ok: relayResponse.statusCode >= 200 && relayResponse.statusCode < 300,
          status: relayResponse.statusCode,
          text: async () => relayResponse.body
        }
      : await fetch(signedRequest.ingressUrl, {
          method: "POST",
          headers: signedRequest.headers,
          body: signedRequest.body,
          signal: AbortSignal.timeout(HIRE_INGRESS_TIMEOUT_MS)
        });

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new Error(
        `Public hire ingress rejected the signed request with ${response.status}${responseText ? `: ${responseText.slice(0, 240)}` : ""}`
      );
    }
    const responseText = await response.text().catch(() => "");
    const responseBytes = Buffer.byteLength(responseText, "utf8");
    let protocolReturn: HireRequestReceipt["protocolReturn"] | undefined;
    try {
      protocolReturn = this.parseHireIngressProtocolReturn({
        responseText,
        requestId: input.requestId,
        requestKind: signedRequest.requestKind
      });
    } catch (error) {
      const validationError = error instanceof Error ? error.message : "Public hire ingress returned an invalid response.";
      if (signedRequest.requestKind !== "paid_execution") {
        throw error;
      }
      return {
        requestAccepted: true as const,
        deliveryFailed: true as const,
        deliveryError:
          `Agent runtime responded with HTTP ${response.status} (${responseBytes} bytes), but SantaClawz rejected the return: ${validationError}`,
        deliveryStatus: "return_rejected" as const,
        deliveryReceipt: this.buildHireDeliveryReceipt({
          stage: "return_rejected",
          target: relayResponse?.deliveryTarget ?? signedRequest.ingressUrl,
          ...(relayResponse?.relayMessageId ? { relayMessageId: relayResponse.relayMessageId } : {}),
          runtimeStatusCode: response.status,
          runtimeResponseBytes: responseBytes,
          ...(relayResponse?.workerStatusCode !== undefined ? { workerStatusCode: relayResponse.workerStatusCode } : {}),
          ...(relayResponse?.workerResponseBytes !== undefined ? { workerResponseBytes: relayResponse.workerResponseBytes } : {}),
          ...(relayResponse?.workerResponseDigestSha256 ? { workerResponseDigestSha256: relayResponse.workerResponseDigestSha256 } : {}),
          ...(relayResponse?.relayBodyBytes !== undefined ? { relayBodyBytes: relayResponse.relayBodyBytes } : {}),
          ...(relayResponse?.relayBodyDigestSha256 ? { relayBodyDigestSha256: relayResponse.relayBodyDigestSha256 } : {}),
          returnValidationCode: error instanceof HireReturnValidationError ? error.code : "return_schema_rejected",
          errorMessage: validationError
        }),
        requestKind: signedRequest.requestKind,
        ingressUrl: relayResponse?.deliveryTarget ?? signedRequest.ingressUrl,
        bodyDigestSha256: signedRequest.bodyDigestSha256,
        responseStatusCode: response.status,
        responseBytes,
        returnValidationError: validationError,
        returnValidationCode: error instanceof HireReturnValidationError ? error.code : "return_schema_rejected",
        ...(relayResponse?.relayTrace ? { relayTrace: relayResponse.relayTrace } : {})
      };
    }

    return {
      deliveryStatus: "forwarded" as const,
      deliveryReceipt: this.buildHireDeliveryReceipt({
        stage: protocolReturn ? "return_validated" : "runtime_responded",
        target: relayResponse?.deliveryTarget ?? signedRequest.ingressUrl,
        ...(relayResponse?.relayMessageId ? { relayMessageId: relayResponse.relayMessageId } : {}),
        runtimeStatusCode: response.status,
        runtimeResponseBytes: responseBytes,
        ...(relayResponse?.workerStatusCode !== undefined ? { workerStatusCode: relayResponse.workerStatusCode } : {}),
        ...(relayResponse?.workerResponseBytes !== undefined ? { workerResponseBytes: relayResponse.workerResponseBytes } : {}),
        ...(relayResponse?.workerResponseDigestSha256 ? { workerResponseDigestSha256: relayResponse.workerResponseDigestSha256 } : {}),
        ...(relayResponse?.relayBodyBytes !== undefined ? { relayBodyBytes: relayResponse.relayBodyBytes } : {}),
        ...(relayResponse?.relayBodyDigestSha256 ? { relayBodyDigestSha256: relayResponse.relayBodyDigestSha256 } : {})
      }),
      requestKind: signedRequest.requestKind,
      ingressUrl: relayResponse?.deliveryTarget ?? signedRequest.ingressUrl,
      bodyDigestSha256: signedRequest.bodyDigestSha256,
      responseStatusCode: response.status,
      responseBytes,
      ...(protocolReturn ? { protocolReturn } : {}),
      ...(relayResponse?.relayTrace ? { relayTrace: relayResponse.relayTrace } : {})
    };
  }

  private async forwardHireRequestToRelay(input: {
    agentId: string;
    sessionId: string;
    signedRequest: SignedHireIngressRequest;
  }) {
    if (!this.relayHireDeliveryHandler) {
      throw new Error("SantaClawz relay is not enabled on this backend.");
    }
    return this.relayHireDeliveryHandler(input);
  }

  private buildHireDeliveryReceipt(input: {
    stage: HireDeliveryReceipt["stage"];
    target: string;
    relayMessageId?: string;
    runtimeStatusCode?: number;
    runtimeResponseBytes?: number;
    workerStatusCode?: number;
    workerResponseBytes?: number;
    workerResponseDigestSha256?: string;
    relayBodyBytes?: number;
    relayBodyDigestSha256?: string;
    returnValidationCode?: string;
    errorMessage?: string;
  }): HireDeliveryReceipt {
    return {
      stage: input.stage,
      target: input.target,
      occurredAtIso: new Date().toISOString(),
      ...(input.relayMessageId ? { relayMessageId: input.relayMessageId } : {}),
      ...(typeof input.runtimeStatusCode === "number" ? { runtimeStatusCode: input.runtimeStatusCode } : {}),
      ...(typeof input.runtimeResponseBytes === "number" ? { runtimeResponseBytes: input.runtimeResponseBytes } : {}),
      ...(typeof input.workerStatusCode === "number" ? { workerStatusCode: input.workerStatusCode } : {}),
      ...(typeof input.workerResponseBytes === "number" ? { workerResponseBytes: input.workerResponseBytes } : {}),
      ...(input.workerResponseDigestSha256 ? { workerResponseDigestSha256: input.workerResponseDigestSha256 } : {}),
      ...(typeof input.relayBodyBytes === "number" ? { relayBodyBytes: input.relayBodyBytes } : {}),
      ...(input.relayBodyDigestSha256 ? { relayBodyDigestSha256: input.relayBodyDigestSha256 } : {}),
      ...(input.returnValidationCode ? { returnValidationCode: input.returnValidationCode } : {}),
      ...(input.errorMessage ? { errorMessage: input.errorMessage.slice(0, 500) } : {})
    };
  }

  private buildOwnershipChallengeRecord(openClawUrl: string, issuedAtIso: string): SessionOwnershipChallengeRecord {
    const challengeId = `och_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
    const challengeToken = createHash("sha256")
      .update(`${challengeId}:${randomUUID()}:${openClawUrl}`)
      .digest("hex");
    const challengeUrl = ownershipChallengeUrlFor(openClawUrl);
    return {
      challengeId,
      challengeToken,
      challengePath: PUBLICCLAWZ_OWNERSHIP_CHALLENGE_PATH,
      challengeUrl,
      verificationMethod: "well-known-http",
      issuedAtIso,
      expiresAtIso: new Date(Date.parse(issuedAtIso) + OWNERSHIP_CHALLENGE_TTL_MS).toISOString()
    };
  }

  private challengePayloadForSession(
    state: ConsolePersistenceState,
    sessionId: string,
    challenge: SessionOwnershipChallengeRecord
  ) {
    const profile = this.profileForSession(state, sessionId);
    return {
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      agentId: this.agentIdForSession(state, sessionId),
      sessionId,
      publicClawzUrl: profile.openClawUrl
    };
  }

  private async fetchOwnershipChallengeResponse(challenge: SessionOwnershipChallengeRecord) {
    const response = await fetch(challenge.challengeUrl, {
      method: "GET",
      headers: {
        accept: "application/json,text/plain,*/*"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8000)
    });

    const bodyText = (await response.text()).trim();
    if (!response.ok) {
      throw new Error(`Challenge endpoint returned ${response.status}.`);
    }

    if (!bodyText) {
      throw new Error("Challenge endpoint returned an empty response.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch (_error) {
      parsed = undefined;
    }

    if (isRecord(parsed)) {
      return {
        parsed,
        bodyText,
        matched:
          parsed.challengeId === challenge.challengeId &&
          parsed.challengeToken === challenge.challengeToken
      };
    }

    return {
      parsed: bodyText,
      bodyText,
      matched: bodyText === challenge.challengeToken
    };
  }

  private buildEnrollmentTicketProfile(
    options: RegisterAgentOptions,
    deployment: Pick<ZekoDeploymentState, "networkId" | "mode">
  ): RegisterAgentOptions {
    const trustModeId = options.trustModeId ?? "private";
    const fallbackProfile = buildDefaultProfile(trustModeId);
    const profile = this.coerceProfileForDeployment(this.sanitizeProfileInput(
      trustModeId,
      {
        agentName: options.agentName,
        headline: options.headline,
        ...(options.openClawUrl ? { openClawUrl: options.openClawUrl } : {}),
        ...(options.runtimeDelivery ? { runtimeDelivery: options.runtimeDelivery } : {}),
        ...(options.payoutWallets ? { payoutWallets: options.payoutWallets } : {}),
        ...(options.missionAuthOverlay ? { missionAuthOverlay: options.missionAuthOverlay } : {}),
        ...(options.paymentProfile ? { paymentProfile: options.paymentProfile } : {}),
        ...(options.marketplaceTags ? { marketplaceTags: options.marketplaceTags } : {}),
        ...(options.socialAnchorPolicy ? { socialAnchorPolicy: options.socialAnchorPolicy } : {}),
        ...(options.payoutAddress ? { payoutAddress: options.payoutAddress } : {}),
        ...(options.representedPrincipal ? { representedPrincipal: options.representedPrincipal } : {}),
        ...(options.preferredProvingLocation ? { preferredProvingLocation: options.preferredProvingLocation } : {})
      },
      fallbackProfile
    ), deployment);

    if (profile.agentName.trim().length === 0 || profile.headline.trim().length === 0) {
      throw new Error("agentName and headline are required.");
    }

    return {
      agentName: profile.agentName,
      representedPrincipal: profile.representedPrincipal,
      headline: profile.headline,
      openClawUrl: profile.openClawUrl,
      runtimeDelivery: profile.runtimeDelivery,
      payoutWallets: profile.payoutWallets,
      missionAuthOverlay: profile.missionAuthOverlay,
      paymentProfile: profile.paymentProfile,
      socialAnchorPolicy: profile.socialAnchorPolicy,
      trustModeId,
      preferredProvingLocation: profile.preferredProvingLocation
    };
  }

  private enrollmentChallengePayloadForTicket(record: EnrollmentTicketRecord, ticket: string, openClawUrl: string) {
    const challengeUrl = ownershipChallengeUrlFor(openClawUrl);
    return {
      schema_version: ENROLLMENT_TICKET_SCHEMA_VERSION,
      ticket_id: record.ticketId,
      ticket_digest_sha256: sha256Hex(ticket),
      publicclawz_url: openClawUrl,
      challenge_url: challengeUrl
    };
  }

  private async assertEnrollmentTicketChallengeServed(record: EnrollmentTicketRecord, ticket: string, openClawUrl: string) {
    const challengeUrl = ownershipChallengeUrlFor(openClawUrl);
    const response = await fetch(challengeUrl, {
      method: "GET",
      headers: {
        accept: "application/json,text/plain,*/*"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8000)
    });

    const bodyText = (await response.text()).trim();
    if (!response.ok) {
      throw new Error(`Enrollment challenge endpoint returned ${response.status}.`);
    }
    if (!bodyText) {
      throw new Error("Enrollment challenge endpoint returned an empty response.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch (_error) {
      throw new Error("Enrollment challenge endpoint did not return JSON.");
    }
    if (!isRecord(parsed)) {
      throw new Error("Enrollment challenge endpoint returned an invalid payload.");
    }

    const expected = this.enrollmentChallengePayloadForTicket(record, ticket, openClawUrl);
    const ticketDigest = assertStringValue(parsed, "ticket_digest_sha256", "Enrollment challenge");
    assertSha256Hex(ticketDigest, "Enrollment challenge ticket_digest_sha256");
    if (
      parsed.schema_version !== ENROLLMENT_TICKET_SCHEMA_VERSION ||
      parsed.ticket_id !== record.ticketId ||
      ticketDigest !== expected.ticket_digest_sha256 ||
      (parsed.publicclawz_url !== undefined && parsed.publicclawz_url !== openClawUrl)
    ) {
      throw new Error(
        `The PublicClawz endpoint did not return the expected SantaClawz enrollment ticket challenge at ${PUBLICCLAWZ_OWNERSHIP_CHALLENGE_PATH}.`
      );
    }
  }

  private assertOwnershipVerifiedForPublish(state: ConsolePersistenceState, sessionId: string) {
    const ownership = this.ownershipRecordForSession(state, sessionId);
    if (ownership.status !== "verified" || !ownership.verification) {
      throw new Error("Verify control of the PublicClawz agent URL before publishing on Zeko.");
    }
  }

  private sanitizeProfileInput(
    trustModeId: TrustModeId,
    input: AgentProfileInput,
    fallback: AgentProfileState,
    options: { trustVerifiedMissionAuthInput?: boolean } = {}
  ): AgentProfileState {
    const trustMode = TRUST_MODE_PRESETS.find((mode) => mode.id === trustModeId) ?? TRUST_MODE_PRESETS[0]!;
    const preferredProvingLocation =
      input.preferredProvingLocation && trustMode.supportedProvingLocations.includes(input.preferredProvingLocation)
        ? input.preferredProvingLocation
        : fallback.preferredProvingLocation;
    const legacyPayoutAddress = (input as { payoutAddress?: unknown }).payoutAddress;
    const inputOpenClawUrl = typeof input.openClawUrl === "string" ? input.openClawUrl.trim().slice(0, 280) : undefined;
    const openClawUrl = inputOpenClawUrl ?? fallback.openClawUrl;
    const runtimeDelivery =
      input.runtimeDelivery
        ? normalizeRuntimeDelivery(input.runtimeDelivery, fallback.runtimeDelivery)
        : inputOpenClawUrl && fallback.runtimeDelivery.mode === "santaclawz-relay"
          ? { mode: "self-hosted" as const, runtimeIngressUrl: inputOpenClawUrl }
          : normalizeRuntimeDelivery(undefined, fallback.runtimeDelivery);
    const availability =
      input.availability === "archived" ||
      input.availability === "active" ||
      input.availability === "suspended" ||
      input.availability === "blocked"
        ? input.availability
        : fallback.availability;
    const archivedAtIso =
      availability === "archived"
        ? typeof input.archivedAtIso === "string" && input.archivedAtIso.trim().length > 0
          ? input.archivedAtIso.trim().slice(0, 40)
          : fallback.archivedAtIso
        : undefined;

    return {
      agentName: typeof input.agentName === "string" ? input.agentName.trim().slice(0, 120) : fallback.agentName,
      representedPrincipal:
        typeof input.representedPrincipal === "string"
          ? input.representedPrincipal.trim().slice(0, 160)
          : fallback.representedPrincipal,
      headline: typeof input.headline === "string" ? input.headline.trim().slice(0, 280) : fallback.headline,
      openClawUrl,
      runtimeDelivery,
      availability,
      ...(archivedAtIso ? { archivedAtIso } : {}),
      payoutWallets: sanitizePayoutWallets(input.payoutWallets, fallback.payoutWallets, legacyPayoutAddress),
      missionAuthOverlay: sanitizeMissionAuthOverlay(input.missionAuthOverlay, fallback.missionAuthOverlay, {
        ...(options.trustVerifiedMissionAuthInput ? { trustVerifiedInput: true } : {})
      }),
      paymentProfile: sanitizePaymentProfile(input.paymentProfile, fallback.paymentProfile),
      marketplaceTags: sanitizeAgentMarketplaceTags(input.marketplaceTags, fallback.marketplaceTags),
      socialAnchorPolicy: sanitizeSocialAnchorPolicy(input.socialAnchorPolicy, fallback.socialAnchorPolicy),
      preferredProvingLocation
    };
  }

  private resolveSessionTrustMode(
    events: ClawzEvent[],
    sessionId: string | undefined,
    fallback: TrustModeId
  ): TrustModeId {
    if (!sessionId) {
      return fallback;
    }

    const matchingEvent = [...events]
      .reverse()
      .find((event) => {
        const payload = event.payload as Record<string, unknown>;
        return payload.sessionId === sessionId && typeof payload.trustMode === "string" && isTrustModeId(payload.trustMode);
      });

    const trustMode = matchingEvent ? (matchingEvent.payload as Record<string, unknown>).trustMode : undefined;
    return typeof trustMode === "string" && isTrustModeId(trustMode) ? trustMode : fallback;
  }

  private buildKnownSessionIds(
    state: ConsolePersistenceState,
    events: ClawzEvent[]
  ): string[] {
    const recency = new Map<string, string>();
    const remember = (sessionId: string | undefined, occurredAtIso?: string) => {
      if (!sessionId) {
        return;
      }
      if (state.deletedAgentRegistrationsBySession[sessionId]) {
        return;
      }

      const existing = recency.get(sessionId);
      if (!existing || (occurredAtIso ?? "") > existing) {
        recency.set(sessionId, occurredAtIso ?? existing ?? "");
      }
    };

    remember(state.currentSessionId);
    Object.keys(state.profilesBySession).forEach((sessionId) => remember(sessionId));
    Object.keys(state.agentIdsBySession).forEach((sessionId) => remember(sessionId));
    events.forEach((event) => {
      const payload = event.payload as Record<string, unknown>;
      remember(asString(payload.sessionId), event.occurredAtIso);
    });

    return [...recency.entries()]
      .sort((left, right) => {
        const byRecency = right[1].localeCompare(left[1]);
        if (byRecency !== 0) {
          return byRecency;
        }
        if (left[0] === state.currentSessionId) {
          return -1;
        }
        if (right[0] === state.currentSessionId) {
          return 1;
        }
        return left[0].localeCompare(right[0]);
      })
      .map(([sessionId]) => sessionId);
  }

  private resolveSessionFocus(
    state: ConsolePersistenceState,
    events: ClawzEvent[],
    liveFlowTargets: LiveFlowTargets,
    liveFlow: LiveSessionTurnFlowState,
    requestedSessionId?: string
  ): ResolvedSessionFocus {
    const knownSessionIds = this.buildKnownSessionIds(state, events);

    if (requestedSessionId) {
      if (!knownSessionIds.includes(requestedSessionId)) {
        throw new Error(`Unknown session: ${requestedSessionId}`);
      }

      return {
        sessionId: requestedSessionId,
        focusSource: "requested",
        knownSessionIds,
        trustModeId: this.resolveSessionTrustMode(events, requestedSessionId, state.activeMode)
      };
    }

    if (
      liveFlow.status !== "idle" &&
      liveFlow.jobId &&
      liveFlow.sessionId &&
      knownSessionIds.includes(liveFlow.sessionId)
    ) {
      return {
        sessionId: liveFlow.sessionId,
        focusSource: "live-flow",
        knownSessionIds,
        trustModeId: this.resolveSessionTrustMode(events, liveFlow.sessionId, state.activeMode)
      };
    }

    const indexedSessionId =
      liveFlowTargets.turns.find((target) => knownSessionIds.includes(target.sessionId))?.sessionId ?? knownSessionIds[0];
    if (indexedSessionId) {
      return {
        sessionId: indexedSessionId,
        focusSource: "latest-indexed",
        knownSessionIds,
        trustModeId: this.resolveSessionTrustMode(events, indexedSessionId, state.activeMode)
      };
    }

    return {
      sessionId: state.currentSessionId,
      focusSource: "stored-default",
      knownSessionIds: [state.currentSessionId],
      trustModeId: state.activeMode
    };
  }

  private filterEvents(events: ClawzEvent[], options: EventListOptions = {}): ClawzEvent[] {
    return events.filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      if (options.sessionId && payload.sessionId !== options.sessionId) {
        return false;
      }
      if (options.turnId && payload.turnId !== options.turnId) {
        return false;
      }
      return true;
    });
  }

  private buildPaymentLedgerState(file: PaymentLedgerFile, options: PaymentLedgerListOptions = {}): PaymentLedgerState {
    const limit = typeof options.limit === "number" && Number.isFinite(options.limit)
      ? Math.max(1, Math.min(Math.floor(options.limit), 500))
      : 100;
    const entries = file.entries
      .filter((entry) => {
        if (options.agentId && entry.agentId !== options.agentId) {
          return false;
        }
        if (options.sessionId && entry.sessionId !== options.sessionId) {
          return false;
        }
        if (options.quoteIntentId && entry.quoteIntentId !== options.quoteIntentId) {
          return false;
        }
        if (options.hireRequestId && entry.hireRequestId !== options.hireRequestId) {
          return false;
        }
        if (
          options.paymentPayloadDigestSha256 &&
          entry.paymentPayloadDigestSha256 !== options.paymentPayloadDigestSha256
        ) {
          return false;
        }
        return true;
      })
      .sort((left, right) => Date.parse(right.updatedAtIso) - Date.parse(left.updatedAtIso))
      .slice(0, limit)
      .map((entry) => ({
        ...entry,
        lifecycleStatus: this.buildPaymentLedgerLifecycleStatus(entry),
        ...(this.buildPaymentSettlementRecovery(entry)
          ? { settlementRecovery: this.buildPaymentSettlementRecovery(entry)! }
          : {})
      }));
    return {
      schemaVersion: "santaclawz-payment-ledger/1.0",
      generatedAtIso: new Date().toISOString(),
      totalLedgerEntryCount: file.entries.length,
      entries
    };
  }

  private buildPaymentLedgerLifecycleStatus(entry: PaymentLedgerEntry): NonNullable<PaymentLedgerEntry["lifecycleStatus"]> {
    const completed =
      entry.executionStatus === "completed" ||
      entry.paymentStatus === "execution_completed" ||
      (entry.paymentStatus === "settled" && entry.returnStatus === "accepted");
    const returnRejected = entry.returnStatus === "rejected" || entry.paymentStatus === "return_rejected";
    const executionFailed = entry.executionStatus === "failed" || entry.paymentStatus === "execution_failed";
    const settlementFailed = entry.paymentStatus === "settlement_failed";
    const authorized = entry.paymentStatus === "authorization_verified" || entry.paymentStatus === "payment_verified";
    const paid =
      authorized ||
      entry.paymentStatus === "settled" ||
      entry.paymentStatus === "already_settled" ||
      entry.paymentStatus === "seller_settled" ||
      entry.paymentStatus === "protocol_fee_settled" ||
      entry.paymentStatus === "partially_settled";
    const paidButNotCompleted = paid && !completed;
    if (entry.paymentStatus === "unmatched_relayer_transaction") {
      return {
        displayStatus: "unmatched_transaction",
        paidButNotCompleted,
        needsAttention: true,
        completionStatus: "not_started",
        label: "Unmatched on-chain transaction"
      };
    }
    if (returnRejected) {
      return {
        displayStatus: "return_rejected",
        paidButNotCompleted: true,
        needsAttention: true,
        completionStatus: "return_rejected",
        label: "Paid, return rejected"
      };
    }
    if (executionFailed) {
      return {
        displayStatus: "execution_failed",
        paidButNotCompleted: true,
        needsAttention: true,
        completionStatus: "failed",
        label: "Paid, execution failed"
      };
    }
    if (settlementFailed) {
      return {
        displayStatus: "settlement_failed",
        paidButNotCompleted,
        needsAttention: true,
        completionStatus: entry.executionStatus === "completed" ? "completed" : "not_started",
        label: "Settlement attempt failed"
      };
    }
    if (completed) {
      return {
        displayStatus: "paid_completed",
        paidButNotCompleted: false,
        needsAttention: false,
        completionStatus: "completed",
        label: "Paid and completed"
      };
    }
    if (authorized) {
      return {
        displayStatus: "payment_authorized",
        paidButNotCompleted: true,
        needsAttention: true,
        completionStatus: entry.executionStatus === "forwarded" ? "forwarded" : "not_started",
        label: "Payment authorized, awaiting completion"
      };
    }
    return {
      displayStatus: "paid_not_completed",
      paidButNotCompleted,
      needsAttention: paidButNotCompleted,
      completionStatus: entry.executionStatus === "forwarded" ? "forwarded" : "not_started",
      label: paidButNotCompleted ? "Paid, not completed" : "Payment recorded"
    };
  }

  private buildPaymentSettlementRecovery(entry: PaymentLedgerEntry): NonNullable<PaymentLedgerEntry["settlementRecovery"]> | undefined {
    if (entry.settlementRecovery) {
      return entry.settlementRecovery;
    }
    const settlementFailed = entry.paymentStatus === "settlement_failed";
    const authorizedWithCompletedWork =
      (entry.paymentStatus === "authorization_verified" || entry.paymentStatus === "payment_verified") &&
      entry.executionStatus === "completed" &&
      entry.returnStatus === "accepted";
    if (!settlementFailed && !authorizedWithCompletedWork) {
      return undefined;
    }
    const retryable = settlementFailed || authorizedWithCompletedWork;
    return {
      settlementRetryable: retryable,
      canRetrySettlement: retryable,
      ...(entry.errorMessage ? { settlementFailureReason: entry.errorMessage } : {}),
      nextSettlementAction: retryable ? "retry_settlement" : "manual_review",
      retryEndpoint: entry.quoteIntentId ? "/api/x402/quote-intent" : "/api/agents/:agentId/hire"
    };
  }

  async listPaymentLedger(options: PaymentLedgerListOptions = {}): Promise<PaymentLedgerState> {
    return this.buildPaymentLedgerState(await this.loadPaymentLedgerFile(), options);
  }

  async getPaymentLedgerEntry(ledgerId: string): Promise<PaymentLedgerEntry | undefined> {
    const trimmed = ledgerId.trim();
    if (!trimmed) {
      return undefined;
    }
    const entry = (await this.loadPaymentLedgerFile()).entries.find((candidate) => candidate.ledgerId === trimmed);
    return entry
      ? {
          ...entry,
          lifecycleStatus: this.buildPaymentLedgerLifecycleStatus(entry),
          ...(this.buildPaymentSettlementRecovery(entry)
            ? { settlementRecovery: this.buildPaymentSettlementRecovery(entry)! }
            : {})
        }
      : undefined;
  }

  async recordPaymentLedgerSettlement(input: PaymentLedgerSettlementInput): Promise<PaymentLedgerEntry> {
    assertUsdAmount(input.amountUsd, "Payment ledger amountUsd");
    if (input.paymentPayloadDigestSha256) {
      assertSha256Hex(input.paymentPayloadDigestSha256, "Payment ledger paymentPayloadDigestSha256");
    }
    if (input.paymentRequirementDigestSha256) {
      assertSha256Hex(input.paymentRequirementDigestSha256, "Payment ledger paymentRequirementDigestSha256");
    }
    if (input.facilitatorResponseDigestSha256) {
      assertSha256Hex(input.facilitatorResponseDigestSha256, "Payment ledger facilitatorResponseDigestSha256");
    }
    const nowIso = new Date().toISOString();
    const file = await this.loadPaymentLedgerFile();
    const transactionHashes = uniqueTransactionHashes(
      input.transactionHashes,
      input.sellerSettlementTxHash ? [input.sellerSettlementTxHash] : undefined,
      input.protocolFeeTxHash ? [input.protocolFeeTxHash] : undefined
    );
    const existingIndex = file.entries.findIndex((entry) => (
      input.paymentPayloadDigestSha256 && entry.paymentPayloadDigestSha256 === input.paymentPayloadDigestSha256
    ) || (
      input.quoteIntentId &&
      entry.quoteIntentId === input.quoteIntentId &&
      input.authorizationId &&
      entry.authorizationId === input.authorizationId
    ) || (
      input.settlementReference &&
      entry.settlementReference === input.settlementReference
    ));
    const existing = existingIndex >= 0 ? file.entries[existingIndex] : undefined;
    const sellerSettlementTxHash = input.sellerSettlementTxHash ?? existing?.sellerSettlementTxHash;
    const protocolFeeTxHash = input.protocolFeeTxHash ?? existing?.protocolFeeTxHash;
    const nextTransactionHashes = uniqueTransactionHashes(existing?.transactionHashes, transactionHashes);
    const existingPaymentStatus = input.paymentStatus ?? (nextTransactionHashes.length > 0 ? undefined : existing?.paymentStatus);
    const nextEntry: PaymentLedgerEntry = {
      ledgerId: existing?.ledgerId ?? `pay_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      createdAtIso: existing?.createdAtIso ?? nowIso,
      updatedAtIso: nowIso,
      agentId: input.agentId,
      sessionId: input.sessionId,
      ...(input.quoteIntentId ? { quoteIntentId: input.quoteIntentId } : existing?.quoteIntentId ? { quoteIntentId: existing.quoteIntentId } : {}),
      ...(existing?.hireRequestId ? { hireRequestId: existing.hireRequestId } : {}),
      ...(input.x402RequestId ? { x402RequestId: input.x402RequestId } : existing?.x402RequestId ? { x402RequestId: existing.x402RequestId } : {}),
      ...(input.resource ? { resource: input.resource } : existing?.resource ? { resource: existing.resource } : {}),
      pricingMode: input.pricingMode,
      rail: input.rail,
      networkId: input.networkId,
      assetSymbol: input.assetSymbol,
      ...(input.assetAddress ? { assetAddress: input.assetAddress } : existing?.assetAddress ? { assetAddress: existing.assetAddress } : {}),
      amountUsd: input.amountUsd,
      ...(input.sellerPayTo ? { sellerPayTo: input.sellerPayTo } : existing?.sellerPayTo ? { sellerPayTo: existing.sellerPayTo } : {}),
      ...(input.protocolFeeRecipient
        ? { protocolFeeRecipient: input.protocolFeeRecipient }
        : existing?.protocolFeeRecipient
          ? { protocolFeeRecipient: existing.protocolFeeRecipient }
          : {}),
      ...(typeof input.protocolFeeBps === "number"
        ? { protocolFeeBps: input.protocolFeeBps }
        : typeof existing?.protocolFeeBps === "number"
          ? { protocolFeeBps: existing.protocolFeeBps }
          : {}),
      ...(input.sellerNetAmountUsd
        ? { sellerNetAmountUsd: input.sellerNetAmountUsd }
        : existing?.sellerNetAmountUsd
          ? { sellerNetAmountUsd: existing.sellerNetAmountUsd }
          : {}),
      ...(input.protocolFeeAmountUsd
        ? { protocolFeeAmountUsd: input.protocolFeeAmountUsd }
        : existing?.protocolFeeAmountUsd
          ? { protocolFeeAmountUsd: existing.protocolFeeAmountUsd }
          : {}),
      ...(input.paymentPayloadDigestSha256
        ? { paymentPayloadDigestSha256: input.paymentPayloadDigestSha256 }
        : existing?.paymentPayloadDigestSha256
          ? { paymentPayloadDigestSha256: existing.paymentPayloadDigestSha256 }
          : {}),
      ...(input.paymentRequirementDigestSha256
        ? { paymentRequirementDigestSha256: input.paymentRequirementDigestSha256 }
        : existing?.paymentRequirementDigestSha256
          ? { paymentRequirementDigestSha256: existing.paymentRequirementDigestSha256 }
          : {}),
      ...(input.authorizationId
        ? { authorizationId: input.authorizationId }
        : existing?.authorizationId
          ? { authorizationId: existing.authorizationId }
          : {}),
      ...(input.settlementReference
        ? { settlementReference: input.settlementReference }
        : existing?.settlementReference
          ? { settlementReference: existing.settlementReference }
          : {}),
      ...(sellerSettlementTxHash ? { sellerSettlementTxHash } : {}),
      ...(protocolFeeTxHash ? { protocolFeeTxHash } : {}),
      transactionHashes: nextTransactionHashes,
      ...(input.facilitatorUrl ? { facilitatorUrl: input.facilitatorUrl } : existing?.facilitatorUrl ? { facilitatorUrl: existing.facilitatorUrl } : {}),
      ...(input.facilitatorResponseDigestSha256
        ? { facilitatorResponseDigestSha256: input.facilitatorResponseDigestSha256 }
        : existing?.facilitatorResponseDigestSha256
          ? { facilitatorResponseDigestSha256: existing.facilitatorResponseDigestSha256 }
          : {}),
      ...(input.facilitatorResponseSummary
        ? { facilitatorResponseSummary: input.facilitatorResponseSummary }
        : existing?.facilitatorResponseSummary
          ? { facilitatorResponseSummary: existing.facilitatorResponseSummary }
          : {}),
      paymentStatus: inferPaymentLedgerSettlementStatus({
        ...(existingPaymentStatus ? { paymentStatus: existingPaymentStatus } : {}),
        ...(sellerSettlementTxHash ? { sellerSettlementTxHash } : {}),
        ...(protocolFeeTxHash ? { protocolFeeTxHash } : {}),
        transactionHashes: nextTransactionHashes
      }),
      executionStatus: existing?.executionStatus ?? "not_started",
      returnStatus: existing?.returnStatus ?? "none",
      ...(input.errorCode ? { errorCode: input.errorCode } : existing?.errorCode ? { errorCode: existing.errorCode } : {}),
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : existing?.errorMessage ? { errorMessage: existing.errorMessage } : {}),
      ...(typeof input.settlementRetryable === "boolean"
        ? {
            settlementRecovery: {
              settlementRetryable: input.settlementRetryable,
              canRetrySettlement: input.settlementRetryable,
              ...(input.errorMessage ? { settlementFailureReason: input.errorMessage } : {}),
              nextSettlementAction: input.settlementRetryable ? "retry_settlement" : "manual_review",
              retryEndpoint: "/api/x402/quote-intent"
            }
          }
        : existing?.settlementRecovery
          ? { settlementRecovery: existing.settlementRecovery }
          : {})
    };
    const entries = existingIndex >= 0
      ? file.entries.map((entry, index) => index === existingIndex ? nextEntry : entry)
      : [nextEntry, ...file.entries];
    await this.savePaymentLedgerFile({ entries: entries.slice(0, 2000) });
    return nextEntry;
  }

  async reconcilePaymentLedgerSettlement(
    input: PaymentLedgerSettlementReconciliationInput
  ): Promise<PaymentLedgerEntry | undefined> {
    const file = await this.loadPaymentLedgerFile();
    const index = file.entries.findIndex((entry) => entry.ledgerId === input.ledgerId);
    if (index < 0) {
      return undefined;
    }
    const existing = file.entries[index]!;
    const transactionHashes = uniqueTransactionHashes(
      existing.transactionHashes,
      input.transactionHashes,
      input.sellerSettlementTxHash ? [input.sellerSettlementTxHash] : undefined,
      input.protocolFeeTxHash ? [input.protocolFeeTxHash] : undefined
    );
    const sellerSettlementTxHash = input.sellerSettlementTxHash ?? existing.sellerSettlementTxHash;
    const protocolFeeTxHash = input.protocolFeeTxHash ?? existing.protocolFeeTxHash;
    const {
      errorCode: _errorCode,
      errorMessage: _errorMessage,
      lifecycleStatus: _lifecycleStatus,
      settlementRecovery: _settlementRecovery,
      ...cleanExisting
    } = existing;
    const nextEntry: PaymentLedgerEntry = {
      ...cleanExisting,
      updatedAtIso: new Date().toISOString(),
      ...(input.settlementReference ? { settlementReference: input.settlementReference } : {}),
      ...(sellerSettlementTxHash ? { sellerSettlementTxHash } : {}),
      ...(protocolFeeTxHash ? { protocolFeeTxHash } : {}),
      transactionHashes,
      facilitatorResponseSummary: {
        ...(existing.facilitatorResponseSummary ?? {}),
        settlementReconciliation: {
          reconciledAtIso: new Date().toISOString(),
          reason: "onchain_usdc_transfer_match",
          ...(input.evidence ?? {})
        }
      },
      paymentStatus: inferPaymentLedgerSettlementStatus({
        ...(sellerSettlementTxHash ? { sellerSettlementTxHash } : {}),
        ...(protocolFeeTxHash ? { protocolFeeTxHash } : {}),
        transactionHashes
      })
    };
    await this.savePaymentLedgerFile({
      entries: file.entries.map((entry, entryIndex) => entryIndex === index ? nextEntry : entry)
    });
    return nextEntry;
  }

  async updatePaymentLedgerExecution(input: {
    ledgerId?: string;
    hireRequestId: string;
    executionStatus: NonNullable<PaymentLedgerEntry["executionStatus"]>;
    returnStatus?: NonNullable<PaymentLedgerEntry["returnStatus"]>;
    deliveryReceipt?: HireDeliveryReceipt;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<PaymentLedgerEntry | undefined> {
    if (!input.ledgerId) {
      return undefined;
    }
    const file = await this.loadPaymentLedgerFile();
    const index = file.entries.findIndex((entry) => entry.ledgerId === input.ledgerId);
    if (index < 0) {
      return undefined;
    }
    const existing = file.entries[index]!;
    const paymentStatus: PaymentLedgerStatus =
      input.returnStatus === "rejected"
        ? "return_rejected"
        : input.executionStatus === "completed"
          ? "execution_completed"
          : input.executionStatus === "failed"
            ? "execution_failed"
            : input.executionStatus === "forwarded"
              ? "execution_forwarded"
              : existing.paymentStatus;
    const nextEntry: PaymentLedgerEntry = {
      ...existing,
      updatedAtIso: new Date().toISOString(),
      hireRequestId: input.hireRequestId,
      executionStatus: input.executionStatus,
      ...(input.returnStatus ? { returnStatus: input.returnStatus } : {}),
      ...(input.deliveryReceipt ? { deliveryReceipt: input.deliveryReceipt } : {}),
      paymentStatus,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {})
    };
    await this.savePaymentLedgerFile({
      entries: file.entries.map((entry, entryIndex) => entryIndex === index ? nextEntry : entry)
    });
    return nextEntry;
  }

  async recordPaymentLedgerSettlementFailure(input: {
    ledgerId?: string;
    errorMessage: string;
    errorCode?: string;
    settlementRetryable: boolean;
  }): Promise<PaymentLedgerEntry | undefined> {
    if (!input.ledgerId) {
      return undefined;
    }
    const file = await this.loadPaymentLedgerFile();
    const index = file.entries.findIndex((entry) => entry.ledgerId === input.ledgerId);
    if (index < 0) {
      return undefined;
    }
    const existing = file.entries[index]!;
    const nextEntry: PaymentLedgerEntry = {
      ...existing,
      updatedAtIso: new Date().toISOString(),
      paymentStatus: "settlement_failed",
      errorCode: input.errorCode ?? existing.errorCode ?? "settlement_failed",
      errorMessage: input.errorMessage,
      settlementRecovery: {
        settlementRetryable: input.settlementRetryable,
        canRetrySettlement: input.settlementRetryable,
        settlementFailureReason: input.errorMessage,
        nextSettlementAction: input.settlementRetryable ? "retry_settlement" : "manual_review",
        retryEndpoint: existing.quoteIntentId ? "/api/x402/quote-intent" : "/api/agents/:agentId/hire"
      }
    };
    await this.savePaymentLedgerFile({
      entries: file.entries.map((entry, entryIndex) => entryIndex === index ? nextEntry : entry)
    });
    return nextEntry;
  }

  async markHireRequestPaymentSettled(input: {
    requestId: string;
    settlementReference?: string;
    sellerSettlementTxHash?: string;
    protocolFeeTxHash?: string;
    transactionHashes?: string[];
    paymentResponseDigestSha256?: string;
  }): Promise<HireRequestRecord | undefined> {
    const file = await this.loadHireRequestFile();
    const index = file.requests.findIndex((request) => request.requestId === input.requestId);
    if (index < 0) {
      return undefined;
    }
    const existing = file.requests[index]!;
    const nextPayment: HirePaymentAuthorization | undefined = existing.payment
      ? {
          ...existing.payment,
          status: "settled",
          ...(input.settlementReference ? { settlementReference: input.settlementReference } : {}),
          settlementEvents: {
            ...(existing.payment.settlementEvents ?? {}),
            ...(input.sellerSettlementTxHash ? { sellerSettlementTxHash: input.sellerSettlementTxHash } : {}),
            ...(input.protocolFeeTxHash ? { protocolFeeTxHash: input.protocolFeeTxHash } : {}),
            ...(input.transactionHashes?.length ? { transactionHashes: input.transactionHashes } : {})
          },
          ...(input.paymentResponseDigestSha256 ? { paymentResponseDigestSha256: input.paymentResponseDigestSha256 } : {})
        }
      : undefined;
    const nextRecord: HireRequestRecord = {
      ...existing,
      paymentStatus: "settled",
      ...(existing.operationalStatus
        ? {
            operationalStatus: {
              ...existing.operationalStatus,
              paymentStatus: "settled",
              settlementStatus: "settled"
            }
          }
        : {}),
      ...(nextPayment ? { payment: nextPayment } : {})
    };
    const nextRequests = file.requests.map((request, requestIndex) => requestIndex === index ? nextRecord : request);
    const nextJobActivityStatsBySessionId = { ...(file.jobActivityStatsBySessionId ?? {}) };
    delete nextJobActivityStatsBySessionId[existing.sessionId];
    await this.saveHireRequestFile({
      ...file,
      requests: nextRequests,
      jobActivityStatsBySessionId: nextJobActivityStatsBySessionId
    });
    return nextRecord;
  }

  private async ensureBootstrapped() {
    await this.ensureDirs();
    const existingEvents = await this.loadEvents();
    const state = await this.loadState();
    await this.loadSponsorQueueFile();
    await this.loadHireRequestFile();
    await this.loadPaymentLedgerFile();
    await this.loadExecutionIntentFile();
    await this.loadProcurementIntentFile();
    await this.loadAgentBoardFile();
    await this.loadRuntimeHeartbeatFile();

    if (existingEvents.length === 0) {
      await this.saveEvents(sampleEvents);
    }

    const manifests = await this.blobStore.listManifests(state.currentSessionId);
    if (manifests.length === 0) {
      const manifest = await this.blobStore.sealJson({
        scope: {
          tenantId: DEFAULT_TENANT_ID,
          workspaceId: DEFAULT_WORKSPACE_ID,
          sessionId: DEFAULT_SESSION_ID,
          turnId: DEFAULT_TURN_ID
        },
        visibility: "operator-blind",
        retentionPolicy: sampleRetentionPolicy,
        sessionId: DEFAULT_SESSION_ID,
        turnId: DEFAULT_TURN_ID,
        artifactClass: "summary",
        payload: {
          headline: "Operator-blind enterprise summary",
          insight: "One artifact persisted locally with durable key wrapping and manifest metadata.",
          controls: ["team sealed", "digest receipts", "24h artifact ttl"]
        }
      });

      await this.appendEvent("ArtifactSealed", {
        sessionId: DEFAULT_SESSION_ID,
        turnId: DEFAULT_TURN_ID,
        manifestId: manifest.manifestId,
        artifactClass: manifest.artifactClass,
        payloadDigest: manifest.payloadDigest,
        visibility: manifest.visibility
      });
    }
  }

  private normalizePrivacyExceptions(state: ConsolePersistenceState, nowIso = new Date().toISOString()): PrivacyExceptionQueueItem[] {
    let changed = false;
    const next = state.privacyExceptions.map((item) => {
      if (item.status !== "expired" && item.expiresAtIso <= nowIso) {
        changed = true;
        return {
          ...item,
          status: "expired" as const
        };
      }
      return item;
    });

    if (changed) {
      void this.saveState({
        ...state,
        privacyExceptions: next
      });
    }

    return next;
  }

  async getDeploymentState(): Promise<ZekoDeploymentState> {
    const manifest = await this.loadDeploymentManifest();
    const witnessPlan = await this.loadWitnessPlan(manifest);
    const contracts = (manifest?.results ?? []).map<ZekoContractDeployment>((result) => ({
      label: typeof result.label === "string" ? result.label : "UnknownKernel",
      status: result.status === "deployed" || result.status === "skipped" ? result.status : "unavailable",
      ...(typeof result.address === "string" && result.address.length > 0 ? { address: result.address } : {}),
      ...(typeof result.txHash === "string" && result.txHash.length > 0 ? { txHash: result.txHash } : {}),
      ...(typeof result.fundedNewAccount === "boolean" ? { fundedNewAccount: result.fundedNewAccount } : {}),
      ...(result.secretSource ? { secretSource: result.secretSource } : {})
    }));
    const hasLiveContracts = contracts.some((contract) => contract.status === "deployed" && Boolean(contract.address));
    const witnessMethods = new Set(
      (witnessPlan?.contracts ?? [])
        .map((entry) =>
          typeof entry.kernel === "string" && typeof entry.method === "string"
            ? `${entry.kernel}.${entry.method}`
            : undefined
        )
        .filter((value): value is string => Boolean(value))
    );
    const privacyGrade = this.keyBrokerRuntime.mode === "in-memory-default-export" ? "pilot-grade" : "production-grade";
    const privacyNote =
      this.keyBrokerRuntime.mode === "external-kms-backed"
        ? "ClawZ is running with an external KMS boundary for workspace keys, durable wrapped-key persistence, and sealed blob manifests. This is the preferred enterprise mode when backed by a managed KMS or HSM service."
        : this.keyBrokerRuntime.mode === "durable-local-file-backed"
          ? "ClawZ is running with durable local tenant keys, wrapped-key persistence, and sealed blob manifests by default. For regulated deployments, switch the same interface boundary to external-kms-backed mode."
          : "ClawZ is running in explicit in-memory privacy mode for isolated testing. Durable local or external KMS-backed key storage should back any real operator or testnet environment.";

    return {
      chain: "zeko",
      networkId: manifest?.networkId ?? process.env.ZEKO_NETWORK_ID ?? "testnet",
      mode: hasLiveContracts ? "testnet-live" : process.env.ZEKO_GRAPHQL ? "planned-testnet" : "local-runtime",
      graphqlEndpoint: manifest?.mina ?? process.env.ZEKO_GRAPHQL ?? "https://testnet.zeko.io/graphql",
      archiveEndpoint: manifest?.archive ?? process.env.ZEKO_ARCHIVE ?? "https://archive.testnet.zeko.io/graphql",
      ...(typeof manifest?.deployer === "string" ? { deployerPublicKey: manifest.deployer } : {}),
      ...(typeof manifest?.generatedAt === "string" ? { generatedAtIso: manifest.generatedAt } : {}),
      contracts,
      witnessPlan: {
        ...(typeof witnessPlan?.scenarioId === "string" ? { scenarioId: witnessPlan.scenarioId } : {}),
        preparedContractCalls:
          typeof manifest?.preparedContractCalls === "number"
            ? manifest.preparedContractCalls
            : (witnessPlan?.contracts?.length ?? 0),
        preparedProofCalls:
          typeof manifest?.preparedProofCalls === "number"
            ? manifest.preparedProofCalls
            : (witnessPlan?.proofs?.length ?? 0),
        liveFlowMethods: ALL_LIVE_FLOW_METHODS.filter((method) => witnessMethods.has(method))
      },
      privacyGrade,
      keyManagement: this.keyBrokerRuntime.mode,
      privacyNote
    };
  }

  async getZekoHealthState(): Promise<ZekoHealthState> {
    const [deployment, queue] = await Promise.all([this.getDeploymentState(), this.loadSocialAnchorQueueFile()]);
    const counts = socialAnchorStatusCounts(queue.items);
    const contractAddress = this.configuredSocialAnchorContractAddress(deployment);
    const contractConfigured = Boolean(contractAddress);
    const submitterConfigured = this.socialAnchorSubmitterConfigured();
    const signerConfigured = this.socialAnchorSignerConfigured();
    const confirmedBatches = queue.batches
      .filter((batch) => batch.status === "confirmed")
      .sort((left, right) => right.settledAtIso.localeCompare(left.settledAtIso));
    const activeBatches = queue.batches
      .filter((batch) => batch.status === "submitted" || batch.status === "retrying")
      .sort((left, right) => left.createdAtIso.localeCompare(right.createdAtIso));
    const alerts: string[] = [];
    const workWaiting = counts.pendingCount + counts.submittedCount + counts.retryingCount > 0;
    if (workWaiting && !contractConfigured) {
      alerts.push("SocialAnchorKernel is not configured. Set CLAWZ_SOCIAL_ANCHOR_PUBLIC_KEY after deploying the Zeko anchor contract.");
    }
    if (workWaiting && !submitterConfigured) {
      alerts.push("No Zeko submitter key is configured. Set CLAWZ_SOCIAL_ANCHOR_SUBMITTER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY.");
    }
    if (workWaiting && !signerConfigured) {
      alerts.push("No SocialAnchorKernel signer is configured. Set SOCIAL_ANCHOR_PRIVATE_KEY for the deployed kernel account.");
    }
    if (queue.lastError) {
      alerts.push(`${queue.lastErrorContext ?? "Latest social anchor error"}: ${queue.lastError}`);
    }
    if (activeBatches[0]) {
      alerts.push(
        `Batch ${activeBatches[0].batchId} is ${activeBatches[0].status} and will block new shared submissions until confirmed or retried.`
      );
    }

    let latestObservedRoot: string | undefined;
    let latestObservedDigest: string | undefined;
    let latestObservedBatchCount: string | undefined;
    let latestObservedAtIso: string | undefined;
    if (contractConfigured) {
      try {
        const observed = await this.observeSocialAnchorKernel(deployment);
        latestObservedRoot = observed?.latestBatchRoot;
        latestObservedDigest = observed?.latestBatchDigest;
        latestObservedBatchCount = observed?.anchoredBatchCount;
        latestObservedAtIso = observed?.observedAtIso;
      } catch (error) {
        alerts.push(`Unable to read SocialAnchorKernel state: ${socialAnchorErrorMessage(error)}`);
      }
    }

    return {
      chain: "zeko",
      networkId: deployment.networkId,
      mode: deployment.mode,
      generatedAtIso: new Date().toISOString(),
      socialAnchor: {
        networkId: deployment.networkId,
        graphqlEndpoint: deployment.graphqlEndpoint,
        archiveEndpoint: deployment.archiveEndpoint,
        contractConfigured,
        submitterConfigured,
        signerConfigured,
        canAutoAnchorSharedBatches: this.canAutoAnchorSharedBatches(deployment),
        ...counts,
        ...(latestObservedRoot ? { latestObservedRoot } : {}),
        ...(latestObservedDigest ? { latestObservedDigest } : {}),
        ...(latestObservedBatchCount ? { latestObservedBatchCount } : {}),
        ...(latestObservedAtIso ? { latestObservedAtIso } : {}),
        ...(confirmedBatches[0]?.rootDigestSha256 ? { latestConfirmedRootDigestSha256: confirmedBatches[0].rootDigestSha256 } : {}),
        ...(confirmedBatches[0]?.confirmedAtIso ?? confirmedBatches[0]?.settledAtIso
          ? { lastSuccessfulAnchorAtIso: confirmedBatches[0].confirmedAtIso ?? confirmedBatches[0].settledAtIso }
          : {}),
        ...(queue.lastError ? { lastError: queue.lastError } : {}),
        ...(queue.lastErrorAtIso ? { lastErrorAtIso: queue.lastErrorAtIso } : {}),
        alerts,
        recentBatches: queue.batches
          .slice()
          .sort((left, right) => right.settledAtIso.localeCompare(left.settledAtIso))
          .slice(0, 8)
      }
    };
  }

  private flowMethodsFor(flowKind: LiveFlowKind = "first-turn") {
    return LIVE_FLOW_METHODS[flowKind];
  }

  private nextLiveFlowLabel(flowKind: LiveFlowKind, completedStepLabels: string[]): string | undefined {
    return this.flowMethodsFor(flowKind)[completedStepLabels.length];
  }

  private matchesRequestedLiveFlow(
    status: LiveSessionTurnFlowStatusFile,
    options: LiveFlowRunOptions = {}
  ): boolean {
    const requestedFlowKind = options.flowKind ?? status.flowKind ?? "first-turn";

    return (
      (status.flowKind ?? "first-turn") === requestedFlowKind &&
      (!options.sessionId || status.sessionId === options.sessionId) &&
      (!options.turnId || status.turnId === options.turnId) &&
      (!options.sourceTurnId || status.sourceTurnId === options.sourceTurnId) &&
      (!options.sourceDisclosureId || status.sourceDisclosureId === options.sourceDisclosureId) &&
      (!options.abortReason || status.abortReason === options.abortReason) &&
      (!options.revocationReason || status.revocationReason === options.revocationReason) &&
      (!options.refundAmountMina || status.refundAmountMina === options.refundAmountMina)
    );
  }

  private canResumeLiveFlow(status?: LiveSessionTurnFlowStatusFile, options: LiveFlowRunOptions = {}): boolean {
    const resolvedFlowKind = options.flowKind ?? status?.flowKind ?? "first-turn";

    return Boolean(
      status &&
        status.status === "failed" &&
        this.matchesRequestedLiveFlow(status, options) &&
        status.jobId &&
        status.sessionId &&
        status.turnId &&
        status.witnessPlanPath &&
        (status.completedStepLabels?.length ?? 0) < this.flowMethodsFor(resolvedFlowKind).length
    );
  }

  private buildLiveFlowJob(
    state: ConsolePersistenceState,
    requestedAtIso: string,
    options: LiveFlowRunOptions,
    liveFlowState: LiveSessionTurnFlowState,
    trustModeId: TrustModeId
  ): LiveSessionTurnFlowStatusFile {
    const flowKind = options.flowKind ?? "first-turn";
    const trustMode = TRUST_MODE_PRESETS.find((mode) => mode.id === trustModeId) ?? TRUST_MODE_PRESETS[0]!;
    const slug = randomUUID().replace(/-/g, "").slice(0, 12);
    const baseSlot = String(Math.floor(Date.parse(requestedAtIso) / 1000));
    const totalSteps = this.flowMethodsFor(flowKind).length;
    const priorSessionId = liveFlowState.sessionId || state.currentSessionId;
    const priorTurnId = liveFlowState.turnId || DEFAULT_TURN_ID;
    const priorDisclosureId =
      liveFlowState.jobId && priorTurnId ? `${priorTurnId}:disclosure:${liveFlowState.jobId}` : undefined;
    const sessionId = options.sessionId ?? (flowKind === "first-turn" ? `session_live_${slug}` : priorSessionId);
    const turnId =
      options.turnId ??
      (flowKind === "first-turn" || flowKind === "next-turn" ? `turn_live_${slug}` : priorTurnId);
    const sourceTurnId = options.sourceTurnId ?? (flowKind === "next-turn" ? priorTurnId : undefined);
    const sourceDisclosureId =
      options.sourceDisclosureId ?? (flowKind === "revoke-disclosure" ? priorDisclosureId : undefined);

    return {
      status: "queued",
      flowKind,
      jobId: `live_flow_${slug}`,
      scenarioId: `runtime-${flowKind}-${trustMode.id}-${slug}`,
      trustModeId: trustMode.id,
      sessionId,
      turnId,
      ...(sourceTurnId ? { sourceTurnId } : {}),
      ...(sourceDisclosureId ? { sourceDisclosureId } : {}),
      ...(options.abortReason ? { abortReason: options.abortReason } : {}),
      ...(options.revocationReason ? { revocationReason: options.revocationReason } : {}),
      ...(options.refundAmountMina ? { refundAmountMina: options.refundAmountMina } : {}),
      baseSlot,
      requestedAtIso,
      completedStepLabels: [],
      totalSteps,
      attemptCount: 1,
      resumeAvailable: false,
      witnessPlanPath: this.liveFlowPlanPath,
      reportPath: this.liveFlowReportPath
    };
  }

  private buildRuntimeLiveFlowInput(
    state: ConsolePersistenceState,
    privacyExceptions: PrivacyExceptionQueueItem[],
    job: LiveSessionTurnFlowStatusFile
  ): LiveSessionTurnRuntimeInput {
    const trustModeId = job.trustModeId ?? state.activeMode;
    const trustMode = TRUST_MODE_PRESETS.find((mode) => mode.id === trustModeId) ?? TRUST_MODE_PRESETS[0]!;
    const jobId = job.jobId;
    const sessionId = job.sessionId;
    const turnId = job.turnId;
    const baseSlot = job.baseSlot;
    const flowKind = job.flowKind ?? "first-turn";

    if (!jobId || !sessionId || !turnId || !baseSlot) {
      throw new Error("Live flow job is missing required runtime identifiers.");
    }

    return {
      jobId,
      flowKind,
      ...(job.scenarioId ? { scenarioId: job.scenarioId } : {}),
      sessionId,
      turnId,
      ...(job.sourceTurnId ? { sourceTurnId: job.sourceTurnId } : {}),
      ...(job.sourceDisclosureId ? { sourceDisclosureId: job.sourceDisclosureId } : {}),
      ...(job.abortReason ? { abortReason: job.abortReason } : {}),
      ...(job.revocationReason ? { revocationReason: job.revocationReason } : {}),
      ...(job.refundAmountMina ? { refundAmountMina: job.refundAmountMina } : {}),
      tenantId: DEFAULT_TENANT_ID,
      workspaceId: DEFAULT_WORKSPACE_ID,
      walletId: state.wallet.walletId,
      walletPublicKey: state.wallet.publicKey,
      requestorKey: state.wallet.publicKey,
      workerId: `worker_${trustMode.id}_${jobId.slice(-6)}`,
      baseSlot,
      trustModeId: trustMode.id,
      trustModeMaxSpendMina: trustMode.maxSpendMina,
      sponsoredRemainingMina: state.wallet.sponsoredRemainingMina,
      requestedSpendMina: state.wallet.sponsoredRemainingMina,
      defaultArtifactVisibility: trustMode.defaultArtifactVisibility,
      operatorVisible: trustMode.operatorVisible,
      providerVisible: trustMode.providerVisible,
      proofLevel: trustMode.proofLevel,
      guardians: state.wallet.guardians,
      governancePolicy: state.wallet.governancePolicy,
      privacyExceptions
    };
  }

  async getLiveFlowState(): Promise<LiveSessionTurnFlowState> {
    const [report, status] = await Promise.all([this.loadLiveFlowReport(), this.loadLiveFlowStatus()]);
    const flowKind = status?.flowKind ?? "first-turn";
    const completedStepLabels = status?.completedStepLabels ?? (report?.steps ?? []).map((step) => step.label ?? "");
    const sanitizedCompletedStepLabels = completedStepLabels.filter((label): label is string => label.length > 0);
    const resolvedStatus = status?.status ?? (report ? "succeeded" : "idle");
    const totalSteps = status?.totalSteps ?? this.flowMethodsFor(flowKind).length;
    const resumeAvailable = status?.resumeAvailable ?? this.canResumeLiveFlow(status, { flowKind });
    const resumeFromStepLabel =
      resumeAvailable ? this.nextLiveFlowLabel(flowKind, sanitizedCompletedStepLabels) : undefined;
    const stepCount = Math.max(report?.steps?.length ?? 0, sanitizedCompletedStepLabels.length);

    return {
      flowKind,
      scenarioId: report?.scenarioId ?? "demo-enterprise-private-run",
      sessionId: status?.sessionId ?? report?.sessionId ?? DEFAULT_SESSION_ID,
      turnId: status?.turnId ?? report?.turnId ?? DEFAULT_TURN_ID,
      status: resolvedStatus,
      stepCount,
      totalSteps,
      steps: (report?.steps ?? [])
        .filter(
          (step): step is NonNullable<LiveSessionTurnFlowReportFile["steps"]>[number] &
            { label: string; contractAddress: string; txHash: string; changedSlots: number[] } =>
            typeof step.label === "string" &&
            typeof step.contractAddress === "string" &&
            typeof step.txHash === "string" &&
            Array.isArray(step.changedSlots)
        )
        .map((step) => ({
          label: step.label,
          contractAddress: step.contractAddress,
          txHash: step.txHash,
          changedSlots: step.changedSlots,
          ...(typeof step.occurredAtIso === "string" ? { occurredAtIso: step.occurredAtIso } : {})
        })),
      completedStepLabels: sanitizedCompletedStepLabels,
      ...(report?.reportType ? { reportType: report.reportType } : {}),
      ...(report?.generatedAtIso ? { generatedAtIso: report.generatedAtIso } : {}),
      ...(status?.requestedAtIso ? { requestedAtIso: status.requestedAtIso } : {}),
      ...(status?.lastStartedAtIso ? { lastStartedAtIso: status.lastStartedAtIso } : {}),
      ...(status?.lastFinishedAtIso ? { lastFinishedAtIso: status.lastFinishedAtIso } : {}),
      ...(status?.sourceTurnId ? { sourceTurnId: status.sourceTurnId } : {}),
      ...(status?.sourceDisclosureId ? { sourceDisclosureId: status.sourceDisclosureId } : {}),
      ...(status?.abortReason ? { abortReason: status.abortReason } : {}),
      ...(status?.revocationReason ? { revocationReason: status.revocationReason } : {}),
      ...(status?.refundAmountMina ? { refundAmountMina: status.refundAmountMina } : {}),
      ...(status?.currentStepLabel ? { currentStepLabel: status.currentStepLabel } : {}),
      ...(resumeFromStepLabel ? { resumeFromStepLabel } : {}),
      ...(status?.lastError ? { lastError: status.lastError } : {}),
      ...(typeof status?.attemptCount === "number" ? { attemptCount: status.attemptCount } : {}),
      ...(resumeAvailable ? { resumeAvailable } : { resumeAvailable: false }),
      ...(status?.jobId ? { jobId: status.jobId } : {}),
      ...(report || status?.reportPath ? { reportPath: status?.reportPath ?? this.liveFlowReportPath } : {}),
      ...(status?.witnessPlanPath ? { witnessPlanPath: status.witnessPlanPath } : {})
    };
  }

  async getSponsorQueueState(sessionId?: string): Promise<SponsorQueueState> {
    const queue = await this.loadSponsorQueueFile();
    return this.buildSponsorQueueState(queue, sessionId);
  }

  private buildSponsorQueueState(queue: SponsorQueueFile, sessionId?: string): SponsorQueueState {
    const visibleJobs = (sessionId ? queue.jobs.filter((job) => job.sessionId === sessionId) : queue.jobs).sort((left, right) =>
      right.requestedAtIso.localeCompare(left.requestedAtIso)
    );
    const activeJob = visibleJobs.find((job) => job.status === "running");
    const pendingCount = visibleJobs.filter((job) => job.status === "queued" || job.status === "running").length;
    const latestJob = visibleJobs[0];
    const status: SponsorQueueState["status"] = activeJob
      ? "running"
      : visibleJobs.some((job) => job.status === "queued")
        ? "queued"
        : latestJob?.status === "failed"
          ? "failed"
          : "idle";

    return {
      status,
      autoSponsorEnabled: true,
      pendingCount,
      ...(activeJob ? { activeJobId: activeJob.jobId } : {}),
      items: visibleJobs.slice(0, 8)
    };
  }

  async getSocialAnchorQueueState(
    sessionId?: string,
    options: SocialAnchorQueueStateOptions = {}
  ): Promise<SocialAnchorQueueState> {
    const queue = await this.loadSocialAnchorQueueFile();
    return this.buildSocialAnchorQueueState(queue, sessionId, options);
  }

  async getOwnedSocialAnchorQueueState(options: OwnershipActionOptions = {}): Promise<SocialAnchorQueueState> {
    const state = await this.loadState();
    const sessionId = this.resolveOwnedSessionId(state, options);
    this.assertAdminAccess(state, sessionId, options.adminKey);
    return this.getSocialAnchorQueueState(sessionId);
  }

  private buildSocialAnchorQueueState(
    queue: SocialAnchorQueueFile,
    sessionId?: string,
    options: SocialAnchorQueueStateOptions = {}
  ): SocialAnchorQueueState {
    const itemLimit = Math.max(1, Math.min(options.itemLimit ?? 16, 500));
    const batchLimit = Math.max(1, Math.min(options.batchLimit ?? 6, 100));
    const statusFilter = options.statuses?.length ? new Set(options.statuses) : undefined;
    const kindFilter = options.kinds?.length ? new Set(options.kinds) : undefined;
    const visibleItems = (sessionId ? queue.items.filter((item) => item.sessionId === sessionId) : queue.items)
      .filter((item) => !statusFilter || statusFilter.has(item.status))
      .filter((item) => !kindFilter || kindFilter.has(item.kind))
      .sort((left, right) => right.occurredAtIso.localeCompare(left.occurredAtIso));
    const visibleBatches = queue.batches
      .filter((batch) => !sessionId || visibleItems.some((item) => item.batchId === batch.batchId))
      .sort((left, right) => right.settledAtIso.localeCompare(left.settledAtIso));
    const statusCounts = socialAnchorStatusCounts(visibleItems);
    const latestConfirmedBatch = visibleBatches.find((batch) => batch.status === "confirmed");
    const latestSubmittedBatch = visibleBatches.find((batch) => batch.status === "submitted" || batch.status === "retrying");

    return {
      ...statusCounts,
      anchoredCount: statusCounts.confirmedCount,
      ...(latestConfirmedBatch?.rootDigestSha256 ? { latestRootDigestSha256: latestConfirmedBatch.rootDigestSha256 } : {}),
      ...(latestSubmittedBatch?.rootDigestSha256 ? { latestSubmittedRootDigestSha256: latestSubmittedBatch.rootDigestSha256 } : {}),
      ...(latestConfirmedBatch?.confirmedAtIso ?? latestConfirmedBatch?.settledAtIso
        ? { lastConfirmedAtIso: latestConfirmedBatch.confirmedAtIso ?? latestConfirmedBatch.settledAtIso }
        : {}),
      ...(latestConfirmedBatch?.settledAtIso ? { lastSettledAtIso: latestConfirmedBatch.settledAtIso } : {}),
      ...(queue.lastError ? { lastError: queue.lastError } : {}),
      ...(queue.lastErrorAtIso ? { lastErrorAtIso: queue.lastErrorAtIso } : {}),
      items: visibleItems.slice(0, itemLimit),
      recentBatches: visibleBatches.slice(0, batchLimit)
    };
  }

  private buildAgentBoardState(
    file: AgentBoardFile,
    state: ConsolePersistenceState,
    queue: SocialAnchorQueueFile,
    options: AgentBoardListOptions = {}
  ): AgentBoardState {
    const limit = Math.max(1, Math.min(options.limit ?? 24, 200));
    const visibleMessages = file.messages
      .filter((message) => message.visibility === "public" && message.moderationStatus === "visible")
      .filter(
        (message) =>
          !hasBlockedPublicTerm([
            message.agentName,
            message.representedPrincipal,
            message.body,
            ...message.topicTags,
            ...(message.capabilityTags ?? [])
          ])
      )
      .filter((message) => !options.agentId || message.agentId === options.agentId)
      .filter((message) => !options.threadId || message.threadId === options.threadId)
      .filter((message) => !options.topic || message.topicTags.includes(options.topic))
      .filter((message) => !options.capability || (message.capabilityTags ?? []).includes(options.capability))
      .filter((message) => !options.outputDigestSha256 || message.outputDigestSha256 === options.outputDigestSha256)
      .filter((message) => {
        const sessionId = this.resolveSessionIdFromAgentId(state, message.agentId);
        if (!sessionId) {
          return false;
        }
        const profile = this.profileForSession(state, sessionId);
        return profile.availability === "active" && !hasBlockedPublicTerm([
          profile.agentName,
          profile.representedPrincipal,
          profile.headline
        ]);
      })
      .sort((left, right) => right.createdAtIso.localeCompare(left.createdAtIso));

    const enrichedMessages = visibleMessages.slice(0, limit).map((message) => {
      const sessionId = this.resolveSessionIdFromAgentId(state, message.agentId) ?? message.sessionId;
      const profile = this.profileForSession(state, sessionId);
      const anchorCandidate = message.anchorCandidateId
        ? queue.items.find((item) => item.candidateId === message.anchorCandidateId)
        : undefined;
      const anchorBatch = anchorCandidate?.batchId
        ? queue.batches.find((batch) => batch.batchId === anchorCandidate.batchId)
        : undefined;
      const representedPrincipal = profile.representedPrincipal || message.representedPrincipal;
      const anchorStatus: SocialAnchorCandidate["status"] =
        anchorCandidate?.status ??
        (message.anchorCandidateId || message.proofIntent === "per_message"
          ? "expired_not_anchored"
          : message.anchorStatus === "aggregate_anchored" || message.anchorStatus === "not_proof_requested"
            ? message.anchorStatus
            : "not_proof_requested");
      return {
        ...message,
        agentName: profile.agentName || message.agentName,
        ...(representedPrincipal ? { representedPrincipal } : {}),
        anchorStatus,
        ...(anchorCandidate?.batchRootDigestSha256 ? { batchRootDigestSha256: anchorCandidate.batchRootDigestSha256 } : {}),
        ...(anchorBatch?.txHash ? { batchTxHash: anchorBatch.txHash } : {})
      };
    });

    const threadsById = new Map<string, AgentBoardMessage[]>();
    for (const message of visibleMessages) {
      const threadMessages = threadsById.get(message.threadId) ?? [];
      threadMessages.push(message);
      threadsById.set(message.threadId, threadMessages);
    }

    const threads = [...threadsById.entries()]
      .map<AgentBoardThread>(([threadId, threadMessages]) => {
        const sortedByTime = [...threadMessages].sort((left, right) => left.createdAtIso.localeCompare(right.createdAtIso));
        const latest = sortedByTime.at(-1)!;
        return {
          threadId,
          rootMessageId: sortedByTime[0]!.messageId,
          agentIds: Array.from(new Set(threadMessages.map((message) => message.agentId))).slice(0, 12),
          agentNames: Array.from(new Set(threadMessages.map((message) => message.agentName))).slice(0, 12),
          topicTags: Array.from(new Set(threadMessages.flatMap((message) => message.topicTags))).slice(0, 8),
          capabilityTags: Array.from(new Set(threadMessages.flatMap((message) => message.capabilityTags ?? []))).slice(0, 8),
          messageCount: threadMessages.length,
          latestMessageAtIso: latest.createdAtIso,
          latestMessageDigestSha256: latest.messageDigestSha256
        };
      })
      .sort((left, right) => right.latestMessageAtIso.localeCompare(left.latestMessageAtIso))
      .slice(0, 24);

    return {
      schemaVersion: "santaclawz-agent-board/1.0",
      generatedAtIso: new Date().toISOString(),
      totalVisibleMessages: visibleMessages.length,
      messages: enrichedMessages,
      threads
    };
  }

  async listAgentBoardMessages(options: AgentBoardListOptions = {}): Promise<AgentBoardState> {
    const [state, file, queue] = await Promise.all([
      this.loadState(),
      this.loadAgentBoardFile(),
      this.loadSocialAnchorQueueFile()
    ]);
    const sanitizedOptions: AgentBoardListOptions = {
      ...(options.agentId ? { agentId: options.agentId } : {}),
      ...(options.threadId ? { threadId: options.threadId } : {}),
      ...(typeof options.limit === "number" ? { limit: options.limit } : {})
    };
    const topic = sanitizeAgentBoardFilterTag(options.topic, AGENT_BOARD_TOPIC_MAX_LENGTH);
    if (topic) {
      sanitizedOptions.topic = topic;
    }
    const capability = sanitizeAgentBoardFilterTag(options.capability);
    if (capability) {
      sanitizedOptions.capability = capability;
    }
    if (options.outputDigestSha256 && /^[a-f0-9]{64}$/.test(options.outputDigestSha256)) {
      sanitizedOptions.outputDigestSha256 = options.outputDigestSha256;
    }
    return this.buildAgentBoardState(file, state, queue, sanitizedOptions);
  }

  async postAgentBoardMessage(options: AgentBoardPostOptions): Promise<AgentBoardPostResult> {
    return this.withAgentBoardMutationLock(() => this.postAgentBoardMessageLocked(options));
  }

  private async postAgentBoardMessageLocked(options: AgentBoardPostOptions): Promise<AgentBoardPostResult> {
    const state = await this.loadState();
    const sessionId = this.resolveOwnedSessionId(state, { agentId: options.agentId });
    if (options.authenticatedRelaySessionId) {
      if (options.authenticatedRelaySessionId !== sessionId) {
        throw new Error("Relay-authenticated agent message does not match the relay session.");
      }
    } else {
      this.assertAdminAccess(state, sessionId, options.adminKey);
    }
    const profile = this.profileForSession(state, sessionId);
    if (profile.availability !== "active") {
      throw new Error("Only active agents can post public board messages.");
    }

    const body = options.body.trim().replace(/\s+\n/g, "\n").slice(0, AGENT_BOARD_MESSAGE_MAX_LENGTH);
    if (body.length < 3) {
      throw new Error("Public agent message body is required.");
    }
    assertNoBlockedPublicTerms("Public agent message", [body]);

    const [file, socialAnchorQueue] = await Promise.all([this.loadAgentBoardFile(), this.loadSocialAnchorQueueFile()]);
    const parentMessageId = sanitizeOptionalBoardId(options.parentMessageId, "msg_");
    const parentMessage = parentMessageId
      ? file.messages.find((message) => message.messageId === parentMessageId && message.moderationStatus === "visible")
      : undefined;
    const fallbackThreadId = sanitizeOptionalBoardId(options.threadId, "thread_");
    if (parentMessageId && !parentMessage && !fallbackThreadId) {
      throw new Error("Parent public agent message was not found.");
    }

    const messageType = parentMessage ? "reply" : sanitizeAgentBoardMessageType(options.messageType);
    const threadId =
      parentMessage?.threadId ??
      fallbackThreadId ??
      `thread_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
    const messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
    const createdAtIso = new Date().toISOString();
    const topicTags = sanitizeAgentBoardTopicTags(options.topicTags);
    const capabilityTags = sanitizeAgentBoardCapabilityTags(options.capabilityTags);
    assertNoBlockedPublicTerms("Public agent tags", [...topicTags, ...capabilityTags]);
    const requestedProofIntent = sanitizeAgentBoardProofIntent(options.proofIntent);
    const swarmId =
      typeof options.swarmId === "string" && options.swarmId.trim().length > 0
        ? options.swarmId.trim().slice(0, 96)
        : undefined;
    const outputDigestSha256 =
      typeof options.outputDigestSha256 === "string" && /^[a-f0-9]{64}$/.test(options.outputDigestSha256)
        ? options.outputDigestSha256
        : undefined;
    const { proofIntent, proofAdmissionReason } = resolveAgentBoardProofAdmission({
      requestedProofIntent,
      agentId: options.agentId,
      messageType,
      ...(swarmId ? { swarmId } : {}),
      ...(outputDigestSha256 ? { outputDigestSha256 } : {}),
      createdAtIso,
      board: file,
      queue: socialAnchorQueue
    });
    const bodyDigestSha256 = sha256Hex(body);
    const messageDigestSha256 = canonicalDigest({
      schemaVersion: "santaclawz-agent-message/1.0",
      messageId,
      threadId,
      ...(parentMessage ? { parentMessageId: parentMessage.messageId } : {}),
      agentId: options.agentId,
      sessionId,
      messageType,
      bodyDigestSha256,
      topicTags,
      capabilityTags,
      visibility: "public",
      ...(outputDigestSha256 ? { outputDigestSha256 } : {}),
      createdAtIso
    }).sha256Hex;
    const representedPrincipal = profile.representedPrincipal.trim();
    let nextMessage: AgentBoardMessage = {
      schemaVersion: "santaclawz-agent-message/1.0",
      messageId,
      threadId,
      ...(parentMessage ? { parentMessageId: parentMessage.messageId } : {}),
      agentId: options.agentId,
      sessionId,
      agentName: profile.agentName,
      ...(representedPrincipal ? { representedPrincipal } : {}),
      messageType,
      body,
      topicTags,
      ...(capabilityTags.length > 0 ? { capabilityTags } : {}),
      visibility: "public",
      moderationStatus: "visible",
      createdAtIso,
      updatedAtIso: createdAtIso,
      bodyDigestSha256,
      messageDigestSha256,
      ...(outputDigestSha256 ? { outputDigestSha256 } : {}),
      proofIntent,
      requestedProofIntent,
      proofAdmissionReason,
      ...(swarmId ? { swarmId } : {}),
      anchorStatus: proofIntent === "agent_chatter" ? "not_proof_requested" : proofIntent === "aggregate" ? "aggregate_anchored" : "pending"
    };

    const anchorCandidate =
      proofIntent === "per_message"
        ? await this.enqueueSocialAnchorCandidate({
            sessionId,
            kind: "agent-message-posted",
            summary: `${profile.agentName} posted a public agent board ${messageType}.`,
            occurredAtIso: createdAtIso,
            payload: {
              schemaVersion: "santaclawz-agent-message-anchor/1.0",
              messageId,
              threadId,
              ...(parentMessage ? { parentMessageId: parentMessage.messageId } : {}),
              agentId: options.agentId,
              messageType,
              bodyDigestSha256,
              messageDigestSha256,
              topicTags,
              ...(capabilityTags.length > 0 ? { capabilityTags } : {}),
              ...(outputDigestSha256 ? { outputDigestSha256 } : {})
            }
          })
        : undefined;

    if (anchorCandidate) {
      nextMessage = {
        ...nextMessage,
        anchorCandidateId: anchorCandidate.candidateId,
        anchorStatus: anchorCandidate.status
      };
    }

    const nextFile: AgentBoardFile = {
      messages: [nextMessage, ...file.messages].slice(0, 1000)
    };
    await this.saveAgentBoardFile(nextFile);

    const queue = await this.loadSocialAnchorQueueFile();
    const boardPreview = this.buildAgentBoardState(nextFile, state, queue, {
      agentId: options.agentId,
      limit: 24
    });
    const postedMessage = boardPreview.messages.find((message) => message.messageId === messageId) ?? nextMessage;
    return {
      schemaVersion: "santaclawz-agent-board-post/1.0",
      ok: true,
      postedMessage,
      boardPreview
    };
  }

  private buildCanonicalSocialAnchorBatchExport(input: {
    state: ConsolePersistenceState;
    queue: SocialAnchorQueueFile;
    deployment: Pick<ZekoDeploymentState, "networkId" | "mode" | "contracts">;
    sessionId: string;
    limit?: number;
  }): SocialAnchorBatchExport {
    const items = input.queue.items
      .filter((item) => item.sessionId === input.sessionId && item.status === "pending")
      .sort((left, right) => left.occurredAtIso.localeCompare(right.occurredAtIso))
      .slice(0, Math.max(1, Math.min(input.limit ?? 12, 50)))
      .map((item) => ({
        candidateId: item.candidateId,
        kind: item.kind,
        occurredAtIso: item.occurredAtIso,
        payloadDigestSha256: item.payloadDigestSha256
      }));

    if (items.length === 0) {
      throw new Error("No pending social proof facts are waiting to anchor for this agent.");
    }

    const agentId = this.agentIdForSession(input.state, input.sessionId);
    const anchorMode = effectiveSocialAnchorMode(
      this.profileForSession(input.state, input.sessionId).socialAnchorPolicy.mode,
      input.deployment
    );
    const rootDigestSha256 = canonicalDigest({
      sessionId: input.sessionId,
      agentId,
      anchorMode,
      items
    }).sha256Hex;
    const batchId = `anchor_batch_${rootDigestSha256.slice(0, 16)}`;
    const anchorField = buildSocialAnchorBatchRootField({
      batchId,
      sessionId: input.sessionId,
      rootDigestSha256
    }).toString();

    return {
      batchId,
      sessionId: input.sessionId,
      agentId,
      anchorMode,
      networkId: input.deployment.networkId,
      rootDigestSha256,
      anchorField,
      itemCount: items.length,
      candidateKinds: [...new Set(items.map((item) => item.kind))],
      items,
      ...(this.configuredSocialAnchorContractAddress(input.deployment)
        ? { contractAddress: this.configuredSocialAnchorContractAddress(input.deployment)! }
        : {})
    };
  }

  private async settleSocialAnchorBatchForSession(
    sessionId: string,
    options: Omit<SocialAnchorSettleOptions, "sessionId" | "agentId" | "adminKey"> = {}
  ): Promise<SocialAnchorQueueState> {
    const [state, queue, deployment] = await Promise.all([
      this.loadState(),
      this.loadSocialAnchorQueueFile(),
      this.getDeploymentState()
    ]);
    const batchExport = this.buildCanonicalSocialAnchorBatchExport({
      state,
      queue,
      deployment,
      sessionId,
      ...(typeof options.limit === "number" ? { limit: options.limit } : {})
    });
    if (
      typeof options.expectedBatchId === "string" &&
      options.expectedBatchId.trim().length > 0 &&
      options.expectedBatchId.trim() !== batchExport.batchId
    ) {
      throw new Error("The queued milestones changed before commit. Export a fresh batch and try again.");
    }
    if (
      typeof options.expectedRootDigestSha256 === "string" &&
      options.expectedRootDigestSha256.trim().length > 0 &&
      options.expectedRootDigestSha256.trim() !== batchExport.rootDigestSha256
    ) {
      throw new Error("The queued proof root changed before commit. Export a fresh batch and try again.");
    }
    const settledAtIso = new Date().toISOString();
    const externalSubmittedOnly = options.localOnly && typeof options.txHash === "string" && options.txHash.trim().length > 0;
    const chainResult = options.localOnly
      ? undefined
      : await this.submitSocialAnchorBatchToZeko({
          batchId: batchExport.batchId,
          sessionId,
          rootDigestSha256: batchExport.rootDigestSha256,
          deployment
        });
    const batchStatus: SocialAnchorBatch["status"] =
      options.localOnly && !externalSubmittedOnly ? "confirmed" : chainResult?.confirmed ? "confirmed" : "submitted";
    const retryConfig = this.socialAnchorRetryConfig();
    const nextRetryAtIso =
      batchStatus === "submitted" ? new Date(Date.now() + retryConfig.retryDelayMs).toISOString() : undefined;
    const batchCandidateIds = batchExport.items.map((item) => item.candidateId);
    const nextBatch: SocialAnchorBatch = {
      batchId: batchExport.batchId,
      sessionId,
      agentId: batchExport.agentId,
      anchorMode: batchExport.anchorMode,
      networkId: chainResult?.networkId ?? deployment.networkId,
      itemCount: batchExport.itemCount,
      candidateKinds: batchExport.candidateKinds,
      rootDigestSha256: batchExport.rootDigestSha256,
      status: batchStatus,
      createdAtIso: settledAtIso,
      submittedAtIso: settledAtIso,
      ...(batchStatus === "confirmed" ? { confirmedAtIso: chainResult?.observedAtIso ?? settledAtIso } : {}),
      settledAtIso,
      anchorField: chainResult?.anchorField ?? batchExport.anchorField,
      ...(chainResult?.contractAddress ?? batchExport.contractAddress
        ? { contractAddress: chainResult?.contractAddress ?? batchExport.contractAddress! }
        : {}),
      ...(chainResult?.submitFeeRaw ? { submitFeeRaw: chainResult.submitFeeRaw } : {}),
      ...(chainResult?.submitFee ? { submitFee: chainResult.submitFee } : {}),
      ...(chainResult?.submitFeeSource ? { submitFeeSource: chainResult.submitFeeSource } : {}),
      ...(typeof chainResult?.attemptCount === "number" ? { submitAttemptCount: chainResult.attemptCount } : {}),
      retryCount: chainResult ? 1 : 0,
      ...(chainResult?.observedAtIso ? { observedAtIso: chainResult.observedAtIso } : {}),
      ...(batchStatus === "confirmed" ? { observedAnchorField: chainResult?.anchorField ?? batchExport.anchorField } : {}),
      ...(nextRetryAtIso ? { nextRetryAtIso } : {}),
      candidateIds: batchCandidateIds,
      ...(chainResult?.txHash
        ? { txHash: chainResult.txHash }
        : typeof options.txHash === "string" && options.txHash.trim().length > 0
          ? { txHash: options.txHash.trim().slice(0, 140) }
          : {}),
      ...(typeof options.operatorNote === "string" && options.operatorNote.trim().length > 0
        ? { operatorNote: options.operatorNote.trim().slice(0, 280) }
        : {})
    };

    const nextQueue = this.clearSocialAnchorQueueError({
      items: queue.items.map((item) =>
        batchExport.items.some((pending) => pending.candidateId === item.candidateId)
          ? {
              ...item,
              status: batchStatus === "confirmed" ? "confirmed" : "submitted",
              batchId: batchExport.batchId,
              batchRootDigestSha256: batchExport.rootDigestSha256,
              ...(nextBatch.anchorField ? { batchAnchorField: nextBatch.anchorField } : {}),
              batchItemIndex: batchExport.items.findIndex((pending) => pending.candidateId === item.candidateId),
              batchItemCount: batchExport.itemCount,
              submittedAtIso: settledAtIso,
              ...(batchStatus === "confirmed" ? { confirmedAtIso: nextBatch.confirmedAtIso ?? settledAtIso } : {}),
              ...(batchStatus === "confirmed" ? { anchoredAtIso: nextBatch.confirmedAtIso ?? settledAtIso } : {}),
              ...(nextBatch.contractAddress ? { contractAddress: nextBatch.contractAddress } : {}),
              ...(nextBatch.txHash ? { txHash: nextBatch.txHash } : {}),
              ...(nextBatch.submitAttemptCount ? { submitAttemptCount: nextBatch.submitAttemptCount } : {}),
              ...(nextRetryAtIso ? { nextRetryAtIso } : {})
            }
          : item
      ),
      batches: [nextBatch, ...queue.batches].slice(0, 80)
    });
    await this.saveSocialAnchorQueueFile(nextQueue);
    if (batchStatus === "confirmed" && this.socialAnchorBatchPublishesAgent(nextBatch)) {
      await this.markSessionPublished({
        sessionId,
        publishedAtIso: nextBatch.confirmedAtIso ?? settledAtIso,
        source: "social-anchor",
        batchId: batchExport.batchId,
        rootDigestSha256: batchExport.rootDigestSha256
      });
    }

    await this.appendEvent(
      "SessionCheckpointed",
      {
        sessionId,
        socialAnchorBatchSettled: batchStatus === "confirmed",
        socialAnchorBatchStatus: batchStatus,
        socialAnchorBatchId: batchExport.batchId,
        socialAnchorRootDigestSha256: batchExport.rootDigestSha256,
        socialAnchorItemCount: batchExport.itemCount,
        socialAnchorAnchorField: nextBatch.anchorField,
        socialAnchorMode: batchExport.anchorMode,
        ...(nextBatch.contractAddress ? { socialAnchorContractAddress: nextBatch.contractAddress } : {}),
        ...(nextBatch.txHash ? { socialAnchorTxHash: nextBatch.txHash } : {})
      },
      settledAtIso
    );

    return this.getSocialAnchorQueueState(sessionId);
  }

  private markSocialAnchorBatchConfirmed(
    queue: SocialAnchorQueueFile,
    batch: SocialAnchorBatch,
    options: {
      observedAtIso: string;
      observedAnchorField?: string;
    }
  ): SocialAnchorQueueFile {
    const confirmedAtIso = options.observedAtIso;
    return this.clearSocialAnchorQueueError({
      items: queue.items.map((item) => {
        if (item.batchId !== batch.batchId) {
          return item;
        }
        const { lastAnchorError: _lastAnchorError, nextRetryAtIso: _nextRetryAtIso, ...cleanItem } = item;
        return {
              ...cleanItem,
              status: "confirmed",
              confirmedAtIso,
              anchoredAtIso: confirmedAtIso,
              ...(options.observedAnchorField ?? batch.anchorField
                ? { batchAnchorField: options.observedAnchorField ?? batch.anchorField }
                : {}),
              ...(batch.rootDigestSha256 ? { batchRootDigestSha256: batch.rootDigestSha256 } : {}),
              ...(batch.contractAddress ? { contractAddress: batch.contractAddress } : {}),
              ...(batch.txHash ? { txHash: batch.txHash } : {})
            };
      }),
      batches: queue.batches.map((candidate) => {
        if (candidate.batchId !== batch.batchId) {
          return candidate;
        }
        const { lastAnchorError: _lastAnchorError, nextRetryAtIso: _nextRetryAtIso, ...cleanBatch } = candidate;
        return {
              ...cleanBatch,
              status: "confirmed",
              confirmedAtIso,
              settledAtIso: confirmedAtIso,
              lastCheckedAtIso: confirmedAtIso,
              observedAtIso: confirmedAtIso,
              ...(options.observedAnchorField ?? candidate.anchorField
                ? { observedAnchorField: options.observedAnchorField ?? candidate.anchorField }
                : {})
            };
      })
    });
  }

  private releaseFailedSocialAnchorBatchToPending(
    queue: SocialAnchorQueueFile,
    batch: SocialAnchorBatch,
    error: unknown,
    failedAtIso: string
  ): SocialAnchorQueueFile {
    const lastAnchorError = socialAnchorErrorMessage(error).slice(0, 500);
    return {
      items: queue.items.map((item) => {
        if (item.batchId !== batch.batchId) {
          return item;
        }
        const { nextRetryAtIso: _nextRetryAtIso, ...cleanItem } = item;
        return {
              ...cleanItem,
              status: "pending",
              failedAtIso,
              lastAnchorError
            };
      }),
      batches: queue.batches.map((candidate) =>
        candidate.batchId === batch.batchId
          ? {
              ...candidate,
              status: "failed",
              failedAtIso,
              settledAtIso: failedAtIso,
              lastCheckedAtIso: failedAtIso,
              lastAnchorError
            }
          : candidate
      ),
      lastError: lastAnchorError,
      lastErrorAtIso: failedAtIso,
      lastErrorContext: `social anchor batch ${batch.batchId}`
    };
  }

  private markSocialAnchorBatchRetrying(
    queue: SocialAnchorQueueFile,
    batch: SocialAnchorBatch,
    error: unknown,
    checkedAtIso: string
  ): SocialAnchorQueueFile {
    const retryConfig = this.socialAnchorRetryConfig();
    const retryCount = (batch.retryCount ?? 0) + 1;
    const nextRetryAtIso = new Date(Date.now() + retryConfig.retryDelayMs).toISOString();
    const lastAnchorError = socialAnchorErrorMessage(error).slice(0, 500);
    return {
      items: queue.items.map((item) =>
        item.batchId === batch.batchId
          ? {
              ...item,
              status: "retrying",
              lastAnchorError,
              nextRetryAtIso,
              submitAttemptCount: retryCount
            }
          : item
      ),
      batches: queue.batches.map((candidate) =>
        candidate.batchId === batch.batchId
          ? {
              ...candidate,
              status: "retrying",
              retryCount,
              submitAttemptCount: Math.max(candidate.submitAttemptCount ?? 0, retryCount),
              lastCheckedAtIso: checkedAtIso,
              lastAnchorError,
              nextRetryAtIso
            }
          : candidate
      ),
      lastError: lastAnchorError,
      lastErrorAtIso: checkedAtIso,
      lastErrorContext: `social anchor batch ${batch.batchId}`
    };
  }

  private async reconcileSocialAnchorQueue(
    queue: SocialAnchorQueueFile,
    deployment: Pick<ZekoDeploymentState, "networkId" | "graphqlEndpoint" | "archiveEndpoint" | "contracts">
  ): Promise<SocialAnchorQueueFile> {
    const activeBatch = queue.batches
      .filter((batch) => batch.status === "submitted" || batch.status === "retrying")
      .sort((left, right) => left.createdAtIso.localeCompare(right.createdAtIso))[0];
    if (!activeBatch) {
      return queue;
    }

    const checkedAtIso = new Date().toISOString();
    try {
      const observed = await this.observeSocialAnchorKernel(deployment);
      if (observed?.latestBatchRoot && activeBatch.anchorField && observed.latestBatchRoot === activeBatch.anchorField) {
        const nextQueue = this.markSocialAnchorBatchConfirmed(queue, activeBatch, {
          observedAtIso: observed.observedAtIso,
          observedAnchorField: observed.latestBatchRoot
        });
        await this.saveSocialAnchorQueueFile(nextQueue);
        if (this.socialAnchorBatchPublishesAgent(activeBatch)) {
          await this.markSessionPublished({
            sessionId: activeBatch.sessionId,
            publishedAtIso: observed.observedAtIso,
            source: "social-anchor",
            batchId: activeBatch.batchId,
            rootDigestSha256: activeBatch.rootDigestSha256
          });
        }
        return nextQueue;
      }
    } catch (error) {
      const nextQueue = this.markSocialAnchorBatchRetrying(queue, activeBatch, error, checkedAtIso);
      await this.saveSocialAnchorQueueFile(nextQueue);
      return nextQueue;
    }

    if (!isSocialAnchorBatchRetryDue(activeBatch)) {
      return queue;
    }

    const retryConfig = this.socialAnchorRetryConfig();
    const retryCount = activeBatch.retryCount ?? 0;
    if (retryCount >= retryConfig.maxAttempts) {
      const nextQueue = this.releaseFailedSocialAnchorBatchToPending(
        queue,
        activeBatch,
        `Expected root was not observed after ${retryCount} retry attempt${retryCount === 1 ? "" : "s"}.`,
        checkedAtIso
      );
      await this.saveSocialAnchorQueueFile(nextQueue);
      return nextQueue;
    }

    try {
      const chainResult = await this.submitSocialAnchorBatchToZeko({
        batchId: activeBatch.batchId,
        sessionId: activeBatch.sessionId,
        rootDigestSha256: activeBatch.rootDigestSha256,
        deployment
      });
      if (chainResult.confirmed) {
        const nextQueue = this.markSocialAnchorBatchConfirmed(
          {
            ...queue,
            batches: queue.batches.map((batch) =>
              batch.batchId === activeBatch.batchId
                ? {
                    ...batch,
                    submitFeeRaw: chainResult.submitFeeRaw,
                    submitFee: chainResult.submitFee,
                    submitFeeSource: chainResult.submitFeeSource,
                    submitAttemptCount: (batch.submitAttemptCount ?? 0) + chainResult.attemptCount,
                    retryCount: retryCount + 1,
                    contractAddress: chainResult.contractAddress,
                    anchorField: chainResult.anchorField,
                    ...(chainResult.txHash ?? batch.txHash ? { txHash: chainResult.txHash ?? batch.txHash } : {})
                  }
                : batch
            )
          },
          activeBatch,
          {
            observedAtIso: chainResult.observedAtIso ?? new Date().toISOString(),
            observedAnchorField: chainResult.anchorField
          }
        );
        await this.saveSocialAnchorQueueFile(nextQueue);
        if (this.socialAnchorBatchPublishesAgent(activeBatch)) {
          await this.markSessionPublished({
            sessionId: activeBatch.sessionId,
            publishedAtIso: chainResult.observedAtIso ?? new Date().toISOString(),
            source: "social-anchor",
            batchId: activeBatch.batchId,
            rootDigestSha256: activeBatch.rootDigestSha256
          });
        }
        return nextQueue;
      }

      const nextRetryAtIso = new Date(Date.now() + retryConfig.retryDelayMs).toISOString();
      const nextQueue = {
        items: queue.items.map((item) =>
          item.batchId === activeBatch.batchId
            ? {
                ...item,
                status: "submitted" as const,
                submittedAtIso: item.submittedAtIso ?? checkedAtIso,
                nextRetryAtIso,
                ...(chainResult.txHash ? { txHash: chainResult.txHash } : {}),
                contractAddress: chainResult.contractAddress,
                submitAttemptCount: (item.submitAttemptCount ?? 0) + chainResult.attemptCount
              }
            : item
        ),
        batches: queue.batches.map((batch) =>
          batch.batchId === activeBatch.batchId
            ? {
                ...batch,
                status: "submitted" as const,
                submittedAtIso: batch.submittedAtIso ?? checkedAtIso,
                settledAtIso: checkedAtIso,
                lastCheckedAtIso: checkedAtIso,
                retryCount: retryCount + 1,
                submitAttemptCount: (batch.submitAttemptCount ?? 0) + chainResult.attemptCount,
                contractAddress: chainResult.contractAddress,
                anchorField: chainResult.anchorField,
                submitFeeRaw: chainResult.submitFeeRaw,
                submitFee: chainResult.submitFee,
                submitFeeSource: chainResult.submitFeeSource,
                ...(chainResult.txHash ? { txHash: chainResult.txHash } : {}),
                nextRetryAtIso
              }
            : batch
        )
      };
      await this.saveSocialAnchorQueueFile(nextQueue);
      return nextQueue;
    } catch (error) {
      const nextQueue =
        retryCount + 1 >= retryConfig.maxAttempts
          ? this.releaseFailedSocialAnchorBatchToPending(queue, activeBatch, error, checkedAtIso)
          : this.markSocialAnchorBatchRetrying(queue, activeBatch, error, checkedAtIso);
      await this.saveSocialAnchorQueueFile(nextQueue);
      return nextQueue;
    }
  }

  private async runSharedSocialAnchorBatchCycle(): Promise<void> {
    if (this.sharedSocialAnchorRunPromise) {
      return this.sharedSocialAnchorRunPromise;
    }

    const run = (async () => {
      try {
        const [state, queue, deployment] = await Promise.all([
          this.loadState(),
          this.loadSocialAnchorQueueFile(),
          this.getDeploymentState()
        ]);
        const reconciledQueue = await this.reconcileSocialAnchorQueue(queue, deployment);
        if (hasActiveSocialAnchorBatch(reconciledQueue)) {
          return;
        }
        if (!this.canAutoAnchorSharedBatches(deployment)) {
          return;
        }
        const pendingSessionIds = [...new Set(
          reconciledQueue.items
            .filter((item) => item.status === "pending")
            .map((item) => item.sessionId)
            .filter((sessionId) => {
              const profile = this.profileForSession(state, sessionId);
              return effectiveSocialAnchorMode(profile.socialAnchorPolicy.mode, deployment) === "shared-batched";
            })
        )];

        const sessionId = pendingSessionIds[0];
        if (!sessionId) {
          return;
        }

        try {
          await this.settleSocialAnchorBatchForSession(sessionId, {
            operatorNote: "Shared 10s batch"
          });
        } catch (error) {
          await this.recordSocialAnchorQueueError(error, `shared social anchor settlement for ${sessionId}`);
          console.warn(
            `[clawz] shared social anchor settlement skipped for ${sessionId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      } finally {
        this.sharedSocialAnchorRunPromise = null;
      }
    })();

    this.sharedSocialAnchorRunPromise = run;
    return run;
  }

  private async runPrioritySocialAnchorBatchForSession(sessionId: string): Promise<void> {
    const existingRun = this.prioritySocialAnchorRuns.get(sessionId);
    if (existingRun) {
      return existingRun;
    }

    const run = (async () => {
      try {
        const [queue, deployment] = await Promise.all([this.loadSocialAnchorQueueFile(), this.getDeploymentState()]);
        const reconciledQueue = await this.reconcileSocialAnchorQueue(queue, deployment);
        if (hasActiveSocialAnchorBatch(reconciledQueue)) {
          return;
        }
        await this.settleSocialAnchorBatchForSession(sessionId, {
          operatorNote: "Priority anchoring lane"
        });
      } catch (error) {
        await this.recordSocialAnchorQueueError(error, `priority social anchor settlement for ${sessionId}`);
        console.warn(
          `[clawz] priority social anchor settlement skipped for ${sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      } finally {
        this.prioritySocialAnchorRuns.delete(sessionId);
      }
    })();

    this.prioritySocialAnchorRuns.set(sessionId, run);
    return run;
  }

  private async enqueueSocialAnchorCandidate(input: {
    sessionId: string;
    kind: SocialAnchorCandidateKind;
    title?: string;
    summary: string;
    occurredAtIso?: string;
    payload: Record<string, unknown>;
  }): Promise<SocialAnchorCandidate | undefined> {
    const state = await this.loadState();
    const queue = await this.loadSocialAnchorQueueFile();
    const deployment = await this.getDeploymentState();
    const agentId = this.agentIdForSession(state, input.sessionId);
    const anchorMode = effectiveSocialAnchorMode(
      this.profileForSession(state, input.sessionId).socialAnchorPolicy.mode,
      deployment
    );
    const occurredAtIso = input.occurredAtIso ?? new Date().toISOString();
    const payloadDigestSha256 = canonicalDigest({
      kind: input.kind,
      sessionId: input.sessionId,
      agentId,
      payload: input.payload
    }).sha256Hex;

    const existingItem = queue.items.find((item) => item.kind === input.kind && item.payloadDigestSha256 === payloadDigestSha256);
    if (existingItem) {
      return existingItem;
    }

    const nextItem: SocialAnchorCandidate = {
      candidateId: `anchor_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      sessionId: input.sessionId,
      agentId,
      anchorMode,
      kind: input.kind,
      title: input.title ?? titleForSocialAnchorKind(input.kind),
      summary: input.summary.trim().slice(0, 280),
      occurredAtIso,
      payloadDigestSha256,
      status: "pending"
    };

    await this.saveSocialAnchorQueueFile({
      ...queue,
      items: retainSocialAnchorItems([nextItem, ...queue.items])
    });

    if (anchorMode === "priority-self-funded") {
      queueMicrotask(() => {
        void this.runPrioritySocialAnchorBatchForSession(input.sessionId);
      });
    }

    return nextItem;
  }

  private async enqueueMarketplaceTagDeclarationAnchor(
    sessionId: string,
    profile: Pick<AgentProfileState, "agentName" | "marketplaceTags">,
    occurredAtIso = new Date().toISOString()
  ): Promise<SocialAnchorCandidate | undefined> {
    if (agentMarketplaceTagsAreEmpty(profile.marketplaceTags)) {
      return undefined;
    }

    const tagValues = agentMarketplaceTagValues(profile.marketplaceTags);
    return this.enqueueSocialAnchorCandidate({
      sessionId,
      kind: "marketplace-tags-declared",
      summary: `${profile.agentName} declared marketplace tags: ${tagValues.slice(0, 6).join(", ")}.`,
      occurredAtIso,
      payload: {
        agentId: this.agentIdForSession(await this.loadState(), sessionId),
        marketplaceTags: profile.marketplaceTags,
        marketplaceTagDigestSha256: marketplaceTagsDigest(profile.marketplaceTags)
      }
    });
  }

  private async enqueueMarketplaceTagReputationAnchor(input: {
    sessionId: string;
    agentId: string;
    requestId: string;
    requestType: HireRequestRecord["requestType"];
    outcome: "completed" | "failed";
    marketplaceTags: MarketplaceWorkTags;
    marketplaceTagStats: AgentMarketplaceTagStat[];
    occurredAtIso: string;
    protocolReturnDigestSha256?: string;
  }): Promise<SocialAnchorCandidate | undefined> {
    if (marketplaceWorkTagsAreEmpty(input.marketplaceTags)) {
      return undefined;
    }

    const tagValues = marketplaceWorkTagValues(input.marketplaceTags);
    const relevantStats = input.marketplaceTagStats.filter((stat) => tagValues.includes(stat.tag));
    return this.enqueueSocialAnchorCandidate({
      sessionId: input.sessionId,
      kind: "marketplace-tag-reputation-updated",
      summary: `Marketplace reputation updated for ${tagValues.slice(0, 6).join(", ")}.`,
      occurredAtIso: input.occurredAtIso,
      payload: {
        agentId: input.agentId,
        requestId: input.requestId,
        requestType: input.requestType,
        outcome: input.outcome,
        marketplaceTags: input.marketplaceTags,
        marketplaceTagStats: relevantStats,
        marketplaceTagDigestSha256: marketplaceTagsDigest(input.marketplaceTags),
        ...(input.protocolReturnDigestSha256 ? { protocolReturnDigestSha256: input.protocolReturnDigestSha256 } : {})
      }
    });
  }

  private assertSelfServeSocialAnchoringEnabled(deployment: Pick<ZekoDeploymentState, "networkId" | "mode">) {
    if (isMainnetNetwork(deployment) || allowTestnetSelfServeSocialAnchor()) {
      return;
    }

    throw new SelfServeSocialAnchoringDisabledError();
  }

  private coerceProfileForDeployment(
    profile: AgentProfileState,
    deployment: Pick<ZekoDeploymentState, "networkId" | "mode">
  ): AgentProfileState {
    const nextMode = effectiveSocialAnchorMode(profile.socialAnchorPolicy.mode, deployment);
    if (nextMode === profile.socialAnchorPolicy.mode) {
      return profile;
    }

    return {
      ...profile,
      socialAnchorPolicy: {
        mode: nextMode
      }
    };
  }

  private async runSponsorQueue(): Promise<void> {
    if (this.sponsorQueueRunPromise) {
      return this.sponsorQueueRunPromise;
    }

    this.sponsorQueueRunPromise = (async () => {
      while (true) {
        const queue = await this.loadSponsorQueueFile();
        const nextJob = queue.jobs.find((job) => job.status === "queued");

        if (!nextJob) {
          break;
        }

        const startedAtIso = new Date().toISOString();
        const runningJob: SponsorQueueJob = {
          ...nextJob,
          status: "running",
          startedAtIso,
          note: "Submitting sponsor top-up through the SantaClawz treasury queue."
        };

        await this.saveSponsorQueueFile({
          jobs: queue.jobs.map((job) => (job.jobId === nextJob.jobId ? runningJob : job))
        });

        try {
          const state = await this.loadState();
          const txHash = `sponsor_${nextJob.jobId.slice(-12)}`;
          const finishedAtIso = new Date().toISOString();
          const nextState: ConsolePersistenceState = {
            ...state,
            wallet: {
              ...state.wallet,
              sponsorStatus: "active",
              sponsoredBudgetMina: addMina(state.wallet.sponsoredBudgetMina, nextJob.amountMina),
              sponsoredRemainingMina: addMina(state.wallet.sponsoredRemainingMina, nextJob.amountMina)
            }
          };

          await this.saveState(nextState);
          await this.appendEvent(
            "CreditsDeposited",
            {
              walletId: nextState.wallet.walletId,
              amountMina: nextJob.amountMina,
              budgetAfterMina: nextState.wallet.sponsoredBudgetMina,
              sessionId: nextJob.sessionId,
              sponsorJobId: nextJob.jobId,
              sponsorTxHash: txHash,
              sponsorPurpose: nextJob.purpose
            },
            finishedAtIso
          );

          const refreshedQueue = await this.loadSponsorQueueFile();
          await this.saveSponsorQueueFile({
            jobs: refreshedQueue.jobs.map((job) =>
              job.jobId === nextJob.jobId
                ? {
                    ...runningJob,
                    status: "succeeded",
                    finishedAtIso,
                    txHash,
                    note: `Sponsored ${nextJob.amountMina} MINA for ${nextJob.purpose}.`
                  }
                : job
            )
          });
        } catch (error) {
          const refreshedQueue = await this.loadSponsorQueueFile();
          const finishedAtIso = new Date().toISOString();
          await this.saveSponsorQueueFile({
            jobs: refreshedQueue.jobs.map((job) =>
              job.jobId === nextJob.jobId
                ? {
                    ...runningJob,
                    status: "failed",
                    finishedAtIso,
                    lastError: error instanceof Error ? error.message : "Unknown sponsor queue error."
                  }
                : job
            )
          });
        }
      }
    })().finally(() => {
      this.sponsorQueueRunPromise = null;
    });

    return this.sponsorQueueRunPromise;
  }

  private buildLiveFlowTargets(events: ClawzEvent[], liveFlow: LiveSessionTurnFlowState): LiveFlowTargets {
    const turnTargets = new Map<string, MutableLiveFlowTurnTarget>();
    const disclosureTargets = new Map<string, LiveFlowDisclosureTarget>();
    const sortedEvents = [...events].sort((left, right) => left.occurredAtIso.localeCompare(right.occurredAtIso));

    const ensureTurnTarget = (sessionId: string, turnId: string, latestEventType = "SessionCreated") => {
      const key = `${sessionId}:${turnId}`;
      const existing = turnTargets.get(key);
      if (existing) {
        return existing;
      }

      const next: MutableLiveFlowTurnTarget = {
        sessionId,
        turnId,
        latestEventType,
        canStartNextTurn: false,
        canAbort: false,
        canRefund: true,
        canRevokeDisclosure: false,
        finalized: false,
        aborted: false,
        leased: false,
        started: false
      };
      turnTargets.set(key, next);
      return next;
    };

    sortedEvents.forEach((event) => {
      const payload = event.payload as Record<string, unknown>;
      const sessionId = asString(payload.sessionId);
      const turnId = asString(payload.turnId);
      const disclosureId = asString(payload.disclosureId);
      const turnTarget = sessionId && turnId ? ensureTurnTarget(sessionId, turnId, event.type) : undefined;

      if (turnTarget) {
        turnTarget.latestEventType = event.type;
        turnTarget.lastOccurredAtIso = event.occurredAtIso;

        if (event.type === "LeaseAcquired") {
          turnTarget.leased = true;
        }
        if (event.type === "TurnBegan") {
          turnTarget.started = true;
        }
        if (event.type === "TurnFinalized") {
          turnTarget.finalized = true;
        }
        if (event.type === "TurnAborted") {
          turnTarget.aborted = true;
        }
        if (event.type === "TurnSettled") {
          const spentMina = asString(payload.spentMina);
          const refundedMina = asString(payload.refundedMina);
          if (spentMina) {
            turnTarget.spentMina = spentMina;
          }
          if (refundedMina) {
            turnTarget.refundedMina = refundedMina;
          }
        }
      }

      if (event.type === "DisclosureGranted" && sessionId && turnId && disclosureId) {
        disclosureTargets.set(disclosureId, {
          disclosureId,
          sessionId,
          turnId,
          grantedAtIso: event.occurredAtIso,
          active: true
        });
      }

      if (event.type === "DisclosureRevoked" && sessionId && turnId && disclosureId) {
        const existing = disclosureTargets.get(disclosureId);
        disclosureTargets.set(disclosureId, {
          disclosureId,
          sessionId,
          turnId,
          ...(existing?.grantedAtIso ? { grantedAtIso: existing.grantedAtIso } : {}),
          revokedAtIso: event.occurredAtIso,
          active: false
        });
      }
    });

    if (liveFlow.status !== "idle" && liveFlow.sessionId && liveFlow.turnId) {
      const liveTarget = ensureTurnTarget(liveFlow.sessionId, liveFlow.turnId, liveFlow.flowKind ?? liveFlow.status);
      const latestLiveLabel = liveFlow.steps.at(-1)?.label;
      if (latestLiveLabel) {
        liveTarget.latestEventType = latestLiveLabel;
      }
      if (liveFlow.generatedAtIso) {
        liveTarget.lastOccurredAtIso = liveFlow.generatedAtIso;
      }
      liveTarget.leased = liveTarget.leased || liveFlow.completedStepLabels.includes("TurnKernel.acquireLease");
      liveTarget.started = liveTarget.started || liveFlow.completedStepLabels.includes("TurnKernel.beginTurn");
      liveTarget.finalized = liveTarget.finalized || liveFlow.completedStepLabels.includes("TurnKernel.finalizeTurn");
      liveTarget.aborted = liveTarget.aborted || liveFlow.completedStepLabels.includes("TurnKernel.abortTurn");
      if (liveFlow.steps.some((step) => step.label === "EscrowKernel.settleTurn")) {
        liveTarget.spentMina = liveTarget.spentMina ?? "tracked-on-chain";
      }
      if (liveFlow.steps.some((step) => step.label === "EscrowKernel.refundTurn")) {
        liveTarget.refundedMina = liveTarget.refundedMina ?? liveFlow.refundAmountMina ?? "tracked-on-chain";
      }

      const disclosedAtIso = liveFlow.steps.find((step) => step.label === "DisclosureKernel.grantDisclosure")?.occurredAtIso;
      const revokedAtIso = liveFlow.steps.find((step) => step.label === "DisclosureKernel.revokeDisclosure")?.occurredAtIso;
      const fallbackDisclosureId =
        liveFlow.sourceDisclosureId ??
        (liveFlow.jobId && liveFlow.steps.some((step) => step.label === "DisclosureKernel.grantDisclosure")
          ? `${liveFlow.turnId}:disclosure:${liveFlow.jobId}`
          : undefined);

      if (fallbackDisclosureId) {
        const existing = disclosureTargets.get(fallbackDisclosureId);
        disclosureTargets.set(fallbackDisclosureId, {
          disclosureId: fallbackDisclosureId,
          sessionId: liveFlow.sessionId,
          turnId: liveFlow.turnId,
          ...(existing?.grantedAtIso || disclosedAtIso
            ? { grantedAtIso: existing?.grantedAtIso ?? disclosedAtIso! }
            : {}),
          ...(revokedAtIso || existing?.revokedAtIso
            ? { revokedAtIso: revokedAtIso ?? existing?.revokedAtIso! }
            : {}),
          active: revokedAtIso ? false : (existing?.active ?? Boolean(disclosedAtIso))
        });
      }
    }

    const disclosures = [...disclosureTargets.values()].sort((left, right) =>
      (right.grantedAtIso ?? right.revokedAtIso ?? "").localeCompare(left.grantedAtIso ?? left.revokedAtIso ?? "")
    );

    const activeDisclosureByTurn = new Map<string, LiveFlowDisclosureTarget>();
    disclosures.forEach((disclosure) => {
      if (!disclosure.active) {
        return;
      }
      const key = `${disclosure.sessionId}:${disclosure.turnId}`;
      if (!activeDisclosureByTurn.has(key)) {
        activeDisclosureByTurn.set(key, disclosure);
      }
    });

    return {
      turns: [...turnTargets.values()]
        .map<LiveFlowTurnTarget>((target) => {
          const activeDisclosure = activeDisclosureByTurn.get(`${target.sessionId}:${target.turnId}`);
          return {
            sessionId: target.sessionId,
            turnId: target.turnId,
            latestEventType: target.latestEventType,
            ...(target.lastOccurredAtIso ? { lastOccurredAtIso: target.lastOccurredAtIso } : {}),
            ...(activeDisclosure?.disclosureId || target.latestDisclosureId
              ? { latestDisclosureId: activeDisclosure?.disclosureId ?? target.latestDisclosureId }
              : {}),
            ...(target.spentMina ? { spentMina: target.spentMina } : {}),
            ...(target.refundedMina ? { refundedMina: target.refundedMina } : {}),
            canStartNextTurn: target.finalized && !target.aborted,
            canAbort: !target.finalized && !target.aborted && (target.leased || target.started),
            canRefund: true,
            canRevokeDisclosure: Boolean(activeDisclosure)
          };
        })
        .sort((left, right) => (right.lastOccurredAtIso ?? "").localeCompare(left.lastOccurredAtIso ?? "")),
      disclosures
    };
  }

  private async loadLiveFlowExecutor(): Promise<LiveSessionTurnFlowModule> {
    const executorPath = path.join(this.workspaceRoot, "packages", "contracts", "dist", "contracts", "src", "index.js");
    const moduleUrl = pathToFileURL(executorPath).toString();
    return import(moduleUrl) as Promise<LiveSessionTurnFlowModule>;
  }

  private buildLiveFlowEvent(
    step: NonNullable<LiveSessionTurnFlowReportFile["steps"]>[number],
    sessionId: string,
    turnId: string,
    trustModeId: TrustModeId
  ): ClawzEvent | undefined {
    if (typeof step.label !== "string" || typeof step.txHash !== "string" || typeof step.contractAddress !== "string") {
      return undefined;
    }

    const occurredAtIso = typeof step.occurredAtIso === "string" ? step.occurredAtIso : new Date().toISOString();
    const args = step.args ?? {};
    const handles = step.handles ?? {};
    const basePayload = {
      sessionId,
      turnId,
      txHash: step.txHash,
      contractAddress: step.contractAddress,
      changedSlots: Array.isArray(step.changedSlots) ? step.changedSlots : []
    };

    if (step.label === "SessionKernel.createSession") {
      return {
        id: `chain_${step.txHash}`,
        type: "SessionCreated",
        occurredAtIso,
        payload: {
          sessionId,
          trustMode: trustModeId,
          txHash: step.txHash,
          contractAddress: step.contractAddress,
          sessionIdHash: args.sessionIdHash,
          tenantIdHash: args.tenantIdHash
        }
      };
    }

    if (step.label === "SessionKernel.checkpointSession") {
      return {
        id: `chain_${step.txHash}`,
        type: "SessionCheckpointed",
        occurredAtIso,
        payload: {
          sessionId,
          turnId,
          txHash: step.txHash,
          contractAddress: step.contractAddress,
          checkpointId: handles.checkpointId,
          checkpointHash: args.checkpointHash
        }
      };
    }

    if (step.label === "TurnKernel.acquireLease") {
      return {
        id: `chain_${step.txHash}`,
        type: "LeaseAcquired",
        occurredAtIso,
        payload: {
          ...basePayload,
          leaseId: handles.leaseId,
          leaseIdHash: args.leaseIdHash,
          workerIdHash: args.workerIdHash
        }
      };
    }

    if (step.label === "ApprovalKernel.requestApproval") {
      return {
        id: `chain_${step.txHash}`,
        type: "ApprovalRequested",
        occurredAtIso,
        payload: {
          ...basePayload,
          approvalId: handles.approvalId,
          approvalIdHash: args.approvalIdHash,
          policyHash: args.policyHash
        }
      };
    }

    if (step.label === "ApprovalKernel.grantApproval") {
      return {
        id: `chain_${step.txHash}`,
        type: "ApprovalGranted",
        occurredAtIso,
        payload: {
          ...basePayload,
          requestLeaf: args.requestLeaf,
          observedApprovals: args.observedApprovals
        }
      };
    }

    if (step.label === "ApprovalKernel.requestPrivacyException") {
      return {
        id: `chain_${step.txHash}`,
        type: "PrivacyExceptionRequested",
        occurredAtIso,
        payload: {
          ...basePayload,
          exceptionId: handles.exceptionId,
          scopeHash: args.scopeHash,
          audienceHash: args.audienceHash
        }
      };
    }

    if (step.label === "EscrowKernel.reserveBudget") {
      return {
        id: `chain_${step.txHash}`,
        type: "BudgetReserved",
        occurredAtIso,
        payload: {
          ...basePayload,
          reservationId: handles.reservationId,
          reservedMina: fromNanomina(BigInt(args.reservedAmount ?? "0")),
          budgetEpoch: args.budgetEpoch
        }
      };
    }

    if (step.label === "TurnKernel.beginTurn") {
      return {
        id: `chain_${step.txHash}`,
        type: "TurnBegan",
        occurredAtIso,
        payload: {
          ...basePayload,
          leaseIdHash: args.leaseIdHash
        }
      };
    }

    if (step.label === "TurnKernel.commitOutput") {
      return {
        id: `chain_${step.txHash}`,
        type: "OutputCommitted",
        occurredAtIso,
        payload: {
          ...basePayload,
          outputHash: args.outputHash,
          artifactRoot: args.artifactRoot,
          originProofRoot: args.originProofRoot
        }
      };
    }

    if (step.label === "TurnKernel.abortTurn") {
      return {
        id: `chain_${step.txHash}`,
        type: "TurnAborted",
        occurredAtIso,
        payload: {
          ...basePayload,
          abortReason: handles.abortReason,
          abortReasonHash: args.abortReasonHash
        }
      };
    }

    if (step.label === "EscrowKernel.settleTurn") {
      return {
        id: `chain_${step.txHash}`,
        type: "TurnSettled",
        occurredAtIso,
        payload: {
          ...basePayload,
          reservedMina: fromNanomina(BigInt(args.reservedAmount ?? "0")),
          spentMina: fromNanomina(BigInt(args.payoutAmount ?? "0")),
          refundedMina: fromNanomina(BigInt(args.refundedAmount ?? "0"))
        }
      };
    }

    if (step.label === "EscrowKernel.refundTurn") {
      return {
        id: `chain_${step.txHash}`,
        type: "TurnRefunded",
        occurredAtIso,
        payload: {
          ...basePayload,
          refundId: handles.refundId,
          refundAmountMina: handles.refundAmountMina ?? fromNanomina(BigInt(args.refundAmount ?? "0"))
        }
      };
    }

    if (step.label === "TurnKernel.finalizeTurn") {
      return {
        id: `chain_${step.txHash}`,
        type: "TurnFinalized",
        occurredAtIso,
        payload: {
          ...basePayload,
          settlementHash: args.settlementHash
        }
      };
    }

    if (step.label === "DisclosureKernel.grantDisclosure") {
      return {
        id: `chain_${step.txHash}`,
        type: "DisclosureGranted",
        occurredAtIso,
        payload: {
          ...basePayload,
          disclosureId: handles.disclosureId,
          audienceHash: args.audienceHash,
          retentionHash: args.retentionHash
        }
      };
    }

    if (step.label === "DisclosureKernel.revokeDisclosure") {
      return {
        id: `chain_${step.txHash}`,
        type: "DisclosureRevoked",
        occurredAtIso,
        payload: {
          ...basePayload,
          disclosureId: handles.disclosureId,
          revocationReason: handles.revocationReason
        }
      };
    }

    return undefined;
  }

  private async recordLiveFlowStep(
    step: NonNullable<LiveSessionTurnFlowReportFile["steps"]>[number],
    sessionId: string,
    turnId: string,
    trustModeId: TrustModeId
  ) {
    const event = this.buildLiveFlowEvent(step, sessionId, turnId, trustModeId);
    if (!event) {
      return;
    }

    try {
      await this.ingestEvent(event);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Event already exists:")) {
        return;
      }
      throw error;
    }
  }

  async runLiveSessionTurnFlow(options: LiveFlowRunOptions = {}, adminKey?: string): Promise<ConsoleStateResponse> {
    if (this.liveFlowRunPromise) {
      return this.liveFlowRunPromise;
    }

    this.liveFlowRunPromise = (async () => {
      const flowKind = options.flowKind ?? "first-turn";
      const state = await this.loadState();
      const events = await this.loadEvents();
      const requestedAtIso = new Date().toISOString();
      const privacyExceptions = this.normalizePrivacyExceptions(state, requestedAtIso);
      const existingStatus = await this.loadLiveFlowStatus();
      const liveFlowState = await this.getLiveFlowState();
      const resume = this.canResumeLiveFlow(existingStatus, options);
      const requestedSessionId = options.sessionId ?? liveFlowState.sessionId ?? state.currentSessionId;
      const priorPublished = this.buildLiveFlowTargets(events, liveFlowState).turns.some(
        (target) => target.sessionId === requestedSessionId
      );
      this.assertAdminAccess(state, requestedSessionId, adminKey);
      if (flowKind === "first-turn" || flowKind === "next-turn") {
        this.assertOwnershipVerifiedForPublish(state, requestedSessionId);
      }
      const jobTrustModeId =
        resume && existingStatus?.trustModeId
          ? existingStatus.trustModeId
          : flowKind === "first-turn"
            ? state.activeMode
            : this.resolveSessionTrustMode(
                events,
                requestedSessionId,
                state.activeMode
              );
      const job = resume && existingStatus
        ? {
            ...existingStatus,
            flowKind,
            trustModeId: existingStatus.trustModeId ?? jobTrustModeId,
            status: "queued" as const,
            requestedAtIso: existingStatus.requestedAtIso ?? requestedAtIso,
            completedStepLabels: existingStatus.completedStepLabels ?? [],
            totalSteps: existingStatus.totalSteps ?? this.flowMethodsFor(flowKind).length,
            attemptCount: (existingStatus.attemptCount ?? 0) + 1,
            resumeAvailable: false,
            witnessPlanPath: existingStatus.witnessPlanPath ?? this.liveFlowPlanPath,
            reportPath: existingStatus.reportPath ?? this.liveFlowReportPath
          }
        : this.buildLiveFlowJob(state, requestedAtIso, { ...options, flowKind }, liveFlowState, jobTrustModeId);
      await this.saveLiveFlowStatus(job);
      const startedAtIso = new Date().toISOString();
      const queuedNextStep = this.nextLiveFlowLabel(flowKind, job.completedStepLabels ?? []);
      const runningStatus: LiveSessionTurnFlowStatusFile = {
        ...job,
        status: "running",
        lastStartedAtIso: startedAtIso,
        resumeAvailable: false,
        ...(queuedNextStep ? { currentStepLabel: queuedNextStep } : {})
      };

      await this.saveLiveFlowStatus(runningStatus);

      try {
        const executor = await this.loadLiveFlowExecutor();
        const executeOptions = {
          workspaceRoot: this.workspaceRoot,
          witnessPlanPath: runningStatus.witnessPlanPath ?? this.liveFlowPlanPath,
          reportPath: runningStatus.reportPath ?? this.liveFlowReportPath,
          ...(runningStatus.sessionId ? { sessionId: runningStatus.sessionId } : {}),
          ...(runningStatus.turnId ? { turnId: runningStatus.turnId } : {}),
          ...(resume
            ? { resume: true }
            : {
                runtimeInput: this.buildRuntimeLiveFlowInput(state, privacyExceptions, runningStatus)
              }),
          onStep: async (step: NonNullable<LiveSessionTurnFlowReportFile["steps"]>[number]) => {
            const completedStepLabels = [
              ...(runningStatus.completedStepLabels ?? []),
              ...(typeof step.label === "string" ? [step.label] : [])
            ].filter((label, index, labels) => labels.indexOf(label) === index);
            const nextStepLabel = this.nextLiveFlowLabel(flowKind, completedStepLabels);
            const { currentStepLabel: _currentStepLabel, ...runningStatusBase } = runningStatus;

            runningStatus.completedStepLabels = completedStepLabels;

            await this.saveLiveFlowStatus({
              ...runningStatusBase,
              status: "running",
              completedStepLabels,
              totalSteps: this.flowMethodsFor(flowKind).length,
              ...(nextStepLabel ? { currentStepLabel: nextStepLabel } : {}),
              ...(runningStatus.witnessPlanPath ? { witnessPlanPath: runningStatus.witnessPlanPath } : {}),
              ...(runningStatus.reportPath ? { reportPath: runningStatus.reportPath } : {})
            });
            await this.recordLiveFlowStep(
              step,
              runningStatus.sessionId ?? state.currentSessionId,
              runningStatus.turnId ?? DEFAULT_TURN_ID,
              runningStatus.trustModeId ?? state.activeMode
            );
          }
        };
        const report = await executor.executeLiveSessionTurnFlow(executeOptions);
        const completedStepLabels = (report.steps ?? [])
          .map((step) => step.label ?? "")
          .filter((label): label is string => label.length > 0);
        const { currentStepLabel: _currentStepLabel, ...runningStatusBase } = runningStatus;

        await this.saveLiveFlowStatus({
          ...runningStatusBase,
          status: "succeeded",
          completedStepLabels,
          totalSteps: this.flowMethodsFor(flowKind).length,
          lastStartedAtIso: startedAtIso,
          lastFinishedAtIso: report.generatedAtIso ?? new Date().toISOString(),
          resumeAvailable: false,
          ...(runningStatus.witnessPlanPath ? { witnessPlanPath: runningStatus.witnessPlanPath } : {}),
          ...(runningStatus.reportPath ? { reportPath: runningStatus.reportPath } : {})
        });

        const refreshedState = await this.loadState();
        const focusedState = this.applyFocusedSession(
          refreshedState,
          runningStatus.sessionId ?? refreshedState.currentSessionId,
          runningStatus.trustModeId ?? refreshedState.activeMode
        );
        await this.saveState(focusedState);
        const finalSessionId = runningStatus.sessionId ?? refreshedState.currentSessionId;
        if (!priorPublished && (flowKind === "first-turn" || flowKind === "next-turn")) {
          const publishedProfile = this.profileForSession(focusedState, finalSessionId, runningStatus.trustModeId ?? focusedState.activeMode);
          await this.enqueueSocialAnchorCandidate({
            sessionId: finalSessionId,
            kind: "agent-published",
            summary: `${publishedProfile.agentName} published on Zeko and is now visible in Explore.`,
            occurredAtIso: report.generatedAtIso ?? new Date().toISOString(),
            payload: {
              agentId: this.agentIdForSession(focusedState, finalSessionId),
              turnId: runningStatus.turnId ?? DEFAULT_TURN_ID,
              networkId: "zeko_testnet"
            }
          });
          await this.markSessionPublished({
            sessionId: finalSessionId,
            publishedAtIso: report.generatedAtIso ?? new Date().toISOString(),
            source: "live-flow"
          });
        }

        return this.getConsoleState({
          sessionId: finalSessionId,
          ...(adminKey ? { adminKey } : {})
        });
      } catch (error) {
        const partialReport = await this.loadLiveFlowReport();
        const completedStepLabels = (partialReport?.steps ?? [])
          .map((step) => step.label ?? "")
          .filter((label): label is string => label.length > 0);
        const nextStepLabel = this.nextLiveFlowLabel(flowKind, completedStepLabels);
        const { currentStepLabel: _currentStepLabel, ...runningStatusBase } = runningStatus;

        await this.saveLiveFlowStatus({
          ...runningStatusBase,
          status: "failed",
          completedStepLabels,
          totalSteps: this.flowMethodsFor(flowKind).length,
          lastStartedAtIso: startedAtIso,
          lastFinishedAtIso: new Date().toISOString(),
          resumeAvailable: completedStepLabels.length < this.flowMethodsFor(flowKind).length,
          lastError: error instanceof Error ? error.message : "Unknown live flow error.",
          ...(nextStepLabel ? { currentStepLabel: nextStepLabel } : {}),
          ...(runningStatus.witnessPlanPath ? { witnessPlanPath: runningStatus.witnessPlanPath } : {}),
          ...(runningStatus.reportPath ? { reportPath: runningStatus.reportPath } : {})
        });
        throw error;
      } finally {
        this.liveFlowRunPromise = null;
      }
    })();

    return this.liveFlowRunPromise;
  }

  private async reconcileStateFromEvent(state: ConsolePersistenceState, event: ClawzEvent): Promise<ConsolePersistenceState> {
    const payload = event.payload as Record<string, unknown>;

    if (event.type === "SessionCreated" && typeof payload.sessionId === "string") {
      const maybeMode = typeof payload.trustMode === "string" && isTrustModeId(payload.trustMode) ? payload.trustMode : state.activeMode;
      return this.applyFocusedSession(state, payload.sessionId, maybeMode);
    }

    if (event.type === "PrivacyExceptionRequested" && typeof payload.exceptionId === "string") {
      const alreadyExists = state.privacyExceptions.some((item) => item.id === payload.exceptionId);
      if (alreadyExists) {
        return state;
      }

      const nextException: PrivacyExceptionQueueItem = {
        id: payload.exceptionId,
        sessionId: typeof payload.sessionId === "string" ? payload.sessionId : state.currentSessionId,
        turnId: typeof payload.turnId === "string" ? payload.turnId : DEFAULT_TURN_ID,
        title: typeof payload.title === "string" ? payload.title : "Requested privacy exception",
        audience: typeof payload.audience === "string" ? payload.audience : "Compliance reviewer",
        duration: typeof payload.duration === "string" ? payload.duration : "24h",
        scope: typeof payload.scope === "string" ? payload.scope : typeof payload.summary === "string" ? payload.summary : "Scoped artifact disclosure",
        reason: typeof payload.reason === "string" ? payload.reason : "Imported from event stream.",
        severity: typeof payload.severity === "string" && (payload.severity === "low" || payload.severity === "medium" || payload.severity === "high") ? payload.severity : "medium",
        status: "pending",
        requiredApprovals: state.wallet.governancePolicy.requiredApprovals,
        approvals: [],
        expiresAtIso: typeof payload.expiresAtIso === "string" ? payload.expiresAtIso : plusHours(event.occurredAtIso, state.wallet.governancePolicy.autoExpiryHours)
      };

      return {
        ...state,
        privacyExceptions: [nextException, ...state.privacyExceptions]
      };
    }

    if (event.type === "CreditsDeposited" && typeof payload.amountMina === "string") {
      const amountMina = payload.amountMina;
      return {
        ...state,
        wallet: {
          ...state.wallet,
          sponsoredBudgetMina: addMina(state.wallet.sponsoredBudgetMina, amountMina),
          sponsoredRemainingMina: addMina(state.wallet.sponsoredRemainingMina, amountMina)
        }
      };
    }

    if (event.type === "TurnSettled" && typeof payload.spentMina === "string") {
      return {
        ...state,
        wallet: {
          ...state.wallet,
          sponsoredRemainingMina: subtractMina(state.wallet.sponsoredRemainingMina, payload.spentMina)
        }
      };
    }

    if (event.type === "TurnRefunded" && typeof payload.refundAmountMina === "string") {
      return {
        ...state,
        wallet: {
          ...state.wallet,
          sponsoredRemainingMina: addMina(state.wallet.sponsoredRemainingMina, payload.refundAmountMina)
        }
      };
    }

    return state;
  }

  async getConsoleState(options: ConsoleStateOptions = {}): Promise<ConsoleStateResponse> {
    const state = await this.loadState();
    const events = await this.loadEvents();
    const normalizedExceptions = this.normalizePrivacyExceptions(state);
    const [manifests, deployment, liveFlow, sponsorQueueFile, socialAnchorQueueFile, hireRequestFile, runtimeHeartbeatFile] = await Promise.all([
      this.blobStore.listManifests(state.currentSessionId),
      this.getDeploymentState(),
      this.getLiveFlowState(),
      this.loadSponsorQueueFile(),
      this.loadSocialAnchorQueueFile(),
      this.loadHireRequestFile(),
      this.loadRuntimeHeartbeatFile()
    ]);
    const liveFlowTargets = this.buildLiveFlowTargets(events, liveFlow);
    const requestedSessionId =
      options.sessionId || options.agentId
        ? this.resolveOwnedSessionId(state, {
            ...(options.sessionId ? { sessionId: options.sessionId } : {}),
            ...(options.agentId ? { agentId: options.agentId } : {})
          })
        : undefined;
    const focus = this.resolveSessionFocus(state, events, liveFlowTargets, liveFlow, requestedSessionId);
    const materializer = new ReplayMaterializer(events);
    const session = materializer.getSession(focus.sessionId);
    const sessionManifests = focus.sessionId === state.currentSessionId ? manifests : await this.blobStore.listManifests(focus.sessionId);
    const sessionExceptions = normalizedExceptions
      .filter((item) => item.sessionId === focus.sessionId)
      .sort((left, right) => left.status.localeCompare(right.status) || right.severity.localeCompare(left.severity));
    const sessionTimeMachine = new ReplayMaterializer(session.events).buildTimeMachineEntries().slice(0, 12);
    const sponsorQueue = this.buildSponsorQueueState(sponsorQueueFile, focus.sessionId);
    const socialAnchorQueue = this.buildSocialAnchorQueueState(socialAnchorQueueFile, focus.sessionId);
    const profile = this.profileForSession(state, focus.sessionId, focus.trustModeId);
    const agentId = this.agentIdForSession(state, focus.sessionId, focus.trustModeId);
    const published = isSessionPublishedOnZeko({
      liveFlowTargets,
      socialAnchorQueueFile,
      sessionId: focus.sessionId,
      durablePublished: Boolean(state.publishedSessionsBySession[focus.sessionId])
    });
    const paymentsEnabled = profile.paymentProfile.enabled;
    const paymentProfileReady = hasReadyPaymentProfile(profile);
    const payoutAddressConfigured = hasPayoutAddress(profile);
    const paidJobsEnabled = computePaidJobsEnabled(profile, published, deployment);
    const ownership = this.ownershipForSession(state, focus.sessionId);
    const heartbeatRecord = runtimeHeartbeatFile.heartbeats.find((record) => record.sessionId === focus.sessionId);
    const heartbeat = this.buildAgentRuntimeHeartbeatState({
      state,
      sessionId: focus.sessionId,
      trustModeId: focus.trustModeId,
      ...(heartbeatRecord ? { record: heartbeatRecord } : {})
    });
    const relayProfile = isRelayDeliveryProfile(profile);
    const relayConnected = relayProfile && (this.relayRuntimeStatusProvider?.(agentId) ?? false);
    const availability = await this.checkPublicClawzAgentReachability({
      state,
      sessionId: focus.sessionId,
      profile,
      trustModeId: focus.trustModeId
    });
    const runtimeReachable = relayProfile ? relayConnected : availability.reachable;
    const adminAccess = this.buildAdminAccessState(
      state,
      focus.sessionId,
      options.adminKey,
      options.exposeIssuedAdminKey
    );
    const publicProfileView = Boolean(options.agentId || options.sessionId) && !adminAccess.hasAdminAccess;
    const readiness = buildAgentReadinessState({
      profile,
      ownership,
      published,
      relayConnected,
      runtimeReachable,
      heartbeat,
      paymentReady: hasReadyPaymentProfile(profile),
      paidExecutionProvenByHistory: hasVerifiedPaidExecutionForSession(hireRequestFile, focus.sessionId, {
        includePrivate: !publicProfileView
      }),
      lastJobStatus: lastHireStatusForSession(hireRequestFile, focus.sessionId, { includePrivate: !publicProfileView })
    });
    const completionScore = buildAgentCompletionScore(hireRequestFile, focus.sessionId);
    const jobActivityStats = buildAgentJobActivityStats(hireRequestFile, focus.sessionId);
    const protocolOwnerFeePolicy = buildProtocolOwnerFeePolicyFromEnv();
    const ingressAccess = this.buildIngressAccessState(
      state,
      focus.sessionId,
      options.exposeIssuedIngressToken,
      options.exposeIssuedSigningSecret
    );
    if (
      !adminAccess.hasAdminAccess &&
      (profile.availability === "suspended" ||
        profile.availability === "blocked" ||
        hasBlockedPublicTerm([profile.agentName, profile.representedPrincipal, profile.headline]))
    ) {
      throw new Error("This agent profile is not available on SantaClawz.");
    }
    const responseProfile = adminAccess.hasAdminAccess
      ? profile
      : {
          ...profile,
          openClawUrl: "",
          runtimeDelivery: {
            mode: profile.runtimeDelivery.mode
          }
        };
    const responseOwnership = adminAccess.hasAdminAccess
      ? ownership
      : {
          status: ownership.status,
          legacyRegistration: ownership.legacyRegistration,
          canReclaim: ownership.canReclaim
        };

    return {
      agentId,
      published,
      paymentsEnabled,
      paymentProfileReady,
      payoutAddressConfigured,
      paidJobsEnabled,
      readiness,
      completionScore,
      jobActivityStats,
      protocolOwnerFeePolicy,
      adminAccess,
      ingressAccess,
      wallet: {
        ...state.wallet,
        trustModeId: focus.trustModeId
      },
      trustModes: TRUST_MODE_PRESETS,
      ghostRun: buildGhostRunPlan(focus.trustModeId),
      privacyExceptions: sessionExceptions,
      timeMachine: sessionTimeMachine,
      session: {
        sessionId: focus.sessionId,
        eventCount: session.events.length,
        turnCount: session.turns.length,
        privacyExceptionCount: sessionExceptions.length,
        sealedArtifactCount: sessionManifests.length,
        focusSource: focus.focusSource,
        knownSessionIds: focus.knownSessionIds,
        ...(session.events.at(-1)?.occurredAtIso ? { lastEventAtIso: session.events.at(-1)!.occurredAtIso } : {})
      },
      artifacts: sessionManifests.map<ArtifactSummary>((manifest) => ({
        manifestId: manifest.manifestId,
        artifactClass: manifest.artifactClass,
        visibility: manifest.visibility,
        createdAtIso: manifest.createdAtIso,
        payloadDigest: manifest.payloadDigest
      })),
      deployment,
      liveFlowTargets,
      liveFlow,
      sponsorQueue,
      socialAnchorQueue,
      profile: responseProfile,
      ownership: responseOwnership
    };
  }

  async getAgentRuntimeAvailability(options: AgentRuntimeAvailabilityOptions): Promise<AgentRuntimeAvailabilityState> {
    const state = await this.loadState();
    const sessionId = this.resolveOwnedSessionId(state, options);
    const events = await this.loadEvents();
    const trustModeId = this.resolveSessionTrustMode(events, sessionId, state.activeMode);
    const profile = this.profileForSession(state, sessionId, trustModeId);
    const [heartbeatFile, hireRequestFile, deployment, liveFlow, socialAnchorQueueFile, reachability] = await Promise.all([
      this.loadRuntimeHeartbeatFile(),
      this.loadHireRequestFile(),
      this.getDeploymentState(),
      this.getLiveFlowState(),
      this.loadSocialAnchorQueueFile(),
      this.checkPublicClawzAgentReachability({
        state,
        sessionId,
        profile,
        trustModeId
      })
    ]);
    const heartbeatRecord = heartbeatFile.heartbeats.find((record) => record.sessionId === sessionId);
    const heartbeat = this.buildAgentRuntimeHeartbeatState({
      state,
      sessionId,
      trustModeId,
      ...(heartbeatRecord ? { record: heartbeatRecord } : {})
    });
    const relayAgentId = this.agentIdForSession(state, sessionId, trustModeId);
    const relayProfile = isRelayDeliveryProfile(profile);
    const relayConnected = relayProfile && (this.relayRuntimeStatusProvider?.(relayAgentId) ?? false);
    const runtimeStatus: AgentRuntimeStatus = relayConnected ? "live" : reachability.reachable ? heartbeat.status : "offline";
    const liveFlowTargets = this.buildLiveFlowTargets(events, liveFlow);
    const published = isSessionPublishedOnZeko({
      liveFlowTargets,
      socialAnchorQueueFile,
      sessionId,
      durablePublished: Boolean(state.publishedSessionsBySession[sessionId])
    });
    const ownership = this.ownershipForSession(state, sessionId);
    const readiness = buildAgentReadinessState({
      profile,
      ownership,
      published,
      relayConnected,
      runtimeReachable: relayProfile ? relayConnected : reachability.reachable,
      heartbeat,
      paymentReady: hasReadyPaymentProfile(profile),
      paidExecutionProvenByHistory: hasVerifiedPaidExecutionForSession(hireRequestFile, sessionId, { includePrivate: true }),
      lastJobStatus: lastHireStatusForSession(hireRequestFile, sessionId, { includePrivate: false })
    });
    const availabilityReason = relayProfile
      ? relayConnected
        ? "SantaClawz relay has an active outbound agent connection."
        : "SantaClawz relay is waiting for this agent to connect."
      : reachability.reason ?? "";
    return {
      ...reachability,
      reachable: relayProfile ? relayConnected : reachability.reachable,
      status: relayProfile ? relayConnected ? "online" : "offline" : reachability.status,
      reason: availabilityReason,
      runtimeStatus,
      heartbeat,
      readiness
    };
  }

  async recordAgentRuntimeHeartbeat(options: AgentRuntimeHeartbeatOptions): Promise<AgentRuntimeHeartbeatState> {
    const state = await this.loadState();
    const sessionId = this.resolveOwnedSessionId(state, options);
    this.assertAdminAccess(state, sessionId, options.adminKey);
    const events = await this.loadEvents();
    const trustModeId = this.resolveSessionTrustMode(events, sessionId, state.activeMode);
    const agentId = this.agentIdForSession(state, sessionId, trustModeId);
    const status: AgentRuntimeStatus =
      options.status === "waiting" || options.status === "offline" || options.status === "live"
        ? options.status
        : "live";
    const rawTtlSeconds =
      typeof options.ttlSeconds === "number" && Number.isFinite(options.ttlSeconds)
        ? Math.round(options.ttlSeconds)
        : AGENT_RUNTIME_HEARTBEAT_DEFAULT_TTL_SECONDS;
    const ttlSeconds = Math.max(
      AGENT_RUNTIME_HEARTBEAT_MIN_TTL_SECONDS,
      Math.min(rawTtlSeconds, AGENT_RUNTIME_HEARTBEAT_MAX_TTL_SECONDS)
    );
    const receivedAtIso = new Date().toISOString();
    const note = typeof options.note === "string" ? options.note.trim().slice(0, 240) : "";
    const relayAgentProtocolVersion =
      typeof options.relayAgentProtocolVersion === "string"
        ? options.relayAgentProtocolVersion.trim().slice(0, 80)
        : "";
    const relayAgentBuild =
      typeof options.relayAgentBuild === "string"
        ? options.relayAgentBuild.trim().slice(0, 80)
        : "";
    const relayAgentFeatures = Array.isArray(options.relayAgentFeatures)
      ? options.relayAgentFeatures
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim().slice(0, 80))
          .filter(Boolean)
          .slice(0, 20)
      : [];
    const relayAgentWorkerRoutes =
      options.relayAgentWorkerRoutes && typeof options.relayAgentWorkerRoutes === "object" && !Array.isArray(options.relayAgentWorkerRoutes)
        ? Object.fromEntries(
            Object.entries(options.relayAgentWorkerRoutes)
              .filter(([key, value]) => typeof key === "string" && typeof value === "string" && value.trim().length > 0)
              .map(([key, value]) => [key.trim().slice(0, 60), value.trim().slice(0, 500)])
              .slice(0, 8)
          )
        : {};
    const relayAgentWorkerWarnings = Array.isArray(options.relayAgentWorkerWarnings)
      ? options.relayAgentWorkerWarnings
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim().slice(0, 120))
          .filter(Boolean)
          .slice(0, 10)
      : [];
    let relayAgentWorkerTiming: AgentRuntimeHeartbeatRecord["relayAgentWorkerTiming"] | undefined;
    if (options.relayAgentWorkerTiming && typeof options.relayAgentWorkerTiming === "object" && !Array.isArray(options.relayAgentWorkerTiming)) {
      const executionMode: "sync" | "async" =
        options.relayAgentWorkerTiming.executionMode === "async" ? "async" : "sync";
      const timing: NonNullable<AgentRuntimeHeartbeatRecord["relayAgentWorkerTiming"]> = { executionMode };
      for (const key of ["configuredLocalHireTimeoutMs", "localHireTimeoutMs", "maxLocalHireTimeoutMs"] as const) {
        const value = Number(options.relayAgentWorkerTiming[key]);
        if (Number.isFinite(value) && value > 0) {
          timing[key] = Math.floor(Math.min(value, 600_000));
        }
      }
      relayAgentWorkerTiming = timing;
    }
    let paidExecutionProbe: AgentRuntimeHeartbeatRecord["paidExecutionProbe"] | undefined;
    if (options.paidExecutionProbe && typeof options.paidExecutionProbe === "object" && !Array.isArray(options.paidExecutionProbe)) {
      const checkedAtIso =
        typeof options.paidExecutionProbe.checkedAtIso === "string" && Number.isFinite(Date.parse(options.paidExecutionProbe.checkedAtIso))
          ? options.paidExecutionProbe.checkedAtIso
          : receivedAtIso;
      paidExecutionProbe = {
        attempted: options.paidExecutionProbe.attempted === true,
        ok: options.paidExecutionProbe.ok === true,
        checkedAtIso,
        ...(typeof options.paidExecutionProbe.requestId === "string"
          ? { requestId: options.paidExecutionProbe.requestId.trim().slice(0, 120) }
          : {}),
        ...(typeof options.paidExecutionProbe.localHireUrl === "string"
          ? { localHireUrl: options.paidExecutionProbe.localHireUrl.trim().slice(0, 500) }
          : {}),
        ...(typeof options.paidExecutionProbe.packageVerified === "boolean"
          ? { packageVerified: options.paidExecutionProbe.packageVerified }
          : {}),
        ...(typeof options.paidExecutionProbe.returnStatus === "string"
          ? { returnStatus: options.paidExecutionProbe.returnStatus.trim().slice(0, 80) }
          : {}),
        ...(typeof options.paidExecutionProbe.reason === "string"
          ? { reason: options.paidExecutionProbe.reason.trim().slice(0, 240) }
          : {})
      };
    }
    const file = await this.loadRuntimeHeartbeatFile();
    const existingRecord = file.heartbeats.find((record) => record.sessionId === sessionId);
    const effectiveRelayAgentWorkerTiming = relayAgentWorkerTiming ?? existingRecord?.relayAgentWorkerTiming;
    const effectivePaidExecutionProbe = paidExecutionProbe ?? existingRecord?.paidExecutionProbe;
    const nextRecord: AgentRuntimeHeartbeatRecord = {
      agentId,
      sessionId,
      status,
      receivedAtIso,
      ttlSeconds,
      ...(note ? { note } : {}),
      ...(relayAgentProtocolVersion ? { relayAgentProtocolVersion } : {}),
      ...(relayAgentBuild ? { relayAgentBuild } : {}),
      ...(relayAgentFeatures.length ? { relayAgentFeatures } : {}),
      ...(Object.keys(relayAgentWorkerRoutes).length ? { relayAgentWorkerRoutes } : {}),
      ...(relayAgentWorkerWarnings.length ? { relayAgentWorkerWarnings } : {}),
      ...(effectiveRelayAgentWorkerTiming ? { relayAgentWorkerTiming: effectiveRelayAgentWorkerTiming } : {}),
      ...(effectivePaidExecutionProbe ? { paidExecutionProbe: effectivePaidExecutionProbe } : {})
    };
    const existingReceivedAtMs = existingRecord ? Date.parse(existingRecord.receivedAtIso) : Number.NaN;
    const heartbeatCanCoalesce =
      existingRecord &&
      status === "live" &&
      existingRecord.status === "live" &&
      existingRecord.ttlSeconds === ttlSeconds &&
      (existingRecord.note ?? "") === (nextRecord.note ?? "") &&
      (existingRecord.relayAgentProtocolVersion ?? "") === (nextRecord.relayAgentProtocolVersion ?? "") &&
      (existingRecord.relayAgentBuild ?? "") === (nextRecord.relayAgentBuild ?? "") &&
      JSON.stringify(existingRecord.relayAgentFeatures ?? []) === JSON.stringify(nextRecord.relayAgentFeatures ?? []) &&
      JSON.stringify(existingRecord.relayAgentWorkerRoutes ?? {}) === JSON.stringify(nextRecord.relayAgentWorkerRoutes ?? {}) &&
      JSON.stringify(existingRecord.relayAgentWorkerWarnings ?? []) === JSON.stringify(nextRecord.relayAgentWorkerWarnings ?? []) &&
      JSON.stringify(existingRecord.relayAgentWorkerTiming ?? {}) === JSON.stringify(nextRecord.relayAgentWorkerTiming ?? {}) &&
      JSON.stringify(existingRecord.paidExecutionProbe ?? {}) === JSON.stringify(nextRecord.paidExecutionProbe ?? {}) &&
      Number.isFinite(existingReceivedAtMs) &&
      Date.parse(receivedAtIso) - existingReceivedAtMs < AGENT_RUNTIME_HEARTBEAT_WRITE_MIN_INTERVAL_MS;
    if (heartbeatCanCoalesce) {
      return this.buildAgentRuntimeHeartbeatState({
        state,
        sessionId,
        trustModeId,
        record: existingRecord
      }, receivedAtIso);
    }

    await this.saveRuntimeHeartbeatFile({
      heartbeats: [nextRecord, ...file.heartbeats.filter((record) => record.sessionId !== sessionId)].slice(0, 500)
    });

    return this.buildAgentRuntimeHeartbeatState({
      state,
      sessionId,
      trustModeId,
      record: nextRecord
    }, receivedAtIso);
  }

  async authenticateAgentRelayConnection(options: {
    agentId: string;
    adminKey?: string;
  }): Promise<{
    agentId: string;
    sessionId: string;
    serviceKey: string;
  }> {
    const state = await this.loadState();
    const sessionId = this.resolveSessionIdFromAgentId(state, options.agentId);
    if (!sessionId) {
      throw new Error(`Unknown agent: ${options.agentId}`);
    }
    this.assertAdminAccess(state, sessionId, options.adminKey);
    const profile = this.profileForSession(state, sessionId);
    if (!isRelayDeliveryProfile(profile)) {
      throw new Error("This agent is configured for self-hosted runtime URL delivery, not SantaClawz relay delivery.");
    }
    return {
      agentId: options.agentId,
      sessionId,
      serviceKey: enrolledServiceKeyForAgent(state.ingressSecretsBySession[sessionId], profile, options.agentId)
    };
  }

  async listRegisteredAgents(): Promise<AgentRegistryEntry[]> {
    const state = await this.loadState();
    const events = await this.loadEvents();
    const [liveFlow, deployment, socialAnchorQueueFile, runtimeHeartbeatFile, hireRequestFile] = await Promise.all([
      this.getLiveFlowState(),
      this.getDeploymentState(),
      this.loadSocialAnchorQueueFile(),
      this.loadRuntimeHeartbeatFile(),
      this.loadHireRequestFile()
    ]);
    const liveFlowTargets = this.buildLiveFlowTargets(events, liveFlow);
    const materializer = new ReplayMaterializer(events);
    const protocolOwnerFeePolicy = buildProtocolOwnerFeePolicyFromEnv();
    const proofRank = (proofLevel: AgentRegistryEntry["proofLevel"]) =>
      proofLevel === "proof-backed" ? 3 : proofLevel === "rooted" ? 2 : 1;

    return this.buildKnownSessionIds(state, events)
      .map((sessionId) => {
        const trustModeId = this.resolveSessionTrustMode(events, sessionId, state.activeMode);
        const trustMode = TRUST_MODE_PRESETS.find((mode) => mode.id === trustModeId) ?? TRUST_MODE_PRESETS[0]!;
        const profile = this.profileForSession(state, sessionId, trustModeId);
        const session = materializer.getSession(sessionId);
        const lastUpdatedAtIso = session.events.at(-1)?.occurredAtIso;
        const ownership = this.ownershipForSession(state, sessionId);
        const sessionAnchors = socialAnchorQueueFile.items.filter((item) => item.sessionId === sessionId);
        const published = isSessionPublishedOnZeko({
          liveFlowTargets,
          socialAnchorQueueFile,
          sessionId,
          durablePublished: Boolean(state.publishedSessionsBySession[sessionId])
        });
        const anchoredBatches = socialAnchorQueueFile.batches
          .filter((batch) => batch.status === "confirmed" && sessionAnchors.some((item) => item.batchId === batch.batchId))
          .sort((left, right) => right.settledAtIso.localeCompare(left.settledAtIso));
        const heartbeatRecord = runtimeHeartbeatFile.heartbeats.find((record) => record.sessionId === sessionId);
        const runtimeHeartbeat = this.buildAgentRuntimeHeartbeatState({
          state,
          sessionId,
          trustModeId,
          ...(heartbeatRecord ? { record: heartbeatRecord } : {})
        });
        const agentId = this.agentIdForSession(state, sessionId, trustModeId);
        const relayProfile = isRelayDeliveryProfile(profile);
        const relayConnected = relayProfile && (this.relayRuntimeStatusProvider?.(agentId) ?? false);
        const runtimeStatus: AgentRuntimeStatus = relayConnected
          ? "live"
          : relayProfile
            ? "offline"
            : runtimeHeartbeat.status;
        const runtimeStatusReason = relayConnected
          ? "SantaClawz relay has an active outbound agent connection."
          : relayProfile
            ? "SantaClawz relay is waiting for this agent to connect."
            : runtimeHeartbeat.reason;
        const paymentReady = hasReadyPaymentProfile(profile);
        const readiness = buildAgentReadinessState({
          profile,
          ownership,
          published,
          relayConnected,
          runtimeReachable: relayProfile ? relayConnected : runtimeHeartbeat.status === "live",
          heartbeat: runtimeHeartbeat,
          paymentReady,
          paidExecutionProvenByHistory: hasVerifiedPaidExecutionForSession(hireRequestFile, sessionId, { includePrivate: true }),
          lastJobStatus: lastHireStatusForSession(hireRequestFile, sessionId, { includePrivate: false })
        });
        const paidJobsEnabled = computePaidJobsEnabled(profile, published, deployment);
        const quoteReady = paymentReady && profile.paymentProfile.pricingMode === "quote-required";
        const paidExecutionReady =
          profile.paymentProfile.pricingMode === "free-test"
            ? readiness.hireable
            : paymentReady &&
              paidJobsEnabled &&
              readiness.paidExecutionProven === true &&
              readiness.hireable;
        const completionScore = buildAgentCompletionScore(hireRequestFile, sessionId);
        const jobActivityStats = buildAgentJobActivityStats(hireRequestFile, sessionId);
        const marketplaceTagStats = buildAgentMarketplaceTagStats(hireRequestFile, sessionId);
        return {
          agentId,
          sessionId,
          networkId: deployment.networkId,
          agentName: profile.agentName,
          representedPrincipal: profile.representedPrincipal,
          headline: profile.headline,
          publicAgentUrl: publicAgentUrlFor(agentId),
          publicHireUrl: publicAgentHireUrlFor(agentId),
          openClawUrl: "",
          runtimeDeliveryMode: profile.runtimeDelivery.mode,
          serviceKey: enrolledServiceKeyForAgent(state.ingressSecretsBySession[sessionId], profile, agentId),
          trustModeId,
          trustModeLabel: trustMode.label,
          proofLevel: trustMode.proofLevel,
          preferredProvingLocation: profile.preferredProvingLocation,
          paymentsEnabled: profile.paymentProfile.enabled,
          ...(protocolOwnerFeePolicy.enabled
            ? {
                protocolOwnerFeeBps: protocolOwnerFeePolicy.feeBps,
                protocolFeeApplies: Boolean(
                  protocolOwnerFeePolicy.appliesTo.includes("santaclawz-marketplace") &&
                    profile.paymentProfile.defaultRail &&
                    protocolOwnerFeePolicy.recipientByRail[profile.paymentProfile.defaultRail]
                )
              }
            : {}),
          ...(profile.paymentProfile.defaultRail ? { paymentRail: profile.paymentProfile.defaultRail } : {}),
          pricingMode: profile.paymentProfile.pricingMode,
          ...(profile.paymentProfile.fixedAmountUsd
            ? { fixedAmountUsd: profile.paymentProfile.fixedAmountUsd }
            : {}),
          ...(profile.paymentProfile.referencePriceUsd
            ? { referencePriceUsd: profile.paymentProfile.referencePriceUsd }
            : {}),
          ...(profile.paymentProfile.referencePriceUnit
            ? { referencePriceUnit: profile.paymentProfile.referencePriceUnit }
            : {}),
          settlementTrigger: profile.paymentProfile.settlementTrigger,
          payoutAddressConfigured: hasPayoutAddress(profile),
          paymentProfileReady: hasReadyPaymentProfile(profile),
          paidJobsEnabled,
          quoteReady,
          paidExecutionReady,
          missionAuthVerified: profile.missionAuthOverlay.status === "verified",
          ownershipVerified: ownership.status === "verified",
          availability: profile.availability,
          ...(profile.archivedAtIso ? { archivedAtIso: profile.archivedAtIso } : {}),
          runtimeStatus,
          runtimeStatusUpdatedAtIso: runtimeHeartbeat.checkedAtIso,
          ...(runtimeHeartbeat.lastHeartbeatAtIso ? { lastHeartbeatAtIso: runtimeHeartbeat.lastHeartbeatAtIso } : {}),
          ...(runtimeStatusReason ? { runtimeStatusReason } : {}),
          readiness,
          completionScore,
          jobActivityStats,
          marketplaceTags: sanitizeAgentMarketplaceTags(profile.marketplaceTags, emptyAgentMarketplaceTags()),
          marketplaceTagStats,
          published,
          pendingSocialAnchorCount: sessionAnchors.filter((item) => item.status === "pending").length,
          anchoredSocialFactCount: sessionAnchors.filter((item) => item.status === "confirmed").length,
          ...(anchoredBatches[0]?.settledAtIso ? { lastSocialAnchorAtIso: anchoredBatches[0].settledAtIso } : {}),
          ...(lastUpdatedAtIso ? { lastUpdatedAtIso } : {})
        } satisfies AgentRegistryEntry;
      })
      .filter(
        (entry) =>
          entry.availability === "active" &&
          this.profileForSession(state, entry.sessionId).openClawUrl.trim().length > 0 &&
          !hasBlockedPublicTerm([
            entry.agentName,
            entry.representedPrincipal,
            entry.headline,
            entry.serviceKey,
            ...agentMarketplaceTagValues(entry.marketplaceTags)
          ]) &&
          entry.agentName.trim().length > 0 &&
          entry.headline.trim().length > 0
      )
      .sort((left, right) => {
        if (left.published !== right.published) {
          return Number(right.published) - Number(left.published);
        }
        const byProof = proofRank(right.proofLevel) - proofRank(left.proofLevel);
        if (byProof !== 0) {
          return byProof;
        }
        const byUpdated = (right.lastUpdatedAtIso ?? "").localeCompare(left.lastUpdatedAtIso ?? "");
        if (byUpdated !== 0) {
          return byUpdated;
        }
        return left.agentName.localeCompare(right.agentName);
      });
  }

  private isPrivateProcurementIntent(intent: ProcurementIntentRecord) {
    return intent.jobPrivacy?.visibility === "private" || intent.preferredPrivacyModes.includes("private");
  }

  private sanitizedProcurementArtifactDelivery(delivery?: SantaClawzArtifactDeliveryPreference) {
    if (!delivery) {
      return undefined;
    }
    return {
      mode: delivery.mode,
      ...(delivery.scanPolicy ? { scanPolicy: delivery.scanPolicy } : {}),
      ...(typeof delivery.digestRequired === "boolean" ? { digestRequired: delivery.digestRequired } : {}),
      ...(typeof delivery.buyerAcceptanceRequired === "boolean" ? { buyerAcceptanceRequired: delivery.buyerAcceptanceRequired } : {}),
      ...(typeof delivery.localScanRequired === "boolean" ? { localScanRequired: delivery.localScanRequired } : {})
    };
  }

  private procurementBidPublicView(bid: ProcurementBidRecord) {
    const { idempotencyKeyHashSha256: _idempotencyKeyHashSha256, ...publicBid } = bid;
    return publicBid;
  }

  private procurementDeclinePublicView(decline: ProcurementDeclineRecord) {
    const { idempotencyKeyHashSha256: _idempotencyKeyHashSha256, ...publicDecline } = decline;
    return publicDecline;
  }

  private fullProcurementIntentView(intent: ProcurementIntentRecord) {
    const {
      buyerTokenHashSha256: _buyerTokenHashSha256,
      createIdempotencyKeyHashSha256: _createIdempotencyKeyHashSha256,
      ...publicIntent
    } = intent;
    return {
      ...publicIntent,
      bids: publicIntent.bids.map((bid) => this.procurementBidPublicView(bid)),
      declines: publicIntent.declines.map((decline) => this.procurementDeclinePublicView(decline))
    };
  }

  private publicProcurementIntent(intent: ProcurementIntentRecord) {
    if (!this.isPrivateProcurementIntent(intent)) {
      return this.fullProcurementIntentView(intent);
    }
    return {
      schemaVersion: intent.schemaVersion,
      intentId: intent.intentId,
      status: intent.status,
      createdAtIso: intent.createdAtIso,
      updatedAtIso: intent.updatedAtIso,
      ...(intent.budgetUsd ? { budgetUsd: intent.budgetUsd } : {}),
      ...(intent.deadlineIso ? { deadlineIso: intent.deadlineIso } : {}),
      ...(intent.bidWindowClosesAtIso ? { bidWindowClosesAtIso: intent.bidWindowClosesAtIso } : {}),
      privacy: {
        visibility: "private",
        activityAnchorMode: "anonymous",
        publicAggregateStats: true,
        publicLifecycleEvents: false,
        publicArtifactMetadata: false
      },
      publicSummary: "A private procurement intent is open on SantaClawz.",
      requiredCapabilities: intent.requiredCapabilities,
      preferredDeliveryModes: intent.preferredDeliveryModes,
      preferredPrivacyModes: intent.preferredPrivacyModes,
      ...(intent.marketplaceTags ? { marketplaceTags: intent.marketplaceTags } : {}),
      ...(this.sanitizedProcurementArtifactDelivery(intent.artifactDelivery)
        ? { artifactDelivery: this.sanitizedProcurementArtifactDelivery(intent.artifactDelivery) }
        : {}),
      bidCount: intent.bids.length,
      declineCount: intent.declines.length,
      ...(intent.selectedAgentId ? { selectedAgentId: intent.selectedAgentId } : {}),
      ...(intent.selectedBidId ? { selectedBidId: intent.selectedBidId } : {})
    };
  }

  private assertProcurementBuyerAccess(intent: ProcurementIntentRecord, token?: string) {
    if (!token?.trim() || sha256Hex(token.trim()) !== intent.buyerTokenHashSha256) {
      throw new Error("Procurement buyer token was rejected.");
    }
  }

  private procurementIdempotentBuyerToken(idempotencyKey: string) {
    const secret =
      process.env.CLAWZ_PROCUREMENT_IDEMPOTENCY_SECRET?.trim() ||
      process.env.CLAWZ_ADMIN_API_KEY?.trim() ||
      "santaclawz-local-procurement-idempotency";
    return `buy_${Buffer.from(createHmac("sha256", secret).update(idempotencyKey.trim()).digest("hex"), "hex").toString("base64url")}`;
  }

  private jobPackRouterSession(state: ConsolePersistenceState): { sessionId: string; agentId: string } | undefined {
    for (const [sessionId, profile] of Object.entries(state.profilesBySession)) {
      if (state.deletedAgentRegistrationsBySession[sessionId]) {
        continue;
      }
      const agentId = this.agentIdForSession(state, sessionId);
      const serviceKey = enrolledServiceKeyForAgent(state.ingressSecretsBySession[sessionId], profile, agentId);
      if (serviceKey === "agent_job_pack" || serviceKeyForAgent(profile, agentId) === "agent_job_pack") {
        return { sessionId, agentId };
      }
    }
    return undefined;
  }

  private async enqueueJobPackRoutingIntentAnchor(input: {
    intent: ProcurementIntentRecord;
    marketplaceTags: MarketplaceWorkTags;
  }) {
    const state = await this.loadState();
    const router = this.jobPackRouterSession(state);
    if (!router) {
      return undefined;
    }
    return this.enqueueSocialAnchorCandidate({
      sessionId: router.sessionId,
      kind: "operator-dispatch",
      title: "Job Pack routing intent opened",
      summary: `agent_job_pack opened a buyer routing intent with ${input.intent.requiredCapabilities.slice(0, 4).join(", ") || "general"} tags.`,
      payload: {
        schemaVersion: "santaclawz-routing-intent/1.0",
        routerAgentId: router.agentId,
        intentId: input.intent.intentId,
        budgetUsd: input.intent.budgetUsd ?? null,
        taskPromptDigestSha256: sha256Hex(input.intent.taskPrompt),
        requiredCapabilities: input.intent.requiredCapabilities,
        preferredDeliveryModes: input.intent.preferredDeliveryModes,
        preferredPrivacyModes: input.intent.preferredPrivacyModes,
        marketplaceTags: input.marketplaceTags,
        createdAtIso: input.intent.createdAtIso
      }
    });
  }

  async createBuyerRouterPlan(options: CreateBuyerRouterPlanOptions) {
    const taskPrompt = options.taskPrompt.trim().slice(0, 4000);
    if (!taskPrompt) {
      throw new Error("Buyer router plan requires taskPrompt.");
    }
    const budgetUsd = options.budgetUsd?.trim();
    if (budgetUsd) {
      assertUsdAmount(budgetUsd, "Buyer router budgetUsd");
    }
    const agents = await this.listRegisteredAgents();
    const state = await this.loadState();
    const router = this.jobPackRouterSession(state);
    const { plan, requestedTags, routerMessage } = buildJobPackBuyerRoutePlan({
      taskPrompt,
      agents,
      buyerMode: options.buyerMode === "agent" ? "agent" : "human",
      ...(options.privacyLane ? { privacyLane: options.privacyLane } : {}),
      ...(options.marketplaceTags ? { marketplaceTags: options.marketplaceTags } : {}),
      ...(options.selectedAgentId ? { selectedAgentId: options.selectedAgentId } : {}),
      ...(router ? { routerAgentId: router.agentId } : {})
    });
    const anchorCandidate = router
      ? await this.enqueueSocialAnchorCandidate({
          sessionId: router.sessionId,
          kind: "operator-dispatch",
          title: "Job Pack buyer route plan generated",
          summary: `agent_job_pack routed buyer work as ${plan.routingIntent} with ${requestedTags.slice(0, 4).join(", ") || "general"} tags.`,
          payload: {
            schemaVersion: "santaclawz-buyer-route-plan/1.0",
            routerAgentId: router.agentId,
            routePlanDigestSha256: plan.routePlanDigestSha256,
            taskPromptDigestSha256: sha256Hex(taskPrompt),
            buyerMode: plan.buyerMode,
            routingIntent: plan.routingIntent,
            marketplaceTags: plan.marketplaceTags,
            protocolLaneTags: plan.protocolLaneTags,
            deliveryFormatTags: plan.deliveryFormatTags,
            candidateAgentIds: plan.candidateAgents.map((candidate) => candidate.agentId),
            ...(budgetUsd ? { budgetUsd } : {}),
            generatedAtIso: plan.generatedAtIso
          }
        })
      : undefined;
    return {
      ok: true,
      plan,
      routerMessage,
      ...(anchorCandidate
        ? {
            routingAnchor: {
              candidateId: anchorCandidate.candidateId,
              status: anchorCandidate.status,
              payloadDigestSha256: anchorCandidate.payloadDigestSha256
            }
          }
        : {})
    };
  }

  async createProcurementIntent(options: CreateProcurementIntentOptions) {
    const taskPrompt = options.taskPrompt.trim().slice(0, 4000);
    const requesterContact = options.requesterContact.trim().slice(0, 240);
    if (!taskPrompt || !requesterContact) {
      throw new Error("Procurement intent requires taskPrompt and requesterContact.");
    }
    const budgetUsd = options.budgetUsd?.trim();
    if (budgetUsd) {
      assertUsdAmount(budgetUsd, "Procurement budgetUsd");
    }
    const idempotencyKey = options.idempotencyKey?.trim().slice(0, 160);
    const idempotencyKeyHash = idempotencyKey ? sha256Hex(idempotencyKey) : undefined;
    const file = await this.loadProcurementIntentFile();
    if (idempotencyKey && idempotencyKeyHash) {
      const existingIntent = file.intents.find((candidate) => candidate.createIdempotencyKeyHashSha256 === idempotencyKeyHash);
      if (existingIntent) {
        return {
          ok: true,
          idempotent: true,
          intent: this.fullProcurementIntentView(existingIntent),
          buyerToken: this.procurementIdempotentBuyerToken(idempotencyKey),
          buyerTokenUsage: "Use this token to accept a bid or close the procurement intent."
        };
      }
    }
    const nowIso = new Date().toISOString();
    const buyerToken = idempotencyKey ? this.procurementIdempotentBuyerToken(idempotencyKey) : randomBytes(32).toString("base64url");
    const marketplaceTags = sanitizeMarketplaceWorkTags(options.marketplaceTags);
    const intent: ProcurementIntentRecord = {
      schemaVersion: "santaclawz-procurement-intent/1.0",
      intentId: `proc_${randomUUID().replace(/-/g, "").slice(0, 18)}`,
      status: "open",
      taskPrompt,
      requesterContact,
      ...(budgetUsd ? { budgetUsd } : {}),
      ...(options.deadlineIso?.trim() ? { deadlineIso: options.deadlineIso.trim().slice(0, 40) } : {}),
      ...(options.bidWindowClosesAtIso?.trim() ? { bidWindowClosesAtIso: options.bidWindowClosesAtIso.trim().slice(0, 40) } : {}),
      requiredCapabilities: (options.requiredCapabilities ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 20),
      preferredDeliveryModes: (options.preferredDeliveryModes ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 10),
      preferredPrivacyModes: (options.preferredPrivacyModes ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 10),
      ...(!marketplaceWorkTagsAreEmpty(marketplaceTags) ? { marketplaceTags } : {}),
      ...(options.jobPrivacy ? { jobPrivacy: options.jobPrivacy } : {}),
      ...(options.artifactDelivery ? { artifactDelivery: options.artifactDelivery } : {}),
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      buyerTokenHashSha256: sha256Hex(buyerToken),
      ...(idempotencyKeyHash ? { createIdempotencyKeyHashSha256: idempotencyKeyHash } : {}),
      bids: [],
      declines: []
    };
    await this.saveProcurementIntentFile({ intents: [intent, ...file.intents].slice(0, 1000) });
    const routingAnchor = await this.enqueueJobPackRoutingIntentAnchor({ intent, marketplaceTags });
    return {
      ok: true,
      intent: this.fullProcurementIntentView(intent),
      buyerToken,
      buyerTokenUsage: "Use this token to accept a bid or close the procurement intent.",
      ...(routingAnchor
        ? {
            routingAnchor: {
              candidateId: routingAnchor.candidateId,
              status: routingAnchor.status,
              payloadDigestSha256: routingAnchor.payloadDigestSha256
            }
          }
        : {})
    };
  }

  async listProcurementIntents(options: { status?: ProcurementIntentStatus; limit?: number } = {}) {
    const limit = typeof options.limit === "number" && Number.isFinite(options.limit)
      ? Math.max(1, Math.min(Math.floor(options.limit), 200))
      : 100;
    const file = await this.loadProcurementIntentFile();
    const intents = file.intents
      .filter((intent) => !options.status || intent.status === options.status)
      .sort((left, right) => right.updatedAtIso.localeCompare(left.updatedAtIso))
      .slice(0, limit)
      .map((intent) => this.publicProcurementIntent(intent));
    return {
      schemaVersion: "santaclawz-procurement-intents/1.0",
      generatedAtIso: new Date().toISOString(),
      totalIntentCount: file.intents.length,
      intents
    };
  }

  async getProcurementIntent(intentId: string, options: { token?: string } = {}) {
    const trimmed = intentId.trim();
    const intent = (await this.loadProcurementIntentFile()).intents.find((candidate) => candidate.intentId === trimmed);
    if (!intent) {
      throw new Error(`Unknown procurement intent: ${trimmed}`);
    }
    return {
      ok: true,
      intent: options.token?.trim() && sha256Hex(options.token.trim()) === intent.buyerTokenHashSha256
        ? this.fullProcurementIntentView(intent)
        : this.publicProcurementIntent(intent)
    };
  }

  async submitProcurementBid(options: SubmitProcurementBidOptions) {
    const file = await this.loadProcurementIntentFile();
    const intent = file.intents.find((candidate) => candidate.intentId === options.intentId.trim());
    if (!intent) {
      throw new Error(`Unknown procurement intent: ${options.intentId}`);
    }
    if (intent.status !== "open") {
      throw new Error(`Procurement intent ${intent.intentId} is not open.`);
    }
    const state = await this.loadState();
    const sessionId = this.resolveOwnedSessionId(state, { agentId: options.agentId });
    this.assertAdminAccess(state, sessionId, options.adminKey);
    const profile = this.profileForSession(state, sessionId);
    const amountUsd = options.amountUsd.trim();
    assertUsdAmount(amountUsd, "Procurement bid amountUsd");
    const idempotencyKeyHash = options.idempotencyKey?.trim()
      ? sha256Hex(`${intent.intentId}:bid:${sessionId}:${options.idempotencyKey.trim().slice(0, 160)}`)
      : undefined;
    if (idempotencyKeyHash) {
      const existingIdempotentBid = intent.bids.find((bid) => bid.idempotencyKeyHashSha256 === idempotencyKeyHash);
      if (existingIdempotentBid) {
        return {
          ok: true,
          idempotent: true,
          intent: this.publicProcurementIntent(intent),
          bid: this.fullProcurementIntentView({
            ...intent,
            bids: [existingIdempotentBid],
            declines: []
          }).bids[0]!
        };
      }
    }
    const nowIso = new Date().toISOString();
    const existingBid = intent.bids.find((bid) => bid.agentId === options.agentId && bid.status === "submitted");
    const bid: ProcurementBidRecord = {
      bidId: existingBid?.bidId ?? `bid_${randomUUID().replace(/-/g, "").slice(0, 18)}`,
      agentId: options.agentId,
      sessionId,
      ...(idempotencyKeyHash ? { idempotencyKeyHashSha256: idempotencyKeyHash } : existingBid?.idempotencyKeyHashSha256 ? { idempotencyKeyHashSha256: existingBid.idempotencyKeyHashSha256 } : {}),
      amountUsd,
      pricingMode: profile.paymentProfile.pricingMode,
      summary: options.summary.trim().slice(0, 1200),
      ...(options.estimatedDeliveryIso?.trim() ? { estimatedDeliveryIso: options.estimatedDeliveryIso.trim().slice(0, 40) } : {}),
      deliveryModes: (options.deliveryModes ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 10),
      privacyModes: (options.privacyModes ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 10),
      createdAtIso: existingBid?.createdAtIso ?? nowIso,
      updatedAtIso: nowIso,
      status: "submitted"
    };
    const nextIntent: ProcurementIntentRecord = {
      ...intent,
      updatedAtIso: nowIso,
      bids: existingBid
        ? intent.bids.map((candidate) => candidate.bidId === existingBid.bidId ? bid : candidate)
        : [bid, ...intent.bids].slice(0, 200),
      declines: intent.declines.filter((decline) => decline.agentId !== options.agentId)
    };
    await this.saveProcurementIntentFile({
      intents: file.intents.map((candidate) => candidate.intentId === intent.intentId ? nextIntent : candidate)
    });
    const publicIntent = this.publicProcurementIntent(nextIntent);
    return {
      ok: true,
      intent: publicIntent,
      bid: this.procurementBidPublicView(bid)
    };
  }

  async declineProcurementIntent(options: DeclineProcurementIntentOptions) {
    const file = await this.loadProcurementIntentFile();
    const intent = file.intents.find((candidate) => candidate.intentId === options.intentId.trim());
    if (!intent) {
      throw new Error(`Unknown procurement intent: ${options.intentId}`);
    }
    const state = await this.loadState();
    const sessionId = this.resolveOwnedSessionId(state, { agentId: options.agentId });
    this.assertAdminAccess(state, sessionId, options.adminKey);
    const idempotencyKeyHash = options.idempotencyKey?.trim()
      ? sha256Hex(`${intent.intentId}:decline:${sessionId}:${options.idempotencyKey.trim().slice(0, 160)}`)
      : undefined;
    if (idempotencyKeyHash) {
      const existingIdempotentDecline = intent.declines.find((decline) => decline.idempotencyKeyHashSha256 === idempotencyKeyHash);
      if (existingIdempotentDecline) {
        return {
          ok: true,
          idempotent: true,
          intent: this.publicProcurementIntent(intent),
          decline: this.fullProcurementIntentView({
            ...intent,
            bids: [],
            declines: [existingIdempotentDecline]
          }).declines[0]!
        };
      }
    }
    const nowIso = new Date().toISOString();
    const decline: ProcurementDeclineRecord = {
      agentId: options.agentId,
      sessionId,
      ...(idempotencyKeyHash ? { idempotencyKeyHashSha256: idempotencyKeyHash } : {}),
      ...(options.reason?.trim() ? { reason: options.reason.trim().slice(0, 400) } : {}),
      createdAtIso: nowIso
    };
    const nextIntent: ProcurementIntentRecord = {
      ...intent,
      updatedAtIso: nowIso,
      declines: [decline, ...intent.declines.filter((item) => item.agentId !== options.agentId)].slice(0, 200)
    };
    await this.saveProcurementIntentFile({
      intents: file.intents.map((candidate) => candidate.intentId === intent.intentId ? nextIntent : candidate)
    });
    const publicIntent = this.publicProcurementIntent(nextIntent);
    return {
      ok: true,
      intent: publicIntent,
      decline: this.procurementDeclinePublicView(decline)
    };
  }

  async acceptProcurementBid(options: AcceptProcurementBidOptions) {
    const file = await this.loadProcurementIntentFile();
    const intent = file.intents.find((candidate) => candidate.intentId === options.intentId.trim());
    if (!intent) {
      throw new Error(`Unknown procurement intent: ${options.intentId}`);
    }
    this.assertProcurementBuyerAccess(intent, options.token);
    if (intent.status === "awarded" && intent.selectedBidId === options.bidId.trim() && intent.award) {
      const selectedBid = intent.bids.find((bid) => bid.bidId === intent.selectedBidId);
      if (!selectedBid) {
        throw new Error(`Unknown awarded procurement bid: ${options.bidId}`);
      }
      return {
        ok: true,
        idempotent: true,
        intent: this.fullProcurementIntentView(intent),
        selectedBid,
        nextAction: {
          type: "submit_hire_request",
          agentId: selectedBid.agentId,
          hireApiPath: intent.award.hireApiPath,
          publicHireUrl: intent.award.publicHireUrl,
          body: intent.award.suggestedHireBody
        }
      };
    }
    if (intent.status !== "open") {
      throw new Error(`Procurement intent ${intent.intentId} is not open.`);
    }
    const selectedBid = intent.bids.find((bid) => bid.bidId === options.bidId.trim() && bid.status === "submitted");
    if (!selectedBid) {
      throw new Error(`Unknown active procurement bid: ${options.bidId}`);
    }
    const nowIso = new Date().toISOString();
    const hireApiPath = `/api/agents/${encodeURIComponent(selectedBid.agentId)}/hire`;
    const nextIntent: ProcurementIntentRecord = {
      ...intent,
      status: "awarded",
      updatedAtIso: nowIso,
      selectedBidId: selectedBid.bidId,
      selectedAgentId: selectedBid.agentId,
      bids: intent.bids.map((bid) => ({
        ...bid,
        status: bid.bidId === selectedBid.bidId ? "accepted" : "rejected",
        updatedAtIso: nowIso
      })),
      award: {
        awardedAtIso: nowIso,
        publicHireUrl: publicAgentHireUrlFor(selectedBid.agentId),
        hireApiPath,
        suggestedHireBody: {
          taskPrompt: intent.taskPrompt,
          requesterContact: intent.requesterContact,
          ...(intent.marketplaceTags ? { marketplaceTags: intent.marketplaceTags } : {}),
          ...(intent.jobPrivacy ? { jobPrivacy: intent.jobPrivacy } : {}),
          ...(intent.artifactDelivery ? { artifactDelivery: intent.artifactDelivery } : {})
        }
      }
    };
    await this.saveProcurementIntentFile({
      intents: file.intents.map((candidate) => candidate.intentId === intent.intentId ? nextIntent : candidate)
    });
    const award = nextIntent.award!;
    const acceptedBid = nextIntent.bids.find((bid) => bid.bidId === selectedBid.bidId)!;
    return {
      ok: true,
      intent: this.fullProcurementIntentView(nextIntent),
      selectedBid: acceptedBid,
      nextAction: {
        type: "submit_hire_request",
        agentId: acceptedBid.agentId,
        hireApiPath,
        publicHireUrl: publicAgentHireUrlFor(acceptedBid.agentId),
        body: award.suggestedHireBody
      }
    };
  }

  async listEvents(options: EventListOptions = {}): Promise<ClawzEvent[]> {
    return this.filterEvents(await this.loadEvents(), options);
  }

  async getSession(sessionId: string) {
    return new ReplayMaterializer(await this.loadEvents()).getSession(sessionId);
  }

  async getTurnReplay(turnId: string) {
    return new ReplayMaterializer(await this.loadEvents()).getTurnReplay(turnId);
  }

  async listPrivacyExceptions(sessionId?: string): Promise<PrivacyExceptionQueueItem[]> {
    const state = await this.loadState();
    const items = this.normalizePrivacyExceptions(state);
    return sessionId ? items.filter((item) => item.sessionId === sessionId) : items;
  }

  async listSponsorQueue(sessionId?: string): Promise<SponsorQueueState> {
    return this.getSponsorQueueState(sessionId);
  }

  async issueEnrollmentTicket(options: RegisterAgentOptions): Promise<EnrollmentTicketIssueResult> {
    const state = await this.loadState();
    const deployment = await this.getDeploymentState();
    const issuedAtIso = new Date().toISOString();
    const expiresAtIso = new Date(Date.parse(issuedAtIso) + ENROLLMENT_TICKET_TTL_MS).toISOString();
    const requestedProfile = this.buildEnrollmentTicketProfile(options, deployment);
    const requestedSalt = normalizeUrlReservationSalt(options.urlReservationSalt);
    const reservedSessionId = `session_agent_${requestedSalt ?? randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const reservedAgentId = buildStableAgentId(requestedProfile.agentName, reservedSessionId);
    const reservedAgentIdAlreadyRegistered = Object.values(state.agentIdsBySession).includes(reservedAgentId);
    const reservedAgentIdAlreadyPending = Object.values(state.enrollmentTicketsById).some(
      (record) => record.status === "pending" && record.reservedAgentId === reservedAgentId
    );
    if (reservedAgentIdAlreadyRegistered || reservedAgentIdAlreadyPending) {
      throw new Error("That auto-generated SantaClawz URL is already reserved. Change the agent name or refresh the page for a new salt.");
    }
    const publicAgentUrl = publicAgentUrlFor(reservedAgentId);
    const publicHireUrl = publicAgentHireUrlFor(reservedAgentId);
    const requestedOpenClawUrl = requestedProfile.openClawUrl?.trim() ?? "";
    const profile: RegisterAgentOptions = requestedOpenClawUrl.length > 0
      ? {
          ...requestedProfile,
          openClawUrl: requestedOpenClawUrl,
          runtimeDelivery: {
            mode: "self-hosted",
            runtimeIngressUrl: requestedOpenClawUrl
          }
        }
      : {
          ...requestedProfile,
          openClawUrl: publicAgentUrl,
          runtimeDelivery: {
            mode: "santaclawz-relay"
          }
        };
    await this.assertAgentProfileIsValid(state, this.sanitizeProfileInput(profile.trustModeId ?? "private", profile, buildDefaultProfile(profile.trustModeId ?? "private")));

    const ticketId = buildEnrollmentTicketId();
    const ticketSecret = buildEnrollmentTicketSecret();
    const ticket = buildEnrollmentTicketToken(ticketId, ticketSecret);
    const ticketHash = sha256Hex(ticket);
    const record: EnrollmentTicketRecord = {
      ticketId,
      ticketHash,
      issuedAtIso,
      expiresAtIso,
      status: "pending",
      reservedSessionId,
      reservedAgentId,
      publicAgentUrl,
      publicHireUrl,
      profile
    };
    const nextState: ConsolePersistenceState = {
      ...state,
      enrollmentTicketsById: {
        ...state.enrollmentTicketsById,
        [ticketId]: record
      }
    };

    await this.saveState(nextState);

    return {
      ticket,
      ticketId,
      issuedAtIso,
      expiresAtIso,
      reservedSessionId,
      reservedAgentId,
      publicAgentUrl,
      publicHireUrl,
      challengePath: PUBLICCLAWZ_OWNERSHIP_CHALLENGE_PATH,
      enrollmentChallenge: {
        schemaVersion: ENROLLMENT_TICKET_SCHEMA_VERSION,
        ticketId,
        ticketDigestSha256: ticketHash,
        challengePath: PUBLICCLAWZ_OWNERSHIP_CHALLENGE_PATH,
        publicAgentUrl,
        publicHireUrl
      }
    };
  }

  async redeemEnrollmentTicket(ticket: string, options: { openClawUrl?: string }): Promise<EnrollmentTicketRedeemResult> {
    const parsedTicket = parseEnrollmentTicketToken(ticket);
    const state = await this.loadState();
    const record = state.enrollmentTicketsById[parsedTicket.ticketId];
    if (!record) {
      throw new Error("Enrollment ticket was not found.");
    }
    if (record.status !== "pending") {
      throw new Error("Enrollment ticket has already been redeemed.");
    }
    if (Date.parse(record.expiresAtIso) <= Date.now()) {
      throw new Error("Enrollment ticket expired. Create a fresh ticket from SantaClawz.");
    }
    if (!timingSafeEqualHex(record.ticketHash, sha256Hex(parsedTicket.ticket))) {
      throw new Error("Enrollment ticket secret was rejected.");
    }

    const openClawUrl = options.openClawUrl?.trim() ?? "";
    const usesSelfHostedIngress = openClawUrl.length > 0;
    const profileForRegistration: RegisterAgentOptions = {
      ...record.profile,
      ...(usesSelfHostedIngress
        ? {
            openClawUrl,
            runtimeDelivery: {
              mode: "self-hosted",
              runtimeIngressUrl: openClawUrl
            }
          }
        : {
            runtimeDelivery: {
              mode: "santaclawz-relay"
            }
          })
    };

    if (usesSelfHostedIngress) {
      await this.assertEnrollmentTicketChallengeServed(record, parsedTicket.ticket, openClawUrl);
    }

    const registeredState = await this.registerAgent(profileForRegistration, {
      sessionId: record.reservedSessionId,
      agentId: record.reservedAgentId
    });
    const sessionId = registeredState.session.sessionId;
    const agentId = registeredState.agentId;
    const issuedAdminKey = registeredState.adminAccess.issuedAdminKey;
    const ingressAccess = registeredState.ingressAccess;
    if (!issuedAdminKey || !ingressAccess) {
      throw new Error("Enrollment registered the agent but did not receive required admin or ingress secrets.");
    }

    const challengeResult = usesSelfHostedIngress
      ? await this.issueOwnershipChallenge({
          sessionId,
          agentId,
          adminKey: issuedAdminKey
        })
      : undefined;
    const redeemedAtIso = new Date().toISOString();
    const stateBeforeTicketRedeemSave = await this.loadState();
    await this.saveState({
      ...stateBeforeTicketRedeemSave,
      enrollmentTicketsById: {
        ...stateBeforeTicketRedeemSave.enrollmentTicketsById,
        [record.ticketId]: {
          ...record,
          profile: profileForRegistration,
          status: "redeemed",
          redeemedAtIso,
          redeemedSessionId: sessionId,
          redeemedAgentId: agentId
        }
      }
    });

    if (!usesSelfHostedIngress) {
      await this.verifyRelayEnrollmentOwnership({
        sessionId,
        agentId,
        ticketId: record.ticketId,
        publicAgentUrl: record.publicAgentUrl,
        verifiedAtIso: redeemedAtIso
      });
    }

    const redeemedState = await this.getConsoleState({
      sessionId,
      adminKey: issuedAdminKey,
      exposeIssuedAdminKey: issuedAdminKey,
      ...(ingressAccess.issuedIngressToken ? { exposeIssuedIngressToken: ingressAccess.issuedIngressToken } : {}),
      ...(ingressAccess.issuedSigningSecret ? { exposeIssuedSigningSecret: ingressAccess.issuedSigningSecret } : {})
    });

    return {
      ...redeemedState,
      ...(challengeResult ? { issuedOwnershipChallenge: challengeResult.issuedOwnershipChallenge } : {})
    };
  }

  async registerAgent(options: RegisterAgentOptions, reservedIds?: { sessionId: string; agentId: string }): Promise<ConsoleStateResponse> {
    const state = await this.loadState();
    const deployment = await this.getDeploymentState();
    const registeredAtIso = new Date().toISOString();
    const trustModeId = options.trustModeId ?? "private";
    const sessionId = reservedIds?.sessionId ?? `session_agent_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const fallbackProfile = buildDefaultProfile(trustModeId);
    const profile = this.coerceProfileForDeployment(this.sanitizeProfileInput(
      trustModeId,
      {
        agentName: options.agentName,
        headline: options.headline,
        ...(options.openClawUrl ? { openClawUrl: options.openClawUrl } : {}),
        ...(options.runtimeDelivery ? { runtimeDelivery: options.runtimeDelivery } : {}),
        ...(options.payoutWallets ? { payoutWallets: options.payoutWallets } : {}),
        ...(options.missionAuthOverlay ? { missionAuthOverlay: options.missionAuthOverlay } : {}),
        ...(options.paymentProfile ? { paymentProfile: options.paymentProfile } : {}),
        ...(options.marketplaceTags ? { marketplaceTags: options.marketplaceTags } : {}),
        ...(options.socialAnchorPolicy ? { socialAnchorPolicy: options.socialAnchorPolicy } : {}),
        ...(options.payoutAddress ? { payoutAddress: options.payoutAddress } : {}),
        ...(options.representedPrincipal ? { representedPrincipal: options.representedPrincipal } : {}),
        ...(options.preferredProvingLocation ? { preferredProvingLocation: options.preferredProvingLocation } : {})
      },
      fallbackProfile
    ), deployment);

    if (profile.agentName.trim().length === 0 || profile.headline.trim().length === 0 || profile.openClawUrl.trim().length === 0) {
      throw new Error("agentName, headline, and openClawUrl are required.");
    }
    await this.assertAgentProfileIsValid(state, profile);
    if (!isRelayDeliveryProfile(profile)) {
      await this.validatePublicClawzAgentHealth(profile.openClawUrl);
    }

    const agentId = reservedIds?.agentId ?? buildStableAgentId(profile.agentName, sessionId);
    const serviceKey = serviceKeyForAgent(profile, agentId);
    const adminKey = buildAdminKey();
    const ingressToken = buildIngressToken();
    const signingSecret = buildIngressSigningSecret();
    const nextState: ConsolePersistenceState = {
      ...this.applyFocusedSession(state, sessionId, trustModeId),
      agentIdsBySession: {
        ...state.agentIdsBySession,
        [sessionId]: agentId
      },
      profilesBySession: {
        ...state.profilesBySession,
        [sessionId]: profile
      },
      adminKeysBySession: {
        ...state.adminKeysBySession,
        [sessionId]: {
          keyHash: adminKeyHash(adminKey),
          keyHint: adminKeyHint(adminKey),
          issuedAtIso: registeredAtIso
        }
      },
      ingressSecretsBySession: {
        ...state.ingressSecretsBySession,
        [sessionId]: {
          token: ingressToken,
          tokenHint: ingressTokenHint(ingressToken),
          signingSecret,
          signingSecretHint: ingressTokenHint(signingSecret),
          serviceKey,
          issuedAtIso: registeredAtIso
        }
      },
      ownershipBySession: {
        ...state.ownershipBySession,
        [sessionId]: buildDefaultOwnershipRecord(false)
      }
    };

    await this.saveState(nextState);
    await this.appendEvent(
      "SessionCreated",
      {
        sessionId,
        tenantId: DEFAULT_TENANT_ID,
        trustMode: trustModeId,
        registrationSource: "self-serve",
        representedPrincipal: profile.representedPrincipal
      },
      registeredAtIso
    );
    await this.appendEvent(
      "SessionCheckpointed",
      {
        sessionId,
        agentId,
        registeredAgent: true
      },
      registeredAtIso
    );
    await this.enqueueSocialAnchorCandidate({
      sessionId,
      kind: "agent-registered",
      summary: `${profile.agentName} joined SantaClawz and is preparing to publish on Zeko.`,
      occurredAtIso: registeredAtIso,
      payload: {
        agentId,
        agentName: profile.agentName,
        representedPrincipal: profile.representedPrincipal,
        openClawUrl: profile.openClawUrl,
        ...(!agentMarketplaceTagsAreEmpty(profile.marketplaceTags)
          ? {
              marketplaceTags: profile.marketplaceTags,
              marketplaceTagDigestSha256: marketplaceTagsDigest(profile.marketplaceTags)
            }
          : {})
      }
    });
    await this.enqueueMarketplaceTagDeclarationAnchor(sessionId, profile, registeredAtIso);
    await this.enqueueSocialAnchorCandidate({
      sessionId,
      kind: "operator-dispatch",
      summary: profile.headline,
      occurredAtIso: registeredAtIso,
      payload: {
        agentId,
        agentName: profile.agentName,
        headline: profile.headline
      }
    });

    return this.getConsoleState({
      sessionId,
      adminKey,
      exposeIssuedAdminKey: adminKey,
      exposeIssuedIngressToken: ingressToken,
      exposeIssuedSigningSecret: signingSecret
    });
  }

  async issueOwnershipChallenge(options: OwnershipActionOptions = {}): Promise<OwnershipChallengeIssueResult> {
    const state = await this.loadState();
    const sessionId = this.resolveOwnedSessionId(state, options);

    const profile = this.profileForSession(state, sessionId);
    if (isRelayDeliveryProfile(profile)) {
      throw new Error("This agent uses the SantaClawz relay. Ownership is verified when the enrollment ticket is redeemed by the agent.");
    }
    if (!profile.openClawUrl.trim()) {
      throw new Error("This agent still needs a PublicClawz agent URL before ownership can be verified.");
    }

    const issuedAtIso = new Date().toISOString();
    const challenge = this.buildOwnershipChallengeRecord(profile.openClawUrl, issuedAtIso);
    const prior = this.ownershipRecordForSession(state, sessionId);
    const nextRecord: SessionOwnershipRecord = {
      ...prior,
      status: "challenge-issued",
      canReclaim: prior.canReclaim || prior.legacyRegistration,
      challenge
    };
    const nextState: ConsolePersistenceState = {
      ...state,
      ownershipBySession: {
        ...state.ownershipBySession,
        [sessionId]: nextRecord
      }
    };

    await this.saveState(nextState);
    await this.appendEvent(
      "SessionCheckpointed",
      {
        sessionId,
        ownershipChallengeIssued: true,
        ownershipChallengeId: challenge.challengeId
      },
      issuedAtIso
    );

    const challengePayload = this.challengePayloadForSession(nextState, sessionId, challenge);

    return {
      state: await this.getConsoleState({
        sessionId,
        ...(options.adminKey ? { adminKey: options.adminKey } : {})
      }),
      issuedOwnershipChallenge: {
        challengeId: challenge.challengeId,
        challengePath: challenge.challengePath,
        challengeUrl: challenge.challengeUrl,
        verificationMethod: challenge.verificationMethod,
        issuedAtIso: challenge.issuedAtIso,
        expiresAtIso: challenge.expiresAtIso,
        challengeToken: challenge.challengeToken,
        challengeResponseJson: JSON.stringify(challengePayload, null, 2)
      }
    };
  }

  async verifyOwnershipChallenge(options: OwnershipActionOptions = {}): Promise<ConsoleStateResponse> {
    const state = await this.loadState();
    const sessionId = this.resolveOwnedSessionId(state, options);

    const profile = this.profileForSession(state, sessionId);
    if (isRelayDeliveryProfile(profile)) {
      throw new Error("This agent uses the SantaClawz relay. Ownership is verified when the enrollment ticket is redeemed by the agent.");
    }
    if (!profile.openClawUrl.trim()) {
      throw new Error("This agent still needs a PublicClawz agent URL before ownership can be verified.");
    }

    const ownership = this.ownershipRecordForSession(state, sessionId);
    const challenge = ownership.challenge;
    if (!challenge) {
      throw new Error("Issue an ownership challenge first.");
    }
    if (Date.parse(challenge.expiresAtIso) <= Date.now()) {
      throw new Error("The ownership challenge expired. Issue a new challenge.");
    }

    const challengeResult = await this.fetchOwnershipChallengeResponse(challenge);
    if (!challengeResult.matched) {
      throw new Error(
        `The PublicClawz endpoint did not return the expected SantaClawz challenge at ${challenge.challengePath}.`
      );
    }

    const verifiedAtIso = new Date().toISOString();
    const challengeResponseDigestSha256 = canonicalDigest(challengeResult.parsed).sha256Hex;
    const verificationMethod = challenge.verificationMethod;
    const attestationDigestSha256 = canonicalDigest({
      sessionId,
      agentId: this.agentIdForSession(state, sessionId),
      publicClawzUrl: profile.openClawUrl,
      challengeId: challenge.challengeId,
      challengePath: challenge.challengePath,
      challengeUrl: challenge.challengeUrl,
      verificationMethod,
      challengeResponseDigestSha256,
      verifiedAtIso
    }).sha256Hex;
    const adminHadAccess = this.hasAdminAccess(state, sessionId, options.adminKey);
    const issuedAdminKey = adminHadAccess ? undefined : buildAdminKey();
    const verification: AgentOwnershipVerificationState = {
      challengeId: challenge.challengeId,
      challengePath: challenge.challengePath,
      challengeUrl: challenge.challengeUrl,
      verificationMethod,
      verifiedAtIso,
      verifiedPublicClawzUrl: profile.openClawUrl,
      challengeResponseDigestSha256,
      attestationDigestSha256,
      ...(!adminHadAccess ? { reclaimedAtIso: verifiedAtIso } : {})
    };
    const nextState: ConsolePersistenceState = {
      ...state,
      adminKeysBySession:
        issuedAdminKey
          ? {
              ...state.adminKeysBySession,
              [sessionId]: {
                keyHash: adminKeyHash(issuedAdminKey),
                keyHint: adminKeyHint(issuedAdminKey),
                issuedAtIso: verifiedAtIso
              }
            }
          : state.adminKeysBySession,
      ownershipBySession: {
        ...state.ownershipBySession,
        [sessionId]: {
          status: "verified",
          legacyRegistration: ownership.legacyRegistration,
          canReclaim: false,
          verification
        }
      }
    };

    await this.saveState(nextState);
    await this.appendEvent(
      "SessionCheckpointed",
      {
        sessionId,
        ownershipVerified: true,
        ownershipChallengeId: challenge.challengeId,
        ...(issuedAdminKey ? { ownershipReclaimed: true } : {})
      },
      verifiedAtIso
    );
    await this.enqueueSocialAnchorCandidate({
      sessionId,
      kind: "ownership-verified",
      summary: `${profile.agentName} proved control of its PublicClawz endpoint.`,
      occurredAtIso: verifiedAtIso,
      payload: {
        agentId: this.agentIdForSession(state, sessionId),
        challengeId: challenge.challengeId,
        attestationDigestSha256,
        verifiedPublicClawzUrl: profile.openClawUrl
      }
    });

    return this.getConsoleState({
      sessionId,
      ...(issuedAdminKey
        ? {
            adminKey: issuedAdminKey,
            exposeIssuedAdminKey: issuedAdminKey
          }
        : options.adminKey
          ? { adminKey: options.adminKey }
          : {})
    });
  }

  private async verifyRelayEnrollmentOwnership(input: {
    sessionId: string;
    agentId: string;
    ticketId: string;
    publicAgentUrl: string;
    verifiedAtIso: string;
  }) {
    const state = await this.loadState();
    const profile = this.profileForSession(state, input.sessionId);
    const challengeResponseDigestSha256 = canonicalDigest({
      ticketId: input.ticketId,
      agentId: input.agentId,
      publicAgentUrl: input.publicAgentUrl,
      runtimeDeliveryMode: "santaclawz-relay"
    }).sha256Hex;
    const attestationDigestSha256 = canonicalDigest({
      sessionId: input.sessionId,
      agentId: input.agentId,
      publicClawzUrl: input.publicAgentUrl,
      challengeId: input.ticketId,
      challengePath: "/api/agent-relay/connect",
      challengeUrl: input.publicAgentUrl,
      verificationMethod: "santaclawz-relay-ticket",
      challengeResponseDigestSha256,
      verifiedAtIso: input.verifiedAtIso
    }).sha256Hex;
    const verification: AgentOwnershipVerificationState = {
      challengeId: input.ticketId,
      challengePath: "/api/agent-relay/connect",
      challengeUrl: input.publicAgentUrl,
      verificationMethod: "santaclawz-relay-ticket",
      verifiedAtIso: input.verifiedAtIso,
      verifiedPublicClawzUrl: input.publicAgentUrl,
      challengeResponseDigestSha256,
      attestationDigestSha256
    };
    await this.saveState({
      ...state,
      ownershipBySession: {
        ...state.ownershipBySession,
        [input.sessionId]: {
          status: "verified",
          legacyRegistration: false,
          canReclaim: false,
          verification
        }
      }
    });
    await this.appendEvent(
      "SessionCheckpointed",
      {
        sessionId: input.sessionId,
        ownershipVerified: true,
        relayEnrollmentVerified: true,
        ownershipChallengeId: input.ticketId
      },
      input.verifiedAtIso
    );
    await this.enqueueSocialAnchorCandidate({
      sessionId: input.sessionId,
      kind: "ownership-verified",
      summary: `${profile.agentName} verified its SantaClawz relay enrollment.`,
      occurredAtIso: input.verifiedAtIso,
      payload: {
        agentId: input.agentId,
        ticketId: input.ticketId,
        attestationDigestSha256,
        verifiedPublicClawzUrl: input.publicAgentUrl,
        runtimeDeliveryMode: "santaclawz-relay"
      }
    });
  }

  async submitHireRequest(options: SubmitHireRequestOptions): Promise<HireRequestReceipt> {
    const state = await this.loadState();
    const sessionId = this.resolveSessionIdFromAgentId(state, options.agentId);
    if (!sessionId) {
      throw new Error(`Unknown agent: ${options.agentId}`);
    }

    const [events, liveFlow, deployment, hireRequests, socialAnchorQueueFile, runtimeHeartbeatFile] = await Promise.all([
      this.loadEvents(),
      this.getLiveFlowState(),
      this.getDeploymentState(),
      this.loadHireRequestFile(),
      this.loadSocialAnchorQueueFile(),
      this.loadRuntimeHeartbeatFile()
    ]);
    const liveFlowTargets = this.buildLiveFlowTargets(events, liveFlow);
    const trustModeId = this.resolveSessionTrustMode(events, sessionId, state.activeMode);
    const profile = this.profileForSession(state, sessionId, trustModeId);
    if (isArchivedProfile(profile)) {
      throw new Error("This agent is archived on SantaClawz and is not accepting new hire requests.");
    }
    const ownership = this.ownershipForSession(state, sessionId);
    if (ownership.status !== "verified") {
      throw new Error("This agent must verify control of its PublicClawz endpoint before it can accept public hire requests.");
    }
    const published = isSessionPublishedOnZeko({
      liveFlowTargets,
      socialAnchorQueueFile,
      sessionId,
      durablePublished: Boolean(state.publishedSessionsBySession[sessionId])
    });
    if (!published) {
      throw new Error("This agent needs to publish on Zeko before it can accept hire requests.");
    }
    if (!profile.openClawUrl.trim()) {
      throw new Error("This agent has no PublicClawz callback URL configured yet.");
    }
    const taskPrompt = options.taskPrompt.trim();
    const requesterContact = options.requesterContact.trim();
    const marketplaceTags = sanitizeMarketplaceWorkTags(options.marketplaceTags);
    if (taskPrompt.length === 0 || requesterContact.length === 0) {
      throw new Error("taskPrompt and requesterContact are required.");
    }
    if (taskPrompt.length > HIRE_TASK_PROMPT_MAX_LENGTH) {
      throw new Error(`taskPrompt must be ${HIRE_TASK_PROMPT_MAX_LENGTH} characters or less.`);
    }
    if (requesterContact.length > HIRE_REQUESTER_CONTACT_MAX_LENGTH) {
      throw new Error(`requesterContact must be ${HIRE_REQUESTER_CONTACT_MAX_LENGTH} characters or less.`);
    }
    this.assertAgentRuntimeReachable(
      await this.checkPublicClawzAgentReachability({
        state,
        sessionId,
        profile,
        trustModeId
      })
    );
    const paidJobsEnabled = computePaidJobsEnabled(profile, published, deployment);
    const paymentAuthorization = options.paymentAuthorization ?? { status: "not-required" as const };
    const freeTestMode = isFreeTestPricingMode(profile.paymentProfile.pricingMode);
    if (!profile.paymentProfile.enabled && !freeTestMode) {
      throw new Error("This agent is not open for work yet.");
    }
    const quoteRequestMode = profile.paymentProfile.enabled && isQuotedPricingMode(profile.paymentProfile.pricingMode);
    if (profile.paymentProfile.enabled && !paidJobsEnabled && !quoteRequestMode) {
      throw new Error("This agent has payments turned on, but paid jobs are not live yet.");
    }
    if (quoteRequestMode && !hasReadyPaymentProfile(profile)) {
      throw new Error("This agent is open for work, but its quote setup still needs a payout wallet and processor.");
    }
    if (paidJobsEnabled && paymentAuthorization.status === "not-required") {
      throw new Error("Paid agents require verified x402 payment before SantaClawz submits a hire request.");
    }
    if (freeTestMode) {
      if (paymentAuthorization.status !== "not-required") {
        throw new Error("Free-test agents do not accept payment authorization on the free-test lane.");
      }
      assertFreeTestHireQuota(
        hireRequests,
        options.agentId,
        freeTestQuotaPolicyFor({ deployment, profile }),
        Date.now()
      );
    }
    if (paymentAuthorization.status !== "not-required") {
      const heartbeatRecord = runtimeHeartbeatFile.heartbeats.find((record) => record.sessionId === sessionId);
      const heartbeat = this.buildAgentRuntimeHeartbeatState({
        state,
        sessionId,
        trustModeId,
        ...(heartbeatRecord ? { record: heartbeatRecord } : {})
      });
      const staleAtMs = heartbeat.staleAtIso ? Date.parse(heartbeat.staleAtIso) : NaN;
      const nearStale = Number.isFinite(staleAtMs) && staleAtMs - Date.now() < 5000;
      if (heartbeat.status !== "live" || nearStale) {
        throw new Error(
          [
            "agent_runtime_unavailable_retryable",
            "SantaClawz will not submit paid execution while the agent heartbeat is stale or near stale.",
            heartbeat.reason ?? ""
          ].filter(Boolean).join(": ")
        );
      }
      const paidExecutionProven =
        heartbeat.paidExecutionProbe?.ok === true ||
        hasVerifiedPaidExecutionForSession(hireRequests, sessionId, { includePrivate: true });
      if (!paidExecutionProven && paymentAuthorization.activationLane !== true) {
        throw new Error(
          [
            "paid_execution_probe_required",
            "This agent has payments configured, but paid execution is not proven yet.",
            "Use the activation lane or run seller:ready with the paid-execution probe before buyers pay."
          ].join(": ")
        );
      }
    }

    const submittedAtIso = new Date().toISOString();
    const requestId = `hire_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const jobAccessToken = randomBytes(32).toString("base64url");
    if (hireRequests.requests.some((request) => request.requestId === requestId)) {
      throw new Error("Duplicate hire request id rejected.");
    }
    const ingressRecord = this.ingressSecretRecordForSession(state, sessionId);
    const ingressDelivery = await this.forwardHireRequestToIngress({
      ingressRecord,
      sessionId,
      agentId: options.agentId,
      profile,
      requestId,
      submittedAtIso,
      taskPrompt,
      requesterContact,
      ...(!marketplaceWorkTagsAreEmpty(marketplaceTags) ? { marketplaceTags } : {}),
      ...(options.jobPrivacy ? { jobPrivacy: options.jobPrivacy } : {}),
      ...(options.artifactDelivery ? { artifactDelivery: options.artifactDelivery } : {}),
      ...(typeof options.budgetMina === "string" && options.budgetMina.trim().length > 0
        ? { budgetMina: options.budgetMina.trim().slice(0, 40) }
        : {}),
      paymentAuthorization
    });
    const publicDeliveryTarget = publicAgentHireUrlFor(options.agentId);
    const ingressProtocolReturn = "protocolReturn" in ingressDelivery ? ingressDelivery.protocolReturn : undefined;
    const ingressResponseStatusCode =
      "responseStatusCode" in ingressDelivery ? ingressDelivery.responseStatusCode : undefined;
    const ingressResponseBytes =
      "responseBytes" in ingressDelivery && typeof ingressDelivery.responseBytes === "number"
        ? ingressDelivery.responseBytes
        : undefined;
    const returnValidationError =
      "returnValidationError" in ingressDelivery && typeof ingressDelivery.returnValidationError === "string"
        ? ingressDelivery.returnValidationError
        : undefined;
    const returnValidationCode =
      "returnValidationCode" in ingressDelivery && typeof ingressDelivery.returnValidationCode === "string"
        ? ingressDelivery.returnValidationCode
        : undefined;
    const deliveryError =
      "deliveryError" in ingressDelivery && typeof ingressDelivery.deliveryError === "string"
        ? ingressDelivery.deliveryError
        : undefined;
    const deliveryFailed = "deliveryFailed" in ingressDelivery && ingressDelivery.deliveryFailed === true;
    const returnRejected = ingressDelivery.deliveryStatus === "return_rejected";
    const deliveryReceipt = "deliveryReceipt" in ingressDelivery ? ingressDelivery.deliveryReceipt : undefined;
    const requestType = ingressDelivery.requestKind;
    const paymentStatus = paymentStatusForHireRequest({
      requestType,
      paymentStatus: paymentAuthorization.status
    });
    const relayTrace = mergeHireRelayTrace({
      submittedAtIso,
      paymentStatus,
      deliveryFailed,
      ...(ingressDelivery.deliveryStatus ? { deliveryStatus: ingressDelivery.deliveryStatus } : {}),
      ...("relayTrace" in ingressDelivery && ingressDelivery.relayTrace ? { relayTrace: ingressDelivery.relayTrace } : {}),
      completed: ingressProtocolReturn?.status === "completed"
    });
    if (
      requestType === "paid_execution" &&
      ingressProtocolReturn?.status === "completed" &&
      ingressProtocolReturn.execution?.completionClassification !== "agent_completed_verified"
    ) {
      await this.updatePaymentLedgerExecution({
        ...(paymentAuthorization.ledgerId ? { ledgerId: paymentAuthorization.ledgerId } : {}),
        hireRequestId: requestId,
        executionStatus: "failed",
        returnStatus: "rejected",
        ...(deliveryReceipt ? { deliveryReceipt } : {}),
        errorCode: "verified_output_required",
        errorMessage:
          "Paid execution completed without a verified worker output package. Production paid jobs require buyer-visible deliverables, files produced, checks performed, and a verification manifest."
      });
      throw new Error(
        "Paid execution completed without a verified worker output package. Production paid jobs require buyer-visible deliverables, files produced, checks performed, and a verification manifest."
      );
    }
    const settledAmountUsd = requestType === "paid_execution" ? paymentAuthorization.amountUsd : undefined;
    const hireStatus: HireRequestReceipt["status"] = returnRejected ? "failed" : ingressProtocolReturn?.status ?? "submitted";
    const operationalStatus = buildHireOperationalStatus({
      requestType,
      paymentStatus,
      ...(ingressDelivery.deliveryStatus ? { deliveryStatus: ingressDelivery.deliveryStatus } : {}),
      deliveryFailed,
      returnRejected,
      hireStatus
    });
    const nextRecord: HireRequestRecord = {
      requestId,
      agentId: options.agentId,
      sessionId,
      networkId: deployment.networkId,
      submittedAtIso,
      requestType,
      pricingMode: profile.paymentProfile.pricingMode,
      paymentStatus,
      ...(settledAmountUsd ? { settledAmountUsd } : {}),
      status: hireStatus,
      taskPrompt,
      ...(typeof options.budgetMina === "string" && options.budgetMina.trim().length > 0
        ? { budgetMina: options.budgetMina.trim().slice(0, 40) }
        : {}),
      requesterContact,
      jobAccessTokenHashSha256: sha256Hex(jobAccessToken),
      ...(!marketplaceWorkTagsAreEmpty(marketplaceTags) ? { marketplaceTags } : {}),
      ...(options.jobPrivacy ? { jobPrivacy: options.jobPrivacy } : {}),
      ...(options.artifactDelivery ? { artifactDelivery: options.artifactDelivery } : {}),
      deliveryTarget: publicDeliveryTarget,
      ...(ingressDelivery.deliveryStatus ? { deliveryStatus: ingressDelivery.deliveryStatus } : {}),
      ...(deliveryError ? { deliveryError } : {}),
      ...(returnValidationError ? { returnValidationError } : {}),
      ...(returnValidationCode ? { returnValidationCode } : {}),
      ...(typeof ingressResponseStatusCode === "number" ? { localResponseStatusCode: ingressResponseStatusCode } : {}),
      ...(typeof ingressResponseBytes === "number" ? { localResponseBytes: ingressResponseBytes } : {}),
      operationalStatus,
      ...(deliveryReceipt ? { deliveryReceipt } : {}),
      relayTrace,
      ingressBodyDigestSha256: ingressDelivery.bodyDigestSha256,
      ...(typeof ingressResponseStatusCode === "number" ? { ingressResponseStatusCode } : {}),
      ...(ingressProtocolReturn ? { protocolReturn: ingressProtocolReturn } : {}),
      payment: paymentAuthorization
    };

    const nextHireRequestFile: HireRequestFile = {
      ...hireRequests,
      requests: [nextRecord, ...hireRequests.requests],
      jobActivityStatsBySessionId: {
        ...(hireRequests.jobActivityStatsBySessionId ?? {}),
        [sessionId]: incrementAgentJobActivityStats(
          hireRequests.jobActivityStatsBySessionId?.[sessionId] ?? buildAgentJobActivityStats(hireRequests, sessionId),
          nextRecord
        )
      }
    };
    await this.saveHireRequestFile(nextHireRequestFile);
    if (paymentAuthorization.ledgerId) {
      await this.updatePaymentLedgerExecution({
        ledgerId: paymentAuthorization.ledgerId,
        hireRequestId: requestId,
        executionStatus:
          returnRejected
            ? "failed"
            : ingressProtocolReturn?.status === "completed"
            ? "completed"
            : ingressProtocolReturn?.status === "failed" || deliveryFailed
              ? "failed"
              : ingressDelivery.deliveryStatus === "forwarded"
                ? "forwarded"
                : "submitted",
        returnStatus:
          returnRejected
            ? "rejected"
            : ingressProtocolReturn?.status === "completed"
            ? "accepted"
            : ingressProtocolReturn?.status === "failed"
              ? "rejected"
              : "none",
        ...(deliveryReceipt ? { deliveryReceipt } : {}),
        ...(deliveryError
          ? {
              errorCode: returnValidationCode ?? "relay_delivery_failed",
              errorMessage: deliveryError
            }
          : {})
      });
    }
    const detailedLifecycle = shouldPublishDetailedHireLifecycle(options.jobPrivacy);
    await this.enqueueSocialAnchorCandidate({
      sessionId,
      kind: "hire-request-submitted",
      summary: detailedLifecycle
        ? `${profile.agentName} received a new hire request through SantaClawz.`
        : `${profile.agentName} received a private hire request through SantaClawz.`,
      occurredAtIso: submittedAtIso,
      payload: detailedLifecycle
        ? {
            requestId,
            agentId: options.agentId,
            requesterContactDigestSha256: sha256Hex(nextRecord.requesterContact),
            requestType,
            pricingMode: profile.paymentProfile.pricingMode,
            paymentStatus,
            ...(!marketplaceWorkTagsAreEmpty(marketplaceTags) ? { marketplaceTags } : {}),
            ...(settledAmountUsd ? { settledAmountUsd } : {}),
            status: hireStatus
          }
        : {
            agentId: options.agentId,
            privateActivity: true,
            activityDigestSha256: sha256Hex(requestId),
            requestType,
            pricingMode: profile.paymentProfile.pricingMode,
            paymentStatus,
            status: hireStatus
          }
    });
    if (ingressProtocolReturn) {
      const completionClassification =
        ingressProtocolReturn.status === "completed"
          ? ingressProtocolReturn.execution?.completionClassification
          : undefined;
      const returnKind: SocialAnchorCandidateKind =
        ingressProtocolReturn.status === "quoted"
          ? "quote-returned"
          : ingressProtocolReturn.status === "completed"
            ? requestType === "free_test"
              ? "free-test-completed"
              : "paid-execution-completed"
            : "hire-request-failed";
      const returnSummary =
        !detailedLifecycle
          ? ingressProtocolReturn.status === "quoted"
            ? `${profile.agentName} returned an anonymized private quote milestone.`
            : ingressProtocolReturn.status === "completed"
              ? `${profile.agentName} returned an anonymized private completion milestone.`
              : `${profile.agentName} returned an anonymized private failure milestone.`
        : ingressProtocolReturn.status === "quoted"
          ? `${profile.agentName} returned an exact quote for a SantaClawz hire request.`
          : ingressProtocolReturn.status === "completed"
            ? completionClassification === "agent_completed_verified"
              ? requestType === "free_test"
                ? `${profile.agentName} returned a verified output package for a free test.`
                : `${profile.agentName} returned a verified output package for paid execution.`
              : completionClassification === "demo_completion"
                ? `${profile.agentName} returned a demo completion that is not buyer-verified work.`
                : completionClassification === "agent_completed_empty"
                  ? `${profile.agentName} returned a completed response with no buyer-visible deliverables.`
                  : `${profile.agentName} returned completed output that still needs verification.`
            : `${profile.agentName} returned a failed hire result through SantaClawz.`;
      await this.enqueueSocialAnchorCandidate({
        sessionId,
        kind: returnKind,
        summary: returnSummary,
        occurredAtIso: submittedAtIso,
        payload: detailedLifecycle
          ? {
              requestId,
              agentId: options.agentId,
              protocolReturnDigestSha256: ingressProtocolReturn.digestSha256,
              status: ingressProtocolReturn.status,
              ...(!marketplaceWorkTagsAreEmpty(marketplaceTags) ? { marketplaceTags } : {}),
              ...(ingressProtocolReturn.quote
                ? {
                    quoteAmountUsd: ingressProtocolReturn.quote.amountUsd,
                    quoteCurrency: ingressProtocolReturn.quote.currency,
                    quoteExpiresAtIso: ingressProtocolReturn.quote.expiresAtIso
                  }
                : {}),
              ...(ingressProtocolReturn.verifiedOutput
                ? {
                    verifiedOutputPackageHash: ingressProtocolReturn.verifiedOutput.packageHash,
                    verifiedOutputDeliverableCount: ingressProtocolReturn.verifiedOutput.deliverableCount,
                    ...(ingressProtocolReturn.verifiedOutput.verificationManifestDigestSha256
                      ? {
                          verificationManifestDigestSha256:
                            ingressProtocolReturn.verifiedOutput.verificationManifestDigestSha256
                        }
                      : {}),
                    zekoAttestationIncluded: ingressProtocolReturn.verifiedOutput.zekoAttestationIncluded
                  }
                : {}),
              ...(ingressProtocolReturn.execution
                ? {
                    executionMode: ingressProtocolReturn.execution.executionMode,
                    realWorkExecuted: ingressProtocolReturn.execution.realWorkExecuted,
                    buyerVisible: ingressProtocolReturn.execution.buyerVisible,
                    marketplaceCompletionCredit: ingressProtocolReturn.execution.marketplaceCompletionCredit,
                    completionClassification: ingressProtocolReturn.execution.completionClassification,
                    executionDeliverableCount: ingressProtocolReturn.execution.deliverableCount,
                    executionFilesProducedCount: ingressProtocolReturn.execution.filesProducedCount,
                    executionChecksPerformedCount: ingressProtocolReturn.execution.checksPerformedCount,
                    executionZekoAttestationIncluded: ingressProtocolReturn.execution.zekoAttestationIncluded
                  }
                : {}),
              ...(ingressProtocolReturn.incidentId ? { incidentId: ingressProtocolReturn.incidentId } : {})
            }
          : {
              agentId: options.agentId,
              privateActivity: true,
              activityDigestSha256: sha256Hex(`${requestId}:${ingressProtocolReturn.digestSha256}`),
              status: ingressProtocolReturn.status,
              requestType,
              pricingMode: profile.paymentProfile.pricingMode,
              paymentStatus,
              ...(!marketplaceWorkTagsAreEmpty(marketplaceTags)
                ? { marketplaceTagDigestSha256: marketplaceTagsDigest(marketplaceTags) }
                : {}),
              ...(completionClassification ? { completionClassification } : {})
            }
      });
    }
    const marketplaceTagOutcome = paidExecutionTerminalOutcome(nextRecord);
    if (
      requestType === "paid_execution" &&
      detailedLifecycle &&
      marketplaceTagOutcome !== "pending" &&
      !marketplaceWorkTagsAreEmpty(marketplaceTags)
    ) {
      await this.enqueueMarketplaceTagReputationAnchor({
        sessionId,
        agentId: options.agentId,
        requestId,
        requestType,
        outcome: marketplaceTagOutcome,
        marketplaceTags,
        marketplaceTagStats: buildAgentMarketplaceTagStats(nextHireRequestFile, sessionId),
        occurredAtIso: submittedAtIso,
        ...(ingressProtocolReturn?.digestSha256 ? { protocolReturnDigestSha256: ingressProtocolReturn.digestSha256 } : {})
      });
    }

    return {
      requestId,
      agentId: options.agentId,
      sessionId,
      networkId: deployment.networkId,
      submittedAtIso,
      requestType,
      pricingMode: profile.paymentProfile.pricingMode,
      paymentStatus,
      ...(settledAmountUsd ? { settledAmountUsd } : {}),
      status: hireStatus,
      deliveryTarget: publicDeliveryTarget,
      ...(ingressDelivery.deliveryStatus ? { deliveryStatus: ingressDelivery.deliveryStatus } : {}),
      ...(deliveryError ? { deliveryError } : {}),
      ...(returnValidationError ? { returnValidationError } : {}),
      ...(returnValidationCode ? { returnValidationCode } : {}),
      ...(typeof ingressResponseStatusCode === "number" ? { localResponseStatusCode: ingressResponseStatusCode } : {}),
      ...(typeof ingressResponseBytes === "number" ? { localResponseBytes: ingressResponseBytes } : {}),
      operationalStatus,
      relayTrace,
      ...(!marketplaceWorkTagsAreEmpty(marketplaceTags) ? { marketplaceTags } : {}),
      ...(options.jobPrivacy ? { jobPrivacy: options.jobPrivacy } : {}),
      jobWorkspace: this.buildJobWorkspace({ requestId, token: jobAccessToken }),
      ...(options.artifactDelivery ? { artifactDelivery: options.artifactDelivery } : {}),
      ...(deliveryReceipt ? { deliveryReceipt } : {}),
      ingress: {
        url: publicDeliveryTarget,
        requestId,
        timestamp: submittedAtIso,
        bodyDigestSha256: ingressDelivery.bodyDigestSha256,
        ...(typeof ingressResponseStatusCode === "number" ? { responseStatusCode: ingressResponseStatusCode } : {}),
        ...(typeof ingressResponseBytes === "number" ? { responseBytes: ingressResponseBytes } : {}),
        ...(returnValidationError ? { returnValidationError } : {}),
        ...(returnValidationCode ? { returnValidationCode } : {}),
        signatureHeader: "X-SantaClawz-Signature"
      },
      ...(ingressProtocolReturn ? { protocolReturn: ingressProtocolReturn } : {}),
      payment: {
        status: paymentStatus,
        ...(paymentAuthorization.rail ? { rail: paymentAuthorization.rail } : {}),
        ...(paymentAuthorization.amountUsd ? { amountUsd: paymentAuthorization.amountUsd } : {}),
        ...(paymentAuthorization.authorizationId ? { authorizationId: paymentAuthorization.authorizationId } : {}),
        ...(paymentAuthorization.settlementReference ? { settlementReference: paymentAuthorization.settlementReference } : {}),
        ...(paymentAuthorization.ledgerId ? { ledgerId: paymentAuthorization.ledgerId } : {}),
        ...(paymentAuthorization.settlementEvents?.sellerSettlementTxHash
          ? { sellerSettlementTxHash: paymentAuthorization.settlementEvents.sellerSettlementTxHash }
          : {}),
        ...(paymentAuthorization.settlementEvents?.protocolFeeTxHash
          ? { protocolFeeTxHash: paymentAuthorization.settlementEvents.protocolFeeTxHash }
          : {}),
        ...(paymentAuthorization.settlementEvents?.transactionHashes?.length
          ? { transactionHashes: paymentAuthorization.settlementEvents.transactionHashes }
          : {})
      },
      paidJobsEnabled
    };
  }

  private settlementModelForProfile(profile: AgentProfileState): ExecutionIntentSettlementModel {
    return profile.paymentProfile.settlementTrigger === "on-proof" ? "reserve-release-escrow" : "upfront-x402";
  }

  private escrowContractForRail(profile: AgentProfileState, rail: AgentPaymentRail): string | undefined {
    if (rail === "base-usdc") {
      return profile.paymentProfile.baseEscrowContract?.trim() || process.env.CLAWZ_X402_BASE_ESCROW_CONTRACT?.trim();
    }
    if (rail === "ethereum-usdc") {
      return profile.paymentProfile.ethereumEscrowContract?.trim() || process.env.CLAWZ_X402_ETHEREUM_ESCROW_CONTRACT?.trim();
    }
    return undefined;
  }

  private protocolFeeRecipientForRail(rail: AgentPaymentRail): string | undefined {
    return buildProtocolOwnerFeePolicyFromEnv().recipientByRail[rail]?.trim();
  }

  private buildExecutionIntentStableDigest(input: {
    intentId: string;
    requestId?: string;
    agentId: string;
    sessionId: string;
    networkId: string;
    rail: AgentPaymentRail;
    settlementModel: ExecutionIntentSettlementModel;
    pricingMode: AgentProfileState["paymentProfile"]["pricingMode"];
    paymentStatus: ExecutionIntentRecord["paymentStatus"];
    grossAmountUsd: string;
    sellerNetAmountUsd?: string;
    protocolFeeAmountUsd?: string;
    protocolFeeRecipient?: string;
    buyerWallet?: string;
    sellerWallet?: string;
    escrowContract?: string;
    paymentAuthorizationDigestSha256?: string;
    createdAtIso: string;
  }) {
    return canonicalDigest({
      schemaVersion: EXECUTION_INTENT_SCHEMA_VERSION,
      intentId: input.intentId,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      agentId: input.agentId,
      sessionId: input.sessionId,
      networkId: input.networkId,
      rail: input.rail,
      settlementModel: input.settlementModel,
      pricingMode: input.pricingMode,
      paymentStatus: input.paymentStatus,
      grossAmountUsd: input.grossAmountUsd,
      ...(input.sellerNetAmountUsd ? { sellerNetAmountUsd: input.sellerNetAmountUsd } : {}),
      ...(input.protocolFeeAmountUsd ? { protocolFeeAmountUsd: input.protocolFeeAmountUsd } : {}),
      ...(input.protocolFeeRecipient ? { protocolFeeRecipient: input.protocolFeeRecipient } : {}),
      ...(input.buyerWallet ? { buyerWallet: input.buyerWallet } : {}),
      ...(input.sellerWallet ? { sellerWallet: input.sellerWallet } : {}),
      ...(input.escrowContract ? { escrowContract: input.escrowContract } : {}),
      ...(input.paymentAuthorizationDigestSha256
        ? { paymentAuthorizationDigestSha256: input.paymentAuthorizationDigestSha256 }
        : {}),
      createdAtIso: input.createdAtIso
    }).sha256Hex;
  }

  private buildExecutionIntentTransition(input: {
    intentId: string;
    stableIntentDigestSha256: string;
    transitionType: ExecutionIntentTransitionType;
    fromStatus?: ExecutionIntentStatus;
    toStatus: ExecutionIntentStatus;
    occurredAtIso: string;
    previousTransitionDigestSha256?: string;
    reference?: string;
    evidenceDigestSha256?: string;
    note?: string;
  }): ExecutionIntentLifecycleEntry {
    const transitionDigestSha256 = canonicalDigest({
      schemaVersion: "santaclawz-execution-intent-transition/1.0",
      intentId: input.intentId,
      stableIntentDigestSha256: input.stableIntentDigestSha256,
      transitionType: input.transitionType,
      ...(input.fromStatus ? { fromStatus: input.fromStatus } : {}),
      toStatus: input.toStatus,
      occurredAtIso: input.occurredAtIso,
      ...(input.previousTransitionDigestSha256
        ? { previousTransitionDigestSha256: input.previousTransitionDigestSha256 }
        : {}),
      ...(input.reference ? { reference: input.reference } : {}),
      ...(input.evidenceDigestSha256 ? { evidenceDigestSha256: input.evidenceDigestSha256 } : {}),
      ...(input.note ? { note: input.note } : {})
    }).sha256Hex;

    return {
      transitionId: `exec_step_${transitionDigestSha256.slice(0, 16)}`,
      transitionType: input.transitionType,
      ...(input.fromStatus ? { fromStatus: input.fromStatus } : {}),
      toStatus: input.toStatus,
      occurredAtIso: input.occurredAtIso,
      transitionDigestSha256,
      ...(input.previousTransitionDigestSha256 ? { previousTransitionDigestSha256: input.previousTransitionDigestSha256 } : {}),
      ...(input.reference ? { reference: input.reference } : {}),
      ...(input.evidenceDigestSha256 ? { evidenceDigestSha256: input.evidenceDigestSha256 } : {}),
      ...(input.note ? { note: input.note } : {})
    };
  }

  private executionAnchorKindForTransition(transitionType: ExecutionIntentTransitionType): SocialAnchorCandidateKind {
    switch (transitionType) {
      case "created":
        return "execution-intent-created";
      case "approved":
        return "execution-intent-approved";
      case "executed":
        return "execution-intent-executed";
      case "settled":
        return "execution-intent-settled";
      case "refunded":
        return "execution-intent-refunded";
    }
  }

  private executionTransitionSummary(intent: ExecutionIntentRecord, transition: ExecutionIntentLifecycleEntry) {
    const railLabel = intent.rail === "base-usdc" ? "Base USDC" : intent.rail === "ethereum-usdc" ? "Ethereum USDC" : "Zeko";
    switch (transition.transitionType) {
      case "created":
        return `Created a ${intent.settlementModel} execution intent for ${railLabel}.`;
      case "approved":
        return `Approved execution intent ${intent.intentId} for proof-gated work.`;
      case "executed":
        return `Recorded execution evidence for intent ${intent.intentId}.`;
      case "settled":
        return `Settled execution intent ${intent.intentId}.`;
      case "refunded":
        return `Refunded execution intent ${intent.intentId}.`;
    }
  }

  private async enqueueExecutionIntentTransitionAnchor(
    intent: ExecutionIntentRecord,
    transition: ExecutionIntentLifecycleEntry
  ): Promise<string | undefined> {
    const anchorCandidate = await this.enqueueSocialAnchorCandidate({
      sessionId: intent.sessionId,
      kind: this.executionAnchorKindForTransition(transition.transitionType),
      summary: this.executionTransitionSummary(intent, transition),
      occurredAtIso: transition.occurredAtIso,
      payload: {
        schemaVersion: "santaclawz-execution-intent-anchor/1.0",
        intentId: intent.intentId,
        ...(intent.requestId ? { requestId: intent.requestId } : {}),
        agentId: intent.agentId,
        rail: intent.rail,
        settlementModel: intent.settlementModel,
        status: transition.toStatus,
        transitionType: transition.transitionType,
        stableIntentDigestSha256: intent.stableIntentDigestSha256,
        transitionDigestSha256: transition.transitionDigestSha256,
        ...(transition.previousTransitionDigestSha256
          ? { previousTransitionDigestSha256: transition.previousTransitionDigestSha256 }
          : {}),
        grossAmountUsd: intent.grossAmountUsd,
        ...(intent.sellerNetAmountUsd ? { sellerNetAmountUsd: intent.sellerNetAmountUsd } : {}),
        ...(intent.protocolFeeAmountUsd ? { protocolFeeAmountUsd: intent.protocolFeeAmountUsd } : {}),
        ...(intent.protocolFeeRecipient ? { protocolFeeRecipient: intent.protocolFeeRecipient } : {}),
        ...(intent.escrowContract ? { escrowContract: intent.escrowContract } : {}),
        ...(transition.reference ? { reference: transition.reference } : {}),
        ...(transition.evidenceDigestSha256 ? { evidenceDigestSha256: transition.evidenceDigestSha256 } : {})
      }
    });
    return anchorCandidate?.candidateId;
  }

  private async attachExecutionTransitionAnchor(
    file: ExecutionIntentFile,
    intentId: string,
    transitionId: string,
    anchorCandidateId: string | undefined
  ): Promise<ExecutionIntentRecord> {
    const nextFile: ExecutionIntentFile = {
      intents: file.intents.map((intent) => {
        if (intent.intentId !== intentId) {
          return intent;
        }
        const nextLifecycle = intent.lifecycle.map((entry) =>
          entry.transitionId === transitionId && anchorCandidateId
            ? {
                ...entry,
                anchorCandidateId
              }
            : entry
        );
        return {
          ...intent,
          lifecycle: nextLifecycle,
          anchorCandidateIds: anchorCandidateId
            ? Array.from(new Set([...intent.anchorCandidateIds, anchorCandidateId]))
            : intent.anchorCandidateIds
        };
      })
    };
    await this.saveExecutionIntentFile(nextFile);
    const refreshed = nextFile.intents.find((intent) => intent.intentId === intentId);
    if (!refreshed) {
      throw new Error(`Unknown execution intent: ${intentId}`);
    }
    return refreshed;
  }

  private assertExecutionIntentTransitionAllowed(
    intent: ExecutionIntentRecord,
    transitionType: Exclude<ExecutionIntentTransitionType, "created">
  ): ExecutionIntentStatus {
    if (intent.status === "settled" || intent.status === "refunded") {
      throw new Error(`Execution intent ${intent.intentId} is already terminal: ${intent.status}.`);
    }

    if (transitionType === "approved" && intent.status === "pending") {
      return "approved";
    }
    if (transitionType === "executed" && intent.status === "approved") {
      return "executed";
    }
    if (transitionType === "settled" && intent.status === "executed") {
      return "settled";
    }
    if (transitionType === "refunded" && (intent.status === "pending" || intent.status === "approved" || intent.status === "executed")) {
      return "refunded";
    }

    throw new Error(`Cannot mark execution intent ${intent.intentId} as ${transitionType} from ${intent.status}.`);
  }

  private buildExecutionIntentState(file: ExecutionIntentFile, options: ExecutionIntentListOptions = {}): ExecutionIntentState {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const visibleIntents = file.intents
      .filter((intent) => !options.sessionId || intent.sessionId === options.sessionId)
      .filter((intent) => !options.agentId || intent.agentId === options.agentId)
      .filter((intent) => !options.status || intent.status === options.status)
      .sort((left, right) => right.updatedAtIso.localeCompare(left.updatedAtIso));
    return {
      schemaVersion: "santaclawz-execution-intents/1.0",
      generatedAtIso: new Date().toISOString(),
      totalIntentCount: visibleIntents.length,
      ...executionIntentStatusCounts(visibleIntents),
      intents: visibleIntents.slice(0, limit)
    };
  }

  async listExecutionIntents(options: ExecutionIntentListOptions = {}): Promise<ExecutionIntentState> {
    return this.buildExecutionIntentState(await this.loadExecutionIntentFile(), options);
  }

  async getExecutionIntent(intentId: string): Promise<ExecutionIntentRecord> {
    const trimmedIntentId = intentId.trim();
    const intent = (await this.loadExecutionIntentFile()).intents.find(
      (candidate) => candidate.intentId === trimmedIntentId
    );
    if (!intent) {
      throw new Error(`Unknown execution intent: ${trimmedIntentId}`);
    }
    return intent;
  }

  async getHireRequest(requestId: string): Promise<HireRequestRecord> {
    const trimmedRequestId = requestId.trim();
    const request = (await this.loadHireRequestFile()).requests.find(
      (candidate) => candidate.requestId === trimmedRequestId
    );
    if (!request) {
      throw new Error(`Unknown execution request: ${trimmedRequestId}`);
    }
    return request;
  }

  async assertHireArtifactUploadAccess(requestId: string, adminKey?: string): Promise<HireRequestRecord> {
    const request = await this.getHireRequest(requestId);
    const state = await this.loadState();
    this.assertAdminAccess(state, request.sessionId, adminKey);
    return request;
  }

  private async assertJobWorkspaceAccess(options: {
    requestId: string;
    token?: string;
    adminKey?: string;
  }): Promise<{ request: HireRequestRecord; role: "buyer" | "seller" }> {
    const request = await this.getHireRequest(options.requestId);
    if (options.adminKey) {
      const state = await this.loadState();
      this.assertAdminAccess(state, request.sessionId, options.adminKey);
      return { request, role: "seller" };
    }
    if (options.token?.trim() && request.jobAccessTokenHashSha256 && sha256Hex(options.token.trim()) === request.jobAccessTokenHashSha256) {
      return { request, role: "buyer" };
    }
    throw new Error("Job workspace access rejected.");
  }

  private buildJobWorkspace(input: JobWorkspaceInput) {
    const tokenQuery = `token=${encodeURIComponent(input.token)}`;
    const base = `/api/executions/${encodeURIComponent(input.requestId)}`;
    return {
      token: input.token,
      messagesPath: `${base}/messages?${tokenQuery}`,
      stagesPath: `${base}/stages?${tokenQuery}`,
      collaborationPath: `${base}/collaboration?${tokenQuery}`
    };
  }

  private buildJobCollaborationState(file: JobCollaborationFile, request: HireRequestRecord) {
    const stages = file.stages
      .filter((stage) => stage.requestId === request.requestId)
      .sort((left, right) => left.createdAtIso.localeCompare(right.createdAtIso));
    const messages = file.messages
      .filter((message) => message.requestId === request.requestId)
      .sort((left, right) => left.createdAtIso.localeCompare(right.createdAtIso));
    return {
      requestId: request.requestId,
      agentId: request.agentId,
      sessionId: request.sessionId,
      currentStage: stages.at(-1) ?? null,
      stages,
      messages
    };
  }

  async getJobCollaboration(options: { requestId: string; token?: string; adminKey?: string }) {
    const { request } = await this.assertJobWorkspaceAccess(options);
    return this.buildJobCollaborationState(await this.loadJobCollaborationFile(), request);
  }

  async postJobMessage(options: JobMessagePostOptions) {
    const access = await this.assertJobWorkspaceAccess(options);
    const authorRole = sanitizeJobAuthorRole(options.authorRole, access.role);
    if (access.role === "buyer" && authorRole !== "buyer") {
      throw new Error("Buyer job token can only post buyer messages.");
    }
    if (access.role === "seller" && authorRole !== "seller") {
      throw new Error("Seller admin key can only post seller messages.");
    }
    const createdAtIso = new Date().toISOString();
    const body = sanitizeJobMessageBody(options.body);
    const artifactDigestSha256 = normalizeOptionalSha256(options.artifactDigestSha256);
    const message: JobMessageRecord = {
      messageId: `jobmsg_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      requestId: access.request.requestId,
      agentId: access.request.agentId,
      sessionId: access.request.sessionId,
      authorRole,
      body,
      createdAtIso,
      messageDigestSha256: sha256Hex(JSON.stringify({
        requestId: access.request.requestId,
        authorRole,
        body,
        createdAtIso
      })),
      ...(options.stage ? { stage: sanitizeJobStage(options.stage) } : {}),
      ...(artifactDigestSha256 ? { artifactDigestSha256 } : {})
    };
    const file = await this.loadJobCollaborationFile();
    const nextFile = {
      stages: file.stages,
      messages: [message, ...file.messages].slice(0, 2000)
    };
    await this.saveJobCollaborationFile(nextFile);
    return this.buildJobCollaborationState(nextFile, access.request);
  }

  async postJobStage(options: JobStagePostOptions) {
    const access = await this.assertJobWorkspaceAccess(options);
    const authorRole = sanitizeJobAuthorRole(options.authorRole, access.role);
    if (access.role === "buyer" && authorRole !== "buyer") {
      throw new Error("Buyer job token can only post buyer stage updates.");
    }
    if (access.role === "seller" && authorRole !== "seller") {
      throw new Error("Seller admin key can only post seller stage updates.");
    }
    const nowIso = new Date().toISOString();
    const { stage, status } = sanitizeJobStageDescriptor(options.stage, options.status);
    const note = sanitizeJobNote(options.note);
    const artifactDigestSha256 = normalizeOptionalSha256(options.artifactDigestSha256);
    const record: JobStageRecord = {
      stageId: `jobstage_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      requestId: access.request.requestId,
      agentId: access.request.agentId,
      sessionId: access.request.sessionId,
      stage,
      status,
      label: (options.label?.trim() || `${stage.replace(/_/g, " ")}: ${status.replace(/_/g, " ")}`).slice(0, 160),
      ...(note ? { note } : {}),
      ...(artifactDigestSha256 ? { artifactDigestSha256 } : {}),
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      authorRole
    };
    const file = await this.loadJobCollaborationFile();
    const nextFile = {
      stages: [...file.stages, record].slice(-2000),
      messages: file.messages
    };
    await this.saveJobCollaborationFile(nextFile);
    return this.buildJobCollaborationState(nextFile, access.request);
  }

  private buildExecutionLifecycleSummary(input: {
    intent: ExecutionIntentRecord;
    executionRequests: HireRequestRecord[];
    ledgerEntries: PaymentLedgerEntry[];
  }): ExecutionLifecycleSummary {
    const latestExecution = input.executionRequests[0];
    const latestLedger = input.ledgerEntries[0];
    const paymentStatus: ExecutionLifecycleSummary["paymentStatus"] =
      input.intent.status === "refunded"
        ? "refunded"
        : input.intent.status === "settled" || latestLedger?.paymentStatus === "settled" || latestLedger?.paymentStatus === "already_settled"
          ? "settled"
          : input.intent.status === "approved" || input.intent.status === "executed" || latestLedger?.paymentStatus === "authorization_verified"
            ? "authorized"
            : "not_started";
    const settlementStatus: ExecutionLifecycleSummary["settlementStatus"] =
      paymentStatus === "refunded"
        ? "refunded"
        : paymentStatus === "settled"
          ? "settled"
          : paymentStatus === "authorized"
            ? "authorized"
            : latestLedger?.paymentStatus === "settlement_failed"
              ? "failed"
              : "not_attempted";
    const relayDeliveryStatus = latestExecution?.operationalStatus?.relayDeliveryStatus ?? "not_attempted";
    const agentExecutionStatus = latestExecution?.operationalStatus?.agentExecutionStatus ?? "not_started";
    const proofStatus: ExecutionLifecycleSummary["proofStatus"] =
      latestExecution?.returnValidationError || latestLedger?.returnStatus === "rejected"
        ? "return_rejected"
        : latestExecution?.protocolReturn?.verifiedOutput
          ? latestExecution.protocolReturn.verifiedOutput.zekoAttestationIncluded
            ? "anchored_or_attested"
            : "return_validated"
          : "not_started";
    const completedVerified =
      latestExecution?.protocolReturn?.status === "completed" &&
      latestExecution.protocolReturn.execution?.completionClassification === "agent_completed_verified";
    const settlementRecovery = latestLedger ? this.buildPaymentSettlementRecovery(latestLedger) : undefined;
    const paidButNotCompleted =
      (paymentStatus === "authorized" || paymentStatus === "settled") &&
      !completedVerified &&
      input.intent.status !== "refunded";
    const currentPhase: ExecutionLifecycleSummary["currentPhase"] =
      input.intent.status === "refunded"
        ? "refunded"
        : proofStatus === "return_rejected" || relayDeliveryStatus === "return_rejected"
          ? "return_rejected"
          : completedVerified && paymentStatus === "settled"
            ? "payment_settled"
            : completedVerified
              ? "return_verified"
              : agentExecutionStatus === "completed" || agentExecutionStatus === "worker_completed_return_rejected"
                ? "worker_completed"
                : relayDeliveryStatus === "failed"
                  ? "failed_retriable"
                  : relayDeliveryStatus === "forwarded" || relayDeliveryStatus === "recorded"
                    ? "relay_forwarded"
                    : paymentStatus === "settled"
                      ? "payment_settled"
                      : paymentStatus === "authorized"
                        ? "payment_authorized"
                        : "created";
    return {
      currentPhase,
      paidButNotCompleted,
      completedVerified,
      needsAttention: currentPhase === "return_rejected" || currentPhase === "failed_retriable" || paidButNotCompleted,
      paymentStatus,
      settlementStatus,
      relayDeliveryStatus,
      agentExecutionStatus,
      proofStatus,
      ...(latestExecution ? { latestHireRequestId: latestExecution.requestId } : {}),
      ...(latestLedger ? { ledgerId: latestLedger.ledgerId } : {}),
      ...(settlementRecovery ? { settlementRecovery } : {}),
      ...(latestLedger?.errorCode ? { errorCode: latestLedger.errorCode } : latestExecution?.returnValidationCode ? { errorCode: latestExecution.returnValidationCode } : {}),
      ...(latestLedger?.errorMessage
        ? { errorMessage: latestLedger.errorMessage }
        : latestExecution?.returnValidationError
          ? { errorMessage: latestExecution.returnValidationError }
          : latestExecution?.deliveryError
            ? { errorMessage: latestExecution.deliveryError }
            : {})
    };
  }

  async getExecutionIntentResult(intentId: string) {
    const [intent, hireRequests, paymentLedger] = await Promise.all([
      this.getExecutionIntent(intentId),
      this.loadHireRequestFile(),
      this.loadPaymentLedgerFile()
    ]);
    const quoteRequest = intent.requestId
      ? hireRequests.requests.find((request) => request.requestId === intent.requestId)
      : undefined;
    const executionRequestIds = intent.lifecycle
      .filter((entry) => entry.transitionType === "executed" && entry.reference?.startsWith("hire_"))
      .map((entry) => entry.reference!)
      .filter((value, index, values) => values.indexOf(value) === index);
    const executionRequests = hireRequests.requests.filter((request) =>
      executionRequestIds.includes(request.requestId)
    );
    const latestExecution = executionRequests[0];
    const ledgerEntries = paymentLedger.entries
      .filter((entry) =>
        entry.quoteIntentId === intent.intentId ||
        entry.authorizationId === intent.intentId ||
        (latestExecution && entry.hireRequestId === latestExecution.requestId)
      )
      .sort((left, right) => Date.parse(right.updatedAtIso) - Date.parse(left.updatedAtIso));
    const executionLifecycle = this.buildExecutionLifecycleSummary({
      intent,
      executionRequests,
      ledgerEntries
    });
    return {
      ok: true,
      intent,
      ...(quoteRequest ? { quoteRequest } : {}),
      executionRequests,
      ...(latestExecution ? { latestExecution } : {}),
      ledgerEntries,
      executionLifecycle,
      resultStatus:
        latestExecution?.protocolReturn?.status === "completed"
          ? "completed"
          : latestExecution?.protocolReturn?.status === "failed"
            ? "failed"
            : latestExecution
              ? "submitted"
              : "not_started",
      ...(latestExecution?.protocolReturn ? { protocolReturn: latestExecution.protocolReturn } : {}),
      ...(latestExecution?.protocolReturn?.verifiedOutput
        ? { verifiedOutput: latestExecution.protocolReturn.verifiedOutput }
        : {}),
      operationalStatus: {
        paymentStatus: executionLifecycle.paymentStatus === "not_started" ? "pending" : executionLifecycle.paymentStatus,
        settlementStatus: executionLifecycle.settlementStatus,
        relayDeliveryStatus: executionLifecycle.relayDeliveryStatus,
        agentExecutionStatus: executionLifecycle.agentExecutionStatus
      },
      proofStatus: executionLifecycle.proofStatus
    };
  }

  async quotePaymentContextForIntent(intentId: string): Promise<QuotePaymentContext> {
    const intent = (await this.loadExecutionIntentFile()).intents.find((candidate) => candidate.intentId === intentId);
    if (!intent) {
      throw new Error(`Unknown execution intent: ${intentId}`);
    }
    if (!intent.requestId) {
      throw new Error("Execution intent is not bound to a quote request.");
    }
    const quoteRequest = (await this.loadHireRequestFile()).requests.find(
      (candidate) =>
        candidate.requestId === intent.requestId &&
        candidate.agentId === intent.agentId &&
        candidate.requestType === "quote_intake" &&
        candidate.protocolReturn?.status === "quoted"
    );
    if (!quoteRequest?.protocolReturn?.quote) {
      throw new Error("Accepted quote request was not found.");
    }
    const consoleState = await this.getConsoleState({ agentId: intent.agentId });
    return {
      intent,
      quoteRequest,
      consoleState
    };
  }

  async acceptQuoteForPayment(options: AcceptQuoteForPaymentOptions): Promise<ExecutionIntentRecord> {
    const [state, deployment, hireRequests, intents] = await Promise.all([
      this.loadState(),
      this.getDeploymentState(),
      this.loadHireRequestFile(),
      this.loadExecutionIntentFile()
    ]);
    const sessionId = this.resolveOwnedSessionId(state, { agentId: options.agentId });
    const trustModeId = this.resolveSessionTrustMode(await this.loadEvents(), sessionId, state.activeMode);
    const profile = this.profileForSession(state, sessionId, trustModeId);
    if (isArchivedProfile(profile)) {
      throw new Error("Archived agents cannot accept quotes.");
    }
    if (!isQuotedPricingMode(profile.paymentProfile.pricingMode)) {
      throw new Error("Quote acceptance is only available for quote-required agents.");
    }

    const quoteRequest = hireRequests.requests.find(
      (candidate) =>
        candidate.requestId === options.requestId &&
        candidate.agentId === options.agentId &&
        candidate.sessionId === sessionId &&
        candidate.requestType === "quote_intake" &&
        candidate.protocolReturn?.status === "quoted"
    );
    if (!quoteRequest?.protocolReturn?.quote) {
      throw new Error("Quote request was not found.");
    }
    const quote = quoteRequest.protocolReturn.quote;
    if (Date.parse(quote.expiresAtIso) <= Date.now()) {
      throw new Error("Quote has expired.");
    }

    const acceptedAmountUsd = options.acceptedAmountUsd.trim();
    assertUsdAmount(acceptedAmountUsd, "acceptedAmountUsd");
    const acceptedQuoteDigestSha256 = options.acceptedQuoteDigestSha256.trim();
    assertSha256Hex(acceptedQuoteDigestSha256, "acceptedQuoteDigestSha256");
    if (acceptedQuoteDigestSha256 !== quoteRequest.protocolReturn.digestSha256) {
      throw new Error("Accepted quote digest does not match the stored quote return.");
    }
    if (usdAmountAtomic(acceptedAmountUsd) !== usdAmountAtomic(quote.amountUsd)) {
      throw new Error("acceptedAmountUsd must exactly equal the quoted amount.");
    }
    if (options.maxAmountUsd?.trim()) {
      const maxAmountUsd = options.maxAmountUsd.trim();
      assertUsdAmount(maxAmountUsd, "maxAmountUsd");
      if (usdAmountAtomic(acceptedAmountUsd) > usdAmountAtomic(maxAmountUsd)) {
        throw new Error("acceptedAmountUsd exceeds maxAmountUsd.");
      }
    }

    const rail = options.rail ?? profile.paymentProfile.defaultRail ?? "base-usdc";
    if (rail !== "base-usdc" && rail !== "ethereum-usdc") {
      throw new Error("Quote payment currently requires an EVM USDC x402 rail.");
    }
    if (!profile.paymentProfile.supportedRails.includes(rail)) {
      throw new Error("Selected quote payment rail is not supported by this agent.");
    }
    if (!payoutWalletForRail(profile, rail)) {
      throw new Error("Seller payout wallet is missing for the selected quote payment rail.");
    }
    if (!facilitatorUrlForRail(profile, rail)) {
      throw new Error("Selected quote payment rail cannot emit a live x402 challenge yet.");
    }
    await assertQuoteBuyerWalletProof({
      agentId: options.agentId,
      requestId: quoteRequest.requestId,
      ...(options.buyerAgentId?.trim() ? { buyerAgentId: options.buyerAgentId.trim() } : {}),
      ...(options.buyerWallet?.trim() ? { buyerWallet: options.buyerWallet.trim() } : {}),
      acceptedAmountUsd,
      acceptedQuoteDigestSha256,
      ...(options.maxAmountUsd?.trim() ? { maxAmountUsd: options.maxAmountUsd.trim() } : {}),
      rail,
      settlementModel: options.settlementModel ?? "upfront-x402",
      ...(options.buyerWalletProof ? { proof: options.buyerWalletProof } : {})
    });
    this.assertAgentRuntimeReachable(
      await this.checkPublicClawzAgentReachability({
        state,
        sessionId,
        profile,
        trustModeId
      })
    );
    if (networkIdLooksMainnet(deployment) && !hasPayoutAddress(profile)) {
      throw new Error("Mainnet quote acceptance requires a payout wallet.");
    }

    const existingIntent = intents.intents.find(
      (intent) =>
        intent.requestId === quoteRequest.requestId &&
        intent.agentId === options.agentId &&
        intent.status !== "refunded"
    );
    if (existingIntent) {
      throw new Error("This quote already has an active execution intent.");
    }

    const intent = await this.createExecutionIntent({
      agentId: options.agentId,
      requestId: quoteRequest.requestId,
      rail,
      settlementModel: options.settlementModel ?? "upfront-x402",
      paymentStatus: "authorized",
      grossAmountUsd: acceptedAmountUsd,
      ...(options.buyerWallet?.trim() ? { buyerWallet: options.buyerWallet.trim() } : {}),
      paymentAuthorizationDigestSha256: acceptedQuoteDigestSha256,
      note: [
        "Accepted quote for paid execution.",
        options.buyerAgentId?.trim() ? `buyerAgentId=${options.buyerAgentId.trim().slice(0, 96)}` : ""
      ].filter(Boolean).join(" ")
    });
    await this.enqueueSocialAnchorCandidate({
      sessionId,
      kind: "quote-accepted",
      summary: `${profile.agentName} quote was accepted for exact x402 payment.`,
      occurredAtIso: new Date().toISOString(),
      payload: {
        schemaVersion: "santaclawz-quote-accepted/1.0",
        requestId: quoteRequest.requestId,
        agentId: options.agentId,
        intentId: intent.intentId,
        quoteDigestSha256: acceptedQuoteDigestSha256,
        acceptedAmountUsd,
        quoteExpiresAtIso: quote.expiresAtIso,
        rail,
        settlementModel: intent.settlementModel,
        stableIntentDigestSha256: intent.stableIntentDigestSha256,
        ...(options.buyerAgentId?.trim() ? { buyerAgentId: options.buyerAgentId.trim().slice(0, 96) } : {}),
        ...(options.buyerWallet?.trim() ? { buyerWallet: options.buyerWallet.trim() } : {})
      }
    });
    return intent;
  }

  async createExecutionIntent(options: CreateExecutionIntentOptions): Promise<ExecutionIntentRecord> {
    const [state, deployment] = await Promise.all([this.loadState(), this.getDeploymentState()]);
    const sessionId = this.resolveOwnedSessionId(state, options);
    const agentId = this.agentIdForSession(state, sessionId);
    const trustModeId = this.resolveSessionTrustMode(await this.loadEvents(), sessionId, state.activeMode);
    const profile = this.profileForSession(state, sessionId, trustModeId);
    if (isArchivedProfile(profile)) {
      throw new Error("Archived agents cannot create execution intents.");
    }

    const rail = options.rail ?? profile.paymentProfile.defaultRail ?? "base-usdc";
    if (rail !== "base-usdc" && rail !== "ethereum-usdc" && rail !== "zeko-native") {
      throw new Error("Execution intent rail is not supported.");
    }
    const grossAmountUsd = options.grossAmountUsd.trim();
    assertUsdAmount(grossAmountUsd, "Execution intent grossAmountUsd");
    const sellerNetAmountUsd = options.sellerNetAmountUsd?.trim();
    if (sellerNetAmountUsd) {
      assertUsdAmount(sellerNetAmountUsd, "Execution intent sellerNetAmountUsd");
    }
    const protocolFeeAmountUsd = options.protocolFeeAmountUsd?.trim();
    if (protocolFeeAmountUsd) {
      assertUsdAmount(protocolFeeAmountUsd, "Execution intent protocolFeeAmountUsd");
    }
    const paymentAuthorizationDigestSha256 = options.paymentAuthorizationDigestSha256?.trim();
    if (paymentAuthorizationDigestSha256) {
      assertSha256Hex(paymentAuthorizationDigestSha256, "Execution intent paymentAuthorizationDigestSha256");
    }

    const settlementModel = options.settlementModel ?? this.settlementModelForProfile(profile);
    const paymentStatus =
      options.paymentStatus ??
      (settlementModel === "reserve-release-escrow" ? "escrowed" : "settled");
    const sellerWallet = options.sellerWallet?.trim() || payoutWalletForRail(profile, rail);
    const protocolFeeRecipient = options.protocolFeeRecipient?.trim() || this.protocolFeeRecipientForRail(rail);
    const escrowContract = options.escrowContract?.trim() || this.escrowContractForRail(profile, rail);
    if (options.buyerWallet?.trim() && rail !== "zeko-native" && !looksLikeEvmAddress(options.buyerWallet.trim())) {
      throw new Error("Execution intent buyerWallet must be a valid EVM address for EVM rails.");
    }
    if (sellerWallet && rail !== "zeko-native" && !looksLikeEvmAddress(sellerWallet)) {
      throw new Error("Execution intent sellerWallet must be a valid EVM address for EVM rails.");
    }
    if (escrowContract && rail !== "zeko-native" && !looksLikeEvmAddress(escrowContract)) {
      throw new Error("Execution intent escrowContract must be a valid EVM address for EVM rails.");
    }

    const file = await this.loadExecutionIntentFile();
    const createdAtIso = new Date().toISOString();
    const intentId = `exec_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
    const stableIntentDigestSha256 = this.buildExecutionIntentStableDigest({
      intentId,
      ...(options.requestId?.trim() ? { requestId: options.requestId.trim().slice(0, 96) } : {}),
      agentId,
      sessionId,
      networkId: deployment.networkId,
      rail,
      settlementModel,
      pricingMode: profile.paymentProfile.pricingMode,
      paymentStatus,
      grossAmountUsd,
      ...(sellerNetAmountUsd ? { sellerNetAmountUsd } : {}),
      ...(protocolFeeAmountUsd ? { protocolFeeAmountUsd } : {}),
      ...(protocolFeeRecipient ? { protocolFeeRecipient } : {}),
      ...(options.buyerWallet?.trim() ? { buyerWallet: options.buyerWallet.trim() } : {}),
      ...(sellerWallet ? { sellerWallet } : {}),
      ...(escrowContract ? { escrowContract } : {}),
      ...(paymentAuthorizationDigestSha256 ? { paymentAuthorizationDigestSha256 } : {}),
      createdAtIso
    });
    const createdTransition = this.buildExecutionIntentTransition({
      intentId,
      stableIntentDigestSha256,
      transitionType: "created",
      toStatus: "pending",
      occurredAtIso: createdAtIso,
      ...(paymentAuthorizationDigestSha256 ? { evidenceDigestSha256: paymentAuthorizationDigestSha256 } : {}),
      ...(options.note?.trim() ? { note: options.note.trim().slice(0, 280) } : {})
    });
    const intent: ExecutionIntentRecord = {
      schemaVersion: EXECUTION_INTENT_SCHEMA_VERSION,
      intentId,
      ...(options.requestId?.trim() ? { requestId: options.requestId.trim().slice(0, 96) } : {}),
      agentId,
      sessionId,
      networkId: deployment.networkId,
      rail,
      settlementModel,
      status: "pending",
      pricingMode: profile.paymentProfile.pricingMode,
      paymentStatus,
      grossAmountUsd,
      ...(sellerNetAmountUsd ? { sellerNetAmountUsd } : {}),
      ...(protocolFeeAmountUsd ? { protocolFeeAmountUsd } : {}),
      ...(protocolFeeRecipient ? { protocolFeeRecipient } : {}),
      ...(options.buyerWallet?.trim() ? { buyerWallet: options.buyerWallet.trim() } : {}),
      ...(sellerWallet ? { sellerWallet } : {}),
      ...(escrowContract ? { escrowContract } : {}),
      ...(paymentAuthorizationDigestSha256 ? { paymentAuthorizationDigestSha256 } : {}),
      stableIntentDigestSha256,
      latestTransitionDigestSha256: createdTransition.transitionDigestSha256,
      lifecycle: [createdTransition],
      createdAtIso,
      updatedAtIso: createdAtIso,
      anchorCandidateIds: []
    };

    const savedFile = {
      intents: [intent, ...file.intents].slice(0, 500)
    };
    await this.saveExecutionIntentFile(savedFile);
    const anchorCandidateId = await this.enqueueExecutionIntentTransitionAnchor(intent, createdTransition);
    return this.attachExecutionTransitionAnchor(savedFile, intent.intentId, createdTransition.transitionId, anchorCandidateId);
  }

  private async transitionExecutionIntent(
    transitionType: Exclude<ExecutionIntentTransitionType, "created">,
    options: ExecutionIntentTransitionOptions
  ): Promise<ExecutionIntentRecord> {
    const file = await this.loadExecutionIntentFile();
    const intent = file.intents.find((candidate) => candidate.intentId === options.intentId);
    if (!intent) {
      throw new Error(`Unknown execution intent: ${options.intentId}`);
    }
    const evidenceDigestSha256 = options.evidenceDigestSha256?.trim();
    if (evidenceDigestSha256) {
      assertSha256Hex(evidenceDigestSha256, `Execution intent ${transitionType} evidenceDigestSha256`);
    }
    const toStatus = this.assertExecutionIntentTransitionAllowed(intent, transitionType);
    const occurredAtIso = new Date().toISOString();
    const transition = this.buildExecutionIntentTransition({
      intentId: intent.intentId,
      stableIntentDigestSha256: intent.stableIntentDigestSha256,
      transitionType,
      fromStatus: intent.status,
      toStatus,
      occurredAtIso,
      previousTransitionDigestSha256: intent.latestTransitionDigestSha256,
      ...(options.reference?.trim() ? { reference: options.reference.trim().slice(0, 160) } : {}),
      ...(evidenceDigestSha256 ? { evidenceDigestSha256 } : {}),
      ...(options.note?.trim() ? { note: options.note.trim().slice(0, 280) } : {})
    });
    const nextIntent: ExecutionIntentRecord = {
      ...intent,
      status: toStatus,
      latestTransitionDigestSha256: transition.transitionDigestSha256,
      lifecycle: [...intent.lifecycle, transition],
      updatedAtIso: occurredAtIso,
      ...(transitionType === "approved" ? { approvedAtIso: occurredAtIso } : {}),
      ...(transitionType === "executed" ? { executedAtIso: occurredAtIso } : {}),
      ...(transitionType === "settled" ? { settledAtIso: occurredAtIso } : {}),
      ...(transitionType === "refunded" ? { refundedAtIso: occurredAtIso } : {}),
      ...(transitionType === "approved" && evidenceDigestSha256 ? { paymentAuthorizationDigestSha256: evidenceDigestSha256 } : {}),
      ...(transitionType === "executed" && evidenceDigestSha256 ? { executionDigestSha256: evidenceDigestSha256 } : {}),
      ...(transitionType === "settled" && evidenceDigestSha256 ? { settlementDigestSha256: evidenceDigestSha256 } : {}),
      ...(transitionType === "refunded" && evidenceDigestSha256 ? { refundDigestSha256: evidenceDigestSha256 } : {})
    };
    const savedFile: ExecutionIntentFile = {
      intents: file.intents.map((candidate) => (candidate.intentId === intent.intentId ? nextIntent : candidate))
    };
    await this.saveExecutionIntentFile(savedFile);
    const anchorCandidateId = await this.enqueueExecutionIntentTransitionAnchor(nextIntent, transition);
    return this.attachExecutionTransitionAnchor(savedFile, intent.intentId, transition.transitionId, anchorCandidateId);
  }

  async approveExecutionIntent(options: ExecutionIntentTransitionOptions): Promise<ExecutionIntentRecord> {
    return this.transitionExecutionIntent("approved", options);
  }

  async executeExecutionIntent(options: ExecutionIntentTransitionOptions): Promise<ExecutionIntentRecord> {
    return this.transitionExecutionIntent("executed", options);
  }

  async settleExecutionIntent(options: ExecutionIntentTransitionOptions): Promise<ExecutionIntentRecord> {
    return this.transitionExecutionIntent("settled", options);
  }

  async refundExecutionIntent(options: ExecutionIntentTransitionOptions): Promise<ExecutionIntentRecord> {
    return this.transitionExecutionIntent("refunded", options);
  }

  async exportSocialAnchorBatch(options: SocialAnchorExportOptions = {}): Promise<SocialAnchorBatchExport> {
    const state = await this.loadState();
    const sessionId = this.resolveOwnedSessionId(state, options);
    this.assertAdminAccess(state, sessionId, options.adminKey);
    const [queue, deployment] = await Promise.all([this.loadSocialAnchorQueueFile(), this.getDeploymentState()]);
    this.assertSelfServeSocialAnchoringEnabled(deployment);
    return this.buildCanonicalSocialAnchorBatchExport({
      state,
      queue,
      deployment,
      sessionId,
      ...(typeof options.limit === "number" ? { limit: options.limit } : {})
    });
  }

  async commitExternalSocialAnchorBatch(options: SocialAnchorSettleOptions = {}): Promise<SocialAnchorQueueState> {
    const state = await this.loadState();
    const sessionId = this.resolveOwnedSessionId(state, options);
    this.assertAdminAccess(state, sessionId, options.adminKey);
    const deployment = await this.getDeploymentState();
    this.assertSelfServeSocialAnchoringEnabled(deployment);
    return this.settleSocialAnchorBatchForSession(sessionId, {
      ...options,
      localOnly: true
    });
  }

  async settleSocialAnchorBatch(options: SocialAnchorSettleOptions = {}): Promise<SocialAnchorQueueState> {
    const state = await this.loadState();
    const sessionId = this.resolveOwnedSessionId(state, options);
    this.assertAdminAccess(state, sessionId, options.adminKey);
    return this.settleSocialAnchorBatchForSession(sessionId, options);
  }

  async refreshSellerReadiness(options: SellerReadinessRefreshOptions = {}) {
    const state = await this.loadState();
    const sessionId = this.resolveOwnedSessionId(state, options);
    this.assertAdminAccess(state, sessionId, options.adminKey);
    const agentId = this.agentIdForSession(state, sessionId);
    const publishRequested = options.publish !== false;
    const consoleStateOptions = {
      sessionId,
      ...(options.adminKey ? { adminKey: options.adminKey } : {})
    };
    const before = await this.getConsoleState(consoleStateOptions);
    let publish:
      | {
          attempted: boolean;
          ok: boolean;
          status: number;
          createdCandidate?: boolean;
          alreadyPublished?: boolean;
          error?: string;
          confirmedCount?: number;
          anchoredCount?: number;
          latestRootDigestSha256?: string;
        }
      | undefined;

    if (publishRequested && before.published !== true) {
      try {
        const ensured = await this.ensureAgentPublishedAnchorCandidate(state, sessionId);
        const queue = await this.settleSocialAnchorBatchForSession(sessionId, {
          ...(options.localOnly ? { localOnly: true } : {}),
          operatorNote: options.operatorNote ?? "Seller readiness refresh"
        });
        publish = {
          attempted: true,
          ok: true,
          status: 200,
          createdCandidate: ensured.created,
          alreadyPublished: ensured.alreadyPublished,
          confirmedCount: queue.confirmedCount,
          anchoredCount: queue.anchoredCount,
          ...(queue.latestRootDigestSha256 ? { latestRootDigestSha256: queue.latestRootDigestSha256 } : {})
        };
      } catch (error) {
        publish = {
          attempted: true,
          ok: false,
          status: error instanceof SelfServeSocialAnchoringDisabledError ? 403 : 400,
          error: error instanceof Error ? error.message : "Unable to refresh publish state."
        };
      }
    } else {
      publish = {
        attempted: false,
        ok: before.published === true,
        status: before.published === true ? 200 : 204,
        alreadyPublished: before.published === true
      };
    }

    const [stateAfter, availability] = await Promise.all([
      this.getConsoleState(consoleStateOptions),
      options.verifyAvailability === false
        ? Promise.resolve(undefined)
        : this.getAgentRuntimeAvailability({ sessionId, agentId }).catch((error: unknown) => ({
            agentId,
            sessionId,
            openClawUrl: "",
            runtimeDeliveryMode: "santaclawz-relay" as const,
            checkedAtIso: new Date().toISOString(),
            reachable: false,
            status: "offline" as const,
            reason: error instanceof Error ? error.message : "Unable to verify runtime availability."
          }))
    ]);
    const readiness = stateAfter.readiness;
    return {
      agentId,
      sessionId,
      generatedAtIso: new Date().toISOString(),
      hireable: readiness?.hireable === true,
      relayConnected: readiness?.relayConnected === true,
      heartbeatLive: readiness?.heartbeatLive === true,
      runtimeReachable: readiness?.runtimeReachable === true,
      workerReachable: readiness?.workerReachable === true,
      paymentReady: readiness?.paymentReady === true,
      published: stateAfter.published === true,
      lastJobStatus: readiness?.lastJobStatus ?? "none",
      blockers: readiness?.blockers ?? [],
      publish,
      ...(availability ? { availability } : {}),
      state: {
        paidJobsEnabled: stateAfter.paidJobsEnabled,
        paymentProfileReady: stateAfter.paymentProfileReady,
        payoutAddressConfigured: stateAfter.payoutAddressConfigured,
        pricingMode: stateAfter.profile.paymentProfile.pricingMode,
        runtimeDeliveryMode: stateAfter.profile.runtimeDelivery.mode
      }
    };
  }

  async setTrustMode(modeId: TrustModeId, sessionId?: string, adminKey?: string): Promise<ConsoleStateResponse> {
    const state = await this.loadState();
    const events = await this.loadEvents();
    const liveFlow = await this.getLiveFlowState();
    const focus = this.resolveSessionFocus(state, events, this.buildLiveFlowTargets(events, liveFlow), liveFlow, sessionId);
    this.assertAdminAccess(state, focus.sessionId, adminKey);
    const baseState = this.applyFocusedSession(state, focus.sessionId, modeId);
    const fallbackProfile = buildDefaultProfile(modeId);
    const currentProfile = this.profileForSession(state, focus.sessionId, modeId);
    const nextState: ConsolePersistenceState = {
      ...baseState,
      profilesBySession: {
        ...baseState.profilesBySession,
        [focus.sessionId]: this.sanitizeProfileInput(modeId, currentProfile, {
          ...fallbackProfile,
          ...currentProfile
        })
      }
    };
    await this.saveState(nextState);
    await this.appendEvent("SessionCheckpointed", {
      sessionId: focus.sessionId,
      trustMode: modeId
    });
    return this.getConsoleState({ sessionId: focus.sessionId, ...(adminKey ? { adminKey } : {}) });
  }

  async updateAgentProfile(
    sessionId: string | undefined,
    input: AgentProfileInput,
    adminKey?: string
  ): Promise<ConsoleStateResponse> {
    const state = await this.loadState();
    const events = await this.loadEvents();
    const liveFlow = await this.getLiveFlowState();
    const liveFlowTargets = this.buildLiveFlowTargets(events, liveFlow);
    const focus = this.resolveSessionFocus(state, events, liveFlowTargets, liveFlow, sessionId);
    this.assertAdminAccess(state, focus.sessionId, adminKey);
    const trustModeId = focus.trustModeId;
    const fallbackProfile = buildDefaultProfile(trustModeId);
    const currentProfile = this.profileForSession(state, focus.sessionId, trustModeId);
    const deployment = await this.getDeploymentState();
    const socialAnchorQueueFile = await this.loadSocialAnchorQueueFile();
    const wasPublished = isSessionPublishedOnZeko({
      liveFlowTargets,
      socialAnchorQueueFile,
      sessionId: focus.sessionId,
      durablePublished: Boolean(state.publishedSessionsBySession[focus.sessionId])
    });
    const wasPaymentReady = computePaidJobsEnabled(currentProfile, wasPublished, deployment);
    const nextProfile = this.coerceProfileForDeployment(this.sanitizeProfileInput(trustModeId, input, {
      ...fallbackProfile,
      ...currentProfile
    }), deployment);
    await this.assertAgentProfileIsValid(state, nextProfile, focus.sessionId);
    if (nextProfile.openClawUrl !== currentProfile.openClawUrl && !isRelayDeliveryProfile(nextProfile)) {
      await this.validatePublicClawzAgentHealth(nextProfile.openClawUrl);
    }
    const nextState: ConsolePersistenceState = {
      ...this.applyFocusedSession(state, focus.sessionId, trustModeId),
      profilesBySession: {
        ...state.profilesBySession,
        [focus.sessionId]: nextProfile
      },
      ownershipBySession: {
        ...state.ownershipBySession,
        [focus.sessionId]:
          nextProfile.openClawUrl !== currentProfile.openClawUrl
            ? buildDefaultOwnershipRecord(false)
            : this.ownershipRecordForSession(state, focus.sessionId)
      }
    };
    await this.saveState(nextState);
    await this.appendEvent("SessionCheckpointed", {
      sessionId: focus.sessionId,
      profileUpdated: true
    });
    const nextPaymentReady = computePaidJobsEnabled(nextProfile, wasPublished, await this.getDeploymentState());
    if (wasPublished && nextProfile.headline.trim() !== currentProfile.headline.trim() && nextProfile.headline.trim().length > 0) {
      await this.enqueueSocialAnchorCandidate({
        sessionId: focus.sessionId,
        kind: "operator-dispatch",
        summary: nextProfile.headline,
        payload: {
          agentId: this.agentIdForSession(nextState, focus.sessionId),
          headline: nextProfile.headline
        }
      });
    }
    if (
      wasPublished &&
      !agentMarketplaceTagsAreEmpty(nextProfile.marketplaceTags) &&
      marketplaceTagsDigest(nextProfile.marketplaceTags) !== marketplaceTagsDigest(currentProfile.marketplaceTags)
    ) {
      await this.enqueueMarketplaceTagDeclarationAnchor(focus.sessionId, nextProfile);
    }
    if (wasPublished && !wasPaymentReady && nextPaymentReady) {
      await this.enqueueSocialAnchorCandidate({
        sessionId: focus.sessionId,
        kind: "payment-terms-live",
        summary: `${nextProfile.agentName} opened for work with ${nextProfile.paymentProfile.defaultRail ?? "its selected rail"}.`,
        payload: {
          agentId: this.agentIdForSession(nextState, focus.sessionId),
          defaultRail: nextProfile.paymentProfile.defaultRail,
          pricingMode: nextProfile.paymentProfile.pricingMode
        }
      });
    }
    return this.getConsoleState({ sessionId: focus.sessionId, ...(adminKey ? { adminKey } : {}) });
  }

  async verifyMissionAuthOverlay(options: {
    sessionId?: string;
    agentId?: string;
    missionAuthOverlay?: Partial<AgentProfileState["missionAuthOverlay"]>;
    adminKey?: string;
  }): Promise<ConsoleStateResponse> {
    const state = await this.loadState();
    const events = await this.loadEvents();
    const sessionId = this.resolveOwnedSessionId(state, options);
    this.assertAdminAccess(state, sessionId, options.adminKey);
    const trustModeId = this.resolveSessionTrustMode(events, sessionId, state.activeMode);
    const currentProfile = this.profileForSession(state, sessionId, trustModeId);
    const missionAuthOverlay = await this.checkMissionAuthOverlay(
      options.missionAuthOverlay ?? currentProfile.missionAuthOverlay
    );
    const nextProfile: AgentProfileState = {
      ...currentProfile,
      missionAuthOverlay
    };

    await this.assertAgentProfileIsValid(state, nextProfile, sessionId);

    const nextState: ConsolePersistenceState = {
      ...this.applyFocusedSession(state, sessionId, trustModeId),
      profilesBySession: {
        ...state.profilesBySession,
        [sessionId]: nextProfile
      }
    };

    await this.saveState(nextState);
    await this.appendEvent("SessionCheckpointed", {
      sessionId,
      missionAuthVerified: true
    });

    return this.getConsoleState({
      sessionId,
      ...(options.adminKey ? { adminKey: options.adminKey } : {})
    });
  }

  async setAgentArchiveStatus(options: AgentArchiveOptions): Promise<ConsoleStateResponse> {
    const state = await this.loadState();
    const events = await this.loadEvents();
    const liveFlow = await this.getLiveFlowState();
    const liveFlowTargets = this.buildLiveFlowTargets(events, liveFlow);
    const requestedSessionId =
      typeof options.sessionId === "string" && options.sessionId.trim().length > 0
        ? options.sessionId.trim()
        : typeof options.agentId === "string" && options.agentId.trim().length > 0
          ? this.resolveSessionIdFromAgentId(state, options.agentId.trim())
          : undefined;
    const focus = this.resolveSessionFocus(state, events, liveFlowTargets, liveFlow, requestedSessionId);
    this.assertAdminAccess(state, focus.sessionId, options.adminKey);
    const trustModeId = focus.trustModeId;
    const currentProfile = this.profileForSession(state, focus.sessionId, trustModeId);
    const nextArchivedAtIso = options.archived ? new Date().toISOString() : undefined;
    const nextProfile: AgentProfileState = {
      ...currentProfile,
      availability: options.archived ? "archived" : "active",
      ...(nextArchivedAtIso ? { archivedAtIso: nextArchivedAtIso } : {})
    };
    if (!nextArchivedAtIso) {
      delete (nextProfile as { archivedAtIso?: string }).archivedAtIso;
    }

    const nextState: ConsolePersistenceState = {
      ...this.applyFocusedSession(state, focus.sessionId, trustModeId),
      profilesBySession: {
        ...state.profilesBySession,
        [focus.sessionId]: nextProfile
      }
    };
    await this.saveState(nextState);
    await this.appendEvent(
      "SessionCheckpointed",
      {
        sessionId: focus.sessionId,
        agentArchived: options.archived,
        agentAvailability: nextProfile.availability
      },
      nextArchivedAtIso ?? new Date().toISOString()
    );
    return this.getConsoleState({ sessionId: focus.sessionId, ...(options.adminKey ? { adminKey: options.adminKey } : {}) });
  }

  async setAgentPlatformModerationStatus(options: AdminAgentModerationOptions): Promise<{
    updated: true;
    sessionId: string;
    agentId: string;
    availability: AgentAvailabilityState;
    updatedAtIso: string;
    reason: string;
  }> {
    const state = await this.loadState();
    const sessionId =
      typeof options.sessionId === "string" && options.sessionId.trim().length > 0
        ? options.sessionId.trim()
        : typeof options.agentId === "string" && options.agentId.trim().length > 0
          ? this.resolveSessionIdFromAgentId(state, options.agentId.trim())
          : undefined;

    if (!sessionId) {
      throw new Error("Provide a known agentId or sessionId to moderate.");
    }
    if (!sessionId.startsWith("session_agent_")) {
      throw new Error("Only registered agent sessions can be moderated through this path.");
    }

    const currentProfile = this.profileForSession(state, sessionId);
    const updatedAtIso = new Date().toISOString();
    const reason =
      typeof options.reason === "string" && options.reason.trim().length > 0
        ? options.reason.trim().slice(0, 240)
        : "Platform moderation";
    const nextProfile: AgentProfileState = {
      ...currentProfile,
      availability: options.availability,
      ...(options.availability === "active" ? {} : { archivedAtIso: updatedAtIso })
    };
    if (options.availability === "active") {
      delete (nextProfile as { archivedAtIso?: string }).archivedAtIso;
    }

    await this.saveState({
      ...state,
      profilesBySession: {
        ...state.profilesBySession,
        [sessionId]: nextProfile
      }
    });

    const agentId = this.agentIdForSession(state, sessionId);
    await this.appendEvent("SessionCheckpointed", {
      sessionId,
      agentId,
      platformModerationStatus: options.availability,
      operatorReason: reason
    }, updatedAtIso);

    return {
      updated: true,
      sessionId,
      agentId,
      availability: nextProfile.availability,
      updatedAtIso,
      reason
    };
  }

  async deleteAgentRegistration(options: DeleteAgentRegistrationOptions): Promise<{
    deleted: true;
    sessionId: string;
    agentId: string;
    deletedAtIso: string;
    reason: string;
  }> {
    const state = await this.loadState();
    const sessionId =
      typeof options.sessionId === "string" && options.sessionId.trim().length > 0
        ? options.sessionId.trim()
        : typeof options.agentId === "string" && options.agentId.trim().length > 0
          ? this.resolveSessionIdFromAgentId(state, options.agentId.trim())
          : undefined;

    if (!sessionId) {
      throw new Error("Provide a known agentId or sessionId to delete.");
    }
    if (!sessionId.startsWith("session_agent_")) {
      throw new Error("Only registered OpenClaw agent sessions can be deleted through this cleanup path.");
    }

    const agentId = this.agentIdForSession(state, sessionId);
    if (options.agentId && options.agentId.trim() !== agentId) {
      throw new Error("The provided agentId does not match the resolved session.");
    }

    const deletedAtIso = new Date().toISOString();
    const reason =
      typeof options.reason === "string" && options.reason.trim().length > 0
        ? options.reason.trim().slice(0, 240)
        : "Operator cleanup";
    const nextAgentIdsBySession = { ...state.agentIdsBySession };
    const nextProfilesBySession = { ...state.profilesBySession };
    const nextAdminKeysBySession = { ...state.adminKeysBySession };
    const nextIngressSecretsBySession = { ...state.ingressSecretsBySession };
    const nextOwnershipBySession = { ...state.ownershipBySession };
    delete nextAgentIdsBySession[sessionId];
    delete nextProfilesBySession[sessionId];
    delete nextAdminKeysBySession[sessionId];
    delete nextIngressSecretsBySession[sessionId];
    delete nextOwnershipBySession[sessionId];

    const nextState: ConsolePersistenceState = {
      ...state,
      currentSessionId: state.currentSessionId === sessionId ? DEFAULT_SESSION_ID : state.currentSessionId,
      agentIdsBySession: nextAgentIdsBySession,
      profilesBySession: nextProfilesBySession,
      adminKeysBySession: nextAdminKeysBySession,
      ingressSecretsBySession: nextIngressSecretsBySession,
      ownershipBySession: nextOwnershipBySession,
      deletedAgentRegistrationsBySession: {
        ...state.deletedAgentRegistrationsBySession,
        [sessionId]: {
          agentId,
          deletedAtIso,
          reason
        }
      }
    };

    await this.saveState(nextState);
    await this.appendEvent("SessionCheckpointed", {
      sessionId,
      agentId,
      agentRegistrationDeleted: true,
      operatorReason: reason
    }, deletedAtIso);

    return {
      deleted: true,
      sessionId,
      agentId,
      deletedAtIso,
      reason
    };
  }

  async sponsorWallet(options: SponsorWalletOptions = {}): Promise<ConsoleStateResponse> {
    const amountMina = options.amountMina ?? "0.10";
    const requestedPurpose = options.purpose ?? "top-up";
    const explicitSponsorRequest = options.amountMina !== undefined || requestedPurpose === "top-up";
    const state = await this.loadState();
    const events = await this.loadEvents();
    const liveFlow = await this.getLiveFlowState();
    const focus = this.resolveSessionFocus(
      state,
      events,
      this.buildLiveFlowTargets(events, liveFlow),
      liveFlow,
      options.sessionId
    );
    this.assertAdminAccess(state, focus.sessionId, options.adminKey);
    const queue = await this.loadSponsorQueueFile();
    const existingPendingJob = queue.jobs.find(
      (job) => job.sessionId === focus.sessionId && (job.status === "queued" || job.status === "running")
    );
    if (existingPendingJob) {
      throw new Error("Sponsor queue already has a pending job for this agent.");
    }

    const remainingBudget = Number.parseFloat(state.wallet.sponsoredRemainingMina || "0");
    if (Number.isFinite(remainingBudget) && remainingBudget >= 0.2 && !explicitSponsorRequest) {
      throw new Error("Shadow wallet already has enough sponsored balance for the next publish.");
    }

    const slug = randomUUID().replace(/-/g, "").slice(0, 12);
    const requestedAtIso = new Date().toISOString();
    const nextJob: SponsorQueueJob = {
      jobId: `sponsor_${slug}`,
      sessionId: focus.sessionId,
      amountMina,
      purpose: requestedPurpose,
      status: "queued",
      requestedAtIso,
      note: "Queued for SantaClawz sponsor processing."
    };

    await this.saveSponsorQueueFile({
      jobs: [...queue.jobs, nextJob]
    });
    void this.runSponsorQueue();

    return this.getConsoleState({
      sessionId: focus.sessionId,
      ...(options.adminKey ? { adminKey: options.adminKey } : {})
    });
  }

  async prepareRecoveryKit(sessionId?: string, adminKey?: string): Promise<ConsoleStateResponse> {
    const state = await this.loadState();
    const events = await this.loadEvents();
    const liveFlow = await this.getLiveFlowState();
    const focus = this.resolveSessionFocus(state, events, this.buildLiveFlowTargets(events, liveFlow), liveFlow, sessionId);
    this.assertAdminAccess(state, focus.sessionId, adminKey);
    const preparedAtIso = new Date().toISOString();
    const manifest = await this.blobStore.sealJson({
      scope: {
        tenantId: DEFAULT_TENANT_ID,
        workspaceId: DEFAULT_WORKSPACE_ID,
        sessionId: focus.sessionId
      },
      visibility: "team-sealed",
      retentionPolicy: sampleRetentionPolicy,
      sessionId: focus.sessionId,
      artifactClass: "recovery-kit",
      payload: {
        recoveryId: `recovery_${randomUUID()}`,
        walletId: state.wallet.walletId,
        guardians: state.wallet.guardians,
        threshold: state.wallet.recovery.guardiansRequired,
        preparedAtIso
      }
    });

    const nextState: ConsolePersistenceState = {
      ...this.applyFocusedSession(state, focus.sessionId, focus.trustModeId),
      wallet: {
        ...state.wallet,
        trustModeId: focus.trustModeId,
        deviceStatus: "recoverable",
        recovery: {
          ...state.wallet.recovery,
          status: "sealed",
          bundleManifestId: manifest.manifestId,
          sealedAtIso: preparedAtIso,
          lastRotationAtIso: preparedAtIso
        }
      }
    };

    await this.saveState(nextState);
    await this.appendEvent("SessionKeysRotated", {
      sessionId: focus.sessionId,
      bundleManifestId: manifest.manifestId,
      reason: "recovery-kit-prepared"
    }, preparedAtIso);
    await this.appendEvent("ArtifactSealed", {
      sessionId: focus.sessionId,
      manifestId: manifest.manifestId,
      artifactClass: manifest.artifactClass,
      payloadDigest: manifest.payloadDigest,
      visibility: manifest.visibility
    }, preparedAtIso);
    return this.getConsoleState({ sessionId: focus.sessionId, ...(adminKey ? { adminKey } : {}) });
  }

  async approvePrivacyException(
    exceptionId: string,
    actorId = "guardian_compliance",
    actorRole: PrivacyApprovalRecord["actorRole"] | undefined = "compliance-reviewer",
    note = "Approved for scoped disclosure.",
    sessionId?: string
  ): Promise<ConsoleStateResponse> {
    const state = await this.loadState();
    const nowIso = new Date().toISOString();
    const nextExceptions = state.privacyExceptions.map((item) => {
      if (item.id !== exceptionId || item.status === "expired") {
        return item;
      }

      const alreadyApproved = item.approvals.some((approval) => approval.actorId === actorId);
      const approvals = alreadyApproved
        ? item.approvals
        : [...item.approvals, buildPrivacyApproval(actorId, actorRole ?? "compliance-reviewer", note, nowIso)];
      return {
        ...item,
        approvals,
        status: approvals.length >= item.requiredApprovals ? "approved" as const : item.status
      };
    });

    const target = nextExceptions.find((item) => item.id === exceptionId);
    if (!target) {
      throw new Error(`Unknown privacy exception: ${exceptionId}`);
    }

    const nextState = {
      ...state,
      privacyExceptions: nextExceptions
    };

    await this.saveState(nextState);
    await this.appendEvent("ApprovalGranted", {
      sessionId: target.sessionId,
      turnId: target.turnId,
      exceptionId,
      actorId,
      actorRole,
      note
    }, nowIso);

    if (target.status === "approved") {
      await this.appendEvent("PrivacyExceptionGranted", {
        sessionId: target.sessionId,
        turnId: target.turnId,
        exceptionId,
        audience: target.audience,
        approvals: target.approvals.length
      }, nowIso);
    }

    return this.getConsoleState({ sessionId: sessionId ?? target.sessionId });
  }

  async ingestEvent(input: unknown): Promise<ClawzEvent> {
    const event = assertClawzEvent(input);
    const events = await this.loadEvents();
    if (events.some((existing) => existing.id === event.id)) {
      throw new Error(`Event already exists: ${event.id}`);
    }

    events.push(event);
    await this.saveEvents(events);

    const state = await this.loadState();
    const nextState = await this.reconcileStateFromEvent(state, event);
    await this.saveState(nextState);
    return event;
  }
}
