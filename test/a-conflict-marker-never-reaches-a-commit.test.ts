/**
 * test/a-conflict-marker-never-reaches-a-commit.test.ts — W1-T5227.
 *
 * THE DEFECT. Commit 4c047d2bd on #8551 was a two-parent merge whose src/lib/now-view.ts carried a
 * half-resolved conflict. The harness commit ran `git add -A -- <declared>`, and `git add` marks a
 * conflicted path RESOLVED whatever it holds, so git's own "unmerged files" refusal never fired.
 * Nothing on the push path read the tree for markers either.
 *
 * Every fixture here is a REAL diverged clone (the markers come from `git merge`, not typed in). The
 * marker lines are built with `.repeat` so no line of THIS file begins with one.
 */
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  commitWorkerEdits,
  FixRoundPushError,
  harnessCommitForShellLessWorker,
  leftoverConflictMarkerPaths,
  pushFixRoundPrechecked,
  runFixRung,
  startShellLessMergeConflictMerge,
} from "./helpers/run-task-test.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "./helpers/git-repo.js";

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
const CONFLICT_FILE = "conflict.txt";
const RESOLVED = "base line\nresolved by the worker\n";
const OURS_MARK = "<".repeat(7);

function divergedPair(kind: string): GitRepo {
  const upstream = gitRepo({ kind: `${kind}-upstream`, seedCommit: true, branch: "main" });
  writeFileSync(join(upstream.dir, CONFLICT_FILE), "base line\n");
  upstream.git("add", "-A");
  upstream.git("commit", "-m", "seed conflict file");
  const wt = gitRepo({ kind: `${kind}-branch`, cloneFrom: upstream.dir });
  wt.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  wt.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  writeFileSync(join(wt.dir, CONFLICT_FILE), "base line\nours\n");
  wt.git("add", "-A");
  wt.git("commit", "-m", "branch: our own change");
  writeFileSync(join(upstream.dir, CONFLICT_FILE), "base line\ntheirs\n");
  upstream.git("add", "-A");
  upstream.git("commit", "-m", "main: a concurrent change");
  wt.git("fetch", "origin");
  return wt;
}

function mergeHeadLive(wt: GitRepo): boolean {
  return existsSync(join(wt.dir, wt.git("rev-parse", "--git-path", "MERGE_HEAD")));
}

function parentCount(wt: GitRepo): number {
  return wt.git("log", "-1", "--format=%P", "HEAD").split(/\s+/).filter(Boolean).length;
}

test("W1-T5227: the harness commit refuses a tree with conflict markers and names the files", () => {
  const wt = divergedPair("w1t5227-refuse");
  try {
    assert.equal(startShellLessMergeConflictMerge(wt.dir).started, true);
    const before = wt.git("rev-parse", "HEAD");
    // The worker never finished resolving: the markers are still in the file.
    assert.ok(readFileSync(join(wt.dir, CONFLICT_FILE), "utf8").startsWith(`base line\n${OURS_MARK} `));

    const landed = commitWorkerEdits(wt.dir, [CONFLICT_FILE], "fix(x): resolve the merge conflict");

    assert.equal(landed.committed, false);
    assert.deepEqual(landed.conflictMarkerFiles, [CONFLICT_FILE]);
    assert.match(landed.reason ?? "", /leftover conflict markers in conflict\.txt/);
    assert.equal(wt.git("rev-parse", "HEAD"), before, "nothing was committed");
    // Nothing was staged: the path is still unmerged, so git itself still knows it is unresolved.
    assert.equal(wt.git("diff", "--name-only", "--diff-filter=U"), CONFLICT_FILE);
  } finally {
    wt.cleanup();
  }
});

test("W1-T5227: a refused marker commit leaves the merge pending for the conflict path", async () => {
  const wt = divergedPair("w1t5227-pending");
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t5227-pending-`));
  try {
    // (a) the helper's own contract: the refusal carries the files and MERGE_HEAD survives it.
    assert.equal(startShellLessMergeConflictMerge(wt.dir).started, true);
    const refusals: Array<{ reason: string; files: readonly string[] | undefined }> = [];
    const count = harnessCommitForShellLessWorker({
      harnessOwnsGit: true,
      commitCount: 0,
      report: "REPORT\nCOMMIT_MESSAGE: fix(x): resolve the merge conflict",
      worktreePath: wt.dir,
      declaredPaths: [CONFLICT_FILE],
      requireMergeHead: true,
      log: () => {},
      say: () => {},
      onRefusal: (reason, _undeclared, files) => refusals.push({ reason, files }),
    });
    assert.equal(count, 0);
    assert.deepEqual(refusals.map((r) => r.files), [[CONFLICT_FILE]]);
    assert.equal(mergeHeadLive(wt), true, "the pending merge is left alone");
    assert.equal(startShellLessMergeConflictMerge(wt.dir).started, true, "the next strike resumes the same merge");

    // (b) the rung: strike 1 leaves the markers, strike 2 resolves — the conflict path never dropped.
    const startSha = wt.git("rev-parse", "HEAD");
    const lines: Array<{ step: string } & Record<string, unknown>> = [];
    let spawns = 0;
    const run = {
      taskId: "W1-T5227X",
      runId: "W1-T5227X-run",
      task: { id: "W1-T5227X", title: "resolve the conflict", files: [CONFLICT_FILE] },
      prUrl: "https://github.com/acme/remudero/pull/5227",
      branch: "run-W1-T5227X-1",
      worktreePath: wt.dir,
      initialSessionId: "initial-session",
      mount: MOUNT,
      settingsFile: join(root, "settings.json"),
      config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
      budgetUsd: 10,
      strikeCap: 2,
      initialReview: fakeReview("failure", startSha),
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: MOUNT },
      mergeConflict: { files: [{ path: CONFLICT_FILE, oursDeleted: 1, theirsDeleted: 1 }], oursLog: "o", theirsLog: "t" },
      deps: {
        spawn: async (_args: SpawnWorkerArgs) => {
          spawns += 1;
          if (spawns === 2) writeFileSync(join(wt.dir, CONFLICT_FILE), RESOLVED);
          return worker("REPORT\nCOMMIT_MESSAGE: fix(x): resolve the merge conflict");
        },
        waitForCiGreen: async () => "green" as const,
        fetchPrBody: async () => "REPORT\nresolved",
        runReview: async () => fakeReview("success", wt.git("rev-parse", "HEAD")),
        push: () => {},
        issues: issues(),
        ledgerPath: join(root, "ledger.ndjson"),
        log: (step: string, extra?: Record<string, unknown>) => lines.push({ step, ...(extra ?? {}) }),
        say: () => {},
        account: (result: WorkerResult) => result,
      },
    };
    await runFixRung(run as never);

    const refused = lines.filter((l) => l.step === "fix.commit_refused");
    assert.equal(refused.length, 1, "strike 1 is a recorded refusal");
    assert.deepEqual(refused[0]!.conflict_marker_files, [CONFLICT_FILE]);
    assert.equal(lines.filter((l) => l.step === "fix.merge_started").length, 2, "strike 2 is a merge-conflict round again");
    assert.equal(spawns, 2);
    assert.equal(parentCount(wt), 2, "the resolved retry commits as the two-parent merge");
    assert.equal(readFileSync(join(wt.dir, CONFLICT_FILE), "utf8"), RESOLVED);
  } finally {
    wt.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5227: the fix round push refuses a head whose tree carries conflict markers", async () => {
  const wt = divergedPair("w1t5227-push");
  try {
    // A Bash-bearing worker committed the half-resolved merge ITSELF: add marks it resolved.
    startShellLessMergeConflictMerge(wt.dir);
    wt.git("add", "-A");
    wt.git("commit", "-m", "fix: sealed with markers");
    assert.equal(parentCount(wt), 2);

    const log: Array<{ step: string } & Record<string, unknown>> = [];
    let pushed = 0;
    const attempt = pushFixRoundPrechecked(
      (step, extra) => log.push({ step, ...(extra ?? {}) }), wt.dir, "run-x", undefined, {}, () => { pushed += 1; });
    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof FixRoundPushError);
      assert.match(error.detail, /leftover conflict markers in conflict\.txt/);
      return true;
    });
    assert.equal(pushed, 0, "the head never leaves the worktree");
    assert.deepEqual(log.find((l) => l.step === "push.conflict_marker_refused")?.files, [CONFLICT_FILE]);

    // A clean head is not refused by this gate (the coverage precheck is stubbed out).
    writeFileSync(join(wt.dir, CONFLICT_FILE), RESOLVED);
    wt.git("commit", "-am", "fix: resolve for real");
    const ports = { changedFiles: () => [], select: () => ({ suites: [] }) } as never;
    await pushFixRoundPrechecked(() => {}, wt.dir, "run-x", undefined, ports, () => { pushed += 1; });
    assert.equal(pushed, 1);
    assert.deepEqual(leftoverConflictMarkerPaths((args) => wt.git(...args), [], { against: "origin/main", head: "HEAD" }), []);
  } finally {
    wt.cleanup();
  }
});

test("W1-T5227: an unreadable marker scan is logged and does not block the push", async () => {
  const log: Array<{ step: string } & Record<string, unknown>> = [];
  let pushed = 0;
  const ports = {
    conflictMarkers: () => { throw new Error("no origin/main"); },
    changedFiles: () => [],
    select: () => ({ suites: [] }),
  } as never;
  await pushFixRoundPrechecked(
    (step, extra) => log.push({ step, ...(extra ?? {}) }), "/nonexistent-w1t5227", "run-x", undefined, ports, () => { pushed += 1; });
  assert.equal(pushed, 1, "an unreadable scan fails open, as the coverage precheck does");
  const unavailable = log.find((l) => l.step === "push.conflict_marker_check_unavailable");
  assert.equal(unavailable?.site, "rung.fix_push");
  assert.equal(unavailable?.error, "no origin/main");
});

test("W1-T5227: a marker refusal in a non-merge round turns the next strike into a merge-conflict round", async () => {
  const wt = divergedPair("w1t5227-promote");
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t5227-promote-`));
  try {
    const startSha = wt.git("rev-parse", "HEAD");
    const lines: Array<{ step: string } & Record<string, unknown>> = [];
    let spawns = 0;
    let commitCalls = 0;
    const run = {
      taskId: "W1-T5227Y",
      runId: "W1-T5227Y-run",
      task: { id: "W1-T5227Y", title: "resolve the conflict", files: [CONFLICT_FILE] },
      prUrl: "https://github.com/acme/remudero/pull/5227",
      branch: "run-W1-T5227Y-1",
      worktreePath: wt.dir,
      initialSessionId: "initial-session",
      mount: MOUNT,
      settingsFile: join(root, "settings.json"),
      config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
      budgetUsd: 10,
      strikeCap: 2,
      initialReview: fakeReview("failure", startSha),
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: MOUNT },
      // No mergeConflict: strike 1 is an ordinary round, so only the marker refusal can make strike 2 one.
      deps: {
        spawn: async (_args: SpawnWorkerArgs) => {
          spawns += 1;
          if (spawns === 2) writeFileSync(join(wt.dir, CONFLICT_FILE), RESOLVED);
          return worker("REPORT\nCOMMIT_MESSAGE: fix(x): resolve the merge conflict");
        },
        harnessCommitForShellLessWorker: (input: Parameters<typeof harnessCommitForShellLessWorker>[0]) => {
          commitCalls += 1;
          if (commitCalls === 1) {
            assert.equal(input.requireMergeHead, false, "strike 1 is not a merge-conflict round");
            input.onRefusal?.(`${"leftover conflict markers in"} ${CONFLICT_FILE}; nothing was staged`, [], [CONFLICT_FILE]);
            return 0;
          }
          assert.equal(input.requireMergeHead, true, "strike 2 is a merge-conflict round");
          return harnessCommitForShellLessWorker(input);
        },
        waitForCiGreen: async () => "green" as const,
        fetchPrBody: async () => "REPORT\nresolved",
        runReview: async () => fakeReview("success", wt.git("rev-parse", "HEAD")),
        push: () => {},
        issues: issues(),
        ledgerPath: join(root, "ledger.ndjson"),
        log: (step: string, extra?: Record<string, unknown>) => lines.push({ step, ...(extra ?? {}) }),
        say: () => {},
        account: (result: WorkerResult) => result,
      },
    };
    await runFixRung(run as never);

    const refused = lines.filter((l) => l.step === "fix.commit_refused");
    assert.equal(refused.length, 1);
    assert.deepEqual(refused[0]!.conflict_marker_files, [CONFLICT_FILE]);
    assert.equal(lines.filter((l) => l.step === "fix.merge_started").length, 1, "only strike 2 starts the merge");
    const dispatches = lines.filter((l) => l.step === "fix.dispatch");
    assert.deepEqual(dispatches.map((d) => d.conflicted_files), [[CONFLICT_FILE], [CONFLICT_FILE]]);
    assert.equal(parentCount(wt), 2, "the resolved retry commits as the two-parent merge");
  } finally {
    wt.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5227: the pre-commit hook refuses a marker commit for every committer", () => {
  const repo = gitRepo({ kind: "w1t5227-hook", seedCommit: true });
  try {
    // Only pre-commit is under test; commit-msg needs commitlint installed, which a CI shard may lack.
    const hooks = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t5227-hooks-`));
    copyFileSync(fileURLToPath(new URL("../hooks/pre-commit", import.meta.url)), join(hooks, "pre-commit"));
    chmodSync(join(hooks, "pre-commit"), 0o755);
    repo.git("config", "core.hooksPath", hooks);
    repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
    repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
    // A .md file: no .ts/.mjs is staged, the case the hook's early `exit 0` used to wave through.
    writeFileSync(join(repo.dir, "notes.md"), `intro\n${OURS_MARK} HEAD\nmine\n=======\ntheirs\n${">".repeat(7)} origin/main\n`);
    repo.git("add", "notes.md");
    const before = repo.git("rev-parse", "HEAD");

    let stderr = "";
    try {
      repo.git("commit", "-m", "chore: notes");
      assert.fail("the hook must refuse a staged conflict marker");
    } catch (error) {
      stderr = String((error as { stderr?: unknown }).stderr ?? error);
    }
    assert.match(stderr, /notes\.md:2: leftover conflict marker/, "the refusal names file:line");
    assert.equal(repo.git("rev-parse", "HEAD"), before, "nothing was committed");

    // The same file, resolved, commits: the gate refuses markers, not every .md commit.
    writeFileSync(join(repo.dir, "notes.md"), "intro\nmine and theirs\n");
    repo.git("add", "notes.md");
    repo.git("commit", "-m", "chore: notes");
    assert.notEqual(repo.git("rev-parse", "HEAD"), before);
  } finally {
    repo.cleanup();
  }
});

test("W1-T5227: a fully resolved merge still commits as a two-parent merge", () => {
  const wt = divergedPair("w1t5227-resolved");
  try {
    assert.equal(startShellLessMergeConflictMerge(wt.dir).started, true);
    writeFileSync(join(wt.dir, CONFLICT_FILE), RESOLVED);

    const landed = commitWorkerEdits(wt.dir, [CONFLICT_FILE], "fix(x): resolve the merge conflict");

    assert.equal(landed.committed, true, landed.reason);
    assert.equal(landed.conflictMarkerFiles, undefined);
    assert.equal(parentCount(wt), 2);
    assert.equal(readFileSync(join(wt.dir, CONFLICT_FILE), "utf8"), RESOLVED);
  } finally {
    wt.cleanup();
  }
});

function worker(text: string): WorkerResult {
  return {
    sessionId: "fix-session", costUsd: 1, numTurns: 2, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "medium",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    qualitySuspect: false,
  };
}

function criterion(met: boolean): CriterionVerdict {
  return { claim: "the conflict resolves", met, proof: "proof", reason: "", proof_exec: "not_executable" };
}

function fakeReview(state: "success" | "failure", headSha: string): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state, criteria: [criterion(state === "success")], testTheater: false, summary: "s", floorDegraded: false,
    capped: false, keywordOnly: false, planOnly: false, headSha, reviewerOutcome: "success",
  };
}

function issues(): IssueGateway {
  return { create: () => "https://github.com/acme/remudero/issues/1", listOpen: (): OpenIssue[] => [], comment: () => {} };
}

test("a leased fix push the remote outran is re-applied onto the moved tip and pushed once more", async () => {
  const log: Array<{ step: string } & Record<string, unknown>> = [];
  const pushes: Array<{ sha?: string; prior?: string }> = [];
  const push = (_wt: string, _branch: string, sha?: string, prior?: string) => {
    pushes.push({ sha, prior });
    if (pushes.length === 1) throw new FixRoundPushError("run-error", undefined, "leased push of run-x expected mine, observed theirs");
  };
  const reapplyPorts = {
    remoteTip: async () => "theirs",
    headSha: async () => "mine",
    isAncestor: async () => true,
    merge: async () => ({ merged: true as const, head: "merged" }),
  };
  const ports = { conflictMarkers: () => [], changedFiles: () => [], select: () => ({ suites: [] }) } as never;
  await pushFixRoundPrechecked((step, extra) => log.push({ step, ...(extra ?? {}) }), "/unused", "run-x", "mine", ports, push, "base",
    { ports: reapplyPorts });
  assert.deepEqual(pushes, [{ sha: "mine", prior: "base" }, { sha: "merged", prior: "theirs" }]);
  assert.equal(log.filter((row) => row.step === "fix.round_reapplied").length, 1);

  // A second refusal is not re-applied again, and a census refusal (the round's own red) never is.
  const always = () => { throw new FixRoundPushError("run-error", undefined, "still outran"); };
  await assert.rejects(pushFixRoundPrechecked(() => {}, "/unused", "run-x", "mine", ports, always, "base", { ports: reapplyPorts }),
    /still outran/);
  let reads = 0;
  const census = () => { throw new FixRoundPushError("run-error", { text: "census", censuses: ["x"], offeredBaselines: [] }, "census"); };
  await assert.rejects(pushFixRoundPrechecked(() => {}, "/unused", "run-x", "mine", ports, census, "base",
    { ports: { ...reapplyPorts, remoteTip: async () => { reads += 1; return "theirs"; } } }), /census/);
  assert.equal(reads, 0, "a census refusal is never re-applied");
});
