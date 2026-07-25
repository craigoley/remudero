import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

/**
 * Fleet control set (MASTER-PLAN §4A/§4B) — `rmd stop|pause|resume`, plus the
 * quiet-hours toggle (W3-T5, MASTER-PLAN §7/§9).
 *
 * Flag files under `<root>/state/`, checked at the top of every drain tick
 * (lib/drain.ts, W1-T11 acceptance). Mirrors the eventual daemon/panel control
 * set (§4A): **Pause** is drain-and-hold — no new worker spawns, but an
 * in-flight task runs to FULL completion (through verdict and merge) so state
 * stays clean. **Stop** is the hard kill — checked FIRST, every tick, taking
 * precedence over PAUSE — but in this single-task-at-a-time drain loop (W1-T12's
 * daemon does not exist yet) it hits the SAME "no new spawn" boundary as PAUSE;
 * the two are logged distinctly (`drain.stop` vs `drain.pause`) so an operator
 * can tell "holding, resumable" from "operator pulled the plug" apart in the
 * ledger. `rmd resume` clears BOTH flags — the one command that always means go.
 *
 * **Quiet hours** is a THIRD, independent flag (W3-T5): "is now an OPTIONAL
 * wizard toggle, default OFF" (§9) — unlike STOP/PAUSE it does not gate the
 * drain loop by itself (the scheduler that reads it to throttle spawns is
 * later work, same "mechanism now, consumer later" split as lib/board.ts);
 * `setQuietHours` only flips the flag a future consumer reads. `rmd resume`
 * deliberately does NOT touch it — quiet hours is a schedule preference, not
 * an emergency hold, so an operator resuming from a STOP/PAUSE should not
 * silently lose their quiet-hours setting.
 *
 * Plain flag files (not a lock — no liveness/staleness semantics like
 * drain-lock.ts/inflight-lock.ts): existence alone gates the loop, so a
 * corrupt/unreadable file still fails CLOSED (stopped/paused), never open.
 */

export interface FleetControlInfo {
  reason?: string;
  requestedAt: string;
  pid: number;
  host: string;
}

export function stopFilePath(root: string): string {
  return join(root, "state", "STOP");
}

export function pauseFilePath(root: string): string {
  return join(root, "state", "PAUSE");
}

export function quietHoursFilePath(root: string): string {
  return join(root, "state", "QUIET_HOURS");
}

function writeFlag(path: string, reason: string | undefined): FleetControlInfo {
  const info: FleetControlInfo = {
    reason,
    requestedAt: new Date().toISOString(),
    pid: process.pid,
    host: hostname(),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(info, null, 2));
  return info;
}

/** Best-effort read; a missing/garbage file is `null` (the CALLER decides what that means). */
function readFlag(path: string): FleetControlInfo | null {
  try {
    const o = JSON.parse(readFileSync(path, "utf8"));
    return typeof o?.requestedAt === "string" ? (o as FleetControlInfo) : null;
  } catch {
    return null;
  }
}

function clearFlag(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false; // another actor cleared it concurrently — treat as already-clear
  }
}

/** `rmd stop [--reason <text>]` — write the STOP flag. */
export function requestStop(root: string, reason?: string): FleetControlInfo {
  return writeFlag(stopFilePath(root), reason);
}

/** `rmd pause [--reason <text>]` — write the PAUSE flag. */
export function requestPause(root: string, reason?: string): FleetControlInfo {
  return writeFlag(pauseFilePath(root), reason);
}

/** Gate predicate: existence alone, independent of whether the JSON parses (fail CLOSED). */
export function isStopped(root: string): boolean {
  return existsSync(stopFilePath(root));
}

/** Gate predicate: existence alone, independent of whether the JSON parses (fail CLOSED). */
export function isPaused(root: string): boolean {
  return existsSync(pauseFilePath(root));
}

/** Gate predicate: existence alone, independent of whether the JSON parses (fail CLOSED). */
export function isQuietHours(root: string): boolean {
  return existsSync(quietHoursFilePath(root));
}

/** Human-readable ledger/summary detail when STOPPED; `undefined` when not. */
export function stopDetail(root: string): string | undefined {
  if (!isStopped(root)) return undefined;
  const info = readFlag(stopFilePath(root));
  return info?.reason ? `STOP requested: ${info.reason}` : "STOP file present — run `rmd resume` to clear";
}

/** Human-readable ledger/summary detail when PAUSED; `undefined` when not. */
export function pauseDetail(root: string): string | undefined {
  if (!isPaused(root)) return undefined;
  const info = readFlag(pauseFilePath(root));
  return info?.reason ? `PAUSE requested: ${info.reason}` : "PAUSE file present — run `rmd resume` to clear";
}

/**
 * `rmd quiet-hours on|off` / the panel's quiet-hours toggle (W3-T5) — flip the flag. Unlike
 * STOP/PAUSE this is a plain boolean preference, not an emergency hold, so it has no
 * "request with a reason that survives to a detail string" shape: `on` writes the flag,
 * `off` clears it, and the return value is simply the resulting state.
 */
export function setQuietHours(root: string, enabled: boolean): boolean {
  if (enabled) {
    writeFlag(quietHoursFilePath(root), undefined);
    return true;
  }
  clearFlag(quietHoursFilePath(root));
  return false;
}

/**
 * AUTO-CONSUME the STOP flag (one-shot lifecycle). STOP exists only to halt the CURRENTLY
 * running drain; the drain that observed it clears it as it terminates (drainCommand /
 * daemonCommand finally), so STOP can NEVER silently block a future drain — unlike PAUSE,
 * which is a persistent maintenance hold cleared ONLY by `rmd resume`. Clears STOP alone,
 * never PAUSE. Idempotent (returns false when there was nothing to consume).
 */
export function consumeStop(root: string): boolean {
  return clearFlag(stopFilePath(root));
}

export interface ResumeResult {
  clearedStop: boolean;
  clearedPause: boolean;
}

/** `rmd resume` — clear BOTH flags. Idempotent; a resume with nothing to clear is not an error. */
export function resumeFleet(root: string): ResumeResult {
  return {
    clearedStop: clearFlag(stopFilePath(root)),
    clearedPause: clearFlag(pauseFilePath(root)),
  };
}

// ── CONSOLE WRITE-ACTION MARKERS (fb-1784988460437-9daa9b) ──────────────────────
//
// Operator write-actions on the console's UP NEXT panel use the SAME marker-file
// pattern as STOP/PAUSE and DEPLOY_REQUESTED (deployer.ts) — the console NEVER
// manages a process; it drops a marker the running daemon consumes at its next
// poll. Two kinds:
//   - `state/KICK_REQUESTED-<taskId>` — "Run this queued task now." One file per
//     task id, so several kicks coexist and are dispatched over successive cycles.
//   - `state/DRAIN_REQUESTED` — "run one dispatch cycle immediately."
// Each marker carries the caller's `origin` (bearerTokenId, panel-actions.ts) —
// the arm-identity captured AT BIRTH — so the daemon's consume-time ledger line
// names the console as actor without the daemon ever seeing the raw token.

/** A queued-task "Run now" request, parsed off a `KICK_REQUESTED-<taskId>` marker. */
export interface KickRequest {
  taskId: string;
  /** The console actor id (a bearer-token hash), carried from write to consume. */
  origin: string;
  requestedAt: string;
}

/** A "Drain now" request, parsed off the `DRAIN_REQUESTED` marker. */
export interface DrainNowRequest {
  origin: string;
  requestedAt: string;
}

/**
 * Task ids that may become a marker FILENAME. Deliberately strict (the plan's own
 * `W1-T###`/`SBX-T#` shape plus a safe superset) so a hostile or malformed id can
 * never traverse out of `state/` (`/`, `..`, NUL, whitespace all rejected). Enforced
 * fail-closed on BOTH write (`requestKick` throws) and read (`pendingKicks` skips).
 */
const SAFE_TASK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126})$/;

/** True iff `taskId` is safe to embed in a marker filename (see {@link SAFE_TASK_ID}). */
export function isSafeTaskId(taskId: unknown): taskId is string {
  return typeof taskId === "string" && SAFE_TASK_ID.test(taskId) && !taskId.includes("..");
}

const KICK_PREFIX = "KICK_REQUESTED-";

export function kickFilePath(root: string, taskId: string): string {
  return join(root, "state", `${KICK_PREFIX}${taskId}`);
}

export function drainNowFilePath(root: string): string {
  return join(root, "state", "DRAIN_REQUESTED");
}

/**
 * Write a `KICK_REQUESTED-<taskId>` marker (the console's "Run" button). Throws on an
 * unsafe task id BEFORE any write — a malformed id performs no side effect, ever.
 * Overwriting an existing marker for the same id is idempotent (still one pending kick).
 */
export function requestKick(root: string, taskId: string, origin: string): KickRequest {
  if (!isSafeTaskId(taskId)) throw new Error(`requestKick: unsafe task id ${JSON.stringify(taskId)}`);
  const req: KickRequest = { taskId, origin, requestedAt: new Date().toISOString() };
  const path = kickFilePath(root, taskId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(req, null, 2));
  return req;
}

/**
 * Every pending kick, oldest-first (by `requestedAt`). PEEK ONLY — does not delete; the
 * daemon clears each with {@link clearKick} as it dispatches or refuses it, so a runnable
 * kick it can't service this cycle survives to the next. A file whose JSON is garbage, or
 * whose id no longer parses as safe, is skipped (fail-closed), never dispatched.
 */
export function pendingKicks(root: string): KickRequest[] {
  const dir = join(root, "state");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(KICK_PREFIX));
  } catch {
    return []; // no state dir yet ⇒ no kicks
  }
  const out: KickRequest[] = [];
  for (const name of names) {
    try {
      const o = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (isSafeTaskId(o?.taskId) && typeof o?.origin === "string" && typeof o?.requestedAt === "string") {
        out.push({ taskId: o.taskId, origin: o.origin, requestedAt: o.requestedAt });
      }
    } catch {
      // garbage marker — leave it for an operator to notice; never dispatch off it.
    }
  }
  return out.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

/** Delete one kick marker (consumed-once). Idempotent; a concurrent clear is not an error. */
export function clearKick(root: string, taskId: string): boolean {
  return clearFlag(kickFilePath(root, taskId));
}

/** Write the `DRAIN_REQUESTED` marker (the console's "Drain now" button). */
export function requestDrainNow(root: string, origin: string): DrainNowRequest {
  const req: DrainNowRequest = { origin, requestedAt: new Date().toISOString() };
  const path = drainNowFilePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(req, null, 2));
  return req;
}

/** Read + DELETE the `DRAIN_REQUESTED` marker (consumed-once). `null` when none/garbage. */
export function consumeDrainNow(root: string): DrainNowRequest | null {
  const path = drainNowFilePath(root);
  if (!existsSync(path)) return null;
  let parsed: DrainNowRequest | null = null;
  try {
    const o = JSON.parse(readFileSync(path, "utf8"));
    if (typeof o?.origin === "string" && typeof o?.requestedAt === "string") {
      parsed = { origin: o.origin, requestedAt: o.requestedAt };
    }
  } catch {
    parsed = null;
  }
  clearFlag(path); // consumed-once regardless of parse outcome — a garbage marker never lingers
  return parsed;
}
