import { canonicalDigest } from "../hashing/digest.js";

export const SANTACLAWZ_HIRE_RETURN_SCHEMA_VERSION = "santaclawz-return/1.0" as const;

export interface SantaClawzReturnDeliverable {
  name: string;
  sha256: string;
}

export interface SantaClawzVerificationManifest {
  input_digest_sha256: string;
  checks_performed: string[];
  files_produced: string[];
  blocked_suspicious_instructions: string[];
  [key: string]: unknown;
}

export interface SantaClawzCompletedReturnPackage {
  schema_version: typeof SANTACLAWZ_HIRE_RETURN_SCHEMA_VERSION;
  request_id: string;
  status: "completed";
  agent_private: true;
  verified_output: {
    package_hash: string;
    hash_algorithm: "sha256";
    verification_manifest: SantaClawzVerificationManifest;
    deliverables: SantaClawzReturnDeliverable[];
  };
}

export interface BuildSantaClawzCompletedReturnInput {
  requestId: string;
  packageHash: string;
  inputDigestSha256: string;
  verificationManifest?: Partial<SantaClawzVerificationManifest>;
  deliverables?: Array<Partial<SantaClawzReturnDeliverable>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSha256Hex(value: string, label: string) {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${label} must be a 64-character sha256 hex digest.`);
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function normalizeDeliverables(value: unknown): SantaClawzReturnDeliverable[] {
  const rawDeliverables = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  return rawDeliverables.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`SantaClawz return deliverable ${index} must be an object.`);
    }
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : `deliverable-${index + 1}`;
    const sha256 = typeof entry.sha256 === "string" ? entry.sha256.trim() : "";
    assertSha256Hex(sha256, `SantaClawz return deliverable ${index} sha256`);
    return { name, sha256 };
  });
}

export function buildSantaClawzCompletedReturn(
  input: BuildSantaClawzCompletedReturnInput
): SantaClawzCompletedReturnPackage {
  assertSha256Hex(input.packageHash, "SantaClawz return packageHash");
  assertSha256Hex(input.inputDigestSha256, "SantaClawz return inputDigestSha256");

  const verificationManifest: SantaClawzVerificationManifest = {
    ...(input.verificationManifest ?? {}),
    input_digest_sha256: input.inputDigestSha256,
    checks_performed: stringArray(input.verificationManifest?.checks_performed),
    files_produced: stringArray(input.verificationManifest?.files_produced),
    blocked_suspicious_instructions: stringArray(input.verificationManifest?.blocked_suspicious_instructions)
  };

  return {
    schema_version: SANTACLAWZ_HIRE_RETURN_SCHEMA_VERSION,
    request_id: input.requestId,
    status: "completed",
    agent_private: true,
    verified_output: {
      package_hash: input.packageHash,
      hash_algorithm: "sha256",
      verification_manifest: verificationManifest,
      deliverables: normalizeDeliverables(input.deliverables ?? [])
    }
  };
}

export function normalizeSantaClawzCompletedReturn(
  value: unknown,
  fallback: { requestId: string; inputDigestSha256: string }
): SantaClawzCompletedReturnPackage {
  if (!isRecord(value)) {
    throw new Error("SantaClawz return package must be an object.");
  }
  if (value.status !== "completed") {
    throw new Error("SantaClawz return package status must be completed.");
  }
  const verifiedOutput = isRecord(value.verified_output) ? value.verified_output : undefined;
  if (!verifiedOutput) {
    throw new Error("Completed SantaClawz return package must include verified_output.");
  }
  const packageHash = typeof verifiedOutput.package_hash === "string" ? verifiedOutput.package_hash.trim() : "";
  const verificationManifest = isRecord(verifiedOutput.verification_manifest)
    ? verifiedOutput.verification_manifest
    : {};
  const inputDigestSha256 =
    typeof verificationManifest.input_digest_sha256 === "string"
      ? verificationManifest.input_digest_sha256.trim()
      : fallback.inputDigestSha256;

  return buildSantaClawzCompletedReturn({
    requestId: typeof value.request_id === "string" && value.request_id.trim() ? value.request_id.trim() : fallback.requestId,
    packageHash,
    inputDigestSha256,
    verificationManifest,
    deliverables: normalizeDeliverables(verifiedOutput.deliverables)
  });
}

export function santaClawzReturnDigest(value: unknown) {
  return canonicalDigest(value).sha256Hex;
}
