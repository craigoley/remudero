import assert from "node:assert/strict";
import { test } from "node:test";
import { terminalVerdictFields } from "../src/run-task.js";
import { aggregateByType, aggregateByClass, aggregateWeeklyBurnByModelClass, calibrationTable, classCalibrationTable, modelClassWeeklyBurnTable, buildGather, renderGather, shippedSince, gatherRuns, type LedgerRecord } from "../src/lib/retro.js";
import { notionalSpendUsd, spendAmountUsd } from "../src/lib/spend-rows.js";
import { workerLedgerFields, type WorkerResult } from "../src/lib/worker.js";
import { codexNotionalCostUsd, openWeightPriceFor, OpenWeightUnpricedDeploymentError } from "../src/lib/worker-provider.js";

import { detectCostAnomalies } from "../src/lib/cost-anomaly.js";
import { cohortOutcome, settledClassCosts } from "../src/lib/config-gardener.js";
import { cohortGuardMetrics, cohortGuardObservations, evaluateGuardrails, CANARY_COST_PER_MERGED_RATIO } from "../src/lib/experiment-promotion.js";
import { closureByClass, renderClosureByClass } from "../src/lib/retro-closure.js";

const tokens = { input: 1_000_000, output: 100_000, cacheRead: 400_000, cacheCreation: 0 };

function worker(model: string, provider: WorkerResult["provider"] = "codex"): WorkerResult {
  return {
    provider, model: "opus", routedModel: model, costUsd: 0, numTurns: 1,
    tokens, notionalCostUsd: codexNotionalCostUsd(model, tokens),
    isError: false, apiError: false, subtype: "success", childEnvKeys: [],
    sessionId: "codex-session", text: "done", blocks: ["done"], stderr: "",
    permissionDenials: [], effort: "high", modelUsage: {}, compactionEvents: [],
    compactionConfigured: false, qualitySuspect: false,
  };
}

function row(step: string, fields: Record<string, unknown> = {}): LedgerRecord {
  return { ts: "2026-10-08T12:00:00.000Z", run_id: "codex-run", task_id: "W1-T5664", step, ...fields };
}

for (const [model, expected] of [["gpt-6-sol", 2.28], ["gpt-5.6-sol", 4.56]] as const) {
  test(`a codex run with ${model} tokens carries its notional through the verdict into gatherRuns`, () => {
    const result = worker(model);
    assert.equal(result.notionalCostUsd, expected);
    const fields = terminalVerdictFields(result);
    assert.equal(notionalSpendUsd(fields), expected);
    assert.equal(spendAmountUsd(fields), 0);
    assert.equal(fields.spend_role, "restated");
    const runs = gatherRuns([row("run.start", { type: "implement" }), row("verdict", { verdict: "merged", cost_usd: 0, ...fields })]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].costUsd, expected);
    assert.equal(runs[0].costSource, undefined);
    assert.throws(() => openWeightPriceFor(model), OpenWeightUnpricedDeploymentError);
  });
}

test("an unverdicted codex run sums worker notionals and ignores probe cash", () => {
  const fields = workerLedgerFields(worker("gpt-6-sol"));
  const [run] = gatherRuns([
    row("run.start", { type: "implement" }), row("containment.probe", { cost_usd: 99 }),
    row("recon.done", fields), row("implement.done", fields), row("implement.resumed", fields),
  ]);
  assert.equal(run.costUsd, 2.28 * 3);
});

test("an unpriced codex verdict has no notional receipt and is marked unknown in gatherRuns", () => {
  const fields = terminalVerdictFields(worker("unknown-model"));
  assert.equal(Object.hasOwn(fields, "notional_cost_usd"), false);
  assert.equal(notionalSpendUsd(fields), undefined);
  const [run] = gatherRuns([row("run.start"), row("verdict", { verdict: "failed", cost_usd: 0, ...fields })]);
  assert.equal(run.costSource, "none");
  assert.equal(Object.hasOwn(run, "costUsd"), false);
});

test("an unpriced codex worker leaves an unverdicted run marked unknown", () => {
  const fields = workerLedgerFields(worker("unknown-model"));
  const [run] = gatherRuns([row("run.start"), row("implement.done", fields)]);
  assert.equal(run.costSource, "none");
  assert.equal(Object.hasOwn(run, "costUsd"), false);
});

test("claude verdict cash retains its existing precedence and never takes a codex notional", () => {
  const fields = terminalVerdictFields({ ...worker("gpt-6-sol", "claude"), costUsd: 3 });
  assert.equal(Object.hasOwn(fields, "notional_cost_usd"), false);
  const [run] = gatherRuns([row("run.start"), row("verdict", { cost_usd: 7, ...fields })]);
  assert.equal(run.costUsd, 7);
  assert.deepEqual(terminalVerdictFields(null), { model: null, served_model: null });
});

test("codex notional pricing preserves existing base rates and bounds cached input", () => {
  assert.equal(codexNotionalCostUsd("gpt-6.1-sol", tokens), 2.24);
  assert.equal(codexNotionalCostUsd("gpt-6-sol", { input: 100, output: 0, cacheRead: 500 }), 0.00002);
  assert.equal(codexNotionalCostUsd("gpt-6-sol", { input: 0, output: 0, cacheRead: 0 }), 0);
  assert.equal(codexNotionalCostUsd("toString", tokens), undefined);
});


test("absent run costs remain unknown through calibration, shipped credit and rendering", () => {
  const fields = terminalVerdictFields(worker("unknown-model"));
  const records = [row("run.start", { type: "implement", task_class: "src", risk: "low" }),
    row("verdict", { verdict: "merged", pr_url: "https://example.test/1", ...fields })];
  const runs = gatherRuns(records);
  const [type] = aggregateByType(runs);
  const [cls] = aggregateByClass(runs);
  assert.equal(type.totalCostUsd, null);
  assert.equal(type.avgCostUsd, null);
  assert.equal(cls.totalCostUsd, null);
  assert.equal(cls.avgCostUsd, null);
  assert.match(calibrationTable([type]), /unknown/);
  assert.match(classCalibrationTable([cls]), /unknown/);
  const weekly = aggregateWeeklyBurnByModelClass(runs, { mounts: [] } as never, Date.parse("2026-10-08T12:00:00Z"));
  assert.equal(weekly[0].costUsdThisWeek, null);
  assert.match(modelClassWeeklyBurnTable(weekly), /unknown/);
  const github = { headRefName: () => "run-codex-run", findMergedByTrailer: () => null };
  const shipped = shippedSince(runs, undefined, github).shipped;
  assert.equal(Object.hasOwn(shipped[0], "costUsd"), false);
  const gather = buildGather({ ledgerNdjson: records.map((r) => JSON.stringify(r)).join("\n"), learningsMd: "" });
  const rendered = renderGather(gather);
  assert.match(rendered, /https:\/\/example.test\/1 · unknown cost/);
  assert.doesNotMatch(rendered, /NaN|\$0\.000/);
});

test("a partly priced worker run is unknown while a measured zero stays a price", () => {
  const [partial] = gatherRuns([row("run.start"), row("recon.done", workerLedgerFields(worker("gpt-6-sol"))),
    row("implement.done", workerLedgerFields(worker("unknown-model")))]);
  assert.equal(Object.hasOwn(partial, "costUsd"), false);
  const [zero] = gatherRuns([row("run.start"), row("verdict", { provider: "codex", notional_cost_usd: 0, cost_usd: 0 })]);
  assert.equal(zero.costUsd, 0);
  assert.equal(zero.costSource, undefined);
  const [mixed] = aggregateByType([zero, partial]);
  assert.equal(mixed.runs, 2);
  assert.equal(mixed.totalCostUsd, null);
  assert.equal(mixed.avgCostUsd, null);
});


test("missing prices cannot anchor anomaly samples, budgets, canaries or closure totals", () => {
  const runs = Array.from({ length: 5 }, (_, i) => ({ runId: String(i), taskId: String(i),
    type: "implement", risk: "low", taskClass: "src", startTs: "2026-10-08T12:00:00Z",
    verdict: "merged", numTurns: 10, ...(i === 4 ? { costUsd: 10 } : {}) }));
  assert.deepEqual(detectCostAnomalies(runs, { minSamples: 5, multiplier: 3 } as never), []);
  assert.deepEqual(settledClassCosts(runs).byClass.get("src"), [10]);
  const cohort = cohortOutcome(runs);
  assert.equal(cohort.tasks, 5);
  assert.equal(cohort.merged, 5);
  assert.equal(Object.hasOwn(cohort, "costUsd"), false);
  const priced = { tasks: 5, merged: 5, costUsd: 10 };
  for (const sides of [[cohort, priced], [priced, cohort]]) {
    const observations = cohortGuardObservations(sides[0], sides[1], "same-class", "2026-10-08T12:00:00Z");
    assert.equal(observations.some((o) => o.metricName === CANARY_COST_PER_MERGED_RATIO), false);
    const guard = evaluateGuardrails({ guardMetrics: cohortGuardMetrics(), denominatorFloor: 1,
      comparisonPopulation: "same-class", observationWindow: { start: "2026-10-08T00:00:00Z", end: "2026-10-09T00:00:00Z" },
      expiresAt: "2026-10-09T00:00:00Z" }, observations, "2026-10-08T12:00:00Z");
    assert.equal(guard.state, "unmeasurable");
    assert.match(guard.reasons.join(" "), /missing guard observation for cost_per_merged_ratio/);
  }
  const closure = closureByClass(runs, [{ runId: "4", taskId: "4" }], [], undefined);
  assert.equal(closure[0].costPerMerge, null);
  assert.match(renderClosureByClass(closure), /unknown cost/);
});

test("mount sweep cost distributions omit missing receipts and refuse incomplete task totals", async () => {
  // @ts-expect-error the read-only sweep has no TypeScript declaration
  const sweep = await import("../scripts/mount-headroom-sweep.mjs");
  const runs = [{ runId: "known", taskId: "known", type: "implement", risk: "low", taskClass: "src", verdict: "merged", numTurns: 10, costUsd: 2 },
    { runId: "unknown", taskId: "unknown", type: "implement", risk: "low", taskClass: "src", verdict: "merged", numTurns: 20 }];
  const [cls] = sweep.computeClassSweep(runs);
  const [cell] = sweep.computeArmSweep(runs, new Map(), undefined);
  for (const result of [cls, cell.arms[0]]) {
    assert.equal(result.settledRuns, 2);
    assert.equal(result.costP50, 2);
    assert.equal(result.costP90, 2);
    assert.equal(result.costMax, 2);
    assert.equal(result.totalSettledCostUsd, null);
    assert.equal(result.costPerCompletedTaskUsd, null);
    assert.equal(result.unpricedRuns, 1);
  }
});
