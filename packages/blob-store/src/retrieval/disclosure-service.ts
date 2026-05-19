import type { PrivacyException } from "@clawz/protocol";

import type { SealedBlobManifest } from "../types.js";

export interface ScopedDisclosurePackage {
  manifestId: string;
  artifactClass: string;
  payloadDigest: string;
  privacyExceptionId: string;
  expiresAtIso: string;
}

export function buildScopedDisclosurePackage(
  manifest: SealedBlobManifest,
  privacyException: PrivacyException
): ScopedDisclosurePackage {
  return {
    manifestId: manifest.manifestId,
    artifactClass: manifest.artifactClass,
    payloadDigest: manifest.payloadDigest,
    privacyExceptionId: privacyException.exceptionId,
    expiresAtIso: privacyException.expiresAtIso
  };
}
