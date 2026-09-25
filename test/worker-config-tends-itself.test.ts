/**
 * W1-T4113: worker configuration tends itself. A config gardener (a gardener.ts spec) recalibrates
 * queued budgets, adopts mount recommendations and re-derives the learnings cap — each as a canary
 * (experiment-promotion.ts) that it judges on the cohort against the rest, rolling a breach back.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Clock } from "../src/lib/clock.js";
import {
  applyConfigEdits,
  capCandidate,
  configCanariesPath,
  configGardenSpec,
  mountCandidate,
  readConfigCanaries,
  recalibratedBudget,
  reverseEdits,
  routeLine,
  runConfigGarden,
  CONFIG_GARDEN_CLASSES,
  type ConfigGardenSources,
  type ConfigInventory,
} from "../src/lib/config-gardener.js";
import { cohortGuardMetrics, cohortGuardObservations, enterCanary, stepCanary } from "../src/lib/experiment-promotion.js";
import type { MountRecommendation } from "../src/lib/mount-recommender.js";
import { gardenStatePath, readGardenState, type GardenCheckout, type PrState } from "../src/lib/gardener.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { daemonCommand } from "../src/run-task.js";

const T0 = Date.parse("2026-09-25T00:00:00Z");
const HOUR = 3600 * 1000;

function shard(id: string, budget: string): string {
  return [
    `- id: ${id}`,
    `  title: "task ${id}"`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    `  budget_usd: ${budget}`,
    "  status: queued",
    "  files: [src/x.ts]",
    "  acceptance:",
    `    - claim: "c"`,
    `      proof: 'grep: never-${id} in src/x.ts'`,
    "",
  ].join("\n");
}

/** A plan of twelve queued implement shards of class `src`, each declaring $30. */
function repo(): { root: string; ids: string[] } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4113-`));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  const ids = Array.from({ length: 12 }, (_, i) => `W1-T${900 + i}`);
  for (const id of ids) writeFileSync(join(root, "plan", "tasks.d", `${id}-x.yaml`), shard(id, "30.00"));
  return { root, ids };
}

/** One settled implement run of class `src`, as the ledger records it. */
function run(runId: string, taskId: string, atMs: number, verdict: string, costUsd: number): Array<Record<string, unknown>> {
  return [
    { step: "run.start", run_id: runId, task_id: taskId, type: "implement", task_class: "src", ts: new Date(atMs).toISOString() },
    { step: "verdict", run_id: runId, task_id: taskId, verdict, cost_usd: costUsd, ts: new Date(atMs + 60_000).toISOString() },
  ];
}

/** Thirty settled historical runs costing $3–$6: p90 $6, so a recalibrated budget of $9. */
function history(): Array<Record<string, unknown>> {
  return Array.from({ length: 30 }, (_, i) => run(`h${i}`, `W1-T${100 + i}`, T0 - (40 - i) * HOUR, "merged", 3 + (i % 4))).flat();
}

function harness() {
  const { root, ids } = repo();
  const rows = history();
  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let now = T0;
  let pr: PrState = "open";
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const deps = {
    stateDir: join(root, "state"),
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
    log: (step: string, extra?: Record<string, unknown>) => void logs.push({ step, extra }),
    seed: 7,
    clock,
  };
  const sources: ConfigGardenSources = { ledgerRows: () => rows, entryWeights: () => ({}), mountRecommendations: () => [] };
  const pass = () => runConfigGarden(configGardenSpec(deps, sources), deps, sources);
  return {
    root,
    ids,
    rows,
    landed,
    logs,
    deps,
    pass,
    advance: (ms: number) => void (now += ms),
    now: () => now,
    setPr: (s: PrState) => void (pr = s),
    budgetOf: (id: string) => /^ {2}budget_usd: (\S+)$/m.exec(readFileSync(join(root, "plan", "tasks.d", `${id}-x.yaml`), "utf8"))![1],
  };
}

/** Open a budget canary and merge it, returning the harness with the canary exposed. */
function exposedBudgetCanary() {
  const h = harness();
  const first = h.pass();
  assert.deepEqual(first.plan?.acting, ["recalibrate-budget"], "the budget class acts: it is the only class with work");
  assert.equal(h.landed.length, 1);
  const [canary] = readConfigCanaries(h.deps.stateDir);
  assert.equal(canary!.promotion.state, "shadow", "an open PR is a canary in shadow: nothing is exposed yet");
  assert.ok(canary!.cohort.kind === "tasks");
  const cohort = canary!.cohort.taskIds;
  assert.equal(cohort.length, 6, "half the mismatched shards, so the rest can judge them");
  for (const id of h.ids) assert.equal(h.budgetOf(id), cohort.includes(id) ? "9.00" : "30.00", `${id} is ${cohort.includes(id) ? "in" : "outside"} the cohort`);
  h.setPr("merged");
  h.advance(2 * HOUR);
  h.pass();
  const exposed = readConfigCanaries(h.deps.stateDir)[0]!;
  assert.equal(exposed.promotion.state, "canary", "the merge exposes it, on its shadow evidence");
  assert.equal(exposed.exposedAt, new Date(h.now()).toISOString());
  return { h, cohort, exposedAt: h.now() };
}

test("W1-T4113: a budget recalibration runs as a canary and rolls back on a guardrail breach", () => {
  const { h, cohort } = exposedBudgetCanary();
  const rest = h.ids.filter((id) => !cohort.includes(id));
  // After exposure the cohort blocks at its new budget while the rest merges.
  cohort.forEach((id, i) => h.rows.push(...run(`c${i}`, id, h.now() + HOUR, "blocked", 9.4)));
  rest.forEach((id, i) => h.rows.push(...run(`r${i}`, id, h.now() + HOUR, "merged", 5)));
  // Within the tend interval the canary is not judged again.
  h.advance(10 * 60 * 1000);
  h.pass();
  assert.equal(readConfigCanaries(h.deps.stateDir)[0]!.promotion.state, "canary");
  h.advance(2 * HOUR);
  h.pass();

  const judged = readConfigCanaries(h.deps.stateDir)[0]!;
  assert.equal(judged.promotion.state, "rolled_back", "a guardrail breach rolls the canary back");
  assert.match(judged.reason ?? "", /merge_rate_drop/);
  assert.equal(h.landed.length, 2, "the rollback lands as its own PR");
  assert.match(h.landed[1]!.title, /^revert\(config\): /);
  assert.deepEqual(h.landed[1]!.paths, cohort.map((id) => `plan/tasks.d/${id}-x.yaml`).sort());
  assert.equal(judged.rollbackPrUrl, "https://github.com/acme/remudero/pull/102");
  for (const id of h.ids) assert.equal(h.budgetOf(id), "30.00", `${id}'s declared budget is restored`);
  assert.match(h.landed[1]!.body, /proof: grep: budget_usd: 30\.00 in plan\/tasks\.d\//);

  const state = readGardenState(gardenStatePath(h.deps.stateDir, "config"), CONFIG_GARDEN_CLASSES);
  assert.deepEqual(state.classes["recalibrate-budget"], { alpha: 3, beta: 2 }, "the breach debits the class");
  assert.equal(state.pending, undefined, "and releases the gardener to act again");
  assert.ok(h.logs.some((l) => l.step === "config.canary_rolled_back" && l.extra?.rollback_pr_url === judged.rollbackPrUrl));
});

test("W1-T4113: a canary that holds its guardrails is promoted one step at a time and credits the class", () => {
  const { h, cohort } = exposedBudgetCanary();
  const rest = h.ids.filter((id) => !cohort.includes(id));
  cohort.forEach((id, i) => h.rows.push(...run(`c${i}`, id, h.now() + HOUR, "merged", 4)));
  rest.forEach((id, i) => h.rows.push(...run(`r${i}`, id, h.now() + HOUR, "merged", 5)));
  h.advance(2 * HOUR);
  h.pass();
  assert.equal(readConfigCanaries(h.deps.stateDir)[0]!.promotion.state, "observing");
  h.advance(2 * HOUR);
  h.pass();
  assert.equal(readConfigCanaries(h.deps.stateDir)[0]!.promotion.state, "promoted");
  assert.equal(h.landed.length >= 1 && h.landed.every((l) => !l.title.startsWith("revert")), true, "a promotion reverts nothing");
  for (const id of cohort) assert.equal(h.budgetOf(id), "9.00", `${id} keeps its recalibrated budget`);
  const state = readGardenState(gardenStatePath(h.deps.stateDir, "config"), CONFIG_GARDEN_CLASSES);
  assert.equal(state.classes["recalibrate-budget"].alpha, 4, "the promotion credits the class");
});

test("W1-T4113: a thin cohort waits rather than being judged, and a closed PR exposes nothing", () => {
  const { h, cohort } = exposedBudgetCanary();
  h.rows.push(...run("c0", cohort[0]!, h.now() + HOUR, "blocked", 9));
  h.advance(2 * HOUR);
  h.pass();
  assert.equal(readConfigCanaries(h.deps.stateDir)[0]!.promotion.state, "canary", "one task is below the floor: it waits");
  h.advance(22 * 24 * HOUR);
  h.pass();
  assert.equal(readConfigCanaries(h.deps.stateDir)[0]!.promotion.state, "expired", "never measured, it expires rather than being promoted");
  const released = readGardenState(gardenStatePath(h.deps.stateDir, "config"), CONFIG_GARDEN_CLASSES);
  assert.deepEqual(released.classes["recalibrate-budget"], { alpha: 3, beta: 1 }, "an expiry is released unjudged");
  assert.notEqual(released.pending?.prUrl, "https://github.com/acme/remudero/pull/101", "the expired canary no longer holds the gardener");
  assert.ok(h.logs.some((l) => l.step === "config.canary_expired"));

  const closed = harness();
  closed.pass();
  closed.setPr("closed");
  closed.advance(2 * HOUR);
  closed.pass();
  const c = readConfigCanaries(closed.deps.stateDir)[0]!;
  assert.equal(c.promotion.state, "rolled_back");
  assert.equal(c.rollbackPrUrl, undefined, "nothing merged, so there is nothing to revert");
  assert.equal(closed.landed.length, 1);
  assert.equal(readGardenState(gardenStatePath(closed.deps.stateDir, "config"), CONFIG_GARDEN_CLASSES).classes["recalibrate-budget"].beta, 2, "the framework debits the closed PR");
});

test("W1-T4113: the canary engine refuses exposure on a shadow breach and rolls back a regressed cohort", () => {
  const nowIso = new Date(T0).toISOString();
  const record = {
    guardMetrics: cohortGuardMetrics(),
    denominatorFloor: 5,
    comparisonPopulation: "p",
    observationWindow: { start: nowIso, end: new Date(T0 + 10 * HOUR).toISOString() },
    expiresAt: new Date(T0 + 10 * HOUR).toISOString(),
    maxExposure: 0.5,
    state: "approved" as const,
  };
  const shadow = [{ metricName: "shadow_overrun_rate", unit: "fraction", direction: "max" as const, abortThreshold: 0.1 }];
  const obs = (value: number) => [{ metricName: "shadow_overrun_rate", value, denominator: 30, freshness: "verified" as const, comparisonPopulation: "p", observedAt: nowIso }];
  assert.equal(enterCanary(record, shadow, obs(0.05), nowIso).state, "canary");
  assert.deepEqual(enterCanary(record, shadow, obs(0.4), nowIso).verdict, "refused", "a budget most of history overran is never exposed");

  const canary = { ...record, state: "canary" as const };
  const bad = cohortGuardObservations({ tasks: 5, merged: 1, costUsd: 40 }, { tasks: 6, merged: 5, costUsd: 25 }, "p", nowIso);
  assert.deepEqual(stepCanary(canary, bad, nowIso), { state: "rolled_back", verdict: "rolled_back", reason: "guardrail breach: merge_rate_drop, cost_per_merged_ratio" });
  const thin = cohortGuardObservations({ tasks: 2, merged: 0, costUsd: 9 }, { tasks: 6, merged: 5, costUsd: 25 }, "p", nowIso);
  assert.equal(stepCanary(canary, thin, nowIso).verdict, "waiting", "below the floor is not a verdict");
  assert.equal(stepCanary(canary, thin, new Date(T0 + 11 * HOUR).toISOString()).verdict, "expired");
});

test("W1-T4113: budgets come from the observed distribution with no floor; mount and cap edits name their exact lines", () => {
  assert.equal(recalibratedBudget([0.2, 0.3, 0.4]), 1, "p90 $0.40 × 1.5, up to the half dollar — no fixed floor lifts it");
  assert.equal(recalibratedBudget(Array.from({ length: 10 }, (_, i) => i + 1)), 13.5);

  const mounts = ["routes:", "  implement:", "    low:", "      src:       { model: sonnet, effort: medium, max_turns: 400, context_budget: 120000 }", "    medium:", "      src:       { model: sonnet, effort: high,   max_turns: 400, context_budget: 160000 }"].join("\n");
  assert.equal(routeLine(mounts, "implement", "medium", "src"), "      src:       { model: sonnet, effort: high,   max_turns: 400, context_budget: 160000 }");
  assert.equal(routeLine(mounts, "implement", "high", "src"), undefined);

  const inv: ConfigInventory = {
    nowIso: new Date(T0).toISOString(),
    runs: [],
    queued: [],
    recommendations: [],
    active: [],
    cooling: [],
    cap: {
      current: 8148,
      derivation: { currentCapChars: 8148, pressure: { spawnsMeasured: 40, droppedWeightP50: 500, droppedWeightP90: 900 }, deltaChars: 900, deltaTokens: 225, cacheHitRatioUsed: 0.97, recommendedCapChars: 9048, changed: true, reason: "priced" },
    },
  };
  const baseline = readFileSync(join(import.meta.dirname, "..", "scripts", "knowledge-budget-baseline.json"), "utf8").replace(/"capChars": \d+/, '"capChars": 8148');
  const cap = capCandidate(inv, baseline)!;
  assert.deepEqual(cap.edits.map((e) => [e.path, e.to]), [
    ["src/lib/learnings.ts", "export const DEFAULT_KNOWLEDGE_BUDGET_CHARS = 9048;"],
    ["scripts/knowledge-budget-baseline.json", '  "capturedAt": "2026-09-25",'],
    ["scripts/knowledge-budget-baseline.json", '  "measuredDroppedWeightP50Chars": 500,'],
    ["scripts/knowledge-budget-baseline.json", '  "measuredDroppedWeightP90Chars": 900,'],
    ["scripts/knowledge-budget-baseline.json", '  "spawnsMeasured": 40,'],
    ["scripts/knowledge-budget-baseline.json", '  "cacheHitRatioUsed": 0.97,'],
    ["scripts/knowledge-budget-baseline.json", '  "pricedDeltaTokens": 225,'],
    ["scripts/knowledge-budget-baseline.json", '  "capChars": 9048'],
  ], "the cap moves with the re-measured pressure and priced delta beside it");
  assert.deepEqual(cap.cohort, { kind: "all" });
  assert.equal(capCandidate({ ...inv, cap: { ...inv.cap!, derivation: { ...inv.cap!.derivation, changed: false } } }, baseline), undefined);
  assert.ok(configCanariesPath("/s").endsWith("config-gardener-canaries.json"));
});

test("W1-T4113: a self-hosting daemon wires the config gardener", async () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4113-home-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  // Every class off: the wired garden reads this repo's real plan and mounts but never opens a worktree.
  for (const c of CONFIG_GARDEN_CLASSES) writeFileSync(join(root, "state", `CONFIG_OFF-${c}`), "");
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  let captured: DaemonDeps | undefined;
  try {
    await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, d): Promise<DaemonSummary> => {
        captured = d;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    const start = captured?.gardens?.[3];
    assert.ok(start, "the config gardener is wired after the plan, gate and test gardeners");
    const stateFile = gardenStatePath(join(root, "state"), "config");
    const garden = start!(60_000);
    for (let waited = 0; !existsSync(stateFile) && waited < 20_000; waited += 100) await new Promise((r) => setTimeout(r, 100));
    garden.stop();
    assert.ok(readGardenState(stateFile, CONFIG_GARDEN_CLASSES).lastPass, "the wired garden ran a pass over this repo's configuration");
    // Stopped before the headroom sweep loads, it never starts.
    start!(60_000).stop();
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("W1-T4113: a mount recommendation is adopted on its route line, on the same provider only, and reverts exactly", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4113-mounts-`));
  mkdirSync(join(root, ".remudero"));
  const route = "      src:       { model: sonnet, effort: high,   max_turns: 400, context_budget: 160000 }";
  const text = ["tiers:", "  sonnet: 2", "routes:", "  implement:", "    medium:", route, ""].join("\n");
  writeFileSync(join(root, ".remudero", "mounts.yaml"), text);
  const arm = (servedModel: string, effort: string, provider: string, cost: number) => ({ armKey: `${provider}/${servedModel}/${effort}`, provider, servedModel, effort, n: 40, passing: 30, costPerCompletedTaskUsd: cost });
  const rec = (provider: string): MountRecommendation => ({
    kind: "recommendation",
    cellKey: "implement|medium|src",
    type: "implement",
    risk: "medium",
    taskClass: "src",
    recommendedArm: arm("haiku", "medium", provider, 2),
    currentArm: arm("sonnet", "high", "claude", 5),
    effectSizeUsd: 3,
    interval: { lowUsd: 1, highUsd: 4 },
    objective: { kind: "notional-dollar", unit: "usd", cheaperValue: 2, costlierValue: 5 },
    note: "n",
  });
  const inv = (recommendations: MountRecommendation[]): ConfigInventory => ({ nowIso: new Date(T0).toISOString(), runs: [], queued: [], recommendations, active: [], cooling: [] });
  assert.equal(mountCandidate(inv([rec("codex")]), root), undefined, "a provider switch is more than one line");
  const action = mountCandidate(inv([rec("claude")]), root)!;
  assert.deepEqual(action.edits, [{ path: ".remudero/mounts.yaml", from: route, to: "      src:       { model: haiku, effort: medium,   max_turns: 400, context_budget: 160000 }" }]);
  assert.deepEqual(action.cohort, { kind: "cell", type: "implement", risk: "medium", taskClass: "src" });
  assert.equal(action.shadowObservations[0]!.value, 1, "exposure is gated on the recommender's own effect interval");
  assert.deepEqual(applyConfigEdits(root, action.edits), [".remudero/mounts.yaml"]);
  assert.deepEqual(applyConfigEdits(root, action.edits), [], "an edit whose line moved on is skipped, never guessed");
  applyConfigEdits(root, reverseEdits(action.edits));
  assert.equal(readFileSync(join(root, ".remudero", "mounts.yaml"), "utf8"), text);
});
