import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { createEnterpriseKmsApp } = await import(new URL("../dist/server.js", import.meta.url));

async function startServer(options = {}) {
  const app = await createEnterpriseKmsApp({
    apiKey: "enterprise_secret",
    ...options
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to start test enterprise KMS server.");
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function headers(token = "enterprise_secret") {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json"
  };
}

test("requires bearer auth outside health", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawz-enterprise-kms-auth-"));
  const server = await startServer({
    providerMode: "local-dev-root",
    localDevRootKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    auditFile: path.join(tempDir, "audit.jsonl")
  });

  try {
    const health = await fetch(`${server.endpoint}/health`);
    assert.equal(health.status, 200);

    const rootHealth = await fetch(`${server.endpoint}/`);
    assert.equal(rootHealth.status, 200);
    const rootPayload = await rootHealth.json();
    assert.equal(rootPayload.service, "clawz-enterprise-kms");

    const denied = await fetch(`${server.endpoint}/derive-key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        derivation: "clawz/privacy-gateway/v1",
        label: "tenant",
        tenantId: "tenant_a"
      })
    });
    assert.equal(denied.status, 401);
  } finally {
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("command adapter derives keys through the sample adapter and writes audit lines without keys", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawz-enterprise-kms-command-"));
  const auditFile = path.join(tempDir, "audit", "derive-key.jsonl");
  const command = `CLAWZ_EXAMPLE_HSM_ROOT_KEY_BASE64=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= node ${new URL("../../../scripts/example-hsm-command.mjs", import.meta.url).pathname}`;
  const server = await startServer({
    providerMode: "command-adapter",
    command,
    auditFile
  });

  try {
    const response = await fetch(`${server.endpoint}/derive-key`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        derivation: "clawz/privacy-gateway/v1",
        label: "workspace",
        tenantId: "tenant_a",
        workspaceId: "workspace_ops"
      })
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(Buffer.from(payload.keyBase64, "base64").byteLength, 32);
    assert.equal(payload.provider, "example-hsm-command");

    const auditLog = await readFile(auditFile, "utf8");
    assert.match(auditLog, /"providerMode":"command-adapter"/);
    assert.match(auditLog, /"provider":"example-hsm-command"/);
    assert.doesNotMatch(auditLog, /keyBase64/);
  } finally {
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("http forwarder proxies a derive-key request to an upstream service", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawz-enterprise-kms-forwarder-"));
  const upstreamAudit = path.join(tempDir, "upstream-audit.jsonl");
  const upstream = await startServer({
    providerMode: "local-dev-root",
    allowUnauthenticated: true,
    localDevRootKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    auditFile: upstreamAudit
  });
  const forwarder = await startServer({
    providerMode: "http-forwarder",
    upstreamEndpoint: upstream.endpoint,
    upstreamApiKey: "enterprise_secret",
    auditFile: path.join(tempDir, "forwarder-audit.jsonl")
  });

  try {
    const response = await fetch(`${forwarder.endpoint}/derive-key`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        derivation: "clawz/privacy-gateway/v1",
        label: "tenant",
        tenantId: "tenant_a"
      })
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(Buffer.from(payload.keyBase64, "base64").byteLength, 32);
    assert.equal(payload.provider, "local-dev-root");
  } finally {
    await forwarder.close();
    await upstream.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
