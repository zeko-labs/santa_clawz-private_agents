import { canonicalDigest, type CanonicalDigest } from "../hashing/digest.js";
import type { CapabilityManifest } from "../manifests/capability-manifest.js";
import type { ArtifactVisibility, PrivacyPreset, ProgrammablePrivacyPolicy } from "../privacy/types.js";
import type { ToolReceipt } from "../receipts/tool-receipt.js";
import type { RetentionPolicy } from "../retention/types.js";
import type {
  AgentMissionAuthOverlayStatus,
  AgentMissionAuthProviderHint,
  AgentSocialAnchorMode,
  AgentPaymentRail,
  AgentPricingMode,
  AgentSettlementTrigger,
  GovernancePolicy,
  ProtocolOwnerFeeSettlementModel,
  SocialAnchorCandidateKind,
  TrustModeId,
  ZekoDeploymentMode
} from "../runtime/console-state.js";
import type { StableJsonValue } from "../serialization/stable-json.js";

export interface InteropEvidenceObject {
  kind:
    | "capability-manifest"
    | "console-state"
    | "deployment"
    | "session"
    | "event"
    | "privacy-exception"
    | "artifact"
    | "receipt"
    | "origin-proof"
    | "mission-auth-overlay";
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

export interface AgentOwnershipClaim {
  openClawUrl: string;
  ownershipStatus: "unverified" | "challenge-issued" | "verified" | "legacy-unverified";
  legacyRegistration: boolean;
  canReclaim: boolean;
  challengePath: string;
  verificationMethod?: "well-known-http";
  challengeId?: string;
  challengeUrl?: string;
  verifiedAtIso?: string;
  challengeResponseDigestSha256?: string;
  attestationDigestSha256?: string;
  reclaimedAtIso?: string;
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
  x402?: {
    enabled: boolean;
    supportedRails: AgentPaymentRail[];
    defaultRail?: AgentPaymentRail;
    pricingMode: AgentPricingMode;
    settlementTrigger: AgentSettlementTrigger;
    fixedAmountUsd?: string;
    maxAmountUsd?: string;
    quoteUrl?: string;
    protocolOwnerFeeBps?: number;
    protocolFeeRecipientByRail?: Partial<Record<AgentPaymentRail, string>>;
    feeSettlementMode?: ProtocolOwnerFeeSettlementModel;
    feePreviewByRail?: Array<{
      rail: AgentPaymentRail;
      grossAmountUsd?: string;
      sellerNetAmountUsd?: string;
      protocolFeeAmountUsd?: string;
      nominalProtocolFeeAmountUsd?: string;
      networkFacilitationFeeAmountUsd?: string;
      feeBasis?: "protocol-bps" | "network-facilitation-minimum";
    }>;
    facilitatorUrlByRail?: Partial<Record<AgentPaymentRail, string>>;
    paymentNotes?: string;
    payTo?: Partial<Record<AgentPaymentRail, string>>;
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

export interface AgentSocialClaim {
  anchorMode: AgentSocialAnchorMode;
  pendingCandidateCount: number;
  anchoredFactCount: number;
  candidateKinds: SocialAnchorCandidateKind[];
  latestRootDigestSha256?: string;
  lastSettledAtIso?: string;
  recentBatches: Array<{
    batchId: string;
    anchorMode: AgentSocialAnchorMode;
    rootDigestSha256: string;
    settledAtIso: string;
    anchorField?: string;
    contractAddress?: string;
    txHash?: string;
    submitFeeRaw?: string;
    submitFee?: string;
    submitFeeSource?: string;
    submitAttemptCount?: number;
  }>;
  claimDigest: CanonicalDigest;
}

export interface AgentMissionAuthClaim {
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
  ownership: AgentOwnershipClaim;
  authority: AgentAuthorityClaim;
  payment: AgentPaymentClaim;
  privacy: AgentPrivacyClaim;
  social: AgentSocialClaim;
  missionAuth?: AgentMissionAuthClaim;
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
  proofClaims: Array<"representation" | "ownership" | "authority" | "payment" | "privacy" | "origin">;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isClawzJsonRpcRequest(value: unknown): value is ClawzJsonRpcRequest {
  if (!isRecord(value)) {
    return false;
  }

  const id = value.id;
  const method = value.method;
  return (
    value.jsonrpc === "2.0" &&
    (typeof id === "string" || typeof id === "number" || id === null) &&
    (method === "tools/list" || method === "tools/call")
  );
}

export function assertClawzJsonRpcRequest(value: unknown): ClawzJsonRpcRequest {
  if (!isClawzJsonRpcRequest(value)) {
    throw new Error("Invalid ClawZ JSON-RPC request.");
  }

  return value;
}

export function buildOriginProofCommitment(proof: ZkTlsOriginProof): StableJsonValue {
  return JSON.parse(
    canonicalDigest({
      originProofId: proof.originProofId,
      sessionId: proof.sessionId,
      turnId: proof.turnId,
      stepId: proof.stepId,
      host: proof.host,
      method: proof.method,
      requestTemplateHash: proof.requestTemplateHash,
      requestHeaderAllowlistHash: proof.requestHeaderAllowlistHash,
      responseStatus: proof.responseStatus,
      responseHeaderDigest: proof.responseHeaderDigest,
      responseBodyDigest: proof.responseBodyDigest,
      extractedFactDigest: proof.extractedFactDigest,
      selectiveRevealDigest: proof.selectiveRevealDigest ?? null,
      verifierKeyHash: proof.verifierKeyHash,
      verifierSystem: proof.verifierSystem,
      attestedAtIso: proof.attestedAtIso,
      expiresAtIso: proof.expiresAtIso,
      disclosureClass: proof.disclosureClass
    }).stableJson
  ) as StableJsonValue;
}

export function buildOriginProofRoot(originProofs: ZkTlsOriginProof[]): CanonicalDigest {
  return canonicalDigest(originProofs.map((proof) => buildOriginProofCommitment(proof)));
}
