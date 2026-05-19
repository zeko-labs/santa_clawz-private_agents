import { useState } from "react";

import type {
  LiveFlowTargets,
  LiveSessionTurnFlowState,
  ZekoDeploymentState
} from "@clawz/protocol";

type FlowKind = NonNullable<LiveSessionTurnFlowState["flowKind"]>;
type ValueInputEvent = { target: { value: string } };

interface FlowLaunchRequest {
  flowKind?: FlowKind;
  sessionId?: string;
  turnId?: string;
  sourceTurnId?: string;
  sourceDisclosureId?: string;
  abortReason?: string;
  revocationReason?: string;
  refundAmountMina?: string;
}

interface ZekoRailCardProps {
  deployment: ZekoDeploymentState;
  liveFlowTargets: LiveFlowTargets;
  liveFlow: LiveSessionTurnFlowState;
  focusedSessionId?: string;
  onRunFlow: (options?: FlowLaunchRequest) => void;
  pendingAction?: "live-flow";
}

const FLOW_CHOICES: Array<{
  id: FlowKind;
  label: string;
  summary: string;
}> = [
  {
    id: "first-turn",
    label: "First turn",
    summary: "Start a fresh session-turn bundle with new job-scoped ids."
  },
  {
    id: "next-turn",
    label: "Next turn",
    summary: "Checkpoint a completed turn and chain a governed follow-on turn."
  },
  {
    id: "abort-turn",
    label: "Abort",
    summary: "Abort an in-flight turn under a governed privacy-exception path."
  },
  {
    id: "refund-turn",
    label: "Refund",
    summary: "Return credits against a selected turn with an explicit amount."
  },
  {
    id: "revoke-disclosure",
    label: "Revoke disclosure",
    summary: "Close a previously granted disclosure window by disclosure id."
  }
];

function formatMode(mode: ZekoDeploymentState["mode"]) {
  if (mode === "testnet-live") {
    return "Live testnet";
  }
  if (mode === "planned-testnet") {
    return "Planned testnet";
  }
  return "Local runtime";
}

function shorten(value?: string) {
  if (!value) {
    return "Pending";
  }
  if (value.length <= 24) {
    return value;
  }
  return `${value.slice(0, 12)}...${value.slice(-10)}`;
}

function formatTimestamp(value?: string) {
  if (!value) {
    return "Not deployed";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatFlowLabel(flowKind: FlowKind) {
  const match = FLOW_CHOICES.find((choice) => choice.id === flowKind);
  return match?.label ?? flowKind;
}

function formatTurnLabel(turnId: string) {
  return turnId.startsWith("turn_") ? turnId.replace("turn_", "Turn ") : shorten(turnId);
}

export function ZekoRailCard({
  deployment,
  liveFlowTargets,
  liveFlow,
  focusedSessionId,
  onRunFlow,
  pendingAction
}: ZekoRailCardProps) {
  const [selectedFlowKind, setSelectedFlowKind] = useState<FlowKind>("first-turn");
  const [selectedTurnId, setSelectedTurnId] = useState<string>("");
  const [selectedDisclosureId, setSelectedDisclosureId] = useState<string>("");
  const [abortReason, setAbortReason] = useState("governed-abort-requested");
  const [refundAmountMina, setRefundAmountMina] = useState("0.05");
  const [revocationReason, setRevocationReason] = useState("governed-review-window-expired");

  const canRunFlow = deployment.mode === "testnet-live";
  const latestStep = liveFlow.steps.at(-1);
  const recentSteps = liveFlow.steps.slice(-2).reverse();
  const isRunning =
    pendingAction === "live-flow" || liveFlow.status === "running" || liveFlow.status === "queued";
  const scopedTurns = focusedSessionId
    ? liveFlowTargets.turns.filter((target) => target.sessionId === focusedSessionId)
    : liveFlowTargets.turns;
  const scopedDisclosures = focusedSessionId
    ? liveFlowTargets.disclosures.filter((target) => target.sessionId === focusedSessionId)
    : liveFlowTargets.disclosures;
  const activeDisclosures = scopedDisclosures.filter((target) => target.active);
  const nextTurnTargets = scopedTurns.filter((target) => target.canStartNextTurn);
  const abortTargets = scopedTurns.filter((target) => target.canAbort);
  const refundTargets = scopedTurns;

  const selectedNextTurnTarget =
    nextTurnTargets.find((target) => target.turnId === selectedTurnId) ?? nextTurnTargets[0];
  const selectedAbortTarget = abortTargets.find((target) => target.turnId === selectedTurnId) ?? abortTargets[0];
  const selectedRefundTarget =
    refundTargets.find((target) => target.turnId === selectedTurnId) ?? refundTargets[0];
  const selectedDisclosure =
    activeDisclosures.find((target) => target.disclosureId === selectedDisclosureId) ?? activeDisclosures[0];

  const selectedTurnTarget =
    selectedFlowKind === "next-turn"
      ? selectedNextTurnTarget
      : selectedFlowKind === "abort-turn"
        ? selectedAbortTarget
        : selectedFlowKind === "refund-turn"
          ? selectedRefundTarget
          : undefined;
  const selectedChoice = FLOW_CHOICES.find((choice) => choice.id === selectedFlowKind) ?? FLOW_CHOICES[0]!;
  const trimmedRefundAmount = refundAmountMina.trim();
  const refundAmountIsValid = trimmedRefundAmount.length > 0 && /^\d+(\.\d+)?$/.test(trimmedRefundAmount);
  const waitingOnResume = liveFlow.resumeAvailable && liveFlow.flowKind === selectedFlowKind;
  const actionLabel = isRunning
    ? "Submitting on Zeko..."
    : waitingOnResume
      ? `Resume ${formatFlowLabel(selectedFlowKind)}`
      : `Launch ${formatFlowLabel(selectedFlowKind)}`;

  const missingTarget =
    (selectedFlowKind === "next-turn" && !selectedNextTurnTarget) ||
    (selectedFlowKind === "abort-turn" && !selectedAbortTarget) ||
    (selectedFlowKind === "refund-turn" && !selectedRefundTarget) ||
    (selectedFlowKind === "revoke-disclosure" && !selectedDisclosure);
  const runDisabled = !canRunFlow || isRunning || missingTarget || (selectedFlowKind === "refund-turn" && !refundAmountIsValid);

  const submitLaunch = () => {
    const request: FlowLaunchRequest = {
      flowKind: selectedFlowKind
    };

    if (selectedFlowKind === "next-turn" && selectedNextTurnTarget) {
      request.sessionId = selectedNextTurnTarget.sessionId;
      request.sourceTurnId = selectedNextTurnTarget.turnId;
    }

    if (selectedFlowKind === "abort-turn" && selectedAbortTarget) {
      request.sessionId = selectedAbortTarget.sessionId;
      request.turnId = selectedAbortTarget.turnId;
      if (abortReason.trim().length > 0) {
        request.abortReason = abortReason.trim();
      }
    }

    if (selectedFlowKind === "refund-turn" && selectedRefundTarget) {
      request.sessionId = selectedRefundTarget.sessionId;
      request.turnId = selectedRefundTarget.turnId;
      request.refundAmountMina = trimmedRefundAmount;
    }

    if (selectedFlowKind === "revoke-disclosure" && selectedDisclosure) {
      request.sessionId = selectedDisclosure.sessionId;
      request.turnId = selectedDisclosure.turnId;
      request.sourceDisclosureId = selectedDisclosure.disclosureId;
      if (revocationReason.trim().length > 0) {
        request.revocationReason = revocationReason.trim();
      }
    }

    onRunFlow(request);
  };

  const renderFlowFields = () => {
    if (selectedFlowKind === "first-turn") {
      return (
        <div className="launcher-note">
          <span className="metric">Launch mode</span>
          <strong>Fresh session + turn ids</strong>
          <p className="panel-copy">
            ClawZ will mint a new session/turn lineage and commit the full governed first-turn path.
          </p>
        </div>
      );
    }

    if (selectedFlowKind === "next-turn") {
      return (
        <div className="launcher-grid">
          <label className="launcher-field">
            <span>Source turn</span>
            <select
              className="launcher-input"
              value={selectedNextTurnTarget?.turnId ?? ""}
              onChange={(event: ValueInputEvent) => {
                setSelectedTurnId(event.target.value);
              }}
            >
              {nextTurnTargets.map((target) => (
                <option key={`${target.sessionId}:${target.turnId}`} value={target.turnId}>
                  {formatTurnLabel(target.turnId)} · {shorten(target.sessionId)}
                </option>
              ))}
            </select>
          </label>
          <div className="launcher-note">
            <span className="metric">Chain target</span>
            <strong>{selectedNextTurnTarget ? shorten(selectedNextTurnTarget.sessionId) : "No finalized turn yet"}</strong>
            <p className="panel-copy">
              {selectedNextTurnTarget
                ? `Checkpoint ${formatTurnLabel(selectedNextTurnTarget.turnId)} and create a new governed follow-on turn.`
                : "A next-turn launch unlocks after at least one finalized turn is indexed."}
            </p>
          </div>
        </div>
      );
    }

    if (selectedFlowKind === "abort-turn") {
      return (
        <div className="launcher-grid">
          <label className="launcher-field">
            <span>In-flight turn</span>
            <select
              className="launcher-input"
              value={selectedAbortTarget?.turnId ?? ""}
              onChange={(event: ValueInputEvent) => {
                setSelectedTurnId(event.target.value);
              }}
            >
              {abortTargets.map((target) => (
                <option key={`${target.sessionId}:${target.turnId}`} value={target.turnId}>
                  {formatTurnLabel(target.turnId)} · {shorten(target.sessionId)}
                </option>
              ))}
            </select>
          </label>
          <label className="launcher-field">
            <span>Abort reason</span>
            <input
              className="launcher-input"
              value={abortReason}
              onChange={(event: ValueInputEvent) => {
                setAbortReason(event.target.value);
              }}
              placeholder="governed-abort-requested"
            />
          </label>
        </div>
      );
    }

    if (selectedFlowKind === "refund-turn") {
      return (
        <div className="launcher-grid">
          <label className="launcher-field">
            <span>Refund turn</span>
            <select
              className="launcher-input"
              value={selectedRefundTarget?.turnId ?? ""}
              onChange={(event: ValueInputEvent) => {
                setSelectedTurnId(event.target.value);
              }}
            >
              {refundTargets.map((target) => (
                <option key={`${target.sessionId}:${target.turnId}`} value={target.turnId}>
                  {formatTurnLabel(target.turnId)} · {shorten(target.sessionId)}
                </option>
              ))}
            </select>
          </label>
          <label className="launcher-field">
            <span>Refund amount (MINA)</span>
            <input
              className="launcher-input"
              value={refundAmountMina}
              onChange={(event: ValueInputEvent) => {
                setRefundAmountMina(event.target.value);
              }}
              placeholder="0.05"
            />
          </label>
        </div>
      );
    }

    return (
      <div className="launcher-grid">
        <label className="launcher-field">
          <span>Disclosure window</span>
          <select
            className="launcher-input"
            value={selectedDisclosure?.disclosureId ?? ""}
            onChange={(event: ValueInputEvent) => {
              setSelectedDisclosureId(event.target.value);
            }}
          >
            {activeDisclosures.map((target) => (
              <option key={target.disclosureId} value={target.disclosureId}>
                {shorten(target.disclosureId)} · {formatTurnLabel(target.turnId)}
              </option>
            ))}
          </select>
        </label>
        <label className="launcher-field">
          <span>Revocation reason</span>
          <input
            className="launcher-input"
            value={revocationReason}
            onChange={(event: ValueInputEvent) => {
              setRevocationReason(event.target.value);
            }}
            placeholder="governed-review-window-expired"
          />
        </label>
      </div>
    );
  };

  const renderTargetSummary = () => {
    if (selectedFlowKind === "revoke-disclosure") {
      return (
        <article className="kernel-card launcher-card">
          <div className="panel-head">
            <strong>Disclosure target</strong>
            <span className="subtle-pill">
              {selectedDisclosure?.active ? "active" : "awaiting selection"}
            </span>
          </div>
          <span className="kernel-address" title={selectedDisclosure?.disclosureId}>
            {selectedDisclosure ? shorten(selectedDisclosure.disclosureId) : "No active disclosure yet"}
          </span>
          <div className="kernel-meta">
            <span className="subtle-pill">
              {selectedDisclosure ? shorten(selectedDisclosure.sessionId) : "Select a disclosure"}
            </span>
            <span className="subtle-pill">
              {selectedDisclosure ? formatTurnLabel(selectedDisclosure.turnId) : "No turn selected"}
            </span>
            {selectedDisclosure?.grantedAtIso ? (
              <span className="subtle-pill">{formatTimestamp(selectedDisclosure.grantedAtIso)}</span>
            ) : null}
          </div>
        </article>
      );
    }

    return (
      <article className="kernel-card launcher-card">
        <div className="panel-head">
          <strong>Lineage target</strong>
          <span className="subtle-pill">
            {selectedTurnTarget ? selectedTurnTarget.latestEventType : "awaiting selection"}
          </span>
        </div>
        <span className="kernel-address" title={selectedTurnTarget?.turnId}>
          {selectedTurnTarget ? selectedTurnTarget.turnId : "No indexed target available"}
        </span>
        <div className="kernel-meta">
          <span className="subtle-pill">
            {selectedTurnTarget ? shorten(selectedTurnTarget.sessionId) : "Choose a target turn"}
          </span>
          {selectedTurnTarget?.latestDisclosureId ? (
            <span className="subtle-pill">disclosure {shorten(selectedTurnTarget.latestDisclosureId)}</span>
          ) : null}
          {selectedTurnTarget?.spentMina ? (
            <span className="subtle-pill">spent {selectedTurnTarget.spentMina} MINA</span>
          ) : null}
          {selectedTurnTarget?.refundedMina ? (
            <span className="subtle-pill">refunded {selectedTurnTarget.refundedMina} MINA</span>
          ) : null}
          {selectedTurnTarget?.lastOccurredAtIso ? (
            <span className="subtle-pill">{formatTimestamp(selectedTurnTarget.lastOccurredAtIso)}</span>
          ) : null}
        </div>
      </article>
    );
  };

  return (
    <section className="panel accent-panel wide-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Live Rail</p>
          <h2>Zeko Rail</h2>
        </div>
        <span className="proof-pill">{formatMode(deployment.mode)}</span>
      </div>

      <p className="panel-copy">
        The live coordination rail is online and ready for first-turn, next-turn, abort, refund,
        and disclosure-revocation flows.
      </p>

      <div className="deployment-grid">
        <div>
          <span className="metric">Network</span>
          <strong>{deployment.networkId}</strong>
        </div>
        <div>
          <span className="metric">Rail status</span>
          <strong>{liveFlow.status}</strong>
        </div>
        <div>
          <span className="metric">Focused turns</span>
          <strong>{scopedTurns.length}</strong>
        </div>
        <div>
          <span className="metric">Active disclosures</span>
          <strong>{activeDisclosures.length}</strong>
        </div>
      </div>

      <div className="action-row">
        <span className="subtle-pill">
          {deployment.privacyGrade === "production-grade" ? "Enterprise privacy active" : "Pilot privacy mode"}
        </span>
        <span className="subtle-pill">{deployment.keyManagement.replace(/-/g, " ")}</span>
      </div>

      <p className="panel-copy">{deployment.privacyNote}</p>

      {focusedSessionId ? (
        <div className="action-row">
          <span className="subtle-pill">Focused session: {shorten(focusedSessionId)}</span>
          <span className="subtle-pill">Disclosures: {scopedDisclosures.length}</span>
          {liveFlow.generatedAtIso ? (
            <span className="subtle-pill">Last run {formatTimestamp(liveFlow.generatedAtIso)}</span>
          ) : null}
        </div>
      ) : null}

      <div className="flow-strip">
        <div>
          <span className="metric">Live flow status</span>
          <strong>{liveFlow.status}</strong>
        </div>
        <div>
          <span className="metric">Current flow</span>
          <strong>{liveFlow.flowKind ? formatFlowLabel(liveFlow.flowKind) : "Not yet run"}</strong>
        </div>
        <div>
          <span className="metric">Current lineage</span>
          <strong>{shorten(liveFlow.turnId)}</strong>
        </div>
        <div>
          <span className="metric">Current step</span>
          <strong>{liveFlow.currentStepLabel ?? latestStep?.label ?? "None yet"}</strong>
        </div>
      </div>

      <section className="launcher-shell">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Lifecycle Launcher</p>
            <h3>{selectedChoice.label}</h3>
          </div>
          <span className="subtle-pill">{selectedChoice.summary}</span>
        </div>

        <div className="dial-row">
          {FLOW_CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              className={`dial-chip ${selectedFlowKind === choice.id ? "active" : ""}`}
              onClick={() => {
                setSelectedFlowKind(choice.id);
              }}
            >
              {choice.label}
            </button>
          ))}
        </div>

        {renderFlowFields()}
        {renderTargetSummary()}

        <div className="action-row">
          <button className="action-button" onClick={submitLaunch} disabled={runDisabled}>
            {actionLabel}
          </button>
          {!canRunFlow ? (
            <span className="subtle-pill">Live execution unlocks after a testnet deployment is loaded.</span>
          ) : null}
          {missingTarget ? (
            <span className="subtle-pill">This action needs an indexed target before it can be submitted.</span>
          ) : null}
          {selectedFlowKind === "refund-turn" && !refundAmountIsValid ? (
            <span className="subtle-pill">Enter a MINA amount like 0.05.</span>
          ) : null}
          {liveFlow.resumeAvailable && liveFlow.resumeFromStepLabel ? (
            <span className="subtle-pill">Resume from {liveFlow.resumeFromStepLabel}</span>
          ) : null}
          {liveFlow.lastError ? <span className="subtle-pill">Last error: {liveFlow.lastError}</span> : null}
        </div>
      </section>

      <div className="action-row">
        <span className="subtle-pill">{liveFlow.stepCount}/{liveFlow.totalSteps} steps</span>
        {typeof liveFlow.attemptCount === "number" ? (
          <span className="subtle-pill">Attempt {liveFlow.attemptCount}</span>
        ) : null}
        {liveFlow.sourceTurnId ? <span className="subtle-pill">Source turn: {shorten(liveFlow.sourceTurnId)}</span> : null}
        {liveFlow.sourceDisclosureId ? (
          <span className="subtle-pill">Disclosure: {shorten(liveFlow.sourceDisclosureId)}</span>
        ) : null}
      </div>

      {recentSteps.length > 0 ? (
        <div className="kernel-list live-flow-list">
          {recentSteps.map((step) => (
            <article key={`${step.label}:${step.txHash}`} className="kernel-card">
              <div className="panel-head">
                <strong>{step.label}</strong>
                <span className="subtle-pill">{step.changedSlots.length} slot changes</span>
              </div>
              <a
                className="kernel-address"
                href={`https://zekoscan.io/testnet/tx/${step.txHash}`}
                target="_blank"
                rel="noreferrer"
                title={step.txHash}
              >
                {shorten(step.txHash)}
              </a>
              <div className="kernel-meta">
                <span className="subtle-pill">{shorten(step.contractAddress)}</span>
                {step.occurredAtIso ? <span className="subtle-pill">{formatTimestamp(step.occurredAtIso)}</span> : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
