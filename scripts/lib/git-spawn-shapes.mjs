/**
 * W1-T6137 — the two git-spawn shapes W1-T6123's host-worktree-git census counts beyond the named
 * `"-C", <worktree spelling>` argv, defined ONCE. The census test
 * (test/every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf.test.ts) builds its widened
 * detector from these, and scripts/census-precheck.mjs reads the same patterns to decide whether a diff
 * joins that suite locally. The test file registers node:test cases at top level, so the precheck cannot
 * import it; this plain module can be loaded by plain node.
 *
 * The regexes carry the `g` flag: use `matchAll` (which clones) or reset `lastIndex` before `test`.
 */

/**
 * The head of a `"git"` call: a callee (an identifier or member chain) applied to the literal `"git"`
 * as its first argument.
 */
export const CWD_OPTION_GIT_SPAWN = /(?<![\w$.])(?<!\bnew\s+)([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\s*(?:\?\.)?\(\s*(["'`])git\2\s*[,)]/g;

/** A `-C` argv element: the quoted flag, a comma, then any expression (not a closing bracket). */
export const POSITIONAL_C = /(["'`])-C\1\s*,\s*(?=[^\s\])])/g;

/** Callees that take "git" first but spawn nothing: an error subclass's `super("git", …)`, and
 *  run-task.ts's `keyOf("git", args)`, which only builds a replay cache key. */
export const NOT_A_SPAWN = new Set(["super", "keyOf"]);

/**
 * Every text span in `text` that has either shape. A superset of the census's masked, comment-free
 * detector (it does not strip comments or literals): over-triggering runs one extra suite, under-triggering
 * lets a site reach CI unchecked.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function gitSpawnShapeMatches(text) {
  const out = [...text.matchAll(POSITIONAL_C)].map((m) => m[0]);
  for (const m of text.matchAll(CWD_OPTION_GIT_SPAWN)) if (!NOT_A_SPAWN.has(m[1])) out.push(m[0]);
  return out;
}
