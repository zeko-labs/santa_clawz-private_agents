import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  canonicalDigest,
  type DeletionRecord,
  stableJsonStringify,
  type RetentionPolicy,
  type StableJsonValue
} from "@clawz/protocol";
import { TenantKeyBroker, openBytes, sealBytes, type UnwrapRequest } from "@clawz/key-broker";

import { createManifest } from "../manifests/create-manifest.js";
import type { SealBlobInput, SealedBlobManifest, SealedBlobStore, StoredCipherEnvelope } from "../types.js";

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
}

export class LocalSealedBlobStore implements SealedBlobStore {
  constructor(
    private readonly baseDir: string,
    private readonly keyBroker: TenantKeyBroker
  ) {}

  async ensureDirs() {
    await mkdir(path.join(this.baseDir, "cipher"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.baseDir, "manifests"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.baseDir, "deletions"), { recursive: true, mode: 0o700 });
  }

  private getManifestPath(manifestId: string) {
    return path.join(this.baseDir, "manifests", `${manifestId}.json`);
  }

  private getDeletionRecordPath(deletionId: string) {
    return path.join(this.baseDir, "deletions", `${deletionId}.json`);
  }

  async sealJson(input: SealBlobInput): Promise<SealedBlobManifest> {
    await this.ensureDirs();
    const payload = input.payload as StableJsonValue;
    const plainText = Buffer.from(stableJsonStringify(payload), "utf8");
    const payloadDigest = canonicalDigest(payload).sha256Hex;
    const dataKey = this.keyBroker.issueDataKey(input.scope).dataKey;
    const wrappedKey = await this.keyBroker.wrapDataKey(input.scope, input.visibility, dataKey);
    const cipher = sealBytes(plainText, dataKey);
    const cipherPath = path.join(this.baseDir, "cipher", `${wrappedKey.keyId}.json`);

    await writePrivateJson(cipherPath, cipher);

    const manifest = createManifest(input, cipherPath, wrappedKey.keyId, payloadDigest, plainText.byteLength);
    await writePrivateJson(this.getManifestPath(manifest.manifestId), manifest);
    return manifest;
  }

  async readJson(manifestId: string, request: UnwrapRequest): Promise<unknown> {
    const manifest = await this.getManifest(manifestId);
    if (!manifest) {
      throw new Error(`Unknown manifest: ${manifestId}`);
    }

    const cipherRaw = await readFile(manifest.cipherPath, "utf8");
    const cipher = JSON.parse(cipherRaw) as StoredCipherEnvelope;
    const dataKey = await this.keyBroker.unwrapDataKey({
      ...request,
      keyId: manifest.wrappedKeyId
    });

    const plain = openBytes(cipher, dataKey).toString("utf8");
    return JSON.parse(plain) as unknown;
  }

  async listManifests(sessionId?: string): Promise<SealedBlobManifest[]> {
    await this.ensureDirs();
    const entries = await readdir(path.join(this.baseDir, "manifests"));
    const manifests = (
      await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".json"))
          .map(async (entry) => JSON.parse(await readFile(path.join(this.baseDir, "manifests", entry), "utf8")) as SealedBlobManifest)
      )
    ).sort((left, right) => left.createdAtIso.localeCompare(right.createdAtIso));

    return sessionId ? manifests.filter((manifest) => manifest.sessionId === sessionId) : manifests;
  }

  async getManifest(manifestId: string): Promise<SealedBlobManifest | undefined> {
    await this.ensureDirs();
    try {
      return JSON.parse(await readFile(this.getManifestPath(manifestId), "utf8")) as SealedBlobManifest;
    } catch (error) {
      const maybeCode = error as { code?: string };
      if (maybeCode.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async expireManifest(
    manifestId: string,
    retentionPolicy: RetentionPolicy,
    deletedAtIso = new Date().toISOString()
  ): Promise<DeletionRecord | undefined> {
    const manifest = await this.getManifest(manifestId);
    if (!manifest) {
      return undefined;
    }

    if (retentionPolicy.deleteWrappedKeysOnExpiry) {
      await this.keyBroker.revokeKey(manifest.wrappedKeyId, deletedAtIso);
    }

    await rm(manifest.cipherPath, { force: true });
    await rm(this.getManifestPath(manifestId), { force: true });

    const deletionRecord: DeletionRecord = {
      deletionId: `deletion_${manifest.manifestId}`,
      artifactId: manifest.manifestId,
      retentionPolicyId: retentionPolicy.policyId,
      scheduledForIso: deletedAtIso,
      deletedAtIso,
      revokedKeyIds: retentionPolicy.deleteWrappedKeysOnExpiry ? [manifest.wrappedKeyId] : []
    };

    await writePrivateJson(this.getDeletionRecordPath(deletionRecord.deletionId), deletionRecord);

    return deletionRecord;
  }

  async listDeletionRecords(): Promise<DeletionRecord[]> {
    await this.ensureDirs();
    const entries = await readdir(path.join(this.baseDir, "deletions"));
    return Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => JSON.parse(await readFile(path.join(this.baseDir, "deletions", entry), "utf8")) as DeletionRecord)
    );
  }
}
