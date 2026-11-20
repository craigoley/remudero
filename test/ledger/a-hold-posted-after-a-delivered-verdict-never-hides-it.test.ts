/**
 * W1-T13949 — a cannot-evaluate hold posted AFTER a delivered verdict of the same head and input never hides that verdict.
 *
 * OBSERVED 2026-11-20 on #19691 (W1-T13785) and #19721 (W1-T13850): the lane review delivered a FAILURE (08:53:11Z on #19691),
 * then the still-running fix worker's in-round review posted a `review.posted` row of state pending with cannotEvaluate for the
 * same head and input (08:55:02Z). Every release path read that hold as the newest row: the restore refused ("not a full success
 * or failure"), the settle found no failure, and the dead-owner release refused because a failure exists. The sweep then
 * disposed "NO REVIEW STARTED: a verdict is already recorded delivered" on every pass for 3 h; no review and no fix round ran.
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
  DEFAULT_SWEEP_POLICY, REVIEW_STATUS_RESTORED_STEP, deliveredKeyReviewDecision, pendingViewSettledFromDeliveredFailure,
  readLiveLedgerRows, restorableDeliveredVerdict, runSweep, type OpenPrView, type ReviewDispatchMode, type SweepDeps,
} from "#src/lib/sweep.js";

const at = (clock: string): string => `2026-11-20T${clock}.000Z`;
const TASK = "W1-T13785";
const PR = 19691;
const HEAD = "2d022b85".padEnd(40, "c");
const DIGEST = "v2:2b715f6f";
const URL = `https://github.com/acme/scratch/pull/${PR}`;
const KEY = `input:${JSON.stringify([TASK, URL, HEAD, DIGEST])}`;
const UNMET = "a probe found public names the public record's digest";
const UNMET_VIEW = [{ claim: UNMET, proof: "grep: x in y", met: false, reason: "the proof printed no hit", proof_exec: "executed_fail" as const }];

function fixture(t: TestContext, view: Partial<OpenPrView> = {}) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13949-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  const now = Date.parse(at("11:47:00"));
  const pr: OpenPrView = {
    prNumber: PR, prUrl: URL, taskId: TASK, headSha: HEAD, headRefName: `run-${TASK}-1795095230170`, reviewInputDigest: DIGEST,
    reviewState: "pending", reviewPendingSince: at("08:54:52"), reviewPendingOwnerDead: true, checksState: "green", unmetCriteria: [],
    priorStrikes: 0, autoMergeArmed: false, lastActivityAt: at("08:55:02"), ...view,
  };
  const modes: ReviewDispatchMode[] = [];
  const fixes: OpenPrView[] = [];
  const row = (step: string, ts: string, runId: string, over: Record<string, unknown> = {}) => appendLedger(ledgerPath, {
    run_id: runId, task_id: TASK, step, ts, pr_url: URL, head_sha: HEAD, review_input_digest: DIGEST, ...over,
  });
  const seed = {
    failure: (ts: string) => row("review.posted", ts, `review-PR${PR}-1795164527950`, { state: "failure",
      unmet_criteria: [UNMET], reasons: ["the proof printed no hit"], failure_class: "criteria_unmet",
      decision_verdict: { state: "failure", summary: "remudero-review: FAIL — 2 of 4 criteria unmet", criteria: UNMET_VIEW } }),
    success: (ts: string) => row("review.posted", ts, `review-PR${PR}-1795164527950`, { state: "success", unmet_criteria: [], reasons: [],
      decision_verdict: { state: "success", summary: "remudero-review: PASS", criteria: [] } }),
    raw: (ts: string, over: Record<string, unknown>) => row("review.posted", ts, `review-PR${PR}-1795164600000`, over),
    restored: (regressionKey: string) => row(REVIEW_STATUS_RESTORED_STEP, at("11:46:00"), "restorer", { regression_key: regressionKey }),
    /** The fix worker's in-round review: a pending cannot-evaluate hold on the same head and input. */
    hold: (ts: string) => row("review.posted", ts, `work-fix-dispatch-${TASK}-1795160780513-6cd0`, { state: "pending", decision_verdict: {
      state: "pending", cannotEvaluate: true, summary: "remudero-review: cannot-evaluate — promise source unavailable",
      criteria: [{ claim: UNMET, proof: "grep: x in y", met: false, reason: "promise source unavailable", proof_exec: "cannot_evaluate" }],
    } }),
  };
  const deps: SweepDeps = {
    ledgerPath, runId: "sweep-t13949", now: () => now,
    arm: () => assert.fail("a head whose review status reads pending is never armed"),
    close: () => assert.fail("unexpected close"), escalate: () => assert.fail("unexpected escalation"),
    dispatchFix: (failed) => { fixes.push(failed); },
    postReview: (_pr, mode = { kind: "full-review" }) => {
      modes.push(mode);
      // The adapter's contract (W1-T11729): the restore row follows a status post that succeeded.
      if (mode.kind === "restore") row(REVIEW_STATUS_RESTORED_STEP, at("11:47:00"), "restorer", { regression_key: mode.regressionKey });
    },
    reviewerCodeRecovery: { loadedCodeSha: "fresh-code", isLoadedCodeAtOrAfter: () => true, freshTreeReviewAvailable: true,
      probeFreshness: async () => ({ status: "fresh", codeSha: "fresh-code", originMainSha: "fresh-code", advance: "none" }) },
  };
  const lines = () => readLiveLedgerRows(ledgerPath);
  const run = async () => {
    await runSweep([pr], deps, DEFAULT_SWEEP_POLICY);
    const disposed = lines().filter(r => r.step === "sweep.disposed").at(-1);
    assert.ok(disposed, "the pass disposed the pull request");
    return disposed;
  };
  return { pr, seed, modes, fixes, lines, run };
}

test("W1-T13949 criterion 1: a hold posted after a delivered failure is restored to the failure once, then the head reaches the fix lane", async t => {
  const f = fixture(t);
  f.seed.failure(at("08:53:11"));
  f.seed.hold(at("08:55:02"));
  const first = await f.run();
  assert.deepEqual(f.modes.map(m => m.kind), ["restore"], `the delivered failure is re-posted over the hold: ${JSON.stringify(first)}`);
  assert.equal(first.acted, true, JSON.stringify(first));
  const second = await f.run();
  assert.equal(second.disposition, "blocked-fixable", `the restore spent, the verdict settles the view: ${JSON.stringify(second)}`);
  assert.equal(second.review_view_settled, "restore-spent");
  assert.equal(f.fixes.length, 1, "the fix lane was dispatched");
  assert.deepEqual(f.fixes[0]?.unmetCriteria.map(c => c.claim), [UNMET]);
  assert.deepEqual(f.modes.map(m => m.kind), ["restore"], "no review of the judged input was started");
});

test("W1-T13949 criterion 2: the restore and the settle read the newest full verdict, never the hold after it", t => {
  const f = fixture(t);
  f.seed.failure(at("08:53:11"));
  f.seed.hold(at("08:55:02"));
  const restorable = restorableDeliveredVerdict(f.pr, f.lines(), KEY);
  assert.ok("row" in restorable, JSON.stringify(restorable));
  assert.equal(restorable.row.state, "failure");
  assert.equal(restorable.row.ts, at("08:53:11"));
  const decision = deliveredKeyReviewDecision(f.pr, true, f.lines(), KEY);
  assert.equal(decision.dedups, false);

  // The settle reads the same row: before the one restore it waits, and once that restore is spent it settles on the failure.
  const spent = fixture(t);
  spent.seed.failure(at("08:53:11"));
  spent.seed.hold(at("08:55:02"));
  assert.equal(pendingViewSettledFromDeliveredFailure(spent.pr, true, spent.lines(), KEY), undefined,
    "a pending stamped after the verdict keeps the one restore first");
  spent.seed.restored(`${KEY}|${spent.pr.reviewPendingSince}`);
  const settled = pendingViewSettledFromDeliveredFailure(spent.pr, true, spent.lines(), KEY);
  assert.ok(settled, "the spent restore settles the view on the delivered failure");
  assert.equal(settled.basis, "restore-spent");
  assert.equal(settled.deliveredAt, at("08:53:11"));
  assert.equal(settled.view.reviewState, "failure");
  assert.deepEqual(settled.view.unmetCriteria.map(c => c.claim), [UNMET]);

  // A hold posted with a terminal state, and a row whose state and verdict disagree, are not verdicts either: both are looked past.
  for (const [label, over] of [
    ["a terminal cannot-evaluate hold", { state: "failure", decision_verdict: { state: "failure", cannotEvaluate: true, criteria: [] } }],
    ["a row whose state and verdict disagree", { state: "success", decision_verdict: { state: "failure", criteria: [] } }],
  ] as const) {
    const later = fixture(t);
    later.seed.failure(at("08:53:11"));
    later.seed.raw(at("08:55:02"), over);
    const found = restorableDeliveredVerdict(later.pr, later.lines(), KEY);
    assert.ok("row" in found && found.row.ts === at("08:53:11"), `${label} never hides the failure: ${JSON.stringify(found)}`);
    later.seed.restored(`${KEY}|${later.pr.reviewPendingSince}`);
    assert.equal(pendingViewSettledFromDeliveredFailure(later.pr, true, later.lines(), KEY)?.deliveredAt, at("08:53:11"), label);
  }
});

test("W1-T13949 criterion 2: a plain pending row after the verdict is a review in flight, not a hold, so nothing older is restored over it", t => {
  // W1-T11847: a reviewer-code advance posts a plain pending row and admits ONE review of the same head and input. Restoring
  // the older verdict over it would re-post a verdict the running review is about to replace, and the sweep would admit again.
  const f = fixture(t);
  f.seed.failure(at("08:53:11"));
  f.seed.raw(at("08:55:02"), { state: "pending", decision_verdict: { state: "pending", criteria: [] } });
  assert.deepEqual(restorableDeliveredVerdict(f.pr, f.lines(), KEY), { refusal: "the delivered verdict is not a full success or failure" });
  f.seed.restored(`${KEY}|${f.pr.reviewPendingSince}`);
  assert.equal(pendingViewSettledFromDeliveredFailure(f.pr, true, f.lines(), KEY), undefined, "a review in flight is not settled");
});

test("W1-T13949 criterion 3: a hold after a delivered success restores the success; a hold with no full verdict before it keeps today's refusal", t => {
  const success = fixture(t);
  success.seed.success(at("08:53:11"));
  success.seed.hold(at("08:55:02"));
  const restorable = restorableDeliveredVerdict(success.pr, success.lines(), KEY);
  assert.ok("row" in restorable && restorable.row.state === "success", JSON.stringify(restorable));
  const terminalHold = fixture(t);
  terminalHold.seed.success(at("08:53:11"));
  terminalHold.seed.raw(at("08:55:02"), { state: "success", decision_verdict: { state: "success", cannotEvaluate: true, criteria: [] } });
  const pastTerminal = restorableDeliveredVerdict(terminalHold.pr, terminalHold.lines(), KEY);
  assert.ok("row" in pastTerminal && pastTerminal.row.ts === at("08:53:11"), `a terminal hold never hides the success: ${JSON.stringify(pastTerminal)}`);

  const holdOnly = fixture(t);
  holdOnly.seed.hold(at("08:55:02"));
  assert.deepEqual(restorableDeliveredVerdict(holdOnly.pr, holdOnly.lines(), KEY), { refusal: "the delivered verdict is not a full success or failure" });
  assert.equal(pendingViewSettledFromDeliveredFailure(holdOnly.pr, true, holdOnly.lines(), KEY), undefined, "a hold alone is not a verdict");
});
