#!/usr/bin/env node
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { loadEnvFile, normalizeBaseUrl, requestJson } from "./lib/santaclawz-readiness.mjs";

const DEFAULT_API_BASE = "https://api.santaclawz.ai";
const RETRYABLE_STATUSES = new Set([0, 408, 425, 429, 500, 502, 503, 504]);
const ENV_FILE_SUFFIXES = [".env", ".env.santaclawz", ".santaclawz"];

function printUsage() {
  console.error(`Usage:
  pnpm agents:preflight -- \\
    --agent-env-file .santaclawz-agents/alpha.env.santaclawz \\
    --agent-env-file .santaclawz-agents/beta.env.santaclawz

  pnpm agents:preflight -- --env-dir .santaclawz-agents

Options:
  --agent-env-file path    Repeat once per enrolled agent.
  --env-dir path           Load every env-like file in a directory.
  --api-base url           Defaults to https://api.santaclawz.ai.
  --retries n              Retry public readiness/x402 plan checks. Default: 2.
  --retry-delay-ms n       Delay between retry attempts. Default: 1250.
  --allow-incomplete       Exit 0 even when agents are not fully ready.
  --json                   Print machine-readable output.

This command does not spend money. It verifies that every listed agent has a
public readiness view and x402 plan before a multi-agent paid run starts.`);
}

function parseArgs(argv) {
  const args = { agentEnvFiles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      continue;
    }
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    if (key === "help" || key === "json" || key === "allow-incomplete") {
      args[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    if (key === "agent-env-file" || key === "env-file") {
      args.agentEnvFiles.push(value);
    } else {
      args[key] = value;
    }
    index += 1;
  }
  return args;
}

function isEnvLikeFile(filePath) {
  const basename = path.basename(filePath);
  return ENV_FILE_SUFFIXES.some((suffix) => basename.endsWith(suffix)) || basename.includes(".env.");
}

function envFilesFromDir(dirPath) {
  return readdirSync(dirPath)
    .map((entry) => path.join(dirPath, entry))
    .filter((filePath) => {
      try {
        return statSync(filePath).isFile() && isEnvLikeFile(filePath);
      } catch {
        return false;
      }
    })
    .sort();
}

function compactAgentFromEnv(filePath) {
  const env = loadEnvFile(filePath);
  return {
    envFile: filePath,
    agentId: env.CLAWZ_AGENT_ID?.trim() ?? "",
    sessionId: env.CLAWZ_AGENT_SESSION_ID?.trim() ?? "",
    adminKeyPresent: Boolean(env.CLAWZ_AGENT_ADMIN_KEY?.trim()),
    localHireUrl:
      env.CLAWZ_LOCAL_PAID_HIRE_URL?.trim() ??
      env.CLAWZ_LOCAL_PAID_EXECUTION_URL?.trim() ??
      env.CLAWZ_LOCAL_HIRE_URL?.trim() ??
      env.OPENCLAW_LOCAL_HIRE_URL?.trim() ??
      ""
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryableResponse(response) {
  return !response?.ok && RETRYABLE_STATUSES.has(Number(response?.status ?? 0));
}

async function requestWithRetries(url, options) {
  const attempts = Math.max(1, options.retries + 1);
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await requestJson(url);
    if (!retryableResponse(last) || attempt === attempts) {
      return { ...last, attemptCount: attempt };
    }
    await sleep(options.retryDelayMs);
  }
  return { ...last, attemptCount: attempts };
}

function firstReadyRail(plan) {
  return Array.isArray(plan?.rails)
    ? plan.rails.find((rail) => rail?.ready === true) ?? plan.rails[0]
    : undefined;
}

function compactPlan(plan) {
  const rail = firstReadyRail(plan);
  return {
    pricingMode: plan?.pricingMode ?? plan?.paymentProfile?.pricingMode ?? "unknown",
    amountUsd: plan?.fixedAmountUsd ?? rail?.amountUsd ?? plan?.referencePriceUsd ?? "",
    rail: rail?.rail ?? plan?.defaultRail ?? "",
    payTo: rail?.payTo ?? rail?.pay_to ?? "",
    paymentProfileReady: plan?.paymentProfileReady === true,
    hireable: Boolean(plan?.hireable ?? rail?.ready),
    blockers: [
      ...(Array.isArray(plan?.blockers) ? plan.blockers : []),
      ...(Array.isArray(rail?.missing) ? rail.missing : [])
    ]
  };
}

function compactReadiness(readiness) {
  const pricing = readiness?.pricing ?? {};
  return {
    hireable: readiness?.paidExecutionReady === true || readiness?.quoteReady === true,
    pricingReady: pricing.paymentProfileReady === true || readiness?.paymentsReady === true,
    paymentReady: readiness?.paymentsReady === true,
    relayConnected: readiness?.online === true,
    workerReachable: readiness?.availability?.reachable === true || readiness?.online === true,
    paidExecutionProven: readiness?.paidExecutionProven === true,
    blockers: Array.isArray(readiness?.knownBlockers) ? readiness.knownBlockers : [],
    executionTiming: readiness?.executionTiming,
    relayWarnings: Array.isArray(readiness?.relayAgentWorkerWarnings) ? readiness.relayAgentWorkerWarnings : []
  };
}

async function preflightAgent(agent, options) {
  const missing = [
    !agent.agentId ? "CLAWZ_AGENT_ID" : "",
    !agent.sessionId ? "CLAWZ_AGENT_SESSION_ID" : "",
    !agent.adminKeyPresent ? "CLAWZ_AGENT_ADMIN_KEY" : ""
  ].filter(Boolean);
  if (missing.length > 0) {
    return {
      ...agent,
      ok: false,
      errors: [`Missing ${missing.join(", ")} in ${agent.envFile}`],
      plan: compactPlan({}),
      readiness: compactReadiness({})
    };
  }

  const readyUrl = `${options.apiBase}/api/agents/${encodeURIComponent(agent.agentId)}/ready`;
  const planUrl = `${options.apiBase}/api/agents/${encodeURIComponent(agent.agentId)}/x402-plan`;
  const [readyResponse, planResponse] = await Promise.all([
    requestWithRetries(readyUrl, options),
    requestWithRetries(planUrl, options)
  ]);
  const plan = compactPlan(planResponse.payload ?? {});
  const readiness = compactReadiness(readyResponse.payload ?? {});
  const errors = [
    ...(readyResponse.ok ? [] : [`readiness ${readyResponse.status}: ${readyResponse.payload?.error ?? readyResponse.payload?.message ?? "unavailable"}`]),
    ...(planResponse.ok ? [] : [`x402 plan ${planResponse.status}: ${planResponse.payload?.error ?? planResponse.payload?.message ?? "unavailable"}`])
  ];
  const ok =
    errors.length === 0 &&
    readiness.relayConnected &&
    readiness.pricingReady &&
    readiness.paymentReady &&
    (plan.paymentProfileReady || plan.hireable) &&
    readiness.blockers.length === 0;
  return {
    ...agent,
    ok,
    errors,
    readiness,
    plan,
    attempts: {
      readiness: readyResponse.attemptCount,
      x402Plan: planResponse.attemptCount
    }
  };
}

function printTable(results) {
  const rows = results.map((result) => ({
    agent: result.agentId || path.basename(result.envFile),
    status: result.ok ? "ready" : "check",
    price: [result.plan.amountUsd ? `$${result.plan.amountUsd}` : "", result.plan.rail].filter(Boolean).join(" "),
    relay: result.readiness.relayConnected ? "live" : "not-live",
    paid: result.readiness.paidExecutionProven ? "proven" : "not-proven",
    blockers: [...(result.errors ?? []), ...(result.readiness.blockers ?? [])].join("; ") || "-"
  }));
  const widths = {
    agent: Math.max(5, ...rows.map((row) => row.agent.length)),
    status: 6,
    price: Math.max(5, ...rows.map((row) => row.price.length)),
    relay: 8,
    paid: 10
  };
  console.log([
    "agent".padEnd(widths.agent),
    "status".padEnd(widths.status),
    "price".padEnd(widths.price),
    "relay".padEnd(widths.relay),
    "paid-proof".padEnd(widths.paid),
    "blockers"
  ].join("  "));
  for (const row of rows) {
    console.log([
      row.agent.padEnd(widths.agent),
      row.status.padEnd(widths.status),
      row.price.padEnd(widths.price),
      row.relay.padEnd(widths.relay),
      row.paid.padEnd(widths.paid),
      row.blockers
    ].join("  "));
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}

const apiBase = normalizeBaseUrl(String(args["api-base"] ?? process.env.CLAWZ_API_BASE ?? DEFAULT_API_BASE).trim());
const envFiles = [
  ...args.agentEnvFiles,
  ...(typeof args["env-dir"] === "string" ? envFilesFromDir(args["env-dir"]) : [])
].map((filePath) => path.resolve(filePath));
const uniqueEnvFiles = Array.from(new Set(envFiles));
if (uniqueEnvFiles.length === 0) {
  printUsage();
  console.error("At least one --agent-env-file or --env-dir is required.");
  process.exit(1);
}

const options = {
  apiBase,
  retries: Number.parseInt(String(args.retries ?? "2"), 10),
  retryDelayMs: Number.parseInt(String(args["retry-delay-ms"] ?? "1250"), 10)
};
const agents = uniqueEnvFiles.map(compactAgentFromEnv);
const results = [];
for (const agent of agents) {
  results.push(await preflightAgent(agent, options));
}
const summary = {
  schemaVersion: "santaclawz-multi-agent-preflight/1.0",
  generatedAtIso: new Date().toISOString(),
  apiBase,
  totalAgents: results.length,
  readyAgents: results.filter((result) => result.ok).length,
  ok: results.every((result) => result.ok),
  results
};

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  printTable(results);
  console.log("");
  console.log(`${summary.readyAgents}/${summary.totalAgents} agents ready for the checked paid/workflow preflight.`);
}

if (!summary.ok && !args["allow-incomplete"]) {
  process.exit(1);
}
