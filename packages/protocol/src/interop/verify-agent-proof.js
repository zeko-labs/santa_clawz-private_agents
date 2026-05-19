import { canonicalDigest } from "../hashing/digest.js";
function stripDigest(value) {
    const { claimDigest: _claimDigest, ...rest } = value;
    return rest;
}
function stripBundleDigest(value) {
    const { bundleDigest: _bundleDigest, ...rest } = value;
    return rest;
}
function compareDigest(label, digest, value) {
    const expected = canonicalDigest(value);
    const actual = digest;
    const shaOk = actual?.sha256Hex === expected.sha256Hex;
    const stableOk = actual?.stableJson === expected.stableJson;
    const fieldOk = JSON.stringify(actual?.fieldChunks ?? []) === JSON.stringify(expected.fieldChunks);
    return {
        label,
        ok: shaOk && stableOk && fieldOk,
        ...(expected.sha256Hex ? { expected: expected.sha256Hex } : {}),
        ...(actual?.sha256Hex ? { actual: actual.sha256Hex } : {}),
        note: shaOk && stableOk && fieldOk
            ? "Digest matches stable JSON, SHA-256, and field chunks."
            : "Digest mismatch against canonical stable-JSON encoding."
    };
}
function compareValue(label, expected, actual) {
    const expectedStable = canonicalDigest(expected).stableJson;
    const actualStable = canonicalDigest(actual).stableJson;
    return {
        label,
        ok: expectedStable === actualStable,
        ...(expectedStable ? { expected: expectedStable } : {}),
        ...(actualStable ? { actual: actualStable } : {})
    };
}
function verifyEvidenceDigests(evidence) {
    return evidence.map((item) => compareDigest(`evidence:${item.kind}:${item.id}`, item.digest, item.object));
}
function verifyRepresentation(representation) {
    return [
        compareDigest("representation.claimDigest", representation.claimDigest, stripDigest(representation)),
        compareDigest("representation.manifestDigest", representation.proofCapability.manifestDigest, representation.proofCapability.manifest)
    ];
}
function verifyAuthority(authority) {
    return [compareDigest("authority.claimDigest", authority.claimDigest, stripDigest(authority))];
}
function verifyPayment(payment) {
    return [compareDigest("payment.claimDigest", payment.claimDigest, stripDigest(payment))];
}
function verifyPrivacy(privacy) {
    return [compareDigest("privacy.claimDigest", privacy.claimDigest, stripDigest(privacy))];
}
function findOriginVerifierAnchor(bundle, proof) {
    return bundle.trustAnchors.find((anchor) => anchor.type === "zktls-verifier" &&
        anchor.verificationMaterial.includes(proof.verifierSystem) &&
        anchor.verificationMaterial.includes(proof.verifierKeyHash));
}
function verifyOriginProofs(bundle) {
    const originProofs = bundle.originProofs ?? [];
    if (originProofs.length === 0) {
        return [];
    }
    const evidenceById = new Map(bundle.evidence.filter((item) => item.kind === "origin-proof").map((item) => [item.id, item]));
    const proofById = new Map(originProofs.map((proof) => [proof.originProofId, proof]));
    const checks = [
        compareValue("origin:proofCount=evidenceCount", originProofs.length, bundle.evidence.filter((item) => item.kind === "origin-proof").length)
    ];
    originProofs.forEach((proof) => {
        const evidence = evidenceById.get(proof.originProofId);
        checks.push(compareValue(`origin:${proof.originProofId}:evidenceObject`, proof, evidence?.object ?? null));
        checks.push(compareValue(`origin:${proof.originProofId}:hostAllowed`, true, bundle.authority.allowedExternalHosts.includes(proof.host)));
        checks.push(compareValue(`origin:${proof.originProofId}:trustAnchorPresent`, true, Boolean(findOriginVerifierAnchor(bundle, proof))));
    });
    const receipt = bundle.exampleToolReceipt;
    if (receipt?.originProofRef) {
        const proof = proofById.get(receipt.originProofRef);
        checks.push(compareValue("origin:receipt.originProofRef", true, Boolean(proof)));
        checks.push(compareValue("origin:receipt.originProofDigest", proof ? canonicalDigest(proof).sha256Hex : null, receipt.originProofDigest ?? null));
        checks.push(compareValue("origin:receipt.originVerifierKeyHash", proof?.verifierKeyHash ?? null, receipt.originVerifierKeyHash ?? null));
    }
    return checks;
}
function verifyCrossClaimConsistency(bundle) {
    return [
        compareValue("cross:payment.spendModel=manifest.spendModel", bundle.representation.proofCapability.manifest.spendModel, bundle.payment.spendModel),
        compareValue("cross:privacy.providerClass=manifest.providerClass", bundle.representation.proofCapability.manifest.providerClass, bundle.privacy.providerClass),
        compareValue("cross:privacy.disclosureClass=manifest.disclosureClass", bundle.representation.proofCapability.manifest.disclosureClass, bundle.privacy.disclosureClass),
        compareValue("cross:authority.preset=privacy.preset", bundle.authority.privacyBoundary.preset, bundle.privacy.preset),
        compareValue("cross:authority.proofLevel=privacy.proofLevel", bundle.authority.proofLevel, bundle.privacy.proofLevel),
        compareValue("cross:authority.defaultArtifactVisibility=privacy.defaultArtifactVisibility", bundle.authority.privacyBoundary.defaultArtifactVisibility, bundle.privacy.defaultArtifactVisibility),
        compareValue("cross:privacy.selectedLocationAvailable", true, bundle.privacy.programmablePrivacy.options.some((option) => option.location === bundle.privacy.programmablePrivacy.selectedLocation)),
        compareValue("cross:privacy.singleDefaultSelected", 1, bundle.privacy.programmablePrivacy.options.filter((option) => option.defaultSelected).length),
        compareValue("cross:originProofRootedReceipt", Boolean(bundle.originProofs && bundle.originProofs.length > 0), Boolean(bundle.exampleToolReceipt?.originProofRef))
    ];
}
function verifyDiscoveryConsistency(bundle, discovery) {
    if (!discovery) {
        return [];
    }
    return [
        compareValue("discovery:protocol", discovery.protocol, bundle.protocol),
        compareValue("discovery:serviceId", discovery.serviceId, bundle.serviceId),
        compareValue("discovery:discoveryEndpoint", discovery.endpoints.discovery, bundle.discoveryUrl),
        compareValue("discovery:focusedSessionId", discovery.focusedSessionId, bundle.authority.sessionId),
        compareValue("discovery:network", discovery.network, bundle.network),
        compareValue("discovery:programmablePrivacy", discovery.programmablePrivacy, bundle.privacy.programmablePrivacy),
        compareValue("discovery:capabilityId", discovery.capabilities[0]?.capabilityId ?? null, bundle.representation.proofCapability.capabilityId)
    ];
}
export function summarizeAgentProofBundle(bundle) {
    return {
        represents: {
            serviceId: bundle.representation.serviceId,
            agentId: bundle.representation.agentId,
            principalType: bundle.representation.representedPrincipal.type,
            publicKey: bundle.representation.representedPrincipal.publicKey,
            walletId: bundle.representation.representedPrincipal.walletId,
            tenantId: bundle.representation.representedPrincipal.tenantId,
            workspaceId: bundle.representation.representedPrincipal.workspaceId
        },
        authority: {
            sessionId: bundle.authority.sessionId,
            ...(bundle.authority.turnId ? { turnId: bundle.authority.turnId } : {}),
            trustModeId: bundle.authority.trustModeId,
            proofLevel: bundle.authority.proofLevel,
            allowedActions: bundle.authority.allowedActions,
            allowedExternalHosts: bundle.authority.allowedExternalHosts,
            approvalsRequired: bundle.authority.approvalPolicy.requiredApprovals,
            activePrivacyExceptionCount: bundle.authority.activePrivacyExceptions.length
        },
        payment: {
            settlementAsset: bundle.payment.settlementAsset,
            settlementModel: bundle.payment.settlementModel,
            spendModel: bundle.payment.spendModel,
            payeeKey: bundle.payment.payeeKey,
            sponsoredBudgetMina: bundle.payment.sponsoredBudgetMina,
            sponsoredRemainingMina: bundle.payment.sponsoredRemainingMina
        },
        privacy: {
            preset: bundle.privacy.preset,
            proofLevel: bundle.privacy.proofLevel,
            defaultArtifactVisibility: bundle.privacy.defaultArtifactVisibility,
            disclosureClass: bundle.privacy.disclosureClass,
            retentionProfile: bundle.privacy.retentionPolicy.profile,
            sealedArtifactCount: bundle.privacy.sealedArtifactCount,
            selectedProvingLocation: bundle.privacy.programmablePrivacy.selectedLocation,
            availableProvingLocations: bundle.privacy.programmablePrivacy.options.map((option) => option.location)
        },
        origin: {
            proofCount: bundle.originProofs?.length ?? 0,
            hosts: [...new Set((bundle.originProofs ?? []).map((proof) => proof.host))],
            verifierSystems: [...new Set((bundle.originProofs ?? []).map((proof) => proof.verifierSystem))],
            rootedProofs: (bundle.originProofs ?? []).map((proof) => ({
                originProofId: proof.originProofId,
                host: proof.host,
                verifierSystem: proof.verifierSystem,
                expiresAtIso: proof.expiresAtIso
            }))
        }
    };
}
export function buildProofVerificationResponse(input) {
    return {
        ok: input.report.ok,
        source: input.source,
        summary: {
            protocol: input.bundle.protocol,
            serviceId: input.bundle.serviceId,
            generatedAtIso: input.bundle.generatedAtIso,
            bundleDigestSha256: input.bundle.bundleDigest.sha256Hex
        },
        question: summarizeAgentProofBundle(input.bundle),
        report: input.report,
        ...(input.discovery ? { discovery: input.discovery } : {})
    };
}
export function verifyWitnessPlanCoverage(bundle, witnessPlan) {
    const expected = bundle.trustAnchors
        .filter((anchor) => anchor.type === "zeko-kernel-path")
        .flatMap((anchor) => anchor.verificationMaterial);
    const actual = (witnessPlan.contracts ?? [])
        .map((entry) => `${entry.kernel ?? ""}.${entry.method ?? ""}`)
        .filter((value) => value !== ".");
    const missing = expected.filter((entry) => !actual.includes(entry));
    return {
        ok: missing.length === 0,
        ...(witnessPlan.scenarioId ? { scenarioId: witnessPlan.scenarioId } : {}),
        covered: actual.filter((entry) => expected.includes(entry)),
        missing
    };
}
export function verifyAgentProofBundle(bundle, options) {
    const checks = [
        compareDigest("bundle.bundleDigest", bundle.bundleDigest, stripBundleDigest(bundle)),
        ...verifyRepresentation(bundle.representation),
        ...verifyAuthority(bundle.authority),
        ...verifyPayment(bundle.payment),
        ...verifyPrivacy(bundle.privacy),
        ...verifyOriginProofs(bundle),
        ...verifyEvidenceDigests(bundle.evidence),
        ...verifyCrossClaimConsistency(bundle),
        ...verifyDiscoveryConsistency(bundle, options?.discovery)
    ];
    const witnessPlanCoverage = options?.witnessPlan
        ? verifyWitnessPlanCoverage(bundle, options.witnessPlan)
        : undefined;
    const witnessCheck = witnessPlanCoverage
        ? [
            {
                label: "trustAnchors:witnessPlanCoverage",
                ok: witnessPlanCoverage.ok,
                note: witnessPlanCoverage.ok
                    ? "Witness plan covers every Zeko kernel path claimed in trust anchors."
                    : `Missing witness plan entries: ${witnessPlanCoverage.missing.join(", ")}`
            }
        ]
        : [];
    const allChecks = [...checks, ...witnessCheck];
    return {
        ok: allChecks.every((check) => check.ok),
        serviceId: bundle.serviceId,
        bundleDigestSha256: bundle.bundleDigest.sha256Hex,
        checks: allChecks,
        ...(witnessPlanCoverage ? { witnessPlanCoverage } : {})
    };
}
