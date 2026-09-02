import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildOpenPrViews, reviewAttemptsForInput } from "../src/run-task.js";
import { reviewInputDigest } from "../src/lib/review.js";
import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  reviewVerdictOvertakenByActivity,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { appendLedger } from "../src/lib/ledger.js";

/**
 * W1-T2299 — "A CORRECTED PR BODY CANNOT REACH THE REVIEWER THAT JUDGED THE OLD ONE": the
 * post-review disposition row used to offer a head to `remudero-review` only when `reviewState`
 * was `"none"` or a stale `"pending"` — nothing in the predicate ever read the PR's own
 * timestamps, so a posted FAILURE verdict made the head permanently unofferable even once the
 * body that verdict judged was corrected. These tests drive the THIRD admitting arm added to
 * that row: a `reviewState === "failure"` head that has seen activity (per
 * {@link OpenPrView.lastActivityAt}, the PR's own `updated_at`) AFTER its verdict was posted
 * (per {@link OpenPrView.reviewVerdictPostedAt}) only when the current exact head+body digest has
 * ZERO completed judgments. A real body/head correction resets that digest's counter; coarse
 * activity that leaves the input unchanged does not reopen the review lane.
 */

const NOW = Date.parse("2026-08-26T12:00:00Z");
const VERDICT_AT = "2026-08-24T12:00:00Z"; // 2 days before NOW
const ACTIVITY_AFTER = "2026-08-25T12:00:00Z"; // 1 day before NOW, AFTER the verdict

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 700,
    prUrl: "https://github.com/o/r/pull/700",
    taskId: "W1-T700",
    reviewState: "pending",
    checksState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-08-25T12:00:00Z",
    headSha: "cafe700cafe700cafe700cafe700cafe700cafe",
    autoMergeArmed: false,
    ...over,
  };
}

/** A checks-green PR whose `remudero-review` posted FAILURE, ripe for the new admitting arm. */
function failedReviewPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [],
    criteriaRecoverable: false,
    priorReviewAttemptsForInput: 0,
    reviewVerdictPostedAt: VERDICT_AT,
    lastActivityAt: ACTIVITY_AFTER,
    ...over,
  });
}

function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-reoffer-")), "ledger.ndjson"),
    runId: "SWEEP-1",
    now: () => NOW,
    ...overrides,
  };
}

// ── acceptance 1: the admitting arm, and its strictly-additive boundary ──────────────────────

test("a failing review whose PR saw activity AFTER the verdict is offered to post-review; an otherwise identical head with no later activity is not", () => {
  const changed = deriveDisposition(failedReviewPr(), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(changed.disposition, "post-review", "activity postdates the verdict — offer the head again");
  assert.match(changed.reason, /remudero-review failed but the PR has seen activity since that verdict was posted/);

  // Byte-identical fixture except lastActivityAt does NOT postdate the verdict (design note x:
  // "nothing re-offers a head whose body did not change" — activity at-or-before the verdict is
  // the closest a fixture can get to "did not change" at this field's resolution).
  const unchanged = deriveDisposition(failedReviewPr({ lastActivityAt: VERDICT_AT }), DEFAULT_SWEEP_POLICY, NOW);
  assert.notEqual(unchanged.disposition, "post-review", "no later activity — the head stays exactly as unofferable as before this task");
  assert.equal(unchanged.disposition, "blocked-ambiguous", "falls straight through to the pre-existing failure row, unchanged");
  assert.match(unchanged.reason, /criteria unrecoverable/, "the SAME reason that row has always stated");
});

test("reviewVerdictOvertakenByActivity fails CLOSED on missing or unparseable timestamps, and reads strictly-after", () => {
  assert.equal(reviewVerdictOvertakenByActivity(pr({ lastActivityAt: ACTIVITY_AFTER })), false, "no reviewVerdictPostedAt at all");
  assert.equal(
    reviewVerdictOvertakenByActivity(pr({ reviewVerdictPostedAt: "not-a-date", lastActivityAt: ACTIVITY_AFTER })),
    false,
    "an unparseable verdict timestamp",
  );
  assert.equal(
    reviewVerdictOvertakenByActivity(pr({ reviewVerdictPostedAt: VERDICT_AT, lastActivityAt: "not-a-date" })),
    false,
    "an unparseable activity timestamp",
  );
  assert.equal(
    reviewVerdictOvertakenByActivity(pr({ reviewVerdictPostedAt: VERDICT_AT, lastActivityAt: VERDICT_AT })),
    false,
    "equal timestamps — no activity STRICTLY after the verdict",
  );
  assert.equal(
    reviewVerdictOvertakenByActivity(pr({ reviewVerdictPostedAt: VERDICT_AT, lastActivityAt: ACTIVITY_AFTER })),
    true,
  );
});

// ── acceptance 2 & 3: exact-input reset, never a lifetime PR budget ──────────────────────────

test("activity cannot re-offer an exact input that already has one completed judgment", () => {
  const activityOnly = failedReviewPr({
    priorReviewAttemptsForInput: 1,
    lastActivityAt: "2026-08-26T06:00:00Z", // later activity, but the exact-input count is unchanged
  });
  const d = deriveDisposition(activityOnly, DEFAULT_SWEEP_POLICY, NOW);
  assert.notEqual(d.disposition, "post-review", "same-input activity falls through instead of fighting delivery dedup forever");
  assert.equal(d.disposition, "blocked-ambiguous");
  assert.match(d.reason, /criteria unrecoverable/);
});

test("missing exact-input attempt data fails closed instead of manufacturing review permission", () => {
  const d = deriveDisposition(
    failedReviewPr({ priorReviewAttemptsForInput: undefined }),
    DEFAULT_SWEEP_POLICY,
    NOW,
  );
  assert.notEqual(d.disposition, "post-review");
  assert.equal(d.disposition, "blocked-ambiguous");
  assert.match(d.reason, /criteria unrecoverable/);
});

test("a body or head correction creates a fresh exact input and resets review admission immediately", () => {
  const head = "cafe700cafe700cafe700cafe700cafe700cafe";
  const oldBody = "old acceptance";
  const oldDigest = reviewInputDigest(head, oldBody);
  const ledger = [
    {
      ts: "2026-08-24T12:00:00Z",
      step: "review.posted",
      task_id: "W1-T700",
      pr_url: "https://github.com/o/r/pull/700",
      head_sha: head,
      review_input_digest: oldDigest,
    },
  ];

  const unchanged = reviewAttemptsForInput(ledger, "W1-T700", "https://github.com/o/r/pull/700", head, oldDigest);
  assert.equal(unchanged.attempts, 1, "the already-judged digest stays closed despite coarse PR activity");

  const correctedDigest = reviewInputDigest(head, "corrected acceptance");
  const corrected = reviewAttemptsForInput(ledger, "W1-T700", "https://github.com/o/r/pull/700", head, correctedDigest);
  assert.equal(corrected.attempts, 0, "a body edit resets the exact-input count");
  assert.equal(
    deriveDisposition(failedReviewPr({ priorReviewAttemptsForInput: corrected.attempts }), DEFAULT_SWEEP_POLICY, NOW).disposition,
    "post-review",
    "the corrected input is admitted without waiting for a lifetime or wall-clock cap reset",
  );
});

test("the review-orphan cap and stuck-pending clock retain their independent recovery behavior", () => {
  const cappedOrphan = deriveDisposition(
    pr({
      reviewState: "none",
      checksState: "green",
      reviewOrphanedByPush: true,
      priorReviewAttemptsForInput: DEFAULT_SWEEP_POLICY.reviewOrphanCap,
    }),
    DEFAULT_SWEEP_POLICY,
    NOW,
  );
  assert.equal(cappedOrphan.disposition, "blocked-ambiguous");
  assert.match(cappedOrphan.reason, /orphaned by a push, again/);

  const stalePending = deriveDisposition(
    pr({
      reviewState: "pending",
      checksState: "green",
      reviewPendingSince: "2026-08-26T08:00:00Z",
    }),
    DEFAULT_SWEEP_POLICY,
    NOW,
  );
  assert.equal(stalePending.disposition, "post-review");
  assert.match(stalePending.reason, /treating the stuck pending as unattended/);
});

// ── acceptance 4: the reason is its own distinguishable cause ────────────────────────────────

test("the activity-after-verdict reason is textually distinct from the other three post-review admitting reasons", () => {
  const reoffer = deriveDisposition(failedReviewPr(), DEFAULT_SWEEP_POLICY, NOW).reason;
  assert.match(reoffer, /activity since that verdict was posted/);
  assert.doesNotMatch(reoffer, /review never posted/, "distinct from the never-reviewed cause");
  assert.doesNotMatch(reoffer, /orphaned by a push/, "distinct from the orphaned-by-a-push cause");
  assert.doesNotMatch(reoffer, /treating the stuck pending as/, "distinct from the stuck-pending cause");

  const neverReviewed = deriveDisposition(
    pr({ prNumber: 584, reviewState: "none", checksState: "green" }),
    DEFAULT_SWEEP_POLICY,
    NOW,
  ).reason;
  assert.doesNotMatch(neverReviewed, /activity since that verdict was posted/);
});

// ── acceptance 5: a re-offer is judged afresh — same lane, same teeth ────────────────────────

test("runSweep dispatches the SAME postReview lane for a body-edit re-offer as for any other post-review admit — no special-cased bypass", async () => {
  const calls: number[] = [];
  const lp = join(mkdtempSync(join(tmpdir(), "rmd-reoffer-")), "ledger.ndjson");
  const deps = fakeDeps({
    ledgerPath: lp,
    postReview: (p) => {
      calls.push(p.prNumber);
      // Simulates the real effect (buildSweepEffects.postReview -> reviewCommand) posting a FRESH
      // verdict for the head — never a carried-forward one.
      appendLedger(lp, { run_id: "SWEEP-1", task_id: p.taskId ?? "", step: "review.posted", head_sha: p.headSha, state: "failure" });
    },
  });
  await runSweep([failedReviewPr()], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(calls, [700], "the ordinary post-review dispatch ran — the same code path every other admitting arm takes");
});

test("the reoffer reason states a FRESH verdict is posted and the prior one is never carried forward — the reviewer keeps its teeth", () => {
  const d = deriveDisposition(failedReviewPr(), DEFAULT_SWEEP_POLICY, NOW);
  assert.match(d.reason, /a fresh verdict is posted and the prior one is never carried forward/);
});

// ── acceptance 6: honestly framed as activity, never as a body edit ──────────────────────────

test("the admitting arm is recorded as detecting ACTIVITY after a verdict, not a body edit — the payload carries no body-specific timestamp", () => {
  const d = deriveDisposition(failedReviewPr(), DEFAULT_SWEEP_POLICY, NOW);
  assert.match(d.reason, /GitHub's PR object carries no body-specific timestamp/);
  assert.match(d.reason, /not provably a body edit/);
});

// ── the producer: reviewVerdictPostedAt is actually WIRED, not just mechanism ─────────────────

test("buildOpenPrViews POPULATES reviewVerdictPostedAt off the SAME rollup read reviewState already scans", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-reoffer-prod-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");

  const headSha = "cafe700cafe700cafe700cafe700cafe700cafe";
  const verdictCreatedAt = "2026-08-24T12:00:00.000Z";
  const fetch = (args: string[]): unknown => {
    const path = args[args.length - 1] ?? "";
    if (/state=open/.test(path)) {
      return [
        {
          number: 700,
          html_url: "https://github.com/craigoley/remudero/pull/700",
          head: { ref: "fix/x", sha: headSha },
          updated_at: "2026-08-25T12:00:00.000Z",
          body: "Remudero-Task: W1-T700",
          auto_merge: null,
          state: "open",
        },
      ];
    }
    if (/\/check-runs/.test(path)) return { check_runs: [] };
    if (new RegExp(`/commits/${headSha}/status$`).test(path)) {
      return { statuses: [{ context: "remudero-review", state: "failure", created_at: verdictCreatedAt }] };
    }
    if (/\/pulls\/700$/.test(path)) return { mergeable: true, mergeable_state: "clean" };
    return [];
  };

  const views = buildOpenPrViews("craigoley", "remudero", ledgerPath, { fetch, requiredContexts: () => [] });
  assert.equal(views.length, 1);
  assert.equal(views[0].reviewState, "failure");
  assert.equal(views[0].reviewVerdictPostedAt, verdictCreatedAt, "the producer sets it from the SAME commit-status entry, not a fabricated fixture value");
});
