export type RegistryEventType =
  | "AgentRegistered"
  | "AgentUpdated"
  | "PluginRegistered"
  | "CapabilityRegistered"
  | "CapabilityDisabled"
  | "StakeSlashed";

export type SessionEventType =
  | "SessionCreated"
  | "SessionCheckpointed"
  | "SessionKeysRotated"
  | "SessionClosed";

export type TurnEventType =
  | "LeaseAcquired"
  | "TurnBegan"
  | "MessageBatchCommitted"
  | "ToolBatchCommitted"
  | "OutputCommitted"
  | "TurnFinalized"
  | "TurnAborted";

export type ApprovalEventType =
  | "ApprovalRequested"
  | "ApprovalGranted"
  | "ApprovalDenied"
  | "ApprovalExpired"
  | "ApprovalDelegated"
  | "PrivacyExceptionRequested"
  | "PrivacyExceptionGranted"
  | "PrivacyExceptionExpired";

export type EscrowEventType =
  | "CreditsDeposited"
  | "BudgetReserved"
  | "TurnSettled"
  | "TurnRefunded"
  | "BondSlashed";

export type PrivacyEventType =
  | "TranscriptChunkCommitted"
  | "ArtifactSealed"
  | "DisclosureGranted"
  | "DisclosureRevoked"
  | "RetentionExpired"
  | "KeyMaterialRevoked";

export type ClawzEventType =
  | RegistryEventType
  | SessionEventType
  | TurnEventType
  | ApprovalEventType
  | EscrowEventType
  | PrivacyEventType;

export interface ClawzEvent<TPayload = Record<string, unknown>> {
  id: string;
  type: ClawzEventType;
  occurredAtIso: string;
  payload: TPayload;
}
