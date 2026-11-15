// W1-T12513: from 2026-11-12T15:00Z to 2026-11-13T15:07Z every review-replay gardener pass exited 1 with
// "invalid review replay input". Six recorded inputs hold `REVIEW_VERDICT <n>: UNABLE`, which the recorder
// writes since W1-T11428, but the input check accepted only PASS or FAIL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyReviewOutcome, recordedReviewVerdictLines, reviewReplayLedgerFields,
  type ReviewReplayInput } from "#src/lib/review-outcome-class.js";
import { deriveReviewReplaySample, parseReviewReplaySample, replayReviewSample,
  serializeReviewReplaySample } from "#src/lib/review-replay-sample.js";

const ts = "2026-11-06T09:40:56.000Z";
const input = (extra: Partial<ReviewReplayInput> = {}): ReviewReplayInput => ({ stage: "semantic", plan_only: false,
  required_semantic: true, criteria_count: 2, risk_present: true, budget_present: true, untasked: false,
  head_task_resolved: true, own_task_record_missing: false, reviewer_outcome: "success",
  verdict_lines: ["REVIEW_VERDICT 1: PASS"], ...extra });
const recorded = (run: string, i: ReviewReplayInput): Record<string, unknown> => ({ ts, step: "review.replay_input",
  run_id: run, ...reviewReplayLedgerFields(i, classifyReviewOutcome(i), {
    pr_url: `https://github.com/acme/remudero/pull/${run.length}`, head_sha: "e".repeat(40),
    reviewer_code_sha: "f".repeat(40) }) });
const derive = (rows: Record<string, unknown>[]) => deriveReviewReplaySample(rows, { generatorRevision: "fixture" });
const healthy = recorded("healthy", input());

test("W1-T12513 criterion 1: a recorded UNABLE verdict line derives into the sample, keeps its class and replays to it", () => {
  const unable = input({ verdict_lines: ["REVIEW_VERDICT 1: UNABLE", "REVIEW_VERDICT 2: UNABLE"] });
  const row = recorded("pull-17025", unable);
  const sample = derive([healthy, row]);
  const kept = sample.rows.find(r => r.input_digest === row.input_digest);
  assert.ok(kept, "the UNABLE row is in the sample");
  assert.equal(kept.recorded_class, row.recorded_class);
  assert.deepEqual(kept.input.verdict_lines, unable.verdict_lines);
  replayReviewSample(sample);
  replayReviewSample(parseReviewReplaySample(serializeReviewReplaySample(sample)));
});

test("W1-T12513 criterion 2: another token, a line over 128 characters or too many lines still refuses", () => {
  const long = `REVIEW_VERDICT 1${" ".repeat(120)}: UNABLE`;
  assert.ok(long.length > 128, "control: the long line is over the limit");
  const bad: ReviewReplayInput["verdict_lines"][] = [["REVIEW_VERDICT 1: MAYBE"], ["REVIEW_VERDICT 1: UNABLED"],
    ["REVIEW_VERDICT 1: UNABLE because"], [long], Array.from({ length: 5 }, () => "REVIEW_VERDICT 1: UNABLE")];
  for (const verdict_lines of bad) {
    assert.throws(() => derive([healthy, recorded("bad", input({ verdict_lines }))]),
      /invalid review replay input/, JSON.stringify(verdict_lines).slice(0, 60));
  }
});

test("W1-T12513 criterion 3: the lines the recorder writes for PASS, FAIL and UNABLE derive with no error", () => {
  const transcript = ["Notes first.", "REVIEW_VERDICT 1: PASS", "REVIEW_VERDICT 2: FAIL - the proof is stale",
    "REVIEW_VERDICT 3: UNABLE (no access)", "review_verdict 3: unable"].join("\n");
  const lines = recordedReviewVerdictLines(transcript, 3);
  assert.deepEqual(lines.map(line => line.split(":")[1]!.trim().toUpperCase()), ["PASS", "FAIL", "UNABLE"]);
  const sample = derive([healthy, recorded("recorder", input({ criteria_count: 3, verdict_lines: lines }))]);
  assert.equal(sample.rows.length, 2);
  replayReviewSample(sample);
});
