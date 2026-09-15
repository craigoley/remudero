import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createBoardSnapshotCache,
  EMPTY_TASK_FINGERPRINTS,
  foldTaskFingerprints,
  ledgerTaskOf,
  projectionAgesWithTheClock,
  sameTaskProjectionStamp,
  taskProjectionStamp,
  type BoardDeps,
} from "../src/lib/board.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { PrRef } from "../src/lib/status.js";
import { fakeGitHub, type FakeGitHub } from "./helpers/fake-github.js";

// ── The board pass re-derives what MOVED, not the corpus ─────────────────────────────────────
//
// `projectPlan` re-derived every task on every call, and its board caller runs on the console's
// 3s poll. MEASURED 2026-09-15 on the live daemon: 1,792 tasks, 1.44s a pass warm — while the
// ledger touched 1 distinct task id in a 3s window, 2 in 60s and 17 in 20 minutes. The pass was
// re-deriving 1,792 tasks to reflect a change in one, synchronously, on node's single event-loop
// thread. Same corpus after the per-task memo: ~70ms.
//
// These tests pin the memo in BOTH directions, because a memo that is only fast is a silently
// stale board:
//   - it reuses what cannot have moved (test 1), and
//   - it refuses to reuse a row it cannot speak for: an unattributable ledger row (test 2), an
//     in-flight run, which ages with the clock rather than the ledger (test 3), and any change in
//     the GitHub half, which is shared by every task (test 4).
//
// `prByRef` is the derivation counter throughout — the same idiom test/board.test.ts already uses
// for this cache: every task below carries `pr`, so rung (b) calls it exactly once per task that
// is actually re-derived, and zero times for one that is reused.

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function tmpLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-board-incr-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

function append(ledgerPath: string, row: Record<string, unknown>): void {
  appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
}

/**
 * The derivation counter. W1-T2903's shared gateway records EVERY call, and `prByRef` is rung
 * (b) — every task below carries `pr`, so it fires exactly once per task actually re-derived and
 * zero times for one served from the memo. Counting off `.calls` rather than a closure of my own
 * is also what keeps this file out of `fixture-copy-census`'s fake-GitHub-builder population.
 */
function derivations(github: FakeGitHub): number {
  return github.calls.filter((call) => call.method === "prByRef").length;
}

interface Fixture {
  deps: BoardDeps;
  github: FakeGitHub;
  ledgerPath: string;
  state: { failed: boolean; open: PrRef[] };
}

function threeTasks(): Fixture {
  const ledgerPath = tmpLedgerPath();
  const state = { failed: false, open: [] as PrRef[] };
  const github = fakeGitHub({
    readFailed: () => state.failed,
    listOpenHeadBranches: () => state.open,
  });
  const plan = planOf([
    task({ id: "W1-T1", pr: 1 }),
    task({ id: "W1-T2", pr: 2 }),
    task({ id: "W1-T3", pr: 3 }),
  ]);
  return { deps: { plan, ledgerPath, github }, github, ledgerPath, state };
}

test("a ledger line naming one task re-derives that task alone, not the whole plan", () => {
  const { deps, github, ledgerPath } = threeTasks();
  const cache = createBoardSnapshotCache();

  cache.get(deps);
  assert.equal(derivations(github), 3, "the first pass has nothing to reuse and derives all three");

  append(ledgerPath, { run_id: "r1", task_id: "W1-T2", step: "run.start" });
  cache.get(deps);
  assert.equal(
    derivations(github),
    4,
    "one task moved, so exactly ONE more derivation — restore the whole-plan pass and this reads 6",
  );

  append(ledgerPath, { run_id: "r1", task_id: "W1-T2", step: "verdict", verdict: "pass" });
  cache.get(deps);
  assert.equal(derivations(github), 5, "and again: the two untouched tasks are never re-derived");
});

test("a ledger row naming no task re-derives EVERY task, because nothing can say which it bears on", () => {
  const { deps, github, ledgerPath } = threeTasks();
  const cache = createBoardSnapshotCache();
  cache.get(deps);
  assert.equal(derivations(github), 3);

  // No `task_id`, no `task` — unattributable. The memo must fail SAFE, not quietly reuse.
  append(ledgerPath, { run_id: "r9", step: "policy.changed" });
  cache.get(deps);
  assert.equal(derivations(github), 6, "all three re-derived — this is today's behaviour, preserved for the case the memo cannot reason about");
});

test("an in-flight run is re-derived every pass, because it ages with the clock and not with the ledger", () => {
  const { deps, github, ledgerPath } = threeTasks();
  const cache = createBoardSnapshotCache();

  append(ledgerPath, { run_id: "r1", task_id: "W1-T1", step: "run.start" });
  const first = cache.get(deps);
  const running = first.tasks.find((row) => row.taskId === "W1-T1");
  assert.ok(running && projectionAgesWithTheClock(running), "W1-T1 is in flight, so its projection moves with now() — the premise of this test");
  const afterFirst = derivations(github);

  // A line about a DIFFERENT task. W1-T1's own stamp is unchanged, so a stamp-only memo would
  // reuse it — pinning a dead run "running" past the liveness bound and freezing its elapsed
  // clock. It must be re-derived anyway.
  append(ledgerPath, { run_id: "r2", task_id: "W1-T3", step: "run.start" });
  cache.get(deps);
  assert.equal(
    derivations(github),
    afterFirst + 2,
    "the task that moved AND the in-flight one — never just the one the ledger named",
  );
});

test("a change in the GitHub half re-derives every task, since one open index is shared by all of them", () => {
  const { deps, github, state } = threeTasks();
  const cache = createBoardSnapshotCache();
  cache.get(deps);
  assert.equal(derivations(github), 3);

  cache.get(deps);
  assert.equal(derivations(github), 3, "an unchanged index and an unchanged ledger reuse everything");

  state.open = [{ number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", headRefName: "run-W1-T9-1" }];
  cache.get(deps);
  assert.equal(derivations(github), 6, "the open index moved, so no projection is assumed to have held");
});

test("foldTaskFingerprints walks only what is new, and restarts from zero when the ledger rotated", () => {
  const rows = [
    { step: "run.start", ts: "1", task_id: "W1-T1" },
    { step: "verdict", ts: "2", task_id: "W1-T2" },
  ];
  const first = foldTaskFingerprints(rows, EMPTY_TASK_FINGERPRINTS);
  assert.equal(first.foldedUpTo, 2);
  assert.deepEqual([...first.byTask.keys()].sort(), ["W1-T1", "W1-T2"]);
  assert.equal(first.globalCount, 0, "both rows named a task");

  const grown = foldTaskFingerprints([...rows, { step: "verdict", ts: "3", task_id: "W1-T1" }], first);
  assert.notEqual(grown.byTask.get("W1-T1"), first.byTask.get("W1-T1"), "the task the new row named moved");
  assert.equal(grown.byTask.get("W1-T2"), first.byTask.get("W1-T2"), "and the one it did not name did not");

  // A rotation: the log shrank and its head row is different. Continuing the fold across that
  // would key the memo on a file that no longer exists.
  const rotated = foldTaskFingerprints([{ step: "run.start", ts: "9", task_id: "W1-T5" }], grown);
  assert.equal(rotated.foldedUpTo, 1);
  assert.deepEqual([...rotated.byTask.keys()], ["W1-T5"], "the fold restarted rather than carrying stale tasks forward");
});

test("ledgerTaskOf reads both field names the ledger uses, and a stamp compares only integers", () => {
  assert.equal(ledgerTaskOf({ task_id: "W1-T1" }), "W1-T1");
  assert.equal(ledgerTaskOf({ task: "W1-T2" }), "W1-T2", "console-action rows carry the id as `task`, not `task_id`");
  assert.equal(ledgerTaskOf({ step: "sweep.pass" }), undefined);
  assert.equal(ledgerTaskOf({ task_id: "" }), undefined, "an empty id names nothing");

  const fp = foldTaskFingerprints([{ step: "run.start", ts: "1", task_id: "W1-T1" }], EMPTY_TASK_FINGERPRINTS);
  const a = taskProjectionStamp(fp, "W1-T1");
  assert.ok(sameTaskProjectionStamp(a, taskProjectionStamp(fp, "W1-T1")));
  assert.equal(sameTaskProjectionStamp(a, taskProjectionStamp(fp, "W1-T2")), false, "a task with no rows of its own is a different stamp, not the same one");
  for (const value of Object.values(a)) assert.equal(typeof value, "number", "a stamp is integers: the string form cost 110ms a pass rebuilding the same kilobyte prefix");
});
