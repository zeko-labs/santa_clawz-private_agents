export function assertCapabilityManifest(manifest) {
    if (manifest.requiresRawContent && manifest.supportsDigestMode) {
        throw new Error("Capability cannot require raw content and advertise digest mode.");
    }
    if (!manifest.supportsRedactedMode && manifest.inputVisibilityClass === "redacted-content") {
        throw new Error("Capability declares redacted input visibility without redacted support.");
    }
    return manifest;
}
