import type { Mounts } from "./mounts.js";
import type { BillingMode } from "./env.js";
import { pooledPriorFor, type PoolableEvidence } from "./routing-prior.js";
import { routingObjectiveFor, type ArmWindowShare, type RoutingObjectiveKind } from "./routing-objective.js";

/**
 * THE RECOMMENDATION LEG (W1-T2575, MASTER-PLAN §9, WS-8).
 *
 * scripts/mount-headroom-sweep.mjs (W1-T2560, extended W1-T2574) already MEASURES: it groups
 * retained ledger runs into (type, risk, class) CELLS and, within each cell only, into
 * (provider, served_model, effort) ARMS, and reports every within-cell pairwise comparison —
 * "which mount is cheaper" as a printed table a human must read and act on. Nothing turned that
 * evidence into a DECISION: this module is the missing leg.
 *
 * §9's own ruling on the shape (quoted in this task's plan shard) is what this module implements,
 * not a new design: "Routing is knowledge — golden-calibrated. mounts.yaml changes ship as PRs
 * behind the golden suite like every other knowledge change. The flywheel proposes DOWNGRADES
 * when a cheaper mount passes a task-type's goldens above threshold, and UPGRADES when strike-rate
 * correlates with mount." A recommender that edited routing live would violate that doctrine
 * outright — so {@link recommendMounts} below is a PURE function (no I/O, no child_process, no
 * mount ever mutated) that turns a sweep's cells into either a {@link MountRecommendation} or a
 * {@link MountRefusal}, and {@link mountRecommendationProposalCandidate} turns a recommendation
 * into the SAME proposal shape `lib/feedback-docket.ts`'s `DocketProposalCandidate` already
 * hands `updateProposalRegistry` — the EXISTING ratification path (`rmd inbox` tiers it, `rmd
 * approve` ratifies it through the gate into a plan PR). This module holds no authority to merge
 * anything and builds no second ratification mechanism.
 *
 * IT MUST REFUSE MORE OFTEN THAN IT RECOMMENDS (this task's own rationale, verbatim). Every gate
 * below is a REFUSAL reason, checked in this order, and the first one that fires wins:
 *   1. `unmatched-arms`   — the cell has fewer than two arms; no comparison is even possible
 *                           (mirrors `compareArms`'s own cross-cell refusal, scripts/mount-
 *                           headroom-sweep.mjs — this is the WITHIN-cell analogue: nothing to
 *                           measure against).
 *   2. `insufficient-sample` — either arm's `n` sits below the declared floor
 *                           ({@link DEFAULT_MIN_SAMPLE_N}). "No recommendation yet, n=4 against a
 *                           floor of 30" is the correct, expected output for most cells for a
 *                           long time.
 *   3. `no-stable-advantage` — the sweep's own `compareArms` already computed whether the
 *                           cheaper-per-run arm's advantage HOLDS once re-dispatch cost is
 *                           charged to it (`advantageHoldsUnderRedispatch`); anything other than a
 *                           confirmed `true` is refused rather than guessed at.
 *   4. `quality-regression` — OUTCOME BEFORE COST (the sweep script's own rule, restated here for
 *                           a recommendation): a cheaper arm whose observed pass rate is LOWER
 *                           than the costlier arm's is never recommended, however large the cost
 *                           gap.
 *   5. `tier-invariant`    — a proposed mount that would violate the Tier Invariant (G-17,
 *                           `lib/mounts.ts`) is refused AT PROPOSAL TIME, the violation named,
 *                           rather than emitted for a human to discover when the config fails to
 *                           load. `mounts.ts` is out of this task's file scope (this task never
 *                           edits it), so the check below is a deliberately small, read-only
 *                           re-statement of the SAME two ANDed conditions `enforceTierInvariant`
 *                           already enforces at load — see {@link tierInvariantViolation}.
 *   6. `objective-disagreement` (W1-T2577) — `routingObjectiveFor` (routing-objective.ts) is the
 *                           REAL objective: notional dollars under `billing_mode == "api"`, or
 *                           window share consumed per settled task under `"subscription"` when
 *                           BOTH arms' windows are readable (falling back to dollars, loudly,
 *                           when they are not — never silently). When the sweep's dollar-cheaper
 *                           arm is not ALSO the window-share-cheaper arm, this refuses rather than
 *                           recommending a mount that optimises a number nobody is billed against
 *                           the resource that actually runs out (§9, this task's own title).
 *   7. `insufficient-cost-data` / `inconclusive-interval` — the arms' own cost percentiles do not
 *                           support a defensible effect-size interval (see {@link buildInterval}).
 *
 * ONLY once every gate above clears does a cell produce a {@link MountRecommendation} — every
 * recommendation carries the cell, both arms compared, each arm's own `n`, an effect size, an
 * interval, and the {@link RoutingObjectiveKind} that ultimately governed it (this task's own
 * acceptance).
 *
 * OBSERVATIONAL EVIDENCE, NAMED AS SUCH. MASTER-PLAN's own status paragraph records that the
 * golden-task replay suite "has no `HarnessRunner` wired" (the Self-Harness leg reports no run
 * recorded BY CONSTRUCTION). Until that ships, every recommendation's evidence is ledger
 * observation only, not a golden-suite proof — {@link OBSERVATIONAL_EVIDENCE_NOTICE} says so
 * explicitly in every emitted proposal, so a proposal never implies a golden run backed it when
 * none did.
 */

/** The `scripts/mount-headroom-sweep.mjs` arm shape this module reads (a structural subset —
 *  this module never imports the `.mjs` script itself, which sits outside tsconfig's `include`;
 *  the caller reads the sweep and hands its `cells` in, the same "dynamic import at the call
 *  site" discipline `test/a-mount-comparison-across-unmatched-populations-is-not-a-measurement
 *  .test.ts` already established for consuming that script from typed code). */
export interface MountHeadroomArm {
  cellKey: string;
  armKey: string;
  provider: string;
  servedModel: string;
  effort: string;
  n: number;
  outcomes: { passing: number; blockedCi: number; redispatched: number };
  costP50: number | null;
  costP90: number | null;
  costMax: number | null;
  costPerCompletedTaskUsd: number | null;
  /** This arm's OWN window-share evidence (W1-T2577) — see routing-objective.ts. Optional and
   *  structural, same discipline as every other field here. */
  windowShare?: ArmWindowShare;
  /** Material coverage behind `windowShare`; absent on older/hand-built callers. */
  windowEvidence?: {
    eligibleCalls: number;
    measuredCalls: number;
    unreadableCalls: number;
    reasons: string[];
    newestMeasurementTs?: string;
  };
}

/** The `scripts/mount-headroom-sweep.mjs` comparison shape — see {@link MountHeadroomArm}'s own
 *  doc for why this is a structural subset rather than an import. */
export interface MountHeadroomComparison {
  cellKey: string;
  armKeyA: string;
  armKeyB: string;
  nA: number;
  nB: number;
  cheaperByCostP50: string | null;
  cheaperByCostPerCompletedTask: string | null;
  advantageHoldsUnderRedispatch: boolean | null;
  note: string;
}

/** The `scripts/mount-headroom-sweep.mjs` cell shape — see {@link MountHeadroomArm}'s own doc. */
export interface MountHeadroomCell {
  cellKey: string;
  type: string;
  risk: string;
  taskClass: string;
  arms: MountHeadroomArm[];
  comparisons: MountHeadroomComparison[];
}

/** The declared minimum sample floor, per arm, below which this module refuses rather than
 *  recommends (this task's own rationale example: "n=4 against a floor of 30"). Overridable via
 *  {@link RecommendMountsOptions.minSampleN} — never smaller than a caller explicitly asks for,
 *  but this is the value every production caller rides. */
export const DEFAULT_MIN_SAMPLE_N = 30;

/** Printed verbatim inside every emitted recommendation (never a refusal — a refusal asserts
 *  nothing that would need this caveat). See this module's own header, "OBSERVATIONAL EVIDENCE". */
export const OBSERVATIONAL_EVIDENCE_NOTICE =
  "Evidence is OBSERVATIONAL ONLY — no golden-suite run backs this recommendation (the golden-task " +
  "replay suite has no HarnessRunner wired yet, MASTER-PLAN). This is a measurement, not a proof; " +
  "ratify only after human review against the golden suite this table is otherwise gated behind, " +
  "never on this note alone.";

/** One arm as it appears inside an emitted recommendation — the fields a human needs to judge it,
 *  never the whole {@link MountHeadroomArm} (turn percentiles are noise for a routing decision). */
export interface RecommendedArmSummary {
  armKey: string;
  provider: string;
  servedModel: string;
  effort: string;
  n: number;
  passing: number;
  costPerCompletedTaskUsd: number;
}

/** A cell cleared every gate: a real, evidence-backed proposal to route this cell to the cheaper
 *  arm — never applied, only proposed (see this module's own header). */
export interface MountRecommendation {
  kind: "recommendation";
  cellKey: string;
  type: string;
  risk: string;
  taskClass: string;
  /** The arm this recommendation proposes routing the cell to. */
  recommendedArm: RecommendedArmSummary;
  /** The arm currently observed as costlier for this same cell. */
  currentArm: RecommendedArmSummary;
  /** `currentArm.costPerCompletedTaskUsd - recommendedArm.costPerCompletedTaskUsd`, >= interval.lowUsd. */
  effectSizeUsd: number;
  /** A defensible (not fabricated) range on the effect size, derived from each arm's OWN p50/p90
   *  — see {@link buildInterval}'s own doc for why this, not a bootstrap CI, is what the sweep's
   *  aggregate (percentiles only, no retained per-run values) supports. Always `lowUsd > 0` — an
   *  interval that reaches zero or below is refused (`inconclusive-interval`), never recommended. */
   interval: { lowUsd: number; highUsd: number };
  /** The REAL objective that governed this recommendation (W1-T2577, routing-objective.ts) —
   *  `"window-share"` on a subscription install whose windows were readable for BOTH arms
   *  compared, `"notional-dollar"` when `billing_mode == "api"` (the dollars are real there) or
   *  when a subscription's window could not be read (a LOUD fallback, never silent — see
   *  {@link routingObjectiveFor}). `cheaperValue`/`costlierValue` are in `unit`, never dollars
   *  when `kind` is `"window-share"`. */
  objective: {
    kind: RoutingObjectiveKind;
    unit: string;
    cheaperValue: number;
    costlierValue: number;
    /** Present only when a subscription comparison could not use complete window evidence. */
    fallbackReasons?: string[];
  };
  note: string;
}

/** Every reason {@link recommendMounts} refuses a cell/comparison — see this module's own header
 *  for the order they are checked in and what each one means. */
export type MountRefusalReason =
  | "unmatched-arms"
  | "insufficient-sample"
  | "no-stable-advantage"
  | "quality-regression"
  | "tier-invariant"
  | "objective-disagreement"
  | "insufficient-cost-data"
  | "inconclusive-interval";

export interface MountRefusal {
  kind: "refusal";
  cellKey: string;
  type: string;
  risk: string;
  taskClass: string;
  reason: MountRefusalReason;
  /** Names WHAT is missing/violated — never a bare reason code (this task's own acceptance: "a
   *  REFUSAL naming what is missing" / "the violation named"). */
  detail: string;
}

export type MountRecommendationOutcome = MountRecommendation | MountRefusal;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The Tier Invariant (G-17), re-stated read-only against a SINGLE proposed model (never the
 * whole-table pass `enforceTierInvariant` in `lib/mounts.ts` runs at load — that function is
 * private, and `mounts.ts` is outside this task's file scope, so a proposal-time check needs its
 * own small copy of the SAME two conditions, deliberately kept minimal):
 *
 *     candidate.tier  <  architect.tier   — STRICT model-tier dominance, and
 *     candidate.tier  <  judge.tier       — the Layer-2 flight judge, same shape.
 *
 * A `servedModel` absent from `mounts.tiers` (a second-provider model name, an "unreported"/
 * "unknown" arm) CANNOT be checked against the invariant at all — this refuses rather than
 * assumes safe, same "refuse more often than recommend" posture as every other gate here.
 */
export function tierInvariantViolation(mounts: Mounts, candidateModel: string): string | undefined {
  const candidateTier = mounts.tiers[candidateModel];
  if (candidateTier === undefined) {
    return (
      `served_model '${candidateModel}' does not resolve in mounts.yaml's 'tiers' table, so the ` +
      `Tier Invariant (G-17) cannot be verified for it — refusing rather than assuming it is safe.`
    );
  }
  const architectTier = mounts.tiers[mounts.architect.model];
  if (candidateTier >= architectTier) {
    return (
      `proposed model '${candidateModel}' (tier ${candidateTier}) would not sit strictly below the ` +
      `Architect '${mounts.architect.model}' (tier ${architectTier}) — Tier Invariant (G-17) violation.`
    );
  }
  const judgeTier = mounts.tiers[mounts.judge.model];
  if (candidateTier >= judgeTier) {
    return (
      `proposed model '${candidateModel}' (tier ${candidateTier}) would not sit strictly below the ` +
      `flight judge '${mounts.judge.model}' (tier ${judgeTier}) — Tier Invariant (G-17) violation.`
    );
  }
  return undefined;
}

/**
 * A defensible (lowUsd, highUsd) range on `costlier.costPerCompletedTaskUsd -
 * cheaper.costPerCompletedTaskUsd`, built ONLY from each arm's own p50/p90 — never a bootstrap or
 * parametric CI, because the sweep's aggregate carries no retained per-run cost values to
 * resample from (percentiles only, by this repo's own "never a mean" discipline, see
 * `scripts/mount-headroom-sweep.mjs`'s header). The WORST case for the recommendation
 * (`lowUsd`) pairs the costlier arm's OWN cheapest quartile (p50) against the cheaper arm's OWN
 * most expensive observed band (p90); the BEST case (`highUsd`) is the mirror. `undefined` when
 * either arm lacks a p50/p90 to build the range from (too little settled cost data).
 */
export function buildInterval(
  cheaper: Pick<MountHeadroomArm, "costP50" | "costP90">,
  costlier: Pick<MountHeadroomArm, "costP50" | "costP90">,
): { lowUsd: number; highUsd: number } | undefined {
  if (cheaper.costP50 === null || cheaper.costP90 === null || costlier.costP50 === null || costlier.costP90 === null) {
    return undefined;
  }
  return {
    lowUsd: round2(costlier.costP50 - cheaper.costP90),
    highUsd: round2(costlier.costP90 - cheaper.costP50),
  };
}

function armSummary(arm: MountHeadroomArm, costPerCompletedTaskUsd: number): RecommendedArmSummary {
  return {
    armKey: arm.armKey,
    provider: arm.provider,
    servedModel: arm.servedModel,
    effort: arm.effort,
    n: arm.n,
    passing: arm.outcomes.passing,
    costPerCompletedTaskUsd,
  };
}

function refuse(cell: MountHeadroomCell, reason: MountRefusalReason, detail: string): MountRefusal {
  return { kind: "refusal", cellKey: cell.cellKey, type: cell.type, risk: cell.risk, taskClass: cell.taskClass, reason, detail };
}

function evaluateComparison(
  cell: MountHeadroomCell,
  cmp: MountHeadroomComparison,
  arms: Map<string, MountHeadroomArm>,
  mounts: Mounts,
  minSampleN: number,
  armPassRateEvidence: PoolableEvidence[],
  billingMode: BillingMode,
  warn: ((message: string) => void) | undefined,
): MountRecommendationOutcome {
  const armA = arms.get(cmp.armKeyA);
  const armB = arms.get(cmp.armKeyB);
  if (!armA || !armB) {
    // Structurally unreachable for a comparison built off this SAME cell's own arm list
    // (computeArmSweep only ever builds a comparison from arms it just grouped) — guarded anyway
    // so a hand-built fixture that decouples `comparisons` from `arms` fails loud, not silent.
    return refuse(cell, "unmatched-arms", `comparison ${cmp.armKeyA} vs ${cmp.armKeyB} in cell ${cell.cellKey} names an arm not present in this cell's own arm list.`);
  }

  const minN = Math.min(armA.n, armB.n);
  if (minN < minSampleN) {
    return refuse(
      cell,
      "insufficient-sample",
      `${armA.armKey} (n=${armA.n}) vs ${armB.armKey} (n=${armB.n}) in cell ${cell.cellKey}: smallest arm has ` +
        `n=${minN}, below the declared floor of ${minSampleN} — no recommendation yet.`,
    );
  }

  if (cmp.advantageHoldsUnderRedispatch !== true || !cmp.cheaperByCostPerCompletedTask) {
    return refuse(
      cell,
      "no-stable-advantage",
      `${armA.armKey} vs ${armB.armKey} in cell ${cell.cellKey}: ${cmp.note}`,
    );
  }

  const cheaperKey = cmp.cheaperByCostPerCompletedTask;
  const cheaperArm = armA.armKey === cheaperKey ? armA : armB;
  const costlierArm = armA.armKey === cheaperKey ? armB : armA;

  // OUTCOME BEFORE COST (scripts/mount-headroom-sweep.mjs's own rule, restated for a
  // recommendation): a cheaper arm that also fails more often is never recommended.
  //
  // W1-T2576: this cell's OWN slice of an arm's history can be thin even when that SAME arm
  // (same provider/servedModel/effort) has plenty of runs in the OTHER cells this call was handed
  // — a rare cell type should not judge an arm purely on its own noisy few runs, any more than a
  // newly onboarded repo should start from zero (this task's own framing, one join key up: here
  // the pooled entity is the ARM across cells, not a repo across the fleet, because
  // MountHeadroomArm/-Cell carry no repo dimension of their own to pool by). pooledPriorFor
  // shrinks each arm's raw within-cell pass rate toward its own pooled-across-cells rate in
  // proportion to how much of ITS OWN evidence this cell holds — an arm with a full sample in this
  // cell is barely moved; an arm with almost none here rides mostly on its fleet-wide record
  // instead of this cell's few (possibly unlucky) runs. The raw counts still drive every OTHER
  // gate and the emitted `RecommendedArmSummary` (never overwritten) — only this comparison uses
  // the pooled estimate.
  const cheaperPassRate = pooledPriorFor(cheaperArm.armKey, armPassRateEvidence).estimate;
  const costlierPassRate = pooledPriorFor(costlierArm.armKey, armPassRateEvidence).estimate;
  if (cheaperPassRate < costlierPassRate) {
    return refuse(
      cell,
      "quality-regression",
      `${cheaperArm.armKey} is cheaper but its observed pass rate (${cheaperArm.outcomes.passing}/${cheaperArm.n}, ` +
        `pooled-across-cells estimate ${round2(cheaperPassRate)}) is lower than ${costlierArm.armKey}'s ` +
        `(${costlierArm.outcomes.passing}/${costlierArm.n}, pooled-across-cells estimate ${round2(costlierPassRate)}) ` +
        `in cell ${cell.cellKey} — outcome before cost, refusing.`,
    );
  }

  const violation = tierInvariantViolation(mounts, cheaperArm.servedModel);
  if (violation) {
    return refuse(cell, "tier-invariant", `${cheaperArm.armKey} in cell ${cell.cellKey}: ${violation}`);
  }

  if (cheaperArm.costPerCompletedTaskUsd === null || costlierArm.costPerCompletedTaskUsd === null) {
    return refuse(
      cell,
      "insufficient-cost-data",
      `${cheaperArm.armKey} vs ${costlierArm.armKey} in cell ${cell.cellKey}: one or both arms have no settled ` +
        `cost-per-completed-task figure to compare.`,
    );
  }

  // THE REAL OBJECTIVE (W1-T2577, routing-objective.ts): the sweep above judged "cheaper" purely
  // on notional dollars. Under billing_mode == "subscription" the resource that actually runs out
  // is the WINDOW, and with two providers there are two independent ones — so re-judge each arm
  // on its OWN provider's window share per completed task, when both arms' windows are readable.
  // An unreadable window falls back to the dollar objective LOUDLY (routingObjectiveFor's own
  // `warn`), never silently — this call site never swallows that.
  const cheaperObjective = routingObjectiveFor(
    { provider: cheaperArm.provider, costPerCompletedTaskUsd: cheaperArm.costPerCompletedTaskUsd, windowShare: cheaperArm.windowShare },
    billingMode,
    { warn },
  );
  const costlierObjective = routingObjectiveFor(
    { provider: costlierArm.provider, costPerCompletedTaskUsd: costlierArm.costPerCompletedTaskUsd, windowShare: costlierArm.windowShare },
    billingMode,
    { warn },
  );
  const bothWindow = cheaperObjective?.kind === "window-share" && costlierObjective?.kind === "window-share";
  if (bothWindow && cheaperObjective.value >= costlierObjective.value) {
    return refuse(
      cell,
      "objective-disagreement",
      `${cheaperArm.armKey} is cheaper in notional dollars ($${cheaperArm.costPerCompletedTaskUsd}/completed task) ` +
        `in cell ${cell.cellKey}, but consumes ${cheaperObjective.value}% of provider '${cheaperArm.provider}'s window ` +
        `per completed task versus ${costlierArm.armKey}'s ${costlierObjective.value}% of provider ` +
        `'${costlierArm.provider}'s window — the scarce resource on subscription is the window, not the notional ` +
        `dollar (§9); refusing rather than recommending against the resource that actually runs out.`,
    );
  }

  // A comparison has ONE unit. If either subscription arm lacks a complete provider-owned
  // window reading, compare both arms in notional dollars and name the fallback; never label one
  // arm's dollars as the other arm's percent. API billing always uses dollars outright.
  const fallbackReasons = billingMode === "subscription" && !bothWindow
    ? [cheaperObjective?.fallbackReason, costlierObjective?.fallbackReason]
        .filter((reason): reason is string => typeof reason === "string")
    : [];
  if (billingMode === "subscription" && !bothWindow && fallbackReasons.length < 2) {
    fallbackReasons.push("both compared arms need complete window-share evidence; mixed objective units are refused");
    warn?.(
      `${cheaperArm.armKey} vs ${costlierArm.armKey} in cell ${cell.cellKey}: both arms do not have comparable ` +
        `window-share evidence — using notional dollars for BOTH arms rather than mixing percent and USD.`,
    );
  }

  const interval = buildInterval(cheaperArm, costlierArm);
  if (!interval) {
    return refuse(
      cell,
      "insufficient-cost-data",
      `${cheaperArm.armKey} vs ${costlierArm.armKey} in cell ${cell.cellKey}: one or both arms are missing a ` +
        `p50/p90 cost distribution to build a defensible interval from.`,
    );
  }
  if (interval.lowUsd <= 0) {
    return refuse(
      cell,
      "inconclusive-interval",
      `${cheaperArm.armKey} vs ${costlierArm.armKey} in cell ${cell.cellKey}: the effect-size interval ` +
        `[$${interval.lowUsd}, $${interval.highUsd}] (from each arm's own p50/p90) reaches zero or a reversal — ` +
        `not distinguishable from noise at these percentiles, no recommendation yet.`,
    );
  }

  const effectSizeUsd = round2(costlierArm.costPerCompletedTaskUsd - cheaperArm.costPerCompletedTaskUsd);

  const objectiveKind: RoutingObjectiveKind = bothWindow ? "window-share" : "notional-dollar";
  const objectiveUnit = bothWindow ? "percent-per-completed-task" : "usd-per-completed-task";
  const objectiveCheaperValue = bothWindow ? cheaperObjective.value : cheaperArm.costPerCompletedTaskUsd;
  const objectiveCostlierValue = bothWindow ? costlierObjective.value : costlierArm.costPerCompletedTaskUsd;

  return {
    kind: "recommendation",
    cellKey: cell.cellKey,
    type: cell.type,
    risk: cell.risk,
    taskClass: cell.taskClass,
    recommendedArm: armSummary(cheaperArm, cheaperArm.costPerCompletedTaskUsd),
    currentArm: armSummary(costlierArm, costlierArm.costPerCompletedTaskUsd),
    effectSizeUsd,
    interval,
    objective: {
      kind: objectiveKind,
      unit: objectiveUnit,
      cheaperValue: objectiveCheaperValue,
      costlierValue: objectiveCostlierValue,
      ...(fallbackReasons.length ? { fallbackReasons } : {}),
    },
    note:
      `cell ${cell.cellKey} (type=${cell.type}, risk=${cell.risk}, class=${cell.taskClass}): ${cheaperArm.armKey} ` +
      `(n=${cheaperArm.n}) costs $${cheaperArm.costPerCompletedTaskUsd}/completed task vs ${costlierArm.armKey} ` +
      `(n=${costlierArm.n}) at $${costlierArm.costPerCompletedTaskUsd} — effect size $${effectSizeUsd} ` +
      `(interval [$${interval.lowUsd}, $${interval.highUsd}]), advantage holds under re-dispatch, pass rate ` +
      `does not regress, Tier Invariant clears, objective=${objectiveKind} (§9)` +
      `${fallbackReasons.length ? `; fallback=${fallbackReasons.join(" | ")}` : ""}. ${OBSERVATIONAL_EVIDENCE_NOTICE}`,
  };
}

export interface RecommendMountsOptions {
  /** Overrides {@link DEFAULT_MIN_SAMPLE_N}. */
  minSampleN?: number;
  /** How this install is billed (§9) — selects {@link routingObjectiveFor}'s objective. Defaults
   *  to `"subscription"`, matching `billingMode`'s own documented default (env.ts): absent the
   *  sanctioned `ANTHROPIC_API_KEY` valve, an install bills to subscription, and that is where the
   *  window — not the notional dollar — is the real constraint (this task's own title). */
  billingMode?: BillingMode;
  /** Called (never silently swallowed) whenever {@link routingObjectiveFor} falls back to the
   *  dollar objective on a subscription install because a window could not be read. Defaults to
   *  `routingObjectiveFor`'s own `console.warn`. */
  warn?: (message: string) => void;
}

/** Pools every arm's pass rate ACROSS every cell in this same call, keyed by `armKey` — the join
 *  key {@link evaluateComparison}'s quality-regression gate shrinks a single cell's own noisy
 *  sample toward (see that gate's own comment for why the entity pooled here is the arm, not a
 *  repo: these fixtures carry no repo dimension of their own). One entry's `n`/`value` is the SUM
 *  of that armKey's `n`/passing across every cell, so an arm appearing in many cells pools its
 *  whole cross-cell history, not just one cell's slice of it. */
function poolArmPassRates(cells: MountHeadroomCell[]): PoolableEvidence[] {
  const totals = new Map<string, { n: number; passing: number }>();
  for (const cell of cells) {
    for (const a of cell.arms) {
      const t = totals.get(a.armKey) ?? { n: 0, passing: 0 };
      t.n += a.n;
      t.passing += a.outcomes.passing;
      totals.set(a.armKey, t);
    }
  }
  return Array.from(totals.entries()).map(([id, t]) => ({ id, n: t.n, value: t.n > 0 ? t.passing / t.n : 0 }));
}

/**
 * Turn `scripts/mount-headroom-sweep.mjs`'s cells into a recommendation or refusal per pairwise
 * within-cell comparison — see this module's own header for the full gate order. PURE: no I/O, no
 * mount ever read from or written to disk here (the caller supplies the already-loaded `mounts`
 * table so the Tier Invariant check has something to check against), no `child_process`, no
 * network call. Mutates neither its inputs nor any routing table.
 */
export function recommendMounts(cells: MountHeadroomCell[], mounts: Mounts, opts: RecommendMountsOptions = {}): MountRecommendationOutcome[] {
  const minSampleN = opts.minSampleN ?? DEFAULT_MIN_SAMPLE_N;
  const billingMode = opts.billingMode ?? "subscription";
  const armPassRateEvidence = poolArmPassRates(cells);
  const out: MountRecommendationOutcome[] = [];
  for (const cell of cells) {
    if (cell.arms.length < 2) {
      out.push(
        refuse(
          cell,
          "unmatched-arms",
          `cell ${cell.cellKey} has only ${cell.arms.length} arm(s) — no matched (type, risk, class) comparison ` +
            `is possible; a mount recommendation needs at least two arms sharing this cell.`,
        ),
      );
      continue;
    }
    const arms = new Map(cell.arms.map((a) => [a.armKey, a] as const));
    for (const cmp of cell.comparisons) {
      out.push(evaluateComparison(cell, cmp, arms, mounts, minSampleN, armPassRateEvidence, billingMode, opts.warn));
    }
  }
  return out;
}

/** The shape `run-task.ts` hands to `updateProposalRegistry` — deliberately a subset of
 *  `lib/inbox.ts`'s `Proposal` (id/summary/evidenceAnchors), the SAME shape
 *  `lib/feedback-docket.ts`'s `DocketProposalCandidate` already uses and for the SAME reason: this
 *  module never imports `inbox.ts`'s types and stays a pure, standalone measurement-to-proposal
 *  seam. `evidenceAnchors` is always `[]` — a cost/outcome measurement over the ledger is not a
 *  git-grep-able fact (the same reasoning `board-review.ts`'s own findings apply to a PR number). */
export interface MountRecommendationProposalCandidate {
  id: string;
  summary: string;
  evidenceAnchors: [];
}

/**
 * Derived, never random (mirrors `understoodRequestProposalId`'s own "derived, never minted"
 * discipline, `lib/inbox.ts`): re-running {@link recommendMounts} against the SAME cell/arm pair
 * always names the SAME proposal id, so a second daemon poll before ratification never files a
 * duplicate (`updateProposalRegistry`'s own idempotent-by-id check relies on this).
 */
export function mountRecommendationProposalId(rec: MountRecommendation): string {
  return `mount-recommendation:${rec.cellKey}::${rec.recommendedArm.armKey}::over::${rec.currentArm.armKey}`;
}

/** Turn a cleared {@link MountRecommendation} into the proposal candidate `updateProposalRegistry`
 *  (via `lib/inbox.ts`'s `Proposal`) files — the ONLY thing that reaches the existing ratification
 *  path; this function itself performs no I/O and mutates no routing table. */
export function mountRecommendationProposalCandidate(rec: MountRecommendation): MountRecommendationProposalCandidate {
  return {
    id: mountRecommendationProposalId(rec),
    summary:
      `Mount recommendation for routes.${rec.type}.${rec.risk}.${rec.taskClass}: adopt ` +
      `${rec.recommendedArm.armKey} (n=${rec.recommendedArm.n}, ` +
      `$${rec.recommendedArm.costPerCompletedTaskUsd}/completed task) over ` +
      `${rec.currentArm.armKey} (n=${rec.currentArm.n}, $${rec.currentArm.costPerCompletedTaskUsd}/completed task).\n` +
      `Effect size: $${rec.effectSizeUsd}/completed task (interval [$${rec.interval.lowUsd}, ` +
      `$${rec.interval.highUsd}]).\n` +
      `Objective: ${rec.objective.kind} (${rec.objective.cheaperValue} vs ${rec.objective.costlierValue} ${rec.objective.unit}) — ` +
      `§9: the scarce resource on subscription is the window, not the notional dollar.\n` +
      `${rec.objective.fallbackReasons?.length ? `Fallback: ${rec.objective.fallbackReasons.join(" | ")}\n` : ""}` +
      `Tier Invariant (G-17) checked and clears for '${rec.recommendedArm.servedModel}'.\n` +
      `${OBSERVATIONAL_EVIDENCE_NOTICE}\n` +
      `This proposal changes nothing by itself — ratifying it (\`rmd approve\`) is what opens the ` +
      `mounts.yaml PR, gated behind the golden suite like every other routing change (§9).`,
    evidenceAnchors: [],
  };
}
