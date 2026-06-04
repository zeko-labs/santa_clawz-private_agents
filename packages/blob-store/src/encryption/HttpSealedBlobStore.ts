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

interface ObjectListResponse {
  keys?: string[];
}

const TRANSIENT_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_REQUEST_ATTEMPTS = 10;
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 5_000;
const MANIFEST_LIST_CACHE_TTL_MS = boundedIntegerEnv("CLAWZ_BLOB_MANIFEST_LIST_CACHE_TTL_MS", 15_000, 0, 60_000);
const MANIFEST_LIST_GET_CONCURRENCY = boundedIntegerEnv("CLAWZ_BLOB_MANIFEST_LIST_GET_CONCURRENCY", 8, 1, 32);

function normalizeEndpoint(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function objectUri(key: string): string {
  return `object://${key}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function boundedIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(parsed, max));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index] as T, index);
      }
    })
  );
  return results;
}

function objectKeyFromUri(uri: string): string {
  if (!uri.startsWith("object://")) {
    throw new Error(`Unsupported object URI: ${uri}`);
  }

  return uri.slice("object://".length);
}

export class HttpSealedBlobStore implements SealedBlobStore {
  private readonly endpoint: string;
  private manifestListCache: { expiresAtMs: number; manifests: SealedBlobManifest[] } | undefined;

  constructor(
    endpoint: string,
    private readonly keyBroker: TenantKeyBroker,
    private readonly bearerToken?: string
  ) {
    if (!endpoint.trim()) {
      throw new Error("CLAWZ_BLOB_STORE_ENDPOINT is required when using http-object-store mode.");
    }

    this.endpoint = normalizeEndpoint(endpoint.trim());
  }

  async ensureDirs(): Promise<void> {
    await this.request("POST", "/health", undefined, true);
  }

  private headers() {
    return {
      "content-type": "application/json",
      ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {})
    };
  }

  private retryDelayMs(attemptIndex: number): number {
    return Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** attemptIndex);
  }

  private shouldRetryStatus(status: number): boolean {
    return TRANSIENT_STATUS_CODES.has(status);
  }

  private retryLog(method: string, route: string, detail: string, attemptIndex: number): void {
    const nextAttempt = attemptIndex + 2;
    console.warn(
      `[clawz:blob-store] transient object-store failure for ${method} ${route}: ${detail}; retrying attempt ${nextAttempt}/${MAX_REQUEST_ATTEMPTS}`
    );
  }

  private async request(method: string, route: string, body?: unknown, optional = false): Promise<any> {
    const requestBody = body === undefined ? undefined : JSON.stringify(body);
    let lastError: unknown;
    let lastStatus: number | undefined;
    let lastResponseBody: string | undefined;

    for (let attemptIndex = 0; attemptIndex < MAX_REQUEST_ATTEMPTS; attemptIndex += 1) {
      try {
        const response = await fetch(`${this.endpoint}${route}`, {
          method,
          headers: this.headers(),
          ...(requestBody === undefined ? {} : { body: requestBody })
        });

        if (response.ok || (optional && response.status === 404)) {
          return response;
        }

        lastStatus = response.status;
        lastResponseBody = await response.text().catch(() => undefined);
        if (!this.shouldRetryStatus(response.status) || attemptIndex === MAX_REQUEST_ATTEMPTS - 1) {
          break;
        }

        this.retryLog(method, route, `HTTP ${response.status}`, attemptIndex);
      } catch (error) {
        lastError = error;
        if (attemptIndex === MAX_REQUEST_ATTEMPTS - 1) {
          break;
        }

        this.retryLog(
          method,
          route,
          error instanceof Error ? error.message : String(error),
          attemptIndex
        );
      }

      await sleep(this.retryDelayMs(attemptIndex));
    }

    if (lastStatus !== undefined) {
      const detail = lastResponseBody?.trim()
        ? `${lastStatus}: ${lastResponseBody.trim().slice(0, 240)}`
        : String(lastStatus);
      throw new Error(`Sealed blob object-store request failed: ${method} ${route} ${detail}`);
    }

    throw new Error(
      `Sealed blob object-store request failed: ${method} ${route} ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
  }

  private async putObject(key: string, value: unknown): Promise<void> {
    await this.request("PUT", `/objects/${encodeURIComponent(key)}`, value);
  }

  private async getObject<T>(key: string): Promise<T | undefined> {
    const response = await this.request("GET", `/objects/${encodeURIComponent(key)}`, undefined, true);
    if (response.status === 404) {
      return undefined;
    }

    return (await response.json()) as T;
  }

  private async deleteObject(key: string): Promise<void> {
    await this.request("DELETE", `/objects/${encodeURIComponent(key)}`, undefined, true);
  }

  private async listObjects(prefix: string): Promise<string[]> {
    const response = await this.request("GET", `/objects?prefix=${encodeURIComponent(prefix)}`);
    const payload = (await response.json()) as ObjectListResponse;
    return Array.isArray(payload.keys) ? payload.keys : [];
  }

  private cachedManifests(sessionId?: string): SealedBlobManifest[] | undefined {
    if (!this.manifestListCache || this.manifestListCache.expiresAtMs <= Date.now()) {
      return undefined;
    }

    return this.filterManifests(this.manifestListCache.manifests, sessionId);
  }

  private filterManifests(manifests: SealedBlobManifest[], sessionId?: string): SealedBlobManifest[] {
    return sessionId ? manifests.filter((manifest) => manifest.sessionId === sessionId) : [...manifests];
  }

  private invalidateManifestListCache(): void {
    this.manifestListCache = undefined;
  }

  private manifestKey(manifestId: string): string {
    return `manifests/${manifestId}.json`;
  }

  private deletionRecordKey(deletionId: string): string {
    return `deletions/${deletionId}.json`;
  }

  async sealJson(input: SealBlobInput): Promise<SealedBlobManifest> {
    const payload = input.payload as StableJsonValue;
    const plainText = Buffer.from(stableJsonStringify(payload), "utf8");
    const payloadDigest = canonicalDigest(payload).sha256Hex;
    const dataKey = this.keyBroker.issueDataKey(input.scope).dataKey;
    const wrappedKey = await this.keyBroker.wrapDataKey(input.scope, input.visibility, dataKey);
    const cipher = sealBytes(plainText, dataKey);
    const cipherKey = `cipher/${wrappedKey.keyId}.json`;

    await this.putObject(cipherKey, cipher);

    const manifest = createManifest(input, objectUri(cipherKey), wrappedKey.keyId, payloadDigest, plainText.byteLength);
    await this.putObject(this.manifestKey(manifest.manifestId), manifest);
    this.invalidateManifestListCache();
    return manifest;
  }

  async readJson(manifestId: string, request: UnwrapRequest): Promise<unknown> {
    const manifest = await this.getManifest(manifestId);
    if (!manifest) {
      throw new Error(`Unknown manifest: ${manifestId}`);
    }

    const cipher = await this.getObject<StoredCipherEnvelope>(objectKeyFromUri(manifest.cipherPath));
    if (!cipher) {
      throw new Error(`Missing cipher object for manifest: ${manifestId}`);
    }

    const dataKey = await this.keyBroker.unwrapDataKey({
      ...request,
      keyId: manifest.wrappedKeyId
    });

    const plain = openBytes(cipher, dataKey).toString("utf8");
    return JSON.parse(plain) as unknown;
  }

  async listManifests(sessionId?: string): Promise<SealedBlobManifest[]> {
    const cached = this.cachedManifests(sessionId);
    if (cached) {
      return cached;
    }

    const keys = await this.listObjects("manifests/");
    const manifests = (
      await mapWithConcurrency(keys, MANIFEST_LIST_GET_CONCURRENCY, (key) =>
        this.getObject<SealedBlobManifest>(key)
      )
    )
      .filter((manifest): manifest is SealedBlobManifest => Boolean(manifest))
      .sort((left, right) => left.createdAtIso.localeCompare(right.createdAtIso));

    if (MANIFEST_LIST_CACHE_TTL_MS > 0) {
      this.manifestListCache = {
        expiresAtMs: Date.now() + MANIFEST_LIST_CACHE_TTL_MS,
        manifests
      };
    }

    return this.filterManifests(manifests, sessionId);
  }

  getManifest(manifestId: string): Promise<SealedBlobManifest | undefined> {
    return this.getObject<SealedBlobManifest>(this.manifestKey(manifestId));
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

    await this.deleteObject(objectKeyFromUri(manifest.cipherPath));
    await this.deleteObject(this.manifestKey(manifestId));
    this.invalidateManifestListCache();

    const deletionRecord: DeletionRecord = {
      deletionId: `deletion_${manifest.manifestId}`,
      artifactId: manifest.manifestId,
      retentionPolicyId: retentionPolicy.policyId,
      scheduledForIso: deletedAtIso,
      deletedAtIso,
      revokedKeyIds: retentionPolicy.deleteWrappedKeysOnExpiry ? [manifest.wrappedKeyId] : []
    };

    await this.putObject(this.deletionRecordKey(deletionRecord.deletionId), deletionRecord);
    return deletionRecord;
  }

  async listDeletionRecords(): Promise<DeletionRecord[]> {
    const keys = await this.listObjects("deletions/");
    return (await Promise.all(keys.map((key) => this.getObject<DeletionRecord>(key)))).filter(
      (record): record is DeletionRecord => Boolean(record)
    );
  }
}
