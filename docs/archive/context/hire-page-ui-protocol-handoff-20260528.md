# SantaClawz /hire UI and Protocol Handoff

Date: 2026-05-28
Audience: implementation agent taking over the `/hire` page redesign
Primary files:

- `apps/web-console/src/BuyerWorkroom.tsx`
- `apps/web-console/src/App.tsx`
- `apps/web-console/src/api.ts`
- `apps/web-console/src/styles.css`
- `docs/protocol/procurement-intents-v1.md`
- `docs/payments/fixed-price-payment-flow.md`
- `docs/payments/retry-policy-v1.md`
- `docs/platform/public-hire-url-pattern.md`

## Blunt Diagnosis

The current `/hire` page exposes too much protocol machinery at once. It is technically interesting, but it reads like an internal demo board rather than a buyer surface.

The protocol concepts are valid:

- buyer route planning
- direct hire
- quote request
- procurement intent
- x402 payment
- relay execution
- verified return package
- privacy and artifact lanes
- public proof/reputation anchoring

The UI problem is that all of those ideas appear simultaneously as separate cards, traces, labels, and status panels. A buyer should not have to understand "route plan", "agent-native mirror", "live trace", "procurement bid", and "protocol calls" before submitting a job.

The next pass should make `/hire` feel like a marketplace checkout and work-order composer, with protocol depth available only when useful.

## Product Goal

`/hire` should answer one buyer question:

> I have work. Which agent should do it, what will it cost, and what happens after I pay?

The page should make SantaClawz feel powerful because it is simple:

1. Describe the work.
2. Choose direct hire, quote, or marketplace bids.
3. Pay or post the request.
4. Track payment, execution, delivery, and proof.

The protocol trace should be a confidence layer, not the visual center of gravity.

## Current Implementation Map

The `/hire` route is handled by `BuyerWorkroom` through the hidden-page route in `App.tsx`.

Current `BuyerWorkroom` state includes:

- `persona`: `human | agent`
- `selectedAgentId`
- `requestSummary`
- `buyerContact`
- `budget`
- `privacyLane`
- `serverRoutingPlan`
- `routingAnchorDigest`
- `procurementResult`
- `wallet`
- `paymentState`

Current actions:

- `routeCurrentRequest()`: calls `POST /api/buyer-router/plan`
- `connectBaseWallet()`: connects EVM wallet and switches to Base
- `payOrRequestSelectedAgent()`: handles quote or fixed-price x402 flow
- `postProcurementIntent()`: calls `POST /api/procurement/intents`

Current rendering sections:

- hero card
- route summary card
- composer card
- live trace card
- route plan card
- human surface card
- agent-native mirror card

That is too many surfaces for the first version of a buyer page.

## Protocol Overview

### Route Planning

Endpoint:

```http
POST /api/buyer-router/plan
```

Input from UI:

```json
{
  "taskPrompt": "Review this repo for launch risks and return markdown findings.",
  "buyerMode": "human",
  "requesterContact": "human-buyer@local",
  "budgetUsd": "0.25",
  "privacyLane": "private",
  "marketplaceTags": {
    "jobTags": ["repo-review"],
    "capabilityTags": ["code-review"],
    "inputTags": ["url"],
    "outputTags": ["markdown"]
  },
  "selectedAgentId": "optional-agent-id"
}
```

Output:

- routing plan
- candidate agents
- recommended next action
- optional routing anchor digest

This should be shown as "Recommended route" or "Best matches", not as a full protocol object by default.

### Direct Hire or Quote

Endpoint:

```http
POST /api/agents/:agentId/hire
```

Used for:

- fixed-price payment challenge and paid submit
- quote intake for quote-required agents
- normal hire handoff after procurement award

Core body:

```json
{
  "taskPrompt": "Bounded work request",
  "requesterContact": "buyer@example.com",
  "marketplaceTags": {},
  "jobPrivacy": {},
  "artifactDelivery": {},
  "paymentPayload": {}
}
```

Important behavior:

- fixed-price agents return x402 challenge first when no payment is supplied
- quote-required agents return quote state first
- paid submit should use same job body plus signed payment payload
- platform errors must be retryable with the same idempotent payload where applicable

### Procurement Intents

Endpoint:

```http
POST /api/procurement/intents
```

Procurement lets a buyer post work before choosing a seller.

V1 flow:

1. Buyer creates intent.
2. Seller agents bid or decline.
3. Buyer accepts one bid with buyer token.
4. SantaClawz returns `nextAction`.
5. Buyer submits `nextAction.body` to the selected seller's normal hire API.

Procurement is seller selection. It is not payment, escrow, or execution by itself.

### Payment and Execution

Fixed-price payment flow:

1. UI posts hire body without payment.
2. API returns `402 Payment Required` with x402 fee-split requirement.
3. Browser asks wallet to sign EIP-3009 authorization.
4. UI posts hire body again with `paymentPayload`.
5. SantaClawz verifies/settles through ZK x402/facilitator path.
6. SantaClawz forwards signed job to seller relay.
7. Seller returns `santaclawz-return/1.0`.
8. SantaClawz records payment, delivery, return validation, and proof metadata.

Do not show all of this up front. Show it as a compact lifecycle after submission:

`Payment -> Agent working -> Delivered -> Proof recorded`

## Redesign Recommendation

### Default Page Shape

Replace the current multi-card protocol dashboard with one primary work-order surface.

Recommended layout:

```text
Hire an agent
Describe the work. SantaClawz can route it to one agent, request quotes, or open it for bids.

[ Work request textarea                                              ]

[ Budget ] [ Privacy ] [ Delivery ] [ Optional buyer contact ]

Recommended route
[ Best agent ] [ Request bids ] [ Direct hire selected agent ]

Best matches
[ Agent card ] [ Agent card ] [ Agent card ]

[ Route request ] [ Request bids ] [ Pay selected agent / Request quote ]

After submit:
[ Payment status ] [ Agent execution ] [ Delivery ] [ Proof ]

[ Advanced protocol details v ]
```

### Keep Above The Fold

Above the fold should include only:

- title and short promise
- work request textarea
- budget/privacy/delivery fields
- best match or route recommendation
- primary CTA

Everything else should be below or collapsed.

### Remove From Default View

Remove or collapse these current front-and-center concepts:

- "Agent procurement trace" eyebrow
- "Watch work move from intent to verified agent output" hero headline
- separate `Route / Seller / Rail` summary card
- always-visible live trace
- always-visible route plan card
- "Human surface" panel
- "Agent-native mirror" panel
- raw protocol path display
- raw route plan JSON

These can exist inside one `Protocol details` disclosure after the buyer has submitted or explicitly asks to inspect.

### Naming

Use buyer language first:

- "Work request", not "intent"
- "Find an agent", not "route plan"
- "Request bids", not "post procurement"
- "Pay selected agent", not "paid execution"
- "Proof recorded", not "routing anchor"
- "Private delivery", not "private package" if space is tight

Protocol names can appear in the collapsed details.

## Interaction Model

### Step 1: Compose

Required:

- `taskPrompt`

Recommended optional fields:

- budget
- privacy lane
- delivery lane
- buyer contact
- selected agent

Do not require buyer agents to know every field before routing. The UI can infer tags and route suggestions from the brief.

### Step 2: Route

CTA:

- `Find best agents`

Result:

- recommended route
- top candidates
- clear next action

Route result copy examples:

- "Best match: Code Audit Agent. Fixed price, ready for private markdown delivery."
- "This looks broad. Request bids from multiple agents before paying."
- "This agent requires a quote before paid execution."

### Step 3: Commit

Depending on route:

- Direct fixed price: `Pay and hire`
- Quote-required: `Request quote`
- Broad or uncertain: `Request bids`

Only show wallet connection when fixed-price payment is the next step.

### Step 4: Track

After submit, show a compact lifecycle:

```text
Payment: signed / settled / not needed
Agent: queued / working / completed / failed
Delivery: pending / delivered / buyer action needed
Proof: pending / recorded
```

If something fails, use typed error buckets:

- `payment_error`
- `platform_error`
- `relay_error`
- `seller_execution_error`
- `context_insufficient`
- `artifact_delivery_error`

## Agent Buyer/API Mode

The "Buying as Agent/Human" toggle should not dominate the page.

Recommendation:

- Default to human-simple UI.
- Put buyer-agent API details behind `Agent/API mode`.
- If enabled, show:
  - API endpoints
  - idempotency key guidance
  - route plan JSON
  - procurement handoff body
  - retry policy reminder

Agent mode should help technical buyers, not become the main page for everyone.

## Visual Direction

Use quiet marketplace density, not oversized editorial protocol cards.

Recommended:

- one major card for the work order
- one side panel for selected agent / route recommendation on desktop
- stacked cards on mobile
- smaller typography inside tool surfaces
- no huge hero headline
- no heavy glass overlay on every block
- no duplicate status panels
- no "protocol demo" language on the first screen

The background image can stay, but the work surface should be easier to scan.

## Minimal Component Plan

Inside `BuyerWorkroom.tsx`, split rendering into small local components or helper blocks:

- `WorkOrderForm`
- `RouteRecommendation`
- `CandidateList`
- `CommitAction`
- `JobLifecycle`
- `ProtocolDetails`

Keep state in `BuyerWorkroom` for now; do not introduce global state or a new router.

Recommended render order:

```tsx
<section className="hire-shell">
  <header className="hire-header" />
  <div className="hire-layout">
    <WorkOrderForm />
    <RouteRecommendation />
  </div>
  <CandidateList />
  <JobLifecycle />
  <ProtocolDetails />
</section>
```

## Protocol Details Disclosure

Use one collapsed disclosure:

```text
Protocol details
- Route plan digest
- API path
- selected agent ID
- marketplace tags
- privacy/artifact policy
- payment digest
- proof digest
- route plan JSON
```

Do not make this the main visual object.

## Acceptance Criteria

### Human UX

- A first-time buyer can understand the page in under 10 seconds.
- The first screen clearly answers: describe work, find/pay/request bids.
- There are no more than 3 primary actions visible at once.
- Wallet UI appears only when payment is relevant.
- Procurement is explained as "request bids".
- Protocol details are collapsed by default.

### Agent/API UX

- Buyer agents can still access route plan JSON.
- The page still exposes `/api/buyer-router/plan`, `/api/procurement/intents`, and `/api/agents/:id/hire` in advanced details.
- Idempotency and retry guidance remains visible in agent/API mode or protocol details.

### Protocol Correctness

- Direct fixed-price hire still performs the 402 -> wallet signature -> paid submit flow.
- Quote-required agents still use quote intake.
- Procurement intent creation still returns an intent and buyer token-backed handoff.
- `taskPrompt`, `marketplaceTags`, `jobPrivacy`, and `artifactDelivery` still flow into hire/procurement bodies.
- The UI distinguishes payment accepted from work delivered.
- Platform/relay errors do not masquerade as seller execution failures.

### Responsive UI

- Desktop: work-order form and selected route/agent side panel can sit side by side.
- Tablet: controls should not stretch awkwardly; use compact rows and wrap intelligently.
- Mobile: stack fields, keep CTAs sticky or near the form, collapse protocol details.

## Things Not To Do

- Do not add another hero card.
- Do not show every protocol state before the buyer submits.
- Do not make procurement look like payment.
- Do not require buyers to pick tags manually before routing.
- Do not make route plan JSON visible by default.
- Do not rename protocol fields in request bodies.
- Do not overfit the UI to one agent or one workload.

## Suggested Copy

Hero:

```text
Hire an agent
Describe the work. SantaClawz routes it to the right agent, handles payment, and records proof when work is delivered.
```

Textarea label:

```text
What do you need done?
```

Route button:

```text
Find agents
```

Procurement button:

```text
Request bids
```

Direct payment button:

```text
Pay and hire
```

Quote button:

```text
Request quote
```

Lifecycle labels:

```text
Payment
Agent work
Delivery
Proof
```

Protocol disclosure:

```text
Protocol details for buyer agents
```

## Technical Notes For The Next Agent

The current `BuyerWorkroom` already has most data and action plumbing. The redesign should mostly change presentation and progressive disclosure.

Keep these functions unless there is a specific bug:

- `routeCurrentRequest`
- `postProcurementIntent`
- `payOrRequestSelectedAgent`
- `hireRequestBody`
- `buildRoutingPlan`
- `chooseRoutingMode`
- `buildBrowserFeeSplitPaymentPayload`

Likely changes:

- replace the current returned JSX structure
- simplify associated CSS selectors in `styles.css`
- keep API types and request bodies stable
- possibly rename visible labels only

High-risk area:

- payment signing and payload construction
- quote vs fixed-price branching
- procurement idempotency
- job privacy and artifact delivery body shape

Do not alter those unless tests require it.

## Test Plan

Run:

```bash
pnpm run typecheck
pnpm --filter @clawz/web-console build
```

Then visually verify:

- `/hire` desktop
- `/hire` tablet
- `/hire` mobile
- work request text fits
- candidate cards do not overflow
- protocol details are collapsed by default
- route request does not crash when API is unavailable
- wallet connect button is only prominent when needed

If possible, run one non-payment route-plan smoke and one fixed-price buyer smoke against a known test agent.

