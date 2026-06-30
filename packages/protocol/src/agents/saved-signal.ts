export const SANTACLAWZ_AGENT_SAVED_SIGNAL_SCHEMA_VERSION = "santaclawz-agent-saved-signal/0.1" as const;

export type SantaClawzAgentSavedByType = "human" | "agent" | "app";

export interface SantaClawzAgentSavedSignalInput {
  agentId: string;
  platformId: string;
  savedByType: SantaClawzAgentSavedByType;
  savedByHash: string;
}

export interface SantaClawzAgentSavedSignalRecord extends SantaClawzAgentSavedSignalInput {
  schemaVersion: typeof SANTACLAWZ_AGENT_SAVED_SIGNAL_SCHEMA_VERSION;
  signalId: string;
  active: boolean;
  createdAtIso: string;
  updatedAtIso: string;
  removedAtIso?: string;
}

export const SANTACLAWZ_AGENT_SAVED_BY_TYPES: readonly SantaClawzAgentSavedByType[] = ["human", "agent", "app"] as const;

const AGENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{1,180}$/;
const PLATFORM_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SAVED_BY_HASH_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{5,191}$/;

function normalizeNonEmptyString(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required.`);
  }
  return normalized;
}

export function normalizeSantaClawzAgentSavedSignalInput(input: SantaClawzAgentSavedSignalInput): SantaClawzAgentSavedSignalInput {
  const agentId = normalizeNonEmptyString(input.agentId, "agentId");
  const platformId = normalizeNonEmptyString(input.platformId, "platformId").toLowerCase();
  const savedByHash = normalizeNonEmptyString(input.savedByHash, "savedByHash");
  const savedByType = input.savedByType;

  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new Error("agentId is invalid.");
  }
  if (!PLATFORM_ID_PATTERN.test(platformId)) {
    throw new Error("platformId is invalid.");
  }
  if (!SANTACLAWZ_AGENT_SAVED_BY_TYPES.includes(savedByType)) {
    throw new Error("savedByType must be human, agent, or app.");
  }
  if (!SAVED_BY_HASH_PATTERN.test(savedByHash)) {
    throw new Error("savedByHash is invalid.");
  }

  return {
    agentId,
    platformId,
    savedByType,
    savedByHash
  };
}

