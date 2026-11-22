/**
 * W1-T14305: a concluded randomised winner whose every covered routes row is a block no exact edit can name logs
 * one `config.randomised_finding` row naming those rows, instead of proposing nothing in silence.
 *
 * `randomisedMountCandidate` (src/lib/config-gardener.ts) puts a winner's provider on each covered routes row one
 * exact edit can name. `blockRowEdit` declines a block holding a comment, a blank line inside it or a quoted value,
 * so no text is lost, and the row is left alone. When at least one row is editable the candidate's reason names the
 * rest. When EVERY covered row was left alone the candidate was dropped, and nothing said why.
 *
 * INVARIANT no-silent-randomised-winner: a concluded randomised winner either becomes a candidate or leaves a finding
 * naming why each covered row could not take it.
 *
 * Every row is written the way production writes it: the experiment's input rows through `appendLedger`, its result
 * by `recordRoutingExperimentResults` itself, read back through the ledger union by the gardener's own pass, on a
 * temp repo holding a real mounts table.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { Clock } from "#src/lib/clock.js";
import {
  configGardenSpec,
  configInventory,
  mountCandidate,
  randomisedRecommendationSource,
  runConfigGarden,
  RANDOMISED_FINDING_STEP,
  type ConfigGardenSources,
} from "#src/lib/config-gardener.js";
import type { GardenCheckout, GardenLandOpts } from "#src/lib/gardener.js";
import { appendLedger, type LedgerLine } from "#src/lib/ledger.js";
import { LEDGER_FILENAME } from "#src/lib/ledger-path.js";
import { readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";
import { RANDOMISED_EXPERIMENT_STEP } from "#src/lib/mount-recommender.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { recordRoutingExperimentResults } from "#src/lib/routing-experiment-result.js";
import { experimentArmForTask, ROUTING_EXPERIMENTS, type RoutingExperiment } from "#src/lib/routing-experiments.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

type Row = Record<string, unknown>;
const DAY = "2026-11-21";
const T0 = Date.parse("2026-11-22T06:00:00.000Z");
const MOUNTS = ".remudero/mounts.yaml";
const NOT_NAMEABLE = "not a row one exact edit can name";

/** Everything above `routes:` in a table shaped like .remudero/mounts.yaml (the W1-T12143 suite's fixture). */
const HEADER = `# Remudero — a fixture shaped like .remudero/mounts.yaml
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
`;

/** implement.medium.src as a block holding a comment. */
const IMPLEMENT_COMMENTED = ["    medium:", "      src:", "        model: sonnet", "        # measured on implement work", "        effort: high",
  "        max_turns: 400", "        context_budget: 160000"].join("\n");
/** implement.medium.src as the one-line flow map one exact edit can name. */
const IMPLEMENT_FLOW = "    medium:\n      src:       { model: sonnet, effort: high,   max_turns: 400, context_budget: 160000 }";
/** diagnose.high.src as a block with a blank line inside it. */
const DIAGNOSE_BLANK = ["  diagnose:", "    high:", "      src:", "        model: sonnet", "        effort: high", "", "        max_turns: 400",
  "        context_budget: 180000"].join("\n");
/** fix.high.src as a block holding a quoted value. */
const FIX_QUOTED = ["  fix:", "    high:", "      src:", "        model: \"sonnet\"", "        effort: high", "        max_turns: 400",
  "        context_budget: 200000"].join("\n");

/** A table whose balanced/high routes rows are `implement` (either form), the blank-line diagnose block and the quoted
 *  fix block. implement.high.src is frontier (opus), so the balanced/high experiment does not cover it. */
const table = (implement: string) => `${HEADER}routes:
  implement:
${implement}
    high:
      src:       { model: opus,   effort: high,   max_turns: 400, context_budget: 200000 }
${DIAGNOSE_BLANK}
${FIX_QUOTED}
`;
const COVERED = ["routes.implement.medium.src", "routes.diagnose.high.src", "routes.fix.high.src"];

/** The live experiment's arms, cell and treatments, under a decision rule twenty tasks an arm can settle. */
function small(id: string): RoutingExperiment {
  const e = ROUTING_EXPERIMENTS.find((x) => x.id === id);
  assert.ok(e, `the live experiment ${id} is listed in ROUTING_EXPERIMENTS`);
  return { ...e, minTasksPerArm: 2, decision: { ...e.decision, minimumDifference: 0.5 } };
}

/** `perArm` tasks in each arm of `experiment`, each arm drawn by the experiment's own task-keyed draw, every task one
 *  assignment and one build verdict; the k-th task of an arm merges when k mod 20 is below its rate × 20. */
function experimentRows(experiment: RoutingExperiment, perArm: number, rates: Record<string, number>): Row[] {
  const providerOf = new Map(Object.entries(experiment.arms).map(([provider, arm]) => [arm, provider]));
  const seen = new Map<string, number>();
  const rows: Row[] = [];
  for (let n = 1; [...providerOf.keys()].some((arm) => (seen.get(arm) ?? 0) < perArm); n++) {
    const task = `W1-T${n}`;
    const arm = experimentArmForTask(experiment, task).arm;
    const k = seen.get(arm) ?? 0;
    seen.set(arm, k + 1);
    if (k >= perArm) continue;
    const id = `${experiment.id}:${task}`;
    rows.push({ ts: "2026-11-18T09:00:00.000Z", run_id: `run-${id}`, task_id: task, step: "worker.assignment",
      worker_assignment: { id, selected: { provider: providerOf.get(arm) }, routing: { decision: { ab: experiment.id, capability: experiment.capability } } } });
    rows.push({ ts: "2026-11-18T09:01:00.000Z", run_id: `run-${id}`, task_id: task, step: "verdict",
      verdict: k % 20 < Math.round(rates[arm]! * 20) ? "merged" : "failed", selection_assignment_id: id });
  }
  return rows;
}

function harness(t: TestContext, mountsText: string) {
  const root = ownedFixtureDir(t, "w1t14305-").dir;
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "state"));
  mkdirSync(join(root, ".remudero"));
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(root, MOUNTS), mountsText);
  const stateDir = join(root, "state");
  const ledger = join(stateDir, LEDGER_FILENAME);
  const landed: GardenLandOpts[] = [];
  let now = T0;
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
    prState: () => "open" as const,
    // The gardener's own rows land in the ledger, as the daemon's log writes them.
    log: (step: string, extra: Record<string, unknown> = {}) => write([{ run_id: "GARDEN-config", task_id: "config", step, ...extra }]),
    seed: 7,
    clock,
  };
  const source = (experiments: readonly RoutingExperiment[]) =>
    randomisedRecommendationSource({ stateDir, mountsFile: mountsPath(root), log: deps.log, codexModel: "gpt-6.2-sol", experiments });
  const sources = (experiments: readonly RoutingExperiment[]): ConfigGardenSources => ({ entryWeights: () => ({}), mountRecommendations: source(experiments) });
  return {
    root, stateDir, landed, write, source,
    pass: (experiments: readonly RoutingExperiment[]) => runConfigGarden(configGardenSpec(deps, sources(experiments)), deps, sources(experiments)),
    inventory: (experiments: readonly RoutingExperiment[]) => configInventory(deps, sources(experiments)),
    findings: () => readLedgerUnionRecordsSync(stateDir, { step: [RANDOMISED_FINDING_STEP] }).rows,
    advance: (ms: number) => void (now += ms),
  };
}

/** A concluded experiment whose Claude arm (sonnet) beats its Codex arm (sol62), recorded for `day`. */
async function sonnetWins(h: ReturnType<typeof harness>, day = DAY) {
  const experiment = small("sol62-vs-sonnet55");
  if (day === DAY) h.write(experimentRows(experiment, 20, { sonnet: 0.9, sol62: 0.2 }));
  const [result] = await recordRoutingExperimentResults({ stateDir: h.stateDir, today: day, experiments: [experiment] });
  assert.equal(result?.status, "concluded");
  assert.equal(result?.winner, "sonnet", "positive control: the producer itself declares the Claude arm the winner");
  return experiment;
}

test("W1-T14305 criterion 1: a concluded winner whose covered rows are all blocks holding a comment, a blank line inside or a quoted value yields no candidate and one config.randomised_finding row naming each row and its reason", async (t) => {
  const h = harness(t, table(IMPLEMENT_COMMENTED));
  const experiment = await sonnetWins(h);
  // POSITIVE CONTROL: the loader reads all three blocks, so the winner covers exactly those rows.
  const mounts = loadMounts(join(h.root, MOUNTS));
  assert.equal(mounts.routes.diagnose!.high!.src!.model, "sonnet");
  assert.equal(mounts.routes.fix!.high!.src!.model, "sonnet");
  const recs = await h.source([experiment])();
  assert.deepEqual(recs.map((r) => r.cellKey), [`experiment:${experiment.id}`], "the winner is a recommendation");
  assert.deepEqual(recs[0]!.rows.map((r) => `routes.${r.type}.${r.risk}.${r.taskClass}`).sort(), [...COVERED].sort());

  // The gardener's own pass: no candidate, so no canary PR, and one finding naming every covered row and its reason.
  await h.pass([experiment]);
  assert.deepEqual(h.landed, [], "no candidate becomes a canary");
  assert.equal(mountCandidate(await h.inventory([experiment]), h.root), undefined, "and none is proposed");
  const findings = h.findings();
  const setting = recs[0]!.rows.map((r) => `routes.${r.type}.${r.risk}.${r.taskClass}`).join(",");
  assert.deepEqual(findings.map((f) => [f.evidence_step, f.evidence_id, f.day, f.setting]), [[RANDOMISED_EXPERIMENT_STEP, experiment.id, DAY, setting]],
    "one finding for the winner on its evidence day, naming the covered rows");
  for (const row of COVERED) {
    assert.ok(String(findings[0]!.detail).includes(`${row} (${NOT_NAMEABLE})`), `the finding names ${row} and its reason: ${String(findings[0]!.detail)}`);
  }
});

test("W1-T14305 criterion 2: a second pass on the same evidence day writes no second finding for that winner", async (t) => {
  const h = harness(t, table(IMPLEMENT_COMMENTED));
  const experiment = await sonnetWins(h);
  await h.pass([experiment]);
  await h.source([experiment])();
  h.advance(3600 * 1000);
  await h.pass([experiment]);
  await h.source([experiment])();
  assert.deepEqual(h.findings().map((f) => [f.evidence_id, f.day]), [[experiment.id, DAY]], "one finding however many passes read that evidence day");
  // POSITIVE CONTROL: the producer's row for the next day is new evidence, so it gets its own finding.
  await sonnetWins(h, "2026-11-22");
  await h.source([experiment])();
  await h.source([experiment])();
  assert.deepEqual(h.findings().map((f) => [f.evidence_id, f.day]), [[experiment.id, DAY], [experiment.id, "2026-11-22"]]);
});

test("W1-T14305 criterion 3: a winner with at least one editable covered row still yields one candidate whose reason names the rows left alone, and no finding", async (t) => {
  const h = harness(t, table(IMPLEMENT_FLOW));
  const experiment = await sonnetWins(h);
  const action = mountCandidate(await h.inventory([experiment]), h.root);
  assert.ok(action, "a candidate");
  assert.equal(action.class, "adopt-mount");
  assert.deepEqual(action.edits.map((e) => e.from), ["      src:       { model: sonnet, effort: high,   max_turns: 400, context_budget: 160000 }"],
    "the flow-map row is the one edit");
  assert.ok(action.reason.endsWith(`Left alone: routes.diagnose.high.src (${NOT_NAMEABLE}); routes.fix.high.src (${NOT_NAMEABLE}).`), action.reason);
  await h.pass([experiment]);
  assert.equal(h.landed.length, 1, "the candidate opens its canary PR");
  assert.deepEqual(h.findings(), [], "and no finding is written for a winner that became a candidate");
});
