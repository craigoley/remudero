/**
 * test/a-verdict-is-reused-when-nothing-it-judged-changed.test.ts — W1-T3704.
 *
 * THE DEFECT: a push discards a completed review WHOLE, even when the pull request's own diff is
 * byte-identical. `DISPOSITION_RULES` (src/lib/sweep.ts) routed EVERY `reviewOrphanedByPush` PR to
 * either the W1-T225 escalation cap or a full `post-review` re-review — no cheaper middle case for
 * the common "update branch" / no-op-force-push shapes.
 *
 * THE FIX, split exactly along the task's own design boundary:
 *  (i)   review.ts RECORDS what a verdict judged: `reviewLedgerLegibilityFields` rides `own_diff_digest`/
 *        `merge_base_sha` onto the `review.posted` ledger line when the verdict carries them, and
 *        `priorReviewVerdictFromLedger` reads them back onto {@link PriorReviewVerdict} — absent
 *        means UNREADABLE, never a false-ish default (unlike `capped`/`planOnly`).
 *  (ii)  sweep.ts DECIDES what a later push, having orphaned that verdict, is actually owed:
 *        {@link reviewReuseVerdict} compares what was judged against what the current push carries
 *        and returns `"reuse"` / `"discriminate-only"` / `"full-review"`. Two new `DISPOSITION_RULES`
 *        rows route the first two kinds to the `"review-reused"`/`"discriminate-only"` dispositions,
 *        ordered strictly before the existing orphan-cap/post-review rows so a push this task can
 *        cheapen never still falls through to the total-loss default.
 *
 * Five acceptance criteria, one test block each below.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  reviewReuseVerdict,
  type OpenPrView,
  type ReviewReuseInputs,
} from "../src/lib/sweep.js";
import { priorReviewVerdictFromLedger, reviewLedgerLegibilityFields } from "../src/lib/review.js";

const NOW = Date.parse("2026-09-16T19:00:00Z");
const RECENT = "2026-09-16T18:50:00Z";
const CURRENT_HEAD = "cafef00dcafef00dcafef00dcafef00dcafef00d";
const JUDGED_HEAD = "d00dfeedd00dfeedd00dfeedd00dfeedd00dfeed";
const TASK = "W1-T3704D";
const PR_URL = "https://github.com/craigoley/remudero/pull/3704";
const OWN_DIFF_DIGEST = "sha256:own-diff-abc123";
const MERGE_BASE = "0ldbase00ldbase00ldbase00ldbase00ldbase0";
const NEW_MERGE_BASE = "newbase1newbase1newbase1newbase1newbase1";

/** {@link ReviewReuseInputs} is declared OFF `OpenPrView` on purpose (see that type's own doc in
 *  sweep.ts) — no producer assigns any of its five keys onto a real `OpenPrView` yet, so a fixture
 *  here carries them as an overlay, the same shape `reviewReuseInputsFrom` reads off a real PR. */
type OrphanedPrFixture = Partial<OpenPrView> & Partial<ReviewReuseInputs>;

/** The exact shape a push-orphaned, checks-green review matches: `reviewState: "none"`,
 *  `checksState: "green"`, `reviewOrphanedByPush: true`, no unreadable required-contexts read. */
function orphanedPr(over: OrphanedPrFixture = {}): OpenPrView & Partial<ReviewReuseInputs> {
  return {
    prNumber: 3704,
    prUrl: PR_URL,
    taskId: TASK,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: CURRENT_HEAD,
    autoMergeArmed: false,
    reviewOrphanedByPush: true,
    priorReviewAttemptsForInput: 0,
    ...over,
  };
}

/** The full set of identity inputs {@link reviewReuseVerdict} compares, both sides equal — the
 *  "nothing a review reads has changed" shape (design row 1). */
function unchangedInputs(): Partial<ReviewReuseInputs> {
  return {
    reviewedOwnDiffDigest: OWN_DIFF_DIGEST,
    currentOwnDiffDigest: OWN_DIFF_DIGEST,
    reviewedMergeBaseSha: MERGE_BASE,
    currentMergeBaseSha: MERGE_BASE,
    reviewedHeadSha: JUDGED_HEAD,
  };
}

// ── acceptance 1: own diff same, merge base same → reuse the verdict ──────────────────────────

test("W1-T3704 (1): a push whose own diff and merge base are both unchanged reuses the verdict instead of discarding it", () => {
  const pr = orphanedPr(unchangedInputs());

  assert.deepEqual(reviewReuseVerdict(pr), { kind: "reuse", judgedHeadSha: JUDGED_HEAD });

  const result = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "review-reused", "reused, never routed to a full re-review");
  assert.notEqual(result.disposition, "post-review", "the discarded-verdict default must not fire here");
});

// ── acceptance 2: own diff same, merge base moved → discrimination only ───────────────────────

test("W1-T3704 (2): a push that only moves the merge base re-runs discrimination alone rather than the whole review", () => {
  const pr = orphanedPr({ ...unchangedInputs(), currentMergeBaseSha: NEW_MERGE_BASE });

  assert.deepEqual(reviewReuseVerdict(pr), { kind: "discriminate-only", judgedHeadSha: JUDGED_HEAD });

  const result = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "discriminate-only");
  assert.notEqual(result.disposition, "post-review", "a base-only move is cheaper than a full review");
  assert.match(result.reason, /discrimination alone/i);
});

// ── acceptance 3: any change to the own diff is a full re-review, no threshold of smallness ────

test("W1-T3704 (3): any change to the pull request's own diff still takes a full re-review, so no threshold of smallness exists", () => {
  const changedDiffCases: Array<OrphanedPrFixture> = [
    // own diff changed, merge base unchanged
    { ...unchangedInputs(), currentOwnDiffDigest: "sha256:own-diff-DIFFERENT" },
    // own diff changed AND merge base moved — still full review, never "discriminate-only"
    { ...unchangedInputs(), currentOwnDiffDigest: "sha256:own-diff-DIFFERENT", currentMergeBaseSha: NEW_MERGE_BASE },
  ];

  for (const over of changedDiffCases) {
    const pr = orphanedPr(over);
    assert.deepEqual(reviewReuseVerdict(pr), { kind: "full-review" });

    const result = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
    // Falls through, unmodified, to the existing orphaned-by-push post-review row (or the cap row
    // once `priorReviewAttemptsForInput` reaches the cap — neither is "review-reused"/"discriminate-only").
    assert.notEqual(result.disposition, "review-reused");
    assert.notEqual(result.disposition, "discriminate-only");
  }
});

// ── acceptance 4: a reused verdict names the head it originally judged ─────────────────────────

test("W1-T3704 (4): a reused verdict names the head it originally judged, so reuse is auditable rather than silent", () => {
  const pr = orphanedPr(unchangedInputs());
  const verdict = reviewReuseVerdict(pr);
  assert.equal(verdict.kind, "reuse");
  assert.equal(verdict.kind === "reuse" ? verdict.judgedHeadSha : undefined, JUDGED_HEAD);

  const result = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.match(
    result.reason,
    new RegExp(JUDGED_HEAD.slice(0, 7)),
    "the disposition reason names the ORIGINALLY judged head, not the current one",
  );
  assert.doesNotMatch(result.reason, new RegExp(CURRENT_HEAD.slice(0, 7)), "never the current head instead");

  // The discriminate-only kind names its judged head identically.
  const discriminateOnlyPr = orphanedPr({ ...unchangedInputs(), currentMergeBaseSha: NEW_MERGE_BASE });
  const discriminateResult = deriveDisposition(discriminateOnlyPr, DEFAULT_SWEEP_POLICY, NOW);
  assert.match(discriminateResult.reason, new RegExp(JUDGED_HEAD.slice(0, 7)));
});

// ── acceptance 5: unreadable evidence refuses to reuse, falling back to a full re-review ──────

test("W1-T3704 (5): an unreadable diff or unresolvable merge base falls back to a full re-review rather than reusing on incomplete evidence", () => {
  const missingOneField: Array<OrphanedPrFixture> = [
    { ...unchangedInputs(), reviewedOwnDiffDigest: undefined },
    { ...unchangedInputs(), currentOwnDiffDigest: undefined },
    { ...unchangedInputs(), reviewedMergeBaseSha: undefined },
    { ...unchangedInputs(), currentMergeBaseSha: undefined },
    { ...unchangedInputs(), reviewedHeadSha: undefined },
    // nothing recorded at all — a line that predates every one of these fields
    {},
  ];

  for (const over of missingOneField) {
    const pr = orphanedPr(over);
    assert.deepEqual(reviewReuseVerdict(pr), { kind: "full-review" });

    const result = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
    assert.notEqual(result.disposition, "review-reused");
    assert.notEqual(result.disposition, "discriminate-only");
  }
});

// ── design (i): review.ts records what a verdict judged, round-tripped through the ledger ─────

test("W1-T3704 (design i): review.posted records own_diff_digest/merge_base_sha, and priorReviewVerdictFromLedger reads them back", () => {
  const fields = reviewLedgerLegibilityFields({
    capped: false,
    keywordOnly: false,
    planOnly: false,
    ownDiffDigest: OWN_DIFF_DIGEST,
    mergeBaseSha: MERGE_BASE,
  });
  assert.equal(fields.own_diff_digest, OWN_DIFF_DIGEST);
  assert.equal(fields.merge_base_sha, MERGE_BASE);

  const ledgerLine = {
    step: "review.posted",
    task_id: TASK,
    head_sha: JUDGED_HEAD,
    state: "success" as const,
    ...fields,
  };
  const prior = priorReviewVerdictFromLedger([ledgerLine], TASK);
  assert.equal(prior?.ownDiffDigest, OWN_DIFF_DIGEST);
  assert.equal(prior?.mergeBaseSha, MERGE_BASE);
  assert.equal(prior?.headSha, JUDGED_HEAD);
});

test("W1-T3704 (design i): an older review.posted line with neither key reads back UNDEFINED, not a false-ish default", () => {
  const fields = reviewLedgerLegibilityFields({ capped: false, keywordOnly: false, planOnly: false });
  assert.equal("own_diff_digest" in fields, false, "absent from the line, never written as undefined");
  assert.equal("merge_base_sha" in fields, false);

  const legacyLine = { step: "review.posted", task_id: TASK, head_sha: JUDGED_HEAD, state: "success" as const };
  const prior = priorReviewVerdictFromLedger([legacyLine], TASK);
  assert.equal(prior?.ownDiffDigest, undefined);
  assert.equal(prior?.mergeBaseSha, undefined);
});
