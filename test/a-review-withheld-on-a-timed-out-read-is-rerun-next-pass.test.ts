import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewLedgerKeyFor } from "../src/lib/review.js";
import { withheldReviewRefusalRow } from "../src/run-task.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";

const MIN = 60_000;
const NOW = Date.parse("2026-10-16T16:57:00Z");
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * MIN).toISOString();
const PR_URL = "https://github.com/acme/remudero/pull/12362";
const HEAD = "5a3c0de91";
const DIGEST = "sha256:digest-of-the-exact-review-input";
const TASK = "W1-T9845";
const LEDGER_TASK = reviewLedgerKeyFor(TASK, 12362);
const TIMED_OUT = [{ id: TASK, reason: "base-unreadable: git cat-file timed out after 120000ms and was killed" }];
const FETCH_FAILED = [{ id: TASK, reason: "ls-remote failed: could not read from remote" }];

const withheld = (minutesAgo: number, unknown: { id: string; reason: string }[], digest: string | undefined = DIGEST): Record<string, unknown> => ({
  ts: at(minutesAgo), task_id: LEDGER_TASK, step: "review.post_refused",
  head_sha: HEAD, pr_url: PR_URL,
  reason: `id ${TASK} reservation unreadable (UNKNOWN): base read timed out — verdict withheld`,
  unknown_reservations: unknown, ...(digest !== undefined ? { review_input_digest: digest } : {}),
});

const openPr = (): OpenPrView => ({
  prNumber: 12362, prUrl: PR_URL, taskId: TASK, headSha: HEAD, headRefName: `run-${TASK}-1`,
  checksState: "green", reviewState: "pending", reviewPendingSince: at(13), reviewInputDigest: DIGEST,
  unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, lastActivityAt: at(13), ciFailures: [],
});

function harness(rows: Record<string, unknown>[]): { rows: Record<string, unknown>[]; effects: string[]; deps: SweepDeps } {
  const effects: string[] = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused/timed-out-read-ledger", runId: "timed-out-read", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    dispatchFix: () => { effects.push("body"); },
    dispatchPlanOnlyRepair: () => { effects.push("plan"); return true; },
    postReview: (pr) => { effects.push(`review:${pr.prNumber}`); },
    arm: () => { effects.push("arm"); return "armed"; },
    escalate: (_pr, reason) => { effects.push(`escalate:${reason}`); },
    close: () => { effects.push("close"); },
  };
  return { rows, effects, deps };
}

test("W1-T9907: a review withheld on a timed-out base read is re-run on the next pass", async () => {
  // #12362's shape: pending posted 13m ago, the review withheld on a base-read timeout 9m ago.
  const h = harness([withheld(9, TIMED_OUT)]);
  const result = await runSweep([openPr()], h.deps);
  const action = result.actions[0]!;
  assert.equal(action.disposition, "post-review");
  assert.equal(action.acted, true);
  assert.doesNotMatch(action.reason, /already in flight/);
  assert.deepEqual(h.effects, ["review:12362"]);

  // The baseline read arm is the same class.
  const baseline = harness([withheld(9, [{ id: TASK, reason: "baseline-unreadable: git cat-file timed out" }])]);
  const again = await runSweep([openPr()], baseline.deps);
  assert.equal(again.actions[0]!.disposition, "post-review");
  assert.deepEqual(baseline.effects, ["review:12362"]);

  // A withhold older than the current pending post answers an earlier review, so the owner is not proven dead.
  const older = harness([withheld(20, TIMED_OUT)]);
  const stillWaiting = await runSweep([openPr()], older.deps);
  assert.equal(stillWaiting.actions[0]!.disposition, "wait");
  assert.deepEqual(older.effects, []);
});

test("W1-T9907: the withheld review row carries the review input digest", () => {
  const row = withheldReviewRefusalRow({
    headSha: HEAD, prUrl: PR_URL, reason: "withheld", inputDigest: DIGEST,
    ownership: [{ id: TASK, kind: "unknown", reason: TIMED_OUT[0]!.reason }] as never,
  });
  assert.equal(row.review_input_digest, DIGEST);
  assert.equal(row.head_sha, HEAD);
  assert.equal(row.pr_url, PR_URL);
  assert.deepEqual(row.unknown_reservations, TIMED_OUT);
  const undigested = withheldReviewRefusalRow({ headSha: HEAD, prUrl: PR_URL, reason: "withheld", inputDigest: undefined, ownership: [] });
  assert.equal("review_input_digest" in undigested, false);
});

test("W1-T9907: a review withheld on a failed reservation fetch still waits as before", async () => {
  const h = harness([withheld(9, FETCH_FAILED)]);
  const result = await runSweep([openPr()], h.deps);
  assert.equal(result.actions[0]!.disposition, "wait");
  assert.match(result.actions[0]!.reason, /already in flight/);
  assert.deepEqual(h.effects, []);

  // One timed-out read among other reasons is not a pure timed-out read.
  const mixed = harness([withheld(9, [...TIMED_OUT, ...FETCH_FAILED])]);
  const mixedResult = await runSweep([openPr()], mixed.deps);
  assert.equal(mixedResult.actions[0]!.disposition, "wait");
  assert.deepEqual(mixed.effects, []);
});

test("W1-T9907: repeated timed-out withholds on one input escalate at the strike cap", async () => {
  const cap = DEFAULT_SWEEP_POLICY.strikeCap;
  const rows = Array.from({ length: cap + 1 }, (_, i) => withheld(9 - i * 0.1, TIMED_OUT));
  const h = harness(rows);
  const result = await runSweep([openPr()], h.deps);
  const action = result.actions[0]!;
  assert.equal(action.disposition, "blocked-ambiguous");
  assert.match(action.reason, new RegExp(`exceeding the ${cap}-strike retry cap`));
  assert.deepEqual(h.effects.filter((effect) => effect.startsWith("review:")), []);

  // At the cap itself the review is still re-run.
  const atCap = harness(Array.from({ length: cap }, (_, i) => withheld(9 - i * 0.1, TIMED_OUT)));
  const retried = await runSweep([openPr()], atCap.deps);
  assert.equal(retried.actions[0]!.disposition, "post-review");
});
