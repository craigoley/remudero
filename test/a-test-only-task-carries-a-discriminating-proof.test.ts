import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lintTask,
  promoteIntroducedPlanOnlyDiagnostics,
  proofTestOnlyDiscriminationViolations,
} from "../src/lib/task-linter.js";
import type { AcceptanceCriterion, Task } from "../src/lib/plan.js";

const CENSUS = "test/every-priced-ledger-step-is-in-the-config-garden-read.test.ts";

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
    origin: "architect",
    ...over,
  };
}

/** W1-T5527's ORIGINAL filing shape (before #9103): one census test file, one whole-file proof. */
const original = (): Task =>
  task({
    id: "W1-T5527",
    files: [CENSUS],
    acceptance: [{ claim: "every priced ledger step is in the garden read", proof: `unit test: ${CENSUS}` }],
  });

/** Its AMENDED shape: the census becomes a `kind: guard` criterion and a `grep:` discriminates. */
const amended = (): Task =>
  task({
    id: "W1-T5527",
    files: [CENSUS],
    acceptance: [
      {
        claim: "every priced ledger step is in the garden read",
        kind: "guard",
        proof: `unit test: ${CENSUS}`,
      } as AcceptanceCriterion,
      {
        claim: "the census is a new test file checking every priced ledger step",
        proof: `grep: every ledger step written with pr_url or cost_usd in ${CENSUS}`,
      },
    ],
  });

test("lint-plan reports the check on W1-T5527's original filing shape", () => {
  const found = lintTask(original()).violations.filter((v) => v.check === "proof-test-only-discrimination");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.severity, "warn");
  assert.match(found[0]!.message, /discriminates nothing/);
  assert.match(found[0]!.message, new RegExp(CENSUS.replace(/[.]/g, "\\.")));
});

test("lint-plan is silent on W1-T5527's amended shape with a grep: criterion", () => {
  assert.deepEqual(proofTestOnlyDiscriminationViolations(amended()), []);
  assert.equal(
    lintTask(amended()).violations.some((v) => v.check === "proof-test-only-discrimination"),
    false,
  );
});

test("the name-filtered unit test form is reported too", () => {
  const t = original();
  t.acceptance = [{ claim: "x", proof: "unit test: every priced ledger step is in the garden read" }];
  assert.equal(proofTestOnlyDiscriminationViolations(t).length, 1);
});

test("a task that also changes src, or declares plan/ plus test/ only, is judged on its non-plan files", () => {
  const withSrc = original();
  withSrc.files = ["src/lib/task-linter.ts", CENSUS];
  assert.deepEqual(proofTestOnlyDiscriminationViolations(withSrc), []);

  const withPlan = original();
  withPlan.files = ["plan/tasks.d/W1-T5527-x.yaml", CENSUS];
  assert.equal(proofTestOnlyDiscriminationViolations(withPlan).length, 1);
});

test("a verify: human task and a task with no test-only files stay silent", () => {
  const human = original();
  human.verify = "human";
  assert.deepEqual(proofTestOnlyDiscriminationViolations(human), []);

  const noFiles = original();
  noFiles.files = undefined;
  assert.deepEqual(proofTestOnlyDiscriminationViolations(noFiles), []);
});

test("the check is promoted to a block on a new shard and stays a warning when inherited", () => {
  const head = proofTestOnlyDiscriminationViolations(original());
  const [fresh] = promoteIntroducedPlanOnlyDiagnostics(head, undefined, true);
  assert.equal(fresh!.severity, "block");
  const [inherited] = promoteIntroducedPlanOnlyDiagnostics(head, head, false);
  assert.equal(inherited!.severity, "warn");
});
