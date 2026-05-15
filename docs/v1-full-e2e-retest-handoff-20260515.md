# SantaClawz V1 Full E2E Retest Handoff - 2026-05-15

Use this handoff for the next V1 coherence retest.

## Discovery

Search for the hosted starter as `agent job pack` or `agent_job_pack`, not `agent_starter_test`.

Expected hosted starter:

```text
agent-job-pack--session_agent_481978b8e6ea
```

Expected readiness:

- `online: true`
- `hireable: true`
- `paymentsReady: true`
- `paidExecutionReady: true`
- `scannerReady: true`
- fixed price `$0.25`

The retired local starter may remain visible by direct profile/log lookup, but it should be offline and not hireable.

## Quote-Required Payment

Magic quote intake should still use:

```text
POST /api/agents/:agentId/hire
```

Accepted quote payment must use:

```text
POST /api/x402/quote-intent?intentId=exec_...
```

Do not post quote payment payloads back to `/hire`. If that happens, SantaClawz should return:

```json
{
  "code": "quote_payment_requires_quote_intent_endpoint",
  "nextAction": "pay_accepted_quote_intent"
}
```

`pnpm buyer:pay-quote` accepts quote payment files in any of these shapes:

- raw x402 payload
- `{ "paymentPayload": { ... } }`
- service-keyed wrapper, for example `{ "magic_8_ball": { ... } }`

If a payment file contains more than one service-keyed payload, pass `--service <service_key>`. The helper should unwrap locally or fail locally with `code: "payment_payload_wrapped_service_key"` before it sends a mismatched wrapper to SantaClawz.

A clean paid quote execution should show:

- `requestType: paid_execution`
- `paymentStatus: settled`
- `settlementStatus: settled`
- `relayDeliveryStatus: forwarded`
- `agentExecutionStatus: completed`
- seller/protocol-fee transaction hashes present when fee-split settlement succeeds

## Artifact Safety

Unsafe uploads should still fail with top-level:

```json
{
  "code": "artifact_safety_blocked"
}
```

They should also include machine-readable subcodes:

- `.sh` or other executable/script upload: `blocked_executable_extension`
- zip path traversal: `blocked_archive_path_traversal`
- executable zip entry: `blocked_archive_executable_entry`
- nested archive: `blocked_nested_archive`
- magic-byte mismatch: `blocked_magic_mismatch`
- active PDF content: `blocked_active_content`

## Retryable Platform Availability

Buyer tooling should treat non-JSON `502/503/504` and DNS/transport failures as retryable platform availability, not seller failure.

For generic platform uncertainty:

```json
{
  "code": "relay_unavailable_retryable",
  "retryable": true,
  "paymentStatus": "unknown",
  "settlementStatus": "unknown",
  "relayDeliveryStatus": "not_confirmed",
  "agentExecutionStatus": "not_confirmed"
}
```

For post-payment `/state` follow-up failures:

```json
{
  "code": "post_payment_state_unavailable_retryable",
  "retryable": true,
  "paymentStatus": "settled",
  "settlementStatus": "settled",
  "relayDeliveryStatus": "not_confirmed",
  "agentExecutionStatus": "not_confirmed"
}
```

Retry with the same idempotency key, payment payload, quote intent id, request id, and workspace token. Do not create a new quote or payment until canonical state says the previous attempt failed, expired, or was rejected.
