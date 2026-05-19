import { randomUUID } from "node:crypto";
import path from "node:path";

import { canonicalDigest } from "@clawz/protocol";

import { evaluateAccess } from "./access/policy.js";
import { FileTenantKms } from "./kms/FileTenantKms.js";
import { HttpTenantKms } from "./kms/HttpTenantKms.js";
import { InMemoryTenantKms } from "./kms/in-memory-kms.js";
import { FileWrappedKeyStore } from "./store/FileWrappedKeyStore.js";
import type {
  KeyScope,
  TenantKms,
  TenantKeyBrokerRuntimeDescriptor,
  TenantKeyBrokerRuntimeMode,
  UnwrapRequest,
  WrappedKeyRecord,
  WrappedKeyStore
} from "./types.js";
import { openBytes, randomKey, sealBytes } from "./wrapping/aes-gcm.js";

class InMemoryWrappedKeyStore implements WrappedKeyStore {
  private readonly records = new Map<string, WrappedKeyRecord>();

  async save(record: WrappedKeyRecord): Promise<void> {
    this.records.set(record.keyId, record);
  }

  async get(keyId: string): Promise<WrappedKeyRecord | undefined> {
    return this.records.get(keyId);
  }

  async list(): Promise<WrappedKeyRecord[]> {
    return [...this.records.values()];
  }
}

function isRuntimeMode(value?: string): value is TenantKeyBrokerRuntimeMode {
  return (
    value === "durable-local-file-backed" ||
    value === "external-kms-backed" ||
    value === "in-memory-default-export"
  );
}

function defaultBaseDir(): string {
  return path.join(process.cwd(), ".clawz-data", "kms");
}

export function resolveTenantKeyBrokerRuntimeDescriptor(
  overrides: Partial<TenantKeyBrokerRuntimeDescriptor> = {}
): TenantKeyBrokerRuntimeDescriptor {
  const envMode = isRuntimeMode(process.env.CLAWZ_KEY_BROKER_MODE)
    ? process.env.CLAWZ_KEY_BROKER_MODE
    : undefined;
  const mode = overrides.mode ?? envMode ?? "durable-local-file-backed";

  if (mode === "in-memory-default-export") {
    return {
      mode
    };
  }

  const envBaseDir = process.env.CLAWZ_KEY_BROKER_DIR?.trim();
  const baseDir =
    overrides.baseDir ?? (envBaseDir && envBaseDir.length > 0 ? envBaseDir : defaultBaseDir());
  const externalKmsEndpoint = overrides.externalKmsEndpoint ?? process.env.CLAWZ_KMS_ENDPOINT?.trim();

  return {
    mode,
    baseDir,
    wrappedKeyDir: overrides.wrappedKeyDir ?? path.join(baseDir, "wrapped-keys"),
    ...(mode === "external-kms-backed" && externalKmsEndpoint ? { externalKmsEndpoint } : {}),
    ...(mode === "external-kms-backed"
      ? { externalKmsAuthConfigured: Boolean(process.env.CLAWZ_KMS_API_KEY?.trim()) }
      : {})
  };
}

function buildRuntimeDependencies(runtime: TenantKeyBrokerRuntimeDescriptor): {
  runtime: TenantKeyBrokerRuntimeDescriptor;
  kms: TenantKms;
  records: WrappedKeyStore;
} {
  if (runtime.mode === "in-memory-default-export") {
    return {
      runtime,
      kms: new InMemoryTenantKms(),
      records: new InMemoryWrappedKeyStore()
    };
  }

  const baseDir = runtime.baseDir ?? defaultBaseDir();
  const wrappedKeyDir = runtime.wrappedKeyDir ?? path.join(baseDir, "wrapped-keys");
  if (runtime.mode === "external-kms-backed") {
    if (!runtime.externalKmsEndpoint) {
      throw new Error("CLAWZ_KMS_ENDPOINT is required when using external-kms-backed mode.");
    }

    return {
      runtime: {
        mode: runtime.mode,
        baseDir,
        wrappedKeyDir,
        externalKmsEndpoint: runtime.externalKmsEndpoint,
        externalKmsAuthConfigured: Boolean(process.env.CLAWZ_KMS_API_KEY?.trim())
      },
      kms: new HttpTenantKms(runtime.externalKmsEndpoint, process.env.CLAWZ_KMS_API_KEY),
      records: new FileWrappedKeyStore(wrappedKeyDir)
    };
  }

  return {
    runtime: {
      mode: runtime.mode,
      baseDir,
      wrappedKeyDir
    },
    kms: new FileTenantKms(baseDir),
    records: new FileWrappedKeyStore(wrappedKeyDir)
  };
}

export class TenantKeyBroker {
  private readonly kms: TenantKms;
  private readonly records: WrappedKeyStore;
  private readonly runtime: TenantKeyBrokerRuntimeDescriptor;

  constructor(
    kms?: TenantKms,
    records?: WrappedKeyStore,
    runtime = resolveTenantKeyBrokerRuntimeDescriptor()
  ) {
    const resolvedRuntime = resolveTenantKeyBrokerRuntimeDescriptor(runtime);
    const defaults = buildRuntimeDependencies(resolvedRuntime);
    this.runtime = defaults.runtime;
    this.kms = kms ?? defaults.kms;
    this.records = records ?? defaults.records;
  }

  issueDataKey(scope: KeyScope) {
    return {
      keyId: `key_${scope.tenantId}_${scope.workspaceId}_${randomUUID()}`,
      dataKey: randomKey()
    };
  }

  async wrapDataKey(
    scope: KeyScope,
    visibility: WrappedKeyRecord["visibility"],
    dataKey: Buffer
  ): Promise<WrappedKeyRecord> {
    const workspaceKey = await this.kms.getWorkspaceKey(scope.tenantId, scope.workspaceId);
    const envelope = sealBytes(dataKey, workspaceKey);
    const keyId = `key_${scope.tenantId}_${scope.workspaceId}_${randomUUID()}`;

    const record: WrappedKeyRecord = {
      keyId,
      scope,
      visibility,
      wrappedDekBase64: envelope.cipherTextBase64,
      wrapIvBase64: envelope.ivBase64,
      wrapTagBase64: envelope.authTagBase64,
      createdAtIso: new Date().toISOString(),
      metadataDigest: canonicalDigest({
        scope,
        visibility,
        keyId
      }).sha256Hex
    };

    await this.records.save(record);
    return record;
  }

  async unwrapDataKey(request: UnwrapRequest): Promise<Buffer> {
    const record = await this.records.get(request.keyId);
    if (!record) {
      throw new Error(`Unknown keyId: ${request.keyId}`);
    }

    const decision = evaluateAccess(record, request);
    if (!decision.allowed) {
      throw new Error(decision.reason);
    }

    const workspaceKey = await this.kms.getWorkspaceKey(record.scope.tenantId, record.scope.workspaceId);
    return openBytes(
      {
        cipherTextBase64: record.wrappedDekBase64,
        ivBase64: record.wrapIvBase64,
        authTagBase64: record.wrapTagBase64
      },
      workspaceKey
    );
  }

  async revokeKey(keyId: string, revokedAtIso = new Date().toISOString()) {
    const record = await this.records.get(keyId);
    if (!record) {
      return;
    }

    await this.records.save({
      ...record,
      revokedAtIso
    });
  }

  getRecord(keyId: string): Promise<WrappedKeyRecord | undefined> {
    return this.records.get(keyId);
  }

  listRecords(): Promise<WrappedKeyRecord[]> {
    return this.records.list();
  }

  getRuntimeDescriptor(): TenantKeyBrokerRuntimeDescriptor {
    return this.runtime;
  }
}

export function createTenantKeyBroker(
  runtime: Partial<TenantKeyBrokerRuntimeDescriptor> = {}
): TenantKeyBroker {
  return new TenantKeyBroker(undefined, undefined, resolveTenantKeyBrokerRuntimeDescriptor(runtime));
}
