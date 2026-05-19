import { type CanonicalDigest } from "../hashing/digest.js";
export interface CanonicalLeaf<TObject> {
    object: TObject;
    digest: CanonicalDigest;
}
export declare function buildLeaf<TObject>(object: TObject): CanonicalLeaf<TObject>;
