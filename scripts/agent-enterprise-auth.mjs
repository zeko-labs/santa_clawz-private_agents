import { applyEnvFile, normalizeBaseUrl, requestJson } from "./lib/santaclawz-readiness.mjs";

const VALID_PROVIDERS = new Set(["custom-oidc", "auth0", "okta"]);
const BOOLEAN_FLAGS = new Set(["help", "json", "check", "disable"]);

function printUsage() {
  console.error(`Usage:
  pnpm agent:enterprise-auth -- \\
    --env-file .env.santaclawz \\
    --authority-url https://auth-sidecar.example.com \\
    --provider custom-oidc \\
    --scopes "github:repo,drive.readonly" \\
    --check

  pnpm agent:enterprise-auth -- --env-file .env.santaclawz --disable

Environment variables:
  CLAWZ_API_BASE
  CLAWZ_AGENT_ID
  CLAWZ_AGENT_SESSION_ID
  CLAWZ_AGENT_ADMIN_KEY

Options:
  --agent-id agent-slug--session_agent_...
  --session-id session_agent_...
  --admin-key sck_...
  --api-base https://api.santaclawz.ai
  --authority-url https://auth-sidecar.example.com
  --provider custom-oidc|auth0|okta
  --scopes "github:repo,drive.readonly"
  --check
  --disable
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

function parseScopes(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  return value
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean)
    .slice(0, 16);
}

function resolveConfig(args) {
  const agentId = firstString(args["agent-id"], process.env.CLAWZ_AGENT_ID);
  const adminKey = firstString(args["admin-key"], process.env.CLAWZ_AGENT_ADMIN_KEY);
  const provider = firstString(args.provider) || "custom-oidc";
  const authorityUrl = firstString(args["authority-url"]);

  if (!agentId || !adminKey) {
    printUsage();
    throw new Error(
      "agent-id and admin-key are required. Use --env-file .env.santaclawz or set CLAWZ_AGENT_ID and CLAWZ_AGENT_ADMIN_KEY."
    );
  }
  if (!args.disable && !authorityUrl) {
    printUsage();
    throw new Error("authority-url is required unless --disable is set.");
  }
  if (!VALID_PROVIDERS.has(provider)) {
    throw new Error("provider must be custom-oidc, auth0, or okta.");
  }

  return {
    apiBase: normalizeBaseUrl(firstString(args["api-base"], process.env.CLAWZ_API_BASE) || "https://api.santaclawz.ai"),
    agentId,
    sessionId: firstString(args["session-id"], process.env.CLAWZ_AGENT_SESSION_ID),
    adminKey,
    authorityUrl,
    provider,
    scopes: parseScopes(args.scopes),
    check: Boolean(args.check),
    disable: Boolean(args.disable),
    json: Boolean(args.json)
  };
}

function queryFor(config) {
  return new URLSearchParams({
    ...(config.sessionId ? { sessionId: config.sessionId } : {}),
    agentId: config.agentId
  });
}

function missionAuthOverlayFor(config) {
  if (config.disable) {
    return {
      enabled: false,
      status: "disabled",
      scopeHints: []
    };
  }

  return {
    enabled: true,
    status: "configured",
    authorityBaseUrl: config.authorityUrl,
    providerHint: config.provider,
    scopeHints: config.scopes
  };
}

async function updateProfile(config) {
  const missionAuthOverlay = missionAuthOverlayFor(config);
  const response = await requestJson(`${config.apiBase}/api/console/profile?${queryFor(config).toString()}`, {
    method: "POST",
    headers: {
      "x-clawz-admin-key": config.adminKey
    },
    body: JSON.stringify({
      ...(config.sessionId ? { sessionId: config.sessionId } : {}),
      agentId: config.agentId,
      missionAuthOverlay
    })
  });
  if (!response.ok) {
    throw new Error(response.payload?.error ?? `Enterprise auth update failed with status ${response.status}`);
  }
  return response.payload;
}

async function checkOverlay(config) {
  const response = await requestJson(`${config.apiBase}/api/mission-auth/check?${queryFor(config).toString()}`, {
    method: "POST",
    headers: {
      "x-clawz-admin-key": config.adminKey
    },
    body: JSON.stringify({
      ...(config.sessionId ? { sessionId: config.sessionId } : {}),
      agentId: config.agentId,
      missionAuthOverlay: missionAuthOverlayFor(config)
    })
  });
  if (!response.ok) {
    throw new Error(response.payload?.error ?? `Enterprise auth check failed with status ${response.status}`);
  }
  return response.payload;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}
if (typeof args["env-file"] === "string" && args["env-file"].trim().length > 0) {
  applyEnvFile(args["env-file"].trim());
}

const config = resolveConfig(args);
const updateResult = await updateProfile(config);
const checkResult = config.check && !config.disable ? await checkOverlay(config) : undefined;
const result = checkResult ?? updateResult;
const overlay = result.profile?.missionAuthOverlay ?? result.missionAuthOverlay ?? missionAuthOverlayFor(config);

if (config.json) {
  console.log(JSON.stringify({ update: updateResult, ...(checkResult ? { check: checkResult } : {}) }, null, 2));
} else {
  console.log(`Agent: ${result.agentId ?? config.agentId}`);
  console.log(`Enterprise auth: ${overlay.enabled ? overlay.status ?? "configured" : "disabled"}`);
  if (overlay.authorityBaseUrl) {
    console.log(`Authority: ${overlay.authorityBaseUrl}`);
  }
  if (overlay.providerHint) {
    console.log(`Provider: ${overlay.providerHint}`);
  }
  if (overlay.scopeHints?.length) {
    console.log(`Scopes: ${overlay.scopeHints.join(", ")}`);
  }
  if (config.check && overlay.status === "verified") {
    console.log("Mission auth sidecar verified.");
  } else if (!config.disable) {
    console.log("Next: run again with --check after the sidecar discovery document and JWKS are live.");
  }
}
