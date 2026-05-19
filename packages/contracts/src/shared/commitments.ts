import { Field, Poseidon, UInt64 } from "o1js";

export function buildRegistryAgentCommitment(
  agentIdHash: Field,
  ownerHash: Field,
  manifestHash: Field,
  pricingHash: Field,
  policyClassHash: Field,
  stakeAmount: UInt64,
  statusHash: Field,
  metadataHash: Field
): Field {
  return Poseidon.hash([
    agentIdHash,
    ownerHash,
    manifestHash,
    pricingHash,
    policyClassHash,
    stakeAmount.value,
    statusHash,
    metadataHash
  ]);
}

export function buildRegistryCapabilityCommitment(
  capabilityIdHash: Field,
  pluginIdHash: Field,
  manifestHash: Field,
  ioSchemaHash: Field,
  policyClassHash: Field,
  priceModelHash: Field,
  stakeAmount: UInt64,
  statusHash: Field
): Field {
  return Poseidon.hash([
    capabilityIdHash,
    pluginIdHash,
    manifestHash,
    ioSchemaHash,
    policyClassHash,
    priceModelHash,
    stakeAmount.value,
    statusHash
  ]);
}

export function buildRegistryPluginCommitment(
  pluginIdHash: Field,
  publisherHash: Field,
  manifestHash: Field,
  bondAmount: UInt64,
  statusHash: Field
): Field {
  return Poseidon.hash([pluginIdHash, publisherHash, manifestHash, bondAmount.value, statusHash]);
}

export function buildRegistryStakeCommitment(
  subjectIdHash: Field,
  amount: UInt64,
  contextHash: Field
): Field {
  return Poseidon.hash([subjectIdHash, amount.value, contextHash]);
}

export function buildRegistryCapabilityDisableCommitment(
  capabilityIdHash: Field,
  reasonHash: Field,
  actorHash: Field,
  disabledAtSlot: UInt64
): Field {
  return Poseidon.hash([capabilityIdHash, reasonHash, actorHash, disabledAtSlot.value]);
}

export function buildSessionCreateCommitment(
  sessionIdHash: Field,
  tenantIdHash: Field,
  agentIdHash: Field,
  routingPolicyHash: Field,
  participantRoot: Field,
  keyRefHash: Field,
  channelBindingHash: Field,
  createdAtSlot: UInt64
): Field {
  return Poseidon.hash([
    sessionIdHash,
    tenantIdHash,
    agentIdHash,
    routingPolicyHash,
    participantRoot,
    keyRefHash,
    channelBindingHash,
    createdAtSlot.value
  ]);
}

export function buildSessionKeyRotationCommitment(
  sessionIdHash: Field,
  oldKeyRefHash: Field,
  newKeyRefHash: Field,
  rotatedAtSlot: UInt64
): Field {
  return Poseidon.hash([sessionIdHash, oldKeyRefHash, newKeyRefHash, rotatedAtSlot.value]);
}

export function buildSessionCheckpointCommitment(
  sessionIdHash: Field,
  checkpointHash: Field,
  transcriptRoot: Field,
  artifactRoot: Field,
  checkpointSlot: UInt64
): Field {
  return Poseidon.hash([sessionIdHash, checkpointHash, transcriptRoot, artifactRoot, checkpointSlot.value]);
}

export function buildSessionCloseCommitment(
  sessionIdHash: Field,
  finalRoot: Field,
  disclosureRoot: Field,
  closedAtSlot: UInt64
): Field {
  return Poseidon.hash([sessionIdHash, finalRoot, disclosureRoot, closedAtSlot.value]);
}

export function buildTurnLeaseCommitment(
  turnIdHash: Field,
  sessionIdHash: Field,
  leaseIdHash: Field,
  workerIdHash: Field,
  workerBond: UInt64,
  leaseExpiresAtSlot: UInt64
): Field {
  return Poseidon.hash([
    turnIdHash,
    sessionIdHash,
    leaseIdHash,
    workerIdHash,
    workerBond.value,
    leaseExpiresAtSlot.value
  ]);
}

export function buildTurnHeaderCommitment(
  turnIdHash: Field,
  sessionIdHash: Field,
  leaseIdHash: Field,
  workerIdHash: Field,
  inputMessageRoot: Field,
  budgetReservationHash: Field,
  approvalBundleHash: Field,
  startedAtSlot: UInt64
): Field {
  return Poseidon.hash([
    turnIdHash,
    sessionIdHash,
    leaseIdHash,
    workerIdHash,
    inputMessageRoot,
    budgetReservationHash,
    approvalBundleHash,
    startedAtSlot.value
  ]);
}

export function buildTurnMessageBatchCommitment(
  turnIdHash: Field,
  messageBatchRoot: Field,
  batchIndex: UInt64
): Field {
  return Poseidon.hash([turnIdHash, messageBatchRoot, batchIndex.value]);
}

export function buildTurnToolReceiptCommitment(
  turnIdHash: Field,
  toolBatchRoot: Field,
  batchIndex: UInt64
): Field {
  return Poseidon.hash([turnIdHash, toolBatchRoot, batchIndex.value]);
}

export function buildTurnOutputCommitment(
  turnIdHash: Field,
  outputHash: Field,
  artifactRoot: Field,
  visibilityHash: Field,
  originProofRoot: Field
): Field {
  return Poseidon.hash([turnIdHash, outputHash, artifactRoot, visibilityHash, originProofRoot]);
}

export function buildTurnFinalizationCommitment(
  turnIdHash: Field,
  finalTurnRoot: Field,
  settlementHash: Field,
  transcriptRoot: Field,
  finalizedAtSlot: UInt64
): Field {
  return Poseidon.hash([turnIdHash, finalTurnRoot, settlementHash, transcriptRoot, finalizedAtSlot.value]);
}

export function buildTurnAbortCommitment(
  turnIdHash: Field,
  abortReasonHash: Field,
  reporterHash: Field,
  abortedAtSlot: UInt64
): Field {
  return Poseidon.hash([turnIdHash, abortReasonHash, reporterHash, abortedAtSlot.value]);
}

export function buildApprovalRequestCommitment(
  approvalIdHash: Field,
  policyHash: Field,
  scopeHash: Field,
  expirySlot: UInt64
): Field {
  return Poseidon.hash([approvalIdHash, policyHash, scopeHash, expirySlot.value]);
}

export function buildApprovalDecisionCommitment(
  requestLeaf: Field,
  decisionHash: Field,
  committeeDigest: Field,
  observedApprovals: UInt64,
  threshold: UInt64
): Field {
  return Poseidon.hash([requestLeaf, decisionHash, committeeDigest, observedApprovals.value, threshold.value]);
}

export function buildApprovalDelegationCommitment(
  delegatorHash: Field,
  delegateeHash: Field,
  scopeHash: Field,
  expirySlot: UInt64
): Field {
  return Poseidon.hash([delegatorHash, delegateeHash, scopeHash, expirySlot.value]);
}

export function buildPrivacyExceptionCommitment(
  exceptionIdHash: Field,
  scopeHash: Field,
  audienceHash: Field,
  severityHash: Field,
  expirySlot: UInt64
): Field {
  return Poseidon.hash([exceptionIdHash, scopeHash, audienceHash, severityHash, expirySlot.value]);
}

export function buildCommitteeDecisionCommitment(
  committeeHash: Field,
  decisionHash: Field,
  quorum: UInt64,
  observedVotes: UInt64,
  validUntilSlot: UInt64
): Field {
  return Poseidon.hash([committeeHash, decisionHash, quorum.value, observedVotes.value, validUntilSlot.value]);
}

export function buildDisclosureGrantCommitment(
  disclosureIdHash: Field,
  scopeHash: Field,
  audienceHash: Field,
  legalBasisHash: Field,
  retentionHash: Field,
  expirySlot: UInt64
): Field {
  return Poseidon.hash([
    disclosureIdHash,
    scopeHash,
    audienceHash,
    legalBasisHash,
    retentionHash,
    expirySlot.value
  ]);
}

export function buildDisclosureRevocationCommitment(
  disclosureIdHash: Field,
  revocationHash: Field,
  actorHash: Field
): Field {
  return Poseidon.hash([disclosureIdHash, revocationHash, actorHash]);
}

export function buildCreditCommitment(
  ownerHash: Field,
  depositIdHash: Field,
  amount: UInt64,
  policyHash: Field
): Field {
  return Poseidon.hash([ownerHash, depositIdHash, amount.value, policyHash]);
}

export function buildBudgetReservationCommitment(
  turnIdHash: Field,
  reservationHash: Field,
  nullifierHash: Field,
  reservedAmount: UInt64,
  budgetEpoch: UInt64
): Field {
  return Poseidon.hash([
    turnIdHash,
    reservationHash,
    nullifierHash,
    reservedAmount.value,
    budgetEpoch.value
  ]);
}

export function buildBudgetSettlementCommitment(
  turnIdHash: Field,
  reservedAmount: UInt64,
  payoutAmount: UInt64,
  refundedAmount: UInt64,
  feeAmount: UInt64
): Field {
  return Poseidon.hash([
    turnIdHash,
    reservedAmount.value,
    payoutAmount.value,
    refundedAmount.value,
    feeAmount.value
  ]);
}

export function buildRefundCommitment(
  turnIdHash: Field,
  refundIdHash: Field,
  refundAmount: UInt64,
  nullifierHash: Field
): Field {
  return Poseidon.hash([turnIdHash, refundIdHash, refundAmount.value, nullifierHash]);
}
