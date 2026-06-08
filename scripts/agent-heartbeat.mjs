import { readFileSync } from "node:fs";

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_TTL_SECONDS = 30;
const VALID_STATUSES = new Set(["live", "waiting", "offline"]);

function printUsage() {
  console.error(`Usage:
  pnpm heartbeat:agent -- \\
    --agent-id "agent-id" \\
    --admin-key "sck_..." \\
    [--agent-env-file .env.santaclawz] \\
    [--api-base https://api.santaclawz.ai] \\
    [--session-id "session_agent_..."] \\
    [--interval-ms 15000] \\
    [--ttl-seconds 30] \\
    [--status live] \\
    [--note "Local PublicClawz gateway heartbeat"] \\
    [--once]

Environment variables:
  CLAWZ_API_BASE
  CLAWZ_AGENT_ID
  CLAWZ_AGENT_ADMIN_KEY
  CLAWZ_AGENT_SESSION_ID
  CLAWZ_AGENT_HEARTBEAT_INTERVAL_MS
  CLAWZ_AGENT_HEARTBEAT_TTL_SECONDS
  CLAWZ_AGENT_HEARTBEAT_STATUS
  CLAWZ_AGENT_HEARTBEAT_NOTE
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
    if (key === "help" || key === "once") {
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

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFile(filePath) {
  const contents = readFileSync(filePath, "utf8");
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
    const value = unquoteEnvValue(line.slice(separatorIndex + 1));
    if (!key || process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value;
  }
}

function parsePositiveInteger(value, fallback, label) {
  if (value === undefined || value === null || String(value).trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function resolveConfig(args) {
  const agentId = String(args["agent-id"] ?? process.env.CLAWZ_AGENT_ID ?? "").trim();
  const adminKey = String(args["admin-key"] ?? process.env.CLAWZ_AGENT_ADMIN_KEY ?? "").trim();
  const status = String(args.status ?? process.env.CLAWZ_AGENT_HEARTBEAT_STATUS ?? "live").trim();

  if (!agentId || !adminKey) {
    printUsage();
    throw new Error("agent-id and admin-key are required.");
  }
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`status must be one of: ${Array.from(VALID_STATUSES).join(", ")}`);
  }

  return {
    apiBase: normalizeBaseUrl(String(args["api-base"] ?? process.env.CLAWZ_API_BASE ?? "https://api.santaclawz.ai").trim()),
    agentId,
    adminKey,
    sessionId: String(args["session-id"] ?? process.env.CLAWZ_AGENT_SESSION_ID ?? "").trim(),
    intervalMs: parsePositiveInteger(
      args["interval-ms"] ?? process.env.CLAWZ_AGENT_HEARTBEAT_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
      "interval-ms"
    ),
    ttlSeconds: parsePositiveInteger(
      args["ttl-seconds"] ?? process.env.CLAWZ_AGENT_HEARTBEAT_TTL_SECONDS,
      DEFAULT_TTL_SECONDS,
      "ttl-seconds"
    ),
    status,
    note: String(args.note ?? process.env.CLAWZ_AGENT_HEARTBEAT_NOTE ?? "Local PublicClawz gateway heartbeat.").trim(),
    once: Boolean(args.once)
  };
}

async function postHeartbeat(config) {
  const response = await fetch(`${config.apiBase}/api/agents/${encodeURIComponent(config.agentId)}/heartbeat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawz-admin-key": config.adminKey
    },
    body: JSON.stringify({
      status: config.status,
      ttlSeconds: config.ttlSeconds,
      ...(config.sessionId ? { sessionId: config.sessionId } : {}),
      ...(config.note ? { note: config.note } : {})
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error ?? `Heartbeat failed with status ${response.status}`);
  }
  return payload;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}
const requestedEnvFile =
  typeof args["agent-env-file"] === "string" && args["agent-env-file"].trim().length > 0
    ? args["agent-env-file"].trim()
    : typeof args["env-file"] === "string" && args["env-file"].trim().length > 0
      ? args["env-file"].trim()
      : "";
if (requestedEnvFile) {
  loadEnvFile(requestedEnvFile);
}

const config = resolveConfig(args);
let stopping = false;

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

async function runOnce() {
  const heartbeat = await postHeartbeat(config);
  console.log(
    JSON.stringify(
      {
        agentId: heartbeat.agentId,
        sessionId: heartbeat.sessionId,
        status: heartbeat.status,
        checkedAtIso: heartbeat.checkedAtIso,
        staleAtIso: heartbeat.staleAtIso
      },
      null,
      2
    )
  );
}

if (config.once) {
  await runOnce();
} else {
  console.error(
    `Sending ${config.status} heartbeats for ${config.agentId} every ${config.intervalMs}ms. Press Ctrl-C to stop.`
  );
  while (!stopping) {
    try {
      const heartbeat = await postHeartbeat(config);
      console.error(
        `[${heartbeat.checkedAtIso}] ${heartbeat.status}; stale after ${heartbeat.staleAtIso ?? `${config.ttlSeconds}s`}`
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, config.intervalMs));
  }
}
