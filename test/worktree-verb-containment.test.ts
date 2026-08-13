/**
 * W1-T452 — A WORKER MUST BE ABLE TO RUN `rmd` INSIDE THE WORKTREE IT WAS GIVEN.
 *
 * THE DEFECT: `checkCliFreshness` refuses on `diverged`, and `main()` turns any `refused` into
 * `process.exit(1)`. A worktree sits on `run-<taskId>-<epochMs>`, so from its FIRST COMMIT it is no
 * longer an ancestor of origin/main — DIVERGED, which is what a branch IS. Every subsequent verb
 * died in the place the worker was told to work. MEASURED: fourteen of the last fifteen implement
 * runs relocated to the daemon's live checkout to run `check-proof`, `preflight --ci-parity`,
 * `review` and `gh pr create`, and their COMMITS LANDED THERE as collateral.
 *
 * THE COMMITS ARE THE ACTUAL DAMAGE, so this suite asserts a real `git commit` inside a real
 * worktree lands in the worktree's own branch and leaves the shared checkout untouched — not merely
 * that a verb stopped exiting 1, which would pass on a change that removed the guard outright.
 *
 * THE PAIR THAT MATTERS IS IN ONE FILE ON PURPOSE: a worktree PERMITS *and* a diverged main checkout
 * still REFUSES. A suite asserting only the first passes on a change that relaxes both, which is
 * strictly worse than the defect.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkCliFreshness } from "../src/lib/self-sync.js";

const git = (dir: string, args: string[]): string =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8" });

/** A real origin + a real clone, plus a real LINKED WORKTREE cut from the clone. */
function fixture(): { originDir: string; localDir: string; worktreeDir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "w1t452-"));
  const originDir = join(root, "origin");
  const localDir = join(root, "local");
  const worktreeDir = join(root, "wt");
  mkdirSync(originDir, { recursive: true });
  git(originDir, ["init", "--quiet", "-b", "main"]);
  git(originDir, ["config", "user.email", "t@example.com"]);
  git(originDir, ["config", "user.name", "T"]);
  writeFileSync(join(originDir, "seed.txt"), "seed\n", "utf8");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", "init"]);
  execFileSync("git", ["clone", "--quiet", originDir, localDir], { encoding: "utf8" });
  git(localDir, ["config", "user.email", "t@example.com"]);
  git(localDir, ["config", "user.name", "T"]);
  // The real shape a worker is handed: a linked worktree on a run branch.
  git(localDir, ["worktree", "add", "--quiet", "-b", "run-W1-T452-1786600000000", worktreeDir, "HEAD"]);
  git(worktreeDir, ["config", "user.email", "worker@example.com"]);
  git(worktreeDir, ["config", "user.name", "Worker"]);
  return { originDir, localDir, worktreeDir, root };
}

/** Advance origin so the clone and its worktree are genuinely BEHIND. */
function publish(originDir: string, name: string): void {
  writeFileSync(join(originDir, `${name}.txt`), name, "utf8");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", name]);
}

// ── DIRECTION 1: the worktree PERMITS ─────────────────────────────────────────────────────────

test("a linked worktree that has DIVERGED is not refused — the worker never has to leave", () => {
  const f = fixture();
  publish(f.originDir, "published");
  // The worker's first commit: this is precisely what makes the branch stop being an ancestor.
  writeFileSync(join(f.worktreeDir, "work.txt"), "worker output\n", "utf8");
  git(f.worktreeDir, ["add", "."]);
  git(f.worktreeDir, ["commit", "--quiet", "-m", "the worker's own commit"]);

  const result = checkCliFreshness(f.worktreeDir, {});
  assert.equal(result.status, "worktree", `expected a worktree verdict, got ${result.status}`);
  assert.notEqual(result.status, "refused", "a refusal here is what sent fourteen of fifteen runs to the checkout");
});

test("a linked worktree that is merely BEHIND is not refused either — W1-T445's off-main path is cleared too", () => {
  // THE PATH A `diverged`-ONLY FIX WOULD MISS. With no commit of its own the worktree is still an
  // ancestor of origin/main, so it never reaches the divergence refusal — it falls through to
  // W1-T445's `off-main` refusal instead. Same exit 1, different reason.
  const f = fixture();
  publish(f.originDir, "published");
  const result = checkCliFreshness(f.worktreeDir, {});
  assert.equal(result.status, "worktree");
  assert.notEqual(result.status, "refused", "clearing only `diverged` would leave this one refusing");
});

test("a DIRTY linked worktree is not refused — a worktree mid-task always is", () => {
  const f = fixture();
  publish(f.originDir, "published");
  writeFileSync(join(f.worktreeDir, "seed.txt"), "locally edited\n", "utf8");
  const result = checkCliFreshness(f.worktreeDir, {});
  assert.equal(result.status, "worktree");
});

// ── DIRECTION 2: the operator's own checkout STILL REFUSES ────────────────────────────────────

test("a MAIN checkout that has diverged STILL refuses — the guard protects the human", () => {
  // THE TRAP. A change that relaxed both would pass every test above and be strictly worse than the
  // defect: the operator's own checkout is exactly what this guard exists for.
  const f = fixture();
  publish(f.originDir, "published");
  writeFileSync(join(f.localDir, "local-only.txt"), "operator work\n", "utf8");
  git(f.localDir, ["add", "."]);
  git(f.localDir, ["commit", "--quiet", "-m", "the operator's own commit"]);

  const result = checkCliFreshness(f.localDir, {});
  assert.equal(result.status, "refused", "the operator's checkout must still be protected");
  if (result.status === "refused") assert.equal(result.reason, "diverged");
});

test("a DIRTY main checkout still refuses, with reason `dirty`", () => {
  const f = fixture();
  publish(f.originDir, "published");
  writeFileSync(join(f.localDir, "seed.txt"), "uncommitted operator edit\n", "utf8");
  const result = checkCliFreshness(f.localDir, {});
  assert.equal(result.status, "refused");
  if (result.status === "refused") assert.equal(result.reason, "dirty");
});

test("a main checkout on a NON-main branch still refuses off-main — W1-T445 is not weakened", () => {
  const f = fixture();
  publish(f.originDir, "published");
  git(f.localDir, ["checkout", "--quiet", "-b", "some-feature"]);
  const result = checkCliFreshness(f.localDir, {});
  assert.equal(result.status, "refused");
  if (result.status === "refused") assert.equal(result.reason, "off-main");
});

// ── DIRECTION 3: THE ACTUAL DAMAGE — where the commit lands ───────────────────────────────────

test("a commit made inside the worktree lands on the WORKTREE's branch, not the shared checkout", () => {
  // The acceptance the shard demands. Asserting that a verb stopped exiting 1 is necessary and NOT
  // sufficient: the observed damage was commits in the wrong repository, so this asserts the
  // destination directly — the worktree's branch gains the commit and the checkout's `main` does not.
  const f = fixture();
  publish(f.originDir, "published");

  const localMainBefore = git(f.localDir, ["rev-parse", "main"]).trim();
  const localHeadBefore = git(f.localDir, ["rev-parse", "HEAD"]).trim();

  // The guard must not refuse first — that refusal is what drove the worker out of this directory.
  assert.equal(checkCliFreshness(f.worktreeDir, {}).status, "worktree");

  writeFileSync(join(f.worktreeDir, "delivered.txt"), "the task's real output\n", "utf8");
  git(f.worktreeDir, ["add", "."]);
  git(f.worktreeDir, ["commit", "--quiet", "-m", "feat: the work the task was dispatched for"]);

  const runBranch = git(f.worktreeDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  assert.equal(runBranch, "run-W1-T452-1786600000000");

  // The commit is ON the run branch...
  const subject = git(f.worktreeDir, ["log", "-1", "--pretty=%s"]).trim();
  assert.equal(subject, "feat: the work the task was dispatched for");
  // ...and the file exists in the worktree, not the checkout.
  assert.equal(readFileSync(join(f.worktreeDir, "delivered.txt"), "utf8").trim(), "the task's real output");

  // ...and the shared checkout moved NOT AT ALL. This is the assertion that would have caught the
  // real incident: fourteen runs' commits landed on the checkout's branch instead of here.
  assert.equal(git(f.localDir, ["rev-parse", "main"]).trim(), localMainBefore, "the checkout's main must not move");
  assert.equal(git(f.localDir, ["rev-parse", "HEAD"]).trim(), localHeadBefore, "the checkout's HEAD must not move");
  assert.equal(
    git(f.localDir, ["log", "-1", "--pretty=%s"]).trim(),
    "init",
    "the checkout must not have gained the worker's commit",
  );
});

// ── THE NO-`.git` CASE: still degrades, never throws ──────────────────────────────────────────

test("a directory with NO .git still returns `degraded`, never a throw — the /app shape", () => {
  // SECOND TRAP. `/app` in the container image has no `.git` (`verify-image.sh` records it), and the
  // worktree probe added here runs `git rev-parse` — it must not start throwing where this function
  // previously degraded. The fetch above already fails first, so this asserts the ORDER holds.
  const dir = mkdtempSync(join(tmpdir(), "w1t452-nogit-"));
  const result = checkCliFreshness(dir, {});
  assert.equal(result.status, "degraded", "a non-repo must degrade, not throw and not refuse");
});

test("the loop-guard and CI short-circuits are untouched — they still win before any git call", () => {
  const f = fixture();
  assert.equal(checkCliFreshness(f.worktreeDir, { RMD_SELF_SYNC_DONE: "1" }).status, "guarded");
  assert.equal(checkCliFreshness(f.worktreeDir, { CI: "true" }).status, "guarded");
});
