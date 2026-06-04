import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

const { HttpSealedBlobStore } = await import(new URL("../dist/blob-store/src/index.js", import.meta.url));

async function startObjectStore(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to start test object store.");
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("retries transient object-store health failures before bootstrapping", async () => {
  let attempts = 0;
  const objectStore = await startObjectStore((request, response) => {
    if (request.method !== "POST" || request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    attempts += 1;
    if (attempts < 3) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "gateway warming" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });

  try {
    const store = new HttpSealedBlobStore(objectStore.endpoint, {});
    await store.ensureDirs();
    assert.equal(attempts, 3);
  } finally {
    await objectStore.close();
  }
});

test("does not retry permanent object-store failures", async () => {
  let attempts = 0;
  const objectStore = await startObjectStore((_request, response) => {
    attempts += 1;
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "auth required" }));
  });

  try {
    const store = new HttpSealedBlobStore(objectStore.endpoint, {});
    await assert.rejects(() => store.ensureDirs(), /401/);
    assert.equal(attempts, 1);
  } finally {
    await objectStore.close();
  }
});

test("caches manifest list reads and filters by session locally", async () => {
  let listAttempts = 0;
  let getAttempts = 0;
  const manifests = {
    "manifests/manifest_a.json": {
      manifestId: "manifest_a",
      sessionId: "session_a",
      artifactClass: "summary",
      scope: { tenantId: "tenant", workspaceId: "workspace", sessionId: "session_a" },
      visibility: "operator-blind",
      retentionPolicyId: "retention",
      cipherPath: "object://cipher/a.json",
      wrappedKeyId: "wrapped_a",
      payloadDigest: "payload_a",
      metadataDigest: "metadata_a",
      byteLength: 10,
      createdAtIso: "2026-01-01T00:00:00.000Z"
    },
    "manifests/manifest_b.json": {
      manifestId: "manifest_b",
      sessionId: "session_b",
      artifactClass: "summary",
      scope: { tenantId: "tenant", workspaceId: "workspace", sessionId: "session_b" },
      visibility: "operator-blind",
      retentionPolicyId: "retention",
      cipherPath: "object://cipher/b.json",
      wrappedKeyId: "wrapped_b",
      payloadDigest: "payload_b",
      metadataDigest: "metadata_b",
      byteLength: 10,
      createdAtIso: "2026-01-02T00:00:00.000Z"
    }
  };
  const objectStore = await startObjectStore((request, response) => {
    if (request.method === "GET" && request.url === "/objects?prefix=manifests%2F") {
      listAttempts += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: Object.keys(manifests) }));
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/objects/")) {
      getAttempts += 1;
      const key = decodeURIComponent(request.url.slice("/objects/".length));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(manifests[key]));
      return;
    }

    response.writeHead(404).end();
  });

  try {
    const store = new HttpSealedBlobStore(objectStore.endpoint, {});
    assert.deepEqual((await store.listManifests("session_a")).map((manifest) => manifest.manifestId), ["manifest_a"]);
    assert.deepEqual((await store.listManifests("session_b")).map((manifest) => manifest.manifestId), ["manifest_b"]);
    assert.equal(listAttempts, 1);
    assert.equal(getAttempts, 2);
  } finally {
    await objectStore.close();
  }
});
