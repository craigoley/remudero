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
import { execFile, spawn } from "node:child_process";
import { setPriority as osSetPriority } from "node:os";
import { join } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { gardenLedgerBucket, type GardenerDeps } from "./gardener.js";
import { ghJsonAsync, ghTextAsync } from "./github-transport.js";
import { HOST_RESOURCE_MIN_INTERVAL_MS } from "./host-resource-gardener.js";
import { OVERSEER_MIN_INTERVAL_MS } from "./gardener-overseer.js";
import {
  readCoverageShardLogsAsync, readSelectorShadowChangedPaths, readSelectorShadowRunsAsync, runSelectorShadowGardener,
  selectorShadowFlakeLedger,
} from "./selector-shadow-gardener.js";
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
  // W1-T5361: the machine-filing judge, in the slot its in-process starter held (its git work froze the loop).
  "machine-judge",
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

/** A garden's due probe threw; its pass runs anyway and reports the failure itself. */
export const GARDEN_DUE_FAILED_STEP = "garden.due_failed";

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
  /** Whether a pass would do anything ({@link gardenPassDue}). Absent, every tick spawns. A pass that would
   *  skip costs a file read here instead of a whole child process; a probe that throws spawns the pass. */
  due?: () => boolean;
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
    const bucket = gardenLedgerBucket(clock);
    const hourly = schedule.hourly && bucket !== reportedBucket;
    if (!hourly && wiring.due) {
      try {
        if (!wiring.due()) return;
      } catch (e) {
        wiring.log(GARDEN_DUE_FAILED_STEP, { name, error: String((e as Error)?.message ?? e) });
      }
    }
    running = true;
    const startedMs = clock.now();
    lastStartMs = startedMs;
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
 * BACKSTOP (W1-T5365): the V8 heap a garden child may hold. Without it a child inherited node's default, measured at
 * 8,240 MB in the daemon container on 2026-10-03, and two may run at once (~16 GB on a 15 GiB host; this bounds them
 * at ~8 GB). On 2026-10-02 (research/loop-stall.md §1a) backlog reached 1.75 GB RSS + 2.0 GB swap and ci-friction
 * 2.4 GB RSS + 1.25 GB swap, both holding the 1.37 GB ledger union as objects, and the daemon spent 38% of its
 * main-thread samples on swap-in. The PRIMARY CONTROL is each garden reading only the steps it needs (W1-T5363,
 * W1-T5364); a garden that outgrows this fails its own pass. MEASURED 2026-10-03: config-gardener's unfiltered 60-day
 * union read peaks at 3,163 MB of heap (2.85M rows) and dies under a 1,536 MB cap, so this sits above it. Drop it to
 * 2048 once that read is filtered by step.
 */
export const GARDEN_CHILD_HEAP_LIMIT_MB = 4096;

/** A garden child's CPU niceness: a heavy pass yields the CPU to the daemon instead of competing on equal terms. */
export const GARDEN_CHILD_NICENESS = 10;

/** Noted once per refusal kind ("nice" | "ionice") when the host will not lower a garden child's priority. */
export const GARDEN_PRIORITY_DEGRADED_STEP = "garden.priority_degraded";

/** The `garden.pass` error prefix for a child that died of its heap cap, so it never reads as an ordinary failure. */
export const GARDEN_HEAP_EXHAUSTED = "heap_exhausted";

const HEAP_EXHAUSTED_STDERR = /heap out of memory/;
const STDERR_TAIL_CHARS = 8 * 1024;

/**
 * The production pass: `rmd garden run <name>` as a child of THIS process's own node and loader, so the
 * child runs the same source tree and inherits the same config root, state and ledger actor. Self-sync is
 * skipped in the child: the parent already decided which code it runs. The child runs under
 * {@link GARDEN_CHILD_HEAP_LIMIT_MB}, niced, and in the idle IO class where an `ionice` binary exists.
 */
export function childGardenPassSpawn(
  opts: {
    execPath?: string;
    execArgv?: readonly string[];
    entry?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    heapLimitMb?: number;
    setPriority?: (pid: number, priority: number) => void;
    ionice?: string;
    log?: (step: string, extra?: Record<string, unknown>) => void;
  } = {},
): GardenPassSpawn {
  const execPath = opts.execPath ?? process.execPath;
  const execArgv = opts.execArgv ?? process.execArgv;
  const entry = opts.entry ?? process.argv[1] ?? "";
  const heapLimitMb = opts.heapLimitMb ?? GARDEN_CHILD_HEAP_LIMIT_MB;
  const setPriority = opts.setPriority ?? osSetPriority;
  const log = opts.log ?? ((step, extra) => void process.stderr.write(`${JSON.stringify({ step, ...extra })}\n`));
  const noted = new Set<string>();
  const firstRefusal = (how: "nice" | "ionice"): boolean => !noted.has(how) && noted.add(how).has(how);
  const refusal = (how: "nice" | "ionice", e: unknown) => ({ how, error: String((e as Error)?.message ?? e) });
  return (name, args) =>
    new Promise((resolve, reject) => {
      // The cap follows the inherited flags: V8 takes the last `--max-old-space-size` it is given.
      const child = spawn(execPath, [...execArgv, `--max-old-space-size=${heapLimitMb}`, entry, "garden", "run", name, ...args], {
        cwd: opts.cwd,
        env: { ...(opts.env ?? process.env), [SELF_SYNC_GUARD_ENV]: "1" },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = `${stderr}${String(chunk)}`.slice(-STDERR_TAIL_CHARS);
      });
      let lowered: Promise<void> = Promise.resolve();
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          setPriority(pid, GARDEN_CHILD_NICENESS);
        } catch (e) {
          if (firstRefusal("nice")) log(GARDEN_PRIORITY_DEGRADED_STEP, refusal("nice", e));
        }
        lowered = new Promise((done) => {
          execFile(opts.ionice ?? "ionice", ["-c", "3", "-p", String(pid)], { timeout: 5_000 }, (e) => {
            // A child that already exited cannot be re-classed; that is not the host refusing.
            if (e && child.exitCode === null && child.signalCode === null && firstRefusal("ionice")) {
              log(GARDEN_PRIORITY_DEGRADED_STEP, refusal("ionice", e));
            }
            done();
          });
        });
      }
      child.once("error", reject);
      child.once("close", (code, signal) => {
        void lowered.then(() => {
          if (signal !== null && HEAP_EXHAUSTED_STDERR.test(stderr)) {
            reject(new Error(`${GARDEN_HEAP_EXHAUSTED}: garden ${name} exceeded its ${heapLimitMb} MB heap cap (${signal})`));
          } else {
            resolve(code);
          }
        });
      });
    });
}

/** The GitHub reads a selector-shadow pass makes; each absent one goes through the gh transport. */
type SelectorShadowGhReads = NonNullable<Parameters<typeof readCoverageShardLogsAsync>[3]>;

/** test-with-retry.mjs names a shard's first-pass failing files on this line (GitHub prefixes a timestamp). */
const MAIN_FAILED_FILES = /^(?:\S+Z )?FLAKE-RETRY-FILES: retrying \d+ failed file\(s\)(?: uninstrumented)? — (.+)$/;

/**
 * W1-T5409: test files failing in main's own CI at a sha. On main the coverage shards skip their run
 * (W1-T1033), so the failures are read from the eight `ci-shard (k/8)` jobs of the newest completed
 * main run at that sha, through the same jobs/logs API the PR-run reader uses. No completed run is
 * no result (`undefined`); a malformed or incomplete read throws, which the guard ledgers as
 * `selector-shadow.base_unread`. A green run is `[]` without reading any job log.
 */
export function selectorShadowMainFailures(
  owner: string, repo: string, io: SelectorShadowGhReads = {},
): (baseSha: string) => Promise<readonly string[] | undefined> {
  const readJson = io.readJson ?? ghJsonAsync;
  const readText = io.readText ?? ((args: string[]) => ghTextAsync(args, { maxBuffer: 16 * 1024 * 1024 }));
  return async (baseSha) => {
    const listed = await readJson(["api", `repos/${owner}/${repo}/actions/workflows/ci.yml/runs?branch=main&head_sha=${baseSha}&per_page=20`,
      "--jq", "{workflow_runs: [.workflow_runs[] | {id, status, conclusion}]}"]) as { workflow_runs?: Array<{ id?: number; status?: string; conclusion?: string | null }> } | null;
    if (!listed || !Array.isArray(listed.workflow_runs) || listed.workflow_runs.some((r) => !Number.isInteger(r.id))) {
      throw new Error(`selector shadow: GitHub returned no main CI runs for ${baseSha}`);
    }
    const run = listed.workflow_runs.find((r) => r.status === "completed" && r.conclusion !== "cancelled" && r.conclusion !== "skipped");
    if (run === undefined) return undefined;
    if (run.conclusion === "success") return [];
    const body = await readJson(["api", `repos/${owner}/${repo}/actions/runs/${run.id}/jobs?per_page=100`]) as
      { total_count?: number; jobs?: Array<{ id?: number; name?: string; status?: string; conclusion?: string | null }> } | null;
    if (!body || !Array.isArray(body.jobs) || typeof body.total_count !== "number" || body.total_count > body.jobs.length) {
      throw new Error(`selector shadow: incomplete job list for main run ${run.id}`);
    }
    const shards = body.jobs.filter((job) => /^ci-shard \([1-8]\/8\)$/.test(job.name ?? ""));
    if (shards.length !== 8 || shards.some((job) => job.status !== "completed" || !Number.isInteger(job.id))) {
      throw new Error(`selector shadow: main run ${run.id} lacks eight completed test shards`);
    }
    const files = new Set<string>();
    for (const job of shards.filter((j) => j.conclusion === "failure")) {
      for (const line of (await readText(["api", `repos/${owner}/${repo}/actions/jobs/${job.id}/logs`])).split(/\r?\n/)) {
        const named = MAIN_FAILED_FILES.exec(line);
        if (named) for (const file of named[1]!.split(", ")) if (file.trim()) files.add(file.trim());
      }
    }
    return [...files].sort();
  };
}

/** W1-T4439/W1-T5409: one selector-shadow pass as the daemon builds it — the PR runs, their changed
 *  paths, and main's failures at each run's base sha, all read through `io` (absent: the gh transport). */
export function selectorShadowGardenPass(
  d: GardenerDeps, owner: string, repo: string, mintTaskId: (filingBranch: string) => string, io: SelectorShadowGhReads = {},
): () => Promise<void> {
  return async () => {
    try {
      const runs = await readSelectorShadowRunsAsync(owner, repo, undefined, {
        readJson: io.readJson,
        cachePath: join(d.stateDir, "selector-shadow-log-cache.json"),
        warn: (message) => d.log("selector-shadow.cache_failed", { message }),
        onFlakes: selectorShadowFlakeLedger(d.log),
      });
      await runSelectorShadowGardener(d, () => runs, (miss) => readSelectorShadowChangedPaths(owner, repo, miss, io.readJson), mintTaskId,
        undefined, undefined, selectorShadowMainFailures(owner, repo, io));
    } catch (e) {
      d.log("selector-shadow.gardener_failed", { error: String((e as Error)?.message ?? e) });
    }
  };
}
