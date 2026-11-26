/**
 * W1-T14902 — a pull request whose `Remudero-Task:` names a task carrying `dispatch_hold: true` is not mergeable.
 * OBSERVED 2026-11-25: remudero-ops #910's task W1-T14898 was filed held, awaiting the operator; remudero-review posted
 * success and the fleet merged it four seconds later, with GitHub auto-merge off. Review now holds that pass as pending,
 * and the merge path refuses the PR, until the hold is released. A hold that cannot be read holds too.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { runReview, type ReviewCommandHost } from "#src/cli/commands/review.js";
import { armIfVerdictPermitsAsync, attemptArmAsync, readPullRequestTaskHold, realArmDepsAsync } from "#src/lib/arm-auto-merge.js";
import type { Config } from "#src/lib/config.js";
import { appendLedger } from "#src/lib/ledger.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { postReviewStatusGuarded, taskHoldReading, type TaskHoldReading, type ReviewVerdict } from "#src/lib/review.js";
import { planCheckoutRoot, readOpsCatalogHold, targetPlanRoot, readTaskDispatchHold, type TaskDispatchHoldSources } from "#src/lib/task-dispatch-hold.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
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

test("W1-T14902: the one reader reads main, then a fresh ops record; every other answer is unread", async () => {
  const main = (byId: Record<string, { dispatch_hold?: boolean }>) => async () => ({ byId: new Map(Object.entries(byId)) });
  const never = async (): Promise<never> => { throw new Error("the ops catalog is not consulted for a task main holds"); };
  const ops = (answer: unknown) => async () => answer as Awaited<ReturnType<NonNullable<TaskDispatchHoldSources["lookup"]>>>;
  const read = (sources: Omit<TaskDispatchHoldSources, "stateDir">, id: string | undefined = TASK) =>
    readTaskDispatchHold(id, { stateDir: "/nonexistent/state", ...sources });
  // A public task held on main is held (the merge path read no public plan before), and main answers before ops.
  assert.deepEqual(await read({ readMainPlan: main({ [TASK]: { dispatch_hold: true } }), lookup: never }), { outcome: "held", taskId: TASK });
  assert.deepEqual(await read({ readMainPlan: main({ [TASK]: {} }), lookup: never }), { outcome: "clear" });
  // Absent from main: the ops catalog's fresh record decides.
  const found = (task: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ops({ outcome: "found", catalog: "ops", task: { id: TASK, ...task }, ...extra });
  assert.deepEqual(await read({ readMainPlan: main({}), lookup: found({ dispatch_hold: true }) }), { outcome: "held", taskId: TASK });
  assert.deepEqual(await read({ readMainPlan: main({}), lookup: found({}) }), { outcome: "clear" });
  assert.deepEqual(await read({ readMainPlan: main({}), lookup: ops({ outcome: "absent" }) }),
    { outcome: "unread", taskId: TASK, reason: "neither the plan at origin/main nor the ops catalog holds it" },
    "a real id neither catalog holds cannot be shown clear");
  assert.deepEqual(await read({ readMainPlan: main({ "W1-T12e": { dispatch_hold: true } }), lookup: never }, "W1-T12e"),
    { outcome: "held", taskId: "W1-T12e" }, "a legacy suffixed id is a task id, not a synthetic key");
  // THE INVARIANT: a last-good snapshot may predate the hold, so it is unread; so is every failed read.
  assert.equal((await read({ readMainPlan: main({}), lookup: found({}, { lastGood: { refusal: "ops-stale", snapshotAgeMs: 1 } }) })).outcome, "unread");
  assert.equal((await read({ readMainPlan: main({}), lookup: ops({ outcome: "unreadable", reason: "ops-malformed" }) })).outcome, "unread");
  assert.equal((await read({ readMainPlan: main({}), lookup: async () => { throw new Error("HTTP 502"); } })).outcome, "unread");
  assert.equal((await read({ readMainPlan: async () => { throw new Error("bad object origin/main"); }, lookup: never })).outcome, "unread");
  // A synthetic review key or no trailer names no task.
  assert.deepEqual(await read({ readMainPlan: never, lookup: never }, "PR-910"), { outcome: "clear" });
  assert.deepEqual(await readTaskDispatchHold(undefined, { stateDir: "/nonexistent/state", readMainPlan: never, lookup: never }), { outcome: "clear" });
});

test("W1-T14902: the merge path's reader follows the PR body's trailer into the one reader", async (t) => {
  const root = tmp(t, "reader");
  const config = (() => ({ root })) as unknown as Parameters<typeof readPullRequestTaskHold>[1];
  const bodyOf = (body: string | undefined) => async (path: string) => {
    assert.equal(path, "repos/acme/remudero-ops/pulls/910");
    return body === undefined ? {} : { body };
  };
  const held = { readMainPlan: async () => ({ byId: new Map([[TASK, { dispatch_hold: true }]]) }) };
  assert.deepEqual(await readPullRequestTaskHold(PR_URL, config, bodyOf(`Remudero-Task: ${TASK}\n`), held), { outcome: "held", taskId: TASK });
  assert.deepEqual(await readPullRequestTaskHold(PR_URL, config, bodyOf("no trailer"), held), { outcome: "clear" },
    "a PR naming no task reviews as today");
  assert.deepEqual(await readPullRequestTaskHold(PR_URL, config, bodyOf(undefined), held), { outcome: "clear" });
  assert.equal((await readPullRequestTaskHold("not a pull request url", config)).outcome, "unread");
});

test("W1-T14902: the one reader's defaults read this checkout's plan at origin/main, never a PR head", async (t) => {
  // W1-T8397 is a public record carrying dispatch_hold: true on main; W1-T10732 carries dispatch_hold: false.
  const stateDir = tmp(t, "default-state");
  assert.deepEqual(await readTaskDispatchHold("W1-T8397", { stateDir }), { outcome: "held", taskId: "W1-T8397" });
  assert.deepEqual(await readTaskDispatchHold("W1-T10732", { stateDir }), { outcome: "clear" });
  // Absent from main, the default lookup finds no plan destination under this state dir: no ops catalog, clear.
  assert.equal((await readTaskDispatchHold("W1-T99999998", { stateDir })).outcome, "unread");
});

test("W1-T14902: the default ops read answers only from a fresh snapshot of the named destination", async (t) => {
  type Read = NonNullable<Parameters<typeof readOpsCatalogHold>[2]>;
  type Snapshot = Awaited<ReturnType<Read>>;
  const named = tmp(t, "ops-destination");
  writeFileSync(join(named, "plan-destination.json"), JSON.stringify({ repository: "acme/remudero-ops", kinds: ["task"] }));
  const targets: string[] = [];
  const snapshot = (answer: Partial<Snapshot>): Read => async (target) => {
    targets.push(target.repository);
    return { counts: {}, ...answer } as Snapshot;
  };
  const ops = { outcome: "ok", plan: { byId: new Map([[TASK, { dispatch_hold: true }]]) } } as unknown as Partial<Snapshot>;
  assert.deepEqual(await readOpsCatalogHold(TASK, named, snapshot(ops)), { outcome: "found", task: { dispatch_hold: true } });
  assert.deepEqual(await readOpsCatalogHold("W1-T99999998", named, snapshot(ops)), { outcome: "absent" });
  assert.deepEqual(await readOpsCatalogHold(TASK, named, snapshot({ outcome: "stale" } as Partial<Snapshot>)),
    { outcome: "unreadable", reason: "ops-stale" }, "a refused read is never the last good snapshot");
  assert.deepEqual(targets, ["acme/remudero-ops", "acme/remudero-ops", "acme/remudero-ops"]);
  const never: Read = async () => { throw new Error("no destination means no ops read"); };
  assert.deepEqual(await readOpsCatalogHold(TASK, tmp(t, "ops-off"), never), { outcome: "absent" });
  const broken = tmp(t, "ops-broken");
  writeFileSync(join(broken, "plan-destination.json"), "{not json");
  assert.deepEqual(await readOpsCatalogHold(TASK, broken, never), { outcome: "unreadable", reason: "destination-unreadable" });
  // Through the one reader, a refused ops read holds.
  assert.equal((await readTaskDispatchHold(TASK, { stateDir: named, readMainPlan: async () => ({ byId: new Map() }),
    lookup: (id) => readOpsCatalogHold(id, named, snapshot({ outcome: "stale" } as Partial<Snapshot>)) })).outcome, "unread");
});

test("W1-T14902: every guarded post reads the hold itself when its caller supplied none", async (t) => {
  const previous = process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (previous === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = previous; });
  const ledgerPath = join(tmp(t, "guarded-default"), "ledger.ndjson");
  const posts: string[] = [];
  const post = (taskId: string) => postReviewStatusGuarded({
    owner: "acme", repo: "remudero", sha: SHA, state: "success", verdict: PASS, description: PASS.summary,
    taskId, evidence: "executed", ledgerPath, runId: "t14902-default", prUrl: PR_URL, reviewInputDigest: `v2:${taskId}`,
    fetchLifecycle: () => ({ merged: false, closed: false }),
    readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
    fetchCurrentStatusEntry: () => undefined,
    post: (status) => { posts.push(`${taskId}:${status.state}`); },
    semanticJudgement: { planOnly: false, reviewerOutcome: "success" },
  });
  delete process.env.NODE_TEST_CONTEXT;
  const held = await post("W1-T8397");
  assert.equal(held.taskHold, "held: W1-T8397 carries dispatch_hold", "THE WIRING: a caller that passes no reading is still held");
  // THE TARGET WIRING: the post's own owner/repo picks the plan. A daemon whose target acme/remudero has no readable
  // checkout holds even a task this checkout's plan reads clear, so the reading came from the PR's repository.
  writeFileSync(join(dirname(ledgerPath), "daemon-target.json"),
    JSON.stringify({ owner: "acme", repo: "remudero", isSelf: false, checkoutRoot: join(dirname(ledgerPath), "no-checkout") }));
  const target = await post("W1-T10732");
  assert.match(target.taskHold ?? "", /^held: W1-T10732's dispatch_hold is unreadable/);
  rmSync(join(dirname(ledgerPath), "daemon-target.json"));
  process.env.NODE_TEST_CONTEXT = previous ?? "child-v8";
  await post("W1-T10732");
  assert.deepEqual(posts, ["W1-T8397:pending", "W1-T10732:pending", "W1-T10732:success"]);
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
  // THE TARGET WIRING on the merge path: the PR's acme/remudero-ops plan is read from its managed checkout, so a broken
  // one holds even W1-T10732, which this checkout's plan reads clear.
  mkdirSync(join(root, "repos", "remudero-ops", ".git"), { recursive: true });
  const viaTarget = await readPullRequestTaskHold(PR_URL, (() => ({ root })) as unknown as Parameters<typeof readPullRequestTaskHold>[1],
    async () => ({ body: "Remudero-Task: W1-T10732\n" }));
  assert.equal(viaTarget.outcome, "unread");
  rmSync(join(root, "repos"), { recursive: true, force: true });
  // No plan destination and no acme/remudero-ops checkout: no catalog holds the named task, so it reads unread.
  const reading = await readPullRequestTaskHold(PR_URL, (() => ({ root })) as unknown as Parameters<typeof readPullRequestTaskHold>[1]);
  assert.deepEqual(reading, { outcome: "unread", taskId: TASK, reason: "neither the plan at origin/main nor the ops catalog holds it" });
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

test("W1-T14902: the daemon's arm deps carry the live hold reader, left out only under the test runner", (t) => {
  const previous = process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (previous === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = previous; });
  assert.equal(realArmDepsAsync().taskHold, undefined, "under the test runner a suite with partial fakes reads no real PR body");
  delete process.env.NODE_TEST_CONTEXT;
  assert.equal(typeof realArmDepsAsync().taskHold, "function", "THE WIRING: a live daemon reads the hold before every arm");
});

test("W1-T14902: a target repository's task is read from that repository's own plan, not the core checkout's", async (t) => {
  const root = tmp(t, "target-root");
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const self = async () => "/the/self/checkout";
  // Not the daemon's target and no managed checkout: this checkout answers, as an operator's CLI does.
  assert.equal(await targetPlanRoot(stateDir, { owner: "acme", repo: "wreck" }, self), "/the/self/checkout");
  assert.equal(await targetPlanRoot(stateDir, undefined, self), "/the/self/checkout");
  // A managed checkout <config.root>/repos/<repo> answers for its repository.
  mkdirSync(join(root, "repos"));
  symlinkSync(REPO_ROOT, join(root, "repos", "wreck"));
  assert.equal(await targetPlanRoot(stateDir, { owner: "acme", repo: "wreck" }, self), join(root, "repos", "wreck"));
  // The daemon's own target record wins, whatever its checkout is called (a self target is not under repos/).
  writeFileSync(join(stateDir, "daemon-target.json"), JSON.stringify({ owner: "Acme", repo: "Core", isSelf: true, checkoutRoot: REPO_ROOT }));
  assert.equal(await targetPlanRoot(stateDir, { owner: "acme", repo: "core" }, self), REPO_ROOT);
  writeFileSync(join(stateDir, "daemon-target.json"), "{not json");
  assert.equal(await targetPlanRoot(stateDir, { owner: "acme", repo: "core" }, self), "/the/self/checkout");
  // End to end through the guarded poster's own source: a held record in the target's plan holds its PR.
  assert.deepEqual(await readTaskDispatchHold("W1-T8397", { stateDir, repository: { owner: "acme", repo: "wreck" } }),
    { outcome: "held", taskId: "W1-T8397" });
});

test("W1-T14902: a daemon whose cwd is no work tree (launchd's config.root) still reads the plan, from its install", async (t) => {
  const outside = tmp(t, "launchd-cwd");
  assert.equal(await planCheckoutRoot([], outside), REPO_ROOT, "the install's own checkout, as repoRoot falls back");
  assert.equal(await planCheckoutRoot([], join(REPO_ROOT, "src", "lib")), REPO_ROOT, "a cwd inside a work tree names its top");
  assert.equal(await planCheckoutRoot(["review", "--repo-root", outside], REPO_ROOT), outside, "an explicit --repo-root wins");
  const cwd = process.cwd();
  t.after(() => process.chdir(cwd));
  process.chdir(outside);
  // The reproduction: from a non-git cwd a clear public task read unread, and every named task was held.
  assert.deepEqual(await readTaskDispatchHold("W1-T10732", { stateDir: outside }), { outcome: "clear" });
  assert.deepEqual(await readTaskDispatchHold("W1-T8397", { stateDir: outside }), { outcome: "held", taskId: "W1-T8397" });
});
