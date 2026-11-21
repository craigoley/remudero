import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ReviewCommandHost, runReview } from "#src/cli/commands/review.js";
import type { Config } from "#src/lib/config.js";
import { OUTCOME_PROPENSITY_TRIM } from "#src/lib/knowledge-outcome.js";
import { LEDGER_FILENAME } from "#src/lib/ledger-path.js";
import { meaningOfStep } from "#src/lib/ledger-steps.js";
import type { ReviewReplayInput } from "#src/lib/review-outcome-class.js";
import { evaluateRoutingExperimentResult, requiredRoutingTasksPerArm } from "#src/lib/routing-experiment-result.js";
import { experimentDrawSeed, ROUTING_EXPERIMENTS } from "#src/lib/routing-experiments.js";
import {
  estimateRoutingPolicies,
  recordRoutingPolicyEstimates,
  ROUTING_POLICY_ESTIMATE_STEP,
  ROUTING_POLICY_RULE,
  routingPolicyFloor,
  type RoutingPolicyEstimate,
} from "#src/lib/routing-policy-estimate.js";
import type { SpawnWorkerArgs, WorkerResult, WorkerSelectionAssignment } from "#src/lib/worker.js";
import {
  type ProviderCapacity,
  ROUTING_DRAW_METHOD,
  type RoutingDrawSeed,
  selectionPropensity,
  selectWorkerProvider,
  spawnDecisionPoint,
} from "#src/lib/worker-provider.js";
import { ledgeredNonDispatchSpawn } from "#src/run-task.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { buildMeasurementCadenceDaemonHooks } from "#test/helpers/run-task-test.js";

type Row = Record<string, unknown>;
type Pipeline = "build" | "fix" | "review";
type Cell = { capability?: string; effort?: string; taskClass?: string };
interface Attempt {
  task: string;
  id: string;
  served: string;
  /** The logged candidate probabilities; the served provider's entry is the selected probability. */
  probabilities: Record<string, number>;
  /** The pipeline's positive outcome (merged, accepted fix, FAILED review); undefined writes no outcome. */
  positive?: boolean;
  pipeline?: Pipeline;
  cell?: Cell;
  rule?: string;
  learner?: string;
  /** Replaces the auction-draw propensity; null writes a row from before propensities were logged. */
  propensity?: Row | null;
  at?: number;
}

const today = "2026-11-21";
const CELL: Required<Cell> = { capability: "balanced", effort: "high", taskClass: "src" };
const KEY = "balanced/high/src";
const at = (n: number) => new Date(Date.parse(`${today}T00:00:00.000Z`) + n * 2).toISOString();

function attemptRows(a: Attempt): Row[] {
  const cell = { ...CELL, ...a.cell };
  const propensity = a.propensity === null ? undefined : a.propensity ?? {
    method: ROUTING_DRAW_METHOD,
    selectedProbability: a.probabilities[a.served] ?? 0,
    candidates: Object.entries(a.probabilities).map(([provider, probability]) => ({ provider, probability })),
  };
  const assignment: Row = {
    ts: at(a.at ?? 0), run_id: `run-${a.id}`, task_id: a.task, step: "worker.assignment",
    worker_assignment: {
      id: a.id,
      requested: { model: "fixture", effort: cell.effort },
      selected: { provider: a.served, model: `${a.served}-model`, effort: cell.effort },
      routing: {
        decision: { rule: a.rule ?? "headroom-auction", ...(cell.capability ? { capability: cell.capability } : {}),
          ...(a.learner ? { learner: a.learner } : {}), considered: [], headroomPercent: {} },
        ...(propensity ? { propensity } : {}),
      },
    },
    benchmark_run: { work: { taskClass: cell.taskClass ? { state: "observed", value: cell.taskClass }
      : { state: "unavailable", reason: "not-recorded-at-assignment" } } },
  };
  if (a.positive === undefined) return [assignment];
  const base = { ts: at((a.at ?? 0) + 0.5), run_id: `run-${a.id}`, task_id: a.task };
  const pipeline = a.pipeline ?? "build";
  const outcome: Row = pipeline === "build"
    ? { ...base, step: "verdict", verdict: a.positive ? "merged" : "failed", selection_assignment_id: a.id }
    : pipeline === "fix"
      ? { ...base, step: "fix.done", subtype: a.positive ? "success" : "failure", ...(a.positive ? { pushed_head_sha: "fixed" } : {}),
        selection_assignment_id: a.id }
      : { ...base, step: "review.posted", state: a.positive ? "failure" : "success", evaluator_provenance: { selectionAssignmentId: a.id } };
  return [assignment, outcome];
}

/** Deterministic: an even index is served Claude, an odd one Codex, each at probability 0.5; the k-th task of a
 *  provider is positive when k mod 100 falls below its rate, so each arm's rate is exact. */
function patterned(count: number, rates: { claude: number; codex: number }, opts: { pipeline?: Pipeline; prefix?: string; cell?: Cell } = {}): Row[] {
  const pipeline = opts.pipeline ?? "build";
  const prefix = opts.prefix ?? `${pipeline}-`;
  return Array.from({ length: count }, (_, i) => {
    const served = i % 2 === 0 ? "claude" : "codex";
    return attemptRows({ task: `${prefix}T${i}`, id: `${prefix}${i}`, served, probabilities: { claude: 0.5, codex: 0.5 },
      positive: Math.floor(i / 2) % 100 < Math.round(rates[served] * 100), pipeline, cell: opts.cell, at: i });
  }).flat();
}

/** One task per attempt, every task of an arm served at the same probabilities (so an arm's weights are equal), the
 *  first `positive` of an arm's `tasks` positive: each arm's rate and task count are exact by construction. */
function arms(spec: Record<"claude" | "codex", { tasks: number; positive: number }>,
  probabilities: Record<string, number> = { claude: 0.5, codex: 0.5 }): Row[] {
  return (["claude", "codex"] as const).flatMap((served, s) => Array.from({ length: spec[served].tasks }, (_, i) => attemptRows({
    task: `arm-${served}-T${i}`, id: `arm-${served}-${i}`, served, probabilities, positive: i < spec[served].positive, at: s * 10000 + i,
  })).flat());
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Confounded logs with KNOWN probabilities and a KNOWN provider effect: easy tasks go to Codex with probability
 *  0.8 and hard ones with 0.2, so the raw per-provider merge rates are far from the truth. Truth: always-claude
 *  0.45, always-codex 0.60, effect +0.15, logged policy 0.525. */
function confounded(seed: number, tasks = 4000): Row[] {
  const rand = mulberry32(seed);
  const rows: Row[] = [];
  for (let i = 0; i < tasks; i++) {
    const easy = rand() < 0.5;
    const codex = easy ? 0.8 : 0.2;
    const served = rand() < codex ? "codex" : "claude";
    const rate = (easy ? 0.7 : 0.2) + (served === "codex" ? 0.15 : 0);
    rows.push(...attemptRows({ task: `W1-T${i + 1}`, id: `a${i}`, served, probabilities: { claude: 1 - codex, codex },
      positive: rand() < rate, at: i }));
  }
  return rows;
}

type Readings = Record<"claude" | "codex", number>;

/** Two subscriptions as the auction weighs them: one window each, at `used` percent. */
const capacities = (used: Readings): ProviderCapacity[] => (["claude", "codex"] as const).map((provider) =>
  ({ provider, readable: true, windows: [{ name: "five-hour", usedPercent: used[provider] }] }));

/** The probability the production auction gives `provider` at `used`, under the default 5% reserve. */
const drawProbability = (used: Readings, provider: "claude" | "codex"): number =>
  selectWorkerProvider(capacities(used), 5).draw!.probabilities.find((entry) => entry.provider === provider)!.probability;

/** One spawn routed as worker.ts routes it: `selectWorkerProvider` over the readings, its draw keyed on the task,
 *  the run and the decision point (or the experiment's own key), and the row's propensity `selectionPropensity`
 *  of that draw (src/lib/worker.ts, `workerSelectionAssignment`). */
function auction(used: Readings, key: RoutingDrawSeed): { served: "claude" | "codex"; propensity: Row } {
  const selection = selectWorkerProvider(capacities(used), 5, key);
  const served = selection.provider as "claude" | "codex";
  return { served, propensity: { ...selectionPropensity({ selected: served, considered: ["claude", "codex"], selection }) } };
}

/** `tasks` tasks the production auction served by `provider` at `used` (a draw serving the other provider is not
 *  kept), numbered from `first`, each of `attempts` attempts: the first attempt of each of the first `positive`
 *  tasks is positive, every other attempt negative. */
function auctionArm(provider: "claude" | "codex", used: Readings, spec: { tasks: number; positive: number; first: number; attempts?: number }): Row[] {
  const rows: Row[] = [];
  for (let t = 0; t < spec.tasks; t++) {
    const task = `W1-T${spec.first + t}`;
    for (let kept = 0, run = 0; kept < (spec.attempts ?? 1); run++) {
      const runId = `${task}-${1795000000000 + run}`;
      const routed = auction(used, { unit: "spawn", taskId: task, attempt: runId, point: spawnDecisionPoint({ prompt: `implement ${task}` }) });
      if (routed.served !== provider) continue;
      rows.push(...attemptRows({ task, id: `${runId}-assignment`, probabilities: {}, ...routed,
        positive: kept === 0 && t < spec.positive, at: (spec.first + t) * 4 + kept }));
      kept++;
    }
  }
  return rows;
}

function cell(rows: Row[], key = KEY): RoutingPolicyEstimate {
  const found = estimateRoutingPolicies(rows, today).cells.find((c) => c.cellKey === key);
  assert.ok(found, `cell ${key} is estimated`);
  return found;
}

test("W1-T14146 criterion 1: rows without positive probability for both providers are excluded from the cell and counted by reason", () => {
  const good = (n: number, served: string, positive: boolean, extra: Partial<Attempt> = {}): Row[] =>
    attemptRows({ task: `W1-T${100 + n}`, id: `good-${n}`, served, probabilities: { claude: 0.6, codex: 0.4 }, positive, at: n, ...extra });
  const rows: Row[] = [
    ...good(1, "claude", true), ...good(2, "codex", false), ...good(3, "codex", true),
    // The fix learner's mix is the other randomized population.
    ...good(4, "claude", false, { learner: "fix-acceptance/v1", pipeline: "fix" }),
    ...attemptRows({ task: "W1-T201", id: "single", served: "claude", probabilities: {}, positive: true, rule: "claude-only",
      propensity: { method: "single-candidate", selectedProbability: 1, candidates: [{ provider: "claude", probability: 1 }] } }),
    ...attemptRows({ task: "W1-T202", id: "preference", served: "codex", probabilities: { claude: 0.5, codex: 0.5 }, positive: true,
      rule: "capability-preference" }),
    ...attemptRows({ task: "W1-T203", id: "fallback", served: "cash", probabilities: {}, positive: true, rule: "overflow-fallback",
      propensity: { method: "unavailable", selectedProbability: "unavailable", unavailableReason: "no-eligible-candidates",
        candidates: [{ provider: "cash", probability: "unavailable" }] } }),
    ...attemptRows({ task: "W1-T204", id: "missing-weight", served: "claude", probabilities: {}, positive: true,
      propensity: { method: "unavailable", selectedProbability: "unavailable", unavailableReason: "missing-weight",
        candidates: [{ provider: "claude", probability: "unavailable" }, { provider: "codex", probability: "unavailable" }] } }),
    ...attemptRows({ task: "W1-T205", id: "cash-trial", served: "claude", probabilities: {}, positive: false, rule: "cash-trial",
      propensity: { method: "unavailable", selectedProbability: "unavailable", unavailableReason: "assigned-by-cash-trial", candidates: [] } }),
    ...attemptRows({ task: "W1-T206", id: "before-propensity", served: "claude", probabilities: {}, positive: true, propensity: null }),
    ...attemptRows({ task: "W1-T207", id: "credits", served: "codex", probabilities: { claude: 0.5, codex: 0.5 }, positive: true, rule: "codex-credits" }),
    ...attemptRows({ task: "W1-T208", id: "zero", served: "claude", probabilities: { claude: 1, codex: 0 }, positive: true }),
    ...attemptRows({ task: "W1-T209", id: "trimmed", served: "claude", probabilities: { claude: 0.97, codex: 0.03 }, positive: true }),
    ...attemptRows({ task: "W1-T210", id: "pending", served: "codex", probabilities: { claude: 0.5, codex: 0.5 } }),
    // Rows that cannot be placed in any cell are counted beside the cells.
    ...attemptRows({ task: "W1-T211", id: "no-class", served: "codex", probabilities: { claude: 0.5, codex: 0.5 }, positive: true,
      cell: { taskClass: "" } }),
    ...attemptRows({ task: "W1-T212", id: "no-capability", served: "codex", probabilities: { claude: 0.5, codex: 0.5 }, positive: true,
      cell: { capability: "" } }),
  ];
  const report = estimateRoutingPolicies(rows, today);
  assert.deepEqual(report.cells.map((c) => c.cellKey), [KEY]);
  const estimate = report.cells[0]!;
  assert.deepEqual(estimate.excluded, {
    "no-propensity": 1, fallback: 1, preference: 1, "single-candidate": 1, unavailable: 2, "other-rule": 1,
    "zero-support": 1, trimmed: 1, "no-outcome": 1,
  });
  assert.deepEqual(report.unplaced, { "no-capability": 1, "no-effort": 0, "no-task-class": 1 });
  assert.equal(estimate.n, 4, "only the four in-support auction and learner rows with an outcome are estimated from");
  assert.equal(estimate.tasks, 4);
  assert.equal(estimate.pipelines.build!.n, 3);
  assert.equal(estimate.pipelines.fix!.n, 1);
  assert.equal(estimate.pipelines.review, null);
  // The logged policy's value is the plain mean of the rows that entered: 2 of the 3 build rows merged.
  assert.equal(estimate.pipelines.build!.policies.logged.estimate, 2 / 3);
  // The trimmed share counts the trimmed row against every in-support row: 1 trimmed of 4 + 1 pending + 1 trimmed.
  assert.equal(estimate.trimmedShare, 1 / 6);
  assert.deepEqual(estimateRoutingPolicies([...rows].reverse(), today), report, "the estimate does not depend on row order");
});

test("W1-T14146 criterion 2: on synthetic logs with known probabilities and a known effect the estimate recovers it across seeds", () => {
  const seeds = [1, 2, 3, 4, 5];
  const differences: number[] = [];
  for (const seed of seeds) {
    const rows = confounded(seed);
    const build = cell(rows).pipelines.build!;
    const claude = build.policies["always-claude"].estimate!;
    const codex = build.policies["always-codex"].estimate!;
    const difference = build.difference!;
    assert.ok(Math.abs(claude - 0.45) < 0.04, `seed ${seed}: always-claude ${claude} recovers 0.45`);
    assert.ok(Math.abs(codex - 0.6) < 0.04, `seed ${seed}: always-codex ${codex} recovers 0.60`);
    assert.ok(Math.abs(difference.estimate - 0.15) < 0.05, `seed ${seed}: effect ${difference.estimate} recovers +0.15`);
    assert.ok(Math.abs(difference.estimate - (codex - claude)) < 1e-12, "the difference is always-codex minus always-claude");
    assert.ok(Math.abs(build.policies.logged.estimate! - 0.525) < 0.03, `seed ${seed}: the logged policy reads its own rate`);
    assert.ok(difference.lower < 0.15 && 0.15 < difference.upper, `seed ${seed}: the interval covers the true effect`);
    // POSITIVE CONTROL: the confounding is real, so an unweighted per-provider comparison is far from the effect.
    const raw = (provider: string) => {
      const ids = new Set(rows.filter((r) => r.step === "worker.assignment"
        && (r.worker_assignment as { selected: { provider: string } }).selected.provider === provider).map((r) => r.task_id));
      const outcomes = rows.filter((r) => r.step === "verdict" && ids.has(r.task_id));
      return outcomes.filter((r) => r.verdict === "merged").length / outcomes.length;
    };
    assert.ok(raw("codex") - raw("claude") > 0.35, `seed ${seed}: the raw comparison is confounded`);
    differences.push(difference.estimate);
  }
  const mean = differences.reduce((a, b) => a + b, 0) / differences.length;
  assert.ok(Math.abs(mean - 0.15) < 0.02, `the mean effect over seeds ${mean} sits on +0.15`);
});

test("W1-T14146 criterion 3: the interval resamples tasks, so one task's attempts move together", () => {
  const rand = mulberry32(7);
  const base: Attempt[] = [];
  for (let t = 0; t < 300; t++) {
    // One latent outcome per task: every attempt of a task succeeds or fails together.
    const positive = rand() < (t % 2 === 0 ? 0.35 : 0.65);
    for (const [n, served] of [[0, rand() < 0.5 ? "claude" : "codex"], [1, rand() < 0.5 ? "claude" : "codex"]] as const) {
      base.push({ task: `W1-T${t + 1}`, id: `t${t}-a${n}`, served, probabilities: { claude: 0.5, codex: 0.5 }, positive, at: t * 2 + n });
    }
  }
  const repeated = base.flatMap((a) => Array.from({ length: 5 }, (_, r) => ({ ...a, id: `${a.id}-r${r}` })));
  const asTasks = repeated.map((a) => ({ ...a, task: `${a.task}-${a.id}` }));
  const once = cell(base.flatMap(attemptRows)).pipelines.build!;
  const five = cell(repeated.flatMap(attemptRows)).pipelines.build!;
  const split = cell(asTasks.flatMap(attemptRows)).pipelines.build!;
  assert.equal(five.tasks, 300);
  assert.equal(five.n, 3000);
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  // Five copies of every attempt inside its own task change nothing: the task, not the attempt, is resampled.
  for (const key of ["lower", "upper", "estimate"] as const) assert.ok(close(five.difference![key], once.difference![key]), key);
  for (const target of ["always-claude", "always-codex", "logged"] as const) {
    assert.ok(close(five.policies[target].effectiveN, once.policies[target].effectiveN), `${target} effective n counts tasks`);
    assert.ok(close(five.policies[target].interval!.lower, once.policies[target].interval!.lower), `${target} interval`);
  }
  // Read as independent tasks, the same attempts claim a much tighter interval and five times the effective n.
  const width = (d: { lower: number; upper: number }) => d.upper - d.lower;
  assert.ok(width(split.difference!) < 0.6 * width(five.difference!), "attempt-level resampling would understate the interval");
  assert.ok(split.policies.logged.effectiveN > 4 * five.policies.logged.effectiveN);
  assert.equal(five.difference!.method, "task-bootstrap");
  assert.equal(five.difference!.confidence, 0.95);
  assert.deepEqual(cell(repeated.flatMap(attemptRows)), cell(repeated.flatMap(attemptRows)), "the bootstrap is seeded from the cell");
});

test("W1-T14146 criterion 4: a cell concludes only past the experiments' decision rule and floor, and otherwise names why", () => {
  // The experiments' rule: 0.10 at 95% with 80% power, so 392 effective tasks per arm (routing-experiment-result.ts).
  const live = ROUTING_EXPERIMENTS[0]!;
  assert.equal(ROUTING_POLICY_RULE.minimumDifference, live.decision.minimumDifference);
  assert.equal(ROUTING_POLICY_RULE.power, live.decision.power);
  assert.equal(ROUTING_POLICY_RULE.confidence, live.decision.confidence);
  assert.equal(routingPolicyFloor(), requiredRoutingTasksPerArm(live));
  assert.equal(routingPolicyFloor(), 392);
  assert.equal(ROUTING_POLICY_RULE.trim, OUTCOME_PROPENSITY_TRIM, "the learning-outcome estimator's trim");
  assert.equal(ROUTING_POLICY_RULE.draws, 2000);

  const concluded = cell(patterned(1000, { claude: 0.4, codex: 0.7 }));
  assert.equal(concluded.status, "concluded");
  assert.equal(concluded.concluded, true);
  assert.equal(concluded.winner, "codex");
  assert.equal(concluded.decision.code, "winner");
  assert.equal(concluded.rule.floor, 392);
  assert.equal(concluded.effectiveN["always-claude"], 500);
  assert.equal(concluded.effectiveN["always-codex"], 500);
  assert.ok(concluded.pipelines.build!.difference!.lower > 0);

  const small = cell(patterned(200, { claude: 0.4, codex: 0.7 }));
  assert.equal(small.status, "underpowered");
  assert.equal(small.concluded, false);
  assert.equal(small.winner, null);
  assert.equal(small.decision.code, "below-floor");
  assert.match(small.decision.reason, /build: always-claude has 100(\.0)? effective tasks, below the floor of 392/);

  const close = cell(patterned(1000, { claude: 0.5, codex: 0.52 }));
  assert.equal(close.status, "running");
  assert.equal(close.decision.code, "interval-includes-zero");
  assert.match(close.decision.reason, /build: the interval .* includes 0/);

  const slight = cell(patterned(6000, { claude: 0.5, codex: 0.55 }));
  const slightDiff = slight.pipelines.build!.difference!;
  assert.ok(slightDiff.lower > 0, "the interval excludes 0");
  assert.equal(slight.status, "running");
  assert.equal(slight.decision.code, "below-minimum-difference");
  assert.match(slight.decision.reason, /below the minimum of 0\.1/);

  // A review's positive outcome is a FAILED review, so fewer of them wins.
  const review = cell(patterned(1000, { claude: 0.6, codex: 0.3 }, { pipeline: "review" }));
  assert.equal(review.status, "concluded");
  assert.equal(review.winner, "codex");

  const disagree = cell([...patterned(1000, { claude: 0.4, codex: 0.7 }), ...patterned(1000, { claude: 0.3, codex: 0.6 }, { pipeline: "review" })]);
  assert.equal(disagree.status, "running");
  assert.equal(disagree.decision.code, "pipelines-disagree");
  assert.match(disagree.decision.reason, /build favours codex.*review favours claude/);

  // Every active pipeline must clear the floor, as every experiment pipeline must.
  const thinFix = cell([...patterned(1000, { claude: 0.4, codex: 0.7 }), ...patterned(100, { claude: 0.4, codex: 0.7 }, { pipeline: "fix" })]);
  assert.equal(thinFix.status, "underpowered");
  assert.match(thinFix.decision.reason, /^fix: /);

  const empty = cell(attemptRows({ task: "W1-T1", id: "only-pending", served: "codex", probabilities: { claude: 0.5, codex: 0.5 } }));
  assert.equal(empty.status, "underpowered");
  assert.equal(empty.decision.code, "no-support");
  assert.equal(empty.trimmedShare, 0);
});

test("W1-T14146 criterion 4: the rule's boundaries are exact — 0.10 and 392 effective tasks conclude, 0.0999 and 391 do not, and a bound at 0 includes 0", () => {
  const tasks = (claude: [number, number], codex: [number, number]) =>
    ({ claude: { positive: claude[0], tasks: claude[1] }, codex: { positive: codex[0], tasks: codex[1] } });
  const diffOf = (estimate: RoutingPolicyEstimate) => estimate.pipelines.build!.difference!;

  // THE EFFECT BAR. 0.5 - 0.4 is 0.09999999999999998 in doubles: exactly the minimum difference, read as met.
  const atBar = cell(arms(tasks([400, 1000], [500, 1000])));
  assert.ok(diffOf(atBar).estimate < ROUTING_POLICY_RULE.minimumDifference, "the boundary is live: the double sits under 0.1");
  assert.ok(Math.abs(diffOf(atBar).estimate - 0.1) < 1e-15);
  assert.ok(diffOf(atBar).lower > 0, "the interval excludes 0, so only the bar decides");
  assert.deepEqual(atBar.effectiveN, { "always-claude": 1000, "always-codex": 1000 });
  assert.equal(atBar.status, "concluded", atBar.decision.reason);
  assert.equal(atBar.winner, "codex");
  // 129/400 against 264/625 is a 0.0999 difference, its interval also above 0: under the bar, so still running.
  const underBar = cell(arms(tasks([129, 400], [264, 625])));
  assert.ok(Math.abs(diffOf(underBar).estimate - 0.0999) < 1e-12);
  assert.ok(diffOf(underBar).lower > 0, "the interval excludes 0, so only the bar decides");
  assert.deepEqual(underBar.effectiveN, { "always-claude": 400, "always-codex": 625 });
  assert.equal(underBar.status, "running");
  assert.equal(underBar.decision.code, "below-minimum-difference");

  // THE FLOOR. At 0.3 / 0.7 every Claude weight is 1/0.3, and Kish's sums over 392 of them read 391.9999999999956
  // unscaled: n equal weights must be exactly n effective tasks.
  const probabilities = { claude: 0.3, codex: 0.7 };
  const atFloor = cell(arms(tasks([80, 392], [240, 392]), probabilities));
  assert.deepEqual(atFloor.effectiveN, { "always-claude": 392, "always-codex": 392 });
  assert.equal(atFloor.status, "concluded", atFloor.decision.reason);
  const underFloor = cell(arms(tasks([80, 391], [240, 392]), probabilities));
  assert.deepEqual(underFloor.effectiveN, { "always-claude": 391, "always-codex": 392 });
  assert.equal(underFloor.status, "underpowered");
  assert.equal(underFloor.decision.code, "below-floor");
  assert.match(underFloor.decision.reason, /^build: always-claude has 391\.0 effective tasks, below the floor of 392$/);

  // THE INTERVAL'S BOUND. Claude never succeeds and Codex once in 400 tasks, so over a third of the resamples miss that
  // task and differ by exactly 0: the lower bound IS 0, and an interval that reaches 0 includes it. The mirror image
  // puts the upper bound at exactly 0.
  const lowerAtZero = cell(arms(tasks([0, 400], [1, 400])));
  assert.equal(diffOf(lowerAtZero).lower, 0);
  assert.ok(diffOf(lowerAtZero).upper > 0);
  assert.equal(lowerAtZero.status, "running");
  assert.equal(lowerAtZero.decision.code, "interval-includes-zero");
  const upperAtZero = cell(arms(tasks([1, 400], [0, 400])));
  assert.equal(diffOf(upperAtZero).upper, 0);
  assert.ok(diffOf(upperAtZero).lower < 0);
  assert.equal(upperAtZero.status, "running");
  assert.equal(upperAtZero.decision.code, "interval-includes-zero");
});

test("W1-T14146 criterion 4: on the production auction's own probabilities 0.10 concludes, 0.0999999995 and 0.0999 do not, 392 effective tasks conclude and 391 do not, and rates equal but for rounding include 0", () => {
  const diffOf = (estimate: RoutingPolicyEstimate) => estimate.pipelines.build!.difference!;
  // Fresh windows, Claude 9% used and Codex 5%: the auction weighs (100 - used - 5)^2, so it draws Claude at 0.477
  // and Codex at 0.523, and every row's weight is the inverse of a probability it computed.
  const fresh = { claude: 9, codex: 5 };
  assert.ok(Math.abs(drawProbability(fresh, "claude") - 7396 / 15496) < 1e-15);
  // The Codex reading at which the auction draws Codex at q, Claude's reading held.
  const codexDrawnAt = (q: number): Readings => ({ claude: fresh.claude, codex: 95 - Math.sqrt(q / (1 - q)) * (95 - fresh.claude) });

  // THE EFFECT BAR, short by `delta`. Claude merges 400 of 1,000 tasks drawn at the fresh readings. Codex merges 200 of
  // 500 there and 300 of 500 at readings that weigh its rows rho = (1 - 10 delta) / (1 + 10 delta) of the fresh ones,
  // so its Hajek rate is (2 + 3 rho) / (5 (1 + rho)) = 0.5 - delta: always-codex minus always-claude is 0.10 - delta.
  const shortBy = (delta: number) => {
    const q = drawProbability(fresh, "codex");
    const other = delta === 0 ? fresh : codexDrawnAt(q * (1 + 10 * delta) / (1 - 10 * delta));
    return cell([
      ...auctionArm("claude", fresh, { tasks: 1000, positive: 400, first: 100000 }),
      ...auctionArm("codex", fresh, { tasks: 500, positive: 200, first: 200000 }),
      ...auctionArm("codex", other, { tasks: 500, positive: 300, first: 300000 }),
    ]);
  };
  // An exact 0.10 effect, computed as the double under 0.1: it concludes. Plain running sums read it 2.4e-14 short.
  const exact = shortBy(0);
  assert.ok(diffOf(exact).estimate < ROUTING_POLICY_RULE.minimumDifference, "the boundary is live: the double sits under 0.1");
  assert.ok(Math.abs(diffOf(exact).estimate - 0.1) < 1e-15);
  assert.ok(diffOf(exact).lower > 0, "the interval excludes 0, so only the bar decides");
  assert.deepEqual(exact.effectiveN, { "always-claude": 1000, "always-codex": 1000 });
  assert.equal(exact.status, "concluded", exact.decision.reason);
  assert.equal(exact.winner, "codex");
  // 5e-10 short, and 1e-4 short: each interval is above 0 and each arm above the floor, so only the bar decides.
  for (const [delta, difference] of [[5e-10, 0.0999999995], [1e-4, 0.0999]] as const) {
    const short = shortBy(delta);
    assert.ok(Math.abs(diffOf(short).estimate - difference) < 1e-12, `${diffOf(short).estimate} is ${difference}`);
    assert.ok(diffOf(short).lower > 0, "the interval excludes 0, so only the bar decides");
    assert.ok(short.effectiveN["always-claude"]! >= routingPolicyFloor() && short.effectiveN["always-codex"]! >= routingPolicyFloor());
    assert.equal(short.status, "running", `${difference}: ${short.decision.reason}`);
    assert.equal(short.concluded, false);
    assert.equal(short.winner, null);
    assert.equal(short.decision.code, "below-minimum-difference");
  }

  // THE FLOOR. Every Claude row weighs 1/0.477 and every Codex row 1/0.523: n equal weights are exactly n tasks.
  const floorAt = (claudeTasks: number) => cell([
    ...auctionArm("claude", fresh, { tasks: claudeTasks, positive: 80, first: 400000 }),
    ...auctionArm("codex", fresh, { tasks: 392, positive: 240, first: 500000 }),
  ]);
  const atFloor = floorAt(392);
  assert.deepEqual(atFloor.effectiveN, { "always-claude": 392, "always-codex": 392 });
  assert.equal(atFloor.status, "concluded", atFloor.decision.reason);
  const underFloor = floorAt(391);
  assert.deepEqual(underFloor.effectiveN, { "always-claude": 391, "always-codex": 392 });
  assert.equal(underFloor.status, "underpowered");
  assert.match(underFloor.decision.reason, /^build: always-claude has 391\.0 effective tasks, below the floor of 392$/);

  // THE INTERVAL'S BOUND. Every task is three attempts Claude served and three Codex served, one of each merged, so
  // each arm's rate is exactly 1/3 in every resample, and every resample draws the same mix. In doubles the two arms'
  // 1/3 differ by one unit in the last place, Codex's above Claude's at the first readings and below at the second,
  // so read bare every resample's difference sits on one side of 0. A bound that close to 0 is 0: the interval
  // includes 0, and the cell names that, not a difference below the minimum.
  for (const used of [{ claude: 60, codex: 40 }, { claude: 42, codex: 17 }]) {
    const thirds = cell([
      ...auctionArm("claude", used, { tasks: 400, positive: 400, first: 600000, attempts: 3 }),
      ...auctionArm("codex", used, { tasks: 400, positive: 400, first: 600000, attempts: 3 }),
    ]);
    const build = thirds.pipelines.build!;
    const claude = build.policies["always-claude"].estimate!, codex = build.policies["always-codex"].estimate!;
    assert.notEqual(codex, claude, `the boundary is live: ${codex} and ${claude} differ in doubles`);
    assert.ok(Math.abs(codex - claude) < 1e-16);
    assert.deepEqual(thirds.effectiveN, { "always-claude": 400, "always-codex": 400 });
    assert.deepEqual([build.difference!.estimate, build.difference!.lower, build.difference!.upper], [0, 0, 0]);
    assert.equal(thirds.status, "running");
    assert.equal(thirds.decision.code, "interval-includes-zero", thirds.decision.reason);
  }
});

test("W1-T14146 criterion 4: either sign concludes, as the experiments' own rule concludes on the same tasks — at −0.30 Claude wins", () => {
  // The experiments' rule (routing-experiment-result.ts, `evaluateRoutingExperimentResult`) reads its second arm
  // minus its first, and every experiment declares Claude's arm first: the difference is Codex minus Claude. An
  // interval above 0 with a difference of at least +0.10 names the second arm, one below 0 with at most -0.10 the
  // first; for review, whose positive outcome is a FAILED review, the other way round.
  const experiment = ROUTING_EXPERIMENTS.find((candidate) => candidate.id === "sol-vs-sonnet")!;
  assert.deepEqual(Object.entries(experiment.arms), [["claude", "sonnet"], ["codex", "sol"]]);
  // Equal readings give each provider exactly 0.5, and the experiment's draw walks its arms in declared order, so the
  // auction serves each task the arm the experiment assigns it: the IPW estimate and the experiment's ITT read the
  // same split, from the same rows.
  const used = { claude: 30, codex: 30 };
  assert.equal(drawProbability(used, "claude"), 0.5);
  const enrolled = (perTen: Readings, pipeline: Pipeline): Row[] => {
    const seen = { claude: 0, codex: 0 };
    return Array.from({ length: 1000 }, (_, i) => {
      const task = `W1-T${800000 + i}`;
      const routed = auction(used, experimentDrawSeed(experiment, task));
      const rows = attemptRows({ task, id: `${task}-assignment`, probabilities: {}, ...routed, pipeline,
        positive: seen[routed.served]++ % 10 < perTen[routed.served], at: 2 * i });
      // worker.ts tags a decision the experiment drew with the experiment's id.
      ((rows[0]!.worker_assignment as { routing: { decision: Row } }).routing.decision).ab = experiment.id;
      return rows;
    }).flat();
  };
  const cases = [
    { pipeline: "build", perTen: { claude: 7, codex: 4 }, difference: -0.3, winner: "claude" },
    { pipeline: "build", perTen: { claude: 4, codex: 7 }, difference: 0.3, winner: "codex" },
    { pipeline: "review", perTen: { claude: 7, codex: 4 }, difference: -0.3, winner: "codex" },
  ] as const;
  for (const { pipeline, perTen, difference, winner } of cases) {
    const rows = enrolled(perTen, pipeline);
    const result = evaluateRoutingExperimentResult(rows, experiment, today);
    assert.equal(result.status, "concluded", `${pipeline} ${difference}: the experiment concludes`);
    assert.equal(result.conclusion, "winner");
    assert.equal(result.winner, experiment.arms[winner], `${pipeline} ${difference}: the experiment names ${winner}'s arm`);
    const estimate = cell(rows);
    const d = estimate.pipelines[pipeline]!.difference!;
    assert.ok(Math.abs(d.estimate - difference) < 0.01, `${pipeline}: always-codex minus always-claude ${d.estimate}`);
    assert.ok(difference < 0 ? d.upper < 0 : d.lower > 0, "the interval excludes 0 on the difference's side");
    assert.ok(estimate.effectiveN["always-claude"]! >= 392 && estimate.effectiveN["always-codex"]! >= 392);
    assert.equal(estimate.status, "concluded", `${pipeline} ${difference}: ${estimate.decision.reason}`);
    assert.equal(estimate.winner, winner, `${pipeline} ${difference}: the estimate names ${winner}, as the experiment does`);
  }
});

test("W1-T14146 criterion 5: invariant within-support — no row values a provider whose logged probability in that cell was 0", () => {
  const docs = { capability: "economy", effort: "low", taskClass: "docs" };
  const rows: Row[] = [
    ...patterned(40, { claude: 0.4, codex: 0.6 }),
    // Codex not eligible: a two-provider draw that gave it 0, a three-provider draw that gave it 0, and a draw
    // that never named it. Each is a logged-zero for Codex, in this cell and in a cell where it never had support.
    ...[KEY, "economy/low/docs"].flatMap((key, k) => Array.from({ length: 30 }, (_, i) => attemptRows({
      task: `zero-${k}-${i}`, id: `zero-${k}-${i}`, served: "claude", positive: i % 2 === 0, at: 1000 + i,
      cell: key === KEY ? undefined : docs,
      probabilities: i % 3 === 0 ? { claude: 1, codex: 0 } : i % 3 === 1 ? { claude: 0.7, codex: 0, openweight: 0.3 } : { claude: 0.6, openweight: 0.4 },
    })).flat()),
  ];
  const report = estimateRoutingPolicies(rows, today);
  // The property first: every valued always-one policy sits on rows where its provider was drawable.
  for (const estimate of report.cells) {
    for (const [pipeline, entry] of Object.entries(estimate.pipelines)) {
      if (!entry) continue;
      for (const provider of ["claude", "codex"] as const) {
        const value = entry.policies[`always-${provider}`];
        if (value.estimate === null) continue;
        assert.ok(entry.support[provider].min > 0, `${estimate.cellKey} ${pipeline}: always-${provider} is valued only within support`);
        assert.ok(entry.support[provider].min >= ROUTING_POLICY_RULE.trim);
      }
    }
    if (estimate.n === 0) {
      assert.deepEqual(estimate.pipelines, { build: null, fix: null, review: null }, `${estimate.cellKey} values no provider`);
      assert.deepEqual(estimate.effectiveN, { "always-claude": null, "always-codex": null });
    }
  }
  const routed = report.cells.find((c) => c.cellKey === KEY)!;
  const unsupported = report.cells.find((c) => c.cellKey === "economy/low/docs")!;
  assert.equal(routed.excluded["zero-support"], 30);
  assert.equal(routed.n, 40);
  assert.equal(unsupported.excluded["zero-support"], 30);
  assert.equal(unsupported.n, 0);
  assert.equal(unsupported.decision.code, "no-support");
  assert.equal(unsupported.winner, null);
});

test("W1-T14146: the measurement cadence writes one routing.policy.estimate row per cell per day", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-routing-policy-"));
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir);
    const ledger = join(stateDir, LEDGER_FILENAME);
    const encode = (items: unknown[]) => items.map((row) => JSON.stringify(row)).join("\n") + "\n";
    const seeded = [...patterned(20, { claude: 0.4, codex: 0.6 }), ...patterned(10, { claude: 0.5, codex: 0.5 }, { cell: { taskClass: "docs" }, prefix: "docs-" })];
    writeFileSync(ledger, encode(seeded));
    const hooks = buildMeasurementCadenceDaemonHooks({ config: { root } as Config, now: () => new Date(`${today}T10:00:00.000Z`),
      verifyHumanCadenceResult: async () => { throw new Error("fixture stops sibling work"); } });
    await assert.rejects(hooks.runMeasurementCadence(), /fixture stops sibling work/);
    const read = () => readFileSync(ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row)
      .filter((row) => row.step === ROUTING_POLICY_ESTIMATE_STEP);
    const written = read();
    assert.deepEqual(written.map((row) => row.cell_key).sort(), ["balanced/high/docs", KEY]);
    for (const row of written) {
      const estimate = row.estimate as RoutingPolicyEstimate;
      assert.equal(row.day, today);
      assert.equal(estimate.cellKey, row.cell_key);
      assert.equal(estimate.status, "underpowered");
      assert.equal(typeof estimate.decision.reason, "string");
    }
    // A second pass on the same day writes nothing; the next day writes each cell again.
    assert.deepEqual(await recordRoutingPolicyEstimates({ stateDir, today }), []);
    assert.equal(read().length, 2);
    assert.equal((await recordRoutingPolicyEstimates({ stateDir, today: "2026-11-22" })).length, 2);
    assert.equal(read().length, 4);
    await assert.rejects(recordRoutingPolicyEstimates({ stateDir, today: "2026-02-30" }), /invalid routing policy day/);
    writeFileSync(join(stateDir, "ledger.2026-11-21T12-00-00-000Z.ndjson.gz"), "corrupt gzip");
    await assert.rejects(recordRoutingPolicyEstimates({ stateDir, today: "2026-11-23" }), /routing policy ledger unreadable/);
    assert.deepEqual(meaningOfStep(ROUTING_POLICY_ESTIMATE_STEP)?.writer, ["recordRoutingPolicyEstimates"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
function unexpected(): never { throw new Error("unexpected review fixture dependency"); }

/** The review lane run for real (`runReview`, src/cli/commands/review.ts) through to its reviewer. The reviewer's
 *  spawn is the production receipt writer, run-task.ts's `ledgeredNonDispatchSpawn("review", …)`, given whatever work
 *  `runReview` passes it; only the provider call under it is a fixture, routed by the production auction and
 *  returning a passing verdict. Returns the rows the writer ledgered, each `ts` pinned to `at(n)`. */
async function reviewedByTheLane(task: { id: string; files?: string[] }, setup: Pick<ReviewReplayInput, "untasked" | "head_task_resolved">,
  n: number): Promise<Row[]> {
  const root = mkdtempSync(join(tmpdir(), "rmd-routing-policy-review-lane-"));
  const shim = ghShim([
    { when: "/statuses?", stdout: "[[]]" },
    { when: "/commits/", stdout: '{"statuses":[]}' },
    { when: "/pulls/", stdout: JSON.stringify({ number: 1, html_url: "https://github.com/acme/remudero/pull/1", updated_at: "t", body: "", head: { ref: "b", sha: HEAD } }) },
    { when: "headRefOid", stdout: JSON.stringify({ headRefOid: HEAD }) },
    { when: "pr view", stdout: '{"state":"OPEN"}' },
    { when: "pr diff", stdout: "" },
    { when: "api ", stdout: "{}" },
  ]);
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${shim.dir}:${oldPath}`;
    writeFileSync(join(root, "settings.json"), JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }));
    const provider = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
      const routed = auction({ claude: 30, codex: 30 }, { unit: "spawn", taskId: args.taskId!, attempt: args.runId!, point: spawnDecisionPoint(args) });
      const id = `${args.runId}-reviewer`;
      args.onSelectionAssignment?.({
        version: 1, id, phase: "pre-execution", requested: { model: args.model!, effort: args.effort!, maxTurns: args.maxTurns ?? null },
        selected: { provider: routed.served, model: `${routed.served}-model`, effort: args.effort! },
        routing: { mode: "multi-provider", selectionPath: "auction", policy: { preference: "automatic", reservePercent: 5, provenance: "default" },
          decision: { rule: "headroom-auction", capability: "balanced", considered: [], headroomPercent: {} }, propensity: routed.propensity },
        candidates: [],
      } as unknown as WorkerSelectionAssignment);
      return { sessionId: `${id}-session`, costUsd: 0.01, numTurns: 1, text: "REVIEW_VERDICT 1: PASS", blocks: [], stderr: "",
        subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: `${routed.served}-model`,
        effort: args.effort, tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
        qualitySuspect: false, workerDurationMs: 5, selectionAssignmentId: id } as unknown as WorkerResult;
    };
    const host: ReviewCommandHost = {
      GIT_UNTRACKED_FILES_ALL: "--untracked-files=all", JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
      acceptedReviewAttemptId: (value) => typeof value === "string" ? value : undefined,
      attributeWorkerStreamEvent: unexpected,
      ledgeredNonDispatchSpawn: (lane, _raw, known) => ledgeredNonDispatchSpawn(lane, provider, known),
      lintPlanForReview: unexpected, liveWorkerRunIds: new Set<string>(), materializeReviewWorktree: unexpected,
      readHeadShaRest: () => HEAD, readMainPlanTreeSha: unexpected,
      realDeps: () => ({ reviewWorktree: { fetch: unexpected } }) as unknown as ReturnType<ReviewCommandHost["realDeps"]>,
      reviewPostedDescription: (verdict) => verdict.summary, reviewWorkerLockId: (runId) => runId,
      reviewerClockBoundMs: () => 60_000, reviewSubjectGit: unexpected,
    };
    await runReview(host, {
      owner: "acme", repo: "remudero", prUrl: "https://github.com/acme/remudero/pull/1",
      task: { ...task, acceptance: [{ claim: "a claim the report never substantiates", proof: "unit test: no-such-test-title-w1-t14146" }] },
      report: "This report deliberately substantiates nothing.", reviewInputBody: "body",
      reviewReplaySetupInput: { stage: "setup", plan_only: false, required_semantic: false, criteria_count: 1, risk_present: false,
        budget_present: false, own_task_record_missing: false, reviewer_outcome: "not_attempted", verdict_lines: [], ...setup },
      settingsFile: join(root, "settings.json"), config: { claudeBin: "/bin/true", root } as never,
      log: () => {}, say: () => {}, account: (r: never) => r, spawnReviewer: true, disarm: () => {},
      reviewerMount: { model: "sonnet", provider: "claude", effort: "high", maxTurns: 10, contextBudget: 120000 },
      headCheckoutDir: REPO_ROOT, ledgerPath: join(root, "review-ledger.ndjson"), runId: `review-PR1-${1795000000000 + n}`,
    } as never);
    return readFileSync(join(root, "state", LEDGER_FILENAME), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row)
      .filter((row) => row.step === "worker.assignment").map((row) => ({ ...row, ts: at(n) }));
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
}

/** Beside a review's assignment row: its task's implement `run.start`, naming `runStartClass`, before it, and the
 *  review's verdict naming the assignment that served it, after it. */
function aroundReview(assignment: Row, n: number, runStartClass: string, failed: boolean): Row[] {
  const task = text(assignment.task_id);
  return [
    { ts: at(n - 1), run_id: `${task}-1795000000000`, task_id: task, step: "run.start", type: "implement", risk: "medium",
      task_class: runStartClass, mount_class: runStartClass, provider: "claude", worker_role: "implementer" },
    assignment,
    { ts: at(n + 1), run_id: assignment.run_id, task_id: task, step: "review.posted", lane: "review", context: "remudero-review",
      state: failed ? "failure" : "success", pr_url: "https://github.com/acme/remudero/pull/1",
      evaluator_provenance: { selectionAssignmentId: (assignment.worker_assignment as Row).id } },
  ];
}
const text = (value: unknown): string => typeof value === "string" ? value : "";

/** The cadence's own pass over `rows`, written to a fresh state directory: the cell keys it wrote today. */
async function cadenceCells(rows: Row[]): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "rmd-routing-policy-cadence-"));
  try {
    mkdirSync(join(root, "state"));
    writeFileSync(join(root, "state", LEDGER_FILENAME), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    return (await recordRoutingPolicyEstimates({ stateDir: join(root, "state"), today })).map((estimate) => estimate.cellKey).sort();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T14146: the review lane's assignment receipt records its PR's plan task class, and the cadence estimates the review in that cell", async () => {
  // A docs-only plan task: deriveTaskClass reads `docs`, the class its implement run's run.start records.
  const [assignment, ...others] = await reviewedByTheLane({ id: "W1-T14901", files: ["docs/routing.md"] },
    { untasked: false, head_task_resolved: true }, 10);
  assert.deepEqual(others, [], "the reviewer was assigned once");
  assert.equal(assignment!.lane, "review");
  assert.equal(assignment!.task_id, "W1-T14901");
  assert.deepEqual((assignment!.benchmark_run as { work: { taskClass: unknown } }).work.taskClass, { state: "observed", value: "docs" },
    "the receipt records the reviewed task's class when the reviewer is assigned");
  // The task's run.start names another class: the receipt's own class places the row, and nothing overrides it.
  const rows = aroundReview(assignment!, 10, "src", true);
  const report = estimateRoutingPolicies(rows, today);
  assert.deepEqual(report.cells.map((c) => c.cellKey), ["balanced/high/docs"]);
  assert.deepEqual(report.unplaced, { "no-capability": 0, "no-effort": 0, "no-task-class": 0 });
  assert.equal(report.cells[0]!.pipelines.review?.n, 1, "the review's verdict is estimated in its task's cell");
  assert.deepEqual(await cadenceCells(rows), ["balanced/high/docs"], "the cadence writes that cell");
});

test("W1-T14146: a review receipt that recorded no class is counted unplaced, and never takes its task's run.start class", async () => {
  // The review names a plan task whose record did not resolve at head, so its receipt records no class, though the
  // task's files would read `docs` and its run.start names `src`.
  const [assignment] = await reviewedByTheLane({ id: "W1-T14902", files: ["docs/routing.md"] },
    { untasked: false, head_task_resolved: false }, 20);
  assert.deepEqual((assignment!.benchmark_run as { work: { taskClass: unknown } }).work.taskClass,
    { state: "unavailable", reason: "not-recorded-at-assignment" }, "no plan task, so the receipt records no class");
  const rows = aroundReview(assignment!, 20, "src", false);
  const report = estimateRoutingPolicies(rows, today);
  assert.deepEqual(report.cells, [], "no cell is built from a receipt that recorded no class, run.start's included");
  assert.deepEqual(report.unplaced, { "no-capability": 0, "no-effort": 0, "no-task-class": 1 }, "the row is counted unplaced");
  assert.deepEqual(await cadenceCells(rows), [], "the cadence writes no cell for it");
});
