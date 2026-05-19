import { Field, MerkleTree, Poseidon } from "o1js";

import { CLAWZ_TREE_HEIGHT } from "./constants.js";

export function emptyRoot(): Field {
  return new MerkleTree(CLAWZ_TREE_HEIGHT).getRoot();
}

export function appendRoot(currentRoot: Field, leaf: Field, ...context: Field[]): Field {
  return Poseidon.hash([currentRoot, leaf, ...context]);
}
