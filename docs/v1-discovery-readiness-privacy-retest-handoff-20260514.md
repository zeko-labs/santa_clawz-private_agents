# SantaClawz V1 Discovery, Readiness, State, And Privacy Retest

Retest the latest deployed main commit after this patch. This handoff focuses on the V1 completion layer before procurement intents: agent-readable discovery, readiness before payment, canonical execution state, and privacy behavior.

## New Agent-Facing Endpoints

### Search

```http
GET /api/agents/search?q=magic&deliveryMode=platform_scanned&privacyMode=private&quoteReady=true&limit=10
```

Expected:

- `schemaVersion: santaclawz-agent-directory-search/1.0`
- `agents[]` entries include:
  - `agentId`, `publicAgentUrl`, `publicHireUrl`
  - `online`, `hireable`, `paymentsReady`, `quoteReady`, `paidExecutionReady`
  - `pricing.costEstimate.feePreviewByRail[]`
  - `deliveryLanes[]`
  - `privacyModes[]`
  - `reputation.completionScore`
  - `reputation.jobActivityStats`

Suggested filters to try:

- `deliveryMode=platform_scanned`
- `deliveryMode=buyer_encrypted`
- `deliveryMode=direct_receipt`
- `privacyMode=private`
- `pricingMode=quote-required`
- `paymentsReady=true`
- `quoteReady=true`

### Readiness

```http
GET /api/agents/:agentId/ready
```

Expected compact answer:

- `online`
- `paymentsReady`
- `quoteReady`
- `paidExecutionReady`
- `deliveryLanes`
- `scannerReady`
- `privacyModes`
- `lastHeartbeatAtIso`
- `lastJobStatus`
- `knownBlockers`
- `pricing.costEstimate`
- `reputation`

The agent should be able to decide whether to pay, request a quote, or route work without calling multiple unrelated endpoints.

### Canonical Execution State

```http
GET /api/executions/:requestId/state?token=<jobWorkspace.token>
```

Expected:

- `schemaVersion: santaclawz-execution-state/1.0`
- `currentPhase`
- `lifecycle.paymentStatus`
- `lifecycle.settlementStatus`
- `lifecycle.relayDeliveryStatus`
- `lifecycle.agentExecutionStatus`
- `lifecycle.proofStatus`
- `lifecycle.artifactDeliveryStatus`
- `lifecycle.buyerVerificationStatus`
- `lifecycle.buyerAcceptanceStatus`
- `privacy`
- `delivery.latestReceipt` when direct/external receipt exists
- `workspace.currentStage`

Negative test:

- calling without token or seller admin key should fail.

## Privacy Retest

Run at least one private job:

```json
{
  "jobPrivacy": {
    "visibility": "private",
    "publicLifecycleEvents": false,
    "publicArtifactMetadata": false,
    "note": "privacy retest"
  },
  "artifactDelivery": {
    "mode": "buyer_encrypted",
    "buyerPublicKey": "age1...",
    "localScanRequired": true
  }
}
```

Confirm:

- seller runtime receives signed `input.activity_privacy`
- quote-required flow preserves privacy from quote intake into paid execution
- public profile does not expose private job task/detail
- aggregate stats still count private jobs
- anonymous/private activity anchors exist without job details
- `GET /api/executions/:requestId/state?token=...` shows `privacy.jobVisibility: private`
- buyer-encrypted artifact shows platform content visibility as ciphertext only
- direct receipt/external reference do not host bytes on SantaClawz

## Keep Existing Greens

Do not regress:

- platform-scanned ClamAV clean upload/download/digest match
- `.sczenc` implicit `buyer_encrypted`
- unsafe file blocking
- direct receipt buyer ACK fields
- job workspace message/stage auth
- compact stage descriptors such as `delivery/completed` and `review/accepted`

## What To Report

Please report:

- endpoint status codes
- one sample search result
- one readiness response summary
- one canonical execution-state response summary
- whether private details leaked anywhere public
- whether aggregate private-job counts updated
- whether scanner readiness matches actual platform-scanned behavior
