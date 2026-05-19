import type { RetentionPolicy } from "@clawz/protocol";

import type { SealedBlobManifest } from "../types.js";

export function expiresAt(manifest: SealedBlobManifest, retentionPolicy: RetentionPolicy): string {
  const created = Date.parse(manifest.createdAtIso);
  const ttlMs = retentionPolicy.artifactTtlHours * 60 * 60 * 1000;
  return new Date(created + ttlMs).toISOString();
}

export function isExpired(manifest: SealedBlobManifest, retentionPolicy: RetentionPolicy, nowIso: string): boolean {
  return expiresAt(manifest, retentionPolicy) <= nowIso;
}
