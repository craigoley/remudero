/**
 * W1-T11929 — a delivered verdict whose status context reads pending is settled by re-posting the delivered state.
 * OBSERVED 2026-11-09: #17485 received a delivered FAIL at 21:12Z, then two stale-claim takeovers wrote pending over it at
 * 21:20 and 22:08. For the same input key the sweep then logged "a verdict was already DELIVERED" and "remudero-review
 * pending 106m (>= 60m ceiling) - re-running the review lane" with acted false, 18 times: the re-run was deduped because a
 * verdict existed, and the verdict was not re-posted because a pending row followed it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  DEFAULT_SWEEP_POLICY, REVIEW_SETTLED_STEP, REVIEW_STATUS_RESTORED_STEP, restorableDeliveredVerdict, runSweep,
  type OpenPrView, type ReviewDispatchMode, type SweepDeps,
} from "#src/lib/sweep.js";

const URL = "https://github.com/acme/scratch/pull/17485";
const TASK = "W1-T11768";
const HEAD = "2869d1f07962842f8be7bad5d411c50043b832dc";
const OTHER_HEAD = "38acaba8d3b03fa0042f8be7bad5d411c50043b8";
const DIGEST = "v2:f8d4";
const PENDING_SINCE = "2026-11-09T21:20:00.000Z";
const SUMMARY = "remudero-review: FAIL — 1 of 3 criteria unmet";
const REVIEW_KEY = `input:${JSON.stringify([TASK, URL, HEAD, DIGEST])}`;
const REGRESSION_KEY = `${REVIEW_KEY}|${PENDING_SINCE}`;

function fixture(t: TestContext, opts: { over?: Partial<OpenPrView>; postSucceeds?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t11929-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = Date.parse("2026-11-09T23:06:00Z"); // 106 minutes after the first takeover's pending
  const ledgerPath = join(dir, "ledger.ndjson");
  const pr: OpenPrView = {
    prNumber: 17485, prUrl: URL, taskId: TASK, headSha: HEAD, reviewInputDigest: DIGEST, reviewState: "pending",
    checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, reviewPendingOwnerDead: true,
    lastActivityAt: "2026-11-09T21:00:00Z", reviewPendingSince: PENDING_SINCE, ...opts.over,
  };
  const modes: ReviewDispatchMode[] = [];
  const deliver = (over: Record<string, unknown> = {}) => appendLedger(ledgerPath, {
    run_id: "review-fleet", task_id: TASK, step: "review.posted", ts: "2026-11-09T21:12:18.000Z", state: "failure", pr_url: URL,
    head_sha: HEAD, review_input_digest: DIGEST, decision_verdict: { state: "failure", summary: SUMMARY, criteria: [] }, ...over,
  });
  /** The two stale-claim takeovers: each wrote pending for the SAME head and input after the verdict. */
  const takeOver = () => {
    for (const ts of [PENDING_SINCE, "2026-11-09T22:08:00.000Z"]) appendLedger(ledgerPath, {
      run_id: `takeover-${ts}`, task_id: TASK, step: "review.pending_posted", ts, pr_url: URL, head_sha: HEAD, review_input_digest: DIGEST,
    });
  };
  const deps: SweepDeps = {
    ledgerPath, runId: "sweep-t11929", now: () => now,
    arm: () => undefined as never, close: () => assert.fail("unexpected close"),
    dispatchFix: () => assert.fail("unexpected fix"), escalate: () => assert.fail("unexpected escalation"),
    postReview: (_pr, mode = { kind: "full-review" }) => {
      modes.push(mode);
      if (mode.kind !== "restore" || opts.postSucceeds === false) return;
      // The adapter's contract (W1-T11729): it re-posts the delivered row's own state and description, and writes this
      // row only after that status post succeeded.
      const delivered = restorableDeliveredVerdict(pr, readLedgerLines(ledgerPath), REVIEW_KEY);
      assert.ok("row" in delivered, JSON.stringify(delivered));
      appendLedger(ledgerPath, { run_id: "restorer", task_id: TASK, step: REVIEW_STATUS_RESTORED_STEP, pr_url: URL, head_sha: HEAD,
        review_input_digest: DIGEST, regression_key: mode.regressionKey, old_state: "pending", new_state: delivered.row.state,
        delivered_state: delivered.row.state, delivered_run_id: delivered.row.run_id, delivered_at: delivered.row.ts });
    },
  };
  const run = async () => {
    await runSweep([pr], deps, DEFAULT_SWEEP_POLICY);
    const row = readLedgerLines(ledgerPath).findLast(r => r.step === "sweep.disposed");
    assert.ok(row);
    return row;
  };
  const rows = (step: string) => readLedgerLines(ledgerPath).filter(r => r.step === step);
  return { pr, modes, deliver, takeOver, run, rows, ledgerPath };
}

test("W1-T11929 criterion 1: a delivered failure under a takeover's pending status is re-posted and ledgered as settled", async t => {
  const f = fixture(t);
  f.deliver();
  f.takeOver();
  const row = await f.run();
  assert.deepEqual(f.modes, [{ kind: "restore", judgedHeadSha: HEAD, regressionKey: REGRESSION_KEY }], "the delivered state is re-posted, with no review");
  assert.equal(row.acted, true, String(row.stand_down_reason));
  assert.equal(f.rows("sweep.review_admitted").length, 0, "re-posting a delivered state admits no review");
  const settled = f.rows(REVIEW_SETTLED_STEP);
  assert.equal(settled.length, 1);
  assert.deepEqual(
    { run: settled[0]?.run_id, task: settled[0]?.task_id, pr: settled[0]?.pr_number, head: settled[0]?.head_sha, key: settled[0]?.review_key,
      digest: settled[0]?.review_input_digest, regression: settled[0]?.regression_key, from: settled[0]?.old_state, to: settled[0]?.settled_state,
      by: settled[0]?.delivered_run_id, at: settled[0]?.delivered_at },
    { run: "sweep-t11929", task: TASK, pr: 17485, head: HEAD, key: REVIEW_KEY, digest: DIGEST, regression: REGRESSION_KEY, from: "pending",
      to: "failure", by: "review-fleet", at: "2026-11-09T21:12:18.000Z" },
  );
});

test("W1-T11929 criterion 1: the verdict re-posted is the delivered row itself, so its state and description are the delivered ones", t => {
  const f = fixture(t);
  f.deliver();
  f.takeOver();
  // OBSERVED on the same head at 23:56Z: a thrown re-run left a refusal row after the verdict as well.
  appendLedger(f.ledgerPath, { run_id: "sweep-earlier", task_id: TASK, step: "review.post_refused", ts: "2026-11-09T22:30:00.000Z", pr_url: URL,
    head_sha: HEAD, review_input_digest: DIGEST, reason: "post-review attempt threw — standing down rather than retrying this head unbounded: boom" });
  const delivered = restorableDeliveredVerdict(f.pr, readLedgerLines(f.ledgerPath), REVIEW_KEY);
  assert.ok("row" in delivered, JSON.stringify(delivered));
  assert.equal(delivered.row.run_id, "review-fleet");
  assert.equal(delivered.row.state, "failure");
  assert.equal((delivered.row.decision_verdict as { summary: string }).summary, SUMMARY);
  assert.equal(delivered.regressionKey, REGRESSION_KEY);
});

test("W1-T11929 criterion 1: a re-post that did not reach the status writes no settled row", async t => {
  const f = fixture(t, { postSucceeds: false });
  f.deliver();
  f.takeOver();
  await f.run();
  assert.deepEqual(f.modes.map(m => m.kind), ["restore"]);
  assert.equal(f.rows(REVIEW_SETTLED_STEP).length, 0, "no restore row, so nothing was settled and the next pass retries");
});

test("W1-T11929 criterion 2: a pending status with no delivered verdict for its input is left to the review lane", async t => {
  const f = fixture(t);
  f.takeOver();
  assert.ok("refusal" in restorableDeliveredVerdict(f.pr, readLedgerLines(f.ledgerPath), REVIEW_KEY));
  await f.run();
  assert.deepEqual(f.modes.map(m => m.kind), ["full-review"]);
  assert.equal(f.rows(REVIEW_SETTLED_STEP).length, 0);
});

test("W1-T11929 criterion 2: a verdict delivered for another head is never re-posted on this one", async t => {
  const f = fixture(t);
  f.deliver({ head_sha: OTHER_HEAD });
  f.takeOver();
  assert.ok("refusal" in restorableDeliveredVerdict(f.pr, readLedgerLines(f.ledgerPath), REVIEW_KEY), "the other head's verdict is not this head's");
  await f.run();
  assert.deepEqual(f.modes.map(m => m.kind), ["full-review"]);
  assert.equal(f.rows(REVIEW_SETTLED_STEP).length, 0);
});

test("W1-T11929 criterion 3: a context that already reads the delivered state causes no post", async t => {
  for (const state of ["failure", "success"] as const) {
    const f = fixture(t, { over: { reviewState: state, reviewPendingSince: undefined, reviewPendingOwnerDead: undefined } });
    f.deliver({ state, decision_verdict: { state, summary: SUMMARY, criteria: [] } });
    const agreed = restorableDeliveredVerdict(f.pr, readLedgerLines(f.ledgerPath), REVIEW_KEY);
    assert.ok("refusal" in agreed, state);
    assert.match(agreed.refusal, /not pending/);
  }
  const f = fixture(t, { over: { reviewState: "success", reviewPendingSince: undefined, reviewPendingOwnerDead: undefined } });
  f.deliver({ state: "success", decision_verdict: { state: "success", summary: SUMMARY, criteria: [] } });
  await f.run();
  assert.deepEqual(f.modes, [], "the status agrees with the delivered verdict: nothing is posted");
  assert.equal(f.rows(REVIEW_SETTLED_STEP).length + f.rows(REVIEW_STATUS_RESTORED_STEP).length, 0);
});
