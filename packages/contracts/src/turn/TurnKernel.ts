import {
  Field,
  Permissions,
  SmartContract,
  State,
  UInt64,
  method,
  state
} from "o1js";

import {
  buildTurnAbortCommitment,
  buildTurnFinalizationCommitment,
  buildTurnHeaderCommitment,
  buildTurnLeaseCommitment,
  buildTurnMessageBatchCommitment,
  buildTurnOutputCommitment,
  buildTurnToolReceiptCommitment
} from "../shared/commitments.js";
import { appendRoot, emptyRoot } from "../shared/root-helpers.js";

export class TurnKernel extends SmartContract {
  @state(Field) activeTurnRoot = State<Field>();
  @state(Field) messageRoot = State<Field>();
  @state(Field) toolReceiptRoot = State<Field>();
  @state(Field) outputRoot = State<Field>();
  @state(Field) finalizationRoot = State<Field>();
  @state(UInt64) turnCounter = State<UInt64>();

  events = {
    leaseAcquired: Field,
    turnBegan: Field,
    outputCommitted: Field,
    turnFinalized: Field
  };

  init() {
    super.init();
    const root = emptyRoot();
    this.activeTurnRoot.set(root);
    this.messageRoot.set(root);
    this.toolReceiptRoot.set(root);
    this.outputRoot.set(root);
    this.finalizationRoot.set(root);
    this.turnCounter.set(UInt64.from(0));
    this.account.permissions.set({
      ...Permissions.default(),
      editState: Permissions.proof()
    });
  }

  @method async acquireLease(
    turnIdHash: Field,
    sessionIdHash: Field,
    leaseIdHash: Field,
    workerIdHash: Field,
    workerBond: UInt64,
    leaseExpiresAtSlot: UInt64
  ) {
    const current = this.activeTurnRoot.getAndRequireEquals();
    const next = appendRoot(
      current,
      buildTurnLeaseCommitment(turnIdHash, sessionIdHash, leaseIdHash, workerIdHash, workerBond, leaseExpiresAtSlot)
    );
    this.activeTurnRoot.set(next);
    this.emitEvent("leaseAcquired", next);
  }

  @method async beginTurn(
    turnIdHash: Field,
    sessionIdHash: Field,
    leaseIdHash: Field,
    workerIdHash: Field,
    inputMessageRoot: Field,
    budgetReservationHash: Field,
    approvalBundleHash: Field,
    startedAtSlot: UInt64
  ) {
    const current = this.activeTurnRoot.getAndRequireEquals();
    const next = appendRoot(
      current,
      buildTurnHeaderCommitment(
        turnIdHash,
        sessionIdHash,
        leaseIdHash,
        workerIdHash,
        inputMessageRoot,
        budgetReservationHash,
        approvalBundleHash,
        startedAtSlot
      )
    );
    this.activeTurnRoot.set(next);
    const counter = this.turnCounter.getAndRequireEquals();
    this.turnCounter.set(counter.add(UInt64.from(1)));
    this.emitEvent("turnBegan", next);
  }

  @method async commitMessageBatch(turnIdHash: Field, messageBatchRoot: Field, batchIndex: UInt64) {
    const current = this.messageRoot.getAndRequireEquals();
    this.messageRoot.set(appendRoot(current, buildTurnMessageBatchCommitment(turnIdHash, messageBatchRoot, batchIndex)));
  }

  @method async commitToolReceiptBatch(turnIdHash: Field, toolBatchRoot: Field, batchIndex: UInt64) {
    const current = this.toolReceiptRoot.getAndRequireEquals();
    this.toolReceiptRoot.set(appendRoot(current, buildTurnToolReceiptCommitment(turnIdHash, toolBatchRoot, batchIndex)));
  }

  @method async commitOutput(
    turnIdHash: Field,
    outputHash: Field,
    artifactRoot: Field,
    visibilityHash: Field,
    originProofRoot: Field
  ) {
    const current = this.outputRoot.getAndRequireEquals();
    const next = appendRoot(
      current,
      buildTurnOutputCommitment(turnIdHash, outputHash, artifactRoot, visibilityHash, originProofRoot)
    );
    this.outputRoot.set(next);
    this.emitEvent("outputCommitted", next);
  }

  @method async finalizeTurn(
    turnIdHash: Field,
    finalTurnRoot: Field,
    settlementHash: Field,
    transcriptRoot: Field,
    finalizedAtSlot: UInt64
  ) {
    const current = this.finalizationRoot.getAndRequireEquals();
    const next = appendRoot(
      current,
      buildTurnFinalizationCommitment(turnIdHash, finalTurnRoot, settlementHash, transcriptRoot, finalizedAtSlot)
    );
    this.finalizationRoot.set(next);
    this.emitEvent("turnFinalized", next);
  }

  @method async abortTurn(turnIdHash: Field, abortReasonHash: Field, reporterHash: Field, abortedAtSlot: UInt64) {
    const current = this.finalizationRoot.getAndRequireEquals();
    this.finalizationRoot.set(
      appendRoot(current, buildTurnAbortCommitment(turnIdHash, abortReasonHash, reporterHash, abortedAtSlot))
    );
  }
}
