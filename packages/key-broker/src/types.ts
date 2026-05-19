import type { ArtifactVisibility } from "@clawz/protocol";

export type KeyActorRole =
  | "participant"
  | "workspace-member"
  | "operator"
  | "tenant-admin"
  | "compliance-reviewer";

export type TenantKeyBrokerRuntimeMode =
  | "durable-local-file-backed"
  | "external-kms-backed"
  | "in-memory-default-export";

export interface TenantKeyBrokerRuntimeDescriptor {
  mode: TenantKeyBrokerRuntimeMode;
  baseDir?: string;
  wrappedKeyDir?: string;
  externalKmsEndpoint?: string;
  externalKmsAuthConfigured?: boolean;
}

export interface KeyScope {
  tenantId: string;
  workspaceId: string;
  sessionId?: string;
  turnId?: string;
}

export interface WrappedKeyRecord {
  keyId: string;
  scope: KeyScope;
  visibility: ArtifactVisibility;
  wrappedDekBase64: string;
  wrapIvBase64: string;
  wrapTagBase64: string;
  createdAtIso: string;
  revokedAtIso?: string;
  metadataDigest: string;
}

export interface UnwrapRequest {
  keyId: string;
  actorId: string;
  actorRole: KeyActorRole;
  privacyExceptionId?: string;
}

export interface AccessDecision {
  allowed: boolean;
  reason: string;
}

export interface TenantKms {
  getTenantKey(tenantId: string): Promise<Buffer>;
  getWorkspaceKey(tenantId: string, workspaceId: string): Promise<Buffer>;
}

export interface WrappedKeyStore {
  save(record: WrappedKeyRecord): Promise<void>;
  get(keyId: string): Promise<WrappedKeyRecord | undefined>;
  list(): Promise<WrappedKeyRecord[]>;
}
