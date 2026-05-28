# X402 Paid Route Fix Recommendation

Date: 2026-05-28

## Summary

The tester run exposed two separate issues in the live paid route:

1. Buyer-side x402 payload builders signed `ReceiveWithAuthorization`, while the hosted Base USDC `zeko-x402` facilitator verifies and settles `TransferWithAuthorization`.
2. After a local patch fixed the payment signature type, payment authorization succeeded, but the public API timed out waiting for a relay `hire_response` on the local competitive-intelligence worker path even though that worker completed and wrote a valid return payload in about 11 seconds.

This is happening now because the test is exercising the full live path: buyer signing, hosted facilitator verification, relay delivery, local worker execution, and upstream return propagation. Earlier dry-runs, local shape checks, free-test paths, quote intake, or mocked settlement would not catch these integration mismatches.

## Issue 1: EIP-3009 Typed Data Mismatch

Observed failure:

```text
Payer does not hold enough USDC for the x402 payment.
```

Actual facilitator result:

```text
EIP-3009 signature verification failed.
```

Root cause:

- SantaClawz buyer tooling signed `ReceiveWithAuthorization`.
- The hosted Base USDC `zeko-x402` path verifies `TransferWithAuthorization`.
- EIP-712 includes `primaryType` in the signed payload, so these signatures are not interchangeable.

Required fix:

- Standardize the confirmed SantaClawz hosted Base USDC exact fee-split rail on `TransferWithAuthorization`.
- Keep Ethereum/EVM buyer helpers consistent with the same hosted facilitator convention, but verify the Ethereum hosted path with a dedicated smoke before treating it as directly proven.
- Update buyer CLI, browser buyer flow, SDK helper, docs, and tests.
- Emit `evm-eip3009-transfer-with-authorization` in payload metadata.

Also fix error precedence:

- If facilitator verification returns `invalidReason`, `error`, `errorReason`, or `errorMessage`, surface that first.
- Only infer insufficient balance when the facilitator did not already return a root-cause error.

Suggested typed error codes:

- `x402_signature_verification_failed`
- `x402_insufficient_balance`
- `x402_authorization_already_used`
- `x402_facilitator_unavailable`
- `x402_payload_shape_invalid`

## Issue 2: Relay Return Timeout After Worker Completion

Observed paid run after local payment patch:

```json
{
  "paymentStatus": "authorized",
  "settlementStatus": "authorized",
  "relayDeliveryStatus": "failed",
  "agentExecutionStatus": "submitted",
  "deliveryError": "Timed out waiting for agent relay response."
}
```

Relay trace:

```text
accepted_by_indexer: completed
payment_authorized: completed
sent_to_relay: completed
worker_ack: completed
received_by_worker: completed
relay_returned: failed
worker_completed: not_reached
```

Local worker evidence showed the worker completed in about 11 seconds and wrote `santaclawz_return_payload.json` for the same `request_id`.

Scope note: this is not evidence of a global paid-route or hosted relay failure. After the local x402 patch, a hosted `agent_job_pack` paid run completed end-to-end with `paymentStatus: settled`, `relayDeliveryStatus: forwarded`, and `agentExecutionStatus: completed`. The timeout appears specific to the local competitive-intelligence relay/worker return path, payload normalization, or response propagation.

Most likely failure modes:

1. The local relay agent forwarded the worker request, but its `hire_response` frame did not reach the API before the API response timer fired.
2. The local relay agent received the worker output but failed to normalize, encode, or send it.
3. The `hire_response` used a mismatched or missing `messageId`, so the API could not correlate it to the pending request.
4. The relay connection was replaced, closed, or marked stale between `received_by_worker` and `hire_response`.
5. The API only accepts the synchronous websocket response and cannot reconcile a late but valid worker completion.

Recommended fix:

1. Add typed relay timeout errors.
   - Distinguish `relay_return_timeout_after_worker_ack` from worker failure.
   - Preserve `relayMessageId`, `requestId`, worker route, elapsed time, local timeout, platform timeout, and request body digest.

2. Add relay response telemetry before and after send.
   - Log `hire_response_prepared`.
   - Log `hire_response_sent` with frame bytes and digest.
   - Include `requestId`, `messageId`, `requestKind`, worker status, relay body digest, and elapsed milliseconds.

3. Include request correlation in relay frames.
   - Add `requestId` and `requestBodyDigestSha256` to `hire_response`.
   - API should reject mismatched IDs loudly instead of silently timing out.

4. Make API timeout errors more recoverable.
   - When timeout happens after `worker_ack` or `received_by_worker`, set `retryable: true`, `errorCode: relay_return_timeout_after_worker_ack`, and `paymentStatus: authorized`.
   - Tell buyers to retry with the same payment payload and inspect `/api/x402/payment-state`.

5. Add a reconciliation path.
   - In the short term, expose enough state for an operator to reconcile a valid local `santaclawz_return_payload.json` by `request_id`.
   - Longer term, support an authenticated relay/agent completion callback that can attach a late worker return to the existing hire request.

6. Keep timeout windows aligned.
   - Local worker timeout should remain below the platform relay response timeout.
   - Default local timeout is 45s and platform relay timeout is 120s, which should be enough for the reported 11s worker. Since the API still timed out, this looks less like a timeout-size problem and more like a missing/mismatched response frame.

## Implementation Plan

1. Patch EIP-3009 builders:
   - `packages/agent-sdk/src/quote-payment.ts`
   - `scripts/buyer-buy-once.mjs`
   - `apps/web-console/src/BuyerWorkroom.tsx`

2. Patch x402 error precedence:
   - `apps/indexer/src/x402-adapter.ts`

3. Improve relay diagnostics and correlation:
   - `scripts/relay-agent.mjs`
   - `apps/indexer/src/server.ts`

4. Add tests:
   - SDK test asserts `TransferWithAuthorization`.
   - CLI or helper test asserts hosted payload primitive is `evm-eip3009-transfer-with-authorization`.
   - Adapter test asserts facilitator `invalidReason` wins over inferred funding errors.
   - Relay unit or smoke test asserts a `hire_response` with `requestId` and matching `messageId` resolves the pending request.

## Expected Outcome

After the fix:

- Funded buyers with valid payloads should pass hosted facilitator verification.
- Signature failures should be reported as signature failures, not insufficient funds.
- Paid execution should reach relay delivery and worker completion.
- If relay return propagation fails, buyer agents should get a typed recoverable relay error with enough correlation data to retry safely or reconcile the completed worker output.
