import { buildOriginProofRoot, canonicalDigest, type ZkTlsOriginProof } from "@clawz/protocol";

import type { OriginProofAdapter, OriginProofAttestationRequest, OriginProofAttestationResult } from "./types.js";

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function buildVerifierKeyHash(request: OriginProofAttestationRequest, verifierSystem: string): string {
  return canonicalDigest({
    verifierSystem,
    host: request.host,
    method: request.method,
    requestTemplateHash: request.requestTemplateHash
  }).sha256Hex;
}

export function buildNoopOriginProofAttestation(request: OriginProofAttestationRequest): OriginProofAttestationResult {
  const attestedAtIso = request.attestedAtIso ?? new Date().toISOString();
  const verifierSystem = request.verifierSystem ?? "clawz-noop-zktls";
  const verifierKeyHash = request.verifierKeyHash ?? buildVerifierKeyHash(request, verifierSystem);
  const responseStatus = request.responseStatus ?? 200;
  const disclosureClass = request.disclosureClass ?? "self-only";
  const responseHeaderDigest = canonicalDigest(request.responseHeaders ?? { "content-type": "application/json" }).sha256Hex;
  const requestHeaderAllowlistHash = canonicalDigest(
    request.requestHeaderAllowlist ?? ["accept", "if-none-match", "user-agent"]
  ).sha256Hex;
  const responseBodyDigest =
    request.responseBodyDigest ??
    canonicalDigest({
      host: request.host,
      selectorHash: request.selectorHash,
      stepId: request.stepId,
      turnId: request.turnId
    }).sha256Hex;
  const extractedFactDigest =
    request.extractedFactDigest ??
    canonicalDigest({
      selectorHash: request.selectorHash,
      responseBodyDigest,
      sessionId: request.sessionId,
      turnId: request.turnId
    }).sha256Hex;

  const originProof: ZkTlsOriginProof = {
    originProofId: `origin_${canonicalDigest({
      sessionId: request.sessionId,
      turnId: request.turnId,
      stepId: request.stepId,
      host: request.host,
      attestedAtIso
    }).sha256Hex.slice(0, 16)}`,
    sessionId: request.sessionId,
    turnId: request.turnId,
    stepId: request.stepId,
    host: request.host,
    method: request.method,
    requestTemplateHash: request.requestTemplateHash,
    requestHeaderAllowlistHash,
    responseStatus,
    responseHeaderDigest,
    responseBodyDigest,
    extractedFactDigest,
    ...(request.selectiveRevealDigest ? { selectiveRevealDigest: request.selectiveRevealDigest } : {}),
    verifierKeyHash,
    verifierSystem,
    attestedAtIso,
    expiresAtIso: request.expiresAtIso ?? addSeconds(attestedAtIso, request.freshnessWindowSeconds),
    disclosureClass,
    ...(request.rawTranscriptManifestId ? { rawTranscriptManifestId: request.rawTranscriptManifestId } : {})
  };

  return {
    originProof,
    originProofDigest: canonicalDigest(originProof).sha256Hex,
    originProofRoot: buildOriginProofRoot([originProof]).sha256Hex,
    ...(request.rawTranscriptManifestId ? { sealedManifestId: request.rawTranscriptManifestId } : {})
  };
}

export class NoopOriginProofAdapter implements OriginProofAdapter {
  async createAttestation(request: OriginProofAttestationRequest): Promise<OriginProofAttestationResult> {
    return buildNoopOriginProofAttestation(request);
  }
}
