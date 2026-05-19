import { existsSync } from "fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Field, Mina, PrivateKey, PublicKey, UInt64, fetchAccount } from "o1js";

import { ApprovalKernel } from "../approval/ApprovalKernel.js";
import { DisclosureKernel } from "../disclosure/DisclosureKernel.js";
import { EscrowKernel } from "../escrow/EscrowKernel.js";
import { loadLocalEnv } from "./load-env.js";
import { normalizeGraphqlEndpoint } from "./network.js";
import {
  buildDefaultRuntimeLiveSessionTurnFlowInput,
  buildRuntimeFlowWitnessPlan,
  type RuntimeLiveSessionTurnFlowInput
} from "./runtime-live-flow-plan.js";
import { SessionKernel } from "../session/SessionKernel.js";
import { TurnKernel } from "../turn/TurnKernel.js";
import type { DeploymentWitnessPlan, PreparedKernelCall } from "./witness-builders.js";

const DEFAULT_SESSION_ID = "session_demo_enterprise";
const DEFAULT_TURN_ID = "turn_0011";

interface DeploymentManifestFile {
  networkId?: string;
  mina?: string;
  archive?: string;
  fee?: string;
  results: Array<{
    label?: string;
    address?: string | null;
  }>;
}

interface FlowPreparedKernelCall extends Omit<PreparedKernelCall, "args"> {
  args: Record<string, string>;
}

interface FlowExecutionContext {
  deployer: PrivateKey;
  fee: string;
  sessionKernel: SessionKernel;
  turnKernel: TurnKernel;
  approvalKernel: ApprovalKernel;
  disclosureKernel: DisclosureKernel;
  escrowKernel: EscrowKernel;
  sessionAddress: PublicKey;
  turnAddress: PublicKey;
  approvalAddress: PublicKey;
  disclosureAddress: PublicKey;
  escrowAddress: PublicKey;
}

export interface LiveSessionTurnFlowStepReport {
  label: string;
  kernel: string;
  method: string;
  contractAddress: string;
  txHash: string;
  changedSlots: number[];
  occurredAtIso: string;
  args: Record<string, string>;
  handles?: Record<string, string>;
  beforeState: string[];
  afterState: string[];
}

export interface LiveSessionTurnFlowReport {
  scenarioId: string;
  sessionId: string;
  turnId: string;
  networkId: string;
  generatedAtIso: string;
  deploymentPath: string;
  witnessPlanPath: string;
  reportType: "live-session-turn-flow";
  steps: LiveSessionTurnFlowStepReport[];
}

export interface ExecuteLiveSessionTurnFlowOptions {
  workspaceRoot?: string;
  sessionId?: string;
  turnId?: string;
  reportPath?: string;
  witnessPlanPath?: string;
  plan?: DeploymentWitnessPlan;
  runtimeInput?: RuntimeLiveSessionTurnFlowInput;
  resume?: boolean;
  onStep?: (step: LiveSessionTurnFlowStepReport) => Promise<void> | void;
}

function findWorkspaceRoot(startDir: string): string {
  let current = startDir;

  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return startDir;
    }
    current = parent;
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return await readJson<T>(filePath);
  } catch (error) {
    const maybeCode = error as { code?: string };
    if (maybeCode.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fieldFrom(value: string): Field {
  return Field.fromJSON(String(value));
}

function uint64From(value: string): UInt64 {
  return UInt64.from(String(value));
}

function getRequiredAddress(deployment: DeploymentManifestFile, label: string): PublicKey {
  const match = deployment.results.find((result) => result.label === label && typeof result.address === "string");

  if (!match?.address) {
    throw new Error(`Missing deployed address for ${label}`);
  }

  return PublicKey.fromBase58(match.address);
}

function getCall(plan: DeploymentWitnessPlan, kernel: string, method: string): FlowPreparedKernelCall {
  const match = plan.contracts.find((entry) => entry.kernel === kernel && entry.method === method);
  if (!match) {
    throw new Error(`Missing witness entry for ${kernel}.${method}`);
  }
  return match as FlowPreparedKernelCall;
}

function requiredArg(args: Record<string, string>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`Missing required witness arg: ${key}`);
  }
  return value;
}

async function fetchAppState(publicKey: PublicKey): Promise<string[]> {
  const result = await fetchAccount({ publicKey });
  if (result.error || !result.account) {
    throw new Error(`Account fetch failed for ${publicKey.toBase58()}: ${result.error ?? "account missing"}`);
  }

  return (result.account.zkapp?.appState ?? []).map((field) => field.toString());
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStateChange(label: string, publicKey: PublicKey, beforeState: string[], timeoutMs = 240_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const afterState = await fetchAppState(publicKey);
      if (JSON.stringify(afterState) !== JSON.stringify(beforeState)) {
        return afterState;
      }
    } catch {}

    await sleep(4_000);
  }

  throw new Error(
    `${label} did not change zkApp state within ${timeoutMs}ms for ${publicKey.toBase58()}\n` +
      `before=${JSON.stringify(beforeState)}`
  );
}

async function sendFlowTransaction(input: {
  label: string;
  kernel: string;
  method: string;
  args: Record<string, string>;
  handles?: Record<string, string>;
  deployer: PrivateKey;
  fee: string;
  contractAddress: PublicKey;
  invoke: () => Promise<void>;
}): Promise<LiveSessionTurnFlowStepReport> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const beforeState = await fetchAppState(input.contractAddress);
    await fetchAccount({ publicKey: input.deployer.toPublicKey() });

    try {
      const tx = await Mina.transaction({ sender: input.deployer.toPublicKey(), fee: input.fee }, async () => {
        await input.invoke();
      });

      await tx.prove();
      const pending = await tx.sign([input.deployer]).send();
      const txHash =
        typeof pending === "object" &&
        pending !== null &&
        "hash" in pending &&
        typeof (pending as { hash?: unknown }).hash === "string"
          ? ((pending as { hash: string }).hash)
          : undefined;

      if (!txHash) {
        throw new Error(`${input.label} did not return a transaction hash`);
      }

      const afterState = await waitForStateChange(input.label, input.contractAddress, beforeState);
      const changedSlots = afterState
        .map((value, index) => (value === beforeState[index] ? null : index))
        .filter((value): value is number => value !== null);

      if (changedSlots.length === 0) {
        throw new Error(`${input.label} did not mutate zkApp state`);
      }

      return {
        label: input.label,
        kernel: input.kernel,
        method: input.method,
        contractAddress: input.contractAddress.toBase58(),
        txHash,
        changedSlots,
        occurredAtIso: new Date().toISOString(),
        args: input.args,
        ...(input.handles ? { handles: input.handles } : {}),
        beforeState,
        afterState
      };
    } catch (error) {
      lastError = error;
      if (attempt === 3) {
        break;
      }
      await sleep(3_000 * attempt);
    }
  }

  throw new Error(
    `${input.label} failed after 3 attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

function getKernelAddress(context: FlowExecutionContext, kernel: FlowPreparedKernelCall["kernel"]): PublicKey {
  if (kernel === "SessionKernel") {
    return context.sessionAddress;
  }
  if (kernel === "TurnKernel") {
    return context.turnAddress;
  }
  if (kernel === "ApprovalKernel") {
    return context.approvalAddress;
  }
  if (kernel === "DisclosureKernel") {
    return context.disclosureAddress;
  }
  if (kernel === "EscrowKernel") {
    return context.escrowAddress;
  }

  throw new Error(`Unsupported kernel: ${kernel}`);
}

async function invokePreparedKernelCall(
  context: FlowExecutionContext,
  call: FlowPreparedKernelCall
): Promise<LiveSessionTurnFlowStepReport> {
  const label = `${call.kernel}.${call.method}`;

  return sendFlowTransaction({
    label,
    kernel: call.kernel,
    method: call.method,
    args: call.args,
    ...(call.handles ? { handles: call.handles } : {}),
    deployer: context.deployer,
    fee: context.fee,
    contractAddress: getKernelAddress(context, call.kernel),
    invoke: async () => {
      if (label === "SessionKernel.createSession") {
        await context.sessionKernel.createSession(
          fieldFrom(requiredArg(call.args, "sessionIdHash")),
          fieldFrom(requiredArg(call.args, "tenantIdHash")),
          fieldFrom(requiredArg(call.args, "agentIdHash")),
          fieldFrom(requiredArg(call.args, "routingPolicyHash")),
          fieldFrom(requiredArg(call.args, "participantRoot")),
          fieldFrom(requiredArg(call.args, "keyRefHash")),
          fieldFrom(requiredArg(call.args, "channelBindingHash")),
          uint64From(requiredArg(call.args, "createdAtSlot"))
        );
        return;
      }

      if (label === "SessionKernel.rotateSessionKeys") {
        await context.sessionKernel.rotateSessionKeys(
          fieldFrom(requiredArg(call.args, "sessionIdHash")),
          fieldFrom(requiredArg(call.args, "oldKeyRefHash")),
          fieldFrom(requiredArg(call.args, "newKeyRefHash")),
          uint64From(requiredArg(call.args, "rotatedAtSlot"))
        );
        return;
      }

      if (label === "SessionKernel.checkpointSession") {
        await context.sessionKernel.checkpointSession(
          fieldFrom(requiredArg(call.args, "sessionIdHash")),
          fieldFrom(requiredArg(call.args, "checkpointHash")),
          fieldFrom(requiredArg(call.args, "transcriptRoot")),
          fieldFrom(requiredArg(call.args, "artifactRoot")),
          uint64From(requiredArg(call.args, "checkpointSlot"))
        );
        return;
      }

      if (label === "SessionKernel.closeSession") {
        await context.sessionKernel.closeSession(
          fieldFrom(requiredArg(call.args, "sessionIdHash")),
          fieldFrom(requiredArg(call.args, "finalRoot")),
          fieldFrom(requiredArg(call.args, "disclosureRoot")),
          uint64From(requiredArg(call.args, "closedAtSlot"))
        );
        return;
      }

      if (label === "TurnKernel.acquireLease") {
        await context.turnKernel.acquireLease(
          fieldFrom(requiredArg(call.args, "turnIdHash")),
          fieldFrom(requiredArg(call.args, "sessionIdHash")),
          fieldFrom(requiredArg(call.args, "leaseIdHash")),
          fieldFrom(requiredArg(call.args, "workerIdHash")),
          uint64From(requiredArg(call.args, "workerBond")),
          uint64From(requiredArg(call.args, "leaseExpiresAtSlot"))
        );
        return;
      }

      if (label === "TurnKernel.beginTurn") {
        await context.turnKernel.beginTurn(
          fieldFrom(requiredArg(call.args, "turnIdHash")),
          fieldFrom(requiredArg(call.args, "sessionIdHash")),
          fieldFrom(requiredArg(call.args, "leaseIdHash")),
          fieldFrom(requiredArg(call.args, "workerIdHash")),
          fieldFrom(requiredArg(call.args, "inputMessageRoot")),
          fieldFrom(requiredArg(call.args, "budgetReservationHash")),
          fieldFrom(requiredArg(call.args, "approvalBundleHash")),
          uint64From(requiredArg(call.args, "startedAtSlot"))
        );
        return;
      }

      if (label === "TurnKernel.commitMessageBatch") {
        await context.turnKernel.commitMessageBatch(
          fieldFrom(requiredArg(call.args, "turnIdHash")),
          fieldFrom(requiredArg(call.args, "messageBatchRoot")),
          uint64From(requiredArg(call.args, "batchIndex"))
        );
        return;
      }

      if (label === "TurnKernel.commitToolReceiptBatch") {
        await context.turnKernel.commitToolReceiptBatch(
          fieldFrom(requiredArg(call.args, "turnIdHash")),
          fieldFrom(requiredArg(call.args, "toolBatchRoot")),
          uint64From(requiredArg(call.args, "batchIndex"))
        );
        return;
      }

      if (label === "TurnKernel.commitOutput") {
        await context.turnKernel.commitOutput(
          fieldFrom(requiredArg(call.args, "turnIdHash")),
          fieldFrom(requiredArg(call.args, "outputHash")),
          fieldFrom(requiredArg(call.args, "artifactRoot")),
          fieldFrom(requiredArg(call.args, "visibilityHash")),
          fieldFrom(requiredArg(call.args, "originProofRoot"))
        );
        return;
      }

      if (label === "TurnKernel.finalizeTurn") {
        await context.turnKernel.finalizeTurn(
          fieldFrom(requiredArg(call.args, "turnIdHash")),
          fieldFrom(requiredArg(call.args, "finalTurnRoot")),
          fieldFrom(requiredArg(call.args, "settlementHash")),
          fieldFrom(requiredArg(call.args, "transcriptRoot")),
          uint64From(requiredArg(call.args, "finalizedAtSlot"))
        );
        return;
      }

      if (label === "TurnKernel.abortTurn") {
        await context.turnKernel.abortTurn(
          fieldFrom(requiredArg(call.args, "turnIdHash")),
          fieldFrom(requiredArg(call.args, "abortReasonHash")),
          fieldFrom(requiredArg(call.args, "reporterHash")),
          uint64From(requiredArg(call.args, "abortedAtSlot"))
        );
        return;
      }

      if (label === "ApprovalKernel.requestApproval") {
        await context.approvalKernel.requestApproval(
          fieldFrom(requiredArg(call.args, "approvalIdHash")),
          fieldFrom(requiredArg(call.args, "policyHash")),
          fieldFrom(requiredArg(call.args, "scopeHash")),
          uint64From(requiredArg(call.args, "expirySlot"))
        );
        return;
      }

      if (label === "ApprovalKernel.grantApproval") {
        await context.approvalKernel.grantApproval(
          fieldFrom(requiredArg(call.args, "requestLeaf")),
          fieldFrom(requiredArg(call.args, "decisionHash")),
          fieldFrom(requiredArg(call.args, "committeeDigest")),
          uint64From(requiredArg(call.args, "observedApprovals")),
          uint64From(requiredArg(call.args, "threshold"))
        );
        return;
      }

      if (label === "ApprovalKernel.delegateApproval") {
        await context.approvalKernel.delegateApproval(
          fieldFrom(requiredArg(call.args, "delegatorHash")),
          fieldFrom(requiredArg(call.args, "delegateeHash")),
          fieldFrom(requiredArg(call.args, "scopeHash")),
          uint64From(requiredArg(call.args, "expirySlot"))
        );
        return;
      }

      if (label === "ApprovalKernel.requestPrivacyException") {
        await context.approvalKernel.requestPrivacyException(
          fieldFrom(requiredArg(call.args, "exceptionIdHash")),
          fieldFrom(requiredArg(call.args, "scopeHash")),
          fieldFrom(requiredArg(call.args, "audienceHash")),
          fieldFrom(requiredArg(call.args, "severityHash")),
          uint64From(requiredArg(call.args, "expirySlot"))
        );
        return;
      }

      if (label === "DisclosureKernel.grantDisclosure") {
        await context.disclosureKernel.grantDisclosure(
          fieldFrom(requiredArg(call.args, "disclosureIdHash")),
          fieldFrom(requiredArg(call.args, "scopeHash")),
          fieldFrom(requiredArg(call.args, "audienceHash")),
          fieldFrom(requiredArg(call.args, "legalBasisHash")),
          fieldFrom(requiredArg(call.args, "retentionHash")),
          uint64From(requiredArg(call.args, "expirySlot"))
        );
        return;
      }

      if (label === "DisclosureKernel.revokeDisclosure") {
        await context.disclosureKernel.revokeDisclosure(
          fieldFrom(requiredArg(call.args, "disclosureIdHash")),
          fieldFrom(requiredArg(call.args, "revocationHash")),
          fieldFrom(requiredArg(call.args, "actorHash"))
        );
        return;
      }

      if (label === "EscrowKernel.depositCredits") {
        await context.escrowKernel.depositCredits(
          fieldFrom(requiredArg(call.args, "ownerHash")),
          fieldFrom(requiredArg(call.args, "depositIdHash")),
          uint64From(requiredArg(call.args, "amount")),
          fieldFrom(requiredArg(call.args, "policyHash"))
        );
        return;
      }

      if (label === "EscrowKernel.reserveBudget") {
        await context.escrowKernel.reserveBudget(
          fieldFrom(requiredArg(call.args, "turnIdHash")),
          fieldFrom(requiredArg(call.args, "reservationHash")),
          fieldFrom(requiredArg(call.args, "nullifierHash")),
          uint64From(requiredArg(call.args, "reservedAmount")),
          uint64From(requiredArg(call.args, "budgetEpoch"))
        );
        return;
      }

      if (label === "EscrowKernel.settleTurn") {
        await context.escrowKernel.settleTurn(
          fieldFrom(requiredArg(call.args, "turnIdHash")),
          uint64From(requiredArg(call.args, "reservedAmount")),
          uint64From(requiredArg(call.args, "payoutAmount")),
          uint64From(requiredArg(call.args, "refundedAmount")),
          uint64From(requiredArg(call.args, "feeAmount"))
        );
        return;
      }

      if (label === "EscrowKernel.refundTurn") {
        await context.escrowKernel.refundTurn(
          fieldFrom(requiredArg(call.args, "turnIdHash")),
          fieldFrom(requiredArg(call.args, "refundIdHash")),
          uint64From(requiredArg(call.args, "refundAmount")),
          fieldFrom(requiredArg(call.args, "nullifierHash"))
        );
        return;
      }

      throw new Error(`Unsupported prepared kernel call: ${label}`);
    }
  });
}

export async function executeLiveSessionTurnFlow(
  options: ExecuteLiveSessionTurnFlowOptions = {}
): Promise<LiveSessionTurnFlowReport> {
  const workspaceRoot = options.workspaceRoot ?? findWorkspaceRoot(process.cwd());
  const contractsDir = path.join(workspaceRoot, "packages", "contracts");
  const deploymentPath = path.join(contractsDir, "deployments", "latest-testnet.json");
  const witnessPlanPath =
    options.witnessPlanPath ?? path.join(contractsDir, "deployments", "latest-runtime-session-turn-plan.json");
  const reportPath = options.reportPath ?? path.join(contractsDir, "deployments", "latest-session-turn-flow.json");

  await loadLocalEnv(contractsDir);

  const deployment = await readJson<DeploymentManifestFile>(deploymentPath);
  const defaultRuntimeInput =
    !options.plan && !options.runtimeInput && !options.resume
      ? buildDefaultRuntimeLiveSessionTurnFlowInput({
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          ...(options.turnId ? { turnId: options.turnId } : {})
        })
      : undefined;
  const runtimeInput = options.runtimeInput ?? defaultRuntimeInput;
  const witnessPlan =
    options.plan ??
    (runtimeInput
      ? buildRuntimeFlowWitnessPlan(runtimeInput)
      : await readJson<DeploymentWitnessPlan>(witnessPlanPath));
  const existingReport = options.resume ? await readOptionalJson<LiveSessionTurnFlowReport>(reportPath) : undefined;
  const deployerSecret = process.env.DEPLOYER_PRIVATE_KEY;

  if (!deployerSecret) {
    throw new Error("DEPLOYER_PRIVATE_KEY must be set in packages/contracts/.env");
  }

  if (options.plan || runtimeInput) {
    await writeJson(witnessPlanPath, witnessPlan);
  }

  const resolvedSessionId =
    options.sessionId ?? runtimeInput?.sessionId ?? existingReport?.sessionId ?? DEFAULT_SESSION_ID;
  const resolvedTurnId =
    options.turnId ?? runtimeInput?.turnId ?? existingReport?.turnId ?? DEFAULT_TURN_ID;
  const resumeSteps =
    options.resume &&
    existingReport?.sessionId === resolvedSessionId &&
    existingReport?.turnId === resolvedTurnId &&
    Array.isArray(existingReport.steps)
      ? existingReport.steps
      : [];
  const report: LiveSessionTurnFlowReport = {
    scenarioId: witnessPlan.scenarioId ?? runtimeInput?.scenarioId ?? "demo-enterprise-private-run",
    sessionId: resolvedSessionId,
    turnId: resolvedTurnId,
    networkId: deployment.networkId ?? "testnet",
    generatedAtIso: existingReport?.generatedAtIso ?? new Date().toISOString(),
    deploymentPath,
    witnessPlanPath,
    reportType: "live-session-turn-flow",
    steps: [...resumeSteps]
  };
  const completedLabels = new Set(report.steps.map((step) => step.label));

  const persistReport = async (generatedAtIso = new Date().toISOString()) => {
    report.generatedAtIso = generatedAtIso;
    await writeJson(reportPath, report);
  };

  const deployer = PrivateKey.fromBase58(deployerSecret);
  const network = Mina.Network({
    networkId: deployment.networkId ?? process.env.ZEKO_NETWORK_ID ?? "testnet",
    mina: normalizeGraphqlEndpoint(deployment.mina ?? process.env.ZEKO_GRAPHQL ?? "https://testnet.zeko.io/graphql"),
    archive: normalizeGraphqlEndpoint(
      deployment.archive ?? process.env.ZEKO_ARCHIVE ?? "https://archive.testnet.zeko.io/graphql"
    )
  });
  Mina.setActiveInstance(network);

  const fee = deployment.fee ?? process.env.TX_FEE ?? "100000000";
  const sessionAddress = getRequiredAddress(deployment, "SessionKernel");
  const turnAddress = getRequiredAddress(deployment, "TurnKernel");
  const approvalAddress = getRequiredAddress(deployment, "ApprovalKernel");
  const disclosureAddress = getRequiredAddress(deployment, "DisclosureKernel");
  const escrowAddress = getRequiredAddress(deployment, "EscrowKernel");

  const sessionKernel = new SessionKernel(sessionAddress);
  const turnKernel = new TurnKernel(turnAddress);
  const approvalKernel = new ApprovalKernel(approvalAddress);
  const disclosureKernel = new DisclosureKernel(disclosureAddress);
  const escrowKernel = new EscrowKernel(escrowAddress);
  const executionContext: FlowExecutionContext = {
    deployer,
    fee,
    sessionKernel,
    turnKernel,
    approvalKernel,
    disclosureKernel,
    escrowKernel,
    sessionAddress,
    turnAddress,
    approvalAddress,
    disclosureAddress,
    escrowAddress
  };

  await SessionKernel.compile();
  await TurnKernel.compile();
  await ApprovalKernel.compile();
  await DisclosureKernel.compile();
  await EscrowKernel.compile();

  const contractCalls = witnessPlan.contracts as FlowPreparedKernelCall[];

  const pushStep = async (step: LiveSessionTurnFlowStepReport) => {
    report.steps.push(step);
    completedLabels.add(step.label);
    await persistReport(step.occurredAtIso);
    await options.onStep?.(step);
  };
  const runStep = async (label: string, task: () => Promise<LiveSessionTurnFlowStepReport>) => {
    if (completedLabels.has(label)) {
      return;
    }
    await pushStep(await task());
  };

  await persistReport(report.generatedAtIso);

  for (const call of contractCalls) {
    const label = `${call.kernel}.${call.method}`;
    await runStep(label, () => invokePreparedKernelCall(executionContext, call));
  }
  await persistReport(new Date().toISOString());

  return report;
}
