import assert from "node:assert/strict";
import { test } from "node:test";
import {
  globsIntersect,
  partitionByFileOverlap,
  serializedLedgerPayload,
} from "../src/lib/dispatch-overlap.js";
import type { Task } from "../src/lib/plan.js";

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

// ── golden: overlapping files: SERIALIZE ────────────────────────────────────

test("partitionByFileOverlap: two tasks with overlapping files: never share a pass — the later one serializes", () => {
  const a = task({ id: "W1-A", files: ["src/lib/drain.ts", "src/lib/plan.ts"] });
  const b = task({ id: "W1-B", files: ["src/lib/drain.ts"] }); // overlaps A on drain.ts
  const partition = partitionByFileOverlap([a, b]);

  assert.deepEqual(
    partition.dispatch.map((t) => t.id),
    ["W1-A"],
  );
  assert.equal(partition.serialized.length, 1);
  assert.equal(partition.serialized[0].task, "W1-B");
  assert.equal(partition.serialized[0].blockedBy, "W1-A");
  assert.deepEqual(partition.serialized[0].paths.slice().sort(), ["src/lib/drain.ts"]);
});

test("dispatch.serialized ledger payload carries BOTH task ids and the intersecting paths", () => {
  const a = task({ id: "W1-A", files: ["src/lib/drain.ts"] });
  const b = task({ id: "W1-B", files: ["src/lib/drain.ts"] });
  const partition = partitionByFileOverlap([a, b]);
  const payload = serializedLedgerPayload(partition.serialized[0]);
  assert.equal(payload.task, "W1-B");
  assert.equal(payload.blocked_by, "W1-A");
  assert.equal(payload.reason, "file-overlap");
  assert.deepEqual(payload.paths, ["src/lib/drain.ts"]);
});

// ── falsifier: DISJOINT globs are eligible for the same pass ────────────────

test("partitionByFileOverlap: two tasks with DISJOINT files: are BOTH eligible for the same pass", () => {
  const a = task({ id: "W1-A", files: ["src/lib/drain.ts"] });
  const b = task({ id: "W1-B", files: ["src/lib/plan.ts"] });
  const partition = partitionByFileOverlap([a, b]);

  assert.deepEqual(
    partition.dispatch.map((t) => t.id).sort(),
    ["W1-A", "W1-B"],
  );
  assert.deepEqual(partition.serialized, []);
});

test("partitionByFileOverlap: a blanket serializer is NOT what this does — three disjoint tasks all dispatch together", () => {
  const a = task({ id: "W1-A", files: ["src/lib/a.ts"] });
  const b = task({ id: "W1-B", files: ["src/lib/b.ts"] });
  const c = task({ id: "W1-C", files: ["src/lib/c.ts"] });
  const partition = partitionByFileOverlap([a, b, c]);

  assert.equal(partition.dispatch.length, 3);
  assert.equal(partition.serialized.length, 0);
});

// ── fail-closed: absent/empty files: overlaps EVERYTHING ────────────────────

test("partitionByFileOverlap: a task with NO files: list overlaps every candidate (fail-closed)", () => {
  const a = task({ id: "W1-A", files: ["src/lib/drain.ts"] });
  const b = task({ id: "W1-B" }); // files: absent entirely
  const partition = partitionByFileOverlap([a, b]);

  assert.deepEqual(
    partition.dispatch.map((t) => t.id),
    ["W1-A"],
  );
  assert.equal(partition.serialized.length, 1);
  assert.equal(partition.serialized[0].task, "W1-B");
});

test("partitionByFileOverlap: a task with an EMPTY files: list overlaps every candidate (fail-closed)", () => {
  const a = task({ id: "W1-A", files: ["src/lib/drain.ts"] });
  const b = task({ id: "W1-B", files: [] });
  const partition = partitionByFileOverlap([a, b]);

  assert.deepEqual(
    partition.dispatch.map((t) => t.id),
    ["W1-A"],
  );
  assert.equal(partition.serialized[0].task, "W1-B");
});

test("partitionByFileOverlap: TWO undeclared-scope tasks still overlap each other, not just declared ones", () => {
  const a = task({ id: "W1-A" });
  const b = task({ id: "W1-B" });
  const partition = partitionByFileOverlap([a, b]);
  assert.deepEqual(
    partition.dispatch.map((t) => t.id),
    ["W1-A"],
  );
  assert.equal(partition.serialized[0].task, "W1-B");
});

// ── determinism / LLM-free ───────────────────────────────────────────────────

test("partitionByFileOverlap: the SAME candidate set yields the SAME partition across repeated calls", () => {
  const a = task({ id: "W1-A", files: ["src/lib/drain.ts"] });
  const b = task({ id: "W1-B", files: ["src/lib/drain.ts"] });
  const c = task({ id: "W1-C", files: ["src/lib/plan.ts"] });
  const candidates = [a, b, c];

  const first = partitionByFileOverlap(candidates);
  for (let i = 0; i < 20; i++) {
    const again = partitionByFileOverlap(candidates);
    assert.deepEqual(
      again.dispatch.map((t) => t.id),
      first.dispatch.map((t) => t.id),
    );
    assert.deepEqual(again.serialized, first.serialized);
  }
});

test("partitionByFileOverlap: is a plain synchronous function — no promise, no async gap for a model call to hide in", () => {
  const result = partitionByFileOverlap([task({ id: "W1-A", files: ["x.ts"] })]);
  assert.equal(typeof (result as unknown as Promise<unknown>).then, "undefined");
});

// ── glob expansion ───────────────────────────────────────────────────────────

test("globsIntersect: literal paths compare by normalized string equality", () => {
  assert.equal(globsIntersect("src/lib/drain.ts", "src/lib/drain.ts"), true);
  assert.equal(globsIntersect("./src/lib/drain.ts", "src/lib/drain.ts"), true);
  assert.equal(globsIntersect("src/lib/drain.ts", "src/lib/plan.ts"), false);
});

test("globsIntersect: a wildcard glob intersects a literal path it would match", () => {
  assert.equal(globsIntersect("src/lib/*.ts", "src/lib/drain.ts"), true);
  assert.equal(globsIntersect("src/lib/**", "src/lib/drain.ts"), true);
  assert.equal(globsIntersect("src/lib/*.ts", "src/cli/drain.ts"), false);
});

test("globsIntersect: two disjoint wildcard globs over the same directory still intersect (bias toward safety)", () => {
  // "*.ts" and "drain.*" both admit "drain.ts" — the fail-closed bias for wildcard
  // comparisons this module documents (over-approximate rather than under-detect).
  assert.equal(globsIntersect("src/lib/*.ts", "src/lib/drain.*"), true);
});
