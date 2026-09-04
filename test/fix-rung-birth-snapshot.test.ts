/**
 * test/fix-rung-birth-snapshot.test.ts — W1-T2652.
 *
 * The fix rung gets a byte-clean birth snapshot immediately after a cold/sweep worktree is
 * materialized. A round-1 snapshot that is dirty at birth, or differs from that birth snapshot
 * before the first worker turn, is foreign local content: the rung escalates, spends no strike,
 * spawns no worker, pushes nothing, and never mutates the evidence.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  captureWorktreeSnapshotViaGit,
  createFixRungWorktree,
  foreignTreeStandDownReason,
  runFixRung,
  worktreeSnapshotIsClean,
  type WorktreeSnapshot,
} from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { RegisteredWorktree, SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function result(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

function fakeReview(
  state: "success" | "failure",
  criteria: CriterionVerdict[],
  headSha = "deadbeef",
): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state,
    criteria,
    testTheater: false,
    summary: state === "success" ? "all criteria met" : "unmet criteria",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  };
}

function fakeIssueStore(): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }> } {
  let seq = 1200;
  const issues: Array<{ number: number; url: string; title: string; body: string; state: string }> = [];
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  return {
    calls,
    create(title, body, labels) {
      const number = seq++;
      const url = `https://github.com/acme/remudero/issues/${number}`;
      issues.push({ number, url, title, body, state: "open" });
      calls.push({ title, body, labels });
      return url;
    },
    listOpen(): OpenIssue[] {
      return issues.filter((i) => i.state === "open").map((i) => ({ number: i.number, url: i.url, title: i.title, body: i.body }));
    },
    comment() {},
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fixrung-birth-ledger-")), "ledger.ndjson");
}

function fixRungBaseOpts(worktreePath: string) {
  return {
    taskId: "W1-T2652X",
    runId: "W1-T2652X-1730000000000",
    task: { id: "W1-T2652X", title: "Some task", acceptance: [{ claim: "c", proof: "p" }] },
    prUrl: "https://github.com/acme/remudero/pull/1",
    branch: "run-W1-T2652X-1730000000000",
    worktreePath,
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fixrung-birth-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: worktreePath, reviewerMount: FIX_RUNG_MOUNT },
  };
}

function initFixRungRepo(): { root: string; repoDir: string; worktreePath: string; branch: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t2652-birth-`));
  const seed = join(root, "seed");
  const origin = join(root, "origin.git");
  const repoDir = join(root, "repo");
  const worktreePath = join(root, "fix-worktree");
  const branch = "run-W1-T2652X-1730000000000";

  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { env: GIT_ENV });
  writeFileSync(join(seed, "file.ts"), "original\n");
  execFileSync("git", ["-C", seed, "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "--quiet", "-m", "seed"], { env: GIT_ENV });
  execFileSync("git", ["init", "--quiet", "--bare", origin], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "remote", "add", "origin", origin], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "push", "--quiet", "origin", "HEAD:main"], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "push", "--quiet", "origin", `HEAD:${branch}`], { env: GIT_ENV });
  execFileSync("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/main"], { env: GIT_ENV });
  execFileSync("git", ["clone", "--quiet", origin, repoDir], { env: GIT_ENV });

  createFixRungWorktree(repoDir, worktreePath, branch);
  return { root, repoDir, worktreePath, branch };
}

function snap(over: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return { status: "M  file.ts\0", diff: "diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-old\n+new\n", untrackedHash: "h1", ...over };
}

test("foreignTreeStandDownReason: dirty birth snapshot is foreign even before later drift", () => {
  const dirty = snap();
  const got = foreignTreeStandDownReason({
    round: 1,
    branch: "run-W1-T2652X-1730000000000",
    currentWorktreePath: "/tmp/current",
    birthSnapshot: dirty,
    currentSnapshot: dirty,
    registeredWorktrees: [{ path: "/tmp/other", branch: "run-W1-T2652X-1730000000000" }],
  });

  assert.ok(got);
  assert.match(got.reason, /not byte-clean at birth/);
  assert.deepEqual(got.porcelainPaths, [{ path: "file.ts", code: "M ", staged: true, unstaged: false }]);
  assert.deepEqual(got.diffstat, { filesChanged: 1, insertions: 1, deletions: 1 });
  assert.deepEqual(got.otherWorktrees, [{ path: "/tmp/other", branch: "run-W1-T2652X-1730000000000" }]);
});

test("foreignTreeStandDownReason: absent birth/current snapshots and later rounds fail toward running", () => {
  assert.equal(
    foreignTreeStandDownReason({
      round: 1,
      branch: "run-W1-T2652X-1730000000000",
      currentWorktreePath: "/tmp/current",
      birthSnapshot: undefined,
      currentSnapshot: snap(),
    }),
    undefined,
  );
  assert.equal(
    foreignTreeStandDownReason({
      round: 1,
      branch: "run-W1-T2652X-1730000000000",
      currentWorktreePath: "/tmp/current",
      birthSnapshot: snap({ status: "", diff: "", untrackedHash: "missing" }),
      currentSnapshot: undefined,
    }),
    undefined,
  );
  assert.equal(
    foreignTreeStandDownReason({
      round: 2,
      branch: "run-W1-T2652X-1730000000000",
      currentWorktreePath: "/tmp/current",
      birthSnapshot: snap({ status: "", diff: "", untrackedHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }),
      currentSnapshot: snap({ untrackedHash: "changed" }),
    }),
    undefined,
  );
});

test("runFixRung: round-1 drift from the real birth snapshot escalates without strike, spawn, push, commit, or mutation", async () => {
  const { root, worktreePath, branch } = initFixRungRepo();
  try {
    const birth = captureWorktreeSnapshotViaGit(worktreePath);
    assert.ok(worktreeSnapshotIsClean(birth), "newly materialized fix worktree must capture clean");

    const headBefore = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(join(worktreePath, "file.ts"), "foreign staged edit\n");
    execFileSync("git", ["-C", worktreePath, "add", "file.ts"], { env: GIT_ENV });

    const spawnCalls: SpawnWorkerArgs[] = [];
    const pushCalls: string[] = [];
    const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const issues = fakeIssueStore();
    const registered: RegisteredWorktree[] = [
      { path: worktreePath, branch },
      { path: "/tmp/other-worktree", branch },
      { path: "/tmp/different-worktree", branch: "main" },
    ];

    const outcome = await runFixRung({
      ...fixRungBaseOpts(worktreePath),
      branch,
      birthWorktreeSnapshot: birth,
      strikeCap: 2,
      initialReview: fakeReview("failure", [criterion({ claim: "fix it", met: false })]),
      deps: {
        spawn: async (args) => {
          spawnCalls.push(args);
          return result({ sessionId: `s-${spawnCalls.length}` });
        },
        waitForCiGreen: async () => "red",
        runReview: async () => fakeReview("failure", []),
        push: (wt) => {
          pushCalls.push(wt);
        },
        issues,
        ledgerPath: tmpLedgerPath(),
        log: (step, extra) => logs.push({ step, extra }),
        say: () => {},
        account: (r) => r,
        readLiveState: async () => ({ ok: true, state: "OPEN" }),
        captureWorktreeSnapshot: captureWorktreeSnapshotViaGit,
        readRegisteredWorktrees: async () => registered,
      },
    });

    assert.equal(outcome.outcome, "stood_down");
    assert.equal(outcome.strikes, 0);
    assert.equal(spawnCalls.length, 0, "no worker is spawned against foreign local content");
    assert.equal(pushCalls.length, 0, "foreign local content is never pushed");
    assert.equal(issues.calls.length, 1, "operator-decidable foreign content is escalated");
    assert.match(issues.calls[0].body, /did not observe an author/);
    assert.match(issues.calls[0].body, /will not reset, stash, clean, commit or push it/);

    const foreignRow = logs.find((l) => l.step === "rung.foreign_tree");
    assert.ok(foreignRow, "foreign-tree disposition gets its own named ledger row");
    assert.equal(foreignRow.extra?.strike, 1);
    assert.deepEqual(foreignRow.extra?.porcelain_paths, [{ path: "file.ts", code: "M ", staged: true, unstaged: false }]);
    assert.deepEqual(foreignRow.extra?.diffstat, { filesChanged: 1, insertions: 1, deletions: 1 });
    assert.deepEqual(foreignRow.extra?.other_worktrees, [{ path: "/tmp/other-worktree", branch }]);

    const stoodDown = logs.find((l) => l.step === "fix.stood_down");
    assert.equal(stoodDown?.extra?.site, "rung.foreign_tree");
    assert.equal(stoodDown?.extra?.issue_url, "https://github.com/acme/remudero/issues/1200");

    const headAfter = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const statusAfter = execFileSync("git", ["-C", worktreePath, "status", "--porcelain=v1"], { encoding: "utf8" });
    assert.equal(headAfter, headBefore, "no commit is created");
    assert.match(statusAfter, /^M  file\.ts/m, "the staged evidence remains staged for the operator");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runFixRung: missing birth snapshot never manufactures a foreign-tree stand-down", async () => {
  const worktreePath = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t2652-no-birth-`));
  const spawnCalls: SpawnWorkerArgs[] = [];

  try {
    execFileSync("git", ["init", "--quiet", "-b", "main", worktreePath], { env: GIT_ENV });
    writeFileSync(join(worktreePath, "file.ts"), "original\n");
    execFileSync("git", ["-C", worktreePath, "add", "-A"], { env: GIT_ENV });
    execFileSync("git", ["-C", worktreePath, "commit", "--quiet", "-m", "seed"], { env: GIT_ENV });

    const outcome = await runFixRung({
      ...fixRungBaseOpts(worktreePath),
      strikeCap: 1,
      initialReview: fakeReview("failure", [criterion({ claim: "fix it", met: false })]),
      deps: {
        spawn: async (args) => {
          spawnCalls.push(args);
          return result({ sessionId: "s-1" });
        },
        waitForCiGreen: async () => "red",
        runReview: async () => fakeReview("failure", []),
        push: () => {},
        issues: fakeIssueStore(),
        ledgerPath: tmpLedgerPath(),
        log: () => {},
        say: () => {},
        account: (r) => r,
        readLiveState: async () => ({ ok: true, state: "OPEN" }),
        captureWorktreeSnapshot: async () => snap(),
        readRegisteredWorktrees: async () => {
          throw new Error("registry unreadable");
        },
      },
    });

    assert.equal(spawnCalls.length, 1, "without a birth baseline, round 1 proceeds exactly as before");
    assert.equal(outcome.outcome, "escalated");
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
  }
});
