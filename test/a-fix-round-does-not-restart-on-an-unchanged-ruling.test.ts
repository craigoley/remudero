import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { priorRoundHold, PRIOR_ROUND_HOLD_FIELD } from "#src/lib/fix-progress-judge.js";
import { runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";

// W1-T13865: 53 fix rounds ($10.56) started at a head whose last round had ruled NEEDS_SCOPE or FLAKE.
const TASK = "W1-T13865";
const HEAD = "b".repeat(40);
const NEW_HEAD = "c".repeat(40);
const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const PR_URL = "https://github.com/o/remudero/pull/13865";
type Row = Record<string, unknown>;

const round = (outcome: string, over: Row = {}): Row[] => [
  { step: "fix.dispatch", task_id: TASK, round_id: "R1", head_sha: HEAD, ts: at(60_000), mode: "ci-log",
    ci_failures: [{ check: "ci-shard (1/8)" }] },
  { step: "fix.done", task_id: TASK, round_id: "R1", head_sha: HEAD, ts: at(30_000), fix_outcome: outcome,
    subtype: "success", ...over },
];
const facts = (over: Partial<Parameters<typeof priorRoundHold>[1]> = {}) =>
  ({ taskId: TASK, headSha: HEAD, contractRevision: "contract-A", checkCompletions: [], ...over });

const pr = (over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: 13865, prUrl: PR_URL, taskId: TASK, headSha: HEAD, checksState: "red", reviewState: "pending",
  unmetCriteria: [], priorStrikes: 1, autoMergeArmed: false, lastActivityAt: at(0),
  ciFailures: [{ name: "ci-shard (1/8)", logTail: "not ok 1 - a flaky timeout", completedAt: at(45_000) }], ...over,
});

function fixture(rows: Row[]) {
  const state = { dispatched: 0, escalated: 0 };
  const deps: SweepDeps = {
    ledgerPath: "/unused/prior-round-hold", runId: "W1-T13865-test", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    readHeadContractRefreshHistory: async () => ({ complete: true, lines: rows }),
    fixProgressJudge: async () => ({ verdict: "continue", reason: "the red names one failing test" }),
    readTaskContractRevision: () => "contract-A",
    arm: () => {}, close: () => {},
    escalate: () => { state.escalated++; },
    dispatchFix: () => { state.dispatched++; },
  };
  return { deps, state };
}
// The no-commit gateway already reran the failed job at this head before the round, so the pass reaches the fix rung.
const rerunDone: Row = { step: "sweep.disposed", task_id: TASK, pr_number: 13865, head_sha: HEAD, ts: at(90_000),
  disposition: "wait", acted: true, no_commit_rerun_attempted: true };
const swept = (rows: Row[]): Row[] => [rerunDone, ...rows];
const lastDisposed = (rows: Row[]) => rows.findLast(row => row.step === "sweep.disposed" && row.pr_number === 13865)!;

describe("test/a-fix-round-does-not-restart-on-an-unchanged-ruling.test.ts", () => {
  test("W1-T13865 criterion 1: a NEEDS_SCOPE round holds its head while no amendment merged and the contract is unchanged", () => {
    const rows = round("NEEDS_SCOPE");
    const hold = priorRoundHold(rows, facts());
    assert.equal(hold?.hold, "NEEDS_SCOPE");
    assert.equal(hold?.since, at(30_000));
    assert.equal(hold?.contractRevision, "contract-A");
    const pending = [...rows, { step: "fix.scope_amendment", task_id: TASK, head_sha: HEAD, outcome: "created",
      amendmentNumber: 900, ts: at(20_000) }];
    assert.equal(priorRoundHold(pending, facts())?.hold, "NEEDS_SCOPE", "a pending amendment has not merged");
    const latched = [...rows, { step: "sweep.disposed", pr_number: 13865, head_sha: HEAD,
      [PRIOR_ROUND_HOLD_FIELD]: "NEEDS_SCOPE", prior_round_hold_since: at(30_000), prior_round_hold_contract_revision: "contract-A" }];
    assert.equal(priorRoundHold(latched, facts())?.hold, "NEEDS_SCOPE");
  });

  test("W1-T13865 criterion 2: a FLAKE round holds its head while no required check has completed since it ended", () => {
    const rows = round("FLAKE");
    const hold = priorRoundHold(rows, facts({ checkCompletions: [{ name: "ci-shard (1/8)", completedAt: at(45_000) }] }));
    assert.equal(hold?.hold, "FLAKE");
    assert.equal(hold?.since, at(30_000));
    assert.equal(priorRoundHold(rows, facts({ checkCompletions: [{ name: "ci-shard (1/8)" }] }))?.hold, "FLAKE",
      "a check with no completion time has not completed");
    assert.equal(priorRoundHold(round("FLAKE", { flake_claim: "requeue_deferred" }), facts())?.hold, "FLAKE");
  });

  test("W1-T13865 criterion 3: a new head, a new red, a merged amendment, a changed contract or another ruling holds nothing", () => {
    assert.equal(priorRoundHold(round("FLAKE"), facts({ headSha: NEW_HEAD })), undefined);
    assert.equal(priorRoundHold(round("NEEDS_SCOPE"), facts({ headSha: NEW_HEAD })), undefined);
    assert.equal(priorRoundHold(round("FLAKE"), facts({ checkCompletions: [{ name: "ci-shard (1/8)", completedAt: at(10_000) }] })),
      undefined, "a check completed red after the FLAKE round");
    assert.equal(priorRoundHold(round("FLAKE", { flake_claim: "refuted" }), facts()), undefined,
      "the round's own rerun already completed red after the FLAKE ruling");
    const merged = [...round("NEEDS_SCOPE"),
      { step: "fix.scope_amendment", task_id: TASK, head_sha: HEAD, outcome: "created", amendmentNumber: 900, ts: at(25_000) },
      { step: "pr.terminal", pr_number: 900, state: "merged", ts: at(5_000) }];
    assert.equal(priorRoundHold(merged, facts()), undefined, "a merged scope amendment after the NEEDS_SCOPE round");
    const mergedBefore = [{ step: "fix.scope_amendment", task_id: TASK, outcome: "created", amendmentNumber: 900, ts: at(90_000) },
      { step: "pr.terminal", pr_number: 900, state: "merged", ts: at(80_000) }, ...round("NEEDS_SCOPE")];
    assert.equal(priorRoundHold(mergedBefore, facts())?.hold, "NEEDS_SCOPE", "an amendment merged before the round answered nothing");
    const latched = [...round("NEEDS_SCOPE"), { step: "sweep.disposed", pr_number: 13865, head_sha: HEAD,
      [PRIOR_ROUND_HOLD_FIELD]: "NEEDS_SCOPE", prior_round_hold_since: at(30_000), prior_round_hold_contract_revision: "contract-A" }];
    assert.equal(priorRoundHold(latched, facts({ contractRevision: "contract-B" })), undefined, "a changed contract");
    for (const outcome of ["FIXED", "NOT_LANDED", "NEEDS_DESIGN"]) {
      assert.equal(priorRoundHold(round(outcome), facts()), undefined, outcome);
    }
    assert.equal(priorRoundHold([...round("FLAKE"), ...round("FIXED").slice(1).map(r => ({ ...r, round_id: "R2", ts: at(1_000) }))],
      facts()), undefined, "the newest round at the head decides");
  });

  test("W1-T13865 criterion 4: the sweep stands the fix rung down on the hold and spawns no fix worker", async () => {
    const rows = swept(round("FLAKE"));
    const f = fixture(rows);
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 0, "no second fix worker at the same head after a FLAKE round");
    const disposed = lastDisposed(rows);
    assert.equal(disposed.acted, false);
    assert.equal(disposed[PRIOR_ROUND_HOLD_FIELD], "FLAKE");
    assert.match(String(disposed.stand_down_reason), /ruled FLAKE .* no required check has completed on this head since/);

    const later = pr({ ciFailures: [{ name: "ci-shard (1/8)", logTail: "not ok 1 - red again", completedAt: at(1_000) }] });
    await runSweep([later], f.deps);
    assert.equal(f.state.dispatched, 1, "a check completed after the round releases the hold");

    const scope = swept(round("NEEDS_SCOPE"));
    const s = fixture(scope);
    await runSweep([pr()], s.deps);
    assert.equal(s.state.dispatched, 0);
    assert.equal(lastDisposed(scope)[PRIOR_ROUND_HOLD_FIELD], "NEEDS_SCOPE");
    assert.equal(lastDisposed(scope).prior_round_hold_contract_revision, "contract-A");
    await runSweep([pr({ headSha: NEW_HEAD })], s.deps);
    assert.equal(s.state.dispatched, 1, "a new head starts a round");
  });

  test("W1-T13865 criterion 4: the existing NEEDS_DESIGN hold is unchanged", async () => {
    const common = { task_id: TASK, head_sha: HEAD, run_id: "DESIGN-ROUND", host: "fixture-host", actor_pid: 777 };
    const designRound = { ...common, round_id: "DESIGN-ROUND:1", repair_pr_url: PR_URL };
    const rows: Row[] = [rerunDone,
      { ...designRound, step: "fix.dispatch", ts: at(60_000), mode: "ci-log" },
      { ...common, step: "fix.needs_design", ts: at(40_000), contract_revision: "contract-A",
        reason: "authoritative fix for this red lives on main, not in this diff" },
      { ...designRound, step: "fix.done", ts: at(30_000), fix_outcome: "NEEDS_DESIGN", subtype: "success" }];
    const f = fixture(rows);
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 0);
    const disposed = lastDisposed(rows);
    assert.equal(disposed.needs_design_hold, true);
    assert.equal(disposed[PRIOR_ROUND_HOLD_FIELD], undefined);
    assert.doesNotMatch(String(disposed.stand_down_reason ?? ""), /ruled (FLAKE|NEEDS_SCOPE)/);
  });
});
