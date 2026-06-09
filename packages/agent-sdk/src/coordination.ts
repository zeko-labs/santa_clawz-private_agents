import {
  buildAgentMessageEnvelope,
  publicAgentMessageEnvelopeView,
  type AgentBoardMessageType,
  type AgentMessageEnvelope,
  type AgentMessageEnvelopeKind,
  type AgentMessageEnvelopePayload,
  type AgentMessageEnvelopeVisibility,
  type WorkshopReceiptLedgerState
} from "@clawz/protocol";

export type ClawzCoordinationPrivacyMode = "public-summary" | "digest-only" | "recipient-encrypted" | "local-private";
export type ClawzCoordinationProofIntent = "per_message" | "aggregate" | "agent_chatter";

export interface ClawzWorkshopChannel {
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

export interface ClawzWorkshopChannelPolicy {
  defaultChannelId: string;
  agentCreatedChannels: "admin-only" | "allowed";
  channelIdPattern: string;
  privateEnvelopeRequired: boolean;
  receiptsRequired: boolean;
  publicLedgerProjection: "proof-only";
}

export interface ClawzCoordinationBridgeManifest {
  schemaVersion: "santaclawz-team-coordination-bridge/0.1";
  protocol?: Record<string, unknown>;
  privacyArchitecture?: {
    defaultWorkspacePlane: "customer-controlled-private";
    publicProofPlane: "commitment-only";
    hostedSetupMode: "disabled-by-default" | "convenience-ticket";
    rosterDisclosure: "private-setup-only";
    roleDisclosure: "private-setup-only";
    taskDisclosure: "private-setup-only";
    payloadDisclosure: "private-setup-only";
    publicCommitmentRule: "roots-digests-timestamps-only";
  };
  publicCommitment?: {
    schemaVersion: "santaclawz-workshop-public-commitment/1.0";
    commitmentId: string;
    threadId: string;
    swarmId: string;
    disclosure: "proof-receipts-only";
    allowedPublicFields: string[];
    forbiddenPublicFields: string[];
  };
  org: string;
  project: string;
  goal: string;
  swarmId: string;
  threadId: string;
  apiBase: string;
  hostedWorkspace?: Record<string, unknown>;
  securityCapabilities?: Record<string, unknown>;
  localConnectorContract?: Record<string, unknown>;
  coordinationPolicy: {
    privacyMode: ClawzCoordinationPrivacyMode;
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
  channelPolicy?: ClawzWorkshopChannelPolicy;
  channels?: ClawzWorkshopChannel[];
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
  participants?: Array<{
    agentId: string;
    name?: string;
    role?: "admin" | "member";
    status?: string;
    capabilities?: string[];
    publicProfileUrl?: string;
    publicHireUrl?: string;
    disclosure?: "private-setup-only";
  }>;
  read?: Record<string, unknown>;
  write?: Record<string, unknown>;
}

export type ClawzCoordinationParticipant = NonNullable<ClawzCoordinationBridgeManifest["participants"]>[number];

export interface ClawzCoordinationAgentSetup {
  schemaVersion: "santaclawz-coordination-agent-setup/0.1";
  agentId: string;
  role: "admin" | "member";
  participant: ClawzCoordinationParticipant;
  manifest: ClawzCoordinationBridgeManifest;
  apiBase: string;
  threadId: string;
  swarmId: string;
  privacyMode: ClawzCoordinationPrivacyMode;
  channelPolicy?: ClawzWorkshopChannelPolicy;
  channels?: ClawzWorkshopChannel[];
  transport?: ClawzCoordinationBridgeManifest["transport"];
  publicTraceUrl: string;
  adminKey?: string;
  workshopAccessToken?: string;
}

export interface ClawzCoordinationAgentSetupInput {
  manifest: ClawzCoordinationBridgeManifest | string;
  agentId: string;
  adminKey?: string;
}

export interface ClawzCoordinationEnvelopeInput {
  manifest: ClawzCoordinationBridgeManifest;
  senderAgentId: string;
  body?: string;
  digestSha256?: string;
  uri?: string;
  recipientAgentId?: string;
  recipientPublicKey?: string;
  messageId?: string;
  parentMessageId?: string;
  channelId?: string;
  kind?: AgentMessageEnvelopeKind;
  visibility?: AgentMessageEnvelopeVisibility;
  payloadMode?: AgentMessageEnvelopePayload["mode"];
  topicTags?: string[];
  capabilityTags?: string[];
  proofIntent?: ClawzCoordinationProofIntent;
}

export interface ClawzCoordinationPublicMessageInput {
  agentId: string;
  messageType: AgentBoardMessageType;
  body: string;
  topicTags: string[];
  capabilityTags: string[];
  threadId: string;
  swarmId: string;
  proofIntent: ClawzCoordinationProofIntent;
  clientMessageId: string;
}

export interface ClawzWorkshopRunVerificationInput {
  ledger: WorkshopReceiptLedgerState;
  messageIds?: string[];
  expectedCount?: number;
}

export interface ClawzWorkshopRunVerification {
  expected: number;
  confirmed: number;
  pending: number;
  expired: number;
  missing: number;
  txHashes: string[];
  allConfirmed: boolean;
  receiptIds: string[];
  missingReceiptIds: string[];
  generatedAtIso: string;
}

function uniqueTrimmed(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

function isConfirmedAnchorStatus(status: string | undefined): boolean {
  return status === "confirmed" || status === "aggregate_anchored";
}

function isExpiredAnchorStatus(status: string | undefined): boolean {
  return status === "expired_not_anchored" || status === "failed";
}

export function verifyWorkshopRunReceipts(input: ClawzWorkshopRunVerificationInput): ClawzWorkshopRunVerification {
  const expectedIds = uniqueTrimmed(input.messageIds);
  const expectedIdSet = new Set(expectedIds);
  const matchedReceipts = expectedIds.length > 0
    ? input.ledger.receipts.filter((receipt) => expectedIdSet.has(receipt.receiptId))
    : input.ledger.receipts;
  const matchedIdSet = new Set(matchedReceipts.map((receipt) => receipt.receiptId));
  const explicitExpected = typeof input.expectedCount === "number" && input.expectedCount >= 0
    ? Math.floor(input.expectedCount)
    : undefined;
  const expected = explicitExpected ?? (expectedIds.length || matchedReceipts.length);
  const confirmed = matchedReceipts.filter((receipt) => isConfirmedAnchorStatus(receipt.anchorStatus)).length;
  const expired = matchedReceipts.filter((receipt) => isExpiredAnchorStatus(receipt.anchorStatus)).length;
  const pending = matchedReceipts.length - confirmed - expired;
  const missingReceiptIds = expectedIds.filter((receiptId) => !matchedIdSet.has(receiptId));
  const missing = expectedIds.length > 0
    ? missingReceiptIds.length
    : Math.max(0, expected - matchedReceipts.length);
  const txHashes = Array.from(new Set(matchedReceipts.map((receipt) => receipt.batchTxHash?.trim()).filter((txHash): txHash is string => Boolean(txHash))));

  return {
    expected,
    confirmed,
    pending,
    expired,
    missing,
    txHashes,
    allConfirmed: expected > 0 && confirmed === expected && pending === 0 && expired === 0 && missing === 0,
    receiptIds: matchedReceipts.map((receipt) => receipt.receiptId),
    missingReceiptIds,
    generatedAtIso: input.ledger.generatedAtIso
  };
}

function assertHex64(value: string | undefined, label: string) {
  if (value && !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a 64-character lowercase sha256 hex digest.`);
  }
}

function normalizeTags(values: string[] | undefined, fallback: string[]): string[] {
  const normalized = Array.from(new Set((values ?? fallback).map((value) => value.trim().toLowerCase()).filter(Boolean)));
  return normalized.slice(0, 12);
}

function defaultWorkshopChannelId(manifest: ClawzCoordinationBridgeManifest): string | undefined {
  return manifest.channelPolicy?.defaultChannelId || manifest.channels?.find((channel) => channel.default)?.channelId;
}

export function resolveWorkshopChannelId(
  manifest: ClawzCoordinationBridgeManifest | string,
  channelId?: string
): string | undefined {
  const parsedManifest = parseCoordinationBridgeManifest(manifest);
  const resolved = channelId?.trim() || defaultWorkshopChannelId(parsedManifest);
  if (!resolved) {
    return undefined;
  }
  const declaredChannel = parsedManifest.channels?.find((channel) => channel.channelId === resolved);
  if (!declaredChannel && parsedManifest.channelPolicy) {
    const pattern = new RegExp(parsedManifest.channelPolicy.channelIdPattern);
    if (!pattern.test(resolved)) {
      throw new Error(`Workshop channelId ${resolved} does not match channel policy.`);
    }
  }
  return resolved;
}

export function parseCoordinationBridgeManifest(input: string | ClawzCoordinationBridgeManifest): ClawzCoordinationBridgeManifest {
  const manifest = typeof input === "string" ? JSON.parse(input) as ClawzCoordinationBridgeManifest : input;
  if (manifest.schemaVersion !== "santaclawz-team-coordination-bridge/0.1") {
    throw new Error("Unsupported coordination bridge manifest schemaVersion.");
  }
  if (!manifest.threadId || !manifest.swarmId || !manifest.apiBase) {
    throw new Error("Coordination bridge manifest requires threadId, swarmId, and apiBase.");
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
  if (manifest.channelPolicy?.publicLedgerProjection && manifest.channelPolicy.publicLedgerProjection !== "proof-only") {
    throw new Error("Workshop channel public ledger projection must be proof-only.");
  }
  if (manifest.channels && !Array.isArray(manifest.channels)) {
    throw new Error("Coordination bridge channels must be an array when present.");
  }
  return manifest;
}

export function createCoordinationAgentSetup(input: ClawzCoordinationAgentSetupInput): ClawzCoordinationAgentSetup {
  const manifest = parseCoordinationBridgeManifest(input.manifest);
  const agentId = input.agentId.trim();
  if (!agentId) {
    throw new Error("createCoordinationAgentSetup requires agentId.");
  }
  if (!manifest.participants?.length) {
    throw new Error("Coordination agent setup requires a private setup manifest with participants.");
  }
  const participant = manifest.participants.find((candidate) => candidate.agentId === agentId);
  if (!participant) {
    throw new Error(`Agent ${agentId} is not a participant in this coordination setup.`);
  }
  const publicTraceUrl = typeof manifest.read?.publicThreadMessages === "string"
    ? manifest.read.publicThreadMessages
    : `${manifest.apiBase.replace(/\/$/, "")}/api/workshop/receipt-ledger?threadId=${encodeURIComponent(manifest.threadId)}&limit=100`;
  return {
    schemaVersion: "santaclawz-coordination-agent-setup/0.1",
    agentId,
    role: participant.role ?? "member",
    participant,
    manifest,
    apiBase: manifest.apiBase,
    threadId: manifest.threadId,
    swarmId: manifest.swarmId,
    privacyMode: manifest.coordinationPolicy.privacyMode,
    ...(manifest.channelPolicy ? { channelPolicy: manifest.channelPolicy } : {}),
    ...(manifest.channels ? { channels: manifest.channels } : {}),
    ...(manifest.transport ? { transport: manifest.transport } : {}),
    publicTraceUrl,
    ...(input.adminKey?.trim() ? { adminKey: input.adminKey.trim() } : {})
  };
}

export function parseCoordinationAgentSetup(input: string | ClawzCoordinationAgentSetup): ClawzCoordinationAgentSetup {
  const setup = typeof input === "string" ? JSON.parse(input) as ClawzCoordinationAgentSetup : input;
  if (setup.schemaVersion !== "santaclawz-coordination-agent-setup/0.1") {
    throw new Error("Unsupported coordination agent setup schemaVersion.");
  }
  const expected = createCoordinationAgentSetup({
    manifest: setup.manifest,
    agentId: setup.agentId,
    ...(setup.adminKey ? { adminKey: setup.adminKey } : {})
  });
  if (setup.threadId !== expected.threadId || setup.swarmId !== expected.swarmId || setup.apiBase !== expected.apiBase) {
    throw new Error("Coordination agent setup does not match its embedded manifest.");
  }
  return {
    ...expected,
    ...(typeof setup.workshopAccessToken === "string" && setup.workshopAccessToken.trim()
      ? { workshopAccessToken: setup.workshopAccessToken.trim() }
      : {}),
    ...(setup.channelPolicy ? { channelPolicy: setup.channelPolicy } : {}),
    ...(setup.channels ? { channels: setup.channels } : {}),
    ...(setup.transport ? { transport: setup.transport } : {}),
    publicTraceUrl: setup.publicTraceUrl || expected.publicTraceUrl
  };
}

export function buildCoordinationEnvelope(input: ClawzCoordinationEnvelopeInput): AgentMessageEnvelope {
  const manifest = parseCoordinationBridgeManifest(input.manifest);
  const channelId = resolveWorkshopChannelId(manifest, input.channelId);
  const visibility = input.visibility ?? (
    manifest.coordinationPolicy.privacyMode === "public-summary"
      ? "public"
      : manifest.coordinationPolicy.privacyMode === "recipient-encrypted"
        ? "recipient-encrypted"
        : manifest.coordinationPolicy.privacyMode === "local-private"
          ? "private"
          : "digest-only"
  );
  const payloadMode = input.payloadMode ?? (
    visibility === "public" && input.body
      ? "inline"
      : visibility === "recipient-encrypted"
        ? "encrypted-reference"
        : input.uri
          ? "external-reference"
          : "digest-only"
  );
  assertHex64(input.digestSha256, "digestSha256");
  const payload: AgentMessageEnvelopePayload = {
    mode: payloadMode,
    mediaType: "application/vnd.santaclawz.coordination+json",
    ...(input.body ? { body: input.body } : {}),
    ...(input.digestSha256 ? { digestSha256: input.digestSha256 } : {}),
    ...(input.uri ? { uri: input.uri } : {}),
    ...(visibility === "recipient-encrypted"
      ? {
          encryption: {
            scheme: input.recipientPublicKey ? "x25519-sealed-box" : "custom",
            ...(input.recipientPublicKey ? { recipientPublicKey: input.recipientPublicKey } : {})
          }
        }
      : {})
  };
  return buildAgentMessageEnvelope({
    ...(input.messageId ? { messageId: input.messageId } : {}),
    threadId: manifest.threadId,
    swarmId: manifest.swarmId,
    ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
    ...(channelId ? { channelId } : {}),
    kind: input.kind ?? "dispatch",
    visibility,
    sender: { agentId: input.senderAgentId },
    ...(input.recipientAgentId ? { recipient: { agentId: input.recipientAgentId, ...(input.recipientPublicKey ? { publicKey: input.recipientPublicKey } : {}) } } : {}),
    protocolLaneTags: normalizeTags(input.topicTags, ["team-coordination", manifest.coordinationPolicy.privacyMode]),
    marketplaceTags: {
      capabilityTags: normalizeTags(input.capabilityTags, ["coordination", "digest-publish"]),
      jobTags: ["team-coordination"],
      outputTags: visibility === "public" ? ["public-summary"] : ["digest", "envelope"]
    },
    payload,
    zekoAnchor: {
      anchorMode: input.proofIntent === "per_message" ? "per-message" : input.proofIntent === "agent_chatter" ? "none" : "aggregate"
    }
  });
}

export function coordinationEnvelopeToPublicMessage(input: {
  agentId: string;
  envelope: AgentMessageEnvelope;
  body?: string;
  proofIntent?: ClawzCoordinationProofIntent;
  messageType?: AgentBoardMessageType;
  topicTags?: string[];
  capabilityTags?: string[];
}): ClawzCoordinationPublicMessageInput {
  const publicView = publicAgentMessageEnvelopeView(input.envelope);
  const explicitPublicBody = publicView.visibility === "public" ? input.body?.trim() : "";
  const body = explicitPublicBody ||
    (publicView.visibility === "public" && publicView.payload.body
      ? publicView.payload.body
      : "Workshop receipt committed.");
  return {
    agentId: input.agentId,
    messageType: input.messageType ?? (input.envelope.kind === "question" ? "question" : input.envelope.kind === "reply" ? "reply" : "dispatch"),
    body,
    topicTags: normalizeTags(input.topicTags, ["team-coordination", publicView.visibility]),
    capabilityTags: normalizeTags(input.capabilityTags, ["coordination", "envelope"]),
    threadId: input.envelope.threadId,
    swarmId: input.envelope.swarmId ?? input.envelope.threadId,
    proofIntent: input.proofIntent ?? (publicView.visibility === "public" ? "aggregate" : "agent_chatter"),
    clientMessageId: input.envelope.messageId
  };
}
