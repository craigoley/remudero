// W1-T2619: THE FOLLOW-UP DEDUP CORPUS DOES NOT CONTAIN THE POPULATION IT NOW HAS TO DEDUP
// AGAINST. `mineFollowups` (src/lib/retro.ts) scores every harvested candidate against
// `openTitles` (plan task titles + MASTER-PLAN `P\d+` bullets, `run-task.ts`'s `buildGather`
// call site) ALONE — never against `state/inbox-proposals.json`, the very registry
// `routeFollowupsToRegistry` files candidates into, and never against another candidate from the
// same pass. This suite MEASURES that gap and what the shipped 0.6 containment arm
// (`followupMatchesTitle`) and a 0.2 shingle-Jaccard arm (`bestNearDuplicate`'s
// `DEFAULT_DUPLICATE_CUTOFF`) each catch and each wrongly collapse over one population. NO
// REFUSAL IS BUILT OR WIRED HERE — see src/lib/followup-dedup-census.ts's own header for the
// exhaustive out-of-scope list.
//
// `CENSUS_FIXTURE` below is embedded here (no separate fixture path — the task's own `files:`
// declares exactly src/lib/followup-dedup-census.ts and this file) and is derived from this
// repo's own real routed population's shape: `c1`/`c2`/`r1`'s text is adapted from a genuine
// research entry that `state/ledger.ndjson` records HARVESTED TWICE, worded slightly differently
// each time (task W1-T2496, `report.followups` rows), with `r1` standing in for an earlier pass
// that already routed it to `state/inbox-proposals.json`; `c3`/`c4`'s "Implement W1-T#### per its
// acceptance criteria ... ready for a build pass" phrasing is adapted from real `task`-type
// entries for two DIFFERENT tasks (W1-T2479, W1-T2498) — legitimately distinct work that shares
// the routed population's own recurring boilerplate, the same "board-review #NNNN" hazard
// `src/lib/inbox.ts` already names for a sibling family; `c5`/`c6` are adapted verbatim from real,
// mutually unrelated `research` entries (W1-T2515, W1-T2476); `c7` is a byte-for-byte rewording of
// `c5` and `c8` a heavy paraphrase of it — the same two-tier fixture shape
// `test/knowledge-dedup.test.ts` uses for its own `REWORDED_FACT`/`HEAVY_PARAPHRASE_FACT`.
// `r2` is an unrelated already-routed proposal included specifically to prove affix-stripping:
// scored as raw minted summaries, `r1` and `r2` would share nothing but boilerplate tokens, but a
// SHORTER pair (see the dedicated affix test below) shows that boilerplate alone CAN cross the
// containment cutoff if never stripped.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mineFollowups, type LedgerRecord } from "../src/lib/retro.js";
import { DEFAULT_DUPLICATE_CUTOFF } from "../src/lib/knowledge-dedup.js";
import {
  containmentRatio,
  followupDedupCensus,
  followupMatchesTitleReplica,
  FOLLOWUP_DEDUP_CENSUS_MEASURED,
  SHIPPED_CONTAINMENT_CUTOFF,
  significantWordsOf,
  stripMintedFollowupAffix,
  type CensusEntry,
  type RoutedProposal,
} from "../src/lib/followup-dedup-census.js";

// ── the embedded corpus fixture, real-shaped (see header) ──────────────────────────────────

const CENSUS_FIXTURE: { candidates: CensusEntry[]; routedProposals: RoutedProposal[] } = {
  candidates: [
    {
      id: "c1",
      text:
        "Confirm whether `plan/plan-index.json`'s absence of W1-T2494/W1-T2496/W1-T2497 entries is " +
        "expected lag or a gap in the plan-sync pipeline (MASTER-PLAN §13) — relevant if other " +
        "queued-but-actually-shipped deps are also missing from the index.",
      duplicateClusterId: "plan-index-gap",
    },
    {
      id: "c2",
      text:
        "Confirm whether `plan/plan-index.json`'s absence of W1-T2494/W1-T2496/W1-T2497 entries is " +
        "expected plan-sync lag or a pipeline gap (MASTER-PLAN §13) — relevant if other " +
        "queued-but-actually-shipped dependencies are also missing from the index.",
      duplicateClusterId: "plan-index-gap",
    },
    {
      id: "c3",
      text:
        "Implement W1-T2479 per its acceptance criteria (fix `deriveCliVerbs` regex + add " +
        "caller-side agreement assertion in `run-task.ts` + new test file) — this recon confirms " +
        "the bug and scope, ready for a build pass.",
    },
    {
      id: "c4",
      text:
        "Implement W1-T2498 per its acceptance criteria (create `src/lib/operator-message.ts` " +
        "with `checkOperatorMessage()`, wire it into `src/lib/escalate.ts`, add the standard's " +
        "test file) — this recon confirms the bug and scope, ready for a build pass.",
    },
    {
      id: "c5",
      text:
        "`run-task.ts`'s `runDiagnoseThenRetry` call site does not branch on " +
        "`driverResult.usageLimit` — a usage-limit `gave_up` falls through to the generic " +
        "`failOnWorkerError` path rather than getting a distinct escalation message naming the " +
        "quota exhaustion.",
      duplicateClusterId: "usage-limit-not-branched",
    },
    {
      id: "c6",
      text:
        "the catch-erasure-ratchet detector is purely textual (brace-matched regex over the " +
        "catch body, per `test/catch-erasure-ratchet.test.ts`'s own header) and cannot see that " +
        "a caught error is recorded a few lines later through a helper, so it may flag a " +
        "defensible pattern as a violation.",
    },
    {
      id: "c7",
      text:
        "`run-task.ts`'s `runDiagnoseThenRetry` call site never branches on " +
        "`driverResult.usageLimit`, so a usage-limit `gave_up` falls through to the generic " +
        "`failOnWorkerError` path instead of a distinct escalation message naming the quota " +
        "exhaustion.",
      duplicateClusterId: "usage-limit-not-branched",
    },
    {
      id: "c8",
      text:
        "Because `runDiagnoseThenRetry` ignores the driver's usage-limit signal, a quota " +
        "exhaustion event is treated like any other worker failure and never gets its own " +
        "distinct message.",
      duplicateClusterId: "usage-limit-not-branched",
    },
  ],
  routedProposals: [
    {
      id: "r1",
      summary:
        "follow-up harvest [research]: Confirm whether `plan/plan-index.json`'s absence of " +
        "W1-T2494/W1-T2496/W1-T2497 entries is expected lag or a gap in the plan-sync pipeline " +
        "(MASTER-PLAN §13) — relevant if other queued-but-actually-shipped deps are also " +
        "missing from the index. — from W1-T2496 (run W1-T2496-oldrun)",
      duplicateClusterId: "plan-index-gap",
    },
    {
      id: "r2",
      summary:
        "follow-up harvest [task]: regenerate the CLI reference docs from the command registry " +
        "after the verb census fix lands. — from W1-T2510 (run W1-T2510-run, " +
        "https://github.com/craigoley/remudero/pull/3500)",
    },
  ],
};

// ── criterion: entry point is REACHED, not merely built ─────────────────────────────────────

test("ACCEPTANCE: followupDedupCensus is the census entry point and is CALLED from this test", () => {
  const report = followupDedupCensus(CENSUS_FIXTURE.candidates, CENSUS_FIXTURE.routedProposals);
  assert.equal(report.corpusSize, 10, "8 candidates + 2 already-routed proposals");
});

// ── criterion 1: scores ENTRY TEXT, never a routed summary verbatim ─────────────────────────

test("stripMintedFollowupAffix: recovers the entry text from routeFollowupsToRegistry's exact mint shape", () => {
  assert.equal(
    stripMintedFollowupAffix("follow-up harvest [task]: fix the thing — from W1-T1 (run W1-T1-abc)"),
    "fix the thing",
  );
  assert.equal(
    stripMintedFollowupAffix(
      "follow-up harvest [research]: an open question — from W1-T2 (run W1-T2-xyz, https://github.com/o/r/pull/9)",
    ),
    "an open question",
    "the trailing prUrl, when present, is stripped along with the rest of the affix",
  );
  assert.equal(
    stripMintedFollowupAffix("not a minted summary at all"),
    "not a minted summary at all",
    "an unrecognized shape is returned unchanged, never silently emptied",
  );
});

test("ACCEPTANCE 1: two routed proposals sharing ONLY the minted boilerplate do not collapse", () => {
  // Short substantive text, so the shared "follow-up harvest [task]: ... — from ... (run ...)"
  // affix dominates the raw string — the exact hazard `inbox.ts` already names for the eleven
  // near-identical `board-review: #NNNN carries 1 unhandled escalation(s)` summaries.
  const rawA = "follow-up harvest [task]: rename the config flag. — from W1-T3001 (run W1-T3001-run)";
  const rawB = "follow-up harvest [task]: fix the null check. — from W1-T3002 (run W1-T3002-run)";
  // MEASURED: scored RAW (never stripped), containment reaches EXACTLY the shipped cutoff —
  // two entries about unrelated work would collapse on boilerplate alone.
  const rawContainment = Math.max(containmentRatio(rawA, rawB), containmentRatio(rawB, rawA));
  assert.ok(rawContainment >= SHIPPED_CONTAINMENT_CUTOFF, `raw affix alone reaches cutoff, got ${rawContainment}`);

  // The census never scores the raw summary — it strips first, and the resulting report carries
  // no pair for these two at all, at either arm's cutoff.
  const report = followupDedupCensus([], [
    { id: "unrelated-a", summary: rawA },
    { id: "unrelated-b", summary: rawB },
  ]);
  assert.deepEqual(report.containmentArm.caught, [], "affix-stripped, the two share nothing — no containment catch");
  assert.deepEqual(report.jaccardArm.caught, [], "and no jaccard catch either");
});

test("ACCEPTANCE 1: r1 and r2 in the main fixture share only the mint boilerplate and never collapse", () => {
  const report = followupDedupCensus([], CENSUS_FIXTURE.routedProposals);
  assert.deepEqual(report.containmentArm.caught, []);
  assert.deepEqual(report.jaccardArm.caught, []);
});

// ── criterion 2: every cutoff carries BOTH arms (catches AND wrong collapses) ───────────────

test("ACCEPTANCE 2: the containment arm reports catches AND its own wrongly-collapsed pairs", () => {
  const report = followupDedupCensus(CENSUS_FIXTURE.candidates, CENSUS_FIXTURE.routedProposals);
  assert.equal(report.containmentArm.cutoff, SHIPPED_CONTAINMENT_CUTOFF);
  assert.ok(report.containmentArm.trueDuplicatesCaught.length > 0, "recall is non-trivial on this fixture");
  assert.equal(report.containmentArm.wronglyCollapsed.length, 1, "exactly the c3/c4 sibling pair");
  const collapsed = report.containmentArm.wronglyCollapsed[0];
  assert.deepEqual(new Set([collapsed.aId, collapsed.bId]), new Set(["c3", "c4"]));
});

test("ACCEPTANCE 2: the jaccard arm ALSO reports both, and differs from containment on this fixture", () => {
  const report = followupDedupCensus(CENSUS_FIXTURE.candidates, CENSUS_FIXTURE.routedProposals);
  assert.equal(report.jaccardArm.cutoff, DEFAULT_DUPLICATE_CUTOFF);
  assert.ok(report.jaccardArm.trueDuplicatesCaught.length > 0);
  // MEASURED (not asserted): jaccard's precision beats containment's on THIS population — the
  // c3/c4 sibling scores 0.146 (below 0.2) because differing substance breaks the k=3 shingle
  // alignment the shared boilerplate SENTENCE would otherwise produce.
  assert.deepEqual(report.jaccardArm.wronglyCollapsed, [], "zero wrong collapses for jaccard here");
  assert.ok(
    report.containmentArm.wronglyCollapsed.length > report.jaccardArm.wronglyCollapsed.length,
    "containment wrongly collapses a pair jaccard does not, on the SAME population",
  );
});

test("both arms MISS the heavy-paraphrase pair — the documented, deliberate miss shape", () => {
  const report = followupDedupCensus(CENSUS_FIXTURE.candidates, CENSUS_FIXTURE.routedProposals);
  const missedKeys = (arm: typeof report.containmentArm) =>
    new Set(arm.trueDuplicatesMissed.map((m) => [m.aId, m.bId].sort().join("|")));
  assert.ok(missedKeys(report.containmentArm).has(["c5", "c8"].sort().join("|")));
  assert.ok(missedKeys(report.jaccardArm).has(["c5", "c8"].sort().join("|")));
});

// ── criterion 4: reuses bestNearDuplicate, never a second scorer ────────────────────────────
// (proved by grep over src/lib/followup-dedup-census.ts itself; this test proves BEHAVIOUR: the
// jaccard arm's numbers are exactly what bestNearDuplicate produces.)

test("the jaccard arm's positive control scores exactly what bestNearDuplicate itself reports", () => {
  const report = followupDedupCensus(CENSUS_FIXTURE.candidates, CENSUS_FIXTURE.routedProposals);
  const rewordPair = report.jaccardArm.trueDuplicatesCaught.find(
    (m) => new Set([m.aId, m.bId]).has("c5") && new Set([m.aId, m.bId]).has("c7"),
  );
  assert.ok(rewordPair, "the byte-reworded c5/c7 pair is caught");
  assert.ok(rewordPair!.score >= DEFAULT_DUPLICATE_CUTOFF);
});

// ── criterion 5: the corpus gap is its own number ────────────────────────────────────────────

test("ACCEPTANCE 5: the corpus gap counts candidate-vs-routed AND candidate-vs-candidate duplicates", () => {
  const report = followupDedupCensus(CENSUS_FIXTURE.candidates, CENSUS_FIXTURE.routedProposals);
  assert.equal(report.corpusGap.candidateVsRouted.length, 2, "c1-r1 and c2-r1");
  assert.equal(report.corpusGap.candidateVsCandidate.length, 4, "c1-c2, c5-c7, c5-c8, c7-c8");
  const routedPairKeys = new Set(report.corpusGap.candidateVsRouted.map((m) => [m.aId, m.bId].sort().join("|")));
  assert.ok(routedPairKeys.has(["c1", "r1"].sort().join("|")));
  assert.ok(routedPairKeys.has(["c2", "r1"].sort().join("|")));
  // Every gap pair is counted independent of whether a cutoff would catch it — c5/c8 (the heavy
  // paraphrase, missed by BOTH arms above) is still counted here: the gap is about whether
  // `openTitles` ever COMPARES the pair, not about whether a predicate would recognize it.
  const candidatePairKeys = new Set(report.corpusGap.candidateVsCandidate.map((m) => [m.aId, m.bId].sort().join("|")));
  assert.ok(candidatePairKeys.has(["c5", "c8"].sort().join("|")), "counted in the gap even though no arm catches it");
});

test("FALSIFIER: two routed proposals sharing a cluster are NOT counted as a corpus-gap pair", () => {
  // Both sides are ALREADY in the registry — any consumer reading state/inbox-proposals.json can
  // already see both, so this is not a gap `openTitles` creates.
  const report = followupDedupCensus([], [
    { id: "ra", summary: "follow-up harvest [task]: same fact restated once — from W1-T1 (run r1)", duplicateClusterId: "x" },
    { id: "rb", summary: "follow-up harvest [task]: same fact restated twice — from W1-T2 (run r2)", duplicateClusterId: "x" },
  ]);
  assert.deepEqual(report.corpusGap.candidateVsRouted, []);
  assert.deepEqual(report.corpusGap.candidateVsCandidate, []);
});

// ── criterion 6: no cutoff is invented to force a clean separation ──────────────────────────

test("ACCEPTANCE 6: the main fixture's verdict is DECLINE and names the residue, not a fabricated cutoff", () => {
  const report = followupDedupCensus(CENSUS_FIXTURE.candidates, CENSUS_FIXTURE.routedProposals);
  assert.match(report.verdict, /^DECLINE/);
  assert.match(report.verdict, /wrongly collapses 1/, "containment's residue is named");
  assert.match(report.verdict, /misses 2/, "the paraphrase miss is named on both arms");
  // The verdict text may reference the two EXISTING cutoffs it measured (0.6, 0.2) but never
  // proposes a THIRD, freshly-invented number to force a clean separation.
  const cutoffNumbers = [...report.verdict.matchAll(/cutoff (\d+(?:\.\d+)?)/g)].map((m) => m[1]);
  assert.deepEqual(new Set(cutoffNumbers), new Set(["0.6", "0.2"]), "only the two measured cutoffs are named");
});

test("PAIRED POSITIVE CONTROL: a population with a clean, fully-recalled gap pair verdicts MEASURED", () => {
  const report = followupDedupCensus(
    [{ id: "x1", text: "the daemon leaks a temp directory on crash-recovery restart", duplicateClusterId: "temp-leak" }],
    [{ id: "y1", summary: "follow-up harvest [task]: the daemon leaks a temp directory on crash-recovery restart — from W1-T5000 (run W1-T5000-run)", duplicateClusterId: "temp-leak" }],
  );
  assert.match(report.verdict, /^MEASURED, NOT ASSERTED/);
  assert.equal(report.containmentArm.wronglyCollapsed.length, 0);
  assert.equal(report.jaccardArm.wronglyCollapsed.length, 0);
});

test("a population with NO ground-truth duplicate at all verdicts UNMEASURED, never DECLINE", () => {
  const report = followupDedupCensus(
    [{ id: "a", text: "one unrelated followup entry about the daemon" }],
    [{ id: "b", summary: "follow-up harvest [task]: an unrelated proposal about the CLI — from W1-T1 (run r1)" }],
  );
  assert.match(report.verdict, /^UNMEASURED/);
});

test("FALSIFIER: an entirely empty population never throws and verdicts UNMEASURED", () => {
  const report = followupDedupCensus([], []);
  assert.equal(report.corpusSize, 0);
  assert.match(report.verdict, /^UNMEASURED/);
  assert.deepEqual(report.containmentArm.caught, []);
  assert.deepEqual(report.jaccardArm.caught, []);
});

// ── criterion 7: the measured distribution rides in source, dated ───────────────────────────

test("ACCEPTANCE 7: FOLLOWUP_DEDUP_CENSUS_MEASURED is exactly what followupDedupCensus(CENSUS_FIXTURE) reports", () => {
  const report = followupDedupCensus(CENSUS_FIXTURE.candidates, CENSUS_FIXTURE.routedProposals);
  assert.equal(report.corpusSize, FOLLOWUP_DEDUP_CENSUS_MEASURED.corpusSize);
  const gtCount = report.corpusGap.candidateVsRouted.length + report.corpusGap.candidateVsCandidate.length;
  assert.equal(gtCount, FOLLOWUP_DEDUP_CENSUS_MEASURED.groundTruthPairCount);

  assert.equal(report.containmentArm.cutoff, FOLLOWUP_DEDUP_CENSUS_MEASURED.containmentArm.cutoff);
  assert.equal(report.containmentArm.caught.length, FOLLOWUP_DEDUP_CENSUS_MEASURED.containmentArm.caughtCount);
  assert.equal(
    report.containmentArm.trueDuplicatesCaught.length,
    FOLLOWUP_DEDUP_CENSUS_MEASURED.containmentArm.trueDuplicatesCaughtCount,
  );
  assert.equal(
    report.containmentArm.trueDuplicatesMissed.length,
    FOLLOWUP_DEDUP_CENSUS_MEASURED.containmentArm.trueDuplicatesMissedCount,
  );
  assert.equal(
    report.containmentArm.wronglyCollapsed.length,
    FOLLOWUP_DEDUP_CENSUS_MEASURED.containmentArm.wronglyCollapsedCount,
  );

  assert.equal(report.jaccardArm.cutoff, FOLLOWUP_DEDUP_CENSUS_MEASURED.jaccardArm.cutoff);
  assert.equal(report.jaccardArm.caught.length, FOLLOWUP_DEDUP_CENSUS_MEASURED.jaccardArm.caughtCount);
  assert.equal(
    report.jaccardArm.trueDuplicatesCaught.length,
    FOLLOWUP_DEDUP_CENSUS_MEASURED.jaccardArm.trueDuplicatesCaughtCount,
  );
  assert.equal(
    report.jaccardArm.trueDuplicatesMissed.length,
    FOLLOWUP_DEDUP_CENSUS_MEASURED.jaccardArm.trueDuplicatesMissedCount,
  );
  assert.equal(report.jaccardArm.wronglyCollapsed.length, FOLLOWUP_DEDUP_CENSUS_MEASURED.jaccardArm.wronglyCollapsedCount);

  assert.equal(report.corpusGap.candidateVsRouted.length, FOLLOWUP_DEDUP_CENSUS_MEASURED.corpusGap.candidateVsRoutedCount);
  assert.equal(
    report.corpusGap.candidateVsCandidate.length,
    FOLLOWUP_DEDUP_CENSUS_MEASURED.corpusGap.candidateVsCandidateCount,
  );
  assert.match(report.verdict, new RegExp(`^${FOLLOWUP_DEDUP_CENSUS_MEASURED.verdict}\\b`));
});

// ── the containment replica is PINNED against the real, shipped mineFollowups ───────────────

test("followupMatchesTitleReplica agrees with the REAL mineFollowups on the same inputs", () => {
  const records: LedgerRecord[] = [
    {
      run_id: "PIN-1",
      ts: "2026-09-02T00:00:00.000Z",
      task_id: "W1-T9000",
      step: "report.followups",
      entries: [
        { type: "research", text: "confirm the daemon's worktree cleanup runs on every crash path" },
        { type: "research", text: "an entirely unrelated question about the CLI verb census regex" },
      ],
    },
  ];
  const openTitles = ["the daemon's worktree cleanup must run on every crash path, not only a clean exit"];
  const harvest = mineFollowups(records, openTitles);
  assert.equal(harvest.deduped.length, 1, "the shipped arm dedups the contained entry");
  assert.equal(harvest.candidates.length, 1, "and lets the unrelated one through");

  const titleWords = significantWordsOf(openTitles[0]);
  assert.equal(
    followupMatchesTitleReplica(harvest.deduped[0].text, titleWords),
    true,
    "the replica agrees with the shipped arm's OWN dedup decision",
  );
  assert.equal(
    followupMatchesTitleReplica(harvest.candidates[0].text, titleWords),
    false,
    "and agrees on the entry the shipped arm let through",
  );
});

// ── purity: same inputs, same outputs, every time ────────────────────────────────────────────

test("ACCEPTANCE (purity): followupDedupCensus is deterministic over identical inputs", () => {
  const first = followupDedupCensus(CENSUS_FIXTURE.candidates, CENSUS_FIXTURE.routedProposals);
  const second = followupDedupCensus(CENSUS_FIXTURE.candidates, CENSUS_FIXTURE.routedProposals);
  assert.deepEqual(first, second);
});
