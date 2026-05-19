import { Field, Struct, UInt64, ZkProgram } from "o1js";

import { buildBudgetSettlementCommitment } from "../shared/commitments.js";

export class BudgetConservationInput extends Struct({
  turnIdHash: Field,
  reserved: UInt64,
  payout: UInt64,
  refunded: UInt64,
  fee: UInt64,
  expectedDigest: Field
}) {}

export const BudgetConservationProgram = ZkProgram({
  name: "BudgetConservationProgram",
  publicInput: BudgetConservationInput,
  methods: {
    verifyBudget: {
      privateInputs: [],
      async method(input: BudgetConservationInput) {
        input.payout.add(input.refunded).add(input.fee).assertEquals(input.reserved);
        buildBudgetSettlementCommitment(
          input.turnIdHash,
          input.reserved,
          input.payout,
          input.refunded,
          input.fee
        ).assertEquals(input.expectedDigest);
      }
    }
  }
});

export class BudgetConservationProof extends ZkProgram.Proof(BudgetConservationProgram) {}
