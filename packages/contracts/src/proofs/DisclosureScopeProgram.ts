import { Field, Struct, UInt64, ZkProgram } from "o1js";

import { buildDisclosureGrantCommitment } from "../shared/commitments.js";

export class DisclosureScopeInput extends Struct({
  disclosureIdHash: Field,
  scopeHash: Field,
  audienceHash: Field,
  legalBasisHash: Field,
  retentionHash: Field,
  expirySlot: UInt64,
  currentSlot: UInt64,
  expectedDigest: Field
}) {}

export const DisclosureScopeProgram = ZkProgram({
  name: "DisclosureScopeProgram",
  publicInput: DisclosureScopeInput,
  methods: {
    verifyDisclosure: {
      privateInputs: [],
      async method(input: DisclosureScopeInput) {
        input.expirySlot.assertGreaterThanOrEqual(input.currentSlot);
        buildDisclosureGrantCommitment(
          input.disclosureIdHash,
          input.scopeHash,
          input.audienceHash,
          input.legalBasisHash,
          input.retentionHash,
          input.expirySlot
        ).assertEquals(input.expectedDigest);
      }
    }
  }
});

export class DisclosureScopeProof extends ZkProgram.Proof(DisclosureScopeProgram) {}
