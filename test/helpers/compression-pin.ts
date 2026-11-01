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
import { REPO_ROOT } from "./repo-root.js";

function gitOutput(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, `git ${args[0]} failed: ${result.error ?? result.stderr}`);
  return result.stdout;
}

/**
 * The merge-base version of `sourcePath` when the diff from `git merge-base origin/main HEAD`
 * ADDS the test at `testUrl` (pass `import.meta.url`), else `undefined`. A git failure throws
 * rather than reading as "not added", so a missing base never silently disables the comparison.
 */
export function compressionPinBase(sourcePath: string, testUrl: string, root = REPO_ROOT): string | undefined {
  const realRoot = realpathSync(root);
  const testPath = relative(realRoot, realpathSync(fileURLToPath(testUrl))).split("\\").join("/");
  assert.ok(!testPath.startsWith(".."), `the pin test must live inside ${realRoot}: ${testPath}`);
  const base = gitOutput(realRoot, ["merge-base", "origin/main", "HEAD"]).trim();
  const added = gitOutput(realRoot, ["diff", "--name-only", "--diff-filter=A", `${base}...HEAD`, "--", testPath]);
  if (added.trim() !== testPath) return undefined;
  return gitOutput(realRoot, ["show", `${base}:${sourcePath}`]);
}
