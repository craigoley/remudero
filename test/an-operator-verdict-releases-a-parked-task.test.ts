import assert from "node:assert/strict";
import { test } from "node:test";

import { RELEASE_LEDGER_STEP, releasedTaskIds } from "../src/lib/plan.js";
import { approveParkedTask, namesATask } from "../src/run-task.js";
import type { Plan, Task } from "../src/lib/plan.js";

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

const row = (o: Record<string, unknown>): Record<string, unknown> => o;

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

test("W1-T3206: a malformed row releases nothing rather than throwing — the safe direction", () => {
  // The reader takes the PARSED rows the repo's own ledger readers return, so an unparseable LINE
  // never reaches it; what can still arrive is a row missing or mistyping the fields.
  const ids = releasedTaskIds([
    null as unknown as Record<string, unknown>,
    { step: RELEASE_LEDGER_STEP, task_id: 42 } as unknown as Record<string, unknown>,
    row({ step: RELEASE_LEDGER_STEP, task_id: "W1-T2983" }),
  ]);
  assert.deepEqual([...ids], ["W1-T2983"], "the good row still releases; the bad ones are skipped");
});

test("W1-T3206: a row whose PROSE mentions the step name does not release — the step field is authoritative", () => {
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

// ── the ADMISSION half: naming a parked shard to the pipeline proposals already use ────────────

const task = (over: Partial<Task>): Task =>
  ({ id: "W1-T1041", title: "t", repo: "remudero", depends_on: [], type: "implement",
     risk: "high", verify: "human", status: "queued", attempts: 0, ...over }) as Task;
const planOf = (...ts: Task[]): Plan => ({ byId: new Map(ts.map((t) => [t.id, t])), tasks: ts }) as unknown as Plan;

test("W1-T3206: namesATask distinguishes a task id from a proposal id", () => {
  assert.equal(namesATask("W1-T1041"), true);
  assert.equal(namesATask("W12-T3a"), true);
  assert.equal(namesATask("P7"), false, "a proposal id must still take the proposal path");
  assert.equal(namesATask("--dry-run"), false);
});

test("W1-T3206: releasing a queued verify:human task writes exactly one ratify.approved row naming it", () => {
  const written: Record<string, unknown>[] = [];
  const r = approveParkedTask("W1-T1041", {
    plan: planOf(task({})), ledgerPath: "/x", runId: "R1", ledgerLines: [],
    append: ((_p: string, row: Record<string, unknown>) => { written.push(row); }) as never,
  });
  assert.equal(r.code, 0);
  assert.equal(written.length, 1);
  assert.equal(written[0].step, RELEASE_LEDGER_STEP);
  assert.equal(written[0].task_id, "W1-T1041");
  assert.equal(releasedTaskIds(written).has("W1-T1041"), true, "the row it writes is the row the reader reads");
});

test("W1-T3206: every refusal names the state and writes NOTHING", () => {
  const cases: Array<[string, Plan, string]> = [
    ["unknown", planOf(), "unknown task"],
    ["not parked", planOf(task({ verify: "auto" })), "verify:auto"],
    ["blocked", planOf(task({ status: "blocked" })), "status:blocked"],
  ];
  for (const [label, plan, expect] of cases) {
    const written: Record<string, unknown>[] = [];
    const r = approveParkedTask("W1-T1041", {
      plan, ledgerPath: "/x", runId: "R1", ledgerLines: [],
      append: ((_p: string, row: Record<string, unknown>) => { written.push(row); }) as never,
    });
    assert.equal(r.code, 2, label);
    assert.equal(written.length, 0, `${label}: zero side effects`);
    assert.ok(r.message.includes(expect), `${label}: names the state — got "${r.message}"`);
  }
});

test("W1-T3206: an ALREADY-released task writes no second row and does not error", () => {
  const written: Record<string, unknown>[] = [];
  const r = approveParkedTask("W1-T1041", {
    plan: planOf(task({})), ledgerPath: "/x", runId: "R1",
    ledgerLines: [{ step: RELEASE_LEDGER_STEP, task_id: "W1-T1041" }],
    append: ((_p: string, row: Record<string, unknown>) => { written.push(row); }) as never,
  });
  assert.equal(r.code, 0);
  assert.equal(written.length, 0, "idempotent — a second bit is not a second release");
  assert.ok(r.message.includes("already released"));
});
