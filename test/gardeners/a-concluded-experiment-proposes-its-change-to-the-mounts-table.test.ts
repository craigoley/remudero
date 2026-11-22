/**
 * W1-T12143: a concluded randomised result proposes its change to the mounts table. The newest
 * `routing.experiment.result` row of each experiment (W1-T12142) and `routing.policy.estimate` row of each cell
 * (W1-T14146) are a second source of adopt-mount candidates beside the observational headroom sweep. A winner puts
 * its provider on the auctioned routes rows it covers, as one config-gardener canary like every adopt-mount change.
 *
 * Every row here is written the way production writes it: the experiments' and the auction's input rows through
 * `appendLedger`, their results by `recordRoutingExperimentResults` and `recordRoutingPolicyEstimates` themselves,
 * read back through the ledger union by the gardener's own pass, on a temp repo holding a real mounts table.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";

import type { Clock } from "#src/lib/clock.js";
import {
  applyConfigEdits,
  configGardenSpec,
  configInventory,
  configPromotion,
  exactLineProof,
  holdsExactLine,
  mountCandidate,
  randomisedRecommendationSource,
  readConfigCanaries,
  runConfigGarden,
  tendConfigCanaries,
  CONFIG_GARDEN_CLASSES,
  RANDOMISED_FINDING_STEP,
  type ConfigCanary,
  type ConfigGardenAction,
  type ConfigGardenSources,
  type ConfigInventory,
} from "#src/lib/config-gardener.js";
import { gardenStatePath, readGardenState, type GardenCheckout, type GardenLandOpts, type PrState } from "#src/lib/gardener.js";
import { appendLedger, type LedgerLine } from "#src/lib/ledger.js";
import { LEDGER_FILENAME } from "#src/lib/ledger-path.js";
import { readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";
import {
  OBSERVATIONAL_EVIDENCE_NOTICE,
  RANDOMISED_ESTIMATE_STEP,
  RANDOMISED_EXPERIMENT_STEP,
  randomisedMountRecommendations,
  type RandomisedMountRecommendation,
} from "#src/lib/mount-recommender.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { parseAcceptanceBlock, parseWhitelistedProof } from "#src/lib/review.js";
import { recordRoutingExperimentResults, type RoutingExperimentResult } from "#src/lib/routing-experiment-result.js";
import { experimentArmForTask, ROUTING_EXPERIMENTS, type RoutingExperiment } from "#src/lib/routing-experiments.js";
import { recordRoutingPolicyEstimates, routingPolicyFloor, ROUTING_POLICY_ESTIMATE_STEP, type RoutingPolicyEstimate } from "#src/lib/routing-policy-estimate.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ROUTING_DRAW_METHOD } from "#src/lib/worker-provider.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = Record<string, unknown>;
const DAY = "2026-11-21";
const T0 = Date.parse("2026-11-22T06:00:00.000Z");
const HOUR = 3600 * 1000;
const MOUNTS = ".remudero/mounts.yaml";

/** A table shaped like .remudero/mounts.yaml: a capabilities block whose balanced/high Codex row leads with
 *  gpt-6.2-sol and whose balanced Claude list leads with claude-sonnet-5-5, aligned flow-map routes rows, a
 *  trailing comment, a block-mapping row, two identical rows, a pinned row and a frontier peer row. */
const TABLE = `# Remudero — a fixture shaped like .remudero/mounts.yaml
tiers:
  haiku: 1
  claude-haiku-5-5: 1
  sonnet: 2
  opus: 3
  claude-opus-5-5: 4
efforts:
  low: 1
  medium: 2
  high: 3
capabilities:
  ladder:
    economy: 1
    balanced: 2
    frontier: 3
  claude:
    haiku: economy
    claude-haiku-5-5: economy
    sonnet: balanced
    claude-sonnet-5-5: balanced
    opus: frontier
    claude-opus-5-5: frontier
  claude_candidates:
    economy:  [claude-haiku-5-5]
    balanced: [claude-sonnet-5-5]
    frontier: [claude-opus-5-5]
  codex:
    economy:
      low:    [gpt-6-luna]
      medium: [gpt-6-luna]
      high:   [gpt-6-luna]
    balanced:
      low:    [gpt-6.2-sol, gpt-6.1-sol]
      medium: [gpt-6.2-sol, gpt-6.1-sol]
      high:   [gpt-6.2-sol, gpt-6.1-sol]
    frontier:
      low:    [gpt-6.2-sol]
      medium: [gpt-6.2-sol]
      high:   [gpt-6.2-sol]
  provider_preference:
    frontier: claude
architect:
  model: claude-opus-5-5
  effort: high
  max_turns: 400
  context_budget: 180000
judge:
  model: claude-opus-5-5
  effort: high
  max_turns: 400
  context_budget: 180000
synthesis:
  retro:       { model: claude-opus-5-5, effort: high, max_turns: 400, context_budget: 180000 }
  triage:      { model: sonnet,        effort: low,  max_turns: 400, context_budget: 180000 }
  inbox_draft: { model: haiku,         effort: high, max_turns: 400, context_budget: 180000 }
routes:
  recon:
    low:
      src:       { model: sonnet, effort: medium, max_turns: 40,   context_budget: 60000 }
    high:
      src:       { model: sonnet, effort: high,   max_turns: 40,   context_budget: 120000 }
  implement:
    low:
      src:       { model: sonnet, effort: medium, max_turns: 400, context_budget: 120000 }
      docs:      { model: haiku,  effort: low,    max_turns: 400, context_budget: 60000 }
    medium:
      src:       { model: sonnet, effort: high,   max_turns: 400, context_budget: 160000 }
      docs:      { model: haiku,  effort: medium, max_turns: 400, context_budget: 90000 }
    high:
      src:       { model: opus,   effort: high,   max_turns: 400, context_budget: 200000 }
      routine:   { model: sonnet, effort: high,   max_turns: 400, context_budget: 200000 }  # the routine lane
      design:    { model: claude-opus-5-5, effort: high, max_turns: 400, context_budget: 200000 }
  diagnose:
    high:
      src:
        model: sonnet
        effort: high
        max_turns: 400
        context_budget: 180000
  fix:
    medium:
      src:       { model: sonnet, effort: high,   max_turns: 400, context_budget: 160000 }
    high:
      src:       { model: sonnet, effort: high,   max_turns: 400, context_budget: 200000 }
  reviewer:
    high:
      src:       { model: sonnet, effort: high,   max_turns: 400, context_budget: 200000, provider: claude }
`;
const RECON_HIGH = "      src:       { model: sonnet, effort: high,   max_turns: 40,   context_budget: 120000 }";
const MEDIUM_160K = "      src:       { model: sonnet, effort: high,   max_turns: 400, context_budget: 160000 }";
const ROUTINE = "      routine:   { model: sonnet, effort: high,   max_turns: 400, context_budget: 200000 }  # the routine lane";
const FIX_HIGH = "      src:       { model: sonnet, effort: high,   max_turns: 400, context_budget: 200000 }";
const IMPLEMENT_HIGH = "      src:       { model: opus,   effort: high,   max_turns: 400, context_budget: 200000 }";

function live(id: string): RoutingExperiment {
  const found = ROUTING_EXPERIMENTS.find((e) => e.id === id);
  assert.ok(found, `the live experiment ${id} is listed in ROUTING_EXPERIMENTS`);
  return found;
}

/** A live experiment's arms, cell and treatments, under a decision rule twenty tasks an arm can settle. */
function small(id: string, decision: Partial<RoutingExperiment["decision"]> = {}): RoutingExperiment {
  const e = live(id);
  return { ...e, minTasksPerArm: 2, decision: { ...e.decision, minimumDifference: 0.5, ...decision } };
}

/** `perArm` tasks in each arm of `experiment`, each arm drawn by the experiment's own task-keyed draw, every task
 *  one assignment and one build verdict; the k-th task of an arm merges when k mod 20 is below its rate × 20. */
function experimentRows(experiment: RoutingExperiment, perArm: number, rates: Record<string, number>, from = 0): Row[] {
  const providerOf = new Map(Object.entries(experiment.arms).map(([provider, arm]) => [arm, provider]));
  const seen = new Map<string, number>();
  const rows: Row[] = [];
  for (let n = 1; [...providerOf.keys()].some((arm) => (seen.get(arm) ?? 0) < from + perArm); n++) {
    const task = `W1-T${n}`;
    const arm = experimentArmForTask(experiment, task).arm;
    const k = seen.get(arm) ?? 0;
    seen.set(arm, k + 1);
    if (k < from || k >= from + perArm) continue;
    const id = `${experiment.id}:${task}`;
    rows.push({ ts: "2026-11-18T09:00:00.000Z", run_id: `run-${id}`, task_id: task, step: "worker.assignment",
      worker_assignment: { id, selected: { provider: providerOf.get(arm) }, routing: { decision: { ab: experiment.id, capability: experiment.capability } } } });
    rows.push({ ts: "2026-11-18T09:01:00.000Z", run_id: `run-${id}`, task_id: task, step: "verdict",
      verdict: k % 20 < Math.round(rates[arm]! * 20) ? "merged" : "failed", selection_assignment_id: id });
  }
  return rows;
}

/** `perProvider` tasks the headroom auction served each provider at probability 0.5 in `cell`, each one build
 *  verdict; the k-th task of a provider merges when k mod 20 is below its rate × 20. */
function auctionRows(perProvider: number, rates: { claude: number; codex: number }, cell = { capability: "balanced", effort: "high", taskClass: "src" }): Row[] {
  return (["claude", "codex"] as const).flatMap((served) => Array.from({ length: perProvider }, (_, k) => {
    const task = `W1-T${(served === "claude" ? 50000 : 60000) + k}`;
    const id = `auction:${task}`;
    return [
      { ts: "2026-11-19T09:00:00.000Z", run_id: `run-${id}`, task_id: task, step: "worker.assignment",
        worker_assignment: { id, requested: { model: "sonnet", effort: cell.effort }, selected: { provider: served, model: `${served}-model`, effort: cell.effort },
          routing: { decision: { rule: "headroom-auction", capability: cell.capability, considered: [], headroomPercent: {} },
            propensity: { method: ROUTING_DRAW_METHOD, selectedProbability: 0.5, candidates: [{ provider: "claude", probability: 0.5 }, { provider: "codex", probability: 0.5 }] } } },
        benchmark_run: { work: { taskClass: { state: "observed", value: cell.taskClass } } } },
      { ts: "2026-11-19T09:01:00.000Z", run_id: `run-${id}`, task_id: task, step: "verdict",
        verdict: k % 20 < Math.round(rates[served] * 20) ? "merged" : "failed", selection_assignment_id: id },
    ];
  }).flat());
}

/** One settled implement run of `cell`, as `runTask` ledgers it. */
function run(id: string, atMs: number, merged: boolean, cell = { type: "implement", risk: "medium", taskClass: "src" }): Row[] {
  return [
    { step: "run.start", run_id: id, task_id: id, type: cell.type, risk: cell.risk, task_class: cell.taskClass, ts: new Date(atMs).toISOString() },
    { step: "verdict", run_id: id, task_id: id, verdict: merged ? "merged" : "failed", cost_usd: 3, ts: new Date(atMs + 60_000).toISOString() },
  ];
}

function harness(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t12143-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "state"));
  mkdirSync(join(root, ".remudero"));
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(root, MOUNTS), TABLE);
  const stateDir = join(root, "state");
  const ledger = join(stateDir, LEDGER_FILENAME);
  const landed: GardenLandOpts[] = [];
  const logged: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let now = T0;
  let pr: PrState = "open";
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const write = (rows: Row[]) => { for (const row of rows) appendLedger(ledger, row as LedgerLine); };
  const deps = {
    stateDir,
    repoRoot: root,
    openWorkspace: (): GardenCheckout => ({
      root,
      land: (opts) => {
        landed.push(opts);
        return `https://github.com/acme/remudero/pull/${100 + landed.length}`;
      },
      dispose: () => {},
    }),
    prState: () => pr,
    // The gardener's own rows land in the ledger, as the daemon's log writes them.
    log: (step: string, extra: Record<string, unknown> = {}) => {
      logged.push({ step, extra });
      write([{ run_id: "GARDEN-config", task_id: "config", step, ...extra }]);
    },
    seed: 7,
    clock,
  };
  const source = (experiments?: readonly RoutingExperiment[]) =>
    randomisedRecommendationSource({ stateDir, mountsFile: mountsPath(root), log: deps.log, ...(experiments ? { experiments } : {}) });
  // No injected ledger rows: the inventory reads the union itself, in its measurement worker.
  const sources = (experiments?: readonly RoutingExperiment[]): ConfigGardenSources => ({ entryWeights: () => ({}), mountRecommendations: source(experiments) });
  return {
    root, stateDir, ledger, landed, logged, deps, write, source,
    pass: (experiments?: readonly RoutingExperiment[]) => runConfigGarden(configGardenSpec(deps, sources(experiments)), deps, sources(experiments)),
    tend: (experiments?: readonly RoutingExperiment[]) => tendConfigCanaries(deps, async () => (await configInventory(deps, sources(experiments))).runs),
    inventory: (experiments?: readonly RoutingExperiment[]) => configInventory(deps, sources(experiments)),
    evidence: () => readLedgerUnionRecordsSync(stateDir, { step: [RANDOMISED_EXPERIMENT_STEP, ROUTING_POLICY_ESTIMATE_STEP] }).rows,
    table: () => readFileSync(join(root, MOUNTS), "utf8"),
    advance: (ms: number) => void (now += ms),
    now: () => now,
    setPr: (s: PrState) => void (pr = s),
    gardenState: () => readGardenState(gardenStatePath(stateDir, "config"), CONFIG_GARDEN_CLASSES),
  };
}

/** The result row its producer wrote for `id` on `day`. */
function resultOf(rows: Row[], id: string, day = DAY): RoutingExperimentResult {
  const row = rows.find((r) => r.step === RANDOMISED_EXPERIMENT_STEP && r.experiment_id === id && r.day === day);
  assert.ok(row, `the producer wrote ${id}'s result for ${day}`);
  return row.result as RoutingExperimentResult;
}

/** Whether the proof executor's own argv (`parseWhitelistedProof`) finds `proof` on a tree holding `files`. */
function executorFinds(proof: string, files: ReadonlyMap<string, string>): boolean {
  const parsed = parseWhitelistedProof(proof);
  assert.ok(parsed?.kind === "grep", `the executor runs ${proof} as a grep`);
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t12143-proof-`));
  try {
    for (const [path, text] of files) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const res = spawnSync(parsed.command, parsed.args, { cwd: dir, encoding: "utf8" });
    assert.ok(res.status === 0 || res.status === 1, `grep ran: ${res.stderr}`);
    return res.status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const exact = (model: string) => new RegExp(`^${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

/** A concluded experiment whose Claude arm (sonnet, claude-sonnet-5-5) beats its Codex arm (sol62, gpt-6.2-sol). */
async function sonnetWins(h: ReturnType<typeof harness>, experiment = small("sol62-vs-sonnet55")) {
  h.write(experimentRows(experiment, 20, { sonnet: 0.9, sol62: 0.2 }));
  const [result] = await recordRoutingExperimentResults({ stateDir: h.stateDir, today: DAY, experiments: [experiment] });
  assert.equal(result?.status, "concluded");
  assert.equal(result?.winner, "sonnet", "positive control: the producer itself declares the Claude arm the winner");
  return { experiment, result: result! };
}

test("W1-T12143 criterion 1: the config gardener reads the newest routing.experiment.result row of each experiment, and one concluded winner becomes one adopt-mount candidate", async (t) => {
  const h = harness(t);
  // The live experiment list and its live decision rule: 392 tasks an arm. Day one has twenty an arm (running).
  const sol62 = live("sol62-vs-sonnet55");
  const rates = { sonnet: 0.75, sol62: 0.5 };
  h.write(experimentRows(sol62, 20, rates));
  await recordRoutingExperimentResults({ stateDir: h.stateDir, today: "2026-11-19" });
  h.write(experimentRows(sol62, 380, rates, 20));
  const second = await recordRoutingExperimentResults({ stateDir: h.stateDir, today: DAY });
  const rows = h.evidence();
  assert.equal(resultOf(rows, sol62.id, "2026-11-19").status, "running", "the older row is running");
  assert.equal(resultOf(rows, sol62.id).status, "concluded", "the newer row is concluded");
  assert.equal(resultOf(rows, sol62.id).winner, "sonnet");
  assert.ok(second.length > 1 && second.filter((r) => r.status === "concluded").length === 1,
    "positive control: every live experiment wrote a row, and exactly one concluded");

  const recs = await h.source()();
  assert.deepEqual(recs.map((r) => r.cellKey), [`experiment:${sol62.id}`], "one concluded winner is one recommendation");
  assert.equal(recs[0]!.randomised.day, DAY, "from the newest row");
  assert.equal(recs[0]!.randomised.winner.provider, "claude");

  // Read order never decides: the newer row in an archive the union reads first, the older row in the live file.
  const lines = readFileSync(h.ledger, "utf8").split("\n").filter(Boolean);
  const newest = lines.find((l) => l.includes(`"experiment_id":"${sol62.id}"`) && l.includes(`"day":"${DAY}"`))!;
  const moved = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t12143-moved-`));
  t.after(() => rmSync(moved, { recursive: true, force: true }));
  writeFileSync(join(moved, LEDGER_FILENAME), lines.filter((l) => l !== newest).join("\n") + "\n");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(moved, `ledger.${stamp}.ndjson.gz`), gzipSync(newest + "\n"));
  const reordered = await randomisedRecommendationSource({ stateDir: moved, mountsFile: mountsPath(h.root), log: h.deps.log })();
  assert.deepEqual(reordered.map((r) => [r.cellKey, r.randomised.day]), [[`experiment:${sol62.id}`, DAY]], "the newest row wins from either file");
  const pure = randomisedMountRecommendations(rows, loadMounts(join(h.root, MOUNTS)), ROUTING_EXPERIMENTS);
  assert.deepEqual(randomisedMountRecommendations([...rows].reverse(), loadMounts(join(h.root, MOUNTS)), ROUTING_EXPERIMENTS), pure, "the same rows in any order");

  // The gardener's own pass: one adopt-mount canary PR for the one candidate.
  const pass = await h.pass();
  assert.deepEqual(pass.plan?.acting, ["adopt-mount"]);
  assert.equal(h.landed.length, 1);
  assert.deepEqual(h.landed[0]!.paths, [MOUNTS]);
  const [canary] = readConfigCanaries(h.stateDir);
  assert.equal(canary?.promotion.scope.policyScope, `mount:experiment:${sol62.id}`);

  // A read that misses a file proposes nothing: the missing file could hold a newer row.
  writeFileSync(join(moved, `ledger.${new Date(Date.now() + 1000).toISOString().replace(/[:.]/g, "-")}.ndjson.gz`), "not a gzip archive");
  const before = h.logged.length;
  assert.deepEqual(await randomisedRecommendationSource({ stateDir: moved, mountsFile: mountsPath(h.root), log: h.deps.log })(), []);
  assert.equal(h.logged[before]?.step, "config.randomised_recommendations_unread");
  assert.match(String(h.logged[before]?.extra.error), /incomplete ledger union: .*\.ndjson\.gz/);
});

test("W1-T12143 criterion 2: the candidate puts the winner's provider on the mounts rows the experiment covers, and its reason quotes both rates, the interval and the tasks", async (t) => {
  const h = harness(t);
  const { experiment } = await sonnetWins(h);
  const result = resultOf(h.evidence(), experiment.id);
  const inv: ConfigInventory = await h.inventory([experiment]);
  const action = mountCandidate(inv, h.root);
  assert.ok(action, "a candidate");
  assert.equal(action.class, "adopt-mount");
  // Every auctioned balanced/high row: recon.high.src, the two identical 160k rows as one edit, the routine row.
  assert.deepEqual(action.edits, [
    { path: MOUNTS, from: RECON_HIGH, to: RECON_HIGH.replace(" }", ", provider: claude }") },
    { path: MOUNTS, from: MEDIUM_160K, to: MEDIUM_160K.replace(" }", ", provider: claude }"), occurrences: 2 },
    { path: MOUNTS, from: ROUTINE, to: ROUTINE.replace(" }", ", provider: claude }") },
  ]);
  assert.deepEqual(action.cohort, { kind: "cells", cells: [
    { type: "recon", risk: "high", taskClass: "src" }, { type: "implement", risk: "medium", taskClass: "src" },
    { type: "fix", risk: "medium", taskClass: "src" }, { type: "implement", risk: "high", taskClass: "routine" },
  ] });
  assert.match(action.reason, /Left alone: routes\.diagnose\.high\.src \(not a one-line row\); routes\.fix\.high\.src \(its line is not one this edit can name exactly\)\./,
    "a block-mapping row, and a row whose edited line would equal the pinned reviewer row, are named, never edited");

  // The edits mean what they say to the real loader: those rows on Claude, every other row as it was.
  const before = loadMounts(join(h.root, MOUNTS));
  assert.deepEqual(applyConfigEdits(h.root, action.edits), [MOUNTS]);
  const after = loadMounts(join(h.root, MOUNTS));
  const edited = new Set(["recon.high.src", "implement.medium.src", "fix.medium.src", "implement.high.routine"]);
  for (const [type, byRisk] of Object.entries(before.routes)) {
    for (const [risk, byClass] of Object.entries(byRisk)) {
      for (const [cls, mount] of Object.entries(byClass)) {
        const key = `${type}.${risk}.${cls}`;
        assert.deepEqual(after.routes[type]![risk]![cls], edited.has(key) ? { ...mount, provider: "claude" } : mount, key);
      }
    }
  }

  // The reason quotes the result: both rates with their tasks, the difference and its interval, as the producer wrote them.
  const build = result.arms.map((arm) => arm.pipelines.build);
  const interval = result.differences.build.rate!;
  assert.deepEqual(build.map((b) => [b.rate, b.tasks]), [[0.9, 20], [0.2, 20]], "positive control on the fixture's arms");
  for (const quoted of ["sonnet 90.0% of 20 tasks", "sol62 20.0% of 20 tasks", `sol62 minus sonnet ${interval.difference.toFixed(3)}`,
    `95% interval ${interval.lower.toFixed(3)} to ${interval.upper.toFixed(3)}`, `Randomised experiment ${experiment.id}`]) {
    assert.ok(action.reason.includes(quoted), `the reason quotes ${JSON.stringify(quoted)}: ${action.reason}`);
  }
  assert.ok(!action.reason.includes(OBSERVATIONAL_EVIDENCE_NOTICE) && !/OBSERVATIONAL/.test(action.reason), "no observational notice on randomised evidence");

  // Each edited line round-trips the revert proofs: held after the edit, absent before it, by the executor's own grep.
  for (const e of action.edits) {
    assert.ok(holdsExactLine(h.table(), e.to) && !holdsExactLine(TABLE, e.to), `${e.to} tells the edit from the tree before it`);
    assert.ok(executorFinds(exactLineProof(e.path, e.to), new Map([[MOUNTS, h.table()]])));
    assert.ok(!executorFinds(exactLineProof(e.path, e.to), new Map([[MOUNTS, TABLE]])));
    assert.ok(executorFinds(exactLineProof(e.path, e.from), new Map([[MOUNTS, TABLE]])) && !holdsExactLine(h.table(), e.from), `${e.from} is the revert's line`);
  }
});

test("W1-T12143 criterion 2: on the production mounts table every covered row is edited or named, and the edited table still loads", async (t) => {
  const h = harness(t);
  await sonnetWins(h);
  const realPath = join(REPO_ROOT, MOUNTS);
  const realText = readFileSync(realPath, "utf8");
  const real = loadMounts(realPath);
  // The same arms and cell, the treatments set to whatever the production table serves first today.
  const experiment = { ...small("sol62-vs-sonnet55"), claudeModel: exact(real.capabilities!.claudeCandidates!.balanced![0]!),
    codexModel: exact(real.capabilities!.codex.balanced!.high![0]!) };
  writeFileSync(join(h.root, MOUNTS), realText);
  const [rec] = randomisedMountRecommendations(h.evidence(), real, [experiment]).recommendations;
  assert.ok(rec, "the production table can carry the winner");
  const covered = Object.entries(real.routes).flatMap(([type, byRisk]) => Object.entries(byRisk).flatMap(([risk, byClass]) =>
    Object.entries(byClass).flatMap(([cls, m]) => real.capabilities!.claude[m.model] === "balanced" && m.effort === "high" && m.provider === undefined ? [`${type}.${risk}.${cls}`] : [])));
  assert.ok(covered.length >= 5, `positive control: the production table has auctioned balanced/high rows (${covered.join(", ")})`);
  assert.deepEqual(rec.rows.map((r) => `${r.type}.${r.risk}.${r.taskClass}`), covered, "the recommendation covers exactly those rows");
  const action = mountCandidate({ nowIso: new Date(T0).toISOString(), runs: [], queued: [], recommendations: [rec], active: [], cooling: [] }, h.root)!;
  assert.deepEqual(applyConfigEdits(h.root, action.edits), [MOUNTS]);
  const edited = loadMounts(join(h.root, MOUNTS));
  for (const key of covered) {
    const [type, risk, cls] = key.split(".") as [string, string, string];
    assert.ok(edited.routes[type]![risk]![cls]!.provider === "claude" || action.reason.includes(`routes.${key} (`), `${key} is edited or named`);
  }
  for (const e of action.edits) {
    assert.equal(h.table().split("\n").filter((l) => l === e.to).length, e.occurrences ?? 1, `${e.to} replaced every line it names`);
    assert.ok(executorFinds(exactLineProof(e.path, e.to), new Map([[MOUNTS, h.table()]])) && !executorFinds(exactLineProof(e.path, e.to), new Map([[MOUNTS, realText]])));
  }
  assert.ok(action.edits.length > 0 && action.edits.some((e) => /^ {6}src: /.test(e.from)), "positive control: a src row moved");
});

test("W1-T12143 criterion 3: an experiment candidate opens a canary PR, is exposed on merge and is reverted on a breach like every other adopt-mount change", async (t) => {
  const h = harness(t);
  const { experiment } = await sonnetWins(h);
  const exps = [experiment];
  const first = await h.pass(exps);
  assert.deepEqual(first.plan?.acting, ["adopt-mount"]);
  assert.equal(h.landed.length, 1, "one canary PR");
  assert.equal(h.landed[0]!.title, "chore(mounts): the config gardener canaries a recommended mount");
  const proofs = parseAcceptanceBlock(h.landed[0]!.body).map((c) => c.proof);
  const [shadow] = readConfigCanaries(h.stateDir);
  assert.ok(shadow, "the candidate is recorded as a canary");
  assert.equal(shadow.promotion.state, "shadow", "its PR opening puts it in shadow, nothing exposed");
  assert.equal(shadow.actionClass, "adopt-mount");
  assert.equal(shadow.cohort.kind, "cells");
  assert.deepEqual(shadow.shadowMetrics.map((m) => m.metricName), ["randomised_advantage_low"]);
  assert.ok(shadow.shadowObservations[0]!.value > 0, "the shadow guard is the winner's own advantage bound");
  assert.deepEqual(proofs, shadow.edits.map((e) => exactLineProof(e.path, e.to)), "the PR proves each edited line");
  for (const proof of proofs) assert.ok(executorFinds(proof, new Map([[MOUNTS, h.table()]])) && !executorFinds(proof, new Map([[MOUNTS, TABLE]])));
  assert.match(h.landed[0]!.body, /Randomised experiment/);
  assert.ok(!h.landed[0]!.body.includes(OBSERVATIONAL_EVIDENCE_NOTICE));
  assert.match(h.landed[0]!.body, /\(2 identical rows\)/);
  assert.equal(h.gardenState().pending?.prUrl, shadow.prUrl, "the canary holds the gardener while it is open");

  // The edited rows now name their provider. What stays in the auction (the block row, the row whose edit would
  // equal the pinned reviewer row) no one-line edit can name, so no second candidate.
  const after = randomisedMountRecommendations(h.evidence(), loadMounts(join(h.root, MOUNTS)), exps);
  assert.deepEqual(after.recommendations.map((r) => r.rows.map((row) => `${row.type}.${row.risk}.${row.taskClass}`)), [["diagnose.high.src", "fix.high.src"]]);
  assert.equal(mountCandidate(await h.inventory(exps), h.root), undefined);

  // Merged: exposed. Then the cohort merges less than the same rows did before it, and the canary reverts its lines.
  h.setPr("merged");
  h.advance(2 * HOUR);
  await h.tend(exps);
  const exposed = readConfigCanaries(h.stateDir)[0]!;
  assert.equal(exposed.promotion.state, "canary", "the merge exposes it");
  const exposedAt = Date.parse(exposed.exposedAt!);
  h.write(Array.from({ length: 6 }, (_, i) => run(`rest-${i}`, exposedAt - (10 - i) * HOUR, true)).flat());
  h.write(Array.from({ length: 6 }, (_, i) => run(`canary-${i}`, exposedAt + (i + 1) * HOUR, false)).flat());
  const classesBefore = h.gardenState().classes["adopt-mount"];
  h.advance(24 * HOUR);
  const [step] = await h.tend(exps);
  assert.equal(step?.step.verdict, "rolled_back", `a breach rolls it back: ${step?.step.reason}`);
  assert.equal(h.landed.length, 2, "the revert is its own PR");
  assert.match(h.landed[1]!.title, /^revert\(config\): /);
  assert.equal(h.table(), TABLE, "the revert puts back exactly the lines the canary changed, both identical rows included");
  const revertProofs = parseAcceptanceBlock(h.landed[1]!.body).map((c) => c.proof);
  assert.deepEqual(revertProofs, shadow.edits.map((e) => exactLineProof(e.path, e.from)));
  for (const proof of revertProofs) {
    assert.ok(executorFinds(proof, new Map([[MOUNTS, TABLE]])), `${proof} holds after the revert`);
  }
  assert.equal(h.gardenState().classes["adopt-mount"].beta, classesBefore.beta + 1, "the breach debits the class");
});

test("W1-T12143 criterion 3: the tier check refuses a covered row at the Architect's tier, and a row an open canary holds is left alone", async (t) => {
  const h = harness(t);
  // A frontier/high experiment: its covered rows are implement.high.src (opus) and implement.high.design, a frontier
  // peer row on the Architect's own model. The table loads (a peer is allowed); a candidate onto Codex must not pass.
  const frontier: RoutingExperiment = { ...small("sol62-vs-sonnet55"), id: "opus55-vs-sol62-frontier", capability: "frontier", effort: "high",
    arms: { claude: "opus55", codex: "sol62" }, claudeModel: /^claude-opus-5-5$/, codexModel: /^gpt-6\.2-sol$/ };
  h.write(experimentRows(frontier, 20, { opus55: 0.2, sol62: 0.9 }));
  const [result] = await recordRoutingExperimentResults({ stateDir: h.stateDir, today: DAY, experiments: [frontier] });
  assert.equal(result?.winner, "sol62", "positive control: the producer declares the Codex arm");
  const outcomes = randomisedMountRecommendations(h.evidence(), loadMounts(join(h.root, MOUNTS)), [frontier]);
  assert.deepEqual(outcomes.refusals.map((r) => [r.reason, r.detail.split(":")[0]]), [["tier-invariant", "routes.implement.high.design"]]);
  assert.match(outcomes.refusals[0]!.detail, /Tier Invariant \(G-17\) violation/);
  assert.deepEqual(outcomes.recommendations[0]?.rows, [{ type: "implement", risk: "high", taskClass: "src" }]);
  const pass = await h.pass([frontier]);
  assert.deepEqual(pass.plan?.acting, ["adopt-mount"]);
  assert.deepEqual(readConfigCanaries(h.stateDir)[0]?.edits, [{ path: MOUNTS, from: IMPLEMENT_HIGH, to: IMPLEMENT_HIGH.replace(" }", ", provider: codex }") }]);
  assert.ok(!h.table().includes("claude-opus-5-5, effort: high, max_turns: 400, context_budget: 200000, provider"), "the peer row is untouched");
  const settled = randomisedMountRecommendations(h.evidence(), loadMounts(join(h.root, MOUNTS)), [frontier]);
  assert.deepEqual(settled.recommendations, []);
  assert.deepEqual(settled.refusals.map((r) => r.reason), ["tier-invariant", "nothing-to-change"], "with its one row moved, nothing is left to change");

  // An open canary holding a row's line keeps a second canary off it.
  const h2 = harness(t);
  const { experiment } = await sonnetWins(h2);
  const inv = await h2.inventory([experiment]);
  const rec = inv.recommendations.find((r): r is RandomisedMountRecommendation => "randomised" in r)!;
  const holder: ConfigGardenAction = { class: "adopt-mount", target: "implement|medium|src", scope: "mount:implement/medium/src", reason: "r",
    edits: [{ path: MOUNTS, from: MEDIUM_160K, to: MEDIUM_160K.replace("sonnet", "haiku") }], cohort: { kind: "cell", type: "implement", risk: "medium", taskClass: "src" },
    candidate: "c", baseline: "b", exposure: 1, shadowMetrics: [], shadowObservations: [] };
  const active: ConfigCanary = { promotion: { ...configPromotion(holder, inv.nowIso), state: "canary" }, actionClass: "adopt-mount", prUrl: "https://github.com/acme/remudero/pull/9",
    cohort: holder.cohort, edits: holder.edits, shadowMetrics: [], shadowObservations: [] };
  const action = mountCandidate({ ...inv, recommendations: [rec], active: [active] }, h2.root)!;
  assert.deepEqual(action.edits.map((e) => e.from), [RECON_HIGH, ROUTINE], "the held 160k rows are not edited");
  for (const row of ["implement.medium.src", "fix.medium.src"]) assert.ok(action.reason.includes(`routes.${row} (an open canary holds its line)`), row);
});

test("W1-T12143 criterion 4: running, underpowered and no-difference results propose nothing, and a winner the table cannot express is one finding naming the setting that can", async (t) => {
  const h = harness(t);
  const running = small("sol62-vs-sonnet55");
  const underpowered = small("haiku55-vs-luna6-low", { stopOn: "2026-11-20" });
  const noDifference = small("haiku55-vs-luna6-medium");
  const stale = small("sol61-vs-sonnet55");
  const noRow = small("haiku55-vs-luna6-high");
  const exps = [running, underpowered, noDifference, stale, noRow];
  h.write([
    ...experimentRows(running, 5, { sonnet: 0.9, sol62: 0.2 }),
    ...experimentRows(underpowered, 5, { haiku55: 0.9, luna6: 0.2 }),
    ...experimentRows(noDifference, 20, { haiku55: 0.5, luna6: 0.5 }),
    ...experimentRows(stale, 20, { sonnet: 0.2, sol61: 0.9 }),
    ...experimentRows(noRow, 20, { haiku55: 0.2, luna6: 0.9 }),
  ]);
  const results = await recordRoutingExperimentResults({ stateDir: h.stateDir, today: DAY, experiments: exps });
  assert.deepEqual(results.map((r) => [r.id, r.status, r.winner]), [
    [running.id, "running", null], [underpowered.id, "underpowered", null], [noDifference.id, "concluded", null],
    [stale.id, "concluded", "sol61"], [noRow.id, "concluded", "luna6"],
  ], "positive control: the producer's own verdicts");

  const outcomes = randomisedMountRecommendations(h.evidence(), loadMounts(join(h.root, MOUNTS)), exps);
  assert.deepEqual(outcomes.recommendations, []);
  assert.deepEqual(outcomes.refusals.map((r) => [r.id, r.reason]).sort(), [
    [noDifference.id, "no-difference"], [running.id, "running"], [underpowered.id, "underpowered"],
  ].sort());
  assert.deepEqual(outcomes.findings.map((f) => [f.id, f.setting]).sort(), [
    [noRow.id, "capabilities.provider_preference.economy"],
    [stale.id, "capabilities.codex.balanced.high"],
  ].sort());
  assert.match(outcomes.findings.find((f) => f.id === stale.id)!.detail, /serves gpt-6\.2-sol first/);

  // Through the source: no candidate, each finding written to the ledger once per evidence day however often it is read.
  assert.deepEqual(await h.source(exps)(), []);
  assert.deepEqual(await h.source(exps)(), []);
  const findings = readLedgerUnionRecordsSync(h.stateDir, { step: RANDOMISED_FINDING_STEP }).rows;
  assert.deepEqual(findings.map((f) => [f.evidence_id, f.setting, f.day]).sort(), [
    [noRow.id, "capabilities.provider_preference.economy", DAY], [stale.id, "capabilities.codex.balanced.high", DAY],
  ].sort());
  const pass = await h.pass(exps);
  assert.deepEqual(pass.plan?.actions ?? [], [], "the gardener proposes nothing");
  assert.equal(h.landed.length, 0, "and opens no PR");
  assert.equal(h.table(), TABLE);
  assert.equal(readLedgerUnionRecordsSync(h.stateDir, { step: RANDOMISED_FINDING_STEP }).rows.length, 2);

  // A result naming no listed experiment cannot be mapped to providers, and a missing table is a logged refusal.
  assert.deepEqual(randomisedMountRecommendations(h.evidence(), loadMounts(join(h.root, MOUNTS)), []).refusals.map((r) => r.reason),
    exps.map(() => "unknown-experiment"));
  const before = h.logged.length;
  assert.deepEqual(await randomisedRecommendationSource({ stateDir: h.stateDir, mountsFile: join(h.root, "absent.yaml"), log: h.deps.log })(), []);
  assert.equal(h.logged[before]?.step, "config.randomised_recommendations_unread");
});

/** The auction's estimate of cell balanced/high/src, concluded for Codex by its own producer. */
async function codexEstimate(h: ReturnType<typeof harness>): Promise<RoutingPolicyEstimate> {
  const perProvider = 400;
  assert.ok(perProvider >= routingPolicyFloor(), "each arm clears the estimate's floor");
  h.write(auctionRows(perProvider, { claude: 0.5, codex: 0.7 }));
  const estimates = await recordRoutingPolicyEstimates({ stateDir: h.stateDir, today: DAY });
  const cell = estimates.find((e) => e.cellKey === "balanced/high/src");
  assert.equal(cell?.status, "concluded", `positive control: the producer concludes the cell (${cell?.decision.reason})`);
  assert.equal(cell?.winner, "codex");
  return cell!;
}

test("W1-T12143 criterion 5: a concluded routing.policy.estimate cell becomes a candidate the same way, marked as randomised by the auction", async (t) => {
  const h = harness(t);
  const estimate = await codexEstimate(h);
  assert.equal(RANDOMISED_ESTIMATE_STEP, ROUTING_POLICY_ESTIMATE_STEP, "the step the gardener reads is the one the producer writes");
  const pass = await h.pass([]);
  assert.deepEqual(pass.plan?.acting, ["adopt-mount"]);
  const [canary] = readConfigCanaries(h.stateDir);
  assert.equal(canary?.promotion.scope.policyScope, "mount:estimate:balanced/high/src");
  // The cell's class only: the src rows, not the routine row.
  assert.deepEqual(canary.edits, [
    { path: MOUNTS, from: RECON_HIGH, to: RECON_HIGH.replace(" }", ", provider: codex }") },
    { path: MOUNTS, from: MEDIUM_160K, to: MEDIUM_160K.replace(" }", ", provider: codex }"), occurrences: 2 },
    { path: MOUNTS, from: FIX_HIGH, to: FIX_HIGH.replace(" }", ", provider: codex }") },
  ]);
  assert.equal(canary.promotion.state, "shadow");
  const body = h.landed[0]!.body;
  const build = estimate.pipelines.build!;
  for (const quoted of ["Randomised by the headroom auction", "always-claude 50.0% of 400 tasks", "always-codex 70.0% of 400 tasks",
    `95% interval ${build.difference!.lower.toFixed(3)} to ${build.difference!.upper.toFixed(3)}`]) {
    assert.ok(body.includes(quoted), `the PR quotes ${JSON.stringify(quoted)}`);
  }
  assert.ok(!body.includes(OBSERVATIONAL_EVIDENCE_NOTICE));
  // Once its rows name codex, only the block row is left in the auction, and no one-line edit can name it.
  const [rec] = randomisedMountRecommendations(h.evidence(), loadMounts(join(h.root, MOUNTS)), []).recommendations;
  assert.deepEqual(rec?.rows, [{ type: "diagnose", risk: "high", taskClass: "src" }]);
  assert.equal(mountCandidate(await h.inventory([]), h.root), undefined);
});

test("W1-T12143 criterion 5: a cell inside a concluded experiment uses the experiment's result, winner or not", async (t) => {
  // A concluded experiment for Claude at balanced/high: the experiment's candidate, never the cell's.
  const h = harness(t);
  await codexEstimate(h);
  const { experiment } = await sonnetWins(h);
  const outcomes = randomisedMountRecommendations(h.evidence(), loadMounts(join(h.root, MOUNTS)), [experiment]);
  assert.deepEqual(outcomes.recommendations.map((r) => [r.cellKey, r.randomised.winner.provider]), [[`experiment:${experiment.id}`, "claude"]]);
  assert.deepEqual(outcomes.refusals.map((r) => [r.id, r.reason]), [["balanced/high/src", "experiment-decides"]]);
  await h.pass([experiment]);
  assert.equal(readConfigCanaries(h.stateDir)[0]?.promotion.scope.policyScope, `mount:experiment:${experiment.id}`);
  assert.ok(h.table().includes(MEDIUM_160K.replace(" }", ", provider: claude }")) && !h.table().includes("provider: codex"));

  // A concluded experiment with no difference: the cell proposes nothing either.
  const h2 = harness(t);
  await codexEstimate(h2);
  const tie = small("sol62-vs-sonnet55");
  h2.write(experimentRows(tie, 20, { sonnet: 0.5, sol62: 0.5 }));
  const [result] = await recordRoutingExperimentResults({ stateDir: h2.stateDir, today: DAY, experiments: [tie] });
  assert.deepEqual([result?.status, result?.conclusion], ["concluded", "no-difference"]);
  const tied = randomisedMountRecommendations(h2.evidence(), loadMounts(join(h2.root, MOUNTS)), [tie]);
  assert.deepEqual(tied.recommendations, []);
  assert.deepEqual(tied.refusals.map((r) => [r.id, r.reason]).sort(), [["balanced/high/src", "experiment-decides"], [tie.id, "no-difference"]].sort());
  const pass = await h2.pass([tie]);
  assert.deepEqual(pass.plan?.actions ?? [], []);
  assert.equal(h2.landed.length, 0);
});
