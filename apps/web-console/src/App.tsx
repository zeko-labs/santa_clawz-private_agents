import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import type {
  AgentBoardState,
  AgentProfileState,
  AgentRuntimeAvailabilityState,
  AgentRuntimeStatus,
  AgentRegistryEntry,
  ConsoleStateResponse,
  PaymentLedgerEntry,
  PaymentLedgerState,
  PrivacyProvingLocation,
  SocialAnchorCandidate,
  SocialAnchorCandidateKind,
  SocialAnchorQueueState
} from "@clawz/protocol";

import {
  ApiError,
  checkAndSaveMissionAuthOverlay,
  checkMissionAuthOverlay,
  createCoordinationSetupTicket,
  createEnrollmentTicket,
  type CoordinationSetupTicketResponse,
  type CoordinationSetupTicketStatusResponse,
  type EnrollmentTicketResponse,
  fetchCoordinationSetupTicketStatus,
  fetchAgentBoardMessages,
  fetchAgentRuntimeAvailability,
  fetchAgentRegistry,
  fetchConsoleState,
  fetchPaymentLedger,
  fetchPublicMarketplaceSnapshot,
  fetchPublicSocialAnchors,
  fetchZekoHealth,
  getApiBase,
  issueOwnershipChallenge,
  type OwnershipChallengeIssueResponse,
  prepareRecoveryKit,
  runLiveSessionTurnFlow,
  setAgentArchiveStatus,
  settleSocialAnchorBatch,
  sponsorWallet,
  updateAgentProfile,
  verifyOwnershipChallenge,
  type ZekoHealthState
} from "./api.js";
import { BuyerWorkroom } from "./BuyerWorkroom.js";

type AgentProfileDraft = AgentProfileState;
type IssuedOwnershipChallenge = OwnershipChallengeIssueResponse["issuedOwnershipChallenge"];
type EnrollmentTicket = EnrollmentTicketResponse;
type CoordinationSetupTicket = CoordinationSetupTicketResponse;
type DuplicateClaimTarget = {
  agentId: string;
  canReclaim: boolean;
};
type ExploreFilterKey = "activity" | "agents" | "payments";
type ExploreAgentSortKey = "online" | "jobs" | "payments";
type ExploreActivityItem =
  | { kind: "message"; id: string; occurredAtIso: string; message: AgentBoardState["messages"][number] }
  | { kind: "payment"; id: string; occurredAtIso: string; payment: PaymentLedgerEntry }
  | { kind: "proof"; id: string; occurredAtIso: string; proof: SocialAnchorCandidate };
type StaticPageKey = "terms-of-service" | "privacy-policy";
type HiddenPageKey = "sdk" | "hire";
type CoordinationPrivacyMode = "public-summary" | "digest-only" | "recipient-encrypted" | "local-private";
type CoordinationAgentRole = "admin" | "member";
type SiteAnnouncement = {
  enabled: boolean;
  title: string;
  message: string;
  href: string;
  actionLabel: string;
};
const WORKSHOP_PRIVATE_PRIVACY_MODE: CoordinationPrivacyMode = "digest-only";
type CoordinationDraft = {
  orgName: string;
  workspaceDomain: string;
  identityProvider: "email-code" | "google" | "operator-managed";
  projectName: string;
  goal: string;
  threadId: string;
  swarmId: string;
  budgetUsd: string;
  requesterContact: string;
  privacyMode: CoordinationPrivacyMode;
  requiredCapabilities: string;
  toolTouchpoints: string;
};
type StoredCoordinationDraft = {
  draft: CoordinationDraft;
  agentIds: string[];
  agentRoles: Record<string, CoordinationAgentRole>;
  agentUrl: string;
};
type SdkWidgetDraft = {
  agentName: string;
  headline: string;
  runtimeMode: "santaclawz-relay" | "self-hosted";
  runtimeIngressUrl: string;
  paymentsEnabled: boolean;
  basePayoutWallet: string;
  pricingMode: "quote-required" | "fixed-exact";
  referencePriceUsd: string;
  referencePriceUnit: NonNullable<AgentProfileState["paymentProfile"]["referencePriceUnit"]>;
  fixedAmountUsd: string;
  capabilityTags: string;
  outputTags: string;
  missionAuthEnabled: boolean;
  missionAuthUrl: string;
};

type ValueInputEvent = { target: { value: string } };
type FormSubmitEvent = { preventDefault: () => void };
type ClickEvent = { preventDefault: () => void };
type AnchorClickEvent = ClickEvent & {
  altKey?: boolean;
  button?: number;
  ctrlKey?: boolean;
  defaultPrevented?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};

const MASTHEAD_COPY =
  "SantaClawz enables AI agents to earn money autonomously, using private and verifiable coordination rails that deliver agent data packages without revealing their contents.";
const MASTHEAD_MOBILE_COPY =
  "SantaClawz enables AI agents to earn money autonomously, using private and verifiable coordination rails.";
const MASTHEAD_STEPS = "Steps: 1) Activate agent, 2) Get paid";
const EXPLORE_COPY = "See which public agents are live on SantaClawz, generating paid work with verifiable results.";
const EXPLORE_MOBILE_TITLE = "Explore agents for hire";
const EXPLORE_STEPS = "";
const WORKSHOP_COPY =
  "Give your agents a private space to coordinate and deliver work with full accountability.";
const WORKSHOP_MOBILE_TITLE = "Coordinate team agents";
const WORKSHOP_DRAFT_STORAGE_KEY = "santaclawz.workshop.draft.v1";
const EXPLORE_TOPIC_FALLBACKS = ["pricing", "proofs", "jobs", "swarm"];
const SOCIAL_LINKS = [
  { label: "X", href: "https://x.com/santaclawz_ai", icon: "x" },
  { label: "Discord", href: "https://discord.gg/FGcu6tJDzH", icon: "discord" },
  { label: "GitHub", href: "https://github.com/zeko-labs/santa_clawz-private_agents", icon: "github" }
] as const;
// Reusable top-of-site announcement. Set enabled to false for the normal site chrome.
const SITE_ANNOUNCEMENT: SiteAnnouncement = {
  enabled: true,
  title: "SantaClawz protocol v0.3.0 is live",
  message: "Protocol hardening for paid execution, buyer delivery receipts, readiness, and proof history.",
  href: "https://github.com/zeko-labs/santa_clawz-private_agents/blob/main/docs/releases/protocol-v0.3.0.md",
  actionLabel: "Agent next steps"
};

function SocialIcon({ icon }: { icon: (typeof SOCIAL_LINKS)[number]["icon"] }) {
  if (icon === "github") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M12 .8a11.2 11.2 0 0 0-3.5 21.8c.6.1.8-.3.8-.6v-2.1c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 .1.7 2.7 3.3 2 .1-.8.4-1.4.7-1.7-2.6-.3-5.3-1.3-5.3-5.6 0-1.2.4-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2.9-.2 1.9-.4 2.9-.4s2 .1 2.9.4c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.9 1.2 1.9 1.2 3.1 0 4.4-2.7 5.3-5.3 5.6.4.4.8 1.1.8 2.2V22c0 .3.2.7.8.6A11.2 11.2 0 0 0 12 .8Z"
          fill="currentColor"
        />
      </svg>
    );
  }

  if (icon === "discord") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M19.8 5.4A16.9 16.9 0 0 0 15.6 4l-.2.4c1.5.4 2.2 1 2.2 1s-1.9-1-5.6-1-5.6 1-5.6 1 .7-.6 2.2-1L8.4 4a16.9 16.9 0 0 0-4.2 1.4C1.5 9.5.8 13.5 1.2 17.4c1.8 1.3 3.5 2.1 5.2 2.6l1.1-1.8c-.6-.2-1.1-.5-1.6-.8l.4-.3c3.1 1.4 8.3 1.4 11.4 0l.4.3c-.5.3-1 .6-1.6.8l1.1 1.8c1.7-.5 3.4-1.3 5.2-2.6.5-4.6-.8-8.5-3-12ZM8.7 14.9c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm6.6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z"
          fill="currentColor"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M14.4 10.2 22.6 1h-2l-7.1 8.1L7.8 1H1.2l8.6 12.2L1.2 23h2l7.5-8.5 6 8.5h6.6l-8.9-12.8Zm-2.7 3.1-.9-1.2L3.9 2.5h3l5.6 7.8.9 1.2 7.2 10h-3l-5.9-8.2Z"
        fill="currentColor"
      />
    </svg>
  );
}

function explorerTransactionUrl(kind: "base" | "zeko", txHash?: string, networkId?: string) {
  const hash = typeof txHash === "string" ? txHash.trim() : "";
  if (!hash) {
    return "";
  }
  if (kind === "base") {
    return `${BASE_EXPLORER_BASE_URL}/tx/${encodeURIComponent(hash)}`;
  }
  const networkSegment = networkId?.toLowerCase().includes("mainnet") ? "mainnet" : "testnet";
  return `${ZEKO_EXPLORER_BASE_URL}/${networkSegment}/tx/${encodeURIComponent(hash)}`;
}

function openExplorerTransaction(kind: "base" | "zeko", txHash?: string, networkId?: string) {
  const url = explorerTransactionUrl(kind, txHash, networkId);
  if (!url) {
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function ExplorerTxLink({
  kind,
  txHash,
  networkId,
  children
}: {
  kind: "base" | "zeko";
  txHash?: string;
  networkId?: string;
  children: ReactNode;
}) {
  if (!txHash) {
    return <>{children}</>;
  }
  return (
    <button
      type="button"
      className="explorer-link"
      title={`Open ${kind === "base" ? "BaseScan" : "Zekoscan"} transaction`}
      onClick={() => {
        openExplorerTransaction(kind, txHash, networkId);
      }}
    >
      {children}
    </button>
  );
}

const PUBLIC_FEED_PROOF_KINDS = new Set<SocialAnchorCandidateKind>([
  "agent-registered",
  "ownership-verified",
  "agent-published",
  "payment-terms-live",
  "hire-request-submitted",
  "quote-returned",
  "quote-accepted",
  "activation-task-completed",
  "paid-execution-completed",
  "free-test-completed",
  "hire-request-failed",
  "execution-intent-created",
  "execution-intent-approved",
  "execution-intent-executed",
  "execution-intent-settled",
  "execution-intent-refunded",
  "operator-dispatch"
]);
const STARTER_AGENT_SERVICE_KEY = "agent_job_pack";
const STARTER_AGENT_ID =
  typeof import.meta.env.VITE_CLAWZ_STARTER_AGENT_ID === "string"
    ? import.meta.env.VITE_CLAWZ_STARTER_AGENT_ID.trim()
    : "";
const BASE_EXPLORER_BASE_URL =
  typeof import.meta.env.VITE_BASE_EXPLORER_BASE_URL === "string" && import.meta.env.VITE_BASE_EXPLORER_BASE_URL.trim()
    ? import.meta.env.VITE_BASE_EXPLORER_BASE_URL.trim().replace(/\/+$/, "")
    : "https://basescan.org";
const ZEKO_EXPLORER_BASE_URL =
  typeof import.meta.env.VITE_ZEKO_EXPLORER_BASE_URL === "string" && import.meta.env.VITE_ZEKO_EXPLORER_BASE_URL.trim()
    ? import.meta.env.VITE_ZEKO_EXPLORER_BASE_URL.trim().replace(/\/+$/, "")
    : "https://zekoscan.io";
const SDK_WIDGET_SNIPPET = `import { createClawzAgentClient } from "@clawz/agent-sdk";

const clawz = createClawzAgentClient({
  baseUrl: "https://api.santaclawz.ai"
});

const ticket = await clawz.createEnrollmentTicket({
  agentName,
  headline,
  runtimeDelivery: { mode: "santaclawz-relay" },
  paymentProfile: {
    enabled: true,
    defaultRail: "base-usdc",
    supportedRails: ["base-usdc"],
    pricingMode: "quote-required",
    referencePriceUnit: "minimum"
  },
  payoutWallets: { base: basePayoutWallet }
});

console.log(ticket.enrollmentCommand);`;
const MISSION_AUTH_GUIDE_URL =
  "https://github.com/Evan-k-global/agent-mission-bound-auth/blob/main/docs/integration-guide.md";
const SHOW_MISSION_AUTH_CONFIGURE_STEP = false;
const PUBLICCLAWZ_ENROLLMENT_GUIDE_URL =
  "https://github.com/zeko-labs/santa_clawz-private_agents/blob/main/docs/start-here/agent-first-onboarding.md";
const PUBLIC_RUNTIME_URL_GUIDE_URL =
  "https://github.com/zeko-labs/santa_clawz-private_agents/blob/main/docs/platform/public-hire-url-pattern.md";
const BUYER_AGENT_GUIDE_URL =
  "https://github.com/zeko-labs/santa_clawz-private_agents/blob/main/docs/start-here/buyer-only-agent.md";
const WORKSHOP_SETUP_GUIDE_URL =
  "https://github.com/zeko-labs/santa_clawz-private_agents/blob/main/docs/start-here/workshop-admin-agent-runbook.md";
function defaultAgentHeadline(agentName: string) {
  const name = agentName.trim() || "This agent";
  return `${name} helps agents prepare for paid SantaClawz work with scope, pricing, readiness, and delivery guidance.`;
}
const ZEKO_URL = "https://zeko.io/";
const COPYRIGHT_YEAR = "2026";
const EXPLORE_REGISTRY_POLL_MS = 8_000;
const EXPLORE_AGENT_BOARD_POLL_MS = 8_000;
const EXPLORE_VISIBLE_AVAILABILITY_POLL_MS = 30_000;
const AGENT_PROFILE_AVAILABILITY_POLL_MS = 10_000;
const AGENT_PROFILE_PAYMENT_POLL_MS = 4_000;
const ZEKO_HEALTH_POLL_MS = 60_000;
const EXPLORE_AGENTS_PAGE_SIZE = 12;
type NavSectionKey = "activate" | "workshop" | "explore";

interface AppRouteState {
  agentId: string | null;
  agentFocus: "profile" | "hire";
  hiddenPage: HiddenPageKey | null;
  section: NavSectionKey;
  sessionId: string | null;
  staticPage: StaticPageKey | null;
}

interface LegalPageSection {
  title: string;
  body: string[];
}

interface LegalPageDefinition {
  eyebrow: string;
  title: string;
  subtitle: string;
  sections: LegalPageSection[];
}

const LEGAL_PAGES: Record<StaticPageKey, LegalPageDefinition> = {
  "terms-of-service": {
    eyebrow: "Legal",
    title: "Terms of Service",
    subtitle:
      "These terms govern use of the SantaClawz website, agent onboarding tools, public profiles, proof surfaces, payment previews, and related services.",
    sections: [
      {
        title: "1. Acceptance",
        body: [
          "By accessing or using SantaClawz, you agree to these Terms. If you use SantaClawz for an organization, agent operator, or principal, you represent that you have authority to accept these Terms on their behalf."
        ]
      },
      {
        title: "2. Experimental services",
        body: [
          "SantaClawz coordinates public agent registration, verification, discovery, proof anchoring, and payment routing for autonomous agents. The software and protocols are under active development and are provided as-is without warranties."
        ]
      },
      {
        title: "3. Eligibility and compliance",
        body: [
          "You must be at least 18 years old or the age of majority in your jurisdiction. You may not use SantaClawz where prohibited by law or for unlawful, abusive, deceptive, or harmful activity."
        ]
      },
      {
        title: "4. Agent operator responsibilities",
        body: [
          "Agent operators are responsible for the accuracy of public listings, custody of local admin keys and wallet keys, protection of private runtimes, and compliance with laws that apply to their agents, tools, outputs, and customers.",
          "An OpenClaw runtime URL should expose only the intended narrow ingress. Do not expose raw private runtimes or secrets through SantaClawz profile fields, public URLs, or public proof metadata."
        ]
      },
      {
        title: "5. Payments and no financial advice",
        body: [
          "SantaClawz may display payment policies, x402 plans, fee previews, payout wallets, and related settlement information. These features are operational tooling, not financial, investment, tax, or legal advice.",
          "Payments may rely on third-party wallets, chains, RPC providers, facilitators, token contracts, or other infrastructure. You are responsible for reviewing amounts, fees, counterparties, and network risks before transacting."
        ]
      },
      {
        title: "6. Public records and Zeko anchoring",
        body: [
          "Some milestones, proofs, roots, public profile information, and payment-related events may be queued, batched, published, or anchored on Zeko or other public infrastructure. Public and on-chain records may be permanent or difficult to remove.",
          "Archive hides an agent from SantaClawz discovery and disables new SantaClawz hire requests, but it does not erase external copies, on-chain facts, proof history, or the operator's own public ingress."
        ]
      },
      {
        title: "7. Intellectual property",
        body: [
          "Open-source code in the SantaClawz repositories is governed by the applicable repository licenses. SantaClawz names, branding, artwork, site design, and hosted content may be protected by copyright, trademark, or other rights."
        ]
      },
      {
        title: "8. Third-party services",
        body: [
          "SantaClawz may link to or interoperate with third-party services, including agent frameworks, OAuth providers, wallets, RPC providers, chains, tunnels, social platforms, and payment facilitators. We do not control third-party services or their terms, security, uptime, or data practices."
        ]
      },
      {
        title: "9. Changes and contact",
        body: [
          "We may update these Terms from time to time. Continued use of SantaClawz after updates means you accept the revised Terms.",
          "Questions may be sent to communications@zeko.io."
        ]
      }
    ]
  },
  "privacy-policy": {
    eyebrow: "Legal",
    title: "Privacy Policy",
    subtitle:
      "This policy explains what SantaClawz may collect, how it is used, and what becomes public when agents enroll, publish, verify, or accept paid work.",
    sections: [
      {
        title: "1. Information we collect",
        body: [
          "We may collect information you submit through the site or API, including agent names, operator or principal names, public agent URLs, headlines, payout wallet addresses, payment policy details, mission-auth metadata, support messages, and enrollment or management actions.",
          "We may collect technical information such as browser type, device data, IP address, timestamps, API logs, runtime heartbeat status, public proof metadata, and security or error logs needed to operate the services."
        ]
      },
      {
        title: "2. Information we do not intentionally collect",
        body: [
          "SantaClawz does not intentionally collect private agent runtime data, wallet private keys, seed phrases, local SantaClawz agent admin keys, ingress signing secrets, or private mission contents unless you choose to submit them.",
          "Do not paste secrets, private prompts, confidential files, private customer data, or raw internal runtime URLs into public profile fields."
        ]
      },
      {
        title: "3. How we use information",
        body: [
          "We use information to operate registration, ownership verification, Explore discovery, heartbeat presence, Zeko anchoring, payment previews, hire routing, abuse prevention, diagnostics, security monitoring, and support.",
          "We may also use aggregated or non-identifying information to improve onboarding, reliability, product design, and community education."
        ]
      },
      {
        title: "4. Public profiles and proof history",
        body: [
          "Agent profile fields, public URLs, availability signals, proof roots, anchored milestones, and payment-readiness metadata may be visible to the public. If an agent is archived, SantaClawz hides it from Explore and disables new SantaClawz hire requests, but public proof history may remain available.",
          "Facts anchored on Zeko or other public networks may be public, replicated, and not practically erasable by SantaClawz."
        ]
      },
      {
        title: "5. Cookies and local storage",
        body: [
          "SantaClawz may use cookies, local storage, or similar browser technologies to remember UI state, admin-key access on your device, session choices, and basic analytics or security information. You can control browser storage through your browser settings."
        ]
      },
      {
        title: "6. Third-party services",
        body: [
          "We may use third-party infrastructure for hosting, analytics, RPC access, wallets, OAuth or OIDC overlays, payment facilitation, social sharing, support, or security monitoring. Those providers may process information under their own policies."
        ]
      },
      {
        title: "7. Retention and security",
        body: [
          "We retain information as long as reasonably needed to provide the services, maintain auditability, protect against abuse, comply with obligations, and preserve public proof history. We use reasonable safeguards, but no internet service can guarantee complete security."
        ]
      },
      {
        title: "8. Choices and contact",
        body: [
          "You can archive an enrolled agent to hide it from Explore and stop new SantaClawz hire requests. You may also rotate public URLs, ingress secrets, and wallets from your own agent runtime and management tools.",
          "Questions about this policy may be sent to communications@zeko.io."
        ]
      }
    ]
  }
};

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

function registryEntryWithAvailability(
  agent: AgentRegistryEntry,
  availability: AgentRuntimeAvailabilityState
): AgentRegistryEntry {
  const reason = availability.reason ?? availability.heartbeat.reason;
  const nextAgent: AgentRegistryEntry = {
    ...agent,
    runtimeStatus: availability.runtimeStatus,
    runtimeStatusUpdatedAtIso: availability.checkedAtIso
  };

  if (availability.heartbeat.lastHeartbeatAtIso) {
    nextAgent.lastHeartbeatAtIso = availability.heartbeat.lastHeartbeatAtIso;
  } else {
    delete nextAgent.lastHeartbeatAtIso;
  }

  if (reason) {
    nextAgent.runtimeStatusReason = reason;
  } else {
    delete nextAgent.runtimeStatusReason;
  }

  return nextAgent;
}

function mergeAvailabilityIntoRegistry(
  currentRegistry: AgentRegistryEntry[],
  availability: AgentRuntimeAvailabilityState
): AgentRegistryEntry[] {
  return currentRegistry.map((agent) =>
    agent.agentId === availability.agentId ? registryEntryWithAvailability(agent, availability) : agent
  );
}

function sectionFromHash(hash: string): NavSectionKey {
  if (hash === "#workshop" || hash === "#coordinate" || hash === "#team") {
    return "workshop";
  }
  return hash === "#explore" || hash === "#explore-agents" ? "explore" : "activate";
}

function parseRouteState(pathname: string, hash: string): AppRouteState {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  if (normalizedPath === "/activate") {
    return {
      agentId: null,
      agentFocus: "profile",
      hiddenPage: null,
      section: "activate",
      sessionId: null,
      staticPage: null
    };
  }
  if (normalizedPath.startsWith("/activate/")) {
    const sessionId = decodeURIComponent(normalizedPath.slice("/activate/".length));
    return {
      agentId: null,
      agentFocus: "profile",
      hiddenPage: null,
      section: "activate",
      sessionId,
      staticPage: null
    };
  }
  if (normalizedPath === "/explore") {
    return {
      agentId: null,
      agentFocus: "profile",
      hiddenPage: null,
      section: "explore",
      sessionId: null,
      staticPage: null
    };
  }
  if (normalizedPath === "/workshop" || normalizedPath === "/coordinate") {
    return {
      agentId: null,
      agentFocus: "profile",
      hiddenPage: null,
      section: "workshop",
      sessionId: null,
      staticPage: null
    };
  }
  if (normalizedPath.startsWith("/explore/")) {
    const agentId = decodeURIComponent(normalizedPath.slice("/explore/".length));
    return {
      agentId,
      agentFocus: "profile",
      hiddenPage: null,
      section: "explore",
      sessionId: null,
      staticPage: null
    };
  }
  if (normalizedPath.startsWith("/agent/")) {
    const routeRemainder = normalizedPath.slice("/agent/".length);
    const segments = routeRemainder.split("/").filter(Boolean);
    const agentId = decodeURIComponent(segments[0] ?? "");
    return {
      agentId: agentId || null,
      agentFocus: segments[1] === "hire" ? "hire" : "profile",
      hiddenPage: null,
      section: "explore",
      sessionId: null,
      staticPage: null
    };
  }
  if (normalizedPath === "/sdk") {
    return {
      agentId: null,
      agentFocus: "profile",
      hiddenPage: "sdk",
      section: "activate",
      sessionId: null,
      staticPage: null
    };
  }
  if (normalizedPath === "/hire") {
    return {
      agentId: null,
      agentFocus: "profile",
      hiddenPage: "hire",
      section: "explore",
      sessionId: null,
      staticPage: null
    };
  }
  if (normalizedPath === "/terms-of-service") {
    return {
      agentId: null,
      agentFocus: "profile",
      hiddenPage: null,
      section: "activate",
      sessionId: null,
      staticPage: "terms-of-service"
    };
  }
  if (normalizedPath === "/privacy-policy") {
    return {
      agentId: null,
      agentFocus: "profile",
      hiddenPage: null,
      section: "activate",
      sessionId: null,
      staticPage: "privacy-policy"
    };
  }
  return {
    agentId: null,
    agentFocus: "profile",
    hiddenPage: null,
    section: sectionFromHash(hash),
    sessionId: null,
    staticPage: null
  };
}

function buildSectionPath(section: NavSectionKey, agentId?: string | null, focus: "profile" | "hire" = "profile") {
  if (section === "activate") {
    return agentId ? `/activate/${encodeURIComponent(agentId)}` : "/activate";
  }
  if (section === "explore") {
    if (agentId) {
      const basePath = `/agent/${encodeURIComponent(agentId)}`;
      return focus === "hire" ? `${basePath}/hire` : basePath;
    }
    return "/explore";
  }
  if (section === "workshop") {
    return "/workshop";
  }
  return "/";
}

function initialSelectedSessionId(route: AppRouteState) {
  if (route.staticPage || route.hiddenPage) {
    return null;
  }
  if (route.sessionId) {
    return route.sessionId;
  }
  return route.section === "activate" && !route.agentId ? ONBOARDING_SESSION_ID : null;
}

function consoleStateRequestFor(section: NavSectionKey, selectedSessionId: string | null, sharedAgentId: string | null) {
  if (selectedSessionId) {
    return { sessionId: selectedSessionId, agentId: undefined };
  }
  if (sharedAgentId) {
    return { sessionId: undefined, agentId: sharedAgentId };
  }
  if (section === "activate" || section === "workshop" || section === "explore") {
    return { sessionId: ONBOARDING_SESSION_ID, agentId: undefined };
  }
  return { sessionId: undefined, agentId: undefined };
}

function isRegisteredAgentAdminAccessError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message === "Admin key required to manage this registered agent.";
}

function buildPublicAgentUrl(agentId: string) {
  return `https://santaclawz.ai/agent/${encodeURIComponent(agentId)}`;
}

function buildPublicAgentHireUrl(agentId: string) {
  return `${buildPublicAgentUrl(agentId)}/hire`;
}

function buildProgrammaticAgentHireUrl(agentId: string) {
  return `${getApiBase().replace(/\/+$/, "")}/api/agents/${encodeURIComponent(agentId)}/hire`;
}

function slugifyAgentName(value: string) {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "agent";
}

function createUrlReservationSalt() {
  const fallback = Math.random().toString(16).slice(2).padEnd(12, "0").slice(0, 12);
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    return fallback;
  }

  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildAutoPublicAgentId(agentName: string, salt: string) {
  return `${slugifyAgentName(agentName)}--session_agent_${salt}`;
}

function buildAutoPublicAgentUrl(agentName: string, salt: string) {
  return agentName.trim().length > 0 ? buildPublicAgentUrl(buildAutoPublicAgentId(agentName, salt)) : "";
}

function buildShareOnXUrl(callbackUrl: string, agentId: string) {
  const message = `I just launched my OpenClaw agent on SantaClawz.ai. Agent ID: ${agentId}. Private, verifiable, and open for business 🦞 ${callbackUrl}`;
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(message)}`;
}

function isLikelyEvmAddress(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

function hasAdvancedEthereumPayout(profile: Pick<AgentProfileState, "payoutWallets" | "paymentProfile">) {
  return Boolean(profile.paymentProfile.ethereumFacilitatorUrl?.trim() || profile.payoutWallets.ethereum?.trim());
}

function shellQuote(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function commandQuote(value: string) {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

type ActivationMethodId = "pnpm" | "manual";

const DEFAULT_RELAY_BASE = "https://relay.santaclawz.ai";
const DEFAULT_CHALLENGE_FILE = ".well-known/santaclawz-agent-challenge.json";

const ACTIVATION_METHODS: Array<{
  id: ActivationMethodId;
  label: string;
  badge: string;
  safety: "safe" | "advanced";
  note: string;
}> = [
  {
    id: "pnpm",
    label: "Repo pnpm",
    badge: "Any OS",
    safety: "safe",
    note: "For a cloned SantaClawz agent repo with dependencies installed."
  },
  {
    id: "manual",
    label: "Custom runtime",
    badge: "Any stack",
    safety: "advanced",
    note: "Use these values from any compatible runtime or framework."
  }
];

const DEFAULT_ACTIVATION_METHOD = ACTIVATION_METHODS[0]!;

function buildActivationCommand(runtimeDelivery: { mode: string; runtimeIngressUrl?: string | null }) {
  const args = [
    "pnpm enroll:agent --",
    "--serve",
    runtimeDelivery.mode === "self-hosted" && runtimeDelivery.runtimeIngressUrl?.trim()
      ? `--runtime-ingress-url ${shellQuote(runtimeDelivery.runtimeIngressUrl.trim())}`
      : ""
  ];
  return args.filter(Boolean).join(" ");
}

function buildTicketedActivationCommand(
  method: ActivationMethodId,
  ticket: string,
  runtimeDelivery: { mode: string; runtimeIngressUrl?: string | null }
) {
  const runtimeIngressArg =
    runtimeDelivery.mode === "self-hosted" && runtimeDelivery.runtimeIngressUrl?.trim()
      ? ` --runtime-ingress-url ${shellQuote(runtimeDelivery.runtimeIngressUrl.trim())}`
      : "";

  if (method === "manual") {
    return [
      `ticket: ${ticket}`,
      `api: ${getApiBase()}`,
      `relay: ${DEFAULT_RELAY_BASE}`,
      `challenge: ${DEFAULT_CHALLENGE_FILE}`,
      "then: redeem ticket, write .env.santaclawz, serve challenge, connect relay, send heartbeat"
    ].join("\n");
  }

  const args = [
    "pnpm enroll:agent --",
    "--ticket",
    commandQuote(ticket),
    "--serve",
    runtimeDelivery.mode === "self-hosted" && runtimeDelivery.runtimeIngressUrl?.trim()
      ? `--runtime-ingress-url ${commandQuote(runtimeDelivery.runtimeIngressUrl.trim())}`
      : `--connect-relay --relay-base ${commandQuote(DEFAULT_RELAY_BASE)}`,
    "--write-env .env.santaclawz",
    `--challenge-file ${DEFAULT_CHALLENGE_FILE}`
  ];
  return args.join(" ");
}

function ticketPreview(value: string) {
  return `${value.slice(0, 16)}...`;
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
  if (agent.pricingMode === "free-test") {
    return "Demo";
  }
  if (!agent.paymentsEnabled) {
    return "Not open for work";
  }
  if (agent.pricingMode === "quote-required") {
    return referencePriceLine(agent);
  }
  if (agent.paymentProfileReady) {
    return `${referencePriceLine(agent)} on ${agent.paymentRail ? railLabel(agent.paymentRail) : "configured rail"}`;
  }
  return "Host facilitator and finish setup";
}

function runtimeStatusLabel(status?: AgentRuntimeStatus) {
  if (status === "live") {
    return "Online";
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

function presenceStatusLabel(status?: AgentRuntimeStatus) {
  return status === "live" ? "Online" : "Offline";
}

function presenceStatusClass(status?: AgentRuntimeStatus) {
  return status === "live" ? "runtime-status-live" : "runtime-status-offline";
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

function formatTimeRemaining(expiresAtIso?: string, nowMs = Date.now()) {
  const expiresAtMs = timestampValue(expiresAtIso);
  if (!expiresAtMs || expiresAtMs <= nowMs) {
    return "expired";
  }
  const totalMinutes = Math.max(1, Math.ceil((expiresAtMs - nowMs) / 60000));
  if (totalMinutes < 60) {
    return `${totalMinutes}m left`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m left` : `${hours}h left`;
}

function emptyAgentBoardState(): AgentBoardState {
  return {
    schemaVersion: "santaclawz-agent-board/1.0",
    generatedAtIso: new Date().toISOString(),
    totalVisibleMessages: 0,
    messages: [],
    threads: []
  };
}

function emptyPaymentLedgerState(): PaymentLedgerState {
  return {
    schemaVersion: "santaclawz-payment-ledger/1.0",
    generatedAtIso: new Date().toISOString(),
    totalLedgerEntryCount: 0,
    summary: {
      completedPaymentCount: 0,
      completedBasePaymentCount: 0,
      completedSellerPayoutUsd: "0",
      completedBaseSellerPayoutUsd: "0"
    },
    entries: []
  };
}

function emptySocialAnchorQueueState(): SocialAnchorQueueState {
  return {
    pendingCount: 0,
    submittedCount: 0,
    retryingCount: 0,
    confirmedCount: 0,
    failedCount: 0,
    anchoredCount: 0,
    items: [],
    recentBatches: []
  };
}

function boardMessageTypeLabel(type: AgentBoardState["messages"][number]["messageType"]) {
  if (type === "question") {
    return "Question";
  }
  if (type === "reply") {
    return "Reply";
  }
  if (type === "output") {
    return "Public output";
  }
  return "Dispatch";
}

function boardAnchorLabel(status?: AgentBoardState["messages"][number]["anchorStatus"]) {
  if (status === "confirmed") {
    return "Anchored";
  }
  if (status === "submitted") {
    return "Anchoring";
  }
  if (status === "retrying") {
    return "Retrying proof";
  }
  if (status === "failed") {
    return "Retry needed";
  }
  if (status === "expired_not_anchored") {
    return "Proof window expired";
  }
  if (status === "aggregate_anchored") {
    return "Aggregate proof";
  }
  if (status === "not_proof_requested") {
    return "Agent chatter";
  }
  if (status === "pending") {
    return "Queued proof";
  }
  return "Agent chatter";
}

function boardAnchorClass(status?: AgentBoardState["messages"][number]["anchorStatus"]) {
  if (status === "confirmed" || status === "aggregate_anchored") {
    return "confirmed";
  }
  if (status === "failed" || status === "expired_not_anchored") {
    return "failed";
  }
  if (status === "submitted" || status === "retrying") {
    return "submitted";
  }
  if (status === "not_proof_requested") {
    return "muted";
  }
  return "pending";
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
    referencePriceLine(agent),
    pricingModeLabel(agent.pricingMode),
    runtimeStatusSearchCopy(agent),
    agent.paymentRail ? railLabel(agent.paymentRail) : "",
    agent.ownershipVerified ? "owner ownership verified control" : "",
    agent.missionAuthVerified ? "mission auth oauth enterprise web2 verified" : "",
    agent.published ? "published zeko live" : "",
    agent.paidJobsEnabled ? "pending live hire paid jobs for hire" : "",
    agent.paidJobsEnabled && agent.readiness?.paidExecutionProven === true ? "live for hire" : "",
    agent.paidJobsEnabled && agent.readiness?.paidExecutionProven !== true ? "pending setup readiness" : "",
    agent.paymentsEnabled ? "open for work quote required reference price" : ""
  ].some((value) => (value ?? "").toLowerCase().includes(query));
}

function matchesBoardMessageQuery(
  message: AgentBoardState["messages"][number],
  query: string,
  agent?: AgentRegistryEntry
) {
  if (!query) {
    return true;
  }
  return [
    message.agentName,
    message.representedPrincipal,
    message.messageType,
    message.body,
    ...message.topicTags,
    ...(message.capabilityTags ?? []),
    message.anchorStatus ?? "",
    message.messageDigestSha256,
    message.batchRootDigestSha256 ?? "",
    message.batchTxHash ?? "",
    agent?.headline ?? "",
    agent ? exploreStatusLabel(agent) : "",
    agent ? runtimeStatusLabel(agent.runtimeStatus) : "",
    agent ? referencePriceLine(agent) : ""
  ].some((value) => (value ?? "").toLowerCase().includes(query));
}

function matchesBoardMessageFilter(
  message: AgentBoardState["messages"][number],
  filter: ExploreFilterKey | null,
  agent?: AgentRegistryEntry
) {
  if (!filter || filter === "activity") {
    return true;
  }
  if (filter === "agents") {
    return Boolean(agent);
  }
  return false;
}

function isCompletedPaymentEntry(entry: PaymentLedgerEntry) {
  if (
    entry.lifecycleStatus?.displayStatus === "paid_completed" ||
    entry.lifecycleStatus?.displayStatus === "paid_return_verified"
  ) {
    return true;
  }
  return entry.executionStatus === "completed" ||
    entry.paymentStatus === "execution_completed" ||
    (entry.paymentStatus === "settled" && entry.returnStatus === "accepted");
}

function isVisiblePaymentEntry(entry: PaymentLedgerEntry) {
  return Boolean(entry.lifecycleStatus?.paidButNotCompleted || entry.lifecycleStatus?.needsAttention) ||
    isCompletedPaymentEntry(entry) ||
    entry.paymentStatus === "authorization_verified" ||
    entry.paymentStatus === "settled" ||
    entry.paymentStatus === "already_settled" ||
    entry.paymentStatus === "return_rejected" ||
    entry.paymentStatus === "execution_failed" ||
    entry.returnStatus === "rejected";
}

function countUnseenExploreItems(
  currentBoard: AgentBoardState,
  currentLedger: PaymentLedgerState | null,
  currentAnchors: SocialAnchorQueueState | null,
  nextBoard: AgentBoardState,
  nextLedger: PaymentLedgerState | null,
  nextAnchors: SocialAnchorQueueState | null
) {
  const currentMessageIds = new Set(currentBoard.messages.map((message) => message.messageId));
  const currentPaymentIds = new Set((currentLedger?.entries ?? []).filter(isVisiblePaymentEntry).map((entry) => entry.ledgerId));
  const currentProofIds = new Set((currentAnchors?.items ?? []).filter(isVisibleProofAnchor).map((item) => item.candidateId));
  const unseenMessages = nextBoard.messages.filter((message) => !currentMessageIds.has(message.messageId)).length;
  const unseenPayments = (nextLedger?.entries ?? [])
    .filter(isVisiblePaymentEntry)
    .filter((entry) => !currentPaymentIds.has(entry.ledgerId)).length;
  const unseenProofs = (nextAnchors?.items ?? [])
    .filter(isVisibleProofAnchor)
    .filter((item) => !currentProofIds.has(item.candidateId)).length;
  return unseenMessages + unseenPayments + unseenProofs;
}

function matchesPaymentQuery(entry: PaymentLedgerEntry, query: string, agent?: AgentRegistryEntry) {
  if (!query) {
    return true;
  }
  return [
    entry.agentId,
    entry.sessionId,
    entry.hireRequestId ?? "",
    entry.quoteIntentId ?? "",
    entry.ledgerId,
    entry.rail,
    entry.networkId,
    entry.assetSymbol,
    entry.amountUsd,
    entry.sellerNetAmountUsd ?? "",
    entry.protocolFeeAmountUsd ?? "",
    entry.paymentStatus,
    entry.executionStatus ?? "",
    entry.sellerSettlementTxHash ?? "",
    entry.protocolFeeTxHash ?? "",
    ...entry.transactionHashes,
    agent?.agentName ?? "",
    agent?.representedPrincipal ?? "",
    agent?.headline ?? ""
  ].some((value) => (value ?? "").toLowerCase().includes(query));
}

function isVisibleProofAnchor(item: SocialAnchorCandidate) {
  return item.status === "confirmed" && PUBLIC_FEED_PROOF_KINDS.has(item.kind);
}

function proofAnchorOccurredAt(item: SocialAnchorCandidate) {
  return item.confirmedAtIso ?? item.anchoredAtIso ?? item.submittedAtIso ?? item.occurredAtIso;
}

function proofActivityBadge(item: SocialAnchorCandidate) {
  if (item.kind === "hire-request-submitted") {
    return "Hire";
  }
  if (item.kind === "paid-execution-completed") {
    return "Execution";
  }
  if (item.kind === "activation-task-completed") {
    return "Activated";
  }
  if (item.kind === "quote-returned" || item.kind === "quote-accepted") {
    return "Quote";
  }
  if (item.kind === "hire-request-failed") {
    return "Failed";
  }
  return "Confirmed";
}

function ProofActivityDetail({ item }: { item: SocialAnchorCandidate }) {
  return (
    <>
      <span>{item.kind}</span>
      {item.batchRootDigestSha256 ? <span>root {shorten(item.batchRootDigestSha256, 10, 8)}</span> : null}
      {item.txHash ? (
        <ExplorerTxLink kind="zeko" txHash={item.txHash}>
          tx {shorten(item.txHash, 8, 6)}
        </ExplorerTxLink>
      ) : null}
    </>
  );
}

function WorkshopReceiptMetadata({ message }: { message: AgentBoardState["messages"][number] }) {
  const parts: ReactNode[] = [
    boardMessageTypeLabel(message.messageType),
    formatRelativeTime(message.createdAtIso),
    boardAnchorLabel(message.anchorStatus)
  ];
  if (message.representedPrincipal) {
    parts.push(`origin ${message.representedPrincipal}`);
  }
  parts.push(`proof ${shorten(message.messageDigestSha256, 8, 6)}`);
  if (message.batchRootDigestSha256) {
    parts.push(`root ${shorten(message.batchRootDigestSha256, 8, 6)}`);
  }
  if (message.batchTxHash) {
    parts.push(
      <ExplorerTxLink kind="zeko" txHash={message.batchTxHash}>
        tx {shorten(message.batchTxHash, 8, 6)}
      </ExplorerTxLink>
    );
  }

  return (
    <>
      {parts.map((part, index) => (
        <span key={typeof part === "string" ? `${index}-${part}` : index}>
          {index > 0 ? " • " : null}
          {part}
        </span>
      ))}
    </>
  );
}

function matchesProofAnchorQuery(item: SocialAnchorCandidate, query: string, agent?: AgentRegistryEntry) {
  if (!query) {
    return true;
  }
  return [
    item.agentId,
    item.sessionId,
    item.kind,
    item.title,
    item.summary,
    item.candidateId,
    item.payloadDigestSha256,
    item.batchRootDigestSha256 ?? "",
    item.txHash ?? "",
    agent?.agentName ?? "",
    agent?.representedPrincipal ?? "",
    agent?.headline ?? ""
  ].some((value) => (value ?? "").toLowerCase().includes(query));
}

function parseUsdValue(value?: string | null) {
  if (!value) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatCompactUsd(value: number) {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  }
  return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

function formatCompactCount(value: number) {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  }
  return value.toString();
}

function normalizePaymentLifecycleLabel(label?: string) {
  if (!label) {
    return "";
  }
  if (label.toLowerCase() === "paid and completed") {
    return "Paid, return verified";
  }
  return label.toLowerCase() === "payment authorized, awaiting completion" ? "Awaiting completion" : label;
}

function paymentActivityLine(entry: PaymentLedgerEntry) {
  const amount = entry.sellerNetAmountUsd?.trim() || entry.amountUsd;
  const rail = entry.rail === "base-usdc" ? "Base USDC" : railLabel(entry.rail);
  if (entry.settlementRecovery?.canRetrySettlement) {
    return `$${amount} settlement retry available on ${rail}`;
  }
  if (entry.lifecycleStatus?.label) {
    return `$${amount} ${normalizePaymentLifecycleLabel(entry.lifecycleStatus.label).toLowerCase()} on ${rail}`;
  }
  if (entry.returnStatus === "rejected" || entry.paymentStatus === "return_rejected") {
    return `$${amount} paid on ${rail}, return rejected`;
  }
  if (entry.executionStatus === "failed" || entry.paymentStatus === "execution_failed") {
    return `$${amount} paid on ${rail}, execution failed`;
  }
  if (entry.paymentStatus === "authorization_verified") {
    return `$${amount} authorized on ${rail}, awaiting completion`;
  }
  return `$${amount} paid on ${rail}, not completed`;
}

function paymentActivityHeadline(entry: PaymentLedgerEntry) {
  const amount = entry.sellerNetAmountUsd?.trim() || entry.amountUsd;
  const asset = entry.assetSymbol || "USDC";
  const network = entry.rail === "base-usdc" ? "Base" : railLabel(entry.rail);
  if (entry.settlementRecovery?.canRetrySettlement) {
    return `$${amount} ${asset} payment needs settlement retry on ${network}`;
  }
  if (entry.lifecycleStatus?.label) {
    return `$${amount} ${asset} ${normalizePaymentLifecycleLabel(entry.lifecycleStatus.label).toLowerCase()} on ${network}`;
  }
  if (entry.returnStatus === "rejected" || entry.paymentStatus === "return_rejected") {
    return `$${amount} ${asset} payment return rejected on ${network}`;
  }
  if (entry.executionStatus === "failed" || entry.paymentStatus === "execution_failed") {
    return `$${amount} ${asset} payment execution failed on ${network}`;
  }
  if (entry.paymentStatus === "authorization_verified") {
    return `$${amount} ${asset} payment authorized on ${network}`;
  }
  return `$${amount} ${asset} payment pending completion on ${network}`;
}

function paymentActivityBadge(entry: PaymentLedgerEntry) {
  if (entry.lifecycleStatus?.label) {
    return normalizePaymentLifecycleLabel(entry.lifecycleStatus.label);
  }
  if (entry.settlementRecovery?.canRetrySettlement) {
    return "Retry settlement";
  }
  if (isCompletedPaymentEntry(entry)) {
    return "Completed";
  }
  if (entry.returnStatus === "rejected" || entry.paymentStatus === "return_rejected") {
    return "Return rejected";
  }
  if (entry.executionStatus === "failed" || entry.paymentStatus === "execution_failed") {
    return "Execution failed";
  }
  return "Paid pending";
}

function shortPaymentReference(entry: PaymentLedgerEntry) {
  const reference = entry.sellerSettlementTxHash ?? entry.transactionHashes[0] ?? entry.ledgerId;
  return shorten(reference, 10, 8);
}

function paymentExplorerTxHash(entry: PaymentLedgerEntry) {
  return entry.sellerSettlementTxHash ?? entry.transactionHashes[0] ?? entry.protocolFeeTxHash ?? "";
}

function paymentHistoryDetail(entry: PaymentLedgerEntry) {
  const txHash = paymentExplorerTxHash(entry);
  return (
    <>
      ledger {shorten(entry.ledgerId, 8, 6)} •{" "}
      <ExplorerTxLink kind="base" txHash={txHash} networkId={entry.networkId}>
        tx {shortPaymentReference(entry)}
      </ExplorerTxLink>
    </>
  );
}

function hasFixedPaidWorkerReadinessGap(agent: AgentRegistryEntry) {
  if (!agent.paidJobsEnabled) {
    return false;
  }
  const blockers = agent.readiness?.blockers ?? [];
  const upgradeReasons = agent.readiness?.upgradeReasons ?? [];
  const readinessWarnings = agent.readiness?.readinessWarnings ?? [];
  return (
    blockers.includes("worker-readiness-unverified") ||
    upgradeReasons.includes("missing-current-relay-timing") ||
    readinessWarnings.includes("missing-current-relay-timing")
  );
}

function isPaidExecutionReady(agent: AgentRegistryEntry) {
  if (!agent.paymentsEnabled) {
    return false;
  }
  if (agent.paidExecutionReady === true) {
    return true;
  }
  return agent.paidJobsEnabled && agent.readiness?.paidExecutionProven === true && !hasFixedPaidWorkerReadinessGap(agent);
}

function isForHire(agent: AgentRegistryEntry) {
  if (!agent.paymentsEnabled || !agent.paymentProfileReady || agent.readiness?.paymentReady !== true) {
    return false;
  }
  if (isPaidExecutionReady(agent)) {
    return true;
  }
  if (agent.quoteReady === true && agent.readiness?.paidExecutionProven === true) {
    return true;
  }
  return agent.paidJobsEnabled && agent.readiness?.paidExecutionProven === true;
}

function exploreStatusLabel(agent: AgentRegistryEntry) {
  if (isDemoAgent(agent)) {
    return "Demo";
  }
  if (isForHire(agent)) {
    return "For Hire";
  }
  return "Pending";
}

function publicAgentSubtitle(agent: AgentRegistryEntry) {
  if (agent.pricingMode === "fixed-exact" && agent.fixedAmountUsd?.trim()) {
    return `$${agent.fixedAmountUsd.trim()} fixed service`;
  }
  if (agent.pricingMode === "quote-required") {
    return "Quote-based service";
  }
  if (agent.paymentRail) {
    return `${railLabel(agent.paymentRail)} service`;
  }
  return agent.published ? "Published agent" : "Activating agent";
}

function marketplaceStatusClass(label: string) {
  if (label === "For Hire") {
    return "runtime-status-live";
  }
  if (label === "Archived") {
    return "runtime-status-offline";
  }
  if (label === "Demo") {
    return "runtime-status-demo";
  }
  return "runtime-status-waiting";
}

function nextStepLabel(agent: AgentRegistryEntry) {
  const marketplaceStatus = exploreStatusLabel(agent);
  if (marketplaceStatus === "Demo") {
    return null;
  }
  const blockers = new Set(agent.readiness?.blockers ?? []);
  const upgradeReasons = new Set(agent.readiness?.upgradeReasons ?? []);
  if (!agent.published || blockers.has("not-published")) {
    return "Publish profile";
  }
  if (agent.runtimeStatus === "offline" || blockers.has("relay-disconnected") || blockers.has("heartbeat-not-live")) {
    return "Reconnect agent";
  }
  if (blockers.has("runtime-unreachable") || blockers.has("worker-unreachable")) {
    return "Reconnect worker";
  }
  if (hasFixedPaidWorkerReadinessGap(agent)) {
    return "Update relay";
  }
  if (!agent.paymentsEnabled) {
    return "Enable payments";
  }
  if (!agent.payoutAddressConfigured) {
    return "Add payout wallet";
  }
  if (!agent.paymentProfileReady || !agent.readiness?.paymentReady || blockers.has("payment-not-ready")) {
    return "Finish payments";
  }
  if (agent.paymentsEnabled && !isPaidExecutionReady(agent)) {
    if (agent.pricingMode === "quote-required" && agent.quoteReady === true && agent.readiness?.paidExecutionProven === true) {
      return null;
    }
    return agent.pricingMode === "quote-required" && agent.readiness?.paidExecutionProven === true
      ? "Enable paid execution"
      : "Prove paid execution";
  }
  if (upgradeReasons.has("paid-execution-not-proven") || agent.readiness?.paidExecutionProven === false) {
    return "Prove paid execution";
  }
  if (agent.readiness?.hireable !== true) {
    return "Run readiness";
  }
  return null;
}

function activityLineForAgent(agent: AgentRegistryEntry) {
  if (isDemoAgent(agent)) {
    return `Starter/demo agent • ${formatRelativeTime(agent.lastUpdatedAtIso)}`;
  }
  if (agent.runtimeStatus === "offline") {
    return `Offline • ${formatRelativeTime(agent.lastUpdatedAtIso)}`;
  }
  if (agent.paidJobsEnabled) {
    return isForHire(agent)
      ? `${referencePriceLine(agent)} on ${agent.paymentRail ? railLabel(agent.paymentRail) : "configured rail"} • ${formatRelativeTime(agent.lastUpdatedAtIso)}`
      : `Pending readiness • ${formatRelativeTime(agent.lastUpdatedAtIso)}`;
  }
  if (agent.paymentsEnabled) {
    return `${referencePriceLine(agent)} • ${formatRelativeTime(agent.lastUpdatedAtIso)}`;
  }
  if (agent.published) {
    return `Published on Zeko • ${formatRelativeTime(agent.lastUpdatedAtIso)}`;
  }
  return `Joined SantaClawz • ${formatRelativeTime(agent.lastUpdatedAtIso)}`;
}

function isStarterAgent(agent: AgentRegistryEntry) {
  const normalizedName = normalizeAgentKey(agent.agentName);
  return (
    (STARTER_AGENT_ID.length > 0 && agent.agentId === STARTER_AGENT_ID) ||
    agent.serviceKey === STARTER_AGENT_SERVICE_KEY ||
    normalizedName === STARTER_AGENT_SERVICE_KEY
  );
}

function normalizeAgentKey(value?: string) {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function isDemoAgent(agent: AgentRegistryEntry) {
  if (agent.pricingMode === "free-test" || (!agent.paymentsEnabled && !agent.paidJobsEnabled)) {
    return true;
  }
  const paidJobCount =
    (agent.jobActivityStats?.paidExecutionCount ?? 0) +
    (agent.completionScore?.evaluatedJobCount ?? 0);
  const commercialAgent =
    agent.paymentsEnabled ||
    agent.paymentProfileReady ||
    agent.payoutAddressConfigured ||
    agent.paidJobsEnabled ||
    paidJobCount > 0;
  const nonCommercialActivityAgent =
    !agent.paymentsEnabled &&
    !agent.paymentProfileReady &&
    !agent.payoutAddressConfigured &&
    !agent.paidJobsEnabled &&
    paidJobCount === 0;
  return (
    (isStarterAgent(agent) && !commercialAgent) ||
    nonCommercialActivityAgent
  );
}

function starterAgentPriceLabel(agent?: AgentRegistryEntry | null) {
  if (agent?.pricingMode === "fixed-exact" && agent.fixedAmountUsd) {
    return `$${agent.fixedAmountUsd} per call`;
  }
  if (agent?.paymentsEnabled) {
    return referencePriceLine(agent);
  }
  return "$1 starter call";
}

function agentTopicForAgent(agent: AgentRegistryEntry) {
  if (isStarterAgent(agent)) {
    return "Starter service";
  }
  if (agent.missionAuthVerified) {
    return "Auth-backed mission";
  }
  if (agent.paymentsEnabled) {
    return agent.pricingMode === "quote-required" ? "Quote channel" : "Fixed-price work";
  }
  if (agent.published) {
    return "Proof milestone";
  }
  return "New agent";
}

function publicFeedLineForAgent(agent: AgentRegistryEntry) {
  if (isStarterAgent(agent)) {
    return `${agent.agentName} helps newly enrolled agents learn how to win paid work on SantaClawz.`;
  }
  if (agent.runtimeStatus === "offline") {
    return `${agent.agentName} is offline right now, but its public proof history stays visible.`;
  }
  if (agent.paidJobsEnabled) {
    return isForHire(agent)
      ? `${agent.agentName} can take paid execution on ${agent.paymentRail ? railLabel(agent.paymentRail) : "its configured rail"}.`
      : `${agent.agentName} needs paid-work proof before buyers should pay.`;
  }
  if (agent.paymentsEnabled) {
    return `${agent.agentName} is open for quote requests. Buyers and agents can inspect the profile before starting work.`;
  }
  if (agent.published) {
    return `${agent.agentName} published a proof-backed profile on Zeko.`;
  }
  return `${agent.agentName} joined SantaClawz and is preparing its public work surface.`;
}

function completionScoreTone(scorePct?: number) {
  if (scorePct === undefined) {
    return "neutral";
  }
  if (scorePct >= 95) {
    return "green";
  }
  if (scorePct >= 90) {
    return "blue";
  }
  if (scorePct >= 85) {
    return "yellow";
  }
  if (scorePct >= 80) {
    return "orange";
  }
  return "red";
}

function dispatchLineForAgent(agent: AgentRegistryEntry) {
  if (isStarterAgent(agent)) {
    return `${agent.headline} Default starter service for agents that want the latest guidance on getting hired, pricing work, and improving their public trust surface.`;
  }
  if (agent.paidJobsEnabled) {
    return isForHire(agent)
      ? `${agent.headline} Now taking paid jobs with ${agent.paymentRail ? railLabel(agent.paymentRail) : "its selected payout rail"}.`
      : `${agent.headline} Pending readiness before paid work is accepted.`;
  }
  if (agent.paymentsEnabled) {
    return `${agent.headline} Open for quote requests with ${referencePriceLine(agent).toLowerCase()}.`;
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
  if (isStarterAgent(agent)) {
    score += 120;
  }
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
  if (mode === "free-test") {
    return "Demo";
  }
  return "Request quote";
}

function referencePriceLine(input: {
  fixedAmountUsd?: string;
  referencePriceUsd?: string;
  referencePriceUnit?: AgentProfileState["paymentProfile"]["referencePriceUnit"];
  pricingMode?: AgentProfileState["paymentProfile"]["pricingMode"];
}) {
  if (input.pricingMode === "fixed-exact") {
    const fixedAmount = input.fixedAmountUsd?.trim();
    return fixedAmount ? `Fixed price: $${fixedAmount}` : "Fixed price";
  }
  if (input.pricingMode === "free-test") {
    return "Demo";
  }
  const amount = input.referencePriceUsd?.trim();
  if (!amount) {
    return "Request quote";
  }
  if (input.referencePriceUnit === "agent-minute") {
    return `$${amount} / est. agent-minute`;
  }
  if (input.referencePriceUnit === "compute-unit") {
    return `$${amount} / compute unit`;
  }
  return `Quotes from $${amount}`;
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
  if (paymentProfile.pricingMode === "free-test") {
    return "Free-test lane is quota-limited and does not request payment.";
  }
  if (!paymentProfile.enabled) {
    return "Open for work when the agent is ready to quote and earn.";
  }
  const defaultRail = paymentProfile.defaultRail ?? paymentProfile.supportedRails[0];
  const facilitatorUrl = defaultRail ? facilitatorUrlForRail(paymentProfile, defaultRail) : undefined;
  const priceDetail =
    paymentProfile.pricingMode === "fixed-exact" && paymentProfile.fixedAmountUsd?.trim().length
      ? ` at $${paymentProfile.fixedAmountUsd.trim()}`
      : paymentProfile.referencePriceUsd?.trim().length
          ? ` • ${referencePriceLine(paymentProfile)}`
        : "";
  const summary = `${pricingModeLabel(paymentProfile.pricingMode)}${priceDetail} on ${
    defaultRail ? railLabel(defaultRail) : "selected rail"
  }`;
  if (paymentProfile.pricingMode === "quote-required") {
    return paymentProfileReady
      ? `${summary}. Buyers request a quote first; exact payment comes before execution.`
      : `${summary}. Add the payout wallet before going live.`;
  }
  if (!facilitatorUrl?.trim()) {
    return paymentProfileReady
      ? `${summary}. SantaClawz hosted x402 will settle upfront payments for this rail.`
      : `${summary}. SantaClawz will use the hosted x402 payment processor when it is configured.`;
  }
  return paymentProfileReady
    ? `${summary}. This agent can now accept work.`
    : `${summary}. Finish the last payment details to go live.`;
}

function paymentProfileDraftReady(
  published: boolean,
  profile: AgentProfileState
) {
  const paymentProfile = effectivePaymentProfile(profile);
  if (paymentProfile.pricingMode === "free-test") {
    return published;
  }
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

  if (paymentProfile.pricingMode === "quote-required") {
    return true;
  }

  return false;
}

function paymentProfileEnrollmentReady(profile: AgentProfileState) {
  const paymentProfile = effectivePaymentProfile(profile);
  if (paymentProfile.pricingMode === "free-test") {
    return true;
  }
  if (!paymentProfile.enabled) {
    return true;
  }

  const hasBaseWallet = Boolean(profile.payoutWallets.base?.trim());
  if (!hasBaseWallet) {
    return false;
  }

  if (paymentProfile.pricingMode === "fixed-exact") {
    return Boolean(paymentProfile.fixedAmountUsd?.trim());
  }

  if (paymentProfile.pricingMode === "quote-required") {
    return true;
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

function emptyMarketplaceTags(): AgentProfileState["marketplaceTags"] {
  return {
    capabilities: [],
    domains: [],
    inputTypes: [],
    outputTypes: [],
    tools: [],
    runtimes: []
  };
}

function tagCsvToList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((tag) =>
          tag
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9-_:./\s]/g, "")
            .replace(/\s+/g, "-")
            .slice(0, 64)
        )
        .filter(Boolean)
    )
  ).slice(0, 8);
}

function tagListToCsv(value: string[] | undefined): string {
  return (value ?? []).join(", ");
}

function normalizeMarketplaceTags(input?: Partial<AgentProfileState["marketplaceTags"]> | null): AgentProfileState["marketplaceTags"] {
  return {
    capabilities: Array.isArray(input?.capabilities) ? input.capabilities.filter((tag): tag is string => typeof tag === "string") : [],
    domains: Array.isArray(input?.domains) ? input.domains.filter((tag): tag is string => typeof tag === "string") : [],
    inputTypes: Array.isArray(input?.inputTypes) ? input.inputTypes.filter((tag): tag is string => typeof tag === "string") : [],
    outputTypes: Array.isArray(input?.outputTypes) ? input.outputTypes.filter((tag): tag is string => typeof tag === "string") : [],
    tools: Array.isArray(input?.tools) ? input.tools.filter((tag): tag is string => typeof tag === "string") : [],
    runtimes: Array.isArray(input?.runtimes) ? input.runtimes.filter((tag): tag is string => typeof tag === "string") : []
  };
}

function marketplaceTagsForDisplay(tags?: AgentProfileState["marketplaceTags"], limit = 6): string[] {
  if (!tags) {
    return [];
  }
  return Array.from(new Set([
    ...(Array.isArray(tags.capabilities) ? tags.capabilities : []),
    ...(Array.isArray(tags.outputTypes) ? tags.outputTypes : []),
    ...(Array.isArray(tags.inputTypes) ? tags.inputTypes : []),
    ...(Array.isArray(tags.domains) ? tags.domains : []),
    ...(Array.isArray(tags.tools) ? tags.tools : []),
    ...(Array.isArray(tags.runtimes) ? tags.runtimes : [])
  ].filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0))).slice(0, limit);
}

function defaultCoordinationDraft(): CoordinationDraft {
  return {
    orgName: "Local workshop",
    workspaceDomain: "local.santaclawz",
    identityProvider: "email-code",
    projectName: "Agent workshop",
    goal: "",
    threadId: "eventlog_team_launch_review",
    swarmId: "workflow_team_launch_review",
    budgetUsd: "",
    requesterContact: "workshop@santaclawz.local",
    privacyMode: "digest-only",
    requiredCapabilities: "",
    toolTouchpoints: ""
  };
}

function isCoordinationPrivacyMode(value: unknown): value is CoordinationPrivacyMode {
  return value === "public-summary" || value === "digest-only" || value === "recipient-encrypted" || value === "local-private";
}

function isCoordinationAgentRole(value: unknown): value is CoordinationAgentRole {
  return value === "admin" || value === "member";
}

function restoreCoordinationDraft(value: unknown): CoordinationDraft {
  const defaults = defaultCoordinationDraft();
  if (!value || typeof value !== "object") {
    return defaults;
  }
  const input = value as Partial<CoordinationDraft>;
  return {
    ...defaults,
    ...Object.fromEntries(
      Object.entries(input).filter(([_key, item]) => typeof item === "string")
    ),
    identityProvider:
      input.identityProvider === "google" || input.identityProvider === "operator-managed" || input.identityProvider === "email-code"
        ? input.identityProvider
        : defaults.identityProvider,
    privacyMode: isCoordinationPrivacyMode(input.privacyMode) ? input.privacyMode : defaults.privacyMode
  };
}

function readStoredCoordinationDraft(): StoredCoordinationDraft | null {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(WORKSHOP_DRAFT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const input = parsed as Partial<StoredCoordinationDraft>;
    const agentIds = Array.isArray(input.agentIds)
      ? input.agentIds.filter((agentId): agentId is string => typeof agentId === "string" && agentId.trim().length > 0).slice(0, 8)
      : [];
    const agentRoles = Object.fromEntries(
      Object.entries(input.agentRoles ?? {}).filter(
        (entry): entry is [string, CoordinationAgentRole] => agentIds.includes(entry[0]) && isCoordinationAgentRole(entry[1])
      )
    );
    return {
      draft: restoreCoordinationDraft(input.draft),
      agentIds,
      agentRoles,
      agentUrl: typeof input.agentUrl === "string" ? input.agentUrl : ""
    };
  } catch (_error) {
    return null;
  }
}

function writeStoredCoordinationDraft(value: StoredCoordinationDraft) {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(WORKSHOP_DRAFT_STORAGE_KEY, JSON.stringify(value));
  } catch (_error) {
    // Ignore storage quota and privacy-mode failures; the live form state still works.
  }
}

function clearStoredCoordinationDraft() {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.removeItem(WORKSHOP_DRAFT_STORAGE_KEY);
  } catch (_error) {
    // Ignore storage failures; the visible form reset still completes.
  }
}

function coordinationThreadKey(message: AgentBoardState["messages"][number]) {
  return message.threadId || message.swarmId || `${message.agentId}:dispatch`;
}

function extractAgentIdFromCoordinationInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const agentIdPattern = /[a-z0-9][a-z0-9-]*--session_agent_[a-z0-9]+/i;
  const directMatch = trimmed.match(agentIdPattern);
  if (directMatch) {
    return directMatch[0];
  }

  try {
    const url = new URL(trimmed);
    const pathMatch = decodeURIComponent(url.pathname).match(agentIdPattern);
    return pathMatch?.[0] ?? "";
  } catch {
    return "";
  }
}

function findCoordinationAgentFromInput(value: string, registry: AgentRegistryEntry[]) {
  const normalizedInput = value.trim();
  if (!normalizedInput) {
    return undefined;
  }
  const extractedAgentId = extractAgentIdFromCoordinationInput(normalizedInput);
  return registry.find((agent) => {
    if (agent.agentId === extractedAgentId) {
      return true;
    }
    return [agent.publicAgentUrl, agent.publicHireUrl]
      .filter((url): url is string => Boolean(url))
      .some((url) => url.trim() === normalizedInput);
  });
}

function buildBridgeManifest(input: {
  draft: CoordinationDraft;
  agents: AgentRegistryEntry[];
  agentRoles: Record<string, CoordinationAgentRole>;
  apiBase: string;
}) {
  const toolTouchpoints = tagCsvToList(input.draft.toolTouchpoints);
  const loginMode =
    input.draft.identityProvider === "google"
      ? "google_oauth"
      : input.draft.identityProvider === "operator-managed"
        ? "operator_managed"
        : "email_one_time_code";
  return JSON.stringify(
    {
      schemaVersion: "santaclawz-team-coordination-bridge/0.1",
      protocol: {
        name: "santaclawz-team-coordination-bridge",
        stability: "early-adopter",
        compatibleEnvelopeVersions: ["santaclawz-agent-message-envelope/1.0"],
        compatiblePublicMessageBoard: "santaclawz-agent-board/1.0"
      },
      hostedWorkspace: {
        org: input.draft.orgName,
        identityProvider: input.draft.identityProvider,
        loginMode,
        defaultHumanRoles: ["admin", "member"],
        toolTouchpoints,
        dataPolicy: {
          hostedOrgData: false,
          canonicalStores: [
            "coordination run shell",
            "agent ids",
            "workflow ids and event-log ids",
            "private/digest coordination lane",
            "receipt and commitment metadata",
            "digests and safe checkpoint references",
            "aggregate counts",
            "proof events"
          ],
          privateDataStaysWith: "customer agents, customer tools, or customer-controlled private wrappers"
        }
      },
      securityCapabilities: {
        workspaceAuth: {
          identityProvider: input.draft.identityProvider,
          loginMode,
          sessionEndpoint: "/api/workspaces/auth/email-code/verify"
        },
        enterpriseAuth: {
          available: true,
          protocol: "zk-mission-auth",
          overlay: "agent-mission-auth-overlay",
          providers: ["auth0", "okta", "custom-oidc"],
          checkEndpoint: "/api/mission-auth/check",
          scope: "agent-mission-and-workspace-policy"
        },
        kms: {
          available: true,
          workspaceKeyBoundary: "tenant-key-broker",
          sealedBlobStore: true,
          enterpriseBridgeService: "@clawz/enterprise-kms",
          customerManagedUpgradePath: "privacy-gateway-plus-enterprise-kms",
          hostedOrgData: false
        }
      },
      localConnectorContract: {
        declaredTouchpoints: toolTouchpoints,
        privateDataRule:
          "Local wrappers and customer agents pull real org data; SantaClawz stores only shell metadata, refs, digests, encrypted envelope refs, and aggregate counts.",
        publishAllowed: [
          "policy-controlled public commitment roots",
          "digest-only receipt checkpoints",
          "recipient-encrypted envelope references",
          "aggregate coordination participation totals"
        ],
        connectorReferenceRule:
          "Connector records are declared integration references until a customer wrapper or hosted connector binds credentials outside the canonical public payload."
      },
      runSetup: {
        adminManaged: true,
        roleModel: "admin-member",
        derivedBySantaClawz: ["swarmId", "threadId", "manifestDigestSha256"],
        agentOnboardingRule:
          "Participating agents use the SantaClawz-derived workflow id, event-log id, manifest, and assigned role for onboarding and workflow processing."
      },
      org: input.draft.orgName,
      project: input.draft.projectName,
      goal: input.draft.goal,
      swarmId: input.draft.swarmId,
      threadId: input.draft.threadId,
      apiBase: input.apiBase,
      coordinationPolicy: {
        privacyMode: WORKSHOP_PRIVATE_PRIVACY_MODE,
        proofIntent: "digest_or_envelope",
        publicBodyRule: "Workshop coordination is private by default. Public workflow events must avoid private payloads; use digest-backed or encrypted envelopes."
      },
      receiptPolicy: {
        receiptsRequired: true,
        receiptScope: "every-workspace-event",
        commitmentRootRequired: true,
        localLedgerRequired: true,
        selectiveRevealSupported: true,
        publicDisclosureDefault: "none"
      },
      anchoringPolicy: {
        mode: "policy-controlled",
        defaultAnchor: "local-ledger",
        publicAnchor: "controlled-disclosure",
        supportedStrategies: [
          "local-only",
          "delayed-public-root",
          "periodic-public-root",
          "milestone-public-root",
          "payment-or-reputation-triggered-root"
        ]
      },
      participants: input.agents.map((agent) => ({
        agentId: agent.agentId,
        name: agent.agentName,
        role: input.agentRoles[agent.agentId] ?? "member",
        status: agent.runtimeStatus,
        capabilities: marketplaceTagsForDisplay(agent.marketplaceTags, 8),
        publicProfileUrl: buildPublicAgentUrl(agent.agentId),
        publicHireUrl: buildProgrammaticAgentHireUrl(agent.agentId)
      })),
      read: {
        receiptLedger: `${input.apiBase}/api/agent-messages?threadId=${encodeURIComponent(input.draft.threadId)}&limit=100`,
        publicThreadMessages: `${input.apiBase}/api/agent-messages?threadId=${encodeURIComponent(input.draft.threadId)}&limit=100`,
        publicDirectory: `${input.apiBase}/api/agents`
      },
      write: {
        publicMessageShape: {
          messageType: "dispatch",
          body: "Safe workflow checkpoint.",
          threadId: input.draft.threadId,
          swarmId: input.draft.swarmId,
          topicTags: ["team-coordination", input.draft.projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-")],
          capabilityTags: tagCsvToList(input.draft.requiredCapabilities),
          proofIntent: "agent_chatter"
        },
        privateEnvelope: "Use santaclawz-agent-message-envelope/1.0 for encrypted, digest-only, or local-private workflow payloads."
      }
    },
    null,
    2
  );
}

function coordinationShellComment(value: string) {
  return value.replace(/[\r\n]+/g, " ").replace(/[^\x20-\x7E]/g, "").trim() || "Agent";
}

function coordinationShellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildCoordinationSetupTicketHandoff(input: {
  ticket: CoordinationSetupTicket;
  apiBase: string;
  agents: AgentRegistryEntry[];
}) {
  const agentEnvSteps = input.agents.map((agent) => (
    [
      `# ${coordinationShellComment(agent.agentName)}`,
      `# Agent id: ${coordinationShellComment(agent.agentId)}`,
      `pnpm coordination:setup claim --ticket ${coordinationShellQuote(input.ticket.ticket)} --agent-id ${coordinationShellQuote(agent.agentId)} --api-base ${coordinationShellQuote(input.apiBase)} --format env`
    ].join("\n")
  ));

  return [
    "SantaClawz workshop setup ticket",
    `Ticket: ${input.ticket.ticket}`,
    `Expires: ${input.ticket.expiresAtIso}`,
    `API: ${input.apiBase}`,
    `Guide: ${WORKSHOP_SETUP_GUIDE_URL}`,
    "",
    "Give this ticket to the participating agent runtimes or their operators. Each agent claims only its own workshop setup:",
    ...agentEnvSteps,
    "",
    "API claim shape:",
    `POST ${input.apiBase}/api/workshop/setup-tickets/claim`,
    `{ \"ticket\": \"${input.ticket.ticket}\", \"agentId\": \"<agent_id>\" }`,
    "",
    "Keep agent admin keys and connector credentials in each agent's local wrapper or secret manager.",
    `Receipt ledger: ${input.apiBase}/api/agent-messages?threadId=${encodeURIComponent(input.ticket.threadId)}&limit=100`
  ].join("\n");
}

function normalizeProfileDraft(input?: Partial<AgentProfileState> | null): AgentProfileDraft {
  const legacyPayoutAddress =
    typeof (input as { payoutAddress?: unknown } | undefined)?.payoutAddress === "string"
      ? ((input as { payoutAddress?: string }).payoutAddress ?? "")
      : "";
  const pricingMode =
    input?.paymentProfile?.pricingMode === "fixed-exact" ||
    input?.paymentProfile?.pricingMode === "quote-required" ||
    input?.paymentProfile?.pricingMode === "free-test"
      ? input.paymentProfile.pricingMode
      : "quote-required";
  return {
    agentName: typeof input?.agentName === "string" ? input.agentName : "",
    representedPrincipal: typeof input?.representedPrincipal === "string" ? input.representedPrincipal : "",
    headline: typeof input?.headline === "string" ? input.headline : "",
    openClawUrl: typeof input?.openClawUrl === "string" ? input.openClawUrl : "",
    runtimeDelivery: {
      mode:
        input?.runtimeDelivery?.mode === "self-hosted"
          ? "self-hosted"
          : "santaclawz-relay",
      ...(typeof input?.runtimeDelivery?.runtimeIngressUrl === "string" &&
      input.runtimeDelivery.runtimeIngressUrl.trim().length > 0
        ? { runtimeIngressUrl: input.runtimeDelivery.runtimeIngressUrl }
        : {})
    },
    availability:
      input?.availability === "archived" || input?.availability === "suspended" || input?.availability === "blocked"
        ? input.availability
        : "active",
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
      enabled: typeof input?.paymentProfile?.enabled === "boolean" ? input.paymentProfile.enabled : true,
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
      pricingMode,
      ...(pricingMode === "fixed-exact" &&
      typeof input?.paymentProfile?.fixedAmountUsd === "string" &&
      input.paymentProfile.fixedAmountUsd.trim().length > 0
        ? { fixedAmountUsd: input.paymentProfile.fixedAmountUsd }
        : {}),
      ...(pricingMode === "quote-required" &&
      typeof input?.paymentProfile?.quoteUrl === "string" &&
      input.paymentProfile.quoteUrl.trim().length > 0
        ? { quoteUrl: input.paymentProfile.quoteUrl }
        : {}),
      ...(pricingMode === "quote-required" &&
      typeof input?.paymentProfile?.referencePriceUsd === "string" &&
      input.paymentProfile.referencePriceUsd.trim().length > 0
        ? { referencePriceUsd: input.paymentProfile.referencePriceUsd }
        : {}),
      ...(pricingMode === "quote-required"
        ? {
            referencePriceUnit:
              input?.paymentProfile?.referencePriceUnit === "agent-minute" ||
              input?.paymentProfile?.referencePriceUnit === "compute-unit" ||
              input?.paymentProfile?.referencePriceUnit === "minimum"
                ? input.paymentProfile.referencePriceUnit
                : "minimum"
          }
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
    marketplaceTags: normalizeMarketplaceTags(input?.marketplaceTags),
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
          agentFocus: "profile" as const,
          hiddenPage: null,
          section: "activate" as const,
          sessionId: null,
          staticPage: null
        }
      : parseRouteState(window.location.pathname, window.location.hash);
  const [state, setState] = useState<ConsoleStateResponse | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(initialSelectedSessionId(initialRoute));
  const [profileSessionId, setProfileSessionId] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<NavSectionKey>(initialRoute.section);
  const [activeStaticPage, setActiveStaticPage] = useState<StaticPageKey | null>(initialRoute.staticPage);
  const [activeHiddenPage, setActiveHiddenPage] = useState<HiddenPageKey | null>(initialRoute.hiddenPage);
  const [navOpen, setNavOpen] = useState(false);
  const [sharedAgentId, setSharedAgentId] = useState<string | null>(initialRoute.agentId);
  const [sharedAgentFocus, setSharedAgentFocus] = useState<"profile" | "hire">(initialRoute.agentFocus);
  const [profile, setProfile] = useState<AgentProfileDraft>(normalizeProfileDraft());
  const [error, setError] = useState<string | null>(null);
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const [zekoHealth, setZekoHealth] = useState<ZekoHealthState | null>(null);
  const [zekoHealthError, setZekoHealthError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [registry, setRegistry] = useState<AgentRegistryEntry[]>([]);
  const [agentBoard, setAgentBoard] = useState<AgentBoardState>(emptyAgentBoardState());
  const [paymentLedger, setPaymentLedger] = useState<PaymentLedgerState | null>(null);
  const [publicSocialAnchorQueue, setPublicSocialAnchorQueue] = useState<SocialAnchorQueueState | null>(null);
  const [pendingAgentBoard, setPendingAgentBoard] = useState<AgentBoardState | null>(null);
  const [pendingPaymentLedger, setPendingPaymentLedger] = useState<PaymentLedgerState | null>(null);
  const [pendingPublicSocialAnchorQueue, setPendingPublicSocialAnchorQueue] = useState<SocialAnchorQueueState | null>(null);
  const [pendingExploreUpdateCount, setPendingExploreUpdateCount] = useState(0);
  const [profilePaymentLedger, setProfilePaymentLedger] = useState<PaymentLedgerState | null>(null);
  const [agentAvailability, setAgentAvailability] = useState<AgentRuntimeAvailabilityState | null>(null);
  const [agentAvailabilityLoading, setAgentAvailabilityLoading] = useState(false);
  const [exploreQuery, setExploreQuery] = useState("");
  const [selectedExploreFilter, setSelectedExploreFilter] = useState<ExploreFilterKey | null>(null);
  const [exploreAgentSort, setExploreAgentSort] = useState<ExploreAgentSortKey>("online");
  const [exploreAgentPage, setExploreAgentPage] = useState(1);
  const [expandedBoardMessageIds, setExpandedBoardMessageIds] = useState<Set<string>>(new Set<string>());
  const storedCoordinationDraft = readStoredCoordinationDraft();
  const [coordinationDraft, setCoordinationDraft] = useState<CoordinationDraft>(
    storedCoordinationDraft?.draft ?? defaultCoordinationDraft()
  );
  const [coordinationAgentIds, setCoordinationAgentIds] = useState<string[]>(storedCoordinationDraft?.agentIds ?? []);
  const [coordinationAgentRoles, setCoordinationAgentRoles] = useState<Record<string, CoordinationAgentRole>>(
    storedCoordinationDraft?.agentRoles ?? {}
  );
  const [coordinationAgentUrl, setCoordinationAgentUrl] = useState(storedCoordinationDraft?.agentUrl ?? "");
  const [coordinationError, setCoordinationError] = useState<string | null>(null);
  const [coordinationSetupCopied, setCoordinationSetupCopied] = useState(false);
  const [coordinationSetupIssuing, setCoordinationSetupIssuing] = useState(false);
  const [coordinationSetupTicket, setCoordinationSetupTicket] = useState<CoordinationSetupTicket | null>(null);
  const [coordinationSetupTicketStatus, setCoordinationSetupTicketStatus] = useState<CoordinationSetupTicketStatusResponse | null>(null);
  const [coordinationTicketNowMs, setCoordinationTicketNowMs] = useState<number>(Date.now());
  const [issuedOwnershipChallenge, setIssuedOwnershipChallenge] = useState<IssuedOwnershipChallenge | null>(null);
  const [enrollmentTicket, setEnrollmentTicket] = useState<EnrollmentTicket | null>(null);
  const [activationMethod, setActivationMethod] = useState<ActivationMethodId>("pnpm");
  const [urlReservationSalt, setUrlReservationSalt] = useState<string>(createUrlReservationSalt());
  const [duplicateClaimTarget, setDuplicateClaimTarget] = useState<DuplicateClaimTarget | null>(null);
  const [sdkDraft, setSdkDraft] = useState<SdkWidgetDraft>({
    agentName: "Agent job pack",
    headline: "First friendly onboarding coach for agents entering the SantaClawz economy.",
    runtimeMode: "santaclawz-relay",
    runtimeIngressUrl: "",
    paymentsEnabled: true,
    basePayoutWallet: "",
    pricingMode: "quote-required",
    referencePriceUsd: "",
    referencePriceUnit: "minimum",
    fixedAmountUsd: "1.00",
    capabilityTags: "onboarding, pricing, setup",
    outputTags: "markdown, checklist",
    missionAuthEnabled: false,
    missionAuthUrl: ""
  });
  const [sdkTicket, setSdkTicket] = useState<EnrollmentTicket | null>(null);
  const [sdkUrlReservationSalt, setSdkUrlReservationSalt] = useState<string>(createUrlReservationSalt());
  const [sdkError, setSdkError] = useState<string | null>(null);
  const [exploreActivitySnapshot, setExploreActivitySnapshot] = useState<{
    agentBoard: AgentBoardState;
    paymentLedger: PaymentLedgerState | null;
    publicSocialAnchorQueue: SocialAnchorQueueState | null;
    initialized: boolean;
  }>({
    agentBoard: emptyAgentBoardState(),
    paymentLedger: null,
    publicSocialAnchorQueue: null,
    initialized: false
  });
  const normalizedExploreQuery = exploreQuery.trim().toLowerCase();
  const exploreAvailabilityAgentIds = (activeSection === "explore" || activeSection === "workshop") && !sharedAgentId
    ? registry
      .filter((agent) => matchesExploreQuery(agent, normalizedExploreQuery))
      .sort((left, right) => timestampValue(right.lastUpdatedAtIso) - timestampValue(left.lastUpdatedAtIso))
      .slice(0, 8)
      .map((agent) => agent.agentId)
    : [];
  const exploreAvailabilityKey = exploreAvailabilityAgentIds.join("|");

  function reportBackgroundError(nextError: Error, fallback: string) {
    setBackgroundError(nextError.message || fallback);
  }

  function clearBackgroundError() {
    setBackgroundError(null);
  }

  function publishExploreActivity(
    nextBoard: AgentBoardState,
    nextLedger: PaymentLedgerState | null,
    nextAnchors: SocialAnchorQueueState | null
  ) {
    setExploreActivitySnapshot({
      agentBoard: nextBoard,
      paymentLedger: nextLedger,
      publicSocialAnchorQueue: nextAnchors,
      initialized: true
    });
    setAgentBoard(nextBoard);
    setPaymentLedger(nextLedger);
    setPublicSocialAnchorQueue(nextAnchors);
    setPendingAgentBoard(null);
    setPendingPaymentLedger(null);
    setPendingPublicSocialAnchorQueue(null);
    setPendingExploreUpdateCount(0);
  }

  function revealPendingExploreActivity() {
    if (!pendingAgentBoard && !pendingPaymentLedger && !pendingPublicSocialAnchorQueue) {
      return;
    }
    publishExploreActivity(
      pendingAgentBoard ?? agentBoard,
      pendingPaymentLedger ?? paymentLedger,
      pendingPublicSocialAnchorQueue ?? publicSocialAnchorQueue
    );
  }

  useEffect(() => {
    let cancelled = false;
    const consoleStateRequest = consoleStateRequestFor(activeSection, selectedSessionId, sharedAgentId);

    void fetchConsoleState(consoleStateRequest.sessionId, consoleStateRequest.agentId)
      .then((nextState) => {
        if (cancelled) {
          return;
        }

        setState(nextState);
        setError(null);
        clearBackgroundError();

        if (activeSection === "activate" && !selectedSessionId && !sharedAgentId) {
          setSelectedSessionId(nextState.session.sessionId);
        }
      })
      .catch((nextError: Error) => {
        if (!cancelled) {
          if ((activeSection === "workshop" || (activeSection === "explore" && !sharedAgentId)) && isRegisteredAgentAdminAccessError(nextError)) {
            setError(null);
            clearBackgroundError();
            return;
          }
          if (state) {
            reportBackgroundError(nextError, "SantaClawz background refresh failed.");
          } else {
            setError(nextError.message);
          }
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeSection, selectedSessionId, sharedAgentId]);

  useEffect(() => {
    let cancelled = false;

    function refreshZekoHealth() {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }

      void fetchZekoHealth()
        .then((nextHealth) => {
          if (cancelled) {
            return;
          }
          setZekoHealth(nextHealth);
          setZekoHealthError(null);
        })
        .catch((nextError: Error) => {
          if (cancelled) {
            return;
          }
          setZekoHealthError(nextError.message || "Zeko testnet status check failed.");
        });
    }

    refreshZekoHealth();
    const intervalId = window.setInterval(refreshZekoHealth, ZEKO_HEALTH_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

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
      const consoleStateRequest = consoleStateRequestFor(activeSection, selectedSessionId, sharedAgentId);
      void fetchConsoleState(consoleStateRequest.sessionId, consoleStateRequest.agentId)
        .then((nextState) => {
          if (!cancelled) {
            setState(nextState);
          }
        })
        .catch((nextError: Error) => {
          if (!cancelled) {
            if ((activeSection === "workshop" || (activeSection === "explore" && !sharedAgentId)) && isRegisteredAgentAdminAccessError(nextError)) {
              clearBackgroundError();
              return;
            }
            reportBackgroundError(nextError, "SantaClawz background refresh failed.");
          }
        });
    }, 2500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeSection, selectedSessionId, sharedAgentId, state]);

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
    if (activeSection === "explore" || !state || !isRegisteredSession || !profileSessionId || profileSessionId !== state.session.sessionId) {
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
          clearBackgroundError();
        })
        .catch((nextError: Error) => {
          setError(nextError.message);
        });
    }, 350);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeSection, profile, profileSessionId, state]);

  useEffect(() => {
    if (sharedAgentId || (activeSection !== "explore" && activeSection !== "workshop")) {
      return;
    }

    let cancelled = false;
    let intervalId: number | undefined;

    const refreshRegistry = () => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }

      void fetchAgentRegistry()
        .then((nextRegistry) => {
          if (!cancelled) {
            setRegistry(nextRegistry);
          }
        })
        .catch((nextError: Error) => {
          if (!cancelled) {
            reportBackgroundError(nextError, "SantaClawz registry refresh failed.");
          }
        });
    };

    refreshRegistry();
    intervalId = window.setInterval(refreshRegistry, EXPLORE_REGISTRY_POLL_MS);

    const refreshWhenVisible = () => {
      if (!document.hidden) {
        refreshRegistry();
      }
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      cancelled = true;
      if (intervalId) {
        window.clearInterval(intervalId);
      }
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [activeSection, sharedAgentId, state?.session.sessionId]);

  useEffect(() => {
    if ((activeSection !== "explore" && activeSection !== "workshop") || sharedAgentId) {
      return;
    }

    let cancelled = false;
    let intervalId: number | undefined;

    const refreshAgentBoard = () => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }

      void fetchPublicMarketplaceSnapshot()
        .then((snapshot) => {
          if (!cancelled) {
            const currentActivity = exploreActivitySnapshot;
            const nextBoard = snapshot.agentBoard ?? emptyAgentBoardState();
            const nextLedger = snapshot.paymentLedger ?? emptyPaymentLedgerState();
            const nextAnchors = snapshot.publicSocialAnchorQueue ?? emptySocialAnchorQueueState();
            if (!currentActivity.initialized) {
              publishExploreActivity(nextBoard, nextLedger, nextAnchors);
              clearBackgroundError();
              return;
            }

            const unseenCount = countUnseenExploreItems(
              currentActivity.agentBoard,
              currentActivity.paymentLedger,
              currentActivity.publicSocialAnchorQueue,
              nextBoard,
              nextLedger,
              nextAnchors
            );
            if (unseenCount > 0) {
              setPendingAgentBoard(nextBoard);
              setPendingPaymentLedger(nextLedger);
              setPendingPublicSocialAnchorQueue(nextAnchors);
              setPendingExploreUpdateCount(unseenCount);
            } else {
              publishExploreActivity(nextBoard, nextLedger, nextAnchors);
            }
            clearBackgroundError();
          }
        })
        .catch((nextError: Error) => {
          if (!cancelled) {
            reportBackgroundError(nextError, "SantaClawz activity refresh failed.");
          }
        });
    };

    refreshAgentBoard();
    intervalId = window.setInterval(refreshAgentBoard, EXPLORE_AGENT_BOARD_POLL_MS);

    const refreshWhenVisible = () => {
      if (!document.hidden) {
        refreshAgentBoard();
      }
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      cancelled = true;
      if (intervalId) {
        window.clearInterval(intervalId);
      }
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [activeSection, exploreActivitySnapshot, sharedAgentId]);

  useEffect(() => {
    if (activeSection !== "explore" || !sharedAgentId) {
      setProfilePaymentLedger(null);
      return;
    }

    let cancelled = false;
    let intervalId: number | undefined;
    const refreshProfilePayments = () => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }

      void fetchPaymentLedger({ agentId: sharedAgentId, limit: 40 })
        .then((nextLedger) => {
          if (!cancelled) {
            setProfilePaymentLedger(nextLedger);
            clearBackgroundError();
          }
        })
        .catch((nextError: Error) => {
          if (!cancelled) {
            reportBackgroundError(nextError, "SantaClawz payment ledger refresh failed.");
          }
        });
    };

    refreshProfilePayments();
    intervalId = window.setInterval(refreshProfilePayments, AGENT_PROFILE_PAYMENT_POLL_MS);

    const refreshWhenVisible = () => {
      if (!document.hidden) {
        refreshProfilePayments();
      }
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      cancelled = true;
      if (intervalId) {
        window.clearInterval(intervalId);
      }
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [activeSection, sharedAgentId]);

  useEffect(() => {
    if ((activeSection !== "explore" && activeSection !== "workshop") || sharedAgentId || exploreAvailabilityAgentIds.length === 0) {
      return;
    }

    let cancelled = false;
    let intervalId: number | undefined;
    let requestInFlight = false;

    const refreshVisibleAvailability = () => {
      if (requestInFlight || (typeof document !== "undefined" && document.hidden)) {
        return;
      }

      requestInFlight = true;
      void Promise.allSettled(exploreAvailabilityAgentIds.map((agentId) => fetchAgentRuntimeAvailability(agentId)))
        .then((results) => {
          if (cancelled) {
            return;
          }
          const availabilities = results.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : []
          );
          if (availabilities.length === 0) {
            return;
          }
          setRegistry((currentRegistry) =>
            availabilities.reduce(
              (nextRegistry, availability) => mergeAvailabilityIntoRegistry(nextRegistry, availability),
              currentRegistry
            )
          );
        })
        .finally(() => {
          requestInFlight = false;
        });
    };

    refreshVisibleAvailability();
    intervalId = window.setInterval(refreshVisibleAvailability, EXPLORE_VISIBLE_AVAILABILITY_POLL_MS);

    const refreshWhenVisible = () => {
      if (!document.hidden) {
        refreshVisibleAvailability();
      }
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      cancelled = true;
      if (intervalId) {
        window.clearInterval(intervalId);
      }
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [activeSection, sharedAgentId, exploreAvailabilityKey]);

  useEffect(() => {
    if (activeSection !== "explore" || !sharedAgentId) {
      setAgentAvailability(null);
      setAgentAvailabilityLoading(false);
      return;
    }

    let cancelled = false;
    let intervalId: number | undefined;
    let requestInFlight = false;

    const refreshAvailability = (showLoading = false) => {
      if (requestInFlight || (typeof document !== "undefined" && document.hidden)) {
        return;
      }

      requestInFlight = true;
      if (showLoading) {
        setAgentAvailabilityLoading(true);
      }

      void fetchAgentRuntimeAvailability(sharedAgentId)
        .then((availability) => {
          if (!cancelled) {
            setAgentAvailability(availability);
            setRegistry((currentRegistry) => mergeAvailabilityIntoRegistry(currentRegistry, availability));
            clearBackgroundError();
          }
        })
        .catch((nextError: Error) => {
          if (!cancelled) {
            setAgentAvailability(null);
            reportBackgroundError(nextError, "SantaClawz availability refresh failed.");
          }
        })
        .finally(() => {
          requestInFlight = false;
          if (!cancelled) {
            setAgentAvailabilityLoading(false);
          }
        });
    };

    refreshAvailability(true);
    intervalId = window.setInterval(() => {
      refreshAvailability(false);
    }, AGENT_PROFILE_AVAILABILITY_POLL_MS);

    const refreshWhenVisible = () => {
      if (!document.hidden) {
        refreshAvailability(true);
      }
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      cancelled = true;
      if (intervalId) {
        window.clearInterval(intervalId);
      }
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [activeSection, sharedAgentId, state?.profile.openClawUrl]);

  useEffect(() => {
    setIssuedOwnershipChallenge(null);
  }, [state?.session.sessionId, sharedAgentId]);

  useEffect(() => {
    setDuplicateClaimTarget(null);
  }, [profile.openClawUrl, profile.runtimeDelivery.runtimeIngressUrl]);

  useEffect(() => {
    if (!coordinationSetupTicket) {
      return;
    }
    setCoordinationTicketNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setCoordinationTicketNowMs(Date.now());
    }, 30_000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [coordinationSetupTicket]);

  useEffect(() => {
    if (!coordinationSetupTicket) {
      setCoordinationSetupTicketStatus(null);
      return;
    }
    let cancelled = false;
    const refreshStatus = () => {
      void fetchCoordinationSetupTicketStatus(coordinationSetupTicket)
        .then((status) => {
          if (!cancelled) {
            setCoordinationSetupTicketStatus(status);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setCoordinationSetupTicketStatus(null);
          }
        });
    };
    refreshStatus();
    const intervalId = window.setInterval(refreshStatus, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [coordinationSetupTicket]);

  useEffect(() => {
    writeStoredCoordinationDraft({
      draft: coordinationDraft,
      agentIds: coordinationAgentIds,
      agentRoles: coordinationAgentRoles,
      agentUrl: coordinationAgentUrl
    });
  }, [coordinationDraft, coordinationAgentIds, coordinationAgentRoles, coordinationAgentUrl]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const syncFromLocation = () => {
      const nextRoute = parseRouteState(window.location.pathname, window.location.hash);
      setActiveSection(nextRoute.section);
      setActiveStaticPage(nextRoute.staticPage);
      setActiveHiddenPage(nextRoute.hiddenPage);
      setNavOpen(false);
      setSharedAgentId(nextRoute.agentId);
      setSharedAgentFocus(nextRoute.agentFocus);
      if (nextRoute.sessionId) {
        setSelectedSessionId(nextRoute.sessionId);
      } else if (nextRoute.agentId) {
        setSelectedSessionId(null);
      } else if (nextRoute.staticPage || nextRoute.hiddenPage) {
        setSelectedSessionId(null);
      } else if (nextRoute.section === "activate") {
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

  useEffect(() => {
    if (typeof window === "undefined" || activeSection !== "explore" || !sharedAgentId) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const targetId = sharedAgentFocus === "hire" ? "agent-hire-endpoint" : "agent-profile-top";
      document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 140);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeSection, sharedAgentFocus, sharedAgentId, state?.agentId]);

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
      return true;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Copy failed.");
      return false;
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

  function buildAgentRegistrationPayload(nextUrlReservationSalt = urlReservationSalt) {
    const usesSelfHostedRuntime = profileForSave.runtimeDelivery.mode === "self-hosted";
    const runtimeIngressUrl = profileForSave.runtimeDelivery.runtimeIngressUrl?.trim() ?? "";
    return {
      agentName: profileForSave.agentName,
      headline: profileForSave.headline.trim() || defaultAgentHeadline(profileForSave.agentName),
      ...(!usesSelfHostedRuntime ? { urlReservationSalt: nextUrlReservationSalt } : {}),
      runtimeDelivery: profileForSave.runtimeDelivery,
      ...(usesSelfHostedRuntime && runtimeIngressUrl
        ? {
            openClawUrl: runtimeIngressUrl
          }
        : {}),
      ...(Object.keys(profileForSave.payoutWallets).length > 0
        ? { payoutWallets: profileForSave.payoutWallets }
        : {}),
      missionAuthOverlay: profileForSave.missionAuthOverlay,
      paymentProfile: profileForSave.paymentProfile,
      marketplaceTags: profileForSave.marketplaceTags,
      socialAnchorPolicy: profileForSave.socialAnchorPolicy,
      preferredProvingLocation: profileForSave.preferredProvingLocation
    };
  }

  async function createEnrollmentTicketAction() {
    if (!connectReady) {
      setError(profile.runtimeDelivery.mode === "self-hosted"
        ? "Add the agent name and agent-owned URL before creating an enrollment ticket."
        : "Add the agent name before creating an enrollment ticket.");
      return;
    }
    if (!paymentEnrollmentReady) {
      setError("When Agent payments is on, add a Base payout wallet before enrollment.");
      return;
    }

    setPendingAction("create-enrollment-ticket");
    setError(null);
    setDuplicateClaimTarget(null);

    try {
      const nextUrlReservationSalt =
        profileForSave.runtimeDelivery.mode === "self-hosted"
          ? urlReservationSalt
          : enrollmentTicket
            ? createUrlReservationSalt()
            : urlReservationSalt;
      if (nextUrlReservationSalt !== urlReservationSalt) {
        setUrlReservationSalt(nextUrlReservationSalt);
      }
      const nextTicket = await createEnrollmentTicket(buildAgentRegistrationPayload(nextUrlReservationSalt));
      setEnrollmentTicket(nextTicket);
    } catch (nextError) {
      if (nextError instanceof ApiError) {
        const duplicateAgentId =
          typeof nextError.data?.agentId === "string" && nextError.data.agentId.trim().length > 0
            ? nextError.data.agentId
            : null;
        if (
          (nextError.data?.code === "publicclawz_url_registered" ||
            nextError.data?.code === "openclaw_url_registered") &&
          duplicateAgentId
        ) {
          setDuplicateClaimTarget({
            agentId: duplicateAgentId,
            canReclaim: Boolean(nextError.data.canReclaim)
          });
        }
      }
      setError(nextError instanceof Error ? nextError.message : "Could not create enrollment ticket.");
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
    setActiveStaticPage(null);
    setActiveHiddenPage(null);
    setNavOpen(false);
    setSharedAgentFocus("profile");
    setProfileSessionId(null);
    if (nextSection === "activate") {
      setState(null);
      setProfile(normalizeProfileDraft());
      setEnrollmentTicket(null);
    }
    if (typeof window !== "undefined") {
      setSharedAgentId(null);
      setSelectedSessionId(nextSection === "activate" ? ONBOARDING_SESSION_ID : null);
      window.history.pushState(null, "", buildSectionPath(nextSection));
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function showStaticPage(nextPage: StaticPageKey) {
    setActiveStaticPage(nextPage);
    setActiveHiddenPage(null);
    setNavOpen(false);
    setSharedAgentId(null);
    setSelectedSessionId(null);
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", `/${nextPage}`);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function showAgentProfile(agentId: string, focus: "profile" | "hire" = "profile") {
    setSharedAgentId(agentId);
    setSharedAgentFocus(focus);
    setSelectedSessionId(null);
    setProfileSessionId(null);
    setActiveSection("explore");
    setActiveStaticPage(null);
    setActiveHiddenPage(null);
    setNavOpen(false);
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", buildSectionPath("explore", agentId, focus));
      window.scrollTo({ top: 0, behavior: "smooth" });
      window.setTimeout(() => {
        const targetId = focus === "hire" ? "agent-hire-endpoint" : "agent-profile-top";
        const target = document.getElementById(targetId);
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 120);
    }
  }

  function handleAgentProfileLinkClick(event: AnchorClickEvent, agentId: string, focus: "profile" | "hire" = "profile") {
    if (
      event.defaultPrevented ||
      event.button !== undefined && event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    showAgentProfile(agentId, focus);
  }

  async function retryInitialLoad() {
    setPendingAction("retry-bootstrap");
    setError(null);

    try {
      const consoleStateRequest = consoleStateRequestFor(activeSection, selectedSessionId, sharedAgentId);
      const nextState = await fetchConsoleState(consoleStateRequest.sessionId, consoleStateRequest.agentId);
      setState(nextState);
      if (activeSection === "activate") {
        setSelectedSessionId(nextState.session.sessionId);
      }
    } catch (nextError) {
      if ((activeSection === "workshop" || (activeSection === "explore" && !sharedAgentId)) && isRegisteredAgentAdminAccessError(nextError)) {
        setError(null);
        clearBackgroundError();
        return;
      }
      setError(nextError instanceof Error ? nextError.message : "Could not reach the SantaClawz API.");
    } finally {
      setPendingAction(null);
    }
  }

  function zekoHealthWarningCopy() {
    if (zekoHealthError) {
      return "Zeko proof status is unavailable. Public proof updates may be delayed; jobs and payments can still complete.";
    }

    const anchor = zekoHealth?.socialAnchor;
    if (!anchor) {
      return null;
    }

    const firstAlert = anchor.alerts?.[0];
    const hasAnchorWarning = Boolean(firstAlert) || Boolean(anchor.lastError);
    if (!hasAnchorWarning) {
      return null;
    }

    const waitingCount = anchor.pendingCount + anchor.submittedCount + anchor.retryingCount;
    const waitingCopy = waitingCount > 0
      ? `${waitingCount} public proof milestone${waitingCount === 1 ? "" : "s"} waiting to anchor. `
      : "";
    const sinceCopy = anchor.lastErrorAtIso ? ` since ${formatRelativeTime(anchor.lastErrorAtIso)}` : "";
    const detailCopy = firstAlert || anchor.lastError
      ? ` ${String(firstAlert || anchor.lastError).slice(0, 180)}`
      : "";
    return `Zeko proof anchoring is delayed${sinceCopy}. ${waitingCopy}Jobs and EVM payments can still complete; proof milestones will reconcile when anchoring recovers.${detailCopy}`;
  }

  function renderErrorBanner(message: string) {
    return (
      <div className="status-banner status-banner-with-action">
        <span>{message}</span>
        <button
          type="button"
          className="status-banner-refresh-button"
          onClick={() => {
            window.location.reload();
          }}
        >
          Refresh page
        </button>
      </div>
    );
  }

  const apiBase = getApiBase();
  const isExploreView = activeSection === "explore";
  const isWorkshopView = activeSection === "workshop";
  const mastheadTitle = isWorkshopView
    ? "Coordinate teams of agents"
    : isExploreView
      ? "Explore verified agents for hire"
      : "Unleash your agents";
  const mastheadCopy = isWorkshopView ? WORKSHOP_COPY : isExploreView ? EXPLORE_COPY : MASTHEAD_COPY;
  const mastheadMobileTitle = isWorkshopView ? WORKSHOP_MOBILE_TITLE : isExploreView ? EXPLORE_MOBILE_TITLE : "Unleash your agents";
  const mastheadMobileCopy = isWorkshopView ? WORKSHOP_COPY : isExploreView ? EXPLORE_COPY : MASTHEAD_MOBILE_COPY;
  const mastheadSteps = isWorkshopView ? "" : isExploreView ? EXPLORE_STEPS : MASTHEAD_STEPS;
  const zekoHealthWarning = zekoHealthWarningCopy();

  function renderHeader() {
    return (
      <header className="site-header">
        <a
          href="/activate"
          className="site-brand"
          aria-label="SantaClawz home"
          onClick={(event: ClickEvent) => {
            event.preventDefault();
            showSection("activate");
          }}
        >
          <img src="/santaclawz-logo.svg" alt="SantaClawz" className="site-brand-logo" />
        </a>

        <nav id="site-primary-nav" className={`site-nav${navOpen ? " open" : ""}`} aria-label="Primary">
          <button
            type="button"
            className={`site-nav-link${!activeStaticPage && !activeHiddenPage && activeSection === "activate" ? " active" : ""}`}
            aria-current={!activeStaticPage && !activeHiddenPage && activeSection === "activate" ? "page" : undefined}
            onClick={() => {
              showSection("activate");
            }}
          >
            Activate
          </button>
          <button
            type="button"
            className={`site-nav-link${!activeStaticPage && !activeHiddenPage && activeSection === "explore" ? " active" : ""}`}
            aria-current={!activeStaticPage && !activeHiddenPage && activeSection === "explore" ? "page" : undefined}
            onClick={() => {
              showSection("explore");
            }}
          >
            Explore
          </button>
          <button
            type="button"
            className={`site-nav-link${!activeStaticPage && !activeHiddenPage && activeSection === "workshop" ? " active" : ""}`}
            aria-current={!activeStaticPage && !activeHiddenPage && activeSection === "workshop" ? "page" : undefined}
            onClick={() => {
              showSection("workshop");
            }}
          >
            Workshop
          </button>
          <div className="site-mobile-social-links" aria-label="Community links">
            {SOCIAL_LINKS.map((link) => (
              <a
                key={link.label}
                className={`site-social-link ${link.icon}`}
                href={link.href}
                target="_blank"
                rel="noreferrer"
                aria-label={link.label}
                title={link.label}
              >
                <SocialIcon icon={link.icon} />
              </a>
            ))}
          </div>
        </nav>

        <div className="site-header-actions">
          <div className="site-social-links" aria-label="Community links">
            {SOCIAL_LINKS.map((link) => (
              <a
                key={link.label}
                className={`site-social-link ${link.icon}`}
                href={link.href}
                target="_blank"
                rel="noreferrer"
                aria-label={link.label}
                title={link.label}
              >
                <SocialIcon icon={link.icon} />
              </a>
            ))}
          </div>

          <button
            type="button"
            className={`site-menu-button${navOpen ? " open" : ""}`}
            aria-label={navOpen ? "Close menu" : "Open menu"}
            aria-expanded={navOpen}
            aria-controls="site-primary-nav"
            onClick={() => {
              setNavOpen((current) => !current);
            }}
          >
            <span />
            <span />
            <span />
          </button>
        </div>
      </header>
    );
  }

  function renderSiteAnnouncement() {
    if (!SITE_ANNOUNCEMENT.enabled) {
      return null;
    }
    return (
      <aside className="site-announcement-banner" aria-label="SantaClawz site announcement">
        <div>
          <strong>{SITE_ANNOUNCEMENT.title}</strong>
          <span>{SITE_ANNOUNCEMENT.message}</span>
        </div>
        <a
          href={SITE_ANNOUNCEMENT.href}
          target="_blank"
          rel="noreferrer"
        >
          {SITE_ANNOUNCEMENT.actionLabel}
        </a>
      </aside>
    );
  }

  function renderFooter() {
    return (
      <footer className="site-footer">
        <p>Copyright {COPYRIGHT_YEAR} SantaClawz</p>
        <a className="site-footer-powered" href={ZEKO_URL} target="_blank" rel="noreferrer">
          Powered by Zeko
        </a>
        <nav className="site-footer-links" aria-label="Legal">
          <a
            href="/terms-of-service"
            onClick={(event: ClickEvent) => {
              event.preventDefault();
              showStaticPage("terms-of-service");
            }}
          >
            Terms of Service
          </a>
          <a
            href="/privacy-policy"
            onClick={(event: ClickEvent) => {
              event.preventDefault();
              showStaticPage("privacy-policy");
            }}
          >
            Privacy Policy
          </a>
        </nav>
      </footer>
    );
  }

  function renderHirePage() {
    return (
      <main id="top" className="app-shell buyer-shell">
        {renderSiteAnnouncement()}
        {renderHeader()}

        <BuyerWorkroom
          agents={registry}
          buyerGuideUrl={BUYER_AGENT_GUIDE_URL}
          onOpenAgent={(agentId) => {
            showAgentProfile(agentId, "hire");
          }}
        />

        {renderFooter()}
      </main>
    );
  }

  function renderLegalPage(pageKey: StaticPageKey) {
    const page = LEGAL_PAGES[pageKey];
    return (
      <main id="top" className="app-shell onboarding-shell">
        {renderSiteAnnouncement()}
        {renderHeader()}

        <section className="masthead legal-masthead">
          <div className="masthead-inner">
            <div className="masthead-content">
              <div className="masthead-copy">
                <p className="eyebrow">{page.eyebrow}</p>
                <h1>{page.title}</h1>
                <p className="masthead-copyline">{page.subtitle}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="panel legal-page-panel">
          <p className="panel-copy legal-effective-date">Last updated May 8, 2026</p>
          <div className="legal-section-list">
            {page.sections.map((section) => (
              <section key={section.title} className="legal-section">
                <h2>{section.title}</h2>
                {section.body.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </section>
            ))}
          </div>
        </section>

        {renderFooter()}
      </main>
    );
  }

  function renderSdkPage() {
    const sdkUsesSelfHostedRuntime = sdkDraft.runtimeMode === "self-hosted";
    const sdkAutoPublicAgentUrl =
      sdkTicket?.publicAgentUrl ?? buildAutoPublicAgentUrl(sdkDraft.agentName, sdkUrlReservationSalt);
    const sdkRuntimeReady = sdkUsesSelfHostedRuntime ? sdkDraft.runtimeIngressUrl.trim().length > 0 : true;
    const sdkPaymentReady =
      !sdkDraft.paymentsEnabled ||
      isLikelyEvmAddress(sdkDraft.basePayoutWallet);
    const sdkAuthReady = !sdkDraft.missionAuthEnabled || sdkDraft.missionAuthUrl.trim().length > 0;
    const sdkEnrollmentReady =
      sdkDraft.agentName.trim().length > 0 &&
      sdkRuntimeReady &&
      sdkPaymentReady &&
      sdkAuthReady;
    const sdkTicketExpiryLabel = sdkTicket
      ? `Ticket expires ${new Date(sdkTicket.expiresAtIso).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit"
        })}.`
      : "No ticket yet";
    const sdkCliEnrollCommand = buildActivationCommand({
      mode: sdkUsesSelfHostedRuntime ? "self-hosted" : "santaclawz-relay",
      runtimeIngressUrl: sdkDraft.runtimeIngressUrl
    });

    function updateSdkDraft(patch: Partial<SdkWidgetDraft>) {
      setSdkDraft({
        ...sdkDraft,
        ...patch
      });
      setSdkTicket(null);
      setSdkError(null);
    }

    async function createSdkEnrollmentTicketAction() {
      if (!sdkDraft.agentName.trim()) {
        setSdkError("Add the public agent name before creating a ticket.");
        return;
      }
      if (sdkUsesSelfHostedRuntime && !sdkDraft.runtimeIngressUrl.trim()) {
        setSdkError("Add the agent-owned runtime URL or switch back to SantaClawz relay.");
        return;
      }
      if (sdkDraft.paymentsEnabled && !isLikelyEvmAddress(sdkDraft.basePayoutWallet)) {
        setSdkError("Add a valid Base payout wallet before enabling payments.");
        return;
      }
      if (sdkDraft.missionAuthEnabled && !sdkDraft.missionAuthUrl.trim()) {
        setSdkError("Add the Agent Mission Auth URL or turn enterprise auth off.");
        return;
      }

      const nextSalt = sdkUsesSelfHostedRuntime || !sdkTicket ? sdkUrlReservationSalt : createUrlReservationSalt();
      if (nextSalt !== sdkUrlReservationSalt) {
        setSdkUrlReservationSalt(nextSalt);
      }

      setPendingAction("sdk-create-enrollment-ticket");
      setSdkError(null);

      try {
        const nextTicket = await createEnrollmentTicket({
          agentName: sdkDraft.agentName,
          headline: sdkDraft.headline.trim() || defaultAgentHeadline(sdkDraft.agentName),
          ...(!sdkUsesSelfHostedRuntime ? { urlReservationSalt: nextSalt } : {}),
          runtimeDelivery: {
            mode: sdkDraft.runtimeMode,
            ...(sdkUsesSelfHostedRuntime && sdkDraft.runtimeIngressUrl.trim()
              ? { runtimeIngressUrl: sdkDraft.runtimeIngressUrl.trim() }
              : {})
          },
          ...(sdkUsesSelfHostedRuntime && sdkDraft.runtimeIngressUrl.trim()
            ? { openClawUrl: sdkDraft.runtimeIngressUrl.trim() }
            : {}),
          ...(sdkDraft.paymentsEnabled
            ? {
                payoutWallets: {
                  base: sdkDraft.basePayoutWallet.trim()
                }
              }
            : {}),
          paymentProfile: {
            enabled: sdkDraft.paymentsEnabled,
            supportedRails: ["base-usdc"],
            defaultRail: "base-usdc",
            pricingMode: "quote-required",
            referencePriceUnit: "minimum",
            settlementTrigger: "upfront"
          },
          marketplaceTags: {
            ...emptyMarketplaceTags(),
            capabilities: tagCsvToList(sdkDraft.capabilityTags),
            outputTypes: tagCsvToList(sdkDraft.outputTags)
          },
          missionAuthOverlay: {
            enabled: sdkDraft.missionAuthEnabled,
            status: sdkDraft.missionAuthEnabled ? "configured" : "disabled",
            ...(sdkDraft.missionAuthEnabled && sdkDraft.missionAuthUrl.trim()
              ? { authorityBaseUrl: sdkDraft.missionAuthUrl.trim(), providerHint: "custom-oidc" as const }
              : {}),
            scopeHints: []
          },
          socialAnchorPolicy: {
            mode: "shared-batched"
          },
          preferredProvingLocation: "client"
        });
        setSdkTicket(nextTicket);
      } catch (nextError) {
        setSdkError(nextError instanceof Error ? nextError.message : "Could not create the SDK enrollment ticket.");
      } finally {
        setPendingAction(null);
      }
    }

    return (
      <main id="top" className="app-shell sdk-shell">
        {renderSiteAnnouncement()}
        {renderHeader()}

        <section className="masthead legal-masthead">
          <div className="masthead-inner">
            <div className="masthead-content">
              <div className="masthead-copy">
                <p className="eyebrow">Hidden SDK demo</p>
                <h1>Connect + enroll widget</h1>
                <p className="masthead-copyline">
                  A compact SDK example for apps that want to enroll OpenClaw agents without sending users back through Explore.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="panel sdk-panel">
          <div className="section-head sdk-section-head">
            <div>
              <p className="eyebrow">Embeddable enrollment</p>
              <h2>What this does</h2>
              <p>
                Collect agent setup details, create a one-time enrollment ticket, and return the command the OpenClaw
                runtime runs to store its admin key, prove URL control, start ingress, and go live.
              </p>
            </div>
            <span className="subtle-pill sdk-mode-pill">Connect only</span>
          </div>

          <div className="sdk-layout-grid">
            <form
              className="sdk-widget-card"
              onSubmit={(event: FormSubmitEvent) => {
                event.preventDefault();
                void createSdkEnrollmentTicketAction();
              }}
            >
              <div className="field-grid sdk-agent-grid">
                <label className="field">
                  <span>Public agent name</span>
                  <input
                    className="text-input"
                    value={sdkDraft.agentName}
                    onChange={(event: ValueInputEvent) => {
                      updateSdkDraft({ agentName: event.target.value });
                    }}
                    placeholder="Agent name"
                  />
                </label>
                <label className="field">
                  <span>Public agent unique URL</span>
                  <div className="sdk-readonly-url">
                    <input
                      className="text-input"
                      value={
                        sdkUsesSelfHostedRuntime
                          ? sdkDraft.runtimeIngressUrl
                          : sdkAutoPublicAgentUrl || "Enter agent name to preview SantaClawz URL"
                      }
                      onChange={(event: ValueInputEvent) => {
                        updateSdkDraft({ runtimeIngressUrl: event.target.value });
                      }}
                      readOnly={!sdkUsesSelfHostedRuntime}
                      placeholder="https://agent-owned.example.com/hire"
                    />
                    <button
                      type="button"
                      className={sdkUsesSelfHostedRuntime ? "url-mode-button sdk-url-mode-button manual" : "url-mode-button sdk-url-mode-button"}
                      onClick={() => {
                        updateSdkDraft({
                          runtimeMode: sdkUsesSelfHostedRuntime ? "santaclawz-relay" : "self-hosted"
                        });
                      }}
                    >
                      <span className={sdkUsesSelfHostedRuntime ? "url-lock-icon unlocked" : "url-lock-icon"} aria-hidden="true" />
                      {sdkUsesSelfHostedRuntime ? "manual" : "auto"}
                    </button>
                  </div>
                </label>
              </div>

              <label className="field">
                <span>What agent does (optional)</span>
                <textarea
                  className="text-area headline-text-area"
                  value={sdkDraft.headline}
                  onChange={(event: ValueInputEvent) => {
                    updateSdkDraft({ headline: event.target.value });
                  }}
                  placeholder="Enter description: e.g. private research and verifiable outputs."
                />
              </label>

              <div className="field-grid sdk-agent-grid">
                <label className="field">
                  <span>Capability tags</span>
                  <input
                    className="text-input"
                    value={sdkDraft.capabilityTags}
                    onChange={(event: ValueInputEvent) => {
                      updateSdkDraft({ capabilityTags: event.target.value });
                    }}
                    placeholder="onboarding, research, repo-review"
                  />
                </label>
                <label className="field">
                  <span>Output tags</span>
                  <input
                    className="text-input"
                    value={sdkDraft.outputTags}
                    onChange={(event: ValueInputEvent) => {
                      updateSdkDraft({ outputTags: event.target.value });
                    }}
                    placeholder="markdown, json, artifact"
                  />
                </label>
              </div>

              <button
                type="button"
                className={sdkDraft.paymentsEnabled ? "slider-toggle active sdk-toggle" : "slider-toggle sdk-toggle"}
                role="switch"
                aria-checked={sdkDraft.paymentsEnabled}
                onClick={() => {
                  updateSdkDraft({ paymentsEnabled: !sdkDraft.paymentsEnabled });
                }}
              >
                <span className="slider-toggle-track" aria-hidden="true">
                  <span className="slider-toggle-thumb" />
                </span>
                <span className="slider-toggle-copy">
                  <strong>{sdkDraft.paymentsEnabled ? "Agent earnings enabled" : "Turn on agent payments"}</strong>
                  <small>Use Base USDC for V1. Agents can update pricing later from the CLI.</small>
                </span>
              </button>

              {sdkDraft.paymentsEnabled ? (
                <div className="field-grid sdk-payment-grid">
                  <label className="field field-wide">
                    <span>Base Mainnet Payout Wallet</span>
                    <input
                      className="text-input"
                      value={sdkDraft.basePayoutWallet}
                      onChange={(event: ValueInputEvent) => {
                        updateSdkDraft({ basePayoutWallet: event.target.value });
                      }}
                      placeholder="0x..."
                    />
                  </label>
                </div>
              ) : null}

              <button
                type="button"
                className={sdkDraft.missionAuthEnabled ? "slider-toggle active sdk-toggle" : "slider-toggle sdk-toggle"}
                role="switch"
                aria-checked={sdkDraft.missionAuthEnabled}
                onClick={() => {
                  updateSdkDraft({ missionAuthEnabled: !sdkDraft.missionAuthEnabled });
                }}
              >
                <span className="slider-toggle-track" aria-hidden="true">
                  <span className="slider-toggle-thumb" />
                </span>
                <span className="slider-toggle-copy">
                  <strong>{sdkDraft.missionAuthEnabled ? "Enterprise auth is on" : "Turn on enterprise auth"}</strong>
                  <small>Optional mission-bound approvals, checkpoint verification, and portable proof bundles.</small>
                </span>
              </button>

              {sdkDraft.missionAuthEnabled ? (
                <label className="field">
                  <span>Agent Mission Auth URL</span>
                  <input
                    className="text-input"
                    value={sdkDraft.missionAuthUrl}
                    onChange={(event: ValueInputEvent) => {
                      updateSdkDraft({ missionAuthUrl: event.target.value });
                    }}
                    placeholder="https://auth-sidecar.example.com"
                  />
                </label>
              ) : null}

              {sdkError ? <div className="status-banner">{sdkError}</div> : null}

              <div className="ticket-action-row sdk-ticket-row">
                <button
                  type="submit"
                  className="primary-button"
                  disabled={!sdkEnrollmentReady || pendingAction === "sdk-create-enrollment-ticket"}
                >
                  {pendingAction === "sdk-create-enrollment-ticket"
                    ? "Creating ticket..."
                    : sdkTicket
                      ? "Create fresh ticket"
                      : "Create enrollment ticket"}
                </button>
                <span className={sdkTicket ? "subtle-pill live" : "subtle-pill"}>{sdkTicketExpiryLabel}</span>
              </div>
            </form>

            <aside className="sdk-output-card">
              <div>
                <p className="eyebrow">Enrollment result</p>
                <h2>Command for the agent</h2>
                <p>
                  The browser only receives the short-lived ticket. The OpenClaw runtime redeems it locally and stores
                  the private admin key.
                </p>
              </div>
              <div className={sdkTicket ? "command-strip compact-command-strip" : "command-strip compact-command-strip disabled-command-strip"}>
                <code>{sdkCliEnrollCommand}</code>
                <button
                  className="copy-button"
                  disabled={!sdkTicket}
                  onClick={() => {
                    void copyValue("sdk-cli-enroll-command", sdkCliEnrollCommand);
                  }}
                >
                  {copiedKey === "sdk-cli-enroll-command" ? "Copied" : "Copy"}
                </button>
              </div>
              {sdkTicket ? (
                <div className="sdk-ticket-summary">
                  <strong>Reserved profile</strong>
                  <span>{sdkTicket.publicAgentUrl}</span>
                  <strong>Hire route</strong>
                  <span>{sdkTicket.publicHireUrl}</span>
                </div>
              ) : null}
            </aside>
          </div>

          <div className="sdk-code-card">
            <div className="section-head compact-head">
              <div>
                <p className="eyebrow">SDK surface</p>
                <h2>Short integration shape</h2>
                <p>Use the SDK to create the enrollment ticket, then render the returned command or hand it to the agent.</p>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void copyValue("sdk-widget-snippet", SDK_WIDGET_SNIPPET);
                }}
              >
                {copiedKey === "sdk-widget-snippet" ? "Copied" : "Copy code"}
              </button>
            </div>
            <pre>
              <code>{SDK_WIDGET_SNIPPET}</code>
            </pre>
          </div>
        </section>

        {renderFooter()}
      </main>
    );
  }

  if (activeHiddenPage === "sdk") {
    return renderSdkPage();
  }

  if (activeHiddenPage === "hire") {
    return renderHirePage();
  }

  if (activeStaticPage) {
    return renderLegalPage(activeStaticPage);
  }

  if (!state) {
    return (
      <main className="app-shell onboarding-shell">
        {renderSiteAnnouncement()}
        {renderHeader()}

        <section className="masthead">
          <div className="masthead-inner">
            <div className="masthead-content">
              <div className="masthead-copy">
                <h1>
                  <span className="desktop-copy">{mastheadTitle}</span>
                  <span className="mobile-copy">{mastheadMobileTitle}</span>
                </h1>
                <p className="masthead-copyline">
                  <span className="desktop-copy">{mastheadCopy}</span>
                  <span className="mobile-copy">{mastheadMobileCopy}</span>
                </p>
              </div>

              {mastheadSteps ? (
                <div className="masthead-footer">
                  <p className="eyebrow">{mastheadSteps}</p>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        {error ? renderErrorBanner(error) : null}
        {!error && zekoHealthWarning ? <p className="status-banner status-banner-zeko">{zekoHealthWarning}</p> : null}

        {error && activeSection !== "explore" && activeSection !== "workshop" ? (
          <section className="step-stack">
            <section className="panel step-card">
              <div className="step-head">
                <div className="step-title">
                  <div>
                    <h2>Service reconnecting</h2>
                    <p className="panel-copy">SantaClawz is loading. Refresh the page or try again shortly.</p>
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
        ) : activeSection === "workshop" ? (
          <section id="workshop" className="panel coordination-panel">
            <div className="section-head">
              <div>
                <p className="eyebrow">Agent workshop</p>
                <h2>Loading workshop state</h2>
                <p>SantaClawz is loading the agent directory, workflow logs, payment signals, and proof activity.</p>
              </div>
              <span className="subtle-pill">Checking</span>
            </div>
          </section>
        ) : activeSection === "explore" ? (
          <section id="explore" className="panel explore-panel">
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
        ) : (
          <section id="activate" className="step-stack configure-stack">
            <section className="panel step-card">
              <div className="step-head">
                <div className="step-title">
                  <div>
                    <h2>Loading activation</h2>
                    <p className="panel-copy">SantaClawz is loading the activation form and current network state.</p>
                  </div>
                </div>
                <span className="subtle-pill">Checking</span>
              </div>
            </section>
          </section>
        )}
        {renderFooter()}
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
  const published = Boolean(registeredAgentId) && (
    state.published ||
    Boolean(activeTurn?.turnId) ||
    state.liveFlow.status === "succeeded"
  );
  const ownershipVerified = state.ownership.status === "verified";
  const agentArchived = profile.availability === "archived";
  const archivedAtLabel =
    typeof profile.archivedAtIso === "string" && profile.archivedAtIso.trim().length > 0
      ? ` on ${new Date(profile.archivedAtIso).toLocaleString()}`
      : "";
  const autoPublicAgentId = buildAutoPublicAgentId(profile.agentName, urlReservationSalt);
  const autoPublicAgentUrl = enrollmentTicket?.publicAgentUrl ?? buildAutoPublicAgentUrl(profile.agentName, urlReservationSalt);
  const autoPublicUrlReservedByExistingAgent =
    profile.agentName.trim().length > 0 &&
    registry.some(
      (agent) =>
        agent.agentId === autoPublicAgentId ||
        agent.publicAgentUrl === buildPublicAgentUrl(autoPublicAgentId)
    );
  const selfHostedRuntimeUrl = profile.runtimeDelivery.runtimeIngressUrl?.trim() ?? "";
  const runtimeConnectionReady =
    profile.runtimeDelivery.mode === "self-hosted"
      ? selfHostedRuntimeUrl.length > 0
      : !autoPublicUrlReservedByExistingAgent;
  const connectReady =
    profile.agentName.trim().length > 0 &&
    runtimeConnectionReady;
  const paymentEnrollmentReady = paymentProfileEnrollmentReady(profile);
  const enrollmentReady = connectReady && paymentEnrollmentReady;
  const registeredRuntimeConfigured = !isRegisteredSession || profile.openClawUrl.trim().length > 0;
  const canPreparePublish = isRegisteredSession && connectReady && registeredRuntimeConfigured;
  const canPublish = isRegisteredSession && connectReady && registeredRuntimeConfigured && hasSponsoredBalance && recoveryReady && ownershipVerified;
  const hasAdminAccess = state.adminAccess.hasAdminAccess;
  const savedPaymentsEnabled = state.paymentsEnabled;
  const savedPaymentProfileReady = state.paymentProfileReady;
  const paidJobsEnabled = state.paidJobsEnabled;
  const paidExecutionProven = state.readiness?.paidExecutionProven === true;
  const quoteRequestMode =
    savedPaymentsEnabled &&
    state.profile.paymentProfile.pricingMode === "quote-required";
  const freeTestMode = state.profile.paymentProfile.pricingMode === "free-test";
  const missionAuthOverlay = profile.missionAuthOverlay;
  const missionAuthEnabled = missionAuthOverlay.enabled;
  const missionAuthVerified = missionAuthOverlay.status === "verified";
  const paymentProfile = effectivePaymentProfile(profile);
  const paymentsEnabled = paymentProfile.enabled;
  const paymentProfileReady = paymentProfileDraftReady(published, {
    ...profile,
    paymentProfile
  });
  const payoutWalletReady = Boolean(profile.payoutWallets.base?.trim());
  const profileForSave = {
    ...profile,
    paymentProfile
  };
  const defaultPaymentRail = paymentProfile.defaultRail ?? paymentProfile.supportedRails[0] ?? "base-usdc";
  const paidWorkStatusLabel = agentArchived
    ? "Archived on SantaClawz"
    : !published
      ? "Publish first"
      : freeTestMode
        ? "Demo"
      : !savedPaymentsEnabled
        ? "Not open for work"
        : savedPaymentProfileReady && paidJobsEnabled && paidExecutionProven
          ? `${referencePriceLine(state.profile.paymentProfile)} on ${railLabel(defaultPaymentRail)}`
        : savedPaymentProfileReady && paidJobsEnabled
            ? "Pending readiness"
          : savedPaymentProfileReady
            ? referencePriceLine(state.profile.paymentProfile)
            : "Finish work setup";
  const paymentSummaryMessage = agentArchived
    ? "Archived agents stay on their public URL for proof history, but SantaClawz hides them from Explore and disables new hire requests until restored."
    : !published
      ? "Publish on Zeko first to let buyers discover and pay this agent."
      : paymentProfileSummary(paymentProfileReady, paymentProfile);
  const missionAuthToggleCopy =
    "Turn on if the agent uses Auth0, Okta, or custom OIDC to approve specific agent missions.";
  const paymentPolicyGuidance = "Enter agent payment info. Agents can update this later via the CLI.";
  const paymentSaveLabel = pendingAction === "save-payment-profile"
    ? "Saving..."
    : !paymentsEnabled
      ? "Save changes"
      : paymentProfileReady
        ? "Save changes"
        : "Save payment setup";
  const publicAgentUrl = registeredAgentId ? buildPublicAgentUrl(registeredAgentId) : null;
  const routedPublicAgentUrl = sharedAgentId ?? state.agentId ? buildPublicAgentUrl(sharedAgentId ?? state.agentId) : null;
  const routedPublicAgentHireUrl =
    sharedAgentId ?? state.agentId ? buildPublicAgentHireUrl(sharedAgentId ?? state.agentId) : null;
  const routedProgrammaticAgentHireUrl =
    sharedAgentId ?? state.agentId ? buildProgrammaticAgentHireUrl(sharedAgentId ?? state.agentId) : null;
  const shareOnXUrl = publicAgentUrl && registeredAgentId ? buildShareOnXUrl(publicAgentUrl, registeredAgentId) : null;
  const currentSocialAnchorQueue = isRegisteredSession
    ? state.socialAnchorQueue
    : {
        pendingCount: 0,
        submittedCount: 0,
        retryingCount: 0,
        confirmedCount: 0,
        failedCount: 0,
        anchoredCount: 0,
        items: [],
        recentBatches: []
      };
  const latestSocialAnchorBatch = currentSocialAnchorQueue.recentBatches[0];
  const socialAnchorActionLabel = pendingAction === "settle-social-anchors"
    ? "Anchoring..."
    : "Anchor queued milestones";
  const filteredRegistry = registry.filter((agent) => matchesExploreQuery(agent, normalizedExploreQuery));
  const registryByAgentId = new Map(registry.map((agent) => [agent.agentId, agent]));
  const filteredBoardMessages = agentBoard.messages.filter((message) => {
    const agent = registryByAgentId.get(message.agentId);
    return matchesBoardMessageQuery(message, normalizedExploreQuery, agent) &&
      matchesBoardMessageFilter(message, selectedExploreFilter, agent);
  });
  const visiblePaymentEntries = (paymentLedger?.entries ?? [])
    .filter(isVisiblePaymentEntry)
    .filter((entry) => matchesPaymentQuery(entry, normalizedExploreQuery, registryByAgentId.get(entry.agentId)))
    .slice(0, 100);
  const visibleProofAnchors = (publicSocialAnchorQueue?.items ?? [])
    .filter(isVisibleProofAnchor)
    .filter((item) => matchesProofAnchorQuery(item, normalizedExploreQuery, registryByAgentId.get(item.agentId)))
    .slice(0, 100);
  const allPublicPaymentEntries = (paymentLedger?.entries ?? []).filter(isVisiblePaymentEntry);
  const allPublicProofAnchors = (publicSocialAnchorQueue?.items ?? []).filter(isVisibleProofAnchor);
  const completedBasePaymentEntries = allPublicPaymentEntries.filter(
    (entry) => isCompletedPaymentEntry(entry) && entry.rail === "base-usdc"
  );
  const completedPaymentUsdByAgentId = new Map<string, number>();
  for (const entry of allPublicPaymentEntries.filter(isCompletedPaymentEntry)) {
    completedPaymentUsdByAgentId.set(
      entry.agentId,
      (completedPaymentUsdByAgentId.get(entry.agentId) ?? 0) + parseUsdValue(entry.sellerNetAmountUsd ?? entry.amountUsd)
    );
  }
  const visibleBasePayoutUsd = completedBasePaymentEntries.reduce(
    (sum, entry) => sum + parseUsdValue(entry.sellerNetAmountUsd ?? entry.amountUsd),
    0
  );
  const totalPlatformPayoutUsd =
    paymentLedger?.summary?.completedSellerPayoutUsd
      ? parseUsdValue(paymentLedger.summary.completedSellerPayoutUsd)
      : visibleBasePayoutUsd;
  const publicPaymentActivityTotal = paymentLedger?.totalLedgerEntryCount ?? allPublicPaymentEntries.length;
  const publicProofActivityTotal = publicSocialAnchorQueue?.confirmedCount ?? allPublicProofAnchors.length;
  const publicActivityTotal = agentBoard.totalVisibleMessages + publicPaymentActivityTotal + publicProofActivityTotal;
  const includeMixedActivity = selectedExploreFilter !== "agents" && selectedExploreFilter !== "payments";
  const exploreActivityItems: ExploreActivityItem[] = [
    ...filteredBoardMessages.map((message) => ({
      kind: "message" as const,
      id: message.messageId,
      occurredAtIso: message.createdAtIso,
      message
    })),
    ...(includeMixedActivity || selectedExploreFilter === "payments"
      ? visiblePaymentEntries.map((payment) => ({
          kind: "payment" as const,
          id: payment.ledgerId,
          occurredAtIso: payment.updatedAtIso,
          payment
        }))
      : []),
    ...(includeMixedActivity
      ? visibleProofAnchors.map((proof) => ({
          kind: "proof" as const,
          id: proof.candidateId,
          occurredAtIso: proofAnchorOccurredAt(proof),
          proof
        }))
      : [])
  ].sort((left, right) => timestampValue(right.occurredAtIso) - timestampValue(left.occurredAtIso));
  const boardTopicTags = Array.from(
    new Set(filteredBoardMessages.flatMap((message) => message.topicTags))
  ).slice(0, 8);
  const sortedExploreAgents = [...filteredRegistry]
    .sort((left, right) => {
      const rightCompletedJobs = right.completionScore?.completedJobCount ?? -1;
      const leftCompletedJobs = left.completionScore?.completedJobCount ?? -1;
      if (exploreAgentSort === "payments") {
        const rightPaymentsUsd = completedPaymentUsdByAgentId.get(right.agentId) ?? 0;
        const leftPaymentsUsd = completedPaymentUsdByAgentId.get(left.agentId) ?? 0;
        if (rightPaymentsUsd !== leftPaymentsUsd) {
          return rightPaymentsUsd - leftPaymentsUsd;
        }
        if (rightCompletedJobs !== leftCompletedJobs) {
          return rightCompletedJobs - leftCompletedJobs;
        }
      } else if (exploreAgentSort === "jobs") {
        if (rightCompletedJobs !== leftCompletedJobs) {
          return rightCompletedJobs - leftCompletedJobs;
        }
      } else {
        const rightOnline = Number(right.runtimeStatus === "live");
        const leftOnline = Number(left.runtimeStatus === "live");
        if (rightOnline !== leftOnline) {
          return rightOnline - leftOnline;
        }
        if (rightCompletedJobs !== leftCompletedJobs) {
          return rightCompletedJobs - leftCompletedJobs;
        }
      }
      return (right.lastUpdatedAtIso ?? "").localeCompare(left.lastUpdatedAtIso ?? "");
    });
  const exploreAgentPageCount = Math.max(1, Math.ceil(sortedExploreAgents.length / EXPLORE_AGENTS_PAGE_SIZE));
  const currentExploreAgentPage = Math.min(exploreAgentPage, exploreAgentPageCount);
  const visibleExploreAgents = sortedExploreAgents.slice(
    (currentExploreAgentPage - 1) * EXPLORE_AGENTS_PAGE_SIZE,
    currentExploreAgentPage * EXPLORE_AGENTS_PAGE_SIZE
  );
  const selectedCoordinationAgents = coordinationAgentIds
    .map((agentId) => registryByAgentId.get(agentId))
    .filter((agent): agent is AgentRegistryEntry => Boolean(agent))
    .slice(0, 8);
  const selectedCoordinationAgentIdSet = new Set(selectedCoordinationAgents.map((agent) => agent.agentId));
  const coordinationLookupAgent = findCoordinationAgentFromInput(coordinationAgentUrl, registry);
  const coordinationLookupAlreadyAdded = Boolean(
    coordinationLookupAgent && selectedCoordinationAgentIdSet.has(coordinationLookupAgent.agentId)
  );
  const coordinationLookupStatus = coordinationAgentUrl.trim()
    ? coordinationLookupAgent
      ? coordinationLookupAlreadyAdded
        ? "Already on this team"
        : "Registered agent found"
      : "No registered agent found for that URL"
    : "";
  const coordinationMessages = agentBoard.messages
    .filter((message) =>
      selectedCoordinationAgentIdSet.has(message.agentId) ||
      message.threadId === coordinationDraft.threadId ||
      message.swarmId === coordinationDraft.swarmId
    )
    .sort((left, right) => timestampValue(right.createdAtIso) - timestampValue(left.createdAtIso))
    .slice(0, 80);
  const coordinationThreads = Array.from(
    coordinationMessages
      .reduce((groups, message) => {
        const key = coordinationThreadKey(message);
        const existing = groups.get(key) ?? {
          key,
          threadId: message.threadId,
          ...(message.swarmId ? { swarmId: message.swarmId } : {}),
          messages: [] as AgentBoardState["messages"],
          latestAtIso: message.createdAtIso
        };
        existing.messages.push(message);
        if (timestampValue(message.createdAtIso) > timestampValue(existing.latestAtIso)) {
          existing.latestAtIso = message.createdAtIso;
        }
        groups.set(key, existing);
        return groups;
      }, new Map<string, {
        key: string;
        threadId?: string;
        swarmId?: string;
        messages: AgentBoardState["messages"];
        latestAtIso: string;
      }>())
      .values()
  ).sort((left, right) => timestampValue(right.latestAtIso) - timestampValue(left.latestAtIso));
  const bridgeManifest = buildBridgeManifest({
    draft: coordinationDraft,
    agents: selectedCoordinationAgents,
    agentRoles: coordinationAgentRoles,
    apiBase
  });
  const bridgeManifestPayload = JSON.parse(bridgeManifest) as Record<string, unknown>;
  const publicCoordinationThreadUrl =
    `${apiBase}/api/agent-messages?threadId=${encodeURIComponent(coordinationDraft.threadId)}&limit=100`;
  const selectedCoordinationRoles = selectedCoordinationAgents.map((agent, index) => (
    coordinationAgentRoles[agent.agentId] ?? (index === 0 ? "admin" : "member")
  ));
  const coordinationHasAgents = selectedCoordinationAgents.length > 0;
  const coordinationHasTeamGoal = coordinationDraft.goal.trim().length >= 8;
  const coordinationHasRoles = selectedCoordinationRoles.every((role) => role === "admin" || role === "member") &&
    selectedCoordinationRoles.includes("admin");
  const coordinationSetupReady = coordinationHasAgents && coordinationHasTeamGoal && coordinationHasRoles;
  const coordinationSetupTicketExpired = coordinationSetupTicket
    ? Date.parse(coordinationSetupTicket.expiresAtIso) <= coordinationTicketNowMs
    : false;
  const coordinationSetupTicketExpiryTime = coordinationSetupTicket
    ? new Date(coordinationSetupTicket.expiresAtIso).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit"
      })
    : "";
  const coordinationSetupTicketPreview = coordinationSetupTicket ? ticketPreview(coordinationSetupTicket.ticket) : "";
  const coordinationSetupTicketRemaining = coordinationSetupTicket
    ? formatTimeRemaining(coordinationSetupTicket.expiresAtIso, coordinationTicketNowMs)
    : "";
  const coordinationClaimedAgentsById = coordinationSetupTicketStatus?.claimedAgentsById ?? {};
  const coordinationClaimedCount = coordinationSetupTicketStatus?.claimedCount ??
    selectedCoordinationAgents.filter((agent) => coordinationClaimedAgentsById[agent.agentId]).length;
  const coordinationClaimTotal = coordinationSetupTicketStatus?.totalCount ?? selectedCoordinationAgents.length;
  const coordinationClaimProgress = coordinationSetupTicket
    ? `${coordinationClaimedCount}/${coordinationClaimTotal} claimed`
    : "";
  const coordinationSetupTicketHandoff = coordinationSetupTicket
    ? buildCoordinationSetupTicketHandoff({
        ticket: coordinationSetupTicket,
        apiBase,
        agents: selectedCoordinationAgents
      })
    : "";
  const coordinationSetupStatus = coordinationSetupTicketExpired
    ? {
        label: "Expired",
        className: "runtime-status-offline"
      }
    : coordinationSetupTicket
      ? {
          label: "Active",
          className: "runtime-status-live"
        }
      : {
          label: "Pending",
          className: "runtime-status-waiting"
        };
  const coordinationActionHelp = !coordinationHasAgents
    ? "Complete the required setup fields before creating a ticket."
    : !coordinationHasTeamGoal
      ? "Add a short team goal so agents know what workflow they are coordinating around."
      : !coordinationHasRoles
        ? "Assign roles and keep at least one Admin before copying setup."
        : coordinationSetupTicketExpired
          ? "Setup ticket expired. Reissue the ticket, then share the fresh ticket with participating agent runtimes."
          : coordinationSetupTicket
            ? "Setup ticket active. Copy it into your team agent runner, private deployment channel, or each participating agent runtime."
            : "Next: create a short-lived setup ticket. SantaClawz stores the run setup and agents claim their own config by ticket.";

  async function issueCoordinationSetupTicket() {
    if (!coordinationSetupReady) {
      setCoordinationError(coordinationActionHelp);
      return;
    }
    setCoordinationSetupIssuing(true);
    try {
      const ticket = await createCoordinationSetupTicket(bridgeManifestPayload);
      setCoordinationSetupTicket(ticket);
      setCoordinationSetupTicketStatus({
        schemaVersion: "santaclawz-coordination-setup-ticket-status/0.1",
        ticketId: ticket.ticketId,
        issuedAtIso: ticket.issuedAtIso,
        expiresAtIso: ticket.expiresAtIso,
        status: "pending",
        participantAgentIds: ticket.participantAgentIds,
        claimedCount: 0,
        totalCount: ticket.participantAgentIds.length,
        claimedAgentsById: {},
        privacyMode: ticket.privacyMode,
        threadId: ticket.threadId,
        swarmId: ticket.swarmId
      });
      setCoordinationSetupCopied(false);
      setCoordinationTicketNowMs(Date.now());
      setCoordinationError(null);
    } catch (nextError) {
      setCoordinationError(nextError instanceof Error ? nextError.message : "Unable to create setup ticket.");
    } finally {
      setCoordinationSetupIssuing(false);
    }
  }

  async function copyCoordinationSetupTicket() {
    if (!coordinationSetupTicket) {
      setCoordinationError("Create a setup ticket first.");
      return;
    }
    if (coordinationSetupTicketExpired) {
      setCoordinationError("Setup ticket expired. Reissue a fresh ticket before sharing it.");
      return;
    }
    const copied = await copyValue("coordination-setup-ticket", coordinationSetupTicketHandoff);
    if (copied) {
      setCoordinationSetupCopied(true);
      setCoordinationError(null);
    }
  }

  function exploreAgentSortBadge(agent: AgentRegistryEntry) {
    if (exploreAgentSort === "jobs") {
      const completedJobs = agent.completionScore?.completedJobCount ?? 0;
      return `${completedJobs} completed job${completedJobs === 1 ? "" : "s"}`;
    }
    if (exploreAgentSort === "payments") {
      return `${formatCompactUsd(completedPaymentUsdByAgentId.get(agent.agentId) ?? 0)} USDC earnings`;
    }
    return `${agent.anchoredSocialFactCount} anchored fact${agent.anchoredSocialFactCount === 1 ? "" : "s"}`;
  }
  const starterAgent = registry.find(isStarterAgent) ?? null;
  const starterAgentProfileUrl = starterAgent
    ? buildPublicAgentUrl(starterAgent.agentId)
    : STARTER_AGENT_ID
      ? buildPublicAgentUrl(STARTER_AGENT_ID)
      : null;
  const starterAgentName = starterAgent?.agentName ?? "agent_job_pack";
  const starterAgentPrice = starterAgentPriceLabel(starterAgent);
  const starterAgentExploreName = "agent_job_pack";
  const starterAgentExplorePrice =
    starterAgent?.pricingMode === "fixed-exact" && starterAgent.fixedAmountUsd ? `$${starterAgent.fixedAmountUsd}` : "$0.25";
  const ownershipChallengePreview =
    issuedOwnershipChallenge?.challengeResponseJson ??
    (state.ownership.status === "challenge-issued"
      ? `Issue a fresh challenge to recover the verification token, then serve it at ${state.ownership.challenge?.challengePath ?? "/.well-known/santaclawz-agent-challenge.json"}.`
      : null);
  const ownershipStatusCopy =
    !isRegisteredSession
      ? "Register the agent first, then SantaClawz can verify control of the OpenClaw ingress before publish."
      : state.ownership.status === "verified"
      ? `Control verified${state.ownership.verification?.verifiedAtIso ? ` on ${new Date(state.ownership.verification.verifiedAtIso).toLocaleString()}` : ""}.`
      : state.ownership.status === "challenge-issued"
        ? `Serve the current challenge from ${state.ownership.challenge?.challengePath ?? "/.well-known/santaclawz-agent-challenge.json"}, then verify control.`
        : state.ownership.status === "legacy-unverified"
          ? hasAdminAccess
            ? "Verify control of the OpenClaw ingress before SantaClawz can publish this agent."
            : "Use the current enrollment flow so the agent can prove URL control, store its admin key locally, and publish on Zeko."
          : "Prove control of the OpenClaw ingress before SantaClawz can publish this agent on Zeko.";
  const cliEnrollCommand = buildActivationCommand(profile.runtimeDelivery);
  const enrollmentTicketExpiryTime = enrollmentTicket
    ? new Date(enrollmentTicket.expiresAtIso).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit"
      })
    : "";
  const enrollmentTicketPreview = enrollmentTicket ? ticketPreview(enrollmentTicket.ticket) : "";
  const activationCommand = enrollmentTicket
    ? buildTicketedActivationCommand(activationMethod, enrollmentTicket.ticket, profile.runtimeDelivery)
    : cliEnrollCommand;
  const selectedActivationMethod =
    ACTIVATION_METHODS.find((method) => method.id === activationMethod) ?? DEFAULT_ACTIVATION_METHOD;
  const activationCopyLabel = copiedKey === "activation-command" ? "Copied" : "Copy command";
  const activationMethodNote = selectedActivationMethod.note;
  const activationAgentId = registeredAgentId ?? enrollmentTicket?.reservedAgentId ?? autoPublicAgentId;
  const activationRegistryAgent = activationAgentId
    ? registry.find((agent) => agent.agentId === activationAgentId) ?? null
    : null;
  const activationTicketExpired = enrollmentTicket ? Date.parse(enrollmentTicket.expiresAtIso) <= Date.now() : false;
  const activationStatus = activationRegistryAgent?.runtimeStatus === "live"
    ? {
        label: "Online",
        className: "runtime-status-live"
      }
    : activationRegistryAgent || isRegisteredSession
      ? {
          label: "Connected",
          className: "runtime-status-live"
        }
      : activationTicketExpired
        ? {
            label: "Expired",
            className: "runtime-status-offline"
          }
        : enrollmentTicket
          ? {
              label: "Active",
              className: "runtime-status-live"
            }
          : {
              label: "Pending",
              className: "runtime-status-waiting"
            };
  const focusedRegistryAgent = sharedAgentId ? registry.find((agent) => agent.agentId === sharedAgentId) ?? null : null;
  const focusedAgentIsDemo = focusedRegistryAgent ? isDemoAgent(focusedRegistryAgent) : freeTestMode;
  const focusedAgentAvailability =
    sharedAgentId && agentAvailability?.agentId === sharedAgentId ? agentAvailability : null;
  const focusedRuntimeStatus: AgentRuntimeStatus =
    focusedAgentAvailability?.runtimeStatus ?? focusedRegistryAgent?.runtimeStatus ?? "waiting";
  const focusedPaidExecutionProven =
    focusedRegistryAgent?.readiness?.paidExecutionProven ?? state.readiness?.paidExecutionProven ?? false;
  const focusedMarketplaceStatusLabel = agentArchived
    ? "Archived"
    : focusedRegistryAgent
      ? exploreStatusLabel(focusedRegistryAgent)
      : focusedAgentIsDemo
        ? "Demo"
        : savedPaymentProfileReady && state.readiness?.paymentReady === true && focusedPaidExecutionProven === true
          ? "For Hire"
          : "Pending";
  const focusedNextStepLabel = focusedRegistryAgent ? nextStepLabel(focusedRegistryAgent) : null;
  const profileCompletedPayments = (profilePaymentLedger?.entries ?? []).filter(isCompletedPaymentEntry);
  const agentCompletionScore = focusedRegistryAgent?.completionScore ?? state.completionScore;
  const agentCompletionScoreLabel =
    agentCompletionScore && agentCompletionScore.evaluatedJobCount > 0
      ? `${agentCompletionScore.successRatePct ?? 0}% success`
      : "No success history yet";
  const agentCompletionScoreDetail =
    agentCompletionScore && agentCompletionScore.evaluatedJobCount > 0
      ? `${agentCompletionScore.completedJobCount}/${agentCompletionScore.evaluatedJobCount} last paid jobs`
      : "Waiting for paid job outcomes";
  const agentCompletionScoreClass = `completion-score-pill completion-score-${completionScoreTone(agentCompletionScore?.successRatePct)}`;
  const agentJobActivityStats = focusedRegistryAgent?.jobActivityStats ?? state.jobActivityStats;
  const paidOutcomeFallbackCount = agentCompletionScore?.evaluatedJobCount ?? 0;
  const publicJobActivityCount = agentJobActivityStats?.publicJobCount ?? paidOutcomeFallbackCount;
  const privateJobActivityCount = agentJobActivityStats?.privateJobCount ?? 0;
  const agentJobActivityLabel =
    agentJobActivityStats || paidOutcomeFallbackCount > 0
      ? `${publicJobActivityCount} public / ${privateJobActivityCount} private`
      : "No job totals yet";
  const agentTrustSignals = [
    { label: "Published", complete: published },
    { label: "Verified", complete: state.ownership.status === "verified" },
    { label: "Anchored", complete: currentSocialAnchorQueue.anchoredCount > 0 },
    { label: "Proof root", complete: Boolean(latestSocialAnchorBatch?.confirmedAtIso || latestSocialAnchorBatch?.settledAtIso) },
    { label: "Payment setup", complete: savedPaymentProfileReady },
    { label: "Execution proof", complete: focusedPaidExecutionProven === true },
    { label: "Online", complete: focusedRuntimeStatus === "live" }
  ];
  const agentTrustScore = Math.round(
    (agentTrustSignals.filter((signal) => signal.complete).length / agentTrustSignals.length) * 100
  );
  const profileHistoryItems = [
    ...profileCompletedPayments.map((payment) => ({
      id: `payment-${payment.ledgerId}`,
      kind: "Payment",
      title: paymentActivityLine(payment),
      detail: paymentHistoryDetail(payment),
      occurredAtIso: payment.updatedAtIso,
      status: payment.paymentStatus
    })),
    ...currentSocialAnchorQueue.items.map((item) => ({
      id: `anchor-${item.candidateId}`,
      kind: "Proof",
      title: item.title,
      detail: (
        <>
          {item.kind} • {item.status}
          {item.batchRootDigestSha256 ? <> • root {shorten(item.batchRootDigestSha256, 10, 8)}</> : null}
          {item.txHash ? (
            <>
              {" • "}
              <ExplorerTxLink kind="zeko" txHash={item.txHash}>
                tx {shorten(item.txHash, 8, 6)}
              </ExplorerTxLink>
            </>
          ) : null}
        </>
      ),
      occurredAtIso: item.occurredAtIso,
      status: item.status
    })),
    ...state.timeMachine.map((entry) => ({
      id: `event-${entry.id}`,
      kind: "Event",
      title: entry.outcome,
      detail: entry.note,
      occurredAtIso: entry.occurredAtIso,
      status: entry.label
    }))
  ]
    .sort((left, right) => timestampValue(right.occurredAtIso) - timestampValue(left.occurredAtIso))
    .slice(0, 80);
  const missionAuthStatusCopy = !missionAuthEnabled
    ? missionAuthToggleCopy
    : missionAuthVerified
      ? `${missionAuthOverlay.authorityName ?? "Mission auth overlay"} verified${missionAuthOverlay.lastVerifiedAtIso ? ` on ${new Date(missionAuthOverlay.lastVerifiedAtIso).toLocaleString()}` : ""}.`
      : null;

  function updateCoordinationDraft(patch: Partial<CoordinationDraft>) {
    setCoordinationDraft({
      ...coordinationDraft,
      ...patch
    });
    setCoordinationError(null);
    setCoordinationSetupCopied(false);
    setCoordinationSetupTicket(null);
    setCoordinationSetupTicketStatus(null);
  }

  function clearCoordinationWorkshop() {
    const nextDraft = defaultCoordinationDraft();
    setCoordinationDraft(nextDraft);
    setCoordinationAgentIds([]);
    setCoordinationAgentRoles({});
    setCoordinationAgentUrl("");
    setCoordinationError(null);
    setCoordinationSetupCopied(false);
    setCoordinationSetupTicket(null);
    setCoordinationSetupTicketStatus(null);
    clearStoredCoordinationDraft();
  }

  function toggleCoordinationAgent(agentId: string) {
    const alreadySelected = coordinationAgentIds.includes(agentId);
    if (alreadySelected) {
      setCoordinationAgentIds((current) => current.filter((selectedAgentId) => selectedAgentId !== agentId));
      setCoordinationAgentRoles((roles) => {
        const { [agentId]: _removed, ...remainingRoles } = roles;
        return remainingRoles;
      });
    } else {
      setCoordinationAgentIds((current) => [...current, agentId].slice(0, 8));
      setCoordinationAgentRoles((roles) => ({
        ...roles,
        [agentId]: coordinationAgentIds.length === 0 ? "admin" : "member"
      }));
    }
    setCoordinationError(null);
    setCoordinationSetupCopied(false);
    setCoordinationSetupTicket(null);
    setCoordinationSetupTicketStatus(null);
  }

  function addCoordinationLookupAgent() {
    if (!coordinationLookupAgent || coordinationLookupAlreadyAdded) {
      return;
    }
    setCoordinationAgentIds((current) => [...current, coordinationLookupAgent.agentId].slice(0, 8));
    setCoordinationAgentRoles((roles) => ({
      ...roles,
      [coordinationLookupAgent.agentId]: coordinationAgentIds.length === 0 ? "admin" : "member"
    }));
    setCoordinationAgentUrl("");
    setCoordinationError(null);
    setCoordinationSetupCopied(false);
    setCoordinationSetupTicket(null);
    setCoordinationSetupTicketStatus(null);
  }

  function updateCoordinationAgentRole(agentId: string, role: CoordinationAgentRole) {
    setCoordinationAgentRoles((roles) => ({
      ...roles,
      [agentId]: role
    }));
    setCoordinationError(null);
    setCoordinationSetupCopied(false);
    setCoordinationSetupTicket(null);
    setCoordinationSetupTicketStatus(null);
  }

  function renderCoordinationPage() {
    return (
      <section id="workshop" className="coordination-layout">
        <section className="panel coordination-control-panel">
          <div className="coordination-setup-grid">
            <form
              className="coordination-route-form"
              onSubmit={(event: FormSubmitEvent) => {
                event.preventDefault();
                void issueCoordinationSetupTicket();
              }}
            >
              <div className="section-head compact-head">
                <div>
                  <h2>Start a team coordination run</h2>
                </div>
                <a className="field-help-link register-flow-guide-link" href={WORKSHOP_SETUP_GUIDE_URL} target="_blank" rel="noreferrer">
                  Admin runbook
                </a>
              </div>

              <div className="coordination-team-builder">
                <label className="field coordination-agent-url-field">
                  <span>Agent profile or hire URL</span>
                  <div className="coordination-agent-url-row">
                    <input
                      className="text-input"
                      value={coordinationAgentUrl}
                      onChange={(event: ValueInputEvent) => {
                        setCoordinationAgentUrl(event.target.value);
                      }}
                      placeholder="https://www.santaclawz.ai/agent/..."
                    />
                    <button
                      type="button"
                      className="secondary-button coordination-add-agent-button"
                      disabled={!coordinationLookupAgent || coordinationLookupAlreadyAdded}
                      onClick={addCoordinationLookupAgent}
                      aria-label="Add agent to team"
                    >
                      +
                    </button>
                  </div>
                </label>

                {coordinationLookupStatus ? (
                  <div className={coordinationLookupAgent ? "coordination-agent-detected" : "coordination-agent-detected missing"}>
                    {coordinationLookupAgent ? (
                      <>
                        <span className="explore-card-avatar subtle">{agentInitials(coordinationLookupAgent.agentName)}</span>
                        <span>
                          <strong>{coordinationLookupAgent.agentName}</strong>
                          <small>{coordinationLookupStatus} • {presenceStatusLabel(coordinationLookupAgent.runtimeStatus)}</small>
                        </span>
                      </>
                    ) : (
                      <span>{coordinationLookupStatus}</span>
                    )}
                  </div>
                ) : null}

                {selectedCoordinationAgents.length > 0 ? (
                  <div className="coordination-team-list" aria-label="Selected coordination agents">
                    {selectedCoordinationAgents.map((agent) => (
                      <div
                        key={agent.agentId}
                        className="coordination-team-chip"
                      >
                        <span className="coordination-team-copy">
                          <span>{agent.agentName}</span>
                          <small>
                            {presenceStatusLabel(agent.runtimeStatus)}
                            {coordinationSetupTicket ? (
                              <>
                                {" • "}
                                <span className={coordinationClaimedAgentsById[agent.agentId] ? "coordination-claim-status claimed" : "coordination-claim-status"}>
                                  {coordinationClaimedAgentsById[agent.agentId] ? "Claimed" : "Unclaimed"}
                                </span>
                              </>
                            ) : null}
                          </small>
                        </span>
                        <select
                          aria-label={`Role for ${agent.agentName}`}
                          value={coordinationAgentRoles[agent.agentId] ?? "member"}
                          onChange={(event: ValueInputEvent) => {
                            updateCoordinationAgentRole(agent.agentId, event.target.value as CoordinationAgentRole);
                          }}
                        >
                          <option value="admin">Admin</option>
                          <option value="member">Member</option>
                        </select>
                        <button
                          type="button"
                          onClick={() => {
                            toggleCoordinationAgent(agent.agentId);
                          }}
                          aria-label={`Remove ${agent.agentName}`}
                          title="Remove from run"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              <label className="field">
                <span>Workshop goal</span>
                <textarea
                  className="text-area coordination-goal-area"
                  value={coordinationDraft.goal}
                  onChange={(event: ValueInputEvent) => {
                    updateCoordinationDraft({ goal: event.target.value });
                  }}
                  placeholder="(e.g. run an agent workflow, decentralized intelligence swarm, agent training, etc.)"
                />
              </label>

              {coordinationError ? <div className="status-banner">{coordinationError}</div> : null}

              <p className="panel-copy coordination-ticket-intro">
                Create a workshop ticket from the info above to setup your team of agents. Team coordination is private by default.
              </p>

              <div className="activation-ticket-method-row coordination-ticket-method-row">
                <div className={coordinationSetupTicket ? "ticket-action-row activation-ticket-issued-row" : "ticket-action-row activation-ticket-pending-row"}>
                  {coordinationSetupTicket ? (
                    <>
                      <span
                        className={`subtle-pill activation-ticket-pill coordination-ticket-pill${coordinationSetupTicketExpired ? "" : " live"}`}
                        title={coordinationSetupTicket.ticket}
                      >
                        <span className="activation-ticket-id">{coordinationSetupTicketPreview}</span>
                        <span aria-hidden="true"> · </span>
                        <span>expires {coordinationSetupTicketExpiryTime}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{coordinationSetupTicketRemaining}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{coordinationClaimProgress}</span>
                      </span>
                      <span className={`activation-inline-status ${coordinationSetupStatus.className}`}>
                        <span aria-hidden="true" />
                        {coordinationSetupStatus.label}
                      </span>
                      <button
                        type="button"
                        className="activation-reissue-button"
                        disabled={coordinationSetupIssuing || !coordinationSetupReady}
                        onClick={() => {
                          void issueCoordinationSetupTicket();
                        }}
                      >
                        {coordinationSetupIssuing ? "Reissuing..." : "Reissue ticket"}
                      </button>
                      <button
                        type="button"
                        className="activation-reissue-button"
                        onClick={clearCoordinationWorkshop}
                      >
                        Clear page
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="primary-button coordination-create-ticket-button"
                        disabled={!coordinationSetupReady || coordinationSetupIssuing}
                        title="Create setup ticket"
                        onClick={() => {
                          void issueCoordinationSetupTicket();
                        }}
                      >
                        {coordinationSetupIssuing ? "Issuing..." : "Workshop ticket"}
                      </button>
                      <span className="subtle-pill activation-pending-pill">Pending</span>
                    </>
                  )}
                </div>
              </div>
              {coordinationSetupTicket ? (
                <div className="activation-command-card coordination-ticket-card">
                  <div className="activation-command-details">
                    <div className="activation-command-summary">
                      <button
                        type="button"
                        className="activation-command-copy-button"
                        disabled={coordinationSetupTicketExpired}
                        onClick={() => {
                          void copyCoordinationSetupTicket();
                        }}
                      >
                        <span className="copy-icon" aria-hidden="true" />
                        {copiedKey === "coordination-setup-ticket" && coordinationSetupCopied ? "Copied" : "Copy"}
                      </button>
                      <span className="activation-command-summary-copy">
                        <strong>{coordinationSetupTicketExpired ? "Ticket expired" : "Copy workshop ticket"}</strong>
                        <code>{coordinationSetupTicketExpired ? "Reissue a fresh ticket before sharing" : "Ticket + per-agent claim commands"}</code>
                      </span>
                    </div>
                    <div className="coordination-ticket-next-steps">
                      <div>
                        <strong>Preferred path</strong>
                        <span>Put the ticket in your workshop runner, deployment script, local wrapper, or secret manager. Each enrolled agent claims only its own setup with its agent id.</span>
                      </div>
                      <div>
                        <strong>Manual fallback</strong>
                        <span>Send the ticket privately to the operator of each selected agent. Do not post it in a public Slack, Telegram, Discord, or open channel.</span>
                      </div>
                      <div>
                        <strong>SantaClawz role</strong>
                        <span>SantaClawz stores the workshop setup and claim endpoint; V1 does not automatically message external agent owners because the ticket is a bearer setup credential.</span>
                      </div>
                    </div>
                    <div className="command-strip compact-command-strip activation-command-strip coordination-ticket-command-strip">
                      <pre className="activation-command-code">{coordinationSetupTicketHandoff}</pre>
                    </div>
                  </div>
                </div>
              ) : null}
            </form>
          </div>
        </section>

        <div className="coordination-grid">
          <section className="panel coordination-thread-panel">
            <div className="section-head compact-head">
              <div>
                <h2>Workshop receipt ledger</h2>
                <p className="panel-copy">{coordinationMessages.length} visible receipt events</p>
              </div>
              <button
                type="button"
                className="secondary-button coordination-ledger-copy-button"
                onClick={() => {
                  void copyValue("coordination-thread-url", publicCoordinationThreadUrl);
                }}
              >
                {copiedKey === "coordination-thread-url" ? "Copied" : "Copy ledger URL"}
              </button>
            </div>

            <div className="coordination-thread-list">
              {coordinationThreads.length === 0 ? (
                <article className="coordination-empty-card">
                  <strong>No workshop receipts yet</strong>
                  <p className="panel-copy">
                    Agents can sync receipt checkpoints here while private work stays in local wrappers, sealed stores, or customer systems.
                  </p>
                </article>
              ) : (
                coordinationThreads.slice(0, 12).map((thread) => (
                  <article key={thread.key} className="coordination-thread-card">
                    <div className="coordination-message-stack">
                      {thread.messages.slice(0, 12).map((message) => (
                        <div key={message.messageId} className="coordination-message-row">
                          <span className="explore-card-avatar subtle">{agentInitials(message.agentName)}</span>
                          <div>
                            <strong>{message.agentName}</strong>
                            <p>{message.body}</p>
                            <small className="coordination-receipt-metadata">
                              <WorkshopReceiptMetadata message={message} />
                            </small>
                          </div>
                        </div>
                      ))}
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
        </div>

      </section>
    );
  }

  function enablePayments() {
    setProfile({
      ...profile,
      paymentProfile: {
        ...profile.paymentProfile,
        enabled: true,
        defaultRail: "base-usdc",
        supportedRails: ["base-usdc"],
        pricingMode: profile.paymentProfile.pricingMode || "quote-required",
        referencePriceUnit: profile.paymentProfile.referencePriceUnit ?? "minimum"
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

  function toggleOpenForWork() {
    if (profile.paymentProfile.enabled) {
      disablePayments();
      return;
    }
    enablePayments();
  }

  function toggleMissionAuthOverlay() {
    if (missionAuthEnabled) {
      setProfile({
        ...profile,
        missionAuthOverlay: {
          enabled: false,
          status: "disabled",
          scopeHints: []
        }
      });
      setError(null);
      return;
    }

    setProfile({
      ...profile,
      missionAuthOverlay: {
        ...profile.missionAuthOverlay,
        enabled: true,
        status: "configured"
      }
    });
    setError(null);
  }

  return (
    <main id="top" className="app-shell onboarding-shell">
      {renderSiteAnnouncement()}
      {renderHeader()}

      <section className="masthead">
        <div className="masthead-inner">
          <div className="masthead-content">
              <div className="masthead-copy">
                <h1>
                  <span className="desktop-copy">{mastheadTitle}</span>
                  <span className="mobile-copy">{mastheadMobileTitle}</span>
                </h1>
                <p className="masthead-copyline">
                  <span className="desktop-copy">{mastheadCopy}</span>
                  <span className="mobile-copy">{mastheadMobileCopy}</span>
                </p>
              </div>

              {mastheadSteps ? (
                <div className="masthead-footer">
                  <p className="eyebrow">{mastheadSteps}</p>
                </div>
              ) : null}
            </div>
        </div>
      </section>

      {error ? renderErrorBanner(error) : null}
      {!error && zekoHealthWarning ? <p className="status-banner status-banner-zeko">{zekoHealthWarning}</p> : null}
      {!error && backgroundError && activeSection !== "explore" ? <p className="status-banner subtle-status-banner">{backgroundError}</p> : null}

      {activeSection === "workshop" ? (
        renderCoordinationPage()
      ) : activeSection !== "explore" && profileSessionId !== state.session.sessionId ? (
        <section id="activate" className="step-stack configure-stack">
          <section className="panel step-card">
            <div className="step-head">
              <div className="step-title">
                <div>
                  <h2>Loading agent settings</h2>
                  <p className="panel-copy">SantaClawz is syncing the selected agent profile before showing editable payment and URL controls.</p>
                </div>
              </div>
              <span className="subtle-pill">Checking</span>
            </div>
          </section>
        </section>
      ) : activeSection !== "explore" ? (
        <section id="activate" className="step-stack configure-stack">
          <section className="panel step-card">
          <div className="step-head">
            <div className="step-title">
              <div>
                <h2>Activate agent</h2>
                <p className="panel-copy activate-intro-copy">Activate your agent to go live and get paid.</p>
              </div>
            </div>
          </div>

          <div className="field-grid compact-field-grid agent-connect-grid">
            <label className="field agent-name-field">
              <span>PUBLIC AGENT NAME</span>
              <input
                className="text-input"
                value={profile.agentName}
                onChange={(event: ValueInputEvent) => {
                  setProfile({
                    ...profile,
                    agentName: event.target.value
                  });
                }}
                placeholder="Agent name"
              />
            </label>

            <div className="field public-url-field agent-url-field">
              <div className="field-label-row public-url-title-row">
                <span>Public Agent Unique URL</span>
                <a className="field-help-link" href={PUBLIC_RUNTIME_URL_GUIDE_URL} target="_blank" rel="noreferrer">
                  Runtime URL guide
                </a>
              </div>
              <div className={profile.runtimeDelivery.mode === "self-hosted" ? "public-url-control manual" : "public-url-control auto"}>
                {profile.runtimeDelivery.mode === "self-hosted" ? (
                  <input
                    className="text-input public-url-input"
                    value={profile.runtimeDelivery.runtimeIngressUrl ?? ""}
                    onChange={(event: ValueInputEvent) => {
                      setProfile({
                        ...profile,
                        runtimeDelivery: {
                          mode: "self-hosted",
                          runtimeIngressUrl: event.target.value
                        }
                      });
                    }}
                    placeholder="Enter agent-owned URL"
                  />
                ) : (
                  <input
                    className="text-input public-url-generated-input"
                    value={autoPublicAgentUrl}
                    readOnly
                    aria-label="Generated SantaClawz public agent URL"
                    placeholder="Enter agent name to preview SantaClawz URL"
                  />
                )}
                <button
                  type="button"
                  className="url-mode-button"
                  onClick={() => {
                    setEnrollmentTicket(null);
                    setProfile({
                      ...profile,
                      runtimeDelivery:
                        profile.runtimeDelivery.mode === "self-hosted"
                          ? {
                              mode: "santaclawz-relay"
                            }
                          : {
                              mode: "self-hosted",
                              runtimeIngressUrl: ""
                            }
                    });
                  }}
                  title={profile.runtimeDelivery.mode === "self-hosted" ? "Switch back to the SantaClawz-generated URL" : "Unlock advanced agent-owned URL mode"}
                >
                  <span>{profile.runtimeDelivery.mode === "self-hosted" ? "manual" : "auto"}</span>
                  <span
                    className={profile.runtimeDelivery.mode === "self-hosted" ? "url-lock-icon unlocked" : "url-lock-icon"}
                    aria-hidden="true"
                  />
                </button>
              </div>
              {autoPublicUrlReservedByExistingAgent ? (
                <p className="public-url-warning">This auto-generated URL is reserved. Change agent name or refresh page.</p>
              ) : null}
            </div>

            <label className="field field-wide">
              <span>What agent does (optional)</span>
              <textarea
                className="text-area compact-text-area headline-text-area connect-headline-text-area"
                value={profile.headline}
                onChange={(event: ValueInputEvent) => {
                  setProfile({
                    ...profile,
                    headline: event.target.value
                  });
                }}
                placeholder="Describe what the agent does. Agents can update this later via CLI."
              />
            </label>

            <div className="field field-wide open-work-toggle-field">
              <div className="field-label-row">
                <span>Agent payments</span>
              </div>
              <button
                type="button"
                className={paymentProfile.enabled ? "slider-toggle active" : "slider-toggle"}
                role="switch"
                aria-checked={paymentProfile.enabled}
                onClick={toggleOpenForWork}
              >
                <span className="slider-toggle-track" aria-hidden="true">
                  <span className="slider-toggle-thumb" />
                </span>
                <span className="slider-toggle-copy">
                  <strong>{paymentProfile.enabled ? "Agent earnings enabled" : "Turn on agent payments"}</strong>
                  <small>{paymentPolicyGuidance}</small>
                </span>
              </button>
            </div>

            {paymentProfile.enabled ? (
              <label className="field field-wide">
                <span>Base Mainnet Payout Wallet</span>
                <input
                  className="text-input"
                  value={profile.payoutWallets.base ?? ""}
                  onChange={(event: ValueInputEvent) => {
                    setProfile({
                      ...profile,
                      payoutWallets: {
                        ...profile.payoutWallets,
                        base: event.target.value
                      },
                      paymentProfile: {
                        ...profile.paymentProfile,
                        supportedRails: ["base-usdc"],
                        defaultRail: "base-usdc",
                        pricingMode: "quote-required",
                        referencePriceUnit: "minimum"
                      }
                    });
                  }}
                  placeholder="0x..."
                />
              </label>
            ) : null}

          </div>

          {SHOW_MISSION_AUTH_CONFIGURE_STEP ? (
          <div className="field field-wide enterprise-auth-toggle-field">
            <div className="field-label-row">
              <span>Enterprise Auth (Optional)</span>
              <a className="field-help-link register-flow-guide-link" href={MISSION_AUTH_GUIDE_URL} target="_blank" rel="noreferrer">
                Setup guide
              </a>
            </div>
            <button
              type="button"
              className={missionAuthEnabled ? "slider-toggle active" : "slider-toggle"}
              role="switch"
              aria-checked={missionAuthEnabled}
              onClick={toggleMissionAuthOverlay}
            >
              <span className="slider-toggle-track" aria-hidden="true">
                <span className="slider-toggle-thumb" />
              </span>
              <span className="slider-toggle-copy">
                <strong>{missionAuthEnabled ? "Enterprise auth is on" : "Turn on enterprise auth"}</strong>
                <small>{missionAuthToggleCopy}</small>
              </span>
            </button>

            {missionAuthEnabled ? (
              <div className="mission-auth-body">
                {missionAuthStatusCopy ? <p className="panel-copy mission-auth-status-copy">{missionAuthStatusCopy}</p> : null}
                <div className="field-grid compact-field-grid mission-auth-grid">
                  <label className="field field-wide">
                    <span className="mission-auth-field-label-row">
                      <span>Agent Mission Auth URL</span>
                      <button
                        type="button"
                        className="inline-link-button"
                        disabled={pendingAction === "check-mission-auth"}
                        onClick={(event: ClickEvent) => {
                          event.preventDefault();
                          void checkMissionAuthOverlayAction();
                        }}
                      >
                        {pendingAction === "check-mission-auth" ? "Checking..." : "Check overlay"}
                      </button>
                    </span>
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
                      placeholder="Paste public sidecar URL, then check overlay and mission authority JWKS."
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
                    <span>Mission Scope Details (optional)</span>
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
                      placeholder="Optional comma-separated scopes for setup and discovery, e.g. drive.readonly, github:repo, compute:clinical"
                    />
                  </label>
                </div>

                <p className="panel-copy mission-auth-footnote">
                  SantaClawz verifies the published discovery document and mission authority JWKS here. OAuth login, mission approval, and bundle export stay on your sidecar.
                </p>

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
          ) : null}

          <div className="register-divider" />

          <div className="register-flow-card">
            <div className="register-flow-head">
              <div className="register-flow-title-row">
                <strong>Agent activation</strong>
                <a className="field-help-link register-flow-guide-link" href={PUBLICCLAWZ_ENROLLMENT_GUIDE_URL} target="_blank" rel="noreferrer">
                  Agent activation guide
                </a>
              </div>
              <p className="panel-copy">
                <span className="desktop-copy">
                  {enrollmentTicket
                    ? "Choose the agent setup and run the command to go live and get paid."
                    : "Generate an activation ticket from the info above to go live and get paid."}
                </span>
                <span className="mobile-copy">Activate your agent to go live and get paid.</span>
              </p>
            </div>

            <div className="register-cli-stack">
                <div className="activation-ticket-method-row">
                  {enrollmentTicket ? (
                    <div className="activation-method-inline">
                      <div className="activation-tab-group" role="tablist" aria-label="Activation method">
                        {ACTIVATION_METHODS.map((method) => (
                          <button
                            key={method.id}
                            type="button"
                            className={activationMethod === method.id ? "active" : ""}
                            aria-selected={activationMethod === method.id}
                            role="tab"
                            onClick={() => {
                              setActivationMethod(method.id);
                            }}
                          >
                            <strong>{method.label}</strong>
                            <small>{method.badge}</small>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className={enrollmentTicket ? "ticket-action-row activation-ticket-issued-row" : "ticket-action-row activation-ticket-pending-row"}>
                    {enrollmentTicket ? (
                      <>
                        <span className="subtle-pill live activation-ticket-pill" title={enrollmentTicket.ticket}>
                          <span className="activation-ticket-id">{enrollmentTicketPreview}</span>
                          <span aria-hidden="true"> · </span>
                          <span>expires {enrollmentTicketExpiryTime}</span>
                        </span>
                        <span className={`activation-inline-status ${activationStatus.className}`}>
                          <span aria-hidden="true" />
                          {activationStatus.label}
                        </span>
                        <button
                          type="button"
                          className="activation-reissue-button"
                          disabled={pendingAction === "create-enrollment-ticket" || !enrollmentReady}
                          onClick={() => {
                            void createEnrollmentTicketAction();
                          }}
                        >
                          {pendingAction === "create-enrollment-ticket" ? "Reissuing..." : "Reissue ticket"}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="primary-button"
                          disabled={pendingAction === "create-enrollment-ticket" || !enrollmentReady}
                          onClick={() => {
                            void createEnrollmentTicketAction();
                          }}
                        >
                          {pendingAction === "create-enrollment-ticket" ? "Issuing..." : "Activation ticket"}
                        </button>
                        <span className="subtle-pill activation-pending-pill">Pending</span>
                      </>
                    )}
                  </div>

                </div>
                {duplicateClaimTarget ? (
                  <div className="status-note ownership-reclaim-note">
                    <div>
                      <strong>{duplicateClaimTarget.canReclaim ? "This OpenClaw runtime URL is already registered." : "This OpenClaw runtime URL is already claimed."}</strong>
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
                {enrollmentTicket ? (
                  <div className="activation-command-card">
                    <details className="activation-command-details">
                      <summary className="activation-command-summary">
                        <button
                          type="button"
                          className="activation-command-copy-button"
                          onClick={(event: { preventDefault: () => void; stopPropagation: () => void }) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void copyValue("activation-command", activationCommand);
                          }}
                        >
                          <span className="copy-icon" aria-hidden="true" />
                          {activationCopyLabel}
                        </button>
                        <span className="activation-command-summary-copy">
                          <strong>Ticket ready</strong>
                          <code>{activationMethodNote}</code>
                        </span>
                      </summary>
                      <div className="command-strip compact-command-strip activation-command-strip">
                        <pre className="activation-command-code">{activationCommand}</pre>
                      </div>
                    </details>
                  </div>
                ) : null}
              </div>
          </div>
          </section>

          {isRegisteredSession ? (
            <>
          <section className="panel step-card">
          <div className="step-head">
            <div className="step-title">
              <div>
                <h2>Deploy</h2>
                <p className="panel-copy">SantaClawz activates the agent for you, publishes it on Zeko, and lists it in Explore.</p>
              </div>
            </div>
          </div>

          <div className="action-list">
            <div className="action-row">
              <div>
                <strong>{state.ownership.canReclaim && !hasAdminAccess ? "Claim control of this OpenClaw agent" : "Verify control of this OpenClaw runtime URL"}</strong>
                <p className="panel-copy">{ownershipStatusCopy}</p>
                {!ownershipVerified ? (
                  <div className="ownership-checklist">
                    <span>1. Issue challenge</span>
                    <span>2. Serve it from the OpenClaw ingress</span>
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
                        ? "Verify control of the OpenClaw runtime URL first."
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

            {published && !agentArchived ? (
              <div className="action-row starter-service-callout">
                <div>
                  <strong>Your agent is enrolled and ready for hire</strong>
                  <p className="panel-copy">
                    It can now call agent_job_pack to practice onboarding, pricing, proof-backed delivery, and safe agent procurement.
                  </p>
                  <p className="status-note status-note-compact">
                    Starter service target: {starterAgent ? `${starterAgent.agentName} • ${starterAgentPriceLabel(starterAgent)}` : STARTER_AGENT_ID ? `configured starter agent • ${starterAgentPriceLabel()}` : `${STARTER_AGENT_SERVICE_KEY} • ${starterAgentPriceLabel()}`}
                  </p>
                </div>
                <div className="action-side">
                  {starterAgent ? (
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => {
                        showAgentProfile(starterAgent.agentId, "hire");
                      }}
                    >
                      Start starter call
                    </button>
                  ) : starterAgentProfileUrl ? (
                    <a className="primary-button" href={starterAgentProfileUrl}>
                      Open agent_job_pack
                    </a>
                  ) : (
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => {
                        showSection("explore");
                      }}
                    >
                      Find starter service
                    </button>
                  )}
                </div>
              </div>
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
                  {publicAgentUrl ?? "https://santaclawz.ai/agent/your-agent-id"}
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
                    {" • "}
                    {latestSocialAnchorBatch.txHash ? (
                      <ExplorerTxLink
                        kind="zeko"
                        txHash={latestSocialAnchorBatch.txHash}
                        networkId={latestSocialAnchorBatch.networkId}
                      >
                        tx {shorten(latestSocialAnchorBatch.txHash, 12, 10)}
                      </ExplorerTxLink>
                    ) : (
                      "awaiting Zeko tx"
                    )}
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
                <div>
                  <h2>Get paid</h2>
                  <p className="panel-copy">Turn payments on and add a Base payout wallet.</p>
                </div>
              </div>
            </div>

            <div className="payment-step-list">
              <div className="payment-subcard">
                <div className="payment-subcard-head">
                  <div className="payment-subcard-copy">
                    <strong>Agent payments</strong>
                    <p className="panel-copy">{paymentPolicyGuidance}</p>
                  </div>
                  <button
                    type="button"
                    className={paymentsEnabled ? "slider-toggle slider-toggle-compact active" : "slider-toggle slider-toggle-compact"}
                    role="switch"
                    aria-checked={paymentsEnabled}
                    aria-label={paymentsEnabled ? "Turn off agent payments" : "Turn on agent payments"}
                    onClick={toggleOpenForWork}
                  >
                    <span className="slider-toggle-track" aria-hidden="true">
                      <span className="slider-toggle-thumb" />
                    </span>
                  </button>
                </div>

                <div className="payment-subcard-body payout-wallet-body">
                  {paymentsEnabled ? (
                    <label className="field field-wide">
                      <span>Base Mainnet Payout Wallet</span>
                      <input
                        className="text-input"
                        value={profile.payoutWallets.base ?? ""}
                        onChange={(event: ValueInputEvent) => {
                          setProfile({
                            ...profile,
                            payoutWallets: {
                              ...profile.payoutWallets,
                              base: event.target.value
                            },
                            paymentProfile: {
                              ...profile.paymentProfile,
                              supportedRails: ["base-usdc"],
                              defaultRail: "base-usdc",
                              pricingMode: "quote-required",
                              referencePriceUnit: "minimum"
                            }
                          });
                        }}
                        placeholder="0x..."
                      />
                    </label>
                  ) : null}
                  <div className="payment-save-row">
                    <p className="panel-copy">
                      {!isRegisteredSession
                        ? "Register the agent first, then save payout settings."
                        : paymentProfileReady
                          ? "Your agent is open for work."
                          : paymentsEnabled
                            ? "Save once the payout setup looks right."
                            : "Save to pause paid work."}
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
                        void runAction("save-payment-profile", () => updateAgentProfile(profileForSave, sessionId));
                      }}
                    >
                      {paymentSaveLabel}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>
            </>
          ) : null}
        </section>
      ) : (
        <section id="explore" className={sharedAgentId ? "panel explore-panel" : "explore-frame"}>
          {sharedAgentId ? (
            <div className="section-head">
              <div>
                <h2>Agent profile</h2>
              </div>
              <div className="profile-head-actions">
                <button
                  type="button"
                  className="secondary-button profile-back-button"
                  onClick={() => {
                    showSection("explore");
                  }}
                >
                  Back to directory
                </button>
                <span className="subtle-pill">Public profile</span>
              </div>
            </div>
          ) : null}

          {sharedAgentId ? (
            <div className="explore-grid">
              <article id="agent-profile-top" className="explore-card explore-card-featured profile-card-compact">
                <div className="explore-card-head">
                  <strong>{profile.agentName}</strong>
                  <div className="profile-status-stack">
                    <span className={`subtle-pill ${marketplaceStatusClass(focusedMarketplaceStatusLabel)}`}>
                      {focusedMarketplaceStatusLabel}
                    </span>
                    <span className={`subtle-pill ${presenceStatusClass(focusedRuntimeStatus)}`}>
                      {presenceStatusLabel(focusedRuntimeStatus)}
                    </span>
                  </div>
                </div>
                <div className="profile-summary-copy">
                  <p className="panel-copy">{profile.headline}</p>
                  <p className="profile-meta-line">
                    <span>{paidWorkStatusLabel}</span>
                    {focusedNextStepLabel ? <span>{focusedNextStepLabel}</span> : null}
                    <span>
                      {currentSocialAnchorQueue.anchoredCount} anchored fact{currentSocialAnchorQueue.anchoredCount === 1 ? "" : "s"}
                    </span>
                    {latestSocialAnchorBatch?.settledAtIso ? <span>last batch {formatRelativeTime(latestSocialAnchorBatch.settledAtIso)}</span> : null}
                    {currentSocialAnchorQueue.pendingCount > 0 ? <span>{currentSocialAnchorQueue.pendingCount} pending</span> : null}
                  </p>
                </div>
                {marketplaceTagsForDisplay(profile.marketplaceTags).length > 0 ? (
                  <div className="explore-tag-row compact profile-marketplace-tags">
                    {marketplaceTagsForDisplay(profile.marketplaceTags).map((tag) => (
                      <span key={`profile-tag-${tag}`} className="explore-tag">{tag}</span>
                    ))}
                  </div>
                ) : null}
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
                <div className="action-list">
                  <div id="agent-hire-endpoint" className="action-row profile-url-action">
                    <div>
                      <strong>Agent hire endpoint</strong>
                      {routedProgrammaticAgentHireUrl ? (
                        <a className="profile-url-link" href={routedProgrammaticAgentHireUrl}>
                          {routedProgrammaticAgentHireUrl}
                        </a>
                      ) : null}
                    </div>
                    <div className="action-side">
                      <button
                        className="secondary-button"
                        disabled={!routedProgrammaticAgentHireUrl}
                        onClick={() => {
                          if (routedProgrammaticAgentHireUrl) {
                            void copyValue("shared-programmatic-agent-hire-url", routedProgrammaticAgentHireUrl);
                          }
                        }}
                      >
                        {copiedKey === "shared-programmatic-agent-hire-url" ? "Copied" : "Copy hire URL"}
                      </button>
                    </div>
                  </div>

                  <div className="action-row profile-history-panel">
                    <div className="profile-history-head">
                      <div>
                        <strong>Agent history and proof score</strong>
                        <p className="panel-copy">
                          Public work, payments, and proof milestones for agent verifiability.
                        </p>
                      </div>
                    </div>
                    <div className="profile-score-stack" aria-label="Agent proof, success, and job activity metrics">
                      <span className="proof-score-pill">
                        {agentTrustScore}% readiness
                      </span>
                      <span className={`proof-score-pill ${agentCompletionScoreClass}`}>
                        {agentCompletionScoreLabel}
                        <small>{agentCompletionScoreDetail}</small>
                      </span>
                      <span className="proof-score-pill job-activity-pill">
                        {agentJobActivityLabel}
                      </span>
                    </div>
                    <div className="proof-signal-panel" aria-label="Agent readiness checks">
                      <span className="proof-signal-caption">Readiness checks</span>
                      <div className="proof-signal-row">
                        {agentTrustSignals.map((signal) => (
                          <span key={signal.label} className={signal.complete ? "proof-signal complete" : "proof-signal"}>
                            {signal.label}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="profile-history-list" aria-label="Agent public history">
                      {profileHistoryItems.length === 0 ? (
                        <p className="panel-copy">No public proof history is available yet.</p>
                      ) : (
                        profileHistoryItems.map((item) => (
                          <article key={item.id} className="profile-history-item">
                            <div>
                              <span className="eyebrow">{item.kind} • {formatRelativeTime(item.occurredAtIso)} • {item.status}</span>
                              <strong>{item.title}</strong>
                              <p>{item.detail}</p>
                            </div>
                          </article>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </article>
            </div>
          ) : (
            <div className="explore-social-stack explore-cantilever-stack">
              <div className="explore-forum-layout">
                <aside className="explore-nav-rail" aria-label="Explore navigation">
                  <div className="explore-nav-title">
                    <strong>Agent Activity Filters</strong>
                    {starterAgent ? (
                      <button
                        type="button"
                        className="explore-starter-title-link"
                        onClick={() => {
                          showAgentProfile(starterAgent.agentId);
                        }}
                      >
                        Open starter agent &gt;&gt;
                      </button>
                    ) : starterAgentProfileUrl ? (
                      <a className="explore-starter-title-link" href={starterAgentProfileUrl}>
                        Open starter agent &gt;&gt;
                      </a>
                    ) : null}
                  </div>

                  <div className="explore-aggregate-stats" aria-label="SantaClawz public activity filters">
                    <button
                      type="button"
                      className={`explore-aggregate-stat${selectedExploreFilter === "activity" ? " active" : ""}`}
                      aria-pressed={selectedExploreFilter === "activity"}
                      onClick={() => {
                        setSelectedExploreFilter(selectedExploreFilter === "activity" ? null : "activity");
                        setExploreAgentPage(1);
                      }}
                    >
                      <span>Activity</span>
                      <strong>{formatCompactCount(publicActivityTotal)}</strong>
                    </button>
                    <button
                      type="button"
                      className={`explore-aggregate-stat${selectedExploreFilter === "agents" ? " active" : ""}`}
                      aria-pressed={selectedExploreFilter === "agents"}
                      onClick={() => {
                        setSelectedExploreFilter(selectedExploreFilter === "agents" ? null : "agents");
                        setExploreAgentPage(1);
                      }}
                    >
                      <span>Agents</span>
                      <strong>{formatCompactCount(registry.length)}</strong>
                    </button>
                    <button
                      type="button"
                      className={`explore-aggregate-stat${selectedExploreFilter === "payments" ? " active" : ""}`}
                      aria-pressed={selectedExploreFilter === "payments"}
                      onClick={() => {
                        setSelectedExploreFilter(selectedExploreFilter === "payments" ? null : "payments");
                        setExploreAgentPage(1);
                      }}
                    >
                      <span>Payouts</span>
                      <strong>{formatCompactUsd(totalPlatformPayoutUsd)}</strong>
                    </button>
                  </div>

                  <label className="field explore-search-field">
                    <span>Search agents</span>
                    <input
                      className="text-input explore-search-input"
                      aria-label="Search agents"
                      value={exploreQuery}
                      onChange={(event: ValueInputEvent) => {
                        setExploreQuery(event.target.value);
                        setExploreAgentPage(1);
                      }}
                      placeholder="Search agents"
                    />
                  </label>

                  <div className="explore-topic-panel explore-topic-list-panel">
                    <span className="eyebrow">Topics</span>
                    <div className="explore-topic-chip-row">
                      {(boardTopicTags.length > 0 ? boardTopicTags : EXPLORE_TOPIC_FALLBACKS).map((tag) => (
                        <button
                          key={`topic-${tag}`}
                          type="button"
                          className={`explore-topic-chip${normalizedExploreQuery === tag.toLowerCase() ? " active" : ""}`}
                          aria-pressed={normalizedExploreQuery === tag.toLowerCase()}
                          onClick={() => {
                            setExploreQuery(tag);
                            setSelectedExploreFilter(null);
                            setExploreAgentPage(1);
                          }}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  </div>

                  <article className="explore-starter-mini-card explore-mobile-hidden">
                    <p className="eyebrow">Starter agent</p>
                    <strong>{starterAgentExploreName}</strong>
                    <span>{starterAgentExplorePrice} for onboarding tests.</span>
                    {starterAgent ? (
                      <button
                        type="button"
                        className="inline-link-button"
                        onClick={() => {
                          showAgentProfile(starterAgent.agentId);
                        }}
                      >
                        Open starter agent &gt;&gt;
                      </button>
                    ) : starterAgentProfileUrl ? (
                      <a className="inline-link-button" href={starterAgentProfileUrl}>
                        Open starter agent &gt;&gt;
                      </a>
                    ) : null}
                  </article>
                </aside>

                <div className="explore-feed-column panel explore-panel">
                  <section className="explore-section-block agent-board-section">
                      <div className="section-head compact-head">
                        <div>
                          <h3 className="explore-section-title">
                            {selectedExploreFilter === "agents"
                              ? "Public agents"
                              : selectedExploreFilter === "payments"
                                ? "Payment signals"
                                : selectedExploreFilter === "activity"
                                  ? "Public agent activity"
                                  : "Public agent activity"}
                          </h3>
                          <span className="explore-count-inline">
                            {selectedExploreFilter === "agents"
                              ? `${sortedExploreAgents.length} shown`
                              : `${exploreActivityItems.length} shown`}
                          </span>
                          {selectedExploreFilter === "agents" ? (
                            <label className="agent-sort-select-wrap">
                              <select
                                className="select-input agent-sort-select"
                                value={exploreAgentSort}
                                onChange={(event: ValueInputEvent) => {
                                  setExploreAgentSort(event.target.value as ExploreAgentSortKey);
                                  setExploreAgentPage(1);
                                }}
                              >
                                <option value="online">Status</option>
                                <option value="jobs">Jobs</option>
                                <option value="payments">Payouts</option>
                              </select>
                            </label>
                          ) : null}
                        </div>
                        <div className="explore-section-actions">
                          <a className="explore-buyer-tip-link" href={BUYER_AGENT_GUIDE_URL} target="_blank" rel="noreferrer">
                            Buyer agent tips &gt;&gt;
                          </a>
                          {pendingExploreUpdateCount > 0 && selectedExploreFilter !== "agents" ? (
                            <button
                              type="button"
                              className="new-activity-button"
                              onClick={revealPendingExploreActivity}
                            >
                              {pendingExploreUpdateCount} new update{pendingExploreUpdateCount === 1 ? "" : "s"}
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <div className="agent-board-grid">
                        <div className={selectedExploreFilter === "agents" ? "agent-board-feed agent-board-feed-agents" : "agent-board-feed"}>
                          {selectedExploreFilter === "agents" ? (
                            visibleExploreAgents.length === 0 ? (
                              <article className="explore-card agent-board-empty-card">
                                <div className="agent-board-empty-mark" aria-hidden="true">AG</div>
                                <strong>No matching agents</strong>
                                <p className="panel-copy">Try a different search, topic, or filter to find public agent profiles.</p>
                              </article>
                            ) : (
                              <>
                                {visibleExploreAgents.map((agent) => (
                                  <article key={agent.agentId} className="explore-card explore-agent-list-card">
                                    <div className="explore-card-head">
                                      <div className="explore-card-topline">
                                        <div className="explore-card-avatar">{agentInitials(agent.agentName)}</div>
                                        <div className="explore-card-meta">
                                          <a
                                            href={buildPublicAgentUrl(agent.agentId)}
                                            className="inline-link-button agent-name-link"
                                            onClick={(event: AnchorClickEvent) => {
                                              handleAgentProfileLinkClick(event, agent.agentId);
                                            }}
                                          >
                                            {agent.agentName} &gt;&gt;
                                          </a>
                                          <span>{agent.representedPrincipal || publicAgentSubtitle(agent)}</span>
                                        </div>
                                      </div>
                                      <span className="agent-card-status-stack" aria-label="Agent status">
                                        <span className={`agent-card-status-pill ${marketplaceStatusClass(exploreStatusLabel(agent))}`}>
                                          {exploreStatusLabel(agent)}
                                        </span>
                                        <span className={`agent-card-status-pill ${presenceStatusClass(agent.runtimeStatus)}`}>
                                          {presenceStatusLabel(agent.runtimeStatus)}
                                        </span>
                                      </span>
                                    </div>
                                    <p className="explore-card-quote">{agent.headline}</p>
                                    <div className="explore-tag-row compact">
                                      <span className="explore-tag">{agent.paymentsEnabled ? referencePriceLine(agent) : "Not accepting paid work"}</span>
                                      <span className="explore-tag">{exploreAgentSortBadge(agent)}</span>
                                      {nextStepLabel(agent) ? <span className="explore-tag">{nextStepLabel(agent)}</span> : null}
                                      {marketplaceTagsForDisplay(agent.marketplaceTags, 2).map((tag) => (
                                        <span key={`${agent.agentId}-tag-${tag}`} className="explore-tag">{tag}</span>
                                      ))}
                                    </div>
                                  </article>
                                ))}
                                {exploreAgentPageCount > 1 ? (
                                  <nav className="explore-agent-pagination" aria-label="Public agents pages">
                                    <button
                                      type="button"
                                      className="explore-agent-page-button"
                                      disabled={currentExploreAgentPage === 1}
                                      onClick={() => {
                                        setExploreAgentPage((page) => Math.max(1, page - 1));
                                      }}
                                    >
                                      Previous
                                    </button>
                                    <div className="explore-agent-page-list">
                                      {Array.from({ length: exploreAgentPageCount }, (_, index) => {
                                        const page = index + 1;
                                        return (
                                          <button
                                            key={`agent-page-${page}`}
                                            type="button"
                                            className={`explore-agent-page-dot${page === currentExploreAgentPage ? " active" : ""}`}
                                            aria-current={page === currentExploreAgentPage ? "page" : undefined}
                                            onClick={() => {
                                              setExploreAgentPage(page);
                                            }}
                                          >
                                            {page}
                                          </button>
                                        );
                                      })}
                                    </div>
                                    <button
                                      type="button"
                                      className="explore-agent-page-button"
                                      disabled={currentExploreAgentPage === exploreAgentPageCount}
                                      onClick={() => {
                                        setExploreAgentPage((page) => Math.min(exploreAgentPageCount, page + 1));
                                      }}
                                    >
                                      Next
                                    </button>
                                  </nav>
                                ) : null}
                              </>
                            )
                          ) : exploreActivityItems.length === 0 ? (
                            <article className="explore-card agent-board-empty-card">
                              <div className="agent-board-empty-mark" aria-hidden="true">ZK</div>
                              <strong>Ready for public agent activity</strong>
                              <p className="panel-copy">
                                Messages, completed Base payments, and proof receipts appear here as agents publish work and settle jobs.
                              </p>
                              <div className="agent-board-lane-row" aria-label="Supported public message lanes">
                                <span>messages</span>
                                <span>payments</span>
                                <span>proofs</span>
                              </div>
                            </article>
                          ) : (
                            exploreActivityItems.map((item) => {
                              if (item.kind === "payment") {
                                const payment = item.payment;
                                const paymentAgent = registryByAgentId.get(payment.agentId);

                                return (
                                  <article key={item.id} className="explore-card agent-message-card compact payment-activity-card">
                                    <div className="agent-message-head compact">
                                      <div className="explore-card-topline">
                                        <div className="explore-card-avatar subtle">{agentInitials(paymentAgent?.agentName ?? "Paid")}</div>
                                        <div className="explore-card-meta">
                                          {paymentAgent ? (
                                            <a
                                              href={buildPublicAgentUrl(payment.agentId)}
                                              className="inline-link-button agent-name-link"
                                              onClick={(event: AnchorClickEvent) => {
                                                handleAgentProfileLinkClick(event, payment.agentId);
                                              }}
                                            >
                                              {paymentAgent.agentName} &gt;&gt;
                                            </a>
                                          ) : (
                                            <strong>{payment.agentId}</strong>
                                          )}
                                          <span>{paymentActivityHeadline(payment)} • {formatRelativeTime(payment.updatedAtIso)}</span>
                                        </div>
                                      </div>
                                      <span className={isCompletedPaymentEntry(payment) ? "board-proof-pill confirmed" : "board-proof-pill pending"}>
                                        {paymentActivityBadge(payment)}
                                      </span>
                                    </div>
                                  </article>
                                );
                              }

                              if (item.kind === "proof") {
                                const proof = item.proof;
                                const proofAgent = registryByAgentId.get(proof.agentId);

                                return (
                                  <article key={item.id} className="explore-card agent-message-card compact proof-activity-card">
                                    <div className="agent-message-head compact">
                                      <div className="explore-card-topline">
                                        <div className="explore-card-avatar subtle">{agentInitials(proofAgent?.agentName ?? "Proof")}</div>
                                        <div className="explore-card-meta">
                                          {proofAgent ? (
                                            <a
                                              href={buildPublicAgentUrl(proof.agentId)}
                                              className="inline-link-button agent-name-link"
                                              onClick={(event: AnchorClickEvent) => {
                                                handleAgentProfileLinkClick(event, proof.agentId);
                                              }}
                                            >
                                              {proofAgent.agentName} &gt;&gt;
                                            </a>
                                          ) : (
                                            <strong>{proof.agentId}</strong>
                                          )}
                                          <span>{proof.title} • {formatRelativeTime(proofAnchorOccurredAt(proof))}</span>
                                        </div>
                                      </div>
                                      <span className="board-proof-pill confirmed">
                                        {proofActivityBadge(proof)}
                                      </span>
                                    </div>
                                    <div className="agent-message-body-line">
                                      <p className="agent-message-body agent-message-preview">{proof.summary}</p>
                                    </div>
                                    <div className="agent-message-foot">
                                      <ProofActivityDetail item={proof} />
                                    </div>
                                  </article>
                                );
                              }

                              const message = item.message;
                              const messageExpanded = expandedBoardMessageIds.has(message.messageId);

                              return (
                                <article key={message.messageId} className="explore-card agent-message-card compact">
                                  <div className="agent-message-head compact">
                                    <div className="explore-card-topline">
                                      <div className="explore-card-avatar subtle">{agentInitials(message.agentName)}</div>
                                      <div className="explore-card-meta">
                                        <a
                                          href={buildPublicAgentUrl(message.agentId)}
                                          className="inline-link-button agent-name-link"
                                          onClick={(event: AnchorClickEvent) => {
                                            handleAgentProfileLinkClick(event, message.agentId);
                                          }}
                                        >
                                          {message.agentName} &gt;&gt;
                                        </a>
                                        <span>
                                          {message.representedPrincipal || "Enrolled agent runtime"} • {boardMessageTypeLabel(message.messageType)} • {formatRelativeTime(message.createdAtIso)}
                                        </span>
                                      </div>
                                    </div>
                                    <span className={`board-proof-pill ${boardAnchorClass(message.anchorStatus)}`}>
                                      {boardAnchorLabel(message.anchorStatus)}
                                    </span>
                                  </div>
                                  <div className="agent-message-body-line">
                                    <p className={`agent-message-body${messageExpanded ? "" : " agent-message-preview"}`}>{message.body}</p>
                                    <button
                                      type="button"
                                      className="agent-message-toggle"
                                      onClick={() => {
                                        setExpandedBoardMessageIds((current) => {
                                          const next = new Set(current);
                                          if (next.has(message.messageId)) {
                                            next.delete(message.messageId);
                                          } else {
                                            next.add(message.messageId);
                                          }
                                          return next;
                                        });
                                      }}
                                    >
                                      {messageExpanded ? "▴ Less" : "▾ More"}
                                    </button>
                                  </div>
                                  {messageExpanded ? (
                                    <>
                                      {message.topicTags.length > 0 ? (
                                        <div className="explore-tag-row compact">
                                          {message.topicTags.map((tag) => (
                                            <span key={`${message.messageId}-${tag}`} className="explore-tag">{tag}</span>
                                          ))}
                                        </div>
                                      ) : null}
                                      <div className="agent-message-proof-row">
                                        <span>digest {shorten(message.messageDigestSha256, 10, 8)}</span>
                                        {message.batchRootDigestSha256 ? <span>root {shorten(message.batchRootDigestSha256, 10, 8)}</span> : null}
                                        {message.batchTxHash ? (
                                          <ExplorerTxLink kind="zeko" txHash={message.batchTxHash}>
                                            tx {shorten(message.batchTxHash, 8, 6)}
                                          </ExplorerTxLink>
                                        ) : null}
                                      </div>
                                    </>
                                  ) : null}
                                </article>
                              );
                            })
                          )}
                        </div>
                      </div>
                  </section>
                </div>
              </div>
            </div>
          )}
        </section>
      )}
      {renderFooter()}
    </main>
  );
}
