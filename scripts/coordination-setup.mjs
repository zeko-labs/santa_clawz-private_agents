#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function usage() {
  return `Usage:
  pnpm coordination:setup split --manifest ./bridge.json --out-dir ./.santaclawz/coordination
  pnpm coordination:setup accept --manifest ./bridge.json --agent-id agent_... --admin-key sk_... --format env
  pnpm coordination:setup accept --setup ./agent_....setup.json --format json
  pnpm coordination:setup claim --ticket scz_coord_... --agent-id agent_... --api-base https://api.santaclawz.ai --format env

Options:
  --manifest <path|url>        Bridge manifest JSON. Falls back to SANTACLAWZ_BRIDGE_MANIFEST_JSON.
  --setup <path|url>           Per-agent setup JSON for accept mode.
  --ticket <token>             Short-lived SantaClawz setup ticket for claim mode.
  --agent-id <id>              Participant agent id for accept mode.
  --api-base <url>             SantaClawz API base for claim mode. Default: SANTACLAWZ_API_BASE or http://127.0.0.1:4318
  --admin-key <key>            Optional local admin key to include in the generated setup/env.
  --admin-keys <path>          Optional JSON object of agentId -> admin key for split mode.
  --out-dir <path>             Output directory for split mode. Default: ./.santaclawz/coordination
  --format <json|env>          Output format for accept mode. Default: json
`;
}

function argValue(name, fallback = "") {
  const prefixed = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefixed));
  if (inline) {
    return inline.slice(prefixed.length).trim();
  }
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1].trim();
  }
  return fallback;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function readTextSource(source, label) {
  if (!source) {
    throw new Error(`${label} is required.`);
  }
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`GET ${source} failed: ${response.status} ${text}`);
    }
    return text;
  }
  return readFile(source, "utf8");
}

async function readJsonSource(source, label) {
  return JSON.parse(await readTextSource(source, label));
}

function envOutput(setup) {
  const manifestJson = JSON.stringify(setup.manifest);
  const setupJson = JSON.stringify(setup);
  const lines = [
    `export SANTACLAWZ_COORDINATION_AGENT_SETUP_JSON=${shellQuote(setupJson)}`,
    `export SANTACLAWZ_BRIDGE_MANIFEST_JSON=${shellQuote(manifestJson)}`,
    `export SANTACLAWZ_AGENT_ID=${shellQuote(setup.agentId)}`,
    `export SANTACLAWZ_API_BASE=${shellQuote(setup.apiBase)}`,
    `export SANTACLAWZ_COORDINATION_THREAD_ID=${shellQuote(setup.threadId)}`,
    `export SANTACLAWZ_COORDINATION_WORKFLOW_ID=${shellQuote(setup.swarmId)}`,
    `export SANTACLAWZ_COORDINATION_PRIVACY_MODE=${shellQuote(setup.privacyMode)}`,
    `export SANTACLAWZ_COORDINATION_PUBLIC_TRACE_URL=${shellQuote(setup.publicTraceUrl)}`
  ];
  if (setup.adminKey) {
    lines.push(`export SANTACLAWZ_AGENT_ADMIN_KEY=${shellQuote(setup.adminKey)}`);
  }
  return `${lines.join("\n")}\n`;
}

async function loadSdk() {
  const sdkPath = path.resolve("packages/agent-sdk/dist/agent-sdk/src/index.js");
  return import(pathToFileURL(sdkPath).href);
}

async function readManifest() {
  const manifestSource = argValue("manifest");
  if (manifestSource) {
    return readJsonSource(manifestSource, "--manifest");
  }
  const manifestJson = process.env.SANTACLAWZ_BRIDGE_MANIFEST_JSON;
  if (!manifestJson) {
    throw new Error("--manifest or SANTACLAWZ_BRIDGE_MANIFEST_JSON is required.");
  }
  return JSON.parse(manifestJson);
}

async function splitSetups(sdk) {
  const manifest = sdk.parseCoordinationBridgeManifest(await readManifest());
  const outDir = argValue("out-dir", path.join(".santaclawz", "coordination"));
  const adminKeysPath = argValue("admin-keys");
  const adminKeys = adminKeysPath ? await readJsonSource(adminKeysPath, "--admin-keys") : {};
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const written = [];
  for (const participant of manifest.participants) {
    const adminKey = typeof adminKeys[participant.agentId] === "string" ? adminKeys[participant.agentId] : undefined;
    const setup = sdk.createCoordinationAgentSetup({
      manifest,
      agentId: participant.agentId,
      ...(adminKey ? { adminKey } : {})
    });
    const jsonPath = path.join(outDir, `${participant.agentId}.setup.json`);
    const envPath = path.join(outDir, `${participant.agentId}.env`);
    await writeFile(jsonPath, `${JSON.stringify(setup, null, 2)}\n`, { mode: 0o600 });
    await writeFile(envPath, envOutput(setup), { mode: 0o600 });
    written.push({
      agentId: participant.agentId,
      role: setup.role,
      setupPath: jsonPath,
      envPath,
      hasAdminKey: Boolean(setup.adminKey)
    });
  }
  console.log(JSON.stringify({
    ok: true,
    mode: "split",
    outDir,
    threadId: manifest.threadId,
    swarmId: manifest.swarmId,
    participants: written
  }, null, 2));
}

async function acceptSetup(sdk) {
  const setupSource = argValue("setup");
  const format = argValue("format", "json");
  const setup = setupSource
    ? sdk.parseCoordinationAgentSetup(await readJsonSource(setupSource, "--setup"))
    : sdk.createCoordinationAgentSetup({
        manifest: await readManifest(),
        agentId: argValue("agent-id", process.env.SANTACLAWZ_AGENT_ID ?? ""),
        adminKey: argValue("admin-key", process.env.SANTACLAWZ_AGENT_ADMIN_KEY ?? "")
      });
  if (format === "env") {
    process.stdout.write(envOutput(setup));
    return;
  }
  if (format !== "json") {
    throw new Error("--format must be json or env.");
  }
  console.log(JSON.stringify(setup, null, 2));
}

async function claimSetup(sdk) {
  const ticket = argValue("ticket", process.env.SANTACLAWZ_COORDINATION_SETUP_TICKET ?? "");
  const agentId = argValue("agent-id", process.env.SANTACLAWZ_AGENT_ID ?? "");
  const apiBase = argValue("api-base", process.env.SANTACLAWZ_API_BASE ?? "http://127.0.0.1:4318").replace(/\/+$/, "");
  const format = argValue("format", "json");
  if (!ticket) {
    throw new Error("--ticket or SANTACLAWZ_COORDINATION_SETUP_TICKET is required for claim mode.");
  }
  if (!agentId) {
    throw new Error("--agent-id or SANTACLAWZ_AGENT_ID is required for claim mode.");
  }
  const response = await fetch(`${apiBase}/api/coordination/setup-tickets/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket, agentId })
  });
  const payloadText = await response.text();
  const payload = payloadText ? JSON.parse(payloadText) : {};
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : `Claim failed: ${response.status}`);
  }
  const setup = sdk.parseCoordinationAgentSetup(payload);
  if (format === "env") {
    process.stdout.write(envOutput(setup));
    return;
  }
  if (format !== "json") {
    throw new Error("--format must be json or env.");
  }
  console.log(JSON.stringify(setup, null, 2));
}

async function main() {
  const command = process.argv[2];
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(usage());
    return;
  }
  const sdk = await loadSdk();
  if (command === "split") {
    await splitSetups(sdk);
    return;
  }
  if (command === "accept") {
    await acceptSetup(sdk);
    return;
  }
  if (command === "claim") {
    await claimSetup(sdk);
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
