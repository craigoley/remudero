// src/lib/daemon-standby.ts — W1-T14544: the waiting half of a blue-green daemon restart.
//
// A standby daemon (`rmd daemon --standby`) runs only the read-only part of its boot, says it is ready, and waits
// for the daemon that started it to hand over. INVARIANT single-writer: nothing here takes `state/drain.lock` from a
// live holder. The pid lock is the fence on one host; `acquireDrainLock` already reclaims a lock whose holder is dead.
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { type Clock, systemClock } from "./clock.js";
import { DrainLockError, type DrainLockHandle, type DrainLockInfo } from "./drain-lock.js";

/** Directory of the standby's ready and promote markers. */
export const standbyDir = (stateDir: string): string => join(stateDir, "daemon-standby");
/** Directory the entrypoint watches for a handed-off successor (deploy/entrypoint-supervise.sh, W1-T14546). */
export const handoffDir = (stateDir: string): string => join(stateDir, "daemon-handoff");
export const standbyReadyPath = (stateDir: string, runId: string): string => join(standbyDir(stateDir), `${runId}.ready`);
export const standbyPromotePath = (stateDir: string, runId: string): string => join(standbyDir(stateDir), `${runId}.promote`);
export const handoffExitPath = (stateDir: string, pid: number): string => join(handoffDir(stateDir), `${pid}.exit`);

/** BACKSTOP: a prepare not ready inside 10 min aborts; a healthy read-only boot measured ~15 s (2026-11-23 boot_phases). */
export const STANDBY_READY_BOUND_MS = 10 * 60_000;
/** BACKSTOP: a standby never promoted inside 60 min exits; the active's exit wait measured p90 1,800 s. */
export const STANDBY_PROMOTE_BOUND_MS = 60 * 60_000;
/** BACKSTOP: a live lock holder that has not let go inside 5 min is refused, never reclaimed. */
export const STANDBY_LOCK_WAIT_BOUND_MS = 5 * 60_000;
export const STANDBY_POLL_MS = 500;

export interface StandbyPorts {
  readonly stateDir: string;
  readonly runId: string;
  readonly sha: string | undefined;
  readonly pid: number;
  readonly clock: Clock;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (step: string, extra?: Record<string, unknown>) => void;
  readonly readyBoundMs: number;
  readonly promoteBoundMs: number;
  readonly lockWaitBoundMs: number;
  readonly pollMs: number;
  /** W1-T15004: the command line this daemon started with; its `--repo` and slot tree name the promoted title. */
  readonly argv: readonly string[];
  readonly setTitle: (title: string) => void;
  /** `/proc/self/status`, whose NSpid line holds this process's pid in each pid namespace, outermost first. */
  readonly readStatus: () => string | undefined;
}

export interface StandbyOptions {
  readonly readyBoundMs?: number;
  readonly promoteBoundMs?: number;
  readonly lockWaitBoundMs?: number;
  readonly pollMs?: number;
  readonly clock?: Clock;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly argv?: readonly string[];
  readonly setTitle?: (title: string) => void;
  readonly readStatus?: () => string | undefined;
}

export function standbyPorts(base: Pick<StandbyPorts, "stateDir" | "runId" | "sha" | "pid" | "log">, opts: StandbyOptions = {}): StandbyPorts {
  return {
    ...base,
    clock: opts.clock ?? systemClock,
    sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    readyBoundMs: opts.readyBoundMs ?? STANDBY_READY_BOUND_MS,
    promoteBoundMs: opts.promoteBoundMs ?? STANDBY_PROMOTE_BOUND_MS,
    lockWaitBoundMs: opts.lockWaitBoundMs ?? STANDBY_LOCK_WAIT_BOUND_MS,
    pollMs: opts.pollMs ?? STANDBY_POLL_MS,
    argv: opts.argv ?? process.argv,
    setTitle: opts.setTitle ?? ((title) => { process.title = title; }),
    readStatus: opts.readStatus ?? readProcSelfStatus,
  };
}

function readProcSelfStatus(): string | undefined {
  try {
    return readFileSync("/proc/self/status", "utf8");
  } catch {
    return undefined; // no procfs (macOS): the row's host_pid is then null, never a guess
  }
}

/** W1-T15004: the title a promoted daemon shows in `ps`, since a promoted standby keeps its `--standby` argv. */
export function promotedDaemonTitle(argv: readonly string[], runId: string): string {
  const at = argv.indexOf("--repo");
  const repo = at >= 0 ? argv[at + 1] : argv.find((arg) => arg.startsWith("--repo="))?.slice("--repo=".length);
  const slot = argv.map((arg) => /\/daemon-slots\/([^/]+)\//.exec(arg)?.[1]).find((name) => name !== undefined);
  return ["rmd daemon active", repo ?? "unknown-repo", runId, ...(slot ? [`slot-${slot}`] : [])].join(" ");
}

/** The pid in the outermost pid namespace this process's procfs shows (the host's when /proc is the host's), or null. */
export function outermostPid(status: string | undefined): number | null {
  const first = /^NSpid:\s+(\d+)/m.exec(status ?? "")?.[1];
  return first === undefined ? null : Number(first);
}

export type StandbyAbort = { readonly criterion: "prepare_failed" | "ready_bound" | "promote_bound"; readonly detail?: string };

/** Records an abort; the caller exits without touching the lock. Removes the ready marker so nothing promotes it. */
export function abortStandby(ports: StandbyPorts, abort: StandbyAbort, startedAtMs: number): void {
  rmSync(standbyReadyPath(ports.stateDir, ports.runId), { force: true });
  ports.log("daemon.standby_aborted", { criterion: abort.criterion, ...(abort.detail === undefined ? {} : { detail: abort.detail.slice(0, 300) }),
    elapsed_ms: Math.max(0, ports.clock.now() - startedAtMs), sha: ports.sha ?? null });
}

/**
 * The prepare ended: past the ready bound it aborts, otherwise it writes the ready marker and waits for the promote
 * marker. Resolves with how long it waited, or with the abort it recorded.
 */
export async function awaitPromotion(ports: StandbyPorts, startedAtMs: number): Promise<{ prepareMs: number; waitMs: number } | StandbyAbort> {
  const prepareMs = Math.max(0, ports.clock.now() - startedAtMs);
  if (prepareMs > ports.readyBoundMs) {
    const abort: StandbyAbort = { criterion: "ready_bound", detail: `prepare took ${prepareMs} ms, bound ${ports.readyBoundMs} ms` };
    abortStandby(ports, abort, startedAtMs);
    return abort;
  }
  mkdirSync(standbyDir(ports.stateDir), { recursive: true });
  writeFileSync(standbyReadyPath(ports.stateDir, ports.runId),
    JSON.stringify({ run_id: ports.runId, sha: ports.sha ?? null, pid: ports.pid, prepare_ms: prepareMs }) + "\n");
  ports.log("daemon.standby_ready", { sha: ports.sha ?? null, pid: ports.pid, prepare_ms: prepareMs });
  const readyAtMs = ports.clock.now();
  while (!existsSync(standbyPromotePath(ports.stateDir, ports.runId))) {
    if (ports.clock.now() - readyAtMs > ports.promoteBoundMs) {
      const abort: StandbyAbort = { criterion: "promote_bound", detail: `no promote marker in ${ports.promoteBoundMs} ms` };
      abortStandby(ports, abort, startedAtMs);
      return abort;
    }
    await ports.sleep(ports.pollMs);
  }
  rmSync(standbyPromotePath(ports.stateDir, ports.runId), { force: true });
  rmSync(standbyReadyPath(ports.stateDir, ports.runId), { force: true });
  return { prepareMs, waitMs: Math.max(0, ports.clock.now() - readyAtMs) };
}

/**
 * Takes the drain lock once its holder is gone. A live holder is waited out up to the bound, never reclaimed:
 * past it the standby records `daemon.standby_promote_refused` naming the holder and the caller exits non-zero.
 */
export async function acquireLockWhenFree(
  ports: StandbyPorts, acquire: () => DrainLockHandle,
): Promise<{ handle: DrainLockHandle; lockWaitMs: number } | { refused: DrainLockInfo }> {
  const startMs = ports.clock.now();
  for (;;) {
    try {
      return { handle: acquire(), lockWaitMs: Math.max(0, ports.clock.now() - startMs) };
    } catch (error) {
      if (!(error instanceof DrainLockError)) throw error;
      if (ports.clock.now() - startMs >= ports.lockWaitBoundMs) {
        ports.log("daemon.standby_promote_refused", { holder_pid: error.holder.pid, holder_host: error.holder.host,
          holder_started_at: error.holder.startedAt, lock_wait_ms: Math.max(0, ports.clock.now() - startMs) });
        return { refused: error.holder };
      }
      await ports.sleep(ports.pollMs);
    }
  }
}

/**
 * From promotion on, this process is the entrypoint's handed-off successor: on exit it leaves its code where the
 * entrypoint looks (W1-T14546). A missing file there reads as a crash, so the write is best-effort and silent.
 */
export function leaveExitCodeForEntrypoint(stateDir: string, pid: number, proc: Pick<NodeJS.Process, "once"> = process): void {
  proc.once("exit", (code: number) => {
    try {
      mkdirSync(handoffDir(stateDir), { recursive: true });
      writeFileSync(handoffExitPath(stateDir, pid), `${code}\n`);
    } catch {
      // deliberate: an exit hook cannot report; the entrypoint treats a missing file as a crash, the safe reading.
    }
  });
}

/** The promoted row: how long each part of the standby's life took, written before its loop starts. */
export function logPromoted(ports: StandbyPorts, parts: { prepareMs: number; waitMs: number; lockWaitMs: number; takeoverStartMs: number }): void {
  try {
    ports.setTitle(promotedDaemonTitle(ports.argv, ports.runId));
  } catch {
    // A title the platform refuses changes nothing about the promotion; `ps` then shows the standby argv, as before.
  }
  ports.log("daemon.standby_promoted", { sha: ports.sha ?? null, pid: ports.pid, host_pid: outermostPid(ports.readStatus()), prepare_ms: parts.prepareMs,
    promote_wait_ms: parts.waitMs, lock_wait_ms: parts.lockWaitMs, takeover_ms: Math.max(0, ports.clock.now() - parts.takeoverStartMs) });
}
