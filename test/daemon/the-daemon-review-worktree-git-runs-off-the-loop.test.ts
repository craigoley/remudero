import * as sweepLib from "#src/lib/sweep.js";
import { buildSweepEffects } from "#src/lib/sweep.js";
import { judgeReview } from "#src/lib/review.js";
import { appendLedger } from "#src/lib/ledger.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import * as task from "#src/run-task.js";
import * as reclaim from "#src/lib/review-worktree-reclaim.js";
import { withMaterializedWorktree } from "#src/cli/commands/review.js";
import { runDaemon } from "#src/lib/daemon.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import type { Config } from "#src/lib/config.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
type Materialize = (...args: Parameters<typeof task.materializeReviewWorktree>) => Promise<ReturnType<typeof task.materializeReviewWorktree>>;
type Preserve = (...args: Parameters<typeof task.preserveStagedFixOwnerResidue>) => Promise<string>;
type Sweep = (...args: Parameters<typeof reclaim.sweepStrandedReviewWorktrees>) => Promise<ReturnType<typeof reclaim.sweepStrandedReviewWorktrees>>;
// Base fallbacks execute the original real paths, so red means blocked timing rather than a missing export.
const materialize = (task as unknown as { materializeReviewWorktreeAsync?: Materialize }).materializeReviewWorktreeAsync
  ?? ((...args: Parameters<Materialize>) => Promise.resolve(task.materializeReviewWorktree(...args)));
const preserve = (task as unknown as { preserveStagedFixOwnerResidueAsync?: Preserve }).preserveStagedFixOwnerResidueAsync
  ?? ((...args: Parameters<Preserve>) => Promise.resolve(task.preserveStagedFixOwnerResidue(...args)));
const sweep = (reclaim as unknown as { sweepStrandedReviewWorktreesAsync?: Sweep }).sweepStrandedReviewWorktreesAsync
  ?? ((...args: Parameters<Sweep>) => Promise.resolve(reclaim.sweepStrandedReviewWorktrees(...args)));

function fixture() {
  const repo = gitRepo({ kind: "review-worktree-off-loop" });
  const scratch = mkdtempSync(join(tmpdir(), "rmd-review-loop-order-"));
  const config = { root: join(scratch, "runtime") } as Config;
  mkdirSync(join(config.root, "worktrees"), { recursive: true });
  writeFileSync(join(repo.dir, "tracked.txt"), "base\n");
  repo.git("add", "tracked.txt"); repo.git("commit", "-qm", "fixture base");
  const sha = repo.git("rev-parse", "HEAD").trim();
  repo.git("remote", "add", "origin", repo.dir);
  repo.git("update-ref", "refs/pull/1/head", sha);
  const order = join(scratch, "order"), bin = join(scratch, "bin");
  mkdirSync(bin); writeFileSync(order, "");
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "start $$" >> ${quote(order)}\nsleep 0.05\n${quote(realGit)} "$@"\nrc=$?\necho "end $$" >> ${quote(order)}\nexit $rc\n`, { mode: 0o755 });
  return { repo, scratch, config, sha, order, bin,
    cleanup() { repo.cleanup(); rmSync(scratch, { recursive: true, force: true }); } };
}
async function measure<T>(fx: ReturnType<typeof fixture>, body: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  writeFileSync(fx.order, ""); process.env.PATH = `${fx.bin}:${saved}`;
  const beat = setInterval(() => appendFileSync(fx.order, "tick\n"), 1);
  try {
    const result = await body();
    const rows = readFileSync(fx.order, "utf8").trim().split("\n");
    const starts = rows.flatMap((row, at) => row.startsWith("start ") ? [{ pid: row.slice(6), at }] : []);
    assert.ok(starts.length > 0, "positive control: the actual path spawned Git");
    for (const { pid, at } of starts) {
      const end = rows.findIndex((row, index) => index > at && row === `end ${pid}`);
      assert.ok(end > at, `Git ${pid} completed`);
      assert.ok(rows.slice(at + 1, end).includes("tick"), `the loop did not turn during Git ${pid}`);
    }
    return result;
  } finally { clearInterval(beat); process.env.PATH = saved; }
}

test("W1-T11459 criterion 1: materialization turns the loop during every real Git child", async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  let path: string | undefined;
  try {
    const result = await measure(fx, () => materialize(fx.config, fx.repo.dir, 1, fx.sha));
    path = result.worktreePath;
    assert.ok(path, "a complete checkout is returned");
    assert.equal(readFileSync(join(path, "tracked.txt"), "utf8"), "base\n");
  } finally {
    if (path) { reclaim.releaseReviewWorktree(path); fx.repo.git("worktree", "remove", "--force", path); }
  }
  await materializeControls(fx);
  await reviewCommandWiring(fx);
  await sameTickMaterializationOwnership(fx, t);
});

test("W1-T11459 criterion 1: staged recovery awaits temporary-index Git and preserves the exact tree", async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  writeFileSync(join(fx.repo.dir, "tracked.txt"), "staged\n"); fx.repo.git("add", "tracked.txt");
  const expected = fx.repo.git("write-tree").trim();
  const ref = await measure(fx, () => preserve(fx.repo.dir, fx.repo.dir, "run-fixture", fx.sha));
  assert.equal(fx.repo.git("rev-parse", `${ref}^{tree}`).trim(), expected);
  assert.equal(readFileSync(join(fx.repo.dir, "tracked.txt"), "utf8"), "staged\n");
  assert.equal(fx.repo.git("write-tree").trim(), expected, "the owner's real index is untouched");
  await recoveryDefaults(fx);
});

test("W1-T11459 criterion 1: stranded sweep awaits head reads, remote evidence and removal", async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const name = `review-PR1-${Date.now() - reclaim.DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS * 2}`;
  const path = join(fx.config.root, "worktrees", name);
  fx.repo.git("worktree", "add", "--detach", path, fx.sha);
  const result = await measure(fx, () => sweep(fx.config, () => {}, { isLive: () => false }));
  assert.deepEqual(result.reclaimed, [name]);
  assert.equal(existsSync(path), false, "removal finished before the sweep returned");
  const heldName = `review-PR1-${Date.now() - reclaim.DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS * 2}`;
  const heldPath = join(fx.config.root, "worktrees", heldName);
  fx.repo.git("worktree", "add", "--detach", heldPath, fx.sha);
  let reading!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  const remoteGate = new Promise<void>(resolve => { resume = resolve; });
  const pending = sweep(fx.config, () => {}, {
    isLive: reclaim.reviewWorktreeIsHeld,
    readRemoteHeadSha: async () => { reading(); await remoteGate; return fx.sha; },
  } as never);
  try {
    await reached(started, pending, "remote-head read");
    reclaim.holdReviewWorktree(heldPath); resume();
    const held = await pending;
    assert.deepEqual(held.reclaimed, []);
    assert.equal(held.kept[0]?.reason, "live-review", "ownership acquired during awaited Git must be revalidated");
    assert.equal(existsSync(heldPath), true);
    reclaim.releaseReviewWorktree(heldPath);
    assert.deepEqual((await sweep(fx.config, () => {}, { isLive: () => false })).reclaimed, [heldName]);
  } finally {
    resume(); await pending; reclaim.releaseReviewWorktree(heldPath);
    if (existsSync(heldPath)) fx.repo.git("worktree", "remove", "--force", heldPath);
  }
  await reclaimFailureControls(fx);
  await daemonReclaimWiring(fx);
});

test("W1-T11459 criterion 2: teardown finishes before its hold is released or its caller resumes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-teardown-order-"));
  let finish: () => void = () => {};
  try {
    reclaim.holdReviewWorktree(root);
    const events: string[] = [];
    let heldAtRemovalEnd = false;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const run = withMaterializedWorktree(root, root, async () => { events.push("body"); return "reviewed"; }, async () => {
      events.push("removal-start"); await gate;
      heldAtRemovalEnd = reclaim.reviewWorktreeIsHeld(root);
      events.push("removal-end");
    }).then(value => { events.push("caller"); return value; });
    await delay(0);
    assert.deepEqual(events, ["body", "removal-start"], "the caller cannot reuse the path during removal");
    assert.equal(reclaim.reviewWorktreeIsHeld(root), true);
    finish();
    assert.equal(await run, "reviewed");
    assert.equal(heldAtRemovalEnd, true, "the hold lasts through removal");
    assert.deepEqual(events, ["body", "removal-start", "removal-end", "caller"]);
    assert.equal(reclaim.reviewWorktreeIsHeld(root), false);
  } finally { finish(); await new Promise<void>(resolve => setImmediate(resolve)); reclaim.releaseReviewWorktree(root); rmSync(root, { recursive: true, force: true }); }
});

test("W1-T11459 criterion 2: the daemon ticker waits for a stranded sweep before its light pass", async () => {
  const plan = loadPlanFromYaml("- id: A\n  title: fixture\n  repo: remudero\n  type: implement\n  status: queued\n", "fixture");
  const events: string[] = [];
  let finishRun!: () => void;
  const runGate = new Promise<void>(resolve => { finishRun = resolve; });
  const result = await runDaemon(plan, {
    refreshMerged: () => () => false,
    isCreditIndeterminate: () => false,
    readLedgerLines: () => [],
    runOne: async () => { await runGate; const completed: task.RunResult = { taskId: "A", runId: "A-run", merged: true, verdict: "merged", costUsd: 0 }; return completed; },
    sleep: async ms => { await delay(ms); },
    sweepStrandedReviewWorktrees: async () => { events.push("start"); await delay(10); events.push("removed"); },
    sweepLight: async () => { events.push("light"); finishRun(); },
  }, { max: 1, pollIntervalMs: 1, headroomEnabled: false });
  assert.deepEqual(result.attempted, ["A"]);
  assert.ok(events.includes("light"), "positive control: the real in-flight ticker ran");
  assert.ok(events.includes("removed"), "the awaited sweep must finish before the caller resumes");
  assert.ok(events.indexOf("removed") < events.indexOf("light"), JSON.stringify(events));
});

test("W1-T11459 criterion 2: a plan round awaits materialization and removal before releasing its claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-plan-order-"));
  const tree = join(root, "tree"), ledgerPath = join(root, "ledger.ndjson");
  const events: string[] = [];
  let entered!: () => void, ready!: (value: unknown) => void, removing!: () => void, finish!: () => void;
  const called = new Promise<void>(resolve => { entered = resolve; });
  const materialized = new Promise<unknown>(resolve => { ready = resolve; });
  const removalStarted = new Promise<void>(resolve => { removing = resolve; });
  const removalGate = new Promise<void>(resolve => { finish = resolve; });
  const head = "a".repeat(40), planPath = "plan/tasks.d/W1-T11459-fixture.yaml";
  const pr = { prNumber: 9000, prUrl: "https://github.com/fixture/loop/pull/9000", headSha: head,
    headRefName: `ci-friction-garden-${Date.now()}`, isPlanFiling: true, checksState: "red", reviewState: "pending",
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(), autoMergeArmed: false } as never;
  let returned = false, heldAtRemovalEnd = false;
  const effects = buildSweepEffects({
    owner: "fixture", repo: "loop", config: { root } as Config, repoRoot: REPO_ROOT,
    ledgerPath, runId: "review-plan-order", log: () => {}, plan: { tasks: [], byId: new Map() } as never,
    dispatchFixPreflightStandDownImpl: async () => false,
    ghJsonImpl: () => ({ head: { ref: (pr as { headRefName: string }).headRefName, sha: head },
      user: { login: "remudero-fleet[bot]" }, title: "chore(plan): fixture",
      body: `## Acceptance\n- claim: fixture shard is filed\n  proof: grep: id: W1-T11459 in ${planPath}` }),
    fetchPrDiffFilesImpl: async () => [planPath], fixBranchClaimKeyImpl: () => "review-plan-order",
    materializePlanRoundWorktreeImpl: () => { events.push("materialize"); entered(); return materialized; },
    restRollupForImpl: async () => [], fetchCiFailuresImpl: () => [],
    runPlanScopedFixRoundImpl: async (input: { worktreePath: string }) => {
      assert.equal(input.worktreePath, tree); assert.equal(readFileSync(join(tree, "ready"), "utf8"), "ready");
      events.push("round"); return { outcome: "refused", reason: "private fixture complete" };
    },
    reviewWorktreeRemoveImpl: async (_repo: string, path: string) => {
      events.push("removing"); assert.equal(path, tree); removing(); await removalGate;
      heldAtRemovalEnd = reclaim.reviewWorktreeIsHeld(tree);
      rmSync(tree, { recursive: true, force: true }); events.push("removed");
    },
    worktreeRemoveImpl: () => { throw new Error("review must not use the synchronous general removal port"); },
  } as never);
  const work = Promise.resolve(effects.dispatchPlanGateRound!(pr)).then(value => { returned = true; events.push("caller"); return value; });
  try {
    await reached(called, work, "materialization"); await delay(0);
    assert.equal(returned, false, "a plan round cannot treat an unresolved materialization as unavailable");
    assert.deepEqual(events, ["materialize"]);
    mkdirSync(tree); writeFileSync(join(tree, "ready"), "ready"); reclaim.holdReviewWorktree(tree);
    ready({ worktreePath: tree });
    await removalStarted;
    assert.equal(returned, false, "the caller cannot resume while cleanup is pending");
    assert.equal(reclaim.reviewWorktreeIsHeld(tree), true);
    assert.ok(readdirSync(join(root, "state", "inflight")).length > 0, "the real claim remains held during cleanup");
    finish(); await work;
    assert.deepEqual(events, ["materialize", "round", "removing", "removed", "caller"]);
    assert.equal(heldAtRemovalEnd, true, "the review hold survives the last removal turn");
    assert.equal(reclaim.reviewWorktreeIsHeld(tree), false);
    assert.equal(readdirSync(join(root, "state", "inflight")).length, 0);
  } finally {
    ready({ failure: { message: "fixture released" } }); finish(); await work;
    reclaim.releaseReviewWorktree(tree); rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T11459 criterion 2: command review reuse awaits readiness and teardown before its fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-reuse-order-")), tree = join(root, "head");
  const ledgerPath = join(root, "ledger.ndjson"), taskId = "W1-T11459";
  const url = "https://github.com/fixture/loop/pull/9001", priorHead = "d".repeat(40), head = "a".repeat(40);
  const claim = "the private fixture proof is present", proof = "grep: private-fixture in src/fixture.ts";
  const prior = judgeReview([{ claim, proof }], { diff: "diff --git a/src/fixture.ts b/src/fixture.ts\n+private-fixture\n",
    report: claim, headCheckoutDir: tree, execProof: () => "pass" });
  appendLedger(ledgerPath, { run_id: "prior", task_id: taskId, step: "review.posted",
    state: prior.state, head_sha: priorHead, pr_url: url, decision_verdict: prior });
  let entered!: () => void, ready!: (value: unknown) => void, removing!: () => void, finish!: () => void;
  const called = new Promise<void>(resolve => { entered = resolve; });
  const materialized = new Promise<unknown>(resolve => { ready = resolve; });
  const removalStarted = new Promise<void>(resolve => { removing = resolve; });
  const removalGate = new Promise<void>(resolve => { finish = resolve; });
  const events: string[] = []; let returned = false, heldAtRemovalEnd = false;
  const effects = task.buildSweepEffects({
    owner: "fixture", repo: "loop", localRepoName: "not-loop", config: { root } as Config,
    ledgerPath, runId: "reuse-order", plan: { tasks: [], byId: new Map([[taskId, { id: taskId, files: [] }]]) } as never,
    log: () => {}, reviewRunner: async () => { events.push("fallback"); return 0; },
    materializeReviewWorktreeImpl: () => { events.push("materialize"); entered(); return materialized; },
    buildBaseProofDirImpl: (_criteria: unknown, path: string) => {
      assert.equal(path, tree); assert.equal(readFileSync(join(tree, "ready"), "utf8"), "ready");
      events.push("base"); return {};
    },
    reviewWorktreeRemoveImpl: async (_repo: string, path: string) => {
      assert.equal(path, tree); events.push("removing"); removing(); await removalGate;
      heldAtRemovalEnd = reclaim.reviewWorktreeIsHeld(tree);
      rmSync(tree, { recursive: true, force: true }); events.push("removed");
    },
    worktreeRemoveImpl: () => { throw new Error("review reuse must select its async review removal port"); },
  } as never);
  const pr = { prNumber: 9001, prUrl: url, taskId, headSha: head, reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(), autoMergeArmed: false,
    body: claim, currentOwnDiffDigest: "sha256:current", currentMergeBaseSha: "base-current" } as never;
  const work = Promise.resolve(withLiveWritesAllowed(() => effects.postReview!(pr, { kind: "discriminate-only", judgedHeadSha: priorHead })))
    .then(value => { returned = true; events.push("caller"); return value; });
  try {
    await reached(called, work, "materialization"); await delay(0);
    assert.equal(returned, false, "review reuse must await readiness rather than falling back on a Promise");
    assert.deepEqual(events, ["materialize"]);
    mkdirSync(tree); writeFileSync(join(tree, "ready"), "ready"); reclaim.holdReviewWorktree(tree);
    ready({ worktreePath: tree }); await removalStarted;
    assert.equal(returned, false); assert.equal(events.includes("fallback"), false, "fallback waits for teardown");
    finish(); await work;
    assert.deepEqual(events, ["materialize", "base", "removing", "removed", "fallback", "caller"]);
    assert.equal(heldAtRemovalEnd, true, "reuse retains ownership through removal");
    assert.equal(reclaim.reviewWorktreeIsHeld(tree), false);
  } finally {
    ready({ failure: { message: "fixture released" } }); finish(); await work;
    reclaim.releaseReviewWorktree(tree); rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T11459 criterion 2: sweep awaits a recovery reference, reset and removal before re-reading ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-recovery-adapter-")), owner = join(root, "owner");
  mkdirSync(owner);
  const id = "W1-T11459", head = "a".repeat(40), branch = `run-${id}-${Date.now()}`;
  const ref = `refs/rmd-recovery/fix-dirty/${branch}/${head}/${"b".repeat(40)}`;
  const events: string[] = [], rows: Array<Record<string, unknown>> = [];
  let preserveStarted!: () => void, resetStarted!: () => void, removeStarted!: () => void;
  let save!: () => void, reset!: () => void, remove!: () => void;
  const preserving = new Promise<void>(r => { preserveStarted = r; }), saved = new Promise<void>(r => { save = r; });
  const resetting = new Promise<void>(r => { resetStarted = r; }), resetDone = new Promise<void>(r => { reset = r; });
  const removing = new Promise<void>(r => { removeStarted = r; }), removedDone = new Promise<void>(r => { remove = r; });
  let removed = false, returned = false;
  const fixtureTask = { id, title: "private recovery adapter", repo: "loop", type: "implement",
    risk: "high", budget_usd: 0, files: ["src/fixture.ts"], acceptance: [], status: "queued" };
  const plan = { tasks: [fixtureTask], byId: new Map([[id, fixtureTask]]) };
  const pr = { prNumber: 9002, prUrl: "https://github.com/fixture/loop/pull/9002", taskId: id,
    headSha: head, headRefName: branch, reviewState: "failure", checksState: "green", unmetCriteria: [],
    priorStrikes: 0, lastActivityAt: new Date().toISOString(), autoMergeArmed: false } as never;
  const effects = buildSweepEffects({
    owner: "fixture", repo: "loop", config: { root } as Config, ledgerPath: join(root, "ledger.ndjson"),
    runId: "recovery-adapter", plan, log: (step: string, fields: Record<string, unknown> = {}) => rows.push({ step, ...fields }),
    contributorAdmissionImpl: async () => {}, dispatchFixPreflightStandDownImpl: async () => false,
    ghLiveStateImpl: () => ({ ok: true, state: "OPEN" }), reloadPlanForFixImpl: () => plan,
    ghJsonImpl: () => ({ headRefName: branch, headRefOid: head, body: `Remudero-Task: ${id}`, files: ["src/fixture.ts"] }),
    registeredWorktreeOwnerImpl: () => { if (removed) throw new Error("private end after verified removal"); return owner; },
    registeredOwnerRecovery: {
      capture: () => ({ path: owner, pathState: "managed", attachmentState: "exact", treeState: "tracked_dirty",
        remoteState: "exact", historyState: "contained", claimState: "clear", processState: "clear",
        ageMs: 0, localSha: head, remoteSha: head }),
      preserveTrackedDirty: async () => { events.push("preserve"); preserveStarted(); await saved; events.push("preserved"); return ref; },
      resetTrackedDirty: async () => { events.push("reset"); resetStarted(); await resetDone; events.push("reset-done"); },
      remove: async () => { events.push("remove"); removeStarted(); await removedDone; removed = true; events.push("removed"); },
    },
    decideRegisteredFixOwnerRecoveryImpl: task.decideRegisteredFixOwnerRecovery,
    fixBranchClaimKeyImpl: () => "recovery-adapter",
    boundedWorktreeOwnerPathImpl: (path: string) => path,
    createFixRungWorktreeImpl: () => { throw new Error("fixture must not create a worker checkout"); },
    spawnImpl: async () => { throw new Error("fixture must not spawn a worker"); },
  } as never);
  const work = Promise.resolve(effects.dispatchFix(pr, { unmetCriteria: [] })).then(value => { returned = true; return value; });
  try {
    await reached(preserving, work, "owner preservation"); await delay(0);
    assert.deepEqual(events, ["preserve"], "no reset or removal may begin while the recovery result is unresolved");
    assert.equal(returned, false);
    save(); await resetting;
    assert.equal(rows.find(row => row.step === "sweep.fix.checkout_owner_dirty_preserved")?.recovery_ref, ref,
      "the receipt contains the verified ref, never an unresolved Promise");
    assert.deepEqual(events, ["preserve", "preserved", "reset"]);
    reset(); await removing;
    assert.equal(returned, false, "ownership may not be re-read before removal settles");
    remove();
    const outcome = await work;
    assert.deepEqual(outcome, { claimDeclined: true, ownerRecoveryReason: "worktree_registry_reread_failed" });
    assert.deepEqual(events, ["preserve", "preserved", "reset", "reset-done", "remove", "removed"]);
    const decline = { step: "sweep.fix.checkout_claim_declined", task_id: id, reason: "registered_worktree_owner",
      owner_recovery_reason: "owner_dirty_recovery_preserve_failed", pr_number: 9002, head_sha: head,
      branch, worktree_path: owner };
    assert.equal(await effects.fixOwnerReclaimableAtHold!(pr, decline), true, "a backstop awaits the same async preservation capsule");
    const lines = Array.from({ length: sweepLib.FIX_CLAIM_DECLINE_BACKSTOP }, () => ({ ...decline }));
    const readHold = (sweepLib as unknown as { fixDispatchHoldAtHeadAsync?: typeof sweepLib.fixDispatchHoldAtHead }).fixDispatchHoldAtHeadAsync
      ?? sweepLib.fixDispatchHoldAtHead;
    assert.equal(await readHold(pr, lines, () => true, effects.fixOwnerReclaimableAtHold), undefined);
  } finally {
    save(); reset(); remove(); await work;
    rmSync(root, { recursive: true, force: true });
  }
});

async function reached(signal: Promise<void>, work: Promise<unknown>, phase: string): Promise<void> {
  await Promise.race([signal, work.then(() => { throw new Error("fixture ended before reaching " + phase); })]);
}

type RecoveryName = "preserveTrackedDirtyFixOwner" | "preserveOrDiscardFixOwnerResidue"
  | "preserveStagedFixOwnerResidue" | "resetTrackedDirtyFixOwner" | "preserveAndClearUntrackedFixOwner"
  | "preserveStaleDirtyFixOwner" | "clearStaleDirtyFixOwner" | "removeAbandonedFixWorktreeOwner";
// Retain base execution for the semantic timing falsifier; restored code selects the real async twins.
type RecoveryTwin<K extends RecoveryName> = (...args: Parameters<typeof task[K]>) =>
  ReturnType<typeof task[K]> | Promise<ReturnType<typeof task[K]>>;
function recoveryTwin<K extends RecoveryName>(name: K): RecoveryTwin<K> {
  return (Reflect.get(task, `${name}Async`) ?? task[name]) as unknown as RecoveryTwin<K>;
}

async function recoveryDefaults(fx: ReturnType<typeof fixture>): Promise<void> {
  const owner = join(fx.config.root, "worktrees", "recovery-defaults");
  const branch = "run-private-recovery-defaults";
  fx.repo.git("worktree", "add", "--detach", owner, fx.sha);
  const tracked = join(owner, "tracked.txt");
  const git = (...args: string[]) => fx.repo.git("-C", owner, ...args).trim();
  try {
    writeFileSync(tracked, "tracked recovery\n");
    const ref = await measure(fx, () => Promise.resolve(recoveryTwin("preserveTrackedDirtyFixOwner")(fx.repo.dir, owner, branch, fx.sha)));
    assert.equal(fx.repo.git("show", `${ref}:tracked.txt`), "tracked recovery");
    // The same verified immutable ref is reusable, with no second destructive state transition.
    assert.equal(await measure(fx, () => Promise.resolve(recoveryTwin("preserveTrackedDirtyFixOwner")(fx.repo.dir, owner, branch, fx.sha))), ref);
    await measure(fx, () => Promise.resolve(recoveryTwin("resetTrackedDirtyFixOwner")(owner, fx.sha)));
    assert.equal(readFileSync(tracked, "utf8"), "base\n");
    const clean = await measure(fx, () => Promise.resolve(recoveryTwin("preserveOrDiscardFixOwnerResidue")(fx.repo.dir, owner, branch, fx.sha)));
    assert.equal(typeof clean, "object");
    if (typeof clean === "object") assert.deepEqual(clean.stagedPaths, []);

    writeFileSync(tracked, "index only\n"); git("add", "tracked.txt");
    writeFileSync(tracked, "base\n");
    const residue = await measure(fx, () => Promise.resolve(recoveryTwin("preserveOrDiscardFixOwnerResidue")(fx.repo.dir, owner, branch, fx.sha)));
    assert.equal(typeof residue, "object");
    if (typeof residue === "object") assert.equal(residue.refusal, "owner_dirty_staged_only_refused");
    const staged = await measure(fx, () => Promise.resolve(recoveryTwin("preserveStagedFixOwnerResidue")(fx.repo.dir, owner, branch, fx.sha)));
    assert.equal(fx.repo.git("show", `${staged}:tracked.txt`), "index only");
    await recoveryTwin("resetTrackedDirtyFixOwner")(owner, fx.sha);

    const loose = join(owner, "loose.txt"); writeFileSync(loose, "untracked bytes\n");
    const untracked = await measure(fx, () => Promise.resolve(recoveryTwin("preserveAndClearUntrackedFixOwner")(fx.repo.dir, owner, branch, fx.sha)));
    assert.equal(fx.repo.git("show", `${untracked}:loose.txt`), "untracked bytes");
    assert.equal(existsSync(loose), false);

    writeFileSync(tracked, "saved index\n"); git("add", "tracked.txt");
    writeFileSync(tracked, "saved worktree\n"); writeFileSync(loose, "saved loose\n");
    const saved = await measure(fx, () => Promise.resolve(recoveryTwin("preserveStaleDirtyFixOwner")(fx.config.root, fx.repo.dir, owner, branch, fx.sha)));
    assert.ok(readFileSync(join(saved, "index.patch"), "utf8").includes("+saved index"));
    assert.ok(readFileSync(join(saved, "worktree.patch"), "utf8").includes("+saved worktree"));
    assert.ok(readFileSync(join(saved, "untracked.patch"), "utf8").includes("+saved loose"));
    assert.equal(readFileSync(tracked, "utf8"), "saved worktree\n", "durable preservation does not reset the owner");
    await measure(fx, () => Promise.resolve(recoveryTwin("clearStaleDirtyFixOwner")(owner, fx.sha)));
    assert.equal(readFileSync(tracked, "utf8"), "base\n"); assert.equal(existsSync(loose), false);

    await assert.rejects(async () => recoveryTwin("preserveTrackedDirtyFixOwner")(fx.repo.dir, owner, branch, "0".repeat(40)), /HEAD changed/);
    await assert.rejects(async () => recoveryTwin("preserveTrackedDirtyFixOwner")(fx.repo.dir, owner, branch, fx.sha), /no HEAD-relative tracked diff/);
    await assert.rejects(async () => recoveryTwin("preserveStaleDirtyFixOwner")(fx.config.root, fx.repo.dir, owner, branch, fx.sha), /untracked state is empty/);
    await measure(fx, () => Promise.resolve(recoveryTwin("removeAbandonedFixWorktreeOwner")(fx.repo.dir, owner)));
    assert.equal(existsSync(owner), false);
  } finally {
    if (existsSync(owner)) fx.repo.git("worktree", "remove", "--force", owner);
  }
}

async function reclaimFailureControls(fx: ReturnType<typeof fixture>): Promise<void> {
  const name = `review-PR1-${Date.now() - reclaim.DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS * 2}`;
  const path = join(fx.config.root, "worktrees", name);
  fx.repo.git("worktree", "add", "--detach", path, fx.sha);
  const faultBin = join(fx.scratch, "fault-bin"); mkdirSync(faultBin);
  const savedPath = process.env.PATH;
  try {
    for (const [tail, reason] of [["rev-parse HEAD", "git-unreadable"], ["ls-remote origin refs/pull/1/head", "remote-unreadable"]] as const) {
      writeFileSync(join(faultBin, "git"), `#!/bin/sh\ncase "$*" in *${quote(tail)}) echo "private Git failure" >&2; exit 1;; esac\nexec ${quote(realGit)} "$@"\n`, { mode: 0o755 });
      process.env.PATH = `${faultBin}:${savedPath}`;
      const result = await sweep(fx.config, () => {}, { isLive: () => false });
      assert.equal(result.kept.find(row => row.name === name)?.reason, reason);
      assert.equal(existsSync(path), true, "failed Git evidence never authorizes reclamation");
    }
    process.env.PATH = savedPath;
    const refused = await sweep(fx.config, () => {}, {
      isLive: () => false,
      removeWorktree: async () => { throw new Error("private async removal failure"); },
    });
    assert.equal(refused.kept.find(row => row.name === name)?.reason, "removal-failed");
    assert.equal(existsSync(path), true);
    assert.deepEqual((await sweep(fx.config, () => {}, { isLive: () => false })).reclaimed, [name]);
  } finally {
    process.env.PATH = savedPath;
    if (existsSync(path)) fx.repo.git("worktree", "remove", "--force", path);
  }
}

async function materializeControls(fx: ReturnType<typeof fixture>): Promise<void> {
  const remove = (path: string) => { reclaim.releaseReviewWorktree(path); fx.repo.git("worktree", "remove", "--force", path); };
  fx.repo.git("update-ref", "-d", "refs/pull/1/head");
  try {
    const fallback = await measure(fx, () => materialize(fx.config, fx.repo.dir, 1, fx.sha));
    assert.ok(fallback.worktreePath);
    remove(fallback.worktreePath);
    const missing = await measure(fx, () => materialize(fx.config, fx.repo.dir, 404, "0".repeat(40)));
    assert.equal(missing.worktreePath, undefined);
    if (missing.worktreePath === undefined) {
      assert.equal(missing.failure.errorClass, "fetch-failure");
      assert.ok(missing.failure.message.includes("refs/pull/404/head"), "a failed SHA fallback keeps the original missing-ref failure");
    }
  } finally { fx.repo.git("update-ref", "refs/pull/1/head", fx.sha); }

  fx.repo.git("remote", "remove", "origin");
  try {
    const failed = await measure(fx, () => materialize(fx.config, fx.repo.dir, 1, fx.sha));
    assert.equal(failed.worktreePath, undefined);
    if (failed.worktreePath === undefined) assert.equal(failed.failure.errorClass, "fetch-failure");
  } finally { fx.repo.git("remote", "add", "origin", fx.repo.dir); }

  let captured = "", entered!: () => void, proceed!: () => void, cleaning!: () => void, finish!: () => void;
  const adding = new Promise<void>(resolve => { entered = resolve; }), addGate = new Promise<void>(resolve => { proceed = resolve; });
  const removal = new Promise<void>(resolve => { cleaning = resolve; }), removeGate = new Promise<void>(resolve => { finish = resolve; });
  let returned = false;
  const pending = materialize(fx.config, fx.repo.dir, 2, fx.sha, {
    fetch: () => {},
    addWorktree: async (_repo, path) => { captured = path; entered(); await addGate; },
    revParseHead: () => "wrong-head",
    removeWorktree: async (_repo, path) => {
      assert.equal(path, captured); cleaning(); await removeGate;
      assert.equal(reclaim.reviewWorktreeIsHeld(path), true);
    },
  }).then(value => { returned = true; return value; });
  try {
    await reached(adding, pending, "gated worktree add");
    assert.equal(reclaim.reviewWorktreeIsHeld(captured), true, "the hold precedes the first yielded creation step");
    proceed(); await removal;
    assert.equal(returned, false, "mismatch failure waits for teardown");
    assert.equal(reclaim.reviewWorktreeIsHeld(captured), true);
    finish(); await assert.rejects(pending, /not the PR head/);
    assert.equal(reclaim.reviewWorktreeIsHeld(captured), false, "failed materialization releases only after cleanup");
  } finally { proceed(); finish(); await pending.catch(() => {}); reclaim.releaseReviewWorktree(captured); }

  for (const where of ["add", "head"] as const) {
    let path = "";
    const result = await materialize(fx.config, fx.repo.dir, 3, fx.sha, {
      fetch: () => {},
      addWorktree: (_repo, value) => { path = value; if (where === "add") throw new Error("private add failure"); },
      revParseHead: () => { throw new Error("private head failure"); },
      removeWorktree: async () => { throw new Error("private cleanup failure"); },
    });
    assert.equal(result.worktreePath, undefined);
    if (result.worktreePath === undefined) assert.ok(result.failure.message.includes(`private ${where} failure`));
    assert.equal(reclaim.reviewWorktreeIsHeld(path), false);
  }

  type PlanRound = (...args: Parameters<typeof task.materializePlanRoundWorktree>) =>
    ReturnType<typeof task.materializePlanRoundWorktree> | Promise<ReturnType<typeof task.materializePlanRoundWorktree>>;
  const planRound = (Reflect.get(task, "materializePlanRoundWorktreeAsync") ?? task.materializePlanRoundWorktree) as unknown as PlanRound;
  for (const throws of [false, true]) {
    const name = `review-PR4-${Date.now()}`, path = join(fx.config.root, "worktrees", name);
    fx.repo.git("worktree", "add", "--detach", path, fx.sha); reclaim.holdReviewWorktree(path);
    const work = Promise.resolve(planRound(fx.config, fx.repo.dir, 4, fx.sha, {
      materialize: () => ({ worktreePath: path }),
      prepare: () => { if (throws) throw new Error("private prepare failure"); return false; },
    }));
    try {
      if (throws) await assert.rejects(work, /private prepare failure/);
      else assert.equal((await work).worktreePath, undefined);
      assert.equal(existsSync(path), false);
      assert.equal(reclaim.reviewWorktreeIsHeld(path), false);
    } finally { await work.catch(() => {}); if (existsSync(path)) remove(path); }
  }
  const unavailable = { worktreePath: undefined, failure: { errorClass: "fetch-failure" as const, message: "private unavailable checkout" } };
  assert.equal(await planRound(fx.config, fx.repo.dir, 4, fx.sha, {
    materialize: () => unavailable,
    prepare: () => { throw new Error("an unavailable checkout must not be prepared"); },
  }), unavailable, "the adapter preserves a declined materialization without preparing it");

  const dependencySource = join(fx.repo.dir, "node_modules");
  assert.equal(existsSync(dependencySource), false, "the private repository has no installed dependencies");
  const wrapper = join(fx.bin, "git"), originalWrapper = readFileSync(wrapper, "utf8");
  const delegated = join(fx.scratch, "original-prepare-git");
  writeFileSync(delegated, originalWrapper, { mode: 0o755 });
  mkdirSync(dependencySource);
  for (const state of ["ready", "common-unreadable"] as const) {
    const path = join(fx.config.root, "worktrees", `review-PR4-${Date.now()}`);
    fx.repo.git("worktree", "add", "--detach", path, fx.sha); reclaim.holdReviewWorktree(path);
    const attempted = join(fx.scratch, "common-dir-read-attempted");
    try {
      if (state === "common-unreadable") writeFileSync(wrapper, `#!/bin/sh
case "$*" in *--git-common-dir*)
 echo "start $$" >> ${quote(fx.order)}
 sleep 0.05
 : > ${quote(attempted)}
 echo "private common-dir read failure" >&2
 echo "end $$" >> ${quote(fx.order)}
 exit 7;;
esac
exec ${quote(delegated)} "$@"
`, { mode: 0o755 });
      const result = await measure(fx, async () => {
        const work = Promise.resolve(planRound(fx.config, fx.repo.dir, 4, fx.sha, {
          materialize: () => ({ worktreePath: path }),
        }));
        await assert.doesNotReject(work, "the existing toolchain exclusion remains best effort");
        return await work;
      });
      assert.equal(result.worktreePath, path);
      assert.equal(existsSync(join(path, "node_modules")), true, "the real default links the empty fixture dependency source");
      assert.equal(reclaim.reviewWorktreeIsHeld(path), true, "a prepared checkout stays owned");
      if (state === "common-unreadable") assert.equal(existsSync(attempted), true, "positive control: the real common-directory child failed");
    } finally {
      writeFileSync(wrapper, originalWrapper, { mode: 0o755 });
      try { if (existsSync(path)) fx.repo.git("worktree", "remove", "--force", path); }
      finally { reclaim.releaseReviewWorktree(path); }
    }
  }
}

async function daemonReclaimWiring(fx: ReturnType<typeof fixture>): Promise<void> {
  const planPath = join(fx.scratch, "empty-daemon-plan.yaml");
  writeFileSync(planPath, "[]\n"); mkdirSync(join(fx.config.root, "state"), { recursive: true });
  // Public environment seams isolate command composition from the host's test slot and give
  // the masked proof checkout a source identity. Hardened worktree Git still uses its local origin.
  const slot = "RMD_TEST_SLOT_DIR", parent = "RMD_TEST_SLOT_PARENT";
  const index = Number(process.env.GIT_CONFIG_COUNT ?? "0");
  assert.ok(Number.isInteger(index) && index >= 0);
  const key = `GIT_CONFIG_KEY_${index}`, value = `GIT_CONFIG_VALUE_${index}`;
  const previous = new Map([slot, parent, "GIT_CONFIG_COUNT", key, value].map(name => [name, process.env[name]]));
  process.env[slot] = join(fx.scratch, "slots"); mkdirSync(process.env[slot]!);
  delete process.env[parent];
  process.env.GIT_CONFIG_COUNT = String(index + 1);
  process.env[key] = "remote.origin.url";
  process.env[value] = "https://github.com/fixture/command-source.git";
  let path: string | undefined;
  try {
    let captured: Parameters<typeof runDaemon>[1] | undefined;
    const code = await task.daemonCommand(["--repo", "fixture/review-loop", "--plan", planPath, "--max", "0"], {
      config: { ...fx.config, claudeBin: "/bin/true" } as Config,
      repoRoot: fx.repo.dir,
      daemonBoot: async () => ({ env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version }),
      githubFactory: () => ({} as never),
      startGithubAppRefresh: () => ({ armed: false, stop: () => {} }),
      startGitCredentialSocket: async () => undefined,
      startLoopTelemetry: () => ({ sample: () => undefined, stop: () => {} }) as never,
      startMemoryCensus: () => () => {},
      writeProviderRoutingStatus: () => {},
      runDaemon: async (_plan, deps) => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0, "the real command reaches the injected bounded loop");
    const wired = captured?.sweepStrandedReviewWorktrees;
    assert.equal(typeof wired, "function", "the production command supplies its real reclaimer");
    const name = `review-PR1-${Date.now() - reclaim.DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS * 2}`;
    path = join(fx.config.root, "worktrees", name);
    fx.repo.git("worktree", "add", "--detach", path, fx.sha);
    await measure(fx, () => Promise.resolve(wired!()));
    assert.equal(existsSync(path), false, "the actual default binding awaits removal");
  } finally {
    for (const [name, old] of previous) { if (old === undefined) delete process.env[name]; else process.env[name] = old; }
    if (path && existsSync(path)) fx.repo.git("worktree", "remove", "--force", path);
  }
}

async function reviewCommandWiring(fx: ReturnType<typeof fixture>): Promise<void> {
  const repos = join(fx.config.root, "repos"), managed = join(repos, "review-loop");
  const remoteDir = join(fx.scratch, "fixture"), remote = join(remoteDir, "review-loop.git");
  mkdirSync(repos, { recursive: true }); mkdirSync(remoteDir, { recursive: true });
  symlinkSync(fx.repo.dir, remote, "dir");
  fx.repo.addWorktree(managed, "private-review-command-target", fx.sha);
  const previousOrigin = fx.repo.git("remote", "get-url", "origin");
  const wrapper = join(fx.bin, "git"), previousWrapper = readFileSync(wrapper, "utf8");
  let reviewed: string | undefined, publications = 0;
  try {
    fx.repo.git("remote", "set-url", "origin", remote);
    // Target identity validation predates this task and remains synchronous. Delay and measure
    // the profiled fetch/add/HEAD/remove chain, keeping those two validation reads real.
    writeFileSync(wrapper, `#!/bin/sh
case " $* " in *" rev-parse --is-inside-work-tree "*|*" config --get remote.origin.url "*) exec ${quote(realGit)} "$@";; esac
echo "start $$" >> ${quote(fx.order)}
sleep 0.05
${quote(realGit)} "$@"
rc=$?
echo "end $$" >> ${quote(fx.order)}
exit $rc
`, { mode: 0o755 });
    const code = await measure(fx, () => task.reviewCommand("1", ["--repo", "fixture/review-loop", "--reviewer-shadow"], {
      enforceReviewSubjectCheckout: true,
      resolveOwnerRepo: () => ({ owner: "fixture", repo: "controller" }),
      loadConfig: () => ({ ...fx.config, installRoot: REPO_ROOT } as Config),
      fetchView: () => ({ number: 1, state: "open", head: { sha: fx.sha, ref: "private-review-command" },
        base: { ref: "main" }, html_url: "https://github.com/fixture/review-loop/pull/1",
        body: "## Acceptance\n- claim: fixture content exists\n  proof: grep: base in tracked.txt" }),
      refreshSubjectInstall: () => {},
      buildBaseProof: () => ({ baseCheckoutDir: undefined, baseUnreadablePaths: new Set(), baseIsCheckout: false, addedTestFiles: new Set() }),
      reviewerCodeFreshness: () => ({ status: "fresh", codeSha: fx.sha, originMainSha: fx.sha, advance: "none" }),
      postReviewPending: async () => { publications++; return { posted: false } as never; },
      postStatus: async () => { publications++; return { posted: false } as never; },
      runReview: async input => {
        assert.ok(input.headCheckoutDir, "the real default materializer supplies a prepared head");
        reviewed = input.headCheckoutDir;
        assert.equal(readFileSync(join(reviewed, "tracked.txt"), "utf8"), "base\n");
        assert.equal(reclaim.reviewWorktreeIsHeld(reviewed), true, "review owns the completed checkout");
        return { state: "success", headSha: fx.sha, reviewerOutcome: "private fixture",
          keywordOnly: false, criteria: [], testTheater: false, summary: "private fixture",
          floorDegraded: false, capped: false, planOnly: false };
      },
    }));
    assert.equal(code, 0);
    assert.ok(reviewed, "the real command reaches the private reviewer");
    assert.equal(existsSync(reviewed), false, "default teardown finished before command return");
    assert.equal(reclaim.reviewWorktreeIsHeld(reviewed), false);
    assert.equal(publications, 0, "the public shadow path publishes no status or arm");
    assert.equal(existsSync(managed), true, "the managed subject is retained");
  } finally {
    writeFileSync(wrapper, previousWrapper, { mode: 0o755 });
    fx.repo.git("remote", "set-url", "origin", previousOrigin);
    if (existsSync(managed)) fx.repo.git("worktree", "remove", "--force", managed);
  }
}

async function sameTickMaterializationOwnership(fx: ReturnType<typeof fixture>, t: TestContext): Promise<void> {
  const instant = Date.now(), frozen = t.mock.method(Date, "now", () => instant);
  let ready!: () => void, refuse!: (error: Error) => void;
  const successfulFetch = new Promise<void>(resolve => { ready = resolve; });
  const refusedFetch = new Promise<void>((_resolve, reject) => { refuse = reject; });
  let fetches = 0, owned: string | undefined;
  const first = materialize(fx.config, fx.repo.dir, 41, fx.sha, {
    fetch: async () => { fetches++; await successfulFetch; },
    addWorktree: () => {}, revParseHead: () => fx.sha,
  });
  const second = materialize(fx.config, fx.repo.dir, 41, fx.sha, {
    fetch: async () => { fetches++; await refusedFetch; },
    addWorktree: () => { throw new Error("a failed fetch cannot add a checkout"); },
    revParseHead: () => fx.sha,
  });
  try {
    assert.equal(fetches, 2, "positive control: both same-tick materializations entered their fetch");
    ready();
    owned = (await first).worktreePath;
    assert.ok(owned);
    assert.match(owned, /review-PR41-[0-9]+$/, "the reclaimer's existing epoch name stays recognizable");
    assert.equal(reclaim.reviewWorktreeIsHeld(owned), true);
    refuse(new Error("private second fetch failure"));
    const failed = await second;
    assert.equal(failed.worktreePath, undefined);
    if (!failed.worktreePath) assert.equal(failed.failure.errorClass, "fetch-failure");
    assert.equal(reclaim.reviewWorktreeIsHeld(owned), true,
      "a failed same-tick attempt cannot release another review's hold");
  } finally {
    ready(); refuse(new Error("private fixture released"));
    await Promise.allSettled([first, second]);
    if (owned) reclaim.releaseReviewWorktree(owned);
    frozen.mock.restore();
  }
}
