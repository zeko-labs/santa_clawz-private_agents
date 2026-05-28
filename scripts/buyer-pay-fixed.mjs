#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { normalizeBaseUrl } from "./lib/santaclawz-readiness.mjs";
import {
  createRetryablePlatformFailure,
  isRetryablePlatformStatus,
  isRetryablePlatformTransportError
} from "./lib/platform-failures.mjs";

const BOOLEAN_FLAGS = new Set(["help", "allow-real-money", "json"]);
const HIRE_TASK_PROMPT_MAX_LENGTH = 2000;
const HIRE_REQUESTER_CONTACT_MAX_LENGTH = 240;
const HIRE_REQUEST_BODY_MAX_BYTES = 32 * 1024;

function printUsage() {
  console.error(`Usage:
  pnpm buyer:pay-fixed -- \\
    --agent-id magic_8_ball--session_agent_... \\
    --task "Ask the fixed-price agent to do the listed job." \\
    --payment-payload-file ./payment-payload.json \\
    --allow-real-money

Options:
  --api-base https://api.santaclawz.ai
  --agent-id agent-id
  --task "Buyer task prompt"
  --requester-contact buyer-agent:local
  --payment-payload-file path
  --service magic_8_ball    Optional service key when the payload file contains multiple service-keyed payloads.
  --allow-real-money        Required. Prevents accidental live payment submission.
  --json

Fixed-price flow:
  1. POST /api/agents/<agent-id>/hire without payment to get the exact x402 requirement.
  2. Sign the x402 payload with a buyer wallet.
  3. Run pnpm buyer:payment:check against the requirement and signed payload.
  4. Run this command with the same signed payload.
  5. Poll the returned requestId with /api/executions/<requestId>/state.
`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (!token.startsWith("--")) continue;
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

function failPaymentPayloadShape(message, extra = {}) {
  const payload = {
    ok: false,
    code: "payment_payload_wrapped_service_key",
    retryable: false,
    message,
    ...extra
  };
  console.error(JSON.stringify(payload, null, 2));
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
    if (isX402PaymentPayload(selected)) return selected;
    if (isRecord(selected) && isX402PaymentPayload(selected.paymentPayload)) return selected.paymentPayload;
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
    failPaymentPayloadShape("Payment payload file contains multiple service-keyed x402 payloads. Pass --service.", {
      availableServices: candidates.map(([key]) => key)
    });
  }
  failPaymentPayloadShape("Payment payload file does not contain a valid x402 payload.");
}

function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function stringField(value, key) {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

function paidExecutionSummary(responseOk, payload) {
  const operational = isRecord(payload?.operationalStatus) ? payload.operationalStatus : {};
  const payment = isRecord(payload?.payment) ? payload.payment : {};
  const paymentStatus = stringField(operational, "paymentStatus") || stringField(payload, "paymentStatus") || stringField(payment, "status");
  const settlementStatus = stringField(operational, "settlementStatus") || stringField(payload, "settlementStatus") || "unknown";
  const relayDeliveryStatus = stringField(operational, "relayDeliveryStatus") || stringField(payload, "relayDeliveryStatus") || "not_confirmed";
  const agentExecutionStatus =
    stringField(operational, "agentExecutionStatus") || stringField(payload, "agentExecutionStatus") || stringField(payload, "status") || "not_confirmed";
  const paymentAccepted = ["authorized", "settled", "paid", "escrowed"].includes(paymentStatus);
  const paymentOk = paymentAccepted;
  const executionOk = agentExecutionStatus === "completed";
  const artifactDeliveryOk = executionOk && ["forwarded", "recorded"].includes(relayDeliveryStatus);
  const jobCompleted =
    responseOk &&
    ["settled", "paid", "escrowed"].includes(paymentStatus) &&
    settlementStatus === "settled" &&
    ["forwarded", "recorded"].includes(relayDeliveryStatus) &&
    agentExecutionStatus === "completed";
  const acceptedPendingResult =
    responseOk &&
    relayDeliveryStatus === "acknowledged" &&
    agentExecutionStatus === "running_or_unknown";
  return {
    ok: jobCompleted,
    overallOk: jobCompleted,
    paymentOk,
    executionOk,
    artifactDeliveryOk,
    paymentAccepted,
    paymentStatus: paymentStatus || "unknown",
    settlementStatus,
    relayDeliveryStatus,
    agentExecutionStatus,
    jobCompleted,
    retryable: paymentOk && !executionOk,
    nextAction: acceptedPendingResult
      ? "poll_state_or_resume_same_payment"
      : paymentOk && !executionOk
        ? "retry_delivery_or_resume_execution"
        : jobCompleted
          ? "none"
          : "inspect_payment_state",
    code: jobCompleted
      ? "paid_execution_completed"
      : acceptedPendingResult
        ? "job_running_or_return_timeout"
        : "paid_execution_not_completed",
    ...(acceptedPendingResult
      ? {
          safeToRetrySamePayload: true,
          doNotCreateNewPayment: true
        }
      : {})
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}
if (!args["allow-real-money"]) {
  printUsage();
  throw new Error("--allow-real-money is required to submit a fixed-price x402 payment.");
}

const apiBase = normalizeBaseUrl(String(args["api-base"] ?? process.env.CLAWZ_API_BASE ?? "https://api.santaclawz.ai").trim());
const agentId = String(args["agent-id"] ?? "").trim();
const taskPrompt = String(args.task ?? "").trim();
const requesterContact = String(args["requester-contact"] ?? "buyer-agent:local").trim();
const paymentPayloadPath = typeof args["payment-payload-file"] === "string" ? args["payment-payload-file"].trim() : "";
if (!agentId) throw new Error("--agent-id is required.");
if (!taskPrompt) throw new Error("--task is required.");
if (taskPrompt.length > HIRE_TASK_PROMPT_MAX_LENGTH) {
  throw new Error(`--task is ${taskPrompt.length} characters; SantaClawz fixed-price hire requests currently allow ${HIRE_TASK_PROMPT_MAX_LENGTH}. Use quote/procurement/workspace for longer specs.`);
}
if (requesterContact.length > HIRE_REQUESTER_CONTACT_MAX_LENGTH) {
  throw new Error(`--requester-contact is ${requesterContact.length} characters; SantaClawz allows ${HIRE_REQUESTER_CONTACT_MAX_LENGTH}.`);
}
if (!paymentPayloadPath) throw new Error("--payment-payload-file is required.");

const paymentPayload = normalizePaymentPayloadFromFile(readJsonFile(paymentPayloadPath, "payment payload"), {
  service: typeof args.service === "string" ? args.service : ""
});
const requestBody = {
  taskPrompt,
  requesterContact,
  paymentPayload
};
const requestBodyBytes = Buffer.byteLength(JSON.stringify(requestBody), "utf8");
if (requestBodyBytes > HIRE_REQUEST_BODY_MAX_BYTES) {
  throw new Error(`Fixed-price hire request body is ${requestBodyBytes} bytes; SantaClawz allows ${HIRE_REQUEST_BODY_MAX_BYTES}. Shorten the task or use quote/procurement/workspace.`);
}

let response;
try {
  response = await fetch(`${apiBase}/api/agents/${encodeURIComponent(agentId)}/hire`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody)
  });
} catch (error) {
  if (!isRetryablePlatformTransportError(error)) throw error;
  const payload = createRetryablePlatformFailure(0, error instanceof Error ? error.message : String(error), {
    code: "post_payment_state_unavailable_retryable",
    paymentStatus: "authorized",
    settlementStatus: "unknown",
    relayDeliveryStatus: "not_confirmed",
    agentExecutionStatus: "not_confirmed",
    paymentPayloadDigestSha256: digestJson(paymentPayload)
  });
  console.log(JSON.stringify(payload, null, 2));
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
        agentExecutionStatus: "not_confirmed",
        paymentPayloadDigestSha256: digestJson(paymentPayload)
      })
    : { error: responseText.slice(0, 1000) };
}

const output = {
  ...paidExecutionSummary(response.ok, payload),
  status: response.status,
  agentId,
  paymentPayloadDigestSha256: digestJson(paymentPayload),
  response: payload,
  ...(payload?.requestId
    ? {
        stateUrl: `${apiBase}/api/executions/${encodeURIComponent(payload.requestId)}/state`
      }
    : {
        paymentStateUrl: `${apiBase}/api/x402/payment-state?paymentPayloadDigestSha256=${digestJson(paymentPayload)}`
      })
};
console.log(JSON.stringify(output, null, 2));

if (!output.ok) {
  process.exitCode = 1;
}
