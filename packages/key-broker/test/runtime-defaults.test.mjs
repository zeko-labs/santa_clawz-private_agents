import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { TenantKeyBroker } = await import(new URL("../dist/key-broker/src/index.js", import.meta.url));

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      try {
        resolve(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function startKmsServer() {
  const workspaceKeys = new Map();
  const server = createServer(async (request, response) => {
    try {
      const body = await readRequestJson(request);
      const keyId =
        request.url === "/tenant-key"
          ? `tenant:${body.tenantId}`
          : request.url === "/workspace-key"
            ? `workspace:${body.tenantId}:${body.workspaceId}`
            : undefined;
      if (!keyId) {
        response.writeHead(404).end();
        return;
      }

      if (!workspaceKeys.has(keyId)) {
        workspaceKeys.set(keyId, Buffer.alloc(32, keyId).toString("base64").slice(0, 44));
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keyBase64: workspaceKeys.get(keyId) }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to start test KMS server.");
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

test("default runtime persists wrapped keys when a durable directory is configured", { concurrency: false }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawz-key-broker-"));
  const previousDir = process.env.CLAWZ_KEY_BROKER_DIR;
  const previousMode = process.env.CLAWZ_KEY_BROKER_MODE;
  const scope = {
    tenantId: "tenant_enterprise",
    workspaceId: "workspace_ops"
  };

  process.env.CLAWZ_KEY_BROKER_DIR = tempDir;
  delete process.env.CLAWZ_KEY_BROKER_MODE;

  try {
    const broker = new TenantKeyBroker();
    const { dataKey } = broker.issueDataKey(scope);
    const record = await broker.wrapDataKey(scope, "team-sealed", dataKey);

    assert.equal(broker.getRuntimeDescriptor().mode, "durable-local-file-backed");
    assert.equal(broker.getRuntimeDescriptor().baseDir, tempDir);

    const restartedBroker = new TenantKeyBroker();
    const reopened = await restartedBroker.unwrapDataKey({
      keyId: record.keyId,
      actorId: "workspace_member_001",
      actorRole: "workspace-member"
    });

    assert.equal(reopened.toString("base64"), dataKey.toString("base64"));
  } finally {
    restoreEnv("CLAWZ_KEY_BROKER_DIR", previousDir);
    restoreEnv("CLAWZ_KEY_BROKER_MODE", previousMode);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("explicit in-memory runtime stays ephemeral across broker instances", { concurrency: false }, async () => {
  const previousDir = process.env.CLAWZ_KEY_BROKER_DIR;
  const previousMode = process.env.CLAWZ_KEY_BROKER_MODE;
  const scope = {
    tenantId: "tenant_ephemeral",
    workspaceId: "workspace_sandbox"
  };

  delete process.env.CLAWZ_KEY_BROKER_DIR;
  process.env.CLAWZ_KEY_BROKER_MODE = "in-memory-default-export";

  try {
    const broker = new TenantKeyBroker();
    const { dataKey } = broker.issueDataKey(scope);
    const record = await broker.wrapDataKey(scope, "team-sealed", dataKey);

    assert.equal(broker.getRuntimeDescriptor().mode, "in-memory-default-export");

    const restartedBroker = new TenantKeyBroker();
    await assert.rejects(
      restartedBroker.unwrapDataKey({
        keyId: record.keyId,
        actorId: "workspace_member_001",
        actorRole: "workspace-member"
      }),
      /Unknown keyId/
    );
  } finally {
    restoreEnv("CLAWZ_KEY_BROKER_DIR", previousDir);
    restoreEnv("CLAWZ_KEY_BROKER_MODE", previousMode);
  }
});

test("external KMS mode keeps wrapped-key records durable without local master keys", { concurrency: false }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawz-external-kms-"));
  const kms = await startKmsServer();
  const previousDir = process.env.CLAWZ_KEY_BROKER_DIR;
  const previousMode = process.env.CLAWZ_KEY_BROKER_MODE;
  const previousEndpoint = process.env.CLAWZ_KMS_ENDPOINT;
  const scope = {
    tenantId: "tenant_enterprise",
    workspaceId: "workspace_external"
  };

  process.env.CLAWZ_KEY_BROKER_DIR = tempDir;
  process.env.CLAWZ_KEY_BROKER_MODE = "external-kms-backed";
  process.env.CLAWZ_KMS_ENDPOINT = kms.endpoint;

  try {
    const broker = new TenantKeyBroker();
    const { dataKey } = broker.issueDataKey(scope);
    const record = await broker.wrapDataKey(scope, "team-sealed", dataKey);

    assert.equal(broker.getRuntimeDescriptor().mode, "external-kms-backed");
    assert.equal(broker.getRuntimeDescriptor().externalKmsEndpoint, kms.endpoint);

    const restartedBroker = new TenantKeyBroker();
    const reopened = await restartedBroker.unwrapDataKey({
      keyId: record.keyId,
      actorId: "workspace_member_001",
      actorRole: "workspace-member"
    });

    assert.equal(reopened.toString("base64"), dataKey.toString("base64"));
  } finally {
    restoreEnv("CLAWZ_KEY_BROKER_DIR", previousDir);
    restoreEnv("CLAWZ_KEY_BROKER_MODE", previousMode);
    restoreEnv("CLAWZ_KMS_ENDPOINT", previousEndpoint);
    await kms.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
