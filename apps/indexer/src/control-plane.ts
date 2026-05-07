import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createSealedBlobStore, type SealedBlobStore } from "@clawz/blob-store";
import {
  buildSocialAnchorBatchRootField,
  submitSocialAnchorBatchOnZeko
} from "@clawz/contracts";
import { createTenantKeyBroker, type TenantKeyBrokerRuntimeDescriptor, TenantKeyBroker } from "@clawz/key-broker";
import {
  canonicalDigest,
  type AgentRuntimeHeartbeatState,
  type AgentRuntimeStatus,
  type AgentRuntimeAvailabilityState,
  type AgentRegistryEntry,
  type AgentOwnershipChallengeState,
  type AgentOwnershipState,
  type AgentOwnershipVerificationState,
  type AgentProfileState,
  type HireRequestReceipt,
  type SponsorQueueJob,
  type SponsorQueueState,
  TRUST_MODE_PRESETS,
  assertClawzEvent,
  sampleRetentionPolicy,
  type ArtifactSummary,
  type ClawzEvent,
  type ConsoleStateResponse,
  type LiveFlowDisclosureTarget,
  type LiveSessionTurnFlowState,
  type LiveFlowTargets,
  type LiveFlowTurnTarget,
  type PrivacyApprovalRecord,
  type PrivacyExceptionQueueItem,
  type SocialAnchorBatch,
  type SocialAnchorBatchExport,
  type SocialAnchorCandidate,
  type SocialAnchorCandidateKind,
  type SocialAnchorQueueState,
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
const PUBLICCLAW_OWNERSHIP_CHALLENGE_PATH = "/.well-known/santaclawz-agent-challenge.json";
const OWNERSHIP_CHALLENGE_TTL_MS = 15 * 60 * 1000;
const AGENT_RUNTIME_CHECK_TIMEOUT_MS = 5000;
const AGENT_RUNTIME_HEARTBEAT_DEFAULT_TTL_SECONDS = 30;
const AGENT_RUNTIME_HEARTBEAT_MIN_TTL_SECONDS = 10;
const AGENT_RUNTIME_HEARTBEAT_MAX_TTL_SECONDS = 300;
const HIRE_REQUEST_SCHEMA_VERSION = "santaclawz-request/1.0";
const HIRE_RETURN_SCHEMA_VERSION = "santaclawz-return/1.0";
const HIRE_INGRESS_TIMEOUT_MS = 10_000;
const HIRE_INGRESS_RETURN_MAX_BYTES = 128 * 1024;
const HIRE_TASK_PROMPT_MAX_LENGTH = 2000;
const HIRE_REQUESTER_CONTACT_MAX_LENGTH = 240;
const ENROLLMENT_TICKET_TTL_MS = 15 * 60 * 1000;
const ENROLLMENT_TICKET_SCHEMA_VERSION = "santaclawz-enrollment-ticket/1.0";
type LiveFlowKind = "first-turn" | "next-turn" | "abort-turn" | "refund-turn" | "revoke-disclosure";
type HireIngressRequestKind = "quote" | "paid-execution";

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
  schemaVersion: 5;
  currentSessionId: string;
  activeMode: TrustModeId;
  wallet: ShadowWalletState;
  privacyExceptions: PrivacyExceptionQueueItem[];
  agentIdsBySession: Record<string, string>;
  profilesBySession: Record<string, AgentProfileState>;
  adminKeysBySession: Record<string, SessionAdminAccessRecord>;
  ingressSecretsBySession: Record<string, SessionIngressSecretRecord>;
  ownershipBySession: Record<string, SessionOwnershipRecord>;
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

interface SessionIngressSecretRecord {
  token: string;
  tokenHint: string;
  signingSecret: string;
  signingSecretHint: string;
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
  profile: RegisterAgentOptions;
  redeemedAtIso?: string;
  redeemedSessionId?: string;
  redeemedAgentId?: string;
}

export class DuplicatePublicClawUrlError extends Error {
  existingAgentId: string;
  canReclaim: boolean;

  constructor(message: string, existingAgentId: string, canReclaim: boolean) {
    super(message);
    this.name = "DuplicatePublicClawUrlError";
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

interface SocialAnchorExportOptions {
  sessionId?: string;
  agentId?: string;
  limit?: number;
  adminKey?: string;
}

interface RegisterAgentOptions {
  agentName: string;
  representedPrincipal?: string;
  headline: string;
  openClawUrl: string;
  payoutWallets?: AgentProfileState["payoutWallets"];
  missionAuthOverlay?: Partial<AgentProfileState["missionAuthOverlay"]>;
  paymentProfile?: Partial<AgentProfileState["paymentProfile"]>;
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
  challengePath: string;
  challengeUrl: string;
  enrollmentChallenge: {
    schemaVersion: typeof ENROLLMENT_TICKET_SCHEMA_VERSION;
    ticketId: string;
    ticketDigestSha256: string;
    challengeUrl: string;
    publicClawUrl: string;
  };
}

interface EnrollmentTicketRedeemResult extends ConsoleStateResponse {
  issuedOwnershipChallenge: OwnershipChallengeIssueResult["issuedOwnershipChallenge"];
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

type AgentProfileInput = Partial<Omit<AgentProfileState, "paymentProfile" | "socialAnchorPolicy" | "missionAuthOverlay">> & {
  missionAuthOverlay?: Partial<AgentProfileState["missionAuthOverlay"]>;
  paymentProfile?: Partial<AgentProfileState["paymentProfile"]>;
  socialAnchorPolicy?: Partial<AgentProfileState["socialAnchorPolicy"]>;
  payoutAddress?: unknown;
};

interface SubmitHireRequestOptions {
  agentId: string;
  taskPrompt: string;
  budgetMina?: string;
  requesterContact: string;
  paymentAuthorization?: HirePaymentAuthorization;
}

interface HirePaymentAuthorization {
  status: "not-required" | "authorized" | "settled";
  rail?: string;
  amountUsd?: string;
  authorizationId?: string;
  settlementReference?: string;
  paymentPayloadDigestSha256?: string;
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
}

interface AgentRuntimeHeartbeatFile {
  heartbeats: AgentRuntimeHeartbeatRecord[];
}

interface AgentRuntimeHeartbeatOptions extends AgentRuntimeAvailabilityOptions {
  status?: AgentRuntimeStatus;
  ttlSeconds?: number;
  note?: string;
  adminKey?: string;
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
  status: HireRequestReceipt["status"];
  taskPrompt: string;
  budgetMina?: string;
  requesterContact: string;
  deliveryTarget: string;
  deliveryStatus?: "forwarded" | "recorded";
  ingressBodyDigestSha256?: string;
  ingressResponseStatusCode?: number;
  protocolReturn?: HireRequestReceipt["protocolReturn"];
  payment?: HirePaymentAuthorization;
}

interface HireRequestFile {
  requests: HireRequestRecord[];
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
    schemaVersion: 5,
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
    representedPrincipal: "Existing OpenClaw operator",
    headline: "Private, verifiable agent work on Zeko.",
    openClawUrl: "",
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
    socialAnchorPolicy: {
      mode: "shared-batched"
    },
    preferredProvingLocation: trustMode.defaultProvingLocation
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
  return new URL(PUBLICCLAW_OWNERSHIP_CHALLENGE_PATH, openClawUrl).toString();
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

function assertSha256Hex(value: string, context: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${context} must be a lowercase sha256 hex digest.`);
  }
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
    requests: []
  };
}

function buildDefaultSocialAnchorQueueFile(): SocialAnchorQueueFile {
  return {
    items: [],
    batches: []
  };
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
    case "paid-execution-completed":
      return "Paid execution completed";
    case "hire-request-failed":
      return "Hire request failed";
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

function allowTestnetSelfServeSocialAnchor(): boolean {
  const value = process.env.CLAWZ_ALLOW_TESTNET_SELF_SERVE_SOCIAL_ANCHOR?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
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
    input?.pricingMode === "fixed-exact" ||
    input?.pricingMode === "capped-exact" ||
    input?.pricingMode === "quote-required" ||
    input?.pricingMode === "agent-negotiated"
      ? input.pricingMode
      : fallback.pricingMode;
  const settlementTrigger =
    input?.settlementTrigger === "upfront" || input?.settlementTrigger === "on-proof"
      ? input.settlementTrigger
      : fallback.settlementTrigger;

  return {
    enabled: typeof input?.enabled === "boolean" ? input.enabled : fallback.enabled,
    supportedRails: normalizedRails,
    ...(defaultRail ? { defaultRail } : {}),
    pricingMode,
    ...(sanitizeUsdAmount(input?.fixedAmountUsd) ?? sanitizeUsdAmount(fallback.fixedAmountUsd)
      ? { fixedAmountUsd: sanitizeUsdAmount(input?.fixedAmountUsd) ?? sanitizeUsdAmount(fallback.fixedAmountUsd)! }
      : {}),
    ...(sanitizeUsdAmount(input?.maxAmountUsd) ?? sanitizeUsdAmount(fallback.maxAmountUsd)
      ? { maxAmountUsd: sanitizeUsdAmount(input?.maxAmountUsd) ?? sanitizeUsdAmount(fallback.maxAmountUsd)! }
      : {}),
    ...(sanitizeUrl(input?.quoteUrl) ?? sanitizeUrl(fallback.quoteUrl)
      ? { quoteUrl: sanitizeUrl(input?.quoteUrl) ?? sanitizeUrl(fallback.quoteUrl)! }
      : {}),
    ...(sanitizeUsdAmount(input?.referencePriceUsd) ?? sanitizeUsdAmount(fallback.referencePriceUsd)
      ? {
          referencePriceUsd:
            sanitizeUsdAmount(input?.referencePriceUsd) ?? sanitizeUsdAmount(fallback.referencePriceUsd)!
        }
      : {}),
    ...(input?.referencePriceUnit === "minimum" ||
    input?.referencePriceUnit === "agent-minute" ||
    input?.referencePriceUnit === "compute-unit"
      ? { referencePriceUnit: input.referencePriceUnit }
      : fallback.referencePriceUnit
        ? { referencePriceUnit: fallback.referencePriceUnit }
        : {}),
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
  return mode === "quote-required" || mode === "agent-negotiated";
}

function hasReadyPaymentProfile(profile: AgentProfileState): boolean {
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
  if (profile.paymentProfile.pricingMode === "capped-exact") {
    return typeof profile.paymentProfile.maxAmountUsd === "string" && profile.paymentProfile.maxAmountUsd.trim().length > 0;
  }
  if (isQuotedPricingMode(profile.paymentProfile.pricingMode)) {
    return typeof profile.paymentProfile.referencePriceUsd === "string" && profile.paymentProfile.referencePriceUsd.trim().length > 0;
  }
  return true;
}

function isArchivedProfile(profile: AgentProfileState): boolean {
  return profile.availability === "archived";
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
  private readonly socialAnchorQueuePath: string;
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
    this.socialAnchorQueuePath = path.join(baseDir, "state", "social-anchor-queue.json");
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
        schemaVersion: 5,
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
        deletedAgentRegistrationsBySession: state.deletedAgentRegistrationsBySession ?? {},
        enrollmentTicketsById: state.enrollmentTicketsById ?? {}
      };
      if (
        state.schemaVersion !== 5 ||
        !state.agentIdsBySession ||
        Object.keys(state.agentIdsBySession).length === 0 ||
        !state.profilesBySession ||
        Object.keys(state.profilesBySession).length === 0 ||
        !state.adminKeysBySession ||
        !state.ingressSecretsBySession ||
        !state.ownershipBySession ||
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
      return file;
    }

    const fallback = buildDefaultHireRequestFile();
    await this.saveHireRequestFile(fallback);
    return fallback;
  }

  private async saveHireRequestFile(file: HireRequestFile) {
    await this.ensureDirs();
    await writeJsonFile(this.hireRequestPath, file);
  }

  private async loadSocialAnchorQueueFile(): Promise<SocialAnchorQueueFile> {
    await this.ensureDirs();
    const file = await readJsonFile<SocialAnchorQueueFile>(this.socialAnchorQueuePath);
    if (file?.items && file?.batches) {
      return {
        items: file.items.map((item) => ({
          ...item,
          anchorMode: item.anchorMode ?? "shared-batched"
        })),
        batches: file.batches.map((batch) => ({
          ...batch,
          sessionId: batch.sessionId ?? "",
          agentId: batch.agentId ?? "",
          anchorMode: batch.anchorMode ?? "shared-batched"
        }))
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

  private canAutoAnchorSharedBatches(deployment: Pick<ZekoDeploymentState, "contracts">): boolean {
    const hasSubmitterKey =
      (typeof process.env.CLAWZ_SOCIAL_ANCHOR_SUBMITTER_PRIVATE_KEY === "string" &&
        process.env.CLAWZ_SOCIAL_ANCHOR_SUBMITTER_PRIVATE_KEY.trim().length > 0) ||
      (typeof process.env.DEPLOYER_PRIVATE_KEY === "string" && process.env.DEPLOYER_PRIVATE_KEY.trim().length > 0);
    const hasSocialAnchorPrivateKey =
      (typeof process.env.SOCIAL_ANCHOR_PRIVATE_KEY === "string" && process.env.SOCIAL_ANCHOR_PRIVATE_KEY.trim().length > 0) ||
      (typeof process.env.CLAWZ_SOCIAL_ANCHOR_PRIVATE_KEY === "string" &&
        process.env.CLAWZ_SOCIAL_ANCHOR_PRIVATE_KEY.trim().length > 0);
    return Boolean(this.configuredSocialAnchorContractAddress(deployment) && hasSubmitterKey && hasSocialAnchorPrivateKey);
  }

  private async submitSocialAnchorBatchToZeko(options: {
    batchId: string;
    sessionId: string;
    rootDigestSha256: string;
    deployment: Pick<ZekoDeploymentState, "networkId" | "graphqlEndpoint" | "archiveEndpoint" | "contracts">;
  }) {
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
      ...(parsePositiveIntegerEnv(process.env.CLAWZ_SOCIAL_ANCHOR_MAX_SEND_ATTEMPTS, 5)
        ? { maxAttempts: parsePositiveIntegerEnv(process.env.CLAWZ_SOCIAL_ANCHOR_MAX_SEND_ATTEMPTS, 5)! }
        : {}),
      ...(parsePositiveIntegerEnv(process.env.CLAWZ_SOCIAL_ANCHOR_RETRY_DELAY_MS, 30_000)
        ? { retryDelayMs: parsePositiveIntegerEnv(process.env.CLAWZ_SOCIAL_ANCHOR_RETRY_DELAY_MS, 30_000)! }
        : {}),
      ...(parsePositiveIntegerEnv(process.env.CLAWZ_SOCIAL_ANCHOR_CONFIRMATION_WAIT_MS, 60_000)
        ? { confirmationWaitMs: parsePositiveIntegerEnv(process.env.CLAWZ_SOCIAL_ANCHOR_CONFIRMATION_WAIT_MS, 60_000)! }
        : {})
    });
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
      ...(record.note ? { note: record.note } : {})
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
    if (profile.openClawUrl.trim().length > 0) {
      const normalizedPublicClawUrl = this.validatePublicClawUrl(profile.openClawUrl);
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
        if (normalizedKnownUrl === normalizedPublicClawUrl) {
          const existingAgentId = state.agentIdsBySession[knownSessionId] ?? knownSessionId;
          const ownership = this.ownershipRecordForSession(state, knownSessionId);
          throw new DuplicatePublicClawUrlError(
            ownership.status === "verified"
              ? "That PublicClaw agent URL is already registered and ownership has already been verified."
              : "That PublicClaw agent URL is already registered. Verify control of the existing agent record to reclaim it.",
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
      } else if (
        profile.paymentProfile.pricingMode === "quote-required" ||
        profile.paymentProfile.pricingMode === "agent-negotiated"
      ) {
        if (!profile.paymentProfile.referencePriceUsd?.trim()) {
          throw new Error("Reference price is required when Open for work is on.");
        }
        assertUsdAmount(profile.paymentProfile.referencePriceUsd, "Reference price");
      } else if (profile.paymentProfile.pricingMode === "capped-exact") {
        if (!profile.paymentProfile.maxAmountUsd?.trim()) {
          throw new Error("Max price is required when Open for work is on.");
        }
        assertUsdAmount(profile.paymentProfile.maxAmountUsd, "Max price");
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

  private validatePublicClawUrl(rawUrl: string) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch (error) {
      throw new Error("PublicClaw agent URL must be a valid URL.");
    }

    const isProductionValidation = process.env.NODE_ENV === "production";
    const usesSecureProtocol = parsed.protocol === "https:";
    const isLocalHttp = parsed.protocol === "http:" && isPrivateHostname(parsed.hostname) && !isProductionValidation;

    if (!usesSecureProtocol && !isLocalHttp) {
      throw new Error("PublicClaw agent URL must use https in public deployments.");
    }
    if (isProductionValidation && isPrivateHostname(parsed.hostname)) {
      throw new Error("PublicClaw agent URL must be publicly reachable.");
    }
    if (isPlaceholderHostname(parsed.hostname)) {
      throw new Error("PublicClaw agent URL still looks like placeholder copy.");
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

  private async validatePublicClawAgentHealth(rawUrl: string) {
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
      throw new Error(`PublicClaw agent URL did not respond cleanly (${message}).`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async checkPublicClawAgentReachability(input: {
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
        checkedAtIso,
        reachable: false,
        status: "not-configured",
        reason: "This agent has no PublicClaw URL configured."
      };
    }

    try {
      this.validatePublicClawUrl(openClawUrl);
    } catch (error) {
      return {
        agentId,
        sessionId: input.sessionId,
        openClawUrl,
        checkedAtIso,
        reachable: false,
        status: "offline",
        reason: error instanceof Error ? error.message : "The PublicClaw URL is not valid."
      };
    }

    if (!shouldCheckAgentRuntimeReachability()) {
      return {
        agentId,
        sessionId: input.sessionId,
        openClawUrl,
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
        checkedAtIso,
        reachable,
        status: reachable ? "online" : "offline",
        httpStatus: response.status,
        ...(reachable
          ? { reason: response.ok ? "PublicClaw agent endpoint responded." : `PublicClaw agent endpoint responded with ${response.status}.` }
          : { reason: `PublicClaw agent endpoint returned ${response.status}.` })
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "network request failed";
      return {
        agentId,
        sessionId: input.sessionId,
        openClawUrl,
        checkedAtIso,
        reachable: false,
        status: "offline",
        reason: `PublicClaw agent endpoint could not be reached (${message}).`
      };
    }
  }

  private assertAgentRuntimeReachable(availability: Pick<AgentRuntimeAvailabilityState, "reachable" | "reason">) {
    if (availability.reachable) {
      return;
    }

    throw new Error(
      `This agent appears offline. SantaClawz will not request payment or submit a hire until the PublicClaw endpoint is reachable. ${availability.reason ?? ""}`.trim()
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
    paymentAuthorization: HirePaymentAuthorization;
  }) {
    const ingressUrl = this.hireIngressUrlFor(input.profile.openClawUrl);
    const requestKind: HireIngressRequestKind =
      isQuotedPricingMode(input.profile.paymentProfile.pricingMode) && input.paymentAuthorization.status === "not-required"
        ? "quote"
        : "paid-execution";
    const envelope = {
      schema_version: HIRE_REQUEST_SCHEMA_VERSION,
      request_id: input.requestId,
      agent_id: input.agentId,
      session_id: input.sessionId,
      caller_type: "human",
      service: "agent_job_pack",
      verification_required: true,
      return_channel: "santaclawz",
      request_kind: requestKind,
      paid_or_escrowed: input.paymentAuthorization.status !== "not-required",
      payment: {
        status:
          requestKind === "quote"
            ? "quote-requested"
            : input.paymentAuthorization.status,
        ...(input.paymentAuthorization.rail ? { rail: input.paymentAuthorization.rail } : {}),
        ...(input.paymentAuthorization.amountUsd ? { amount_usd: input.paymentAuthorization.amountUsd } : {}),
        ...(input.paymentAuthorization.authorizationId ? { authorization_id: input.paymentAuthorization.authorizationId } : {}),
        ...(input.paymentAuthorization.settlementReference ? { settlement_reference: input.paymentAuthorization.settlementReference } : {}),
        ...(input.paymentAuthorization.paymentPayloadDigestSha256
          ? { payment_payload_digest_sha256: input.paymentAuthorization.paymentPayloadDigestSha256 }
          : {}),
        ...(input.paymentAuthorization.paymentResponseDigestSha256
          ? { payment_response_digest_sha256: input.paymentAuthorization.paymentResponseDigestSha256 }
          : {})
      },
      input: {
        title: input.taskPrompt.split(/\r?\n/)[0]?.trim().slice(0, 120) || "SantaClawz hire request",
        client_request: input.taskPrompt,
        requester_contact: input.requesterContact,
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
      requestKind,
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
    const trimmedResponseText = input.responseText.trim();
    if (trimmedResponseText.length === 0) {
      return undefined;
    }
    if (Buffer.byteLength(input.responseText, "utf8") > HIRE_INGRESS_RETURN_MAX_BYTES) {
      throw new Error("Public hire ingress returned a protocol response that is too large.");
    }
    if (!trimmedResponseText.startsWith("{")) {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmedResponseText);
    } catch {
      throw new Error("Public hire ingress returned invalid JSON.");
    }
    if (!isRecord(parsed) || parsed.schema_version === undefined) {
      return undefined;
    }
    if (parsed.schema_version !== HIRE_RETURN_SCHEMA_VERSION) {
      throw new Error("Public hire ingress returned an unsupported SantaClawz return schema.");
    }

    const returnedRequestId = assertStringValue(parsed, "request_id", "SantaClawz return package");
    if (returnedRequestId !== input.requestId) {
      throw new Error("Public hire ingress returned a SantaClawz package for the wrong request_id.");
    }
    if (parsed.agent_private !== true) {
      throw new Error("SantaClawz return package must set agent_private=true.");
    }

    const status = assertStringValue(parsed, "status", "SantaClawz return package");
    if (status !== "quoted" && status !== "completed" && status !== "failed") {
      throw new Error("SantaClawz return package has an unsupported status.");
    }
    if (input.requestKind === "quote" && status === "completed") {
      throw new Error("Quote intake cannot return completed paid execution.");
    }
    if (input.requestKind === "paid-execution" && status === "quoted") {
      throw new Error("Paid execution cannot return quote-only status.");
    }

    const digestSha256 = sha256Hex(input.responseText);
    if (status === "quoted") {
      const quote = parsed.quote;
      if (!isRecord(quote)) {
        throw new Error("Quoted SantaClawz return package must include quote.");
      }
      const amountUsd = assertStringValue(quote, "amount_usd", "SantaClawz quote");
      assertUsdAmount(amountUsd, "SantaClawz quote amount_usd");
      if (quote.currency !== "USDC") {
        throw new Error("SantaClawz quote currency must be USDC.");
      }
      const expiresAtIso = assertStringValue(quote, "expires_at_iso", "SantaClawz quote");
      if (Number.isNaN(Date.parse(expiresAtIso))) {
        throw new Error("SantaClawz quote expires_at_iso must be an ISO date-time.");
      }
      const summary = assertStringValue(quote, "summary", "SantaClawz quote");
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
        throw new Error("Completed SantaClawz return package must include verified_output.");
      }
      const packageHash = assertStringValue(verifiedOutput, "package_hash", "SantaClawz verified_output");
      assertSha256Hex(packageHash, "SantaClawz verified_output package_hash");
      if (verifiedOutput.hash_algorithm !== "sha256") {
        throw new Error("SantaClawz verified_output hash_algorithm must be sha256.");
      }
      if (!Array.isArray(verifiedOutput.deliverables)) {
        throw new Error("SantaClawz verified_output deliverables must be an array.");
      }
      for (const [index, deliverable] of verifiedOutput.deliverables.entries()) {
        if (!isRecord(deliverable)) {
          throw new Error(`SantaClawz verified_output deliverable ${index} must be an object.`);
        }
        assertStringValue(deliverable, "name", `SantaClawz verified_output deliverable ${index}`);
        assertSha256Hex(
          assertStringValue(deliverable, "sha256", `SantaClawz verified_output deliverable ${index}`),
          `SantaClawz verified_output deliverable ${index} sha256`
        );
      }
      return {
        schemaVersion: HIRE_RETURN_SCHEMA_VERSION,
        status,
        digestSha256,
        verifiedOutput: {
          packageHash,
          deliverableCount: verifiedOutput.deliverables.length,
          zekoAttestationIncluded: isRecord(verifiedOutput.zeko_attestation)
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
    paymentAuthorization: HirePaymentAuthorization;
  }) {
    const signedRequest = this.buildSignedHireIngressRequest(input);
    if (process.env.CLAWZ_HIRE_FORWARDING_ENABLED === "false") {
      return {
        deliveryStatus: "recorded" as const,
        ingressUrl: signedRequest.ingressUrl,
        bodyDigestSha256: signedRequest.bodyDigestSha256
      };
    }

    const response = await fetch(signedRequest.ingressUrl, {
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
    const protocolReturn = this.parseHireIngressProtocolReturn({
      responseText,
      requestId: input.requestId,
      requestKind: signedRequest.requestKind
    });

    return {
      deliveryStatus: "forwarded" as const,
      ingressUrl: signedRequest.ingressUrl,
      bodyDigestSha256: signedRequest.bodyDigestSha256,
      responseStatusCode: response.status,
      ...(protocolReturn ? { protocolReturn } : {})
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
      challengePath: PUBLICCLAW_OWNERSHIP_CHALLENGE_PATH,
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
      publicClawUrl: profile.openClawUrl
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
        openClawUrl: options.openClawUrl,
        ...(options.payoutWallets ? { payoutWallets: options.payoutWallets } : {}),
        ...(options.missionAuthOverlay ? { missionAuthOverlay: options.missionAuthOverlay } : {}),
        ...(options.paymentProfile ? { paymentProfile: options.paymentProfile } : {}),
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

    return {
      agentName: profile.agentName,
      representedPrincipal: profile.representedPrincipal,
      headline: profile.headline,
      openClawUrl: profile.openClawUrl,
      payoutWallets: profile.payoutWallets,
      missionAuthOverlay: profile.missionAuthOverlay,
      paymentProfile: profile.paymentProfile,
      socialAnchorPolicy: profile.socialAnchorPolicy,
      trustModeId,
      preferredProvingLocation: profile.preferredProvingLocation
    };
  }

  private enrollmentChallengePayloadForTicket(record: EnrollmentTicketRecord, ticket: string) {
    const challengeUrl = ownershipChallengeUrlFor(record.profile.openClawUrl);
    return {
      schema_version: ENROLLMENT_TICKET_SCHEMA_VERSION,
      ticket_id: record.ticketId,
      ticket_digest_sha256: sha256Hex(ticket),
      publicclaw_url: record.profile.openClawUrl,
      challenge_url: challengeUrl
    };
  }

  private async assertEnrollmentTicketChallengeServed(record: EnrollmentTicketRecord, ticket: string) {
    const challengeUrl = ownershipChallengeUrlFor(record.profile.openClawUrl);
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

    const expected = this.enrollmentChallengePayloadForTicket(record, ticket);
    const ticketDigest = assertStringValue(parsed, "ticket_digest_sha256", "Enrollment challenge");
    assertSha256Hex(ticketDigest, "Enrollment challenge ticket_digest_sha256");
    if (
      parsed.schema_version !== ENROLLMENT_TICKET_SCHEMA_VERSION ||
      parsed.ticket_id !== record.ticketId ||
      ticketDigest !== expected.ticket_digest_sha256 ||
      (parsed.publicclaw_url !== undefined && parsed.publicclaw_url !== record.profile.openClawUrl)
    ) {
      throw new Error(
        `The PublicClaw endpoint did not return the expected SantaClawz enrollment ticket challenge at ${PUBLICCLAW_OWNERSHIP_CHALLENGE_PATH}.`
      );
    }
  }

  private assertOwnershipVerifiedForPublish(state: ConsolePersistenceState, sessionId: string) {
    const ownership = this.ownershipRecordForSession(state, sessionId);
    if (ownership.status !== "verified" || !ownership.verification) {
      throw new Error("Verify control of the PublicClaw agent URL before publishing on Zeko.");
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
    const availability =
      input.availability === "archived" || input.availability === "active" ? input.availability : fallback.availability;
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
      openClawUrl: typeof input.openClawUrl === "string" ? input.openClawUrl.trim().slice(0, 280) : fallback.openClawUrl,
      availability,
      ...(archivedAtIso ? { archivedAtIso } : {}),
      payoutWallets: sanitizePayoutWallets(input.payoutWallets, fallback.payoutWallets, legacyPayoutAddress),
      missionAuthOverlay: sanitizeMissionAuthOverlay(input.missionAuthOverlay, fallback.missionAuthOverlay, {
        ...(options.trustVerifiedMissionAuthInput ? { trustVerifiedInput: true } : {})
      }),
      paymentProfile: sanitizePaymentProfile(input.paymentProfile, fallback.paymentProfile),
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

  private async ensureBootstrapped() {
    await this.ensureDirs();
    const existingEvents = await this.loadEvents();
    const state = await this.loadState();
    await this.loadSponsorQueueFile();
    await this.loadHireRequestFile();
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

  async getSocialAnchorQueueState(sessionId?: string): Promise<SocialAnchorQueueState> {
    const queue = await this.loadSocialAnchorQueueFile();
    return this.buildSocialAnchorQueueState(queue, sessionId);
  }

  async getOwnedSocialAnchorQueueState(options: OwnershipActionOptions = {}): Promise<SocialAnchorQueueState> {
    const state = await this.loadState();
    const sessionId = this.resolveOwnedSessionId(state, options);
    this.assertAdminAccess(state, sessionId, options.adminKey);
    return this.getSocialAnchorQueueState(sessionId);
  }

  private buildSocialAnchorQueueState(queue: SocialAnchorQueueFile, sessionId?: string): SocialAnchorQueueState {
    const visibleItems = (sessionId ? queue.items.filter((item) => item.sessionId === sessionId) : queue.items).sort((left, right) =>
      right.occurredAtIso.localeCompare(left.occurredAtIso)
    );
    const visibleBatches = queue.batches
      .filter((batch) => !sessionId || visibleItems.some((item) => item.batchId === batch.batchId))
      .sort((left, right) => right.settledAtIso.localeCompare(left.settledAtIso));

    return {
      pendingCount: visibleItems.filter((item) => item.status === "pending").length,
      anchoredCount: visibleItems.filter((item) => item.status === "anchored").length,
      ...(visibleBatches[0]?.rootDigestSha256 ? { latestRootDigestSha256: visibleBatches[0].rootDigestSha256 } : {}),
      ...(visibleBatches[0]?.settledAtIso ? { lastSettledAtIso: visibleBatches[0].settledAtIso } : {}),
      items: visibleItems.slice(0, 16),
      recentBatches: visibleBatches.slice(0, 6)
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
    const chainResult = options.localOnly
      ? undefined
      : await this.submitSocialAnchorBatchToZeko({
          batchId: batchExport.batchId,
          sessionId,
          rootDigestSha256: batchExport.rootDigestSha256,
          deployment
        });
    const nextBatch: SocialAnchorBatch = {
      batchId: batchExport.batchId,
      sessionId,
      agentId: batchExport.agentId,
      anchorMode: batchExport.anchorMode,
      networkId: chainResult?.networkId ?? deployment.networkId,
      itemCount: batchExport.itemCount,
      candidateKinds: batchExport.candidateKinds,
      rootDigestSha256: batchExport.rootDigestSha256,
      createdAtIso: settledAtIso,
      settledAtIso,
      anchorField: chainResult?.anchorField ?? batchExport.anchorField,
      ...(chainResult?.contractAddress ?? batchExport.contractAddress
        ? { contractAddress: chainResult?.contractAddress ?? batchExport.contractAddress! }
        : {}),
      ...(chainResult?.submitFeeRaw ? { submitFeeRaw: chainResult.submitFeeRaw } : {}),
      ...(chainResult?.submitFee ? { submitFee: chainResult.submitFee } : {}),
      ...(chainResult?.submitFeeSource ? { submitFeeSource: chainResult.submitFeeSource } : {}),
      ...(typeof chainResult?.attemptCount === "number" ? { submitAttemptCount: chainResult.attemptCount } : {}),
      ...(chainResult?.txHash
        ? { txHash: chainResult.txHash }
        : typeof options.txHash === "string" && options.txHash.trim().length > 0
          ? { txHash: options.txHash.trim().slice(0, 140) }
          : {}),
      ...(typeof options.operatorNote === "string" && options.operatorNote.trim().length > 0
        ? { operatorNote: options.operatorNote.trim().slice(0, 280) }
        : {})
    };

    await this.saveSocialAnchorQueueFile({
      items: queue.items.map((item) =>
        batchExport.items.some((pending) => pending.candidateId === item.candidateId)
          ? {
              ...item,
              status: "anchored",
              batchId: batchExport.batchId,
              anchoredAtIso: settledAtIso
            }
          : item
      ),
      batches: [nextBatch, ...queue.batches].slice(0, 80)
    });

    await this.appendEvent(
      "SessionCheckpointed",
      {
        sessionId,
        socialAnchorBatchSettled: true,
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
        if (!this.canAutoAnchorSharedBatches(deployment)) {
          return;
        }
        const pendingSessionIds = [...new Set(
          queue.items
            .filter((item) => item.status === "pending")
            .map((item) => item.sessionId)
            .filter((sessionId) => {
              const profile = this.profileForSession(state, sessionId);
              return effectiveSocialAnchorMode(profile.socialAnchorPolicy.mode, deployment) === "shared-batched";
            })
        )];

        for (const sessionId of pendingSessionIds) {
          try {
            await this.settleSocialAnchorBatchForSession(sessionId, {
              operatorNote: "Shared 10s batch"
            });
          } catch (error) {
            console.warn(
              `[clawz] shared social anchor settlement skipped for ${sessionId}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
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
        await this.settleSocialAnchorBatchForSession(sessionId, {
          operatorNote: "Priority anchoring lane"
        });
      } catch (error) {
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
  }): Promise<void> {
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

    if (queue.items.some((item) => item.kind === input.kind && item.payloadDigestSha256 === payloadDigestSha256)) {
      return;
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
      items: [nextItem, ...queue.items].slice(0, 500)
    });

    if (anchorMode === "priority-self-funded") {
      queueMicrotask(() => {
        void this.runPrioritySocialAnchorBatchForSession(input.sessionId);
      });
    }
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
    const [manifests, deployment, liveFlow, sponsorQueueFile, socialAnchorQueueFile] = await Promise.all([
      this.blobStore.listManifests(state.currentSessionId),
      this.getDeploymentState(),
      this.getLiveFlowState(),
      this.loadSponsorQueueFile(),
      this.loadSocialAnchorQueueFile()
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
    const published = liveFlowTargets.turns.some((target) => target.sessionId === focus.sessionId);
    const paymentsEnabled = profile.paymentProfile.enabled;
    const paymentProfileReady = hasReadyPaymentProfile(profile);
    const payoutAddressConfigured = hasPayoutAddress(profile);
    const paidJobsEnabled = computePaidJobsEnabled(profile, published, deployment);
    const ownership = this.ownershipForSession(state, focus.sessionId);
    const protocolOwnerFeePolicy = buildProtocolOwnerFeePolicyFromEnv();
    const adminAccess = this.buildAdminAccessState(
      state,
      focus.sessionId,
      options.adminKey,
      options.exposeIssuedAdminKey
    );
    const ingressAccess = this.buildIngressAccessState(
      state,
      focus.sessionId,
      options.exposeIssuedIngressToken,
      options.exposeIssuedSigningSecret
    );

    return {
      agentId,
      paymentsEnabled,
      paymentProfileReady,
      payoutAddressConfigured,
      paidJobsEnabled,
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
      profile,
      ownership
    };
  }

  async getAgentRuntimeAvailability(options: AgentRuntimeAvailabilityOptions): Promise<AgentRuntimeAvailabilityState> {
    const state = await this.loadState();
    const sessionId = this.resolveOwnedSessionId(state, options);
    const events = await this.loadEvents();
    const trustModeId = this.resolveSessionTrustMode(events, sessionId, state.activeMode);
    const profile = this.profileForSession(state, sessionId, trustModeId);
    const [heartbeatFile, reachability] = await Promise.all([
      this.loadRuntimeHeartbeatFile(),
      this.checkPublicClawAgentReachability({
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
    const runtimeStatus: AgentRuntimeStatus = reachability.reachable ? heartbeat.status : "offline";
    return {
      ...reachability,
      runtimeStatus,
      heartbeat
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
    const nextRecord: AgentRuntimeHeartbeatRecord = {
      agentId,
      sessionId,
      status,
      receivedAtIso,
      ttlSeconds,
      ...(note ? { note } : {})
    };
    const file = await this.loadRuntimeHeartbeatFile();
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

  async listRegisteredAgents(): Promise<AgentRegistryEntry[]> {
    const state = await this.loadState();
    const events = await this.loadEvents();
    const [liveFlow, deployment, socialAnchorQueueFile, runtimeHeartbeatFile] = await Promise.all([
      this.getLiveFlowState(),
      this.getDeploymentState(),
      this.loadSocialAnchorQueueFile(),
      this.loadRuntimeHeartbeatFile()
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
        const published = liveFlowTargets.turns.some((target) => target.sessionId === sessionId);
        const lastUpdatedAtIso = session.events.at(-1)?.occurredAtIso;
        const ownership = this.ownershipForSession(state, sessionId);
        const sessionAnchors = socialAnchorQueueFile.items.filter((item) => item.sessionId === sessionId);
        const anchoredBatches = socialAnchorQueueFile.batches
          .filter((batch) => sessionAnchors.some((item) => item.batchId === batch.batchId))
          .sort((left, right) => right.settledAtIso.localeCompare(left.settledAtIso));
        const heartbeatRecord = runtimeHeartbeatFile.heartbeats.find((record) => record.sessionId === sessionId);
        const runtimeHeartbeat = this.buildAgentRuntimeHeartbeatState({
          state,
          sessionId,
          trustModeId,
          ...(heartbeatRecord ? { record: heartbeatRecord } : {})
        });
        return {
          agentId: this.agentIdForSession(state, sessionId, trustModeId),
          sessionId,
          networkId: deployment.networkId,
          agentName: profile.agentName,
          representedPrincipal: profile.representedPrincipal,
          headline: profile.headline,
          openClawUrl: profile.openClawUrl,
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
          ...(profile.paymentProfile.referencePriceUsd
            ? { referencePriceUsd: profile.paymentProfile.referencePriceUsd }
            : {}),
          ...(profile.paymentProfile.referencePriceUnit
            ? { referencePriceUnit: profile.paymentProfile.referencePriceUnit }
            : {}),
          settlementTrigger: profile.paymentProfile.settlementTrigger,
          payoutAddressConfigured: hasPayoutAddress(profile),
          paymentProfileReady: hasReadyPaymentProfile(profile),
          paidJobsEnabled: computePaidJobsEnabled(profile, published, deployment),
          missionAuthVerified: profile.missionAuthOverlay.status === "verified",
          ownershipVerified: ownership.status === "verified",
          availability: profile.availability,
          ...(profile.archivedAtIso ? { archivedAtIso: profile.archivedAtIso } : {}),
          runtimeStatus: runtimeHeartbeat.status,
          runtimeStatusUpdatedAtIso: runtimeHeartbeat.checkedAtIso,
          ...(runtimeHeartbeat.lastHeartbeatAtIso ? { lastHeartbeatAtIso: runtimeHeartbeat.lastHeartbeatAtIso } : {}),
          ...(runtimeHeartbeat.reason ? { runtimeStatusReason: runtimeHeartbeat.reason } : {}),
          published,
          pendingSocialAnchorCount: sessionAnchors.filter((item) => item.status === "pending").length,
          anchoredSocialFactCount: sessionAnchors.filter((item) => item.status === "anchored").length,
          ...(anchoredBatches[0]?.settledAtIso ? { lastSocialAnchorAtIso: anchoredBatches[0].settledAtIso } : {}),
          ...(lastUpdatedAtIso ? { lastUpdatedAtIso } : {})
        } satisfies AgentRegistryEntry;
      })
      .filter(
        (entry) =>
          entry.availability !== "archived" &&
          entry.openClawUrl.trim().length > 0 &&
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
    const profile = this.buildEnrollmentTicketProfile(options, deployment);
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
      challengePath: PUBLICCLAW_OWNERSHIP_CHALLENGE_PATH,
      challengeUrl: ownershipChallengeUrlFor(profile.openClawUrl),
      enrollmentChallenge: {
        schemaVersion: ENROLLMENT_TICKET_SCHEMA_VERSION,
        ticketId,
        ticketDigestSha256: ticketHash,
        challengeUrl: ownershipChallengeUrlFor(profile.openClawUrl),
        publicClawUrl: profile.openClawUrl
      }
    };
  }

  async redeemEnrollmentTicket(ticket: string): Promise<EnrollmentTicketRedeemResult> {
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

    await this.assertEnrollmentTicketChallengeServed(record, parsedTicket.ticket);

    const registeredState = await this.registerAgent(record.profile);
    const sessionId = registeredState.session.sessionId;
    const agentId = registeredState.agentId;
    const issuedAdminKey = registeredState.adminAccess.issuedAdminKey;
    const ingressAccess = registeredState.ingressAccess;
    if (!issuedAdminKey || !ingressAccess) {
      throw new Error("Enrollment registered the agent but did not receive required admin or ingress secrets.");
    }

    const challengeResult = await this.issueOwnershipChallenge({
      sessionId,
      agentId,
      adminKey: issuedAdminKey
    });
    const redeemedAtIso = new Date().toISOString();
    const latestState = await this.loadState();
    await this.saveState({
      ...latestState,
      enrollmentTicketsById: {
        ...latestState.enrollmentTicketsById,
        [record.ticketId]: {
          ...record,
          status: "redeemed",
          redeemedAtIso,
          redeemedSessionId: sessionId,
          redeemedAgentId: agentId
        }
      }
    });

    return {
      ...challengeResult.state,
      adminAccess: registeredState.adminAccess,
      ingressAccess,
      issuedOwnershipChallenge: challengeResult.issuedOwnershipChallenge
    };
  }

  async registerAgent(options: RegisterAgentOptions): Promise<ConsoleStateResponse> {
    const state = await this.loadState();
    const deployment = await this.getDeploymentState();
    const registeredAtIso = new Date().toISOString();
    const trustModeId = options.trustModeId ?? "private";
    const sessionSlug = randomUUID().replace(/-/g, "").slice(0, 12);
    const sessionId = `session_agent_${sessionSlug}`;
    const fallbackProfile = buildDefaultProfile(trustModeId);
    const profile = this.coerceProfileForDeployment(this.sanitizeProfileInput(
      trustModeId,
      {
        agentName: options.agentName,
        headline: options.headline,
        openClawUrl: options.openClawUrl,
        ...(options.payoutWallets ? { payoutWallets: options.payoutWallets } : {}),
        ...(options.missionAuthOverlay ? { missionAuthOverlay: options.missionAuthOverlay } : {}),
        ...(options.paymentProfile ? { paymentProfile: options.paymentProfile } : {}),
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
    await this.validatePublicClawAgentHealth(profile.openClawUrl);

    const agentId = buildStableAgentId(profile.agentName, sessionId);
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
        openClawUrl: profile.openClawUrl
      }
    });
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
    if (!profile.openClawUrl.trim()) {
      throw new Error("This agent still needs a PublicClaw agent URL before ownership can be verified.");
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
    if (!profile.openClawUrl.trim()) {
      throw new Error("This agent still needs a PublicClaw agent URL before ownership can be verified.");
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
        `The PublicClaw endpoint did not return the expected SantaClawz challenge at ${challenge.challengePath}.`
      );
    }

    const verifiedAtIso = new Date().toISOString();
    const challengeResponseDigestSha256 = canonicalDigest(challengeResult.parsed).sha256Hex;
    const verificationMethod = challenge.verificationMethod;
    const attestationDigestSha256 = canonicalDigest({
      sessionId,
      agentId: this.agentIdForSession(state, sessionId),
      publicClawUrl: profile.openClawUrl,
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
      verifiedPublicClawUrl: profile.openClawUrl,
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
      summary: `${profile.agentName} proved control of its PublicClaw endpoint.`,
      occurredAtIso: verifiedAtIso,
      payload: {
        agentId: this.agentIdForSession(state, sessionId),
        challengeId: challenge.challengeId,
        attestationDigestSha256,
        verifiedPublicClawUrl: profile.openClawUrl
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

  async submitHireRequest(options: SubmitHireRequestOptions): Promise<HireRequestReceipt> {
    const state = await this.loadState();
    const sessionId = this.resolveSessionIdFromAgentId(state, options.agentId);
    if (!sessionId) {
      throw new Error(`Unknown agent: ${options.agentId}`);
    }

    const [events, liveFlow, deployment, hireRequests] = await Promise.all([
      this.loadEvents(),
      this.getLiveFlowState(),
      this.getDeploymentState(),
      this.loadHireRequestFile()
    ]);
    const liveFlowTargets = this.buildLiveFlowTargets(events, liveFlow);
    const trustModeId = this.resolveSessionTrustMode(events, sessionId, state.activeMode);
    const profile = this.profileForSession(state, sessionId, trustModeId);
    if (isArchivedProfile(profile)) {
      throw new Error("This agent is archived on SantaClawz and is not accepting new hire requests.");
    }
    const ownership = this.ownershipForSession(state, sessionId);
    if (ownership.status !== "verified") {
      throw new Error("This agent must verify control of its PublicClaw endpoint before it can accept public hire requests.");
    }
    const published = liveFlowTargets.turns.some((target) => target.sessionId === sessionId);
    if (!published) {
      throw new Error("This agent needs to publish on Zeko before it can accept hire requests.");
    }
    if (!profile.openClawUrl.trim()) {
      throw new Error("This agent has no PublicClaw callback URL configured yet.");
    }
    const taskPrompt = options.taskPrompt.trim();
    const requesterContact = options.requesterContact.trim();
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
      await this.checkPublicClawAgentReachability({
        state,
        sessionId,
        profile,
        trustModeId
      })
    );
    const paidJobsEnabled = computePaidJobsEnabled(profile, published, deployment);
    const paymentAuthorization = options.paymentAuthorization ?? { status: "not-required" as const };
    if (!profile.paymentProfile.enabled) {
      throw new Error("This agent is not open for work yet.");
    }
    const quoteRequestMode = profile.paymentProfile.enabled && isQuotedPricingMode(profile.paymentProfile.pricingMode);
    if (profile.paymentProfile.enabled && !paidJobsEnabled && !quoteRequestMode) {
      throw new Error("This agent has payments turned on, but paid jobs are not live yet.");
    }
    if (quoteRequestMode && !hasReadyPaymentProfile(profile)) {
      throw new Error("This agent is open for work, but its quote setup still needs a payout wallet, processor, and reference price.");
    }
    if (paidJobsEnabled && paymentAuthorization.status === "not-required") {
      throw new Error("Paid agents require verified x402 payment before SantaClawz submits a hire request.");
    }

    const submittedAtIso = new Date().toISOString();
    const requestId = `hire_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
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
      ...(typeof options.budgetMina === "string" && options.budgetMina.trim().length > 0
        ? { budgetMina: options.budgetMina.trim().slice(0, 40) }
        : {}),
      paymentAuthorization
    });
    const ingressProtocolReturn = "protocolReturn" in ingressDelivery ? ingressDelivery.protocolReturn : undefined;
    const ingressResponseStatusCode =
      "responseStatusCode" in ingressDelivery ? ingressDelivery.responseStatusCode : undefined;
    const hireStatus: HireRequestReceipt["status"] = ingressProtocolReturn?.status ?? "submitted";
    const nextRecord: HireRequestRecord = {
      requestId,
      agentId: options.agentId,
      sessionId,
      networkId: deployment.networkId,
      submittedAtIso,
      status: hireStatus,
      taskPrompt,
      ...(typeof options.budgetMina === "string" && options.budgetMina.trim().length > 0
        ? { budgetMina: options.budgetMina.trim().slice(0, 40) }
        : {}),
      requesterContact,
      deliveryTarget: ingressDelivery.ingressUrl,
      deliveryStatus: ingressDelivery.deliveryStatus,
      ingressBodyDigestSha256: ingressDelivery.bodyDigestSha256,
      ...(typeof ingressResponseStatusCode === "number" ? { ingressResponseStatusCode } : {}),
      ...(ingressProtocolReturn ? { protocolReturn: ingressProtocolReturn } : {}),
      payment: paymentAuthorization
    };

    await this.saveHireRequestFile({
      requests: [nextRecord, ...hireRequests.requests].slice(0, 200)
    });
    await this.enqueueSocialAnchorCandidate({
      sessionId,
      kind: "hire-request-submitted",
      summary: `${profile.agentName} received a new hire request through SantaClawz.`,
      occurredAtIso: submittedAtIso,
      payload: {
        requestId,
        agentId: options.agentId,
        requesterContactDigestSha256: sha256Hex(nextRecord.requesterContact),
        status: hireStatus
      }
    });
    if (ingressProtocolReturn) {
      const returnKind: SocialAnchorCandidateKind =
        ingressProtocolReturn.status === "quoted"
          ? "quote-returned"
          : ingressProtocolReturn.status === "completed"
            ? "paid-execution-completed"
            : "hire-request-failed";
      const returnSummary =
        ingressProtocolReturn.status === "quoted"
          ? `${profile.agentName} returned an exact quote for a SantaClawz hire request.`
          : ingressProtocolReturn.status === "completed"
            ? `${profile.agentName} returned a verified output package for paid execution.`
            : `${profile.agentName} returned a failed hire result through SantaClawz.`;
      await this.enqueueSocialAnchorCandidate({
        sessionId,
        kind: returnKind,
        summary: returnSummary,
        occurredAtIso: submittedAtIso,
        payload: {
          requestId,
          agentId: options.agentId,
          protocolReturnDigestSha256: ingressProtocolReturn.digestSha256,
          status: ingressProtocolReturn.status,
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
                zekoAttestationIncluded: ingressProtocolReturn.verifiedOutput.zekoAttestationIncluded
              }
            : {}),
          ...(ingressProtocolReturn.incidentId ? { incidentId: ingressProtocolReturn.incidentId } : {})
        }
      });
    }

    return {
      requestId,
      agentId: options.agentId,
      sessionId,
      networkId: deployment.networkId,
      submittedAtIso,
      status: hireStatus,
      deliveryTarget: ingressDelivery.ingressUrl,
      deliveryStatus: ingressDelivery.deliveryStatus,
      ingress: {
        url: ingressDelivery.ingressUrl,
        requestId,
        timestamp: submittedAtIso,
        bodyDigestSha256: ingressDelivery.bodyDigestSha256,
        ...(typeof ingressResponseStatusCode === "number" ? { responseStatusCode: ingressResponseStatusCode } : {}),
        signatureHeader: "X-SantaClawz-Signature"
      },
      ...(ingressProtocolReturn ? { protocolReturn: ingressProtocolReturn } : {}),
      payment: {
        status: paymentAuthorization.status,
        ...(paymentAuthorization.rail ? { rail: paymentAuthorization.rail } : {}),
        ...(paymentAuthorization.amountUsd ? { amountUsd: paymentAuthorization.amountUsd } : {}),
        ...(paymentAuthorization.authorizationId ? { authorizationId: paymentAuthorization.authorizationId } : {}),
        ...(paymentAuthorization.settlementReference ? { settlementReference: paymentAuthorization.settlementReference } : {})
      },
      paidJobsEnabled
    };
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
    const wasPublished = liveFlowTargets.turns.some((target) => target.sessionId === focus.sessionId);
    const wasPaymentReady = computePaidJobsEnabled(currentProfile, wasPublished, deployment);
    const nextProfile = this.coerceProfileForDeployment(this.sanitizeProfileInput(trustModeId, input, {
      ...fallbackProfile,
      ...currentProfile
    }), deployment);
    await this.assertAgentProfileIsValid(state, nextProfile, focus.sessionId);
    if (nextProfile.openClawUrl !== currentProfile.openClawUrl) {
      await this.validatePublicClawAgentHealth(nextProfile.openClawUrl);
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
