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
import { BoundedOutput } from "./bounded-file-tail.js";
import { RmdError } from "./errors.js";
import { inboxGardenerMode } from "./inbox-retirement.js";
import { execFileLoopBounded } from "./loop-bounded-child.js";
import { readFileSync } from "node:fs";
import { homedir, setPriority as osSetPriority } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHILD_ENTRY_SPAWNED_STEP, childEntryArgv, childEntrySpawnedRow } from "./child-entry-argv.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { gardenLedgerBucket, type GardenerDeps } from "./gardener.js";
import { ghJsonAsync, ghTextAsync } from "./github-transport.js";
import { runFlakeIncidentGardener } from "./flake-incident-gardener.js";
import { FLOW_GARDENER_FAILED_STEP, flowCiReader, flowPassDue, runFlowGardener, type AdmissionFlowInput } from "./flow-gardener.js";
import { HOST_RESOURCE_MIN_INTERVAL_MS } from "./host-resource-gardener.js";
import { OVERSEER_MIN_INTERVAL_MS } from "./gardener-overseer.js";
import { ISSUE_REVALIDATION_FAILED_STEP, ISSUE_REVALIDATION_MIN_INTERVAL_MS, runIssueRevalidationGarden, type IssueRevalidationPorts } from "./issue-revalidation-garden.js";
import { SCOUT_MIN_INTERVAL_MS } from "./scout-gardener.js";
import {
  readCoverageShardLogsAsync, readSelectorShadowChangedPaths, readSelectorShadowRunsAsync, runSelectorShadowGardener,
  selectorShadowFlakeLedger,
} from "./selector-shadow-gardener.js";
import { SELF_SYNC_GUARD_ENV } from "./self-sync.js";
import { awaitMemoryAdmission, endDeferralStreak, type AdmissionPorts } from "./host-memory-admission.js";
import { daemonOwnedProcess, openLearnedReservation, type LearnedReservation } from "./host-memory-learning.js";
import { recordShadowMemoryVerdict } from "./host-memory-shadow.js";
import { writeAtomic } from "./fs-race-safe.js";
import { randomUUID } from "node:crypto";
import { GARDENER_RUNTIME_FILE, medianMs, parseGardenerRuntime, standingDueInterval, type DueInterval, type GardenerRuntimeEvent } from "./gardener-runtime.js";
import { GARDENER_ORIGIN_ENV, gardenerOriginEnv } from "./worker-containment.js";

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
  // W1-T5420: append the formerly separate knowledge starter; existing registered slots stay unchanged.
  "knowledge",
  // W1-T8864: every open issue re-checked against current evidence, shadow-first.
  "issue-revalidation",
  "inbox",
  "review-replay",
  // W1-T9925: an LLM judge re-ranks queued tasks by measured cost of delay and is scored on its own predictions.
  "queue-judge",
  // Operator ruling 2026-10-30: the plan Architect amends a task its fix lane stood down on, through a reviewed plan PR.
  "redesign",
] as const;

export type RegisteredGardenName = (typeof REGISTERED_GARDEN_NAMES)[number];
/** Disabled Inbox mode is represented consistently in starters, due probes and runtime health. */
export function registeredGardenEnabled(name: RegisteredGardenName, isSelf: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return isSelf && (name !== "inbox" || inboxGardenerMode(env) !== "off");
}

export function isRegisteredGardenName(name: string): name is RegisteredGardenName {
  return (REGISTERED_GARDEN_NAMES as readonly string[]).includes(name);
}

/** The ledger step one row per pass carries, so a slow gardener is named rather than inferred from loop lag. */
export const GARDEN_PASS_STEP = "garden.pass";

/** A garden's due probe threw; its pass runs anyway and reports the failure itself. */
export const GARDEN_DUE_FAILED_STEP = "garden.due_failed";

/** The child's flag for "this pass also refreshes its hourly evidence" (the test garden's feed). */
export const GARDEN_HOURLY_FLAG = "--hourly";

/** A resource hold did not start a process; it is neither a signal exit nor a successful pass. */
export type GardenPassOutcome = number | null | { kind: "deferred"; reason: "memory-budget-shortfall" | "admission-rank" };
/** W1-T9761, W1-T9975: the garden's own pass cadence, its DUE INTERVAL (from a completed pass to the first ask of its
 *  next one; admission and pass-pool wait are not in it), and whether this is its first ask in this process, when a
 *  restart's wait is seeded. "measured" is this process's own median of two or more intervals (joined to the carried
 *  one), "carried" the previous generation's, "scheduled" the timer interval when neither exists. `samples` is the
 *  number of intervals behind the figure. */
export interface GardenDeferral { cadenceMs: number; cadenceBasis: "measured" | "carried" | "scheduled"; samples: number; firstAsk: boolean }
/** Runs ONE pass. The optional admitted notification means a successfully spawned child,
 * not ownership of a pool slot or a memory grant; injected process producers must signal it explicitly. */
export type GardenPassSpawn = (name: RegisteredGardenName, args: readonly string[], signal: { readonly stopped: boolean; readonly passId?: string; admitted?: () => void; readonly deferral?: GardenDeferral }) => Promise<GardenPassOutcome>;

/** The run id a garden's admission rows and deferral streak carry. */
export function gardenRunId(name: string): string {
  return `garden-${name}`;
}

/** The median of this process's own due intervals, or the scheduled interval while fewer than two are measured. Pure. */
export function gardenCadence(intervalsMs: readonly number[], scheduledMs: number): Pick<GardenDeferral, "cadenceMs" | "cadenceBasis" | "samples"> {
  if (intervalsMs.length < 2) return { cadenceMs: scheduledMs, cadenceBasis: "scheduled", samples: intervalsMs.length };
  return { cadenceMs: medianMs(intervalsMs)!, cadenceBasis: "measured", samples: intervalsMs.length };
}

/** A restart's carried due interval joined to the loop's own deferral: own intervals stand once there are two, the carried
 *  one below that, and the scheduled interval only with neither. Pure. */
export function gardenCadenceWithCarried(own: GardenDeferral, carried: DueInterval | undefined): Pick<GardenDeferral, "cadenceMs" | "cadenceBasis" | "samples"> {
  const standing = standingDueInterval(own.cadenceBasis === "measured" ? { medianMs: own.cadenceMs, samples: own.samples } : undefined, carried);
  return standing === undefined ? { cadenceMs: own.cadenceMs, cadenceBasis: own.cadenceBasis, samples: own.samples } :
    { cadenceMs: standing.interval.medianMs, cadenceBasis: standing.basis, samples: standing.interval.samples };
}

/** Share a small host budget across all garden starters. A busy garden keeps its own pending
 * pass rather than spawning a second child, while queued passes from other gardens wait here. */
export function boundedGardenPassSpawn(spawnPass: GardenPassSpawn, width: number): GardenPassSpawn {
  if (!Number.isInteger(width) || width < 1) throw new Error("garden pass width must be a positive integer");
  type Pending = {
    name: RegisteredGardenName;
    args: readonly string[];
    signal: Parameters<GardenPassSpawn>[2];
    resolve: (exit: GardenPassOutcome) => void;
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
          return spawnPass(next.name, next.args, next.signal);
        })
        .then(next.resolve, next.reject)
        .finally(() => {
          active -= 1;
          admit();
        });
    }
  };
  return (name, args, signal) => new Promise<GardenPassOutcome>((resolve, reject) => {
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
  if (name === "inbox") return { intervalFor: i => Math.max(i, 15 * 60_000), minIntervalMs: 15 * 60_000, hourly: false };
  if (name === "host-resource") {
    return { intervalFor: (i) => Math.max(1_000, Math.min(i, HOST_RESOURCE_MIN_INTERVAL_MS)), minIntervalMs: HOST_RESOURCE_MIN_INTERVAL_MS, hourly: false };
  }
  if (name === "flow-remedy") return { intervalFor: sameInterval, minIntervalMs: HOST_RESOURCE_MIN_INTERVAL_MS, hourly: false };
  if (name === "overseer") return { intervalFor: (i) => Math.max(i, OVERSEER_MIN_INTERVAL_MS), minIntervalMs: 0, hourly: false };
  if (name === "scout") return { intervalFor: (i) => Math.max(i, SCOUT_MIN_INTERVAL_MS), minIntervalMs: 0, hourly: false };
  if (name === "flow" || name === "fix-lane") return { intervalFor: (i) => Math.max(i, FLOW_DUE_PROBE_INTERVAL_MS), minIntervalMs: 0, hourly: false };
  if (name === "issue-revalidation") {
    return { intervalFor: (i) => Math.max(i, ISSUE_REVALIDATION_MIN_INTERVAL_MS), minIntervalMs: ISSUE_REVALIDATION_MIN_INTERVAL_MS, hourly: false };
  }
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
function gardenQuietSpanDue(pacing: GardenPacing, clock: Clock): boolean {
  const last = Date.parse(pacing.lastPassAt); // expiring-fixture: exempt -- written by recordGardenPacing from the injected clock; tests derive it from that clock.
  const quiet = Math.max(0, last - Date.parse(pacing.lastNewAt));
  return clock.now() - last >= quiet / GARDEN_QUIET_BACKOFF_DIVISOR;
}

export function gardenPacingDue(stateDir: string, name: RegisteredGardenName, opts: { clock?: Clock; inputs?: () => string } = {}): boolean {
  const pacing = readGardenPacing(stateDir, name);
  if (pacing === undefined) return true;
  if (name === "host-resource" || name === "flow-remedy") {
    const elapsed = (opts.clock ?? systemClock).now() - Date.parse(pacing.lastPassAt);
    if (elapsed < HOST_RESOURCE_MIN_INTERVAL_MS) return false;
    if (name === "host-resource" && elapsed >= FLOW_DUE_PROBE_INTERVAL_MS) return true;
    return opts.inputs === undefined || opts.inputs() !== pacing.inputs;
  }
  if (opts.inputs !== undefined && opts.inputs() !== pacing.inputs) return true;
  return gardenQuietSpanDue(pacing, opts.clock ?? systemClock);
}

export async function gardenPacingDueAsync(stateDir: string, name: RegisteredGardenName, opts: { clock?: Clock; inputs?: () => string | Promise<string> } = {}): Promise<boolean> {
  const pacing = readGardenPacing(stateDir, name);
  if (pacing === undefined) return true;
  if (name === "host-resource" || name === "flow-remedy") {
    const elapsed = (opts.clock ?? systemClock).now() - Date.parse(pacing.lastPassAt);
    if (elapsed < HOST_RESOURCE_MIN_INTERVAL_MS) return false;
    if (name === "host-resource" && elapsed >= FLOW_DUE_PROBE_INTERVAL_MS) return true;
    return opts.inputs === undefined || await opts.inputs() !== pacing.inputs;
  }
  if (opts.inputs !== undefined && await opts.inputs() !== pacing.inputs) return true;
  return gardenQuietSpanDue(pacing, opts.clock ?? systemClock);
}

/** Record one finished pass of a paced garden: `found` is whether it found anything new. */
export function recordGardenPacing(stateDir: string, name: RegisteredGardenName, found: boolean, opts: { clock?: Clock; inputs?: string } = {}): void {
  const at = (opts.clock ?? systemClock).iso();
  const prior = readGardenPacing(stateDir, name);
  const pacing: GardenPacing = { lastPassAt: at, lastNewAt: found || prior === undefined ? at : prior.lastNewAt,
    ...(opts.inputs === undefined ? {} : { inputs: opts.inputs }) };
  writeAtomic(gardenPacingPath(stateDir, name), JSON.stringify(pacing) + "\n");
}

/** Persistent low-yield pacing at the same production pass/probe boundary. Capture inputs BEFORE
 *  awaiting the child, so a mid-pass change remains due; a rejected pass writes no completion. */
export function lowYieldGardenPass(
  stateDir: string, name: "host-resource" | "flow-remedy",
  pass: (() => void | Promise<void>) & { due?: () => boolean | Promise<boolean> },
  opts: { clock?: Clock; inputs: () => string },
): (() => Promise<void>) & { due: () => boolean | Promise<boolean> } {
  const run = async (): Promise<void> => {
    const startedAt = (opts.clock ?? systemClock).now();
    const inputs = opts.inputs();
    await pass();
    recordGardenPacing(stateDir, name, true, { clock: fixedClock(startedAt), inputs });
  };
  return Object.assign(run, { due: () => gardenPacingDue(stateDir, name, opts) && (pass.due?.() ?? true) });
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
  due?: () => boolean | Promise<boolean>;
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
  let idleBucket: number | undefined;
  // W1-T9975: each completed pass's due interval, and the open due period's first ask.
  const dueIntervalsMs: number[] = [];
  let lastCompletionMs: number | undefined;
  let periodFirstAskMs: number | undefined;
  let asked = false;
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
  const idle = (bucket: number): void => {
    const lowYield = name === "host-resource" || name === "flow-remedy";
    if (!lowYield || idleBucket !== bucket) observe(event("idle", { reason: "inputs-unchanged" }));
    idleBucket = bucket;
    asked = true;
    endDeferralStreak(gardenRunId(name)); // a garden that is not due no longer asks
  };
  const deferral = (): GardenDeferral => {
    const firstAsk = !asked;
    asked = true;
    return { ...gardenCadence(dueIntervalsMs, Math.max(timerIntervalMs, schedule.minIntervalMs)), firstAsk };
  };
  const runPass = (bucket: number, hourly: boolean): void => {
    running = true;
    const startedMs = clock.now();
    lastStartMs = startedMs;
    periodFirstAskMs ??= startedMs; // a deferred re-ask of the same due period does not open a new one
    const passId = randomUUID();
    let admittedMs: number | undefined;
    let settled = false;
    observe(event("queued", { passId, nextDueAt: null }));
    const passSignal = {
      passId,
      deferral: deferral(),
      get stopped() { return signal.stopped; },
      admitted: () => {
        if (settled || admittedMs !== undefined) return;
        admittedMs = clock.now();
        observe(event("running", { passId, nextDueAt: null, queueMs: Math.max(0, admittedMs - startedMs) }));
      },
    };
    const settle = (outcome: GardenPassOutcome, error?: string, report?: GardenReportError): void => {
      settled = true;
      const deferred = typeof outcome === "object" && outcome !== null;
      const exit = report ? report.childExit : deferred ? null : outcome;
      running = false;
      if (hourly && exit === 0 && error === undefined) reportedBucket = bucket;
      // One completion timestamp for both destinations: the logger's own latency
      // is not child execution, and the persisted card can correlate this row.
      const finishedMs = clock.now();
      let dueIntervalMs: number | undefined;
      if (!deferred) {
        if (lastCompletionMs !== undefined && periodFirstAskMs !== undefined) {
          dueIntervalMs = Math.max(0, periodFirstAskMs - lastCompletionMs);
          dueIntervalsMs.push(dueIntervalMs);
        }
        lastCompletionMs = finishedMs;
        periodFirstAskMs = undefined;
      }
      const queueMs = admittedMs === undefined ? null : Math.max(0, admittedMs - startedMs);
      const executionMs = deferred || admittedMs === undefined ? null : Math.max(0, finishedMs - admittedMs);
      wiring.log(GARDEN_PASS_STEP, { name, passId, ms: finishedMs - startedMs, queueMs, executionMs, exit,
        ...(deferred ? { reason: outcome.reason } : {}), ...(error === undefined ? {} : { error }),
        ...(report ? { signal: report.signal, output_retention: report.retained.evidence,
          stderr: report.retained.chunks.join("") } : {}) });
      const phase = deferred ? "idle" : error !== undefined || (exit !== null && exit !== 0) ? "failed" : exit === 0 ? "completed" : "cancelled";
      observe(event(phase, { passId, exit,
        queueMs, executionMs, ...(dueIntervalMs === undefined ? {} : { dueIntervalMs }),
        reason: deferred ? outcome.reason : report ? "process-failed" : error !== undefined ? "spawn-failed" : exit === 0 ? "process-completed" : exit === null ? "signal-or-cancelled" : "process-failed" }));
    };
    let pass: Promise<GardenPassOutcome>;
    try {
      pass = wiring.spawnPass(name, hourly ? [GARDEN_HOURLY_FLAG] : [], passSignal);
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      settle(null, error);
      return;
    }
    pass.then(
      (exit) => settle(exit),
      (e: unknown) => settle(null, String((e as Error)?.message ?? e), e instanceof GardenReportError ? e : undefined),
    );
  };
  const tick = (): void => {
    if (running || signal.stopped || clock.now() - lastStartMs < schedule.minIntervalMs) return;
    const bucket = gardenLedgerBucket(clock);
    const hourly = schedule.hourly && bucket !== reportedBucket;
    if (!hourly && wiring.due) {
      try {
        const due = wiring.due();
        if (due && typeof (due as Promise<boolean>).then === "function") {
          running = true;
          Promise.resolve(due).then((isDue) => {
            running = false;
            if (signal.stopped) return;
            if (!isDue) { idle(bucket); return; }
            runPass(bucket, hourly);
          }, (error: unknown) => {
            running = false;
            wiring.log(GARDEN_DUE_FAILED_STEP, { name, error: String((error as Error)?.message ?? error) });
            if (!signal.stopped) runPass(bucket, hourly);
          });
          return;
        }
        if (!due) { idle(bucket); return; }
      } catch (error) {
        wiring.log(GARDEN_DUE_FAILED_STEP, { name, error: String((error as Error)?.message ?? error) });
      }
    }
    runPass(bucket, hourly);
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

/** Each garden's last completed pass and measured due interval in the runtime file the previous daemon generation left;
 *  none when unreadable. */
function priorGardenRuntime(stateDir: string): Map<string, { completedMs?: number; interval?: DueInterval }> {
  const out = new Map<string, { completedMs?: number; interval?: DueInterval }>();
  try {
    for (const g of parseGardenerRuntime(JSON.parse(readFileSync(join(stateDir, GARDENER_RUNTIME_FILE), "utf8"))).gardens) {
      out.set(g.name, { ...(g.lastCompletedAt === null ? {} : { completedMs: Date.parse(g.lastCompletedAt) }),
        ...(g.dueIntervalMedianMs === null ? {} : { interval: { medianMs: g.dueIntervalMedianMs, samples: g.dueIntervalSamples } }) });
    }
  } catch {
    // deliberate: no readable runtime file means no earlier pass to seed a wait from; the streak starts at its first ask.
  }
  return out;
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
const STDERR_TAIL_BYTES = 8 * 1024;

/** A failed report keeps the child's observed exit separate from the evidence failure. */
class GardenReportError extends RmdError {
  constructor(message: string, readonly childExit: number | null, readonly signal: NodeJS.Signals | null,
    readonly retained: ReturnType<BoundedOutput["finish"]>) {
    super("gardener", 1, message);
  }
}

/** The harness tree this module runs from: where the precompiled run-task entry for a garden child lives. */
const HARNESS_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX_LOADER_FLAG = /^(?:--import|--require|-r|--loader|--experimental-loader)$/;

/** `execArgv` without the tsx loader flags (`--import tsx`, `--require .../tsx/...`, either spelling). */
function withoutTsxLoader(execArgv: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const flag = execArgv[i]!;
    const inline = /^(--import|--require|--loader|--experimental-loader)=(.*)$/.exec(flag);
    if (inline) {
      if (!/tsx/.test(inline[2]!)) kept.push(flag);
    } else if (TSX_LOADER_FLAG.test(flag) && /tsx/.test(execArgv[i + 1] ?? "")) {
      i++;
    } else {
      kept.push(flag);
    }
  }
  return kept;
}

/**
 * W1-T8778: the node argv for one garden child. With no caller-given execArgv/entry (`implicit`) and a current
 * precompiled run-task bundle (childEntryArgv), the child runs it under plain node: the inherited tsx loader flags
 * are dropped, the heap cap follows every other flag, and no tsx cache is opened. Any other answer, and any
 * explicit execArgv/entry, runs exactly as before. Either way `child_entry.spawned` records the kind and why.
 */
export function gardenChildNodeArgv(
  name: string,
  args: readonly string[],
  heapLimitMb: number,
  inherited: { execArgv: readonly string[]; entry: string },
  implicit: boolean,
  log: (step: string, extra?: Record<string, unknown>) => void,
  root: string = HARNESS_ROOT,
): string[] {
  const cap = `--max-old-space-size=${heapLimitMb}`;
  const legacy = [...inherited.execArgv, cap, inherited.entry, "garden", "run", name, ...args];
  if (!implicit) return legacy;
  const launch = childEntryArgv(root, "run-task", "src/run-task.ts", ["garden", "run", name, ...args], undefined, { log });
  log(CHILD_ENTRY_SPAWNED_STEP, childEntrySpawnedRow("run-task", `garden run ${name}`, launch));
  return launch.kind === "bundle" ? [...withoutTsxLoader(inherited.execArgv), cap, ...launch.argv] : legacy;
}

/**
 * The production pass: `rmd garden run <name>` as a child of THIS process's own node and loader, so the
 * child runs the same source tree and inherits the same config root, state and ledger actor. Self-sync is
 * skipped in the child: the parent already decided which code it runs. The child runs under
 * {@link GARDEN_CHILD_HEAP_LIMIT_MB}, niced, and in the idle IO class where an `ionice` binary exists. In a
 * daemon-owned process each child also holds a "garden" host-memory reservation for its lifetime (about 1 GB each,
 * 2-3 at once, measured 2026-10-10 and unreserved until now). Under an enforced garden budget (operator 2026-10-14) a
 * child that would not fit is DEFERRED, not waited for: no child starts, memory_budget.enforce_defer names it, the pass
 * resolves null, and with no pacing recorded the garden stays due for its next tick.
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
    /** The state root whose ledger the budget reads. Default: the config default, `~/Remudero`. */
    root?: string;
    /** Opens the child's reservation. Default: a learned "garden" reservation in a daemon-owned process, else none. */
    reserve?: () => LearnedReservation | undefined;
    /** The enforce-mode admission's ports (tests). */
    admission?: Partial<AdmissionPorts>;
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
  const root = opts.root ?? join(homedir(), "Remudero");
  const reserve = opts.reserve ??
    (() => (daemonOwnedProcess() ? openLearnedReservation({ workerClass: "garden", root }) : undefined));
  // Read BEFORE this generation's runtime writer replaces the file: the last generation's completed passes.
  const prior = priorGardenRuntime(join(root, "state"));
  return async (name, args, signal) => {
    const earlier = prior.get(name);
    const d = signal.deferral === undefined ? undefined : { ...signal.deferral, ...gardenCadenceWithCarried(signal.deferral, earlier?.interval) };
    const last = d?.firstAsk ? earlier?.completedMs : undefined;
    const admission = await awaitMemoryAdmission({ workerClass: "garden", root, taskId: "GARDEN", runId: gardenRunId(name), reserve,
      onShortfall: "defer", ...(d ? { deferral: { cadenceMs: d.cadenceMs, cadenceBasis: d.cadenceBasis, samples: d.samples,
        ...(last === undefined ? {} : { dueSinceMs: last + d.cadenceMs }) } } : {}) }, opts.admission);
    if (admission.kind === "deferred") return { kind: "deferred", reason: admission.basis === "rank" ? "admission-rank" : "memory-budget-shortfall" };
    const reservation = "reservation" in admission ? admission.reservation :
      admission.kind === "error" && admission.reservationAttempted ? undefined : reserve();
    // The same counterfactual row a worker start writes, so a garden start's fit is measured before any ruling.
    if (reservation) {
      recordShadowMemoryVerdict({ workerClass: "garden", reservationId: reservation.id, estimateMib: reservation.estimateMib, root,
        taskId: "GARDEN", runId: `garden-${name}` }, opts.admission);
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      if (admission.kind === "admitted") admission.endAged?.();
      reservation?.releaseOccupancy();
    };
    if (signal.stopped) {
      release();
      return null;
    }
    return new Promise<number | null>((resolve, reject) => {
      // The cap follows the inherited flags: V8 takes the last `--max-old-space-size` it is given.
      const nodeArgv = gardenChildNodeArgv(name, args, heapLimitMb, { execArgv, entry }, opts.execArgv === undefined && opts.entry === undefined, log);
      const child = spawn(execPath, nodeArgv, {
        cwd: opts.cwd,
        env: { ...(opts.env ?? process.env), [SELF_SYNC_GUARD_ENV]: "1",
          [GARDENER_ORIGIN_ENV]: gardenerOriginEnv(name, signal.passId) },
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.once("spawn", () => signal.admitted?.());
      const stderr = new BoundedOutput(STDERR_TAIL_BYTES);
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      let stderrFailure: { state: "unreadable" | "malformed"; reason: string } | undefined;
      let stderrBytes = 0;
      let heapSuffix = "";
      let heapExhaustedSeen = false;
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        // The fatal signature is ASCII; decoding failures must not erase a heap verdict.
        const captured = heapSuffix + chunk.toString("latin1");
        heapExhaustedSeen ||= HEAP_EXHAUSTED_STDERR.test(captured);
        heapSuffix = captured.slice(-32);
        if (stderrFailure) return;
        try {
          stderr.push(decoder.decode(chunk, { stream: true }));
        } catch (error) {
          stderrFailure = { state: "malformed", reason: String((error as Error)?.message ?? error).slice(0, 240) };
        }
      });
      child.stderr?.once("error", (error) => {
        stderrFailure = { state: "unreadable", reason: error.message.slice(0, 240) };
      });
      let lowered: Promise<void> = Promise.resolve();
      const pid = child.pid;
      if (pid !== undefined) {
        reservation?.bindRoot(pid);
        try {
          setPriority(pid, GARDEN_CHILD_NICENESS);
        } catch (e) {
          if (firstRefusal("nice")) log(GARDEN_PRIORITY_DEGRADED_STEP, refusal("nice", e));
        }
        lowered = execFileLoopBounded(opts.ionice ?? "ionice", ["-c", "3", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 }).then(
          () => undefined,
          (e: Error) => {
            // A child that already exited cannot be re-classed; that is not the host refusing.
            if (child.exitCode === null && child.signalCode === null && firstRefusal("ionice")) {
              log(GARDEN_PRIORITY_DEGRADED_STEP, refusal("ionice", e));
            }
          },
        );
      }
      child.once("error", (error) => {
        release();
        reject(error);
      });
      child.once("close", (code, signal) => {
        release();
        if (!stderrFailure) {
          try { stderr.push(decoder.decode()); }
          catch (error) {
            stderrFailure = { state: "malformed", reason: String((error as Error)?.message ?? error).slice(0, 240) };
          }
        }
        const retained = stderr.finish();
        if (stderrFailure) retained.evidence = { ...retained.evidence, ...stderrFailure, fileBytes: stderrBytes };
        void lowered.then(() => {
          if (signal !== null && heapExhaustedSeen) {
            reject(new GardenReportError(`${GARDEN_HEAP_EXHAUSTED}: garden ${name} exceeded its ${heapLimitMb} MB heap cap (${signal})`, code, signal, retained));
          } else if (retained.evidence.state !== "complete") {
            reject(new GardenReportError(`garden ${name}: incomplete stderr output (${retained.evidence.state})`, code, signal, retained));
          } else {
            resolve(code);
          }
        });
      });
    }).catch((error: unknown) => {
      release(); // A spawn that threw synchronously never reached "error" or "close".
      throw error;
    });
  };
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
): (() => Promise<void>) & { due: () => boolean | Promise<boolean> } {
  const pass = async (): Promise<void> => {
    // New evidence is a newly complete CI run stored, or a replay slice of history read; nothing else in
    // this pass changes without one of them.
    let found = false;
    // W1-T9551: one main-CI read per base sha per pass, shared by the selector-shadow guard and the flake-incident classifier.
    const mainReads = new Map<string, Promise<readonly string[] | undefined>>();
    const readMain = selectorShadowMainFailures(owner, repo, io);
    const mainFailures = (baseSha: string): Promise<readonly string[] | undefined> => {
      let read = mainReads.get(baseSha);
      if (read === undefined) mainReads.set(baseSha, read = readMain(baseSha));
      return read;
    };
    try {
      const runs = await readSelectorShadowRunsAsync(owner, repo, undefined, {
        readJson: io.readJson,
        cachePath: join(d.stateDir, "selector-shadow-log-cache.json"),
        warn: (message) => d.log("selector-shadow.cache_failed", { message }),
        onFlakes: selectorShadowFlakeLedger(d.log),
      });
      const report = await runSelectorShadowGardener(d, () => runs, (miss) => readSelectorShadowChangedPaths(owner, repo, miss, io.readJson), mintTaskId,
        undefined, undefined, mainFailures,
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
        mainFailures,
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
export interface FlowGardenIo extends Pick<SelectorShadowGhReads, "readJson"> { admission?: AdmissionFlowInput }
export function flowGardenPass(
  d: GardenerDeps, owner: string, repo: string, mintTaskId: (filingBranch: string) => string, io: FlowGardenIo = {},
): (() => Promise<void>) & { due: () => boolean | Promise<boolean> } {
  const pass = async (): Promise<void> => {
    try {
      await runFlowGardener(d, { mintTaskId, readCi: flowCiReader(owner, repo, io.readJson), admission: io.admission });
    } catch (e) {
      d.log(FLOW_GARDENER_FAILED_STEP, { error: String((e as Error)?.message ?? e) });
    }
  };
  return Object.assign(pass, { due: () => flowPassDue(d.stateDir, d.clock) });
}

/** W1-T8864: one issue-revalidation pass as the daemon builds it. Paced: a pass whose verdicts all match
 *  the previous ones widens the wait (never under the garden's hourly floor), and a changed verdict snaps
 *  it back. A pass never throws: a failure is ledgered as `issue_revalidation.failed`. */
export function issueRevalidationGardenPass(
  stateDir: string, ports: IssueRevalidationPorts, clock?: Clock,
): (() => Promise<void>) & { due: () => boolean | Promise<boolean> } {
  const pass = async (): Promise<void> => {
    let found = false;
    try {
      found = (await runIssueRevalidationGarden(ports)).found;
    } catch (e) {
      ports.log(ISSUE_REVALIDATION_FAILED_STEP, { stage: "pass", error: String((e as Error)?.message ?? e) });
    }
    try {
      recordGardenPacing(stateDir, "issue-revalidation", found, { clock });
    } catch (e) {
      ports.log(ISSUE_REVALIDATION_FAILED_STEP, { stage: "pacing", error: String((e as Error)?.message ?? e) });
    }
  };
  return Object.assign(pass, { due: () => gardenPacingDue(stateDir, "issue-revalidation", { clock }) });
}
