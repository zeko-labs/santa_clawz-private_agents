import {
  Field,
  Permissions,
  SmartContract,
  State,
  UInt64,
  method,
  state
} from "o1js";

const signaturePermission = (
  Permissions as typeof Permissions & {
    signature?: () => unknown;
  }
).signature;

export class SocialAnchorKernel extends SmartContract {
  @state(Field) latestBatchRoot = State<Field>();
  @state(Field) latestBatchDigest = State<Field>();
  @state(UInt64) anchoredBatchCount = State<UInt64>();

  events = {
    socialBatchAnchored: Field
  };

  init() {
    super.init();
    this.latestBatchRoot.set(Field.fromJSON("0"));
    this.latestBatchDigest.set(Field.fromJSON("0"));
    this.anchoredBatchCount.set(UInt64.from(0));
    this.account.permissions.set({
      ...Permissions.default(),
      editState: signaturePermission ? signaturePermission() : Permissions.proof()
    });
  }

  @method async anchorBatch(batchRoot: Field, batchDigest: Field) {
    (
      this as unknown as {
        self: {
          requireSignature(): void;
        };
      }
    ).self.requireSignature();
    this.latestBatchRoot.set(batchRoot);
    this.latestBatchDigest.set(batchDigest);
    const currentCount = this.anchoredBatchCount.getAndRequireEquals();
    this.anchoredBatchCount.set(currentCount.add(UInt64.from(1)));
    this.emitEvent("socialBatchAnchored", batchRoot);
  }
}
