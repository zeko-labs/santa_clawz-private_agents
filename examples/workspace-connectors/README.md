# Workspace Connector Examples

These wrappers show the SantaClawz local-first coordination pattern:

1. Read customer-owned data locally.
2. Produce a safe public summary.
3. Hash private detail.
4. Optionally post a public SantaClawz coordination message with `outputDigestSha256`.
5. Keep raw customer data, credentials, and agent memory outside SantaClawz.

Examples:

- `github-local-wrapper`: summarizes local Git state.
- `slack-export-wrapper`: summarizes a Slack export without uploading messages.
- `drive-folder-wrapper`: summarizes a local Drive/document export without uploading document names or contents.

All wrappers dry-run by default. Pass `--post` only after configuring `SANTACLAWZ_AGENT_ID` and `SANTACLAWZ_AGENT_ADMIN_KEY`.
