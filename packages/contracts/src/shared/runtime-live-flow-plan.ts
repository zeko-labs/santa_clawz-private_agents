import { randomUUID } from "node:crypto";

import { TRUST_MODE_PRESETS } from "@clawz/protocol";
import type {
  ArtifactVisibility,
  GovernancePolicy,
  GuardianRecord,
  PrivacyExceptionQueueItem,
  TrustModeId
} from "@clawz/protocol";

import { appendRoot, emptyRoot } from "./root-helpers.js";
import {
  buildAcquireLeaseWitness,
  buildAbortTurnWitness,
  buildApprovalPolicyProofWitness,
  buildBeginTurnWitness,
  buildBudgetConservationProofWitness,
  buildCheckpointSessionWitness,
  buildCommitOutputWitness,
  buildCreateSessionWitness,
  buildDisclosureScopeProofWitness,
  buildFinalizeTurnWitness,
  buildGrantApprovalWitness,
  buildGrantDisclosureWitness,
  buildRefundTurnWitness,
  buildRequestPrivacyExceptionWitness,
  buildRevokeDisclosureWitness,
  buildRequestApprovalWitness,
  buildReserveBudgetWitness,
  buildSettleTurnWitness,
  fieldFromValue,
  serializeWitnessValue,
  type DeploymentWitnessPlan,
  type KernelWitness,
  type PreparedKernelCall,
  type PreparedProgramCall,
  type ProgramWitness
} from "./witness-builders.js";

export type RuntimeFlowKind =
  | "first-turn"
  | "next-turn"
  | "abort-turn"
  | "refund-turn"
  | "revoke-disclosure";

export interface RuntimeLiveSessionTurnFlowInput {
  jobId: string;
  flowKind?: RuntimeFlowKind;
  scenarioId?: string;
  sessionId: string;
  turnId: string;
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
  defaultArtifactVisibility: ArtifactVisibility;
  operatorVisible: boolean;
  providerVisible: boolean;
  proofLevel: "signed" | "rooted" | "proof-backed";
  guardians: GuardianRecord[];
  governancePolicy: GovernancePolicy;
  privacyExceptions: PrivacyExceptionQueueItem[];
  sourceTurnId?: string;
  sourceDisclosureId?: string;
  abortReason?: string;
  revocationReason?: string;
  refundAmountMina?: string;
}

export interface BuildDefaultRuntimeLiveSessionTurnFlowInputOptions {
  flowKind?: RuntimeFlowKind;
  scenarioId?: string;
  sessionId?: string;
  turnId?: string;
  sourceTurnId?: string;
  sourceDisclosureId?: string;
  abortReason?: string;
  revocationReason?: string;
  refundAmountMina?: string;
  requestedAtIso?: string;
  trustModeId?: TrustModeId;
  walletId?: string;
  walletPublicKey?: string;
  requestorKey?: string;
  workerId?: string;
  jobId?: string;
  sponsoredRemainingMina?: string;
  requestedSpendMina?: string;
}

const DEFAULT_TENANT_ID = "tenant_acme";
const DEFAULT_WORKSPACE_ID = "workspace_blue";
const DEFAULT_WALLET_ID = "shadow_wallet_acme_primary";
const DEFAULT_WALLET_PUBLIC_KEY = "B62qshadowwallet000000000000000000000000000000000000000000000000";
const DEFAULT_GUARDIANS: GuardianRecord[] = [
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
];
const DEFAULT_GOVERNANCE_POLICY: GovernancePolicy = {
  requiredApprovals: 2,
  reviewAudience: "Security + Compliance",
  autoExpiryHours: 24
};

function prepareKernelCall<TArgs extends Record<string, unknown>>(
  kernel: string,
  method: string,
  witness: KernelWitness<TArgs>,
  handles?: Record<string, string>
): PreparedKernelCall {
  return {
    kernel,
    method,
    args: serializeWitnessValue(witness.args) as Record<string, string>,
    expectedCommitment: witness.commitment.toString(),
    ...(handles ? { handles } : {})
  };
}

function prepareProgramCall<TPublicInput extends Record<string, unknown>>(
  program: string,
  witness: ProgramWitness<TPublicInput>
): PreparedProgramCall {
  return {
    program,
    publicInput: serializeWitnessValue(witness.publicInput),
    privateInputs: witness.privateInputs.map((input) => serializeWitnessValue(input)),
    expectedDigest: witness.expectedDigest.toString()
  };
}

function severityRank(value: PrivacyExceptionQueueItem["severity"]) {
  if (value === "high") {
    return 3;
  }
  if (value === "medium") {
    return 2;
  }
  return 1;
}

function statusRank(value: PrivacyExceptionQueueItem["status"]) {
  if (value === "approved") {
    return 3;
  }
  if (value === "pending") {
    return 2;
  }
  return 1;
}

function toNanomina(value: string): bigint {
  const [whole = "0", fractional = ""] = value.split(".");
  return BigInt(whole) * 1_000_000_000n + BigInt((fractional + "000000000").slice(0, 9));
}

function bigintToString(value: bigint): string {
  return value.toString();
}

function slot(base: bigint, offset: number): string {
  return (base + BigInt(offset)).toString();
}

function composeRoot(parts: unknown[]): string {
  let root = emptyRoot();

  parts.forEach((part, index) => {
    root = appendRoot(root, fieldFromValue(part), fieldFromValue(index));
  });

  return root.toString();
}

export function buildDefaultRuntimeLiveSessionTurnFlowInput(
  options: BuildDefaultRuntimeLiveSessionTurnFlowInputOptions = {}
): RuntimeLiveSessionTurnFlowInput {
  const flowKind = options.flowKind ?? "first-turn";
  const trustMode = TRUST_MODE_PRESETS.find((mode) => mode.id === (options.trustModeId ?? "private")) ?? TRUST_MODE_PRESETS[0]!;
  const slug = randomUUID().replace(/-/g, "").slice(0, 12);
  const requestedAtIso = options.requestedAtIso ?? new Date().toISOString();
  const baseSlot = String(Math.floor(Date.parse(requestedAtIso) / 1000));
  const jobId = options.jobId ?? `live_flow_${slug}`;
  const sessionId = options.sessionId ?? `session_live_${slug}`;
  const turnId = options.turnId ?? `turn_live_${slug}`;
  const requestorKey = options.requestorKey ?? options.walletPublicKey ?? DEFAULT_WALLET_PUBLIC_KEY;

  return {
    jobId,
    flowKind,
    scenarioId: options.scenarioId ?? `runtime-${flowKind}-${trustMode.id}-${slug}`,
    sessionId,
    turnId,
    ...(options.sourceTurnId ? { sourceTurnId: options.sourceTurnId } : {}),
    ...(options.sourceDisclosureId ? { sourceDisclosureId: options.sourceDisclosureId } : {}),
    ...(options.abortReason ? { abortReason: options.abortReason } : {}),
    ...(options.revocationReason ? { revocationReason: options.revocationReason } : {}),
    ...(options.refundAmountMina ? { refundAmountMina: options.refundAmountMina } : {}),
    tenantId: DEFAULT_TENANT_ID,
    workspaceId: DEFAULT_WORKSPACE_ID,
    walletId: options.walletId ?? DEFAULT_WALLET_ID,
    walletPublicKey: options.walletPublicKey ?? DEFAULT_WALLET_PUBLIC_KEY,
    requestorKey,
    workerId: options.workerId ?? `worker_${trustMode.id}_${slug.slice(-6)}`,
    baseSlot,
    trustModeId: trustMode.id,
    trustModeMaxSpendMina: trustMode.maxSpendMina,
    sponsoredRemainingMina: options.sponsoredRemainingMina ?? "0.50",
    requestedSpendMina: options.requestedSpendMina ?? trustMode.maxSpendMina,
    defaultArtifactVisibility: trustMode.defaultArtifactVisibility,
    operatorVisible: trustMode.operatorVisible,
    providerVisible: trustMode.providerVisible,
    proofLevel: trustMode.proofLevel,
    guardians: DEFAULT_GUARDIANS.map((guardian) => ({ ...guardian })),
    governancePolicy: { ...DEFAULT_GOVERNANCE_POLICY },
    privacyExceptions: []
  };
}

function composeOriginProofRoot(input: {
  sessionId: string;
  turnId: string;
  stepId: string;
  host: string;
  trustModeId: TrustModeId;
  proofLevel: RuntimeLiveSessionTurnFlowInput["proofLevel"];
  audience: string;
  reviewAudience: string;
}): string {
  return composeRoot([
    {
      sessionId: input.sessionId,
      turnId: input.turnId,
      stepId: input.stepId,
      host: input.host
    },
    {
      trustModeId: input.trustModeId,
      proofLevel: input.proofLevel,
      audience: input.audience,
      reviewAudience: input.reviewAudience
    }
  ]);
}

function selectPrivacyException(input: RuntimeLiveSessionTurnFlowInput): PrivacyExceptionQueueItem {
  const active = input.privacyExceptions
    .filter((item) => item.status !== "expired")
    .sort(
      (left, right) =>
        statusRank(right.status) - statusRank(left.status) ||
        severityRank(right.severity) - severityRank(left.severity) ||
        left.id.localeCompare(right.id)
    );

  if (active[0]) {
    return active[0];
  }

  return {
    id: `privacy_exception_${input.jobId}`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    title: "Governed enterprise disclosure window",
    audience: input.governancePolicy.reviewAudience,
    duration: `${input.governancePolicy.autoExpiryHours}h`,
    scope: input.providerVisible ? "Redacted provider fallback plus receipts" : "Selective audit disclosure only",
    reason: "Runtime-generated approval bundle for the live ClawZ session-turn flow.",
    severity: "medium",
    status: "pending",
    requiredApprovals: Math.max(1, input.governancePolicy.requiredApprovals),
    approvals: [],
    expiresAtIso: new Date().toISOString()
  };
}

function resolveRequiredApprovals(input: RuntimeLiveSessionTurnFlowInput) {
  const activeGuardians = input.guardians.filter((guardian) => guardian.status === "active");
  const requiredApprovals = Math.max(
    1,
    Math.min(input.governancePolicy.requiredApprovals, Math.max(activeGuardians.length, 1))
  );

  return {
    activeGuardians,
    requiredApprovals
  };
}

function resolveReservedAmount(input: RuntimeLiveSessionTurnFlowInput): bigint {
  const requestedSpend = toNanomina(input.requestedSpendMina ?? input.trustModeMaxSpendMina);
  const remainingSpend = toNanomina(input.sponsoredRemainingMina);
  const trustBudget = toNanomina(input.trustModeMaxSpendMina);

  return [requestedSpend, remainingSpend, trustBudget].reduce(
    (lowest, current) => (current < lowest ? current : lowest),
    requestedSpend
  );
}

export function buildRuntimeLiveSessionTurnWitnessPlan(
  input: RuntimeLiveSessionTurnFlowInput
): DeploymentWitnessPlan {
  const { activeGuardians, requiredApprovals } = resolveRequiredApprovals(input);
  const selectedException = selectPrivacyException(input);
  const baseSlot = BigInt(input.baseSlot);

  const reservedAmount = resolveReservedAmount(input);
  const payoutAmount = (reservedAmount * 72n) / 100n;
  const feeAmount = reservedAmount / 10n;
  const refundedAmount = reservedAmount - payoutAmount - feeAmount;
  const observedApprovals = Math.max(requiredApprovals, selectedException.approvals.length);

  const participantRoot = composeRoot([
    {
      guardians: activeGuardians.map((guardian) => ({
        guardianId: guardian.guardianId,
        role: guardian.role
      })),
      threshold: requiredApprovals
    },
    {
      trustModeId: input.trustModeId,
      reviewAudience: input.governancePolicy.reviewAudience
    }
  ]);
  const routingPolicyHash = composeRoot([
    {
      trustModeId: input.trustModeId,
      operatorVisible: input.operatorVisible,
      providerVisible: input.providerVisible,
      proofLevel: input.proofLevel
    },
    {
      workspaceId: input.workspaceId,
      reviewAudience: input.governancePolicy.reviewAudience
    }
  ]);
  const keyRefHash = composeRoot([
    {
      walletId: input.walletId,
      walletPublicKey: input.walletPublicKey
    },
    {
      jobId: input.jobId
    }
  ]);
  const channelBindingHash = composeRoot([
    {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId
    },
    "web-console"
  ]);
  const approvalScopeHash = composeRoot([
    {
      exceptionId: selectedException.id,
      scope: selectedException.scope,
      reason: selectedException.reason
    },
    {
      visibility: input.defaultArtifactVisibility,
      providerVisible: input.providerVisible
    }
  ]);
  const approvalPolicyHash = composeRoot([
    {
      trustModeId: input.trustModeId,
      proofLevel: input.proofLevel
    },
    {
      requiredApprovals,
      reviewAudience: input.governancePolicy.reviewAudience
    }
  ]);
  const committeeId = composeRoot([
    {
      sessionId: input.sessionId,
      guardians: activeGuardians.map((guardian) => guardian.guardianId)
    },
    {
      threshold: requiredApprovals
    }
  ]);
  const disclosureScopeHash = composeRoot([
    {
      sessionId: input.sessionId,
      turnId: input.turnId
    },
    {
      scope: selectedException.scope,
      audience: selectedException.audience
    }
  ]);
  const legalBasisHash = composeRoot([
    selectedException.reason,
    {
      reviewAudience: input.governancePolicy.reviewAudience,
      approvals: selectedException.approvals.map((approval) => ({
        actorId: approval.actorId,
        actorRole: approval.actorRole
      }))
    }
  ]);
  const audienceHash = composeRoot([
    {
      audience: selectedException.audience,
      trustModeId: input.trustModeId
    },
    {
      operatorVisible: input.operatorVisible,
      providerVisible: input.providerVisible
    }
  ]);
  const retentionHash = composeRoot([
    {
      duration: selectedException.duration,
      autoExpiryHours: input.governancePolicy.autoExpiryHours
    },
    {
      defaultArtifactVisibility: input.defaultArtifactVisibility
    }
  ]);
  const inputMessageRoot = composeRoot([
    {
      sessionId: input.sessionId,
      turnId: input.turnId,
      tenantId: input.tenantId
    },
    {
      trustModeId: input.trustModeId,
      exceptionId: selectedException.id
    }
  ]);
  const artifactRoot = composeRoot([
    {
      sessionId: input.sessionId,
      turnId: input.turnId,
      visibility: input.defaultArtifactVisibility
    },
    {
      proofLevel: input.proofLevel,
      operatorVisible: input.operatorVisible,
      providerVisible: input.providerVisible
    }
  ]);
  const transcriptRoot = composeRoot([
    {
      sessionId: input.sessionId,
      turnId: input.turnId,
      workerId: input.workerId
    },
    {
      approvalAudience: selectedException.audience,
      reviewAudience: input.governancePolicy.reviewAudience
    }
  ]);
  const finalTurnRoot = composeRoot([
    artifactRoot,
    transcriptRoot,
    {
      turnId: input.turnId,
      visibility: input.defaultArtifactVisibility
    }
  ]);
  const approvalId = `${input.turnId}:approval:${input.jobId}`;
  const decisionId = `${input.turnId}:decision:${input.jobId}`;
  const reservationId = `${input.turnId}:reservation:${input.jobId}`;
  const leaseId = `${input.turnId}:lease:${input.jobId}`;
  const disclosureId = `${input.turnId}:disclosure:${input.jobId}`;

  const createSessionWitness = buildCreateSessionWitness({
    header: {
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      agentId: `agent_clawz_${input.trustModeId}`,
      routingPolicyHash,
      keyRefHash,
      createdAtSlot: slot(baseSlot, 0),
      channelBindingHash
    },
    participantRoot
  });

  const acquireLeaseWitness = buildAcquireLeaseWitness({
    turnId: input.turnId,
    sessionId: input.sessionId,
    leaseId,
    workerId: input.workerId,
    workerBond: bigintToString(toNanomina("0.075")),
    leaseExpiresAtSlot: slot(baseSlot, 9)
  });

  const requestApprovalWitness = buildRequestApprovalWitness({
    approvalId,
    turnId: input.turnId,
    requesterKey: input.requestorKey ?? input.walletPublicKey,
    workerId: input.workerId,
    policyHash: approvalPolicyHash,
    dangerClass: "privacy-exception",
    scopeHash: approvalScopeHash,
    privacyExceptionHash: selectedException.id,
    expiresAtSlot: slot(baseSlot, 10)
  });

  const grantApprovalWitness = buildGrantApprovalWitness({
    request: requestApprovalWitness,
    decisionId,
    committeeId,
    quorum: String(requiredApprovals),
    observedApprovals: String(observedApprovals),
    validUntilSlot: slot(baseSlot, 24)
  });

  const reserveBudgetWitness = buildReserveBudgetWitness(
    {
      reservationId,
      turnId: input.turnId,
      payerKey: input.walletPublicKey,
      maxSpend: bigintToString(reservedAmount),
      refundAddress: input.walletPublicKey,
      nullifier: composeRoot([
        {
          walletId: input.walletId,
          sessionId: input.sessionId,
          turnId: input.turnId
        },
        input.jobId
      ])
    },
    "1"
  );

  const beginTurnWitness = buildBeginTurnWitness({
    turnId: input.turnId,
    sessionId: input.sessionId,
    leaseId,
    workerId: input.workerId,
    inputMessageRoot,
    budgetReservationHash: reserveBudgetWitness.commitment,
    approvalBundleHash: grantApprovalWitness.commitment,
    startedAtSlot: slot(baseSlot, 3)
  });

  const commitOutputWitness = buildCommitOutputWitness({
    turnId: input.turnId,
    outputDigest: composeRoot([
      {
        sessionId: input.sessionId,
        turnId: input.turnId,
        trustModeId: input.trustModeId
      },
      {
        proofLevel: input.proofLevel,
        audience: selectedException.audience
      }
    ]),
    artifactRoot,
    visibility: input.defaultArtifactVisibility,
    originProofRoot: composeOriginProofRoot({
      sessionId: input.sessionId,
      turnId: input.turnId,
      stepId: "browser_1",
      host: "docs.openclaw.ai",
      trustModeId: input.trustModeId,
      proofLevel: input.proofLevel,
      audience: selectedException.audience,
      reviewAudience: input.governancePolicy.reviewAudience
    })
  });

  const settleTurnWitness = buildSettleTurnWitness({
    turnId: input.turnId,
    reservedAmount: bigintToString(reservedAmount),
    payoutAmount: bigintToString(payoutAmount),
    refundedAmount: bigintToString(refundedAmount),
    feeAmount: bigintToString(feeAmount)
  });

  const finalizeTurnWitness = buildFinalizeTurnWitness({
    turnId: input.turnId,
    finalTurnRoot,
    settlementHash: settleTurnWitness.commitment,
    transcriptRoot,
    finalizedAtSlot: slot(baseSlot, 10)
  });

  const disclosureGrantWitness = buildGrantDisclosureWitness({
    disclosureId,
    sessionId: input.sessionId,
    requestorKey: input.requestorKey ?? input.walletPublicKey,
    artifactRef: artifactRoot,
    scopeHash: disclosureScopeHash,
    legalBasisHash,
    expiresAtSlot: slot(baseSlot, Math.max(input.governancePolicy.autoExpiryHours, 12)),
    audienceHash
  });

  const approvalPolicyProof = buildApprovalPolicyProofWitness({
    request: requestApprovalWitness,
    decisionId,
    committeeId,
    minimumApprovals: String(requiredApprovals),
    observedApprovals: String(observedApprovals),
    validUntilSlot: slot(baseSlot, 24),
    currentSlot: slot(baseSlot, 4)
  });
  const disclosureScopeProof = buildDisclosureScopeProofWitness({
    grant: disclosureGrantWitness,
    currentSlot: slot(baseSlot, 4)
  });
  const budgetProof = buildBudgetConservationProofWitness({
    settlement: settleTurnWitness
  });

  return {
    scenarioId: input.scenarioId ?? `runtime-live-${input.trustModeId}`,
    contracts: [
      prepareKernelCall("SessionKernel", "createSession", createSessionWitness),
      prepareKernelCall("TurnKernel", "acquireLease", acquireLeaseWitness, { leaseId }),
      prepareKernelCall("ApprovalKernel", "requestApproval", requestApprovalWitness, { approvalId }),
      prepareKernelCall("ApprovalKernel", "grantApproval", grantApprovalWitness),
      prepareKernelCall("EscrowKernel", "reserveBudget", reserveBudgetWitness, { reservationId }),
      prepareKernelCall("TurnKernel", "beginTurn", beginTurnWitness),
      prepareKernelCall("TurnKernel", "commitOutput", commitOutputWitness),
      prepareKernelCall("EscrowKernel", "settleTurn", settleTurnWitness),
      prepareKernelCall("TurnKernel", "finalizeTurn", finalizeTurnWitness),
      prepareKernelCall("DisclosureKernel", "grantDisclosure", disclosureGrantWitness, { disclosureId })
    ],
    proofs: [
      prepareProgramCall("ApprovalPolicyProgram", approvalPolicyProof),
      prepareProgramCall("DisclosureScopeProgram", disclosureScopeProof),
      prepareProgramCall("BudgetConservationProgram", budgetProof)
    ]
  };
}

export function buildRuntimeNextTurnWitnessPlan(
  input: RuntimeLiveSessionTurnFlowInput
): DeploymentWitnessPlan {
  const { activeGuardians, requiredApprovals } = resolveRequiredApprovals(input);
  const selectedException = selectPrivacyException(input);
  const baseSlot = BigInt(input.baseSlot);
  const reservedAmount = resolveReservedAmount(input);
  const payoutAmount = (reservedAmount * 70n) / 100n;
  const feeAmount = reservedAmount / 10n;
  const refundedAmount = reservedAmount - payoutAmount - feeAmount;
  const priorTurnId = input.sourceTurnId ?? `${input.sessionId}:turn_seed`;
  const checkpointId = `${priorTurnId}:checkpoint:${input.jobId}`;
  const reservationId = `${input.turnId}:reservation:${input.jobId}`;
  const approvalId = `${input.turnId}:approval:${input.jobId}`;
  const decisionId = `${input.turnId}:decision:${input.jobId}`;
  const leaseId = `${input.turnId}:lease:${input.jobId}`;
  const disclosureId = `${input.turnId}:disclosure:${input.jobId}`;
  const checkpointTranscriptRoot = composeRoot([
    {
      sessionId: input.sessionId,
      priorTurnId
    },
    {
      trustModeId: input.trustModeId,
      jobId: input.jobId
    }
  ]);
  const checkpointArtifactRoot = composeRoot([
    {
      priorTurnId,
      visibility: input.defaultArtifactVisibility
    },
    input.jobId
  ]);
  const checkpointWitness = buildCheckpointSessionWitness({
    sessionId: input.sessionId,
    checkpointId,
    transcriptRoot: checkpointTranscriptRoot,
    artifactRoot: checkpointArtifactRoot,
    checkpointSlot: slot(baseSlot, 0)
  });
  const approvalScopeHash = composeRoot([
    {
      turnId: input.turnId,
      scope: selectedException.scope
    },
    {
      audience: selectedException.audience,
      proofLevel: input.proofLevel
    }
  ]);
  const approvalPolicyHash = composeRoot([
    {
      trustModeId: input.trustModeId,
      turnKind: "next-turn"
    },
    {
      requiredApprovals,
      workspaceId: input.workspaceId
    }
  ]);
  const committeeId = composeRoot([
    {
      sessionId: input.sessionId,
      guardians: activeGuardians.map((guardian) => guardian.guardianId)
    },
    "next-turn"
  ]);
  const reserveBudgetWitness = buildReserveBudgetWitness(
    {
      reservationId,
      turnId: input.turnId,
      payerKey: input.walletPublicKey,
      maxSpend: bigintToString(reservedAmount),
      refundAddress: input.walletPublicKey,
      nullifier: composeRoot([
        {
          sessionId: input.sessionId,
          turnId: input.turnId,
          priorTurnId
        },
        input.jobId
      ])
    },
    "2"
  );
  const requestApprovalWitness = buildRequestApprovalWitness({
    approvalId,
    turnId: input.turnId,
    requesterKey: input.requestorKey ?? input.walletPublicKey,
    workerId: input.workerId,
    policyHash: approvalPolicyHash,
    dangerClass: "privacy-exception",
    scopeHash: approvalScopeHash,
    privacyExceptionHash: selectedException.id,
    expiresAtSlot: slot(baseSlot, 12)
  });
  const grantApprovalWitness = buildGrantApprovalWitness({
    request: requestApprovalWitness,
    decisionId,
    committeeId,
    quorum: String(requiredApprovals),
    observedApprovals: String(Math.max(requiredApprovals, selectedException.approvals.length)),
    validUntilSlot: slot(baseSlot, 24)
  });
  const acquireLeaseWitness = buildAcquireLeaseWitness({
    turnId: input.turnId,
    sessionId: input.sessionId,
    leaseId,
    workerId: input.workerId,
    workerBond: bigintToString(toNanomina("0.050")),
    leaseExpiresAtSlot: slot(baseSlot, 14)
  });
  const artifactRoot = composeRoot([
    {
      sessionId: input.sessionId,
      turnId: input.turnId,
      turnKind: "next-turn"
    },
    {
      visibility: input.defaultArtifactVisibility,
      proofLevel: input.proofLevel
    }
  ]);
  const transcriptRoot = composeRoot([
    {
      sessionId: input.sessionId,
      priorTurnId,
      turnId: input.turnId
    },
    {
      audience: selectedException.audience,
      reviewAudience: input.governancePolicy.reviewAudience
    }
  ]);
  const beginTurnWitness = buildBeginTurnWitness({
    turnId: input.turnId,
    sessionId: input.sessionId,
    leaseId,
    workerId: input.workerId,
    inputMessageRoot: composeRoot([input.turnId, input.sessionId, "next-turn"]),
    budgetReservationHash: reserveBudgetWitness.commitment,
    approvalBundleHash: grantApprovalWitness.commitment,
    startedAtSlot: slot(baseSlot, 3)
  });
  const commitOutputWitness = buildCommitOutputWitness({
    turnId: input.turnId,
    outputDigest: composeRoot([artifactRoot, transcriptRoot, "next-turn"]),
    artifactRoot,
    visibility: input.defaultArtifactVisibility,
    originProofRoot: composeOriginProofRoot({
      sessionId: input.sessionId,
      turnId: input.turnId,
      stepId: "browser_1",
      host: "docs.openclaw.ai",
      trustModeId: input.trustModeId,
      proofLevel: input.proofLevel,
      audience: selectedException.audience,
      reviewAudience: input.governancePolicy.reviewAudience
    })
  });
  const settleTurnWitness = buildSettleTurnWitness({
    turnId: input.turnId,
    reservedAmount: bigintToString(reservedAmount),
    payoutAmount: bigintToString(payoutAmount),
    refundedAmount: bigintToString(refundedAmount),
    feeAmount: bigintToString(feeAmount)
  });
  const finalizeTurnWitness = buildFinalizeTurnWitness({
    turnId: input.turnId,
    finalTurnRoot: composeRoot([artifactRoot, transcriptRoot, input.turnId]),
    settlementHash: settleTurnWitness.commitment,
    transcriptRoot,
    finalizedAtSlot: slot(baseSlot, 10)
  });
  const disclosureGrantWitness = buildGrantDisclosureWitness({
    disclosureId,
    sessionId: input.sessionId,
    requestorKey: input.requestorKey ?? input.walletPublicKey,
    artifactRef: artifactRoot,
    scopeHash: composeRoot([selectedException.scope, input.turnId, "next-turn"]),
    legalBasisHash: composeRoot([selectedException.reason, "next-turn", input.governancePolicy.reviewAudience]),
    expiresAtSlot: slot(baseSlot, Math.max(input.governancePolicy.autoExpiryHours, 12)),
    audienceHash: composeRoot([selectedException.audience, input.trustModeId, "next-turn"])
  });
  const approvalPolicyProof = buildApprovalPolicyProofWitness({
    request: requestApprovalWitness,
    decisionId,
    committeeId,
    minimumApprovals: String(requiredApprovals),
    observedApprovals: String(Math.max(requiredApprovals, selectedException.approvals.length)),
    validUntilSlot: slot(baseSlot, 24),
    currentSlot: slot(baseSlot, 4)
  });
  const budgetProof = buildBudgetConservationProofWitness({
    settlement: settleTurnWitness
  });
  const disclosureScopeProof = buildDisclosureScopeProofWitness({
    grant: disclosureGrantWitness,
    currentSlot: slot(baseSlot, 4)
  });

  return {
    scenarioId: input.scenarioId ?? `runtime-next-turn-${input.trustModeId}`,
    contracts: [
      prepareKernelCall("SessionKernel", "checkpointSession", checkpointWitness, { checkpointId }),
      prepareKernelCall("TurnKernel", "acquireLease", acquireLeaseWitness, { leaseId }),
      prepareKernelCall("ApprovalKernel", "requestApproval", requestApprovalWitness, { approvalId }),
      prepareKernelCall("ApprovalKernel", "grantApproval", grantApprovalWitness),
      prepareKernelCall("EscrowKernel", "reserveBudget", reserveBudgetWitness, { reservationId }),
      prepareKernelCall("TurnKernel", "beginTurn", beginTurnWitness),
      prepareKernelCall("TurnKernel", "commitOutput", commitOutputWitness),
      prepareKernelCall("EscrowKernel", "settleTurn", settleTurnWitness),
      prepareKernelCall("TurnKernel", "finalizeTurn", finalizeTurnWitness),
      prepareKernelCall("DisclosureKernel", "grantDisclosure", disclosureGrantWitness, { disclosureId })
    ],
    proofs: [
      prepareProgramCall("ApprovalPolicyProgram", approvalPolicyProof),
      prepareProgramCall("DisclosureScopeProgram", disclosureScopeProof),
      prepareProgramCall("BudgetConservationProgram", budgetProof)
    ]
  };
}

export function buildRuntimeAbortTurnWitnessPlan(
  input: RuntimeLiveSessionTurnFlowInput
): DeploymentWitnessPlan {
  const baseSlot = BigInt(input.baseSlot);
  const selectedException = selectPrivacyException(input);
  const exceptionId = `${input.turnId}:abort-exception:${input.jobId}`;
  const requestPrivacyExceptionWitness = buildRequestPrivacyExceptionWitness({
    exceptionId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    audience: selectedException.audience,
    severity: selectedException.severity,
    expirySlot: slot(baseSlot, 6)
  });
  const abortTurnWitness = buildAbortTurnWitness({
    turnId: input.turnId,
    abortReason: input.abortReason ?? "governed-abort-requested",
    reporterKey: input.requestorKey ?? input.walletPublicKey,
    abortedAtSlot: slot(baseSlot, 2)
  });

  return {
    scenarioId: input.scenarioId ?? `runtime-abort-${input.trustModeId}`,
    contracts: [
      prepareKernelCall("ApprovalKernel", "requestPrivacyException", requestPrivacyExceptionWitness, {
        exceptionId
      }),
      prepareKernelCall("TurnKernel", "abortTurn", abortTurnWitness, {
        abortReason: input.abortReason ?? "governed-abort-requested"
      })
    ],
    proofs: []
  };
}

export function buildRuntimeRefundTurnPlan(
  input: RuntimeLiveSessionTurnFlowInput
): DeploymentWitnessPlan {
  const refundAmount = toNanomina(input.refundAmountMina ?? input.requestedSpendMina ?? "0.05");
  const boundedRefund = [refundAmount, resolveReservedAmount(input)].reduce(
    (lowest, current) => (current < lowest ? current : lowest),
    refundAmount
  );
  const refundId = `${input.turnId}:refund:${input.jobId}`;
  const refundWitness = buildRefundTurnWitness({
    turnId: input.turnId,
    refundId,
    refundAmount: bigintToString(boundedRefund),
    nullifier: composeRoot([
      {
        sessionId: input.sessionId,
        turnId: input.turnId,
        walletId: input.walletId
      },
      "refund"
    ])
  });

  return {
    scenarioId: input.scenarioId ?? `runtime-refund-${input.trustModeId}`,
    contracts: [
      prepareKernelCall("EscrowKernel", "refundTurn", refundWitness, {
        refundId,
        refundAmountMina: input.refundAmountMina ?? input.requestedSpendMina ?? "0.05"
      })
    ],
    proofs: []
  };
}

export function buildRuntimeDisclosureRevocationPlan(
  input: RuntimeLiveSessionTurnFlowInput
): DeploymentWitnessPlan {
  const disclosureId = input.sourceDisclosureId ?? `${input.turnId}:disclosure:${input.jobId}`;
  const revocationReason = input.revocationReason ?? "governed-review-window-expired";
  const revokeWitness = buildRevokeDisclosureWitness({
    disclosureId,
    revocationReason,
    actorKey: input.requestorKey ?? input.walletPublicKey
  });

  return {
    scenarioId: input.scenarioId ?? `runtime-disclosure-revoke-${input.trustModeId}`,
    contracts: [
      prepareKernelCall("DisclosureKernel", "revokeDisclosure", revokeWitness, {
        disclosureId,
        revocationReason
      })
    ],
    proofs: []
  };
}

export function buildRuntimeFlowWitnessPlan(
  input: RuntimeLiveSessionTurnFlowInput
): DeploymentWitnessPlan {
  const flowKind = input.flowKind ?? "first-turn";

  if (flowKind === "next-turn") {
    return buildRuntimeNextTurnWitnessPlan(input);
  }

  if (flowKind === "abort-turn") {
    return buildRuntimeAbortTurnWitnessPlan(input);
  }

  if (flowKind === "refund-turn") {
    return buildRuntimeRefundTurnPlan(input);
  }

  if (flowKind === "revoke-disclosure") {
    return buildRuntimeDisclosureRevocationPlan(input);
  }

  return buildRuntimeLiveSessionTurnWitnessPlan(input);
}
