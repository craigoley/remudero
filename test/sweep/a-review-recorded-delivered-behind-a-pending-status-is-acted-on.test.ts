/**
 * W1-T12994 — a pull request whose review status reads pending while its review is recorded delivered is acted on.
 *
 * OBSERVED 2026-11-15 (the task record carries the ledger rows):
 * CASE A, #18689: a review ended as a pending cannot-evaluate hold ("reviewer unable: Could not read the PR body"). Its
 * owner process was dead, so every pass disposed "owner proven dead — re-running the review lane", and every claim
 * answered "a verdict was already DELIVERED". Seven passes, two hours, no review.
 * CASE B, #18701: a FAILURE was delivered, the view went on reading pending, and the head got re-posts and a dedup
 * instead of a fix round; an older freshness refusal still named the review "refused after it began".
 *
 * Every stamp below is aged only against the clock each fixture injects, never the wall clock.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendLedger } from "#src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  DEFAULT_SWEEP_POLICY, REVIEW_REQUEUED_STEP, REVIEW_RERUN_CONTRADICTION_STEP, REVIEW_STATUS_RESTORED_STEP, deliveredKeyReviewDecision,
  deriveDisposition, pendingHoldOwnerProvenDead, pendingViewSettledFromDeliveredFailure, readLiveLedgerRows, reviewNotStartedReason, runSweep,
  type OpenPrView, type ReviewDispatchMode, type SweepDeps,
} from "#src/lib/sweep.js";

/** A stamp on the day the two cases were observed. */
const at = (clock: string): string => `2026-11-15T${clock}.000Z`;

const UNMET = "the claim's action-time read does not dedup a pending hold";
const HOLD_SUMMARY = "remudero-review: cannot-evaluate — reviewer unable: Could not read the PR body";

interface Case { prNumber: number; task: string; head: string; digest: string; now: string }
const CASE_A: Case = { prNumber: 18689, task: "W1-T12527", head: "9332b814".padEnd(40, "a"), digest: "v2:a7047b50", now: at("18:39:18") };
const CASE_B: Case = { prNumber: 18701, task: "W1-T12231", head: "5dd7beb1".padEnd(40, "b"), digest: "v2:5dd7", now: at("18:14:25") };

function fixture(t: TestContext, c: Case, view: Partial<OpenPrView> = {}, opts: { onReview?: () => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12994-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  const prUrl = `https://github.com/acme/scratch/pull/${c.prNumber}`;
  const key = `input:${JSON.stringify([c.task, prUrl, c.head, c.digest])}`;
  const now = Date.parse(c.now);
  const pr: OpenPrView = {
    prNumber: c.prNumber, prUrl, taskId: c.task, headSha: c.head, headRefName: `run-${c.task}-1794790000000`, reviewInputDigest: c.digest,
    reviewState: "pending", checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: new Date(now - 3 * 3_600_000).toISOString(), ...view,
  };
  const modes: ReviewDispatchMode[] = [];
  const fixes: OpenPrView[] = [];
  const row = (step: string, ts: string, over: Record<string, unknown> = {}) => appendLedger(ledgerPath, {
    run_id: `review-PR${c.prNumber}-${ts}`, task_id: c.task, step, ts, pr_url: prUrl, head_sha: c.head, review_input_digest: c.digest, ...over,
  });
  const seed = {
    /** `review.post_refused` for reviewer code that is behind: a freshness refusal the sweep retries. */
    staleCodeRefusal: (ts: string) => row("review.post_refused", ts, { attempted_state: "success", reviewer_code_freshness: "stale",
      reviewer_code_sha: "cd1e5c686771", origin_main_sha: "required-code", reason: "reviewer code cd1e5c686771 is materially behind origin/main" }),
    hostGapRefusal: (ts: string) => row("review.post_refused", ts, { reviewer_code_freshness: "unreadable", reviewer_code_host_gap: "cwd-missing" }),
    timedOutReadRefusal: (ts: string) => row("review.post_refused", ts, { reason: "reservation unreadable",
      unknown_reservations: [{ id: c.task, reason: "base-unreadable: git cat-file timed out after 120000ms and was killed" }] }),
    pendingPosted: (ts: string) => row("review.pending_posted", ts, { owner_pid: 4242, owner_started_at: ts }),
    /** `review.posted` with state pending: a cannot-evaluate hold, never a verdict. */
    hold: (ts: string, over: Record<string, unknown> = {}) => row("review.posted", ts, { state: "pending", decision_verdict: {
      state: "pending", cannotEvaluate: true, summary: HOLD_SUMMARY,
      criteria: [{ claim: UNMET, proof: "grep: x in y", met: false, reason: "reviewer unable", proof_exec: "cannot_evaluate" }],
    }, ...over }),
    failure: (ts: string, over: Record<string, unknown> = {}) => row("review.posted", ts, { state: "failure",
      unmet_criteria: [UNMET], reasons: ["the proof printed no hit"], failure_class: "criteria_unmet",
      decision_verdict: { state: "failure", summary: "remudero-review: FAIL — 1 of 5 criteria unmet",
        criteria: [{ claim: UNMET, proof: "grep: x in y", met: false, reason: "the proof printed no hit", proof_exec: "executed_fail" }] },
      ...over }),
    success: (ts: string) => row("review.posted", ts, { state: "success", unmet_criteria: [], reasons: [],
      decision_verdict: { state: "success", summary: "remudero-review: PASS", criteria: [] } }),
    row,
  };
  const deps: SweepDeps = {
    ledgerPath, runId: "sweep-t12994", now: () => now,
    arm: () => assert.fail("a head whose review status reads pending is never armed"),
    close: () => assert.fail("unexpected close"), escalate: () => assert.fail("unexpected escalation"),
    dispatchFix: (failed) => { fixes.push(failed); },
    postReview: (_pr, mode = { kind: "full-review" }) => {
      modes.push(mode);
      // The adapter's contract (W1-T11729): the restore row follows a status post that succeeded.
      if (mode.kind === "restore") row(REVIEW_STATUS_RESTORED_STEP, c.now, { run_id: "restorer", regression_key: mode.regressionKey });
      else opts.onReview?.();
    },
    reviewerCodeRecovery: { loadedCodeSha: "fresh-code", isLoadedCodeAtOrAfter: () => true, freshTreeReviewAvailable: true,
      probeFreshness: async () => ({ status: "fresh", codeSha: "fresh-code", originMainSha: "fresh-code", advance: "none" }) },
  };
  const lines = () => readLiveLedgerRows(ledgerPath);
  const rows = (step: string) => lines().filter(r => r.step === step);
  const run = async (over: Partial<OpenPrView> = {}) => {
    await runSweep([{ ...pr, ...over }], deps, DEFAULT_SWEEP_POLICY);
    const disposed = rows("sweep.disposed").at(-1);
    assert.ok(disposed, "the pass disposed the pull request");
    return disposed;
  };
  return { pr, key, ledgerPath, now, deps, seed, modes, fixes, rows, run, lines };
}

/** Case A's ledger and view: refused, admitted again, pending, then a cannot-evaluate hold whose owner is dead. */
function caseA(t: TestContext, view: Partial<OpenPrView> = {}, opts: { onReview?: () => void } = {}) {
  const f = fixture(t, CASE_A, { reviewPendingSince: at("16:23:23"), reviewPendingOwnerDead: true, ...view }, opts);
  f.seed.staleCodeRefusal(at("16:19:36"));
  f.seed.pendingPosted(at("16:23:23"));
  f.seed.hold(at("16:28:35"));
  return f;
}

test("W1-T12994 criterion 1: a pending cannot-evaluate hold whose owner is proven dead is reviewed again, not deduped as delivered", async t => {
  const f = caseA(t);
  const disposed = await f.run();
  assert.deepEqual(f.modes, [{ kind: "full-review" }], `the claim admitted the review the walk decided: ${JSON.stringify(disposed)}`);
  assert.equal(disposed.disposition, "post-review");
  assert.equal(disposed.acted, true, JSON.stringify(disposed));
  assert.equal(disposed.deduped, undefined, JSON.stringify(disposed));
  assert.equal(disposed.owner_gone_cause, "owner-pid-dead");
  assert.equal(disposed.reason, "checks green, remudero-review owner proven dead — re-running the review lane on #18689");
  assert.equal(f.rows("sweep.review_admitted").length, 1, "one review was admitted for the input");
  assert.equal(f.rows(REVIEW_RERUN_CONTRADICTION_STEP).length, 0, "the walk and the claim agreed");
});

test("W1-T12994 criterion 1: the release reads the newest review.posted row of the exact head and input, and only a proven-dead owner", t => {
  const f = caseA(t);
  assert.equal(pendingHoldOwnerProvenDead(f.pr, f.lines()), true);
  assert.deepEqual(deliveredKeyReviewDecision(f.pr, false, f.lines(), f.key), { dedups: false }, "a released key runs");
  assert.equal(pendingHoldOwnerProvenDead({ ...f.pr, reviewPendingOwnerDead: undefined }, f.lines()), false, "an owner not proven dead keeps the hold");
  assert.equal(pendingHoldOwnerProvenDead({ ...f.pr, reviewPendingOwnerGone: "refused-after-pending" }, f.lines()), false, "a derived cause is not a dead process");
  assert.equal(pendingHoldOwnerProvenDead({ ...f.pr, reviewState: "none" }, f.lines()), false);
  assert.equal(pendingHoldOwnerProvenDead({ ...f.pr, headSha: "f".repeat(40) }, f.lines()), false, "another head's hold is not this head's");
  assert.equal(pendingHoldOwnerProvenDead({ ...f.pr, reviewInputDigest: "v2:other" }, f.lines()), false, "another input's hold is not this input's");
  assert.equal(pendingHoldOwnerProvenDead({ ...f.pr, reviewInputDigest: undefined }, f.lines()), false, "an unread input names no hold");
  // A terminal verdict recorded after the hold is the newest outcome: the key is a verdict again.
  f.seed.failure(at("16:40:00"));
  assert.equal(pendingHoldOwnerProvenDead(f.pr, f.lines()), false);
  // And a hold recorded AFTER a verdict of the same input releases nothing: that input was judged once already.
  const judged = fixture(t, CASE_A, { reviewPendingSince: at("16:23:23"), reviewPendingOwnerDead: true });
  judged.seed.failure(at("16:10:00"));
  judged.seed.hold(at("16:28:35"));
  assert.equal(pendingHoldOwnerProvenDead(judged.pr, judged.lines()), false);
  // W1-T11729's shape: a row of state success whose verdict could not evaluate is not a pending hold.
  const odd = fixture(t, CASE_A, { reviewPendingSince: at("16:23:23"), reviewPendingOwnerDead: true });
  odd.seed.row("review.posted", at("16:28:35"), { state: "success", decision_verdict: { state: "success", cannotEvaluate: true, criteria: [] } });
  assert.equal(pendingHoldOwnerProvenDead(odd.pr, odd.lines()), false);
});

test("W1-T12994 criterion 1: a delivered key dedups by one rule — not delivered runs, an agreeing status dedups, a pending status restores once", t => {
  const f = fixture(t, CASE_B, { reviewPendingSince: at("18:10:00"), reviewPendingOwnerDead: true });
  f.seed.success(at("18:06:56"));
  assert.deepEqual(deliveredKeyReviewDecision(f.pr, false, f.lines(), f.key), { dedups: false });
  assert.deepEqual(deliveredKeyReviewDecision({ ...f.pr, reviewState: "success" }, true, f.lines(), f.key), { dedups: true });
  assert.deepEqual(deliveredKeyReviewDecision({ ...f.pr, reviewState: "none" }, true, f.lines(), f.key), { dedups: true });
  const restore = deliveredKeyReviewDecision(f.pr, true, f.lines(), f.key);
  assert.equal(restore.dedups, false);
  assert.equal("restore" in restore && restore.restore?.regressionKey, `${f.key}|${at("18:10:00")}`);
  f.seed.row(REVIEW_STATUS_RESTORED_STEP, at("18:12:00"), { regression_key: `${f.key}|${at("18:10:00")}` });
  assert.deepEqual(deliveredKeyReviewDecision(f.pr, true, f.lines(), f.key), { dedups: true }, "a spent restore dedups: no review of a delivered verdict");
});

/** Case B's ledger: refused for stale reviewer code, reviewed again, and a FAILURE delivered. */
function caseB(t: TestContext, view: Partial<OpenPrView> = {}) {
  const f = fixture(t, CASE_B, { reviewPendingSince: at("18:04:58"), ...view });
  f.seed.staleCodeRefusal(at("17:36:36"));
  f.seed.pendingPosted(at("18:04:58"));
  f.seed.failure(at("18:06:56"));
  return f;
}

/** The view the producer builds once GitHub's status reads the delivered failure. */
function failedView(f: ReturnType<typeof fixture>): OpenPrView {
  return { ...f.pr, reviewState: "failure", reviewPendingSince: undefined, reviewPendingOwnerDead: undefined,
    unmetCriteria: [{ claim: UNMET, proof: "grep: x in y", met: false, reason: "the proof printed no hit", proof_exec: "executed_fail" }] };
}

test("W1-T12994 criterion 2: a delivered failure settles a view that still reads pending — it takes a failed review's disposition and no review starts", async t => {
  const f = caseB(t);
  const failed = deriveDisposition(failedView(f), DEFAULT_SWEEP_POLICY, f.now);
  assert.equal(failed.disposition, "blocked-fixable", "what a failed review with an unmet criterion takes on a fleet pull request");
  const disposed = await f.run();
  assert.equal(disposed.disposition, failed.disposition, JSON.stringify(disposed));
  assert.equal(disposed.blocker, "review-failed", JSON.stringify(disposed));
  assert.equal(disposed.acted, true, JSON.stringify(disposed));
  assert.match(String(disposed.reason), /^1 unmet criterion — /);
  assert.equal(disposed.review_view_settled, "verdict-after-pending");
  assert.equal(disposed.review_view_settled_at, at("18:06:56"));
  assert.equal(f.fixes.length, 1, "the fix lane was dispatched");
  assert.equal(f.fixes[0]?.reviewState, "failure");
  assert.deepEqual(f.fixes[0]?.unmetCriteria.map(c => [c.claim, c.met, c.reason, c.proof_exec]), [[UNMET, false, "the proof printed no hit", "executed_fail"]]);
  assert.deepEqual(f.modes, [], "no review and no re-post was started for the input");
  assert.equal(f.rows("sweep.review_admitted").length, 0);
});

test("W1-T12994 criterion 2: a takeover's pending over a delivered failure is re-posted once, then settled from the verdict", async t => {
  // W1-T11929's shape: the pending claim is NEWER than the verdict, so GitHub may really read pending.
  const f = fixture(t, CASE_B, { reviewPendingSince: at("18:10:00"), reviewPendingOwnerDead: true });
  f.seed.failure(at("18:06:56"));
  f.seed.pendingPosted(at("18:10:00"));
  const first = await f.run();
  assert.deepEqual(f.modes.map(m => m.kind), ["restore"], "the delivered state is re-posted first, as W1-T11729 decided");
  assert.equal(first.disposition, "post-review");
  assert.equal(f.fixes.length, 0);
  const second = await f.run();
  assert.equal(second.disposition, "blocked-fixable", `the view still reads pending after its restore: ${JSON.stringify(second)}`);
  assert.equal(second.review_view_settled, "restore-spent");
  assert.equal(f.fixes.length, 1);
  assert.deepEqual(f.modes.map(m => m.kind), ["restore"], "nothing further was posted or reviewed");
});

test("W1-T12994 criterion 2: only a delivered full failure with unmet criteria settles, and only when no newer pending claim stands", t => {
  const f = caseB(t);
  const settled = pendingViewSettledFromDeliveredFailure(f.pr, true, f.lines(), f.key);
  assert.equal(settled?.basis, "verdict-after-pending");
  assert.equal(settled?.view.reviewState, "failure");
  assert.equal(settled?.view.reviewSummary, "remudero-review: FAIL — 1 of 5 criteria unmet");
  assert.equal(settled?.view.reviewPendingSince, undefined);
  assert.equal(pendingViewSettledFromDeliveredFailure(f.pr, false, f.lines(), f.key), undefined, "a released key is no standing verdict");
  assert.equal(pendingViewSettledFromDeliveredFailure({ ...f.pr, reviewState: "none" }, true, f.lines(), f.key), undefined);
  assert.equal(pendingViewSettledFromDeliveredFailure({ ...f.pr, headSha: "f".repeat(40) }, true, f.lines(), f.key), undefined);
  assert.equal(pendingViewSettledFromDeliveredFailure({ ...f.pr, reviewInputDigest: "v2:other" }, true, f.lines(), f.key), undefined);
  assert.equal(pendingViewSettledFromDeliveredFailure({ ...f.pr, reviewPendingSince: at("18:10:00") }, true, f.lines(), f.key), undefined,
    "a pending claim newer than the verdict may be a live review: left to the restore and the wait");
  assert.equal(pendingViewSettledFromDeliveredFailure({ ...f.pr, reviewPendingSince: undefined }, true, f.lines(), f.key), undefined,
    "an undated pending proves nothing about order");
  const success = fixture(t, CASE_B, { reviewPendingSince: at("18:04:58") });
  success.seed.success(at("18:06:56"));
  assert.equal(pendingViewSettledFromDeliveredFailure(success.pr, true, success.lines(), success.key), undefined,
    "a success needs GitHub's status to merge: it keeps the restore");
  const noCriteria = fixture(t, CASE_B, { reviewPendingSince: at("18:04:58") });
  noCriteria.seed.failure(at("18:06:56"), { unmet_criteria: [] });
  assert.equal(pendingViewSettledFromDeliveredFailure(noCriteria.pr, true, noCriteria.lines(), noCriteria.key), undefined,
    "a failure with no unmet criterion on its row is routed by fields only the view producer reads");
  const entangled = fixture(t, CASE_B, { reviewPendingSince: at("18:04:58") });
  entangled.seed.failure(at("18:06:56"), { failure_class: "instrument_entangled", instrument_entangled: true });
  assert.equal(pendingViewSettledFromDeliveredFailure(entangled.pr, true, entangled.lines(), entangled.key), undefined);
  const hold = caseA(t);
  assert.equal(pendingViewSettledFromDeliveredFailure(hold.pr, true, hold.lines(), hold.key), undefined, "a hold is not a verdict");
});

test("W1-T12994 criterion 2: a failure a re-review request released is not settled", async t => {
  const f = caseB(t);
  f.seed.row(REVIEW_REQUEUED_STEP, at("18:08:00"), { review_key: f.key });
  const disposed = await f.run({ reviewPendingSince: at("18:09:00") });
  assert.equal(disposed.disposition, "wait", `the requested review is in flight: ${JSON.stringify(disposed)}`);
  assert.equal(f.fixes.length, 0);
});

for (const kind of ["staleCodeRefusal", "hostGapRefusal", "timedOutReadRefusal"] as const) {
  test(`W1-T12994 criterion 3: a ${kind} stops marking the pending review refused once a later verdict is recorded for the input`, async t => {
    // Control: with no later verdict the refusal after the pending post is the completed outcome (W1-T9732).
    const control = fixture(t, CASE_B, { reviewPendingSince: at("17:30:00") });
    control.seed.pendingPosted(at("17:30:00"));
    control.seed[kind](at("17:36:36"));
    const refused = await control.run();
    assert.equal(refused.owner_gone_cause, "refused-after-pending", JSON.stringify(refused));
    assert.match(String(refused.reason), /the pending review's post was refused after it began/);

    const f = fixture(t, CASE_B, { reviewPendingSince: at("17:30:00") });
    f.seed.pendingPosted(at("17:30:00"));
    f.seed[kind](at("17:36:36"));
    f.seed.success(at("18:06:56"));
    const disposed = await f.run();
    assert.equal(Object.hasOwn(disposed, "owner_gone_cause"), false, JSON.stringify(disposed));
    assert.doesNotMatch(String(disposed.reason), /refused after it began/);
    assert.equal(disposed.disposition, "wait", "a pending status 44 minutes old with no proven-gone owner is waited on");
    assert.deepEqual(f.modes, [], "nothing was re-run or re-posted on the strength of the older refusal");
  });
}

test("W1-T12994 criterion 3: a refusal recorded after the verdict still counts, and a hold is a recorded outcome too", async t => {
  const later = fixture(t, CASE_B, { reviewPendingSince: at("17:30:00") });
  later.seed.pendingPosted(at("17:30:00"));
  later.seed.success(at("17:33:00"));
  later.seed.staleCodeRefusal(at("17:36:36"));
  const refused = await later.run();
  assert.equal(refused.owner_gone_cause, "refused-after-pending", "the newest fact about the review is its refusal");

  const held = fixture(t, CASE_B, { reviewPendingSince: at("17:30:00") });
  held.seed.pendingPosted(at("17:30:00"));
  held.seed.staleCodeRefusal(at("17:36:36"));
  held.seed.hold(at("17:50:00"));
  const disposed = await held.run();
  assert.equal(Object.hasOwn(disposed, "owner_gone_cause"), false, JSON.stringify(disposed));
  assert.equal(disposed.disposition, "wait");
});

test("W1-T12994 criterion 3: case B's failure is not re-run as refused after it began — it reaches the fix lane", async t => {
  // The view dates its pending from before the refusal, the reading the live rows showed at 18:14:25Z.
  const f = fixture(t, CASE_B, { reviewPendingSince: at("17:30:00") });
  f.seed.pendingPosted(at("17:30:00"));
  f.seed.staleCodeRefusal(at("17:36:36"));
  f.seed.failure(at("18:06:56"));
  const disposed = await f.run();
  assert.doesNotMatch(String(disposed.reason), /refused after it began|re-running the review lane/);
  assert.equal(disposed.disposition, "blocked-fixable", JSON.stringify(disposed));
  assert.equal(f.fixes.length, 1);
  assert.deepEqual(f.modes, []);
});

test("W1-T12994 criterion 4: a review the disposition asked for and the delivered key refused writes one named row, and the reason says no review started", async t => {
  // A delivered success under a pending status: restored once (W1-T11729), then the same regression dedups.
  const f = fixture(t, CASE_B, { reviewPendingSince: at("18:10:00"), reviewPendingOwnerDead: true });
  f.seed.success(at("18:06:56"));
  f.seed.pendingPosted(at("18:10:00"));
  await f.run();
  assert.deepEqual(f.modes.map(m => m.kind), ["restore"]);
  assert.equal(f.rows(REVIEW_RERUN_CONTRADICTION_STEP).length, 0, "a restore is the walk's decision carried out");

  const second = await f.run();
  assert.equal(second.disposition, "post-review");
  assert.equal(second.acted, false);
  assert.equal(second.deduped, true);
  assert.match(String(second.stand_down_reason), /already DELIVERED/);
  assert.doesNotMatch(String(second.reason), /re-running|running the review lane/, "the text no longer says a review is being re-run");
  assert.equal(second.reason,
    "checks green, remudero-review owner proven dead — would re-run the review lane on #18701 — NO REVIEW STARTED this pass: " +
    "a verdict is already recorded delivered for this head and input");
  const named = f.rows(REVIEW_RERUN_CONTRADICTION_STEP);
  assert.equal(named.length, 1, "the first such pass writes the row");
  assert.deepEqual(
    { pr: named[0]?.pr_number, head: named[0]?.head_sha, key: named[0]?.review_key, disposition: named[0]?.disposition,
      at: named[0]?.decided_at, cause: named[0]?.dedup_cause, said: named[0]?.disposition_reason },
    { pr: 18701, head: CASE_B.head, key: f.key, disposition: "post-review", at: "walk", cause: "delivered",
      said: "checks green, remudero-review owner proven dead — re-running the review lane on #18701" },
  );
  assert.match(String(named[0]?.dedup_reason), /a verdict was already DELIVERED for input:/);

  const third = await f.run();
  assert.equal(f.rows(REVIEW_RERUN_CONTRADICTION_STEP).length, 1, "later passes of the same head, input and cause write no second row");
  assert.equal(third.reason, second.reason);
  assert.deepEqual(f.modes.map(m => m.kind), ["restore"], "and no review ever started");
});

test("W1-T12994 criterion 4: a claim that refuses what the walk decided writes the same row from its action-time read", async t => {
  const f = fixture(t, CASE_A, { reviewState: "none", reviewOrphanedByPush: true });
  const other: OpenPrView = { ...failedView(f), prNumber: 18702, prUrl: "https://github.com/acme/scratch/pull/18702", taskId: "W1-T12232",
    headSha: "c".repeat(40), headRefName: "run-W1-T12232-1794790000000" };
  // Another pass delivers the verdict between this pass's walk and its claim: the walk's fix dispatch stands in for it.
  f.deps.dispatchFix = () => { f.seed.success(at("18:39:00")); };
  await runSweep([f.pr, other], f.deps, DEFAULT_SWEEP_POLICY);
  const disposed = f.rows("sweep.disposed").find(r => r.pr_number === 18689);
  assert.ok(disposed);
  assert.equal(disposed.acted, false, JSON.stringify(disposed));
  assert.equal(disposed.deduped, true);
  assert.match(String(disposed.stand_down_reason), /already DELIVERED .* the action-time re-read deduped the re-post/);
  assert.equal(disposed.reason,
    "checks green, review orphaned by a push (reviewed on an earlier head, silent on this one) — would re-run the review lane on #18689 — " +
    "NO REVIEW STARTED this pass: a verdict is already recorded delivered for this head and input");
  const named = f.rows(REVIEW_RERUN_CONTRADICTION_STEP);
  assert.equal(named.length, 1);
  assert.equal(named[0]?.decided_at, "claim");
  assert.equal(named[0]?.dedup_cause, "delivered");
  assert.equal(named[0]?.review_key, f.key);
  assert.deepEqual(f.modes, [], "the claim refused: no review ran");
  // The next pass reads the verdict in its own snapshot, so the walk's arm dedups it as it always has under a status that
  // does not read pending (W1-T2427: that dedup writes its disposed row and no other step).
  await runSweep([f.pr], f.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(f.rows("sweep.disposed").filter(r => r.pr_number === 18689).at(-1)?.deduped, true);
  assert.equal(f.rows(REVIEW_RERUN_CONTRADICTION_STEP).length, 1);
});

test("W1-T12994 criterion 4: the reason names each dedup cause and leaves a reason that promised no review untouched but for the cause", () => {
  assert.equal(reviewNotStartedReason("checks green, review never posted — running the review lane on #7", "refused"),
    "checks green, review never posted — would run the review lane on #7 — NO REVIEW STARTED this pass: a review post was already refused for this head and input");
  assert.match(reviewNotStartedReason("x — re-running the authoritative reviewer on #7 before auto-merge", "backoff"),
    /would re-run the authoritative reviewer on #7 before auto-merge — NO REVIEW STARTED this pass: the review retry is inside its backoff$/);
  assert.match(reviewNotStartedReason("re-reviewing the unchanged head once", "claimed"), /^re-reviewing the unchanged head once — NO REVIEW STARTED this pass: a review of this head and input is already claimed$/);
});

test("W1-T12994 criterion 5: invariant:one-review-per-input — a fresh pending status with a live owner is never taken over or reviewed again", async t => {
  // The hold is on the ledger, but a newer claim is pending and its owner is not proven dead.
  const live = caseA(t, { reviewPendingSince: at("18:30:00"), reviewPendingOwnerDead: undefined });
  live.seed.pendingPosted(at("18:30:00"));
  const waiting = await live.run();
  assert.equal(waiting.disposition, "wait", JSON.stringify(waiting));
  assert.match(String(waiting.reason), /a review is already in flight, waiting/);
  assert.deepEqual(live.modes, []);
  assert.equal(live.rows("sweep.review_admitted").length, 0);

  // A pending status past its ceiling whose owner is NOT proven dead: the hold keeps its dedup, and the row says so.
  const stale = caseA(t, { reviewPendingOwnerDead: undefined });
  const kept = await stale.run();
  assert.equal(kept.disposition, "post-review");
  assert.equal(kept.acted, false, JSON.stringify(kept));
  assert.equal(kept.deduped, true);
  assert.deepEqual(stale.modes, [], "no proof the owner is dead, so no review");
  assert.equal(stale.rows(REVIEW_RERUN_CONTRADICTION_STEP).length, 1);

  // The re-run a dead owner earned is ONE review: once it has claimed the status, its fresh pending is waited on.
  const rerun = caseA(t, {}, { onReview: () => rerun.seed.pendingPosted(CASE_A.now) });
  await rerun.run();
  assert.deepEqual(rerun.modes, [{ kind: "full-review" }]);
  const after = await rerun.run({ reviewPendingSince: CASE_A.now, reviewPendingOwnerDead: undefined });
  assert.equal(after.disposition, "wait", JSON.stringify(after));
  assert.deepEqual(rerun.modes, [{ kind: "full-review" }], "the review in flight is not reviewed again");
  assert.equal(rerun.rows("sweep.review_admitted").length, 1);
});

test("W1-T12994 criterion 5: invariant:one-review-per-input — a head and input with a delivered terminal verdict is never reviewed a second time", async t => {
  for (const state of ["failure", "success"] as const) {
    for (const ownerDead of [true, undefined]) {
      // Pending claimed before the verdict (a stale read), and after it (a takeover): four passes of each.
      for (const pendingSince of [at("16:00:00"), at("17:00:00")]) {
        const f = fixture(t, CASE_A, { reviewPendingSince: pendingSince, reviewPendingOwnerDead: ownerDead });
        f.seed.pendingPosted(at("16:00:00"));
        f.seed[state](at("16:30:00"));
        if (pendingSince === at("17:00:00")) f.seed.pendingPosted(pendingSince);
        for (let pass = 0; pass < 4; pass++) await f.run();
        const label = JSON.stringify({ state, ownerDead, pendingSince, modes: f.modes });
        assert.equal(f.modes.some(m => m.kind !== "restore"), false, `no review of a delivered verdict: ${label}`);
        assert.ok(f.modes.length <= 1, `at most one re-post of the delivered state per regression: ${label}`);
        assert.equal(f.rows("sweep.review_admitted").length, 0, label);
      }
    }
  }
});
