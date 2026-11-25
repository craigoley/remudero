import assert from "node:assert/strict";
import { test } from "node:test";
import { planLoadRefusalViolations } from "#src/run-task.js";

test("W1-T13116: triage.relint_plan_lint_unavailable no longer recurs", () => {
  const found = planLoadRefusalViolations({ ran: false, reason: "task W1-T9 depends on unknown W1-T0" });
  assert.equal(found.length, 1);
  assert.equal(found[0].check, "plan-load");
  assert.equal(found[0].severity, "block");
  assert.match(found[0].message, /depends on unknown/);
});

test("W1-T13116: the symptom is still recorded when its failure occurs", () => {
  // Infrastructure failures stay unavailable (the ledger row is written by the caller); no violation is invented.
  for (const reason of ["no merge base: x", "lint-plan killed by SIGKILL", "lint-plan could not start: boom", "no PR-head checkout"]) {
    assert.deepEqual(planLoadRefusalViolations({ ran: false, reason }), [], reason);
  }
  assert.deepEqual(planLoadRefusalViolations({ ran: true, label: "l", checked: 1, violations: [] } as never), []);
});
