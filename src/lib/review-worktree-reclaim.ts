/**
 * src/lib/review-worktree-reclaim.ts — reclaims `review-PR*` worktrees a SIGKILL stranded
 * (W1-T3378).
 *
 * THE DEFECT. `materializeReviewWorktree`'s failure-path cleanup and `withMaterializedWorktree`'s
 * success-path teardown (src/run-task.ts, W1-T233) are both in-process `finally`/`catch` blocks —
 * neither runs when the process is SIGKILLed, and this fleet is hard-killed routinely (launchd
 * KeepAlive restarts, `launchctl kickstart -k`, an operator `pkill`, an OOM). A worktree stranded
 * that way is never revisited by anything: `git worktree prune` only removes a registration whose
 * DIRECTORY is gone, and these directories are very much present.
 *
 * THE FIX IS A LATER, OUT-OF-PROCESS SWEEP, not a better `finally`. {@link
 * sweepStrandedReviewWorktrees} runs once per daemon tick and reclaims any `review-PR*` directory
 * under `worktreesDir(config)` that (a) has aged past a grace window generous enough to protect a
 * genuinely slow live review, AND (b) holds no commit absent from its own remote. Age alone is
 * never sufficient (it cannot tell a stranded worktree from a slow live one) and neither is size —
 * both are refused by design; the unpushed-commit check is the one proof that actually answers
 * "would reclaiming this destroy shipped-nowhere work". An unreadable remote is never a yes.
 *
 * SCOPE IS EXACTLY `review-PR*`. The name pattern is the only filter: `coverage/`, `rmd-*` temp
 * dirs and any hand-cut lane never match it and are never even considered, let alone touched.
 */
import { execFileSync } from "node:child_process";
import { hostWorktreeGit, hostWorktreeGitAsync } from "./worktree-git.js";
import { runStepsSync, runStepsAsync, step, type Steps } from "./git-push.js";
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { systemClock, type Clock } from "./clock.js";
import type { Config } from "./config.js";
import { DEFAULT_WORKTREE_REAP_GRACE_MS, readRunLock, removeRunLock, reviewWorktreeHoldState, worktreesDir, worktreeRemove,
  worktreeRemoveAsync } from "./worker.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { reviewerTreeCutRoot } from "./reviewer-tree-reaper.js";
import { removeUnderReviewerLease } from "./reviewer-worktree-lease.js";
import { readPidNamespace } from "./test-slot.js";
export { holdReviewWorktree, releaseReviewWorktree, reviewWorktreeIsHeld } from "./worker.js";

/** Exactly what `materializeReviewWorktree` mints (src/run-task.ts): `review-PR<n>-<epochMs>`.
 *  Anchored full-match, captured groups for the PR number and the creation instant — the sweep
 *  derives BOTH from the name alone, never from a walk of the tree's own mtimes, because a review
 *  worktree is a read-only checkout that nothing legitimately touches after creation. */
const REVIEW_WORKTREE_NAME = /^review-PR(\d+)-(\d+)$/;

/** W1-T14928: a run's `<run-id>-source` view (src/run-task.ts), cut under `worktreesDir(config)`. */
const RUN_SOURCE_TREE_NAME = /^run-[A-Za-z0-9._-]+-source$/;
/** W1-T14928: reviewer-health's healed tree, as prepareFreshOriginMainTree and perAttemptTreePath name it:
 *  `healed-<x>-<sha12>`, or `healed-<x>-<sha12>-<pid>-<8hex>`, cut in the reviewer tree cut root. */
const HEALED_TREE_NAME = /^healed-[0-9A-Za-z]{1,12}-[0-9a-f]{12}(?:-\d+-[0-9a-f]{8})?$/;

/** Reused rather than a second policy constant: the same "a linked worktree might still be doing
 *  something" grace window {@link DEFAULT_WORKTREE_REAP_GRACE_MS} already protects the general
 *  worktree reaper with (plan/policy.yaml's `worktreeReapGraceMs`, 30 minutes) — comfortably above
 *  an abandoned checkout should remain. Shared worker ownership, not elapsed age, protects slow reviews. Exported so a test
 *  can assert the boundary without hand-duplicating the number. */
export const DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS = DEFAULT_WORKTREE_REAP_GRACE_MS;

/** WHY a candidate was reclaimed or kept — ledgered on every candidate, so a sweep that finds
 *  nothing eligible is distinguishable from one that ran and saw nothing at all (W1-T3378). */
export type ReviewWorktreeSweepReason =
  | "reclaimed"
  /** Younger than the grace window — may be a live review still running; never the sole guard. */
  | "too-young"
  /** HEAD carries a commit this sweep could not find on `origin` — refused, never assumed shipped. */
  | "unpushed-commits"
  /** The remote could not be read at all (network, auth, a vanished ref) — an unanswerable
   *  question is never a yes. */
  | "remote-unreadable"
  /** The candidate's own `.git` pointer, or its HEAD, could not be read or parsed. */
  | "git-unreadable"
  /** Every gate passed but the removal itself failed — best-effort, the pass continues. */
  | "removal-failed"
  /** THIS process materialized it and has not torn it down — a live review, whatever its age. */
  | "live-review"
  /** Shared ownership was unreadable; a missing owner has not been established. */
  | "review-ownership-unknown"
  /** W1-T14928: its admin directory is gone, but the clone still lists it. */
  | "registered"
  /** W1-T14928: its sibling `<tree>.lock` names a live holder. */
  | "lock-held"
  /** W1-T14928: its sibling lock is corrupt, or names a pid this process cannot probe. */
  | "lock-unknown";

export interface ReviewWorktreeSweepOutcome {
  name: string;
  path: string;
  reason: ReviewWorktreeSweepReason;
}

export interface ReviewWorktreeSweepSummary {
  reclaimed: string[];
  kept: ReviewWorktreeSweepOutcome[];
}

export interface ReviewWorktreeSweepOptions {
  /** Directory names directly under `worktreesDir(config)`. Defaults to a real `readdirSync`. */
  listEntries?: (dir: string) => string[];
  isDirectory?: (path: string) => boolean;
  /** Shared clock port. Tests drive "later" without a real 30-minute wait; production uses the
   *  same system implementation every other time-aware module does. */
  clock?: Clock;
  /** Overrides {@link DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS}. */
  graceMs?: number;
  /** The candidate's OWN parent repoDir, resolved from its `.git` gitdir pointer (mirrors
   *  worker.ts's private `resolveWorktreeRepoDir` — duplicated here rather than exported, since
   *  this task's own scope is this module plus daemon.ts). `undefined` = unreadable/unparseable. */
  resolveRepoDir?: (worktreePath: string) => string | undefined;
  /** The worktree's own current HEAD sha. `undefined` = unreadable. */
  readHeadSha?: (worktreePath: string) => string | undefined;
  /** The PR's head sha as `origin` reports it RIGHT NOW (`refs/pull/<n>/head`), read fresh, never
   *  cached — a PR that has since advanced is honoured, not assumed stale. `undefined` means the
   *  remote could not be read at all: network failure, auth failure, or the ref is gone. */
  readRemoteHeadSha?: (repoDir: string, prNumber: number) => string | undefined;
  removeWorktree?: (repoDir: string, worktreePath: string) => void;
  /** Whether THIS process is still reviewing in the candidate. Defaults to {@link reviewWorktreeIsHeld}. */
  isLive?: (worktreePath: string) => boolean;
  /** W1-T14928: the clone's registered worktree paths. `undefined` = unreadable. */
  listRegisteredWorktrees?: (repoDir: string) => string[] | undefined;
  /** W1-T14928: removes an unregistered tree, which `git worktree remove` cannot. "leased" = a reviewer holds it. */
  removeUnregisteredTree?: (path: string) => void | "leased";
  /** W1-T14928: other directories healed trees are cut in. Defaults to the reviewer tree cut root. */
  healedTreeRoots?: string[];
  /** W1-T14928: the bytes a tree holds, for the ledger row. */
  measureTreeBytes?: (path: string) => number;
}

/**
 * The review worktrees THIS process materialized and has not yet torn down. Age cannot tell a
 * slow live review from a stranded one, so the grace window alone let the daemon reclaim its OWN
 * live review: on 2026-10-10 PR #10741's review ran its reviewer for 37 minutes, the sweep removed
 * `review-PR10741-1791665021022` at 30.0 minutes from the same pid, and every proof then spawned
 * into a missing cwd (ENOENT, ledgered as "bwrap is not installed"), capping the verdict at 0/3.
 * Cross-process worker claims now protect the same checkout; their existing lifecycle handles stranded owners.
 */
// The existing API above now shares worker.ts's hold with the general sync/async reaper.

/**
 * Reclaim `review-PR*` worktrees under `worktreesDir(config)` that this process did not create and
 * no `finally` is pending for. Called once per daemon tick (src/lib/daemon.ts); see this module's
 * header for the full defect and design.
 */
type AsyncPorted = "readHeadSha" | "readRemoteHeadSha" | "removeWorktree" | "listRegisteredWorktrees" | "removeUnregisteredTree" | "measureTreeBytes";
export type ReviewWorktreeSweepAsyncOptions = Omit<ReviewWorktreeSweepOptions, AsyncPorted> & {
  readHeadSha?: (worktreePath: string) => string | undefined | Promise<string | undefined>;
  readRemoteHeadSha?: (repoDir: string, prNumber: number) => string | undefined | Promise<string | undefined>;
  removeWorktree?: (repoDir: string, worktreePath: string) => void | Promise<void>;
  listRegisteredWorktrees?: (repoDir: string) => string[] | undefined | Promise<string[] | undefined>;
  removeUnregisteredTree?: (path: string) => void | "leased" | Promise<void | "leased">;
  measureTreeBytes?: (path: string) => number | Promise<number>;
};
type ReviewSweepGitPorts = Required<Pick<ReviewWorktreeSweepAsyncOptions, AsyncPorted>>;

export function sweepStrandedReviewWorktrees(config: Config, log: (step: string, extra?: Record<string, unknown>) => void,
  opts: ReviewWorktreeSweepOptions = {}): ReviewWorktreeSweepSummary {
  return runStepsSync(strandedReviewWorktreeSteps(config, log, opts,
    { readHeadSha: defaultReadHeadSha, readRemoteHeadSha: defaultReadRemoteHeadSha, removeWorktree: worktreeRemove,
      listRegisteredWorktrees: defaultListRegisteredWorktrees, removeUnregisteredTree: removeWritableTree,
      measureTreeBytes: treeBytes }, false));
}

export function sweepStrandedReviewWorktreesAsync(config: Config, log: (step: string, extra?: Record<string, unknown>) => void,
  opts: ReviewWorktreeSweepAsyncOptions = {}): Promise<ReviewWorktreeSweepSummary> {
  return runStepsAsync(strandedReviewWorktreeSteps(config, log, opts,
    { readHeadSha: defaultReadHeadShaAsync, readRemoteHeadSha: defaultReadRemoteHeadShaAsync, removeWorktree: worktreeRemoveAsync,
      listRegisteredWorktrees: defaultListRegisteredWorktrees, removeUnregisteredTree: removeWritableTreeAsync,
      measureTreeBytes: treeBytesAsync }, true));
}

function* strandedReviewWorktreeSteps(config: Config, log: (step: string, extra?: Record<string, unknown>) => void,
  opts: ReviewWorktreeSweepAsyncOptions, defaults: ReviewSweepGitPorts, recheckOwnership: boolean): Steps<ReviewWorktreeSweepSummary> {
  const root = worktreesDir(config);
  const listEntries = opts.listEntries ?? ((dir: string) => readdirSync(dir));
  const isDirectory =
    opts.isDirectory ??
    ((p: string) => {
      try {
        return statSync(p).isDirectory();
      } catch (e) {
        // Bind + carry, never a bare erasure: a vanished-mid-loop entry and a genuinely unreadable
        // one both read `false` to the caller, but the reason still reaches the console.
        console.error(`review-worktree-reclaim: could not stat ${p} (${String((e as Error)?.message ?? e)})`);
        return false;
      }
    });
  const clock = opts.clock ?? systemClock;
  const graceMs = opts.graceMs ?? DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS;
  const resolveRepoDir = opts.resolveRepoDir ?? defaultResolveRepoDir;
  const readHeadSha = opts.readHeadSha ?? defaults.readHeadSha;
  const readRemoteHeadSha = opts.readRemoteHeadSha ?? defaults.readRemoteHeadSha;
  const removeWorktree = opts.removeWorktree ?? defaults.removeWorktree;
  const listRegistered = opts.listRegisteredWorktrees ?? defaults.listRegisteredWorktrees;
  const removeTree = opts.removeUnregisteredTree ?? defaults.removeUnregisteredTree;
  const measureBytes = opts.measureTreeBytes ?? defaults.measureTreeBytes;
  const holdState = opts.isLive
    ? (path: string) => opts.isLive!(path) ? "held" : "unheld"
    : reviewWorktreeHoldState;

  const reclaimed: string[] = [];
  const kept: ReviewWorktreeSweepOutcome[] = [];
  const keep = (name: string, path: string, reason: ReviewWorktreeSweepReason, extra: Record<string, unknown> = {}): void => {
    kept.push({ name, path, reason });
    log("review_worktree.sweep.kept", { name, reason, ...extra });
  };

  type Verdict = { kind: "resolvable" } | { kind: "kept"; reason: ReviewWorktreeSweepReason } | { kind: "eligible" };
  // INVARIANT registered-and-young-kept: only a tree whose admin directory is gone, absent from the
  // clone's worktree list, unheld and past the grace is eligible.
  function* unregisteredTreeVerdict(path: string): Steps<Verdict> {
    const pointer = readGitPointer(path);
    if (!pointer || existsSync(pointer.adminDir)) return { kind: "resolvable" };
    if (!existsSync(join(pointer.repoDir, ".git"))) return { kind: "kept", reason: "git-unreadable" };
    const newest = newestMtimeMs(path);
    if (newest === undefined || clock.now() - newest < graceMs) return { kind: "kept", reason: "too-young" };
    const held = holderReason(path);
    if (held !== undefined) return { kind: "kept", reason: held };
    const registered = yield* step(() => listRegistered(pointer.repoDir));
    if (registered === undefined) return { kind: "kept", reason: "git-unreadable" };
    if (registered.some((p) => resolve(p) === resolve(path))) return { kind: "kept", reason: "registered" };
    return { kind: "eligible" };
  }
  // A review hold, then the sibling run lock or reviewer lease: live or unprobeable keeps the tree.
  function holderReason(path: string): ReviewWorktreeSweepReason | undefined {
    const owner = holdState(path);
    if (owner !== "unheld") return owner === "held" ? "live-review" : "review-ownership-unknown";
    const lock = siblingLockState(path);
    return lock === "free" ? undefined : lock === "held" ? "lock-held" : "lock-unknown";
  }
  function* reclaimUnregistered(name: string, path: string): Steps<void> {
    try {
      const bytes = yield* step(() => measureBytes(path));
      const held = holderReason(path); // rechecked immediately before the removal
      if (held !== undefined) { keep(name, path, held); return; }
      if ((yield* step(() => removeTree(path))) === "leased") { keep(name, path, "lock-held"); return; }
      removeRunLock(path);
      reclaimed.push(name);
      log("review_worktree.sweep.reclaimed", { name, path, bytes, kind: "unregistered" });
    } catch (e) {
      keep(name, path, "removal-failed", { error: String((e as Error)?.message ?? e) });
    }
  }

  function* considerRunTree(dir: string, name: string): Steps<void> {
    const path = join(dir, name);
    if (!isDirectory(path)) return;
    const verdict = yield* unregisteredTreeVerdict(path);
    if (verdict.kind === "kept") keep(name, path, verdict.reason);
    else if (verdict.kind === "eligible") yield* reclaimUnregistered(name, path);
  }

  let names: string[];
  try {
    names = listEntries(root);
  } catch {
    return { reclaimed, kept }; // unreadable root — best-effort, matches reapStaleWorktrees
  }

  for (const name of names) {
    const m = REVIEW_WORKTREE_NAME.exec(name);
    if (!m) {
      // W1-T14928: a run tree is considered only once git no longer resolves it; any other name never is.
      if (RUN_SOURCE_TREE_NAME.test(name) || HEALED_TREE_NAME.test(name)) yield* considerRunTree(root, name);
      continue;
    }
    const prNumber = Number(m[1]);
    const createdAtMs = Number(m[2]);
    const path = join(root, name);
    if (!isDirectory(path)) continue;

    if (clock.now() - createdAtMs < graceMs) {
      keep(name, path, "too-young");
      continue;
    }
    const ownership = holdState(path);
    if (ownership !== "unheld") {
      keep(name, path, ownership === "held" ? "live-review" : "review-ownership-unknown");
      continue;
    }

    const repoDir = resolveRepoDir(path);
    if (!repoDir) {
      keep(name, path, "git-unreadable");
      continue;
    }
    const localHead = yield* step(() => readHeadSha(path));
    if (!localHead) {
      const verdict = yield* unregisteredTreeVerdict(path);
      if (verdict.kind === "eligible") yield* reclaimUnregistered(name, path);
      else keep(name, path, "git-unreadable");
      continue;
    }
    const remoteHead = yield* step(() => readRemoteHeadSha(repoDir, prNumber));
    if (remoteHead === undefined) {
      keep(name, path, "remote-unreadable");
      continue;
    }
    if (remoteHead !== localHead) {
      keep(name, path, "unpushed-commits");
      continue;
    }

    // An awaited Git read lets a review acquire ownership in this process.
    if (recheckOwnership) {
      const ownerAfterRead = holdState(path);
      if (ownerAfterRead !== "unheld") {
        keep(name, path, ownerAfterRead === "held" ? "live-review" : "review-ownership-unknown");
        continue;
      }
    }
    try {
      yield* step(() => removeWorktree(repoDir, path));
      reclaimed.push(name);
      log("review_worktree.sweep.reclaimed", { name });
    } catch (e) {
      keep(name, path, "removal-failed", { error: String((e as Error)?.message ?? e) });
    }
  }

  const cutRoots = opts.healedTreeRoots ?? [reviewerTreeCutRoot(installRootDir())];
  for (const dir of new Set(cutRoots.map((r) => resolve(r)))) {
    if (dir === resolve(root)) continue;
    let entries: string[];
    try { entries = listEntries(dir); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`review-worktree-reclaim: could not list ${dir} (${String((e as Error)?.message ?? e)})`);
      continue;
    }
    for (const name of entries) if (HEALED_TREE_NAME.test(name)) yield* considerRunTree(dir, name);
  }

  return { reclaimed, kept };
}

async function defaultReadHeadShaAsync(worktreePath: string): Promise<string | undefined> {
  try { return (await hostWorktreeGitAsync(worktreePath, ["rev-parse", "HEAD"])).trim(); }
  catch (e) {
    console.error(`review-worktree-reclaim: could not read HEAD at ${worktreePath} (${String((e as Error)?.message ?? e)})`);
    return undefined;
  }
}

async function defaultReadRemoteHeadShaAsync(repoDir: string, prNumber: number): Promise<string | undefined> {
  try {
    const out = await hostWorktreeGitAsync(repoDir, ["ls-remote", "origin", `refs/pull/${prNumber}/head`]);
    return out.split(/\s+/)[0]?.trim() || undefined;
  } catch (e) {
    console.error(`review-worktree-reclaim: could not ls-remote origin refs/pull/${prNumber}/head in ${repoDir} (${String((e as Error)?.message ?? e)})`);
    return undefined;
  }
}


/** Resolve a linked worktree's parent repoDir from its OWN `.git` gitdir pointer — the same
 *  technique worker.ts's `resolveWorktreeRepoDir` uses, never a fixed/assumed path (the
 *  multi-checkout lesson: these worktrees register against the OPERATOR checkout, not necessarily
 *  `repos/<repo>`). */
function defaultResolveRepoDir(worktreePath: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(worktreePath, ".git"), "utf8");
  } catch (e) {
    console.error(
      `review-worktree-reclaim: could not read ${join(worktreePath, ".git")} (${String((e as Error)?.message ?? e)})`,
    );
    return undefined;
  }
  const m = raw.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return undefined;
  const marker = `${sep}.git${sep}worktrees${sep}`;
  const idx = m[1].indexOf(marker);
  return idx === -1 ? undefined : m[1].slice(0, idx);
}

function defaultReadHeadSha(worktreePath: string): string | undefined {
  try {
    // W1-T6122: a reviewer ran in this PR-head tree, so the read goes through the leaf.
    return hostWorktreeGit(worktreePath, ["rev-parse", "HEAD"]).trim();
  } catch (e) {
    console.error(`review-worktree-reclaim: could not read HEAD at ${worktreePath} (${String((e as Error)?.message ?? e)})`);
    return undefined;
  }
}

/** `git ls-remote` — a read-only, no-object-transfer question to `origin` about the PR's CURRENT
 *  head, matching the exact ref `materializeReviewWorktree` fetched from (`refs/pull/<n>/head`).
 *  Any failure (network, auth, the ref gone) or an empty answer is `undefined`, never a guess. */
function defaultReadRemoteHeadSha(repoDir: string, prNumber: number): string | undefined {
  let out: string;
  try {
    out = execFileSync("git", ["-C", repoDir, "ls-remote", "origin", `refs/pull/${prNumber}/head`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    console.error(
      `review-worktree-reclaim: could not ls-remote origin refs/pull/${prNumber}/head in ${repoDir} ` +
        `(${String((e as Error)?.message ?? e)})`,
    );
    return undefined;
  }
  const sha = out.split(/\s+/)[0]?.trim();
  return sha ? sha : undefined;
}

/** W1-T14928: a linked tree's `.git` pointer, its admin directory and its clone. `undefined` when `.git` is not
 *  a pointer file naming a `<clone>/.git/worktrees/<id>` directory. */
function readGitPointer(path: string): { adminDir: string; repoDir: string } | undefined {
  let raw: string;
  try {
    if (!lstatSync(join(path, ".git")).isFile()) return undefined;
    raw = readFileSync(join(path, ".git"), "utf8");
  } catch (e) {
    console.error(`review-worktree-reclaim: could not read ${join(path, ".git")} (${String((e as Error)?.message ?? e)})`);
    return undefined;
  }
  const m = raw.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return undefined;
  const adminDir = isAbsolute(m[1]) ? m[1] : resolve(path, m[1]);
  const marker = `${sep}.git${sep}worktrees${sep}`;
  const idx = adminDir.indexOf(marker);
  return idx === -1 ? undefined : { adminDir, repoDir: adminDir.slice(0, idx) };
}

/** The newest of the tree root's and its `.git` pointer's mtimes. `undefined` = unreadable. */
function newestMtimeMs(path: string): number | undefined {
  try {
    return Math.max(statSync(path).mtimeMs, lstatSync(join(path, ".git")).mtimeMs);
  } catch (e) {
    console.error(`review-worktree-reclaim: could not stat ${path} (${String((e as Error)?.message ?? e)})`);
    return undefined;
  }
}

/** The clone's registered worktree paths, read from the admin directories git itself lists them from
 *  (`<clone>/.git/worktrees/<id>/gitdir`), with no git process. `undefined` = unreadable. */
function defaultListRegisteredWorktrees(repoDir: string): string[] | undefined {
  const admin = join(repoDir, ".git", "worktrees");
  let ids: string[];
  try {
    ids = existsSync(admin) ? readdirSync(admin) : [];
  } catch (e) {
    console.error(`review-worktree-reclaim: could not list worktrees of ${repoDir} (${String((e as Error)?.message ?? e)})`);
    return undefined;
  }
  const paths = [repoDir];
  for (const id of ids) {
    try {
      paths.push(dirname(readFileSync(join(admin, id, "gitdir"), "utf8").trim()));
    } catch (e) {
      console.error(`review-worktree-reclaim: could not read ${join(admin, id, "gitdir")} (${String((e as Error)?.message ?? e)})`);
      return undefined;
    }
  }
  return paths;
}

/** Bytes under `path`, symlinks counted as links, never followed. */
function treeBytes(path: string): number {
  const st = lstatSync(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const entry of readdirSync(path)) total += treeBytes(join(path, entry));
  return total;
}

async function treeBytesAsync(path: string): Promise<number> {
  const st = await lstat(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const entry of await readdir(path)) total += await treeBytesAsync(join(path, entry));
  return total;
}

/** This rmd install's own root, derived as src/lib/reviewer-tree-reaper.ts derives it. */
function installRootDir(): string {
  return join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
}

/** W1-T14928: a tree's sibling `<tree>.lock` (a run lock or a reviewer lease). A dead pid frees it only when it was
 *  written in this process's pid namespace, or on this host when it names none; otherwise it cannot be probed. */
function siblingLockState(path: string): "free" | "held" | "unknown" {
  const lock = readRunLock(path);
  if (lock.kind === "absent") return "free";
  if (lock.kind === "corrupt") return "unknown";
  if (defaultIsPidAlive(lock.info.pid)) return "held";
  const own = readPidNamespace();
  const host = (lock.info as { host?: unknown }).host;
  const sameNamespace = lock.info.pidNs !== undefined ? own !== undefined && lock.info.pidNs === own : host === hostname();
  return sameNamespace ? "free" : "unknown";
}

/** Restore owner write and search on every directory under `path`, never following a symlink, so a read-only
 *  tree (a run's `-source` view) can be removed. */
function makeOwnerWritable(path: string): void {
  const st = lstatSync(path);
  if (!st.isDirectory()) return;
  chmodSync(path, (st.mode & 0o7777) | 0o700);
  for (const entry of readdirSync(path)) makeOwnerWritable(join(path, entry));
}

async function makeOwnerWritableAsync(path: string): Promise<void> {
  const st = await lstat(path);
  if (!st.isDirectory()) return;
  await chmod(path, (st.mode & 0o7777) | 0o700);
  for (const entry of await readdir(path)) await makeOwnerWritableAsync(join(path, entry));
}

function removeWritableTree(path: string): void {
  makeOwnerWritable(path);
  rmSync(path, { recursive: true, force: true });
}

/** A healed tree is removed only while this process holds its reviewer lease. */
async function removeWritableTreeAsync(path: string): Promise<void | "leased"> {
  const remove = async (): Promise<void> => { await makeOwnerWritableAsync(path); await rm(path, { recursive: true, force: true }); };
  if (!HEALED_TREE_NAME.test(path.split(sep).pop() ?? "")) return remove();
  return (await removeUnderReviewerLease(path, remove)) === "leased" ? "leased" : undefined;
}
