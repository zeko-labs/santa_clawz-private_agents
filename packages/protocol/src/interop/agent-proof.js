import { canonicalDigest } from "../hashing/digest.js";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isClawzJsonRpcRequest(value) {
    if (!isRecord(value)) {
        return false;
    }
    const id = value.id;
    const method = value.method;
    return (value.jsonrpc === "2.0" &&
        (typeof id === "string" || typeof id === "number" || id === null) &&
        (method === "tools/list" || method === "tools/call"));
}
export function assertClawzJsonRpcRequest(value) {
    if (!isClawzJsonRpcRequest(value)) {
        throw new Error("Invalid ClawZ JSON-RPC request.");
    }
    return value;
}
export function buildOriginProofCommitment(proof) {
    return JSON.parse(canonicalDigest({
        originProofId: proof.originProofId,
        sessionId: proof.sessionId,
        turnId: proof.turnId,
        stepId: proof.stepId,
        host: proof.host,
        method: proof.method,
        requestTemplateHash: proof.requestTemplateHash,
        requestHeaderAllowlistHash: proof.requestHeaderAllowlistHash,
        responseStatus: proof.responseStatus,
        responseHeaderDigest: proof.responseHeaderDigest,
        responseBodyDigest: proof.responseBodyDigest,
        extractedFactDigest: proof.extractedFactDigest,
        selectiveRevealDigest: proof.selectiveRevealDigest ?? null,
        verifierKeyHash: proof.verifierKeyHash,
        verifierSystem: proof.verifierSystem,
        attestedAtIso: proof.attestedAtIso,
        expiresAtIso: proof.expiresAtIso,
        disclosureClass: proof.disclosureClass
    }).stableJson);
}
export function buildOriginProofRoot(originProofs) {
    return canonicalDigest(originProofs.map((proof) => buildOriginProofCommitment(proof)));
}
