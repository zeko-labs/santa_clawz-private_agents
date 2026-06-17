import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  createRetryablePlatformFailure,
  isRetryablePlatformStatus,
  isRetryablePlatformTransportError
} from "./platform-failures.mjs";

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
  const timeoutMs = Number.parseInt(process.env.CLAWZ_API_FETCH_TIMEOUT_MS ?? "10000", 10);
  const fetchInit = {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    },
    ...(!init.signal && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? { signal: AbortSignal.timeout(timeoutMs) }
      : {})
  };
  let response;
  try {
    response = await fetch(url, fetchInit);
  } catch (error) {
    if (!isRetryablePlatformTransportError(error)) {
      throw error;
    }
    return {
      ok: false,
      status: 0,
      payload: createRetryablePlatformFailure(0, error instanceof Error ? error.message : String(error), {
        code: "platform_unavailable_retryable",
        operation: init.method ?? "GET"
      })
    };
  }
  const text = await response.text().catch(() => "");
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = isRetryablePlatformStatus(response.status)
      ? createRetryablePlatformFailure(response.status, text, {
          code: "platform_unavailable_retryable",
          operation: init.method ?? "GET"
        })
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
    paidExecutionProbe: config.paidExecutionProbe === true,
    limit: config.limit,
    operatorNote: config.operatorNote ?? "Agent enrollment readiness publish"
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
      note: config.heartbeatNote ?? "SantaClawz seller readiness heartbeat.",
      ...(typeof config.relayAgentProtocolVersion === "string" ? { relayAgentProtocolVersion: config.relayAgentProtocolVersion } : {}),
      ...(typeof config.relayAgentBuild === "string" ? { relayAgentBuild: config.relayAgentBuild } : {}),
      ...(Array.isArray(config.relayAgentFeatures) ? { relayAgentFeatures: config.relayAgentFeatures } : {}),
      ...(config.relayAgentWorkerRoutes && typeof config.relayAgentWorkerRoutes === "object"
        ? { relayAgentWorkerRoutes: config.relayAgentWorkerRoutes }
        : {}),
      ...(Array.isArray(config.relayAgentWorkerWarnings)
        ? { relayAgentWorkerWarnings: config.relayAgentWorkerWarnings }
        : {}),
      ...(config.relayAgentWorkerTiming && typeof config.relayAgentWorkerTiming === "object"
        ? { relayAgentWorkerTiming: config.relayAgentWorkerTiming }
        : {}),
      ...(config.paidExecutionProbe && typeof config.paidExecutionProbe === "object"
        ? { paidExecutionProbe: config.paidExecutionProbe }
        : {})
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

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function signLocalHireHeaders(input) {
  const bodySha256 = sha256Hex(input.body);
  const signature = createHmac("sha256", input.signingSecret)
    .update(`${input.timestamp}.${input.requestId}.${bodySha256}`)
    .digest("hex");
  return {
    authorization: `Bearer ${input.ingressToken}`,
    "content-type": "application/json",
    "x-santaclawz-request-id": input.requestId,
    "x-santaclawz-timestamp": input.timestamp,
    "x-santaclawz-body-sha256": bodySha256,
    "x-santaclawz-signature": `v1=${signature}`
  };
}

function readinessEnv(config, name) {
  return typeof config[name] === "string" && config[name].trim().length > 0
    ? config[name].trim()
    : process.env[name]?.trim() ?? "";
}

function verifiedOutputFromReturn(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value.verified_output ?? value.verifiedOutput;
}

function hasVerifiedPaidReturnPackage(value) {
  const verifiedOutput = verifiedOutputFromReturn(value);
  if (!verifiedOutput || typeof verifiedOutput !== "object") {
    return false;
  }
  const manifest = verifiedOutput.verification_manifest ?? verifiedOutput.verificationManifest;
  const deliverables = Array.isArray(verifiedOutput.deliverables) ? verifiedOutput.deliverables : [];
  const deliverableReferenceAvailable = deliverables.some(
    (entry) => entry && typeof entry === "object" && typeof entry.uri === "string" && entry.uri.trim().length > 0
  );
  const buyerVisibleOutputs = Array.isArray(verifiedOutput.buyer_visible_outputs)
    ? verifiedOutput.buyer_visible_outputs
    : Array.isArray(verifiedOutput.buyerVisibleOutputs)
      ? verifiedOutput.buyerVisibleOutputs
      : [];
  const buyerReadableOutput = buyerVisibleOutputs.some(
    (entry) => entry && typeof entry === "object" && typeof entry.text === "string" && entry.text.trim().length > 0
  );
  const artifactManifestUrl =
    typeof verifiedOutput.artifact_manifest_url === "string"
      ? verifiedOutput.artifact_manifest_url
      : typeof verifiedOutput.artifactManifestUrl === "string"
        ? verifiedOutput.artifactManifestUrl
        : "";
  return Boolean(
    value.status === "completed" &&
      (value.schema_version === "santaclawz-return/1.0" || value.schemaVersion === "santaclawz-return/1.0") &&
      (typeof verifiedOutput.package_hash === "string" || typeof verifiedOutput.packageHash === "string") &&
      manifest &&
      typeof manifest === "object" &&
      deliverables.length > 0 &&
      (buyerReadableOutput || artifactManifestUrl.trim().length > 0 || deliverableReferenceAvailable)
  );
}

export async function runPaidExecutionProbe(config, plan) {
  const pricingMode = plan?.pricingMode;
  if (pricingMode !== "fixed-exact" && pricingMode !== "quote-required") {
    return {
      attempted: false,
      ok: true,
      skipped: true,
      reason: "paid_execution probe is only needed for paid quote-required or fixed-exact agents."
    };
  }

  const localHireUrl =
    config.localHireUrl ??
    process.env.CLAWZ_LOCAL_HIRE_URL?.trim() ??
    process.env.OPENCLAW_LOCAL_HIRE_URL?.trim() ??
    "http://127.0.0.1:8797/hire";
  const ingressToken = readinessEnv(config, "CLAWZ_AGENT_INGRESS_TOKEN");
  const signingSecret = readinessEnv(config, "CLAWZ_AGENT_SIGNING_SECRET");
  const serviceKey = readinessEnv(config, "CLAWZ_AGENT_SERVICE_KEY");
  const agentId = config.agentId;
  const sessionId = config.sessionId;
  const missing = [
    !ingressToken ? "CLAWZ_AGENT_INGRESS_TOKEN" : "",
    !signingSecret ? "CLAWZ_AGENT_SIGNING_SECRET" : "",
    !serviceKey ? "CLAWZ_AGENT_SERVICE_KEY" : ""
  ].filter(Boolean);
  if (missing.length > 0) {
    return {
      attempted: false,
      ok: false,
      skipped: false,
      localHireUrl,
      reason: `Missing local paid-execution probe secrets: ${missing.join(", ")}.`
    };
  }

  const readyRail = Array.isArray(plan.rails) ? plan.rails.find((rail) => rail?.ready && rail?.amountUsd) : undefined;
  const settledAmountUsd = readyRail?.amountUsd ?? plan.referencePriceUsd ?? "0.01";
  const requestId = `hire_probe_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const timestamp = new Date().toISOString();
  const payload = {
    schema_version: "santaclawz-request/1.0",
    request_id: requestId,
    agent_id: agentId,
    session_id: sessionId,
    caller_type: "operator",
    service: serviceKey,
    service_key: serviceKey,
    verification_required: true,
    return_channel: "santaclawz",
    request_type: "paid_execution",
    pricing_mode: pricingMode,
    payment_status: "settled",
    settled_amount_usd: settledAmountUsd,
    paid_or_escrowed: true,
    payment: {
      status: "settled",
      rail: readyRail?.rail ?? plan.defaultRail ?? "base-usdc",
      amount_usd: settledAmountUsd,
      authorization_id: `seller_ready_probe_${requestId}`
    },
    input: {
      title: "SantaClawz paid execution readiness probe",
      client_request:
        "Return a tiny paid_execution readiness package with a buyer-visible deliverable, verification manifest, and package hash.",
      requested_deliverables: [
        "A santaclawz-return/1.0 completed package with verified_output, verification_manifest, at least one deliverable, and buyer_visible_outputs, artifact_manifest_url, or deliverable uri."
      ]
    }
  };
  const body = JSON.stringify(payload);
  let response;
  let responseBody;
  try {
    response = await fetch(localHireUrl, {
      method: "POST",
      headers: signLocalHireHeaders({
        body,
        timestamp,
        requestId,
        ingressToken,
        signingSecret
      }),
      body
    });
    const responseText = await response.text();
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = responseText;
    }
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      localHireUrl,
      requestId,
      reason: error instanceof Error ? error.message : String(error)
    };
  }

  const packageVerified = hasVerifiedPaidReturnPackage(responseBody);
  const buyerDeliveryVerified = packageVerified;
  return {
    attempted: true,
    ok: response.ok && packageVerified,
    status: response.status,
    localHireUrl,
    requestId,
    packageVerified,
    buyerDeliveryVerified,
    returnStatus: responseBody && typeof responseBody === "object" ? responseBody.status : undefined,
    reason: response.ok
      ? packageVerified
        ? "Paid execution returned a verified package with buyer-visible delivery."
        : "Paid execution response did not include a completed verified_output package with manifest, deliverables, and buyer-visible delivery."
      : `Local paid execution probe returned HTTP ${response.status}.`,
    response: responseBody
  };
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

function buildUpgradeGuideHint(config) {
  const envFile = typeof config?.envFile === "string" && config.envFile.trim()
    ? config.envFile.trim()
    : ".env.santaclawz";
  const localPaidUrl = typeof config?.localHireUrl === "string" && config.localHireUrl.trim()
    ? config.localHireUrl.trim()
    : "";
  return {
    doc: "docs/start-here/agent-upgrade-guide.md",
    command: [
      "pnpm agent:upgrade-guide --",
      `--env-file ${shellQuote(envFile)}`,
      ...(localPaidUrl ? [`--local-paid-url ${shellQuote(localPaidUrl)}`] : [])
    ].join(" "),
    purpose: "Update runtime code, rerun seller readiness, and prove buyer-visible delivery before paid work."
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function arrayStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function buildReadinessSummary(input) {
  const plan = input.afterPlan?.payload ?? input.beforePlan?.payload ?? {};
  const state = input.afterState?.payload ?? input.beforeState?.payload ?? {};
  const availability = input.availability?.payload ?? {};
  const hostedReadiness = availability.readiness && typeof availability.readiness === "object"
    ? availability.readiness
    : {};
  const hostedReadinessBlockers = arrayStrings(hostedReadiness.blockers);
  const quoteMode = plan.pricingMode === "quote-required";
  const fixedMode = plan.pricingMode === "fixed-exact";
  const freeTestMode = plan.pricingMode === "free-test";
  const railReady = Array.isArray(plan.rails) ? plan.rails.some((rail) => rail?.ready === true) : false;
  const stateOwnershipVerified = state.ownership?.status === "verified";
  const hostedReadinessHireable = hostedReadiness.hireable === true;
  const ownershipSnapshotConflict =
    !stateOwnershipVerified &&
    hostedReadinessHireable &&
    !hostedReadinessBlockers.includes("ownership-unverified");
  const ownershipVerified = stateOwnershipVerified || ownershipSnapshotConflict;
  const paymentsEnabled = plan.paymentsEnabled === true;
  const paymentProfileReady = plan.paymentProfileReady === true;
  const payoutReady = plan.payoutAddressConfigured === true;
  const publishedOnZeko = plan.published === true;
  const heartbeatLive = input.heartbeat?.payload?.status === "live" || input.heartbeatSkipped === true;
  const runtimeReachable = input.availabilitySkipped === true ? true : availability.reachable === true;
  const paymentReady = freeTestMode ? false : quoteMode ? paymentProfileReady : fixedMode ? railReady : paymentProfileReady;
  const freeTestPolicyReady = freeTestMode && !paymentsEnabled;
  const paidExecutionProbeRequired = Boolean(input.paidExecutionProbeRequired && !freeTestMode && (quoteMode || fixedMode));
  const paidExecutionProbeOk =
    !paidExecutionProbeRequired ||
    (input.paidExecutionProbe?.ok === true && input.paidExecutionProbe?.buyerDeliveryVerified === true);
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
  if (paidExecutionProbeRequired && !paidExecutionProbeOk) {
    blockers.push({
      stage: "paid_execution_probe",
      message: input.paidExecutionProbe?.reason ?? "Local paid_execution probe did not return a verified package."
    });
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
  const statusCoaching = buildAgentStatusCoaching({
    hireable,
    paidHireable,
    freeTestHireable,
    allowedRequestTypes,
    blockers,
    checks: {
      ownershipVerified,
      publishedOnZeko,
      heartbeatLive,
      runtimeReachable,
      paymentReady,
      paidExecutionReturnPackage: paidExecutionProbeRequired ? paidExecutionProbeOk : undefined
    },
    pricingMode: plan.pricingMode
  });
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
    localRouteSummary: input.config?.localRouteSummary,
    blockingReason: blockers[0]?.message,
    statusCoaching,
    upgradeGuide: buildUpgradeGuideHint(input.config),
    readinessSources: {
      ownership: ownershipSnapshotConflict
        ? "hosted-readiness-projection"
        : "console-state",
      stateOwnershipStatus: state.ownership?.status ?? "unknown",
      hostedReadinessHireable,
      hostedReadinessBlockers
    },
    ...(ownershipSnapshotConflict
      ? {
          readinessDiagnostics: [
            {
              code: "ownership_snapshot_conflict",
              severity: "info",
              message:
                "Console state ownership looked stale, but hosted readiness reported this agent hireable and did not report ownership-unverified."
            }
          ]
        }
      : {}),
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
      fixedPriceRailReady: fixedMode ? railReady : undefined,
      paidExecutionReturnPackage: paidExecutionProbeRequired ? paidExecutionProbeOk : undefined
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
    paidExecutionProbe: input.paidExecutionProbe
      ? {
          attempted: input.paidExecutionProbe.attempted === true,
          ok: input.paidExecutionProbe.ok === true,
          localHireUrl: input.paidExecutionProbe.localHireUrl,
          requestId: input.paidExecutionProbe.requestId,
          packageVerified: input.paidExecutionProbe.packageVerified,
          buyerDeliveryVerified: input.paidExecutionProbe.buyerDeliveryVerified,
          returnStatus: input.paidExecutionProbe.returnStatus,
          reason: input.paidExecutionProbe.reason
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

function buildAgentStatusCoaching(input) {
  const firstBlocker = input.blockers[0];
  const stage = firstBlocker?.stage;
  if (input.hireable) {
    const allowed = input.allowedRequestTypes.includes("quote_intake")
      ? "You can receive quote requests. Quote carefully, execute only after accepted payment, and keep building completion history."
      : input.allowedRequestTypes.includes("paid_execution")
        ? "You can receive fixed-price paid execution. Keep the task scope narrow and return verified packages every time."
        : "You can receive free-test requests. Use this to practice the loop before paid work.";
    return {
      headline: "You are visible and hireable.",
      message: allowed,
      nextAction: "Keep the relay running, complete small jobs cleanly, and ask agent_job_pack for current first-work guidance.",
      stage: "hireable"
    };
  }
  if (stage === "heartbeat" || stage === "runtime") {
    return {
      headline: "You are visible but not hireable yet.",
      message: "SantaClawz cannot confirm your live runtime path. Buyers should not pay until relay, heartbeat, and worker reachability are healthy.",
      nextAction: "Restart the relay or runtime, then run seller:ready again.",
      stage: stage ?? "runtime"
    };
  }
  if (stage === "paid_execution_probe") {
    return {
      headline: "You can be discovered, but paid execution is not proven yet.",
      message: "Your local worker needs to return a completed santaclawz-return/1.0 package with verified output, manifest, deliverables, and buyer-visible delivery before paid work should count.",
      nextAction: "Run test:hire with --request-type paid_execution --allow-paid-execution-dry-run and fix the worker return package.",
      stage
    };
  }
  if (stage === "payments" || stage === "payout" || stage === "pricing" || stage === "x402") {
    return {
      headline: "You are not ready to accept paid work yet.",
      message: firstBlocker?.message ?? "Payment, payout, pricing, or x402 rail setup is incomplete.",
      nextAction: "Use quote-required until pricing is clear. Configure payout and run seller:ready again.",
      stage: stage ?? "payments"
    };
  }
  if (stage === "ownership") {
    return {
      headline: "Your SantaClawz identity is created, but runtime control is not verified.",
      message: "SantaClawz needs proof that this runtime controls the enrolled agent identity before publishing or accepting work.",
      nextAction: "Finish enrollment from the agent runtime, serve the challenge, and run seller:ready again.",
      stage
    };
  }
  if (stage === "zeko_publish") {
    return {
      headline: "Your runtime is close, but the public proof anchor is not complete.",
      message: firstBlocker?.message ?? "Publish/anchor on Zeko has not completed.",
      nextAction: "Check Zeko health and run seller:ready again with publish enabled.",
      stage
    };
  }
  return {
    headline: "You are not hireable yet.",
    message: firstBlocker?.message ?? "SantaClawz found a readiness blocker.",
    nextAction: "Run seller:ready after fixing the blocker.",
    stage: stage ?? "unknown"
  };
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
  const paidExecutionProbe = options.paidExecutionProbe
    ? await runPaidExecutionProbe(resolvedConfig, afterPlan.payload ?? beforePlan.payload ?? {})
    : undefined;
  let paidExecutionProbeHeartbeat;
  if (options.heartbeat && paidExecutionProbe?.attempted === true) {
    paidExecutionProbeHeartbeat = await postHeartbeat({
      ...resolvedConfig,
      heartbeatNote: "SantaClawz paid execution readiness probe.",
      paidExecutionProbe: {
        attempted: true,
        ok: paidExecutionProbe.ok === true,
        checkedAtIso: new Date().toISOString(),
        localHireUrl: paidExecutionProbe.localHireUrl,
        requestId: paidExecutionProbe.requestId,
        packageVerified: paidExecutionProbe.packageVerified === true,
        buyerDeliveryVerified: paidExecutionProbe.buyerDeliveryVerified === true,
        returnStatus: paidExecutionProbe.returnStatus,
        reason: paidExecutionProbe.reason
      }
    });
  }

  return buildReadinessSummary({
    config: resolvedConfig,
    beforeState,
    beforePlan,
    afterState,
    afterPlan,
    heartbeat: paidExecutionProbeHeartbeat?.ok ? paidExecutionProbeHeartbeat : heartbeat,
    heartbeatSkipped: !options.heartbeat,
    publish,
    availability,
    availabilitySkipped: !options.verifyAvailability,
    zekoHealth,
    paidExecutionProbe,
    paidExecutionProbeRequired: options.paidExecutionProbe
  });
}

export function readinessErrorMessage(readiness) {
  const lines = [
    "Agent is not hireable yet.",
    ...(readiness.blockingReason ? [`Reason: ${readiness.blockingReason}`] : []),
    ...((readiness.blockers ?? []).slice(0, 4).map((blocker) => `- ${blocker.stage}: ${blocker.message}`)),
    ...(readiness.upgradeGuide?.command ? [`Upgrade: ${readiness.upgradeGuide.command}`] : []),
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
  if (checks.paidExecutionReturnPackage !== undefined) {
    console.log(line("Paid execution package", checks.paidExecutionReturnPackage, readiness.paidExecutionProbe?.reason ?? ""));
  }
  if (readiness.statusCoaching?.headline) {
    console.log(`Agent coaching: ${readiness.statusCoaching.headline}`);
    if (readiness.statusCoaching.message) {
      console.log(`Next: ${readiness.statusCoaching.message}`);
    }
  }
  console.log(`Agent hireable: ${readiness.hireable ? "yes" : "no"}`);
  if (Array.isArray(readiness.allowedRequestTypes) && readiness.allowedRequestTypes.length > 0) {
    console.log(`Allowed request types: ${readiness.allowedRequestTypes.join(", ")}`);
  }
  if (readiness.localRouteSummary?.paid_execution) {
    const defaultRoute = readiness.localRouteSummary.default ? `default=${readiness.localRouteSummary.default} ` : "";
    console.log(`Local routes: ${defaultRoute}paid_execution=${readiness.localRouteSummary.paid_execution}`);
  }
  if (!readiness.hireable && readiness.blockingReason) {
    console.log(`Blocking reason: ${readiness.blockingReason}`);
  }
  if (!readiness.hireable && readiness.upgradeGuide?.command) {
    console.log(`Upgrade guide: ${readiness.upgradeGuide.command}`);
  }
}
