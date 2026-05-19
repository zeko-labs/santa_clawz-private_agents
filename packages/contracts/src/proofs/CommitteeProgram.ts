import { Field, Struct, UInt64, ZkProgram } from "o1js";

import { buildCommitteeDecisionCommitment } from "../shared/commitments.js";

export class CommitteeInput extends Struct({
  committeeHash: Field,
  decisionHash: Field,
  quorum: UInt64,
  observedVotes: UInt64,
  validUntilSlot: UInt64,
  currentSlot: UInt64,
  expectedDigest: Field
}) {}

export const CommitteeProgram = ZkProgram({
  name: "CommitteeProgram",
  publicInput: CommitteeInput,
  methods: {
    verifyCommittee: {
      privateInputs: [],
      async method(input: CommitteeInput) {
        input.observedVotes.assertGreaterThanOrEqual(input.quorum);
        input.validUntilSlot.assertGreaterThanOrEqual(input.currentSlot);
        buildCommitteeDecisionCommitment(
          input.committeeHash,
          input.decisionHash,
          input.quorum,
          input.observedVotes,
          input.validUntilSlot
        ).assertEquals(input.expectedDigest);
      }
    }
  }
});

export class CommitteeProof extends ZkProgram.Proof(CommitteeProgram) {}
