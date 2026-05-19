import { Field, Struct, UInt64, ZkProgram } from "o1js";

import {
  buildApprovalDecisionCommitment,
  buildApprovalRequestCommitment
} from "../shared/commitments.js";

export class ApprovalPolicyInput extends Struct({
  approvalIdHash: Field,
  policyHash: Field,
  scopeHash: Field,
  committeeDigest: Field,
  expirySlot: UInt64,
  currentSlot: UInt64,
  minimumApprovals: UInt64,
  observedApprovals: UInt64,
  expectedDigest: Field
}) {}

export const ApprovalPolicyProgram = ZkProgram({
  name: "ApprovalPolicyProgram",
  publicInput: ApprovalPolicyInput,
  methods: {
    verifyPolicy: {
      privateInputs: [Field],
      async method(input: ApprovalPolicyInput, decisionHash: Field) {
        input.expirySlot.assertGreaterThanOrEqual(input.currentSlot);
        input.observedApprovals.assertGreaterThanOrEqual(input.minimumApprovals);

        const requestLeaf = buildApprovalRequestCommitment(
          input.approvalIdHash,
          input.policyHash,
          input.scopeHash,
          input.expirySlot
        );
        buildApprovalDecisionCommitment(
          requestLeaf,
          decisionHash,
          input.committeeDigest,
          input.observedApprovals,
          input.minimumApprovals
        ).assertEquals(input.expectedDigest);
      }
    }
  }
});

export class ApprovalPolicyProof extends ZkProgram.Proof(ApprovalPolicyProgram) {}
