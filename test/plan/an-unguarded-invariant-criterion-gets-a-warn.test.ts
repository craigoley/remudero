/**
 * W1-T14915 — an `invariant:<slug>` claim proved by a unit test, with no `kind` and no `satisfied_by`, gets one warn
 * at filing: such a proof usually passes at the merge base and proof-discrimination refuses it at review.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { lintTask, unguardedInvariantViolations, type LintOpts } from "#src/lib/task-linter.js";
import type { AcceptanceCriterion, Task } from "#src/lib/plan.js";

const ON: LintOpts = { requireDesignInvariantDeclaration: true };
const INVARIANT = "invariant:keep-buckets — legacy buckets keep their counts";

function task(invariant: Partial<AcceptanceCriterion> & { kind?: string }): Task {
  return {
    id: "ZZ-GUARD", title: "unguarded invariant fixture", repo: "remudero", depends_on: [], type: "implement",
    verify: "auto", risk: "medium", status: "queued", attempts: 0,
    design: "INVARIANT keep-buckets: legacy buckets keep their counts",
    acceptance: [
      { claim: "the new behavior works", proof: "unit test: the new behavior works" },
      { claim: INVARIANT, proof: "unit test: legacy buckets keep their counts", ...invariant },
    ],
  } as Task;
}

test("W1-T14915 criterion 1: an invariant claim with a unit-test proof and no kind gets the warn", () => {
  const got = unguardedInvariantViolations(task({}), ON);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.check, "invariant-unguarded");
  assert.equal(got[0]!.severity, "warn");
  assert.match(got[0]!.message, /claim 2/);
  assert.match(got[0]!.message, /`kind: guard`/);
  assert.match(got[0]!.message, /grep on text the build adds/);
  assert.equal(lintTask(task({}), ON).violations.filter((v) => v.check === "invariant-unguarded").length, 1, "lintTask carries it");
});

test("W1-T14915 criterion 1: an invariant claim with a code-span-wrapped unit-test proof gets the warn too", () => {
  // A plan record can wrap the proof in backticks; the YAML loader keeps them and the review executor strips them.
  for (const proof of ["`unit test: legacy buckets keep their counts`", "``unit test: legacy buckets keep their counts``"]) {
    const got = unguardedInvariantViolations(task({ proof }), ON);
    assert.equal(got.length, 1, proof);
    assert.match(got[0]!.message, /claim 2/);
  }
  assert.deepEqual(unguardedInvariantViolations(task({ proof: "`grep: keep-buckets in src/a.ts`" }), ON), [],
    "a wrapped grep proof is not a test proof");
});

test("W1-T14915 criterion 2: a guarded invariant gets no warn and existing checks are unchanged", () => {
  const guarded = task({ kind: "guard" });
  const credited = task({ satisfied_by: "#123" });
  const grepProved = task({ proof: "grep: keep-buckets in src/a.ts" });
  for (const t of [guarded, credited, grepProved]) assert.deepEqual(unguardedInvariantViolations(t, ON), []);
  assert.deepEqual(unguardedInvariantViolations(task({}), {}), [], "silent outside the changed-task pass");
  const others = (t: Task) => lintTask(t, ON).violations.filter((v) => v.check !== "invariant-unguarded");
  assert.deepEqual(others(task({})), others(guarded), "every other check reads the same with or without the guard");
  assert.equal(lintTask(guarded, ON).violations.some((v) => v.check === "invariant-unguarded"), false);
});
