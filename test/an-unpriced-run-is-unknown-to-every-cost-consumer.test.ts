import test from "node:test";
import assert from "node:assert/strict";
import type { RunSummary } from "../src/lib/retro.js";
import { detectCostAnomalies, costAnomalyLine } from "../src/lib/cost-anomaly.js";
import { settledClassCosts, cohortOutcome } from "../src/lib/config-gardener.js";
import { cohortGuardObservations } from "../src/lib/experiment-promotion.js";
import { closureByClass, renderClosureByClass } from "../src/lib/retro-closure.js";
// @ts-expect-error — an .mjs script with no declaration file
import { computeClassSweep, computeArmSweep } from "../scripts/mount-headroom-sweep.mjs";

const run = (id: string, over: Partial<RunSummary> = {}): RunSummary => ({
  runId: id, taskId: `T-${id}`, type: "implement", startTs: "2026-10-08T10:00:00Z", verdict: "merged",
  costUsd: 0, numTurns: 5, taskClass: "c", ...over,
} as RunSummary);
const unpriced = (id: string, over: Partial<RunSummary> = {}) => run(id, { costSource: "none", ...over });

// One $9 priced run beside three unpriced runs (the plan's falsifier fixture).
const mixed = [run("a", { costUsd: 9 }), unpriced("b"), unpriced("c"), unpriced("d")];
const onlyUnpriced = [unpriced("b"), unpriced("c"), unpriced("d")];

test("W1-T6466: an unpriced run is counted, not averaged in as free, by every cost consumer", () => {
  // cost-anomaly: the class median is the priced runs' own, and the $0s are counted beside it.
  const policy = { minSamples: 2, multiplier: 2 };
  const priced = [run("p1", { costUsd: 4 }), run("p2", { costUsd: 5 }), run("p3", { costUsd: 30 })];
  const base = detectCostAnomalies(priced, policy as never);
  assert.deepEqual(base.map((f) => [f.runId, f.medianCostUsd]), [["p3", 5]]);
  const withFree = detectCostAnomalies([...priced, unpriced("u1"), unpriced("u2"), unpriced("u3")], policy as never);
  assert.deepEqual(withFree.map((f) => [f.runId, f.medianCostUsd, f.sampleSize, f.unpriced]), [["p3", 5, 3, 3]]);
  assert.equal(costAnomalyLine(withFree[0]!).unpriced, 3);
  assert.deepEqual(detectCostAnomalies(onlyUnpriced, policy as never), [], "all-unpriced class stays silent, no 0 median");

  // config-gardener: class costs and cohort spend skip the unpriced runs.
  const classCosts = settledClassCosts(mixed);
  assert.deepEqual(classCosts.byClass.get("c"), [9]);
  assert.equal(classCosts.unpriced.get("c"), 3);
  const outcome = cohortOutcome(mixed);
  assert.equal(outcome.costUsd, 9);
  assert.equal(outcome.unpriced, 3);
  assert.equal(cohortOutcome(onlyUnpriced).costUsd, null, "all inputs unpriced: unknown, never 0");

  // experiment-promotion: cost per merge of an unknown side is unmeasurable, not a free cohort.
  const known = { tasks: 4, merged: 2, costUsd: 10 };
  const obs = cohortGuardObservations(cohortOutcome(onlyUnpriced), known, "pop", "2026-10-08T12:00:00Z");
  const ratio = obs.find((o) => o.metricName === "cost_per_merged_ratio")!;
  assert.equal(ratio.denominator, 0);
  const ok = cohortGuardObservations(known, known, "pop", "2026-10-08T12:00:00Z").find((o) => o.metricName === "cost_per_merged_ratio")!;
  assert.equal(ok.denominator, 4);
  assert.equal(ok.value, 1);

  // retro-closure: the unpriced run is out of cost per merge and shown beside it.
  const closure = closureByClass(mixed, [{ runId: "a", taskId: "T-a" }], [], undefined);
  assert.equal(closure[0]!.costPerMerge, 9);
  assert.equal(closure[0]!.unpriced, 3);
  assert.match(renderClosureByClass(closure), /\$9\.000 \(unpriced: 3\)/);
  const allUnknown = closureByClass(onlyUnpriced, [{ runId: "b", taskId: "T-b" }], [], undefined);
  assert.equal(allUnknown[0]!.costPerMerge, null);
  assert.match(renderClosureByClass(allUnknown), /n\/a \(unpriced: 3\)/);

  // mount headroom sweep: percentiles and cost-per-task come from priced runs only.
  const [row] = computeClassSweep(mixed);
  assert.equal(row.costP50, 9);
  assert.equal(row.unpriced, 3);
  assert.equal(row.costPerCompletedTaskUsd, 9);
  const [none] = computeClassSweep(onlyUnpriced);
  assert.equal(none.costP50, null);
  assert.equal(none.costPerCompletedTaskUsd, null);
  const cells = computeArmSweep(mixed, new Map(), undefined);
  assert.equal(cells[0].arms[0].costP50, 9);
  assert.equal(cells[0].arms[0].unpriced, 3);
});
