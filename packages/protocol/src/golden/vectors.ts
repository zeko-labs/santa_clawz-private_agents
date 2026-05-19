import { buildLeaf } from "../leaves/builders.js";
import { canonicalDigest } from "../hashing/digest.js";
import { buildOriginProofRoot } from "../interop/agent-proof.js";
import type {
  ApprovalLeaf,
  CapabilityLeaf,
  DisclosureLeaf,
  OriginProofLeaf,
  SessionHeaderLeaf,
  TurnHeaderLeaf
} from "../leaves/types.js";
import type { ZkTlsOriginProof } from "../interop/agent-proof.js";
import { assertCapabilityManifest, type CapabilityManifest } from "../manifests/capability-manifest.js";
import type { PrivacyException, PrivacyMode } from "../privacy/types.js";
import type { ToolReceipt, OutputCommitment } from "../receipts/tool-receipt.js";
import type { RetentionPolicy } from "../retention/types.js";

export const samplePrivacyMode: PrivacyMode = {
  modeId: "mode_team_sealed",
  preset: "team-sealed",
  operatorVisible: false,
  providerVisible: false,
  externalHostsAllowed: false,
  maxSpendMina: "0.25",
  proofLevel: "rooted",
  defaultArtifactVisibility: "team-sealed",
  defaultProvingLocation: "client",
  supportedProvingLocations: ["client", "server", "sovereign-rollup"]
};

export const sampleRetentionPolicy: RetentionPolicy = {
  policyId: "retention_zero_72h",
  profile: "zero-retention",
  transcriptTtlHours: 72,
  artifactTtlHours: 24,
  legalHold: false,
  deleteWrappedKeysOnExpiry: true,
  exportBeforeDelete: false
};

export const sampleCapabilityManifest: CapabilityManifest = assertCapabilityManifest({
  capabilityId: "cap_browser_research",
  pluginId: "plugin_research_suite",
  name: "Sealed Browser Research",
  version: "0.1.0",
  description: "Researches one host under operator-blind constraints.",
  owner: "B62qowner000000000000000000000000000000000000000000000000000",
  ioSchemaHash: "io_schema_hash_v1",
  trustClass: "audited",
  approvalClass: "browser-automation",
  spendModel: "per-minute",
  artifactClasses: ["screenshot", "summary", "receipt"],
  reproducibleBuildHash: "build_hash_v1",
  inputVisibilityClass: "redacted-content",
  outputVisibilityClass: "digest-only",
  retentionClass: "zero-retention",
  providerClass: "zktls-attested-remote",
  disclosureClass: "team",
  requiresRawContent: false,
  supportsRedactedMode: true,
  supportsDigestMode: true
});

export const sampleCapabilityLeaf: CapabilityLeaf = {
  capabilityId: sampleCapabilityManifest.capabilityId,
  pluginId: sampleCapabilityManifest.pluginId,
  manifestHash: "manifest_hash_v1",
  ioSchemaHash: sampleCapabilityManifest.ioSchemaHash,
  policyClassHash: "policy_class_hash_v1",
  priceModelHash: "price_model_hash_v1",
  stakeAmount: "2500000000",
  status: "active"
};

export const sampleSessionHeaderLeaf: SessionHeaderLeaf = {
  sessionId: "session_demo_enterprise",
  tenantId: "tenant_acme",
  agentId: "agent_privacy_orchestrator",
  routingPolicyHash: "routing_policy_hash_v1",
  keyRefHash: "key_ref_workspace_blue",
  createdAtSlot: "128",
  channelBindingHash: "channel_binding_hash_v1"
};

export const sampleTurnHeaderLeaf: TurnHeaderLeaf = {
  turnId: "turn_0001",
  sessionId: sampleSessionHeaderLeaf.sessionId,
  leaseId: "lease_worker_alpha",
  workerId: "worker_alpha",
  inputMessageRoot: "input_message_root_hash",
  budgetReservationHash: "budget_reservation_hash",
  approvalBundleHash: "approval_bundle_hash",
  startedAtSlot: "129"
};

export const sampleApprovalLeaf: ApprovalLeaf = {
  approvalId: "approval_privacy_exception_1",
  turnId: sampleTurnHeaderLeaf.turnId,
  requesterKey: "B62qrequester0000000000000000000000000000000000000000000000",
  workerId: "worker_alpha",
  policyHash: "policy_hash_browser_sealed",
  dangerClass: "privacy-exception",
  scopeHash: "scope_hash_operator_disclosure",
  privacyExceptionHash: "privacy_exception_hash_1",
  expiresAtSlot: "132"
};

export const sampleDisclosureLeaf: DisclosureLeaf = {
  disclosureId: "disclosure_001",
  sessionId: sampleSessionHeaderLeaf.sessionId,
  requestorKey: sampleApprovalLeaf.requesterKey,
  artifactRef: "artifact_manifest_hash_1",
  scopeHash: "scope_hash_single_artifact",
  legalBasisHash: "legal_basis_incident_review",
  expiresAtSlot: "145",
  audienceHash: "audience_hash_compliance"
};

export const sampleOriginProof: ZkTlsOriginProof = {
  originProofId: "origin_proof_001",
  sessionId: sampleSessionHeaderLeaf.sessionId,
  turnId: sampleTurnHeaderLeaf.turnId,
  stepId: "step_browser_lookup",
  host: "docs.openclaw.ai",
  method: "GET",
  requestTemplateHash: "request_template_hash_v1",
  requestHeaderAllowlistHash: "request_header_allowlist_hash_v1",
  responseStatus: 200,
  responseHeaderDigest: "response_header_digest_v1",
  responseBodyDigest: "response_body_digest_v1",
  extractedFactDigest: "extracted_fact_digest_v1",
  selectiveRevealDigest: "selective_reveal_digest_v1",
  verifierKeyHash: "verifier_key_hash_v1",
  verifierSystem: "tlsn-notary-compatible",
  attestedAtIso: "2026-04-19T08:00:10.000Z",
  expiresAtIso: "2026-04-19T14:00:10.000Z",
  disclosureClass: "team",
  rawTranscriptManifestId: "sealed_transcript_manifest_001"
};

export const sampleOriginProofLeaf: OriginProofLeaf = {
  originProofId: sampleOriginProof.originProofId,
  sessionId: sampleOriginProof.sessionId,
  turnId: sampleOriginProof.turnId,
  stepId: sampleOriginProof.stepId,
  hostHash: "host_hash_docs_openclaw_ai",
  requestTemplateHash: sampleOriginProof.requestTemplateHash,
  responseBodyDigest: sampleOriginProof.responseBodyDigest,
  extractedFactDigest: sampleOriginProof.extractedFactDigest,
  verifierKeyHash: sampleOriginProof.verifierKeyHash,
  attestedAtSlot: "129",
  expiresAtSlot: "141"
};

export const samplePrivacyException: PrivacyException = {
  exceptionId: "privacy_exception_001",
  sessionId: sampleSessionHeaderLeaf.sessionId,
  turnId: sampleTurnHeaderLeaf.turnId,
  requestorKey: sampleApprovalLeaf.requesterKey,
  audience: "compliance-reviewer",
  reason: "Investigate an incident without expanding visibility for the full session.",
  scopeSummary: "Reveal one operator-blind artifact for 24 hours.",
  expiresAtIso: "2026-04-20T12:00:00.000Z"
};

export const sampleToolReceipt: ToolReceipt = {
  turnId: sampleTurnHeaderLeaf.turnId,
  stepId: "step_browser_lookup",
  capabilityId: sampleCapabilityManifest.capabilityId,
  pluginManifestHash: "plugin_manifest_hash_v1",
  policyHash: sampleApprovalLeaf.policyHash,
  approvalRef: sampleApprovalLeaf.approvalId,
  inputDigest: "input_digest_hash_v1",
  outputDigest: "output_digest_hash_v1",
  statusCode: 200,
  startedAtIso: "2026-04-19T08:00:00.000Z",
  endedAtIso: "2026-04-19T08:00:12.000Z",
  privacyModeHash: "privacy_mode_hash_v1",
  retentionPolicyHash: "retention_policy_hash_v1",
  providerRoutingHash: "provider_routing_hash_local",
  originProofRef: sampleOriginProof.originProofId,
  originProofDigest: canonicalDigest(sampleOriginProof).sha256Hex,
  originVerifierKeyHash: sampleOriginProof.verifierKeyHash
};

export const sampleOutputCommitment: OutputCommitment = {
  turnId: sampleTurnHeaderLeaf.turnId,
  assistantMessageHash: "assistant_message_hash_v1",
  artifactRoot: "artifact_root_hash_v1",
  originProofRoot: buildOriginProofRoot([sampleOriginProof]).sha256Hex,
  citationRoot: "citation_root_hash_v1",
  moderationRoot: "moderation_root_hash_v1",
  encryptionKeyRefHash: "artifact_key_ref_hash_v1",
  visibilityClassHash: "visibility_hash_operator_blind",
  retentionClassHash: "retention_hash_zero_retention",
  completedAtIso: "2026-04-19T08:00:15.000Z"
};

export const GOLDEN_VECTORS = {
  capabilityManifest: buildLeaf(sampleCapabilityManifest),
  capabilityLeaf: buildLeaf(sampleCapabilityLeaf),
  sessionHeaderLeaf: buildLeaf(sampleSessionHeaderLeaf),
  turnHeaderLeaf: buildLeaf(sampleTurnHeaderLeaf),
  approvalLeaf: buildLeaf(sampleApprovalLeaf),
  disclosureLeaf: buildLeaf(sampleDisclosureLeaf),
  originProof: buildLeaf(sampleOriginProof),
  originProofLeaf: buildLeaf(sampleOriginProofLeaf),
  toolReceipt: buildLeaf(sampleToolReceipt),
  outputCommitment: buildLeaf(sampleOutputCommitment),
  privacyMode: buildLeaf(samplePrivacyMode),
  retentionPolicy: buildLeaf(sampleRetentionPolicy),
  privacyException: buildLeaf(samplePrivacyException)
};
