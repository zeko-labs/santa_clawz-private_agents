export type VisibilityClass = "raw-content" | "redacted-content" | "metadata-only" | "digest-only" | "sealed-local-only";
export type ArtifactVisibility = "user-visible" | "team-sealed" | "operator-blind" | "compliance-sealed" | "ephemeral";
export type ProviderClass = "sealed-local" | "enterprise-approved-remote" | "zktls-attested-remote" | "redacted-remote" | "digest-only";
export type PrivacyPreset = "convenient" | "private" | "team-sealed" | "verifiable-minimal" | "executive-sealed" | "workspace-private" | "compliance-reviewable" | "zero-retention";
export type PrivacyProvingLocation = "client" | "server" | "sovereign-rollup";
export type PrivacyDataDomain = "user-data" | "application-data" | "enterprise-data";
export type DangerClass = "shell-execution" | "network-egress" | "secret-access" | "plugin-install" | "browser-automation" | "financial-transaction" | "high-cost-model" | "governance-action" | "privacy-exception";
export interface PrivacyMode {
    modeId: string;
    preset: PrivacyPreset;
    operatorVisible: boolean;
    providerVisible: boolean;
    externalHostsAllowed: boolean;
    maxSpendMina: string;
    proofLevel: "signed" | "rooted" | "proof-backed";
    defaultArtifactVisibility: ArtifactVisibility;
    defaultProvingLocation: PrivacyProvingLocation;
    supportedProvingLocations: PrivacyProvingLocation[];
}
export interface ProgrammablePrivacyOption {
    location: PrivacyProvingLocation;
    dataDomain: PrivacyDataDomain;
    description: string;
    defaultSelected: boolean;
    available: boolean;
}
export interface ProgrammablePrivacyPolicy {
    selectedLocation: PrivacyProvingLocation;
    options: ProgrammablePrivacyOption[];
    serverProverConfigured: boolean;
    sovereignRollupConfigured: boolean;
    sovereignRollupStack?: "docker-compose-phala";
    docs: string[];
}
export interface PrivacyException {
    exceptionId: string;
    sessionId: string;
    turnId: string;
    requestorKey: string;
    audience: "operator" | "tenant-admin" | "compliance-reviewer" | "provider";
    reason: string;
    scopeSummary: string;
    expiresAtIso: string;
}
