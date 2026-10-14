import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CONTRACT_AMENDED_REFRESH_STEP,
  DEFAULT_SWEEP_POLICY,
  buildSweepEffects,
  runSweep,
  type BuildSweepEffectsDeps,
  type OpenPrView,
  type SweepDeps,
  type UpdateBranchOutcome,
} from "../src/lib/sweep.js";
import { taskContractRevision } from "../src/lib/escalate.js";
import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";

/**
 * remudero-console #2035 (CONSOLE-T99) sat red for 30+ hours. The fix progress judge escalated it
 * ("the pinned core contract lacks the endpoints acceptance needs"), the operator answered by amending
 * the task's plan on main (#2038), and the sweep kept standing down with "this fix progress loop is
 * already escalated; awaiting new evidence or an operator answer": the latch keyed on the head and the
 * round history, and a plan amendment moves neither. These tests pin the release: the latch remembers
 * the contract it stands on, and a different one on main takes main into the branch once.
 */

const TASK = "CONSOLE-T99";
const NOW = Date.now();
const LATCHED = "this fix progress loop is already escalated; awaiting new evidence or an operator answer";
const pr = (over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: 2035, prUrl: "https://github.com/o/console/pull/2035", taskId: TASK,
  headSha: "3dccfbb", checksState: "red", reviewState: "pending", unmetCriteria: [],
  priorStrikes: 0, autoMergeArmed: false, lastActivityAt: new Date(NOW).toISOString(),
  ciFailures: [{ name: "console-ci", logTail: "write-parity: undeclared core read" }], ...over,
});

function fixture(rows: Record<string, unknown>[], outcome: UpdateBranchOutcome = "updated") {
  const state = { revision: "contract-A" as string | undefined, judged: 0, escalated: 0, dispatched: 0, refreshed: 0 };
  const deps: SweepDeps = {
    ledgerPath: "/unused/contract-latch-ledger", runId: "contract-latch-test", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    fixProgressJudge: async () => {
      state.judged++;
      return { verdict: "escalate", loop: "operator scope decision", reason: "the pinned contract lacks the endpoints" };
    },
    readTaskContractRevision: (taskId) => (taskId === TASK ? state.revision : undefined),
    updateBranch: async () => { state.refreshed++; return outcome; },
    arm: () => {}, close: () => {},
    escalate: () => { state.escalated++; },
    dispatchFix: () => { state.dispatched++; },
  };
  return { deps, state };
}

const lastDisposed = (rows: Record<string, unknown>[]) => rows.findLast(row => row.step === "sweep.disposed")!;

describe("test/an-amended-contract-releases-an-escalated-fix-latch.test.ts", () => {
  test("an escalated head whose task contract is amended on main takes main once instead of standing down", async () => {
    const rows: Record<string, unknown>[] = [];
    const f = fixture(rows);

    await runSweep([pr()], f.deps);
    assert.equal(f.state.judged, 1);
    assert.equal(f.state.escalated, 1);
    assert.equal(lastDisposed(rows).progress_contract_revision, "contract-A", "the escalation records the contract it was asked under");

    await runSweep([pr()], f.deps);
    assert.equal(f.state.judged, 1, "an unchanged contract keeps the latch");
    assert.equal(lastDisposed(rows).stand_down_reason, LATCHED);
    assert.equal(f.state.refreshed, 0);

    f.state.revision = "contract-B";
    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 1, "the amended contract takes main into the branch");
    assert.equal(f.state.judged, 1, "the old question is not re-asked on the old head");
    assert.equal(f.state.escalated, 1);
    assert.equal(f.state.dispatched, 0, "no round runs against the old head's contract");
    const disposed = lastDisposed(rows);
    assert.equal(disposed.acted, true);
    assert.match(String(disposed.stand_down_reason), /task contract amended since this head was escalated — took main into the branch \(updated\)/);
    const refresh = rows.findLast(row => row.step === CONTRACT_AMENDED_REFRESH_STEP)!;
    assert.deepEqual([refresh.pr_number, refresh.head_sha, refresh.escalated_under, refresh.contract_revision, refresh.outcome],
      [2035, "3dccfbb", "contract-A", "contract-B", "updated"]);
  });

  test("a latch that predates the record adopts the current contract, then releases on the next amendment", async () => {
    const rows: Record<string, unknown>[] = [];
    const f = fixture(rows);
    await runSweep([pr()], f.deps);
    for (const row of rows) delete row.progress_contract_revision; // the shape every pre-fix escalation row has

    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 0, "an unknown starting contract is never read as an amendment");
    assert.equal(lastDisposed(rows).stand_down_reason, LATCHED);
    assert.equal(lastDisposed(rows).progress_contract_revision, "contract-A");

    f.state.revision = "contract-B";
    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 1);
  });

  test("a refused refresh is named and not retried for the same amended contract", async () => {
    const rows: Record<string, unknown>[] = [];
    const f = fixture(rows, "conflict");
    await runSweep([pr()], f.deps);
    f.state.revision = "contract-B";

    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 1);
    assert.equal(lastDisposed(rows).acted, false);
    assert.match(String(lastDisposed(rows).stand_down_reason), /branch refresh conflict/);

    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 1, "the same amendment is refreshed once per head");
    assert.equal(lastDisposed(rows).stand_down_reason, LATCHED);
  });

  test("a pass without update-branch defers the refresh to the full sweep and keeps the old contract", async () => {
    const rows: Record<string, unknown>[] = [];
    const f = fixture(rows);
    await runSweep([pr()], f.deps);
    f.state.revision = "contract-B";

    await runSweep([pr()], { ...f.deps, updateBranch: undefined });
    assert.match(String(lastDisposed(rows).stand_down_reason), /deferred to full sweep \(update-branch not available on this pass\)/);
    assert.equal(lastDisposed(rows).progress_contract_revision, "contract-A", "the amendment stays pending for the full pass");

    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 1, "the full pass takes it");
  });

  test("a throwing refresh is recorded as an error outcome, never as taken", async () => {
    const rows: Record<string, unknown>[] = [];
    const f = fixture(rows);
    await runSweep([pr()], f.deps);
    f.state.revision = "contract-B";

    await runSweep([pr()], { ...f.deps, updateBranch: async () => { throw new Error("422 merge conflict"); } });
    assert.equal(lastDisposed(rows).acted, false);
    assert.match(String(lastDisposed(rows).stand_down_reason), /branch refresh error: Error: 422 merge conflict/);
    assert.match(String(rows.findLast(row => row.step === CONTRACT_AMENDED_REFRESH_STEP)!.outcome), /^error: /);
  });

  test("production effects read the task contract revision from the pass's plan, re-reading one it lacks", () => {
    const task = (proof: string) => ({ id: TASK, title: "t", files: ["lib/rmd-control.ts"],
      acceptance: [{ claim: "renders core only", proof }] });
    const plan = (...tasks: ReturnType<typeof task>[]) =>
      ({ tasks, byId: new Map(tasks.map(t => [t.id, t])) }) as unknown as Plan;
    let reloads = 0;
    const effects = (passPlan: Plan) => buildSweepEffects({
      owner: "craigoley", repo: "remudero-console", config: { root: "/unused", claudeBin: "/bin/true" } as Config,
      ledgerPath: "/unused/ledger.ndjson", runId: "contract-latch-effects", plan: passPlan, log: () => {},
      policy: DEFAULT_SWEEP_POLICY, reviewRunner: async () => 0,
      issuesImpl: { create: () => "https://github.com/craigoley/remudero-console/issues/1" },
      reloadPlanForFixImpl: () => { reloads++; return plan(task("grep: amended")); },
    } as unknown as BuildSweepEffectsDeps);

    const amendedPass = effects(plan(task("grep: amended")));
    assert.equal(amendedPass.readTaskContractRevision?.(TASK), taskContractRevision(task("grep: amended")));
    assert.notEqual(amendedPass.readTaskContractRevision?.(TASK), taskContractRevision(task("grep: old")));
    assert.equal(reloads, 0, "a task the pass's plan holds is read from it");

    const stalePass = effects(plan());
    assert.equal(stalePass.readTaskContractRevision?.(TASK), taskContractRevision(task("grep: amended")));
    assert.equal(stalePass.readTaskContractRevision?.("CONSOLE-T0"), undefined);
    assert.equal(reloads, 1, "one re-read per cycle serves every missing task");
  });
});
