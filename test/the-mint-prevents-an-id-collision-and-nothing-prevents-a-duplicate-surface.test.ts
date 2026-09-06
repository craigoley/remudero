import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DUPLICATE_SURFACE_MIN_FILES,
  duplicateSurfaceViolations,
  lintTask,
  type DuplicateSurfaceCorpusEntry,
} from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

// ── W1-T2676 ─────────────────────────────────────────────────────────────────────────────────
//
// `next-task-id --reserve` answers "is this NUMBER free" and answers it correctly. Nothing
// answered "is this WORK already filed". MEASURED 2026-09-01 in this repo's own plan tree:
// W1-T2589 was filed for work W1-T2581 already covered, its four declared files a STRICT SUBSET
// of W1-T2581's seven, both queued with `depends_on: []` and therefore both dispatch-eligible,
// and lint-plan said nothing. The costly part is not the redundancy: two workers editing one
// surface produce CONFLICTING PRs.
//
// The hard half is not firing. Any check keyed on shared files fires on the create-and-wire pair
// too, so the legitimate-overlap cases are asserted here beside the catch.

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: `title for ${over.id}`,
    repo: "remudero",
    type: "implement",
    verify: "auto",
    status: "queued",
    attempts: 0,
    depends_on: [],
    ...over,
  } as Task;
}

const SEVEN = [
  "src/lib/merge-hold.ts",
  "src/lib/serve.ts",
  "src/run-task.ts",
  "test/merge-hold.test.ts",
  "test/serve.test.ts",
  "docs/operator-guide.md",
  "plan/tasks.d/W1-T2581-expose-the-durable-merge-hold-writer.yaml",
];
const FOUR_SUBSET = ["src/lib/merge-hold.ts", "src/run-task.ts", "test/merge-hold.test.ts", "docs/operator-guide.md"];

function corpus(...entries: DuplicateSurfaceCorpusEntry[]): DuplicateSurfaceCorpusEntry[] {
  return entries;
}

// ── the observed pair ─────────────────────────────────────────────────────────────────────────

test("two queued shards declaring the same files are reported, naming BOTH ids and the overlap", () => {
  const v = duplicateSurfaceViolations(task({ id: "W1-T2589", files: [...SEVEN] }), {
    openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }),
  });

  assert.equal(v.length, 1);
  assert.equal(v[0]!.check, "duplicate-surface");
  assert.match(v[0]!.message, /W1-T2589/, "this task is named");
  assert.match(v[0]!.message, /W1-T2581/, "and so is the other — a pair finding that names one id is not actionable");
  assert.match(v[0]!.message, /src\/lib\/merge-hold\.ts/, "the overlap itself is named, not just its size");
  assert.match(v[0]!.message, /the same files as/, "and the relation is stated");
});

test("a SUBSET overlap is caught, not only an exact match — the shape actually observed", () => {
  // W1-T2589's four files were a strict subset of W1-T2581's seven. A check that required
  // set equality would have said nothing about the one pair it exists to catch.
  const v = duplicateSurfaceViolations(task({ id: "W1-T2589", files: [...FOUR_SUBSET] }), {
    openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }),
  });
  assert.equal(v.length, 1);
  assert.match(v[0]!.message, /a subset of W1-T2581/);
  assert.match(v[0]!.message, /4 shared file\(s\)/);
});

test("the subset is caught in EITHER direction — nothing makes the smaller shard the one filed second", () => {
  const v = duplicateSurfaceViolations(task({ id: "W1-T2581", files: [...SEVEN] }), {
    openTaskSurfaces: corpus({ id: "W1-T2589", files: FOUR_SUBSET, status: "queued" }),
  });
  assert.equal(v.length, 1);
  assert.match(v[0]!.message, /a superset of W1-T2589/);
});

// ── severity ──────────────────────────────────────────────────────────────────────────────────

test("the finding is a WARNING, not a refusal, so a legitimate overlap is never blocked", () => {
  const t = task({ id: "W1-T2589", files: [...FOUR_SUBSET] });
  const opts = { openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }) };

  assert.equal(duplicateSurfaceViolations(t, opts)[0]!.severity, "warn");

  // And through the aggregator, because an unwired check reports nothing to anyone. `ok` is not
  // asserted directly: this minimal fixture trips other rules for unrelated reasons, so the
  // precise property is that ADDING the corpus adds a finding and adds NO blocking one.
  const withCorpus = lintTask(t, opts);
  const without = lintTask(t, {});
  assert.ok(
    withCorpus.violations.some((x) => x.check === "duplicate-surface"),
    "the check is WIRED INTO lintTask",
  );
  assert.ok(
    withCorpus.violations.filter((x) => x.check === "duplicate-surface").every((x) => x.severity === "warn"),
    "and contributes only warnings",
  );
  const blocking = (r: { violations: { severity: string; check: string }[] }) =>
    r.violations.filter((x) => x.severity === "block").map((x) => x.check).sort();
  assert.deepEqual(blocking(withCorpus), blocking(without), "the duplicate surface adds no blocking violation");
});

// ── the legitimate overlaps: the half that is hard ────────────────────────────────────────────

test("a pair whose overlap is a single shared module with different concerns is NOT reported", () => {
  // The shard's own falsifier. A wiring task and the module it wires share one file by design;
  // firing here would flag the create-and-wire shape Rule 19 already pushes to risk:high, and a
  // check that cries on legitimate work gets ignored on the case it exists for.
  const v = duplicateSurfaceViolations(task({ id: "W1-T900", files: ["src/lib/shared.ts", "src/lib/only-mine.ts"] }), {
    openTaskSurfaces: corpus({ id: "W1-T901", files: ["src/lib/shared.ts", "src/lib/only-theirs.ts"], status: "queued" }),
  });
  assert.deepEqual(v, [], "one shared module is not a duplicate surface");
});

test("a one-file shard is not a duplicate of every task that touches its file", () => {
  // A single declared file is a subset of nearly everything. Keying on subset alone would fire
  // here, which is why DUPLICATE_SURFACE_MIN_FILES exists and is asserted rather than assumed.
  assert.equal(DUPLICATE_SURFACE_MIN_FILES, 2);
  const v = duplicateSurfaceViolations(task({ id: "W1-T902", files: ["src/lib/merge-hold.ts"] }), {
    openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }),
  });
  assert.deepEqual(v, [], "a subset of size 1 is not evidence of duplicated work");
});

test("a TINY candidate is not a duplicate of this task either — the floor is on the overlap, both directions", () => {
  // The mirror of the one-file case, and the direction a `task.files.length` guard cannot see:
  // here THIS task is the superset and the other shard declares the single shared file. The
  // falsifier matrix found this gap — with only the size-of-my-own-surface guard, mutating the
  // overlap floor reddened nothing.
  const v = duplicateSurfaceViolations(task({ id: "W1-T2581", files: [...SEVEN] }), {
    openTaskSurfaces: corpus({ id: "W1-T908", files: ["src/lib/merge-hold.ts"], status: "queued" }),
  });
  assert.deepEqual(v, [], "one shared module is not a duplicate surface in either direction");
});

test("a shard whose files overlap nothing is never reported, so the check is not vacuous", () => {
  const v = duplicateSurfaceViolations(task({ id: "W1-T903", files: ["src/lib/elsewhere.ts", "test/elsewhere.test.ts"] }), {
    openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }),
  });
  assert.deepEqual(v, []);
});

// ── live work only ────────────────────────────────────────────────────────────────────────────

test("a shard already credited as merged is not counted as a duplicate of live work", () => {
  // Otherwise every follow-up is flagged against the task it follows, which is how an advisory
  // check earns the reputation that gets it ignored.
  for (const status of ["merged", "done", "blocked"]) {
    const v = duplicateSurfaceViolations(task({ id: "W1-T2589", files: [...FOUR_SUBSET] }), {
      openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status }),
    });
    assert.deepEqual(v, [], `a ${status} candidate is history, not live work`);
  }
});

test("a task that is ITSELF merged reports nothing — it is not competing for a dispatch slot", () => {
  const v = duplicateSurfaceViolations(task({ id: "W1-T2589", status: "merged", files: [...FOUR_SUBSET] }), {
    openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }),
  });
  assert.deepEqual(v, []);
});

// ── the silences that must stay silent ────────────────────────────────────────────────────────

test("absent a corpus the check is silent, and it never compares a task against itself", () => {
  const t = task({ id: "W1-T2581", files: [...SEVEN] });
  assert.deepEqual(duplicateSurfaceViolations(t, {}), [], "no corpus ⇒ silent");
  assert.deepEqual(duplicateSurfaceViolations(t, { openTaskSurfaces: [] }), [], "empty corpus ⇒ silent");
  assert.deepEqual(
    duplicateSurfaceViolations(t, { openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }) }),
    [],
    "a task is not its own duplicate",
  );
  assert.deepEqual(
    duplicateSurfaceViolations(task({ id: "W1-T904" }), {
      openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }),
    }),
    [],
    "an undeclared files: has no surface to compare",
  );
  assert.deepEqual(
    duplicateSurfaceViolations(task({ id: "W1-T905", files: [...SEVEN] }), {
      openTaskSurfaces: corpus({ id: "W1-T906", files: [], status: "queued" }),
    }),
    [],
    "a candidate with no declared surface is not a match for everything",
  );
});

test("paths are compared normalised — whitespace and duplicates in files: do not hide an overlap", () => {
  // A shard hand-edited into ` src/lib/merge-hold.ts` must not read as a different surface, and a
  // repeated path must not inflate the shared count past the real overlap.
  const v = duplicateSurfaceViolations(
    task({ id: "W1-T907", files: ["  src/lib/merge-hold.ts  ", "src/run-task.ts", "src/run-task.ts"] }),
    { openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }) },
  );
  assert.equal(v.length, 1);
  assert.match(v[0]!.message, /2 shared file\(s\)/, "de-duplicated, not 3");
});

test("the message tells the reader how to clear it, and refuses the answer that hides the overlap", () => {
  const v = duplicateSurfaceViolations(task({ id: "W1-T2589", files: [...FOUR_SUBSET] }), {
    openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }),
  });
  assert.match(v[0]!.message, /ADVISORY, never blocking/);
  assert.match(v[0]!.message, /retire whichever shard the other supersedes, or cite W1-T2581/);
  assert.match(v[0]!.message, /Never by narrowing files:/, "narrowing files: hides the overlap rather than ruling on it");
});
