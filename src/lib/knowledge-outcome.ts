import { AMBIGUOUS_LEARNING_CONTENT, LEARNING_CONTENT_IDENTITY_RE, learningIdRecord } from "./learnings.js";
import { KNOWLEDGE_MEASURED_STEP } from "./knowledge-gaps.js";
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
 * ONLY HARM ACTS (W1-T14141): nothing here feeds ranking. A `hurts` verdict on the exact current
 * revision of an active learning feeds one retirement candidate in the knowledge gardener
 * (knowledge-gardener.ts's `measuredHarmRetirements`), which still lands as a reviewed PR; `helps`,
 * `no-detectable-effect` and `unmeasurable` feed nothing. Below the per-arm floor the answer is
 * `unmeasurable` with its counts, never a favourable zero.
 *
 * W1-T11115 — ONE COHORT PER CONTENT REVISION. An edit keeps the id, so grouping by id alone pooled
 * different interventions, and an edit inherited its predecessor's verdict. The producer now ledgers
 * `content_ids` (learnings.ts's `learningContentIdentity`) for every contested entry, and the fold
 * groups by {id, revision}. An observation whose revision cannot be named is excluded and counted in
 * `excludedRevision`. It is never given the current corpus's bytes: this fold reads the ledger only.
 * A learning id is free corpus text (`__proto__` and `constructor` load), so every id-keyed lookup
 * here is a Map or an own-property read, and a produced id-keyed record has no prototype.
 * An id is not unique across layers either: a project and a user-overall copy of one id can both
 * match a task. The producer counts the draw per copy, so such an id keeps its share and its
 * `ambiguous` marker, and the fold reads an id listed in BOTH arms as an exposure it counts and
 * never credits (see {@link foldLearningOutcomes}).
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
  /** Runs with a terminal verdict whose row ledgered shares or listed an id in both arms. */
  runs: number;
  excludedNoVerdict: number;
  excludedMasked: number;
  /** Entry observations outside the propensity trim. Only an observation whose revision and arm both
   *  resolve can land here: see {@link foldLearningOutcomes}'s counting rule. */
  excludedTrimmed: number;
  /** W1-T11115: entry observations that name no single revision, by reason. Every reason is checked
   *  BEFORE the trim, so a trimmed observation is counted here under its reason, never only as
   *  trimmed, and `ambiguous: 0` means no contested row named an ambiguous identity. */
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
  /** One run's rows for the same entry name more than one claim: two different revisions, or a
   *  revision beside a row that names none. The check reads EVERY row of the run that exposes the
   *  entry, before the trim and every other exclusion, so a trimmed row still voids the exposure. */
  conflicting: number;
  /** No identity for the exposed entry, no ledgered share for it, or it is not listed in exactly one of
   *  selected and dropped. An id listed in both arms always lands here, or in an earlier reason. */
  unresolved: number;
}

/** Keep only the entries the budget cut decided; `undefined` when none were. An entry is decided when
 *  its share is strictly between 0 and 1, or when the draw names it in `contestedIds` (learnings.ts's
 *  `selectLearnings`): an id whose copies split the draw is contested even at a pooled share of 1,
 *  and keeps that share here. The result is a learnings.ts `learningIdRecord` (no prototype), so an
 *  id such as `__proto__` stays a key. */
export function contestedPropensities(
  propensity: Record<string, number> | undefined,
  contestedIds: Iterable<string> = [],
): Record<string, number> | undefined {
  if (propensity === undefined) return undefined;
  const decided = new Set(contestedIds);
  const contested = Object.entries(propensity).filter(([id, p]) => (p > 0 && p < 1) || decided.has(id));
  return contested.length > 0 ? learningIdRecord(contested) : undefined;
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

/** The revision one row's `content_ids` names for `id`, or why it names none. It reads an OWN
 *  property only: a parsed row has `Object.prototype`, so `content_ids["__proto__"]` or
 *  `["constructor"]` would otherwise read an inherited member, and a missing digest would read as
 *  `malformed` instead of `unresolved`. */
function revisionOf(contentIds: unknown, id: string): Revision {
  if (contentIds === undefined) return { excluded: "legacy" };
  if (contentIds === null || typeof contentIds !== "object" || Array.isArray(contentIds)) return { excluded: "malformed" };
  const value = Object.hasOwn(contentIds, id) ? (contentIds as Record<string, unknown>)[id] : undefined;
  if (value === undefined) return { excluded: "unresolved" };
  if (value === AMBIGUOUS_LEARNING_CONTENT) return { excluded: "ambiguous" };
  return typeof value === "string" && LEARNING_CONTENT_IDENTITY_RE.test(value) ? { contentId: value } : { excluded: "malformed" };
}

const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The claim a row without a single revision makes in an exposure's census. It is not an `lc1:`
 *  identity, so it can never collide with one. */
const NO_SINGLE_REVISION = "\u0000none";

/** A ledgered share: in (0, 1]. The producer ledgers only contested entries, and an id whose copies
 *  split the draw is contested at a pooled share of 1 (learnings.ts's `selectLearnings`). */
const isLedgeredShare = (p: unknown): p is number => typeof p === "number" && p > 0 && p <= 1;

/** One run's draws of one entry. */
const exposureKey = (runId: string, id: string): string => `${runId}\u0000${id}`;

/** The exposures one `learnings.injected` row records, each id with its ledgered share: every entry
 *  the row ledgers a share for, and every id the row lists in BOTH arms, with or without a share. A
 *  both-arms id is one id whose copies split the draw: one reached the prompt and another did not.
 *  The fold can never credit it, so it is an exposure only to be COUNTED, never silently dropped.
 *  `undefined` when the row records no draw at all: no share record and no both-arms id. */
function exposuresOf(r: Record<string, unknown>): Map<string, number | undefined> | undefined {
  const propensity = r.propensity;
  const hasShares = propensity !== null && typeof propensity === "object";
  const dropped = new Set(stringList(r.dropped));
  const bothArms = stringList(r.matched_ids).filter((id) => dropped.has(id));
  if (!hasShares && bothArms.length === 0) return undefined;
  const exposures = new Map<string, number | undefined>();
  if (hasShares) {
    for (const [id, p] of Object.entries(propensity as Record<string, unknown>)) if (isLedgeredShare(p)) exposures.set(id, p);
  }
  for (const id of bothArms) if (!exposures.has(id)) exposures.set(id, undefined);
  return exposures;
}

/** Every revision claim each exposure (one run's draws of one entry) received, from EVERY
 *  `learnings.injected` row that exposes the entry: trimmed, masked or verdict-less alike. Read
 *  before any observation is withheld, so a conflict on a row the trim drops is still seen. */
function revisionClaimsByExposure(all: readonly Record<string, unknown>[]): Map<string, Set<string>> {
  const claims = new Map<string, Set<string>>();
  for (const r of all) {
    if (r.step !== "learnings.injected" || typeof r.run_id !== "string") continue;
    for (const id of exposuresOf(r)?.keys() ?? []) {
      const revision = revisionOf(r.content_ids, id);
      const exposure = exposureKey(r.run_id, id);
      const seen = claims.get(exposure) ?? new Set<string>();
      seen.add("contentId" in revision ? revision.contentId : NO_SINGLE_REVISION);
      claims.set(exposure, seen);
    }
  }
  return claims;
}

/** Fold ledger rows (read through the ledger union by the caller) into a per-revision outcome
 *  report. A run's outcome is its LAST `verdict` row; a run with none is excluded and counted.
 *
 *  THE COUNTING RULE: each exposure of an unmasked run with a verdict (an entry its row ledgers a
 *  share for, or an id its row lists in both arms: see `exposuresOf`) lands in exactly ONE place,
 *  the first of these that applies:
 *  1. `excludedRevision.conflicting`: the exposure (over EVERY row of the run) names more than one claim;
 *  2. `excludedRevision.{legacy, malformed, ambiguous, unresolved}`: the row names no single revision;
 *  3. `excludedRevision.unresolved`: the row ledgers no share for it, or does not list it in exactly
 *     one of selected and dropped. A both-arms id never passes this step;
 *  4. `excludedTrimmed`: its propensity is outside [trim, 1 - trim];
 *  5. its {id, revision} cohort.
 *  Identity comes before the trim, so a trimmed row can never hide an unresolved identity, and an
 *  id in both arms is counted under its own reason: `ambiguous` when its copies differ. */
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
  // An exposure is one run's draws of one entry. Its claims are taken over every row first.
  const claimsByExposure = revisionClaimsByExposure(all);
  const byRevision = new Map<string, { id: string; contentId: string; obs: Observation[] }>();
  let from: string | undefined;
  let to: string | undefined;
  for (const r of all) {
    if (r.step !== "learnings.injected" || typeof r.run_id !== "string") continue;
    const exposures = exposuresOf(r);
    if (exposures === undefined) continue;
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
    for (const [id, p] of exposures) {
      if (claimsByExposure.get(exposureKey(r.run_id, id))!.size > 1) {
        report.excludedRevision.conflicting++;
        continue;
      }
      const revision = revisionOf(r.content_ids, id);
      if ("excluded" in revision) {
        report.excludedRevision[revision.excluded]++;
        continue;
      }
      const { contentId } = revision;
      if (p === undefined || selected.has(id) === dropped.has(id)) {
        report.excludedRevision.unresolved++;
        continue;
      }
      if (p < trim || p > 1 - trim) {
        report.excludedTrimmed++;
        continue;
      }
      const key = `${id}\u0000${contentId}`;
      const cohort = byRevision.get(key) ?? { id, contentId, obs: [] };
      cohort.obs.push({ injected: selected.has(id), propensity: p, clean });
      byRevision.set(key, cohort);
    }
  }
  if (from !== undefined && to !== undefined) report.window = { from, to };
  report.learnings = [...byRevision.values()]
    .map((c) => estimateLearningOutcome(c.id, c.contentId, c.obs, opts.floor))
    .sort((x, y) => order(x.id, y.id) || order(x.contentId, y.contentId));
  return report;
}

const VERDICTS: ReadonlySet<string> = new Set<LearningOutcomeVerdict>(["helps", "hurts", "no-detectable-effect", "unmeasurable"]);
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isOptionalFinite = (v: unknown): boolean => v === undefined || (typeof v === "number" && Number.isFinite(v));

/** W1-T14141: whether one parsed `outcomes.learnings` entry has the {@link LearningOutcome} shape. A
 *  ledger row is parsed text, so each field is checked before anything reads it as a verdict. */
function isLearningOutcome(v: unknown): v is LearningOutcome {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.contentId === "string" && isCount(o.injected) && isCount(o.dropped) &&
    typeof o.verdict === "string" && VERDICTS.has(o.verdict) && isOptionalFinite(o.effect) && isOptionalFinite(o.se);
}

/** W1-T14141: the learnings of the NEWEST `knowledge.measured` row, the row the digest reads
 *  (digest.ts's `summarizeKnowledgeMeasured`): the latest by `ts`, whatever its status. A newest row
 *  that was refused or carries no outcomes gives `[]`, never an older row's verdicts: a retirement
 *  acts on the current measurement only. An entry without the outcome shape is left out. */
export function newestMeasuredLearningOutcomes(rows: Iterable<Record<string, unknown>>): LearningOutcome[] {
  let latest: Record<string, unknown> | undefined;
  for (const r of rows) {
    if (r.step !== KNOWLEDGE_MEASURED_STEP || typeof r.ts !== "string") continue;
    if (latest === undefined || r.ts > (latest.ts as string)) latest = r;
  }
  if (latest?.status !== "measured") return [];
  const learnings = (latest.outcomes as { learnings?: unknown } | undefined)?.learnings;
  return Array.isArray(learnings) ? learnings.filter(isLearningOutcome) : [];
}

/** W1-T14141 — the one verdict that may act. The cohort reads `hurts` AND its numbers agree with
 *  {@link estimateLearningOutcome}'s own rule: a negative effect beyond {@link OUTCOME_Z} standard
 *  errors. A row whose verdict and numbers disagree is not harm. */
export function measuredHarm(o: LearningOutcome): o is LearningOutcome & { effect: number; se: number } {
  return o.verdict === "hurts" && o.effect !== undefined && o.se !== undefined && o.se >= 0 && o.effect < 0 && -o.effect > OUTCOME_Z * o.se;
}
