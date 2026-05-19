import test from "node:test";
import assert from "node:assert/strict";

import { buildDeploymentWitnessPlan } from "../dist/contracts/src/index.js";

test("deployment witness plan covers kernels and proof programs", () => {
  const plan = buildDeploymentWitnessPlan();

  assert.equal(plan.scenarioId, "demo-enterprise-private-run");
  assert.equal(plan.contracts.length, 25);
  assert.equal(plan.proofs.length, 4);
  assert.ok(plan.contracts.some((call) => call.kernel === "SessionKernel" && call.method === "createSession"));
  assert.ok(plan.contracts.some((call) => call.kernel === "TurnKernel" && call.method === "finalizeTurn"));
  assert.ok(plan.contracts.some((call) => call.kernel === "ApprovalKernel" && call.method === "grantApproval"));
  assert.ok(plan.proofs.some((call) => call.program === "ApprovalPolicyProgram"));
  assert.ok(plan.proofs.some((call) => call.program === "BudgetConservationProgram"));
});

test("deployment witness plan links cross-kernel commitments deterministically", () => {
  const plan = buildDeploymentWitnessPlan();
  const approvalGrant = plan.contracts.find(
    (call) => call.kernel === "ApprovalKernel" && call.method === "grantApproval"
  );
  const beginTurn = plan.contracts.find(
    (call) => call.kernel === "TurnKernel" && call.method === "beginTurn"
  );
  const disclosureGrant = plan.contracts.find(
    (call) => call.kernel === "DisclosureKernel" && call.method === "grantDisclosure"
  );
  const closeSession = plan.contracts.find(
    (call) => call.kernel === "SessionKernel" && call.method === "closeSession"
  );
  const settlement = plan.contracts.find(
    (call) => call.kernel === "EscrowKernel" && call.method === "settleTurn"
  );
  const finalizeTurn = plan.contracts.find(
    (call) => call.kernel === "TurnKernel" && call.method === "finalizeTurn"
  );

  assert.equal(beginTurn?.args.approvalBundleHash, approvalGrant?.expectedCommitment);
  assert.equal(closeSession?.args.disclosureRoot, disclosureGrant?.expectedCommitment);
  assert.equal(finalizeTurn?.args.settlementHash, settlement?.expectedCommitment);
  assert.equal(JSON.stringify(plan), JSON.stringify(buildDeploymentWitnessPlan()));
});
