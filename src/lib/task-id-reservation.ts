import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { defaultIsPidAlive } from "./drain-lock.js";
import { isAllocatableTaskId } from "./task-id.js";

/**
 * Atomic reservation of a minted task id — the piece {@link mintNextTaskIdWithHistory} skips. The
 * mint is a snapshot (plan/tasks.yaml, every shard, open plan PRs, plan history since #1051), so
 * two hosts that mint before either pushes derive the SAME id; since #1060 that collision merges
 * cleanly onto `main`, surfacing later as `loadPlan`'s "duplicate task id" rather than at merge
 * time. Reservation composes on top of the mint's answer and never changes what it computes (see
 * CLAUDE.md's "Plan and task hygiene" for why a contested reservation renumbers rather than being
 * deleted). Reservations live under `<root>/state/`, one file per id, atomic via `O_EXCL` —
 * discarding a torn write here IS the collision, unlike the mint's own history cache.
 * Why: docs/forensics/task-id-reservation.md#module-header. Falsifier: test/task-id-reservation.test.ts.
 */
export function taskIdReservationsDir(root: string): string {
  return join(root, "state", "task-id-reservations");
}

/** One reserved id's on-disk record. `purpose` is for an operator's `cat`, never parsed — a new caller never invalidates an existing reservation by adding one. */
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

/** A reservation file's contents, or `null` when missing, unreadable, or garbage — mirroring
 *  {@link "./drain-lock.js".readDrainLock}: an unparseable holder is NO holder, so a half-written file can never wedge an id shut. */
export function readTaskIdReservation(path: string): TaskIdReservationInfo | null {
  try {
    const o = JSON.parse(readFileSync(path, "utf8"));
    if (typeof o?.pid === "number" && typeof o?.id === "number") return o as TaskIdReservationInfo;
    return null;
  } catch {
    return null;
  }
}

/** How a reservation failure is machine-classified: "unreachable" is a failed remote read/write
 *  (recoverable), "exhausted" means the scanned window was already fully held, "local" is a
 *  non-contention LOCAL store fault naming no remote id/ref. Ledgered as fields, never a string. */
export type ReservationFailureOutcome = "unreachable" | "exhausted" | "local" | "unknown";

/**
 * Raised when a reservation fails for a reason that is NOT contention — an unwritable state
 * directory, a full disk, an unreachable remote, or an exhausted scan window. Loud on purpose:
 * `triageCommandLocked` reserves before spawning a paid worker, so a silent fallback to the
 * unreserved id would spend money AND still collide (the paid-worker trap). Carries the
 * id/ref/outcome it failed on directly, not only in the message, so a catching lane logs a
 * queryable row instead of re-parsing prose; a field is `undefined` only where none applies.
 * Why: docs/forensics/task-id-reservation.md#taskidreservationerror.
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

/** Every id currently reserved by a LIVE holder, ascending. A reservation whose pid is dead or
 *  whose file is garbage is NOT reported — it is reclaimable, and treating it as held is the "phantom id" failure this module must not create. */
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
  /** How far above `startId` to search before giving up — guards an unbounded loop if the
   *  directory somehow fills with live reservations; 1000 is far above any real fleet's in-flight count. */
  maxScan?: number;
}

/**
 * Reserve the first id at or above `startId` that no LIVE holder has claimed, and return a handle.
 * Contention advances rather than refusing: `O_EXCL` lets exactly one of two same-`startId`
 * callers create the file, and the loser retries at `startId + 1` — both get an id, neither
 * collides. A dead holder is reclaimed, never burned — the phantom-id trap the header names.
 * Why: docs/forensics/task-id-reservation.md#reservetaskidfrom.
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

/** What {@link firstUnreservedAtOrAbove} reports: an id, or `"unknown"` when a needed store could
 *  not be read — a first-class outcome, never an exception, and never folded into a false "nothing reserved". */
export type FirstUnreservedResult = number | "unknown";

export interface FirstUnreservedOpts {
  isPidAlive?: (pid: number) => boolean;
  /** Reads which ids are held on a store OTHER than `dir` — production's `refs/rmd-id/*`
   *  (W1-T509), which a worker sandbox's local `dir` does not share. Injected, never opened here,
   *  so omitting it is exactly today's local-only read.
   *  Why: docs/forensics/task-id-reservation.md#firstunreservedopts-readremoteheld. */
  readRemoteHeld?: () => Set<number> | "unknown";
}

/**
 * The first id at or above `startId` that no LIVE holder has claimed — WITHOUT reserving it. For
 * advisory readers (`rmd next-task-id`): reporting and claiming are different acts, and only the
 * caller that will actually FILE should claim. The two stores fail asymmetrically: `dir` missing
 * reads as free, but `readRemoteHeld` returning `"unknown"` must propagate as `"unknown"` rather
 * than fold into a free id — that fold-in is exactly the collision this function exists to close.
 * Why: docs/forensics/task-id-reservation.md#firstunreservedatorabove.
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
  /** Release EVERY handle. Idempotent, and never throws — a release failure must not mask the caller's own error. */
  releaseAll(): void;
}

/**
 * Reserve `count` ids at or above `startId`, as a block, released together — `rmd plan` must
 * reserve BEFORE a worker runs but doesn't know the count until it has (closes the gap #1075 left
 * for a second or third id). Every id is released, including ones nobody used — the phantom-id
 * trap the header names — via {@link TaskIdReservationBlock.releaseAll}, from the caller's `finally`.
 * Why: docs/forensics/task-id-reservation.md#reservetaskidblock.
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
    // a partial acquire must not strand: whatever was taken before the failure is released here,
    // so the only paths out of this function are "all of them held" or "none of them held".
    releaseAll();
    throw err;
  }
  return { ids: handles.map((h) => h.id), handles, releaseAll };
}

// ── REMOTE RESERVATION (W1-T509) — a substrate every writer can see ──────────────────────────
// Everything above is local-only, invisible across hosts: a worker sandbox's `dir` is discarded
// on exit. `refs/rmd-id/` is the shared substrate, and only ONE push shape actually locks — an
// ORPHAN commit (no parents) to the id's own ref, since two writers can never share that payload.
// A tag, an empty-value `--force-with-lease`, and a local-only `update-ref` all measured as NOT
// locking (see forensics). The namespace sits outside a default `git fetch` and outside
// `reapBranchesCommand`'s `refs/heads/`-only view.
// Why: docs/forensics/task-id-reservation.md#remote-reservation-w1-t509.

/** The ref a reserved id occupies. Suffix-aware by construction: the id is the whole token, so
 *  `W1-T1` and `W1-T1B` are different refs and neither folds onto the other. */
export function taskIdReservationRef(taskId: string): string {
  return `refs/rmd-id/${taskId}`;
}

/** The outcome of one remote reservation attempt. `taken` is contention (advance); `unreachable`
 *  is a failed READ of the world and must never be read as "free" — the fail-closed direction. */
export type RemoteReserveOutcome = "created" | "taken" | "unreachable" | "local" | "unknown";

/** Matches a DEFAULT-FAMILY reservation ref and captures its number. Anchored at both ends so a
 *  suffixed id (`W1-T1B`) is NOT read as the bare number; `[0-9]` not `\d` since a POSIX engine drops the latter silently. */
export const RESERVATION_REF_RE = /(?:^|\s)refs\/rmd-id\/W1-T([0-9]+)$/;

/**
 * Every ALLOCATABLE id `refs/rmd-id/` already holds on origin, from ONE `ls-remote` — one round
 * trip against one failed push per taken id otherwise. The filter is load-bearing: this namespace
 * also holds refs far above {@link MAX_ALLOCATABLE_TASK_ID}, which a raw maximum would seed from
 * permanently. `"unknown"` on a read failure degrades to the slower walk instead of refusing —
 * deliberately the opposite of {@link RemoteRefReserver.attempt}'s fail-closed posture.
 * Why: docs/forensics/task-id-reservation.md#remotereservedtaskids.
 */
export function remoteReservedTaskIds(
  run: (args: string[]) => { status: number; stdout: string; stderr: string },
): number[] | "unknown" {
  let res: { status: number; stdout: string; stderr: string };
  try {
    res = run(["ls-remote", "origin", "refs/rmd-id/*"]);
  } catch {
    return "unknown"; // a thrown runner reads identically to a non-zero exit: both fall back to the walk
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

/** The lowest id no listed reservation holds. `"unknown"` when unreadable or empty — both mean "no
 *  floor to raise to", and neither may LOWER a caller's own start ({@link reserveTaskIdRemote}'s `Math.max`). */
export function reservationFloorFrom(ids: number[] | "unknown"): number | "unknown" {
  if (ids === "unknown" || ids.length === 0) return "unknown";
  return Math.max(...ids) + 1;
}

export interface RemoteRefReserver {
  /** A payload unique to THIS writer. Two writers must never produce the same value, or a
   *  shared-anchor remote (which treats a matching push as a no-op success) stops locking. */
  mintAnchor(): string;
  /** Create-if-absent of {@link taskIdReservationRef}. Never throws — an unreachable remote is an
   *  OUTCOME, because a thrown error at this seam reads identically to contention at the caller. */
  attempt(taskId: string, anchor: string): RemoteReserveOutcome;
  /** Stderr from the latest failed attempt, retained so a refusal can name the evidence. */
  lastAttemptStderr?(): string | undefined;
  /** OPTIONAL, an optimisation only: the lowest id above every reservation this remote already
   *  holds, so {@link reserveTaskIdRemote} can start there instead of re-probing. Never a
   *  correctness input — a floor too LOW only costs attempts, one too HIGH only skips burned ids. */
  reservedFloor?(): number | "unknown";
}

/** Classifies the reservation push's actual evidence. Unknown errors remain fail-closed, but are
 *  not misreported as an unreachable origin. */
export function classifyReservationPushFailure(stderr: string): RemoteReserveOutcome {
  if (/pre-push\s+REFUSED\./i.test(stderr)) return "local";
  if (/non-fast-forward|already exists|fetch first|rejected/i.test(stderr)) return "taken";
  if (/could not read from remote repository|could not resolve host|unable to access|connection (?:timed out|refused)|network is unreachable|no route to host|ssh: connect to host/i.test(stderr)) {
    return "unreachable";
  }
  return "unknown";
}

/** Distinguishes CONTENTION from an unreachable remote for existing non-reservation claim callers. */
export function classifyPushFailure(stderr: string): "taken" | "unreachable" {
  return /non-fast-forward|already exists|fetch first|rejected/i.test(stderr) ? "taken" : "unreachable";
}

export interface RemoteReserveDeps {
  /** Runs a git argv; returns its exit status, stdout and stderr. Injected by tests. */
  run(args: string[]): { status: number; stdout: string; stderr: string };
  /** Overrides the anchor for a test that needs two writers to be distinguishable. */
  anchor?: () => string;
}

export interface ReservationHolderLine {
  branch: string;
  pid?: number;
  host?: string;
  startedAt?: string;
  source?: string;
}

export type ParsedReservationHolderLine =
  | { status: "known"; holder: ReservationHolderLine }
  | { status: "legacy" }
  | { status: "unreadable"; reason: string };

function holderValue(v: string): string {
  return encodeURIComponent(v).replace(/%20/g, "+");
}

function unholderValue(v: string): string {
  return decodeURIComponent(v.replace(/\+/g, "%20"));
}

function currentBranch(run: RemoteReserveDeps["run"]): string {
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF;
  const symbolic = run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (symbolic.status === 0 && symbolic.stdout.trim()) return symbolic.stdout.trim();
  const abbrev = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (abbrev.status === 0 && abbrev.stdout.trim() && abbrev.stdout.trim() !== "HEAD") return abbrev.stdout.trim();
  return "unknown";
}

export function formatReservationHolderLine(holder: ReservationHolderLine): string {
  const parts = [`branch=${holderValue(holder.branch)}`];
  if (holder.pid !== undefined) parts.push(`pid=${holder.pid}`);
  if (holder.host !== undefined) parts.push(`host=${holderValue(holder.host)}`);
  if (holder.startedAt !== undefined) parts.push(`started_at=${holderValue(holder.startedAt)}`);
  if (holder.source !== undefined) parts.push(`source=${holderValue(holder.source)}`);
  return `rmd-id holder ${parts.join(" ")}`;
}

export function formatReservationAnchorMessage(holder: ReservationHolderLine): string {
  const who = holder.pid !== undefined && holder.host ? `${holder.pid}@${holder.host}` : holder.branch;
  return `rmd-id reservation ${who} ${holder.startedAt ?? new Date().toISOString()}\n\n${formatReservationHolderLine(holder)}`;
}

export function formatHandMintReservationMessage(taskId: string, holder: ReservationHolderLine): string {
  return `reserve ${taskId} ${holder.branch}\n\n${formatReservationHolderLine({ ...holder, source: holder.source ?? "hand-mint" })}`;
}

export function parseReservationHolderLine(message: string): ParsedReservationHolderLine {
  const line = message.split(/\r?\n/).find((l) => l.startsWith("rmd-id holder "));
  if (!line) return { status: "legacy" };
  const values = new Map<string, string>();
  for (const token of line.slice("rmd-id holder ".length).trim().split(/[ \t]+/)) {
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq < 1) return { status: "unreadable", reason: `malformed token ${token}` };
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    try {
      values.set(key, unholderValue(value));
    } catch {
      return { status: "unreadable", reason: `malformed value for ${key}` };
    }
  }
  const branch = values.get("branch");
  if (!branch || branch === "unknown") return { status: "unreadable", reason: "missing branch" };
  const pidRaw = values.get("pid");
  const pid = pidRaw === undefined ? undefined : Number(pidRaw);
  if (pidRaw !== undefined && !Number.isInteger(pid)) return { status: "unreadable", reason: "malformed pid" };
  return {
    status: "known",
    holder: {
      branch,
      pid,
      host: values.get("host"),
      startedAt: values.get("started_at"),
      source: values.get("source"),
    },
  };
}

/** The real reserver: an orphan commit over the empty tree, pushed to the id's own ref. `commit-tree`
 *  with NO `-p` is what makes the payload unrelated to every other writer's (see the module-level
 *  note above); the message carries pid+host+time plus a parseable holder line, so an operator can
 *  see which branch or lane owns a stuck reservation. */
export function gitRemoteRefReserver(deps: RemoteReserveDeps): RemoteRefReserver {
  // Cached once per reserver INSTANCE, not per attempt — a block makes N calls, and the push
  // staying the claim means a stale floor only costs attempts, never a wrong id.
  let floor: number | "unknown" | undefined;
  let lastStderr: string | undefined;
  return {
    lastAttemptStderr() {
      return lastStderr;
    },
    reservedFloor() {
      if (floor === undefined) floor = reservationFloorFrom(remoteReservedTaskIds(deps.run));
      return floor;
    },
    mintAnchor() {
      if (deps.anchor) return deps.anchor();
      const tree = deps.run(["hash-object", "-t", "tree", "/dev/null"]).stdout.trim();
      const startedAt = new Date().toISOString();
      const msg = formatReservationAnchorMessage({
        branch: currentBranch(deps.run),
        pid: process.pid,
        host: hostname(),
        startedAt,
        source: "automatic",
      });
      return deps.run(["commit-tree", tree, "-m", msg]).stdout.trim();
    },
    attempt(taskId, anchor) {
      const res = deps.run(["push", "origin", `${anchor}:${taskIdReservationRef(taskId)}`]);
      if (res.status === 0) {
        lastStderr = undefined;
        return "created";
      }
      lastStderr = res.stderr;
      return classifyReservationPushFailure(res.stderr);
    },
  };
}

export interface ReserveRemoteOpts {
  /** How far above `startId` to advance before refusing. Bounded and LOUD: an unbounded retry
   *  against a network service risks exhausting a shared rate limit this same host shares with
   *  other callers (docs/forensics/task-id-reservation.md#reserveremoteopts-maxscan). */
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

/** The machine-readable fields a {@link TaskIdReservationError} contributes to a ledger row, so an
 *  operator can tell an unreachable origin from an exhausted range from a local fault. `null` keeps the key PRESENT for a later `zgrep`. */
export function idReservationFailureFields(e: TaskIdReservationError): Record<string, unknown> {
  return { id: e.taskId ?? null, ref: e.ref ?? null, outcome: e.outcome ?? null, error: e.message };
}

/**
 * Run `body`; on a {@link TaskIdReservationError} emit ONE durable ledger row under `step` before
 * rethrowing UNCHANGED. Any other error passes through untouched and unlogged — one policy
 * instead of three lane-local `catch` blocks (triage, plan, approve) that had drifted. `extra` is
 * spread FIRST so a lane-specific key leads without shadowing {@link idReservationFailureFields}.
 * Why: docs/forensics/task-id-reservation.md#withidreservationlogging.
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
 * Reserve the first id at or above `startId` no other writer holds ON THE REMOTE. Same policy as
 * {@link reserveTaskIdFrom}: contention advances rather than refusing. An unreachable remote
 * refuses to mint rather than reconciling optimistically later, which is what took `origin/main`
 * down twice before this existed. Nothing ever releases a reservation, either: a hole in the
 * sequence is cheap and normal here, cheaper than the distributed-state problem release-on-merge
 * would trade it for. A hole is not a defect; a collision is.
 * Why: docs/forensics/task-id-reservation.md#reservetaskidremote.
 */
export function reserveTaskIdRemote(
  startId: number,
  reserver: RemoteRefReserver,
  opts: ReserveRemoteOpts = {},
): RemoteReservationHandle {
  const maxScan = opts.maxScan ?? 50;
  const idFor = opts.idFor ?? ((n: number) => `W1-T${n}`);
  // Seeds from the namespace THIS function owns, invisible to the mint's own surfaces — without it
  // the loop rediscovers every prior reservation one failed push at a time (forensics: #reservetaskidremote-seeding).
  // `Math.max` only ever moves the floor UP, and only for the default id family.
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
    if (outcome === "local") {
      const stderr = reserver.lastAttemptStderr?.() ?? "pre-push REFUSED.";
      throw new TaskIdReservationError(
        `local pre-push gate refused reservation of ${idFor(n)} — refusing to mint. git said:\n${stderr}`,
        { taskId: idFor(n), ref: taskIdReservationRef(idFor(n)), outcome: "local" },
      );
    }
    if (outcome === "unknown") {
      const stderr = reserver.lastAttemptStderr?.() ?? "(no stderr was emitted)";
      throw new TaskIdReservationError(
        `UNKNOWN push failure while reserving ${idFor(n)} — refusing to mint. git said:\n${stderr}`,
        { taskId: idFor(n), ref: taskIdReservationRef(idFor(n)), outcome: "unknown" },
      );
    }
  }
  throw new TaskIdReservationError(
    `no free task id in ${idFor(from)}..${idFor(from + maxScan - 1)} — ` +
      `${maxScan} consecutive ids are reserved on origin (attempted ${attempts})`,
    { taskId: idFor(from), outcome: "exhausted" },
  );
}

/** A block of ids reserved on the remote, one ref each — the remote twin of
 *  {@link TaskIdReservationBlock}, with no `releaseAll`: nothing releases a remote reservation,
 *  deliberately (see {@link reserveTaskIdRemote}'s own doc). */
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
 * Reserve `count` ids at or above `startId`, EACH on the remote — the remote twin of
 * {@link reserveTaskIdBlock}, for a filing that mints N ids needing N refs pushed to the shared
 * store. Chains the same way: each reservation asks above the id the previous one won. Partial
 * acquire throws rather than returning a short block — refs already pushed before a failure stay
 * pushed (see {@link reserveTaskIdRemote}'s own doctrine).
 * Why: docs/forensics/task-id-reservation.md#reservetaskidblockremote.
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
