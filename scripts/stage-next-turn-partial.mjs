import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRuntimeFlowWitnessPlan,
  executeLiveSessionTurnFlow
} from "../packages/contracts/dist/contracts/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..");
const apiBase = process.env.CLAWZ_API_BASE ?? "http://127.0.0.1:4325";
const requestedSessionId = process.env.SESSION_ID;
const requestedSourceTurnId = process.env.SOURCE_TURN_ID;
const configuredStepCount = Number.parseInt(process.env.STEP_COUNT ?? "6", 10);

if (!requestedSessionId || !requestedSourceTurnId) {
  throw new Error("SESSION_ID and SOURCE_TURN_ID are required.");
}

if (!Number.isInteger(configuredStepCount) || configuredStepCount <= 0) {
  throw new Error("STEP_COUNT must be a positive integer.");
}

const response = await fetch(`${apiBase}/api/console/state?sessionId=${encodeURIComponent(requestedSessionId)}`);
if (!response.ok) {
  throw new Error(`Unable to load console state from ${apiBase}: ${response.status}`);
}

const state = await response.json();
const sessionId = state.session.sessionId;
const trustMode = state.trustModes.find((mode) => mode.id === state.wallet.trustModeId) ?? state.trustModes[0];
const slug = randomUUID().replace(/-/g, "").slice(0, 12);
const jobId = `stage_flow_${slug}`;
const turnId = process.env.TURN_ID ?? `turn_live_${slug}`;
const baseSlot = String(Math.floor(Date.now() / 1000));

const runtimeInput = {
  jobId,
  flowKind: "next-turn",
  scenarioId: `runtime-stage-next-turn-${trustMode.id}-${slug}`,
  sessionId,
  turnId,
  sourceTurnId: requestedSourceTurnId,
  tenantId: "tenant_acme",
  workspaceId: "workspace_blue",
  walletId: state.wallet.walletId,
  walletPublicKey: state.wallet.publicKey,
  requestorKey: state.wallet.publicKey,
  workerId: `worker_${trustMode.id}_${jobId.slice(-6)}`,
  baseSlot,
  trustModeId: trustMode.id,
  trustModeMaxSpendMina: trustMode.maxSpendMina,
  sponsoredRemainingMina: state.wallet.sponsoredRemainingMina,
  requestedSpendMina: state.wallet.sponsoredRemainingMina,
  defaultArtifactVisibility: trustMode.defaultArtifactVisibility,
  operatorVisible: trustMode.operatorVisible,
  providerVisible: trustMode.providerVisible,
  proofLevel: trustMode.proofLevel,
  guardians: state.wallet.guardians,
  governancePolicy: state.wallet.governancePolicy,
  privacyExceptions: state.privacyExceptions
};

const fullPlan = buildRuntimeFlowWitnessPlan(runtimeInput);
const plan = {
  ...fullPlan,
  contracts: fullPlan.contracts.slice(0, Math.min(configuredStepCount, fullPlan.contracts.length))
};
const reportPath = path.join(workspaceRoot, "packages", "contracts", "deployments", "staged-next-turn-flow.json");
const witnessPlanPath = path.join(workspaceRoot, "packages", "contracts", "deployments", "staged-next-turn-plan.json");
const report = await executeLiveSessionTurnFlow({
  workspaceRoot,
  sessionId,
  turnId,
  plan,
  reportPath,
  witnessPlanPath
});

console.log(
  JSON.stringify(
    {
      sessionId,
      turnId,
      sourceTurnId: requestedSourceTurnId,
      trustModeId: trustMode.id,
      requestedStepCount: configuredStepCount,
      executedStepCount: report.steps.length,
      lastStepLabel: report.steps.at(-1)?.label ?? null,
      reportPath,
      witnessPlanPath,
      txHashes: report.steps.map((step) => ({
        label: step.label,
        txHash: step.txHash
      }))
    },
    null,
    2
  )
);
