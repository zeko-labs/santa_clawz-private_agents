export type TrustModeId = "fast" | "private" | "verified" | "team-governed";

export interface TrustModeCard {
  id: TrustModeId;
  label: string;
  blurb: string;
  operatorVisible: boolean;
  providerVisible: boolean;
  proofLevel: string;
  maxSpend: string;
  retention: string;
  stripe: string[];
}

export const trustModes: TrustModeCard[] = [
  {
    id: "fast",
    label: "Fast",
    blurb: "For low-risk drafting and internal synthesis with minimal friction.",
    operatorVisible: true,
    providerVisible: true,
    proofLevel: "Signed",
    maxSpend: "0.08 MINA",
    retention: "24h checkpoint",
    stripe: ["Visible to your workspace", "Provider approved", "Quick retention"]
  },
  {
    id: "private",
    label: "Private",
    blurb: "Default mode for day-to-day work with sealed outputs and bounded disclosure.",
    operatorVisible: false,
    providerVisible: false,
    proofLevel: "Rooted",
    maxSpend: "0.18 MINA",
    retention: "72h zero-retention",
    stripe: ["Visible only to you", "Operator blind", "Deleted after completion"]
  },
  {
    id: "verified",
    label: "Verified",
    blurb: "Adds denser receipts and stronger auditability for high-trust deliverables.",
    operatorVisible: false,
    providerVisible: false,
    proofLevel: "Rooted + replay proofs",
    maxSpend: "0.25 MINA",
    retention: "Checkpoint only",
    stripe: ["Operator blind", "Receipt complete", "Selective disclosure only"]
  },
  {
    id: "team-governed",
    label: "Team-governed",
    blurb: "For enterprise workflows with guardians, privacy exceptions, and shared review.",
    operatorVisible: false,
    providerVisible: false,
    proofLevel: "Policy proofs",
    maxSpend: "0.40 MINA",
    retention: "Workspace sealed",
    stripe: ["Visible to your workspace", "Privacy exceptions required", "Compliance scoped"]
  }
];

export const privacyExceptions = [
  {
    id: "pex_001",
    title: "Reveal one operator-blind artifact for incident review",
    audience: "Compliance reviewer",
    duration: "24h",
    scope: "One screenshot and one tool receipt",
    reason: "Investigate anomalous outbound host access without opening the full transcript.",
    severity: "high"
  },
  {
    id: "pex_002",
    title: "Allow redacted remote provider fallback",
    audience: "Approved remote model",
    duration: "This turn only",
    scope: "Redacted prompt fields and citation digests",
    reason: "Local sealed provider is saturated and the task can safely route in digest mode.",
    severity: "medium"
  }
] as const;

export const ghostPlan = [
  "Run 2 shell commands inside the sealed workspace sandbox",
  "Open 1 approved external host in browser mode",
  "Emit 1 operator-blind artifact manifest",
  "Request no raw-content provider routing",
  "Reserve 0.18 MINA and refund unused spend"
];

export const timeMachineEntries = [
  {
    id: "turn_0009",
    label: "Turn 9",
    outcome: "Privacy exception granted",
    note: "One artifact disclosed to compliance reviewer under 24h expiry."
  },
  {
    id: "turn_0010",
    label: "Turn 10",
    outcome: "Ghost Run approved",
    note: "User switched from Fast to Private after seeing provider visibility."
  },
  {
    id: "turn_0011",
    label: "Turn 11",
    outcome: "Operator-blind sealed execution",
    note: "Shell + browser receipts committed with zero-retention artifacts."
  },
  {
    id: "turn_0012",
    label: "Turn 12",
    outcome: "Budget refunded",
    note: "Reserved 0.25 MINA, spent 0.13 MINA, refunded 0.12 MINA."
  }
];
