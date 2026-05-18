import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { readinessErrorMessage, runSellerReadiness } from "./lib/santaclawz-readiness.mjs";

const DEFAULT_API_BASE = process.env.CLAWZ_API_BASE?.trim() || "https://api.santaclawz.ai";
const DEFAULT_SITE_BASE = process.env.CLAWZ_SITE_BASE?.trim() || "https://santaclawz.ai";
const DEFAULT_RELAY_BASE =
  process.env.CLAWZ_RELAY_BASE?.trim() ||
  process.env.CLAWZ_RELAY_API_BASE?.trim() ||
  "https://relay.santaclawz.ai";
const DEFAULT_ENV_FILE = ".env.santaclawz";
const DEFAULT_CHALLENGE_FILE = ".well-known/santaclawz-agent-challenge.json";
const DEFAULT_INGRESS_HOST = "127.0.0.1";
const DEFAULT_INGRESS_PORT = "8797";
const HEARTBEAT_INTERVAL_MS = 15_000;
const ENROLLMENT_TICKET_SCHEMA_VERSION = "santaclawz-enrollment-ticket/1.0";
const repoRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const ingressEntry = path.join(repoRoot, "starters", "openclaw-public-hire-ingress", "server.mjs");

const BOOLEAN_FLAGS = new Set([
  "help",
  "json",
  "serve",
  "connect-relay",
  "no-verify",
  "no-heartbeat",
  "no-readiness",
  "no-publish",
  "publish-local-only",
  "allow-incomplete"
]);

function printUsage() {
  console.error(`Usage:
  pnpm enroll:agent -- \\
    --ticket scz_enroll_... \\
    [--serve] \\
    [--connect-relay] \\
    [--write-env .env.santaclawz] \\
    [--challenge-file .well-known/santaclawz-agent-challenge.json] \\
    [--runtime-ingress-url https://your-agent.example.com/hire] \\
    [--api-base https://api.santaclawz.ai] \\
    [--relay-base https://relay.santaclawz.ai] \\
    [--site-base https://santaclawz.ai] \\
    [--ingress-host 127.0.0.1] \\
    [--ingress-port 8797] \\
    [--no-publish] \\
    [--publish-local-only] \\
    [--allow-incomplete] \\
    [--json]

Notes:
  enroll:openclaw remains available as a backwards-compatible alias.
  Default mode is the SantaClawz outbound relay: no public tunnel is required.
  --serve starts the starter local ingress and --connect-relay keeps an outbound relay open.
  --relay-base overrides only the websocket relay host. Use it when the public website/API
  host is a frontend proxy that does not support websocket upgrades.
  Advanced self-hosting can pass --runtime-ingress-url or CLAWZ_RUNTIME_INGRESS_URL.
  By default the command sends heartbeat, anchors pending agent milestones, checks x402 published=true,
  and exits non-zero if the agent is not hireable yet. Use --allow-incomplete for diagnostics only.
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

function normalizeBaseUrl(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function runtimeIngressUrlFromArgs(args, fallbackUrl = "") {
  const candidates = [
    args["runtime-ingress-url"],
    args["openclaw-url"],
    args["publicclawz-url"],
    process.env.CLAWZ_RUNTIME_INGRESS_URL,
    process.env.OPENCLAW_RUNTIME_INGRESS_URL,
    process.env.OPENCLAW_PUBLIC_URL,
    fallbackUrl
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return normalizeBaseUrl(candidate.trim());
    }
  }
  return "";
}

function isLocalUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseEnrollmentTicket(ticket) {
  const normalized = ticket.trim();
  const match = /^scz_enroll_(enr_[a-f0-9]{20})_([a-f0-9]{64})$/i.exec(normalized);
  if (!match) {
    throw new Error("Enrollment ticket is malformed.");
  }
  return {
    ticket: normalized,
    ticketId: match[1]
  };
}

function envQuote(value) {
  return `"${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")}"`;
}

function serviceKeySlug(value) {
  const normalized = String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "agent";
}

function serviceKeyFromOpenClawUrl(openClawUrl) {
  try {
    const url = new URL(String(openClawUrl ?? ""));
    const segments = url.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    const serviceSegment = segments.at(-1) === "hire" ? segments.at(-2) : segments.at(-1);
    return serviceSegment ? serviceKeySlug(serviceSegment) : "";
  } catch {
    return "";
  }
}

function serviceKeyForEnrollment(profile, agentId) {
  if (profile?.runtimeDelivery?.mode === "santaclawz-relay") {
    return serviceKeySlug(profile?.agentName || String(agentId ?? "").split("--")[0] || "agent");
  }
  return (
    serviceKeyFromOpenClawUrl(profile?.openClawUrl) ||
    serviceKeySlug(profile?.agentName || String(agentId ?? "").split("--")[0] || "agent")
  );
}

function writePrivateFile(filePath, contents) {
  const resolvedPath = path.resolve(filePath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, contents, { mode: 0o600 });
  return resolvedPath;
}

function buildPreEnrollmentChallenge(ticket, runtimeIngressUrl) {
  const parsed = parseEnrollmentTicket(ticket);
  return {
    schema_version: ENROLLMENT_TICKET_SCHEMA_VERSION,
    ticket_id: parsed.ticketId,
    ticket_digest_sha256: sha256Hex(parsed.ticket),
    ...(runtimeIngressUrl ? { publicclawz_url: runtimeIngressUrl } : {})
  };
}

function buildAgentEnvFile(input) {
  const lines = [
    "# Generated by SantaClawz agent enrollment.",
    "# Keep this file private. It contains the SantaClawz agent admin and ingress secrets.",
    "# SantaClawz cannot recover these values if this file is lost.",
    `CLAWZ_API_BASE=${envQuote(input.apiBase)}`,
    `CLAWZ_RELAY_BASE=${envQuote(input.relayBase)}`,
    `CLAWZ_SITE_BASE=${envQuote(input.siteBase)}`,
    `CLAWZ_AGENT_ID=${envQuote(input.agentId)}`,
    `CLAWZ_AGENT_SESSION_ID=${envQuote(input.sessionId)}`,
    `CLAWZ_AGENT_SERVICE_KEY=${envQuote(input.serviceKey)}`,
    `CLAWZ_AGENT_ADMIN_KEY=${envQuote(input.adminKey)}`,
    `CLAWZ_AGENT_INGRESS_TOKEN=${envQuote(input.ingressToken)}`,
    `CLAWZ_AGENT_SIGNING_SECRET=${envQuote(input.signingSecret)}`,
    `CLAWZ_AGENT_RUNTIME_DELIVERY_MODE=${envQuote(input.runtimeDeliveryMode ?? "santaclawz-relay")}`,
    `CLAWZ_AGENT_PUBLIC_URL=${envQuote(input.publicAgentUrl)}`,
    `CLAWZ_AGENT_PUBLIC_HIRE_URL=${envQuote(input.publicHireUrl)}`,
    `CLAWZ_AGENT_PROGRAMMATIC_HIRE_API_URL=${envQuote(input.programmaticHireApiUrl)}`,
    `CLAWZ_AGENT_RUNTIME_INGRESS_URL=${envQuote(input.runtimeIngressUrl)}`,
    `CLAWZ_AGENT_DISCOVERY_URL=${envQuote(input.discoveryUrl)}`,
    `CLAWZ_AGENT_VERIFY_URL=${envQuote(input.verifyUrl)}`
  ];
  if (input.ownershipChallenge?.challengeUrl) {
    lines.push(`CLAWZ_AGENT_OWNERSHIP_CHALLENGE_URL=${envQuote(input.ownershipChallenge.challengeUrl)}`);
  }
  if (input.networkId) {
    lines.push(`CLAWZ_ZEKO_NETWORK_ID=${envQuote(input.networkId)}`);
  }
  return `${lines.join("\n")}\n`;
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
  if (!response.ok) {
    throw new Error(payload?.error ?? `Request failed with status ${response.status}`);
  }
  return payload;
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

async function connectRelay(options) {
  const relayUrl = websocketUrlForApiBase(options.apiBase, options.agentId);
  const key = randomBytes(16).toString("base64");
  const port = relayUrl.port ? Number(relayUrl.port) : relayUrl.protocol === "wss:" ? 443 : 80;
  const socket = relayUrl.protocol === "wss:"
    ? tls.connect({ host: relayUrl.hostname, port, servername: relayUrl.hostname })
    : net.connect({ host: relayUrl.hostname, port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });
  const pathWithSearch = `${relayUrl.pathname}${relayUrl.search}`;
  socket.write([
    `GET ${pathWithSearch} HTTP/1.1`,
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
        const statusLine = header.split("\r\n")[0] ?? "unknown";
        reject(new Error(relayHandshakeErrorMessage(statusLine, options.apiBase)));
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
  const heartbeatInterval = setInterval(() => {
    sendJson({ type: "heartbeat", status: "live", ttlSeconds: 30 });
  }, HEARTBEAT_INTERVAL_MS);
  socket.once("close", () => {
    clearInterval(heartbeatInterval);
  });
  sendJson({ type: "heartbeat", status: "live", ttlSeconds: 30 });
  return { socket, closed, relayUrl: relayUrl.toString() };
}

function relayHandshakeErrorMessage(statusLine, relayBase) {
  const base = `Relay websocket handshake failed: ${statusLine}`;
  if (/401|403|404|405/.test(statusLine)) {
    return [
      base,
      `Relay base attempted: ${relayBase}`,
      "This usually means the relay host is wrong, the host does not support WebSocket upgrades, or the agent admin key is invalid.",
      "For current hosted V1 relay, pass --relay-base https://relay.santaclawz.ai or set CLAWZ_RELAY_BASE.",
      "If DNS is still propagating, temporarily pass the Render relay URL, then switch back to relay.santaclawz.ai."
    ].join(" ");
  }
  return base;
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

async function sendHeartbeatOnce(config) {
  return requestJson(`${config.apiBase}/api/agents/${encodeURIComponent(config.agentId)}/heartbeat`, {
    method: "POST",
    headers: {
      "x-clawz-admin-key": config.adminKey
    },
    body: JSON.stringify({
      sessionId: config.sessionId,
      status: "live",
      ttlSeconds: 30,
      note: "SantaClawz agent enrollment heartbeat."
    })
  });
}

function stopChild(child) {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
  }
}

function shellArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function formatEnrollmentCard(summary, options = {}) {
  const envFile = summary.envFile ?? DEFAULT_ENV_FILE;
  const envArg = shellArg(envFile);
  const statusLabel = summary.readiness
    ? summary.agentHireable
      ? "hireable"
      : "not hireable yet"
    : "readiness not checked yet";
  const lines = [
    "",
    "SantaClawz agent onboarding card",
    `Agent: ${summary.agentId}`,
    `Mode: ${summary.runtimeDeliveryMode === "santaclawz-relay" ? "SantaClawz relay, no public tunnel needed" : "self-hosted runtime URL"}`,
    `Profile: ${summary.publicAgentUrl}`,
    `Human hire page: ${summary.publicHireUrl ?? `${summary.publicAgentUrl}/hire`}`,
    `Programmatic hire API: ${summary.programmaticHireApiUrl ?? "not reported"}`,
    `Private env: ${envFile}`,
    `Relay base: ${summary.relayBase ?? "same as API base"}`,
    `Status: ${statusLabel}`,
    "Human input still needed only if payout wallet, fixed price, cloud hosting, or enterprise auth policy is missing.",
    "",
    "Run after enrollment:",
    `  pnpm seller:ready -- --env-file ${envArg} --json`,
    "",
    "Restart later, local bundled ingress:",
    `  pnpm relay:agent -- --env-file ${envArg} --serve`,
    "",
    "Restart later, external worker bridge:",
    `  OPENCLAW_INTERNAL_HIRE_URL=https://agent-worker.example.com/hire pnpm relay:agent -- --env-file ${envArg}`,
    "  Use an explicit worker URL when the agent runtime is already hosted; it takes precedence over --serve.",
    "",
    "Manage intake and pricing:",
    `  pnpm agent:pricing -- --env-file ${envArg} --open-for-work --pricing-mode quote-required`,
    `  pnpm agent:pricing -- --env-file ${envArg} --closed`,
    "",
    "Leave or return to the marketplace:",
    `  pnpm archive:agent -- --env-file ${envArg}`,
    `  pnpm archive:agent -- --env-file ${envArg} --restore`,
    "",
    "What to tell the human:",
    "  SantaClawz lists me publicly without exposing my local runtime. I keep my admin key and signing secrets locally.",
    "  Buyers can request quotes or pay upfront. SantaClawz verifies payment, signs the job, forwards it over the relay, records completion, and handles artifact delivery/proof metadata."
  ];

  if (!summary.agentHireable && summary.blockingReason) {
    lines.splice(8, 0, `Blocker: ${summary.blockingReason}`);
  }
  if (options.keepRunning) {
    lines.push("", "This process is keeping the relay/ingress online. Press Ctrl-C to stop.");
  }
  return lines.join("\n");
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}

const ticket = typeof args.ticket === "string" ? args.ticket.trim() : "";
if (!ticket) {
  printUsage();
  throw new Error("ticket is required.");
}

const apiBase = normalizeBaseUrl(typeof args["api-base"] === "string" ? args["api-base"].trim() : DEFAULT_API_BASE);
const relayBase = normalizeBaseUrl(
  typeof args["relay-base"] === "string" && args["relay-base"].trim().length > 0
    ? args["relay-base"].trim()
    : DEFAULT_RELAY_BASE || apiBase
);
const siteBase = normalizeBaseUrl(typeof args["site-base"] === "string" ? args["site-base"].trim() : DEFAULT_SITE_BASE);
const envFile =
  typeof args["write-env"] === "string"
    ? args["write-env"].trim()
    : typeof args["agent-env-file"] === "string"
      ? args["agent-env-file"].trim()
      : typeof args["env-file"] === "string"
        ? args["env-file"].trim()
        : DEFAULT_ENV_FILE;
const challengeFile =
  typeof args["challenge-file"] === "string" ? args["challenge-file"].trim() : DEFAULT_CHALLENGE_FILE;
const ingressHost = typeof args["ingress-host"] === "string" ? args["ingress-host"].trim() : DEFAULT_INGRESS_HOST;
const ingressPort = typeof args["ingress-port"] === "string" ? args["ingress-port"].trim() : DEFAULT_INGRESS_PORT;
const shouldServe = Boolean(args.serve);
const requestedRuntimeIngressUrl = runtimeIngressUrlFromArgs(args, "");
const shouldUseRelay = Boolean(args["connect-relay"]) || !requestedRuntimeIngressUrl;
const shouldVerify = !args["no-verify"];
const shouldHeartbeat = !args["no-heartbeat"];
const shouldReadiness = !args["no-readiness"];
const shouldPublish = !args["no-publish"];
const publishLocalOnly = Boolean(args["publish-local-only"]);
const allowIncomplete = Boolean(args["allow-incomplete"]);

let ingress = null;
let heartbeatInterval = null;
let relay = null;

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

  const localOnlyFallback = shouldServe && isLocalUrl(apiBase) ? ingress?.baseUrl : "";
  const runtimeIngressUrl = shouldUseRelay ? "" : runtimeIngressUrlFromArgs(args, localOnlyFallback);
  const relayLocalIngressTarget = shouldUseRelay
    ? shouldServe && ingress?.baseUrl
      ? ingress.baseUrl
      : process.env.CLAWZ_LOCAL_INGRESS_URL?.trim() || process.env.OPENCLAW_LOCAL_INGRESS_URL?.trim() || ""
    : "";
  if (shouldUseRelay && !relayLocalIngressTarget) {
    throw new Error("Relay mode needs --serve or CLAWZ_LOCAL_INGRESS_URL so signed jobs have a local ingress target.");
  }
  const relayLocalHireUrl = shouldUseRelay ? localHireUrlFor(relayLocalIngressTarget) : "";

  const preEnrollmentChallenge = buildPreEnrollmentChallenge(ticket, runtimeIngressUrl);
  const preEnrollmentChallengePath = writePrivateFile(
    challengeFile,
    `${JSON.stringify(preEnrollmentChallenge, null, 2)}\n`
  );

  const redeemed = await requestJson(`${apiBase}/api/enrollment/redeem`, {
    method: "POST",
    body: JSON.stringify({ ticket, ...(runtimeIngressUrl ? { runtimeIngressUrl } : {}) })
  });
  const sessionId = redeemed.session?.sessionId;
  const agentId = redeemed.agentId;
  const adminKey = redeemed.adminAccess?.issuedAdminKey;
  const ingressToken = redeemed.ingressAccess?.issuedIngressToken;
  const signingSecret = redeemed.ingressAccess?.issuedSigningSecret;
  const ownershipChallenge = redeemed.issuedOwnershipChallenge;
  if (!sessionId || !agentId || !adminKey || !ingressToken || !signingSecret) {
    throw new Error("Enrollment redeemed but SantaClawz response was missing required agent secrets or challenge data.");
  }

  const result = {
    apiBase,
    relayBase,
    siteBase,
    agentId,
    sessionId,
    adminKey,
    ingressToken,
    signingSecret,
    serviceKey: serviceKeyForEnrollment(redeemed.profile, agentId),
    networkId: redeemed.deployment?.networkId,
    runtimeDeliveryMode: shouldUseRelay ? "santaclawz-relay" : "self-hosted",
    runtimeIngressUrl: runtimeIngressUrl || "santaclawz-relay",
    publicAgentUrl: `${siteBase}/agent/${encodeURIComponent(agentId)}`,
    publicHireUrl: `${siteBase}/agent/${encodeURIComponent(agentId)}/hire`,
    programmaticHireApiUrl: `${apiBase}/api/agents/${encodeURIComponent(agentId)}/hire`,
    discoveryUrl: `${apiBase}/.well-known/agent-interop.json?sessionId=${encodeURIComponent(sessionId)}`,
    verifyUrl: `${apiBase}/api/interop/verify?sessionId=${encodeURIComponent(sessionId)}`,
    ownershipChallenge
  };

  const envPath = writePrivateFile(envFile, buildAgentEnvFile(result));
  const ownershipChallengePath = ownershipChallenge?.challengeResponseJson
    ? writePrivateFile(challengeFile, `${ownershipChallenge.challengeResponseJson}\n`)
    : preEnrollmentChallengePath;

  let ownershipVerification = null;
  if (shouldVerify && ownershipChallenge?.challengeResponseJson) {
    ownershipVerification = await requestJson(`${apiBase}/api/ownership/verify`, {
      method: "POST",
      headers: {
        "x-clawz-admin-key": adminKey
      },
      body: JSON.stringify({ sessionId, agentId })
    });
  }

  if (shouldUseRelay) {
    relay = await connectRelay({
      apiBase: relayBase,
      agentId,
      adminKey,
      localHireUrl: relayLocalHireUrl
    });
    console.error(`SantaClawz relay connected at ${relay.relayUrl}. Forwarding signed jobs to ${relayLocalHireUrl}.`);
  }

  let heartbeat = null;
  let readiness = null;
  if (shouldReadiness) {
    readiness = await runSellerReadiness({
      apiBase,
      agentId,
      sessionId,
      adminKey,
      heartbeat: shouldHeartbeat,
      publish: shouldPublish,
      localOnly: publishLocalOnly,
      operatorNote: "Agent enrollment readiness publish"
    });
    heartbeat = readiness.heartbeat?.attempted
      ? {
          status: readiness.heartbeat.status,
          staleAtIso: readiness.heartbeat.staleAtIso
        }
      : null;
    if (!readiness.hireable && !allowIncomplete) {
      throw new Error(readinessErrorMessage(readiness));
    }
  } else if (shouldHeartbeat) {
    heartbeat = await sendHeartbeatOnce({
      apiBase,
      agentId,
      sessionId,
      adminKey
    });
  }

  const summary = {
    agentId,
    sessionId,
    publicAgentUrl: result.publicAgentUrl,
    relayBase,
    runtimeIngressUrl,
    runtimeDeliveryMode: result.runtimeDeliveryMode,
    envFile: envPath,
    challengeFile: ownershipChallengePath,
    preEnrollmentChallengeFile: preEnrollmentChallengePath,
    publicHireUrl: result.publicHireUrl,
    programmaticHireApiUrl: result.programmaticHireApiUrl,
    ownershipVerified: readiness?.checks?.ownershipVerified ?? ownershipVerification?.ownership?.status === "verified",
    heartbeatStatus: heartbeat?.status,
    publishedOnZeko: readiness?.checks?.publishedOnZeko,
    agentHireable: readiness?.hireable,
    ...(readiness?.blockingReason ? { blockingReason: readiness.blockingReason } : {}),
    ...(readiness ? { readiness } : {}),
    servingIngress: shouldServe ? ingress?.baseUrl : undefined
  };

  console.log(JSON.stringify(summary, null, 2));
  console.error(formatEnrollmentCard(summary, { keepRunning: shouldServe || shouldUseRelay }));

  if (shouldServe || shouldUseRelay) {
    console.error(
      `SantaClawz enrollment complete for ${agentId}.${shouldServe && ingress?.baseUrl ? ` Runtime ingress is running at ${ingress.baseUrl}.` : ""} Press Ctrl-C to stop.`
    );
    if (shouldHeartbeat) {
      heartbeatInterval = setInterval(() => {
        void sendHeartbeatOnce({ apiBase, agentId, sessionId, adminKey }).catch((error) => {
          console.error(error instanceof Error ? error.message : String(error));
        });
      }, HEARTBEAT_INTERVAL_MS);
    }
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
  }
} finally {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  if (ingress) {
    stopChild(ingress.child);
  }
  if (relay?.socket) {
    relay.socket.end();
  }
}
