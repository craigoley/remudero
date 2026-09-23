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

test("W1-T3843: a blocked machine-filed task names its blocked admission reason", () => {
  const filed = task({ author_class: "machine", status: "blocked", note: "operator hold" });
  const result = lintTask(filed, {
    machineFilingAdmission: {
      plan: planFor(filed),
      releasedIds: new Set([filed.id]),
      pathExists: () => true,
    },
  });

  const admission = result.violations.find((v) => v.check === "machine-filing-admission");
  assert.ok(admission);
  assert.match(admission.message, /task W1-T3843-fixture is blocked/);
});

test("W1-T3843: an unmerged machine-filed dependency names the unmet task", () => {
  const dependency = task({ id: "W1-T3843-dependency", verify: "auto" });
  const filed = task({ author_class: "machine", depends_on: [dependency.id] });
  const plan: Plan = { tasks: [filed, dependency], byId: new Map([[filed.id, filed], [dependency.id, dependency]]) };
  const result = lintTask(filed, {
    machineFilingAdmission: {
      plan,
      releasedIds: new Set([filed.id]),
      isMerged: () => false,
      pathExists: () => true,
    },
  });

  const admission = result.violations.find((v) => v.check === "machine-filing-admission");
  assert.ok(admission);
  assert.match(admission.message, /unmerged dependencies: W1-T3843-dependency/);
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

test("W1-T3843: the canonical ci-learning shard is allowed to remain parked for human release", () => {
  const filed = task({
    author_class: "machine",
    origin: "ci-learning:5505:ci-gate",
    files: ["learnings/ci.yaml"],
  });
  const result = lintTask(filed, {
    machineFilingAdmission: {
      plan: planFor(filed),
      releasedIds: new Set(),
      pathExists: () => true,
    },
  });

  assert.equal(result.violations.some((v) => v.check === "machine-filing-admission"), false);
});

test("W1-T4111: a machine-filed task the plan gardener retired is admitted without a selectability refusal", () => {
  const retired = task({ author_class: "machine", status: "blocked", retirement: "withdrawn", note: "plan gardener: merge into W1-T1" });
  const result = lintTask(retired, {
    machineFilingAdmission: {
      plan: planFor(retired),
      releasedIds: new Set(),
      pathExists: () => true,
    },
  });

  assert.equal(result.violations.find((v) => v.check === "machine-filing-admission"), undefined);
});
