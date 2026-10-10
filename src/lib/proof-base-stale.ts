import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { visibleCriteria } from "./plan.js";
import {
  baseBlobErrorIsAbsence,
  execWhitelistedProof,
  parseWhitelistedProof,
  preexistingProofHits,
  type ProofExecutor,
  type WhitelistedProof,
} from "./review.js";
import { RMD_TMP_PREFIX } from "./tmp.js";
import { hostWorktreeGit } from "./worktree-git.js";

/**
 * W1-T4921 — A `grep:` PROOF THE REVIEWER WILL GRADE STALE, ASKED IN MILLISECONDS AND IN-PROCESS.
 *
 * `proof-discrimination` wants a proof to FAIL at the merge base and PASS at the head. `rmd check-proof --base` answers
 * that with one process tree per proof (7-11 s measured); the reviewer's own classifier, {@link preexistingProofHits},
 * answers it for a `grep:` proof from ONE base blob and no worktree. ONE PREDICATE: the pre-push precheck and
 * `rmd preflight --proofs` both call this, so the hook and the verb cannot disagree about which proofs are stale.
 * `unit test:` proofs are left to the gate, because running a test at the base is not cheap.
 */
export interface StaleProofRow {
  claim: string;
  proof: string;
  why: string;
}

export type ProofCriterion = { claim?: string; proof?: string; satisfied_by?: string; holdout?: boolean; kind?: string };

export interface StaleProofReaders extends BaseGrepTreeReaders {
  makeDir?: () => string;
  exec?: ProofExecutor;
}

/** The dialect `grep:` shape the reviewer's executor reads at both commits; a legacy fenced grep is not one. */
export function isDialectGrepProof(proof: string): boolean {
  const w = parseWhitelistedProof(proof.trim());
  return w !== null && isDialectGrep(w);
}

function isDialectGrep(w: WhitelistedProof): boolean {
  return w.kind === "grep" && w.authorSelectedArgv !== true && w.args.length === 4 && w.args[0] === "-arn" && w.args[1] === "--";
}

// ── The base side of a `grep:` proof, without a checkout ─────────────────────────────────────────
//
// OBSERVED 2026-10-10 on the fleet host at load 30: `rmd check-proof --base origin/main` for ONE
// `grep: ^  status: merged$ in <a task shard>` spent 66 minutes inside the `git reset --hard`
// of `git worktree add --detach`, a checkout of all ~8,100 files and a fresh index, to answer a grep
// over one blob. The dialect executor runs `grep -arn -- <pattern> <path>` and reads nothing but
// `<path>`, so a tree holding exactly the bytes a checkout would write at `<path>` (and nothing
// else) gives that grep the same input, and so the same exit, stdout and binary handling.

/** One `git ls-tree` row: what a checkout writes at `path`. */
export interface BaseTreeEntry {
  mode: string;
  type: string;
  path: string;
}

/** How {@link materialiseBaseGrepTree} reads the base. Real callers inject none. */
export interface BaseGrepTreeReaders {
  /** `git ls-tree` of `paths` at `rev`: with `recursive`, every entry at or beneath each (`-r -t`). */
  listTree?: (cwd: string, rev: string, paths: readonly string[], recursive: boolean) => BaseTreeEntry[];
  /** One blob's bytes exactly as a checkout writes them: its eol and smudge filters applied. */
  readBlob?: (cwd: string, rev: string, repoRelPath: string) => Buffer;
  /** A file-only seam (`git show <rev>:<path>`) for fixtures that supply a literal base text with no
   *  real rev behind it. When set it replaces both readers above. */
  showBlob?: (cwd: string, rev: string, repoRelPath: string) => string;
}

/** What {@link materialiseBaseGrepTree} could not put in the tree, keyed by the proof's own target text. */
export interface BaseGrepTree {
  /** The base read broke, so nothing is known about the base for this target (W1-T460). Never absence. */
  unreadable: string[];
  /** A symlink or submodule sits at, beneath or above the target. A tree of plain files cannot reproduce
   *  what grep resolves through it, so only a real checkout answers for this target. */
  needsCheckout: string[];
}

/** The target path of every executable proof when each is a house-dialect `grep:`; `undefined` when any
 *  proof needs a real tree: a `unit test:` re-runs code, and a legacy fenced grep's argv is the author's own. */
export function grepOnlyBaseTargets(criteria: ReadonlyArray<{ proof?: string }>): string[] | undefined {
  const targets: string[] = [];
  for (const c of criteria) {
    const w = typeof c.proof === "string" ? parseWhitelistedProof(c.proof) : null;
    if (w === null) continue;
    if (!isDialectGrep(w)) return undefined;
    targets.push(w.args[3]!);
  }
  return targets;
}

/** The repo-relative spelling git reads for a grep target: `./a//b/` and `a/b` name one path. */
function repoRelTarget(target: string): string {
  const normalised = posix.normalize(target).replace(/\/+$/, "");
  return normalised === "" ? "." : normalised;
}

/** GIT_LITERAL_PATHSPECS: a target is a path, never a pattern; `?` and `[` are legal in one. */
const LS_TREE_OPTIONS = { env: { GIT_LITERAL_PATHSPECS: "1" }, maxBuffer: 1 << 26 };

function lsTreeArgv(rev: string, paths: readonly string[], recursive: boolean): string[] {
  return ["ls-tree", ...(recursive ? ["-r", "-t"] : []), "-z", "--full-tree", rev, "--", ...paths];
}

function lsTreeRows(out: string): BaseTreeEntry[] {
  return out
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const tab = row.indexOf("\t");
      const [mode = "", type = ""] = row.slice(0, tab).split(" ");
      return { mode, type, path: row.slice(tab + 1) };
    });
}

function defaultListTree(cwd: string, rev: string, paths: readonly string[], recursive: boolean): BaseTreeEntry[] {
  return lsTreeRows(hostWorktreeGit(cwd, lsTreeArgv(rev, paths, recursive), LS_TREE_OPTIONS));
}

function defaultReadBlob(cwd: string, rev: string, repoRelPath: string): Buffer {
  return Buffer.from(hostWorktreeGit(cwd, ["cat-file", "--filters", `${rev}:${repoRelPath}`], { maxBuffer: 1 << 26, encoding: "latin1" }), "latin1");
}

/** Every proper ancestor of `rel`: `a/b/c.ts` → `a`, `a/b`. */
function ancestorsOf(rel: string): string[] {
  const parts = rel.split("/");
  return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/**
 * Write into `dir` exactly what a checkout of `rev` holds at each target, and nothing else: a file's
 * bytes as a checkout writes them, a directory with everything beneath it, and NOTHING for a target
 * absent at `rev`, so grep exits 2 there exactly as it does in a checkout that lacks the path. A
 * target this cannot reproduce faithfully is named in `needsCheckout`; a broken read in `unreadable`.
 */
export function materialiseBaseGrepTree(
  cwd: string,
  rev: string,
  targets: readonly string[],
  dir: string,
  readers: BaseGrepTreeReaders = {},
): BaseGrepTree {
  const listTree = readers.listTree ?? defaultListTree;
  const readBlob = readers.readBlob ?? defaultReadBlob;
  const unreadable: string[] = [];
  const needsCheckout: string[] = [];
  const write = (rel: string, bytes: string | Buffer): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), bytes);
  };
  for (const target of new Set(targets)) {
    const rel = repoRelTarget(target);
    if (readers.showBlob) {
      try {
        write(rel, readers.showBlob(cwd, rev, rel));
      } catch (e) {
        // Absent at the base is the healthy forward reference: nothing is written, as before.
        if (!baseBlobErrorIsAbsence(e)) unreadable.push(target);
      }
      continue;
    }
    try {
      const rows = listTree(cwd, rev, [rel], true).filter((r) => rel === "." || r.path === rel || r.path.startsWith(`${rel}/`));
      if (rows.length === 0) {
        // Absent, unless a SYMLINKED ancestor hides it from ls-tree while a checkout resolves through it.
        const ancestors = ancestorsOf(rel);
        if (ancestors.length > 0 && listTree(cwd, rev, ancestors, false).some((r) => r.mode === "120000" && ancestors.includes(r.path))) {
          needsCheckout.push(target);
        }
        continue;
      }
      if (rows.some((r) => r.mode === "120000" || r.type === "commit")) {
        needsCheckout.push(target);
        continue;
      }
      for (const r of rows) {
        if (r.type === "tree") mkdirSync(join(dir, r.path), { recursive: true });
        else write(r.path, readBlob(cwd, rev, r.path));
      }
    } catch {
      unreadable.push(target); // the base read broke: never absence, never a manufactured match
    }
  }
  return { unreadable, needsCheckout };
}

export function certainStaleProofs(
  criteria: readonly ProofCriterion[],
  cwd: string,
  baseRev: string,
  deps: StaleProofReaders = {},
): StaleProofRow[] {
  const makeDir = deps.makeDir ?? (() => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}proof-base-stale-`)));
  const exec = deps.exec ?? execWhitelistedProof;

  const atHead: { c: ProofCriterion; w: WhitelistedProof }[] = [];
  for (const c of visibleCriteria([...criteria])) {
    const proof = (c.proof ?? "").trim();
    if (c.satisfied_by || c.kind === "guard" || !isDialectGrepProof(proof)) continue;
    const w = parseWhitelistedProof(proof) as WhitelistedProof;
    try {
      if (exec(w, cwd) === "pass") atHead.push({ c, w });
    } catch {
      continue; // deliberate: an exec error is an environment gap, never a finding
    }
  }
  if (atHead.length === 0) return [];

  const dir = makeDir();
  try {
    // W1-T6136: the harness pre-push gate passes the worker worktree being pushed, so every read goes through the leaf.
    const listTree = deps.listTree ?? ((tree: string, rev: string, paths: readonly string[], recursive: boolean) =>
      lsTreeRows(hostWorktreeGit(tree, lsTreeArgv(rev, paths, recursive), LS_TREE_OPTIONS)));
    const tree = materialiseBaseGrepTree(cwd, baseRev, atHead.map(({ w }) => w.args[3]!), dir, { ...deps, listTree });
    // A target only a checkout could answer for is no certain finding either way.
    const unreadablePaths = new Set([...tree.unreadable, ...tree.needsCheckout]);
    return atHead
      .filter(({ w }) => preexistingProofHits(w, exec, dir, unreadablePaths, false))
      .map(({ c }) => ({
        claim: c.claim ?? "",
        proof: (c.proof ?? "").trim(),
        why: `the same grep also matches at the merge base ${baseRev.slice(0, 9)}, so proof-discrimination grades it executed_stale`,
      }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
