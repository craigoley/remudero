import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyReviewOutcome, reviewReplayLedgerFields, type ReviewReplayInput } from "#src/lib/review-outcome-class.js";
import { deriveReviewReplaySample, parseReviewReplaySample, replayReviewSample, serializeReviewReplaySample } from "#src/lib/review-replay-sample.js";

const ts = new Date().toISOString();
const input = (extra: Partial<ReviewReplayInput> = {}): ReviewReplayInput => ({ stage: "semantic", plan_only: false,
  required_semantic: true, criteria_count: 1, risk_present: true, budget_present: true, untasked: false,
  head_task_resolved: true, own_task_record_missing: false, reviewer_outcome: "success", verdict_lines: ["REVIEW_VERDICT 1: PASS"], ...extra });
const modern = (i = input(), run = "modern"): Record<string, unknown> => ({ ts, step: "review.replay_input", run_id: run,
  ...reviewReplayLedgerFields(i, classifyReviewOutcome(i), { pr_url: "https://github.com/acme/remudero/pull/1",
    head_sha: "e".repeat(40), reviewer_code_sha: "f".repeat(40) }) });
const legacy = (): Record<string, unknown>[] => [
  { ts: new Date(Date.parse(ts) - 1_000).toISOString(), step: "review.reviewer.skipped", run_id: "legacy", reason: "plan-only" },
  { ts: new Date(Date.parse(ts) - 1_000).toISOString(), step: "review.posted", run_id: "legacy", plan_only: true, proof_exec: [{}],
    pr_url: "https://github.com/acme/remudero/pull/2", head_sha: "e".repeat(40), reviewer_code_sha: "f".repeat(40) },
];
const derive = (rows: Record<string, unknown>[]) => deriveReviewReplaySample(rows, { generatorRevision: "fixture" });

test("unattributable legacy outcomes are counted without inventing identity or dropping healthy classes", () => {
  const healthy = [modern(), modern(input({ verdict_lines: [] }), "withheld"),
    modern(input({ stage: "setup", setup_unavailable: true }), "refused")];
  const control = derive(healthy);
  for (const field of ["pr_url", "head_sha", "reviewer_code_sha"]) {
    for (const value of [undefined, "", null, 0]) {
      const old = legacy(); old[1]![field] = value;
      const sample = derive([...old, ...healthy]);
      assert.deepEqual(sample.rows, control.rows);
      assert.deepEqual(sample.header.classes, ["posted", "refused", "withheld"]);
      assert.equal(sample.header.legacy_unattributed, 1);
      assert.equal(parseReviewReplaySample(serializeReviewReplaySample(sample)).header.legacy_unattributed, 1);
      replayReviewSample(sample);
    }
  }
  const old = legacy(); delete old[1]!.reviewer_code_sha;
  old[1]!.reviewer_code_provenance = { codeSha: "f".repeat(40) };
  const retained = derive([...old, ...healthy]);
  assert.equal(retained.rows.length, control.rows.length + 1);
  assert.equal(retained.header.legacy_unattributed, undefined);
});

test("malformed explicit replay inputs and empty or corrupt samples still refuse", () => {
  for (const field of ["pr_url", "head_sha", "reviewer_code_sha"]) {
    const bad = modern(); delete bad[field];
    assert.throws(() => derive([bad, modern(input({ stage: "setup", setup_unavailable: true }), "control")]),
      new RegExp(`invalid review replay row field: ${field}`));
  }
  const corrupt = modern(); corrupt.input_digest = "bad";
  assert.throws(() => derive([corrupt]), /input digest mismatch/);
  const old = legacy(); delete old[1]!.pr_url;
  for (const at of [ts, new Date(Date.parse(ts) + 1_000).toISOString(), "invalid"]) {
    const current = legacy(); delete current[1]!.pr_url; current[1]!.ts = at;
    assert.throws(() => derive([...current, modern()]), /outside the observed pre-recording era/);
  }
  assert.throws(() => derive(old), /outside the observed pre-recording era/);
  assert.throws(() => derive([]), /empty review replay sample/);
  const sample = derive([modern()]);
  sample.header.legacy_unattributed = -1;
  assert.throws(() => serializeReviewReplaySample(sample), /invalid unattributed legacy count/);
});

test("a positively recorded legacy setup refusal remains refused rather than a posted review", () => {
  const old = legacy();
  old[0]!.reason = "head-task-metadata-unavailable";
  old[0]!.missing = ["risk", "budget_usd"];
  old[1]!.plan_only = false;
  old[1]!.reviewer_outcome = "not_attempted";
  const sample = derive([...old, modern()]);
  const refusal = sample.rows.find(row => row.pr_url.endsWith("/2"))!;
  assert.equal(refusal.recorded_class, "refused");
  assert.equal(refusal.input.stage, "setup");
  assert.equal(refusal.input.setup_unavailable, true);
  assert.equal(refusal.input.verdict_lines, "unrecorded");
  replayReviewSample(sample);
});
