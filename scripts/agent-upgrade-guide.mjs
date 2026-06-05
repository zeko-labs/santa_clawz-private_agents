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
  return {
    schemaVersion: "santaclawz-agent-upgrade-guide/1.0",
    doc: "docs/start-here/agent-upgrade-guide.md",
    envFile,
    commands: [
      "git pull --ff-only",
      "corepack enable",
      "pnpm install --frozen-lockfile",
      readinessCommand,
      paidSmokeCommand
    ],
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
  guide.commands.forEach((command, index) => {
    console.log(`${index + 1}. ${command}`);
  });
  console.log("");
  console.log("Rule: sellerExecutionCompleted is seller reputation; buyerComplete is buyer success.");
  console.log("If buyer delivery is missing after a verified seller return, update runtime code and rerun readiness.");
}
