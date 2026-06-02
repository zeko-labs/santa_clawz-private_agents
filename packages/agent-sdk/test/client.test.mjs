import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkEntry = fileURLToPath(new URL("../dist/agent-sdk/src/index.js", import.meta.url));
const serverEntry = fileURLToPath(new URL("../../../apps/indexer/dist/apps/indexer/src/server.js", import.meta.url));

function startServer(workspaceDir, port) {
  const stdout = [];
  const stderr = [];
  const child = spawn("node", [serverEntry], {
    cwd: workspaceDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => {
    stdout.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
  });

  return {
    child,
    stdout,
    stderr
  };
}

async function waitForJson(url, timeoutMs = 15000, logs = { stdout: [], stderr: [] }) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.json();
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    [
      `Timed out waiting for ${url}`,
      logs.stdout.length > 0 ? `stdout:\n${logs.stdout.join("")}` : "",
      logs.stderr.length > 0 ? `stderr:\n${logs.stderr.join("")}` : ""
    ]
      .filter(Boolean)
      .join("\n\n")
  );
}

async function stopProcess(child) {
  if (child.exitCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    child.once("exit", finish);
    child.once("close", finish);

    if (child.exitCode !== null) {
      finish();
      return;
    }

    child.kill("SIGTERM");
    setTimeout(finish, 1000);
  });
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => {
          reject(new Error("Unable to reserve a TCP port."));
        });
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function main() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "clawz-agent-sdk-"));
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startServer(workspaceDir, port);

  try {
    const health = await waitForJson(`${baseUrl}/health`, 15000, server);
    assert.equal(health.service, "clawz-indexer");
    const {
      createClawzAgentClient,
      createClawzQuotePaymentClient,
      ClawzRetryablePlatformError,
      artifactBytesDigestMatches,
      buildClawzFeeStackPreview,
      buildClawzFeeSplitExactPaymentPayload,
      buildCoordinationEnvelope,
      buildClawzQuoteAcceptanceWalletProof,
      buildSantaClawzBuyerInboxEnvelope,
      buyerInboxEnvelopeDigestSha256,
      coordinationEnvelopeToPublicMessage,
      parseCoordinationBridgeManifest,
      validateClawzFeeCompatibility,
      withClawzPlatformRetry
    } = await import(
      pathToFileURL(sdkEntry).href
    );
    const client = createClawzAgentClient({ baseUrl });
    const retryableHtmlFetch = async () =>
      new Response("<html><body>Bad Gateway</body></html>", {
        status: 502,
        headers: {
          "content-type": "text/html"
        }
      });
    const unavailableClient = createClawzAgentClient({
      baseUrl: "https://www.santaclawz.ai",
      fetchImpl: retryableHtmlFetch
    });
    await assert.rejects(unavailableClient.getX402Plan(), (error) => {
      assert.ok(error instanceof ClawzRetryablePlatformError);
      assert.equal(error.failure.code, "relay_unavailable_retryable");
      assert.equal(error.failure.retryable, true);
      assert.equal(error.failure.paymentStatus, "unknown");
      assert.equal(error.failure.settlementStatus, "unknown");
      assert.equal(error.failure.relayDeliveryStatus, "not_confirmed");
      assert.equal(error.failure.agentExecutionStatus, "not_confirmed");
      assert.equal(error.failure.requestMethod, "GET");
      assert.match(error.failure.requestUrl, /\/api\/x402\/plan/);
      return true;
    });
    const unavailablePublicMessages = createClawzAgentClient({
      baseUrl: "https://www.santaclawz.ai",
      adminKey: "admin_test",
      fetchImpl: retryableHtmlFetch
    });
    await assert.rejects(
      unavailablePublicMessages.postAgentBoardMessage({
        agentId: "agent-test--session_agent_test",
        body: "Busy-run public message",
        proofIntent: "aggregate",
        swarmId: "busy-run",
        clientMessageId: "busy-run-message-001"
      }),
      (error) => {
        assert.ok(error instanceof ClawzRetryablePlatformError);
        assert.equal(error.failure.code, "platform_unavailable_retryable");
        assert.equal(error.failure.retryable, true);
        assert.equal(error.failure.operation, "public_agent_message");
        assert.equal(error.failure.messageAccepted, false);
        assert.equal(error.failure.proofIntent, "unknown");
        assert.equal(error.failure.anchorStatus, "not_started");
        return true;
      }
    );

    let retryAttempts = 0;
    const eventuallyHealthyClient = createClawzAgentClient({
      baseUrl,
      fetchImpl: async (url, init) => {
        retryAttempts += 1;
        if (retryAttempts < 3) {
          return new Response("<html><body>Bad Gateway</body></html>", {
            status: 502,
            headers: {
              "content-type": "text/html"
            }
          });
        }
        return fetch(url, init);
      }
    });
    const retriedPlan = await withClawzPlatformRetry(() => eventuallyHealthyClient.getX402Plan(), {
      attempts: 3,
      initialDelayMs: 0,
      maxDelayMs: 0,
      jitterRatio: 0
    });
    assert.ok(Array.isArray(retriedPlan.rails));
    assert.equal(retryAttempts, 3);

    const unavailableQuotePayments = createClawzQuotePaymentClient({
      baseUrl: "https://www.santaclawz.ai",
      fetchImpl: retryableHtmlFetch
    });
    await assert.rejects(
      unavailableQuotePayments.settleQuoteIntent({
        intentId: "exec_retryable",
        paymentPayload: {
          paymentId: "pay_retryable"
        }
      }),
      (error) => {
        assert.ok(error instanceof ClawzRetryablePlatformError);
        assert.equal(error.failure.code, "relay_unavailable_retryable");
        assert.equal(error.failure.paymentStatus, "unknown");
        assert.equal(error.failure.relayDeliveryStatus, "not_confirmed");
        return true;
      }
    );
    const transportFailureClient = createClawzAgentClient({
      baseUrl: "https://www.santaclawz.ai",
      fetchImpl: async () => {
        const error = new TypeError("fetch failed");
        error.cause = Object.assign(new Error("getaddrinfo ENOTFOUND www.santaclawz.ai"), { code: "ENOTFOUND" });
        throw error;
      }
    });
    await assert.rejects(
      transportFailureClient.watchExecution({
        requestId: "hire_retryable",
        token: "workspace_token",
        paymentStatus: "settled",
        settlementStatus: "settled"
      }),
      (error) => {
        assert.ok(error instanceof ClawzRetryablePlatformError);
        assert.equal(error.failure.code, "post_payment_state_unavailable_retryable");
        assert.equal(error.failure.status, 0);
        assert.equal(error.failure.paymentStatus, "settled");
        assert.equal(error.failure.settlementStatus, "settled");
        assert.equal(error.failure.relayDeliveryStatus, "not_confirmed");
        return true;
      }
    );

    const discovery = await client.getDiscovery();
    assert.equal(discovery.protocol, "clawz-agent-proof");
    assert.equal(discovery.endpoints.discovery, `${baseUrl}/.well-known/agent-interop.json?sessionId=${discovery.focusedSessionId}`);
    assert.equal(discovery.endpoints.verify, `${baseUrl}/api/interop/verify?sessionId=${discovery.focusedSessionId}`);

    const bundle = await client.getProofBundle();
    assert.equal(bundle.protocol, "clawz-agent-proof");
    assert.ok(bundle.originProofs.length >= 1);

    const verification = await client.getVerification();
    assert.equal(verification.ok, true);
    assert.equal(verification.source.mode, "self");
    assert.equal(verification.question.payment.settlementAsset, "MINA");
    assert.ok(verification.question.origin.proofCount >= 1);

    const remoteVerification = await client.getVerification({ url: baseUrl });
    assert.equal(remoteVerification.ok, true);
    assert.equal(remoteVerification.source.mode, "live-url");

    const x402Plan = await client.getX402Plan();
    assert.ok(Array.isArray(x402Plan.rails));
    assert.ok(Array.isArray(x402Plan.feePreviewByRail ?? []));

    const discoverySearch = await client.discover({ deliveryMode: "platform_scanned", privacyMode: "private", limit: 5 });
    assert.equal(discoverySearch.schemaVersion, "santaclawz-agent-directory-search/1.0");
    assert.equal(Array.isArray(discoverySearch.agents), true);
    if (discoverySearch.agents.length > 0) {
      const readiness = await client.getAgentReadiness({ agentId: discoverySearch.agents[0].agentId });
      assert.equal(readiness.schemaVersion, "santaclawz-agent-readiness/1.0");
      assert.equal(typeof readiness.scannerReady, "boolean");
    }

    const enrollment = await client.createEnrollmentTicket({
      agentName: "SDK enrollment agent",
      headline: "SDK-created enrollment ticket for an OpenClaw runtime.",
      urlReservationSalt: "abc123000001",
      runtimeDelivery: {
        mode: "santaclawz-relay"
      },
      paymentProfile: {
        enabled: false,
        supportedRails: ["base-usdc"],
        defaultRail: "base-usdc",
        pricingMode: "quote-required",
        referencePriceUnit: "minimum",
        settlementTrigger: "upfront"
      },
      socialAnchorPolicy: {
        mode: "shared-batched"
      },
      preferredProvingLocation: "client"
    });
    assert.match(enrollment.ticket, /^scz_enroll_/);
    assert.match(enrollment.publicAgentUrl, /sdk-enrollment-agent--session_agent_abc123000001/);
    assert.equal(enrollment.enrollmentCommand, "pnpm enroll:agent -- --serve");

    const adminClient = createClawzAgentClient({ baseUrl, adminKey: "sdk-test-admin-key" });
    const pricingUpdate = await adminClient.updateAgentPricing({
      openForWork: true,
      pricingMode: "quote-required",
      defaultRail: "base-usdc",
      basePayoutAddress: "0x1908217952D7117f5aeFBbd91AeBf04566D286f9",
      referencePriceUsd: "0.35",
      referencePriceUnit: "minimum"
    });
    assert.equal(pricingUpdate.profile.paymentProfile.enabled, true);
    assert.equal(pricingUpdate.profile.paymentProfile.pricingMode, "quote-required");
    assert.equal(pricingUpdate.profile.paymentProfile.referencePriceUsd, "0.35");
    assert.equal(pricingUpdate.profile.payoutWallets.base, "0x1908217952D7117f5aeFBbd91AeBf04566D286f9");

    const archiveUpdate = await adminClient.archiveAgent({
      agentId: pricingUpdate.agentId,
      sessionId: pricingUpdate.sessionId
    });
    assert.equal(archiveUpdate.profile.availability, "archived");

    const restoreUpdate = await adminClient.restoreAgent({
      agentId: pricingUpdate.agentId,
      sessionId: pricingUpdate.sessionId
    });
    assert.equal(restoreUpdate.profile.availability, "active");

    const coordinationManifest = parseCoordinationBridgeManifest({
      schemaVersion: "santaclawz-team-coordination-bridge/0.1",
      org: "SDK test org",
      project: "Coordination SDK",
      goal: "Post safe digest-backed coordination updates.",
      swarmId: "sdk_coordination_swarm",
      threadId: "thread_sdk_coordination",
      apiBase: baseUrl,
      coordinationPolicy: {
        privacyMode: "recipient-encrypted"
      },
      participants: [
        {
          agentId: pricingUpdate.agentId,
          name: "SDK enrollment agent",
          role: "admin"
        }
      ]
    });
    const coordinationEnvelope = buildCoordinationEnvelope({
      manifest: coordinationManifest,
      senderAgentId: pricingUpdate.agentId,
      body: "Private packet stored locally.",
      uri: "local://sdk/private-packet",
      proofIntent: "aggregate"
    });
    assert.equal(coordinationEnvelope.visibility, "recipient-encrypted");
    assert.match(coordinationEnvelope.envelopeDigestSha256, /^[a-f0-9]{64}$/);
    const coordinationMessage = coordinationEnvelopeToPublicMessage({
      agentId: pricingUpdate.agentId,
      envelope: coordinationEnvelope
    });
    assert.equal(coordinationMessage.threadId, "thread_sdk_coordination");
    assert.equal(coordinationMessage.outputDigestSha256, coordinationEnvelope.envelopeDigestSha256);
    const postedCoordination = await adminClient.postCoordinationEvent({
      manifest: coordinationManifest,
      agentId: pricingUpdate.agentId,
      body: "Private packet stored locally.",
      uri: "local://sdk/private-packet",
      proofIntent: "aggregate"
    });
    assert.equal(postedCoordination.ok, true);
    assert.equal(postedCoordination.postedMessage.threadId, "thread_sdk_coordination");
    assert.equal(postedCoordination.postedMessage.outputDigestSha256.length, 64);
    const coordinationThread = await client.readCoordinationThread({ manifest: coordinationManifest, limit: 10 });
    assert.ok(coordinationThread.messages.some((message) => message.threadId === "thread_sdk_coordination"));

    const currentBundle = await client.getProofBundle();
    assert.notEqual(currentBundle.bundleDigest.sha256Hex, bundle.bundleDigest.sha256Hex);

    const localVerification = await client.verifyLiveProof();
    assert.equal(localVerification.report.ok, true);
    assert.equal(localVerification.question.authority.sessionId, currentBundle.authority.sessionId);

    const tools = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "verify_agent_proof"));

    const mcpBundle = await client.getAgentProofBundleViaMcp();
    assert.equal(mcpBundle.bundleDigest.sha256Hex, currentBundle.bundleDigest.sha256Hex);

    const mcpVerification = await client.verifyAgentProofViaMcp();
    assert.equal(mcpVerification.ok, true);
    assert.equal(mcpVerification.summary.bundleDigestSha256, currentBundle.bundleDigest.sha256Hex);

    const feePreview = buildClawzFeeStackPreview({
      plan: {
        protocolOwnerFeePolicy: {
          enabled: true,
          feeBps: 10,
          settlementModel: "fee-on-reserve-v1",
          appliesTo: ["santaclawz-marketplace"],
          recipientByRail: {
            "base-usdc": "0xProtocol"
          }
        },
        feePreviewByRail: [
          {
            rail: "base-usdc",
            grossAmountUsd: "1",
            sellerNetAmountUsd: "0.999",
            protocolFeeAmountUsd: "0.001",
            sellerPayTo: "0xSeller",
            protocolFeeRecipient: "0xProtocol",
            feeBps: 10
          }
        ]
      },
      deployerFee: {
        enabled: true,
        feeBps: 200,
        label: "Acme UI",
        recipientByRail: {
          "base-usdc": "0xUi"
        }
      }
    });
    assert.equal(feePreview.length, 1);
    assert.equal(feePreview[0].deployerFeeAmountUsd, "0.02");
    assert.equal(feePreview[0].sellerNetAmountUsd, "0.979");
    assert.equal(feePreview[0].totalFeeBps, 210);
    assert.equal(feePreview[0].compatibility.compatible, true);
    assert.equal(feePreview[0].compatibility.protocolFeeFloorBps, 0);

    const incompatibleFeeStack = validateClawzFeeCompatibility({
      protocolFeeBps: 10,
      deployerFeeBps: 350
    });
    assert.equal(incompatibleFeeStack.compatible, false);
    assert.equal(incompatibleFeeStack.deployerFeeCapSatisfied, false);

    const quoteProof = await buildClawzQuoteAcceptanceWalletProof({
      agentId: "agent_quote_sdk",
      requestId: "hire_quote_sdk",
      buyerWallet: "0xb4ad7F6B6e6B964C9D1c4bB8b7F2e38732E0b386",
      acceptedAmountUsd: "0.42",
      acceptedQuoteDigestSha256: "a".repeat(64),
      maxAmountUsd: "1.00",
      rail: "base-usdc",
      settlementModel: "upfront-x402",
      buyerAgentId: "buyer_sdk",
      signMessage: (message) => `signed:${message}`
    });
    assert.equal(quoteProof.scheme, "eip191-personal-sign");
    assert.match(quoteProof.message, /SantaClawz quote acceptance/);
    assert.match(quoteProof.signature, /^signed:SantaClawz quote acceptance/);

    const feeSplitPayload = await buildClawzFeeSplitExactPaymentPayload({
      paymentRequirement: {
        requestId: "hire_fee_split_sdk",
        seller: {
          serviceId: "svc_fee_split_sdk"
        },
        accepts: [
          {
            scheme: "exact",
            settlementRail: "evm",
            network: "eip155:8453",
            asset: {
              symbol: "USDC",
              decimals: 6,
              standard: "erc20",
              address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
            },
            amount: "420000",
            payTo: "0x1908217952D7117f5aeFBbd91AeBf04566D286f9",
            settlementModel: "x402-exact-evm-fee-split-v1",
            extensions: {
              evm: {
                amountUnit: "atomic",
                chainId: 8453,
                assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                eip712Name: "USD Coin",
                assetVersion: "2",
                feeSplit: {
                  sellerPayTo: "0x1908217952D7117f5aeFBbd91AeBf04566D286f9",
                  protocolFeePayTo: "0x1111111111111111111111111111111111111111",
                  sellerAmount: "419580",
                  protocolFeeAmount: "420"
                }
              }
            }
          }
        ]
      },
      sessionId: "session_fee_split_sdk",
      payer: "0xb4ad7F6B6e6B964C9D1c4bB8b7F2e38732E0b386",
      issuedAtIso: "2026-05-11T12:00:00.000Z",
      expiresAtIso: "2026-05-11T12:15:00.000Z",
      signTypedData: ({ message }) => `0xsigned_${message.to}_${message.value}`
    });
    assert.equal(feeSplitPayload.sessionId, "session_fee_split_sdk");
    assert.equal(feeSplitPayload.extensions.evm.amountUnit, "atomic");
    assert.equal(feeSplitPayload.extensions.santaclawz.idempotencyKey, feeSplitPayload.paymentId);
    assert.equal(feeSplitPayload.payloadShape, "santaclawz-hosted-exact-fee-split-v1");
    assert.equal(feeSplitPayload.accepted.asset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    assert.equal(feeSplitPayload.accepted.amount, "420000");
    assert.equal(feeSplitPayload.accepted.extra.amountUnit, "atomic");
    assert.equal(feeSplitPayload.accepted.payTo, "0x1908217952D7117f5aeFBbd91AeBf04566D286f9");
    assert.equal(feeSplitPayload.accepted.extra.feeSplit.grossAmount, "420000");
    assert.equal(feeSplitPayload.payload.authorization.value, "419580");
    assert.equal(feeSplitPayload.payload.feeAuthorization.authorization.value, "420");
    assert.equal(feeSplitPayload.payload.primitive, "evm-eip3009-transfer-with-authorization");
    assert.equal(feeSplitPayload.payload.feeAuthorization.primitive, "evm-eip3009-transfer-with-authorization");
    assert.equal(feeSplitPayload.authorization.typedData.primaryType, "TransferWithAuthorization");
    assert.equal(feeSplitPayload.feeAuthorization.typedData.primaryType, "TransferWithAuthorization");
    assert.equal(feeSplitPayload.authorization.typedData.message.value, "419580");
    assert.equal(feeSplitPayload.feeAuthorization.typedData.message.value, "420");
    assert.match(feeSplitPayload.paymentContextDigest, /^[a-f0-9]{64}$/);
    assert.match(feeSplitPayload.authorizationDigest, /^[a-f0-9]{64}$/);

    const directArtifactDigest = "d".repeat(64);
    const buyerInboxEnvelope = buildSantaClawzBuyerInboxEnvelope({
      requestId: "hire_sdk_direct",
      deliveryChannel: "buyer-agent-inbox://sdk-test",
      artifact: {
        filename: "answer.md",
        contentType: "text/markdown",
        sizeBytes: 12,
        digestSha256: directArtifactDigest
      },
      sellerAgentId: "agent_sdk",
      sellerDeliveryReceipt: "posted to buyer inbox"
    });
    assert.equal(buyerInboxEnvelope.schema_version, "santaclawz-buyer-inbox-delivery/1.0");
    assert.equal(buyerInboxEnvelope.scan_policy, "buyer_required");
    assert.equal(buyerInboxEnvelope.artifact.digest_sha256, directArtifactDigest);
    assert.match(buyerInboxEnvelopeDigestSha256(buyerInboxEnvelope), /^[a-f0-9]{64}$/);
    assert.equal(
      artifactBytesDigestMatches({
        bytes: "hello direct",
        expectedSha256: "db72a6e363c9ffcede9bb620256eb2b294a07b575a0401574c7636e65a953878"
      }),
      true
    );

    console.log("ok - agent sdk discovers, verifies, and speaks MCP against a live SantaClawz runtime");
  } finally {
    await stopProcess(server.child);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
