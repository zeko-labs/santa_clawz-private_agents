#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_BASE_URL = "http://127.0.0.1:4318";

function hasArg(name) {
  return process.argv.includes(`--${name}`);
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

async function requestJson(url, init = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.headers ?? {})
      }
    });
  } catch (error) {
    const method = init.method ?? "GET";
    const cause = error?.cause instanceof Error ? ` (${error.cause.message})` : "";
    throw new Error(`${method} ${url} failed before response: ${error.message}${cause}`);
  }
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${url} failed: ${response.status} ${payload.error ?? text}`);
  }
  return payload;
}

async function waitForReady(baseUrl, timeoutMs) {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await requestJson(`${baseUrl}/ready`);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await delay(300);
    }
  }
  throw new Error(`Timed out waiting for ${baseUrl}/ready after ${timeoutMs}ms. Last error: ${lastError}`);
}

function startLocalIndexer(baseUrl) {
  const url = new URL(baseUrl);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const child = spawn("pnpm", ["--filter", "@clawz/indexer", "start"], {
    cwd: new URL("../../..", import.meta.url),
    env: {
      ...process.env,
      PORT: port,
      CLAWZ_PORT: port
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = [];
  const remember = (chunk) => {
    output.push(String(chunk).trim());
    if (output.length > 16) {
      output.shift();
    }
  };
  child.stdout.on("data", remember);
  child.stderr.on("data", remember);
  child.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      output.push(`indexer exited with code ${code ?? "none"} signal ${signal ?? "none"}`);
    }
  });
  return {
    child,
    recentOutput: () => output.filter(Boolean).join("\n")
  };
}

async function registerDemoAgent(baseUrl, input) {
  return requestJson(`${baseUrl}/api/console/register`, {
    method: "POST",
    body: JSON.stringify({
      agentName: input.agentName,
      headline: input.headline,
      urlReservationSalt: input.urlReservationSalt,
      openClawUrl: input.openClawUrl,
      marketplaceTags: {
        capabilities: input.capabilities,
        domains: ["coordination-demo"],
        inputTypes: ["workflow", "manifest"],
        outputTypes: ["summary", "digest", "envelope"],
        tools: ["santaclawz-agent-sdk"],
        runtimes: ["local-demo"]
      }
    })
  });
}

async function main() {
  const baseUrl = argValue("base-url", process.env.SANTACLAWZ_API_BASE || DEFAULT_BASE_URL).replace(/\/$/, "");
  const suffix = argValue("suffix", String(Date.now()).slice(-8));
  const shouldStartIndexer = hasArg("start-indexer");
  let indexer;
  let stopIndexer = () => {};

  if (shouldStartIndexer) {
    indexer = startLocalIndexer(baseUrl);
    stopIndexer = () => {
      if (indexer?.child && !indexer.child.killed) {
        indexer.child.kill("SIGTERM");
      }
    };
    process.once("SIGINT", () => {
      stopIndexer();
      process.exit(130);
    });
    process.once("SIGTERM", stopIndexer);
  }

  try {
  const sdkPath = new URL("../../../packages/agent-sdk/dist/agent-sdk/src/index.js", import.meta.url);
  const {
    createClawzAgentClient,
    buildCoordinationEnvelope,
    coordinationEnvelopeToPublicMessage,
    parseCoordinationBridgeManifest
  } = await import(pathToFileURL(sdkPath.pathname).href);

  try {
    await waitForReady(baseUrl, shouldStartIndexer ? 15000 : 3000);
  } catch (error) {
    if (indexer) {
      const recentOutput = indexer.recentOutput();
      throw new Error(`${error.message}${recentOutput ? `\n\nIndexer output:\n${recentOutput}` : ""}`);
    }
    throw error;
  }

  const agentA = await registerDemoAgent(baseUrl, {
    agentName: `coordination_demo_alpha_${suffix}`,
    headline: "Local demo agent A for SantaClawz coordination.",
    urlReservationSalt: `coord-alpha-${suffix}`,
    openClawUrl: `http://127.0.0.1:49${suffix.slice(-3) || "101"}/alpha`,
    capabilities: ["coordination", "requester", "digest-reader"]
  });
  const agentB = await registerDemoAgent(baseUrl, {
    agentName: `coordination_demo_beta_${suffix}`,
    headline: "Local demo agent B for SantaClawz coordination.",
    urlReservationSalt: `coord-beta-${suffix}`,
    openClawUrl: `http://127.0.0.1:48${suffix.slice(-3) || "102"}/beta`,
    capabilities: ["coordination", "responder", "encrypted-envelope"]
  });

  const threadId = `eventlog_two_agent_demo_${suffix}`;
  const swarmId = `workflow_two_agent_demo_${suffix}`;
  const manifest = parseCoordinationBridgeManifest({
    schemaVersion: "santaclawz-team-coordination-bridge/0.1",
    protocol: {
      name: "santaclawz-team-coordination-bridge",
      stability: "early-adopter",
      compatibleEnvelopeVersions: ["santaclawz-agent-message-envelope/1.0"],
      compatiblePublicMessageBoard: "santaclawz-agent-board/1.0",
      compatiblePublicReceiptLedger: "santaclawz-workshop-receipt-ledger/1.0"
    },
    org: "Local two-agent demo",
    project: "Connect independently operated agent systems",
    goal: "Agent A and Agent B coordinate a shared workflow while private context stays local.",
    swarmId,
    threadId,
    apiBase: baseUrl,
    coordinationPolicy: {
      privacyMode: "recipient-encrypted",
      proofIntent: "aggregate",
      publicBodyRule: "Public ledger entries are redacted proof receipts only: no agent names, rosters, task summaries, local refs, or work payloads."
    },
    participants: [
      {
        agentId: agentA.agentId,
        name: agentA.profile?.agentName ?? "Agent A",
        role: "admin",
        capabilities: ["coordination", "requester"]
      },
      {
        agentId: agentB.agentId,
        name: agentB.profile?.agentName ?? "Agent B",
        role: "member",
        capabilities: ["coordination", "responder"]
      }
    ],
    read: {
      publicThreadMessages: `${baseUrl}/api/workshop/receipt-ledger?threadId=${encodeURIComponent(threadId)}&limit=50`
    },
    write: {
      privateEnvelope: "santaclawz-agent-message-envelope/1.0"
    }
  });

  const clientA = createClawzAgentClient({
    baseUrl,
    adminKey: agentA.adminAccess.issuedAdminKey
  });
  const clientB = createClawzAgentClient({
    baseUrl,
    adminKey: agentB.adminAccess.issuedAdminKey
  });

  const firstPost = await clientA.postCoordinationEvent({
    manifest,
    agentId: agentA.agentId,
    body: "Agent A claimed the discovery job. No private context attached.",
    publicBody: "Workshop receipt committed.",
    proofIntent: "aggregate",
    topicTags: ["two-agent-demo", "coordination"],
    capabilityTags: ["coordination", "workflow-dispatch"]
  });

  const threadAfterA = await clientB.readWorkshopReceiptLedger({ manifest, limit: 20 });

  const privateContextUri = `local://agent-b/private-context/${suffix}`;
  const envelope = buildCoordinationEnvelope({
    manifest,
    senderAgentId: agentB.agentId,
    recipientAgentId: agentA.agentId,
    recipientPublicKey: "demo-recipient-public-key-agent-a",
    body: "Private context is stored locally by Agent B. This plaintext is not posted to SantaClawz.",
    uri: privateContextUri,
    proofIntent: "aggregate",
    topicTags: ["two-agent-demo", "encrypted-reference"],
    capabilityTags: ["coordination", "private-context"]
  });
  const publicEnvelopeMessage = coordinationEnvelopeToPublicMessage({
    agentId: agentB.agentId,
    envelope,
    body: "Workshop receipt committed.",
    proofIntent: "aggregate",
    topicTags: ["two-agent-demo", "encrypted-reference"],
    capabilityTags: ["coordination", "private-context"]
  });
  const secondPost = await clientB.postAgentBoardMessage(publicEnvelopeMessage);
  const finalThread = await clientA.readWorkshopReceiptLedger({ manifest, limit: 20 });

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    manifest: {
      schemaVersion: manifest.schemaVersion,
      threadId,
      swarmId,
      apiBase: manifest.apiBase,
      participants: manifest.participants
    },
    generatedAgents: [
      {
        role: "Agent A",
        agentId: agentA.agentId,
        sessionId: agentA.session.sessionId
      },
      {
        role: "Agent B",
        agentId: agentB.agentId,
        sessionId: agentB.session.sessionId
      }
    ],
    publicTraceUrl: `${baseUrl}/api/workshop/receipt-ledger?threadId=${encodeURIComponent(threadId)}&limit=20`,
    flow: [
      {
        step: "agent-a-claimed-workflow-job",
        messageId: firstPost.postedMessage.messageId,
        outputDigestSha256: firstPost.postedMessage.outputDigestSha256
      },
      {
        step: "agent-b-read-workflow-log",
        visibleMessageCount: threadAfterA.messages.length
      },
      {
        step: "agent-b-posted-encrypted-sync-checkpoint",
        messageId: secondPost.postedMessage.messageId,
        outputDigestSha256: secondPost.postedMessage.outputDigestSha256,
        envelopeDigestSha256: envelope.envelopeDigestSha256,
        privateContextUri
      },
      {
        step: "agent-a-read-workflow-log",
        visibleMessageCount: finalThread.messages.length
      }
    ],
    privateBoundary: {
      adminKeysPrinted: false,
      privatePayloadPosted: false,
      privatePayloadLocation: privateContextUri,
      publicBoardContains: ["safe summaries", "workflow/event-log ids", "agent ids", "digest/envelope references"],
      publicBoardDoesNotContain: ["private context plaintext", "local credentials", "agent memory"]
    }
  }, null, 2));
  } finally {
    stopIndexer();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
