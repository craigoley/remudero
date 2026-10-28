/**
 * W1-T8833 — a fix round's push lost to a base refresh is re-applied, and a push that failed is never
 * recorded as success.
 *
 * OBSERVED 2026-10-12 on #11133: the sweep merged main into the PR at 18:20:26Z, the fix round dispatched at
 * the OLD head, and its leased push was rejected "stale info" at 18:22:17Z. The sweep's rung pushed with the
 * raw pushFixRound, so #10509's re-apply never ran and the FIXED commit was discarded, while fix.done said
 * success. These tests drive the PRODUCTION sweep adapter's push and the real runFixRung.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildSweepEffects, FixRoundPushError, harnessCommitForShellLessWorker, runFixRung } from "./helpers/run-task-test.js";
import { buildFixProgressInput } from "../src/lib/fix-progress-judge.js";
import { ghJsonAsync } from "../src/lib/github-transport.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Plan } from "../src/lib/plan.js";
import type { ReviewVerdict } from "../src/lib/review.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { ghShim } from "./helpers/gh-shim.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "./helpers/git-repo.js";

const TASK = "W1-T8833X";
const BRANCH = "run-W1-T8833X-1";
const PR_URL = "https://github.com/craigoley/remudero/pull/11133";
const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
const STALE = "To https://github.com/craigoley/remudero.git\n ! [rejected]  dec02d183 -> run-W1-T8833X-1 (stale info)\n" +
  "error: failed to push some refs to 'https://github.com/craigoley/remudero.git'";
type Row = Record<string, unknown> & { step: string };

/**
 * A PR branch on a real bare remote. The round committed `committed` on top of `base` (the head it was
 * dispatched at); while it ran, the sweep's base refresh merged a moved main into the REMOTE branch.
 */
function refreshedMidRound() {
  const origin = gitRepo({ bare: true, kind: "w1-t8833-origin" });
  const seed = gitRepo({ cloneFrom: origin.dir, kind: "w1-t8833-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "README.md");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "origin", "HEAD:refs/heads/main");
  seed.git("checkout", "-q", "-b", BRANCH);
  writeFileSync(join(seed.dir, "feature.txt"), "the PR's change\n");
  seed.git("add", "feature.txt");
  seed.git("commit", "-q", "-m", "feat: the PR's change");
  seed.git("push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
  const base = seed.git("rev-parse", "HEAD");

  const lane = gitRepo({ cloneFrom: origin.dir, kind: "w1-t8833-lane" });
  // Production merges and commits with plain git; a CI runner has no global identity.
  lane.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  lane.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  lane.git("checkout", "-q", BRANCH);
  writeFileSync(join(lane.dir, "fix.txt"), "the round's FIXED change\n");
  lane.git("add", "fix.txt");
  lane.git("commit", "-q", "-m", "fix: the round's FIXED change");
  const committed = lane.git("rev-parse", "HEAD");

  // The base refresh: main moves, and the sweep merges it into the PR branch on the remote.
  seed.git("checkout", "-q", "main");
  writeFileSync(join(seed.dir, "main.txt"), "main moved\n");
  seed.git("add", "main.txt");
  seed.git("commit", "-q", "-m", "main moved");
  seed.git("push", "-q", "origin", "HEAD:refs/heads/main");
  seed.git("checkout", "-q", BRANCH);
  seed.git("merge", "-q", "--no-ff", "-m", "Merge branch 'main' into the PR", "main");
  seed.git("push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
  const refreshed = seed.git("rev-parse", "HEAD");
  return { origin, seed, lane, base, committed, refreshed,
    cleanup: () => { origin.cleanup(); seed.cleanup(); lane.cleanup(); } };
}

test("W1-T8833: a sweep fix round whose branch gained a main merge mid-round lands its change on the new head", async () => {
  const fx = refreshedMidRound();
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t8833-root-`));
  const hooks = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t8833-hooks-`));
  const shim = ghShim([{
    when: `pr view ${PR_URL} --json headRefName,headRefOid,body,files`,
    stdout: JSON.stringify({ headRefName: BRANCH, headRefOid: fx.base, body: "" }),
  }], { kind: "w1-t8833-sweep-gh" });
  const savedPath = process.env.PATH;
  const savedHooks = process.env.RMD_HARNESS_HOOKS_DIR;
  process.env.RMD_HARNESS_HOOKS_DIR = hooks;
  try {
    process.env.PATH = `${shim.dir}:${savedPath}`;
    for (const d of ["state/inflight", "repos/remudero-fixture", "tmp"]) mkdirSync(join(root, d), { recursive: true });
    const task = { id: TASK, title: "sweep re-apply", risk: "low", acceptance: [], verify: "auto", files: [], status: "queued" };
    const rows: Row[] = [];
    let pushed: unknown;
    let ownerReads = 0;
    // The PRODUCTION adapter, with no push injected: what reaches runFixRung is the entrypoint's own wiring.
    const effects = buildSweepEffects({
      owner: "craigoley",
      repo: "remudero-fixture",
      repoRoot: process.cwd(),
      localRepoName: "remudero",
      config: { root, claudeBin: "/bin/true" } as Config,
      ledgerPath: join(root, "state", "ledger.ndjson"),
      runId: "SWEEP-W1-T8833",
      plan: { tasks: [task], byId: new Map([[task.id, task]]) } as unknown as Plan,
      log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); },
      policy: DEFAULT_SWEEP_POLICY,
      reviewRunner: async () => 0,
      issuesImpl: { create: () => "https://github.com/craigoley/remudero/issues/11133" },
      stallNotice: () => {},
      armImpl: () => "armed",
      armSessionPrsOverride: false,
      captureRepairFeedbackImpl: () => {},
      ghRunImpl: () => {},
      spawnWallClockBoundMsOverride: 1,
      reclaimWorkerImpl: () => {},
      disarmImpl: () => undefined,
      readJsonImpl: async (args: string[]) => args[0] === "pr" ? ghJsonAsync(args) : {},
      registeredWorktreeOwnerImpl: () => (++ownerReads === 1 ? join(root, "worktrees", "owner") : undefined),
      registeredOwnerRecovery: {
        capture: () => ({
          path: join(root, "worktrees", "owner"), localSha: "local123456789", remoteSha: fx.base, ageMs: 10,
          pathState: "managed", attachmentState: "exact", treeState: "clean", remoteState: "exact",
          historyState: "ahead", claimState: "clear", processState: "clear",
        }),
        publishAhead: () => {},
        remove: () => {},
      },
      decideRegisteredFixOwnerRecoveryImpl: () => ({ kind: "publish-ahead" }),
      dispatchFixPreflightStandDownImpl: async () => undefined,
      resolveTaskContractAtHeadImpl: () => ({ criteria: [] }),
      fixBranchClaimKeyImpl: () => "claim-key",
      createFixRungWorktreeImpl: () => undefined,
      captureWorktreeSnapshotImpl: () => ({ headSha: "birth123" }),
      buildFixRungDispatchArgsImpl: () => ({}),
      openTaskIdsFromPlanImpl: () => new Set([TASK]),
      runFixRungImpl: async (args: { deps: { push: (wt: string, branch: string, sha: string, prior: string) => unknown } }) => {
        // The round's leased push, guarded on the head it was dispatched at, after the refresh moved the remote.
        pushed = await Promise.resolve(args.deps.push(fx.lane.dir, BRANCH, fx.committed, fx.base)).then(() => "landed", (e: unknown) => e);
        return { outcome: "stood_down", strikes: 0, retriggers: 0, reason: "test" };
      },
      spawnImpl: async () => ({ sessionId: "new-session" }) as never,
    } as unknown as Parameters<typeof buildSweepEffects>[0]);

    await withLiveWritesAllowed(() => effects.dispatchFix!(
      { prNumber: 11133, prUrl: PR_URL, headSha: fx.base, taskId: TASK, priorStrikes: 0,
        mergeState: "clean", checksState: "failure" } as never,
      { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "red" }] } as never,
    ));

    assert.equal(pushed, "landed", `the round's push landed; got ${String((pushed as Error)?.message ?? pushed)}`);
    const tip = fx.origin.git("rev-parse", `refs/heads/${BRANCH}`);
    assert.deepEqual(fx.origin.git("log", "-1", "--format=%P", tip).split(" "), [fx.committed, fx.refreshed],
      "the round's commit is merged onto the refreshed head, keeping both");
    assert.equal(fx.origin.git("show", `${tip}:fix.txt`), "the round's FIXED change", "the FIXED change reached the remote");
    const reapplied = rows.filter((r) => r.step === "fix.round_reapplied");
    assert.equal(reapplied.length, 1, `steps=${JSON.stringify(rows.map((r) => r.step))}`);
    assert.equal(reapplied[0]!.branch, BRANCH, "the re-apply names the PR branch it merged onto");
    assert.equal(reapplied[0]!.remote_tip, fx.refreshed);
  } finally {
    process.env.PATH = savedPath;
    if (savedHooks === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR; else process.env.RMD_HARNESS_HOOKS_DIR = savedHooks;
    rmSync(shim.dir, { recursive: true, force: true });
    fx.cleanup();
  }
});

function worker(text: string): WorkerResult {
  return {
    sessionId: "fix-session", costUsd: 1, numTurns: 2, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "medium",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    qualitySuspect: false, provider: "claude",
  } as WorkerResult;
}

function review(headSha: string): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return { state: "failure", headSha, reviewerOutcome: "failure", testTheater: false, summary: "blocked",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    criteria: [{ claim: "the fix lands", proof: "unit test: the fix lands", met: false, reason: "still blocked", proof_exec: "not_executable" }] };
}

const PRIOR = "d8ac26a2cd8ac26a2cd8ac26a2cd8ac26a2cd8ac";
const ROUND = "63540e37063540e37063540e37063540e37063540";

/** The #11133 round: the worker reports FIXED and commits, and its leased push is rejected as stale. */
async function staleLeaseRound() {
  const rows: Row[] = [];
  const repo = gitRepo({ kind: "w1-t8833-rung" });
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t8833-rung-`));
  const outcome = await runFixRung({
    taskId: TASK, runId: "DAEMON-8833", task: { id: TASK, title: "the fix lands", files: ["src/fix.ts"] },
    prUrl: PR_URL, branch: BRANCH, worktreePath: repo.dir, initialSessionId: "initial-session", mount: MOUNT,
    settingsFile: join(root, "settings.json"), config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 1, initialReview: review(PRIOR),
    reviewBase: { owner: "craigoley", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: MOUNT },
    deps: {
      spawn: async () => worker("REPORT\nFIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(ci): repair the red"),
      waitForCiGreen: async () => "green" as const,
      runReview: async () => review(PRIOR),
      fetchPrBody: async () => "REPORT",
      push: () => { throw new FixRoundPushError("git-push-failed", undefined, STALE); },
      issues: { create: () => "https://github.com/craigoley/remudero/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(root, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => { rows.push({ ts: new Date().toISOString(), task_id: TASK, step, ...extra }); },
      say: () => {}, account: (result) => result,
      worktreeHasUncommittedChanges: () => true,
      harnessCommitForShellLessWorker: (input) => harnessCommitForShellLessWorker(input,
        { commit: () => ({ committed: true, sha: ROUND, undeclared: [] }), ahead: () => 1 }),
    },
  });
  return { outcome, rows, done: rows.filter((r) => r.step === "fix.done") };
}

test("W1-T8833: a stood-down push records subtype push_failed on its fix-done row", async () => {
  const run = await staleLeaseRound();
  assert.equal(run.done.length, 1, JSON.stringify(run.rows.map((r) => r.step)));
  const done = run.done[0]!;
  assert.equal(done.subtype, "push_failed", "never the worker's own \"success\"");
  assert.equal(done.worker_subtype, "success", "the worker's own subtype is kept beside it");
  assert.equal(done.pushed_head_sha, undefined);
  assert.match(String(done.push_failure_reason), /stale info/);
  assert.equal(run.rows.filter((r) => r.step === "fix.push_failed").length, 1);
  assert.equal(run.outcome.outcome, "stood_down");
});

test("W1-T8833: the progress judge reads a push_failed round as not landed", async () => {
  const run = await staleLeaseRound();
  const input = buildFixProgressInput({ taskId: TASK, headSha: PRIOR, currentRed: ["review:the fix lands"], ledger: run.rows });
  assert.equal(input.rounds.length, 1);
  const round = input.rounds[0]!;
  assert.equal(round.subtype, "push_failed", "the judge's input names the round push_failed");
  assert.notEqual(round.fixOutcome, "FIXED", "never presented as a FIXED round");
  assert.equal(round.pushedHead, undefined, "no head is credited to it");
  assert.equal(input.signals.pushFailedRounds, 1);
  assert.equal(input.signals.reviewerOnlyFailurePersists, 0, "it cleared nothing and failed nothing on the reviewer's side");
});


async function censusRefreshOwner(t: import("node:test").TestContext) {
  const { writeFixCensusSnapshotAsync, readInheritedCensusContextAsync, preserveInheritedCensusWork } = await import("#src/run-task.js");
  const { refreshInheritedCensusRefusal } = await import("#src/cli/commands/fix.js");
  const { fixRoundBranchClaim } = await import("#src/lib/sweep.js");
  const { acquireInflightLock } = await import("#src/lib/inflight-lock.js");
  const repo = gitRepo({ scope: t, kind: "census-refresh-owner" });
  const root = join(repo.dir, "state", "owner");
  mkdirSync(root, { recursive: true }); mkdirSync(join(repo.dir, "scripts"));
  writeFileSync(join(repo.dir, ".gitignore"), "state/\n");
  writeFileSync(join(repo.dir, "scripts/affected-reach-baseline.json"), '{"importerCount":1}');
  writeFileSync(join(repo.dir, "source.ts"), "export const saved = 0;\n");
  repo.git("add", "."); repo.git("commit", "-m", "fixture: old baseline");
  const base = repo.git("rev-parse", "HEAD");
  repo.git("branch", "refresh");
  writeFileSync(join(repo.dir, "scripts/affected-reach-baseline.json"), '{"resolution":"package-imports","importerCount":1}');
  repo.git("add", "scripts"); repo.git("commit", "-m", "fixture: main migration");
  const main = repo.git("rev-parse", "HEAD"); repo.git("update-ref", "refs/remotes/origin/main", main);
  repo.git("switch", "refresh");
  const snapshot = await writeFixCensusSnapshotAsync(repo.dir, () => {}); assert.ok(snapshot);
  const context = await readInheritedCensusContextAsync(repo.dir, snapshot); assert.equal(context.state, "inherited");
  if (context.state !== "inherited") throw new Error("fixture context unavailable");
  const lock = acquireInflightLock(join(root, "locks"), "refresh", { run_id: "TEST-refresh" });
  const claim = fixRoundBranchClaim(lock, () => { throw new Error("unexpected reacquire"); });
  t.after(() => lock.release());
  let updates = 0;
  const rows: Row[] = [];
  const deps: Parameters<typeof refreshInheritedCensusRefusal>[1] = {
    branchClaim: claim, readLiveState: () => ({ ok: true, state: "OPEN" }),
    readLiveHead: () => ({ ok: true, headSha: base, headRefName: "refresh" }),
    readCiRollup: () => [{ name: "ci-gate", conclusion: "SUCCESS" }],
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 1 }),
    reproduceFailingTestsOnMerge: async (_pr, files) => files.map(file => ({ file, outcome: "passes", duration_ms: 1, cached: false })),
    updateBranch: (_pr, head) => { assert.equal(head, base); updates++; return { ok: true }; },
    log: (step, extra) => rows.push({ step, ...extra }),
  };
  const input = { root, worktreePath: repo.dir, branch: "refresh", prUrl: PR_URL, prNumber: 11133, snapshotPath: snapshot, context };
  return { repo, root, base, main, lock, claim, context, deps, input, rows,
    evidence: { readInheritedCensusContextAsync, preserveInheritedCensusWork },
    run: () => refreshInheritedCensusRefusal(input, deps, { readInheritedCensusContextAsync, preserveInheritedCensusWork }),
    updates: () => updates };
}

test("census baseline refresh respects live owners and the exact head", async t => {
  for (const mode of ["foreign-owner", "unknown-owner", "head-changed", "branch-changed", "ci-in-flight", "no-ci", "merge-unknown", "context-changed", "update-refused"] as const) {
    await t.test(mode, async t => {
      const fx = await censusRefreshOwner(t);
      if (mode === "foreign-owner") writeFileSync(fx.lock.path, JSON.stringify({ ...fx.lock.info, run_id: "FOREIGN-live" }));
      if (mode === "unknown-owner") unlinkSync(fx.lock.path);
      if (mode === "head-changed") {
        let reads = 0;
        fx.deps.readLiveHead = () => ({ ok: true, headSha: ++reads === 1 ? fx.base : fx.main, headRefName: "refresh" });
      }
      if (mode === "branch-changed") fx.deps.readLiveHead = () => ({ ok: true, headSha: fx.base, headRefName: "sibling" });
      if (mode === "ci-in-flight") fx.deps.readCiRollup = () => [{ name: "old-red", conclusion: "FAILURE" }, { name: "running", status: "IN_PROGRESS" }];
      if (mode === "no-ci") fx.deps.readCiRollup = () => [];
      if (mode === "merge-unknown") fx.deps.readMergeFacts = () => ({ mergeable: "UNKNOWN", behindBy: 1 });
      if (mode === "context-changed") fx.deps.reproduceFailingTestsOnMerge = async (_pr, files) => {
        fx.repo.git("update-ref", "refs/remotes/origin/main", fx.base);
        return files.map(file => ({ file, outcome: "passes", duration_ms: 1, cached: false }));
      };
      if (mode === "update-refused") fx.deps.updateBranch = () => ({ ok: false, error: "expected_head_sha mismatch" });
      const before = fx.repo.git("status", "--porcelain=v1");
      const result = await fx.run();
      assert.equal(result.outcome, "held", JSON.stringify(fx.rows)); assert.equal(fx.updates(), 0);
      assert.equal(fx.repo.git("status", "--porcelain=v1"), before, "refusal keeps unpublished work unchanged");
      if (mode === "foreign-owner") assert.equal(JSON.parse(readFileSync(fx.lock.path, "utf8")).run_id, "FOREIGN-live");
    });
  }
});

test("census refresh durably preserves staged unstaged and untracked work without changing any owner tree", async t => {
  const fx = await censusRefreshOwner(t);
  fx.repo.git("branch", "sibling", fx.main);
  writeFileSync(join(fx.repo.dir, "source.ts"), "export const saved = 1;\n"); fx.repo.git("add", "source.ts");
  writeFileSync(join(fx.repo.dir, "source.ts"), "export const saved = 2;\n");
  writeFileSync(join(fx.repo.dir, "unpublished.txt"), "untracked fix\n");
  const before = fx.repo.git("status", "--porcelain=v1");
  assert.equal((await fx.run()).outcome, "requested"); assert.equal(fx.updates(), 1);
  assert.equal(fx.repo.git("status", "--porcelain=v1"), before);
  assert.equal(fx.repo.git("show", ":source.ts"), "export const saved = 1;");
  assert.equal(readFileSync(join(fx.repo.dir, "source.ts"), "utf8"), "export const saved = 2;\n");
  const saved = fx.rows.find(row => row.outcome === "work-preserved")!.saved_path as string;
  assert.match(readFileSync(join(saved, "index.patch"), "utf8"), /saved = 1/);
  assert.match(readFileSync(join(saved, "worktree.patch"), "utf8"), /saved = 2/);
  assert.match(readFileSync(join(saved, "untracked.patch"), "utf8"), /untracked fix/);
  assert.equal(fx.repo.git("rev-parse", "sibling"), fx.main);
  assert.equal(fx.repo.git("rev-parse", "HEAD"), fx.base);
});

test("census refresh retains failed merged checks overlaps unavailable reads and preservation errors", async t => {
  for (const mode of ["growth", "unrunnable", "missing-probe", "unwired-owner", "overlap", "reader-error", "save-error", "tracked-only"] as const) {
    await t.test(mode, async t => {
      const fx = await censusRefreshOwner(t);
      if (mode === "growth" || mode === "unrunnable") fx.deps.reproduceFailingTestsOnMerge = async (_pr, files) =>
        files.map(file => ({ file, outcome: mode === "growth" ? "fails" : "unrunnable", duration_ms: 1, cached: false }));
      if (mode === "missing-probe") fx.deps.reproduceFailingTestsOnMerge = undefined;
      if (mode === "unwired-owner") fx.deps.branchClaim = undefined;
      if (mode === "overlap") {
        writeFileSync(join(fx.repo.dir, "scripts/affected-reach-baseline.json"), "changed saved baseline\n");
      }
      if (mode === "reader-error") fx.deps.readCiRollup = () => { throw new Error("read unavailable"); };
      if (mode === "save-error") {
        // Real default preservation must fail; no fake that bypasses its filesystem arm.
        writeFileSync(join(fx.repo.dir, "unpublished.txt"), "saved fix\n");
        writeFileSync(join(fx.root, "recovery"), "file blocks recovery directory");
      }
      if (mode === "tracked-only") writeFileSync(join(fx.repo.dir, "source.ts"), "export const saved = 3;\n");
      const before = fx.repo.git("status", "--porcelain=v1");
      const result = await fx.run();
      assert.equal(result.outcome, mode === "tracked-only" ? "requested" : "held", JSON.stringify(fx.rows));
      assert.equal(fx.repo.git("status", "--porcelain=v1"), before);
      assert.equal(fx.updates(), mode === "tracked-only" ? 1 : 0);
      if (mode === "overlap") await assert.rejects(fx.evidence.preserveInheritedCensusWork(fx.root, fx.repo.dir, "refresh", fx.context), /overlaps main/);
      if (mode === "tracked-only") assert.match(String(fx.rows.find(row => row.outcome === "work-preserved")!.recovery_ref), /^refs\/rmd-recovery\//);
    });
  }
});
