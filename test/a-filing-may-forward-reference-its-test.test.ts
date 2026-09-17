import assert from "node:assert/strict";
import { test } from "node:test";
import { proofUnitTestUnresolvableViolations } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

// ── W1-T3730 — A FILING CANNOT DECLARE ITS OWN TEST FILE ─────────────────────────────────────
//
// REPRODUCED 2026-09-17 on #5901's branch, a diff of THREE FILES, all under `plan/tasks.d/`:
//
//   $ rmd lint-plan --base origin/main
//   ✗ W1-T3727: [proof-unit-test-unresolvable] criterion 1 … resolves to ZERO tests in the head
//     tree — refused. This task's own files: names a test/ path, SO THIS DIFF SHIPS THE SUITE …
//
// `declaresTestFile` asks whether the TASK declares a `test/` path, and the message converts that
// into "this diff ships the suite". On a BUILD those are the same statement. On a FILING they are
// not: `files:` is what the future build will touch, and the filing ships no test at all.
//
// So a filing could not name its own test file — the opposite of what every other rule wants,
// since `files:` is the contract `acceptance-author-gate` resolves against and what the dispatcher
// hands a worker. The only exits were to make the shard lie about its scope, or to renumber.
//
// The check itself is RIGHT and is not weakened by one case: on a diff that really does ship the
// suite, a title resolving to zero tests has no forward-reference excuse and review refuses it
// later at the cost of a full CI round.

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T3727",
    title: "the two committing lanes have no cash path",
    repo: "remudero",
    files: ["src/lib/worker.ts", "src/run-task.ts", "test/a-committing-lane-diverts.test.ts"],
    acceptance: [
      { claim: "a committing lane offers a cash divert surface", proof: "unit test: a committing lane offers no divert until the harness owns its git" },
    ],
    ...over,
  } as unknown as Task;
}

/** The reviewer's own resolver, faked to the one answer that makes this check fire. `absent` is
 *  the status `resolveNameFilteredCandidates` returns for a title matching no test at all. */
type LintOptsArg = NonNullable<Parameters<typeof proofUnitTestUnresolvableViolations>[1]>;
const absent: NonNullable<LintOptsArg["resolveNameFilteredCandidates"]> = () => ({ status: "absent" });

test("a plan-only filing may forward-reference the test its build will write", () => {
  // #5901's exact shape: the task declares its future test file, and the diff in front of the
  // linter is plan-only. Five criteria across two shards were refused for this.
  const v = proofUnitTestUnresolvableViolations(task(), {
    resolveNameFilteredCandidates: absent,
    planOnlyFiling: true,
  });
  assert.deepEqual(v, [], "a filing ships no suite, whatever its files: declares");
});

test("a diff carrying a test file still refuses an unresolvable title", () => {
  // THE CHECK THIS TASK KEEPS. Without this the change is not a narrowing, it is a removal — and
  // the refusal it restores is the one that saves a full CI round at review time.
  const v = proofUnitTestUnresolvableViolations(task(), {
    resolveNameFilteredCandidates: absent,
    planOnlyFiling: false,
  });
  assert.equal(v.length, 1, "a build diff still gets the check");
  assert.equal(v[0].check, "proof-unit-test-unresolvable");
  assert.equal(v[0].severity, "block");
});

test("no filing fact means no change in behaviour", () => {
  // The whole-plan pass and pre-dispatch never supply it, so they must be byte-identical to
  // before this field existed — which is also why the field is optional rather than defaulted.
  const withoutFact = proofUnitTestUnresolvableViolations(task(), { resolveNameFilteredCandidates: absent });
  const asBuild = proofUnitTestUnresolvableViolations(task(), { resolveNameFilteredCandidates: absent, planOnlyFiling: false });
  assert.deepEqual(withoutFact, asBuild, "absent must behave exactly as an explicit build");
  assert.equal(withoutFact.length, 1);

  // And the check stays silent without the injected resolver, on every value of the new field.
  for (const planOnlyFiling of [undefined, true, false]) {
    assert.deepEqual(proofUnitTestUnresolvableViolations(task(), { planOnlyFiling }), []);
  }
});

test("a task declaring no test file is unaffected, whatever the diff is", () => {
  // The pre-existing carve-out — "a task that is only filed, whose suite is not written yet, gets
  // no opinion here" — still holds on its own, independently of the filing fact.
  const noSuite = task({ files: ["src/lib/worker.ts"] });
  for (const planOnlyFiling of [undefined, true, false]) {
    assert.deepEqual(proofUnitTestUnresolvableViolations(noSuite, { resolveNameFilteredCandidates: absent, planOnlyFiling }), []);
  }
});
