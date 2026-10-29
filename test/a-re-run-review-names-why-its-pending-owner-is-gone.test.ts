import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";

function fixture(t: TestContext, over: Partial<OpenPrView> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t9732-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const ledgerPath = join(dir, "ledger.ndjson");
  const pr: OpenPrView = {
    prNumber: 9732, prUrl: "https://github.com/o/r/pull/9732", taskId: "W1-T9732",
    headSha: "review-head", reviewInputDigest: "review-input", reviewState: "pending",
    checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: new Date(now - 15 * 60_000).toISOString(),
    reviewPendingSince: new Date(now - 15 * 60_000).toISOString(), ...over,
  };
  const posted: OpenPrView[] = [];
  const deps: SweepDeps = {
    ledgerPath, runId: "sweep-t9732", now: () => now,
    arm: () => assert.fail("pending review cannot arm"), close: () => assert.fail("unexpected close"),
    dispatchFix: () => assert.fail("unexpected fix"), escalate: () => assert.fail("unexpected escalation"),
    postReview: candidate => { posted.push(candidate); },
    reviewerCodeRecovery: { loadedCodeSha: "fresh-code", isLoadedCodeAtOrAfter: () => true, freshTreeReviewAvailable: true,
      probeFreshness: async () => ({ status: "fresh", codeSha: "fresh-code", originMainSha: "fresh-code", advance: "none" }) },
  };
  const seed = (over: Record<string, unknown>) => appendLedger(ledgerPath, {
    run_id: "prior-review", task_id: pr.taskId!, step: "review.post_refused",
    pr_url: pr.prUrl, head_sha: pr.headSha, review_input_digest: pr.reviewInputDigest,
    ts: new Date(now - 10 * 60_000).toISOString(), ...over,
  });
  const run = async () => {
    await runSweep([pr], deps, DEFAULT_SWEEP_POLICY);
    const row = readLedgerLines(ledgerPath).findLast(row => row.step === "sweep.disposed");
    assert.ok(row);
    return row;
  };
  return { pr, posted, seed, run, now };
}

test("W1-T9732: a refusal after the pending post is named, not owner proven dead", async t => {
  for (const freshness of ["stale", "unreadable"] as const) {
    const f = fixture(t);
    f.seed({ reviewer_code_freshness: freshness, origin_main_sha: "required-code",
      reason: `reviewer materially behind: ${freshness}` });
    const row = await f.run();
    assert.equal(row.disposition, "post-review");
    assert.equal(row.owner_gone_cause, "refused-after-pending");
    assert.match(String(row.reason), /the pending review's post was refused after it began/);
    assert.match(String(row.reason), new RegExp(`reviewer materially behind: ${freshness}`));
    assert.match(String(row.reason), /re-running the review lane on #9732$/);
    assert.doesNotMatch(String(row.reason), /owner proven dead/);
    assert.equal(f.posted.length, 1);
  }
});

test("W1-T9732: an incomplete promise harvest is named as its own cause", async t => {
  const f = fixture(t);
  f.seed({ step: "review.posted", state: "pending", decision_verdict: {
    state: "pending", criteria: [], promisedFollowUpObservation: {
      state: "unknown", cause: "promise-harvest-incomplete", reason: "promise harvest unavailable: AbortError",
    },
  } });
  const row = await f.run();
  assert.equal(row.disposition, "post-review");
  assert.equal(row.owner_gone_cause, "promise-harvest-incomplete");
  assert.match(String(row.reason), /its promise harvest did not complete/);
  assert.match(String(row.reason), /re-running the review lane on #9732$/);
  assert.doesNotMatch(String(row.reason), /owner proven dead/);
  assert.equal(f.posted.length, 1);
});

test("W1-T9732: a dead owner pid still reads owner proven dead", async t => {
  const f = fixture(t, { reviewPendingOwnerDead: true });
  const row = await f.run();
  assert.equal(row.disposition, "post-review");
  assert.equal(row.owner_gone_cause, "owner-pid-dead");
  assert.equal(row.reason, "checks green, remudero-review owner proven dead — re-running the review lane on #9732");
  assert.equal(f.posted.length, 1);
});

test("W1-T9732: refusal attribution preserves the current pending and exact-input guards", async t => {
  for (const control of ["older-refusal", "other-head", "other-input", "no-refusal"] as const) {
    const f = fixture(t);
    if (control !== "no-refusal") f.seed({ reviewer_code_freshness: "stale", origin_main_sha: "required-code",
      reason: "materially behind", ...(control === "older-refusal" ? { ts: new Date(f.now - 20 * 60_000).toISOString() }
        : control === "other-head" ? { head_sha: "other-head" } : { review_input_digest: "other-input" }) });
    const row = await f.run();
    assert.equal(row.disposition, "wait", control);
    assert.equal(Object.hasOwn(row, "owner_gone_cause"), false, control);
    assert.equal(f.posted.length, 0, control);
  }
});

test("W1-T9732: a refusal reason is bounded in the disposed row", async t => {
  const f = fixture(t);
  f.seed({ reviewer_code_freshness: "stale", origin_main_sha: "required-code", reason: `materially behind ${"x".repeat(2000)}` });
  const row = await f.run();
  assert.equal(row.owner_gone_cause, "refused-after-pending");
  assert.match(String(row.reason), /materially behind/);
  assert.ok(String(row.reason).length < 600);
});

test("W1-T9732: a completed host-gap refusal keeps its retry cause", async t => {
  const f = fixture(t);
  f.seed({ reviewer_code_freshness: "unreadable", reviewer_code_host_gap: "cwd-missing" });
  const row = await f.run();
  assert.equal(row.owner_gone_cause, "refused-after-pending");
  assert.match(String(row.reason), /the pending review's post was refused after it began/);
  assert.match(String(row.reason), /host gap: cwd-missing/);
  assert.match(String(row.reason), /re-running the review lane on #9732$/);
  assert.equal(f.posted.length, 1);
});

test("W1-T9732: a timed-out read refusal is a completed post, not a dead pid", async t => {
  const f = fixture(t);
  f.seed({ reason: "reservation unreadable", unknown_reservations: [
    { id: f.pr.taskId, reason: "base-unreadable: git cat-file timed out after 120000ms and was killed" },
  ] });
  const row = await f.run();
  assert.equal(row.owner_gone_cause, "refused-after-pending");
  assert.match(String(row.reason), /reservation read timed out/);
  assert.doesNotMatch(String(row.reason), /owner proven dead/);
  assert.equal(f.posted.length, 1);
});

test("W1-T9732: a legacy refusal without prose still names its freshness cause", async t => {
  const f = fixture(t);
  f.seed({ reviewer_code_freshness: "stale", origin_main_sha: "required-code" });
  const row = await f.run();
  assert.equal(row.owner_gone_cause, "refused-after-pending");
  assert.match(String(row.reason), /reviewer-code freshness stale/);
  assert.equal(f.posted.length, 1);
});
