import { createHash } from "node:crypto";
import { join } from "node:path";
import { fixedClock, systemClock } from "./clock.js";
import { twoProportionSampleSize } from "./eval-card.js";
import { appendLedger } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { openLedgerUnion } from "./ledger-union.js";
import { ROUTING_DRAW_METHOD } from "./worker-provider.js";

/**
 * lib/routing-policy-estimate.ts (W1-T14146) — what always-Claude and always-Codex would have done in each routed
 * cell, estimated from the probabilities ordinary dispatch already logs.
 *
 * Every `worker.assignment` row carries the probability its provider was drawn with (`RoutingPropensity`,
 * worker-provider.ts, W1-T4617), and the headroom auction gives every eligible provider a weight above zero, so
 * ordinary dispatch randomizes between Claude and Codex every day. The randomized experiments need 392 tasks per
 * arm and see a few dozen a fortnight. Replaying the logged decisions with inverse-propensity weights values a
 * target policy without bias inside the logged support (Li, Chu, Langford and Wang, WSDM 2011). Only the provider
 * has support: a provider's model and effort follow its mount row, so a target policy changes the provider and
 * nothing else.
 *
 * - POPULATION: assignment rows drawn by the headroom auction or the fix learner's mix (`ROUTING_DRAW_METHOD`)
 *   that gave BOTH providers a probability inside `[trim, 1 - trim]`. Every other row is excluded and counted by
 *   {@link RoutingPolicyExclusion}; a row that names no cell is counted in {@link RoutingPolicyReport.unplaced}.
 * - CELL: capability (`routing.decision.capability`) × requested effort × task class (`benchmark_run.work.taskClass`).
 *   A non-dispatch lane's receipt names no class (`nonDispatchBenchmarkWork`): the review lane's and the sweep's fix
 *   rung's rows read `not-recorded-at-assignment`. Such a row takes the `task_class` of its task's latest `run.start`
 *   at or before it ({@link taskClassFromDispatch}): the dispatch's own row, and the field its receipt copies
 *   (`observeBenchmarkWork`). A lane's own `run.start` (triage, retro) names its lane, not a task class, so only a
 *   plan task's counts; a row with neither stays unplaced as `no-task-class`.
 * - OUTCOME: the ledger-only terminal join routing-experiment-result.ts uses, per pipeline. Its helpers are private
 *   to that module, so the join is restated below ({@link terminalOutcome}); a change to one must change both.
 * - ESTIMATOR: Hajek (self-normalised) weights `1 / selectedProbability`, the estimator knowledge-outcome.ts runs
 *   for learnings. Its `hajek` is private and takes no clusters, so the sums are restated here per task.
 * - INTERVAL: a 2,000-draw bootstrap over TASKS, seeded from the cell, so one task's attempts move together.
 * - DECISION: the experiments' rule ({@link ROUTING_POLICY_RULE}), with effective tasks per arm as the floor. Every
 *   sum it reads is compensated, and its tolerance absorbs representation error alone.
 *
 * INVARIANT within-support: no estimate values a provider that the logged policy gave probability 0 in its cell.
 * SURFACE, DO NOT ACT: nothing routes on these rows. W1-T12143 reads a concluded cell as randomised evidence.
 */

type Row = Record<string, unknown>;
export type RoutingPolicyPipeline = "build" | "fix" | "review";
export type RoutingPolicyProvider = "claude" | "codex";
export type RoutingPolicyTarget = "always-claude" | "always-codex" | "logged";

export const ROUTING_POLICY_ESTIMATE_STEP = "routing.policy.estimate";

/**
 * The experiments' decision rule (every live experiment in routing-experiments.ts declares 0.10 at 95% with 80%
 * power and a 20-task floor), plus the estimator's own trim and bootstrap size. The trim equals
 * knowledge-outcome.ts's `OUTCOME_PROPENSITY_TRIM`: an inverse weight of 20+ lets one task dominate an arm.
 *
 * `tolerance` absorbs floating-point representation error and nothing else, so it is RELATIVE to the operands: a
 * computed value within `tolerance × s` of a threshold is AT it, where `s` is the magnitude of what produced it —
 * the larger of the two rates a difference subtracts, or the effective n and the floor. Doubles miss exact
 * boundaries (0.5 − 0.4 is 0.09999999999999998), but by a bounded amount. Every sum the decision reads is
 * compensated ({@link plus}), so it holds within 2u of its terms whatever their count (u = 2^-53; Higham,
 * "Accuracy and Stability of Numerical Algorithms", 2nd ed., eq. 4.8). With each weight's own rounding, a rate
 * then carries at most 11u of relative error, a difference of two rates 24u of the larger, and Kish's effective n
 * 37u of itself. 2^-45 is 256u, about 2.8e-14: seven times the largest of those bounds, and any gap wider than
 * that share of the operands is a shortfall. The bar at 0.10 between rates near 0.5 therefore gives 1.4e-14.
 */
export interface RoutingPolicyRule {
  minimumDifference: number;
  power: number;
  confidence: number;
  minTasksPerArm: number;
  trim: number;
  draws: number;
  tolerance: number;
}
export const ROUTING_POLICY_RULE: Readonly<RoutingPolicyRule> = {
  minimumDifference: 0.1,
  power: 0.8,
  confidence: 0.95,
  minTasksPerArm: 20,
  trim: 0.05,
  draws: 2000,
  tolerance: 2 ** -45,
};

/** Whether `value` reaches `threshold`, where both come from operands of magnitude `scale`: a gap within their
 *  representation error ({@link RoutingPolicyRule.tolerance}) is no gap, and any larger gap is a shortfall. */
const reaches = (value: number, threshold: number, scale: number, rule: Readonly<RoutingPolicyRule>): boolean =>
  value >= threshold - rule.tolerance * scale;

/** always-codex minus always-claude, and exactly 0 when the two rates agree within their representation error: so
 *  the interval's bounds compare with 0 bare, as the experiments' do (`evaluateRoutingExperimentResult`). */
const gap = (claude: number, codex: number, rule: Readonly<RoutingPolicyRule>): number => {
  const difference = codex - claude;
  return Math.abs(difference) <= rule.tolerance * Math.max(claude, codex) ? 0 : difference;
};

/** A running sum and the low-order bits its last addition dropped. */
interface Compensated { sum: number; carry: number }
const compensated = (): Compensated => ({ sum: 0, carry: 0 });

/** Kahan's compensated step: the sum stays within (2u + O(n·u²)) of the summed magnitudes however many terms it
 *  takes (Higham, eq. 4.8), where a plain running sum drifts by up to (n − 1)·u: plain sums read an exact 0.10
 *  effect over two 1,000-task arms of the auction's equal weights as 0.09999999999997594, 2.4e-14 short. */
function plus(acc: Compensated, value: number): void {
  const y = value - acc.carry;
  const t = acc.sum + y;
  acc.carry = (t - acc.sum) - y;
  acc.sum = t;
}

/** Effective tasks each arm needs: the two-proportion sample `requiredRoutingTasksPerArm` computes for an
 *  experiment (symmetric rates about 0.5, the largest variance), never below the experiments' task floor. */
export function routingPolicyFloor(rule: Readonly<RoutingPolicyRule> = ROUTING_POLICY_RULE): number {
  const d = rule.minimumDifference;
  return Math.max(rule.minTasksPerArm, Math.ceil(twoProportionSampleSize((1 - d) / 2, (1 + d) / 2, 1 - rule.confidence, rule.power)));
}

/** Why an assignment row in a cell did not enter its estimate, in the order the reasons are tested. */
export const ROUTING_POLICY_EXCLUSIONS = [
  "no-propensity", // written before W1-T4617 logged a probability
  "fallback", // a `*-fallback` rule settled the provider with no weighing
  "preference", // a capability, role or operator preference chose the provider
  "single-candidate", // one provider could serve
  "unavailable", // the probability is unavailable or disagrees with its own candidate list
  "other-rule", // a draw under a rule other than the auction or the fix learner (credits lane, mount affinity)
  "zero-support", // Claude or Codex had probability 0 (or none) in the draw
  "trimmed", // a provider's probability lies outside [trim, 1 - trim]
  "no-outcome", // no terminal row joins it yet
] as const;
export type RoutingPolicyExclusion = (typeof ROUTING_POLICY_EXCLUSIONS)[number];
export const ROUTING_POLICY_UNPLACED = ["no-capability", "no-effort", "no-task-class"] as const;
export type RoutingPolicyUnplaced = (typeof ROUTING_POLICY_UNPLACED)[number];

export interface RoutingPolicyValue {
  /** Hajek estimate of the pipeline's positive rate under this policy; null when no row was served by its provider. */
  estimate: number | null;
  /** Task-bootstrap percentile interval of `estimate` at the rule's confidence. */
  interval: { lower: number; upper: number } | null;
  /** Assignments served by the policy's provider (every assignment for `logged`). */
  n: number;
  tasks: number;
  /** Kish's (Σw)² / Σw² over TASK weights (a task's weight sums its attempts'), so retries never inflate it, and
   *  n equal task weights read exactly n ({@link kish}). */
  effectiveN: number;
}

export interface RoutingPolicyDifference {
  /** always-codex minus always-claude, 0 within representation error ({@link RoutingPolicyRule.tolerance}). For
   *  review the positive outcome is a FAILED review, so lower wins. */
  estimate: number;
  lower: number;
  upper: number;
  confidence: number;
  method: "task-bootstrap";
}

export interface RoutingPolicyPipelineEstimate {
  n: number;
  tasks: number;
  /** Smallest and largest logged probability of each provider among the rows estimated from. */
  support: Record<RoutingPolicyProvider, { min: number; max: number }>;
  policies: Record<RoutingPolicyTarget, RoutingPolicyValue>;
  difference: RoutingPolicyDifference | null;
}

export type RoutingPolicyDecisionCode =
  | "winner" | "no-support" | "below-floor" | "interval-includes-zero" | "below-minimum-difference" | "pipelines-disagree";

/** One `routing.policy.estimate` row's payload: one cell on one UTC day. */
export interface RoutingPolicyEstimate {
  /** `capability/effort/taskClass`. */
  cellKey: string;
  cell: { capability: string; effort: string; taskClass: string };
  day: string;
  rule: RoutingPolicyRule & { floor: number };
  /** concluded: every active pipeline clears the floor and the rule, and they agree. underpowered: an arm sits
   *  below the floor (or nothing is in support). running: the floor is met and the rule is not. */
  status: "running" | "concluded" | "underpowered";
  concluded: boolean;
  /** The provider an always-one policy should pick; null unless concluded. */
  winner: RoutingPolicyProvider | null;
  decision: { code: RoutingPolicyDecisionCode; reason: string };
  /** Assignments and tasks estimated from: in support, inside the trim, with an outcome. */
  n: number;
  tasks: number;
  /** Each always-one arm's smallest effective n over the active pipelines: the number the floor is read against. */
  effectiveN: Record<"always-claude" | "always-codex", number | null>;
  /** trimmed / (trimmed + no-outcome + estimated): the in-support share the trim removed. */
  trimmedShare: number | null;
  excluded: Record<RoutingPolicyExclusion, number>;
  /** Earliest and latest assignment `ts` estimated from. */
  window: { from: string; to: string } | null;
  pipelines: Record<RoutingPolicyPipeline, RoutingPolicyPipelineEstimate | null>;
}

export interface RoutingPolicyReport {
  day: string;
  cells: RoutingPolicyEstimate[];
  unplaced: Record<RoutingPolicyUnplaced, number>;
}

const PIPELINES: readonly RoutingPolicyPipeline[] = ["build", "fix", "review"];
const PREFERENCE_RULES = new Set(["capability-preference", "role-preference", "operator-preference", "preference-bypassed"]);
const object = (value: unknown): Row => value !== null && typeof value === "object" ? value as Row : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const fixed = (value: number): string => value.toFixed(3);
/** Code-unit order: locale-independent, and cheap over a whole ledger union. */
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function assertDay(day: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || fixedClock(Date.parse(day)).iso().slice(0, 10) !== day) {
    throw new Error(`invalid routing policy day: ${day}`);
  }
}

/** The terminal classification of routing-experiment-result.ts, restated (see the module doc). */
function terminalOutcome(row: Row): { pipeline: RoutingPolicyPipeline; positive: number } | undefined {
  if (row.step === "verdict.merged" || (row.step === "verdict" && row.verdict === "merged")) return { pipeline: "build", positive: 1 };
  if (row.step === "verdict" && ["failed", "refused", "abandoned", "no_pr"].includes(text(row.verdict))) return { pipeline: "build", positive: 0 };
  if (row.step === "fix.done") return { pipeline: "fix", positive: row.subtype === "success"
    && typeof row.pushed_head_sha === "string" && row.pushed_head_sha.length > 0
    && row.fix_outcome !== "NEEDS_DESIGN" && row.fix_outcome !== "NEEDS_SCOPE" ? 1 : 0 };
  if (row.step === "review.posted" && ["success", "failure"].includes(text(row.state))) {
    return { pipeline: "review", positive: row.state === "failure" ? 1 : 0 };
  }
  return undefined;
}

/** A plan task's id, the shape dispatch-value.ts's `PLAN_TASK_ID` reads `run.start` by: a lane's own id
 *  (`TRIAGE-<feedback>`, `PR-<n>`) never matches. */
const PLAN_TASK_ID = /^[A-Z][A-Z0-9]*-T\d+$/;

/** The class a dispatch's `run.start` gave its task, or undefined for any other row. */
function taskClassFromDispatch(row: Row): { task: string; taskClass: string } | undefined {
  const task = text(row.task_id);
  const taskClass = text(row.task_class);
  return row.step === "run.start" && PLAN_TASK_ID.test(task) && taskClass ? { task, taskClass } : undefined;
}

interface Observation { task: string; served: string; weight: number; claude: number; codex: number; ts: string }
type Admission = { reason: RoutingPolicyExclusion } | Omit<Observation, "task" | "ts">;

/** INVARIANT within-support: a row enters only when its draw gave BOTH providers a positive probability inside the
 *  trim, so no target policy is ever valued on traffic where the logged policy could not have chosen it. */
function admit(routing: Row, served: string, trim: number): Admission {
  const decision = object(routing.decision);
  const rule = text(decision.rule);
  if (routing.propensity === null || typeof routing.propensity !== "object") return { reason: "no-propensity" };
  if (rule.endsWith("-fallback")) return { reason: "fallback" };
  if (PREFERENCE_RULES.has(rule)) return { reason: "preference" };
  const propensity = object(routing.propensity);
  if (propensity.method === "single-candidate") return { reason: "single-candidate" };
  if (propensity.method !== ROUTING_DRAW_METHOD) return { reason: "unavailable" };
  if (rule !== "headroom-auction" && typeof decision.learner !== "string") return { reason: "other-rule" };
  const candidates = Array.isArray(propensity.candidates) ? propensity.candidates.map(object) : [];
  const probability = (provider: string): unknown => candidates.find((entry) => entry.provider === provider)?.probability;
  const claude = probability("claude");
  const codex = probability("codex");
  if (!positive(claude) || !positive(codex)) return { reason: "zero-support" };
  if (claude < trim || claude > 1 - trim || codex < trim || codex > 1 - trim) return { reason: "trimmed" };
  const selected = propensity.selectedProbability;
  if (!positive(selected) || selected > 1 || !(Math.abs(selected - Number(probability(served))) <= 1e-9)) return { reason: "unavailable" };
  return { served, weight: 1 / selected, claude, codex };
}

interface Cluster { task: string; sums: Record<RoutingPolicyTarget, { w: Compensated; wy: Compensated; n: number }> }

const emptySums = (): Cluster["sums"] => ({
  "always-claude": { w: compensated(), wy: compensated(), n: 0 }, "always-codex": { w: compensated(), wy: compensated(), n: 0 },
  logged: { w: compensated(), wy: compensated(), n: 0 },
});

/** Kish's effective sample size, over weights scaled by their largest: n equal weights each scale to exactly 1, so
 *  they read exactly n, where the unscaled sums of 392 weights of 1/0.3 read 391.9999999999956. */
function kish(weights: readonly number[]): number {
  const largest = weights.reduce((a, b) => Math.max(a, b), 0);
  if (!(largest > 0)) return 0;
  const total = compensated(), squares = compensated();
  for (const w of weights) {
    const scaled = w / largest;
    plus(total, scaled); plus(squares, scaled * scaled);
  }
  return total.sum * total.sum / squares.sum;
}

function percentile(values: number[], confidence: number): { lower: number; upper: number } | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  return { lower: sorted[Math.floor(tail * (sorted.length - 1))]!, upper: sorted[Math.ceil((1 - tail) * (sorted.length - 1))]! };
}

function pipelineEstimate(observations: Array<Observation & { positive: number }>, seed: string, rule: Readonly<RoutingPolicyRule>): RoutingPolicyPipelineEstimate {
  const byTask = new Map<string, Cluster>();
  for (const o of observations) {
    const cluster = byTask.get(o.task) ?? { task: o.task, sums: emptySums() };
    const add = (target: RoutingPolicyTarget, w: number) => {
      const sum = cluster.sums[target];
      plus(sum.w, w); plus(sum.wy, w * o.positive); sum.n += 1;
    };
    add("logged", 1);
    if (o.served === "claude") add("always-claude", o.weight);
    if (o.served === "codex") add("always-codex", o.weight);
    byTask.set(o.task, cluster);
  }
  const clusters = [...byTask.values()].sort((a, b) => compare(a.task, b.task));
  const targets: RoutingPolicyTarget[] = ["always-claude", "always-codex", "logged"];
  const value = (target: RoutingPolicyTarget): number | null => {
    const w = compensated(), wy = compensated();
    for (const cluster of clusters) { plus(w, cluster.sums[target].w.sum); plus(wy, cluster.sums[target].wy.sum); }
    return w.sum > 0 ? wy.sum / w.sum : null;
  };
  // Resample TASKS: a task's attempts (and both providers' share of it) are drawn together or not at all.
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
  const draw = (n: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor(state / 0x100000000 * n);
  };
  const samples: Record<RoutingPolicyTarget | "difference", number[]> = { "always-claude": [], "always-codex": [], logged: [], difference: [] };
  // Flat per-task sums, one column per (target, w | wy): the draw loop touches no object.
  const columns = targets.flatMap((target) => [
    Float64Array.from(clusters, (cluster) => cluster.sums[target].w.sum), Float64Array.from(clusters, (cluster) => cluster.sums[target].wy.sum),
  ]);
  const totals = new Float64Array(columns.length);
  const carries = new Float64Array(columns.length);
  for (let n = 0; n < rule.draws; n++) {
    totals.fill(0);
    carries.fill(0);
    for (let k = 0; k < clusters.length; k++) {
      const j = draw(clusters.length);
      for (let c = 0; c < columns.length; c++) {
        // {@link plus}, inlined over the columns.
        const y = columns[c]![j]! - carries[c]!;
        const t = totals[c]! + y;
        carries[c] = (t - totals[c]!) - y;
        totals[c] = t;
      }
    }
    const values = targets.map((_, i) => totals[2 * i]! > 0 ? totals[2 * i + 1]! / totals[2 * i]! : null);
    targets.forEach((target, i) => { if (values[i] !== null) samples[target].push(values[i]!); });
    if (values[0] !== null && values[1] !== null) samples.difference.push(gap(values[0]!, values[1]!, rule));
  }
  const policies = Object.fromEntries(targets.map((target) => {
    const weights = clusters.map((cluster) => cluster.sums[target].w.sum).filter((w) => w > 0);
    const estimate = value(target);
    return [target, {
      estimate, interval: estimate === null ? null : percentile(samples[target], rule.confidence),
      n: clusters.reduce((sum, cluster) => sum + cluster.sums[target].n, 0), tasks: weights.length,
      effectiveN: kish(weights),
    }];
  })) as Record<RoutingPolicyTarget, RoutingPolicyValue>;
  const claude = policies["always-claude"].estimate;
  const codex = policies["always-codex"].estimate;
  const interval = percentile(samples.difference, rule.confidence);
  const range = (pick: (o: Observation) => number) => observations.reduce(
    (acc, o) => ({ min: Math.min(acc.min, pick(o)), max: Math.max(acc.max, pick(o)) }), { min: Infinity, max: -Infinity });
  return {
    n: observations.length, tasks: clusters.length,
    support: { claude: range((o) => o.claude), codex: range((o) => o.codex) },
    policies,
    difference: claude !== null && codex !== null && interval
      ? { estimate: gap(claude, codex, rule), ...interval, confidence: rule.confidence, method: "task-bootstrap" } : null,
  };
}

type Decision = Pick<RoutingPolicyEstimate, "status" | "winner" | "decision">;

/** The experiments' rule, read across every active pipeline as `evaluateRoutingExperimentResult` reads it: the
 *  difference is always-codex minus always-claude (its second arm minus its first), and EITHER sign concludes —
 *  an interval above 0 with a difference of at least the minimum favours the higher arm, one below 0 with a
 *  difference of at most minus the minimum the lower. The bounds compare with 0 strictly and the floor and the
 *  minimum inclusively, as the experiments' do; the floor and the minimum through {@link reaches}, the bounds bare,
 *  over resamples already exact at 0 ({@link pipelineEstimate}). */
function decide(pipelines: RoutingPolicyEstimate["pipelines"], rule: Readonly<RoutingPolicyRule>, floor: number): Decision {
  const stop = (status: Decision["status"], code: RoutingPolicyDecisionCode, reason: string): Decision =>
    ({ status, winner: null, decision: { code, reason } });
  const active = PIPELINES.flatMap((p) => pipelines[p] ? [[p, pipelines[p]] as const] : []);
  if (!active.length) return stop("underpowered", "no-support", "no assignment in this cell had both providers in support and an outcome");
  for (const [p, entry] of active) {
    for (const target of ["always-claude", "always-codex"] as const) {
      const effective = entry.policies[target].effectiveN;
      if (!reaches(effective, floor, Math.max(effective, floor), rule)) {
        return stop("underpowered", "below-floor", `${p}: ${target} has ${effective.toFixed(1)} effective tasks, below the floor of ${floor}`);
      }
    }
  }
  const favoured: Array<[RoutingPolicyPipeline, RoutingPolicyProvider]> = [];
  for (const [p, entry] of active) {
    // Both arms clear a positive floor, so both are valued and the difference exists.
    const d = entry.difference!;
    const scale = Math.max(entry.policies["always-claude"].estimate!, entry.policies["always-codex"].estimate!);
    const codexWhenHigher: RoutingPolicyProvider = p === "review" ? "claude" : "codex";
    const codexWhenLower: RoutingPolicyProvider = p === "review" ? "codex" : "claude";
    const excludesZeroAbove = d.lower > 0;
    const excludesZeroBelow = d.upper < 0;
    if (excludesZeroAbove && reaches(d.estimate, rule.minimumDifference, scale, rule)) favoured.push([p, codexWhenHigher]);
    else if (excludesZeroBelow && reaches(-d.estimate, rule.minimumDifference, scale, rule)) favoured.push([p, codexWhenLower]);
    else if (!excludesZeroAbove && !excludesZeroBelow) {
      return stop("running", "interval-includes-zero", `${p}: the interval ${fixed(d.lower)} to ${fixed(d.upper)} includes 0`);
    } else {
      return stop("running", "below-minimum-difference",
        `${p}: the difference ${fixed(d.estimate)} is below the minimum of ${rule.minimumDifference}`);
    }
  }
  if (favoured.some(([, provider]) => provider !== favoured[0]![1])) {
    return stop("running", "pipelines-disagree", `pipelines disagree: ${favoured.map(([p, provider]) => `${p} favours ${provider}`).join(", ")}`);
  }
  const winner = favoured[0]![1];
  const evidence = active.map(([p, entry]) => `${p}: always-codex minus always-claude ${fixed(entry.difference!.estimate)} `
    + `(${rule.confidence * 100}% interval ${fixed(entry.difference!.lower)} to ${fixed(entry.difference!.upper)})`);
  return { status: "concluded", winner, decision: { code: "winner",
    reason: `${winner} wins: ${evidence.join("; ")}; every arm has at least ${floor} effective tasks` } };
}

interface CellState {
  cell: RoutingPolicyEstimate["cell"];
  excluded: Record<RoutingPolicyExclusion, number>;
  pending: Map<string, Observation>;
}

/** Fold ledger rows (read through the union by the caller) into one estimate per cell. Rows dated after `today`
 *  are ignored. Pure: the same rows in any order give the same report. */
export function estimateRoutingPolicies(input: Iterable<Row>, today: string): RoutingPolicyReport {
  assertDay(today);
  const rule = ROUTING_POLICY_RULE;
  const until = Date.parse(today) + 86400000;
  // Same-ts rows are ordered by their serialisation, computed only for a tie.
  const serialised = new Map<Row, string>();
  const key = (row: Row): string => {
    const known = serialised.get(row);
    if (known !== undefined) return known;
    const made = JSON.stringify(row);
    serialised.set(row, made);
    return made;
  };
  const rows = [...input].filter((row) => {
    const at = Date.parse(text(row.ts));
    return Number.isFinite(at) && at < until;
  }).sort((a, b) => compare(text(a.ts), text(b.ts)) || compare(key(a), key(b)));
  type Placed = { task: string; ts: string; routing: Row; served: string }
    & ({ unplaced: RoutingPolicyUnplaced } | { cell: RoutingPolicyEstimate["cell"] });
  const assignments = new Map<string, Placed>();
  // Rows are in time order, so this holds each task's latest dispatch class at the row being read.
  const dispatchClass = new Map<string, string>();
  for (const row of rows) {
    const dispatched = taskClassFromDispatch(row);
    if (dispatched) { dispatchClass.set(dispatched.task, dispatched.taskClass); continue; }
    const assignment = object(row.worker_assignment);
    const id = text(assignment.id);
    if (row.step !== "worker.assignment" || !id) continue;
    const routing = object(assignment.routing);
    const capability = text(object(routing.decision).capability);
    const effort = text(object(assignment.requested).effort);
    const classEvidence = object(object(object(row.benchmark_run).work).taskClass);
    const taskClass = classEvidence.state === "observed" ? text(classEvidence.value) : dispatchClass.get(text(row.task_id)) ?? "";
    const unplaced = !capability ? "no-capability" : !effort ? "no-effort" : !taskClass ? "no-task-class" : undefined;
    assignments.set(id, { task: text(row.task_id) || id, ts: text(row.ts), routing,
      served: text(object(assignment.selected).provider), ...(unplaced ? { unplaced } : { cell: { capability, effort, taskClass } }) });
  }
  // The terminal join of routing-experiment-result.ts: by assignment id and task, after the assignment, last wins;
  // a sweep's task-level merge credit resolves through the PR head the assignment opened.
  const prAssignments = new Map<string, string>();
  for (const row of rows) {
    if (row.step === "pr.opened" && text(row.pr_url) && text(row.head_assignment)) prAssignments.set(text(row.pr_url), text(row.head_assignment));
  }
  const outcomes = new Map<string, { pipeline: RoutingPolicyPipeline; positive: number }>();
  for (const row of rows) {
    let id = text(row.selection_assignment_id) || text(object(row.evaluator_provenance).selectionAssignmentId);
    if (!id && row.step === "verdict.merged") id = prAssignments.get(text(row.pr_url)) ?? "";
    const assignment = assignments.get(id);
    if (!assignment || row.task_id !== assignment.task || text(row.ts) < assignment.ts) continue;
    const end = terminalOutcome(row);
    if (end) outcomes.set(id, end);
  }

  const unplaced = Object.fromEntries(ROUTING_POLICY_UNPLACED.map((reason) => [reason, 0])) as Record<RoutingPolicyUnplaced, number>;
  const cells = new Map<string, CellState>();
  for (const [id, assignment] of assignments) {
    if ("unplaced" in assignment) { unplaced[assignment.unplaced]++; continue; }
    const { capability, effort, taskClass } = assignment.cell;
    const cellKey = `${capability}/${effort}/${taskClass}`;
    const state = cells.get(cellKey) ?? { cell: assignment.cell, pending: new Map(),
      excluded: Object.fromEntries(ROUTING_POLICY_EXCLUSIONS.map((reason) => [reason, 0])) as Record<RoutingPolicyExclusion, number> };
    cells.set(cellKey, state);
    const admitted = admit(assignment.routing, assignment.served, rule.trim);
    if ("reason" in admitted) state.excluded[admitted.reason]++;
    else state.pending.set(id, { ...admitted, task: assignment.task, ts: assignment.ts });
  }

  const floor = routingPolicyFloor(rule);
  const estimates = [...cells.entries()].sort(([a], [b]) => compare(a, b)).map(([cellKey, state]): RoutingPolicyEstimate => {
    const byPipeline = new Map<RoutingPolicyPipeline, Array<Observation & { positive: number }>>();
    for (const [id, observation] of state.pending) {
      const end = outcomes.get(id);
      if (!end) { state.excluded["no-outcome"]++; continue; }
      const list = byPipeline.get(end.pipeline) ?? [];
      list.push({ ...observation, positive: end.positive });
      byPipeline.set(end.pipeline, list);
    }
    const pipelines = Object.fromEntries(PIPELINES.map((p) => {
      const observations = byPipeline.get(p);
      return [p, observations ? pipelineEstimate(observations, `${cellKey}:${p}`, rule) : null];
    })) as RoutingPolicyEstimate["pipelines"];
    const estimated = [...byPipeline.values()].flat();
    const active = PIPELINES.flatMap((p) => pipelines[p] ? [pipelines[p]] : []);
    const smallest = (target: "always-claude" | "always-codex") =>
      active.length ? Math.min(...active.map((entry) => entry.policies[target].effectiveN)) : null;
    const inSupport = state.excluded.trimmed + state.excluded["no-outcome"] + estimated.length;
    const times = estimated.map((o) => o.ts).sort();
    const decision = decide(pipelines, rule, floor);
    return {
      cellKey, cell: state.cell, day: today, rule: { ...rule, floor },
      ...decision, concluded: decision.status === "concluded",
      n: estimated.length, tasks: new Set(estimated.map((o) => o.task)).size,
      effectiveN: { "always-claude": smallest("always-claude"), "always-codex": smallest("always-codex") },
      trimmedShare: inSupport > 0 ? state.excluded.trimmed / inSupport : null,
      excluded: state.excluded,
      window: times.length ? { from: times[0]!, to: times[times.length - 1]! } : null,
      pipelines,
    };
  });
  return { day: today, cells: estimates, unplaced };
}

/** The ledger steps the estimate reads, beside its own rows (read back so a day is written once). */
export const ROUTING_POLICY_SOURCE_STEPS = ["worker.assignment", "verdict", "verdict.merged", "fix.done", "review.posted", "pr.opened",
  "run.start"] as const;

/** The measurement cadence's pass: one `routing.policy.estimate` row per cell per UTC day. A cell already written
 *  today is frozen for that day, concluded or not; the next day estimates it again from the larger log. */
export async function recordRoutingPolicyEstimates(opts: { stateDir: string; today?: string }): Promise<RoutingPolicyEstimate[]> {
  const today = opts.today ?? systemClock.iso().slice(0, 10);
  assertDay(today);
  // The daemon loop reaches this pass, so it streams the ledger off the event loop. Any unread file refuses
  // the pass: an estimate from part of the log would read as a smaller, different experiment.
  const unread: string[] = [];
  const rows: Row[] = [];
  for await (const row of openLedgerUnion(opts.stateDir, { step: [...ROUTING_POLICY_SOURCE_STEPS, ROUTING_POLICY_ESTIMATE_STEP],
    onUnreadArchive: (path) => unread.push(path), onUnreadLive: (path) => unread.push(path),
    onUnreadDirectory: (path) => unread.push(path) })) {
    // A run.start carries the task's whole shape block; the estimate reads its class alone, so keep only that.
    rows.push(row.step === "run.start" ? { ts: row.ts, step: row.step, task_id: row.task_id, task_class: row.task_class } : row);
  }
  if (unread.length > 0) throw new Error(`routing policy ledger unreadable: ${unread.join(", ")}`);
  const written = new Set(rows.flatMap((row) =>
    row.step === ROUTING_POLICY_ESTIMATE_STEP && row.day === today && typeof row.cell_key === "string" ? [row.cell_key] : []));
  const recorded: RoutingPolicyEstimate[] = [];
  for (const estimate of estimateRoutingPolicies(rows, today).cells) {
    if (written.has(estimate.cellKey)) continue;
    appendLedger(join(opts.stateDir, LEDGER_FILENAME), { run_id: `ROUTING-POLICY-${estimate.cellKey}-${today}`,
      task_id: "FLEET", step: ROUTING_POLICY_ESTIMATE_STEP, cell_key: estimate.cellKey, day: today, estimate });
    recorded.push(estimate);
  }
  return recorded;
}
