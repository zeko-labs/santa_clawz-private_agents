import test from "node:test";
import assert from "node:assert/strict";

import { Field, UInt64 } from "o1js";

import {
  buildApprovalDecisionCommitment,
  buildApprovalRequestCommitment,
  buildBudgetSettlementCommitment,
  buildCommitteeDecisionCommitment,
  buildDisclosureGrantCommitment,
  buildPrivacyExceptionCommitment,
  buildRefundCommitment
} from "../dist/contracts/src/index.js";

const field = (value) => Field.fromJSON(String(value));
const amount = (value) => UInt64.from(value);

test("approval commitments change when scope or quorum changes", () => {
  const requestA = buildApprovalRequestCommitment(field(101), field(202), field(303), amount(90));
  const requestB = buildApprovalRequestCommitment(field(101), field(202), field(304), amount(90));
  const committeeA = buildCommitteeDecisionCommitment(field(505), field(606), amount(2), amount(3), amount(120));
  const committeeB = buildCommitteeDecisionCommitment(field(505), field(606), amount(3), amount(3), amount(120));
  const decisionA = buildApprovalDecisionCommitment(requestA, field(707), committeeA, amount(3), amount(2));
  const decisionB = buildApprovalDecisionCommitment(requestA, field(707), committeeB, amount(3), amount(2));

  assert.notEqual(requestA.toString(), requestB.toString());
  assert.notEqual(committeeA.toString(), committeeB.toString());
  assert.notEqual(decisionA.toString(), decisionB.toString());
});

test("privacy and disclosure commitments encode expiry and audience boundaries", () => {
  const disclosureA = buildDisclosureGrantCommitment(
    field(11),
    field(12),
    field(13),
    field(14),
    field(15),
    amount(500)
  );
  const disclosureB = buildDisclosureGrantCommitment(
    field(11),
    field(12),
    field(99),
    field(14),
    field(15),
    amount(500)
  );
  const exceptionA = buildPrivacyExceptionCommitment(field(21), field(22), field(23), field(24), amount(48));
  const exceptionB = buildPrivacyExceptionCommitment(field(21), field(22), field(23), field(24), amount(72));

  assert.notEqual(disclosureA.toString(), disclosureB.toString());
  assert.notEqual(exceptionA.toString(), exceptionB.toString());
});

test("budget settlement and refund commitments remain distinct for the same turn", () => {
  const settlement = buildBudgetSettlementCommitment(field(31), amount(100), amount(72), amount(23), amount(5));
  const refund = buildRefundCommitment(field(31), field(32), amount(23), field(33));

  assert.notEqual(settlement.toString(), refund.toString());
});
