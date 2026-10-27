/** Repository maintenance cadence; legacy reaper exports are unreachable from production dispatch. */
import { execFileSync, spawn } from "node:child_process";
import { boundChildByLoopTime } from "./loop-bounded-child.js";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { OpenFileProbe } from "./clone-reaper.js";
import { type Clock, clockFromMillisFn, systemClock } from "./clock.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { isHolderStale, readFileIfExists } from "./fs-race-safe.js";
import { RMD_TMP_PREFIX } from "./tmp.js";

/** How old an unreachable object must be before it is eligible. The SECOND of the two barriers:
 *  it is what makes a wrong quiet verdict survivable, so it is never omitted and never zero. */
export const OBJECT_PRUNE_EXPIRY = "24.hours.ago";

/** Below this many loose objects the reap is not worth a subprocess. Reported, not silent. */
export const LOOSE_OBJECT_FLOOR = 5000;

const UNREADABLE_WORKTREE = "<unreadable>";

/** An awaited loose-object count that could not be read. Never 0: 0 is a reading, this is not. */
export const UNKNOWN_COUNT = "unknown" as const;
export type LooseCount = number | typeof UNKNOWN_COUNT;

/** BACKSTOP on the awaited prune (and its `-n` survey, the same walk). MEASURED 2026-10-06: one armed
 *  prune held the daemon loop 161 s on a store of ~141k loose objects; prune time grows with the store,
 *  so this sits near 4x that. Past it the prune is killed and the decision row says `timed_out`. */
export const OBJECT_PRUNE_TIMEOUT_MS = 600_000;

/** BACKSTOP on the awaited read probes (`worktree list`, `count-objects`): seconds even on that store. */
export const OBJECT_PROBE_TIMEOUT_MS = 120_000;

/** The argv every reaper git call runs, shared by the sync and the awaited paths so they cannot drift. */
const WORKTREE_LIST_ARGS = ["worktree", "list", "--porcelain"] as const;
const COUNT_OBJECTS_ARGS = ["count-objects", "-v"] as const;
const PRUNE_ARGS = ["prune", `--expire=${OBJECT_PRUNE_EXPIRY}`] as const;
const SURVEY_ARGS = ["prune", "-n", `--expire=${OBJECT_PRUNE_EXPIRY}`] as const;

/** `worktree <path>` lines; the FIRST is the repo itself and is never a reason to refuse. */
function worktreesFromPorcelain(out: string): string[] {
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim())
    .slice(1);
}

function looseCountFrom(out: string): number {
  const m = /^count: (\d+)$/m.exec(out);
  return m ? Number(m[1]) : 0;
}

function nonEmptyLines(out: string): number {
  return out.split("\n").filter((l) => l.trim().length > 0).length;
}

export interface ObjectReapDeps {
  /** Registered worktrees for the repo. Non-empty means the expiry, not quiet, carries the prune. */
  listWorktrees?: (repoDir: string) => readonly string[];
  /** Inflight lock files. Non-empty means the expiry, not quiet, carries the prune. */
  listInflightLocks?: () => readonly string[];
  /** Open-handle count under `.git`. Non-zero REFUSES; unreadable must return >0 (fail closed). */
  openFileCount?: (dir: string) => number;
  /** {@link reapGitObjectsAsync} only: the awaited open-handle probe, preferred over openFileCount.
   *  A probe killed at its bound REFUSES, and the decision names it (`handleProbe: "timed_out"`). */
  openFileCountAsync?: (dir: string) => Promise<OpenFileProbe>;
  /** W1-T5119: the CALLING run's own inflight lock file name; it is not another worker, so it never refuses. */
  ownInflightLock?: string;
  /** W1-T5119: whether a lock file names a live holder. Absent counts every lock (the strict default). */
  isInflightLockActive?: (lockFile: string) => boolean;
  /** W1-T5119: whether a registered worktree has a live worker. Absent counts every worktree (the strict default). */
  isWorktreeActive?: (worktreePath: string) => boolean;
  /** Loose object count. {@link reapGitObjectsAsync}'s default answers {@link UNKNOWN_COUNT} when unreadable. */
  looseObjectCount?: (repoDir: string) => number;
  /** Runs the prune. Injected so a test can assert the ARGV, which is where the expiry lives. */
  runPrune?: (repoDir: string, args: readonly string[]) => void;
  /** SURVEY MODE. Every check the armed path runs still runs; nothing is spawned and nothing is
   *  removed. ONE PREDICATE, TWO OUTCOMES — a survey that reached different probes would report a
   *  decision nobody will ever make, which is the whole point of reading dispositions first. */
  dryRun?: boolean;
  /** Counts what a prune WOULD remove, for the survey. An ESTIMATE AT SURVEY TIME: the armed pass
   *  runs later, against a repo that has moved. */
  countPrunable?: (repoDir: string, args: readonly string[]) => number;
  /** W1-T4022: where the CONSECUTIVE REFUSAL streak is persisted (design (iii)). Undefined skips
   *  streak tracking entirely — a test with no interest in it never has to plumb one through, and
   *  the below-the-floor early return (a different condition from "the fleet is busy") never
   *  touches this file at all. Read+written on every call so a permanent block is distinguishable
   *  from a single busy tick across process restarts, not just within one. */
  streakPath?: string;
  /** Injectable clock for the streak's `refusingSinceIso` timestamp and the stale-lock age. */
  clock?: Clock;
  /** Every process on this host, for the stale-lock reclaim. A throw keeps every lock. */
  listProcesses?: () => readonly ProcessEntry[];
  /** This host's name, matched against the one `gc.pid` records. */
  hostname?: () => string;
  /** {@link reapGitObjectsAsync} only: the default prune's bound, {@link OBJECT_PRUNE_TIMEOUT_MS} when absent. */
  pruneTimeoutMs?: number;
  /** Cadence controller adapters share the reaper's clock and composition seam. */
  random?: () => number;
  context?: () => MaintenanceContext;
  survey?: typeof surveyRepositoryMaintenance;
  run?: typeof runMaintenanceGit;
  /** W1-T10750: the earliest start of any instance that could own a leftover in the store; THROWS when unreadable. */
  bootMs?: (gitDir: string) => number;
  /** W1-T10750: the instants of every live consumer of the store, for the gc prune window. THROWS when unreadable. */
  pruneInputs?: PruneInputsFn;
  /** W1-T10750: where an escalated store tells the operator, and where recovery closes it. */
  operator?: MaintenanceOperatorChannel;
}

/** What an awaited prune reports. `timedOutAfterMs` is set iff it was killed at its bound. */
export interface PruneOutcome {
  timedOutAfterMs?: number;
}

/** One `ps` row. */
export interface ProcessEntry {
  pid: number;
  args: string;
}

/** Which barrier let a prune (or a survey's would-prune) through. `quiet`: no active worktree and
 *  no inflight lock either, so both barriers held. `expiry`: the store was busy, and the 24h expiry
 *  alone stands between a live worker and its objects — the 2026-10-06 operator ruling. */
export type ObjectReapBarrier = "quiet" | "expiry";

export interface ObjectReapDecision {
  /** Present iff the reap must not run. Only an open handle under `.git` (or an unreadable count). */
  refusedBecause?: string;
  /** Present iff the reap may run. */
  carriedBy?: ObjectReapBarrier;
  /** The quiet condition that failed, when {@link carriedBy} is `expiry`. */
  quietShortfall?: string;
  /** Awaited decision only: the open-handle probe was killed at its bound, so the refusal is that. */
  handleProbe?: "timed_out";
}

/** Persisted at {@link ObjectReapDeps.streakPath}: how many CONSECUTIVE REFUSALS the quiet
 *  predicate has produced, and since when. A refusal names WHICH condition; this names for HOW
 *  LONG, so "refused once" and "has refused every time for three weeks" stop reading identically. */
export interface RefusalStreak {
  consecutiveRefusals: number;
  /** ISO timestamp the CURRENT streak began, or `null` while it is zero. */
  refusingSinceIso: string | null;
}

export interface ObjectReapResult {
  /** Objects removed, or 0 when refused OR surveying. {@link UNKNOWN_COUNT} when the awaited count
   *  after the prune could not be read: a difference against an unread count is not a figure. */
  pruned: LooseCount;
  /** SURVEY ONLY: what a prune would have removed. Undefined on an armed pass. An estimate. */
  wouldPrune?: number;
  /** Present iff nothing was pruned. Names the cause in the operator's own vocabulary. */
  refusedBecause?: string;
  /** {@link UNKNOWN_COUNT} when the awaited count could not be read; the reap then skips. */
  looseBefore: LooseCount;
  /** Awaited refusal only: the open-handle probe was killed at its bound. */
  handleProbe?: "timed_out";
  /** Present iff {@link ObjectReapDeps.streakPath} was supplied. The updated streak AFTER this
   *  call's own outcome is folded in. */
  consecutiveRefusals?: number;
  refusingSinceIso?: string;
  /** Which barrier carried a prune or survey; absent on a refusal or a below-the-floor skip. */
  carriedBy?: ObjectReapBarrier;
  /** The failing quiet condition when {@link carriedBy} is `expiry`. */
  quietShortfall?: string;
  /** Armed pass only: the stale maintenance locks reclaimed before the prune, and any kept. */
  locks?: StaleLockReclaim;
  /** Awaited armed pass only: the prune was killed at this bound, so `pruned` is a partial count. */
  pruneTimedOutAfterMs?: number;
}

/** Registered worktrees, excluding the main one. `git worktree list --porcelain` emits a
 *  `worktree <path>` line per entry; the FIRST is the repo itself and is never a reason to refuse. */
export function defaultListWorktrees(repoDir: string): readonly string[] {
  try {
    const out = execFileSync("git", ["-C", repoDir, ...WORKTREE_LIST_ARGS], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return worktreesFromPorcelain(out);
  } catch {
    return [UNREADABLE_WORKTREE]; // fail closed — an unreadable list is not an empty one
  }
}

/** `.lock` files under the fleet's inflight dir. Unreadable is NOT empty: it refuses. */
export function defaultListInflightLocks(inflightDir: string): readonly string[] {
  try {
    if (!existsSync(inflightDir)) return [];
    return readdirSync(inflightDir).filter((n) => n.endsWith(".lock"));
  } catch {
    return ["<unreadable>"]; // fail closed
  }
}

/** Loose (unpacked) object count from `git count-objects -v`. Unreadable reads as 0, which only
 *  ever causes a SKIP (below the floor), never a prune — the safe direction for this input. */
export function defaultLooseObjectCount(repoDir: string): number {
  try {
    const out = execFileSync("git", ["-C", repoDir, ...COUNT_OBJECTS_ARGS], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return looseCountFrom(out);
  } catch {
    // Unreadable reads as 0, and 0 is BELOW the floor, so an unreadable count can only ever cause
    // a SKIP — never a prune. That is the safe direction for this input, unlike the probes above,
    // where unreadable must read as "held".
    return 0;
  }
}

/**
 * The full QUIET predicate: the first of its three conditions that fails, or `undefined` when all
 * three read clear. Each arm names its cause in the operator's own vocabulary.
 *
 * SINCE THE 2026-10-06 OPERATOR RULING THIS IS NO LONGER THE GATE. {@link objectReapDecision} is:
 * only the open-handle arm refuses there, and a failing worktree or inflight-lock arm becomes the
 * decision's `quietShortfall` with `carriedBy: "expiry"`. The arms themselves are unchanged.
 */
export function objectReapRefusal(
  repoDir: string,
  inflightDir: string,
  deps: ObjectReapDeps = {},
): string | undefined {
  return quietShortfall(repoDir, inflightDir, deps) ?? openHandleRefusal(repoDir, deps);
}

/** The worktree and inflight-lock arms of the quiet predicate, the two that no longer refuse. */
function quietShortfall(repoDir: string, inflightDir: string, deps: ObjectReapDeps): string | undefined {
  const worktrees = (deps.listWorktrees ?? defaultListWorktrees)(repoDir)
    .filter((w) => w === UNREADABLE_WORKTREE || (deps.isWorktreeActive?.(w) ?? true));
  if (worktrees.length > 0) {
    return `${worktrees.length} worktree(s) registered — a prune racing a worker can remove an object it is about to reference`;
  }
  const locks = (deps.listInflightLocks ?? (() => defaultListInflightLocks(inflightDir)))()
    .filter((lock) => lock !== deps.ownInflightLock && (deps.isInflightLockActive?.(lock) ?? true));
  if (locks.length > 0) {
    return `${locks.length} inflight lock(s) held — the fleet is mid-dispatch`;
  }
  return undefined;
}

/** The arm that STILL refuses. An absent probe reads as held: fail closed. */
function openHandleRefusal(repoDir: string, deps: ObjectReapDeps): string | undefined {
  const open = (deps.openFileCount ?? (() => 1))(join(repoDir, ".git"));
  return open > 0 ? `${open} open handle(s) under .git — a live process holds the object store` : undefined;
}

/**
 * THE DECISION the reap acts on (operator ruling 2026-10-06). An open handle under `.git` refuses;
 * otherwise the reap runs, and the decision names which barrier carried it: `quiet` when the
 * worktree and inflight-lock arms also read clear, `expiry` when only the always-passed
 * {@link OBJECT_PRUNE_EXPIRY} stands between a busy fleet and its objects.
 */
export function objectReapDecision(
  repoDir: string,
  inflightDir: string,
  deps: ObjectReapDeps = {},
): ObjectReapDecision {
  const refusedBecause = openHandleRefusal(repoDir, deps);
  if (refusedBecause !== undefined) return { refusedBecause };
  return carriedDecision(quietShortfall(repoDir, inflightDir, deps));
}

function carriedDecision(shortfall: string | undefined): ObjectReapDecision {
  return shortfall === undefined ? { carriedBy: "quiet" } : { carriedBy: "expiry", quietShortfall: shortfall };
}

/** A maintenance leftover younger than this is presumed to belong to a live git command. A gc
 *  takes seconds to minutes; the stranding leftovers measured 2026-10-06 were four weeks old. */
export const STALE_MAINTENANCE_LOCK_AGE_MS = 60 * 60_000;

/** Leftovers under a repo's git dir whose presence blocks git's own maintenance. A minimal subset
 *  of PR #9555's `GIT_MAINTENANCE_LEFTOVERS` (unmerged when this landed): ref and index locks are
 *  not maintenance and are never touched here. Git alone owns `gc.log`. */
export const MAINTENANCE_LEFTOVERS = ["objects/maintenance.lock", "gc.pid", "gc.log.lock"] as const;

/** A git process that may own a maintenance lock. Matched against a whole `ps` args line. */
const MAINTENANCE_PROCESS = /(^|[\s/])git\s(.*\s)?(gc|maintenance|repack|prune|pack-refs)(\s|$)/;

export interface StaleLockReclaim {
  /** Paths (relative to the git dir) removed. */
  reclaimed: string[];
  /** Stale leftovers deliberately kept, and why. */
  kept?: { paths: string[]; reason: string };
  /** Removals attempted that failed. A failure costs the lock, never the prune. */
  failed?: Array<{ path: string; error: string }>;
}

/** Every process on this host, from `ps`, bounded by a timeout. Throws when unreadable. */
export function defaultListProcesses(): ProcessEntry[] {
  const out = execFileSync("ps", ["-eo", "pid=,args="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10_000,
  });
  return out
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), args: m[2] }));
}

/**
 * Remove maintenance leftovers older than {@link STALE_MAINTENANCE_LOCK_AGE_MS} from `gitDir`.
 * Nothing is removed while a git gc/maintenance/repack/prune process is alive on this host, while
 * `gc.pid` names a live git process on this host, or when the process list cannot be read —
 * "could not look" is not "nobody is there".
 */
export function reclaimStaleMaintenanceLocks(gitDir: string, deps: ObjectReapDeps = {}): StaleLockReclaim {
  const now = (deps.clock ?? systemClock).now();
  const stale = MAINTENANCE_LEFTOVERS.filter((rel) => {
    try {
      return now - statSync(join(gitDir, rel)).mtimeMs >= STALE_MAINTENANCE_LOCK_AGE_MS;
    } catch {
      // absent (the usual case) or unstattable: either way it is not removed, so neither can take a live lock
      return false;
    }
  });
  if (stale.length === 0) return { reclaimed: [] };
  const keep = (reason: string): StaleLockReclaim => ({ reclaimed: [], kept: { paths: [...stale], reason } });
  let processes: readonly ProcessEntry[];
  try {
    processes = (deps.listProcesses ?? defaultListProcesses)();
  } catch (err) {
    // could not look is not "nobody is there": every stale lock is kept, and the reason says why
    return keep(`process list unavailable, so a live gc cannot be ruled out: ${String((err as Error)?.message ?? err)}`);
  }
  const live = processes.find((p) => MAINTENANCE_PROCESS.test(p.args));
  if (live !== undefined) return keep(`live git maintenance process ${live.pid}: ${live.args}`);
  const [pidText = "", owner = ""] = (readFileIfExists(join(gitDir, "gc.pid")) ?? "").trim().split(/\s+/);
  if (owner === (deps.hostname ?? hostname)() && processes.some((p) => p.pid === Number(pidText))) {
    return keep(`gc.pid names live process ${pidText} on this host`);
  }
  const result: StaleLockReclaim = { reclaimed: [] };
  for (const rel of stale) {
    try {
      rmSync(join(gitDir, rel), { force: true });
      result.reclaimed.push(rel);
    } catch (err) {
      (result.failed ??= []).push({ path: rel, error: String((err as Error)?.message ?? err) });
    }
  }
  return result;
}

/** W1-T10750: a git process that could own ANY leftover below — the maintenance verbs, plus the verbs
 *  that write a pack (`fetch`, `index-pack`) or a ref (`update-ref`, `commit`, `reflog`). */
const LEFTOVER_OWNER_PROCESS = /(^|[\s/])git\s(.*\s)?(gc|maintenance|repack|prune|pack-refs|fetch|update-ref|commit|reflog|index-pack|pack-objects)(\s|$)/;

/** Where each mounting instance advertises its start beside a shared store (git ignores the directory). */
export const BOOT_RECEIPT_DIR = "rmd-boot-receipts";

/** One leftover the owner-gone reclaim left in place. `owner: "live"` is PROVEN (a live gc.pid, or a live git
 *  process naming this store), so the lock is a deferral; `"unproven"` is only "could not prove it gone". */
export interface KeptLeftover {
  path: string;
  reason: string;
  owner: "live" | "unproven";
}

export interface LeftoverReclaim {
  reclaimed: string[];
  kept: KeptLeftover[];
  failed: Array<{ path: string; error: string }>;
}

/** The directory git keeps this repo's database in, or undefined when it cannot be named. */
function maintenanceGitDir(repo: string): string | undefined {
  try {
    if (statSync(join(repo, ".git")).isDirectory()) return join(repo, ".git");
  } catch (err) {
    // no `.git` directory: a bare store is its own git dir; anything else unstattable cannot be named, so no leftover is touched
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    if (existsSync(join(repo, "objects"))) return repo;
  }
  return undefined;
}

async function listLockFiles(gitDir: string, rel: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(join(gitDir, rel), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await listLockFiles(gitDir, `${rel}/${entry.name}`, out);
    else if (entry.name.endsWith(".lock")) out.push(`${rel}/${entry.name}`);
  }
}

/** Every leftover that exists: the maintenance set, a crashed repack's `tmp_pack_*`/`tmp_idx_*`, and stale ref and reflog locks. */
async function leftoverCandidates(gitDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const rel of MAINTENANCE_LEFTOVERS) if (existsSync(join(gitDir, rel))) found.push(rel);
  try {
    for (const name of await readdir(join(gitDir, "objects", "pack"))) {
      if (/^tmp_(pack|idx)_/.test(name)) found.push(`objects/pack/${name}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await listLockFiles(gitDir, "refs", found);
  await listLockFiles(gitDir, "logs/refs", found);
  return found;
}

/**
 * W1-T10750: remove the store's leftovers when their owner is PROVABLY gone — never by age. A leftover is
 * removed only when no git process that could own it is alive in this PID namespace, `gc.pid` (when present)
 * names a dead pid here or another host, and its mtime predates {@link ObjectReapDeps.bootMs} (the earliest
 * start of any instance that mounts the store). Anything unreadable KEEPS the leftover and says what.
 * `gc.log` is never touched (W1-T3116 (iv)). Never throws: a failure is carried in the result.
 */
export async function reclaimOwnerGoneLeftovers(repo: string, deps: ObjectReapDeps = {}): Promise<LeftoverReclaim> {
  const result: LeftoverReclaim = { reclaimed: [], kept: [], failed: [] };
  const gitDir = maintenanceGitDir(repo);
  if (gitDir === undefined) return result;
  let candidates: string[];
  try {
    candidates = await leftoverCandidates(gitDir);
  } catch (err) {
    result.failed.push({ path: ".", error: `leftover scan failed: ${String((err as Error)?.message ?? err)}` });
    return result;
  }
  if (candidates.length === 0) return result;
  const keepAll = (reason: string, owner: KeptLeftover["owner"]): LeftoverReclaim => {
    result.kept = candidates.map((path) => ({ path, reason, owner }));
    return result;
  };
  let processes: readonly ProcessEntry[];
  try {
    processes = (deps.listProcesses ?? defaultListProcesses)();
  } catch (err) {
    // could not look is not "nobody is there": every leftover is kept and the kept reason names the failure
    return keepAll(`process list unavailable, so a live owner cannot be ruled out: ${String((err as Error)?.message ?? err)}`, "unproven");
  }
  const [pidText = "", owner = ""] = (readFileIfExists(join(gitDir, "gc.pid")) ?? "").trim().split(/\s+/);
  if (candidates.includes("gc.pid") && !/^\d+$/.test(pidText)) return keepAll("gc.pid is unreadable, so its owner cannot be named", "unproven");
  if (owner === (deps.hostname ?? hostname)() && processes.some((p) => p.pid === Number(pidText))) {
    return keepAll(`gc.pid names live process ${pidText} on this host`, "live");
  }
  const live = processes.find((p) => LEFTOVER_OWNER_PROCESS.test(p.args));
  if (live !== undefined) {
    return keepAll(`live git process ${live.pid}: ${live.args}`, live.args.includes(repo) ? "live" : "unproven");
  }
  let boot: number;
  try {
    if (deps.bootMs === undefined) throw new Error("no boot evidence source supplied");
    boot = deps.bootMs(gitDir);
  } catch (err) {
    // an unprovable start keeps every leftover; the kept reason names what could not be read
    return keepAll(`boot evidence unreadable, so a leftover cannot be shown to predate every instance: ${String((err as Error)?.message ?? err)}`, "unproven");
  }
  for (const rel of candidates) {
    try {
      const { mtimeMs } = await stat(join(gitDir, rel));
      if (!(mtimeMs < boot)) {
        result.kept.push({ path: rel, owner: "unproven",
          reason: `mtime ${isoOf(mtimeMs)} does not predate boot ${isoOf(boot)}` });
        continue;
      }
      await rm(join(gitDir, rel), { force: true });
      result.reclaimed.push(rel);
    } catch (err) {
      result.failed.push({ path: rel, error: String((err as Error)?.message ?? err) });
    }
  }
  return result;
}

let ownBootCache: number | undefined;

/** Linux's USER_HZ: the unit `/proc/<pid>/stat` field 22 counts in, fixed by the kernel ABI. */
const PROC_CLOCK_TICKS_PER_SECOND = 100;

/** This PID namespace's start: PID 1's start tick after the kernel's boot time, both read from /proc (no child process). THROWS when /proc cannot say. */
function ownBootMs(_now: number): number {
  if (ownBootCache === undefined) {
    const stat = readFileSync("/proc/1/stat", "utf8");
    // field 2 (comm) may hold spaces and parentheses, so count fields from the LAST ")"
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTicks = Number(fields[19]); // field 22 overall; fields[0] is field 3
    const btime = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(btime)) throw new Error("PID 1 start time unreadable from /proc");
    ownBootCache = btime * 1000 + (startTicks / PROC_CLOCK_TICKS_PER_SECOND) * 1000;
  }
  return ownBootCache;
}

/** Advertise this instance's start beside the store, so every other instance that mounts it can read it. */
export function writeBootReceipt(gitDir: string, host: string, now: number): void {
  const dir = join(gitDir, BOOT_RECEIPT_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, host), JSON.stringify({ boot: ownBootMs(now) }) + "\n");
}

/** The earliest start among this instance and every OTHER instance whose receipt was refreshed within `freshMs`. THROWS when unreadable. */
export function bootEvidenceFor(gitDir: string, opts: { now: number; host: string; freshMs: number }): number {
  let earliest = ownBootMs(opts.now);
  const dir = join(gitDir, BOOT_RECEIPT_DIR);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const name of names) {
    if (name === opts.host) continue;
    // one open handle: the freshness and the content come from the same file, never a path tested and then reused
    const fd = openSync(join(dir, name), "r");
    let text: string;
    let mtimeMs: number;
    try {
      mtimeMs = fstatSync(fd).mtimeMs;
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
    if (opts.now - mtimeMs > opts.freshMs) continue;
    const boot = Number((JSON.parse(text) as { boot?: unknown }).boot);
    if (!Number.isFinite(boot)) throw new Error(`boot receipt ${name} unreadable`);
    earliest = Math.min(earliest, boot);
  }
  return earliest;
}

/** One live consumer of a store and when it started. */
export interface PruneInput {
  source: string;
  at: number;
}
export type PruneInputsFn = (repo: string) => Promise<readonly PruneInput[]>;

/** The registered worktrees, inflight locks and live `--shared` borrower clones of `repo`, each with its start. THROWS when any is unreadable. */
export function fleetPruneInputs(inflightDir: string, scratchDir: string = tmpdir()): PruneInputsFn {
  const startOf = async (path: string): Promise<number | undefined> => {
    try {
      return (await stat(path)).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  };
  const names = async (dir: string): Promise<string[]> => {
    try {
      return await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  };
  return async (repo) => {
    const gitDir = maintenanceGitDir(repo);
    if (gitDir === undefined) throw new Error(`git dir of ${repo} unreadable`);
    const inputs: PruneInput[] = [];
    for (const name of await names(join(gitDir, "worktrees"))) {
      const at = await startOf(join(gitDir, "worktrees", name, "gitdir"));
      if (at === undefined) throw new Error(`worktree ${name} has no gitdir file`);
      inputs.push({ source: `worktree:${name}`, at });
    }
    for (const name of (await names(inflightDir)).filter((n) => n.endsWith(".lock"))) {
      const at = await startOf(join(inflightDir, name));
      if (at !== undefined) inputs.push({ source: `inflight:${name}`, at });
    }
    // A borrower clone sits at the scratch dir itself (ci-parity's `rmd-stale-red-merge-*`) or one level below it
    // (review's `rmd-review-*/checkout`, synthetic-tasks' `rmd-synthetic-task-*/candidate`), as a work tree or a bare dir.
    const cloneRoots: Array<{ label: string; root: string }> = [];
    for (const name of (await names(scratchDir)).filter((n) => n.startsWith(RMD_TMP_PREFIX))) {
      cloneRoots.push({ label: name, root: join(scratchDir, name) });
      let children: string[] = [];
      try {
        children = await readdir(join(scratchDir, name));
      } catch (err) {
        if (!["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
      }
      for (const child of children) cloneRoots.push({ label: `${name}/${child}`, root: join(scratchDir, name, child) });
    }
    // A clone's own `.git` dir is also a child of its parent root, so the same alternates file is reachable twice: count it once.
    const seen = new Set<string>();
    for (const { label, root } of cloneRoots) {
      for (const alternates of [join(root, ".git", "objects", "info", "alternates"), join(root, "objects", "info", "alternates")]) {
        if (seen.has(alternates)) continue;
        let text: string;
        try {
          text = await readFile(alternates, "utf8");
        } catch (err) {
          if (["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) continue;
          throw err;
        }
        if (!text.split("\n").includes(join(gitDir, "objects"))) continue;
        seen.add(alternates);
        inputs.push({ source: `borrower:${label}`, at: (await stat(alternates)).mtimeMs });
      }
    }
    return inputs;
  };
}

/** An epoch-millisecond instant as ISO-8601, read through the Clock port. */
function isoOf(ms: number): string {
  return clockFromMillisFn(() => ms).iso();
}

/** The `gc.pruneExpire` value for an instant: second resolution, rounded EARLIER so it is never narrower than the evidence. */
export function pruneExpireFor(ms: number): string {
  return isoOf(Math.floor(ms / 1000) * 1000).replace(/\.000Z$/, "Z");
}

/**
 * W1-T5119: the ACTIVE-worker probes the rung hands {@link objectReapRefusal}, so the operator's rule ("no prune while an active
 * worker uses the store") is measured, not approximated by counting files. An inflight lock or a worktree run lock (`<path>.lock`)
 * counts while its holder is live by {@link isHolderStale}; an unreadable lock counts as live (fail closed), a missing run lock
 * does not (a leftover registration with no worker).
 */
export function activeWorkerProbes(
  inflightDir: string,
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): Pick<ObjectReapDeps, "isInflightLockActive" | "isWorktreeActive"> {
  const live = (raw: string | undefined, absentIsLive: boolean): boolean => {
    if (raw === undefined) return absentIsLive;
    let holder: { pid?: unknown; host?: string; startedAt?: string };
    try {
      holder = JSON.parse(raw) as typeof holder;
    } catch {
      return true; // a torn or garbled lock cannot prove its holder dead, so it still refuses the prune
    }
    return typeof holder?.pid !== "number" || !isHolderStale({ ...holder, pid: holder.pid }, { isPidAlive });
  };
  return {
    isInflightLockActive: (lockFile) => live(readFileIfExists(join(inflightDir, lockFile)), true),
    isWorktreeActive: (worktreePath) => live(readFileIfExists(`${worktreePath}.lock`), false),
  };
}

/** Read the streak at `path`. Absent or malformed reads as a fresh, zero streak — a corrupt or
 *  missing state file must never crash the rung; it just loses count, which is recoverable the
 *  next time the predicate refuses. */
export function readRefusalStreak(path: string): RefusalStreak {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RefusalStreak>;
    if (typeof raw.consecutiveRefusals === "number" && Number.isFinite(raw.consecutiveRefusals)) {
      return {
        consecutiveRefusals: raw.consecutiveRefusals,
        refusingSinceIso: typeof raw.refusingSinceIso === "string" ? raw.refusingSinceIso : null,
      };
    }
  } catch {
    // absent, unreadable, or malformed — start a fresh streak rather than throwing out of a rung
  }
  return { consecutiveRefusals: 0, refusingSinceIso: null };
}

/** Best-effort write: a streak file this process cannot write costs an undercount next tick,
 *  never a blocked reap — this is telemetry, not the refusal decision itself. */
export function writeRefusalStreak(path: string, streak: RefusalStreak): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(streak));
  } catch {
    // best-effort — losing the streak file costs an undercount, never blocks the reap
  }
}

/**
 * Fold ONE outcome into the persisted consecutive-refusal streak: `refused` extends it (or starts
 * it, stamping `refusingSinceIso` with `nowIso` the first time), anything else resets it to zero.
 * So a refusal records how long the rung has been refusing: it persists consecutive refusals and
 * the moment the streak began, turning "refused once" and "has refused every tick for three
 * weeks" into two different, readable numbers instead of the same bare fact.
 */
export function recordRefusalStreak(path: string, refused: boolean, nowIso: string): RefusalStreak {
  const prior = readRefusalStreak(path);
  const next: RefusalStreak = refused
    ? { consecutiveRefusals: prior.consecutiveRefusals + 1, refusingSinceIso: prior.refusingSinceIso ?? nowIso }
    : { consecutiveRefusals: 0, refusingSinceIso: null };
  writeRefusalStreak(path, next);
  return next;
}

/** Merge a streak update into a result, if and only if the caller asked for one via
 *  {@link ObjectReapDeps.streakPath} — a caller with no interest in the streak gets back exactly
 *  the shape it always did. */
function withStreak(deps: ObjectReapDeps, refused: boolean, result: ObjectReapResult): ObjectReapResult {
  if (!deps.streakPath) return result;
  const nowIso = (deps.clock ?? systemClock).iso();
  const streak = recordRefusalStreak(deps.streakPath, refused, nowIso);
  return {
    ...result,
    consecutiveRefusals: streak.consecutiveRefusals,
    ...(streak.refusingSinceIso !== null ? { refusingSinceIso: streak.refusingSinceIso } : {}),
  };
}

/** How many objects `git prune -n` would remove. Unreadable reads as 0 — a survey that cannot
 *  measure reports nothing, and reporting nothing is never mistaken for authorising something. */
export function defaultCountPrunable(repoDir: string, args: readonly string[]): number {
  try {
    const out = execFileSync("git", ["-C", repoDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return nonEmptyLines(out);
  } catch {
    // A survey that cannot measure reports nothing. Reporting nothing is never mistaken for
    // authorising something: this value is ledgered, never compared against a threshold.
    return 0;
  }
}

/**
 * Reclaim unreachable objects, or refuse with a named cause.
 *
 * Retained for older direct callers, outside the production dispatch graph. Git alone owns gc.log.
 *
 * THE QUIESCED WINDOW (design (ii), W1-T4022). {@link objectReapDecision} is a single sample at
 * one instant, so it is taken TWICE: once here, once more immediately before the one subprocess
 * that deletes anything. An open handle at EITHER end refuses; the barrier recorded is the one
 * read at the second end, the state at the moment of deletion. Stale maintenance locks are
 * reclaimed between the second check and the prune ({@link reclaimStaleMaintenanceLocks}).
 */
export function reapGitObjects(
  repoDir: string,
  inflightDir: string,
  deps: ObjectReapDeps = {},
): ObjectReapResult {
  const looseBefore = (deps.looseObjectCount ?? defaultLooseObjectCount)(repoDir);
  if (looseBefore < LOOSE_OBJECT_FLOOR) {
    // Below the floor is "not worth a subprocess", a different condition from "the fleet is
    // busy" — it never touches the refusal streak (see recordRefusalStreak's own doc), so a run
    // of small-but-quiet ticks cannot masquerade as a long busy streak, or vice versa.
    return belowFloor(looseBefore);
  }
  const first = objectReapDecision(repoDir, inflightDir, deps);
  if (first.refusedBecause !== undefined) return withStreak(deps, true, { pruned: 0, looseBefore, refusedBecause: first.refusedBecause });

  // SURVEY: past every refusal above, so the disposition reported is the decision the armed path
  // would have made. Returns before anything is spawned or removed.
  if (deps.dryRun === true) {
    const count = deps.countPrunable ?? defaultCountPrunable;
    return withStreak(deps, false, {
      pruned: 0,
      wouldPrune: count(repoDir, [...SURVEY_ARGS]),
      looseBefore,
      ...barrierFields(first),
    });
  }

  // THE SECOND END OF THE QUIESCED WINDOW. A refusal here must
  // leave the auto-gc suppressor exactly where the first refusal above would have left it.
  const second = objectReapDecision(repoDir, inflightDir, deps);
  if (second.refusedBecause !== undefined) {
    return withStreak(deps, true, closedWindow(looseBefore, second.refusedBecause));
  }

  const locks = commitToPrune(repoDir, deps);
  const run = deps.runPrune ?? ((dir, args) => {
    execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "ignore", "ignore"] });
  });
  run(repoDir, [...PRUNE_ARGS]);
  const looseAfter = (deps.looseObjectCount ?? defaultLooseObjectCount)(repoDir);
  return withStreak(deps, false, { pruned: Math.max(0, looseBefore - looseAfter), looseBefore, ...barrierFields(second), locks });
}

function belowFloor(looseBefore: number): ObjectReapResult {
  return { pruned: 0, looseBefore, refusedBecause: `only ${looseBefore} loose object(s), below the ${LOOSE_OBJECT_FLOOR} floor` };
}

function closedWindow(looseBefore: number, refusedBecause: string): ObjectReapResult {
  return { pruned: 0, looseBefore, refusedBecause: closedWindowReason(refusedBecause) };
}

function closedWindowReason(refusedBecause: string): string {
  return `quiesced window closed before the prune: ${refusedBecause}`;
}

/** Retired prune compatibility: preserve Git failure evidence. */
function commitToPrune(repoDir: string, deps: ObjectReapDeps): StaleLockReclaim {
  return reclaimStaleMaintenanceLocks(join(repoDir, ".git"), deps);
}

type BoundedGit = { ok: true; stdout: string } | { ok: false; timedOut: boolean; error: string };

/** One awaited git call, off the event loop: SIGTERM at `timeoutMs`, SIGKILL after the grace. Never rejects. */
function runGitBounded(repoDir: string, args: readonly string[], timeoutMs: number): Promise<BoundedGit> {
  return runMaintenanceGit(repoDir, args, timeoutMs);
}

/** {@link defaultListWorktrees}, awaited. Unreadable or timed out fails closed, as the sync read does. */
export async function defaultListWorktreesAsync(repoDir: string): Promise<readonly string[]> {
  const r = await runGitBounded(repoDir, WORKTREE_LIST_ARGS, OBJECT_PROBE_TIMEOUT_MS);
  return r.ok ? worktreesFromPorcelain(r.stdout) : [UNREADABLE_WORKTREE];
}

/** {@link defaultLooseObjectCount}, awaited. Unreadable or timed out answers {@link UNKNOWN_COUNT},
 *  never 0: a 0 after a prune would credit the prune with every object it was given. */
export async function defaultLooseObjectCountAsync(repoDir: string): Promise<LooseCount> {
  const r = await runGitBounded(repoDir, COUNT_OBJECTS_ARGS, OBJECT_PROBE_TIMEOUT_MS);
  return r.ok ? looseCountFrom(r.stdout) : UNKNOWN_COUNT;
}

/** {@link defaultCountPrunable}, awaited, under the prune's bound (it is the same walk). Unreadable reads 0. */
export async function defaultCountPrunableAsync(repoDir: string, args: readonly string[]): Promise<number> {
  const r = await runGitBounded(repoDir, args, OBJECT_PRUNE_TIMEOUT_MS);
  return r.ok ? nonEmptyLines(r.stdout) : 0;
}

/** The armed prune, awaited. Killed at its bound it resolves `timedOutAfterMs`; any other failure
 *  throws, exactly as the sync prune's `execFileSync` does. */
export async function defaultRunPruneAsync(
  repoDir: string,
  args: readonly string[],
  timeoutMs = OBJECT_PRUNE_TIMEOUT_MS,
): Promise<PruneOutcome> {
  const r = await runGitBounded(repoDir, args, timeoutMs);
  if (r.ok) return {};
  if (r.timedOut) return { timedOutAfterMs: timeoutMs };
  throw new Error(`git ${args.join(" ")} failed: ${r.error}`);
}

/** The awaited decision. The worktree list is read FIRST so the open-handle sample, the one that
 *  refuses, stays the last probe before the prune; the verdict is {@link objectReapDecision}'s. An
 *  awaited handle probe killed at its bound refuses, named: it cannot rule out a live holder. */
async function objectReapDecisionAsync(repoDir: string, inflightDir: string, deps: ObjectReapDeps): Promise<ObjectReapDecision> {
  const worktrees = await (deps.listWorktrees ?? defaultListWorktreesAsync)(repoDir);
  const probe = deps.openFileCountAsync ? await deps.openFileCountAsync(join(repoDir, ".git")) : undefined;
  if (probe !== undefined && "timedOutAfterMs" in probe) {
    const refusedBecause = `open-handle probe timed out after ${probe.timedOutAfterMs} ms — a live holder of .git cannot be ruled out`;
    return { refusedBecause, handleProbe: "timed_out" };
  }
  const openFileCount = probe !== undefined ? () => probe.count : deps.openFileCount;
  return objectReapDecision(repoDir, inflightDir, { ...deps, listWorktrees: () => worktrees, openFileCount });
}

function refused(looseBefore: LooseCount, d: ObjectReapDecision, because = d.refusedBecause): ObjectReapResult {
  return { pruned: 0, looseBefore, refusedBecause: because, ...(d.handleProbe ? { handleProbe: d.handleProbe } : {}) };
}

/**
 * {@link reapGitObjects} OFF THE DAEMON LOOP: the same contract, step for step — floor, decision,
 * survey, second decision, lock reclaim, prune — with every git call awaited and bounded.
 * MEASURED 2026-10-06: the sync prune held the daemon loop 161 s (235 s of lag) during one pass.
 * A prune killed at its bound is NOT a success: the result carries `pruneTimedOutAfterMs`.
 */
export async function reapGitObjectsAsync(
  repoDir: string,
  inflightDir: string,
  deps: ObjectReapDeps = {},
): Promise<ObjectReapResult> {
  const looseCount: (dir: string) => LooseCount | Promise<LooseCount> = deps.looseObjectCount ?? defaultLooseObjectCountAsync;
  const looseBefore = await looseCount(repoDir);
  // An unread count is not "below the floor": it skips, named, and touches no streak (as a skip doesn't).
  if (looseBefore === UNKNOWN_COUNT) {
    return { pruned: 0, looseBefore, refusedBecause: "loose object count unreadable (git count-objects failed or timed out)" };
  }
  if (looseBefore < LOOSE_OBJECT_FLOOR) return belowFloor(looseBefore);
  const first = await objectReapDecisionAsync(repoDir, inflightDir, deps);
  if (first.refusedBecause !== undefined) return withStreak(deps, true, refused(looseBefore, first));
  if (deps.dryRun === true) {
    const wouldPrune = await (deps.countPrunable ?? defaultCountPrunableAsync)(repoDir, [...SURVEY_ARGS]);
    return withStreak(deps, false, { pruned: 0, wouldPrune, looseBefore, ...barrierFields(first) });
  }
  const second = await objectReapDecisionAsync(repoDir, inflightDir, deps);
  if (second.refusedBecause !== undefined) {
    return withStreak(deps, true, refused(looseBefore, second, closedWindowReason(second.refusedBecause)));
  }
  const locks = commitToPrune(repoDir, deps);
  // An injected runPrune (tests) answers no outcome; only the default prune can be killed at its bound.
  let outcome: PruneOutcome = {};
  if (deps.runPrune) await deps.runPrune(repoDir, [...PRUNE_ARGS]);
  else outcome = await defaultRunPruneAsync(repoDir, [...PRUNE_ARGS], deps.pruneTimeoutMs);
  const looseAfter = await looseCount(repoDir);
  const timedOut = outcome.timedOutAfterMs !== undefined ? { pruneTimedOutAfterMs: outcome.timedOutAfterMs } : {};
  // An unread after-count leaves the prune's yield unknown — never `looseBefore - 0`.
  const pruned = looseAfter === UNKNOWN_COUNT ? UNKNOWN_COUNT : Math.max(0, looseBefore - looseAfter);
  return withStreak(deps, false, { pruned, looseBefore, ...barrierFields(second), locks, ...timedOut });
}

function barrierFields(d: ObjectReapDecision): Pick<ObjectReapResult, "carriedBy" | "quietShortfall"> {
  return { carriedBy: d.carriedBy, ...(d.quietShortfall !== undefined ? { quietShortfall: d.quietShortfall } : {}) };
}

export interface MaintenancePolicy {
  intervalMs: number;
  probeIntervalMs: number;
  timeoutMs: number;
  backoffMs: number;
  maxBackoffMs: number;
  maxFailures: number;
  maxActiveLanes: number;
}

export interface MaintenanceContext {
  activeLanes: number;
  disk: "healthy" | "low" | "unknown";
  queueBusy?: boolean;
}

export interface MaintenanceSurvey extends MaintenanceContext {
  readable: boolean;
  looseCount?: number;
  looseBytes?: number;
  gcLog?: string | null;
  error?: string;
}

/** W1-T10750: what the operator is told when a store escalates. */
export interface MaintenanceEscalationNote {
  repo: string;
  leftovers: Array<{ path: string; reason: string }>;
  lastReason: string;
  nextSurveyAt: number;
}

/** W1-T10750: the operator channel an escalated store opens one issue on (keyed by repo) and recovery closes. */
export interface MaintenanceOperatorChannel {
  open(note: MaintenanceEscalationNote): Promise<string>;
  close(repo: string, issueUrl: string | undefined, comment: string): Promise<void>;
}

export interface MaintenanceState {
  /** W1-T10750: when a gc marker was first seen without a gc since; bounds how long quiet admission may starve the full gc. */
  gcLogSince?: number;
  /** W1-T10750: the open operator issue for this store, until the first verified success closes it. */
  operatorIssue?: string;
  nextEligibleAt: number;
  nextSurveyAt: number;
  failures: number;
  escalated: boolean;
  failedGcLog?: string;
  lastOutcome?: string;
  lastSuccess?: number;
  lastFailure?: number;
  lastAttempt?: number;
  lastReason?: string;
}

export function maintenanceArgs(kind: "incremental" | "gc", pruneExpire?: string): string[] {
  // `-c` rides git's own maintenance run, never a raw gc or prune: the expiry is the only thing it changes.
  return [...(kind === "gc" && pruneExpire !== undefined ? ["-c", `gc.pruneExpire=${pruneExpire}`] : []), "maintenance", "run",
    ...(kind === "gc" ? ["--task=gc"] : ["--task=commit-graph", "--task=loose-objects", "--task=incremental-repack"])];
}

function completeMaintenanceSurvey(survey: MaintenanceSurvey): boolean {
  return survey.readable && (survey.gcLog === null || typeof survey.gcLog === "string") &&
    Number.isSafeInteger(survey.looseCount) && Number.isSafeInteger(survey.looseBytes) &&
    (survey.looseCount ?? -1) >= 0 && (survey.looseBytes ?? -1) >= 0 &&
    Number.isSafeInteger(survey.activeLanes) && survey.activeLanes >= 0;
}

export function decideRepositoryMaintenance(
  survey: MaintenanceSurvey, state: MaintenanceState, policy: MaintenancePolicy, now: number,
): { verdict: "healthy" | "incremental-due" | "full-gc-due" | "deferred";
  reason: string; nextEligibleAt: number } {
  const decision = (verdict: ReturnType<typeof decideRepositoryMaintenance>["verdict"], reason: string) =>
    ({ verdict, reason, nextEligibleAt: state.nextEligibleAt });
  if (!completeMaintenanceSurvey(survey)) {
    return decision("deferred", survey.error ?? "incomplete repository survey");
  }
  if (now < state.nextEligibleAt) return decision("healthy", "cadence or failure backoff pending");
  if (survey.disk !== "healthy") return decision("deferred", `disk verdict ${survey.disk}`);
  if (survey.gcLog !== null) {
    if (survey.activeLanes === 0 && !survey.queueBusy) return decision("full-gc-due", "persistent Git failure marker");
    if (survey.activeLanes > policy.maxActiveLanes) return decision("deferred", "full GC requires quiet admission");
    // W1-T10750: a store that is never fully quiet is not starved. The incremental pass runs under its normal
    // load limit, and once the marker has outlived one maintenance interval the full gc is admitted beside the lanes —
    // its prune window never reaches past the oldest live consumer, so it deletes nothing a lane can still name.
    if (now - (state.gcLogSince ?? now) >= policy.intervalMs) return decision("full-gc-due", "quiet admission starved past the maintenance interval");
    return decision("incremental-due", "incremental maintenance beside a persistent Git failure marker");
  }
  if (survey.activeLanes > policy.maxActiveLanes) return decision("deferred", "incremental load limit");
  return decision("incremental-due", "daily incremental maintenance due");
}

export function readMaintenanceState(path: string): MaintenanceState {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { nextEligibleAt: 0, nextSurveyAt: 0, failures: 0, escalated: false };
    }
    throw new Error(`maintenance state unreadable: ${String(error)}`);
  }
  const state = JSON.parse(raw) as MaintenanceState;
  if (![state.nextEligibleAt, state.nextSurveyAt, state.failures].every((n) => Number.isFinite(n) && n >= 0) ||
      !Number.isSafeInteger(state.failures) || typeof state.escalated !== "boolean") throw new Error("maintenance state invalid");
  return state;
}

function saveMaintenanceState(path: string, state: MaintenanceState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}

export type MaintenanceChild = { ok: true; stdout: string } |
  { ok: false; timedOut: boolean; error: string };

/** A private process group bounds Git and its descendants; Git owns the database lock. */
export function runMaintenanceGit(repo: string, args: readonly string[], timeoutMs: number): Promise<MaintenanceChild> {
  return new Promise((resolve) => {
    const grouped = process.platform !== "win32";
    // Git can return zero when another maintainer owns its database lock. Its default
    // pipe mode also hides the warning; retain that diagnostic instead of claiming work.
    const verb = args[0] === "-c" ? 2 : 0;
    const maintenanceRun = args[verb] === "maintenance" && args[verb + 1] === "run";
    const childArgs = maintenanceRun ? [...args, "--no-quiet"] : args;
    const child = spawn("git", ["-C", repo, ...childArgs], { detached: grouped,
      env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let spawnError: string | undefined;
    const signal = (kind: NodeJS.Signals): void => {
      try {
        if (grouped && child.pid !== undefined) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") spawnError = `teardown failed: ${String(error)}`;
      }
    };
    const teardown = () => signal("SIGKILL");
    process.once("exit", teardown);
    child.stdout.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-64 * 1024 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-65536); });
    child.on("error", (error) => { spawnError = error.message; });
    // W1-T9651: the group is signalled at a loop-available budget, so a held loop never stops a finished git.
    const bound = boundChildByLoopTime({ kill: (kind) => (signal(kind as NodeJS.Signals), true) }, timeoutMs, { escalateAfterMs: 1000 });
    child.on("close", (code) => {
      process.removeListener("exit", teardown);
      const timedOut = bound.timedOut;
      bound.cancel();
      if (timedOut) signal("SIGKILL");
      const skipped = maintenanceRun && /^warning: lock file '[^\r\n]+' exists, skipping maintenance\r?$/m.test(stderr);
      resolve(code === 0 && !timedOut && !spawnError && !skipped ? { ok: true, stdout } :
        { ok: false, timedOut, error: spawnError ?? (stderr.trim() || `git exited ${code}`) });
    });
  });
}

export async function surveyRepositoryMaintenance(
  repo: string, activeLanes: number, disk: MaintenanceContext["disk"], timeoutMs: number,
): Promise<MaintenanceSurvey> {
  const context = { activeLanes, disk };
  const common = await runMaintenanceGit(repo, ["rev-parse", "--git-common-dir"], timeoutMs);
  const counts = await runMaintenanceGit(repo, ["count-objects", "-v"], timeoutMs);
  if (!common.ok || !counts.ok) return { ...context, readable: false,
    error: !common.ok ? common.error : (counts as Extract<MaintenanceChild, { ok: false }>).error };
  const count = /^count: (\d+)$/m.exec(counts.stdout);
  const size = /^size: (\d+)$/m.exec(counts.stdout);
  if (!count || !size) return { ...context, readable: false, error: "incomplete count-objects output" };
  let gcLog: string | null;
  try { gcLog = readFileSync(join(resolve(repo, common.stdout.trim()), "gc.log"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ...context, readable: false, error: String(error) };
    gcLog = null;
  }
  return { ...context, readable: true, looseCount: Number(count[1]), looseBytes: Number(size[1]) * 1024, gcLog };
}

const maintenanceInFlight = new Set<string>();

export async function runRepositoryMaintenance(
  repo: string, statePath: string, policy: MaintenancePolicy,
  log: (step: string, fields: Record<string, unknown>) => void,
  deps: Pick<ObjectReapDeps, "clock" | "random" | "survey" | "run" | "listProcesses" | "hostname" | "bootMs" | "pruneInputs" | "operator"> &
    Required<Pick<ObjectReapDeps, "context">>,
): Promise<void> {
  if (maintenanceInFlight.has(repo)) return;
  maintenanceInFlight.add(repo);
  const clock = deps.clock ?? systemClock;
  let state: MaintenanceState | undefined;
  let before: MaintenanceSurvey | undefined;
  let after: MaintenanceSurvey | undefined;
  let kind: "incremental" | "gc" | undefined;
  let leftovers: LeftoverReclaim = { reclaimed: [], kept: [], failed: [] };
  let prune: { expire?: string; inputs: string[] } | undefined;
  let closedIssue: string | undefined;
  let operatorError: string | undefined;
  let receiptError: string | undefined;
  const started = clock.now();
  const emit = (outcome: string, reason: string) => log(`repository_maintenance.${outcome}`, {
    repo, kind: kind ?? "survey", outcome, reason, duration_ms: Math.max(0, clock.now() - started),
    loose_before: before?.looseCount, bytes_before: before?.looseBytes,
    loose_after: after?.looseCount, bytes_after: after?.looseBytes,
    gc_log_before: before?.gcLog === undefined ? "unknown" : before.gcLog === null ? "absent" : "present",
    gc_log_after: after?.gcLog === undefined ? "unknown" : after.gcLog === null ? "absent" : "present",
    active_lanes: before?.activeLanes, next_retry: state && Math.max(state.nextEligibleAt, state.nextSurveyAt),
    last_success: state?.lastSuccess, last_failure: state?.lastFailure,
    retry_pending: state !== undefined && Math.max(state.nextEligibleAt, state.nextSurveyAt) > clock.now(),
    leftovers_reclaimed: leftovers.reclaimed, leftovers_failed: leftovers.failed,
    leftovers_kept: leftovers.kept.map((k) => `${k.path}: ${k.reason}`),
    prune_expire: prune?.expire ?? (prune === undefined ? undefined : "git-default"), prune_inputs: prune?.inputs,
    operator_issue: state?.operatorIssue, operator_issue_closed: closedIssue, operator_error: operatorError, boot_receipt_error: receiptError,
  });
  const jittered = (backoff: number) =>
    Math.min(policy.maxBackoffMs, Math.round(backoff * (1 + (deps.random ?? Math.random)() * 0.2)));
  // W1-T10750: an escalated store tells the operator once and tells them again only when it recovers.
  const settleOperator = async (): Promise<void> => {
    if (!deps.operator || !state) return;
    try {
      if (state.escalated && state.operatorIssue === undefined) {
        state.operatorIssue = await deps.operator.open({ repo, lastReason: state.lastReason ?? "unknown",
          leftovers: leftovers.kept.map((k) => ({ path: k.path, reason: k.reason })),
          nextSurveyAt: Math.max(state.nextEligibleAt, state.nextSurveyAt) });
        saveMaintenanceState(statePath, state);
      } else if (!state.escalated && state.operatorIssue !== undefined) {
        const url = state.operatorIssue;
        await deps.operator.close(repo, url, `Repository maintenance verified for ${repo}. Loose objects ` +
          `${before?.looseCount ?? "unknown"} -> ${after?.looseCount ?? "unknown"}, ` +
          `${before?.looseBytes ?? "unknown"} -> ${after?.looseBytes ?? "unknown"} bytes.`);
        closedIssue = url;
        state.operatorIssue = undefined;
        saveMaintenanceState(statePath, state);
      }
    } catch (error) {
      // an unreachable operator channel never blocks maintenance; the row carries operator_error and the next pass retries
      operatorError = String((error as Error)?.message ?? error);
    }
  };
  const settle = async (outcome: string, reason: string): Promise<void> => {
    await settleOperator();
    emit(outcome, reason);
  };
  try {
    state = readMaintenanceState(statePath);
    // W1-T10750: escalation is the "operator has been told" tier, never a stop; the retry window alone gates a pass.
    if (started < Math.max(state.nextEligibleAt, state.nextSurveyAt)) return;
    if (state.lastOutcome === "running") {
      const wasEscalated = state.escalated;
      state.lastOutcome = "fail";
      state.lastFailure = state.lastAttempt;
      state.lastReason = "daemon stopped during maintenance; retry window preserved";
      state.escalated = state.escalated || state.failures >= policy.maxFailures;
      if (state.escalated && !wasEscalated) {
        // The interrupted attempt was the last allowed one: tell the operator, then wait one backoff step before the re-survey.
        state.nextSurveyAt = started + jittered(policy.backoffMs * 2 ** Math.min(state.failures - 1, 30));
        saveMaintenanceState(statePath, state);
        emit("fail", state.lastReason);
        await settle("escalate", "automatic retry limit reached after interrupted attempt");
        return;
      }
      saveMaintenanceState(statePath, state);
      emit("fail", state.lastReason);
    }
    const context = deps.context();
    const gitDir = maintenanceGitDir(repo);
    const host = (deps.hostname ?? hostname)();
    if (deps.bootMs === undefined && gitDir !== undefined) {
      try { writeBootReceipt(gitDir, host, started); }
      catch (error) { receiptError = String((error as Error)?.message ?? error); /* carried on every row as boot_receipt_error */ }
    }
    leftovers = await reclaimOwnerGoneLeftovers(repo, { clock, listProcesses: deps.listProcesses, hostname: () => host,
      bootMs: deps.bootMs ?? ((dir) => bootEvidenceFor(dir, { now: started, host, freshMs: 2 * policy.intervalMs })) });
    const survey = deps.survey ?? surveyRepositoryMaintenance;
    before = { ...await survey(repo, context.activeLanes, context.disk, Math.min(policy.timeoutMs, 30000)),
      queueBusy: context.queueBusy };
    // Re-read occupancy after asynchronous probes; a newly admitted lane must veto heavy work.
    Object.assign(before, deps.context());
    if (completeMaintenanceSurvey(before)) state.gcLogSince = before.gcLog === null ? undefined : (state.gcLogSince ?? started);
    let decision = decideRepositoryMaintenance(before, state, policy, started);
    // A lock a PROVEN live owner holds is a deferral, never a failure: the run would only be refused by it.
    const held = leftovers.kept.find((k) => k.owner === "live" && !/\/tmp_(pack|idx)_/.test(k.path));
    if (held && (decision.verdict === "incremental-due" || decision.verdict === "full-gc-due")) {
      decision = { ...decision, verdict: "deferred", reason: `${held.path} is held by a live owner: ${held.reason}` };
    }
    if (decision.verdict === "deferred" || decision.verdict === "healthy") {
      state.nextSurveyAt = clock.now() + policy.probeIntervalMs;
      state.lastOutcome = "defer";
      state.lastReason = decision.reason;
      saveMaintenanceState(statePath, state);
      await settle("defer", decision.reason);
      return;
    }
    kind = decision.verdict === "full-gc-due" ? "gc" : "incremental";
    if (kind === "gc" && deps.pruneInputs) {
      // The window never reaches past the oldest live consumer; any unreadable input leaves git's own default.
      try {
        const inputs = await deps.pruneInputs(repo);
        const oldest = inputs.reduce((min, i) => Math.min(min, i.at), Number.POSITIVE_INFINITY);
        prune = { expire: inputs.length === 0 ? undefined : pruneExpireFor(oldest),
          inputs: inputs.map((i) => `${i.source}@${isoOf(i.at)}`) };
      } catch (error) {
        prune = { inputs: [`unreadable: ${String((error as Error)?.message ?? error)}`] };
      }
    }
    state.failedGcLog = before.gcLog ?? undefined;
    // Persist an interrupted attempt's failure and retry window BEFORE spawning the child.
    const priorFailures = state.failures;
    state.failures++;
    state.lastAttempt = clock.now();
    state.lastOutcome = "running";
    const backoff = Math.min(policy.maxBackoffMs, policy.backoffMs * 2 ** Math.min(state.failures - 1, 30));
    state.nextEligibleAt = clock.now() + policy.timeoutMs + jittered(backoff);
    saveMaintenanceState(statePath, state);
    emit("start", decision.reason);
    const result = await (deps.run ?? runMaintenanceGit)(repo, maintenanceArgs(kind, prune?.expire), policy.timeoutMs);
    const postContext = deps.context();
    after = await survey(repo, postContext.activeLanes, postContext.disk, Math.min(policy.timeoutMs, 30000));
    const beside = kind === "incremental" && before.gcLog !== null;
    const verified = result.ok && completeMaintenanceSurvey(after) && (beside || after.gcLog === null);
    if (verified && beside) {
      // An incremental pass beside a gc marker bounds the store but verifies nothing: the full gc is still owed.
      state.failures = priorFailures;
      state.lastOutcome = "complete";
      state.lastSuccess = clock.now();
      state.lastReason = "incremental maintenance verified; full gc still pending behind the Git failure marker";
      state.nextEligibleAt = Math.max(clock.now() + policy.probeIntervalMs,
        Math.min((state.gcLogSince ?? started) + policy.intervalMs, clock.now() + policy.intervalMs));
      saveMaintenanceState(statePath, state);
      await settle("complete", state.lastReason);
    } else if (verified) {
      state = { ...state, failures: 0, escalated: false, lastOutcome: "complete", lastSuccess: clock.now(),
        nextEligibleAt: clock.now() + Math.max(86400000, policy.intervalMs), nextSurveyAt: 0, failedGcLog: undefined,
        gcLogSince: undefined };
      state.lastReason = "Git maintenance verified";
      saveMaintenanceState(statePath, state);
      await settle("complete", state.lastReason);
    } else {
      const wasEscalated = state.escalated;
      state.lastOutcome = "fail";
      state.lastReason = !result.ok ? `${result.timedOut ? "timeout: " : ""}${result.error}` :
        !completeMaintenanceSurvey(after) ? `post-survey unreadable: ${after.error ?? "incomplete state"}` :
          "Git failure marker survives";
      state.lastFailure = clock.now();
      state.nextEligibleAt = clock.now() + jittered(backoff);
      state.escalated = state.escalated || state.failures >= policy.maxFailures;
      // An escalated store is re-surveyed one further backoff step past the failure window, and the step keeps growing.
      if (state.escalated) state.nextSurveyAt = state.nextEligibleAt + jittered(backoff);
      saveMaintenanceState(statePath, state);
      emit("fail", state.lastReason);
      if (state.escalated && !wasEscalated) await settle("escalate", "automatic retry limit reached");
      else await settleOperator();
    }
  } catch (error) {
    // State and adapter failures remain visible, with the interrupted attempt's saved retry window.
    emit("fail", String(error));
  } finally {
    maintenanceInFlight.delete(repo);
  }
}
