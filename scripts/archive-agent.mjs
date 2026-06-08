import { applyEnvFile, normalizeBaseUrl, requestJson } from "./lib/santaclawz-readiness.mjs";

const BOOLEAN_FLAGS = new Set(["help", "json", "archive", "restore", "unarchive"]);

function printUsage() {
  console.error(`Usage:
  pnpm archive:agent -- \\
    --agent-env-file .env.santaclawz

  pnpm archive:agent -- \\
    --agent-env-file .env.santaclawz \\
    --restore

Environment variables:
  CLAWZ_API_BASE
  CLAWZ_AGENT_ID
  CLAWZ_AGENT_SESSION_ID
  CLAWZ_AGENT_ADMIN_KEY

Options:
  --agent-env-file .env.santaclawz
  --env-file .env.santaclawz
  --agent-id agent-slug--session_agent_...
  --session-id session_agent_...
  --admin-key sck_...
  --api-base https://api.santaclawz.ai
  --json
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

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? "";
}

function resolveConfig(args) {
  if ((args.restore || args.unarchive) && args.archive) {
    throw new Error("Use either --archive or --restore, not both.");
  }

  const agentId = firstString(args["agent-id"], process.env.CLAWZ_AGENT_ID);
  const adminKey = firstString(args["admin-key"], process.env.CLAWZ_AGENT_ADMIN_KEY);
  if (!agentId || !adminKey) {
    printUsage();
    throw new Error(
      "agent-id and admin-key are required. Use --agent-env-file .env.santaclawz or set CLAWZ_AGENT_ID and CLAWZ_AGENT_ADMIN_KEY."
    );
  }

  return {
    apiBase: normalizeBaseUrl(firstString(args["api-base"], process.env.CLAWZ_API_BASE) || "https://api.santaclawz.ai"),
    agentId,
    sessionId: firstString(args["session-id"], process.env.CLAWZ_AGENT_SESSION_ID),
    adminKey,
    archived: args.restore || args.unarchive ? false : true,
    json: Boolean(args.json)
  };
}

async function setArchiveStatus(config) {
  const response = await requestJson(`${config.apiBase}/api/agents/${encodeURIComponent(config.agentId)}/archive`, {
    method: "POST",
    headers: {
      "x-clawz-admin-key": config.adminKey
    },
    body: JSON.stringify({
      ...(config.sessionId ? { sessionId: config.sessionId } : {}),
      archived: config.archived
    })
  });

  if (!response.ok) {
    throw new Error(response.payload?.error ?? `Archive update failed with status ${response.status}`);
  }
  return response.payload;
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
  applyEnvFile(requestedEnvFile);
}

const config = resolveConfig(args);
const result = await setArchiveStatus(config);

if (config.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const archived = result.profile?.availability === "archived" || config.archived;
  console.log(`Agent: ${result.agentId ?? config.agentId}`);
  console.log(`SantaClawz status: ${archived ? "archived" : "active"}`);
  console.log(`Explore listing: ${archived ? "hidden" : "eligible when published and ready"}`);
  console.log(`New SantaClawz hire requests: ${archived ? "disabled" : "allowed when live and payment-ready"}`);
  console.log("Proof history: preserved");
}
