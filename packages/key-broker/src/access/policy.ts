import type { ArtifactVisibility } from "@clawz/protocol";

import type { AccessDecision, KeyActorRole, WrappedKeyRecord, UnwrapRequest } from "../types.js";

function requiresPrivacyException(visibility: ArtifactVisibility, actorRole: KeyActorRole): boolean {
  if (visibility === "operator-blind" && actorRole === "operator") {
    return true;
  }

  if (visibility === "compliance-sealed" && actorRole !== "compliance-reviewer") {
    return true;
  }

  return false;
}

export function evaluateAccess(record: WrappedKeyRecord, request: UnwrapRequest): AccessDecision {
  if (record.revokedAtIso) {
    return {
      allowed: false,
      reason: "Key material has already been revoked."
    };
  }

  const role = request.actorRole;
  const visibility = record.visibility;

  if (visibility === "ephemeral" && role !== "participant") {
    return {
      allowed: false,
      reason: "Ephemeral artifacts may only be decrypted by the original participant."
    };
  }

  if (visibility === "team-sealed" && role === "operator") {
    return {
      allowed: false,
      reason: "Operators are blind to team-sealed artifacts without disclosure."
    };
  }

  if (requiresPrivacyException(visibility, role) && !request.privacyExceptionId) {
    return {
      allowed: false,
      reason: "This visibility class requires a privacy exception reference."
    };
  }

  return {
    allowed: true,
    reason: "Access permitted by visibility policy."
  };
}
