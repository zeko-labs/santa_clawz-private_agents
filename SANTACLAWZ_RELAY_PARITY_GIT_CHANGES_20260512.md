# SantaClawz Relay Parity Changes

Date: 2026-05-12

## Goal

Bring official `pnpm relay:agent` into parity with the known-good local relay shim so SantaClawz accepts local worker responses over the platform relay websocket.

The tester's key symptom was:

```text
Relay sent invalid JSON while SantaClawz was waiting for the agent response.
```

The official relay had already received local worker `200` responses, but the platform rejected the websocket `hire_response` payload before accepting the return.

## Code Changed

### `scripts/relay-agent.mjs`

- Canonicalizes local worker `santaclawz-return/1.0` responses before sending the relay `hire_response`.
- Handles all accepted return statuses:
  - `quoted`
  - `completed`
  - `failed`
- For completed returns, normalizes:
  - `request_id`
  - `agent_private: true`
  - `verified_output.package_hash`
  - `verified_output.hash_algorithm`
  - `verification_manifest.input_digest_sha256`
  - `verification_manifest.checks_performed`
  - `verification_manifest.files_produced`
  - `verification_manifest.blocked_suspicious_instructions`
  - deliverable `name` and `sha256`
- Keeps malformed completed/quote packages non-payable by throwing into the relay's failed-return path instead of inventing a valid completion.
- Adds websocket ping -> pong handling.
- Serializes websocket writes so heartbeat and hire responses do not interleave.
- Logs `relayPayloadBytes` and `relayPayloadDigestSha256` for the exact relay JSON envelope sent to SantaClawz.

### `apps/indexer/test/server-api.test.mjs`

- Adds a regression test that spawns the real `scripts/relay-agent.mjs`.
- The test sends a large noisy worker response through the official relay.
- It asserts SantaClawz accepts the normalized relay response as a completed hire.

New passing test log line:

```text
ok - official relay normalizes large worker responses into accepted hire_response JSON
```

## Verification Run

Passed locally:

```text
node --check scripts/relay-agent.mjs
pnpm --filter @clawz/indexer build
pnpm run test:indexer
pnpm run typecheck
```

## Tester Retest Focus

Please retest the official relay path, not the shim:

```text
pnpm relay:agent -- --env-file <agent env> --local-hire-url http://127.0.0.1:<worker-port>/hire --takeover
```

Expected behavior:

- Relay logs `relay_worker_response_normalized`.
- Platform no longer reports invalid relay JSON.
- Quote intake returns `status:"quoted"` when the worker returns a quote package.
- Paid/free-test execution returns `status:"completed"` when the worker returns a valid completed package.
- Payment remains authorized only until completion validation passes.
- Settlement still happens only after accepted completed return validation.

## Notes

Unrelated existing local changes are still present in:

- `apps/web-console/src/App.tsx`
- `apps/web-console/src/styles.css`

There is also a local dev-script change in:

- `apps/indexer/package.json`

Those are not part of the relay response parity fix.
