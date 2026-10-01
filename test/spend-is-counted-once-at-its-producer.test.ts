import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deriveAnalyticsSnapshot } from "../src/lib/analytics-route.js";
import { buildAnalyticsTimeSeries } from "../src/lib/analytics-timeseries.js";
import { isProducedSpendRow, SPEND_STEP_ROLES, spendAmountUsd } from "../src/lib/spend-rows.js";
import { terminalVerdictFields } from "../src/run-task.js";

/**
 * W1-T4066 — a cost is counted once, at the row of the step that PRODUCED it. The old rule ("a row with a string
 * `model` adds its `total_cost_usd`") counted each run's last worker twice (the `verdict` row restates it) and never
 * saw `fix.done` or the probes, which carry `cost_usd` and no `model`.
 */

const NOW = "2026-09-22T12:00:00.000Z";
const TS = "2026-09-22T01:00:00.000Z";

const implement = { ts: TS, run_id: "R1", step: "implement.done", lane: "run-task", model: "sonnet", total_cost_usd: 3 };
// Exactly what `terminalVerdictFields` writes: the same model and the same cost as the last worker row.
const verdict = { ts: TS, run_id: "R1", step: "verdict", lane: "run-task", model: "sonnet", total_cost_usd: 3, spend_role: "restated" };

function seriesTotal(rows: Array<Record<string, unknown>>): number {
  const cost = buildAnalyticsTimeSeries(rows, NOW).find((s) => s.id === "cost.modeled.usd");
  assert.ok(cost, "the cost series is always present");
  return cost.points.reduce((sum, p) => sum + (typeof p.value === "number" ? p.value : 0), 0);
}

function modeledUsd(rows: Array<Record<string, unknown>>): number {
  const metric = deriveAnalyticsSnapshot(rows, NOW).consoleV1.metrics.find((m) => m.key === "cost.modeled.usd");
  assert.ok(metric, "the console projection always names cost.modeled.usd");
  return metric.value as number;
}

test("W1-T4066: a verdict restating its last worker adds nothing to cost modeled usd", () => {
  assert.equal(modeledUsd([implement, verdict]), 3, "the snapshot counts the worker row once");
  assert.equal(seriesTotal([implement, verdict]), 3, "the daily series counts the worker row once");
  // A verdict from before the label existed is still recognised by its step.
  const { spend_role: _label, ...unlabelled } = verdict;
  assert.equal(modeledUsd([implement, unlabelled]), 3);
  assert.equal(seriesTotal([implement, unlabelled]), 3);
  // The bucket by lane/model agrees with the total.
  const snapshot = deriveAnalyticsSnapshot([implement, verdict], NOW);
  assert.equal(snapshot.workersByLaneModel.reduce((sum, b) => sum + b.totalCostUsd, 0), 3);
  // The writer labels the restatement.
  assert.equal(terminalVerdictFields(null).model, null);
  const written = terminalVerdictFields({
    model: "sonnet", servedModel: "sonnet", costUsd: 3, isError: false, subtype: "success",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
  } as unknown as Parameters<typeof terminalVerdictFields>[0]);
  assert.equal(written.spend_role, "restated");
  assert.equal(isProducedSpendRow({ step: "verdict", ...written }), false);
});

test("W1-T4066: fix rung and probe cost_usd rows are counted once", () => {
  const fix = { ts: TS, run_id: "R1", step: "fix.done", session_id: "S1", cost_usd: 4.5 };
  const containment = { ts: TS, run_id: "R1", step: "containment.probe", cost_usd: 0.25 };
  const isolation = { ts: TS, run_id: "R1", step: "isolation.probe", cost_usd: 0.25 };
  const rows = [implement, verdict, fix, containment, isolation];
  assert.equal(modeledUsd(rows), 3 + 4.5 + 0.25 + 0.25);
  assert.equal(seriesTotal(rows), 3 + 4.5 + 0.25 + 0.25);
  // A row carrying BOTH fields is one cost, not two; a missing cost stays absent rather than reading as 0.
  assert.equal(spendAmountUsd({ step: "implement.done", model: "sonnet", total_cost_usd: 2, cost_usd: 2 }), 2);
  assert.equal(spendAmountUsd({ step: "fix.done" }), undefined);
  assert.equal(isProducedSpendRow({ step: "fix.done" }), false);
});

test("W1-T4066: two produced rows sharing a session_id are both counted", () => {
  const synthesized = { ts: TS, step: "retro.synthesized", session_id: "S9", cost_usd: 10 };
  const repair = { ts: TS, step: "retro.preflight_repair", session_id: "S9", cost_usd: 5.77 };
  assert.equal(modeledUsd([synthesized, repair]), 15.77);
  assert.equal(seriesTotal([synthesized, repair]), 15.77);
});

/** Every literal step passed to a `log(…)` call whose payload names a cost or spreads `workerLedgerFields`. */
function costBearingLogSteps(dir: string, found: Map<string, string>): Map<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      costBearingLogSteps(path, found);
      continue;
    }
    if (!path.endsWith(".ts")) continue;
    const text = readFileSync(path, "utf8");
    for (const m of text.matchAll(/\blog\w*\(\s*(["'])([A-Za-z0-9_.:-]+)\1\s*,/g)) {
      let depth = 0;
      let end = text.indexOf("(", m.index);
      for (; end < text.length; end++) {
        if (text[end] === "(") depth++;
        else if (text[end] === ")" && --depth === 0) break;
      }
      if (/\b(total_cost_usd|cost_usd)\b|workerLedgerFields\(/.test(text.slice(m.index, end))) found.set(m[2], path);
    }
  }
  return found;
}

test("W1-T4066: every cost-bearing log step declares a spend role", () => {
  const steps = costBearingLogSteps("src", new Map());
  // Positive control: the census must see the steps this task is about, or its zero would mean nothing.
  for (const known of ["verdict", "fix.done", "containment.probe", "isolation.probe"]) {
    assert.ok(steps.has(known), `the census reads ${known} out of src`);
  }
  const undeclared = [...steps].filter(([step]) => !Object.hasOwn(SPEND_STEP_ROLES, step));
  assert.deepEqual(
    undeclared,
    [],
    "a cost-bearing step must be listed in SPEND_STEP_ROLES (src/lib/spend-rows.ts) as produced or restated",
  );
  assert.equal(SPEND_STEP_ROLES.verdict, "restated");
  assert.equal(SPEND_STEP_ROLES["cost.anomaly"], "restated");
});
