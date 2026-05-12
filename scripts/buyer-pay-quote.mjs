#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { normalizeBaseUrl } from "./lib/santaclawz-readiness.mjs";

const BOOLEAN_FLAGS = new Set(["help", "allow-real-money", "json"]);

function printUsage() {
  console.error(`Usage:
  pnpm buyer:pay-quote -- \\
    --quote-manifest ./santaclawz_quote.json \\
    --payment-payload-file ./payment-payload.json \\
    --allow-real-money

Options:
  --api-base https://api.santaclawz.ai
  --intent-id exec_...
  --quote-manifest path     Manifest produced by quote acceptance/procurement tooling.
  --payment-payload-file path
  --allow-real-money        Required. Prevents accidental live payment submission.
  --json

This command pays an existing accepted quote intent. It never creates a fresh quote.
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

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function findFirstStringByKey(value, keys) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstStringByKey(item, keys);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  for (const item of Object.values(value)) {
    const found = findFirstStringByKey(item, keys);
    if (found) {
      return found;
    }
  }
  return undefined;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}
if (!args["allow-real-money"]) {
  printUsage();
  throw new Error("--allow-real-money is required to submit an x402 quote payment.");
}

const apiBase = normalizeBaseUrl(String(args["api-base"] ?? process.env.CLAWZ_API_BASE ?? "https://api.santaclawz.ai").trim());
const quoteManifestPath = typeof args["quote-manifest"] === "string" ? args["quote-manifest"].trim() : "";
const paymentPayloadPath = typeof args["payment-payload-file"] === "string" ? args["payment-payload-file"].trim() : "";
if (!quoteManifestPath && typeof args["intent-id"] !== "string") {
  throw new Error("--quote-manifest or --intent-id is required.");
}
if (!paymentPayloadPath) {
  throw new Error("--payment-payload-file is required.");
}

const quoteManifest = quoteManifestPath ? readJsonFile(quoteManifestPath, "quote manifest") : {};
const paymentPayloadFile = readJsonFile(paymentPayloadPath, "payment payload");
const intentId =
  typeof args["intent-id"] === "string" && args["intent-id"].trim().length > 0
    ? args["intent-id"].trim()
    : findFirstStringByKey(quoteManifest, ["intentId", "intent_id"]) ??
      findFirstStringByKey(quoteManifest, ["acceptedIntentId", "accepted_intent_id"]);
if (!intentId || !/^exec_[a-zA-Z0-9]+$/.test(intentId)) {
  throw new Error("Unable to find an accepted quote intentId. Pass --intent-id exec_... or a quote manifest containing intentId.");
}

const paymentPayload =
  paymentPayloadFile && typeof paymentPayloadFile === "object" && !Array.isArray(paymentPayloadFile) && paymentPayloadFile.paymentPayload
    ? paymentPayloadFile.paymentPayload
    : paymentPayloadFile;

const response = await fetch(`${apiBase}/api/x402/quote-intent?${new URLSearchParams({ intentId }).toString()}`, {
  method: "POST",
  headers: {
    "content-type": "application/json"
  },
  body: JSON.stringify({ paymentPayload })
});
const responseText = await response.text();
let payload;
try {
  payload = JSON.parse(responseText);
} catch {
  payload = { error: responseText.slice(0, 1000) };
}

if (args.json) {
  console.log(JSON.stringify({
    ok: response.ok,
    status: response.status,
    intentId,
    response: payload
  }, null, 2));
} else {
  console.log(JSON.stringify(payload, null, 2));
}

if (!response.ok) {
  process.exitCode = 1;
}
