/**
 * W1-T5114 — every gardener pass runs OFF the daemon's event loop.
 *
 * MEASURED 2026-10-01: eleven daemon ticks spent 4,344 s reaching admission, and the silent-loop gaps that
 * ended in a gardener's scorecard totalled ~1,620 s (config 839, hot-file 405, host-resource 117, plan 105,
 * test 80, ci-friction 72). Each garden's starter ran its synchronous pass on the thread that admits builds.
 *
 * Here a pass is a CHILD PROCESS (`rmd garden run <name>`) awaited on exit, so the loop only waits for a
 * process exit event. The child builds the garden from the same registry the daemon names
 * (`buildRegisteredGarden`, run-task.ts), appends to the same ledger as the daemon (it inherits the daemon's
 * actor marker), and logs every scorecard, judged and failure row exactly as the in-process pass did.
 * Pacing that used to live in each starter's closure (a minimum interval, the test garden's hourly evidence
 * refresh) stays in the parent, because a child starts fresh every pass.
 */
import { spawn } from "node:child_process";
import { systemClock, type Clock } from "./clock.js";
import { gardenLedgerBucket } from "./gardener.js";
import { HOST_RESOURCE_MIN_INTERVAL_MS } from "./host-resource-gardener.js";
import { OVERSEER_MIN_INTERVAL_MS } from "./gardener-overseer.js";
import { SELF_SYNC_GUARD_ENV } from "./self-sync.js";

/** The gardens the daemon runs off its loop, in the order its `gardens` list has always wired them. */
export const REGISTERED_GARDEN_NAMES = [
  "plan",
  "gate",
  "test",
  "config",
  "export",
  "ci-friction",
  "selector-shadow",
  "evidence-coverage",
  "overseer",
  "hot-file",
  "host-resource",
  "backlog",
] as const;

export type RegisteredGardenName = (typeof REGISTERED_GARDEN_NAMES)[number];

export function isRegisteredGardenName(name: string): name is RegisteredGardenName {
  return (REGISTERED_GARDEN_NAMES as readonly string[]).includes(name);
}

/** The ledger step one row per pass carries, so a slow gardener is named rather than inferred from loop lag. */
export const GARDEN_PASS_STEP = "garden.pass";

/** The child's flag for "this pass also refreshes its hourly evidence" (the test garden's feed). */
export const GARDEN_HOURLY_FLAG = "--hourly";

/** Runs ONE pass of the named garden and resolves with its exit code (null when it died on a signal). */
export type GardenPassSpawn = (name: RegisteredGardenName, args: readonly string[], signal: { readonly stopped: boolean }) => Promise<number | null>;

/** Share a small host budget across all garden starters. A busy garden keeps its own pending
 * pass rather than spawning a second child, while queued passes from other gardens wait here. */
export function boundedGardenPassSpawn(spawnPass: GardenPassSpawn, width: number): GardenPassSpawn {
  if (!Number.isInteger(width) || width < 1) throw new Error("garden pass width must be a positive integer");
  type Pending = {
    name: RegisteredGardenName;
    args: readonly string[];
    signal: { readonly stopped: boolean };
    resolve: (exit: number | null) => void;
    reject: (error: unknown) => void;
  };
  const pending: Pending[] = [];
  let active = 0;
  const admit = (): void => {
    while (active < width && pending.length > 0) {
      const next = pending.shift()!;
      if (next.signal.stopped) {
        next.resolve(null);
        continue;
      }
      active += 1;
      // An asynchronous turn keeps a synchronous throwing spawn inside the same settle path.
      Promise.resolve()
        .then(() => next.signal.stopped ? null : spawnPass(next.name, next.args, next.signal))
        .then(next.resolve, next.reject)
        .finally(() => {
          active -= 1;
          admit();
        });
    }
  };
  return (name, args, signal) => new Promise<number | null>((resolve, reject) => {
    pending.push({ name, args, signal, resolve, reject });
    admit();
  });
}

/** Each garden's own pacing, carried over from its former in-process starter. */
interface GardenSchedule {
  /** The timer period, from the daemon's poll interval. */
  intervalFor: (intervalMs: number) => number;
  /** A tick inside this much time since the last pass started is skipped. */
  minIntervalMs: number;
  /** The test garden refreshes its CI evidence once per ledger bucket (an hour). */
  hourly: boolean;
}

const sameInterval = (intervalMs: number) => intervalMs;

export function gardenSchedule(name: RegisteredGardenName): GardenSchedule {
  if (name === "host-resource") {
    return { intervalFor: (i) => Math.max(1_000, Math.min(i, HOST_RESOURCE_MIN_INTERVAL_MS)), minIntervalMs: HOST_RESOURCE_MIN_INTERVAL_MS, hourly: false };
  }
  if (name === "overseer") return { intervalFor: (i) => Math.max(i, OVERSEER_MIN_INTERVAL_MS), minIntervalMs: 0, hourly: false };
  return { intervalFor: sameInterval, minIntervalMs: 0, hourly: name === "test" };
}

/**
 * Start one registered garden: a pass at once, then one per interval, never two at once. The `running`
 * flag skips a tick while that garden's pass is still in flight, exactly as each in-process starter did.
 */
export interface GardenOffLoopWiring {
  spawnPass: GardenPassSpawn;
  log: (step: string, extra?: Record<string, unknown>) => void;
  clock?: Clock;
}

export function startGardenOffLoop(name: RegisteredGardenName, intervalMs: number, wiring: GardenOffLoopWiring): { stop: () => void } {
  const clock = wiring.clock ?? systemClock;
  const schedule = gardenSchedule(name);
  const signal = { stopped: false };
  let running = false;
  let lastStartMs = -Infinity;
  let reportedBucket: number | undefined;
  const tick = (): void => {
    if (running || signal.stopped || clock.now() - lastStartMs < schedule.minIntervalMs) return;
    running = true;
    const startedMs = clock.now();
    lastStartMs = startedMs;
    const bucket = gardenLedgerBucket(clock);
    const hourly = schedule.hourly && bucket !== reportedBucket;
    const settle = (exit: number | null, error?: string): void => {
      running = false;
      if (hourly && exit === 0) reportedBucket = bucket;
      wiring.log(GARDEN_PASS_STEP, { name, ms: clock.now() - startedMs, exit, ...(error === undefined ? {} : { error }) });
    };
    let pass: Promise<number | null>;
    try {
      pass = wiring.spawnPass(name, hourly ? [GARDEN_HOURLY_FLAG] : [], signal);
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      settle(null, error);
      return;
    }
    pass.then(
      (exit) => settle(exit),
      (e: unknown) => settle(null, String((e as Error)?.message ?? e)),
    );
  };
  tick();
  const timer = setInterval(tick, schedule.intervalFor(intervalMs));
  timer.unref?.();
  return {
    stop: () => {
      signal.stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * The production pass: `rmd garden run <name>` as a child of THIS process's own node and loader, so the
 * child runs the same source tree and inherits the same config root, state and ledger actor. Self-sync is
 * skipped in the child: the parent already decided which code it runs.
 */
export function childGardenPassSpawn(
  opts: { execPath?: string; execArgv?: readonly string[]; entry?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): GardenPassSpawn {
  const execPath = opts.execPath ?? process.execPath;
  const execArgv = opts.execArgv ?? process.execArgv;
  const entry = opts.entry ?? process.argv[1] ?? "";
  return (name, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(execPath, [...execArgv, entry, "garden", "run", name, ...args], {
        cwd: opts.cwd,
        env: { ...(opts.env ?? process.env), [SELF_SYNC_GUARD_ENV]: "1" },
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
}
