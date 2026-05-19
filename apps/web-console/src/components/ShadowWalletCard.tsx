import type { SessionSummary, ShadowWalletState, TrustModeId } from "@clawz/protocol";

type ValueInputEvent = { target: { value: string } };

export interface SessionLineageBadge {
  sessionId: string;
  trustModeId: TrustModeId;
  status: "idle" | "queued" | "running" | "in-flight" | "ready" | "disclosed" | "aborted" | "refunded" | "indexed";
  selected: boolean;
  turnCount: number;
  pendingExceptions: number;
  activeDisclosures: number;
  lastEventAtIso?: string;
  recentHistory: string[];
}

interface ShadowWalletCardProps {
  wallet: ShadowWalletState;
  session: SessionSummary;
  selectedSessionId: string;
  lineages: SessionLineageBadge[];
  onSelectSession: (sessionId: string) => void;
}

function shorten(value: string) {
  if (value.length <= 28) {
    return value;
  }
  return `${value.slice(0, 14)}...${value.slice(-10)}`;
}

function formatLineageStatus(status: SessionLineageBadge["status"]) {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "in-flight":
      return "In flight";
    case "ready":
      return "Ready";
    case "disclosed":
      return "Disclosure live";
    case "aborted":
      return "Aborted";
    case "refunded":
      return "Refunded";
    case "indexed":
      return "Indexed";
    default:
      return "Idle";
  }
}

function formatOutcome(outcome: string) {
  return outcome.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function formatTimestamp(value?: string) {
  if (!value) {
    return "No recent activity";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function ShadowWalletCard({
  wallet,
  session,
  selectedSessionId,
  lineages,
  onSelectSession
}: ShadowWalletCardProps) {
  return (
    <section className="panel hero-card">
      <p className="eyebrow">Operator View</p>
      <h1>ClawZ Console</h1>
      <p className="lede">
        Private agent sessions on Zeko, with trust-mode control, live lineage state, and governed
        action rails.
      </p>
      <div className="summary-strip compact-summary">
        <span className="subtle-pill">Focus {shorten(session.sessionId)}</span>
        <span className="subtle-pill">Mode {wallet.trustModeId}</span>
        <span className="subtle-pill">Budget {wallet.sponsoredRemainingMina} / {wallet.sponsoredBudgetMina} MINA</span>
        <span className="subtle-pill">{session.knownSessionIds?.length ?? 1} indexed sessions</span>
      </div>
      {session.knownSessionIds && session.knownSessionIds.length > 0 ? (
        <label className="session-picker">
          <span className="metric">Session focus</span>
          <select
            className="session-select"
            value={selectedSessionId}
            onChange={(event: ValueInputEvent) => {
              onSelectSession(event.target.value);
            }}
          >
            {session.knownSessionIds.map((sessionId) => (
              <option key={sessionId} value={sessionId}>
                {shorten(sessionId)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {lineages.length > 0 ? (
        <div className="lineage-board">
          {lineages.map((lineage) => (
            <button
              key={lineage.sessionId}
              type="button"
              className={`lineage-card ${lineage.selected ? "active" : ""}`}
              onClick={() => {
                onSelectSession(lineage.sessionId);
              }}
            >
              <div className="lineage-card-head">
                <strong>{shorten(lineage.sessionId)}</strong>
                <span className={`lineage-state lineage-state-${lineage.status}`}>
                  {formatLineageStatus(lineage.status)}
                </span>
              </div>
              <div className="lineage-badges">
                <span className="subtle-pill">mode {lineage.trustModeId}</span>
                <span className="subtle-pill">{lineage.turnCount} turns</span>
                {lineage.pendingExceptions > 0 ? (
                  <span className="subtle-pill">
                    {lineage.pendingExceptions} privacy exception{lineage.pendingExceptions === 1 ? "" : "s"}
                  </span>
                ) : null}
                {lineage.activeDisclosures > 0 ? (
                  <span className="subtle-pill">
                    {lineage.activeDisclosures} active disclosure{lineage.activeDisclosures === 1 ? "" : "s"}
                  </span>
                ) : null}
              </div>
              <div className="lineage-history">
                {lineage.recentHistory.length > 0 ? (
                  lineage.recentHistory.map((outcome) => (
                    <span key={`${lineage.sessionId}:${outcome}`} className="history-pill">
                      {formatOutcome(outcome)}
                    </span>
                  ))
                ) : (
                  <span className="history-pill">No recent turns</span>
                )}
              </div>
              <span className="metric">Last activity</span>
              <strong className="lineage-activity">{formatTimestamp(lineage.lastEventAtIso)}</strong>
            </button>
          ))}
        </div>
      ) : null}
      <div className="summary-strip">
        <span className="subtle-pill">{session.turnCount} turns in focus</span>
        <span className="subtle-pill">{session.sealedArtifactCount} sealed artifacts</span>
        <span className="subtle-pill">Focus source {(session.focusSource ?? "stored-default").replace(/-/g, " ")}</span>
      </div>
    </section>
  );
}
