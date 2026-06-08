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
  "no-paid-execution-probe",
  "verify-hireability"
]);

function printUsage() {
  console.error(`Usage:
  pnpm seller:ready -- \\
    --agent-env-file .env.santaclawz

Options:
  --agent-id agent-id
  --session-id session_agent_...
  --admin-key sck_...
  --agent-env-file path    Alias for --env-file; preferred for multi-agent local runs.
  --env-file path          Legacy alias for --agent-env-file.
  --api-base https://api.santaclawz.ai
  --publish                 Default. Anchor pending seller milestones if needed.
  --heartbeat               Default. Send one live heartbeat during readiness.
  --verify-hireability      Default. Exit non-zero until the seller is hireable.
  --no-publish              Check readiness without anchoring pending milestones.
  --local-only              Mark local/dev anchor batches confirmed without a Zeko transaction.
  --no-heartbeat            Do not send a heartbeat during readiness.
  --no-availability         Do not ask SantaClawz to probe the public ingress.
  --local-hire-url url      Local ingress used for the paid_execution return-package probe.
  --local-paid-url url      Local paid_execution route when it differs from quote/default ingress.
  --no-paid-execution-probe Skip the local paid_execution return-package probe.
  --allow-incomplete        Print blockers but exit 0.
  --json

Environment variables:
  CLAWZ_API_BASE
  CLAWZ_AGENT_ID
  CLAWZ_AGENT_SESSION_ID
  CLAWZ_AGENT_ADMIN_KEY
  CLAWZ_AGENT_INGRESS_TOKEN
  CLAWZ_AGENT_SIGNING_SECRET
  CLAWZ_AGENT_SERVICE_KEY
  CLAWZ_LOCAL_HIRE_URL
  CLAWZ_LOCAL_PAID_HIRE_URL
  CLAWZ_LOCAL_PAID_EXECUTION_URL
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

  const localHireUrl = String(
    args["local-paid-url"] ??
      args["local-hire-url"] ??
      process.env.CLAWZ_LOCAL_PAID_HIRE_URL ??
      process.env.CLAWZ_LOCAL_PAID_EXECUTION_URL ??
      process.env.CLAWZ_LOCAL_HIRE_URL ??
      process.env.OPENCLAW_LOCAL_HIRE_URL ??
      "http://127.0.0.1:8797/hire"
  ).trim();
  const localRouteSummary = {
    ...(args["local-hire-url"] || process.env.CLAWZ_LOCAL_HIRE_URL || process.env.OPENCLAW_LOCAL_HIRE_URL
      ? { default: String(args["local-hire-url"] ?? process.env.CLAWZ_LOCAL_HIRE_URL ?? process.env.OPENCLAW_LOCAL_HIRE_URL).trim() }
      : {}),
    paid_execution: localHireUrl
  };

  return {
    apiBase: normalizeBaseUrl(String(args["api-base"] ?? process.env.CLAWZ_API_BASE ?? "https://api.santaclawz.ai").trim()),
    envFile:
      typeof args["agent-env-file"] === "string"
        ? args["agent-env-file"].trim()
        : typeof args["env-file"] === "string"
          ? args["env-file"].trim()
          : ".env.santaclawz",
    agentId,
    sessionId,
    adminKey,
    heartbeat: !args["no-heartbeat"],
    publish: !args["no-publish"],
    localOnly: Boolean(args["local-only"]),
    verifyAvailability: !args["no-availability"],
    paidExecutionProbe: !args["no-paid-execution-probe"],
    localHireUrl,
    localRouteSummary,
    CLAWZ_AGENT_INGRESS_TOKEN: String(process.env.CLAWZ_AGENT_INGRESS_TOKEN ?? "").trim(),
    CLAWZ_AGENT_SIGNING_SECRET: String(process.env.CLAWZ_AGENT_SIGNING_SECRET ?? "").trim(),
    CLAWZ_AGENT_SERVICE_KEY: String(process.env.CLAWZ_AGENT_SERVICE_KEY ?? "").trim(),
    operatorNote: "Seller readiness publish/anchor"
  };
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

const readiness = await runSellerReadiness(resolveConfig(args));

if (args.json) {
  console.log(JSON.stringify(readiness, null, 2));
} else {
  printReadiness(readiness);
}

if (!readiness.hireable && !args["allow-incomplete"]) {
  throw new Error(readinessErrorMessage(readiness));
}
