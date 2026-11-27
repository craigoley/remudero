// W1-T14872 — an orphaned review claim is released a bounded time after its reviewer's last heartbeat; a claim whose
// reviewer still beats is never released, however old (invariant live-claim-waits).
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import * as reviewCommand from "#src/cli/commands/review.js";
import { fixedClock } from "#src/lib/clock.js";
import { rotateLedger } from "#src/lib/ledger.js";
import {
  postReviewPending, reviewClaimHeartbeat, reviewClaimLedgerRows, reviewHeartbeat, reviewHeartbeatSilenceBoundMs, reviewInputDigest,
  REVIEW_CLAIM_SETTLING_STEPS, REVIEW_CONTEXT, REVIEW_ENGINE_REVISION, REVIEW_HEARTBEAT_SILENCE_FLOOR_MS, REVIEW_HEARTBEAT_STEP,
  REVIEWER_CHECKOUT_VANISHED_REASON, watchReviewerCheckout,
} from "#src/lib/review.js";
import {
  DEFAULT_SWEEP_POLICY, deriveDisposition, observeLightPassReviewEligibility, readLiveLedgerRows, reviewHeartbeatView,
  type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { writeLedger, type LedgerFixture } from "#test/helpers/ledger-fixture.js";
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

function rotate(fixture: LedgerFixture): void {
  fixture.append([{ ts: ago(0), step: "fixture.noise", padding: "x".repeat(1024) }]);
  const rotation = rotateLedger(fixture.path, { ceilingBytes: 1024, smoothingWindowMs: 0, now: () => new Date(NOW) });
  assert.equal(rotation.rotated, true);
  assert.ok(rotation.archivePath, "the real rotator archived the input");
  assert.equal(readLiveLedgerRows(fixture.path).some(row => row.step === REVIEW_HEARTBEAT_STEP), false,
    "control: no heartbeat survived in the live file");
}

function eligible(pr: OpenPrView, path: string): boolean {
  const rows: Array<Record<string, unknown>> = [];
  observeLightPassReviewEligibility([pr], {
    ledgerPath: path, runId: "sweep-test", now: () => NOW,
    appendLine: (_path, row) => { rows.push(row); },
  } as SweepDeps);
  return rows.some(row => row.step === "sweep.review_eligible" && row.pr_number === pr.prNumber);
}

test("W1-T14872 a silent heartbeat releases the claim before the ceiling", (t) => {
  const pr = pendingPr(20);
  assert.equal(deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW).disposition, "wait",
    "control: a 20-minute claim with no heartbeat read waits for the 60-minute ceiling");
  const fixture = writeLedger([...completedReviews(10, 1), beat(15),
    { ...beat(1), head_sha: "another-head" }, { ...beat(1), run_id: "another-run" }], { scope: t });
  rotate(fixture);
  const { path } = fixture;
  const view = reviewHeartbeatView(pr, readLiveLedgerRows(path), NOW, path);
  assert.equal(view.reviewPendingHeartbeat, "silent", "15 minutes of silence is past the 5-minute measured bound");
  const decided = deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(decided.disposition, "post-review", "the orphaned claim is re-run before the ceiling");
  assert.match(decided.reason, /heartbeat is silent/);
  assert.equal(eligible(pr, path), true, "the light pass admits the claim after rotation");
});

test("W1-T14872 a fresh heartbeat holds the claim past the ceiling", (t) => {
  const pr = pendingPr(90);
  assert.equal(deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review",
    "control: a 90-minute claim with no heartbeat read is past the 60-minute ceiling");
  const fixture = writeLedger([...completedReviews(10, 1), beat(12)], { scope: t });
  rotate(fixture);
  assert.equal(eligible(pr, fixture.path), true, "control: the prior archived beat is silent");
  fixture.append([beat(1)]);
  rotate(fixture);
  const view = reviewHeartbeatView(pr, readLiveLedgerRows(fixture.path), NOW, fixture.path);
  assert.equal(view.reviewPendingHeartbeat, "fresh");
  assert.equal(deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW).disposition, "wait",
    "invariant live-claim-waits: a reviewer that beat a minute ago keeps its claim");
  assert.equal(eligible(pr, fixture.path), false, "the light pass still waits after a second rotation");
  assert.equal(deriveDisposition({ ...view, reviewPendingOwnerDead: true }, DEFAULT_SWEEP_POLICY, NOW).disposition, "wait",
    "a fresh beat supersedes the view's older assessment of the pending owner");
});

test("W1-T14872 a fresh heartbeat holds the claim lock past its TTL, and a silent one releases it early", async (t) => {
  const digest = reviewInputDigest(HEAD, "acceptance body");
  const claim = (minutes: number) => ({ ts: ago(minutes), step: "review.pending_posted", run_id: "claim-run", task_id: "W1-T14872",
    head_sha: HEAD, pr_url: PR_URL, review_input_digest: digest, owner_pid: 4242 });
  const attempt = async (rows: Record<string, unknown>[], age: number, shared = false) => {
    const fixture = writeLedger(rows, { scope: t });
    rotate(fixture);
    const { path: ledgerPath } = fixture;
    assert.equal(readLiveLedgerRows(ledgerPath).some(row => row.step === "review.pending_posted"),
      rows.some(row => row.step === "review.pending_posted"), "control: the local claim row itself survives this cut");
    const posts: Array<{ description?: string }> = [];
    const result = await postReviewPending({
      owner: "o", repo: "r", sha: HEAD, taskId: "W1-T14872", runId: "new-run", ledgerPath, prUrl: PR_URL,
      reviewInputDigest: digest, reviewEngineRevision: REVIEW_ENGINE_REVISION, ownerIdentity: { pid: 1, startedAt: ago(0) },
      clock: fixedClock(NOW), assessPendingOwner: () => "active",
      fetchLifecycle: () => ({ merged: false, closed: false }),
      fetchStatus: () => ({ statuses: shared ? [{ context: REVIEW_CONTEXT, state: "pending", created_at: ago(age),
        description: "pending (owned by run claim-run)" }] : [] }),
      post: (o: { description?: string }) => { posts.push(o); },
    });
    return { result, posts };
  };
  const held = await attempt([...completedReviews(10, 1), claim(50), beat(1)], 50);
  assert.equal(held.result.posted, false, "a 50-minute claim (past the 42-minute TTL) whose reviewer beat a minute ago holds");
  assert.match(held.result.reason ?? "", /already pending/);
  const remoteHeld = await attempt([...completedReviews(10, 1), beat(1)], 50, true);
  assert.equal(remoteHeld.result.heldByRun, "claim-run", "the shared status writer's heartbeat is found without a local claim row");
  const taken = await attempt([...completedReviews(10, 1), claim(10), beat(8)], 10, true);
  assert.equal(taken.result.posted, true, "a 10-minute claim whose reviewer is 8 minutes silent is taken over");
  assert.match(taken.posts.at(-1)?.description ?? "", /heartbeat was silent/);
  const vanished = { ...claim(1), step: "review.stood_down", reason: REVIEWER_CHECKOUT_VANISHED_REASON };
  const reClaimed = await attempt([claim(2), beat(1), vanished], 2, true);
  assert.equal(reClaimed.result.posted, true, "an archived stand-down makes the still-pending shared status reclaimable");
  assert.match(reClaimed.posts.at(-1)?.description ?? "", /checkout vanished/);
});

test("W1-T14872 the silence bound comes from measured gaps with a five minute floor", (t) => {
  const archive = (rows: Record<string, unknown>[], replay: Record<string, unknown>[] = []) => {
    const fixture = writeLedger(rows, { scope: t });
    rotate(fixture);
    fixture.append(replay);
    return reviewClaimLedgerRows(fixture.path, readLiveLedgerRows(fixture.path));
  };
  const longGaps = completedReviews(10, 4);
  const terminal = longGaps.filter(row => row.step === "review.stood_down")
    .map(row => ({ ...row, step: "review.posted", state: "success" }));
  const unsettled = longGaps.filter(row => row.step === REVIEW_HEARTBEAT_STEP);
  assert.equal(reviewHeartbeatSilenceBoundMs(archive(unsettled, terminal)), 8 * 60_000,
    "p99 of 4-minute gaps, times two, including runs that settled after rotation");
  assert.equal(reviewHeartbeatSilenceBoundMs(archive(completedReviews(10, 1))), REVIEW_HEARTBEAT_SILENCE_FLOOR_MS,
    "1-minute gaps would give 2 minutes; the floor is 5");
  assert.equal(REVIEW_HEARTBEAT_SILENCE_FLOOR_MS, 5 * 60_000);
  assert.equal(reviewHeartbeatSilenceBoundMs(archive(unsettled)), undefined, "gaps of runs that never settled are not measured");
  const tooFew = completedReviews(6, 4);
  assert.equal(reviewHeartbeatSilenceBoundMs(archive(tooFew, tooFew)), undefined, "18 distinct gaps are too few, even with replayed rows");
  assert.equal(reviewClaimHeartbeat(completedReviews(6, 4), "done-0", "done0", NOW), undefined,
    "with no measurable bound the claim keeps the pending ceiling");
  assert.equal(reviewClaimHeartbeat(archive([beat(1)]), "claim-run", HEAD, NOW)?.state, "fresh",
    "even without enough completed reviews, a beat inside the floor holds the claim");
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
  await withGhShim([
    { when: "pulls/1/reviews", stdout: "[]" },
    { when: "pulls/1", stdout: JSON.stringify(view) },
    { when: "pr diff", stdout: "diff --git a/changed.ts b/changed.ts\n+++ b/changed.ts\n@@ -0,0 +1 @@\n+export const changed = true;\n" },
    { when: "pr view", stdout: '{"state":"OPEN"}' },
    { when: "/status", stdout: '{"statuses":[]}' },
    { when: "/actions/workflows/", stdout: "{}", delaySeconds: 0.4 },
    { when: "api ", stdout: "{}" },
  ], async (shim) => {
    const host = fixtureHost(head);
    const path = join(root, "state", "ledger.ndjson");
    await reviewCommand.reviewCommand(host, "1", ["--repo", "acme/remudero"], {
      resolveOwnerRepo: () => ({ owner: "acme", repo: "remudero" }),
      fetchView: () => view,
      loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/unused" }) as never,
      fetchHead: () => {},
      executionMode: vanish ? "semantic" : "deterministic",
      materialize: () => {
        const rows = readLiveLedgerRows(path);
        const claim = rows.find(row => row.step === "review.pending_posted");
        assert.ok(claim);
        assert.ok(rows.some(row => row.step === REVIEW_HEARTBEAT_STEP && row.run_id === claim.run_id &&
          row.head_sha === head && row.pr_number === 1 && row.phase === "materialize"), "the claim starts beating before materialization");
        return { worktreePath: root };
      },
      withMaterialized: async (_path, _repo, run) => run(),
      buildBaseProof: () => ({ baseCheckoutDir: undefined, baseUnreadablePaths: new Set(), baseIsCheckout: false, addedTestFiles: new Set() }),
      reviewerCodeFreshness: () => ({ status: "fresh", codeSha: head, originMainSha: head, advance: "none" }),
      readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
      runReview: async (args) => {
        let allowRead!: () => void;
        const canRead = new Promise<void>(resolve => { allowRead = resolve; });
        let proofRead: ReturnType<typeof reviewCommand.readProofDiscriminationRecord> | undefined;
        try {
          const verdict = await reviewCommand.runReview(host, {
            ...args, headCheckoutDir: root, readReviewReuseFacts: () => undefined, requireSemanticReview: false,
            spawnReviewer: vanish, reviewerCheckoutPollMs: 10,
            reviewerMount: { model: "sonnet", effort: "high", maxTurns: 10, contextBudget: 120_000 }, reviewerClockBoundMs: 120_000,
            readProofRecord: vanish ? (target) => {
              proofRead = canRead.then(() => reviewCommand.readProofDiscriminationRecord(target));
              return proofRead;
            } : undefined,
            log: (step, fields) => {
              args.log(step, fields);
              if (step === "review.stood_down" && fields?.reason === REVIEWER_CHECKOUT_VANISHED_REASON) allowRead();
            },
            reviewerSpawnWorker: async (spawnArgs) => {
              rmSync(spawnArgs.cwd, { recursive: true, force: true });
              await new Promise<void>((resolve) => {
                if (spawnArgs.signal?.aborted) return resolve();
                spawnArgs.signal?.addEventListener("abort", () => resolve(), { once: true });
              });
              return signalEnded();
            },
            disarm: () => "not-armed", arm: () => "hold-refused",
          });
          const events = shim.events().filter(event => event.args.some(arg => arg.includes("/actions/workflows/")));
          assert.deepEqual(events.map(event => event.phase), ["start", "end"],
            "runReview waits for its proof-discrimination child before releasing the caller's shim");
          return verdict;
        } finally {
          allowRead();
          await Promise.allSettled(proofRead === undefined ? [] : [proofRead]);
        }
      },
    });
  }, { kind: "heartbeat-review-command" });
  return [...readLiveLedgerRows(join(root, "state", "ledger.ndjson"))];
}

test("W1-T14872 the review command beats a heartbeat for the claim its own reviewCommand posted", async (t) => {
  const rows = await reviewThroughCommand(t, false);
  const claim = rows.find((row) => row.step === "review.pending_posted");
  assert.ok(claim, "reviewCommand posted the claim");
  const beats = rows.filter((row) => row.step === REVIEW_HEARTBEAT_STEP && row.run_id === claim.run_id);
  assert.ok(beats.length > 0, "runReview's own claim is a same-run no-op, and the run still beats for the claim it holds");
  assert.ok(beats.every((row) => row.head_sha === claim.head_sha));
  assert.ok(beats.every((row) => row.pr_number === 1));
});

test("W1-T14872 a vanished reviewer checkout writes a terminal row", async (t) => {
  const rows = await reviewThroughCommand(t, true);
  const stoodDown = rows.find((row) => row.step === "review.stood_down" && row.reason === REVIEWER_CHECKOUT_VANISHED_REASON);
  assert.ok(stoodDown, `the run stands down on the vanished checkout:\n${rows.map((row) => row.step).join("\n")}`);
  assert.ok(REVIEW_CLAIM_SETTLING_STEPS.has(String(stoodDown.step)), "the stand-down row settles the run's claim");
  assert.equal(rows.some((row) => row.step === "review.posted" && (row.state === "success" || row.state === "failure")), false,
    "no verdict is posted from a review whose checkout vanished");
  const fixture = writeLedger(rows, { scope: t });
  rotate(fixture);
  const pr = { ...pendingPr(1), prNumber: 1, prUrl: String(stoodDown.pr_url), taskId: String(stoodDown.task_id),
    headSha: String(stoodDown.head_sha), reviewPendingOwnerRunId: String(stoodDown.run_id) };
  assert.equal(eligible(pr, fixture.path), true, "the sweep can re-run the vanished review immediately after rotation");
});

test("W1-T14872 a settled run's claim is not judged by its heartbeat", () => {
  const lines = [...completedReviews(10, 1), beat(15), { ts: ago(14), step: "review.stood_down", run_id: "claim-run", head_sha: HEAD }];
  assert.equal(reviewClaimHeartbeat(lines, "claim-run", HEAD, NOW), undefined, "a run that settled holds no claim to orphan");
  assert.equal(reviewClaimHeartbeat([...completedReviews(10, 1), beat(15)], "claim-run", HEAD, NOW)?.state, "silent",
    "positive control: the same silence with no settling row is an orphaned claim");
});
