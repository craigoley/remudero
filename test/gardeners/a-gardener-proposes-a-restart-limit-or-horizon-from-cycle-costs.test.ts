/**
 * W1-T12232 — the config gardener's `retune-restart` class: it reads the complete `daemon.restart_cycle` rows
 * W1-T12229 writes, compares the median cost of waiting with the median cost of restarting, and proposes one
 * bounded, one-line edit of `freshnessRestart.scoreLimit` or `freshnessRestart.stalenessHorizonMs` through the
 * same canary every other class goes through. Each test is named for the criterion it proves.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import {
  applyConfigEdits, configCandidates, configGardenSpec, configPromotion, CONFIG_GARDEN_LEDGER_STEPS,
  freshnessRestartRowLine, freshnessRowsChangedAt, restartCycleSample, restartTuneCandidate, restartTuneReading,
  RESTART_CYCLE_STEP, RESTART_TUNE_FACTOR, RESTART_TUNE_SAMPLE, RESTART_TUNE_STEP,
  type ConfigCanary, type ConfigInventory, type RestartCycleSample,
} from "#src/lib/config-gardener.js";
import { enterCanary } from "#src/lib/experiment-promotion.js";
import type { GardenerDeps } from "#src/lib/gardener.js";
import { policyPath } from "#src/lib/policy.js";
import { ownedFixtureDir, type FixtureScope } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const NOW_MS = Date.parse("2026-11-22T12:00:00.000Z");
const ISO = fixedClock(NOW_MS).iso();
/** The last change of either policy row, as the gardener reads it from the history. */
const SINCE = fixedClock(Date.parse("2026-11-14T06:13:42.000Z")).iso();
const rng = () => 0;

/** A freshness decision that staleness released: the change weight alone stayed under the limit. */
const AGE_TRIGGER = "busy, but pressure 20 (change 2 + staleness 18) >= 18: drain and restart";
/** A freshness decision a material change released on its own. */
const CHANGE_TRIGGER = "busy, but pressure 25 (change 25 + staleness 0) >= 18: drain and restart";

/** One `daemon.restart_cycle` row as W1-T12229 writes it; a null cost part is written null and named. */
function cycleRow(opts: { atMs: number; waiting: number | null; restart: number | null; trigger?: string; firstVerdict?: null }): Record<string, unknown> {
  return {
    step: RESTART_CYCLE_STEP,
    ts: fixedClock(opts.atMs).iso(),
    first_verdict_at: opts.firstVerdict === null ? null : fixedClock(opts.atMs - 60_000).iso(),
    trigger: opts.trigger ?? CHANGE_TRIGGER,
    waiting_cost_ms: opts.waiting,
    restart_cost_ms: opts.restart,
    missing_parts: opts.waiting === null || opts.restart === null ? ["waiting_cost_ms"] : [],
  };
}

/** `count` complete cycles after the policy change, the first `stale` of them staleness-released. */
function cycles(count: number, waiting: number, restart: number, stale = 0): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => cycleRow({
    atMs: Date.parse(SINCE) + (i + 1) * 3_600_000, waiting, restart, trigger: i < stale ? AGE_TRIGGER : CHANGE_TRIGGER,
  }));
}

function inventory(sample: Partial<RestartCycleSample>, extra: Partial<ConfigInventory> = {}): ConfigInventory {
  return {
    nowIso: ISO, runs: [], queued: [], recommendations: [], active: [], cooling: [],
    restart: { cycles: [], incomplete: 0, since: SINCE, ...sample }, ...extra,
  };
}

/** A fixture policy carrying the two rows on one line each, exactly as W1-T12228 writes them. */
function policyYaml(score: { value: number; min: number; max: number }, horizon: { value: number; min: number; max: number }): string {
  return [
    "# W1-T12228: the freshness restart's rows, one per line.",
    "freshnessRestart:",
    `  scoreLimit: { value: ${score.value}, origin: "lifted:src/lib/deploy-judge.ts (DEPLOY_RESTART_SCORE_THRESHOLD)", min: ${score.min}, max: ${score.max} }`,
    `  stalenessHorizonMs: { value: ${horizon.value}, origin: "lifted:src/lib/deploy-judge.ts (DEPLOY_RESTART_RATE_CEILING_MS)", min: ${horizon.min}, max: ${horizon.max} }`,
    `  quietWindowMs: { value: 600000, origin: "lifted:src/lib/deploy-judge.ts (FRESHNESS_COALESCE_WINDOW_MS)", min: 0, max: 1800000 }`,
    "",
  ].join("\n");
}

const DEFAULT_POLICY = policyYaml({ value: 18, min: 6, max: 54 }, { value: 3_600_000, min: 900_000, max: 14_400_000 });

/** A checkout the gardener can read: its own plan/policy.yaml and an empty plan. */
function root(t: FixtureScope, policy = DEFAULT_POLICY): string {
  const dir = ownedFixtureDir(t, "restart-retune").dir;
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(policyPath(dir), policy);
  return dir;
}

/** The `config.scorecard` row of a pass over `dir` — the gardener's pass row. */
function passRow(dir: string, inv: ConfigInventory): Record<string, unknown> {
  const deps: GardenerDeps = {
    repoRoot: dir, stateDir: join(dir, "state"), clock: fixedClock(NOW_MS), log: () => {},
    openWorkspace: () => { throw new Error("the pass row reads no workspace"); },
  };
  return configGardenSpec(deps).scorecard(inv, { actions: [], acting: [] });
}

test("W1-T12232 criterion 1: the gardener reads the last 20 complete restart cycles later than the last change of the two policy rows, and with fewer proposes nothing while its pass row says how many it has", (t) => {
  // The window starts at the last commit that changed either row, read from the real history of this checkout.
  const since = freshnessRowsChangedAt(REPO_ROOT);
  assert.ok(since !== null && Number.isFinite(Date.parse(since)), "the history dates the last change of either policy row");
  assert.ok(freshnessRestartRowLine(readFileSync(policyPath(REPO_ROOT), "utf8"), "scoreLimit"), "positive control: the real policy carries the row the pickaxe looks for");
  // A checkout with no history answers null — a third value, not a date the sample would trust.
  assert.equal(freshnessRowsChangedAt(ownedFixtureDir(t, "restart-retune-nogit").dir), null);

  // Rows at or before the change measured the old values; the newest RESTART_TUNE_SAMPLE complete rows are read.
  const older = [cycleRow({ atMs: Date.parse(SINCE) - 3_600_000, waiting: 11, restart: 12 }), cycleRow({ atMs: Date.parse(SINCE), waiting: 13, restart: 14 })];
  const newer = cycles(RESTART_TUNE_SAMPLE + 2, 4_000, 1_000).map((row, i) => i < 2 ? { ...row, waiting_cost_ms: 15 } : row);
  const sample = restartCycleSample([...older, ...newer], SINCE);
  assert.equal(sample.cycles.length, RESTART_TUNE_SAMPLE, "at most 20 cycles are read");
  assert.equal(sample.since, SINCE);
  assert.deepEqual(sample.cycles.filter((c) => [11, 13, 15].includes(c.waitingCostMs)), [], "no row at or before the change, and no row older than the last 20, is read");

  // One short of the sample: no proposal, and the pass row carries the count it has.
  const short = inventory({ cycles: restartCycleSample(cycles(RESTART_TUNE_SAMPLE - 1, 4_000, 1_000), SINCE).cycles });
  const reading = restartTuneReading(short, DEFAULT_POLICY);
  assert.equal(reading.cycles, RESTART_TUNE_SAMPLE - 1);
  assert.equal(reading.proposal, undefined, "19 complete cycles propose nothing");
  assert.match(reading.reason, /20 complete restart cycles are needed and there are 19/);
  const dir = root(t);
  assert.equal(restartTuneCandidate(short, dir), undefined);
  assert.equal(passRow(dir, short).restart_cycles, RESTART_TUNE_SAMPLE - 1, "the pass row says how many complete cycles it has");
  assert.equal(passRow(dir, short).restart_cycle_since, SINCE, "the pass row says which change the window starts after");

  // Positive control: the twentieth cycle is what turns the same costs into a proposal.
  const full = inventory({ cycles: restartCycleSample(cycles(RESTART_TUNE_SAMPLE, 4_000, 1_000), SINCE).cycles });
  assert.equal(restartTuneReading(full, DEFAULT_POLICY).proposal?.row, "scoreLimit");
});

test("W1-T12232 criterion 2: a median waiting cost 1.5x the median restart cost proposes a value 25% lower, the reverse proposes one 25% higher, and between the two it proposes nothing", (t) => {
  const dir = root(t);
  const read = (waiting: number, restart: number) =>
    restartTuneReading(inventory({ cycles: restartCycleSample(cycles(RESTART_TUNE_SAMPLE, waiting, restart), SINCE).cycles }), DEFAULT_POLICY);

  // Exactly at the factor: waiting dominates, so the daemon should restart sooner — 25% lower.
  const lower = read(3_000, 2_000);
  assert.equal(lower.waitingMedianMs, 3_000);
  assert.equal(lower.restartMedianMs, 2_000);
  assert.equal(lower.proposal?.current, 18);
  assert.equal(lower.proposal?.proposed, Math.round(18 * (1 - RESTART_TUNE_STEP)), "25% lower than the current value");
  assert.equal(lower.proposal?.proposed, 14);

  // Exactly at the factor the other way: restarting dominates, so the daemon should restart later — 25% higher.
  const higher = read(2_000, 3_000);
  assert.equal(higher.proposal?.proposed, Math.round(18 * (1 + RESTART_TUNE_STEP)));
  assert.equal(higher.proposal?.proposed, 23);

  // Inside the band both costs are within 1.5x of each other: nothing is proposed either way.
  for (const [waiting, restart] of [[3_000, 2_001], [2_001, 3_000], [2_000, 2_000]]) {
    const band = read(waiting!, restart!);
    assert.equal(band.proposal, undefined, `${waiting} against ${restart} is inside the band`);
    assert.match(band.reason, new RegExp(`within ${RESTART_TUNE_FACTOR}x of each other`));
    assert.equal(restartTuneCandidate(inventory({ cycles: restartCycleSample(cycles(RESTART_TUNE_SAMPLE, waiting!, restart!), SINCE).cycles }), dir), undefined);
  }
});

test("W1-T12232 criterion 3: staleness releasing more than half of the 20 restarts moves stalenessHorizonMs, and otherwise scoreLimit", () => {
  const read = (stale: number) =>
    restartTuneReading(inventory({ cycles: restartCycleSample(cycles(RESTART_TUNE_SAMPLE, 3_000, 2_000, stale), SINCE).cycles }), DEFAULT_POLICY);

  const majority = read(11);
  assert.equal(majority.stalenessReleased, 11, "the trigger of each row says what released it");
  assert.equal(majority.row, "stalenessHorizonMs");
  assert.equal(majority.proposal?.row, "stalenessHorizonMs");
  assert.equal(majority.proposal?.proposed, 2_700_000, "25% lower, in whole minutes");

  const half = read(10);
  assert.equal(half.stalenessReleased, 10, "half is not more than half");
  assert.equal(half.row, "scoreLimit");
  assert.equal(half.proposal?.row, "scoreLimit");
});

test("W1-T12232 criterion 4: the proposed value is inside the min and max of its row, and a row at its bound proposes nothing and says so", (t) => {
  const read = (policy: string, waiting: number, restart: number, stale = 0) =>
    restartTuneReading(inventory({ cycles: restartCycleSample(cycles(RESTART_TUNE_SAMPLE, waiting, restart, stale), SINCE).cycles }), policy);

  // A step that would fall under the min is held at the min, which is still inside the bounds.
  const clamped = read(policyYaml({ value: 7, min: 6, max: 54 }, { value: 3_600_000, min: 900_000, max: 14_400_000 }), 3_000, 2_000);
  assert.equal(clamped.proposal?.proposed, 6);
  assert.ok(clamped.proposal!.proposed >= 6 && clamped.proposal!.proposed <= 54, "the proposal is inside the row's bounds");

  // scoreLimit already at its min: a lower value is the min itself, so there is nothing to propose.
  const atMin = read(policyYaml({ value: 6, min: 6, max: 54 }, { value: 3_600_000, min: 900_000, max: 14_400_000 }), 3_000, 2_000);
  assert.equal(atMin.proposal, undefined);
  assert.match(atMin.reason, /freshnessRestart\.scoreLimit is at its min 6, so there is nothing to propose/);

  // stalenessHorizonMs already at its max, which is where plan/policy.yaml ships it: no higher value exists.
  const atMax = read(policyYaml({ value: 18, min: 6, max: 54 }, { value: 14_400_000, min: 900_000, max: 14_400_000 }), 2_000, 3_000, 11);
  assert.equal(atMax.proposal, undefined);
  assert.match(atMax.reason, /freshnessRestart\.stalenessHorizonMs is at its max 14400000, so there is nothing to propose/);
  assert.equal(restartTuneCandidate(inventory({ cycles: restartCycleSample(cycles(RESTART_TUNE_SAMPLE, 2_000, 3_000, 11), SINCE).cycles }),
    root(t, policyYaml({ value: 18, min: 6, max: 54 }, { value: 14_400_000, min: 900_000, max: 14_400_000 }))), undefined);
});

test("W1-T12232 criterion 5: a row with a null cost part is not counted, the pass row gives how many there were, and no null is read as 0", (t) => {
  const base = Date.parse(SINCE);
  const nulls = [
    cycleRow({ atMs: base + 100 * 3_600_000, waiting: null, restart: 7_000 }),
    cycleRow({ atMs: base + 101 * 3_600_000, waiting: 7_000, restart: null }),
    cycleRow({ atMs: base + 102 * 3_600_000, waiting: 7_000, restart: 7_000, firstVerdict: null }),
  ];
  const sample = restartCycleSample([...cycles(RESTART_TUNE_SAMPLE, 4_000, 1_000), ...nulls], SINCE);
  assert.equal(sample.cycles.length, RESTART_TUNE_SAMPLE, "the 20 complete cycles are read and the 3 incomplete rows are not");
  assert.equal(sample.incomplete, 3);
  assert.deepEqual(sample.cycles.filter((c) => c.waitingCostMs === 0 || c.restartCostMs === 0), [], "no null part is read as 0");
  assert.deepEqual([...new Set(sample.cycles.map((c) => c.waitingCostMs))], [4_000], "every read cycle carries its own measured cost");

  const inv = inventory(sample);
  const reading = restartTuneReading(inv, DEFAULT_POLICY);
  assert.equal(reading.incomplete, 3);
  assert.equal(reading.waitingMedianMs, 4_000);
  assert.equal(reading.restartMedianMs, 1_000);
  assert.match(reading.reason, /3 row\(s\) with a null cost part left out/);
  const row = passRow(root(t), inv);
  assert.equal(row.restart_cycles_incomplete, 3, "the pass row gives the count of rows with a null cost part");
  assert.equal(row.restart_cycles, RESTART_TUNE_SAMPLE);
});

test("W1-T12232 criterion 6: configCandidates returns the proposal as one action with one edit of one line in the policy file, through the config gardener's canary, and a cooling scope is not proposed again", (t) => {
  const dir = root(t);
  const inv = inventory({ cycles: restartCycleSample(cycles(RESTART_TUNE_SAMPLE, 4_000, 1_000), SINCE).cycles });

  const actions = configCandidates(inv, dir, rng);
  assert.equal(actions.length, 1, "the pass offers exactly one candidate");
  const action = actions[0]!;
  assert.deepEqual([action.class, action.target, action.scope], ["retune-restart", "scoreLimit", "restart:scoreLimit"]);
  assert.equal(action.edits.length, 1, "one edit");
  const edit = action.edits[0]!;
  assert.equal(edit.path, "plan/policy.yaml");
  assert.equal(edit.from.includes("\n"), false, "the edit replaces one physical line");
  assert.equal(edit.to.includes("\n"), false);
  const text = readFileSync(policyPath(dir), "utf8");
  assert.equal(text.split("\n").filter((line) => line === edit.from).length, 1, "the replaced line is unique in the file");
  assert.equal(edit.to, edit.from.replace("value: 18,", "value: 14,"), "only the row's value moves");

  // It goes through the same canary as every other class: the shadow guard admits it, and applying it edits one line.
  assert.equal(enterCanary(configPromotion(action, inv.nowIso), action.shadowMetrics, action.shadowObservations, inv.nowIso).verdict, "advanced");
  assert.deepEqual(applyConfigEdits(dir, action.edits), ["plan/policy.yaml"]);
  const after = readFileSync(policyPath(dir), "utf8");
  assert.equal(after.split("\n").length, text.split("\n").length, "the file keeps its line count");
  assert.deepEqual(after.split("\n").filter((line, i) => line !== text.split("\n")[i]), [edit.to], "exactly one line changed");

  // A scope that cools down, and a scope an active canary holds, are not proposed again.
  assert.deepEqual(configCandidates({ ...inv, cooling: [action.scope] }, dir, rng), []);
  const canary: ConfigCanary = {
    promotion: { ...configPromotion(action, inv.nowIso), promotionId: "config-restart:scoreLimit-earlier", state: "canary" },
    actionClass: action.class, prUrl: "https://github.com/fixture/repo/pull/1",
    cohort: action.cohort, edits: action.edits, shadowMetrics: action.shadowMetrics, shadowObservations: action.shadowObservations,
  };
  assert.deepEqual(configCandidates({ ...inv, active: [canary] }, dir, rng), []);
});

test("W1-T12232 criterion 7: the config gardener reads the daemon.restart_cycle step", () => {
  assert.equal(RESTART_CYCLE_STEP, "daemon.restart_cycle");
  assert.ok(CONFIG_GARDEN_LEDGER_STEPS.includes(RESTART_CYCLE_STEP), "the bounded 60-day read materialises the restart cycle rows");
});
