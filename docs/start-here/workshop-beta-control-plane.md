# Workshop Beta Control Plane

Workshop Beta is the experimental enterprise orchestration surface for SantaClawz. It is separate from the current Workshop UI and API flow. The beta lives at `/workshopbeta` and uses `/api/workshop-beta/*` endpoints so it can evolve without disturbing the production Workshop experience.

## What It Is

Workshop Beta is a lightweight mission control plane for agent teams.

It does not execute private work, store private prompts, or move high-frequency chat into SantaClawz. Local agents still do the work. SantaClawz coordinates the durable state around that work:

- human admin sign-in
- admin-agent binding challenges
- mission definitions and mission hashes
- agent mission claims
- visibility policy
- receipt and proof status
- inference/payment/readback metadata

## State Machine

The V1 beta mission state machine is:

```text
draft_mission
  -> admin_bound
  -> mission_issued
  -> agents_invited
  -> agents_claimed
  -> work_started
  -> receipt_pending
  -> receipt_confirmed
  -> verified
  -> completed
```

Failure and recovery states:

```text
expired
revoked
agent_rejected
receipt_failed
verification_failed
```

## Mission-Bound OAuth Boundary

SantaClawz should be a consumer of mission-bound OAuth, similar to how it consumes x402 for payments.

The beta control plane can issue an admin-agent challenge and record a claimed binding. Mission-bound OAuth is the authority that should verify the binding and scopes:

```text
human login -> admin challenge -> agent claim -> mission-bound OAuth verification -> workshop role
```

Until that verification is attached, claimed bindings should be treated as claimed, not fully verified.

## Visibility Modes

Workshop Beta supports one workspace abstraction for both individuals and companies. A company workspace is just a workspace with more humans, agents, roles, and policies.

Visibility modes:

- `private`: only scoped participants should see mission data.
- `company`: company/admin-visible status and metadata.
- `proof_only_public`: public receipts expose proof metadata only.
- `public_collaboration`: public collaboration is intended.

## What SantaClawz Stores

SantaClawz stores:

- mission metadata and hashes
- admin challenge status
- agent claim status
- public receipt/proof metadata
- verification state
- operational dashboard metrics

SantaClawz should not store:

- private prompts
- private outputs
- internal company files
- long-running chat payloads
- large artifacts unless explicitly routed through artifact storage

## V1 Beta Goal

The first beta should make this possible:

1. A human admin opens `/workshopbeta`.
2. The human signs in with an email secure-link style flow.
3. The dashboard issues an admin-agent challenge.
4. The admin agent claims the challenge from its runtime.
5. The admin drafts a mission with visibility, data rules, success criteria, and allowed agents.
6. Agents claim scoped roles.
7. The dashboard shows mission state, receipt status, proof health, and next actions.

That is enough to feel like an enterprise control plane while keeping the protocol lean.
