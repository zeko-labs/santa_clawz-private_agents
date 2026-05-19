import { randomUUID } from "node:crypto";
import process from "node:process";

function hasValue(value) {
  return Boolean(value?.trim());
}

function normalizeEndpoint(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function headers(apiKey) {
  return {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
  };
}

async function readJson(response) {
  const text = await response.text();
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function requestJson(endpoint, route, options = {}) {
  const response = await fetch(`${endpoint}${route}`, {
    ...options,
    headers: {
      ...headers(options.apiKey),
      ...(options.headers ?? {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const payload = await readJson(response).catch(() => undefined);
  return {
    ok: response.ok,
    status: response.status,
    payload
  };
}

function keyIsValid(payload) {
  if (!payload?.keyBase64) {
    return false;
  }

  return Buffer.from(payload.keyBase64, "base64").byteLength === 32;
}

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    requireExternalHsm:
      argv.includes("--require-external-hsm") ||
      ["1", "true", "yes", "on"].includes(process.env.CLAWZ_REGULATED_ENTERPRISE?.trim().toLowerCase() ?? "")
  };
}

function resolveConfig() {
  const sharedEndpoint = process.env.CLAWZ_PRIVACY_GATEWAY_ENDPOINT?.trim();
  const sharedApiKey = process.env.CLAWZ_PRIVACY_GATEWAY_API_KEY?.trim();
  const kmsEndpoint = process.env.CLAWZ_KMS_ENDPOINT?.trim() || sharedEndpoint;
  const objectEndpoint = process.env.CLAWZ_BLOB_STORE_ENDPOINT?.trim() || sharedEndpoint;

  return {
    kmsEndpoint: kmsEndpoint ? normalizeEndpoint(kmsEndpoint) : undefined,
    objectEndpoint: objectEndpoint ? normalizeEndpoint(objectEndpoint) : undefined,
    kmsApiKey: process.env.CLAWZ_KMS_API_KEY?.trim() || sharedApiKey,
    objectApiKey: process.env.CLAWZ_BLOB_STORE_API_KEY?.trim() || sharedApiKey
  };
}

function addCheck(checks, label, ok, detail) {
  checks.push({
    label,
    ok,
    detail
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = resolveConfig();
  const checks = [];

  addCheck(checks, "kms endpoint configured", hasValue(config.kmsEndpoint), "CLAWZ_KMS_ENDPOINT or CLAWZ_PRIVACY_GATEWAY_ENDPOINT");
  addCheck(
    checks,
    "object endpoint configured",
    hasValue(config.objectEndpoint),
    "CLAWZ_BLOB_STORE_ENDPOINT or CLAWZ_PRIVACY_GATEWAY_ENDPOINT"
  );

  if (checks.some((check) => !check.ok)) {
    printReport(options, checks);
    process.exitCode = 1;
    return;
  }

  const tenantId = `preflight_tenant_${randomUUID().slice(0, 8)}`;
  const workspaceId = `preflight_workspace_${randomUUID().slice(0, 8)}`;
  const objectKey = `preflight/${randomUUID()}.json`;

  const health = await requestJson(config.objectEndpoint, "/health", {
    method: "GET"
  });
  addCheck(checks, "gateway health", health.ok, `GET /health -> ${health.status}`);
  if (options.requireExternalHsm) {
    addCheck(
      checks,
      "external hsm key provider",
      health.payload?.keyProvider === "external-hsm-derive" &&
        health.payload?.rootKeyMaterialInProcess === false &&
        health.payload?.hsmEndpointConfigured === true,
      `keyProvider=${health.payload?.keyProvider ?? "unknown"} rootKeyMaterialInProcess=${String(
        health.payload?.rootKeyMaterialInProcess
      )}`
    );
  }

  const tenantKey = await requestJson(config.kmsEndpoint, "/tenant-key", {
    method: "POST",
    apiKey: config.kmsApiKey,
    body: { tenantId }
  });
  addCheck(checks, "tenant key", tenantKey.ok && keyIsValid(tenantKey.payload), `POST /tenant-key -> ${tenantKey.status}`);

  const workspaceKey = await requestJson(config.kmsEndpoint, "/workspace-key", {
    method: "POST",
    apiKey: config.kmsApiKey,
    body: { tenantId, workspaceId }
  });
  addCheck(
    checks,
    "workspace key",
    workspaceKey.ok && keyIsValid(workspaceKey.payload),
    `POST /workspace-key -> ${workspaceKey.status}`
  );

  const put = await requestJson(config.objectEndpoint, `/objects/${encodeURIComponent(objectKey)}`, {
    method: "PUT",
    apiKey: config.objectApiKey,
    body: {
      kind: "clawz-privacy-gateway-preflight",
      objectKey,
      generatedAtIso: new Date().toISOString()
    }
  });
  addCheck(checks, "object write", put.status === 204, `PUT /objects/:key -> ${put.status}`);

  const list = await requestJson(config.objectEndpoint, `/objects?prefix=${encodeURIComponent("preflight/")}`, {
    method: "GET",
    apiKey: config.objectApiKey
  });
  addCheck(
    checks,
    "object list",
    list.ok && Array.isArray(list.payload?.keys) && list.payload.keys.includes(objectKey),
    `GET /objects?prefix=preflight/ -> ${list.status}`
  );

  const read = await requestJson(config.objectEndpoint, `/objects/${encodeURIComponent(objectKey)}`, {
    method: "GET",
    apiKey: config.objectApiKey
  });
  addCheck(
    checks,
    "object read",
    read.ok && read.payload?.kind === "clawz-privacy-gateway-preflight",
    `GET /objects/:key -> ${read.status}`
  );

  const deleted = await requestJson(config.objectEndpoint, `/objects/${encodeURIComponent(objectKey)}`, {
    method: "DELETE",
    apiKey: config.objectApiKey
  });
  addCheck(checks, "object delete", deleted.status === 204, `DELETE /objects/:key -> ${deleted.status}`);

  printReport(options, checks);
  if (checks.some((check) => !check.ok)) {
    process.exitCode = 1;
  }
}

function printReport(options, checks) {
  const report = {
    ok: checks.every((check) => check.ok),
    generatedAtIso: new Date().toISOString(),
    checks
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`ClawZ privacy gateway check ${report.ok ? "passed" : "failed"}`);
  checks.forEach((check) => {
    console.log(`${check.ok ? "ok " : "bad"} ${check.label}: ${check.detail}`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
