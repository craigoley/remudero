import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
