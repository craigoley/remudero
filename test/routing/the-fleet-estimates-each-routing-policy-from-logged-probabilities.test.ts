import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { OUTCOME_PROPENSITY_TRIM } from "#src/lib/knowledge-outcome.js";
import { LEDGER_FILENAME } from "#src/lib/ledger-path.js";
import { meaningOfStep } from "#src/lib/ledger-steps.js";
import { requiredRoutingTasksPerArm } from "#src/lib/routing-experiment-result.js";
import { ROUTING_EXPERIMENTS } from "#src/lib/routing-experiments.js";
import {
  estimateRoutingPolicies,
  recordRoutingPolicyEstimates,
  ROUTING_POLICY_ESTIMATE_STEP,
  ROUTING_POLICY_RULE,
  routingPolicyFloor,
  type RoutingPolicyEstimate,
} from "#src/lib/routing-policy-estimate.js";
import { ROUTING_DRAW_METHOD } from "#src/lib/worker-provider.js";
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
    assert.deepEqual(recordRoutingPolicyEstimates({ stateDir, today }), []);
    assert.equal(read().length, 2);
    assert.equal(recordRoutingPolicyEstimates({ stateDir, today: "2026-11-22" }).length, 2);
    assert.equal(read().length, 4);
    assert.throws(() => recordRoutingPolicyEstimates({ stateDir, today: "2026-02-30" }), /invalid routing policy day/);
    writeFileSync(join(stateDir, "ledger.2026-11-21T12-00-00-000Z.ndjson.gz"), "corrupt gzip");
    assert.throws(() => recordRoutingPolicyEstimates({ stateDir, today: "2026-11-23" }), /routing policy ledger unreadable/);
    assert.deepEqual(meaningOfStep(ROUTING_POLICY_ESTIMATE_STEP)?.writer, ["recordRoutingPolicyEstimates"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
