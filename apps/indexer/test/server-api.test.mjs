import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildAgentMessageEnvelope } from "@clawz/protocol";

const serverEntry = fileURLToPath(new URL("../dist/apps/indexer/src/server.js", import.meta.url));
const controlPlaneEntry = fileURLToPath(new URL("../dist/apps/indexer/src/control-plane.js", import.meta.url));
const artifactStoreEntry = fileURLToPath(new URL("../dist/apps/indexer/src/artifact-store.js", import.meta.url));
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
      CLAWZ_PUBLIC_READ_RATE_LIMIT_MAX_COST: "100000",
      CLAWZ_PUBLIC_READ_FIRST_PARTY_RATE_LIMIT_MAX_COST: "100000",
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
    payload,
    headers: response.headers
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
    assert.ok(readiness.checks.some((check) => check.label === "process" && check.ok === true));

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

    const publicSettlementRetryMiss = await requestJson(`${baseUrl}/api/x402/settlement-retry?ledgerId=pay_missing_auth_smoke`, {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(publicSettlementRetryMiss.status, 404);
    assert.equal(publicSettlementRetryMiss.payload.code, "settlement_retry_ledger_not_found");

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
    const publicMarketplaceSnapshot = await requestJson(`${baseUrl}/api/public/marketplace-snapshot`, { method: "GET" });
    assert.equal(publicMarketplaceSnapshot.status, 200);
    assert.equal(publicMarketplaceSnapshot.payload.schemaVersion, "santaclawz-public-marketplace-snapshot/1.0");
    const searchedAgentId = publicAgentSearch.payload.agents[0]?.agentId;
    if (searchedAgentId) {
      const publicAgentReady = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(searchedAgentId)}/ready`, {
        method: "GET"
      });
      assert.equal(publicAgentReady.status, 200);
      assert.equal(publicAgentReady.payload.schemaVersion, "santaclawz-agent-readiness/1.0");
    }

    const workshopAgent = await requestJson(`${baseUrl}/api/console/register`, {
      method: "POST",
      headers: {
        "x-api-key": "test_operator_key"
      },
      body: JSON.stringify({
        agentName: "Workshop Token Smoke Agent",
        headline: "Temporary workshop token smoke registration.",
        openClawUrl: "http://127.0.0.1:49993/agent"
      })
    });
    assert.equal(workshopAgent.status, 200);
    const workshopAgentId = workshopAgent.payload.agentId;
    assert.ok(workshopAgentId);
    const workshopRecipientAgent = await requestJson(`${baseUrl}/api/console/register`, {
      method: "POST",
      headers: {
        "x-api-key": "test_operator_key"
      },
      body: JSON.stringify({
        agentName: "Workshop Recipient Smoke Agent",
        headline: "Temporary workshop encrypted recipient smoke registration.",
        openClawUrl: "http://127.0.0.1:49994/agent"
      })
    });
    assert.equal(workshopRecipientAgent.status, 200);
    const workshopRecipientAgentId = workshopRecipientAgent.payload.agentId;
    assert.ok(workshopRecipientAgentId);

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

    const publicWorkshopTicket = await requestJson(`${baseUrl}/api/workshop/setup-tickets`, {
      method: "POST",
      body: JSON.stringify({
        manifest: {
          schemaVersion: "santaclawz-team-coordination-bridge/0.1",
          threadId: "eventlog_public_workshop_auth_smoke",
          swarmId: "workflow_public_workshop_auth_smoke",
          apiBase: baseUrl,
          coordinationPolicy: {
            privacyMode: "digest-only"
          },
          channelPolicy: {
            defaultChannelId: "general",
            agentCreatedChannels: "allowed",
            channelIdPattern: "^[a-z0-9][a-z0-9._:-]{0,79}$",
            privateEnvelopeRequired: true,
            receiptsRequired: true,
            publicLedgerProjection: "proof-only"
          },
          channels: [
            {
              channelId: "general",
              name: "General workshop",
              allowedRoles: ["admin", "member"],
              disclosure: "private-setup-only"
            },
            {
              channelId: "admin",
              name: "Admin coordination",
              allowedRoles: ["admin"],
              disclosure: "private-setup-only"
            }
          ],
          participants: [
            {
              agentId: workshopAgentId,
              role: "admin"
            },
            {
              agentId: workshopRecipientAgentId,
              role: "member"
            }
          ]
        }
      })
    });
    assert.equal(publicWorkshopTicket.status, 200);
    assert.match(publicWorkshopTicket.payload.ticket, /^scz_coord_/);
    assert.equal(publicWorkshopTicket.payload.threadId, "eventlog_public_workshop_auth_smoke");

    const publicWorkshopTicketStatus = await requestJson(
      `${baseUrl}/api/workshop/setup-tickets/${encodeURIComponent(publicWorkshopTicket.payload.ticketId)}/status?${new URLSearchParams({ ticket: publicWorkshopTicket.payload.ticket }).toString()}`,
      { method: "GET" }
    );
    assert.equal(publicWorkshopTicketStatus.status, 200);
    assert.equal(publicWorkshopTicketStatus.payload.claimedCount, 0);
    assert.equal(publicWorkshopTicketStatus.payload.totalCount, 2);

    const publicWorkshopTicketClaim = await requestJson(`${baseUrl}/api/workshop/setup-tickets/claim`, {
      method: "POST",
      body: JSON.stringify({
        ticket: publicWorkshopTicket.payload.ticket,
        agentId: workshopAgentId
      })
    });
    assert.equal(publicWorkshopTicketClaim.status, 200);
    assert.equal(publicWorkshopTicketClaim.payload.agentId, workshopAgentId);
    assert.match(publicWorkshopTicketClaim.payload.workshopAccessToken, /^scz_workshop_/);
    const publicWorkshopRecipientTicketClaim = await requestJson(`${baseUrl}/api/workshop/setup-tickets/claim`, {
      method: "POST",
      body: JSON.stringify({
        ticket: publicWorkshopTicket.payload.ticket,
        agentId: workshopRecipientAgentId
      })
    });
    assert.equal(publicWorkshopRecipientTicketClaim.status, 200);
    assert.equal(publicWorkshopRecipientTicketClaim.payload.agentId, workshopRecipientAgentId);
    assert.match(publicWorkshopRecipientTicketClaim.payload.workshopAccessToken, /^scz_workshop_/);

    const publicWorkshopMessage = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(workshopAgentId)}/messages`, {
      method: "POST",
      headers: {
        "x-santaclawz-workshop-token": publicWorkshopTicketClaim.payload.workshopAccessToken
      },
      body: JSON.stringify({
        messageType: "dispatch",
        body: "Workshop auth smoke: participant can publish a scoped coordination ping.",
        threadId: "eventlog_public_workshop_auth_smoke",
        swarmId: "workflow_public_workshop_auth_smoke",
        clientMessageId: "workshop-auth-smoke-transition-1",
        topicTags: ["team-coordination"],
        proofIntent: "agent_chatter"
      })
    });
    assert.equal(publicWorkshopMessage.status, 200);
    assert.equal(publicWorkshopMessage.payload.postedMessage.agentId, workshopAgentId);
    assert.equal(publicWorkshopMessage.payload.postedMessage.threadId, "eventlog_public_workshop_auth_smoke");
    assert.equal(publicWorkshopMessage.payload.postedMessage.batchTxHash, undefined);
    assert.equal(publicWorkshopMessage.payload.workshopTrace.workshopId, "workflow_public_workshop_auth_smoke");
    assert.equal(publicWorkshopMessage.payload.workshopTrace.indexingStatus.visibleInWorkshopTrace, true);
    assert.equal(publicWorkshopMessage.payload.workshopTrace.indexingStatus.visibleInPublicAgentBoard, false);
    assert.match(publicWorkshopMessage.payload.workshopTrace.readUrls.messages, /\/api\/workshops\/workflow_public_workshop_auth_smoke\/messages$/);
    assert.match(publicWorkshopMessage.payload.workshopTrace.readUrls.state, /\/api\/workshops\/workflow_public_workshop_auth_smoke\/state$/);
    assert.match(publicWorkshopMessage.payload.workshopTrace.readUrls.message, /\/messages\/msg_/);

    const duplicateWorkshopMessage = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(workshopAgentId)}/messages`, {
      method: "POST",
      headers: {
        "x-santaclawz-workshop-token": publicWorkshopTicketClaim.payload.workshopAccessToken
      },
      body: JSON.stringify({
        messageType: "dispatch",
        body: "Workshop auth smoke: participant can publish a scoped coordination ping.",
        threadId: "eventlog_public_workshop_auth_smoke",
        swarmId: "workflow_public_workshop_auth_smoke",
        clientMessageId: "workshop-auth-smoke-transition-1",
        txHash: "5JworkshopReceiptTxSmoke001",
        topicTags: ["team-coordination"],
        proofIntent: "agent_chatter"
      })
    });
    assert.equal(duplicateWorkshopMessage.status, 200);
    assert.equal(duplicateWorkshopMessage.payload.idempotencyStatus, "duplicate-returned");
    assert.equal(duplicateWorkshopMessage.payload.postedMessage.messageId, publicWorkshopMessage.payload.postedMessage.messageId);
    assert.equal(duplicateWorkshopMessage.payload.postedMessage.batchTxHash, "5JworkshopReceiptTxSmoke001");

    const encryptedEnvelope = buildAgentMessageEnvelope({
      threadId: "eventlog_public_workshop_auth_smoke",
      swarmId: "workflow_public_workshop_auth_smoke",
      channelId: "general",
      kind: "dispatch",
      visibility: "recipient-encrypted",
      sender: { agentId: workshopAgentId },
      recipient: { agentId: workshopRecipientAgentId, publicKey: "recipient-key-smoke" },
      permissionScope: {
        lane: "team",
        allowedActions: ["encrypted-text"]
      },
      protocolLaneTags: ["team-coordination", "encrypted-text"],
      payload: {
        mode: "inline",
        mediaType: "text/plain+ciphertext",
        body: "ciphertext:workshop-smoke-private-message",
        encryption: {
          scheme: "x25519-sealed-box",
          recipientPublicKey: "recipient-key-smoke"
        }
      },
      zekoAnchor: {
        anchorMode: "aggregate"
      }
    });
    const workshopEnvelopePost = await requestJson(`${baseUrl}/api/workshop/envelopes`, {
      method: "POST",
      headers: {
        "x-santaclawz-workshop-token": publicWorkshopTicketClaim.payload.workshopAccessToken
      },
      body: JSON.stringify({
        agentId: workshopAgentId,
        envelope: encryptedEnvelope
      })
    });
    assert.equal(workshopEnvelopePost.status, 200);
    assert.equal(workshopEnvelopePost.payload.schemaVersion, "santaclawz-workshop-private-envelope-post/0.1");
    assert.equal(workshopEnvelopePost.payload.storedEnvelope.senderAgentId, workshopAgentId);
    assert.equal(workshopEnvelopePost.payload.storedEnvelope.channelId, "general");
    assert.equal(workshopEnvelopePost.payload.storedEnvelope.recipientAgentId, workshopRecipientAgentId);
    assert.equal(workshopEnvelopePost.payload.storedEnvelope.envelope.payload.body, "ciphertext:workshop-smoke-private-message");

    const workshopRecipientEnvelopeInbox = await requestJson(
      `${baseUrl}/api/workshop/envelopes?${new URLSearchParams({
        agentId: workshopRecipientAgentId,
        threadId: "eventlog_public_workshop_auth_smoke",
        channelId: "general",
        limit: "10"
      }).toString()}`,
      {
        method: "GET",
        headers: {
          "x-santaclawz-workshop-token": publicWorkshopRecipientTicketClaim.payload.workshopAccessToken
        }
      }
    );
    assert.equal(workshopRecipientEnvelopeInbox.status, 200);
    assert.equal(workshopRecipientEnvelopeInbox.payload.schemaVersion, "santaclawz-workshop-private-envelope-store/0.1");
    assert.equal(workshopRecipientEnvelopeInbox.payload.totalEnvelopeCount, 1);
    assert.equal(workshopRecipientEnvelopeInbox.payload.envelopes[0].envelopeId, encryptedEnvelope.messageId);

    const memberAdminChannelEnvelope = buildAgentMessageEnvelope({
      threadId: "eventlog_public_workshop_auth_smoke",
      swarmId: "workflow_public_workshop_auth_smoke",
      channelId: "admin",
      kind: "dispatch",
      visibility: "recipient-encrypted",
      sender: { agentId: workshopRecipientAgentId },
      permissionScope: {
        lane: "team",
        allowedActions: ["encrypted-text"]
      },
      protocolLaneTags: ["team-coordination", "encrypted-text", "channel:admin"],
      payload: {
        mode: "inline",
        mediaType: "text/plain+ciphertext",
        body: "ciphertext:member-should-not-post-admin-channel",
        encryption: {
          scheme: "custom"
        }
      },
      zekoAnchor: {
        anchorMode: "aggregate"
      }
    });
    const memberAdminChannelPost = await requestJson(`${baseUrl}/api/workshop/envelopes`, {
      method: "POST",
      headers: {
        "x-santaclawz-workshop-token": publicWorkshopRecipientTicketClaim.payload.workshopAccessToken
      },
      body: JSON.stringify({
        agentId: workshopRecipientAgentId,
        envelope: memberAdminChannelEnvelope
      })
    });
    assert.equal(memberAdminChannelPost.status, 400);
    assert.match(memberAdminChannelPost.payload.error, /channel/i);

    const workshopPublicThread = await requestJson(
      `${baseUrl}/api/agent-messages?threadId=${encodeURIComponent("eventlog_public_workshop_auth_smoke")}&limit=10`,
      { method: "GET" }
    );
    assert.equal(workshopPublicThread.status, 200);
    assert.equal(workshopPublicThread.payload.messages.some((message) => message.body.includes("ciphertext:workshop-smoke-private-message")), false);
    assert.equal(workshopPublicThread.payload.messages.some((message) => message.threadId === "eventlog_public_workshop_auth_smoke"), false);

    const workshopTraceMessages = await requestJson(
      `${baseUrl}/api/workshops/${encodeURIComponent("workflow_public_workshop_auth_smoke")}/messages?limit=10`,
      { method: "GET" }
    );
    assert.equal(workshopTraceMessages.status, 200);
    assert.equal(workshopTraceMessages.payload.schemaVersion, "santaclawz-workshop-messages/0.1");
    assert.equal(workshopTraceMessages.payload.workshopId, "workflow_public_workshop_auth_smoke");
    assert.equal(workshopTraceMessages.payload.totalMessageCount, 1);
    assert.equal(workshopTraceMessages.payload.messages[0].messageId, publicWorkshopMessage.payload.postedMessage.messageId);
    assert.equal(workshopTraceMessages.payload.messages[0].batchTxHash, "5JworkshopReceiptTxSmoke001");
    assert.equal(workshopTraceMessages.payload.state.stateVersion, 1);
    assert.equal(workshopTraceMessages.payload.state.lastMessageId, publicWorkshopMessage.payload.postedMessage.messageId);
    assert.equal(workshopTraceMessages.payload.state.publicDisclosure, "workshop-public-actions-only");
    assert.equal(workshopTraceMessages.payload.state.anchorCompleteness.expectedCheckpointCount, 0);
    assert.equal(workshopTraceMessages.payload.state.anchorCompleteness.allConfirmed, false);

    const workshopReceiptLedger = await requestJson(
      `${baseUrl}/api/workshop/receipt-ledger?threadId=${encodeURIComponent("eventlog_public_workshop_auth_smoke")}&limit=10`,
      { method: "GET" }
    );
    assert.equal(workshopReceiptLedger.status, 200);
    assert.equal(workshopReceiptLedger.payload.receipts[0].receiptId, publicWorkshopMessage.payload.postedMessage.messageId);
    assert.equal(workshopReceiptLedger.payload.receipts[0].batchTxHash, "5JworkshopReceiptTxSmoke001");

    const workshopTraceState = await requestJson(
      `${baseUrl}/api/workshops/${encodeURIComponent("workflow_public_workshop_auth_smoke")}/state`,
      { method: "GET" }
    );
    assert.equal(workshopTraceState.status, 200);
    assert.equal(workshopTraceState.payload.schemaVersion, "santaclawz-workshop-state/0.1");
    assert.equal(workshopTraceState.payload.stateVersion, 1);
    assert.equal(workshopTraceState.payload.lastTransitionDigest, publicWorkshopMessage.payload.postedMessage.messageDigestSha256);
    assert.equal(workshopTraceState.payload.anchorCompleteness.expectedCheckpointCount, 0);
    assert.deepEqual(workshopTraceState.payload.anchorCompleteness.missingCandidateIds, []);

    const directWorkshopMessage = await requestJson(
      `${baseUrl}/api/workshops/${encodeURIComponent("workflow_public_workshop_auth_smoke")}/messages/${encodeURIComponent(publicWorkshopMessage.payload.postedMessage.messageId)}`,
      { method: "GET" }
    );
    assert.equal(directWorkshopMessage.status, 200);
    assert.equal(directWorkshopMessage.payload.totalMessageCount, 1);
    assert.equal(directWorkshopMessage.payload.messages[0].messageId, publicWorkshopMessage.payload.postedMessage.messageId);

    const publicWorkshopWrongThread = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(workshopAgentId)}/messages`, {
      method: "POST",
      headers: {
        "x-santaclawz-workshop-token": publicWorkshopTicketClaim.payload.workshopAccessToken
      },
      body: JSON.stringify({
        messageType: "dispatch",
        body: "This scoped workshop token should not post outside its thread.",
        threadId: "eventlog_wrong_thread",
        swarmId: "workflow_public_workshop_auth_smoke",
        topicTags: ["team-coordination"],
        proofIntent: "agent_chatter"
      })
    });
    assert.equal(publicWorkshopWrongThread.status, 400);
    assert.match(publicWorkshopWrongThread.payload.error, /workshop thread/i);

    const publicWorkshopTicketClaimedStatus = await requestJson(
      `${baseUrl}/api/workshop/setup-tickets/${encodeURIComponent(publicWorkshopTicket.payload.ticketId)}/status?${new URLSearchParams({ ticket: publicWorkshopTicket.payload.ticket }).toString()}`,
      { method: "GET" }
    );
    assert.equal(publicWorkshopTicketClaimedStatus.status, 200);
    assert.equal(publicWorkshopTicketClaimedStatus.payload.claimedCount, 2);
    assert.ok(publicWorkshopTicketClaimedStatus.payload.claimedAgentsById[workshopAgentId]);

    const tokenStateAccess = await requestJson(`${baseUrl}/api/executions/hire_missing/state?token=fake`, {
      method: "GET"
    });
    assert.notEqual(tokenStateAccess.status, 401);

    const lateCompletionMissingAdmin = await requestJson(`${baseUrl}/api/executions/hire_missing/late-completion`, {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(lateCompletionMissingAdmin.status, 401);
    assert.equal(lateCompletionMissingAdmin.payload.code, "admin_key_required");

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
    CLAWZ_PUBLIC_ONBOARDING: "true",
    CLAWZ_ACTIVATION_LANE_TOKEN: "test_activation_lane_token"
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

    const activationCandidatesMissingToken = await requestJson(`${baseUrl}/api/activation-lane/candidates`, {
      method: "GET"
    });
    assert.equal(activationCandidatesMissingToken.status, 401);
    assert.equal(activationCandidatesMissingToken.payload.code, "activation_lane_auth_required");

    const activationCandidatesWithLaneToken = await requestJson(`${baseUrl}/api/activation-lane/candidates`, {
      method: "GET",
      headers: {
        "x-santaclawz-activation-lane-key": "test_activation_lane_token"
      }
    });
    assert.equal(activationCandidatesWithLaneToken.status, 200);
    assert.equal(activationCandidatesWithLaneToken.payload.lane, "activation_lane");

    const publicPaymentState = await requestJson(
      `${baseUrl}/api/x402/payment-state?paymentPayloadDigestSha256=${"a".repeat(64)}`
    );
    assert.equal(publicPaymentState.status, 200);
    assert.equal(publicPaymentState.payload.schemaVersion, "santaclawz-x402-payment-state/1.0");
    assert.equal(publicPaymentState.payload.redacted, true);
    assert.equal(publicPaymentState.payload.retryResume.safeToCreateNewPayment, false);

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

async function testPublicBrowseLimitsDoNotStarveX402Preflight() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-public-read-class-test-"));
  const port = await reservePort();
  const server = startServer(workspaceDir, port, {
    CLAWZ_REQUIRE_API_AUTH: "false",
    CLAWZ_PUBLIC_ONBOARDING: "true",
    CLAWZ_PUBLIC_READ_RATE_LIMIT_MAX_COST: "60",
    CLAWZ_PUBLIC_READ_FIRST_PARTY_RATE_LIMIT_MAX_COST: "60",
    CLAWZ_PUBLIC_READ_CACHE_TTL_MS: "0",
    CLAWZ_PAYMENT_LEDGER_CACHE_TTL_MS: "0"
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);
    const headers = {
      "x-forwarded-for": "203.0.113.44",
      "user-agent": "node"
    };

    const browseOne = await requestJson(`${baseUrl}/api/console/state`, { headers });
    assert.equal(browseOne.status, 200);
    const browseTwo = await requestJson(`${baseUrl}/api/console/state`, { headers });
    assert.equal(browseTwo.status, 200);
    const browseLimited = await requestJson(`${baseUrl}/api/console/state`, { headers });
    assert.equal(browseLimited.status, 429);
    assert.equal(browseLimited.payload.code, "public_read_rate_limited");
    assert.equal(browseLimited.payload.rateLimitClass, "browse");

    const x402Plan = await requestJson(`${baseUrl}/api/agents/not-yet-registered/x402-plan`, { headers });
    assert.notEqual(x402Plan.status, 429);
    assert.notEqual(x402Plan.payload?.code, "public_read_rate_limited");

    const scopedConsoleState = await requestJson(`${baseUrl}/api/console/state?agentId=not-yet-registered`, { headers });
    assert.notEqual(scopedConsoleState.status, 429);
    assert.notEqual(scopedConsoleState.payload?.code, "public_read_rate_limited");

    console.log("ok - public browse limits do not starve x402 preflight reads");
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

async function testMarketplaceTagsExposeDiscoveryAndSearch() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-marketplace-tags-test-"));
  const port = await reservePort();
  const server = startServer(workspaceDir, port, {
    CLAWZ_PUBLIC_PROOF_SURFACE: "discovery-only",
    CLAWZ_PUBLIC_ONBOARDING: "true"
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);

    const registered = await requestJson(`${baseUrl}/api/console/register`, {
      method: "POST",
      body: JSON.stringify({
        agentName: "Tagged Marketplace Agent",
        headline: "Finds repo security issues and returns markdown.",
        openClawUrl: "http://127.0.0.1:49994/agent",
        marketplaceTags: {
          capabilities: ["Repo Review", "Security Review"],
          outputTypes: ["Markdown"]
        }
      })
    });
    assert.equal(registered.status, 200);
    const sessionId = registered.payload.session.sessionId;
    const agentId = registered.payload.agentId;
    const adminKey = registered.payload.adminAccess.issuedAdminKey;

    const listed = await requestJson(`${baseUrl}/api/agents`);
    assert.equal(listed.status, 200);
    const listedAgent = listed.payload.find((agent) => agent.agentId === agentId);
    assert.ok(listedAgent);
    assert.deepEqual(listedAgent.marketplaceTags.capabilities, ["repo-review", "security-review"]);
    assert.deepEqual(listedAgent.marketplaceTags.outputTypes, ["markdown"]);

    const anchors = await requestJson(`${baseUrl}/api/social/anchors?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: {
        "x-clawz-admin-key": adminKey
      }
    });
    assert.equal(anchors.status, 200);
    assert.equal(anchors.payload.items.some((item) => item.kind === "marketplace-tags-declared"), true);

    const searched = await requestJson(`${baseUrl}/api/agents/search?tag=repo%20review`);
    assert.equal(searched.status, 200);
    assert.equal(searched.payload.agents.some((agent) => agent.agentId === agentId), true);

    const partialUpdate = await requestJson(`${baseUrl}/api/console/profile?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: {
        "x-clawz-admin-key": adminKey
      },
      body: JSON.stringify({
        marketplaceTags: {
          outputTypes: ["Artifact Bundle"]
        }
      })
    });
    assert.equal(partialUpdate.status, 200);
    assert.deepEqual(partialUpdate.payload.profile.marketplaceTags.capabilities, ["repo-review", "security-review"]);
    assert.deepEqual(partialUpdate.payload.profile.marketplaceTags.outputTypes, ["artifact-bundle"]);

    console.log("ok - marketplace tags expose profile discovery and preserve partial updates");
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

    const publicAnchors = await requestJson(`${baseUrl}/api/social/anchors/public?limit=50`, {
      method: "GET"
    });
    assert.equal(publicAnchors.status, 200);
    assert.equal(publicAnchors.payload.items.every((item) => item.status === "confirmed"), true);
    assert.ok(publicAnchors.payload.items.some((item) => item.candidateId === confirmedItem?.candidateId));

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
    const publicAnchorCandidate = await requestJson(
      `${baseUrl}/api/social/anchors/${encodeURIComponent(postedMessage.anchorCandidateId)}`,
      { method: "GET" }
    );
    assert.equal(publicAnchorCandidate.status, 200);
    assert.equal(publicAnchorCandidate.payload.candidateId, postedMessage.anchorCandidateId);
    assert.equal(publicAnchorCandidate.payload.status, "pending");
    assert.equal(publicAnchorCandidate.payload.payloadDigestSha256.length, 64);

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
    const originalAnchorCandidate = queueFile.items.find((item) => item.candidateId === postedMessage.anchorCandidateId);
    assert.ok(originalAnchorCandidate);
    queueFile.items = queueFile.items.filter((item) => item.candidateId !== postedMessage.anchorCandidateId);
    await writeFile(queuePath, JSON.stringify(queueFile, null, 2));
    const reconciledBoard = await requestJson(
      `${baseUrl}/api/agent-messages?agentId=${encodeURIComponent(agentId)}&outputDigest=${"a".repeat(64)}`
    );
    assert.equal(reconciledBoard.status, 200);
    assert.equal(reconciledBoard.payload.messages[0].anchorStatus, "pending");
    assert.equal(reconciledBoard.payload.messages[0].anchorFailureCode, undefined);

    const queueWithoutArchivedCandidate = JSON.parse(await readFile(queuePath, "utf8"));
    const recoveredBatchTime = new Date().toISOString();
    queueWithoutArchivedCandidate.archivedItems = (queueWithoutArchivedCandidate.archivedItems ?? []).filter(
      (item) => item.candidateId !== postedMessage.anchorCandidateId
    );
    queueWithoutArchivedCandidate.batches = [
      {
        batchId: "batch_recovered_from_candidate_ids",
        sessionId,
        agentId,
        anchorMode: "shared-batched",
        networkId: "zeko:testnet",
        itemCount: 1,
        candidateKinds: ["agent-message-posted"],
        rootDigestSha256: "c".repeat(64),
        status: "confirmed",
        createdAtIso: recoveredBatchTime,
        submittedAtIso: recoveredBatchTime,
        settledAtIso: recoveredBatchTime,
        confirmedAtIso: recoveredBatchTime,
        anchorField: "123",
        txHash: "5JrecoveredCandidateBatchTx",
        candidateIds: [postedMessage.anchorCandidateId]
      },
      ...queueWithoutArchivedCandidate.batches
    ];
    await writeFile(queuePath, JSON.stringify(queueWithoutArchivedCandidate, null, 2));
    const batchRecoveredBoard = await requestJson(
      `${baseUrl}/api/agent-messages?agentId=${encodeURIComponent(agentId)}&outputDigest=${"a".repeat(64)}&limit=2`
    );
    assert.equal(batchRecoveredBoard.status, 200);
    assert.equal(batchRecoveredBoard.payload.messages[0].anchorStatus, "confirmed");
    assert.equal(batchRecoveredBoard.payload.messages[0].anchorFailureCode, undefined);
    assert.equal(batchRecoveredBoard.payload.messages[0].batchRootDigestSha256, "c".repeat(64));
    assert.equal(batchRecoveredBoard.payload.messages[0].batchTxHash, "5JrecoveredCandidateBatchTx");

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
    CLAWZ_FREE_TEST_AGENT_HIRE_LIMIT_PER_10M: "1",
    CLAWZ_ACTIVATION_LANE_TOKEN: "test_activation_lane_token"
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
    assert.equal(paidReady.payload.readiness.hireable, false);
    assert.equal(paidReady.payload.readiness.paidExecutionProven, false);
    assert.deepEqual(paidReady.payload.readiness.upgradeReasons, ["paid-execution-not-proven"]);

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

    const activationCandidates = await requestJson(`${baseUrl}/api/activation-lane/candidates`, {
      headers: {
        authorization: "Bearer test_activation_lane_token"
      }
    });
    assert.equal(activationCandidates.status, 200);
    assert.equal(activationCandidates.payload.lane, "activation_lane");
    assert.equal(activationCandidates.payload.amountUsd, "0.002001");
    assert.equal(activationCandidates.payload.intervalSeconds, 30);
    assert.equal(
      activationCandidates.payload.candidates.some((candidate) => candidate.agentId === agentId),
      true
    );
    const paymentLedgerPath = path.join(workspaceDir, ".clawz-data", "state", "payment-ledger.json");
    await mkdir(path.dirname(paymentLedgerPath), { recursive: true });
    await writeFile(paymentLedgerPath, JSON.stringify({
      entries: [
        {
          ledgerId: "pay_activation_pending_test",
          createdAtIso: new Date().toISOString(),
          updatedAtIso: new Date().toISOString(),
          agentId,
          sessionId,
          resource: `${baseUrl}/api/activation-lane/agents/${encodeURIComponent(agentId)}/hire`,
          pricingMode: "fixed-exact",
          rail: "base-usdc",
          networkId: "testnet",
          assetSymbol: "USDC",
          amountUsd: "0.002001",
          transactionHashes: [],
          paymentStatus: "authorization_verified",
          executionStatus: "submitted",
          returnStatus: "none"
        }
      ]
    }, null, 2));
    const activationCandidatesWithPendingPayment = await requestJson(
      `${baseUrl}/api/activation-lane/candidates?agentId=${encodeURIComponent(agentId)}&includeDiagnostics=true`,
      {
        headers: {
          authorization: "Bearer test_activation_lane_token"
        }
      }
    );
    assert.equal(activationCandidatesWithPendingPayment.status, 200);
    assert.equal(activationCandidatesWithPendingPayment.payload.total, 0);
    assert.equal(
      activationCandidatesWithPendingPayment.payload.diagnostics.excludedAgents[0]?.exclusionReasons.includes(
        "activation-lane-payment-pending"
      ),
      true
    );
    await writeFile(paymentLedgerPath, JSON.stringify({ entries: [] }, null, 2));
    const activationCandidatesViaWorkerHeader = await requestJson(`${baseUrl}/api/activation-lane/candidates`, {
      headers: {
        "x-santaclawz-activation-lane-key": "test_activation_lane_token"
      }
    });
    assert.equal(activationCandidatesViaWorkerHeader.status, 200);
    assert.equal(activationCandidatesViaWorkerHeader.payload.candidates.length, activationCandidates.payload.candidates.length);

    const activationCandidatesWithBadToken = await requestJson(`${baseUrl}/api/activation-lane/candidates`, {
      headers: {
        "x-santaclawz-activation-lane-key": "wrong-token"
      }
    });
    assert.equal(activationCandidatesWithBadToken.status, 401);
    assert.equal(activationCandidatesWithBadToken.payload.code, "activation_lane_auth_required");

    const activationAttemptMissingToken = await requestJson(`${baseUrl}/api/activation-lane/attempts`, {
      method: "POST",
      body: JSON.stringify({
        agentId,
        sessionId,
        status: "preview_only"
      })
    });
    assert.equal(activationAttemptMissingToken.status, 401);
    assert.equal(activationAttemptMissingToken.payload.code, "activation_lane_auth_required");

    const activationAttempt = await requestJson(`${baseUrl}/api/activation-lane/attempts`, {
      method: "POST",
      headers: {
        "x-santaclawz-activation-lane-key": "test_activation_lane_token"
      },
      body: JSON.stringify({
        agentId,
        sessionId,
        status: "preview_only",
        classification: "payment",
        ok: false,
        mode: "payment_required_preview",
        httpStatus: 402,
        error: "missing hosted activation buyer key"
      })
    });
    assert.equal(activationAttempt.status, 200);
    assert.equal(activationAttempt.payload.ok, true);
    assert.equal(activationAttempt.payload.attempt.agentId, agentId);
    assert.equal(activationAttempt.payload.attempt.status, "preview_only");

    const readyAfterActivationAttempt = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/ready`);
    assert.equal(readyAfterActivationAttempt.status, 200);
    assert.equal(readyAfterActivationAttempt.payload.readiness.activationLaneStatus.totalAttemptCount, 1);
    assert.equal(readyAfterActivationAttempt.payload.readiness.activationLaneStatus.lastAttemptStatus, "preview_only");
    assert.equal(
      readyAfterActivationAttempt.payload.readiness.readinessNotes.some((note) => note.code === "activation_lane_preview_only"),
      true
    );

    const activationCandidatesAfterAttempt = await requestJson(`${baseUrl}/api/activation-lane/candidates`, {
      headers: {
        authorization: "Bearer test_activation_lane_token"
      }
    });
    assert.equal(
      activationCandidatesAfterAttempt.payload.candidates.some((candidate) => candidate.agentId === agentId),
      false
    );

    const activationCooldownDiagnostics = await requestJson(
      `${baseUrl}/api/activation-lane/candidates?agentId=${encodeURIComponent(agentId)}&includeDiagnostics=true`,
      {
        headers: {
          "x-santaclawz-activation-lane-key": "test_activation_lane_token"
        }
      }
    );
    assert.equal(activationCooldownDiagnostics.status, 200);
    assert.deepEqual(
      activationCooldownDiagnostics.payload.diagnostics.excludedAgents[0]?.exclusionReasons,
      ["activation-lane-cooldown"]
    );

    const unprovenPaidHire = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Should require a paid execution probe before payment.",
        requesterContact: "buyer@example.com"
      })
    });
    assert.equal(unprovenPaidHire.status, 409);
    assert.equal(unprovenPaidHire.payload.code, "paid_execution_probe_required");
    assert.equal(unprovenPaidHire.payload.paymentRequested, false);
    assert.deepEqual(unprovenPaidHire.payload.statusTags, ["Pending"]);
    assert.equal(unprovenPaidHire.payload.activationMethods.publicPaidProbe.amountUsd, "0.002001");

    const publicActivationProbePreflight = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        activationProbe: true,
        taskPrompt: "Public paid activation probe should return a tiny x402 challenge.",
        requesterContact: "buyer-activation-probe@example.com"
      })
    });
    assert.equal(publicActivationProbePreflight.status, 402);
    const publicActivationProbeChallenge = JSON.stringify(publicActivationProbePreflight.payload);
    assert.equal(publicActivationProbeChallenge.includes("2001"), true);
    assert.equal(publicActivationProbeChallenge.includes('"amountUnit":"atomic"'), true);

    const sellerReadinessTestPreflight = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        sellerReadinessTest: true,
        taskPrompt: "Seller readiness test should use the tiny x402 challenge.",
        requesterContact: "seller-readiness-test@example.com"
      })
    });
    assert.equal(sellerReadinessTestPreflight.status, 402);
    const sellerReadinessTestChallenge = JSON.stringify(sellerReadinessTestPreflight.payload);
    assert.equal(sellerReadinessTestChallenge.includes("2001"), true);
    assert.equal(sellerReadinessTestChallenge.includes('"amountUnit":"atomic"'), true);

    const provenPaidAgentHeartbeat = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/heartbeat`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({
        sessionId,
        status: "live",
        ttlSeconds: 60,
        relayAgentBuild: "server-api-test-build",
        paidExecutionProbe: {
          attempted: true,
          ok: true,
	          requestId: "probe_server_api_paid_ready",
	          packageVerified: true,
	          buyerDeliveryVerified: true,
	          returnStatus: "completed"
	        }
      })
    });
    assert.equal(provenPaidAgentHeartbeat.status, 200);
    assert.equal(provenPaidAgentHeartbeat.payload.paidExecutionProbe.provenBy, "heartbeat_probe");
    assert.equal(provenPaidAgentHeartbeat.payload.paidExecutionProbe.lastProvenBuild, "server-api-test-build");

    const firstCachedPlan = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/x402-plan`);
    assert.equal(firstCachedPlan.status, 200);
    assert.equal(firstCachedPlan.headers.get("x-santaclawz-cache"), "miss");
    assert.equal(firstCachedPlan.payload.heartbeatSafety.status, "fresh");
    const secondCachedPlan = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/x402-plan`);
    assert.equal(secondCachedPlan.status, 200);
    assert.equal(secondCachedPlan.headers.get("x-santaclawz-cache"), "hit");
    assert.equal(secondCachedPlan.payload.heartbeatSafety.status, "fresh");

    const heartbeatRefresh = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/heartbeat`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({
        sessionId,
        status: "live",
        ttlSeconds: 60,
        relayAgentBuild: "server-api-test-build-refreshed",
        paidExecutionProbe: {
          attempted: true,
          ok: true,
          requestId: "probe_server_api_paid_ready",
          packageVerified: true,
          buyerDeliveryVerified: true,
          returnStatus: "completed"
        }
      })
    });
    assert.equal(heartbeatRefresh.status, 200);
    const cachedPlanAfterHeartbeat = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/x402-plan`);
    assert.equal(cachedPlanAfterHeartbeat.status, 200);
    assert.equal(cachedPlanAfterHeartbeat.headers.get("x-santaclawz-cache"), "hit");
    assert.equal(cachedPlanAfterHeartbeat.payload.heartbeatSafety.status, "fresh");

    const runtimeHeartbeatPath = path.join(workspaceDir, ".clawz-data", "state", "agent-runtime-heartbeats.json");
    const heartbeatProbe = {
      attempted: true,
      ok: true,
      checkedAtIso: new Date().toISOString(),
      provenAtIso: new Date().toISOString(),
      provenBy: "heartbeat_probe",
      lastProvenBuild: "server-api-test-build",
      requestId: "probe_server_api_paid_ready",
      packageVerified: true,
      buyerDeliveryVerified: true,
      returnStatus: "completed"
    };
    await writeFile(runtimeHeartbeatPath, JSON.stringify({
      heartbeats: [
        {
          agentId,
          sessionId,
          status: "live",
          receivedAtIso: new Date(Date.now() - 8000).toISOString(),
          ttlSeconds: 10,
          note: "Near-stale heartbeat for paid preflight safety test.",
          paidExecutionProbe: heartbeatProbe
        }
      ]
    }, null, 2));
    const nearStalePlan = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/x402-plan`);
    assert.equal(nearStalePlan.status, 200);
    assert.equal(nearStalePlan.payload.heartbeatSafety.status, "stale_soon");
    assert.equal(nearStalePlan.payload.heartbeatSafety.paidPreflightSafe, false);
    assert.equal(nearStalePlan.payload.heartbeatSafety.minimumFreshMs, 20_000);
    assert.equal(nearStalePlan.payload.buyerPaymentState, "NO_PAYMENT_CREATED");
    assert.equal(nearStalePlan.payload.paymentRequested, false);
    assert.equal(nearStalePlan.payload.readiness.hireable, false);
    assert.equal(nearStalePlan.payload.readiness.blockers.includes("heartbeat-stale-soon"), true);
    assert.equal(nearStalePlan.payload.activationDecision.recommendedBuyerAction, "retry_plan_after_heartbeat");
    const nearStaleHire = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Should not request payment while heartbeat is near stale.",
        requesterContact: "buyer@example.com"
      })
    });
    assert.equal(nearStaleHire.status, 503);
    assert.equal(nearStaleHire.payload.code, "agent_runtime_unavailable_retryable");
    assert.equal(nearStaleHire.payload.buyerPaymentState, "NO_PAYMENT_CREATED");
    assert.equal(nearStaleHire.payload.paymentRequested, false);
    assert.equal(nearStaleHire.payload.safeToCreateNewPayment, false);
    assert.equal(nearStaleHire.payload.safeToRetryFreshPreflight, true);
    assert.equal(nearStaleHire.payload.heartbeatSafety.status, "stale_soon");
    await writeFile(runtimeHeartbeatPath, JSON.stringify({
      heartbeats: [
        {
          agentId,
          sessionId,
          status: "live",
          receivedAtIso: new Date().toISOString(),
          ttlSeconds: 60,
          note: "Fresh heartbeat restored after paid preflight safety test.",
          paidExecutionProbe: heartbeatProbe
        }
      ]
    }, null, 2));

    const activationDiagnostics = await requestJson(
      `${baseUrl}/api/activation-lane/candidates?agentId=${encodeURIComponent(agentId)}&includeDiagnostics=true`,
      {
        headers: {
          "x-santaclawz-activation-lane-key": "test_activation_lane_token"
        }
      }
    );
    assert.equal(activationDiagnostics.status, 200);
    assert.equal(activationDiagnostics.payload.total, 0);
    assert.equal(activationDiagnostics.payload.diagnostics.totalRegisteredMatching, 1);
    assert.equal(activationDiagnostics.payload.diagnostics.totalEligible, 0);
    assert.equal(
      activationDiagnostics.payload.diagnostics.excludedAgents[0]?.exclusionReasons.includes("paid-execution-already-proven"),
      true
    );

    const forcedActivationCandidates = await requestJson(
      `${baseUrl}/api/activation-lane/candidates?agentId=${encodeURIComponent(agentId)}&force=true`,
      {
        headers: {
          "x-santaclawz-activation-lane-key": "test_activation_lane_token"
        }
      }
    );
    assert.equal(forcedActivationCandidates.status, 200);
    assert.equal(forcedActivationCandidates.payload.candidates[0]?.agentId, agentId);
    assert.equal(forcedActivationCandidates.payload.candidates[0]?.reason, "manual-paid-smoke-requested");
    assert.equal(forcedActivationCandidates.payload.candidates[0]?.readiness.paidExecutionProvenBy, "heartbeat_probe");

    const unpaidPaidHire = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Should require x402 payment.",
        requesterContact: "buyer@example.com"
      })
    });
    assert.equal(unpaidPaidHire.status, 402);
    assert.equal(typeof unpaidPaidHire.payload, "object");
    assert.equal(unpaidPaidHire.payload.heartbeatSafety.status, "fresh");
    assert.equal(unpaidPaidHire.payload.heartbeatSafety.paidPreflightSafe, true);
    assert.equal(unpaidPaidHire.payload.heartbeatSafety.minimumFreshMs, 20_000);
    assert.equal(unpaidPaidHire.payload.buyerPaymentState, "PAYMENT_REQUIRED");
    assert.equal(unpaidPaidHire.payload.paymentRequested, true);
    const fixedPriceAccept = firstX402Accept(unpaidPaidHire.payload);
    assert.ok(fixedPriceAccept, JSON.stringify(unpaidPaidHire.payload));
    assert.equal(fixedPriceAccept.amount, "200000");
    assert.notEqual(fixedPriceAccept.amount, "0.20");

    const retryPaymentPayload = {
      protocol: "x402",
      networkId: "eip155:8453",
      settlementRail: "base-usdc",
      payTo: "0x0000000000000000000000000000000000000001",
      payload: {
        authorization: {
          value: "1"
        }
      }
    };
    const retryPaymentPayloadDigest = createHash("sha256").update(JSON.stringify(retryPaymentPayload)).digest("hex");
    const retryPaymentLedgerPath = path.join(workspaceDir, ".clawz-data", "state", "payment-ledger.json");
    await writeFile(retryPaymentLedgerPath, JSON.stringify({
      entries: [
        {
          ledgerId: "pay_existing_digest_retry_test",
          createdAtIso: new Date().toISOString(),
          updatedAtIso: new Date().toISOString(),
          agentId,
          sessionId,
          hireRequestId: "hire_existing_digest_retry_test",
          resource: `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`,
          pricingMode: "fixed-exact",
          rail: "base-usdc",
          networkId: "eip155:8453",
          assetSymbol: "USDC",
          amountUsd: "0.20",
          paymentPayloadDigestSha256: retryPaymentPayloadDigest,
          transactionHashes: [],
          paymentStatus: "authorization_verified",
          executionStatus: "submitted",
          returnStatus: "none"
        }
      ]
    }, null, 2), "utf8");
    const retryExistingDigest = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Retry an existing paid request digest without creating a fresh payment.",
        requesterContact: "buyer@example.com",
        paymentPayload: retryPaymentPayload
      })
    });
    assert.equal(retryExistingDigest.status, 202);
    assert.equal(retryExistingDigest.payload.code, "payment_payload_retry_failed_existing_state");
    assert.equal(retryExistingDigest.payload.paymentPayloadDigestSha256, retryPaymentPayloadDigest);
    assert.notEqual(retryExistingDigest.payload.operationalStatus.paymentStatus, "failed");
    assert.notEqual(retryExistingDigest.payload.operationalStatus.relayDeliveryStatus, "not_attempted");
    assert.equal(retryExistingDigest.payload.retryResume.safeToRetrySamePayload, false);
    assert.equal(retryExistingDigest.payload.retryResume.safeToCreateNewPayment, false);
    assert.match(retryExistingDigest.payload.paymentStateUrl, /paymentPayloadDigestSha256=/);

    const annotatedLedger = JSON.parse(await readFile(retryPaymentLedgerPath, "utf8"));
    annotatedLedger.entries[0].errorCode = "payment_payload_expired_for_retry";
    annotatedLedger.entries[0].errorMessage = "Payment payload is expired.";
    await writeFile(retryPaymentLedgerPath, JSON.stringify(annotatedLedger, null, 2), "utf8");
    const expiredPaymentState = await requestJson(
      `${baseUrl}/api/x402/payment-state?paymentPayloadDigestSha256=${retryPaymentPayloadDigest}`
    );
    assert.equal(expiredPaymentState.status, 200);
    assert.equal(expiredPaymentState.payload.retryResume.safeToRetrySamePayload, false);
    assert.equal(expiredPaymentState.payload.retryResume.safeToRetrySamePaymentPayload, false);
    assert.equal(expiredPaymentState.payload.retryResume.safeToCreateNewPayment, false);
    assert.equal(expiredPaymentState.payload.retryResume.paymentPayloadExpiredForRetry, true);
    assert.equal(expiredPaymentState.payload.retryResume.nextAction, "poll_execution_state");

    const expiredNoLedgerPaymentPayload = {
      ...retryPaymentPayload,
      paymentId: "pay_expired_no_ledger_test"
    };
    const expiredNoLedgerDigest = createHash("sha256").update(JSON.stringify(expiredNoLedgerPaymentPayload)).digest("hex");
    await writeFile(retryPaymentLedgerPath, JSON.stringify({
      entries: [
        {
          ledgerId: "pay_expired_no_ledger_test",
          createdAtIso: new Date().toISOString(),
          updatedAtIso: new Date().toISOString(),
          agentId,
          sessionId,
          resource: `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`,
          pricingMode: "fixed-exact",
          rail: "base-usdc",
          networkId: "eip155:8453",
          assetSymbol: "USDC",
          amountUsd: "0.20",
          paymentPayloadDigestSha256: expiredNoLedgerDigest,
          transactionHashes: [],
          paymentStatus: "not_settled",
          executionStatus: "not_started",
          returnStatus: "none",
          errorCode: "payment_payload_expired_no_ledger",
          errorMessage: "Payment payload is expired."
        }
      ]
    }, null, 2), "utf8");
    const expiredNoLedgerPaymentState = await requestJson(
      `${baseUrl}/api/x402/payment-state?paymentPayloadDigestSha256=${expiredNoLedgerDigest}`
    );
    assert.equal(expiredNoLedgerPaymentState.status, 200);
    assert.equal(expiredNoLedgerPaymentState.payload.protocolState, "EXPIRED_NO_CHARGE");
    assert.equal(expiredNoLedgerPaymentState.payload.buyerAction, "create_fresh_payment");
    assert.equal(expiredNoLedgerPaymentState.payload.sellerOutcome, "not_at_fault");
    assert.equal(expiredNoLedgerPaymentState.payload.retryResume.safeToRetrySamePayload, false);
    assert.equal(expiredNoLedgerPaymentState.payload.retryResume.safeToRetrySamePaymentPayload, false);
    assert.equal(expiredNoLedgerPaymentState.payload.retryResume.safeToCreateNewPayment, true);
    assert.equal(expiredNoLedgerPaymentState.payload.retryResume.terminal, true);
    assert.equal(expiredNoLedgerPaymentState.payload.retryResume.terminalReason, "payment_payload_expired_no_charge");
    assert.equal(expiredNoLedgerPaymentState.payload.retryResume.refundOrNoChargeStatus, "no_charge_authorization_expired");
    assert.equal(expiredNoLedgerPaymentState.payload.retryResume.paymentPayloadExpiredForRetry, true);
    await writeFile(retryPaymentLedgerPath, JSON.stringify({ entries: [] }, null, 2), "utf8");

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

    const contextRequired = await requestJson(`${baseUrl}/api/console/profile`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({
        sessionId,
        contextRequirements: {
          schemaVersion: "santaclawz-context-requirements/1.0",
          hardRequirements: [
            {
              key: "source-material",
              label: "Source material",
              anyOf: ["url", "document"],
              buyerMessage: "Provide a source URL or document before hiring this agent."
            }
          ]
        }
      })
    });
    assert.equal(contextRequired.status, 200);
    assert.equal(contextRequired.payload.profile.contextRequirements.hardRequirements[0].key, "source-material");

    const missingContext = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Quote this request without required buyer context.",
        requesterContact: "buyer@example.com"
      })
    });
    assert.equal(missingContext.status, 400);
    assert.equal(missingContext.payload.code, "missing_required_input");
    assert.equal(missingContext.payload.paymentRequested, false);
    assert.equal(missingContext.payload.operationalStatus.relayDeliveryStatus, "not_attempted");

    const accepted = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Quote this signed hire request.",
        requesterContact: "buyer@example.com",
        jobContext: {
          urls: ["https://example.com/source-brief"],
          text: "Use this as buyer-provided context for the quote."
        }
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
    assert.deepEqual(accepted.payload.jobContext.urls, ["https://example.com/source-brief"]);
    assert.equal(ingress.receivedHireRequests.get(accepted.payload.requestId).input.job_context.urls[0], "https://example.com/source-brief");

    const acceptedFromHostedUrl = await requestJson(`${baseUrl}/agent/${encodeURIComponent(agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Quote this from the hosted SantaClawz hire URL.",
        requesterContact: "buyer@example.com",
        jobContext: {
          attachments: [
            {
              kind: "document",
              url: "https://example.com/hosted-brief.pdf"
            }
          ]
        }
      })
    });
    assert.equal(acceptedFromHostedUrl.status, 200);
    assert.equal(acceptedFromHostedUrl.payload.requestType, "quote_intake");
    assert.equal(acceptedFromHostedUrl.payload.deliveryStatus, "forwarded");
    assert.equal(acceptedFromHostedUrl.payload.deliveryTarget, `https://santaclawz.ai/agent/${encodeURIComponent(agentId)}/hire`);
    assert.equal(ingress.receivedHireRequestIds.has(acceptedFromHostedUrl.payload.requestId), true);

    const contextRequirementCleared = await requestJson(`${baseUrl}/api/console/profile`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({
        sessionId,
        contextRequirements: {
          schemaVersion: "santaclawz-context-requirements/1.0",
          hardRequirements: []
        }
      })
    });
    assert.equal(contextRequirementCleared.status, 200);

    ingress.setNextProtocolReturnFactory(({ requestId }) => ({
      schema_version: "santaclawz-return/1.0",
      request_id: requestId,
      status: "quoted",
      agent_private: true,
      quote: {
        amount_usd: "0.42",
        currency: "USDC",
        expires_at_iso: "2099-01-01T00:00:00.000Z",
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
    assert.equal(artifactManifest.payload.artifactState.downloadStatus, "available");
    assert.equal(artifactManifest.payload.artifactState.buyerDigestVerificationRequired, true);
    assert.equal(artifactManifest.payload.artifact.transport.expectedDigestSha256, artifactUpload.payload.artifact.artifactBundleDigestSha256);
    assert.equal(artifactManifest.payload.artifact.transport.expectedBytes, artifactBody.length);

    const artifactStatus = await requestJson(
      artifactUpload.payload.artifact.artifactManifestUrl.replace("/manifest?", "/status?"),
      { method: "GET" }
    );
    assert.equal(artifactStatus.status, 200);
    assert.equal(artifactStatus.payload.artifactState.downloadStatus, "available");
    assert.equal(artifactStatus.payload.expectedDigestSha256, artifactUpload.payload.artifact.artifactBundleDigestSha256);
    assert.equal(artifactStatus.payload.expectedBytes, artifactBody.length);

    const artifactHead = await requestBytes(artifactUpload.payload.artifact.artifactDownloadUrl, { method: "HEAD" });
    assert.equal(artifactHead.status, 200);
    assert.equal(artifactHead.headers.get("content-length"), String(artifactBody.length));
    assert.equal(artifactHead.headers.get("accept-ranges"), "bytes");
    assert.equal(artifactHead.headers.get("x-santaclawz-artifact-digest-sha256"), artifactUpload.payload.artifact.artifactBundleDigestSha256);

    const artifactRange = await requestBytes(artifactUpload.payload.artifact.artifactDownloadUrl, {
      method: "GET",
      headers: { range: "bytes=0-2" }
    });
    assert.equal(artifactRange.status, 206);
    assert.equal(artifactRange.headers.get("content-range"), `bytes 0-2/${artifactBody.length}`);
    assert.deepEqual(artifactRange.body, artifactBody.subarray(0, 3));

    const artifactDownload = await requestBytes(artifactUpload.payload.artifact.artifactDownloadUrl, { method: "GET" });
    assert.equal(artifactDownload.status, 200);
    assert.equal(artifactDownload.headers.get("x-santaclawz-artifact-digest-sha256"), artifactUpload.payload.artifact.artifactBundleDigestSha256);
    assert.equal(artifactDownload.headers.get("x-santaclawz-artifact-bytes"), String(artifactBody.length));
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
    assert.equal(privateDownloadBlocked.payload.expectedDigestSha256, privateArtifactUpload.payload.artifact.artifactBundleDigestSha256);
    assert.equal(privateDownloadBlocked.payload.expectedBytes, encryptedBody.length);
    assert.equal(privateDownloadBlocked.payload.artifactState.downloadStatus, "buyer_scan_required");

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
      sellerExecutionCompleted: true,
      buyerComplete: true,
      buyerDeliveryAvailable: true,
      artifactDelivered: true,
      buyerVerified: true,
      buyerAccepted: true,
      failed: false,
      terminal: true,
      protocolTerminal: false
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
    assert.equal(liveAvailability.payload.heartbeat.status, "live");
    assert.match(liveAvailability.payload.heartbeat.reason, /relay websocket is fresh/i);
    assert.equal(liveAvailability.payload.readiness, undefined);

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
    assert.equal(staleAvailability.payload.readiness, undefined);
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
    assert.equal(hire.payload.deliveryReceipt.errorCode, "relay_worker_ack_timeout");
    assert.match(hire.payload.deliveryReceipt.target, /^santaclawz-relay:\/\//);
    assert.match(hire.payload.deliveryError, /worker acknowledgement|relay response|Relay connection/);
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
    assert.match(hire.payload.jobWorkspace.statePath, /\/api\/executions\/hire_/);

    const relayFailureDigest = "9".repeat(64);
    const relayFailurePaymentLedgerPath = path.join(workspaceDir, ".clawz-data", "state", "payment-ledger.json");
    await writeFile(relayFailurePaymentLedgerPath, JSON.stringify({
      entries: [
        {
          ledgerId: "pay_relay_failed_before_worker_ack",
          createdAtIso: new Date().toISOString(),
          updatedAtIso: new Date().toISOString(),
          agentId,
          sessionId,
          x402RequestId: "req_relay_failed_before_worker_ack",
          hireRequestId: hire.payload.requestId,
          resource: `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`,
          pricingMode: "fixed-exact",
          rail: "base-usdc",
          networkId: "eip155:8453",
          assetSymbol: "USDC",
          amountUsd: "0.25",
          paymentPayloadDigestSha256: relayFailureDigest,
          transactionHashes: [],
          paymentStatus: "authorization_verified",
          executionStatus: "failed",
          returnStatus: "none",
          errorCode: "relay_delivery_failed_before_worker_ack",
          errorMessage: "Relay delivery failed before worker acknowledgement."
        }
      ]
    }, null, 2), "utf8");
    const relayFailurePaymentState = await requestJson(
      `${baseUrl}/api/x402/payment-state?paymentPayloadDigestSha256=${relayFailureDigest}`
    );
    assert.equal(relayFailurePaymentState.status, 200);
    assert.equal(relayFailurePaymentState.payload.protocolState, "PLATFORM_FAILED_NO_SETTLEMENT");
    assert.equal(relayFailurePaymentState.payload.buyerAction, "create_fresh_payment");
    assert.equal(relayFailurePaymentState.payload.sellerOutcome, "not_at_fault");
    assert.equal(relayFailurePaymentState.payload.operatorObligation, "none");
    assert.equal(relayFailurePaymentState.payload.retryResume.safeToRetrySamePayload, false);
    assert.equal(relayFailurePaymentState.payload.retryResume.safeToCreateNewPayment, true);
    assert.match(relayFailurePaymentState.payload.retryResume.guidance, /terminal no-charge/);
    const relayFailureExecutionState = await requestJson(`${baseUrl}${hire.payload.jobWorkspace.statePath}`);
    assert.equal(relayFailureExecutionState.status, 200);
    assert.equal(relayFailureExecutionState.payload.protocolState, "PLATFORM_FAILED_NO_SETTLEMENT");
    assert.equal(relayFailureExecutionState.payload.sellerOutcome, "not_at_fault");
    assert.equal(relayFailureExecutionState.payload.lifecycle.sellerReputationImpact, "none");

    const lateReturn = {
      schema_version: "santaclawz-return/1.0",
      request_id: hire.payload.requestId,
      status: "completed",
      agent_private: true,
      real_work_executed: true,
      buyer_visible: true,
      verified_output: {
        package_hash: "a".repeat(64),
        hash_algorithm: "sha256",
        verification_manifest: {
          input_digest_sha256: "b".repeat(64),
          checks_performed: ["worker_completed", "late_completion_reconciled"],
          files_produced: ["late-result.md"],
          blocked_suspicious_instructions: []
        },
	        deliverables: [{ name: "late-result.md", sha256: "c".repeat(64) }],
	        buyer_visible_outputs: [
	          {
	            name: "late-result.md",
	            content_type: "text/markdown",
	            text: "Late result reconciled for the buyer.",
	            sha256: "d".repeat(64)
	          }
	        ]
	      }
	    };
    const lateCompletion = await requestJson(`${baseUrl}/api/executions/${encodeURIComponent(hire.payload.requestId)}/late-completion`, {
      method: "POST",
      headers: { "x-clawz-admin-key": adminKey },
      body: JSON.stringify({
        statusCode: 200,
        bodyBase64: Buffer.from(JSON.stringify(lateReturn), "utf8").toString("base64"),
        bodyEncoding: "base64",
        relayMessageId: "relay_late_test"
      })
    });
    assert.equal(lateCompletion.status, 200);
    assert.equal(lateCompletion.payload.status, "completed");
    assert.equal(lateCompletion.payload.operationalStatus.relayDeliveryStatus, "forwarded");
    assert.equal(lateCompletion.payload.operationalStatus.agentExecutionStatus, "completed");

    const recoveredState = await requestJson(`${baseUrl}${hire.payload.jobWorkspace.statePath}`);
    assert.equal(recoveredState.status, 200);
    assert.equal(recoveredState.payload.ids.hireRequestId, hire.payload.requestId);
    assert.equal(recoveredState.payload.ids.executionRequestId, hire.payload.requestId);
    assert.match(recoveredState.payload.stateUrl, new RegExp(`/api/executions/${hire.payload.requestId}/state`));
    assert.equal(recoveredState.payload.lifecycle.agentExecutionStatus, "completed");
    assert.equal(recoveredState.payload.lifecycle.relayDeliveryStatus, "forwarded");
    assert.equal(recoveredState.payload.lifecycle.sellerExecutionCompleted, true);
	    assert.equal(recoveredState.payload.lifecycle.buyerCompletionStatus, "buyer_complete");
    assert.equal(recoveredState.payload.lifecycle.platformReconciliationStatus, "seller_return_recorded");
	    assert.equal(recoveredState.payload.lifecycle.sellerReputationImpact, "none");
    assert.equal(recoveredState.payload.lifecycle.buyerVisibleInlineOutputCount, 1);
    assert.equal(recoveredState.payload.lifecycle.buyerDownloadableArtifactCount, 0);
    assert.equal(recoveredState.payload.lifecycle.artifactReceiptCount, 0);
    assert.equal(recoveredState.payload.lifecycle.verifiedOutputDeliverableCount, 1);
    assert.equal(recoveredState.payload.lifecycle.filesProducedCount, 1);
    assert.equal(recoveredState.payload.lifecycle.internalPackageOnly, true);
    assert.equal(recoveredState.payload.partyFinality.buyerTerminal, true);
    assert.equal(recoveredState.payload.partyFinality.sellerTerminal, true);
    assert.equal(recoveredState.payload.lifecycleChecks.failed, false);
	    assert.equal(recoveredState.payload.lifecycleChecks.terminal, false);
    assert.equal(
      recoveredState.payload.relayTrace.some((entry) => entry.step === "worker_completed" && entry.status === "completed"),
      true
    );
    assert.equal(
      recoveredState.payload.relayTrace.some((entry) => entry.step === "worker_completed" && entry.status === "not_reached"),
      false
    );
    const relayFailureRecoveredPaymentState = await requestJson(
      `${baseUrl}/api/x402/payment-state?paymentPayloadDigestSha256=${relayFailureDigest}`
    );
    assert.equal(relayFailureRecoveredPaymentState.status, 200);
    assert.equal(relayFailureRecoveredPaymentState.payload.protocolState, "DELIVERED_AWAITING_SETTLEMENT");
    assert.notEqual(relayFailureRecoveredPaymentState.payload.projectionSource, "hit");
    assert.equal(relayFailureRecoveredPaymentState.payload.buyerAction, "view_delivery");
    assert.equal(relayFailureRecoveredPaymentState.payload.sellerOutcome, "completed");
    assert.equal(relayFailureRecoveredPaymentState.payload.operatorObligation, "settle_payment");
    assert.equal(relayFailureRecoveredPaymentState.payload.payment.latestLedger.executionStatus, "completed");
    assert.equal(relayFailureRecoveredPaymentState.payload.payment.latestLedger.returnStatus, "accepted");
    assert.equal(relayFailureRecoveredPaymentState.payload.payment.latestLedger.paymentStatus, "execution_completed");
    assert.equal(relayFailureRecoveredPaymentState.payload.retryResume.safeToCreateNewPayment, false);
    assert.equal(relayFailureRecoveredPaymentState.payload.retryResume.safeToRetrySamePayload, false);

    const deliveredAwaitingSettlementPayload = {
      protocol: "x402",
      nonce: "delivered-awaiting-settlement-test"
    };
    const deliveredAwaitingSettlementDigest = createHash("sha256")
      .update(JSON.stringify(deliveredAwaitingSettlementPayload))
      .digest("hex");
    const deliveredPaymentLedgerPath = path.join(workspaceDir, ".clawz-data", "state", "payment-ledger.json");
    const deliveredPaymentLedgerEntry = {
      ledgerId: "pay_delivered_awaiting_settlement_test",
      createdAtIso: new Date().toISOString(),
      updatedAtIso: new Date().toISOString(),
      agentId,
      sessionId,
      x402RequestId: "req_delivered_awaiting_settlement_test",
      hireRequestId: hire.payload.requestId,
      resource: `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`,
      pricingMode: "fixed-exact",
      rail: "base-usdc",
      networkId: "eip155:8453",
      assetSymbol: "USDC",
      amountUsd: "0.25",
      paymentPayloadDigestSha256: deliveredAwaitingSettlementDigest,
      transactionHashes: [],
      paymentStatus: "authorization_verified",
      executionStatus: "completed",
      returnStatus: "accepted"
    };
    await writeFile(deliveredPaymentLedgerPath, JSON.stringify({
      entries: [deliveredPaymentLedgerEntry]
    }, null, 2), "utf8");
    const deliveredPaymentState = await requestJson(
      `${baseUrl}/api/x402/payment-state?paymentPayloadDigestSha256=${deliveredAwaitingSettlementDigest}`
    );
    assert.equal(deliveredPaymentState.status, 200);
    assert.equal(deliveredPaymentState.payload.stateFreshness, "fresh");
    assert.equal(deliveredPaymentState.payload.projectionSource, "miss");
    assert.equal(deliveredPaymentState.payload.protocolState, "DELIVERED_AWAITING_SETTLEMENT");
    assert.equal(deliveredPaymentState.payload.buyerAction, "view_delivery");
    assert.equal(deliveredPaymentState.payload.operatorObligation, "settle_payment");
    assert.equal(deliveredPaymentState.payload.buyerWorkStatus, "delivered");
    assert.equal(deliveredPaymentState.payload.sellerWorkStatus, "completed");
    assert.equal(deliveredPaymentState.payload.buyerPaymentAction, "do_not_pay_poll_or_settle_same_payload");
    assert.equal(deliveredPaymentState.payload.platformSettlementStatus, "pending_platform_settlement");
    assert.equal(deliveredPaymentState.payload.freshPaymentForbidden, true);
    assert.equal(deliveredPaymentState.payload.paymentPayloadCreated, true);
    assert.equal(deliveredPaymentState.payload.paymentPayloadSubmitted, true);
    assert.equal(deliveredPaymentState.payload.paymentAuthorized, true);
    assert.equal(deliveredPaymentState.payload.deliveryFinality, "delivered");
    assert.equal(deliveredPaymentState.payload.settlementFinality, "pending");
    assert.equal(deliveredPaymentState.payload.settlementOwner, "platform");
    assert.equal(deliveredPaymentState.payload.settlementTelemetry.status, "pending_platform_settlement");
    assert.equal(deliveredPaymentState.payload.settlementTelemetry.owner, "platform");
    assert.equal(deliveredPaymentState.payload.settlementTelemetry.settlementRequired, true);
    assert.equal(deliveredPaymentState.payload.settlementTelemetry.samePayloadSettlementAvailable, true);
    assert.equal(deliveredPaymentState.payload.settlementTelemetry.retryable, false);
    assert.equal(deliveredPaymentState.payload.settlementTelemetry.retryableFailure, false);
    assert.equal(deliveredPaymentState.payload.settlementTelemetry.nextAction, "poll_payment_state");
    assert.equal(deliveredPaymentState.payload.settlementTelemetry.freshPaymentForbidden, true);
    assert.equal(deliveredPaymentState.payload.settlementTelemetry.recommendedPollAfterMs, 2000);
    assert.equal(deliveredPaymentState.payload.protocolLifecycle.operatorAnswer.operatorActionRequired, true);
    assert.equal(deliveredPaymentState.payload.protocolLifecycle.operatorAnswer.reconciliationRequired, false);
    assert.equal(deliveredPaymentState.payload.protocolLifecycle.operatorAnswer.operatorReconciliationRequired, false);
    assert.equal(deliveredPaymentState.payload.paymentFinality, "pending");
    assert.equal(deliveredPaymentState.payload.paymentFinalityPending, true);
    assert.equal(deliveredPaymentState.payload.statePollingRequired, true);
    assert.equal(deliveredPaymentState.payload.recommendedPollAfterMs, 2000);
    assert.equal(deliveredPaymentState.payload.sourceFreshness.paymentStateCanonicalForRetrySafety, true);
    assert.equal(typeof deliveredPaymentState.payload.stateProjectionUpdatedAtIso, "string");
    assert.equal(deliveredPaymentState.payload.retryResume.nextAction, "view_delivery");
    assert.equal(deliveredPaymentState.payload.retryResume.safeToRetrySamePayload, false);
    assert.equal(deliveredPaymentState.payload.retryResume.safeToCreateNewPayment, false);
    assert.equal(deliveredPaymentState.payload.retryResume.settlementRecovery.action, "complete_settlement_same_payload");
    assert.equal(deliveredPaymentState.payload.retryResume.settlementRecovery.status, "pending_settlement");
    assert.equal(deliveredPaymentState.payload.retryResume.settlementRecovery.requiresOriginalPaymentPayload, true);
    assert.equal(deliveredPaymentState.payload.retryResume.settlementRecovery.doNotCreateNewPayment, true);
    assert.equal(deliveredPaymentState.payload.retryResume.settlementRecovery.freshPaymentForbidden, true);
    assert.equal(deliveredPaymentState.payload.retryResume.settlementRecovery.settlementOwner, "platform");
    assert.equal(deliveredPaymentState.payload.retryResume.settlementRecovery.settlementQueued, true);
    assert.equal(deliveredPaymentState.payload.retryResume.settlementRecovery.buyerAction, "view_delivery");
    assert.match(
      deliveredPaymentState.payload.retryResume.settlementRecovery.retryEndpoint,
      /\/api\/x402\/settlement-retry\?ledgerId=pay_delivered_awaiting_settlement_test/
    );
    const deliveredPaymentStateByLedgerId = await requestJson(
      `${baseUrl}/api/x402/payment-state?ledgerId=pay_delivered_awaiting_settlement_test`
    );
    assert.equal(deliveredPaymentStateByLedgerId.status, 200);
    assert.equal(deliveredPaymentStateByLedgerId.payload.protocolState, "DELIVERED_AWAITING_SETTLEMENT");
    assert.equal(deliveredPaymentStateByLedgerId.payload.lookup.ledgerId, "pay_delivered_awaiting_settlement_test");
    assert.equal(deliveredPaymentStateByLedgerId.payload.payment.ledgerEntryCount, 1);
    assert.equal(deliveredPaymentStateByLedgerId.payload.buyerWorkStatus, "delivered");
    assert.equal(deliveredPaymentStateByLedgerId.payload.sellerWorkStatus, "completed");
    assert.equal(deliveredPaymentStateByLedgerId.payload.freshPaymentForbidden, true);
    const deliveredPaymentStateCached = await requestJson(
      `${baseUrl}/api/x402/payment-state?paymentPayloadDigestSha256=${deliveredAwaitingSettlementDigest}`
    );
    assert.equal(deliveredPaymentStateCached.status, 200);
    assert.equal(deliveredPaymentStateCached.payload.protocolState, "DELIVERED_AWAITING_SETTLEMENT");
    assert.equal(deliveredPaymentStateCached.payload.stateFreshness, "fresh");
    assert.ok(["hit", "miss"].includes(deliveredPaymentStateCached.payload.projectionSource));
    assert.equal(deliveredPaymentStateCached.payload.retryResume.safeToCreateNewPayment, false);
    const deliveredSettlementMissingPayload = await requestJson(
      `${baseUrl}/api/x402/settlement-retry?ledgerId=pay_delivered_awaiting_settlement_test`,
      {
        method: "POST",
        body: JSON.stringify({})
      }
    );
    assert.equal(deliveredSettlementMissingPayload.status, 400);
    assert.equal(deliveredSettlementMissingPayload.payload.code, "payment_payload_required_for_settlement_retry");
    assert.equal(deliveredSettlementMissingPayload.payload.requiresOriginalPaymentPayload, true);
    assert.equal(deliveredSettlementMissingPayload.payload.doNotCreateNewPayment, true);
    assert.equal(deliveredSettlementMissingPayload.payload.expectedPaymentPayloadDigestSha256, deliveredAwaitingSettlementDigest);
    assert.equal("paymentState" in deliveredSettlementMissingPayload.payload, false);
    const deliveredSettlementWrongPayload = await requestJson(
      `${baseUrl}/api/x402/settlement-retry?ledgerId=pay_delivered_awaiting_settlement_test`,
      {
        method: "POST",
        body: JSON.stringify({
          paymentPayload: {
            protocol: "x402",
            nonce: "wrong-payload-for-delivered-awaiting-settlement-test"
          }
        })
      }
    );
    assert.equal(deliveredSettlementWrongPayload.status, 409);
    assert.equal(deliveredSettlementWrongPayload.payload.code, "settlement_retry_payload_digest_mismatch");
    assert.equal(deliveredSettlementWrongPayload.payload.requiresOriginalPaymentPayload, true);
    assert.equal(deliveredSettlementWrongPayload.payload.doNotCreateNewPayment, true);
    assert.equal(deliveredSettlementWrongPayload.payload.expectedPaymentPayloadDigestSha256, deliveredAwaitingSettlementDigest);
    assert.equal("paymentState" in deliveredSettlementWrongPayload.payload, false);
    await writeFile(deliveredPaymentLedgerPath, JSON.stringify({
      entries: [
        {
          ...deliveredPaymentLedgerEntry,
          updatedAtIso: new Date().toISOString(),
          paymentStatus: "settled",
          settlementStatus: "settled",
          sellerSettlementTxHash: "0xdeliveredawaitingsettlementalreadyrecorded",
          protocolFeeTxHash: "0xdeliveredawaitingsettlementfeerecorded",
          transactionHashes: [
            "0xdeliveredawaitingsettlementalreadyrecorded",
            "0xdeliveredawaitingsettlementfeerecorded"
          ]
        }
      ]
    }, null, 2), "utf8");
    const deliveredSettlementAlreadyRecorded = await requestJson(
      `${baseUrl}/api/x402/settlement-retry?ledgerId=pay_delivered_awaiting_settlement_test`,
      {
        method: "POST",
        body: JSON.stringify({ paymentPayload: deliveredAwaitingSettlementPayload })
      }
    );
    assert.equal(deliveredSettlementAlreadyRecorded.status, 200);
    assert.equal(deliveredSettlementAlreadyRecorded.payload.code, "settlement_already_recorded");
    assert.equal(deliveredSettlementAlreadyRecorded.payload.idempotentRecovery, true);
    assert.equal(deliveredSettlementAlreadyRecorded.payload.samePayloadReplayDetected, true);
    assert.equal(deliveredSettlementAlreadyRecorded.payload.duplicateChargeCreated, false);
    assert.equal(deliveredSettlementAlreadyRecorded.payload.protocolState, "DELIVERED_SETTLED");
    assert.equal(deliveredSettlementAlreadyRecorded.payload.paymentFinality, "settled");
    assert.equal(deliveredSettlementAlreadyRecorded.payload.paymentFinalityPending, false);
    assert.equal(deliveredSettlementAlreadyRecorded.payload.sellerSettlementTxHash, "0xdeliveredawaitingsettlementalreadyrecorded");
    assert.equal(deliveredSettlementAlreadyRecorded.payload.paymentState.protocolState, "DELIVERED_SETTLED");
    const deliveredPaymentStateAfterSettlementRetry = await requestJson(
      `${baseUrl}/api/x402/payment-state?paymentPayloadDigestSha256=${deliveredAwaitingSettlementDigest}`
    );
    assert.equal(deliveredPaymentStateAfterSettlementRetry.status, 200);
    assert.equal(deliveredPaymentStateAfterSettlementRetry.payload.protocolState, "DELIVERED_SETTLED");
    assert.ok(["hit", "miss"].includes(deliveredPaymentStateAfterSettlementRetry.payload.projectionSource));
    assert.equal(deliveredPaymentStateAfterSettlementRetry.payload.paymentFinality, "settled");
    assert.equal(deliveredPaymentStateAfterSettlementRetry.payload.paymentFinalityPending, false);
    assert.equal(deliveredPaymentStateAfterSettlementRetry.payload.buyerWorkStatus, "delivered");
    assert.equal(deliveredPaymentStateAfterSettlementRetry.payload.sellerWorkStatus, "completed");
    assert.equal(deliveredPaymentStateAfterSettlementRetry.payload.buyerPaymentAction, "none");
    assert.equal(deliveredPaymentStateAfterSettlementRetry.payload.platformSettlementStatus, "settled");
    assert.equal(deliveredPaymentStateAfterSettlementRetry.payload.freshPaymentForbidden, false);
    assert.equal(deliveredPaymentStateAfterSettlementRetry.payload.settlementFinality, "settled");
    assert.equal(deliveredPaymentStateAfterSettlementRetry.payload.settlementOwner, "none");
    assert.match(deliveredPaymentState.payload.retryResume.guidance, /Delivery is available/);
    assert.doesNotMatch(deliveredPaymentState.payload.retryResume.guidance, /Retry or resume/);
    assert.equal(deliveredPaymentState.payload.partyFinality.buyerTerminal, true);
    assert.equal(deliveredPaymentState.payload.partyFinality.sellerTerminal, true);
    assert.equal(deliveredPaymentState.payload.partyFinality.paymentTerminal, false);
    assert.equal(deliveredPaymentState.payload.partyFinality.operatorTerminal, false);

    const stalePendingFinalityPayload = {
      protocol: "x402",
      nonce: "stale-pending-finality-promotion-test"
    };
    const stalePendingFinalityDigest = createHash("sha256")
      .update(JSON.stringify(stalePendingFinalityPayload))
      .digest("hex");
    const stalePendingFinalityEntry = {
      ledgerId: "pay_stale_pending_finality_test",
      createdAtIso: new Date().toISOString(),
      updatedAtIso: new Date().toISOString(),
      agentId,
      sessionId,
      x402RequestId: "req_stale_pending_finality_test",
      hireRequestId: hire.payload.requestId,
      resource: `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`,
      pricingMode: "fixed-exact",
      rail: "base-usdc",
      networkId: "eip155:8453",
      assetSymbol: "USDC",
      amountUsd: "0.25",
      paymentPayloadDigestSha256: stalePendingFinalityDigest,
      transactionHashes: [],
      paymentStatus: "authorization_verified",
      executionStatus: "completed",
      returnStatus: "accepted"
    };
    await writeFile(deliveredPaymentLedgerPath, JSON.stringify({
      entries: [stalePendingFinalityEntry]
    }, null, 2), "utf8");
    const stalePendingInitial = await requestJson(
      `${baseUrl}/api/x402/payment-state?paymentPayloadDigestSha256=${stalePendingFinalityDigest}`
    );
    assert.equal(stalePendingInitial.status, 200);
    assert.equal(stalePendingInitial.payload.protocolState, "DELIVERED_AWAITING_SETTLEMENT");
    assert.equal(stalePendingInitial.payload.statePollingRequired, true);
    await new Promise((resolve) => setTimeout(resolve, 5200));
    await writeFile(deliveredPaymentLedgerPath, JSON.stringify({
      entries: [
        {
          ...stalePendingFinalityEntry,
          updatedAtIso: new Date().toISOString(),
          paymentStatus: "settled",
          settlementStatus: "settled",
          sellerSettlementTxHash: "0xstalependingfinalityseller",
          protocolFeeTxHash: "0xstalependingfinalityfee",
          transactionHashes: [
            "0xstalependingfinalityseller",
            "0xstalependingfinalityfee"
          ]
        }
      ]
    }, null, 2), "utf8");
    const stalePendingPromoted = await requestJson(
      `${baseUrl}/api/x402/payment-state?paymentPayloadDigestSha256=${stalePendingFinalityDigest}`
    );
    assert.equal(stalePendingPromoted.status, 200);
    assert.equal(stalePendingPromoted.payload.protocolState, "DELIVERED_SETTLED");
    assert.equal(stalePendingPromoted.payload.stateFreshness, "fresh");
    assert.equal(stalePendingPromoted.payload.projectionSource, "inflight");
    assert.equal(stalePendingPromoted.payload.paymentFinality, "settled");
    assert.equal(stalePendingPromoted.payload.paymentFinalityPending, false);

    const staleLedgerDigest = "a".repeat(64);
    await writeFile(deliveredPaymentLedgerPath, JSON.stringify({
      entries: [
        {
          ledgerId: "pay_stale_submitted_after_delivery_test",
          createdAtIso: new Date().toISOString(),
          updatedAtIso: new Date().toISOString(),
          agentId,
          sessionId,
          x402RequestId: "req_stale_submitted_after_delivery_test",
          hireRequestId: hire.payload.requestId,
          resource: `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`,
          pricingMode: "fixed-exact",
          rail: "base-usdc",
          networkId: "eip155:8453",
          assetSymbol: "USDC",
          amountUsd: "0.25",
          paymentPayloadDigestSha256: staleLedgerDigest,
          transactionHashes: [],
          paymentStatus: "execution_completed",
          executionStatus: "submitted",
          returnStatus: "none"
        }
      ]
    }, null, 2), "utf8");
    const staleLedgerPaymentState = await requestJson(
      `${baseUrl}/api/x402/payment-state?paymentPayloadDigestSha256=${staleLedgerDigest}`
    );
    assert.equal(staleLedgerPaymentState.status, 200);
    assert.equal(staleLedgerPaymentState.payload.protocolState, "DELIVERED_AWAITING_SETTLEMENT");
    assert.equal(staleLedgerPaymentState.payload.buyerAction, "view_delivery");
    assert.equal(staleLedgerPaymentState.payload.sellerOutcome, "completed");
    assert.equal(staleLedgerPaymentState.payload.operatorObligation, "settle_payment");
    assert.equal(staleLedgerPaymentState.payload.payment.latestLedger.executionStatus, "completed");
    assert.equal(staleLedgerPaymentState.payload.payment.latestLedger.returnStatus, "accepted");
    assert.equal(staleLedgerPaymentState.payload.payment.latestLedger.paymentStatus, "execution_completed");
    assert.equal(staleLedgerPaymentState.payload.execution.operationalStatus.agentExecutionStatus, "completed");
    assert.equal(staleLedgerPaymentState.payload.retryResume.nextAction, "view_delivery");
    assert.equal(staleLedgerPaymentState.payload.retryResume.safeToRetrySamePayload, false);
    assert.equal(staleLedgerPaymentState.payload.retryResume.safeToCreateNewPayment, false);
    const staleLedgerSettlementWrongPayload = await requestJson(
      `${baseUrl}/api/x402/settlement-retry?ledgerId=pay_stale_submitted_after_delivery_test`,
      {
        method: "POST",
        body: JSON.stringify({
          paymentPayload: {
            protocol: "x402",
            nonce: "wrong-payload-for-stale-delivered-awaiting-settlement-test"
          }
        })
      }
    );
    assert.equal(staleLedgerSettlementWrongPayload.status, 409);
    assert.equal(staleLedgerSettlementWrongPayload.payload.code, "settlement_retry_payload_digest_mismatch");
    assert.equal(staleLedgerSettlementWrongPayload.payload.requiresOriginalPaymentPayload, true);
    assert.equal(staleLedgerSettlementWrongPayload.payload.doNotCreateNewPayment, true);
    assert.equal(staleLedgerSettlementWrongPayload.payload.expectedPaymentPayloadDigestSha256, staleLedgerDigest);
    assert.equal("paymentState" in staleLedgerSettlementWrongPayload.payload, false);

    const deliveredSettlementFailedDigest = "f".repeat(64);
    await writeFile(deliveredPaymentLedgerPath, JSON.stringify({
      entries: [
        {
          ledgerId: "pay_delivered_settlement_failed_test",
          createdAtIso: new Date().toISOString(),
          updatedAtIso: new Date().toISOString(),
          agentId,
          sessionId,
          x402RequestId: "req_delivered_settlement_failed_test",
          hireRequestId: hire.payload.requestId,
          resource: `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`,
          pricingMode: "fixed-exact",
          rail: "base-usdc",
          networkId: "eip155:8453",
          assetSymbol: "USDC",
          amountUsd: "0.25",
          paymentPayloadDigestSha256: deliveredSettlementFailedDigest,
          transactionHashes: [],
          paymentStatus: "settlement_failed",
          executionStatus: "completed",
          returnStatus: "accepted",
          errorMessage: "Facilitator settlement attempt timed out after 10000ms.",
          settlementRecovery: {
            settlementRetryable: false,
            canRetrySettlement: false,
            settlementFailureReason: "Facilitator settlement attempt timed out after 10000ms.",
            nextSettlementAction: "manual_review"
          }
        }
      ]
    }, null, 2), "utf8");
    const deliveredSettlementFailedPaymentState = await requestJson(
      `${baseUrl}/api/x402/payment-state?paymentPayloadDigestSha256=${deliveredSettlementFailedDigest}`
    );
    assert.equal(deliveredSettlementFailedPaymentState.status, 200);
    assert.equal(
      deliveredSettlementFailedPaymentState.payload.protocolState,
      "DELIVERED_SETTLEMENT_FAILED_REQUIRES_RECONCILIATION"
    );
    assert.equal(deliveredSettlementFailedPaymentState.payload.buyerAction, "view_delivery");
    assert.equal(deliveredSettlementFailedPaymentState.payload.sellerOutcome, "completed");
    assert.equal(deliveredSettlementFailedPaymentState.payload.operatorObligation, "reconcile_platform_state");
    assert.equal(deliveredSettlementFailedPaymentState.payload.settlementStatus, "failed");
    assert.equal(deliveredSettlementFailedPaymentState.payload.execution.operationalStatus.settlementStatus, "failed");
    assert.equal(deliveredSettlementFailedPaymentState.payload.retryResume.nextAction, "view_delivery");
    assert.equal(deliveredSettlementFailedPaymentState.payload.retryResume.safeToRetrySamePayload, false);
    assert.equal(deliveredSettlementFailedPaymentState.payload.retryResume.safeToCreateNewPayment, false);
    assert.match(deliveredSettlementFailedPaymentState.payload.retryResume.guidance, /Settlement failed/);
    assert.equal(deliveredSettlementFailedPaymentState.payload.payment.latestLedger.settlementRecovery.canRetrySettlement, true);
    assert.equal(deliveredSettlementFailedPaymentState.payload.payment.latestLedger.settlementRecovery.nextSettlementAction, "retry_settlement");
    assert.match(
      deliveredSettlementFailedPaymentState.payload.payment.latestLedger.settlementRecovery.retryEndpoint,
      /\/api\/x402\/settlement-retry\?ledgerId=pay_delivered_settlement_failed_test/
    );
    assert.match(
      deliveredSettlementFailedPaymentState.payload.retryResume.retryEndpoint,
      /\/api\/x402\/settlement-retry\?ledgerId=pay_delivered_settlement_failed_test/
    );
    assert.equal(
      deliveredSettlementFailedPaymentState.payload.retryResume.settlementRecovery.actor,
      "platform_or_buyer_agent_with_original_payload"
    );
    assert.equal(
      deliveredSettlementFailedPaymentState.payload.retryResume.settlementRecovery.action,
      "retry_settlement_same_payload"
    );
    assert.equal(deliveredSettlementFailedPaymentState.payload.partyFinality.buyerTerminal, true);
    assert.equal(deliveredSettlementFailedPaymentState.payload.partyFinality.sellerTerminal, true);
    assert.equal(deliveredSettlementFailedPaymentState.payload.partyFinality.paymentTerminal, false);
    assert.equal(deliveredSettlementFailedPaymentState.payload.partyFinality.operatorTerminal, false);

    console.log("ok - relay hire response failures create durable execution records");
  } finally {
    relaySocket?.destroy();
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testRelayPostAckTimeoutStaysPendingAndRetrySafe() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-relay-post-ack-timeout-test-"));
  const port = await reservePort();
  const server = startServer(workspaceDir, port, {
    CLAWZ_AGENT_RELAY_RESPONSE_TIMEOUT_MS: "500",
    CLAWZ_PAYMENT_LEDGER_CACHE_TTL_MS: "0"
  });
  let relaySocket;

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);

    const ticket = await requestJson(`${baseUrl}/api/enrollment/tickets`, {
      method: "POST",
      body: JSON.stringify({
        agentName: "Relay Post Ack Timeout Agent",
        headline: "Keeps post-ack relay timeouts pending instead of final failed.",
        representedPrincipal: "Relay timeout smoke operator",
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
        taskPrompt: "Acknowledge the job but do not return before platform timeout.",
        requesterContact: "buyer@example.com"
      })
    });
    const relayHire = await waitForRelayJson(
      relaySocket,
      (message) => message.type === "hire_request"
    );
    const requestId = JSON.parse(relayHire.request.body).request_id;
    sendRelayJson(relaySocket, {
      type: "hire_ack",
      messageId: relayHire.messageId,
      requestId,
      receivedAtIso: new Date().toISOString(),
      localHireUrl: "http://127.0.0.1:65535/hire",
      localHireTimeoutMs: 300000,
      relayAgentProtocolVersion: "relay-test"
    });
    sendRelayJson(relaySocket, {
      type: "hire_worker_progress",
      messageId: relayHire.messageId,
      requestId,
      requestBodyDigestSha256: relayHire.request.bodyDigestSha256,
      step: "received_by_worker",
      status: "completed",
      occurredAtIso: new Date().toISOString(),
      detail: "test worker accepted but did not return",
      localHireTimeoutMs: 300000,
      elapsedMs: 15
    });

    const hire = await hirePromise;
    assert.equal(hire.status, 200);
    assert.equal(hire.payload.status, "submitted");
    assert.equal(hire.payload.deliveryStatus, "acknowledged");
    assert.equal(hire.payload.operationalStatus.relayDeliveryStatus, "acknowledged");
    assert.equal(hire.payload.operationalStatus.agentExecutionStatus, "running_or_unknown");
    assert.equal(hire.payload.deliveryReceipt.errorCode, "relay_return_timeout_after_worker_ack");
    assert.equal(hire.payload.relayTrace.some((entry) => entry.step === "received_by_worker" && entry.status === "completed"), true);
    assert.equal(hire.payload.relayTrace.some((entry) => entry.step === "relay_returned" && entry.status === "failed"), true);

    const executionState = await requestJson(
      `${baseUrl}/api/executions/${encodeURIComponent(hire.payload.requestId)}/state?token=${encodeURIComponent(hire.payload.jobWorkspace.token)}`
    );
    assert.equal(executionState.status, 200);
    assert.equal(executionState.payload.lifecycle.relayDeliveryStatus, "acknowledged");
    assert.equal(executionState.payload.lifecycle.agentExecutionStatus, "running_or_unknown");
    assert.equal(executionState.payload.lifecycle.buyerCompletionStatus, "worker_acknowledged_pending_reconciliation");
    assert.equal(executionState.payload.lifecycle.platformReconciliationStatus, "pending_worker_return_or_late_completion");
    assert.equal(executionState.payload.lifecycleChecks.failed, false);
    assert.equal(executionState.payload.lifecycleChecks.terminal, false);
    assert.equal(executionState.payload.safeToRetrySamePayload, false);
    assert.equal(executionState.payload.safeToRetrySamePaymentPayload, false);
    assert.equal(executionState.payload.doNotCreateNewPayment, true);

    const paymentLedgerPath = path.join(workspaceDir, ".clawz-data", "state", "payment-ledger.json");
    await writeFile(paymentLedgerPath, JSON.stringify({
      entries: [
        {
          ledgerId: "pay_post_ack_alias_test",
          createdAtIso: new Date().toISOString(),
          updatedAtIso: new Date().toISOString(),
          agentId,
          sessionId,
          x402RequestId: "req_post_ack_alias_test",
          hireRequestId: hire.payload.requestId,
          resource: `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`,
          pricingMode: "free-test",
          rail: "free-test",
          networkId: "local",
          assetSymbol: "TEST",
          amountUsd: "0",
          paymentPayloadDigestSha256: "d".repeat(64),
          transactionHashes: [],
          paymentStatus: "authorized",
          executionStatus: "submitted",
          returnStatus: "none"
        }
      ]
    }, null, 2), "utf8");
    const aliasExecutionState = await requestJson(
      `${baseUrl}/api/executions/req_post_ack_alias_test/state?token=${encodeURIComponent(hire.payload.jobWorkspace.token)}`
    );
    assert.equal(aliasExecutionState.status, 200);
    assert.equal(aliasExecutionState.payload.requestId, hire.payload.requestId);
    assert.equal(aliasExecutionState.payload.requestedRequestId, "req_post_ack_alias_test");
    assert.equal(aliasExecutionState.payload.ids.x402RequestId, "req_post_ack_alias_test");
    assert.equal(aliasExecutionState.payload.ids.hireRequestId, hire.payload.requestId);
    assert.match(
      aliasExecutionState.payload.paymentStateUrl,
      /paymentPayloadDigestSha256=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd$/
    );

    const redactedPaymentState = await requestJson(
      `${baseUrl}/api/x402/payment-state?paymentPayloadDigestSha256=${"d".repeat(64)}`
    );
    assert.equal(redactedPaymentState.status, 200);
    assert.equal(redactedPaymentState.payload.redacted, true);
    assert.equal(redactedPaymentState.payload.protocolState, "AUTHORIZED_WAITING_FOR_DELIVERY");
    assert.equal(redactedPaymentState.payload.buyerAction, "retry_same_payment_payload");
    assert.equal(redactedPaymentState.payload.sellerOutcome, "pending");
    assert.match(
      redactedPaymentState.payload.retryResume.stateEndpoint,
      /\/api\/executions\/[^/]+\/state\?paymentPayloadDigestSha256=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd$/
    );
    const digestExecutionState = await requestJson(redactedPaymentState.payload.retryResume.stateEndpoint);
    assert.equal(digestExecutionState.status, 200);
    assert.equal(digestExecutionState.payload.stateAccess.mode, "payment_digest_recovery");
    assert.equal(digestExecutionState.payload.stateAccess.redacted, true);
    assert.equal(digestExecutionState.payload.payment.ledgerEntries, undefined);
    assert.equal(digestExecutionState.payload.payment.ledgerEntryCount, 1);
    assert.equal(digestExecutionState.payload.workspace.access, "redacted_payment_digest_recovery");
    assert.equal(digestExecutionState.payload.workspace.stageCount, 0);
    assert.equal(digestExecutionState.payload.workspace.messageCount, 0);
    assert.equal(digestExecutionState.payload.safeToRetrySamePayload, true);
    assert.equal(digestExecutionState.payload.safeToCreateNewPayment, false);
    assert.equal(digestExecutionState.payload.protocolState, "AUTHORIZED_WAITING_FOR_DELIVERY");
    assert.equal(digestExecutionState.payload.buyerAction, "retry_same_payment_payload");
    assert.equal(digestExecutionState.payload.operatorObligation, "reconcile_platform_state");

    const expiredLedger = JSON.parse(await readFile(paymentLedgerPath, "utf8"));
    expiredLedger.entries = expiredLedger.entries.map((entry) =>
      entry.paymentPayloadDigestSha256 === "d".repeat(64)
        ? {
            ...entry,
            errorCode: "payment_payload_expired_for_retry",
            errorMessage: "Payment payload is expired."
          }
        : entry
    );
    await writeFile(paymentLedgerPath, JSON.stringify(expiredLedger, null, 2), "utf8");
    const expiredRedactedPaymentState = await requestJson(
      `${baseUrl}/api/x402/payment-state?paymentPayloadDigestSha256=${"d".repeat(64)}`
    );
    assert.equal(expiredRedactedPaymentState.status, 200);
    assert.equal(expiredRedactedPaymentState.payload.protocolState, "EXPIRED_NO_CHARGE");
    assert.equal(expiredRedactedPaymentState.payload.buyerAction, "create_fresh_payment");
    assert.equal(expiredRedactedPaymentState.payload.retryResume.safeToRetrySamePayload, false);
    assert.equal(expiredRedactedPaymentState.payload.retryResume.safeToRetrySamePaymentPayload, false);
    assert.equal(expiredRedactedPaymentState.payload.retryResume.safeToCreateNewPayment, true);
    assert.equal(expiredRedactedPaymentState.payload.retryResume.terminal, true);
    assert.equal(expiredRedactedPaymentState.payload.retryResume.terminalReason, "payment_payload_expired_no_charge");
    assert.equal(expiredRedactedPaymentState.payload.retryResume.refundOrNoChargeStatus, "no_charge_authorization_expired");
    assert.equal(expiredRedactedPaymentState.payload.retryResume.paymentPayloadExpiredForRetry, true);
    const expiredDigestExecutionState = await requestJson(expiredRedactedPaymentState.payload.retryResume.stateEndpoint);
    assert.equal(expiredDigestExecutionState.status, 200);
    assert.equal(expiredDigestExecutionState.payload.protocolState, "EXPIRED_NO_CHARGE");
    assert.equal(expiredDigestExecutionState.payload.buyerAction, "create_fresh_payment");
    assert.equal(expiredDigestExecutionState.payload.sellerOutcome, "not_at_fault");
    assert.equal(expiredDigestExecutionState.payload.safeToRetrySamePayload, false);
    assert.equal(expiredDigestExecutionState.payload.safeToRetrySamePaymentPayload, false);
    assert.equal(expiredDigestExecutionState.payload.safeToCreateNewPayment, true);
    assert.equal(expiredDigestExecutionState.payload.doNotCreateNewPayment, false);
    assert.equal(expiredDigestExecutionState.payload.terminalReason, "payment_payload_expired_no_charge");
    assert.equal(expiredDigestExecutionState.payload.refundOrNoChargeStatus, "no_charge_authorization_expired");
    assert.equal(expiredDigestExecutionState.payload.paymentPayloadExpiredForRetry, true);
    assert.equal(expiredDigestExecutionState.payload.paymentPayloadRetryRejected, true);
    assert.equal(expiredDigestExecutionState.payload.humanOrPlatformInterventionRequired, false);
    assert.equal(expiredDigestExecutionState.payload.reason, "payment_payload_expired_no_charge");
    assert.equal(expiredDigestExecutionState.payload.reconciliation.status, "terminal_no_charge");
    assert.equal(expiredDigestExecutionState.payload.reconciliation.reason, "payment_payload_expired_no_charge");

    const plainPlanBeforeBuyerDigest = await requestJson(
      `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/x402-plan`
    );
    assert.equal(plainPlanBeforeBuyerDigest.status, 200);
    assert.equal(plainPlanBeforeBuyerDigest.payload.buyerPaymentSafety, undefined);

    const blockedPlan = await requestJson(
      `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/x402-plan?paymentPayloadDigestSha256=${"d".repeat(64)}`
    );
    assert.equal(blockedPlan.status, 200);
    assert.equal(blockedPlan.payload.buyerPaymentSafety.schemaVersion, "santaclawz-buyer-payment-safety/1.0");
    assert.equal(blockedPlan.payload.buyerPaymentSafety.freshPaymentSafeForBuyer, true);
    assert.equal(blockedPlan.payload.buyerPaymentSafety.safeToRetrySamePayload, false);
    assert.equal(blockedPlan.payload.buyerPaymentSafety.safeToCreateNewPayment, true);
    assert.equal(blockedPlan.payload.buyerPaymentSafety.safeNextAction, "create_new_payment_or_retry_job");
    assert.equal(blockedPlan.payload.buyerPaymentSafety.terminal, true);
    assert.equal(blockedPlan.payload.buyerPaymentSafety.terminalReason, "payment_payload_expired_no_charge");
    assert.equal(blockedPlan.payload.buyerPaymentSafety.refundOrNoChargeStatus, "no_charge_authorization_expired");
    assert.equal(blockedPlan.payload.buyerPaymentSafety.unresolved, false);
    assert.equal(blockedPlan.payload.buyerPaymentSafety.humanOrPlatformInterventionRequired, false);
    assert.equal(blockedPlan.payload.buyerPaymentSafety.blockingPaymentPayloadDigestSha256, "d".repeat(64));
    assert.equal(blockedPlan.payload.buyerPaymentSafety.blockerCode, undefined);

    const plainPlanAfterBuyerDigest = await requestJson(
      `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/x402-plan`
    );
    assert.equal(plainPlanAfterBuyerDigest.status, 200);
    assert.equal(plainPlanAfterBuyerDigest.payload.buyerPaymentSafety, undefined);

    const hireRequestPath = path.join(workspaceDir, ".clawz-data", "state", "hire-requests.json");
    const legacyHireRequests = JSON.parse(await readFile(hireRequestPath, "utf8"));
    legacyHireRequests.requests = legacyHireRequests.requests.map((request) =>
      request.requestId === hire.payload.requestId
        ? {
            ...request,
            status: "submitted",
            deliveryStatus: "failed",
            deliveryError: "Timed out waiting for agent relay response after worker acknowledgement.",
            operationalStatus: {
              ...request.operationalStatus,
              relayDeliveryStatus: "failed",
              agentExecutionStatus: "submitted"
            }
          }
        : request
    );
    await writeFile(hireRequestPath, JSON.stringify(legacyHireRequests, null, 2), "utf8");

    const legacyExecutionState = await requestJson(
      `${baseUrl}/api/executions/${encodeURIComponent(hire.payload.requestId)}/state?token=${encodeURIComponent(hire.payload.jobWorkspace.token)}`
    );
    assert.equal(legacyExecutionState.status, 200);
    assert.equal(legacyExecutionState.payload.lifecycle.relayDeliveryStatus, "failed");
    assert.equal(legacyExecutionState.payload.lifecycle.agentExecutionStatus, "submitted");
    assert.equal(legacyExecutionState.payload.lifecycleChecks.failed, false);
    assert.equal(legacyExecutionState.payload.lifecycleChecks.terminal, true);
    assert.equal(legacyExecutionState.payload.lifecycleChecks.paymentPathTerminal, true);
    assert.equal(legacyExecutionState.payload.retryMode, "fresh_payment_allowed_after_expired_authorization");
    assert.equal(legacyExecutionState.payload.safeToRetrySamePayload, false);
    assert.equal(legacyExecutionState.payload.safeToRetrySamePaymentPayload, false);
    assert.equal(legacyExecutionState.payload.paymentPayloadExpiredForRetry, true);
    assert.equal(legacyExecutionState.payload.reason, "payment_payload_expired_no_charge");
    assert.equal(legacyExecutionState.payload.safeToCreateNewPayment, true);

    const reconciled = await requestJson(
      `${baseUrl}/api/executions/${encodeURIComponent(hire.payload.requestId)}/reconcile-worker-return`,
      {
        method: "POST",
        headers: { "x-clawz-admin-key": adminKey },
        body: JSON.stringify({
          schema_version: "santaclawz-return/1.0",
          request_id: hire.payload.requestId,
          status: "completed",
          agent_private: true,
          real_work_executed: true,
          buyer_visible: true,
          verified_output: {
            package_hash: "f".repeat(64),
            hash_algorithm: "sha256",
            verification_manifest: {
              input_digest_sha256: "a".repeat(64),
              checks_performed: ["worker_completed", "late_return_reconciled"],
              files_produced: ["late-result.json"],
              blocked_suspicious_instructions: []
            },
	            deliverables: [
	              {
	                name: "late-result.json",
	                sha256: "b".repeat(64)
	              }
	            ],
	            buyer_visible_outputs: [
	              {
	                name: "late-result.json",
	                content_type: "application/json",
	                text: "{\"ok\":true}",
	                sha256: "c".repeat(64)
	              }
	            ]
	          }
	        })
      }
    );
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.payload.request.status, "completed");
    assert.equal(reconciled.payload.request.operationalStatus.relayDeliveryStatus, "reconciled_completed");
    assert.equal(reconciled.payload.request.operationalStatus.agentExecutionStatus, "completed");
    assert.equal(reconciled.payload.request.deliveryError, undefined);

    const reconciledState = await requestJson(
      `${baseUrl}/api/executions/${encodeURIComponent(hire.payload.requestId)}/state?token=${encodeURIComponent(hire.payload.jobWorkspace.token)}`
    );
    assert.equal(reconciledState.status, 200);
    assert.equal(reconciledState.payload.lifecycle.relayDeliveryStatus, "reconciled_completed");
    assert.equal(reconciledState.payload.lifecycle.agentExecutionStatus, "completed");
    assert.equal(reconciledState.payload.lifecycle.sellerExecutionCompleted, true);
	    assert.equal(reconciledState.payload.lifecycle.buyerCompletionStatus, "buyer_complete");
	    assert.equal(reconciledState.payload.lifecycle.sellerReputationImpact, "none");
    assert.equal(reconciledState.payload.lifecycle.buyerVisibleInlineOutputCount, 1);
    assert.equal(reconciledState.payload.lifecycle.buyerDownloadableArtifactCount, 0);
    assert.equal(reconciledState.payload.lifecycle.verifiedOutputDeliverableCount, 1);
    assert.equal(reconciledState.payload.lifecycle.filesProducedCount, 1);
    assert.equal(reconciledState.payload.lifecycle.internalPackageOnly, true);
    assert.equal(reconciledState.payload.partyFinality.buyerTerminal, true);
    assert.equal(reconciledState.payload.partyFinality.sellerTerminal, true);
    assert.equal(reconciledState.payload.partyFinality.paymentTerminal, false);
    assert.equal(reconciledState.payload.lifecycleChecks.agentCompleted, true);
    assert.equal(reconciledState.payload.lifecycleChecks.failed, false);
	    assert.equal(reconciledState.payload.lifecycleChecks.terminal, false);
    assert.equal(reconciledState.payload.relayTrace.some((entry) => entry.detail === "late worker return reconciled through authenticated endpoint"), true);
    assert.equal(
      reconciledState.payload.relayTrace.some((entry) => entry.step === "worker_completed" && entry.status === "completed"),
      true
    );
    assert.equal(
      reconciledState.payload.relayTrace.some((entry) => entry.step === "worker_completed" && entry.status === "not_reached"),
      false
    );

    console.log("ok - relay post-ack timeout remains pending, retry-safe, and reconcilable");
  } finally {
    relaySocket?.destroy();
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testRelayPreparedResponseResolvesInlineCompletion() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-relay-prepared-response-test-"));
  const port = await reservePort();
  const server = startServer(workspaceDir, port, {
    CLAWZ_AGENT_RELAY_RESPONSE_TIMEOUT_MS: "5000"
  });
  let relaySocket;

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);

    const ticket = await requestJson(`${baseUrl}/api/enrollment/tickets`, {
      method: "POST",
      body: JSON.stringify({
        agentName: "Relay Prepared Response Agent",
        headline: "Uses the prepared response progress frame as an inline fallback.",
        representedPrincipal: "Prepared response smoke operator",
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
        taskPrompt: "Complete through the prepared-response fallback frame.",
        requesterContact: "buyer@example.com"
      })
    });
    const relayHire = await waitForRelayJson(
      relaySocket,
      (message) => message.type === "hire_request"
    );
    const requestId = JSON.parse(relayHire.request.body).request_id;
    const preparedReturn = {
      schema_version: "santaclawz-return/1.0",
      request_id: requestId,
      status: "completed",
      agent_private: true,
      real_work_executed: true,
      buyer_visible: true,
      verified_output: {
        package_hash: "1".repeat(64),
        hash_algorithm: "sha256",
        verification_manifest: {
          input_digest_sha256: "2".repeat(64),
          checks_performed: ["worker_completed", "prepared_response_inline_fallback"],
          files_produced: ["prepared-response.md"],
          blocked_suspicious_instructions: []
        },
        deliverables: [{ name: "prepared-response.md", sha256: "3".repeat(64) }],
        buyer_visible_outputs: [
          {
            name: "prepared-response.md",
            content_type: "text/markdown",
            text: "Prepared response is available inline.",
            sha256: "4".repeat(64)
          }
        ]
      }
    };
    const preparedBody = JSON.stringify(preparedReturn);
    const inFlightLateCompletion = await requestJson(
      `${baseUrl}/api/executions/${encodeURIComponent(requestId)}/late-completion`,
      {
        method: "POST",
        headers: { "x-clawz-admin-key": adminKey },
        body: JSON.stringify({
          statusCode: 200,
          bodyBase64: Buffer.from(preparedBody, "utf8").toString("base64"),
          bodyEncoding: "base64",
          relayMessageId: "relay_prepared_backup"
        })
      }
    );
    assert.equal(inFlightLateCompletion.status, 200);
    assert.equal(inFlightLateCompletion.payload.status, "completed");
    sendRelayJson(relaySocket, {
      type: "hire_ack",
      messageId: relayHire.messageId,
      requestId,
      receivedAtIso: new Date().toISOString(),
      localHireUrl: "http://127.0.0.1:65535/hire",
      relayAgentProtocolVersion: "relay-test"
    });
    sendRelayJson(relaySocket, {
      type: "hire_worker_progress",
      messageId: relayHire.messageId,
      requestId,
      requestBodyDigestSha256: relayHire.request.bodyDigestSha256,
      step: "relay_response_compacted",
      status: "completed",
      occurredAtIso: new Date().toISOString(),
      detail: "compacted prepared response body is available before the separate hire_response frame",
      workerStatusCode: 200,
      workerResponseBytes: Buffer.byteLength(preparedBody, "utf8"),
      workerResponseDigestSha256: createHash("sha256").update(preparedBody).digest("hex"),
      relayBodyBytes: Buffer.byteLength(preparedBody, "utf8"),
      relayBodyDigestSha256: createHash("sha256").update(preparedBody).digest("hex"),
      preparedResponseStatusCode: 200,
      preparedResponseBodyBase64: Buffer.from(preparedBody, "utf8").toString("base64"),
      preparedResponseBodyEncoding: "base64"
    });

    const hire = await hirePromise;
    assert.equal(hire.status, 200);
    assert.equal(hire.payload.status, "completed");
    assert.equal(hire.payload.deliveryStatus, "forwarded");
    assert.equal(hire.payload.operationalStatus.relayDeliveryStatus, "forwarded");
    assert.equal(hire.payload.operationalStatus.agentExecutionStatus, "completed");
    assert.equal(hire.payload.protocolReturn.status, "completed");
    assert.equal(hire.payload.relayTrace.some((entry) => entry.step === "relay_response_compacted" && entry.status === "completed"), true);
    assert.equal(hire.payload.relayTrace.some((entry) => entry.step === "hire_response_prepared" && entry.status === "completed"), true);
    assert.equal(hire.payload.relayTrace.some((entry) => entry.step === "worker_completed" && entry.status === "completed"), true);
    assert.equal(hire.payload.relayTrace.some((entry) => entry.step === "relay_returned" && entry.status === "completed"), true);

    console.log("ok - prepared relay response progress frame resolves inline completion");
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
	        deliverables,
	        buyer_visible_outputs: [
	          {
	            name: "compacted-summary.md",
	            content_type: "text/markdown",
	            text: "Large relay return compacted with buyer-readable summary.",
	            sha256: "f".repeat(64)
	          }
	        ]
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
    assert.equal(hire.payload.relayTrace.some((entry) => entry.step === "hire_response_prepared" && entry.status === "completed"), true);
    assert.equal(hire.payload.relayTrace.some((entry) => entry.step === "worker_completed" && entry.status === "completed"), true);
    const executionState = await requestJson(
      `${baseUrl}/api/executions/${encodeURIComponent(hire.payload.requestId)}/state?token=${encodeURIComponent(hire.payload.jobWorkspace.token)}`
    );
    assert.equal(executionState.status, 200);
    assert.equal(executionState.payload.relayTrace.some((entry) => entry.step === "worker_ack" && entry.status === "completed"), true);
    assert.match(relayLogs.stderr.join(""), /"relayPayloadBytes":[4-9][0-9]{3}/);
    assert.match(relayLogs.stderr.join(""), /relay_worker_request_received/);
    assert.match(relayLogs.stderr.join(""), /relay_hire_response_prepared_progress_send_succeeded/);
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
    assert.equal(availability.payload.readiness, undefined);

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

async function testHostedWorkspaceRunApi() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-workspace-run-test-"));
  const port = await reservePort();
  const server = startServer(workspaceDir, port);

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);

    const code = await requestJson(`${baseUrl}/api/workspaces/auth/email-code`, {
      method: "POST",
      body: JSON.stringify({
        orgName: "Example team",
        workspaceDomain: "example.com",
        email: "team-bridge@example.com"
      })
    });
    assert.equal(code.status, 200);
    assert.equal(code.payload.ok, true);
    assert.equal(code.payload.deliveryMode, "dev-returned");
    assert.equal(typeof code.payload.devCode, "string");

    const verified = await requestJson(`${baseUrl}/api/workspaces/auth/email-code/verify`, {
      method: "POST",
      body: JSON.stringify({
        challengeId: code.payload.challengeId,
        email: "team-bridge@example.com",
        code: code.payload.devCode
      })
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.payload.ok, true);
    assert.equal(verified.payload.workspaceId, code.payload.workspaceId);
    assert.equal(typeof verified.payload.workspaceSessionToken, "string");

    const unauthenticatedSave = await requestJson(`${baseUrl}/api/workspaces/runs`, {
      method: "POST",
      body: JSON.stringify({
        orgName: "Example team",
        workspaceDomain: "example.com",
        identityProvider: "email-code",
        projectName: "Market launch review",
        goal: "Coordinate research agents without hosting company data.",
        threadId: "thread_team_launch_review",
        swarmId: "team_launch_review",
        requesterContact: "team-bridge@example.com",
        privacyMode: "digest-only"
      })
    });
    assert.equal(unauthenticatedSave.status, 401);
    assert.equal(unauthenticatedSave.payload.code, "workspace_session_required");

    const saved = await requestJson(`${baseUrl}/api/workspaces/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${verified.payload.workspaceSessionToken}`
      },
      body: JSON.stringify({
        orgName: "Example team",
        workspaceDomain: "example.com",
        identityProvider: "email-code",
        projectName: "Market launch review",
        goal: "Coordinate research agents without hosting company data.",
        threadId: "thread_team_launch_review",
        swarmId: "team_launch_review",
        requesterContact: "team-bridge@example.com",
        budgetUsd: "1.00",
        privacyMode: "digest-only",
        requiredCapabilities: ["research", "critique"],
        selectedAgentIds: [],
        toolTouchpoints: ["slack", "github"],
        manifest: {
          schemaVersion: "santaclawz-team-coordination-bridge/0.1"
        }
      })
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.payload.ok, true);
    assert.equal(saved.payload.workspace.workspaceId, code.payload.workspaceId);
    assert.equal(saved.payload.workspace.loginMode, "email_one_time_code");
    assert.equal(saved.payload.workspace.dataPolicy.hostedOrgData, false);
    assert.equal(saved.payload.stats.hostedOrgData, false);
    assert.equal(saved.payload.stats.globalMetricsCounted, true);
    assert.equal(saved.payload.connectors.length, 2);
    assert.deepEqual(saved.payload.connectors.map((connector) => connector.kind).sort(), ["github", "slack"]);
    assert.equal(saved.payload.securityCapabilities.enterpriseAuth.protocol, "zk-mission-auth");
    assert.deepEqual(saved.payload.securityCapabilities.enterpriseAuth.providers, ["auth0", "okta", "custom-oidc"]);
    assert.equal(saved.payload.securityCapabilities.kms.workspaceKeyBoundary, "tenant-key-broker");
    assert.equal(saved.payload.securityCapabilities.kms.hostedOrgData, false);
    assert.equal(saved.payload.localConnectorContract.privateDataRule.includes("Local wrappers"), true);
    assert.deepEqual(saved.payload.localConnectorContract.declaredTouchpoints, ["slack", "github"]);

    const wrongWorkspaceList = await requestJson(`${baseUrl}/api/workspaces/runs?workspaceId=${encodeURIComponent("workspace_wrong")}`, {
      headers: {
        authorization: `Bearer ${verified.payload.workspaceSessionToken}`
      }
    });
    assert.equal(wrongWorkspaceList.status, 403);
    assert.match(wrongWorkspaceList.payload.error, /does not match/);

    const fetched = await requestJson(`${baseUrl}/api/workspaces/runs/${encodeURIComponent(saved.payload.run.runId)}`, {
      headers: {
        authorization: `Bearer ${verified.payload.workspaceSessionToken}`
      }
    });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.payload.ok, true);
    assert.equal(fetched.payload.run.runId, saved.payload.run.runId);
    assert.equal(fetched.payload.stats.hostedOrgData, false);
    assert.equal(fetched.payload.securityCapabilities.enterpriseAuth.overlay, "agent-mission-auth-overlay");

    const listed = await requestJson(`${baseUrl}/api/workspaces/runs?workspaceId=${encodeURIComponent(code.payload.workspaceId)}`, {
      headers: {
        authorization: `Bearer ${verified.payload.workspaceSessionToken}`
      }
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.payload.ok, true);
    assert.equal(listed.payload.runs.length, 1);

    console.log("ok - hosted workspace run API persists shell state without org data");
  } finally {
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

async function testPublicPayoutSummaryUsesAllTimeLedgerStats() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-payment-rollup-"));
  const ledgerDir = path.join(workspaceDir, ".clawz-data", "state");
  await mkdir(ledgerDir, { recursive: true });
  await writeFile(path.join(ledgerDir, "payment-ledger.json"), JSON.stringify({
    entries: [
      {
        ledgerId: "pay_recent_completed",
        createdAtIso: "2026-06-07T00:00:00.000Z",
        updatedAtIso: "2026-06-07T00:01:00.000Z",
        agentId: "rollup-agent--session_agent_rollup",
        sessionId: "session_agent_rollup",
        pricingMode: "fixed-exact",
        rail: "base-usdc",
        networkId: "eip155:8453",
        assetSymbol: "USDC",
        amountUsd: "0.25",
        sellerNetAmountUsd: "0.248",
        transactionHashes: [],
        paymentStatus: "execution_completed",
        executionStatus: "completed",
        returnStatus: "accepted"
      }
    ],
    allTimeStats: {
      completedPaymentCount: 812,
      completedBasePaymentCount: 812,
      completedSellerPayoutUsd: "219.75",
      completedBaseSellerPayoutUsd: "219.75",
      countedPaymentKeys: ["legacy_completed_rollup"]
    }
  }, null, 2), "utf8");
  const port = await reservePort();
  const server = startServer(workspaceDir, port);

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, server);
    const payments = await requestJson(`${baseUrl}/api/payments?limit=1`);
    assert.equal(payments.status, 200);
    assert.equal(payments.payload.summary.completedSellerPayoutUsd, "219.998");
    assert.equal(payments.payload.summary.completedBaseSellerPayoutUsd, "219.998");
    assert.equal(payments.payload.summary.completedPaymentCount, 813);
    const publicMarketplaceSnapshot = await requestJson(`${baseUrl}/api/public/marketplace-snapshot`, { method: "GET" });
    assert.equal(publicMarketplaceSnapshot.status, 200);
    assert.equal(publicMarketplaceSnapshot.payload.paymentLedger.summary.completedSellerPayoutUsd, "219.998");
    assert.equal(publicMarketplaceSnapshot.payload.paymentLedger.totalLedgerEntryCount, 813);

    console.log("ok - public payout summary uses all-time payment ledger stats");
  } finally {
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testPaymentLedgerPersistenceKeepsCumulativePayoutStatsWhenRowsArePruned() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-payment-ledger-rollup-"));
  try {
    const { ClawzControlPlane } = await import(pathToFileURL(controlPlaneEntry).href);
    const controlPlane = new ClawzControlPlane(path.join(workspaceDir, ".clawz-data"));
    const nowIso = new Date().toISOString();
    const entries = Array.from({ length: 2001 }, (_, index) => ({
      ledgerId: `pay_rollup_${index.toString().padStart(4, "0")}`,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      agentId: "agent_rollup",
      sessionId: "session_rollup",
      resource: "http://127.0.0.1/hire",
      pricingMode: "fixed-exact",
      rail: "base-usdc",
      networkId: "eip155:8453",
      assetSymbol: "USDC",
      amountUsd: index === 0 ? "1.234567" : "0.000001",
      sellerNetAmountUsd: index === 0 ? "1.234567" : "0.000001",
      settlementReference: `settlement_rollup_${index}`,
      transactionHashes: [`0x${(index + 1).toString(16).padStart(64, "0")}`],
      paymentStatus: "settled",
      executionStatus: "completed",
      returnStatus: "accepted"
    }));

    await controlPlane.savePaymentLedgerFile({ entries });

    const paymentLedgerPath = path.join(workspaceDir, ".clawz-data", "state", "payment-ledger.json");
    const saved = JSON.parse(await readFile(paymentLedgerPath, "utf8"));
    assert.equal(saved.entries.length, 2000);
    assert.equal(saved.allTimeStats.completedPaymentCount, 2001);
    assert.equal(saved.allTimeStats.completedBasePaymentCount, 2001);
    assert.equal(saved.allTimeStats.completedSellerPayoutUsd, "1.236567");
    assert.equal(saved.allTimeStats.completedBaseSellerPayoutUsd, "1.236567");

    const reconciledStats = await controlPlane.reconcileBasePaymentLedgerRollup({
      completedBasePaymentCount: 3,
      completedBaseSellerPayoutUsd: "5.432101",
      countedPaymentKeys: ["base_tx_one", "base_tx_two", "base_tx_three"]
    });
    assert.equal(reconciledStats.completedPaymentCount, 3);
    assert.equal(reconciledStats.completedBasePaymentCount, 3);
    assert.equal(reconciledStats.completedSellerPayoutUsd, "5.432101");
    assert.equal(reconciledStats.completedBaseSellerPayoutUsd, "5.432101");
    const reconciled = JSON.parse(await readFile(paymentLedgerPath, "utf8"));
    assert.equal(reconciled.entries.length, 2000);
    assert.equal(reconciled.allTimeStats.completedPaymentCount, 3);
    assert.equal(reconciled.allTimeStats.completedBaseSellerPayoutUsd, "5.432101");

    console.log("ok - payment ledger persistence keeps cumulative payout stats when rows are pruned");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testProductionPaymentLedgerUsesVerifiedBasePayoutBaseline() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-payment-ledger-baseline-"));
  const priorRuntimeEnv = process.env.CLAWZ_RUNTIME_ENV;
  try {
    process.env.CLAWZ_RUNTIME_ENV = "production";
    const { ClawzControlPlane } = await import(pathToFileURL(controlPlaneEntry).href);
    const controlPlane = new ClawzControlPlane(path.join(workspaceDir, ".clawz-data"));
    const nowIso = new Date().toISOString();
    await controlPlane.savePaymentLedgerFile({
      entries: [
        {
          ledgerId: "pay_retained_before_verified_snapshot",
          createdAtIso: nowIso,
          updatedAtIso: nowIso,
          agentId: "baseline-agent--session_agent_baseline",
          sessionId: "session_agent_baseline",
          pricingMode: "fixed-exact",
          rail: "base-usdc",
          networkId: "eip155:8453",
          assetSymbol: "USDC",
          amountUsd: "0.25",
          sellerNetAmountUsd: "0.248",
          settlementReference: "baseline-retained-settlement",
          transactionHashes: [`0x${"1".padStart(64, "0")}`],
          paymentStatus: "settled",
          executionStatus: "completed",
          returnStatus: "accepted"
        }
      ],
      allTimeStats: {
        completedPaymentCount: 1825,
        completedBasePaymentCount: 1825,
        completedSellerPayoutUsd: "499.256003",
        completedBaseSellerPayoutUsd: "499.256003",
        countedPaymentKeys: []
      }
    });

    const paymentLedgerPath = path.join(workspaceDir, ".clawz-data", "state", "payment-ledger.json");
    const saved = JSON.parse(await readFile(paymentLedgerPath, "utf8"));
    assert.equal(saved.allTimeStats.completedPaymentCount, 2360);
    assert.equal(saved.allTimeStats.completedBasePaymentCount, 2360);
    assert.equal(saved.allTimeStats.completedSellerPayoutUsd, "749.385576");
    assert.equal(saved.allTimeStats.completedBaseSellerPayoutUsd, "749.385576");
    assert.ok(saved.allTimeStats.countedPaymentKeys.includes("baseline-retained-settlement"));

    console.log("ok - production payment ledger uses verified Base payout baseline");
  } finally {
    if (priorRuntimeEnv === undefined) {
      delete process.env.CLAWZ_RUNTIME_ENV;
    } else {
      process.env.CLAWZ_RUNTIME_ENV = priorRuntimeEnv;
    }
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testPaymentLedgerExecutionUpdatesAreMonotonic() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-payment-ledger-monotonic-"));
  try {
    const { ClawzControlPlane } = await import(pathToFileURL(controlPlaneEntry).href);
    const controlPlane = new ClawzControlPlane(path.join(workspaceDir, ".clawz-data"));
    await controlPlane.savePaymentLedgerFile({
      entries: [
        {
          ledgerId: "pay_monotonic_return",
          createdAtIso: new Date().toISOString(),
          updatedAtIso: new Date().toISOString(),
          agentId: "monotonic-agent--session_agent_monotonic",
          sessionId: "session_agent_monotonic",
          hireRequestId: "hire_monotonic",
          pricingMode: "fixed-exact",
          rail: "base-usdc",
          networkId: "eip155:8453",
          assetSymbol: "USDC",
          amountUsd: "0.25",
          paymentPayloadDigestSha256: "b".repeat(64),
          transactionHashes: [],
          paymentStatus: "execution_completed",
          executionStatus: "completed",
          returnStatus: "accepted"
        }
      ]
    });

    const staleExecution = await controlPlane.updatePaymentLedgerExecution({
      ledgerId: "pay_monotonic_return",
      hireRequestId: "hire_monotonic",
      executionStatus: "submitted",
      returnStatus: "none",
      errorCode: "stale_platform_timeout",
      errorMessage: "Stale platform timeout arrived after accepted return."
    });
    assert.equal(staleExecution.executionStatus, "completed");
    assert.equal(staleExecution.returnStatus, "accepted");
    assert.equal(staleExecution.paymentStatus, "execution_completed");
    assert.equal(staleExecution.errorCode, undefined);
    assert.equal(staleExecution.errorMessage, undefined);

    const staleAuthorization = await controlPlane.recordPaymentLedgerSettlement({
      agentId: "monotonic-agent--session_agent_monotonic",
      sessionId: "session_agent_monotonic",
      pricingMode: "fixed-exact",
      rail: "base-usdc",
      networkId: "eip155:8453",
      assetSymbol: "USDC",
      amountUsd: "0.25",
      paymentPayloadDigestSha256: "b".repeat(64),
      paymentStatus: "authorization_verified"
    });
    assert.equal(staleAuthorization.executionStatus, "completed");
    assert.equal(staleAuthorization.returnStatus, "accepted");
    assert.equal(staleAuthorization.paymentStatus, "execution_completed");

    console.log("ok - payment ledger execution updates are monotonic");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testCompletionScorePrefersPaidDeliveryReliability() {
  const { buildAgentCompletionScore } = await import(pathToFileURL(controlPlaneEntry).href);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const sessionId = "session_agent_reputation";
  const hireRequests = {
    requests: Array.from({ length: 100 }, (_, index) => ({
      requestId: `hire_raw_failed_${index}`,
      sessionId,
      requestType: "paid_execution",
      submittedAtIso: new Date(nowMs - index * 1000).toISOString(),
      status: "pending"
    }))
  };
  const paymentLedgerFile = {
    entries: [
      {
        ledgerId: "pay_verified_return",
        createdAtIso: nowIso,
        updatedAtIso: nowIso,
        agentId: "reputation-agent--session_agent_reputation",
        sessionId,
        pricingMode: "fixed-exact",
        rail: "base-usdc",
        networkId: "eip155:8453",
        assetSymbol: "USDC",
        amountUsd: "0.25",
        transactionHashes: ["0x1"],
        paymentStatus: "settled",
        executionStatus: "completed",
        returnStatus: "accepted"
      },
      {
        ledgerId: "pay_verified_return_settlement_retry",
        createdAtIso: nowIso,
        updatedAtIso: new Date(nowMs - 1000).toISOString(),
        agentId: "reputation-agent--session_agent_reputation",
        sessionId,
        pricingMode: "fixed-exact",
        rail: "base-usdc",
        networkId: "eip155:8453",
        assetSymbol: "USDC",
        amountUsd: "0.25",
        transactionHashes: ["0x2"],
        paymentStatus: "settlement_failed",
        executionStatus: "completed",
        returnStatus: "accepted",
        errorCode: "settlement_retryable"
      },
      {
        ledgerId: "pay_activation_probe_ignored",
        createdAtIso: nowIso,
        updatedAtIso: new Date(nowMs - 2000).toISOString(),
        agentId: "reputation-agent--session_agent_reputation",
        sessionId,
        resource: "https://www.santaclawz.ai/api/activation-lane/probe",
        pricingMode: "fixed-exact",
        rail: "base-usdc",
        networkId: "eip155:8453",
        assetSymbol: "USDC",
        amountUsd: "0.25",
        transactionHashes: ["0x3"],
        paymentStatus: "return_rejected",
        executionStatus: "failed",
        returnStatus: "rejected"
      },
      {
        ledgerId: "pay_seller_readiness_purpose_ignored",
        createdAtIso: nowIso,
        updatedAtIso: new Date(nowMs - 2500).toISOString(),
        agentId: "reputation-agent--session_agent_reputation",
        sessionId,
        purpose: "seller_readiness_test",
        resource: "https://api.santaclawz.ai/api/x402/proof?sessionId=session_agent_reputation",
        pricingMode: "fixed-exact",
        rail: "base-usdc",
        networkId: "eip155:8453",
        assetSymbol: "USDC",
        amountUsd: "0.25",
        transactionHashes: [],
        paymentStatus: "authorization_verified",
        executionStatus: "submitted",
        returnStatus: "none"
      },
      {
        ledgerId: "pay_platform_timeout_ignored",
        createdAtIso: nowIso,
        updatedAtIso: new Date(nowMs - 3000).toISOString(),
        agentId: "reputation-agent--session_agent_reputation",
        sessionId,
        pricingMode: "fixed-exact",
        rail: "base-usdc",
        networkId: "eip155:8453",
        assetSymbol: "USDC",
        amountUsd: "0.25",
        transactionHashes: ["0x4"],
        paymentStatus: "execution_failed",
        executionStatus: "failed",
        returnStatus: "none",
        errorCode: "relay_timeout"
      },
      {
        ledgerId: "pay_legacy_activation_amount_ignored",
        createdAtIso: nowIso,
        updatedAtIso: new Date(nowMs - 3250).toISOString(),
        agentId: "reputation-agent--session_agent_reputation",
        sessionId,
        resource: "https://api.santaclawz.ai/api/x402/proof?sessionId=session_agent_reputation",
        pricingMode: "fixed-exact",
        rail: "base-usdc",
        networkId: "eip155:8453",
        assetSymbol: "USDC",
        amountUsd: "0.002001",
        transactionHashes: [],
        paymentStatus: "authorization_verified",
        executionStatus: "submitted",
        returnStatus: "none"
      },
      {
        ledgerId: "pay_settled_without_delivery_is_visible_unresolved",
        createdAtIso: nowIso,
        updatedAtIso: new Date(nowMs - 3500).toISOString(),
        agentId: "reputation-agent--session_agent_reputation",
        sessionId,
        resource: "https://api.santaclawz.ai/api/x402/proof?sessionId=session_agent_reputation",
        pricingMode: "fixed-exact",
        rail: "base-usdc",
        networkId: "eip155:8453",
        assetSymbol: "USDC",
        amountUsd: "0.25",
        transactionHashes: ["0x4b"],
        paymentStatus: "settled",
        executionStatus: "not_started",
        returnStatus: "none"
      },
      {
        ledgerId: "pay_worker_ack_timeout_counts_against_delivery",
        createdAtIso: nowIso,
        updatedAtIso: new Date(nowMs - 4000).toISOString(),
        agentId: "reputation-agent--session_agent_reputation",
        sessionId,
        pricingMode: "fixed-exact",
        rail: "base-usdc",
        networkId: "eip155:8453",
        assetSymbol: "USDC",
        amountUsd: "0.25",
        transactionHashes: ["0x5"],
        paymentStatus: "execution_completed",
        executionStatus: "submitted",
        returnStatus: "none",
        deliveryReceipt: {
          stage: "relay_timeout",
          target: "santaclawz-relay://agent/reputation-agent--session_agent_reputation",
          occurredAtIso: new Date(nowMs - 4000).toISOString(),
          platformRelayTimeoutMs: 120000,
          errorCode: "relay_return_timeout_after_worker_ack",
          errorMessage: "Timed out waiting for agent relay response after worker acknowledgement."
        }
      }
    ]
  };

  const score = buildAgentCompletionScore(hireRequests, sessionId, Date.now(), { paymentLedgerFile });
  assert.equal(score.source, "payment-ledger");
  assert.equal(score.evaluatedJobCount, 4);
  assert.equal(score.completedJobCount, 2);
  assert.equal(score.failedJobCount, 2);
  assert.equal(score.pendingJobCount, undefined);
  assert.equal(score.successRatePct, 50);
  assert.equal(score.label, "2/4 paid deliveries");

  const activationOnlyScore = buildAgentCompletionScore({
    requests: [
      {
        requestId: "hire_activation_only",
        agentId: "reputation-agent--session_agent_reputation",
        sessionId,
        requestType: "paid_execution",
        submittedAtIso: nowIso,
        status: "failed",
        payment: {
          status: "authorized",
          activationLane: true
        }
      }
    ]
  }, sessionId, Date.now(), {
    paymentLedgerFile: {
      entries: paymentLedgerFile.entries.filter((entry) =>
        entry.ledgerId === "pay_seller_readiness_purpose_ignored" ||
        entry.ledgerId === "pay_legacy_activation_amount_ignored"
      )
    }
  });
  assert.equal(activationOnlyScore.evaluatedJobCount, 0);
  assert.equal(activationOnlyScore.completedJobCount, 0);
  assert.equal(activationOnlyScore.failedJobCount, 0);
  assert.equal(activationOnlyScore.label, "No paid jobs yet");

  console.log("ok - completion score prefers paid delivery reliability");
}

async function testArtifactReceiptsUseRequestIndexInsteadOfGlobalScan() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-artifact-receipt-index-"));
  try {
    const { ArtifactStore } = await import(pathToFileURL(artifactStoreEntry).href);
    const store = new ArtifactStore(path.join(workspaceDir, "artifacts"));
    await store.ensureDirs();

    await store.createReceipt({
      requestId: "hire_indexed_receipts",
      deliveryMode: "external_reference",
      filename: "report.md",
      contentType: "text/markdown",
      artifactDigestSha256: "a".repeat(64),
      artifactSizeBytes: 128,
      artifactUrl: "https://example.com/report.md",
      baseUrl: "http://127.0.0.1:3000"
    });

    const legacyReceiptDir = path.join(workspaceDir, "artifacts", "receipts");
    await writeFile(path.join(legacyReceiptDir, "receipt_legacy_unindexed.json"), JSON.stringify({
      receiptId: "receipt_legacy_unindexed",
      requestId: "hire_legacy_only",
      createdAtIso: new Date().toISOString(),
      updatedAtIso: new Date().toISOString(),
      deliveredAtIso: new Date().toISOString(),
      deliveryMode: "external_reference",
      transport: "external_url",
      scanPolicy: "external_unverified",
      digestRequired: true,
      buyerAcceptanceRequired: true,
      buyerAcceptanceStatus: "pending",
      filename: "legacy.md",
      contentType: "text/markdown",
      artifactDigestSha256: "b".repeat(64),
      artifactSizeBytes: 256,
      artifactUrl: "https://example.com/legacy.md",
      manifestDigestSha256: "c".repeat(64),
      tokenHashSha256: "d".repeat(64)
    }, null, 2), "utf8");

    const indexed = await store.receiptsForRequest("hire_indexed_receipts");
    assert.equal(indexed.length, 1);
    assert.equal(indexed[0].requestId, "hire_indexed_receipts");

    const unindexed = await store.receiptsForRequest("hire_legacy_only");
    assert.equal(unindexed.length, 0);

    console.log("ok - artifact receipts use request index instead of global scan");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testHostedBasePaymentsRequireMinimumFacilitationFee() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-indexer-facilitation-floor-test-"));
  const port = await reservePort();
  const hangingRpcPort = await reservePort();
  const hangingRpcServer = createServer((_request, _response) => {
    // Intentionally never respond. x402 plan generation must not depend on live RPC by default.
  });
  await new Promise((resolve) => hangingRpcServer.listen(hangingRpcPort, "127.0.0.1", resolve));
  const server = startServer(workspaceDir, port, {
    CLAWZ_X402_BASE_FACILITATOR_URL: "https://x402-zeko.example",
    CLAWZ_X402_MIN_NETWORK_FACILITATION_FEE_USD: "0.002",
    CLAWZ_X402_BASE_RPC_URLS: `http://127.0.0.1:${hangingRpcPort}`,
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

    const underFloorPlanStartedAt = Date.now();
    const underFloorPlan = await requestJson(`${baseUrl}/api/x402/plan?sessionId=session_demo_enterprise`);
    assert.ok(
      Date.now() - underFloorPlanStartedAt < 1000,
      "x402 plan should use the deterministic facilitator floor without waiting on RPC by default"
    );
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
    await new Promise((resolve) => hangingRpcServer.close(resolve));
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function testHostedExactFeeSplitPaymentRequirementCarriesSplitAmounts() {
  const { buildAgentX402RuntimeContext } = await import("../dist/apps/indexer/src/x402-adapter.js");
  const runtime = buildAgentX402RuntimeContext({
    baseUrl: "https://api.santaclawz.ai",
    serviceNetworkId: "zeko:test",
    plan: {
      agentId: "code-audit-agent--session_agent_test",
      sessionId: "session_agent_test",
      serviceId: "santaclawz-agent:code-audit-agent--session_agent_test",
      pricingMode: "fixed-exact",
      settlementTrigger: "upfront",
      proofBundleUrl: "https://api.santaclawz.ai/api/x402/proof?sessionId=session_agent_test",
      verifyProofUrl: "https://api.santaclawz.ai/api/x402/proof?sessionId=session_agent_test",
      rails: [
        {
          rail: "base-usdc",
          settlementRail: "evm",
          networkId: "eip155:8453",
          assetSymbol: "USDC",
          assetDecimals: 6,
          assetStandard: "erc20",
          assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1FC80745F8c0acfeEb8C4128bC20A622d1D6ef22",
          amountUsd: "0.25",
          settlementModel: "x402-exact-evm-fee-split-v1",
          executionMode: "settle-first",
          facilitatorMode: "hosted",
          facilitatorUrl: "https://x402-zeko.example",
          ready: true,
          missing: [],
          notes: []
        }
      ],
      feePreviewByRail: [
        {
          rail: "base-usdc",
          grossAmountUsd: "0.25",
          sellerNetAmountUsd: "0.238845",
          protocolFeeAmountUsd: "0.011155",
          nominalProtocolFeeAmountUsd: "0.000025",
          networkFacilitationFeeAmountUsd: "0.011155",
          feeBasis: "network-facilitation-minimum",
          sellerPayTo: "0x1FC80745F8c0acfeEb8C4128bC20A622d1D6ef22",
          protocolFeeRecipient: "0xF787fF44c5e80c8165e1B4FB156411e2d42c91B2",
          feeBps: 10
        }
      ],
      protocolOwnerFeePolicy: {
        enabled: true,
        feeBps: 10,
        settlementModel: "fee-on-reserve-v1",
        appliesTo: ["santaclawz-marketplace"],
        recipientByRail: {
          "base-usdc": "0xF787fF44c5e80c8165e1B4FB156411e2d42c91B2"
        }
      }
    }
  });

  assert.ok(runtime, "runtime should be available for a ready hosted exact fee-split rail");
  const accept = runtime.paymentRequired.accepts[0];
  const feeSplit = accept.extensions.evm.feeSplit;
  assert.equal(accept.amount, "250000");
  assert.equal(accept.extensions.evm.amountUnit, "atomic");
  assert.equal(accept.settlementModel, "x402-exact-evm-fee-split-v1");
  assert.equal(feeSplit.grossAmount, "250000");
  assert.equal(feeSplit.sellerAmount, "238845");
  assert.equal(feeSplit.protocolFeeAmount, "11155");
  assert.equal(feeSplit.sellerPayTo, "0x1FC80745F8c0acfeEb8C4128bC20A622d1D6ef22");
  assert.equal(feeSplit.protocolFeePayTo, "0xF787fF44c5e80c8165e1B4FB156411e2d42c91B2");

  console.log("ok - hosted exact fee-split payment requirement carries seller and protocol fee amounts");
}

async function testSellerReputationRequiresBuyerDeliveryContract() {
  const { paidExecutionTerminalOutcome } = await import("../dist/apps/indexer/src/control-plane.js");
  const verifiedSellerReturnWithBuyerDelivery = {
    requestType: "paid_execution",
    status: "completed",
    submittedAtIso: new Date().toISOString(),
    operationalStatus: {
      relayDeliveryStatus: "failed",
      agentExecutionStatus: "completed"
    },
    protocolReturn: {
      status: "completed",
      execution: {
        completionClassification: "agent_completed_verified"
      },
      verifiedOutput: {
        packageHash: "a".repeat(64),
        deliverableCount: 1,
        filesProducedCount: 1,
        checksPerformedCount: 1,
        zekoAttestationIncluded: false,
        buyerVisibleOutputs: [
          {
            name: "answer.md",
            contentType: "text/markdown",
            text: "Buyer-readable result.",
            sha256: "b".repeat(64)
          }
        ]
      }
    }
  };
  const verifiedSellerReturnWithoutBuyerDelivery = {
    ...verifiedSellerReturnWithBuyerDelivery,
    protocolReturn: {
      ...verifiedSellerReturnWithBuyerDelivery.protocolReturn,
      verifiedOutput: {
        ...verifiedSellerReturnWithBuyerDelivery.protocolReturn.verifiedOutput,
        buyerVisibleOutputs: []
      }
    }
  };
  const verifiedSellerReturnWithDeliverableReference = {
    ...verifiedSellerReturnWithBuyerDelivery,
    protocolReturn: {
      ...verifiedSellerReturnWithBuyerDelivery.protocolReturn,
      verifiedOutput: {
        ...verifiedSellerReturnWithBuyerDelivery.protocolReturn.verifiedOutput,
        buyerVisibleOutputs: [],
        deliverableReferenceCount: 1
      }
    }
  };
  const emptySellerReturn = {
    ...verifiedSellerReturnWithBuyerDelivery,
    protocolReturn: {
      ...verifiedSellerReturnWithBuyerDelivery.protocolReturn,
      execution: {
        completionClassification: "agent_completed_empty"
      }
    }
  };

  assert.equal(paidExecutionTerminalOutcome(verifiedSellerReturnWithBuyerDelivery), "completed");
  assert.equal(paidExecutionTerminalOutcome(verifiedSellerReturnWithDeliverableReference), "completed");
  assert.equal(paidExecutionTerminalOutcome(verifiedSellerReturnWithoutBuyerDelivery), "failed");
  assert.equal(paidExecutionTerminalOutcome(emptySellerReturn), "failed");

  console.log("ok - seller reputation requires verified buyer delivery contract");
}

async function testPaidLifecycleReducerInvariants() {
  const { reduceSantaClawzPaidLifecycle } = await import("../../../packages/protocol/dist/hire/lifecycle.js");

  const deliveredSettled = reduceSantaClawzPaidLifecycle({
    paymentStatus: "settled",
    settlementStatus: "settled",
    agentExecutionStatus: "completed",
    proofStatus: "return_validated",
    sellerExecutionCompleted: true,
    buyerDeliveryAvailable: true,
    buyerComplete: true,
    paymentSettled: true
  });
  assert.equal(deliveredSettled.protocolState, "DELIVERED_SETTLED");
  assert.equal(deliveredSettled.terminal, true);
  assert.equal(deliveredSettled.paymentFinality, "settled");
  assert.equal(deliveredSettled.paymentFinalityPending, false);
  assert.equal(deliveredSettled.statePollingRequired, false);
  assert.equal(deliveredSettled.buyerAction, "view_delivery");
  assert.equal(deliveredSettled.sellerOutcome, "completed");
  assert.equal(deliveredSettled.operatorObligation, "none");

  const deliveredAwaitingSettlement = reduceSantaClawzPaidLifecycle({
    paymentStatus: "authorization_verified",
    settlementStatus: "authorized",
    agentExecutionStatus: "completed",
    proofStatus: "return_validated",
    sellerExecutionCompleted: true,
    buyerDeliveryAvailable: true,
    buyerComplete: false,
    paymentAuthorized: true,
    paymentSettled: false
  });
  assert.equal(deliveredAwaitingSettlement.protocolState, "DELIVERED_AWAITING_SETTLEMENT");
  assert.equal(deliveredAwaitingSettlement.terminal, false);
  assert.equal(deliveredAwaitingSettlement.paymentFinality, "pending");
  assert.equal(deliveredAwaitingSettlement.paymentFinalityPending, true);
  assert.equal(deliveredAwaitingSettlement.statePollingRequired, true);
  assert.equal(deliveredAwaitingSettlement.recommendedPollAfterMs, 2000);
  assert.equal(deliveredAwaitingSettlement.buyerAction, "view_delivery");
  assert.equal(deliveredAwaitingSettlement.sellerOutcome, "completed");
  assert.equal(deliveredAwaitingSettlement.operatorObligation, "settle_payment");
  assert.equal(deliveredAwaitingSettlement.operatorAnswer.operatorActionRequired, true);
  assert.equal(deliveredAwaitingSettlement.operatorAnswer.reconciliationRequired, false);
  assert.equal(deliveredAwaitingSettlement.operatorAnswer.operatorReconciliationRequired, false);
  assert.equal(deliveredAwaitingSettlement.buyerAnswer.canCreateFreshPayment, false);
  assert.equal(deliveredAwaitingSettlement.buyerAnswer.canRetrySamePaymentPayload, false);

  const deliveredSettlementFailed = reduceSantaClawzPaidLifecycle({
    paymentStatus: "settlement_failed",
    settlementStatus: "failed",
    agentExecutionStatus: "completed",
    proofStatus: "return_validated",
    sellerExecutionCompleted: true,
    buyerDeliveryAvailable: true,
    buyerComplete: true,
    paymentAuthorized: true,
    paymentSettled: false
  });
  assert.equal(deliveredSettlementFailed.protocolState, "DELIVERED_SETTLEMENT_FAILED_REQUIRES_RECONCILIATION");
  assert.equal(deliveredSettlementFailed.terminal, false);
  assert.equal(deliveredSettlementFailed.paymentFinality, "requires_reconciliation");
  assert.equal(deliveredSettlementFailed.paymentFinalityPending, false);
  assert.equal(deliveredSettlementFailed.statePollingRequired, true);
  assert.equal(deliveredSettlementFailed.recommendedPollAfterMs, 5000);
  assert.equal(deliveredSettlementFailed.buyerAction, "view_delivery");
  assert.equal(deliveredSettlementFailed.sellerOutcome, "completed");
  assert.equal(deliveredSettlementFailed.operatorObligation, "reconcile_platform_state");
  assert.equal(deliveredSettlementFailed.operatorAnswer.operatorActionRequired, true);
  assert.equal(deliveredSettlementFailed.operatorAnswer.reconciliationRequired, true);
  assert.equal(deliveredSettlementFailed.operatorAnswer.operatorReconciliationRequired, true);
  assert.equal(deliveredSettlementFailed.buyerAnswer.canCreateFreshPayment, false);
  assert.equal(deliveredSettlementFailed.sellerAnswer.reputationImpact, "none");

  const executionCompletedWithoutSettlement = reduceSantaClawzPaidLifecycle({
    paymentStatus: "execution_completed",
    settlementStatus: "authorized",
    agentExecutionStatus: "completed",
    proofStatus: "return_validated",
    sellerExecutionCompleted: true,
    buyerDeliveryAvailable: true,
    buyerComplete: false,
    paymentAuthorized: true,
    paymentSettled: false
  });
  assert.equal(executionCompletedWithoutSettlement.protocolState, "DELIVERED_AWAITING_SETTLEMENT");
  assert.equal(executionCompletedWithoutSettlement.operatorObligation, "settle_payment");
  assert.equal(executionCompletedWithoutSettlement.buyerAnswer.canCreateFreshPayment, false);

  const authorizedWaiting = reduceSantaClawzPaidLifecycle({
    paymentStatus: "authorization_verified",
    relayDeliveryStatus: "acknowledged",
    agentExecutionStatus: "running_or_unknown",
    paymentAuthorized: true,
    safeToRetrySamePayload: true,
    platformTimedOutAfterWorkerAck: true
  });
  assert.equal(authorizedWaiting.protocolState, "AUTHORIZED_WAITING_FOR_DELIVERY");
  assert.equal(authorizedWaiting.terminal, false);
  assert.equal(authorizedWaiting.buyerAnswer.canCreateFreshPayment, false);
  assert.equal(authorizedWaiting.buyerAnswer.canRetrySamePaymentPayload, true);
  assert.equal(authorizedWaiting.operatorObligation, "reconcile_platform_state");

  const platformFailure = reduceSantaClawzPaidLifecycle({
    paymentStatus: "authorization_verified",
    relayDeliveryStatus: "failed",
    agentExecutionStatus: "submitted",
    paymentAuthorized: true,
    platformFailure: true
  });
  assert.equal(platformFailure.protocolState, "PLATFORM_FAILED_NO_SETTLEMENT");
  assert.equal(platformFailure.terminal, true);
  assert.equal(platformFailure.sellerOutcome, "not_at_fault");
  assert.equal(platformFailure.sellerAnswer.reputationImpact, "none");
  assert.equal(platformFailure.operatorObligation, "none");
  assert.equal(platformFailure.buyerAnswer.canCreateFreshPayment, true);

  const platformFailureAfterSettlement = reduceSantaClawzPaidLifecycle({
    paymentStatus: "settled",
    settlementStatus: "settled",
    relayDeliveryStatus: "failed",
    agentExecutionStatus: "submitted",
    paymentAuthorized: true,
    paymentSettled: true,
    platformFailure: true
  });
  assert.equal(platformFailureAfterSettlement.protocolState, "PLATFORM_FAILED_RECONCILE");
  assert.equal(platformFailureAfterSettlement.terminal, false);
  assert.equal(platformFailureAfterSettlement.operatorObligation, "reconcile_platform_state");
  assert.equal(platformFailureAfterSettlement.buyerAnswer.canCreateFreshPayment, false);

  const sellerFailed = reduceSantaClawzPaidLifecycle({
    paymentStatus: "authorization_verified",
    agentExecutionStatus: "failed",
    paymentAuthorized: true,
    hasFailure: true
  });
  assert.equal(sellerFailed.protocolState, "SELLER_FAILED_NO_SETTLEMENT");
  assert.equal(sellerFailed.terminal, true);
  assert.equal(sellerFailed.sellerOutcome, "failed");
  assert.equal(sellerFailed.sellerAnswer.reputationImpact, "seller_failure");
  assert.equal(sellerFailed.buyerAnswer.canCreateFreshPayment, true);

  const expiredNoCharge = reduceSantaClawzPaidLifecycle({
    paymentStatus: "authorization_verified",
    paymentAuthorized: true,
    expiredAuthorizationNoCharge: true,
    paymentPayloadRetryRejected: true
  });
  assert.equal(expiredNoCharge.protocolState, "EXPIRED_NO_CHARGE");
  assert.equal(expiredNoCharge.terminal, true);
  assert.equal(expiredNoCharge.buyerAction, "create_fresh_payment");
  assert.equal(expiredNoCharge.sellerOutcome, "not_at_fault");
  assert.equal(expiredNoCharge.buyerAnswer.canCreateFreshPayment, true);

  console.log("ok - paid lifecycle reducer preserves buyer/seller/operator invariants");
}

async function main() {
  await testPersistenceFlow();
  await testMalformedEventFlow();
  await testFocusedInteropSessionFlow();
  await testProtectedApiAuth();
  await testPublicOnboardingApiAuth();
  await testPublicBrowseLimitsDoNotStarveX402Preflight();
  await testOperatorCanDeleteLostKeyRegistration();
  await testMarketplaceTagsExposeDiscoveryAndSearch();
  await testZekoSocialAnchorHealthAndMembershipState();
  await testProofBackedAgentMessageBoard();
  await testExecutionIntentLifecycleAnchors();
  await testHireRouteRequiresSafeIngressAndPaymentState();
  await testMainnetFreeTestDisabledByDefault();
  await testStaleRelayDoesNotStayLive();
  await testRelayHireFailureCreatesDurableExecutionRecord();
  await testRelayPostAckTimeoutStaysPendingAndRetrySafe();
  await testRelayPreparedResponseResolvesInlineCompletion();
  await testOfficialRelayNormalizesLargeWorkerResponses();
  await testMissionAuthVerificationPersists();
  await testHostedWorkspaceRunApi();
  await testLegacyDemoProfileCanEnableBasePayments();
  await testPublicPayoutSummaryUsesAllTimeLedgerStats();
  await testPaymentLedgerPersistenceKeepsCumulativePayoutStatsWhenRowsArePruned();
  await testProductionPaymentLedgerUsesVerifiedBasePayoutBaseline();
  await testPaymentLedgerExecutionUpdatesAreMonotonic();
  await testCompletionScorePrefersPaidDeliveryReliability();
  await testArtifactReceiptsUseRequestIndexInsteadOfGlobalScan();
  await testHostedBasePaymentsRequireMinimumFacilitationFee();
  await testHostedExactFeeSplitPaymentRequirementCarriesSplitAmounts();
  await testSellerReputationRequiresBuyerDeliveryContract();
  await testPaidLifecycleReducerInvariants();
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
}
