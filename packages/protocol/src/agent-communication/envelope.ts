import { canonicalDigest } from "../hashing/digest.js";
import type { MarketplaceWorkTags } from "../runtime/console-state.js";

export type AgentMessageEnvelopeKind =
  | "dispatch"
  | "question"
  | "reply"
  | "request"
  | "quote"
  | "permission_grant"
  | "artifact_notice"
  | "output_summary"
  | "procurement"
  | "status";

export type AgentMessageEnvelopeVisibility =
  | "public"
  | "digest-only"
  | "buyer-encrypted"
  | "recipient-encrypted"
  | "private";

export type AgentMessagePayloadMode =
  | "inline"
  | "digest-only"
  | "encrypted-reference"
  | "artifact-reference"
  | "external-reference";

export type AgentMessageAnchorMode =
  | "none"
  | "aggregate"
  | "per-message"
  | "direct-zkapp";

export interface AgentMessageEnvelopeParty {
  agentId: string;
  sessionId?: string;
  operatorId?: string;
  publicKey?: string;
  endpointHint?: string;
}

export interface AgentMessagePermissionScope {
  lane:
    | "public"
    | "team"
    | "buyer-seller"
    | "subcontract"
    | "verifier"
    | "private-swarm"
    | "custom";
  allowedActions?: string[];
  expiresAtIso?: string;
  policyDigestSha256?: string;
}

export interface AgentMessageEnvelopePayload {
  mode: AgentMessagePayloadMode;
  mediaType?: string;
  body?: string;
  digestSha256?: string;
  uri?: string;
  artifactManifestUrl?: string;
  artifactBundleDigestSha256?: string;
  encryption?: {
    scheme: "x25519-sealed-box" | "age" | "custom";
    keyId?: string;
    recipientPublicKey?: string;
  };
}

export interface AgentMessageEnvelopeZekoAnchor {
  anchorMode: AgentMessageAnchorMode;
  candidateId?: string;
  batchId?: string;
  rootDigestSha256?: string;
  txHash?: string;
  network?: "zeko-testnet" | "zeko-mainnet" | "custom";
}

export interface AgentMessageEnvelope {
  schemaVersion: "santaclawz-agent-message-envelope/1.0";
  messageId: string;
  threadId: string;
  parentMessageId?: string;
  channelId?: string;
  swarmId?: string;
  sentAtIso: string;
  kind: AgentMessageEnvelopeKind;
  visibility: AgentMessageEnvelopeVisibility;
  sender: AgentMessageEnvelopeParty;
  recipient?: AgentMessageEnvelopeParty;
  permissionScope?: AgentMessagePermissionScope;
  marketplaceTags?: Partial<MarketplaceWorkTags>;
  protocolLaneTags?: string[];
  marketplaceIntentTags?: string[];
  payload: AgentMessageEnvelopePayload;
  zekoAnchor: AgentMessageEnvelopeZekoAnchor;
  envelopeDigestSha256: string;
}

export interface BuildAgentMessageEnvelopeInput {
  messageId?: string;
  threadId?: string;
  parentMessageId?: string;
  channelId?: string;
  swarmId?: string;
  sentAtIso?: string;
  kind?: AgentMessageEnvelopeKind;
  visibility?: AgentMessageEnvelopeVisibility;
  sender: AgentMessageEnvelopeParty;
  recipient?: AgentMessageEnvelopeParty;
  permissionScope?: AgentMessagePermissionScope;
  marketplaceTags?: Partial<MarketplaceWorkTags>;
  protocolLaneTags?: string[];
  marketplaceIntentTags?: string[];
  payload: AgentMessageEnvelopePayload;
  zekoAnchor?: Partial<AgentMessageEnvelopeZekoAnchor>;
}

export interface PublicAgentMessageEnvelopeView {
  schemaVersion: "santaclawz-agent-message-envelope-public/1.0";
  messageId: string;
  threadId: string;
  parentMessageId?: string;
  channelId?: string;
  swarmId?: string;
  sentAtIso: string;
  kind: AgentMessageEnvelopeKind;
  visibility: AgentMessageEnvelopeVisibility;
  sender: AgentMessageEnvelopeParty;
  recipient?: AgentMessageEnvelopeParty;
  permissionScope?: AgentMessagePermissionScope;
  marketplaceTags?: Partial<MarketplaceWorkTags>;
  protocolLaneTags?: string[];
  marketplaceIntentTags?: string[];
  payload: {
    mode: AgentMessagePayloadMode;
    mediaType?: string;
    digestSha256?: string;
    uri?: string;
    artifactManifestUrl?: string;
    artifactBundleDigestSha256?: string;
    body?: string;
  };
  zekoAnchor: AgentMessageEnvelopeZekoAnchor;
  envelopeDigestSha256: string;
}

const HEX_64 = /^[a-f0-9]{64}$/;

function sanitizeIdentifier(value: string | undefined, fallback: string, maxLength = 160): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.slice(0, maxLength);
}

function sanitizeOptionalIdentifier(value: string | undefined, maxLength = 160): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function sanitizeStringList(values: string[] | undefined, maxLength = 48): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const normalized = Array.from(new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean)))
    .map((value) => value.slice(0, maxLength));
  return normalized.length > 0 ? normalized : undefined;
}

function sanitizeParty(party: AgentMessageEnvelopeParty): AgentMessageEnvelopeParty {
  const agentId = sanitizeIdentifier(party.agentId, "");
  if (!agentId) {
    throw new Error("Agent message envelope party requires agentId.");
  }
  const output: AgentMessageEnvelopeParty = { agentId };
  const sessionId = sanitizeOptionalIdentifier(party.sessionId);
  const operatorId = sanitizeOptionalIdentifier(party.operatorId);
  const publicKey = sanitizeOptionalIdentifier(party.publicKey, 240);
  const endpointHint = sanitizeOptionalIdentifier(party.endpointHint, 240);
  if (sessionId) output.sessionId = sessionId;
  if (operatorId) output.operatorId = operatorId;
  if (publicKey) output.publicKey = publicKey;
  if (endpointHint) output.endpointHint = endpointHint;
  return output;
}

function sanitizeMarketplaceTags(tags: Partial<MarketplaceWorkTags> | undefined): Partial<MarketplaceWorkTags> | undefined {
  if (!tags) {
    return undefined;
  }
  const normalized: Partial<MarketplaceWorkTags> = {};
  const capabilityTags = sanitizeStringList(tags.capabilityTags);
  const jobTags = sanitizeStringList(tags.jobTags);
  const inputTags = sanitizeStringList(tags.inputTags);
  const outputTags = sanitizeStringList(tags.outputTags);
  if (capabilityTags) normalized.capabilityTags = capabilityTags;
  if (jobTags) normalized.jobTags = jobTags;
  if (inputTags) normalized.inputTags = inputTags;
  if (outputTags) normalized.outputTags = outputTags;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function sanitizePermissionScope(scope: AgentMessagePermissionScope | undefined): AgentMessagePermissionScope | undefined {
  if (!scope) {
    return undefined;
  }
  const output: AgentMessagePermissionScope = { lane: scope.lane };
  const allowedActions = sanitizeStringList(scope.allowedActions);
  const expiresAtIso = sanitizeOptionalIdentifier(scope.expiresAtIso, 64);
  if (allowedActions) output.allowedActions = allowedActions;
  if (expiresAtIso) output.expiresAtIso = expiresAtIso;
  if (scope.policyDigestSha256 && HEX_64.test(scope.policyDigestSha256)) {
    output.policyDigestSha256 = scope.policyDigestSha256;
  }
  return output;
}

function sanitizePayload(payload: AgentMessageEnvelopePayload): AgentMessageEnvelopePayload {
  const body = payload.body?.trim();
  const digestSha256 =
    payload.digestSha256 && HEX_64.test(payload.digestSha256)
      ? payload.digestSha256
      : body
        ? canonicalDigest({ body }).sha256Hex
        : undefined;
  const output: AgentMessageEnvelopePayload = { mode: payload.mode };
  const mediaType = sanitizeOptionalIdentifier(payload.mediaType, 120);
  const uri = sanitizeOptionalIdentifier(payload.uri, 500);
  const artifactManifestUrl = sanitizeOptionalIdentifier(payload.artifactManifestUrl, 500);
  if (mediaType) output.mediaType = mediaType;
  if (body && payload.mode === "inline") output.body = body.slice(0, 8000);
  if (digestSha256) output.digestSha256 = digestSha256;
  if (uri) output.uri = uri;
  if (artifactManifestUrl) output.artifactManifestUrl = artifactManifestUrl;
  if (payload.artifactBundleDigestSha256 && HEX_64.test(payload.artifactBundleDigestSha256)) {
    output.artifactBundleDigestSha256 = payload.artifactBundleDigestSha256;
  }
  if (payload.encryption) {
    const encryption: NonNullable<AgentMessageEnvelopePayload["encryption"]> = {
      scheme: payload.encryption.scheme
    };
    const keyId = sanitizeOptionalIdentifier(payload.encryption.keyId, 160);
    const recipientPublicKey = sanitizeOptionalIdentifier(payload.encryption.recipientPublicKey, 240);
    if (keyId) encryption.keyId = keyId;
    if (recipientPublicKey) encryption.recipientPublicKey = recipientPublicKey;
    output.encryption = encryption;
  }
  return output;
}

function sanitizeZekoAnchor(anchor: Partial<AgentMessageEnvelopeZekoAnchor> | undefined): AgentMessageEnvelopeZekoAnchor {
  const output: AgentMessageEnvelopeZekoAnchor = { anchorMode: anchor?.anchorMode ?? "aggregate" };
  const candidateId = sanitizeOptionalIdentifier(anchor?.candidateId);
  const batchId = sanitizeOptionalIdentifier(anchor?.batchId);
  const txHash = sanitizeOptionalIdentifier(anchor?.txHash, 120);
  if (candidateId) output.candidateId = candidateId;
  if (batchId) output.batchId = batchId;
  if (anchor?.rootDigestSha256 && HEX_64.test(anchor.rootDigestSha256)) output.rootDigestSha256 = anchor.rootDigestSha256;
  if (txHash) output.txHash = txHash;
  if (anchor?.network) output.network = anchor.network;
  return output;
}

export function buildAgentMessageEnvelope(input: BuildAgentMessageEnvelopeInput): AgentMessageEnvelope {
  const sentAtIso = sanitizeIdentifier(input.sentAtIso, new Date().toISOString(), 64);
  const threadId = sanitizeIdentifier(input.threadId, `thread_${canonicalDigest({
    sender: input.sender.agentId,
    sentAtIso,
    payload: input.payload
  }).sha256Hex.slice(0, 24)}`);
  const draft: Omit<AgentMessageEnvelope, "envelopeDigestSha256"> = {
    schemaVersion: "santaclawz-agent-message-envelope/1.0",
    messageId: sanitizeIdentifier(input.messageId, ""),
    threadId,
    sentAtIso,
    kind: input.kind ?? "dispatch",
    visibility: input.visibility ?? "digest-only",
    sender: sanitizeParty(input.sender),
    payload: sanitizePayload(input.payload),
    zekoAnchor: sanitizeZekoAnchor(input.zekoAnchor)
  };
  const parentMessageId = sanitizeOptionalIdentifier(input.parentMessageId);
  const channelId = sanitizeOptionalIdentifier(input.channelId);
  const swarmId = sanitizeOptionalIdentifier(input.swarmId);
  const permissionScope = sanitizePermissionScope(input.permissionScope);
  const marketplaceTags = sanitizeMarketplaceTags(input.marketplaceTags);
  const protocolLaneTags = sanitizeStringList(input.protocolLaneTags);
  const marketplaceIntentTags = sanitizeStringList(input.marketplaceIntentTags);
  if (parentMessageId) draft.parentMessageId = parentMessageId;
  if (channelId) draft.channelId = channelId;
  if (swarmId) draft.swarmId = swarmId;
  if (input.recipient) draft.recipient = sanitizeParty(input.recipient);
  if (permissionScope) draft.permissionScope = permissionScope;
  if (marketplaceTags) draft.marketplaceTags = marketplaceTags;
  if (protocolLaneTags) draft.protocolLaneTags = protocolLaneTags;
  if (marketplaceIntentTags) draft.marketplaceIntentTags = marketplaceIntentTags;
  const messageId = draft.messageId || `msg_${canonicalDigest({ ...draft, messageId: "" }).sha256Hex.slice(0, 24)}`;
  const withoutDigest = {
    ...draft,
    messageId
  };
  return {
    ...withoutDigest,
    envelopeDigestSha256: canonicalDigest(withoutDigest).sha256Hex
  };
}

export function digestAgentMessageEnvelope(envelope: AgentMessageEnvelope): string {
  const { envelopeDigestSha256: _existingDigest, ...withoutDigest } = envelope;
  return canonicalDigest(withoutDigest).sha256Hex;
}

export function assertValidAgentMessageEnvelope(envelope: AgentMessageEnvelope): AgentMessageEnvelope {
  if (envelope.schemaVersion !== "santaclawz-agent-message-envelope/1.0") {
    throw new Error("Unsupported agent message envelope schemaVersion.");
  }
  if (!envelope.messageId || !envelope.threadId || !envelope.sender?.agentId) {
    throw new Error("Agent message envelope requires messageId, threadId, and sender.agentId.");
  }
  const expectedDigest = digestAgentMessageEnvelope(envelope);
  if (envelope.envelopeDigestSha256 !== expectedDigest) {
    throw new Error("Agent message envelope digest does not match canonical payload.");
  }
  if (envelope.payload.mode !== "inline" && !envelope.payload.digestSha256 && !envelope.payload.uri && !envelope.payload.artifactManifestUrl) {
    throw new Error("Non-inline agent message envelopes require a digest, URI, or artifact manifest reference.");
  }
  return envelope;
}

export function publicAgentMessageEnvelopeView(envelope: AgentMessageEnvelope): PublicAgentMessageEnvelopeView {
  const payload: PublicAgentMessageEnvelopeView["payload"] = {
    mode: envelope.payload.mode,
    ...(envelope.payload.mediaType ? { mediaType: envelope.payload.mediaType } : {}),
    ...(envelope.payload.digestSha256 ? { digestSha256: envelope.payload.digestSha256 } : {}),
    ...(envelope.payload.uri && envelope.visibility !== "private" ? { uri: envelope.payload.uri } : {}),
    ...(envelope.payload.artifactManifestUrl && envelope.visibility !== "private" ? { artifactManifestUrl: envelope.payload.artifactManifestUrl } : {}),
    ...(envelope.payload.artifactBundleDigestSha256 ? { artifactBundleDigestSha256: envelope.payload.artifactBundleDigestSha256 } : {}),
    ...(envelope.visibility === "public" && envelope.payload.mode === "inline" && envelope.payload.body ? { body: envelope.payload.body } : {})
  };
  return {
    schemaVersion: "santaclawz-agent-message-envelope-public/1.0",
    messageId: envelope.messageId,
    threadId: envelope.threadId,
    ...(envelope.parentMessageId ? { parentMessageId: envelope.parentMessageId } : {}),
    ...(envelope.channelId ? { channelId: envelope.channelId } : {}),
    ...(envelope.swarmId ? { swarmId: envelope.swarmId } : {}),
    sentAtIso: envelope.sentAtIso,
    kind: envelope.kind,
    visibility: envelope.visibility,
    sender: envelope.sender,
    ...(envelope.recipient ? { recipient: envelope.recipient } : {}),
    ...(envelope.permissionScope ? { permissionScope: envelope.permissionScope } : {}),
    ...(envelope.marketplaceTags ? { marketplaceTags: envelope.marketplaceTags } : {}),
    ...(envelope.protocolLaneTags ? { protocolLaneTags: envelope.protocolLaneTags } : {}),
    ...(envelope.marketplaceIntentTags ? { marketplaceIntentTags: envelope.marketplaceIntentTags } : {}),
    payload,
    zekoAnchor: envelope.zekoAnchor,
    envelopeDigestSha256: envelope.envelopeDigestSha256
  };
}
