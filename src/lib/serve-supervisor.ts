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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { systemClock, type Clock } from "./clock.js";
import type { GithubHookListenerHandle } from "./github-hook-listener.js";
import type { ServeOnlyVerdict } from "./serve-own-code.js";
import { GENERATION_MESSAGES, SERVE_READY_PATH, SERVE_READY_SOCKET_ENV, SERVE_ROLE_ENV, isGithubHookConfig, type GenerationMessage, type GithubHookConfig, type SwapProbeTrigger } from "./serve-generation.js";
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

/**
 * W1-T13276: the supervisor GETs SMOKE_PATHS[0] on the generation that is serving every minute. OBSERVED 2026-11-16: a
 * generation listened, kept writing background rows and answered no HTTP request for 40 minutes (455 connections in the
 * accept queue, 444 in CLOSE_WAIT) until a manual restart. INVARIANT a-slow-answer-is-not-a-wedge: only an UNANSWERED
 * probe counts, a timeout or a refused connection; any HTTP status (200, 401, 503) inside the bound is alive.
 */
export const ACTIVE_PROBE_INTERVAL_MS = 60_000;
/** PRIMARY CONTROL: how long one probe waits for any HTTP answer before it counts as unanswered. */
export const ACTIVE_PROBE_TIMEOUT_MS = 10_000;
/** Consecutive unanswered probes that make a wedge: three minutes of silence, not one dropped packet. */
export const ACTIVE_PROBE_FAILURES = 3;
/** BACKSTOP: a second wedge inside this long is recorded and held, never restarted, so a build that wedges at boot cannot loop. */
export const ACTIVE_WEDGE_RESTART_FLOOR_MS = 15 * 60_000;
/** The port the post-mortem socket census reads when the supervisor is not told another. */
export const ACTIVE_WEDGE_SERVE_PORT = 4317;
/**
 * W1-T13503: THE PROBE GOES WHERE THE TUNNEL GOES, the serve port over TCP, never the generation's private socket. The
 * 2026-11-16 wedge left the generation's loop healthy (runtime.loop_lag p99 60-97 ms, background rows still written)
 * while 455 connections sat unaccepted on 4317: the private socket has its own listener and would have answered.
 * The path is unrouted on purpose: serve answers it 404 before any credential check, so the probe carries no token and
 * writes no `service.unauthorized` row. Any status is an answer (a-slow-answer-is-not-a-wedge).
 */
export const ACTIVE_PROBE_PUBLIC_PATH = "/v1/supervisor-probe";
/** W1-T13503: what the generation's private socket said when the public port went unanswered. */
type PrivateProbeAnswer = { answered: true; status: number } | { answered: false; error: string };
/** BACKSTOP (W1-T13503): the private-socket comparison on a wedge row waits at most this long, so a restart is never held up by it; a healthy socket answers in milliseconds. */
export const ACTIVE_PRIVATE_PROBE_TIMEOUT_MS = 2_000;

/** W1-T13503: the port serve's own arguments bind (`--port N`), or {@link ACTIVE_WEDGE_SERVE_PORT}. */
export function servePortOf(serveArgs: readonly string[] | undefined, fallback = ACTIVE_WEDGE_SERVE_PORT): number {
  const at = serveArgs?.indexOf("--port") ?? -1;
  const port = at >= 0 ? Number(serveArgs?.[at + 1]) : Number.NaN;
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : fallback;
}

/** W1-T13277: the host serve's own arguments bind (`--host H`); absent, every interface, as node's listen does. */
export function serveHostOf(serveArgs: readonly string[] | undefined): string | undefined {
  const at = serveArgs?.indexOf("--host") ?? -1;
  const host = at >= 0 ? serveArgs?.[at + 1] : undefined;
  return host && !host.startsWith("--") ? host : undefined;
}

/** W1-T13277: what serve's port answers while no generation holds it: why, since when, and how long a boot last took. */
export interface RestartingState {
  state: "starting" | "restarting";
  since: string;
  reason: "boot" | "restart" | "wedge";
  /** The last measured time from fork to promotion; null before any boot has been measured. */
  expectedReadyMs: number | null;
}

/** W1-T13277: the Retry-After a restarting answer gives before any boot has been measured. */
export const RESTARTING_RETRY_AFTER_DEFAULT_S = 5;

/** W1-T13277: seconds until the expected promotion, at least 1; the default before any measured boot. */
export function restartingRetryAfterS(state: RestartingState, nowMs: number): number {
  if (state.expectedReadyMs === null) return RESTARTING_RETRY_AFTER_DEFAULT_S;
  const left = Date.parse(state.since) + state.expectedReadyMs - nowMs;
  return Math.max(1, Math.ceil(left / 1000));
}

export interface RestartingAnswer {
  /** Starts answering, or replaces the state it answers with. */
  open(state: RestartingState): Promise<void>;
  /** Stops answering and frees the port; resolves once the listener is closed. */
  close(): Promise<void>;
  state(): RestartingState | undefined;
}

/**
 * W1-T13277: while no generation holds serve's port, the supervisor answers it itself: 503, Retry-After and the state
 * as JSON, to every method. INVARIANT writes-are-never-swallowed: a request is answered at once and its connection
 * closed, never held or replayed, so a write's only path is the caller's own retry.
 */
export function createRestartingAnswer(port: number, host: string | undefined, clock: Clock,
  log: (step: string, extra?: Record<string, unknown>) => void): RestartingAnswer {
  let current: RestartingState | undefined;
  let answered = 0;
  let listenPort = port;
  let listening: ReturnType<typeof createServer> | undefined;
  // One transition at a time: an open and a close never interleave on the listener.
  let chain: Promise<void> = Promise.resolve();
  const serially = (step: () => Promise<void>): Promise<void> => (chain = chain.then(step, step));
  const server = (): ReturnType<typeof createServer> => createServer((req, res) => {
    const state = current;
    answered += 1;
    const body = JSON.stringify(state ?? { state: "restarting", since: clock.iso(), reason: "restart", expectedReadyMs: null });
    res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", connection: "close",
      "retry-after": String(state ? restartingRetryAfterS(state, clock.now()) : RESTARTING_RETRY_AFTER_DEFAULT_S) });
    res.end(body);
    req.resume();
  });
  return {
    state: () => current,
    open: (state) => serially(async () => {
      current = state;
      if (listening) return;
      const next = server();
      const bound = await new Promise<boolean>((resolve) => {
        next.once("listening", () => resolve(true));
        next.once("error", (error) => {
          log("serve.restarting_answer_failed", { port: listenPort, reason: errorText(error) });
          resolve(false);
        });
        next.listen(listenPort, host);
      });
      if (!bound) return;
      // Keep the same endpoint across restarts when the first bind used an ephemeral port.
      listenPort = (next.address() as AddressInfo).port;
      listening = next;
      answered = 0;
      log("serve.restarting_answer_opened", { port: listenPort, ...state });
    }),
    close: () => serially(async () => {
      const open = listening;
      const was = current;
      listening = undefined;
      current = undefined;
      if (!open) return;
      await new Promise<void>((resolve) => {
        open.close(() => resolve());
        open.closeAllConnections();
      });
      log("serve.restarting_answer_closed", { port: listenPort, answered, ...(was ? { reason: was.reason, since: was.since } : {}) });
    }),
  };
}

const TCP_STATES: Record<string, string> = {
  "01": "ESTABLISHED", "02": "SYN_SENT", "03": "SYN_RECV", "04": "FIN_WAIT1", "05": "FIN_WAIT2", "06": "TIME_WAIT",
  "07": "CLOSE", "08": "CLOSE_WAIT", "09": "LAST_ACK", "0A": "LISTEN", "0B": "CLOSING",
};

/** Open sockets on a local port by TCP state, from /proc/net/tcp and /proc/net/tcp6; a table that cannot be read is skipped. */
export function socketStatesForPort(port: number, read: (path: string) => string = (path) => readFileSync(path, "utf8")): Record<string, number> {
  const counts: Record<string, number> = {};
  const wantPort = port.toString(16).toUpperCase().padStart(4, "0");
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = read(table);
    } catch {
      continue; // this table is absent (no IPv6, or not Linux): the other one still counts
    }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4 || fields[1]?.split(":")[1]?.toUpperCase() !== wantPort) continue;
      const state = TCP_STATES[fields[3]?.toUpperCase() ?? ""] ?? `0x${fields[3]}`;
      counts[state] = (counts[state] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * W1-T13303: the shortest gap between two ordinary handoffs. MEASURED 2026-11-16/17: at 15 minutes, serve handed off 12
 * times in 10 hours (main moved 28 times in 3), and each cold boot stalled the Console for minutes. W1-T13676: with
 * {@link ServeSupervisorOptions.spaceFromBoot} (serve's production supervisor) a fresh boot counts as the last restart, so its
 * first handoff waits out the base window too; without it a supervisor with no handoff yet hands off at once.
 */
export const SERVE_HANDOFF_SPACING_BASE_MS = 2 * 60 * 60_000;
/**
 * BACKSTOP (W1-T13534): the most handoff pressure may stretch the spacing, twice its base. W1-T13303 meant a 2 h
 * window; OBSERVED 2026-11-17 a wait of 3.45 h (spacingMs 13291701) held a merged fix out of serve. A base set
 * above it is never cut below that base.
 */
export const SERVE_HANDOFF_SPACING_MAX_MS = 2 * SERVE_HANDOFF_SPACING_BASE_MS;
/** BACKSTOP: the cap on a memory-deferred handoff's retry backoff: the old 15-minute window, kept apart from the spacing above. */
export const SERVE_HANDOFF_MEMORY_RETRY_CAP_MS = 15 * 60_000;
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
 * and halves every {@link SERVE_HANDOFF_PRESSURE_HALF_LIFE_MS}. No cliff: a busy fleet settles where
 * the gaps balance the decay (about 1.4 an hour on the measured merges, from 2.8), and a quiet one
 * returns to the base window on its own. W1-T13534 caps the stretch at
 * {@link SERVE_HANDOFF_SPACING_MAX_MS}, so a self-sync is never held behind main past twice the base.
 * The deferred handoff prepares the newest main when it finally runs, so every merge meanwhile rides it.
 */
export function handoffSpacingMs(pressure: number, baseMs: number): number {
  return Math.min(baseMs * (1 + Math.max(0, pressure)), Math.max(baseMs, SERVE_HANDOFF_SPACING_MAX_MS));
}

/** One forked generation, as the supervisor sees it. */
export interface GenerationProcess {
  readonly pid: number | undefined;
  send(message: GenerationMessage): void;
  onMessage(listener: (message: GenerationMessage) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  kill(signal: NodeJS.Signals): void;
}

/** W1-T13304: the container cgroup's total CPU (cpu.stat usage_usec), or undefined when unreadable. */
export function cgroupCpuUsageUsec(path = "/sys/fs/cgroup/cpu.stat"): number | undefined {
  try {
    const match = /^usage_usec (\d+)$/m.exec(readFileSync(path, "utf8"));
    return match ? Number(match[1]) : undefined;
  } catch (_err) {
    // Carried, not erased: unreadable is "unknown" (undefined), never zero.
    return undefined;
  }
}

/** W1-T13304: the CPU seconds each thread name of `pids` has used, plus their reaped children under "children".
 *  Totals are cumulative; the budget row takes the hour's delta. A pid that cannot be read adds nothing. */
export function procCpuConsumers(pids: readonly number[], proc = "/proc", clockTicks = 100): Map<string, number> {
  const out = new Map<string, number>();
  const add = (name: string, ticks: number): void => void out.set(name, (out.get(name) ?? 0) + ticks / clockTicks);
  const fields = (text: string): { comm: string; rest: string[] } | undefined => {
    const close = text.lastIndexOf(")");
    if (close < 0) return undefined;
    return { comm: text.slice(text.indexOf("(") + 1, close), rest: text.slice(close + 2).split(" ") };
  };
  for (const pid of pids) {
    try {
      const own = fields(readFileSync(`${proc}/${pid}/stat`, "utf8"));
      if (own) add("children", Number(own.rest[13]) + Number(own.rest[14]));
      for (const tid of readdirSync(`${proc}/${pid}/task`)) {
        const thread = fields(readFileSync(`${proc}/${pid}/task/${tid}/stat`, "utf8"));
        if (thread) add(thread.comm, Number(thread.rest[11]) + Number(thread.rest[12]));
      }
    } catch (_err) {
      // Carried, not erased: a pid that exited mid-read only leaves the consumer list shorter.
      continue;
    }
  }
  return out;
}

/** W1-T13304: how often the supervisor writes `serve.cpu_budget` (incident-invariants.ts's serve-cpu-budget rule reads it). */
export const SERVE_CPU_BUDGET_INTERVAL_MS = 60 * 60_000;

/** W1-T13441: a consumer under this many cores over the hour is left off serve.cpu_budget's `threads` list. */
export const SERVE_CPU_BUDGET_THREAD_FLOOR_CORES = 0.005;

/** W1-T13304: the steps that open and close a boot window, the time serve.cpu_budget leaves out of steady CPU. */
const CPU_BOOT_OPEN_STEPS = new Set(["serve.generation_forked"]);
const CPU_BOOT_CLOSE_STEPS = new Set(["serve.cold_start_ready", "serve.handoff_done", "serve.handoff_aborted", "serve.handoff_failed", "serve.cold_start_failed", "serve.generation_restart_failed"]);
/** BACKSTOP: a window under a minute outside boots is too short to judge, so its steady_cores is null. */
const CPU_BUDGET_MIN_STEADY_MS = 60_000;

/** W1-T13304: the supervisor's CPU budget seams; every default reads this container. */
export interface ServeCpuBudgetOptions {
  usageUsec?: () => number | undefined;
  consumers?: (pids: readonly number[]) => ReadonlyMap<string, number>;
  /** Run `fn` every `ms`; returns a cancel. Defaults to an unref'd setInterval. */
  every?: (ms: number, fn: () => void) => () => void;
  intervalMs?: number;
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
  /**
   * W1-T13676: count the cold boot as the last restart, so the first handoff waits out the base spacing from it. OBSERVED
   * 2026-11-18: a container booted at 06:01:29Z handed off again at 06:21:51Z. A boot adds no handoff pressure.
   */
  spaceFromBoot?: boolean;
  /**
   * W1-T13276: one probe of the active generation; resolves with any HTTP status, rejects on a refusal. W1-T13503: defaults
   * to {@link tcpGet} of {@link ACTIVE_PROBE_PUBLIC_PATH} on the serve port, the path the tunnel's connections take.
   */
  activeProbe?: (socketPath: string, path: string, timeoutMs: number) => Promise<{ status: number }>;
  /** W1-T13503: after an unanswered public probe, one GET of the generation's private socket, recorded on the wedge row. Defaults to {@link socketGet}. */
  privateProbe?: (socketPath: string, path: string, timeoutMs: number) => Promise<{ status: number }>;
  /** W1-T13276: runs `tick` every `ms` and returns its canceller; defaults to an unref'd interval. */
  every?: (tick: () => void, ms: number) => () => void;
  activeProbeTimeoutMs?: number;
  /** W1-T13276: the post-mortem socket census; defaults to {@link socketStatesForPort} on `servePort`. */
  socketStates?: () => Record<string, number> | undefined;
  /** W1-T13503: defaults to {@link servePortOf} of `serveArgs`. */
  servePort?: number;
  /** W1-T13304: the hourly serve.cpu_budget row's seams. */
  cpuBudget?: ServeCpuBudgetOptions;
  /**
   * W1-T13277: answer serve's port with 503 and the restarting state while no generation holds it. `true` is serve's
   * own port and host; an object names them (tests); absent, the gap is left unanswered as before.
   */
  restartingAnswer?: boolean | { port: number; host?: string };
  /**
   * W1-T14986: the webhook listener thread (github-hook-listener.ts). The active generation's pushed hook config is
   * forwarded to it, and each accepted delivery's follow-up is relayed to the active generation. Absent, none runs.
   */
  hookListener?: GithubHookListenerHandle;
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
  /** When it was forked, on the supervisor's clock, so a wedge row can say how long it had lived. */
  startedAt: number;
  /** It asked for a handoff before it was active; the ask is replayed once it is promoted. */
  asked: boolean;
  /** W1-T14987: what that early ask said (target and verdict), so its replay keeps it. */
  askedWith?: HandoffAsk;
  /** It dropped its caches for a handoff that has not yet replaced it. */
  shed?: boolean;
  /** W1-T8873: when it terminated its worker threads for a handoff that has not yet replaced it; absent once restored. */
  workersShedAt?: number;
  /** W1-T14986: the hook config it last pushed, forwarded to the listener while it is active. */
  hookConfig?: GithubHookConfig;
}

/** What a handoff ask says about itself. */
export interface HandoffAsk {
  targetSha?: string;
  /**
   * W1-T14987: the active generation's verdict on the advance it asks for (serve.ts classifies `fromSha..toSha` with
   * serve-own-code.ts). The supervisor runs no classifier, so its baked closure stays as it was; it trusts a verdict
   * only for its own active sha and the sha prepare lands on.
   */
  serveOnly?: ServeOnlyVerdict;
  /** Why the ask's `serveOnly` field was present but not a verdict. */
  serveOnlyMalformed?: string;
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** W1-T14987: the `serveOnly` field of a generation's IPC ask, checked for shape. Absent stays absent; anything else
 *  that is not a verdict is named, so the spacing row says why it was not trusted. */
export function readServeOnlyVerdict(raw: unknown): Pick<HandoffAsk, "serveOnly" | "serveOnlyMalformed"> {
  if (raw === undefined) return {};
  const v = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const toSha = typeof v.toSha === "string" ? { toSha: v.toSha } : {};
  if (typeof v.fromSha !== "string") return { serveOnlyMalformed: "the verdict names no fromSha" };
  if ((v.status === "unreadable" || v.status === "spaced") && typeof v.reason === "string") return { serveOnly: { status: v.status, reason: v.reason, fromSha: v.fromSha, ...toSha } };
  if (v.status === "serve_only" && typeof v.toSha === "string" && typeof v.merge === "string" && isStrings(v.paths)) {
    return { serveOnly: { status: "serve_only", merge: v.merge, paths: [...v.paths], fromSha: v.fromSha, toSha: v.toSha } };
  }
  return { serveOnlyMalformed: `the verdict's status ${JSON.stringify(v.status)} does not carry its fields` };
}

export interface ServeSupervisor {
  start(): Promise<void>;
  /** `ask.targetSha`, when the asker knows it, names the build it wants; the spacing ledger carries it. */
  requestHandoff(ask?: HandoffAsk): Promise<void>;
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

/** W1-T13503: one HTTP GET over TCP to this container's own serve port, the accept queue the tunnel's connections enter. */
export function tcpGet(port: number, path: string, timeoutMs = 30_000, host = "127.0.0.1"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, agent: false, timeout: timeoutMs }, (res) => {
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

export function createServeSupervisor(input: ServeSupervisorOptions): ServeSupervisor {
  // W1-T13304: every log line also opens or closes a boot window for the CPU budget; nothing else changes.
  const budget = createCpuBudgetTracker(input);
  const opts: ServeSupervisorOptions = { ...input, log: (step, extra) => { budget.note(step); input.log(step, extra); } };
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
  const retryCapMs = Math.max(deferMs, SERVE_HANDOFF_MEMORY_RETRY_CAP_MS);

  let next = 0;
  let active: Generation | undefined;
  let previous: PreparedSlot | undefined;
  let inFlight: Promise<void> | undefined;
  let askedAgain = false;
  /**
   * W1-T14987: the latest ask that said anything (target, verdict). A re-ask that carries nothing of its own (the memory
   * retry, a spacing wake, an ask absorbed while one was in flight, an early ask's replay) runs with it, so a waiver is
   * not lost on the way; the waiver re-checks it against the active sha and the prepared sha every time.
   */
  let heldAsk: HandoffAsk | undefined;
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
  /** W1-T13534: when the pending spacing wait re-asks, and how many asks it has absorbed meanwhile. */
  let spacingWakeAt = 0;
  let spacingAbsorbed = 0;
  const servePort = opts.servePort ?? servePortOf(opts.serveArgs);
  const activeProbe = opts.activeProbe ?? ((_socketPath: string, path: string, timeoutMs: number) => tcpGet(servePort, path, timeoutMs));
  const privateProbe = opts.privateProbe ?? ((socketPath: string, path: string, timeoutMs: number) => socketGet(socketPath, path, timeoutMs));
  const probeTimeoutMs = opts.activeProbeTimeoutMs ?? ACTIVE_PROBE_TIMEOUT_MS;
  const every = opts.every ?? ((tick: () => void, ms: number) => {
    const timer = setInterval(tick, ms);
    timer.unref();
    return () => clearInterval(timer);
  });
  const socketStates = opts.socketStates ?? (() => socketStatesForPort(servePort));
  let stopProbing: (() => void) | undefined;
  let probing = false;
  let probeMisses: { generation: number; count: number } = { generation: 0, count: 0 };
  let lastWedgeRestartAt: number | undefined;
  /** Generations the supervisor itself is killing for a wedge: not probed again, and not a crash to roll back from. */
  const wedged = new Set<Generation>();
  // W1-T13277: the answer on serve's port while nothing holds it, and the last measured boot it quotes.
  const restartingOption = opts.restartingAnswer;
  const restarting = restartingOption === undefined || restartingOption === false ? undefined
    : restartingOption === true ? createRestartingAnswer(servePort, serveHostOf(opts.serveArgs), clock, opts.log)
      : createRestartingAnswer(restartingOption.port, restartingOption.host, clock, opts.log);
  let lastAloneReadyMs: number | undefined;
  let booted = false;
  const answerRestarting = (reason: RestartingState["reason"]): Promise<void> => restarting?.open({
    state: booted ? "restarting" : "starting", since: clock.iso(), reason, expectedReadyMs: lastAloneReadyMs ?? null,
  }) ?? Promise.resolve();

  const fork = (slot: PreparedSlot): Generation => {
    const id = ++next;
    const socketPath = socketPathFor(id);
    const proc = spawn(command(slot), { [SERVE_ROLE_ENV]: "standby", [SERVE_READY_SOCKET_ENV]: socketPath, [SELF_SYNC_GUARD_ENV]: "1" });
    let alive = true;
    const exited = new Promise<void>((resolve) => proc.onExit(() => ((alive = false), resolve())));
    const generation: Generation = { id, slot, socketPath, process: proc, exited, isAlive: () => alive, startedAt: clock.now(), asked: false };
    proc.onMessage((message) => {
      if (message.type === GENERATION_MESSAGES.githubHookConfig && isGithubHookConfig(message.config)) {
        generation.hookConfig = message.config;
        if (generation === active) opts.hookListener?.configure(message.config);
        return;
      }
      if (message.type !== GENERATION_MESSAGES.handoffRequest) return;
      const ask: HandoffAsk = { ...(typeof message.targetSha === "string" ? { targetSha: message.targetSha } : {}), ...readServeOnlyVerdict(message.serveOnly) };
      if (generation === active) void supervisor.requestHandoff(Object.keys(ask).length > 0 ? ask : undefined);
      else {
        generation.asked = true;
        if (Object.keys(ask).length > 0) generation.askedWith = ask;
      }
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

  /** One bounded probe of `generation`: any HTTP status is an answer; a timeout or a refusal is the unanswered kind. */
  const probeOnce = async (generation: Generation): Promise<{ answered: true; status: number } | { answered: false; error: string }> => {
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${probeTimeoutMs} ms`)), probeTimeoutMs);
      timer.unref();
    });
    try {
      const reply = await Promise.race([activeProbe(generation.socketPath, ACTIVE_PROBE_PUBLIC_PATH, probeTimeoutMs), bound]);
      return { answered: true, status: reply.status };
    } catch (err) {
      return { answered: false, error: errorText(err) };
    } finally {
      clearTimeout(timer);
    }
  };

  /** W1-T13276: the active generation answered nothing for ACTIVE_PROBE_FAILURES probes: record it and restart it, at most once per floor. */
  const handleWedge = (generation: Generation, failures: number, lastError: string, privateSocket?: PrivateProbeAnswer): void => {
    const now = clock.now();
    if (lastWedgeRestartAt !== undefined && now - lastWedgeRestartAt < ACTIVE_WEDGE_RESTART_FLOOR_MS) {
      opts.log("serve.active_wedged_held", { generation: generation.id, sha: generation.slot.sha, failures, lastError, sinceLastRestartMs: now - lastWedgeRestartAt, floorMs: ACTIVE_WEDGE_RESTART_FLOOR_MS, privateSocket });
      return;
    }
    lastWedgeRestartAt = now;
    let sockets: Record<string, number> | undefined;
    try {
      sockets = socketStates();
    } catch (err) {
      opts.log("serve.active_wedge_snapshot_unread", { reason: errorText(err) });
    }
    opts.log("serve.active_wedged", { generation: generation.id, sha: generation.slot.sha, pid: generation.process.pid, failures, lastError, uptimeMs: now - generation.startedAt, sockets, probedPort: servePort, privateSocket });
    wedged.add(generation);
    try {
      generation.process.kill("SIGKILL");
    } catch (err) {
      // The restart path is unavailable: the legacy exit lets docker restart the whole container.
      opts.log("serve.active_wedge_kill_failed", { generation: generation.id, reason: errorText(err) });
      void legacyExit("active_wedged");
    }
  };

  /** W1-T13503: one bounded GET of the generation's private socket, never thrown: `{answered,status}` or `{answered:false,error}`. */
  const probePrivately = async (generation: Generation): Promise<PrivateProbeAnswer> => {
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ACTIVE_PRIVATE_PROBE_TIMEOUT_MS} ms`)), ACTIVE_PRIVATE_PROBE_TIMEOUT_MS);
      timer.unref();
    });
    try {
      const reply = await Promise.race([privateProbe(generation.socketPath, SMOKE_PATHS[0], ACTIVE_PRIVATE_PROBE_TIMEOUT_MS), bound]);
      return { answered: true, status: reply.status };
    } catch (err) {
      return { answered: false, error: errorText(err) };
    } finally {
      clearTimeout(timer);
    }
  };

  /** One probe interval: probes only the generation that is serving, and never while a handoff, a drain or a restart is under way. */
  const probeTick = async (): Promise<void> => {
    const generation = active;
    if (probing || stopping || !generation || inFlight || wedged.has(generation) || !generation.isAlive()) {
      if (!probing) probeMisses = { generation: 0, count: 0 };
      return;
    }
    probing = true;
    try {
      const result = await probeOnce(generation);
      // A handoff, a drain or a crash began while it was in flight: that answer is about a generation that is leaving.
      if (active !== generation || inFlight || stopping) return void (probeMisses = { generation: 0, count: 0 });
      if (result.answered) return void (probeMisses = { generation: generation.id, count: 0 });
      const count = (probeMisses.generation === generation.id ? probeMisses.count : 0) + 1;
      probeMisses = { generation: generation.id, count };
      if (count < ACTIVE_PROBE_FAILURES) return;
      probeMisses = { generation: generation.id, count: 0 };
      // W1-T13503: the private socket's answer separates a stalled accept on the public port from a stalled generation.
      const privateSocket = await probePrivately(generation);
      if (active !== generation || inFlight || stopping || wedged.has(generation)) return;
      handleWedge(generation, count, result.error, privateSocket);
    } finally {
      probing = false;
    }
  };

  const startProbing = (): void => {
    if (stopProbing) return;
    stopProbing = every(() => void probeTick().catch((err: unknown) => opts.log("serve.active_probe_error", { reason: errorText(err) })), ACTIVE_PROBE_INTERVAL_MS);
  };

  /** W1-T13832: ask the generation now serving to probe its views once. Never awaited, so it cannot hold a swap. */
  const askSwapProbe = (generation: Generation, trigger: SwapProbeTrigger, fromSha?: string): void => {
    try {
      generation.process.send({ type: GENERATION_MESSAGES.swapProbe, trigger, generation: generation.id, sha: generation.slot.sha, ...(fromSha === undefined ? {} : { fromSha }) });
    } catch (error) {
      opts.log("serve.swap_probe_unsent", { generation: generation.id, trigger, reason: errorText(error) });
    }
  };

  const activate = (generation: Generation): void => {
    active = generation;
    if (generation.hookConfig) opts.hookListener?.configure(generation.hookConfig);
    startProbing();
    if (generation.asked) void supervisor.requestHandoff(generation.askedWith);
  };

  /**
   * The active generation's served body count: a standby must not be thinner than what it replaces.
   * W1-T13600: the committed count when the active reports one. On 2026-11-18 every handoff after a 02:24Z cold
   * start aborted on ready_bound with 226 of 235 bodies: a standby loads only the store, and the active held bodies it
   * had built itself that the store did not give the standby.
   * An active on older code reports no `committed`, and its total is used as before.
   */
  const activeBodies = async (): Promise<number> => {
    if (!active) return 0;
    const reply = await get(active.socketPath, SERVE_READY_PATH).catch((err: unknown) => ({ status: 0, body: errorText(err) }));
    const report = (safeJson(reply.body) as { criteria?: Array<{ name: string; detail?: { bodies?: number; committed?: unknown } }> } | undefined);
    const detail = report?.criteria?.find((c) => c.name === "read_model_warm")?.detail;
    return typeof detail?.committed === "number" ? detail.committed : (detail?.bodies ?? 0);
  };

  const promote = async (generation: Generation): Promise<boolean> => {
    const promoted = new Promise<boolean>((resolve) => {
      generation.process.onMessage((message) => message.type === GENERATION_MESSAGES.promoted && resolve(true));
      void generation.exited.then(() => resolve(false));
    });
    // W1-T13277: the generation binds serve's port on promote, so the restarting answer frees it first.
    await restarting?.close();
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
    // W1-T13277: the measured boot the next restarting answer quotes.
    lastAloneReadyMs = clock.now() - startedAt;
    booted = true;
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

  /**
   * True when this ask must wait out the spacing; the wait re-asks once, however many asks arrive meanwhile.
   * W1-T13534: each ask it absorbs writes `serve.handoff_spacing_absorbed`, so a self-sync held behind main says why.
   */
  const awaitSpacing = (from: Generation, ask: HandoffAsk | undefined, waiver?: string): boolean => {
    if (spacingBaseMs <= 0 || lastDoneAt === undefined) return false;
    const now = clock.now();
    const level = decayedPressure(pressure, now, spacingHalfLifeMs);
    const spacingMs = handoffSpacingMs(level, spacingBaseMs);
    const waitMs = lastDoneAt + spacingMs - now;
    if (waitMs <= 0) return false;
    const why = waiver === undefined ? {} : { waiver };
    if (spacingPending) {
      spacingAbsorbed += 1;
      opts.log("serve.handoff_spacing_absorbed", { sha: ask?.targetSha, remainingMs: Math.max(0, spacingWakeAt - now), absorbed: spacingAbsorbed, ...why });
      return true;
    }
    spacingPending = true;
    spacingWakeAt = now + waitMs;
    opts.log("serve.handoff_deferred", { reason: "spacing", waitMs, spacingMs, pressure: Number(level.toFixed(3)), sinceLastMs: now - lastDoneAt, sha: from.slot.sha, ...why });
    void sleep(waitMs).then(() => {
      spacingPending = false;
      spacingAbsorbed = 0;
      return supervisor.requestHandoff();
    });
    return true;
  };

  /**
   * W1-T14987: before the spacing holds an ask (a new wait or one a pending wait absorbs), a generation verdict that the
   * advance holds a merge changing only serve's own code waives it. Fail-closed: a malformed verdict, an ask with no
   * target, a verdict for another active sha or target, or an unreadable one returns the reason the spacing row names.
   * An ask with no verdict, or a readable one with no such merge, returns nothing, so its row is as before.
   * A waiver covers exactly the classified target: `row` is written only once prepare lands on that sha.
   */
  type SpacingWaiver = { waived: false; why?: string } | { waived: true; toSha: string; row: Record<string, unknown> };
  const spacingWaiver = (from: Generation, ask: HandoffAsk | undefined): SpacingWaiver => {
    const verdict = ask?.serveOnly;
    if ((verdict === undefined && ask?.serveOnlyMalformed === undefined) || spacingBaseMs <= 0 || lastDoneAt === undefined) return { waived: false };
    const waitMs = lastDoneAt + handoffSpacingMs(decayedPressure(pressure, clock.now(), spacingHalfLifeMs), spacingBaseMs) - clock.now();
    if (waitMs <= 0) return { waived: false };
    if (verdict === undefined) return { waived: false, why: `malformed verdict: ${ask?.serveOnlyMalformed}` };
    const toSha = ask?.targetSha;
    if (toSha === undefined) return { waived: false, why: "the ask names no target sha" };
    if (verdict.fromSha !== from.slot.sha) return { waived: false, why: `a verdict from ${verdict.fromSha}, not the active ${from.slot.sha}` };
    if (verdict.status === "unreadable") return { waived: false, why: `unreadable: ${verdict.reason}` };
    if (verdict.status === "spaced") return { waived: false };
    if (verdict.toSha !== toSha) return { waived: false, why: `a verdict for ${verdict.toSha}, not the asked ${toSha}` };
    return { waived: true, toSha, row: { fromSha: from.slot.sha, toSha, merge: verdict.merge, paths: verdict.paths, waitMs } };
  };

  const handoff = async (ask?: HandoffAsk): Promise<void> => {
    if (!handoffEnabled()) return legacyExit("handoff_off");
    const from = active;
    if (!from) return;
    const waiver = spacingWaiver(from, ask);
    if (!waiver.waived && awaitSpacing(from, ask, waiver.why)) return;
    const startedAt = clock.now();
    let slot: PreparedSlot;
    try {
      slot = await opts.prepare(from.slot.dir);
    } catch (err) {
      opts.log("serve.handoff_aborted", { criterion: "prepare", reason: errorText(err), fromSha: from.slot.sha });
      return;
    }
    if (waiver.waived) {
      // prepare checks out the newest main, which may hold merges that landed after the ask: those never ride the waiver.
      if (slot.sha !== waiver.toSha && awaitSpacing(from, ask, `prepared ${slot.sha}, not the waived target ${waiver.toSha}`)) return;
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
    // W1-T14987: the waiver is recorded only once the handoff it waived actually proceeds; a memory deferral keeps the
    // ask (heldAsk) and its retry judges it again.
    if (waiver.waived && slot.sha === waiver.toSha) opts.log("serve.handoff_spacing_waived", waiver.row);
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
    // The ask this handoff answered is spent; one that arrived meanwhile (a promoted standby's replay) is kept.
    if (heldAsk === ask) heldAsk = undefined;
    pressure = { value: decayedPressure(pressure, lastDoneAt, spacingHalfLifeMs) + 1, at: lastDoneAt };
    opts.log("serve.handoff_done", {
      fromSha: from.slot.sha, toSha: slot.sha, deps: slot.deps, prepMs, readyMs: up.readyMs, drainMs, peakBytes: largestRss || undefined, pressure: Number(pressure.value.toFixed(3)),
      overlapPeakBytes: measured.overlapPeakBytes, overlapSamples: measured.overlapSamples,
      ...(from.workersShedAt === undefined ? {} : { workersShedMs: lastDoneAt - from.workersShedAt }),
    });
    askSwapProbe(up.generation, "handoff", from.slot.sha);
  };

  /** A promoted generation died on its own: replace it, from the previous slot when it is a different build. */
  const replaceCrashed = async (dead: Generation, code: number | null, signal: string | null): Promise<void> => {
    active = undefined;
    // W1-T13277: from the exit on, serve's port says it is restarting, through the back-off and the boot.
    void answerRestarting(wedged.has(dead) ? "wedge" : "restart");
    if (inFlight) await inFlight;
    if (active) return;
    crashes += 1;
    // A wedge says nothing about the build: the same slot restarts, and nothing is marked failed.
    const rollback = !wedged.has(dead) && previous !== undefined && previous.sha !== dead.slot.sha;
    const slot = rollback && previous ? previous : dead.slot;
    if (rollback) failed.add(dead.slot.sha);
    opts.log(rollback ? "serve.handoff_rolled_back" : "serve.generation_crashed", { sha: dead.slot.sha, toSha: slot.sha, code, signal, crashes });
    // Self-healing back-off: a build that dies at once must not become a fork loop.
    await sleep(Math.min(60_000, 1_000 * 2 ** (crashes - 1)));
    const up = await bringUpAlone(slot);
    if (up.generation) {
      previous = undefined;
      askSwapProbe(up.generation, "crash_restart", dead.slot.sha);
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

  // W1-T14986: the listener's rows go on the supervisor's ledger; a follow-up runs on the active generation, after the 202.
  opts.hookListener?.onMessage((message) => {
    if (message.kind === "log") return opts.log(message.step, message.extra);
    if (message.kind !== "followUp") return;
    const generation = active;
    const info = message.followUp.checkRunCompleted;
    if (!generation || !generation.isAlive()) {
      // The marker already wakes the daemon; only the CI-incident consumer misses this check run.
      return opts.log("github.wake.check_run_callback_failed", { check_run_id: info.id, reason: "no_active_generation" });
    }
    generation.process.send({ type: GENERATION_MESSAGES.githubDelivery, checkRunCompleted: info });
  });

  const supervisor: ServeSupervisor = {
    activeSha: () => active?.slot.sha,
    start: async () => {
      await answerRestarting("boot");
      const up = await bringUpAlone(opts.coldSlot);
      if (!up.generation) {
        opts.log("serve.cold_start_failed", { sha: opts.coldSlot.sha, criterion: up.criterion, detail: up.detail });
        exit(1);
        return;
      }
      opts.log("serve.supervisor_ready", { sha: opts.coldSlot.sha, readyMs: up.readyMs });
      askSwapProbe(up.generation, "cold_start");
      if (opts.spaceFromBoot === true && spacingBaseMs > 0) lastDoneAt = clock.now();
      budget.start(() => [process.pid, ...(active?.process.pid === undefined ? [] : [active.process.pid])]);
      await reportAlone(up.generation, up.startedAt, up.readyMs);
    },
    requestHandoff: (given) => {
      if (stopping) return Promise.resolve();
      if (given !== undefined) heldAsk = given;
      // Only a held verdict travels: a bare re-ask after a target-only ask stays bare, as before W1-T14987.
      const ask = given ?? (heldAsk?.serveOnly === undefined ? undefined : heldAsk);
      if (inFlight) {
        askedAgain = true;
        return inFlight;
      }
      // A memory refusal owns one retry. An external/coalesced ask must not skip its backoff and
      // prepare/shed/restore again; that retry prepares the newest main when it actually wakes.
      if (retryPending && handoffEnabled()) return Promise.resolve();
      inFlight = handoff(ask)
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
      stopProbing?.();
      budget.stop();
      await restarting?.close();
      await opts.hookListener?.stop();
      const generation = active;
      if (generation) await drainOld(generation, reason);
      exit(0);
    },
  };
  return supervisor;
}

/**
 * W1-T13304: serve's steady CPU. The cgroup's usage is read at each boot's start and end, so the hour's row splits
 * usage exactly into boot and steady parts: steady_cores = (usage outside boots) / (seconds outside boots).
 */
function createCpuBudgetTracker(opts: ServeSupervisorOptions): { note(step: string): void; start(pids: () => number[]): void; stop(): void } {
  const clock = opts.clock ?? systemClock;
  const seams = opts.cpuBudget ?? {};
  const usage = seams.usageUsec ?? (() => cgroupCpuUsageUsec());
  const consumers = seams.consumers ?? ((pids: readonly number[]) => procCpuConsumers(pids));
  const every = seams.every ?? ((ms: number, fn: () => void) => {
    const timer = setInterval(fn, ms);
    timer.unref();
    return () => clearInterval(timer);
  });
  const intervalMs = seams.intervalMs ?? SERVE_CPU_BUDGET_INTERVAL_MS;
  let started = false;
  let cancel: (() => void) | undefined;
  let window = { atMs: 0, usage: undefined as number | undefined, bootMs: 0, bootUsec: 0, bootUnread: false };
  let boot: { atMs: number; usage: number | undefined } | undefined;
  let lastConsumers: ReadonlyMap<string, number> = new Map();
  let prevSteady: number | null = null;
  const closeBoot = (now: number, at: number | undefined): void => {
    if (boot === undefined) return;
    window.bootMs += now - Math.max(boot.atMs, window.atMs);
    if (at === undefined || boot.usage === undefined) window.bootUnread = true;
    else window.bootUsec += at - boot.usage;
    boot = undefined;
  };
  const note = (step: string): void => {
    if (!started) return;
    if (CPU_BOOT_OPEN_STEPS.has(step) && boot === undefined) boot = { atMs: clock.now(), usage: usage() };
    else if (CPU_BOOT_CLOSE_STEPS.has(step)) closeBoot(clock.now(), usage());
  };
  const sample = (pids: () => number[]): void => {
    const now = clock.now();
    const at = usage();
    // A boot still open at the hour is split there: its part so far is boot, and it reopens for the next hour.
    const reopen = boot !== undefined && now - boot.atMs < STANDBY_READY_BOUND_MS;
    closeBoot(now, at);
    const windowMs = now - window.atMs;
    const steadyMs = windowMs - window.bootMs;
    const usageUsec = at === undefined || window.usage === undefined ? undefined : at - window.usage;
    const steady = usageUsec === undefined || window.bootUnread || steadyMs < CPU_BUDGET_MIN_STEADY_MS
      ? null : Number((((usageUsec - window.bootUsec) / 1e6) / (steadyMs / 1000)).toFixed(3));
    const nextConsumers = consumers(pids());
    const ranked = [...nextConsumers].map(([name, seconds]) => ({ name, cores: Number((Math.max(0, seconds - (lastConsumers.get(name) ?? 0)) / (windowMs / 1000)).toFixed(3)) }))
      .sort((a, b) => b.cores - a.cores);
    const top = ranked.slice(0, 3);
    // W1-T13441: every named thread over the floor, not only three: a named worker below the top three still answers for its cores.
    const threads = ranked.filter((consumer) => consumer.cores >= SERVE_CPU_BUDGET_THREAD_FLOOR_CORES);
    opts.log("serve.cpu_budget", {
      window_ms: windowMs, usage_usec: usageUsec ?? null, boot_ms: window.bootMs, boot_usage_usec: window.bootUnread ? null : window.bootUsec,
      steady_cores: steady, prev_steady_cores: prevSteady, top, threads,
    });
    prevSteady = steady;
    lastConsumers = nextConsumers;
    window = { atMs: now, usage: at, bootMs: 0, bootUsec: 0, bootUnread: false };
    if (reopen) boot = { atMs: now, usage: at };
  };
  return {
    note,
    start(pids) {
      if (started) return;
      started = true;
      window = { atMs: clock.now(), usage: usage(), bootMs: 0, bootUsec: 0, bootUnread: false };
      lastConsumers = consumers(pids());
      cancel = every(intervalMs, () => sample(pids));
    },
    stop() {
      cancel?.();
      cancel = undefined;
    },
  };
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
