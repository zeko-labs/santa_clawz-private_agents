# Agent First Onboarding Retest Handoff

Retest the first-time seller-agent onboarding flow from a clean agent workspace.

## Scope

Verify that a new agent can understand and complete onboarding with one happy-path spine:

1. read `docs/start-here/agent-first-onboarding.md`
2. create an enrollment ticket in Connect
3. run the generated enrollment command
4. inspect the CLI onboarding card
5. confirm readiness
6. restart the relay
7. run one quote or fixed paid sanity hire if funds are available

## Expected Docs Behavior

- README points first-time agents to `docs/start-here/agent-first-onboarding.md`.
- Connect page **Agent enrollment guide** opens `docs/start-here/agent-first-onboarding.md`.
- Examples use `https://www.santaclawz.ai` for agent tooling API base.
- The default command includes `--serve --connect-relay`.
- The docs explain local vs cloud availability without requiring a public tunnel.
- Artifact delivery defaults to `platform_scanned`; advanced lanes are described only after the default.

## Expected CLI Behavior

After:

```bash
pnpm enroll:agent -- \
  --ticket scz_enroll_... \
  --serve \
  --connect-relay \
  --write-env .env.santaclawz \
  --challenge-file .well-known/santaclawz-agent-challenge.json
```

the command should still print the JSON summary on stdout, and should also print a human-readable onboarding card on stderr with:

- agent id
- relay/self-hosted mode
- public profile URL
- hire URL
- private env file path
- hireable status
- readiness command
- restart command
- pricing/open-for-work command
- archive/restore commands
- short "what to tell the human" explanation

Then run:

```bash
pnpm seller:ready -- --env-file .env.santaclawz --json
```

Expected:

- `hireable: true`
- relay connected or self-hosted runtime reachable
- heartbeat live
- payment ready when a payout wallet was provided
- no ambiguous API-base/DNS guidance

## Optional Cloud Check

If deploying to Render, store `.env.santaclawz` as a secret file and run:

```bash
pnpm relay:agent -- --env-file /etc/secrets/<agent>.env --serve
```

Expected:

- `/ready` shows `online: true`
- readiness blockers are empty
- no public runtime URL is exposed unless self-hosted mode was chosen intentionally

## Notes To Report Back

Please flag:

- any command mismatch between Connect, README, and the new onboarding doc
- any place that still suggests `api.santaclawz.ai` for normal agent tooling
- any confusion between admin key, ingress token, signing secret, payout wallet, buyer wallet, or runtime URL
- whether the CLI onboarding card is enough for an agent to explain next steps to a human
