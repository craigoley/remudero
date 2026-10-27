import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "#src/lib/plan.js";
import { proofBaseDiscriminationViolations } from "#src/lib/task-linter.js";

function task(kind?: "guard"): Task {
  return {
    id: "W1-T9251",
    title: "guard proof discrimination",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "low",
    status: "queued",
    attempts: 0,
    acceptance: [{
      claim: "preserves existing behaviour",
      proof: "unit test: test/lint-plan-proof-discrimination.test.ts",
      ...(kind ? { kind } : {}),
    }],
  };
}

test("W1-T9251: a guard on an existing test file draws no base-discrimination warn", () => {
  const violations = proofBaseDiscriminationViolations(task("guard"), {
    pathExistsAtBase: () => true,
  });
  assert.deepEqual(violations, []);
});

test("W1-T9251: an unguarded existing-file proof still warns and names the guard remedy", () => {
  const paths: string[] = [];
  const violations = proofBaseDiscriminationViolations(task(), {
    pathExistsAtBase: (path) => {
      paths.push(path);
      return true;
    },
  });
  assert.deepEqual(paths, ["test/lint-plan-proof-discrimination.test.ts"]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "proof-base-discrimination");
  assert.equal(violations[0]!.severity, "warn");
  assert.match(violations[0]!.message, /kind: guard/);
  assert.match(violations[0]!.message, /grep:/);
  assert.match(violations[0]!.message, /head/);
});
