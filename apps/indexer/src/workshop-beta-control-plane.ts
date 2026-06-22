import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AgentBoardState,
  AgentRegistryEntry,
  PaymentLedgerState,
  SocialAnchorQueueState
} from "@clawz/protocol";

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

export interface WorkshopBetaAuthSession {
  sessionId: string;
  email: string;
  provider: "email_magic_link" | "google_oidc";
  status: "pending" | "verified" | "expired" | "revoked";
  tokenHash: string;
  createdAtIso: string;
  expiresAtIso: string;
  verifiedAtIso?: string;
}

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

interface WorkshopBetaStore {
  schemaVersion: "santaclawz-workshop-beta-control-plane/0.1";
  updatedAtIso: string;
  authSessions: WorkshopBetaAuthSession[];
  adminChallenges: WorkshopBetaAdminChallenge[];
  adminBindings: WorkshopBetaAdminBinding[];
  missions: WorkshopBetaMission[];
  agentClaims: WorkshopBetaAgentClaim[];
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

const WORKSHOP_BETA_STAGE_ORDER: WorkshopBetaMissionStatus[] = [
  "draft_mission",
  "admin_bound",
  "mission_issued",
  "agents_invited",
  "agents_claimed",
  "work_started",
  "receipt_pending",
  "receipt_confirmed",
  "verified",
  "completed"
];

const WORKSHOP_BETA_TERMINAL_STATES = new Set<WorkshopBetaMissionStatus>([
  "completed",
  "expired",
  "revoked",
  "agent_rejected",
  "receipt_failed",
  "verification_failed"
]);

const WORKSHOP_BETA_ALLOWED_TRANSITIONS: Record<WorkshopBetaMissionStatus, WorkshopBetaMissionStatus[]> = {
  draft_mission: ["admin_bound", "mission_issued", "expired", "revoked"],
  admin_bound: ["mission_issued", "expired", "revoked"],
  mission_issued: ["agents_invited", "agents_claimed", "expired", "revoked"],
  agents_invited: ["agents_claimed", "agent_rejected", "expired", "revoked"],
  agents_claimed: ["work_started", "agent_rejected", "expired", "revoked"],
  work_started: ["receipt_pending", "receipt_failed", "verification_failed", "expired", "revoked"],
  receipt_pending: ["receipt_confirmed", "receipt_failed", "expired", "revoked"],
  receipt_confirmed: ["verified", "verification_failed", "expired", "revoked"],
  verified: ["completed", "verification_failed", "expired", "revoked"],
  completed: [],
  expired: [],
  revoked: [],
  agent_rejected: [],
  receipt_failed: [],
  verification_failed: []
};

function nowIso() {
  return new Date().toISOString();
}

function addMinutes(minutes: number) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeTimingEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function sanitizeEmail(value: unknown) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Valid email is required.");
  }
  return email.slice(0, 240);
}

function sanitizeId(value: unknown, fallbackPrefix: string) {
  const id = typeof value === "string" ? value.trim() : "";
  if (/^[a-zA-Z0-9:_./@-]{3,160}$/.test(id)) {
    return id;
  }
  return `${fallbackPrefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function optionalString(value: unknown, maxLength = 2000) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text.slice(0, maxLength) : undefined;
}

function requiredString(value: unknown, field: string, maxLength = 2000) {
  const text = optionalString(value, maxLength);
  if (!text) {
    throw new Error(`${field} is required.`);
  }
  return text;
}

function sanitizeVisibility(value: unknown): WorkshopBetaVisibilityMode {
  return value === "private" ||
    value === "company" ||
    value === "proof_only_public" ||
    value === "public_collaboration"
    ? value
    : "private";
}

function sanitizeRole(value: unknown): WorkshopBetaAgentClaim["role"] {
  return value === "admin" ||
    value === "worker" ||
    value === "verifier" ||
    value === "compiler" ||
    value === "observer"
    ? value
    : "worker";
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
}

function buildDefaultStore(): WorkshopBetaStore {
  return {
    schemaVersion: "santaclawz-workshop-beta-control-plane/0.1",
    updatedAtIso: nowIso(),
    authSessions: [],
    adminChallenges: [],
    adminBindings: [],
    missions: [],
    agentClaims: []
  };
}

function buildMissionHash(input: {
  workspaceId: string;
  title: string;
  goal: string;
  visibility: WorkshopBetaVisibilityMode;
  allowedAgentIds: string[];
  dataRules: string;
  successCriteria: string;
  budgetUsd?: string;
  expiresAtIso?: string;
}) {
  return sha256(JSON.stringify({
    schemaVersion: "santaclawz-workshop-beta-mission/0.1",
    ...input
  }));
}

function sortNewest<T extends { createdAtIso?: string; updatedAtIso?: string }>(items: T[]) {
  return [...items].sort((left, right) =>
    (right.updatedAtIso ?? right.createdAtIso ?? "").localeCompare(left.updatedAtIso ?? left.createdAtIso ?? "")
  );
}

function summarizeNextActions(store: WorkshopBetaStore): string[] {
  const actions: string[] = [];
  const activeChallenge = store.adminChallenges.some((challenge) => challenge.status === "issued");
  const verifiedBinding = store.adminBindings.some((binding) => binding.status === "verified");
  const claimedBinding = store.adminBindings.some((binding) => binding.status === "claimed");
  const activeMission = store.missions.find((mission) => !WORKSHOP_BETA_TERMINAL_STATES.has(mission.status));

  if (!activeChallenge && !claimedBinding && !verifiedBinding) {
    actions.push("Sign in and issue an admin-agent challenge.");
  }
  if (claimedBinding && !verifiedBinding) {
    actions.push("Connect mission-bound OAuth verification for the claimed admin agent.");
  }
  if (!activeMission) {
    actions.push("Create a mission with visibility, data rules, and success criteria.");
  } else if (activeMission.status === "draft_mission") {
    actions.push("Bind an admin agent or issue the mission to start agent claims.");
  } else if (activeMission.status === "mission_issued" || activeMission.status === "agents_invited") {
    actions.push("Have participating agents claim their mission-scoped roles.");
  } else if (activeMission.status === "work_started" || activeMission.status === "receipt_pending") {
    actions.push("Wait for receipt confirmation, then verify the mission outcome.");
  }

  return actions.slice(0, 4);
}

export class WorkshopBetaControlPlane {
  private constructor(private readonly filePath: string) {}

  static async boot(baseDir: string) {
    const instance = new WorkshopBetaControlPlane(path.join(baseDir, "control-plane.json"));
    await instance.load();
    return instance;
  }

  private async load(): Promise<WorkshopBetaStore> {
    const existing = await readJsonFile<Partial<WorkshopBetaStore>>(this.filePath);
    if (!existing) {
      const next = buildDefaultStore();
      await this.save(next);
      return next;
    }
    return {
      schemaVersion: "santaclawz-workshop-beta-control-plane/0.1",
      updatedAtIso: typeof existing.updatedAtIso === "string" ? existing.updatedAtIso : nowIso(),
      authSessions: Array.isArray(existing.authSessions) ? existing.authSessions : [],
      adminChallenges: Array.isArray(existing.adminChallenges) ? existing.adminChallenges : [],
      adminBindings: Array.isArray(existing.adminBindings) ? existing.adminBindings : [],
      missions: Array.isArray(existing.missions) ? existing.missions : [],
      agentClaims: Array.isArray(existing.agentClaims) ? existing.agentClaims : []
    };
  }

  private async save(store: WorkshopBetaStore) {
    await writeJsonFile(this.filePath, {
      ...store,
      updatedAtIso: nowIso()
    });
  }

  async createAuthSession(input: { email: unknown; provider?: unknown }) {
    const email = sanitizeEmail(input.email);
    const provider = input.provider === "google_oidc" ? "google_oidc" : "email_magic_link";
    const token = `scz_wbeta_auth_${randomUUID().replace(/-/g, "")}`;
    const session: WorkshopBetaAuthSession = {
      sessionId: `wbeta_sess_${randomUUID().replace(/-/g, "").slice(0, 18)}`,
      email,
      provider,
      status: "pending",
      tokenHash: sha256(token),
      createdAtIso: nowIso(),
      expiresAtIso: addMinutes(20)
    };
    const store = await this.load();
    await this.save({
      ...store,
      authSessions: [session, ...store.authSessions].slice(0, 200)
    });
    return {
      schemaVersion: "santaclawz-workshop-beta-auth-start/0.1",
      sessionId: session.sessionId,
      email: session.email,
      provider: session.provider,
      status: session.status,
      expiresAtIso: session.expiresAtIso,
      // Hidden beta: expose a local verification token until an email provider is attached.
      verificationToken: token
    };
  }

  async verifyAuthSession(input: { sessionId: unknown; token: unknown }) {
    const sessionId = requiredString(input.sessionId, "sessionId", 120);
    const token = requiredString(input.token, "token", 240);
    const store = await this.load();
    const session = store.authSessions.find((item) => item.sessionId === sessionId);
    if (!session) {
      throw new Error("Auth session was not found.");
    }
    if (session.status !== "pending") {
      return {
        schemaVersion: "santaclawz-workshop-beta-auth-session/0.1",
        session: { ...session, tokenHash: undefined }
      };
    }
    if (Date.parse(session.expiresAtIso) <= Date.now()) {
      session.status = "expired";
      await this.save(store);
      throw new Error("Auth session expired.");
    }
    if (!safeTimingEqual(session.tokenHash, sha256(token))) {
      throw new Error("Auth token is invalid.");
    }
    const nextSession: WorkshopBetaAuthSession = {
      ...session,
      status: "verified",
      verifiedAtIso: nowIso()
    };
    await this.save({
      ...store,
      authSessions: store.authSessions.map((item) => item.sessionId === sessionId ? nextSession : item)
    });
    return {
      schemaVersion: "santaclawz-workshop-beta-auth-session/0.1",
      session: { ...nextSession, tokenHash: undefined }
    };
  }

  async issueAdminChallenge(input: {
    sessionId: unknown;
    workshopId?: unknown;
    missionAuthAuthorityBaseUrl?: unknown;
  }) {
    const sessionId = requiredString(input.sessionId, "sessionId", 120);
    const store = await this.load();
    const session = store.authSessions.find((item) => item.sessionId === sessionId && item.status === "verified");
    if (!session) {
      throw new Error("Verified beta auth session is required.");
    }
    const missionAuthAuthorityBaseUrl = optionalString(input.missionAuthAuthorityBaseUrl, 500);
    const challenge: WorkshopBetaAdminChallenge = {
      challengeId: `wbeta_chal_${randomUUID().replace(/-/g, "").slice(0, 18)}`,
      sessionId,
      emailHash: sha256(session.email),
      workshopId: sanitizeId(input.workshopId, "workshop_beta"),
      requestedRole: "workshop_admin",
      nonce: randomUUID().replace(/-/g, ""),
      audience: "santaclawz-workshop-beta-admin-binding",
      status: "issued",
      ...(missionAuthAuthorityBaseUrl ? { missionAuthAuthorityBaseUrl } : {}),
      createdAtIso: nowIso(),
      expiresAtIso: addMinutes(30)
    };
    await this.save({
      ...store,
      adminChallenges: [challenge, ...store.adminChallenges].slice(0, 300)
    });
    return {
      schemaVersion: "santaclawz-workshop-beta-admin-challenge/0.1",
      challenge
    };
  }

  async claimAdminChallenge(input: {
    challengeId: unknown;
    agentId: unknown;
    agentName?: unknown;
    signature?: unknown;
    publicKey?: unknown;
    claimDigestSha256?: unknown;
  }) {
    const challengeId = requiredString(input.challengeId, "challengeId", 120);
    const agentId = requiredString(input.agentId, "agentId", 180);
    const store = await this.load();
    const challenge = store.adminChallenges.find((item) => item.challengeId === challengeId);
    if (!challenge) {
      throw new Error("Admin challenge was not found.");
    }
    if (Date.parse(challenge.expiresAtIso) <= Date.now()) {
      const expired = { ...challenge, status: "expired" as const };
      await this.save({
        ...store,
        adminChallenges: store.adminChallenges.map((item) => item.challengeId === challengeId ? expired : item)
      });
      throw new Error("Admin challenge expired.");
    }
    if (challenge.status !== "issued" && challenge.status !== "claimed") {
      throw new Error(`Admin challenge cannot be claimed from ${challenge.status}.`);
    }
    const signature = optionalString(input.signature, 2000);
    const publicKey = optionalString(input.publicKey, 500);
    const suppliedDigest = optionalString(input.claimDigestSha256, 80);
    const claimDigestSha256 = suppliedDigest && /^[a-f0-9]{64}$/.test(suppliedDigest)
      ? suppliedDigest
      : sha256(JSON.stringify({
          challengeId,
          agentId,
          nonce: challenge.nonce,
          audience: challenge.audience
        }));
    const agentName = optionalString(input.agentName, 160);
    const nextChallenge: WorkshopBetaAdminChallenge = {
      ...challenge,
      status: "claimed",
      agentId,
      ...(agentName ? { agentName } : {}),
      claimDigestSha256,
      ...(signature ? { signature } : {}),
      ...(publicKey ? { publicKey } : {}),
      claimedAtIso: nowIso()
    };
    const binding: WorkshopBetaAdminBinding = {
      bindingId: `wbeta_bind_${randomUUID().replace(/-/g, "").slice(0, 18)}`,
      sessionId: challenge.sessionId,
      emailHash: challenge.emailHash,
      workshopId: challenge.workshopId,
      agentId,
      ...(agentName ? { agentName } : {}),
      role: "workshop_admin",
      status: "claimed",
      challengeId,
      createdAtIso: nowIso()
    };
    await this.save({
      ...store,
      adminChallenges: store.adminChallenges.map((item) => item.challengeId === challengeId ? nextChallenge : item),
      adminBindings: [binding, ...store.adminBindings.filter((item) =>
        !(item.sessionId === challenge.sessionId && item.agentId === agentId && item.status !== "revoked")
      )].slice(0, 300)
    });
    return {
      schemaVersion: "santaclawz-workshop-beta-admin-binding/0.1",
      challenge: nextChallenge,
      binding
    };
  }

  async createMission(input: {
    sessionId?: unknown;
    adminBindingId?: unknown;
    workspaceId?: unknown;
    title?: unknown;
    goal?: unknown;
    visibility?: unknown;
    allowedAgentIds?: unknown;
    dataRules?: unknown;
    successCriteria?: unknown;
    budgetUsd?: unknown;
    expiresAtIso?: unknown;
  }) {
    const store = await this.load();
    const title = requiredString(input.title, "title", 160);
    const goal = requiredString(input.goal, "goal", 2000);
    const workspaceId = sanitizeId(input.workspaceId, "workshop_beta");
    const allowedAgentIds = Array.isArray(input.allowedAgentIds)
      ? input.allowedAgentIds.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 50)
      : [];
    const dataRules = optionalString(input.dataRules, 2000) ?? "Private by default. Public receipts expose proof metadata only.";
    const successCriteria = optionalString(input.successCriteria, 2000) ?? "Mission completes when the required receipt is confirmed and reviewed.";
    const budgetUsd = optionalString(input.budgetUsd, 40);
    const expiresAtIso = optionalString(input.expiresAtIso, 80);
    const createdBySessionId = optionalString(input.sessionId, 120);
    const adminBindingId = optionalString(input.adminBindingId, 120);
    const visibility = sanitizeVisibility(input.visibility);
    const missionHash = buildMissionHash({
      workspaceId,
      title,
      goal,
      visibility,
      allowedAgentIds,
      dataRules,
      successCriteria,
      ...(budgetUsd ? { budgetUsd } : {}),
      ...(expiresAtIso ? { expiresAtIso } : {})
    });
    const mission: WorkshopBetaMission = {
      missionId: `wbeta_mission_${randomUUID().replace(/-/g, "").slice(0, 18)}`,
      workspaceId,
      title,
      goal,
      visibility,
      allowedAgentIds,
      dataRules,
      successCriteria,
      ...(budgetUsd ? { budgetUsd } : {}),
      missionHash,
      status: "draft_mission",
      ...(createdBySessionId ? { createdBySessionId } : {}),
      ...(adminBindingId ? { adminBindingId } : {}),
      createdAtIso: nowIso(),
      updatedAtIso: nowIso(),
      ...(expiresAtIso ? { expiresAtIso } : {})
    };
    await this.save({
      ...store,
      missions: [mission, ...store.missions].slice(0, 500)
    });
    return {
      schemaVersion: "santaclawz-workshop-beta-mission/0.1",
      mission
    };
  }

  async transitionMission(input: { missionId: unknown; status: unknown }) {
    const missionId = requiredString(input.missionId, "missionId", 120);
    const nextStatus = requiredString(input.status, "status", 80) as WorkshopBetaMissionStatus;
    if (!Object.hasOwn(WORKSHOP_BETA_ALLOWED_TRANSITIONS, nextStatus)) {
      throw new Error("Unsupported mission status.");
    }
    const store = await this.load();
    const mission = store.missions.find((item) => item.missionId === missionId);
    if (!mission) {
      throw new Error("Mission was not found.");
    }
    if (!WORKSHOP_BETA_ALLOWED_TRANSITIONS[mission.status].includes(nextStatus)) {
      throw new Error(`Mission cannot transition from ${mission.status} to ${nextStatus}.`);
    }
    const nextMission: WorkshopBetaMission = {
      ...mission,
      status: nextStatus,
      updatedAtIso: nowIso()
    };
    await this.save({
      ...store,
      missions: store.missions.map((item) => item.missionId === missionId ? nextMission : item)
    });
    return {
      schemaVersion: "santaclawz-workshop-beta-mission-transition/0.1",
      mission: nextMission
    };
  }

  async claimMission(input: { missionId: unknown; agentId: unknown; role?: unknown; scope?: unknown }) {
    const missionId = requiredString(input.missionId, "missionId", 120);
    const agentId = requiredString(input.agentId, "agentId", 180);
    const role = sanitizeRole(input.role);
    const scope = optionalString(input.scope, 2000) ?? `${role}:${agentId}:${missionId}`;
    const store = await this.load();
    const mission = store.missions.find((item) => item.missionId === missionId);
    if (!mission) {
      throw new Error("Mission was not found.");
    }
    const claim: WorkshopBetaAgentClaim = {
      claimId: `wbeta_claim_${randomUUID().replace(/-/g, "").slice(0, 18)}`,
      missionId,
      agentId,
      role,
      status: "claimed",
      scopeDigestSha256: sha256(scope),
      createdAtIso: nowIso(),
      updatedAtIso: nowIso()
    };
    const missionShouldAdvance = mission.status === "mission_issued" || mission.status === "agents_invited";
    const nextMission: WorkshopBetaMission = missionShouldAdvance
      ? { ...mission, status: "agents_claimed", updatedAtIso: nowIso() }
      : mission;
    await this.save({
      ...store,
      missions: store.missions.map((item) => item.missionId === missionId ? nextMission : item),
      agentClaims: [claim, ...store.agentClaims].slice(0, 1000)
    });
    return {
      schemaVersion: "santaclawz-workshop-beta-agent-claim/0.1",
      claim,
      mission: nextMission
    };
  }

  async dashboard(input: {
    agents: AgentRegistryEntry[];
    agentBoard: AgentBoardState;
    socialAnchorQueue: SocialAnchorQueueState;
    paymentLedger: PaymentLedgerState;
  }): Promise<WorkshopBetaDashboardSnapshot> {
    const store = await this.load();
    const activeChallenges = store.adminChallenges.filter((challenge) =>
      challenge.status === "issued" && Date.parse(challenge.expiresAtIso) > Date.now()
    );
    const activeMissions = store.missions.filter((mission) => !WORKSHOP_BETA_TERMINAL_STATES.has(mission.status));
    return {
      schemaVersion: "santaclawz-workshop-beta-dashboard/0.1",
      generatedAtIso: nowIso(),
      stageOrder: WORKSHOP_BETA_STAGE_ORDER,
      controlPlane: {
        authSessionCount: store.authSessions.filter((session) => session.status === "verified").length,
        activeAdminChallengeCount: activeChallenges.length,
        adminBindingCount: store.adminBindings.filter((binding) => binding.status !== "revoked").length,
        verifiedAdminBindingCount: store.adminBindings.filter((binding) => binding.status === "verified").length,
        missionCount: store.missions.length,
        activeMissionCount: activeMissions.length,
        agentClaimCount: store.agentClaims.filter((claim) => claim.status !== "revoked").length
      },
      liveNetwork: {
        totalAgentCount: input.agents.length,
        onlineAgentCount: input.agents.filter((agent) => agent.runtimeStatus === "live").length,
        missionAuthVerifiedAgentCount: input.agents.filter((agent) => agent.missionAuthVerified).length,
        workshopReceiptCount: input.agentBoard.totalVisibleMessages,
        recentWorkshopReceiptCount: input.agentBoard.messages.length,
        confirmedProofCount: input.socialAnchorQueue.confirmedCount,
        pendingProofCount: input.socialAnchorQueue.pendingCount + input.socialAnchorQueue.submittedCount + input.socialAnchorQueue.retryingCount,
        failedProofCount: input.socialAnchorQueue.failedCount + input.socialAnchorQueue.expiredCount,
        completedPaymentCount: input.paymentLedger.summary?.completedPaymentCount ?? 0,
        completedSellerPayoutUsd: input.paymentLedger.summary?.completedSellerPayoutUsd ?? "0"
      },
      adminChallenges: sortNewest(store.adminChallenges).slice(0, 8),
      adminBindings: sortNewest(store.adminBindings).slice(0, 8),
      missions: sortNewest(store.missions).slice(0, 8),
      agentClaims: sortNewest(store.agentClaims).slice(0, 12),
      recentReceipts: input.agentBoard.messages.slice(0, 8),
      recommendedNextActions: summarizeNextActions(store)
    };
  }
}
