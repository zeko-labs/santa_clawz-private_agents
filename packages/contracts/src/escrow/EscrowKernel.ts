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
  buildBudgetReservationCommitment,
  buildBudgetSettlementCommitment,
  buildCreditCommitment,
  buildRefundCommitment
} from "../shared/commitments.js";
import { appendRoot, emptyRoot } from "../shared/root-helpers.js";

export class EscrowKernel extends SmartContract {
  @state(Field) creditRoot = State<Field>();
  @state(Field) budgetRoot = State<Field>();
  @state(Field) payoutRoot = State<Field>();
  @state(Field) nullifierRoot = State<Field>();
  @state(Field) feePolicyRoot = State<Field>();

  events = {
    creditsDeposited: Field,
    budgetReserved: Field,
    turnSettled: Field,
    turnRefunded: Field
  };

  init() {
    super.init();
    const root = emptyRoot();
    this.creditRoot.set(root);
    this.budgetRoot.set(root);
    this.payoutRoot.set(root);
    this.nullifierRoot.set(root);
    this.feePolicyRoot.set(root);
    this.account.permissions.set({
      ...Permissions.default(),
      editState: Permissions.proof()
    });
  }

  @method async depositCredits(ownerHash: Field, depositIdHash: Field, amount: UInt64, policyHash: Field) {
    const current = this.creditRoot.getAndRequireEquals();
    const creditLeaf = buildCreditCommitment(ownerHash, depositIdHash, amount, policyHash);
    const next = appendRoot(current, creditLeaf);
    this.creditRoot.set(next);
    this.emitEvent("creditsDeposited", next);
  }

  @method async reserveBudget(
    turnIdHash: Field,
    reservationHash: Field,
    nullifierHash: Field,
    reservedAmount: UInt64,
    budgetEpoch: UInt64
  ) {
    const budgetCurrent = this.budgetRoot.getAndRequireEquals();
    const reservationLeaf = buildBudgetReservationCommitment(
      turnIdHash,
      reservationHash,
      nullifierHash,
      reservedAmount,
      budgetEpoch
    );
    const budgetNext = appendRoot(budgetCurrent, reservationLeaf);
    this.budgetRoot.set(budgetNext);

    const nullifierCurrent = this.nullifierRoot.getAndRequireEquals();
    this.nullifierRoot.set(appendRoot(nullifierCurrent, nullifierHash, turnIdHash, budgetEpoch.value));
    this.emitEvent("budgetReserved", budgetNext);
  }

  @method async settleTurn(
    turnIdHash: Field,
    reservedAmount: UInt64,
    payoutAmount: UInt64,
    refundedAmount: UInt64,
    feeAmount: UInt64
  ) {
    payoutAmount.add(refundedAmount).add(feeAmount).assertEquals(reservedAmount);
    const current = this.payoutRoot.getAndRequireEquals();
    const settlementLeaf = buildBudgetSettlementCommitment(
      turnIdHash,
      reservedAmount,
      payoutAmount,
      refundedAmount,
      feeAmount
    );
    const next = appendRoot(current, settlementLeaf);
    this.payoutRoot.set(next);
    this.emitEvent("turnSettled", next);
  }

  @method async refundTurn(turnIdHash: Field, refundIdHash: Field, refundAmount: UInt64, nullifierHash: Field) {
    const current = this.payoutRoot.getAndRequireEquals();
    const refundLeaf = buildRefundCommitment(turnIdHash, refundIdHash, refundAmount, nullifierHash);
    const next = appendRoot(current, refundLeaf);
    this.payoutRoot.set(next);
    this.emitEvent("turnRefunded", next);
  }
}
