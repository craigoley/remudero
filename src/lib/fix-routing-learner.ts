import { readLedgerUnionRecords } from "./ledger-union.js";
import { betaDraw, DISPATCH_VALUE_PRIOR_WEIGHT } from "./dispatch-value.js";

/**
 * W1-T5535: THE FIX LANE LEARNS WHICH ARM'S ROUNDS THE HARNESS ACCEPTS.
 *
 * Measured over 2026-09-26..10-03, the fix lane's harness refused 62% of codex/gpt-6.1-sol rounds and
 * 22% of claude-sonnet-5 ones, while the auction weighed only subscription headroom. This module folds
 * `fix.done` rows into per-arm evidence and turns it into a seeded Thompson draw per arm. It is PURE:
 * rows in, numbers out. The auction mixes those draws with its own headroom probabilities
 * (`selectWorkerProvider`'s `mixing` input); only `runFixRung` ever supplies them, so every other lane
 * routes exactly as before.
 */
export const FIX_ROUTING_LEARNER = "fix-acceptance/v1";

/** Rounds fade by this half-life, so there is no window edge and an old failure stops suppressing an arm. */
export const FIX_ROUTING_HALF_LIFE_MS = 72 * 3_600_000;

/** How far back the ledger read reaches: about five half-lives, past which a round weighs under 4%. */
export const FIX_ROUTING_READ_WINDOW_MS = 14 * 24 * 3_600_000;

/** Pseudo-rounds of fix-lane-wide evidence each arm starts from (the dispatch-value.ts pooled-prior pattern). */
export const FIX_ROUTING_PRIOR_WEIGHT = DISPATCH_VALUE_PRIOR_WEIGHT;

/** What one fix round is worth: refused by the harness, pushed but CI red, or pushed and CI not red. */
export const FIX_ROUND_REWARD = { refused: 0, ciNotGreen: 0.5, accepted: 1 } as const;

const PRIOR_MEAN_EPSILON = 1e-3;

type Row = Record<string, unknown>;

export interface FixArmStats {
  provider: string;
  model: string;
  rounds: number;
  /** Decay-weighted reward earned. */
  acceptedWeight: number;
  /** Decay-weighted reward not earned. */
  refusedWeight: number;
  /** Total decay weight: the arm's effective sample size. */
  nEff: number;
}

export interface FixArmEvidence {
  arms: FixArmStats[];
  /** `fix.done` rows with no provider or no selected_model: counted, never pooled into an arm. */
  unattributedExcluded: number;
  /** Pooled fix-lane acceptance mean, the prior's centre. */
  priorMean: number;
  priorWeight: number;
  halfLifeMs: number;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** Fold the ledger's `fix.done` and `fix.ci_not_green` rows into per-(provider, selected_model) evidence. */
export function fixArmEvidence(rows: readonly Row[], nowMs: number): FixArmEvidence {
  const redShas = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.step !== "fix.ci_not_green") continue;
    const task = text(row.task_id);
    const sha = text(row.sha);
    if (!task || !sha) continue;
    const set = redShas.get(task) ?? new Set<string>();
    set.add(sha);
    redShas.set(task, set);
  }
  const byArm = new Map<string, FixArmStats>();
  let unattributedExcluded = 0;
  for (const row of rows) {
    if (row.step !== "fix.done") continue;
    const provider = text(row.provider);
    const model = text(row.selected_model);
    if (!provider || !model) {
      unattributedExcluded += 1;
      continue;
    }
    const ts = typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
    if (Number.isNaN(ts)) continue;
    const pushed = text(row.pushed_head_sha);
    const task = text(row.task_id);
    const reward = row.subtype === "commit_refused"
      ? FIX_ROUND_REWARD.refused
      : pushed && task && redShas.get(task)?.has(pushed)
        ? FIX_ROUND_REWARD.ciNotGreen
        : FIX_ROUND_REWARD.accepted;
    const weight = 0.5 ** (Math.max(0, nowMs - ts) / FIX_ROUTING_HALF_LIFE_MS);
    const key = `${provider}\u0000${model}`;
    const arm = byArm.get(key) ?? { provider, model, rounds: 0, acceptedWeight: 0, refusedWeight: 0, nEff: 0 };
    arm.rounds += 1;
    arm.acceptedWeight += weight * reward;
    arm.refusedWeight += weight * (1 - reward);
    arm.nEff += weight;
    byArm.set(key, arm);
  }
  const arms = [...byArm.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  const accepted = arms.reduce((sum, arm) => sum + arm.acceptedWeight, 0);
  const total = arms.reduce((sum, arm) => sum + arm.nEff, 0);
  const mean = total > 0 ? accepted / total : 0.5;
  return {
    arms,
    unattributedExcluded,
    priorMean: Math.min(Math.max(mean, PRIOR_MEAN_EPSILON), 1 - PRIOR_MEAN_EPSILON),
    priorWeight: FIX_ROUTING_PRIOR_WEIGHT,
    halfLifeMs: FIX_ROUTING_HALF_LIFE_MS,
  };
}

export interface FixRoutingCandidate {
  provider: string;
  /** The concrete model the provider would serve; absent when unknown (the arm then rests on the prior alone). */
  model?: string;
}

export interface FixWeighedArm {
  provider: string;
  model: string;
  rounds: number;
  acceptedWeight: number;
  refusedWeight: number;
  nEff: number;
  alpha: number;
  beta: number;
  /** `null`: evidence names this arm but no candidate would serve it at this decision, so it was not drawn. */
  draw: number | null;
}

export interface FixRoutingWeights {
  arms: FixWeighedArm[];
  /** Each provider's multiplier: the draw of the arm that provider would serve (its highest-drawing arm). */
  multipliers: Record<string, number>;
  /** The model each provider would serve under those draws. */
  preferredModel: Record<string, string>;
  /** Share of probability left to the pure-headroom auction: k / (k + n_eff_min). */
  epsilon: number;
  nEffMin: number;
  unattributedExcluded: number;
  halfLifeMs: number;
}

/**
 * One seeded Thompson draw per candidate arm, `Beta(alpha0 + accepted, beta0 + refused)` over a pooled prior.
 * The exploration share has no fixed floor: it is `k / (k + n_eff_min)` over the arms providers would serve,
 * so it falls as evidence accumulates, and stays positive because decay keeps `n_eff` bounded.
 */
export function fixRoutingWeights(
  evidence: FixArmEvidence,
  candidates: readonly FixRoutingCandidate[],
  seed: string,
): FixRoutingWeights {
  const seen = new Set<string>();
  const arms: FixWeighedArm[] = [];
  for (const candidate of candidates) {
    const model = candidate.model ?? "";
    const key = `${candidate.provider}\u0000${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const stats = evidence.arms.find((arm) => arm.provider === candidate.provider && arm.model === model);
    const acceptedWeight = stats?.acceptedWeight ?? 0;
    const refusedWeight = stats?.refusedWeight ?? 0;
    const alpha = evidence.priorWeight * evidence.priorMean + acceptedWeight;
    const beta = evidence.priorWeight * (1 - evidence.priorMean) + refusedWeight;
    arms.push({
      provider: candidate.provider,
      model,
      rounds: stats?.rounds ?? 0,
      acceptedWeight,
      refusedWeight,
      nEff: stats?.nEff ?? 0,
      alpha,
      beta,
      draw: betaDraw(alpha, beta, seed, key),
    });
  }
  const multipliers: Record<string, number> = {};
  const preferredModel: Record<string, string> = {};
  const served = new Map<string, FixWeighedArm & { draw: number }>();
  for (const arm of arms) {
    if (arm.draw === null) continue;
    const best = served.get(arm.provider);
    if (!best || arm.draw > best.draw) served.set(arm.provider, { ...arm, draw: arm.draw });
  }
  for (const [provider, arm] of served) {
    multipliers[provider] = arm.draw;
    preferredModel[provider] = arm.model;
  }
  // The row names EVERY arm the evidence holds for a provider in play, drawn or not, so no acceptance rate is hidden.
  for (const stats of evidence.arms) {
    if (seen.has(`${stats.provider}\u0000${stats.model}`) || !served.has(stats.provider)) continue;
    arms.push({
      provider: stats.provider,
      model: stats.model,
      rounds: stats.rounds,
      acceptedWeight: stats.acceptedWeight,
      refusedWeight: stats.refusedWeight,
      nEff: stats.nEff,
      alpha: evidence.priorWeight * evidence.priorMean + stats.acceptedWeight,
      beta: evidence.priorWeight * (1 - evidence.priorMean) + stats.refusedWeight,
      draw: null,
    });
  }
  const nEffMin = served.size > 0 ? Math.min(...[...served.values()].map((arm) => arm.nEff)) : 0;
  return {
    arms,
    multipliers,
    preferredModel,
    epsilon: evidence.priorWeight / (evidence.priorWeight + nEffMin),
    nEffMin,
    unattributedExcluded: evidence.unattributedExcluded,
    halfLifeMs: evidence.halfLifeMs,
  };
}

/** One provider's probability at the decision: the headroom auction's, the learned one's, and the mix. */
export interface FixProviderProbability {
  provider: string;
  headroom: number;
  learned: number;
  final: number;
}

/** The `fix.routing_decision` ledger fields. `applied: false` names why the learner stood aside. */
export function fixRoutingDecisionFields(input: {
  weights: FixRoutingWeights;
  probabilities: readonly FixProviderProbability[];
  selected: { provider: string; model?: string };
}): Record<string, unknown> {
  const { weights, probabilities, selected } = input;
  return {
    learner: FIX_ROUTING_LEARNER,
    applied: true,
    epsilon: weights.epsilon,
    n_eff_min: weights.nEffMin,
    unattributed_excluded: weights.unattributedExcluded,
    half_life_ms: weights.halfLifeMs,
    arms: weights.arms.map((arm) => {
      const serves = arm.draw !== null && weights.preferredModel[arm.provider] === arm.model;
      const p = serves ? probabilities.find((entry) => entry.provider === arm.provider) : undefined;
      return {
        provider: arm.provider,
        model: arm.model,
        rounds: arm.rounds,
        accepted_weight: arm.acceptedWeight,
        refused_weight: arm.refusedWeight,
        n_eff: arm.nEff,
        alpha: arm.alpha,
        beta: arm.beta,
        draw: arm.draw,
        // null: this provider serves a different arm at this decision, so this arm held no share of it.
        p_headroom: p ? p.headroom : null,
        p_final: p ? p.final : null,
      };
    }),
    selected_provider: selected.provider,
    ...(selected.model ? { selected_model: selected.model } : {}),
  };
}

/** What the worker's auction receives from the fix rung: evidence, a weigher bound to this module, and a sink. */
export interface FixLearnedArms {
  evidence: FixArmEvidence;
  weigh: (candidates: readonly FixRoutingCandidate[], seed: string) => FixRoutingWeights;
  /** Called once per spawn with the `fix.routing_decision` fields (the rung owns the ledger row). */
  onDecision?: (fields: Record<string, unknown>) => void;
}

const EVIDENCE_TTL_MS = 5 * 60_000;
const evidenceCache = new Map<string, { at: number; rows: Promise<Row[]> }>();

/** Drop the process cache (tests). */
export function clearFixRoutingEvidenceCache(): void {
  evidenceCache.clear();
}

/**
 * The fix rows the learner folds, read ASYNC from the ledger union and cached per state dir for a short
 * TTL, so a rung's strikes never re-walk the ledger. A failed read is not cached.
 */
export function readFixRoutingRows(
  stateDir: string,
  nowMs: number,
  read: (stateDir: string, since: string) => Promise<Row[]> = (dir, since) =>
    readLedgerUnionRecords(dir, { since, step: ["fix.done", "fix.ci_not_green"] }),
): Promise<Row[]> {
  const cached = evidenceCache.get(stateDir);
  if (cached && nowMs - cached.at < EVIDENCE_TTL_MS) return cached.rows;
  const rows = read(stateDir, new Date(nowMs - FIX_ROUTING_READ_WINDOW_MS).toISOString());
  evidenceCache.set(stateDir, { at: nowMs, rows });
  rows.catch(() => {
    if (evidenceCache.get(stateDir)?.rows === rows) evidenceCache.delete(stateDir);
  });
  return rows;
}
