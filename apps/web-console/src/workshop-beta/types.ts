import type { AgentBoardState } from "@clawz/protocol";

export type WorkshopBetaMissionStatus =
  | "draft_mission"
  | "admin_bound"
  | "mission_issued"
  | "agents_invited"
  | "agents_claimed"
  | "work_started"
  | "receipt_pending"
  | "receipt_confirmed"
  | "verified"
  | "completed"
  | "expired"
  | "revoked"
  | "agent_rejected"
  | "receipt_failed"
  | "verification_failed";

export type WorkshopBetaVisibilityMode =
  | "private"
  | "company"
  | "proof_only_public"
  | "public_collaboration";

export interface WorkshopBetaAdminChallenge {
  challengeId: string;
  sessionId: string;
  emailHash: string;
  workshopId: string;
  requestedRole: "workshop_admin";
  nonce: string;
  audience: "santaclawz-workshop-beta-admin-binding";
  status: "issued" | "claimed" | "verified" | "expired" | "revoked";
  agentId?: string;
  agentName?: string;
  claimDigestSha256?: string;
  signature?: string;
  publicKey?: string;
  missionAuthAuthorityBaseUrl?: string;
  createdAtIso: string;
  expiresAtIso: string;
  claimedAtIso?: string;
  verifiedAtIso?: string;
}

export interface WorkshopBetaAdminBinding {
  bindingId: string;
  sessionId: string;
  emailHash: string;
  workshopId: string;
  agentId: string;
  agentName?: string;
  role: "workshop_admin";
  status: "claimed" | "verified" | "revoked";
  challengeId: string;
  createdAtIso: string;
  verifiedAtIso?: string;
}

export interface WorkshopBetaMission {
  missionId: string;
  workspaceId: string;
  title: string;
  goal: string;
  visibility: WorkshopBetaVisibilityMode;
  allowedAgentIds: string[];
  dataRules: string;
  successCriteria: string;
  budgetUsd?: string;
  missionHash: string;
  status: WorkshopBetaMissionStatus;
  createdBySessionId?: string;
  adminBindingId?: string;
  createdAtIso: string;
  updatedAtIso: string;
  expiresAtIso?: string;
}

export interface WorkshopBetaAgentClaim {
  claimId: string;
  missionId: string;
  agentId: string;
  role: "admin" | "worker" | "verifier" | "compiler" | "observer";
  status: "claimed" | "accepted" | "rejected" | "revoked";
  scopeDigestSha256: string;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface WorkshopBetaDashboardSnapshot {
  schemaVersion: "santaclawz-workshop-beta-dashboard/0.1";
  generatedAtIso: string;
  stageOrder: WorkshopBetaMissionStatus[];
  controlPlane: {
    authSessionCount: number;
    activeAdminChallengeCount: number;
    adminBindingCount: number;
    verifiedAdminBindingCount: number;
    missionCount: number;
    activeMissionCount: number;
    agentClaimCount: number;
  };
  liveNetwork: {
    totalAgentCount: number;
    onlineAgentCount: number;
    missionAuthVerifiedAgentCount: number;
    workshopReceiptCount: number;
    recentWorkshopReceiptCount: number;
    confirmedProofCount: number;
    pendingProofCount: number;
    failedProofCount: number;
    completedPaymentCount: number;
    completedSellerPayoutUsd: string;
  };
  adminChallenges: WorkshopBetaAdminChallenge[];
  adminBindings: WorkshopBetaAdminBinding[];
  missions: WorkshopBetaMission[];
  agentClaims: WorkshopBetaAgentClaim[];
  recentReceipts: AgentBoardState["messages"];
  recommendedNextActions: string[];
}

export interface WorkshopBetaAuthStartResponse {
  schemaVersion: "santaclawz-workshop-beta-auth-start/0.1";
  sessionId: string;
  email: string;
  provider: "email_magic_link" | "google_oidc";
  status: "pending";
  expiresAtIso: string;
  verificationToken: string;
}
