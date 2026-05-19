import {
  Field,
  Permissions,
  SmartContract,
  State,
  UInt64,
  method,
  state
} from "o1js";

import {
  buildDisclosureGrantCommitment,
  buildDisclosureRevocationCommitment
} from "../shared/commitments.js";
import { appendRoot, emptyRoot } from "../shared/root-helpers.js";

export class DisclosureKernel extends SmartContract {
  @state(Field) disclosureRoot = State<Field>();
  @state(Field) revocationRoot = State<Field>();

  events = {
    disclosureGranted: Field,
    disclosureRevoked: Field
  };

  init() {
    super.init();
    const root = emptyRoot();
    this.disclosureRoot.set(root);
    this.revocationRoot.set(root);
    this.account.permissions.set({
      ...Permissions.default(),
      editState: Permissions.proof()
    });
  }

  @method async grantDisclosure(
    disclosureIdHash: Field,
    scopeHash: Field,
    audienceHash: Field,
    legalBasisHash: Field,
    retentionHash: Field,
    expirySlot: UInt64
  ) {
    const current = this.disclosureRoot.getAndRequireEquals();
    const disclosureLeaf = buildDisclosureGrantCommitment(
      disclosureIdHash,
      scopeHash,
      audienceHash,
      legalBasisHash,
      retentionHash,
      expirySlot
    );
    const next = appendRoot(current, disclosureLeaf);
    this.disclosureRoot.set(next);
    this.emitEvent("disclosureGranted", next);
  }

  @method async revokeDisclosure(disclosureIdHash: Field, revocationHash: Field, actorHash: Field) {
    const current = this.revocationRoot.getAndRequireEquals();
    const revocationLeaf = buildDisclosureRevocationCommitment(disclosureIdHash, revocationHash, actorHash);
    const next = appendRoot(current, revocationLeaf);
    this.revocationRoot.set(next);
    this.emitEvent("disclosureRevoked", next);
  }
}
