import { Field, Poseidon, UInt64 } from "o1js";

import type {
  AgentLeaf,
  ApprovalLeaf,
  BudgetReservationLeaf,
  CapabilityLeaf,
  DisclosureLeaf,
  SessionHeaderLeaf,
  StableJsonValue
} from "@clawz/protocol";
import { canonicalDigest } from "@clawz/protocol";

import {
  buildApprovalDecisionCommitment,
  buildApprovalDelegationCommitment,
  buildApprovalRequestCommitment,
  buildBudgetReservationCommitment,
  buildBudgetSettlementCommitment,
  buildCommitteeDecisionCommitment,
  buildCreditCommitment,
  buildDisclosureGrantCommitment,
  buildDisclosureRevocationCommitment,
  buildPrivacyExceptionCommitment,
  buildRefundCommitment,
  buildRegistryAgentCommitment,
  buildRegistryCapabilityCommitment,
  buildRegistryCapabilityDisableCommitment,
  buildRegistryPluginCommitment,
  buildRegistryStakeCommitment,
  buildSessionCheckpointCommitment,
  buildSessionCloseCommitment,
  buildSessionCreateCommitment,
  buildSessionKeyRotationCommitment,
  buildTurnAbortCommitment,
  buildTurnFinalizationCommitment,
  buildTurnHeaderCommitment,
  buildTurnLeaseCommitment,
  buildTurnMessageBatchCommitment,
  buildTurnOutputCommitment,
  buildTurnToolReceiptCommitment
} from "./commitments.js";

export type UInt64Like = string | number | bigint;

export interface PluginRegistrationInput {
  pluginId: string;
  publisherKey: string;
  manifestHash: string;
  bondAmount: UInt64Like;
  status: "active" | "disabled" | "pending";
}

export interface DisableCapabilityWitnessInput {
  capabilityId: string;
  reason: string;
  actorKey: string;
  disabledAtSlot: UInt64Like;
}

export interface SessionCreateWitnessInput {
  header: SessionHeaderLeaf;
  participantRoot: unknown;
}

export interface SessionKeyRotationInput {
  sessionId: string;
  oldKeyRef: unknown;
  newKeyRef: unknown;
  rotatedAtSlot: UInt64Like;
}

export interface SessionCheckpointInput {
  sessionId: string;
  checkpointId: string;
  transcriptRoot: unknown;
  artifactRoot: unknown;
  checkpointSlot: UInt64Like;
}

export interface SessionCloseInput {
  sessionId: string;
  finalRoot: unknown;
  disclosureRoot: unknown;
  closedAtSlot: UInt64Like;
}

export interface TurnLeaseInput {
  turnId: string;
  sessionId: string;
  leaseId: string;
  workerId: string;
  workerBond: UInt64Like;
  leaseExpiresAtSlot: UInt64Like;
}

export interface TurnStartWitnessInput {
  turnId: string;
  sessionId: string;
  leaseId: string;
  workerId: string;
  inputMessageRoot: unknown;
  budgetReservationHash: unknown;
  approvalBundleHash: unknown;
  startedAtSlot: UInt64Like;
}

export interface TurnBatchInput {
  turnId: string;
  batchRoot: unknown;
  batchIndex: UInt64Like;
}

export interface TurnOutputInput {
  turnId: string;
  outputDigest: unknown;
  artifactRoot: unknown;
  visibility: string;
  originProofRoot: unknown;
}

export interface TurnFinalizeInput {
  turnId: string;
  finalTurnRoot: unknown;
  settlementHash: unknown;
  transcriptRoot: unknown;
  finalizedAtSlot: UInt64Like;
}

export interface TurnAbortInput {
  turnId: string;
  abortReason: string;
  reporterKey: string;
  abortedAtSlot: UInt64Like;
}

export interface ApprovalDecisionInput {
  request: KernelWitness<{
    approvalIdHash: Field;
    policyHash: Field;
    scopeHash: Field;
    expirySlot: UInt64;
  }>;
  decisionId: string;
  committeeId: string;
  quorum: UInt64Like;
  observedApprovals: UInt64Like;
  validUntilSlot: UInt64Like;
}

export interface ApprovalDelegationInput {
  delegatorKey: string;
  delegateeKey: string;
  scope: unknown;
  expirySlot: UInt64Like;
}

export interface PrivacyExceptionWitnessInput {
  exceptionId: string;
  sessionId: string;
  turnId: string;
  audience: string;
  severity: "low" | "medium" | "high";
  expirySlot: UInt64Like;
}

export interface DisclosureRevocationInput {
  disclosureId: string;
  revocationReason: string;
  actorKey: string;
}

export interface CreditDepositInput {
  ownerKey: string;
  depositId: string;
  amount: UInt64Like;
  policyHash: string;
}

export interface BudgetSettlementInput {
  turnId: string;
  reservedAmount: UInt64Like;
  payoutAmount: UInt64Like;
  refundedAmount: UInt64Like;
  feeAmount: UInt64Like;
}

export interface RefundInput {
  turnId: string;
  refundId: string;
  refundAmount: UInt64Like;
  nullifier: string;
}

export interface CommitteeProofInput {
  committeeId: string;
  decisionId: string;
  quorum: UInt64Like | UInt64;
  observedVotes: UInt64Like | UInt64;
  validUntilSlot: UInt64Like | UInt64;
  currentSlot: UInt64Like | UInt64;
}

export interface ApprovalPolicyProofInput {
  request: KernelWitness<{
    approvalIdHash: Field;
    policyHash: Field;
    scopeHash: Field;
    expirySlot: UInt64;
  }>;
  decisionId: string;
  committeeId: string;
  minimumApprovals: UInt64Like;
  observedApprovals: UInt64Like;
  validUntilSlot: UInt64Like;
  currentSlot: UInt64Like;
}

export interface DisclosureScopeProofInput {
  grant: KernelWitness<{
    disclosureIdHash: Field;
    scopeHash: Field;
    audienceHash: Field;
    legalBasisHash: Field;
    retentionHash: Field;
    expirySlot: UInt64;
  }>;
  currentSlot: UInt64Like;
}

export interface BudgetProofInput {
  settlement: KernelWitness<{
    turnIdHash: Field;
    reservedAmount: UInt64;
    payoutAmount: UInt64;
    refundedAmount: UInt64;
    feeAmount: UInt64;
  }>;
}

export interface KernelWitness<TArgs extends Record<string, unknown>> {
  args: TArgs;
  commitment: Field;
}

export interface ProgramWitness<TPublicInput extends Record<string, unknown>> {
  publicInput: TPublicInput;
  privateInputs: unknown[];
  expectedDigest: Field;
}

export interface PreparedKernelCall {
  kernel: string;
  method: string;
  args: StableJsonValue;
  expectedCommitment: string;
  handles?: Record<string, string>;
}

export interface PreparedProgramCall {
  program: string;
  publicInput: StableJsonValue;
  privateInputs: StableJsonValue[];
  expectedDigest: string;
}

export interface DeploymentWitnessPlan {
  scenarioId: string;
  contracts: PreparedKernelCall[];
  proofs: PreparedProgramCall[];
}

const ZERO_FIELD = Field.fromJSON("0");

function digestToField(value: unknown): Field {
  const digest = canonicalDigest(value);
  const chunks = digest.fieldChunks.map((chunk) => Field.fromJSON(chunk));
  return Poseidon.hash(chunks.length > 0 ? chunks : [ZERO_FIELD]);
}

export function fieldFromValue(value: unknown): Field {
  if (value instanceof Field) {
    return value;
  }

  if (value instanceof UInt64) {
    return value.value;
  }

  return digestToField(value);
}

export function uint64FromValue(value: UInt64Like | UInt64): UInt64 {
  return value instanceof UInt64 ? value : UInt64.from(value);
}

export function serializeWitnessValue(value: unknown): StableJsonValue {
  if (value instanceof Field) {
    return value.toString();
  }

  if (value instanceof UInt64) {
    return value.value.toString();
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeWitnessValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .map(([key, nested]) => [key, serializeWitnessValue(nested)])
    ) as StableJsonValue;
  }

  return value as StableJsonValue;
}

function prepareKernelCall<TArgs extends Record<string, unknown>>(
  kernel: string,
  method: string,
  witness: KernelWitness<TArgs>
): PreparedKernelCall {
  return {
    kernel,
    method,
    args: serializeWitnessValue(witness.args),
    expectedCommitment: witness.commitment.toString()
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

export function buildRegisterAgentWitness(agent: AgentLeaf): KernelWitness<{
  agentIdHash: Field;
  ownerHash: Field;
  manifestHash: Field;
  pricingHash: Field;
  policyClassHash: Field;
  stakeAmount: UInt64;
  statusHash: Field;
  metadataHash: Field;
}> {
  const args = {
    agentIdHash: fieldFromValue(agent.agentId),
    ownerHash: fieldFromValue(agent.ownerKey),
    manifestHash: fieldFromValue(agent.manifestHash),
    pricingHash: fieldFromValue(agent.pricingHash),
    policyClassHash: fieldFromValue(agent.policyClassHash),
    stakeAmount: uint64FromValue(agent.stakeAmount),
    statusHash: fieldFromValue(agent.status),
    metadataHash: fieldFromValue(agent.metadataHash)
  };

  return {
    args,
    commitment: buildRegistryAgentCommitment(
      args.agentIdHash,
      args.ownerHash,
      args.manifestHash,
      args.pricingHash,
      args.policyClassHash,
      args.stakeAmount,
      args.statusHash,
      args.metadataHash
    )
  };
}

export function buildRegisterCapabilityWitness(capability: CapabilityLeaf): KernelWitness<{
  capabilityIdHash: Field;
  pluginIdHash: Field;
  manifestHash: Field;
  ioSchemaHash: Field;
  policyClassHash: Field;
  priceModelHash: Field;
  stakeAmount: UInt64;
  statusHash: Field;
}> {
  const args = {
    capabilityIdHash: fieldFromValue(capability.capabilityId),
    pluginIdHash: fieldFromValue(capability.pluginId),
    manifestHash: fieldFromValue(capability.manifestHash),
    ioSchemaHash: fieldFromValue(capability.ioSchemaHash),
    policyClassHash: fieldFromValue(capability.policyClassHash),
    priceModelHash: fieldFromValue(capability.priceModelHash),
    stakeAmount: uint64FromValue(capability.stakeAmount),
    statusHash: fieldFromValue(capability.status)
  };

  return {
    args,
    commitment: buildRegistryCapabilityCommitment(
      args.capabilityIdHash,
      args.pluginIdHash,
      args.manifestHash,
      args.ioSchemaHash,
      args.policyClassHash,
      args.priceModelHash,
      args.stakeAmount,
      args.statusHash
    )
  };
}

export function buildRegisterPluginWitness(plugin: PluginRegistrationInput): KernelWitness<{
  pluginIdHash: Field;
  publisherHash: Field;
  manifestHash: Field;
  bondAmount: UInt64;
  statusHash: Field;
}> {
  const args = {
    pluginIdHash: fieldFromValue(plugin.pluginId),
    publisherHash: fieldFromValue(plugin.publisherKey),
    manifestHash: fieldFromValue(plugin.manifestHash),
    bondAmount: uint64FromValue(plugin.bondAmount),
    statusHash: fieldFromValue(plugin.status)
  };

  return {
    args,
    commitment: buildRegistryPluginCommitment(
      args.pluginIdHash,
      args.publisherHash,
      args.manifestHash,
      args.bondAmount,
      args.statusHash
    )
  };
}

export function buildDisableCapabilityWitness(input: DisableCapabilityWitnessInput): KernelWitness<{
  capabilityIdHash: Field;
  reasonHash: Field;
  actorHash: Field;
  disabledAtSlot: UInt64;
}> {
  const args = {
    capabilityIdHash: fieldFromValue(input.capabilityId),
    reasonHash: fieldFromValue(input.reason),
    actorHash: fieldFromValue(input.actorKey),
    disabledAtSlot: uint64FromValue(input.disabledAtSlot)
  };

  return {
    args,
    commitment: buildRegistryCapabilityDisableCommitment(
      args.capabilityIdHash,
      args.reasonHash,
      args.actorHash,
      args.disabledAtSlot
    )
  };
}

export function buildCreateSessionWitness(input: SessionCreateWitnessInput): KernelWitness<{
  sessionIdHash: Field;
  tenantIdHash: Field;
  agentIdHash: Field;
  routingPolicyHash: Field;
  participantRoot: Field;
  keyRefHash: Field;
  channelBindingHash: Field;
  createdAtSlot: UInt64;
}> {
  const args = {
    sessionIdHash: fieldFromValue(input.header.sessionId),
    tenantIdHash: fieldFromValue(input.header.tenantId),
    agentIdHash: fieldFromValue(input.header.agentId),
    routingPolicyHash: fieldFromValue(input.header.routingPolicyHash),
    participantRoot: fieldFromValue(input.participantRoot),
    keyRefHash: fieldFromValue(input.header.keyRefHash),
    channelBindingHash: fieldFromValue(input.header.channelBindingHash),
    createdAtSlot: uint64FromValue(input.header.createdAtSlot)
  };

  return {
    args,
    commitment: buildSessionCreateCommitment(
      args.sessionIdHash,
      args.tenantIdHash,
      args.agentIdHash,
      args.routingPolicyHash,
      args.participantRoot,
      args.keyRefHash,
      args.channelBindingHash,
      args.createdAtSlot
    )
  };
}

export function buildRotateSessionKeysWitness(input: SessionKeyRotationInput): KernelWitness<{
  sessionIdHash: Field;
  oldKeyRefHash: Field;
  newKeyRefHash: Field;
  rotatedAtSlot: UInt64;
}> {
  const args = {
    sessionIdHash: fieldFromValue(input.sessionId),
    oldKeyRefHash: fieldFromValue(input.oldKeyRef),
    newKeyRefHash: fieldFromValue(input.newKeyRef),
    rotatedAtSlot: uint64FromValue(input.rotatedAtSlot)
  };

  return {
    args,
    commitment: buildSessionKeyRotationCommitment(
      args.sessionIdHash,
      args.oldKeyRefHash,
      args.newKeyRefHash,
      args.rotatedAtSlot
    )
  };
}

export function buildCheckpointSessionWitness(input: SessionCheckpointInput): KernelWitness<{
  sessionIdHash: Field;
  checkpointHash: Field;
  transcriptRoot: Field;
  artifactRoot: Field;
  checkpointSlot: UInt64;
}> {
  const args = {
    sessionIdHash: fieldFromValue(input.sessionId),
    checkpointHash: fieldFromValue(input.checkpointId),
    transcriptRoot: fieldFromValue(input.transcriptRoot),
    artifactRoot: fieldFromValue(input.artifactRoot),
    checkpointSlot: uint64FromValue(input.checkpointSlot)
  };

  return {
    args,
    commitment: buildSessionCheckpointCommitment(
      args.sessionIdHash,
      args.checkpointHash,
      args.transcriptRoot,
      args.artifactRoot,
      args.checkpointSlot
    )
  };
}

export function buildCloseSessionWitness(input: SessionCloseInput): KernelWitness<{
  sessionIdHash: Field;
  finalRoot: Field;
  disclosureRoot: Field;
  closedAtSlot: UInt64;
}> {
  const args = {
    sessionIdHash: fieldFromValue(input.sessionId),
    finalRoot: fieldFromValue(input.finalRoot),
    disclosureRoot: fieldFromValue(input.disclosureRoot),
    closedAtSlot: uint64FromValue(input.closedAtSlot)
  };

  return {
    args,
    commitment: buildSessionCloseCommitment(
      args.sessionIdHash,
      args.finalRoot,
      args.disclosureRoot,
      args.closedAtSlot
    )
  };
}

export function buildAcquireLeaseWitness(input: TurnLeaseInput): KernelWitness<{
  turnIdHash: Field;
  sessionIdHash: Field;
  leaseIdHash: Field;
  workerIdHash: Field;
  workerBond: UInt64;
  leaseExpiresAtSlot: UInt64;
}> {
  const args = {
    turnIdHash: fieldFromValue(input.turnId),
    sessionIdHash: fieldFromValue(input.sessionId),
    leaseIdHash: fieldFromValue(input.leaseId),
    workerIdHash: fieldFromValue(input.workerId),
    workerBond: uint64FromValue(input.workerBond),
    leaseExpiresAtSlot: uint64FromValue(input.leaseExpiresAtSlot)
  };

  return {
    args,
    commitment: buildTurnLeaseCommitment(
      args.turnIdHash,
      args.sessionIdHash,
      args.leaseIdHash,
      args.workerIdHash,
      args.workerBond,
      args.leaseExpiresAtSlot
    )
  };
}

export function buildBeginTurnWitness(header: TurnStartWitnessInput): KernelWitness<{
  turnIdHash: Field;
  sessionIdHash: Field;
  leaseIdHash: Field;
  workerIdHash: Field;
  inputMessageRoot: Field;
  budgetReservationHash: Field;
  approvalBundleHash: Field;
  startedAtSlot: UInt64;
}> {
  const args = {
    turnIdHash: fieldFromValue(header.turnId),
    sessionIdHash: fieldFromValue(header.sessionId),
    leaseIdHash: fieldFromValue(header.leaseId),
    workerIdHash: fieldFromValue(header.workerId),
    inputMessageRoot: fieldFromValue(header.inputMessageRoot),
    budgetReservationHash: fieldFromValue(header.budgetReservationHash),
    approvalBundleHash: fieldFromValue(header.approvalBundleHash),
    startedAtSlot: uint64FromValue(header.startedAtSlot)
  };

  return {
    args,
    commitment: buildTurnHeaderCommitment(
      args.turnIdHash,
      args.sessionIdHash,
      args.leaseIdHash,
      args.workerIdHash,
      args.inputMessageRoot,
      args.budgetReservationHash,
      args.approvalBundleHash,
      args.startedAtSlot
    )
  };
}

export function buildCommitMessageBatchWitness(input: TurnBatchInput): KernelWitness<{
  turnIdHash: Field;
  messageBatchRoot: Field;
  batchIndex: UInt64;
}> {
  const args = {
    turnIdHash: fieldFromValue(input.turnId),
    messageBatchRoot: fieldFromValue(input.batchRoot),
    batchIndex: uint64FromValue(input.batchIndex)
  };

  return {
    args,
    commitment: buildTurnMessageBatchCommitment(args.turnIdHash, args.messageBatchRoot, args.batchIndex)
  };
}

export function buildCommitToolReceiptBatchWitness(input: TurnBatchInput): KernelWitness<{
  turnIdHash: Field;
  toolBatchRoot: Field;
  batchIndex: UInt64;
}> {
  const args = {
    turnIdHash: fieldFromValue(input.turnId),
    toolBatchRoot: fieldFromValue(input.batchRoot),
    batchIndex: uint64FromValue(input.batchIndex)
  };

  return {
    args,
    commitment: buildTurnToolReceiptCommitment(args.turnIdHash, args.toolBatchRoot, args.batchIndex)
  };
}

export function buildCommitOutputWitness(input: TurnOutputInput): KernelWitness<{
  turnIdHash: Field;
  outputHash: Field;
  artifactRoot: Field;
  visibilityHash: Field;
  originProofRoot: Field;
}> {
  const args = {
    turnIdHash: fieldFromValue(input.turnId),
    outputHash: fieldFromValue(input.outputDigest),
    artifactRoot: fieldFromValue(input.artifactRoot),
    visibilityHash: fieldFromValue(input.visibility),
    originProofRoot: fieldFromValue(input.originProofRoot)
  };

  return {
    args,
    commitment: buildTurnOutputCommitment(
      args.turnIdHash,
      args.outputHash,
      args.artifactRoot,
      args.visibilityHash,
      args.originProofRoot
    )
  };
}

export function buildFinalizeTurnWitness(input: TurnFinalizeInput): KernelWitness<{
  turnIdHash: Field;
  finalTurnRoot: Field;
  settlementHash: Field;
  transcriptRoot: Field;
  finalizedAtSlot: UInt64;
}> {
  const args = {
    turnIdHash: fieldFromValue(input.turnId),
    finalTurnRoot: fieldFromValue(input.finalTurnRoot),
    settlementHash: fieldFromValue(input.settlementHash),
    transcriptRoot: fieldFromValue(input.transcriptRoot),
    finalizedAtSlot: uint64FromValue(input.finalizedAtSlot)
  };

  return {
    args,
    commitment: buildTurnFinalizationCommitment(
      args.turnIdHash,
      args.finalTurnRoot,
      args.settlementHash,
      args.transcriptRoot,
      args.finalizedAtSlot
    )
  };
}

export function buildAbortTurnWitness(input: TurnAbortInput): KernelWitness<{
  turnIdHash: Field;
  abortReasonHash: Field;
  reporterHash: Field;
  abortedAtSlot: UInt64;
}> {
  const args = {
    turnIdHash: fieldFromValue(input.turnId),
    abortReasonHash: fieldFromValue(input.abortReason),
    reporterHash: fieldFromValue(input.reporterKey),
    abortedAtSlot: uint64FromValue(input.abortedAtSlot)
  };

  return {
    args,
    commitment: buildTurnAbortCommitment(
      args.turnIdHash,
      args.abortReasonHash,
      args.reporterHash,
      args.abortedAtSlot
    )
  };
}

export function buildRequestApprovalWitness(approval: ApprovalLeaf): KernelWitness<{
  approvalIdHash: Field;
  policyHash: Field;
  scopeHash: Field;
  expirySlot: UInt64;
}> {
  const args = {
    approvalIdHash: fieldFromValue(approval.approvalId),
    policyHash: fieldFromValue(approval.policyHash),
    scopeHash: fieldFromValue({
      turnId: approval.turnId,
      requesterKey: approval.requesterKey,
      workerId: approval.workerId,
      dangerClass: approval.dangerClass,
      scopeHash: approval.scopeHash,
      privacyExceptionHash: approval.privacyExceptionHash ?? null
    }),
    expirySlot: uint64FromValue(approval.expiresAtSlot)
  };

  return {
    args,
    commitment: buildApprovalRequestCommitment(
      args.approvalIdHash,
      args.policyHash,
      args.scopeHash,
      args.expirySlot
    )
  };
}

export function buildCommitteeProofWitness(input: CommitteeProofInput): ProgramWitness<{
  committeeHash: Field;
  decisionHash: Field;
  quorum: UInt64;
  observedVotes: UInt64;
  validUntilSlot: UInt64;
  currentSlot: UInt64;
  expectedDigest: Field;
}> {
  const committeeHash = fieldFromValue(input.committeeId);
  const decisionHash = fieldFromValue(input.decisionId);
  const quorum = uint64FromValue(input.quorum);
  const observedVotes = uint64FromValue(input.observedVotes);
  const validUntilSlot = uint64FromValue(input.validUntilSlot);
  const currentSlot = uint64FromValue(input.currentSlot);
  const expectedDigest = buildCommitteeDecisionCommitment(
    committeeHash,
    decisionHash,
    quorum,
    observedVotes,
    validUntilSlot
  );

  return {
    publicInput: {
      committeeHash,
      decisionHash,
      quorum,
      observedVotes,
      validUntilSlot,
      currentSlot,
      expectedDigest
    },
    privateInputs: [],
    expectedDigest
  };
}

export function buildGrantApprovalWitness(input: ApprovalDecisionInput): KernelWitness<{
  requestLeaf: Field;
  decisionHash: Field;
  committeeDigest: Field;
  observedApprovals: UInt64;
  threshold: UInt64;
}> {
  const committeeWitness = buildCommitteeProofWitness({
    committeeId: input.committeeId,
    decisionId: input.decisionId,
    quorum: input.quorum,
    observedVotes: input.observedApprovals,
    validUntilSlot: input.validUntilSlot,
    currentSlot: input.validUntilSlot
  });
  const args = {
    requestLeaf: input.request.commitment,
    decisionHash: fieldFromValue(input.decisionId),
    committeeDigest: committeeWitness.expectedDigest,
    observedApprovals: uint64FromValue(input.observedApprovals),
    threshold: uint64FromValue(input.quorum)
  };

  return {
    args,
    commitment: buildApprovalDecisionCommitment(
      args.requestLeaf,
      args.decisionHash,
      args.committeeDigest,
      args.observedApprovals,
      args.threshold
    )
  };
}

export function buildDelegateApprovalWitness(input: ApprovalDelegationInput): KernelWitness<{
  delegatorHash: Field;
  delegateeHash: Field;
  scopeHash: Field;
  expirySlot: UInt64;
}> {
  const args = {
    delegatorHash: fieldFromValue(input.delegatorKey),
    delegateeHash: fieldFromValue(input.delegateeKey),
    scopeHash: fieldFromValue(input.scope),
    expirySlot: uint64FromValue(input.expirySlot)
  };

  return {
    args,
    commitment: buildApprovalDelegationCommitment(
      args.delegatorHash,
      args.delegateeHash,
      args.scopeHash,
      args.expirySlot
    )
  };
}

export function buildRequestPrivacyExceptionWitness(
  input: PrivacyExceptionWitnessInput
): KernelWitness<{
  exceptionIdHash: Field;
  scopeHash: Field;
  audienceHash: Field;
  severityHash: Field;
  expirySlot: UInt64;
}> {
  const args = {
    exceptionIdHash: fieldFromValue(input.exceptionId),
    scopeHash: fieldFromValue({
      sessionId: input.sessionId,
      turnId: input.turnId
    }),
    audienceHash: fieldFromValue(input.audience),
    severityHash: fieldFromValue(input.severity),
    expirySlot: uint64FromValue(input.expirySlot)
  };

  return {
    args,
    commitment: buildPrivacyExceptionCommitment(
      args.exceptionIdHash,
      args.scopeHash,
      args.audienceHash,
      args.severityHash,
      args.expirySlot
    )
  };
}

export function buildGrantDisclosureWitness(disclosure: DisclosureLeaf): KernelWitness<{
  disclosureIdHash: Field;
  scopeHash: Field;
  audienceHash: Field;
  legalBasisHash: Field;
  retentionHash: Field;
  expirySlot: UInt64;
}> {
  const args = {
    disclosureIdHash: fieldFromValue(disclosure.disclosureId),
    scopeHash: fieldFromValue({
      sessionId: disclosure.sessionId,
      artifactRef: disclosure.artifactRef,
      scopeHash: disclosure.scopeHash
    }),
    audienceHash: fieldFromValue(disclosure.audienceHash),
    legalBasisHash: fieldFromValue(disclosure.legalBasisHash),
    retentionHash: fieldFromValue({
      expiresAtSlot: disclosure.expiresAtSlot,
      requestorKey: disclosure.requestorKey
    }),
    expirySlot: uint64FromValue(disclosure.expiresAtSlot)
  };

  return {
    args,
    commitment: buildDisclosureGrantCommitment(
      args.disclosureIdHash,
      args.scopeHash,
      args.audienceHash,
      args.legalBasisHash,
      args.retentionHash,
      args.expirySlot
    )
  };
}

export function buildRevokeDisclosureWitness(input: DisclosureRevocationInput): KernelWitness<{
  disclosureIdHash: Field;
  revocationHash: Field;
  actorHash: Field;
}> {
  const args = {
    disclosureIdHash: fieldFromValue(input.disclosureId),
    revocationHash: fieldFromValue(input.revocationReason),
    actorHash: fieldFromValue(input.actorKey)
  };

  return {
    args,
    commitment: buildDisclosureRevocationCommitment(
      args.disclosureIdHash,
      args.revocationHash,
      args.actorHash
    )
  };
}

export function buildDepositCreditsWitness(input: CreditDepositInput): KernelWitness<{
  ownerHash: Field;
  depositIdHash: Field;
  amount: UInt64;
  policyHash: Field;
}> {
  const args = {
    ownerHash: fieldFromValue(input.ownerKey),
    depositIdHash: fieldFromValue(input.depositId),
    amount: uint64FromValue(input.amount),
    policyHash: fieldFromValue(input.policyHash)
  };

  return {
    args,
    commitment: buildCreditCommitment(
      args.ownerHash,
      args.depositIdHash,
      args.amount,
      args.policyHash
    )
  };
}

export function buildReserveBudgetWitness(
  reservation: BudgetReservationLeaf,
  budgetEpoch: UInt64Like
): KernelWitness<{
  turnIdHash: Field;
  reservationHash: Field;
  nullifierHash: Field;
  reservedAmount: UInt64;
  budgetEpoch: UInt64;
}> {
  const args = {
    turnIdHash: fieldFromValue(reservation.turnId),
    reservationHash: fieldFromValue({
      reservationId: reservation.reservationId,
      payerKey: reservation.payerKey,
      refundAddress: reservation.refundAddress
    }),
    nullifierHash: fieldFromValue(reservation.nullifier),
    reservedAmount: uint64FromValue(reservation.maxSpend),
    budgetEpoch: uint64FromValue(budgetEpoch)
  };

  return {
    args,
    commitment: buildBudgetReservationCommitment(
      args.turnIdHash,
      args.reservationHash,
      args.nullifierHash,
      args.reservedAmount,
      args.budgetEpoch
    )
  };
}

export function buildSettleTurnWitness(input: BudgetSettlementInput): KernelWitness<{
  turnIdHash: Field;
  reservedAmount: UInt64;
  payoutAmount: UInt64;
  refundedAmount: UInt64;
  feeAmount: UInt64;
}> {
  const args = {
    turnIdHash: fieldFromValue(input.turnId),
    reservedAmount: uint64FromValue(input.reservedAmount),
    payoutAmount: uint64FromValue(input.payoutAmount),
    refundedAmount: uint64FromValue(input.refundedAmount),
    feeAmount: uint64FromValue(input.feeAmount)
  };

  return {
    args,
    commitment: buildBudgetSettlementCommitment(
      args.turnIdHash,
      args.reservedAmount,
      args.payoutAmount,
      args.refundedAmount,
      args.feeAmount
    )
  };
}

export function buildRefundTurnWitness(input: RefundInput): KernelWitness<{
  turnIdHash: Field;
  refundIdHash: Field;
  refundAmount: UInt64;
  nullifierHash: Field;
}> {
  const args = {
    turnIdHash: fieldFromValue(input.turnId),
    refundIdHash: fieldFromValue(input.refundId),
    refundAmount: uint64FromValue(input.refundAmount),
    nullifierHash: fieldFromValue(input.nullifier)
  };

  return {
    args,
    commitment: buildRefundCommitment(
      args.turnIdHash,
      args.refundIdHash,
      args.refundAmount,
      args.nullifierHash
    )
  };
}

export function buildApprovalPolicyProofWitness(
  input: ApprovalPolicyProofInput
): ProgramWitness<{
  approvalIdHash: Field;
  policyHash: Field;
  scopeHash: Field;
  committeeDigest: Field;
  expirySlot: UInt64;
  currentSlot: UInt64;
  minimumApprovals: UInt64;
  observedApprovals: UInt64;
  expectedDigest: Field;
}> {
  const currentSlot = uint64FromValue(input.currentSlot);
  const minimumApprovals = uint64FromValue(input.minimumApprovals);
  const observedApprovals = uint64FromValue(input.observedApprovals);
  const committeeWitness = buildCommitteeProofWitness({
    committeeId: input.committeeId,
    decisionId: input.decisionId,
    quorum: minimumApprovals,
    observedVotes: observedApprovals,
    validUntilSlot: input.validUntilSlot,
    currentSlot
  });
  const decisionHash = fieldFromValue(input.decisionId);
  const expectedDigest = buildApprovalDecisionCommitment(
    input.request.commitment,
    decisionHash,
    committeeWitness.expectedDigest,
    observedApprovals,
    minimumApprovals
  );

  return {
    publicInput: {
      approvalIdHash: input.request.args.approvalIdHash,
      policyHash: input.request.args.policyHash,
      scopeHash: input.request.args.scopeHash,
      committeeDigest: committeeWitness.expectedDigest,
      expirySlot: input.request.args.expirySlot,
      currentSlot,
      minimumApprovals,
      observedApprovals,
      expectedDigest
    },
    privateInputs: [decisionHash],
    expectedDigest
  };
}

export function buildDisclosureScopeProofWitness(
  input: DisclosureScopeProofInput
): ProgramWitness<{
  disclosureIdHash: Field;
  scopeHash: Field;
  audienceHash: Field;
  legalBasisHash: Field;
  retentionHash: Field;
  expirySlot: UInt64;
  currentSlot: UInt64;
  expectedDigest: Field;
}> {
  const currentSlot = uint64FromValue(input.currentSlot);

  return {
    publicInput: {
      disclosureIdHash: input.grant.args.disclosureIdHash,
      scopeHash: input.grant.args.scopeHash,
      audienceHash: input.grant.args.audienceHash,
      legalBasisHash: input.grant.args.legalBasisHash,
      retentionHash: input.grant.args.retentionHash,
      expirySlot: input.grant.args.expirySlot,
      currentSlot,
      expectedDigest: input.grant.commitment
    },
    privateInputs: [],
    expectedDigest: input.grant.commitment
  };
}

export function buildBudgetConservationProofWitness(
  input: BudgetProofInput
): ProgramWitness<{
  turnIdHash: Field;
  reserved: UInt64;
  payout: UInt64;
  refunded: UInt64;
  fee: UInt64;
  expectedDigest: Field;
}> {
  return {
    publicInput: {
      turnIdHash: input.settlement.args.turnIdHash,
      reserved: input.settlement.args.reservedAmount,
      payout: input.settlement.args.payoutAmount,
      refunded: input.settlement.args.refundedAmount,
      fee: input.settlement.args.feeAmount,
      expectedDigest: input.settlement.commitment
    },
    privateInputs: [],
    expectedDigest: input.settlement.commitment
  };
}

export function buildDeploymentWitnessPlan(): DeploymentWitnessPlan {
  const agent: AgentLeaf = {
    agentId: "agent_shadow_wallet",
    ownerKey: "B62qagentowner0000000000000000000000000000000000000000000000",
    manifestHash: "agent_manifest_shadow_wallet_v1",
    pricingHash: "agent_pricing_shadow_wallet_v1",
    policyClassHash: "policy_workspace_private_v1",
    stakeAmount: "5000000000",
    status: "active",
    metadataHash: "agent_metadata_shadow_wallet_v1"
  };
  const capability: CapabilityLeaf = {
    capabilityId: "capability_private_run",
    pluginId: "plugin_shadow_wallet",
    manifestHash: "capability_manifest_private_run_v1",
    ioSchemaHash: "io_schema_private_run_v1",
    policyClassHash: "policy_workspace_private_v1",
    priceModelHash: "price_model_shadow_run_v1",
    stakeAmount: "3000000000",
    status: "active"
  };
  const plugin: PluginRegistrationInput = {
    pluginId: "plugin_shadow_wallet",
    publisherKey: "B62qpluginpublisher000000000000000000000000000000000000000000",
    manifestHash: "plugin_manifest_shadow_wallet_v1",
    bondAmount: "2500000000",
    status: "active"
  };
  const approvalLeaf: ApprovalLeaf = {
    approvalId: "approval_turn_0011",
    turnId: "turn_0011",
    requesterKey: "B62qrequestor000000000000000000000000000000000000000000000000",
    workerId: "worker_alpha",
    policyHash: "policy_workspace_private_v1",
    dangerClass: "privacy-exception",
    scopeHash: "scope_redacted_tool_receipts_v1",
    privacyExceptionHash: "privacy_exception_002",
    expiresAtSlot: "130"
  };
  const disclosureLeaf: DisclosureLeaf = {
    disclosureId: "disclosure_incident_review_001",
    sessionId: "session_demo_enterprise",
    requestorKey: "B62qcompliance0000000000000000000000000000000000000000000000",
    artifactRef: "artifact_operator_blind_summary_001",
    scopeHash: "scope_incident_review_24h",
    legalBasisHash: "legal_basis_incident_response_v1",
    expiresAtSlot: "144",
    audienceHash: "audience_compliance_reviewer_v1"
  };
  const reservationLeaf: BudgetReservationLeaf = {
    reservationId: "reservation_turn_0011",
    turnId: "turn_0011",
    payerKey: "B62qpayer00000000000000000000000000000000000000000000000000",
    maxSpend: "250000000",
    refundAddress: "B62qrefund000000000000000000000000000000000000000000000000",
    nullifier: "nullifier_turn_0011_v1"
  };

  const agentWitness = buildRegisterAgentWitness(agent);
  const capabilityWitness = buildRegisterCapabilityWitness(capability);
  const pluginWitness = buildRegisterPluginWitness(plugin);
  const disableCapabilityWitness = buildDisableCapabilityWitness({
    capabilityId: capability.capabilityId,
    reason: "policy-disabled-pending-rotation",
    actorKey: "B62qadmin0000000000000000000000000000000000000000000000000",
    disabledAtSlot: "188"
  });

  const requestApprovalWitness = buildRequestApprovalWitness(approvalLeaf);
  const approvalPolicyProof = buildApprovalPolicyProofWitness({
    request: requestApprovalWitness,
    decisionId: "decision_turn_0011_approved",
    committeeId: "committee_enterprise_guardians",
    minimumApprovals: "2",
    observedApprovals: "3",
    validUntilSlot: "150",
    currentSlot: "128"
  });
  const grantApprovalWitness = buildGrantApprovalWitness({
    request: requestApprovalWitness,
    decisionId: "decision_turn_0011_approved",
    committeeId: "committee_enterprise_guardians",
    quorum: "2",
    observedApprovals: "3",
    validUntilSlot: "150"
  });
  const delegateApprovalWitness = buildDelegateApprovalWitness({
    delegatorKey: "guardian_security",
    delegateeKey: "guardian_compliance",
    scope: {
      turnId: "turn_0011",
      sessionId: "session_demo_enterprise"
    },
    expirySlot: "132"
  });
  const privacyExceptionWitness = buildRequestPrivacyExceptionWitness({
    exceptionId: "privacy_exception_002",
    sessionId: "session_demo_enterprise",
    turnId: "turn_0011",
    audience: "Compliance reviewer",
    severity: "medium",
    expirySlot: "134"
  });

  const disclosureGrantWitness = buildGrantDisclosureWitness(disclosureLeaf);
  const disclosureScopeProof = buildDisclosureScopeProofWitness({
    grant: disclosureGrantWitness,
    currentSlot: "120"
  });
  const revokeDisclosureWitness = buildRevokeDisclosureWitness({
    disclosureId: disclosureLeaf.disclosureId,
    revocationReason: "review-window-expired",
    actorKey: "guardian_compliance"
  });

  const depositCreditsWitness = buildDepositCreditsWitness({
    ownerKey: reservationLeaf.payerKey,
    depositId: "deposit_wallet_budget_001",
    amount: "250000000",
    policyHash: "sponsor_policy_shadow_wallet_v1"
  });
  const reserveBudgetWitness = buildReserveBudgetWitness(reservationLeaf, "1");
  const settleTurnWitness = buildSettleTurnWitness({
    turnId: "turn_0011",
    reservedAmount: "250000000",
    payoutAmount: "180000000",
    refundedAmount: "50000000",
    feeAmount: "20000000"
  });
  const refundTurnWitness = buildRefundTurnWitness({
    turnId: "turn_0011",
    refundId: "refund_turn_0011_tail",
    refundAmount: "50000000",
    nullifier: reservationLeaf.nullifier
  });
  const budgetProof = buildBudgetConservationProofWitness({
    settlement: settleTurnWitness
  });

  const createSessionWitness = buildCreateSessionWitness({
    header: {
      sessionId: "session_demo_enterprise",
      tenantId: "tenant_acme",
      agentId: agent.agentId,
      routingPolicyHash: "routing_policy_private_local_v1",
      keyRefHash: "shadow_wallet_keyref_epoch_1",
      createdAtSlot: "120",
      channelBindingHash: "channel_binding_private_console_v1"
    },
    participantRoot: {
      guardians: ["guardian_security", "guardian_compliance", "guardian_legal"],
      threshold: 2
    }
  });
  const rotateSessionKeysWitness = buildRotateSessionKeysWitness({
    sessionId: "session_demo_enterprise",
    oldKeyRef: "shadow_wallet_keyref_epoch_1",
    newKeyRef: "shadow_wallet_keyref_epoch_2",
    rotatedAtSlot: "122"
  });
  const checkpointSessionWitness = buildCheckpointSessionWitness({
    sessionId: "session_demo_enterprise",
    checkpointId: "checkpoint_turn_0011",
    transcriptRoot: "transcript_root_turn_0011",
    artifactRoot: disclosureGrantWitness.commitment,
    checkpointSlot: "126"
  });
  const closeSessionWitness = buildCloseSessionWitness({
    sessionId: "session_demo_enterprise",
    finalRoot: "final_session_root_demo_v1",
    disclosureRoot: disclosureGrantWitness.commitment,
    closedAtSlot: "146"
  });

  const acquireLeaseWitness = buildAcquireLeaseWitness({
    turnId: "turn_0011",
    sessionId: "session_demo_enterprise",
    leaseId: "lease_turn_0011",
    workerId: "worker_alpha",
    workerBond: "75000000",
    leaseExpiresAtSlot: "129"
  });
  const beginTurnWitness = buildBeginTurnWitness({
    turnId: "turn_0011",
    sessionId: "session_demo_enterprise",
    leaseId: "lease_turn_0011",
    workerId: "worker_alpha",
    inputMessageRoot: "input_message_root_turn_0011",
    budgetReservationHash: reserveBudgetWitness.commitment,
    approvalBundleHash: grantApprovalWitness.commitment,
    startedAtSlot: "123"
  });
  const commitMessageBatchWitness = buildCommitMessageBatchWitness({
    turnId: "turn_0011",
    batchRoot: "message_batch_root_turn_0011",
    batchIndex: "0"
  });
  const commitToolReceiptWitness = buildCommitToolReceiptBatchWitness({
    turnId: "turn_0011",
    batchRoot: "tool_receipt_batch_root_turn_0011",
    batchIndex: "0"
  });
  const commitOutputWitness = buildCommitOutputWitness({
    turnId: "turn_0011",
    outputDigest: "output_digest_turn_0011",
    artifactRoot: "artifact_root_turn_0011",
    visibility: "operator-blind",
    originProofRoot: "origin_proof_root_turn_0011"
  });
  const finalizeTurnWitness = buildFinalizeTurnWitness({
    turnId: "turn_0011",
    finalTurnRoot: "final_turn_root_turn_0011",
    settlementHash: settleTurnWitness.commitment,
    transcriptRoot: "transcript_root_turn_0011",
    finalizedAtSlot: "130"
  });
  const abortTurnWitness = buildAbortTurnWitness({
    turnId: "turn_0011",
    abortReason: "provider-timeout-reverted",
    reporterKey: "guardian_security",
    abortedAtSlot: "131"
  });

  return {
    scenarioId: "demo-enterprise-private-run",
    contracts: [
      prepareKernelCall("RegistryKernel", "registerAgent", agentWitness),
      prepareKernelCall("RegistryKernel", "registerCapability", capabilityWitness),
      prepareKernelCall("RegistryKernel", "registerPlugin", pluginWitness),
      prepareKernelCall("RegistryKernel", "disableCapability", disableCapabilityWitness),
      prepareKernelCall("SessionKernel", "createSession", createSessionWitness),
      prepareKernelCall("SessionKernel", "rotateSessionKeys", rotateSessionKeysWitness),
      prepareKernelCall("SessionKernel", "checkpointSession", checkpointSessionWitness),
      prepareKernelCall("SessionKernel", "closeSession", closeSessionWitness),
      prepareKernelCall("TurnKernel", "acquireLease", acquireLeaseWitness),
      prepareKernelCall("TurnKernel", "beginTurn", beginTurnWitness),
      prepareKernelCall("TurnKernel", "commitMessageBatch", commitMessageBatchWitness),
      prepareKernelCall("TurnKernel", "commitToolReceiptBatch", commitToolReceiptWitness),
      prepareKernelCall("TurnKernel", "commitOutput", commitOutputWitness),
      prepareKernelCall("TurnKernel", "finalizeTurn", finalizeTurnWitness),
      prepareKernelCall("TurnKernel", "abortTurn", abortTurnWitness),
      prepareKernelCall("ApprovalKernel", "requestApproval", requestApprovalWitness),
      prepareKernelCall("ApprovalKernel", "grantApproval", grantApprovalWitness),
      prepareKernelCall("ApprovalKernel", "delegateApproval", delegateApprovalWitness),
      prepareKernelCall("ApprovalKernel", "requestPrivacyException", privacyExceptionWitness),
      prepareKernelCall("DisclosureKernel", "grantDisclosure", disclosureGrantWitness),
      prepareKernelCall("DisclosureKernel", "revokeDisclosure", revokeDisclosureWitness),
      prepareKernelCall("EscrowKernel", "depositCredits", depositCreditsWitness),
      prepareKernelCall("EscrowKernel", "reserveBudget", reserveBudgetWitness),
      prepareKernelCall("EscrowKernel", "settleTurn", settleTurnWitness),
      prepareKernelCall("EscrowKernel", "refundTurn", refundTurnWitness)
    ],
    proofs: [
      prepareProgramCall(
        "ApprovalPolicyProgram",
        approvalPolicyProof
      ),
      prepareProgramCall(
        "CommitteeProgram",
        buildCommitteeProofWitness({
          committeeId: "committee_enterprise_guardians",
          decisionId: "decision_turn_0011_approved",
          quorum: "2",
          observedVotes: "3",
          validUntilSlot: "150",
          currentSlot: "128"
        })
      ),
      prepareProgramCall("DisclosureScopeProgram", disclosureScopeProof),
      prepareProgramCall("BudgetConservationProgram", budgetProof)
    ]
  };
}
