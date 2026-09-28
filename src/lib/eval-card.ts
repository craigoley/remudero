/**
 * lib/eval-card.ts — W1-T4630: the `eval-card-v1` record every field trial (W1-T4575 A/A,
 * W1-T4603 paid pilot, W1-T4625 paired trial) carries so a result can show its own validity.
 *
 * INVARIANT: a card is publishable only when a canonical protocol was hashed and committed
 * STRICTLY BEFORE the first assignment; anything else lists a blocker and reads unpublishable.
 * INVARIANT: absence is never zero — an empty cell, an unrun check or an ungraded trial reads
 * `unknown`, and an A/A card never names a winner.
 * INVARIANT: pure and private. Nothing here reads the ledger, publishes, or gates dispatch; the
 * site's reviewed release gate is the only consumer that may make a card public.
 */

import { createHash } from "node:crypto";
import type { ProofExecOutcome } from "./review.js";

export const EVAL_CARD_VERSION = "eval-card-v1" as const;
/** Conventional SRM alarm level: a split this unlikely under the plan means allocation is broken. */
export const SRM_ALPHA = 0.001;
const PROPENSITY_EXCERPT_CHARS = 280;

/** Line endings and trailing whitespace are presentation, not protocol content. */
export function canonicalProtocolText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

export function protocolHash(text: string): string {
  return createHash("sha256").update(canonicalProtocolText(text)).digest("hex");
}

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let sum = LANCZOS[0]!;
  for (let i = 1; i < LANCZOS.length; i += 1) sum += LANCZOS[i]! / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Regularized upper incomplete gamma Q(a, x): series below a+1, Lentz continued fraction above. */
export function regularizedGammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const front = Math.exp(-x + a * Math.log(x) - logGamma(a));
  if (x < a + 1) {
    let term = 1 / a;
    let sum = term;
    for (let n = 1; n < 1000 && Math.abs(term) > Math.abs(sum) * 1e-16; n += 1) {
      term *= x / (a + n);
      sum += term;
    }
    return Math.max(0, 1 - sum * front);
  }
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return front * h;
}

export function chiSquareSurvival(statistic: number, degreesOfFreedom: number): number {
  return statistic <= 0 ? 1 : regularizedGammaQ(degreesOfFreedom / 2, statistic / 2);
}

export interface ChiSquareFit {
  statistic: number;
  degreesOfFreedom: number;
  pValue: number;
}

/** Pearson goodness of fit of observed counts against planned proportions (normalized). */
export function chiSquareGoodnessOfFit(observed: readonly number[], plannedProportions: readonly number[]): ChiSquareFit {
  const total = observed.reduce((s, n) => s + n, 0);
  const weight = plannedProportions.reduce((s, p) => s + p, 0);
  let statistic = 0;
  observed.forEach((count, i) => {
    const expected = (total * plannedProportions[i]!) / weight;
    if (expected > 0) statistic += (count - expected) ** 2 / expected;
  });
  const degreesOfFreedom = observed.length - 1;
  return { statistic, degreesOfFreedom, pValue: chiSquareSurvival(statistic, degreesOfFreedom) };
}

export function normalCdf(z: number): number {
  const tail = 0.5 * regularizedGammaQ(0.5, (z * z) / 2);
  return z < 0 ? tail : 1 - tail;
}

/** Acklam's rational approximation, polished by one Halley step against {@link normalCdf}. */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  let x: number;
  if (p < low || p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(p < low ? p : 1 - p));
    const v = (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
    x = p < low ? v : -v;
  } else {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/** Two-sided two-proportion power at `n` per arm — the equation R's `power.prop.test` solves. */
export function twoProportionPower(n: number, p1: number, p2: number, alpha: number): number {
  const pooled = Math.sqrt(((p1 + p2) * (2 - p1 - p2)) / 2);
  const spread = Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return normalCdf((Math.sqrt(n) * Math.abs(p1 - p2) - normalQuantile(1 - alpha / 2) * pooled) / spread);
}

/** Units per arm (unrounded) at which {@link twoProportionPower} reaches `power`. */
export function twoProportionSampleSize(p1: number, p2: number, alpha: number, power: number): number {
  const pooled = Math.sqrt(((p1 + p2) * (2 - p1 - p2)) / 2);
  const spread = Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return ((normalQuantile(1 - alpha / 2) * pooled + normalQuantile(power) * spread) / Math.abs(p1 - p2)) ** 2;
}

/** Connor (1987) McNemar pairs for discordant share `psi` = p10 + p01 and effect `delta` = p10 − p01; NaN when |delta| > psi. */
export function mcnemarPairsRequired(psi: number, delta: number, alpha: number, power: number): number {
  if (!(psi > 0 && psi <= 1 && delta !== 0 && Math.abs(delta) <= psi)) return Number.NaN;
  return (normalQuantile(1 - alpha / 2) * Math.sqrt(psi) + normalQuantile(power) * Math.sqrt(psi - delta * delta)) ** 2 / (delta * delta);
}

export interface EvalCardPowerSpec {
  baselineRate: number;
  /** Absolute difference in verified-completion rate the trial must be able to detect. */
  minimumDetectableEffect: number;
  alpha?: number;
  power?: number;
  /** Expected share of discordant pairs, for the paired (McNemar) variant. */
  discordantRate?: number;
}

export interface EvalCardTrial {
  trialId: string;
  kind: "aa" | "paid-pilot" | "paired" | "paired-pilot" | "ab";
  protocolText: string | null;
  /** When the protocol was committed (ISO time). */
  preRegisteredAt: string | null;
  /** The hash recorded at registration; a text that no longer matches it is a changed protocol. */
  registeredProtocolHash?: string;
  estimand: string;
  randomizationUnit: string;
  propensity?: string;
  plannedAllocation: Record<string, number>;
  /** Declared `${arm}|${stratum}` cells; each is reported even when empty. */
  cells?: string[];
  power?: EvalCardPowerSpec;
  /** A non-A/A trial cites the A/A card it relies on. */
  aaReceipt?: string;
}

export interface EvalCardAssignment {
  unitId: string;
  arm: string;
  assignedAt: string;
  taskId?: string;
}

export interface EvalCardOutcome {
  unitId: string;
  arm: string;
  stratum: string;
  /** null: no verified outcome yet (censored or unavailable) — excluded from rates, counted apart. */
  success: boolean | null;
}

export interface EvalCardDeviation {
  at: string | null;
  kind: string;
  description: string;
  source?: "declared" | "derived";
}

export interface EvalCardEvidence {
  assignments: EvalCardAssignment[];
  outcomes: EvalCardOutcome[];
  /** Ledger rows; only `review.posted` rows for the trial's tasks are read. */
  reviewRows: ReadonlyArray<Record<string, unknown>>;
  deviations: EvalCardDeviation[];
}

export function emptyEvalCardEvidence(): EvalCardEvidence {
  return { assignments: [], outcomes: [], reviewRows: [], deviations: [] };
}

const GRADER_DEGRADES = ["executed_stale", "not_executable", "exec_error"] as const satisfies readonly ProofExecOutcome[];

export type GraderValidity =
  | { state: "unknown"; reason: string }
  | {
    state: "observed";
    reviews: number;
    criteria: number;
    counts: Record<(typeof GRADER_DEGRADES)[number], number>;
    shares: Record<(typeof GRADER_DEGRADES)[number], number>;
    /** Share of the trial's reviews that graded at least one holdout criterion. */
    holdoutCoverage: number;
  };

/** The latest `review.posted` per (task, PR) for the trial's tasks; its criteria's proof outcomes are the grader's validity. */
export function graderValidityFromReviewRows(rows: ReadonlyArray<Record<string, unknown>>, taskIds: ReadonlySet<string>): GraderValidity {
  const latest = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    if (row.step !== "review.posted" || typeof row.task_id !== "string" || !taskIds.has(row.task_id)) continue;
    const criteria = (row.decision_verdict as { criteria?: unknown } | undefined)?.criteria;
    if (!Array.isArray(criteria)) continue;
    latest.set(`${row.task_id}\u0000${String(row.pr_url ?? "")}`, criteria as Array<Record<string, unknown>>);
  }
  if (latest.size === 0) return { state: "unknown", reason: "no-graded-review-for-trial-tasks" };
  const counts = { executed_stale: 0, not_executable: 0, exec_error: 0 };
  let criteriaTotal = 0;
  let withHoldout = 0;
  for (const criteria of latest.values()) {
    criteriaTotal += criteria.length;
    if (criteria.some((c) => c.holdout === true)) withHoldout += 1;
    for (const c of criteria) {
      const outcome = c.proof_exec as string;
      if (outcome === "executed_stale" || outcome === "not_executable" || outcome === "exec_error") counts[outcome] += 1;
    }
  }
  const share = (n: number) => (criteriaTotal === 0 ? 0 : n / criteriaTotal);
  return {
    state: "observed",
    reviews: latest.size,
    criteria: criteriaTotal,
    counts,
    shares: { executed_stale: share(counts.executed_stale), not_executable: share(counts.not_executable), exec_error: share(counts.exec_error) },
    holdoutCoverage: withHoldout / latest.size,
  };
}

function timeOf(iso: string | null | undefined): number {
  return typeof iso === "string" ? Date.parse(iso) : Number.NaN;
}

export type SampleRatioCheck =
  | { state: "unknown"; reason: string }
  | {
    state: "observed";
    planned: Record<string, number>;
    observed: Record<string, number>;
    statistic: number;
    degreesOfFreedom: number;
    pValue: number;
    mismatch: boolean;
    crossoverUnits: number;
    unplannedArmUnits: number;
  };

interface UnitAllocation {
  firstArm: Map<string, EvalCardAssignment>;
  crossovers: EvalCardAssignment[];
}

/** Intention to treat: a unit belongs to the arm of its EARLIEST assignment; a later other-arm assignment is a crossover. */
function allocateUnits(assignments: readonly EvalCardAssignment[]): UnitAllocation {
  const ordered = [...assignments].sort((x, y) => timeOf(x.assignedAt) - timeOf(y.assignedAt));
  const firstArm = new Map<string, EvalCardAssignment>();
  const crossed = new Map<string, EvalCardAssignment>();
  for (const a of ordered) {
    const first = firstArm.get(a.unitId);
    if (!first) firstArm.set(a.unitId, a);
    else if (first.arm !== a.arm && !crossed.has(a.unitId)) crossed.set(a.unitId, a);
  }
  return { firstArm, crossovers: [...crossed.values()] };
}

function sampleRatio(trial: EvalCardTrial, units: UnitAllocation): SampleRatioCheck {
  const arms = Object.keys(trial.plannedAllocation).sort();
  if (arms.length < 2) return { state: "unknown", reason: "fewer-than-two-planned-arms" };
  if (units.firstArm.size === 0) return { state: "unknown", reason: "no-assignments" };
  const observed: Record<string, number> = Object.fromEntries(arms.map((arm) => [arm, 0]));
  let unplannedArmUnits = 0;
  for (const a of units.firstArm.values()) {
    if (a.arm in observed) observed[a.arm]! += 1;
    else unplannedArmUnits += 1;
  }
  const fit = chiSquareGoodnessOfFit(arms.map((arm) => observed[arm]!), arms.map((arm) => trial.plannedAllocation[arm]!));
  return {
    state: "observed",
    planned: Object.fromEntries(arms.map((arm) => [arm, trial.plannedAllocation[arm]!])),
    observed,
    ...fit,
    mismatch: fit.pValue < SRM_ALPHA,
    crossoverUnits: units.crossovers.length,
    unplannedArmUnits,
  };
}

export type AaSection =
  | { state: "cited"; receipt: string }
  | { state: "missing"; reason: string }
  | { state: "unknown"; reason: string }
  | {
    state: "observed";
    arms: Record<string, { n: number; successes: number; rate: number }>;
    difference: { estimate: number; low: number; high: number };
    pValue: number;
    winnerDeclared: false;
  };

function aaSection(trial: EvalCardTrial, outcomes: readonly EvalCardOutcome[]): AaSection {
  if (trial.kind !== "aa") {
    return trial.aaReceipt ? { state: "cited", receipt: trial.aaReceipt } : { state: "missing", reason: "no-aa-receipt-cited" };
  }
  const arms = Object.keys(trial.plannedAllocation).sort();
  if (arms.length !== 2) return { state: "unknown", reason: "aa-needs-exactly-two-arms" };
  const tally = Object.fromEntries(arms.map((arm) => [arm, { n: 0, successes: 0, rate: 0 }]));
  for (const o of outcomes) {
    const t = tally[o.arm];
    if (!t || o.success === null) continue;
    t.n += 1;
    if (o.success) t.successes += 1;
  }
  const [a, b] = arms.map((arm) => tally[arm]!);
  if (a!.n === 0 || b!.n === 0) return { state: "unknown", reason: "an-arm-has-no-graded-outcome" };
  for (const t of [a!, b!]) t.rate = t.successes / t.n;
  const estimate = a!.rate - b!.rate;
  const se = Math.sqrt((a!.rate * (1 - a!.rate)) / a!.n + (b!.rate * (1 - b!.rate)) / b!.n);
  const pooled = (a!.successes + b!.successes) / (a!.n + b!.n);
  const pooledSe = Math.sqrt(pooled * (1 - pooled) * (1 / a!.n + 1 / b!.n));
  const pValue = pooledSe === 0 ? 1 : 2 * (1 - normalCdf(Math.abs(estimate) / pooledSe));
  const z = normalQuantile(0.975);
  return { state: "observed", arms: tally, difference: { estimate, low: estimate - z * se, high: estimate + z * se }, pValue, winnerDeclared: false };
}

export type PowerSection =
  | { state: "undeclared" }
  | {
    state: "declared";
    alpha: number;
    targetPower: number;
    twoProportion: {
      baselineRate: number;
      comparisonRate: number;
      unitsPerArm: number;
      observedMinArmUnits: number | "unknown";
      achievedPower: number | "unknown";
    };
    paired: { state: "computed"; discordantRate: number; pairs: number } | { state: "unknown"; reason: string };
  };

function powerSection(spec: EvalCardPowerSpec | undefined, srm: SampleRatioCheck): PowerSection {
  if (!spec) return { state: "undeclared" };
  const alpha = spec.alpha ?? 0.05;
  const targetPower = spec.power ?? 0.8;
  const comparisonRate = spec.baselineRate + spec.minimumDetectableEffect;
  const minArm = srm.state === "observed" ? Math.min(...Object.values(srm.observed)) : 0;
  const pairs = spec.discordantRate === undefined ? Number.NaN : mcnemarPairsRequired(spec.discordantRate, spec.minimumDetectableEffect, alpha, targetPower);
  return {
    state: "declared",
    alpha,
    targetPower,
    twoProportion: {
      baselineRate: spec.baselineRate,
      comparisonRate,
      unitsPerArm: Math.ceil(twoProportionSampleSize(spec.baselineRate, comparisonRate, alpha, targetPower)),
      observedMinArmUnits: minArm > 0 ? minArm : "unknown",
      achievedPower: minArm > 0 ? twoProportionPower(minArm, spec.baselineRate, comparisonRate, alpha) : "unknown",
    },
    paired: Number.isFinite(pairs)
      ? { state: "computed", discordantRate: spec.discordantRate!, pairs: Math.ceil(pairs) }
      : { state: "unknown", reason: spec.discordantRate === undefined ? "no-discordant-rate-declared" : "discordant-rate-cannot-carry-effect" },
  };
}

export type CoverageCell =
  | { cell: string; declared: boolean; state: "unknown"; n: 0; unavailableOutcomes: number }
  | { cell: string; declared: boolean; state: "observed"; n: number; successes: number; successRate: number; unavailableOutcomes: number };

function coverage(trial: EvalCardTrial, outcomes: readonly EvalCardOutcome[]): CoverageCell[] {
  const tally = new Map<string, { n: number; successes: number; unavailable: number }>();
  for (const o of outcomes) {
    const key = `${o.arm}|${o.stratum}`;
    const t = tally.get(key) ?? { n: 0, successes: 0, unavailable: 0 };
    if (o.success === null) t.unavailable += 1;
    else {
      t.n += 1;
      if (o.success) t.successes += 1;
    }
    tally.set(key, t);
  }
  const declared = trial.cells ?? [];
  const cells = [...declared, ...[...tally.keys()].filter((k) => !declared.includes(k)).sort()];
  return cells.map((cell): CoverageCell => {
    const t = tally.get(cell) ?? { n: 0, successes: 0, unavailable: 0 };
    const isDeclared = declared.includes(cell);
    if (t.n === 0) return { cell, declared: isDeclared, state: "unknown", n: 0, unavailableOutcomes: t.unavailable };
    return { cell, declared: isDeclared, state: "observed", n: t.n, successes: t.successes, successRate: t.successes / t.n, unavailableOutcomes: t.unavailable };
  });
}

export interface EvalCard {
  version: typeof EVAL_CARD_VERSION;
  state: "observed" | "unavailable";
  trialId: string | null;
  kind: EvalCardTrial["kind"] | null;
  /** Always private here; only the site's reviewed release gate may make a card public. */
  visibility: "private";
  publishable: boolean;
  blockers: string[];
  preRegistration: {
    protocolHash: string | null;
    committedAt: string | null;
    firstAssignmentAt: string | null;
    precedesFirstAssignment: boolean | "unknown";
  };
  design: { estimand: string; randomizationUnit: string; propensityExcerpt: string };
  aa: AaSection;
  sampleRatio: SampleRatioCheck;
  power: PowerSection;
  coverage: CoverageCell[];
  graderValidity: GraderValidity;
  deviations: EvalCardDeviation[];
}

function excerpt(text: string | undefined): string {
  if (!text || text.trim() === "") return "unavailable";
  const flat = text.trim();
  return flat.length <= PROPENSITY_EXCERPT_CHARS ? flat : `${flat.slice(0, PROPENSITY_EXCERPT_CHARS)}…`;
}

function sortDeviations(deviations: EvalCardDeviation[]): EvalCardDeviation[] {
  const key = (d: EvalCardDeviation) => (Number.isFinite(timeOf(d.at)) ? timeOf(d.at) : Number.POSITIVE_INFINITY);
  return [...deviations].sort((x, y) => key(x) - key(y));
}

/** Build the `eval-card-v1` record for one trial. `trial` null is an unregistered trial: an unavailable, unpublishable card. */
export function buildEvalCard(trial: EvalCardTrial | null, evidence: EvalCardEvidence): EvalCard {
  const t: EvalCardTrial = trial ?? {
    trialId: "", kind: "ab", protocolText: null, preRegisteredAt: null, estimand: "unavailable", randomizationUnit: "unavailable", plannedAllocation: {},
  };
  const blockers: string[] = [];
  const derived: EvalCardDeviation[] = [];
  const units = allocateUnits(evidence.assignments);
  const first = [...units.firstArm.values()].reduce<EvalCardAssignment | undefined>(
    (min, a) => (!min || timeOf(a.assignedAt) < timeOf(min.assignedAt) ? a : min), undefined);
  const hash = t.protocolText && t.protocolText.trim() !== "" ? protocolHash(t.protocolText) : null;
  const committed = timeOf(t.preRegisteredAt);
  let precedes: boolean | "unknown" = "unknown";
  if (hash === null || !Number.isFinite(committed)) blockers.push("no-committed-pre-registration");
  else if (first && Number.isFinite(timeOf(first.assignedAt))) {
    precedes = committed < timeOf(first.assignedAt);
    if (!precedes) {
      blockers.push("pre-registration-postdates-first-assignment");
      derived.push({ at: t.preRegisteredAt, kind: "pre-registration-postdates-first-assignment", description: `committed after the first assignment at ${first.assignedAt}`, source: "derived" });
    }
  }
  if (hash !== null && t.registeredProtocolHash !== undefined && t.registeredProtocolHash !== hash) {
    blockers.push("protocol-text-changed-after-registration");
    derived.push({ at: null, kind: "protocol-text-changed-after-registration", description: "protocol text no longer hashes to its registered hash", source: "derived" });
  }
  const srm = sampleRatio(t, units);
  if (srm.state === "observed" && srm.mismatch) {
    derived.push({ at: null, kind: "sample-ratio-mismatch", description: `observed split ${JSON.stringify(srm.observed)} vs plan, p=${srm.pValue.toExponential(2)}`, source: "derived" });
  }
  for (const c of units.crossovers) derived.push({ at: c.assignedAt, kind: "crossover", description: `unit ${c.unitId} later assigned to ${c.arm}`, source: "derived" });
  const taskIds = new Set(evidence.assignments.map((a) => a.taskId ?? a.unitId));
  return {
    version: EVAL_CARD_VERSION,
    state: trial ? "observed" : "unavailable",
    trialId: trial ? trial.trialId : null,
    kind: trial ? trial.kind : null,
    visibility: "private",
    publishable: trial !== null && blockers.length === 0,
    blockers,
    preRegistration: { protocolHash: hash, committedAt: hash === null ? null : t.preRegisteredAt, firstAssignmentAt: first?.assignedAt ?? null, precedesFirstAssignment: precedes },
    design: { estimand: t.estimand, randomizationUnit: t.randomizationUnit, propensityExcerpt: excerpt(t.propensity) },
    aa: trial ? aaSection(t, evidence.outcomes) : { state: "missing", reason: "no-trial-registered" },
    sampleRatio: srm,
    power: powerSection(t.power, srm),
    coverage: coverage(t, evidence.outcomes),
    graderValidity: graderValidityFromReviewRows(evidence.reviewRows, taskIds),
    deviations: sortDeviations([...evidence.deviations.map((d) => ({ ...d, source: d.source ?? "declared" as const })), ...derived]),
  };
}
