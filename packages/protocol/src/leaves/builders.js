import { canonicalDigest } from "../hashing/digest.js";
export function buildLeaf(object) {
    return {
        object,
        digest: canonicalDigest(object)
    };
}
