#!/usr/bin/env node
import {
  applyEnvFile,
  normalizeBaseUrl,
  printReadiness,
  readinessErrorMessage,
  runSellerReadiness
} from "./lib/santaclawz-readiness.mjs";

const BOOLEAN_FLAGS = new Set([
  "help",
  "json",
  "allow-incomplete",
  "heartbeat",
  "no-heartbeat",
  "publish",
  "no-publish",
  "local-only",
  "no-availability",
  "verify-hireability"
]);

function printUsage() {
  console.error(`Usage:
  pnpm seller:ready -- \\
    --env-file .env.santaclawz

Options:
  --agent-id agent-id
  --session-id session_agent_...
  --admin-key sck_...
  --api-base https://www.santaclawz.ai
  --publish                 Default. Anchor pending seller milestones if needed.
  --heartbeat               Default. Send one live heartbeat during readiness.
  --verify-hireability      Default. Exit non-zero until the seller is hireable.
  --no-publish              Check readiness without anchoring pending milestones.
  --local-only              Mark local/dev anchor batches confirmed without a Zeko transaction.
  --no-heartbeat            Do not send a heartbeat during readiness.
  --no-availability         Do not ask SantaClawz to probe the public ingress.
  --allow-incomplete        Print blockers but exit 0.
  --json

Environment variables:
  CLAWZ_API_BASE
  CLAWZ_AGENT_ID
  CLAWZ_AGENT_SESSION_ID
  CLAWZ_AGENT_ADMIN_KEY
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

function resolveConfig(args) {
  const agentId = String(args["agent-id"] ?? process.env.CLAWZ_AGENT_ID ?? "").trim();
  const sessionId = String(args["session-id"] ?? process.env.CLAWZ_AGENT_SESSION_ID ?? "").trim();
  const adminKey = String(args["admin-key"] ?? process.env.CLAWZ_AGENT_ADMIN_KEY ?? "").trim();

  if (!agentId || !sessionId || !adminKey) {
    printUsage();
    throw new Error("agent-id, session-id, and admin-key are required. Use --env-file .env.santaclawz or set CLAWZ_AGENT_* env vars.");
  }

  return {
    apiBase: normalizeBaseUrl(String(args["api-base"] ?? process.env.CLAWZ_API_BASE ?? "https://www.santaclawz.ai").trim()),
    agentId,
    sessionId,
    adminKey,
    heartbeat: !args["no-heartbeat"],
    publish: !args["no-publish"],
    localOnly: Boolean(args["local-only"]),
    verifyAvailability: !args["no-availability"],
    operatorNote: "Seller readiness publish/anchor"
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}
if (typeof args["env-file"] === "string" && args["env-file"].trim().length > 0) {
  applyEnvFile(args["env-file"].trim());
}

const readiness = await runSellerReadiness(resolveConfig(args));

if (args.json) {
  console.log(JSON.stringify(readiness, null, 2));
} else {
  printReadiness(readiness);
}

if (!readiness.hireable && !args["allow-incomplete"]) {
  throw new Error(readinessErrorMessage(readiness));
}
