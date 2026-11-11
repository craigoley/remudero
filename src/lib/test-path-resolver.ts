import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { placePaths } from "./test-placement.js";
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
export const ELIGIBLE_TEST_PATH_RE = /^test\/(?:[^/]+\/)*[^/]+\.test\.ts$/;

export function isBasenameEligibleTestPath(path: string): boolean {
  return ELIGIBLE_TEST_PATH_RE.test(path) && !path.startsWith("test/fixtures/") && !path.split("/").includes("..");
}

/** A unique test basename survives a move; fixtures and all other paths retain exact identity. */
export function sameTestFile(a: string, b: string): boolean {
  return a === b || (isBasenameEligibleTestPath(a) && isBasenameEligibleTestPath(b) && posix.basename(a) === posix.basename(b));
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

function indexFor(opts: ResolveTestPathOptions): { index: TestBasenameIndex } | { reason: string } {
  const git = opts.git ?? defaultGit;
  const cache = opts.cache ?? processCache;
  // A directory with no `.git` entry of its own is no checkout: never let git walk up to an enclosing repository.
  if (opts.git === undefined && !existsSync(join(opts.root, ".git"))) return { reason: "no git checkout at the root" };
  let sha: string;
  try {
    sha = git.treeSha(opts.root, opts.tree ?? "HEAD");
  } catch (e) {
    return { reason: `the tree could not be read (${String((e as Error)?.message ?? e).split("\n")[0]})` };
  }
  if (!sha) return { reason: "the tree could not be read (no tree sha)" };
  const cached = cache.get(sha);
  if (cached) return { index: cached };
  let listed: string[];
  try {
    listed = git.listTestTree(opts.root, sha);
  } catch (e) {
    return { reason: `the tree's test files could not be listed (${String((e as Error)?.message ?? e).split("\n")[0]})` };
  }
  const index = buildTestBasenameIndex(listed);
  cache.set(sha, index);
  return { index };
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
  const read = indexFor(opts);
  if ("reason" in read) return { unresolved: "absent", candidates: [], reason: read.reason };
  const { index } = read;
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

/**
 * W1-T11501 — A TEST SHIPPED IN ITS COMPUTED FOLDER IS NOT A SCOPE WIDENING. `rmd test-place` computes a test's folder
 * from the file's own contents, so a shard that declares `test/a.test.ts` before the test exists names a sketch, not a
 * final path. ONE predicate (this one) admits the file that was written at the computed folder, for worker staging,
 * the implement/fix scope guards and the review scope comparison, so the four never disagree.
 *
 * ADMITTED only when ALL hold: a declared, eligible test path that has NEVER existed in the base tree; one candidate
 * with the SAME basename, new in this change, and the ONLY file of that basename in the base tree plus the change;
 * a regular file (no symlink) outside test/fixtures/ with no traversal; its directory is exactly `test/<folder>` for
 * the folder {@link placePaths} computes from the candidate's contents; and every marker the declared path's proofs
 * require is present, unchanged. Anything else keeps its old outcome (out of scope). Non-tests keep exact paths.
 */
export interface ComputedPlacementEvidence {
  /** The task's declared `files:`. */
  declaredFiles: readonly string[];
  /** The task's acceptance proofs (verbatim `proof:` strings); the markers a candidate must keep come from these. */
  proofs: readonly string[];
  /** Every test path in the BASE tree (before this change), never including the candidates. */
  baseTracked: readonly string[];
  /** The candidate's contents when it is a regular file (never a symlink), else the reason it is not readable. */
  read: (path: string) => string | { unreadable: string };
  /** The folder (`ci/suites`) the placement engine computes for the candidate; undefined or a throw is a refusal. */
  folderOf: (path: string) => string | undefined;
}

export interface ComputedPlacementOutcome {
  /** The candidates admitted as the declared test's computed-folder home. */
  admitted: Set<string>;
  /** Each refused eligible-looking candidate with the reason it kept exact-path treatment. */
  refusals: Map<string, string>;
}

/** A `grep:` proof body split into its pattern and an explicit path token (the shape review.ts's DIALECT_GREP_PATH_RE reads). */
export const GREP_PROOF_PATH_RE = /^(.*?)\s+in\s+(\S*[./*]\S*)$/i;

/** The markers a declared test's proofs require: each `grep: <pattern> in <declaredPath>` pattern, plus the titles of
 *  `unit test:` proofs when that declared test is the only eligible test the task declares. */
export function placementMarkersFor(declaredPath: string, proofs: readonly string[], soleDeclaredTest: boolean): string[] {
  const markers: string[] = [];
  for (const proof of proofs) {
    const grep = /^\s*grep:\s*(.*)$/i.exec(proof);
    if (grep) {
      const split = GREP_PROOF_PATH_RE.exec(grep[1]!.trim());
      if (split && split[2] === declaredPath && split[1]!.trim() !== "") markers.push(split[1]!.trim());
      continue;
    }
    const unit = /^\s*unit test:\s*(.+)$/i.exec(proof);
    if (unit && soleDeclaredTest) markers.push(unit[1]!.trim());
  }
  return markers;
}

/** The pure admission core: which candidate paths sit at the contents-computed folder of a declared, not-yet-created test. */
export function computedPlacementAdmission(candidates: readonly string[], ev: ComputedPlacementEvidence): ComputedPlacementOutcome {
  const outcome: ComputedPlacementOutcome = { admitted: new Set(), refusals: new Map() };
  const declaredTests = ev.declaredFiles.filter(isBasenameEligibleTestPath);
  if (declaredTests.length === 0) return outcome;
  const tracked = new Set(ev.baseTracked);
  const sameBasenameCount = (name: string): number =>
    new Set([...ev.baseTracked, ...candidates].filter((p) => posix.basename(p) === name)).size;
  for (const candidate of candidates) {
    if (!isBasenameEligibleTestPath(candidate)) continue;
    const name = posix.basename(candidate);
    const declared = declaredTests.filter((d) => posix.basename(d) === name);
    if (declared.length === 0 || declared.includes(candidate)) continue;
    const refuse = (reason: string): void => void outcome.refusals.set(candidate, reason);
    if (tracked.has(candidate)) { refuse("the candidate already exists in the base tree"); continue; }
    if (declared.some((d) => tracked.has(d))) { refuse("the declared test already exists in the base tree"); continue; }
    if (sameBasenameCount(name) !== 1) { refuse(`the basename ${name} is not unique in the base tree and this change`); continue; }
    const text = ev.read(candidate);
    if (typeof text !== "string") { refuse(text.unreadable); continue; }
    const soleDeclaredTest = declaredTests.length === 1;
    const markers = declared.flatMap((d) => placementMarkersFor(d, ev.proofs, soleDeclaredTest));
    if (markers.length === 0) { refuse("no criterion marker ties the candidate to the declared test"); continue; }
    const missing = markers.filter((m) => !text.includes(m));
    if (missing.length > 0) { refuse(`criterion marker(s) not preserved: ${missing.join(" | ")}`); continue; }
    let folder: string | undefined;
    try {
      folder = ev.folderOf(candidate);
    } catch (e) {
      const reason = `placement could not be computed (${String((e as Error)?.message ?? e).split("\n")[0]})`;
      refuse(reason); // the reason is carried into the outcome's refusals, never erased
      continue;
    }
    if (folder === undefined) { refuse("placement could not be computed"); continue; }
    if (posix.dirname(candidate) !== `test/${folder}`) { refuse(`the computed folder is test/${folder}/, not ${posix.dirname(candidate)}/`); continue; }
    outcome.admitted.add(candidate);
  }
  return outcome;
}

export interface ObservedPlacementOptions {
  /** The checkout holding the candidates on disk. */
  root: string;
  declaredFiles: readonly string[] | undefined;
  proofs: readonly string[];
  /** Changed paths to judge; only new eligible tests with a declared same-basename sibling can be admitted. */
  candidates: readonly string[];
  /** The base tree to list tests from (`git ls-tree`); default `HEAD`. Ignored when `baseTracked` is given. */
  baseRev?: string;
  /** The base tree's tests, or a thunk reading them (called only when a candidate could be admitted). */
  baseTracked?: readonly string[] | (() => readonly string[]);
}

/** Every test path under test/ in `rev` of the checkout at `root`. Throws when the tree cannot be read. */
export function listBaseTests(root: string, rev: string): string[] {
  return hostWorktreeGit(root, ["ls-tree", "-r", "--name-only", "-z", rev, "--", "test/"], { maxBuffer: 1 << 26 })
    .split("\0").filter(Boolean);
}

/** {@link computedPlacementAdmission} against a real checkout: git for the base tree, the filesystem for contents and
 *  the real placement engine for the folder. An unreadable base tree admits nothing, with the reason carried. */
export function observeComputedPlacement(opts: ObservedPlacementOptions): ComputedPlacementOutcome {
  const declaredFiles = opts.declaredFiles ?? [];
  const eligible = opts.candidates.filter(isBasenameEligibleTestPath);
  if (eligible.length === 0 || !declaredFiles.some(isBasenameEligibleTestPath)) return { admitted: new Set(), refusals: new Map() };
  let baseTracked: readonly string[];
  let treeSha: string;
  try {
    baseTracked = typeof opts.baseTracked === "function" ? opts.baseTracked()
      : opts.baseTracked ?? listBaseTests(opts.root, opts.baseRev ?? "HEAD");
    treeSha = hostWorktreeGit(opts.root, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"]).trim();
  } catch (e) {
    const reason = `the base tree could not be read (${String((e as Error)?.message ?? e).split("\n")[0]})`;
    return { admitted: new Set(), refusals: new Map(eligible.map((p) => [p, reason] as const)) };
  }
  return computedPlacementAdmission(eligible, {
    declaredFiles,
    proofs: opts.proofs,
    baseTracked,
    read: (path) => {
      const abs = join(opts.root, path);
      try {
        return lstatSync(abs).isFile() ? readFileSync(abs, "utf8") : { unreadable: "the candidate is not a readable regular file" };
      } catch (e) {
        return { unreadable: `the candidate is not a readable regular file (${String((e as Error)?.message ?? e).split("\n")[0]})` };
      }
    },
    folderOf: (path) => placePaths(opts.root, [path], treeSha)[0]?.placement.folder,
  });
}
