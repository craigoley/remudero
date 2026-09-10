import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import {
  buildSweepEffects,
  DEFAULT_SWEEP_POLICY,
  rebaseDirtyFleetBranchViaGit,
  runSweep,
  type BuildSweepEffectsDeps,
  type ClarificationQuestion,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { readLedgerLines } from "../src/lib/status.js";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Remudero Test",
  GIT_AUTHOR_EMAIL: "remudero-test@example.invalid",
  GIT_COMMITTER_NAME: "Remudero Test",
  GIT_COMMITTER_EMAIL: "remudero-test@example.invalid",
};

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-w1-t2999-")), "ledger.ndjson");
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, env: GIT_ENV, encoding: "utf8", stdio: "pipe" }) as string;
}

function dirtyFleetPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 2999,
    prUrl: "https://github.com/acme/remudero/pull/2999",
    taskId: "W1-T2999",
    reviewState: "none",
    checksState: "none",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-07T11:45:00.000Z",
    headSha: "old-head",
    headRefName: "run-W1-T2999-1789036344804",
    autoMergeArmed: false,
    mergeState: "dirty",
    mergeable: false,
    mergeableState: "dirty",
    mergeConflict: {
      files: [{ path: "src/lib/sweep.ts", oursDeleted: 1, theirsDeleted: 0 }],
      oursLog: "branch changed sweep.ts",
      theirsLog: "main changed sweep.ts too",
    },
    ...over,
  };
}

function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & {
  fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }>;
  escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }>;
} {
  const fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  const escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }> = [];
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: (pr, evidence) => {
      fixed.push({ pr, evidence });
    },
    escalate: (pr, reason, question) => {
      escalated.push({ pr, reason, question });
    },
    fixed,
    escalated,
    ledgerPath: ledgerPath(),
    runId: "SWEEP-W1-T2999",
    now: () => NOW,
    ...overrides,
  };
}

test("W1-T2999: a cleanly-rebasable fleet branch is rebased instead of escalated", async () => {
  const rebased: number[] = [];
  const deps = fakeDeps({
    rebaseDirtyFleetBranch: async (pr) => {
      rebased.push(pr.prNumber);
      return { outcome: "rebased", oldHeadSha: pr.headSha, newHeadSha: "new-head" };
    },
  });

  const summary = await runSweep([dirtyFleetPr()], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(summary.byDisposition["blocked-ambiguous"], 1);
  assert.deepEqual(rebased, [2999]);
  assert.equal(deps.escalated.length, 0, "the fleet branch rebase stands down the escalation");
  assert.equal(deps.fixed.length, 0, "this path does not spend a merge-conflict fix worker");
  const disposed = readLedgerLines(deps.ledgerPath).filter((line) => line.step === "sweep.disposed");
  assert.equal(disposed[0].acted, false, "a rebase is not recorded as the blocked-ambiguous escalation");
  assert.match(String(disposed[0].stand_down_reason), /rebased dirty fleet branch/);
  assert.match(String(disposed[0].stand_down_reason), /new-head/);
  assert.equal(readLedgerLines(deps.ledgerPath).some((line) => line.step === "sweep.dirty_fleet_rebase.rebased"), true);
});

test("W1-T2999: buildSweepEffects wires the default dirty-fleet rebase through real git", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t2999-real-git-"));
  const branch = "run-W1-T2999-1789036344804";
  const repoDir = join(root, "checkout");
  const originDir = join(root, "origin.git");
  const configRoot = join(root, "daemon");
  try {
    mkdirSync(repoDir, { recursive: true });
    git(root, ["init", "--bare", originDir]);
    git(repoDir, ["init"]);
    git(repoDir, ["checkout", "-b", "main"]);
    writeFileSync(join(repoDir, "README.md"), "base\n");
    git(repoDir, ["add", "README.md"]);
    git(repoDir, ["commit", "-m", "initial"]);
    git(repoDir, ["remote", "add", "origin", originDir]);
    git(repoDir, ["push", "-u", "origin", "main"]);

    git(repoDir, ["checkout", "-b", branch]);
    writeFileSync(join(repoDir, "branch.txt"), "branch change\n");
    git(repoDir, ["add", "branch.txt"]);
    git(repoDir, ["commit", "-m", "branch change"]);
    const oldHead = git(repoDir, ["rev-parse", "HEAD"]).trim();
    git(repoDir, ["push", "-u", "origin", branch]);

    git(repoDir, ["checkout", "main"]);
    writeFileSync(join(repoDir, "main.txt"), "main change\n");
    git(repoDir, ["add", "main.txt"]);
    git(repoDir, ["commit", "-m", "main change"]);
    git(repoDir, ["push", "origin", "main"]);

    const effects = buildSweepEffects({
      owner: "craigoley",
      repo: "remudero",
      repoRoot: repoDir,
      config: { root: configRoot, claudeBin: "/bin/true" } as Config,
      ledgerPath: join(configRoot, "state", "ledger.ndjson"),
      runId: "SWEEP-W1-T2999-real-git",
      plan: { tasks: [], byId: new Map() } as unknown as Plan,
      log: () => {},
      policy: DEFAULT_SWEEP_POLICY,
      nowMsImpl: () => 1234,
    } as BuildSweepEffectsDeps);

    const outcome = await withLiveWritesAllowed(() =>
      effects.rebaseDirtyFleetBranch!(dirtyFleetPr({ headSha: oldHead, headRefName: branch })),
    );

    assert.equal(outcome.outcome, "rebased");
    assert.equal(outcome.oldHeadSha, oldHead);
    assert.notEqual(outcome.newHeadSha, oldHead);
    const remoteHead = git(repoDir, ["ls-remote", "origin", `refs/heads/${branch}`]).trim().split(/\s+/)[0];
    assert.equal(remoteHead, outcome.newHeadSha, "the default effect updates the fleet branch on its origin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2999: buildSweepEffects preserves an injected dirty-fleet rebase implementation", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t2999-injected-rebase-"));
  try {
    const calls: OpenPrView[] = [];
    const effects = buildSweepEffects({
      owner: "craigoley",
      repo: "remudero",
      repoRoot: root,
      config: { root, claudeBin: "/bin/true" } as Config,
      ledgerPath: join(root, "state", "ledger.ndjson"),
      runId: "SWEEP-W1-T2999-injected-rebase",
      plan: { tasks: [], byId: new Map() } as unknown as Plan,
      log: () => {},
      policy: DEFAULT_SWEEP_POLICY,
      rebaseDirtyFleetBranchImpl: (pr) => {
        calls.push(pr);
        return { outcome: "conflict", reason: "synthetic conflict" };
      },
    } as BuildSweepEffectsDeps);

    const outcome = await effects.rebaseDirtyFleetBranch!(dirtyFleetPr({ prNumber: 3000 }));

    assert.equal(outcome.outcome, "conflict");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].prNumber, 3000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2999: a conflicting rebase still escalates", async () => {
  const deps = fakeDeps({
    rebaseDirtyFleetBranch: async () => ({ outcome: "conflict", reason: "git rebase reported content conflicts" }),
  });

  const summary = await runSweep([dirtyFleetPr()], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(summary.byDisposition["blocked-ambiguous"], 1);
  assert.equal(deps.escalated.length, 1, "a rebase conflict falls through to the existing escalation");
  assert.match(deps.escalated[0].reason, /merge conflict \(mergeState dirty\)/);
  assert.match(deps.escalated[0].reason, /never auto-resolved/);
  const attempts = readLedgerLines(deps.ledgerPath).filter((line) => line.step === "sweep.dirty_fleet_rebase.conflict");
  assert.equal(attempts.length, 1);
});

test("W1-T2999: a dirty fleet PR without the rebase dependency keeps the existing escalation path", async () => {
  const deps = fakeDeps();

  const summary = await runSweep([dirtyFleetPr()], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(summary.byDisposition["blocked-ambiguous"], 1);
  assert.equal(deps.escalated.length, 1);
  assert.match(deps.escalated[0].reason, /merge conflict \(mergeState dirty\)/);
});

test("W1-T2999: the git rebase helper refuses a branch that moved before checkout", () => {
  const commands: string[][] = [];
  const outcome = rebaseDirtyFleetBranchViaGit("/repo", "/tmp/w1-t2999-rebase", dirtyFleetPr(), {
    git: (_file, args) => {
      commands.push([...args]);
      const command = args.slice(2);
      if (command[0] === "fetch") return "";
      if (command[0] === "rev-parse" && command[1] === "refs/remotes/origin/run-W1-T2999-1789036344804") {
        return "other-head\n";
      }
      throw new Error(`unexpected git command: ${command.join(" ")}`);
    },
  });

  assert.equal(outcome.outcome, "lease-mismatch");
  assert.match(outcome.reason, /moved from old-head to other-head before the rebase started/);
  assert.equal(commands.some((args) => args.includes("worktree")), false, "a stale observed head is never checked out");
});

test("W1-T2999: the git rebase helper aborts and removes the worktree after a content conflict", () => {
  const commands: string[][] = [];
  const removed: string[] = [];
  const outcome = rebaseDirtyFleetBranchViaGit("/repo", "/tmp/w1-t2999-rebase", dirtyFleetPr(), {
    git: (_file, args) => {
      commands.push([...args]);
      const command = args.slice(2);
      if (command[0] === "fetch") return "";
      if (command[0] === "rev-parse" && command[1] === "refs/remotes/origin/run-W1-T2999-1789036344804") return "old-head\n";
      if (command[0] === "worktree") return "";
      if (command[0] === "rebase" && command[1] === "origin/main") throw new Error("CONFLICT (content): sweep.ts");
      if (command[0] === "rebase" && command[1] === "--abort") return "";
      throw new Error(`unexpected git command: ${command.join(" ")}`);
    },
    worktreeRemoveImpl: (_repoDir, worktreePath) => {
      removed.push(worktreePath);
    },
  });

  assert.equal(outcome.outcome, "conflict");
  assert.match(outcome.reason, /CONFLICT/);
  assert.equal(commands.some((args) => args.slice(2).join(" ") === "rebase --abort"), true);
  assert.deepEqual(removed, ["/tmp/w1-t2999-rebase"]);
});

test("W1-T2999: a branch advanced by another writer is left alone", async () => {
  const commands: string[][] = [];
  const removed: string[] = [];
  const branch = "run-W1-T2999-1789036344804";
  const helperOutcome = withLiveWritesAllowed(() =>
    rebaseDirtyFleetBranchViaGit("/repo", "/tmp/w1-t2999-rebase", dirtyFleetPr(), {
      git: (_file, args) => {
        commands.push([...args]);
        const command = args.slice(2);
        if (command[0] === "fetch") return "";
        if (command[0] === "rev-parse" && command[1] === `refs/remotes/origin/${branch}`) return "old-head\n";
        if (command[0] === "worktree") return "";
        if (command[0] === "rebase") return "";
        if (command[0] === "rev-parse" && command[1] === "HEAD") return "rebased-head\n";
        if (command[0] === "push") throw new Error("stale lease");
        throw new Error(`unexpected git command: ${command.join(" ")}`);
      },
      worktreeRemoveImpl: (_repoDir, worktreePath) => {
        removed.push(worktreePath);
      },
    }),
  );
  assert.equal(helperOutcome.outcome, "lease-mismatch");
  assert.deepEqual(
    commands.find((args) => args.includes("push"))?.slice(2),
    [
      "push",
      `--force-with-lease=refs/heads/${branch}:old-head`,
      "origin",
      `HEAD:refs/heads/${branch}`,
    ],
    "the only publish attempt is leased to the head the sweep judged",
  );
  assert.deepEqual(removed, ["/tmp/w1-t2999-rebase"], "a refused leased push still cleans up its worktree");

  const deps = fakeDeps({
    rebaseDirtyFleetBranch: async () => ({
      outcome: "lease-mismatch",
      reason: "origin moved from old-head to other-writer-head before the force-with-lease push",
    }),
  });

  const summary = await runSweep([dirtyFleetPr()], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(summary.byDisposition["blocked-ambiguous"], 1);
  assert.equal(deps.escalated.length, 1, "lease loss preserves the old escalation path");
  assert.match(deps.escalated[0].reason, /merge conflict \(mergeState dirty\)/);
  const attempts = readLedgerLines(deps.ledgerPath).filter((line) => line.step === "sweep.dirty_fleet_rebase.lease-mismatch");
  assert.equal(attempts.length, 1);
  assert.match(String(attempts[0].reason), /force-with-lease/);
});

test("W1-T2999: the git rebase helper verifies that a successful push actually moved origin", () => {
  const commands: string[][] = [];
  const outcome = withLiveWritesAllowed(() =>
    rebaseDirtyFleetBranchViaGit("/repo", "/tmp/w1-t2999-rebase", dirtyFleetPr(), {
      git: (_file, args) => {
        commands.push([...args]);
        const command = args.slice(2);
        if (command[0] === "fetch") return "";
        if (command[0] === "rev-parse" && command[1] === "refs/remotes/origin/run-W1-T2999-1789036344804") return "old-head\n";
        if (command[0] === "worktree") return "";
        if (command[0] === "rebase") return "";
        if (command[0] === "rev-parse" && command[1] === "HEAD") return "rebased-head\n";
        if (command[0] === "push") return "";
        if (command[0] === "ls-remote") return "some-other-head\trefs/heads/run-W1-T2999-1789036344804\n";
        throw new Error(`unexpected git command: ${command.join(" ")}`);
      },
      worktreeRemoveImpl: () => {},
    }),
  );

  assert.equal(outcome.outcome, "lease-mismatch");
  assert.match(outcome.reason, /reported success/);
  assert.match(outcome.reason, /some-other-head/);
  assert.equal(commands.some((args) => args.slice(2)[0] === "ls-remote"), true);
});

test("W1-T2999: the git rebase helper reports setup errors before a worktree exists", () => {
  const outcome = rebaseDirtyFleetBranchViaGit("/repo", "/tmp/w1-t2999-rebase", dirtyFleetPr(), {
    git: () => {
      throw new Error("fetch failed");
    },
  });

  assert.equal(outcome.outcome, "error");
  assert.match(outcome.reason, /fetch failed/);
});
