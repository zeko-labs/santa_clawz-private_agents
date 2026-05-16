import { readFileSync } from "node:fs";

import { createRetryablePlatformFailure, isRetryablePlatformStatus } from "./platform-failures.mjs";

export function normalizeBaseUrl(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function loadEnvFile(filePath) {
  const env = {};
  const contents = readFileSync(filePath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    env[line.slice(0, separatorIndex).trim()] = unquoteEnvValue(line.slice(separatorIndex + 1));
  }
  return env;
}

export function applyEnvFile(filePath) {
  const env = loadEnvFile(filePath);
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return env;
}

export async function requestJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const text = await response.text().catch(() => "");
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = isRetryablePlatformStatus(response.status)
      ? createRetryablePlatformFailure(response.status, text)
      : {
          error: `SantaClawz API returned non-JSON response (${response.status}).`,
          responsePreview: text.slice(0, 240)
        };
  }
  return {
    ok: response.ok,
    status: response.status,
    payload
  };
}

function adminHeaders(adminKey) {
  return adminKey
    ? {
        "x-clawz-admin-key": adminKey
      }
    : {};
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

function classifyPublishBlocker(error, zekoHealth) {
  const message = firstString(error, zekoHealth?.socialAnchor?.lastError, zekoHealth?.socialAnchor?.alerts?.[0]);
  if (!message) {
    return undefined;
  }
  if (/submitter key|DEPLOYER_PRIVATE_KEY|CLAWZ_SOCIAL_ANCHOR_SUBMITTER_PRIVATE_KEY/i.test(message)) {
    return "social_anchor_submitter_missing";
  }
  if (/signer|SOCIAL_ANCHOR_PRIVATE_KEY|SocialAnchorKernel signer/i.test(message)) {
    return "social_anchor_signer_missing";
  }
  if (/SocialAnchorKernel is not configured|CLAWZ_SOCIAL_ANCHOR_PUBLIC_KEY|contract.*not configured/i.test(message)) {
    return "social_anchor_contract_missing";
  }
  if (/insufficient|balance|fund|fee/i.test(message)) {
    return "social_anchor_submitter_unfunded";
  }
  return "zeko_publish_failed";
}

function defaultReadinessOptions(config) {
  return {
    heartbeat: config.heartbeat !== false,
    publish: config.publish !== false,
    localOnly: config.localOnly === true,
    verifyAvailability: config.verifyAvailability !== false,
    limit: config.limit,
    operatorNote: config.operatorNote ?? "OpenClaw enrollment readiness publish"
  };
}

export async function postHeartbeat(config) {
  return requestJson(`${config.apiBase}/api/agents/${encodeURIComponent(config.agentId)}/heartbeat`, {
    method: "POST",
    headers: adminHeaders(config.adminKey),
    body: JSON.stringify({
      sessionId: config.sessionId,
      status: "live",
      ttlSeconds: config.ttlSeconds ?? 30,
      note: config.heartbeatNote ?? "SantaClawz seller readiness heartbeat."
    })
  });
}

export async function fetchConsoleState(config) {
  const query = new URLSearchParams({
    agentId: config.agentId,
    ...(config.sessionId ? { sessionId: config.sessionId } : {})
  });
  return requestJson(`${config.apiBase}/api/console/state?${query.toString()}`, {
    headers: adminHeaders(config.adminKey)
  });
}

export async function fetchX402Plan(config) {
  return requestJson(`${config.apiBase}/api/agents/${encodeURIComponent(config.agentId)}/x402-plan`);
}

export async function fetchAvailability(config) {
  return requestJson(`${config.apiBase}/api/agents/${encodeURIComponent(config.agentId)}/availability`);
}

export async function fetchZekoHealth(config) {
  return requestJson(`${config.apiBase}/api/zeko/health`);
}

export async function publishSocialAnchors(config, options) {
  return requestJson(`${config.apiBase}/api/social/anchors/settle`, {
    method: "POST",
    headers: adminHeaders(config.adminKey),
    body: JSON.stringify({
      sessionId: config.sessionId,
      agentId: config.agentId,
      ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
      ...(options.localOnly ? { localOnly: true } : {}),
      operatorNote: options.operatorNote
    })
  });
}

export async function refreshSellerReadiness(config, options) {
  return requestJson(`${config.apiBase}/api/agents/${encodeURIComponent(config.agentId)}/readiness/refresh`, {
    method: "POST",
    headers: adminHeaders(config.adminKey),
    body: JSON.stringify({
      sessionId: config.sessionId,
      publish: options.publish !== false,
      ...(options.localOnly ? { localOnly: true } : {}),
      verifyAvailability: options.verifyAvailability !== false,
      operatorNote: options.operatorNote
    })
  });
}

function buildReadinessSummary(input) {
  const plan = input.afterPlan?.payload ?? input.beforePlan?.payload ?? {};
  const state = input.afterState?.payload ?? input.beforeState?.payload ?? {};
  const availability = input.availability?.payload ?? {};
  const quoteMode = plan.pricingMode === "quote-required";
  const fixedMode = plan.pricingMode === "fixed-exact";
  const freeTestMode = plan.pricingMode === "free-test";
  const railReady = Array.isArray(plan.rails) ? plan.rails.some((rail) => rail?.ready === true) : false;
  const ownershipVerified = state.ownership?.status === "verified";
  const paymentsEnabled = plan.paymentsEnabled === true;
  const paymentProfileReady = plan.paymentProfileReady === true;
  const payoutReady = plan.payoutAddressConfigured === true;
  const publishedOnZeko = plan.published === true;
  const heartbeatLive = input.heartbeat?.payload?.status === "live" || input.heartbeatSkipped === true;
  const runtimeReachable = input.availabilitySkipped === true ? true : availability.reachable === true;
  const paymentReady = freeTestMode ? false : quoteMode ? paymentProfileReady : fixedMode ? railReady : paymentProfileReady;
  const freeTestPolicyReady = freeTestMode && !paymentsEnabled;
  const blockers = [];

  if (!ownershipVerified) {
    blockers.push({ stage: "ownership", message: "Owner control is not verified yet." });
  }
  if (!publishedOnZeko) {
    blockers.push({ stage: "zeko_publish", message: "Publish/anchor on Zeko has not completed." });
  }
  if (!freeTestMode && !paymentsEnabled) {
    blockers.push({ stage: "payments", message: "Agent payments are not turned on." });
  }
  if (!freeTestMode && !payoutReady) {
    blockers.push({ stage: "payout", message: "A payout wallet is not configured." });
  }
  if (!freeTestMode && !paymentProfileReady) {
    blockers.push({ stage: "pricing", message: "Pricing or payout details are incomplete." });
  }
  if (fixedMode && !railReady) {
    const firstMissing = plan.rails?.flatMap((rail) => rail?.missing ?? [])?.[0];
    blockers.push({ stage: "x402", message: firstMissing ?? "No fixed-price x402 rail is ready." });
  }
  if (!heartbeatLive) {
    blockers.push({ stage: "heartbeat", message: input.heartbeat?.payload?.error ?? "Heartbeat is not live." });
  }
  if (!runtimeReachable) {
    blockers.push({ stage: "runtime", message: availability.reason ?? "Public agent ingress is not reachable." });
  }
  if (input.publish?.ok === false && !publishedOnZeko) {
    blockers.unshift({
      stage: classifyPublishBlocker(input.publish.payload?.error, input.zekoHealth?.payload) ?? "zeko_publish",
      message: input.publish.payload?.error ?? "Zeko publish/anchor failed."
    });
  }

  const paidHireable = !freeTestMode && blockers.length === 0 && paymentReady;
  const freeTestHireable = freeTestMode && blockers.length === 0 && freeTestPolicyReady;
  const hireable = paidHireable || freeTestHireable;
  const allowedRequestTypes = freeTestHireable
    ? ["free_test"]
    : paidHireable
      ? quoteMode
        ? ["quote_intake"]
        : ["paid_execution"]
      : [];
  return {
    agentId: configValue(input.config, "agentId"),
    sessionId: configValue(input.config, "sessionId"),
    hireable,
    paidHireable,
    freeTestHireable,
    allowedRequestTypes,
    blockedRequestTypes: ["quote_intake", "paid_execution", "free_test"].filter(
      (requestType) => !allowedRequestTypes.includes(requestType)
    ),
    blockingReason: blockers[0]?.message,
    blockers,
    checks: {
      enrolled: Boolean(configValue(input.config, "agentId") && configValue(input.config, "sessionId")),
      ownershipVerified,
      priced: paymentProfileReady,
      payoutReady,
      freeTestPolicyReady: freeTestMode ? freeTestPolicyReady : undefined,
      heartbeatLive,
      runtimeReachable,
      publishedOnZeko,
      paymentReady,
      fixedPriceRailReady: fixedMode ? railReady : undefined
    },
    plan: {
      published: publishedOnZeko,
      pricingMode: plan.pricingMode,
      paymentsEnabled,
      paymentProfileReady,
      payoutAddressConfigured: payoutReady,
      defaultRail: plan.defaultRail,
      readyRails: Array.isArray(plan.rails) ? plan.rails.filter((rail) => rail?.ready).map((rail) => rail.rail) : []
    },
    publish: input.publish
      ? {
          attempted: true,
          ok: input.publish.ok,
          status: input.publish.status,
          error: input.publish.payload?.error,
          confirmedCount: input.publish.payload?.confirmedCount,
          anchoredCount: input.publish.payload?.anchoredCount,
          latestRootDigestSha256: input.publish.payload?.latestRootDigestSha256
        }
      : { attempted: false },
    heartbeat: input.heartbeat
      ? {
          attempted: true,
          ok: input.heartbeat.ok,
          status: input.heartbeat.payload?.status,
          staleAtIso: input.heartbeat.payload?.staleAtIso,
          error: input.heartbeat.payload?.error
        }
      : { attempted: false },
    availability: input.availability
      ? {
          attempted: true,
          reachable: input.availability.payload?.reachable,
          status: input.availability.payload?.status,
          reason: input.availability.payload?.reason
        }
      : { attempted: false },
    zekoHealth: input.zekoHealth?.payload?.socialAnchor
      ? {
          canAutoAnchorSharedBatches: input.zekoHealth.payload.socialAnchor.canAutoAnchorSharedBatches,
          contractConfigured: input.zekoHealth.payload.socialAnchor.contractConfigured,
          submitterConfigured: input.zekoHealth.payload.socialAnchor.submitterConfigured,
          signerConfigured: input.zekoHealth.payload.socialAnchor.signerConfigured,
          alerts: input.zekoHealth.payload.socialAnchor.alerts ?? []
        }
      : undefined
  };
}

function configValue(config, key) {
  return typeof config?.[key] === "string" ? config[key] : undefined;
}

export async function runSellerReadiness(config) {
  const apiBase = normalizeBaseUrl(config.apiBase);
  const resolvedConfig = { ...config, apiBase };
  const options = defaultReadinessOptions(resolvedConfig);
  const beforeState = await fetchConsoleState(resolvedConfig);
  const beforePlan = await fetchX402Plan(resolvedConfig);
  let heartbeat;
  let publish;
  let refresh;

  if (options.heartbeat) {
    heartbeat = await postHeartbeat(resolvedConfig);
  }
  if (options.publish && beforePlan.payload?.published !== true) {
    refresh = await refreshSellerReadiness(resolvedConfig, options);
    publish = {
      ok: refresh.ok && refresh.payload?.publish?.ok !== false,
      status: refresh.status,
      payload: refresh.payload?.publish ?? refresh.payload
    };
  }

  const [afterState, afterPlan, availability, zekoHealth] = await Promise.all([
    fetchConsoleState(resolvedConfig),
    fetchX402Plan(resolvedConfig),
    options.verifyAvailability ? fetchAvailability(resolvedConfig) : Promise.resolve(undefined),
    publish?.ok === false || beforePlan.payload?.published !== true ? fetchZekoHealth(resolvedConfig) : Promise.resolve(undefined)
  ]);

  return buildReadinessSummary({
    config: resolvedConfig,
    beforeState,
    beforePlan,
    afterState,
    afterPlan,
    heartbeat,
    heartbeatSkipped: !options.heartbeat,
    publish,
    availability,
    availabilitySkipped: !options.verifyAvailability,
    zekoHealth
  });
}

export function readinessErrorMessage(readiness) {
  const lines = [
    "Agent is not hireable yet.",
    ...(readiness.blockingReason ? [`Reason: ${readiness.blockingReason}`] : []),
    ...((readiness.blockers ?? []).slice(0, 4).map((blocker) => `- ${blocker.stage}: ${blocker.message}`)),
    ...(readiness.zekoHealth?.alerts?.length ? [`Zeko alert: ${readiness.zekoHealth.alerts[0]}`] : [])
  ];
  return lines.join("\n");
}

export function printReadiness(readiness) {
  const checks = readiness.checks ?? {};
  const line = (label, ok, detail = "") => `${label}: ${ok ? "ok" : "blocked"}${detail ? ` (${detail})` : ""}`;
  console.log(line("Enrollment", checks.enrolled));
  console.log(line("Ownership", checks.ownershipVerified));
  console.log(line("Pricing", checks.priced, readiness.plan?.pricingMode));
  if (checks.freeTestPolicyReady !== undefined) {
    console.log(line("Payout", true, "not required for free-test"));
    console.log(line("Free-test policy", checks.freeTestPolicyReady));
  } else {
    console.log(line("Payout", checks.payoutReady, readiness.plan?.defaultRail));
  }
  console.log(line("Heartbeat", checks.heartbeatLive, readiness.heartbeat?.staleAtIso ? `last accepted; TTL until ${readiness.heartbeat.staleAtIso}` : ""));
  console.log(line("Runtime", checks.runtimeReachable, readiness.availability?.reason ?? readiness.availability?.status ?? ""));
  console.log(line("Zeko publish", checks.publishedOnZeko, readiness.publish?.latestRootDigestSha256 ?? ""));
  console.log(line("Payment gate", checks.paymentReady, readiness.plan?.readyRails?.join(", ") ?? ""));
  console.log(`Agent hireable: ${readiness.hireable ? "yes" : "no"}`);
  if (Array.isArray(readiness.allowedRequestTypes) && readiness.allowedRequestTypes.length > 0) {
    console.log(`Allowed request types: ${readiness.allowedRequestTypes.join(", ")}`);
  }
  if (!readiness.hireable && readiness.blockingReason) {
    console.log(`Blocking reason: ${readiness.blockingReason}`);
  }
}
