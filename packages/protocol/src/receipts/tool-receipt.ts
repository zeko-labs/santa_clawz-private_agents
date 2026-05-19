export interface ToolReceipt {
  turnId: string;
  stepId: string;
  capabilityId: string;
  pluginManifestHash: string;
  policyHash: string;
  approvalRef: string;
  inputDigest: string;
  outputDigest: string;
  statusCode: number;
  startedAtIso: string;
  endedAtIso: string;
  privacyModeHash: string;
  retentionPolicyHash: string;
  providerRoutingHash: string;
  originProofRef?: string;
  originProofDigest?: string;
  originVerifierKeyHash?: string;
}

export interface OutputCommitment {
  turnId: string;
  assistantMessageHash: string;
  artifactRoot: string;
  originProofRoot: string;
  citationRoot: string;
  moderationRoot: string;
  encryptionKeyRefHash: string;
  visibilityClassHash: string;
  retentionClassHash: string;
  completedAtIso: string;
}
