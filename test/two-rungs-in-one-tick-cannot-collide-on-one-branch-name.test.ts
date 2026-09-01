import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { addLaneWorktree, nextLaneEpochMs } from "../src/run-task.js";
import { worktreeAdd } from "../src/lib/worker.js";
import { taskIdFromRunBranch } from "../src/lib/status.js";

// W1-T2528 — THE DEFECT. A lane's runId is a PER-PROCESS name (`DAEMON-${Date.now()}`,
// `RETRO-${Date.now()}`, `${taskId}-${Date.now()}`, …) minted once, then handed straight to
// `const branch = \`run-${runId}\`` and `git worktree add -b`. `Date.now()` has 1ms resolution,
// so two rungs minted in the SAME millisecond got the SAME branch name — OBSERVED verbatim in
// the daemon's own log, 2026-08-31:
//
//     Preparing worktree (new branch 'run-DAEMON-1788127440289')
//     HEAD is now at c46e5f55 chore(plan): file ten findings ... (#3339)
//     Preparing worktree (new branch 'run-DAEMON-1788127440289')
//     fatal: a branch named 'run-DAEMON-1788127440289' already exists
//
// THE SAME EPOCH, TWICE. `pruneStaleRuns` cannot save it: the first rung's worktree is LIVE (its
// run lock is precisely what tells a concurrent prune to skip it), so the branch is still there
// when the second rung asks for the identical name. Which rung is lost depends on ordering, and
// nothing says a rung was skipped — `fatal:` is git's line, not the harness's, so there is no
// ledger row and no escalation.
//
// THE FIX IS A NAME, NOT A RETRY (`nextLaneEpochMs`, run-task.ts): a per-process clock that
// compares each reading only against the ONE immediately before it — two calls that read the
// identical real millisecond back-to-back get consecutive integers (the collision this task
// fixes); a call whose reading differs from the one before it — real time moved on, OR a test
// pinned `Date.now()` to an unrelated fixed value between cases — passes straight through
// unchanged. Decided BEFORE `worktreeAdd` is ever called; never a numbered-suffix retry after a
// failed add; never touches the run id used for ledger `run_id` fields. `addLaneWorktree`
// (run-task.ts) is the shared call site `retroCommand`/`triageCommand`/`planCommand` now route
// through, and also ledgers a failed add under its own step before rethrowing, so a genuine add
// failure (one `nextLaneEpochMs` cannot prevent) is still visible on the ledger rather than lost
// to `worktreeAdd`'s inherited git stderr.
//
// THE TASK LANE (`runTask`) IS DELIBERATELY NOT ROUTED THROUGH `nextLaneEpochMs`. Its runId is
// `${taskId}-${Date.now()}` — the taskId is ALREADY the per-rung component ("a task lane does
// not have this defect, because its name is run-<taskId>-<epochMs> and the taskId
// disambiguates" — this task's own rationale), and two rungs for the SAME taskId in one process
// are refused earlier, at the dispatch claim/inflight check, before ever reaching this line. It
// is left on bare `Date.now()` on purpose, byte-identical to before this task, so it keeps
// faith with the many fixtures elsewhere in this suite (run-task.test.ts,
// no-pr-followups-harvested.test.ts, recon-degrade.test.ts) that pin `Date.now()` to an exact
// value and assert it echoes into the runId unchanged.

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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

/** Freeze `Date.now()` for the duration of `fn`, restoring the real implementation after —
 *  the only way to deterministically FORCE the same-millisecond collision the live incident
 *  hit, rather than hoping a fast enough loop reproduces it by luck. */
function withFrozenClock<T>(epochMs: number, fn: () => T): T {
  const real = Date.now;
  Date.now = () => epochMs;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

test("nextLaneEpochMs never repeats within a process, even when the wall clock itself repeats", () => {
  const seen = new Set<number>();
  withFrozenClock(1788127440289, () => {
    let prev = -1;
    for (let i = 0; i < 50; i++) {
      const v = nextLaneEpochMs();
      assert.ok(v > prev, `nextLaneEpochMs must strictly increase even under a frozen clock (got ${v} after ${prev})`);
      assert.ok(!seen.has(v), `nextLaneEpochMs must never repeat a value (${v} seen twice)`);
      seen.add(v);
      prev = v;
    }
  });
});

test("acceptance (1,5): two rungs minted in the SAME millisecond get DISTINCT worktree branches with the fix, and reverting to bare Date.now() reproduces the observed collision naming the same branch twice", () => {
  const root = tmp("rmd-two-rungs-collision-");
  try {
    const clone = join(root, "clone");
    seedClone(clone);
    const frozenEpoch = 1788127440289; // the exact epoch the live incident logged

    withFrozenClock(frozenEpoch, () => {
      // THE PRE-FIX SHAPE, VERBATIM (`const branch = \`run-${runId}\`` built from bare
      // `Date.now()`): two rungs of the SAME lane, same frozen millisecond, produce the
      // IDENTICAL branch string — exactly `run-DAEMON-1788127440289` printed twice in the log.
      const brokenRunId1 = `DAEMON-${Date.now()}`;
      const brokenRunId2 = `DAEMON-${Date.now()}`;
      assert.equal(brokenRunId1, brokenRunId2, "reverting the fix reproduces the SAME runId twice");
      const brokenBranch1 = `run-${brokenRunId1}`;
      const brokenBranch2 = `run-${brokenRunId2}`;
      assert.equal(brokenBranch1, brokenBranch2, "the pre-fix shape names the SAME branch twice");
      worktreeAdd(clone, join(root, "broken-wt-1"), brokenBranch1, "origin/main");
      assert.throws(
        () => worktreeAdd(clone, join(root, "broken-wt-2"), brokenBranch2, "origin/main"),
        "the SECOND rung dies exactly as the live incident's 'fatal: a branch ... already exists' did",
      );

      // THE FIX: the SAME two rungs, same frozen millisecond, minting through nextLaneEpochMs
      // instead — the collision is impossible, not merely recovered from.
      const fixedRunId1 = `DAEMON-${nextLaneEpochMs()}`;
      const fixedRunId2 = `DAEMON-${nextLaneEpochMs()}`;
      assert.notEqual(fixedRunId1, fixedRunId2, "two rungs in one tick must mint distinct runIds");
      const fixedBranch1 = `run-${fixedRunId1}`;
      const fixedBranch2 = `run-${fixedRunId2}`;
      assert.notEqual(fixedBranch1, fixedBranch2, "two rungs in one tick must get distinct branch names");
      worktreeAdd(clone, join(root, "fixed-wt-1"), fixedBranch1, "origin/main");
      // Must NOT throw — this is the assertion the pre-fix shape above could never pass.
      worktreeAdd(clone, join(root, "fixed-wt-2"), fixedBranch2, "origin/main");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acceptance (2): retro/triage/plan each carry the per-rung component (nextLaneEpochMs) — regression guard against reintroducing bare Date.now() at any ONE of those three sites", () => {
  const src = readFileSync(join(repoRoot, "src", "run-task.ts"), "utf8");
  // The retro lane has no other per-instance id, so its whole fix IS this line.
  const retroMints = src.match(/const runId = `RETRO-\$\{[^}]*\}`;/g) ?? [];
  assert.equal(retroMints.length, 1, `expected exactly one retro runId mint, found ${retroMints.length}`);
  assert.ok(retroMints[0].includes("nextLaneEpochMs()"), `retro's runId mint must use nextLaneEpochMs(): ${retroMints[0]}`);

  // Triage (`TRIAGE-<feedbackId>`) and plan (`PLAN-<mode>`) both build their runId as
  // `${taskId}-${...}` — textually IDENTICAL to the task lane's OWN runId mint (acceptance 3,
  // below) except for what fills the epoch slot. There must be exactly THREE such sites in the
  // whole file (task, triage, plan): two on nextLaneEpochMs(), one deliberately still on bare
  // Date.now() — see acceptance (3) for why the task lane is the one exception.
  const taskShapedMints = src.match(/const runId = `\$\{taskId\}-\$\{[^}]*\}`;/g) ?? [];
  assert.equal(
    taskShapedMints.length,
    3,
    `expected exactly 3 \`\${taskId}-...\` runId mints (task, triage, plan), found ${taskShapedMints.length}: ${JSON.stringify(taskShapedMints)}`,
  );
  const onNextLaneEpochMs = taskShapedMints.filter((l) => l.includes("nextLaneEpochMs()"));
  const onBareDateNow = taskShapedMints.filter((l) => l.includes("Date.now()"));
  assert.equal(onNextLaneEpochMs.length, 2, "triage and plan must both use nextLaneEpochMs()");
  assert.equal(onBareDateNow.length, 1, "exactly the task lane must still use bare Date.now()");
});

test("acceptance (3): a task lane's run-<taskId>-<epochMs> branch shape is unchanged — same expression runTask itself uses (bare Date.now(), never nextLaneEpochMs), and taskIdFromRunBranch still resolves it so dispatch visibility and merge credit still work", () => {
  const taskId = "W1-T2528";
  const runId = `${taskId}-${Date.now()}`; // byte-identical to runTask's own `const runId = ...` line
  const branch = `run-${runId}`;
  assert.match(branch, /^run-W1-T2528-\d+$/, "the branch shape is byte-identical to before this task: run-<taskId>-<epochMs>");
  assert.equal(taskIdFromRunBranch(branch), taskId, "taskIdFromRunBranch must still recover the exact taskId");
});

test("acceptance (4): a worktree add that still fails is ledgered under worktree.add_failed (naming the branch and carrying real error text), not lost to git's own stderr, and is rethrown", () => {
  const root = tmp("rmd-two-rungs-reported-");
  try {
    const clone = join(root, "clone");
    const worktreesRoot = join(root, "worktrees");
    seedClone(clone);
    const runId = `RETRO-${nextLaneEpochMs()}`;
    const branch = `run-${runId}`;
    // Occupy the exact worktree path with a non-empty directory first, so `git worktree add`
    // fails for a reason nextLaneEpochMs's uniqueness cannot prevent (a genuine add failure,
    // not a name collision) — the case this task's acceptance (4) is about.
    const worktreePath = join(worktreesRoot, branch);
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "occupied.txt"), "not empty\n");

    const log: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const logger = (step: string, extra?: Record<string, unknown>) => log.push({ step, extra });

    assert.throws(() => addLaneWorktree(clone, worktreesRoot, runId, logger));
    const failure = log.find((l) => l.step === "worktree.add_failed");
    assert.ok(failure, "the failure must be ledgered under its own step, not silently dropped");
    assert.equal(failure?.extra?.branch, branch);
    assert.equal(typeof failure?.extra?.error, "string");
    assert.ok((failure?.extra?.error as string).length > 0, "the reported error must carry real text, not be empty git noise");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("addLaneWorktree acceptance (1): the common, single-attempt case cuts a real worktree on the expected run-<runId> branch and logs no failure", () => {
  const root = tmp("rmd-two-rungs-plain-");
  try {
    const clone = join(root, "clone");
    const worktreesRoot = join(root, "worktrees");
    seedClone(clone);
    const runId = `PLAN-fast-forward-${nextLaneEpochMs()}`;
    const log: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const logger = (step: string, extra?: Record<string, unknown>) => log.push({ step, extra });

    const { branch, worktreePath } = addLaneWorktree(clone, worktreesRoot, runId, logger);
    assert.equal(branch, `run-${runId}`);
    assert.equal(worktreePath, join(worktreesRoot, branch));
    assert.ok(!log.some((l) => l.step === "worktree.add_failed"), "the success path must not ledger a failure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("addLaneWorktree acceptance: two rungs of the SAME lane in one process, minted in the SAME frozen millisecond, both get their OWN worktree — the exact scenario the daemon log observed", () => {
  const root = tmp("rmd-two-rungs-samelane-");
  try {
    const clone = join(root, "clone");
    const worktreesRoot = join(root, "worktrees");
    seedClone(clone);
    const log: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const logger = (step: string, extra?: Record<string, unknown>) => log.push({ step, extra });

    withFrozenClock(1788127440289, () => {
      const runId1 = `RETRO-${nextLaneEpochMs()}`;
      const runId2 = `RETRO-${nextLaneEpochMs()}`;
      assert.notEqual(runId1, runId2);

      const first = addLaneWorktree(clone, worktreesRoot, runId1, logger);
      const second = addLaneWorktree(clone, worktreesRoot, runId2, logger);
      assert.notEqual(first.branch, second.branch, "two RETRO rungs in one tick must get distinct branches");
      assert.ok(!log.some((l) => l.step === "worktree.add_failed"), "neither rung should fail — this is the whole point of the fix");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
