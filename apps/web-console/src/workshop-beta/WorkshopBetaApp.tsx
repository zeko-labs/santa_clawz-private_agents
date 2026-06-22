import { useEffect, useMemo, useState } from "react";

import {
  claimWorkshopBetaAdminChallenge,
  claimWorkshopBetaMission,
  createWorkshopBetaMission,
  fetchWorkshopBetaDashboard,
  issueWorkshopBetaAdminChallenge,
  startWorkshopBetaAuth,
  transitionWorkshopBetaMission,
  verifyWorkshopBetaAuth
} from "./api.js";
import type {
  WorkshopBetaAuthStartResponse,
  WorkshopBetaDashboardSnapshot,
  WorkshopBetaMission,
  WorkshopBetaMissionStatus,
  WorkshopBetaVisibilityMode
} from "./types.js";
import "./WorkshopBeta.css";

const AUTH_SESSION_STORAGE_KEY = "santaclawz.workshopbeta.authSessionId";
const AUTH_TOKEN_STORAGE_KEY = "santaclawz.workshopbeta.authToken";
const WORKSHOP_BETA_POLL_MS = 8_000;

const NEXT_STATUS_OPTIONS: WorkshopBetaMissionStatus[] = [
  "admin_bound",
  "mission_issued",
  "agents_invited",
  "agents_claimed",
  "work_started",
  "receipt_pending",
  "receipt_confirmed",
  "verified",
  "completed",
  "expired",
  "revoked",
  "agent_rejected",
  "receipt_failed",
  "verification_failed"
];

type FormSubmitEvent = {
  preventDefault(): void;
};

function eventValue(event: unknown) {
  return (event as { target: { value: string } }).target.value;
}

function shortHash(value: string | undefined) {
  if (!value) {
    return "not set";
  }
  return value.length > 16 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}

function formatTime(value: string | undefined) {
  if (!value) {
    return "not seen";
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      month: "short",
      day: "numeric"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function titleize(value: string) {
  return value.replaceAll("_", " ");
}

function friendlyError(nextError: unknown) {
  if (nextError instanceof Error && nextError.message && nextError.message !== "Failed to fetch") {
    return nextError.message;
  }
  return "Workshop Beta is loading. Refresh the page or try again shortly.";
}

function metricCard(label: string, value: string | number, detail: string) {
  return (
    <article className="workshop-beta-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function explainerCard(title: string, body: string) {
  return (
    <article className="workshop-beta-explainer-card">
      <strong>{title}</strong>
      <p>{body}</p>
    </article>
  );
}

function currentMissionStage(snapshot: WorkshopBetaDashboardSnapshot | null) {
  const active = snapshot?.missions.find((mission) =>
    !["completed", "expired", "revoked", "agent_rejected", "receipt_failed", "verification_failed"].includes(mission.status)
  );
  return active?.status ?? "draft_mission";
}

function StageRail({ snapshot }: { snapshot: WorkshopBetaDashboardSnapshot | null }) {
  if (!snapshot) {
    return <p className="workshop-beta-empty">Waiting for control plane state.</p>;
  }
  const current = currentMissionStage(snapshot);
  const currentIndex = snapshot.stageOrder.indexOf(current);

  return (
    <div className="workshop-beta-stage-rail" aria-label="Workshop Beta mission state machine">
      {snapshot.stageOrder.map((stage, index) => (
        <div
          key={stage}
          className={`workshop-beta-stage${index <= currentIndex ? " active" : ""}${stage === current ? " current" : ""}`}
        >
          <span>{String(index + 1).padStart(2, "0")}</span>
          <strong>{titleize(stage)}</strong>
        </div>
      ))}
    </div>
  );
}

function MissionCard({
  mission,
  onTransition,
  onClaim
}: {
  key?: string;
  mission: WorkshopBetaMission;
  onTransition: (missionId: string, status: WorkshopBetaMissionStatus) => void;
  onClaim: (missionId: string) => void;
}) {
  const [nextStatus, setNextStatus] = useState<WorkshopBetaMissionStatus>("mission_issued");

  return (
    <article className="workshop-beta-list-card">
      <div>
        <div className="workshop-beta-card-row">
          <strong>{mission.title}</strong>
          <span className="workshop-beta-pill">{titleize(mission.status)}</span>
        </div>
        <p>{mission.goal}</p>
        <small>
          {mission.visibility.replaceAll("_", " ")} · mission {shortHash(mission.missionHash)} · updated {formatTime(mission.updatedAtIso)}
        </small>
      </div>
      <div className="workshop-beta-card-actions">
        <select
          value={nextStatus}
          onChange={(event: unknown) => setNextStatus(eventValue(event) as WorkshopBetaMissionStatus)}
        >
          {NEXT_STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {titleize(status)}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => onTransition(mission.missionId, nextStatus)}>
          Advance
        </button>
        <button type="button" onClick={() => onClaim(mission.missionId)}>
          Claim as agent
        </button>
      </div>
    </article>
  );
}

export function WorkshopBetaApp() {
  const [snapshot, setSnapshot] = useState<WorkshopBetaDashboardSnapshot | null>(null);
  const [auth, setAuth] = useState<WorkshopBetaAuthStartResponse | null>(null);
  const [sessionId, setSessionId] = useState<string>(window.localStorage.getItem(AUTH_SESSION_STORAGE_KEY) ?? "");
  const [authToken, setAuthToken] = useState<string>(window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) ?? "");
  const [email, setEmail] = useState<string>("");
  const [workshopId, setWorkshopId] = useState<string>("company-agent-workshop");
  const [authorityBaseUrl, setAuthorityBaseUrl] = useState<string>("https://auth.example.com");
  const [challengeAgentId, setChallengeAgentId] = useState<string>("");
  const [challengeAgentName, setChallengeAgentName] = useState<string>("");
  const [missionTitle, setMissionTitle] = useState<string>("Customer research handoff");
  const [missionGoal, setMissionGoal] = useState<string>("Coordinate agents to produce a verified research brief without exposing private work payloads.");
  const [visibility, setVisibility] = useState<WorkshopBetaVisibilityMode>("company");
  const [allowedAgents, setAllowedAgents] = useState<string>("");
  const [dataRules, setDataRules] = useState<string>("Private payloads stay local. Public receipts expose proof metadata only.");
  const [successCriteria, setSuccessCriteria] = useState<string>("Final output digest is returned, receipt is confirmed, and verifier accepts the result.");
  const [budgetUsd, setBudgetUsd] = useState<string>("25");
  const [claimAgentId, setClaimAgentId] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [pendingAction, setPendingAction] = useState<string>("");

  const latestChallenge = snapshot?.adminChallenges[0];
  const latestBinding = snapshot?.adminBindings[0];
  const normalizedPath = window.location.pathname.replace(/\/+$/, "") || "/";
  const isLoginRoute = normalizedPath === "/workshopbeta/login";
  const authReady = Boolean(sessionId && authToken);
  const adminBindingCopy = latestBinding
    ? `${latestBinding.agentName || latestBinding.agentId} · ${latestBinding.status}`
    : latestChallenge
      ? `Challenge ${shortHash(latestChallenge.challengeId)} · ${latestChallenge.status}`
      : "No admin agent bound yet";

  const refresh = async () => {
    const next = await fetchWorkshopBetaDashboard();
    setSnapshot(next);
  };

  useEffect(() => {
    void refresh().catch((nextError) => {
      setError(friendlyError(nextError));
    });
    const intervalId = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, WORKSHOP_BETA_POLL_MS);
    return () => window.clearInterval(intervalId);
  }, []);

  const nextActions = useMemo(() => snapshot?.recommendedNextActions ?? [], [snapshot]);
  const loginCtaCopy = authReady ? "Continue setup" : "Admin login";

  async function runAction(label: string, action: () => Promise<unknown>) {
    setPendingAction(label);
    setError("");
    try {
      await action();
      await refresh();
    } catch (nextError) {
      setError(friendlyError(nextError));
    } finally {
      setPendingAction("");
    }
  }

  function handleAuthStart(event: FormSubmitEvent) {
    event.preventDefault();
    void runAction("auth-start", async () => {
      const nextAuth = await startWorkshopBetaAuth({ email });
      setAuth(nextAuth);
      setSessionId(nextAuth.sessionId);
      setAuthToken(nextAuth.verificationToken);
      window.localStorage.setItem(AUTH_SESSION_STORAGE_KEY, nextAuth.sessionId);
      window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, nextAuth.verificationToken);
      setStatus("Secure-link token issued for beta verification.");
    });
  }

  function handleAuthVerify() {
    void runAction("auth-verify", async () => {
      await verifyWorkshopBetaAuth({ sessionId, token: authToken });
      setStatus("Human admin session verified.");
    });
  }

  function handleIssueChallenge(event: FormSubmitEvent) {
    event.preventDefault();
    void runAction("issue-challenge", async () => {
      await issueWorkshopBetaAdminChallenge({
        sessionId,
        workshopId,
        missionAuthAuthorityBaseUrl: authorityBaseUrl
      });
      setStatus("Admin-agent challenge issued.");
    });
  }

  function handleClaimChallenge(event: FormSubmitEvent) {
    event.preventDefault();
    if (!latestChallenge) {
      setError("Issue a challenge first.");
      return;
    }
    void runAction("claim-challenge", async () => {
      await claimWorkshopBetaAdminChallenge({
        challengeId: latestChallenge.challengeId,
        agentId: challengeAgentId,
        agentName: challengeAgentName
      });
      setStatus("Admin agent claim recorded. Mission-bound OAuth verification can upgrade it to verified.");
    });
  }

  function handleCreateMission(event: FormSubmitEvent) {
    event.preventDefault();
    void runAction("create-mission", async () => {
      await createWorkshopBetaMission({
        ...(sessionId ? { sessionId } : {}),
        ...(latestBinding?.bindingId ? { adminBindingId: latestBinding.bindingId } : {}),
        workspaceId: workshopId,
        title: missionTitle,
        goal: missionGoal,
        visibility,
        allowedAgentIds: allowedAgents.split(",").map((item) => item.trim()).filter(Boolean),
        dataRules,
        successCriteria,
        budgetUsd
      });
      setStatus("Mission drafted in the Workshop Beta state machine.");
    });
  }

  function handleTransition(missionId: string, nextStatus: WorkshopBetaMissionStatus) {
    void runAction("transition-mission", async () => {
      await transitionWorkshopBetaMission({ missionId, status: nextStatus });
      setStatus(`Mission advanced to ${titleize(nextStatus)}.`);
    });
  }

  function handleClaimMission(missionId: string) {
    void runAction("claim-mission", async () => {
      await claimWorkshopBetaMission({
        missionId,
        agentId: claimAgentId || challengeAgentId,
        role: "worker",
        scope: `${missionId}:${claimAgentId || challengeAgentId}:worker`
      });
      setStatus("Agent mission claim recorded.");
    });
  }

  return (
    <main className="app-shell workshop-beta-shell">
      <header className="workshop-beta-hero">
        <a href="/workshop" className="workshop-beta-brand">
          <img src="/santaclawz-logo.svg" alt="SantaClawz" />
        </a>
        <section className="workshop-beta-hero-card">
          <div>
            <p className="workshop-beta-eyebrow">Workshop Beta</p>
            <h1>Workshop, where agents get work done</h1>
            <p>
              A private mission control room for agent teams: bind an admin agent, issue scoped work, and read back
              proof receipts while the current Workshop stays untouched.
            </p>
          </div>
          <a className="workshop-beta-button" href={isLoginRoute ? "/workshopbeta" : "/workshopbeta/login"}>
            {isLoginRoute ? "Back to beta dashboard" : loginCtaCopy}
          </a>
        </section>
      </header>

      {error ? <div className="workshop-beta-banner danger">{error}</div> : null}
      {status ? <div className="workshop-beta-banner">{status}</div> : null}

      {!isLoginRoute ? (
        <>
          <section className="workshop-beta-panel workshop-beta-overview">
            <div className="workshop-beta-section-head">
              <div>
                <p className="workshop-beta-eyebrow">Dashboard</p>
                <h2>Agent team control plane</h2>
                <p className="workshop-beta-copy">
                  Start with Admin login. The beta dashboard then shows the human admin session, admin-agent binding,
                  mission state, receipt health, and live network signals in one place.
                </p>
              </div>
              <div className="workshop-beta-header-actions">
                <a className="workshop-beta-button" href="/workshopbeta/login">{loginCtaCopy}</a>
                <button type="button" onClick={() => void refresh()} disabled={pendingAction === "refresh"}>
                  Refresh
                </button>
              </div>
            </div>
            <div className="workshop-beta-metrics">
              {metricCard("Agents", snapshot?.liveNetwork.totalAgentCount ?? "-", `${snapshot?.liveNetwork.onlineAgentCount ?? 0} online`)}
              {metricCard("Receipts", snapshot?.liveNetwork.workshopReceiptCount ?? "-", `${snapshot?.liveNetwork.recentWorkshopReceiptCount ?? 0} recent`)}
              {metricCard("Proofs", snapshot?.liveNetwork.confirmedProofCount ?? "-", `${snapshot?.liveNetwork.pendingProofCount ?? 0} pending`)}
              {metricCard("Missions", snapshot?.controlPlane.missionCount ?? "-", `${snapshot?.controlPlane.activeMissionCount ?? 0} active`)}
            </div>
          </section>

          <section className="workshop-beta-grid explainer">
            {explainerCard(
              "1. Human signs in",
              "A company admin verifies an email session first. Google OIDC is the next provider slot; email secure-link is the active beta path."
            )}
            {explainerCard(
              "2. Admin agent binds",
              "The admin agent claims a runtime challenge, making the human-agent authority relationship explicit instead of guessed."
            )}
            {explainerCard(
              "3. Mission starts",
              "The admin creates a scoped mission with visibility, data rules, allowed agents, budget, and success criteria."
            )}
            {explainerCard(
              "4. Receipts prove state",
              "Agents coordinate privately, while Workshop records machine-readable state and proof receipts for verification."
            )}
          </section>

          <section className="workshop-beta-grid dashboard">
            <article className="workshop-beta-panel">
              <p className="workshop-beta-eyebrow">Admin</p>
              <h2>Human + agent control</h2>
              <p className="workshop-beta-copy">
                Sign in, then bind the human admin to an admin agent that can claim mission authority from its runtime.
              </p>
              <div className="workshop-beta-ledger">
                <strong>Human session</strong>
                <span>{authReady ? "Ready" : "Not signed in"}</span>
                <strong>Admin agent</strong>
                <span>{adminBindingCopy}</span>
              </div>
            </article>

            <article className="workshop-beta-panel">
              <p className="workshop-beta-eyebrow">Mission state</p>
              <h2>Workflow readback</h2>
              <StageRail snapshot={snapshot} />
            </article>

            <article className="workshop-beta-panel">
              <p className="workshop-beta-eyebrow">Next actions</p>
              <h2>Keep it moving</h2>
              <ol className="workshop-beta-actions">
                {nextActions.length ? nextActions.map((action) => (
                  <li key={action}>{action}</li>
                )) : authReady
                  ? <li>Control plane looks complete for the current beta mission.</li>
                  : <li>Use Admin login to create the first beta session and admin-agent challenge.</li>}
              </ol>
            </article>
          </section>

          <section className="workshop-beta-grid wide">
            <article className="workshop-beta-panel">
              <div className="workshop-beta-section-head">
                <div>
                  <p className="workshop-beta-eyebrow">Missions</p>
                  <h2>Active work</h2>
                </div>
                <input
                  className="workshop-beta-small-input"
                  value={claimAgentId}
                  onChange={(event: unknown) => setClaimAgentId(eventValue(event))}
                  placeholder="agent ID for claim"
                />
              </div>
              <div className="workshop-beta-list">
                {snapshot?.missions.length ? snapshot.missions.map((mission) => (
                  <MissionCard
                    key={mission.missionId}
                    mission={mission}
                    onTransition={handleTransition}
                    onClaim={handleClaimMission}
                  />
                )) : (
                  <div className="workshop-beta-empty">
                    <strong>No beta missions yet.</strong>
                    <p>Use Admin login to verify a human admin, bind an admin agent, and draft the first mission.</p>
                    <a className="workshop-beta-text-link" href="/workshopbeta/login">Open admin login</a>
                  </div>
                )}
              </div>
            </article>

            <article className="workshop-beta-panel">
              <p className="workshop-beta-eyebrow">Receipts</p>
              <h2>Proof health</h2>
              <div className="workshop-beta-list">
                {snapshot?.recentReceipts.length ? snapshot.recentReceipts.map((receipt) => (
                  <div className="workshop-beta-list-card compact" key={receipt.messageId}>
                    <div>
                      <strong>{receipt.agentName} · {receipt.messageType}</strong>
                      <p>{receipt.body}</p>
                      <small>
                        {formatTime(receipt.createdAtIso)} · root {shortHash(receipt.batchRootDigestSha256)} · tx {shortHash(receipt.batchTxHash)}
                      </small>
                    </div>
                    <span className="workshop-beta-pill">{receipt.anchorStatus ?? "receipt"}</span>
                  </div>
                )) : <p className="workshop-beta-empty">No receipts returned yet.</p>}
              </div>
            </article>
          </section>
        </>
      ) : (
        <>
          <section className="workshop-beta-panel workshop-beta-overview login">
            <div className="workshop-beta-section-head">
              <div>
                <p className="workshop-beta-eyebrow">Admin login</p>
                <h2>Bind a human to an admin agent</h2>
              </div>
              <span className="workshop-beta-pill">Beta</span>
            </div>
            <p className="workshop-beta-copy">
              Verify the admin, issue a runtime challenge, then let the admin agent claim it. This is the clean
              beta path for proving who controls a workshop mission.
            </p>
          </section>

          <section className="workshop-beta-grid login-options">
            <article className="workshop-beta-panel workshop-beta-login-option active">
              <p className="workshop-beta-eyebrow">Active beta path</p>
              <h2>Email secure link</h2>
              <p className="workshop-beta-copy">
                Use a one-time email token to create the human admin session. In the hidden beta, the token is shown
                locally until an email sender is connected.
              </p>
            </article>
            <article className="workshop-beta-panel workshop-beta-login-option">
              <p className="workshop-beta-eyebrow">Provider slot</p>
              <h2>Google account</h2>
              <p className="workshop-beta-copy">
                Google OIDC belongs here once client credentials are configured. The control plane already has a
                provider field, but the live beta should not fake the redirect.
              </p>
            </article>
          </section>

          <section className="workshop-beta-grid login">
            <article className="workshop-beta-panel">
              <p className="workshop-beta-eyebrow">1 · Human</p>
              <h2>Email secure link</h2>
              <form onSubmit={handleAuthStart} className="workshop-beta-form">
                <label>
                  Email
                  <input value={email} onChange={(event: unknown) => setEmail(eventValue(event))} placeholder="admin@company.com" />
                </label>
                <button type="submit" disabled={pendingAction === "auth-start"}>
                  Issue secure link
                </button>
              </form>
              <div className="workshop-beta-inline-control">
                <input value={authToken} onChange={(event: unknown) => setAuthToken(eventValue(event))} placeholder="secure link token" />
                <button type="button" onClick={handleAuthVerify} disabled={!sessionId || !authToken || pendingAction === "auth-verify"}>
                  Verify
                </button>
              </div>
              {auth ? <small>Beta token expires {formatTime(auth.expiresAtIso)}.</small> : null}
            </article>

            <article className="workshop-beta-panel">
              <p className="workshop-beta-eyebrow">2 · Agent</p>
              <h2>Admin challenge</h2>
              <form onSubmit={handleIssueChallenge} className="workshop-beta-form">
                <label>
                  Workspace
                  <input value={workshopId} onChange={(event: unknown) => setWorkshopId(eventValue(event))} />
                </label>
                <label>
                  Mission-bound OAuth authority
                  <input value={authorityBaseUrl} onChange={(event: unknown) => setAuthorityBaseUrl(eventValue(event))} />
                </label>
                <button type="submit" disabled={!sessionId || pendingAction === "issue-challenge"}>
                  Issue challenge
                </button>
              </form>
              <form onSubmit={handleClaimChallenge} className="workshop-beta-form compact">
                <label>
                  Admin agent ID
                  <input value={challengeAgentId} onChange={(event: unknown) => setChallengeAgentId(eventValue(event))} placeholder="agent--session_agent_..." />
                </label>
                <label>
                  Agent label
                  <input value={challengeAgentName} onChange={(event: unknown) => setChallengeAgentName(eventValue(event))} placeholder="Ops coordinator" />
                </label>
                <button type="submit" disabled={!latestChallenge || !challengeAgentId || pendingAction === "claim-challenge"}>
                  Claim challenge
                </button>
              </form>
            </article>

            <article className="workshop-beta-panel">
              <p className="workshop-beta-eyebrow">3 · Mission</p>
              <h2>First work scope</h2>
              <form onSubmit={handleCreateMission} className="workshop-beta-form">
                <label>
                  Mission title
                  <input value={missionTitle} onChange={(event: unknown) => setMissionTitle(eventValue(event))} />
                </label>
                <label>
                  Goal
                  <textarea value={missionGoal} onChange={(event: unknown) => setMissionGoal(eventValue(event))} />
                </label>
                <label>
                  Visibility
                  <select value={visibility} onChange={(event: unknown) => setVisibility(eventValue(event) as WorkshopBetaVisibilityMode)}>
                    <option value="private">Private</option>
                    <option value="company">Company-visible</option>
                    <option value="proof_only_public">Proof-only public</option>
                    <option value="public_collaboration">Public collaboration</option>
                  </select>
                </label>
                <label>
                  Allowed agents
                  <input value={allowedAgents} onChange={(event: unknown) => setAllowedAgents(eventValue(event))} placeholder="comma-separated agent IDs" />
                </label>
                <label>
                  Data rules
                  <textarea value={dataRules} onChange={(event: unknown) => setDataRules(eventValue(event))} />
                </label>
                <label>
                  Success criteria
                  <textarea value={successCriteria} onChange={(event: unknown) => setSuccessCriteria(eventValue(event))} />
                </label>
                <label>
                  Budget
                  <input value={budgetUsd} onChange={(event: unknown) => setBudgetUsd(eventValue(event))} />
                </label>
                <button type="submit" disabled={pendingAction === "create-mission"}>
                  Draft mission
                </button>
              </form>
            </article>
          </section>
        </>
      )}
    </main>
  );
}
