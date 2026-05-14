import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Socket } from "node:net";

interface ArtifactMetadata {
  artifactId: string;
  requestId: string;
  createdAtIso: string;
  expiresAtIso: string;
  claimedAtIso?: string;
  filename: string;
  contentType: string;
  plaintextBytes: number;
  encryptedBytes: number;
  digestSha256: string;
  deliveryMode?: ArtifactDeliveryMode;
  safety?: ArtifactSafetyReport;
  ivBase64: string;
  authTagBase64: string;
  tokenHashSha256: string;
}

type ArtifactReceiptDeliveryMode = "direct_receipt" | "external_reference";
type ArtifactReceiptTransport = "buyer_agent_inbox" | "external_url" | "out_of_band" | "custom";
type ArtifactReceiptScanPolicy = "buyer_required" | "external_unverified" | "external_verified" | "none";
type ArtifactReceiptAcceptanceStatus = "pending" | "accepted" | "rejected" | "not_required";

interface ArtifactReceiptMetadata {
  receiptId: string;
  requestId: string;
  createdAtIso: string;
  updatedAtIso: string;
  deliveredAtIso: string;
  deliveryMode: ArtifactReceiptDeliveryMode;
  transport: ArtifactReceiptTransport;
  scanPolicy: ArtifactReceiptScanPolicy;
  digestRequired: true;
  buyerAcceptanceRequired: boolean;
  buyerAcceptanceStatus: ArtifactReceiptAcceptanceStatus;
  buyerAcknowledgedAtIso?: string;
  buyerAcknowledgementNote?: string;
  filename: string;
  contentType: string;
  artifactDigestSha256: string;
  artifactSizeBytes: number;
  artifactUrl?: string;
  deliveryChannel?: string;
  sellerDeliveryReceipt?: string;
  sellerSignature?: string;
  manifestDigestSha256: string;
  tokenHashSha256: string;
}

interface ArtifactCreateOptions {
  requestId: string;
  filename?: string;
  contentType?: string;
  deliveryMode?: ArtifactDeliveryMode;
  body: Buffer;
  baseUrl: string;
}

interface ArtifactReceiptCreateOptions {
  requestId: string;
  deliveryMode: ArtifactReceiptDeliveryMode;
  transport?: ArtifactReceiptTransport;
  scanPolicy?: ArtifactReceiptScanPolicy;
  buyerAcceptanceRequired?: boolean;
  filename: string;
  contentType?: string;
  artifactDigestSha256: string;
  artifactSizeBytes: number;
  artifactUrl?: string;
  deliveryChannel?: string;
  sellerDeliveryReceipt?: string;
  sellerSignature?: string;
  deliveredAtIso?: string;
  baseUrl: string;
}

interface ArtifactCreateResult {
  artifactId: string;
  requestId: string;
  artifactManifestUrl: string;
  artifactDownloadUrl: string;
  artifactBundleDigestSha256: string;
  filename: string;
  contentType: string;
  bytes: number;
  expiresAtIso: string;
  deliveryMode: ArtifactDeliveryMode;
  requiresBuyerDownloadAcceptance: boolean;
  safety: ArtifactSafetyReport;
}

interface ArtifactReceiptPublicMetadata {
  receiptId: string;
  requestId: string;
  createdAtIso: string;
  updatedAtIso: string;
  deliveredAtIso: string;
  deliveryMode: ArtifactReceiptDeliveryMode;
  transport: ArtifactReceiptTransport;
  scanPolicy: ArtifactReceiptScanPolicy;
  digestRequired: true;
  buyerAcceptanceRequired: boolean;
  buyerAcceptanceStatus: ArtifactReceiptAcceptanceStatus;
  buyerAcknowledgedAtIso?: string;
  buyerAcknowledgementNote?: string;
  filename: string;
  contentType: string;
  artifactDigestSha256: string;
  artifactSizeBytes: number;
  artifactUrl?: string;
  deliveryChannel?: string;
  sellerDeliveryReceipt?: string;
  sellerSignature?: string;
  manifestDigestSha256: string;
}

interface ArtifactReceiptCreateResult {
  receipt: ArtifactReceiptPublicMetadata;
  receiptManifestUrl: string;
  buyerAcknowledgementUrl?: string;
  verifiedOutputPatch: {
    artifact_manifest_url: string;
    artifact_bundle_digest_sha256: string;
  };
}

interface ArtifactReadResult {
  metadata: Omit<ArtifactMetadata, "tokenHashSha256" | "ivBase64" | "authTagBase64">;
  body: Buffer;
}

type ArtifactDeliveryMode = "platform_scanned" | "buyer_encrypted";
type ArtifactSafetyStatus = "clean" | "blocked" | "buyer_scan_required" | "scan_unavailable";

interface ArtifactSafetyReport {
  status: ArtifactSafetyStatus;
  scanner: "santaclawz-static-policy-v1" | "santaclawz-private-ciphertext-v1";
  malwareScanner: "not_configured" | "clamav" | "buyer_scan_required" | "scan_unavailable";
  malwareScannerVerdict?: "clean" | "infected" | "unavailable" | "not_scanned";
  malwareSignature?: string;
  scanDurationMs?: number;
  privacyMode: "platform_scanned_then_encrypted_at_rest" | "platform_ciphertext_only_buyer_scan_required";
  platformContentVisibility: "plaintext_during_platform_scan" | "ciphertext_only";
  fileKind: string;
  extension: string;
  declaredContentType: string;
  detectedContentType: string;
  archive?: {
    inspected: boolean;
    entries: number;
    executableEntries: string[];
    nestedArchiveEntries: string[];
    suspiciousEntries: string[];
  };
  reasons: string[];
  buyerMessage: string;
  sellerMessage: string;
}

export class ArtifactSafetyError extends Error {
  constructor(readonly report: ArtifactSafetyReport) {
    super(report.sellerMessage);
  }
}

export class ArtifactScanUnavailableError extends Error {
  constructor(readonly report: ArtifactSafetyReport) {
    super(report.sellerMessage);
  }
}

const SAFE_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".xlsx",
  ".pdf",
  ".docx",
  ".pptx",
  ".png",
  ".jpg",
  ".jpeg",
  ".zip"
]);

const EXECUTABLE_EXTENSIONS = new Set([
  ".app",
  ".bat",
  ".cmd",
  ".com",
  ".dmg",
  ".exe",
  ".jar",
  ".js",
  ".mjs",
  ".pkg",
  ".ps1",
  ".py",
  ".rb",
  ".scr",
  ".sh",
  ".php",
  ".msi",
  ".vbs",
  ".wsf",
  ".xpi",
  ".crx"
]);

const NESTED_ARCHIVE_EXTENSIONS = new Set([".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz"]);

const PRIVATE_ENCRYPTED_EXTENSIONS = new Set([".sczenc", ".enc", ".age", ".gpg", ".pgp"]);

function sha256Hex(value: Buffer | string) {
  const hash = createHash("sha256");
  const update = hash.update as unknown as (input: Buffer | string, encoding?: string) => { digest(encoding: "hex"): string };
  return update.call(hash, value).digest("hex");
}

function parsePositiveInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function envFlag(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function resolveEncryptionKey(baseDir: string) {
  const configured = process.env.CLAWZ_ARTIFACT_ENCRYPTION_KEY_BASE64?.trim();
  if (configured) {
    const decoded = Buffer.from(configured, "base64");
    if (decoded.length !== 32) {
      throw new Error("CLAWZ_ARTIFACT_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes.");
    }
    return decoded;
  }

  return Buffer.from(createHash("sha256").update(`santaclawz-dev-artifact-key:${baseDir}`).digest("hex"), "hex");
}

function safeFilename(value: string | undefined) {
  const fallback = "santaclawz-artifact.bin";
  if (!value?.trim()) {
    return fallback;
  }
  const cleaned = (value.trim().split(/[\\/]/).pop() ?? fallback).replace(/[^\w.\- ]+/g, "_").slice(0, 120).trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function extensionFor(filename: string) {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0) {
    return "";
  }
  return filename.slice(lastDot).toLowerCase();
}

function sanitizeContentType(value: string | undefined) {
  if (!value?.trim()) {
    return "application/octet-stream";
  }
  return value.trim().slice(0, 120);
}

function readUInt16LE(buffer: Uint8Array, offset: number) {
  return (buffer[offset] ?? 0) | ((buffer[offset + 1] ?? 0) << 8);
}

function readUInt32LE(buffer: Uint8Array, offset: number) {
  return (
    (buffer[offset] ?? 0) |
    ((buffer[offset + 1] ?? 0) << 8) |
    ((buffer[offset + 2] ?? 0) << 16) |
    ((buffer[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function startsWithBytes(buffer: Uint8Array, bytes: number[]) {
  return bytes.every((byte, index) => buffer[index] === byte);
}

function detectContentType(body: Buffer, extension: string) {
  if (startsWithBytes(body, [0x25, 0x50, 0x44, 0x46])) {
    return "application/pdf";
  }
  if (startsWithBytes(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWithBytes(body, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (startsWithBytes(body, [0x50, 0x4b, 0x03, 0x04]) || startsWithBytes(body, [0x50, 0x4b, 0x05, 0x06])) {
    return extension === ".docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : extension === ".xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : extension === ".pptx"
          ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
          : "application/zip";
  }
  if (extension === ".json") {
    return "application/json";
  }
  if (extension === ".csv") {
    return "text/csv";
  }
  if (extension === ".md") {
    return "text/markdown";
  }
  if (extension === ".txt") {
    return "text/plain";
  }
  return "application/octet-stream";
}

function hasNullByte(body: Buffer) {
  return body.some((byte) => byte === 0);
}

function inspectZip(body: Buffer) {
  const executableEntries: string[] = [];
  const nestedArchiveEntries: string[] = [];
  const suspiciousEntries: string[] = [];
  let entries = 0;
  let offset = 0;

  while (offset + 30 <= body.length) {
    const signature = readUInt32LE(body, offset);
    if (signature !== 0x04034b50) {
      break;
    }

    const flags = readUInt16LE(body, offset + 6);
    const compressedSize = readUInt32LE(body, offset + 18);
    const uncompressedSize = readUInt32LE(body, offset + 22);
    const fileNameLength = readUInt16LE(body, offset + 26);
    const extraLength = readUInt16LE(body, offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + fileNameLength;
    const dataStart = nameEnd + extraLength;
    if (nameEnd > body.length || dataStart > body.length) {
      suspiciousEntries.push("malformed-zip-entry");
      break;
    }

    const name = Buffer.from(body.subarray(nameStart, nameEnd)).toString("utf8");
    const normalizedName = name.replace(/\\/g, "/");
    const entryExt = extensionFor(normalizedName);
    entries += 1;

    if (normalizedName.startsWith("/") || normalizedName.includes("../") || normalizedName.includes("/..")) {
      suspiciousEntries.push(name);
    }
    if (EXECUTABLE_EXTENSIONS.has(entryExt)) {
      executableEntries.push(name);
    }
    if (NESTED_ARCHIVE_EXTENSIONS.has(entryExt) && entryExt !== ".zip") {
      nestedArchiveEntries.push(name);
    }
    if (entryExt === ".zip") {
      nestedArchiveEntries.push(name);
    }
    if ((flags & 0x1) === 0x1) {
      suspiciousEntries.push(`${name}: encrypted/password-protected`);
    }
    if (compressedSize > 0 && uncompressedSize / Math.max(1, compressedSize) > 100) {
      suspiciousEntries.push(`${name}: suspicious compression ratio`);
    }
    if (entries > 1000) {
      suspiciousEntries.push("too-many-zip-entries");
      break;
    }

    offset = dataStart + compressedSize;
  }

  return {
    inspected: true,
    entries,
    executableEntries,
    nestedArchiveEntries,
    suspiciousEntries
  };
}

function buildSafetyReport(input: {
  filename: string;
  declaredContentType: string;
  detectedContentType: string;
  body: Buffer;
}): ArtifactSafetyReport {
  const extension = extensionFor(input.filename);
  const reasons: string[] = [];
  let archive: ArtifactSafetyReport["archive"];

  if (!SAFE_EXTENSIONS.has(extension)) {
    reasons.push(`File extension ${extension || "(none)"} is not allowed for default artifact delivery.`);
  }
  if (EXECUTABLE_EXTENSIONS.has(extension)) {
    reasons.push(`Executable or script file extension ${extension} is blocked by default.`);
  }
  if ([".txt", ".md", ".json", ".csv"].includes(extension) && hasNullByte(input.body)) {
    reasons.push("Text-like artifact contains null bytes and was treated as binary content.");
  }
  if (extension === ".json") {
    try {
      JSON.parse(input.body.toString("utf8"));
    } catch {
      reasons.push("JSON artifact is not valid JSON.");
    }
  }
  if (extension === ".pdf") {
    const pdfText = input.body.toString("latin1").toLowerCase();
    if (!input.detectedContentType.includes("pdf")) {
      reasons.push("PDF artifact did not match PDF magic bytes.");
    }
    if (pdfText.includes("/javascript") || pdfText.includes("/launch") || pdfText.includes("/embeddedfile")) {
      reasons.push("PDF contains active or embedded content markers.");
    }
  }
  if (extension === ".png" && input.detectedContentType !== "image/png") {
    reasons.push("PNG artifact did not match PNG magic bytes.");
  }
  if ((extension === ".jpg" || extension === ".jpeg") && input.detectedContentType !== "image/jpeg") {
    reasons.push("JPEG artifact did not match JPEG magic bytes.");
  }
  if ([".zip", ".docx", ".xlsx", ".pptx"].includes(extension)) {
    if (!input.detectedContentType.includes("zip") && !input.detectedContentType.includes("openxmlformats")) {
      reasons.push("Archive artifact did not match ZIP/OpenXML magic bytes.");
    } else {
      archive = inspectZip(input.body);
      if (archive.entries === 0) {
        reasons.push("Archive has no inspectable file entries.");
      }
      if (archive.executableEntries.length > 0) {
        reasons.push(`Archive contains executable/script entries: ${archive.executableEntries.slice(0, 5).join(", ")}.`);
      }
      if (archive.nestedArchiveEntries.length > 0) {
        reasons.push(`Archive contains nested archives: ${archive.nestedArchiveEntries.slice(0, 5).join(", ")}.`);
      }
      if (archive.suspiciousEntries.length > 0) {
        reasons.push(`Archive contains suspicious entries: ${archive.suspiciousEntries.slice(0, 5).join(", ")}.`);
      }
    }
  }

  const status: ArtifactSafetyStatus = reasons.length === 0 ? "clean" : "blocked";
  return {
    status,
    scanner: "santaclawz-static-policy-v1",
    malwareScanner: "not_configured",
    malwareScannerVerdict: "not_scanned",
    privacyMode: "platform_scanned_then_encrypted_at_rest",
    platformContentVisibility: "plaintext_during_platform_scan",
    fileKind: extension === ".zip" ? "restricted_archive" : extension ? extension.slice(1) : "unknown",
    extension,
    declaredContentType: input.declaredContentType,
    detectedContentType: input.detectedContentType,
    ...(archive ? { archive } : {}),
    reasons,
    buyerMessage:
      status === "clean"
        ? "SantaClawz static safety checks passed. Treat agent artifacts as untrusted and verify the displayed hash before opening."
        : "SantaClawz blocked this artifact before buyer download because it did not match the default safe-file policy.",
    sellerMessage:
      status === "clean"
        ? "Artifact accepted for buyer delivery. Default V1 delivery allows non-executable work-product files only."
        : `Artifact blocked. Upload a non-executable work-product file or restricted zip without active, executable, nested, or suspicious entries. Reasons: ${reasons.join(" ")}`
  };
}

function publicArtifactBase(baseUrl: string, artifactId: string) {
  return `${baseUrl.replace(/\/+$/, "")}/api/artifacts/${encodeURIComponent(artifactId)}`;
}

function publicArtifactReceiptBase(baseUrl: string, receiptId: string) {
  return `${baseUrl.replace(/\/+$/, "")}/api/artifact-receipts/${encodeURIComponent(receiptId)}`;
}

function isPrivateEncryptedFilename(filename: string) {
  return PRIVATE_ENCRYPTED_EXTENSIONS.has(extensionFor(filename));
}

function normalizeDeliveryMode(value: string | undefined, filename: string): ArtifactDeliveryMode {
  if (value === "buyer_encrypted") {
    return "buyer_encrypted";
  }
  if (value === "platform_scanned") {
    return "platform_scanned";
  }
  return isPrivateEncryptedFilename(filename) ? "buyer_encrypted" : "platform_scanned";
}

function normalizeReceiptTransport(
  value: ArtifactReceiptTransport | undefined,
  deliveryMode: ArtifactReceiptDeliveryMode
): ArtifactReceiptTransport {
  if (value === "buyer_agent_inbox" || value === "external_url" || value === "out_of_band" || value === "custom") {
    return value;
  }
  return deliveryMode === "external_reference" ? "external_url" : "out_of_band";
}

function normalizeReceiptScanPolicy(
  value: ArtifactReceiptScanPolicy | undefined,
  deliveryMode: ArtifactReceiptDeliveryMode
): ArtifactReceiptScanPolicy {
  if (value === "buyer_required" || value === "external_unverified" || value === "external_verified" || value === "none") {
    return value;
  }
  return deliveryMode === "external_reference" ? "external_unverified" : "buyer_required";
}

function normalizeSha256(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("artifactDigestSha256 must be a 64-character lowercase hex SHA-256 digest.");
  }
  return normalized;
}

function sanitizeOptionalText(value: string | undefined, maxLength: number) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function buildReceiptManifestDigest(input: Omit<ArtifactReceiptMetadata, "manifestDigestSha256" | "tokenHashSha256">) {
  return sha256Hex(JSON.stringify(input));
}

function buildPrivateCiphertextSafetyReport(input: {
  filename: string;
  declaredContentType: string;
  detectedContentType: string;
}): ArtifactSafetyReport {
  const extension = extensionFor(input.filename);
  const reasons: string[] = [];
  if (!PRIVATE_ENCRYPTED_EXTENSIONS.has(extension)) {
    reasons.push(
      `Private buyer-encrypted delivery requires an encrypted artifact extension: ${Array.from(PRIVATE_ENCRYPTED_EXTENSIONS).join(", ")}.`
    );
  }

  const status: ArtifactSafetyStatus = reasons.length === 0 ? "buyer_scan_required" : "blocked";
  return {
    status,
    scanner: "santaclawz-private-ciphertext-v1",
    malwareScanner: "buyer_scan_required",
    malwareScannerVerdict: "not_scanned",
    privacyMode: "platform_ciphertext_only_buyer_scan_required",
    platformContentVisibility: "ciphertext_only",
    fileKind: "encrypted_artifact",
    extension,
    declaredContentType: input.declaredContentType,
    detectedContentType: input.detectedContentType,
    reasons,
    buyerMessage:
      status === "buyer_scan_required"
        ? "SantaClawz stored encrypted artifact bytes only. Decrypt locally, scan locally, and open only if your local scanner reports clean."
        : "SantaClawz blocked this private artifact because it did not look like an encrypted buyer-delivery bundle.",
    sellerMessage:
      status === "buyer_scan_required"
        ? "Encrypted private artifact accepted. SantaClawz cannot inspect the plaintext; buyer must decrypt and scan locally."
        : `Private artifact blocked. Upload buyer-encrypted ciphertext with an encrypted-artifact extension. Reasons: ${reasons.join(" ")}`
  };
}

interface MalwareScanResult {
  scanner: "clamav";
  verdict: "clean" | "infected" | "unavailable";
  signature?: string;
  durationMs: number;
  error?: string;
}

interface ClamAvHealthResult {
  configured: boolean;
  scanner: "clamav" | "not_configured";
  target: {
    host: string;
    port: number;
  };
  timeoutMs: number;
  reachable: boolean;
  response?: string;
  error?: string;
  durationMs: number;
}

function clamAvConfigured() {
  return process.env.CLAWZ_ARTIFACT_MALWARE_SCANNER?.trim().toLowerCase() === "clamav";
}

function parseHostPort(value: string | undefined, fallbackPort: number) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `tcp://${trimmed}`;
    const url = new URL(withScheme);
    return {
      host: url.hostname,
      port: url.port ? parsePositiveInteger(url.port, fallbackPort, 1, 65535) : fallbackPort
    };
  } catch {
    const lastColon = trimmed.lastIndexOf(":");
    if (lastColon > 0 && !trimmed.includes("/")) {
      return {
        host: trimmed.slice(0, lastColon),
        port: parsePositiveInteger(trimmed.slice(lastColon + 1), fallbackPort, 1, 65535)
      };
    }
    return {
      host: trimmed,
      port: fallbackPort
    };
  }
}

function clamAvTarget() {
  const configuredPort = parsePositiveInteger(process.env.CLAWZ_CLAMAV_PORT, 3310, 1, 65535);
  return (
    parseHostPort(process.env.CLAWZ_CLAMAV_ENDPOINT, configuredPort) ??
    parseHostPort(process.env.CLAWZ_CLAMAV_HOST, configuredPort) ?? {
      host: "127.0.0.1",
      port: configuredPort
    }
  );
}

function clamAvTimeoutMs() {
  return parsePositiveInteger(process.env.CLAWZ_CLAMAV_TIMEOUT_MS, 15000, 1000, 60000);
}

function buildUint32BE(value: number) {
  return Buffer.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

async function pingClamAv(): Promise<ClamAvHealthResult> {
  const startedAt = Date.now();
  const target = clamAvTarget();
  const timeoutMs = clamAvTimeoutMs();
  const base = {
    configured: clamAvConfigured(),
    scanner: clamAvConfigured() ? "clamav" as const : "not_configured" as const,
    target,
    timeoutMs
  };
  if (!base.configured) {
    return {
      ...base,
      reachable: false,
      error: "CLAWZ_ARTIFACT_MALWARE_SCANNER is not set to clamav.",
      durationMs: Date.now() - startedAt
    };
  }

  try {
    const net = (await import("node:net")) as unknown as {
      createConnection(options: { host: string; port: number }, onConnect?: () => void): Socket & {
        setTimeout(timeoutMs: number, callback?: () => void): void;
      };
    };
    const response = await new Promise<string>((resolve, reject) => {
      let settled = false;
      let responseText = "";
      const socket = net.createConnection({ host: target.host, port: target.port }, () => {
        socket.write("zPING\0");
      });
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        if (error) {
          reject(error);
          return;
        }
        resolve(responseText.replace(/\0/g, "").trim());
      };
      socket.setTimeout(timeoutMs, () => finish(new Error(`ClamAV ping timed out at ${target.host}:${target.port}.`)));
      socket.on("data", (chunk) => {
        responseText += chunk.toString("utf8");
        if (responseText.includes("PONG") || responseText.includes("\0")) {
          finish();
        }
      });
      socket.once("error", () => finish(new Error(`ClamAV connection failed at ${target.host}:${target.port}.`)));
      socket.once("close", () => finish());
    });
    return {
      ...base,
      reachable: response === "PONG",
      response,
      ...(response === "PONG" ? {} : { error: response || "Unexpected ClamAV ping response." }),
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      ...base,
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt
    };
  }
}

async function scanWithClamAv(body: Buffer): Promise<MalwareScanResult> {
  const startedAt = Date.now();
  const target = clamAvTarget();
  try {
    const net = (await import("node:net")) as unknown as {
      createConnection(options: { host: string; port: number }, onConnect?: () => void): Socket & {
        setTimeout(timeoutMs: number, callback?: () => void): void;
      };
    };
    const response = await new Promise<string>((resolve, reject) => {
      let settled = false;
      let responseText = "";
      const socket = net.createConnection({ host: target.host, port: target.port }, () => {
        socket.write("zINSTREAM\0");
        for (let offset = 0; offset < body.length; offset += 1024 * 1024) {
          const chunk = body.subarray(offset, Math.min(body.length, offset + 1024 * 1024));
          socket.write(buildUint32BE(chunk.length));
          socket.write(Buffer.from(chunk));
        }
        socket.write(buildUint32BE(0));
      });
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        if (error) {
          reject(error);
          return;
        }
        resolve(responseText);
      };
      socket.setTimeout(clamAvTimeoutMs(), () => finish(new Error(`ClamAV scan timed out at ${target.host}:${target.port}.`)));
      socket.on("data", (chunk) => {
        responseText += chunk.toString("utf8");
      });
      socket.once("error", () => finish(new Error(`ClamAV connection failed at ${target.host}:${target.port}.`)));
      socket.once("close", () => finish());
    });

    const normalized = response.replace(/\0/g, "").trim();
    if (/\bOK$/.test(normalized)) {
      return { scanner: "clamav", verdict: "clean", durationMs: Date.now() - startedAt };
    }
    const found = normalized.match(/: (.+) FOUND$/);
    if (found) {
      return {
        scanner: "clamav",
        verdict: "infected",
        ...(found[1] ? { signature: found[1] } : {}),
        durationMs: Date.now() - startedAt
      };
    }
    return {
      scanner: "clamav",
      verdict: "unavailable",
      durationMs: Date.now() - startedAt,
      error: normalized || "Unexpected ClamAV response."
    };
  } catch (error) {
    return {
      scanner: "clamav",
      verdict: "unavailable",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export class ArtifactStore {
  private readonly metadataDir: string;
  private readonly dataDir: string;
  private readonly receiptDir: string;
  private readonly encryptionKey: Buffer;
  private readonly retentionDays: number;
  private readonly maxBytes: number;
  private readonly maxArtifactsPerRequest: number;
  private readonly maxBytesPerRequest: number;
  private readonly scanRequired: boolean;

  constructor(private readonly baseDir: string) {
    this.metadataDir = path.join(baseDir, "metadata");
    this.dataDir = path.join(baseDir, "data");
    this.receiptDir = path.join(baseDir, "receipts");
    this.encryptionKey = resolveEncryptionKey(baseDir);
    this.retentionDays = parsePositiveInteger(process.env.CLAWZ_ARTIFACT_RETENTION_DAYS, 10, 1, 90);
    this.maxBytes = parsePositiveInteger(process.env.CLAWZ_ARTIFACT_MAX_BYTES, 25 * 1024 * 1024, 1024, 250 * 1024 * 1024);
    this.maxArtifactsPerRequest = parsePositiveInteger(process.env.CLAWZ_ARTIFACT_MAX_PER_REQUEST, 5, 1, 100);
    this.maxBytesPerRequest = parsePositiveInteger(
      process.env.CLAWZ_ARTIFACT_MAX_BYTES_PER_REQUEST,
      100 * 1024 * 1024,
      1024,
      1024 * 1024 * 1024
    );
    this.scanRequired = envFlag(process.env.CLAWZ_ARTIFACT_SCAN_REQUIRED, false);
  }

  async ensureDirs() {
    await mkdir(this.metadataDir, { recursive: true, mode: 0o700 });
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await mkdir(this.receiptDir, { recursive: true, mode: 0o700 });
  }

  async scannerHealth() {
    return pingClamAv();
  }

  async create(options: ArtifactCreateOptions): Promise<ArtifactCreateResult> {
    await this.ensureDirs();
    if (options.body.length === 0) {
      throw new Error("Artifact body is required.");
    }
    if (options.body.length > this.maxBytes) {
      throw new Error(`Artifact body exceeds the ${this.maxBytes} byte limit.`);
    }
    await this.assertRequestQuota(options.requestId.trim(), options.body.length);

    const artifactId = `artifact_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const token = randomBytes(32).toString("base64url");
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.retentionDays * 24 * 60 * 60 * 1000);
    const filename = safeFilename(options.filename);
    const contentType = sanitizeContentType(options.contentType);
    const deliveryMode = normalizeDeliveryMode(options.deliveryMode, filename);
    const detectedContentType = detectContentType(options.body, extensionFor(filename));
    const safety =
      deliveryMode === "buyer_encrypted"
        ? buildPrivateCiphertextSafetyReport({
            filename,
            declaredContentType: contentType,
            detectedContentType
          })
        : await this.buildPlatformSafetyReport({
            filename,
            declaredContentType: contentType,
            detectedContentType,
            body: options.body
          });
    if (safety.status === "blocked") {
      throw new ArtifactSafetyError(safety);
    }
    if (safety.status === "scan_unavailable") {
      throw new ArtifactScanUnavailableError(safety);
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(options.body), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const metadata: ArtifactMetadata = {
      artifactId,
      requestId: options.requestId.trim(),
      createdAtIso: createdAt.toISOString(),
      expiresAtIso: expiresAt.toISOString(),
      filename,
      contentType,
      plaintextBytes: options.body.length,
      encryptedBytes: encrypted.length,
      digestSha256: sha256Hex(options.body),
      deliveryMode,
      safety,
      ivBase64: iv.toString("base64"),
      authTagBase64: authTag.toString("base64"),
      tokenHashSha256: sha256Hex(token)
    };

    await writeBinaryFile(this.dataPath(artifactId), encrypted);
    await writeJsonFile(this.metadataPath(artifactId), metadata);

    const base = publicArtifactBase(options.baseUrl, artifactId);
    const tokenQuery = `token=${encodeURIComponent(token)}`;
    return {
      artifactId,
      requestId: metadata.requestId,
      artifactManifestUrl: `${base}/manifest?${tokenQuery}`,
      artifactDownloadUrl: `${base}/download?${tokenQuery}`,
      artifactBundleDigestSha256: metadata.digestSha256,
      filename,
      contentType,
      bytes: metadata.plaintextBytes,
      expiresAtIso: metadata.expiresAtIso,
      deliveryMode,
      requiresBuyerDownloadAcceptance: safety.status === "buyer_scan_required",
      safety
    };
  }

  async manifest(artifactId: string, token: string) {
    const metadata = await this.readAuthorizedMetadata(artifactId, token);
    return this.publicMetadata(metadata);
  }

  async read(artifactId: string, token: string): Promise<ArtifactReadResult> {
    const metadata = await this.readAuthorizedMetadata(artifactId, token);
    const safety = this.resolveSafety(metadata);
    if (safety.status === "blocked" || safety.status === "scan_unavailable") {
      throw new Error("Artifact is not available for buyer download because its safety status is not clean.");
    }
    const encrypted = await readBinaryFile(this.dataPath(metadata.artifactId));
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(metadata.ivBase64, "base64"));
    decipher.setAuthTag(Buffer.from(metadata.authTagBase64, "base64"));
    const body = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    if (sha256Hex(body) !== metadata.digestSha256) {
      throw new Error("Artifact digest verification failed.");
    }
    if (!metadata.claimedAtIso) {
      await this.writeMetadata({
        ...metadata,
        claimedAtIso: new Date().toISOString()
      });
    }
    return {
      metadata: this.publicMetadata(metadata),
      body
    };
  }

  async createReceipt(options: ArtifactReceiptCreateOptions): Promise<ArtifactReceiptCreateResult> {
    await this.ensureDirs();
    const receiptId = `receipt_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const token = randomBytes(32).toString("base64url");
    const createdAtIso = new Date().toISOString();
    const deliveredAtIso = options.deliveredAtIso?.trim() || createdAtIso;
    const filename = safeFilename(options.filename);
    const contentType = sanitizeContentType(options.contentType);
    const deliveryMode = options.deliveryMode;
    const transport = normalizeReceiptTransport(options.transport, deliveryMode);
    const scanPolicy = normalizeReceiptScanPolicy(options.scanPolicy, deliveryMode);
    const artifactSizeBytes = Math.max(0, Math.floor(options.artifactSizeBytes));
    if (!Number.isFinite(artifactSizeBytes) || artifactSizeBytes <= 0) {
      throw new Error("artifactSizeBytes must be a positive integer.");
    }
    const artifactUrl = sanitizeOptionalText(options.artifactUrl, 2048);
    if (deliveryMode === "external_reference" && !artifactUrl) {
      throw new Error("artifactUrl is required for external_reference receipts.");
    }
    const deliveryChannel = sanitizeOptionalText(options.deliveryChannel, 240);
    const sellerDeliveryReceipt = sanitizeOptionalText(options.sellerDeliveryReceipt, 2048);
    const sellerSignature = sanitizeOptionalText(options.sellerSignature, 512);
    const withoutDigest: Omit<ArtifactReceiptMetadata, "manifestDigestSha256" | "tokenHashSha256"> = {
      receiptId,
      requestId: options.requestId.trim(),
      createdAtIso,
      updatedAtIso: createdAtIso,
      deliveredAtIso,
      deliveryMode,
      transport,
      scanPolicy,
      digestRequired: true as const,
      buyerAcceptanceRequired: options.buyerAcceptanceRequired ?? true,
      buyerAcceptanceStatus: options.buyerAcceptanceRequired === false ? "not_required" as const : "pending" as const,
      filename,
      contentType,
      artifactDigestSha256: normalizeSha256(options.artifactDigestSha256),
      artifactSizeBytes,
      ...(artifactUrl ? { artifactUrl } : {}),
      ...(deliveryChannel ? { deliveryChannel } : {}),
      ...(sellerDeliveryReceipt ? { sellerDeliveryReceipt } : {}),
      ...(sellerSignature ? { sellerSignature } : {})
    };
    const metadata: ArtifactReceiptMetadata = {
      ...withoutDigest,
      manifestDigestSha256: buildReceiptManifestDigest(withoutDigest),
      tokenHashSha256: sha256Hex(token)
    };
    await writeJsonFile(this.receiptPath(receiptId), metadata);
    const base = publicArtifactReceiptBase(options.baseUrl, receiptId);
    const tokenQuery = `token=${encodeURIComponent(token)}`;
    const receiptManifestUrl = `${base}?${tokenQuery}`;
    return {
      receipt: this.publicReceipt(metadata),
      receiptManifestUrl,
      ...(metadata.buyerAcceptanceRequired ? { buyerAcknowledgementUrl: `${base}/acknowledge?${tokenQuery}` } : {}),
      verifiedOutputPatch: {
        artifact_manifest_url: receiptManifestUrl,
        artifact_bundle_digest_sha256: metadata.artifactDigestSha256
      }
    };
  }

  async receipt(receiptId: string, token: string) {
    const metadata = await this.readAuthorizedReceipt(receiptId, token);
    return this.publicReceipt(metadata);
  }

  async acknowledgeReceipt(receiptId: string, token: string, input: { accepted: boolean; note?: string }) {
    const metadata = await this.readAuthorizedReceipt(receiptId, token);
    if (!metadata.buyerAcceptanceRequired) {
      return this.publicReceipt(metadata);
    }
    const note = sanitizeOptionalText(input.note, 240);
    const updated: ArtifactReceiptMetadata = {
      ...metadata,
      updatedAtIso: new Date().toISOString(),
      buyerAcceptanceStatus: input.accepted ? "accepted" : "rejected",
      buyerAcknowledgedAtIso: new Date().toISOString(),
      ...(note ? { buyerAcknowledgementNote: note } : {})
    };
    await writeJsonFile(this.receiptPath(receiptId), updated);
    return this.publicReceipt(updated);
  }

  async cleanupExpired(now = Date.now()) {
    await this.ensureDirs();
    const names = await readdir(this.metadataDir);
    let deleted = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) {
        continue;
      }
      try {
        const metadata = JSON.parse(await readFile(path.join(this.metadataDir, name), "utf8")) as ArtifactMetadata;
        if (Date.parse(metadata.expiresAtIso) <= now) {
          await rm(this.metadataPath(metadata.artifactId), { force: true });
          await rm(this.dataPath(metadata.artifactId), { force: true });
          deleted += 1;
        }
      } catch {
        // Ignore malformed entries so one bad metadata file cannot block cleanup.
      }
    }
    return { deleted };
  }

  private async readAuthorizedMetadata(artifactId: string, token: string) {
    const metadata = JSON.parse(await readFile(this.metadataPath(artifactId), "utf8")) as ArtifactMetadata;
    if (Date.parse(metadata.expiresAtIso) <= Date.now()) {
      throw new Error("Artifact link has expired.");
    }
    if (!token.trim() || sha256Hex(token.trim()) !== metadata.tokenHashSha256) {
      throw new Error("Artifact token was rejected.");
    }
    return metadata;
  }

  private async readAuthorizedReceipt(receiptId: string, token: string) {
    const metadata = JSON.parse(await readFile(this.receiptPath(receiptId), "utf8")) as ArtifactReceiptMetadata;
    if (!token.trim() || sha256Hex(token.trim()) !== metadata.tokenHashSha256) {
      throw new Error("Artifact receipt token was rejected.");
    }
    return metadata;
  }

  private publicReceipt(metadata: ArtifactReceiptMetadata): ArtifactReceiptPublicMetadata {
    return {
      receiptId: metadata.receiptId,
      requestId: metadata.requestId,
      createdAtIso: metadata.createdAtIso,
      updatedAtIso: metadata.updatedAtIso,
      deliveredAtIso: metadata.deliveredAtIso,
      deliveryMode: metadata.deliveryMode,
      transport: metadata.transport,
      scanPolicy: metadata.scanPolicy,
      digestRequired: metadata.digestRequired,
      buyerAcceptanceRequired: metadata.buyerAcceptanceRequired,
      buyerAcceptanceStatus: metadata.buyerAcceptanceStatus,
      ...(metadata.buyerAcknowledgedAtIso ? { buyerAcknowledgedAtIso: metadata.buyerAcknowledgedAtIso } : {}),
      ...(metadata.buyerAcknowledgementNote ? { buyerAcknowledgementNote: metadata.buyerAcknowledgementNote } : {}),
      filename: metadata.filename,
      contentType: metadata.contentType,
      artifactDigestSha256: metadata.artifactDigestSha256,
      artifactSizeBytes: metadata.artifactSizeBytes,
      ...(metadata.artifactUrl ? { artifactUrl: metadata.artifactUrl } : {}),
      ...(metadata.deliveryChannel ? { deliveryChannel: metadata.deliveryChannel } : {}),
      ...(metadata.sellerDeliveryReceipt ? { sellerDeliveryReceipt: metadata.sellerDeliveryReceipt } : {}),
      ...(metadata.sellerSignature ? { sellerSignature: metadata.sellerSignature } : {}),
      manifestDigestSha256: metadata.manifestDigestSha256
    };
  }

  private publicMetadata(metadata: ArtifactMetadata) {
    const safety = this.resolveSafety(metadata);
    const deliveryMode = metadata.deliveryMode ?? "platform_scanned";
    return {
      artifactId: metadata.artifactId,
      requestId: metadata.requestId,
      createdAtIso: metadata.createdAtIso,
      expiresAtIso: metadata.expiresAtIso,
      ...(metadata.claimedAtIso ? { claimedAtIso: metadata.claimedAtIso } : {}),
      filename: metadata.filename,
      contentType: metadata.contentType,
      plaintextBytes: metadata.plaintextBytes,
      encryptedBytes: metadata.encryptedBytes,
      digestSha256: metadata.digestSha256,
      deliveryMode,
      requiresBuyerDownloadAcceptance: safety.status === "buyer_scan_required",
      safety
    };
  }

  private resolveSafety(metadata: ArtifactMetadata): ArtifactSafetyReport {
    return metadata.safety ?? {
      status: "clean" as const,
      scanner: "santaclawz-static-policy-v1" as const,
      malwareScanner: "not_configured" as const,
      malwareScannerVerdict: "not_scanned" as const,
      privacyMode: "platform_scanned_then_encrypted_at_rest" as const,
      platformContentVisibility: "plaintext_during_platform_scan" as const,
      fileKind: extensionFor(metadata.filename).slice(1) || "legacy",
      extension: extensionFor(metadata.filename),
      declaredContentType: metadata.contentType,
      detectedContentType: metadata.contentType,
      reasons: [],
      buyerMessage:
        "SantaClawz static safety metadata was not present on this legacy artifact. Treat agent artifacts as untrusted and verify the displayed hash before opening.",
      sellerMessage: "Legacy artifact is available for buyer delivery, but it predates V1 static safety metadata."
    };
  }

  private async writeMetadata(metadata: ArtifactMetadata) {
    await writeJsonFile(this.metadataPath(metadata.artifactId), metadata);
  }

  private metadataPath(artifactId: string) {
    return path.join(this.metadataDir, `${artifactId}.json`);
  }

  private dataPath(artifactId: string) {
    return path.join(this.dataDir, `${artifactId}.bin`);
  }

  private receiptPath(receiptId: string) {
    return path.join(this.receiptDir, `${receiptId}.json`);
  }

  private async assertRequestQuota(requestId: string, nextBytes: number) {
    const names = await readdir(this.metadataDir);
    let count = 0;
    let bytes = 0;
    const now = Date.now();
    for (const name of names) {
      if (!name.endsWith(".json")) {
        continue;
      }
      try {
        const metadata = JSON.parse(await readFile(path.join(this.metadataDir, name), "utf8")) as ArtifactMetadata;
        if (metadata.requestId !== requestId || Date.parse(metadata.expiresAtIso) <= now) {
          continue;
        }
        count += 1;
        bytes += metadata.plaintextBytes;
      } catch {
        // Malformed metadata does not count against request quotas.
      }
    }
    if (count >= this.maxArtifactsPerRequest) {
      throw new Error(`Artifact limit reached for this request. Maximum artifacts per request: ${this.maxArtifactsPerRequest}.`);
    }
    if (bytes + nextBytes > this.maxBytesPerRequest) {
      throw new Error(`Artifact byte quota exceeded for this request. Maximum bytes per request: ${this.maxBytesPerRequest}.`);
    }
  }

  private async buildPlatformSafetyReport(input: {
    filename: string;
    declaredContentType: string;
    detectedContentType: string;
    body: Buffer;
  }) {
    let safety = buildSafetyReport(input);
    if (safety.status !== "clean") {
      return safety;
    }

    if (!clamAvConfigured()) {
      if (!this.scanRequired) {
        return safety;
      }
      return {
        ...safety,
        status: "scan_unavailable" as const,
        malwareScanner: "scan_unavailable" as const,
        malwareScannerVerdict: "unavailable" as const,
        reasons: ["Malware scanning is required, but ClamAV is not configured."],
        buyerMessage: "SantaClawz could not make this artifact downloadable because malware scanning is required but unavailable.",
        sellerMessage: "Artifact scan unavailable. Retry after the platform ClamAV service is configured and healthy."
      };
    }

    const scan = await scanWithClamAv(input.body);
    if (scan.verdict === "clean") {
      return {
        ...safety,
        malwareScanner: "clamav" as const,
        malwareScannerVerdict: "clean" as const,
        scanDurationMs: scan.durationMs,
        buyerMessage:
          "SantaClawz static safety checks and private ClamAV scan passed. Treat agent artifacts as untrusted and verify the displayed hash before opening.",
        sellerMessage: "Artifact accepted for buyer delivery after static safety checks and private ClamAV scan."
      };
    }
    if (scan.verdict === "infected") {
      return {
        ...safety,
        status: "blocked" as const,
        malwareScanner: "clamav" as const,
        malwareScannerVerdict: "infected" as const,
        ...(scan.signature ? { malwareSignature: scan.signature } : {}),
        scanDurationMs: scan.durationMs,
        reasons: [`ClamAV reported malware${scan.signature ? `: ${scan.signature}` : ""}.`],
        buyerMessage: "SantaClawz blocked this artifact because the private malware scanner reported a threat.",
        sellerMessage: `Artifact blocked by ClamAV${scan.signature ? ` (${scan.signature})` : ""}. Upload a clean work-product file.`
      };
    }
    return {
      ...safety,
      status: this.scanRequired ? ("scan_unavailable" as const) : ("clean" as const),
      malwareScanner: "scan_unavailable" as const,
      malwareScannerVerdict: "unavailable" as const,
      scanDurationMs: scan.durationMs,
      reasons: this.scanRequired
        ? [`ClamAV scan unavailable${scan.error ? `: ${scan.error}` : ""}.`]
        : [`ClamAV scan unavailable${scan.error ? `: ${scan.error}` : ""}; static policy passed and scan is not required.`],
      buyerMessage: this.scanRequired
        ? "SantaClawz could not make this artifact downloadable because the private malware scanner was unavailable."
        : "SantaClawz static safety checks passed, but private malware scanning was unavailable. Treat this artifact as untrusted.",
      sellerMessage: this.scanRequired
        ? "Artifact scan unavailable. Retry after the platform ClamAV service is healthy."
        : "Artifact accepted by static policy, but ClamAV was unavailable and scan-required mode is off."
    };
  }
}

async function readBinaryFile(filePath: string): Promise<Buffer> {
  const read = readFile as unknown as (path: string) => Promise<Buffer>;
  return read(filePath);
}

async function writeBinaryFile(filePath: string, data: Buffer): Promise<void> {
  const write = writeFile as unknown as (path: string, data: Buffer, options: { mode?: number }) => Promise<void>;
  await write(filePath, data, { mode: 0o600 });
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
