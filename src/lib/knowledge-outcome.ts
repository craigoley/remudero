import { AMBIGUOUS_LEARNING_CONTENT, LEARNING_CONTENT_IDENTITY_RE } from "./learnings.js";
import { fixDispatchCountByRun } from "./retro.js";

/**
 * lib/knowledge-outcome.ts (W1-T4241) — credit each learning by the outcome of the runs it reached.
 *
 * The only usefulness signal before this was a worker's own `LEARNINGS_USED:` claim (W1-T4090), and
 * the causal check that could test it (W1-T4092's ablation) had run once. But `selectLearnings`
 * already randomizes: within equal match strength a seeded Beta draw decides who survives the
 * budget cut, and the dropped entries were already ledgered. Replayed over plan/ on 2026-09-23, 34%
 * of tasks overflow the budget, with ~28 draw-decided entries each. That is a randomized trial the
 * harness ran on every such dispatch and never read.
 *
 * Each run now ledgers, per CONTESTED entry (0 < p < 1), the share of re-selections under derived
 * seeds that picked it. Here those rows are joined to the run's outcome — the retro's own
 * `clean_single_strike`: merged with zero `fix.dispatch` — and weighted by inverse propensity
 * (Hajek), which is causal within the contested band. ACE keeps helpful/harmful counters and ExpeL
 * up/down-votes insights, both from the agent's own judgement; this is the measured version.
 *
 * SURFACE, DO NOT ACT: nothing here feeds ranking or retirement. Below the per-arm floor the answer
 * is `unmeasurable` with its counts, never a favourable zero.
 *
 * W1-T11115 — ONE COHORT PER CONTENT REVISION. An edit keeps the id, so grouping by id alone pooled
 * different interventions, and an edit inherited its predecessor's verdict. The producer now ledgers
 * `content_ids` (learnings.ts's `learningContentIdentity`) for every contested entry, and the fold
 * groups by {id, revision}. An observation whose revision cannot be named is excluded and counted in
 * `excludedRevision`. It is never given the current corpus's bytes: this fold reads the ledger only.
 */

/** Propensities outside [TRIM, 1 - TRIM] are excluded: an inverse weight of 20+ lets one run
 *  dominate an arm. The exclusion is counted, not silent. */
export const OUTCOME_PROPENSITY_TRIM = 0.05;
/** Fewer observations than this in either arm reads `unmeasurable`. */
export const OUTCOME_ARM_FLOOR = 10;
/** An effect is reported as helps / hurts only beyond this many standard errors. */
export const OUTCOME_Z = 2;

export type LearningOutcomeVerdict = "helps" | "hurts" | "no-detectable-effect" | "unmeasurable";

export interface LearningOutcome {
  id: string;
  /** W1-T11115: the exact content revision these observations exposed (`lc1:<16 hex>`). */
  contentId: string;
  injected: number;
  dropped: number;
  /** Hajek-weighted clean-merge rate difference, injected minus dropped (absent when unmeasurable). */
  effect?: number;
  se?: number;
  verdict: LearningOutcomeVerdict;
}

export interface LearningOutcomeReport {
  /** Earliest and latest `ts` among the runs that contributed an observation. */
  window?: { from: string; to: string };
  /** Runs with contested propensities and a terminal verdict. */
  runs: number;
  excludedNoVerdict: number;
  excludedMasked: number;
  /** Entry observations outside the propensity trim. */
  excludedTrimmed: number;
  /** W1-T11115: entry observations inside the trim that name no single revision, by reason. */
  excludedRevision: RevisionExclusions;
  learnings: LearningOutcome[];
}

/** W1-T11115: why an observation names no single content revision. Each is excluded and counted. */
export interface RevisionExclusions {
  /** The row predates content identities: it carries no `content_ids` field. */
  legacy: number;
  /** `content_ids` is not an object, or this entry's value is neither an identity nor `ambiguous`. */
  malformed: number;
  /** The draw's snapshot held this id more than once with different content. */
  ambiguous: number;
  /** One run ledgered different revisions for the same entry. */
  conflicting: number;
  /** No identity for the contested entry, or it is not listed in exactly one of selected and dropped. */
  unresolved: number;
}

/** Keep only the entries the budget cut decided (0 < p < 1); `undefined` when none were. */
export function contestedPropensities(propensity: Record<string, number> | undefined): Record<string, number> | undefined {
  if (propensity === undefined) return undefined;
  const contested = Object.entries(propensity).filter(([, p]) => p > 0 && p < 1);
  return contested.length > 0 ? Object.fromEntries(contested) : undefined;
}

interface Observation {
  injected: boolean;
  propensity: number;
  clean: boolean;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

/** Hajek mean and its linearized variance for one arm. */
function hajek(obs: Observation[], weight: (o: Observation) => number): { mean: number; variance: number } {
  const total = obs.reduce((sum, o) => sum + weight(o), 0);
  const mean = obs.reduce((sum, o) => sum + weight(o) * (o.clean ? 1 : 0), 0) / total;
  const variance = obs.reduce((sum, o) => sum + weight(o) ** 2 * ((o.clean ? 1 : 0) - mean) ** 2, 0) / total ** 2;
  return { mean, variance };
}

export function estimateLearningOutcome(id: string, contentId: string, obs: Observation[], floor = OUTCOME_ARM_FLOOR): LearningOutcome {
  const inj = obs.filter((o) => o.injected);
  const drop = obs.filter((o) => !o.injected);
  if (inj.length < floor || drop.length < floor) {
    return { id, contentId, injected: inj.length, dropped: drop.length, verdict: "unmeasurable" };
  }
  const a = hajek(inj, (o) => 1 / o.propensity);
  const b = hajek(drop, (o) => 1 / (1 - o.propensity));
  const effect = a.mean - b.mean;
  const se = Math.sqrt(a.variance + b.variance);
  const verdict: LearningOutcomeVerdict =
    Math.abs(effect) > OUTCOME_Z * se ? (effect > 0 ? "helps" : "hurts") : "no-detectable-effect";
  return { id, contentId, injected: inj.length, dropped: drop.length, effect, se, verdict };
}

type Revision = { contentId: string } | { excluded: Exclude<keyof RevisionExclusions, "conflicting"> };

/** The revision one row's `content_ids` names for `id`, or why it names none. */
function revisionOf(contentIds: unknown, id: string): Revision {
  if (contentIds === undefined) return { excluded: "legacy" };
  if (contentIds === null || typeof contentIds !== "object" || Array.isArray(contentIds)) return { excluded: "malformed" };
  const value = (contentIds as Record<string, unknown>)[id];
  if (value === undefined) return { excluded: "unresolved" };
  if (value === AMBIGUOUS_LEARNING_CONTENT) return { excluded: "ambiguous" };
  return typeof value === "string" && LEARNING_CONTENT_IDENTITY_RE.test(value) ? { contentId: value } : { excluded: "malformed" };
}

const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Fold ledger rows (read through the ledger union by the caller) into a per-revision outcome
 *  report. A run's outcome is its LAST `verdict` row; a run with none is excluded and counted. A
 *  valid identity still participates in conflict detection when its observation is trimmed.
 *  Exclusions count trimmed rows separately from otherwise eligible rows withheld for conflict. */
export function foldLearningOutcomes(
  rows: Iterable<Record<string, unknown>>,
  opts: { floor?: number; trim?: number } = {},
): LearningOutcomeReport {
  const trim = opts.trim ?? OUTCOME_PROPENSITY_TRIM;
  const all = [...rows];
  const verdictByRun = new Map<string, string>();
  for (const r of all) {
    if (r.step === "verdict" && typeof r.run_id === "string" && typeof r.verdict === "string") verdictByRun.set(r.run_id, r.verdict);
  }
  const fixes = fixDispatchCountByRun(
    all.flatMap((r) => (r.step === "fix.dispatch" && typeof r.run_id === "string" ? [{ step: r.step, run_id: r.run_id }] : [])),
  );

  const report: LearningOutcomeReport = {
    runs: 0,
    excludedNoVerdict: 0,
    excludedMasked: 0,
    excludedTrimmed: 0,
    excludedRevision: { legacy: 0, malformed: 0, ambiguous: 0, conflicting: 0, unresolved: 0 },
    learnings: [],
  };
  // An exposure is one run's draw of one entry. Two rows naming it with different revisions conflict.
  const pending: Array<{ exposure: string; id: string; contentId: string; obs: Observation }> = [];
  const revisionsByExposure = new Map<string, Set<string>>();
  let from: string | undefined;
  let to: string | undefined;
  for (const r of all) {
    if (r.step !== "learnings.injected" || typeof r.run_id !== "string") continue;
    const propensity = r.propensity;
    if (propensity === null || typeof propensity !== "object") continue;
    if (r.masked === true) {
      report.excludedMasked++;
      continue;
    }
    const verdict = verdictByRun.get(r.run_id);
    if (verdict === undefined) {
      report.excludedNoVerdict++;
      continue;
    }
    report.runs++;
    if (typeof r.ts === "string") {
      if (from === undefined || r.ts < from) from = r.ts;
      if (to === undefined || r.ts > to) to = r.ts;
    }
    const clean = verdict === "merged" && (fixes.get(r.run_id) ?? 0) === 0;
    const selected = new Set(stringList(r.matched_ids));
    const dropped = new Set(stringList(r.dropped));
    for (const [id, p] of Object.entries(propensity as Record<string, unknown>)) {
      if (typeof p !== "number" || !(p > 0 && p < 1)) continue;
      const exposure = `${r.run_id}\u0000${id}`;
      const revision = revisionOf(r.content_ids, id);
      if ("contentId" in revision) {
        const seen = revisionsByExposure.get(exposure) ?? new Set<string>();
        seen.add(revision.contentId);
        revisionsByExposure.set(exposure, seen);
      }
      if (p < trim || p > 1 - trim) {
        report.excludedTrimmed++;
        continue;
      }
      if ("excluded" in revision) {
        report.excludedRevision[revision.excluded]++;
        continue;
      }
      const { contentId } = revision;
      if (selected.has(id) === dropped.has(id)) {
        report.excludedRevision.unresolved++;
        continue;
      }
      pending.push({ exposure, id, contentId, obs: { injected: selected.has(id), propensity: p, clean } });
    }
  }
  const byRevision = new Map<string, { id: string; contentId: string; obs: Observation[] }>();
  for (const o of pending) {
    if (revisionsByExposure.get(o.exposure)!.size > 1) {
      report.excludedRevision.conflicting++;
      continue;
    }
    const key = `${o.id}\u0000${o.contentId}`;
    const cohort = byRevision.get(key) ?? { id: o.id, contentId: o.contentId, obs: [] };
    cohort.obs.push(o.obs);
    byRevision.set(key, cohort);
  }
  if (from !== undefined && to !== undefined) report.window = { from, to };
  report.learnings = [...byRevision.values()]
    .map((c) => estimateLearningOutcome(c.id, c.contentId, c.obs, opts.floor))
    .sort((x, y) => order(x.id, y.id) || order(x.contentId, y.contentId));
  return report;
}
