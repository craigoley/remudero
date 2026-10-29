import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DESIGN_HOLD_MAIN_ADOPTION_FIELD, designHoldMainAdoptionDue, runSweep, type OpenPrView, type SweepDeps, type UpdateBranchOutcome,
} from "#src/lib/sweep.js";

/**
 * PR #13416 sat 39.6 PR-hours at `escalated:none:fix-needs-design-at-this-exact-head-…` until an operator merged main
 * into its head (6b62f0802). The terminal design hold keys on the head, and nothing in the fleet moves a head behind
 * main while it waits — so the person's one act was a merge. These tests pin the fleet doing that merge itself, once.
 */

const TASK = "W1-T13416";
const HEAD = "6b62f08".padEnd(40, "1");
const MAIN = "a".repeat(40);
const NOW = Date.now();
const PR_URL = "https://github.com/o/remudero/pull/13416";
const pr = (over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: 13416, prUrl: PR_URL, taskId: TASK, headSha: HEAD, checksState: "red", reviewState: "pending", unmetCriteria: [],
  priorStrikes: 1, autoMergeArmed: false, lastActivityAt: new Date(NOW).toISOString(),
  ciFailures: [{ name: "ci-shard (1/8)", logTail: "not ok 1 - a test main already fixed" }], ...over,
});

function designRows(): Record<string, unknown>[] {
  const common = { task_id: TASK, head_sha: HEAD, run_id: "DESIGN-ROUND", host: "fixture-host", actor_pid: 777 };
  const round = { ...common, round_id: "DESIGN-ROUND:1", repair_pr_url: PR_URL };
  return [
    { ...round, step: "fix.dispatch", ts: new Date(NOW - 3000).toISOString(), mode: "ci-log" },
    { ...common, step: "fix.needs_design", ts: new Date(NOW - 2000).toISOString(), contract_revision: "contract-A",
      reason: "authoritative fix for this red lives on main, not in this diff" },
    { ...round, step: "fix.done", ts: new Date(NOW - 1000).toISOString(), fix_outcome: "NEEDS_DESIGN", subtype: "success" },
  ];
}

function fixture(rows: Record<string, unknown>[], opts: { behind?: number; outcome?: UpdateBranchOutcome | "throw" } = {}) {
  const state = { escalated: 0, dispatched: 0, refreshed: 0, admissions: 0, refreshedPrs: [] as number[] };
  const deps: SweepDeps = {
    ledgerPath: "/unused/design-hold-main-ledger", runId: "W1-T10608-test", now: () => NOW,
    readLedger: () => rows, readHeadContractRefreshHistory: async () => ({ complete: true, lines: rows }),
    appendLine: (_path, row) => { rows.push(row); },
    fixProgressJudge: async () => ({ verdict: "continue", reason: "the red names one failing test" }),
    readTaskContractRevision: () => "contract-A",
    readMainTip: async () => MAIN,
    behindMainByPr: new Map([[13416, opts.behind ?? 3], [13417, opts.behind ?? 3]]),
    updateBranch: async (p): Promise<UpdateBranchOutcome> => {
      state.refreshed++; state.refreshedPrs.push(p.prNumber);
      if (opts.outcome === "throw") throw new Error("gh unavailable");
      return opts.outcome ?? "updated";
    },
    arm: () => {}, close: () => {},
    escalate: () => { state.escalated++; },
    dispatchFix: () => { state.dispatched++; },
    claimFixAdmission: () => { state.admissions++; return { admitted: true }; },
  };
  return { deps, state };
}

const lastDisposed = (rows: Record<string, unknown>[], prNumber = 13416) =>
  rows.findLast(row => row.step === "sweep.disposed" && row.pr_number === prNumber)!;

describe("test/sweep/fix-lane-escalated-none-fix-needs-design-at-this-exact-head-auth.test.ts", () => {
  test("W1-T10608: fix-lane-escalated-none-fix-needs-design-at-this-exact-head-auth clears without a person", async () => {
    const rows = designRows();
    const f = fixture(rows);
    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 1, "the head behind main takes main, the operator's one act on #13416");
    assert.equal(f.state.escalated, 0, "no person is asked while main is untaken");
    assert.equal(f.state.dispatched, 0, "no fix round runs at the held head");
    assert.equal(f.state.admissions, 0);
    const disposed = lastDisposed(rows);
    assert.equal(disposed.disposition, "blocked-fixable");
    assert.notEqual(disposed.blocker, "escalated");
    assert.equal(disposed.acted, true);
    assert.equal(disposed[DESIGN_HOLD_MAIN_ADOPTION_FIELD], "updated");
    assert.equal(disposed.needs_design_hold, true);
    assert.match(String(disposed.reason), /3 commit\(s\) behind main — taking main into the branch once/);
    assert.match(String(disposed.stand_down_reason), /took main into the branch \(updated\)/);

    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 1, "the adoption is spent once per PR, read back from the disposed line");
    assert.equal(lastDisposed(rows).disposition, "refused-escalate");
    assert.equal(lastDisposed(rows).blocker, "escalated");
  });

  test("a design hold on a head already at main escalates as before, with no refresh", async () => {
    const rows = designRows();
    const f = fixture(rows, { behind: 0 });
    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 0);
    assert.equal(f.state.escalated, 1);
    assert.equal(lastDisposed(rows).disposition, "refused-escalate");
    assert.equal(lastDisposed(rows)[DESIGN_HOLD_MAIN_ADOPTION_FIELD], undefined);
  });

  for (const outcome of ["conflict", "throw"] as const) {
    test(`a ${outcome} refresh spends the adoption and the next pass escalates the design question`, async () => {
      const rows = designRows();
      const f = fixture(rows, { outcome });
      await runSweep([pr()], f.deps);
      assert.equal(f.state.refreshed, 1);
      const disposed = lastDisposed(rows);
      assert.equal(disposed.acted, false);
      const recorded = String(disposed[DESIGN_HOLD_MAIN_ADOPTION_FIELD]);
      if (outcome === "conflict") assert.equal(recorded, "conflict");
      else assert.match(recorded, /^error: Error: gh unavailable$/);
      assert.match(String(disposed.stand_down_reason), /branch refresh .*the next pass escalates the design question/);
      await runSweep([pr()], f.deps);
      assert.equal(f.state.refreshed, 1);
      assert.equal(f.state.escalated, 1);
      assert.equal(lastDisposed(rows).disposition, "refused-escalate");
    });
  }

  test("two held PRs behind main take main one per pass, never fanned out", async () => {
    const second = pr({ prNumber: 13417, prUrl: "https://github.com/o/remudero/pull/13417", taskId: "W1-T13417" });
    const rows = [...designRows(), ...designRows().map(row => ({ ...row, task_id: "W1-T13417",
      ...(row.repair_pr_url === undefined ? {} : { repair_pr_url: second.prUrl }) }))];
    const f = fixture(rows);
    await runSweep([pr(), second], f.deps);
    assert.equal(f.state.refreshed, 1);
    await runSweep([pr(), second], f.deps);
    assert.equal(f.state.refreshed, 2);
    assert.deepEqual([...f.state.refreshedPrs].sort(), [13416, 13417]);
  });

  const refusalCases: Array<{
    reason: string;
    configure: (deps: SweepDeps, rows: Record<string, unknown>[]) => void;
  }> = [
    { reason: "updater-unavailable", configure: (deps) => { delete deps.updateBranch; } },
    { reason: "main-tip-unavailable", configure: (deps) => { deps.readMainTip = async () => undefined; } },
    { reason: "distance-unavailable", configure: (deps) => { deps.behindMainByPr = new Map(); } },
    { reason: "not-behind", configure: (deps) => { deps.behindMainByPr = new Map([[13416, 0]]); } },
    { reason: "already-attempted", configure: (_deps, rows) => {
      rows.push({ step: "sweep.disposed", pr_number: 13416, [DESIGN_HOLD_MAIN_ADOPTION_FIELD]: "conflict" });
    } },
  ];

  for (const scenario of refusalCases) {
    test(`a terminal design hold records the exact main-adoption refusal arm (${scenario.reason})`, async () => {
      const rows = designRows();
      const f = fixture(rows);
      scenario.configure(f.deps, rows);
      await runSweep([pr()], f.deps);
      assert.equal(lastDisposed(rows).design_hold_main_adoption_decision, scenario.reason);
      assert.equal(lastDisposed(rows).disposition, "refused-escalate");
      assert.equal(f.state.refreshed, 0);
      assert.equal(f.state.dispatched, 0);
      assert.equal(f.state.admissions, 0);
      assert.equal(f.state.escalated, 1);
    });
  }

  test("a due main adoption records eligibility separately from its update result", async () => {
    const rows = designRows();
    const f = fixture(rows, { outcome: "conflict" });
    await runSweep([pr()], f.deps);
    assert.equal(lastDisposed(rows).design_hold_main_adoption_decision, "due");
    assert.equal(lastDisposed(rows)[DESIGN_HOLD_MAIN_ADOPTION_FIELD], "conflict");
    assert.equal(f.state.refreshed, 1);
    assert.equal(f.state.dispatched, 0);
  });

  test("an amended contract records that its existing refresh path owns the design handoff", async () => {
    const rows = designRows();
    const f = fixture(rows);
    f.deps.readTaskContractRevision = () => "contract-B";
    await runSweep([pr()], f.deps);
    assert.equal(lastDisposed(rows).design_hold_main_adoption_decision, "contract-amended");
    assert.equal(lastDisposed(rows).disposition, "blocked-fixable");
  });

  test("a second design-held head records the spent main-adoption pass budget", async () => {
    const second = pr({ prNumber: 13417, prUrl: "https://github.com/o/remudero/pull/13417", taskId: "W1-T13417" });
    const rows = [...designRows(), ...designRows().map(row => ({ ...row, task_id: "W1-T13417",
      ...(row.repair_pr_url === undefined ? {} : { repair_pr_url: second.prUrl }) }))];
    const f = fixture(rows);
    await runSweep([pr(), second], f.deps);
    assert.equal(lastDisposed(rows, 13416).design_hold_main_adoption_decision, "due");
    assert.equal(lastDisposed(rows, 13417).design_hold_main_adoption_decision, "pass-budget-spent");
    assert.equal(f.state.refreshed, 1);
    assert.equal(f.state.escalated, 1);
    assert.equal(f.state.dispatched, 0);
  });

  test("the adoption is due only with a main tip, a refresh seam, a positive distance and no prior adoption", () => {
    const view = { prNumber: 13416 };
    assert.equal(designHoldMainAdoptionDue(view, [], 2, MAIN, true), true);
    assert.equal(designHoldMainAdoptionDue(view, [], 2, MAIN, false), false);
    assert.equal(designHoldMainAdoptionDue(view, [], 2, undefined, true), false);
    assert.equal(designHoldMainAdoptionDue(view, [], undefined, MAIN, true), false);
    assert.equal(designHoldMainAdoptionDue(view, [], 0, MAIN, true), false);
    const spent = { step: "sweep.disposed", pr_number: 13416, [DESIGN_HOLD_MAIN_ADOPTION_FIELD]: "updated" };
    assert.equal(designHoldMainAdoptionDue(view, [spent], 2, MAIN, true), false);
    assert.equal(designHoldMainAdoptionDue(view, [{ ...spent, pr_number: 9 }], 2, MAIN, true), true);
    assert.equal(designHoldMainAdoptionDue(view, [{ ...spent, step: "fix.done" }], 2, MAIN, true), true);
  });
});
