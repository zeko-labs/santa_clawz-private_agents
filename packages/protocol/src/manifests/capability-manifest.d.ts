import type { ProviderClass, VisibilityClass } from "../privacy/types.js";
import type { RetentionProfile } from "../retention/types.js";
export interface CapabilityManifest {
    capabilityId: string;
    pluginId: string;
    name: string;
    version: string;
    description: string;
    owner: string;
    manifestHash?: string;
    ioSchemaHash: string;
    trustClass: "standard" | "audited" | "high-assurance";
    approvalClass: string;
    spendModel: "flat" | "per-token-band" | "per-minute" | "per-artifact";
    artifactClasses: string[];
    reproducibleBuildHash: string;
    inputVisibilityClass: VisibilityClass;
    outputVisibilityClass: VisibilityClass;
    retentionClass: RetentionProfile;
    providerClass: ProviderClass;
    disclosureClass: "self-only" | "team" | "compliance" | "custom";
    requiresRawContent: boolean;
    supportsRedactedMode: boolean;
    supportsDigestMode: boolean;
}
export declare function assertCapabilityManifest(manifest: CapabilityManifest): CapabilityManifest;
