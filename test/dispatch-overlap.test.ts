import assert from "node:assert/strict";
import { test } from "node:test";
import {
  globsIntersect,
  partitionByFileOverlap,
  serializedLedgerPayload,
  rareOverlapWarnings,
  declarationCountsByPath,
  DEFAULT_OVERLAP_WARNING_POLICY,
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

// ── W1-T533: rarity-weighted overlap warning (advisory only) ───────────────
//
// The measured distribution the whole feature is sized against (task
// rationale (4)/(3)): src/lib/open-prs-rest.ts is declared by 6 of 277 shards
// (2%) — the path four concurrent PRs actually converged on. src/run-task.ts
// is declared by 103 of 277 shards (37%) — the hub raw overlap would flag
// uselessly. Both counts recur across the tests below.

test("W1-T533: an overlap on a rare path is reported", () => {
  const counts = new Map([["src/lib/open-prs-rest.ts", 6]]);
  const totalShardCount = 277; // 6/277 ≈ 2%
  const candidate = task({ id: "W1-NEW", files: ["src/lib/open-prs-rest.ts", "src/lib/unrelated.ts"] });
  const openPr = { id: "1930", files: ["src/lib/open-prs-rest.ts"] };

  const warnings = rareOverlapWarnings(candidate, [openPr], counts, totalShardCount);

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].withPr, "1930");
  assert.equal(warnings[0].rarestPath, "src/lib/open-prs-rest.ts");
  assert.equal(warnings[0].declaredByCount, 6);
  assert.equal(warnings[0].totalShardCount, 277);
});

test("W1-T533: an overlap on a hub path alone is not reported", () => {
  const counts = new Map([["src/run-task.ts", 103]]);
  const totalShardCount = 277; // 103/277 ≈ 37%
  const candidate = task({ id: "W1-NEW", files: ["src/run-task.ts"] });
  const openPr = { id: "1930", files: ["src/run-task.ts"] };

  const warnings = rareOverlapWarnings(candidate, [openPr], counts, totalShardCount);

  assert.deepEqual(warnings, []);
});

test("W1-T533: the rare-overlap report refuses nothing", () => {
  const counts = new Map([["src/lib/open-prs-rest.ts", 6]]);
  const totalShardCount = 277;
  const candidate = task({ id: "W1-NEW", files: ["src/lib/open-prs-rest.ts"] });
  const openPr = { id: "1930", files: ["src/lib/open-prs-rest.ts"] };

  // The warning fires...
  const warnings = rareOverlapWarnings(candidate, [openPr], counts, totalShardCount);
  assert.equal(warnings.length, 1);

  // ...yet the SAME candidate still dispatches on its own: nothing in this
  // module wires the warning into partitionByFileOverlap's decision, and a
  // solitary candidate has no in-pass collision to serialize against.
  const partition = partitionByFileOverlap([candidate]);
  assert.deepEqual(partition.dispatch.map((t) => t.id), ["W1-NEW"]);
  assert.deepEqual(partition.serialized, []);
});

test("W1-T533: the rarity threshold is policy data", () => {
  const counts = new Map([["src/lib/medium.ts", 40]]); // 40/277 ≈ 14%
  const totalShardCount = 277;
  const candidate = task({ id: "W1-NEW", files: ["src/lib/medium.ts"] });
  const openPr = { id: "1", files: ["src/lib/medium.ts"] };

  // The default policy (5% ceiling) does not consider 14% rare.
  assert.deepEqual(rareOverlapWarnings(candidate, [openPr], counts, totalShardCount), []);

  // A fixture-supplied policy object moves the threshold with zero code
  // change — the same discipline SweepPolicy already follows.
  const loosePolicy = { rareDeclarationRatioCeiling: 0.2 };
  const warnings = rareOverlapWarnings(candidate, [openPr], counts, totalShardCount, loosePolicy);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].rarestPath, "src/lib/medium.ts");
});

test("W1-T533: declarationCountsByPath counts each declaring task once per path", () => {
  const a = task({ id: "W1-A", files: ["src/lib/x.ts", "src/lib/x.ts", "src/lib/y.ts"] });
  const b = task({ id: "W1-B", files: ["src/lib/x.ts"] });
  const c = task({ id: "W1-C" }); // undeclared files: — contributes nothing
  const counts = declarationCountsByPath([a, b, c]);

  assert.equal(counts.get("src/lib/x.ts"), 2);
  assert.equal(counts.get("src/lib/y.ts"), 1);
  assert.equal(counts.has("src/lib/z.ts"), false);
});

test("W1-T533: DEFAULT_OVERLAP_WARNING_POLICY clears the 2% instance and excludes the 37% hub", () => {
  const ceiling = DEFAULT_OVERLAP_WARNING_POLICY.rareDeclarationRatioCeiling;
  assert.ok(6 / 277 <= ceiling, "the measured rare instance must clear the default ceiling");
  assert.ok(103 / 277 > ceiling, "the measured hub must NOT clear the default ceiling");
});
