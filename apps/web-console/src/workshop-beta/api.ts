import { getApiBase } from "../api.js";
import type {
  WorkshopBetaAuthStartResponse,
  WorkshopBetaDashboardSnapshot,
  WorkshopBetaMissionStatus,
  WorkshopBetaVisibilityMode
} from "./types.js";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiBase()}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as T & { error?: string } : undefined;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Request failed with ${response.status}.`);
  }
  return payload as T;
}

export function fetchWorkshopBetaDashboard() {
  return requestJson<WorkshopBetaDashboardSnapshot>("/api/workshop-beta/dashboard");
}

export function startWorkshopBetaAuth(input: { email: string; provider?: "email_magic_link" | "google_oidc" }) {
  return requestJson<WorkshopBetaAuthStartResponse>("/api/workshop-beta/auth/start", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function verifyWorkshopBetaAuth(input: { sessionId: string; token: string }) {
  return requestJson<unknown>("/api/workshop-beta/auth/verify", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function issueWorkshopBetaAdminChallenge(input: {
  sessionId: string;
  workshopId: string;
  missionAuthAuthorityBaseUrl?: string;
}) {
  return requestJson<unknown>("/api/workshop-beta/admin-challenges", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function claimWorkshopBetaAdminChallenge(input: {
  challengeId: string;
  agentId: string;
  agentName?: string;
  signature?: string;
  publicKey?: string;
}) {
  return requestJson<unknown>("/api/workshop-beta/admin-challenges/claim", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function createWorkshopBetaMission(input: {
  sessionId?: string;
  adminBindingId?: string;
  workspaceId: string;
  title: string;
  goal: string;
  visibility: WorkshopBetaVisibilityMode;
  allowedAgentIds: string[];
  dataRules: string;
  successCriteria: string;
  budgetUsd?: string;
}) {
  return requestJson<unknown>("/api/workshop-beta/missions", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function transitionWorkshopBetaMission(input: { missionId: string; status: WorkshopBetaMissionStatus }) {
  return requestJson<unknown>(`/api/workshop-beta/missions/${encodeURIComponent(input.missionId)}/transition`, {
    method: "POST",
    body: JSON.stringify({ status: input.status })
  });
}

export function claimWorkshopBetaMission(input: {
  missionId: string;
  agentId: string;
  role: "admin" | "worker" | "verifier" | "compiler" | "observer";
  scope?: string;
}) {
  return requestJson<unknown>(`/api/workshop-beta/missions/${encodeURIComponent(input.missionId)}/claims`, {
    method: "POST",
    body: JSON.stringify({
      agentId: input.agentId,
      role: input.role,
      scope: input.scope
    })
  });
}
