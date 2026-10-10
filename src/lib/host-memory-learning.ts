/**
 * lib/host-memory-learning.ts — per-class memory estimates LEARNED from measured tree peaks, so a reservation claims what
 * its class has actually used rather than a fixed default.
 *
 * OBSERVED 2026-10-10 (core census): every reservation used DEFAULT_ESTIMATE_MIB (review 1024; fix, implement and
 * unclassified 2048) because nothing passed a measured estimate, while measured trees held 0.4-0.84 GB steady (about
 * 2.8 GB with a cold tsc or a broad test run), a review about 1 GB, a garden about 1 GB and check-proof 250-290 MB.
 *
 * (1) MEASURE. While a reservation's work runs, its owner samples the tree (the bound roots and every descendant) on an
 *     unref'd timer: the sum of each live member's VmHWM, the kernel's own per-process resident peak. At release the
 *     largest sum seen is that tree's peak. A tree never observed records nothing; it is never recorded as zero.
 * (2) STORE. One append-only NDJSON file per instance under `estimates/` in the shared ledger directory, so instances
 *     never write the same file. Reads are a bounded tail of each file. Compaction keeps the newest samples per class.
 * (3) LEARN. The estimate is a decayed, weighted quantile of the class's peaks. The class default is a PRIOR, a
 *     pseudo-sample that never decays: with no samples the estimate IS the default (and says it is unmeasured); as fresh
 *     samples arrive they outweigh it; if samples stop arriving their weight decays and the prior regains its pull. The
 *     same samples also give the class's TYPICAL peak (the median), which the budget sums across live trees while it
 *     allows only one tree's tail above it (host-memory-shadow.ts).
 * (4) NEST. A `node --test` runner found inside a sampled tree (a worker's `npm test`, or a hand-typed run) gets its own
 *     "test" reservation, so the budget sees a test run's spike as it starts, and its peak teaches the test class. The
 *     enclosing tree's peak leaves the runner's members out, so no process is counted in two classes.
 *
 * BEST-EFFORT: nothing here throws to a caller. A failed read is no samples (the prior, named unmeasured), a failed
 * write loses one sample. Nothing here delays, refuses or alters work.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { fixedClock, systemClock, type Clock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";
import {
  DEFAULT_ESTIMATE_MIB,
  DEFAULT_WALK_LIMITS,
  WORKER_CLASSES,
  defaultInstance,
  defaultListProcesses,
  defaultMemoryLedgerLocation,
  openMemoryReservation,
  parseProcStat,
  type EstimateSource,
  type HostMemoryLedgerOptions,
  type MemoryReservationHandle,
  type ProcessListing,
  type WorkerClass,
} from "./host-memory-ledger.js";
import { isTestRunnerArgv } from "./test-file-admission.js";

// ── the learning rule (pure) ────────────────────────────────────────────────────────────────────────────────────────

/** PROPOSALS, like every host-memory number: to be re-read against the shadow rows, never a ruling. */
export const ESTIMATE_LEARNING = {
  /** The quantile a reservation claims: most trees of the class stay under it. */
  quantile: 0.9,
  /** The quantile the budget treats as a tree's TYPICAL peak: half the class's trees stay under it. */
  typicalQuantile: 0.5,
  /** A sample's weight halves every this long, so a class whose work changed re-learns within days. */
  halfLifeMs: 24 * 60 * 60_000,
  /** The prior's weight in samples. It never decays: at the 0.9 quantile a prior above every sample holds until about
   *  ten fresh samples outweigh it, and regains its pull as they age. */
  priorWeight: 1,
  /** Newest samples kept per class per instance when a store file is compacted. */
  keepPerClass: 128,
} as const;

export interface PeakSample {
  workerClass: WorkerClass;
  peakMib: number;
  at: number;
}

export interface LearnedEstimate {
  estimateMib: number;
  /** Real samples behind it. Zero means the estimate is the prior alone. */
  samples: number;
}

/** The decayed weighted quantile of `samples` with `priorMib` as a non-decaying pseudo-sample. Pure. */
export function learnEstimate(
  samples: readonly Pick<PeakSample, "peakMib" | "at">[],
  priorMib: number,
  now: number,
  params: { quantile: number; halfLifeMs: number; priorWeight: number } = ESTIMATE_LEARNING,
): LearnedEstimate {
  const usable = samples.filter((s) => Number.isFinite(s.peakMib) && s.peakMib > 0 && Number.isFinite(s.at));
  if (usable.length === 0) return { estimateMib: priorMib, samples: 0 };
  const weighted = [
    { value: priorMib, weight: params.priorWeight },
    ...usable.map((s) => ({ value: s.peakMib, weight: 0.5 ** (Math.max(0, now - s.at) / params.halfLifeMs) })),
  ].sort((a, b) => a.value - b.value);
  const total = weighted.reduce((sum, w) => sum + w.weight, 0);
  let cumulative = 0;
  for (const w of weighted) {
    cumulative += w.weight;
    if (cumulative >= params.quantile * total) return { estimateMib: Math.ceil(w.value), samples: usable.length };
  }
  return { estimateMib: Math.ceil(weighted.at(-1)!.value), samples: usable.length };
}

// ── classification of non-dispatch lanes (pure) ─────────────────────────────────────────────────────────────────────

const LANE_CLASS: Readonly<Record<string, WorkerClass>> = {
  review: "review",
  "sweep-fix": "fix",
  "alert-fix": "fix",
  "main-repair-fix": "fix",
  "head-rehome": "fix",
  "aa-prospective": "implement",
  "paired-trial": "implement",
};

/** Lanes whose worker reads and judges but builds and tests nothing. */
const ADVISORY_LANES = new Set([
  "inbox-response", "inbox-draft", "specialist", "retro", "serve-feedback", "triage", "plan", "verify-human-judge",
  "verify-human-shadow", "risk-judge", "onboard-synthesis", "onboard-recon", "escalation-summary", "containment",
  "worker-smoke", "isolation", "plan-gate", "typed-judgment", "ruling-judge", "ci-judge", "feedback-summary",
  "feedback-judge", "flight-judge", "spike",
]);

/** The class a non-dispatch lane's worker reserves under. An unknown lane says "unclassified" rather than guessing. */
export function workerClassOfLane(lane: string): WorkerClass {
  return LANE_CLASS[lane] ?? (ADVISORY_LANES.has(lane) ? "advisory" : "unclassified");
}

// ── the store (impure, bounded) ─────────────────────────────────────────────────────────────────────────────────────

export const PEAK_STORE_SUBDIR = "estimates";
/** BACKSTOP on each instance file read: the newest samples of every class fit in a fraction of it. */
export const PEAK_TAIL_BYTES = 256 * 1024;
/** BACKSTOP on file growth: past this an append compacts to the newest samples per class. */
export const PEAK_COMPACT_BYTES = 1024 * 1024;
/** How long a process reuses a class estimate before re-reading the store. */
export const ESTIMATE_CACHE_MS = 60_000;

export interface PeakStoreOptions {
  location?: () => { dir: string; scope?: "host" | "local" };
  root?: string;
  instance?: (root: string) => { name: string };
  clock?: Clock;
  append?: (path: string, line: string) => void;
  readTail?: (path: string, maxBytes: number) => string;
  list?: (dir: string) => string[];
  size?: (path: string) => number;
  rewrite?: (path: string, content: string) => void;
  log?: (event: Record<string, unknown>) => void;
}

const diagnosticsSeen = new Set<string>();

function recordError(opts: PeakStoreOptions, op: string, error: unknown): void {
  const reason = (error as NodeJS.ErrnoException | undefined)?.code ?? String((error as Error)?.message ?? error).slice(0, 120);
  const key = `${op}:${reason}`;
  if (diagnosticsSeen.has(key)) return;
  if (diagnosticsSeen.size >= 256) diagnosticsSeen.clear();
  diagnosticsSeen.add(key);
  try {
    (opts.log ?? ((event) => console.error(JSON.stringify(event))))({ event: "memory_budget.learning_diagnostic", op, reason });
  } catch (logError) {
    void logError; // The diagnostic of a diagnostic: the caller must not hear of it.
  }
}

function storeDir(opts: PeakStoreOptions): string {
  const location = (opts.location ?? defaultMemoryLedgerLocation)();
  // The local slot fallback lives under the OS temp directory, which is shared across users. Keep
  // learned inputs out of that namespace; unlike a reservation ledger, they need only be shared
  // by processes of this user. The host scratch location remains shared across service instances.
  if (!opts.location && location.scope === "local") {
    return join(homedir(), ".cache", "remudero", "host-memory", PEAK_STORE_SUBDIR);
  }
  return join(location.dir, PEAK_STORE_SUBDIR);
}

function instanceFile(opts: PeakStoreOptions): string {
  const root = opts.root ?? join(homedir(), "Remudero");
  const name = (opts.instance ?? defaultInstance)(root).name.replace(/[^A-Za-z0-9._-]/g, "_") || "_";
  return join(storeDir(opts), `${name}.ndjson`);
}

/** The last `maxBytes` of a file, starting at a whole line. A store file is compacted near PEAK_COMPACT_BYTES, so the
 *  whole-file read this slices is bounded by it. */
export function readFileTail(path: string, maxBytes: number): string {
  const buf = readFileSync(path);
  if (buf.length <= maxBytes) return buf.toString("utf8");
  const text = buf.subarray(buf.length - maxBytes).toString("utf8");
  return text.slice(text.indexOf("\n") + 1);
}

function parseSamples(text: string): PeakSample[] {
  const out: PeakSample[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as { c?: unknown; p?: unknown; at?: unknown };
      const at = typeof row.at === "string" ? Date.parse(row.at) : NaN;
      if (!WORKER_CLASSES.includes(row.c as WorkerClass) || typeof row.p !== "number" || !Number.isFinite(at)) continue;
      out.push({ workerClass: row.c as WorkerClass, peakMib: row.p, at });
    } catch (error) {
      void error; // A torn line: one sample among many.
    }
  }
  return out;
}

/** Keep the newest `keep` samples of each class, in file order. Pure. */
export function compactSamples(samples: readonly PeakSample[], keep: number): PeakSample[] {
  const kept = new Set<PeakSample>();
  for (const cls of WORKER_CLASSES) {
    for (const s of samples.filter((x) => x.workerClass === cls).slice(-keep)) kept.add(s);
  }
  return samples.filter((s) => kept.has(s));
}

const lineOf = (s: PeakSample): string =>
  `${JSON.stringify({ c: s.workerClass, p: Math.round(s.peakMib), at: fixedClock(s.at).iso() })}\n`;

/** Record one measured tree peak for this instance. NEVER throws. */
export function recordPeak(workerClass: WorkerClass, peakMib: number, opts: PeakStoreOptions = {}): boolean {
  try {
    if (!Number.isFinite(peakMib) || peakMib <= 0) return false;
    const path = instanceFile(opts);
    const at = (opts.clock ?? systemClock).now();
    const append = opts.append ?? ((target: string, line: string) => {
      mkdirSync(storeDir(opts), { recursive: true, mode: 0o700 });
      appendFileSync(target, line, { mode: 0o600 });
    });
    append(path, lineOf({ workerClass, peakMib, at }));
    cachedEstimates.delete(workerClass);
    const size = (opts.size ?? ((target: string) => statSync(target).size))(path);
    if (size > PEAK_COMPACT_BYTES) {
      const kept = compactSamples(parseSamples((opts.readTail ?? readFileTail)(path, PEAK_COMPACT_BYTES)), ESTIMATE_LEARNING.keepPerClass);
      (opts.rewrite ?? ((target: string, content: string) => void writeAtomic(target, content, { mode: 0o600 })))(path, kept.map(lineOf).join(""));
    }
    return true;
  } catch (error) {
    recordError(opts, "record", error);
    return false;
  }
}

/** Every instance's samples of one class, from a bounded tail of each store file. A failure reads as no samples. */
export function readPeakSamples(workerClass: WorkerClass, opts: PeakStoreOptions = {}): PeakSample[] {
  let names: string[];
  try {
    names = (opts.list ?? ((dir: string) => readdirSync(dir)))(storeDir(opts)).filter((name) => name.endsWith(".ndjson"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") recordError(opts, "list", error);
    return [];
  }
  const out: PeakSample[] = [];
  for (const name of names) {
    try {
      const text = (opts.readTail ?? readFileTail)(join(storeDir(opts), name), PEAK_TAIL_BYTES);
      out.push(...parseSamples(text).filter((s) => s.workerClass === workerClass));
    } catch (error) {
      recordError(opts, "read", error);
    }
  }
  return out;
}

const cachedEstimates = new Map<WorkerClass, { at: number; estimate: LearnedEstimate; typical: LearnedEstimate }>();

export function resetLearnedEstimateCacheForTests(): void {
  cachedEstimates.clear();
  diagnosticsSeen.clear();
}

function learnedClass(workerClass: WorkerClass, opts: PeakStoreOptions): { estimate: LearnedEstimate; typical: LearnedEstimate } {
  const now = (opts.clock ?? systemClock).now();
  const cached = cachedEstimates.get(workerClass);
  if (cached && now - cached.at < ESTIMATE_CACHE_MS) return cached;
  const samples = readPeakSamples(workerClass, opts);
  const prior = DEFAULT_ESTIMATE_MIB[workerClass];
  const learned = {
    estimate: learnEstimate(samples, prior, now),
    typical: learnEstimate(samples, prior, now, { ...ESTIMATE_LEARNING, quantile: ESTIMATE_LEARNING.typicalQuantile }),
  };
  cachedEstimates.set(workerClass, { at: now, ...learned });
  return learned;
}

/** The class estimate a reservation claims: learned from every instance's peaks, the class default as its prior. */
export function classEstimate(workerClass: WorkerClass, opts: PeakStoreOptions = {}): LearnedEstimate {
  return learnedClass(workerClass, opts).estimate;
}

/** The class's TYPICAL peak, the median of the same samples and prior. With no samples it is the prior, so an unmeasured
 *  class has no tail above its typical and its whole estimate counts as typical. */
export function classTypical(workerClass: WorkerClass, opts: PeakStoreOptions = {}): LearnedEstimate {
  return learnedClass(workerClass, opts).typical;
}

/** The estimate and the source a reservation records for it. */
export function estimateSourceOf(estimate: LearnedEstimate): EstimateSource {
  return estimate.samples > 0 ? { kind: "measured", samples: estimate.samples } : { kind: "default-unmeasured" };
}

// ── tree peaks (impure, bounded) ────────────────────────────────────────────────────────────────────────────────────

/** How often an owner samples its open trees. Each pass is one bounded /proc listing plus one status read per member. */
export const TREE_SAMPLE_MS = 15_000;
/** BACKSTOP on the per-process argv memo that spots test runners; past it the memo starts over. */
const RUNNER_MEMO_MAX = 4_096;

export interface TreeSamplerPorts {
  listProcesses: () => ProcessListing;
  readFile: (path: string) => string;
  setTimer: (fn: () => void, ms: number) => { unref?: () => void } | undefined;
  clearTimer: (timer: unknown) => void;
}

/** A test run the sampler found inside a tracked tree, ended once the runner's whole tree has exited. */
export interface NestedTestRun {
  /** The runner tree's peak in MiB, or undefined when it was never observed. Called once. */
  finish(peakMib: number | undefined): void;
}

export interface TrackHooks {
  /** A `node --test` runner appeared in this tree: open its reservation, or return undefined to leave it in this tree. */
  onTestRunner?: (pid: number) => NestedTestRun | undefined;
}

interface Tracked {
  roots: Array<{ pid: number; start: string }>;
  peakMib: number;
  observed: boolean;
  hooks?: TrackHooks;
  /** Set on a test run found inside another tree: it ends when its runner's tree has exited. */
  nested?: NestedTestRun;
}

function defaultSamplerPorts(): TreeSamplerPorts {
  return {
    listProcesses: () => defaultListProcesses(DEFAULT_WALK_LIMITS),
    readFile: (path) => readFileSync(path, "utf8"),
    setTimer: (fn, ms) => setInterval(fn, ms),
    clearTimer: (timer) => clearInterval(timer as NodeJS.Timeout),
  };
}

/** The live members of a tree: each root still carrying its start time, and every descendant in the listing. Pure. */
export function treeMembers(roots: readonly { pid: number; start: string }[], listing: ProcessListing): number[] {
  const live = new Map(listing.rows.map((row) => [row.pid, row]));
  const children = new Map<number, number[]>();
  for (const row of listing.rows) children.set(row.parent, [...(children.get(row.parent) ?? []), row.pid]);
  const queue = roots.filter((r) => live.get(r.pid)?.start === r.start).map((r) => r.pid);
  const seen = new Set<number>(queue);
  for (let i = 0; i < queue.length; i += 1) {
    for (const child of children.get(queue[i]!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return queue;
}

export interface TreePeakSampler {
  track(id: string, pid: number, hooks?: TrackHooks): void;
  /** Stop tracking `id` after one final sample; the peak in MiB, or undefined when the tree was never observed. */
  finish(id: string): number | undefined;
  sampleNow(): void;
  size(): number;
}

/**
 * One sampler per process: a timer runs only while some tree is tracked. NEVER throws. A `node --test` runner inside a
 * tree tracked with an `onTestRunner` hook becomes a tracked tree of its own, and the enclosing tree's peak leaves the
 * runner's members out.
 */
export function createTreePeakSampler(overrides: Partial<TreeSamplerPorts> = {}): TreePeakSampler {
  const ports = { ...defaultSamplerPorts(), ...overrides };
  const tracked = new Map<string, Tracked>();
  /** Per (pid, start): whether its argv is a test runner. Each process's argv is read once. */
  const runnerMemo = new Map<string, boolean>();
  /** The runners a hook was already asked about, whatever it answered. */
  const asked = new Set<string>();
  let timer: unknown;
  let sampling = false;

  const isRunner = (key: string, pid: number): boolean => {
    const known = runnerMemo.get(key);
    if (known !== undefined) return known;
    let runner = false;
    try {
      runner = isTestRunnerArgv(ports.readFile(`/proc/${pid}/cmdline`).split("\0"));
    } catch (error) {
      void error; // Exited or unreadable: nothing proves a runner, so nothing is reserved for it.
    }
    if (runnerMemo.size >= RUNNER_MEMO_MAX) {
      runnerMemo.clear();
      asked.clear();
    }
    runnerMemo.set(key, runner);
    return runner;
  };

  const peakOf = (members: readonly number[], skip: ReadonlySet<number>): number => {
    let kb = 0;
    for (const pid of members) {
      if (skip.has(pid)) continue;
      try {
        kb += Number(/^VmHWM:\s+(\d+)/m.exec(ports.readFile(`/proc/${pid}/status`))?.[1] ?? 0);
      } catch (error) {
        void error; // Exited between the listing and the read: it holds nothing now.
      }
    }
    return kb / 1024;
  };

  const stopIfIdle = (): void => {
    if (tracked.size > 0 || timer === undefined) return;
    ports.clearTimer(timer);
    timer = undefined;
  };

  /**
   * (1) Hooked trees adopt their new test runners: the OUTERMOST runner of a run (npm test's wrapper, not the
   * `node --test` it starts) is one run with everything below it. Returns which tracked tree each root (pid:start) is.
   */
  const adoptRunners = (listing: ProcessListing, startOf: ReadonlyMap<number, string>): Map<string, string> => {
    const rootOwner = new Map<string, string>();
    for (const [id, entry] of tracked) for (const root of entry.roots) rootOwner.set(`${root.pid}:${root.start}`, id);
    for (const [id, entry] of [...tracked]) {
      const hook = entry.hooks?.onTestRunner;
      if (!hook) continue;
      const inside = new Set<number>();
      // Breadth-first, so a runner is met before anything it started.
      for (const pid of treeMembers(entry.roots, listing)) {
        if (inside.has(pid)) continue;
        const start = startOf.get(pid) ?? "unknown";
        const key = `${pid}:${start}`;
        const owner = rootOwner.get(key);
        const nestedRoot = owner !== undefined && owner !== id;
        if (!nestedRoot && !isRunner(key, pid)) continue;
        for (const member of treeMembers([{ pid, start }], listing)) inside.add(member);
        if (nestedRoot || asked.has(key)) continue;
        asked.add(key); // Asked once, whatever the hook answers.
        let run: NestedTestRun | undefined;
        try {
          run = hook(pid);
        } catch (error) {
          void error; // No reservation opened: the run stays inside its enclosing tree's measure.
        }
        if (!run) continue;
        const nestedId = `${id}>test:${key}`;
        tracked.set(nestedId, { roots: [{ pid, start }], peakMib: 0, observed: false, nested: run });
        rootOwner.set(key, nestedId);
      }
    }
    return rootOwner;
  };

  const sampleNow = (): void => {
    if (tracked.size === 0 || sampling) return;
    sampling = true;
    const ended: Array<{ run: NestedTestRun; peakMib: number | undefined }> = [];
    try {
      let listing: ProcessListing;
      try {
        listing = ports.listProcesses();
      } catch (error) {
        void error; // An unreadable /proc this pass: the next pass tries again; no sample is invented.
        return;
      }
      const startOf = new Map(listing.rows.map((row) => [row.pid, row.start]));
      const rootOwner = adoptRunners(listing, startOf);
      // (2) Each tree's peak leaves out the members of every tracked tree rooted inside it, so a process counts once.
      const members = new Map([...tracked].map(([id, entry]) => [id, treeMembers(entry.roots, listing)]));
      for (const [id, entry] of tracked) {
        const own = members.get(id) ?? [];
        const inner = new Set<number>();
        for (const pid of own) {
          const owner = rootOwner.get(`${pid}:${startOf.get(pid)}`);
          if (owner !== undefined && owner !== id) for (const member of members.get(owner) ?? []) inner.add(member);
        }
        const peak = peakOf(own, inner);
        if (peak > 0) {
          entry.observed = true;
          entry.peakMib = Math.max(entry.peakMib, peak);
        }
        // (3) A nested run ends once its runner's whole tree has exited.
        if (entry.nested && own.length === 0) {
          tracked.delete(id);
          ended.push({ run: entry.nested, peakMib: entry.observed ? entry.peakMib : undefined });
        }
      }
    } finally {
      sampling = false;
    }
    for (const { run, peakMib } of ended) {
      try {
        run.finish(peakMib);
      } catch (error) {
        void error; // A failed release is the ledger's to report; the sampler carries on.
      }
    }
    stopIfIdle();
  };

  return {
    track(id, pid, hooks) {
      try {
        const stat = parseProcStat(ports.readFile(`/proc/${pid}/stat`));
        if (!stat || stat.zombie) return;
        const entry = tracked.get(id) ?? { roots: [], peakMib: 0, observed: false };
        entry.roots.push({ pid, start: stat.start });
        if (hooks) entry.hooks = hooks;
        tracked.set(id, entry);
        sampleNow();
        if (timer === undefined) {
          const handle = ports.setTimer(sampleNow, TREE_SAMPLE_MS);
          handle?.unref?.();
          timer = handle;
        }
      } catch (error) {
        void error; // No /proc (or the root already exited): this tree is never observed and records nothing.
      }
    },
    finish(id) {
      sampleNow(); // Never throws: an unreadable listing or member is skipped inside it.
      const entry = tracked.get(id);
      tracked.delete(id);
      stopIfIdle();
      return entry?.observed ? entry.peakMib : undefined;
    },
    sampleNow,
    size: () => tracked.size,
  };
}

let processSampler: TreePeakSampler | undefined;

function sharedSampler(): TreePeakSampler {
  processSampler ??= createTreePeakSampler();
  return processSampler;
}

// ── the learned reservation ─────────────────────────────────────────────────────────────────────────────────────────

export interface LearnedReservation extends MemoryReservationHandle {
  readonly workerClass: WorkerClass;
  readonly estimateMib: number;
  readonly estimateSource: EstimateSource;
}

export interface LearnedReservationOptions {
  ledger?: HostMemoryLedgerOptions;
  store?: PeakStoreOptions;
  sampler?: TreePeakSampler;
}

/** The ledger reservation and learned peak of one test runner found inside a tracked tree. NEVER throws. */
function openNestedTestRun(
  pid: number,
  context: { root?: string; ledger?: HostMemoryLedgerOptions; store: PeakStoreOptions },
): NestedTestRun {
  let estimate: LearnedEstimate = { estimateMib: DEFAULT_ESTIMATE_MIB.test, samples: 0 };
  try {
    estimate = classEstimate("test", context.store);
  } catch (error) {
    recordError(context.store, "estimate", error);
  }
  const handle = openMemoryReservation({
    workerClass: "test",
    root: context.root,
    ...(estimate.samples > 0 ? { measured: { estimateMib: estimate.estimateMib, samples: estimate.samples } } : {}),
  }, context.ledger);
  handle.bindRoot(pid);
  return {
    finish(peakMib) {
      if (peakMib !== undefined) recordPeak("test", peakMib, context.store);
      handle.releaseOccupancy();
    },
  };
}

/**
 * Open a reservation at the class's LEARNED estimate, sample its tree while the work runs, and record the tree's peak
 * when the occupancy ends. A test runner inside the tree gets its own "test" reservation (module doc, (4)). NEVER throws:
 * a failure anywhere leaves the ledger's own no-op or default behaviour.
 */
export function openLearnedReservation(
  input: { workerClass: WorkerClass; root?: string },
  deps: LearnedReservationOptions = {},
): LearnedReservation {
  // The store lives beside the ledger it learns for: a caller that moved the ledger moved the store with it.
  const store: PeakStoreOptions = {
    ...(deps.ledger?.location ? { location: deps.ledger.location } : {}),
    ...(deps.ledger?.instance ? { instance: deps.ledger.instance } : {}),
    ...deps.store,
    ...(input.root ? { root: input.root } : {}),
  };
  let estimate: LearnedEstimate = { estimateMib: DEFAULT_ESTIMATE_MIB[input.workerClass], samples: 0 };
  try {
    estimate = classEstimate(input.workerClass, store);
  } catch (error) {
    recordError(store, "estimate", error);
  }
  const handle = openMemoryReservation({
    workerClass: input.workerClass,
    root: input.root,
    ...(estimate.samples > 0 ? { measured: { estimateMib: estimate.estimateMib, samples: estimate.samples } } : {}),
  }, deps.ledger);
  const sampler = deps.sampler ?? sharedSampler();
  const key = handle.id ?? `untracked-${Math.random().toString(36).slice(2)}`;
  let finished = false;
  const hooks: TrackHooks | undefined = input.workerClass === "test" ? undefined : {
    onTestRunner: (pid) => openNestedTestRun(pid, { ...(input.root ? { root: input.root } : {}), ledger: deps.ledger, store }),
  };
  return {
    id: handle.id,
    workerClass: input.workerClass,
    estimateMib: estimate.estimateMib,
    estimateSource: estimateSourceOf(estimate),
    bindRoot(pid: number): void {
      handle.bindRoot(pid);
      try {
        sampler.track(key, pid, hooks);
      } catch (error) {
        recordError(store, "track", error);
      }
    },
    releaseOccupancy(): void {
      if (!finished) {
        finished = true;
        try {
          const peak = sampler.finish(key);
          if (peak !== undefined) recordPeak(input.workerClass, peak, store);
        } catch (error) {
          recordError(store, "finish", error);
        }
      }
      handle.releaseOccupancy();
    },
  };
}

/**
 * A reservation held for the duration of SYNCHRONOUS work, released after it whatever `run` does. With `bindSelf` the
 * calling process is the tree (a verb such as check-proof reserving for itself): its own resident memory counts, and its
 * VmHWM at the end is recorded as the class's peak. Without it nothing is measured (a spawnSync child cannot be sampled
 * from its blocked parent), and the class keeps its prior unless another owner measures it.
 */
export function withSyncChildReservation<T>(
  workerClass: WorkerClass,
  run: () => T,
  deps: LearnedReservationOptions & { enabled?: () => boolean; root?: string; bindSelf?: boolean } = {},
): T {
  const enabled = (deps.enabled ?? daemonOwnedProcess)();
  const reservation = enabled ? openLearnedReservation({ workerClass, ...(deps.root ? { root: deps.root } : {}) }, deps) : undefined;
  if (deps.bindSelf) reservation?.bindRoot(process.pid);
  try {
    return run();
  } finally {
    reservation?.releaseOccupancy();
  }
}

/** True in the daemon and the processes it starts (not a test, not an operator's shell): only they share the ledger. */
export function daemonOwnedProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REMUDERO_DAEMON_PROCESS === "1" && !env.NODE_TEST_CONTEXT;
}
