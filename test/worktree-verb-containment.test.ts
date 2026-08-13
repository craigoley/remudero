/**
 * W1-T452 — WORKERS BUILD IN THE DAEMON'S LIVE CHECKOUT BECAUSE `checkCliFreshness` REFUSED
 * ITSELF INSIDE A WORKTREE.
 *
 * THE CHAIN (see the task shard for the full rationale): `spawnContained` starts a worker with
 * `cwd: worktreePath` on `run-<taskId>-<epochMs>`, a branch cut from `origin/main` at claim time.
 * The moment that branch takes its FIRST COMMIT it is no longer `origin/main`'s ancestor — which
 * is what a branch on its own line of history IS, not a stale-binary condition. Before this fix,
 * the very next non-exempt `rmd` verb read that healthy divergence as `refused: "diverged"` (or
 * `"off-main"`), `main()` turned that into `process.exit(1)`, and the worker walked to the shared
 * checkout to find a verb that didn't refuse — landing ITS commits there instead.
 *
 * EVERY TEST HERE DRIVES REAL GIT REPOS, THREE OF THEM: an `origin`, the daemon's shared
 * `checkout` (a real clone of it — what the worker would have fled to), and a LINKED `worktree`
 * created off the checkout via `git worktree add -b <run-branch>`, the exact call `worktreeAdd`
 * (src/lib/worker.ts) makes when a task is claimed. Only `git worktree add` makes a directory's
 * `git rev-parse --git-dir` resolve under `checkout/.git/worktrees/<name>` — the fact this fix
 * reads to tell "a worker's worktree" apart from "an ordinary checkout on a feature branch"
 * (self-sync-branch-guard.test.ts already pins that the latter must keep refusing off-main).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkCliFreshness, type GitRunner } from "../src/lib/self-sync.js";

const git = (dir: string, args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

function planYaml(title: string): string {
  return `- id: T1\n  title: "${title}"\n  repo: remudero\n  type: implement\n`;
}

/**
 * `origin` + a real clone of it (`checkout`, standing in for the daemon's shared checkout) + a
 * LINKED worktree cut off `checkout` on a `run-<taskId>-<epochMs>`-shaped branch — the exact
 * shape `worktreeAdd` produces for a claimed task.
 */
function fixture(): { originDir: string; checkoutDir: string; worktreeDir: string; runBranch: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-worktree-containment-"));
  const originDir = join(root, "origin");
  const checkoutDir = join(root, "checkout");
  const worktreeDir = join(root, "worktree");
  mkdirSync(join(originDir, "plan"), { recursive: true });
  git(originDir, ["init", "--quiet", "-b", "main"]);
  git(originDir, ["config", "user.email", "test@example.com"]);
  git(originDir, ["config", "user.name", "Test"]);
  writeFileSync(join(originDir, "plan", "tasks.yaml"), planYaml("origin-title"), "utf8");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", "init"]);

  execFileSync("git", ["clone", "--quiet", originDir, checkoutDir], { encoding: "utf8" });
  git(checkoutDir, ["config", "user.email", "test@example.com"]);
  git(checkoutDir, ["config", "user.name", "Test"]);

  const runBranch = "run-W1-T999-1786600000000";
  git(checkoutDir, ["worktree", "add", "--quiet", "-b", runBranch, worktreeDir, "origin/main"]);
  git(worktreeDir, ["config", "user.email", "test@example.com"]);
  git(worktreeDir, ["config", "user.name", "Test"]);

  return { originDir, checkoutDir, worktreeDir, runBranch };
}

const headSha = (dir: string): string => git(dir, ["rev-parse", "HEAD"]).trim();
const currentBranch = (dir: string): string => git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();

/** Same shape as the sibling suites' `spies()`, plus a git-call log so a test can prove the
 *  worktree short-circuit costs exactly one call and it is never a fetch. */
function realGitDeps(dir: string) {
  const warnCalls: string[] = [];
  const gitCalls: string[][] = [];
  let reexecCalls = 0;
  const runner: GitRunner = (args) => {
    gitCalls.push(args);
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  };
  return {
    warnCalls,
    gitCalls,
    reexecCount: () => reexecCalls,
    deps: {
      git: runner,
      say: () => {},
      warn: (m: string) => void warnCalls.push(m),
      reexec: () => void reexecCalls++,
    },
  };
}

function commitInWorktree(worktreeDir: string, filename: string, content: string): void {
  writeFileSync(join(worktreeDir, filename), content, "utf8");
  git(worktreeDir, ["add", filename]);
  git(worktreeDir, ["commit", "--quiet", "-m", `worker commit: ${filename}`]);
}

// ── AC1: a worker's verb inside its worktree is not refused, so it never has to leave ─────────

test("a worker's verb inside its worktree is not refused after its first commit — it never has to leave", () => {
  const { worktreeDir } = fixture();
  // THE FALSIFIER: the worker's first commit makes HEAD strictly ahead of origin/main — no
  // longer origin/main's ancestor, which is what the OLD guard read as `refused: "diverged"`.
  commitInWorktree(worktreeDir, "worker-output.txt", "first commit\n");

  const { deps, gitCalls, reexecCount } = realGitDeps(worktreeDir);
  const result = checkCliFreshness(worktreeDir, {}, deps);

  assert.notEqual(result.status, "refused", "a worker must never be refused for its own worktree's healthy divergence");
  assert.equal(result.status, "guarded", "self-sync's operator-convenience contract does not apply inside a worktree");
  assert.deepEqual(
    gitCalls,
    [["rev-parse", "--git-dir"]],
    "detecting the worktree costs exactly one call, and it is never a fetch -- same no-mutation contract as the CI guard",
  );
  assert.equal(reexecCount(), 0, "guarded is a total no-op");
});

// ── AC2: a commit made by that worker lands in the worktree and not in the shared checkout ────

test("a worker's commit lands in the worktree, and the shared checkout it never had to flee to is untouched", () => {
  const { worktreeDir, checkoutDir, runBranch } = fixture();
  const checkoutHeadBefore = headSha(checkoutDir);

  // The worker never leaves (AC1), so every `git commit` it runs keeps `cwd` at the worktree it
  // was given -- modelled directly here, not inferred.
  commitInWorktree(worktreeDir, "worker-output.txt", "worker's own commit\n");
  const { deps } = realGitDeps(worktreeDir);
  const result = checkCliFreshness(worktreeDir, {}, deps);
  assert.equal(result.status, "guarded");

  assert.equal(currentBranch(worktreeDir), runBranch, "the commit landed on the worker's own run branch");
  assert.notEqual(headSha(worktreeDir), checkoutHeadBefore, "the worktree HEAD advanced past the shared base");
  // THE ASSERTION THAT MATTERS: the shared checkout is byte-identical, not merely "not obviously
  // broken" -- a fix that let the commit reach the checkout via any path would fail this.
  assert.equal(headSha(checkoutDir), checkoutHeadBefore, "the shared checkout's HEAD did not move");
  assert.equal(currentBranch(checkoutDir), "main", "the checkout is still on main, never switched to the run branch");
  const checkoutLog = git(checkoutDir, ["log", "--oneline", "main"]);
  assert.doesNotMatch(
    checkoutLog,
    /worker commit: worker-output\.txt/,
    "the worker's commit message never reaches the checkout's main history",
  );
});

// ── AC3: the guard still refuses a genuinely stale ORDINARY checkout, so the relaxation is scoped

test("the relaxation is SCOPED: a genuinely diverged ordinary checkout (not a linked worktree) still refuses", () => {
  const { originDir, checkoutDir } = fixture();
  // Origin gains a commit the checkout never fetched...
  writeFileSync(join(originDir, "plan", "tasks.yaml"), planYaml("newer-title"), "utf8");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", "newer"]);
  // ...while the checkout makes its own unpublished commit on ITS main -- clean tree, a real
  // non-ff divergence, the same shape self-sync.test.ts's "DIVERGED" case pins, reproduced here
  // so this suite proves scoping without depending on another file's fixture.
  writeFileSync(join(checkoutDir, "plan", "tasks.yaml"), planYaml("LOCAL-ONLY-COMMIT"), "utf8");
  git(checkoutDir, ["add", "."]);
  git(checkoutDir, ["commit", "--quiet", "-m", "local work"]);
  const before = headSha(checkoutDir);

  // `checkoutDir` is a plain `git clone`, never `git worktree add` -- `--git-dir` resolves to
  // `.git`, not a `worktrees/` path, so the W1-T452 short-circuit must NOT fire here.
  const { deps, reexecCount } = realGitDeps(checkoutDir);
  const result = checkCliFreshness(checkoutDir, {}, deps);

  assert.equal(result.status, "refused", "an ordinary checkout that has genuinely diverged must still refuse");
  if (result.status === "refused") assert.equal(result.reason, "diverged");
  assert.equal(headSha(checkoutDir), before, "a refusal must never mutate the ref");
  assert.equal(reexecCount(), 0, "nothing may re-exec on a refusal");
});
