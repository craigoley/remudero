// W1-T13897: the healed reviewer tree's cut and remove run `git worktree remove` off the event loop.
// On 2026-11-20 one sync remove from buildHealedReviewerTree held the daemon loop for 253,258 ms.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { healedReviewerTreeTools } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";

/** `prepare` refuses while `refusals` lasts, as prepareFreshOriginMainTree refuses a leftover tree, then cuts. */
function fixture(refusals = 0) {
  const repo = gitRepo({ kind: "w1-t13897" });
  const sha = repo.git("rev-parse", "HEAD");
  const worktreeRoot = join(repo.dir, ".trees");
  mkdirSync(worktreeRoot, { recursive: true });
  const adds: string[] = [];
  const prepare = (prefix: string, revision: string): string => {
    const path = `${worktreeRoot}/${prefix}-${revision.slice(0, 12)}`;
    if (refusals-- > 0) throw new Error(`${prefix} worktree at ${path} is not an exact clean detached checkout of ${revision}`);
    adds.push(path);
    execFileSync("git", ["-C", repo.dir, "worktree", "add", "-q", "--detach", path, revision], { stdio: "pipe" });
    return path;
  };
  return { repo, sha, worktreeRoot, adds, tools: healedReviewerTreeTools(repo.dir, worktreeRoot, prepare) };
}

test("W1-T13897 criterion 1: remove returns before git removes the tree, and the tree is gone once it settles", async () => {
  const f = fixture();
  const path = join(f.worktreeRoot, "healed-tree");
  f.repo.git("worktree", "add", "-q", "--detach", path, f.sha);
  const pending = f.tools.remove(path);
  assert.ok(pending instanceof Promise);
  assert.equal(existsSync(path), true, "the removal has not run on the caller's turn of the loop");
  await pending;
  assert.equal(existsSync(path), false);
  assert.doesNotMatch(f.repo.git("worktree", "list"), /healed-tree/);
});

test("W1-T13897 criterion 2: a cut over a leftover tree removes it off the loop, then cuts again", async () => {
  const f = fixture(1);
  const leftover = join(f.worktreeRoot, `healed-${f.sha.slice(0, 12)}`);
  f.repo.git("worktree", "add", "-q", "--detach", leftover, f.sha);
  const pending = f.tools.cut("healed", f.sha);
  assert.equal(f.adds.length, 0, "the leftover's removal has not run on the caller's turn of the loop");
  assert.equal(await pending, leftover);
  assert.deepEqual(f.adds, [leftover]);
  assert.equal(existsSync(leftover), true);
});

test("W1-T13897 invariant: a cut with nothing to remove keeps its own refusal", async () => {
  const f = fixture(2);
  await assert.rejects(f.tools.cut("healed", f.sha), /is not an exact clean detached checkout/);
  assert.deepEqual(f.adds, []);
});
