import assert from "node:assert/strict";
import { test } from "node:test";

import { lintPlan } from "../src/lib/task-linter.js";
import { parseTasksFromYaml } from "../src/lib/plan.js";
import type { Plan, Task } from "../src/lib/plan.js";

// ── GET /v1/inbox lints the whole plan once per proposal, and reads back two tasks ────────────
//
// MEASURED 2026-09-16 against the live fleet state (423 proposals, a 1,849-task plan):
//
//   classify loop          61,862ms    of which 640ms was git-grep subprocesses
//   GET /v1/daemon-health  61,245ms    296 bytes, issued alongside — 250ms once the inbox finished
//
// 90% of that sat in task-linter.ts. `blockingLintMessages` called `lintPlan(merged)` — every task
// in the merged plan — then read `results.get(id)` for the FRAGMENT's tasks only and dropped the
// rest. Once per proposal, so ~783,000 task lints per request on the daemon's only thread.
//
// The starvation is the part that reached an operator. `boundConsoleReadRoute` bounds a console
// read to 750ms by racing the handler against a `setTimeout`, and A `setTimeout` CANNOT FIRE ON A
// BLOCKED EVENT LOOP — so the stale-while-revalidate path the repo built for exactly this never
// ran, and Board, Inbox and Analytics all read "unavailable" against the console's 5s client
// timeout.
//
// These assertions are about the property, not the timing: `only` narrows what is COMPUTED and
// never what it is computed AGAINST, so the saving cannot come at the cost of an answer.

function planOf(yaml: string): Plan {
  const tasks = parseTasksFromYaml(yaml, "lint-scope fixture") as Task[];
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

/**
 * Two tasks declaring the SAME surface — the shape `duplicateSurfaceViolations` exists to catch.
 * TWO shared files, not one: `DUPLICATE_SURFACE_MIN_FILES` is 2, and a one-file fixture tripped
 * nothing at all — caught by this suite's own "fixture must actually collide" guard.
 */
const COLLIDING = `
- id: W1-T9001
  title: "Existing task that already owns the surface"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  principles: {tdd: strict}
  budget_usd: 10.00
  rationale: "fixture"
  design: "fixture"
  acceptance:
    - claim: "a"
      proof: "unit test: fixture a"
  risk: low
  origin: human
  files: [src/lib/collision-surface.ts, src/lib/collision-helper.ts]
  status: queued
  attempts: 0
- id: W1-T9002
  title: "New task that collides with the surface above"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  principles: {tdd: strict}
  budget_usd: 10.00
  rationale: "fixture"
  design: "fixture"
  acceptance:
    - claim: "b"
      proof: "unit test: fixture b"
  risk: low
  origin: human
  files: [src/lib/collision-surface.ts, src/lib/collision-helper.ts]
  status: queued
  attempts: 0
`;

test("lintPlan's id filter computes only the asked-for tasks", () => {
  const plan = planOf(COLLIDING);
  const all = lintPlan(plan);
  assert.equal(all.size, 2, "control: an unfiltered lint answers for every task");

  const one = lintPlan(plan, () => ({}), new Set(["W1-T9002"]));
  assert.deepEqual([...one.keys()], ["W1-T9002"]);
});

test("lintPlan's id filter still lints AGAINST the whole plan, so a duplicate surface is still seen", () => {
  // THE ASSERTION THE SAVING RESTS ON. Narrowing the corpus as well as the output would make the
  // filtered lint cheaper AND blind: W1-T9002 collides with W1-T9001, which is not in the filter.
  const plan = planOf(COLLIDING);
  const unfiltered = lintPlan(plan).get("W1-T9002");
  const filtered = lintPlan(plan, () => ({}), new Set(["W1-T9002"])).get("W1-T9002");

  const duplicates = (r: typeof filtered) => (r?.violations ?? []).filter((v) => v.check === "duplicate-surface");
  // A guard on the guard: a fixture that triggers nothing would make the equality below vacuous.
  assert.ok(duplicates(unfiltered).length > 0, "fixture must actually collide, or this test proves nothing");
  assert.deepEqual(duplicates(filtered), duplicates(unfiltered));
});

test("a filtered lint answers identically to an unfiltered one, violation for violation", () => {
  const plan = planOf(COLLIDING);
  const unfiltered = lintPlan(plan);
  for (const id of ["W1-T9001", "W1-T9002"]) {
    const filtered = lintPlan(plan, () => ({}), new Set([id])).get(id);
    assert.deepEqual(filtered, unfiltered.get(id), `${id} must lint the same whether or not it was filtered for`);
  }
});

test("an empty filter computes nothing, and an absent filter is the whole plan", () => {
  const plan = planOf(COLLIDING);
  assert.equal(lintPlan(plan, () => ({}), new Set()).size, 0);
  assert.equal(lintPlan(plan, () => ({})).size, 2);
});

test("the filter does not invent results for ids the plan does not carry", () => {
  const plan = planOf(COLLIDING);
  const out = lintPlan(plan, () => ({}), new Set(["W1-T9002", "W1-T9999"]));
  assert.deepEqual([...out.keys()], ["W1-T9002"]);
});

// ── The caller ───────────────────────────────────────────────────────────────────────────────
//
// `lintPlan` narrowing when asked is worth nothing if its one hot caller never asks. #5816 in this
// repo is the precedent: a predicate was widened correctly and its caller left invoking the old
// form, behind ten green predicate tests and none driving the caller.

const FRAGMENT = `
- id: W1-T9500
  title: "A drafted fragment task"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  principles: {tdd: strict}
  budget_usd: 10.00
  rationale: "fixture"
  design: "fixture"
  acceptance:
    - claim: "c"
      proof: "unit test: fixture c"
  risk: low
  origin: human
  files: [src/lib/fragment-surface.ts]
  status: queued
  attempts: 0
`;

test("blockingLintMessages asks only for the fragment's own ids, never the whole merged plan", async () => {
  const { blockingLintMessages } = await import("../src/lib/inbox.js");
  const base = planOf(COLLIDING);
  const fragment = planOf(FRAGMENT);

  let asked: ReadonlySet<string> | undefined;
  let calls = 0;
  blockingLintMessages(base, fragment, ((plan, optsFor, only) => {
    calls += 1;
    asked = only;
    return lintPlan(plan, optsFor, only);
  }) as typeof lintPlan);

  assert.equal(calls, 1, "control: the spy must actually be the lint that ran");
  assert.ok(asked !== undefined, "the caller must pass a filter at all — an absent one lints every task");
  assert.deepEqual([...asked!].sort(), ["W1-T9500"]);
  // The base plan's two tasks are in the merged plan and must NOT be asked for: they are computed
  // and discarded, which is the entire cost this removes.
  assert.equal(asked!.has("W1-T9001"), false);
  assert.equal(asked!.has("W1-T9002"), false);
});

test("narrowing the caller does not change the messages it returns", async () => {
  const { blockingLintMessages } = await import("../src/lib/inbox.js");
  const base = planOf(COLLIDING);
  const fragment = planOf(FRAGMENT);

  const narrowed = blockingLintMessages(base, fragment);
  // The pre-fix behaviour, reconstructed exactly: lint every task, read back the fragment's.
  const wide = blockingLintMessages(base, fragment, ((plan, optsFor) => lintPlan(plan, optsFor)) as typeof lintPlan);
  assert.deepEqual(narrowed, wide);
});
