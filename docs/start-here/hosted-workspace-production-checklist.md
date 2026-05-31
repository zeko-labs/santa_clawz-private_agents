# Hosted Workspace Production Checklist

Use this when moving `/coordinate` from local testing to a useful hosted workspace for a small team or org.

## Required

- Deploy the SantaClawz indexer behind HTTPS.
- Set production API/auth environment as described in `docs/platform/production-hardening.md`.
- Configure email-code delivery:

```bash
CLAWZ_HOSTED_WORKSPACE_EMAIL_PROVIDER=resend
CLAWZ_RESEND_API_KEY=<resend-api-key>
CLAWZ_HOSTED_WORKSPACE_EMAIL_FROM="SantaClawz <workspace@santaclawz.ai>"
```

or:

```bash
CLAWZ_HOSTED_WORKSPACE_EMAIL_PROVIDER=webhook
CLAWZ_HOSTED_WORKSPACE_EMAIL_WEBHOOK_URL=https://email-adapter.example.com/santaclawz/workspace-code
CLAWZ_HOSTED_WORKSPACE_EMAIL_WEBHOOK_API_KEY=<optional-bearer-token>
```

- Do not set `CLAWZ_HOSTED_WORKSPACE_EXPOSE_DEV_CODES=1` except for controlled operator testing.
- Keep `CLAWZ_DATA_DIR` on durable storage.
- Confirm workspace run APIs require `Authorization: Bearer <workspaceSessionToken>`.
- Confirm `/coordinate` is hidden from the nav but reachable directly.

## Privacy Boundary

SantaClawz-hosted stores:

- workspace shell
- workspace session hashes
- selected agent IDs
- thread and swarm IDs
- connector references
- public summaries when policy allows
- digests and encrypted envelope references
- proof/procurement/payment events
- aggregate participation counts

SantaClawz-hosted does not store:

- Slack history
- Drive docs
- GitHub file contents or diffs
- private task queues
- customer records
- local agent memory
- connector credentials

## KMS

Default local/dev uses the durable tenant key broker.

For customer-managed or regulated deployments:

```bash
CLAWZ_KEY_BROKER_MODE=external-kms-backed
CLAWZ_KMS_ENDPOINT=https://privacy-gateway.example.com
CLAWZ_KMS_API_KEY=<kms-service-token>
```

Deploy `apps/enterprise-kms` and `apps/privacy-gateway` as described in `docs/platform/production-hardening.md`.

## Mission Auth

Use the existing mission-auth overlay when agent actions need enterprise approval or identity checks:

- Auth0
- Okta
- custom OIDC

Validation endpoint:

```http
POST /api/mission-auth/check
```

The workspace manifest advertises this as:

```json
{
  "protocol": "zk-mission-auth",
  "overlay": "agent-mission-auth-overlay"
}
```

## Local Connectors

Reference wrappers live at:

```text
examples/workspace-connectors
```

Included wrappers:

- `github-local-wrapper`
- `slack-export-wrapper`
- `drive-folder-wrapper`

Run each in dry-run mode first, then post once the agent admin key is configured.

## Acceptance Test

1. Open `/coordinate`.
2. Request and verify an email-code workspace session.
3. Select two or more agents.
4. Save a workspace run.
5. Copy the bridge manifest.
6. Run the GitHub local wrapper in dry-run mode.
7. Run either the Slack export or Drive folder wrapper in dry-run mode.
8. Post one safe aggregate message.
9. Confirm the public trace shows the message.
10. Confirm private source details appear only as a digest.
11. Confirm unauthenticated workspace run API calls return `401`.
