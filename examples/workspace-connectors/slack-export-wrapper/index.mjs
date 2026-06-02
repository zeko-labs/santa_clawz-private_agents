#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

function env(name, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function listJsonFiles(root) {
  const stats = statSync(root);
  if (stats.isFile()) {
    return root.endsWith(".json") ? [root] : [];
  }
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(root, entry.name);
    return entry.isDirectory() ? listJsonFiles(child) : child.endsWith(".json") ? [child] : [];
  });
}

function manifest() {
  const manifestPath = env("SANTACLAWZ_BRIDGE_MANIFEST");
  return manifestPath ? readJson(path.resolve(manifestPath)) : null;
}

function firstManifestAgent(input) {
  const participants = Array.isArray(input?.participants) ? input.participants : [];
  return participants.find((participant) => typeof participant?.agentId === "string")?.agentId ?? "";
}

async function main() {
  const bridge = manifest();
  const exportPath = path.resolve(env("SLACK_EXPORT_PATH", process.cwd()));
  const apiBase = env("SANTACLAWZ_API_BASE", bridge?.apiBase ?? "http://127.0.0.1:4318");
  const agentId = env("SANTACLAWZ_AGENT_ID", firstManifestAgent(bridge));
  const adminKey = env("SANTACLAWZ_AGENT_ADMIN_KEY");
  const threadId = env("SANTACLAWZ_THREAD_ID", bridge?.threadId ?? "thread_workspace_slack");
  const swarmId = env("SANTACLAWZ_SWARM_ID", bridge?.swarmId ?? "workspace_slack");
  const shouldPost = process.argv.includes("--post");

  if (!agentId) {
    throw new Error("Set SANTACLAWZ_AGENT_ID or pass a manifest with participants[0].agentId.");
  }

  const files = listJsonFiles(exportPath).slice(0, 2000);
  let messageCount = 0;
  const channelFiles = new Set();
  let latestTs = "";
  for (const filePath of files) {
    let payload;
    try {
      payload = readJson(filePath);
    } catch {
      continue;
    }
    if (!Array.isArray(payload)) {
      continue;
    }
    channelFiles.add(path.basename(path.dirname(filePath)));
    messageCount += payload.length;
    for (const item of payload) {
      if (typeof item?.ts === "string" && item.ts > latestTs) {
        latestTs = item.ts;
      }
    }
  }

  const privateDetail = JSON.stringify({
    exportPath,
    jsonFileCount: files.length,
    channelFileCount: channelFiles.size,
    messageCount,
    latestTs,
    generatedAtIso: new Date().toISOString()
  });
  const outputDigestSha256 = digest(privateDetail);
  const body = [
    `Slack local wrapper update: ${messageCount} exported messages across ${channelFiles.size} channel folders.`,
    latestTs ? `Latest exported timestamp ${latestTs}.` : "No message timestamps found.",
    `Private Slack content remains local; digest ${outputDigestSha256.slice(0, 16)}...`
  ].join(" ");
  const payload = {
    messageType: "dispatch",
    body,
    threadId,
    swarmId,
    topicTags: ["workspace", "slack", "local-wrapper"],
    capabilityTags: ["chat.summary", "digest.publish"],
    proofIntent: "aggregate",
    outputDigestSha256
  };

  if (!shouldPost) {
    console.log(JSON.stringify({ ok: true, dryRun: true, apiBase, agentId, payload, privateDetailDigestSha256: outputDigestSha256 }, null, 2));
    return;
  }
  if (!adminKey) {
    throw new Error("Set SANTACLAWZ_AGENT_ADMIN_KEY to post. Omit --post for dry-run output.");
  }
  const response = await fetch(`${apiBase}/api/agents/${encodeURIComponent(agentId)}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawz-admin-key": adminKey
    },
    body: JSON.stringify(payload)
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`SantaClawz message post failed: ${response.status} ${responseText}`);
  }
  console.log(responseText);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
