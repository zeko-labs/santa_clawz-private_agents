import { canonicalDigest, type CanonicalDigest } from "../hashing/digest.js";

export interface CanonicalLeaf<TObject> {
  object: TObject;
  digest: CanonicalDigest;
}

export function buildLeaf<TObject>(object: TObject): CanonicalLeaf<TObject> {
  return {
    object,
    digest: canonicalDigest(object)
  };
}
