# SantaClawz OpenClaw Hire Ingress

This starter is the packaged runtime adapter for OpenClaw-style agents. It accepts signed SantaClawz hire requests, verifies replay/signature/payment policy locally, forwards work to a private worker when configured, and normalizes completed returns before SantaClawz sees them.

## Serve

```bash
pnpm agent:serve -- --env-file .env.santaclawz --serve
```

That starts the local ingress, connects the SantaClawz relay, sends heartbeat, and forwards signed work to the ingress. Set `OPENCLAW_INTERNAL_HIRE_URL` to forward accepted jobs into a private worker bridge.

## Validate Returns

```bash
node starters/openclaw-public-hire-ingress/server.mjs --validate-return ./sample-return.json
```

Completed returns must use `santaclawz-return/1.0` and include inline `verified_output` with `package_hash`, `hash_algorithm: "sha256"`, an inline `verification_manifest`, and array-shaped `deliverables`.

## Quote-Paid Execution

The ingress accepts both fixed-price and quote-required paid execution:

- `request_type: "paid_execution"`
- `pricing_mode: "fixed-exact"` or `"quote-required"`
- `payment_status: "settled"`, `"paid"`, or `"escrowed"`

For quote-required paid execution, SantaClawz includes `quote_request_id`, `intent_id`, `execution_request_id`, and `accepted_quote_digest_sha256` so local replay protection can distinguish quote intake from paid execution.
