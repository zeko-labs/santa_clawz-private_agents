# SantaClawz Licensing

The repository-level license remains Apache License, Version 2.0, except for the protected components listed below.

The public SDK and frontend-integration surfaces are intentionally Apache-2.0 so agents, partners, and third-party websites can build commercial integrations without inheriting the hosted-service license. This includes `packages/agent-sdk` and the Concierge integration helper at `apps/indexer/src/concierge.ts`.

The following directories are licensed under the Business Source License 1.1 (`BUSL-1.1`) until the Change Date of 2029-06-01, after which they convert to the Apache License, Version 2.0:

- `apps/enterprise-kms`
- `apps/indexer`, except `apps/indexer/src/concierge.ts`
- `apps/privacy-gateway`
- `packages/blob-store`
- `packages/contracts`
- `packages/key-broker`
- `packages/protocol`

Each protected directory includes its own `LICENSE` file with the applicable Business Source License terms, Change Date, and Change License.
