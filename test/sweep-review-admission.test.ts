import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SWEEP_POLICY, runSweepLightPass, selectReviewAdmission, selectReviewAdmissions, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";
import { appendLedger } from "../src/lib/ledger.js";

// ── W1-T526 — THE QUEUE-ADMISSION RULE ──────────────────────────────────────────────────────
//
// Deliberately a SEPARATE file from test/sweep.test.ts (this task's own plan note: an
// admission rule wants a file whose failures cannot be confused with a disposition
// regression — that file carries the whole disposition surface).
//
// `strict: true` branch protection means only ONE open PR can merge before every OTHER one
// reads `behind`, and a `behind` PR's own next push (to catch back up) mints a NEW head sha —
// discarding whatever verdict `runSweepLightPass` just spent a review posting. Before this
// task, `runSweepLightPass` fanned every post-review-eligible PR out to its own concurrent
// `runSweep` call every ~60s tick, so a queue of N such PRs cost N + (N-1) + … + 1 reviews to
// land N merges — quadratic in queue depth. W1-T2792 keeps the admission bounded but uses the
// configured reviewLanes width: at most that many post-review-eligible PRs are admitted per pass,
// chosen oldest-head-first (never starves), and
// only a genuinely post-review-eligible PR is ever a candidate (never held up by one that
// cannot merge).

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-sweep-admission-")), "ledger.ndjson");
}

const NOW = Date.parse("2026-07-17T12:00:00Z");

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    taskId: "W1-TX",
    reviewState: "pending",
    checksState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-07-16T12:00:00Z",
    headSha: "aaaa111",
    autoMergeArmed: false,
    ...over,
  };
}

/** checks green, review never posted -> `post-review`, the ONE lane this task caps at one per pass. */
function postReviewPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({ reviewState: "none", checksState: "green", ...over });
}

/** review passed, checks green -> `mergeable` (the arm lane) — a disposition this task leaves untouched. */
function mergeablePr(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({ reviewState: "success", checksState: "green", ...over });
}

/** a reviewer-unmet failure with checks green -> `blocked-fixable` (the fix lane) — also untouched. */
function blockedFixablePr(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [{ claim: "does the thing", proof: "unit test: it works", met: false, reason: "not done", proof_exec: "executed_fail" }],
    ...over,
  });
}

/** strikes at cap, still failing, checks red -> `blocked-ambiguous` (escalate) — NEVER post-review,
 *  and NEVER mergeable: this is the "cannot merge" fixture the queue must never be held up by. */
function unmergeablePr(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({
    reviewState: "failure",
    checksState: "red",
    priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap,
    unmetCriteria: [{ claim: "still broken", proof: "unit test: it works", met: false, reason: "not done", proof_exec: "executed_fail" }],
    ...over,
  });
}

function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & {
  armed: OpenPrView[];
  fixed: OpenPrView[];
  escalated: OpenPrView[];
} {
  const armed: OpenPrView[] = [];
  const fixed: OpenPrView[] = [];
  const escalated: OpenPrView[] = [];
  return {
    armed,
    fixed,
    escalated,
    arm: (p) => {
      armed.push(p);
    },
    close: () => {},
    dispatchFix: (p) => {
      fixed.push(p);
    },
    escalate: (p) => {
      escalated.push(p);
    },
    ledgerPath: ledgerPath(),
    runId: "SWEEP-1",
    now: () => NOW,
    ...overrides,
  };
}

test("W1-T2792: reviewLanes one preserves the original single semantic admission", () => {
  const older = postReviewPr({ prNumber: 10, createdAt: "2026-07-10T00:00:00Z" });
  const middle = postReviewPr({ prNumber: 20, createdAt: "2026-07-11T00:00:00Z" });
  const younger = postReviewPr({ prNumber: 30, createdAt: "2026-07-12T00:00:00Z" });
  const selected = selectReviewAdmissions(
    [younger, middle, older],
    { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1 },
    NOW,
  );
  assert.deepEqual(selected.spawning.map((candidate) => candidate.prNumber), [10]);
});

test("W1-T2792: one light pass reviews up to the configured semantic width", async () => {
  const lp = ledgerPath();
  const posted: number[] = [];
  const deps = fakeDeps({
    ledgerPath: lp,
    postReview: (p) => {
      posted.push(p.prNumber);
    },
  });
  // Both PRs derive `post-review` this pass — #10 carries the OLDER head.
  const older = postReviewPr({ prNumber: 10, prUrl: "url/10", taskId: "W1-T10", headSha: "sha10", lastActivityAt: "2026-07-10T00:00:00Z" });
  const younger = postReviewPr({ prNumber: 20, prUrl: "url/20", taskId: "W1-T20", headSha: "sha20", lastActivityAt: "2026-07-15T00:00:00Z" });

  const summaries = await runSweepLightPass([older, younger], deps, DEFAULT_SWEEP_POLICY);

  assert.deepEqual(posted.sort((a, b) => a - b), [10, 20], "both eligible reviews fit the configured two lanes");
  assert.equal(summaries.length, 2, "the standing-down PR is still reconciled this pass, never silently dropped");

  const disposed = readLedgerLines(lp).filter((l) => l.step === "sweep.disposed");
  const olderLine = disposed.find((l) => l.pr_number === 10);
  const youngerLine = disposed.find((l) => l.pr_number === 20);
  assert.equal(olderLine?.disposition, "post-review");
  assert.equal(olderLine?.acted, true, "the admitted PR's review really ran");
  assert.equal(youngerLine?.disposition, "post-review", "the losing PR's OWN disposition is unchanged — still post-review, just not admitted");
  assert.equal(youngerLine?.acted, true, "the second PR uses the second configured review lane");
});

test("W1-T526: the loser of one pass wins a later pass", async () => {
  const lp = ledgerPath();
  const postedPass1: number[] = [];
  const deps1 = fakeDeps({
    ledgerPath: lp,
    postReview: (p) => {
      postedPass1.push(p.prNumber);
      appendLedger(lp, { run_id: "SWEEP-1", task_id: p.taskId ?? "", step: "review.posted", head_sha: p.headSha, state: "success" });
    },
  });
  const older = postReviewPr({ prNumber: 10, prUrl: "url/10", taskId: "W1-T10", headSha: "sha10", lastActivityAt: "2026-07-10T00:00:00Z" });
  const younger = postReviewPr({ prNumber: 20, prUrl: "url/20", taskId: "W1-T20", headSha: "sha20", lastActivityAt: "2026-07-15T00:00:00Z" });

  await runSweepLightPass([older, younger], deps1, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(postedPass1.sort((a, b) => a - b), [10, 20], "pass 1: both heads fit the configured width");

  // A fresh read of #10's own live state (`buildOpenPrViews`, the real gateway) now reflects
  // the review it just posted — it is no longer `post-review`-eligible AT ALL, exactly as a
  // real re-fetch after a posted verdict would show. #20 — the PASS-1 LOSER — is now the only
  // eligible candidate: the starvation falsifier design (ii) names.
  const olderNowReviewed: OpenPrView = { ...older, reviewState: "success" };
  const postedPass2: number[] = [];
  const deps2 = fakeDeps({
    ledgerPath: lp,
    postReview: (p) => {
      postedPass2.push(p.prNumber);
    },
  });
  await runSweepLightPass([olderNowReviewed, younger], deps2, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(postedPass2, [], "pass 2: both prior outcomes are deduped before ranking");
});

test("W1-T526: an unmergeable pull request never holds the queue", async () => {
  const lp = ledgerPath();
  const posted: number[] = [];
  const deps = fakeDeps({
    ledgerPath: lp,
    postReview: (p) => {
      posted.push(p.prNumber);
    },
  });

  // The unmergeable PR carries the OLDEST head of the two (but inside `staleDays`, so it stays
  // blocked-ambiguous rather than tripping the SEPARATE stale-abandonment rule) — if age alone
  // governed admission, rather than disposition-eligibility gating it out first, it would win.
  const stuck = unmergeablePr({ prNumber: 30, prUrl: "url/30", taskId: "W1-T30", headSha: "sha30", lastActivityAt: "2026-07-05T00:00:00Z" });
  const eligible = postReviewPr({ prNumber: 10, prUrl: "url/10", taskId: "W1-T10", headSha: "sha10", lastActivityAt: "2026-07-10T00:00:00Z" });

  await runSweepLightPass([stuck, eligible], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(posted, [10], "the unmergeable PR's age never lets it capture the one review slot");
  assert.equal(deps.escalated.length, 1, "the unmergeable PR is still dispositioned (escalated) every pass, just never admitted to post-review");

  // The pure selector itself, directly: disposition-gated FIRST, age-ordered second — an
  // unmergeable PR is never even a candidate, however old its head.
  const chosen = selectReviewAdmission([stuck, eligible], DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(chosen?.prNumber, 10, "selectReviewAdmission only ever considers post-review-eligible PRs");
});

test("W1-T526: arming and fixing still act on every pull request", async () => {
  const lp = ledgerPath();
  const posted: number[] = [];
  const deps = fakeDeps({
    ledgerPath: lp,
    postReview: (p) => {
      posted.push(p.prNumber);
    },
  });

  const mergeable = mergeablePr({ prNumber: 40, prUrl: "url/40", taskId: "W1-T40", headSha: "sha40" });
  const fixable = blockedFixablePr({ prNumber: 41, prUrl: "url/41", taskId: "W1-T41", headSha: "sha41" });
  const older = postReviewPr({ prNumber: 10, prUrl: "url/10", taskId: "W1-T10", headSha: "sha10", lastActivityAt: "2026-07-10T00:00:00Z" });
  const younger = postReviewPr({ prNumber: 20, prUrl: "url/20", taskId: "W1-T20", headSha: "sha20", lastActivityAt: "2026-07-15T00:00:00Z" });

  await runSweepLightPass([mergeable, fixable, older, younger], deps, DEFAULT_SWEEP_POLICY);

  assert.deepEqual(deps.armed.map((p) => p.prNumber), [40], "the mergeable PR still arms — the review-admission rule is a review-only lane");
  assert.deepEqual(deps.fixed.map((p) => p.prNumber), [41], "the blocked-fixable PR still dispatches a fix, in the SAME pass");
  assert.deepEqual(posted.sort((a, b) => a - b), [10, 20], "both post-review PRs use the two configured lanes while other dispositions still act");
});
