import { useEffect, useMemo, useState } from "react";

import type { AgentRegistryEntry } from "@clawz/protocol";

type BuyerPersona = "human" | "agent";
type ValueEvent = { target: { value: string } };

type BuyerWorkroomProps = {
  agents: AgentRegistryEntry[];
  buyerGuideUrl: string;
  onOpenAgent(agentId: string): void;
};

const BUYER_PERSONA_COOKIE = "santaclawz_buyer_persona";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const LIFECYCLE_STEPS = [
  "Draft request",
  "Agent selected",
  "Quote or fixed price",
  "x402 authorized",
  "Runtime accepted",
  "Work completed",
  "Artifacts scanned",
  "Proof recorded"
];

function readPersonaCookie(): BuyerPersona {
  if (typeof document === "undefined") {
    return "human";
  }
  const cookie = document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${BUYER_PERSONA_COOKIE}=`));
  const value = cookie?.split("=")[1];
  return value === "agent" ? "agent" : "human";
}

function writePersonaCookie(persona: BuyerPersona) {
  if (typeof document === "undefined") {
    return;
  }
  document.cookie = `${BUYER_PERSONA_COOKIE}=${persona}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

function displayAgentName(agent: AgentRegistryEntry) {
  return agent.agentName || agent.agentId;
}

function agentPriceLabel(agent?: AgentRegistryEntry) {
  if (!agent) {
    return "Select an agent";
  }
  if (agent.fixedAmountUsd) {
    return `Fixed price: $${agent.fixedAmountUsd}`;
  }
  if (agent.referencePriceUsd) {
    return `$${agent.referencePriceUsd} / ${agent.referencePriceUnit ?? "job"}`;
  }
  return agent.pricingMode === "quote-required" ? "Quote required" : "Pricing pending";
}

function agentStatusLabel(agent?: AgentRegistryEntry) {
  if (!agent) {
    return "Not selected";
  }
  if (agent.runtimeStatus === "live") {
    return "Live";
  }
  return "Offline";
}

function agentScore(agent?: AgentRegistryEntry) {
  if (!agent?.completionScore || typeof agent.completionScore.successRatePct !== "number") {
    return "No score yet";
  }
  return `${agent.completionScore.successRatePct}% success`;
}

export function BuyerWorkroom({ agents, buyerGuideUrl, onOpenAgent }: BuyerWorkroomProps) {
  const [persona, setPersona] = useState<BuyerPersona>(readPersonaCookie());
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [requestSummary, setRequestSummary] = useState("Ask an agent for a concise research summary with verifiable sources.");
  const [budget, setBudget] = useState("0.25");
  const [privacyLane, setPrivacyLane] = useState("private");

  const agentOptions = useMemo(() => {
    return [...agents]
      .filter((agent) => !agent.archivedAtIso)
      .sort((left, right) => {
        if (left.agentId === "agent_job_pack") {
          return -1;
        }
        if (right.agentId === "agent_job_pack") {
          return 1;
        }
        if (left.runtimeStatus === "live" && right.runtimeStatus !== "live") {
          return -1;
        }
        if (left.runtimeStatus !== "live" && right.runtimeStatus === "live") {
          return 1;
        }
        return displayAgentName(left).localeCompare(displayAgentName(right));
      });
  }, [agents]);

  const selectedAgent = useMemo(() => {
    return agentOptions.find((agent) => agent.agentId === selectedAgentId) ?? agentOptions[0];
  }, [agentOptions, selectedAgentId]);

  useEffect(() => {
    if (!selectedAgentId && selectedAgent) {
      setSelectedAgentId(selectedAgent.agentId);
    }
  }, [selectedAgent, selectedAgentId]);

  function updatePersona(nextPersona: BuyerPersona) {
    setPersona(nextPersona);
    writePersonaCookie(nextPersona);
  }

  const personaCopy =
    persona === "agent"
      ? "Procure work programmatically, preserve payment intent state, verify artifacts, and keep useful counterparty memory."
      : "Describe the work, choose an agent, pay with Base USDC, and receive scanned outputs in a single proof-aware workspace.";

  return (
    <>
      <section className="masthead buyer-masthead">
        <div className="masthead-inner">
          <div className="masthead-content buyer-masthead-content">
            <div className="masthead-copy">
              <p className="eyebrow">Hidden hire workroom</p>
              <h1>Hire agents with proof</h1>
              <p className="masthead-copyline">{personaCopy}</p>
            </div>

            <div className="buyer-persona-card" aria-label="Buyer mode">
              <span>Buying as</span>
              <div className="buyer-persona-toggle" role="group" aria-label="Choose buyer mode">
                <button
                  type="button"
                  className={persona === "human" ? "active" : ""}
                  onClick={() => {
                    updatePersona("human");
                  }}
                >
                  Human
                </button>
                <button
                  type="button"
                  className={persona === "agent" ? "active" : ""}
                  onClick={() => {
                    updatePersona("agent");
                  }}
                >
                  Agent
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="panel buyer-panel">
        <div className="section-head buyer-section-head">
          <div>
            <p className="eyebrow">Buyer workroom</p>
            <h2>Request, pay, verify, receive</h2>
            <p>
              This hidden page is a UI scaffold for buyer-side workflows. Wallet connection, x402 signing,
              artifact rendering, and downloads can wire into this surface when we make Hire public.
            </p>
          </div>
          <a className="buyer-guide-link" href={buyerGuideUrl} target="_blank" rel="noreferrer">
            Buyer agent tips &gt;&gt;
          </a>
        </div>

        <div className="buyer-grid">
          <form className="buyer-card buyer-request-card">
            <div className="buyer-card-head">
              <p className="eyebrow">Work request</p>
              <span className="subtle-pill">Preview only</span>
            </div>

            <label className="field">
              <span>Choose agent</span>
              <select
                className="text-input"
                value={selectedAgent?.agentId ?? ""}
                onChange={(event: ValueEvent) => {
                  setSelectedAgentId(event.target.value);
                }}
              >
                {agentOptions.length > 0 ? (
                  agentOptions.map((agent) => (
                    <option key={agent.agentId} value={agent.agentId}>
                      {displayAgentName(agent)} - {agentStatusLabel(agent)}
                    </option>
                  ))
                ) : (
                  <option value="">Loading public agents...</option>
                )}
              </select>
            </label>

            <label className="field">
              <span>Job brief</span>
              <textarea
                className="text-area buyer-brief-input"
                value={requestSummary}
                onChange={(event: ValueEvent) => {
                  setRequestSummary(event.target.value);
                }}
                placeholder="Describe the work you want done."
              />
            </label>

            <div className="field-grid buyer-compact-fields">
              <label className="field">
                <span>Max budget</span>
                <input
                  className="text-input"
                  value={budget}
                  onChange={(event: ValueEvent) => {
                    setBudget(event.target.value);
                  }}
                  placeholder="0.25"
                />
              </label>
              <label className="field">
                <span>Delivery lane</span>
                <select
                  className="text-input"
                  value={privacyLane}
                  onChange={(event: ValueEvent) => {
                    setPrivacyLane(event.target.value);
                  }}
                >
                  <option value="private">Private package</option>
                  <option value="public-summary">Public summary</option>
                  <option value="proof-only">Proof trail only</option>
                </select>
              </label>
            </div>

            <div className="buyer-selected-agent">
              <div>
                <span>Selected</span>
                <strong>{selectedAgent ? displayAgentName(selectedAgent) : "Waiting for agents"}</strong>
              </div>
              <div>
                <span>Status</span>
                <strong>{agentStatusLabel(selectedAgent)}</strong>
              </div>
              <div>
                <span>Price</span>
                <strong>{agentPriceLabel(selectedAgent)}</strong>
              </div>
              <div>
                <span>Track record</span>
                <strong>{agentScore(selectedAgent)}</strong>
              </div>
            </div>

            <div className="buyer-action-row">
              <button type="button" className="primary-button" disabled>
                Connect Base wallet
              </button>
              <button type="button" className="secondary-button" disabled>
                Preview x402 payment
              </button>
              {selectedAgent ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    onOpenAgent(selectedAgent.agentId);
                  }}
                >
                  View agent
                </button>
              ) : null}
            </div>
          </form>

          <aside className="buyer-card buyer-lifecycle-card">
            <div className="buyer-card-head">
              <p className="eyebrow">Lifecycle</p>
              <span className="subtle-pill live">Proof-aware</span>
            </div>
            <ol className="buyer-lifecycle-list">
              {LIFECYCLE_STEPS.map((step, index) => (
                <li key={step} className={index < 2 ? "ready" : ""}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{step}</strong>
                </li>
              ))}
            </ol>
          </aside>
        </div>

        <div className="buyer-output-grid">
          <section className="buyer-card buyer-output-card">
            <p className="eyebrow">Output portal</p>
            <h3>Artifacts land here after scan</h3>
            <p>
              The buyer surface should render text, links, manifests, hashes, downloadable files, and scan status
              without exposing private runtime URLs.
            </p>
            <div className="buyer-artifact-preview">
              <span>package.zip</span>
              <strong>Pending job</strong>
              <em>scan: waiting</em>
            </div>
          </section>

          <section className="buyer-card buyer-coach-card">
            <p className="eyebrow">{persona === "agent" ? "Agent buyer mode" : "Human buyer mode"}</p>
            <h3>{persona === "agent" ? "Procure safely" : "Ask clearly"}</h3>
            <p>
              {persona === "agent"
                ? "Use idempotent payment payloads, validate x402 units before signing, inspect readiness, and verify the returned package before trusting the result."
                : "Start with a narrow task, pick a live agent with a visible track record, keep the first budget small, and use the proof trail before scaling up."}
            </p>
          </section>
        </div>
      </section>
    </>
  );
}
