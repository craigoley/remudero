import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { priorRoundHold, PRIOR_ROUND_HOLD_FIELD, type FixProgressInput } from "#src/lib/fix-progress-judge.js";
import { buildFixProgressInput, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";

// W1-T14201: a FLAKE round whose rerun came back red (refuted), or that repeated a refuted claim, held its head
// forever: the rerun's red completed before fix.done was written, and the spent requeue key brings no new completion.
const TASK = "W1-T14201";
const OTHER_TASK = "W1-T14999";
const HEAD = "d".repeat(40);
const OTHER_HEAD = "e".repeat(40);
const CHECK = "ci-shard (1/8)";
const PR_NUMBER = 14201;
const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
type Row = Record<string, unknown>;

const round = (over: Row = {}, roundId = "R1", doneAgo = 30_000): Row[] => [
  { step: "fix.dispatch", task_id: TASK, round_id: roundId, head_sha: HEAD, ts: at(doneAgo + 30_000), mode: "ci-log",
    ci_failures: [{ check: CHECK }] },
  { step: "fix.done", task_id: TASK, round_id: roundId, head_sha: HEAD, ts: at(doneAgo), fix_outcome: "FLAKE",
    subtype: "success", ...over },
];
const facts = (over: Partial<Parameters<typeof priorRoundHold>[1]> = {}) =>
  ({ taskId: TASK, headSha: HEAD, contractRevision: "contract-A", checkCompletions: [], ...over });
// The rerun's own red completed before fix.done was written, so it dates nothing after the round.
const rerunRed = [{ name: CHECK, completedAt: at(45_000) }];

const pr = (over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: PR_NUMBER, prUrl: `https://github.com/o/remudero/pull/${PR_NUMBER}`, taskId: TASK, headSha: HEAD,
  checksState: "red", reviewState: "pending", unmetCriteria: [], priorStrikes: 1, autoMergeArmed: false,
  lastActivityAt: at(0), ciFailures: [{ name: CHECK, logTail: "not ok 1 - a deterministic failure", jobId: "70",
    completedAt: at(45_000) }], ...over,
});

describe("test/a-refuted-flake-never-holds-its-head.test.ts", () => {
  test("W1-T14201 criterion 1: a refuted or repeated FLAKE ruling at the head never holds it", () => {
    for (const flake_claim of ["refuted", "repeated"]) {
      const rows = round({ flake_claim });
      assert.equal(priorRoundHold(rows, facts({ checkCompletions: undefined })), undefined, `${flake_claim}, no completions`);
      assert.equal(priorRoundHold(rows, facts()), undefined, `${flake_claim}, empty completions`);
      assert.equal(priorRoundHold(rows, facts({ checkCompletions: rerunRed })), undefined,
        `${flake_claim}, only a completion dated before the round`);
    }
  });

  test("W1-T14201 criterion 2: a requeue_deferred, confirmed or unclaimed FLAKE ruling still holds until a newer completion", () => {
    for (const over of [{ flake_claim: "requeue_deferred" }, { flake_claim: "confirmed" }, {}]) {
      const label = String(over.flake_claim ?? "no flake_claim");
      const rows = round(over);
      assert.equal(priorRoundHold(rows, facts())?.hold, "FLAKE", label);
      assert.equal(priorRoundHold(rows, facts({ checkCompletions: rerunRed }))?.hold, "FLAKE", `${label}, older completion`);
      assert.equal(priorRoundHold(rows, facts({ checkCompletions: [{ name: CHECK, completedAt: at(1_000) }] })), undefined,
        `${label}, a completion after the round releases it`);
    }
  });

  test("W1-T14201 criterion 3: a refuted ruling releases only its own head and task, and a newer held ruling holds again", () => {
    const held = round();
    const otherTask = { step: "fix.done", task_id: OTHER_TASK, round_id: "X1", head_sha: HEAD, ts: at(10_000),
      fix_outcome: "FLAKE", flake_claim: "refuted", subtype: "success" };
    assert.equal(priorRoundHold([...held, otherTask], facts())?.hold, "FLAKE", "another task's refutation");
    const otherHead = { ...otherTask, task_id: TASK, round_id: "X2", head_sha: OTHER_HEAD };
    assert.equal(priorRoundHold([...held, otherHead], facts())?.hold, "FLAKE", "a refutation at another head");
    const refutedThenHeld = [...round({ flake_claim: "refuted" }, "R1", 60_000), ...round({ flake_claim: "requeue_deferred" }, "R2")];
    assert.equal(priorRoundHold(refutedThenHeld, facts())?.hold, "FLAKE", "a newer unrefuted FLAKE ruling holds again");
    assert.equal(priorRoundHold(refutedThenHeld, facts())?.roundId, "R2");
    const heldThenRefuted = [...round({}, "R1", 60_000), ...round({ flake_claim: "refuted" }, "R2")];
    assert.equal(priorRoundHold(heldThenRefuted, facts()), undefined, "the newest ruling at the head decides");
  });

  test("W1-T14201 criterion 4: after a refuted FLAKE round with a spent requeue key, the sweep runs one round at the same head", async () => {
    const rows: Row[] = [
      // The no-commit gateway already reran the failed job at this head, so the pass reaches the fix rung.
      { step: "sweep.disposed", task_id: TASK, pr_number: PR_NUMBER, head_sha: HEAD, ts: at(90_000), disposition: "wait",
        acted: true, no_commit_rerun_attempted: true },
      round()[0]!,
      // The FLAKE round's own requeue of the check: key head@check is spent.
      { step: "sweep.check_requeued", task_id: TASK, pr_number: PR_NUMBER, head_sha: HEAD, check_name: CHECK, job_id: "70",
        ts: at(50_000) },
      round({ flake_claim: "refuted" })[1]!,
    ];
    const judged: FixProgressInput[] = [];
    const dispatched: { headSha: string }[] = [];
    let requeued = 0;
    const deps: SweepDeps = {
      ledgerPath: "/unused/refuted-flake-hold", runId: "W1-T14201-test", now: () => NOW,
      readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
      readHeadContractRefreshHistory: async () => ({ complete: true, lines: rows }),
      readRequiredCheckCompletions: async () => rerunRed,
      fixProgressJudge: async input => { judged.push(input); return { verdict: "continue", reason: "the red reproduced" }; },
      readTaskContractRevision: () => "contract-A",
      arm: () => {}, close: () => {}, escalate: () => assert.fail("no escalation"),
      requeueCheck: () => { requeued++; return true; },
      dispatchFix: target => { dispatched.push({ headSha: target.headSha }); },
    };
    await runSweep([pr()], deps);
    assert.deepEqual(dispatched, [{ headSha: HEAD }], "one fix round at the same head");
    assert.equal(requeued, 0, "the spent requeue key is not spent again");
    const disposed = rows.findLast(row => row.step === "sweep.disposed" && row.pr_number === PR_NUMBER)!;
    assert.equal(Object.hasOwn(disposed, PRIOR_ROUND_HOLD_FIELD), false, "no prior_round_hold field");
    assert.equal(judged.length > 0, true, "the progress judge saw the round's input");
    assert.equal(Reflect.get(judged.at(-1)!.signals, "refutedFlakeClaims"), 1);
    const input = buildFixProgressInput({ taskId: TASK, prNumber: PR_NUMBER, headSha: HEAD, currentRed: [CHECK], ledger: rows });
    assert.equal(input.signals.refutedFlakeClaims, 1);
  });
});
