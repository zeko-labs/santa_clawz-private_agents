#!/usr/bin/env node
import assert from "node:assert/strict";

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

const agentId = argValue("--agent-id", process.env.CLAWZ_SMOKE_AGENT_ID);
const apiBase = (argValue("--api-base", process.env.CLAWZ_API_BASE ?? "https://api.santaclawz.ai") ?? "").replace(/\/$/, "");
const publicBase = (argValue("--public-base", process.env.CLAWZ_PUBLIC_BASE ?? "https://www.santaclawz.ai") ?? "").replace(/\/$/, "");

if (!agentId) {
  console.error("Usage: pnpm smoke:paid-route -- --agent-id <agent-id>");
  process.exit(1);
}

async function paidRoutePreflight(label, baseUrl) {
  const url = `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/hire`;
  const startedAtMs = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      taskPrompt: "SantaClawz paid-route preflight smoke check. Do not execute paid work.",
      requesterContact: "santaclawz-smoke"
    })
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text.slice(0, 400) };
  }
  return {
    label,
    url,
    status: response.status,
    durationMs: Date.now() - startedAtMs,
    contentType: response.headers.get("content-type"),
    xRequestId: response.headers.get("x-request-id"),
    xRenderOriginServer: response.headers.get("x-render-origin-server"),
    xVercelId: response.headers.get("x-vercel-id"),
    payload
  };
}

const results = await Promise.all([
  paidRoutePreflight("api", apiBase),
  paidRoutePreflight("public", publicBase)
]);

for (const result of results) {
  console.log(JSON.stringify({
    label: result.label,
    status: result.status,
    durationMs: result.durationMs,
    contentType: result.contentType,
    xRequestId: result.xRequestId,
    xRenderOriginServer: result.xRenderOriginServer,
    xVercelId: result.xVercelId
  }, null, 2));
}

for (const result of results) {
  assert.equal(result.status, 402, `${result.label} paid preflight should return x402 HTTP 402, got ${result.status}`);
  assert.equal(result.payload?.x402Version, 2, `${result.label} preflight should return x402 v2 JSON`);
  const accept = result.payload?.accepts?.[0];
  assert.ok(accept, `${result.label} preflight must include an x402 accepts[0] requirement`);
  assert.match(String(accept.amount ?? ""), /^[0-9]+$/, `${result.label} x402 amount must be atomic integer string`);
  assert.equal(accept.extensions?.evm?.amountUnit, "atomic", `${result.label} x402 amountUnit must be atomic`);
}

const [api, publicRoute] = results;
assert.equal(
  publicRoute.payload.accepts?.[0]?.amount,
  api.payload.accepts?.[0]?.amount,
  "public rewrite and direct API should advertise the same x402 amount"
);

console.log("ok - paid route preflight healthy through direct API and public rewrite");
