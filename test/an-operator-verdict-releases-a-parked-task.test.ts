import assert from "node:assert/strict";
import { test } from "node:test";

import { RELEASE_LEDGER_STEP, releasedTaskIds } from "../src/lib/plan.js";

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
