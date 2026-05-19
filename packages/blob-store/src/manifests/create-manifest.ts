import { randomUUID } from "node:crypto";

import { canonicalDigest } from "@clawz/protocol";

import type { SealBlobInput, SealedBlobManifest } from "../types.js";

export function createManifest(
  input: SealBlobInput,
  cipherPath: string,
  wrappedKeyId: string,
  payloadDigest: string,
  byteLength: number
): SealedBlobManifest {
  const manifestId = `manifest_${input.scope.tenantId}_${randomUUID()}`;
  const createdAtIso = new Date().toISOString();
  const metadataDigest = canonicalDigest({
    manifestId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    artifactClass: input.artifactClass,
    scope: input.scope,
    visibility: input.visibility,
    retentionPolicyId: input.retentionPolicy.policyId,
    cipherPath,
    wrappedKeyId,
    payloadDigest,
    byteLength,
    createdAtIso
  }).sha256Hex;

  return {
    manifestId,
    sessionId: input.sessionId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    artifactClass: input.artifactClass,
    scope: input.scope,
    visibility: input.visibility,
    retentionPolicyId: input.retentionPolicy.policyId,
    cipherPath,
    wrappedKeyId,
    payloadDigest,
    metadataDigest,
    byteLength,
    createdAtIso
  };
}
