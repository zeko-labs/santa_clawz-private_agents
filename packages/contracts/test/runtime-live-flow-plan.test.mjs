import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRuntimeAbortTurnWitnessPlan,
  buildRuntimeDisclosureRevocationPlan,
  buildRuntimeFlowWitnessPlan,
  buildRuntimeLiveSessionTurnWitnessPlan,
  buildRuntimeNextTurnWitnessPlan,
  buildRuntimeRefundTurnPlan
} from "../dist/contracts/src/index.js";

const runtimeInput = {
  jobId: "job_live_001",
  scenarioId: "runtime-private-smoke",
  sessionId: "session_live_001",
  turnId: "turn_live_001",
  tenantId: "tenant_acme",
  workspaceId: "workspace_blue",
  walletId: "shadow_wallet_acme_primary",
  walletPublicKey: "B62qshadowwallet000000000000000000000000000000000000000000000000",
  requestorKey: "B62qshadowwallet000000000000000000000000000000000000000000000000",
  workerId: "worker_private_flow",
  baseSlot: "100",
  trustModeId: "private",
  trustModeMaxSpendMina: "0.18",
  sponsoredRemainingMina: "0.50",
  requestedSpendMina: "0.22",
  defaultArtifactVisibility: "operator-blind",
  operatorVisible: false,
  providerVisible: false,
  proofLevel: "rooted",
  guardians: [
    {
      guardianId: "guardian_security",
      label: "Security Lead",
      role: "security",
      status: "active"
    },
    {
      guardianId: "guardian_compliance",
      label: "Compliance Reviewer",
      role: "compliance",
      status: "active"
    },
    {
      guardianId: "guardian_legal",
      label: "Legal Counsel",
      role: "legal",
      status: "invited"
    }
  ],
  governancePolicy: {
    requiredApprovals: 2,
    reviewAudience: "Security + Compliance",
    autoExpiryHours: 24
  },
  privacyExceptions: [
    {
      id: "privacy_exception_approved",
      sessionId: "session_live_001",
      turnId: "turn_live_001",
      title: "Reveal one operator-blind artifact for incident review",
      audience: "Compliance reviewer",
      duration: "24h",
      scope: "One screenshot and one tool receipt",
      reason: "Investigate anomalous outbound host access without opening the full transcript.",
      severity: "high",
      status: "approved",
      requiredApprovals: 2,
      approvals: [
        {
          actorId: "guardian_security",
          actorRole: "workspace-member",
          approvedAtIso: "2026-04-21T00:00:00.000Z",
          note: "Security approved limited disclosure."
        },
        {
          actorId: "guardian_compliance",
          actorRole: "compliance-reviewer",
          approvedAtIso: "2026-04-21T00:00:10.000Z",
          note: "Compliance approved 24h review window."
        }
      ],
      expiresAtIso: "2026-04-22T00:00:00.000Z"
    }
  ]
};

test("runtime live flow plan produces the first live session-turn path with proofs", () => {
  const plan = buildRuntimeLiveSessionTurnWitnessPlan(runtimeInput);

  assert.equal(plan.scenarioId, "runtime-private-smoke");
  assert.equal(plan.contracts.length, 10);
  assert.equal(plan.proofs.length, 3);
  assert.ok(plan.contracts.some((call) => call.kernel === "SessionKernel" && call.method === "createSession"));
  assert.ok(plan.contracts.some((call) => call.kernel === "DisclosureKernel" && call.method === "grantDisclosure"));
  assert.ok(plan.proofs.some((call) => call.program === "ApprovalPolicyProgram"));
  assert.ok(plan.proofs.some((call) => call.program === "BudgetConservationProgram"));
});

test("runtime live flow plan links approval, budget, and settlement commitments deterministically", () => {
  const plan = buildRuntimeLiveSessionTurnWitnessPlan(runtimeInput);

  const grantApproval = plan.contracts.find(
    (call) => call.kernel === "ApprovalKernel" && call.method === "grantApproval"
  );
  const reserveBudget = plan.contracts.find(
    (call) => call.kernel === "EscrowKernel" && call.method === "reserveBudget"
  );
  const beginTurn = plan.contracts.find(
    (call) => call.kernel === "TurnKernel" && call.method === "beginTurn"
  );
  const settleTurn = plan.contracts.find(
    (call) => call.kernel === "EscrowKernel" && call.method === "settleTurn"
  );
  const finalizeTurn = plan.contracts.find(
    (call) => call.kernel === "TurnKernel" && call.method === "finalizeTurn"
  );
  const disclosureGrant = plan.contracts.find(
    (call) => call.kernel === "DisclosureKernel" && call.method === "grantDisclosure"
  );

  assert.equal(reserveBudget?.args.reservedAmount, "180000000");
  assert.equal(grantApproval?.args.threshold, "2");
  assert.equal(beginTurn?.args.approvalBundleHash, grantApproval?.expectedCommitment);
  assert.equal(beginTurn?.args.budgetReservationHash, reserveBudget?.expectedCommitment);
  assert.equal(finalizeTurn?.args.settlementHash, settleTurn?.expectedCommitment);
  assert.equal(disclosureGrant?.args.expirySlot, "124");
  assert.equal(JSON.stringify(plan), JSON.stringify(buildRuntimeLiveSessionTurnWitnessPlan(runtimeInput)));
});

test("runtime next-turn plan checkpoints the session and runs a resumable follow-on turn", () => {
  const plan = buildRuntimeNextTurnWitnessPlan({
    ...runtimeInput,
    flowKind: "next-turn",
    sourceTurnId: "turn_live_seed"
  });

  assert.equal(plan.contracts[0]?.kernel, "SessionKernel");
  assert.equal(plan.contracts[0]?.method, "checkpointSession");
  assert.equal(plan.contracts.length, 10);
  assert.equal(plan.proofs.length, 3);
});

test("runtime abort, refund, and disclosure revocation plans stay narrowly scoped", () => {
  const abortPlan = buildRuntimeAbortTurnWitnessPlan({
    ...runtimeInput,
    flowKind: "abort-turn",
    abortReason: "provider-timeout"
  });
  const refundPlan = buildRuntimeRefundTurnPlan({
    ...runtimeInput,
    flowKind: "refund-turn",
    refundAmountMina: "0.04"
  });
  const revokePlan = buildRuntimeDisclosureRevocationPlan({
    ...runtimeInput,
    flowKind: "revoke-disclosure",
    sourceDisclosureId: "disclosure_live_001"
  });

  assert.deepEqual(
    abortPlan.contracts.map((call) => `${call.kernel}.${call.method}`),
    ["ApprovalKernel.requestPrivacyException", "TurnKernel.abortTurn"]
  );
  assert.deepEqual(refundPlan.contracts.map((call) => `${call.kernel}.${call.method}`), ["EscrowKernel.refundTurn"]);
  assert.deepEqual(
    revokePlan.contracts.map((call) => `${call.kernel}.${call.method}`),
    ["DisclosureKernel.revokeDisclosure"]
  );
});

test("generic runtime flow plan dispatches by flow kind", () => {
  const nextTurnPlan = buildRuntimeFlowWitnessPlan({
    ...runtimeInput,
    flowKind: "next-turn"
  });
  const revokePlan = buildRuntimeFlowWitnessPlan({
    ...runtimeInput,
    flowKind: "revoke-disclosure"
  });

  assert.equal(nextTurnPlan.contracts[0]?.method, "checkpointSession");
  assert.equal(revokePlan.contracts[0]?.method, "revokeDisclosure");
});
