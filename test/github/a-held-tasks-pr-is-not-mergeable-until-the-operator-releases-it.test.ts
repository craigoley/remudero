/**
 * W1-T14902 — a pull request whose `Remudero-Task:` names a task carrying `dispatch_hold: true` is not mergeable.
 * OBSERVED 2026-11-25: remudero-ops #910's task W1-T14898 was filed held, awaiting the operator; remudero-review posted
 * success and the fleet merged it four seconds later, with GitHub auto-merge off. Review now holds that pass as pending,
 * and the merge path refuses the PR, until the hold is released. A hold that cannot be read holds too.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runReview, type ReviewCommandHost } from "#src/cli/commands/review.js";
import { armIfVerdictPermitsAsync, attemptArmAsync, readPullRequestTaskHold } from "#src/lib/arm-auto-merge.js";
import type { Config } from "#src/lib/config.js";
import { appendLedger } from "#src/lib/ledger.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { postReviewStatusGuarded, taskHoldReading, type TaskHoldReading, type ReviewVerdict } from "#src/lib/review.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { spawnWorker } from "#src/lib/worker.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const SHA = "14902000c0de000000000000000000000000000ab";
const PR_URL = "https://github.com/acme/remudero-ops/pull/910";
const TASK = "W1-T14898";
const PASS: ReviewVerdict = { state: "success", criteria: [{ claim: "the change ships", proof: "grep: ships in src/x.ts",
  met: true, floorMet: true, reason: "proof executed and PASSED", proof_exec: "executed_pass" }] as ReviewVerdict["criteria"],
testTheater: false, floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, summary: "remudero-review: PASS" };

function tmp(t: TestContext, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t14902-${kind}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The guarded poster with every GitHub read injected, handed `taskHold` as the review read it. */
async function guardedPost(t: TestContext, taskHold: TaskHoldReading | undefined) {
  const ledgerPath = join(tmp(t, "post"), "ledger.ndjson");
  const posts: Array<{ state: string; description?: string }> = [];
  const result = await postReviewStatusGuarded({
    owner: "acme", repo: "remudero-ops", sha: SHA, state: "success", verdict: PASS, description: PASS.summary,
    taskId: TASK, evidence: "executed", ledgerPath, runId: "t14902", prUrl: PR_URL, reviewInputDigest: "v2:t14902",
    fetchLifecycle: () => ({ merged: false, closed: false }),
    readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
    fetchCurrentStatusEntry: () => undefined,
    post: (status) => { posts.push({ state: status.state, description: status.description }); },
    semanticJudgement: { planOnly: false, reviewerOutcome: "success" },
    ...(taskHold !== undefined ? { taskHold } : {}),
  });
  return { result, posts, rows: readLedgerLines(ledgerPath) };
}

/** One review arm through the real attemptArm, every GitHub write recorded; `log` is the ledger the review writes. */
async function reviewArm(taskHold: (prUrl: string) => Promise<TaskHoldReading>) {
  const writes: string[] = [];
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  const outcome = await armIfVerdictPermitsAsync(PASS, {
    prUrl: PR_URL, taskId: TASK, headSha: SHA, ledgerPath: "/nonexistent/ledger.ndjson",
    log: (step, extra) => { rows.push({ step, ...extra }); },
  }, {
    ledgerLines: () => [],
    arm: (prUrl) => attemptArmAsync(prUrl, {
      headSha: async () => SHA,
      ledgerLines: () => [],
      armAuto: async () => { writes.push("armAuto"); },
      mergeDirect: async () => { writes.push("mergeDirect"); },
      isMerged: async () => false,
      taskHold,
      say: () => {},
    }, SHA),
  });
  return { outcome, writes, rows };
}

test("W1-T14902 criterion 1: a held task's met verdict posts remudero-review pending naming the hold, never success", async (t) => {
  const { result, posts, rows } = await guardedPost(t, taskHoldReading(TASK, { dispatch_hold: true }));
  assert.deepEqual(posts.map((p) => p.state), ["pending"], "THE CLAIM: only pending is posted, never success");
  assert.match(posts[0]!.description ?? "", /held: W1-T14898 carries dispatch_hold/, "the description names the task and the hold");
  assert.equal(result.effectiveState, "pending");
  assert.equal(result.effectiveVerdict?.state, "pending");
  assert.match(result.taskHold ?? "", /^held: W1-T14898 carries dispatch_hold$/);
  const held = rows.filter((row) => row.step === "review.dispatch_hold_held");
  assert.equal(held.length, 1, "the hold is ledgered once");
  assert.equal(held[0]!.attempted_state, "success");
  assert.equal(held[0]!.head_sha, SHA);
});

test("W1-T14902 criterion 2: attemptArm refuses a held task's pull request: no arm, no direct merge, one row naming it", async () => {
  const asked: string[] = [];
  const { outcome, writes, rows } = await reviewArm(async (prUrl) => { asked.push(prUrl); return { outcome: "held", taskId: TASK }; });
  assert.equal(outcome, "hold-refused", "THE CLAIM: the arm is refused");
  assert.deepEqual(writes, [], "no arm and no direct merge reached GitHub");
  assert.deepEqual(asked, [PR_URL], "positive control: the hold reader was asked about this PR");
  const named = rows.filter((row) => row.outcome === "hold-refused");
  assert.equal(named.length, 1, `one row records the refusal: ${JSON.stringify(rows)}`);
  assert.match(String(named[0]!.error), /W1-T14898 carries dispatch_hold/, "the row names the task and the hold");
});

test("W1-T14902 criterion 3: invariant:an-unread-hold-holds", async (t) => {
  // An unread hold: review stays pending, and attemptArm refuses, whether the reader answers unread or throws.
  const unread: TaskHoldReading = { outcome: "unread", taskId: TASK, reason: "ops-unreadable" };
  const review = await guardedPost(t, unread);
  assert.deepEqual(review.posts.map((p) => p.state), ["pending"], "an unread hold posts pending");
  assert.match(review.posts[0]!.description ?? "", /W1-T14898's dispatch_hold is unreadable \(ops-unreadable\)/);
  for (const [why, reader] of [
    ["unread", async () => unread],
    ["thrown", async () => { throw new Error("HTTP 502"); }],
  ] as const) {
    const arm = await reviewArm(reader);
    assert.equal(arm.outcome, "hold-refused", `${why}: the arm is refused`);
    assert.deepEqual(arm.writes, [], `${why}: nothing reached GitHub`);
  }
  // A clear task, or no reading at all, reviews and arms exactly as today.
  for (const [why, hold] of [
    ["no dispatch_hold", taskHoldReading(TASK, {})],
    ["dispatch_hold false", taskHoldReading(TASK, { dispatch_hold: false })],
    ["no record", taskHoldReading(TASK, undefined)],
    ["no reading", undefined],
  ] as const) {
    const posted = await guardedPost(t, hold);
    assert.deepEqual(posted.posts.map((p) => p.state), ["success"], `${why}: success posts as before`);
    assert.equal(posted.result.taskHold, undefined, `${why}: no hold`);
  }
  const clear = await reviewArm(async () => ({ outcome: "clear" }));
  assert.equal(clear.outcome, "armed", "a clear task arms as before");
  assert.deepEqual(clear.writes, ["armAuto"]);
});

test("W1-T14902: the production reader follows the PR body's trailer to the task's catalog record", async (t) => {
  const root = tmp(t, "reader");
  const config = (() => ({ root }) as unknown as Config) as unknown as Parameters<typeof readPullRequestTaskHold>[1];
  const bodyOf = (body: string | undefined) => async (path: string) => {
    assert.equal(path, "repos/acme/remudero-ops/pulls/910");
    return body === undefined ? {} : { body };
  };
  const found = (dispatch_hold?: boolean) => async (taskId: string, sources: { stateDir?: string }) => {
    assert.equal(taskId, TASK);
    assert.equal(sources.stateDir, join(root, "state"));
    return { outcome: "found" as const, catalog: "ops" as const,
      task: { id: taskId, ...(dispatch_hold === undefined ? {} : { dispatch_hold }) } as never };
  };
  const trailer = `Task: ${TASK}\n\nRemudero-Task: ${TASK}\n`;
  assert.deepEqual(await readPullRequestTaskHold(PR_URL, config, bodyOf(trailer), found(true)), { outcome: "held", taskId: TASK });
  assert.deepEqual(await readPullRequestTaskHold(PR_URL, config, bodyOf(trailer), found()), { outcome: "clear" });
  assert.deepEqual(await readPullRequestTaskHold(PR_URL, config, bodyOf(trailer),
    async () => ({ outcome: "unreadable" as const, reason: "ops-malformed" })), { outcome: "unread", taskId: TASK, reason: "ops-malformed" });
  assert.deepEqual(await readPullRequestTaskHold(PR_URL, config, bodyOf("no trailer"), found(true)), { outcome: "clear" },
    "a PR naming no task reviews as today");
  assert.deepEqual(await readPullRequestTaskHold(PR_URL, config, bodyOf(undefined), found(true)), { outcome: "clear" });
  assert.equal((await readPullRequestTaskHold("not a pull request url", config)).outcome, "unread");
});

test("W1-T14902: the production reader's defaults read the body through gh and the real catalog lookup", async (t) => {
  const root = tmp(t, "defaults");
  const body = join(root, "pull.json");
  writeFileSync(body, JSON.stringify({ number: 910, body: `Remudero-Task: ${TASK}\n` }));
  const shim = ghShim([
    { when: "api repos/acme/remudero-ops/pulls/910", stdoutFile: body },
    { when: "", exit: 97, stderr: "unexpected GitHub call" },
  ]);
  const previous = new Map(["PATH", "HOME", "RMD_GH_CACHE_HOME", "RMD_SELF_SYNC_DONE"].map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const [k, v] of previous) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(shim.dir, { recursive: true, force: true });
  });
  Object.assign(process.env, { PATH: `${shim.dir}:${previous.get("PATH")}`, HOME: root, RMD_GH_CACHE_HOME: root, RMD_SELF_SYNC_DONE: "1" });
  // No plan destination is configured under this state dir, so the real lookup answers absent: clear, as today.
  const reading = await readPullRequestTaskHold(PR_URL, (() => ({ root })) as unknown as Parameters<typeof readPullRequestTaskHold>[1]);
  assert.deepEqual(reading, { outcome: "clear" });
  assert.equal(shim.calls().filter((c) => c.includes("pulls/910")).length, 1, "positive control: the body was read through gh");
});

// ── the run's own review, end to end ─────────────────────────────────────────────────────────────────────────────

function unexpected(): never { throw new Error("unexpected review fixture dependency"); }
let reviewedHead = SHA;
const host: ReviewCommandHost = {
  GIT_UNTRACKED_FILES_ALL: "--untracked-files=all",
  JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
  acceptedReviewAttemptId: (value) => typeof value === "string" ? value : undefined,
  attributeWorkerStreamEvent: (event) => event,
  ledgeredNonDispatchSpawn: (_lane, raw) => raw ?? spawnWorker,
  lintPlanForReview: unexpected,
  liveWorkerRunIds: new Set<string>(),
  materializeReviewWorktree: unexpected,
  readHeadShaRest: () => reviewedHead,
  readMainPlanTreeSha: unexpected,
  realDeps: () => ({ reviewWorktree: { fetch: () => {} } }) as unknown as ReturnType<ReviewCommandHost["realDeps"]>,
  reviewPostedDescription: (verdict) => verdict.summary,
  reviewWorkerLockId: (runId) => runId,
  reviewerClockBoundMs: () => 60_000,
  reviewSubjectGit: unexpected,
};

/** `runReview` over a real head whose one grep proof executes and passes, handed `taskHold` as the command read it. */
async function heldRunReview(t: TestContext, taskHold: TaskHoldReading) {
  const root = tmp(t, "run");
  const head = gitRepo({ scope: t, kind: "t14902-head" });
  writeFileSync(join(head.dir, "x.ts"), "export const shipsIt = 1;\n");
  head.git("add", "x.ts");
  head.git("commit", "-qm", "x");
  const headSha = head.git("rev-parse", "HEAD");
  reviewedHead = headSha;
  t.after(() => { reviewedHead = SHA; });
  const prUrl = "https://github.com/acme/remudero-ops/pull/14902";
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(join(root, "settings.json"), "{}");
  const report = "REPORT\n- shipsIt exported and verified.";
  const pull = { number: 14902, html_url: prUrl, updated_at: "t", body: report, state: "open", merged: false,
    head: { ref: "run-t14902", sha: headSha } };
  const shim = ghShim([
    { when: "/statuses?", stdout: "[[]]" },
    { when: "/reviews?", stdout: "[]" },
    { when: "/commits/", stdout: '{"statuses":[]}' },
    { when: "/pulls/", stdout: JSON.stringify(pull) },
    { when: "pr view", stdout: '{"state":"OPEN"}' },
    { when: "pr diff", stdout: "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n@@\n+export const shipsIt = 1;\n" },
    { when: "api ", stdout: "{}" },
  ], { kind: "t14902-run" });
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  const effects: string[] = [];
  try {
    const verdict = await withLiveWritesAllowed(() => runReview(host, {
      owner: "acme", repo: "remudero-ops", prUrl,
      task: { id: TASK, acceptance: [{ claim: "shipsIt is exported", proof: "grep: export const shipsIt in x.ts" }] },
      taskHold,
      report,
      settingsFile: join(root, "settings.json"),
      config: { claudeBin: "/bin/true", root } as Config,
      log: (step: string, extra: Record<string, unknown> = {}) => {
        appendLedger(ledgerPath, { run_id: "t14902-run", task_id: TASK, step, ...extra });
      },
      say: () => {},
      account: (r: WorkerResult) => r,
      reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 },
      reviewerSpawnWorker: async () => ({ sessionId: "t14902-reviewer", text: "REVIEW_VERDICT 1: PASS", blocks: [],
        stderr: "", exit: { kind: "exit", code: 0 }, costUsd: 0, numTurns: 1, permissionDenials: [], childEnvKeys: [],
        model: "sonnet", effort: "medium", provider: "claude", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        modelUsage: {}, compactionEvents: [], qualitySuspect: false, subtype: "success", isError: false, apiError: false }) as WorkerResult,
      headCheckoutDir: head.dir,
      ledgerPath,
      runId: "t14902-run",
      arm: () => { effects.push("arm"); return "armed" as const; },
      disarm: () => { effects.push("disarm"); return "not-armed" as const; },
    }));
    const statusPosts = shim.calls().filter((call) => call.includes("context=remudero-review"));
    return { verdict, effects, statusPosts };
  } finally {
    process.env.PATH = oldPath;
  }
}

test("W1-T14902: the review command holds a held task's pass as pending, arms nothing and withdraws an open arm", async (t) => {
  const held = await heldRunReview(t, taskHoldReading(TASK, { dispatch_hold: true }));
  assert.ok(!held.statusPosts.some((call) => call.includes("state=success")), `no success is posted: ${held.statusPosts.join(" | ")}`);
  assert.ok(held.statusPosts.some((call) => call.includes("state=pending") && call.includes("dispatch_hold")),
    `a pending naming the hold is posted: ${held.statusPosts.join(" | ")}`);
  assert.equal(held.verdict.state, "pending");
  assert.match(held.verdict.verdictWithheld ?? "", /held: W1-T14898 carries dispatch_hold/);
  assert.ok(!held.effects.includes("arm"), "nothing is armed");
  assert.ok(held.effects.includes("disarm"), "an arm taken at open is withdrawn");
  // Positive control: the same run with the hold clear publishes success and arms.
  const clear = await heldRunReview(t, { outcome: "clear" });
  assert.ok(clear.statusPosts.some((call) => call.includes("state=success")), `a clear task's pass posts: ${clear.statusPosts.join(" | ")}`);
  assert.ok(clear.effects.includes("arm"), "a clear task's pass arms");
});
