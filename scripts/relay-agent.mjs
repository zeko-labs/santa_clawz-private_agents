import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { applyEnvFile, normalizeBaseUrl, postHeartbeat } from "./lib/santaclawz-readiness.mjs";

const DEFAULT_API_BASE = process.env.CLAWZ_API_BASE?.trim() || "https://api.santaclawz.ai";
const DEFAULT_ENV_FILE = ".env.santaclawz";
const DEFAULT_CHALLENGE_FILE = ".well-known/santaclawz-agent-challenge.json";
const DEFAULT_INGRESS_HOST = "127.0.0.1";
const DEFAULT_INGRESS_PORT = "8797";
const HEARTBEAT_INTERVAL_MS = 15_000;
const repoRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const ingressEntry = path.join(repoRoot, "starters", "openclaw-public-hire-ingress", "server.mjs");

const BOOLEAN_FLAGS = new Set(["help", "serve", "json", "no-heartbeat"]);

function printUsage() {
  console.error(`Usage:
  pnpm relay:agent -- \\
    --env-file .env.santaclawz \\
    [--serve] \\
    [--local-hire-url http://127.0.0.1:8797/hire] \\
    [--api-base https://api.santaclawz.ai] \\
    [--ingress-host 127.0.0.1] \\
    [--ingress-port 8797] \\
    [--challenge-file .well-known/santaclawz-agent-challenge.json] \\
    [--no-heartbeat] \\
    [--json]

Notes:
  Use this after one-time enrollment. It reads the private .env.santaclawz file,
  reconnects the SantaClawz outbound relay, and keeps heartbeat status live.
  --serve starts the bundled local public-hire ingress starter.
  --local-hire-url points relay traffic at an already running local /hire endpoint.
`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      continue;
    }
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}. Pass --env-file .env.santaclawz from a completed enrollment.`);
  }
  return value;
}

function websocketUrlForApiBase(apiBase, agentId) {
  const url = new URL("/api/agent-relay/connect", apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("agentId", agentId);
  return url;
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

function localHireUrlFor(baseUrl) {
  const url = new URL(baseUrl);
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  url.pathname = normalizedPath.endsWith("/hire")
    ? normalizedPath
    : `${normalizedPath.length > 0 ? normalizedPath : ""}/hire`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function handleRelayMessage(message, localHireUrl, sendJson) {
  if (!message || typeof message !== "object" || message.type !== "hire_request") {
    return;
  }
  const request = message.request && typeof message.request === "object" ? message.request : {};
  try {
    const response = await fetch(localHireUrl, {
      method: "POST",
      headers: request.headers && typeof request.headers === "object" ? request.headers : {},
      body: typeof request.body === "string" ? request.body : "{}"
    });
    sendJson({
      type: "hire_response",
      messageId: message.messageId,
      statusCode: response.status,
      body: await response.text()
    });
  } catch (error) {
    sendJson({
      type: "hire_response",
      messageId: message.messageId,
      statusCode: 502,
      body: JSON.stringify({
        schema_version: "santaclawz-return/1.0",
        request_id: (() => {
          try {
            const parsed = JSON.parse(typeof request.body === "string" ? request.body : "{}");
            return typeof parsed.request_id === "string" ? parsed.request_id : "unknown";
          } catch {
            return "unknown";
          }
        })(),
        status: "failed",
        agent_private: true,
        incident_id: `relay_forward_${Date.now()}`,
        error: error instanceof Error ? error.message : "relay forward failed"
      })
    });
  }
}

async function connectRelay(options) {
  const relayUrl = websocketUrlForApiBase(options.apiBase, options.agentId);
  const key = randomBytes(16).toString("base64");
  const port = relayUrl.port ? Number(relayUrl.port) : relayUrl.protocol === "wss:" ? 443 : 80;
  const socket =
    relayUrl.protocol === "wss:"
      ? tls.connect({ host: relayUrl.hostname, port, servername: relayUrl.hostname })
      : net.connect({ host: relayUrl.hostname, port });

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });

  socket.write([
    `GET ${relayUrl.pathname}${relayUrl.search} HTTP/1.1`,
    `Host: ${relayUrl.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    `X-ClawZ-Admin-Key: ${options.adminKey}`,
    "\r\n"
  ].join("\r\n"));

  let handshakeBuffer = Buffer.alloc(0);
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      const end = handshakeBuffer.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      socket.off("data", onData);
      const header = handshakeBuffer.subarray(0, end).toString("utf8");
      if (!header.startsWith("HTTP/1.1 101")) {
        reject(new Error(`Relay websocket handshake failed: ${header.split("\r\n")[0] ?? "unknown"}`));
        return;
      }
      const rest = handshakeBuffer.subarray(end + 4);
      if (rest.length > 0) {
        socket.unshift(rest);
      }
      resolve();
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });

  let frameBuffer = Buffer.alloc(0);
  const closed = new Promise((resolve) => {
    socket.once("close", resolve);
  });
  const sendJson = (payload) => {
    socket.write(encodeClientWebSocketFrame(payload));
  };
  socket.on("data", (chunk) => {
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
      if (opcode === 0x8) {
        socket.end();
        return;
      }
      if (opcode !== 0x1) {
        continue;
      }
      void handleRelayMessage(JSON.parse(payload.toString("utf8")), options.localHireUrl, sendJson);
    }
  });
  const relayHeartbeatInterval = setInterval(() => {
    sendJson({ type: "heartbeat", status: "live", ttlSeconds: 30 });
  }, HEARTBEAT_INTERVAL_MS);
  socket.once("close", () => {
    clearInterval(relayHeartbeatInterval);
  });
  sendJson({ type: "heartbeat", status: "live", ttlSeconds: 30 });
  return { socket, closed, relayUrl: relayUrl.toString() };
}

async function waitForHealth(baseUrl, logs, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    [
      `Timed out waiting for runtime ingress at ${baseUrl}/health`,
      lastError instanceof Error ? lastError.message : String(lastError ?? ""),
      logs.stderr.length > 0 ? logs.stderr.join("") : ""
    ].filter(Boolean).join("\n\n")
  );
}

function startIngress(options) {
  const stdout = [];
  const stderr = [];
  const child = spawn(
    "node",
    [
      ingressEntry,
      "--agent-env-file",
      options.envFile,
      "--challenge-file",
      options.challengeFile,
      "--host",
      options.host,
      "--port",
      options.port
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  return {
    child,
    stdout,
    stderr,
    baseUrl: `http://${options.host}:${options.port}`
  };
}

function stopChild(child) {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}

const envFile = typeof args["env-file"] === "string" ? args["env-file"].trim() : DEFAULT_ENV_FILE;
applyEnvFile(envFile);

const apiBase = normalizeBaseUrl(typeof args["api-base"] === "string" ? args["api-base"].trim() : DEFAULT_API_BASE);
const agentId = requireEnv("CLAWZ_AGENT_ID");
const sessionId = requireEnv("CLAWZ_AGENT_SESSION_ID");
const adminKey = requireEnv("CLAWZ_AGENT_ADMIN_KEY");
const challengeFile =
  typeof args["challenge-file"] === "string" ? args["challenge-file"].trim() : DEFAULT_CHALLENGE_FILE;
const ingressHost = typeof args["ingress-host"] === "string" ? args["ingress-host"].trim() : DEFAULT_INGRESS_HOST;
const ingressPort = typeof args["ingress-port"] === "string" ? args["ingress-port"].trim() : DEFAULT_INGRESS_PORT;
const shouldServe = Boolean(args.serve);
const shouldHeartbeat = !args["no-heartbeat"];

let ingress = null;
let relay = null;
let heartbeatInterval = null;

try {
  if (shouldServe) {
    ingress = startIngress({
      envFile,
      challengeFile,
      host: ingressHost,
      port: ingressPort
    });
    await waitForHealth(ingress.baseUrl, ingress);
  }

  const localHireUrl =
    typeof args["local-hire-url"] === "string" && args["local-hire-url"].trim().length > 0
      ? normalizeBaseUrl(args["local-hire-url"].trim())
      : shouldServe && ingress?.baseUrl
        ? localHireUrlFor(ingress.baseUrl)
        : process.env.CLAWZ_LOCAL_HIRE_URL?.trim() ||
          process.env.OPENCLAW_LOCAL_HIRE_URL?.trim() ||
          process.env.OPENCLAW_INTERNAL_HIRE_URL?.trim() ||
          "";

  if (!localHireUrl) {
    throw new Error("Relay resume needs --serve or --local-hire-url http://127.0.0.1:8797/hire.");
  }

  relay = await connectRelay({
    apiBase,
    agentId,
    adminKey,
    localHireUrl
  });

  if (shouldHeartbeat) {
    const firstHeartbeat = await postHeartbeat({
      apiBase,
      agentId,
      sessionId,
      adminKey,
      ttlSeconds: 30,
      heartbeatNote: "SantaClawz relay resume heartbeat."
    });
    if (!firstHeartbeat.ok) {
      throw new Error(firstHeartbeat.payload?.error ?? `Heartbeat failed with status ${firstHeartbeat.status}`);
    }
    heartbeatInterval = setInterval(() => {
      void postHeartbeat({
        apiBase,
        agentId,
        sessionId,
        adminKey,
        ttlSeconds: 30,
        heartbeatNote: "SantaClawz relay resume heartbeat."
      }).catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  const summary = {
    agentId,
    sessionId,
    apiBase,
    relayUrl: relay.relayUrl,
    localHireUrl,
    servingIngress: ingress?.baseUrl,
    heartbeat: shouldHeartbeat ? "live" : "skipped"
  };
  console.log(JSON.stringify(summary, null, 2));
  console.error(`SantaClawz relay connected for ${agentId}. Forwarding signed jobs to ${localHireUrl}. Press Ctrl-C to stop.`);

  await new Promise((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (ingress?.child) {
      ingress.child.once("exit", stop);
    }
    if (relay) {
      relay.closed.then(stop).catch(stop);
    }
  });
} finally {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  if (relay?.socket) {
    relay.socket.end();
  }
  if (ingress) {
    stopChild(ingress.child);
  }
}
