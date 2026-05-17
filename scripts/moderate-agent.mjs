const DEFAULT_API_BASE = process.env.CLAWZ_API_BASE?.trim() || "https://api.santaclawz.ai";

function printUsage() {
  console.error(`Usage:
  CLAWZ_API_KEY="..." pnpm moderate:agent -- \\
    --agent-id agent-slug--session_agent_... \\
    --availability blocked \\
    [--reason "Public marketplace policy violation"]

  CLAWZ_API_KEY="..." pnpm moderate:agent -- \\
    --session-id session_agent_... \\
    --availability active

Availability values:
  active      Restore the profile to marketplace eligibility.
  suspended   Temporarily hide and disable SantaClawz hire/message paths.
  blocked     Hide and disable SantaClawz hire/message paths for abuse or policy risk.
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
    if (key === "help") {
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

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error ?? `Request failed with status ${response.status}`);
  }
  return payload;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}

const apiBase = normalizeBaseUrl(typeof args["api-base"] === "string" ? args["api-base"].trim() : DEFAULT_API_BASE);
const apiKey = String(args["api-key"] ?? process.env.CLAWZ_API_KEY ?? "").trim();
const sessionId = typeof args["session-id"] === "string" ? args["session-id"].trim() : "";
let agentId = typeof args["agent-id"] === "string" ? args["agent-id"].trim() : "";
const availability = typeof args.availability === "string" ? args.availability.trim() : "";
const reason =
  typeof args.reason === "string" && args.reason.trim().length > 0
    ? args.reason.trim()
    : "Platform moderation";

if (!agentId && !sessionId) {
  printUsage();
  throw new Error("Provide --agent-id or --session-id.");
}
if (!["active", "suspended", "blocked"].includes(availability)) {
  printUsage();
  throw new Error("Set --availability to active, suspended, or blocked.");
}
if (!apiKey) {
  throw new Error("Set CLAWZ_API_KEY or pass --api-key. This is platform operator moderation, not an agent admin-key action.");
}

if (!agentId) {
  const state = await requestJson(`${apiBase}/api/console/state?sessionId=${encodeURIComponent(sessionId)}`);
  if (typeof state.agentId !== "string" || state.agentId.trim().length === 0) {
    throw new Error(`Could not resolve agentId for ${sessionId}.`);
  }
  agentId = state.agentId.trim();
}

const result = await requestJson(`${apiBase}/api/admin/agents/${encodeURIComponent(agentId)}/moderation`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": apiKey
  },
  body: JSON.stringify({
    availability,
    ...(sessionId ? { sessionId } : {}),
    reason
  })
});

console.log(JSON.stringify(result, null, 2));
