import { canonicalDigest } from "../hashing/digest.js";
import type { AgentRegistryEntry, MarketplaceWorkTags } from "../runtime/console-state.js";

export type JobPackBuyerRouterMode = "direct-hire" | "quote-request" | "procurement-bid" | "paid-execution";
export type JobPackBuyerMode = "human" | "agent";
export type JobPackPrivacyLane = "private" | "proof-only" | "public-summary";

export interface JobPackRouteCandidate {
  agentId: string;
  agentName: string;
  matchScore: number;
  matchReasons: string[];
  pricingMode?: string;
  runtimeStatus?: string;
  paidExecutionReady?: boolean;
  quoteReady?: boolean;
  completionScorePct?: number;
  provenTags?: Array<{
    tag: string;
    totalJobCount: number;
    completedJobCount: number;
    successRatePct?: number;
  }>;
}

export interface JobPackBuyerRoutePlan {
  schemaVersion: "santaclawz-routing-plan/1.0";
  intelligenceSource: "protocol-state+agent-job-pack-router";
  routerAgentId?: string;
  generatedAtIso: string;
  buyerMode: JobPackBuyerMode;
  routingIntent: JobPackBuyerRouterMode;
  marketplaceTags: MarketplaceWorkTags;
  protocolLaneTags: string[];
  deliveryFormatTags: string[];
  candidateAgents: JobPackRouteCandidate[];
  recommendedNextAction: string;
  warnings: string[];
  routePlanDigestSha256: string;
}

export interface BuildJobPackBuyerRoutePlanInput {
  taskPrompt: string;
  buyerMode?: JobPackBuyerMode;
  privacyLane?: JobPackPrivacyLane;
  marketplaceTags?: Partial<MarketplaceWorkTags>;
  selectedAgentId?: string;
  agents: AgentRegistryEntry[];
  routerAgentId?: string;
  generatedAtIso?: string;
}

export interface JobPackBuyerRoutePlanResult {
  plan: JobPackBuyerRoutePlan;
  routerMessage: string;
  requestedTags: string[];
}

type JobPackRouteRule = {
  patterns: RegExp[];
  jobTags?: string[];
  capabilityTags?: string[];
  inputTags?: string[];
  outputTags?: string[];
};

const JOB_PACK_ROUTE_RULES: JobPackRouteRule[] = [
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

function normalizeTag(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_:./\s]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 48);
}

function uniqueTags(values: Array<string | undefined>, limit = 12) {
  return Array.from(new Set(values.map((value) => normalizeTag(value ?? "")).filter(Boolean))).slice(0, limit);
}

function addTags(target: string[], values?: string[]) {
  if (values) {
    target.push(...values);
  }
}

function emptyWorkTags(): MarketplaceWorkTags {
  return {
    jobTags: [],
    capabilityTags: [],
    inputTags: [],
    outputTags: []
  };
}

function sanitizeWorkTags(input: Partial<MarketplaceWorkTags> | undefined): MarketplaceWorkTags {
  if (!input) {
    return emptyWorkTags();
  }
  return {
    jobTags: uniqueTags(input.jobTags ?? []),
    capabilityTags: uniqueTags(input.capabilityTags ?? []),
    inputTags: uniqueTags(input.inputTags ?? []),
    outputTags: uniqueTags(input.outputTags ?? [])
  };
}

function workTagsAreEmpty(tags: MarketplaceWorkTags) {
  return tags.jobTags.length === 0 && tags.capabilityTags.length === 0 && tags.inputTags.length === 0 && tags.outputTags.length === 0;
}

export function inferJobPackMarketplaceWorkTags(prompt: string): MarketplaceWorkTags {
  const jobTags: string[] = [];
  const capabilityTags: string[] = [];
  const inputTags: string[] = [];
  const outputTags: string[] = [];
  for (const rule of JOB_PACK_ROUTE_RULES) {
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

function mergeWorkTags(inferred: MarketplaceWorkTags, supplied: MarketplaceWorkTags): MarketplaceWorkTags {
  return {
    jobTags: uniqueTags([...supplied.jobTags, ...inferred.jobTags]),
    capabilityTags: uniqueTags([...supplied.capabilityTags, ...inferred.capabilityTags]),
    inputTags: uniqueTags([...supplied.inputTags, ...inferred.inputTags]),
    outputTags: uniqueTags([...supplied.outputTags, ...inferred.outputTags])
  };
}

function workTagValues(tags: MarketplaceWorkTags) {
  return uniqueTags([...tags.jobTags, ...tags.capabilityTags, ...tags.inputTags, ...tags.outputTags], 48);
}

function protocolLaneTags(privacyLane: JobPackPrivacyLane | undefined, prompt: string): string[] {
  const lanes = [
    privacyLane === "public-summary"
      ? "public-summary"
      : privacyLane === "proof-only"
        ? "proof-trail-only"
        : "private-job"
  ];
  if (/file|zip|archive|download|artifact|image|video|spreadsheet/i.test(prompt)) {
    lanes.push("platform-scanned");
  }
  if (/encrypt|encrypted|confidential|sensitive/i.test(prompt)) {
    lanes.push("buyer-encrypted");
  }
  return uniqueTags(lanes);
}

function deliveryFormats(tags: MarketplaceWorkTags) {
  return uniqueTags(tags.outputTags.length > 0 ? tags.outputTags : ["text"]);
}

function agentTagValues(agent: AgentRegistryEntry) {
  const tags = agent.marketplaceTags;
  return uniqueTags([
    ...(tags?.capabilities ?? []),
    ...(tags?.domains ?? []),
    ...(tags?.inputTypes ?? []),
    ...(tags?.outputTypes ?? []),
    ...(tags?.tools ?? []),
    ...(tags?.runtimes ?? [])
  ], 48);
}

function scoreAgent(agent: AgentRegistryEntry, requestedTags: string[]) {
  const profileTags = agentTagValues(agent);
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
  if (agent.serviceKey === "agent_job_pack" || agent.agentId === "agent_job_pack") {
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

function routingMode(input: {
  candidateCount: number;
  prompt: string;
  selectedAgent?: AgentRegistryEntry;
  tags: MarketplaceWorkTags;
}): JobPackBuyerRouterMode {
  const broadPrompt = input.prompt.length > 420 || /compare|best|bid|who should|multiple|market|find someone/i.test(input.prompt);
  const richMedia = input.tags.outputTags.some((tag) => tag === "image" || tag === "video" || tag === "archive");
  if (broadPrompt || richMedia || input.candidateCount >= 3) {
    return "procurement-bid";
  }
  if (input.selectedAgent?.pricingMode === "quote-required" || /quote|estimate|scope/i.test(input.prompt)) {
    return "quote-request";
  }
  if (input.selectedAgent?.paidExecutionReady && input.selectedAgent.pricingMode === "fixed-exact") {
    return "paid-execution";
  }
  return "direct-hire";
}

function nextAction(mode: JobPackBuyerRouterMode) {
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

export function buildJobPackBuyerRoutePlan(input: BuildJobPackBuyerRoutePlanInput): JobPackBuyerRoutePlanResult {
  const taskPrompt = input.taskPrompt.trim().slice(0, 4000);
  const suppliedTags = sanitizeWorkTags(input.marketplaceTags);
  const inferredTags = inferJobPackMarketplaceWorkTags(taskPrompt);
  const marketplaceTags = workTagsAreEmpty(suppliedTags) ? inferredTags : mergeWorkTags(inferredTags, suppliedTags);
  const requestedTags = workTagValues(marketplaceTags);
  const activeAgents = input.agents.filter((agent) => !agent.archivedAtIso);
  const scoredCandidates = activeAgents
    .map((agent) => scoreAgent(agent, requestedTags))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 6);
  const selectedAgent =
    (input.selectedAgentId ? activeAgents.find((agent) => agent.agentId === input.selectedAgentId) : undefined) ??
    scoredCandidates[0]?.agent ??
    activeAgents[0];
  const routingIntent = routingMode({
    candidateCount: scoredCandidates.filter((candidate) => candidate.score >= 15).length,
    prompt: taskPrompt,
    ...(selectedAgent ? { selectedAgent } : {}),
    tags: marketplaceTags
  });
  const generatedAtIso = input.generatedAtIso ?? new Date().toISOString();
  const planWithoutDigest = {
    schemaVersion: "santaclawz-routing-plan/1.0" as const,
    intelligenceSource: "protocol-state+agent-job-pack-router" as const,
    ...(input.routerAgentId ? { routerAgentId: input.routerAgentId } : {}),
    generatedAtIso,
    buyerMode: input.buyerMode === "agent" ? "agent" as const : "human" as const,
    routingIntent,
    marketplaceTags,
    protocolLaneTags: protocolLaneTags(input.privacyLane, taskPrompt),
    deliveryFormatTags: deliveryFormats(marketplaceTags),
    candidateAgents: scoredCandidates.slice(0, 4).map((candidate) => ({
      agentId: candidate.agent.agentId,
      agentName: candidate.agent.agentName || candidate.agent.agentId,
      matchScore: candidate.score,
      matchReasons: candidate.reasons,
      pricingMode: candidate.agent.pricingMode,
      runtimeStatus: candidate.agent.runtimeStatus,
      paidExecutionReady: candidate.agent.paidExecutionReady === true,
      quoteReady: candidate.agent.quoteReady === true,
      ...(typeof candidate.agent.completionScore?.successRatePct === "number"
        ? { completionScorePct: candidate.agent.completionScore.successRatePct }
        : {}),
      provenTags: candidate.provenTags.slice(0, 4).map((stat) => ({
        tag: stat.tag,
        totalJobCount: stat.totalJobCount,
        completedJobCount: stat.completedJobCount,
        ...(typeof stat.successRatePct === "number" ? { successRatePct: stat.successRatePct } : {})
      }))
    })),
    recommendedNextAction: nextAction(routingIntent),
    warnings: [
      ...(scoredCandidates.length === 0 ? ["No strong seller match yet. Prefer procurement bidding or clarify the job brief."] : []),
      ...(routingIntent === "paid-execution" ? ["Verify the x402 payload and keep the same idempotent payment payload on retry."] : [])
    ]
  };
  const plan: JobPackBuyerRoutePlan = {
    ...planWithoutDigest,
    routePlanDigestSha256: canonicalDigest(planWithoutDigest).sha256Hex
  };
  return {
    plan,
    requestedTags,
    routerMessage: `I read this as ${requestedTags.slice(0, 5).join(", ") || "general work"}. Best route: ${routingIntent.replace(/-/g, " ")}. ${
      plan.candidateAgents[0]
        ? `Top match: ${plan.candidateAgents[0].agentName} because ${plan.candidateAgents[0].matchReasons[0]}.`
        : "I need more agent history before ranking sellers."
    }`
  };
}
