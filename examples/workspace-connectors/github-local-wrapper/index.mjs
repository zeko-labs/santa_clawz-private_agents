#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

function env(name, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(repoPath, args) {
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function shortLines(value, limit) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, limit);
}

function bridgeManifest() {
  const manifestPath = env("SANTACLAWZ_BRIDGE_MANIFEST");
  if (!manifestPath) {
    return null;
  }
  return readJson(path.resolve(manifestPath));
}

function firstManifestAgent(manifest) {
  const participants = Array.isArray(manifest?.participants) ? manifest.participants : [];
  return participants.find((participant) => typeof participant?.agentId === "string")?.agentId ?? "";
}

async function main() {
  const manifest = bridgeManifest();
  const repoPath = path.resolve(env("GITHUB_WORKSPACE_REPO", process.cwd()));
  const apiBase = env("SANTACLAWZ_API_BASE", manifest?.apiBase ?? "http://127.0.0.1:4318");
  const agentId = env("SANTACLAWZ_AGENT_ID", firstManifestAgent(manifest));
  const adminKey = env("SANTACLAWZ_AGENT_ADMIN_KEY");
  const threadId = env("SANTACLAWZ_THREAD_ID", manifest?.threadId ?? "thread_workspace_github");
  const swarmId = env("SANTACLAWZ_SWARM_ID", manifest?.swarmId ?? "workspace_github");
  const shouldPost = process.argv.includes("--post");

  if (!agentId) {
    throw new Error("Set SANTACLAWZ_AGENT_ID or pass a manifest with participants[0].agentId.");
  }

  const branch = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(repoPath, ["rev-parse", "--short", "HEAD"]);
  const statusLines = shortLines(git(repoPath, ["status", "--short"]), 12);
  const recentCommits = shortLines(git(repoPath, ["log", "--oneline", "-n", "5"]), 5);
  const privateDetail = JSON.stringify({
    repoPath,
    branch,
    head,
    statusLines,
    recentCommits,
    generatedAtIso: new Date().toISOString()
  });
  const outputDigestSha256 = digest(privateDetail);

  const body = [
    `GitHub local wrapper update for ${path.basename(repoPath)} on ${branch}@${head}.`,
    statusLines.length > 0
      ? `${statusLines.length} local change entries summarized; private file details remain local.`
      : "Working tree is clean.",
    `Private detail digest ${outputDigestSha256.slice(0, 16)}...`
  ].join(" ");

  const payload = {
    messageType: "dispatch",
    body,
    threadId,
    swarmId,
    topicTags: ["workspace", "github", "local-wrapper"],
    capabilityTags: ["repo.summary", "digest.publish"],
    proofIntent: "aggregate",
    outputDigestSha256
  };

  if (!shouldPost) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      apiBase,
      agentId,
      payload,
      privateDetailDigestSha256: outputDigestSha256
    }, null, 2));
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
