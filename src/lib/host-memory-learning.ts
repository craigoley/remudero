/**
 * lib/host-memory-learning.ts — per-class memory estimates LEARNED from measured tree peaks, so a reservation claims what
 * its class has actually used rather than a fixed default.
 *
 * OBSERVED 2026-10-10 (core census): every reservation used DEFAULT_ESTIMATE_MIB (review 1024; fix, implement and
 * unclassified 2048) because nothing passed a measured estimate, while measured trees held 0.4-0.84 GB steady (about
 * 2.8 GB with a cold tsc or a broad test run), a review about 1 GB, a garden about 1 GB and check-proof 250-290 MB.
 *
 * (1) MEASURE. While a reservation's work runs, its owner samples the tree (the bound roots and every descendant) on an
 *     unref'd timer: the sum of each live member's concurrent VmRSS. Historical VmHWM peaks need not coincide. At release the
 *     largest sum seen is that tree's peak, stored with its age when last raised (W1-T9762: the class's time to peak).
 *     A tree never observed records nothing; it is never recorded as zero.
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
import { basename, join, normalize } from "node:path";

import { fixedClock, systemClock, type Clock } from "./clock.js";
import { readBoundedFileTail } from "./bounded-file-tail.js";
import { writeAtomic } from "./fs-race-safe.js";
import {
  DEFAULT_ESTIMATE_MIB,
  DEFAULT_WALK_LIMITS,
  WORKER_CLASSES,
  adoptMemoryReservation,
  defaultInstance,
  defaultListProcesses,
  defaultMemoryLedgerLocation,
  openMemoryReservation,
  parseProcStat,
  type EstimateSource,
  type HostMemoryLedgerOptions,
  type MemoryReservationHandle,
  type ContainerGeneration,
  type ProcessIdentity,
  type ProcessListing,
  type WorkerClass,
} from "./host-memory-ledger.js";
import { isTestRunnerArgv } from "./test-file-admission.js";
import { TEST_FILE_PEAK_BYTES, type TestFileSize } from "./test-slot.js";

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
  /** Largest summed VmHWM of members whose argv[0] basename is claude; absent if none observed. */
  cliPeakMib?: number;
  at: number;
  /** Present only on file-child samples; whole-tree test peaks remain a separate population. */
  testFile?: string;
  entryKind?: "bundle" | "tsx";
  /** Absent historical rows are legacy HWM evidence, never upgraded to concurrent RSS. */
  measurementBasis?: "legacy-hwm" | "concurrent-rss" | "process-hwm" | "unknown";
  /** Simultaneously observed legacy HWM sum: existing admission continues learning its original metric. */
  legacyPeakMib?: number;
  /** W1-T9762: the tree's age, since its reservation opened, when its concurrent-RSS peak was last raised. */
  peakAgeMs?: number;
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

/** How much of a class's growth a live tree still has ahead of it, or why that is unmeasured. */
export type Survival = { factor: number; samples: number } | { unmeasured: string };

/**
 * W1-T9762: the weighted share of the class's time-to-peak samples later than `ageMs`, with learnEstimate's half-life
 * weighting and prior rule. The prior is a non-decaying pseudo-sample at the longest measured time to peak, so stale
 * samples drift back toward no decay while a tree older than every measured peak has nothing ahead of it. Pure.
 */
export function survivalAt(
  samples: readonly Pick<PeakSample, "peakAgeMs" | "at">[], ageMs: number, now: number,
  params: { halfLifeMs: number; priorWeight: number } = ESTIMATE_LEARNING,
): Survival {
  const usable = samples.filter((s) => Number.isFinite(s.peakAgeMs) && s.peakAgeMs! >= 0 && Number.isFinite(s.at));
  if (usable.length === 0) return { unmeasured: "no time-to-peak samples" };
  const weighted = [
    { value: Math.max(...usable.map((s) => s.peakAgeMs!)), weight: params.priorWeight },
    ...usable.map((s) => ({ value: s.peakAgeMs!, weight: 0.5 ** (Math.max(0, now - s.at) / params.halfLifeMs) })),
  ];
  const total = weighted.reduce((sum, w) => sum + w.weight, 0);
  const ahead = weighted.filter((w) => w.value > ageMs).reduce((sum, w) => sum + w.weight, 0);
  return { factor: ahead / total, samples: usable.length };
}

// ── classification of non-dispatch lanes (pure) ─────────────────────────────────────────────────────────────────────

const LANE_CLASS: Readonly<Record<string, WorkerClass>> = {
  implement: "implement",
  fix: "fix",
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
  cliPeakMib?: number;
  legacyPeakMib?: number;
  peakAgeMs?: number;
  measurementBasis?: PeakSample["measurementBasis"];
  entryKind?: "bundle" | "tsx";
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

/** Retain whole NDJSON lines only; failures reach the store's existing diagnostic path. */
export function readFileTail(path: string, maxBytes: number): string {
  const tail = readBoundedFileTail(path, maxBytes);
  if (tail.state !== "complete" && tail.state !== "truncated") throw new Error(`${tail.state}: ${tail.reason}`);
  if (tail.state === "complete") return tail.text;
  const newline = tail.text.indexOf("\n");
  return newline < 0 ? "" : tail.text.slice(newline + 1);
}

function parseSamples(text: string): PeakSample[] {
  const out: PeakSample[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as { c?: unknown; p?: unknown; at?: unknown; f?: unknown; entry_kind?: unknown; basis?: unknown; legacy_p?: unknown; cli_p?: unknown; ttp_ms?: unknown };
      const at = typeof row.at === "string" ? Date.parse(row.at) : NaN;
      if (!WORKER_CLASSES.includes(row.c as WorkerClass) || typeof row.p !== "number" || !Number.isFinite(at)) continue;
      if (row.f !== undefined && (row.c !== "test" || typeof row.f !== "string" || !row.f)) continue;
      out.push({ workerClass: row.c as WorkerClass, peakMib: row.p, at,
        ...(typeof row.cli_p === "number" && Number.isFinite(row.cli_p) && row.cli_p > 0 ? { cliPeakMib: row.cli_p } : {}),
        ...(typeof row.legacy_p === "number" && Number.isFinite(row.legacy_p) && row.legacy_p > 0 ? { legacyPeakMib: row.legacy_p } : {}),
        measurementBasis: row.basis === undefined || row.basis === "legacy-hwm" ? "legacy-hwm"
          : row.basis === "concurrent-rss" || row.basis === "process-hwm" ? row.basis : "unknown",
        ...(typeof row.f === "string" ? { testFile: testFileKey(row.f) } : {}),
        ...(typeof row.ttp_ms === "number" && Number.isFinite(row.ttp_ms) && row.ttp_ms >= 0 ? { peakAgeMs: row.ttp_ms } : {}),
        ...(row.entry_kind === "bundle" || row.entry_kind === "tsx" ? { entryKind: row.entry_kind } : {}) });
    } catch (error) {
      void error; // A torn line: one sample among many.
    }
  }
  return out;
}

/** Keep the newest `keep` samples per class and per test file, in file order. Pure. */
export function compactSamples(samples: readonly PeakSample[], keep: number): PeakSample[] {
  const counts = new Map<string, number>();
  const kept = new Set<PeakSample>();
  for (const s of [...samples].reverse()) {
    const key = `${s.workerClass}:${s.testFile ?? ""}:${s.measurementBasis ?? "legacy-hwm"}`;
    const count = counts.get(key) ?? 0;
    if (count < keep) kept.add(s);
    counts.set(key, count + 1);
  }
  return samples.filter((s) => kept.has(s));
}

const lineOf = (s: PeakSample): string =>
  `${JSON.stringify({ c: s.workerClass, p: Math.round(s.peakMib), at: fixedClock(s.at).iso(),
    basis: s.measurementBasis ?? "legacy-hwm",
    ...(s.cliPeakMib !== undefined ? { cli_p: s.cliPeakMib } : {}),
    ...(s.legacyPeakMib !== undefined ? { legacy_p: s.legacyPeakMib } : {}),
    ...(s.testFile ? { f: s.testFile } : {}),
    ...(s.entryKind ? { entry_kind: s.entryKind } : {}),
    ...(s.peakAgeMs !== undefined ? { ttp_ms: Math.round(s.peakAgeMs) } : {}) })}\n`;

/** Record one measured tree peak for this instance. NEVER throws. */
export function recordPeak(workerClass: WorkerClass, peakMib: number, opts: PeakStoreOptions = {}, testFile?: string): boolean {
  try {
    if (!Number.isFinite(peakMib) || peakMib <= 0) return false;
    const path = instanceFile(opts);
    const at = (opts.clock ?? systemClock).now();
    const append = opts.append ?? ((target: string, line: string) => {
      mkdirSync(storeDir(opts), { recursive: true, mode: 0o700 });
      appendFileSync(target, line, { mode: 0o600 });
    });
    append(path, lineOf({ workerClass, peakMib, at,
      ...(opts.cliPeakMib !== undefined ? { cliPeakMib: opts.cliPeakMib } : {}),
      measurementBasis: opts.measurementBasis ?? "legacy-hwm",
      ...(opts.legacyPeakMib !== undefined ? { legacyPeakMib: opts.legacyPeakMib } : {}),
      ...(testFile ? { testFile: testFileKey(testFile) } : {}),
      ...(opts.peakAgeMs !== undefined ? { peakAgeMs: opts.peakAgeMs } : {}),
      ...(opts.entryKind ? { entryKind: opts.entryKind } : {}) }));
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
export function readPeakSamples(workerClass: WorkerClass, opts: PeakStoreOptions = {}, fileSamples = false): PeakSample[] {
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
      out.push(...parseSamples(text).filter((s) => s.workerClass === workerClass && (s.testFile !== undefined) === fileSamples));
    } catch (error) {
      recordError(opts, "read", error);
    }
  }
  return out;
}

/** Repository test paths survive worktree and container prefixes in Node's absolute child argv. */
export function testFileKey(path: string): string {
  const key = normalize(path).replaceAll("\\", "/");
  const at = key.lastIndexOf("/test/");
  return at >= 0 ? key.slice(at + 1) : key;
}

export function recordTestFilePeak(path: string, peakMib: number, opts: PeakStoreOptions = {}): boolean {
  return recordPeak("test", peakMib, { ...opts, measurementBasis: "process-hwm" }, path);
}

/** File p90, otherwise the file population's p90, otherwise the one-sample 512 MiB prior. */
export function testFileEstimates(selection: readonly string[], opts: PeakStoreOptions = {}): TestFileSize[] {
  const now = (opts.clock ?? systemClock).now();
  const samples = readPeakSamples("test", opts, true);
  const prior = TEST_FILE_PEAK_BYTES / 1024 ** 2;
  const tail = learnEstimate(samples, prior, now);
  const byFile = new Map<string, PeakSample[]>();
  for (const sample of samples) {
    const group = byFile.get(sample.testFile!) ?? [];
    group.push(sample);
    byFile.set(sample.testFile!, group);
  }
  return [...new Set(selection.length ? selection.map(testFileKey) : ["<selection>"])].map((path) => {
    const own = learnEstimate(byFile.get(path) ?? [], prior, now);
    const estimate = own.samples ? own : tail;
    return { path, bytes: estimate.estimateMib * 1024 ** 2, samples: estimate.samples,
      basis: own.samples ? "file-p90" : tail.samples ? "class-tail" : "prior" };
  });
}

type LearnedClass = { estimate: LearnedEstimate; typical: LearnedEstimate; timeToPeak: PeakSample[] };
const cachedEstimates = new Map<WorkerClass, { at: number } & LearnedClass>();

export function resetLearnedEstimateCacheForTests(): void {
  cachedEstimates.clear();
  diagnosticsSeen.clear();
}

function learnedClass(workerClass: WorkerClass, opts: PeakStoreOptions): LearnedClass {
  const now = (opts.clock ?? systemClock).now();
  const cached = cachedEstimates.get(workerClass);
  if (cached && now - cached.at < ESTIMATE_CACHE_MS) return cached;
  const raw = readPeakSamples(workerClass, opts);
  const samples = raw.flatMap(s => s.measurementBasis === "concurrent-rss"
    ? s.legacyPeakMib === undefined ? [] : [{ ...s, peakMib: s.legacyPeakMib }]
    : s.measurementBasis === "unknown" ? [] : [s]);
  const prior = DEFAULT_ESTIMATE_MIB[workerClass];
  const learned = {
    estimate: learnEstimate(samples, prior, now),
    typical: learnEstimate(samples, prior, now, { ...ESTIMATE_LEARNING, quantile: ESTIMATE_LEARNING.typicalQuantile }),
    timeToPeak: raw.filter((s) => s.peakAgeMs !== undefined),
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

export type ValidationClassEstimate =
  | { kind: "measured"; estimateMib: number; typicalMib: number; samples: number; basis: "legacy-compatible-tree-peaks" }
  | { kind: "unavailable"; reason: string };

/** Opt-in evidence for NEW validation; legacy partial reads/cache/estimator behavior stays unchanged.
 * Completeness means the maintained bounded tail population, not all historical measurements. */
export function readValidationClassEstimate(workerClass: WorkerClass, opts: PeakStoreOptions = {}): ValidationClassEstimate {
  try {
    const location = (opts.location ?? defaultMemoryLedgerLocation)();
    if (location.scope !== "host") return { kind: "unavailable", reason: "estimate-store-local-or-unknown" };
    let unavailable = false;
    const samples = readPeakSamples(workerClass, {
      ...opts, location: () => location,
      list: dir => {
        try { return (opts.list ?? readdirSync)(dir); }
        catch (error) { unavailable = true; throw error; }
      },
      readTail: (path, bytes) => {
        try {
          const text = (opts.readTail ?? readFileTail)(path, bytes);
          // Reuse the maintained parser; an omitted malformed record is uncertainty, not a smaller corpus.
          if (parseSamples(text).length !== text.split("\n").filter(Boolean).length) unavailable = true;
          return text;
        } catch (error) { unavailable = true; throw error; }
      },
    });
    if (unavailable) return { kind: "unavailable", reason: "estimate-population-incomplete" };
    const now = (opts.clock ?? systemClock).now();
    if (!Number.isFinite(now) || samples.some(s => !Number.isFinite(s.peakMib) || s.peakMib <= 0 || s.at > now ||
        s.measurementBasis === "unknown" || s.measurementBasis === "process-hwm" ||
        (s.measurementBasis === "concurrent-rss" && s.legacyPeakMib === undefined))) {
      return { kind: "unavailable", reason: "estimate-basis-unavailable" };
    }
    // EXACT legacy metric: paired legacy HWM for concurrent samples, not a switch to an RSS/joint estimator.
    const legacy = samples.map(s => s.measurementBasis === "concurrent-rss" ? { ...s, peakMib: s.legacyPeakMib! } : s);
    const estimate = learnEstimate(legacy, DEFAULT_ESTIMATE_MIB[workerClass], now);
    const typical = learnEstimate(legacy, DEFAULT_ESTIMATE_MIB[workerClass], now,
      { ...ESTIMATE_LEARNING, quantile: ESTIMATE_LEARNING.typicalQuantile });
    if (estimate.samples === 0) return { kind: "unavailable", reason: "no-measured-samples" };
    return { kind: "measured", estimateMib: estimate.estimateMib, typicalMib: typical.estimateMib,
      samples: estimate.samples, basis: "legacy-compatible-tree-peaks" };
  } catch {
    return { kind: "unavailable", reason: "estimate-reader-unavailable" };
  }
}

/** W1-T9762: the class's measured survival at a live tree's age (see {@link survivalAt}). */
export function classSurvival(workerClass: WorkerClass, ageMs: number, opts: PeakStoreOptions = {}): Survival {
  return survivalAt(learnedClass(workerClass, opts).timeToPeak, ageMs, (opts.clock ?? systemClock).now());
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
  /** When a peak is raised, so its age can be recorded. */
  clock: Clock;
}

/** A test run the sampler found inside a tracked tree, ended once the runner's whole tree has exited. */
export interface NestedTestRun {
  /** The runner tree's peak in MiB, or undefined when it was never observed. Called once. */
  finish(peakMib: number | undefined, legacyPeakMib?: number, peakAgeMs?: number, cliPeakMib?: number): void;
}

export interface TrackHooks {
  /** A `node --test` runner appeared in this tree: open its reservation, or return undefined to leave it in this tree. */
  onTestRunner?: (pid: number) => NestedTestRun | undefined;
  onTestFilePeak?: (path: string, peakMib: number) => void;
  /** W1-T9762: when the tree's reservation opened, the origin of the age its peak is recorded at. */
  openedAtMs?: number;
}

interface Tracked {
  cliPeakMib?: number;
  rssIncomplete?: boolean;
  legacyPeakMib?: number;
  roots: Array<{ pid: number; start: string }>;
  peakMib: number;
  /** When `peakMib` was last raised. */
  peakAtMs?: number;
  observed: boolean;
  hooks?: TrackHooks;
  /** Set on a test run found inside another tree: it ends when its runner's tree has exited. */
  nested?: NestedTestRun;
  files?: Map<string, { path: string; peakMib: number }>;
}

function defaultSamplerPorts(): TreeSamplerPorts {
  return {
    listProcesses: () => defaultListProcesses(DEFAULT_WALK_LIMITS),
    readFile: (path) => readFileSync(path, "utf8"),
    setTimer: (fn, ms) => setInterval(fn, ms),
    clearTimer: (timer) => clearInterval(timer as NodeJS.Timeout),
    clock: systemClock,
  };
}

/** The live members of a tree: each root still carrying its start time, and every descendant in the listing. Pure. */
export function treeMembers(roots: readonly { pid: number; start: string }[], listing: ProcessListing): number[] {
  const live = new Map(listing.rows.map((row) => [row.pid, row]));
  const children = new Map<number, number[]>();
  for (const row of listing.rows) children.set(row.parent, [...(children.get(row.parent) ?? []), row.pid]);
  const queue = [...new Set(roots.filter((r) => live.get(r.pid)?.start === r.start).map((r) => r.pid))];
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
  /** End through the public finish hook, returning separately labelled current-RSS and legacy-HWM peaks, and the age
   *  the current-RSS peak was reached at when the tree was tracked with its reservation's open time. */
  finishMeasurement?(id: string): { peakMib?: number; legacyPeakMib?: number; peakAgeMs?: number; cliPeakMib?: number };
  track(id: string, pid: number, hooks?: TrackHooks): void;
  /** Legacy sum-of-HWM peak, retained for existing adapters; concurrent training uses finishMeasurement. */
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
  /** Per (pid, start): argv classification shared by runner and CLI measurement. */
  const runnerMemo = new Map<string, { runner: boolean; cli?: boolean; file?: string }>();
  /** The runners a hook was already asked about, whatever it answered. */
  const asked = new Set<string>();
  let timer: unknown;
  let sampling = false;

  const argvOf = (key: string, pid: number): { runner: boolean; cli?: boolean; file?: string } => {
    const known = runnerMemo.get(key);
    if (known !== undefined) return known;
    let facts: { runner: boolean; cli?: boolean; file?: string } = { runner: false };
    try {
      const rawArgv = ports.readFile(`/proc/${pid}/cmdline`).split("\0");
      const argv = rawArgv.filter(Boolean);
      facts = { runner: isTestRunnerArgv(argv), cli: basename(rawArgv[0] ?? "") === "claude" };
      if (!facts.runner && /^node(js)?$/.test(basename(argv[0] ?? ""))) {
        const file = argv.at(-1);
        if (file && /\.[cm]?[jt]sx?$/.test(file) && !file.startsWith("-")) facts.file = testFileKey(file);
      }
    } catch (error) {
      void error; // Exited or unreadable: nothing proves a runner, so nothing is reserved for it.
    }
    if (runnerMemo.size >= RUNNER_MEMO_MAX) {
      runnerMemo.clear();
      asked.clear();
    }
    runnerMemo.set(key, facts);
    return facts;
  };

  const peakOf = (members: readonly number[], skip: ReadonlySet<number>, entry: Tracked,
    rows: ReadonlyMap<number, ProcessListing["rows"][number]>): number | undefined => {
    let kb = 0;
    let legacyKb = 0;
    let cliKb = 0;
    let legacyComplete = true;
    let complete = true;
    for (const pid of members) {
      if (skip.has(pid)) continue;
      try {
        const status = ports.readFile(`/proc/${pid}/status`);
        const rss = /^VmRSS:\s+(\d+)/m.exec(status)?.[1];
        if (rss === undefined) complete = false;
        else kb += Number(rss);
        const hwm = Number(/^VmHWM:\s+(\d+)/m.exec(status)?.[1] ?? 0);
        legacyKb += hwm;
        const member = rows.get(pid)!;
        if (hwm > 0 && argvOf(`${pid}:${member.start}`, pid).cli) cliKb += hwm;
        if (hwm === 0) legacyComplete = false;
        if (hwm > 0 && entry.hooks?.onTestFilePeak) {
          const row = rows.get(pid)!;
          const parent = rows.get(row.parent);
          if (parent && argvOf(`${parent.pid}:${parent.start}`, parent.pid).runner) {
            const key = `${pid}:${row.start}`;
            const file = argvOf(key, pid).file;
            if (file) {
              entry.files ??= new Map();
              entry.files.set(key, { path: file, peakMib: Math.max(entry.files.get(key)?.peakMib ?? 0, hwm / 1024) });
            }
          }
        }
      } catch (error) {
        // A confirmed exit holds nothing now; denied or failed reads must not create an underestimated sample.
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") { complete = false; legacyComplete = false; }
      }
    }
    if (!complete) entry.rssIncomplete = true;
    if (cliKb > 0) entry.cliPeakMib = Math.max(entry.cliPeakMib ?? 0, cliKb / 1024);
    if (legacyComplete && legacyKb > 0) entry.legacyPeakMib = Math.max(entry.legacyPeakMib ?? 0, legacyKb / 1024);
    return complete ? kb / 1024 : undefined;
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
        if (!nestedRoot && !argvOf(key, pid).runner) continue;
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
        tracked.set(nestedId, { roots: [{ pid, start }], peakMib: 0, observed: false, nested: run,
          hooks: { onTestFilePeak: entry.hooks?.onTestFilePeak, openedAtMs: ports.clock.now() } });
        rootOwner.set(key, nestedId);
      }
    }
    return rootOwner;
  };

  const flushFiles = (entry: Tracked, live: ReadonlySet<string>): void => {
    for (const [key, file] of entry.files ?? []) {
      if (live.has(key)) continue;
      entry.files!.delete(key);
      try {
        entry.hooks?.onTestFilePeak?.(file.path, file.peakMib);
      } catch (error) {
        void error; // Losing a file sample does not end tree measurement or admission.
      }
    }
  };

  const sampleNow = (): void => {
    if (tracked.size === 0 || sampling) return;
    sampling = true;
    const ended: Array<{ run: NestedTestRun; peakMib: number | undefined; legacyPeakMib?: number; peakAgeMs?: number; cliPeakMib?: number }> = [];
    try {
      let listing: ProcessListing;
      try {
        listing = ports.listProcesses();
        if (!listing.complete) { for (const entry of tracked.values()) entry.rssIncomplete = true; return; }
      } catch (error) {
        for (const entry of tracked.values()) entry.rssIncomplete = true;
        void error; // A later good sample cannot certify the tree's missing interval.
        return;
      }
      const startOf = new Map(listing.rows.map((row) => [row.pid, row.start]));
      const rows = new Map(listing.rows.map((row) => [row.pid, row]));
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
        const peak = peakOf(own, inner, entry, rows);
        flushFiles(entry, new Set(own.map((pid) => `${pid}:${startOf.get(pid)}`)));
        if (peak !== undefined && peak > 0) {
          entry.observed = true;
          if (peak > entry.peakMib) entry.peakAtMs = ports.clock.now();
          entry.peakMib = Math.max(entry.peakMib, peak);
        }
        // (3) A nested run ends once its runner's whole tree has exited.
        if (entry.nested && own.length === 0) {
          tracked.delete(id);
          const measured = entry.observed && !entry.rssIncomplete;
          ended.push({ run: entry.nested, peakMib: measured ? entry.peakMib : undefined, legacyPeakMib: entry.legacyPeakMib,
            cliPeakMib: entry.cliPeakMib,
            peakAgeMs: measured ? peakAgeOf(entry) : undefined });
        }
      }
    } finally {
      sampling = false;
    }
    for (const { run, peakMib, legacyPeakMib, peakAgeMs, cliPeakMib } of ended) {
      try {
        run.finish(peakMib, legacyPeakMib, peakAgeMs, cliPeakMib);
      } catch (error) {
        void error; // A failed release is the ledger's to report; the sampler carries on.
      }
    }
    stopIfIdle();
  };

  const finishLegacy = (id: string): number | undefined => {
    sampleNow();
    const entry = tracked.get(id);
    tracked.delete(id);
    if (entry) flushFiles(entry, new Set());
    stopIfIdle();
    return entry?.legacyPeakMib;
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
    finish: finishLegacy,
    finishMeasurement(this: TreePeakSampler, id: string) {
      const entry = tracked.get(id);
      // run-child wraps finish to capture its legacy result. Dispatch through that adapter, not around it.
      const legacyPeakMib = this.finish(id);
      const peakAgeMs = entry ? peakAgeOf(entry) : undefined;
      return entry ? { ...(entry.observed && !entry.rssIncomplete
        ? { peakMib: entry.peakMib, ...(peakAgeMs !== undefined ? { peakAgeMs } : {}) } : {}), legacyPeakMib,
        ...(entry.cliPeakMib !== undefined ? { cliPeakMib: entry.cliPeakMib } : {}) }
        : { legacyPeakMib };
    },
    sampleNow,
    size: () => tracked.size,
  };
}

/** The tree's age at its last raised peak, since its reservation opened; undefined without both instants. */
function peakAgeOf(entry: Tracked): number | undefined {
  const opened = entry.hooks?.openedAtMs;
  return opened === undefined || entry.peakAtMs === undefined ? undefined : Math.max(0, entry.peakAtMs - opened);
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
    finish(peakMib, legacyPeakMib, peakAgeMs, cliPeakMib) {
      if (peakMib !== undefined) recordPeak("test", peakMib, { ...context.store, measurementBasis: "concurrent-rss", legacyPeakMib, peakAgeMs, cliPeakMib });
      else if (legacyPeakMib !== undefined) recordPeak("test", legacyPeakMib, { ...context.store, measurementBasis: "legacy-hwm", cliPeakMib });
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
  input: { workerClass: WorkerClass; root?: string; entryKind?: "bundle" | "tsx" },
  deps: LearnedReservationOptions = {},
): LearnedReservation {
  // The store lives beside the ledger it learns for: a caller that moved the ledger moved the store with it.
  const store: PeakStoreOptions = {
    ...(deps.ledger?.location ? { location: deps.ledger.location } : {}),
    ...(deps.ledger?.instance ? { instance: deps.ledger.instance } : {}),
    ...deps.store,
    ...(input.root ? { root: input.root } : {}),
    ...(input.entryKind ? { entryKind: input.entryKind } : {}),
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
    ...(input.entryKind ? { entryKind: input.entryKind } : {}),
    ...(estimate.samples > 0 ? { measured: { estimateMib: estimate.estimateMib, samples: estimate.samples } } : {}),
  }, deps.ledger);
  return learnedHandle(handle, input.workerClass, estimate.estimateMib, estimateSourceOf(estimate), input.root, deps, store,
    (deps.ledger?.clock ?? systemClock).now());
}

function learnedHandle(
  handle: MemoryReservationHandle, workerClass: WorkerClass, estimateMib: number, estimateSource: EstimateSource,
  root: string | undefined, deps: LearnedReservationOptions, store: PeakStoreOptions, openedAtMs: number,
): LearnedReservation {
  const sampler = deps.sampler ?? sharedSampler();
  const key = handle.id ?? `untracked-${Math.random().toString(36).slice(2)}`;
  let finished = false;
  const hooks: TrackHooks = {
    openedAtMs,
    ...(workerClass === "test" ? {} : {
      onTestRunner: (pid: number) => openNestedTestRun(pid, { ...(root ? { root } : {}),
        ledger: deps.ledger, store: { ...store, entryKind: undefined } }),
    }),
    onTestFilePeak: (path, peak) => { recordTestFilePeak(path, peak, { ...store, entryKind: undefined }); },
  };
  return {
    id: handle.id,
    get published() { return handle.published; },
    workerClass,
    estimateMib,
    estimateSource,
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
          const measured = sampler.finishMeasurement?.(key);
          const peak = measured ? measured.peakMib : sampler.finish(key);
          if (peak !== undefined) recordPeak(workerClass, peak, { ...store,
            cliPeakMib: measured?.cliPeakMib,
            measurementBasis: measured ? "concurrent-rss" : "legacy-hwm", legacyPeakMib: measured?.legacyPeakMib,
            ...(measured?.peakAgeMs !== undefined ? { peakAgeMs: measured.peakAgeMs } : {}) });
          else if (measured?.legacyPeakMib !== undefined) recordPeak(workerClass, measured.legacyPeakMib, { ...store, measurementBasis: "legacy-hwm", cliPeakMib: measured.cliPeakMib });
        } catch (error) {
          recordError(store, "finish", error);
        }
      }
      handle.releaseOccupancy();
    },
  };
}

/** Resume learning on an adopted child's root without opening another reservation or changing its estimate. */
export function adoptLearnedReservation(
  id: string,
  identity: ProcessIdentity & { generation: ContainerGeneration },
  deps: LearnedReservationOptions = {},
): LearnedReservation | undefined {
  const adopted = adoptMemoryReservation(id, identity, deps.ledger);
  if (!adopted) return undefined;
  const { entry, handle } = adopted;
  const store: PeakStoreOptions = {
    location: deps.ledger?.location, instance: deps.ledger?.instance, root: deps.ledger?.root,
    ...deps.store, ...(entry.entry_kind ? { entryKind: entry.entry_kind } : {}),
  };
  const opened = Date.parse(entry.openedAt); // expiring-fixture: exempt -- the origin of a measured peak age; no threshold compares it.
  const learned = learnedHandle(handle, entry.workerClass, entry.estimateMib, entry.estimateSource, deps.ledger?.root, deps, store,
    Number.isFinite(opened) ? opened : (deps.ledger?.clock ?? systemClock).now());
  learned.bindRoot(identity.pid);
  return learned;
}

/**
 * A reservation held for the duration of SYNCHRONOUS work, released after it whatever `run` does. With `bindSelf` the
 * calling process is the tree (a verb such as check-proof reserving for itself): its own resident memory counts, and its
 * sampled concurrent RSS peak is recorded for the class. Without it nothing is measured (a spawnSync child cannot be sampled
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
