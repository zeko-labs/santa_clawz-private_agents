#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { normalizeBaseUrl } from "./lib/santaclawz-readiness.mjs";
import {
  createRetryablePlatformFailure,
  isRetryablePlatformStatus,
  isRetryablePlatformTransportError
} from "./lib/platform-failures.mjs";

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
  --service magic_8_ball    Optional service key when the payload file contains multiple service-keyed payloads.
  --allow-real-money        Required. Prevents accidental live payment submission.
  --json

This command pays an existing accepted quote intent. It never creates a fresh quote.
Run pnpm buyer:payment:check first if you are testing a new buyer integration or SDK payload shape.
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

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isX402PaymentPayload(value) {
  return (
    isRecord(value) &&
    value.protocol === "x402" &&
    typeof value.networkId === "string" &&
    typeof value.settlementRail === "string" &&
    typeof value.payTo === "string"
  );
}

function paymentPayloadShapeFailure(message, extra = {}) {
  return {
    ok: false,
    code: "payment_payload_wrapped_service_key",
    retryable: false,
    message,
    ...extra
  };
}

function failPaymentPayloadShape(message, extra = {}) {
  const payload = paymentPayloadShapeFailure(message, extra);
  console.error(JSON.stringify(args.json ? payload : payload, null, 2));
  process.exit(1);
}

function normalizePaymentPayloadFromFile(paymentPayloadFile, options = {}) {
  const service = typeof options.service === "string" ? options.service.trim() : "";
  if (isX402PaymentPayload(paymentPayloadFile)) {
    return paymentPayloadFile;
  }
  if (isRecord(paymentPayloadFile) && isX402PaymentPayload(paymentPayloadFile.paymentPayload)) {
    return paymentPayloadFile.paymentPayload;
  }

  if (!isRecord(paymentPayloadFile)) {
    failPaymentPayloadShape("Payment payload file must contain a raw x402 payload, { paymentPayload }, or a service-keyed payload object.");
  }

  if (service) {
    const selected = paymentPayloadFile[service];
    if (!selected) {
      failPaymentPayloadShape(`Payment payload file does not contain service key '${service}'.`, {
        service,
        availableServices: Object.keys(paymentPayloadFile).filter((key) => isRecord(paymentPayloadFile[key]))
      });
    }
    if (isX402PaymentPayload(selected)) {
      return selected;
    }
    if (isRecord(selected) && isX402PaymentPayload(selected.paymentPayload)) {
      return selected.paymentPayload;
    }
    failPaymentPayloadShape(`Service key '${service}' does not contain a valid x402 payment payload.`, { service });
  }

  const candidates = Object.entries(paymentPayloadFile).filter(([, value]) => {
    return isX402PaymentPayload(value) || (isRecord(value) && isX402PaymentPayload(value.paymentPayload));
  });

  if (candidates.length === 1) {
    const [, value] = candidates[0];
    return isX402PaymentPayload(value) ? value : value.paymentPayload;
  }

  if (candidates.length > 1) {
    failPaymentPayloadShape("Payment payload file contains multiple service-keyed x402 payloads. Pass --service so buyer:pay-quote can unwrap the correct one locally.", {
      availableServices: candidates.map(([key]) => key)
    });
  }

  failPaymentPayloadShape("Payment payload file does not contain a valid x402 payload. Pass a raw x402 payload, { paymentPayload }, or a service-keyed wrapper such as { \"magic_8_ball\": { ... } }.");
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

const paymentPayload = normalizePaymentPayloadFromFile(paymentPayloadFile, {
  service: typeof args.service === "string" ? args.service : ""
});

let response;
try {
  response = await fetch(`${apiBase}/api/x402/quote-intent?${new URLSearchParams({ intentId }).toString()}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ paymentPayload })
  });
} catch (error) {
  if (!isRetryablePlatformTransportError(error)) {
    throw error;
  }
  const payload = createRetryablePlatformFailure(0, error instanceof Error ? error.message : String(error), {
    code: "post_payment_state_unavailable_retryable",
    paymentStatus: "authorized",
    settlementStatus: "unknown",
    relayDeliveryStatus: "not_confirmed",
    agentExecutionStatus: "not_confirmed"
  });
  console.log(JSON.stringify(args.json ? { ...payload, intentId } : payload, null, 2));
  process.exitCode = 1;
  process.exit();
}
const responseText = await response.text();
let payload;
try {
  payload = JSON.parse(responseText);
} catch {
  payload = isRetryablePlatformStatus(response.status)
    ? createRetryablePlatformFailure(response.status, responseText, {
        code: "post_payment_state_unavailable_retryable",
        paymentStatus: "authorized",
        settlementStatus: "unknown",
        relayDeliveryStatus: "not_confirmed",
        agentExecutionStatus: "not_confirmed"
      })
    : { error: responseText.slice(0, 1000) };
}

if (args.json) {
  const output =
    payload?.ok === false && payload?.retryable === true
      ? {
          ...payload,
          intentId
        }
      : {
          ok: response.ok,
          status: response.status,
          intentId,
          response: payload
        };
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(JSON.stringify(payload, null, 2));
}

if (!response.ok) {
  process.exitCode = 1;
}
