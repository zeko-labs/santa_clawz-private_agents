import type { ZkTlsOriginProof } from "@clawz/protocol";

export interface OriginProofAttestationRequest {
  sessionId: string;
  turnId: string;
  stepId: string;
  host: string;
  method: "GET" | "POST";
  requestTemplateHash: string;
  selectorHash: string;
  freshnessWindowSeconds: number;
  disclosureClass?: ZkTlsOriginProof["disclosureClass"];
  requestHeaderAllowlist?: string[];
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  responseBodyDigest?: string;
  extractedFactDigest?: string;
  selectiveRevealDigest?: string;
  verifierSystem?: string;
  verifierKeyHash?: string;
  attestedAtIso?: string;
  expiresAtIso?: string;
  rawTranscriptManifestId?: string;
}

export interface OriginProofAttestationResult {
  originProof: ZkTlsOriginProof;
  originProofDigest: string;
  originProofRoot: string;
  sealedManifestId?: string;
}

export interface OriginProofAdapter {
  createAttestation(request: OriginProofAttestationRequest): Promise<OriginProofAttestationResult>;
}
