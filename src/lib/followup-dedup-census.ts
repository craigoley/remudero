/**
 * Follow-up dedup CENSUS (W1-T2619) — an instrument, not a refusal.
 *
 * THE GAP THIS MEASURES: `mineFollowups` (src/lib/retro.ts) scores every harvested follow-up
 * candidate against `openTitles` alone — plan task titles plus MASTER-PLAN `P\d+` bullets
 * (`run-task.ts`'s `openTitles: [...openTaskTitles, ...openProposalLines]`). It NEVER scores a
 * candidate against `state/inbox-proposals.json` — the very registry `routeFollowupsToRegistry`
 * (W1-T2458) files candidates into — and it never scores two candidates against EACH OTHER
 * within one mining pass. So a follow-up already routed, or a sibling harvested in the same
 * retro, can be re-filed as a brand-new proposal with no check ever comparing the two. This
 * module measures how big that gap is, and separately measures what the SHIPPED predicate
 * (`followupMatchesTitle`, asymmetric containment at 0.6) and a CANDIDATE predicate
 * (`bestNearDuplicate`'s k-shingle Jaccard at {@link DEFAULT_DUPLICATE_CUTOFF}) would each catch
 * and each wrongly collapse if pointed at that population. NO REFUSAL IS BUILT OR WIRED HERE —
 * see this task's own `design` for the exhaustive out-of-scope list (mineFollowups,
 * routeFollowupsToRegistry, the ratification seam, lint-plan all stay untouched).
 *
 * PURE OVER ITS INPUTS, same discipline as `knowledge-dedup.ts` itself: no `node:fs`, no
 * network, no reach into another src/lib module for state. The caller supplies the population;
 * this module only scores it. It imports {@link bestNearDuplicate} from `knowledge-dedup.ts` and
 * reuses it VERBATIM (never a second scorer) — the same one-module-many-consumers discipline
 * `duplicateTitleViolations`/`learningDuplicateViolation`/`draftedDuplicate` already follow. It
 * does not live inside `knowledge-dedup.ts` itself: that module states as its own contract that
 * it "never knows which corpus it is looking at", and the minted-affix stripping below is
 * follow-up-specific — folding it in would break that purity.
 *
 * THE CONTAINMENT ARM IS AN EXPLICIT, LABELLED REPLICA, NOT AN IMPORT. `followupMatchesTitle`
 * (retro.ts, module-private, ~line 2501) cannot be imported — widening `retro.ts`'s exports is
 * explicitly out of scope for this task. {@link followupMatchesTitleReplica} below mirrors its
 * body (`significantWords` + `>=3` char words + `overlap / textWords.size >= 0.6`) exactly, and
 * `test/followup-dedup-census.test.ts` pins it against the REAL `mineFollowups` on a shared
 * fixture so a future edit to the shipped predicate that this replica misses shows up as a
 * failing test, not a silently stale copy.
 */

import { bestNearDuplicate, DEFAULT_DUPLICATE_CUTOFF } from "./knowledge-dedup.js";

/** `retro.ts`'s `followupMatchesTitle` cutoff, verified at head (2026-09-02) — asymmetric
 *  significant-word containment, entry-text side. Named here (not re-guessed) because this
 *  module's whole point is comparing it against {@link DEFAULT_DUPLICATE_CUTOFF} over one
 *  corpus. */
export const SHIPPED_CONTAINMENT_CUTOFF = 0.6;

/** One entry in the population this census scores — the harvested follow-up's OWN text, never
 *  a routed proposal's minted summary (see {@link stripMintedFollowupAffix}). `duplicateClusterId`
 *  is ground truth the CALLER hand-labels — this module never infers it: every entry (candidate
 *  or routed) sharing the SAME non-empty `duplicateClusterId` is a genuine restatement of one
 *  underlying fact, pairwise, so a three-way restatement labels all three with one shared id
 *  rather than needing a second pairwise edge a fixture author could forget. An entry with no
 *  `duplicateClusterId` (or a cluster of one) is, by construction, legitimately distinct from
 *  every other entry in the population: any pair a cutoff still catches that shares no cluster id
 *  is therefore a wrongly-collapsed pair, never an unlabeled maybe. */
export interface CensusEntry {
  id: string;
  text: string;
  duplicateClusterId?: string;
}

/** One ALREADY-ROUTED registry proposal (`state/inbox-proposals.json`, `followup:*` ids) — the
 *  population `openTitles` cannot see today. `summary` is the minted string verbatim
 *  (`routeFollowupsToRegistry`'s `follow-up harvest [<type>]: <text> — from <taskId> (run
 *  <runId>[, <prUrl>])`); this module strips it back to `<text>` before scoring anything. Same
 *  `duplicateClusterId` ground-truth contract as {@link CensusEntry}. */
export interface RoutedProposal {
  id: string;
  summary: string;
  duplicateClusterId?: string;
}

/** One scored pair in the population, either arm. */
export interface CensusMatch {
  aId: string;
  bId: string;
  score: number;
}

/** One predicate arm's result over the WHOLE population, at its own cutoff. `caught` is every
 *  pair EITHER direction scores at or above `cutoff` (deduplicated, one entry per unordered
 *  pair, highest-scoring direction kept). `trueDuplicatesCaught`/`trueDuplicatesMissed` split the
 *  caller's `duplicateClusterId` ground truth by whether this arm's cutoff reaches it;
 *  `wronglyCollapsed` is every OTHER caught pair — no ground-truth label, caught anyway. Recall
 *  and false-collapse cost ride together, always, per design point (iii): no cutoff is reported
 *  with one and not the other. */
export interface DedupArmReport {
  cutoff: number;
  caught: CensusMatch[];
  trueDuplicatesCaught: CensusMatch[];
  trueDuplicatesMissed: CensusMatch[];
  wronglyCollapsed: CensusMatch[];
}

/** The corpus-gap number, counted independent of any cutoff (design point (v)): every
 *  ground-truth duplicate pair `openTitles` structurally cannot see today, because it is built
 *  from plan task titles and MASTER-PLAN `P\d+` bullets alone (verified at `run-task.ts`'s
 *  `buildGather` call site) and never reads `state/inbox-proposals.json`, and because
 *  `mineFollowups` never compares two candidates from the same pass to each other. */
export interface CorpusGapReport {
  candidateVsRouted: CensusMatch[];
  candidateVsCandidate: CensusMatch[];
}

export interface FollowupDedupCensusReport {
  corpusSize: number;
  containmentArm: DedupArmReport;
  jaccardArm: DedupArmReport;
  corpusGap: CorpusGapReport;
  /** Named, never a bare number — design point (viii): a corpus with no clean separation
   *  between the duplicate band and the sibling band publishes that residue instead of a cutoff
   *  invented to reach a satisfying score. */
  verdict: string;
}

export interface FollowupDedupCensusOpts {
  containmentCutoff?: number;
  jaccardCutoff?: number;
}

/** Significant words (>=3 alnum chars, lowercased) — an EXPLICIT REPLICA of `retro.ts`'s
 *  module-private `significantWords`, verified at head 2026-09-02. Local to this module, same as
 *  `knowledge-dedup.ts`'s own `STOPWORDS` is local to it — no cross-module reach for state. */
function significantWordsReplica(s: string): ReadonlySet<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
}

/**
 * Asymmetric containment ratio: the fraction of `text`'s own significant words that also appear
 * in `otherText`'s significant-word set. An EXPLICIT REPLICA of `retro.ts`'s module-private
 * `followupMatchesTitle`'s scoring body, generalized to a continuous [0, 1] score (the shipped
 * function only ever returns the boolean at its own fixed 0.6 cutoff; this census needs the
 * number to report a distribution, same as `bestNearDuplicate`'s Jaccard already does).
 * {@link followupMatchesTitleReplica} below is the boolean form, pinned at the shipped cutoff.
 */
export function containmentRatio(text: string, otherText: string): number {
  const textWords = significantWordsReplica(text);
  if (textWords.size === 0) return 0;
  const otherWords = significantWordsReplica(otherText);
  let overlap = 0;
  for (const w of textWords) if (otherWords.has(w)) overlap++;
  return overlap / textWords.size;
}

/** The boolean form at the SHIPPED cutoff — byte-for-byte the same predicate
 *  `mineFollowups`/`followupMatchesTitle` applies to (candidate text, one open title's word
 *  set). `test/followup-dedup-census.test.ts` pins this against the real `mineFollowups` so a
 *  drift between the replica and the shipped arm surfaces as a failing test, not a silent
 *  mis-price of the very mechanism under measurement. */
export function followupMatchesTitleReplica(text: string, titleWords: ReadonlySet<string>): boolean {
  const textWords = significantWordsReplica(text);
  if (textWords.size === 0) return false;
  let overlap = 0;
  for (const w of textWords) if (titleWords.has(w)) overlap++;
  return overlap / textWords.size >= SHIPPED_CONTAINMENT_CUTOFF;
}

/** `significantWordsReplica`, exposed for a caller that wants to feed
 *  {@link followupMatchesTitleReplica} the same pre-tokenized title-word-set shape
 *  `mineFollowups` builds once per title (see its own `openTitleWordSets`). */
export function significantWordsOf(s: string): ReadonlySet<string> {
  return significantWordsReplica(s);
}

/**
 * Recover a harvested follow-up's own entry text from an ALREADY-ROUTED proposal's minted
 * summary — `routeFollowupsToRegistry`'s exact shape, verified at head 2026-09-02:
 * `` `follow-up harvest [${type}]: ${text} — from ${taskId} (run ${runId}${prUrl ? `, ${prUrl}` : ""})` ``.
 * Every routed follow-up proposal shares this literal prefix and suffix; scoring the summary
 * VERBATIM would inflate every pair's overlap on boilerplate alone (the exact hazard
 * `inbox.ts` already records for the eleven near-identical `board-review: #NNNN carries N
 * unhandled escalation(s)` summaries — same shape, different family). When the shape doesn't
 * match (a summary this module doesn't recognize as a follow-up harvest mint), the summary is
 * returned unchanged rather than silently emptied — a caller passing a non-follow-up proposal by
 * mistake still gets SOMETHING to score, not a vacuous empty string that matches nothing.
 */
export function stripMintedFollowupAffix(summary: string): string {
  const m = /^follow-up harvest \[(?:research|task|action)\]: ([\s\S]*) — from \S+ \(run [^()]*\)$/.exec(summary);
  return m ? m[1] : summary;
}

interface PopEntry {
  id: string;
  text: string;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

function unpairKey(key: string): [string, string] {
  const [a, b] = key.split(" ");
  return [a, b];
}

function allUnorderedPairs(population: readonly PopEntry[]): Array<[PopEntry, PopEntry]> {
  const pairs: Array<[PopEntry, PopEntry]> = [];
  for (let i = 0; i < population.length; i++) {
    for (let j = i + 1; j < population.length; j++) pairs.push([population[i], population[j]]);
  }
  return pairs;
}

/** Pairwise Jaccard score of two population entries, computed by REUSING {@link bestNearDuplicate}
 *  over a one-entry corpus rather than reimplementing shingle overlap here — the whole point of
 *  reusing the existing scorer instead of adding a second one. */
function jaccardPairScore(a: PopEntry, b: PopEntry): number {
  return bestNearDuplicate({ id: a.id, text: a.text }, [{ id: b.id, text: b.text }])?.score ?? 0;
}

/** Pairwise containment score, taken as the MAX of both directions (`a` read as the shorter
 *  entry-text against `b` read as the title-role, and vice versa). The shipped predicate is
 *  directional (entry text vs. an open TITLE's words), but this census scores entry-vs-entry —
 *  neither side is structurally "the title" — so a pair counts as a containment catch if EITHER
 *  direction would trip the shipped predicate, documented here rather than silently picking one
 *  direction and under-counting the arm's real recall. */
function containmentPairScore(a: PopEntry, b: PopEntry): number {
  return Math.max(containmentRatio(a.text, b.text), containmentRatio(b.text, a.text));
}

function computeArm(
  population: readonly PopEntry[],
  pairScore: (a: PopEntry, b: PopEntry) => number,
  cutoff: number,
  groundTruthPairKeys: ReadonlySet<string>,
): DedupArmReport {
  const caught: CensusMatch[] = [];
  for (const [a, b] of allUnorderedPairs(population)) {
    const score = pairScore(a, b);
    if (score >= cutoff) caught.push({ aId: a.id, bId: b.id, score });
  }
  const caughtKeys = new Set(caught.map((m) => pairKey(m.aId, m.bId)));
  const trueDuplicatesCaught = caught.filter((m) => groundTruthPairKeys.has(pairKey(m.aId, m.bId)));
  const wronglyCollapsed = caught.filter((m) => !groundTruthPairKeys.has(pairKey(m.aId, m.bId)));
  const trueDuplicatesMissed: CensusMatch[] = [];
  for (const key of groundTruthPairKeys) {
    if (caughtKeys.has(key)) continue;
    const [aId, bId] = unpairKey(key);
    const a = population.find((p) => p.id === aId);
    const b = population.find((p) => p.id === bId);
    trueDuplicatesMissed.push({ aId, bId, score: a && b ? pairScore(a, b) : 0 });
  }
  return { cutoff, caught, trueDuplicatesCaught, trueDuplicatesMissed, wronglyCollapsed };
}

function deriveVerdict(containmentArm: DedupArmReport, jaccardArm: DedupArmReport, corpusGap: CorpusGapReport): string {
  const gapTotal = corpusGap.candidateVsRouted.length + corpusGap.candidateVsCandidate.length;
  if (gapTotal === 0) {
    return (
      "UNMEASURED — the supplied population carries no hand-labeled routed-proposal/candidate " +
      "duplicate, so the corpus gap this task exists to measure has nothing to measure against " +
      "in this pass"
    );
  }
  const bothClean = containmentArm.wronglyCollapsed.length === 0 && jaccardArm.wronglyCollapsed.length === 0;
  const bothFullRecall = containmentArm.trueDuplicatesMissed.length === 0 && jaccardArm.trueDuplicatesMissed.length === 0;
  if (bothClean && bothFullRecall) {
    return (
      `MEASURED, NOT ASSERTED — the corpus gap is real (${gapTotal} ground-truth duplicate ` +
      "pair(s) invisible to today's openTitles-only corpus) and BOTH predicate arms recall every " +
      "known duplicate in this population with ZERO wrongly-collapsed pairs — wiring a refusal " +
      "against the FULL corpus (routed proposals included) is worth pursuing as a follow-up, " +
      "though this instrument files none itself"
    );
  }
  return (
    `DECLINE — the corpus gap is real (${gapTotal} ground-truth duplicate pair(s) invisible to ` +
    "today's openTitles-only corpus), but on this population at least one predicate arm either " +
    "misses a known duplicate or wrongly collapses a legitimately-distinct pair: containment " +
    `(cutoff ${containmentArm.cutoff}) misses ${containmentArm.trueDuplicatesMissed.length} and ` +
    `wrongly collapses ${containmentArm.wronglyCollapsed.length}; jaccard (cutoff ` +
    `${jaccardArm.cutoff}) misses ${jaccardArm.trueDuplicatesMissed.length} and wrongly collapses ` +
    `${jaccardArm.wronglyCollapsed.length}. No cutoff is invented here to force a clean separation ` +
    "the measured bands do not have — the residue is named instead, per this task's own design."
  );
}

/**
 * The census entry point (this task's own criterion 3: it is REACHED, not merely built — the
 * only consumer this deliberately-unwired instrument has is the test that calls it).
 *
 * `candidates` is the current pass's unharvested `report.followups` entries; `routedProposals`
 * is the ALREADY-ROUTED `state/inbox-proposals.json` population `openTitles` never includes.
 * Both carry hand-labeled `duplicateClusterId` ground truth — this module never infers a
 * duplicate pair, it only reports whether each predicate arm's cutoff would (or would not) reach
 * every pair sharing a cluster, and which OTHER pairs it reaches with no shared cluster (a wrong
 * collapse).
 */
export function followupDedupCensus(
  candidates: readonly CensusEntry[],
  routedProposals: readonly RoutedProposal[],
  opts: FollowupDedupCensusOpts = {},
): FollowupDedupCensusReport {
  const containmentCutoff = opts.containmentCutoff ?? SHIPPED_CONTAINMENT_CUTOFF;
  const jaccardCutoff = opts.jaccardCutoff ?? DEFAULT_DUPLICATE_CUTOFF;

  const population: PopEntry[] = [
    ...candidates.map((c) => ({ id: c.id, text: c.text })),
    ...routedProposals.map((r) => ({ id: r.id, text: stripMintedFollowupAffix(r.summary) })),
  ];
  const byId = new Map(population.map((p) => [p.id, p]));

  // GROUND TRUTH FROM CLUSTERS, NOT PAIRWISE EDGES: every entry sharing one `duplicateClusterId`
  // is pairwise ground truth against every OTHER member of that same cluster — so a three-way
  // restatement (the real shape a follow-up re-harvested across two runs plus already routed
  // once can take) needs one shared id per member, never a second pairwise edge a fixture author
  // could forget and that would otherwise silently mis-score the forgotten pair as a wrong
  // collapse instead of a true (if labeled) duplicate.
  const clusters = new Map<string, Array<{ id: string; isCandidate: boolean }>>();
  for (const c of candidates) {
    if (!c.duplicateClusterId) continue;
    const members = clusters.get(c.duplicateClusterId) ?? [];
    members.push({ id: c.id, isCandidate: true });
    clusters.set(c.duplicateClusterId, members);
  }
  for (const r of routedProposals) {
    if (!r.duplicateClusterId) continue;
    const members = clusters.get(r.duplicateClusterId) ?? [];
    members.push({ id: r.id, isCandidate: false });
    clusters.set(r.duplicateClusterId, members);
  }

  const groundTruthPairKeys = new Set<string>();
  const candidateVsRouted: CensusMatch[] = [];
  const candidateVsCandidate: CensusMatch[] = [];
  for (const members of clusters.values()) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const [m1, m2] = [members[i], members[j]];
        const a = byId.get(m1.id);
        const b = byId.get(m2.id);
        if (!a || !b) continue; // an unresolved reference names nothing to score — skipped
        groundTruthPairKeys.add(pairKey(a.id, b.id));
        const score = jaccardPairScore(a, b);
        if (m1.isCandidate && !m2.isCandidate) candidateVsRouted.push({ aId: m1.id, bId: m2.id, score });
        else if (!m1.isCandidate && m2.isCandidate) candidateVsRouted.push({ aId: m2.id, bId: m1.id, score });
        else if (m1.isCandidate && m2.isCandidate) candidateVsCandidate.push({ aId: m1.id, bId: m2.id, score });
        // two routed proposals sharing a cluster: not a corpus-GAP pair (both already visible in
        // the registry to any consumer that reads it) — omitted from either gap list on purpose.
      }
    }
  }

  const containmentArm = computeArm(population, containmentPairScore, containmentCutoff, groundTruthPairKeys);
  const jaccardArm = computeArm(population, jaccardPairScore, jaccardCutoff, groundTruthPairKeys);
  const corpusGap: CorpusGapReport = { candidateVsRouted, candidateVsCandidate };

  return {
    corpusSize: population.length,
    containmentArm,
    jaccardArm,
    corpusGap,
    verdict: deriveVerdict(containmentArm, jaccardArm, corpusGap),
  };
}

/**
 * MEASURED, not asserted (design point (vi)) — the exact precedent `knowledge-dedup.ts`'s own
 * `DEFAULT_DUPLICATE_CUTOFF` doc block set. Computed by calling {@link followupDedupCensus} on
 * the 10-entry population `test/followup-dedup-census.test.ts`'s `CENSUS_FIXTURE` embeds (real
 * follow-up text drawn from this repo's own `state/ledger.ndjson` `report.followups` rows and
 * `state/inbox-proposals.json` `followup:*` rows, adapted where needed to carry hand-labeled
 * ground truth — see that test file's own header for the exact texts and clusters). The test
 * calls `followupDedupCensus` on that SAME fixture and asserts the result against every count
 * below, so a later edit to the fixture that changes the answer fails the test rather than
 * leaving this block stale and unnoticed.
 *
 *   - corpus size 10 (8 candidates + 2 already-routed proposals), carrying 6 hand-labeled
 *     ground-truth duplicate pairs across two clusters: `plan-index-gap` (two candidates plus
 *     the already-routed proposal restating the same `plan/plan-index.json` research question)
 *     and `usage-limit-not-branched` (an original candidate, a byte-for-byte reword, and a heavy
 *     paraphrase of the same `runDiagnoseThenRetry` defect).
 *   - containment arm (cutoff 0.6): CAUGHT 5 pairs, of which 4 are true duplicates (both
 *     `plan-index-gap` candidate-vs-candidate/candidate-vs-routed edges reachable at this cutoff,
 *     plus the reworded `usage-limit-not-branched` pair) and 1 is a WRONG COLLAPSE — two
 *     legitimately distinct tasks ("Implement W1-T2479 ..." / "Implement W1-T2498 ...") that
 *     share the routed population's own recurring "per its acceptance criteria ... ready for a
 *     build pass" boilerplate, the exact "board-review #NNNN" hazard `inbox.ts` already names for
 *     a sibling family. It MISSES 2 true duplicates — both involve the heavy paraphrase, the
 *     documented, deliberate miss shape (paraphrase evades word-overlap same as it evades
 *     shingle-overlap).
 *   - jaccard arm (cutoff 0.2, `DEFAULT_DUPLICATE_CUTOFF`): CAUGHT 4 pairs, all 4 true duplicates,
 *     ZERO wrong collapses on this population — the "Implement W1-T####..." sibling pair scores
 *     0.146, under cutoff, because the two task descriptions' *differing* substance (regex fix vs.
 *     new-module creation) breaks the contiguous 3-token shingle alignment the shared boilerplate
 *     sentence would otherwise produce; a bag-of-words check (containment) has no such structural
 *     protection. It MISSES the same 2 heavy-paraphrase pairs containment misses.
 *   - corpus gap: 6 ground-truth pairs total (2 candidate-vs-routed, 4 candidate-vs-candidate) —
 *     EVERY one invisible to `openTitles` today regardless of cutoff, because `openTitles` is
 *     built from plan task titles and MASTER-PLAN `P\d+` bullets alone and never reads
 *     `state/inbox-proposals.json`, and `mineFollowups` never compares two candidates from one
 *     pass to each other (verified at `run-task.ts`'s `buildGather` call site and at
 *     `mineFollowups` itself, both re-read at head 2026-09-02).
 *   - VERDICT: DECLINE. The corpus gap is real and the candidate Jaccard arm has a real edge on
 *     precision here (0 wrong collapses vs. containment's 1) — but BOTH arms share the same
 *     documented paraphrase-miss ceiling, so wiring either one against the fuller corpus unchanged
 *     would still leave the true duplicate this population is hardest on (a heavy paraphrase)
 *     un-caught, while the sibling-boilerplate hazard remains a live risk for containment
 *     specifically. No cutoff is invented here to erase either residue — both are named instead,
 *     per this task's own design point (viii).
 */
export const FOLLOWUP_DEDUP_CENSUS_MEASURED = {
  measuredAt: "2026-09-02",
  corpusSize: 10,
  groundTruthPairCount: 6,
  containmentArm: { cutoff: SHIPPED_CONTAINMENT_CUTOFF, caughtCount: 5, trueDuplicatesCaughtCount: 4, trueDuplicatesMissedCount: 2, wronglyCollapsedCount: 1 },
  jaccardArm: { cutoff: DEFAULT_DUPLICATE_CUTOFF, caughtCount: 4, trueDuplicatesCaughtCount: 4, trueDuplicatesMissedCount: 2, wronglyCollapsedCount: 0 },
  corpusGap: { candidateVsRoutedCount: 2, candidateVsCandidateCount: 4 },
  verdict: "DECLINE",
} as const;
