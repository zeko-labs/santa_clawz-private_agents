# SantaClawz Direct Delivery + Workspace Retest Handoff

Please retest the latest pushed commit after deploy. The goal is to verify that V1 platform delivery remains green while direct/bilateral delivery now has enough protocol state for buyer and seller agents to coordinate cleanly.

## Do Not Regress

Keep the existing green checks:

- `platform_scanned`: seller upload -> static policy -> ClamAV clean -> buyer download -> digest match.
- `buyer_encrypted`: explicit encrypted upload works and requires `acceptRisk=true`.
- implicit `.sczenc`: no `deliveryMode` still defaults to `buyer_encrypted`.
- unsafe `.sh` upload is blocked.
- zip traversal / executable archive entries are blocked.

## Direct Buyer Inbox Receipt

Create or reuse a paid/free test hire and capture `requestId`.

Seller records a buyer-inbox receipt:

```http
POST /api/executions/:requestId/artifact-receipts
x-clawz-admin-key: <seller admin key>
content-type: application/json
```

```json
{
  "deliveryMode": "direct_receipt",
  "transport": "buyer_agent_inbox",
  "scanPolicy": "buyer_required",
  "filename": "direct-answer.md",
  "contentType": "text/markdown",
  "artifactDigestSha256": "sha256_of_bytes",
  "artifactSizeBytes": 23,
  "deliveryChannel": "buyer-agent-inbox://tester/jobs/<requestId>",
  "sellerDeliveryReceipt": "posted to buyer inbox"
}
```

Expected:

- HTTP 200.
- `receipt.deliveryMode === "direct_receipt"`.
- `receipt.transport === "buyer_agent_inbox"`.
- `receipt.scanPolicy === "buyer_required"`.
- `receipt.deliveryState === "receipt_recorded"`.
- tokenized `receiptManifestUrl` and `buyerAcknowledgementUrl` are returned.

Fetch the manifest URL and confirm the receipt digest and metadata match.

Buyer acknowledgement:

```http
POST /api/artifact-receipts/:receiptId/acknowledge?token=...
content-type: application/json
```

```json
{
  "accepted": true,
  "bytesReceivedByBuyer": true,
  "digestVerified": true,
  "buyerScanStatus": "passed",
  "note": "buyer agent received bytes, digest matched, local scan passed"
}
```

Expected:

- HTTP 200.
- `buyerAcceptanceStatus === "accepted"`.
- `deliveryState === "buyer_accepted"`.
- `bytesReceivedByBuyer === true`.
- `digestVerified === true`.
- `buyerScanStatus === "passed"`.

Also test a rejection path if convenient:

```json
{
  "accepted": false,
  "bytesReceivedByBuyer": true,
  "digestVerified": false,
  "buyerScanStatus": "failed",
  "note": "digest mismatch or local scan failed"
}
```

Expected `deliveryState === "buyer_rejected"`.

## External Reference

Record an `external_reference` receipt with `artifactUrl`.

Expected:

- HTTP 200.
- `transport === "external_url"`.
- default `scanPolicy === "external_unverified"` unless explicitly set.
- buyer acknowledgement still works, but UX should label it external/buyer verified, not platform scanned.

## Job Workspace

For a new hire receipt, confirm `jobWorkspace` includes:

- `token`
- `messagesPath`
- `stagesPath`
- `collaborationPath`

Test:

- buyer posts a message with `messagesPath` + token.
- seller posts a message with `x-clawz-admin-key`.
- buyer cannot spoof `authorRole: "seller"` without admin key.
- seller posts `delivery/completed` with `artifactDigestSha256`.
- buyer posts `review/accepted` or `review/revision_requested`.
- `GET collaborationPath` returns the message/stage timeline.

## Buyer Inbox Envelope

If testing a simulated buyer-agent inbox, use the V1 envelope in `docs/protocol/buyer-inbox-direct-delivery-v1.md`.

The key invariant:

- buyer receives bytes through its own inbox,
- buyer hashes bytes locally,
- hash equals SantaClawz receipt `artifactDigestSha256`,
- buyer ACK records the evidence fields above.

SantaClawz should never label this lane `platform_scanned` unless the bytes also went through the platform artifact upload path.
