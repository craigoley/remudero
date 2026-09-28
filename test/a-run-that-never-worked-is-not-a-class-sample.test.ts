// test/a-run-that-never-worked-is-not-a-class-sample.test.ts
//
// W1-T4711 — a run that threw, was refused at dispatch, or was backfilled by the operator ends on a
// verdict `isNeverWorkedVerdict` names (a stage in THROWN_RUN_VERDICT_STAGES, or `backfilled: true`).
// Its $0 and zero turns are setup only. `gatherRuns` now carries that as `neverWorked` on the
// RunSummary, and the three per-class readers over it — retro's overrun mining and class
// calibration, the mount-headroom class sweep, and the config gardener's budget recalibration —
// skip such runs and report how many they skipped. An ordinary `failed` run still counts.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  budgetCandidate,
  nearestRank,
  settledClassCosts,
  BUDGET_MIN_SAMPLES,
  type ConfigInventory,
  type QueuedBudget,
} from "../src/lib/config-gardener.js";
import { isNeverWorkedVerdict as costAnomalyIsNeverWorked } from "../src/lib/cost-anomaly.js";
import { isNeverWorkedVerdict } from "../src/lib/never-worked.js";
import {
  aggregateByClass,
  gatherRuns,
  mineOverrunClasses,
  mineOverrunClassesCounted,
  type LedgerRecord,
} from "../src/lib/retro.js";
import { REFUSED_RUN_VERDICT_STAGE_LIST, THROWN_RUN_VERDICT_STAGES } from "../src/lib/status.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "mount-headroom-sweep.mjs");
const sweep = (await import(pathToFileURL(SCRIPT).href)) as {
  computeClassSweep: (runs: unknown[]) => Array<{
    taskClass: string;
    totalRuns: number;
    settledRuns: number;
    turnsP50: number | null;
    turnsP90: number | null;
    costP50: number | null;
    costP90: number | null;
    excludedCount?: number;
  }>;
};

const T0 = Date.parse("2026-09-28T00:00:00.000Z");
const MIN = 60_000;
const CLASS = "src";

function run(id: string, i: number, verdict: Record<string, unknown>, turns: number): LedgerRecord[] {
  const ts = (ms: number) => new Date(T0 + i * 10 * MIN + ms).toISOString();
  const lines: LedgerRecord[] = [
    { ts: ts(0), run_id: id, task_id: `W1-${id}`, step: "run.start", type: "implement", risk: "low", task_class: CLASS },
  ];
  if (turns > 0) lines.push({ ts: ts(MIN), run_id: id, task_id: `W1-${id}`, step: "implement.done", num_turns: turns });
  lines.push({ ts: ts(2 * MIN), run_id: id, task_id: `W1-${id}`, step: "verdict", ...verdict });
  return lines;
}

/** Ten real runs: cost $1..$10, turns 10..100 — p50 $5 / 50 turns, p90 $9 / 90 turns. */
function realRuns(): LedgerRecord[] {
  return Array.from({ length: 10 }, (_, i) => run(`REAL-${i}`, i, { verdict: "merged", cost_usd: i + 1 }, 10 * (i + 1))).flat();
}

/** Ten runs refused at dispatch: `failed`, a refused-dispatch stage, $0, zero turns. */
function refusedRuns(): LedgerRecord[] {
  return Array.from({ length: 10 }, (_, i) =>
    run(`REFUSED-${i}`, 10 + i, { verdict: "failed", stage: REFUSED_RUN_VERDICT_STAGE_LIST[i % REFUSED_RUN_VERDICT_STAGE_LIST.length], cost_usd: 0 }, 0),
  ).flat();
}

/** Ten backfilled phantom verdicts: no stage at all, so `backfilled: true` alone must exclude them. */
function backfilledRuns(): LedgerRecord[] {
  return Array.from({ length: 10 }, (_, i) => run(`BACKFILL-${i}`, 20 + i, { verdict: "failed", backfilled: true, cost_usd: 0 }, 0)).flat();
}

/** Two ordinary failed runs that did work — still an overrun, still a sample. */
function ordinaryFailedRuns(): LedgerRecord[] {
  return Array.from({ length: 2 }, (_, i) => run(`FAILED-${i}`, 30 + i, { verdict: "failed", cost_usd: 4 }, 40)).flat();
}

test("W1-T4711: gatherRuns flags a refused, thrown or backfilled verdict neverWorked — never an ordinary failed one", () => {
  const runs = gatherRuns([...realRuns(), ...refusedRuns(), ...backfilledRuns(), ...ordinaryFailedRuns()]);
  const flagged = runs.filter((r) => r.neverWorked).map((r) => r.runId).sort();
  assert.equal(flagged.length, 20);
  assert.ok(flagged.every((id) => id.startsWith("REFUSED-") || id.startsWith("BACKFILL-")), flagged.join(","));
  for (const r of runs.filter((x) => x.runId.startsWith("REAL-") || x.runId.startsWith("FAILED-"))) {
    assert.equal("neverWorked" in r, false, `${r.runId} did work and carries no flag`);
  }
  for (const stage of THROWN_RUN_VERDICT_STAGES) {
    assert.equal(gatherRuns(run("ONE", 0, { verdict: "failed", stage }, 0))[0]!.neverWorked, true, `stage ${stage}`);
  }
  assert.equal(costAnomalyIsNeverWorked, isNeverWorkedVerdict, "cost-anomaly re-exports the one rule, never a second copy");
});

test("W1-T4711: retro mines no overrun class from refusals, and counts what it skipped", () => {
  const runs = gatherRuns([...realRuns(), ...refusedRuns()]);
  assert.deepEqual(mineOverrunClasses(runs), [], "ten refusals are a host condition, not a class overrun");
  const counted = mineOverrunClassesCounted(runs);
  assert.deepEqual(counted.proposals, []);
  assert.equal(counted.excludedCount, 10);
});

test("W1-T4711: an ordinary failed run is still mined as an overrun beside the skipped refusals and backfills", () => {
  const runs = gatherRuns([...realRuns(), ...refusedRuns(), ...backfilledRuns(), ...ordinaryFailedRuns()]);
  const counted = mineOverrunClassesCounted(runs);
  assert.equal(counted.excludedCount, 20);
  assert.equal(counted.proposals.length, 1);
  assert.equal(counted.proposals[0]!.count, 2, "only the two ordinary failed runs");
  assert.deepEqual(counted.proposals[0]!.taskIds, ["W1-FAILED-0", "W1-FAILED-1"]);
});

test("W1-T4711: retro's class calibration averages the real runs alone and reports the excluded count", () => {
  const [row] = aggregateByClass(gatherRuns([...realRuns(), ...refusedRuns(), ...backfilledRuns()]));
  assert.equal(row!.taskClass, CLASS);
  assert.equal(row!.runs, 10);
  assert.equal(row!.avgCostUsd, 5.5);
  assert.equal(row!.avgTurns, 55);
  assert.equal(row!.mergeRate, 1);
  assert.equal(row!.excludedCount, 20);
  const [plain] = aggregateByClass(gatherRuns([...realRuns(), ...ordinaryFailedRuns()]));
  assert.equal(plain!.runs, 12, "ordinary failed runs are counted exactly as before");
  assert.equal("excludedCount" in plain!, false, "nothing excluded, no field");
});

test("W1-T4711: the mount-headroom class p50/p90 match the ten real runs alone", () => {
  const [real] = sweep.computeClassSweep(gatherRuns(realRuns()));
  const [mixed] = sweep.computeClassSweep(gatherRuns([...realRuns(), ...refusedRuns(), ...backfilledRuns()]));
  assert.equal(real!.costP50, 5);
  assert.equal(real!.turnsP50, 50);
  assert.equal(mixed!.costP50, real!.costP50);
  assert.equal(mixed!.turnsP50, real!.turnsP50);
  assert.equal(mixed!.costP90, real!.costP90);
  assert.equal(mixed!.turnsP90, real!.turnsP90);
  assert.equal(mixed!.settledRuns, 10);
  assert.equal(mixed!.totalRuns, 30, "the total still shows every run");
  assert.equal(mixed!.excludedCount, 20);
  assert.equal("excludedCount" in real!, false);
  const [withFailed] = sweep.computeClassSweep(gatherRuns([...realRuns(), ...ordinaryFailedRuns()]));
  assert.equal(withFailed!.settledRuns, 12, "an ordinary failed run is still a sample");
});

test("W1-T4711: the gardener's per-class cost p90 matches the ten real runs alone", () => {
  const { byClass, excluded } = settledClassCosts(gatherRuns([...realRuns(), ...refusedRuns(), ...backfilledRuns(), ...ordinaryFailedRuns()]));
  const costs = byClass.get(CLASS)!;
  assert.equal(costs.length, 12, "ten real runs and two ordinary failed ones");
  assert.equal(excluded.get(CLASS), 20);
  const realOnly = settledClassCosts(gatherRuns(realRuns()));
  assert.equal(nearestRank(settledClassCosts(gatherRuns([...realRuns(), ...refusedRuns()])).byClass.get(CLASS)!, 90), nearestRank(realOnly.byClass.get(CLASS)!, 90));
  assert.equal(realOnly.excluded.size, 0);
});

test("W1-T4711: the gardener recalibrates a budget from real runs only and names the excluded count", () => {
  const real = Array.from({ length: BUDGET_MIN_SAMPLES }, (_, i) => run(`REAL-${i}`, i, { verdict: "merged", cost_usd: (i % 10) + 1 }, 10)).flat();
  const refused = Array.from({ length: BUDGET_MIN_SAMPLES }, (_, i) => run(`REFUSED-${i}`, 100 + i, { verdict: "failed", stage: "dispatch.claim", cost_usd: 0 }, 0)).flat();
  const queued: QueuedBudget[] = Array.from({ length: 10 }, (_, i) => ({
    id: `W1-Q${i}`,
    taskClass: CLASS,
    budgetUsd: 100,
    shard: `plan/tasks.d/W1-Q${i}.yaml`,
    line: "  budget_usd: 100.00",
  }));
  const inv = (records: LedgerRecord[]): ConfigInventory => ({ nowIso: new Date(T0).toISOString(), runs: gatherRuns(records), queued, recommendations: [], active: [], cooling: [] });
  const alone = budgetCandidate(inv(real), () => 0)!;
  const mixed = budgetCandidate(inv([...real, ...refused]), () => 0)!;
  assert.ok(alone && mixed, "both inventories propose a recalibration");
  assert.deepEqual(mixed.edits, alone.edits, "the $0 refusals move no budget");
  assert.equal(mixed.shadowObservations[0]!.denominator, BUDGET_MIN_SAMPLES);
  assert.equal(mixed.excludedCount, BUDGET_MIN_SAMPLES);
  assert.match(mixed.reason, new RegExp(`p90 of ${BUDGET_MIN_SAMPLES} settled implement runs is \\$9\\.00.*${BUDGET_MIN_SAMPLES} never-worked run\\(s\\) excluded`));
  assert.equal("excludedCount" in alone, false);
});
