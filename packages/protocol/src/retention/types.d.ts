export type RetentionProfile = "ephemeral" | "checkpoint-only" | "standard-enterprise" | "regulated-hold" | "zero-retention";
export interface RetentionPolicy {
    policyId: string;
    profile: RetentionProfile;
    transcriptTtlHours: number;
    artifactTtlHours: number;
    legalHold: boolean;
    deleteWrappedKeysOnExpiry: boolean;
    exportBeforeDelete: boolean;
}
export interface DeletionRecord {
    deletionId: string;
    artifactId: string;
    retentionPolicyId: string;
    scheduledForIso: string;
    deletedAtIso?: string;
    revokedKeyIds: string[];
}
