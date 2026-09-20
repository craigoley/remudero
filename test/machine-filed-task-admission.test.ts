import test from "node:test";
import assert from "node:assert/strict";

import { lintTask } from "../src/lib/task-linter.js";
import type { Plan, Task } from "../src/lib/plan.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "W1-T3843-fixture",
    title: "machine filing fixture",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "human",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "feedback#W1-T3843",
    files: ["src/lib/plan.ts"],
    acceptance: [{ claim: "the admission gate is exercised", proof: "unit test: machine filing" }],
    ...overrides,
  };
}

function planFor(t: Task): Plan {
  return { tasks: [t], byId: new Map([[t.id, t]]) };
}

test("W1-T3843: an unselectable machine-filed task is refused at filing", () => {
  const filed = task({ author_class: "machine" });
  const result = lintTask(filed, {
    machineFilingAdmission: {
      plan: planFor(filed),
      releasedIds: new Set(),
      pathExists: () => true,
    },
  });

  const admission = result.violations.find((v) => v.check === "machine-filing-admission");
  assert.ok(admission);
  assert.match(admission.message, /not selectable by runnableCandidates/);
  assert.equal(admission.severity, "block");
});

test("W1-T3843: a machine-filed task naming a nonexistent file is refused", () => {
  const filed = task({ author_class: "machine", files: ["learnings/ci-gate-lessons.yaml"] });
  const result = lintTask(filed, {
    machineFilingAdmission: {
      plan: planFor(filed),
      releasedIds: new Set([filed.id]),
      pathExists: () => false,
      pathExistsAtBase: () => false,
    },
  });

  const admission = result.violations.find((v) => v.check === "machine-filing-admission");
  assert.ok(admission);
  assert.match(admission.message, /exist in neither the checkout nor the base tree/);
  assert.equal(admission.severity, "block");
});

test("W1-T3843: a human-authored verify:human task still files", () => {
  const filed = task();
  const result = lintTask(filed, {
    machineFilingAdmission: {
      plan: planFor(filed),
      releasedIds: new Set(),
      pathExists: () => true,
    },
  });

  assert.equal(result.violations.some((v) => v.check === "machine-filing-admission"), false);
});
