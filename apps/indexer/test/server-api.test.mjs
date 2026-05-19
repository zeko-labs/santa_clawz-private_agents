import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverEntry = fileURLToPath(new URL("../dist/apps/indexer/src/server.js", import.meta.url));
const verifierEntry = fileURLToPath(new URL("../dist/apps/indexer/src/verify-agent-proof.js", import.meta.url));
const relayEntry = fileURLToPath(new URL("../../../scripts/relay-agent.mjs", import.meta.url));
const SERVER_READY_TIMEOUT_MS = 30000;

function startServer(workspaceDir, port, extraEnv = {}) {
  const stdout = [];
  const stderr = [];
  const child = spawn("node", [serverEntry], {
    cwd: workspaceDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => {
    stdout.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
  });

  return {
    child,
    stdout,
    stderr
  };
}

async function waitForJson(url, timeoutMs = SERVER_READY_TIMEOUT_MS, logs = { stdout: [], stderr: [] }) {
  const startedAt = Date.now();
  let lastStatus;
  let lastBody;
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (response.ok) {
        return body.length > 0 ? JSON.parse(body) : {};
      }
      lastStatus = response.status;
      lastBody = body;
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    [
      `Timed out waiting for ${url}`,
      lastStatus ? `last response: ${lastStatus}\n${lastBody ?? ""}` : "",
      lastError ? `last error: ${lastError instanceof Error ? lastError.message : String(lastError)}` : "",
      logs.stdout.length > 0 ? `stdout:\n${logs.stdout.join("")}` : "",
      logs.stderr.length > 0 ? `stderr:\n${logs.stderr.join("")}` : ""
    ]
      .filter(Boolean)
      .join("\n\n")
  );
}

async function waitForJsonMatch(url, predicate, timeoutMs = SERVER_READY_TIMEOUT_MS, logs = { stdout: [], stderr: [] }) {
  const startedAt = Date.now();
  let lastPayload;

  while (Date.now() - startedAt < timeoutMs) {
    const payload = await waitForJson(url, Math.min(2000, timeoutMs), logs);
    lastPayload = payload;
    if (predicate(payload)) {
      return payload;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for matching payload from ${url}\n\nlast payload:\n${JSON.stringify(lastPayload, null, 2)}`);
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

    if (child.exitCode !== null) {
      finish();
      return;
    }

    child.kill("SIGTERM");
    setTimeout(finish, 1000);
  });
}

async function startMissionAuthAuthority(port) {
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    response.setHeader("content-type", "application/json");

    if (url === "/.well-known/agent-authorization.json") {
      response.end(
        JSON.stringify({
          protocol: "zk-mission-auth",
          name: "Local Mission Authority",
          endpoints: {
            missionAuthorityJwks: `http://127.0.0.1:${port}/.well-known/mission-authority-jwks.json`,
            oauthProviders: `http://127.0.0.1:${port}/providers.json`,
            verifyCheckpoint: `http://127.0.0.1:${port}/verify`,
            exportBundle: `http://127.0.0.1:${port}/bundle`
          }
        })
      );
      return;
    }

    if (url === "/.well-known/mission-authority-jwks.json") {
      response.end(
        JSON.stringify({
          keys: [
            {
              kty: "OKP",
              crv: "Ed25519",
              kid: "local-test-key",
              x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            }
          ]
        })
      );
      return;
    }

    if (url === "/providers.json") {
      response.end(
        JSON.stringify({
          providers: ["auth0", "custom-oidc"]
        })
      );
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return server;
}

async function startHireIngress(port) {
  let challengePayload = null;
  let expectedIngressToken = "";
  let expectedSigningSecret = "";
  let expectedServiceKey = "";
  let nextProtocolReturnFactory = null;
  const receivedHireRequestIds = new Set();
  const receivedHireRequests = new Map();
  const server = createServer((request, response) => {
    const url = request.url ?? "/";

    if (request.method === "GET" && url === "/.well-known/santaclawz-agent-challenge.json") {
      response.setHeader("content-type", "application/json");
      if (!challengePayload) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "challenge not set" }));
        return;
      }
      response.end(JSON.stringify(challengePayload));
      return;
    }

    if (request.method === "POST" && url === "/hire") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const requestId = request.headers["x-santaclawz-request-id"];
        const timestamp = request.headers["x-santaclawz-timestamp"];
        const bodyDigest = request.headers["x-santaclawz-body-sha256"];
        const signature = request.headers["x-santaclawz-signature"];
        const authorization = request.headers.authorization;
        const expectedBodyDigest = createHash("sha256").update(body).digest("hex");
        const expectedSignature =
          typeof timestamp === "string" && typeof requestId === "string"
            ? `v1=${createHmac("sha256", expectedSigningSecret).update(`${timestamp}.${requestId}.${expectedBodyDigest}`).digest("hex")}`
            : "";

        response.setHeader("content-type", "application/json");
        if (!expectedIngressToken || authorization !== `Bearer ${expectedIngressToken}`) {
          response.statusCode = 401;
          response.end(JSON.stringify({ error: "missing ingress token" }));
          return;
        }
        if (typeof requestId !== "string" || receivedHireRequestIds.has(requestId)) {
          response.statusCode = 409;
          response.end(JSON.stringify({ error: "duplicate request id" }));
          return;
        }
        if (bodyDigest !== expectedBodyDigest || signature !== expectedSignature) {
          response.statusCode = 401;
          response.end(JSON.stringify({ error: "invalid signature" }));
          return;
        }
        const parsed = JSON.parse(body);
        if (parsed.schema_version !== "santaclawz-request/1.0") {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "bad schema" }));
          return;
        }
        if (
          expectedServiceKey &&
          (parsed.service_key !== expectedServiceKey || parsed.service !== expectedServiceKey)
        ) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "bad service key" }));
          return;
        }
        if (parsed.request_type === "quote_intake") {
          if (
            parsed.pricing_mode !== "quote-required" ||
            parsed.payment_status !== "quote_requested" ||
            parsed.payment?.status !== "quote_requested" ||
            parsed.paid_or_escrowed !== false ||
            parsed.settled_amount_usd !== undefined
          ) {
            response.statusCode = 400;
            response.end(JSON.stringify({ error: "bad quote intake policy" }));
            return;
          }
        } else if (parsed.request_type === "paid_execution") {
          if (
            !["fixed-exact", "quote-required"].includes(parsed.pricing_mode) ||
            !["settled", "paid", "escrowed"].includes(parsed.payment_status) ||
            parsed.payment?.status !== parsed.payment_status ||
            parsed.payment?.amount_usd !== parsed.settled_amount_usd ||
            parsed.paid_or_escrowed !== true
          ) {
            response.statusCode = 402;
            response.end(JSON.stringify({ error: "bad paid execution policy" }));
            return;
          }
          if (
            parsed.pricing_mode === "quote-required" &&
            (!String(parsed.quote_request_id ?? "").startsWith("hire_") ||
              !String(parsed.intent_id ?? "").startsWith("exec_") ||
              parsed.execution_request_id !== parsed.request_id ||
              parsed.payment?.quote_request_id !== parsed.quote_request_id ||
              parsed.payment?.execution_request_id !== parsed.request_id ||
              parsed.payment?.accepted_quote_digest_sha256 !== parsed.accepted_quote_digest_sha256)
          ) {
            response.statusCode = 400;
            response.end(JSON.stringify({ error: "bad quote paid execution lineage" }));
            return;
          }
        } else if (parsed.request_type === "free_test") {
          if (
            parsed.pricing_mode !== "free-test" ||
            parsed.payment_status !== "free_test" ||
            parsed.payment?.status !== "free_test" ||
            parsed.paid_or_escrowed !== false ||
            parsed.settled_amount_usd !== undefined ||
            parsed.payment?.rail !== undefined ||
            parsed.payment?.amount_usd !== undefined
          ) {
            response.statusCode = 400;
            response.end(JSON.stringify({ error: "bad free test policy" }));
            return;
          }
        } else {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "bad request_type" }));
          return;
        }
        receivedHireRequestIds.add(requestId);
        receivedHireRequests.set(requestId, parsed);
        if (nextProtocolReturnFactory) {
          const protocolReturn = nextProtocolReturnFactory({ requestId, request: parsed });
          nextProtocolReturnFactory = null;
          response.statusCode = 200;
          response.end(JSON.stringify(protocolReturn));
          return;
        }
        response.statusCode = 202;
        response.end(JSON.stringify({ ok: true, requestId }));
      });
      return;
    }

    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, runtime: "hire-ingress" }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    setChallengePayload(nextPayload) {
      challengePayload = nextPayload;
    },
    setExpectedIngressToken(nextToken) {
      expectedIngressToken = nextToken;
    },
    setExpectedSigningSecret(nextSecret) {
      expectedSigningSecret = nextSecret;
    },
    setExpectedServiceKey(nextServiceKey) {
      expectedServiceKey = nextServiceKey;
    },
    setNextProtocolReturnFactory(nextFactory) {
      nextProtocolReturnFactory = nextFactory;
    },
    receivedHireRequestIds,
    receivedHireRequests,
    close() {
      return stopHttpServer(server);
    }
  };
}

async function stopHttpServer(server) {
  await new Promise((resolve) => {
    server.close(resolve);
  });
}

async function connectRelaySocket(baseUrl, agentId, adminKey) {
  const url = new URL(`/api/agent-relay/connect?agentId=${encodeURIComponent(agentId)}`, baseUrl);
  const key = Buffer.from(`relay-test-${agentId}`).toString("base64").slice(0, 24).padEnd(24, "A");
  const socket = net.connect(Number(url.port), url.hostname);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write([
    `GET ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    `X-ClawZ-Admin-Key: ${adminKey}`,
    "\r\n"
  ].join("\r\n"));

  let buffer = Buffer.alloc(0);
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      socket.off("data", onData);
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      if (!header.startsWith("HTTP/1.1 101")) {
        reject(new Error(`Relay handshake failed: ${header.split("\r\n")[0] ?? "unknown"}`));
        return;
      }
      resolve();
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
  return socket;
}

function encodeClientWebSocketFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const length = body.length;
  const headerLength = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
  const header = Buffer.alloc(headerLength);
  header[0] = 0x81;
  if (length < 126) {
    header[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.from(body);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] = masked[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function sendRelayJson(socket, payload) {
  socket.write(encodeClientWebSocketFrame(payload));
}

async function waitForRelayJson(socket, predicate, timeoutMs = 5000) {
  let frameBuffer = Buffer.alloc(0);
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for relay websocket message."));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      frameBuffer = Buffer.concat([frameBuffer, chunk]);
      while (frameBuffer.length >= 2) {
        const opcode = frameBuffer[0] & 0x0f;
        let offset = 2;
        let payloadLength = frameBuffer[1] & 0x7f;
        if (payloadLength === 126) {
          if (frameBuffer.length < offset + 2) return;
          payloadLength = frameBuffer.readUInt16BE(offset);
          offset += 2;
        } else if (payloadLength === 127) {
          if (frameBuffer.length < offset + 8) return;
          payloadLength = Number(frameBuffer.readBigUInt64BE(offset));
          offset += 8;
        }
        if (frameBuffer.length < offset + payloadLength) return;
        const payload = frameBuffer.subarray(offset, offset + payloadLength);
        frameBuffer = frameBuffer.subarray(offset + payloadLength);
        if (opcode !== 0x1) {
          continue;
        }
        const message = JSON.parse(payload.toString("utf8"));
        if (predicate(message)) {
          cleanup();
          resolve(message);
          return;
        }
      }
      if (Date.now() - startedAt > timeoutMs) {
        cleanup();
        reject(new Error("Timed out waiting for matching relay websocket message."));
      }
    };

    socket.on("data", onData);
    socket.once("error", onError);
  });
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => {
          reject(new Error("Unable to reserve a TCP port."));
        });
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

async function requestJson(url, init) {
  const headers = {
    "content-type": "application/json",
    ...(init?.headers ?? {})
  };
  const response = await fetch(url, {
    ...init,
    headers
  });
  const payload = await response.json();
  return {
    status: response.status,
    payload
  };
}

function firstX402Accept(payload) {
  return (
    payload?.accepts?.[0] ??
    payload?.paymentRequired?.accepts?.[0] ??
    payload?.paymentRequirements?.accepts?.[0] ??
    payload?.requirements?.accepts?.[0] ??
    payload?.routes?.[0]?.accepts?.[0]
  );
}

async function requestBytes(url, init) {
  const response = await fetch(url, init);
  return {
    status: response.status,
    headers: response.headers,
    body: Buffer.from(await response.arrayBuffer())
  };
}

function buildTinyZip(entries) {
  const chunks = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    chunks.push(header, name, data);
  }
  return Buffer.concat(chunks);
}

async function runJsonCommand(command, args, cwd) {
  const stdout = [];
  const stderr = [];

  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => {
    stdout.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
  });

  const exitCode = await new Promise((resolve) => {
    child.once("exit", resolve);
  });

  if (exitCode !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        stdout.length ? `stdout:\n${stdout.join("")}` : "",
        stderr.length ? `stderr:\n${stderr.join("")}` : ""
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  }

  return JSON.parse(stdout.join(""));
}

async function testPersistenceFlow() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-test-"));
  const port = await reservePort();
  const server = startServer(workspaceDir, port);

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const initialState = await waitForJson(`${baseUrl}/api/console/state`, SERVER_READY_TIMEOUT_MS, server);
    assert.equal(initialState.wallet.trustModeId, "private");
    assert.equal(initialState.artifacts.length, 1);
    assert.equal(initialState.deployment.chain, "zeko");
    assert.ok(["local-runtime", "planned-testnet", "testnet-live"].includes(initialState.deployment.mode));
    assert.equal(initialState.deployment.privacyGrade, "production-grade");
    assert.equal(initialState.deployment.keyManagement, "durable-local-file-backed");
    assert.ok(Array.isArray(initialState.deployment.contracts));
    assert.ok(["idle", "queued", "running", "succeeded", "failed"].includes(initialState.liveFlow.status));
    assert.ok(Array.isArray(initialState.liveFlow.steps));
    assert.equal(initialState.liveFlow.flowKind, "first-turn");
    assert.equal(initialState.liveFlow.totalSteps, 10);
    assert.ok(Array.isArray(initialState.liveFlow.completedStepLabels));
    assert.equal(initialState.liveFlow.resumeAvailable, false);
    assert.ok(Array.isArray(initialState.liveFlowTargets.turns));
    assert.ok(Array.isArray(initialState.liveFlowTargets.disclosures));
    assert.ok(initialState.liveFlowTargets.turns.some((target) => target.turnId === "turn_0011"));
    assert.equal(initialState.sponsorQueue.status, "idle");
    assert.equal(initialState.sponsorQueue.pendingCount, 0);
    assert.ok(Array.isArray(initialState.sponsorQueue.items));

    const readiness = await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);
    assert.equal(readiness.ok, true);
    assert.equal(readiness.security.apiAuthRequired, false);
    assert.equal(readiness.deployment.keyManagement, "durable-local-file-backed");

    const discovery = await waitForJson(`${baseUrl}/.well-known/clawz-agent.json`, SERVER_READY_TIMEOUT_MS, server);
    assert.equal(discovery.protocol, "clawz-agent-proof");
    assert.ok(discovery.supportedMcpTools.includes("get_agent_proof_bundle"));
    assert.ok(discovery.supportedMcpTools.includes("verify_agent_proof"));
    assert.ok(discovery.supportedMcpTools.includes("get_zeko_deployment"));
    assert.equal(discovery.endpoints.deployment, `${baseUrl}/api/zeko/deployment`);
    assert.equal(discovery.endpoints.discovery, `${baseUrl}/.well-known/agent-interop.json?sessionId=${discovery.focusedSessionId}`);
    assert.equal(discovery.endpoints.verify, `${baseUrl}/api/interop/verify?sessionId=${discovery.focusedSessionId}`);

    const canonicalDiscovery = await waitForJson(`${baseUrl}/.well-known/agent-interop.json`, SERVER_READY_TIMEOUT_MS, server);
    assert.equal(canonicalDiscovery.endpoints.discovery, discovery.endpoints.discovery);

    const deployment = await waitForJson(`${baseUrl}/api/zeko/deployment`, SERVER_READY_TIMEOUT_MS, server);
    assert.equal(deployment.chain, "zeko");
    assert.equal(deployment.mode, initialState.deployment.mode);

    const directBundle = await waitForJson(`${baseUrl}/api/interop/agent-proof`, SERVER_READY_TIMEOUT_MS, server);
    assert.equal(directBundle.protocol, "clawz-agent-proof");
    assert.equal(directBundle.representation.representedPrincipal.publicKey, initialState.wallet.publicKey);
    assert.equal(directBundle.ownership.publicClawzUrl, `https://santaclawz.ai/agent/${encodeURIComponent(initialState.agentId)}`);
    assert.equal(directBundle.ownership.challengeUrl, undefined);
    assert.equal(directBundle.authority.sessionId, initialState.session.sessionId);
    assert.equal(directBundle.payment.settlementAsset, "MINA");
    assert.ok(Array.isArray(directBundle.originProofs));
    assert.ok(directBundle.originProofs.length >= 1);
    assert.equal(directBundle.exampleToolReceipt.originProofRef, directBundle.originProofs[0].originProofId);
    assert.ok(Array.isArray(directBundle.evidence));
    assert.ok(directBundle.evidence.length >= 4);
    assert.ok(directBundle.trustAnchors.some((anchor) => anchor.type === "zktls-verifier"));
    const currentBundle = await waitForJson(`${baseUrl}/api/interop/agent-proof`, SERVER_READY_TIMEOUT_MS, server);

    const mcpTools = await requestJson(`${baseUrl}/mcp`, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list"
      })
    });
    assert.equal(mcpTools.status, 200);
    assert.ok(mcpTools.payload.result.tools.some((tool) => tool.name === "get_agent_discovery"));
    assert.ok(mcpTools.payload.result.tools.some((tool) => tool.name === "get_agent_proof_bundle"));
    assert.ok(mcpTools.payload.result.tools.some((tool) => tool.name === "verify_agent_proof"));
    assert.ok(mcpTools.payload.result.tools.some((tool) => tool.name === "get_zeko_deployment"));

    const mcpBundle = await requestJson(`${baseUrl}/mcp`, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "get_agent_proof_bundle",
          arguments: {}
        }
      })
    });
    assert.equal(mcpBundle.status, 200);
    assert.equal(
      mcpBundle.payload.result.structuredContent.bundleDigest.sha256Hex,
      currentBundle.bundleDigest.sha256Hex
    );

    const mcpDeployment = await requestJson(`${baseUrl}/mcp`, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "get_zeko_deployment",
          arguments: {}
        }
      })
    });
    assert.equal(mcpDeployment.status, 200);
    assert.equal(mcpDeployment.payload.result.structuredContent.mode, deployment.mode);

    const verification = await waitForJson(`${baseUrl}/api/interop/verify`, SERVER_READY_TIMEOUT_MS, server);
    assert.equal(verification.ok, true);
    assert.equal(verification.source.mode, "self");
    assert.equal(verification.question.payment.settlementAsset, "MINA");
    assert.ok(verification.question.origin.proofCount >= 1);
    assert.equal(verification.summary.bundleDigestSha256, currentBundle.bundleDigest.sha256Hex);

    const mcpVerification = await requestJson(`${baseUrl}/mcp`, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "verify_agent_proof",
          arguments: {}
        }
      })
    });
    assert.equal(mcpVerification.status, 200);
    assert.equal(mcpVerification.payload.result.structuredContent.ok, true);
    assert.equal(
      mcpVerification.payload.result.structuredContent.summary.bundleDigestSha256,
      currentBundle.bundleDigest.sha256Hex
    );

    const verifierReport = await runJsonCommand("node", [verifierEntry, "--url", baseUrl, "--json"], workspaceDir);
    assert.equal(verifierReport.ok, true);
    assert.equal(verifierReport.witnessPlanCoverage.ok, true);

    const trustModeResult = await requestJson(`${baseUrl}/api/console/trust-mode`, {
      method: "POST",
      body: JSON.stringify({
        modeId: "team-governed"
      })
    });
    assert.equal(trustModeResult.status, 200);
    assert.equal(trustModeResult.payload.wallet.trustModeId, "team-governed");

    const sponsorResult = await requestJson(`${baseUrl}/api/wallet/sponsor`, {
      method: "POST",
      body: JSON.stringify({
        amountMina: "0.25"
      })
    });
    assert.equal(sponsorResult.status, 200);
    assert.ok(["queued", "running"].includes(sponsorResult.payload.sponsorQueue.status));
    assert.equal(sponsorResult.payload.sponsorQueue.pendingCount, 1);
    assert.equal(sponsorResult.payload.sponsorQueue.items[0]?.amountMina, "0.25");

    const queuedSponsors = await waitForJson(`${baseUrl}/api/wallet/sponsor/queue`, SERVER_READY_TIMEOUT_MS, server);
    assert.ok(Array.isArray(queuedSponsors.items));

    const sponsoredState = await waitForJsonMatch(
      `${baseUrl}/api/console/state`,
      (payload) =>
        payload.wallet?.sponsoredBudgetMina === "0.75" &&
        payload.wallet?.sponsoredRemainingMina === "0.75" &&
        payload.sponsorQueue?.items?.some((item) => item.status === "succeeded"),
      SERVER_READY_TIMEOUT_MS,
      server
    );
    assert.equal(sponsoredState.sponsorQueue.status, "idle");

    const recoveryResult = await requestJson(`${baseUrl}/api/wallet/recovery/prepare`, {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(recoveryResult.status, 200);
    assert.equal(recoveryResult.payload.wallet.recovery.status, "sealed");
    assert.equal(recoveryResult.payload.session.sealedArtifactCount, 2);

    const approvalResult = await requestJson(`${baseUrl}/api/privacy-exceptions/privacy_exception_002/approve`, {
      method: "POST",
      body: JSON.stringify({
        actorId: "guardian_compliance",
        actorRole: "compliance-reviewer",
        note: "Approved in API integration test."
      })
    });
    assert.equal(approvalResult.status, 200);
    const approvedException = approvalResult.payload.privacyExceptions.find((item) => item.id === "privacy_exception_002");
    assert.equal(approvedException?.status, "approved");

    const ingestResult = await requestJson(`${baseUrl}/api/events/ingest`, {
      method: "POST",
      body: JSON.stringify({
        id: "evt_external_001",
        type: "PrivacyExceptionRequested",
        occurredAtIso: "2026-04-20T08:00:00.000Z",
        payload: {
          sessionId: "session_demo_enterprise",
          turnId: "turn_0012",
          exceptionId: "privacy_exception_777",
          title: "Escalate one redacted artifact to legal",
          audience: "Legal counsel",
          reason: "Contract redline requires privileged review.",
          expiresAtIso: "2099-01-01T00:00:00.000Z"
        }
      })
    });
    assert.equal(ingestResult.status, 202);

    const finalState = await waitForJson(`${baseUrl}/api/console/state`, SERVER_READY_TIMEOUT_MS, server);
    assert.equal(finalState.wallet.deviceStatus, "recoverable");
    assert.equal(finalState.session.sealedArtifactCount, 2);
    assert.ok(finalState.privacyExceptions.some((item) => item.id === "privacy_exception_777"));
    assert.ok(finalState.sponsorQueue.items.some((item) => item.status === "succeeded"));

    const updatedBundle = await waitForJson(`${baseUrl}/api/interop/agent-proof`, SERVER_READY_TIMEOUT_MS, server);
    assert.equal(updatedBundle.authority.trustModeId, "team-governed");
    assert.ok(updatedBundle.authority.activePrivacyExceptions.some((item) => item.exceptionId === "privacy_exception_777"));
    assert.equal(updatedBundle.payment.sponsoredBudgetMina, "0.75");
    assert.equal(updatedBundle.payment.sponsoredRemainingMina, "0.75");

    const persistedConsole = JSON.parse(
      await readFile(path.join(workspaceDir, ".clawz-data", "state", "console.json"), "utf8")
    );
    const persistedEvents = JSON.parse(
      await readFile(path.join(workspaceDir, ".clawz-data", "state", "events.json"), "utf8")
    );

    assert.equal(persistedConsole.activeMode, "team-governed");
    assert.equal(persistedConsole.wallet.recovery.status, "sealed");
    assert.ok(persistedEvents.some((event) => event.type === "PrivacyExceptionGranted"));
    assert.ok(persistedEvents.some((event) => event.type === "CreditsDeposited"));
    assert.ok(persistedEvents.some((event) => event.id === "evt_external_001"));

    await stopProcess(server.child);

    const restarted = startServer(workspaceDir, port);
    try {
      const restartedState = await waitForJson(`${baseUrl}/api/console/state`, SERVER_READY_TIMEOUT_MS, restarted);
      assert.equal(restartedState.wallet.trustModeId, "team-governed");
      assert.equal(restartedState.wallet.recovery.status, "sealed");
      assert.ok(restartedState.privacyExceptions.some((item) => item.id === "privacy_exception_777"));
      assert.ok(restartedState.sponsorQueue.items.some((item) => item.status === "succeeded"));
    } finally {
      await stopProcess(restarted.child);
    }

    console.log("ok - indexer API persists privacy and wallet mutations across restarts");
  } finally {
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testMalformedEventFlow() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-invalid-"));
  const port = await reservePort();
  const server = startServer(workspaceDir, port);

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForJson(`${baseUrl}/health`, SERVER_READY_TIMEOUT_MS, server);
    assert.equal(health.service, "clawz-indexer");

    const result = await requestJson(`${baseUrl}/api/events/ingest`, {
      method: "POST",
      body: JSON.stringify({
        nope: true
      })
    });

    assert.equal(result.status, 400);
    assert.equal(result.payload.accepted, false);

    const invalidFlow = await requestJson(`${baseUrl}/api/zeko/flow/run`, {
      method: "POST",
      body: JSON.stringify({
        flowKind: "definitely-not-a-real-flow"
      })
    });

    assert.equal(invalidFlow.status, 400);
    assert.match(invalidFlow.payload.error, /Unsupported live flow kind/);
    console.log("ok - indexer API rejects malformed event payloads");
  } finally {
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testFocusedInteropSessionFlow() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-focused-"));
  const port = await reservePort();
  const server = startServer(workspaceDir, port);

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/api/console/state`, SERVER_READY_TIMEOUT_MS, server);

    const liveSessionId = "session_live_focus_test";
    const liveTurnId = "turn_live_focus_test";

    const sessionCreated = await requestJson(`${baseUrl}/api/events/ingest`, {
      method: "POST",
      body: JSON.stringify({
        id: "evt_focus_001",
        type: "SessionCreated",
        occurredAtIso: "2026-04-21T23:30:00.000Z",
        payload: {
          sessionId: liveSessionId,
          trustMode: "verified"
        }
      })
    });
    assert.equal(sessionCreated.status, 202);

    const turnFinalized = await requestJson(`${baseUrl}/api/events/ingest`, {
      method: "POST",
      body: JSON.stringify({
        id: "evt_focus_002",
        type: "TurnFinalized",
        occurredAtIso: "2026-04-21T23:35:00.000Z",
        payload: {
          sessionId: liveSessionId,
          turnId: liveTurnId,
          txHash: "5JfocusTurnFinalized",
          contractAddress: "B62qfocuscontract0000000000000000000000000000000000000"
        }
      })
    });
    assert.equal(turnFinalized.status, 202);

    const disclosureGranted = await requestJson(`${baseUrl}/api/events/ingest`, {
      method: "POST",
      body: JSON.stringify({
        id: "evt_focus_003",
        type: "DisclosureGranted",
        occurredAtIso: "2026-04-21T23:36:00.000Z",
        payload: {
          sessionId: liveSessionId,
          turnId: liveTurnId,
          disclosureId: `${liveTurnId}:disclosure:test`
        }
      })
    });
    assert.equal(disclosureGranted.status, 202);

    const inferredState = await waitForJson(`${baseUrl}/api/console/state`, SERVER_READY_TIMEOUT_MS, server);
    assert.ok(inferredState.session.knownSessionIds.includes("session_demo_enterprise"));
    assert.ok(inferredState.session.knownSessionIds.includes(liveSessionId));

    const focusedState = await waitForJson(
      `${baseUrl}/api/console/state?sessionId=${liveSessionId}`,
      SERVER_READY_TIMEOUT_MS,
      server
    );
    assert.equal(focusedState.session.sessionId, liveSessionId);
    assert.equal(focusedState.session.focusSource, "requested");
    assert.equal(focusedState.wallet.trustModeId, "verified");

    const requestedDemoState = await waitForJson(
      `${baseUrl}/api/console/state?sessionId=session_demo_enterprise`,
      SERVER_READY_TIMEOUT_MS,
      server
    );
    assert.equal(requestedDemoState.session.sessionId, "session_demo_enterprise");
    assert.equal(requestedDemoState.session.focusSource, "requested");

    const scopedModeUpdate = await requestJson(`${baseUrl}/api/console/trust-mode`, {
      method: "POST",
      body: JSON.stringify({
        modeId: "team-governed",
        sessionId: "session_demo_enterprise"
      })
    });
    assert.equal(scopedModeUpdate.status, 200);
    assert.equal(scopedModeUpdate.payload.session.sessionId, "session_demo_enterprise");
    assert.equal(scopedModeUpdate.payload.wallet.trustModeId, "team-governed");

    const filteredEvents = await waitForJson(`${baseUrl}/api/events?sessionId=${liveSessionId}`, SERVER_READY_TIMEOUT_MS, server);
    assert.equal(filteredEvents.length, 3);
    assert.ok(filteredEvents.every((event) => event.payload.sessionId === liveSessionId));

    const scopedDiscovery = await waitForJson(
      `${baseUrl}/.well-known/agent-interop.json?sessionId=${liveSessionId}`,
      SERVER_READY_TIMEOUT_MS,
      server
    );
    assert.equal(scopedDiscovery.focusedSessionId, liveSessionId);
    assert.match(scopedDiscovery.endpoints.proofBundle, new RegExp(`sessionId=${liveSessionId}`));
    assert.match(scopedDiscovery.endpoints.consoleState, new RegExp(`sessionId=${liveSessionId}`));
    assert.match(scopedDiscovery.endpoints.verify, new RegExp(`sessionId=${liveSessionId}`));

    const scopedBundle = await waitForJson(
      `${baseUrl}/api/interop/agent-proof?sessionId=${liveSessionId}&turnId=${liveTurnId}`,
      SERVER_READY_TIMEOUT_MS,
      server
    );
    assert.equal(scopedBundle.authority.sessionId, liveSessionId);
    assert.equal(scopedBundle.authority.turnId, liveTurnId);
    assert.equal(scopedBundle.authority.trustModeId, "verified");
    assert.ok(scopedBundle.evidence.some((item) => item.kind === "session" && item.id === liveSessionId));

    const discoveryViaMcp = await requestJson(`${baseUrl}/mcp`, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "get_agent_discovery",
          arguments: {
            sessionId: liveSessionId
          }
        }
      })
    });
    assert.equal(discoveryViaMcp.status, 200);
    assert.equal(discoveryViaMcp.payload.result.structuredContent.focusedSessionId, liveSessionId);

    const scopedVerification = await requestJson(`${baseUrl}/api/interop/verify`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: liveSessionId,
        turnId: liveTurnId
      })
    });
    assert.equal(scopedVerification.status, 200);
    assert.equal(scopedVerification.payload.ok, true);
    assert.equal(scopedVerification.payload.question.authority.sessionId, liveSessionId);
    assert.equal(scopedVerification.payload.question.authority.turnId, liveTurnId);

    const unknownSession = await requestJson(`${baseUrl}/api/console/state?sessionId=session_missing`, {
      method: "GET"
    });
    assert.equal(unknownSession.status, 400);
    assert.match(unknownSession.payload.error, /Unknown session/);

    const unknownTurn = await requestJson(
      `${baseUrl}/api/interop/agent-proof?sessionId=${liveSessionId}&turnId=turn_missing`,
      {
        method: "GET"
      }
    );
    assert.equal(unknownTurn.status, 400);
    assert.match(unknownTurn.payload.error, /Unknown turn/);

    console.log("ok - interop endpoints scope discovery and proof bundles to explicit live sessions");
  } finally {
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testProtectedApiAuth() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-auth-test-"));
  const port = await reservePort();
  const server = startServer(workspaceDir, port, {
    CLAWZ_REQUIRE_API_AUTH: "true",
    CLAWZ_API_KEYS: "test_operator_key",
    CLAWZ_PUBLIC_PROOF_SURFACE: "discovery-only"
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const readiness = await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);
    assert.equal(readiness.security.apiAuthRequired, true);
    assert.equal(readiness.security.apiKeyConfigured, true);

    const unauthorized = await requestJson(`${baseUrl}/api/events/ingest`, {
      method: "POST",
      body: JSON.stringify({
        id: "evt_auth_rejected",
        type: "CreditsDeposited",
        occurredAtIso: "2026-04-20T08:00:00.000Z",
        payload: {
          amountMina: "0.01"
        }
      })
    });
    assert.equal(unauthorized.status, 401);

    const authorized = await requestJson(`${baseUrl}/api/events/ingest`, {
      method: "POST",
      headers: {
        "x-api-key": "test_operator_key"
      },
      body: JSON.stringify({
        id: "evt_auth_accepted",
        type: "CreditsDeposited",
        occurredAtIso: "2026-04-20T08:00:00.000Z",
        payload: {
          amountMina: "0.01"
        }
      })
    });
    assert.equal(authorized.status, 202);

    const publicDiscovery = await waitForJson(`${baseUrl}/.well-known/agent-interop.json`, SERVER_READY_TIMEOUT_MS, server);
    assert.equal(publicDiscovery.protocol, "clawz-agent-proof");

    const publicAgentSearch = await requestJson(`${baseUrl}/api/agents/search?limit=1`, { method: "GET" });
    assert.equal(publicAgentSearch.status, 200);
    assert.equal(publicAgentSearch.payload.schemaVersion, "santaclawz-agent-directory-search/1.0");
    const searchedAgentId = publicAgentSearch.payload.agents[0]?.agentId;
    if (searchedAgentId) {
      const publicAgentReady = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(searchedAgentId)}/ready`, {
        method: "GET"
      });
      assert.equal(publicAgentReady.status, 200);
      assert.equal(publicAgentReady.payload.schemaVersion, "santaclawz-agent-readiness/1.0");
    }

    const publicProcurement = await requestJson(`${baseUrl}/api/procurement/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskPrompt: "Public buyer-agent procurement auth smoke.",
        requesterContact: "buyer-agent:test",
        budgetUsd: "0.25"
      })
    });
    assert.equal(publicProcurement.status, 200);
    assert.match(publicProcurement.payload.intent.intentId, /^proc_/);

    const tokenStateAccess = await requestJson(`${baseUrl}/api/executions/hire_missing/state?token=fake`, {
      method: "GET"
    });
    assert.notEqual(tokenStateAccess.status, 401);

    const protectedState = await requestJson(`${baseUrl}/api/console/state`, {
      method: "GET"
    });
    assert.equal(protectedState.status, 401);

    console.log("ok - indexer API enforces production API-key authentication when configured");
  } finally {
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testPublicOnboardingApiAuth() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-public-onboarding-test-"));
  const port = await reservePort();
  const server = startServer(workspaceDir, port, {
    CLAWZ_REQUIRE_API_AUTH: "true",
    CLAWZ_API_KEYS: "test_operator_key",
    CLAWZ_PUBLIC_PROOF_SURFACE: "discovery-only",
    CLAWZ_PUBLIC_ONBOARDING: "true"
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const readiness = await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);
    assert.equal(readiness.security.apiAuthRequired, true);
    assert.equal(readiness.security.apiKeyConfigured, true);
    assert.equal(readiness.security.publicOnboardingEnabled, true);

    const publicState = await requestJson(`${baseUrl}/api/console/state`, {
      method: "GET"
    });
    assert.equal(publicState.status, 200);

    const publicAgentMessages = await requestJson(`${baseUrl}/api/agent-messages`, {
      method: "GET"
    });
    assert.equal(publicAgentMessages.status, 200);
    assert.equal(publicAgentMessages.payload.schemaVersion, "santaclawz-agent-board/1.0");

    const publicEnrollmentTicket = await requestJson(`${baseUrl}/api/enrollment/tickets`, {
      method: "POST",
      body: JSON.stringify({
        agentName: "Public Enrollment Auth Smoke",
        headline: "Smoke test ticket creation without operator API key.",
        representedPrincipal: "SantaClawz smoke operator",
        payoutWallets: {
          base: "0x1908217952D7117f5aeFBbd91AeBf04566D286f9"
        },
        paymentProfile: {
          enabled: true,
          supportedRails: ["base-usdc"],
          defaultRail: "base-usdc",
          pricingMode: "quote-required",
          settlementTrigger: "upfront"
        }
      })
    });
    assert.equal(publicEnrollmentTicket.status, 200);
    assert.match(publicEnrollmentTicket.payload.ticket, /^scz_enroll_/);
    assert.match(publicEnrollmentTicket.payload.publicAgentUrl, /\/agent\/public-enrollment-auth-smoke--session_agent_/);
    assert.match(publicEnrollmentTicket.payload.publicHireUrl, /\/agent\/public-enrollment-auth-smoke--session_agent_.*\/hire$/);
    assert.equal(publicEnrollmentTicket.payload.challengeUrl, undefined);
    assert.equal(publicEnrollmentTicket.payload.enrollmentChallenge.challengeUrl, undefined);

    const publicEnrollmentRedeem = await requestJson(`${baseUrl}/api/enrollment/redeem`, {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(publicEnrollmentRedeem.status, 400);
    assert.match(publicEnrollmentRedeem.payload.error, /ticket is required/);

    const publicTrustMode = await requestJson(`${baseUrl}/api/console/trust-mode`, {
      method: "POST",
      body: JSON.stringify({
        modeId: "verified"
      })
    });
    assert.equal(publicTrustMode.status, 200);
    assert.equal(publicTrustMode.payload.wallet.trustModeId, "verified");

    const publicSponsor = await requestJson(`${baseUrl}/api/wallet/sponsor`, {
      method: "POST",
      body: JSON.stringify({
        amountMina: "0.15",
        purpose: "onboarding"
      })
    });
    assert.equal(publicSponsor.status, 200);

    const publicRecovery = await requestJson(`${baseUrl}/api/wallet/recovery/prepare`, {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(publicRecovery.status, 200);
    assert.equal(publicRecovery.payload.wallet.recovery.status, "sealed");

    const publicMissionAuthCheck = await requestJson(`${baseUrl}/api/mission-auth/check`, {
      method: "POST",
      body: JSON.stringify({
        missionAuthOverlay: {
          enabled: false,
          status: "disabled",
          scopeHints: []
        }
      })
    });
    assert.equal(publicMissionAuthCheck.status, 400);
    assert.match(publicMissionAuthCheck.payload.error, /Turn on the enterprise auth overlay first/);

    const publicDeploy = await requestJson(`${baseUrl}/api/zeko/session-turn/run`, {
      method: "POST",
      body: JSON.stringify({
        flowKind: "not-a-valid-flow"
      })
    });
    assert.equal(publicDeploy.status, 400);
    assert.match(publicDeploy.payload.error, /Unsupported live flow kind/);

    const protectedEvents = await requestJson(`${baseUrl}/api/events/ingest`, {
      method: "POST",
      body: JSON.stringify({
        id: "evt_public_onboarding_rejected",
        type: "CreditsDeposited",
        occurredAtIso: "2026-04-20T08:00:00.000Z",
        payload: {
          amountMina: "0.01"
        }
      })
    });
    assert.equal(protectedEvents.status, 401);

    const protectedApproval = await requestJson(`${baseUrl}/api/privacy-exceptions/privacy_exception_002/approve`, {
      method: "POST",
      body: JSON.stringify({
        actorId: "guardian_compliance",
        actorRole: "compliance-reviewer",
        note: "Should require operator auth."
      })
    });
    assert.equal(protectedApproval.status, 401);

    console.log("ok - public onboarding mode exposes only the intended browser onboarding routes");
  } finally {
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testOperatorCanDeleteLostKeyRegistration() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-delete-agent-test-"));
  const port = await reservePort();
  const server = startServer(workspaceDir, port, {
    CLAWZ_REQUIRE_API_AUTH: "true",
    CLAWZ_API_KEYS: "test_operator_key",
    CLAWZ_PUBLIC_PROOF_SURFACE: "discovery-only",
    CLAWZ_PUBLIC_ONBOARDING: "true"
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);

    const registered = await requestJson(`${baseUrl}/api/console/register`, {
      method: "POST",
      body: JSON.stringify({
        agentName: "Delete Me Smoke Agent",
        headline: "Temporary smoke registration.",
        openClawUrl: "http://127.0.0.1:49997/agent"
      })
    });
    assert.equal(registered.status, 200);
    const sessionId = registered.payload.session.sessionId;
    const agentId = registered.payload.agentId;
    assert.equal(sessionId.startsWith("session_agent_"), true);

    const publicRegistry = await requestJson(`${baseUrl}/api/agents`);
    assert.equal(publicRegistry.status, 200);
    assert.equal(publicRegistry.payload.some((agent) => agent.agentId === agentId), true);

    const rejectedDelete = await requestJson(`${baseUrl}/api/admin/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE",
      body: JSON.stringify({
        sessionId,
        reason: "Missing operator API key."
      })
    });
    assert.equal(rejectedDelete.status, 401);

    const deleted = await requestJson(`${baseUrl}/api/admin/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE",
      headers: {
        "x-api-key": "test_operator_key"
      },
      body: JSON.stringify({
        sessionId,
        reason: "Lost admin key for smoke-test registration."
      })
    });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.payload.deleted, true);
    assert.equal(deleted.payload.sessionId, sessionId);
    assert.equal(deleted.payload.agentId, agentId);

    const nextRegistry = await requestJson(`${baseUrl}/api/agents`);
    assert.equal(nextRegistry.status, 200);
    assert.equal(nextRegistry.payload.some((agent) => agent.agentId === agentId), false);

    const deletedState = await requestJson(`${baseUrl}/api/console/state?sessionId=${encodeURIComponent(sessionId)}`);
    assert.equal(deletedState.status, 400);
    assert.match(deletedState.payload.error, /Unknown session/);

    console.log("ok - platform operator can delete lost-key test registrations without weakening agent admin keys");
  } finally {
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testZekoSocialAnchorHealthAndMembershipState() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-zeko-anchor-health-test-"));
  const port = await reservePort();
  const server = startServer(workspaceDir, port);

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);

    const registered = await requestJson(`${baseUrl}/api/console/register`, {
      method: "POST",
      body: JSON.stringify({
        agentName: "Zeko Anchor Health Agent",
        headline: "Exercises social anchor health state.",
        openClawUrl: "http://127.0.0.1:49996/agent"
      })
    });
    assert.equal(registered.status, 200);
    const sessionId = registered.payload.session.sessionId;
    const agentId = registered.payload.agentId;
    const adminKey = registered.payload.adminAccess.issuedAdminKey;

    const pendingQueue = await requestJson(`${baseUrl}/api/social/anchors?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "GET",
      headers: {
        "x-clawz-admin-key": adminKey
      }
    });
    assert.equal(pendingQueue.status, 200);
    assert.equal(pendingQueue.payload.pendingCount > 0, true);
    assert.equal(pendingQueue.payload.submittedCount, 0);
    assert.equal(pendingQueue.payload.confirmedCount, 0);

    const pendingHealth = await requestJson(`${baseUrl}/api/zeko/health`, {
      method: "GET"
    });
    assert.equal(pendingHealth.status, 200);
    assert.equal(pendingHealth.payload.socialAnchor.pendingCount > 0, true);
    assert.equal(Array.isArray(pendingHealth.payload.socialAnchor.alerts), true);
    assert.ok(pendingHealth.payload.socialAnchor.alerts.some((alert) => /SocialAnchorKernel is not configured/.test(alert)));

    const settled = await requestJson(`${baseUrl}/api/social/anchors/settle`, {
      method: "POST",
      headers: {
        "x-clawz-admin-key": adminKey
      },
      body: JSON.stringify({
        sessionId,
        agentId,
        localOnly: true
      })
    });
    assert.equal(settled.status, 200);
    assert.equal(settled.payload.pendingCount, 0);
    assert.equal(settled.payload.confirmedCount > 0, true);
    assert.equal(settled.payload.anchoredCount, settled.payload.confirmedCount);
    assert.equal(settled.payload.recentBatches[0]?.status, "confirmed");
    assert.equal(typeof settled.payload.recentBatches[0]?.rootDigestSha256, "string");

    const confirmedItem = settled.payload.items.find((item) => item.status === "confirmed");
    assert.equal(typeof confirmedItem?.batchId, "string");
    assert.equal(confirmedItem?.batchRootDigestSha256, settled.payload.recentBatches[0]?.rootDigestSha256);
    assert.equal(confirmedItem?.batchAnchorField, settled.payload.recentBatches[0]?.anchorField);
    assert.equal(typeof confirmedItem?.batchItemIndex, "number");
    assert.equal(confirmedItem?.batchItemCount, settled.payload.recentBatches[0]?.itemCount);
    assert.equal(typeof confirmedItem?.confirmedAtIso, "string");

    const confirmedHealth = await requestJson(`${baseUrl}/api/zeko/health`, {
      method: "GET"
    });
    assert.equal(confirmedHealth.status, 200);
    assert.equal(confirmedHealth.payload.socialAnchor.confirmedCount > 0, true);
    assert.equal(
      confirmedHealth.payload.socialAnchor.latestConfirmedRootDigestSha256,
      settled.payload.recentBatches[0]?.rootDigestSha256
    );
    assert.equal(typeof confirmedHealth.payload.socialAnchor.lastSuccessfulAnchorAtIso, "string");

    console.log("ok - Zeko social anchor health exposes queue status and per-milestone batch membership");
  } finally {
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testProofBackedAgentMessageBoard() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-agent-board-test-"));
  const port = await reservePort();
  const server = startServer(workspaceDir, port);
  let relaySocket;

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);

    const emptyBoard = await requestJson(`${baseUrl}/api/agent-messages`);
    assert.equal(emptyBoard.status, 200);
    assert.equal(emptyBoard.payload.schemaVersion, "santaclawz-agent-board/1.0");
    assert.equal(emptyBoard.payload.totalVisibleMessages, 0);

    const registered = await requestJson(`${baseUrl}/api/console/register`, {
      method: "POST",
      body: JSON.stringify({
        agentName: "Agent Board Smoke",
        headline: "Publishes proof-backed public messages.",
        openClawUrl: "http://127.0.0.1:49995/agent"
      })
    });
    assert.equal(registered.status, 200);
    const agentId = registered.payload.agentId;
    const sessionId = registered.payload.session.sessionId;
    const adminKey = registered.payload.adminAccess.issuedAdminKey;

    const rejectedPost = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        messageType: "dispatch",
        body: "This should not post without the agent admin key."
      })
    });
    assert.equal(rejectedPost.status, 400);
    assert.match(rejectedPost.payload.error, /Admin key required/);

    const posted = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/messages`, {
      method: "POST",
      headers: {
        "x-clawz-admin-key": adminKey
      },
      body: JSON.stringify({
        messageType: "dispatch",
        body: "Ready for public quote requests and verified output summaries.",
        topicTags: ["quotes", "outputs"],
        capabilityTags: ["research.summary", "quote-builder"],
        outputDigestSha256: "a".repeat(64)
      })
    });
    assert.equal(posted.status, 200);
    assert.equal(posted.payload.schemaVersion, "santaclawz-agent-board-post/1.0");
    assert.equal(posted.payload.ok, true);
    const postedMessage = posted.payload.postedMessage;
    assert.equal(postedMessage.agentId, agentId);
    assert.equal(postedMessage.messageType, "dispatch");
    assert.deepEqual(postedMessage.capabilityTags, ["research.summary", "quote-builder"]);
    assert.equal(postedMessage.outputDigestSha256, "a".repeat(64));
    assert.equal(postedMessage.anchorStatus, "pending");
    assert.match(postedMessage.anchorCandidateId, /^anchor_/);
    assert.equal(postedMessage.requestedProofIntent, "per_message");
    assert.equal(postedMessage.proofIntent, "per_message");
    assert.equal(postedMessage.proofAdmissionReason, "requested");
    assert.match(postedMessage.messageDigestSha256, /^[a-f0-9]{64}$/);
    assert.equal(posted.payload.boardPreview.totalVisibleMessages, 1);
    assert.deepEqual(posted.payload.boardPreview.threads[0].capabilityTags, ["research.summary", "quote-builder"]);
    assert.equal(posted.payload.boardPreview.threads[0].messageCount, 1);

    const agentChatterPost = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/messages`, {
      method: "POST",
      headers: {
        "x-clawz-admin-key": adminKey
      },
      body: JSON.stringify({
        messageType: "dispatch",
        body: "Low-stakes chatter should be visible without promising a Zeko proof.",
        proofIntent: "agent_chatter",
        swarmId: "busy-run-agent-chatter"
      })
    });
    assert.equal(agentChatterPost.status, 200);
    assert.equal(agentChatterPost.payload.boardPreview.totalVisibleMessages, 2);
    assert.equal(agentChatterPost.payload.postedMessage.requestedProofIntent, "agent_chatter");
    assert.equal(agentChatterPost.payload.postedMessage.proofIntent, "agent_chatter");
    assert.equal(agentChatterPost.payload.postedMessage.proofAdmissionReason, "requested");
    assert.equal(agentChatterPost.payload.postedMessage.swarmId, "busy-run-agent-chatter");
    assert.equal(agentChatterPost.payload.postedMessage.anchorStatus, "not_proof_requested");

    const legacyDisplayOnlyPost = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/messages`, {
      method: "POST",
      headers: {
        "x-clawz-admin-key": adminKey
      },
      body: JSON.stringify({
        messageType: "dispatch",
        body: "Legacy display_only should map to agent chatter.",
        proofIntent: "display_only"
      })
    });
    assert.equal(legacyDisplayOnlyPost.status, 200);
    assert.equal(legacyDisplayOnlyPost.payload.boardPreview.totalVisibleMessages, 3);
    assert.equal(legacyDisplayOnlyPost.payload.postedMessage.requestedProofIntent, "agent_chatter");
    assert.equal(legacyDisplayOnlyPost.payload.postedMessage.proofIntent, "agent_chatter");

    const staleParentAppend = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/messages`, {
      method: "POST",
      headers: {
        "x-clawz-admin-key": adminKey
      },
      body: JSON.stringify({
        messageType: "reply",
        threadId: postedMessage.threadId,
        parentMessageId: "msg_ffffffffffffffffff",
        body: "Appending to the thread should not fail when an old parent is outside the visible window."
      })
    });
    assert.equal(staleParentAppend.status, 200);
    assert.equal(staleParentAppend.payload.boardPreview.totalVisibleMessages, 4);
    assert.equal(staleParentAppend.payload.postedMessage.threadId, postedMessage.threadId);

    let swarmBudgetPost;
    for (let index = 0; index < 9; index += 1) {
      swarmBudgetPost = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/messages`, {
        method: "POST",
        headers: {
          "x-clawz-admin-key": adminKey
        },
        body: JSON.stringify({
          messageType: "dispatch",
          body: `Busy swarm proof pressure message ${index + 1}`,
          proofIntent: "per_message",
          swarmId: "busy-run-proof-budget"
        })
      });
      assert.equal(swarmBudgetPost.status, 200);
    }
    assert.equal(swarmBudgetPost.payload.postedMessage.requestedProofIntent, "per_message");
    assert.equal(swarmBudgetPost.payload.postedMessage.proofIntent, "aggregate");
    assert.equal(swarmBudgetPost.payload.postedMessage.proofAdmissionReason, "swarm_proof_budget_exceeded");
    assert.equal(swarmBudgetPost.payload.postedMessage.anchorStatus, "aggregate_anchored");

    const concurrentRegistered = await requestJson(`${baseUrl}/api/console/register`, {
      method: "POST",
      body: JSON.stringify({
        agentName: "Concurrent Board Smoke",
        headline: "Publishes concurrent public proof requests.",
        openClawUrl: "http://127.0.0.1:49996/agent"
      })
    });
    assert.equal(concurrentRegistered.status, 200);
    const concurrentAgentId = concurrentRegistered.payload.agentId;
    const concurrentAdminKey = concurrentRegistered.payload.adminAccess.issuedAdminKey;
    const concurrentPosts = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        requestJson(`${baseUrl}/api/agents/${encodeURIComponent(concurrentAgentId)}/messages`, {
          method: "POST",
          headers: {
            "x-clawz-admin-key": concurrentAdminKey
          },
          body: JSON.stringify({
            messageType: "dispatch",
            body: `Concurrent proof pressure message ${index + 1}`,
            proofIntent: "per_message",
            swarmId: "busy-run-concurrent-proof-budget"
          })
        })
      )
    );
    assert.equal(concurrentPosts.every((post) => post.status === 200), true);
    const concurrentPostedMessages = concurrentPosts.map((post) => post.payload.postedMessage);
    assert.equal(concurrentPostedMessages.filter((message) => message.proofIntent === "per_message").length, 8);
    assert.equal(concurrentPostedMessages.filter((message) => message.proofAdmissionReason === "swarm_proof_budget_exceeded").length, 4);
    assert.equal(
      concurrentPostedMessages.every((message) =>
        message.proofIntent === "per_message" ? Boolean(message.anchorCandidateId) && message.anchorStatus === "pending" : true
      ),
      true
    );

    const publicBoard = await requestJson(
      `${baseUrl}/api/agent-messages?agentId=${encodeURIComponent(agentId)}&topic=quotes&capability=research.summary&outputDigest=${"a".repeat(64)}`
    );
    assert.equal(publicBoard.status, 200);
    assert.equal(publicBoard.payload.totalVisibleMessages, 1);
    assert.equal(publicBoard.payload.messages[0].body, "Ready for public quote requests and verified output summaries.");

    const relayRegistered = await requestJson(`${baseUrl}/api/console/register`, {
      method: "POST",
      body: JSON.stringify({
        agentName: "Relay Board Smoke",
        headline: "Publishes public messages over the authenticated relay.",
        publicClawzUrl: "https://santaclawz.ai/agent/relay-board-smoke-test",
        runtimeDelivery: {
          mode: "santaclawz-relay"
        }
      })
    });
    assert.equal(relayRegistered.status, 200);
    const relayAgentId = relayRegistered.payload.agentId;
    relaySocket = await connectRelaySocket(baseUrl, relayAgentId, relayRegistered.payload.adminAccess.issuedAdminKey);
    sendRelayJson(relaySocket, {
      type: "post_message",
      messageId: "relay-post-001",
      messageType: "question",
      body: "Looking for collaborators on proof-backed output packaging.",
      topicTags: ["collaboration"],
      capabilityTags: ["output.package"],
      proofIntent: "aggregate",
      swarmId: "swarm_research_ops",
      outputDigestSha256: "b".repeat(64)
    });
    const relayPostResult = await waitForRelayJson(
      relaySocket,
      (message) => message.type === "post_message_result" && message.messageId === "relay-post-001"
    );
    assert.equal(relayPostResult.ok, true);
    assert.equal(relayPostResult.agentId, relayAgentId);
    assert.equal(relayPostResult.postedMessage.agentId, relayAgentId);
    assert.equal(relayPostResult.postedMessage.messageType, "question");
    assert.deepEqual(relayPostResult.postedMessage.capabilityTags, ["output.package"]);
    assert.equal(relayPostResult.postedMessage.requestedProofIntent, "aggregate");
    assert.equal(relayPostResult.postedMessage.proofIntent, "aggregate");
    assert.equal(relayPostResult.postedMessage.proofAdmissionReason, "requested");
    assert.equal(relayPostResult.postedMessage.swarmId, "swarm_research_ops");
    assert.equal(relayPostResult.postedMessage.anchorStatus, "aggregate_anchored");

    const relayFilteredBoard = await requestJson(
      `${baseUrl}/api/agent-messages?agentId=${encodeURIComponent(relayAgentId)}&topic=collaboration&capability=output.package&outputDigestSha256=${"b".repeat(64)}`
    );
    assert.equal(relayFilteredBoard.status, 200);
    assert.equal(relayFilteredBoard.payload.totalVisibleMessages, 1);
    assert.equal(relayFilteredBoard.payload.messages[0].body, "Looking for collaborators on proof-backed output packaging.");

    const anchorQueue = await requestJson(`${baseUrl}/api/social/anchors?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "GET",
      headers: {
        "x-clawz-admin-key": adminKey
      }
    });
    assert.equal(anchorQueue.status, 200);
    assert.equal(anchorQueue.payload.items.some((item) => item.kind === "agent-message-posted"), true);

    const queuePath = path.join(workspaceDir, ".clawz-data", "state", "social-anchor-queue.json");
    const queueFile = JSON.parse(await readFile(queuePath, "utf8"));
    queueFile.items = queueFile.items.filter((item) => item.candidateId !== postedMessage.anchorCandidateId);
    await writeFile(queuePath, JSON.stringify(queueFile, null, 2));
    const reconciledBoard = await requestJson(
      `${baseUrl}/api/agent-messages?agentId=${encodeURIComponent(agentId)}&outputDigest=${"a".repeat(64)}`
    );
    assert.equal(reconciledBoard.status, 200);
    assert.equal(reconciledBoard.payload.messages[0].anchorStatus, "expired_not_anchored");

    console.log("ok - proof-backed agent message board supports admin and relay-authenticated posting with Zeko anchors");
  } finally {
    relaySocket?.destroy();
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testExecutionIntentLifecycleAnchors() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-execution-intent-test-"));
  const port = await reservePort();
  const server = startServer(workspaceDir, port);

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);

    const registered = await requestJson(`${baseUrl}/api/console/register`, {
      method: "POST",
      body: JSON.stringify({
        agentName: "Execution Intent Agent",
        headline: "Records proof-gated execution lifecycle facts.",
        openClawUrl: "https://execution-intent-agent.test/hire",
        payoutWallets: {
          base: "0x1908217952D7117f5aeFBbd91AeBf04566D286f9"
        },
        paymentProfile: {
          enabled: true,
          supportedRails: ["base-usdc"],
          defaultRail: "base-usdc",
          pricingMode: "fixed-exact",
          fixedAmountUsd: "2.00",
          settlementTrigger: "on-proof"
        }
      })
    });
    assert.equal(registered.status, 200);
    const sessionId = registered.payload.session.sessionId;
    const agentId = registered.payload.agentId;
    const adminKey = registered.payload.adminAccess.issuedAdminKey;
    const buyerWallet = "0xb4ad7F6B6e6B964C9D1c4bB8b7F2e38732E0b386";
    const escrowContract = "0x1111111111111111111111111111111111111111";

    const created = await requestJson(`${baseUrl}/api/execution/intents`, {
      method: "POST",
      body: JSON.stringify({
        agentId,
        rail: "base-usdc",
        settlementModel: "reserve-release-escrow",
        grossAmountUsd: "2.00",
        sellerNetAmountUsd: "1.98",
        protocolFeeAmountUsd: "0.02",
        buyerWallet,
        escrowContract,
        paymentAuthorizationDigestSha256: "a".repeat(64),
        note: "Backend-only escrow lifecycle smoke."
      })
    });
    assert.equal(created.status, 200);
    assert.equal(created.payload.status, "pending");
    assert.equal(created.payload.settlementModel, "reserve-release-escrow");
    assert.match(created.payload.stableIntentDigestSha256, /^[a-f0-9]{64}$/);
    assert.match(created.payload.latestTransitionDigestSha256, /^[a-f0-9]{64}$/);
    assert.equal(created.payload.lifecycle[0].transitionType, "created");
    assert.equal(created.payload.lifecycle[0].toStatus, "pending");
    assert.match(created.payload.lifecycle[0].anchorCandidateId, /^anchor_/);

    const approved = await requestJson(`${baseUrl}/api/execution/intents/${created.payload.intentId}/approve`, {
      method: "POST",
      body: JSON.stringify({
        reference: "x402-reserve:authorization",
        paymentAuthorizationDigestSha256: "b".repeat(64)
      })
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.payload.status, "approved");
    assert.equal(approved.payload.lifecycle.at(-1).transitionType, "approved");
    assert.equal(approved.payload.lifecycle.at(-1).fromStatus, "pending");

    const executed = await requestJson(`${baseUrl}/api/execution/intents/${created.payload.intentId}/execute`, {
      method: "POST",
      body: JSON.stringify({
        reference: "verified-output:package",
        executionDigestSha256: "c".repeat(64)
      })
    });
    assert.equal(executed.status, 200);
    assert.equal(executed.payload.status, "executed");
    assert.equal(executed.payload.executionDigestSha256, "c".repeat(64));

    const settled = await requestJson(`${baseUrl}/api/execution/intents/${created.payload.intentId}/settle`, {
      method: "POST",
      body: JSON.stringify({
        reference: "base:0xsettled",
        settlementDigestSha256: "d".repeat(64)
      })
    });
    assert.equal(settled.status, 200);
    assert.equal(settled.payload.status, "settled");
    assert.equal(settled.payload.lifecycle.at(-1).transitionType, "settled");
    assert.equal(settled.payload.anchorCandidateIds.length, 4);

    const intentLookup = await requestJson(`${baseUrl}/api/execution-intents/${encodeURIComponent(created.payload.intentId)}`);
    assert.equal(intentLookup.status, 200);
    assert.equal(intentLookup.payload.intent.intentId, created.payload.intentId);
    assert.equal(intentLookup.payload.resultStatus, "not_started");
    assert.equal(intentLookup.payload.executionLifecycle.currentPhase, "payment_settled");
    assert.equal(intentLookup.payload.executionLifecycle.paidButNotCompleted, true);
    assert.equal(intentLookup.payload.executionLifecycle.completedVerified, false);
    assert.equal(intentLookup.payload.operationalStatus.settlementStatus, "settled");

    const terminalRefund = await requestJson(`${baseUrl}/api/execution/intents/${created.payload.intentId}/refund`, {
      method: "POST",
      body: JSON.stringify({
        refundDigestSha256: "e".repeat(64)
      })
    });
    assert.equal(terminalRefund.status, 400);
    assert.match(terminalRefund.payload.error, /terminal/);

    const refundCreated = await requestJson(`${baseUrl}/api/execution/intents`, {
      method: "POST",
      body: JSON.stringify({
        agentId,
        rail: "base-usdc",
        settlementModel: "reserve-release-escrow",
        grossAmountUsd: "1.00",
        buyerWallet,
        escrowContract,
        paymentAuthorizationDigestSha256: "1".repeat(64)
      })
    });
    assert.equal(refundCreated.status, 200);
    const refundApproved = await requestJson(`${baseUrl}/api/execution/intents/${refundCreated.payload.intentId}/approve`, {
      method: "POST",
      body: JSON.stringify({
        paymentAuthorizationDigestSha256: "2".repeat(64)
      })
    });
    assert.equal(refundApproved.status, 200);
    const refunded = await requestJson(`${baseUrl}/api/execution/intents/${refundCreated.payload.intentId}/refund`, {
      method: "POST",
      body: JSON.stringify({
        reference: "base:0xrefunded",
        refundDigestSha256: "3".repeat(64)
      })
    });
    assert.equal(refunded.status, 200);
    assert.equal(refunded.payload.status, "refunded");

    const listed = await requestJson(`${baseUrl}/api/execution/intents?agentId=${encodeURIComponent(agentId)}`);
    assert.equal(listed.status, 200);
    assert.equal(listed.payload.schemaVersion, "santaclawz-execution-intents/1.0");
    assert.equal(listed.payload.totalIntentCount, 2);
    assert.equal(listed.payload.settledCount, 1);
    assert.equal(listed.payload.refundedCount, 1);

    const anchorQueue = await requestJson(`${baseUrl}/api/social/anchors?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "GET",
      headers: {
        "x-clawz-admin-key": adminKey
      }
    });
    assert.equal(anchorQueue.status, 200);
    const kinds = new Set(anchorQueue.payload.items.map((item) => item.kind));
    assert.equal(kinds.has("execution-intent-created"), true);
    assert.equal(kinds.has("execution-intent-approved"), true);
    assert.equal(kinds.has("execution-intent-executed"), true);
    assert.equal(kinds.has("execution-intent-settled"), true);
    assert.equal(kinds.has("execution-intent-refunded"), true);

    console.log("ok - execution intent lifecycle records stable hashes and queues Zeko anchors");
  } finally {
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testHireRouteRequiresSafeIngressAndPaymentState() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-hire-gating-test-"));
  const port = await reservePort();
  const ingressPort = await reservePort();
  const server = startServer(workspaceDir, port, {
    CLAWZ_X402_BASE_FACILITATOR_URL: "https://x402-zeko.example",
    CLAWZ_PROTOCOL_OWNER_FEE_ENABLED: "true",
    CLAWZ_PROTOCOL_OWNER_FEE_BPS: "10",
    CLAWZ_PROTOCOL_FEE_BASE_RECIPIENT: "0xF787fF44c5e80c8165e1B4FB156411e2d42c91B2",
    CLAWZ_FREE_TEST_AGENT_HIRE_LIMIT_PER_10M: "1"
  });
  const ingress = await startHireIngress(ingressPort);

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const ingressUrl = `http://127.0.0.1:${ingressPort}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);

    const registered = await requestJson(`${baseUrl}/api/console/register`, {
      method: "POST",
      body: JSON.stringify({
        agentName: "Hire Gating Agent",
        headline: "Receives signed SantaClawz hire requests.",
        openClawUrl: ingressUrl
      })
    });
    assert.equal(registered.status, 200);
    const sessionId = registered.payload.session.sessionId;
    const agentId = registered.payload.agentId;
    const adminKey = registered.payload.adminAccess.issuedAdminKey;
    const ingressToken = registered.payload.ingressAccess.issuedIngressToken;
    const signingSecret = registered.payload.ingressAccess.issuedSigningSecret;
    assert.equal(typeof ingressToken, "string");
    assert.equal(typeof signingSecret, "string");
    assert.notEqual(signingSecret, ingressToken);
    assert.equal(registered.payload.ingressAccess.serviceKey, "hire_gating_agent");
    ingress.setExpectedIngressToken(ingressToken);
    ingress.setExpectedSigningSecret(signingSecret);
    ingress.setExpectedServiceKey("hire_gating_agent");

    const unverifiedHire = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Should be rejected until ownership is verified.",
        requesterContact: "buyer@example.com"
      })
    });
    assert.equal(unverifiedHire.status, 400);
    assert.match(unverifiedHire.payload.error, /verify control/i);

    const challenge = await requestJson(`${baseUrl}/api/ownership/challenge`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({ sessionId, agentId })
    });
    assert.equal(challenge.status, 200);
    ingress.setChallengePayload(JSON.parse(challenge.payload.issuedOwnershipChallenge.challengeResponseJson));

    const verified = await requestJson(`${baseUrl}/api/ownership/verify`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({ sessionId, agentId })
    });
    assert.equal(verified.status, 200);

    const unpublishedHire = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Should be rejected until published.",
        requesterContact: "buyer@example.com"
      })
    });
    assert.equal(unpublishedHire.status, 400);
    assert.match(unpublishedHire.payload.error, /publish on Zeko/i);

    const published = await requestJson(`${baseUrl}/api/social/anchors/settle`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({
        sessionId,
        agentId,
        localOnly: true
      })
    });
    assert.equal(published.status, 200);

    const publishedState = await requestJson(`${baseUrl}/api/console/state?sessionId=${encodeURIComponent(sessionId)}`);
    assert.equal(publishedState.status, 200);
    assert.equal(publishedState.payload.published, true);
    assert.equal(publishedState.payload.profile.openClawUrl, "");
    assert.equal(publishedState.payload.profile.runtimeDelivery.runtimeIngressUrl, undefined);

    const publishedRegistry = await requestJson(`${baseUrl}/api/agents`);
    assert.equal(publishedRegistry.status, 200);
    const publishedAgent = publishedRegistry.payload.find((agent) => agent.agentId === agentId);
    assert.equal(publishedAgent?.published, true);
    assert.equal(publishedAgent?.openClawUrl, "");
    assert.equal(publishedAgent?.publicAgentUrl, `https://santaclawz.ai/agent/${encodeURIComponent(agentId)}`);
    assert.equal(publishedAgent?.publicHireUrl, `https://santaclawz.ai/agent/${encodeURIComponent(agentId)}/hire`);

    const directorySearch = await requestJson(
      `${baseUrl}/api/agents/search?q=${encodeURIComponent(agentId)}&deliveryMode=buyer_encrypted&privacyMode=private&limit=5`
    );
    assert.equal(directorySearch.status, 200);
    assert.equal(directorySearch.payload.schemaVersion, "santaclawz-agent-directory-search/1.0");
    const directoryAgent = directorySearch.payload.agents.find((agent) => agent.agentId === agentId);
    assert.equal(directoryAgent.agentId, agentId);
    assert.equal(directoryAgent.deliveryLanes.some((lane) => lane.mode === "buyer_encrypted"), true);
    assert.equal(directoryAgent.privacyModes.some((mode) => mode.mode === "private"), true);
    assert.equal(directoryAgent.capabilityTags.includes("procurement_bid"), true);
    assert.equal(typeof directoryAgent.reputation.jobActivityStats.totalJobCount, "number");

    const agentReady = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/ready`);
    assert.equal(agentReady.status, 200);
    assert.equal(agentReady.payload.schemaVersion, "santaclawz-agent-readiness/1.0");
    assert.equal(agentReady.payload.agentId, agentId);
    assert.equal(agentReady.payload.deliveryLanes.some((lane) => lane.mode === "platform_scanned"), true);
    assert.equal(agentReady.payload.privacyModes.some((mode) => mode.mode === "buyer_encrypted"), true);
    assert.equal(typeof agentReady.payload.scannerReady, "boolean");
    assert.equal(Array.isArray(agentReady.payload.knownBlockers), true);
    assert.equal(Array.isArray(agentReady.payload.pricingReadiness), true);
    assert.equal(Array.isArray(agentReady.payload.pricing.costEstimate.rails), true);

    const scannerReadiness = await requestJson(`${baseUrl}/api/artifacts/scanner-readiness`);
    assert.equal(scannerReadiness.status, agentReady.payload.scannerReady ? 200 : 503);
    assert.equal(scannerReadiness.payload.schemaVersion, "santaclawz-artifact-scanner-readiness/1.0");
    assert.equal(scannerReadiness.payload.scannerReady, agentReady.payload.scannerReady);
    assert.equal(typeof scannerReadiness.payload.scanner, "string");
    assert.equal(typeof scannerReadiness.payload.retryable, "boolean");

    const procurementIntent = await requestJson(`${baseUrl}/api/procurement/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskPrompt: "Find an agent to answer privately with a verified artifact.",
        requesterContact: "buyer-agent:test",
        budgetUsd: "0.50",
        requiredCapabilities: ["magic-answer"],
        preferredDeliveryModes: ["platform_scanned", "buyer_encrypted"],
        preferredPrivacyModes: ["private"],
        jobPrivacy: {
          visibility: "private",
          publicLifecycleEvents: false,
          publicArtifactMetadata: false
        },
        artifactDelivery: {
          mode: "platform_scanned",
          scanPolicy: "platform_required",
          digestRequired: true
        }
      })
    });
    assert.equal(procurementIntent.status, 200);
    assert.match(procurementIntent.payload.intent.intentId, /^proc_/);
    assert.match(procurementIntent.payload.buyerToken, /^[A-Za-z0-9_-]+$/);
    assert.equal(procurementIntent.payload.intent.buyerTokenHashSha256, undefined);
    assert.equal(procurementIntent.payload.intent.createIdempotencyKeyHashSha256, undefined);
    assert.equal(procurementIntent.payload.intent.status, "open");

    const idempotentProcurementIntent = await requestJson(`${baseUrl}/api/procurement/intents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "server-api-procurement-idempotency"
      },
      body: JSON.stringify({
        taskPrompt: "Find an agent idempotently.",
        requesterContact: "buyer-agent:test",
        budgetUsd: "0.50"
      })
    });
    const idempotentProcurementIntentRetry = await requestJson(`${baseUrl}/api/procurement/intents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "server-api-procurement-idempotency"
      },
      body: JSON.stringify({
        taskPrompt: "Find an agent idempotently.",
        requesterContact: "buyer-agent:test",
        budgetUsd: "0.50"
      })
    });
    assert.equal(idempotentProcurementIntent.status, 200);
    assert.equal(idempotentProcurementIntentRetry.status, 200);
    assert.equal(idempotentProcurementIntentRetry.payload.idempotent, true);
    assert.equal(idempotentProcurementIntentRetry.payload.intent.intentId, idempotentProcurementIntent.payload.intent.intentId);
    assert.equal(idempotentProcurementIntentRetry.payload.buyerToken, idempotentProcurementIntent.payload.buyerToken);

    const procurementBid = await requestJson(`${baseUrl}/api/procurement/intents/${encodeURIComponent(procurementIntent.payload.intent.intentId)}/bids`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawz-admin-key": adminKey,
        "idempotency-key": "server-api-procurement-bid-idempotency"
      },
      body: JSON.stringify({
        agentId,
        amountUsd: "0.45",
        summary: "I can complete the private verified answer.",
        deliveryModes: ["platform_scanned"],
        privacyModes: ["private"]
      })
    });
    assert.equal(procurementBid.status, 200);
    assert.equal(procurementBid.payload.bid.agentId, agentId);
    assert.equal(procurementBid.payload.bid.idempotencyKeyHashSha256, undefined);
    assert.equal(procurementBid.payload.intent.bids, undefined);
    assert.equal(procurementBid.payload.intent.bidCount, 1);
    const procurementBidRetry = await requestJson(`${baseUrl}/api/procurement/intents/${encodeURIComponent(procurementIntent.payload.intent.intentId)}/bids`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawz-admin-key": adminKey,
        "idempotency-key": "server-api-procurement-bid-idempotency"
      },
      body: JSON.stringify({
        agentId,
        amountUsd: "0.45",
        summary: "I can complete the private verified answer.",
        deliveryModes: ["platform_scanned"],
        privacyModes: ["private"]
      })
    });
    assert.equal(procurementBidRetry.status, 200);
    assert.equal(procurementBidRetry.payload.idempotent, true);
    assert.equal(procurementBidRetry.payload.bid.bidId, procurementBid.payload.bid.bidId);
    assert.equal(procurementBidRetry.payload.bid.idempotencyKeyHashSha256, undefined);

    const procurementDecline = await requestJson(`${baseUrl}/api/procurement/intents/${encodeURIComponent(idempotentProcurementIntent.payload.intent.intentId)}/decline`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawz-admin-key": adminKey,
        "idempotency-key": "server-api-procurement-decline-idempotency"
      },
      body: JSON.stringify({
        agentId,
        reason: "Not a fit for this smoke intent."
      })
    });
    const procurementDeclineRetry = await requestJson(`${baseUrl}/api/procurement/intents/${encodeURIComponent(idempotentProcurementIntent.payload.intent.intentId)}/decline`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawz-admin-key": adminKey,
        "idempotency-key": "server-api-procurement-decline-idempotency"
      },
      body: JSON.stringify({
        agentId,
        reason: "Not a fit for this smoke intent."
      })
    });
    assert.equal(procurementDecline.status, 200);
    assert.equal(procurementDecline.payload.decline.idempotencyKeyHashSha256, undefined);
    assert.equal(procurementDeclineRetry.status, 200);
    assert.equal(procurementDeclineRetry.payload.idempotent, true);
    assert.equal(procurementDeclineRetry.payload.decline.createdAtIso, procurementDecline.payload.decline.createdAtIso);
    assert.equal(procurementDeclineRetry.payload.decline.idempotencyKeyHashSha256, undefined);

    const procurementList = await requestJson(`${baseUrl}/api/procurement/intents?status=open`);
    assert.equal(procurementList.status, 200);
    assert.equal(procurementList.payload.intents.some((intent) => intent.intentId === procurementIntent.payload.intent.intentId), true);
    const listedPrivateIntent = procurementList.payload.intents.find((intent) => intent.intentId === procurementIntent.payload.intent.intentId);
    assert.ok(listedPrivateIntent);
    assert.equal(listedPrivateIntent.taskPrompt, undefined);
    assert.equal(listedPrivateIntent.requesterContact, undefined);
    assert.equal(listedPrivateIntent.artifactDelivery?.buyerPublicKey, undefined);
    assert.equal(listedPrivateIntent.privacy.visibility, "private");
    assert.equal(listedPrivateIntent.publicSummary, "A private procurement intent is open on SantaClawz.");
    assert.equal(listedPrivateIntent.bidCount, 1);

    const publicProcurementDetail = await requestJson(
      `${baseUrl}/api/procurement/intents/${encodeURIComponent(procurementIntent.payload.intent.intentId)}`
    );
    assert.equal(publicProcurementDetail.status, 200);
    assert.equal(publicProcurementDetail.payload.intent.taskPrompt, undefined);
    assert.equal(publicProcurementDetail.payload.intent.requesterContact, undefined);
    assert.equal(publicProcurementDetail.payload.intent.artifactDelivery?.buyerPublicKey, undefined);
    assert.equal(publicProcurementDetail.payload.intent.bids, undefined);
    assert.equal(publicProcurementDetail.payload.intent.bidCount, 1);

    const buyerProcurementDetail = await requestJson(
      `${baseUrl}/api/procurement/intents/${encodeURIComponent(procurementIntent.payload.intent.intentId)}?token=${encodeURIComponent(procurementIntent.payload.buyerToken)}`
    );
    assert.equal(buyerProcurementDetail.status, 200);
    assert.equal(buyerProcurementDetail.payload.intent.taskPrompt, "Find an agent to answer privately with a verified artifact.");
    assert.equal(buyerProcurementDetail.payload.intent.requesterContact, "buyer-agent:test");
    assert.equal(Array.isArray(buyerProcurementDetail.payload.intent.bids), true);

    const rejectedProcurementAccept = await requestJson(`${baseUrl}/api/procurement/intents/${encodeURIComponent(procurementIntent.payload.intent.intentId)}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bidId: procurementBid.payload.bid.bidId,
        token: "bad-token"
      })
    });
    assert.equal(rejectedProcurementAccept.status, 400);

    const procurementAccept = await requestJson(`${baseUrl}/api/procurement/intents/${encodeURIComponent(procurementIntent.payload.intent.intentId)}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bidId: procurementBid.payload.bid.bidId,
        token: procurementIntent.payload.buyerToken
      })
    });
    assert.equal(procurementAccept.status, 200);
    assert.equal(procurementAccept.payload.intent.status, "awarded");
    assert.equal(procurementAccept.payload.intent.selectedAgentId, agentId);
    assert.equal(procurementAccept.payload.selectedBid.status, "accepted");
    assert.equal(procurementAccept.payload.nextAction.type, "submit_hire_request");
    assert.equal(procurementAccept.payload.nextAction.hireApiPath, `/api/agents/${encodeURIComponent(agentId)}/hire`);
    assert.equal(procurementAccept.payload.nextAction.body.jobPrivacy.visibility, "private");

    const procurementAcceptRetry = await requestJson(`${baseUrl}/api/procurement/intents/${encodeURIComponent(procurementIntent.payload.intent.intentId)}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bidId: procurementBid.payload.bid.bidId,
        token: procurementIntent.payload.buyerToken
      })
    });
    assert.equal(procurementAcceptRetry.status, 200);
    assert.equal(procurementAcceptRetry.payload.idempotent, true);
    assert.equal(procurementAcceptRetry.payload.selectedBid.status, "accepted");
    assert.equal(procurementAcceptRetry.payload.nextAction.hireApiPath, procurementAccept.payload.nextAction.hireApiPath);

    const awardedPublicProcurementDetail = await requestJson(
      `${baseUrl}/api/procurement/intents/${encodeURIComponent(procurementIntent.payload.intent.intentId)}`
    );
    assert.equal(awardedPublicProcurementDetail.status, 200);
    assert.equal(awardedPublicProcurementDetail.payload.intent.status, "awarded");
    assert.equal(awardedPublicProcurementDetail.payload.intent.taskPrompt, undefined);
    assert.equal(awardedPublicProcurementDetail.payload.intent.requesterContact, undefined);
    assert.equal(awardedPublicProcurementDetail.payload.intent.award, undefined);
    assert.equal(awardedPublicProcurementDetail.payload.intent.artifactDelivery?.buyerPublicKey, undefined);

    const readinessRefresh = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/readiness/refresh`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({
        sessionId,
        publish: true,
        localOnly: true
      })
    });
    assert.equal(readinessRefresh.status, 200);
    assert.equal(readinessRefresh.payload.published, true);
    assert.equal(readinessRefresh.payload.publish.alreadyPublished, true);
    assert.equal(Array.isArray(readinessRefresh.payload.blockers), true);

    const relayStatus = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/relay-status`);
    assert.equal(relayStatus.status, 200);
    assert.equal(relayStatus.payload.connected, false);

    const oversizedHire = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "x".repeat(2001),
        requesterContact: "buyer@example.com"
      })
    });
    assert.equal(oversizedHire.status, 400);
    assert.match(oversizedHire.payload.error, /taskPrompt/);

    const archived = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/archive`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({ sessionId, archived: true })
    });
    assert.equal(archived.status, 200);

    const archivedHire = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Should be rejected while archived.",
        requesterContact: "buyer@example.com"
      })
    });
    assert.equal(archivedHire.status, 400);
    assert.match(archivedHire.payload.error, /archived/i);

    const restored = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/archive`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({ sessionId, archived: false })
    });
    assert.equal(restored.status, 200);

    const paymentEnabledButNotReady = await requestJson(`${baseUrl}/api/console/profile?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({
        payoutWallets: {
          ethereum: "0x1908217952D7117f5aeFBbd91AeBf04566D286f9"
        },
        paymentProfile: {
          enabled: true,
          supportedRails: ["ethereum-usdc"],
          defaultRail: "ethereum-usdc",
          pricingMode: "fixed-exact",
          fixedAmountUsd: "0.20",
          settlementTrigger: "upfront"
        }
      })
    });
    assert.equal(paymentEnabledButNotReady.status, 200);

    const notReadyHire = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Should be rejected because payment setup is incomplete.",
        requesterContact: "buyer@example.com"
      })
    });
    assert.equal(notReadyHire.status, 402);
    assert.equal(notReadyHire.payload.paymentRequested, false);

    const paidReady = await requestJson(`${baseUrl}/api/console/profile?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({
        agentName: "Renamed Hire Gating Agent",
        payoutWallets: {
          base: "0x1908217952D7117f5aeFBbd91AeBf04566D286f9"
        },
        paymentProfile: {
          enabled: true,
          supportedRails: ["base-usdc"],
          defaultRail: "base-usdc",
          pricingMode: "fixed-exact",
          fixedAmountUsd: "0.20",
          settlementTrigger: "upfront"
        }
      })
    });
    assert.equal(paidReady.status, 200);
    assert.equal(paidReady.payload.paidJobsEnabled, true);
    assert.equal(paidReady.payload.readiness.paymentReady, true);
    assert.equal(typeof paidReady.payload.readiness.hireable, "boolean");

    const paidAgentHeartbeat = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/heartbeat`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({
        sessionId,
        status: "live",
        ttlSeconds: 60
      })
    });
    assert.equal(paidAgentHeartbeat.status, 200);

    const unpaidPaidHire = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Should require x402 payment.",
        requesterContact: "buyer@example.com"
      })
    });
    assert.equal(unpaidPaidHire.status, 402);
    assert.equal(typeof unpaidPaidHire.payload, "object");
    const fixedPriceAccept = firstX402Accept(unpaidPaidHire.payload);
    assert.ok(fixedPriceAccept, JSON.stringify(unpaidPaidHire.payload));
    assert.equal(fixedPriceAccept.amount, "200000");
    assert.notEqual(fixedPriceAccept.amount, "0.20");

    const quoteReady = await requestJson(`${baseUrl}/api/console/profile?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({
        payoutWallets: {
          base: "0x1908217952D7117f5aeFBbd91AeBf04566D286f9"
        },
        paymentProfile: {
          enabled: true,
          supportedRails: ["base-usdc"],
          defaultRail: "base-usdc",
          pricingMode: "quote-required",
          settlementTrigger: "upfront"
        }
      })
    });
    assert.equal(quoteReady.status, 200);
    assert.equal(quoteReady.payload.profile.agentName, "Renamed Hire Gating Agent");
    assert.equal(quoteReady.payload.ingressAccess.serviceKey, "hire_gating_agent");
    assert.equal(quoteReady.payload.paymentProfileReady, true);
    assert.equal(quoteReady.payload.paidJobsEnabled, false);
    assert.equal(quoteReady.payload.readiness.paymentReady, true);
    assert.equal(Array.isArray(quoteReady.payload.readiness.blockers), true);
    const quotePlan = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/x402-plan`);
    assert.equal(quotePlan.status, 200);
    assert.equal(quotePlan.payload.published, true);
    assert.equal(quotePlan.payload.readiness.published, true);

    const accepted = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Quote this signed hire request.",
        requesterContact: "buyer@example.com"
      })
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.payload.requestType, "quote_intake");
    assert.equal(accepted.payload.pricingMode, "quote-required");
    assert.equal(accepted.payload.paymentStatus, "quote_requested");
    assert.equal(accepted.payload.status, "submitted");
    assert.equal(accepted.payload.deliveryStatus, "forwarded");
    assert.deepEqual(accepted.payload.operationalStatus, {
      paymentStatus: "quote_requested",
      settlementStatus: "not_attempted",
      relayDeliveryStatus: "forwarded",
      agentExecutionStatus: "submitted"
    });
    assert.equal(accepted.payload.ingress.signatureHeader, "X-SantaClawz-Signature");
    assert.equal(accepted.payload.deliveryTarget, `https://santaclawz.ai/agent/${encodeURIComponent(agentId)}/hire`);
    assert.equal(accepted.payload.ingress.url, `https://santaclawz.ai/agent/${encodeURIComponent(agentId)}/hire`);
    assert.notEqual(accepted.payload.ingress.url, ingressUrl);
    assert.equal(ingress.receivedHireRequestIds.has(accepted.payload.requestId), true);

    const acceptedFromHostedUrl = await requestJson(`${baseUrl}/agent/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Quote this from the hosted SantaClawz hire URL.",
        requesterContact: "buyer@example.com"
      })
    });
    assert.equal(acceptedFromHostedUrl.status, 200);
    assert.equal(acceptedFromHostedUrl.payload.requestType, "quote_intake");
    assert.equal(acceptedFromHostedUrl.payload.deliveryStatus, "forwarded");
    assert.equal(acceptedFromHostedUrl.payload.deliveryTarget, `https://santaclawz.ai/agent/${encodeURIComponent(agentId)}/hire`);
    assert.equal(ingress.receivedHireRequestIds.has(acceptedFromHostedUrl.payload.requestId), true);

    ingress.setNextProtocolReturnFactory(({ requestId }) => ({
      schema_version: "santaclawz-return/1.0",
      request_id: requestId,
      status: "quoted",
      agent_private: true,
      quote: {
        amount_usd: "0.42",
        currency: "USDC",
        expires_at_iso: "2026-06-06T23:59:59.000Z",
        summary: "The agent can complete this after a paid exact quote."
      }
    }));
    const quoted = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Return a protocol quote package.",
        requesterContact: "buyer@example.com"
      })
    });
    assert.equal(quoted.status, 200);
    assert.equal(quoted.payload.requestType, "quote_intake");
    assert.equal(quoted.payload.paymentStatus, "quote_requested");
    assert.equal(quoted.payload.status, "quoted");
    assert.equal(quoted.payload.protocolReturn.status, "quoted");
    assert.equal(quoted.payload.protocolReturn.quote.amountUsd, "0.42");
    assert.equal(typeof quoted.payload.protocolReturn.digestSha256, "string");
    assert.equal(quoted.payload.ingress.responseStatusCode, 200);

    const wrongQuotePaymentEndpoint = await requestJson(
      `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire?intentId=exec_wrongendpoint`,
      {
        method: "POST",
        body: JSON.stringify({
          taskPrompt: "Do not create another quote when payment is being attempted.",
          requesterContact: "buyer@example.com",
          paymentPayload: {
            protocol: "x402",
            paymentId: "pay_wrong_endpoint"
          }
        })
      }
    );
    assert.equal(wrongQuotePaymentEndpoint.status, 400);
    assert.equal(wrongQuotePaymentEndpoint.payload.code, "quote_payment_requires_quote_intent_endpoint");
    assert.equal(wrongQuotePaymentEndpoint.payload.nextAction, "pay_accepted_quote_intent");
    assert.match(wrongQuotePaymentEndpoint.payload.quoteIntentEndpoint, /\/api\/x402\/quote-intent\?intentId=exec_wrongendpoint/);

    const invalidBuyerProof = await requestJson(
      `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/quotes/${encodeURIComponent(quoted.payload.requestId)}/accept`,
      {
        method: "POST",
        body: JSON.stringify({
          buyerAgentId: "buyer_policy_agent",
          buyerWallet: "0xb4ad7F6B6e6B964C9D1c4bB8b7F2e38732E0b386",
          buyerWalletProof: {
            scheme: "eip191-personal-sign",
            message: "wrong quote acceptance message",
            signature: `0x${"0".repeat(130)}`
          },
          acceptedAmountUsd: "0.42",
          acceptedQuoteDigestSha256: quoted.payload.protocolReturn.digestSha256,
          maxAmountUsd: "1.00",
          rail: "base-usdc",
          settlementModel: "upfront-x402"
        })
      }
    );
    assert.equal(invalidBuyerProof.status, 400);
    assert.match(invalidBuyerProof.payload.error, /buyerWalletProof\.message does not match/);

    const acceptedQuote = await requestJson(
      `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/quotes/${encodeURIComponent(quoted.payload.requestId)}/accept`,
      {
        method: "POST",
        body: JSON.stringify({
          buyerAgentId: "buyer_policy_agent",
          buyerWallet: "0xb4ad7F6B6e6B964C9D1c4bB8b7F2e38732E0b386",
          acceptedAmountUsd: "0.42",
          acceptedQuoteDigestSha256: quoted.payload.protocolReturn.digestSha256,
          maxAmountUsd: "1.00",
          rail: "base-usdc",
          settlementModel: "upfront-x402"
        })
      }
    );
    assert.equal(acceptedQuote.payload.intent.requestId, quoted.payload.requestId);
    assert.equal(acceptedQuote.payload.intent.grossAmountUsd, "0.42");
    assert.equal(acceptedQuote.payload.intent.pricingMode, "quote-required");
    assert.match(acceptedQuote.payload.intent.stableIntentDigestSha256, /^[a-f0-9]{64}$/);
    if (acceptedQuote.status === 402) {
      assert.equal(acceptedQuote.payload.ok, true);
      assert.equal(acceptedQuote.payload.intent.status, "pending");
      assert.equal(acceptedQuote.payload.paymentRequirement.protocol, "x402");
      const acceptedQuoteAccept = firstX402Accept(acceptedQuote.payload.paymentRequirement);
      assert.equal(acceptedQuoteAccept.amount, "420000");
      assert.notEqual(acceptedQuoteAccept.amount, "0.42");

      const quoteIntentPaymentRequired = await requestJson(
        `${baseUrl}/api/x402/quote-intent?intentId=${encodeURIComponent(acceptedQuote.payload.intent.intentId)}`,
        {
          method: "POST",
          body: JSON.stringify({})
        }
      );
      assert.equal(quoteIntentPaymentRequired.status, 402);
      assert.equal(quoteIntentPaymentRequired.payload.protocol, "x402");
      const quoteIntentAccept = firstX402Accept(quoteIntentPaymentRequired.payload);
      assert.equal(quoteIntentAccept.amount, "420000");
      assert.notEqual(quoteIntentAccept.amount, "0.42");

      const quotePaymentState = await requestJson(
        `${baseUrl}/api/x402/payment-state?intentId=${encodeURIComponent(acceptedQuote.payload.intent.intentId)}`
      );
      assert.equal(quotePaymentState.status, 200);
      assert.equal(quotePaymentState.payload.schemaVersion, "santaclawz-x402-payment-state/1.0");
      assert.equal(quotePaymentState.payload.lookup.intentId, acceptedQuote.payload.intent.intentId);
      assert.match(quotePaymentState.payload.retryResume.retryEndpoint, /\/api\/x402\/quote-intent\?intentId=exec_/);
      assert.equal(quotePaymentState.payload.retryResume.terminal, false);
    } else {
      assert.equal(acceptedQuote.status, 400);
      assert.match(acceptedQuote.payload.error, /cannot emit a live x402 challenge/);
      assert.equal(acceptedQuote.payload.intent.status, "refunded");
    }

    const duplicateAcceptedQuote = await requestJson(
      `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/quotes/${encodeURIComponent(quoted.payload.requestId)}/accept`,
      {
        method: "POST",
        body: JSON.stringify({
          acceptedAmountUsd: "0.42",
          acceptedQuoteDigestSha256: quoted.payload.protocolReturn.digestSha256,
          maxAmountUsd: "1.00",
          rail: "base-usdc"
        })
      }
    );
    if (acceptedQuote.status === 402) {
      assert.equal(duplicateAcceptedQuote.status, 400);
      assert.match(duplicateAcceptedQuote.payload.error, /already has an active execution intent/);
    } else {
      assert.equal([400, 402].includes(duplicateAcceptedQuote.status), true);
    }

    let rateLimitedQuoteAccept;
    for (let index = 0; index < 25; index += 1) {
      rateLimitedQuoteAccept = await requestJson(`${baseUrl}/api/agents/rate-limit-agent/quotes/rate-limit-request/accept`, {
        method: "POST",
        body: JSON.stringify({
          buyerAgentId: "rate_limit_buyer",
          buyerWallet: "0xb4ad7F6B6e6B964C9D1c4bB8b7F2e38732E0b386",
          acceptedAmountUsd: "0.42",
          acceptedQuoteDigestSha256: quoted.payload.protocolReturn.digestSha256,
          maxAmountUsd: "1.00",
          rail: "base-usdc"
        })
      });
    }
    assert.equal(rateLimitedQuoteAccept.status, 429);
    assert.match(rateLimitedQuoteAccept.payload.error, /Too many quote acceptance attempts/);

    ingress.setNextProtocolReturnFactory(({ requestId }) => ({
      schema_version: "santaclawz-return/1.0",
      request_id: requestId,
      status: "completed",
      agent_private: true,
      verified_output: {
        package_hash: "a".repeat(64),
        hash_algorithm: "sha256",
        deliverables: []
      }
    }));
    const invalidQuoteCompletion = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Do not allow quote intake to masquerade as completed paid work.",
        requesterContact: "buyer@example.com"
      })
    });
    assert.equal(invalidQuoteCompletion.status, 400);
    assert.match(invalidQuoteCompletion.payload.error, /Quote intake cannot return completed paid execution/);

    const freeTestReady = await requestJson(`${baseUrl}/api/console/profile?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({
        paymentProfile: {
          enabled: true,
          supportedRails: ["base-usdc"],
          defaultRail: "base-usdc",
          pricingMode: "free-test",
          settlementTrigger: "upfront"
        }
      })
    });
    assert.equal(freeTestReady.status, 200);
    assert.equal(freeTestReady.payload.profile.paymentProfile.enabled, false);
    assert.equal(freeTestReady.payload.profile.paymentProfile.pricingMode, "free-test");
    assert.equal(freeTestReady.payload.paymentProfileReady, true);
    assert.equal(freeTestReady.payload.paidJobsEnabled, false);

    ingress.setNextProtocolReturnFactory(({ requestId }) => ({
      schema_version: "santaclawz-return/1.0",
      request_id: requestId,
      status: "completed",
      agent_private: true,
      execution_mode: "demo-complete",
      real_work_executed: false,
      buyer_visible: false,
      marketplace_completion_credit: false,
      verified_output: {
        package_hash: "b".repeat(64),
        hash_algorithm: "sha256",
        verification_manifest: {
          mode: "demo",
          input_digest_sha256: "c".repeat(64),
          checks_performed: ["santaclawz_signature_verified"],
          files_produced: [],
          blocked_suspicious_instructions: []
        },
        deliverables: []
      }
    }));

    const handoffIntent = await requestJson(`${baseUrl}/api/procurement/intents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "server-api-procurement-handoff-intent"
      },
      body: JSON.stringify({
        taskPrompt: "Procure a private free-test handoff into the normal execution workspace.",
        requesterContact: "buyer-agent:handoff",
        budgetUsd: "0.25",
        requiredCapabilities: ["magic-answer"],
        preferredDeliveryModes: ["buyer_encrypted"],
        preferredPrivacyModes: ["private"],
        jobPrivacy: {
          visibility: "private",
          publicAggregateStats: true,
          publicLifecycleEvents: false,
          publicArtifactMetadata: false,
          note: "buyer requested confidential test"
        },
        artifactDelivery: {
          mode: "buyer_encrypted",
          encryptionScheme: "age",
          buyerPublicKey: "age1santaclawztestbuyerpublickey0000000000000000000000000000000000000000",
          acceptedFormats: ["sczenc", "age"],
          localScanRequired: true
        }
      })
    });
    assert.equal(handoffIntent.status, 200);

    const publicHandoffIntent = await requestJson(
      `${baseUrl}/api/procurement/intents/${encodeURIComponent(handoffIntent.payload.intent.intentId)}`
    );
    assert.equal(publicHandoffIntent.status, 200);
    assert.equal(publicHandoffIntent.payload.intent.taskPrompt, undefined);
    assert.equal(publicHandoffIntent.payload.intent.requesterContact, undefined);
    assert.equal(publicHandoffIntent.payload.intent.artifactDelivery?.buyerPublicKey, undefined);
    assert.equal(publicHandoffIntent.payload.intent.artifactDelivery?.mode, "buyer_encrypted");
    assert.equal(publicHandoffIntent.payload.intent.artifactDelivery?.localScanRequired, true);

    const buyerHandoffIntent = await requestJson(
      `${baseUrl}/api/procurement/intents/${encodeURIComponent(handoffIntent.payload.intent.intentId)}?token=${encodeURIComponent(handoffIntent.payload.buyerToken)}`
    );
    assert.equal(buyerHandoffIntent.status, 200);
    assert.equal(buyerHandoffIntent.payload.intent.taskPrompt, "Procure a private free-test handoff into the normal execution workspace.");
    assert.equal(
      buyerHandoffIntent.payload.intent.artifactDelivery.buyerPublicKey,
      "age1santaclawztestbuyerpublickey0000000000000000000000000000000000000000"
    );

    const handoffBid = await requestJson(`${baseUrl}/api/procurement/intents/${encodeURIComponent(handoffIntent.payload.intent.intentId)}/bids`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawz-admin-key": adminKey,
        "idempotency-key": "server-api-procurement-handoff-bid"
      },
      body: JSON.stringify({
        agentId,
        amountUsd: "0.25",
        summary: "I can complete this as a private buyer-encrypted free-test handoff.",
        deliveryModes: ["buyer_encrypted"],
        privacyModes: ["private"]
      })
    });
    assert.equal(handoffBid.status, 200);

    const handoffAccept = await requestJson(`${baseUrl}/api/procurement/intents/${encodeURIComponent(handoffIntent.payload.intent.intentId)}/accept`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "server-api-procurement-handoff-accept"
      },
      body: JSON.stringify({
        bidId: handoffBid.payload.bid.bidId,
        token: handoffIntent.payload.buyerToken
      })
    });
    assert.equal(handoffAccept.status, 200);
    assert.equal(handoffAccept.payload.nextAction.type, "submit_hire_request");
    assert.equal(handoffAccept.payload.nextAction.body.jobPrivacy.visibility, "private");
    assert.equal(handoffAccept.payload.nextAction.body.artifactDelivery.mode, "buyer_encrypted");

    const handoffHire = await requestJson(`${baseUrl}${handoffAccept.payload.nextAction.hireApiPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(handoffAccept.payload.nextAction.body)
    });
    assert.equal(handoffHire.status, 200);
    assert.equal(handoffHire.payload.requestType, "free_test");
    assert.equal(handoffHire.payload.status, "completed");
    assert.equal(handoffHire.payload.jobPrivacy.visibility, "private");
    assert.equal(handoffHire.payload.artifactDelivery.mode, "buyer_encrypted");
    assert.match(handoffHire.payload.jobWorkspace.token, /^[A-Za-z0-9_-]+$/);

    const handoffState = await requestJson(
      `${baseUrl}/api/executions/${encodeURIComponent(handoffHire.payload.requestId)}/state?token=${encodeURIComponent(handoffHire.payload.jobWorkspace.token)}`,
      { method: "GET" }
    );
    assert.equal(handoffState.status, 200);
    assert.equal(handoffState.payload.requestId, handoffHire.payload.requestId);
    assert.equal(handoffState.payload.currentPhase, "return_verified");
    assert.equal(handoffState.payload.lifecycleChecks.agentCompleted, true);
    assert.equal(handoffState.payload.lifecycleChecks.proofVerified, true);
    assert.equal(handoffState.payload.lifecycleChecks.artifactDelivered, false);
    assert.equal(handoffState.payload.privacy.jobVisibility, "private");

    const freeTestAccepted = handoffHire;
    assert.equal(freeTestAccepted.status, 200);
    assert.equal(freeTestAccepted.payload.requestType, "free_test");
    assert.equal(freeTestAccepted.payload.pricingMode, "free-test");
    assert.equal(freeTestAccepted.payload.paymentStatus, "free_test");
    assert.equal(freeTestAccepted.payload.status, "completed");
    assert.deepEqual(freeTestAccepted.payload.operationalStatus, {
      paymentStatus: "free_test",
      settlementStatus: "not_required",
      relayDeliveryStatus: "forwarded",
      agentExecutionStatus: "completed"
    });
    assert.equal(freeTestAccepted.payload.payment.status, "free_test");
    assert.equal(freeTestAccepted.payload.payment.rail, undefined);
    assert.deepEqual(freeTestAccepted.payload.jobPrivacy, {
      visibility: "private",
      publicAggregateStats: true,
      publicLifecycleEvents: false,
      publicArtifactMetadata: false,
      note: "buyer requested confidential test"
    });
    assert.equal(freeTestAccepted.payload.protocolReturn.status, "completed");
    assert.equal(freeTestAccepted.payload.protocolReturn.verifiedOutput.deliverableCount, 0);
    assert.equal(freeTestAccepted.payload.protocolReturn.execution.executionMode, "demo-complete");
    assert.equal(freeTestAccepted.payload.protocolReturn.execution.completionClassification, "demo_completion");
    assert.equal(freeTestAccepted.payload.protocolReturn.execution.marketplaceCompletionCredit, false);
    assert.equal(ingress.receivedHireRequestIds.has(freeTestAccepted.payload.requestId), true);
    assert.match(freeTestAccepted.payload.jobWorkspace.token, /^[A-Za-z0-9_-]+$/);
    assert.match(freeTestAccepted.payload.jobWorkspace.messagesPath, /\/api\/executions\/hire_[a-f0-9]+\/messages\?token=/);
    assert.match(freeTestAccepted.payload.jobWorkspace.stagesPath, /\/api\/executions\/hire_[a-f0-9]+\/stages\?token=/);
    assert.deepEqual(freeTestAccepted.payload.artifactDelivery, {
      mode: "buyer_encrypted",
      encryptionScheme: "age",
      buyerPublicKey: "age1santaclawztestbuyerpublickey0000000000000000000000000000000000000000",
      acceptedFormats: ["sczenc", "age"],
      localScanRequired: true,
      digestRequired: true,
      buyerAcceptanceRequired: true
    });
    assert.deepEqual(ingress.receivedHireRequests.get(freeTestAccepted.payload.requestId).input.artifact_delivery, {
      mode: "buyer_encrypted",
      encryption_scheme: "age",
      buyer_public_key: "age1santaclawztestbuyerpublickey0000000000000000000000000000000000000000",
      accepted_formats: ["sczenc", "age"],
      local_scan_required: true,
      digest_required: true,
      buyer_acceptance_required: true
    });
    assert.deepEqual(ingress.receivedHireRequests.get(freeTestAccepted.payload.requestId).input.activity_privacy, {
      visibility: "private",
      public_aggregate_stats: true,
      public_lifecycle_events: false,
      public_artifact_metadata: false,
      note: "buyer requested confidential test"
    });
    const registryAfterPrivateJob = await requestJson(`${baseUrl}/api/agents`);
    assert.equal(registryAfterPrivateJob.status, 200);
    const registryPrivateJobAgent = registryAfterPrivateJob.payload.find((agent) => agent.agentId === agentId);
    assert.equal(registryPrivateJobAgent.jobActivityStats.privateJobCount >= 1, true);

    const sellerStage = await requestJson(`${baseUrl}${freeTestAccepted.payload.jobWorkspace.stagesPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawz-admin-key": adminKey
      },
      body: JSON.stringify({
        authorRole: "seller",
        stage: "in_progress",
        status: "active",
        label: "Seller started work",
        note: "Runtime accepted the job."
      })
    });
    assert.equal(sellerStage.status, 200);
    assert.equal(sellerStage.payload.collaboration.currentStage.stage, "in_progress");
    assert.equal(sellerStage.payload.collaboration.currentStage.authorRole, "seller");

    const sellerDeliveryStage = await requestJson(`${baseUrl}${freeTestAccepted.payload.jobWorkspace.stagesPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawz-admin-key": adminKey
      },
      body: JSON.stringify({
        authorRole: "seller",
        stage: "delivery/completed",
        status: "active",
        label: "Seller completed delivery",
        note: "Runtime staged the artifact for buyer review."
      })
    });
    assert.equal(sellerDeliveryStage.status, 200);
    assert.equal(sellerDeliveryStage.payload.collaboration.currentStage.stage, "delivery");
    assert.equal(sellerDeliveryStage.payload.collaboration.currentStage.status, "completed");

    const buyerReviewStage = await requestJson(`${baseUrl}${freeTestAccepted.payload.jobWorkspace.stagesPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorRole: "buyer",
        stage: "review/accepted",
        status: "completed",
        label: "Buyer accepted delivery"
      })
    });
    assert.equal(buyerReviewStage.status, 200);
    assert.equal(buyerReviewStage.payload.collaboration.currentStage.stage, "review");
    assert.equal(buyerReviewStage.payload.collaboration.currentStage.status, "accepted");

    const buyerMessage = await requestJson(`${baseUrl}${freeTestAccepted.payload.jobWorkspace.messagesPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorRole: "buyer",
        body: "Please keep the answer concise.",
        stage: "in_progress"
      })
    });
    assert.equal(buyerMessage.status, 200);
    assert.equal(buyerMessage.payload.collaboration.messages.at(-1).authorRole, "buyer");
    assert.equal(buyerMessage.payload.collaboration.messages.at(-1).body, "Please keep the answer concise.");

    const buyerSpoofSeller = await requestJson(`${baseUrl}${freeTestAccepted.payload.jobWorkspace.messagesPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorRole: "seller",
        body: "spoof"
      })
    });
    assert.equal(buyerSpoofSeller.status, 403);

    const sellerSpoofBuyer = await requestJson(`${baseUrl}${freeTestAccepted.payload.jobWorkspace.messagesPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawz-admin-key": adminKey
      },
      body: JSON.stringify({
        authorRole: "buyer",
        body: "seller admin should not silently author as buyer"
      })
    });
    assert.equal(sellerSpoofBuyer.status, 403);

    const sellerSpoofBuyerStage = await requestJson(`${baseUrl}${freeTestAccepted.payload.jobWorkspace.stagesPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawz-admin-key": adminKey
      },
      body: JSON.stringify({
        authorRole: "buyer",
        stage: "review",
        status: "accepted",
        label: "seller admin should not buyer-accept"
      })
    });
    assert.equal(sellerSpoofBuyerStage.status, 403);

    const collaborationState = await requestJson(`${baseUrl}${freeTestAccepted.payload.jobWorkspace.collaborationPath}`, {
      method: "GET"
    });
    assert.equal(collaborationState.status, 200);
    assert.equal(collaborationState.payload.collaboration.requestId, freeTestAccepted.payload.requestId);
    assert.equal(collaborationState.payload.collaboration.messages.length, 1);
    assert.equal(collaborationState.payload.collaboration.stages.length, 3);

    const artifactBody = Buffer.from("Ask again after one brave sip of coffee.\n", "utf8");
    const artifactUpload = await requestJson(
      `${baseUrl}/api/executions/${encodeURIComponent(freeTestAccepted.payload.requestId)}/artifacts?filename=answer.md&contentType=text/markdown&deliveryMode=platform_scanned`,
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-clawz-admin-key": adminKey
        },
        body: artifactBody
      }
    );
    assert.equal(artifactUpload.status, 200);
    assert.equal(artifactUpload.payload.artifact.requestId, freeTestAccepted.payload.requestId);
    assert.equal(artifactUpload.payload.artifact.filename, "answer.md");
    assert.equal(artifactUpload.payload.artifact.contentType, "text/markdown");
    assert.equal(artifactUpload.payload.artifact.artifactBundleDigestSha256, createHash("sha256").update(artifactBody).digest("hex"));
    assert.equal(artifactUpload.payload.artifact.safety.status, "clean");
    assert.equal(artifactUpload.payload.artifact.safety.scanner, "santaclawz-static-policy-v1");
    assert.equal(artifactUpload.payload.artifact.safety.fileKind, "md");
    assert.equal(artifactUpload.payload.artifact.safety.malwareScanner, "not_configured");
    assert.equal(artifactUpload.payload.artifact.safety.privacyMode, "platform_scanned_then_encrypted_at_rest");
    assert.equal(artifactUpload.payload.artifact.safety.platformContentVisibility, "plaintext_during_platform_scan");
    assert.equal(artifactUpload.payload.artifact.requiresBuyerDownloadAcceptance, false);
    assert.match(artifactUpload.payload.artifact.artifactDownloadUrl, /\/api\/artifacts\/artifact_[a-f0-9]+\/download\?token=/);
    assert.deepEqual(artifactUpload.payload.verifiedOutputPatch, {
      artifact_manifest_url: artifactUpload.payload.artifact.artifactManifestUrl,
      artifact_bundle_digest_sha256: artifactUpload.payload.artifact.artifactBundleDigestSha256
    });

    const artifactManifest = await requestJson(artifactUpload.payload.artifact.artifactManifestUrl, { method: "GET" });
    assert.equal(artifactManifest.status, 200);
    assert.equal(artifactManifest.payload.artifact.digestSha256, artifactUpload.payload.artifact.artifactBundleDigestSha256);
    assert.equal(artifactManifest.payload.artifact.plaintextBytes, artifactBody.length);
    assert.equal(artifactManifest.payload.artifact.safety.status, "clean");

    const artifactDownload = await requestBytes(artifactUpload.payload.artifact.artifactDownloadUrl, { method: "GET" });
    assert.equal(artifactDownload.status, 200);
    assert.equal(artifactDownload.headers.get("x-santaclawz-artifact-digest-sha256"), artifactUpload.payload.artifact.artifactBundleDigestSha256);
    assert.deepEqual(artifactDownload.body, artifactBody);

    const encryptedBody = Buffer.from("ciphertext-only-for-buyer-local-decrypt-and-scan", "utf8");
    const privateArtifactUpload = await requestJson(
      `${baseUrl}/api/executions/${encodeURIComponent(freeTestAccepted.payload.requestId)}/artifacts?filename=private-output.sczenc&contentType=application/vnd.santaclawz.encrypted-artifact`,
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-clawz-admin-key": adminKey
        },
        body: encryptedBody
      }
    );
    assert.equal(privateArtifactUpload.status, 200);
    assert.equal(privateArtifactUpload.payload.artifact.deliveryMode, "buyer_encrypted");
    assert.equal(privateArtifactUpload.payload.artifact.requiresBuyerDownloadAcceptance, true);
    assert.equal(privateArtifactUpload.payload.artifact.safety.status, "buyer_scan_required");
    assert.equal(privateArtifactUpload.payload.artifact.safety.platformContentVisibility, "ciphertext_only");
    assert.equal(privateArtifactUpload.payload.artifact.safety.malwareScanner, "buyer_scan_required");

    const privateAgeUpload = await requestJson(
      `${baseUrl}/api/executions/${encodeURIComponent(freeTestAccepted.payload.requestId)}/artifacts?filename=private-output.age&contentType=application/octet-stream`,
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-clawz-admin-key": adminKey
        },
        body: Buffer.from("age-ciphertext-placeholder", "utf8")
      }
    );
    assert.equal(privateAgeUpload.status, 200);
    assert.equal(privateAgeUpload.payload.artifact.deliveryMode, "buyer_encrypted");
    assert.equal(privateAgeUpload.payload.artifact.safety.status, "buyer_scan_required");

    const privateDownloadBlocked = await requestJson(privateArtifactUpload.payload.artifact.artifactDownloadUrl, { method: "GET" });
    assert.equal(privateDownloadBlocked.status, 409);
    assert.equal(privateDownloadBlocked.payload.code, "buyer_scan_required");

    const privateDownloadAccepted = await requestBytes(`${privateArtifactUpload.payload.artifact.artifactDownloadUrl}&acceptRisk=true`, { method: "GET" });
    assert.equal(privateDownloadAccepted.status, 200);
    assert.deepEqual(privateDownloadAccepted.body, encryptedBody);

    const blockedScriptUpload = await requestJson(
      `${baseUrl}/api/executions/${encodeURIComponent(freeTestAccepted.payload.requestId)}/artifacts?filename=install.sh&contentType=text/x-shellscript&deliveryMode=platform_scanned`,
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-clawz-admin-key": adminKey
        },
        body: Buffer.from("#!/bin/sh\necho nope\n", "utf8")
      }
    );
    assert.equal(blockedScriptUpload.status, 400);
    assert.equal(blockedScriptUpload.payload.code, "artifact_safety_blocked");
    assert.equal(blockedScriptUpload.payload.safetyCode, "blocked_extension_not_allowed");
    assert.equal(blockedScriptUpload.payload.safety.codes.includes("blocked_executable_extension"), true);
    assert.equal(blockedScriptUpload.payload.safety.status, "blocked");
    assert.match(blockedScriptUpload.payload.sellerMessage, /non-executable/i);

    const blockedZipUpload = await requestJson(
      `${baseUrl}/api/executions/${encodeURIComponent(freeTestAccepted.payload.requestId)}/artifacts?filename=bundle.zip&contentType=application/zip&deliveryMode=platform_scanned`,
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-clawz-admin-key": adminKey
        },
        body: buildTinyZip([{ name: "../evil.sh", data: "echo bad" }])
      }
    );
    assert.equal(blockedZipUpload.status, 400);
    assert.equal(blockedZipUpload.payload.code, "artifact_safety_blocked");
    assert.equal(blockedZipUpload.payload.safetyCodes.includes("blocked_archive_path_traversal"), true);
    assert.equal(blockedZipUpload.payload.safetyCodes.includes("blocked_archive_executable_entry"), true);
    assert.equal(blockedZipUpload.payload.safety.archive.executableEntries.includes("../evil.sh"), true);
    assert.equal(blockedZipUpload.payload.safety.archive.suspiciousEntries.includes("../evil.sh"), true);

    const directDigest = createHash("sha256").update("direct bilateral bytes").digest("hex");
    const directReceipt = await requestJson(
      `${baseUrl}/api/executions/${encodeURIComponent(freeTestAccepted.payload.requestId)}/artifact-receipts`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clawz-admin-key": adminKey
        },
        body: JSON.stringify({
          deliveryMode: "direct_receipt",
          transport: "buyer_agent_inbox",
          scanPolicy: "buyer_required",
          filename: "direct-answer.md",
          contentType: "text/markdown",
          artifactDigestSha256: directDigest,
          artifactSizeBytes: 23,
          deliveryChannel: "buyer-agent-inbox://test",
          sellerDeliveryReceipt: "seller posted artifact package to buyer inbox"
        })
      }
    );
    assert.equal(directReceipt.status, 200);
    assert.equal(directReceipt.payload.receipt.deliveryMode, "direct_receipt");
    assert.equal(directReceipt.payload.receipt.transport, "buyer_agent_inbox");
    assert.equal(directReceipt.payload.receipt.scanPolicy, "buyer_required");
    assert.equal(directReceipt.payload.receipt.artifactDigestSha256, directDigest);
    assert.equal(directReceipt.payload.receipt.buyerAcceptanceStatus, "pending");
    assert.equal(directReceipt.payload.receipt.deliveryState, "receipt_recorded");
    assert.match(directReceipt.payload.receiptManifestUrl, /\/api\/artifact-receipts\/receipt_[a-f0-9]+\?token=/);
    assert.match(directReceipt.payload.buyerAcknowledgementUrl, /\/api\/artifact-receipts\/receipt_[a-f0-9]+\/acknowledge\?token=/);
    assert.deepEqual(directReceipt.payload.verifiedOutputPatch, {
      artifact_manifest_url: directReceipt.payload.receiptManifestUrl,
      artifact_bundle_digest_sha256: directDigest
    });

    const directReceiptManifest = await requestJson(directReceipt.payload.receiptManifestUrl, { method: "GET" });
    assert.equal(directReceiptManifest.status, 200);
    assert.equal(directReceiptManifest.payload.receipt.manifestDigestSha256, directReceipt.payload.receipt.manifestDigestSha256);

    const directReceiptAck = await requestJson(directReceipt.payload.buyerAcknowledgementUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accepted: true,
        bytesReceivedByBuyer: true,
        digestVerified: true,
        buyerScanStatus: "passed",
        note: "digest verified by buyer agent"
      })
    });
    assert.equal(directReceiptAck.status, 200);
    assert.equal(directReceiptAck.payload.receipt.buyerAcceptanceStatus, "accepted");
    assert.equal(directReceiptAck.payload.receipt.deliveryState, "buyer_accepted");
    assert.equal(directReceiptAck.payload.receipt.bytesReceivedByBuyer, true);
    assert.equal(directReceiptAck.payload.receipt.digestVerified, true);
    assert.equal(directReceiptAck.payload.receipt.buyerScanStatus, "passed");
    assert.equal(directReceiptAck.payload.receipt.buyerAcknowledgementNote, "digest verified by buyer agent");

    const executionState = await requestJson(
      `${baseUrl}/api/executions/${encodeURIComponent(freeTestAccepted.payload.requestId)}/state?token=${encodeURIComponent(freeTestAccepted.payload.jobWorkspace.token)}`,
      { method: "GET" }
    );
    assert.equal(executionState.status, 200);
    assert.equal(executionState.payload.schemaVersion, "santaclawz-execution-state/1.0");
    assert.equal(executionState.payload.currentPhase, "buyer_accepted");
    assert.equal(executionState.payload.lifecycle.artifactDeliveryStatus, "delivered");
    assert.equal(executionState.payload.lifecycle.buyerVerificationStatus, "verified");
    assert.equal(executionState.payload.lifecycle.buyerAcceptanceStatus, "accepted");
    assert.equal(executionState.payload.lifecycle.narrative.execution, "completed");
    assert.equal(executionState.payload.lifecycle.narrative.artifactDelivery, "delivered_or_receipt_recorded");
    assert.equal(executionState.payload.lifecycle.narrative.buyerAcceptance, "accepted");
    assert.equal(executionState.payload.lifecycleNarrative.summary, "Execution completed, artifact delivery is recorded, and buyer accepted the work.");
    assert.deepEqual(executionState.payload.lifecycleChecks, {
      paymentSettled: false,
      relayDelivered: true,
      agentStarted: true,
      agentCompleted: true,
      proofVerified: true,
      artifactDelivered: true,
      buyerVerified: true,
      buyerAccepted: true,
      failed: false,
      terminal: true
    });
    assert.equal(executionState.payload.privacy.jobVisibility, "private");
    assert.equal(executionState.payload.delivery.latestReceipt.deliveryState, "buyer_accepted");
    assert.equal(executionState.payload.workspace.stageCount, 3);

    const externalDigest = createHash("sha256").update("external reference bytes").digest("hex");
    const externalReceipt = await requestJson(
      `${baseUrl}/api/executions/${encodeURIComponent(freeTestAccepted.payload.requestId)}/artifact-receipts`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clawz-admin-key": adminKey
        },
        body: JSON.stringify({
          deliveryMode: "external_reference",
          filename: "large-output.zip",
          contentType: "application/zip",
          artifactDigestSha256: externalDigest,
          artifactSizeBytes: 98765,
          artifactUrl: "https://storage.example.test/signed/large-output.zip"
        })
      }
    );
    assert.equal(externalReceipt.status, 200);
    assert.equal(externalReceipt.payload.receipt.deliveryMode, "external_reference");
    assert.equal(externalReceipt.payload.receipt.transport, "external_url");
    assert.equal(externalReceipt.payload.receipt.scanPolicy, "external_unverified");
    assert.equal(externalReceipt.payload.receipt.artifactUrl, "https://storage.example.test/signed/large-output.zip");

    const freeTestLimited = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "This second free test should hit the per-agent quota.",
        requesterContact: "buyer@example.com"
      })
    });
    assert.equal(freeTestLimited.status, 400);
    assert.match(freeTestLimited.payload.error, /Free-test limit reached/i);

    console.log("ok - hire route gates ownership, publish, archive, payment readiness, and signed ingress delivery");
  } finally {
    await ingress.close();
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testMainnetFreeTestDisabledByDefault() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-mainnet-free-test-gate-"));
  const port = await reservePort();
  const ingressPort = await reservePort();
  const server = startServer(workspaceDir, port, {
    ZEKO_NETWORK_ID: "zeko-mainnet",
    CLAWZ_X402_BASE_FACILITATOR_URL: "https://x402-zeko.example"
  });
  const ingress = await startHireIngress(ingressPort);

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const ingressUrl = `http://127.0.0.1:${ingressPort}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);

    const registered = await requestJson(`${baseUrl}/api/console/register`, {
      method: "POST",
      body: JSON.stringify({
        agentName: "Mainnet Free Test Gate Agent",
        headline: "Confirms free-test does not silently sponsor mainnet traffic.",
        openClawUrl: ingressUrl
      })
    });
    assert.equal(registered.status, 200);
    const sessionId = registered.payload.session.sessionId;
    const agentId = registered.payload.agentId;
    const adminKey = registered.payload.adminAccess.issuedAdminKey;

    const challenge = await requestJson(`${baseUrl}/api/ownership/challenge`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({ sessionId, agentId })
    });
    assert.equal(challenge.status, 200);
    ingress.setChallengePayload(JSON.parse(challenge.payload.issuedOwnershipChallenge.challengeResponseJson));

    const verified = await requestJson(`${baseUrl}/api/ownership/verify`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({ sessionId, agentId })
    });
    assert.equal(verified.status, 200);

    const published = await requestJson(`${baseUrl}/api/social/anchors/settle`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({
        sessionId,
        agentId,
        localOnly: true
      })
    });
    assert.equal(published.status, 200);

    const freeTestReady = await requestJson(`${baseUrl}/api/console/profile?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({
        paymentProfile: {
          enabled: true,
          supportedRails: ["base-usdc"],
          defaultRail: "base-usdc",
          pricingMode: "free-test",
          settlementTrigger: "upfront"
        }
      })
    });
    assert.equal(freeTestReady.status, 200);
    assert.equal(freeTestReady.payload.profile.paymentProfile.pricingMode, "free-test");

    const mainnetFreeTestHire = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "This free test should not be operational on mainnet by default.",
        requesterContact: "buyer@example.com"
      })
    });
    assert.equal(mainnetFreeTestHire.status, 400);
    assert.match(mainnetFreeTestHire.payload.error, /disabled on mainnet/i);

    console.log("ok - mainnet free-test lane is disabled by default");
  } finally {
    await ingress.close();
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testStaleRelayDoesNotStayLive() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-stale-relay-test-"));
  const port = await reservePort();
  const server = startServer(workspaceDir, port, {
    CLAWZ_AGENT_RELAY_HEARTBEAT_GRACE_MS: "500"
  });
  let relaySocket;

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);

    const registered = await requestJson(`${baseUrl}/api/console/register`, {
      method: "POST",
      body: JSON.stringify({
        agentName: "Stale Relay Agent",
        headline: "Confirms sleeping relay agents do not stay live.",
        openClawUrl: "http://127.0.0.1:49998/agent",
        runtimeDelivery: {
          mode: "santaclawz-relay"
        }
      })
    });
    assert.equal(registered.status, 200);
    const agentId = registered.payload.agentId;
    const adminKey = registered.payload.adminAccess.issuedAdminKey;

    relaySocket = await connectRelaySocket(baseUrl, agentId, adminKey);

    const liveRegistry = await requestJson(`${baseUrl}/api/agents`);
    assert.equal(liveRegistry.status, 200);
    assert.equal(liveRegistry.payload.find((agent) => agent.agentId === agentId)?.runtimeStatus, "live");

    const liveAvailability = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/availability`);
    assert.equal(liveAvailability.status, 200);
    assert.equal(liveAvailability.payload.reachable, true);
    assert.equal(liveAvailability.payload.runtimeStatus, "live");
    assert.equal(liveAvailability.payload.readiness.relayConnected, true);
    assert.equal(liveAvailability.payload.readiness.runtimeReachable, true);

    const relayPricingUpdate = await requestJson(`${baseUrl}/api/console/profile?agentId=${encodeURIComponent(agentId)}`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({
        agentId,
        payoutWallets: {
          base: "0x1908217952D7117f5aeFBbd91AeBf04566D286f9"
        },
        paymentProfile: {
          enabled: true,
          supportedRails: ["base-usdc"],
          defaultRail: "base-usdc",
          pricingMode: "fixed-exact",
          fixedAmountUsd: "0.25",
          settlementTrigger: "upfront"
        }
      })
    });
    assert.equal(relayPricingUpdate.status, 200);
    assert.equal(relayPricingUpdate.payload.profile.runtimeDelivery.mode, "santaclawz-relay");

    const relayRegistryAfterPricing = await requestJson(`${baseUrl}/api/agents`);
    assert.equal(relayRegistryAfterPricing.status, 200);
    const relayAgentAfterPricing = relayRegistryAfterPricing.payload.find((agent) => agent.agentId === agentId);
    assert.equal(relayAgentAfterPricing?.runtimeDeliveryMode, "santaclawz-relay");
    assert.equal(relayAgentAfterPricing?.readiness?.relayConnected, true);

    await new Promise((resolve) => setTimeout(resolve, 900));

    const staleAvailability = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/availability`);
    assert.equal(staleAvailability.status, 200);
    assert.equal(staleAvailability.payload.reachable, false);
    assert.equal(staleAvailability.payload.runtimeStatus, "offline");
    assert.equal(staleAvailability.payload.readiness.relayConnected, false);
    assert.equal(staleAvailability.payload.readiness.hireable, false);
    assert.match(staleAvailability.payload.reason, /waiting/i);

    const staleRegistry = await requestJson(`${baseUrl}/api/agents`);
    assert.equal(staleRegistry.status, 200);
    const staleAgent = staleRegistry.payload.find((agent) => agent.agentId === agentId);
    assert.equal(staleAgent?.runtimeStatus, "offline");
    assert.equal(staleAgent?.readiness?.relayConnected, false);
    assert.match(staleAgent?.runtimeStatusReason ?? "", /waiting/i);

    console.log("ok - stale relay sockets do not keep sleeping agents marked live");
  } finally {
    relaySocket?.destroy();
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testRelayHireFailureCreatesDurableExecutionRecord() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-relay-hire-failure-test-"));
  const port = await reservePort();
  const server = startServer(workspaceDir, port, {
    CLAWZ_AGENT_RELAY_RESPONSE_TIMEOUT_MS: "500"
  });
  let relaySocket;

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);

    const ticket = await requestJson(`${baseUrl}/api/enrollment/tickets`, {
      method: "POST",
      body: JSON.stringify({
        agentName: "Relay Hire Failure Agent",
        headline: "Keeps durable execution state when the relay response breaks.",
        representedPrincipal: "Relay failure smoke operator",
        paymentProfile: {
          enabled: true,
          supportedRails: ["base-usdc"],
          defaultRail: "base-usdc",
          pricingMode: "free-test",
          settlementTrigger: "upfront"
        }
      })
    });
    assert.equal(ticket.status, 200);

    const redeemed = await requestJson(`${baseUrl}/api/enrollment/redeem`, {
      method: "POST",
      body: JSON.stringify({ ticket: ticket.payload.ticket })
    });
    assert.equal(redeemed.status, 200);
    const sessionId = redeemed.payload.session.sessionId;
    const agentId = redeemed.payload.agentId;
    const adminKey = redeemed.payload.adminAccess.issuedAdminKey;

    const published = await requestJson(`${baseUrl}/api/social/anchors/settle`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({ sessionId, agentId, localOnly: true })
    });
    assert.equal(published.status, 200);

    relaySocket = await connectRelaySocket(baseUrl, agentId, adminKey);
    const hirePromise = requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Record this even if the relay response disappears.",
        requesterContact: "buyer@example.com"
      })
    });
    const relayHire = await waitForRelayJson(
      relaySocket,
      (message) => message.type === "hire_request"
    );
    assert.equal(relayHire.request.requestKind, "free_test");
    relaySocket.destroy();

    const hire = await hirePromise;
    assert.equal(hire.status, 200);
    assert.equal(hire.payload.status, "submitted");
    assert.equal(hire.payload.operationalStatus.relayDeliveryStatus, "failed");
    assert.equal(hire.payload.operationalStatus.agentExecutionStatus, "submitted");
    assert.equal(["relay_disconnected", "relay_timeout"].includes(hire.payload.deliveryReceipt.stage), true);
    assert.match(hire.payload.deliveryReceipt.target, /^santaclawz-relay:\/\//);
    assert.match(hire.payload.deliveryError, /relay response|Relay connection/);
    assert.deepEqual(
      hire.payload.relayTrace.map((entry) => `${entry.step}:${entry.status}`),
      [
        "accepted_by_indexer:completed",
        "sent_to_relay:completed",
        "relay_returned:failed",
        "worker_ack:not_reached",
        "worker_completed:not_reached",
        "state_updated:completed"
      ]
    );

    const executionLookup = await requestJson(`${baseUrl}/api/executions/${encodeURIComponent(hire.payload.requestId)}`);
    assert.equal(executionLookup.status, 200);
    assert.equal(executionLookup.payload.request.requestId, hire.payload.requestId);
    assert.equal(executionLookup.payload.request.operationalStatus.relayDeliveryStatus, "failed");
    assert.equal(["relay_disconnected", "relay_timeout"].includes(executionLookup.payload.request.deliveryReceipt.stage), true);
    assert.equal(executionLookup.payload.request.relayTrace.at(-1).step, "state_updated");

    console.log("ok - relay hire response failures create durable execution records");
  } finally {
    relaySocket?.destroy();
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testOfficialRelayNormalizesLargeWorkerResponses() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-official-relay-normalize-test-"));
  const port = await reservePort();
  const ingressPort = await reservePort();
  const server = startServer(workspaceDir, port, {
    CLAWZ_AGENT_RELAY_RESPONSE_TIMEOUT_MS: "5000",
    CLAWZ_FREE_TEST_AGENT_HIRE_LIMIT_PER_10M: "2"
  });
  const ingress = await startHireIngress(ingressPort);
  let relayProcess;

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);

    const ticket = await requestJson(`${baseUrl}/api/enrollment/tickets`, {
      method: "POST",
      body: JSON.stringify({
        agentName: "Official Relay Normalize Agent",
        headline: "Confirms official relay sends canonical worker responses.",
        representedPrincipal: "Relay normalization smoke operator",
        paymentProfile: {
          enabled: true,
          supportedRails: ["base-usdc"],
          defaultRail: "base-usdc",
          pricingMode: "free-test",
          settlementTrigger: "upfront"
        }
      })
    });
    assert.equal(ticket.status, 200);

    const redeemed = await requestJson(`${baseUrl}/api/enrollment/redeem`, {
      method: "POST",
      body: JSON.stringify({ ticket: ticket.payload.ticket })
    });
    assert.equal(redeemed.status, 200);
    const sessionId = redeemed.payload.session.sessionId;
    const agentId = redeemed.payload.agentId;
    const adminKey = redeemed.payload.adminAccess.issuedAdminKey;
    ingress.setExpectedIngressToken(redeemed.payload.ingressAccess.issuedIngressToken);
    ingress.setExpectedSigningSecret(redeemed.payload.ingressAccess.issuedSigningSecret);
    ingress.setExpectedServiceKey(redeemed.payload.ingressAccess.serviceKey);

    const published = await requestJson(`${baseUrl}/api/social/anchors/settle`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({ sessionId, agentId, localOnly: true })
    });
    assert.equal(published.status, 200);

    const envPath = path.join(workspaceDir, ".env.santaclawz");
    await writeFile(
      envPath,
      [
        `CLAWZ_API_BASE=${baseUrl}`,
        `CLAWZ_AGENT_ID=${agentId}`,
        `CLAWZ_AGENT_SESSION_ID=${sessionId}`,
        `CLAWZ_AGENT_ADMIN_KEY=${adminKey}`,
        ""
      ].join("\n"),
      "utf8"
    );

    relayProcess = spawn(
      "node",
      [
        relayEntry,
        "--env-file",
        envPath,
        "--api-base",
        baseUrl,
        "--relay-base",
        baseUrl,
        "--local-hire-url",
        `http://127.0.0.1:${ingressPort}/hire`,
        "--takeover",
        "--no-heartbeat"
      ],
      {
        cwd: workspaceDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const relayLogs = { stdout: [], stderr: [] };
    relayProcess.stdout.on("data", (chunk) => relayLogs.stdout.push(String(chunk)));
    relayProcess.stderr.on("data", (chunk) => relayLogs.stderr.push(String(chunk)));

    await waitForJsonMatch(
      `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/relay-status`,
      (payload) => payload.connected === true,
      SERVER_READY_TIMEOUT_MS,
      relayLogs
    );

    const deliverables = Array.from({ length: 28 }, (_, index) => ({
      name: `job-pack-artifact-${String(index + 1).padStart(2, "0")}.json`,
      sha256: createHash("sha256").update(`job-pack-artifact-${index + 1}`).digest("hex")
    }));
    ingress.setNextProtocolReturnFactory(({ requestId }) => ({
      schema_version: "santaclawz-return/1.0",
      request_id: requestId,
      status: "completed",
      agent_private: true,
      noisy_worker_trace: "x".repeat(9000),
      verified_output: {
        package_hash: "d".repeat(64),
        hash_algorithm: "sha256",
        verification_manifest: {
          input_digest_sha256: "e".repeat(64),
          checks_performed: ["worker_completed", "manifest_verified", "deliverables_hashed"],
          files_produced: deliverables.map((deliverable) => deliverable.name),
          blocked_suspicious_instructions: []
        },
        deliverables
      }
    }));

    const hire = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Return a large worker envelope through official relay.",
        requesterContact: "buyer@example.com"
      })
    });
    assert.equal(hire.status, 200);
    assert.equal(hire.payload.status, "completed");
    assert.equal(hire.payload.deliveryStatus, "forwarded");
    assert.equal(hire.payload.operationalStatus.relayDeliveryStatus, "forwarded");
    assert.equal(hire.payload.operationalStatus.agentExecutionStatus, "completed");
    assert.equal(hire.payload.protocolReturn.status, "completed");
    assert.equal(hire.payload.protocolReturn.verifiedOutput.deliverableCount, 28);
    assert.equal(hire.payload.deliveryReceipt.workerStatusCode, 200);
    assert.ok(hire.payload.deliveryReceipt.workerResponseBytes > 10_000);
    assert.match(hire.payload.deliveryReceipt.workerResponseDigestSha256, /^[a-f0-9]{64}$/);
    assert.ok(hire.payload.deliveryReceipt.relayBodyBytes > 4_000);
    assert.match(hire.payload.deliveryReceipt.relayBodyDigestSha256, /^[a-f0-9]{64}$/);
    assert.equal(hire.payload.relayTrace.some((entry) => entry.step === "worker_ack" && entry.status === "completed"), true);
    assert.equal(hire.payload.relayTrace.some((entry) => entry.step === "worker_completed" && entry.status === "completed"), true);
    const executionState = await requestJson(
      `${baseUrl}/api/executions/${encodeURIComponent(hire.payload.requestId)}/state?token=${encodeURIComponent(hire.payload.jobWorkspace.token)}`
    );
    assert.equal(executionState.status, 200);
    assert.equal(executionState.payload.relayTrace.some((entry) => entry.step === "worker_ack" && entry.status === "completed"), true);
    assert.match(relayLogs.stderr.join(""), /"relayPayloadBytes":[4-9][0-9]{3}/);
    assert.match(relayLogs.stderr.join(""), /relay_worker_request_received/);
    assert.match(relayLogs.stderr.join(""), /relay_worker_response_normalized/);

    console.log("ok - official relay normalizes large worker responses into accepted hire_response JSON");
  } finally {
    if (relayProcess) {
      await stopProcess(relayProcess);
    }
    await ingress.close();
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testMissionAuthVerificationPersists() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-mission-auth-test-"));
  const port = await reservePort();
  const authorityPort = await reservePort();
  const server = startServer(workspaceDir, port);
  const authority = await startMissionAuthAuthority(authorityPort);

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);

    const registered = await requestJson(`${baseUrl}/api/console/register`, {
      method: "POST",
      body: JSON.stringify({
        agentName: "Mission Auth Agent",
        headline: "Verifies mission-bound Web2 receipts.",
        openClawUrl: "http://127.0.0.1:49999/agent"
      })
    });
    assert.equal(registered.status, 200);
    assert.equal(registered.payload.profile.missionAuthOverlay.status, "disabled");
    assert.equal(typeof registered.payload.adminAccess.issuedAdminKey, "string");

    const sessionId = registered.payload.session.sessionId;
    const agentId = registered.payload.agentId;
    const adminKey = registered.payload.adminAccess.issuedAdminKey;
    const heartbeat = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/heartbeat`, {
      method: "POST",
      headers: {
        "x-clawz-admin-key": adminKey
      },
      body: JSON.stringify({
        sessionId,
        status: "live",
        ttlSeconds: 20,
        note: "Local smoke heartbeat.",
        relayAgentProtocolVersion: "santaclawz-relay-agent/test",
        relayAgentBuild: "test-build-123",
        relayAgentFeatures: ["worker_progress", "node_http_worker_forwarding"]
      })
    });
    assert.equal(heartbeat.status, 200);
    assert.equal(heartbeat.payload.status, "live");
    assert.equal(heartbeat.payload.lastHeartbeatAtIso, heartbeat.payload.checkedAtIso);
    assert.equal(heartbeat.payload.relayAgentProtocolVersion, "santaclawz-relay-agent/test");
    assert.equal(heartbeat.payload.relayAgentBuild, "test-build-123");
    assert.deepEqual(heartbeat.payload.relayAgentFeatures, ["worker_progress", "node_http_worker_forwarding"]);
    const coalescedHeartbeat = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/heartbeat`, {
      method: "POST",
      headers: {
        "x-clawz-admin-key": adminKey
      },
      body: JSON.stringify({
        sessionId,
        status: "live",
        ttlSeconds: 20,
        note: "Local smoke heartbeat.",
        relayAgentProtocolVersion: "santaclawz-relay-agent/test",
        relayAgentBuild: "test-build-123",
        relayAgentFeatures: ["worker_progress", "node_http_worker_forwarding"]
      })
    });
    assert.equal(coalescedHeartbeat.status, 200);
    assert.equal(coalescedHeartbeat.payload.status, "live");
    assert.equal(coalescedHeartbeat.payload.lastHeartbeatAtIso, heartbeat.payload.lastHeartbeatAtIso);

    const availability = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/availability`);
    assert.equal(availability.status, 200);
    assert.equal(availability.payload.runtimeStatus, "live");
    assert.equal(availability.payload.heartbeat.status, "live");
    assert.equal(availability.payload.heartbeat.relayAgentBuild, "test-build-123");
    assert.deepEqual(availability.payload.heartbeat.relayAgentFeatures, ["worker_progress", "node_http_worker_forwarding"]);
    assert.equal(availability.payload.readiness.heartbeatLive, true);

    const registry = await requestJson(`${baseUrl}/api/agents`);
    assert.equal(registry.status, 200);
    assert.equal(registry.payload.find((agent) => agent.agentId === agentId)?.runtimeStatus, "live");
    assert.equal(registry.payload.find((agent) => agent.agentId === agentId)?.readiness?.heartbeatLive, true);

    const authorityBaseUrl = `http://127.0.0.1:${authorityPort}`;
    const checked = await requestJson(`${baseUrl}/api/mission-auth/check`, {
      method: "POST",
      headers: {
        "x-clawz-admin-key": adminKey
      },
      body: JSON.stringify({
        sessionId,
        missionAuthOverlay: {
          enabled: true,
          status: "configured",
          authorityBaseUrl,
          providerHint: "custom-oidc",
          scopeHints: ["github:repo"]
        }
      })
    });
    assert.equal(checked.status, 200);
    assert.equal(checked.payload.profile.missionAuthOverlay.status, "verified");
    assert.equal(checked.payload.profile.missionAuthOverlay.protocol, "zk-mission-auth");
    assert.equal(checked.payload.profile.missionAuthOverlay.authorityName, "Local Mission Authority");
    assert.deepEqual(checked.payload.profile.missionAuthOverlay.supportedProviders, ["auth0", "custom-oidc"]);

    const persisted = await requestJson(`${baseUrl}/api/console/state?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "GET",
      headers: {
        "x-clawz-admin-key": adminKey
      }
    });
    assert.equal(persisted.status, 200);
    assert.equal(persisted.payload.profile.missionAuthOverlay.status, "verified");
    assert.equal(persisted.payload.profile.missionAuthOverlay.authorityBaseUrl, authorityBaseUrl);

    const forged = await requestJson(`${baseUrl}/api/console/profile?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: {
        "x-clawz-admin-key": adminKey
      },
      body: JSON.stringify({
        missionAuthOverlay: {
          enabled: true,
          status: "verified",
          authorityBaseUrl: "http://127.0.0.1:49998",
          protocol: "zk-mission-auth",
          authorityName: "Forged"
        }
      })
    });
    assert.equal(forged.status, 200);
    assert.equal(forged.payload.profile.missionAuthOverlay.status, "configured");
    assert.equal(forged.payload.profile.missionAuthOverlay.authorityName, undefined);

    console.log("ok - mission auth verification persists only through the server-validated check path");
  } finally {
    await stopHttpServer(authority);
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testLegacyDemoProfileCanEnableBasePayments() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-legacy-payment-test-"));
  const port = await reservePort();
  const server = startServer(workspaceDir, port);

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);

    const updated = await requestJson(`${baseUrl}/api/console/profile?sessionId=session_demo_enterprise`, {
      method: "POST",
      body: JSON.stringify({
        payoutWallets: {
          base: "0x1908217952D7117f5aeFBbd91AeBf04566D286f9"
        },
        paymentProfile: {
          enabled: true,
          supportedRails: ["base-usdc"],
          defaultRail: "base-usdc",
          pricingMode: "fixed-exact",
          fixedAmountUsd: "0.01",
          settlementTrigger: "upfront"
        }
      })
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.payload.profile.openClawUrl, "");
    assert.equal(updated.payload.profile.payoutWallets.base, "0x1908217952D7117f5aeFBbd91AeBf04566D286f9");
    assert.equal(updated.payload.profile.paymentProfile.enabled, true);
    assert.equal(updated.payload.profile.paymentProfile.fixedAmountUsd, "0.01");

    const ready = await requestJson(`${baseUrl}/ready`);
    assert.equal(ready.status, 200);

    console.log("ok - legacy demo profile can enable Base payments without a registered OpenClaw URL");
  } finally {
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testHostedBasePaymentsRequireMinimumFacilitationFee() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-facilitation-floor-test-"));
  const port = await reservePort();
  const server = startServer(workspaceDir, port, {
    CLAWZ_X402_BASE_FACILITATOR_URL: "https://x402-zeko.example",
    CLAWZ_X402_MIN_NETWORK_FACILITATION_FEE_USD: "0.002",
    CLAWZ_PROTOCOL_OWNER_FEE_ENABLED: "true",
    CLAWZ_PROTOCOL_OWNER_FEE_BPS: "100",
    CLAWZ_PROTOCOL_FEE_BASE_RECIPIENT: "0xF787fF44c5e80c8165e1B4FB156411e2d42c91B2",
    CLAWZ_X402_RESERVE_RELEASE_ESCROW_ENABLED: "false",
    CLAWZ_X402_BASE_RESERVE_RELEASE_ESCROW_ENABLED: "false"
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);

    const profileBody = {
      payoutWallets: {
        base: "0x1908217952D7117f5aeFBbd91AeBf04566D286f9"
      },
      paymentProfile: {
        enabled: true,
        supportedRails: ["base-usdc"],
        defaultRail: "base-usdc",
        pricingMode: "fixed-exact",
        fixedAmountUsd: "0.001",
        settlementTrigger: "upfront"
      }
    };
    const underFloor = await requestJson(`${baseUrl}/api/console/profile?sessionId=session_demo_enterprise`, {
      method: "POST",
      body: JSON.stringify(profileBody)
    });
    assert.equal(underFloor.status, 200);

    const underFloorPlan = await requestJson(`${baseUrl}/api/x402/plan?sessionId=session_demo_enterprise`);
    assert.equal(underFloorPlan.status, 200);
    assert.equal(underFloorPlan.payload.rails[0].ready, false);
    assert.match(underFloorPlan.payload.rails[0].missing.join("\n"), /above \$0\.002/);
    assert.match(underFloorPlan.payload.rails[0].notes.join("\n"), /\$0\.002/);

    const microPayment = await requestJson(`${baseUrl}/api/console/profile?sessionId=session_demo_enterprise`, {
      method: "POST",
      body: JSON.stringify({
        ...profileBody,
        paymentProfile: {
          ...profileBody.paymentProfile,
          fixedAmountUsd: "0.01"
        }
      })
    });
    assert.equal(microPayment.status, 200);

    const microPaymentPlan = await requestJson(`${baseUrl}/api/x402/plan?sessionId=session_demo_enterprise`);
    assert.equal(microPaymentPlan.status, 200);
    assert.equal(microPaymentPlan.payload.rails[0].ready, true);
    assert.equal(microPaymentPlan.payload.rails[0].settlementModel, "x402-exact-evm-fee-split-v1");
    assert.equal(microPaymentPlan.payload.feePreviewByRail[0].protocolFeeAmountUsd, "0.002");
    assert.equal(microPaymentPlan.payload.feePreviewByRail[0].nominalProtocolFeeAmountUsd, "0.0001");
    assert.equal(microPaymentPlan.payload.feePreviewByRail[0].networkFacilitationFeeAmountUsd, "0.002");
    assert.equal(microPaymentPlan.payload.feePreviewByRail[0].sellerNetAmountUsd, "0.008");
    assert.equal(microPaymentPlan.payload.feePreviewByRail[0].feeBasis, "network-facilitation-minimum");

    const microPaymentCatalog = await requestJson(`${baseUrl}/.well-known/x402.json?sessionId=session_demo_enterprise`);
    assert.equal(microPaymentCatalog.status, 200);
    assert.equal(microPaymentCatalog.payload.routes[0].accepts[0].amount, "10000");
    assert.notEqual(microPaymentCatalog.payload.routes[0].accepts[0].amount, "0.01");
    assert.equal(microPaymentCatalog.payload.routes[0].accepts[0].settlementModel, "x402-exact-evm-fee-split-v1");
    assert.equal(microPaymentCatalog.payload.routes[0].accepts[0].extensions.evm.feeSplit.grossAmount, "10000");
    assert.equal(microPaymentCatalog.payload.routes[0].accepts[0].extensions.evm.feeSplit.sellerAmount, "8000");
    assert.equal(microPaymentCatalog.payload.routes[0].accepts[0].extensions.evm.feeSplit.protocolFeeAmount, "2000");
    assert.equal(
      microPaymentCatalog.payload.routes[0].accepts[0].extensions.evm.feeSplit.protocolFeePayTo,
      "0xF787fF44c5e80c8165e1B4FB156411e2d42c91B2"
    );

    const atFloor = await requestJson(`${baseUrl}/api/console/profile?sessionId=session_demo_enterprise`, {
      method: "POST",
      body: JSON.stringify({
        ...profileBody,
        paymentProfile: {
          ...profileBody.paymentProfile,
          fixedAmountUsd: "0.20"
        }
      })
    });
    assert.equal(atFloor.status, 200);

    const atFloorPlan = await requestJson(`${baseUrl}/api/x402/plan?sessionId=session_demo_enterprise`);
    assert.equal(atFloorPlan.status, 200);
    assert.equal(atFloorPlan.payload.rails[0].ready, true);
    assert.equal(atFloorPlan.payload.rails[0].settlementModel, "x402-exact-evm-fee-split-v1");
    assert.equal(atFloorPlan.payload.feePreviewByRail[0].protocolFeeAmountUsd, "0.002");
    assert.equal(atFloorPlan.payload.feePreviewByRail[0].sellerNetAmountUsd, "0.198");

    const escrowDarkLaunch = await requestJson(`${baseUrl}/api/console/profile?sessionId=session_demo_enterprise`, {
      method: "POST",
      body: JSON.stringify({
        ...profileBody,
        paymentProfile: {
          ...profileBody.paymentProfile,
          fixedAmountUsd: "2.00",
          settlementTrigger: "on-proof",
          baseEscrowContract: "0x1111111111111111111111111111111111111111"
        }
      })
    });
    assert.equal(escrowDarkLaunch.status, 200);

    const escrowDarkLaunchPlan = await requestJson(`${baseUrl}/api/x402/plan?sessionId=session_demo_enterprise`);
    assert.equal(escrowDarkLaunchPlan.status, 200);
    assert.equal(escrowDarkLaunchPlan.payload.rails[0].executionMode, "reserve-release");
    assert.equal(escrowDarkLaunchPlan.payload.rails[0].settlementModel, "x402-base-usdc-reserve-release-v4");
    assert.equal(escrowDarkLaunchPlan.payload.rails[0].ready, false);
    assert.match(
      escrowDarkLaunchPlan.payload.rails[0].missing.join("\n"),
      /CLAWZ_X402_BASE_RESERVE_RELEASE_ESCROW_ENABLED/
    );

    console.log("ok - hosted Base payments deduct the higher of percentage fee or minimum network facilitation fee");
  } finally {
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function main() {
  await testPersistenceFlow();
  await testMalformedEventFlow();
  await testFocusedInteropSessionFlow();
  await testProtectedApiAuth();
  await testPublicOnboardingApiAuth();
  await testOperatorCanDeleteLostKeyRegistration();
  await testZekoSocialAnchorHealthAndMembershipState();
  await testProofBackedAgentMessageBoard();
  await testExecutionIntentLifecycleAnchors();
  await testHireRouteRequiresSafeIngressAndPaymentState();
  await testMainnetFreeTestDisabledByDefault();
  await testStaleRelayDoesNotStayLive();
  await testRelayHireFailureCreatesDurableExecutionRecord();
  await testOfficialRelayNormalizesLargeWorkerResponses();
  await testMissionAuthVerificationPersists();
  await testLegacyDemoProfileCanEnableBasePayments();
  await testHostedBasePaymentsRequireMinimumFacilitationFee();
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
}
