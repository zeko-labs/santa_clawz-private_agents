import { canonicalDigest } from "../hashing/digest.js";

export const SANTACLAWZ_COORDINATION_BRIDGE_SCHEMA_VERSION = "santaclawz-team-coordination-bridge/0.1" as const;
export const SANTACLAWZ_COORDINATION_BRIDGE_PROTOCOL = "santaclawz-team-coordination-bridge" as const;
export const SANTACLAWZ_COORDINATION_BRIDGE_SUPPORTED_VERSIONS = [
  SANTACLAWZ_COORDINATION_BRIDGE_SCHEMA_VERSION
] as const;

export type SantaClawzCoordinationBridgeSchemaVersion =
  typeof SANTACLAWZ_COORDINATION_BRIDGE_SUPPORTED_VERSIONS[number];
export type SantaClawzCoordinationPrivacyMode =
  | "public-summary"
  | "digest-only"
  | "recipient-encrypted"
  | "local-private";

export interface SantaClawzCoordinationBridgeParticipant {
  agentId: string;
  name?: string;
  role?: "admin" | "member";
  status?: string;
  capabilities?: string[];
  publicProfileUrl?: string;
  publicHireUrl?: string;
  disclosure?: "private-setup-only";
}

export interface SantaClawzWorkshopChannel {
  channelId: string;
  name: string;
  purpose?: string;
  default?: boolean;
  allowedRoles?: Array<"admin" | "member">;
  allowedAgentIds?: string[];
  disclosure?: "private-setup-only";
  transport?: {
    privateEnvelopeRequired?: boolean;
    receiptRequired?: boolean;
    publicLedgerProjection?: "proof-only";
  };
}

export interface SantaClawzWorkshopChannelPolicy {
  defaultChannelId: string;
  agentCreatedChannels: "admin-only" | "allowed";
  channelIdPattern: string;
  privateEnvelopeRequired: boolean;
  receiptsRequired: boolean;
  publicLedgerProjection: "proof-only";
}

export interface SantaClawzCoordinationPrivacyArchitecture {
  defaultWorkspacePlane: "customer-controlled-private";
  publicProofPlane: "commitment-only";
  hostedSetupMode: "disabled-by-default" | "convenience-ticket";
  rosterDisclosure: "private-setup-only";
  roleDisclosure: "private-setup-only";
  taskDisclosure: "private-setup-only";
  payloadDisclosure: "private-setup-only";
  publicCommitmentRule: "roots-digests-timestamps-only";
}

export interface SantaClawzCoordinationPublicCommitment {
  schemaVersion: "santaclawz-workshop-public-commitment/1.0";
  commitmentId: string;
  threadId: string;
  swarmId: string;
  disclosure: "proof-receipts-only";
  allowedPublicFields: Array<
    | "commitmentId"
    | "threadId"
    | "swarmId"
    | "receiptId"
    | "receiptType"
    | "timestamp"
    | "receiptCommitmentSha256"
    | "batchRootDigestSha256"
    | "batchTxHash"
    | "aggregateCount"
  >;
  forbiddenPublicFields: Array<
    | "agentId"
    | "agentName"
    | "participantRoster"
    | "roleAssignment"
    | "taskSummary"
    | "messageBody"
    | "localRef"
    | "artifactUrl"
    | "customerData"
  >;
}

export interface SantaClawzCoordinationBridgeManifest {
  schemaVersion: SantaClawzCoordinationBridgeSchemaVersion;
  protocol?: SantaClawzCoordinationBridgeVersionDescriptor;
  privacyArchitecture?: SantaClawzCoordinationPrivacyArchitecture;
  publicCommitment?: SantaClawzCoordinationPublicCommitment;
  hostedWorkspace?: Record<string, unknown>;
  securityCapabilities?: Record<string, unknown>;
  localConnectorContract?: Record<string, unknown>;
  org: string;
  project: string;
  goal: string;
  swarmId: string;
  threadId: string;
  apiBase: string;
  coordinationPolicy: {
    privacyMode: SantaClawzCoordinationPrivacyMode;
    proofIntent?: string;
    publicBodyRule?: string;
  };
  receiptPolicy?: {
    receiptsRequired: boolean;
    receiptScope?: string;
    commitmentRootRequired?: boolean;
    localLedgerRequired?: boolean;
    selectiveRevealSupported?: boolean;
    publicDisclosureDefault?: string;
  };
  channelPolicy?: SantaClawzWorkshopChannelPolicy;
  channels?: SantaClawzWorkshopChannel[];
  transport?: {
    privateEnvelopeEndpoint?: string;
    privateEnvelopeReadEndpoint?: string;
    receiptEndpoint?: string;
    receiptLedgerEndpoint?: string;
    setupClaimEndpoint?: string;
  };
  anchoringPolicy?: {
    mode: string;
    defaultAnchor?: string;
    publicAnchor?: string;
    supportedStrategies?: string[];
  };
  participants?: SantaClawzCoordinationBridgeParticipant[];
  read?: Record<string, unknown>;
  write?: Record<string, unknown>;
}

export interface SantaClawzCoordinationBridgeVersionDescriptor {
  protocol: typeof SANTACLAWZ_COORDINATION_BRIDGE_PROTOCOL;
  schemaVersion: SantaClawzCoordinationBridgeSchemaVersion;
  stability: "early-adopter";
  compatibleEnvelopeVersions: ["santaclawz-agent-message-envelope/1.0"];
  compatiblePublicMessageBoard: "santaclawz-agent-board/1.0";
  compatiblePublicReceiptLedger: "santaclawz-workshop-receipt-ledger/1.0";
}

export function coordinationBridgeVersionDescriptor(): SantaClawzCoordinationBridgeVersionDescriptor {
  return {
    protocol: SANTACLAWZ_COORDINATION_BRIDGE_PROTOCOL,
    schemaVersion: SANTACLAWZ_COORDINATION_BRIDGE_SCHEMA_VERSION,
    stability: "early-adopter",
    compatibleEnvelopeVersions: ["santaclawz-agent-message-envelope/1.0"],
    compatiblePublicMessageBoard: "santaclawz-agent-board/1.0",
    compatiblePublicReceiptLedger: "santaclawz-workshop-receipt-ledger/1.0"
  };
}

export function assertSupportedCoordinationBridgeVersion(schemaVersion: string): SantaClawzCoordinationBridgeSchemaVersion {
  if (schemaVersion !== SANTACLAWZ_COORDINATION_BRIDGE_SCHEMA_VERSION) {
    throw new Error(`Unsupported SantaClawz coordination bridge schemaVersion: ${schemaVersion}`);
  }
  return schemaVersion;
}

export function assertValidCoordinationBridgeManifest(
  manifest: SantaClawzCoordinationBridgeManifest
): SantaClawzCoordinationBridgeManifest {
  assertSupportedCoordinationBridgeVersion(manifest.schemaVersion);
  if (!manifest.threadId || !manifest.swarmId || !manifest.apiBase) {
    throw new Error("Coordination bridge manifest requires threadId, swarmId, and apiBase.");
  }
  if (!manifest.org || !manifest.project || !manifest.goal) {
    throw new Error("Coordination bridge manifest requires org, project, and goal.");
  }
  if (manifest.privacyArchitecture) {
    if (manifest.privacyArchitecture.defaultWorkspacePlane !== "customer-controlled-private") {
      throw new Error("Coordination bridge default workspace plane must be customer-controlled-private.");
    }
    if (manifest.privacyArchitecture.publicProofPlane !== "commitment-only") {
      throw new Error("Coordination bridge public proof plane must be commitment-only.");
    }
  }
  if (manifest.publicCommitment?.disclosure && manifest.publicCommitment.disclosure !== "proof-receipts-only") {
    throw new Error("Coordination bridge public commitment must be proof-receipts-only.");
  }
  if (manifest.participants && !Array.isArray(manifest.participants)) {
    throw new Error("Coordination bridge participants must be an array when present.");
  }
  if (manifest.channelPolicy) {
    if (!manifest.channelPolicy.defaultChannelId) {
      throw new Error("Coordination bridge channelPolicy requires defaultChannelId.");
    }
    if (manifest.channelPolicy.publicLedgerProjection !== "proof-only") {
      throw new Error("Workshop channel public ledger projection must be proof-only.");
    }
  }
  if (manifest.channels) {
    if (!Array.isArray(manifest.channels)) {
      throw new Error("Coordination bridge channels must be an array when present.");
    }
    const channelIds = new Set<string>();
    for (const channel of manifest.channels) {
      if (!channel.channelId || !channel.name) {
        throw new Error("Coordination bridge channels require channelId and name.");
      }
      if (channelIds.has(channel.channelId)) {
        throw new Error(`Duplicate workshop channelId: ${channel.channelId}`);
      }
      channelIds.add(channel.channelId);
      if (channel.disclosure && channel.disclosure !== "private-setup-only") {
        throw new Error("Workshop channel disclosure must be private-setup-only.");
      }
      if (channel.transport?.publicLedgerProjection && channel.transport.publicLedgerProjection !== "proof-only") {
        throw new Error("Workshop channel public ledger projection must be proof-only.");
      }
    }
  }
  return manifest;
}

export function coordinationBridgeManifestDigestSha256(manifest: SantaClawzCoordinationBridgeManifest): string {
  return canonicalDigest(assertValidCoordinationBridgeManifest(manifest)).sha256Hex;
}
