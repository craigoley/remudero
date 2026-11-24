// src/lib/daemon-handoff.ts — W1-T14545: the active half of a blue-green daemon restart.
//
// With `state/daemon-handoff.on` present, a freshness restart prepares the inactive daemon slot
// (`state/daemon-slots/a|b`, the serve slot preparer), checks memory headroom for one more daemon at this
// process's measured peak, and spawns `rmd daemon --standby` from that slot (W1-T14544). When the standby says it
// is ready, the active daemon finishes its restart drain, writes the successor pid file the entrypoint watches
// (W1-T14546) and the promote marker, and exits 79.
// INVARIANT single-writer: the promote marker is written only after the drain, and the standby takes
// `state/drain.lock` only once this process has let go of it. Any unmet criterion keeps today's freshness exit.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Clock, systemClock } from "./clock.js";
import { handoffDir, STANDBY_READY_BOUND_MS, standbyDir, standbyPromotePath, standbyReadyPath } from "./daemon-standby.js";

/** The switch: a handoff is attempted only while this file exists. Default off. */
export const handoffSwitchPath = (stateDir: string): string => join(stateDir, "daemon-handoff.on");
/** `<pid> <runId>`: the successor the entrypoint watches after exit 79 (deploy/entrypoint-supervise.sh). */
export const successorPidPath = (stateDir: string): string => join(handoffDir(stateDir), "successor.pid");
/** KEY=value lines naming both sides of the last handoff, for the entrypoint's rollback (W1-T14547). */
export const handoffRecordPath = (stateDir: string): string => join(handoffDir(stateDir), "record.env");
export const daemonSlotsDir = (stateDir: string): string => join(stateDir, "daemon-slots");
/** Free memory a handoff leaves beyond the standby's measured peak, for the active daemon's own growth. */
export const HANDOFF_HEADROOM_MARGIN_BYTES = 1024 ** 3;
export const HANDOFF_READY_POLL_MS = 1_000;

type Log = (step: string, extra?: Record<string, unknown>) => void;

/**
 * A prepared daemon slot: a worktree at the new sha. The shape of serve's `PreparedSlot`, declared here because this
 * module imports nothing from the serve modules: they sit in the daemon's import cycle, which this module stays out of.
 */
export interface HandoffSlot { readonly dir: string; readonly sha: string; readonly deps?: string }

/** Memory this daemon could still use, and where the number came from; `undefined` when nothing was readable. */
export interface Headroom { readonly availableBytes: number | undefined; readonly source: string }

/** A running standby process, as far as the handoff needs it. */
export interface StandbyProcess {
  readonly pid: number | undefined;
  /** The exit code (or signal name) once the process has ended; undefined while it runs. */
  exited(): number | string | undefined;
  kill(): void;
}

export interface HandoffPorts {
  readonly stateDir: string;
  readonly log: Log;
  readonly clock: Clock;
  readonly sleep: (ms: number) => Promise<void>;
  readonly switchOn: () => boolean;
  /** The code tree this daemon runs from; the slot preparer picks the slot that is not it. */
  readonly activeDir: string;
  /** The sha this daemon booted on, for the handoff record; undefined when it could not be read. */
  readonly activeSha: string | undefined;
  readonly prepareSlot: (activeDir: string) => Promise<HandoffSlot>;
  readonly headroom: () => Headroom;
  readonly peakBytes: () => number;
  readonly spawnStandby: (slot: HandoffSlot, runId: string) => StandbyProcess;
  readonly newRunId: () => string;
  readonly readyBoundMs: number;
  readonly pollMs: number;
}

export type HandoffCriterion = "headroom" | "slot" | "spawn" | "standby_exited" | "ready_timeout";

/** A started handoff: the standby runs; the caller asks whether it became ready, then yields or aborts. */
export interface HandoffAttempt {
  readonly runId: string;
  readonly pid: number | undefined;
  readonly slot: HandoffSlot;
  /** Resolves true once the standby wrote its ready marker; false (and aborted, logged, killed) otherwise. */
  ready(): Promise<boolean>;
  /** Writes the successor pid file and the promote marker. The caller exits 79 right after. */
  yieldTo(childrenLeftRunning: readonly string[]): void;
  /** Kills the standby and logs daemon.handoff_aborted; the caller takes today's freshness exit. */
  abort(criterion: HandoffCriterion, detail: string): void;
}

/** What `runDaemon` holds: whether the switch is on, and how to start one handoff. */
export interface DaemonHandoff {
  enabled(): boolean;
  /** Never rejects: a refused criterion is logged as daemon.handoff_aborted and resolves undefined. */
  begin(newSha: string): Promise<HandoffAttempt | undefined>;
}

const reason = (error: unknown): string => String((error as Error)?.message ?? error).slice(0, 400);

function writeAtomic(path: string, text: string): void {
  const staged = `${path}.${process.pid}.tmp`;
  writeFileSync(staged, text);
  renameSync(staged, path);
}

export function daemonHandoff(ports: HandoffPorts): DaemonHandoff {
  const aborted = (criterion: HandoffCriterion, detail: string, extra: Record<string, unknown> = {}): undefined => {
    ports.log("daemon.handoff_aborted", { criterion, detail: detail.slice(0, 400), ...extra });
    return undefined;
  };
  return {
    enabled: () => ports.switchOn(),
    begin: async (newSha) => {
      const startedAtMs = ports.clock.now();
      let peak: number;
      let room: Headroom;
      try {
        peak = ports.peakBytes();
        room = ports.headroom();
      } catch (error) {
        return aborted("headroom", `memory unreadable: ${reason(error)}`, { sha: newSha });
      }
      const headroom = { available_bytes: room.availableBytes ?? null, source: room.source, peak_bytes: peak,
        margin_bytes: HANDOFF_HEADROOM_MARGIN_BYTES };
      if (room.availableBytes === undefined || room.availableBytes < peak + HANDOFF_HEADROOM_MARGIN_BYTES) {
        return aborted("headroom", room.availableBytes === undefined ? `no memory reading (${room.source})`
          : `${room.availableBytes} bytes free, the standby needs ${peak + HANDOFF_HEADROOM_MARGIN_BYTES}`, { sha: newSha, headroom });
      }
      let slot: HandoffSlot;
      try {
        slot = await ports.prepareSlot(ports.activeDir);
      } catch (error) {
        // recorded: aborted() logs daemon.handoff_aborted with this reason, and the old daemon keeps running.
        return aborted("slot", reason(error), { sha: newSha, headroom });
      }
      const runId = ports.newRunId();
      let standby: StandbyProcess;
      try {
        standby = ports.spawnStandby(slot, runId);
      } catch (error) {
        // recorded: aborted() logs daemon.handoff_aborted with this reason, and the old daemon keeps running.
        return aborted("spawn", reason(error), { sha: slot.sha, slot: slot.dir, headroom });
      }
      ports.log("daemon.handoff_requested", { sha: slot.sha, decided_sha: newSha, slot: slot.dir, slot_deps: slot.deps ?? null,
        standby_run_id: runId, standby_pid: standby.pid ?? null, headroom, prepare_ms: Math.max(0, ports.clock.now() - startedAtMs) });
      const spawnedAtMs = ports.clock.now();
      let done = false;
      const attempt: HandoffAttempt = {
        runId, pid: standby.pid, slot,
        ready: async () => {
          for (;;) {
            if (existsSync(standbyReadyPath(ports.stateDir, runId))) return true;
            const code = standby.exited();
            if (code !== undefined) { attempt.abort("standby_exited", `the standby exited ${code} before it was ready`); return false; }
            if (ports.clock.now() - spawnedAtMs > ports.readyBoundMs) {
              attempt.abort("ready_timeout", `no ready marker in ${ports.readyBoundMs} ms`);
              return false;
            }
            await ports.sleep(ports.pollMs);
          }
        },
        yieldTo: (childrenLeftRunning) => {
          if (done) return;
          done = true;
          mkdirSync(handoffDir(ports.stateDir), { recursive: true });
          writeAtomic(handoffRecordPath(ports.stateDir), [`predecessor_sha=${ports.activeSha ?? ""}`, `predecessor_tree=${ports.activeDir}`,
            `successor_sha=${slot.sha}`, `successor_tree=${slot.dir}`, `successor_run_id=${runId}`, `yielded_at_ms=${ports.clock.now()}`].join("\n") + "\n");
          writeAtomic(successorPidPath(ports.stateDir), `${standby.pid} ${runId}\n`);
          mkdirSync(standbyDir(ports.stateDir), { recursive: true });
          writeFileSync(standbyPromotePath(ports.stateDir, runId), "");
          ports.log("daemon.handoff_yielded", { sha: slot.sha, slot: slot.dir, standby_run_id: runId, standby_pid: standby.pid ?? null,
            children_left_running: [...childrenLeftRunning], since_request_ms: Math.max(0, ports.clock.now() - startedAtMs) });
        },
        abort: (criterion, detail) => {
          if (done) return;
          done = true;
          try {
            if (standby.exited() === undefined) standby.kill();
          } catch (error) {
            detail = `${detail}; kill failed: ${reason(error)}`;
          }
          aborted(criterion, detail, { sha: slot.sha, slot: slot.dir, standby_run_id: runId, standby_pid: standby.pid ?? null });
        },
      };
      return attempt;
    },
  };
}

/** cgroup v2's limit less its usage, and /proc/meminfo's MemAvailable; the smaller of what could be read. */
export function readHeadroom(read: (path: string) => string = (path) => readFileSync(path, "utf8")): Headroom {
  const readings: { bytes: number; source: string }[] = [];
  try {
    const max = read("/sys/fs/cgroup/memory.max").trim();
    const current = Number(read("/sys/fs/cgroup/memory.current").trim());
    if (/^\d+$/.test(max) && Number.isFinite(current)) readings.push({ bytes: Number(max) - current, source: "cgroup" });
  } catch {
    // deliberate: no cgroup v2 files (a bare host) is no cgroup reading; meminfo below still answers.
  }
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(read("/proc/meminfo"));
    if (match) readings.push({ bytes: Number(match[1]) * 1024, source: "meminfo" });
  } catch {
    // deliberate: no meminfo (not Linux); with no cgroup reading either, the handoff refuses as "no memory reading".
  }
  if (readings.length === 0) return { availableBytes: undefined, source: "unreadable" };
  const least = readings.reduce((a, b) => (b.bytes < a.bytes ? b : a));
  return { availableBytes: least.bytes, source: least.source };
}

/** `rmd daemon --standby <the active daemon's own arguments>` from the slot, detached so it outlives this process. */
export function spawnStandbyDaemon(stateDir: string, daemonArgs: readonly string[], env: NodeJS.ProcessEnv = process.env):
  (slot: HandoffSlot, runId: string) => StandbyProcess {
  return (slot, runId) => {
    mkdirSync(standbyDir(stateDir), { recursive: true });
    const out = openSync(join(standbyDir(stateDir), `${runId}.log`), "a");
    let child: ChildProcess;
    try {
      child = spawn(join(slot.dir, "bin", "rmd"), ["daemon", "--standby", ...daemonArgs.filter((arg) => arg !== "--standby")], {
        cwd: slot.dir, detached: true, stdio: ["ignore", out, out], env: { ...env, REMUDERO_RUN_ID: runId },
      });
    } finally {
      closeSync(out);
    }
    let exit: number | string | undefined;
    child.on("exit", (code, signal) => { exit = code ?? signal ?? "unknown"; });
    child.on("error", (error) => { exit = `spawn error: ${reason(error)}`; });
    child.unref();
    return { pid: child.pid, exited: () => exit, kill: () => { child.kill("SIGTERM"); } };
  };
}

/** The real handoff for `rmd daemon`: the switch file, the slot pair beside serve's, and this process's peak RSS. */
export function createDaemonHandoff(opts: { stateDir: string; activeDir: string; activeSha: string | undefined;
  daemonArgs: readonly string[]; log: Log;
  /** The slot preparer over {@link daemonSlotsDir}; the CLI builds it with serve's createSlotPreparer. */
  prepareSlot: (activeDir: string) => Promise<HandoffSlot> }): DaemonHandoff {
  return daemonHandoff({
    stateDir: opts.stateDir, log: opts.log, clock: systemClock,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    switchOn: () => existsSync(handoffSwitchPath(opts.stateDir)),
    activeDir: opts.activeDir, activeSha: opts.activeSha,
    prepareSlot: opts.prepareSlot,
    headroom: () => readHeadroom(),
    peakBytes: () => process.resourceUsage().maxRSS * 1024,
    spawnStandby: spawnStandbyDaemon(opts.stateDir, opts.daemonArgs),
    newRunId: () => `DAEMON-${systemClock.now()}`,
    readyBoundMs: STANDBY_READY_BOUND_MS, pollMs: HANDOFF_READY_POLL_MS,
  });
}
