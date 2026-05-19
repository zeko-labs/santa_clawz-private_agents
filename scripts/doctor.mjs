import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const workspaceRoot = process.cwd();
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const MODES = {
  quick: {
    label: "quick",
    commands: [
      ["pnpm", ["build"]],
      ["pnpm", ["test:key-broker"]]
    ]
  },
  full: {
    label: "full",
    commands: [
      ["pnpm", ["build"]],
      ["pnpm", ["typecheck"]],
      ["pnpm", ["test:key-broker"]],
      ["pnpm", ["test:enterprise-kms"]],
      ["pnpm", ["test:privacy-gateway"]],
      ["pnpm", ["test:contracts"]],
      ["pnpm", ["test:indexer"]],
      ["pnpm", ["test:interop-sdk"]]
    ]
  },
  testnet: {
    label: "testnet",
    commands: [
      ["pnpm", ["preflight:testnet"]],
      ["pnpm", ["--filter", "@clawz/contracts", "check:vk-drift"]]
    ]
  }
};

function parseArgs(argv) {
  let mode = "quick";
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--full") {
      mode = "full";
      continue;
    }

    if (token === "--testnet") {
      mode = "testnet";
      continue;
    }

    if (token === "--json") {
      json = true;
      continue;
    }

    if (token === "--help" || token === "-h") {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return {
    mode,
    json
  };
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/doctor.mjs [--full | --testnet] [--json]",
      "",
      "Modes:",
      "  quick     Build + privacy-runtime sanity checks (default)",
      "  full      Deep local validation including indexer + SDK integration",
      "  testnet   Zeko preflight + verification-key drift check",
      "",
      "Flags:",
      "  --json    Print the final report as JSON"
    ].join("\n")
  );
}

async function exists(relativePath) {
  try {
    await access(path.join(workspaceRoot, relativePath), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function envFileHasKey(relativePath, key) {
  try {
    const content = await readFile(path.join(workspaceRoot, relativePath), "utf8");
    return new RegExp(`^\\s*${key}\\s*=`, "m").test(content);
  } catch {
    return false;
  }
}

function effectiveKeyBrokerMode() {
  return process.env.CLAWZ_KEY_BROKER_MODE === "in-memory-default-export"
    ? "in-memory-default-export"
    : "durable-local-file-backed";
}

function effectiveKeyBrokerDir() {
  return process.env.CLAWZ_KEY_BROKER_DIR?.trim() || path.join(workspaceRoot, ".clawz-data", "kms");
}

function nodeMajorVersion() {
  const major = Number(process.versions.node.split(".")[0] ?? "0");
  return Number.isFinite(major) ? major : 0;
}

async function collectStaticChecks(mode) {
  const checks = [
    {
      label: "workspace root",
      ok: await exists("pnpm-workspace.yaml"),
      detail: "pnpm workspace manifest"
    },
    {
      label: "web console",
      ok: await exists("apps/web-console/package.json"),
      detail: "apps/web-console/package.json"
    },
    {
      label: "indexer",
      ok: await exists("apps/indexer/package.json"),
      detail: "apps/indexer/package.json"
    },
    {
      label: "enterprise kms",
      ok: await exists("apps/enterprise-kms/package.json"),
      detail: "apps/enterprise-kms/package.json"
    },
    {
      label: "privacy gateway",
      ok: await exists("apps/privacy-gateway/package.json"),
      detail: "apps/privacy-gateway/package.json"
    },
    {
      label: "contracts",
      ok: await exists("packages/contracts/package.json"),
      detail: "packages/contracts/package.json"
    },
    {
      label: "key broker runtime",
      ok: true,
      detail: `${effectiveKeyBrokerMode()} (${effectiveKeyBrokerDir()})`
    },
    {
      label: "Node.js version",
      ok: nodeMajorVersion() >= 20,
      detail: process.version
    }
  ];

  if (mode === "testnet") {
    checks.push(
      {
        label: "contracts env file",
        ok: await exists("packages/contracts/.env"),
        detail: "packages/contracts/.env"
      },
      {
        label: "deployer secret configured",
        ok:
          Boolean(process.env.DEPLOYER_PRIVATE_KEY?.trim()) ||
          (await envFileHasKey("packages/contracts/.env", "DEPLOYER_PRIVATE_KEY")),
        detail: "DEPLOYER_PRIVATE_KEY in env or packages/contracts/.env"
      },
      {
        label: "deployment manifest",
        ok: await exists("packages/contracts/deployments/latest-testnet.json"),
        detail: "packages/contracts/deployments/latest-testnet.json"
      }
    );
  }

  return checks;
}

async function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: "inherit"
    });

    child.once("exit", (code) => {
      resolve({
        ok: code === 0,
        code: code ?? 1,
        command: [command, ...args].join(" ")
      });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const staticChecks = await collectStaticChecks(options.mode);
  const mode = MODES[options.mode];

  const report = {
    mode: mode.label,
    workspaceRoot,
    staticChecks,
    commands: [],
    ok: false
  };

  if (staticChecks.some((check) => !check.ok)) {
    report.ok = false;
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.error(`ClawZ doctor failed before running commands (${mode.label} mode).`);
      staticChecks.forEach((check) => {
        console.error(`${check.ok ? "ok " : "bad"} ${check.label}: ${check.detail}`);
      });
    }
    process.exitCode = 1;
    return;
  }

  if (!options.json) {
    console.log(`ClawZ doctor running in ${mode.label} mode`);
    staticChecks.forEach((check) => {
      console.log(`ok  ${check.label}: ${check.detail}`);
    });
  }

  for (const [commandName, args] of mode.commands) {
    const command = commandName === "pnpm" ? pnpmBin : commandName;
    if (!options.json) {
      console.log(`\n==> ${[commandName, ...args].join(" ")}`);
    }

    const result = await runCommand(command, args);
    report.commands.push(result);

    if (!result.ok) {
      report.ok = false;
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.error(`\nClawZ doctor failed in ${mode.label} mode at: ${result.command}`);
      }
      process.exitCode = 1;
      return;
    }
  }

  report.ok = true;

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nClawZ doctor passed (${mode.label} mode).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
