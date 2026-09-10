import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  buildGather,
  failedReviewFeedbackForRuns,
  gatherRuns,
  mineFailedReviewReasonCandidates,
  parseLedger,
  renderFailedReviewFeedback,
  renderGather,
} from "../src/lib/retro.js";

const FAILED_REVIEW_LEDGER = [
  `{"ts":"2026-09-01T00:00:00.000Z","run_id":"FR1","task_id":"W1-T900","step":"run.start","type":"implement"}`,
  `{"ts":"2026-09-01T00:01:00.000Z","run_id":"FR1","task_id":"W1-T900","step":"review.posted","state":"failure","unmet_criteria":["the UI renders the saved state"],"reasons":["proof did not name the saved-state behaviour","test theater: added tests assert nothing"],"proof_exec":["executed_fail"]}`,
  `{"ts":"2026-09-02T00:00:00.000Z","run_id":"FR2","task_id":"W1-T901","step":"run.start","type":"implement"}`,
  `{"ts":"2026-09-02T00:01:00.000Z","run_id":"FR2","task_id":"W1-T901","step":"review.posted","state":"failure","unmet_criteria":["the API rejects stale writes"],"reasons":["test theater: added tests assert nothing"],"proof_exec":["executed_fail"]}`,
  `{"ts":"2026-09-03T00:00:00.000Z","run_id":"FR3","task_id":"W1-T902","step":"run.start","type":"implement"}`,
  `{"ts":"2026-09-03T00:01:00.000Z","run_id":"FR3","task_id":"W1-T902","step":"review.posted","state":"failure","unmet_criteria":["the CLI prints the refusal"],"reasons":["proof never exercised the refusal path"],"proof_exec":["not_executable"]}`,
].join("\n");

test("W1-T2928: the gather carries a failed review's unmet reasons", () => {
  const records = parseLedger(FAILED_REVIEW_LEDGER);
  const feedback = failedReviewFeedbackForRuns(gatherRuns(records), records);
  const first = feedback.find((f) => f.taskId === "W1-T900");
  assert.ok(first, "the failed review row must survive the gather projection");
  assert.deepEqual(first!.unmetCriteria, ["the UI renders the saved state"]);
  assert.deepEqual(first!.reasons, ["proof did not name the saved-state behaviour", "test theater: added tests assert nothing"]);

  const gather = buildGather({ ledgerNdjson: FAILED_REVIEW_LEDGER, learningsMd: "# Learnings\n" });
  assert.deepEqual(gather.failedReviewFeedback, feedback);
});

test("W1-T2928: recurrence across tasks earns a candidate and a one-off does not", () => {
  const records = parseLedger(FAILED_REVIEW_LEDGER);
  const candidates = mineFailedReviewReasonCandidates(gatherRuns(records), records);
  assert.equal(candidates.length, 1);
  const candidate = candidates[0]!;
  assert.equal(candidate.reason, "test theater: added tests assert nothing");
  assert.equal(candidate.supportingTasks, 2);
  assert.deepEqual(candidate.taskIds, ["W1-T900", "W1-T901"]);
  assert.equal(candidate.occurrences, 2);
  assert.ok(!candidate.evidence.some((e) => e.taskId === "W1-T902"), "the one-off free-text reason never becomes a candidate");

  const rendered = renderFailedReviewFeedback(candidates);
  assert.match(rendered, /recurring reasons proposed for Architect learning ratification/);
  assert.match(rendered, /test theater: added tests assert nothing/);
  assert.doesNotMatch(rendered, /proof never exercised the refusal path/);
});

test("W1-T2928: the retro proposes a candidate and never writes the corpus", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}review-feedback-learning-loop-`));
  const learningsDir = join(root, "learnings");
  const shard = join(learningsDir, "existing.yaml");
  const original = "- id: existing\n  fact: existing learning\n  lifecycle: active\n";
  mkdirSync(learningsDir, { recursive: true });
  writeFileSync(shard, original);

  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    const gather = buildGather({ ledgerNdjson: FAILED_REVIEW_LEDGER, learningsMd: readFileSync(shard, "utf8") });
    assert.equal(gather.failedReviewCandidates.length, 1);
    assert.equal(readFileSync(shard, "utf8"), original, "gather/render must not mutate a learnings shard");
    const rendered = renderGather(gather);
    assert.match(rendered, /Failed-review feedback mining/);
    assert.match(rendered, /proposed for Architect learning ratification/);
    assert.equal(readFileSync(shard, "utf8"), original, "rendering the candidate must still be read-only");
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
});
