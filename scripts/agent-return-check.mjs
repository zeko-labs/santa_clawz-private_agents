#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const starterEntry = path.join(repoRoot, "starters", "openclaw-public-hire-ingress", "server.mjs");

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
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function printUsage() {
  console.error(`Usage:
  pnpm agent:return-check -- --agent-env-file .env.santaclawz --sample-return ./sample-return.json

Options:
  --sample-return <path>       Required local return package to validate.
  --agent-env-file <path>      Optional .env.santaclawz file for operator context.
  --request-id <id>            Expected request_id. Defaults to the sample package request_id.
  --normalized-output <path>   Write the normalized santaclawz-return/1.0 JSON package.
`);
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  printUsage();
  process.exit(1);
}

if (!args["sample-return"]) {
  printUsage();
  process.exit(1);
}

const childArgs = [
  starterEntry,
  "--sample-return",
  args["sample-return"]
];
if (args["agent-env-file"]) {
  childArgs.push("--agent-env-file", args["agent-env-file"]);
}
if (args["request-id"]) {
  childArgs.push("--request-id", args["request-id"]);
}
if (args["normalized-output"]) {
  childArgs.push("--normalized-output", args["normalized-output"]);
}

const child = spawn(process.execPath, childArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
