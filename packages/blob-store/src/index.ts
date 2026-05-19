import type { TenantKeyBroker } from "@clawz/key-broker";

import { HttpSealedBlobStore } from "./encryption/HttpSealedBlobStore.js";
import { LocalSealedBlobStore } from "./encryption/LocalSealedBlobStore.js";
import type { SealedBlobStore } from "./types.js";

export * from "./encryption/LocalSealedBlobStore.js";
export * from "./encryption/HttpSealedBlobStore.js";
export * from "./manifests/create-manifest.js";
export * from "./retrieval/disclosure-service.js";
export * from "./retention/retention-engine.js";
export * from "./types.js";

export type SealedBlobStoreRuntimeMode = "local-file-backed" | "http-object-store";

export interface CreateSealedBlobStoreOptions {
  baseDir: string;
  keyBroker: TenantKeyBroker;
  mode?: SealedBlobStoreRuntimeMode;
  endpoint?: string;
  bearerToken?: string;
}

function resolveBlobStoreMode(mode?: SealedBlobStoreRuntimeMode): SealedBlobStoreRuntimeMode {
  const envMode = process.env.CLAWZ_BLOB_STORE_MODE;
  if (mode === "http-object-store" || mode === "local-file-backed") {
    return mode;
  }
  if (envMode === "http-object-store" || envMode === "local-file-backed") {
    return envMode;
  }
  return "local-file-backed";
}

export function createSealedBlobStore(options: CreateSealedBlobStoreOptions): SealedBlobStore {
  const mode = resolveBlobStoreMode(options.mode);
  if (mode === "http-object-store") {
    return new HttpSealedBlobStore(
      options.endpoint ?? process.env.CLAWZ_BLOB_STORE_ENDPOINT ?? "",
      options.keyBroker,
      options.bearerToken ?? process.env.CLAWZ_BLOB_STORE_API_KEY
    );
  }

  return new LocalSealedBlobStore(options.baseDir, options.keyBroker);
}
