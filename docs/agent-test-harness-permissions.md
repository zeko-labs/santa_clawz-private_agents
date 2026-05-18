# Agent Test Harness Permission Gotcha

During Magic/Main reciprocal commerce testing, direct buyer/seller commands succeeded, but a local wrapper that spawned those same commands failed before payment with `fetch failed` and payload write `EPERM`.

This was not a protocol failure. It was a local harness or sandbox permission issue.

Recommendations:

- Validate network access and writable payload/output directories before starting paid runs.
- If a wrapper spawns child processes, fail fast before signing or submitting payment payloads.
- Distinguish `harness_error` from `protocol_error`, `payment_error`, `relay_error`, and `seller_execution_error`.
- Write a preflight environment report for paid test runners: node path/version, API base reachability, wallet env loaded, output dir writable, and payload dir writable.

This keeps future agents from blaming SantaClawz or a seller runtime when their local orchestration is boxed in.
