import {
  TRUST_MODE_PRESETS,
  assertCapabilityManifest,
  canonicalDigest,
  sampleRetentionPolicy,
  type AllowedActionClaim,
  type CapabilityManifest,
  type ClawzAgentDiscoveryDocument,
  type ClawzAgentProofBundle,
  type ClawzEvent,
  type ClawzMcpToolDefinition,
  type ConsoleStateResponse,
  type InteropEvidenceObject,
  type PrivacyProvingLocation,
  type ProgrammablePrivacyPolicy,
  type StableJsonValue,
  type ToolReceipt,
  type ZkTlsOriginProof
} from "@clawz/protocol";
import { buildGhostRunPlan, buildNoopOriginProofAttestation } from "@clawz/worker-runtime";

import type { SessionView } from "./materializer.js";
import { buildProtocolOwnerFeePreviews } from "./protocol-owner-fee.js";

const SERVICE_ID = "clawz-privacy-orchestrator";
const PROOF_PLUGIN_ID = "plugin_clawz_proof_surface";
const PROOF_CAPABILITY_ID = "cap_clawz_identity_authority_payment";
const DEFAULT_TENANT_ID = "tenant_acme";
const DEFAULT_WORKSPACE_ID = "workspace_blue";
const ZEKO_PROGRAMMABLE_PRIVACY_DOCS = [
  "https://docs.zeko.io/architecture/technical-architecture",
  "https://docs.zeko.io/operators/guides/rollup-on-phala"
] as const;
const KERNEL_VERIFICATION_PATH = [
  "RegistryKernel.registerAgent",
  "SessionKernel.createSession",
  "ApprovalKernel.requestApproval",
  "DisclosureKernel.grantDisclosure",
  "EscrowKernel.reserveBudget",
  "EscrowKernel.settleTurn",
  "TurnKernel.finalizeTurn"
] as const;

export interface InteropBuildInput {
  baseUrl: string;
  consoleState: ConsoleStateResponse;
  sessionView: SessionView;
  events: ClawzEvent[];
  sessionId?: string;
  turnId?: string;
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function isPrivacyProvingLocation(value: string | undefined): value is PrivacyProvingLocation {
  return value === "client" || value === "server" || value === "sovereign-rollup";
}

function addHours(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 60 * 60 * 1000).toISOString();
}

function payoutWalletForRail(
  profile: ConsoleStateResponse["profile"],
  rail: NonNullable<ConsoleStateResponse["profile"]["paymentProfile"]["defaultRail"]>
) {
  if (rail === "base-usdc") {
    return profile.payoutWallets.base;
  }
  if (rail === "ethereum-usdc") {
    return profile.payoutWallets.ethereum;
  }
  return profile.payoutWallets.zeko;
}

function facilitatorUrlForRail(
  profile: ConsoleStateResponse["profile"],
  rail: NonNullable<ConsoleStateResponse["profile"]["paymentProfile"]["defaultRail"]>
) {
  if (rail === "base-usdc") {
    return profile.paymentProfile.baseFacilitatorUrl;
  }
  if (rail === "ethereum-usdc") {
    return profile.paymentProfile.ethereumFacilitatorUrl;
  }
  return undefined;
}

function buildProgrammablePrivacyPolicy(
  consoleState: ConsoleStateResponse,
  supportedLocations: PrivacyProvingLocation[],
  defaultLocation: PrivacyProvingLocation
): ProgrammablePrivacyPolicy {
  const profilePreferredLocation = consoleState.profile.preferredProvingLocation;
  const requestedLocation = process.env.CLAWZ_PRIVACY_PROVING_LOCATION;
  const serverProverConfigured = Boolean(process.env.CLAWZ_SERVER_PROVER_URL?.trim());
  const sovereignRollupConfigured =
    Boolean(process.env.CLAWZ_SOVEREIGN_ROLLUP_ENDPOINT?.trim()) || truthy(process.env.CLAWZ_SOVEREIGN_ROLLUP_ENABLED);
  const teamGoverned = consoleState.wallet.trustModeId === "team-governed";
  const isAvailable = (location: PrivacyProvingLocation) =>
    location === "server" ? serverProverConfigured : location === "sovereign-rollup" ? sovereignRollupConfigured || teamGoverned : true;
  const preferredLocation =
    profilePreferredLocation && supportedLocations.includes(profilePreferredLocation) ? profilePreferredLocation : undefined;
  const envSelectedLocation =
    isPrivacyProvingLocation(requestedLocation) && supportedLocations.includes(requestedLocation) ? requestedLocation : undefined;
  const candidateLocation = preferredLocation ?? envSelectedLocation ?? defaultLocation;
  const selectedLocation = isAvailable(candidateLocation)
    ? candidateLocation
    : supportedLocations.find((location) => isAvailable(location)) ?? defaultLocation;

  return {
    selectedLocation,
    options: supportedLocations.map((location) => ({
      location,
      dataDomain:
        location === "client" ? "user-data" : location === "server" ? "application-data" : "enterprise-data",
      description:
        location === "client"
          ? "Client-side proving keeps user prompts, files, and workspace context on the operator machine before only commitments leave the device."
          : location === "server"
            ? "Server-side proving fits application-owned data and shared backend context where the app operator is the privacy boundary."
            : "Sovereign-rollup proving pushes enterprise workloads into a private Zeko app rollup, ideal for regulated teams running the Docker Compose plus Phala stack.",
      defaultSelected: location === selectedLocation,
      available: isAvailable(location)
    })),
    serverProverConfigured,
    sovereignRollupConfigured,
    ...(sovereignRollupConfigured || teamGoverned ? { sovereignRollupStack: "docker-compose-phala" as const } : {}),
    docs: [...ZEKO_PROGRAMMABLE_PRIVACY_DOCS]
  };
}

function buildProofCapabilityManifest(consoleState: ConsoleStateResponse): CapabilityManifest {
  const activeMode = TRUST_MODE_PRESETS.find((mode) => mode.id === consoleState.wallet.trustModeId) ?? TRUST_MODE_PRESETS[0]!;
  return assertCapabilityManifest({
    capabilityId: PROOF_CAPABILITY_ID,
    pluginId: PROOF_PLUGIN_ID,
    name: "ClawZ Agent Proof Bundle",
    version: "0.1.0",
    description:
      "Produces deterministic identity, authority, payment, privacy, and programmable-proving proof bundles for agent-to-agent coordination.",
    owner: consoleState.wallet.publicKey,
    ioSchemaHash: canonicalDigest({
      input: {
        sessionId: "optional-string",
        turnId: "optional-string"
      },
      output: {
        protocol: "clawz-agent-proof",
        claims: ["representation", "ownership", "authority", "payment", "privacy", "origin"]
      }
    }).sha256Hex,
    trustClass: activeMode.proofLevel === "proof-backed" ? "high-assurance" : activeMode.proofLevel === "rooted" ? "audited" : "standard",
    approvalClass: "identity-authority-payment-proof",
    spendModel: "per-artifact",
    artifactClasses: ["proof-bundle", "digest", "receipt"],
    reproducibleBuildHash: canonicalDigest({
      serviceId: SERVICE_ID,
      version: "0.1.0",
      proofLevel: activeMode.proofLevel
    }).sha256Hex,
    inputVisibilityClass: "metadata-only",
    outputVisibilityClass: "digest-only",
    retentionClass: sampleRetentionPolicy.profile,
    providerClass: "sealed-local",
    disclosureClass: "self-only",
    requiresRawContent: false,
    supportsRedactedMode: true,
    supportsDigestMode: true
  });
}

function buildEvidenceObject(
  kind: InteropEvidenceObject["kind"],
  id: string,
  route: string,
  object: unknown,
  occurredAtIso?: string
): InteropEvidenceObject {
  const normalizedObject = JSON.parse(canonicalDigest(object).stableJson) as StableJsonValue;
  return {
    kind,
    id,
    route,
    object: normalizedObject,
    digest: canonicalDigest(normalizedObject),
    ...(occurredAtIso ? { occurredAtIso } : {})
  };
}

function selectTurnId(events: ClawzEvent[], requestedTurnId?: string): string | undefined {
  if (requestedTurnId) {
    return requestedTurnId;
  }

  const latest = [...events]
    .reverse()
    .find((event) => typeof (event.payload as Record<string, unknown>).turnId === "string");

  const turnId = latest ? (latest.payload as Record<string, unknown>).turnId : undefined;
  return typeof turnId === "string" ? turnId : undefined;
}

function buildExampleToolReceipt(
  consoleState: ConsoleStateResponse,
  capabilityManifest: CapabilityManifest,
  generatedAtIso: string,
  turnId?: string,
  originProof?: ZkTlsOriginProof
): ToolReceipt {
  const mode = TRUST_MODE_PRESETS.find((item) => item.id === consoleState.wallet.trustModeId) ?? TRUST_MODE_PRESETS[0]!;
  const programmablePrivacy = buildProgrammablePrivacyPolicy(
    consoleState,
    mode.supportedProvingLocations,
    mode.defaultProvingLocation
  );
  return {
    turnId: turnId ?? "turn_unbound",
    stepId: "step_generate_agent_proof_bundle",
    capabilityId: capabilityManifest.capabilityId,
    pluginManifestHash: canonicalDigest(capabilityManifest).sha256Hex,
    policyHash: canonicalDigest({
      trustModeId: mode.id,
      proofLevel: mode.proofLevel,
      requiredApprovals: consoleState.wallet.governancePolicy.requiredApprovals
    }).sha256Hex,
    approvalRef: consoleState.privacyExceptions.find((item) => item.status === "approved")?.id ?? "not-required",
    inputDigest: canonicalDigest({
      sessionId: consoleState.session.sessionId,
      turnId: turnId ?? null
    }).sha256Hex,
    outputDigest: canonicalDigest({
      serviceId: SERVICE_ID,
      bundle: "agent-proof",
      turnId: turnId ?? null
    }).sha256Hex,
    statusCode: 200,
    startedAtIso: generatedAtIso,
    endedAtIso: generatedAtIso,
    privacyModeHash: canonicalDigest({
      preset: mode.preset,
      proofLevel: mode.proofLevel,
      defaultArtifactVisibility: mode.defaultArtifactVisibility,
      selectedProvingLocation: programmablePrivacy.selectedLocation
    }).sha256Hex,
    retentionPolicyHash: canonicalDigest(sampleRetentionPolicy).sha256Hex,
    providerRoutingHash: canonicalDigest({
      providerClass: capabilityManifest.providerClass,
      outputVisibilityClass: capabilityManifest.outputVisibilityClass,
      originProofBacked: Boolean(originProof),
      selectedProvingLocation: programmablePrivacy.selectedLocation
    }).sha256Hex,
    ...(originProof
      ? {
          originProofRef: originProof.originProofId,
          originProofDigest: canonicalDigest(originProof).sha256Hex,
          originVerifierKeyHash: originProof.verifierKeyHash
        }
      : {})
  };
}

function buildAllowedActions(consoleState: ConsoleStateResponse): AllowedActionClaim[] {
  return buildGhostRunPlan(consoleState.wallet.trustModeId).steps.map((step) => ({
    capabilityClass: step.capabilityClass,
    summary: step.summary,
    requiresApproval: step.requiresApproval,
    expandsVisibility: step.expandsVisibility,
    ...(step.externalHost ? { externalHost: step.externalHost } : {})
  }));
}

function buildOriginProofs(input: InteropBuildInput, generatedAtIso: string, turnId?: string): ZkTlsOriginProof[] {
  const sessionId = input.sessionId ?? input.consoleState.session.sessionId;
  const resolvedTurnId = turnId ?? "turn_unbound";
  const currentMode = TRUST_MODE_PRESETS.find((mode) => mode.id === input.consoleState.wallet.trustModeId) ?? TRUST_MODE_PRESETS[0]!;

  return buildGhostRunPlan(input.consoleState.wallet.trustModeId).steps
    .filter((step) => step.externalHost)
    .map((step) =>
      buildNoopOriginProofAttestation({
        sessionId,
        turnId: resolvedTurnId,
        stepId: step.id,
        host: step.externalHost!,
        method: "GET",
        requestTemplateHash: canonicalDigest({
          stepId: step.id,
          host: step.externalHost,
          capabilityClass: step.capabilityClass
        }).sha256Hex,
        selectorHash: canonicalDigest({
          sessionId,
          turnId: resolvedTurnId,
          trustModeId: currentMode.id,
          proofLevel: currentMode.proofLevel
        }).sha256Hex,
        freshnessWindowSeconds: 6 * 60 * 60,
        disclosureClass: currentMode.id === "team-governed" ? "team" : "self-only",
        attestedAtIso: generatedAtIso,
        expiresAtIso: addHours(generatedAtIso, 6),
        verifierSystem: "tlsn-notary-compatible",
        ...(currentMode.proofLevel === "proof-backed"
          ? {
              rawTranscriptManifestId: `sealed_transcript_${resolvedTurnId}_${step.id}`
            }
          : {})
      }).originProof
    );
}

export function buildDiscoveryDocument(input: Omit<InteropBuildInput, "sessionView" | "events">): ClawzAgentDiscoveryDocument {
  const capabilityManifest = buildProofCapabilityManifest(input.consoleState);
  const deployment = input.consoleState.deployment;
  const activeMode = TRUST_MODE_PRESETS.find((mode) => mode.id === input.consoleState.wallet.trustModeId) ?? TRUST_MODE_PRESETS[0]!;
  const programmablePrivacy = buildProgrammablePrivacyPolicy(
    input.consoleState,
    activeMode.supportedProvingLocations,
    activeMode.defaultProvingLocation
  );
  const focusedSessionId = input.sessionId ?? input.consoleState.session.sessionId;
  const profile = input.consoleState.profile;
  const sessionQuery = `sessionId=${encodeURIComponent(focusedSessionId)}`;
  return {
    protocol: "clawz-agent-proof",
    version: "0.1",
    serviceId: SERVICE_ID,
    title: `${profile.agentName} discovery surface`,
    summary:
      profile.headline.length > 0
        ? profile.headline
        : "Deterministic proof surface for showing who an agent represents, what it is allowed to do, how it gets paid, which privacy boundaries govern the run, and where proving happens.",
    focusedSessionId,
    network: {
      chain: deployment.chain,
      networkId: deployment.networkId,
      mode: deployment.mode,
      graphqlEndpoint: deployment.graphqlEndpoint,
      archiveEndpoint: deployment.archiveEndpoint
    },
    endpoints: {
      discovery: `${input.baseUrl}/.well-known/agent-interop.json?${sessionQuery}`,
      proofBundle: `${input.baseUrl}/api/interop/agent-proof?${sessionQuery}`,
      verify: `${input.baseUrl}/api/interop/verify?${sessionQuery}`,
      mcp: `${input.baseUrl}/mcp`,
      events: `${input.baseUrl}/api/events?${sessionQuery}`,
      consoleState: `${input.baseUrl}/api/console/state?${sessionQuery}`,
      deployment: `${input.baseUrl}/api/zeko/deployment`,
      privacyExceptions: `${input.baseUrl}/api/privacy-exceptions?${sessionQuery}`
    },
    answersQuestion:
      "ClawZ publishes a deterministic proof bundle plus a live Zeko deployment surface that binds represented principal, verified OpenClaw runtime control, allowed action boundary, payment rail, privacy policy, proving location, and remote-origin provenance into reproducible digests another agent can verify.",
    proofClaims: ["representation", "ownership", "authority", "payment", "privacy", "origin"],
    programmablePrivacy,
    capabilities: [
      {
        capabilityId: capabilityManifest.capabilityId,
        pluginId: capabilityManifest.pluginId,
        name: capabilityManifest.name,
        description: capabilityManifest.description,
        spendModel: capabilityManifest.spendModel,
        approvalClass: capabilityManifest.approvalClass,
        manifestDigest: canonicalDigest(capabilityManifest)
      }
    ],
    supportedMcpTools: ["get_agent_discovery", "get_agent_proof_bundle", "verify_agent_proof", "get_zeko_deployment"]
  };
}

export function buildAgentProofBundle(input: InteropBuildInput): ClawzAgentProofBundle {
  const sessionId = input.sessionId ?? input.consoleState.session.sessionId;
  const turnId = selectTurnId(input.events, input.turnId);
  const profile = input.consoleState.profile;
  const currentMode = TRUST_MODE_PRESETS.find((mode) => mode.id === input.consoleState.wallet.trustModeId) ?? TRUST_MODE_PRESETS[0]!;
  const programmablePrivacy = buildProgrammablePrivacyPolicy(
    input.consoleState,
    currentMode.supportedProvingLocations,
    currentMode.defaultProvingLocation
  );
  const capabilityManifest = buildProofCapabilityManifest(input.consoleState);
  const discovery = buildDiscoveryDocument({
    baseUrl: input.baseUrl,
    consoleState: input.consoleState,
    sessionId
  });

  const sessionEvents = input.events.filter((event) => {
    const payload = event.payload as Record<string, unknown>;
    return payload.sessionId === sessionId;
  });
  const turnEvents = turnId
    ? input.events.filter((event) => {
        const payload = event.payload as Record<string, unknown>;
        return payload.turnId === turnId;
      })
    : [];

  const activePrivacyExceptions = input.consoleState.privacyExceptions
    .filter((item) => item.sessionId === sessionId && (turnId ? item.turnId === turnId : true))
    .filter((item) => item.status !== "expired")
    .map((item) => ({
      exceptionId: item.id,
      audience: item.audience,
      scope: item.scope,
      status: item.status,
      approvalsObserved: item.approvals.length,
      approvalsRequired: item.requiredApprovals,
      expiresAtIso: item.expiresAtIso
    }));

  const latestCreditDeposit = [...input.events]
    .reverse()
    .find((event) => event.type === "CreditsDeposited");

  const latestTurnSettlement = [...input.events]
    .reverse()
    .find((event) => event.type === "TurnSettled" && (!turnId || (event.payload as Record<string, unknown>).turnId === turnId));

  const representationWithoutDigest = {
    serviceId: SERVICE_ID,
    agentId: input.consoleState.agentId,
    representedPrincipal: {
      type: "workspace-shadow-wallet" as const,
      publicKey: input.consoleState.wallet.publicKey,
      walletId: input.consoleState.wallet.walletId,
      tenantId: DEFAULT_TENANT_ID,
      workspaceId: DEFAULT_WORKSPACE_ID
    },
    proofCapability: {
      pluginId: capabilityManifest.pluginId,
      capabilityId: capabilityManifest.capabilityId,
      manifest: capabilityManifest,
      manifestDigest: canonicalDigest(capabilityManifest)
    }
  };
  const representation = {
    ...representationWithoutDigest,
    claimDigest: canonicalDigest(representationWithoutDigest)
  };

  const ownershipWithoutDigest = {
    openClawUrl: profile.openClawUrl,
    ownershipStatus: input.consoleState.ownership.status,
    legacyRegistration: input.consoleState.ownership.legacyRegistration,
    canReclaim: input.consoleState.ownership.canReclaim,
    challengePath: input.consoleState.ownership.challenge?.challengePath ?? "/.well-known/santaclawz-agent-challenge.json",
    ...(input.consoleState.ownership.verification?.verificationMethod
      ? { verificationMethod: input.consoleState.ownership.verification.verificationMethod }
      : {}),
    ...(input.consoleState.ownership.verification?.challengeId
      ? { challengeId: input.consoleState.ownership.verification.challengeId }
      : input.consoleState.ownership.challenge?.challengeId
        ? { challengeId: input.consoleState.ownership.challenge.challengeId }
        : {}),
    ...(input.consoleState.ownership.verification?.challengeUrl
      ? { challengeUrl: input.consoleState.ownership.verification.challengeUrl }
      : input.consoleState.ownership.challenge?.challengeUrl
        ? { challengeUrl: input.consoleState.ownership.challenge.challengeUrl }
        : {}),
    ...(input.consoleState.ownership.verification?.verifiedAtIso
      ? { verifiedAtIso: input.consoleState.ownership.verification.verifiedAtIso }
      : {}),
    ...(input.consoleState.ownership.verification?.challengeResponseDigestSha256
      ? { challengeResponseDigestSha256: input.consoleState.ownership.verification.challengeResponseDigestSha256 }
      : {}),
    ...(input.consoleState.ownership.verification?.attestationDigestSha256
      ? { attestationDigestSha256: input.consoleState.ownership.verification.attestationDigestSha256 }
      : {}),
    ...(input.consoleState.ownership.verification?.reclaimedAtIso
      ? { reclaimedAtIso: input.consoleState.ownership.verification.reclaimedAtIso }
      : {})
  };
  const ownership = {
    ...ownershipWithoutDigest,
    claimDigest: canonicalDigest(ownershipWithoutDigest)
  };

  const allowedActions = buildAllowedActions(input.consoleState);
  const authorityWithoutDigest = {
    sessionId,
    ...(turnId ? { turnId } : {}),
    trustModeId: currentMode.id,
    proofLevel: currentMode.proofLevel,
    allowedActions,
    allowedExternalHosts: unique(allowedActions.map((action) => action.externalHost).filter((value): value is string => Boolean(value))),
    approvalPolicy: input.consoleState.wallet.governancePolicy,
    privacyBoundary: {
      preset: currentMode.preset,
      operatorVisible: currentMode.operatorVisible,
      providerVisible: currentMode.providerVisible,
      externalHostsAllowed: currentMode.preset === "convenient",
      defaultArtifactVisibility: currentMode.defaultArtifactVisibility,
      privacyExceptionsRequired: buildGhostRunPlan(currentMode.id).privacyExceptionsRequired,
      retentionPolicy: sampleRetentionPolicy
    },
    activePrivacyExceptions
  };
  const authority = {
    ...authorityWithoutDigest,
    claimDigest: canonicalDigest(authorityWithoutDigest)
  };
  const x402PayTo = Object.fromEntries(
    input.consoleState.profile.paymentProfile.supportedRails
      .map((rail) => [rail, payoutWalletForRail(input.consoleState.profile, rail)] as const)
      .filter((entry): entry is [typeof entry[0], string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
  );
  const x402FacilitatorUrlByRail = Object.fromEntries(
    input.consoleState.profile.paymentProfile.supportedRails
      .map((rail) => [rail, facilitatorUrlForRail(input.consoleState.profile, rail)] as const)
      .filter((entry): entry is [typeof entry[0], string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
  );
  const x402FeePreviewByRail = buildProtocolOwnerFeePreviews({
    policy: input.consoleState.protocolOwnerFeePolicy,
    profile: input.consoleState.profile
  });

  const paymentWithoutDigest = {
    settlementAsset: "MINA" as const,
    settlementModel: "reserve-settle-refund" as const,
    payeeKey: input.consoleState.wallet.publicKey,
    spendModel: capabilityManifest.spendModel,
    sponsoredBudgetMina: input.consoleState.wallet.sponsoredBudgetMina,
    sponsoredRemainingMina: input.consoleState.wallet.sponsoredRemainingMina,
    ...(latestCreditDeposit
      ? {
          latestCreditDeposit: {
            eventId: latestCreditDeposit.id,
            amountMina: String((latestCreditDeposit.payload as Record<string, unknown>).amountMina ?? "0"),
            occurredAtIso: latestCreditDeposit.occurredAtIso
          }
        }
      : {}),
    ...(latestTurnSettlement
      ? {
          latestTurnSettlement: {
            eventId: latestTurnSettlement.id,
            turnId: String((latestTurnSettlement.payload as Record<string, unknown>).turnId ?? turnId ?? "unknown"),
            ...(typeof (latestTurnSettlement.payload as Record<string, unknown>).reservedMina === "string"
              ? { reservedMina: (latestTurnSettlement.payload as Record<string, unknown>).reservedMina as string }
              : {}),
            ...(typeof (latestTurnSettlement.payload as Record<string, unknown>).spentMina === "string"
              ? { spentMina: (latestTurnSettlement.payload as Record<string, unknown>).spentMina as string }
              : {}),
            ...(typeof (latestTurnSettlement.payload as Record<string, unknown>).refundedMina === "string"
              ? { refundedMina: (latestTurnSettlement.payload as Record<string, unknown>).refundedMina as string }
              : {}),
            occurredAtIso: latestTurnSettlement.occurredAtIso
          }
        }
      : {}),
    ...(input.consoleState.profile.paymentProfile.enabled
      ? {
          x402: {
            enabled: input.consoleState.profile.paymentProfile.enabled,
            supportedRails: input.consoleState.profile.paymentProfile.supportedRails,
            ...(input.consoleState.profile.paymentProfile.defaultRail
              ? { defaultRail: input.consoleState.profile.paymentProfile.defaultRail }
              : {}),
            pricingMode: input.consoleState.profile.paymentProfile.pricingMode,
            settlementTrigger: input.consoleState.profile.paymentProfile.settlementTrigger,
            ...(input.consoleState.profile.paymentProfile.fixedAmountUsd
              ? { fixedAmountUsd: input.consoleState.profile.paymentProfile.fixedAmountUsd }
              : {}),
            ...(input.consoleState.profile.paymentProfile.maxAmountUsd
              ? { maxAmountUsd: input.consoleState.profile.paymentProfile.maxAmountUsd }
              : {}),
            ...(input.consoleState.profile.paymentProfile.quoteUrl
              ? { quoteUrl: input.consoleState.profile.paymentProfile.quoteUrl }
              : {}),
            ...(input.consoleState.protocolOwnerFeePolicy.enabled
              ? {
                  protocolOwnerFeeBps: input.consoleState.protocolOwnerFeePolicy.feeBps,
                  protocolFeeRecipientByRail: input.consoleState.protocolOwnerFeePolicy.recipientByRail,
                  feeSettlementMode: input.consoleState.protocolOwnerFeePolicy.settlementModel
                }
              : {}),
            ...(x402FeePreviewByRail.length > 0
              ? {
                  feePreviewByRail: x402FeePreviewByRail.map((preview) => ({
                    rail: preview.rail,
                    ...(preview.grossAmountUsd ? { grossAmountUsd: preview.grossAmountUsd } : {}),
                    ...(preview.sellerNetAmountUsd ? { sellerNetAmountUsd: preview.sellerNetAmountUsd } : {}),
                    ...(preview.protocolFeeAmountUsd ? { protocolFeeAmountUsd: preview.protocolFeeAmountUsd } : {}),
                    ...(preview.nominalProtocolFeeAmountUsd
                      ? { nominalProtocolFeeAmountUsd: preview.nominalProtocolFeeAmountUsd }
                      : {}),
                    ...(preview.networkFacilitationFeeAmountUsd
                      ? { networkFacilitationFeeAmountUsd: preview.networkFacilitationFeeAmountUsd }
                      : {}),
                    ...(preview.feeBasis ? { feeBasis: preview.feeBasis } : {})
                  }))
                }
              : {}),
            ...(Object.keys(x402FacilitatorUrlByRail).length > 0
              ? { facilitatorUrlByRail: x402FacilitatorUrlByRail }
              : {}),
            ...(input.consoleState.profile.paymentProfile.paymentNotes
              ? { paymentNotes: input.consoleState.profile.paymentProfile.paymentNotes }
              : {}),
            ...(Object.keys(x402PayTo).length > 0 ? { payTo: x402PayTo } : {})
          }
        }
      : {})
  };
  const payment = {
    ...paymentWithoutDigest,
    claimDigest: canonicalDigest(paymentWithoutDigest)
  };

  const privacyWithoutDigest = {
    preset: currentMode.preset,
    proofLevel: currentMode.proofLevel,
    defaultArtifactVisibility: currentMode.defaultArtifactVisibility,
    providerClass: capabilityManifest.providerClass,
    disclosureClass: capabilityManifest.disclosureClass,
    retentionPolicy: sampleRetentionPolicy,
    sealedArtifactCount: input.consoleState.session.sealedArtifactCount,
    programmablePrivacy
  };
  const privacy = {
    ...privacyWithoutDigest,
    claimDigest: canonicalDigest(privacyWithoutDigest)
  };

  const socialWithoutDigest = {
    anchorMode: input.consoleState.profile.socialAnchorPolicy.mode,
    pendingCandidateCount: input.consoleState.socialAnchorQueue.pendingCount,
    anchoredFactCount: input.consoleState.socialAnchorQueue.anchoredCount,
    candidateKinds: [...new Set(input.consoleState.socialAnchorQueue.items.map((item) => item.kind))],
    ...(input.consoleState.socialAnchorQueue.latestRootDigestSha256
      ? { latestRootDigestSha256: input.consoleState.socialAnchorQueue.latestRootDigestSha256 }
      : {}),
    ...(input.consoleState.socialAnchorQueue.lastSettledAtIso
      ? { lastSettledAtIso: input.consoleState.socialAnchorQueue.lastSettledAtIso }
      : {}),
    recentBatches: input.consoleState.socialAnchorQueue.recentBatches.map((batch) => ({
      batchId: batch.batchId,
      anchorMode: batch.anchorMode,
      rootDigestSha256: batch.rootDigestSha256,
      settledAtIso: batch.settledAtIso,
      ...(batch.anchorField ? { anchorField: batch.anchorField } : {}),
      ...(batch.contractAddress ? { contractAddress: batch.contractAddress } : {}),
      ...(batch.txHash ? { txHash: batch.txHash } : {}),
      ...(batch.submitFeeRaw ? { submitFeeRaw: batch.submitFeeRaw } : {}),
      ...(batch.submitFee ? { submitFee: batch.submitFee } : {}),
      ...(batch.submitFeeSource ? { submitFeeSource: batch.submitFeeSource } : {}),
      ...(typeof batch.submitAttemptCount === "number" ? { submitAttemptCount: batch.submitAttemptCount } : {})
    }))
  };
  const social = {
    ...socialWithoutDigest,
    claimDigest: canonicalDigest(socialWithoutDigest)
  };

  const missionAuthWithoutDigest = input.consoleState.profile.missionAuthOverlay.enabled
    ? {
        enabled: input.consoleState.profile.missionAuthOverlay.enabled,
        status: input.consoleState.profile.missionAuthOverlay.status,
        ...(input.consoleState.profile.missionAuthOverlay.authorityBaseUrl
          ? { authorityBaseUrl: input.consoleState.profile.missionAuthOverlay.authorityBaseUrl }
          : {}),
        ...(input.consoleState.profile.missionAuthOverlay.providerHint
          ? { providerHint: input.consoleState.profile.missionAuthOverlay.providerHint }
          : {}),
        scopeHints: input.consoleState.profile.missionAuthOverlay.scopeHints,
        ...(input.consoleState.profile.missionAuthOverlay.protocol
          ? { protocol: input.consoleState.profile.missionAuthOverlay.protocol }
          : {}),
        ...(input.consoleState.profile.missionAuthOverlay.authorityName
          ? { authorityName: input.consoleState.profile.missionAuthOverlay.authorityName }
          : {}),
        ...(input.consoleState.profile.missionAuthOverlay.discoveryUrl
          ? { discoveryUrl: input.consoleState.profile.missionAuthOverlay.discoveryUrl }
          : {}),
        ...(input.consoleState.profile.missionAuthOverlay.jwksUrl
          ? { jwksUrl: input.consoleState.profile.missionAuthOverlay.jwksUrl }
          : {}),
        ...(input.consoleState.profile.missionAuthOverlay.providersUrl
          ? { providersUrl: input.consoleState.profile.missionAuthOverlay.providersUrl }
          : {}),
        ...(input.consoleState.profile.missionAuthOverlay.verifyCheckpointUrl
          ? { verifyCheckpointUrl: input.consoleState.profile.missionAuthOverlay.verifyCheckpointUrl }
          : {}),
        ...(input.consoleState.profile.missionAuthOverlay.exportBundleUrl
          ? { exportBundleUrl: input.consoleState.profile.missionAuthOverlay.exportBundleUrl }
          : {}),
        ...(input.consoleState.profile.missionAuthOverlay.supportedProviders
          ? { supportedProviders: input.consoleState.profile.missionAuthOverlay.supportedProviders }
          : {}),
        ...(input.consoleState.profile.missionAuthOverlay.lastVerifiedAtIso
          ? { lastVerifiedAtIso: input.consoleState.profile.missionAuthOverlay.lastVerifiedAtIso }
          : {})
      }
    : undefined;
  const missionAuth = missionAuthWithoutDigest
    ? {
        ...missionAuthWithoutDigest,
        claimDigest: canonicalDigest(missionAuthWithoutDigest)
      }
    : undefined;

  const generatedAtIso =
    [
      input.consoleState.session.lastEventAtIso,
      ...input.consoleState.artifacts.map((artifact) => artifact.createdAtIso),
      ...turnEvents.map((event) => event.occurredAtIso),
      ...sessionEvents.map((event) => event.occurredAtIso)
    ]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? new Date().toISOString();

  const originProofs = buildOriginProofs(input, generatedAtIso, turnId);
  const exampleToolReceipt = buildExampleToolReceipt(
    input.consoleState,
    capabilityManifest,
    generatedAtIso,
    turnId,
    originProofs[0]
  );

  const evidence: InteropEvidenceObject[] = [
    buildEvidenceObject("capability-manifest", capabilityManifest.capabilityId, discovery.endpoints.discovery, capabilityManifest),
    buildEvidenceObject("console-state", input.consoleState.session.sessionId, discovery.endpoints.consoleState, input.consoleState),
    buildEvidenceObject(
      "deployment",
      `${input.consoleState.deployment.networkId}:${input.consoleState.deployment.mode}`,
      discovery.endpoints.deployment,
      input.consoleState.deployment,
      input.consoleState.deployment.generatedAtIso
    ),
    buildEvidenceObject("session", sessionId, `${input.baseUrl}/api/sessions/${sessionId}`, input.sessionView),
    buildEvidenceObject("receipt", exampleToolReceipt.stepId, discovery.endpoints.proofBundle, exampleToolReceipt, generatedAtIso),
    ...originProofs.map((originProof) =>
      buildEvidenceObject("origin-proof", originProof.originProofId, discovery.endpoints.proofBundle, originProof, originProof.attestedAtIso)
    ),
    ...input.consoleState.artifacts.map((artifact) =>
      buildEvidenceObject("artifact", artifact.manifestId, discovery.endpoints.consoleState, artifact, artifact.createdAtIso)
    ),
    ...activePrivacyExceptions.map((exception) =>
      buildEvidenceObject("privacy-exception", exception.exceptionId, discovery.endpoints.privacyExceptions, exception, exception.expiresAtIso)
    ),
    ...(missionAuth
      ? [
          buildEvidenceObject(
            "mission-auth-overlay",
            input.consoleState.session.sessionId,
            discovery.endpoints.proofBundle,
            missionAuthWithoutDigest as StableJsonValue,
            input.consoleState.profile.missionAuthOverlay.lastVerifiedAtIso
          )
        ]
      : []),
    ...unique([...sessionEvents, ...turnEvents].map((event) => event.id)).map((eventId) => {
      const event = [...sessionEvents, ...turnEvents].find((entry) => entry.id === eventId)!;
      return buildEvidenceObject("event", event.id, discovery.endpoints.events, event as unknown as Record<string, unknown>, event.occurredAtIso);
    })
  ];

  const trustAnchors = [
    {
      type: "canonical-digest" as const,
      chain: "zeko" as const,
      networkId: discovery.network.networkId,
      verificationMaterial: ["capability manifest digest", "claim digests", "bundle digest", "evidence digests"],
      note: "Every claim and evidence object is stable-JSON hashed so another agent can reproduce the same digests offline."
    },
    {
      type: "zeko-kernel-path" as const,
      chain: "zeko" as const,
      networkId: discovery.network.networkId,
      verificationMaterial: [...KERNEL_VERIFICATION_PATH],
      note: "These claim categories map cleanly onto the Zeko deployment path for registry, approvals, disclosures, escrow, and turn finalization."
    },
    ...social.recentBatches
      .filter((batch) => Boolean(batch.contractAddress) && Boolean(batch.txHash))
      .slice(0, 1)
      .map((batch) => ({
        type: "zeko-kernel-path" as const,
        chain: "zeko" as const,
        networkId: discovery.network.networkId,
        verificationMaterial: [
          batch.contractAddress!,
          batch.txHash!,
          ...(batch.anchorField ? [batch.anchorField] : []),
          batch.rootDigestSha256
        ],
        note: "Recent social activity can be checked against the SocialAnchorKernel batch root SantaClawz submitted on Zeko."
      })),
    ...unique(originProofs.map((proof) => `${proof.verifierSystem}:${proof.verifierKeyHash}`)).map((descriptor) => {
      const separator = descriptor.indexOf(":");
      const verifierSystem = separator >= 0 ? descriptor.slice(0, separator) : descriptor;
      const verifierKeyHash = separator >= 0 ? descriptor.slice(separator + 1) : "";
      return {
        type: "zktls-verifier" as const,
        chain: "offchain" as const,
        networkId: verifierSystem,
        verificationMaterial: [
          verifierSystem,
          verifierKeyHash,
          "origin proof digests are canonical stable-JSON hashes over attested request/response commitments"
        ],
        note:
          "Remote-origin proofs are pinned to verifier metadata so another agent can confirm which zkTLS/notary system attested the upstream fact."
      };
    })
  ];

  const bundleWithoutDigest = {
    protocol: "clawz-agent-proof" as const,
    version: "0.1" as const,
    serviceId: SERVICE_ID,
    generatedAtIso,
    network: discovery.network,
    discoveryUrl: discovery.endpoints.discovery,
    representation,
    ownership,
    authority,
    payment,
    privacy,
    social,
    ...(missionAuth ? { missionAuth } : {}),
    ...(originProofs.length > 0 ? { originProofs } : {}),
    exampleToolReceipt,
    evidence,
    trustAnchors
  };

  return {
    ...bundleWithoutDigest,
    bundleDigest: canonicalDigest(bundleWithoutDigest)
  };
}

export function buildMcpToolDefinitions(): ClawzMcpToolDefinition[] {
  return [
    {
      name: "get_agent_discovery",
      description: "Return the ClawZ discovery document for interoperable identity, authority, payment, and privacy proofs.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: {
            type: "string"
          }
        }
      }
    },
    {
      name: "get_agent_proof_bundle",
      description: "Return a deterministic proof bundle for the current or requested session/turn.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: {
            type: "string"
          },
          turnId: {
            type: "string"
          }
        }
      }
    },
    {
      name: "get_zeko_deployment",
      description: "Return the live Zeko deployment summary, kernel addresses, and privacy posture for this ClawZ runtime.",
      inputSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "verify_agent_proof",
      description:
        "Verify a ClawZ proof bundle from this runtime, from a remote URL, or from a provided bundle payload.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string"
          },
          sessionId: {
            type: "string"
          },
          turnId: {
            type: "string"
          },
          bundle: {
            type: "object"
          },
          discovery: {
            type: "object"
          },
          witnessPlan: {
            type: "object"
          }
        }
      }
    }
  ];
}
