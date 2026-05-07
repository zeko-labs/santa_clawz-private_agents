import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const serverEntry = path.join(repoRoot, "apps", "indexer", "dist", "apps", "indexer", "src", "server.js");
const enrollEntry = path.join(repoRoot, "scripts", "enroll-openclaw-agent.mjs");
const heartbeatEntry = path.join(repoRoot, "scripts", "agent-heartbeat.mjs");
const ingressEntry = path.join(repoRoot, "starters", "openclaw-public-hire-ingress", "server.mjs");
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

function startIngress(agentDir, port) {
  const stdout = [];
  const stderr = [];
  const envFile = path.join(agentDir, ".env.santaclawz");
  const challengeFile = path.join(agentDir, ".well-known", "santaclawz-agent-challenge.json");
  const auditLog = path.join(agentDir, "hire-ingress-audit.log");
  const child = spawn(
    "node",
    [
      ingressEntry,
      "--agent-env-file",
      envFile,
      "--challenge-file",
      challengeFile,
      "--host",
      "127.0.0.1",
      "--port",
      String(port)
    ],
    {
      cwd: agentDir,
      env: {
        ...process.env,
        CLAWZ_AGENT_QUOTE_AMOUNT_USD: "0.20",
        CLAWZ_AGENT_QUOTE_SUMMARY: "Smoke ingress quote for a SantaClawz/OpenClaw job.",
        CLAWZ_AGENT_AUDIT_LOG: auditLog
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  return {
    child,
    stdout,
    stderr,
    envFile,
    challengeFile,
    auditLog,
    baseUrl: `http://127.0.0.1:${port}`
  };
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
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

function runNodeJson(entry, args, options = {}) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn("node", [entry, ...args], {
      cwd: options.cwd ?? repoRoot,
      env: {
        ...process.env,
        ...(options.env ?? {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("exit", (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`${path.basename(entry)} failed with ${exitCode}\n${stderr.join("")}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.join("")));
      } catch (error) {
        reject(new Error(`Could not parse ${path.basename(entry)} JSON output:\n${stdout.join("")}\n${String(error)}`));
      }
    });
  });
}

async function loadEnvFile(filePath) {
  const contents = await readFile(filePath, "utf8");
  const env = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function main() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-cli-smoke-indexer-"));
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "clawz-cli-smoke-agent-"));
  const indexerPort = await reservePort();
  const ingressPort = await reservePort();
  const indexer = startIndexer(workspaceDir, indexerPort);
  const ingress = startIngress(agentDir, ingressPort);

  try {
    const baseUrl = `http://127.0.0.1:${indexerPort}`;
    await waitForJson(`${baseUrl}/ready`, SERVER_READY_TIMEOUT_MS, indexer);
    await waitForJson(`${ingress.baseUrl}/health`, SERVER_READY_TIMEOUT_MS, ingress);

    const ticket = await requestJson(`${baseUrl}/api/enrollment/tickets`, {
      method: "POST",
      body: JSON.stringify({
        agentName: "OpenClaw CLI Enrollment Smoke",
        headline: "CLI enrolled OpenClaw ingress returning signed quote packages.",
        representedPrincipal: "SantaClawz smoke operator",
        publicClawUrl: ingress.baseUrl,
        openClawUrl: ingress.baseUrl,
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
        },
        socialAnchorPolicy: {
          mode: "shared-batched"
        },
        trustModeId: "private",
        preferredProvingLocation: "client"
      })
    });
    assert.equal(ticket.status, 200);
    assert.match(ticket.payload.ticket, /^scz_enroll_/);

    const enrollment = await runNodeJson(enrollEntry, [
      "--api-base",
      baseUrl,
      "--site-base",
      "http://127.0.0.1:5173",
      "--ticket",
      ticket.payload.ticket,
      "--write-env",
      ingress.envFile,
      "--challenge-file",
      ingress.challengeFile
    ]);
    const enrollmentEnv = await loadEnvFile(ingress.envFile);
    const registration = {
      ...enrollment,
      adminKey: enrollmentEnv.CLAWZ_AGENT_ADMIN_KEY,
      ingressToken: enrollmentEnv.CLAWZ_AGENT_INGRESS_TOKEN,
      signingSecret: enrollmentEnv.CLAWZ_AGENT_SIGNING_SECRET
    };

    assert.equal(typeof registration.agentId, "string");
    assert.equal(typeof registration.adminKey, "string");
    assert.equal(typeof registration.ingressToken, "string");
    assert.equal(typeof registration.signingSecret, "string");
    assert.notEqual(registration.ingressToken, registration.signingSecret);
    assert.equal(registration.ownershipVerified, true);

    const published = await requestJson(`${baseUrl}/api/events/ingest`, {
      method: "POST",
      body: JSON.stringify({
        id: `evt_cli_smoke_published_${Date.now()}`,
        type: "TurnFinalized",
        occurredAtIso: new Date().toISOString(),
        payload: {
          sessionId: registration.sessionId,
          turnId: "turn_cli_smoke_001"
        }
      })
    });
    assert.equal(published.status, 202);

    const firstAnchor = await requestJson(`${baseUrl}/api/social/anchors/settle`, {
      method: "POST",
      headers: { "x-clawz-admin-key": registration.adminKey },
      body: JSON.stringify({
        sessionId: registration.sessionId,
        agentId: registration.agentId,
        localOnly: true
      })
    });
    assert.equal(firstAnchor.status, 200);
    assert.ok(firstAnchor.payload.anchoredCount > 0);

    const heartbeat = await runNodeJson(heartbeatEntry, ["--env-file", ingress.envFile, "--ttl-seconds", "10", "--once"]);
    assert.equal(heartbeat.status, "live");

    const quote = await requestJson(`${baseUrl}/api/agents/${encodeURIComponent(registration.agentId)}/hire`, {
      method: "POST",
      body: JSON.stringify({
        taskPrompt: "Quote this real CLI-enrolled OpenClaw ingress flow.",
        requesterContact: "smoke@example.com"
      })
    });
    assert.equal(quote.status, 200);
    assert.equal(quote.payload.status, "quoted");
    assert.equal(quote.payload.protocolReturn.status, "quoted");
    assert.equal(quote.payload.protocolReturn.quote.amountUsd, "0.20");
    assert.equal(quote.payload.protocolReturn.quote.currency, "USDC");

    const quoteAnchor = await requestJson(`${baseUrl}/api/social/anchors/settle`, {
      method: "POST",
      headers: { "x-clawz-admin-key": registration.adminKey },
      body: JSON.stringify({
        sessionId: registration.sessionId,
        agentId: registration.agentId,
        localOnly: true
      })
    });
    assert.equal(quoteAnchor.status, 200);
    assert.equal(
      quoteAnchor.payload.recentBatches.some((batch) => batch.candidateKinds.includes("quote-returned")),
      true
    );

    console.log("ok - OpenClaw CLI enrollment smoke passed");
    console.log(`agentId=${registration.agentId}`);
    console.log("flow=ticket -> template ingress -> one CLI enroll -> env/challenge -> verify -> publish -> anchor -> heartbeat -> quote -> anchor quote");
  } finally {
    await stopProcess(indexer.child);
    await stopProcess(ingress.child);
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
}

await main();
