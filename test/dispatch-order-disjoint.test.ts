import assert from "node:assert/strict";
import { test } from "node:test";
import { compareDispatch, dispatchOrder, runnableCandidates, type MergedSet } from "../src/lib/drain.js";
import { partitionByFileOverlap } from "../src/lib/dispatch-overlap.js";
import type { Plan, Task } from "../src/lib/plan.js";

// ── W1-T476: THE DISPATCH HEAD WAS POISONED DETERMINISTICALLY ───────────────────────────────
//
// THE MECHANISM (see drain.ts's compareDispatch/idOrdinal and dispatch-overlap.ts's
// overlappingPaths): `idOrdinal` used to take the LAST integer run in an id, so `W2-T1` ranked
// ordinal 1 -- ahead of the entire W1-T4xx backlog -- purely by accident of that regex. `W2-T1`'s
// `files:` is empty, which `overlappingPaths` fail-closes as overlapping EVERY other candidate.
// `partitionByFileOverlap`'s first-declared-wins placement then serialized the whole pool behind
// it: production admitted 1 lane where the pool held N disjoint tasks.
//
// THE FIX, three parts, all exercised below: (i) `undeclaredScopeLast` sorts a task with no
// `files:` after every declared-scope task; (ii) `idOrdinal` is workstream-aware, so an id's
// workstream number ranks before its own task ordinal; (iii) `runnableCandidates` packs its
// `limit` slots disjointness-first instead of a plain dispatchOrder truncation.

/** A minimal, otherwise-clean Task fixture, matching test/dispatch-overlap.test.ts's own helper. */
function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

const NONE_MERGED: MergedSet = () => false;

// ── (i) undeclaredScopeLast — the named comparator term ──────────────────────────────────────

test("undeclaredScopeLast: a task with NO files: sorts AFTER a declared-scope task, even when its own id ordinal is smaller", () => {
  const poison = task({ id: "W1-T1" }); // files: absent -- would rank ordinal 1 under an id-only tiebreak
  const declared = task({ id: "W1-T900", files: ["src/x.ts"] });

  assert.deepEqual(dispatchOrder([poison, declared]).map((t) => t.id), ["W1-T900", "W1-T1"]);
  assert.equal(compareDispatch(poison, declared) > 0, true, "poison (undeclared) sorts strictly after declared");
});

test("undeclaredScopeLast: an explicit files: [] (empty, not merely absent) also sorts last", () => {
  const poison = task({ id: "W1-T1", files: [] });
  const declared = task({ id: "W1-T900", files: ["src/x.ts"] });

  assert.deepEqual(dispatchOrder([poison, declared]).map((t) => t.id), ["W1-T900", "W1-T1"]);
});

test("undeclaredScopeLast: two undeclared tasks still tie on this term and fall through to the id tiebreak", () => {
  const a = task({ id: "W1-T900" });
  const b = task({ id: "W1-T1" });

  assert.deepEqual(dispatchOrder([a, b]).map((t) => t.id), ["W1-T1", "W1-T900"], "no files: on either side -- ordinal decides");
});

// ── (ii) idOrdinal is workstream-aware ────────────────────────────────────────────────────────

test("idOrdinal is workstream-aware: W2-T1 no longer outranks W1-T400 by the accident of the trailing-integer regex", () => {
  // Both tasks declare files:, isolating (ii) from (i) -- neither is undeclared scope, so this
  // fails if idOrdinal alone reverts to "last integer run in the id" even with (i) intact.
  const w2 = task({ id: "W2-T1", files: ["src/w2.ts"] });
  const w1 = task({ id: "W1-T400", files: ["src/w1.ts"] });

  assert.deepEqual(dispatchOrder([w2, w1]).map((t) => t.id), ["W1-T400", "W2-T1"]);
});

test("idOrdinal ranks WITHIN a workstream by task ordinal, and streams compare deliberately by number", () => {
  const ids = ["W3-T1", "W1-T99", "W1-T2", "W2-T5"];
  const tasks = ids.map((id) => task({ id, files: [`src/${id}.ts`] }));

  assert.deepEqual(
    dispatchOrder(tasks).map((t) => t.id),
    ["W1-T2", "W1-T99", "W2-T5", "W3-T1"],
    "W1 before W2 before W3, and within W1 the lower task ordinal (2) comes before the higher (99)",
  );
});

// ── (iii)+(iv): disjointness-first packing, and the falsifier, both directions ───────────────

test("FALSIFIER direction 1: a pool led (by raw id) by an empty-files task admits FULL lanes at lanes=2/3/4, never collapsing to 1", () => {
  // The poison task shares its WORKSTREAM with the disjoint set (W1-T1: files: absent, the
  // genuinely lowest ordinal in the pool) so this isolates (i) -- (ii)'s workstream comparison
  // cannot rescue a same-workstream poison; only sorting undeclared scope last can.
  const poison = task({ id: "W1-T1" });
  const disjoint = [2, 3, 4, 5].map((n) => task({ id: `W1-T40${n}`, files: [`src/d${n}.ts`] }));
  const plan = planOf([poison, ...disjoint]);

  for (const lanes of [2, 3, 4]) {
    const candidates = runnableCandidates(plan, NONE_MERGED, lanes);
    const { dispatch } = partitionByFileOverlap(candidates);
    assert.equal(dispatch.length, lanes, `lanes=${lanes} must admit ${lanes} full lanes, not collapse to 1`);
    assert.ok(!dispatch.some((t) => t.id === poison.id), "the undeclared-scope task never occupies a lane it would poison");
  }
});

test("regression: the literal historical shape (id W2-T1, files: absent, ranked ordinal 1 by the old last-integer-run regex) also admits full lanes", () => {
  // The exact shape named in this task's own rationale: a cross-workstream poison whose id would
  // rank ordinal 1 under the OLD comparator. Either (i) or (ii) alone is enough to demote it here
  // (they overlap in coverage for a cross-workstream poison); the same-workstream fixture above is
  // what isolates (i) on its own.
  const poison = task({ id: "W2-T1" });
  const disjoint = [1, 2, 3, 4].map((n) => task({ id: `W1-T40${n}`, files: [`src/d${n}.ts`] }));
  const plan = planOf([poison, ...disjoint]);

  const candidates = runnableCandidates(plan, NONE_MERGED, 4);
  const { dispatch } = partitionByFileOverlap(candidates);
  assert.equal(dispatch.length, 4, "the pool holds 4 disjoint tasks -- all 4 lanes must fill");
});

test("FALSIFIER direction 1 continued: disjointness-first packing rescues lanes even when an overlapping PAIR sits ahead of the disjoint set in dispatch order", () => {
  // overlapA/overlapB overlap EACH OTHER on shared.ts and sort ahead of the disjoint trio by id.
  // A plain dispatchOrder truncation at limit=3 would take [overlapA, overlapB, d1], and
  // partitionByFileOverlap would then admit only [overlapA, d1] -- 2 of 3 lanes. Reverting (iii)
  // alone (keeping (i) and (ii)) reproduces exactly that 2-of-3 collapse, so this fails on its own.
  const overlapA = task({ id: "W1-T401", files: ["src/shared.ts"] });
  const overlapB = task({ id: "W1-T402", files: ["src/shared.ts"] });
  const d1 = task({ id: "W1-T403", files: ["src/d1.ts"] });
  const d2 = task({ id: "W1-T404", files: ["src/d2.ts"] });
  const d3 = task({ id: "W1-T405", files: ["src/d3.ts"] });
  const poison = task({ id: "W2-T1" });
  const plan = planOf([overlapA, overlapB, d1, d2, d3, poison]);

  const candidates = runnableCandidates(plan, NONE_MERGED, 3);
  const { dispatch } = partitionByFileOverlap(candidates);

  assert.equal(dispatch.length, 3, "a disjoint triple exists in the eligible pool -- the pack must find it, not settle for 2");
});

test("FALSIFIER direction 2 (stability containment): a pool with NO disjoint pair admits exactly 1, and the candidate order is byte-identical to plain dispatchOrder truncation", () => {
  // Every task declares the SAME file, so no two are ever disjoint -- the pack has nothing to
  // improve and must fall back to dispatchOrder position at every slot, exactly like today.
  const allOverlapping = [1, 2, 3, 4].map((n) => task({ id: `W1-T50${n}`, files: ["src/shared.ts"] }));
  const plan = planOf(allOverlapping);

  const plainTruncation = dispatchOrder(allOverlapping)
    .slice(0, 3)
    .map((t) => t.id);
  const candidates = runnableCandidates(plan, NONE_MERGED, 3);

  assert.deepEqual(
    candidates.map((t) => t.id),
    plainTruncation,
    "absent an overlap difference to exploit, the pack must not reorder anything",
  );

  const { dispatch } = partitionByFileOverlap(candidates);
  assert.equal(dispatch.length, 1, "no disjoint pair exists anywhere in the pool -- exactly one lane fills");
});
