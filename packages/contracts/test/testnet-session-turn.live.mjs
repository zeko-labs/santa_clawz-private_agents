import test from "node:test";

import assert from "node:assert/strict";

import { executeLiveSessionTurnFlow } from "../dist/contracts/src/index.js";

test(
  "deployed Zeko kernels accept the first live session-turn flow",
  { timeout: 30 * 60_000 },
  async () => {
    const report = await executeLiveSessionTurnFlow();

    assert.equal(report.reportType, "live-session-turn-flow");
    assert.equal(report.steps.length, 10);
    assert.ok(report.steps.every((step) => typeof step.txHash === "string" && step.txHash.length > 0));
  }
);
