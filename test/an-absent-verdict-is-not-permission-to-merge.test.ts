import assert from "node:assert/strict";
import { test } from "node:test";

import { decideSweepArm, type OpenPrView } from "../src/lib/sweep.js";

const HEAD = "head-3471";
const TASK = "W1-T3471";

function greenPr(): OpenPrView {
  return {
    prNumber: 3471,
    prUrl: "https://github.com/craigoley/remudero/pull/3471",
    taskId: TASK,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    headSha: HEAD,
    autoMergeArmed: false,
  };
}

function posted(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { step: "review.posted", task_id: TASK, head_sha: HEAD, capped: false, plan_only: false, ...over };
}

test("W1-T3471: a complete ledger union that proves no verdict refuses a green PR instead of arming it", () => {
  const decision = decideSweepArm(greenPr(), [], undefined, () => ({ complete: true, lines: [] }));
  assert.equal(decision.arm, false);
  assert.match(decision.reason, /complete ledger union shows no review\.posted verdict/);
});

test("W1-T3471: a verdict rotated out of the live file is recovered and still arms", () => {
  const decision = decideSweepArm(greenPr(), [], undefined, () => ({ complete: true, lines: [posted()] }));
  assert.equal(decision.arm, true);
  assert.match(decision.reason, /full PASS/);
});

test("W1-T14317: an unavailable or throwing archive lookup refuses the arm and names the unreadable history", () => {
  const unavailable = decideSweepArm(greenPr(), [], undefined, () => ({ complete: false, lines: [] }));
  assert.equal(unavailable.arm, false);
  assert.match(unavailable.reason, /unreadable verdict history/);

  const throwing = decideSweepArm(greenPr(), [], undefined, () => {
    throw new Error("archive unreadable");
  });
  assert.equal(throwing.arm, false);
  assert.match(throwing.reason, /unreadable verdict history \(the history read threw: archive unreadable\)/);
});

test("W1-T3471: a rotated capped verdict still refuses through the existing shared predicate", () => {
  const decision = decideSweepArm(greenPr(), [], undefined, () => ({ complete: true, lines: [posted({ capped: true })] }));
  assert.equal(decision.arm, false);
  assert.match(decision.reason, /CAPPED verdict/);
});
