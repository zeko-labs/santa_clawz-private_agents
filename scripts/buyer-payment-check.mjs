#!/usr/bin/env node
import { readFileSync } from "node:fs";

const BOOLEAN_FLAGS = new Set(["help", "json"]);

function printUsage() {
  console.error(`Usage:
  pnpm buyer:payment:check -- \\
    --quote-manifest ./santaclawz_quote.json \\
    --payment-payload-file ./payment-payload.json

Options:
  --payment-requirement-file path   File containing the x402 payment requirement.
  --quote-manifest path             File containing paymentRequirement or acceptedQuote.paymentRequirement.
  --payment-payload-file path       Raw x402 payload, { paymentPayload }, or service-keyed wrapper.
  --service magic_8_ball            Select one service when the payload file contains multiple services.
  --json

This command validates payment JSON locally before submitting it to SantaClawz or the hosted facilitator.
It does not settle, verify on-chain, or spend funds.
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

function normalizePaymentPayload(paymentPayloadFile, service = "") {
  if (isX402PaymentPayload(paymentPayloadFile)) {
    return paymentPayloadFile;
  }
  if (isRecord(paymentPayloadFile) && isX402PaymentPayload(paymentPayloadFile.paymentPayload)) {
    return paymentPayloadFile.paymentPayload;
  }
  if (!isRecord(paymentPayloadFile)) {
    throw new Error("Payment payload file must contain a raw x402 payload, { paymentPayload }, or a service-keyed payload object.");
  }

  const selectedService = service.trim();
  if (selectedService) {
    const selected = paymentPayloadFile[selectedService];
    if (!selected) {
      throw new Error(`Payment payload file does not contain service key '${selectedService}'.`);
    }
    if (isX402PaymentPayload(selected)) {
      return selected;
    }
    if (isRecord(selected) && isX402PaymentPayload(selected.paymentPayload)) {
      return selected.paymentPayload;
    }
    throw new Error(`Service key '${selectedService}' does not contain a valid x402 payment payload.`);
  }

  const candidates = Object.entries(paymentPayloadFile).filter(([, value]) => {
    return isX402PaymentPayload(value) || (isRecord(value) && isX402PaymentPayload(value.paymentPayload));
  });
  if (candidates.length === 1) {
    const [, value] = candidates[0];
    return isX402PaymentPayload(value) ? value : value.paymentPayload;
  }
  if (candidates.length > 1) {
    throw new Error(`Payment payload file contains multiple service-keyed x402 payloads. Pass --service. Available: ${candidates.map(([key]) => key).join(", ")}`);
  }
  throw new Error("Payment payload file does not contain a valid x402 payload.");
}

function findPaymentRequirement(value) {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.requestId === "string" && Array.isArray(value.accepts)) {
    return value;
  }
  const directCandidates = [
    value.paymentRequirement,
    isRecord(value.acceptedQuote) ? value.acceptedQuote.paymentRequirement : undefined,
    isRecord(value.response) ? value.response.paymentRequirement : undefined
  ];
  for (const candidate of directCandidates) {
    const found = findPaymentRequirement(candidate);
    if (found) {
      return found;
    }
  }
  for (const item of Object.values(value)) {
    const found = findPaymentRequirement(item);
    if (found) {
      return found;
    }
  }
  return null;
}

function sameAddress(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function sameAsset(left, right) {
  if (isRecord(left) && isRecord(right)) {
    return left.symbol === right.symbol &&
      left.decimals === right.decimals &&
      (left.standard ?? null) === (right.standard ?? null) &&
      sameAddress(left.address, right.address);
  }
  return left === right;
}

function matchingAccept(requirement, payload) {
  return Array.isArray(requirement?.accepts)
    ? requirement.accepts.find((option) => (
        isRecord(option) &&
        option.scheme === payload.scheme &&
        option.settlementRail === payload.settlementRail &&
        option.network === payload.networkId &&
        sameAsset(option.asset, payload.asset) &&
        String(option.amount ?? option.price ?? "") === String(payload.amount ?? "") &&
        sameAddress(option.payTo, payload.payTo)
      ))
    : null;
}

function add(errors, condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function validatePaymentPayload(input) {
  const errors = [];
  const warnings = [];
  const { paymentRequirement, paymentPayload } = input;
  add(errors, paymentPayload.protocol === "x402", "paymentPayload.protocol must be 'x402'.");
  add(errors, typeof paymentPayload.networkId === "string", "paymentPayload.networkId is required.");
  add(errors, paymentPayload.settlementRail === "evm", "paymentPayload.settlementRail must be 'evm' for Base/Ethereum USDC.");
  add(errors, typeof paymentPayload.payTo === "string", "paymentPayload.payTo is required.");
  add(errors, typeof paymentPayload.amount === "string", "paymentPayload.amount is required.");
  add(errors, isRecord(paymentPayload.authorization), "paymentPayload.authorization is required.");
  add(errors, isRecord(paymentPayload.authorization?.typedData?.message), "paymentPayload.authorization.typedData.message is required.");
  add(errors, typeof paymentPayload.authorization?.signature === "string", "paymentPayload.authorization.signature is required.");
  add(errors, /^[a-f0-9]{64}$/i.test(String(paymentPayload.authorizationDigest ?? "")), "paymentPayload.authorizationDigest must be a 64-character hex digest.");

  const accept = matchingAccept(paymentRequirement, paymentPayload);
  add(errors, Boolean(accept), "Payment payload does not match any advertised payment requirement accept option.");

  const accepted = isRecord(paymentPayload.accepted) ? paymentPayload.accepted : null;
  add(errors, Boolean(accepted), "paymentPayload.accepted is required for the hosted EVM facilitator.");
  if (accepted) {
    add(errors, typeof accepted.asset === "string", "paymentPayload.accepted.asset must be the token address string.");
    add(errors, typeof accepted.amount === "string", "paymentPayload.accepted.amount is required.");
    add(errors, typeof accepted.payTo === "string", "paymentPayload.accepted.payTo is required.");
    if (accept) {
      const assetAddress = isRecord(accept.asset) ? accept.asset.address : accept.asset;
      add(errors, sameAddress(accepted.asset, assetAddress), "paymentPayload.accepted.asset does not match the advertised token address.");
      add(errors, accepted.amount === String(accept.amount ?? accept.price ?? ""), "paymentPayload.accepted.amount does not match the advertised amount.");
      add(errors, sameAddress(accepted.payTo, accept.payTo), "paymentPayload.accepted.payTo does not match the advertised seller payout wallet.");
    }
  }

  const feeSplit = isRecord(accept?.extensions?.evm?.feeSplit) ? accept.extensions.evm.feeSplit : null;
  if (feeSplit) {
    add(errors, isRecord(paymentPayload.feeAuthorization), "paymentPayload.feeAuthorization is required for exact fee-split payments.");
    add(errors, isRecord(paymentPayload.payload?.feeAuthorization), "paymentPayload.payload.feeAuthorization is required for direct hosted facilitator tests.");
    const hostedFeeSplit = isRecord(accepted?.extra?.feeSplit) ? accepted.extra.feeSplit : null;
    add(errors, Boolean(hostedFeeSplit), "paymentPayload.accepted.extra.feeSplit is required for exact fee-split payments.");
    if (hostedFeeSplit) {
      add(errors, hostedFeeSplit.grossAmount === String(paymentPayload.amount), "accepted.extra.feeSplit.grossAmount must equal paymentPayload.amount.");
      add(errors, String(hostedFeeSplit.sellerAmount ?? "") === String(feeSplit.sellerAmount ?? ""), "accepted.extra.feeSplit.sellerAmount does not match the advertised split.");
      add(errors, String(hostedFeeSplit.protocolFeeAmount ?? "") === String(feeSplit.protocolFeeAmount ?? ""), "accepted.extra.feeSplit.protocolFeeAmount does not match the advertised split.");
      add(errors, sameAddress(hostedFeeSplit.protocolFeePayTo, feeSplit.protocolFeePayTo), "accepted.extra.feeSplit.protocolFeePayTo does not match the advertised split.");
    }
  } else if (isRecord(paymentPayload.feeAuthorization)) {
    warnings.push("Payment payload includes feeAuthorization, but the matched accept option is not a fee-split rail.");
  }

  return {
    ok: errors.length === 0,
    shape: paymentPayload.payloadShape ?? (accepted ? "hosted-compatible-x402" : "legacy-x402"),
    requestId: paymentPayload.requestId,
    paymentId: paymentPayload.paymentId,
    settlementRail: paymentPayload.settlementRail,
    networkId: paymentPayload.networkId,
    amount: paymentPayload.amount,
    payTo: paymentPayload.payTo,
    errors,
    warnings
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}

const paymentPayloadPath = typeof args["payment-payload-file"] === "string" ? args["payment-payload-file"].trim() : "";
const paymentRequirementPath = typeof args["payment-requirement-file"] === "string" ? args["payment-requirement-file"].trim() : "";
const quoteManifestPath = typeof args["quote-manifest"] === "string" ? args["quote-manifest"].trim() : "";
if (!paymentPayloadPath) {
  printUsage();
  throw new Error("--payment-payload-file is required.");
}
if (!paymentRequirementPath && !quoteManifestPath) {
  printUsage();
  throw new Error("--payment-requirement-file or --quote-manifest is required.");
}

const paymentPayload = normalizePaymentPayload(readJsonFile(paymentPayloadPath, "payment payload"), String(args.service ?? ""));
const requirementSource = paymentRequirementPath
  ? readJsonFile(paymentRequirementPath, "payment requirement")
  : readJsonFile(quoteManifestPath, "quote manifest");
const paymentRequirement = findPaymentRequirement(requirementSource);
if (!paymentRequirement) {
  throw new Error("Unable to find paymentRequirement with requestId and accepts[].");
}

const report = validatePaymentPayload({ paymentRequirement, paymentPayload });
console.log(JSON.stringify(args.json ? report : report, null, 2));
if (!report.ok) {
  process.exitCode = 1;
}
