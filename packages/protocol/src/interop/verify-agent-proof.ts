import { canonicalDigest } from "../hashing/digest.js";

import type {
  AgentAuthorityClaim,
  AgentMissionAuthClaim,
  AgentOwnershipClaim,
  AgentPaymentClaim,
  AgentPrivacyClaim,
  AgentRepresentationClaim,
  ClawzAgentDiscoveryDocument,
  ClawzAgentProofBundle,
  InteropEvidenceObject,
  ZkTlsOriginProof
} from "./agent-proof.js";

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
  ownership: {
    publicClawzUrl: string;
    ownershipStatus: AgentOwnershipClaim["ownershipStatus"];
    legacyRegistration: boolean;
    canReclaim: boolean;
    challengePath: string;
    verificationMethod?: AgentOwnershipClaim["verificationMethod"];
    challengeId?: string;
    verifiedAtIso?: string;
    reclaimedAtIso?: string;
    verified: boolean;
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
    x402Enabled: boolean;
    supportedRails?: NonNullable<AgentPaymentClaim["x402"]>["supportedRails"];
    defaultRail?: NonNullable<AgentPaymentClaim["x402"]>["defaultRail"];
    pricingMode?: NonNullable<AgentPaymentClaim["x402"]>["pricingMode"];
    settlementTrigger?: NonNullable<AgentPaymentClaim["x402"]>["settlementTrigger"];
    fixedAmountUsd?: NonNullable<AgentPaymentClaim["x402"]>["fixedAmountUsd"];
    maxAmountUsd?: NonNullable<AgentPaymentClaim["x402"]>["maxAmountUsd"];
    quoteUrl?: NonNullable<AgentPaymentClaim["x402"]>["quoteUrl"];
    referencePriceUsd?: NonNullable<AgentPaymentClaim["x402"]>["referencePriceUsd"];
    referencePriceUnit?: NonNullable<AgentPaymentClaim["x402"]>["referencePriceUnit"];
    facilitatorUrlByRail?: NonNullable<AgentPaymentClaim["x402"]>["facilitatorUrlByRail"];
    payTo?: NonNullable<AgentPaymentClaim["x402"]>["payTo"];
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
  missionAuth?: {
    enabled: boolean;
    status: AgentMissionAuthClaim["status"];
    authorityBaseUrl?: string;
    providerHint?: AgentMissionAuthClaim["providerHint"];
    authorityName?: string;
    supportedProviders?: string[];
    verifyCheckpointUrl?: string;
    exportBundleUrl?: string;
    lastVerifiedAtIso?: string;
    verified: boolean;
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

function stripDigest<T extends { claimDigest: unknown }>(value: T): Omit<T, "claimDigest"> {
  const { claimDigest: _claimDigest, ...rest } = value;
  return rest;
}

function stripBundleDigest<T extends { bundleDigest: unknown }>(value: T): Omit<T, "bundleDigest"> {
  const { bundleDigest: _bundleDigest, ...rest } = value;
  return rest;
}

function compareDigest(label: string, digest: unknown, value: unknown): VerificationCheck {
  const expected = canonicalDigest(value);
  const actual = digest as { sha256Hex?: string; stableJson?: string; fieldChunks?: string[] } | undefined;

  const shaOk = actual?.sha256Hex === expected.sha256Hex;
  const stableOk = actual?.stableJson === expected.stableJson;
  const fieldOk = JSON.stringify(actual?.fieldChunks ?? []) === JSON.stringify(expected.fieldChunks);

  return {
    label,
    ok: shaOk && stableOk && fieldOk,
    ...(expected.sha256Hex ? { expected: expected.sha256Hex } : {}),
    ...(actual?.sha256Hex ? { actual: actual.sha256Hex } : {}),
    note:
      shaOk && stableOk && fieldOk
        ? "Digest matches stable JSON, SHA-256, and field chunks."
        : "Digest mismatch against canonical stable-JSON encoding."
  };
}

function compareValue(label: string, expected: unknown, actual: unknown): VerificationCheck {
  const expectedStable = canonicalDigest(expected).stableJson;
  const actualStable = canonicalDigest(actual).stableJson;
  return {
    label,
    ok: expectedStable === actualStable,
    ...(expectedStable ? { expected: expectedStable } : {}),
    ...(actualStable ? { actual: actualStable } : {})
  };
}

function verifyEvidenceDigests(evidence: InteropEvidenceObject[]): VerificationCheck[] {
  return evidence.map((item) => compareDigest(`evidence:${item.kind}:${item.id}`, item.digest, item.object));
}

function verifyRepresentation(representation: AgentRepresentationClaim): VerificationCheck[] {
  return [
    compareDigest(
      "representation.claimDigest",
      representation.claimDigest,
      stripDigest(representation)
    ),
    compareDigest(
      "representation.manifestDigest",
      representation.proofCapability.manifestDigest,
      representation.proofCapability.manifest
    )
  ];
}

function verifyOwnership(ownership: AgentOwnershipClaim): VerificationCheck[] {
  return [compareDigest("ownership.claimDigest", ownership.claimDigest, stripDigest(ownership))];
}

function verifyAuthority(authority: AgentAuthorityClaim): VerificationCheck[] {
  return [compareDigest("authority.claimDigest", authority.claimDigest, stripDigest(authority))];
}

function verifyPayment(payment: AgentPaymentClaim): VerificationCheck[] {
  return [compareDigest("payment.claimDigest", payment.claimDigest, stripDigest(payment))];
}

function verifyPrivacy(privacy: AgentPrivacyClaim): VerificationCheck[] {
  return [compareDigest("privacy.claimDigest", privacy.claimDigest, stripDigest(privacy))];
}

function verifyMissionAuth(missionAuth: AgentMissionAuthClaim | undefined): VerificationCheck[] {
  if (!missionAuth) {
    return [];
  }
  return [compareDigest("missionAuth.claimDigest", missionAuth.claimDigest, stripDigest(missionAuth))];
}

function findOriginVerifierAnchor(bundle: ClawzAgentProofBundle, proof: ZkTlsOriginProof) {
  return bundle.trustAnchors.find(
    (anchor) =>
      anchor.type === "zktls-verifier" &&
      anchor.verificationMaterial.includes(proof.verifierSystem) &&
      anchor.verificationMaterial.includes(proof.verifierKeyHash)
  );
}

function verifyOriginProofs(bundle: ClawzAgentProofBundle): VerificationCheck[] {
  const originProofs = bundle.originProofs ?? [];
  if (originProofs.length === 0) {
    return [];
  }

  const evidenceById = new Map(
    bundle.evidence.filter((item) => item.kind === "origin-proof").map((item) => [item.id, item])
  );
  const proofById = new Map(originProofs.map((proof) => [proof.originProofId, proof]));
  const checks: VerificationCheck[] = [
    compareValue(
      "origin:proofCount=evidenceCount",
      originProofs.length,
      bundle.evidence.filter((item) => item.kind === "origin-proof").length
    )
  ];

  originProofs.forEach((proof) => {
    const evidence = evidenceById.get(proof.originProofId);
    checks.push(compareValue(`origin:${proof.originProofId}:evidenceObject`, proof, evidence?.object ?? null));
    checks.push(
      compareValue(
        `origin:${proof.originProofId}:hostAllowed`,
        true,
        bundle.authority.allowedExternalHosts.includes(proof.host)
      )
    );
    checks.push(
      compareValue(
        `origin:${proof.originProofId}:trustAnchorPresent`,
        true,
        Boolean(findOriginVerifierAnchor(bundle, proof))
      )
    );
  });

  const receipt = bundle.exampleToolReceipt;
  if (receipt?.originProofRef) {
    const proof = proofById.get(receipt.originProofRef);
    checks.push(compareValue("origin:receipt.originProofRef", true, Boolean(proof)));
    checks.push(
      compareValue(
        "origin:receipt.originProofDigest",
        proof ? canonicalDigest(proof).sha256Hex : null,
        receipt.originProofDigest ?? null
      )
    );
    checks.push(
      compareValue(
        "origin:receipt.originVerifierKeyHash",
        proof?.verifierKeyHash ?? null,
        receipt.originVerifierKeyHash ?? null
      )
    );
  }

  return checks;
}

function verifyCrossClaimConsistency(bundle: ClawzAgentProofBundle): VerificationCheck[] {
  return [
    compareValue(
      "cross:payment.spendModel=manifest.spendModel",
      bundle.representation.proofCapability.manifest.spendModel,
      bundle.payment.spendModel
    ),
    compareValue(
      "cross:privacy.providerClass=manifest.providerClass",
      bundle.representation.proofCapability.manifest.providerClass,
      bundle.privacy.providerClass
    ),
    compareValue(
      "cross:privacy.disclosureClass=manifest.disclosureClass",
      bundle.representation.proofCapability.manifest.disclosureClass,
      bundle.privacy.disclosureClass
    ),
    compareValue(
      "cross:authority.preset=privacy.preset",
      bundle.authority.privacyBoundary.preset,
      bundle.privacy.preset
    ),
    compareValue(
      "cross:authority.proofLevel=privacy.proofLevel",
      bundle.authority.proofLevel,
      bundle.privacy.proofLevel
    ),
    compareValue(
      "cross:authority.defaultArtifactVisibility=privacy.defaultArtifactVisibility",
      bundle.authority.privacyBoundary.defaultArtifactVisibility,
      bundle.privacy.defaultArtifactVisibility
    ),
    compareValue(
      "cross:privacy.selectedLocationAvailable",
      true,
      bundle.privacy.programmablePrivacy.options.some((option) => option.location === bundle.privacy.programmablePrivacy.selectedLocation)
    ),
    compareValue(
      "cross:privacy.singleDefaultSelected",
      1,
      bundle.privacy.programmablePrivacy.options.filter((option) => option.defaultSelected).length
    ),
    compareValue(
      "cross:originProofRootedReceipt",
      Boolean(bundle.originProofs && bundle.originProofs.length > 0),
      Boolean(bundle.exampleToolReceipt?.originProofRef)
    )
  ];
}

function verifyDiscoveryConsistency(
  bundle: ClawzAgentProofBundle,
  discovery?: ClawzAgentDiscoveryDocument
): VerificationCheck[] {
  if (!discovery) {
    return [];
  }

  return [
    compareValue("discovery:protocol", discovery.protocol, bundle.protocol),
    compareValue("discovery:serviceId", discovery.serviceId, bundle.serviceId),
    compareValue("discovery:discoveryEndpoint", discovery.endpoints.discovery, bundle.discoveryUrl),
    compareValue("discovery:focusedSessionId", discovery.focusedSessionId, bundle.authority.sessionId),
    compareValue("discovery:network", discovery.network, bundle.network),
    compareValue("discovery:programmablePrivacy", discovery.programmablePrivacy, bundle.privacy.programmablePrivacy),
    compareValue(
      "discovery:capabilityId",
      discovery.capabilities[0]?.capabilityId ?? null,
      bundle.representation.proofCapability.capabilityId
    )
  ];
}

export function summarizeAgentProofBundle(bundle: ClawzAgentProofBundle): AgentTrustQuestionAnswer {
  return {
    represents: {
      serviceId: bundle.representation.serviceId,
      agentId: bundle.representation.agentId,
      principalType: bundle.representation.representedPrincipal.type,
      publicKey: bundle.representation.representedPrincipal.publicKey,
      walletId: bundle.representation.representedPrincipal.walletId,
      tenantId: bundle.representation.representedPrincipal.tenantId,
      workspaceId: bundle.representation.representedPrincipal.workspaceId
    },
    ownership: {
      publicClawzUrl: bundle.ownership.publicClawzUrl,
      ownershipStatus: bundle.ownership.ownershipStatus,
      legacyRegistration: bundle.ownership.legacyRegistration,
      canReclaim: bundle.ownership.canReclaim,
      challengePath: bundle.ownership.challengePath,
      ...(bundle.ownership.verificationMethod ? { verificationMethod: bundle.ownership.verificationMethod } : {}),
      ...(bundle.ownership.challengeId ? { challengeId: bundle.ownership.challengeId } : {}),
      ...(bundle.ownership.verifiedAtIso ? { verifiedAtIso: bundle.ownership.verifiedAtIso } : {}),
      ...(bundle.ownership.reclaimedAtIso ? { reclaimedAtIso: bundle.ownership.reclaimedAtIso } : {}),
      verified: bundle.ownership.ownershipStatus === "verified"
    },
    authority: {
      sessionId: bundle.authority.sessionId,
      ...(bundle.authority.turnId ? { turnId: bundle.authority.turnId } : {}),
      trustModeId: bundle.authority.trustModeId,
      proofLevel: bundle.authority.proofLevel,
      allowedActions: bundle.authority.allowedActions,
      allowedExternalHosts: bundle.authority.allowedExternalHosts,
      approvalsRequired: bundle.authority.approvalPolicy.requiredApprovals,
      activePrivacyExceptionCount: bundle.authority.activePrivacyExceptions.length
    },
    payment: {
      settlementAsset: bundle.payment.settlementAsset,
      settlementModel: bundle.payment.settlementModel,
      spendModel: bundle.payment.spendModel,
      payeeKey: bundle.payment.payeeKey,
      sponsoredBudgetMina: bundle.payment.sponsoredBudgetMina,
      sponsoredRemainingMina: bundle.payment.sponsoredRemainingMina,
      x402Enabled: Boolean(bundle.payment.x402?.enabled),
      ...(bundle.payment.x402?.supportedRails ? { supportedRails: bundle.payment.x402.supportedRails } : {}),
      ...(bundle.payment.x402?.defaultRail ? { defaultRail: bundle.payment.x402.defaultRail } : {}),
      ...(bundle.payment.x402?.pricingMode ? { pricingMode: bundle.payment.x402.pricingMode } : {}),
      ...(bundle.payment.x402?.settlementTrigger ? { settlementTrigger: bundle.payment.x402.settlementTrigger } : {}),
      ...(bundle.payment.x402?.fixedAmountUsd ? { fixedAmountUsd: bundle.payment.x402.fixedAmountUsd } : {}),
      ...(bundle.payment.x402?.maxAmountUsd ? { maxAmountUsd: bundle.payment.x402.maxAmountUsd } : {}),
      ...(bundle.payment.x402?.quoteUrl ? { quoteUrl: bundle.payment.x402.quoteUrl } : {}),
      ...(bundle.payment.x402?.referencePriceUsd ? { referencePriceUsd: bundle.payment.x402.referencePriceUsd } : {}),
      ...(bundle.payment.x402?.referencePriceUnit ? { referencePriceUnit: bundle.payment.x402.referencePriceUnit } : {}),
      ...(bundle.payment.x402?.payTo ? { payTo: bundle.payment.x402.payTo } : {})
    },
    privacy: {
      preset: bundle.privacy.preset,
      proofLevel: bundle.privacy.proofLevel,
      defaultArtifactVisibility: bundle.privacy.defaultArtifactVisibility,
      disclosureClass: bundle.privacy.disclosureClass,
      retentionProfile: bundle.privacy.retentionPolicy.profile,
      sealedArtifactCount: bundle.privacy.sealedArtifactCount,
      selectedProvingLocation: bundle.privacy.programmablePrivacy.selectedLocation,
      availableProvingLocations: bundle.privacy.programmablePrivacy.options.map((option) => option.location)
    },
    ...(bundle.missionAuth
      ? {
          missionAuth: {
            enabled: bundle.missionAuth.enabled,
            status: bundle.missionAuth.status,
            ...(bundle.missionAuth.authorityBaseUrl ? { authorityBaseUrl: bundle.missionAuth.authorityBaseUrl } : {}),
            ...(bundle.missionAuth.providerHint ? { providerHint: bundle.missionAuth.providerHint } : {}),
            ...(bundle.missionAuth.authorityName ? { authorityName: bundle.missionAuth.authorityName } : {}),
            ...(bundle.missionAuth.supportedProviders ? { supportedProviders: bundle.missionAuth.supportedProviders } : {}),
            ...(bundle.missionAuth.verifyCheckpointUrl
              ? { verifyCheckpointUrl: bundle.missionAuth.verifyCheckpointUrl }
              : {}),
            ...(bundle.missionAuth.exportBundleUrl ? { exportBundleUrl: bundle.missionAuth.exportBundleUrl } : {}),
            ...(bundle.missionAuth.lastVerifiedAtIso ? { lastVerifiedAtIso: bundle.missionAuth.lastVerifiedAtIso } : {}),
            verified: bundle.missionAuth.status === "verified"
          }
        }
      : {}),
    origin: {
      proofCount: bundle.originProofs?.length ?? 0,
      hosts: [...new Set((bundle.originProofs ?? []).map((proof) => proof.host))],
      verifierSystems: [...new Set((bundle.originProofs ?? []).map((proof) => proof.verifierSystem))],
      rootedProofs: (bundle.originProofs ?? []).map((proof) => ({
        originProofId: proof.originProofId,
        host: proof.host,
        verifierSystem: proof.verifierSystem,
        expiresAtIso: proof.expiresAtIso
      }))
    }
  };
}

export function buildProofVerificationResponse(input: {
  source: ClawzAgentProofVerificationResponse["source"];
  bundle: ClawzAgentProofBundle;
  report: AgentProofVerificationReport;
  discovery?: ClawzAgentDiscoveryDocument;
}): ClawzAgentProofVerificationResponse {
  return {
    ok: input.report.ok,
    source: input.source,
    summary: {
      protocol: input.bundle.protocol,
      serviceId: input.bundle.serviceId,
      generatedAtIso: input.bundle.generatedAtIso,
      bundleDigestSha256: input.bundle.bundleDigest.sha256Hex
    },
    question: summarizeAgentProofBundle(input.bundle),
    report: input.report,
    ...(input.discovery ? { discovery: input.discovery } : {})
  };
}

export function verifyWitnessPlanCoverage(
  bundle: ClawzAgentProofBundle,
  witnessPlan: WitnessPlanLike
): WitnessPlanCoverageResult {
  const expected = bundle.trustAnchors
    .filter((anchor) => anchor.type === "zeko-kernel-path")
    .flatMap((anchor) => anchor.verificationMaterial);
  const actual = (witnessPlan.contracts ?? [])
    .map((entry) => `${entry.kernel ?? ""}.${entry.method ?? ""}`)
    .filter((value) => value !== ".");
  const missing = expected.filter((entry) => !actual.includes(entry));

  return {
    ok: missing.length === 0,
    ...(witnessPlan.scenarioId ? { scenarioId: witnessPlan.scenarioId } : {}),
    covered: actual.filter((entry) => expected.includes(entry)),
    missing
  };
}

export function verifyAgentProofBundle(
  bundle: ClawzAgentProofBundle,
  options?: {
    discovery?: ClawzAgentDiscoveryDocument;
    witnessPlan?: WitnessPlanLike;
  }
): AgentProofVerificationReport {
  const checks: VerificationCheck[] = [
    compareDigest("bundle.bundleDigest", bundle.bundleDigest, stripBundleDigest(bundle)),
    ...verifyRepresentation(bundle.representation),
    ...verifyOwnership(bundle.ownership),
    ...verifyAuthority(bundle.authority),
    ...verifyPayment(bundle.payment),
    ...verifyPrivacy(bundle.privacy),
    ...verifyMissionAuth(bundle.missionAuth),
    ...verifyOriginProofs(bundle),
    ...verifyEvidenceDigests(bundle.evidence),
    ...verifyCrossClaimConsistency(bundle),
    ...verifyDiscoveryConsistency(bundle, options?.discovery)
  ];

  const witnessPlanCoverage = options?.witnessPlan
    ? verifyWitnessPlanCoverage(bundle, options.witnessPlan)
    : undefined;

  const witnessCheck: VerificationCheck[] = witnessPlanCoverage
    ? [
        {
          label: "trustAnchors:witnessPlanCoverage",
          ok: witnessPlanCoverage.ok,
          note: witnessPlanCoverage.ok
            ? "Witness plan covers every Zeko kernel path claimed in trust anchors."
            : `Missing witness plan entries: ${witnessPlanCoverage.missing.join(", ")}`
        }
      ]
    : [];

  const allChecks = [...checks, ...witnessCheck];

  return {
    ok: allChecks.every((check) => check.ok),
    serviceId: bundle.serviceId,
    bundleDigestSha256: bundle.bundleDigest.sha256Hex,
    checks: allChecks,
    ...(witnessPlanCoverage ? { witnessPlanCoverage } : {})
  };
}
