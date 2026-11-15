import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkRunAssignmentReceipt } from "#src/lib/benchmark-run.js";
import { experimentIntentionToTreat, type ExperimentIntentionToTreat } from "#src/lib/routing-experiments.js";

const assignment = {
  id: "allocation-receipt-assignment",
  requested: { model: "gpt-6.1-sol", effort: "high" },
  selected: { provider: "claude", model: "claude-sonnet-5-5", effort: "high" },
};

test("W1-T12144 criterion 1: a routing experiment produces a randomized allocation receipt", () => {
  const experiment = experimentIntentionToTreat("sol61-vs-sonnet55", "W1-T12144", "claude");
  assert.ok(experiment);
  const receipt = benchmarkRunAssignmentReceipt({ ...assignment, routing: { experiment } }, {});
  assert.deepEqual(receipt.allocation, {
    method: "randomized",
    experimentId: experiment.id,
    arm: experiment.assignedArm,
    servedArm: experiment.servedArm,
    probability: experiment.assignedProbability,
    unit: "task",
  });
});

test("W1-T12144 criterion 2: an assignment without an experiment retains its observational allocation", () => {
  for (const routing of [undefined, {}, { experiment: undefined }]) {
    const receipt = benchmarkRunAssignmentReceipt({ ...assignment, routing }, {});
    assert.deepEqual(receipt.allocation, {
      method: "observational", reason: "no-random-allocation-receipt",
    });
  }
});

test("W1-T12144 criterion 3: the receipt copies intention-to-treat evidence without another draw", (t) => {
  t.mock.method(Math, "random", () => { throw new Error("receipting must not draw"); });
  for (const servedArm of ["recorded-assigned-arm", "recorded-crossover-arm"]) {
    const experiment: ExperimentIntentionToTreat = Object.freeze({
      id: "recorded-experiment-outside-live-registry", unit: "task", assignedArm: "recorded-assigned-arm",
      assignedProbability: 0.375, servedArm, crossover: servedArm !== "recorded-assigned-arm",
    });
    const input = Object.freeze({ ...assignment, routing: Object.freeze({ experiment }) });
    const first = benchmarkRunAssignmentReceipt(input, {});
    const retry = benchmarkRunAssignmentReceipt({ ...input, id: "retry-assignment" }, {});
    assert.deepEqual(first.allocation, {
      method: "randomized", experimentId: "recorded-experiment-outside-live-registry",
      arm: "recorded-assigned-arm", servedArm, probability: 0.375, unit: "task",
    });
    assert.deepEqual(retry.allocation, first.allocation);
    assert.equal(experiment.assignedProbability, 0.375);
  }
});
