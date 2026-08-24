/**
 * test/fix-rung-unchanged-tree-stand-down.test.ts — W1-T1284.
 *
 * THE DEFECT. The fix rung's pre-strike gate (`fixRungStandDownReason`, site `rung.strike` in
 * run-task.ts) already re-reads WHO moved the head (`branchAuthorshipStandDownReason`) and
 * WHETHER the PR went terminal, both fresh every round. But a live head EQUAL to the rung's own
 * last-pushed head reads as "fine, not foreign" — correct for THAT check's own purpose (it exists
 * to catch a FOREIGN push) — so a strike whose own worker pushed nothing at all left no signal
 * anywhere that the next strike was about to run against a tree its own last strike never touched.
 * A `deps.push` failure, or a worker that edits files but never commits, never even reaches the
 * PR's remote head sha at all, so proxying through GitHub can never catch it either.
 *
 * THE FIX. `unchangedTreeStandDownReason` (pure) compares a fresh LOCAL worktree-content snapshot
 * (`captureWorktreeSnapshotViaGit` — tracked `git status`, uncommitted `git diff HEAD`, and a hash
 * of every untracked file's own bytes; re-derived from PrimeIntellect-ai/prime-agent's
 * `captureGitWorktreeSnapshot`, `e319a66d`) against the snapshot recorded the last time THIS SAME
 * gate (the failing check names / unmet criteria / conflicting files this round is about to target)
 * was about to be spent against. A first round has no recorded snapshot and is never read as a
 * match (exactly `branchAuthorshipStandDownReason`'s own "first round has no prior head"
 * contract). An unreadable capture, on either side, is never a match either — FAILS TOWARD
 * RUNNING, mirroring prime-agent's own `gitWorktreeSnapshotsEqual`. This is composed into the
 * EXISTING `fixRungStandDownReason` gate at site `rung.strike` — never a second early-return path
 * — and never covers `origin/main` or the check rollup, so a base that moves under the branch
 * (changing WHICH check is red) is read as a DIFFERENT gate, never "nothing changed".
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  runFixRung,
  worktreeSnapshotsEqual,
  unchangedTreeStandDownReason,
  captureWorktreeSnapshotViaGit,
  type WorktreeSnapshot,
} from "../src/run-task.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

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

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function fixRungBaseOpts() {
  return {
    taskId: "W1-T1284X",
    runId: "W1-T1284X-1730000000000",
    task: { id: "W1-T1284X", title: "Some task" },
    prUrl: "https://github.com/acme/remudero/pull/1",
    branch: "run-W1-T1284X-1730000000000",
    worktreePath: "/tmp/rmd-fixrung-unchanged-tree-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fixrung-unchanged-tree-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-fixrung-unchanged-tree-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fixrung-unchanged-tree-")), "ledger.ndjson");
}

function fakeIssueStore(): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }> } {
  let seq = 900;
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

function snap(over: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return { status: "M file.ts\0", diff: "diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-old\n+new\n", untrackedHash: "h1", ...over };
}

// ── worktreeSnapshotsEqual — the pure equality boundary (criterion 3) ───────────────────────────

test("worktreeSnapshotsEqual: two snapshots with identical status/diff/untrackedHash are equal", () => {
  assert.equal(worktreeSnapshotsEqual(snap(), snap()), true);
});

test("worktreeSnapshotsEqual: differing status, diff, or untrackedHash alone each break equality", () => {
  assert.equal(worktreeSnapshotsEqual(snap(), snap({ status: "M other.ts\0" })), false);
  assert.equal(worktreeSnapshotsEqual(snap(), snap({ diff: "diff --git a/other.ts b/other.ts\n" })), false);
  assert.equal(worktreeSnapshotsEqual(snap(), snap({ untrackedHash: "h2" })), false, "an untracked-only content change must still break equality");
});

test("worktreeSnapshotsEqual: FAILS TOWARD RUNNING — undefined on either side, or both sides, is never a match", () => {
  assert.equal(worktreeSnapshotsEqual(undefined, snap()), false);
  assert.equal(worktreeSnapshotsEqual(snap(), undefined), false);
  assert.equal(worktreeSnapshotsEqual(undefined, undefined), false);
});

// ── unchangedTreeStandDownReason — the pure boundary (criteria 1, 2, 3, 5) ──────────────────────

test("unchangedTreeStandDownReason: a FIRST round (no prior failure recorded) is never a match, no matter the snapshot", () => {
  assert.equal(unchangedTreeStandDownReason("ci:check-a", undefined, snap()), undefined);
});

test("unchangedTreeStandDownReason: the SAME gate with a BYTE-IDENTICAL snapshot stands down, naming the gate", () => {
  const got = unchangedTreeStandDownReason("ci:check-a", { gateKey: "ci:check-a", snapshot: snap() }, snap());
  assert.ok(got, "an unchanged tree against the same gate must be caught");
  assert.match(got.reason, /ci:check-a/);
  assert.match(got.reason, /byte-identical/);
});

test("unchangedTreeStandDownReason: a DIFFERENT gate key never reads as unchanged, even with an identical snapshot (base-move / fixed-then-newly-red discrimination)", () => {
  assert.equal(unchangedTreeStandDownReason("ci:check-b", { gateKey: "ci:check-a", snapshot: snap() }, snap()), undefined);
});

test("unchangedTreeStandDownReason: a changed snapshot on the SAME gate is real progress — never a match", () => {
  assert.equal(
    unchangedTreeStandDownReason("ci:check-a", { gateKey: "ci:check-a", snapshot: snap() }, snap({ untrackedHash: "h2" })),
    undefined,
  );
});

test("unchangedTreeStandDownReason: an unreadable CURRENT snapshot never manufactures a stand-down, even against a real recorded prior failure", () => {
  assert.equal(unchangedTreeStandDownReason("ci:check-a", { gateKey: "ci:check-a", snapshot: snap() }, undefined), undefined);
});

// ── captureWorktreeSnapshotViaGit — the real local-git reader ───────────────────────────────────

function initWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "w1t1284-wt-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", dir], { encoding: "utf8", env: GIT_ENV });
  writeFileSync(join(dir, "file.ts"), "original\n");
  execFileSync("git", ["-C", dir, "add", "-A"], { encoding: "utf8", env: GIT_ENV });
  execFileSync("git", ["-C", dir, "commit", "--quiet", "-m", "seed"], { encoding: "utf8", env: GIT_ENV });
  return dir;
}

test("captureWorktreeSnapshotViaGit: a clean checkout is stable across repeated captures", () => {
  const dir = initWorktree();
  try {
    const a = captureWorktreeSnapshotViaGit(dir);
    const b = captureWorktreeSnapshotViaGit(dir);
    assert.ok(a && b);
    assert.equal(worktreeSnapshotsEqual(a, b), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureWorktreeSnapshotViaGit: editing a TRACKED file (uncommitted) changes the snapshot", () => {
  const dir = initWorktree();
  try {
    const before = captureWorktreeSnapshotViaGit(dir);
    writeFileSync(join(dir, "file.ts"), "edited\n");
    const after = captureWorktreeSnapshotViaGit(dir);
    assert.ok(before && after);
    assert.equal(worktreeSnapshotsEqual(before, after), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureWorktreeSnapshotViaGit: adding an UNTRACKED file changes the snapshot even though tracked content and the diff are unchanged", () => {
  const dir = initWorktree();
  try {
    const before = captureWorktreeSnapshotViaGit(dir);
    writeFileSync(join(dir, "new-untracked.txt"), "brand new\n");
    const after = captureWorktreeSnapshotViaGit(dir);
    assert.ok(before && after);
    assert.equal(worktreeSnapshotsEqual(before, after), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureWorktreeSnapshotViaGit: an unreadable path (not a git worktree at all) returns undefined, never throws", () => {
  const notAWorktree = join(tmpdir(), "w1t1284-not-a-worktree-does-not-exist");
  assert.equal(captureWorktreeSnapshotViaGit(notAWorktree), undefined);
});

// ── the full rung, behaviorally — the five acceptance criteria ──────────────────────────────────

test("runFixRung (criterion 1): a strike is REFUSED when the worktree content is identical to the snapshot taken at the previous failed gate for the same check", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const unchangedSnapshot = snap();

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 3,
    initialReview: noReviewYet,
    ciFailures: [{ name: "ci", logTail: "tsc: error TS2322" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `s-${spawnCalls.length}` });
      },
      // The SAME required check stays red every round — the worker's own push landed nothing new.
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [{ name: "ci", logTail: "tsc: error TS2322" }],
      runReview: async () => noReviewYet,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      // Byte-identical worktree content on every round — nothing was ever committed.
      captureWorktreeSnapshot: async () => unchangedSnapshot,
    },
  });

  assert.equal(spawnCalls.length, 1, "exactly ONE strike — round 1's; round 2 is refused before it ever dispatches a fix worker");
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(outcome.strikes, 1, "the strike counter never moves past round 1");
  assert.match(outcome.standDownReason ?? "", /byte-identical/);
  assert.match(outcome.standDownReason ?? "", /ci:ci/);

  const stoodDown = logs.filter((l) => l.step === "fix.stood_down");
  assert.equal(stoodDown.length, 1);
  assert.equal(stoodDown[0].extra?.site, "rung.strike");
  assert.equal(stoodDown[0].extra?.strike, 2, "named as the strike that was about to be spent");
  assert.equal(stoodDown[0].extra?.reason, outcome.standDownReason);
});

test("runFixRung (criterion 2, tracked content): a strike whose worker changed TRACKED content still spends exactly as before", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);
  let captureCall = 0;
  const snapshots = [snap({ diff: "diff-v1" }), snap({ diff: "diff-v2", status: "M file.ts\0M other.ts\0" })];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: noReviewYet,
    ciFailures: [{ name: "ci", logTail: "tsc: error TS2322" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `s-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [{ name: "ci", logTail: "tsc: error TS2322" }],
      runReview: async () => noReviewYet,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      captureWorktreeSnapshot: async () => snapshots[Math.min(captureCall++, snapshots.length - 1)],
    },
  });

  assert.equal(spawnCalls.length, 2, "BOTH strikes spend — real tracked-content progress must never be mistaken for an unchanged tree");
  assert.equal(outcome.outcome, "escalated", "strikeCap exhausted after two genuine strikes, exactly as before this task");
  assert.equal(outcome.strikes, 2);
});

test("runFixRung (criterion 2, untracked file): a strike whose worker ADDED an untracked file still spends exactly as before, even with identical tracked status/diff", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);
  let captureCall = 0;
  const snapshots = [snap({ untrackedHash: "h1" }), snap({ untrackedHash: "h2" })];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: noReviewYet,
    ciFailures: [{ name: "ci", logTail: "tsc: error TS2322" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `s-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [{ name: "ci", logTail: "tsc: error TS2322" }],
      runReview: async () => noReviewYet,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      captureWorktreeSnapshot: async () => snapshots[Math.min(captureCall++, snapshots.length - 1)],
    },
  });

  assert.equal(spawnCalls.length, 2, "BOTH strikes spend — an untracked-only change is still real progress");
  assert.equal(outcome.outcome, "escalated");
  assert.equal(outcome.strikes, 2);
});

test("runFixRung (criterion 3a): OMITTING deps.captureWorktreeSnapshot behaves EXACTLY as before this task — every strike still spends", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: noReviewYet,
    ciFailures: [{ name: "ci", logTail: "tsc: error TS2322" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `s-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [{ name: "ci", logTail: "tsc: error TS2322" }],
      runReview: async () => noReviewYet,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      // No captureWorktreeSnapshot dep at all — the un-wired site's contract.
    },
  });

  assert.equal(spawnCalls.length, 2, "with no reader wired, both strikes spend — the un-wired contract");
  assert.equal(outcome.outcome, "escalated");
});

test("runFixRung (criterion 3b): a capture that is ALWAYS unreadable (returns undefined every round) never manufactures a stand-down", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: noReviewYet,
    ciFailures: [{ name: "ci", logTail: "tsc: error TS2322" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `s-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [{ name: "ci", logTail: "tsc: error TS2322" }],
      runReview: async () => noReviewYet,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      // Simulates a git failure (e.g. a reaped worktree) on every capture — never a match.
      captureWorktreeSnapshot: async () => undefined,
    },
  });

  assert.equal(spawnCalls.length, 2, "an always-unreadable capture never stands the rung down — every strike still spends");
  assert.equal(outcome.outcome, "escalated");
});

test("runFixRung (criterion 3c): a THROWING capture degrades to unreadable rather than propagating, and never manufactures a stand-down", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: noReviewYet,
    ciFailures: [{ name: "ci", logTail: "tsc: error TS2322" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `s-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [{ name: "ci", logTail: "tsc: error TS2322" }],
      runReview: async () => noReviewYet,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      captureWorktreeSnapshot: async () => {
        throw new Error("worktree reaped mid-round");
      },
    },
  });

  assert.equal(spawnCalls.length, 2, "a throwing capture never stands the rung down — every strike still spends");
  assert.equal(outcome.outcome, "escalated");
});

test("runFixRung (criterion 4): the refusal records a NAMED reason and never reports the gate as satisfied", async () => {
  const noReviewYet = fakeReview("failure", []);
  const unchangedSnapshot = snap();

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 3,
    initialReview: noReviewYet,
    ciFailures: [{ name: "ci", logTail: "tsc: error TS2322" }],
    deps: {
      spawn: async () => result({ sessionId: "s-1" }),
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [{ name: "ci", logTail: "tsc: error TS2322" }],
      runReview: async () => noReviewYet,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      captureWorktreeSnapshot: async () => unchangedSnapshot,
    },
  });

  assert.equal(outcome.outcome, "stood_down", "never 'fixed' — a stand-down is a refusal, not a pass");
  assert.notEqual(outcome.review.state, "success", "the underlying gate's own verdict is never rewritten to success");
  assert.ok(outcome.standDownReason && outcome.standDownReason.length > 0, "the refusal names an explicit reason");
});

test("runFixRung (criterion 5a): the strike cap and the escalation at the ceiling are UNCHANGED — a strikeCap of 1 still escalates after its one genuine strike", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);
  const issues = fakeIssueStore();

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: noReviewYet,
    ciFailures: [{ name: "ci", logTail: "tsc: error TS2322" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `s-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [{ name: "ci", logTail: "tsc: error TS2322" }],
      runReview: async () => noReviewYet,
      push: () => {},
      issues,
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      captureWorktreeSnapshot: async () => snap(),
    },
  });

  assert.equal(spawnCalls.length, 1, "the ONE strike strikeCap=1 allows is spent — never declined (nothing recorded yet on round 1)");
  assert.equal(outcome.outcome, "escalated", "the cap's own exhaustion escalation fires exactly as before this task");
  assert.equal(outcome.strikes, 1);
  assert.equal(issues.calls.length, 1, "the exhaustion escalation still opens exactly one issue");
});

test("runFixRung (criterion 5b): a base that moves under the branch — changing WHICH required check is red — is a DIFFERENT gate and does not trigger the refusal, even on an unchanged local worktree", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: noReviewYet,
    // Round 1 dispatches against "check-a" (this rung's own initial evidence).
    ciFailures: [{ name: "check-a", logTail: "" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `s-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "red",
      // Refreshed after round 1's push: the base has moved under this untouched head, and a
      // DIFFERENT required check ("check-b") is now the one reading red — never "check-a" again.
      fetchCiFailures: async () => [{ name: "check-b", logTail: "" }],
      runReview: async () => noReviewYet,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      // The LOCAL worktree genuinely never changed across both rounds.
      captureWorktreeSnapshot: async () => snap(),
    },
  });

  assert.equal(spawnCalls.length, 2, "round 2 still spends its strike — a newly-red check under a moved base is never told 'nothing changed'");
  assert.equal(outcome.outcome, "escalated");
  assert.equal(outcome.strikes, 2);
});
