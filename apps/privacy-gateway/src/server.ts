import { timingSafeEqual, hkdfSync } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import express from "express";

type KeyRequest = {
  tenantId?: string;
  workspaceId?: string;
};

type ObjectListResponse = {
  keys: string[];
};

type KeyProviderMode = "local-root" | "external-hsm-derive";

type KeyDerivationResult = {
  key: Buffer;
  keyVersion?: string;
  auditId?: string;
  provider?: string;
};

type KeyProviderDescriptor = {
  mode: KeyProviderMode;
  rootKeyMaterialInProcess: boolean;
  boundary: string;
  hsmEndpointConfigured?: boolean;
  hsmAuthConfigured?: boolean;
};

type KeyProvider = {
  descriptor: KeyProviderDescriptor;
  deriveTenantKey(tenantId: string): Promise<KeyDerivationResult>;
  deriveWorkspaceKey(tenantId: string, workspaceId: string): Promise<KeyDerivationResult>;
};

type GatewayOptions = {
  apiKey?: string;
  allowUnauthenticated?: boolean;
  keyProviderMode?: KeyProviderMode;
  rootKeyBase64?: string;
  rootKeyFile?: string;
  hsmEndpoint?: string;
  hsmApiKey?: string;
  regulatedEnterprise?: boolean;
  objectDir?: string;
  maxJsonBytes?: string;
};

type ExternalDeriveKeyResponse = {
  keyBase64?: string;
  keyVersion?: string;
  auditId?: string;
  provider?: string;
};

const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production" || process.env.CLAWZ_RUNTIME_ENV === "production";
}

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function normalizeEndpoint(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function defaultObjectDir(): string {
  const dataDir = process.env.CLAWZ_DATA_DIR?.trim() || path.join(process.cwd(), ".clawz-data");
  return path.join(dataDir, "privacy-gateway", "objects");
}

function decodeRootKey(rootKeyBase64: string | undefined): Buffer | undefined {
  if (!rootKeyBase64?.trim()) {
    return undefined;
  }

  const key = Buffer.from(rootKeyBase64.trim(), "base64");
  if (key.byteLength < 32) {
    throw new Error("CLAWZ_PRIVACY_GATEWAY_ROOT_KEY_BASE64 must decode to at least 32 bytes.");
  }

  return key;
}

async function resolveRootKey(options: GatewayOptions): Promise<Buffer> {
  const inlineKey = decodeRootKey(options.rootKeyBase64 ?? process.env.CLAWZ_PRIVACY_GATEWAY_ROOT_KEY_BASE64);
  if (inlineKey) {
    return inlineKey;
  }

  const keyFile = options.rootKeyFile ?? process.env.CLAWZ_PRIVACY_GATEWAY_ROOT_KEY_FILE;
  if (keyFile?.trim()) {
    return decodeRootKey(await readFile(keyFile.trim(), "utf8")) as Buffer;
  }

  throw new Error(
    "Configure CLAWZ_PRIVACY_GATEWAY_ROOT_KEY_BASE64 or CLAWZ_PRIVACY_GATEWAY_ROOT_KEY_FILE before starting the privacy gateway."
  );
}

function isKeyProviderMode(value: string | undefined): value is KeyProviderMode {
  return value === "local-root" || value === "external-hsm-derive";
}

function decodeDerivedKey(payload: ExternalDeriveKeyResponse, label: string): KeyDerivationResult {
  if (!payload.keyBase64) {
    throw new Error(`KMS/HSM derivation response missing keyBase64 for ${label}.`);
  }

  const key = Buffer.from(payload.keyBase64, "base64");
  if (key.byteLength !== 32) {
    throw new Error(`KMS/HSM derivation response returned invalid key length for ${label}.`);
  }

  return {
    key,
    ...(payload.keyVersion ? { keyVersion: payload.keyVersion } : {}),
    ...(payload.auditId ? { auditId: payload.auditId } : {}),
    ...(payload.provider ? { provider: payload.provider } : {})
  };
}

function assertSafeId(value: string | undefined, label: string): string {
  if (!value || !SAFE_ID_PATTERN.test(value)) {
    throw new Error(`${label} must match ${SAFE_ID_PATTERN.toString()}.`);
  }

  return value;
}

function deriveKey(rootKey: Buffer, label: string, parts: string[]): Buffer {
  const salt = Buffer.from("clawz/privacy-gateway/v1", "utf8");
  const info = Buffer.from([label, ...parts].join(":"), "utf8");
  return Buffer.from(hkdfSync("sha256", rootKey, salt, info, 32));
}

async function createLocalRootKeyProvider(options: GatewayOptions): Promise<KeyProvider> {
  const rootKey = await resolveRootKey(options);

  return {
    descriptor: {
      mode: "local-root",
      rootKeyMaterialInProcess: true,
      boundary: "service-process"
    },
    async deriveTenantKey(tenantId: string) {
      return {
        key: deriveKey(rootKey, "tenant", [tenantId])
      };
    },
    async deriveWorkspaceKey(tenantId: string, workspaceId: string) {
      return {
        key: deriveKey(rootKey, "workspace", [tenantId, workspaceId])
      };
    }
  };
}

function createExternalHsmKeyProvider(options: GatewayOptions): KeyProvider {
  const endpoint = options.hsmEndpoint ?? process.env.CLAWZ_PRIVACY_GATEWAY_HSM_ENDPOINT;
  const apiKey = options.hsmApiKey ?? process.env.CLAWZ_PRIVACY_GATEWAY_HSM_API_KEY;

  if (!endpoint?.trim()) {
    throw new Error("CLAWZ_PRIVACY_GATEWAY_HSM_ENDPOINT is required when using external-hsm-derive mode.");
  }

  if (isProductionEnv() && !apiKey?.trim()) {
    throw new Error("CLAWZ_PRIVACY_GATEWAY_HSM_API_KEY is required for production external-hsm-derive mode.");
  }

  const normalizedEndpoint = normalizeEndpoint(endpoint.trim());

  async function requestDerivedKey(label: "tenant" | "workspace", body: Record<string, string>) {
    const response = await fetch(`${normalizedEndpoint}/derive-key`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey?.trim() ? { authorization: `Bearer ${apiKey.trim()}` } : {})
      },
      body: JSON.stringify({
        derivation: "clawz/privacy-gateway/v1",
        label,
        ...body
      })
    });

    if (!response.ok) {
      throw new Error(`KMS/HSM derivation failed for ${label}: ${response.status}`);
    }

    return decodeDerivedKey((await response.json()) as ExternalDeriveKeyResponse, label);
  }

  return {
    descriptor: {
      mode: "external-hsm-derive",
      rootKeyMaterialInProcess: false,
      boundary: "external-kms-hsm",
      hsmEndpointConfigured: true,
      hsmAuthConfigured: Boolean(apiKey?.trim())
    },
    deriveTenantKey(tenantId: string) {
      return requestDerivedKey("tenant", { tenantId });
    },
    deriveWorkspaceKey(tenantId: string, workspaceId: string) {
      return requestDerivedKey("workspace", { tenantId, workspaceId });
    }
  };
}

async function createKeyProvider(options: GatewayOptions): Promise<KeyProvider> {
  const envMode = process.env.CLAWZ_PRIVACY_GATEWAY_KEY_PROVIDER;
  const mode = options.keyProviderMode ?? (isKeyProviderMode(envMode) ? envMode : "local-root");

  if (mode === "external-hsm-derive") {
    return createExternalHsmKeyProvider(options);
  }

  return createLocalRootKeyProvider(options);
}

function keyResponse(result: KeyDerivationResult) {
  return {
    keyBase64: result.key.toString("base64"),
    ...(result.keyVersion ? { keyVersion: result.keyVersion } : {}),
    ...(result.auditId ? { auditId: result.auditId } : {}),
    ...(result.provider ? { provider: result.provider } : {})
  };
}

function hasBearerToken(request: { header(name: string): string | undefined }, expected: string | undefined): boolean {
  if (!expected) {
    return false;
  }

  const authorization = request.header("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  const received = Buffer.from(token);
  const wanted = Buffer.from(expected);
  return received.byteLength === wanted.byteLength && timingSafeEqual(received, wanted);
}

function sanitizeObjectKey(encodedKey: string | undefined): string {
  if (!encodedKey) {
    throw new Error("object key is required.");
  }

  const key = decodeURIComponent(encodedKey);
  if (
    key.startsWith("/") ||
    key.includes("\\") ||
    key.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("object key must be a relative path without traversal segments.");
  }

  return key;
}

function objectPath(baseDir: string, key: string): string {
  const target = path.join(baseDir, key);
  const relative = path.relative(baseDir, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("object key escaped the object directory.");
  }

  return target;
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function listObjectKeys(baseDir: string, prefix: string): Promise<string[]> {
  async function walk(currentDir: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(currentDir);
    } catch (error) {
      const maybeCode = error as { code?: string };
      if (maybeCode.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const nested = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(currentDir, entry);
        const relativeKey = path.relative(baseDir, fullPath).split(path.sep).join("/");
        try {
          return await walk(fullPath);
        } catch (error) {
          const maybeCode = error as { code?: string };
          if (maybeCode.code === "ENOTDIR") {
            return [relativeKey];
          }
          throw error;
        }
      })
    );

    return nested.flat();
  }

  const keys = await walk(baseDir);
  return keys.filter((key) => key.startsWith(prefix)).sort();
}

export async function createPrivacyGatewayApp(options: GatewayOptions = {}) {
  const keyProvider = await createKeyProvider(options);
  const objectDir = options.objectDir ?? process.env.CLAWZ_PRIVACY_GATEWAY_OBJECT_DIR ?? defaultObjectDir();
  const apiKey = options.apiKey ?? process.env.CLAWZ_PRIVACY_GATEWAY_API_KEY;
  const regulatedEnterprise =
    options.regulatedEnterprise ?? truthy(process.env.CLAWZ_REGULATED_ENTERPRISE);
  const allowUnauthenticated =
    options.allowUnauthenticated ?? truthy(process.env.CLAWZ_PRIVACY_GATEWAY_ALLOW_UNAUTHENTICATED);

  if (isProductionEnv() && !apiKey && !allowUnauthenticated) {
    throw new Error("CLAWZ_PRIVACY_GATEWAY_API_KEY is required for production privacy gateway deployments.");
  }

  if (regulatedEnterprise && keyProvider.descriptor.mode !== "external-hsm-derive") {
    throw new Error("CLAWZ_REGULATED_ENTERPRISE=true requires CLAWZ_PRIVACY_GATEWAY_KEY_PROVIDER=external-hsm-derive.");
  }

  await mkdir(objectDir, { recursive: true, mode: 0o700 });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: options.maxJsonBytes ?? process.env.CLAWZ_PRIVACY_GATEWAY_MAX_JSON_BYTES ?? "16mb" }));
  app.use((request: any, response: any, next: () => void) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");

    if (request.path === "/health") {
      next();
      return;
    }

    if (allowUnauthenticated || hasBearerToken(request, apiKey)) {
      next();
      return;
    }

    response.status(401).json({
      error: "privacy gateway authentication required"
    });
  });

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      service: "clawz-privacy-gateway",
      objectStore: "file-backed",
      kms: keyProvider.descriptor.mode === "external-hsm-derive" ? "external-hsm-derive" : "hkdf-root-backed",
      keyProvider: keyProvider.descriptor.mode,
      keyBoundary: keyProvider.descriptor.boundary,
      rootKeyMaterialInProcess: keyProvider.descriptor.rootKeyMaterialInProcess,
      regulatedEnterprise,
      hsmEndpointConfigured: Boolean(keyProvider.descriptor.hsmEndpointConfigured),
      hsmAuthConfigured: Boolean(keyProvider.descriptor.hsmAuthConfigured)
    });
  });

  app.post("/health", (_request, response) => {
    response.json({
      ok: true
    });
  });

  app.post("/tenant-key", async (request, response) => {
    try {
      const body = request.body as KeyRequest;
      const tenantId = assertSafeId(body.tenantId, "tenantId");
      response.json(keyResponse(await keyProvider.deriveTenantKey(tenantId)));
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/workspace-key", async (request, response) => {
    try {
      const body = request.body as KeyRequest;
      const tenantId = assertSafeId(body.tenantId, "tenantId");
      const workspaceId = assertSafeId(body.workspaceId, "workspaceId");
      response.json(keyResponse(await keyProvider.deriveWorkspaceKey(tenantId, workspaceId)));
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/objects", async (request, response) => {
    try {
      const prefix = typeof request.query.prefix === "string" ? request.query.prefix : "";
      const payload: ObjectListResponse = {
        keys: await listObjectKeys(objectDir, prefix)
      };
      response.json(payload);
    } catch (error) {
      response.status(500).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.put("/objects/:key", async (request, response) => {
    try {
      const key = sanitizeObjectKey(request.params.key);
      await writePrivateJson(objectPath(objectDir, key), request.body);
      response.status(204).end();
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/objects/:key", async (request, response) => {
    try {
      const key = sanitizeObjectKey(request.params.key);
      const filePath = objectPath(objectDir, key);
      response.type("application/json").send(await readFile(filePath, "utf8"));
    } catch (error) {
      const maybeCode = error as { code?: string };
      response.status(maybeCode.code === "ENOENT" ? 404 : 400).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.delete("/objects/:key", async (request, response) => {
    try {
      const key = sanitizeObjectKey(request.params.key);
      await rm(objectPath(objectDir, key), { force: true });
      response.status(204).end();
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  return app;
}

export async function startPrivacyGateway() {
  const host = process.env.HOST ?? "0.0.0.0";
  const port = Number(process.env.PORT ?? "8789");
  const app = await createPrivacyGatewayApp();

  app.listen(port, host, () => {
    console.log(`ClawZ privacy gateway listening on http://${host}:${port}`);
  });
}

if (process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts")) {
  startPrivacyGateway().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
