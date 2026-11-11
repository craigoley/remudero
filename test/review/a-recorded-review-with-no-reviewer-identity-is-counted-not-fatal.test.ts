// W1-T12026: the review-replay gardener failed its pass on 2026-11-10 with "invalid review replay row field:
// reviewer_code_sha". The row was a 2026-11-03 review.replay_input whose recorder wrote reviewer_code_sha: null,
// which is what review.ts writes when it cannot name the reviewer's code. One such row failed every later pass.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyReviewOutcome, reviewReplayLedgerFields, type ReviewReplayInput } from "#src/lib/review-outcome-class.js";
import { deriveReviewReplaySample, parseReviewReplaySample, replayReviewSample, serializeReviewReplaySample } from "#src/lib/review-replay-sample.js";

const ts = "2026-11-10T08:00:00.000Z";
const input = (extra: Partial<ReviewReplayInput> = {}): ReviewReplayInput => ({ stage: "semantic", plan_only: false,
  required_semantic: true, criteria_count: 1, risk_present: true, budget_present: true, untasked: false,
  head_task_resolved: true, own_task_record_missing: false, reviewer_outcome: "success", verdict_lines: ["REVIEW_VERDICT 1: PASS"], ...extra });
const recorded = (run: string, sha: string | null, i = input()): Record<string, unknown> => ({ ts, step: "review.replay_input", run_id: run,
  ...reviewReplayLedgerFields(i, classifyReviewOutcome(i), { pr_url: `https://github.com/acme/remudero/pull/${run.length}`,
    head_sha: "e".repeat(40), reviewer_code_sha: sha }) });
const derive = (rows: Record<string, unknown>[]) => deriveReviewReplaySample(rows, { generatorRevision: "fixture" });
const healthy = [recorded("posted", "f".repeat(40)), recorded("withheld-run", "f".repeat(40), input({ verdict_lines: [] }))];

test("W1-T12026 criterion 1: a recorded input whose reviewer code sha is an explicit null is counted and left out, and the pass still derives its sample", () => {
  const control = derive(healthy);
  const unknown = recorded("unknown-reviewer", null, input({ stage: "setup", setup_unavailable: true }));
  assert.equal(unknown.reviewer_code_sha, null, "control: the recorder writes the null this test is about");
  const sample = derive([unknown, ...healthy, { ...unknown, run_id: "unknown-reviewer-2" }]);
  assert.deepEqual(sample.rows, control.rows, "no row is invented for an unknown reviewer");
  assert.deepEqual(sample.header.classes, control.header.classes, "its class is not claimed as observed");
  assert.equal(sample.header.recorded_unattributed, 2);
  assert.equal(control.header.recorded_unattributed, undefined, "a sample with none carries no count");
  replayReviewSample(sample);
});

test("W1-T12026 criterion 2: a row whose field is absent or malformed still refuses, and a sample of only unknown reviewers is still empty", () => {
  for (const value of [undefined, "", 0]) {
    const bad = recorded("bad", "f".repeat(40));
    if (value === undefined) delete bad.reviewer_code_sha;
    else bad.reviewer_code_sha = value;
    assert.throws(() => derive([bad, ...healthy]), /invalid review replay row field: reviewer_code_sha/, String(value));
  }
  assert.throws(() => derive([recorded("only", null)]), /empty review replay sample/);
});

test("W1-T12026 criterion 3: the count survives serialize and parse, and a corrupt count refuses", () => {
  const sample = derive([recorded("unknown-reviewer", null), ...healthy]);
  assert.equal(parseReviewReplaySample(serializeReviewReplaySample(sample)).header.recorded_unattributed, 1);
  sample.header.recorded_unattributed = -1;
  assert.throws(() => serializeReviewReplaySample(sample), /invalid unattributed recorded count/);
});
