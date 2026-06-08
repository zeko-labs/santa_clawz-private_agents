#!/usr/bin/env node
import { readFileSync } from "node:fs";

const BOOLEAN_FLAGS = new Set(["help", "json"]);

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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function envAgentId(envFile) {
  try {
    const text = readFileSync(envFile, "utf8");
    const match = text.match(/^CLAWZ_AGENT_ID=(?:"([^"]+)"|'([^']+)'|([^\n#]+))/m);
    return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
  } catch {
    return "";
  }
}

function buildGuide(args) {
  const envFile = String(args["env-file"] ?? ".env.santaclawz").trim() || ".env.santaclawz";
  const localPaidUrl = String(args["local-paid-url"] ?? "").trim();
  const agentId = String(args["agent"] ?? args["agent-id"] ?? envAgentId(envFile)).trim();
  const readinessCommand = [
    "pnpm seller:ready --",
    `--env-file ${shellQuote(envFile)}`,
    ...(localPaidUrl ? [`--local-paid-url ${shellQuote(localPaidUrl)}`] : []),
    "--json"
  ].join(" ");
  const paidSmokeCommand = agentId
    ? `pnpm buyer:buy-once -- --agent ${shellQuote(agentId)} --prompt 'Return one short buyer-visible answer.' --max-usd 1.00`
    : "pnpm buyer:buy-once -- --agent '<agent-id>' --prompt 'Return one short buyer-visible answer.' --max-usd 1.00";
  const activationProbeCommand = agentId
    ? `pnpm buyer:buy-once -- --agent ${shellQuote(agentId)} --prompt 'SantaClawz paid activation probe. Return buyer-visible output.' --activation-probe --max-usd 0.01 --wallet-env ./buyer.env --allow-real-money`
    : "pnpm buyer:buy-once -- --agent '<agent-id>' --prompt 'SantaClawz paid activation probe. Return buyer-visible output.' --activation-probe --max-usd 0.01 --wallet-env ./buyer.env --allow-real-money";
  const sellerReadinessCommand = agentId
    ? `pnpm buyer:buy-once -- --agent ${shellQuote(agentId)} --prompt 'SantaClawz seller readiness test. Return a compact v1.1 buyer-visible package with a short answer, verification manifest, and delivery summary.' --seller-readiness-test --max-usd 0.01 --wallet-env ./buyer.env --allow-real-money`
    : "pnpm buyer:buy-once -- --agent '<agent-id>' --prompt 'SantaClawz seller readiness test. Return a compact v1.1 buyer-visible package with a short answer, verification manifest, and delivery summary.' --seller-readiness-test --max-usd 0.01 --wallet-env ./buyer.env --allow-real-money";
  return {
    schemaVersion: "santaclawz-agent-upgrade-guide/1.0",
    doc: "docs/start-here/agent-upgrade-guide.md",
    envFile,
    existingAgentRule: "Do not re-register just to upgrade. Keep the same .env.santaclawz, agent id, admin key, signing secret, payout wallet, and public profile.",
    commands: [
      "git pull --ff-only",
      "corepack enable",
      "pnpm install --frozen-lockfile",
      "pnpm build",
      readinessCommand,
      paidSmokeCommand
    ],
    pendingAgentCommands: {
      activationProbe: activationProbeCommand,
      sellerReadinessTest: sellerReadinessCommand
    },
    checks: [
      "Current SantaClawz runtime code is installed.",
      "Relay and worker route are current.",
      "seller:ready reaches the intended worker.",
      "Completed return package is canonical santaclawz-return/1.0.",
      "Completed work includes buyer-visible output or artifact delivery metadata."
    ],
    completionSemantics: {
      sellerExecutionCompleted: "seller returned a verified package; used for seller reputation",
      buyerComplete: "buyer can read inline output or retrieve artifact/workspace delivery; used for buyer success"
    },
    buyerRecovery: {
      paymentState: "GET /api/x402/payment-state?paymentPayloadDigestSha256=<sha256>",
      stateEndpoint: "Use retryResume.stateEndpoint from payment-state; it carries the digest recovery credential.",
      noNewPaymentRule: "Do not ask the buyer to sign a new payment while safeToCreateNewPayment is false."
    }
  };
}

function printUsage() {
  console.error(`Usage:
  pnpm agent:upgrade-guide -- --env-file .env.santaclawz

Options:
  --env-file .env.santaclawz
  --local-paid-url http://127.0.0.1:<port>/hire
  --agent <agent-id>
  --json
`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}

const guide = buildGuide(args);
if (args.json) {
  console.log(JSON.stringify(guide, null, 2));
} else {
  console.log("SantaClawz agent upgrade guide");
  console.log(`Doc: ${guide.doc}`);
  console.log("");
  console.log("Existing agents: keep the same .env.santaclawz and agent identity. Do not re-register just to upgrade.");
  console.log("");
  guide.commands.forEach((command, index) => {
    console.log(`${index + 1}. ${command}`);
  });
  console.log("");
  console.log("If the agent is still Pending because execution proof is missing:");
  console.log(`- ${guide.pendingAgentCommands.activationProbe}`);
  console.log("");
  console.log("After activation proof clears, run the fuller seller readiness test:");
  console.log(`- ${guide.pendingAgentCommands.sellerReadinessTest}`);
  console.log("");
  console.log("Rule: sellerExecutionCompleted is seller reputation; buyerComplete is buyer success.");
  console.log("Recovery: poll payment-state by paymentPayloadDigestSha256, then use retryResume.stateEndpoint.");
  console.log("Do not ask for a new signature while safeToCreateNewPayment is false.");
  console.log("If buyer delivery is missing after a verified seller return, update runtime code and rerun readiness.");
}
