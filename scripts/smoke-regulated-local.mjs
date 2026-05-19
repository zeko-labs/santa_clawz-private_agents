import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const workspaceRoot = process.cwd();
const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawz-regulated-local-"));

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnProcess(command, args, env) {
  const child = spawn(command, args, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitForHealth(url, label) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}

    await wait(1000);
  }

  throw new Error(`Timed out waiting for ${label} health at ${url}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

const enterpriseKmsPort = process.env.CLAWZ_ENTERPRISE_KMS_PORT ?? "8791";
const privacyGatewayPort = process.env.CLAWZ_PRIVACY_GATEWAY_PORT ?? "8789";
const sampleCommand = `CLAWZ_EXAMPLE_HSM_ROOT_KEY_BASE64=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= node ${path.join(
  workspaceRoot,
  "scripts",
  "example-hsm-command.mjs"
)}`;

const enterpriseKms = spawnProcess("node", [path.join(workspaceRoot, "apps", "enterprise-kms", "dist", "server.js")], {
  HOST: "127.0.0.1",
  PORT: enterpriseKmsPort,
  NODE_ENV: "production",
  CLAWZ_RUNTIME_ENV: "production",
  CLAWZ_DATA_DIR: tempDir,
  CLAWZ_ENTERPRISE_KMS_PROVIDER_MODE: "command-adapter",
  CLAWZ_ENTERPRISE_KMS_API_KEY: "enterprise_secret",
  CLAWZ_ENTERPRISE_KMS_COMMAND: sampleCommand
});

const privacyGateway = spawnProcess("node", [path.join(workspaceRoot, "apps", "privacy-gateway", "dist", "server.js")], {
  HOST: "127.0.0.1",
  PORT: privacyGatewayPort,
  NODE_ENV: "production",
  CLAWZ_RUNTIME_ENV: "production",
  CLAWZ_REGULATED_ENTERPRISE: "true",
  CLAWZ_DATA_DIR: tempDir,
  CLAWZ_PRIVACY_GATEWAY_KEY_PROVIDER: "external-hsm-derive",
  CLAWZ_PRIVACY_GATEWAY_HSM_ENDPOINT: `http://127.0.0.1:${enterpriseKmsPort}`,
  CLAWZ_PRIVACY_GATEWAY_HSM_API_KEY: "enterprise_secret",
  CLAWZ_PRIVACY_GATEWAY_API_KEY: "gateway_secret"
});

try {
  await waitForHealth(`http://127.0.0.1:${enterpriseKmsPort}/health`, "enterprise kms");
  await waitForHealth(`http://127.0.0.1:${privacyGatewayPort}/health`, "privacy gateway");

  const checker = spawn("node", ["scripts/check-privacy-gateway.mjs", "--json", "--require-external-hsm"], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      CLAWZ_REGULATED_ENTERPRISE: "true",
      CLAWZ_PRIVACY_GATEWAY_ENDPOINT: `http://127.0.0.1:${privacyGatewayPort}`,
      CLAWZ_PRIVACY_GATEWAY_API_KEY: "gateway_secret"
    },
    stdio: "inherit"
  });

  const exitCode = await new Promise((resolve) => checker.once("exit", resolve));
  if (exitCode !== 0) {
    process.exitCode = exitCode ?? 1;
  }
} finally {
  await stopChild(privacyGateway);
  await stopChild(enterpriseKms);
  await rm(tempDir, { recursive: true, force: true });
}
