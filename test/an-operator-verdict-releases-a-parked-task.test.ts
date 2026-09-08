import assert from "node:assert/strict";
import { test } from "node:test";

import { RELEASE_LEDGER_STEP, assertRunnable, releasedTaskIds } from "../src/lib/plan.js";
import { nextRunnable, resolveReleasedIds, runDrain } from "../src/lib/drain.js";
import { approveParkedTask, namesATask } from "../src/run-task.js";

/**
 * W1-T3206 — `verify: human` WAS A ONE-WAY PARK WITH NO RELEASE.
 *
 * MEASURED 2026-09-08: `isDispatchEligible` refuses it (drain.ts:418), `assertRunnable` throws
 * (plan.ts), and a grep across `src/` for any approve/release/unblock path keyed on `verify: human`
 * returned ZERO matches. 45 such shards were queued, the oldest filed 2026-07-21 — seven weeks.
 *
 * The release is NOT a plan edit: it is the `ratify.approved` row `rmd approve` already writes when
 * an operator spends his bit, so the plan record stays byte-identical and no worker rewrites a
 * `verify:` field (which Standing rule 15 forbids anyway).
 */

const row = (o: Record<string, unknown>) => JSON.stringify(o);

test("W1-T3206: a ratify.approved row releases exactly the task it names", () => {
  const ids = releasedTaskIds([
    row({ step: RELEASE_LEDGER_STEP, task_id: "W1-T1041" }),
    row({ step: "sweep.disposed", task_id: "W1-T9999" }),
  ]);
  assert.deepEqual([...ids], ["W1-T1041"]);
});

test("W1-T3206: no release rows means NO releases — the wall still stands", () => {
  const ids = releasedTaskIds([row({ step: "sweep.disposed", task_id: "W1-T1041" })]);
  assert.equal(ids.size, 0);
});

test("W1-T3206: an unparseable line releases nothing rather than throwing — the safe direction", () => {
  const ids = releasedTaskIds([
    "{ this ratify.approved row is not json",
    row({ step: RELEASE_LEDGER_STEP, task_id: "W1-T2983" }),
  ]);
  assert.deepEqual([...ids], ["W1-T2983"], "the good row still releases; the bad one is skipped");
});

test("W1-T3206: a row whose step merely CONTAINS the step name does not release", () => {
  // The reader cheap-rejects on substring before parsing; the parse must still be authoritative,
  // or a prose field mentioning the step name would release a task nobody ratified.
  const ids = releasedTaskIds([
    row({ step: "review.posted", task_id: "W1-T1041", note: "mentions ratify.approved in prose" }),
  ]);
  assert.equal(ids.size, 0);
});

test("W1-T3206: a release row with no task_id releases nothing", () => {
  assert.equal(releasedTaskIds([row({ step: RELEASE_LEDGER_STEP })]).size, 0);
  assert.equal(releasedTaskIds([row({ step: RELEASE_LEDGER_STEP, task_id: "" })]).size, 0);
});

test("W1-T3206 FALSIFIER: released and unreleased ids are DISTINGUISHED, not answered alike", () => {
  const ids = releasedTaskIds([row({ step: RELEASE_LEDGER_STEP, task_id: "W1-T1041" })]);
  assert.equal(ids.has("W1-T1041"), true, "the ratified one is released");
  assert.equal(ids.has("W1-T2983"), false, "an unratified sibling is NOT");
  // A reader that returned everything, or nothing, would fail exactly one of these two.
});

// ══ W1-T3216 — THE WRITER AND THE WIRING ═══════════════════════════════════════════════════════
//
// W1-T3206 shipped the READER and nothing else: on main before this task, `releasedTaskIds` had
// ZERO callers and `releasedIds` ZERO producers, so every assertion above passed against a feature
// no production path could reach. The suites below are the two halves that were missing, and the
// LAST one is the test whose absence let that ship.

const parked = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: id, repo: "remudero", type: "implement",
  verify: "human", status: "queued", depends_on: [], ...over,
});

/** A plan with a byId map — the only shape approveParkedTask and assertRunnable read. */
function planOf(tasks: Record<string, unknown>[]) {
  return { tasks, byId: new Map(tasks.map((t) => [t.id as string, t])) } as never;
}

const NEVER_MERGED = (() => false) as never;

test("W1-T3216: naming a parked task to approve writes exactly ONE ratify.approved row for it", () => {
  const written: [string, Record<string, unknown>][] = [];
  const out = approveParkedTask("W1-T1041", {
    plan: planOf([parked("W1-T1041")]),
    ledgerPath: "/nonexistent/ledger.jsonl",
    runId: "APPROVE-W1-T1041",
    ledgerLines: [],
    append: ((path: string, r: Record<string, unknown>) => void written.push([path, r])) as never,
  });
  assert.equal(out.code, 0);
  assert.equal(written.length, 1, "exactly one row — a release is one event");
  assert.equal(written[0]![1].step, RELEASE_LEDGER_STEP, "the SAME step a proposal ratification writes, never a second vocabulary");
  assert.equal(written[0]![1].task_id, "W1-T1041");
  assert.equal(written[0]![1].run_id, "APPROVE-W1-T1041", "clock-free: keyed on the task, so the row is findable by what it releases");
});

test("W1-T3216: every refusal names the state and writes NOTHING", () => {
  const cases: [string, Record<string, unknown>[], RegExp][] = [
    ["W1-T9999", [parked("W1-T1041")], /unknown task 'W1-T9999'/],
    ["W1-T1041", [parked("W1-T1041", { verify: "auto" })], /is verify:auto — it needs no release/],
    ["W1-T1041", [parked("W1-T1041", { status: "blocked" })], /is status:blocked/],
    ["W1-T1041", [parked("W1-T1041", { status: "retired" })], /is status:retired/],
  ];
  for (const [id, tasks, expected] of cases) {
    const written: unknown[] = [];
    const out = approveParkedTask(id, {
      plan: planOf(tasks), ledgerPath: "/x", runId: "R", ledgerLines: [],
      append: (() => void written.push(1)) as never,
    });
    assert.equal(out.code, 2, `${id} must be refused`);
    assert.match(out.message, expected, "the refusal NAMES the state — 'refused' alone is unactionable");
    assert.equal(written.length, 0, "a refusal writes nothing at all");
  }
});

test("W1-T3216: an ALREADY-released task returns 0 and writes no second row — a second bit is not a second release", () => {
  const written: unknown[] = [];
  const out = approveParkedTask("W1-T1041", {
    plan: planOf([parked("W1-T1041")]),
    ledgerPath: "/x", runId: "R",
    ledgerLines: [row({ step: RELEASE_LEDGER_STEP, task_id: "W1-T1041" })],
    append: (() => void written.push(1)) as never,
  });
  assert.equal(out.code, 0, "idempotent, not an error — the operator's intent is already recorded");
  assert.match(out.message, /already released — no second row written/);
  assert.equal(written.length, 0);
});

test("W1-T3216: the branch is chosen by SHAPE, so a proposal id still reaches the proposal path", () => {
  assert.equal(namesATask("W1-T1041"), true);
  assert.equal(namesATask("W2-T3a"), true);
  assert.equal(namesATask("P7"), false, "a proposal id must NOT take the task path");
  assert.equal(namesATask("P25"), false);
  assert.equal(namesATask(""), false);
  assert.equal(namesATask("W1-T"), false, "a malformed task-ish token is not a task id");
});

// ── THE WIRING: the half that was never built ─────────────────────────────────────────────────

test("W1-T3216: a released task is dispatch-eligible while an IDENTICAL unreleased one is refused", () => {
  const releasedIds = resolveReleasedIds({
    readLedgerLines: () => [row({ step: RELEASE_LEDGER_STEP, task_id: "W1-T1041" })],
  });
  // Through nextRunnable, the REAL selector every dispatch path calls — not a direct poke at the
  // predicate. Testing the predicate alone is exactly what let the unwired version ship.
  assert.equal(nextRunnable(planOf([parked("W1-T1041")]), NEVER_MERGED, { releasedIds } as never)?.id, "W1-T1041", "the released task is SELECTED by the real drain");
  assert.equal(nextRunnable(planOf([parked("W1-T2222")]), NEVER_MERGED, { releasedIds } as never), undefined, "the IDENTICAL unreleased task is not — this is the discrimination the feature is FOR");
});

test("W1-T3216: assertRunnable admits the released task and still refuses the unreleased one", () => {
  const released = new Set(["W1-T1041"]);
  assert.doesNotThrow(() => assertRunnable(planOf([parked("W1-T1041")]), parked("W1-T1041") as never, NEVER_MERGED, released));
  assert.throws(
    () => assertRunnable(planOf([parked("W1-T2222")]), parked("W1-T2222") as never, NEVER_MERGED, released),
    /verify:human/,
    "the wall still stands for everything the operator did not name",
  );
});

test("W1-T3216: with NO reader wired the released set is EMPTY — a door added, never a wall removed", () => {
  assert.deepEqual([...resolveReleasedIds({})], [], "a caller that has not opted in behaves exactly as before this task");
  assert.equal(nextRunnable(planOf([parked("W1-T1041")]), NEVER_MERGED, { releasedIds: resolveReleasedIds({}) } as never), undefined);
});

test("W1-T3216: the ledger is read ONCE PER PASS, not once per task", () => {
  // The defect this guards: resolving inside the per-task filter puts a disk read in the selection
  // loop, once per candidate. resolveReleasedIds is called at the pass boundary and the SET is
  // threaded down, which is why releasedIds is a ReadonlySet and not a path.
  let reads = 0;
  const releasedIds = resolveReleasedIds({
    readLedgerLines: () => { reads += 1; return [row({ step: RELEASE_LEDGER_STEP, task_id: "W1-T1041" })]; },
  });
  assert.equal(reads, 1, "one resolve, one read");
  for (const id of ["W1-T1041", "W1-T2222", "W1-T3333", "W1-T4444"]) {
    nextRunnable(planOf([parked(id)]), NEVER_MERGED, { releasedIds } as never);
  }
  assert.equal(reads, 1, "four eligibility questions, still ONE read — the filter never touches the disk");
});

test("W1-T3216 FALSIFIER: runDrain DISPATCHES a released verify:human task, and does NOT without the reader", async () => {
  // THIS IS THE TEST WHOSE ABSENCE LET #4715 SHIP. Every assertion above would pass against a
  // reader with zero callers; only a drive of the REAL drain fails when the wiring is missing.
  // Deliberately NOT a source-text assertion (source-text-assertion-census, W1-T2905): a grep for
  // `resolveReleasedIds(deps)` can stay green while the mechanism dies, which is the whole disease
  // this task is treating.
  const drive = async (readLedgerLines?: () => readonly string[]) => {
    const dispatched: string[] = [];
    await runDrain(
      planOf([parked("W1-T1041")]),
      {
        refreshMerged: () => NEVER_MERGED,
        runOne: async (id: string) => {
          dispatched.push(id);
          return { taskId: id, runId: `R-${id}`, merged: true, verdict: "merged", costUsd: 0 };
        },
        ...(readLedgerLines ? { readLedgerLines } : {}),
        log: () => {},
      } as never,
      { max: 1 },
    );
    return dispatched;
  };

  assert.deepEqual(
    await drive(() => [row({ step: RELEASE_LEDGER_STEP, task_id: "W1-T1041" })]),
    ["W1-T1041"],
    "with the reader wired, the REAL drain selects and dispatches the released task",
  );
  assert.deepEqual(
    await drive(undefined),
    [],
    "with no reader, the identical task is refused — a door added, never a wall removed",
  );
});
