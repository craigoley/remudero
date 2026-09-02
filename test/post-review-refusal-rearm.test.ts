// W1-T1213 — a REFUSED review attempt is filed in the same dedup set as a DELIVERED verdict, so a
// refusal that was correct for a condition since ended (the PR being closed) pins its head
// forever, and a green PR never earns a new head, so nothing in the system can ever clear it.
//
// `priorActionsFromLedger` (src/lib/sweep.ts) now keeps two SEPARATE dedup sets for the
// post-review lane instead of one shared `postReviewed` set: a DELIVERED-verdict set
// (`reviewDelivered`, fed by `review.posted`) and a REFUSED-attempt set (`reviewRefused`, fed by
// `review.post_refused`) — see `PriorActions.reviewDelivered`/`reviewRefused`'s own docs. The one
// refusal reason `decideReviewStatusPost` (src/lib/review.ts) writes for a NON-merged closed
// lifecycle ("PR is already closed — refusing to post remudero-review against a closed lifecycle
// (W1-T228 lifecycle rule)") is EXCLUDED from `reviewRefused` — reaching this dedup check at all
// already proves the PR is open again (every `OpenPrView` is built from `state=open`), so that
// specific refusal's own named condition has provably ended and it never enters the suppressing
// set in the first place. Every other refusal reason (including the "merged" sibling half of the
// SAME branch, which has no falsifier) keeps suppressing forever, exactly as before, no clock
// consulted anywhere in this module.
//
// These tests exercise the fold purely at the `runSweep` black-box level (POSTs and ledger rows
// in, dedup behaviour out), the SAME idiom `test/sweep.test.ts`'s own W1-T254 tests already use —
// `PriorActions`/`priorActionsFromLedger` are module-private and deliberately not exported.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";
import { appendLedger } from "../src/lib/ledger.js";

// ── fixtures ──────────────────────────────────────────────────────────────

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-post-review-refusal-rearm-")), "ledger.ndjson");
}

const NOW = Date.parse("2026-08-22T12:00:00Z");

/** The EXACT reason `decideReviewStatusPost` (src/lib/review.ts) writes for a NON-merged closed
 *  lifecycle — the one refusal class this task re-arms. Duplicated here deliberately, not
 *  imported: the fold under test matches this literal from a raw ledger line, exactly like a
 *  real refusal row would carry it; importing a helper would test the import, not the string. */
const CLOSED_LIFECYCLE_REFUSAL_REASON =
  "PR is already closed — refusing to post remudero-review against a closed lifecycle (W1-T228 lifecycle rule)";

/** The sibling "merged" half of the SAME `decideReviewStatusPost` branch — never re-armed (a
 *  merged PR has no GitHub transition back to `state=open`). */
const MERGED_LIFECYCLE_REFUSAL_REASON =
  "PR is already merged — refusing to post remudero-review against a closed lifecycle (W1-T228 lifecycle rule)";

function greenUngatedPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1213,
    prUrl: "https://github.com/o/r/pull/1213",
    taskId: "W1-T1213-SPECIMEN",
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-08-21T12:00:00Z",
    headSha: "cafefeed",
    autoMergeArmed: false,
    ...over,
  };
}

function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: overrides.ledgerPath ?? ledgerPath(),
    runId: "SWEEP-1213",
    now: () => NOW,
    ...overrides,
  };
}

// ── acceptance: a refused review attempt and a delivered verdict no longer share one dedup set ──

test("runSweep post-review dedup: a DELIVERED verdict and a REFUSED attempt are tracked independently — the specimen refusal (closed lifecycle, since reopened) re-arms its own head while a genuinely delivered verdict on a DIFFERENT head keeps suppressing exactly as before", async () => {
  const lp = ledgerPath();

  // Task A: a REAL, delivered verdict already sits on the ledger for this exact head.
  appendLedger(lp, { run_id: "SWEEP-0", task_id: "W1-T1213-A", step: "review.posted", head_sha: "aaaa111", state: "success" });
  // Task B: the specimen — a "PR is already closed" refusal recorded while the PR was
  // transiently closed (the shifted-clock incident, rationale (3)); it has since reopened, so
  // every OpenPrView this pass builds for it necessarily reads state=open.
  appendLedger(lp, {
    run_id: "SWEEP-0",
    task_id: "W1-T1213-B",
    step: "review.post_refused",
    head_sha: "bbbb222",
    attempted_state: "success",
    reason: CLOSED_LIFECYCLE_REFUSAL_REASON,
  });

  const calls: string[] = [];
  const deps = fakeDeps({
    ledgerPath: lp,
    postReview: (p) => {
      calls.push(p.taskId ?? "");
    },
  });

  await runSweep(
    [
      greenUngatedPr({ prNumber: 1, prUrl: "url/1", taskId: "W1-T1213-A", headSha: "aaaa111" }),
      greenUngatedPr({ prNumber: 2, prUrl: "url/2", taskId: "W1-T1213-B", headSha: "bbbb222" }),
    ],
    deps,
    DEFAULT_SWEEP_POLICY,
  );

  assert.deepEqual(
    calls,
    ["W1-T1213-B"],
    "task A's DELIVERED verdict keeps suppressing (acceptance 3); task B's stale closed-lifecycle " +
      "refusal no longer suppresses — the two facts were read off two independent sets, not one",
  );
});

test("runSweep post-review dedup resets on a body edit at the same head", async () => {
  const lp = ledgerPath();
  const prUrl = "https://github.com/o/r/pull/1213";
  appendLedger(lp, {
    run_id: "SWEEP-OLD-BODY",
    task_id: "W1-T1213",
    step: "review.posted",
    head_sha: "cafefeed",
    pr_url: prUrl,
    review_input_digest: "v1:old-body",
    state: "failure",
  });
  const calls: number[] = [];
  const deps = fakeDeps({
    ledgerPath: lp,
    postReview: (pr) => {
      calls.push(pr.prNumber);
    },
  });

  await runSweep(
    [greenUngatedPr({ taskId: "W1-T1213", prUrl, reviewInputDigest: "v1:corrected-body" })],
    deps,
    DEFAULT_SWEEP_POLICY,
  );
  assert.deepEqual(calls, [1213], "an old-body outcome cannot dedup the corrected body on the same commit");

  calls.length = 0;
  await runSweep(
    [greenUngatedPr({ taskId: "W1-T1213", prUrl, reviewInputDigest: "v1:old-body" })],
    deps,
    DEFAULT_SWEEP_POLICY,
  );
  assert.deepEqual(calls, [], "the unchanged exact input remains deduped");
});

// ── acceptance: a refusal whose named condition has provably ended stops suppressing its head ──

test("runSweep post-review dedup: a 'PR is already closed' refusal stops suppressing its head once the PR is read open again — no timer, the reopened OpenPrView is the falsifier", async () => {
  const lp = ledgerPath();
  appendLedger(lp, {
    run_id: "SWEEP-0",
    task_id: "W1-T1213",
    step: "review.post_refused",
    head_sha: "cafefeed",
    attempted_state: "success",
    reason: CLOSED_LIFECYCLE_REFUSAL_REASON,
  });

  const calls: string[] = [];
  const deps = fakeDeps({ ledgerPath: lp, postReview: (p) => { calls.push(p.taskId ?? ""); } });
  await runSweep([greenUngatedPr()], deps, DEFAULT_SWEEP_POLICY);

  assert.deepEqual(calls, ["W1-T1213-SPECIMEN"], "the head is offered to the post-review lane again");
});

test("runSweep post-review dedup: the sibling 'PR is already merged' refusal keeps suppressing forever — a merged PR has no path back to state=open, so it is never re-armed", async () => {
  const lp = ledgerPath();
  appendLedger(lp, {
    run_id: "SWEEP-0",
    task_id: "W1-T1213-SPECIMEN",
    step: "review.post_refused",
    head_sha: "cafefeed",
    attempted_state: "success",
    reason: MERGED_LIFECYCLE_REFUSAL_REASON,
  });

  const calls: string[] = [];
  const deps = fakeDeps({ ledgerPath: lp, postReview: (p) => { calls.push(p.taskId ?? ""); } });
  await runSweep([greenUngatedPr()], deps, DEFAULT_SWEEP_POLICY);

  assert.deepEqual(calls, [], "the merged-lifecycle refusal is not the re-armed class — it keeps deduping");
});

// ── acceptance: a head with a delivered verdict is still deduped exactly as today ──

test("runSweep post-review dedup: a DELIVERED verdict (review.posted) keeps suppressing its own head — unchanged from before this task", async () => {
  const lp = ledgerPath();
  appendLedger(lp, { run_id: "SWEEP-0", task_id: "W1-T1213-SPECIMEN", step: "review.posted", head_sha: "cafefeed", state: "success" });

  const calls: string[] = [];
  const deps = fakeDeps({ ledgerPath: lp, postReview: (p) => { calls.push(p.taskId ?? ""); } });
  await runSweep([greenUngatedPr()], deps, DEFAULT_SWEEP_POLICY);

  assert.deepEqual(calls, [], "a delivered verdict for this exact head must still dedup the post-review lane");
});

// ── acceptance: a refusal that is still live keeps suppressing its head and no clock is consulted ──

test("runSweep post-review dedup: an ordinary (non-lifecycle) refusal keeps suppressing its head across passes, with no staleness window or clock involved", async () => {
  const lp = ledgerPath();
  // A refusal reason that is NOT the closed-lifecycle string — e.g. the precedence refusal
  // decideReviewStatusPost also writes, or this module's own "attempt threw" refusal. Neither
  // names a condition that a reopened PR falsifies, so both must keep suppressing forever.
  appendLedger(lp, {
    run_id: "SWEEP-0",
    task_id: "W1-T1213-SPECIMEN",
    step: "review.post_refused",
    head_sha: "cafefeed",
    attempted_state: "failure",
    reason: "refusing to overwrite an executed-evidence success verdict for cafefee with a keyword-only/CAPPED verdict (W1-T228 precedence: evidence outranks its absence)",
  });

  // A `now` that jumps far into the future — proves no timer/staleness window governs this dedup.
  const calls1: string[] = [];
  const pass1 = fakeDeps({ ledgerPath: lp, now: () => NOW, postReview: (p) => { calls1.push(p.taskId ?? ""); } });
  await runSweep([greenUngatedPr()], pass1, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(calls1, [], "an ordinary refusal dedups immediately");

  const FAR_FUTURE = Date.parse("2030-01-01T00:00:00Z");
  const calls2: string[] = [];
  const pass2 = fakeDeps({ ledgerPath: lp, now: () => FAR_FUTURE, postReview: (p) => { calls2.push(p.taskId ?? ""); } });
  await runSweep([greenUngatedPr()], pass2, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(calls2, [], "the same refusal still dedups years later — nothing here reads a clock");
});

// ── acceptance: clearing the dedup posts no verdict and arms nothing ──

test("runSweep post-review dedup: re-arming a stale closed-lifecycle refusal only offers the head to the post-review lane again — it never posts a verdict itself and never arms the PR", async () => {
  const lp = ledgerPath();
  appendLedger(lp, {
    run_id: "SWEEP-0",
    task_id: "W1-T1213-SPECIMEN",
    step: "review.post_refused",
    head_sha: "cafefeed",
    attempted_state: "success",
    reason: CLOSED_LIFECYCLE_REFUSAL_REASON,
  });

  const armed: OpenPrView[] = [];
  // The injected `postReview` here is a bare recorder — it does NOT itself write a
  // `review.posted`/`review.post_refused` line, standing in for "the lane ran, but this test is
  // isolating what the DEDUP layer itself does, not what a real `decideReviewStatusPost` retest
  // would decide" (that retest is `review.ts`'s own concern — see design note (iii)).
  const calls: string[] = [];
  const deps = fakeDeps({
    ledgerPath: lp,
    arm: (p) => { armed.push(p); },
    postReview: (p) => { calls.push(p.taskId ?? ""); },
  });
  await runSweep([greenUngatedPr()], deps, DEFAULT_SWEEP_POLICY);

  assert.deepEqual(calls, ["W1-T1213-SPECIMEN"], "the head is re-offered to the post-review lane");
  assert.deepEqual(armed, [], "re-arming the DEDUP never arms the PR itself");
  const posted = readLedgerLines(lp).filter((l) => l.step === "review.posted");
  assert.deepEqual(posted, [], "re-arming the dedup never manufactures a review.posted verdict on its own");
});
