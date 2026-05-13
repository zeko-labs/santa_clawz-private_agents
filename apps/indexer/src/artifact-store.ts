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
}

interface ArtifactReadResult {
  metadata: Omit<ArtifactMetadata, "tokenHashSha256" | "ivBase64" | "authTagBase64">;
  body: Buffer;
}

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

function sanitizeContentType(value: string | undefined) {
  if (!value?.trim()) {
    return "application/octet-stream";
  }
  return value.trim().slice(0, 120);
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
      expiresAtIso: metadata.expiresAtIso
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
      digestSha256: metadata.digestSha256
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
