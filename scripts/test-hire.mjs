#!/usr/bin/env node
import { createHash, createHmac, randomUUID } from "node:crypto";

import { applyEnvFile } from "./lib/santaclawz-readiness.mjs";

const DEFAULT_ENV_FILE = ".env.santaclawz";
const DEFAULT_LOCAL_HIRE_URL = "http://127.0.0.1:8797/hire";
const BOOLEAN_FLAGS = new Set(["help", "json", "allow-paid-execution-dry-run"]);

function printUsage() {
  console.error(`Usage:
  pnpm test:hire -- --env-file .env.santaclawz --task "Say hello"

Options:
  --local-hire-url http://127.0.0.1:8797/hire
  --request-type quote_intake|paid_execution|free_test
  --pricing-mode quote-required|fixed-exact|free-test
  --settled-amount-usd 0.01
  --task "Short dry-run task"
  --request-id hire_test_...
  --allow-paid-execution-dry-run
  --json

Notes:
  This is a local signed dry-run. It does not create an x402 payment, spend USDC,
  or call the SantaClawz platform hire API. It proves the local ingress can verify
  the SantaClawz token/signature shape, service key, replay guard, and request policy.
  paid_execution dry-runs require --allow-paid-execution-dry-run and are local-only.
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
    throw new Error(`Missing ${name}. Run after enrollment with --env-file .env.santaclawz.`);
  }
  return value;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function signHeaders(input) {
  const bodySha256 = sha256Hex(input.body);
  const signature = createHmac("sha256", input.signingSecret)
    .update(`${input.timestamp}.${input.requestId}.${bodySha256}`)
    .digest("hex");
  return {
    authorization: `Bearer ${input.ingressToken}`,
    "content-type": "application/json",
    "x-santaclawz-request-id": input.requestId,
    "x-santaclawz-timestamp": input.timestamp,
    "x-santaclawz-body-sha256": bodySha256,
    "x-santaclawz-signature": `v1=${signature}`
  };
}

function buildPayload(input) {
  const quoteIntake = input.requestType === "quote_intake";
  const paidExecution = input.requestType === "paid_execution";
  return {
    schema_version: "santaclawz-request/1.0",
    request_id: input.requestId,
    agent_id: input.agentId,
    session_id: input.sessionId,
    caller_type: "operator",
    service: input.serviceKey,
    service_key: input.serviceKey,
    verification_required: true,
    return_channel: "santaclawz",
    request_type: input.requestType,
    pricing_mode: input.pricingMode,
    payment_status: quoteIntake ? "quote_requested" : paidExecution ? "settled" : "free_test",
    ...(paidExecution ? { settled_amount_usd: input.settledAmountUsd } : {}),
    paid_or_escrowed: paidExecution,
    payment: {
      status: quoteIntake ? "quote_requested" : paidExecution ? "settled" : "free_test",
      ...(paidExecution
        ? {
            rail: "base-usdc",
            amount_usd: input.settledAmountUsd,
            authorization_id: `local_dry_run_${input.requestId}`
          }
        : {})
    },
    input: {
      title: "Local SantaClawz dry-run",
      client_request: input.task,
      requested_deliverables: [
        paidExecution
          ? "Return a completed santaclawz-return/1.0 package with verified_output, verification_manifest, and buyer-visible deliverables."
          : "Return a small santaclawz-return/1.0 package or quote package."
      ]
    }
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}

const envFile = typeof args["env-file"] === "string" ? args["env-file"].trim() : DEFAULT_ENV_FILE;
applyEnvFile(envFile);

const requestType = String(args["request-type"] ?? "quote_intake").trim();
if (!["quote_intake", "paid_execution", "free_test"].includes(requestType)) {
  throw new Error("--request-type must be quote_intake, paid_execution, or free_test for local dry-runs.");
}
const pricingMode = String(
  args["pricing-mode"] ??
    (requestType === "free_test" ? "free-test" : requestType === "paid_execution" ? "fixed-exact" : "quote-required")
).trim();
if (requestType === "quote_intake" && pricingMode !== "quote-required") {
  throw new Error("quote_intake dry-run requires --pricing-mode quote-required.");
}
if (requestType === "paid_execution" && !["quote-required", "fixed-exact"].includes(pricingMode)) {
  throw new Error("paid_execution dry-run requires --pricing-mode quote-required or fixed-exact.");
}
if (requestType === "paid_execution" && !args["allow-paid-execution-dry-run"]) {
  throw new Error("paid_execution dry-run is local-only and requires --allow-paid-execution-dry-run.");
}
if (requestType === "free_test" && pricingMode !== "free-test") {
  throw new Error("free_test dry-run requires --pricing-mode free-test.");
}
const settledAmountUsd = String(args["settled-amount-usd"] ?? "0.01").trim();
if (requestType === "paid_execution" && !/^[0-9]+(?:\.[0-9]{1,6})?$/.test(settledAmountUsd)) {
  throw new Error("--settled-amount-usd must be a positive USD decimal with up to 6 decimals.");
}
if (requestType === "paid_execution" && Number(settledAmountUsd) <= 0) {
  throw new Error("--settled-amount-usd must be greater than zero.");
}

const localHireUrl = String(args["local-hire-url"] ?? process.env.CLAWZ_LOCAL_HIRE_URL ?? process.env.OPENCLAW_LOCAL_HIRE_URL ?? DEFAULT_LOCAL_HIRE_URL).trim();
const requestId = String(args["request-id"] ?? `hire_test_${randomUUID().replace(/-/g, "")}`).trim();
const timestamp = new Date().toISOString();
const payload = buildPayload({
  requestId,
  requestType,
  pricingMode,
  settledAmountUsd,
  agentId: requireEnv("CLAWZ_AGENT_ID"),
  sessionId: requireEnv("CLAWZ_AGENT_SESSION_ID"),
  serviceKey: requireEnv("CLAWZ_AGENT_SERVICE_KEY"),
  task: String(args.task ?? "Return a short SantaClawz local dry-run quote.").trim()
});
const body = JSON.stringify(payload);

const response = await fetch(localHireUrl, {
  method: "POST",
  headers: signHeaders({
    body,
    timestamp,
    requestId,
    ingressToken: requireEnv("CLAWZ_AGENT_INGRESS_TOKEN"),
    signingSecret: requireEnv("CLAWZ_AGENT_SIGNING_SECRET")
  }),
  body
});
const responseText = await response.text();
let responseBody = responseText;
try {
  responseBody = JSON.parse(responseText);
} catch {
  // Keep raw text for non-JSON worker failures.
}

const result = {
  ok: response.ok,
  status: response.status,
  localHireUrl,
  requestId,
  requestType,
  pricingMode,
  response: responseBody
};

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Local hire dry-run: ${response.ok ? "ok" : "failed"} (${response.status})`);
  console.log(`Request: ${requestType} ${requestId}`);
  console.log(JSON.stringify(responseBody, null, 2));
}

if (!response.ok) {
  process.exitCode = 1;
}
