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
