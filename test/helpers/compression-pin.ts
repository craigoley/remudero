/**
 * test/helpers/compression-pin.ts — the comparison base for a comment-compression pin.
 *
 * A "comment compression preserves executable code" pin proves that ONE PR changed only comments.
 * A frozen digest of the whole module did that and then blocked every later feature edit to the
 * module, so each pin was regenerated or carved out by hand. The base-relative shape (first used by
 * test/sweep/compress-src-lib-sweep-ts.test.ts, W1-T10821) instead compares the module against
 * `git merge-base origin/main HEAD` only on the PR that ADDS the pin, and is inert afterwards.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function gitOutput(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, `git ${args[0]} failed: ${result.error ?? result.stderr}`);
  return result.stdout;
}

/** Whether `testPath` is in the index. `git ls-files --error-unmatch` exits 1 for an untracked path;
 *  any other failure (not a repository, git missing) throws, so it never reads as "untracked". */
function pinIsTracked(root: string, testPath: string): boolean {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", testPath], { cwd: root, encoding: "utf8" });
  if (result.status === 0) return true;
  assert.equal(result.status, 1, `git ls-files failed: ${result.error ?? result.stderr}`);
  return false;
}

/**
 * The merge-base version of `sourcePath` when the diff from `git merge-base origin/main HEAD`
 * ADDS the test at `testUrl` (pass `import.meta.url`), HEAD's committed version when that test is
 * untracked (W1-T11312: it is being added), else `undefined`. A git failure throws
 * rather than reading as "not added", so a missing base never silently disables the comparison.
 */
export function compressionPinBase(sourcePath: string, testUrl: string, root = REPO_ROOT): string | undefined {
  const realRoot = realpathSync(root);
  const testPath = relative(realRoot, realpathSync(fileURLToPath(testUrl))).split("\\").join("/");
  assert.ok(!testPath.startsWith(".."), `the pin test must live inside ${realRoot}: ${testPath}`);
  // W1-T11312: an UNTRACKED pin is one being added — the reviewer's base run copies a PR's added test
  // into a merge-base worktree, where the added-diff below is empty — so it compares against HEAD's
  // committed module, and its guarded reductions run (and fail at base) instead of passing vacuously.
  if (!pinIsTracked(realRoot, testPath)) return gitOutput(realRoot, ["show", `HEAD:${sourcePath}`]);
  const base = gitOutput(realRoot, ["merge-base", "origin/main", "HEAD"]).trim();
  const added = gitOutput(realRoot, ["diff", "--name-only", "--diff-filter=A", `${base}...HEAD`, "--", testPath]);
  if (added.trim() !== testPath) return undefined;
  return gitOutput(realRoot, ["show", `${base}:${sourcePath}`]);
}
