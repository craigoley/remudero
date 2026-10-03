/**
 * W1-T4015: the review-failure corpus folds every failed review into a class, pairs it with a repair only
 * when a LATER review passes on a DIFFERENT head, and splits unmet_criteria by why its proofs did not meet.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { collectWorkerFailureCorpus } from "../src/lib/ci-failure-corpus.js";
import type { LedgerLine } from "../src/lib/ledger.js";

const review = (over: Record<string, unknown>): LedgerLine =>
  ({ step: "review.posted", run_id: "R", task_id: "W1-T1", pr_url: "https://github.com/o/r/pull/1", ...over }) as unknown as LedgerLine;

test("W1-T4015: the corpus reports recovery per failure class", () => {
  const corpus = collectWorkerFailureCorpus([
    review({ ts: "2026-10-01T00:00:00Z", state: "failure", failure_class: "lint", head_sha: "a1" }),
    review({ ts: "2026-10-01T01:00:00Z", state: "success", head_sha: "b2" }),
    review({ ts: "2026-10-01T02:00:00Z", task_id: "W1-T2", pr_url: "https://github.com/o/r/pull/2", state: "failure", failure_class: "lint", head_sha: "c3" }),
    review({ ts: "2026-10-01T03:00:00Z", task_id: "W1-T3", state: "failure", failure_class: "scope", head_sha: "d4" }),
    review({ ts: "2026-10-01T04:00:00Z", task_id: "W1-T3", state: "failure", failure_class: "   " }),
    { step: "fix.dispatch", run_id: "R", task_id: "W1-T1" } as unknown as LedgerLine,
  ]);
  assert.equal(corpus.rowsScanned, 6);
  assert.deepEqual(corpus.classes, [
    { failureClass: "lint", failures: 2, repaired: 1, open: 1, recoveryRate: 0.5 },
    { failureClass: "scope", failures: 1, repaired: 0, open: 1, recoveryRate: 0 },
  ]);
  assert.equal(corpus.pairs[0]!.greenSha, "b2");
  assert.equal(corpus.pairs[0]!.repairedAt, "2026-10-01T01:00:00Z");
});

test("W1-T4015: a repair must land on a new head", () => {
  const corpus = collectWorkerFailureCorpus([
    review({ ts: "2026-10-01T00:00:00Z", state: "failure", failure_class: "lint", head_sha: "a1" }),
    // The same head passing is a re-review, not a repair.
    review({ ts: "2026-10-01T01:00:00Z", state: "success", head_sha: "a1" }),
    // A success with no head, or no time, can repair nothing.
    review({ ts: "2026-10-01T01:30:00Z", state: "success" }),
    review({ ts: "not a time", state: "success", head_sha: "z9" }),
    // A failure with no time or head is counted but can never be paired.
    review({ ts: "garbled", state: "failure", failure_class: "lint" }),
  ]);
  assert.equal(corpus.pairs.length, 2);
  assert.ok(corpus.pairs.every((p) => p.state === "open"), "nothing was repaired on a new head");
  assert.equal(corpus.pairs[1]!.redSha, undefined);
  assert.equal(corpus.pairs[1]!.failedAt, undefined);
  // Ordered by time, so a success logged earlier in the file but later in time still repairs.
  const reordered = collectWorkerFailureCorpus([
    review({ ts: "2026-10-01T05:00:00Z", state: "success", head_sha: "n2" }),
    review({ ts: "2026-10-01T04:00:00Z", state: "failure", failure_class: "lint", head_sha: "n1" }),
  ]);
  assert.equal(reordered.pairs[0]!.state, "repaired");
});

test("W1-T4015: the dominant class is not reported undifferentiated", () => {
  const unmet = (ts: string, extra: Record<string, unknown>) =>
    review({ ts, state: "failure", failure_class: "unmet_criteria", head_sha: `h-${ts}`, ...extra });
  const corpus = collectWorkerFailureCorpus([
    unmet("2026-10-01T00:00:00Z", { decision_verdict: { criteria: [{ met: false, proof_exec: "executed_fail" }, { met: true, proof_exec: "executed_pass" }] } }),
    unmet("2026-10-01T00:01:00Z", { decision_verdict: { criteria: [{ met: false, proof_exec: "not_executable", proof_skip: "no-runner" }, { met: false, holdout: true, proof_exec: "executed_fail" }] } }),
    unmet("2026-10-01T00:02:00Z", { proof_exec: ["executed_stale", "made_up"] }),
    unmet("2026-10-01T00:03:00Z", { proof_exec: "not an array" }),
    unmet("2026-10-01T00:04:00Z", { decision_verdict: { criteria: [] } }),
  ]);
  assert.deepEqual(corpus.classes.map((c) => c.subclass), [
    "executed_fail",
    "executed_stale+unknown",
    "not_executable/no-runner",
    "unknown",
  ]);
  assert.equal(corpus.classes.find((c) => c.subclass === "unknown")!.failures, 2, "no proofs and no outcomes both read unknown");
  assert.ok(corpus.classes.every((c) => c.failureClass === "unmet_criteria"));
});
