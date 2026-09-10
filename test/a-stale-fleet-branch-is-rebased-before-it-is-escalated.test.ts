import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_SWEEP_POLICY,
  rebaseDirtyFleetBranchViaGit,
  runSweep,
  type ClarificationQuestion,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { readLedgerLines } from "../src/lib/status.js";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-w1-t2999-")), "ledger.ndjson");
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
