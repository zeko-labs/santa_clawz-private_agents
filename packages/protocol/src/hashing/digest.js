import { createHash } from "node:crypto";
import { stableJsonStringify } from "../serialization/stable-json.js";
export function sha256Hex(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}
export function fieldChunksFromHex(hex, bytesPerField = 31) {
    const chunkWidth = bytesPerField * 2;
    const chunks = [];
    for (let offset = 0; offset < hex.length; offset += chunkWidth) {
        const slice = hex.slice(offset, offset + chunkWidth);
        if (!slice) {
            continue;
        }
        chunks.push(BigInt(`0x${slice}`).toString(10));
    }
    return chunks;
}
export function canonicalDigest(value) {
    const stableJson = stableJsonStringify(value);
    const digest = sha256Hex(stableJson);
    return {
        stableJson,
        sha256Hex: digest,
        fieldChunks: fieldChunksFromHex(digest)
    };
}
