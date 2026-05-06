import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const serverEntry = path.join(repoRoot, "apps", "indexer", "dist", "apps", "indexer", "src", "server.js");
const heartbeatEntry = path.join(repoRoot, "scripts", "agent-heartbeat.mjs");
const SERVER_READY_TIMEOUT_MS = 30_000;

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to reserve a TCP port.")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function startIndexer(workspaceDir, port) {
  const stdout = [];
  const stderr = [];
  const child = spawn("node", [serverEntry], {
    cwd: workspaceDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      CLAWZ_VALIDATE_AGENT_URLS: "true",
      CLAWZ_X402_BASE_FACILITATOR_URL: "https://x402-zeko.example",
      CLAWZ_SHARED_SOCIAL_ANCHOR_INTERVAL_MS: "60000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  return { child, stdout, stderr };
}

function startMockOpenClaw() {
  let challengePayload = null;
  let expectedIngressToken = "";
  const seenHireRequestIds = new Set();
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/.well-known/santaclawz-agent-challenge.json") {
      if (!challengePayload) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "challenge not set" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(challengePayload));
      return;
    }

    if (request.method === "POST" && request.url === "/hire") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const requestId = request.headers["x-santaclawz-request-id"];
        const timestamp = request.headers["x-santaclawz-timestamp"];
        const bodyDigest = request.headers["x-santaclawz-body-sha256"];
        const signature = request.headers["x-santaclawz-signature"];
        const authorization = request.headers.authorization;
        const expectedDigest = createHash("sha256").update(body).digest("hex");
        const expectedSignature =
          typeof timestamp === "string" && typeof requestId === "string"
            ? `v1=${createHmac("sha256", expectedIngressToken).update(`${timestamp}.${requestId}.${expectedDigest}`).digest("hex")}`
            : "";

        if (!expectedIngressToken || authorization !== `Bearer ${expectedIngressToken}`) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "missing ingress token" }));
          return;
        }
        if (typeof requestId !== "string" || seenHireRequestIds.has(requestId)) {
          response.writeHead(409, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "duplicate request id" }));
          return;
        }
        if (bodyDigest !== expectedDigest || signature !== expectedSignature) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid signature" }));
          return;
        }

        seenHireRequestIds.add(requestId);
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, accepted: true, requestId }));
      });
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, runtime: "mock-openclaw" }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to start mock OpenClaw server.")));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        setChallengePayload(nextPayload) {
          challengePayload = nextPayload;
        },
        setExpectedIngressToken(nextToken) {
          expectedIngressToken = nextToken;
        },
        close() {
          return new Promise((closeResolve) => server.close(closeResolve));
        }
      });
    });
  });
}

async function stopProcess(child) {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    child.once("exit", finish);
    child.once("close", finish);
    child.kill("SIGTERM");
    setTimeout(finish, 1000);
  });
}

async function waitForJson(url, timeoutMs = SERVER_READY_TIMEOUT_MS, logs = { stdout: [], stderr: [] }) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (response.ok) {
        return body.length > 0 ? JSON.parse(body) : {};
      }
      lastError = new Error(`${response.status}: ${body}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    [
      `Timed out waiting for ${url}`,
      lastError instanceof Error ? lastError.message : String(lastError ?? ""),
      logs.stdout.length > 0 ? `stdout:\n${logs.stdout.join("")}` : "",
      logs.stderr.length > 0 ? `stderr:\n${logs.stderr.join("")}` : ""
    ].filter(Boolean).join("\n\n")
  );
}

async function requestJson(url, init = {}) {
  const headers = {
    "content-type": "application/json",
    ...(init.headers ?? {})
  };
  const response = await fetch(url, {
    ...init,
    headers
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

async function runHeartbeatOnce(baseUrl, agentId, adminKey) {
  const stdout = [];
  const stderr = [];
  const child = spawn(
    "node",
    [
      heartbeatEntry,
      "--api-base",
      baseUrl,
      "--agent-id",
      agentId,
      "--admin-key",
      adminKey,
      "--ttl-seconds",
      "10",
      "--once"
    ],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  if (exitCode !== 0) {
    throw new Error(`Heartbeat sender failed:\n${stderr.join("")}`);
  }
  return JSON.parse(stdout.join(""));
}

async function main() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-openclaw-smoke-"));
  const indexerPort = await reservePort();
  const indexer = startIndexer(workspaceDir, indexerPort);
  const mockOpenClaw = await startMockOpenClaw();

  try {
    const baseUrl = `http://127.0.0.1:${indexerPort}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, indexer);

    const registered = await requestJson(`${baseUrl}/api/console/register`, {
      method: "POST",
      body: JSON.stringify({
        agentName: "OpenClaw Smoke Agent",
        headline: "Local OpenClaw smoke for SantaClawz heartbeat and hire readiness.",
        openClawUrl: mockOpenClaw.baseUrl,
        payoutWallets: {
          base: "0x1908217952D7117f5aeFBbd91AeBf04566D286f9"
        },
        paymentProfile: {
          enabled: true,
          supportedRails: ["base-usdc"],
          defaultRail: "base-usdc",
          pricingMode: "quote-required",
          referencePriceUsd: "0.20",
          referencePriceUnit: "minimum",
          settlementTrigger: "upfront"
        }
      })
    });
    assert.equal(registered.status, 200);
    const agentId = registered.payload.agentId;
    const sessionId = registered.payload.session.sessionId;
    const adminKey = registered.payload.adminAccess.issuedAdminKey;
    mockOpenClaw.setExpectedIngressToken(registered.payload.ingressAccess.issuedIngressToken);

    const challenge = await requestJson(`${baseUrl}/api/ownership/challenge`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({ sessionId, agentId })
    });
    assert.equal(challenge.status, 200);
    mockOpenClaw.setChallengePayload(JSON.parse(challenge.payload.issuedOwnershipChallenge.challengeResponseJson));

    const verified = await requestJson(`${baseUrl}/api/ownership/verify`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({ sessionId, agentId })
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.payload.ownership.status, "verified");

    const turnId = "turn_openclaw_smoke_001";
    const published = await requestJson(`${baseUrl}/api/events/ingest`, {
      method: "POST",
      body: JSON.stringify({
        id: "evt_openclaw_smoke_published",
        type: "TurnFinalized",
        occurredAtIso: new Date().toISOString(),
        payload: { sessionId, turnId }
      })
    });
    assert.equal(published.status, 202);

    const anchored = await requestJson(`${baseUrl}/api/social/anchors/settle`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({ sessionId, agentId, localOnly: true })
    });
    assert.equal(anchored.status, 200);
    assert.ok(anchored.payload.anchoredCount > 0);

    const heartbeat = await runHeartbeatOnce(baseUrl, agentId, adminKey);
    assert.equal(heartbeat.status, "live");

    const liveRegistry = await requestJson(`${baseUrl}/api/agents`);
    assert.equal(liveRegistry.status, 200);
    assert.equal(liveRegistry.payload.find((agent) => agent.agentId === agentId)?.runtimeStatus, "live");

    const hired = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Smoke-test hire request.",
        requesterContact: "smoke@example.com"
      })
    });
    assert.equal(hired.status, 200);
    assert.equal(hired.payload.status, "submitted");

    await new Promise((resolve) => setTimeout(resolve, 11_000));
    const waitingRegistry = await requestJson(`${baseUrl}/api/agents`);
    assert.equal(waitingRegistry.status, 200);
    assert.equal(waitingRegistry.payload.find((agent) => agent.agentId === agentId)?.runtimeStatus, "waiting");

    await mockOpenClaw.close();
    const offlineAvailability = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/availability`);
    assert.equal(offlineAvailability.status, 200);
    assert.equal(offlineAvailability.payload.runtimeStatus, "offline");
    assert.equal(offlineAvailability.payload.reachable, false);

    console.log("ok - OpenClaw public-agent smoke passed");
    console.log(`agentId=${agentId}`);
    console.log("flow=register -> verify -> publish marker -> local anchor -> heartbeat live -> hire -> waiting -> offline");
  } finally {
    await stopProcess(indexer.child);
    await mockOpenClaw.close().catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

await main();
