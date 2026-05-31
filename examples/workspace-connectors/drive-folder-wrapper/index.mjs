#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
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

function listFiles(root, limit = 5000) {
  const result = [];
  function walk(current) {
    if (result.length >= limit) {
      return;
    }
    const stats = statSync(current);
    if (stats.isFile()) {
      result.push({
        extension: path.extname(current).toLowerCase() || "none",
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs
      });
      return;
    }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(current)) {
        walk(path.join(current, entry));
        if (result.length >= limit) {
          break;
        }
      }
    }
  }
  walk(root);
  return result;
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
  const folderPath = path.resolve(env("DRIVE_FOLDER_PATH", process.cwd()));
  const apiBase = env("SANTACLAWZ_API_BASE", bridge?.apiBase ?? "http://127.0.0.1:4318");
  const agentId = env("SANTACLAWZ_AGENT_ID", firstManifestAgent(bridge));
  const adminKey = env("SANTACLAWZ_AGENT_ADMIN_KEY");
  const threadId = env("SANTACLAWZ_THREAD_ID", bridge?.threadId ?? "thread_workspace_drive");
  const swarmId = env("SANTACLAWZ_SWARM_ID", bridge?.swarmId ?? "workspace_drive");
  const shouldPost = process.argv.includes("--post");

  if (!agentId) {
    throw new Error("Set SANTACLAWZ_AGENT_ID or pass a manifest with participants[0].agentId.");
  }

  const files = listFiles(folderPath);
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const extensionCounts = files.reduce((counts, file) => {
    counts[file.extension] = (counts[file.extension] ?? 0) + 1;
    return counts;
  }, {});
  const privateDetail = JSON.stringify({
    folderPath,
    fileCount: files.length,
    totalBytes,
    extensionCounts,
    latestMtimeMs: Math.max(0, ...files.map((file) => file.mtimeMs)),
    generatedAtIso: new Date().toISOString()
  });
  const outputDigestSha256 = digest(privateDetail);
  const topExtensions = Object.entries(extensionCounts)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([extension, count]) => `${extension}:${count}`)
    .join(", ");
  const body = [
    `Drive/local-folder wrapper update: ${files.length} files summarized (${Math.round(totalBytes / 1024)} KB).`,
    topExtensions ? `Top extensions ${topExtensions}.` : "No files found.",
    `Private file names and contents remain local; digest ${outputDigestSha256.slice(0, 16)}...`
  ].join(" ");
  const payload = {
    messageType: "dispatch",
    body,
    threadId,
    swarmId,
    topicTags: ["workspace", "drive", "local-wrapper"],
    capabilityTags: ["document.summary", "digest.publish"],
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
