import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDaemonLaneWorktree } from "../src/run-task.js";
import { readRunLock, uniqueRunBranch, worktreeAdd, worktreeRemove } from "../src/lib/worker.js";

// W1-T2493 — THE DEFECT. `runId = DAEMON-${Date.now()}` is minted ONCE at daemon boot and a
// per-poll rung built once from it (`buildInboxDraftHook`/`draftProposalBatch`, run-task.ts)
// closes over that SAME string, asking `worktreeAdd` for the identical `run-<runId>` branch on
// every later poll that has work. `worktreeAdd`'s `-b` correctly refuses an existing branch, so
// the SECOND daemon-lane worktree in one boot died on
// `fatal: a branch named 'run-<runId>' already exists` — deterministically, every time, because
// `git worktree remove` never deletes the branch a worktree was checked out on (ordinary git),
// so the FIRST worktree's branch is always still there for the second attempt to collide on.
//
// THE FIX (uniqueRunBranch, lib/worker.ts; createDaemonLaneWorktree, run-task.ts): mint a
// per-attempt BRANCH suffix, never a new run id and never a force/reuse of an existing branch.
// These tests exercise the REAL git plumbing (a real local repo/remote, real worktrees) — no
// mocks — so reverting the fix (restoring `const branch = \`run-${runId}\`` at the call site,
// or reverting uniqueRunBranch to always return the bare name) makes the "second worktree"
// assertions below fail exactly as the live incident did.

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedClone(clone: string): void {
  mkdirSync(clone, { recursive: true });
  execFileSync("git", ["-C", clone, "init", "--quiet", "--initial-branch", "main"]);
  execFileSync("git", ["-C", clone, "config", "user.email", "probe@example.invalid"]);
  execFileSync("git", ["-C", clone, "config", "user.name", "probe"]);
  writeFileSync(join(clone, "seed.txt"), "x\n");
  execFileSync("git", ["-C", clone, "add", "-A"]);
  execFileSync("git", ["-C", clone, "commit", "--no-verify", "--quiet", "-m", "chore: seed"]);
  execFileSync("git", ["-C", clone, "remote", "add", "origin", clone]);
  execFileSync("git", ["-C", clone, "fetch", "origin", "--quiet"]);
}

test("uniqueRunBranch returns the plain run-<runId> name when nothing is taken — the common, single-attempt case is byte-identical to before this task", () => {
  const root = tmp("rmd-daemon-lane-plain-");
  try {
    const clone = join(root, "clone");
    seedClone(clone);
    assert.equal(uniqueRunBranch(clone, "DAEMON-1"), "run-DAEMON-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uniqueRunBranch acceptance (5/6): a branch left over from an earlier attempt with the SAME runId never blocks the next one, and the name it hands back is never one that already exists", () => {
  const root = tmp("rmd-daemon-lane-leftover-");
  try {
    const clone = join(root, "clone");
    seedClone(clone);
    // Simulate the residue `git worktree remove` leaves behind: a local run-<runId> branch
    // with no worktree pointing at it any more (exactly what draftProposalBatch's OWN prior
    // poll leaves once its worktree is torn down).
    execFileSync("git", ["-C", clone, "branch", "run-DAEMON-2"]);
    execFileSync("git", ["-C", clone, "branch", "run-DAEMON-2-2"]);
    const picked = uniqueRunBranch(clone, "DAEMON-2");
    assert.notEqual(picked, "run-DAEMON-2", "must not reuse the already-taken plain name");
    assert.notEqual(picked, "run-DAEMON-2-2", "must not reuse an already-taken suffixed name either");
    assert.equal(picked, "run-DAEMON-2-3", "picks the first genuinely free numbered suffix");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createDaemonLaneWorktree acceptance (1,2,3,5): cuts a SECOND worktree in one process from the SAME runId — different branch, both created, run id unchanged on both run.locks", () => {
  const root = tmp("rmd-daemon-lane-second-");
  try {
    const clone = join(root, "clone");
    const worktreesRoot = join(root, "worktrees");
    seedClone(clone);
    const log: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const runId = "DAEMON-1788100523733"; // the exact epoch shape the live incident logged
    const logger = (step: string, extra?: Record<string, unknown>) => log.push({ step, extra });

    // FIRST daemon-lane worktree of this boot — left ON DISK, not torn down, so the second
    // call below faces the worst case: the branch is not merely a dangling ref, a real
    // worktree still has it checked out.
    const first = createDaemonLaneWorktree(clone, worktreesRoot, runId, logger);
    assert.equal(first.branch, "run-DAEMON-1788100523733", "the FIRST attempt gets the plain name, unchanged from before this task");
    assert.ok(existsSync(first.worktreePath));

    // SECOND daemon-lane worktree of the SAME boot, SAME runId — this is exactly what
    // `buildInboxDraftHook`'s next poll does. Before the fix this threw
    // `fatal: a branch named 'run-DAEMON-1788100523733' already exists`.
    const second = createDaemonLaneWorktree(clone, worktreesRoot, runId, logger);
    assert.ok(existsSync(second.worktreePath), "the second worktree must actually be CREATED, not fail");
    assert.notEqual(second.branch, first.branch, "two daemon-lane worktrees in one process must get different branch names");

    // The run id itself — what the ledger's run_id field carries — must be byte-identical
    // across both worktrees; only the branch name changed.
    const firstLock = readRunLock(first.worktreePath);
    const secondLock = readRunLock(second.worktreePath);
    assert.equal(firstLock.kind, "live");
    assert.equal(secondLock.kind, "live");
    assert.equal(firstLock.kind === "live" && firstLock.info.run_id, runId);
    assert.equal(secondLock.kind === "live" && secondLock.info.run_id, runId);

    worktreeRemove(clone, first.worktreePath);
    worktreeRemove(clone, second.worktreePath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createDaemonLaneWorktree acceptance (4): a branch left over from a REAPED (already torn down) worktree does not block a fresh attempt with the same runId", () => {
  const root = tmp("rmd-daemon-lane-reaped-");
  try {
    const clone = join(root, "clone");
    const worktreesRoot = join(root, "worktrees");
    seedClone(clone);
    const log: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const logger = (step: string, extra?: Record<string, unknown>) => log.push({ step, extra });
    const runId = "DAEMON-3";

    const first = createDaemonLaneWorktree(clone, worktreesRoot, runId, logger);
    // Reap it the normal way — `worktreeRemove` deletes the worktree but (ordinary git)
    // leaves the branch behind, exactly the residue a crash-reap or a clean finish both leave.
    worktreeRemove(clone, first.worktreePath);

    const second = createDaemonLaneWorktree(clone, worktreesRoot, runId, logger);
    assert.ok(existsSync(second.worktreePath), "a fresh attempt must succeed despite the leftover branch");
    worktreeRemove(clone, second.worktreePath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acceptance (6): worktreeAdd itself is UNCHANGED — a genuine two-lane collision on one literal branch is still refused, never forced or reused", () => {
  const root = tmp("rmd-daemon-lane-collision-");
  try {
    const clone = join(root, "clone");
    seedClone(clone);
    worktreeAdd(clone, join(root, "wt-a"), "run-collide", "origin/main");
    // A second lane asking for the IDENTICAL literal branch name (not routed through
    // uniqueRunBranch at all) must still be refused outright — this task never weakens
    // worktreeAdd's own `-b` protection.
    assert.throws(() => worktreeAdd(clone, join(root, "wt-b"), "run-collide", "origin/main"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acceptance (7): a failed worktree add is REPORTED (ledgered `worktree.add_failed` naming the branch), not swallowed as bare git noise, and is rethrown", () => {
  const root = tmp("rmd-daemon-lane-reported-");
  try {
    const clone = join(root, "clone");
    const worktreesRoot = join(root, "worktrees");
    seedClone(clone);
    const runId = "DAEMON-4";
    // uniqueRunBranch will pick the plain "run-DAEMON-4" name (nothing taken yet) — occupy
    // that exact worktree PATH with a non-empty directory first, so `git worktree add` fails
    // for a reason `uniqueRunBranch`'s branch-existence check cannot see (a genuine add
    // failure, not a name collision it could have avoided).
    const worktreePath = join(worktreesRoot, "run-DAEMON-4");
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "occupied.txt"), "not empty\n");

    const log: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const logger = (step: string, extra?: Record<string, unknown>) => log.push({ step, extra });

    assert.throws(() => createDaemonLaneWorktree(clone, worktreesRoot, runId, logger));
    const failure = log.find((l) => l.step === "worktree.add_failed");
    assert.ok(failure, "the failure must be ledgered under its own step, not silently dropped");
    assert.equal(failure?.extra?.branch, "run-DAEMON-4");
    assert.equal(typeof failure?.extra?.error, "string");
    assert.ok((failure?.extra?.error as string).length > 0, "the reported error must carry real text, not be empty git noise");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acceptance (8): restoring the pre-fix shared branch name (bare run-<runId>, no per-attempt suffix) makes the second-worktree assertion fail — proving the tests above actually exercise the fix", () => {
  const root = tmp("rmd-daemon-lane-regression-");
  try {
    const clone = join(root, "clone");
    const worktreesRoot = join(root, "worktrees");
    seedClone(clone);
    const runId = "DAEMON-5";
    // This is `draftProposalBatch`'s PRE-FIX shape verbatim: a bare `run-${runId}` branch,
    // no uniqueRunBranch, second worktree left on disk (never removed) exactly like the
    // "second worktree in one process" test above.
    const branch = `run-${runId}`;
    worktreeAdd(clone, join(worktreesRoot, branch), branch, "origin/main");
    // `worktreeAdd` runs git with `stdio: "inherit"`, so the thrown Error's own `.message` is
    // just `Command failed: git ...` — the git-level `fatal: a branch named '...' already
    // exists` text goes straight to the inherited stderr, never into the JS error itself. The
    // THROW is what matters here (and what a caller — buildInboxDraftHook's outer catch —
    // actually observes and reports), so that is what this regression guard asserts.
    assert.throws(
      () => worktreeAdd(clone, join(worktreesRoot, `${branch}-attempt-2`), branch, "origin/main"),
      "the pre-fix branch-naming shape reproduces the live incident: the second attempt in " +
        "one boot dies exactly as the operator log's 'already exists' fatal showed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
