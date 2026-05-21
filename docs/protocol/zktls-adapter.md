# zkTLS Adapter for ClawZ

ClawZ does not currently implement zkTLS. Today it proves:

- who an agent represents
- what it is allowed to do
- how it gets paid
- what privacy boundary governed the run

That is already useful and interoperable. zkTLS should be added as an optional evidence rail that
lets ClawZ also prove:

> this turn relied on a remote web fact, from this host, under this policy, and the fact was
> attested without exposing more raw user data than necessary.

## Recommendation

Build zkTLS into ClawZ as a first-class origin-proof adapter, not as a separate protocol.

That means:

- keep ClawZ as the coordination, privacy, payment, and authority layer
- treat zkTLS as one possible evidence source for remote facts
- bind zkTLS attestations into the same manifests, receipts, proof bundles, and Zeko commitments
- keep raw transcripts and response bodies offchain and sealed by default

This preserves the core ClawZ story:

- privacy-first by default
- interoperable agent proofs
- Zeko-bound control-plane truth
- enterprise disclosure and retention governance

## What zkTLS Should And Should Not Do

zkTLS should do:

- attest that a remote HTTPS response came from an allowed host
- attest that the response matched a narrow request scope
- produce a digest or selective reveal that ClawZ can bind to the turn
- let another agent verify the origin proof from the ClawZ proof bundle

zkTLS should not do:

- replace ClawZ session, turn, approval, disclosure, or payment semantics
- force raw transcripts onchain
- bypass privacy exceptions or enterprise governance
- become mandatory for every turn

## Exact Fit In ClawZ

The clean fit is:

1. ClawZ decides whether a turn may use a remote host.
2. If the turn requires origin authenticity, ClawZ routes the fetch through a zkTLS adapter.
3. The adapter returns an attestation bundle plus minimal disclosed facts.
4. ClawZ stores the full attestation package in sealed storage.
5. ClawZ adds digests and policy bindings to receipts, artifacts, proof bundles, and Zeko commitments.
6. Another agent verifies the same bundle through `/.well-known/agent-interop.json`, `/api/interop/agent-proof`, and `/api/interop/verify`.

## Product Behavior

### UX

Add a new evidence badge in the console:

- `Verified Web Fact`

When present, the operator should see:

- host
- policy scope
- attested at time
- freshness window
- whether the proof exposes digest-only, selective reveal, or redacted fields

Privacy UX should stay simple:

- `Local only`
- `Remote redacted`
- `Remote digest`
- `zkTLS attested`

The trust dial should not expose zkTLS as a separate mode. It should be a per-step evidence class
inside the existing trust mode.

### Enterprise Privacy

The default enterprise posture should be:

- response body sealed offchain
- only the smallest verified fact or digest enters the turn proof
- raw transcript disclosure requires a privacy exception
- zkTLS verifier metadata is public enough to validate provenance but not enough to leak user data

## Adapter Architecture

### Components

1. `zktls-adapter`
   - normalizes requests from ClawZ
   - enforces allowlisted hosts and selectors
   - talks to a zkTLS prover or notary system

2. `sealed blob store`
   - stores attestation bundles, optional transcript fragments, and any selective reveal package

3. `indexer proof surface`
   - publishes the origin-proof digest and verifier metadata as part of the interop bundle

4. `contracts`
   - bind the origin proof root into turn/output finalization on Zeko

### Request Lifecycle

1. Worker runtime emits a step with `externalHost`.
2. Policy engine checks:
   - host allowlist
   - trust mode
   - privacy exception requirements
   - whether zkTLS is required for this capability
3. Adapter creates an attestation request:
   - method
   - host
   - path or request template hash
   - header allowlist hash
   - selector or extraction rule hash
   - freshness window
4. zkTLS system returns:
   - attestation proof
   - verifier metadata
   - response digest
   - optional redacted fields or extracted facts
5. ClawZ seals the full package offchain.
6. ClawZ commits only digests and policy bindings into receipts and output commitments.

## Exact Protocol Additions

These are the concrete additions I would make.

### `packages/protocol/src/privacy/types.ts`

Add:

- `ProviderClass += "zktls-attested-remote"`

This lets a capability explicitly advertise that it routes through a zkTLS-backed remote source
instead of only `sealed-local`, `redacted-remote`, or `digest-only`.

### `packages/protocol/src/interop/agent-proof.ts`

Add:

- `InteropEvidenceObject.kind += "origin-proof"`
- `ClawzTrustAnchor.type += "zktls-verifier"`

Add a new structured object:

```ts
export interface ZkTlsOriginProof {
  originProofId: string;
  sessionId: string;
  turnId: string;
  stepId: string;
  host: string;
  method: "GET" | "POST";
  requestTemplateHash: string;
  requestHeaderAllowlistHash: string;
  responseStatus: number;
  responseHeaderDigest: string;
  responseBodyDigest: string;
  extractedFactDigest: string;
  selectiveRevealDigest?: string;
  verifierKeyHash: string;
  verifierSystem: string;
  attestedAtIso: string;
  expiresAtIso: string;
  disclosureClass: "self-only" | "team" | "compliance" | "custom";
  rawTranscriptManifestId?: string;
}
```

Add to the proof bundle:

- `originProofs?: ZkTlsOriginProof[]`

This lets another agent verify not just authority and payment, but also the provenance of remote
facts used in the turn.

### `packages/protocol/src/leaves/types.ts`

Add:

```ts
export interface OriginProofLeaf {
  originProofId: string;
  sessionId: string;
  turnId: string;
  stepId: string;
  hostHash: Fieldish;
  requestTemplateHash: Fieldish;
  responseBodyDigest: Fieldish;
  extractedFactDigest: Fieldish;
  verifierKeyHash: Fieldish;
  attestedAtSlot: string;
  expiresAtSlot: string;
}
```

This is the minimal onchain leaf we need for a turn to say, "a verified remote fact existed and
was policy-bound at this point in time."

### `packages/protocol/src/receipts/tool-receipt.ts`

Extend `ToolReceipt` with:

- `originProofRef?: string`
- `originProofDigest?: string`
- `originVerifierKeyHash?: string`

Extend `OutputCommitment` with:

- `originProofRoot: string`

This is the best place to bind zkTLS into the turn output path without leaking the raw response.

## Exact Contract Recommendation

I would do this in two phases.

### Phase 1: Minimal, fastest path

Update the existing turn output commitment:

```ts
buildTurnOutputCommitment(
  turnIdHash,
  outputHash,
  artifactRoot,
  visibilityHash,
  originProofRoot
)
```

That change touches:

- `packages/contracts/src/shared/commitments.ts`
- `packages/contracts/src/turn/TurnKernel.ts`
- `packages/contracts/src/shared/witness-builders.ts`
- runtime flow planners that currently assemble `artifactRoot`

This is the highest-leverage path because it reuses the existing turn finalization rail and keeps
deployment complexity low.

### Phase 2: Stronger reuse model

If we want one origin proof to be reusable across multiple turns or sessions, add:

- `OriginKernel`

Responsibilities:

- register origin proof commitments
- optionally support revocation or expiry
- optionally support verifier registry rotation

I would not start here. It is stronger, but it is not the fastest path to value.

## What Goes Onchain vs Offchain

### Onchain

Commit only:

- origin proof root
- verifier key hash
- extracted fact digest
- policy hash
- attestation time slot
- expiry slot

### Offchain sealed

Keep sealed:

- full response body
- transcript fragments
- full selective reveal package
- any user-specific request parameters

### Public proof bundle

Publish:

- host
- request template hash
- response digest
- extracted fact digest
- verifier system
- verifier key hash
- attested timestamp
- disclosure class

This gives verifiability without turning ClawZ into a data leak.

## Privacy Exception Semantics

zkTLS should not weaken enterprise privacy. It should strengthen it.

Rules:

- digest-only verified facts need no additional disclosure if they reveal no raw user content
- selective reveal packages should require the same privacy-exception flow as any other visibility expansion
- raw transcript disclosure should be treated as a high-sensitivity exception
- enterprise policy should be able to require guardian approval for any remote attestation using customer data

## DevX Recommendation

Expose a narrow internal interface:

```ts
export interface OriginProofAdapter {
  createAttestation(request: {
    sessionId: string;
    turnId: string;
    stepId: string;
    host: string;
    method: "GET" | "POST";
    requestTemplateHash: string;
    selectorHash: string;
    freshnessWindowSeconds: number;
  }): Promise<{
    originProof: ZkTlsOriginProof;
    sealedManifestId?: string;
  }>;
}
```

Then implement:

- `NoopOriginProofAdapter`
  - current default
- `ZkTlsOriginProofAdapter`
  - real adapter

This avoids coupling the whole worker runtime to any one zkTLS vendor or proving stack.

## Indexer And Interop Changes

The indexer should surface origin proofs in three places:

1. `GET /api/interop/agent-proof`
   - add `originProofs`

2. `GET/POST /api/interop/verify`
   - verify origin proof digests and verifier metadata

3. MCP `verify_agent_proof`
   - include origin proof verification in the report

The trust anchors section should add:

- `type: "zktls-verifier"`
- `verificationMaterial: [verifierSystem, verifierKeyHash, attestation digest rules]`

## Best Initial Use Cases

I would first use zkTLS in ClawZ for:

1. market and pricing facts
   - weather, price feeds, benchmarks, exchange pages

2. enterprise compliance facts
   - policy document version checks
   - sanctioned-entity list confirmation
   - regulatory filing pulls

3. agent-to-agent evidence exchange
   - one agent can present not just its own authority and payment proof, but the attested origin of
     a remote fact it relied upon

## Why This Is Worth It

Without zkTLS, ClawZ already proves the agent and the governance boundary.

With zkTLS, ClawZ can additionally prove:

- the remote fact came from the claimed host
- the fact was collected under a defined policy
- the fact was bound to the turn that used it
- the proof did not require broad data disclosure

That turns ClawZ from "private agent protocol with strong accountability" into "private agent
protocol with accountable external truth."

## Recommended Build Order

1. Add protocol types and evidence kinds.
2. Extend receipts and output commitments with `originProofRoot`.
3. Add `NoopOriginProofAdapter` and runtime hooks.
4. Add indexer proof-surface support and verifier checks.
5. Add the real `ZkTlsOriginProofAdapter`.
6. Only then decide whether `OriginKernel` is worth introducing.

## Bottom Line

zkTLS is not part of ClawZ today.

But it fits cleanly if we treat it as:

- an origin-proof adapter
- governed by existing privacy and approval rules
- sealed offchain by default
- bound onchain through turn output commitments
- published through the same interoperable proof surface

That is the design I would build.
