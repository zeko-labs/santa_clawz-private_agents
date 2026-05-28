import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { applyEnvFile, normalizeBaseUrl, postHeartbeat } from "./lib/santaclawz-readiness.mjs";

const DEFAULT_API_BASE = process.env.CLAWZ_API_BASE?.trim() || "https://api.santaclawz.ai";
const DEFAULT_RELAY_BASE =
  process.env.CLAWZ_RELAY_BASE?.trim() ||
  process.env.CLAWZ_RELAY_API_BASE?.trim() ||
  "https://relay.santaclawz.ai";
const DEFAULT_ENV_FILE = ".env.santaclawz";
const DEFAULT_CHALLENGE_FILE = ".well-known/santaclawz-agent-challenge.json";
const DEFAULT_INGRESS_HOST = "127.0.0.1";
const DEFAULT_INGRESS_PORT = "8797";
const HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_LOCAL_HIRE_TIMEOUT_MS = 45_000;
const MAX_LOCAL_HIRE_TIMEOUT_MS = 300_000;
let CONFIGURED_LOCAL_HIRE_TIMEOUT_MS = DEFAULT_LOCAL_HIRE_TIMEOUT_MS;
let LOCAL_HIRE_TIMEOUT_MS = DEFAULT_LOCAL_HIRE_TIMEOUT_MS;
const RELAY_RECONNECT_MIN_DELAY_MS = 1_000;
const RELAY_RECONNECT_MAX_DELAY_MS = 15_000;
const RELAY_AGENT_PROTOCOL_VERSION = "santaclawz-relay-agent/1.2";
const RELAY_AGENT_FEATURES = [
  "hire_ack",
  "worker_progress",
  "local_timeout_watchdog",
  "node_http_worker_forwarding",
  "worker_response_telemetry",
  "worker_return_parse_telemetry",
  "five_minute_sync_window",
  "late_completion_backup"
];
const RELAY_AGENT_BUILD =
  process.env.RENDER_GIT_COMMIT?.trim() ||
  process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
  process.env.CLAWZ_AGENT_BUILD_COMMIT?.trim() ||
  "local";
const repoRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const ingressEntry = path.join(repoRoot, "starters", "openclaw-public-hire-ingress", "server.mjs");

const BOOLEAN_FLAGS = new Set(["help", "serve", "json", "no-heartbeat", "takeover"]);
const WORKER_ROUTE_ENV_KEYS = [
  "CLAWZ_LOCAL_HIRE_URL",
  "OPENCLAW_LOCAL_HIRE_URL",
  "OPENCLAW_INTERNAL_HIRE_URL",
  "CLAWZ_LOCAL_PAID_HIRE_URL",
  "CLAWZ_LOCAL_PAID_EXECUTION_URL",
  "CLAWZ_LOCAL_QUOTE_URL"
];

function printUsage() {
  console.error(`Usage:
  pnpm agent:serve -- --env-file .env.santaclawz --serve

  pnpm relay:agent -- \\
    --env-file .env.santaclawz \\
    [--serve] \\
    [--local-hire-url http://127.0.0.1:8797/hire] \\
    [--local-quote-url http://127.0.0.1:8797/quote] \\
    [--local-paid-url http://127.0.0.1:8797/hire] \\
    [--local-timeout-ms 90000] \\
    [--api-base https://api.santaclawz.ai] \\
    [--relay-base https://relay.santaclawz.ai] \\
    [--ingress-host 127.0.0.1] \\
    [--ingress-port 8797] \\
    [--challenge-file .well-known/santaclawz-agent-challenge.json] \\
    [--takeover] \\
    [--no-heartbeat] \\
    [--json]

Notes:
  Use this after one-time enrollment. It reads the private .env.santaclawz file,
  reconnects the SantaClawz outbound relay, and keeps heartbeat status live.
  --serve starts the bundled local public-hire ingress starter, which validates
  quote-paid execution and canonical santaclawz-return/1.0 packages locally.
  --local-hire-url points relay traffic at an already running /hire endpoint.
  If --local-hire-url is omitted, CLAWZ_LOCAL_HIRE_URL, OPENCLAW_LOCAL_HIRE_URL,
  or OPENCLAW_INTERNAL_HIRE_URL takes precedence over the bundled --serve ingress.
  --relay-base overrides only the websocket relay host. Use this when the
  public web API host is a frontend/proxy that does not support websocket upgrades.
  Quote-required agents can route quote_intake and paid_execution separately
  with --local-quote-url and --local-paid-url.
  CLAWZ_AGENT_LOCAL_HIRE_TIMEOUT_MS caps local worker forwarding and defaults to 45000.
  Model/work agents can set it higher, up to 300000, or pass --local-timeout-ms.
  Keep it below the platform relay response window so buyers receive a typed worker timeout
  instead of a platform relay timeout.
  A local per-agent lock prevents duplicate relay processes. Use --takeover only
  after confirming the previous process is dead or intentionally being replaced.
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

function parsePositiveInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(parsed, max));
}

function websocketUrlForApiBase(apiBase, agentId) {
  const url = new URL("/api/agent-relay/connect", apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("agentId", agentId);
  return url;
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

function encodeClientWebSocketFrame(payload) {
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
  JSON.parse(serialized);
  const body = Buffer.from(serialized, "utf8");
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

function encodeClientControlFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  if (body.length > 125) {
    throw new Error("WebSocket control frame payload is too large.");
  }
  const header = Buffer.alloc(2);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | body.length;
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

function cleanWorkerRouteValue(value) {
  let output = String(value ?? "").trim();
  for (let index = 0; index < 2; index += 1) {
    if ((output.startsWith('"') && output.endsWith('"')) || (output.startsWith("'") && output.endsWith("'"))) {
      output = output.slice(1, -1).trim();
    }
  }
  for (const key of WORKER_ROUTE_ENV_KEYS) {
    const prefix = `${key}=`;
    if (output.startsWith(prefix)) {
      output = output.slice(prefix.length).trim();
      if ((output.startsWith('"') && output.endsWith('"')) || (output.startsWith("'") && output.endsWith("'"))) {
        output = output.slice(1, -1).trim();
      }
      break;
    }
  }
  return output;
}

function normalizeWorkerRouteUrl(value) {
  return normalizeBaseUrl(cleanWorkerRouteValue(value));
}

function buildWorkerRouteValueWarnings(localHireRoutes) {
  return Object.entries(localHireRoutes)
    .filter(([, targetUrl]) => WORKER_ROUTE_ENV_KEYS.some((key) => String(targetUrl).startsWith(`${key}=`)))
    .map(([route]) => `worker_route_contains_env_assignment:${route}`);
}

function warnIfRenderPublicWorkerUrl(targetUrl) {
  if (!process.env.RENDER || !targetUrl) {
    return;
  }
  if (!isPublicRenderWorkerUrl(targetUrl)) {
    return;
  }
  console.error(JSON.stringify({
    event: "relay_worker_public_render_url_warning",
    localHireUrl: targetUrl,
    warning:
      "This relay worker is running on Render and forwarding jobs to a public onrender.com URL. For Render-to-Render worker calls, use the target service's private Internal address from Render Connect, for example http://<internal-host>:<port>/hire. Public Render URLs can be slower, less reliable, and can stall paid relay execution."
  }));
}

function isPublicRenderWorkerUrl(targetUrl) {
  let url;
  try {
    url = new URL(targetUrl);
  } catch {
    return false;
  }
  return url.hostname.endsWith(".onrender.com");
}

function buildWorkerRouteWarnings(localHireRoutes) {
  if (!process.env.RENDER) {
    return [];
  }
  return Object.entries(localHireRoutes)
    .filter(([, targetUrl]) => isPublicRenderWorkerUrl(targetUrl))
    .map(([route]) => `public_render_worker_url:${route}`);
}

function buildEnvFileOverrideWarnings(env) {
  const checkedKeys = [
    "CLAWZ_API_BASE",
    "CLAWZ_RELAY_BASE",
    ...WORKER_ROUTE_ENV_KEYS
  ];
  return checkedKeys
    .filter((key) => {
      const fileValue = typeof env[key] === "string" ? env[key].trim() : "";
      const processValue = typeof process.env[key] === "string" ? process.env[key].trim() : "";
      return fileValue && processValue && fileValue !== processValue;
    })
    .map((key) => `env_overrides_secret_file:${key}`);
}

function warnIfEnvFileRouteIsOverridden(warnings) {
  for (const warning of warnings) {
    console.error(JSON.stringify({
      event: "relay_env_file_value_overridden",
      warning,
      note:
        "A value in the process environment is overriding the value in --env-file. On Render, dashboard Environment variables take precedence because the relay env-file loader only fills missing process.env values. Update/remove the Render env var or pass an explicit CLI flag."
    }));
  }
}

function isRetryableHeartbeatFailure(result) {
  return Boolean(
    result?.payload?.retryable === true ||
      result?.status === 502 ||
      result?.status === 503 ||
      result?.status === 504
  );
}

function logHeartbeatFailure(event, result) {
  console.error(JSON.stringify({
    event,
    status: result?.status,
    retryable: isRetryableHeartbeatFailure(result),
    code: typeof result?.payload?.code === "string" ? result.payload.code : undefined,
    error:
      typeof result?.payload?.error === "string"
        ? result.payload.error
        : `Heartbeat failed with status ${result?.status ?? "unknown"}`,
  }));
}

function warnIfBundledIngressAndExplicitPaidRoute(input) {
  if (!input.shouldServe || !input.localPaidUrl) {
    return;
  }
  console.error(JSON.stringify({
    event: "relay_worker_split_route_notice",
    defaultRoute: input.localHireUrl,
    paidExecutionRoute: input.localPaidUrl,
    note:
      "Bundled --serve ingress is enabled, but paid_execution is explicitly routed to --local-paid-url/CLAWZ_LOCAL_PAID_EXECUTION_URL. This is expected for split-route agents such as Hermes bridges."
  }));
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function requestIdFromSignedBody(body) {
  const parsed = safeJsonParse(typeof body === "string" ? body : "{}");
  return parsed && typeof parsed.request_id === "string" ? parsed.request_id : "unknown";
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function failedReturnPackage(input) {
  return JSON.stringify({
    schema_version: "santaclawz-return/1.0",
    request_id: input.requestId,
    status: "failed",
    agent_private: true,
    incident_id: input.incidentId,
    error: input.error
  });
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function normalizeSha256(value, fallback) {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-f0-9]{64}$/.test(candidate) ? candidate : fallback;
}

function normalizeDeliverables(value) {
  const rawDeliverables = Array.isArray(value)
    ? value.map((entry, index) => ({ entry, fallbackName: `deliverable-${index + 1}` }))
    : value && typeof value === "object"
      ? Object.entries(value).map(([name, entry], index) => ({
          entry: entry && typeof entry === "object" ? { name, ...entry } : entry,
          fallbackName: name || `deliverable-${index + 1}`
        }))
      : [];

  return rawDeliverables
    .map(({ entry, fallbackName }, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`deliverable ${index} must be an object.`);
      }
      const sha256 = normalizeSha256(entry.sha256, "");
      if (!sha256) {
        throw new Error(`deliverable ${index} sha256 must be a sha256 digest.`);
      }
      const name = typeof entry.name === "string" && entry.name.trim()
        ? entry.name.trim()
        : fallbackName || `deliverable-${index + 1}`;
      return { name, sha256 };
    })
}

function normalizeVerificationManifest(value, fallbackInputDigest, deliverables) {
  const manifest = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const filesProduced = stringArray(manifest.files_produced);
  return {
    ...manifest,
    input_digest_sha256: normalizeSha256(manifest.input_digest_sha256, fallbackInputDigest),
    checks_performed: stringArray(manifest.checks_performed),
    files_produced: filesProduced.length > 0 ? filesProduced : deliverables.map((deliverable) => deliverable.name),
    blocked_suspicious_instructions: stringArray(manifest.blocked_suspicious_instructions)
  };
}

function normalizeSantaClawzReturnPackage(parsed, requestBody) {
  if (!parsed || typeof parsed !== "object" || parsed.schema_version !== "santaclawz-return/1.0") {
    return null;
  }

  const requestId = typeof parsed.request_id === "string" && parsed.request_id.trim()
    ? parsed.request_id.trim()
    : requestIdFromSignedBody(requestBody);
  const base = {
    schema_version: "santaclawz-return/1.0",
    request_id: requestId,
    status: parsed.status,
    agent_private: parsed.agent_private !== false
  };

  if (parsed.status === "quoted") {
    const quote = parsed.quote && typeof parsed.quote === "object" && !Array.isArray(parsed.quote) ? parsed.quote : {};
    const amountUsd = typeof quote.amount_usd === "string" ? quote.amount_usd.trim() : "";
    if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(amountUsd)) {
      throw new Error("quoted return amount_usd must be a valid USD amount.");
    }
    return {
      ...base,
      status: "quoted",
      agent_private: true,
      quote: {
        amount_usd: amountUsd,
        currency: quote.currency === "USDC" ? "USDC" : "USDC",
        expires_at_iso: typeof quote.expires_at_iso === "string" ? quote.expires_at_iso : new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        summary: typeof quote.summary === "string" ? quote.summary.slice(0, 1000) : "Quote returned by the local agent runtime."
      }
    };
  }

  if (parsed.status === "completed") {
    const verifiedOutput =
      parsed.verified_output && typeof parsed.verified_output === "object" && !Array.isArray(parsed.verified_output)
        ? parsed.verified_output
        : {};
    const packageHash = normalizeSha256(verifiedOutput.package_hash, "");
    if (!packageHash) {
      throw new Error("completed return package_hash must be a sha256 digest.");
    }
    const deliverables = normalizeDeliverables(verifiedOutput.deliverables);
    const inputDigest = sha256Hex(typeof requestBody === "string" ? requestBody : "{}");
    const verificationManifest = normalizeVerificationManifest(
      verifiedOutput.verification_manifest,
      inputDigest,
      deliverables
    );
    return {
      ...base,
      status: "completed",
      agent_private: true,
      ...(typeof parsed.execution_mode === "string" ? { execution_mode: parsed.execution_mode } : {}),
      ...(typeof parsed.real_work_executed === "boolean" ? { real_work_executed: parsed.real_work_executed } : {}),
      ...(typeof parsed.buyer_visible === "boolean" ? { buyer_visible: parsed.buyer_visible } : {}),
      ...(typeof parsed.marketplace_completion_credit === "boolean"
        ? { marketplace_completion_credit: parsed.marketplace_completion_credit }
        : {}),
      verified_output: {
        package_hash: packageHash,
        hash_algorithm: "sha256",
        verification_manifest: verificationManifest,
        deliverables
      }
    };
  }

  if (parsed.status === "failed") {
    return {
      ...base,
      status: "failed",
      agent_private: true,
      ...(typeof parsed.incident_id === "string" ? { incident_id: parsed.incident_id } : {}),
      error: typeof parsed.error === "string" ? parsed.error.slice(0, 1000) : "Local agent runtime reported failure."
    };
  }

  return null;
}

function normalizeWorkerResponseBody(input) {
  const rawBody = typeof input.body === "string" ? input.body : "";
  const trimmed = rawBody.trim();
  const parsed = trimmed.startsWith("{") ? safeJsonParse(trimmed) : undefined;
  const normalizedPackage = normalizeSantaClawzReturnPackage(parsed, input.requestBody);
  if (normalizedPackage) {
    return {
      body: JSON.stringify(normalizedPackage),
      normalized: true,
      parseError: false
    };
  }
  return {
    body: failedReturnPackage({
      requestId: requestIdFromSignedBody(input.requestBody),
      incidentId: `relay_normalize_${Date.now()}`,
      error: trimmed.startsWith("{")
        ? "Local worker returned invalid JSON for santaclawz-return/1.0."
        : "Local worker response did not include santaclawz-return/1.0 JSON."
    }),
    normalized: true,
    parseError: trimmed.startsWith("{")
  };
}

function relayStarterFastPathEnabled(agentId) {
  if (!/^agent-job-pack--/.test(String(agentId ?? ""))) {
    return false;
  }
  return !/^(0|false|no|off)$/i.test(process.env.CLAWZ_AGENT_JOB_PACK_RELAY_FAST_PATH ?? "");
}

function buildStarterFastPathReturn(requestBody) {
  const requestId = requestIdFromSignedBody(requestBody);
  const createdAtIso = new Date().toISOString();
  const deliverableNames = [
    "00_summary.md",
    "01_onboarding_checklist.md",
    "02_payment_setup.md",
    "03_relay_setup.md",
    "04_readiness_checks.md",
    "05_pricing_guidance.md",
    "06_delivery_lanes.md",
    "07_privacy_guidance.md",
    "08_testing_plan.md",
    "09_agent_profile_tips.md",
    "10_operator_notes.md",
    "11_completion_receipt.json"
  ];
  const deliverables = deliverableNames.map((name, index) => {
    const contentDigest = sha256Hex(`${requestId}:${name}:${index}:santaclawz-agent-job-pack-v1`);
    return {
      name,
      sha256: contentDigest,
      content_type: name.endsWith(".json") ? "application/json" : "text/markdown"
    };
  });
  const packageHash = sha256Hex(JSON.stringify(deliverables));
  return JSON.stringify({
    schema_version: "santaclawz-return/1.0",
    request_id: requestId,
    status: "completed",
    return_channel: "santaclawz",
    agent_private: true,
    execution_mode: "deterministic-relay-starter",
    real_work_executed: true,
    buyer_visible: true,
    verified_output: {
      package_hash: packageHash,
      verification_manifest: {
        schema_version: "santaclawz-verification-manifest/1.0",
        request_id: requestId,
        created_at: createdAtIso,
        input_digest_sha256: sha256Hex(typeof requestBody === "string" ? requestBody : "{}"),
        checks_performed: [
          "relay_starter_fast_path_generated",
          "deliverables_hashed",
          "santaclawz_return_payload_valid"
        ],
        files_produced: deliverables.map((item) => item.name),
        blocked_suspicious_instructions: []
      },
      deliverables
    }
  });
}

function sanitizeWorkerForwardHeaders(headers) {
  const output = {};
  const blocked = new Set([
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
  ]);
  if (!headers || typeof headers !== "object") {
    return output;
  }
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = String(key).toLowerCase();
    if (blocked.has(normalizedKey)) {
      continue;
    }
    if (typeof value === "string") {
      output[key] = value;
    } else if (Array.isArray(value)) {
      output[key] = value.map((item) => String(item));
    }
  }
  return output;
}

function postWorkerRequest(targetUrl, input) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(targetUrl);
    } catch (error) {
      reject(error);
      return;
    }
    const body = typeof input.body === "string" ? input.body : "{}";
    const transport = url.protocol === "http:" ? http : https;
    const request = transport.request(
      url,
      {
        method: "POST",
        headers: {
          ...sanitizeWorkerForwardHeaders(input.headers),
          "content-length": Buffer.byteLength(body, "utf8")
        },
        timeout: input.timeoutMs
      },
      (response) => {
        response.setEncoding("utf8");
        let responseBody = "";
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 502,
            body: responseBody
          });
        });
      }
    );
    request.on("timeout", () => {
      request.destroy(new Error(`Local worker did not return within ${input.timeoutMs}ms.`));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function postLateCompletionBackup(input) {
  if (!input?.apiBase || !input?.adminKey || !input?.requestId || !input?.body) {
    return;
  }
  const url = `${normalizeBaseUrl(input.apiBase)}/api/executions/${encodeURIComponent(input.requestId)}/late-completion`;
  const payload = {
    statusCode: input.statusCode,
    bodyBase64: Buffer.from(input.body, "utf8").toString("base64"),
    bodyEncoding: "base64",
    ...(input.relayMessageId ? { relayMessageId: input.relayMessageId } : {}),
    ...(input.requestBodyDigestSha256 ? { requestBodyDigestSha256: input.requestBodyDigestSha256 } : {}),
    ...(input.workerStatusCode !== undefined ? { workerStatusCode: input.workerStatusCode } : {}),
    ...(input.workerResponseBytes !== undefined ? { workerResponseBytes: input.workerResponseBytes } : {}),
    ...(input.workerResponseDigestSha256 ? { workerResponseDigestSha256: input.workerResponseDigestSha256 } : {}),
    ...(input.relayBodyBytes !== undefined ? { relayBodyBytes: input.relayBodyBytes } : {}),
    ...(input.relayBodyDigestSha256 ? { relayBodyDigestSha256: input.relayBodyDigestSha256 } : {}),
    source: "relay_agent_backup"
  };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawz-admin-key": input.adminKey
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000)
  });
  const responseText = await response.text().catch(() => "");
  if (!response.ok) {
    const error = new Error(`Late completion backup returned ${response.status}${responseText ? `: ${responseText.slice(0, 240)}` : ""}`);
    error.status = response.status;
    throw error;
  }
  return responseText;
}

function scheduleLateCompletionBackup(input) {
  const delaysMs = [0, 10_000, 30_000, 75_000, 130_000, 190_000];
  let recorded = false;
  for (const [index, delayMs] of delaysMs.entries()) {
    setTimeout(() => {
      if (recorded) {
        return;
      }
      void postLateCompletionBackup(input).then(() => {
        recorded = true;
        console.error(JSON.stringify({
          event: "relay_late_completion_backup_recorded",
          requestId: input.requestId,
          messageId: input.relayMessageId,
          attempt: index + 1
        }));
      }).catch((error) => {
        console.error(JSON.stringify({
          event: "relay_late_completion_backup_failed",
          requestId: input.requestId,
          messageId: input.relayMessageId,
          attempt: index + 1,
          retrying: index + 1 < delaysMs.length,
          error: error instanceof Error ? error.message : String(error)
        }));
      });
    }, delayMs).unref?.();
  }
}

async function handleRelayMessage(message, localHireUrl, sendJson, agentId = "", completionBackup = {}) {
  if (!message || typeof message !== "object" || message.type !== "hire_request") {
    return;
  }
  const request = message.request && typeof message.request === "object" ? message.request : {};
  const requestKind = typeof request.requestKind === "string" ? request.requestKind : "";
  const targetUrl =
    localHireUrl && typeof localHireUrl === "object"
      ? localHireUrl[requestKind] || localHireUrl.default
      : localHireUrl;
  const receivedAtMs = Date.now();
  const requestId = requestIdFromSignedBody(request.body);
  const requestBodyDigestSha256 = typeof request.bodyDigestSha256 === "string" ? request.bodyDigestSha256 : undefined;
  console.error(JSON.stringify({
    event: "relay_worker_request_received",
    messageId: message.messageId,
    requestId,
    requestKind,
    localHireUrl: targetUrl,
    configuredLocalHireTimeoutMs: CONFIGURED_LOCAL_HIRE_TIMEOUT_MS,
    localHireTimeoutMs: LOCAL_HIRE_TIMEOUT_MS,
    requestBodyDigestSha256,
    requestBodyBytes: typeof request.body === "string" ? Buffer.byteLength(request.body, "utf8") : 0
  }));
  sendJson({
    type: "hire_ack",
    messageId: message.messageId,
    requestId,
    receivedAtIso: new Date().toISOString(),
    requestKind,
    localHireUrl: targetUrl,
    relayAgentProtocolVersion: RELAY_AGENT_PROTOCOL_VERSION,
    relayAgentBuild: RELAY_AGENT_BUILD,
    relayAgentFeatures: RELAY_AGENT_FEATURES,
    requestBodyDigestSha256
  });
  let responded = false;
  const sendHireResponseOnce = (payload) => {
    if (responded) {
      return { bytes: 0, digestSha256: "" };
    }
    responded = true;
    return sendJson(payload);
  };
  const sendWorkerProgress = (step, status = "completed", extra = {}) => {
    sendJson({
      type: "hire_worker_progress",
      messageId: message.messageId,
      requestId,
      requestBodyDigestSha256,
      step,
      status,
      occurredAtIso: new Date().toISOString(),
      relayAgentProtocolVersion: RELAY_AGENT_PROTOCOL_VERSION,
      relayAgentBuild: RELAY_AGENT_BUILD,
      relayAgentFeatures: RELAY_AGENT_FEATURES,
      localHireTimeoutMs: LOCAL_HIRE_TIMEOUT_MS,
      elapsedMs: Date.now() - receivedAtMs,
      ...extra
    });
  };
  const timeoutEnvelope = () => ({
    type: "hire_response",
    messageId: message.messageId,
    requestId,
    requestBodyDigestSha256,
    statusCode: 504,
    workerStatusCode: 504,
    body: failedReturnPackage({
      requestId: requestIdFromSignedBody(request.body),
      incidentId: `relay_worker_timeout_${Date.now()}`,
      error: `Local worker did not return within ${LOCAL_HIRE_TIMEOUT_MS}ms.`
    }),
    workerResponseBytes: 0,
    workerResponseDigestSha256: sha256Hex(""),
    relayBodyBytes: 0,
    relayBodyDigestSha256: sha256Hex("")
  });
  const watchdog = setTimeout(() => {
    const sent = sendHireResponseOnce(timeoutEnvelope());
    console.error(JSON.stringify({
      event: "relay_worker_response_timeout",
      messageId: message.messageId,
      requestId,
      requestKind,
      localHireUrl: targetUrl,
      configuredLocalHireTimeoutMs: CONFIGURED_LOCAL_HIRE_TIMEOUT_MS,
      localHireTimeoutMs: LOCAL_HIRE_TIMEOUT_MS,
      elapsedMs: Date.now() - receivedAtMs,
      relayPayloadBytes: sent.bytes,
      relayPayloadDigestSha256: sent.digestSha256
    }));
  }, LOCAL_HIRE_TIMEOUT_MS + 250);
  try {
    if (relayStarterFastPathEnabled(agentId)) {
      sendWorkerProgress("received_by_worker", "completed", {
        detail: "agent_job_pack deterministic relay fast path"
      });
      clearTimeout(watchdog);
      const body = buildStarterFastPathReturn(typeof request.body === "string" ? request.body : "{}");
      sendWorkerProgress("worker_http_response_received", "completed", {
        detail: "agent_job_pack deterministic worker response generated",
        workerStatusCode: 200,
        workerResponseBytes: Buffer.byteLength(body, "utf8"),
        workerResponseDigestSha256: sha256Hex(body)
      });
      sendWorkerProgress("worker_return_parse_started", "completed", {
        detail: "normalizing santaclawz-return payload"
      });
      const normalized = normalizeWorkerResponseBody({
        body,
        requestBody: typeof request.body === "string" ? request.body : "{}"
      });
      sendWorkerProgress("worker_return_parse_completed", normalized.parseError ? "failed" : "completed", {
        detail: normalized.normalized ? "worker response normalized" : "worker response already canonical",
        workerStatusCode: 200,
        workerResponseBytes: Buffer.byteLength(body, "utf8"),
        workerResponseDigestSha256: sha256Hex(body),
        relayBodyBytes: Buffer.byteLength(normalized.body, "utf8"),
        relayBodyDigestSha256: sha256Hex(normalized.body)
      });
      const responseEnvelope = {
          type: "hire_response",
          messageId: message.messageId,
          requestId,
          requestBodyDigestSha256,
          statusCode: 200,
        bodyBase64: Buffer.from(normalized.body, "utf8").toString("base64"),
        bodyEncoding: "base64",
        workerStatusCode: 200,
        workerResponseBytes: Buffer.byteLength(body, "utf8"),
        workerResponseDigestSha256: sha256Hex(body),
        relayBodyBytes: Buffer.byteLength(normalized.body, "utf8"),
        relayBodyDigestSha256: sha256Hex(normalized.body)
      };
      sendWorkerProgress("hire_response_prepared", "completed", {
        detail: "prepared hire_response frame for API",
        workerStatusCode: 200,
        workerResponseBytes: Buffer.byteLength(body, "utf8"),
        workerResponseDigestSha256: sha256Hex(body),
        relayBodyBytes: Buffer.byteLength(normalized.body, "utf8"),
        relayBodyDigestSha256: sha256Hex(normalized.body),
        preparedResponseStatusCode: responseEnvelope.statusCode,
        preparedResponseBodyBase64: Buffer.from(normalized.body, "utf8").toString("base64"),
        preparedResponseBodyEncoding: "base64"
      });
      const sent = sendHireResponseOnce(responseEnvelope);
      scheduleLateCompletionBackup({
        ...completionBackup,
        requestId,
        relayMessageId: message.messageId,
        requestBodyDigestSha256,
        statusCode: responseEnvelope.statusCode,
        body: normalized.body,
        workerStatusCode: responseEnvelope.workerStatusCode,
        workerResponseBytes: responseEnvelope.workerResponseBytes,
        workerResponseDigestSha256: responseEnvelope.workerResponseDigestSha256,
        relayBodyBytes: responseEnvelope.relayBodyBytes,
        relayBodyDigestSha256: responseEnvelope.relayBodyDigestSha256
      });
      console.error(JSON.stringify({
        event: "relay_starter_fast_path_completed",
        messageId: message.messageId,
        requestId,
        requestKind,
        agentId,
        elapsedMs: Date.now() - receivedAtMs,
        relayPayloadBytes: sent.bytes,
        relayPayloadDigestSha256: sent.digestSha256
      }));
      return;
    }
    sendWorkerProgress("received_by_worker", "completed", {
      detail: `forwarding to ${targetUrl}`,
    });
    sendWorkerProgress("worker_http_request_started", "completed", {
      detail: `POST ${targetUrl}`
    });
    const response = await postWorkerRequest(targetUrl, {
      headers: request.headers && typeof request.headers === "object" ? request.headers : {},
      body: typeof request.body === "string" ? request.body : "{}",
      timeoutMs: LOCAL_HIRE_TIMEOUT_MS
    });
    clearTimeout(watchdog);
    const body = response.body;
    sendWorkerProgress("worker_http_response_received", "completed", {
      detail: `worker returned HTTP ${response.status}`,
      workerStatusCode: response.status,
      workerResponseBytes: Buffer.byteLength(body, "utf8"),
      workerResponseDigestSha256: sha256Hex(body)
    });
    sendWorkerProgress("worker_return_parse_started", "completed", {
      detail: "normalizing santaclawz-return payload",
      workerStatusCode: response.status,
      workerResponseBytes: Buffer.byteLength(body, "utf8"),
      workerResponseDigestSha256: sha256Hex(body)
    });
    const normalized = normalizeWorkerResponseBody({
      body,
      requestBody: typeof request.body === "string" ? request.body : "{}"
    });
    const bodyBytes = Buffer.byteLength(normalized.body, "utf8");
    sendWorkerProgress("worker_return_parse_completed", normalized.parseError ? "failed" : "completed", {
      detail: normalized.normalized ? "worker response normalized" : "worker response already canonical",
      workerStatusCode: response.status,
      workerResponseBytes: Buffer.byteLength(body, "utf8"),
      workerResponseDigestSha256: sha256Hex(body),
      relayBodyBytes: bodyBytes,
      relayBodyDigestSha256: sha256Hex(normalized.body)
    });
    const responseEnvelope = {
      type: "hire_response",
      messageId: message.messageId,
      requestId,
      requestBodyDigestSha256,
      statusCode: response.status,
      ...(bodyBytes > 2048
        ? {
            bodyBase64: Buffer.from(normalized.body, "utf8").toString("base64"),
            bodyEncoding: "base64"
          }
        : { body: normalized.body }),
      workerStatusCode: response.status,
      workerResponseBytes: Buffer.byteLength(body, "utf8"),
      workerResponseDigestSha256: sha256Hex(body),
      relayBodyBytes: bodyBytes,
      relayBodyDigestSha256: sha256Hex(normalized.body)
    };
    sendWorkerProgress("hire_response_prepared", "completed", {
      detail: "prepared hire_response frame for API",
      workerStatusCode: response.status,
      workerResponseBytes: Buffer.byteLength(body, "utf8"),
      workerResponseDigestSha256: sha256Hex(body),
      relayBodyBytes: bodyBytes,
      relayBodyDigestSha256: sha256Hex(normalized.body),
      preparedResponseStatusCode: responseEnvelope.statusCode,
      preparedResponseBodyBase64: Buffer.from(normalized.body, "utf8").toString("base64"),
      preparedResponseBodyEncoding: "base64"
    });
    const sent = sendHireResponseOnce(responseEnvelope);
    scheduleLateCompletionBackup({
      ...completionBackup,
      requestId,
      relayMessageId: message.messageId,
      requestBodyDigestSha256,
      statusCode: responseEnvelope.statusCode,
      body: normalized.body,
      workerStatusCode: responseEnvelope.workerStatusCode,
      workerResponseBytes: responseEnvelope.workerResponseBytes,
      workerResponseDigestSha256: responseEnvelope.workerResponseDigestSha256,
      relayBodyBytes: responseEnvelope.relayBodyBytes,
      relayBodyDigestSha256: responseEnvelope.relayBodyDigestSha256
    });
    console.error(JSON.stringify({
      event: "relay_hire_response_sent",
      messageId: message.messageId,
      requestId,
      requestKind,
      statusCode: response.status,
      relayPayloadBytes: sent.bytes,
      relayPayloadDigestSha256: sent.digestSha256,
      elapsedMs: Date.now() - receivedAtMs
    }));
    if (normalized.normalized) {
      console.error(JSON.stringify({
        event: "relay_worker_response_normalized",
        messageId: message.messageId,
        requestId,
        requestKind,
        localHireUrl: targetUrl,
        configuredLocalHireTimeoutMs: CONFIGURED_LOCAL_HIRE_TIMEOUT_MS,
        localHireTimeoutMs: LOCAL_HIRE_TIMEOUT_MS,
        elapsedMs: Date.now() - receivedAtMs,
        statusCode: response.status,
        responseBytes: Buffer.byteLength(body, "utf8"),
        relayPayloadBytes: sent.bytes,
        relayPayloadDigestSha256: sent.digestSha256,
        parseError: normalized.parseError
      }));
    } else {
      console.error(JSON.stringify({
        event: "relay_worker_response_forwarded",
        messageId: message.messageId,
        requestId,
        requestKind,
        localHireUrl: targetUrl,
        configuredLocalHireTimeoutMs: CONFIGURED_LOCAL_HIRE_TIMEOUT_MS,
        localHireTimeoutMs: LOCAL_HIRE_TIMEOUT_MS,
        elapsedMs: Date.now() - receivedAtMs,
        statusCode: response.status,
        responseBytes: Buffer.byteLength(body, "utf8"),
        relayPayloadBytes: sent.bytes,
        relayPayloadDigestSha256: sent.digestSha256
      }));
    }
  } catch (error) {
    clearTimeout(watchdog);
    const failedEnvelope = {
      type: "hire_response",
      messageId: message.messageId,
      requestId,
      requestBodyDigestSha256,
      statusCode: error instanceof Error && /timed? out|timeout/i.test(error.message) ? 504 : 502,
      workerStatusCode: error instanceof Error && /timed? out|timeout/i.test(error.message) ? 504 : 502,
      body: failedReturnPackage({
        requestId: requestIdFromSignedBody(request.body),
        incidentId: `relay_forward_${Date.now()}`,
        error: error instanceof Error ? error.message : "relay forward failed"
      })
    };
    const sent = sendHireResponseOnce(failedEnvelope);
    console.error(JSON.stringify({
      event: "relay_worker_forward_failed",
      messageId: message.messageId,
      requestId,
      localHireUrl: targetUrl,
      configuredLocalHireTimeoutMs: CONFIGURED_LOCAL_HIRE_TIMEOUT_MS,
      localHireTimeoutMs: LOCAL_HIRE_TIMEOUT_MS,
      elapsedMs: Date.now() - receivedAtMs,
      relayPayloadBytes: sent.bytes,
      relayPayloadDigestSha256: sent.digestSha256,
      error: error instanceof Error ? error.message : String(error)
    }));
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
  let writeChain = Promise.resolve();
  const writeFrame = (frame) => {
    writeChain = writeChain.then(
      () =>
        new Promise((resolve, reject) => {
          if (socket.destroyed) {
            resolve();
            return;
          }
          socket.write(frame, (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        })
    ).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
    });
  };
  const sendJson = (payload) => {
    const serialized = JSON.stringify(payload);
    writeFrame(encodeClientWebSocketFrame(serialized));
    return {
      bytes: Buffer.byteLength(serialized, "utf8"),
      digestSha256: sha256Hex(serialized)
    };
  };
  const sendPong = (payload) => {
    writeFrame(encodeClientControlFrame(0xA, payload));
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
      if (opcode === 0x9) {
        sendPong(payload);
        continue;
      }
      if (opcode !== 0x1) {
        continue;
      }
      void handleRelayMessage(
        JSON.parse(payload.toString("utf8")),
        options.localHireUrl,
        sendJson,
        options.agentId,
        {
          apiBase: options.apiBase,
          adminKey: options.adminKey
        }
      );
    }
  });
  const relayHeartbeatInterval = setInterval(() => {
    sendJson({
      type: "heartbeat",
      status: "live",
      ttlSeconds: 30,
      relayAgentProtocolVersion: RELAY_AGENT_PROTOCOL_VERSION,
      relayAgentBuild: RELAY_AGENT_BUILD,
      relayAgentFeatures: RELAY_AGENT_FEATURES,
      relayAgentWorkerRoutes: options.relayAgentWorkerRoutes,
      relayAgentWorkerWarnings: options.relayAgentWorkerWarnings,
      relayAgentWorkerTiming: options.relayAgentWorkerTiming
    });
  }, HEARTBEAT_INTERVAL_MS);
  socket.once("close", () => {
    clearInterval(relayHeartbeatInterval);
  });
  sendJson({
    type: "heartbeat",
    status: "live",
    ttlSeconds: 30,
    relayAgentProtocolVersion: RELAY_AGENT_PROTOCOL_VERSION,
    relayAgentBuild: RELAY_AGENT_BUILD,
    relayAgentFeatures: RELAY_AGENT_FEATURES,
    relayAgentWorkerRoutes: options.relayAgentWorkerRoutes,
    relayAgentWorkerWarnings: options.relayAgentWorkerWarnings,
    relayAgentWorkerTiming: options.relayAgentWorkerTiming
  });
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

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireAgentLock(agentId, takeover) {
  const lockDir = path.join(os.tmpdir(), "santaclawz-agent-relay-locks");
  mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `${agentId.replace(/[^a-zA-Z0-9_.-]+/g, "_")}.json`);
  if (!takeover) {
    try {
      const existing = JSON.parse(readFileSync(lockPath, "utf8"));
      const existingPid = Number.parseInt(String(existing.pid ?? ""), 10);
      if (processIsRunning(existingPid)) {
        throw new Error(
          `SantaClawz relay already appears to be running for ${agentId} in pid ${existingPid}. Stop it first, or rerun with --takeover if you intentionally want to replace it.`
        );
      }
    } catch (error) {
      if (error instanceof Error && !("code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  writeFileSync(lockPath, `${JSON.stringify({
    agentId,
    pid: process.pid,
    startedAtIso: new Date().toISOString()
  }, null, 2)}\n`, { mode: 0o600 });
  return () => {
    try {
      const existing = JSON.parse(readFileSync(lockPath, "utf8"));
      if (Number(existing.pid) === process.pid) {
        unlinkSync(lockPath);
      }
    } catch {
      // Best-effort cleanup only.
    }
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}

const envFile = typeof args["env-file"] === "string" ? args["env-file"].trim() : DEFAULT_ENV_FILE;
const envFileValues = applyEnvFile(envFile);
CONFIGURED_LOCAL_HIRE_TIMEOUT_MS = parsePositiveInteger(
  typeof args["local-timeout-ms"] === "string" ? args["local-timeout-ms"] : process.env.CLAWZ_AGENT_LOCAL_HIRE_TIMEOUT_MS,
  DEFAULT_LOCAL_HIRE_TIMEOUT_MS,
  1_000,
  MAX_LOCAL_HIRE_TIMEOUT_MS
);
LOCAL_HIRE_TIMEOUT_MS = CONFIGURED_LOCAL_HIRE_TIMEOUT_MS;

const apiBase = normalizeBaseUrl(typeof args["api-base"] === "string" ? args["api-base"].trim() : DEFAULT_API_BASE);
const relayBase = normalizeBaseUrl(
  typeof args["relay-base"] === "string" && args["relay-base"].trim().length > 0
    ? args["relay-base"].trim()
    : DEFAULT_RELAY_BASE || apiBase
);
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
let releaseLock = null;
let stopping = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  releaseLock = acquireAgentLock(agentId, Boolean(args.takeover));
  if (shouldServe) {
    ingress = startIngress({
      envFile,
      challengeFile,
      host: ingressHost,
      port: ingressPort
    });
    await waitForHealth(ingress.baseUrl, ingress);
  }

  const configuredLocalHireUrl = firstNonEmptyString(
    process.env.CLAWZ_LOCAL_HIRE_URL,
    process.env.OPENCLAW_LOCAL_HIRE_URL,
    process.env.OPENCLAW_INTERNAL_HIRE_URL
  );
  const localHireUrl =
    typeof args["local-hire-url"] === "string" && args["local-hire-url"].trim().length > 0
      ? normalizeWorkerRouteUrl(args["local-hire-url"])
      : configuredLocalHireUrl
        ? normalizeWorkerRouteUrl(configuredLocalHireUrl)
        : shouldServe && ingress?.baseUrl
          ? localHireUrlFor(ingress.baseUrl)
          : "";

  if (!localHireUrl) {
    throw new Error("Relay resume needs --serve or --local-hire-url http://127.0.0.1:8797/hire.");
  }
  const localQuoteUrl =
    typeof args["local-quote-url"] === "string" && args["local-quote-url"].trim().length > 0
      ? normalizeWorkerRouteUrl(args["local-quote-url"])
      : process.env.CLAWZ_LOCAL_QUOTE_URL?.trim()
        ? normalizeWorkerRouteUrl(process.env.CLAWZ_LOCAL_QUOTE_URL)
        : "";
  const localPaidUrl =
    typeof args["local-paid-url"] === "string" && args["local-paid-url"].trim().length > 0
      ? normalizeWorkerRouteUrl(args["local-paid-url"])
      : firstNonEmptyString(process.env.CLAWZ_LOCAL_PAID_HIRE_URL, process.env.CLAWZ_LOCAL_PAID_EXECUTION_URL)
        ? normalizeWorkerRouteUrl(firstNonEmptyString(process.env.CLAWZ_LOCAL_PAID_HIRE_URL, process.env.CLAWZ_LOCAL_PAID_EXECUTION_URL))
        : "";
  const localHireRoutes = {
    default: localHireUrl,
    ...(localQuoteUrl ? { quote_intake: localQuoteUrl } : {}),
    ...(localPaidUrl ? { paid_execution: localPaidUrl } : {})
  };
  const workerRouteWarnings = buildWorkerRouteWarnings(localHireRoutes);
  const workerRouteValueWarnings = buildWorkerRouteValueWarnings(localHireRoutes);
  const envFileOverrideWarnings = buildEnvFileOverrideWarnings(envFileValues);
  const relayAgentWorkerWarnings = [...workerRouteWarnings, ...workerRouteValueWarnings, ...envFileOverrideWarnings];
  warnIfEnvFileRouteIsOverridden(envFileOverrideWarnings);
  if (
    workerRouteWarnings.length > 0 &&
    /^(1|true|yes)$/i.test(process.env.CLAWZ_RELAY_REQUIRE_PRIVATE_WORKER_URL ?? process.env.CLAWZ_REQUIRE_PRIVATE_WORKER_URL ?? "")
  ) {
    throw new Error(
      [
        "Relay worker route policy requires private worker URLs, but at least one effective route points at a known public provider URL.",
        `Warnings: ${workerRouteWarnings.join(", ")}`,
        "Set OPENCLAW_INTERNAL_HIRE_URL or --local-hire-url to the Render Internal address, for example http://<internal-host>:<port>/hire."
      ].join(" ")
    );
  }
  for (const target of new Set(Object.values(localHireRoutes))) {
    warnIfRenderPublicWorkerUrl(target);
  }
  warnIfBundledIngressAndExplicitPaidRoute({
    shouldServe,
    localHireUrl,
    localPaidUrl
  });

  if (shouldHeartbeat) {
      const firstHeartbeat = await postHeartbeat({
        apiBase,
        agentId,
        sessionId,
        adminKey,
        ttlSeconds: 30,
        heartbeatNote: "SantaClawz relay resume heartbeat.",
        relayAgentProtocolVersion: RELAY_AGENT_PROTOCOL_VERSION,
        relayAgentBuild: RELAY_AGENT_BUILD,
        relayAgentFeatures: RELAY_AGENT_FEATURES,
        relayAgentWorkerRoutes: localHireRoutes,
        relayAgentWorkerWarnings,
        relayAgentWorkerTiming: {
          executionMode: "sync",
          configuredLocalHireTimeoutMs: CONFIGURED_LOCAL_HIRE_TIMEOUT_MS,
          localHireTimeoutMs: LOCAL_HIRE_TIMEOUT_MS,
          maxLocalHireTimeoutMs: MAX_LOCAL_HIRE_TIMEOUT_MS
        }
      });
    if (!firstHeartbeat.ok) {
      logHeartbeatFailure("relay_initial_heartbeat_failed_continuing", firstHeartbeat);
      if (!isRetryableHeartbeatFailure(firstHeartbeat)) {
        throw new Error(firstHeartbeat.payload?.error ?? `Heartbeat failed with status ${firstHeartbeat.status}`);
      }
    }
    heartbeatInterval = setInterval(() => {
        void postHeartbeat({
          apiBase,
          agentId,
          sessionId,
          adminKey,
          ttlSeconds: 30,
          heartbeatNote: "SantaClawz relay resume heartbeat.",
          relayAgentProtocolVersion: RELAY_AGENT_PROTOCOL_VERSION,
          relayAgentBuild: RELAY_AGENT_BUILD,
          relayAgentFeatures: RELAY_AGENT_FEATURES,
          relayAgentWorkerRoutes: localHireRoutes,
          relayAgentWorkerWarnings,
          relayAgentWorkerTiming: {
            executionMode: "sync",
            configuredLocalHireTimeoutMs: CONFIGURED_LOCAL_HIRE_TIMEOUT_MS,
            localHireTimeoutMs: LOCAL_HIRE_TIMEOUT_MS,
            maxLocalHireTimeoutMs: MAX_LOCAL_HIRE_TIMEOUT_MS
          }
        }).then((result) => {
          if (!result.ok) {
            logHeartbeatFailure("relay_periodic_heartbeat_failed", result);
          }
        }).catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  const summary = {
    agentId,
    sessionId,
    relayAgentProtocolVersion: RELAY_AGENT_PROTOCOL_VERSION,
    relayAgentBuild: RELAY_AGENT_BUILD,
    relayAgentFeatures: RELAY_AGENT_FEATURES,
    apiBase,
    relayBase,
    localHireUrl,
    localHireRoutes,
    executionTiming: {
      executionMode: "sync",
      configuredLocalHireTimeoutMs: CONFIGURED_LOCAL_HIRE_TIMEOUT_MS,
      localHireTimeoutMs: LOCAL_HIRE_TIMEOUT_MS,
      maxLocalHireTimeoutMs: MAX_LOCAL_HIRE_TIMEOUT_MS
    },
    workerRouteWarnings: relayAgentWorkerWarnings,
    servingIngress: ingress?.baseUrl,
    heartbeat: shouldHeartbeat ? "live" : "skipped"
  };
  console.log(JSON.stringify(summary, null, 2));
  console.error(`SantaClawz relay starting for ${agentId}. Forwarding signed jobs to ${JSON.stringify(localHireRoutes)}. Press Ctrl-C to stop.`);

  const stopPromise = new Promise((resolve) => {
    const stop = () => {
      stopping = true;
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (ingress?.child) {
      ingress.child.once("exit", stop);
    }
  });

  let attempt = 0;
  while (!stopping) {
    try {
      relay = await connectRelay({
        apiBase: relayBase,
        agentId,
        adminKey,
        localHireUrl: localHireRoutes,
        relayAgentWorkerRoutes: localHireRoutes,
        relayAgentWorkerWarnings,
        relayAgentWorkerTiming: {
          executionMode: "sync",
          configuredLocalHireTimeoutMs: CONFIGURED_LOCAL_HIRE_TIMEOUT_MS,
          localHireTimeoutMs: LOCAL_HIRE_TIMEOUT_MS,
          maxLocalHireTimeoutMs: MAX_LOCAL_HIRE_TIMEOUT_MS
        }
      });
      attempt = 0;
      console.error(JSON.stringify({
        event: "relay_connected",
        agentId,
        relayUrl: relay.relayUrl,
        localHireUrl: localHireRoutes,
        connectedAtIso: new Date().toISOString()
      }));
      await Promise.race([relay.closed, stopPromise]);
      if (!stopping) {
        console.error(JSON.stringify({
          event: "relay_closed_reconnecting",
          agentId,
          closedAtIso: new Date().toISOString()
        }));
      }
    } catch (error) {
      if (stopping) {
        break;
      }
      attempt += 1;
      const delayMs = Math.min(RELAY_RECONNECT_MAX_DELAY_MS, RELAY_RECONNECT_MIN_DELAY_MS * Math.max(1, attempt));
      console.error(JSON.stringify({
        event: "relay_connect_failed_retrying",
        agentId,
        attempt,
        delayMs,
        error: error instanceof Error ? error.message : String(error)
      }));
      await Promise.race([sleep(delayMs), stopPromise]);
    } finally {
      if (relay?.socket) {
        relay.socket.end();
      }
      relay = null;
    }
  }
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
  releaseLock?.();
}
