import type { ArtifactVisibility, RetentionPolicy } from "@clawz/protocol";

import type { KeyScope } from "@clawz/key-broker";

export interface SealBlobInput {
  scope: KeyScope;
  visibility: ArtifactVisibility;
  retentionPolicy: RetentionPolicy;
  sessionId: string;
  turnId?: string;
  artifactClass: string;
  payload: unknown;
}

export interface SealedBlobManifest {
  manifestId: string;
  sessionId: string;
  turnId?: string;
  artifactClass: string;
  scope: KeyScope;
  visibility: ArtifactVisibility;
  retentionPolicyId: string;
  cipherPath: string;
  wrappedKeyId: string;
  payloadDigest: string;
  metadataDigest: string;
  byteLength: number;
  createdAtIso: string;
}

export interface StoredCipherEnvelope {
  cipherTextBase64: string;
  ivBase64: string;
  authTagBase64: string;
}

export interface SealedBlobStore {
  ensureDirs(): Promise<void>;
  sealJson(input: SealBlobInput): Promise<SealedBlobManifest>;
  readJson(manifestId: string, request: import("@clawz/key-broker").UnwrapRequest): Promise<unknown>;
  listManifests(sessionId?: string): Promise<SealedBlobManifest[]>;
  getManifest(manifestId: string): Promise<SealedBlobManifest | undefined>;
  expireManifest(
    manifestId: string,
    retentionPolicy: RetentionPolicy,
    deletedAtIso?: string
  ): Promise<import("@clawz/protocol").DeletionRecord | undefined>;
  listDeletionRecords(): Promise<import("@clawz/protocol").DeletionRecord[]>;
}
