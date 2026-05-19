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
  buildApprovalDecisionCommitment,
  buildApprovalDelegationCommitment,
  buildApprovalRequestCommitment,
  buildPrivacyExceptionCommitment
} from "../shared/commitments.js";
import { appendRoot, emptyRoot } from "../shared/root-helpers.js";

export class ApprovalKernel extends SmartContract {
  @state(Field) approvalRequestRoot = State<Field>();
  @state(Field) approvalDecisionRoot = State<Field>();
  @state(Field) delegationRoot = State<Field>();
  @state(Field) privacyExceptionRoot = State<Field>();

  events = {
    approvalRequested: Field,
    approvalGranted: Field,
    privacyExceptionRequested: Field
  };

  init() {
    super.init();
    const root = emptyRoot();
    this.approvalRequestRoot.set(root);
    this.approvalDecisionRoot.set(root);
    this.delegationRoot.set(root);
    this.privacyExceptionRoot.set(root);
    this.account.permissions.set({
      ...Permissions.default(),
      editState: Permissions.proof()
    });
  }

  @method async requestApproval(approvalIdHash: Field, policyHash: Field, scopeHash: Field, expirySlot: UInt64) {
    const current = this.approvalRequestRoot.getAndRequireEquals();
    const approvalLeaf = buildApprovalRequestCommitment(approvalIdHash, policyHash, scopeHash, expirySlot);
    const next = appendRoot(current, approvalLeaf);
    this.approvalRequestRoot.set(next);
    this.emitEvent("approvalRequested", next);
  }

  @method async grantApproval(
    requestLeaf: Field,
    decisionHash: Field,
    committeeDigest: Field,
    observedApprovals: UInt64,
    threshold: UInt64
  ) {
    observedApprovals.assertGreaterThanOrEqual(threshold);
    const current = this.approvalDecisionRoot.getAndRequireEquals();
    const decisionLeaf = buildApprovalDecisionCommitment(
      requestLeaf,
      decisionHash,
      committeeDigest,
      observedApprovals,
      threshold
    );
    const next = appendRoot(current, decisionLeaf);
    this.approvalDecisionRoot.set(next);
    this.emitEvent("approvalGranted", next);
  }

  @method async delegateApproval(
    delegatorHash: Field,
    delegateeHash: Field,
    scopeHash: Field,
    expirySlot: UInt64
  ) {
    const current = this.delegationRoot.getAndRequireEquals();
    const delegateLeaf = buildApprovalDelegationCommitment(delegatorHash, delegateeHash, scopeHash, expirySlot);
    this.delegationRoot.set(appendRoot(current, delegateLeaf));
  }

  @method async requestPrivacyException(
    exceptionIdHash: Field,
    scopeHash: Field,
    audienceHash: Field,
    severityHash: Field,
    expirySlot: UInt64
  ) {
    const current = this.privacyExceptionRoot.getAndRequireEquals();
    const exceptionLeaf = buildPrivacyExceptionCommitment(
      exceptionIdHash,
      scopeHash,
      audienceHash,
      severityHash,
      expirySlot
    );
    const next = appendRoot(current, exceptionLeaf);
    this.privacyExceptionRoot.set(next);
    this.emitEvent("privacyExceptionRequested", next);
  }
}
