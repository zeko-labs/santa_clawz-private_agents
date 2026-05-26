import { useEffect, useMemo, useState } from "react";

import type { AgentMarketplaceTagStat, AgentRegistryEntry, MarketplaceWorkTags } from "@clawz/protocol";

import { ApiError, createProcurementIntent, type ProcurementIntentResponse } from "./api.js";

type BuyerPersona = "human" | "agent";
type RoutingMode = "direct-hire" | "quote-request" | "procurement-bid" | "paid-execution";
type ValueEvent = { target: { value: string } };

type BuyerWorkroomProps = {
  agents: AgentRegistryEntry[];
  buyerGuideUrl: string;
  onOpenAgent(agentId: string): void;
};

type RouteRule = {
  patterns: RegExp[];
  jobTags?: string[];
  capabilityTags?: string[];
  inputTags?: string[];
  outputTags?: string[];
};

type CandidateAgent = {
  agent: AgentRegistryEntry;
  score: number;
  reasons: string[];
  provenTags: AgentMarketplaceTagStat[];
};

type ChatMessage = {
  id: string;
  role: "buyer" | "router";
  body: string;
};

type RoutingPlan = {
  schemaVersion: "santaclawz-routing-plan/1.0";
  buyerMode: BuyerPersona;
  routingIntent: RoutingMode;
  marketplaceTags: MarketplaceWorkTags;
  protocolLaneTags: string[];
  deliveryFormatTags: string[];
  candidateAgents: Array<{
    agentId: string;
    agentName: string;
    matchScore: number;
    matchReasons: string[];
  }>;
  recommendedNextAction: string;
};

const BUYER_PERSONA_COOKIE = "santaclawz_buyer_persona";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const STARTER_AGENT_ID = "agent_job_pack";

const ROUTE_RULES: RouteRule[] = [
  {
    patterns: [/repo/i, /code/i, /github/i, /pull request/i, /\bpr\b/i],
    jobTags: ["repo-audit"],
    capabilityTags: ["repo-review", "code-review"],
    inputTags: ["github-url", "code"],
    outputTags: ["markdown", "findings"]
  },
  {
    patterns: [/security/i, /exploit/i, /vulnerability/i, /audit/i, /threat/i],
    jobTags: ["security-review"],
    capabilityTags: ["security-review", "risk-analysis"],
    outputTags: ["markdown", "risk-register"]
  },
  {
    patterns: [/research/i, /sources/i, /market/i, /compare/i, /summary/i],
    jobTags: ["research"],
    capabilityTags: ["research", "analysis"],
    inputTags: ["web"],
    outputTags: ["markdown", "source-list"]
  },
  {
    patterns: [/image/i, /diagram/i, /mockup/i, /visual/i, /logo/i],
    jobTags: ["image-generation"],
    capabilityTags: ["image-generation", "design"],
    outputTags: ["image", "artifact-manifest"]
  },
  {
    patterns: [/video/i, /clip/i, /animation/i, /short-form/i],
    jobTags: ["video-generation"],
    capabilityTags: ["video", "creative-production"],
    outputTags: ["video", "artifact-manifest"]
  },
  {
    patterns: [/spreadsheet/i, /\bcsv\b/i, /excel/i, /table/i, /dataset/i],
    jobTags: ["data-analysis"],
    capabilityTags: ["data-analysis"],
    inputTags: ["csv", "spreadsheet"],
    outputTags: ["spreadsheet", "markdown"]
  },
  {
    patterns: [/automation/i, /\bn8n\b/i, /workflow/i, /zapier/i],
    jobTags: ["workflow-automation"],
    capabilityTags: ["n8n-workflow", "automation"],
    outputTags: ["json", "runbook"]
  },
  {
    patterns: [/json/i, /schema/i, /api/i, /structured/i],
    jobTags: ["structured-output"],
    capabilityTags: ["api-integration"],
    inputTags: ["json"],
    outputTags: ["json"]
  }
];

const LIFECYCLE_STEPS = [
  "Route intent",
  "Select seller",
  "Quote or bid",
  "Authorize x402",
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

function normalizeTag(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_:./\s]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 48);
}

function uniqueTags(values: Array<string | undefined>) {
  return Array.from(new Set(values.map((value) => normalizeTag(value ?? "")).filter(Boolean))).slice(0, 12);
}

function addTags(target: string[], values?: string[]) {
  if (values) {
    target.push(...values);
  }
}

function marketplaceTagValues(agent: AgentRegistryEntry) {
  const tags = agent.marketplaceTags;
  return uniqueTags([
    ...tags.capabilities,
    ...tags.domains,
    ...tags.inputTypes,
    ...tags.outputTypes,
    ...tags.tools,
    ...tags.runtimes
  ]);
}

function workTagValues(tags: MarketplaceWorkTags) {
  return uniqueTags([...tags.jobTags, ...tags.capabilityTags, ...tags.inputTags, ...tags.outputTags]);
}

function extractMarketplaceTags(prompt: string): MarketplaceWorkTags {
  const jobTags: string[] = [];
  const capabilityTags: string[] = [];
  const inputTags: string[] = [];
  const outputTags: string[] = [];
  for (const rule of ROUTE_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(prompt))) {
      addTags(jobTags, rule.jobTags);
      addTags(capabilityTags, rule.capabilityTags);
      addTags(inputTags, rule.inputTags);
      addTags(outputTags, rule.outputTags);
    }
  }
  if (/patch|diff|fix|implement|bug/i.test(prompt)) {
    outputTags.push("code-patch");
  }
  if (/manifest|artifact|download|file|zip|archive/i.test(prompt)) {
    outputTags.push("artifact-manifest", "archive");
  }
  if (/private|confidential|sensitive|secret/i.test(prompt)) {
    jobTags.push("private-job");
  }
  return {
    jobTags: uniqueTags(jobTags.length > 0 ? jobTags : ["general-task"]),
    capabilityTags: uniqueTags(capabilityTags),
    inputTags: uniqueTags(inputTags),
    outputTags: uniqueTags(outputTags.length > 0 ? outputTags : ["text"])
  };
}

function deliveryFormats(tags: MarketplaceWorkTags) {
  return uniqueTags(tags.outputTags.length > 0 ? tags.outputTags : ["text"]);
}

function protocolLaneTags(privacyLane: string, prompt: string) {
  const lanes = [privacyLane === "public-summary" ? "public-summary" : privacyLane === "proof-only" ? "proof-trail-only" : "private-job"];
  if (/file|zip|archive|download|artifact|image|video|spreadsheet/i.test(prompt)) {
    lanes.push("platform-scanned");
  }
  if (/encrypt|encrypted|confidential|sensitive/i.test(prompt)) {
    lanes.push("buyer-encrypted");
  }
  return uniqueTags(lanes);
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
  return agent.runtimeStatus === "live" ? "Live" : "Offline";
}

function agentSuccessLabel(agent?: AgentRegistryEntry) {
  if (!agent?.completionScore || typeof agent.completionScore.successRatePct !== "number") {
    return "No score yet";
  }
  const count = agent.completionScore.evaluatedJobCount;
  return `${agent.completionScore.successRatePct}% success${count ? ` / ${count} jobs` : ""}`;
}

function scoreAgent(agent: AgentRegistryEntry, tags: MarketplaceWorkTags): CandidateAgent {
  const requestedTags = workTagValues(tags);
  const profileTags = marketplaceTagValues(agent);
  const provenTags = (agent.marketplaceTagStats ?? []).filter((stat) => requestedTags.includes(stat.tag));
  const matchingProfileTags = requestedTags.filter((tag) => profileTags.includes(tag));
  const reasons: string[] = [];
  let score = 0;
  if (agent.runtimeStatus === "live") {
    score += 8;
    reasons.push("live runtime");
  }
  if (agent.paidExecutionReady || agent.paidJobsEnabled) {
    score += 6;
    reasons.push("paid lane ready");
  }
  if (typeof agent.completionScore?.successRatePct === "number") {
    score += Math.min(12, Math.round(agent.completionScore.successRatePct / 10));
    reasons.push(`${agent.completionScore.successRatePct}% completion`);
  }
  if (matchingProfileTags.length > 0) {
    score += matchingProfileTags.length * 5;
    reasons.push(`declares ${matchingProfileTags.slice(0, 3).join(", ")}`);
  }
  if (provenTags.length > 0) {
    score += provenTags.reduce((total, stat) => total + 10 + Math.min(8, stat.totalJobCount), 0);
    reasons.push(`proven ${provenTags.map((stat) => `${stat.tag} ${stat.successRatePct ?? 0}%`).slice(0, 2).join(", ")}`);
  }
  if (agent.agentId === STARTER_AGENT_ID) {
    score += 4;
    reasons.push("starter routing coach");
  }
  return {
    agent,
    score,
    reasons: reasons.length > 0 ? reasons.slice(0, 4) : ["general marketplace candidate"],
    provenTags
  };
}

function chooseRoutingMode(input: {
  candidateCount: number;
  prompt: string;
  selectedAgent?: AgentRegistryEntry;
  tags: MarketplaceWorkTags;
}): RoutingMode {
  const broadPrompt = input.prompt.length > 420 || /compare|best|bid|who should|multiple|market|find someone/i.test(input.prompt);
  const richMedia = input.tags.outputTags.some((tag) => tag === "image" || tag === "video" || tag === "archive");
  if (broadPrompt || richMedia || input.candidateCount >= 3) {
    return "procurement-bid";
  }
  if (input.selectedAgent?.pricingMode === "quote-required" || /quote|estimate|scope/i.test(input.prompt)) {
    return "quote-request";
  }
  return "direct-hire";
}

function nextActionForMode(mode: RoutingMode) {
  if (mode === "procurement-bid") {
    return "Create a procurement intent so multiple seller agents can bid before payment.";
  }
  if (mode === "quote-request") {
    return "Request a quote from the selected agent before authorizing payment.";
  }
  if (mode === "paid-execution") {
    return "Authorize x402 and submit a bounded paid execution.";
  }
  return "Direct-hire the selected agent if the price and delivery lane are clear.";
}

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function safeContact(persona: BuyerPersona) {
  return persona === "agent" ? "buyer-agent@local" : "human-buyer@local";
}

function buildRoutingPlan(input: {
  persona: BuyerPersona;
  mode: RoutingMode;
  tags: MarketplaceWorkTags;
  lanes: string[];
  formats: string[];
  candidates: CandidateAgent[];
}): RoutingPlan {
  return {
    schemaVersion: "santaclawz-routing-plan/1.0",
    buyerMode: input.persona,
    routingIntent: input.mode,
    marketplaceTags: input.tags,
    protocolLaneTags: input.lanes,
    deliveryFormatTags: input.formats,
    candidateAgents: input.candidates.slice(0, 4).map((candidate) => ({
      agentId: candidate.agent.agentId,
      agentName: displayAgentName(candidate.agent),
      matchScore: candidate.score,
      matchReasons: candidate.reasons
    })),
    recommendedNextAction: nextActionForMode(input.mode)
  };
}

export function BuyerWorkroom({ agents, buyerGuideUrl, onOpenAgent }: BuyerWorkroomProps) {
  const [persona, setPersona] = useState<BuyerPersona>(readPersonaCookie());
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [requestSummary, setRequestSummary] = useState("Ask an agent to review a repo for launch risks and return markdown findings with file references.");
  const [buyerContact, setBuyerContact] = useState("");
  const [budget, setBudget] = useState("0.25");
  const [privacyLane, setPrivacyLane] = useState("private");
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "router-welcome",
      role: "router",
      body: "Tell me what you need done. I’ll turn it into marketplace tags, suggest a route, and show whether this should be direct hire, quote, or bidding."
    }
  ]);
  const [postingProcurement, setPostingProcurement] = useState(false);
  const [procurementResult, setProcurementResult] = useState<ProcurementIntentResponse | null>(null);
  const [procurementError, setProcurementError] = useState<string | null>(null);

  const marketplaceTags = useMemo(() => extractMarketplaceTags(requestSummary), [requestSummary]);
  const laneTags = useMemo(() => protocolLaneTags(privacyLane, requestSummary), [privacyLane, requestSummary]);
  const formatTags = useMemo(() => deliveryFormats(marketplaceTags), [marketplaceTags]);

  const agentOptions = useMemo(() => {
    return [...agents]
      .filter((agent) => !agent.archivedAtIso)
      .sort((left, right) => {
        if (left.agentId === STARTER_AGENT_ID) {
          return -1;
        }
        if (right.agentId === STARTER_AGENT_ID) {
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

  const candidates = useMemo(() => {
    return agentOptions
      .map((agent) => scoreAgent(agent, marketplaceTags))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 6);
  }, [agentOptions, marketplaceTags]);

  const selectedAgent = useMemo(() => {
    return agentOptions.find((agent) => agent.agentId === selectedAgentId) ?? candidates[0]?.agent ?? agentOptions[0];
  }, [agentOptions, candidates, selectedAgentId]);

  const routingMode = useMemo(() => {
    return chooseRoutingMode({
      candidateCount: candidates.filter((candidate) => candidate.score >= 15).length,
      prompt: requestSummary,
      ...(selectedAgent ? { selectedAgent } : {}),
      tags: marketplaceTags
    });
  }, [candidates, marketplaceTags, requestSummary, selectedAgent]);

  const routingPlan = useMemo(() => {
    return buildRoutingPlan({
      persona,
      mode: routingMode,
      tags: marketplaceTags,
      lanes: laneTags,
      formats: formatTags,
      candidates
    });
  }, [candidates, formatTags, laneTags, marketplaceTags, persona, routingMode]);

  useEffect(() => {
    if (!selectedAgentId && selectedAgent) {
      setSelectedAgentId(selectedAgent.agentId);
    }
  }, [selectedAgent, selectedAgentId]);

  function updatePersona(nextPersona: BuyerPersona) {
    setPersona(nextPersona);
    writePersonaCookie(nextPersona);
  }

  function sendRouterMessage() {
    const trimmed = chatInput.trim();
    if (!trimmed) {
      return;
    }
    setRequestSummary(trimmed);
    const nextTags = extractMarketplaceTags(trimmed);
    const nextCandidates = agentOptions
      .map((agent) => scoreAgent(agent, nextTags))
      .sort((left, right) => right.score - left.score)
      .slice(0, 3);
    const mode = chooseRoutingMode({
      candidateCount: nextCandidates.filter((candidate) => candidate.score >= 15).length,
      prompt: trimmed,
      ...(nextCandidates[0]?.agent ? { selectedAgent: nextCandidates[0].agent } : {}),
      tags: nextTags
    });
    setMessages((current) => [
      ...current,
      { id: makeId(), role: "buyer", body: trimmed },
      {
        id: makeId(),
        role: "router",
        body: `I read this as ${workTagValues(nextTags).slice(0, 5).join(", ")}. Best route: ${mode.replace("-", " ")}. ${nextCandidates[0] ? `Top match: ${displayAgentName(nextCandidates[0].agent)} because ${nextCandidates[0].reasons[0]}.` : "I need more agent history before ranking sellers."}`
      }
    ]);
    setChatInput("");
  }

  async function postProcurementIntent() {
    setPostingProcurement(true);
    setProcurementError(null);
    try {
      const result = await createProcurementIntent({
        taskPrompt: requestSummary,
        requesterContact: buyerContact.trim() || safeContact(persona),
        idempotencyKey: `hire-ui:${persona}:${requestSummary}:${budget}`.slice(0, 160),
        ...(budget.trim() ? { budgetUsd: budget.trim() } : {}),
        requiredCapabilities: marketplaceTags.capabilityTags,
        preferredDeliveryModes: formatTags,
        preferredPrivacyModes: laneTags,
        marketplaceTags,
        jobPrivacy: {
          visibility: privacyLane === "public-summary" ? "public" : "private",
          publicAggregateStats: true,
          publicLifecycleEvents: privacyLane !== "private",
          publicArtifactMetadata: privacyLane !== "private"
        },
        artifactDelivery: {
          mode: laneTags.includes("buyer-encrypted") ? "buyer_encrypted" : "platform_scanned",
          scanPolicy: "platform_required",
          digestRequired: true,
          buyerAcceptanceRequired: true
        }
      });
      setProcurementResult(result);
    } catch (error) {
      setProcurementError(error instanceof ApiError || error instanceof Error ? error.message : "Could not create procurement intent.");
    } finally {
      setPostingProcurement(false);
    }
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
              <h1>Route work to agents</h1>
              <p className="masthead-copyline">{personaCopy}</p>
            </div>

            <div className="buyer-persona-card" aria-label="Buyer mode">
              <span>Buying as</span>
              <div className="buyer-persona-toggle" role="group" aria-label="Choose buyer mode">
                <button type="button" className={persona === "human" ? "active" : ""} onClick={() => updatePersona("human")}>
                  Human
                </button>
                <button type="button" className={persona === "agent" ? "active" : ""} onClick={() => updatePersona("agent")}>
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
            <h2>Chat, route, bid, verify</h2>
            <p>
              The router converts buyer language into protocol tags, seller candidates, and a marketplace path.
              Tag claims and tag reputation can be anchored on Zeko as work becomes real.
            </p>
          </div>
          <a className="buyer-guide-link" href={buyerGuideUrl} target="_blank" rel="noreferrer">
            Buyer agent tips &gt;&gt;
          </a>
        </div>

        <div className="buyer-grid">
          <section className="buyer-card buyer-router-card">
            <div className="buyer-card-head">
              <p className="eyebrow">Routing chat</p>
              <span className="subtle-pill live">Local router</span>
            </div>
            <div className="buyer-chat-window" aria-live="polite">
              {messages.map((message) => (
                <div key={message.id} className={`buyer-chat-message ${message.role}`}>
                  <span>{message.role === "buyer" ? "You" : "SantaClawz router"}</span>
                  <p>{message.body}</p>
                </div>
              ))}
            </div>
            <div className="buyer-chat-input-row">
              <textarea
                className="text-area buyer-chat-input"
                value={chatInput}
                onChange={(event: ValueEvent) => setChatInput(event.target.value)}
                placeholder="Tell SantaClawz what work you want routed..."
              />
              <button type="button" className="primary-button" onClick={sendRouterMessage}>
                Route request
              </button>
            </div>
            <p className="buyer-router-note">
              Next step: route this same plan through agent_job_pack for model-assisted procurement coaching.
            </p>
          </section>

          <aside className="buyer-card buyer-lifecycle-card">
            <div className="buyer-card-head">
              <p className="eyebrow">Recommended path</p>
              <span className="subtle-pill">{routingMode.replace("-", " ")}</span>
            </div>
            <ol className="buyer-lifecycle-list">
              {LIFECYCLE_STEPS.map((step, index) => (
                <li key={step} className={index < 3 ? "ready" : ""}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{step}</strong>
                </li>
              ))}
            </ol>
          </aside>
        </div>

        <div className="buyer-grid">
          <form className="buyer-card buyer-request-card">
            <div className="buyer-card-head">
              <p className="eyebrow">Structured request</p>
              <span className="subtle-pill">Machine-readable</span>
            </div>

            <label className="field">
              <span>Job brief</span>
              <textarea
                className="text-area buyer-brief-input"
                value={requestSummary}
                onChange={(event: ValueEvent) => setRequestSummary(event.target.value)}
                placeholder="Describe the work you want done."
              />
            </label>

            <div className="field-grid buyer-compact-fields">
              <label className="field">
                <span>Budget USDC</span>
                <input className="text-input" value={budget} onChange={(event: ValueEvent) => setBudget(event.target.value)} placeholder="0.25" />
              </label>
              <label className="field">
                <span>Buyer contact</span>
                <input
                  className="text-input"
                  value={buyerContact}
                  onChange={(event: ValueEvent) => setBuyerContact(event.target.value)}
                  placeholder={safeContact(persona)}
                />
              </label>
            </div>

            <div className="field-grid buyer-compact-fields">
              <label className="field">
                <span>Delivery lane</span>
                <select className="text-input" value={privacyLane} onChange={(event: ValueEvent) => setPrivacyLane(event.target.value)}>
                  <option value="private">Private package</option>
                  <option value="public-summary">Public summary</option>
                  <option value="proof-only">Proof trail only</option>
                </select>
              </label>
              <label className="field">
                <span>Choose agent</span>
                <select
                  className="text-input"
                  value={selectedAgent?.agentId ?? ""}
                  onChange={(event: ValueEvent) => setSelectedAgentId(event.target.value)}
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
            </div>

            <div className="buyer-tag-panel">
              <div>
                <span>Job</span>
                {marketplaceTags.jobTags.map((tag) => <strong key={tag}>{tag}</strong>)}
              </div>
              <div>
                <span>Capability</span>
                {marketplaceTags.capabilityTags.map((tag) => <strong key={tag}>{tag}</strong>)}
              </div>
              <div>
                <span>Delivery</span>
                {formatTags.map((tag) => <strong key={tag}>{tag}</strong>)}
              </div>
              <div>
                <span>Protocol lane</span>
                {laneTags.map((tag) => <strong key={tag}>{tag}</strong>)}
              </div>
            </div>

            <div className="buyer-action-row">
              <button type="button" className="primary-button" disabled>
                Connect Base wallet
              </button>
              <button type="button" className="secondary-button" disabled>
                Preview x402 payment
              </button>
              <button type="button" className="secondary-button" onClick={postProcurementIntent} disabled={postingProcurement || !requestSummary.trim()}>
                {postingProcurement ? "Posting..." : "Post bidding request"}
              </button>
            </div>

            {procurementResult ? (
              <div className="status-banner status-banner-success">
                Procurement intent {procurementResult.intent.intentId} is open. Keep buyer token private for bid acceptance.
              </div>
            ) : null}
            {procurementError ? <div className="status-banner">{procurementError}</div> : null}
          </form>

          <aside className="buyer-card buyer-candidates-card">
            <div className="buyer-card-head">
              <p className="eyebrow">Candidate agents</p>
              <span className="subtle-pill">{candidates.length || 0} matches</span>
            </div>
            <div className="buyer-candidate-list">
              {candidates.length > 0 ? candidates.slice(0, 5).map((candidate) => (
                <button
                  key={candidate.agent.agentId}
                  type="button"
                  className={candidate.agent.agentId === selectedAgent?.agentId ? "buyer-candidate active" : "buyer-candidate"}
                  onClick={() => setSelectedAgentId(candidate.agent.agentId)}
                >
                  <span>{displayAgentName(candidate.agent)}</span>
                  <strong>{candidate.score}</strong>
                  <em>{candidate.reasons.join(" · ")}</em>
                </button>
              )) : (
                <p className="buyer-router-note">No strong matches yet. Add a clearer job brief or use procurement bidding.</p>
              )}
            </div>
            {selectedAgent ? (
              <div className="buyer-selected-agent">
                <div>
                  <span>Selected</span>
                  <strong>{displayAgentName(selectedAgent)}</strong>
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
                  <span>Record</span>
                  <strong>{agentSuccessLabel(selectedAgent)}</strong>
                </div>
              </div>
            ) : null}
            {selectedAgent ? (
              <button type="button" className="secondary-button" onClick={() => onOpenAgent(selectedAgent.agentId)}>
                View selected agent
              </button>
            ) : null}
          </aside>
        </div>

        <div className="buyer-output-grid">
          <section className="buyer-card buyer-output-card">
            <p className="eyebrow">Routing plan</p>
            <h3>Zeko-ready marketplace intent</h3>
            <p>
              This is the compact plan shape the UI can hand to agent_job_pack, direct hire, or procurement bidding.
              The final digest can be anchored without exposing private prompt content.
            </p>
            <pre className="buyer-plan-json">{JSON.stringify(routingPlan, null, 2)}</pre>
          </section>

          <section className="buyer-card buyer-coach-card">
            <p className="eyebrow">{persona === "agent" ? "Agent buyer mode" : "Human buyer mode"}</p>
            <h3>{persona === "agent" ? "Procure safely" : "Ask clearly"}</h3>
            <p>
              {persona === "agent"
                ? "Use idempotent payment payloads, validate x402 units before signing, inspect readiness, and verify the returned package before trusting the result."
                : "Start with a narrow task, prefer proven tags, keep first spend small, and use bidding when the right seller is unclear."}
            </p>
            <div className="buyer-artifact-preview">
              <span>output package</span>
              <strong>after execution</strong>
              <em>scan + manifest</em>
            </div>
          </section>
        </div>
      </section>
    </>
  );
}
