/**
 * test/helpers/repo-root.ts — W1-T9863: the ONE way a test finds the repository root.
 *
 * About 989 tests used to compute the root as `..` from their own folder. A suite moved down a
 * level would then read `test/src` instead of `src`, and a census walking that wrong directory
 * can pass while comparing nothing. This module lives at a FIXED depth (`test/helpers/`, two
 * directories below the root), so the count of `..` is written once, here, and no caller counts
 * directories itself. Same shape as scripts/lib/repo-root.mjs (audit R-59), which gives every
 * scripts/*.mjs caller one derivation.
 *
 * The module's own path is symlink-resolved first, so a checkout reached through a link still
 * lands on the REAL root, and the result never depends on `process.cwd()`.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The package name this repository's package.json must carry. */
const PACKAGE_NAME = "remudero";

const SELF_PATH = realpathSync(fileURLToPath(import.meta.url));

/** The root two directories above this module, verified to hold this repository's package.json. */
function resolveRoot(): string {
  const root = join(dirname(SELF_PATH), "..", "..");
  const manifest = join(root, "package.json");
  if (!existsSync(manifest)) {
    throw new Error(`test/helpers/repo-root.ts: ${root} holds no package.json — this helper moved, or the checkout is not whole`);
  }
  const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name;
  if (name !== PACKAGE_NAME) {
    throw new Error(`test/helpers/repo-root.ts: ${manifest} names package ${JSON.stringify(name)}, not ${JSON.stringify(PACKAGE_NAME)}`);
  }
  return root;
}

/** The repository root, resolved once. */
export const REPO_ROOT: string = resolveRoot();

/** Returns {@link REPO_ROOT}. */
export function repoRoot(): string {
  return REPO_ROOT;
}
