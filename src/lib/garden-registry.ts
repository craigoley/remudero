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
import { readFileSync } from "node:fs";
import { setPriority as osSetPriority } from "node:os";
import { join } from "node:path";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { gardenLedgerBucket, type GardenerDeps } from "./gardener.js";
import { ghJsonAsync, ghTextAsync } from "./github-transport.js";
import { runFlakeIncidentGardener } from "./flake-incident-gardener.js";
import { FLOW_GARDENER_FAILED_STEP, flowCiReader, flowPassDue, runFlowGardener } from "./flow-gardener.js";
import { HOST_RESOURCE_MIN_INTERVAL_MS } from "./host-resource-gardener.js";
import { OVERSEER_MIN_INTERVAL_MS } from "./gardener-overseer.js";
import { SCOUT_MIN_INTERVAL_MS } from "./scout-gardener.js";
import {
  readCoverageShardLogsAsync, readSelectorShadowChangedPaths, readSelectorShadowRunsAsync, runSelectorShadowGardener,
  selectorShadowFlakeLedger,
} from "./selector-shadow-gardener.js";
import { SELF_SYNC_GUARD_ENV } from "./self-sync.js";
import { writeAtomic } from "./fs-race-safe.js";
import { randomUUID } from "node:crypto";
import type { GardenerRuntimeEvent } from "./gardener-runtime.js";

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
  // W1-T5454: the scout files the recurring failure-shaped ledger step no task or scorecard covers.
  "scout",
  // W1-T5904: the daily flow report, which files a PR stage that slowed past its baseline.
  "flow",
  "flow-remedy",
  // W1-T7421: the fix lane's own defects, clustered once a UTC day and drafted as one remedy per class.
  "fix-lane",
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
export type GardenPassSpawn = (name: RegisteredGardenName, args: readonly string[], signal: { readonly stopped: boolean; admitted?: () => void }) => Promise<number | null>;

/** Share a small host budget across all garden starters. A busy garden keeps its own pending
 * pass rather than spawning a second child, while queued passes from other gardens wait here. */
export function boundedGardenPassSpawn(spawnPass: GardenPassSpawn, width: number): GardenPassSpawn {
  if (!Number.isInteger(width) || width < 1) throw new Error("garden pass width must be a positive integer");
  type Pending = {
    name: RegisteredGardenName;
    args: readonly string[];
    signal: { readonly stopped: boolean; admitted?: () => void };
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
        .then(() => {
          if (next.signal.stopped) return null;
          next.signal.admitted?.();
          return spawnPass(next.name, next.args, next.signal);
        })
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

/** The flow garden reports once a UTC day; an hourly due probe finds the new day without a child per poll. */
const FLOW_DUE_PROBE_INTERVAL_MS = 60 * 60 * 1000;

export function gardenSchedule(name: RegisteredGardenName): GardenSchedule {
  if (name === "host-resource") {
    return { intervalFor: (i) => Math.max(1_000, Math.min(i, HOST_RESOURCE_MIN_INTERVAL_MS)), minIntervalMs: HOST_RESOURCE_MIN_INTERVAL_MS, hourly: false };
  }
  if (name === "overseer") return { intervalFor: (i) => Math.max(i, OVERSEER_MIN_INTERVAL_MS), minIntervalMs: 0, hourly: false };
  if (name === "scout") return { intervalFor: (i) => Math.max(i, SCOUT_MIN_INTERVAL_MS), minIntervalMs: 0, hourly: false };
  if (name === "flow" || name === "fix-lane") return { intervalFor: (i) => Math.max(i, FLOW_DUE_PROBE_INTERVAL_MS), minIntervalMs: 0, hourly: false };
  return { intervalFor: sameInterval, minIntervalMs: 0, hourly: name === "test" };
}

/**
 * ADAPTIVE PACING for a garden whose result depends on something no cheap local probe can see (GitHub's CI
 * runs, a model's verdicts). Each pass records whether it found anything new. While passes keep finding
 * nothing, the garden waits half its quiet span before the next one, so the wait grows with the
 * quiet and has no fixed ceiling, and a pass that finds something snaps it back to every poll. A cheap
 * `inputs` stamp (a commit, a file's mtime) snaps it back without waiting for a pass at all.
 * OBSERVED 2026-10-09 on the fleet host: selector-shadow passed 42 times an hour (about 35 s each), and 5
 * of them saw a new CI run; machine-judge passed 43 times an hour and ledgered nothing at all.
 */
export const GARDEN_QUIET_BACKOFF_DIVISOR = 2;

export interface GardenPacing {
  lastPassAt: string;
  /** The last pass that found something new; the quiet span runs from here to `lastPassAt`. */
  lastNewAt: string;
  /** The cheap inputs stamp the last pass saw, when the garden has one. */
  inputs?: string;
}

export function gardenPacingPath(stateDir: string, name: RegisteredGardenName): string {
  return join(stateDir, `${name}-garden-pacing.json`);
}

/** The recorded pacing; an absent or damaged record is none, so the next poll runs a pass. */
export function readGardenPacing(stateDir: string, name: RegisteredGardenName): GardenPacing | undefined {
  try {
    const parsed = JSON.parse(readFileSync(gardenPacingPath(stateDir, name), "utf8")) as Partial<GardenPacing>;
    if (!Number.isFinite(Date.parse(String(parsed.lastPassAt))) || !Number.isFinite(Date.parse(String(parsed.lastNewAt)))) return undefined;
    if (parsed.inputs !== undefined && typeof parsed.inputs !== "string") return undefined;
    return parsed as GardenPacing;
  } catch {
    // deliberate: no readable record means nothing has slowed this garden down yet.
    return undefined;
  }
}

/** Whether the paced garden is due: no record, changed inputs, or half its quiet span has passed. */
export function gardenPacingDue(stateDir: string, name: RegisteredGardenName, opts: { clock?: Clock; inputs?: () => string } = {}): boolean {
  const pacing = readGardenPacing(stateDir, name);
  if (pacing === undefined) return true;
  if (opts.inputs !== undefined && opts.inputs() !== pacing.inputs) return true;
  const last = Date.parse(pacing.lastPassAt); // expiring-fixture: exempt -- written by recordGardenPacing from the injected clock; tests derive it from that clock, never a fixed literal.
  const quiet = Math.max(0, last - Date.parse(pacing.lastNewAt));
  return (opts.clock ?? systemClock).now() - last >= quiet / GARDEN_QUIET_BACKOFF_DIVISOR;
}

/** Record one finished pass of a paced garden: `found` is whether it found anything new. */
export function recordGardenPacing(stateDir: string, name: RegisteredGardenName, found: boolean, opts: { clock?: Clock; inputs?: string } = {}): void {
  const at = (opts.clock ?? systemClock).iso();
  const prior = readGardenPacing(stateDir, name);
  const pacing: GardenPacing = { lastPassAt: at, lastNewAt: found || prior === undefined ? at : prior.lastNewAt,
    ...(opts.inputs === undefined ? {} : { inputs: opts.inputs }) };
  writeAtomic(gardenPacingPath(stateDir, name), JSON.stringify(pacing) + "\n");
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
  observe?: (event: GardenerRuntimeEvent) => void;
}

export function startGardenOffLoop(name: RegisteredGardenName, intervalMs: number, wiring: GardenOffLoopWiring): { stop: () => void } {
  const clock = wiring.clock ?? systemClock;
  const schedule = gardenSchedule(name);
  const timerIntervalMs = schedule.intervalFor(intervalMs);
  const timerAnchorMs = clock.now();
  const signal = { stopped: false };
  let running = false;
  let lastStartMs = -Infinity;
  let reportedBucket: number | undefined;
  const observe = (event: GardenerRuntimeEvent): void => {
    try { wiring.observe?.(event); }
    catch { wiring.log("garden.telemetry_failed", { name, reason: "observer-failed" }); }
  };
  const nextEligibleCheck = (): string => {
    const now = clock.now();
    const earliest = Math.max(now, lastStartMs + schedule.minIntervalMs);
    const ticks = Math.max(1, Math.ceil((earliest - timerAnchorMs) / timerIntervalMs));
    const next = timerAnchorMs + ticks * timerIntervalMs;
    return fixedClock(next <= now ? next + timerIntervalMs : next).iso();
  };
  const event = (phase: GardenerRuntimeEvent["phase"], fields: Partial<GardenerRuntimeEvent> = {}): GardenerRuntimeEvent => ({
    name, phase, observedAt: clock.iso(), passId: null,
    nextDueAt: nextEligibleCheck(),
    queueMs: null, executionMs: null, exit: null, reason: null, ...fields,
  });
  const tick = (): void => {
    if (running || signal.stopped || clock.now() - lastStartMs < schedule.minIntervalMs) return;
    const bucket = gardenLedgerBucket(clock);
    const hourly = schedule.hourly && bucket !== reportedBucket;
    if (!hourly && wiring.due) {
      try {
        if (!wiring.due()) { observe(event("idle", { reason: "inputs-unchanged" })); return; }
      } catch (e) {
        wiring.log(GARDEN_DUE_FAILED_STEP, { name, error: String((e as Error)?.message ?? e) });
      }
    }
    running = true;
    const startedMs = clock.now();
    lastStartMs = startedMs;
    const passId = randomUUID();
    let admittedMs: number | undefined;
    observe(event("queued", { passId, nextDueAt: null }));
    const passSignal = {
      get stopped() { return signal.stopped; },
      admitted: () => {
        admittedMs = clock.now();
        observe(event("running", { passId, nextDueAt: null, queueMs: Math.max(0, admittedMs - startedMs) }));
      },
    };
    const settle = (exit: number | null, error?: string): void => {
      running = false;
      if (hourly && exit === 0) reportedBucket = bucket;
      // One completion timestamp for both destinations: the logger's own latency
      // is not child execution, and the persisted card can correlate this row.
      const finishedMs = clock.now();
      const queueMs = admittedMs === undefined ? null : Math.max(0, admittedMs - startedMs);
      const executionMs = admittedMs === undefined ? null : Math.max(0, finishedMs - admittedMs);
      wiring.log(GARDEN_PASS_STEP, { name, passId, ms: finishedMs - startedMs, queueMs, executionMs, exit,
        ...(error === undefined ? {} : { error }) });
      const phase = error !== undefined || (exit !== null && exit !== 0) ? "failed" : exit === 0 ? "completed" : "cancelled";
      observe(event(phase, { passId, exit,
        queueMs, executionMs,
        reason: error !== undefined ? "spawn-failed" : exit === 0 ? "process-completed" : exit === null ? "signal-or-cancelled" : "process-failed" }));
    };
    let pass: Promise<number | null>;
    try {
      pass = wiring.spawnPass(name, hourly ? [GARDEN_HOURLY_FLAG] : [], passSignal);
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
  const timer = setInterval(tick, timerIntervalMs);
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
 * W1-T5364, W1-T5474); a garden that outgrows this fails its own pass. W1-T5474 filtered the last unfiltered reader,
 * config-gardener's 60-day union read (3,163 MB of heap over 2.85M rows, dead under a 1,536 MB cap), to the steps it
 * prices: MEASURED 2026-10-03 on the live corpus, 79,826 rows at a 211 MB heap peak, so 2048 MB holds it with room.
 */
export const GARDEN_CHILD_HEAP_LIMIT_MB = 2048;

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
      let heapExhaustedSeen = false;
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const captured = `${stderr}${String(chunk)}`;
        // Classify the stream before bounding its diagnostic tail: a long native backtrace
        // can displace the fatal signature, including when a single chunk exceeds the cap.
        heapExhaustedSeen ||= HEAP_EXHAUSTED_STDERR.test(captured);
        stderr = captured.slice(-STDERR_TAIL_CHARS);
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
          if (signal !== null && heapExhaustedSeen) {
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
 *  paths, main's failures at each run's base sha and (W1-T5925) a bounded replay of older failing runs,
 *  all read through `io` (absent: the gh transport). */
export function selectorShadowGardenPass(
  d: GardenerDeps, owner: string, repo: string, mintTaskId: (filingBranch: string) => string, io: SelectorShadowGhReads = {},
): (() => Promise<void>) & { due: () => boolean } {
  const pass = async (): Promise<void> => {
    // New evidence is a newly complete CI run stored, or a replay slice of history read; nothing else in
    // this pass changes without one of them.
    let found = false;
    try {
      const runs = await readSelectorShadowRunsAsync(owner, repo, undefined, {
        readJson: io.readJson,
        cachePath: join(d.stateDir, "selector-shadow-log-cache.json"),
        warn: (message) => d.log("selector-shadow.cache_failed", { message }),
        onFlakes: selectorShadowFlakeLedger(d.log),
      });
      const report = await runSelectorShadowGardener(d, () => runs, (miss) => readSelectorShadowChangedPaths(owner, repo, miss, io.readJson), mintTaskId,
        undefined, undefined, selectorShadowMainFailures(owner, repo, io),
        { replay: { owner, repo, readJson: io.readJson, readText: io.readText } });
      found = report.observations.appended > 0 || (report.replayPass?.attempted ?? 0) > 0;
    } catch (e) {
      d.log("selector-shadow.gardener_failed", { error: String((e as Error)?.message ?? e) });
    }
    // W1-T6406: the flake-incident garden runs in the pass that ledgers its evidence, on the same checkout,
    // so it needs no second child process and no second garden branch form. It reads the ledger union, so
    // a failed run read above does not stop it from judging what earlier passes recorded.
    try {
      await runFlakeIncidentGardener(d, {
        mintTaskId,
        readChangedPaths: (baseSha, headSha) => readSelectorShadowChangedPaths(owner, repo, { baseSha, headSha }, io.readJson),
      });
    } catch (e) {
      d.log("flake_incident.gardener_failed", { error: String((e as Error)?.message ?? e) });
    }
    try {
      recordGardenPacing(d.stateDir, "selector-shadow", found, { clock: d.clock });
    } catch (e) {
      d.log("selector-shadow.pacing_failed", { error: String((e as Error)?.message ?? e) });
    }
  };
  return Object.assign(pass, { due: () => gardenPacingDue(d.stateDir, "selector-shadow", { clock: d.clock }) });
}

/** W1-T5904: one daily flow pass as the daemon builds it — the ledger union, GitHub's CI timings through
 *  `io` (absent: the gh transport) and the shared filing path. Its due probe skips a reported day. */
export function flowGardenPass(
  d: GardenerDeps, owner: string, repo: string, mintTaskId: (filingBranch: string) => string, io: Pick<SelectorShadowGhReads, "readJson"> = {},
): (() => Promise<void>) & { due: () => boolean } {
  const pass = async (): Promise<void> => {
    try {
      await runFlowGardener(d, { mintTaskId, readCi: flowCiReader(owner, repo, io.readJson) });
    } catch (e) {
      d.log(FLOW_GARDENER_FAILED_STEP, { error: String((e as Error)?.message ?? e) });
    }
  };
  return Object.assign(pass, { due: () => flowPassDue(d.stateDir, d.clock) });
}
