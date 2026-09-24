// test/a-review-lane-verdict-reaches-the-retro-miners.test.ts — the retro's three review-reading
// miners joined a merged run to its `review.posted` row by run_id. Since 2026-09-13T07:42Z the review
// lane keys that row by ITS OWN run id (`review-PR<n>-<epoch>`), so the join matched nothing: across
// 4,055 later rows the `fully_executed_proof` signal could not fire, no failed-review feedback was
// mined, and no degraded success was seen. The row still carries the PR it judged, which is the join.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  failedReviewFeedbackForRuns,
  mineDegradedSuccess,
  mineProceduralCandidates,
  type LedgerRecord,
  type RunSummary,
} from "../src/lib/retro.js";

const PR = "https://github.com/craigoley/remudero/pull/7069";

function mergedRun(runId: string, prUrl: string | undefined): RunSummary {
  return { runId, taskId: "W1-T4471", type: "implement", startTs: "2026-09-24T20:00:00.000Z", verdict: "merged", costUsd: 1, numTurns: 40, ...(prUrl ? { prUrl } : {}) };
}

function reviewRow(runId: string, fields: Record<string, unknown>): LedgerRecord {
  return { ts: "2026-09-24T20:30:00.000Z", step: "review.posted", run_id: runId, task_id: "W1-T4471", pr_url: PR, ...fields } as LedgerRecord;
}

test("a review posted under the review lane's own run id still marks the merged run fully executed", () => {
  const runs = [mergedRun("W1-T4471-1790281000000", PR)];
  const records = [reviewRow("review-PR7069-1790290216048", { state: "success", proof_exec: ["executed_pass", "executed_pass"] })];
  const [candidate] = mineProceduralCandidates(runs, records, { threshold: 1 });
  assert.deepEqual(candidate?.signals, ["clean_single_strike", "fully_executed_proof"]);
});

test("a failed review posted under the review lane's own run id is mined as feedback", () => {
  const runs = [mergedRun("W1-T4471-1790281000000", PR)];
  const records = [reviewRow("review-PR7069-1790290216048", { state: "failure", unmet_criteria: ["the reader is called from the sweep"], proof_exec: ["executed_fail"] })];
  assert.deepEqual(failedReviewFeedbackForRuns(runs, records).map((f) => f.unmetCriteria), [["the reader is called from the sweep"]]);
});

test("a degraded review posted under the review lane's own run id is mined as a degraded success", () => {
  const runs = [mergedRun("W1-T4471-1790281000000", PR)];
  const records = [reviewRow("review-PR7069-1790290216048", { state: "success", proof_exec: ["keyword_floor"], floor_degraded: true })];
  assert.deepEqual(mineDegradedSuccess(runs, records).map((f) => f.signal), ["zero_executed_dialect"]);
});

test("a run with no PR still joins a review row keyed by its own run id", () => {
  const runs = [mergedRun("W1-T4471-1790281000000", undefined)];
  const records = [{ ...reviewRow("W1-T4471-1790281000000", { state: "success", proof_exec: ["executed_pass"] }), pr_url: undefined } as LedgerRecord];
  const [candidate] = mineProceduralCandidates(runs, records, { threshold: 1 });
  assert.deepEqual(candidate?.signals, ["clean_single_strike", "fully_executed_proof"]);
});
