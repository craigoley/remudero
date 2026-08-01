import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { defaultIsPidAlive } from "./drain-lock.js";

/**
 * ATOMIC RESERVATION of a minted task id — the half `mintNextTaskIdWithHistory` does not do.
 *
 * THE DEFECT. The mint is a SNAPSHOT taken before a worker runs (lib/triage.ts's ID SELECTION
 * block): the max across `plan/tasks.yaml`, every `plan/tasks.d/*.yaml` shard, the ids OPEN plan
 * PRs have minted, and — since #1051 — every id ever declared in the git history of `plan/`.
 * All four are correct. NONE of them reserves anything, so two callers that mint before either
 * pushes derive the SAME id.
 *
 * WHY THAT GOT WORSE, NOT BETTER. Before #1060 both proposals appended to the `plan/tasks.yaml`
 * monolith and collided textually at EOF: ugly, but LOUD, PRE-MERGE and unmergeable. Since #1060
 * each writes its own `plan/tasks.d/<id>-<slug>.yaml`, the slugs differ, git merges both branches
 * CLEANLY, and `loadPlan` (lib/plan.ts) then throws `duplicate task id` ON MAIN — breaking every
 * plan-loading check for everyone. Sharding traded a conflict you cannot merge for a merge that
 * poisons the plan.
 *
 * WHAT THIS IS NOT. It does NOT change what the mint COMPUTES. The four sources and their
 * precedence were fixed twice this week and are untouched: a caller mints exactly as before, then
 * reserves the result. Reservation composes ON TOP of derivation — {@link reserveTaskIdFrom} takes
 * the mint's answer as its STARTING point and only ever moves UPWARD, past ids a live holder
 * already claimed.
 *
 * WHY A DIRECTORY OF FILES, AND NOT THE HISTORY CACHE. The mint's history cache lives in the
 * shared git-common-dir so every worktree shares one copy, and it tolerates a torn write by
 * DISCARDING unparseable content and rescanning — safe there because a lost cache costs one rescan,
 * never a wrong id. A reservation cannot be built on discard-and-continue: discarding a reservation
 * IS the collision. So reservations live under `<root>/state/` beside `triage.lock` and
 * `last-auto-triage.json`, one file per id, and their atomicity comes from `O_EXCL` — not from
 * validate-then-trust. Nothing here reads or writes the git-common-dir.
 */
export function taskIdReservationsDir(root: string): string {
  return join(root, "state", "task-id-reservations");
}

/** One reserved id's on-disk record. `purpose` is for the OPERATOR reading `cat` output — it is
 *  never parsed or matched on, so adding a caller never invalidates an existing reservation. */
export interface TaskIdReservationInfo {
  id: number;
  pid: number;
  host: string;
  startedAt: string;
  purpose: string;
}

/** Path of one id's reservation file. Zero-padded so `ls` sorts numerically for the operator. */
export function taskIdReservationPath(dir: string, id: number): string {
  return join(dir, `W1-T${String(id).padStart(5, "0")}.json`);
}

/** A reservation file's contents, or `null` when missing, unreadable, or garbage. Mirrors
 *  {@link "./drain-lock.js".readDrainLock} exactly: an unparseable holder is NO holder, so a
 *  half-written file can never wedge an id shut. */
export function readTaskIdReservation(path: string): TaskIdReservationInfo | null {
  try {
    const o = JSON.parse(readFileSync(path, "utf8"));
    if (typeof o?.pid === "number" && typeof o?.id === "number") return o as TaskIdReservationInfo;
    return null;
  } catch {
    return null;
  }
}

/**
 * Raised when a reservation cannot be taken for a reason that is NOT contention — an unwritable
 * state directory, a full disk, a permissions fault.
 *
 * LOUD ON PURPOSE (the paid-worker trap). `triageCommandLocked` reserves BEFORE it spawns, and a
 * triage spawn costs real money (median $0.96, measured over 23 runs). A minter that cannot
 * reserve must REFUSE rather than spend — a silent fallback to the unreserved id would spend the
 * money AND then collide, which is strictly worse than not running.
 */
export class TaskIdReservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskIdReservationError";
  }
}

/** Every id currently reserved by a LIVE holder, ascending. A reservation whose pid is dead — or
 *  whose file is garbage — is NOT reported: it is reclaimable, and treating it as held is exactly
 *  the "phantom id" failure this module must not create. */
export function liveReservedIds(dir: string, opts: { isPidAlive?: (pid: number) => boolean } = {}): number[] {
  const isAlive = opts.isPidAlive ?? defaultIsPidAlive;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // no directory yet ⇒ nothing reserved
  }
  const out: number[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const held = readTaskIdReservation(join(dir, name));
    if (held && isAlive(held.pid)) out.push(held.id);
  }
  return out.sort((a, b) => a - b);
}

/** A live reservation handle. `release()` is idempotent so a `finally` and a signal handler can
 *  both call it — the same contract {@link "./drain-lock.js".DrainLockHandle} offers. */
export interface TaskIdReservationHandle {
  readonly id: number;
  readonly path: string;
  readonly info: TaskIdReservationInfo;
  release(): void;
}

export interface ReserveTaskIdOpts {
  /** Injectable liveness probe (tests). Defaults to {@link "./drain-lock.js".defaultIsPidAlive}. */
  isPidAlive?: (pid: number) => boolean;
  /** Override the recorded holder identity (tests). */
  info?: Partial<Pick<TaskIdReservationInfo, "pid" | "host" | "startedAt" | "purpose">>;
  /** How far above `startId` to search before giving up. Guards against an unbounded loop if the
   *  directory somehow fills with live reservations; 1000 is far above any real fleet's in-flight
   *  count (the plan holds ~313 tasks TOTAL after three weeks). */
  maxScan?: number;
}

/**
 * Reserve the first id at or above `startId` that no LIVE holder has claimed, and return a handle.
 *
 * CONTENTION ADVANCES, IT DOES NOT REFUSE — this is the whole point. Two callers that mint the
 * same id both arrive here with the same `startId`; `O_EXCL` lets exactly one create the file, and
 * the loser moves to `startId + 1` and wins that. Both get an id, neither collides, and no caller
 * has to wait. Refusing on contention would merely convert a plan-poisoning collision into a
 * stalled queue.
 *
 * A DEAD HOLDER IS RECLAIMED, NEVER BURNED (the phantom-id trap). This repo already has four ids
 * that were filed and folded away (W1-T199, W1-T224, W1-T247, W1-T263); a reservation that
 * outlived its process would be a FIFTH mechanism for holes in the id space. So a file whose pid
 * is dead — or whose contents are garbage — is unlinked and the SAME id retried, exactly as
 * `acquireDrainLock` reclaims a stale lock. Reclamation is LAZY, at acquire time: no background
 * reaper exists or is needed, and a crashed minter's id returns to the pool the moment anyone next
 * looks at it.
 */
export function reserveTaskIdFrom(startId: number, dir: string, opts: ReserveTaskIdOpts = {}): TaskIdReservationHandle {
  const isAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const maxScan = opts.maxScan ?? 1000;
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new TaskIdReservationError(`cannot create the task-id reservation directory ${dir}: ${String(e)}`);
  }

  for (let id = startId; id < startId + maxScan; ) {
    const path = taskIdReservationPath(dir, id);
    const info: TaskIdReservationInfo = {
      id,
      pid: opts.info?.pid ?? process.pid,
      host: opts.info?.host ?? hostname(),
      startedAt: opts.info?.startedAt ?? new Date().toISOString(),
      purpose: opts.info?.purpose ?? "task-id reservation",
    };
    try {
      const fd = openSync(path, "wx"); // create-or-fail: no TOCTOU gap between check and claim
      writeSync(fd, JSON.stringify(info, null, 2));
      closeSync(fd);
      let released = false;
      return {
        id,
        path,
        info,
        release() {
          if (released) return;
          released = true;
          try {
            unlinkSync(path);
          } catch {
            // already gone — idempotent
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        // NOT contention — an unwritable dir, a full disk. Loud, so a paid caller never spends.
        throw new TaskIdReservationError(`cannot reserve task id W1-T${id} at ${path}: ${String(e)}`);
      }
      const held = readTaskIdReservation(path);
      if (held && isAlive(held.pid)) {
        id++; // a LIVE holder owns this id — advance
        continue;
      }
      try {
        unlinkSync(path); // stale (dead pid / garbage) → reclaim and retry the SAME id
      } catch {
        // someone else cleared it first; retrying the same id is still correct
      }
    }
  }
  throw new TaskIdReservationError(
    `no free task id in W1-T${startId}..W1-T${startId + maxScan - 1} — ${dir} holds ${maxScan} live reservations`,
  );
}

/**
 * The first id at or above `startId` that no LIVE holder has claimed — WITHOUT reserving it.
 *
 * For advisory readers (`rmd next-task-id`) which must SEE reservations but must not take one: an
 * operator asking "what id is next" thousands of times must not burn thousands of ids, and a
 * reservation held by a process that exits microseconds later reserves nothing anyway. Reporting
 * a number and claiming it are different acts, and only the caller that will actually FILE should
 * claim.
 */
export function firstUnreservedAtOrAbove(
  startId: number,
  dir: string,
  opts: { isPidAlive?: (pid: number) => boolean } = {},
): number {
  if (!existsSync(dir)) return startId;
  const held = new Set(liveReservedIds(dir, opts));
  let id = startId;
  while (held.has(id)) id++;
  return id;
}

/** A contiguous-in-intent set of reserved ids, released as a unit. */
export interface TaskIdReservationBlock {
  /** The reserved ids, ascending. Not necessarily contiguous — contention advances past a holder. */
  readonly ids: number[];
  /** The handles, in the same order as {@link ids}. */
  readonly handles: TaskIdReservationHandle[];
  /** Release EVERY handle. Idempotent, and never throws — a release failure must not mask the
   *  caller's own error. */
  releaseAll(): void;
}

/**
 * Reserve `count` ids at or above `startId`, as a block.
 *
 * WHY A BLOCK EXISTS AT ALL. `rmd plan --mode=create` and `--mode=expand` both file "one or more"
 * tasks, and the count is not knowable until the worker has run — but the ids must be reserved
 * BEFORE it spawns, or the reservation guarantees nothing. Reserving a bounded block up front and
 * releasing the whole of it afterwards is the only ordering that both spends nothing on a collision
 * and leaves no id stranded.
 *
 * THIS ALSO CLOSES A GAP #1075 LEFT IN TRIAGE, which is worth stating plainly: triage reserves ONE
 * id and then tells its worker "if you need more, number them upward" (lib/triage.ts) — so a triage
 * run filing two tasks has its SECOND id unreserved, and that id is exactly what a concurrent plan
 * run would take. A block is what makes "more than one" safe for either lane.
 *
 * EVERY ID IS RELEASED, INCLUDING THE ONES NOBODY USES — the phantom-id trap. The four ids this repo
 * has already lost (W1-T199, W1-T224, W1-T247, W1-T263) were lost by being filed and folded away; a
 * block that reserved five and released one would be a fifth way to punch holes in the id space.
 * {@link TaskIdReservationBlock.releaseAll} is called from the caller's `finally`, so the used and
 * the unused are freed on exactly the same path, and a partial failure mid-acquire releases what it
 * already took before rethrowing.
 */
export function reserveTaskIdBlock(
  startId: number,
  count: number,
  dir: string,
  opts: ReserveTaskIdOpts = {},
): TaskIdReservationBlock {
  if (!Number.isInteger(count) || count < 1) {
    throw new TypeError(`reserveTaskIdBlock: count must be a positive integer, got ${String(count)}`);
  }
  const handles: TaskIdReservationHandle[] = [];
  const releaseAll = (): void => {
    for (const h of handles) {
      try {
        h.release();
      } catch {
        /* a release failure must never mask the caller's own error, nor stop the other releases */
      }
    }
  };
  try {
    let next = startId;
    for (let i = 0; i < count; i++) {
      const h = reserveTaskIdFrom(next, dir, opts);
      handles.push(h);
      next = h.id + 1; // ask ABOVE the one just taken, so a block never reserves the same id twice
    }
  } catch (err) {
    // PARTIAL ACQUIRE MUST NOT STRAND. Whatever was taken before the failure is released here, so
    // the only paths out of this function are "all of them held" or "none of them held".
    releaseAll();
    throw err;
  }
  return { ids: handles.map((h) => h.id), handles, releaseAll };
}
