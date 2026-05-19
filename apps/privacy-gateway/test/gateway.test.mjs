import assert from "node:assert/strict";
import { hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { createPrivacyGatewayApp } = await import(new URL("../dist/server.js", import.meta.url));

async function startGateway(options = {}) {
  const app = await createPrivacyGatewayApp({
    rootKeyBase64: randomBytes(32).toString("base64"),
    apiKey: "gateway_secret",
    ...options
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to start test privacy gateway.");
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function headers(token = "gateway_secret") {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json"
  };
}

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

async function startHsmServer({ apiKey = "hsm_secret", rootKeyBase64 = randomBytes(32).toString("base64") } = {}) {
  const rootKey = Buffer.from(rootKeyBase64, "base64");
  const server = createServer(async (request, response) => {
    try {
      if (request.url !== "/derive-key" || request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }

      if (request.headers.authorization !== `Bearer ${apiKey}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "hsm auth required" }));
        return;
      }

      const body = await readRequestJson(request);
      const label = body.label;
      const parts = label === "tenant" ? [body.tenantId] : [body.tenantId, body.workspaceId];
      const salt = Buffer.from("clawz/privacy-gateway/v1", "utf8");
      const info = Buffer.from([label, ...parts].join(":"), "utf8");
      const key = Buffer.from(hkdfSync("sha256", rootKey, salt, info, 32));

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          keyBase64: key.toString("base64"),
          keyVersion: "hsm-key-v1",
          auditId: `audit_${label}_${body.tenantId}`,
          provider: "test-hsm"
        })
      );
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to start test HSM server.");
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("requires bearer auth outside the health endpoint", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawz-privacy-gateway-auth-"));
  const gateway = await startGateway({ objectDir: tempDir });

  try {
    const health = await fetch(`${gateway.endpoint}/health`);
    assert.equal(health.status, 200);

    const denied = await fetch(`${gateway.endpoint}/tenant-key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant_a" })
    });
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${gateway.endpoint}/tenant-key`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ tenantId: "tenant_a" })
    });
    assert.equal(allowed.status, 200);
    assert.equal(Buffer.from((await allowed.json()).keyBase64, "base64").byteLength, 32);
  } finally {
    await gateway.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("regulated enterprise mode rejects in-process local root key material", async () => {
  await assert.rejects(
    createPrivacyGatewayApp({
      rootKeyBase64: randomBytes(32).toString("base64"),
      regulatedEnterprise: true
    }),
    /requires CLAWZ_PRIVACY_GATEWAY_KEY_PROVIDER=external-hsm-derive/
  );
});

test("external HSM mode derives keys without local root key material", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawz-privacy-gateway-hsm-"));
  const hsm = await startHsmServer();
  const firstGateway = await startGateway({
    objectDir: tempDir,
    keyProviderMode: "external-hsm-derive",
    hsmEndpoint: hsm.endpoint,
    hsmApiKey: "hsm_secret",
    regulatedEnterprise: true
  });

  try {
    const health = await fetch(`${firstGateway.endpoint}/health`);
    const healthPayload = await health.json();
    assert.equal(healthPayload.keyProvider, "external-hsm-derive");
    assert.equal(healthPayload.rootKeyMaterialInProcess, false);
    assert.equal(healthPayload.regulatedEnterprise, true);

    const first = await fetch(`${firstGateway.endpoint}/workspace-key`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ tenantId: "tenant_a", workspaceId: "workspace_ops" })
    });
    assert.equal(first.status, 200);
    const firstPayload = await first.json();
    assert.equal(Buffer.from(firstPayload.keyBase64, "base64").byteLength, 32);
    assert.equal(firstPayload.keyVersion, "hsm-key-v1");
    assert.equal(firstPayload.provider, "test-hsm");

    await firstGateway.close();
    const secondGateway = await startGateway({
      objectDir: tempDir,
      keyProviderMode: "external-hsm-derive",
      hsmEndpoint: hsm.endpoint,
      hsmApiKey: "hsm_secret",
      regulatedEnterprise: true
    });
    try {
      const second = await fetch(`${secondGateway.endpoint}/workspace-key`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ tenantId: "tenant_a", workspaceId: "workspace_ops" })
      });
      assert.equal(second.status, 200);
      assert.equal((await second.json()).keyBase64, firstPayload.keyBase64);
    } finally {
      await secondGateway.close();
    }
  } finally {
    await hsm.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("derives stable tenant and workspace keys from the configured root", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawz-privacy-gateway-kms-"));
  const rootKeyBase64 = randomBytes(32).toString("base64");
  const firstGateway = await startGateway({ objectDir: tempDir, rootKeyBase64 });

  try {
    const first = await fetch(`${firstGateway.endpoint}/workspace-key`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ tenantId: "tenant_a", workspaceId: "workspace_ops" })
    });
    assert.equal(first.status, 200);
    const firstKey = (await first.json()).keyBase64;

    await firstGateway.close();
    const secondGateway = await startGateway({ objectDir: tempDir, rootKeyBase64 });
    try {
      const second = await fetch(`${secondGateway.endpoint}/workspace-key`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ tenantId: "tenant_a", workspaceId: "workspace_ops" })
      });
      assert.equal(second.status, 200);
      assert.equal((await second.json()).keyBase64, firstKey);
    } finally {
      await secondGateway.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("stores, lists, reads, and deletes sealed objects by key prefix", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawz-privacy-gateway-objects-"));
  const gateway = await startGateway({ objectDir: tempDir });
  const objectKey = `manifests/${randomUUID()}.json`;

  try {
    const put = await fetch(`${gateway.endpoint}/objects/${encodeURIComponent(objectKey)}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ manifestId: "manifest_1", ok: true })
    });
    assert.equal(put.status, 204);

    const list = await fetch(`${gateway.endpoint}/objects?prefix=${encodeURIComponent("manifests/")}`, {
      headers: headers()
    });
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).keys, [objectKey]);

    const read = await fetch(`${gateway.endpoint}/objects/${encodeURIComponent(objectKey)}`, {
      headers: headers()
    });
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { manifestId: "manifest_1", ok: true });

    const deleted = await fetch(`${gateway.endpoint}/objects/${encodeURIComponent(objectKey)}`, {
      method: "DELETE",
      headers: headers()
    });
    assert.equal(deleted.status, 204);

    const missing = await fetch(`${gateway.endpoint}/objects/${encodeURIComponent(objectKey)}`, {
      headers: headers()
    });
    assert.equal(missing.status, 404);
  } finally {
    await gateway.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
