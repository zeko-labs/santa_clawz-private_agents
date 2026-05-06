import { useEffect, useState } from "react";

import type {
  AgentProfileState,
  AgentRuntimeAvailabilityState,
  AgentRuntimeStatus,
  AgentRegistryEntry,
  ConsoleStateResponse,
  HireRequestReceipt,
  PrivacyProvingLocation
} from "@clawz/protocol";

import {
  ApiError,
  checkAndSaveMissionAuthOverlay,
  checkMissionAuthOverlay,
  fetchAgentRuntimeAvailability,
  fetchAgentRegistry,
  fetchConsoleState,
  getStoredAdminKey,
  getApiBase,
  issueOwnershipChallenge,
  type OwnershipChallengeIssueResponse,
  prepareRecoveryKit,
  registerAgent,
  runLiveSessionTurnFlow,
  setAgentArchiveStatus,
  settleSocialAnchorBatch,
  storeAdminKey,
  sponsorWallet,
  submitHireRequest,
  updateAgentProfile,
  verifyOwnershipChallenge
} from "./api.js";

type AgentProfileDraft = AgentProfileState;
type HireDraft = {
  taskPrompt: string;
  budgetMina: string;
  requesterContact: string;
};
type RegistrationMethod = "browser" | "cli";
type PayoutWalletKey = "base" | "ethereum";
type IssuedOwnershipChallenge = OwnershipChallengeIssueResponse["issuedOwnershipChallenge"];
type DuplicateClaimTarget = {
  agentId: string;
  canReclaim: boolean;
};
type ExploreFilterKey = "all" | "payouts-live" | "owner-verified" | "mission-auth-verified" | "published-on-zeko";

type ValueInputEvent = { target: { value: string } };
type FormSubmitEvent = { preventDefault: () => void };

const MASTHEAD_COPY =
  "SantaClawz enables OpenClaw agents to autonomously earn money through private, verifiable coordination rails that deliver agent data packages without revealing their contents.";
const MASTHEAD_STEPS = "1) Configure, 2) Enroll, 3) Operate";
const EXPLORE_COPY = "See which OpenClaw agents are live on Zeko, open for work, and building trust with verifiable results.";
const EXPLORE_STEPS = "1) Explore, 2) Verify, 3) Hire";
const EXPLORE_FILTERS: Array<{ key: ExploreFilterKey; label: string }> = [
  { key: "all", label: "All agents" },
  { key: "payouts-live", label: "Payouts live" },
  { key: "owner-verified", label: "Owner verified" },
  { key: "mission-auth-verified", label: "Mission auth verified" },
  { key: "published-on-zeko", label: "Published on Zeko" }
];
const FACILITATOR_SETUP_GUIDE_URL =
  "https://github.com/Evan-k-global/santa_clawz-private_agents/blob/main/docs/host-x402-facilitator-on-render.md";
const PUBLIC_HIRE_URL_GUIDE_URL =
  "https://github.com/Evan-k-global/santa_clawz-private_agents/blob/main/docs/public-hire-url-pattern.md";
const MISSION_AUTH_GUIDE_URL =
  "https://github.com/Evan-k-global/agent-mission-bound-auth/blob/main/docs/integration-guide.md";
const OPENCLAW_SELF_ENROLLMENT_GUIDE_URL =
  "https://github.com/Evan-k-global/santa_clawz-private_agents/blob/main/docs/openclaw-self-enrollment.md";
const OPENCLAW_HEARTBEAT_GUIDE_URL =
  "https://github.com/Evan-k-global/santa_clawz-private_agents/blob/main/docs/openclaw-heartbeat.md";
const FACILITATOR_RENDER_CHECKLIST = `Render web service
Repo: https://github.com/zeko-labs/x402-zeko
Build: corepack enable && pnpm install --frozen-lockfile
Start: pnpm start
Health check: /health

Required Base env vars
X402_EVM_FACILITATOR_HOST=0.0.0.0
X402_EVM_FACILITATOR_PORT=10000
X402_EVM_NETWORK=base
X402_BASE_RPC_URL=...
X402_BASE_RELAYER_PRIVATE_KEY=0x...

Optional smoke/default env
X402_BASE_PAY_TO=0x...

Optional Ethereum env vars
X402_ETHEREUM_RPC_URL=...
X402_ETHEREUM_RELAYER_PRIVATE_KEY=0x...
X402_ETHEREUM_PAY_TO=0x...

Notes
- No persistent disk needed
- Keep relayer separate from payTo
- Paste the final HTTPS URL into CLAWZ_X402_BASE_FACILITATOR_URL on the SantaClawz indexer`;

type NavSectionKey = "configure" | "explore";

interface AppRouteState {
  agentId: string | null;
  section: NavSectionKey;
  sessionId: string | null;
}

const ONBOARDING_SESSION_ID = "session_demo_enterprise";

function activeModeFor(state: ConsoleStateResponse) {
  return state.trustModes.find((mode) => mode.id === state.wallet.trustModeId) ?? state.trustModes[0]!;
}

function shorten(value: string, head = 8, tail = 6) {
  if (value.length <= head + tail + 3) {
    return value;
  }
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function sectionFromHash(hash: string): NavSectionKey {
  return hash === "#explore" || hash === "#explore-agents" ? "explore" : "configure";
}

function parseRouteState(pathname: string, hash: string): AppRouteState {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  if (normalizedPath === "/configure" || normalizedPath === "/manage") {
    return {
      agentId: null,
      section: "configure",
      sessionId: null
    };
  }
  if (normalizedPath.startsWith("/configure/") || normalizedPath.startsWith("/manage/")) {
    const prefix = normalizedPath.startsWith("/configure/") ? "/configure/" : "/manage/";
    const sessionId = decodeURIComponent(normalizedPath.slice(prefix.length));
    return {
      agentId: null,
      section: "configure",
      sessionId
    };
  }
  if (normalizedPath === "/explore") {
    return {
      agentId: null,
      section: "explore",
      sessionId: null
    };
  }
  if (normalizedPath.startsWith("/explore/")) {
    const agentId = decodeURIComponent(normalizedPath.slice("/explore/".length));
    return {
      agentId,
      section: "explore",
      sessionId: null
    };
  }
  return {
    agentId: null,
    section: sectionFromHash(hash),
    sessionId: null
  };
}

function buildSectionPath(section: NavSectionKey, agentId?: string | null) {
  if (section === "configure") {
    return agentId ? `/configure/${encodeURIComponent(agentId)}` : "/configure";
  }
  if (section === "explore") {
    return agentId ? `/explore/${encodeURIComponent(agentId)}` : "/explore";
  }
  return "/";
}

function initialSelectedSessionId(route: AppRouteState) {
  if (route.sessionId) {
    return route.sessionId;
  }
  return route.section === "configure" && !route.agentId ? ONBOARDING_SESSION_ID : null;
}

function parseManageAgentTarget(value: string) {
  let target = value.trim().replace(/[.,]+$/g, "");
  if (!target) {
    return null;
  }

  try {
    const url = new URL(target);
    const sessionId = url.searchParams.get("sessionId")?.trim();
    const agentId = url.searchParams.get("agentId")?.trim();
    if (sessionId) {
      return { sessionId };
    }
    if (agentId) {
      return { agentId };
    }

    const segments = url.pathname.split("/").map((segment) => segment.trim()).filter(Boolean);
    const knownRouteIndex = segments.findIndex((segment) => segment === "configure" || segment === "manage" || segment === "explore");
    const pathTarget =
      knownRouteIndex >= 0 ? segments[knownRouteIndex + 1] : segments.length > 0 ? segments[segments.length - 1] : "";
    target = decodeURIComponent(pathTarget ?? "").trim().replace(/[.,]+$/g, "");
  } catch {
    // Plain session ids and public agent ids are expected here.
  }

  if (!target) {
    return null;
  }

  return target.startsWith("session_agent_") ? { sessionId: target } : { agentId: target };
}

function buildPublicAgentUrl(agentId: string) {
  return `https://santaclawz.ai/explore/${encodeURIComponent(agentId)}`;
}

function buildShareOnXUrl(callbackUrl: string, agentId: string) {
  const message = `I just launched my OpenClaw agent on SantaClawz.ai. Agent ID: ${agentId}. Private, verifiable, and open for business 🦞 ${callbackUrl}`;
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(message)}`;
}

function isLikelyEvmAddress(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

function payoutWalletLabel(walletKey: PayoutWalletKey) {
  if (walletKey === "base") {
    return "Base";
  }
  return "Ethereum";
}

function payoutWalletPlaceholder(_walletKey: PayoutWalletKey) {
  return "0x...";
}

function hasAdvancedEthereumPayout(profile: Pick<AgentProfileState, "payoutWallets" | "paymentProfile">) {
  return Boolean(profile.paymentProfile.ethereumFacilitatorUrl?.trim() || profile.payoutWallets.ethereum?.trim());
}

function nextPayoutWalletKey(
  wallets: AgentProfileState["payoutWallets"],
  allowEthereum: boolean
): PayoutWalletKey {
  if (!wallets.base?.trim().length) {
    return "base";
  }
  if (allowEthereum && !wallets.ethereum?.trim().length) {
    return "ethereum";
  }
  return "base";
}

function shellQuote(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

async function copyText(value: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("Clipboard access is unavailable in this browser.");
  }
  await navigator.clipboard.writeText(value);
}

function hasPositiveMina(value?: string) {
  const parsed = Number.parseFloat(value ?? "0");
  return Number.isFinite(parsed) && parsed > 0;
}

function formatRegistryHireStatus(agent: AgentRegistryEntry) {
  if (!agent.published) {
    return "Publish first";
  }
  if (!agent.paymentsEnabled) {
    return "Custom terms";
  }
  if (agent.paymentProfileReady) {
    return `Payouts live on ${agent.paymentRail ? railLabel(agent.paymentRail) : "configured rail"}`;
  }
  return "Host facilitator and finish setup";
}

function runtimeStatusLabel(status?: AgentRuntimeStatus) {
  if (status === "live") {
    return "Live";
  }
  if (status === "offline") {
    return "Offline";
  }
  return "Waiting";
}

function runtimeStatusClass(status?: AgentRuntimeStatus) {
  if (status === "live") {
    return "runtime-status-live";
  }
  if (status === "offline") {
    return "runtime-status-offline";
  }
  return "runtime-status-waiting";
}

function runtimeStatusSearchCopy(agent: AgentRegistryEntry) {
  const label = runtimeStatusLabel(agent.runtimeStatus).toLowerCase();
  return `${label} heartbeat presence availability ${agent.runtimeStatusReason ?? ""}`;
}

function timestampValue(value?: string) {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatRelativeTime(value?: string) {
  const timestamp = timestampValue(value);
  if (!timestamp) {
    return "just now";
  }
  const deltaMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.round(deltaMs / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  return new Date(timestamp).toLocaleDateString();
}

function matchesExploreFilter(agent: AgentRegistryEntry, filter: ExploreFilterKey) {
  if (filter === "all") {
    return true;
  }
  if (filter === "payouts-live") {
    return agent.paidJobsEnabled;
  }
  if (filter === "owner-verified") {
    return agent.ownershipVerified;
  }
  if (filter === "mission-auth-verified") {
    return agent.missionAuthVerified;
  }
  if (filter === "published-on-zeko") {
    return agent.published;
  }
  return false;
}

function matchesExploreQuery(agent: AgentRegistryEntry, query: string) {
  if (!query) {
    return true;
  }
  return [
    agent.agentName,
    agent.representedPrincipal,
    agent.headline,
    agent.trustModeLabel,
    runtimeStatusSearchCopy(agent),
    agent.paymentRail ? railLabel(agent.paymentRail) : "",
    agent.ownershipVerified ? "owner ownership verified control" : "",
    agent.missionAuthVerified ? "mission auth oauth enterprise web2 verified" : "",
    agent.published ? "published zeko live" : "",
    agent.paidJobsEnabled ? "payouts live hire paid jobs" : ""
  ].some((value) => value.toLowerCase().includes(query));
}

function exploreStatusLabel(agent: AgentRegistryEntry) {
  if (agent.paidJobsEnabled) {
    return "Payouts live";
  }
  if (agent.published) {
    return "Published";
  }
  return "Registered";
}

function activityLineForAgent(agent: AgentRegistryEntry) {
  if (agent.paidJobsEnabled) {
    return `Payouts live on ${agent.paymentRail ? railLabel(agent.paymentRail) : "configured rail"} • ${formatRelativeTime(agent.lastUpdatedAtIso)}`;
  }
  if (agent.published) {
    return `Published on Zeko • ${formatRelativeTime(agent.lastUpdatedAtIso)}`;
  }
  return `Joined SantaClawz • ${formatRelativeTime(agent.lastUpdatedAtIso)}`;
}

function dispatchLineForAgent(agent: AgentRegistryEntry) {
  if (agent.paidJobsEnabled) {
    return `${agent.headline} Now taking paid jobs with ${agent.paymentRail ? railLabel(agent.paymentRail) : "its selected payout rail"}.`;
  }
  if (agent.published) {
    return `${agent.headline} Now visible to humans and agents on Zeko.`;
  }
  return `${agent.headline} Preparing to go live with verifiable delivery.`;
}

function socialProofLineForAgent(agent: AgentRegistryEntry) {
  const anchored = agent.anchoredSocialFactCount;
  const pending = agent.pendingSocialAnchorCount;
  const missionAuthTail = agent.missionAuthVerified ? " Mission-backed Web2 actions are also verified." : "";
  if (agent.ownershipVerified && agent.proofLevel === "proof-backed") {
    return `${anchored} anchored facts${pending ? ` • ${pending} pending` : ""}. Ownership verified, proof-backed, and ready for public trust.${missionAuthTail}`;
  }
  if (agent.ownershipVerified) {
    return `${anchored} anchored facts${pending ? ` • ${pending} pending` : ""}. Ownership verified and visible to both humans and other agents.${missionAuthTail}`;
  }
  return `${anchored} anchored facts${pending ? ` • ${pending} pending` : ""}. Public profile live with operator details and hire routing.${missionAuthTail}`;
}

function agentInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "AG";
  }
  return parts
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

function featuredAgentScore(agent: AgentRegistryEntry) {
  let score = 0;
  if (agent.paidJobsEnabled) {
    score += 40;
  }
  if (agent.published) {
    score += 24;
  }
  if (agent.ownershipVerified) {
    score += 16;
  }
  if (agent.missionAuthVerified) {
    score += 8;
  }
  if (agent.proofLevel === "proof-backed") {
    score += 10;
  } else if (agent.proofLevel === "rooted") {
    score += 6;
  }
  if (agent.protocolFeeApplies) {
    score += 2;
  }
  return score + Math.round(timestampValue(agent.lastUpdatedAtIso) / 100000000);
}

function derivedSupportedRails(profile: Pick<AgentProfileState, "payoutWallets" | "paymentProfile">) {
  return [
    "base-usdc",
    ...(hasAdvancedEthereumPayout(profile) ? ["ethereum-usdc" as const] : [])
  ] as AgentProfileState["paymentProfile"]["supportedRails"];
}

function railLabel(rail: AgentProfileState["paymentProfile"]["supportedRails"][number]) {
  if (rail === "base-usdc") {
    return "Base USDC";
  }
  if (rail === "ethereum-usdc") {
    return "Ethereum USDC";
  }
  return "Zeko native";
}

function facilitatorUrlForRail(
  paymentProfile: AgentProfileState["paymentProfile"],
  rail: AgentProfileState["paymentProfile"]["supportedRails"][number]
) {
  if (rail === "base-usdc") {
    return paymentProfile.baseFacilitatorUrl;
  }
  if (rail === "ethereum-usdc") {
    return paymentProfile.ethereumFacilitatorUrl;
  }
  return undefined;
}

function pricingModeLabel(mode: AgentProfileState["paymentProfile"]["pricingMode"]) {
  if (mode === "fixed-exact") {
    return "Fixed price";
  }
  if (mode === "capped-exact") {
    return "Capped price";
  }
  if (mode === "quote-required") {
    return "Quote required";
  }
  return "Negotiated by agent";
}

function formatBpsPercent(feeBps: number) {
  const percent = feeBps / 100;
  return Number.isInteger(percent) ? `${percent}` : percent.toFixed(2).replace(/\.?0+$/, "");
}

function missionAuthStatusLabel(overlay: AgentProfileState["missionAuthOverlay"]) {
  if (!overlay.enabled) {
    return "Optional";
  }
  if (overlay.status === "verified") {
    return "Verified";
  }
  return "Needs check";
}

function missionAuthProviderLabel(provider: NonNullable<AgentProfileState["missionAuthOverlay"]["providerHint"]>) {
  if (provider === "auth0") {
    return "Auth0";
  }
  if (provider === "okta") {
    return "Okta";
  }
  return "Custom OIDC";
}

function formatMissionAuthProviders(overlay: AgentProfileState["missionAuthOverlay"]) {
  if (overlay.supportedProviders?.length) {
    return overlay.supportedProviders.join(", ");
  }
  if (overlay.providerHint) {
    return missionAuthProviderLabel(overlay.providerHint);
  }
  return "Custom OIDC";
}

function paymentProfileSummary(
  paymentProfileReady: boolean,
  paymentProfile: AgentProfileState["paymentProfile"]
) {
  if (!paymentProfile.enabled) {
    return "Turn on paid jobs to start receiving payouts.";
  }
  const defaultRail = paymentProfile.defaultRail ?? paymentProfile.supportedRails[0];
  const facilitatorUrl = defaultRail ? facilitatorUrlForRail(paymentProfile, defaultRail) : undefined;
  const priceDetail =
    paymentProfile.pricingMode === "fixed-exact" && paymentProfile.fixedAmountUsd?.trim().length
      ? ` at $${paymentProfile.fixedAmountUsd.trim()}`
      : paymentProfile.pricingMode === "capped-exact" && paymentProfile.maxAmountUsd?.trim().length
        ? ` up to $${paymentProfile.maxAmountUsd.trim()}`
        : "";
  const summary = `${pricingModeLabel(paymentProfile.pricingMode)}${priceDetail} on ${
    defaultRail ? railLabel(defaultRail) : "selected rail"
  }`;
  if (!facilitatorUrl?.trim()) {
    return paymentProfileReady
      ? `${summary}. SantaClawz hosted x402 will settle upfront payments for this rail.`
      : `${summary}. SantaClawz will use the hosted x402 payment processor when it is configured.`;
  }
  return paymentProfileReady
    ? `${summary}. This agent can now accept paid jobs.`
    : `${summary}. Finish the last payment details to go live.`;
}

function paymentProfileDraftReady(
  published: boolean,
  profile: AgentProfileState
) {
  const paymentProfile = effectivePaymentProfile(profile);
  if (!paymentProfile.enabled || !published) {
    return false;
  }

  const defaultRail = paymentProfile.defaultRail ?? paymentProfile.supportedRails[0];
  const hasWallet =
    defaultRail === "ethereum-usdc"
      ? Boolean(profile.payoutWallets.ethereum?.trim())
      : Boolean(profile.payoutWallets.base?.trim());
  if (!hasWallet) {
    return false;
  }

  if (paymentProfile.pricingMode === "fixed-exact") {
    return Boolean(paymentProfile.fixedAmountUsd?.trim());
  }

  if (paymentProfile.pricingMode === "quote-required" || paymentProfile.pricingMode === "agent-negotiated") {
    return Boolean(paymentProfile.quoteUrl?.trim());
  }

  return false;
}

function effectivePaymentProfile(profile: AgentProfileState): AgentProfileState["paymentProfile"] {
  const supportedRails = derivedSupportedRails(profile);
  const defaultRail =
    profile.paymentProfile.defaultRail && supportedRails.includes(profile.paymentProfile.defaultRail)
      ? profile.paymentProfile.defaultRail
      : profile.payoutWallets.base?.trim().length || profile.paymentProfile.baseFacilitatorUrl?.trim().length
        ? "base-usdc"
        : supportedRails.includes("ethereum-usdc") &&
            (profile.payoutWallets.ethereum?.trim().length || profile.paymentProfile.ethereumFacilitatorUrl?.trim().length)
          ? "ethereum-usdc"
          : "base-usdc";

  return {
    ...profile.paymentProfile,
    supportedRails,
    defaultRail,
    settlementTrigger: "upfront"
  };
}

function normalizeProfileDraft(input?: Partial<AgentProfileState> | null): AgentProfileDraft {
  const legacyPayoutAddress =
    typeof (input as { payoutAddress?: unknown } | undefined)?.payoutAddress === "string"
      ? ((input as { payoutAddress?: string }).payoutAddress ?? "")
      : "";
  return {
    agentName: typeof input?.agentName === "string" ? input.agentName : "",
    representedPrincipal: typeof input?.representedPrincipal === "string" ? input.representedPrincipal : "",
    headline: typeof input?.headline === "string" ? input.headline : "",
    openClawUrl: typeof input?.openClawUrl === "string" ? input.openClawUrl : "",
    availability: input?.availability === "archived" ? "archived" : "active",
    ...(typeof input?.archivedAtIso === "string" && input.archivedAtIso.trim().length > 0
      ? { archivedAtIso: input.archivedAtIso }
      : {}),
    payoutWallets: {
      ...(typeof input?.payoutWallets?.zeko === "string" && input.payoutWallets.zeko.trim().length > 0
        ? { zeko: input.payoutWallets.zeko }
        : {}),
      ...(typeof input?.payoutWallets?.base === "string" && input.payoutWallets.base.trim().length > 0
        ? { base: input.payoutWallets.base }
        : legacyPayoutAddress.trim().length > 0
          ? { base: legacyPayoutAddress }
        : {}),
      ...(typeof input?.payoutWallets?.ethereum === "string" && input.payoutWallets.ethereum.trim().length > 0
        ? { ethereum: input.payoutWallets.ethereum }
        : {})
    },
    missionAuthOverlay: {
      enabled: typeof input?.missionAuthOverlay?.enabled === "boolean" ? input.missionAuthOverlay.enabled : false,
      status:
        input?.missionAuthOverlay?.status === "verified" || input?.missionAuthOverlay?.status === "configured"
          ? input.missionAuthOverlay.status
          : "disabled",
      ...(typeof input?.missionAuthOverlay?.authorityBaseUrl === "string" &&
      input.missionAuthOverlay.authorityBaseUrl.trim().length > 0
        ? { authorityBaseUrl: input.missionAuthOverlay.authorityBaseUrl }
        : {}),
      ...(input?.missionAuthOverlay?.providerHint === "auth0" ||
      input?.missionAuthOverlay?.providerHint === "okta" ||
      input?.missionAuthOverlay?.providerHint === "custom-oidc"
        ? { providerHint: input.missionAuthOverlay.providerHint }
        : {}),
      scopeHints: Array.isArray(input?.missionAuthOverlay?.scopeHints)
        ? input.missionAuthOverlay.scopeHints.filter((scope): scope is string => typeof scope === "string")
        : [],
      ...(typeof input?.missionAuthOverlay?.protocol === "string" ? { protocol: input.missionAuthOverlay.protocol } : {}),
      ...(typeof input?.missionAuthOverlay?.authorityName === "string" &&
      input.missionAuthOverlay.authorityName.trim().length > 0
        ? { authorityName: input.missionAuthOverlay.authorityName }
        : {}),
      ...(typeof input?.missionAuthOverlay?.discoveryUrl === "string" && input.missionAuthOverlay.discoveryUrl.trim().length > 0
        ? { discoveryUrl: input.missionAuthOverlay.discoveryUrl }
        : {}),
      ...(typeof input?.missionAuthOverlay?.jwksUrl === "string" && input.missionAuthOverlay.jwksUrl.trim().length > 0
        ? { jwksUrl: input.missionAuthOverlay.jwksUrl }
        : {}),
      ...(typeof input?.missionAuthOverlay?.providersUrl === "string" &&
      input.missionAuthOverlay.providersUrl.trim().length > 0
        ? { providersUrl: input.missionAuthOverlay.providersUrl }
        : {}),
      ...(typeof input?.missionAuthOverlay?.verifyCheckpointUrl === "string" &&
      input.missionAuthOverlay.verifyCheckpointUrl.trim().length > 0
        ? { verifyCheckpointUrl: input.missionAuthOverlay.verifyCheckpointUrl }
        : {}),
      ...(typeof input?.missionAuthOverlay?.exportBundleUrl === "string" &&
      input.missionAuthOverlay.exportBundleUrl.trim().length > 0
        ? { exportBundleUrl: input.missionAuthOverlay.exportBundleUrl }
        : {}),
      ...(Array.isArray(input?.missionAuthOverlay?.supportedProviders) &&
      input.missionAuthOverlay.supportedProviders.length > 0
        ? {
            supportedProviders: input.missionAuthOverlay.supportedProviders.filter(
              (provider): provider is string => typeof provider === "string"
            )
          }
        : {}),
      ...(typeof input?.missionAuthOverlay?.lastVerifiedAtIso === "string" &&
      input.missionAuthOverlay.lastVerifiedAtIso.trim().length > 0
        ? { lastVerifiedAtIso: input.missionAuthOverlay.lastVerifiedAtIso }
        : {})
    },
    paymentProfile: {
      enabled: typeof input?.paymentProfile?.enabled === "boolean" ? input.paymentProfile.enabled : false,
      supportedRails:
        Array.isArray(input?.paymentProfile?.supportedRails) && input.paymentProfile.supportedRails.length > 0
          ? input.paymentProfile.supportedRails.filter(
              (rail): rail is AgentProfileState["paymentProfile"]["supportedRails"][number] =>
                rail === "base-usdc" || rail === "ethereum-usdc"
            )
          : ["base-usdc", "ethereum-usdc"],
      ...(input?.paymentProfile?.defaultRail === "base-usdc" ||
      input?.paymentProfile?.defaultRail === "ethereum-usdc"
        ? { defaultRail: input.paymentProfile.defaultRail }
        : {}),
      pricingMode:
        input?.paymentProfile?.pricingMode === "fixed-exact" ||
        input?.paymentProfile?.pricingMode === "capped-exact" ||
        input?.paymentProfile?.pricingMode === "quote-required" ||
        input?.paymentProfile?.pricingMode === "agent-negotiated"
          ? input.paymentProfile.pricingMode
          : "fixed-exact",
      ...(typeof input?.paymentProfile?.fixedAmountUsd === "string" && input.paymentProfile.fixedAmountUsd.trim().length > 0
        ? { fixedAmountUsd: input.paymentProfile.fixedAmountUsd }
        : {}),
      ...(typeof input?.paymentProfile?.maxAmountUsd === "string" && input.paymentProfile.maxAmountUsd.trim().length > 0
        ? { maxAmountUsd: input.paymentProfile.maxAmountUsd }
        : {}),
      ...(typeof input?.paymentProfile?.quoteUrl === "string" && input.paymentProfile.quoteUrl.trim().length > 0
        ? { quoteUrl: input.paymentProfile.quoteUrl }
        : {}),
      settlementTrigger: "upfront",
      ...(typeof input?.paymentProfile?.baseFacilitatorUrl === "string" && input.paymentProfile.baseFacilitatorUrl.trim().length > 0
        ? { baseFacilitatorUrl: input.paymentProfile.baseFacilitatorUrl }
        : {}),
      ...(typeof input?.paymentProfile?.ethereumFacilitatorUrl === "string" &&
      input.paymentProfile.ethereumFacilitatorUrl.trim().length > 0
        ? { ethereumFacilitatorUrl: input.paymentProfile.ethereumFacilitatorUrl }
        : {}),
      ...(typeof input?.paymentProfile?.paymentNotes === "string" && input.paymentProfile.paymentNotes.trim().length > 0
        ? { paymentNotes: input.paymentProfile.paymentNotes }
        : {})
    },
    socialAnchorPolicy: {
      mode: "shared-batched"
    },
    preferredProvingLocation:
      input?.preferredProvingLocation === "client" || input?.preferredProvingLocation === "sovereign-rollup"
        ? input.preferredProvingLocation
        : "client"
  };
}

export function App() {
  const initialRoute =
    typeof window === "undefined"
      ? {
        agentId: null,
          section: "configure" as const,
          sessionId: null
        }
      : parseRouteState(window.location.pathname, window.location.hash);
  const [state, setState] = useState<ConsoleStateResponse | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(initialSelectedSessionId(initialRoute));
  const [profileSessionId, setProfileSessionId] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<NavSectionKey>(initialRoute.section);
  const [sharedAgentId, setSharedAgentId] = useState<string | null>(initialRoute.agentId);
  const [manageLookupValue, setManageLookupValue] = useState(initialRoute.sessionId ?? initialRoute.agentId ?? "");
  const [profile, setProfile] = useState<AgentProfileDraft>(normalizeProfileDraft());
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [registry, setRegistry] = useState<AgentRegistryEntry[]>([]);
  const [agentAvailability, setAgentAvailability] = useState<AgentRuntimeAvailabilityState | null>(null);
  const [agentAvailabilityLoading, setAgentAvailabilityLoading] = useState(false);
  const [hireDraft, setHireDraft] = useState<HireDraft>({
    taskPrompt: "",
    budgetMina: "",
    requesterContact: ""
  });
  const [hireReceipt, setHireReceipt] = useState<HireRequestReceipt | null>(null);
  const [registrationMethod, setRegistrationMethod] = useState<RegistrationMethod>("cli");
  const [exploreQuery, setExploreQuery] = useState("");
  const [exploreFilter, setExploreFilter] = useState<ExploreFilterKey>("all");
  const [selectedPayoutWalletKey, setSelectedPayoutWalletKey] = useState<PayoutWalletKey>("base");
  const [draftPayoutWalletValue, setDraftPayoutWalletValue] = useState("");
  const [adminKeyDraft, setAdminKeyDraft] = useState("");
  const [issuedOwnershipChallenge, setIssuedOwnershipChallenge] = useState<IssuedOwnershipChallenge | null>(null);
  const [duplicateClaimTarget, setDuplicateClaimTarget] = useState<DuplicateClaimTarget | null>(null);
  const ethereumPayoutAllowed = hasAdvancedEthereumPayout(profile);

  useEffect(() => {
    let cancelled = false;

    void fetchConsoleState(selectedSessionId ?? undefined, selectedSessionId ? undefined : sharedAgentId ?? undefined)
      .then((nextState) => {
        if (cancelled) {
          return;
        }

        setState(nextState);
        setError(null);

        if (!selectedSessionId) {
          setSelectedSessionId(nextState.session.sessionId);
        }
      })
      .catch((nextError: Error) => {
        if (!cancelled) {
          setError(nextError.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, sharedAgentId]);

  useEffect(() => {
    if (!state) {
      return;
    }

    const shouldPoll =
      state.liveFlow.status === "queued" ||
      state.liveFlow.status === "running" ||
      state.sponsorQueue.status === "queued" ||
      state.sponsorQueue.status === "running";

    if (!shouldPoll) {
      return;
    }

    let cancelled = false;
    const intervalId = window.setInterval(() => {
      void fetchConsoleState(selectedSessionId ?? undefined, selectedSessionId ? undefined : sharedAgentId ?? undefined)
        .then((nextState) => {
          if (!cancelled) {
            setState(nextState);
          }
        })
        .catch((nextError: Error) => {
          if (!cancelled) {
            setError(nextError.message);
          }
        });
    }, 2500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [selectedSessionId, state]);

  useEffect(() => {
    if (!state) {
      return;
    }

    if (profileSessionId !== state.session.sessionId) {
      const registeredSession = state.session.sessionId.startsWith("session_agent_");
      setProfile(normalizeProfileDraft(registeredSession ? state.profile : undefined));
      setProfileSessionId(state.session.sessionId);
      return;
    }

    const allowedLocations: PrivacyProvingLocation[] = activeModeFor(state).supportedProvingLocations.filter(
      (location): location is PrivacyProvingLocation => location !== "server"
    );
    if (!allowedLocations.includes(profile.preferredProvingLocation)) {
      setProfile({
        ...profile,
        preferredProvingLocation: allowedLocations[0] ?? "client"
      });
    }
  }, [profile.preferredProvingLocation, profileSessionId, state]);

  useEffect(() => {
    const isRegisteredSession = state?.session.sessionId.startsWith("session_agent_") ?? false;
    if (!state || !isRegisteredSession || !profileSessionId || profileSessionId !== state.session.sessionId) {
      return;
    }

    const profileForSave = {
      ...profile,
      paymentProfile: effectivePaymentProfile(profile)
    };

    if (JSON.stringify(state.profile) === JSON.stringify(profileForSave)) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void updateAgentProfile(profileForSave, profileSessionId)
        .then((nextState) => {
          setState(nextState);
        })
        .catch((nextError: Error) => {
          setError(nextError.message);
        });
    }, 350);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [profile, profileSessionId, state]);

  useEffect(() => {
    if (activeSection !== "explore") {
      return;
    }

    let cancelled = false;
    void fetchAgentRegistry()
      .then((nextRegistry) => {
        if (!cancelled) {
          setRegistry(nextRegistry);
        }
      })
      .catch((nextError: Error) => {
        if (!cancelled) {
          setError(nextError.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeSection, state?.session.sessionId]);

  useEffect(() => {
    if (activeSection !== "explore" || !sharedAgentId) {
      setAgentAvailability(null);
      setAgentAvailabilityLoading(false);
      return;
    }

    let cancelled = false;
    setAgentAvailabilityLoading(true);
    void fetchAgentRuntimeAvailability(sharedAgentId)
      .then((availability) => {
        if (!cancelled) {
          setAgentAvailability(availability);
        }
      })
      .catch((nextError: Error) => {
        if (!cancelled) {
          setAgentAvailability(null);
          setError(nextError.message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAgentAvailabilityLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeSection, sharedAgentId, state?.profile.openClawUrl]);

  useEffect(() => {
    setDraftPayoutWalletValue(profile.payoutWallets[selectedPayoutWalletKey] ?? "");
  }, [
    profile.payoutWallets.base,
    profile.payoutWallets.ethereum,
    selectedPayoutWalletKey
  ]);

  useEffect(() => {
    if (!ethereumPayoutAllowed && selectedPayoutWalletKey === "ethereum") {
      setSelectedPayoutWalletKey("base");
    }
  }, [ethereumPayoutAllowed, selectedPayoutWalletKey]);

  useEffect(() => {
    if (!state) {
      return;
    }

    const storedKey = getStoredAdminKey(state.session.sessionId, state.agentId);
    if (storedKey && storedKey !== adminKeyDraft) {
      setAdminKeyDraft(storedKey);
    }
  }, [adminKeyDraft, state]);

  useEffect(() => {
    setIssuedOwnershipChallenge(null);
  }, [state?.session.sessionId, sharedAgentId]);

  useEffect(() => {
    setDuplicateClaimTarget(null);
  }, [profile.openClawUrl]);

  useEffect(() => {
    setHireReceipt(null);
    setHireDraft({
      taskPrompt: "",
      budgetMina: "",
      requesterContact: ""
    });
  }, [sharedAgentId, state?.agentId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const syncFromLocation = () => {
      const nextRoute = parseRouteState(window.location.pathname, window.location.hash);
      setActiveSection(nextRoute.section);
      setSharedAgentId(nextRoute.agentId);
      if (nextRoute.sessionId) {
        setSelectedSessionId(nextRoute.sessionId);
      } else if (nextRoute.agentId) {
        setSelectedSessionId(null);
      } else if (nextRoute.section === "configure") {
        setSelectedSessionId(ONBOARDING_SESSION_ID);
      } else {
        setSelectedSessionId(null);
      }
    };

    window.addEventListener("hashchange", syncFromLocation);
    window.addEventListener("popstate", syncFromLocation);
    return () => {
      window.removeEventListener("hashchange", syncFromLocation);
      window.removeEventListener("popstate", syncFromLocation);
    };
  }, []);

  async function runAction(actionKey: string, task: () => Promise<ConsoleStateResponse>) {
    setPendingAction(actionKey);
    setError(null);

    try {
      const nextState = await task();
      setState(nextState);
      setSelectedSessionId(nextState.session.sessionId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Action failed.");
    } finally {
      setPendingAction(null);
    }
  }

  async function copyValue(copyKey: string, value: string) {
    try {
      await copyText(value);
      setCopiedKey(copyKey);
      window.setTimeout(() => {
        setCopiedKey(null);
      }, 1600);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Copy failed.");
    }
  }

  async function issueChallengeAction(sessionId?: string, agentId?: string) {
    setPendingAction("issue-ownership-challenge");
    setError(null);

    try {
      const nextState = await issueOwnershipChallenge(sessionId, agentId);
      setIssuedOwnershipChallenge(nextState.issuedOwnershipChallenge);
      setState(nextState);
      setSelectedSessionId(nextState.session.sessionId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not issue ownership challenge.");
    } finally {
      setPendingAction(null);
    }
  }

  async function verifyChallengeAction(sessionId?: string, agentId?: string) {
    await runAction("verify-ownership-challenge", () => verifyOwnershipChallenge(sessionId, agentId));
    setIssuedOwnershipChallenge(null);
  }

  async function checkMissionAuthOverlayAction() {
    setPendingAction("check-mission-auth");
    setError(null);

    try {
      if (isRegisteredSession && hasAdminAccess) {
        const nextState = await checkAndSaveMissionAuthOverlay({
          missionAuthOverlay: profile.missionAuthOverlay,
          sessionId,
          ...(registeredAgentId ? { agentId: registeredAgentId } : {})
        });
        setState(nextState);
        setProfile(normalizeProfileDraft(nextState.profile));
        setSelectedSessionId(nextState.session.sessionId);
        return;
      }

      const result = await checkMissionAuthOverlay({
        missionAuthOverlay: profile.missionAuthOverlay
      });
      setProfile({
        ...profile,
        missionAuthOverlay: result.missionAuthOverlay
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not verify the mission auth overlay.");
    } finally {
      setPendingAction(null);
    }
  }

  async function registerAgentInBrowser() {
    setPendingAction("register-agent");
    setError(null);
    setDuplicateClaimTarget(null);

    try {
      let nextState = await registerAgent({
        agentName: profileForSave.agentName,
        representedPrincipal: profileForSave.representedPrincipal,
        headline: profileForSave.headline,
        openClawUrl: profileForSave.openClawUrl,
        ...(Object.keys(profileForSave.payoutWallets).length > 0
          ? { payoutWallets: profileForSave.payoutWallets }
          : {}),
        missionAuthOverlay: profileForSave.missionAuthOverlay,
        paymentProfile: profileForSave.paymentProfile,
        socialAnchorPolicy: profileForSave.socialAnchorPolicy,
        preferredProvingLocation: profileForSave.preferredProvingLocation
      });

      setState(nextState);
      setSelectedSessionId(nextState.session.sessionId);

      if (nextState.agentId && nextState.profile.openClawUrl.trim().length > 0 && nextState.ownership.status !== "verified") {
        try {
          const challengedState = await issueOwnershipChallenge(nextState.session.sessionId, nextState.agentId);
          setIssuedOwnershipChallenge(challengedState.issuedOwnershipChallenge);
          nextState = challengedState;
          setState(nextState);
          setSelectedSessionId(nextState.session.sessionId);
        } catch (challengeError) {
          setError(
            challengeError instanceof Error
              ? `Agent registered. ${challengeError.message}`
              : "Agent registered, but SantaClawz could not issue the ownership challenge yet."
          );
        }
      }
      showConfigureSession(nextState.session.sessionId);
    } catch (nextError) {
      if (nextError instanceof ApiError) {
        const duplicateAgentId =
          typeof nextError.data?.agentId === "string" && nextError.data.agentId.trim().length > 0
            ? nextError.data.agentId
            : null;
        if (nextError.data?.code === "openclaw_url_registered" && duplicateAgentId) {
          setDuplicateClaimTarget({
            agentId: duplicateAgentId,
            canReclaim: Boolean(nextError.data.canReclaim)
          });
        }
      }
      setError(nextError instanceof Error ? nextError.message : "Could not register agent.");
    } finally {
      setPendingAction(null);
    }
  }

  async function settleSocialAnchorsAction(sessionId?: string, agentId?: string) {
    setPendingAction("settle-social-anchors");
    setError(null);

    try {
      await settleSocialAnchorBatch({
        ...(sessionId ? { sessionId } : {}),
        ...(agentId ? { agentId } : {})
      });
      const nextState = await fetchConsoleState(sessionId, sessionId ? undefined : agentId);
      setState(nextState);
      setSelectedSessionId(nextState.session.sessionId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not settle social proof anchors.");
    } finally {
      setPendingAction(null);
    }
  }

  async function setArchiveStatusAction(nextArchived: boolean) {
    const targetAgentId = registeredAgentId ?? state?.agentId;
    if (!targetAgentId) {
      return;
    }
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        nextArchived
          ? "Archive this agent on SantaClawz? It will be hidden from Explore and new hire requests will stop until you restore it."
          : "Restore this agent on SantaClawz? It will become discoverable and hireable again."
      )
    ) {
      return;
    }

    setPendingAction("set-agent-archive");
    setError(null);

    try {
      const nextState = await setAgentArchiveStatus(targetAgentId, nextArchived, sessionId);
      setState(nextState);
      setProfile(normalizeProfileDraft(nextState.profile));
      setSelectedSessionId(nextState.session.sessionId);
      try {
        setRegistry(await fetchAgentRegistry());
      } catch (refreshError) {
        console.warn(
          `[clawz] archive status updated for ${targetAgentId}, but the registry refresh failed: ${
            refreshError instanceof Error ? refreshError.message : String(refreshError)
          }`
        );
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not update the agent archive status.");
    } finally {
      setPendingAction(null);
    }
  }

  function showSection(nextSection: NavSectionKey) {
    setActiveSection(nextSection);
    if (typeof window !== "undefined") {
      setSharedAgentId(null);
      setSelectedSessionId(nextSection === "configure" ? ONBOARDING_SESSION_ID : null);
      if (nextSection === "configure") {
        setManageLookupValue("");
      }
      window.history.pushState(null, "", buildSectionPath(nextSection));
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function showConfigureSession(nextSessionId?: string | null) {
    setSharedAgentId(null);
    setActiveSection("configure");
    setSelectedSessionId(nextSessionId ?? null);
    setManageLookupValue(nextSessionId ?? "");
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", buildSectionPath("configure", nextSessionId));
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  async function openManageTargetAction() {
    const target = parseManageAgentTarget(manageLookupValue);
    if (!target) {
      setError("Paste a SantaClawz profile URL, public agent ID, or session_agent_... record to manage an agent.");
      return;
    }

    setPendingAction("open-manage-agent");
    setError(null);
    try {
      const nextState = await fetchConsoleState(target.sessionId, target.sessionId ? undefined : target.agentId);
      setState(nextState);
      setSharedAgentId(null);
      setSelectedSessionId(nextState.session.sessionId);
      setActiveSection("configure");
      setManageLookupValue(target.sessionId ?? target.agentId ?? nextState.session.sessionId);
      if (typeof window !== "undefined") {
        window.history.pushState(null, "", buildSectionPath("configure", nextState.session.sessionId));
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not open that agent registration.");
    } finally {
      setPendingAction(null);
    }
  }

  function showAgentProfile(agentId: string, focus: "profile" | "hire" = "profile") {
    setSharedAgentId(agentId);
    setSelectedSessionId(null);
    setActiveSection("explore");
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", buildSectionPath("explore", agentId));
      window.scrollTo({ top: 0, behavior: "smooth" });
      window.setTimeout(() => {
        const targetId = focus === "hire" ? "hire-this-agent" : "agent-profile-top";
        const target = document.getElementById(targetId);
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 120);
    }
  }

  async function retryInitialLoad() {
    setPendingAction("retry-bootstrap");
    setError(null);

    try {
      const nextState = await fetchConsoleState(selectedSessionId ?? undefined, selectedSessionId ? undefined : sharedAgentId ?? undefined);
      setState(nextState);
      setSelectedSessionId(nextState.session.sessionId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not reach the SantaClawz API.");
    } finally {
      setPendingAction(null);
    }
  }

  const apiBase = getApiBase();
  const isExploreView = activeSection === "explore";
  const mastheadTitle = isExploreView
    ? "Explore verified agents for hire"
    : "Configure your OpenClaw agent";
  const mastheadCopy = isExploreView ? EXPLORE_COPY : MASTHEAD_COPY;
  const mastheadSteps = isExploreView ? EXPLORE_STEPS : MASTHEAD_STEPS;

  if (!state) {
    return (
      <main className="app-shell onboarding-shell">
        <header className="site-header">
          <a href="#top" className="site-brand" aria-label="SantaClawz home">
            <img src="/santaclawz-logo.svg" alt="SantaClawz" className="site-brand-logo" />
          </a>

          <nav className="site-nav" aria-label="Primary" role="tablist">
            <button
              type="button"
              className={`site-nav-link${activeSection === "configure" ? " active" : ""}`}
              aria-selected={activeSection === "configure"}
              role="tab"
              onClick={() => {
                showSection("configure");
              }}
            >
              Configure
            </button>
            <button
              type="button"
              className={`site-nav-link${activeSection === "explore" ? " active" : ""}`}
              aria-selected={activeSection === "explore"}
              role="tab"
              onClick={() => {
                showSection("explore");
              }}
            >
              Explore
            </button>
          </nav>
        </header>

        <section className="masthead">
          <div className="masthead-inner">
            <div className="masthead-content">
              <div className="masthead-copy">
                <h1>{mastheadTitle}</h1>
                <p className="masthead-copyline">{mastheadCopy}</p>
              </div>

              <div className="masthead-footer">
                <p className="eyebrow">{mastheadSteps}</p>
              </div>
            </div>
          </div>
        </section>

        <p className={`status-banner${error ? "" : " status-banner-neutral"}`}>
          {error ?? "Connecting to the SantaClawz onboarding backend."}
        </p>

        {activeSection !== "explore" ? (
          <section className="step-stack">
            <section className="panel step-card">
              <div className="step-head">
                <div className="step-title">
                  <span className="step-number">1</span>
                  <div>
                    <h2>Connect backend</h2>
                    <p className="panel-copy">The static site is live. The onboarding API still needs to answer from Render.</p>
                  </div>
                </div>
                <span className="subtle-pill">{error ? "Backend offline" : "Checking"}</span>
              </div>

              <div className="action-list">
                <div className="action-row">
                  <div>
                    <strong>Expected API</strong>
                    <p className="panel-copy api-value">{apiBase}</p>
                  </div>
                  <div className="action-side">
                    <button
                      className="secondary-button"
                      onClick={() => {
                        void copyValue("bootstrap-api-base", apiBase);
                      }}
                    >
                      {copiedKey === "bootstrap-api-base" ? "Copied" : "Copy URL"}
                    </button>
                    <a className="secondary-button" href={`${apiBase}/ready`} target="_blank" rel="noreferrer">
                      Open health
                    </a>
                  </div>
                </div>

                <div className="action-row">
                  <div>
                    <strong>What this means</strong>
                    <p className="panel-copy">
                      Spaceship is serving the frontend correctly. SantaClawz just cannot reach the onboarding API yet, so the
                      live steps are waiting on backend rollout.
                    </p>
                  </div>
                  <div className="action-side">
                    <button
                      className="primary-button"
                      disabled={pendingAction === "retry-bootstrap"}
                      onClick={() => {
                        void retryInitialLoad();
                      }}
                    >
                      {pendingAction === "retry-bootstrap" ? "Retrying..." : "Try again"}
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </section>
        ) : (
          <section id="explore" className="panel explore-panel">
            <div className="section-head">
              <div>
                <p className="eyebrow">Explore</p>
                <h2>Browse other agents</h2>
              </div>
              <span className="subtle-pill">Directory preview</span>
            </div>

            <div className="explore-grid">
              <article className="explore-card explore-card-featured">
                <div className="explore-card-head">
                  <strong>Directory loading</strong>
                  <span className="subtle-pill">Waiting</span>
                </div>
                <p className="panel-copy">SantaClawz needs the onboarding API before it can show registered agents here.</p>
              </article>
            </div>
          </section>
        )}
      </main>
    );
  }

  const sessionId = selectedSessionId ?? state.session.sessionId;
  const launchTarget = state.liveFlowTargets.turns.find(
    (target) => target.sessionId === sessionId && target.canStartNextTurn
  );
  const activeTurn = state.liveFlowTargets.turns.find((target) => target.sessionId === sessionId);
  const hasSponsoredBalance = hasPositiveMina(state.wallet.sponsoredRemainingMina);
  const recoveryReady = state.wallet.recovery.status === "sealed";
  const isRegisteredSession = state.session.sessionId.startsWith("session_agent_");
  const registeredAgentId = isRegisteredSession ? state.agentId : null;
  const published = Boolean(registeredAgentId) && (Boolean(activeTurn?.turnId) || state.liveFlow.status === "succeeded");
  const ownershipVerified = state.ownership.status === "verified";
  const agentArchived = profile.availability === "archived";
  const archivedAtLabel =
    typeof profile.archivedAtIso === "string" && profile.archivedAtIso.trim().length > 0
      ? ` on ${new Date(profile.archivedAtIso).toLocaleString()}`
      : "";
  const connectReady =
    profile.agentName.trim().length > 0 && profile.openClawUrl.trim().length > 0 && profile.headline.trim().length > 0;
  const canPreparePublish = isRegisteredSession && connectReady;
  const canPublish = isRegisteredSession && connectReady && hasSponsoredBalance && recoveryReady && ownershipVerified;
  const hasAdminAccess = state.adminAccess.hasAdminAccess;
  const savedPaymentsEnabled = state.paymentsEnabled;
  const savedPaymentProfileReady = state.paymentProfileReady;
  const paidJobsEnabled = state.paidJobsEnabled;
  const missionAuthOverlay = profile.missionAuthOverlay;
  const missionAuthEnabled = missionAuthOverlay.enabled;
  const missionAuthVerified = missionAuthOverlay.status === "verified";
  const paymentProfile = effectivePaymentProfile(profile);
  const paymentsEnabled = paymentProfile.enabled;
  const paymentProfileReady = paymentProfileDraftReady(published, profile);
  const configuredPayoutWallets = ([
    ["base", profile.payoutWallets.base],
    ...(ethereumPayoutAllowed ? [["ethereum", profile.payoutWallets.ethereum] as const] : [])
  ] as Array<[PayoutWalletKey, string | undefined]>).filter(([, value]) => value?.trim().length);
  const walletsReady = configuredPayoutWallets.length > 0;
  const profileForSave = {
    ...profile,
    paymentProfile
  };
  const defaultPaymentRail = paymentProfile.defaultRail ?? paymentProfile.supportedRails[0] ?? "base-usdc";
  const paidWorkStatusLabel = agentArchived
    ? "Archived on SantaClawz"
    : !published
      ? "Publish first"
      : !savedPaymentsEnabled
        ? "Prepay setup"
        : savedPaymentProfileReady
          ? `Payouts live on ${railLabel(defaultPaymentRail)}`
          : "Finish prepay setup";
  const paymentSectionLead = agentArchived
    ? "This agent is archived on SantaClawz."
    : !paymentsEnabled
      ? "You're almost ready to earn."
      : paymentProfileReady
        ? "Prepay enabled. This agent can accept paid jobs."
        : "Finish the required prepay details to start earning.";
  const paymentSummaryMessage = agentArchived
    ? "Archived agents stay on their public URL for proof history, but SantaClawz hides them from Explore and disables new hire requests until restored."
    : !published
      ? "Publish on Zeko first to let buyers discover and pay this agent."
      : paymentProfileSummary(paymentProfileReady, paymentProfile);
  const protocolFeeAppliesToDefaultRail = Boolean(
    state.protocolOwnerFeePolicy.enabled &&
      defaultPaymentRail &&
      state.protocolOwnerFeePolicy.recipientByRail[defaultPaymentRail]
  );
  const protocolFeePercentLabel = formatBpsPercent(state.protocolOwnerFeePolicy.feeBps);
  const sellerNetPercentLabel = formatBpsPercent(10_000 - state.protocolOwnerFeePolicy.feeBps);
  const paymentFeeDisclosure =
    protocolFeeAppliesToDefaultRail && paymentProfile.enabled
      ? paymentProfile.settlementTrigger === "upfront"
        ? `Buyers pay the listed price up front. SantaClawz calculates agent net using the higher of ${protocolFeePercentLabel}% or the current network facilitation cost, so price small jobs with that minimum in mind.`
        : `Buyers pay the listed price up front. SantaClawz keeps ${protocolFeePercentLabel}% and sellers receive ${sellerNetPercentLabel}% of the listed price.`
      : null;
  const paymentPolicyGuidance = !paymentProfile.enabled
    ? "Leave payments off until the agent is ready. Fixed price is live Base prepay; quote modes are intake first."
    : paymentProfile.pricingMode === "fixed-exact"
      ? "Live Base prepay: buyers pay this exact amount before SantaClawz submits /hire to an online agent."
      : paymentProfile.pricingMode === "capped-exact"
        ? "Use this for bounded authorizations later; V1 still needs a release policy before live settlement."
        : paymentProfile.pricingMode === "quote-required"
          ? "First inbound is a lightweight quote request. The agent estimates compute and API credits before execution."
          : "The agent can negotiate each job, but paid execution should wait for an exact quote or authorization.";
  const mainPricingLabel =
    paymentProfile.pricingMode === "quote-required" || paymentProfile.pricingMode === "agent-negotiated"
      ? "Quote URL"
      : paymentProfile.pricingMode === "capped-exact"
        ? "Max price per job (USD)"
        : "Price per job (USD)";
  const mainPricingValue =
    paymentProfile.pricingMode === "quote-required" || paymentProfile.pricingMode === "agent-negotiated"
      ? paymentProfile.quoteUrl ?? ""
      : paymentProfile.pricingMode === "capped-exact"
        ? paymentProfile.maxAmountUsd ?? ""
        : paymentProfile.fixedAmountUsd ?? "";
  const mainPricingPlaceholder =
    paymentProfile.pricingMode === "quote-required" || paymentProfile.pricingMode === "agent-negotiated"
      ? "https://agent.example.com/payments"
      : paymentProfile.pricingMode === "capped-exact"
        ? "0.25"
        : "0.20";
  const paymentSaveLabel = pendingAction === "save-payment-profile"
    ? "Saving..."
    : !paymentsEnabled
      ? "Enable payments"
      : paymentProfileReady
        ? "Save changes"
        : "Save payment setup";
  const publicAgentUrl = registeredAgentId ? buildPublicAgentUrl(registeredAgentId) : null;
  const routedPublicAgentUrl = sharedAgentId ?? state.agentId ? buildPublicAgentUrl(sharedAgentId ?? state.agentId) : null;
  const shareOnXUrl = publicAgentUrl && registeredAgentId ? buildShareOnXUrl(publicAgentUrl, registeredAgentId) : null;
  const heartbeatAgentId = registeredAgentId ?? sharedAgentId ?? state.agentId;
  const currentAdminKey = getStoredAdminKey(sessionId, heartbeatAgentId);
  const heartbeatSenderCommand = [
    `CLAWZ_API_BASE=${shellQuote(getApiBase())}`,
    `CLAWZ_AGENT_ID=${shellQuote(heartbeatAgentId)}`,
    `CLAWZ_AGENT_ADMIN_KEY=${shellQuote(currentAdminKey || "sck_...")}`,
    "pnpm heartbeat:agent"
  ].join(" \\\n");
  const heartbeatCurlCommand = [
    `curl -X POST ${shellQuote(`${getApiBase()}/api/agents/${encodeURIComponent(heartbeatAgentId)}/heartbeat`)} \\`,
    `  -H ${shellQuote("content-type: application/json")} \\`,
    `  -H ${shellQuote(`x-clawz-admin-key: ${currentAdminKey || "sck_..."}`)} \\`,
    `  -d ${shellQuote(JSON.stringify({ status: "live", ttlSeconds: 30, note: "Local OpenClaw gateway heartbeat" }))}`
  ].join("\n");
  const currentSocialAnchorQueue = isRegisteredSession
    ? state.socialAnchorQueue
    : {
        pendingCount: 0,
        anchoredCount: 0,
        items: [],
        recentBatches: []
      };
  const latestSocialAnchorBatch = currentSocialAnchorQueue.recentBatches[0];
  const socialAnchorActionLabel = pendingAction === "settle-social-anchors"
    ? "Anchoring..."
    : "Anchor queued milestones";
  const normalizedExploreQuery = exploreQuery.trim().toLowerCase();
  const filteredRegistry = registry.filter(
    (agent) => matchesExploreFilter(agent, exploreFilter) && matchesExploreQuery(agent, normalizedExploreQuery)
  );
  const featuredAgents = [...filteredRegistry]
    .sort((left, right) => featuredAgentScore(right) - featuredAgentScore(left))
    .slice(0, 3);
  const featuredAgentIds = new Set(featuredAgents.map((agent) => agent.agentId));
  const recentAgents = [...filteredRegistry]
    .sort((left, right) => timestampValue(right.lastUpdatedAtIso) - timestampValue(left.lastUpdatedAtIso))
    .filter((agent) => !featuredAgentIds.has(agent.agentId))
    .slice(0, 6);
  const dispatchAgents = [...filteredRegistry]
    .filter((agent) => agent.headline.trim().length > 0)
    .sort((left, right) => featuredAgentScore(right) - featuredAgentScore(left))
    .slice(0, 3);
  const liveActivityAgents = [...filteredRegistry]
    .sort((left, right) => timestampValue(right.lastUpdatedAtIso) - timestampValue(left.lastUpdatedAtIso))
    .slice(0, 6);
  const socialOpenLineAgent = dispatchAgents[0] ?? featuredAgents[0] ?? recentAgents[0] ?? filteredRegistry[0] ?? null;
  const highlightAgent = featuredAgents[0] ?? recentAgents[0] ?? filteredRegistry[0] ?? null;
  const feedAgents = [...filteredRegistry]
    .sort((left, right) => timestampValue(right.lastUpdatedAtIso) - timestampValue(left.lastUpdatedAtIso))
    .slice(0, 8);
  const payoutsLiveAgents = [...filteredRegistry]
    .filter((agent) => agent.paidJobsEnabled)
    .sort((left, right) => timestampValue(right.lastUpdatedAtIso) - timestampValue(left.lastUpdatedAtIso))
    .slice(0, 4);
  const verifiedAgents = [...filteredRegistry]
    .filter((agent) => agent.ownershipVerified)
    .sort((left, right) => timestampValue(right.lastUpdatedAtIso) - timestampValue(left.lastUpdatedAtIso))
    .slice(0, 4);
  const ownershipChallengePreview =
    issuedOwnershipChallenge?.challengeResponseJson ??
    (state.ownership.status === "challenge-issued"
      ? `Issue a fresh challenge to recover the verification token, then serve it at ${state.ownership.challenge?.challengePath ?? "/.well-known/santaclawz-agent-challenge.json"}.`
      : null);
  const ownershipStatusCopy =
    !isRegisteredSession
      ? "Register the agent first, then SantaClawz can verify control of the OpenClaw runtime before publish."
      : state.ownership.status === "verified"
      ? `Control verified${state.ownership.verification?.verifiedAtIso ? ` on ${new Date(state.ownership.verification.verifiedAtIso).toLocaleString()}` : ""}.`
      : state.ownership.status === "challenge-issued"
        ? `Serve the current challenge from ${state.ownership.challenge?.challengePath ?? "/.well-known/santaclawz-agent-challenge.json"}, then verify control.`
        : state.ownership.status === "legacy-unverified"
          ? hasAdminAccess
            ? "This is a legacy registration. Verify control of the OpenClaw runtime before SantaClawz can publish it."
            : "This agent predates ownership checks. Prove control of the OpenClaw runtime to reclaim and publish it."
          : "Prove control of the OpenClaw runtime before SantaClawz can publish this agent on Zeko.";
  const cliRegisterCommand = [
    "pnpm register:agent --",
    `--agent-name ${shellQuote(profile.agentName || "SantaClawz Operator")}`,
    `--headline ${shellQuote(profile.headline || "Private research and verifiable delivery.")}`,
    `--openclaw-url ${shellQuote(profile.openClawUrl || "https://your-openclaw-agent.example.com")}`,
    ...(profile.representedPrincipal.trim().length > 0
      ? [`--represented-principal ${shellQuote(profile.representedPrincipal)}`]
      : []),
    ...(profile.payoutWallets.base?.trim().length
      ? [`--base-payout-address ${shellQuote(profile.payoutWallets.base)}`]
      : []),
    ...(ethereumPayoutAllowed && profile.payoutWallets.ethereum?.trim().length
      ? [`--ethereum-payout-address ${shellQuote(profile.payoutWallets.ethereum)}`]
      : []),
    ...(paymentProfile.enabled ? ["--payments-enabled"] : []),
    ...(paymentProfile.baseFacilitatorUrl?.trim().length
      ? [`--base-facilitator-url ${shellQuote(paymentProfile.baseFacilitatorUrl)}`]
      : []),
    ...(paymentProfile.ethereumFacilitatorUrl?.trim().length
      ? [`--ethereum-facilitator-url ${shellQuote(paymentProfile.ethereumFacilitatorUrl)}`]
      : []),
    ...(paymentProfile.defaultRail ? [`--default-rail ${shellQuote(paymentProfile.defaultRail)}`] : []),
    `--pricing-mode ${shellQuote(paymentProfile.pricingMode)}`,
    ...(paymentProfile.fixedAmountUsd?.trim().length
      ? [`--fixed-price-usd ${shellQuote(paymentProfile.fixedAmountUsd)}`]
      : []),
    ...(paymentProfile.maxAmountUsd?.trim().length
      ? [`--max-price-usd ${shellQuote(paymentProfile.maxAmountUsd)}`]
      : []),
    ...(paymentProfile.quoteUrl?.trim().length
      ? [`--quote-url ${shellQuote(paymentProfile.quoteUrl)}`]
      : []),
    ...(paymentProfile.paymentNotes?.trim().length
      ? [`--payment-notes ${shellQuote(paymentProfile.paymentNotes)}`]
      : []),
    ...(missionAuthEnabled && missionAuthOverlay.authorityBaseUrl?.trim().length
      ? [`--mission-auth-url ${shellQuote(missionAuthOverlay.authorityBaseUrl)}`]
      : []),
    ...(missionAuthEnabled && missionAuthOverlay.providerHint?.trim().length
      ? [`--mission-auth-provider ${shellQuote(missionAuthOverlay.providerHint)}`]
      : []),
    ...(missionAuthEnabled && missionAuthOverlay.scopeHints.length > 0
      ? [`--mission-auth-scopes ${shellQuote(missionAuthOverlay.scopeHints.join(","))}`]
      : []),
    "--write-env .env.santaclawz",
    "--write-challenge .well-known/santaclawz-agent-challenge.json"
  ].join(" ");
  const cliHeartbeatCheckCommand = "pnpm heartbeat:agent -- --env-file .env.santaclawz --once";
  const focusedRegistryAgent = sharedAgentId ? registry.find((agent) => agent.agentId === sharedAgentId) ?? null : null;
  const focusedAgentAvailability =
    sharedAgentId && agentAvailability?.agentId === sharedAgentId ? agentAvailability : null;
  const agentRuntimeCheckPending = Boolean(sharedAgentId) && agentAvailabilityLoading && !focusedAgentAvailability;
  const focusedRuntimeStatus: AgentRuntimeStatus =
    focusedAgentAvailability?.runtimeStatus ?? focusedRegistryAgent?.runtimeStatus ?? "waiting";
  const focusedRuntimeStatusLabel = agentRuntimeCheckPending ? "Checking" : runtimeStatusLabel(focusedRuntimeStatus);
  const focusedRuntimeStatusClass = agentRuntimeCheckPending
    ? "runtime-status-waiting"
    : runtimeStatusClass(focusedRuntimeStatus);
  const agentRuntimeOffline = Boolean(
    sharedAgentId && focusedAgentAvailability && !focusedAgentAvailability.reachable
  );
  const canSubmitHire =
    Boolean(sharedAgentId) &&
    !agentArchived &&
    published &&
    profile.openClawUrl.trim().length > 0 &&
    !agentRuntimeCheckPending &&
    !agentRuntimeOffline &&
    hireDraft.taskPrompt.trim().length > 0 &&
    hireDraft.requesterContact.trim().length > 0;
  const hireStatusCopy = agentArchived
    ? `This agent is archived on SantaClawz${archivedAtLabel}. Its public proof history stays online, but new hire requests are disabled.`
    : !published
      ? "This agent still needs to publish on Zeko before it can accept work."
      : agentRuntimeCheckPending
        ? "Checking that this OpenClaw agent is online before SantaClawz requests payment or submits work."
        : agentRuntimeOffline
          ? `This OpenClaw agent appears offline. SantaClawz will not request payment or send hires until it is reachable${focusedAgentAvailability?.reason ? `: ${focusedAgentAvailability.reason}` : "."}`
      : savedPaymentsEnabled && !savedPaymentProfileReady
        ? "This agent has started payout setup, but it still needs its facilitator, selected rail, or price details completed."
        : savedPaymentsEnabled && paidJobsEnabled
          ? `Payouts are live on ${railLabel(defaultPaymentRail)} and work routes to ${profile.openClawUrl}.`
          : `Hire requests route to ${profile.openClawUrl}.`
  ;
  const missionAuthStatusCopy = !missionAuthEnabled
    ? "Add this if the agent uses an Auth0, Okta, or custom OIDC sidecar for mission approvals and portable Web2 receipts."
    : missionAuthVerified
      ? `${missionAuthOverlay.authorityName ?? "Mission auth overlay"} verified${missionAuthOverlay.lastVerifiedAtIso ? ` on ${new Date(missionAuthOverlay.lastVerifiedAtIso).toLocaleString()}` : ""}.`
      : "Paste the public sidecar URL, then check its discovery document and mission authority JWKS.";

  function savePayoutWallet() {
    const trimmedValue = draftPayoutWalletValue.trim();
    if (!trimmedValue) {
      setError("Paste a payout wallet address before adding it.");
      return;
    }

    if (!isLikelyEvmAddress(trimmedValue)) {
      setError(`${payoutWalletLabel(selectedPayoutWalletKey)} payout wallet must be a valid EVM address.`);
      return;
    }

    const nextWallets = {
      ...profile.payoutWallets,
      [selectedPayoutWalletKey]: trimmedValue
    };

    const nextProfile = {
      ...profile,
      payoutWallets: nextWallets
    };
    const nextWalletKey = nextPayoutWalletKey(nextWallets, hasAdvancedEthereumPayout(nextProfile));
    setProfile({
      ...profile,
      payoutWallets: nextWallets
    });
    setSelectedPayoutWalletKey(nextWalletKey);
    setDraftPayoutWalletValue(nextWallets[nextWalletKey] ?? "");
    setError(null);
  }

  function removePayoutWallet(walletKey: PayoutWalletKey) {
    const nextWallets = {
      ...profile.payoutWallets
    };
    delete nextWallets[walletKey];
    setProfile({
      ...profile,
      payoutWallets: nextWallets
    });
    setSelectedPayoutWalletKey(walletKey);
    setDraftPayoutWalletValue("");
  }

  function enablePayments() {
    setProfile({
      ...profile,
      paymentProfile: {
        ...profile.paymentProfile,
        enabled: true,
        ...(profile.paymentProfile.fixedAmountUsd?.trim().length ||
        profile.paymentProfile.pricingMode === "quote-required" ||
        profile.paymentProfile.pricingMode === "agent-negotiated" ||
        profile.paymentProfile.pricingMode === "capped-exact"
          ? {}
          : { fixedAmountUsd: "0.20" })
      }
    });
    setError(null);
  }

  function disablePayments() {
    setProfile({
      ...profile,
      paymentProfile: {
        ...profile.paymentProfile,
        enabled: false
      }
    });
    setError(null);
  }

  function unlockAdminAccess() {
    const trimmedKey = adminKeyDraft.trim();
    const targetAgentId = registeredAgentId ?? state?.agentId;
    if (!trimmedKey) {
      setError("Paste the agent admin key first.");
      return;
    }

    storeAdminKey(trimmedKey, sessionId, targetAgentId);
    setPendingAction("unlock-admin");
    setError(null);
    void fetchConsoleState(sessionId, targetAgentId)
      .then((nextState) => {
        setState(nextState);
      })
      .catch((nextError: Error) => {
        setError(nextError.message);
      })
      .finally(() => {
        setPendingAction(null);
      });
  }

  return (
    <main id="top" className="app-shell onboarding-shell">
      <header className="site-header">
        <a href="#top" className="site-brand" aria-label="SantaClawz home">
          <img src="/santaclawz-logo.svg" alt="SantaClawz" className="site-brand-logo" />
        </a>

        <nav className="site-nav" aria-label="Primary" role="tablist">
          <button
            type="button"
            className={`site-nav-link${activeSection === "configure" ? " active" : ""}`}
            aria-selected={activeSection === "configure"}
            role="tab"
            onClick={() => {
              showSection("configure");
            }}
          >
            Configure
          </button>
          <button
            type="button"
            className={`site-nav-link${activeSection === "explore" ? " active" : ""}`}
            aria-selected={activeSection === "explore"}
            role="tab"
            onClick={() => {
              showSection("explore");
            }}
          >
            Explore
          </button>
        </nav>
      </header>

      <section className="masthead">
        <div className="masthead-inner">
          <div className="masthead-content">
              <div className="masthead-copy">
                <h1>{mastheadTitle}</h1>
                <p className="masthead-copyline">{mastheadCopy}</p>
              </div>

              <div className="masthead-footer">
                <p className="eyebrow">{mastheadSteps}</p>
              </div>
            </div>
        </div>
      </section>

      {error ? <p className="status-banner">{error}</p> : null}

      {activeSection !== "explore" ? (
        <section id="configure" className="step-stack configure-stack">
          <section className="panel step-card">
          <div className="step-head">
            <div className="step-title">
              <span className="step-number">1</span>
              <div>
                <h2>Connect agent</h2>
                <p className="panel-copy">Check the requirements, enter policy details, and generate the enrollment command your OpenClaw agent can run.</p>
              </div>
            </div>
          </div>

          <div className="field-grid compact-field-grid">
            <label className="field">
              <span>Agent name</span>
              <input
                className="text-input"
                value={profile.agentName}
                onChange={(event: ValueInputEvent) => {
                  setProfile({
                    ...profile,
                    agentName: event.target.value
                  });
                }}
                placeholder="SantaClawz Operator"
              />
            </label>

            <label className="field">
              <span>Represented principal</span>
              <input
                className="text-input"
                value={profile.representedPrincipal}
                onChange={(event: ValueInputEvent) => {
                  setProfile({
                    ...profile,
                    representedPrincipal: event.target.value
                  });
                }}
                placeholder="Existing OpenClaw operator"
              />
            </label>

            <label className="field field-wide">
              <div className="field-label-row">
                <span>OpenClaw agent URL</span>
                <a className="field-help-link" href={PUBLIC_HIRE_URL_GUIDE_URL} target="_blank" rel="noreferrer">
                  Why this URL is public
                </a>
              </div>
              <input
                className="text-input"
                value={profile.openClawUrl}
                onChange={(event: ValueInputEvent) => {
                  setProfile({
                    ...profile,
                    openClawUrl: event.target.value
                  });
                }}
                placeholder="https://your-openclaw-agent.example.com"
              />
            </label>

            <label className="field field-wide">
              <span>What it does</span>
              <textarea
                className="text-area compact-text-area"
                value={profile.headline}
                onChange={(event: ValueInputEvent) => {
                  setProfile({
                    ...profile,
                    headline: event.target.value
                  });
                }}
                placeholder="Private research, governed execution, and verifiable delivery."
              />
            </label>

            <label className="field">
              <span>Base Network Payout Wallet</span>
              <input
                className="text-input"
                value={profile.payoutWallets.base ?? ""}
                onChange={(event: ValueInputEvent) => {
                  setProfile({
                    ...profile,
                    payoutWallets: {
                      ...profile.payoutWallets,
                      base: event.target.value
                    }
                  });
                }}
                placeholder="0x..."
              />
            </label>

            <label className="field">
              <span>Payment policy</span>
              <select
                className="text-input"
                value={paymentProfile.enabled ? paymentProfile.pricingMode : "off"}
                onChange={(event: ValueInputEvent) => {
                  const nextPolicy = event.target.value;
                  if (nextPolicy === "off") {
                    setProfile({
                      ...profile,
                      paymentProfile: {
                        ...profile.paymentProfile,
                        enabled: false
                      }
                    });
                    return;
                  }
                  setProfile({
                    ...profile,
                    paymentProfile: {
                      ...profile.paymentProfile,
                      enabled: true,
                      defaultRail: "base-usdc",
                      supportedRails: ["base-usdc"],
                      pricingMode: nextPolicy as AgentProfileState["paymentProfile"]["pricingMode"]
                    }
                  });
                }}
              >
                <option value="off">Not accepting paid jobs yet</option>
                <option value="fixed-exact">Fixed price</option>
                <option value="quote-required">Quote required</option>
                <option value="capped-exact">Capped price</option>
                <option value="agent-negotiated">Negotiated by agent</option>
              </select>
              <small className="field-hint">{paymentPolicyGuidance}</small>
            </label>

            {paymentProfile.enabled ? (
              <label className="field">
                <span>{mainPricingLabel}</span>
                <input
                  className="text-input"
                  value={mainPricingValue}
                  onChange={(event: ValueInputEvent) => {
                    if (
                      paymentProfile.pricingMode === "quote-required" ||
                      paymentProfile.pricingMode === "agent-negotiated"
                    ) {
                      setProfile({
                        ...profile,
                        paymentProfile: {
                          ...profile.paymentProfile,
                          quoteUrl: event.target.value
                        }
                      });
                      return;
                    }

                    if (paymentProfile.pricingMode === "capped-exact") {
                      setProfile({
                        ...profile,
                        paymentProfile: {
                          ...profile.paymentProfile,
                          maxAmountUsd: event.target.value
                        }
                      });
                      return;
                    }

                    setProfile({
                      ...profile,
                      paymentProfile: {
                        ...profile.paymentProfile,
                        fixedAmountUsd: event.target.value
                      }
                    });
                  }}
                  placeholder={mainPricingPlaceholder}
                />
              </label>
            ) : null}

          </div>

          <div className="mission-auth-card">
            <div className="mission-auth-head">
              <div className="mission-auth-copy">
                <strong>Enterprise auth overlay</strong>
                <p className="panel-copy">{missionAuthStatusCopy}</p>
              </div>
              <div className="mission-auth-head-actions">
                <span className="subtle-pill">{missionAuthStatusLabel(missionAuthOverlay)}</span>
                {!missionAuthEnabled ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setProfile({
                        ...profile,
                        missionAuthOverlay: {
                          ...profile.missionAuthOverlay,
                          enabled: true,
                          status: "configured"
                        }
                      });
                    }}
                  >
                    Add auth
                  </button>
                ) : null}
              </div>
            </div>

            {missionAuthEnabled ? (
              <div className="mission-auth-body">
                <div className="field-grid compact-field-grid mission-auth-grid">
                  <label className="field field-wide">
                    <span>Mission auth URL</span>
                    <input
                      className="text-input"
                      value={missionAuthOverlay.authorityBaseUrl ?? ""}
                      onChange={(event: ValueInputEvent) => {
                        setProfile({
                          ...profile,
                          missionAuthOverlay: {
                            ...profile.missionAuthOverlay,
                            authorityBaseUrl: event.target.value,
                            status: "configured"
                          }
                        });
                      }}
                      placeholder="https://auth-sidecar.example.com"
                    />
                  </label>

                  <label className="field">
                    <span>Provider</span>
                    <select
                      className="text-input"
                      value={missionAuthOverlay.providerHint ?? "custom-oidc"}
                      onChange={(event: ValueInputEvent) => {
                        setProfile({
                          ...profile,
                          missionAuthOverlay: {
                            ...profile.missionAuthOverlay,
                            providerHint: event.target.value as NonNullable<AgentProfileState["missionAuthOverlay"]["providerHint"]>
                          }
                        });
                      }}
                    >
                      <option value="custom-oidc">Custom OIDC</option>
                      <option value="auth0">Auth0</option>
                      <option value="okta">Okta</option>
                    </select>
                  </label>

                  <label className="field">
                    <span>Scope hints</span>
                    <input
                      className="text-input"
                      value={missionAuthOverlay.scopeHints.join(", ")}
                      onChange={(event: ValueInputEvent) => {
                        setProfile({
                          ...profile,
                          missionAuthOverlay: {
                            ...profile.missionAuthOverlay,
                            scopeHints: event.target.value
                              .split(",")
                              .map((scope) => scope.trim())
                              .filter((scope) => scope.length > 0)
                          }
                        });
                      }}
                      placeholder="drive.readonly, github:repo, compute:clinical"
                    />
                  </label>
                </div>

                <div className="mission-auth-actions">
                  <p className="panel-copy">
                    SantaClawz verifies the published discovery document and mission authority JWKS here. OAuth login, mission approval, and bundle export stay on your sidecar.
                  </p>
                  <div className="action-side">
                    <a className="secondary-button" href={MISSION_AUTH_GUIDE_URL} target="_blank" rel="noreferrer">
                      Open setup guide
                    </a>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={pendingAction === "check-mission-auth"}
                      onClick={() => {
                        void checkMissionAuthOverlayAction();
                      }}
                    >
                      {pendingAction === "check-mission-auth" ? "Checking..." : "Check overlay"}
                    </button>
                    <button
                      type="button"
                      className="mini-button"
                      onClick={() => {
                        setProfile({
                          ...profile,
                          missionAuthOverlay: {
                            enabled: false,
                            status: "disabled",
                            scopeHints: []
                          }
                        });
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {missionAuthVerified ? (
                  <div className="share-url-placeholder live mission-auth-summary">
                    {missionAuthOverlay.authorityName ?? "Mission auth"} verified
                    {missionAuthOverlay.supportedProviders?.length
                      ? ` • ${missionAuthOverlay.supportedProviders.join(", ")}`
                      : missionAuthOverlay.providerHint
                        ? ` • ${missionAuthProviderLabel(missionAuthOverlay.providerHint)}`
                        : ""}
                    {missionAuthOverlay.exportBundleUrl ? " • portable bundle export ready" : ""}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="register-divider" />

          <div className="register-flow-card">
            <div className="register-flow-head">
              <div>
                <strong>Agent-native enrollment</strong>
                <p className="panel-copy">
                  {registrationMethod === "browser"
                    ? isRegisteredSession
                      ? `Registered to ${state.agentId}. This browser already owns the registration record for this agent.`
                      : "Manual browser registration is still available for testing, but production agents should enroll from their OpenClaw runtime so they can store and reuse their own admin key."
                    : "Run this from the OpenClaw runtime. It registers the agent, writes the SantaClawz admin key into a private env file, and exports the ownership challenge file the runtime should serve."}
                </p>
              </div>
              <div className="inline-toggle compact-inline-toggle" role="radiogroup" aria-label="Registration method">
                <button
                  className={registrationMethod === "browser" ? "inline-toggle-button active" : "inline-toggle-button"}
                  onClick={() => {
                    setRegistrationMethod("browser");
                  }}
                  role="radio"
                  aria-checked={registrationMethod === "browser"}
                >
                  Browser
                </button>
                <button
                  className={registrationMethod === "cli" ? "inline-toggle-button active" : "inline-toggle-button"}
                  onClick={() => {
                    setRegistrationMethod("cli");
                  }}
                  role="radio"
                  aria-checked={registrationMethod === "cli"}
                >
                  CLI
                </button>
              </div>
            </div>

            {registrationMethod === "browser" ? (
              <div className="register-browser-stack">
                <button
                  className="primary-button register-browser-button"
                  disabled={pendingAction === "register-agent" || !connectReady || isRegisteredSession}
                  onClick={() => {
                    void registerAgentInBrowser();
                  }}
                >
                  {pendingAction === "register-agent" ? "Registering..." : isRegisteredSession ? "Registered" : "Manual browser register"}
                </button>
                {duplicateClaimTarget ? (
                  <div className="status-note ownership-reclaim-note">
                    <div>
                      <strong>{duplicateClaimTarget.canReclaim ? "This OpenClaw URL is already registered." : "This OpenClaw URL is already claimed."}</strong>
                      <span>
                        {duplicateClaimTarget.canReclaim
                          ? "Open the existing agent record, issue the ownership challenge, and verify control to reclaim it."
                          : "Open the existing agent profile to inspect the verified record."}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        showAgentProfile(duplicateClaimTarget.agentId);
                      }}
                    >
                      {duplicateClaimTarget.canReclaim ? "Open and reclaim" : "Open existing agent"}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="register-cli-stack">
                <p className="panel-copy register-method-copy">
                  Run this once from the OpenClaw project. The generated `.env.santaclawz` should stay private and must be stored with the agent's runtime secrets. SantaClawz cannot recover this admin key later.
                </p>
                <div className="command-strip compact-command-strip">
                  <code>{cliRegisterCommand}</code>
                  <button
                    className="copy-button"
                    onClick={() => {
                      void copyValue("cli-register-command", cliRegisterCommand);
                    }}
                  >
                    {copiedKey === "cli-register-command" ? "Copied" : "Copy"}
                  </button>
                </div>
                <p className="panel-copy register-method-copy">
                  After the challenge file is served from the OpenClaw URL, use the generated env file to smoke-test agent presence.
                </p>
                <div className="command-strip compact-command-strip">
                  <code>{cliHeartbeatCheckCommand}</code>
                  <button
                    className="copy-button"
                    onClick={() => {
                      void copyValue("cli-heartbeat-check-command", cliHeartbeatCheckCommand);
                    }}
                  >
                    {copiedKey === "cli-heartbeat-check-command" ? "Copied" : "Copy"}
                  </button>
                </div>
                <div className="adapter-help">
                  <a className="secondary-button" href={OPENCLAW_SELF_ENROLLMENT_GUIDE_URL} target="_blank" rel="noreferrer">
                    Open enrollment guide
                  </a>
                  <div className="command-strip compact-command-strip">
                    <code>pnpm add openclaw @clawz/openclaw-adapter</code>
                    <button
                      className="copy-button"
                      onClick={() => {
                        void copyValue("install-command", "pnpm add openclaw @clawz/openclaw-adapter");
                      }}
                    >
                      {copiedKey === "install-command" ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              </div>
            )}

          </div>
          </section>
          <section className="panel step-card manage-selector-card">
            <div className="step-head">
              <div className="step-title">
                <span className="step-number manage-step-number">2</span>
                <div>
                  <h2>Manage agent</h2>
                  <p className="panel-copy">
                    Open an existing SantaClawz agent to update settings, publish, archive, heartbeat, or inspect proof history.
                  </p>
                </div>
              </div>
            </div>

            <div className="manage-agent-card">
              <div>
                <span className="metric">Agent registration</span>
                <p className="panel-copy manage-session-note">
                  Paste a public profile URL, public agent ID, or session_agent_... record. New agents should still enroll from the command above so they can save their admin key.
                </p>
              </div>
              <form
                className="manage-agent-open-form"
                onSubmit={(event: FormSubmitEvent) => {
                  event.preventDefault();
                  void openManageTargetAction();
                }}
              >
                <label className="field manage-agent-input-field">
                  <span>Agent URL or ID</span>
                  <input
                    className="text-input"
                    value={manageLookupValue}
                    onChange={(event: ValueInputEvent) => {
                      setManageLookupValue(event.target.value);
                    }}
                    placeholder="https://santaclawz.ai/explore/... or session_agent_..."
                  />
                </label>
                <button type="submit" className="primary-button" disabled={pendingAction === "open-manage-agent"}>
                  {pendingAction === "open-manage-agent" ? "Opening..." : "Open agent"}
                </button>
              </form>
              {isRegisteredSession ? (
                <p className="panel-copy manage-current-agent">
                  Current: {state.profile.agentName || state.agentId} ({state.session.sessionId})
                </p>
              ) : null}
            </div>

            {isRegisteredSession ? (
              <div className="ownership-panel">
                <div>
                  <span className="metric">Admin access</span>
                  <p className="panel-copy">
                    {hasAdminAccess
                      ? "This browser can manage the agent. Keep the admin key if you want to update it from another device later."
                      : `Paste the admin key to unlock agent settings. ${state.adminAccess.keyHint ? `Saved hint: ${state.adminAccess.keyHint}.` : ""}`}
                  </p>
                </div>
                <div className="ownership-actions">
                  {hasAdminAccess ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={!currentAdminKey}
                      onClick={() => {
                        if (currentAdminKey) {
                          void copyValue("admin-key", currentAdminKey);
                        }
                      }}
                    >
                      {copiedKey === "admin-key" ? "Copied admin key" : "Copy admin key"}
                    </button>
                  ) : (
                    <>
                      <input
                        className="text-input ownership-input"
                        value={adminKeyDraft}
                        onChange={(event: ValueInputEvent) => {
                          setAdminKeyDraft(event.target.value);
                        }}
                        placeholder="sck_..."
                      />
                      <button
                        type="button"
                        className="primary-button"
                        disabled={pendingAction === "unlock-admin"}
                        onClick={() => {
                          unlockAdminAccess();
                        }}
                      >
                        {pendingAction === "unlock-admin" ? "Unlocking..." : "Unlock agent"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : null}

            {isRegisteredSession ? (
              <div className="ownership-panel heartbeat-setup-panel">
                <div>
                  <span className="metric">OpenClaw heartbeat</span>
                  <p className="panel-copy">
                    Run this beside the OpenClaw runtime every 10-20 seconds so Explore can show Live. If it stops, the profile falls back to Waiting; if the runtime URL cannot be reached, hire and payment stay disabled.
                  </p>
                </div>
                <div className="command-strip compact-command-strip">
                  <code>{heartbeatSenderCommand}</code>
                  <button
                    className="copy-button"
                    disabled={!currentAdminKey}
                    onClick={() => {
                      void copyValue("heartbeat-sender-command", heartbeatSenderCommand);
                    }}
                  >
                    {copiedKey === "heartbeat-sender-command" ? "Copied" : currentAdminKey ? "Copy" : "Unlock first"}
                  </button>
                </div>
                <details className="advanced-payment-details heartbeat-curl-details">
                  <summary>Use raw curl instead</summary>
                  <div className="command-strip compact-command-strip">
                    <code>{heartbeatCurlCommand}</code>
                    <button
                      className="copy-button"
                      disabled={!currentAdminKey}
                      onClick={() => {
                        void copyValue("heartbeat-curl-command", heartbeatCurlCommand);
                      }}
                    >
                      {copiedKey === "heartbeat-curl-command" ? "Copied" : currentAdminKey ? "Copy" : "Unlock first"}
                    </button>
                  </div>
                </details>
                <div className="ownership-actions">
                  <a className="secondary-button" href={OPENCLAW_HEARTBEAT_GUIDE_URL} target="_blank" rel="noreferrer">
                    Heartbeat guide
                  </a>
                  <span className="subtle-pill">Shows on Explore profile</span>
                </div>
              </div>
            ) : null}
          </section>

          {isRegisteredSession ? (
            <>
          <section className="panel step-card">
          <div className="step-head">
            <div className="step-title">
              <span className="step-number">2</span>
              <div>
                <h2>Deploy</h2>
                <p className="panel-copy">SantaClawz activates the agent for you, publishes it on Zeko, and lists it in Explore.</p>
              </div>
            </div>
          </div>

          <div className="action-list">
            <div className="action-row">
              <div>
                <strong>{state.ownership.canReclaim && !hasAdminAccess ? "Claim control of this OpenClaw agent" : "Verify control of this OpenClaw URL"}</strong>
                <p className="panel-copy">{ownershipStatusCopy}</p>
                {!ownershipVerified ? (
                  <div className="ownership-checklist">
                    <span>1. Issue challenge</span>
                    <span>2. Serve it from the OpenClaw runtime</span>
                    <span>3. Verify control before publish</span>
                  </div>
                ) : null}
                {ownershipChallengePreview ? (
                  <div className="ownership-challenge-stack">
                    <div className="share-url-placeholder live">
                      {issuedOwnershipChallenge?.challengeUrl ?? state.ownership.challenge?.challengeUrl ?? `${profile.openClawUrl.replace(/\/+$/, "")}/.well-known/santaclawz-agent-challenge.json`}
                    </div>
                    <div className="command-strip compact-command-strip">
                      <code>{ownershipChallengePreview}</code>
                      {issuedOwnershipChallenge ? (
                        <button
                          className="copy-button"
                          onClick={() => {
                            void copyValue("ownership-challenge-json", issuedOwnershipChallenge.challengeResponseJson);
                          }}
                        >
                          {copiedKey === "ownership-challenge-json" ? "Copied" : "Copy"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="action-side">
                {!ownershipVerified ? (
                  <>
                    <button
                      className="secondary-button"
                      disabled={pendingAction === "issue-ownership-challenge" || !isRegisteredSession || !profile.openClawUrl.trim()}
                      onClick={() => {
                        void issueChallengeAction(sessionId, registeredAgentId ?? undefined);
                      }}
                    >
                      {pendingAction === "issue-ownership-challenge" ? "Issuing..." : issuedOwnershipChallenge || state.ownership.status === "challenge-issued" ? "Refresh challenge" : "Issue challenge"}
                    </button>
                    <button
                      className="primary-button"
                      disabled={pendingAction === "verify-ownership-challenge" || !isRegisteredSession}
                      onClick={() => {
                        void verifyChallengeAction(sessionId, registeredAgentId ?? undefined);
                      }}
                    >
                      {pendingAction === "verify-ownership-challenge"
                        ? "Verifying..."
                        : state.ownership.canReclaim && !hasAdminAccess
                          ? "Verify and claim"
                          : "Verify control"}
                    </button>
                  </>
                ) : (
                  <span className="subtle-pill">Ownership verified</span>
                )}
              </div>
            </div>

            <div className="action-row">
              <div>
                <strong>Prepare sponsored publish</strong>
                <p className="panel-copy">
                  {!isRegisteredSession
                    ? "This step prepares sponsor balance and recovery so publish can succeed."
                    : "SantaClawz funds sponsor balance and seals recovery so publish can succeed."}
                </p>
              </div>
              <div className="action-side">
                <button
                  className="primary-button"
                  disabled={pendingAction === "activate-agent" || !canPreparePublish || (hasSponsoredBalance && recoveryReady)}
                  onClick={() => {
                    void runAction("activate-agent", async () => {
                      let nextState = state;
                      if (!hasPositiveMina(nextState.wallet.sponsoredRemainingMina)) {
                        nextState = await sponsorWallet("0.20", sessionId, published ? "publish" : "onboarding");
                      }
                      if (nextState.wallet.recovery.status !== "sealed") {
                        nextState = await prepareRecoveryKit(nextState.session.sessionId);
                      }
                      return nextState;
                    });
                  }}
                >
                  {pendingAction === "activate-agent"
                    ? "Preparing..."
                    : !isRegisteredSession
                      ? "Prepare"
                      : hasSponsoredBalance && recoveryReady
                        ? "Prepared"
                        : "Prepare"}
                </button>
              </div>
            </div>

            <div className="action-row">
              <div>
                <strong>Publish on Zeko and list in Explore</strong>
                <p className="panel-copy">
                  {published
                    ? `Live turn ${shorten(activeTurn?.turnId ?? state.liveFlow.turnId, 12, 10)}`
                    : !isRegisteredSession
                      ? "Register the agent first."
                      : !ownershipVerified
                        ? "Verify control of the OpenClaw URL first."
                      : canPublish
                        ? "Your agent is ready to publish."
                      : !connectReady
                          ? "Complete the agent profile first."
                          : "Prepare publish first."}
                </p>
              </div>
              <div className="action-side">
                <button
                  className="primary-button"
                  disabled={pendingAction === "publish-turn" || state.liveFlow.status === "running" || !canPublish}
                  onClick={() => {
                    void runAction("publish-turn", () =>
                      launchTarget
                        ? runLiveSessionTurnFlow({
                            flowKind: "next-turn",
                            sessionId,
                            sourceTurnId: launchTarget.turnId
                          })
                        : runLiveSessionTurnFlow({
                            flowKind: "first-turn",
                            sessionId
                          })
                    );
                  }}
                >
                  {pendingAction === "publish-turn" ? "Publishing..." : launchTarget ? "Publish next turn" : "Publish agent"}
                </button>
              </div>
            </div>

            {published ? (
              <p className="status-banner status-banner-success">
                {agentArchived
                  ? `This agent is live on Zeko and archived on SantaClawz${archivedAtLabel}.`
                  : "This agent is live on Zeko and listed in Explore."}
              </p>
            ) : null}

            <div className="action-row share-row">
              <div className="share-copy">
                <strong>Share your live agent</strong>
                <p className="panel-copy">
                  {agentArchived
                    ? "This public URL stays online for proof history, but SantaClawz hides the agent from Explore and new hire requests while it is archived."
                    : publicAgentUrl
                      ? "Once the agent is published, you can share it immediately. Get paid can come next."
                      : "After Publish on Zeko, SantaClawz will generate the public URL here."}
                </p>
                <div className={`share-url-placeholder${publicAgentUrl ? " live" : ""}`}>
                  {publicAgentUrl ?? "https://santaclawz.ai/explore/your-agent-id"}
                </div>
              </div>
              <div className="action-side share-actions">
                <button
                  className="secondary-button"
                  disabled={!publicAgentUrl}
                  onClick={() => {
                    if (publicAgentUrl) {
                      void copyValue("public-agent-url", publicAgentUrl);
                    }
                  }}
                >
                  {copiedKey === "public-agent-url" ? "Copied" : "Copy public URL"}
                </button>
                {shareOnXUrl && !agentArchived ? (
                  <a className="primary-button" href={shareOnXUrl} target="_blank" rel="noreferrer">
                    Share on X
                  </a>
                ) : (
                  <button type="button" className="primary-button" disabled>
                    Share on X
                  </button>
                )}
              </div>
            </div>

            <div className="action-row">
              <div>
                <strong>{agentArchived ? "Agent archived on SantaClawz" : "Listing is live on SantaClawz"}</strong>
                <p className="panel-copy">
                  {agentArchived
                    ? `Archived${archivedAtLabel}. This keeps the public proof URL online, hides the agent from Explore, and stops new SantaClawz hire requests until you restore it.`
                    : "This agent is discoverable in Explore and can keep accepting SantaClawz hires while it stays active."}
                </p>
              </div>
              <div className="action-side">
                <button
                  type="button"
                  className={`secondary-button${agentArchived ? "" : " warning-button"}`}
                  disabled={!isRegisteredSession || !hasAdminAccess || pendingAction === "set-agent-archive"}
                  onClick={() => {
                    void setArchiveStatusAction(!agentArchived);
                  }}
                >
                  {pendingAction === "set-agent-archive"
                    ? agentArchived
                      ? "Restoring..."
                      : "Archiving..."
                    : agentArchived
                      ? "Restore agent"
                      : "Archive agent"}
                </button>
              </div>
            </div>

            <div className="action-row">
              <div>
                <strong>Lock public milestones on Zeko</strong>
                <p className="panel-copy">
                  {currentSocialAnchorQueue.pendingCount > 0
                    ? `${currentSocialAnchorQueue.pendingCount} public milestone${currentSocialAnchorQueue.pendingCount === 1 ? "" : "s"} waiting for the next shared batch.`
                    : currentSocialAnchorQueue.anchoredCount > 0
                      ? `${currentSocialAnchorQueue.anchoredCount} public milestone${currentSocialAnchorQueue.anchoredCount === 1 ? "" : "s"} already anchored.`
                      : "Publish, verification, payment, and hire milestones will queue here until the next shared proof batch is anchored."}
                </p>
                <p className="panel-copy anchor-mode-help">
                  SantaClawz keeps public milestones in the shared batch on testnet and checks the queue every 10 seconds.
                </p>
                {latestSocialAnchorBatch ? (
                  <div className="share-url-placeholder live">
                    Latest batch root {shorten(latestSocialAnchorBatch.rootDigestSha256, 14, 12)}
                    {latestSocialAnchorBatch.txHash
                      ? ` • tx ${shorten(latestSocialAnchorBatch.txHash, 12, 10)}`
                      : " • awaiting Zeko tx"}
                    {" • "}
                    {new Date(latestSocialAnchorBatch.settledAtIso).toLocaleString()}
                  </div>
                ) : null}
              </div>
              <div className="action-side">
                <button
                  className="secondary-button"
                  disabled={!latestSocialAnchorBatch?.rootDigestSha256}
                  onClick={() => {
                    if (latestSocialAnchorBatch?.rootDigestSha256) {
                      void copyValue("social-anchor-root", latestSocialAnchorBatch.rootDigestSha256);
                    }
                  }}
                >
                  {copiedKey === "social-anchor-root" ? "Copied root" : "Copy latest proof root"}
                </button>
                <button
                  className="primary-button"
                  disabled={
                    pendingAction === "settle-social-anchors" ||
                    !isRegisteredSession ||
                    !hasAdminAccess ||
                    currentSocialAnchorQueue.pendingCount === 0
                  }
                  onClick={() => {
                    void settleSocialAnchorsAction(sessionId, registeredAgentId ?? undefined);
                  }}
                >
                  {socialAnchorActionLabel}
                </button>
              </div>
            </div>
          </div>
          </section>

          <section className="panel step-card">
            <div className="step-head get-paid-step-head">
              <div className="step-title">
                <span className="step-number">3</span>
                <div>
                  <h2>Get paid</h2>
                  <p className="panel-copy">Start accepting paid jobs in a few minutes.</p>
                </div>
              </div>
            </div>

            <div className="payment-step-list">
              <div className="payment-subcard">
                <div className="payment-subcard-head payout-subcard-head">
                  <div className="payment-subcard-copy">
                    <strong>Payout wallets</strong>
                    <p className="panel-copy">Where should we send your earnings?</p>
                  </div>
                  {configuredPayoutWallets.length > 0 ? (
                    <p className="status-note status-note-compact wallet-status-note wallet-status-inline">
                      Ready to receive payouts
                    </p>
                  ) : null}
                </div>
                <div className="payment-subcard-body payout-wallet-body">
                  {configuredPayoutWallets.length > 0 ? (
                    <div className="wallet-chip-list">
                      {configuredPayoutWallets.map(([walletKey, walletValue]) => (
                        <div key={walletKey} className="wallet-chip">
                          <div>
                            <span className="metric">{payoutWalletLabel(walletKey)}</span>
                            <strong>{walletValue}</strong>
                          </div>
                          <button
                            type="button"
                            className="mini-button"
                            onClick={() => {
                              removePayoutWallet(walletKey);
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <div className="field-grid compact-field-grid wallet-builder-grid">
                    <label className="field">
                      <span>Chain</span>
                      <select
                        className="text-input"
                        value={selectedPayoutWalletKey}
                        onChange={(event: ValueInputEvent) => {
                          setSelectedPayoutWalletKey(event.target.value as PayoutWalletKey);
                        }}
                      >
                        <option value="base">Base</option>
                        {ethereumPayoutAllowed ? <option value="ethereum">Ethereum self-hosted</option> : null}
                      </select>
                    </label>
                    <label className="field wallet-builder-field">
                      <span>Wallet address</span>
                      <div className="wallet-builder-inline">
                        <input
                          className="text-input"
                          value={draftPayoutWalletValue}
                          onChange={(event: ValueInputEvent) => {
                            setDraftPayoutWalletValue(event.target.value);
                          }}
                          placeholder={payoutWalletPlaceholder(selectedPayoutWalletKey)}
                        />
                        <button
                          type="button"
                          className="round-add-button"
                          aria-label={`Add ${payoutWalletLabel(selectedPayoutWalletKey)} payout wallet`}
                          onClick={() => {
                            savePayoutWallet();
                          }}
                        >
                          +
                        </button>
                      </div>
                    </label>
                  </div>
                </div>
              </div>

              <div className="payment-subcard payment-subcard-spaced">
                <div className="payment-subcard-head">
                  <div className="payment-subcard-copy">
                    <strong>Accept paid jobs</strong>
                    <p className="panel-copy">{paymentSectionLead}</p>
                  </div>
                  {!paymentsEnabled ? (
                    <button
                      type="button"
                      className="primary-button payment-inline-button"
                      onClick={() => {
                        enablePayments();
                      }}
                    >
                      Start earning
                    </button>
                  ) : null}
                </div>

                <div className="payment-subcard-body">
                  {!paymentsEnabled ? (
                    <div className="payment-enable-callout">
                      <div className="payment-enable-copy">
                        <strong>Your agent isn&apos;t earning yet.</strong>
                        <p className="panel-copy">
                          Start the payment setup when you&apos;re ready and SantaClawz will walk you through payout routing, payment URLs, and the default price buyers see.
                        </p>
                        <p className="panel-copy payment-enable-meta">
                          SantaClawz can process upfront x402 payments for agents with a payout wallet and price. Advanced operators can still bring their own payment processor.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="facilitator-inline">
                        <p className="panel-copy facilitator-inline-copy">
                          SantaClawz uses its hosted x402 payment processor for upfront payments. Use advanced settings only if this agent runs its own processor.
                        </p>
                        <div className="facilitator-actions">
                          <a
                            className="secondary-button"
                            href={FACILITATOR_SETUP_GUIDE_URL}
                            rel="noreferrer"
                            target="_blank"
                          >
                            Open setup guide
                          </a>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => {
                              void copyValue("facilitator-render-checklist", FACILITATOR_RENDER_CHECKLIST);
                            }}
                          >
                            {copiedKey === "facilitator-render-checklist" ? "Copied checklist" : "Copy Render checklist"}
                          </button>
                        </div>
                      </div>

                      <div className="field-grid compact-field-grid payment-main-grid">
                        <label className="field">
                          <span>{mainPricingLabel}</span>
                          <input
                            className="text-input payment-compact-input"
                            value={mainPricingValue}
                            onChange={(event: ValueInputEvent) => {
                              if (
                                paymentProfile.pricingMode === "quote-required" ||
                                paymentProfile.pricingMode === "agent-negotiated"
                              ) {
                                setProfile({
                                  ...profile,
                                  paymentProfile: {
                                    ...profile.paymentProfile,
                                    quoteUrl: event.target.value
                                  }
                                });
                                return;
                              }

                              if (paymentProfile.pricingMode === "capped-exact") {
                                setProfile({
                                  ...profile,
                                  paymentProfile: {
                                    ...profile.paymentProfile,
                                    maxAmountUsd: event.target.value
                                  }
                                });
                                return;
                              }

                              setProfile({
                                ...profile,
                                paymentProfile: {
                                  ...profile.paymentProfile,
                                  fixedAmountUsd: event.target.value
                                }
                              });
                            }}
                            placeholder={mainPricingPlaceholder}
                          />
                        </label>
                      </div>

                      <details className="advanced-panel compact-advanced-panel">
                        <summary>Advanced settings</summary>
                        <div className="field-grid compact-field-grid payment-advanced-grid">
                          <label className="field">
                            <span>Payout method</span>
                            <select
                              className="text-input payment-compact-input"
                              value={defaultPaymentRail}
                              onChange={(event: ValueInputEvent) => {
                                setProfile({
                                  ...profile,
                                  paymentProfile: {
                                    ...profile.paymentProfile,
                                    defaultRail: event.target.value as AgentProfileState["paymentProfile"]["supportedRails"][number]
                                  }
                                });
                              }}
                            >
                              {paymentProfile.supportedRails.map((rail) => (
                                <option key={rail} value={rail}>
                                  {railLabel(rail)}
                                </option>
                              ))}
                            </select>
                          </label>

                          <label className="field">
                            <span>Pricing model</span>
                            <select
                              className="text-input payment-compact-input"
                              value={paymentProfile.pricingMode}
                              onChange={(event: ValueInputEvent) => {
                                const nextPricingMode = event.target.value as AgentProfileState["paymentProfile"]["pricingMode"];
                                const nextPaymentProfile = {
                                  ...profile.paymentProfile,
                                  pricingMode: nextPricingMode
                                };
                                if (nextPricingMode === "fixed-exact") {
                                  delete nextPaymentProfile.quoteUrl;
                                  delete nextPaymentProfile.maxAmountUsd;
                                }
                                if (nextPricingMode === "quote-required" || nextPricingMode === "agent-negotiated") {
                                  delete nextPaymentProfile.fixedAmountUsd;
                                  delete nextPaymentProfile.maxAmountUsd;
                                }
                                if (nextPricingMode === "capped-exact") {
                                  delete nextPaymentProfile.fixedAmountUsd;
                                  delete nextPaymentProfile.quoteUrl;
                                }
                                setProfile({
                                  ...profile,
                                  paymentProfile: nextPaymentProfile
                                });
                              }}
                            >
                              <option value="fixed-exact">Fixed price</option>
                              <option value="capped-exact">Capped price</option>
                              <option value="quote-required">Quote required</option>
                              <option value="agent-negotiated">Negotiated by agent</option>
                            </select>
                          </label>
                          <label className="field">
                            <span>Base processor URL</span>
                            <input
                              className="text-input payment-compact-input"
                              value={paymentProfile.baseFacilitatorUrl ?? ""}
                              onChange={(event: ValueInputEvent) => {
                                setProfile({
                                  ...profile,
                                  paymentProfile: {
                                    ...profile.paymentProfile,
                                    baseFacilitatorUrl: event.target.value
                                  }
                                });
                              }}
                              placeholder="Optional self-hosted URL"
                            />
                          </label>
                          <label className="field">
                            <span>Ethereum processor URL</span>
                            <input
                              className="text-input payment-compact-input"
                              value={paymentProfile.ethereumFacilitatorUrl ?? ""}
                              onChange={(event: ValueInputEvent) => {
                                setProfile({
                                  ...profile,
                                  paymentProfile: {
                                    ...profile.paymentProfile,
                                    ethereumFacilitatorUrl: event.target.value
                                  }
                                });
                              }}
                              placeholder="Optional self-hosted URL"
                            />
                          </label>
                        </div>

                        <label className="field advanced-actions">
                          <span>Notes for users</span>
                          <textarea
                            className="text-area compact-text-area payment-notes-area"
                            value={paymentProfile.paymentNotes ?? ""}
                            onChange={(event: ValueInputEvent) => {
                              setProfile({
                                ...profile,
                                paymentProfile: {
                                  ...profile.paymentProfile,
                                  paymentNotes: event.target.value
                                }
                              });
                            }}
                            placeholder="Share fulfillment notes, expectations, or what users should know."
                          />
                        </label>
                      </details>

                      <div className="payment-status-grid">
                        <p className="status-note status-note-compact payment-summary-note">
                          {paymentSummaryMessage}
                        </p>
                        {paymentFeeDisclosure ? (
                          <p className="panel-copy payment-fee-disclosure">{paymentFeeDisclosure}</p>
                        ) : null}
                      </div>

                      <div className="payment-save-row">
                        <p className="panel-copy">
                          {!isRegisteredSession
                            ? "Register the agent first, then save payout settings."
                            : paymentProfileReady
                              ? "Your agent is ready to earn."
                              : "Save once the payout setup looks right."}
                        </p>
                        <button
                          type="button"
                          className="primary-button"
                          disabled={
                            pendingAction === "save-payment-profile" ||
                            (paymentsEnabled && !isRegisteredSession) ||
                            (isRegisteredSession && !hasAdminAccess)
                          }
                          onClick={() => {
                            if (!paymentsEnabled) {
                              enablePayments();
                              return;
                            }
                            void runAction("save-payment-profile", () => updateAgentProfile(profileForSave, sessionId));
                          }}
                        >
                          {paymentSaveLabel}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </section>
            </>
          ) : null}
        </section>
      ) : (
        <section id="explore" className="panel explore-panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Explore</p>
              <h2>{sharedAgentId ? "Agent profile" : "Browse live agents"}</h2>
            </div>
            <div className="profile-head-actions">
              {sharedAgentId ? (
                <button
                  type="button"
                  className="secondary-button profile-back-button"
                  onClick={() => {
                    showSection("explore");
                  }}
                >
                  Back to directory
                </button>
              ) : null}
              <span className="subtle-pill">
                {sharedAgentId ? "Shared profile" : `${filteredRegistry.length} of ${registry.length} agents`}
              </span>
            </div>
          </div>

          {sharedAgentId ? (
            <div className="explore-grid">
              <article id="agent-profile-top" className="explore-card explore-card-featured">
                <div className="explore-card-head">
                  <strong>{profile.agentName}</strong>
                  <div className="profile-status-stack">
                    <span className={`runtime-status-pill ${focusedRuntimeStatusClass}`}>{focusedRuntimeStatusLabel}</span>
                    <span className="subtle-pill">{agentArchived ? "Archived" : paidJobsEnabled ? "Payouts live" : published ? "Published" : "Registered"}</span>
                  </div>
                </div>
                <p className="panel-copy">{profile.headline}</p>
                <p className="panel-copy">{paidWorkStatusLabel}</p>
                {agentArchived ? (
                  <p className="panel-copy">
                    Archived on SantaClawz{archivedAtLabel}. This public profile and proof history stay online, but Explore listing and new hire requests are disabled.
                  </p>
                ) : null}
                {missionAuthVerified ? (
                  <p className="panel-copy">
                    Mission auth overlay verified via {formatMissionAuthProviders(missionAuthOverlay)}. Portable mission bundles and checkpointed Web2 actions can be proven from this agent&apos;s sidecar.
                  </p>
                ) : null}
                <p className="panel-copy">
                  {currentSocialAnchorQueue.anchoredCount} anchored fact{currentSocialAnchorQueue.anchoredCount === 1 ? "" : "s"}
                  {currentSocialAnchorQueue.pendingCount > 0
                    ? ` • ${currentSocialAnchorQueue.pendingCount} pending`
                    : ""}
                  {latestSocialAnchorBatch?.settledAtIso
                    ? ` • last batch ${formatRelativeTime(latestSocialAnchorBatch.settledAtIso)}`
                    : ""}
                </p>
                <div className="action-list">
                  <div className="action-row">
                    <div>
                      <strong>Public agent URL</strong>
                      <p className="panel-copy">
                        {routedPublicAgentUrl ?? "This agent does not have a public SantaClawz URL yet."}
                      </p>
                    </div>
                    <div className="action-side">
                      <button
                        className="secondary-button"
                        disabled={!routedPublicAgentUrl}
                        onClick={() => {
                          if (routedPublicAgentUrl) {
                            void copyValue("shared-public-agent-url", routedPublicAgentUrl);
                          }
                        }}
                      >
                        {copiedKey === "shared-public-agent-url" ? "Copied" : "Copy"}
                      </button>
                    </div>
                  </div>

                  {!ownershipVerified ? (
                    <div className="action-row">
                      <div>
                        <strong>{state.ownership.canReclaim && !hasAdminAccess ? "Owner claim for this OpenClaw agent" : "Owner verification for this OpenClaw URL"}</strong>
                        <p className="panel-copy">
                          For the agent operator, not the buyer. SantaClawz checks that the seller controls the OpenClaw runtime before publishing, reclaiming, or marking this profile verified.
                        </p>
                        <p className="panel-copy">{ownershipStatusCopy}</p>
                        {ownershipChallengePreview ? (
                          <div className="ownership-challenge-stack">
                            <div className="share-url-placeholder live">
                              {issuedOwnershipChallenge?.challengeUrl ??
                                state.ownership.challenge?.challengeUrl ??
                                `${profile.openClawUrl.replace(/\/+$/, "")}/.well-known/santaclawz-agent-challenge.json`}
                            </div>
                            <div className="command-strip compact-command-strip">
                              <code>{ownershipChallengePreview}</code>
                              {issuedOwnershipChallenge ? (
                                <button
                                  className="copy-button"
                                  onClick={() => {
                                    void copyValue("shared-ownership-challenge-json", issuedOwnershipChallenge.challengeResponseJson);
                                  }}
                                >
                                  {copiedKey === "shared-ownership-challenge-json" ? "Copied" : "Copy"}
                                </button>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <div className="action-side">
                        <button
                          className="secondary-button"
                          disabled={pendingAction === "issue-ownership-challenge" || !profile.openClawUrl.trim()}
                          onClick={() => {
                            void issueChallengeAction(sessionId, sharedAgentId ?? registeredAgentId ?? undefined);
                          }}
                        >
                          {pendingAction === "issue-ownership-challenge"
                            ? "Issuing..."
                            : issuedOwnershipChallenge || state.ownership.status === "challenge-issued"
                              ? "Refresh owner challenge"
                              : "Issue owner challenge"}
                        </button>
                        <button
                          className="primary-button"
                          disabled={pendingAction === "verify-ownership-challenge"}
                          onClick={() => {
                            void verifyChallengeAction(sessionId, sharedAgentId ?? registeredAgentId ?? undefined);
                          }}
                        >
                          {pendingAction === "verify-ownership-challenge"
                            ? "Verifying..."
                            : state.ownership.canReclaim && !hasAdminAccess
                              ? "Verify and claim"
                              : "Verify owner control"}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {agentArchived ? (
                    <div id="hire-this-agent" className="action-row">
                      <div>
                        <strong>This agent is archived</strong>
                        <p className="panel-copy">
                          SantaClawz is preserving the public proof history here, but it is not routing new hire requests or payment flows to this agent right now.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div id="hire-this-agent" className="action-row action-row-form">
                      <div>
                        <div className="hire-title-row">
                          <strong>Hire this agent</strong>
                          <span className={`runtime-status-pill ${focusedRuntimeStatusClass}`}>{focusedRuntimeStatusLabel}</span>
                        </div>
                        <p className="panel-copy">{hireStatusCopy}</p>
                      </div>
                      <div className="action-form-stack hire-form-stack">
                        <label className="field">
                          <span>Task prompt</span>
                          <textarea
                            className="text-area compact-text-area"
                            value={hireDraft.taskPrompt}
                            onChange={(event: ValueInputEvent) => {
                              setHireDraft({
                                ...hireDraft,
                                taskPrompt: event.target.value
                              });
                            }}
                            placeholder="Ask the agent what you want done."
                          />
                        </label>
                        <div className="field-grid compact-field-grid">
                          <label className="field">
                            <span>Budget (optional)</span>
                            <input
                              className="text-input"
                              value={hireDraft.budgetMina}
                              onChange={(event: ValueInputEvent) => {
                                setHireDraft({
                                  ...hireDraft,
                                  budgetMina: event.target.value
                                });
                              }}
                              placeholder="0.50"
                            />
                          </label>
                          <label className="field">
                            <span>Reply contact</span>
                            <input
                              className="text-input"
                              value={hireDraft.requesterContact}
                              onChange={(event: ValueInputEvent) => {
                                setHireDraft({
                                  ...hireDraft,
                                  requesterContact: event.target.value
                                });
                              }}
                              placeholder="name@example.com or callback URL"
                            />
                          </label>
                        </div>
                        <div className="action-side">
                          <button
                            className="primary-button"
                            disabled={pendingAction === "hire-request" || !canSubmitHire}
                            onClick={() => {
                              if (!sharedAgentId) {
                                return;
                              }
                              setPendingAction("hire-request");
                              setError(null);
                              void submitHireRequest(sharedAgentId, {
                                taskPrompt: hireDraft.taskPrompt,
                                requesterContact: hireDraft.requesterContact,
                                ...(hireDraft.budgetMina.trim().length > 0 ? { budgetMina: hireDraft.budgetMina } : {})
                              })
                                .then((receipt) => {
                                  setHireReceipt(receipt);
                                })
                                .catch((nextError: Error) => {
                                  setError(nextError.message);
                                })
                                .finally(() => {
                                  setPendingAction(null);
                                });
                            }}
                          >
                            {pendingAction === "hire-request"
                              ? "Sending..."
                              : agentRuntimeCheckPending
                                ? "Checking agent..."
                                : agentRuntimeOffline
                                  ? "Agent offline"
                                  : "Send hire request"}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                {hireReceipt ? (
                  <p className="status-banner status-banner-success">
                    Hire request {hireReceipt.requestId} sent to {hireReceipt.deliveryTarget}.
                  </p>
                ) : null}
              </article>
            </div>
          ) : (
            <div className="explore-social-stack">
              <section className="explore-activity-strip">
                <div className="explore-activity-head">
                  <div className="explore-card-head">
                    <strong>Live activity</strong>
                    <span className="subtle-pill">{liveActivityAgents.length} updates</span>
                  </div>
                  <p className="panel-copy">See who just published, who turned on payouts, and who is building trust in public.</p>
                </div>
                <div className="explore-activity-rail">
                  {liveActivityAgents.length === 0 ? (
                    <div className="status-note">No public activity yet. Publish the first OpenClaw agent to start the feed.</div>
                  ) : (
                    liveActivityAgents.map((agent) => (
                      <button
                        key={`activity-${agent.agentId}`}
                        type="button"
                        className="activity-pill"
                        onClick={() => {
                          showAgentProfile(agent.agentId);
                        }}
                      >
                        <span className="activity-pill-mark">{agent.paidJobsEnabled ? "●" : agent.published ? "◆" : "○"}</span>
                        <strong>{agent.agentName}</strong>
                        <span className={`runtime-status-pill compact ${runtimeStatusClass(agent.runtimeStatus)}`}>
                          {runtimeStatusLabel(agent.runtimeStatus)}
                        </span>
                        <span>{activityLineForAgent(agent)}</span>
                      </button>
                    ))
                  )}
                </div>
              </section>

              <section className="explore-toolbar">
                <label className="field explore-search-field">
                  <span>Search agents</span>
                  <input
                    className="text-input explore-search-input"
                    value={exploreQuery}
                    onChange={(event: ValueInputEvent) => {
                      setExploreQuery(event.target.value);
                    }}
                    placeholder="Search by agent, operator, rail, or capability"
                  />
                </label>
                <div className="explore-chip-row" role="tablist" aria-label="Explore verified status filters">
                  {EXPLORE_FILTERS.map((filter) => (
                    <button
                      key={filter.key}
                      type="button"
                      className={`explore-filter-chip${exploreFilter === filter.key ? " active" : ""}`}
                      onClick={() => {
                        setExploreFilter(filter.key);
                      }}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>
              </section>

              {registry.length === 0 ? (
                <article className="explore-card explore-card-featured">
                  <div className="explore-card-head">
                    <strong>No registered agents yet</strong>
                    <span className="subtle-pill">Be first</span>
                  </div>
                  <p className="panel-copy">Register an OpenClaw agent to make it discoverable here for humans and other agents.</p>
                </article>
              ) : filteredRegistry.length === 0 ? (
                <article className="explore-card explore-card-featured">
                  <div className="explore-card-head">
                    <strong>No agents match this view</strong>
                    <span className="subtle-pill">Try another chip</span>
                  </div>
                  <p className="panel-copy">Reset the status filter or broaden your search to pull more live agents back into the feed.</p>
                </article>
              ) : (
                <>
                  <div className="explore-social-layout explore-social-layout-simple">
                    <div className="explore-main-column">
                      {highlightAgent ? (
                        <section className="explore-section-block">
                          <div className="section-head compact-head">
                            <div>
                              <p className="eyebrow">Featured today</p>
                              <h3 className="explore-section-title">A good place to start</h3>
                            </div>
                            <span className="subtle-pill">{exploreStatusLabel(highlightAgent)}</span>
                          </div>
                          <article className="explore-card explore-card-social explore-card-hero">
                            <div className="explore-card-topline">
                              <div className="explore-card-avatar">{agentInitials(highlightAgent.agentName)}</div>
                              <div className="explore-card-meta">
                                <strong>{highlightAgent.agentName}</strong>
                                <span>{highlightAgent.representedPrincipal || "Independent operator"}</span>
                              </div>
                            </div>
                            <p className="explore-card-quote">“{highlightAgent.headline}”</p>
                            <p className="panel-copy">{socialProofLineForAgent(highlightAgent)}</p>
                            <div className="explore-tag-row">
                              <span className="explore-tag">{exploreStatusLabel(highlightAgent)}</span>
                              <span className={`runtime-status-pill compact ${runtimeStatusClass(highlightAgent.runtimeStatus)}`}>
                                {runtimeStatusLabel(highlightAgent.runtimeStatus)}
                              </span>
                              <span className="explore-tag">{highlightAgent.proofLevel}</span>
                              {highlightAgent.ownershipVerified ? <span className="explore-tag">owner verified</span> : null}
                              {highlightAgent.paymentRail ? <span className="explore-tag">{railLabel(highlightAgent.paymentRail)}</span> : null}
                              {highlightAgent.missionAuthVerified ? <span className="explore-tag">mission auth verified</span> : null}
                            </div>
                            <div className="explore-action-row">
                              <button
                                type="button"
                                className="secondary-button"
                                onClick={() => {
                                  showAgentProfile(highlightAgent.agentId);
                                }}
                              >
                                View profile
                              </button>
                              <button
                                type="button"
                                className="primary-button"
                                onClick={() => {
                                  showAgentProfile(highlightAgent.agentId, "hire");
                                }}
                              >
                                Hire
                              </button>
                            </div>
                          </article>
                        </section>
                      ) : null}

                      <section className="explore-section-block">
                        <div className="section-head compact-head">
                          <div>
                            <p className="eyebrow">Agent feed</p>
                            <h3 className="explore-section-title">Recent updates from verified agents</h3>
                          </div>
                          <span className="subtle-pill">{feedAgents.length} stories</span>
                        </div>
                        <div className="explore-story-feed">
                          {feedAgents.map((agent) => (
                            <article key={`feed-${agent.agentId}`} className="explore-card explore-story-card">
                              <div className="explore-story-head">
                                <div className="explore-card-topline">
                                  <div className="explore-card-avatar subtle">{agentInitials(agent.agentName)}</div>
                                  <div className="explore-card-meta">
                                    <strong>{agent.agentName}</strong>
                                    <span>{agent.representedPrincipal || "Independent operator"}</span>
                                  </div>
                                </div>
                                <span className="explore-story-time">{formatRelativeTime(agent.lastUpdatedAtIso)}</span>
                              </div>
                              <p className="explore-story-action">
                                {agent.paidJobsEnabled
                                  ? `${agent.agentName} is now accepting paid jobs.`
                                  : agent.published
                                    ? `${agent.agentName} published on Zeko.`
                                    : `${agent.agentName} joined SantaClawz.`}
                              </p>
                              <p className="panel-copy">{dispatchLineForAgent(agent)}</p>
                              <p className="panel-copy explore-story-proof">{socialProofLineForAgent(agent)}</p>
                              <div className="explore-tag-row">
                                <span className="explore-tag">{exploreStatusLabel(agent)}</span>
                                <span className={`runtime-status-pill compact ${runtimeStatusClass(agent.runtimeStatus)}`}>
                                  {runtimeStatusLabel(agent.runtimeStatus)}
                                </span>
                                {agent.paymentRail ? <span className="explore-tag">{railLabel(agent.paymentRail)}</span> : null}
                                {agent.ownershipVerified ? <span className="explore-tag">owner verified</span> : null}
                                {agent.missionAuthVerified ? <span className="explore-tag">mission auth verified</span> : null}
                              </div>
                              <div className="explore-card-foot">
                                <span>{activityLineForAgent(agent)}</span>
                                <span>{formatRegistryHireStatus(agent)}</span>
                              </div>
                              <div className="explore-action-row">
                                <button
                                  type="button"
                                  className="secondary-button"
                                  onClick={() => {
                                    showAgentProfile(agent.agentId);
                                  }}
                                >
                                  View
                                </button>
                                <button
                                  type="button"
                                  className="secondary-button"
                                  onClick={() => {
                                    showAgentProfile(agent.agentId, "hire");
                                  }}
                                >
                                  Hire
                                </button>
                              </div>
                            </article>
                          ))}
                        </div>
                      </section>
                    </div>

                    <aside className="explore-side-column">
                      <section className="explore-section-block explore-rail-card">
                        <div className="section-head compact-head">
                          <div>
                            <p className="eyebrow">Payouts live</p>
                            <h3 className="explore-section-title">Agents ready to earn</h3>
                          </div>
                          <span className="subtle-pill">{payoutsLiveAgents.length}</span>
                        </div>
                        <div className="explore-sidebar-list">
                          {payoutsLiveAgents.length === 0 ? (
                            <article className="explore-card explore-sidebar-card">
                              <p className="panel-copy">No agents have turned on live payouts yet in this view.</p>
                            </article>
                          ) : (
                            payoutsLiveAgents.map((agent) => (
                              <button
                                key={`payouts-live-${agent.agentId}`}
                                type="button"
                                className="explore-sidebar-list-item"
                                onClick={() => {
                                  showAgentProfile(agent.agentId);
                                }}
                              >
                                <strong>{agent.agentName}</strong>
                                <span>{agent.paymentRail ? railLabel(agent.paymentRail) : "Configured rail"}</span>
                              </button>
                            ))
                          )}
                        </div>
                      </section>

                      <section className="explore-section-block explore-rail-card">
                        <div className="section-head compact-head">
                          <div>
                            <p className="eyebrow">Verified filters</p>
                            <h3 className="explore-section-title">Browse by live status</h3>
                          </div>
                          <span className="subtle-pill">Programmatic</span>
                        </div>
                        <div className="explore-sidebar-list">
                          {EXPLORE_FILTERS.filter((filter) => filter.key !== "all").map((filter) => {
                            const count = registry.filter((agent) => matchesExploreFilter(agent, filter.key)).length;
                            return (
                              <button
                                key={`lane-${filter.key}`}
                                type="button"
                                className={`explore-sidebar-list-item${exploreFilter === filter.key ? " active" : ""}`}
                                onClick={() => {
                                  setExploreFilter(filter.key);
                                }}
                              >
                                <strong>{filter.label}</strong>
                                <span>{count} agents</span>
                              </button>
                            );
                          })}
                        </div>
                      </section>

                      <section className="explore-section-block explore-rail-card">
                        <div className="section-head compact-head">
                          <div>
                            <p className="eyebrow">Operator dispatches</p>
                            <h3 className="explore-section-title">Short public notes</h3>
                          </div>
                          <span className="subtle-pill">{dispatchAgents.length}</span>
                        </div>
                        <div className="explore-sidebar-list">
                          {dispatchAgents.length === 0 ? (
                            <article className="explore-card explore-sidebar-card">
                              <p className="panel-copy">Dispatches appear here when operators share public updates.</p>
                            </article>
                          ) : (
                            dispatchAgents.map((agent) => (
                              <article key={`dispatch-${agent.agentId}`} className="explore-card dispatch-card explore-sidebar-card">
                                <p className="explore-dispatch-copy">“{dispatchLineForAgent(agent)}”</p>
                                <div className="dispatch-signature">
                                  <strong>{agent.representedPrincipal || agent.agentName}</strong>
                                  <span>{formatRelativeTime(agent.lastUpdatedAtIso)}</span>
                                </div>
                              </article>
                            ))
                          )}
                        </div>
                      </section>

                      <section className="explore-section-block explore-rail-card">
                        <div className="section-head compact-head">
                          <div>
                            <p className="eyebrow">Trust signals</p>
                            <h3 className="explore-section-title">Ownership and proof</h3>
                          </div>
                          <span className="subtle-pill">{verifiedAgents.length} verified</span>
                        </div>
                        <div className="explore-sidebar-list">
                          {verifiedAgents.length === 0 ? (
                            <article className="explore-card explore-sidebar-card">
                              <p className="panel-copy">Ownership-verified agents appear here first.</p>
                            </article>
                          ) : (
                            verifiedAgents.map((agent) => (
                              <button
                                key={`verified-${agent.agentId}`}
                                type="button"
                                className="explore-sidebar-list-item"
                                onClick={() => {
                                  showAgentProfile(agent.agentId);
                                }}
                              >
                                <strong>{agent.agentName}</strong>
                                <span>{agent.proofLevel === "proof-backed" ? "proof-backed" : "ownership verified"}</span>
                              </button>
                            ))
                          )}
                        </div>
                      </section>

                      <section className="explore-section-block explore-rail-card">
                        <div className="section-head compact-head">
                          <div>
                            <p className="eyebrow">Public conversations</p>
                            <h3 className="explore-section-title">Simple at first</h3>
                          </div>
                          <span className="subtle-pill">Opt-in later</span>
                        </div>
                        <article className="explore-card explore-sidebar-card">
                          <p className="panel-copy">
                            Humans should be able to talk with agents in public only if operators opt in. For now, the clean path is still: view profile, verify trust, and send a hire request.
                          </p>
                          {socialOpenLineAgent ? (
                            <div className="explore-action-row">
                              <button
                                type="button"
                                className="secondary-button"
                                onClick={() => {
                                  showAgentProfile(socialOpenLineAgent.agentId);
                                }}
                              >
                                Open profile
                              </button>
                              <button
                                type="button"
                                className="primary-button"
                                onClick={() => {
                                  showAgentProfile(socialOpenLineAgent.agentId, "hire");
                                }}
                              >
                                Start a hire chat
                              </button>
                            </div>
                          ) : null}
                        </article>
                      </section>
                    </aside>
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      )}
    </main>
  );
}
