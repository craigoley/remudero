/**
 * src/lib/reviewer-tree-reaper.ts — removes retired reviewer trees under `<state>/engines/worktrees`
 * (W1-T14148).
 *
 * Every stale-code review cuts `reviewer-<sha12>` (or a per-attempt `reviewer-<sha12>-<pid>-<8hex>`)
 * at the origin/main sha of that moment, and nothing else removes it. Keep rules only: keep the tree
 * at the registering repository's origin/main, keep a leased tree, keep a tree touched within the
 * worktree-reaper grace, and remove the rest under the tree's own lease.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import type { Config } from "./config.js";
import { engineTreesRoot } from "./engine-paths.js";
import { removeUnderReviewerLease } from "./reviewer-worktree-lease.js";
import { DEFAULT_WORKTREE_REAP_GRACE_MS, worktreeRemoveAsync } from "./worker.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";

const REVIEWER_TREE_NAME = /^reviewer-([0-9a-f]{12})(-\d+-[0-9a-f]{8})?$/;

export type ReviewerTreeKeepReason = "unregistered" | "main-unreadable" | "current-main" | "recent-activity"
  | "leased" | "lease-unknown" | "removal-failed";

export interface ReviewerTreeReapSummary {
  root: string;
  removed: { name: string; bytes: number }[];
  bytes_freed: number;
  kept: { name: string; reason: ReviewerTreeKeepReason }[];
}

export interface ReviewerTreeReapOptions {
  listEntries?: (dir: string) => Promise<string[]>;
  /** The registering repository's origin/main sha; `undefined` when it cannot be read. */
  readOriginMain?: (repoDir: string) => Promise<string | undefined>;
  removeWorktree?: (repoDir: string, worktreePath: string) => Promise<void>;
  clock?: Clock;
  graceMs?: number;
}

const QUIET_REASONS: ReadonlySet<ReviewerTreeKeepReason> = new Set(["current-main", "leased", "recent-activity"]);
let inFlight: Promise<ReviewerTreeReapSummary> | undefined;

/** One pass at a time in a process: a second caller gets the pass already running. */
export function reapRetiredReviewerTreesAsync(config: Config, log: (step: string, extra?: Record<string, unknown>) => void,
  opts: ReviewerTreeReapOptions = {}): Promise<ReviewerTreeReapSummary> {
  inFlight ??= reapPass(config, log, opts).finally(() => { inFlight = undefined; });
  return inFlight;
}

async function reapPass(config: Config, log: (step: string, extra?: Record<string, unknown>) => void,
  opts: ReviewerTreeReapOptions): Promise<ReviewerTreeReapSummary> {
  const root = join(engineTreesRoot(join(config.root, "state")), "worktrees");
  const listEntries = opts.listEntries ?? listRootEntries;
  const readOriginMain = opts.readOriginMain ?? defaultReadOriginMain;
  const removeWorktree = opts.removeWorktree ?? worktreeRemoveAsync;
  const clock = opts.clock ?? systemClock;
  const graceMs = opts.graceMs ?? DEFAULT_WORKTREE_REAP_GRACE_MS;
  const summary: ReviewerTreeReapSummary = { root, removed: [], bytes_freed: 0, kept: [] };
  const mains = new Map<string, Promise<string | undefined>>();
  const keep = (name: string, reason: ReviewerTreeKeepReason): void => { summary.kept.push({ name, reason }); };

  for (const name of await listEntries(root)) {
    const match = REVIEWER_TREE_NAME.exec(name);
    if (!match) continue;
    const tree = join(root, name);
    const stat = await readOrUnreadable(() => lstat(tree));
    if ("unreadable" in stat || !stat.isDirectory()) continue;
    const repoDir = await registeringRepo(tree);
    if (repoDir === undefined) { keep(name, "unregistered"); continue; }
    if (!mains.has(repoDir)) mains.set(repoDir, readOriginMain(repoDir));
    const main = await mains.get(repoDir);
    if (main === undefined) { keep(name, "main-unreadable"); continue; }
    if (main.slice(0, 12) === match[1]) { keep(name, "current-main"); continue; }
    if (stat.mtimeMs > clock.now() - graceMs) { keep(name, "recent-activity"); continue; }
    let bytes = 0;
    let removing = false;
    try {
      const outcome = await removeUnderReviewerLease(tree, async () => {
        removing = true;
        bytes = await treeBytes(tree);
        await removeWorktree(repoDir, tree);
      });
      if (outcome === "leased") { keep(name, "leased"); continue; }
      summary.removed.push({ name, bytes });
      summary.bytes_freed += bytes;
    } catch (error) {
      // A throw before the removal began is the lease itself: unknown or corrupt, so the tree stays.
      keep(name, removing ? "removal-failed" : "lease-unknown");
      console.error(`reviewer-tree-reaper: kept ${name} (${String((error as Error)?.message ?? error)})`);
    }
  }
  if (summary.removed.length > 0 || summary.kept.some((k) => !QUIET_REASONS.has(k.reason)))
    log("reviewer_tree.reaped", { ...summary });
  return summary;
}

async function listRootEntries(dir: string): Promise<string[]> {
  try { return await readdir(dir); }
  catch (error) {
    // A missing root is an empty pass; any other unreadable root is reported and skipped, never thrown into the tick.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.error(`reviewer-tree-reaper: could not list ${dir} (${String((error as Error)?.message ?? error)})`);
    return [];
  }
}

/** The repository whose `.git/worktrees/<name>` registers the tree, from the tree's own `.git` pointer. */
async function registeringRepo(tree: string): Promise<string | undefined> {
  const raw = await readOrUnreadable(() => readFile(join(tree, ".git"), "utf8"));
  const pointer = typeof raw === "string" ? raw.match(/^gitdir:\s*(.+?)\s*$/m)?.[1] : undefined;
  if (pointer === undefined) return undefined;
  const gitdir = isAbsolute(pointer) ? pointer : resolve(tree, pointer);
  const stat = await readOrUnreadable(() => lstat(gitdir));
  if ("unreadable" in stat || !stat.isDirectory()) return undefined;
  const common = dirname(dirname(gitdir));
  return basename(common) === ".git" ? dirname(common) : common;
}

/** A read whose failure is a kept shape, not a throw: a tree that cannot be read is never a candidate. */
async function readOrUnreadable<T>(read: () => Promise<T>): Promise<T | { unreadable: string }> {
  try { return await read(); }
  catch (error) { return { unreadable: String((error as Error)?.message ?? error) }; }
}

async function defaultReadOriginMain(repoDir: string): Promise<string | undefined> {
  try {
    const sha = (await hostWorktreeGitAsync(repoDir, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"])).trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
  } catch (error) {
    console.error(`reviewer-tree-reaper: could not read origin/main in ${repoDir} (${String((error as Error)?.message ?? error)})`);
    return undefined;
  }
}

/** Allocated bytes under `dir`, by lstat; a symlink (the node_modules link) counts as itself, never its target. */
async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const stat = await lstat(current);
    total += stat.blocks * 512;
    if (stat.isDirectory()) for (const entry of await readdir(current)) pending.push(join(current, entry));
  }
  return total;
}
