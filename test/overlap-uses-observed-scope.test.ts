import assert from "node:assert/strict";
import { test } from "node:test";
import { partitionByFileOverlap } from "../src/lib/dispatch-overlap.js";
import type { Task } from "../src/lib/plan.js";

/**
 * W1-T2237: `partitionByFileOverlap` serialized lanes on their DECLARED `files:`
 * while a merged diff exceeded that declaration in 138 of 301 comparable cases
 * (45.8%), 47 of them onto `src/` ground another task also declared — the guard
 * was protecting the declared set while two lanes edited the real one. These
 * tests exercise the optional `observedByTask` parameter (Shape A's narrow half,
 * task rationale §5/§6): a lane's REAL changed-file set, once observed (e.g. from
 * an open PR's diff), is unioned into the overlap comparison, and any overrun of
 * the declaration is REPORTED rather than discarded (§12/§13) — never turned into
 * a refusal at any rung (note: "no refusal ... not at dispatch, not at push, not
 * at review").
 */

/** A minimal, otherwise-clean Task fixture — every test overrides only what it needs. */
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

// ── claim: the overlap decision consults an observed changed-file set ──────

test("W1-T2237: a lane whose OBSERVED diff reaches another lane's declared path serializes, even though the two DECLARATIONS are disjoint", () => {
  const a = task({ id: "W1-A", files: ["src/lib/a.ts"] });
  const b = task({ id: "W1-B", files: ["src/lib/b.ts"] });

  // Control: bare declarations are disjoint, so today both dispatch together.
  const bareControl = partitionByFileOverlap([a, b]);
  assert.deepEqual(
    bareControl.dispatch.map((t) => t.id).sort(),
    ["W1-A", "W1-B"],
    "control: disjoint declarations dispatch together with no observed scope supplied",
  );

  // A's REAL diff (as observed, e.g., from its open PR) also touched b.ts — the
  // exact shape the task rationale measures: a merged diff exceeding its
  // declaration onto ground another task declares.
  const observed = new Map([["W1-A", { files: ["src/lib/a.ts", "src/lib/b.ts"] }]]);
  const partition = partitionByFileOverlap([a, b], observed);

  assert.deepEqual(partition.dispatch.map((t) => t.id), ["W1-A"]);
  assert.equal(partition.serialized.length, 1);
  assert.equal(partition.serialized[0].task, "W1-B");
  assert.equal(partition.serialized[0].blockedBy, "W1-A");
  assert.deepEqual(partition.serialized[0].paths.slice().sort(), ["src/lib/b.ts"]);
});

// ── claim: a lane with no observed scope still participates on its declaration, unchanged ──

test("W1-T2237: a lane absent from observedByTask is scored on its declaration alone — identical to calling with no observed map at all", () => {
  const a = task({ id: "W1-A", files: ["src/lib/a.ts"] });
  const b = task({ id: "W1-B", files: ["src/lib/b.ts"] });
  const c = task({ id: "W1-C", files: ["src/lib/a.ts"] }); // overlaps A on declaration alone

  // Only B carries an observed entry; A and C are entirely absent from the map.
  const observed = new Map([["W1-B", { files: ["src/lib/b.ts"] }]]);

  const withPartialMap = partitionByFileOverlap([a, b, c], observed);
  const withNoMapAtAll = partitionByFileOverlap([a, b, c]);

  assert.deepEqual(withPartialMap.dispatch.map((t) => t.id), withNoMapAtAll.dispatch.map((t) => t.id));
  assert.deepEqual(withPartialMap.serialized, withNoMapAtAll.serialized);
  assert.deepEqual(
    withPartialMap.dispatch.map((t) => t.id),
    ["W1-A", "W1-B"],
    "A and B dispatch together; C serializes behind A on their SHARED declaration",
  );
  assert.equal(withPartialMap.serialized[0]?.task, "W1-C");
});

// ── claim: fail-closed on undeclared-and-unobserved is preserved exactly ───

test("W1-T2237: a task with NEITHER a declaration NOR an observed scope still overlaps every candidate (fail-closed, unchanged)", () => {
  const a = task({ id: "W1-A" }); // files: absent, and absent from observedByTask too
  const b = task({ id: "W1-B", files: ["src/lib/b.ts"] });

  const observed = new Map([["W1-SOMEONE-ELSE", { files: ["src/lib/z.ts"] }]]); // does not name A or B
  const partition = partitionByFileOverlap([a, b], observed);

  assert.deepEqual(partition.dispatch.map((t) => t.id), ["W1-A"]);
  assert.equal(partition.serialized.length, 1);
  assert.equal(partition.serialized[0].task, "W1-B");
  assert.equal(partition.serialized[0].blockedBy, "W1-A");
});

test("W1-T2237: a task observed with an EMPTY files list is treated identically to no observed entry at all — still fail-closed on its empty declaration", () => {
  const a = task({ id: "W1-A" }); // files: absent
  const b = task({ id: "W1-B", files: ["src/lib/b.ts"] });
  const observed = new Map([["W1-A", { files: [] }]]);

  const partition = partitionByFileOverlap([a, b], observed);
  assert.deepEqual(partition.dispatch.map((t) => t.id), ["W1-A"]);
  assert.equal(partition.serialized[0]?.task, "W1-B");
});

// ── claim: an overrun observed at review time is reported against the declaration it exceeded ──

test("W1-T2237: a lane whose observed diff exceeds its own declaration is reported, naming the declaration it exceeded", () => {
  const a = task({ id: "W1-A", files: ["src/lib/drain.ts"] });
  const observed = new Map([["W1-A", { files: ["src/lib/drain.ts", "src/run-task.ts"] }]]);

  const partition = partitionByFileOverlap([a], observed);

  assert.equal(partition.overruns.length, 1);
  assert.equal(partition.overruns[0].task, "W1-A");
  assert.deepEqual(partition.overruns[0].declared, ["src/lib/drain.ts"]);
  assert.deepEqual(partition.overruns[0].observed, ["src/lib/drain.ts", "src/run-task.ts"]);
  assert.deepEqual(partition.overruns[0].overrun, ["src/run-task.ts"]);
});

test("W1-T2237: an observed diff that stays WITHIN its declaration (including via a glob) is not reported as an overrun", () => {
  const a = task({ id: "W1-A", files: ["src/lib/*.ts"] });
  const observed = new Map([["W1-A", { files: ["src/lib/drain.ts", "src/lib/plan.ts"] }]]);

  const partition = partitionByFileOverlap([a], observed);
  assert.deepEqual(partition.overruns, []);
});

// ── claim: the report names declared and observed separately, so an author can tell drift from creep ──

test("W1-T2237: the overrun report carries the declared and observed sides as distinct fields, not just the delta", () => {
  const a = task({ id: "W1-A", files: ["src/lib/drain.ts"] });
  // CREEP: adjacent, same-directory overrun.
  const creeping = task({ id: "W1-CREEP", files: ["src/lib/one.ts"] });
  // DRIFT: overrun onto unrelated ground entirely.
  const drifting = task({ id: "W1-DRIFT", files: ["src/lib/two.ts"] });
  const observed = new Map([
    ["W1-CREEP", { files: ["src/lib/one.ts", "src/lib/one-helper.ts"] }],
    ["W1-DRIFT", { files: ["src/lib/two.ts", "test/unrelated.test.ts"] }],
  ]);

  const partition = partitionByFileOverlap([a, creeping, drifting], observed);
  const byTask = new Map(partition.overruns.map((o) => [o.task, o]));

  const creep = byTask.get("W1-CREEP")!;
  assert.deepEqual(creep.declared, ["src/lib/one.ts"]);
  assert.deepEqual(creep.observed, ["src/lib/one.ts", "src/lib/one-helper.ts"]);
  assert.deepEqual(creep.overrun, ["src/lib/one-helper.ts"]);

  const drift = byTask.get("W1-DRIFT")!;
  assert.deepEqual(drift.declared, ["src/lib/two.ts"]);
  assert.deepEqual(drift.observed, ["src/lib/two.ts", "test/unrelated.test.ts"]);
  assert.deepEqual(drift.overrun, ["test/unrelated.test.ts"]);

  // Both reports name their FULL declared and observed sides — an author reading
  // one row does not have to cross-reference the plan to see what was declared.
  for (const report of partition.overruns) {
    assert.ok(Array.isArray(report.declared) && report.declared.length > 0);
    assert.ok(Array.isArray(report.observed) && report.observed.length > 0);
  }
});

// ── claim: no path in this change refuses a dispatch, a push, or a merge that is permitted today ──

test("W1-T2237: every candidate handed in still lands in EXACTLY ONE of dispatch/serialized — observed scope only reorders, never drops or refuses", () => {
  const a = task({ id: "W1-A", files: ["src/lib/a.ts"] });
  const b = task({ id: "W1-B", files: ["src/lib/b.ts"] });
  const c = task({ id: "W1-C", files: ["src/lib/c.ts"] });
  const observed = new Map([
    ["W1-A", { files: ["src/lib/a.ts", "src/lib/b.ts", "src/lib/c.ts"] }], // observed overlap with BOTH others
  ]);

  const partition = partitionByFileOverlap([a, b, c], observed);
  assert.equal(partition.dispatch.length + partition.serialized.length, 3);
  assert.deepEqual(
    [...partition.dispatch.map((t) => t.id), ...partition.serialized.map((s) => s.task)].sort(),
    ["W1-A", "W1-B", "W1-C"],
  );
});

test("W1-T2237: reporting an overrun never removes the overrunning task from dispatch when nothing else collides", () => {
  const solo = task({ id: "W1-SOLO", files: ["src/lib/solo.ts"] });
  const observed = new Map([["W1-SOLO", { files: ["src/lib/solo.ts", "src/lib/way-outside.ts"] }]]);

  const partition = partitionByFileOverlap([solo], observed);
  assert.deepEqual(partition.dispatch.map((t) => t.id), ["W1-SOLO"]);
  assert.deepEqual(partition.serialized, []);
  assert.equal(partition.overruns.length, 1, "the overrun is still reported even though nothing was refused");
});

test("W1-T2237: observed scope can only ADD a deferral relative to the bare-declaration partition, never remove one", () => {
  // A and B collide on their bare DECLARATIONS already.
  const a = task({ id: "W1-A", files: ["src/lib/shared.ts"] });
  const b = task({ id: "W1-B", files: ["src/lib/shared.ts"] });
  const bare = partitionByFileOverlap([a, b]);
  assert.equal(bare.serialized.length, 1, "control: these two already collide with no observed scope");

  // Even an observed scope that looks entirely disjoint from the collision does
  // not un-serialize a pair the bare declaration already flagged.
  const observed = new Map([["W1-A", { files: ["src/lib/shared.ts", "src/lib/unrelated.ts"] }]]);
  const withObserved = partitionByFileOverlap([a, b], observed);
  assert.equal(withObserved.serialized.length, 1);
  assert.equal(withObserved.serialized[0].task, "W1-B");
});

// ── claim: the partition stays deterministic in candidate order with observed input supplied ──

test("W1-T2237: the SAME candidates and the SAME observed map yield the SAME partition across repeated calls", () => {
  const a = task({ id: "W1-A", files: ["src/lib/a.ts"] });
  const b = task({ id: "W1-B", files: ["src/lib/b.ts"] });
  const c = task({ id: "W1-C", files: ["src/lib/c.ts"] });
  const candidates = [a, b, c];
  const observed = new Map([
    ["W1-A", { files: ["src/lib/a.ts", "src/lib/b.ts"] }],
    ["W1-C", { files: ["src/lib/c.ts", "src/run-task.ts"] }],
  ]);

  const first = partitionByFileOverlap(candidates, observed);
  for (let i = 0; i < 20; i++) {
    const again = partitionByFileOverlap(candidates, observed);
    assert.deepEqual(
      again.dispatch.map((t) => t.id),
      first.dispatch.map((t) => t.id),
    );
    assert.deepEqual(again.serialized, first.serialized);
    assert.deepEqual(again.overruns, first.overruns);
  }
});

test("W1-T2237: partitionByFileOverlap with an observed map is a plain synchronous function — no promise, no async gap", () => {
  const result = partitionByFileOverlap(
    [task({ id: "W1-A", files: ["x.ts"] })],
    new Map([["W1-A", { files: ["x.ts", "y.ts"] }]]),
  );
  assert.equal(typeof (result as unknown as Promise<unknown>).then, "undefined");
});
