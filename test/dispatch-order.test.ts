import assert from "node:assert/strict";
import test from "node:test";
import { compareDispatch, dispatchOrder, nextRunnable, runnableCandidates } from "../src/lib/drain.js";
import type { Plan, Task } from "../src/lib/plan.js";

// ── impl-DQ: dispatch order must not be file placement ────────────────────────────────────
//
// `loadPlan` parses plan/tasks.yaml then APPENDS every plan/tasks.d/*.yaml shard with tasks.push().
// Measured on today's plan: monolith at indices 0-268, shards 269-312. Both selectors iterated that
// array unsorted, so EVERY shard ranked behind EVERY monolith task, permanently. Since PR #1060
// redirected `rmd triage` to file into shards, everything newly filed sorted last.
//
// These tests pin the two properties that matter: the ELIGIBLE SET is untouched (only order moves),
// and the order is deterministic from committed content alone.

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    ...over,
  } as never;
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } as never;
}

const NONE_MERGED = () => false;

test("THE ELIGIBILITY LOCK: the SET of eligible tasks is identical before and after ordering", () => {
  // The most important test here. A behaviour change would be a far riskier PR wearing this one's
  // clothes, so the set is compared as a SET while the order is allowed to move.
  const tasks = [
    task("W1-T10"), // monolith-shaped, low id
    task("W1-T200", { verify: "human" }), // never eligible
    task("W1-T285"), // shard-shaped, high id
    task("W1-T50", { depends_on: ["W1-T10"] }), // eligible only once T10 merges
    task("W3-T6"),
    task("W1-T99", { status: "blocked" } as never),
  ];
  const plan = planOf(tasks);

  const unsortedEligible = plan.tasks.filter((t) => runnableCandidates(planOf([t]), NONE_MERGED, 1).length > 0);
  const sortedEligible = runnableCandidates(plan, NONE_MERGED, 999);

  assert.deepEqual(
    [...sortedEligible.map((t) => t.id)].sort(),
    [...unsortedEligible.map((t) => t.id)].sort(),
    "ordering must move tasks, never admit or exclude one",
  );
  // and the ones that must never be eligible still are not
  const ids = sortedEligible.map((t) => t.id);
  assert.ok(!ids.includes("W1-T200"), "verify:human stays out");
  assert.ok(!ids.includes("W1-T99"), "status:blocked stays out");
  assert.ok(!ids.includes("W1-T50"), "an unmet dependency stays out");
});

test("a SHARD task can rank ahead of a monolith task", () => {
  // The defect itself: shards were appended, so this ordering was previously impossible.
  // `loadPlan` would produce [monolith…, shard…]; here that array order is reproduced literally.
  const asLoaded = [task("W1-T900"), task("W1-T100")]; // monolith first, shard second
  const plan = planOf(asLoaded);

  const first = nextRunnable(plan, NONE_MERGED);

  assert.equal(first?.id, "W1-T100", "the lower-id task wins regardless of which file it came from");
  assert.equal(asLoaded[0].id, "W1-T900", "and the caller's array is NOT mutated");
});

test("ordering is DETERMINISTIC across repeated loads of the same plan", () => {
  const tasks = [task("W1-T285"), task("W1-T10"), task("W3-T6"), task("W1-T99"), task("W1-T1B")];

  const a = dispatchOrder(tasks).map((t) => t.id);
  const b = dispatchOrder(tasks).map((t) => t.id);
  const c = dispatchOrder([...tasks].reverse()).map((t) => t.id);

  assert.deepEqual(a, b, "same input, same output");
  assert.deepEqual(
    a,
    c,
    "and the result does not depend on the INPUT order — so shard enumeration order cannot leak in",
  );
});

test("the comparator is a TOTAL order, so no two tasks tie ambiguously", () => {
  const ids = ["W1-T10", "W1-T1B", "W3-T6", "W1-T285", "NO-DIGITS", "W1-T99"];
  const tasks = ids.map((i) => task(i));

  const sorted = dispatchOrder(tasks).map((t) => t.id);

  // every pair is decided one way or the other, never 0 unless identical
  for (const a of tasks) {
    for (const b of tasks) {
      if (a.id === b.id) continue;
      assert.notEqual(compareDispatch(a, b), 0, `${a.id} vs ${b.id} must not tie`);
    }
  }
  assert.equal(sorted[sorted.length - 1], "NO-DIGITS", "an id with no ordinal sorts last, not first");
});

test("ordering reads ONLY committed content -- never file order, mtime or enumeration", () => {
  // Determinism's real content: two plans whose tasks differ in nothing but array position must
  // select identically. Anything reading outside `id` would break this.
  const forward = planOf([task("W1-T3"), task("W1-T1"), task("W1-T2")]);
  const backward = planOf([task("W1-T2"), task("W1-T1"), task("W1-T3")]);

  assert.equal(nextRunnable(forward, NONE_MERGED)?.id, "W1-T1");
  assert.equal(nextRunnable(backward, NONE_MERGED)?.id, "W1-T1");
});

test("runnableCandidates still honours its limit, and returns them in dispatch order", () => {
  const plan = planOf([task("W1-T30"), task("W1-T10"), task("W1-T20")]);

  const two = runnableCandidates(plan, NONE_MERGED, 2);

  assert.deepEqual(two.map((t) => t.id), ["W1-T10", "W1-T20"], "limit applies AFTER ordering");
});
