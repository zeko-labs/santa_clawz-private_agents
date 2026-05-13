import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

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
  safety?: ArtifactSafetyReport;
  ivBase64: string;
  authTagBase64: string;
  tokenHashSha256: string;
}

interface ArtifactCreateOptions {
  requestId: string;
  filename?: string;
  contentType?: string;
  body: Buffer;
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
  safety: ArtifactSafetyReport;
}

interface ArtifactReadResult {
  metadata: Omit<ArtifactMetadata, "tokenHashSha256" | "ivBase64" | "authTagBase64">;
  body: Buffer;
}

type ArtifactSafetyStatus = "clean" | "blocked";

interface ArtifactSafetyReport {
  status: ArtifactSafetyStatus;
  scanner: "santaclawz-static-policy-v1";
  malwareScanner: "not_configured";
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

export class ArtifactStore {
  private readonly metadataDir: string;
  private readonly dataDir: string;
  private readonly encryptionKey: Buffer;
  private readonly retentionDays: number;
  private readonly maxBytes: number;

  constructor(private readonly baseDir: string) {
    this.metadataDir = path.join(baseDir, "metadata");
    this.dataDir = path.join(baseDir, "data");
    this.encryptionKey = resolveEncryptionKey(baseDir);
    this.retentionDays = parsePositiveInteger(process.env.CLAWZ_ARTIFACT_RETENTION_DAYS, 10, 1, 90);
    this.maxBytes = parsePositiveInteger(process.env.CLAWZ_ARTIFACT_MAX_BYTES, 25 * 1024 * 1024, 1024, 250 * 1024 * 1024);
  }

  async ensureDirs() {
    await mkdir(this.metadataDir, { recursive: true, mode: 0o700 });
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
  }

  async create(options: ArtifactCreateOptions): Promise<ArtifactCreateResult> {
    await this.ensureDirs();
    if (options.body.length === 0) {
      throw new Error("Artifact body is required.");
    }
    if (options.body.length > this.maxBytes) {
      throw new Error(`Artifact body exceeds the ${this.maxBytes} byte limit.`);
    }

    const artifactId = `artifact_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const token = randomBytes(32).toString("base64url");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(options.body), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.retentionDays * 24 * 60 * 60 * 1000);
    const filename = safeFilename(options.filename);
    const contentType = sanitizeContentType(options.contentType);
    const detectedContentType = detectContentType(options.body, extensionFor(filename));
    const safety = buildSafetyReport({
      filename,
      declaredContentType: contentType,
      detectedContentType,
      body: options.body
    });
    if (safety.status !== "clean") {
      throw new ArtifactSafetyError(safety);
    }

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
      safety
    };
  }

  async manifest(artifactId: string, token: string) {
    const metadata = await this.readAuthorizedMetadata(artifactId, token);
    return this.publicMetadata(metadata);
  }

  async read(artifactId: string, token: string): Promise<ArtifactReadResult> {
    const metadata = await this.readAuthorizedMetadata(artifactId, token);
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

  private publicMetadata(metadata: ArtifactMetadata) {
    const safety = metadata.safety ?? {
      status: "clean" as const,
      scanner: "santaclawz-static-policy-v1" as const,
      malwareScanner: "not_configured" as const,
      fileKind: extensionFor(metadata.filename).slice(1) || "legacy",
      extension: extensionFor(metadata.filename),
      declaredContentType: metadata.contentType,
      detectedContentType: metadata.contentType,
      reasons: [],
      buyerMessage:
        "SantaClawz static safety metadata was not present on this legacy artifact. Treat agent artifacts as untrusted and verify the displayed hash before opening.",
      sellerMessage: "Legacy artifact is available for buyer delivery, but it predates V1 static safety metadata."
    };
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
      safety
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
