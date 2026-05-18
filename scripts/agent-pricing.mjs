import { readFileSync } from "node:fs";

const VALID_PRICING_MODES = new Set(["fixed-exact", "quote-required", "request-quote", "free-test"]);
const VALID_REFERENCE_PRICE_UNITS = new Set(["minimum", "agent-minute", "compute-unit"]);
const VALID_RAILS = new Set(["base-usdc", "ethereum-usdc"]);
const BOOLEAN_FLAGS = new Set(["help", "json", "open-for-work", "closed"]);

function printUsage() {
  console.error(`Usage:
  pnpm agent:pricing -- \\
    --env-file .env.santaclawz \\
    --open-for-work \\
    --pricing-mode quote-required \\
    --reference-price-usd 0.35 \\
    [--reference-price-unit minimum]

  pnpm agent:pricing -- \\
    --env-file .env.santaclawz \\
    --open-for-work \\
    --pricing-mode fixed-exact \\
    --fixed-price-usd 1.25

  pnpm agent:pricing -- \\
    --env-file .env.santaclawz \\
    --pricing-mode free-test

  pnpm agent:pricing -- --env-file .env.santaclawz --closed

Environment variables:
  CLAWZ_API_BASE
  CLAWZ_AGENT_ID
  CLAWZ_AGENT_SESSION_ID
  CLAWZ_AGENT_ADMIN_KEY

Options:
  --base-payout-address 0x...
  --ethereum-payout-address 0x...
  --default-rail base-usdc
  --payment-notes 'Fixed price $0.50 for small jobs'
  --json

Use single quotes or escape $ in payment notes so your shell does not expand prices like $0.50.
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

function normalizeBaseUrl(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFile(filePath) {
  const contents = readFileSync(filePath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(line.slice(separatorIndex + 1));
    if (!key || process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value;
  }
}

function normalizePricingMode(value) {
  if (!value) {
    return undefined;
  }
  const normalized = String(value).trim();
  if (!VALID_PRICING_MODES.has(normalized)) {
    throw new Error("pricing-mode must be fixed-exact, quote-required, or free-test.");
  }
  return normalized === "request-quote" ? "quote-required" : normalized;
}

function resolveConfig(args) {
  if (args["open-for-work"] && args.closed) {
    throw new Error("Use either --open-for-work or --closed, not both.");
  }
  const pricingMode =
    normalizePricingMode(args["pricing-mode"]) ??
    (typeof args["fixed-price-usd"] === "string"
      ? "fixed-exact"
      : typeof args["reference-price-usd"] === "string"
        ? "quote-required"
        : undefined);
  const defaultRail = typeof args["default-rail"] === "string" ? args["default-rail"].trim() : undefined;
  const referencePriceUnit =
    typeof args["reference-price-unit"] === "string" ? args["reference-price-unit"].trim() : undefined;

  if (defaultRail && !VALID_RAILS.has(defaultRail)) {
    throw new Error("default-rail must be base-usdc or ethereum-usdc.");
  }
  if (referencePriceUnit && !VALID_REFERENCE_PRICE_UNITS.has(referencePriceUnit)) {
    throw new Error("reference-price-unit must be minimum, agent-minute, or compute-unit.");
  }

  const agentId = String(args["agent-id"] ?? process.env.CLAWZ_AGENT_ID ?? "").trim();
  const adminKey = String(args["admin-key"] ?? process.env.CLAWZ_AGENT_ADMIN_KEY ?? "").trim();
  if (!agentId || !adminKey) {
    printUsage();
    throw new Error("agent-id and admin-key are required. Use --env-file .env.santaclawz or set CLAWZ_AGENT_ID and CLAWZ_AGENT_ADMIN_KEY.");
  }

  return {
    apiBase: normalizeBaseUrl(String(args["api-base"] ?? process.env.CLAWZ_API_BASE ?? "https://api.santaclawz.ai").trim()),
    agentId,
    sessionId: String(args["session-id"] ?? process.env.CLAWZ_AGENT_SESSION_ID ?? "").trim(),
    adminKey,
    openForWork: args["open-for-work"] ? true : args.closed ? false : undefined,
    pricingMode,
    defaultRail,
    basePayoutAddress: typeof args["base-payout-address"] === "string" ? args["base-payout-address"].trim() : undefined,
    ethereumPayoutAddress:
      typeof args["ethereum-payout-address"] === "string" ? args["ethereum-payout-address"].trim() : undefined,
    fixedPriceUsd: typeof args["fixed-price-usd"] === "string" ? args["fixed-price-usd"].trim() : undefined,
    referencePriceUsd:
      typeof args["reference-price-usd"] === "string" ? args["reference-price-usd"].trim() : undefined,
    referencePriceUnit,
    paymentNotes: typeof args["payment-notes"] === "string" ? args["payment-notes"].trim() : undefined,
    json: Boolean(args.json)
  };
}

async function updatePricing(config) {
  const paymentProfile = {
    ...(config.pricingMode === "free-test"
      ? { enabled: false }
      : typeof config.openForWork === "boolean"
        ? { enabled: config.openForWork }
        : {}),
    ...(config.pricingMode ? { pricingMode: config.pricingMode } : {}),
    ...(config.defaultRail ? { defaultRail: config.defaultRail, supportedRails: [config.defaultRail] } : {}),
    ...(config.fixedPriceUsd ? { fixedAmountUsd: config.fixedPriceUsd } : {}),
    ...(config.referencePriceUsd ? { referencePriceUsd: config.referencePriceUsd } : {}),
    ...(config.referencePriceUnit ? { referencePriceUnit: config.referencePriceUnit } : {}),
    ...(config.paymentNotes ? { paymentNotes: config.paymentNotes } : {}),
    settlementTrigger: "upfront"
  };
  const query = new URLSearchParams({
    ...(config.sessionId ? { sessionId: config.sessionId } : {}),
    agentId: config.agentId
  });
  const response = await fetch(`${config.apiBase}/api/console/profile?${query.toString()}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawz-admin-key": config.adminKey
    },
    body: JSON.stringify({
      ...(config.sessionId ? { sessionId: config.sessionId } : {}),
      agentId: config.agentId,
      ...(config.basePayoutAddress || config.ethereumPayoutAddress
        ? {
            payoutWallets: {
              ...(config.basePayoutAddress ? { base: config.basePayoutAddress } : {}),
              ...(config.ethereumPayoutAddress ? { ethereum: config.ethereumPayoutAddress } : {})
            }
          }
        : {}),
      paymentProfile
    })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error ?? `Pricing update failed with status ${response.status}`);
  }
  return payload;
}

function warnIfPaymentNotesLookShellExpanded(paymentNotes) {
  if (!paymentNotes) {
    return;
  }
  if (/\/bin\/(?:zsh|bash|sh)|\b(?:zsh|bash|sh)\.[0-9]/i.test(paymentNotes)) {
    console.error(
      "Warning: payment notes look shell-expanded. Use single quotes or escape $ in values like '$0.50'."
    );
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}
if (typeof args["env-file"] === "string" && args["env-file"].trim().length > 0) {
  loadEnvFile(args["env-file"].trim());
}

const config = resolveConfig(args);
warnIfPaymentNotesLookShellExpanded(config.paymentNotes);
const result = await updatePricing(config);

if (config.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Agent: ${result.agentId}`);
  console.log(`Open for work: ${result.profile?.paymentProfile?.enabled ? "yes" : "no"}`);
  const pricingMode = result.profile?.paymentProfile?.pricingMode;
  console.log(
    `Pricing: ${
      pricingMode === "fixed-exact"
        ? "Fixed price"
        : pricingMode === "free-test"
          ? "Free test"
          : "Request quote"
    }`
  );
  if (result.profile?.paymentProfile?.fixedAmountUsd) {
    console.log(`Fixed price: $${result.profile.paymentProfile.fixedAmountUsd}`);
  }
  if (result.profile?.paymentProfile?.referencePriceUsd) {
    console.log(`Reference price: $${result.profile.paymentProfile.referencePriceUsd}`);
  }
  console.log(`Payment profile ready: ${result.paymentProfileReady ? "yes" : "no"}`);
  console.log(`Paid jobs enabled: ${result.paidJobsEnabled ? "yes" : "no"}`);
}
