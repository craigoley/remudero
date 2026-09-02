// src/lib/routing-prior.ts
//
// ROUTING EVIDENCE IS POOLED OR IT IS PER-REPO AND BOTH ARE WRONG (W1-T2576, MASTER-PLAN §9).
//
// Pool every repo's evidence into one fleet-wide average and the busiest repo's idiosyncrasies —
// its language, its test latency, its gate stack — become the prior every OTHER repo inherits.
// Isolate each repo's evidence instead and onboarding throws away everything the fleet already
// learned: a brand-new repo starts from zero no matter how many thousands of runs the fleet has
// behind it, which is precisely the property the operator asked NOT to have.
//
// PARTIAL POOLING RESOLVES THIS, AND IT IS NOT A COMPROMISE — IT IS THE CORRECT ESTIMATOR. A
// repo's estimate is the pooled fleet-wide estimate shrunk toward that repo's OWN observations in
// proportion to how much of its own evidence exists:
//
//     estimate = (ownN * ownValue + K * pooledValue) / (ownN + K)
//
// where K (see {@link DEFAULT_SHRINKAGE_K}) is a fixed pseudo-count — "trust the pool as much as K
// of the repo's own runs." At ownN=0 the repo inherits the pooled estimate outright (onboarding is
// cheap); as its own n grows the ratio ownN/(ownN+K) → 1 and the estimate migrates to the repo's
// own behaviour (the busiest repo stops governing it). K stays FIXED regardless of how large the
// rest of the fleet's volume grows, which is exactly what stops one repo's volume from moving
// another repo's estimate once that repo has its own evidence: growing some OTHER repo's n moves
// `pooledValue` (a weighted average) but the WEIGHT that pooled value carries against `ownValue` is
// capped at K, not at the fleet's total n. No threshold, no cliff, no "is this repo similar enough"
// judgment call.
//
// AN OPERATOR-DECLARED PRIOR DOMINATES RATHER THAN AVERAGES. §9: "Per-repo priors live in
// principles.yaml (a gnarly C# repo can default Sonnet-high-thinking; a docs repo, Haiku)." A human
// saying "this repo is gnarly" is information the ledger does not contain, and a router that
// quietly out-votes it with learned evidence is not one an operator can direct — so when an
// operator prior is present, {@link pooledPriorFor} returns it VERBATIM, never blended with the
// learned shrinkage estimate. (No live `principles.yaml` instance in this repo declares a
// `routing_priors` block yet — {@link operatorPriorFromPrinciples} documents the read shape this
// module expects a future onboarding write to produce; see this task's own PR body for the
// follow-up that tracks wiring an actual write path.)
//
// WHAT THIS MUST NOT DO IS MANUFACTURE CONFIDENCE. The shrunk estimate reports BOTH the repo's own
// n and the pooled n behind it (never merged into one number) so a caller can see when a
// recommendation rests entirely on other repos' evidence and refuse to act on it if it wants local
// proof — same "refuse more often than recommend" posture `mount-recommender.ts` already carries.
//
// PURE: no I/O, no file reads. Callers (e.g. `mount-recommender.ts`) hand in already-gathered
// evidence and an already-parsed `principles.yaml` document; this module never touches disk.

/** One entity's own observed evidence — a repo's own runs, in this task's own framing, though
 *  nothing here is repo-specific: `id` is whatever join key the caller pools by. `value` is
 *  whatever scalar is being estimated (a pass rate, a cost figure, anything on a shared scale
 *  across every `id` passed to the same call) and `n` is how many observations back it. */
export interface PoolableEvidence {
  id: string;
  n: number;
  value: number;
}

/** The fleet-wide estimate built by pooling every {@link PoolableEvidence} entry together,
 *  weighted by each entry's own `n` — never a plain (unweighted) average across ids, which would
 *  let a low-volume id count as much as a high-volume one and understate how much evidence the
 *  pool actually carries. */
export interface PooledPrior {
  pooledValue: number;
  /** Total evidence behind {@link PooledPrior.pooledValue} — the sum of every entry's own `n`,
   *  reported so a caller can see how much (or little) the pool itself rests on. */
  pooledN: number;
}

/** Weighted-average pool across every entry handed in — `{ pooledValue: 0, pooledN: 0 }` when the
 *  fleet itself has no evidence yet (a true cold start, distinct from a single repo's own n=0). */
export function computePooledPrior(evidence: readonly PoolableEvidence[]): PooledPrior {
  const pooledN = evidence.reduce((sum, e) => sum + e.n, 0);
  if (pooledN === 0) {
    return { pooledValue: 0, pooledN: 0 };
  }
  const weightedSum = evidence.reduce((sum, e) => sum + e.n * e.value, 0);
  return { pooledValue: weightedSum / pooledN, pooledN };
}

/** An operator-declared value that DOMINATES the learned estimate — see this module's own header
 *  for why it is never averaged in. */
export interface RoutingPriorOverride {
  value: number;
}

/** The fixed pseudo-count `K` in this module's own shrinkage formula (module header) — "trust the
 *  pool as much as this many of the id's own runs." Deliberately small relative to the sample
 *  floors `mount-recommender.ts` already enforces (`DEFAULT_MIN_SAMPLE_N = 30`) so an id with a
 *  recommendation-grade sample of its own is barely nudged by the pool at all. */
export const DEFAULT_SHRINKAGE_K = 10;

export type PooledPriorSource = "operator" | "shrinkage";

export interface PooledPriorEstimate {
  id: string;
  /** The final estimate a caller should route on. */
  estimate: number;
  /** This id's OWN observation count — 0 for a repo with no runs of its own. Reported separately
   *  from {@link PooledPriorEstimate.pooledN} on purpose (this module's own header, "must not
   *  manufacture confidence"). */
  ownN: number;
  /** The total evidence behind the fleet-wide pool this estimate was shrunk toward (0 only when
   *  the WHOLE fleet, not just this id, has no evidence yet). */
  pooledN: number;
  /** `"operator"` when an operator-declared {@link RoutingPriorOverride} was supplied (the
   *  estimate is that value, verbatim); `"shrinkage"` when it is the learned partial-pooling
   *  estimate this module's header formula produces. */
  source: PooledPriorSource;
}

export interface PooledPriorOptions {
  /** An operator-declared prior (read from `principles.yaml`, see
   *  {@link operatorPriorFromPrinciples}) — when present, DOMINATES: the returned estimate is this
   *  value verbatim, never blended with the learned one. */
  operatorPrior?: RoutingPriorOverride;
  /** Overrides {@link DEFAULT_SHRINKAGE_K}. */
  shrinkageK?: number;
}

/**
 * The pooled-or-per-repo estimator this task exists to provide (module header has the full
 * rationale). Given `id`'s own evidence (if any) inside `evidence`, plus every OTHER id's evidence
 * in the same array (the fleet pool), returns a single estimate that:
 *
 *   - equals the operator's declared prior verbatim when one is supplied (dominates, never
 *     averaged);
 *   - equals the pooled fleet estimate outright when `id` has no evidence of its own (n=0 — the
 *     zero-evidence-repo falsifier this task's own rationale names);
 *   - migrates toward `id`'s own observed value as its own `n` grows, converging to it rather than
 *     settling somewhere in between, however large the rest of the fleet's volume is.
 */
export function pooledPriorFor(
  id: string,
  evidence: readonly PoolableEvidence[],
  opts: PooledPriorOptions = {},
): PooledPriorEstimate {
  const own = evidence.find((e) => e.id === id);
  const ownN = own?.n ?? 0;
  const ownValue = own?.value ?? 0;
  const { pooledValue, pooledN } = computePooledPrior(evidence);

  if (opts.operatorPrior !== undefined) {
    return { id, estimate: opts.operatorPrior.value, ownN, pooledN, source: "operator" };
  }

  const k = opts.shrinkageK ?? DEFAULT_SHRINKAGE_K;
  const denom = ownN + k;
  const estimate = denom === 0 ? pooledValue : (ownN * ownValue + k * pooledValue) / denom;
  return { id, estimate, ownN, pooledN, source: "shrinkage" };
}

/**
 * Reads an operator-declared routing prior back out of an ALREADY-PARSED `principles.yaml`
 * document (this function performs no file I/O and no YAML parsing itself — a caller that has
 * already loaded the file hands in the parsed object). Documents the shape this module expects a
 * `routing_priors` block to take:
 *
 *     routing_priors:
 *       <id>: <number>            # shorthand
 *       <id>: { value: <number> } # equivalent, explicit form
 *
 * `undefined` for a document with no `routing_priors` block, or none for this `id` — never a
 * thrown error, so a caller can always fall back to the learned {@link pooledPriorFor} estimate.
 */
export function operatorPriorFromPrinciples(principles: unknown, id: string): RoutingPriorOverride | undefined {
  if (!principles || typeof principles !== "object") {
    return undefined;
  }
  const routingPriors = (principles as Record<string, unknown>).routing_priors;
  if (!routingPriors || typeof routingPriors !== "object") {
    return undefined;
  }
  const raw = (routingPriors as Record<string, unknown>)[id];
  if (typeof raw === "number") {
    return { value: raw };
  }
  if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).value === "number") {
    return { value: (raw as Record<string, unknown>).value as number };
  }
  return undefined;
}
