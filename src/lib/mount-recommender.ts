import type { Mount, Mounts } from "./mounts.js";
import type { BillingMode } from "./env.js";
import type { RoutingExperimentResult } from "./routing-experiment-result.js";
import type { RoutingExperiment } from "./routing-experiments.js";
import type { RoutingPolicyEstimate } from "./routing-policy-estimate.js";
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
 * OBSERVATIONAL EVIDENCE, NAMED AS SUCH — THE CAVEAT HELD, ITS REASON DID NOT. It used to read
 * "the replay suite has no `HarnessRunner` wired" (quoting MASTER-PLAN, which still carries that);
 * W1-T2689 shipped the runner and a production caller, so the clause was false in every proposal
 * carrying it while the conclusion stayed true — a shape that reddens nothing, hence the falsifier.
 * The caveat now rests on ground this module can assert about ITSELF: a replay result is not an
 * input to {@link recommendMounts}, so a recommendation is ledger observation, never a golden proof.
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
  "Evidence is OBSERVATIONAL ONLY — no golden-suite run backs this recommendation. The replay " +
  "suite has both a runner and a production caller (`rmd replay-goldens`), but a replay result is " +
  "not an input to recommendMounts and nothing on this path dispatches one, so what follows rests " +
  "on retained-ledger observation alone. This is a measurement, not a proof; ratify only after " +
  "human review against the golden suite this table is otherwise gated behind, never on this note " +
  "alone.";

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

// ── Randomised evidence (W1-T12143) ──────────────────────────────────────────────────────────

/**
 * Randomised evidence for the adopt-mount class (W1-T12143): the source beside the observational sweep above.
 *
 * Two producers report randomised evidence on which provider should serve a capability at an effort:
 * `routing.experiment.result` (W1-T12142, one row per experiment per UTC day, each task assigned its arm at
 * random) and `routing.policy.estimate` (W1-T14146, one row per capability/effort/class cell per day, weighted
 * by the headroom auction's logged draw probabilities). Each producer sets its own status and winner.
 *
 * Invariant: {@link randomisedMountRecommendations} reads the newest row of each experiment and cell and never
 * re-decides it. Only a row marked concluded with a winner proposes; running, underpowered and no-difference
 * propose nothing. A cell inside a concluded experiment's capability and effort uses the experiment's result.
 *
 * A candidate covers the auctioned routes rows (no `provider:`) whose model resolves to the capability and whose
 * effort matches (and, for a cell, whose class matches). A routes row's schema takes a `provider` (mounts.ts
 * `parseMount`), so the winner is written there. A pinned row runs one model ({@link RandomisedHost}); a winner
 * whose pin would not run its measured model, or whose loser the table no longer offers, is a finding naming the
 * setting that holds it, and a winner with no routes row is a finding naming `capabilities.provider_preference`.
 *
 * The recommender's Tier Invariant gate ({@link tierInvariantViolation}) runs on every row a candidate edits.
 * Falsifier: test/gardeners/a-concluded-experiment-proposes-its-change-to-the-mounts-table.test.ts.
 */
export const RANDOMISED_EXPERIMENT_STEP = "routing.experiment.result";
export const RANDOMISED_ESTIMATE_STEP = "routing.policy.estimate";
export type RandomisedStep = typeof RANDOMISED_EXPERIMENT_STEP | typeof RANDOMISED_ESTIMATE_STEP;
export type RandomisedProvider = "claude" | "codex";

/** One arm of one pipeline as its producer reported it: the label, its provider, its positive rate and its tasks. */
export interface RandomisedArm {
  label: string;
  provider: RandomisedProvider;
  rate: number;
  tasks: number;
}

/** One active pipeline's comparison, quoted from its producer: `difference` is the second arm minus the first,
 *  with that producer's own interval at its own confidence. For `review` the positive outcome is a FAILED review. */
export interface RandomisedPipeline {
  pipeline: string;
  first: RandomisedArm;
  second: RandomisedArm;
  difference: number;
  lower: number;
  upper: number;
  confidence: number;
}

/** What a concluded randomised row says, as {@link RandomisedMountRecommendation} carries it. */
export interface RandomisedEvidence {
  /** `randomised`: an experiment assigned each task its arm. `randomised-by-auction`: the auction's logged draws. */
  kind: "randomised" | "randomised-by-auction";
  step: RandomisedStep;
  /** The experiment id, or the estimate's cell key. */
  id: string;
  day: string;
  capability: string;
  effort: string;
  /** A cell's class; absent for an experiment, which covers every class at its capability and effort. */
  taskClass?: string;
  winner: { label: string; provider: RandomisedProvider };
  loser: { label: string; provider: RandomisedProvider };
  pipelines: RandomisedPipeline[];
  /** The smallest bound, over the pipelines, of the winner's advantage interval: above 0 whenever its producer
   *  declared the winner, so it is the candidate's shadow guard and never a second decision. */
  advantageLow: number;
  /** The fewest tasks either arm has in any pipeline. */
  minTasks: number;
}

export interface RandomisedRow {
  type: string;
  risk: string;
  taskClass: string;
}

/** A concluded randomised winner in the recommendation shape `mountCandidate` reads beside {@link MountRecommendation}:
 *  `cellKey` names the evidence (`experiment:<id>` or `estimate:<cell>`), `rows` the routes rows it covers. */
export interface RandomisedMountRecommendation {
  kind: "recommendation";
  cellKey: string;
  rows: RandomisedRow[];
  randomised: RandomisedEvidence;
  note: string;
}

/** Either source's recommendation, as the config gardener's adopt-mount class reads them. */
export type AdoptMountRecommendation = MountRecommendation | RandomisedMountRecommendation;

/** A winner the table cannot express, and the setting that can. */
export interface RandomisedFinding {
  step: RandomisedStep;
  id: string;
  day: string;
  setting: string;
  detail: string;
}

export type RandomisedRefusalReason =
  | "unknown-experiment"
  | "running"
  | "underpowered"
  | "no-difference"
  | "experiment-decides"
  | "tier-invariant"
  | "nothing-to-change";

export interface RandomisedRefusal {
  step: RandomisedStep;
  id: string;
  day: string;
  reason: RandomisedRefusalReason;
  detail: string;
}

export interface RandomisedOutcomes {
  recommendations: RandomisedMountRecommendation[];
  findings: RandomisedFinding[];
  refusals: RandomisedRefusal[];
}

type EvidenceRow = Record<string, unknown>;
const RANDOMISED_PIPELINES = ["build", "fix", "review"] as const;
const PIPELINE_RATE: Readonly<Record<string, string>> = { build: "merge rate", fix: "accepted-fix rate", review: "failed-review rate" };
const isEvidenceRecord = (value: unknown): value is EvidenceRow => value !== null && typeof value === "object" && !Array.isArray(value);
const evidenceText = (value: unknown): string => (typeof value === "string" ? value : "");
/** Code-unit order: locale-independent. */
const codeUnitOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** A table record read with a key from a ledger row: only the record's own entries, never its prototype's. */
const ownEntry = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

/** The newest row of `step` per `keyField`: the latest `day`, then the latest `ts`, then the greater serialisation.
 *  A total order, so the union's read order never decides which row wins and a superseded row never does. */
function newestEvidence(rows: readonly EvidenceRow[], step: RandomisedStep, keyField: string, payloadField: string): Map<string, { day: string; payload: EvidenceRow }> {
  const best = new Map<string, { day: string; ts: string; serial: string; payload: EvidenceRow }>();
  for (const row of rows) {
    const key = evidenceText(row[keyField]);
    const day = evidenceText(row.day);
    const payload = row[payloadField];
    if (row.step !== step || key === "" || day === "" || !isEvidenceRecord(payload)) continue;
    const candidate = { day, ts: evidenceText(row.ts), serial: JSON.stringify(row), payload };
    const held = best.get(key);
    const order = held === undefined ? 1
      : codeUnitOrder(candidate.day, held.day) || codeUnitOrder(candidate.ts, held.ts) || codeUnitOrder(candidate.serial, held.serial);
    if (order > 0) best.set(key, candidate);
  }
  return new Map([...best].sort(([a], [b]) => codeUnitOrder(a, b)).map(([key, { day, payload }]) => [key, { day, payload }]));
}

/** What a routes row's `provider:` pin runs on this host. The pin takes worker.ts's mount-affinity path, which skips
 *  model selection: a `provider: codex` row runs `workerProviders.codexModel`, and with none set its spawn refuses
 *  (worker-provider.ts `codexExecArgs`); a `provider: claude` row runs the first healthy `claude_candidates` entry. */
export interface RandomisedHost {
  codexModel: string | undefined;
}

const CODEX_PIN_SETTING = "workerProviders.codexModel";

/** The models the table offers `provider` at `capability`/`effort`, in order, and the setting that lists them. Which
 *  one serves depends on the account's own model list (a listed model the account cannot run is skipped). */
function offered(mounts: Mounts, provider: RandomisedProvider, capability: string, effort: string): { setting: string; models: readonly string[] } {
  return provider === "claude"
    ? { setting: `capabilities.claude_candidates.${capability}`, models: ownEntry(mounts.capabilities?.claudeCandidates, capability) ?? [] }
    : { setting: `capabilities.codex.${capability}.${effort}`, models: ownEntry(ownEntry(mounts.capabilities?.codex, capability), effort) ?? [] };
}

/** The model a routes row pinned to `provider` runs, and the setting that holds it ({@link RandomisedHost}). */
function pinnedModel(mounts: Mounts, host: RandomisedHost, provider: RandomisedProvider, capability: string, effort: string): { setting: string; model: string | undefined } {
  return provider === "claude" ? { setting: offered(mounts, "claude", capability, effort).setting, model: offered(mounts, "claude", capability, effort).models[0] }
    : { setting: CODEX_PIN_SETTING, model: host.codexModel };
}

/** The result's two arms mapped to their providers through the experiment's own `arms`, in the result's order
 *  (`differences` are its second arm minus its first); undefined unless one is Claude and the other Codex. */
function experimentArms(experiment: RoutingExperiment, result: Partial<RoutingExperimentResult>): [RandomisedEvidence["winner"], RandomisedEvidence["winner"]] | undefined {
  const providerOf = new Map(Object.entries(experiment.arms).map(([provider, label]) => [label, provider]));
  const arms = (Array.isArray(result.arms) ? result.arms : []).map((arm) => ({ label: evidenceText(arm?.arm), provider: providerOf.get(evidenceText(arm?.arm)) }));
  const [first, second] = arms;
  if (arms.length !== 2 || first?.provider === second?.provider || !arms.every((arm) => arm.provider === "claude" || arm.provider === "codex")) return undefined;
  return arms as [RandomisedEvidence["winner"], RandomisedEvidence["winner"]];
}

/** One concluded arm as {@link inexpressible} reads it: `measured` tests a model id against what the arm measured. */
interface MeasuredArm {
  label: string;
  provider: RandomisedProvider;
  measured: (model: string) => boolean;
  shape: string;
}

/** Why pinning the winner's provider cannot carry a concluded result, as the setting that holds the choice; undefined
 *  when it can. The pinned row must run the measured winner, and the table must still offer the measured loser, or
 *  the comparison is not one the table now makes. */
function inexpressible(mounts: Mounts, host: RandomisedHost, at: { id: string; capability: string; effort: string },
  winner: MeasuredArm, loser: MeasuredArm): { setting: string; detail: string } | undefined {
  const pinned = pinnedModel(mounts, host, winner.provider, at.capability, at.effort);
  if (pinned.model === undefined || !winner.measured(pinned.model)) {
    const refused = pinned.model === undefined && winner.provider === "codex" ? `, so its spawn refuses: this host sets no ${CODEX_PIN_SETTING}` : "";
    return { setting: pinned.setting, detail: `${at.id} concluded ${winner.label} on ${winner.provider} as ${winner.shape}, but a routes row ` +
      `pinned to ${winner.provider} runs ${pinned.model ?? "no model"}${refused}; ${pinned.setting} is the setting that holds the choice.` };
  }
  const listed = offered(mounts, loser.provider, at.capability, at.effort);
  if (listed.models.some(loser.measured)) return undefined;
  return { setting: listed.setting, detail: `${at.id} measured its ${loser.label} arm on ${loser.provider} as ${loser.shape}, and ${listed.setting} ` +
    `no longer offers it (${listed.models.join(", ") || "no model"}): the comparison is not one the table makes, and ${listed.setting} holds it.` };
}

function experimentPipelines(result: Partial<RoutingExperimentResult>, arms: readonly RandomisedEvidence["winner"][]): RandomisedPipeline[] {
  return RANDOMISED_PIPELINES.flatMap((pipeline) => {
    const interval = result.differences?.[pipeline]?.rate;
    const first = result.arms?.[0]?.pipelines?.[pipeline];
    const second = result.arms?.[1]?.pipelines?.[pipeline];
    if (!interval || typeof first?.rate !== "number" || typeof second?.rate !== "number") return [];
    return [{ pipeline, first: { ...arms[0]!, rate: first.rate, tasks: first.tasks }, second: { ...arms[1]!, rate: second.rate, tasks: second.tasks },
      difference: interval.difference, lower: interval.lower, upper: interval.upper, confidence: interval.confidence }];
  });
}

function estimatePipelines(estimate: Partial<RoutingPolicyEstimate>): RandomisedPipeline[] {
  return RANDOMISED_PIPELINES.flatMap((pipeline) => {
    const entry = estimate.pipelines?.[pipeline];
    const claude = entry?.policies?.["always-claude"];
    const codex = entry?.policies?.["always-codex"];
    const d = entry?.difference;
    if (!d || typeof claude?.estimate !== "number" || typeof codex?.estimate !== "number") return [];
    return [{ pipeline, first: { label: "always-claude", provider: "claude" as const, rate: claude.estimate, tasks: claude.tasks },
      second: { label: "always-codex", provider: "codex" as const, rate: codex.estimate, tasks: codex.tasks },
      difference: d.estimate, lower: d.lower, upper: d.upper, confidence: d.confidence }];
  });
}

/** The lower bound of `winner`'s advantage in one pipeline: the producer's interval on second minus first, turned
 *  so the winner's side is positive (for `review` a lower failed-review rate is the better one). */
function advantageBound(p: RandomisedPipeline, winner: RandomisedProvider): number {
  const favoursSecond = (p.second.provider === winner) === (p.pipeline !== "review");
  return favoursSecond ? p.lower : -p.upper;
}

const percent = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

/** The evidence quoted for a reviewer: per pipeline, both rates with their tasks, the difference and its interval. */
export function randomisedEvidenceNote(e: RandomisedEvidence): string {
  const source = e.kind === "randomised"
    ? `Randomised experiment ${e.id} (${e.step}, ${e.day})`
    : `Randomised by the headroom auction: the inverse-propensity estimate of cell ${e.id} (${e.step}, ${e.day})`;
  const pipelines = e.pipelines.map((p) =>
    `${p.pipeline} ${PIPELINE_RATE[p.pipeline] ?? "rate"}: ${p.first.label} ${percent(p.first.rate)} of ${p.first.tasks} tasks, ` +
    `${p.second.label} ${percent(p.second.rate)} of ${p.second.tasks} tasks; ${p.second.label} minus ${p.first.label} ` +
    `${p.difference.toFixed(3)}, ${Math.round(p.confidence * 1000) / 10}% interval ${p.lower.toFixed(3)} to ${p.upper.toFixed(3)}`);
  return `${source} concluded ${e.winner.label} (${e.winner.provider}) over ${e.loser.label} (${e.loser.provider}) at ` +
    `${e.capability}/${e.effort}${e.taskClass === undefined ? "" : `/${e.taskClass}`}. ${pipelines.join(". ")}.`;
}

/** The routes rows at `capability`/`effort` (and `taskClass`, when given), in table order. */
function routeRowsAt(mounts: Mounts, capability: string, effort: string, taskClass: string | undefined): Array<RandomisedRow & { mount: Mount }> {
  const rows: Array<RandomisedRow & { mount: Mount }> = [];
  for (const [type, byRisk] of Object.entries(mounts.routes)) {
    for (const [risk, byClass] of Object.entries(byRisk)) {
      for (const [cls, mount] of Object.entries(byClass)) {
        if (mounts.capabilities?.claude[mount.model] !== capability || mount.effort !== effort || (taskClass !== undefined && cls !== taskClass)) continue;
        rows.push({ type, risk, taskClass: cls, mount });
      }
    }
  }
  return rows;
}

/** The candidate for one concluded winner over the auctioned rows it covers, or the finding or refusal instead. */
function proposeRandomised(out: RandomisedOutcomes, mounts: Mounts, e: Omit<RandomisedEvidence, "advantageLow" | "minTasks">): void {
  const evidence: RandomisedEvidence = {
    ...e,
    advantageLow: Math.min(...e.pipelines.map((p) => advantageBound(p, e.winner.provider))),
    minTasks: Math.min(...e.pipelines.flatMap((p) => [p.first.tasks, p.second.tasks])),
  };
  const where = `${e.capability}/${e.effort}${e.taskClass === undefined ? "" : `/${e.taskClass}`}`;
  const at = routeRowsAt(mounts, e.capability, e.effort, e.taskClass);
  if (at.length === 0) {
    const setting = `capabilities.provider_preference.${e.capability}`;
    out.findings.push({ step: e.step, id: e.id, day: e.day, setting,
      detail: `${e.id} concluded ${e.winner.label} (${e.winner.provider}) at ${where}, and no routes row rides ${where} to carry it; ` +
        `${setting} is the setting that holds the provider choice, for every effort of ${e.capability}.` });
    return;
  }
  const rows: RandomisedRow[] = [];
  for (const row of at) {
    if (row.mount.provider !== undefined) continue;
    const violation = tierInvariantViolation(mounts, row.mount.model);
    if (violation === undefined) rows.push({ type: row.type, risk: row.risk, taskClass: row.taskClass });
    else out.refusals.push({ step: e.step, id: e.id, day: e.day, reason: "tier-invariant", detail: `routes.${row.type}.${row.risk}.${row.taskClass}: ${violation}` });
  }
  if (rows.length === 0) {
    out.refusals.push({ step: e.step, id: e.id, day: e.day, reason: "nothing-to-change",
      detail: `every routes row at ${where} already names a provider or is refused by the Tier Invariant` });
    return;
  }
  out.recommendations.push({ kind: "recommendation", cellKey: `${e.kind === "randomised" ? "experiment" : "estimate"}:${e.id}`, rows, randomised: evidence,
    note: randomisedEvidenceNote(evidence) });
}

/**
 * The newest `routing.experiment.result` row of each experiment and the newest `routing.policy.estimate` row of
 * each cell, as candidates, findings and refusals (see this section's header). `experiments` maps a result's arm
 * labels to providers; a result naming no listed experiment is refused. `host` says what a pinned row runs there.
 * PURE, like {@link recommendMounts}.
 */
export function randomisedMountRecommendations(rows: Iterable<Record<string, unknown>>, mounts: Mounts, experiments: readonly RoutingExperiment[],
  host: RandomisedHost): RandomisedOutcomes {
  const all = [...rows];
  const out: RandomisedOutcomes = { recommendations: [], findings: [], refusals: [] };
  const decided = new Set<string>();
  for (const [id, { day, payload }] of newestEvidence(all, RANDOMISED_EXPERIMENT_STEP, "experiment_id", "result")) {
    const result = payload as Partial<RoutingExperimentResult>;
    const refuse = (reason: RandomisedRefusalReason, detail: string) => out.refusals.push({ step: RANDOMISED_EXPERIMENT_STEP, id, day, reason, detail });
    const experiment = experiments.find((candidate) => candidate.id === id);
    const arms = experiment === undefined ? undefined : experimentArms(experiment, result);
    if (experiment === undefined || arms === undefined) {
      refuse("unknown-experiment", `no listed experiment named ${id} maps its two arms to claude and codex`);
      continue;
    }
    if (result.status !== "concluded") {
      refuse(result.status === "underpowered" ? "underpowered" : "running", `${id} is ${evidenceText(result.status) || "unreadable"} on ${day}`);
      continue;
    }
    // Concluded, it decides its cell: winner or not, and whether or not the table can carry it.
    decided.add(`${experiment.capability}/${experiment.effort}`);
    const pipelines = experimentPipelines(result, arms);
    const winner = arms.find((arm) => arm.label === result.winner);
    const loser = arms.find((arm) => arm.label !== result.winner)!;
    if (result.conclusion !== "winner" || winner === undefined || pipelines.length === 0) {
      refuse("no-difference", `${id} concluded with no difference on ${day}`);
      continue;
    }
    const measured = (arm: RandomisedEvidence["winner"]): MeasuredArm => {
      const treatment = arm.provider === "claude" ? experiment.claudeModel : experiment.codexModel;
      return { ...arm, measured: (model) => treatment.test(model), shape: `/${treatment.source}/` };
    };
    const blocked = inexpressible(mounts, host, { id, capability: experiment.capability, effort: experiment.effort }, measured(winner), measured(loser));
    if (blocked !== undefined) {
      out.findings.push({ step: RANDOMISED_EXPERIMENT_STEP, id, day, ...blocked });
      continue;
    }
    proposeRandomised(out, mounts, { kind: "randomised", step: RANDOMISED_EXPERIMENT_STEP, id, day, capability: experiment.capability,
      effort: experiment.effort, winner, loser, pipelines });
  }
  for (const [id, { day, payload }] of newestEvidence(all, RANDOMISED_ESTIMATE_STEP, "cell_key", "estimate")) {
    const estimate = payload as Partial<RoutingPolicyEstimate>;
    const refuse = (reason: RandomisedRefusalReason, detail: string) => out.refusals.push({ step: RANDOMISED_ESTIMATE_STEP, id, day, reason, detail });
    const cell = isEvidenceRecord(estimate.cell) && [estimate.cell.capability, estimate.cell.effort, estimate.cell.taskClass].every((part) => typeof part === "string")
      ? estimate.cell : undefined;
    const winner = estimate.winner;
    const pipelines = estimatePipelines(estimate);
    if (estimate.status !== "concluded" || estimate.concluded !== true || (winner !== "claude" && winner !== "codex") || cell === undefined || pipelines.length === 0) {
      refuse(estimate.status === "underpowered" ? "underpowered" : estimate.status === "concluded" ? "no-difference" : "running",
        `${id} is ${evidenceText(estimate.status) || "unreadable"} on ${day}`);
      continue;
    }
    if (decided.has(`${cell.capability}/${cell.effort}`)) {
      refuse("experiment-decides", `a concluded experiment at ${cell.capability}/${cell.effort} decides ${id}`);
      continue;
    }
    const loser = winner === "claude" ? "codex" : "claude";
    // The auction served each provider from the table's own list at this cell: that list is what each policy measured.
    const policy = (provider: RandomisedProvider): MeasuredArm => {
      const listed = offered(mounts, provider, cell.capability, cell.effort);
      return { label: `always-${provider}`, provider, measured: (model) => listed.models.includes(model), shape: `a model ${listed.setting} offers` };
    };
    const blocked = inexpressible(mounts, host, { id, capability: cell.capability, effort: cell.effort }, policy(winner), policy(loser));
    if (blocked !== undefined) {
      out.findings.push({ step: RANDOMISED_ESTIMATE_STEP, id, day, ...blocked });
      continue;
    }
    proposeRandomised(out, mounts, { kind: "randomised-by-auction", step: RANDOMISED_ESTIMATE_STEP, id, day, capability: cell.capability,
      effort: cell.effort, taskClass: cell.taskClass, winner: { label: `always-${winner}`, provider: winner },
      loser: { label: `always-${loser}`, provider: loser }, pipelines });
  }
  return out;
}
