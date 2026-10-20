/**
 * The serve supervisor (arch-phase3-design.md §1(c), P3-04): the container's long-lived process,
 * which holds port 4317 and swaps serve generations behind it with no gap.
 *
 * It is the Node `cluster` primary with `SCHED_NONE`. The primary creates the listening handle once
 * and shares the SAME fd with every worker, so the kernel's one accept queue survives any generation
 * exiting. The primary never accepts a connection and is never on the data path.
 *
 * One handoff, end to end:
 *   active asks (`rmd.handoff_request`) → prepare the inactive slot → memory headroom → fork a
 *   standby → poll its `/v1/ready` and smoke-test real read routes → `rmd.promote` → it binds the
 *   shared fd and says `rmd.promoted` → `rmd.drain` the old one → `serve.handoff_done`.
 * W1-T8311: memory headroom is the container's cgroup AND a fresh host reading (MemAvailable, swap-in, PSI)
 * against the candidate's measured peak. A refusal (`serve.handoff_deferred` with a named `hold`) keeps the
 * active generation serving and retries; pressure never exits the supervisor. Unknown evidence is a hold.
 * W1-T9542: that need is the overlap a handoff measured (else the boot peak) times a margin, and the cgroup's
 * headroom is read below memory.high, where the kernel starts to reclaim and throttle.
 * A standby that fails readiness is killed and never serves (`serve.handoff_aborted`); the active
 * generation keeps serving. A promoted generation that dies is replaced from the previous slot.
 * A COLD start, or replacing the only generation after a crash, has nothing to protect, so it promotes once
 * the standby listens and serves degraded until ready (`serve.cold_start_degraded`, a bounded `serve.cold_start_still_degraded`
 * per interval while it stays so, then `serve.cold_start_ready`): gating it only kept 4317 dark.
 *
 * Kill switch: `RMD_SERVE_HANDOFF=off`, or a `handoff.off` file in the generations directory, turns a
 * handoff request back into today's behaviour: drain, exit 0, and docker restarts the container.
 */
import cluster from "node:cluster";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { systemClock, type Clock } from "./clock.js";
import { GENERATION_MESSAGES, SERVE_READY_PATH, SERVE_READY_SOCKET_ENV, SERVE_ROLE_ENV, type GenerationMessage } from "./serve-generation.js";
import { SELF_SYNC_GUARD_ENV } from "./self-sync.js";

export const SERVE_HANDOFF_ENV = "RMD_SERVE_HANDOFF";
export const HANDOFF_OFF_FILE = "handoff.off";
/** BACKSTOP on a wedged boot, about 5x the slowest boot measured (66 s); never a bound on a healthy one. */
export const STANDBY_READY_BOUND_MS = 330_000;
/** BACKSTOP: the slowest boot measured, so a healthy cold start writes no `serve.cold_start_still_degraded` row. */
export const COLD_START_STILL_DEGRADED_EVERY_MS = STANDBY_READY_BOUND_MS / 5;
/** The drain's own bound (10 s) plus the exit watchdog (5 s), with room: past it the old generation is killed. */
export const DRAIN_BACKSTOP_MS = 30_000;
/** BACKSTOP on a generation that never answers a shed request; a healthy one answers in milliseconds. */
export const SHED_BACKSTOP_MS = 10_000;
/**
 * W1-T9570: AFTER AN ANSWERED TIER-2 SHED, FREE MEMORY IS READ THIS OFTEN until it fits the need or
 * {@link SHED_SETTLE_CAP_MS} passes. A new constant, not a change to any threshold. On 2026-10-15 a 1 s sampler of
 * serve's cgroup resolved the first live answered tier-2 shed (02:25:43Z): the release came as one +1.17 GB step
 * between two reads a second apart (02:25:50Z to 02:25:51Z). Each read is three small cgroup files.
 */
export const SHED_SETTLE_READ_INTERVAL_MS = 1_000;
/**
 * W1-T9570: BACKSTOP, THE LONGEST AN ANSWERED TIER-2 SHED WAITS FOR ITS FREED MEMORY TO SHOW, before a still-short
 * reading restores the workers and defers; the primary stop is a reading that fits the need. A new constant, not a
 * change to any threshold. Measured: the 02:25:43Z shed's reply-time read was 4.30 GB against a 4.94 GB need (both
 * before W1-T9542's reader and need); the workers were restored 4 ms later, yet the cgroup read a flat or falling
 * plateau for 7 s, then +1.17 GB at +8 s. On 2026-10-14
 * read-model worker recycles first showed +0.41 to +0.85 GB at 6-8 s and up to +2.30 GB at 21-30 s. 30 s covers the
 * +8 s release and the 21-30 s samples, and bounds the degraded wait of a shed that never fits. No stability stop:
 * consecutive reads agreed within 30 MiB for the plateau's first 3 s, so "two reads agree" would judge too early.
 */
export const SHED_SETTLE_CAP_MS = 30_000;
/** W1-T8873: tier 2 (worker threads) runs at most once in this window, however many memory deferrals retry inside it. */
export const WORKER_SHED_MIN_INTERVAL_MS = 15 * 60_000;
/**
 * W1-T9542: THE SAFETY MARGIN ON A HANDOFF'S NEED, applied to the largest overlap this supervisor measured (or,
 * before one is measured, to the boot peak sampled at promotion). A new constant, not a change to any threshold.
 * Measured 2026-10-02 to 10-12 (146 serve.memory samples inside a fork-to-done window): the overlap a handoff
 * added was p50 0.86 GB, p95 1.60, max 2.37, and max/p95 is 1.48. It exceeded the standby's own boot peak in 5
 * samples, by at most 1.34x (10-06 18:45Z), because the old generation keeps allocating through the overlap.
 * 1.5 covers both ratios; the largest measured overlap, 2.37 GB, prices at 3.56 GB.
 */
export const HANDOFF_NEED_MARGIN = 1.5;
/** What a handoff's need was sized on: a measured overlap, the boot-peak fallback, or nothing (a `peak_unknown` hold). */
export type NeedBasis = "measured_overlap" | "boot_peak" | "unknown";
export const SMOKE_PATHS = ["/v1/version", "/v1/status", "/v1/views/versions"] as const;

/** The shortest gap between two handoffs: serve.ts's SERVE_HANDOFF_COALESCE_MS, the operator's 15-minute window. */
export const SERVE_HANDOFF_SPACING_BASE_MS = 15 * 60_000;
/** How fast handoff pressure fades: a handoff an hour ago weighs half of one just done. */
export const SERVE_HANDOFF_PRESSURE_HALF_LIFE_MS = 60 * 60_000;

/** Handoff pressure: each handoff adds one, and the total halves every `halfLifeMs`. */
export interface HandoffPressure {
  value: number;
  at: number;
}

export function decayedPressure(pressure: HandoffPressure | undefined, now: number, halfLifeMs: number): number {
  if (!pressure) return 0;
  return pressure.value * Math.pow(0.5, Math.max(0, now - pressure.at) / halfLifeMs);
}

/**
 * HANDOFF SPACING, A WINDOW THAT GROWS WITH RECENT HANDOFFS AND HEALS WHEN THEY STOP.
 *
 * The generation already waits {@link SERVE_HANDOFF_SPACING_BASE_MS} from its boot before it asks
 * (serve.ts SERVE_HANDOFF_COALESCE_MS), but a fleet that merges code every few minutes fills every
 * window: 2.8 handoffs an hour, each a fork, a 48 s prewarm and up to 2.27 GB of overlap. Serve
 * cannot skip them by path: its generation runs src/run-task.ts, whose import closure is 460 of the
 * 471 source files, and no src/ merge in that span touched only the other 11.
 *
 * So the gap after a handoff is `base x (1 + pressure)`, where pressure counts the handoffs done
 * and halves every {@link SERVE_HANDOFF_PRESSURE_HALF_LIFE_MS}. No cap and no cliff: a busy fleet
 * settles where the gaps balance the decay (about 1.4 an hour on the measured merges, from 2.8), and
 * a quiet one returns to the base window on its own. The deferred handoff prepares the newest main
 * when it finally runs, so every merge meanwhile rides it.
 */
export function handoffSpacingMs(pressure: number, baseMs: number): number {
  return baseMs * (1 + Math.max(0, pressure));
}

/** One forked generation, as the supervisor sees it. */
export interface GenerationProcess {
  readonly pid: number | undefined;
  send(message: GenerationMessage): void;
  onMessage(listener: (message: GenerationMessage) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  kill(signal: NodeJS.Signals): void;
}

export interface GenerationCommand {
  exec: string;
  execArgv: string[];
  args: string[];
  cwd: string;
}

/** A prepared slot: a checkout of `sha` at `dir` with its own installed `node_modules`. */
export interface PreparedSlot {
  dir: string;
  sha: string;
  deps?: string;
}

export interface ServeSupervisorOptions {
  /** The cold-start checkout (the entrypoint's synced clone) and its sha. */
  coldSlot: PreparedSlot;
  /** Prepares the slot that is NOT `activeDir` at origin's newest main; rejects on failure. */
  prepare: (activeDir: string) => Promise<PreparedSlot>;
  /** How a slot runs serve; defaults to `src/run-task.ts serve …` under the slot's own tsx. */
  command?: (slot: PreparedSlot) => GenerationCommand;
  serveArgs?: string[];
  spawn?: (command: GenerationCommand, env: Record<string, string>) => GenerationProcess;
  /** One HTTP GET over a generation's private socket. */
  get?: (socketPath: string, path: string) => Promise<{ status: number; body: string }>;
  /**
   * Bytes this container's memory cgroup can still hold once its clean page cache is reclaimed, or undefined when
   * unbounded or unreadable. W1-T9542: defaults to {@link cgroupSoftFreeMemory}, below memory.high.
   */
  freeMemory?: () => number | undefined;
  /** A generation's resident bytes now (VmRSS), or undefined when unreadable. */
  rss?: (pid: number) => number | undefined;
  /** A generation's resident high-water mark (VmHWM), or undefined when unreadable. */
  peakRss?: (pid: number) => number | undefined;
  handoffEnabled?: () => boolean;
  socketPathFor?: (generation: number) => string;
  log: (step: string, extra?: Record<string, unknown>) => void;
  exit?: (code: number) => void;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  readyBoundMs?: number;
  pollMs?: number;
  drainBackstopMs?: number;
  /** When memory is short, a handoff waits this long before it asks again; each further refusal doubles it, up to the spacing base. */
  deferMs?: number;
  /** W1-T8311: one fresh host pressure reading; defaults to /proc read twice a second apart. */
  hostPressure?: () => Promise<HostPressureReading | undefined>;
  /** W1-T8311: the host memory budget's thresholds; defaults to the active slot's plan/policy.yaml. */
  upgradeThresholds?: (activeDir: string) => ServeUpgradeThresholds | { unread: string };
  shedBackstopMs?: number;
  /** W1-T9570: the tier-2 settle reads' spacing and cap; default {@link SHED_SETTLE_READ_INTERVAL_MS} and {@link SHED_SETTLE_CAP_MS}. */
  shedSettleIntervalMs?: number;
  shedSettleCapMs?: number;
  /** W1-T9570: the container cgroup's bytes in swap, or undefined when unreadable; defaults to {@link cgroupSwapCurrent}. */
  swapMemory?: () => number | undefined;
  /** W1-T8873: the least gap between two worker-thread sheds; defaults to {@link WORKER_SHED_MIN_INTERVAL_MS}. */
  workerShedIntervalMs?: number;
  /** {@link handoffSpacingMs}'s base; absent or 0, a handoff never waits on the previous one. */
  spacingBaseMs?: number;
  spacingHalfLifeMs?: number;
}

/** W1-T9570: the free-memory reads after a tier-2 shed: the first, the one judged, how many, and what ended them. */
interface SettledFree {
  first: number | undefined;
  last: number | undefined;
  reads: number;
  settle: "fits" | "cap" | "unread" | "unanswered";
}

interface Generation {
  id: number;
  slot: PreparedSlot;
  socketPath: string;
  process: GenerationProcess;
  exited: Promise<void>;
  isAlive: () => boolean;
  /** It asked for a handoff before it was active; the ask is replayed once it is promoted. */
  asked: boolean;
  /** It dropped its caches for a handoff that has not yet replaced it. */
  shed?: boolean;
  /** W1-T8873: when it terminated its worker threads for a handoff that has not yet replaced it; absent once restored. */
  workersShedAt?: number;
}

export interface ServeSupervisor {
  start(): Promise<void>;
  requestHandoff(): Promise<void>;
  shutdown(reason: string): Promise<void>;
  /** The sha the active generation runs, for tests and the ledger. */
  activeSha(): string | undefined;
}

export function generationCommand(serveArgs: string[]): (slot: PreparedSlot) => GenerationCommand {
  return (slot) => ({
    exec: join(slot.dir, "src", "run-task.ts"),
    // --expose-gc: a shed request must be able to collect what it dropped (serve-generation.ts onShedRequest).
    execArgv: ["--expose-gc", "--import", pathToFileURL(join(slot.dir, "node_modules", "tsx", "dist", "loader.mjs")).href],
    args: serveArgs,
    cwd: slot.dir,
  });
}

/** Fork through `cluster`, so every generation listens on the primary's one shared handle. */
export function clusterSpawn(command: GenerationCommand, env: Record<string, string>): GenerationProcess {
  cluster.schedulingPolicy = cluster.SCHED_NONE;
  cluster.setupPrimary({ exec: command.exec, execArgv: command.execArgv, args: command.args, cwd: command.cwd });
  const worker = cluster.fork(env);
  return {
    pid: worker.process.pid,
    send: (message) => {
      if (worker.isConnected()) worker.send(message);
    },
    onMessage: (listener) => void worker.on("message", (message: GenerationMessage) => listener(message)),
    onExit: (listener) => void worker.on("exit", (code, signal) => listener(code, signal)),
    kill: (signal) => void worker.process.kill(signal),
  };
}

export function socketGet(socketPath: string, path: string, timeoutMs = 30_000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, agent: false, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("timeout", () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}

/**
 * cgroup v2 `memory.max` minus the bytes the kernel cannot reclaim: `memory.current` less the clean,
 * non-shmem page cache in `memory.stat` (ledger reads), which the kernel drops before it would OOM.
 * Without a readable `memory.stat` all of `memory.current` counts. Undefined when unbounded or absent.
 */
export function cgroupFreeMemory(read: (path: string) => string = (path) => readFileSync(path, "utf8"), root = "/sys/fs/cgroup"): number | undefined {
  return cgroupFree(read, root, false);
}

/**
 * W1-T9542: {@link cgroupFreeMemory} below the SOFT limit, `min(memory.high, memory.max)`: the kernel reclaims
 * and throttles at memory.high (5632 MiB of an 8 GB memory.max on 2026-10-14), so a standby booting past it
 * swaps. When memory.high reads `max` or is unreadable the ceiling is memory.max, as before. The supervisor's
 * handoff judges with this; serve.memory's free_bytes and its relief keep {@link cgroupFreeMemory}.
 */
export function cgroupSoftFreeMemory(read: (path: string) => string = (path) => readFileSync(path, "utf8"), root = "/sys/fs/cgroup"): number | undefined {
  return cgroupFree(read, root, true);
}

function cgroupFree(read: (path: string) => string, root: string, soft: boolean): number | undefined {
  let max: number;
  let current: number;
  try {
    max = Number(read(join(root, "memory.max")).trim());
    current = Number(read(join(root, "memory.current")).trim());
  } catch {
    return undefined; // no cgroup v2 here (macOS, or a host process): headroom is not measurable, so nothing defers
  }
  const high = soft ? softLimitBytes(read, root) : undefined;
  // A memory.max of `max` is NaN here: a finite memory.high is then the only ceiling.
  const ceiling = high !== undefined && !(max <= high) ? high : max;
  if (!Number.isFinite(ceiling) || !Number.isFinite(current)) return undefined;
  return ceiling - (current - reclaimableFileBytes(read, root));
}

function softLimitBytes(read: (path: string) => string, root: string): number | undefined {
  let text: string;
  try {
    text = read(join(root, "memory.high")).trim();
  } catch {
    return undefined; // no memory.high to read: memory.max stays the ceiling, the reading before W1-T9542
  }
  return /^\d+$/.test(text) ? Number(text) : undefined; // `max` is no soft limit
}

function reclaimableFileBytes(read: (path: string) => string, root: string): number {
  let stat: string;
  try {
    stat = read(join(root, "memory.stat"));
  } catch {
    return 0; // no breakdown: count every charged byte as held, the conservative reading
  }
  const field = (name: string): number => Number(new RegExp(`^${name} (\\d+)$`, "m").exec(stat)?.[1] ?? 0);
  return Math.max(0, field("file") - field("shmem") - field("file_dirty") - field("file_writeback"));
}

export function procRss(pid: number, read: (path: string) => string = (path) => readFileSync(path, "utf8"), field: "VmRSS" | "VmHWM" = "VmRSS"): number | undefined {
  try {
    const kb = new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, "m").exec(read(`/proc/${pid}/status`))?.[1];
    return kb === undefined ? undefined : Number(kb) * 1024;
  } catch {
    return undefined; // no procfs (macOS) or the process is gone: this sample simply is not taken
  }
}

/**
 * W1-T9570: cgroup v2 `memory.swap.current`, the bytes this container holds in swap. A heap page in swap is released
 * from here, not from `memory.current`, so a shed that freed swapped pages shows here. Undefined when the file is
 * absent (no swap accounting), unreadable or not a byte count: no reading, never a zero.
 */
export function cgroupSwapCurrent(read: (path: string) => string = (path) => readFileSync(path, "utf8"), root = "/sys/fs/cgroup"): number | undefined {
  let text: string;
  try {
    text = read(join(root, "memory.swap.current")).trim();
  } catch {
    return undefined; // no swap accounting here, or the file is unreadable: this field is not recorded
  }
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

/**
 * W1-T8311: ONE FRESH READING OF THE HOST'S MEMORY PRESSURE, taken before a planned upgrade forks a
 * standby. The cgroup headroom above sees only this container; the host's MemAvailable, swap-in and
 * PSI see the other containers that share its RAM. A measurement not taken is NAMED in `unread`, so
 * it is a hold and never zero pressure.
 */
export interface HostPressureReading {
  atMs: number;
  memAvailableBytes?: number;
  /** pswpin + zswpin delta over the sample window, pages per second (OPERATOR RULING 2026-10-19 (4): a swap-in
   *  served from zswap's compressed pool counts in zswpin, never pswpin). */
  swapInPagesPerSec?: number;
  /** Its parts, and how the zswap part was read: a kernel without zswap has no zswpin line, read as 0 and named. */
  swapInDiskPagesPerSec?: number;
  swapInZswapPagesPerSec?: number;
  swapInZswapBasis?: string;
  psiSomeAvg10?: number;
  psiFullAvg10?: number;
  unread: string[];
}

/** The host memory budget's existing thresholds (plan/policy.yaml sweep.hostMemoryBudget), read, never changed. */
export interface ServeUpgradeThresholds {
  hostReserveBytes: number;
  swapInPagesPerSecMax: number;
  psiSomeAvg10Max: number;
  psiFullAvg10Max: number;
  staleMs: number;
}

export type ServeUpgradeHold = "policy_unread" | "pressure_unread" | "pressure_stale" | "peak_unknown" | "swap_in" | "psi" | "host_headroom";

export type ServeUpgradeAdmission =
  | { admit: true; availableBytes: number; needBytes: number; candidatePeakBytes: number; peakBasis: string }
  | { admit: false; hold: ServeUpgradeHold; detail: string };

const MIB = 1024 * 1024;
const BUDGET_KEYS = { hostReserveMib: "hostReserveMib", swapInPagesPerSecMax: "swapInPagesPerSecMax", psiSomeAvg10Max: "psiSomeAvg10Max", psiFullAvg10Max: "psiFullAvg10Max", staleReadingMs: "staleReadingMs" } as const;

/**
 * The thresholds out of a policy.yaml text. The baked supervisor may import no YAML package (its closure is
 * cataloged in baked-runtime-inputs.ts), so this walks `sweep.hostMemoryBudget.<key>.value` by indentation;
 * test/serve-supervisor.test.ts holds it equal to host-memory-shadow.ts's validated loader on the shipped file.
 * A missing or non-numeric key is `unread`, which holds an upgrade: never a default threshold.
 */
export function serveUpgradeThresholdsFromPolicy(text: string): ServeUpgradeThresholds | { unread: string } {
  const values: Record<string, number> = {};
  let inBudget = false;
  let key: string | undefined;
  for (const line of text.split("\n")) {
    if (/^ {2}hostMemoryBudget:\s*$/.test(line)) {
      inBudget = true;
      continue;
    }
    if (!inBudget || /^\s*(#.*)?$/.test(line)) continue;
    if (!/^ {3}/.test(line)) break; // the block ended
    const keyMatch = /^ {4}(\w+):\s*$/.exec(line);
    if (keyMatch) key = keyMatch[1];
    const valueMatch = /^ {6}value:\s*(-?[0-9.]+)\s*$/.exec(line);
    if (valueMatch && key !== undefined) values[key] = Number(valueMatch[1]);
  }
  const missing = Object.values(BUDGET_KEYS).filter((k) => !Number.isFinite(values[k]));
  if (missing.length > 0) return { unread: `sweep.hostMemoryBudget ${missing.join(", ")} unread` };
  return {
    hostReserveBytes: values.hostReserveMib! * MIB,
    swapInPagesPerSecMax: values.swapInPagesPerSecMax!,
    psiSomeAvg10Max: values.psiSomeAvg10Max!,
    psiFullAvg10Max: values.psiFullAvg10Max!,
    staleMs: values.staleReadingMs!,
  };
}

/** The real thresholds: the active slot's own checkout's plan/policy.yaml. */
export function readServeUpgradeThresholds(slotDir: string, read: (path: string) => string = (path) => readFileSync(path, "utf8")): ServeUpgradeThresholds | { unread: string } {
  try {
    return serveUpgradeThresholdsFromPolicy(read(join(slotDir, "plan", "policy.yaml")));
  } catch (err) {
    // an unreadable policy is a named hold for the caller, never a default threshold
    return { unread: `plan/policy.yaml: ${errorText(err)}` };
  }
}

/**
 * Two pswpin + zswpin reads `sampleMs` apart give the swap-in rate; MemAvailable and the PSI avg10 lines are read after
 * the second. Every read that fails or does not parse is named in `unread`.
 */
export async function readHostPressure(ports: { read?: (path: string) => string; clock: Clock; sleep: (ms: number) => Promise<void>; sampleMs?: number }): Promise<HostPressureReading> {
  const read = ports.read ?? ((path: string) => readFileSync(path, "utf8"));
  const sampleMs = ports.sampleMs ?? 1_000;
  const unread: string[] = [];
  const attempt = <T>(name: string, fn: () => T | undefined): T | undefined => {
    try {
      const value = fn();
      if (value === undefined) unread.push(`${name}: no such field`);
      return value;
    } catch (err) {
      // the failure is named in `unread`, which holds the upgrade; undefined is never read as zero
      unread.push(`${name}: ${errorText(err)}`);
      return undefined;
    }
  };
  const pswpin = (): { disk: number; zswap: number; zswapBasis: string } | undefined => {
    const text = read("/proc/vmstat");
    const disk = /^pswpin\s+(\d+)/m.exec(text)?.[1];
    if (disk === undefined) return undefined;
    const zswap = /^zswpin\s+(\d+)/m.exec(text)?.[1];
    return { disk: Number(disk), zswap: Number(zswap ?? 0), zswapBasis: zswap === undefined ? "no zswpin line (zswap not compiled in): 0" : "zswpin" };
  };
  const firstAt = ports.clock.now();
  const first = attempt("/proc/vmstat pswpin", pswpin);
  await ports.sleep(sampleMs);
  const secondAt = ports.clock.now();
  const second = first === undefined ? undefined : attempt("/proc/vmstat pswpin", pswpin);
  const seconds = (secondAt - firstAt) / 1000;
  let swapIn: Pick<HostPressureReading, "swapInPagesPerSec" | "swapInDiskPagesPerSec" | "swapInZswapPagesPerSec" | "swapInZswapBasis"> = {};
  if (first !== undefined && second !== undefined) {
    if (seconds > 0) {
      const swapInDiskPagesPerSec = Math.max(0, second.disk - first.disk) / seconds;
      const swapInZswapPagesPerSec = Math.max(0, second.zswap - first.zswap) / seconds;
      swapIn = { swapInPagesPerSec: swapInDiskPagesPerSec + swapInZswapPagesPerSec, swapInDiskPagesPerSec, swapInZswapPagesPerSec,
        swapInZswapBasis: second.zswapBasis };
    } else unread.push("/proc/vmstat pswpin: no time elapsed between samples");
  }
  const memKb = attempt("/proc/meminfo MemAvailable", () => {
    const kb = /^MemAvailable:\s+(\d+)\s+kB/m.exec(read("/proc/meminfo"))?.[1];
    return kb === undefined ? undefined : Number(kb);
  });
  const psi = attempt("/proc/pressure/memory", () => {
    const text = read("/proc/pressure/memory");
    const avg10 = (kind: string): number | undefined => {
      const m = new RegExp(`^${kind} .*\\bavg10=([0-9.]+)`, "m").exec(text);
      return m ? Number(m[1]) : undefined;
    };
    const some = avg10("some");
    const full = avg10("full");
    return some === undefined || full === undefined ? undefined : { some, full };
  });
  return {
    atMs: secondAt,
    ...(memKb !== undefined ? { memAvailableBytes: memKb * 1024 } : {}),
    ...swapIn,
    ...(psi ? { psiSomeAvg10: psi.some, psiFullAvg10: psi.full } : {}),
    unread,
  };
}

/**
 * Does a planned serve upgrade fit NOW? The candidate's peak lands on top of what is resident: MemAvailable
 * already excludes the active generation (and every other container), so it is not counted twice. `freedBytes`
 * is memory the transition releases BEFORE the candidate starts (the container path stops the old console first);
 * the supervisor's overlap frees nothing. Unknown, stale or unread evidence is a named hold, never a fit.
 */
export function judgeServeUpgradeAdmission(i: {
  reading: HostPressureReading | undefined;
  thresholds: ServeUpgradeThresholds | { unread: string };
  candidatePeakBytes: number | undefined;
  peakBasis: string;
  freedBytes?: number;
  nowMs: number;
}): ServeUpgradeAdmission {
  const t = i.thresholds;
  if ("unread" in t) return { admit: false, hold: "policy_unread", detail: t.unread };
  const r = i.reading;
  if (!r) return { admit: false, hold: "pressure_unread", detail: "no host pressure reading" };
  if (r.unread.length > 0) return { admit: false, hold: "pressure_unread", detail: r.unread.join("; ") };
  if (r.memAvailableBytes === undefined || r.swapInPagesPerSec === undefined || r.psiSomeAvg10 === undefined || r.psiFullAvg10 === undefined) {
    return { admit: false, hold: "pressure_unread", detail: "a host pressure field is missing" };
  }
  const ageMs = i.nowMs - r.atMs;
  if (!(ageMs >= 0 && ageMs <= t.staleMs)) return { admit: false, hold: "pressure_stale", detail: `reading is ${ageMs} ms old (bound ${t.staleMs} ms)` };
  const peak = i.candidatePeakBytes;
  if (peak === undefined || !Number.isFinite(peak) || peak <= 0) return { admit: false, hold: "peak_unknown", detail: i.peakBasis };
  if (r.swapInPagesPerSec > t.swapInPagesPerSecMax) {
    const parts = r.swapInDiskPagesPerSec === undefined ? "" : ` (disk ${r.swapInDiskPagesPerSec.toFixed(1)} + zswap ` +
      `${(r.swapInZswapPagesPerSec ?? 0).toFixed(1)}, ${r.swapInZswapBasis ?? "zswap unread"})`;
    return { admit: false, hold: "swap_in", detail: `swap-in ${r.swapInPagesPerSec.toFixed(1)} pages/s${parts} > ${t.swapInPagesPerSecMax}` };
  }
  if (r.psiSomeAvg10 > t.psiSomeAvg10Max || r.psiFullAvg10 > t.psiFullAvg10Max) {
    return { admit: false, hold: "psi", detail: `memory PSI some avg10 ${r.psiSomeAvg10} (max ${t.psiSomeAvg10Max}), full avg10 ${r.psiFullAvg10} (max ${t.psiFullAvg10Max})` };
  }
  const needBytes = t.hostReserveBytes + Math.max(0, peak - Math.max(0, i.freedBytes ?? 0));
  if (r.memAvailableBytes < needBytes) {
    return { admit: false, hold: "host_headroom", detail: `MemAvailable ${r.memAvailableBytes} B < need ${needBytes} B (reserve ${t.hostReserveBytes} + candidate ${peak} - freed ${i.freedBytes ?? 0})` };
  }
  return { admit: true, availableBytes: r.memAvailableBytes, needBytes, candidatePeakBytes: peak, peakBasis: i.peakBasis };
}

export function handoffSwitch(env: NodeJS.ProcessEnv, gensDir: string, exists: (path: string) => boolean = existsSync): () => boolean {
  return () => env[SERVE_HANDOFF_ENV] !== "off" && !exists(join(gensDir, HANDOFF_OFF_FILE));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createServeSupervisor(opts: ServeSupervisorOptions): ServeSupervisor {
  const command = opts.command ?? generationCommand(opts.serveArgs ?? ["serve"]);
  const spawn = opts.spawn ?? clusterSpawn;
  const get = opts.get ?? socketGet;
  const freeMemory = opts.freeMemory ?? (() => cgroupSoftFreeMemory());
  const rss = opts.rss ?? ((pid: number) => procRss(pid));
  const peakRss = opts.peakRss ?? ((pid: number) => procRss(pid, undefined, "VmHWM"));
  const handoffEnabled = opts.handoffEnabled ?? (() => true);
  const socketPathFor = opts.socketPathFor ?? ((n: number) => `/tmp/rmd-serve-gen-${process.pid}-${n}.sock`);
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const clock = opts.clock ?? systemClock;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
  const readyBoundMs = opts.readyBoundMs ?? STANDBY_READY_BOUND_MS;
  const stillDegradedRows = Math.floor(readyBoundMs / COLD_START_STILL_DEGRADED_EVERY_MS);
  const pollMs = opts.pollMs ?? 500;
  const drainBackstopMs = opts.drainBackstopMs ?? DRAIN_BACKSTOP_MS;
  const deferMs = opts.deferMs ?? 60_000;
  const shedBackstopMs = opts.shedBackstopMs ?? SHED_BACKSTOP_MS;
  const workerShedIntervalMs = opts.workerShedIntervalMs ?? WORKER_SHED_MIN_INTERVAL_MS;
  const shedSettleIntervalMs = opts.shedSettleIntervalMs ?? SHED_SETTLE_READ_INTERVAL_MS;
  const shedSettleReads = 1 + Math.floor((opts.shedSettleCapMs ?? SHED_SETTLE_CAP_MS) / Math.max(1, shedSettleIntervalMs));
  const swapMemory = opts.swapMemory ?? (() => cgroupSwapCurrent());
  const spacingBaseMs = opts.spacingBaseMs ?? 0;
  const spacingHalfLifeMs = opts.spacingHalfLifeMs ?? SERVE_HANDOFF_PRESSURE_HALF_LIFE_MS;
  const hostPressure = opts.hostPressure ?? (() => readHostPressure({ clock, sleep }));
  const upgradeThresholds = opts.upgradeThresholds ?? ((dir: string) => readServeUpgradeThresholds(dir));
  /** A refused upgrade retries on the existing deferral, doubling per refusal; never later than the spacing base. */
  const retryCapMs = Math.max(deferMs, SERVE_HANDOFF_SPACING_BASE_MS);

  let next = 0;
  let active: Generation | undefined;
  let previous: PreparedSlot | undefined;
  let inFlight: Promise<void> | undefined;
  let askedAgain = false;
  let stopping = false;
  let deferrals = 0;
  let lastWorkerShedAt: number | undefined;
  let retryPending = false;
  let largestRss = 0;
  let largestRssGeneration: number | undefined;
  // W1-T9542: the largest positive overlap a completed handoff measured. Monotone: it only grows.
  let largestOverlap = 0;
  let largestOverlapGeneration: number | undefined;
  let crashes = 0;
  const failed = new Set<string>();
  let pressure: HandoffPressure | undefined;
  let lastDoneAt: number | undefined;
  let spacingPending = false;

  const fork = (slot: PreparedSlot): Generation => {
    const id = ++next;
    const socketPath = socketPathFor(id);
    const proc = spawn(command(slot), { [SERVE_ROLE_ENV]: "standby", [SERVE_READY_SOCKET_ENV]: socketPath, [SELF_SYNC_GUARD_ENV]: "1" });
    let alive = true;
    const exited = new Promise<void>((resolve) => proc.onExit(() => ((alive = false), resolve())));
    const generation: Generation = { id, slot, socketPath, process: proc, exited, isAlive: () => alive, asked: false };
    proc.onMessage((message) => {
      if (message.type !== GENERATION_MESSAGES.handoffRequest) return;
      if (generation === active) void supervisor.requestHandoff();
      else generation.asked = true;
    });
    proc.onExit((code, signal) => {
      if (generation === active && !stopping) void replaceCrashed(generation, code, signal);
    });
    opts.log("serve.generation_forked", { generation: id, sha: slot.sha, dir: slot.dir, pid: proc.pid });
    return generation;
  };

  /** Ready means `/v1/ready` answered 200 and every smoke route answered 200 at the target sha. */
  const awaitReady = async (generation: Generation, bodies: number, sample: () => void): Promise<{ ok: true } | { ok: false; criterion: string; detail?: unknown }> => {
    const deadline = clock.now() + readyBoundMs;
    let last: unknown;
    for (;;) {
      if (!generation.isAlive()) return { ok: false, criterion: "exited", detail: last };
      sample();
      const reply = await get(generation.socketPath, `${SERVE_READY_PATH}?bodies=${bodies}`).catch((err: unknown) => ({ status: 0, body: errorText(err) }));
      if (reply.status === 200) {
        const smoke = await smokeFailure(generation);
        if (!smoke) return { ok: true };
        // Readiness and the real route are separate reads: a board can become unavailable
        // between them. Wait within the SAME boot bound; never promote a 503 response.
        if ((smoke.detail as { status?: number }).status !== 503 || clock.now() >= deadline) return { ok: false, ...smoke };
        last = smoke;
        await sleep(pollMs);
        continue;
      }
      last = reply.status === 0 ? reply.body : safeJson(reply.body);
      if (clock.now() >= deadline) return { ok: false, criterion: "ready_bound", detail: last };
      await sleep(pollMs);
    }
  };

  const smokeFailure = async (generation: Generation): Promise<{ criterion: string; detail: unknown } | undefined> => {
    for (const path of SMOKE_PATHS) {
      const reply = await get(generation.socketPath, path).catch((err: unknown) => ({ status: 0, body: errorText(err) }));
      if (reply.status !== 200) return { criterion: `smoke ${path}`, detail: { status: reply.status } };
      if (path === "/v1/version" && (safeJson(reply.body) as { sha?: string } | undefined)?.sha !== generation.slot.sha) {
        return { criterion: "smoke /v1/version", detail: { sha: safeJson(reply.body), want: generation.slot.sha } };
      }
    }
    return undefined;
  };

  /** Cold start: wait only for the private socket to answer at all; its readiness verdict is reported, not gated. */
  const awaitListening = async (generation: Generation): Promise<{ criterion: string; detail?: unknown } | undefined> => {
    const deadline = clock.now() + readyBoundMs;
    for (;;) {
      if (!generation.isAlive()) return { criterion: "exited" };
      const reply = await get(generation.socketPath, `${SERVE_READY_PATH}?bodies=0`).catch((err: unknown) => ({ status: 0, body: errorText(err) }));
      if (reply.status !== 0) return undefined;
      if (clock.now() >= deadline) return { criterion: "listen_bound", detail: reply.body };
      await sleep(pollMs);
    }
  };

  /** The handoff gate's criteria a promoted cold generation does not yet meet, each with its readiness detail. */
  const coldUnmet = async (generation: Generation): Promise<UnmetCriterion[]> => {
    const ready = await get(generation.socketPath, SERVE_READY_PATH).catch((err: unknown) => ({ status: 0, body: errorText(err) }));
    if (ready.status !== 200) return unmetCriteria(ready.body);
    const smoke = await smokeFailure(generation);
    return smoke ? [{ name: smoke.criterion, detail: smoke.detail }] : [];
  };

  /**
   * A degraded cold generation is re-checked until it meets them, so the ledger says when it stopped serving 503s.
   * #8429: while it stays degraded, each interval says so with every unmet criterion's detail, never past the ready bound's worth.
   */
  const watchColdStart = async (generation: Generation, startedAt: number): Promise<void> => {
    let rows = 0;
    let dueAt = startedAt + COLD_START_STILL_DEGRADED_EVERY_MS;
    while (generation === active && generation.isAlive() && !stopping) {
      await sleep(pollMs);
      const unmet = await coldUnmet(generation);
      const now = clock.now();
      if (unmet.length === 0) return opts.log("serve.cold_start_ready", { sha: generation.slot.sha, readyMs: now - startedAt });
      if (now < dueAt || rows >= stillDegradedRows) continue;
      rows += 1;
      dueAt = now + COLD_START_STILL_DEGRADED_EVERY_MS;
      opts.log("serve.cold_start_still_degraded", { sha: generation.slot.sha, unmet: unmet.map((c) => c.name), criteria: unmet, elapsedMs: now - startedAt, row: rows });
    }
  };

  const activate = (generation: Generation): void => {
    active = generation;
    if (generation.asked) void supervisor.requestHandoff();
  };

  /** The active generation's served body count: a standby must not be thinner than what it replaces. */
  const activeBodies = async (): Promise<number> => {
    if (!active) return 0;
    const reply = await get(active.socketPath, SERVE_READY_PATH).catch((err: unknown) => ({ status: 0, body: errorText(err) }));
    const report = (safeJson(reply.body) as { criteria?: Array<{ name: string; detail?: { bodies?: number } }> } | undefined);
    return report?.criteria?.find((c) => c.name === "read_model_warm")?.detail?.bodies ?? 0;
  };

  const promote = async (generation: Generation): Promise<boolean> => {
    const promoted = new Promise<boolean>((resolve) => {
      generation.process.onMessage((message) => message.type === GENERATION_MESSAGES.promoted && resolve(true));
      void generation.exited.then(() => resolve(false));
    });
    generation.process.send({ type: GENERATION_MESSAGES.promote });
    if (!(await promoted)) return false;
    // The standby's boot peak, not its RSS at this instant: both generations are resident until the drain ends.
    const pid = generation.process.pid;
    const sample = pid === undefined ? undefined : (peakRss(pid) ?? rss(pid));
    if (sample !== undefined && Number.isFinite(sample) && sample > largestRss) {
      largestRss = sample;
      largestRssGeneration = generation.id;
    }
    return true;
  };

  const drainOld = async (generation: Generation, reason: string): Promise<number> => {
    const startedAt = clock.now();
    generation.process.send({ type: GENERATION_MESSAGES.drain, reason });
    const killed = await Promise.race([generation.exited.then(() => false), sleep(drainBackstopMs).then(() => true)]);
    if (killed) {
      opts.log("serve.drain_backstop_kill", { generation: generation.id, sha: generation.slot.sha, ms: drainBackstopMs });
      generation.process.kill("SIGKILL");
      await generation.exited;
    }
    return clock.now() - startedAt;
  };

  /** Fork, wait for readiness, promote; the caller decides what a failure means. `sample` reads the overlap at each step. */
  const bringUp = async (slot: PreparedSlot, sample: () => void): Promise<{ generation?: Generation; criterion?: string; detail?: unknown; readyMs: number }> => {
    const startedAt = clock.now();
    const bodies = await activeBodies();
    const generation = fork(slot);
    sample();
    const ready = await awaitReady(generation, bodies, sample);
    if (!ready.ok) {
      generation.process.kill("SIGKILL");
      return { criterion: ready.criterion, detail: ready.detail, readyMs: clock.now() - startedAt };
    }
    if (!(await promote(generation))) return { criterion: "promote", readyMs: clock.now() - startedAt };
    sample();
    return { generation, readyMs: clock.now() - startedAt };
  };

  /**
   * W1-T9542: the free memory one handoff's overlap took, from just before the fork until the old generation has
   * exited, read with the same reader the handoff is judged with. Overlap is the pre-fork reading less the lowest
   * in the window; with no pre-fork reading or no reading in the window there is none, never a zero.
   */
  const overlapWindow = (): { sample: () => void; result: () => { overlapPeakBytes?: number; overlapSamples: number } } => {
    const usable = (bytes: number | undefined): bytes is number => bytes !== undefined && Number.isFinite(bytes);
    const before = freeMemory();
    let lowest: number | undefined;
    let samples = 0;
    return {
      sample: () => {
        const free = freeMemory();
        if (!usable(free)) return;
        samples += 1;
        lowest = lowest === undefined ? free : Math.min(lowest, free);
      },
      result: () => ({ overlapPeakBytes: usable(before) && lowest !== undefined ? before - lowest : undefined, overlapSamples: samples }),
    };
  };

  /** Nothing is serving (a cold start, or the only generation died): promote once it listens; the gate is reported, never enforced. */
  const bringUpAlone = async (slot: PreparedSlot): Promise<{ generation?: Generation; criterion?: string; detail?: unknown; startedAt: number; readyMs: number }> => {
    const startedAt = clock.now();
    const generation = fork(slot);
    const failure = (await awaitListening(generation)) ?? ((await promote(generation)) ? undefined : { criterion: "promote" });
    if (failure) {
      generation.process.kill("SIGKILL");
      return { ...failure, startedAt, readyMs: clock.now() - startedAt };
    }
    activate(generation);
    return { generation, startedAt, readyMs: clock.now() - startedAt };
  };

  const reportAlone = async (generation: Generation, startedAt: number, readyMs: number): Promise<void> => {
    const unmet = (await coldUnmet(generation)).map((c) => c.name);
    if (unmet.length === 0) return;
    opts.log("serve.cold_start_degraded", { sha: generation.slot.sha, unmet, readyMs });
    void watchColdStart(generation, startedAt);
  };

  /** Tier 1: the active generation drops its rebuildable caches, then free memory is measured again. */
  const shedActive = async (generation: Generation, freeBefore: number): Promise<number | undefined> => {
    const reply = new Promise<GenerationMessage | undefined>((resolve) => {
      generation.process.onMessage((message) => message.type === GENERATION_MESSAGES.shed_done && resolve(message));
      void generation.exited.then(() => resolve(undefined));
      void sleep(shedBackstopMs).then(() => resolve(undefined));
    });
    generation.shed = true;
    generation.process.send({ type: GENERATION_MESSAGES.shed });
    const done = await reply;
    const freeAfter = freeMemory();
    opts.log("serve.handoff_shed", {
      generation: generation.id, answered: done !== undefined, gc: done?.gc, beforeBytes: done?.beforeBytes, afterBytes: done?.afterBytes,
      heapBeforeBytes: done?.heapBeforeBytes, heapAfterBytes: done?.heapAfterBytes, freeBefore, freeAfter, needBytes: need(generation).needBytes,
    });
    return freeAfter;
  };

  /** One reply of `type` from `generation`, or undefined if it exits or stays silent past the backstop. */
  const awaitReply = (generation: Generation, type: string): Promise<GenerationMessage | undefined> =>
    new Promise<GenerationMessage | undefined>((resolve) => {
      generation.process.onMessage((message) => message.type === type && resolve(message));
      void generation.exited.then(() => resolve(undefined));
      void sleep(shedBackstopMs).then(() => resolve(undefined));
    });

  /**
   * W1-T8873, tier 2: tier 1 frees only the main heap, while the active generation's rebuildable worker threads hold
   * most of its resident bytes. A handoff already deferred for memory asks it to terminate them; it keeps answering
   * from the bodies it holds. Free memory is measured again; {@link restoreWorkers} ends the degraded mode.
   * W1-T9570: a thread's exit does not return its heap to the cgroup at once, so an answered shed reads free memory
   * until it is no longer `short` or the cap passes ({@link settleFree}); the row keeps the first reading and swap.
   */
  const shedWorkers = async (generation: Generation, freeBefore: number, short: (bytes: number | undefined) => boolean): Promise<number | undefined> => {
    const startedAt = clock.now();
    lastWorkerShedAt = startedAt;
    generation.workersShedAt = startedAt;
    const swapBefore = swapMemory();
    const reply = awaitReply(generation, GENERATION_MESSAGES.shed_workers_done);
    generation.process.send({ type: GENERATION_MESSAGES.shed_workers });
    const done = await reply;
    const settleStartedAt = clock.now();
    // A generation that never answered already spent the backstop: one reading, as before W1-T9570.
    const settled = done === undefined ? unanswered(freeMemory()) : await settleFree(short);
    const freeAfter = settled.last;
    const swapAfter = swapMemory();
    const before = done?.beforeBytes;
    const after = done?.afterBytes;
    opts.log("serve.handoff_shed", {
      tier: 2, phase: "shed", generation: generation.id, answered: done !== undefined, workers: done?.workers, workerHeapBytes: done?.heapBytes, error: done?.error,
      beforeBytes: before, afterBytes: after, freedBytes: typeof before === "number" && typeof after === "number" ? Math.max(0, before - after) : undefined,
      freeBefore, freeAfter, freeAfterFirst: settled.first, freeReads: settled.reads, settle: settled.settle, settleMs: clock.now() - settleStartedAt,
      ...(swapBefore === undefined ? {} : { swapBefore }), ...(swapAfter === undefined ? {} : { swapAfter }),
      needBytes: need(generation).needBytes, durationMs: clock.now() - startedAt,
    });
    return freeAfter;
  };

  /** W1-T9570: the one reading taken after a tier-2 request that was never answered. */
  const unanswered = (free: number | undefined): SettledFree => ({ first: free, last: free, reads: 1, settle: "unanswered" });

  /**
   * W1-T9570: free memory read every {@link SHED_SETTLE_READ_INTERVAL_MS} until the reading is not `short` (it fits,
   * or it is unreadable and judges nothing, as before) or the cap's reads are spent. `settle` names which ended it.
   */
  const settleFree = async (short: (bytes: number | undefined) => boolean): Promise<SettledFree> => {
    const first = freeMemory();
    let last = first;
    let reads = 1;
    while (short(last) && reads < shedSettleReads) {
      await sleep(shedSettleIntervalMs);
      last = freeMemory();
      reads += 1;
    }
    return { first, last, reads, settle: last === undefined ? "unread" : short(last) ? "cap" : "fits" };
  };

  /** Ends tier 2's degraded mode on the active generation: its worker threads start again. A no-op when none was shed. */
  const restoreWorkers = async (reason: string): Promise<void> => {
    const generation = active;
    const shedAt = generation?.workersShedAt;
    if (generation === undefined || shedAt === undefined) return;
    generation.workersShedAt = undefined;
    if (stopping || !generation.isAlive()) return;
    const reply = awaitReply(generation, GENERATION_MESSAGES.restore_workers_done);
    generation.process.send({ type: GENERATION_MESSAGES.restore_workers, reason });
    const done = await reply;
    opts.log("serve.handoff_shed", { tier: 2, phase: "restored", generation: generation.id, reason, answered: done !== undefined, error: done?.error, degradedMs: clock.now() - shedAt });
  };

  /**
   * What a standby needs ({@link candidateNeed}), with the evidence beside it. The active generation's resident bytes
   * and lifetime high-water mark are ledgered, never added: GC swings its RSS over 1 GB in 10 s, and its lifetime
   * peak includes its own growth after the generation before it exited.
   */
  const need = (generation: Generation): { needBytes?: number; needBasis: NeedBasis; needMargin: number; overlapPeakBytes?: number; bootPeakBytes?: number; activeRssBytes?: number; activePeakBytes?: number } => {
    const pid = generation.process.pid;
    const candidate = candidateNeed();
    return {
      needBytes: candidate.bytes, needBasis: candidate.basis, needMargin: HANDOFF_NEED_MARGIN, overlapPeakBytes: largestOverlap || undefined, bootPeakBytes: largestRss || undefined,
      activeRssBytes: pid === undefined ? undefined : rss(pid), activePeakBytes: pid === undefined ? undefined : peakRss(pid),
    };
  };

  /**
   * W1-T9542: what a planned handoff needs is what its OVERLAP takes, both generations resident from fork until
   * the old one exits: the largest overlap this supervisor measured, times {@link HANDOFF_NEED_MARGIN}. Before
   * one is measured, the largest boot peak a generation reached (sampled at its promotion, a cold start's too)
   * times the same margin. Neither is UNKNOWN, never a zero-sized candidate. This supersedes W1-T8378's pricing by
   * the active generation's lifetime high-water mark (5.31 GB on 10-14 against a measured overlap p95 of 1.60 GB).
   */
  const candidateNeed = (): { bytes?: number; basis: NeedBasis; detail: string } => {
    if (largestOverlap > 0) {
      return { bytes: Math.ceil(largestOverlap * HANDOFF_NEED_MARGIN), basis: "measured_overlap", detail: `largest measured overlap ${largestOverlap} B (the handoff to generation ${largestOverlapGeneration}) x ${HANDOFF_NEED_MARGIN}` };
    }
    if (largestRss > 0) {
      return { bytes: Math.ceil(largestRss * HANDOFF_NEED_MARGIN), basis: "boot_peak", detail: `generation ${largestRssGeneration} boot peak ${largestRss} B (sampled at promotion) x ${HANDOFF_NEED_MARGIN}; no overlap measured yet` };
    }
    return { basis: "unknown", detail: "no handoff overlap was measured and no generation's boot peak was readable" };
  };

  /** Is the kept generation positively healthy: alive, with its readiness answering 200? */
  const answering = async (generation: Generation): Promise<boolean> => {
    if (!generation.isAlive()) return false;
    const reply = await get(generation.socketPath, SERVE_READY_PATH).catch((err: unknown) => ({ status: 0, body: errorText(err) }));
    return reply.status === 200;
  };

  /**
   * W1-T8311: a memory refusal keeps the active generation. No standby is forked and the supervisor never exits
   * for pressure: the retry re-runs the whole handoff, so `prepare` targets the newest main and an obsolete
   * candidate is superseded. No lock is held while it waits; `preserved` is reported only for a generation that
   * positively answers its readiness.
   */
  const deferUpgrade = async (from: Generation, slot: PreparedSlot, extra: Record<string, unknown>): Promise<void> => {
    deferrals += 1;
    const retryMs = Math.min(retryCapMs, deferMs * 2 ** Math.min(deferrals - 1, 20));
    const preserved = await answering(from);
    opts.log("serve.handoff_deferred", { reason: "memory", ...extra, ...need(from), deferrals, retryMs, sha: slot.sha, activeSha: from.slot.sha, preserved });
    retryPending = true;
    void sleep(retryMs).then(() => {
      retryPending = false;
      return supervisor.requestHandoff();
    });
  };

  const legacyExit = async (reason: string): Promise<void> => {
    opts.log("serve.handoff_legacy_exit", { reason, sha: active?.slot.sha });
    await supervisor.shutdown(reason);
  };

  /** True when this ask must wait out the spacing; the wait re-asks once, however many asks arrive meanwhile. */
  const awaitSpacing = (from: Generation): boolean => {
    if (spacingBaseMs <= 0 || lastDoneAt === undefined) return false;
    const now = clock.now();
    const level = decayedPressure(pressure, now, spacingHalfLifeMs);
    const spacingMs = handoffSpacingMs(level, spacingBaseMs);
    const waitMs = lastDoneAt + spacingMs - now;
    if (waitMs <= 0) return false;
    if (spacingPending) return true;
    spacingPending = true;
    opts.log("serve.handoff_deferred", { reason: "spacing", waitMs, spacingMs, pressure: Number(level.toFixed(3)), sinceLastMs: now - lastDoneAt, sha: from.slot.sha });
    void sleep(waitMs).then(() => {
      spacingPending = false;
      return supervisor.requestHandoff();
    });
    return true;
  };

  const handoff = async (): Promise<void> => {
    if (!handoffEnabled()) return legacyExit("handoff_off");
    const from = active;
    if (!from) return;
    if (awaitSpacing(from)) return;
    const startedAt = clock.now();
    let slot: PreparedSlot;
    try {
      slot = await opts.prepare(from.slot.dir);
    } catch (err) {
      opts.log("serve.handoff_aborted", { criterion: "prepare", reason: errorText(err), fromSha: from.slot.sha });
      return;
    }
    const prepMs = clock.now() - startedAt;
    if (slot.sha === from.slot.sha || failed.has(slot.sha)) {
      opts.log("serve.handoff_skipped", { sha: slot.sha, reason: slot.sha === from.slot.sha ? "already_serving" : "failed_before" });
      return;
    }
    const peak = candidateNeed();
    if (peak.bytes === undefined) return deferUpgrade(from, slot, { hold: "peak_unknown", detail: peak.detail });
    const peakBytes = peak.bytes;
    const admissionNow = async (): Promise<ServeUpgradeAdmission> => {
      const reading = await hostPressure().catch((err: unknown): undefined => {
        opts.log("serve.host_pressure_unread", { reason: errorText(err) });
        return undefined;
      });
      return judgeServeUpgradeAdmission({ reading, thresholds: upgradeThresholds(from.slot.dir), candidatePeakBytes: peakBytes, peakBasis: peak.detail, nowMs: clock.now() });
    };
    const short = (bytes: number | undefined): bytes is number => bytes !== undefined && bytes < peakBytes;
    let free = freeMemory();
    if (short(free)) {
      // Shedding and rewarming the live workers itself faults pages back in. Do not create that
      // churn when the host already refuses the fork; keep the same guard and check it again below.
      const beforeShed = await admissionNow();
      // Dropping caches can recover host headroom; only the final read judges that recoverable hold.
      if (!beforeShed.admit && beforeShed.hold !== "host_headroom") return deferUpgrade(from, slot, { hold: beforeShed.hold, detail: beforeShed.detail, freeBytes: free, phase: "before_shed" });
      free = await shedActive(from, free);
    }
    // Tier 2 only once an earlier attempt was deferred for memory, and at most once per interval.
    if (short(free) && deferrals > 0 && (lastWorkerShedAt === undefined || clock.now() - lastWorkerShedAt >= workerShedIntervalMs)) {
      free = await shedWorkers(from, free ?? 0, short);
      // Still short: the workers come back before the deferral, so the generation is not left degraded for nothing.
      if (short(free)) await restoreWorkers("still_short");
    }
    if (short(free)) return deferUpgrade(from, slot, { hold: "container_headroom", freeBytes: free });
    // W1-T8311: the cgroup sees only this container; the host's other containers share the same RAM.
    const admission = await admissionNow();
    if (!admission.admit) return deferUpgrade(from, slot, { hold: admission.hold, detail: admission.detail, freeBytes: free });
    // needBytes here is the host's need (reserve + candidate); the candidate's own is candidateNeedBytes.
    const { needBytes: candidateNeedBytes, ...evidence } = need(from);
    opts.log("serve.handoff_admitted", { sha: slot.sha, availableBytes: admission.availableBytes, needBytes: admission.needBytes, peakBasis: admission.peakBasis, candidateNeedBytes, ...evidence, freeBytes: free, deferrals });
    deferrals = 0;
    const overlap = overlapWindow();
    const up = await bringUp(slot, overlap.sample);
    if (!up.generation) {
      failed.add(slot.sha);
      opts.log("serve.handoff_aborted", { sha: slot.sha, fromSha: from.slot.sha, criterion: up.criterion, detail: up.detail, readyMs: up.readyMs });
      return;
    }
    previous = from.slot;
    activate(up.generation);
    crashes = 0;
    const drainMs = await drainOld(from, "handoff");
    overlap.sample();
    const measured = overlap.result();
    if (measured.overlapPeakBytes !== undefined && measured.overlapPeakBytes > largestOverlap) {
      largestOverlap = measured.overlapPeakBytes;
      largestOverlapGeneration = up.generation.id;
    }
    lastDoneAt = clock.now();
    pressure = { value: decayedPressure(pressure, lastDoneAt, spacingHalfLifeMs) + 1, at: lastDoneAt };
    opts.log("serve.handoff_done", {
      fromSha: from.slot.sha, toSha: slot.sha, deps: slot.deps, prepMs, readyMs: up.readyMs, drainMs, peakBytes: largestRss || undefined, pressure: Number(pressure.value.toFixed(3)),
      overlapPeakBytes: measured.overlapPeakBytes, overlapSamples: measured.overlapSamples,
      ...(from.workersShedAt === undefined ? {} : { workersShedMs: lastDoneAt - from.workersShedAt }),
    });
  };

  /** A promoted generation died on its own: replace it, from the previous slot when it is a different build. */
  const replaceCrashed = async (dead: Generation, code: number | null, signal: string | null): Promise<void> => {
    active = undefined;
    if (inFlight) await inFlight;
    if (active) return;
    crashes += 1;
    const rollback = previous !== undefined && previous.sha !== dead.slot.sha;
    const slot = rollback && previous ? previous : dead.slot;
    if (rollback) failed.add(dead.slot.sha);
    opts.log(rollback ? "serve.handoff_rolled_back" : "serve.generation_crashed", { sha: dead.slot.sha, toSha: slot.sha, code, signal, crashes });
    // Self-healing back-off: a build that dies at once must not become a fork loop.
    await sleep(Math.min(60_000, 1_000 * 2 ** (crashes - 1)));
    const up = await bringUpAlone(slot);
    if (up.generation) {
      previous = undefined;
      return reportAlone(up.generation, up.startedAt, up.readyMs);
    }
    opts.log("serve.generation_restart_failed", { sha: slot.sha, criterion: up.criterion });
    await legacyExit("restart_failed");
  };

  /**
   * A shed buys headroom for ONE standby fork. While a memory deferral will retry, re-warming would be
   * shed again, so the generation stays cold; once the handoff replaced it there is nothing to restore.
   * Only a handoff that ENDED with the shed generation still serving leaves it cold for no fork, and it
   * re-warms now instead of on its 15-minute refresh schedule.
   */
  const restoreShed = (): void => {
    const generation = active;
    if (stopping || retryPending || generation === undefined || generation.shed !== true || !generation.isAlive()) return;
    generation.shed = false;
    opts.log("serve.shed_restore", { generation: generation.id, freeBytes: freeMemory(), needBytes: largestRss });
    generation.process.send({ type: GENERATION_MESSAGES.restore, reason: "handoff_abandoned" });
  };

  const supervisor: ServeSupervisor = {
    activeSha: () => active?.slot.sha,
    start: async () => {
      const up = await bringUpAlone(opts.coldSlot);
      if (!up.generation) {
        opts.log("serve.cold_start_failed", { sha: opts.coldSlot.sha, criterion: up.criterion, detail: up.detail });
        exit(1);
        return;
      }
      opts.log("serve.supervisor_ready", { sha: opts.coldSlot.sha, readyMs: up.readyMs });
      await reportAlone(up.generation, up.startedAt, up.readyMs);
    },
    requestHandoff: () => {
      if (stopping) return Promise.resolve();
      if (inFlight) {
        askedAgain = true;
        return inFlight;
      }
      // A memory refusal owns one retry. An external/coalesced ask must not skip its backoff and
      // prepare/shed/restore again; that retry prepares the newest main when it actually wakes.
      if (retryPending && handoffEnabled()) return Promise.resolve();
      inFlight = handoff()
        .catch((err: unknown) => opts.log("serve.handoff_failed", { reason: errorText(err) }))
        // Whatever ended the handoff without replacing the generation, its worker threads come back.
        .then(() => restoreWorkers("handoff_abandoned"))
        .finally(() => {
          inFlight = undefined;
          if (askedAgain) {
            askedAgain = false;
            void supervisor.requestHandoff();
          } else restoreShed();
        });
      return inFlight;
    },
    shutdown: async (reason) => {
      if (stopping) return;
      stopping = true;
      const generation = active;
      if (generation) await drainOld(generation, reason);
      exit(0);
    },
  };
  return supervisor;
}

interface UnmetCriterion {
  name: string;
  detail?: unknown;
}

function unmetCriteria(body: string): UnmetCriterion[] {
  const report = safeJson(body) as { criteria?: Array<{ name: string; ok: boolean; detail?: unknown }> } | undefined;
  const unmet = Array.isArray(report?.criteria) ? report.criteria.filter((c) => !c.ok).map(({ name, detail }) => ({ name, detail })) : [];
  return unmet.length > 0 ? unmet : [{ name: "ready", detail: report }];
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text; // not JSON: the raw text is the most useful thing to ledger
  }
}
