import { execSync } from "node:child_process";
import { hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import express from "express";

type ProviderMode = "command-adapter" | "http-forwarder" | "local-dev-root";
type DerivationLabel = "tenant" | "workspace";

type DeriveKeyRequest = {
  derivation?: string;
  label?: DerivationLabel;
  tenantId?: string;
  workspaceId?: string;
};

type DeriveKeyResponse = {
  keyBase64: string;
  keyVersion?: string;
  auditId?: string;
  provider?: string;
};

type ProviderDescriptor = {
  mode: ProviderMode;
  rootKeyMaterialInProcess: boolean;
  commandConfigured?: boolean;
  upstreamConfigured?: boolean;
};

type ProviderResult = DeriveKeyResponse & {
  providerMode: ProviderMode;
};

type Provider = {
  descriptor: ProviderDescriptor;
  deriveKey(request: Required<Pick<DeriveKeyRequest, "derivation" | "label" | "tenantId">> & Pick<DeriveKeyRequest, "workspaceId">): Promise<ProviderResult>;
};

type EnterpriseKmsOptions = {
  apiKey?: string;
  allowUnauthenticated?: boolean;
  providerMode?: ProviderMode;
  command?: string;
  commandTimeoutMs?: number;
  upstreamEndpoint?: string;
  upstreamApiKey?: string;
  localDevRootKeyBase64?: string;
  auditFile?: string;
  maxJsonBytes?: string;
};

const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DERIVATION_NAMESPACE = "clawz/privacy-gateway/v1";

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production" || process.env.CLAWZ_RUNTIME_ENV === "production";
}

function normalizeEndpoint(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function defaultAuditFile(): string {
  const dataDir = process.env.CLAWZ_DATA_DIR?.trim() || path.join(process.cwd(), ".clawz-data");
  return path.join(dataDir, "enterprise-kms", "audit", "derive-key.jsonl");
}

function isProviderMode(value: string | undefined): value is ProviderMode {
  return value === "command-adapter" || value === "http-forwarder" || value === "local-dev-root";
}

function assertSafeId(value: string | undefined, label: string): string {
  if (!value || !SAFE_ID_PATTERN.test(value)) {
    throw new Error(`${label} must match ${SAFE_ID_PATTERN.toString()}.`);
  }

  return value;
}

function assertRequest(body: DeriveKeyRequest) {
  const derivation = body.derivation;
  if (derivation !== DERIVATION_NAMESPACE) {
    throw new Error(`derivation must equal ${DERIVATION_NAMESPACE}.`);
  }

  const label = body.label;
  if (label !== "tenant" && label !== "workspace") {
    throw new Error("label must be tenant or workspace.");
  }

  const tenantId = assertSafeId(body.tenantId, "tenantId");
  const workspaceId = label === "workspace" ? assertSafeId(body.workspaceId, "workspaceId") : undefined;

  return {
    derivation,
    label,
    tenantId,
    ...(workspaceId ? { workspaceId } : {})
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

function decodeDerivedKey(payload: DeriveKeyResponse, label: DerivationLabel): DeriveKeyResponse {
  if (!payload.keyBase64) {
    throw new Error(`provider response missing keyBase64 for ${label}.`);
  }

  const key = Buffer.from(payload.keyBase64, "base64");
  if (key.byteLength !== 32) {
    throw new Error(`provider response returned invalid key length for ${label}.`);
  }

  return payload;
}

function decodeRootKey(rootKeyBase64: string | undefined): Buffer {
  if (!rootKeyBase64?.trim()) {
    throw new Error("CLAWZ_ENTERPRISE_KMS_LOCAL_DEV_ROOT_KEY_BASE64 is required for local-dev-root mode.");
  }

  const key = Buffer.from(rootKeyBase64.trim(), "base64");
  if (key.byteLength < 32) {
    throw new Error("CLAWZ_ENTERPRISE_KMS_LOCAL_DEV_ROOT_KEY_BASE64 must decode to at least 32 bytes.");
  }

  return key;
}

function deriveLocalKey(rootKey: Buffer, label: DerivationLabel, tenantId: string, workspaceId?: string): Buffer {
  const salt = Buffer.from(DERIVATION_NAMESPACE, "utf8");
  const info = Buffer.from(
    label === "workspace" ? [label, tenantId, workspaceId ?? ""].join(":") : [label, tenantId].join(":"),
    "utf8"
  );
  return Buffer.from(hkdfSync("sha256", rootKey, salt, info, 32));
}

function createCommandAdapterProvider(options: EnterpriseKmsOptions): Provider {
  const command = options.command ?? process.env.CLAWZ_ENTERPRISE_KMS_COMMAND;
  const timeoutMs =
    options.commandTimeoutMs ?? Number(process.env.CLAWZ_ENTERPRISE_KMS_COMMAND_TIMEOUT_MS ?? "8000");

  if (!command?.trim()) {
    throw new Error("CLAWZ_ENTERPRISE_KMS_COMMAND is required when provider mode is command-adapter.");
  }

  return {
    descriptor: {
      mode: "command-adapter",
      rootKeyMaterialInProcess: false,
      commandConfigured: true
    },
    async deriveKey(request) {
      try {
        const stdout = execSync(command.trim(), {
          input: JSON.stringify(request),
          stdio: ["pipe", "pipe", "pipe"],
          timeout: timeoutMs,
          env: process.env
        }).toString("utf8");

        const payload = decodeDerivedKey(JSON.parse(stdout) as DeriveKeyResponse, request.label);
        return {
          ...payload,
          providerMode: "command-adapter"
        };
      } catch (error) {
        const maybe = error as { stderr?: Buffer; message?: string };
        const stderr = maybe.stderr?.toString("utf8").trim();
        throw new Error(stderr || maybe.message || "enterprise KMS command adapter failed.");
      }
    }
  };
}

function createForwarderProvider(options: EnterpriseKmsOptions): Provider {
  const endpoint = options.upstreamEndpoint ?? process.env.CLAWZ_ENTERPRISE_KMS_UPSTREAM_ENDPOINT;
  const apiKey = options.upstreamApiKey ?? process.env.CLAWZ_ENTERPRISE_KMS_UPSTREAM_API_KEY;

  if (!endpoint?.trim()) {
    throw new Error("CLAWZ_ENTERPRISE_KMS_UPSTREAM_ENDPOINT is required when provider mode is http-forwarder.");
  }

  if (isProductionEnv() && !apiKey?.trim()) {
    throw new Error("CLAWZ_ENTERPRISE_KMS_UPSTREAM_API_KEY is required for production http-forwarder mode.");
  }

  const normalizedEndpoint = normalizeEndpoint(endpoint.trim());

  return {
    descriptor: {
      mode: "http-forwarder",
      rootKeyMaterialInProcess: false,
      upstreamConfigured: true
    },
    async deriveKey(request) {
      const response = await fetch(`${normalizedEndpoint}/derive-key`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey?.trim() ? { authorization: `Bearer ${apiKey.trim()}` } : {})
        },
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        throw new Error(`enterprise KMS upstream forward failed: ${response.status}`);
      }

      const payload = decodeDerivedKey((await response.json()) as DeriveKeyResponse, request.label);
      return {
        ...payload,
        providerMode: "http-forwarder"
      };
    }
  };
}

function createLocalDevRootProvider(options: EnterpriseKmsOptions): Provider {
  const rootKey = decodeRootKey(
    options.localDevRootKeyBase64 ?? process.env.CLAWZ_ENTERPRISE_KMS_LOCAL_DEV_ROOT_KEY_BASE64
  );

  return {
    descriptor: {
      mode: "local-dev-root",
      rootKeyMaterialInProcess: true
    },
    async deriveKey(request) {
      return {
        keyBase64: deriveLocalKey(rootKey, request.label, request.tenantId, request.workspaceId).toString("base64"),
        keyVersion: "local-dev-root-v1",
        auditId: `audit_${request.label}_${request.tenantId}`,
        provider: "local-dev-root",
        providerMode: "local-dev-root"
      };
    }
  };
}

function createProvider(options: EnterpriseKmsOptions): Provider {
  const mode = options.providerMode ?? (isProviderMode(process.env.CLAWZ_ENTERPRISE_KMS_PROVIDER_MODE)
    ? process.env.CLAWZ_ENTERPRISE_KMS_PROVIDER_MODE
    : "command-adapter");

  if (mode === "http-forwarder") {
    return createForwarderProvider(options);
  }

  if (mode === "local-dev-root") {
    return createLocalDevRootProvider(options);
  }

  return createCommandAdapterProvider(options);
}

async function appendAuditLine(filePath: string, event: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    flag: "a",
    mode: 0o600
  });
  await chmod(filePath, 0o600);
}

export async function createEnterpriseKmsApp(options: EnterpriseKmsOptions = {}) {
  const apiKey = options.apiKey ?? process.env.CLAWZ_ENTERPRISE_KMS_API_KEY;
  const allowUnauthenticated =
    options.allowUnauthenticated ?? truthy(process.env.CLAWZ_ENTERPRISE_KMS_ALLOW_UNAUTHENTICATED);
  const provider = createProvider(options);
  const auditFile = options.auditFile ?? process.env.CLAWZ_ENTERPRISE_KMS_AUDIT_FILE ?? defaultAuditFile();

  if (isProductionEnv() && !apiKey?.trim() && !allowUnauthenticated) {
    throw new Error("CLAWZ_ENTERPRISE_KMS_API_KEY is required for production enterprise KMS deployments.");
  }

  if (isProductionEnv() && provider.descriptor.mode === "local-dev-root") {
    throw new Error("local-dev-root mode is not allowed for production enterprise KMS deployments.");
  }

  await mkdir(path.dirname(auditFile), { recursive: true, mode: 0o700 });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: options.maxJsonBytes ?? process.env.CLAWZ_ENTERPRISE_KMS_MAX_JSON_BYTES ?? "1mb" }));
  app.use((request: any, response: any, next: () => void) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");

    if (request.path === "/" || request.path === "/health") {
      next();
      return;
    }

    if (allowUnauthenticated || hasBearerToken(request, apiKey)) {
      next();
      return;
    }

    response.status(401).json({
      error: "enterprise kms authentication required"
    });
  });

  async function healthPayload() {
    let auditLogConfigured = false;
    try {
      await access(path.dirname(auditFile));
      auditLogConfigured = true;
    } catch {
      auditLogConfigured = false;
    }

    return {
      ok: true,
      service: "clawz-enterprise-kms",
      derivation: DERIVATION_NAMESPACE,
      providerMode: provider.descriptor.mode,
      rootKeyMaterialInProcess: provider.descriptor.rootKeyMaterialInProcess,
      commandConfigured: Boolean(provider.descriptor.commandConfigured),
      upstreamConfigured: Boolean(provider.descriptor.upstreamConfigured),
      auditLogConfigured
    };
  }

  app.get("/", async (_request, response) => {
    response.json(await healthPayload());
  });

  app.get("/health", async (_request, response) => {
    response.json(await healthPayload());
  });

  app.post("/derive-key", async (request, response) => {
    const requestId = randomUUID();

    try {
      const parsed = assertRequest(request.body as DeriveKeyRequest);
      const derived = await provider.deriveKey(parsed);
      await appendAuditLine(auditFile, {
        requestId,
        createdAtIso: new Date().toISOString(),
        derivation: parsed.derivation,
        label: parsed.label,
        tenantId: parsed.tenantId,
        ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
        providerMode: derived.providerMode,
        ...(derived.provider ? { provider: derived.provider } : {}),
        ...(derived.keyVersion ? { keyVersion: derived.keyVersion } : {}),
        ...(derived.auditId ? { auditId: derived.auditId } : {})
      });

      response.json({
        keyBase64: derived.keyBase64,
        ...(derived.keyVersion ? { keyVersion: derived.keyVersion } : {}),
        ...(derived.auditId ? { auditId: derived.auditId } : {}),
        ...(derived.provider ? { provider: derived.provider } : {})
      });
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error),
        requestId
      });
    }
  });

  return app;
}

export async function startEnterpriseKms() {
  const host = process.env.HOST ?? "0.0.0.0";
  const port = Number(process.env.PORT ?? "8791");
  const app = await createEnterpriseKmsApp();

  app.listen(port, host, () => {
    console.log(`ClawZ enterprise KMS listening on http://${host}:${port}`);
  });
}

if (process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts")) {
  startEnterpriseKms().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
