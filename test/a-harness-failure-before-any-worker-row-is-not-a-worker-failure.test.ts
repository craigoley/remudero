import assert from "node:assert/strict";
import test from "node:test";
import { buildDispatchValueContext, type DispatchValueContext } from "#src/lib/dispatch-value.js";
import {
  harnessRunErrorBeforeWorker, HARNESS_RUN_ERROR_BEFORE_WORKER, PROOF_COLLECTED_NOTHING, PROOF_INCONCLUSIVE, PUSH_AUTH_REFUSED, streakRefusal,
} from "#src/lib/non-worker-verdict.js";
import { buildLedgerIndex, dispatchesWithoutNewOwnedPr, taskAttributableLifetimeDispatches } from "#src/lib/status.js";
import type { Task } from "#src/lib/plan.js";

type Row = Record<string, unknown>;
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-09T12:00:00Z");
const task = (id: string): Task => ({
  id, title: id, repo: "remudero", depends_on: [], files: ["src/a.ts"], priority: 1,
  type: "implement", verify: "auto", risk: "high", status: "queued", attempts: 0,
});
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

// A measured src-class history, so every open task has a cost and a class score.
const history: Row[] = [];
const baseFiled = new Map<string, number>();
for (let i = 0; i < 12; i++) {
  const id = `W1-T${6000 + i}`;
  baseFiled.set(id, NOW - 3 * DAY);
  history.push({ step: "run.start", task_id: id, run_id: id, task_class: "src", ts: iso(DAY) });
  history.push({ step: "verdict", task_id: id, run_id: id, verdict: i % 2 === 0 ? "merged" : "no_pr", cost_usd: 2, ts: iso(DAY) });
}

const STARTED = task("W1-T6400");
const PEER = task("W1-T6401");
const RUN = `${STARTED.id}-1`;
const REASON = "a harness step failed";
const VERDICT: Row = { step: "verdict", task_id: STARTED.id, run_id: RUN, verdict: "failed", stage: "run.error", reason: REASON, ts: iso(2 * DAY - 3000) };

/** A run whose rows are only run.start, run.error and a failed verdict at stage run.error; `worker` rows sit between. */
function harnessRun(worker: Row[] = []): Row[] {
  return [
    { step: "run.start", task_id: STARTED.id, run_id: RUN, task_class: "src", ts: iso(2 * DAY) },
    ...worker.map((row) => ({ task_id: STARTED.id, run_id: RUN, ts: iso(2 * DAY - 1000), ...row })),
    { step: "run.error", task_id: STARTED.id, run_id: RUN, error: REASON, ts: iso(2 * DAY - 2000) },
    VERDICT,
  ];
}

function strideStarts(extra: Row[]): number {
  const filed = new Map([...baseFiled, [STARTED.id, NOW - 30 * DAY], [PEER.id, NOW - 30 * DAY]]);
  const result = buildDispatchValueContext([STARTED, PEER], [...history, ...extra], new Set([STARTED.id, PEER.id]), NOW, true, "seed", {
    planTreeSha: "tree", filedAtByTaskId: filed,
  });
  assert.equal(result.kind, "ready");
  return (result as { context: DispatchValueContext }).context.costOfDelayInputsByTaskId!.get(STARTED.id)!.starts;
}

/** What each of the three readers counts for the run, with and without a ledger index. */
function counts(rows: Row[]) {
  const index = buildLedgerIndex(rows);
  return {
    stride: strideStarts(rows),
    breaker: dispatchesWithoutNewOwnedPr(rows, STARTED.id),
    breakerIndexed: dispatchesWithoutNewOwnedPr(rows, STARTED.id, index),
    lifetime: taskAttributableLifetimeDispatches(rows, STARTED.id),
    lifetimeIndexed: taskAttributableLifetimeDispatches(rows, STARTED.id, index),
  };
}
const none = { stride: 0, breaker: 0, breakerIndexed: 0, lifetime: 0, lifetimeIndexed: 0 };
const once = { stride: 1, breaker: 1, breakerIndexed: 1, lifetime: 1, lifetimeIndexed: 1 };

test("W1-T14487 criterion 1: a failed run.error verdict on a run that wrote no worker row spends no stride and no breaker strike", () => {
  const rows = harnessRun();
  assert.deepEqual(counts(rows), none);
  assert.equal(streakRefusal(VERDICT, rows), HARNESS_RUN_ERROR_BEFORE_WORKER);
  // The one-argument call still counts the run, as every reader did before.
  assert.equal(streakRefusal(VERDICT), undefined);
});

test("W1-T14487 criterion 2: the same run with one worker row is counted once by all three readers", () => {
  const workerRows: Row[][] = [
    [{ step: "worker.attempt", success: false }],
    [{ step: "implement.done" }],
    [{ step: "worker.assignment" }],
    [{ step: "recon.done" }],
    [{ step: "fix.done" }],
  ];
  for (const worker of workerRows) {
    const rows = harnessRun(worker);
    assert.deepEqual(counts(rows), once, String(worker[0]!.step));
    assert.equal(harnessRunErrorBeforeWorker(VERDICT, rows), false);
  }
});

test("W1-T14487 criterion 3: with no run rows the rule fails closed and the run counts as today", () => {
  assert.equal(harnessRunErrorBeforeWorker(VERDICT, undefined), false);
  assert.equal(streakRefusal(VERDICT), undefined);
  assert.equal(streakRefusal({ ...VERDICT, cause: "run-error" }), undefined);
  // Rows that do not hold the run's start cannot show the run wrote no worker row.
  assert.equal(harnessRunErrorBeforeWorker(VERDICT, []), false);
  assert.equal(harnessRunErrorBeforeWorker(VERDICT, harnessRun().filter((row) => row.step !== "run.start")), false);
  // A verdict that names no run is never excluded.
  const { run_id: _unused, ...unnamed } = VERDICT;
  assert.equal(harnessRunErrorBeforeWorker(unnamed, harnessRun()), false);
  // Another run's worker rows do not count for this run, and this run's rows still decide.
  const otherWorker: Row = { step: "worker.attempt", task_id: STARTED.id, run_id: `${STARTED.id}-0`, ts: iso(3 * DAY) };
  assert.equal(harnessRunErrorBeforeWorker(VERDICT, [otherWorker, ...harnessRun()]), true);
});

test("W1-T14487 criterion 4: invariant:named-exclusions-unchanged", () => {
  const rows = harnessRun();
  const named: Array<[Row, string | undefined]> = [
    [{ verdict: "blocked_containment" }, "blocked_containment"],
    [{ verdict: "blocked_isolation" }, "blocked_isolation"],
    [{ verdict: "blocked_toolchain" }, "blocked_toolchain"],
    [{ verdict: "blocked_transient" }, "blocked_transient"],
    [{ verdict: "task_already_merged" }, "task_already_merged"],
    [{ verdict: "blocked_git_fetch" }, "blocked_git_fetch"],
    [{ verdict: "blocked_inflight" }, "blocked_inflight"],
    [{ verdict: "handed_off" }, "handed_off"],
    [{ verdict: "failed", stage: "managed_checkout.refresh" }, "managed_checkout.refresh"],
    [{ verdict: "failed", stage: "worktree.node_modules" }, "worktree.node_modules"],
    [{ verdict: "failed", stage: "preflight.containment" }, "preflight.containment"],
    [{ verdict: "failed", stage: "preflight.isolation" }, "preflight.isolation"],
    [{ verdict: "no_pr", reason: "restart_checkpoint_failed" }, "restart_checkpoint_failed"],
    [{ verdict: "no_pr", reason: "restart_checkpoint_restore_failed" }, "restart_checkpoint_restore_failed"],
    [{ verdict: "failed", stage: "pr_open.refused", proof_exec: "exec_error" }, PROOF_INCONCLUSIVE],
    [{ verdict: "failed", stage: "pr_open.refused", refusal_class: "proof-collected-nothing" }, PROOF_COLLECTED_NOTHING],
    [{ verdict: "failed", stage: "run.error", cause: "push-auth-refused" }, PUSH_AUTH_REFUSED],
    [{ verdict: "failed", stage: "run.error", cause: "git-push-failed", reason: "remote: Repository not found." }, PUSH_AUTH_REFUSED],
    [{ verdict: "no_pr", reason: "the worker made no change" }, undefined],
    [{ verdict: "merged" }, undefined],
  ];
  for (const [fields, expected] of named) {
    const line = { step: "verdict", task_id: STARTED.id, run_id: RUN, ...fields };
    assert.equal(streakRefusal(line), expected, JSON.stringify(fields));
    assert.equal(streakRefusal(line, rows), expected, `${JSON.stringify(fields)} with run rows`);
  }
  // A failed verdict at any stage other than run.error is never excluded by the new rule.
  for (const stage of ["pr_open.refused", "implement", "recon", "review", "run.timeout", "run.errored", "error", undefined]) {
    const line = { ...VERDICT, stage };
    assert.equal(harnessRunErrorBeforeWorker(line, rows), false, String(stage));
    assert.equal(streakRefusal(line, rows), undefined, String(stage));
  }
  assert.equal(harnessRunErrorBeforeWorker({ ...VERDICT, verdict: "no_pr" }, rows), false);
});
