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
  buildSessionCheckpointCommitment,
  buildSessionCloseCommitment,
  buildSessionCreateCommitment,
  buildSessionKeyRotationCommitment
} from "../shared/commitments.js";
import { appendRoot, emptyRoot } from "../shared/root-helpers.js";

export class SessionKernel extends SmartContract {
  @state(Field) sessionHeaderRoot = State<Field>();
  @state(Field) sessionMemberRoot = State<Field>();
  @state(Field) sessionLeaseRoot = State<Field>();
  @state(Field) sessionCheckpointRoot = State<Field>();
  @state(UInt64) sessionCounter = State<UInt64>();

  events = {
    sessionCreated: Field,
    sessionCheckpointed: Field,
    sessionClosed: Field
  };

  init() {
    super.init();
    const root = emptyRoot();
    this.sessionHeaderRoot.set(root);
    this.sessionMemberRoot.set(root);
    this.sessionLeaseRoot.set(root);
    this.sessionCheckpointRoot.set(root);
    this.sessionCounter.set(UInt64.from(0));
    this.account.permissions.set({
      ...Permissions.default(),
      editState: Permissions.proof()
    });
  }

  @method async createSession(
    sessionIdHash: Field,
    tenantIdHash: Field,
    agentIdHash: Field,
    routingPolicyHash: Field,
    participantRoot: Field,
    keyRefHash: Field,
    channelBindingHash: Field,
    createdAtSlot: UInt64
  ) {
    const sessionHeaderLeaf = buildSessionCreateCommitment(
      sessionIdHash,
      tenantIdHash,
      agentIdHash,
      routingPolicyHash,
      participantRoot,
      keyRefHash,
      channelBindingHash,
      createdAtSlot
    );
    const current = this.sessionHeaderRoot.getAndRequireEquals();
    const next = appendRoot(current, sessionHeaderLeaf);
    this.sessionHeaderRoot.set(next);

    const currentMembers = this.sessionMemberRoot.getAndRequireEquals();
    this.sessionMemberRoot.set(appendRoot(currentMembers, sessionIdHash, participantRoot, keyRefHash));

    const counter = this.sessionCounter.getAndRequireEquals();
    this.sessionCounter.set(counter.add(UInt64.from(1)));
    this.emitEvent("sessionCreated", next);
  }

  @method async rotateSessionKeys(
    sessionIdHash: Field,
    oldKeyRefHash: Field,
    newKeyRefHash: Field,
    rotatedAtSlot: UInt64
  ) {
    const current = this.sessionLeaseRoot.getAndRequireEquals();
    this.sessionLeaseRoot.set(
      appendRoot(current, buildSessionKeyRotationCommitment(sessionIdHash, oldKeyRefHash, newKeyRefHash, rotatedAtSlot))
    );
  }

  @method async checkpointSession(
    sessionIdHash: Field,
    checkpointHash: Field,
    transcriptRoot: Field,
    artifactRoot: Field,
    checkpointSlot: UInt64
  ) {
    const current = this.sessionCheckpointRoot.getAndRequireEquals();
    const next = appendRoot(
      current,
      buildSessionCheckpointCommitment(sessionIdHash, checkpointHash, transcriptRoot, artifactRoot, checkpointSlot)
    );
    this.sessionCheckpointRoot.set(next);
    this.emitEvent("sessionCheckpointed", next);
  }

  @method async closeSession(
    sessionIdHash: Field,
    finalRoot: Field,
    disclosureRoot: Field,
    closedAtSlot: UInt64
  ) {
    const current = this.sessionHeaderRoot.getAndRequireEquals();
    const next = appendRoot(current, buildSessionCloseCommitment(sessionIdHash, finalRoot, disclosureRoot, closedAtSlot));
    this.sessionHeaderRoot.set(next);
    this.emitEvent("sessionClosed", next);
  }
}
