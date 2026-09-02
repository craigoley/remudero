import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { defaultIsPidAlive } from "./drain-lock.js";
import { isAllocatableTaskId } from "./task-id.js";

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
 * How a reservation failure is machine-classified, for a caller that must ledger it rather than
 * fold it into a stringified message (design (iv), W1-T949 rationale (6)):
 *   - "unreachable" — a remote read/write failed (network, auth, proxy — {@link classifyPushFailure}'s
 *     default). Recoverable; a retry against a live remote may succeed.
 *   - "exhausted"   — every id in the scanned window was already held (local or remote). Not a
 *     transient fault — the caller's `startId`/`maxScan` window is genuinely full.
 *   - "local"       — a non-contention failure of the LOCAL O_EXCL store itself (unwritable
 *     directory, full disk, a permissions fault) — never names a remote id/ref.
 */
export type ReservationFailureOutcome = "unreachable" | "exhausted" | "local";

/**
 * Raised when a reservation cannot be taken for a reason that is NOT contention — an unwritable
 * state directory, a full disk, a permissions fault, an unreachable remote, or an exhausted scan
 * window.
 *
 * LOUD ON PURPOSE (the paid-worker trap). `triageCommandLocked` reserves BEFORE it spawns, and a
 * triage spawn costs real money (median $0.96, measured over 23 runs). A minter that cannot
 * reserve must REFUSE rather than spend — a silent fallback to the unreserved id would spend the
 * money AND then collide, which is strictly worse than not running.
 *
 * CARRIES STRUCTURE, NOT JUST PROSE (W1-T949 design (iv)). Every throw site in this module that
 * can name the id/ref/outcome it failed on now does, on the error itself — so a caller no longer
 * has to re-parse this class's own message to log something a week-later reader can query. Fields
 * are `undefined` wherever a throw site genuinely has none to give (e.g. an unwritable directory
 * names no single id), never a placeholder string.
 */
export class TaskIdReservationError extends Error {
  /** The single id this failure concerns — the id a remote push was rejected for, or the first
   *  id a range-exhausted scan started from. `undefined` for a local directory failure, which
   *  concerns the store itself, not any one id. */
  readonly taskId?: string;
  /** The remote ref {@link taskId} would have occupied, mirroring it exactly — `undefined`
   *  wherever `taskId` is (an id-exhausted range names no single ref either). */
  readonly ref?: string;
  /** The machine-classified reason — see {@link ReservationFailureOutcome}. */
  readonly outcome?: ReservationFailureOutcome;
  constructor(message: string, info?: { taskId?: string; ref?: string; outcome?: ReservationFailureOutcome }) {
    super(message);
    this.name = "TaskIdReservationError";
    this.taskId = info?.taskId;
    this.ref = info?.ref;
    this.outcome = info?.outcome;
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
    throw new TaskIdReservationError(`cannot create the task-id reservation directory ${dir}: ${String(e)}`, {
      outcome: "local",
    });
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
        throw new TaskIdReservationError(`cannot reserve task id W1-T${id} at ${path}: ${String(e)}`, {
          taskId: `W1-T${id}`,
          outcome: "local",
        });
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
    { outcome: "exhausted" },
  );
}

/** What {@link firstUnreservedAtOrAbove} reports: an id, or `"unknown"` when a store it needed to
 *  consult could not be read. `"unknown"` is a first-class outcome, not an exception — the read is
 *  advisory and must never crash an operator's query, but it must also never fold an unreadable
 *  store into a false "nothing reserved". */
export type FirstUnreservedResult = number | "unknown";

export interface FirstUnreservedOpts {
  isPidAlive?: (pid: number) => boolean;
  /**
   * Reads which ids are held on a store OTHER than `dir` — in production, the remote's
   * `refs/rmd-id/*` namespace (W1-T509), which every writer shares and `dir` (a worker sandbox's
   * local, ephemeral directory) does not. Returns the held ids, or the literal `"unknown"` when
   * that store could not be read.
   *
   * DEFAULTS TO REPORTING NOTHING HELD — today's local-only behaviour, unchanged for every
   * existing caller. The reader is INJECTED, never opened here: this function still performs no
   * I/O beyond `dir`, and a caller that never supplies one gets exactly the read it got before
   * this parameter existed.
   */
  readRemoteHeld?: () => Set<number> | "unknown";
}

/**
 * The first id at or above `startId` that no LIVE holder has claimed — WITHOUT reserving it.
 *
 * For advisory readers (`rmd next-task-id`) which must SEE reservations but must not take one: an
 * operator asking "what id is next" thousands of times must not burn thousands of ids, and a
 * reservation held by a process that exits microseconds later reserves nothing anyway. Reporting
 * a number and claiming it are different acts, and only the caller that will actually FILE should
 * claim.
 *
 * THE FAIL DIRECTION IS NOT SYMMETRIC BETWEEN THE TWO STORES. `dir` missing is a NORMAL state — a
 * fresh worker sandbox that has reserved nothing locally yet — and reads as "nothing held here",
 * exactly as it always has. `readRemoteHeld` reporting `"unknown"` is DIFFERENT: it means a store
 * that may hold something could not be consulted, and folding that into a number would be exactly
 * the defect this function exists to close — reporting an id FREE when the remote already holds
 * it. So `"unknown"` propagates straight through as this function's own result instead of being
 * silently treated as "nothing held there either".
 */
export function firstUnreservedAtOrAbove(startId: number, dir: string, opts: FirstUnreservedOpts = {}): FirstUnreservedResult {
  const remoteHeld = opts.readRemoteHeld ? opts.readRemoteHeld() : new Set<number>();
  if (remoteHeld === "unknown") return "unknown";
  const held = new Set(liveReservedIds(dir, opts));
  for (const id of remoteHeld) held.add(id);
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

// ── REMOTE RESERVATION (W1-T509) — the substrate the design above never had ───
//
// EVERYTHING ABOVE IS RIGHT AND STAYS. `O_EXCL` is a genuine create-if-absent and the
// contention-advances rule is the correct policy. What it lacked was a substrate any OTHER
// writer can see: `taskIdReservationsDir` resolves under `<config.root>/state`, and for a worker
// that is a path inside a bwrap sandbox discarded when the worker exits — not merely local,
// EPHEMERAL BY CONSTRUCTION. Two writers on two hosts never observe each other's files, which is
// why eight id collisions landed in four days and two of them refused `loadPlan` on origin/main.
//
// THE SUBSTRATE EVERY WRITER SHARES IS THE REMOTE'S REF STORE, AND THREE OBVIOUS WAYS TO USE IT
// DO NOT LOCK. All four results below were reproduced against the real remote at c271f298:
//
//   (1) A TAG IS NOT A LOCK. `git push <sha>:refs/tags/X` onto an EXISTING tag holding that SAME
//       sha exits 0 with `Everything up-to-date`. A reservation is exactly that case whenever
//       writers share an anchor commit, so the second writer is told it succeeded. Only a
//       DIFFERING sha is rejected (`the tag already exists in the remote`).
//   (2) `--force-with-lease=<ref>:` (an empty expected value, i.e. "require this ref to be
//       absent") DOES NOT RESCUE IT: against an existing ref holding that sha it also exits 0
//       with `Everything up-to-date`, because git elides the push when local and remote already
//       agree — no ref update is negotiated, so no lease is ever checked. CONTROL: the identical
//       lease against a genuinely absent ref creates it.
//   (3) `git update-ref --stdin` with `create` is LOCAL ONLY. It reports success and the remote
//       never hears about it (measured: local ref 1, remote ref 0).
//
// (4) WHAT DOES WORK IS A PAYLOAD UNIQUE TO THE WRITER. Push an ORPHAN commit — no parents, empty
//     tree — and two writers can never share a sha. The second push is then a non-fast-forward
//     against an unrelated history, which the server refuses STRUCTURALLY rather than by policy:
//     writer A -> `[new reference]` rc=0; writer B on the SAME id -> rc=1 rejected; writer B on a
//     different id -> rc=0. THE CAS IS A PROPERTY OF THE PAYLOAD, NOT OF THE NAMESPACE.
//
// THE NAMESPACE IS `refs/rmd-id/`, AND THAT IS ABOUT CLONE HYGIENE RATHER THAN LOCKING. Measured:
// with probe refs live, a default `git fetch` brought down NONE of them while a probe TAG on the
// same fetch DID — so a tag scheme would put a ref per id in every clone forever. It is also
// outside `reapBranchesCommand`'s view by construction: that command enumerates
// `git ls-remote --heads`, which is `refs/heads/` only, so a reservation can never read as
// undeclared branch drift against `DECLARED_BRANCH_GUARDS`.

/** The ref a reserved id occupies. Suffix-aware by construction: the id is the whole token, so
 *  `W1-T1` and `W1-T1B` are different refs and neither folds onto the other. */
export function taskIdReservationRef(taskId: string): string {
  return `refs/rmd-id/${taskId}`;
}

/** The outcome of one remote reservation attempt. `taken` is contention (advance); `unreachable`
 *  is a failed READ of the world and must never be read as "free" — the fail-closed direction. */
export type RemoteReserveOutcome = "created" | "taken" | "unreachable";

/** Matches a DEFAULT-FAMILY reservation ref and captures its number. Anchored at both ends so a
 *  suffixed id (`W1-T1B`, which {@link taskIdReservationRef} deliberately keeps distinct) is NOT
 *  read as the bare number, and `[0-9]` rather than `\d` because a POSIX engine drops the latter
 *  silently. */
export const RESERVATION_REF_RE = /(?:^|\s)refs\/rmd-id\/W1-T([0-9]+)$/;

/**
 * Every ALLOCATABLE id the `refs/rmd-id/` namespace already holds on origin, from ONE `ls-remote`
 * — the whole namespace in a single round trip, against one failed push per taken id.
 *
 * ⚠ THE ALLOCATABLE FILTER IS LOAD-BEARING, NOT TIDINESS. Measured on this repo's origin: 793
 * reservation refs, whose highest numbers are 1000002 and 1000003 — far above
 * {@link MAX_ALLOCATABLE_TASK_ID}. Seeding from a raw maximum would move every future mint to
 * 1000004 and keep it there permanently, converting a slow allocator into a broken one. The same
 * bound `mintNextTaskId` applies per source applies here, for the same reason.
 *
 * `"unknown"` on any failure: this is an optimisation, so a remote that cannot be enumerated
 * degrades to today's walk rather than refusing. That is the opposite of {@link
 * RemoteRefReserver.attempt}'s fail-closed posture, and deliberately so — a bad READ here costs
 * attempts, while a bad read THERE would skip a live id.
 */
export function remoteReservedTaskIds(
  run: (args: string[]) => { status: number; stdout: string; stderr: string },
): number[] | "unknown" {
  let res: { status: number; stdout: string; stderr: string };
  try {
    res = run(["ls-remote", "origin", "refs/rmd-id/*"]);
  } catch {
    // A THROWN runner (spawn failure, missing git) is the same answer as a non-zero exit below:
    // the namespace could not be read. Deliberately NOT distinguished, because both lead to the
    // identical caller behaviour — fall back to the linear walk — and inventing a second outcome
    // here would imply a decision no caller makes.
    return "unknown";
  }
  if (res.status !== 0) return "unknown";
  const ids: number[] = [];
  for (const line of (res.stdout ?? "").split("\n")) {
    const m = RESERVATION_REF_RE.exec(line.trimEnd());
    if (!m) continue;
    const n = Number(m[1]);
    if (isAllocatableTaskId(n)) ids.push(n);
  }
  return ids;
}

/** The lowest id no listed reservation holds. `"unknown"` when the namespace could not be read OR
 *  carries no allocatable id — both mean "no floor to raise to", and neither may LOWER a caller's
 *  own start, which {@link reserveTaskIdRemote} enforces with its own `Math.max`. */
export function reservationFloorFrom(ids: number[] | "unknown"): number | "unknown" {
  if (ids === "unknown" || ids.length === 0) return "unknown";
  return Math.max(...ids) + 1;
}

export interface RemoteRefReserver {
  /** A payload unique to THIS writer. Two writers must never produce the same value, or
   *  falsification (1) returns and the lock silently stops locking. */
  mintAnchor(): string;
  /** Create-if-absent of {@link taskIdReservationRef}. Never throws — an unreachable remote is an
   *  OUTCOME, because a thrown error at this seam reads identically to contention at the caller. */
  attempt(taskId: string, anchor: string): RemoteReserveOutcome;
  /**
   * OPTIONAL, and an OPTIMISATION ONLY: the lowest id above every reservation this remote already
   * holds, or `"unknown"`. {@link reserveTaskIdRemote} starts there instead of re-probing ids the
   * namespace already answered for — one `ls-remote` in place of one failed push per taken id.
   *
   * IT IS NEVER A CORRECTNESS INPUT. The push is still the claim, so a floor that is too LOW only
   * costs the attempts it was meant to save, and one that is too HIGH only skips ids that were
   * already burned. A reserver that omits this is byte-identical to before it existed.
   */
  reservedFloor?(): number | "unknown";
}

/** Distinguishes CONTENTION from an unreachable remote. git exits 1 for both, so the only signal
 *  is the message: a rejected update names the ref-update refusal, anything else (DNS, auth,
 *  proxy, timeout) is a failed read of the world. Defaulting the unknown case to `unreachable`
 *  is deliberate — mistaking a network failure for contention would silently skip an id, while
 *  mistaking contention for unreachability only refuses to mint, which is recoverable. */
export function classifyPushFailure(stderr: string): RemoteReserveOutcome {
  return /non-fast-forward|already exists|fetch first|rejected/i.test(stderr) ? "taken" : "unreachable";
}

export interface RemoteReserveDeps {
  /** Runs a git argv; returns its exit status, stdout and stderr. Injected by tests. */
  run(args: string[]): { status: number; stdout: string; stderr: string };
  /** Overrides the anchor for a test that needs two writers to be distinguishable. */
  anchor?: () => string;
}

/**
 * The real reserver: an orphan commit over the empty tree, pushed to the id's own ref.
 *
 * `commit-tree` with NO `-p` is what makes the payload unrelated to every other writer's, which
 * is the entire locking argument (see (4) above). The message carries pid+host+time so an
 * operator inspecting a stuck reservation can see who holds it, and it doubles as the uniqueness
 * source — two writers on one host in the same millisecond still differ by pid.
 */
export function gitRemoteRefReserver(deps: RemoteReserveDeps): RemoteRefReserver {
  // ONE lookup per reserver INSTANCE, not per attempt: `reserveTaskIdBlockRemote` calls
  // `reserveTaskIdRemote` once per id in the block, and re-reading 793 refs for each would trade
  // one round trip for another. A cached floor cannot go stale in a harmful direction — the push
  // is still the claim, so a floor overtaken mid-block just costs the walk it always cost.
  let floor: number | "unknown" | undefined;
  return {
    reservedFloor() {
      if (floor === undefined) floor = reservationFloorFrom(remoteReservedTaskIds(deps.run));
      return floor;
    },
    mintAnchor() {
      if (deps.anchor) return deps.anchor();
      const tree = deps.run(["hash-object", "-t", "tree", "/dev/null"]).stdout.trim();
      const msg = `rmd-id reservation ${process.pid}@${hostname()} ${new Date().toISOString()}`;
      return deps.run(["commit-tree", tree, "-m", msg]).stdout.trim();
    },
    attempt(taskId, anchor) {
      const res = deps.run(["push", "origin", `${anchor}:${taskIdReservationRef(taskId)}`]);
      if (res.status === 0) return "created";
      return classifyPushFailure(res.stderr);
    },
  };
}

export interface ReserveRemoteOpts {
  /** How far above `startId` to advance before refusing. Bounded and LOUD: an unbounded retry
   *  against a network service is how 11,213 GraphQL calls were spent against a 5,000/hour limit
   *  in one morning, and this loop talks to the same host. */
  maxScan?: number;
  /** Renders `W1-T<n>`; injected only so a test can drive a different workstream prefix. */
  idFor?: (n: number) => string;
}

export interface RemoteReservationHandle {
  readonly id: number;
  readonly taskId: string;
  readonly ref: string;
  readonly anchor: string;
  readonly attempts: number;
}

/** The machine-readable fields a {@link TaskIdReservationError} contributes to a ledger row —
 *  `id`/`ref`/`outcome` alongside the message, never the message alone. An operator triaging a
 *  refusal has to tell an unreachable origin from an exhausted range from a local store fault,
 *  and a stringified message is not queryable. `null` rather than `undefined` for the absent
 *  ones so the field is PRESENT in the row: a missing key and a key that is genuinely empty read
 *  identically to a later `zgrep`, and the exhausted arm legitimately names no single ref. */
export function idReservationFailureFields(e: TaskIdReservationError): Record<string, unknown> {
  return { id: e.taskId ?? null, ref: e.ref ?? null, outcome: e.outcome ?? null, error: e.message };
}

/**
 * Run `body`; on a {@link TaskIdReservationError} emit ONE durable ledger row under `step` before
 * rethrowing the error UNCHANGED. Any other error passes through untouched and unlogged.
 *
 * WHY A WRAPPER AND NOT A `catch` AT EACH CALL SITE (W1-T949 design (iv)): all three filing lanes
 * — triage, plan and approve — need the identical refusal record, and each had written its own
 * `catch` around its own `reserveTaskIdBlockRemote` call. Three copies of one policy is three
 * places for it to drift, and none of them was reachable from a unit test: they live inside
 * `run-task.ts`'s lane bodies, so the only way to execute them is to drive a whole lane into a
 * remote failure. Here the policy is one function with both arms exercised directly, and the
 * lanes carry only the step name and any lane-specific field.
 *
 * `extra` is spread FIRST so a lane-specific key (approve's `proposal_id`) leads the row and can
 * never shadow the four fields {@link idReservationFailureFields} contributes.
 */
export function withIdReservationLogging<T>(
  log: (step: string, extra?: Record<string, unknown>) => void,
  step: string,
  body: () => T,
  extra: Record<string, unknown> = {},
): T {
  try {
    return body();
  } catch (e) {
    if (e instanceof TaskIdReservationError) log(step, { ...extra, ...idReservationFailureFields(e) });
    throw e;
  }
}

/**
 * Reserve the first id at or above `startId` that no other writer holds ON THE REMOTE.
 *
 * SAME POLICY AS {@link reserveTaskIdFrom}: contention ADVANCES rather than refusing, so two
 * writers that minted the same candidate both leave with an id and neither poisons the plan.
 *
 * AN UNREACHABLE REMOTE REFUSES TO MINT, and that is the fail-closed choice rather than an
 * oversight. A writer that cannot reserve could mint optimistically and reconcile later — but
 * "mint optimistically" is precisely today's behaviour, and today's behaviour took `origin/main`
 * down twice. Refusing is loud, local, and immediately actionable; the caller has not yet spent
 * anything when it fires.
 *
 * NOTHING RELEASES A RESERVATION, AND THAT IS DELIBERATE. An abandoned filing burns an id
 * forever; ids are integers and a ref is a few dozen bytes, so the whole corpus of ~550 costs
 * around 24 KiB. Release-on-merge would add a distributed-state problem (who releases, on what
 * event, what if it half-fails) to buy back something free, and a gap in the id sequence is
 * already normal — this repo carries four ids that were filed and folded away. A HOLE IS NOT A
 * DEFECT; A COLLISION IS.
 */
export function reserveTaskIdRemote(
  startId: number,
  reserver: RemoteRefReserver,
  opts: ReserveRemoteOpts = {},
): RemoteReservationHandle {
  const maxScan = opts.maxScan ?? 50;
  const idFor = opts.idFor ?? ((n: number) => `W1-T${n}`);
  // SEED FROM THE NAMESPACE THIS FUNCTION ALREADY OWNS. The advisory mint derives its number from
  // plan/tasks.yaml, the shards, open PRs and plan history — four surfaces, none of which is
  // `refs/rmd-id/`. So the reservations THIS function created are invisible to the number it is
  // handed, and it rediscovered them one failed push at a time: measured on this host, 15 attempts
  // and 13.50s for a single id, growing by one with every id the fleet takes.
  //
  // ONLY EVER UPWARDS (`Math.max`): a floor below the caller's own start would hand back an id a
  // plan surface already owns, which is the collision this allocator exists to prevent. And only
  // for the DEFAULT id family — a caller supplying `idFor` is minting in some other namespace that
  // `refs/rmd-id/W1-T<n>` says nothing about.
  const floor = opts.idFor ? "unknown" : (reserver.reservedFloor?.() ?? "unknown");
  const from = floor === "unknown" ? startId : Math.max(startId, floor);
  const anchor = reserver.mintAnchor();
  let attempts = 0;
  for (let n = from; n < from + maxScan; n++) {
    attempts++;
    const outcome = reserver.attempt(idFor(n), anchor);
    if (outcome === "created") return { id: n, taskId: idFor(n), ref: taskIdReservationRef(idFor(n)), anchor, attempts };
    if (outcome === "unreachable") {
      throw new TaskIdReservationError(
        `cannot reach origin to reserve ${idFor(n)} — refusing to mint rather than minting optimistically, ` +
          "which is the behaviour that has already refused loadPlan on origin/main twice",
        { taskId: idFor(n), ref: taskIdReservationRef(idFor(n)), outcome: "unreachable" },
      );
    }
  }
  throw new TaskIdReservationError(
    `no free task id in ${idFor(from)}..${idFor(from + maxScan - 1)} — ` +
      `${maxScan} consecutive ids are reserved on origin (attempted ${attempts})`,
    { taskId: idFor(from), outcome: "exhausted" },
  );
}

/** A block of ids reserved on the remote, one ref each — the remote-substrate twin of
 *  {@link TaskIdReservationBlock}. There is no `releaseAll` here: nothing releases a remote
 *  reservation, deliberately (see {@link reserveTaskIdRemote}'s own doc) — a used-or-not ref
 *  costs a few dozen bytes forever, and reintroducing release would reintroduce the
 *  distributed-state problem this module already refused. */
export interface RemoteReservationBlock {
  /** The reserved ids, ascending — mirrors {@link TaskIdReservationBlock.ids}. */
  readonly ids: number[];
  /** `idFor` applied to each of {@link ids}, in the same order. */
  readonly taskIds: string[];
  /** {@link taskIdReservationRef} applied to each of {@link taskIds}, in the same order. */
  readonly refs: string[];
  /** The handles, in the same order as {@link ids}. */
  readonly handles: RemoteReservationHandle[];
}

/**
 * Reserve `count` ids at or above `startId`, EACH on the remote — the remote-substrate twin of
 * {@link reserveTaskIdBlock}, and the fix W1-T949 exists for: `reserveTaskIdRemote` alone has
 * exactly one call site and reserves exactly one ref, while a filing that mints N ids (triage's
 * own "number them upward" instruction, or the plan/approve lanes' local block) needs N refs
 * pushed to the ONE store every writer shares — not one, and not a fixed count regardless of N
 * (design (v): the paired falsifier a fixed-block implementation would still pass).
 *
 * SAME CONTIGUOUS-FROM-THE-WINNER CHAINING {@link reserveTaskIdBlock} uses locally: each
 * reservation asks ABOVE the id the previous one actually won (`next = h.id + 1`), so contention
 * on any one candidate advances the whole rest of the block past it rather than re-colliding.
 *
 * PARTIAL ACQUIRE THROWS, IT DOES NOT RETURN A SHORT BLOCK (design (i)). A caller must never be
 * handed a block claiming to hold `count` ids while actually holding fewer — so a failure partway
 * through (an unreachable remote, an exhausted scan) throws the SAME {@link TaskIdReservationError}
 * {@link reserveTaskIdRemote} throws, carrying the id/ref/outcome it failed on, rather than
 * returning a partial result the caller could mistake for the whole. Whatever refs were already
 * pushed before the failure STAY pushed — there is nothing to roll back to (see this module's own
 * "NOTHING RELEASES A RESERVATION" doctrine): a hole in the id space is not a defect here, exactly
 * as it is not one for {@link reserveTaskIdBlock}'s unused-but-reserved local ids (design (iii)).
 */
export function reserveTaskIdBlockRemote(
  startId: number,
  count: number,
  reserver: RemoteRefReserver,
  opts: ReserveRemoteOpts = {},
): RemoteReservationBlock {
  if (!Number.isInteger(count) || count < 1) {
    throw new TypeError(`reserveTaskIdBlockRemote: count must be a positive integer, got ${String(count)}`);
  }
  const handles: RemoteReservationHandle[] = [];
  let next = startId;
  for (let i = 0; i < count; i++) {
    const h = reserveTaskIdRemote(next, reserver, opts);
    handles.push(h);
    next = h.id + 1; // ask ABOVE the one just taken, so a block never reserves the same id twice
  }
  return {
    ids: handles.map((h) => h.id),
    taskIds: handles.map((h) => h.taskId),
    refs: handles.map((h) => h.ref),
    handles,
  };
}
