import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { hostWorktreeGit } from "./worktree-git.js";

/**
 * W1-T9860 — A TEST IS FOUND BY ITS UNIQUE BASENAME WHEN ITS CITED PATH IS GONE (operator ruling 5, 2026-10-16,
 * plan/seeds/test-restructure-2026-10-16/decisions.md). A test's unique basename is its identity:
 * test/every-test-basename-is-unique.test.ts keeps basenames unique, and every proof executor resolves a cited
 * `test/**.test.ts` path through {@link resolveTestPath}, so moving test/ into folders strands no proof and no merged
 * proof is rewritten.
 *
 * FAIL CLOSED. The exact path is tried first. Only then is the basename looked up, and only for a `test/**.test.ts`
 * shape outside test/fixtures/. Zero hits is `absent` and two or more is `ambiguous`; neither is ever guessed, so
 * every caller keeps its old outcome for an unresolved path.
 *
 * ONE INDEX PER TREE SHA. The basename index is built from `git ls-tree` of the tree being judged, once per tree SHA,
 * and cached in-process. A base and a head are two trees and get two indexes.
 */
export type TestPathResolution =
  | { path: string; how: "exact" | "basename" }
  | { unresolved: "absent" | "ambiguous"; candidates: string[]; reason?: string };

/** The git reads the resolver makes, injectable so a test can count index builds. */
export interface TestPathResolverGit {
  /** `git rev-parse <rev>^{tree}` in `root`; throws when `root` is no checkout or the rev is unknown. */
  treeSha: (root: string, rev: string) => string;
  /** Every path under test/ in `treeSha`, from `git ls-tree -r --name-only`. */
  listTestTree: (root: string, treeSha: string) => string[];
}

export interface ResolveTestPathOptions {
  /** The checkout the caller judges. */
  root: string;
  /** The tree to judge. Omitted means the checkout's own files on disk, indexed from its `HEAD`. */
  tree?: string;
  git?: TestPathResolverGit;
  /** The per-tree-SHA index cache. Omitted means the process-wide one. */
  cache?: Map<string, TestBasenameIndex>;
}

/** A tree's test files: the full set (for the exact check) and the basename index (for the fallback). */
export interface TestBasenameIndex {
  paths: ReadonlySet<string>;
  byBasename: ReadonlyMap<string, readonly string[]>;
}

/** A path the basename fallback may resolve: a `.test.ts` under test/, outside test/fixtures/, with no traversal. */
const ELIGIBLE_TEST_PATH_RE = /^test\/(?:[^/]+\/)*[^/]+\.test\.ts$/;

export function isBasenameEligibleTestPath(path: string): boolean {
  return ELIGIBLE_TEST_PATH_RE.test(path) && !path.startsWith("test/fixtures/") && !path.split("/").includes("..");
}

const defaultGit: TestPathResolverGit = {
  treeSha: (root, rev) => hostWorktreeGit(root, ["rev-parse", "--verify", "--quiet", `${rev}^{tree}`]).trim(),
  listTestTree: (root, treeSha) =>
    hostWorktreeGit(root, ["ls-tree", "-r", "--name-only", "-z", treeSha, "--", "test/"], { maxBuffer: 1 << 26 })
      .split("\0")
      .filter(Boolean),
};

const processCache = new Map<string, TestBasenameIndex>();

/** Build the basename index for a list of tracked paths. Exported so the uniqueness check reads the same rule. */
export function buildTestBasenameIndex(trackedPaths: readonly string[]): TestBasenameIndex {
  const paths = new Set<string>();
  const byBasename = new Map<string, string[]>();
  for (const path of trackedPaths) {
    if (!isBasenameEligibleTestPath(path)) continue;
    paths.add(path);
    const name = posix.basename(path);
    const list = byBasename.get(name);
    if (list) list.push(path);
    else byBasename.set(name, [path]);
  }
  return { paths, byBasename };
}

function indexFor(opts: ResolveTestPathOptions): TestBasenameIndex | string {
  const git = opts.git ?? defaultGit;
  const cache = opts.cache ?? processCache;
  // A directory with no `.git` entry of its own is no checkout: never let git walk up to an enclosing repository.
  if (opts.git === undefined && !existsSync(join(opts.root, ".git"))) return "no git checkout at the root";
  let sha: string;
  try {
    sha = git.treeSha(opts.root, opts.tree ?? "HEAD");
  } catch (e) {
    return `the tree could not be read (${String((e as Error)?.message ?? e).split("\n")[0]})`;
  }
  if (!sha) return "the tree could not be read (no tree sha)";
  const cached = cache.get(sha);
  if (cached) return cached;
  let listed: string[];
  try {
    listed = git.listTestTree(opts.root, sha);
  } catch (e) {
    return `the tree's test files could not be listed (${String((e as Error)?.message ?? e).split("\n")[0]})`;
  }
  const index = buildTestBasenameIndex(listed);
  cache.set(sha, index);
  return index;
}

/**
 * Resolve a cited test path in the tree being judged: exactly, else by its unique basename, else not at all.
 * With no `tree`, "exactly" means the file is on disk under `root`. With a `tree`, it means the tree lists it.
 */
export function resolveTestPath(pathOrBasename: string, opts: ResolveTestPathOptions): TestPathResolution {
  const cited = pathOrBasename.trim();
  const eligible = isBasenameEligibleTestPath(cited);
  if (opts.tree === undefined && !cited.split("/").includes("..") && existsSync(join(opts.root, cited))) {
    return { path: cited, how: "exact" };
  }
  if (!eligible) return { unresolved: "absent", candidates: [], reason: "not a test/**.test.ts path" };
  const index = indexFor(opts);
  if (typeof index === "string") return { unresolved: "absent", candidates: [], reason: index };
  if (opts.tree !== undefined && index.paths.has(cited)) return { path: cited, how: "exact" };
  const candidates = [...(index.byBasename.get(posix.basename(cited)) ?? [])].sort();
  if (candidates.length === 1) return { path: candidates[0]!, how: "basename" };
  if (candidates.length === 0) return { unresolved: "absent", candidates };
  return { unresolved: "ambiguous", candidates };
}

/** The one line a caller prints when it used the fallback, so a reviewer can see it happened. */
export function basenameResolutionNote(cited: string, resolved: string): string {
  return `resolved ${cited} -> ${resolved} by basename`;
}

/** Every basename two or more tests share, each naming its paths, from {@link buildTestBasenameIndex}'s own rule.
 *  test/every-test-basename-is-unique.test.ts fails on any row: a shared basename makes a moved test ambiguous. */
export function duplicateTestBasenames(trackedPaths: readonly string[]): string[] {
  const rows: string[] = [];
  for (const [name, paths] of buildTestBasenameIndex(trackedPaths).byBasename) {
    if (paths.length > 1) rows.push(`${name} is shared by ${[...paths].sort().join(" and ")}`);
  }
  return rows.sort();
}
