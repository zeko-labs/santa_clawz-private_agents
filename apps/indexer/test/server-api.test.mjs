import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverEntry = fileURLToPath(new URL("../dist/apps/indexer/src/server.js", import.meta.url));
const verifierEntry = fileURLToPath(new URL("../dist/apps/indexer/src/verify-agent-proof.js", import.meta.url));
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

async function stopHttpServer(server) {
  await new Promise((resolve) => {
    server.close(resolve);
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
    const adminKey = registered.payload.adminAccess.issuedAdminKey;
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

async function main() {
  await testPersistenceFlow();
  await testMalformedEventFlow();
  await testFocusedInteropSessionFlow();
  await testProtectedApiAuth();
  await testPublicOnboardingApiAuth();
  await testMissionAuthVerificationPersists();
  await testLegacyDemoProfileCanEnableBasePayments();
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
}
