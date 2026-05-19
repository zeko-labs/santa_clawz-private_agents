import test from "node:test";
import assert from "node:assert/strict";

import {
  assertSocialAnchorSigningKeys,
  buildSocialAnchorFeeAttemptPlan,
  estimateSocialAnchorFeeQuote,
  isRetryableSocialAnchorError
} from "../dist/contracts/src/index.js";

test("social anchor fee quote defaults to the standard 0.10 MINA floor", () => {
  const quote = estimateSocialAnchorFeeQuote();

  assert.equal(quote.feeRaw, "100000000");
  assert.equal(quote.fee, "0.1");
  assert.equal(quote.source, "default-floor");
});

test("social anchor fee plan bumps the configured floor across retry attempts", () => {
  const attempts = buildSocialAnchorFeeAttemptPlan("100000000", 4);

  assert.deepEqual(attempts, ["100000000", "125000000", "160000000", "200000000"]);
});

test("social anchor retry classifier catches known nonce and gateway failures", () => {
  assert.equal(isRetryableSocialAnchorError(new Error("Account_nonce_precondition_unsatisfied")), true);
  assert.equal(isRetryableSocialAnchorError(new Error("Gateway Timeout")), true);
  assert.equal(isRetryableSocialAnchorError(new Error("graphql_http_503")), true);
  assert.equal(isRetryableSocialAnchorError(new Error("proof verification failed permanently")), false);
});

test("social anchor signing keys must target a dedicated kernel account", () => {
  assert.doesNotThrow(() =>
    assertSocialAnchorSigningKeys({
      submitterPublicKey: "B62qsubmitter111111111111111111111111111111111111111111111111",
      socialAnchorPublicKey: "B62qanchor111111111111111111111111111111111111111111111111",
      socialAnchorSignerPublicKey: "B62qanchor111111111111111111111111111111111111111111111111"
    })
  );

  assert.throws(
    () =>
      assertSocialAnchorSigningKeys({
        submitterPublicKey: "B62qsubmitter111111111111111111111111111111111111111111111111",
        socialAnchorPublicKey: "B62qanchor111111111111111111111111111111111111111111111111",
        socialAnchorSignerPublicKey: "B62qother1111111111111111111111111111111111111111111111111"
      }),
    /does not match SOCIAL_ANCHOR_PRIVATE_KEY/
  );

  assert.throws(
    () =>
      assertSocialAnchorSigningKeys({
        submitterPublicKey: "B62qsubmitter111111111111111111111111111111111111111111111111",
        socialAnchorPublicKey: "B62qsubmitter111111111111111111111111111111111111111111111111",
        socialAnchorSignerPublicKey: "B62qsubmitter111111111111111111111111111111111111111111111111"
      }),
    /fee submitter/
  );
});
