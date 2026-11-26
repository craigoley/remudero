/**
 * W1-T14902 — a pull request whose `Remudero-Task:` names a task carrying `dispatch_hold: true` is not mergeable.
 * OBSERVED 2026-11-25: remudero-ops #910's task W1-T14898 was filed held, awaiting the operator; remudero-review posted
 * success and the fleet merged it four seconds later, with GitHub auto-merge off. Review now holds that pass as pending,
 * and the merge path refuses the PR, until the hold is released. A hold that cannot be read holds too.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { catalogReviewPoster, publishUnreadTaskCatalogHold, reviewCommand, runReview, type ReviewCommandHost } from "#src/cli/commands/review.js";
import { armIfVerdictPermitsAsync, attemptArmAsync, readPullRequestTaskHold, realArmDepsAsync } from "#src/lib/arm-auto-merge.js";
import type { Config } from "#src/lib/config.js";
import { appendLedger } from "#src/lib/ledger.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { postReviewStatusGuarded, postUnreadTaskHoldGuarded, reviewInputDigest, taskHoldInputDigest, taskHoldReading, type TaskHoldReading, type ReviewVerdict } from "#src/lib/review.js";
import { planCheckoutRoot, pullRequestTaskSubjectOf, readOpsCatalogHold, readPullRequestNamedTaskHold, resolvePullRequestTaskSubject, targetPlanRoot, readTaskDispatchHold, type TaskDispatchHoldSources } from "#src/lib/task-dispatch-hold.js";
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
const LIVE_BODY = `Remudero-Task: ${TASK}\n`;
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
async function reviewArm(taskHold: (prUrl: string) => Promise<TaskHoldReading>, armLedger: Array<Record<string, unknown>> = []) {
  const writes: string[] = [];
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  const outcome = await armIfVerdictPermitsAsync(PASS, {
    prUrl: PR_URL, taskId: TASK, headSha: SHA, ledgerPath: "/nonexistent/ledger.ndjson",
    log: (step, extra) => { rows.push({ step, ...extra }); },
  }, {
    ledgerLines: () => [],
    arm: (prUrl) => attemptArmAsync(prUrl, {
      headSha: async () => SHA,
      ledgerLines: () => armLedger as never,
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
  // Under a standing operator merge hold too, the refusal row names the task's dispatch_hold (round-5 finding F2).
  const operatorHold = { step: "automerge.hold_engaged", pr_number: 910, by: "operator", reason: "reviewing", authority: "interactive-cli" };
  const both = await reviewArm(async () => ({ outcome: "held", taskId: TASK }), [operatorHold]);
  assert.equal(both.outcome, "hold-refused");
  assert.deepEqual(both.writes, []);
  assert.match(String(both.rows.find((row) => row.outcome === "hold-refused")?.error), /W1-T14898 carries dispatch_hold/);
  // Positive control: the operator hold alone still refuses, under its own reason.
  const operatorOnly = await reviewArm(async () => ({ outcome: "clear" }), [operatorHold]);
  assert.equal(operatorOnly.outcome, "hold-refused");
  assert.doesNotMatch(String(operatorOnly.rows.find((row) => row.outcome === "hold-refused")?.error), /dispatch_hold/);
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
    { outcome: "unread", taskId: TASK, reason: "no plan at origin/main and no ops catalog holds it" },
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
  assert.deepEqual(await read({ readMainPlan: never, lookup: never }, "unfiled"), { outcome: "clear" });
  // Round-6 C1: a lane's private key is no exemption — a caller hands in the body's task, so a key passed by mistake holds.
  assert.equal((await read({ readMainPlan: main({}), lookup: ops({ outcome: "absent" }) }, "dep-review-PR910")).outcome, "unread");
  // Any other trailer is a task id whatever its shape (round-5 finding F1: a `NEW-1a` record's hold was skipped).
  assert.deepEqual(await read({ readMainPlan: main({ "NEW-1a": { dispatch_hold: true } }), lookup: never }, "NEW-1a"),
    { outcome: "held", taskId: "NEW-1a" });
  assert.equal((await read({ readMainPlan: async () => { throw new Error("no plan"); }, lookup: never }, "NEW-1a")).outcome, "unread");
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
  // The post reads the task the live PR names through gh (one fresh read of the pull row), never its ledger key.
  const pullFile = join(dirname(ledgerPath), "pull.json");
  const names = (taskId: string) => writeFileSync(pullFile, JSON.stringify({ number: 911, body: `Remudero-Task: ${taskId}\n`, head: { ref: "feature/x" } }));
  const shim = ghShim([
    { when: "api repos/acme/remudero/pulls/911", stdoutFile: pullFile },
    { when: "", exit: 97, stderr: "unexpected GitHub call" },
  ]);
  const env = new Map(["PATH", "HOME", "RMD_GH_CACHE_HOME", "RMD_SELF_SYNC_DONE"].map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const [k, v] of env) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(shim.dir, { recursive: true, force: true });
  });
  Object.assign(process.env, { PATH: `${shim.dir}:${env.get("PATH")}`, HOME: dirname(ledgerPath), RMD_GH_CACHE_HOME: dirname(ledgerPath), RMD_SELF_SYNC_DONE: "1" });
  const prUrl = "https://github.com/acme/remudero/pull/911";
  const posts: string[] = [];
  const post = (key: string) => postReviewStatusGuarded({
    owner: "acme", repo: "remudero", sha: SHA, state: "success", verdict: PASS, description: PASS.summary,
    taskId: key, evidence: "executed", ledgerPath, runId: "t14902-default", prUrl, reviewInputDigest: `v2:${key}`,
    fetchLifecycle: () => ({ merged: false, closed: false }),
    readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
    fetchCurrentStatusEntry: () => undefined,
    post: (status) => { posts.push(`${key}:${status.state}`); },
    semanticJudgement: { planOnly: false, reviewerOutcome: "success" },
  });
  delete process.env.NODE_TEST_CONTEXT;
  names("W1-T8397");
  // The caller's key is a task this plan reads clear: the hold is the live PR's, not the key's (round-8 C1).
  const held = await post("W1-T10732");
  assert.equal(held.taskHold, "held: W1-T8397 carries dispatch_hold", "THE WIRING: a caller that passes no reading is still held");
  // THE TARGET WIRING: the PR's own repository picks the plan. A daemon whose target acme/remudero has no readable
  // checkout holds even a task this checkout's plan reads clear, so the reading came from the PR's repository.
  writeFileSync(join(dirname(ledgerPath), "daemon-target.json"),
    JSON.stringify({ owner: "acme", repo: "remudero", isSelf: false, checkoutRoot: join(dirname(ledgerPath), "no-checkout") }));
  names("W1-T10732");
  const target = await post("W1-T10732");
  assert.match(target.taskHold ?? "", /^held: W1-T10732's dispatch_hold is unreadable/);
  rmSync(join(dirname(ledgerPath), "daemon-target.json"));
  process.env.NODE_TEST_CONTEXT = previous ?? "child-v8";
  await post("W1-T10732");
  assert.deepEqual(posts, ["W1-T10732:pending", "W1-T10732:pending", "W1-T10732:success"]);
  assert.equal(shim.calls().filter((c) => c.includes("pulls/911")).length, 2, "positive control: each held post read the live PR");
  // Round-9 C1: the caller's verdict started from a body whose trailer was since edited to a held task. The live PR's
  // digest no longer matches the caller's, so a pending carrying the caller's digest would be refused and leave the
  // success; the hold's write names the body it read, and lands.
  delete process.env.NODE_TEST_CONTEXT;
  names("W1-T8397");
  const live = `Remudero-Task: W1-T8397\n`;
  const edited = await postReviewStatusGuarded({
    owner: "acme", repo: "remudero", sha: SHA, state: "success", verdict: PASS, description: PASS.summary,
    taskId: "W1-T10732", evidence: "executed", ledgerPath, runId: "t14902-edited", prUrl,
    reviewInputDigest: reviewInputDigest(SHA, "Remudero-Task: W1-T10732\n"),
    fetchLifecycle: () => ({ merged: false, closed: false, reviewInputDigest: reviewInputDigest(SHA, live) }),
    readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
    fetchCurrentStatusEntry: () => undefined,
    post: (status) => { posts.push(`edited:${status.state}`); },
    semanticJudgement: { planOnly: false, reviewerOutcome: "success" },
  });
  process.env.NODE_TEST_CONTEXT = previous ?? "child-v8";
  assert.equal(edited.taskHold, "held: W1-T8397 carries dispatch_hold");
  assert.equal(posts.at(-1), "edited:pending", "THE CLAIM: the pending for the edited body is posted, not refused as stale");
  assert.equal(taskHoldInputDigest({ sha: SHA, reviewInputDigest: "v2:caller" }, undefined), "v2:caller",
    "a caller-supplied reading keeps the caller's digest");
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
  assert.deepEqual(reading, { outcome: "unread", taskId: TASK, reason: "no plan at origin/main and no ops catalog holds it" });
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

test("W1-T14902: a satellite target's plan is read as its review reads it, and a core record falls back to core", async (t) => {
  // The live remudero-ops shape: a core record (repo: remudero) depending on a public id the ops plan never holds, beside
  // the ops daemon's own tasks. A strict parse throws on the first, and every ops task read unread (round-4 finding).
  const record = (id: string, repo: string, dependsOn: string[], hold?: boolean) =>
    `- id: ${id}\n  title: Fixture ${id}\n  repo: ${repo}\n  depends_on: [${dependsOn.join(", ")}]\n  type: implement\n` +
    `  verify: auto\n  risk: low\n  budget_usd: 5\n  status: queued\n  files: [fixture.ts]\n${hold === undefined ? "" : `  dispatch_hold: ${hold}\n`}` +
    `  acceptance:\n    - claim: ${id} holds\n      proof: "grep: ${id} in fixture.ts"\n`;
  const root = tmp(t, "satellite");
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const ops = gitRepo({ scope: t, kind: "t14902-ops" });
  mkdirSync(join(ops.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(ops.dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(ops.dir, "plan", "tasks.d", "core.yaml"), record("W1-T900301", "remudero", ["W1-T900300"]));
  writeFileSync(join(ops.dir, "plan", "tasks.d", "ops.yaml"),
    record("W1-T900302", "remudero-ops", []) + record("W1-T900303", "remudero-ops", [], true));
  ops.git("add", "plan");
  ops.git("commit", "-qm", "plan");
  ops.git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(stateDir, "daemon-target.json"),
    JSON.stringify({ owner: "acme", repo: "remudero-ops", isSelf: false, checkoutRoot: ops.dir }));
  const read = (id: string, repo = "remudero-ops") => readTaskDispatchHold(id, { stateDir, repository: { owner: "acme", repo } });
  assert.deepEqual(await read("W1-T900302"), { outcome: "clear" }, "an ops task with no hold reviews and arms as today");
  assert.deepEqual(await read("W1-T900303"), { outcome: "held", taskId: "W1-T900303" });
  // A record the PR's own plan does not hold, but this checkout's plan does, is read from it (W1-T8397 is held on main).
  assert.deepEqual(await read("W1-T8397"), { outcome: "held", taskId: "W1-T8397" });
  assert.deepEqual(await read("W1-T10732"), { outcome: "clear" });
  // The target's own task with an unresolved dependency stays strict: that plan cannot be read, and the hold holds.
  writeFileSync(join(ops.dir, "plan", "tasks.d", "ops.yaml"), record("W1-T900302", "remudero-ops", ["W1-T900300"]));
  ops.git("commit", "-qam", "broken own record");
  ops.git("update-ref", "refs/remotes/origin/main", "HEAD");
  assert.equal((await read("W1-T900302")).outcome, "unread");
});

test("W1-T14902: a review whose task catalog is unreadable replaces this head's status with pending naming the unread hold", async (t) => {
  // Round-5 F3 and round-6 C3: the refusal exit (`task catalog unreadable`) left an earlier executed success standing,
  // and a no-evidence pending is refused over it by the unchanged precedence guard. The hold carries the held
  // verdict's evidence class, so the guard permits it, and the row records what the post did.
  const dir = tmp(t, "catalog-refused");
  const ledgerPath = join(dir, "ledger.ndjson");
  const posts: Array<{ state: string; description?: string }> = [];
  const args = {
    post: (status: { state: string; description?: string }) => { posts.push(status); },
    owner: "acme", repo: "remudero-ops", sha: SHA, taskId: TASK, reviewKey: TASK, reason: "ops-ref_moved", ledgerPath,
    runId: "t14902-catalog", prUrl: PR_URL, reviewInputDigest: reviewInputDigest(SHA, LIVE_BODY), fetchLifecycle: () => ({ merged: false, closed: false }),
    log: () => {}, resolveSubject: async () => ({ taskId: TASK, headRefName: `run-${TASK}-1`, untasked: false, snapshot: { headSha: SHA, body: LIVE_BODY } }),
  };
  appendLedger(ledgerPath, { run_id: "earlier", task_id: TASK, step: "review.posted", state: "success", head_sha: SHA,
    pr_url: PR_URL, review_input_digest: reviewInputDigest(SHA, LIVE_BODY), proof_exec: ["executed_pass"] });
  await publishUnreadTaskCatalogHold(args as never);
  assert.deepEqual(posts.map((p) => p.state), ["pending"], "THE CLAIM: pending replaces the executed success on this head");
  assert.match(posts[0]!.description ?? "", /held: W1-T14898's dispatch_hold is unreadable \(task catalog ops-ref_moved\)/);
  const held = readLedgerLines(ledgerPath).filter((row) => row.step === "review.dispatch_hold_held");
  assert.deepEqual(held.map((row) => [row.outcome, row.evidence]), [["pending", "executed"]]);
  // The lifecycle check still applies, and a refused post is ledgered as refused, never as pending.
  const merged = join(tmp(t, "catalog-refused-merged"), "ledger.ndjson");
  await publishUnreadTaskCatalogHold({ ...args, ledgerPath: merged, fetchLifecycle: () => ({ merged: true, closed: false }) } as never);
  assert.equal(posts.length, 1, "a merged PR gets no post");
  const refusedRows = readLedgerLines(merged).filter((row) => row.step === "review.dispatch_hold_held");
  assert.equal(refusedRows.length, 1);
  assert.equal(refusedRows[0]!.outcome, "refused");
  assert.match(String(refusedRows[0]!.post_reason), /already merged/);
  // A publisher that throws is ledgered, never thrown out of the review's exit.
  const failing: string[] = [];
  await publishUnreadTaskCatalogHold({ ...args, log: (step: string) => { failing.push(step); },
    publish: async () => { throw new Error("HTTP 502"); } } as never);
  assert.deepEqual(failing, ["review.pending_post.error"]);
  // Round-8 C3: the live PR is classified through the one resolver. A generated lane's synthetic trailer on its own
  // run branch (main-repair) names no task, so the success standing on it stays.
  const repairId = "main-repair-0123456789ab";
  const untaskedSteps: string[] = [];
  await publishUnreadTaskCatalogHold({ ...args, taskId: repairId, reviewKey: repairId, log: (step: string) => { untaskedSteps.push(step); },
    resolveSubject: async () => ({ taskId: repairId, headRefName: `run-${repairId}-1795650818109`, untasked: true, snapshot: { headSha: SHA, body: "" } }) } as never);
  assert.equal(posts.length, 1, "THE CLAIM: an untasked PR's status is left as it stands");
  assert.deepEqual(untaskedSteps, ["review.dispatch_hold_untasked"]);
  // An unreadable live PR is no exemption: the hold stays unread, and pending is still published.
  const unreadable = join(tmp(t, "catalog-subject-unreadable"), "ledger.ndjson");
  const unreadableSteps: string[] = [];
  const published: string[] = [];
  await publishUnreadTaskCatalogHold({ ...args, ledgerPath: unreadable, log: (step: string) => { unreadableSteps.push(step); },
    resolveSubject: async () => { throw new Error("HTTP 502"); },
    publish: async (o: { refusal: string }) => { published.push(o.refusal); } } as never);
  assert.deepEqual(unreadableSteps, ["review.dispatch_hold_subject_unreadable"]);
  // Round-9 C1: a trailer edited after this review read its body. The pending names the body the hold was read from,
  // so the subject-freshness rule (which compares against the live PR) admits it instead of leaving the success.
  const editedBody = "Remudero-Task: W1-T14898\n\nedited after the review started";
  const digests: Array<string | undefined> = [];
  await publishUnreadTaskCatalogHold({ ...args, ledgerPath: join(tmp(t, "catalog-edited"), "ledger.ndjson"),
    resolveSubject: async () => ({ taskId: TASK, headRefName: "x", untasked: false, snapshot: { headSha: SHA, body: editedBody } }),
    publish: async (o: { reviewInputDigest?: string }) => { digests.push(o.reviewInputDigest); } } as never);
  assert.deepEqual(digests, [reviewInputDigest(SHA, editedBody)], "THE CLAIM: the write is bound to the body the hold read");
  assert.equal(published.length, 1, "an unreadable PR still publishes the unread hold");
  assert.match(published[0]!, /W1-T14898's dispatch_hold is unreadable/);
});

test("W1-T14902: the unread-hold publisher posts only pending, whatever state or verdict a caller smuggles in", async (t) => {
  for (const smuggled of ["success", "failure"] as const) {
    const ledgerPath = join(tmp(t, `pending-only-${smuggled}`), "ledger.ndjson");
    const posts: string[] = [];
    const result = await postUnreadTaskHoldGuarded({
      post: (status: { state: string }) => { posts.push(status.state); }, owner: "acme", repo: "remudero-ops", sha: SHA,
      taskId: TASK, refusal: "held: unread", ledgerPath, runId: `pending-only-${smuggled}`, prUrl: PR_URL,
      reviewInputDigest: "v2:pending-only", fetchLifecycle: () => ({ merged: false, closed: false }),
      state: smuggled, evidence: "executed", verdict: { state: smuggled }, reviewDecisionDigest: "d",
    } as never);
    assert.deepEqual(posts, ["pending"], `a smuggled ${smuggled} still posts pending`);
    assert.equal(result.effectiveState, "pending");
    const rows = readLedgerLines(ledgerPath);
    assert.ok(rows.every((row) => row.state === undefined || row.state === "pending"), "no row records a terminal state");
    assert.equal(rows.find((row) => row.step === "review.dispatch_hold_held")?.evidence, "no_evidence", "no prior: no evidence");
  }
});

test("W1-T14902: a generated lane's correlation id on its own run branch names no task, by the review lane's classification", async () => {
  const never = async (): Promise<never> => { throw new Error("no catalog is read for an untasked review"); };
  const id = "main-repair-0123456789ab";
  const read = (headRefName: TaskDispatchHoldSources["headRefName"]) =>
    readTaskDispatchHold(id, { stateDir: "/nonexistent/state", readMainPlan: never, lookup: never, headRefName });
  assert.deepEqual(await read(`run-${id}-1795650818109`), { outcome: "clear" }, "THE CLAIM: a main-repair PR reviews as before");
  assert.deepEqual(await read(async () => `run-${id}-1795650818109`), { outcome: "clear" }, "a lazily read head classifies the same");
  assert.equal((await read(async () => { throw new Error("HTTP 502"); })).outcome, "unread", "an unreadable head holds");
  // The same id on another branch is not the lane's own: it is read as a task, and nothing holds it.
  const elsewhere = await readTaskDispatchHold(id, { stateDir: "/nonexistent/state", headRefName: "feature/x",
    readMainPlan: async () => ({ byId: new Map() }), lookup: async () => ({ outcome: "absent" }) as never });
  assert.equal(elsewhere.outcome, "unread");
  // A filed task's id never asks for the head at all.
  let asked = 0;
  await readTaskDispatchHold(TASK, { stateDir: "/nonexistent/state", headRefName: async () => { asked++; return "x"; },
    readMainPlan: async () => ({ byId: new Map([[TASK, {}]]) }), lookup: never });
  assert.equal(asked, 0);
});

test("W1-T14902: the one PR task resolver names the live PR's task: its trailer, else its run branch, classified on its head", async () => {
  const reads: string[] = [];
  const pull = (body: string | undefined, ref: string | undefined) => async (path: string) => { reads.push(path); return { body, head: { ref } }; };
  assert.deepEqual(await resolvePullRequestTaskSubject(PR_URL, pull(`Updates left-pad\n\nRemudero-Task: ${TASK}\n`, "dependabot/npm/x")),
    { taskId: TASK, headRefName: "dependabot/npm/x", untasked: false, snapshot: { headSha: undefined, body: `Updates left-pad\n\nRemudero-Task: ${TASK}\n` } },
    "THE CLAIM: the trailer on the live body names the task");
  assert.deepEqual(reads, ["repos/acme/remudero-ops/pulls/910"], "one read of the pull row the URL names");
  assert.equal((await resolvePullRequestTaskSubject(PR_URL, pull(`Remudero-Task: W1-T1\nRemudero-Task: ${TASK}\n`, "x"))).taskId, TASK,
    "the last trailer wins, as everywhere else");
  assert.deepEqual(await resolvePullRequestTaskSubject(PR_URL, pull("lost its trailer", `run-${TASK}-1795650818109`)),
    { taskId: TASK, headRefName: `run-${TASK}-1795650818109`, untasked: false, snapshot: { headSha: undefined, body: "lost its trailer" } },
    "a run branch names its task when the trailer is gone");
  // Round-9 C3: the review lane's own rule — a positively identified plan-only filing names no task, so a trailerless
  // filing on a task-shaped run branch (W1-T4002's shape) keeps its success; an explicit trailer still wins.
  const filing = pull("Files three tasks", `run-${TASK}-1795650818109`);
  assert.equal((await resolvePullRequestTaskSubject(PR_URL, filing, () => true)).untasked, true, "THE CLAIM: a plan-only filing is untasked");
  assert.equal((await resolvePullRequestTaskSubject(PR_URL, pull(`Remudero-Task: ${TASK}\n`, "x"), () => true)).taskId, TASK,
    "an explicit trailer wins over the filing rule");
  assert.equal((await resolvePullRequestTaskSubject(PR_URL, pull("Updates left-pad", "dependabot/npm/x"))).untasked, true,
    "a PR naming no task reviews and arms as today");
  const repairId = "main-repair-0123456789ab";
  assert.equal((await resolvePullRequestTaskSubject(PR_URL, pull(`Remudero-Task: ${repairId}\n`, `run-${repairId}-1795650818109`))).untasked, true,
    "a generated lane's synthetic trailer on its own run branch names no task");
  assert.equal((await resolvePullRequestTaskSubject(PR_URL, pull(`Remudero-Task: ${repairId}\n`, "feature/x"))).untasked, false,
    "the same id on another branch is read as a task");
  assert.deepEqual(pullRequestTaskSubjectOf(null), { taskId: undefined, headRefName: "", untasked: true, snapshot: { headSha: undefined, body: "" } });
  assert.deepEqual(pullRequestTaskSubjectOf({ body: "b", head: { ref: "r", sha: SHA } }).snapshot, { headSha: SHA, body: "b" },
    "the subject carries the head and body it was read from");
  await assert.rejects(resolvePullRequestTaskSubject("not a pr url", pull("", "")), /no pull request/);
});

test("W1-T14902: the hold lookup judges the task the live PR names NOW, never a body or task a caller fetched earlier", async () => {
  // Round-8 C1 and C2: a trailer edited to a held task after a fix round (or a broker cache) read the old body.
  let body = "Remudero-Task: W1-T10732\n";
  const read = async () => ({ body, head: { ref: "feature/x" } });
  const sources = { stateDir: "/nonexistent/state", lookup: async () => ({ outcome: "absent" }) as never,
    readMainPlan: async () => ({ byId: new Map([["W1-T10732", {}], [TASK, { dispatch_hold: true }]]) }) };
  assert.deepEqual((await readPullRequestNamedTaskHold(PR_URL, sources, read)).reading, { outcome: "clear" });
  body = `Remudero-Task: ${TASK}\n`;
  const edited = await readPullRequestNamedTaskHold(PR_URL, sources, read);
  assert.deepEqual(edited.reading, { outcome: "held", taskId: TASK }, "THE CLAIM: the edited trailer's held task is the one judged");
  assert.equal(edited.snapshot?.body, body, "and the reading names the body it was judged on");
  const unreadable = await readPullRequestNamedTaskHold(PR_URL, sources, async () => { throw new Error("HTTP 502"); });
  assert.equal(unreadable.reading.outcome, "unread", "an unreadable pull row holds");
  assert.equal(unreadable.snapshot, undefined);
  assert.equal((await readPullRequestNamedTaskHold(undefined, sources, read)).reading.outcome, "unread", "a post naming no PR holds");
  // The default plan-only reader is the instance ledger's emitter record; an unreadable ledger records none.
  const { ledgerPlanOnlyFiling } = await import("#src/lib/task-dispatch-hold.js");
  assert.equal(ledgerPlanOnlyFiling("/nonexistent/state")(PR_URL), false);
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

test("W1-T14902: the review command's catalog-unreadable exit hands the unread hold to its publisher seam", async (t) => {
  // The wiring half of round-5 F3: the real command reaches publishUnreadTaskCatalogHold at this exit. Under the test
  // runner its default posts nothing (no real `gh`), so the seam is injected here to observe the call.
  const root = tmp(t, "catalog-unreadable-command");
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state", "plan-destination.json"), JSON.stringify({ repository: "fixture-private/ops", kinds: [] }));
  const head = (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const id = "W1-T900000";
  const published: Array<{ taskId: string; reason: string; sha: string }> = [];
  const host = {
    GIT_UNTRACKED_FILES_ALL: "--untracked-files=all", JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
    acceptedReviewAttemptId: () => undefined, reviewWorktreeAsync: { fetch: () => {} },
    materializeReviewWorktree: () => { throw Error("forbidden real materialization"); },
    realDeps: () => { throw Error("forbidden default worker graph"); },
    reviewPostedDescription: () => "fixture", liveWorkerRunIds: new Set<string>(), reviewWorkerLockId: (x: string) => `fixture-${x}`,
  } as unknown as ReviewCommandHost;
  const code = await reviewCommand(host, "42", [], {
    loadConfig: () => ({ root }) as never,
    resolveOwnerRepo: () => ({ owner: "fixture", repo: "remudero" }),
    fetchView: () => ({ body: `Remudero-Task: ${id}\n\n## Acceptance\n- fallback | grep: wrong in src/wrong.ts`, html_url: "https://github.com/fixture/remudero/pull/42",
      number: 42, head: { ref: `run-${id}-1`, sha: head }, updated_at: new Date().toISOString() }),
    fetchHead: () => {}, taskLookup: { api: async () => { throw Error("PRIVATE_API_RESPONSE"); } },
    runReview: (async () => { throw Error("forbidden review"); }) as never,
    postReviewPending: async () => { throw Error("forbidden pending claim"); },
    publishUnreadHold: async (args) => { published.push({ taskId: args.taskId, reason: args.reason, sha: args.sha }); },
  });
  assert.equal(code, 2);
  assert.equal(published.length, 1, "THE CLAIM: the unreadable exit publishes the unread hold");
  assert.equal(published[0]!.taskId, id);
  assert.equal(published[0]!.sha, head);
  assert.match(published[0]!.reason, /^ops-/);
});

test("W1-T14902: dep-review's hold subject is the body trailer's task, never its own ledger key", () => {
  const head = "dependabot/npm_and_yarn/left-pad-1.3.1";
  assert.deepEqual(pullRequestTaskSubjectOf({ body: `Updates left-pad\n\nRemudero-Task: ${TASK}\n`, head: { ref: head } }),
    { taskId: TASK, headRefName: head, untasked: false, snapshot: { headSha: undefined, body: `Updates left-pad\n\nRemudero-Task: ${TASK}\n` } },
    "THE CLAIM: the hold is read for the task the live body names");
  assert.deepEqual(pullRequestTaskSubjectOf({ body: "Updates left-pad", head: { ref: head } }), { taskId: undefined, headRefName: head, untasked: true, snapshot: { headSha: undefined, body: "Updates left-pad" } },
    "a Dependabot PR naming no task reviews and arms as today");
});

test("W1-T14902: the run's at-open arm hands its refusal reason to the caller, so its row names dispatch_hold", async () => {
  const { armAutoMergeAtOpenAsync } = await import("#src/lib/arm-auto-merge.js");
  const attempts: Array<{ outcome: string; error?: string }> = [];
  const writes: string[] = [];
  const outcome = await armAutoMergeAtOpenAsync(PR_URL, {
    headSha: async () => SHA, ledgerLines: () => [], isMerged: async () => false, say: () => {},
    armAuto: async () => { writes.push("armAuto"); }, mergeDirect: async () => { writes.push("mergeDirect"); },
    taskHold: async () => ({ outcome: "held", taskId: TASK }),
  }, false, false, (attempt) => { attempts.push(attempt); });
  assert.equal(outcome, "hold-refused");
  assert.deepEqual(writes, []);
  assert.equal(attempts.length, 1);
  assert.match(attempts[0]!.error ?? "", /W1-T14898 carries dispatch_hold/, "THE CLAIM: the reason reaches the caller");
});

test("W1-T14902: the arm's hold read hands the PR's head branch to the reader, so a main-repair PR arms as before", async (t) => {
  const root = tmp(t, "arm-head-ref");
  const config = (() => ({ root })) as unknown as Parameters<typeof readPullRequestTaskHold>[1];
  const id = "main-repair-0123456789ab";
  const never = async (): Promise<never> => { throw new Error("no catalog is read for an untasked review"); };
  const pull = (ref: string) => async () => ({ body: `Remudero-Task: ${id}\n`, head: { ref } });
  assert.deepEqual(await readPullRequestTaskHold(PR_URL, config, pull(`run-${id}-1795650818109`), { readMainPlan: never, lookup: never }),
    { outcome: "clear" }, "THE CLAIM: the lane's own branch classifies it untasked");
  assert.equal((await readPullRequestTaskHold(PR_URL, config, pull("feature/x"),
    { readMainPlan: async () => ({ byId: new Map() }), lookup: async () => ({ outcome: "absent" }) as never })).outcome, "unread");
});

test("W1-T14902: an ops task's status projection keeps a public-safe description naming the hold", async () => {
  const posted: string[] = [];
  const project = catalogReviewPoster("ops", (async (options: { description?: string }) => { posted.push(options.description ?? ""); }) as never);
  const send = (state: string, description: string) => project({ owner: "acme", repo: "remudero", sha: SHA, state, description } as never);
  await send("pending", "remudero-review: pending — held: W1-T14898 carries dispatch_hold; it merges after the operator releases the hold");
  await send("pending", "remudero-review: pending — held: W1-T14898's dispatch_hold is unreadable (task catalog ops-private-reason)");
  await send("pending", "remudero-review: pending — reviewing");
  await send("success", "remudero-review: PASS — 3 criteria");
  assert.match(posted[0]!, /held: the named task carries dispatch_hold/, "THE CLAIM: a held ops task's PR says why it waits");
  assert.match(posted[1]!, /held: the named task's dispatch_hold is unreadable/);
  assert.doesNotMatch(posted.slice(0, 2).join("\n"), /W1-T14898|ops-private-reason/, "and names neither the private task nor its read failure");
  assert.match(posted[2]!, /detailed evidence retained on host/, "any other ops status keeps the private projection");
  assert.match(posted[3]!, /^remudero-review: success — detailed evidence retained on host/);
});

test("W1-T14902: a review whose public plan at origin/main is unreadable publishes the unread hold before anything else", async (t) => {
  const root = tmp(t, "main-unreadable");
  mkdirSync(join(root, "state"));
  const { execFileSync } = await import("node:child_process");
  // The managed checkout is a real directory (the subject check refuses a symlink) with no refs/remotes/origin/main.
  const dir = join(root, "repos", "subject");
  mkdirSync(join(root, "repos"));
  renameSync(gitRepo({ seedCommit: false, kind: "main-unreadable-subject" }).dir, dir);
  mkdirSync(join(dir, "plan"));
  const git = (...argv: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", ...argv], { encoding: "utf8" });
  writeFileSync(join(dir, "plan", "tasks.yaml"), "[]\n");
  git("add", "plan");
  git("commit", "-qm", "plan");
  git("remote", "add", "origin", "https://github.com/fixture/subject.git");
  const head = git("rev-parse", "HEAD").trim();
  const id = "W1-T900000";
  const published: Array<{ taskId: string; source?: string; reason: string }> = [];
  const host = {
    GIT_UNTRACKED_FILES_ALL: "--untracked-files=all", JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
    acceptedReviewAttemptId: () => undefined, reviewWorktreeAsync: { fetch: () => {} },
    reviewSubjectGit: (dir: string, argv: string[]) => execFileSync("git", ["-C", dir, ...argv], { encoding: "utf8" }),
    materializeReviewWorktree: () => { throw Error("forbidden real materialization"); },
    realDeps: () => { throw Error("forbidden default worker graph"); },
    reviewPostedDescription: () => "fixture", liveWorkerRunIds: new Set<string>(), reviewWorkerLockId: (x: string) => `fixture-${x}`,
  } as unknown as ReviewCommandHost;
  await reviewCommand(host, "42", ["--repo", "fixture/subject"], {
    loadConfig: () => ({ root }) as never,
    resolveOwnerRepo: () => ({ owner: "fixture", repo: "remudero" }),
    fetchView: () => ({ body: `Remudero-Task: ${id}\n\n## Acceptance\n- fallback | grep: wrong in src/wrong.ts`, html_url: "https://github.com/fixture/subject/pull/42",
      number: 42, head: { ref: `run-${id}-1`, sha: head }, updated_at: new Date().toISOString() }),
    fetchHead: () => {}, taskLookup: { api: async () => { throw Error("PRIVATE_API_RESPONSE"); } },
    runReview: (async () => { throw Error("forbidden review"); }) as never,
    postReviewPending: async () => { throw Error("forbidden pending claim"); },
    publishUnreadHold: async (args) => { published.push({ taskId: args.taskId, source: args.source, reason: args.reason }); },
  }).catch(() => 2);
  assert.ok(published.length >= 1, `THE CLAIM: the unread hold is published: ${JSON.stringify(published)}`);
  assert.equal(published[0]!.taskId, id);
  assert.equal(published[0]!.source, "public plan at origin/main");
});

test("W1-T14902: a fresh broker read never joins a GET already under way, which may predate a trailer edit", { timeout: 60_000 }, async (t) => {
  // Round-9 C2: the arm's act-time read asks for freshness; joining an in-flight upstream GET that left before a
  // maintainer's edit served the pre-edit body and the hold read clear.
  const { GhReadBroker } = await import("#src/lib/gh-read-broker.js");
  const { clockFromMillisFn } = await import("#src/lib/clock.js");
  const dir = tmp(t, "broker-fresh");
  let now = 1_800_000_000_000;
  const calls: Array<{ resolve: (r: { stdout: string; stderr: string; exitCode: number }) => void }> = [];
  const exec = (args: string[]) => args[1] === "user" ? Promise.resolve({ stdout: "octo\n", stderr: "", exitCode: 0 })
    : new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => calls.push({ resolve }));
  const broker = new GhReadBroker(join(dir, "broker"), exec as never, clockFromMillisFn(() => now),
    async (ms: number) => { now += ms; await new Promise((resolve) => setImmediate(resolve)); }, () => 1e12);
  const until = async (predicate: () => boolean, what: string) => {
    const deadline = Date.now() + 30_000;
    while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.ok(predicate(), `timed out waiting for ${what}`);
  };
  const row = (body: string) => ({ stdout: `HTTP/2.0 200 OK\r\nETag: "${body.length}"\r\n\r\n${JSON.stringify({ body })}`, stderr: "", exitCode: 0 });
  const args = ["api", "repos/acme/remudero-ops/pulls/910"];
  const stale = broker.read({ op: "read", args, class: "background", caller: "sweep" });
  await until(() => calls.length === 1, "the sweep's GET to leave");
  const joiner = broker.read({ op: "read", args, class: "background", caller: "board" });
  // The maintainer edits the trailer now; the arm's fresh read arrives after the edit, with the old GET still out.
  const fresh = broker.read({ op: "read", args, class: "agent", caller: "arm", fresh: true });
  calls[0]!.resolve(row("Remudero-Task: W1-T10732"));
  assert.equal(JSON.parse((await stale).stdout).body, "Remudero-Task: W1-T10732");
  assert.equal((await joiner).outcome, "coalesced", "a read with no freshness asked still shares the GET in flight");
  await until(() => calls.length === 2, "the fresh read's own GET");
  calls[1]!.resolve(row(`Remudero-Task: ${TASK}`));
  assert.equal(JSON.parse((await fresh).stdout).body, `Remudero-Task: ${TASK}`, "THE CLAIM: the fresh read sees the edit");
  assert.equal(calls.length, 2);
});
