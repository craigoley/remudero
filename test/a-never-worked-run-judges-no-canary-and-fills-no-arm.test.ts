// test/a-never-worked-run-judges-no-canary-and-fills-no-arm.test.ts
//
// W1-T4726 — W1-T4711 flags a thrown, refused or backfilled run `neverWorked` on its RunSummary and
// keeps it out of the per-class samples. Three readers still took it as settled work: the config
// gardener's canary judging (`splitCohort`/`cohortOutcome`), the mount-headroom per-arm cells
// (`computeArmSweep`), and `redispatchedRunIds`, which read a refusal followed by a real run as a
// re-dispatch of that real run. Each now skips the flagged runs and reports how many it skipped; an
// ordinary `failed` run that did work is judged exactly as before.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cohortOutcome, splitCohort, type ConfigCohort } from "../src/lib/config-gardener.js";
import { cohortGuardObservations } from "../src/lib/experiment-promotion.js";
import { gatherRuns, type LedgerRecord, type RunSummary } from "../src/lib/retro.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "mount-headroom-sweep.mjs");

interface Arm { armKey: string; n: number; totalRuns: number; settledRuns: number; costP50: number | null; turnsP50: number | null; outcomes: { passing: number; redispatched: number } }
interface Cell { cellKey: string; arms: Arm[]; comparisons: unknown[]; excludedCount?: number }
type Fields = { provider: string; servedModel: string; effort: string };
const sweep = (await import(pathToFileURL(SCRIPT).href)) as {
  computeArmSweep: (runs: unknown[], armFields: Map<string, Fields>, newestTs?: string) => Cell[];
  computeClassSweep: (runs: unknown[]) => Array<{ outcomes: { redispatched: number } }>;
  redispatchedRunIds: (runs: unknown[]) => Set<string>;
  redispatchedRunIdsCounted: (runs: unknown[]) => { ids: Set<string>; excludedCount?: number };
};

const T0 = Date.parse("2026-09-28T00:00:00.000Z");
const MIN = 60_000;
const CLASS = "src";
const EXPOSED_AT = new Date(T0).toISOString();
const NOW = new Date(T0 + 24 * 60 * MIN).toISOString();

function run(id: string, taskId: string, minute: number, verdict: Record<string, unknown>, turns: number): LedgerRecord[] {
  const ts = (ms: number) => new Date(T0 + minute * MIN + ms).toISOString();
  const lines: LedgerRecord[] = [
    { ts: ts(0), run_id: id, task_id: taskId, step: "run.start", type: "implement", risk: "low", task_class: CLASS },
  ];
  if (turns > 0) lines.push({ ts: ts(1000), run_id: id, task_id: taskId, step: "implement.done", num_turns: turns });
  lines.push({ ts: ts(2000), run_id: id, task_id: taskId, step: "verdict", ...verdict });
  return lines;
}

const refusal = (id: string, taskId: string, minute: number) =>
  run(id, taskId, minute, { verdict: "failed", stage: "dispatch.claim", cost_usd: 0 }, 0);

/** Five real canary runs: T0..T2 merge ($1..$3), T3 and T4 fail ordinarily after real work ($4, $5). */
function realCanary(): LedgerRecord[] {
  return [0, 1, 2, 3, 4]
    .map((i) => run(`REAL-${i}`, `W1-T${i}`, 10 + i * 10, i < 3 ? { verdict: "merged", cost_usd: i + 1 } : { verdict: "failed", cost_usd: i + 1 }, 10 * (i + 1)))
    .flat();
}

/** Five refused dispatches in the cohort: T0 and T1 BEFORE their real runs, T5..T7 never re-run. */
function refusedCanary(): LedgerRecord[] {
  return [refusal("REF-0", "W1-T0", 5), refusal("REF-1", "W1-T1", 15), refusal("REF-5", "W1-T5", 60), refusal("REF-6", "W1-T6", 61), refusal("REF-7", "W1-T7", 62)].flat();
}

/** The rest of the class, outside the cohort: four real merged runs. */
function restRuns(): LedgerRecord[] {
  return [0, 1, 2, 3].map((i) => run(`REST-${i}`, `W1-R${i}`, 100 + i, { verdict: "merged", cost_usd: 2 }, 20)).flat();
}

const COHORT: ConfigCohort = { kind: "tasks", taskClass: CLASS, taskIds: ["W1-T0", "W1-T1", "W1-T2", "W1-T3", "W1-T4", "W1-T5", "W1-T6", "W1-T7"] };
const ids = (runs: RunSummary[]) => runs.map((r) => r.runId).sort();

test("W1-T4726: a canary cohort of five real runs and five refused dispatches judges the five real runs alone", () => {
  const real = splitCohort(COHORT, gatherRuns([...realCanary(), ...restRuns()]), EXPOSED_AT, NOW);
  const mixed = splitCohort(COHORT, gatherRuns([...realCanary(), ...refusedCanary(), ...restRuns()]), EXPOSED_AT, NOW);
  assert.deepEqual(ids(mixed.canary), ["REAL-0", "REAL-1", "REAL-2", "REAL-3", "REAL-4"]);
  assert.deepEqual(ids(mixed.rest), ids(real.rest));
  assert.equal(mixed.excludedCount, 5, "the split names what it skipped");
  assert.equal("excludedCount" in real, false, "nothing skipped, no field");
  assert.deepEqual(cohortOutcome(mixed.canary), { tasks: 5, merged: 3, costUsd: 15 });
  assert.deepEqual(cohortOutcome(mixed.canary), cohortOutcome(real.canary));
  assert.deepEqual(
    cohortGuardObservations(cohortOutcome(mixed.canary), cohortOutcome(mixed.rest), "p", NOW),
    cohortGuardObservations(cohortOutcome(real.canary), cohortOutcome(real.rest), "p", NOW),
  );
});

test("W1-T4726: cohortOutcome itself skips a never-worked run and counts it, and still counts an ordinary failed run", () => {
  const runs = gatherRuns([...realCanary(), ...refusedCanary()]);
  assert.deepEqual(cohortOutcome(runs), { tasks: 5, merged: 3, costUsd: 15, excludedCount: 5 });
  assert.deepEqual(cohortOutcome(gatherRuns(realCanary())), { tasks: 5, merged: 3, costUsd: 15 }, "two ordinary failed tasks still count");
});

test("W1-T4726: a cell or all-runs cohort also leaves never-worked runs out of both sides", () => {
  const before = [0, 1].map((i) => run(`OLD-${i}`, `W1-O${i}`, -30 - i, { verdict: "merged", cost_usd: 1 }, 10)).flat();
  const oldRefusal = refusal("OLD-REF", "W1-O9", -40);
  const runs = gatherRuns([...realCanary(), ...refusedCanary(), ...before, ...oldRefusal]);
  for (const cohort of [{ kind: "cell", type: "implement", risk: "low", taskClass: CLASS }, { kind: "all" }] as ConfigCohort[]) {
    const split = splitCohort(cohort, runs, EXPOSED_AT, new Date(T0 + 120 * MIN).toISOString());
    assert.deepEqual(ids(split.canary), ["REAL-0", "REAL-1", "REAL-2", "REAL-3", "REAL-4"], cohort.kind);
    assert.deepEqual(ids(split.rest), ["OLD-0", "OLD-1"], cohort.kind);
    assert.equal(split.excludedCount, 6, cohort.kind);
  }
});

test("W1-T4726: the first real run after a refusal is not a re-dispatch; a real re-run still is", () => {
  const mixed = gatherRuns([...realCanary(), ...refusedCanary()]);
  assert.deepEqual([...sweep.redispatchedRunIds(mixed)], [], "REAL-0 and REAL-1 follow only a refusal");
  const counted = sweep.redispatchedRunIdsCounted(mixed);
  assert.deepEqual([...counted.ids], []);
  assert.equal(counted.excludedCount, 5);
  const [row] = sweep.computeClassSweep(mixed);
  assert.equal(row!.outcomes.redispatched, 0);
  const rerun = gatherRuns([...realCanary(), ...refusedCanary(), ...run("REAL-0b", "W1-T0", 200, { verdict: "merged", cost_usd: 1 }, 10)]);
  assert.deepEqual([...sweep.redispatchedRunIds(rerun)], ["REAL-0b"], "a second REAL run of W1-T0 is a re-dispatch");
  const afterFailed = gatherRuns([...realCanary(), ...run("REAL-3b", "W1-T3", 200, { verdict: "merged", cost_usd: 1 }, 10)]);
  const plain = sweep.redispatchedRunIdsCounted(afterFailed);
  assert.deepEqual([...plain.ids], ["REAL-3b"], "an ordinary failed run did work, so its successor is a re-dispatch");
  assert.equal("excludedCount" in plain, false);
});

test("W1-T4726: a never-worked run fills no mount-headroom arm cell, and the cell counts it", () => {
  const armOf = new Map<string, Fields>();
  const claude: Fields = { provider: "anthropic", servedModel: "opus", effort: "high" };
  for (let i = 0; i < 5; i++) armOf.set(`REAL-${i}`, claude);
  armOf.set("REF-0", claude);
  armOf.set("REF-1", claude);
  const real = sweep.computeArmSweep(gatherRuns(realCanary()), armOf, NOW);
  const mixed = sweep.computeArmSweep(gatherRuns([...realCanary(), ...refusedCanary()]), armOf, NOW);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0]!.excludedCount, 5);
  assert.deepEqual(mixed[0]!.arms.map((a) => a.armKey), real[0]!.arms.map((a) => a.armKey), "the unattributed refusals open no 'unknown' arm");
  assert.deepEqual(mixed[0]!.arms, real[0]!.arms, "every arm figure equals the real runs alone");
  assert.deepEqual(mixed[0]!.comparisons, []);
  const arm = real[0]!.arms[0]!;
  assert.equal(arm.n, 5, "two ordinary failed runs are still samples");
  assert.equal(arm.outcomes.passing, 3);
  assert.equal(arm.costP50, 3);
  assert.equal("excludedCount" in real[0]!, false, "nothing skipped, no field");
  const [onlyRefused] = sweep.computeArmSweep(gatherRuns(refusedCanary()), armOf, NOW);
  assert.deepEqual(onlyRefused!.arms, [], "a cell of refusals alone has no arm");
  assert.equal(onlyRefused!.excludedCount, 5);
});
