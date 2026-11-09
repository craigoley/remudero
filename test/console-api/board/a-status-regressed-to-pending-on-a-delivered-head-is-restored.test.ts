/**
 * W1-T11729 — a delivered verdict whose GitHub status regressed to pending on the SAME head and input is restored from the
 * ledger, never re-reviewed and never deduped silently. OBSERVED 2026-11-08: #17354 sat `pending` for hours while the
 * action-time claim answered "already DELIVERED" to every re-run the disposition asked for.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendLedger } from "#src/lib/ledger.js";
import { judgeReview, type ReviewVerdict } from "#src/lib/review.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { buildSweepEffects as commandEffects, type SweepCommandHost } from "#src/cli/commands/sweep.js";
import { readLedgerLines } from "#src/lib/status.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import {
  DEFAULT_SWEEP_POLICY, REVIEW_STATUS_RESTORED_STEP, runSweep, type OpenPrView, type ReviewDispatchMode, type SweepDeps,
} from "#src/lib/sweep.js";

const URL = "https://github.com/acme/scratch/pull/17354";
const HEAD = "d552219678ee21fc500aa2ed9c6799f5179db58b";
const DIGEST = "v2:7e94";
const PENDING_SINCE = "2026-11-08T12:43:17.000Z";
const CRITERION = { claim: "W1-T11729 the status is restored", proof: "grep: W1-T11729 in src/x.ts" };
const DIFF = "diff --git a/src/x.ts b/src/x.ts\n+W1-T11729\n";
const REGRESSION_KEY = `input:${JSON.stringify(["W1-T11596", URL, HEAD, DIGEST])}|${PENDING_SINCE}`;

function verdict(): ReviewVerdict {
  return judgeReview([CRITERION], { diff: DIFF, report: "W1-T11729 the status is restored.", headCheckoutDir: "/head", execProof: () => "pass" });
}

function sweepFixture(t: TestContext, over: Partial<OpenPrView> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t11729-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = Date.parse("2026-11-08T13:30:00Z");
  const ledgerPath = join(dir, "ledger.ndjson");
  const pr: OpenPrView = {
    prNumber: 17354, prUrl: URL, taskId: "W1-T11596", headSha: HEAD, reviewInputDigest: DIGEST, reviewState: "pending",
    checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, reviewPendingOwnerDead: true,
    lastActivityAt: "2026-11-08T12:00:00Z", reviewPendingSince: PENDING_SINCE, ...over,
  };
  const modes: ReviewDispatchMode[] = [];
  const deps: SweepDeps = {
    ledgerPath, runId: "sweep-t11729", now: () => now,
    arm: () => assert.fail("pending review cannot arm"), close: () => assert.fail("unexpected close"),
    dispatchFix: () => assert.fail("unexpected fix"), escalate: () => assert.fail("unexpected escalation"),
    postReview: (_pr, mode = { kind: "full-review" }) => {
      modes.push(mode);
      // The adapter's contract: the restore row follows a SUCCESSFUL status post.
      if (mode.kind === "restore") appendLedger(ledgerPath, { run_id: "restorer", task_id: "W1-T11596", step: REVIEW_STATUS_RESTORED_STEP,
        pr_url: URL, head_sha: HEAD, review_input_digest: DIGEST, regression_key: mode.regressionKey });
    },
  };
  const deliver = (over2: Record<string, unknown> = {}) => appendLedger(ledgerPath, {
    run_id: "review-original", task_id: "W1-T11596", step: "review.posted", state: "success", pr_url: URL, head_sha: HEAD,
    review_input_digest: DIGEST, decision_verdict: verdict(), ...over2,
  });
  const run = async (view: OpenPrView = pr) => {
    await runSweep([view], deps, DEFAULT_SWEEP_POLICY);
    const row = readLedgerLines(ledgerPath).findLast(r => r.step === "sweep.disposed");
    assert.ok(row);
    return row;
  };
  return { pr, modes, deliver, run, ledgerPath };
}

test("W1-T11729 criterion 1: a delivered success under a pending status of the same head and input is restored, not re-reviewed", async t => {
  const f = sweepFixture(t);
  f.deliver();
  const row = await f.run();
  assert.deepEqual(f.modes.map(m => m.kind), ["restore"]);
  assert.equal(row.acted, true);
  assert.equal(readLedgerLines(f.ledgerPath).some(r => r.step === "sweep.review_admitted"), false, "a restore is no admitted review");
  assert.equal(readLedgerLines(f.ledgerPath).filter(r => r.step === REVIEW_STATUS_RESTORED_STEP).length, 1);
});

test("W1-T11729 criterion 2: a delivered verdict that is not a full success or failure keeps today's dedup", async t => {
  const cannot = sweepFixture(t);
  cannot.deliver({ decision_verdict: { ...verdict(), cannotEvaluate: true } });
  const cannotRow = await cannot.run();
  assert.deepEqual(cannot.modes, []);
  assert.match(String(cannotRow.stand_down_reason), /already DELIVERED/);

  const later = sweepFixture(t);
  later.deliver();
  appendLedger(later.ledgerPath, { run_id: "later", task_id: "W1-T11596", step: "review.pending_posted", pr_url: URL, head_sha: HEAD, review_input_digest: DIGEST });
  const laterRow = await later.run();
  assert.deepEqual(later.modes, []);
  assert.match(String(laterRow.stand_down_reason), /already DELIVERED/);

  const unread = sweepFixture(t, { reviewInputDigest: undefined });
  unread.deliver({ review_input_digest: undefined });
  const unreadRow = await unread.run();
  assert.deepEqual(unread.modes, []);
  assert.match(String(unreadRow.stand_down_reason), /already DELIVERED/);
});

test("W1-T11729 criterion 2: a moved head or a changed input restores nothing", async t => {
  for (const moved of [{ headSha: "f".repeat(40) }, { reviewInputDigest: "v2:other" }] as const) {
    const f = sweepFixture(t, moved);
    f.deliver();
    await f.run();
    assert.deepEqual(f.modes.map(m => m.kind), ["full-review"], JSON.stringify(moved));
  }
});

test("W1-T11729 criterion 3: one restore is spent per observed regression", async t => {
  const f = sweepFixture(t);
  f.deliver();
  await f.run();
  const second = await f.run();
  assert.deepEqual(f.modes.map(m => m.kind), ["restore"], "the same regression is not restored twice");
  assert.match(String(second.stand_down_reason), /already DELIVERED/);
  await f.run({ ...f.pr, reviewPendingSince: "2026-11-08T13:20:00.000Z" });
  assert.deepEqual(f.modes.map(m => m.kind), ["restore", "restore"], "a new regression earns its own restore");
});

function adapterFixture(t: TestContext, postStatus: "ok" | "fail") {
  const root = mkdtempSync(join(tmpdir(), "rmd-t11729-adapter-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const oldPath = process.env.PATH;
  const shim = ghShim([
    { when: "/statuses?", stdout: "[[]]\n" },
    ...(postStatus === "fail" ? [{ when: "statuses/", stderr: "boom", exit: 1 }] : [{ when: "statuses/", stdout: "{}\n" }]),
    { when: "pulls/17354", stdout: `{"state":"open","merged":false,"head":{"sha":"${HEAD}"}}\n` },
  ]);
  process.env.PATH = `${shim.dir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; rmSync(root, { recursive: true, force: true }); });
  appendLedger(ledgerPath, { run_id: "review-original", task_id: "W1-T11596", step: "review.posted", state: "success", pr_url: URL,
    head_sha: HEAD, review_input_digest: DIGEST, decision_verdict: verdict() });
  const calls: string[] = [];
  const unexpected = (): never => { throw new Error("the restore path made an unexpected host call"); };
  const host = {
    freshTreeGit: unexpected,
    realDeps: () => ({ reviewWorktree: { addWorktree: unexpected } }),
    buildFreshTreeReviewRunner: () => unexpected,
    buildReviewerCodeFreshnessGate: () => ({ call: unexpected, staleThisPass: () => undefined }),
    buildBaseReproductionProbe: () => unexpected, buildImportClosureRead: () => unexpected,
    buildRequiredFixReviewRunner: () => unexpected, readyDraftViaGh: () => unexpected,
    reviewPostedDescription: (verdict: { summary: string }) => verdict.summary,
  } as unknown as SweepCommandHost & Required<Pick<SweepCommandHost, "freshTreeGit">>;
  const effects = commandEffects(host, {
    owner: "acme", repo: "scratch", localRepoName: "not-scratch", config: { root } as never, ledgerPath, runId: "restore-adapter",
    plan: { tasks: [], byId: new Map() } as never, log: step => calls.push(step),
    reviewRunner: async () => { calls.push("full-review"); return 0; },
  });
  const pr = { prNumber: 17354, prUrl: URL, taskId: "W1-T11596", headSha: HEAD, reviewInputDigest: DIGEST, reviewState: "pending",
    reviewPendingSince: PENDING_SINCE, checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    // expiring-fixture: exempt -- the adapter is called directly, so no stale-days disposition is derived.
    lastActivityAt: "2026-11-08T12:00:00Z" } as OpenPrView;
  const mode: ReviewDispatchMode = { kind: "restore", judgedHeadSha: HEAD, regressionKey: REGRESSION_KEY };
  return { effects, pr, mode, calls, ledgerPath, ghCalls: () => shim.calls().join("\n") };
}

test("W1-T11729 criterion 1: the adapter re-posts the delivered state and ledgers the restore only after the post succeeded", async t => {
  const f = adapterFixture(t, "ok");
  await withLiveWritesAllowed(() => f.effects.postReview!(f.pr, f.mode));
  const restored = readLedgerLines(f.ledgerPath).filter(r => r.step === REVIEW_STATUS_RESTORED_STEP);
  assert.equal(restored.length, 1, JSON.stringify(f.calls));
  assert.equal(restored[0]?.old_state, "pending");
  assert.equal(restored[0]?.new_state, "success");
  assert.equal(restored[0]?.delivered_run_id, "review-original");
  assert.equal(f.calls.includes("full-review"), false);
  const posts = f.ghCalls();
  assert.match(posts, /statuses\/d552219678ee21fc500aa2ed9c6799f5179db58b/);
  assert.match(posts, /state=success/);
  assert.equal(/state=(failure|pending)/.test(posts), false, "no state the delivered verdict lacked is posted");
});

test("W1-T11729 criterion 4: a failed status post writes no restore row", async t => {
  const f = adapterFixture(t, "fail");
  await withLiveWritesAllowed(() => f.effects.postReview!(f.pr, f.mode));
  assert.equal(readLedgerLines(f.ledgerPath).some(r => r.step === REVIEW_STATUS_RESTORED_STEP), false);
  assert.equal(f.calls.includes("full-review"), false, "a failed restore never falls back to a review");
});
