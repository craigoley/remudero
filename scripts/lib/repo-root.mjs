/**
 * ONE REPO-ROOT DERIVATION, USED BY EVERY scripts/*.mjs CALLER.
 *
 * Audit recon-2026-09-05 R-59: 12 scripts each re-derived the package root with their own copy of
 * `join(dirname(fileURLToPath(import.meta.url)), "..")` — one `join`/`dirname` per caller, each a
 * chance to get the `".."` count wrong once a file moves. This is the one derivation; every other
 * script imports {@link REPO_ROOT} (or calls {@link repoRoot}) instead of recomputing it.
 *
 * THE SHAPE `bin/rmd` ALREADY USES: resolve the SCRIPT'S OWN location (symlink-safe — `npm link`
 * and a global install both put an entry point on PATH as a symlink chain, not a copy) rather than
 * trusting `process.cwd()`, which is whatever directory the caller happened to invoke from. A
 * script invoked via `npm run <name>` from a nested `cwd` (or through `rmd`, which does not `cd`
 * first) must still resolve the same root a script invoked from the repo root does.
 *
 * FIXED DEPTH, NOT THE CALLER'S DEPTH. This module lives at a fixed location, `scripts/lib/`, two
 * directories below the root — unlike a caller at `scripts/*.mjs` (one directory below), which is
 * why every migrated caller's own `".."` count disappears along with its derivation: they import
 * the already-resolved value instead of counting directories themselves.
 */
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve any symlink in this module's own path before deriving from it — the same
// "resolve real location, not the launcher's" discipline `bin/rmd` applies via its `readlink`
// loop, so a `scripts/lib/repo-root.mjs` reached through a linked install still lands on the
// REAL package's root, not the symlink's parent.
const SELF_PATH = realpathSync(fileURLToPath(import.meta.url));

/** The package root: two directories up from this module's own (symlink-resolved) location.
 *  Never derived from `process.cwd()`, so a nested working directory changes nothing. */
export const REPO_ROOT = join(dirname(SELF_PATH), "..", "..");

/** Returns {@link REPO_ROOT}. A function wrapper alongside the constant so a caller that prefers
 *  `repoRoot()` (matching the parameter name most scripts already gave this value) reads no
 *  differently from one that imports the constant directly — both name the same value. */
export function repoRoot() {
  return REPO_ROOT;
}
