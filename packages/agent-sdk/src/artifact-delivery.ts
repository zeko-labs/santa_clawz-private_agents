import { createHash } from "node:crypto";

export interface SantaClawzBuyerInboxArtifact {
  filename: string;
  contentType?: string;
  sizeBytes: number;
  digestSha256: string;
  artifactUrl?: string;
}

export interface SantaClawzBuyerInboxEnvelopeInput {
  requestId: string;
  artifact: SantaClawzBuyerInboxArtifact;
  deliveryChannel: string;
  deliveredAtIso?: string;
  sellerAgentId?: string;
  sellerDeliveryReceipt?: string;
  sellerSignature?: string;
  receiptManifestUrl?: string;
  scanPolicy?: "buyer_required" | "external_verified" | "none";
}

export interface SantaClawzBuyerInboxEnvelope {
  schema_version: "santaclawz-buyer-inbox-delivery/1.0";
  request_id: string;
  delivery_mode: "direct_receipt";
  transport: "buyer_agent_inbox";
  delivered_at_iso: string;
  delivery_channel: string;
  scan_policy: "buyer_required" | "external_verified" | "none";
  artifact: {
    filename: string;
    content_type: string;
    size_bytes: number;
    digest_sha256: string;
    artifact_url?: string;
  };
  seller: {
    agent_id?: string;
    delivery_receipt?: string;
    signature?: string;
  };
  santaclawz: {
    receipt_manifest_url?: string;
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, unknown] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return createHash("sha256")
    .update(bytes.toString("binary"), "binary")
    .digest("hex");
}

export function buildSantaClawzBuyerInboxEnvelope(
  input: SantaClawzBuyerInboxEnvelopeInput
): SantaClawzBuyerInboxEnvelope {
  const requestId = input.requestId.trim();
  const filename = input.artifact.filename.trim();
  const digestSha256 = input.artifact.digestSha256.trim().toLowerCase();
  if (!requestId) {
    throw new Error("Buyer inbox envelope requires requestId.");
  }
  if (!filename) {
    throw new Error("Buyer inbox envelope requires artifact.filename.");
  }
  if (!/^[a-f0-9]{64}$/.test(digestSha256)) {
    throw new Error("Buyer inbox envelope requires a 64-character lowercase artifact.digestSha256.");
  }
  if (!Number.isFinite(input.artifact.sizeBytes) || input.artifact.sizeBytes <= 0) {
    throw new Error("Buyer inbox envelope requires artifact.sizeBytes to be positive.");
  }

  return {
    schema_version: "santaclawz-buyer-inbox-delivery/1.0",
    request_id: requestId,
    delivery_mode: "direct_receipt",
    transport: "buyer_agent_inbox",
    delivered_at_iso: input.deliveredAtIso?.trim() || new Date().toISOString(),
    delivery_channel: input.deliveryChannel.trim(),
    scan_policy: input.scanPolicy ?? "buyer_required",
    artifact: {
      filename,
      content_type: input.artifact.contentType?.trim() || "application/octet-stream",
      size_bytes: Math.floor(input.artifact.sizeBytes),
      digest_sha256: digestSha256,
      ...(input.artifact.artifactUrl?.trim() ? { artifact_url: input.artifact.artifactUrl.trim() } : {})
    },
    seller: {
      ...(input.sellerAgentId?.trim() ? { agent_id: input.sellerAgentId.trim() } : {}),
      ...(input.sellerDeliveryReceipt?.trim() ? { delivery_receipt: input.sellerDeliveryReceipt.trim() } : {}),
      ...(input.sellerSignature?.trim() ? { signature: input.sellerSignature.trim() } : {})
    },
    santaclawz: {
      ...(input.receiptManifestUrl?.trim() ? { receipt_manifest_url: input.receiptManifestUrl.trim() } : {})
    }
  };
}

export function buyerInboxEnvelopeDigestSha256(envelope: SantaClawzBuyerInboxEnvelope): string {
  return sha256Hex(stableJson({
    ...envelope,
    seller: {
      agent_id: envelope.seller.agent_id,
      delivery_receipt: envelope.seller.delivery_receipt
    }
  }));
}

export function artifactBytesDigestMatches(input: { bytes: string | Uint8Array; expectedSha256: string }): boolean {
  return sha256Hex(input.bytes) === input.expectedSha256.trim().toLowerCase();
}
