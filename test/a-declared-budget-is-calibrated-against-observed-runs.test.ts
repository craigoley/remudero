import assert from "node:assert/strict";
import { test } from "node:test";
import { lintTask, type DeclaredBudgetCalibrationByClass } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "W1-T3146-FIXTURE",
    title: "fixture task",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    budget_usd: 35,
    files: ["src/lib/example.ts"],
    acceptance: [
      {
        claim: "the fixture has an executable proof",
        proof: "unit test: test/a-declared-budget-is-calibrated-against-observed-runs.test.ts",
      },
    ],
    ...overrides,
  };
}

const calibration: DeclaredBudgetCalibrationByClass = {
  src: {
    medianCostUsd: 4.08,
    maxCostUsd: 10.3,
    sampleCount: 668,
    minSamples: 20,
    multiplier: 3,
  },
};

test("declared budget above its class distribution reports median and sample count", () => {
  const res = lintTask(task(), { declaredBudgetCalibration: calibration });
  const warnings = res.violations.filter((v) => v.check === "budget-sanity");

  assert.equal(res.ok, true, "the declared-budget calibration check is advisory");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /src/);
  assert.match(warnings[0].message, /median \$4\.08/);
  assert.match(warnings[0].message, /n=668/);
});

test("a thin class produces no declared-budget finding", () => {
  const thin: DeclaredBudgetCalibrationByClass = {
    src: { ...calibration.src, sampleCount: 19 },
  };

  const res = lintTask(task(), { declaredBudgetCalibration: thin });

  assert.equal(res.violations.some((v) => v.check === "budget-sanity"), false);
});

test("a declared budget inside the observed class range produces no finding", () => {
  const res = lintTask(task({ budget_usd: 9 }), { declaredBudgetCalibration: calibration });

  assert.equal(res.violations.some((v) => v.check === "budget-sanity"), false);
});

test("a malformed calibration row produces no declared-budget finding", () => {
  const malformed: DeclaredBudgetCalibrationByClass = {
    src: { ...calibration.src, medianCostUsd: 0 },
  };

  const res = lintTask(task(), { declaredBudgetCalibration: malformed });

  assert.equal(res.violations.some((v) => v.check === "budget-sanity"), false);
});

test("declared budgets are compared against their own class only", () => {
  const byClass: DeclaredBudgetCalibrationByClass = {
    docs: { medianCostUsd: 1, maxCostUsd: 2, sampleCount: 80, minSamples: 20, multiplier: 3 },
    src: { medianCostUsd: 12, maxCostUsd: 40, sampleCount: 80, minSamples: 20, multiplier: 3 },
  };

  const docsTask = task({ files: ["docs/operator-guide.md"], budget_usd: 10 });
  const srcTask = task({ files: ["src/lib/example.ts"], budget_usd: 10 });

  assert.equal(lintTask(docsTask, { declaredBudgetCalibration: byClass }).violations.some((v) => v.check === "budget-sanity"), true);
  assert.equal(lintTask(srcTask, { declaredBudgetCalibration: byClass }).violations.some((v) => v.check === "budget-sanity"), false);
});
