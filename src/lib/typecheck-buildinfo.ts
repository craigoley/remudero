/**
 * THE FLEET'S FULL TYPE-CHECK IS INCREMENTAL, PER WORKTREE, AND STARTS WARM.
 *
 * OBSERVED 2026-10-09 on the fleet host: a cold `tsc -p tsconfig.json --noEmit` (src plus ~3,000 test files) peaks at
 * 3.0–3.7 GB RSS inside the core daemon container, beside a 3–4.5 GB daemon, and validation containers with a 4 GiB
 * limit OOM-killed it 7 times in 3 days. MEASURED 2026-10-09 on a clone at 372b7f501 (TS 7.0.2): a cold check peaks at
 * 2.7–3.0 GB and ~12 CPU-seconds; the same check against its own `.tsbuildinfo` peaks at ~1.35 GB and ~2.5 CPU-seconds,
 * and reports the identical diagnostics (an edit that breaks a dependent file is still reported — tsc keys every cached
 * result by file content hash and dependency graph).
 *
 * WHERE THE BUILDINFO LIVES. In the checkout's own git directory — `.git/` for the canonical checkout, the private
 * `.git/worktrees/<name>/` for a linked worktree — so it is per worktree, invisible to `git status` and every
 * `git ls-files` census, never committable, and gone when the worktree is removed. A tree with no git directory gets
 * no buildinfo and runs the plain check.
 *
 * WHY A SEED NEEDS REBASING. tsc writes every path in the buildinfo relative to the buildinfo itself, and resolves
 * `node_modules` through its symlink. On the fleet a worktree at `worktrees/<id>` links `node_modules` to the canonical
 * checkout's, so the canonical buildinfo's `./node_modules/...` reads as `../../remudero/node_modules/...` from the
 * worktree. A seed copied verbatim misses every declaration file and the first check runs cold (MEASURED: 3.9 s and
 * 2.6 GB verbatim at a different depth, 1.4 s and 1.4 GB rebased). The tree's own files keep their tree-relative path;
 * everything outside the tree (its `node_modules` and git directory included) keeps its absolute location.
 *
 * A SEED CAN ONLY COST TIME, NEVER CHANGE A RESULT. tsc re-hashes every file it reads and discards any cached entry whose
 * hash, options or version differ, so a stale, foreign or unparseable seed degrades to a cold check. The version guard
 * below only skips work tsc would throw away.
 *
 * This module imports node builtins only, so `scripts/check.mjs` loads it directly under Node's type stripping.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The buildinfo's file name inside a checkout's git directory. */
export const TYPECHECK_BUILDINFO_NAME = "rmd-typecheck.tsbuildinfo";

/** The argv tail of the fleet's full type-check. `buildInfo` undefined is the plain, non-incremental check. */
export function typecheckArgs(buildInfo: string | undefined): string[] {
  const base = ["-p", "tsconfig.json", "--noEmit"];
  return buildInfo === undefined ? base : [...base, "--incremental", "--tsBuildInfoFile", buildInfo];
}

/** `root`'s git directory: `.git` itself, or the target of a linked worktree's `gitdir:` file. */
export function gitDirOf(root: string): string | undefined {
  const dotGit = join(root, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (m === null) return undefined;
    const dir = resolve(root, m[1]!);
    return existsSync(dir) ? dir : undefined;
  } catch {
    // No readable `.git`: this tree has no git directory to keep a buildinfo in, so it runs the plain check.
    return undefined;
  }
}

/** Where `root`'s own buildinfo lives, or undefined when `root` has no git directory. */
export function worktreeBuildInfoPath(root: string): string | undefined {
  const gitDir = gitDirOf(root);
  return gitDir === undefined ? undefined : join(gitDir, TYPECHECK_BUILDINFO_NAME);
}

/** The canonical checkout behind `root` and its buildinfo — the seed every worktree of it starts from. For a canonical
 *  checkout that is `root` itself. Undefined with no git directory, or a bare common directory (no tree to check). */
export function canonicalBuildInfo(root: string): { root: string; buildInfo: string } | undefined {
  const gitDir = gitDirOf(root);
  if (gitDir === undefined) return undefined;
  const commondir = join(gitDir, "commondir");
  if (!existsSync(commondir)) return basename(gitDir) === ".git" ? { root, buildInfo: join(gitDir, TYPECHECK_BUILDINFO_NAME) } : undefined;
  const common = resolve(gitDir, readFileSync(commondir, "utf8").trim());
  if (basename(common) !== ".git") return undefined;
  return { root: dirname(common), buildInfo: join(common, TYPECHECK_BUILDINFO_NAME) };
}

const within = (path: string, dir: string): boolean => path === dir || path.startsWith(dir + sep);

/** tsc's spelling of a path relative to the buildinfo: `./x` below it, `../x` above it. */
function tscRelative(fromDir: string, abs: string): string {
  const rel = relative(fromDir, abs).split(sep).join("/");
  if (rel === "") return ".";
  return rel.startsWith("../") || rel === ".." ? rel : `./${rel}`;
}

/** Rebase one buildinfo path. A bare name (`lib.es5.d.ts`) is tsc's bundled lib and has no location. */
function rebasePath(p: string, from: { root: string; dir: string }, to: { root: string; dir: string }): string {
  if (p !== "." && p !== ".." && !p.startsWith("./") && !p.startsWith("../") && !isAbsolute(p)) return p;
  const abs = resolve(from.dir, p);
  const inTree = within(abs, from.root) && !within(abs, join(from.root, "node_modules")) && !within(abs, join(from.root, ".git"));
  return tscRelative(to.dir, inTree ? join(to.root, relative(from.root, abs)) : abs);
}

const PATH_LIST_FIELDS = ["fileNames", "packageJsons", "missingPackageJsons"] as const;

/**
 * Rewrite a buildinfo written for `from` (its tree root and the buildinfo's own path) so it reads correctly at `to`.
 * Returns undefined when the text is not a buildinfo for `tsVersion` — tsc would discard it anyway.
 */
export function rebaseBuildInfo(
  text: string,
  from: { root: string; buildInfo: string },
  to: { root: string; buildInfo: string },
  tsVersion: string,
): string | undefined {
  let info: Record<string, unknown>;
  try {
    info = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON: not a buildinfo tsc could use either, so there is nothing to seed from.
    return undefined;
  }
  if (info === null || typeof info !== "object" || info.version !== tsVersion) return undefined;
  const src = { root: resolve(from.root), dir: dirname(resolve(from.buildInfo)) };
  const dst = { root: resolve(to.root), dir: dirname(resolve(to.buildInfo)) };
  for (const field of PATH_LIST_FIELDS) {
    const list = info[field];
    if (Array.isArray(list)) info[field] = list.map((p) => (typeof p === "string" ? rebasePath(p, src, dst) : p));
  }
  const options = info.options;
  if (options !== null && typeof options === "object" && !Array.isArray(options)) {
    const opts = options as Record<string, unknown>;
    for (const [key, value] of Object.entries(opts)) {
      if (typeof value === "string") opts[key] = rebasePath(value, src, dst);
    }
    if (typeof opts.tsBuildInfoFile === "string") opts.tsBuildInfoFile = tscRelative(dst.dir, resolve(to.buildInfo));
  }
  return JSON.stringify(info);
}

/** The TypeScript version installed for `root`, or undefined when there is none to read. */
export function installedTypescriptVersion(root: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "node_modules", "typescript", "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    // No readable typescript install: no version to match a seed against, so no seed is written.
    return undefined;
  }
}

export type SeedOutcome = "kept" | "seeded" | "published" | "no-seed" | "mismatch" | "unwritable";

/**
 * Write `from`'s buildinfo, rebased, at `to.buildInfo` — replacing whatever is there. Via a temp file and rename, so a
 * concurrent check never reads half a buildinfo.
 */
export function publishBuildInfo(
  from: { root: string; buildInfo: string },
  to: { root: string; buildInfo: string },
  tsVersion: string | undefined,
): SeedOutcome {
  if (tsVersion === undefined || !existsSync(from.buildInfo)) return "no-seed";
  try {
    const rebased = rebaseBuildInfo(readFileSync(from.buildInfo, "utf8"), from, to, tsVersion);
    if (rebased === undefined) return "mismatch";
    const tmp = `${to.buildInfo}.${process.pid}.tmp`;
    writeFileSync(tmp, rebased);
    renameSync(tmp, to.buildInfo);
    return "published";
  } catch {
    // Distinct from "no-seed": the seed existed and could not be read or written. Either way the check runs cold —
    // a seed is an optimisation, never a precondition.
    return "unwritable";
  }
}

/**
 * Give `to.buildInfo` a warm start from `from` when it has none yet. An existing buildinfo is the target's own, newer
 * history and is kept.
 */
export function seedBuildInfo(
  from: { root: string; buildInfo: string },
  to: { root: string; buildInfo: string },
  tsVersion: string | undefined,
): SeedOutcome {
  if (existsSync(to.buildInfo)) return "kept";
  const outcome = publishBuildInfo(from, to, tsVersion);
  return outcome === "published" ? "seeded" : outcome;
}

/**
 * Seed `buildInfo` — the check of the tree at `root` — from the canonical checkout behind `root`, when it has none yet.
 * The canonical checkout's own check needs no seed: its buildinfo IS the seed.
 */
export function seedFromCanonical(root: string, buildInfo: string): SeedOutcome {
  let canonical: { root: string; buildInfo: string } | undefined;
  try {
    canonical = canonicalBuildInfo(root);
  } catch {
    // An unreadable commondir names no canonical checkout, so there is no seed to look for.
    return "no-seed";
  }
  if (canonical === undefined || resolve(canonical.buildInfo) === resolve(buildInfo)) return "no-seed";
  return seedBuildInfo(canonical, { root, buildInfo }, installedTypescriptVersion(root));
}

/**
 * The full incremental check's argv tail for the checkout at `root`, seeding its buildinfo from the canonical
 * checkout's on first use. A tree with no git directory gets the plain check.
 */
export function prepareWorktreeTypecheck(root: string): { args: string[]; buildInfo?: string; seed: SeedOutcome } {
  const buildInfo = worktreeBuildInfoPath(root);
  if (buildInfo === undefined) return { args: typecheckArgs(undefined), seed: "no-seed" };
  return { args: typecheckArgs(buildInfo), buildInfo, seed: seedFromCanonical(root, buildInfo) };
}
