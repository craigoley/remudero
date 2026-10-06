/**
 * lib/object-reaper.ts — reclaim UNREACHABLE git objects from a fleet repository.
 *
 * THE GAP: nothing has ever reclaimed a git OBJECT. A grep for gc/prune/repack across src/ returns
 * only `git worktree prune`, which is worktree-ADMIN cleanup. Measurements, and why the second-order
 * effects matter more than the bytes, are in plan/tasks.d/W1-T3090-*.yaml.
 *
 * TWO INDEPENDENT PROTECTIONS, which is the {@link file://./clone-reaper.ts} discipline — that
 * module records that an age test ALONE destroyed two working trees:
 *   (1) QUIET  — no active registered worktree, no inflight lock, no open handle under `.git`.
 *   (2) EXPIRY — {@link OBJECT_PRUNE_EXPIRY} is ALWAYS passed. Even if (1) were wrong, an object a
 *                live worker created inside the window is ineligible.
 *
 * OPERATOR RULING 2026-10-06 ("prune on expiry alone"): the armed reaper refused 58 ticks in a row
 * while two stores held 51,865 and 141,536 loose objects, because a working fleet always has a
 * worktree or an inflight lock. Those two quiet arms NO LONGER REFUSE BY THEMSELVES: the prune runs
 * and its decision row says the EXPIRY barrier carried it ({@link ObjectReapDecision}). The
 * open-handle arm STILL refuses, and an unreadable handle count still reads as held. Expiry is
 * never optional, so (2) is now the protection the clone-reaper discipline asks to be independent:
 * an age test is safe here where it was not there because prune only removes objects NO ref, index
 * or reflog reaches — a whole working tree was never in that set.
 *
 * PRUNE ONLY, NEVER `gc`: gc repacks and can rewrite refs and reflogs, and the finding is about
 * UNREACHABLE objects, which prune alone removes. Never `git worktree prune` either.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { type Clock, systemClock } from "./clock.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { isHolderStale, readFileIfExists } from "./fs-race-safe.js";

/** How old an unreachable object must be before it is eligible. The SECOND of the two barriers:
 *  it is what makes a wrong quiet verdict survivable, so it is never omitted and never zero. */
export const OBJECT_PRUNE_EXPIRY = "24.hours.ago";

/** Below this many loose objects the reap is not worth a subprocess. Reported, not silent. */
export const LOOSE_OBJECT_FLOOR = 5000;

const UNREADABLE_WORKTREE = "<unreadable>";

export interface ObjectReapDeps {
  /** Registered worktrees for the repo. Non-empty means the expiry, not quiet, carries the prune. */
  listWorktrees?: (repoDir: string) => readonly string[];
  /** Inflight lock files. Non-empty means the expiry, not quiet, carries the prune. */
  listInflightLocks?: () => readonly string[];
  /** Open-handle count under `.git`. Non-zero REFUSES; unreadable must return >0 (fail closed). */
  openFileCount?: (dir: string) => number;
  /** W1-T5119: the CALLING run's own inflight lock file name; it is not another worker, so it never refuses. */
  ownInflightLock?: string;
  /** W1-T5119: whether a lock file names a live holder. Absent counts every lock (the strict default). */
  isInflightLockActive?: (lockFile: string) => boolean;
  /** W1-T5119: whether a registered worktree has a live worker. Absent counts every worktree (the strict default). */
  isWorktreeActive?: (worktreePath: string) => boolean;
  /** Loose object count. */
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
  /** Objects removed, or 0 when refused OR surveying. */
  pruned: number;
  /** SURVEY ONLY: what a prune would have removed. Undefined on an armed pass. An estimate. */
  wouldPrune?: number;
  /** Present iff nothing was pruned. Names the cause in the operator's own vocabulary. */
  refusedBecause?: string;
  looseBefore: number;
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
}

/** Registered worktrees, excluding the main one. `git worktree list --porcelain` emits a
 *  `worktree <path>` line per entry; the FIRST is the repo itself and is never a reason to refuse. */
export function defaultListWorktrees(repoDir: string): readonly string[] {
  try {
    const out = execFileSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const paths = out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length).trim());
    return paths.slice(1);
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
    const out = execFileSync("git", ["-C", repoDir, "count-objects", "-v"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /^count: (\d+)$/m.exec(out);
    return m ? Number(m[1]) : 0;
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
export function objectReapDecision(repoDir: string, inflightDir: string, deps: ObjectReapDeps = {}): ObjectReapDecision {
  const refusedBecause = openHandleRefusal(repoDir, deps);
  if (refusedBecause !== undefined) return { refusedBecause };
  const shortfall = quietShortfall(repoDir, inflightDir, deps);
  return shortfall === undefined ? { carriedBy: "quiet" } : { carriedBy: "expiry", quietShortfall: shortfall };
}

/** A maintenance leftover younger than this is presumed to belong to a live git command. A gc
 *  takes seconds to minutes; the stranding leftovers measured 2026-10-06 were four weeks old. */
export const STALE_MAINTENANCE_LOCK_AGE_MS = 60 * 60_000;

/** Leftovers under a repo's git dir whose presence blocks git's own maintenance. A minimal subset
 *  of PR #9555's `GIT_MAINTENANCE_LEFTOVERS` (unmerged when this landed): ref and index locks are
 *  not maintenance and are never touched here. `gc.log` is handled by the reap itself. */
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
    return out.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    // A survey that cannot measure reports nothing. Reporting nothing is never mistaken for
    // authorising something: this value is ledgered, never compared against a threshold.
    return 0;
  }
}

/**
 * Reclaim unreachable objects, or refuse with a named cause.
 *
 * ORDER IS LOAD-BEARING: `.git/gc.log` is removed ONLY on a pass that is about to prune. Removing
 * it on a refused pass would re-arm git's UNSUPERVISED automatic cleanup, which is precisely what
 * the operator's standing rule exists to prevent — the opposite of this function's purpose.
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
    return { pruned: 0, looseBefore, refusedBecause: `only ${looseBefore} loose object(s), below the ${LOOSE_OBJECT_FLOOR} floor` };
  }
  const first = objectReapDecision(repoDir, inflightDir, deps);
  if (first.refusedBecause !== undefined) return withStreak(deps, true, { pruned: 0, looseBefore, refusedBecause: first.refusedBecause });

  // SURVEY: past every refusal above, so the disposition reported is the decision the armed path
  // would have made. Returns BEFORE gc.log is touched and before anything is spawned or removed.
  if (deps.dryRun === true) {
    const count = deps.countPrunable ?? defaultCountPrunable;
    return withStreak(deps, false, {
      pruned: 0,
      wouldPrune: count(repoDir, ["prune", "-n", `--expire=${OBJECT_PRUNE_EXPIRY}`]),
      looseBefore,
      ...barrierFields(first),
    });
  }

  // THE SECOND END OF THE QUIESCED WINDOW. Checked BEFORE gc.log is touched: a refusal here must
  // leave the auto-gc suppressor exactly where the first refusal above would have left it.
  const second = objectReapDecision(repoDir, inflightDir, deps);
  if (second.refusedBecause !== undefined) {
    return withStreak(deps, true, {
      pruned: 0,
      looseBefore,
      refusedBecause: `quiesced window closed before the prune: ${second.refusedBecause}`,
    });
  }

  const locks = reclaimStaleMaintenanceLocks(join(repoDir, ".git"), deps);
  // Only now, with the prune committed to, does the auto-gc suppressor come off.
  try {
    rmSync(join(repoDir, ".git", "gc.log"), { force: true });
  } catch {
    // best-effort: a gc.log we cannot remove costs a warning, never the prune
  }
  const run = deps.runPrune ?? ((dir, args) => {
    execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "ignore", "ignore"] });
  });
  run(repoDir, ["prune", `--expire=${OBJECT_PRUNE_EXPIRY}`]);
  const looseAfter = (deps.looseObjectCount ?? defaultLooseObjectCount)(repoDir);
  return withStreak(deps, false, { pruned: Math.max(0, looseBefore - looseAfter), looseBefore, ...barrierFields(second), locks });
}

function barrierFields(d: ObjectReapDecision): Pick<ObjectReapResult, "carriedBy" | "quietShortfall"> {
  return { carriedBy: d.carriedBy, ...(d.quietShortfall !== undefined ? { quietShortfall: d.quietShortfall } : {}) };
}
