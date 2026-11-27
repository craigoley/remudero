// W1-T14872 — an orphaned review claim is released a bounded time after its reviewer's last heartbeat; a claim whose
// reviewer still beats is never released, however old (invariant live-claim-waits).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import * as reviewCommand from "#src/cli/commands/review.js";
import { fixedClock } from "#src/lib/clock.js";
import {
  postReviewPending, reviewClaimHeartbeat, reviewHeartbeat, reviewHeartbeatSilenceBoundMs, reviewInputDigest,
  REVIEW_CLAIM_SETTLING_STEPS, REVIEW_ENGINE_REVISION, REVIEW_HEARTBEAT_SILENCE_FLOOR_MS, REVIEW_HEARTBEAT_STEP,
  REVIEWER_CHECKOUT_VANISHED_REASON, watchReviewerCheckout,
} from "#src/lib/review.js";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, reviewHeartbeatView, type OpenPrView } from "#src/lib/sweep.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

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

test("W1-T14872 the checkout watch fires once when the checkout disappears", async () => {
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
  const beatOnce = reviewHeartbeat((row) => rows.push(row), () => now, { runId: "r", headSha: HEAD });
  assert.equal(beatOnce("claimed"), true);
  assert.equal(beatOnce("judge"), true, "a phase change always writes");
  now += 30_000;
  assert.equal(beatOnce("judge"), false, "streamed output within the minute writes nothing");
  now += 31_000;
  assert.equal(beatOnce("judge"), true);
  assert.deepEqual(rows.map((row) => [row.step, row.phase]),
    [[REVIEW_HEARTBEAT_STEP, "claimed"], [REVIEW_HEARTBEAT_STEP, "judge"], [REVIEW_HEARTBEAT_STEP, "judge"]]);
});

// ── Through reviewCommand: the real claim path, then the real runReview ─────────────────────────

function fixtureHost(head: string): reviewCommand.ReviewCommandHost {
  const unrelated = (): never => { throw new Error("unexpected unrelated orchestration port"); };
  return {
    GIT_UNTRACKED_FILES_ALL: "--untracked-files=all", JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
    acceptedReviewAttemptId: (value) => typeof value === "string" ? value : undefined,
    attributeWorkerStreamEvent: (event) => event as never, ledgeredNonDispatchSpawn: unrelated, lintPlanForReview: unrelated,
    liveWorkerRunIds: new Set(), materializeReviewWorktree: unrelated, readHeadShaRest: () => head, readMainPlanTreeSha: unrelated,
    realDeps: () => ({ reviewWorktree: { fetch: unrelated } }) as unknown as ReturnType<reviewCommand.ReviewCommandHost["realDeps"]>,
    reviewPostedDescription: (verdict) => verdict.summary, reviewWorkerLockId: (runId) => runId,
    reviewerClockBoundMs: (override) => override!, reviewSubjectGit: unrelated,
  };
}

function signalEnded(): WorkerResult {
  return {
    sessionId: "vanished-checkout", costUsd: 0, numTurns: 1, text: "", blocks: [], stderr: "", subtype: "error_exit_null",
    isError: true, apiError: false, exit: { kind: "signal", signal: "SIGTERM" }, permissionDenials: [], childEnvKeys: [],
    model: "sonnet", provider: "claude", effort: "high", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

/** Runs `rmd review` on a one-commit fixture PR with the real claim path and the real runReview; `vanish` makes the reviewer
 *  delete its checkout and wait for the abort. Returns the ledger rows. */
async function reviewThroughCommand(t: TestContext, vanish: boolean): Promise<Record<string, unknown>[]> {
  const fixture = gitRepo({ scope: t, kind: "heartbeat-review-command" });
  const root = fixture.dir;
  writeFileSync(join(root, "changed.ts"), "export const changed = true;\n");
  fixture.git("add", "changed.ts");
  fixture.git("commit", "-qm", "changed");
  const head = fixture.git("rev-parse", "HEAD");
  const prUrl = "https://github.com/acme/remudero/pull/1";
  const view = { number: 1, state: "open", merged_at: null, body: "## Acceptance\n- changed exists | grep: changed in changed.ts\n",
    html_url: prUrl, head: { ref: "topic", sha: head } };
  const shim = ghShim([
    { when: "pulls/1/reviews", stdout: "[]" },
    { when: "pulls/1", stdout: JSON.stringify(view) },
    { when: "pr diff", stdout: "diff --git a/changed.ts b/changed.ts\n+++ b/changed.ts\n@@ -0,0 +1 @@\n+export const changed = true;\n" },
    { when: "pr view", stdout: '{"state":"OPEN"}' },
    { when: "/status", stdout: '{"statuses":[]}' },
    { when: "api ", stdout: "{}" },
  ], { kind: "heartbeat-review-command" });
  const host = fixtureHost(head);
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath ?? ""}`;
  try {
    await reviewCommand.reviewCommand(host, "1", ["--repo", "acme/remudero"], {
      resolveOwnerRepo: () => ({ owner: "acme", repo: "remudero" }),
      fetchView: () => view,
      loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/unused" }) as never,
      fetchHead: () => {},
      executionMode: vanish ? "semantic" : "deterministic",
      materialize: () => ({ worktreePath: root }),
      withMaterialized: async (_path, _repo, run) => run(),
      buildBaseProof: () => ({ baseCheckoutDir: undefined, baseUnreadablePaths: new Set(), baseIsCheckout: false, addedTestFiles: new Set() }),
      reviewerCodeFreshness: () => ({ status: "fresh", codeSha: head, originMainSha: head, advance: "none" }),
      readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
      runReview: (args) => reviewCommand.runReview(host, {
        ...args, headCheckoutDir: root, readReviewReuseFacts: () => undefined, requireSemanticReview: false,
        spawnReviewer: vanish, reviewerCheckoutPollMs: 10,
        reviewerMount: { model: "sonnet", effort: "high", maxTurns: 10, contextBudget: 120_000 }, reviewerClockBoundMs: 120_000,
        reviewerSpawnWorker: async (spawnArgs) => {
          rmSync(spawnArgs.cwd, { recursive: true, force: true });
          await new Promise<void>((resolve) => {
            if (spawnArgs.signal?.aborted) return resolve();
            spawnArgs.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return signalEnded();
        },
        disarm: () => "not-armed", arm: () => "hold-refused",
      }),
    });
  } finally {
    process.env.PATH = previousPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("W1-T14872 the review command beats a heartbeat for the claim its own reviewCommand posted", async (t) => {
  const rows = await reviewThroughCommand(t, false);
  const claim = rows.find((row) => row.step === "review.pending_posted");
  assert.ok(claim, "reviewCommand posted the claim");
  const beats = rows.filter((row) => row.step === REVIEW_HEARTBEAT_STEP && row.run_id === claim.run_id);
  assert.ok(beats.length > 0, "runReview's own claim is a same-run no-op, and the run still beats for the claim it holds");
  assert.ok(beats.every((row) => row.head_sha === claim.head_sha));
});

test("W1-T14872 a vanished reviewer checkout writes a terminal row", async (t) => {
  const rows = await reviewThroughCommand(t, true);
  const stoodDown = rows.find((row) => row.step === "review.stood_down" && row.reason === REVIEWER_CHECKOUT_VANISHED_REASON);
  assert.ok(stoodDown, `the run stands down on the vanished checkout:\n${rows.map((row) => row.step).join("\n")}`);
  assert.ok(REVIEW_CLAIM_SETTLING_STEPS.has(String(stoodDown.step)), "the stand-down row settles the run's claim");
  assert.equal(rows.some((row) => row.step === "review.posted" && (row.state === "success" || row.state === "failure")), false,
    "no verdict is posted from a review whose checkout vanished");
});

test("W1-T14872 a settled run's claim is not judged by its heartbeat", () => {
  const lines = [...completedReviews(10, 1), beat(15), { ts: ago(14), step: "review.stood_down", run_id: "claim-run", head_sha: HEAD }];
  assert.equal(reviewClaimHeartbeat(lines, "claim-run", HEAD, NOW), undefined, "a run that settled holds no claim to orphan");
  assert.equal(reviewClaimHeartbeat([...completedReviews(10, 1), beat(15)], "claim-run", HEAD, NOW)?.state, "silent",
    "positive control: the same silence with no settling row is an orphaned claim");
});
