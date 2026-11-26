// W1-T14872 — an orphaned review claim is released a bounded time after its reviewer's last heartbeat; a claim whose
// reviewer still beats is never released, however old (invariant live-claim-waits).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import {
  postReviewPending, reviewClaimHeartbeat, reviewHeartbeat, reviewHeartbeatSilenceBoundMs, reviewInputDigest,
  REVIEW_CLAIM_SETTLING_STEPS, REVIEW_ENGINE_REVISION, REVIEW_HEARTBEAT_SILENCE_FLOOR_MS, REVIEW_HEARTBEAT_STEP,
  REVIEWER_CHECKOUT_VANISHED_REASON, watchReviewerCheckout,
} from "#src/lib/review.js";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, reviewHeartbeatView, type OpenPrView } from "#src/lib/sweep.js";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const HEAD = "abc1234";
const PR_URL = "https://github.com/o/r/pull/14872";

/** `runs` completed reviews at other heads, each beating every `gapMinutes` four times and then posting a terminal verdict. */
function completedReviews(runs: number, gapMinutes: number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let r = 0; r < runs; r++) {
    const head = `done${r}`;
    for (let b = 0; b < 4; b++) {
      rows.push({ ts: ago(600 - r * 20 - b * gapMinutes), step: REVIEW_HEARTBEAT_STEP, run_id: `done-${r}`, head_sha: head, phase: "judge" });
    }
    rows.push({ ts: ago(600 - r * 20 - 4 * gapMinutes), step: "review.stood_down", run_id: `done-${r}`, head_sha: head });
  }
  return rows;
}

function pendingPr(pendingMinutes: number): OpenPrView {
  return {
    prNumber: 14872, prUrl: PR_URL, taskId: "W1-T14872", reviewState: "pending", checksState: "green", unmetCriteria: [],
    priorStrikes: 0, lastActivityAt: ago(pendingMinutes), headSha: HEAD, autoMergeArmed: false,
    reviewPendingSince: ago(pendingMinutes), reviewPendingOwnerRunId: "claim-run",
  };
}

const beat = (minutes: number): Record<string, unknown> =>
  ({ ts: ago(minutes), step: REVIEW_HEARTBEAT_STEP, run_id: "claim-run", head_sha: HEAD, phase: "judge" });

test("W1-T14872 a silent heartbeat releases the claim before the ceiling", () => {
  const pr = pendingPr(20);
  const lines = [...completedReviews(10, 1), beat(15)];
  assert.equal(deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW).disposition, "wait",
    "control: a 20-minute claim with no heartbeat read waits for the 60-minute ceiling");
  const view = reviewHeartbeatView(pr, lines, NOW);
  assert.equal(view.reviewPendingHeartbeat, "silent", "15 minutes of silence is past the 5-minute measured bound");
  const decided = deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(decided.disposition, "post-review", "the orphaned claim is re-run before the ceiling");
  assert.match(decided.reason, /heartbeat is silent/);
});

test("W1-T14872 a fresh heartbeat holds the claim past the ceiling", () => {
  const pr = pendingPr(90);
  assert.equal(deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review",
    "control: a 90-minute claim with no heartbeat read is past the 60-minute ceiling");
  const view = reviewHeartbeatView(pr, [...completedReviews(10, 1), beat(1)], NOW);
  assert.equal(view.reviewPendingHeartbeat, "fresh");
  assert.equal(deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW).disposition, "wait",
    "invariant live-claim-waits: a reviewer that beat a minute ago keeps its claim");
});

test("W1-T14872 a fresh heartbeat holds the claim lock past its TTL, and a silent one releases it early", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-heartbeat-claim-"));
  try {
    const digest = reviewInputDigest(HEAD, "acceptance body");
    const claim = (minutes: number) => ({ ts: ago(minutes), step: "review.pending_posted", run_id: "claim-run", task_id: "W1-T14872",
      head_sha: HEAD, pr_url: PR_URL, review_input_digest: digest, owner_pid: 4242 });
    const attempt = async (rows: Record<string, unknown>[]) => {
      // The claim reader reads the live ledger beside `ledgerPath`, so each attempt gets its own state dir.
      const ledgerPath = join(mkdtempSync(join(dir, "state-")), "ledger.ndjson");
      writeFileSync(ledgerPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      const posts: Array<{ description?: string }> = [];
      const result = await postReviewPending({
        owner: "o", repo: "r", sha: HEAD, taskId: "W1-T14872", runId: "new-run", ledgerPath, prUrl: PR_URL,
        reviewInputDigest: digest, reviewEngineRevision: REVIEW_ENGINE_REVISION, ownerIdentity: { pid: 1, startedAt: ago(0) },
        clock: fixedClock(NOW), assessPendingOwner: () => "active",
        fetchLifecycle: () => ({ merged: false, closed: false }), fetchStatus: () => ({ statuses: [] }),
        post: (o: { description?: string }) => { posts.push(o); },
      });
      return { result, posts };
    };
    const held = await attempt([...completedReviews(10, 1), claim(50), beat(1)]);
    assert.equal(held.result.posted, false, "a 50-minute claim (past the 42-minute TTL) whose reviewer beat a minute ago holds");
    assert.match(held.result.reason ?? "", /already pending/);
    const taken = await attempt([...completedReviews(10, 1), claim(10), beat(8)]);
    assert.equal(taken.result.posted, true, "a 10-minute claim whose reviewer is 8 minutes silent is taken over");
    assert.match(taken.posts.at(-1)?.description ?? "", /heartbeat was silent/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T14872 the silence bound comes from measured gaps with a five minute floor", () => {
  assert.equal(reviewHeartbeatSilenceBoundMs(completedReviews(10, 4)), 8 * 60_000, "p99 of 4-minute gaps, times two");
  assert.equal(reviewHeartbeatSilenceBoundMs(completedReviews(10, 1)), REVIEW_HEARTBEAT_SILENCE_FLOOR_MS,
    "1-minute gaps would give 2 minutes; the floor is 5");
  assert.equal(REVIEW_HEARTBEAT_SILENCE_FLOOR_MS, 5 * 60_000);
  const unsettled = completedReviews(10, 4).filter((row) => row.step !== "review.stood_down");
  assert.equal(reviewHeartbeatSilenceBoundMs(unsettled), undefined, "gaps of runs that never settled are not measured");
  assert.equal(reviewHeartbeatSilenceBoundMs(completedReviews(6, 4)), undefined, "18 gaps are too few to size a bound");
  assert.equal(reviewClaimHeartbeat(completedReviews(6, 4), "done-0", "done0", NOW), undefined,
    "with no measurable bound the claim keeps the pending ceiling");
});

test("W1-T14872 a vanished reviewer checkout writes a terminal row", async () => {
  let present = true;
  const vanished: string[] = [];
  const stop = watchReviewerCheckout("/review/checkout", () => { vanished.push("gone"); }, 5, () => present);
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(vanished, [], "a present checkout is left alone");
    present = false;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(vanished, ["gone"], "the first missing poll fires once, and only once");
  } finally {
    stop();
  }
  assert.equal(REVIEWER_CHECKOUT_VANISHED_REASON, "reviewer-checkout-vanished");
  assert.ok(REVIEW_CLAIM_SETTLING_STEPS.has("review.stood_down"), "the stand-down row settles the run's claim");
});

test("W1-T14872 the heartbeat writes on each phase change and at most once a minute per phase", () => {
  const rows: Record<string, unknown>[] = [];
  let now = NOW;
  const beatOnce = reviewHeartbeat((row) => rows.push(row), () => now, { runId: "r", prUrl: PR_URL, headSha: HEAD });
  assert.equal(beatOnce("claimed"), true);
  assert.equal(beatOnce("judge"), true, "a phase change always writes");
  now += 30_000;
  assert.equal(beatOnce("judge"), false, "streamed output within the minute writes nothing");
  now += 31_000;
  assert.equal(beatOnce("judge"), true);
  assert.deepEqual(rows.map((row) => [row.step, row.phase]),
    [[REVIEW_HEARTBEAT_STEP, "claimed"], [REVIEW_HEARTBEAT_STEP, "judge"], [REVIEW_HEARTBEAT_STEP, "judge"]]);
});
