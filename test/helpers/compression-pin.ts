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
import { inspect, isDeepStrictEqual } from "node:util";
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

const CONTEXT = 10;
const ENTRY_CHARS = 80;

function renderEntry(entry: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(entry) ?? inspect(entry);
  } catch {
    text = inspect(entry, { depth: 2, breakLength: Infinity });
  }
  return text.length > ENTRY_CHARS ? `${text.slice(0, ENTRY_CHARS)}…` : text;
}

function renderWindow(side: string, tokens: readonly unknown[], index: number): string {
  const from = Math.max(0, index - CONTEXT);
  const to = Math.min(tokens.length, index + CONTEXT + 1);
  const lines = [];
  for (let i = from; i < to; i++) lines.push(`${i === index ? ">" : " "} ${i}: ${renderEntry(tokens[i])}`);
  return `${side} [${from}, ${to}):\n${lines.join("\n")}`;
}

/**
 * Assert two token streams are equal, naming the first differing index (or the shorter length) with
 * at most 10 entries either side. W1-T11342: a failing assert.deepEqual over two whole token arrays
 * builds a diff in roughly quadratic memory (10,000 tokens: 9.2 GiB), so a pin failure became a runaway.
 */
export function assertSameTokens<T>(actual: readonly T[], expected: readonly T[], message: string): void {
  const shorter = Math.min(actual.length, expected.length);
  let index = 0;
  while (index < shorter && isDeepStrictEqual(actual[index], expected[index])) index++;
  if (index === shorter && actual.length === expected.length) return;
  const window = (tokens: readonly T[]) => tokens.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1);
  throw new assert.AssertionError({
    message: [
      message,
      `first difference at index ${index}: actual length ${actual.length}, expected length ${expected.length}`,
      renderWindow("actual", actual, index),
      renderWindow("expected", expected, index),
    ].join("\n"),
    actual: window(actual),
    expected: window(expected),
    operator: "assertSameTokens",
  });
}
