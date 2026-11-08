import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Clock } from "./clock.js";
import type { NearLimitSample } from "./daemon-heap-near-limit.js";
import { HEAP_LIMIT_EXIT_FRACTION, HEAP_PROPOSAL_EVERY_MS } from "./daemon-memory-policy.js";

/** W1-T11383: `daemonMemory.heapAdmissionHold.mode`. Only `enforce`, with a READY verdict, closes a surface. */
export type HeapAdmissionHoldMode = "shadow" | "enforce";

export const HEAP_HOLD_MISSING = [
  "no_same_boot_growth_pairs", "unmeasured_final_gap", "no_room_below_guard", "high_within_ordinary_peaks",
  "no_observed_recovery", "no_observed_rebound", "pair_inverted", "replay_failed", "trace_unread",
] as const;
export type HeapHoldMissing = (typeof HEAP_HOLD_MISSING)[number];

interface TraceChange { from?: NearLimitSample; to?: NearLimitSample; rise_fraction: number }
/** The parts of W1-T11382's persisted trace that readiness reads. */
export interface HeapHoldTrace {
  samples: readonly NearLimitSample[];
  boots: ReadonlyArray<{
    boot_key: string;
    clean_close: boolean;
    peak?: NearLimitSample;
    worst_rise?: TraceChange;
    admission_rise?: TraceChange;
    largest_recovery?: TraceChange;
  }>;
  unread?: string;
}

export interface HeapHoldPair { high: number; low: number; dwell_ms: number }
export interface HeapHoldCounts {
  samples: number;
  readable_samples: number;
  boots: number;
  growth_pairs: number;
  admission_rises: number;
  unclosed_boots: number;
  crossings: number;
  troughs: number;
  rebounds: number;
}
export interface HeapHoldReadiness {
  verdict: "READY" | "NOT READY";
  /** Every failing item; empty exactly when READY. */
  missing: HeapHoldMissing[];
  /** The derived pair and dwell; present on READY, and on NOT READY whenever all three could be derived. */
  pair?: HeapHoldPair;
  worst_rise_fraction?: number;
  reserve_fraction?: number;
  reserve_basis?: "admission_rise" | "worst_rise";
  ordinary_peak_fraction?: number;
  /** The replay's latched share of the retained trace's time. */
  held_share?: number;
  counts: HeapHoldCounts;
}

interface Point { at: number; share: number; admitted: number }
const shareOf = (s: NearLimitSample | undefined): number | undefined =>
  s && typeof s.used_bytes === "number" && typeof s.limit_bytes === "number" && s.limit_bytes > 0 &&
  Number.isFinite(s.used_bytes / s.limit_bytes) ? s.used_bytes / s.limit_bytes : undefined;
const finiteRise = (c: TraceChange | undefined): number | undefined =>
  c && typeof c.rise_fraction === "number" && Number.isFinite(c.rise_fraction) && c.rise_fraction > 0 ? c.rise_fraction : undefined;
const maxOf = (values: readonly number[]): number | undefined => values.length ? Math.max(...values) : undefined;

/**
 * W1-T11383 — may a heap hold be enabled, and at which pair? Pure. Every figure is read from the trace:
 * high = guard - worst same-boot rise - reserve (the largest rise following an admission, else the worst
 * rise); low = the highest post-peak trough plus the troughs' spread; dwell = the longest below-low stretch
 * that rebounded. A replay over the trace must latch before every guard crossing and must not end a boot
 * latched on a recovered heap. `bootKey` names this process's own boot, the one boot not yet closed by design.
 */
export function heapHoldReadiness(
  trace: HeapHoldTrace | undefined, guard: number = HEAP_LIMIT_EXIT_FRACTION, opts: { bootKey?: string } = {},
): HeapHoldReadiness {
  const counts: HeapHoldCounts = { samples: 0, readable_samples: 0, boots: 0, growth_pairs: 0, admission_rises: 0,
    unclosed_boots: 0, crossings: 0, troughs: 0, rebounds: 0 };
  if (!trace || !Array.isArray(trace.samples) || !Array.isArray(trace.boots) || trace.unread !== undefined) {
    return { verdict: "NOT READY", missing: ["trace_unread"], counts };
  }
  const missing = new Set<HeapHoldMissing>();
  counts.samples = trace.samples.length;
  counts.boots = trace.boots.length;
  const series = new Map<string, Point[]>();
  for (const s of trace.samples) {
    const share = shareOf(s);
    if (share === undefined || typeof s.at !== "number") continue;
    counts.readable_samples++;
    const points = series.get(s.boot_key) ?? [];
    points.push({ at: s.at, share, admitted: s.admitted });
    series.set(s.boot_key, points);
  }
  for (const points of series.values()) points.sort((a, b) => a.at - b.at);
  const rises: number[] = [], admissionRises: number[] = [];
  for (const points of series.values()) {
    for (let i = 1; i < points.length; i++) {
      const rise = points[i].share - points[i - 1].share;
      if (rise <= 0 || points[i].at <= points[i - 1].at) continue;
      rises.push(rise);
      if (points[i].admitted > 0) admissionRises.push(rise);
    }
  }
  counts.growth_pairs = rises.length;
  for (const boot of trace.boots) {
    const worst = finiteRise(boot.worst_rise), admission = finiteRise(boot.admission_rise);
    if (worst !== undefined) rises.push(worst);
    if (admission !== undefined) admissionRises.push(admission);
    if (boot.clean_close !== true && boot.boot_key !== opts.bootKey) counts.unclosed_boots++;
  }
  counts.admission_rises = admissionRises.length;
  if (counts.unclosed_boots > 0) missing.add("unmeasured_final_gap");
  const worst = maxOf(rises);
  const admission = maxOf(admissionRises);
  const reserve = admission ?? worst;
  if (worst === undefined) missing.add("no_same_boot_growth_pairs");
  const high = worst === undefined || reserve === undefined ? undefined : guard - worst - reserve;
  if (high !== undefined && !(high > 0)) missing.add("no_room_below_guard");

  const bootPeaks = new Map<string, number>();
  for (const [key, points] of series) bootPeaks.set(key, Math.max(...points.map((p) => p.share)));
  for (const boot of trace.boots) {
    const peak = shareOf(boot.peak);
    if (peak !== undefined) bootPeaks.set(boot.boot_key, Math.max(peak, bootPeaks.get(boot.boot_key) ?? peak));
  }
  const ordinaryPeak = maxOf([...bootPeaks.values()].filter((peak) => peak < guard));
  if (high !== undefined && high > 0 && ordinaryPeak !== undefined && high <= ordinaryPeak) missing.add("high_within_ordinary_peaks");

  const troughs: number[] = [];
  for (const points of series.values()) {
    const peakAt = points.reduce((best, p, i) => p.share > points[best].share ? i : best, 0);
    const after = points.slice(peakAt + 1).map((p) => p.share);
    const trough = maxOf(after) === undefined ? undefined : Math.min(...after);
    if (trough !== undefined && trough < points[peakAt].share) troughs.push(trough);
  }
  counts.troughs = troughs.length;
  if (troughs.length === 0) missing.add("no_observed_recovery");
  const low = troughs.length ? Math.max(...troughs) + (Math.max(...troughs) - Math.min(...troughs)) : undefined;

  let dwell: number | undefined;
  if (low !== undefined) {
    for (const points of series.values()) {
      let since: number | undefined;
      for (const p of points) {
        if (p.share < low) since ??= p.at;
        else if (since !== undefined) {
          counts.rebounds++;
          dwell = Math.max(dwell ?? 0, p.at - since);
          since = undefined;
        }
      }
    }
  }
  if (low !== undefined && dwell === undefined) missing.add("no_observed_rebound");
  if (high !== undefined && low !== undefined && low >= high) missing.add("pair_inverted");

  const derived = high !== undefined && high > 0 && low !== undefined && low < high && dwell !== undefined;
  const pair = derived ? { high, low, dwell_ms: dwell! } : undefined;
  let heldShare: number | undefined;
  if (pair) {
    let unlatchedCrossings = 0, endedLatchedRecovered = 0, heldMs = 0, spanMs = 0;
    for (const points of series.values()) {
      let latched = false, belowSince: number | undefined;
      points.forEach((p, i) => {
        if (i > 0 && latched) heldMs += p.at - points[i - 1].at;
        if (p.share >= guard) {
          counts.crossings++;
          if (!latched) unlatchedCrossings++;
        }
        const next = stepLatch({ latched, belowSince }, p.share, p.at, pair);
        latched = next.latched; belowSince = next.belowSince;
      });
      spanMs += points[points.length - 1].at - points[0].at;
      if (latched && points[points.length - 1].share < pair.low) endedLatchedRecovered++;
    }
    heldShare = spanMs > 0 ? heldMs / spanMs : 0;
    if (unlatchedCrossings > 0 || endedLatchedRecovered > 0) missing.add("replay_failed");
  } else {
    for (const points of series.values()) counts.crossings += points.filter((p) => p.share >= guard).length;
  }
  const ordered = HEAP_HOLD_MISSING.filter((item) => missing.has(item));
  return {
    verdict: ordered.length === 0 ? "READY" : "NOT READY",
    missing: ordered,
    ...(pair ? { pair } : {}),
    ...(worst === undefined ? {} : { worst_rise_fraction: worst, reserve_fraction: reserve,
      reserve_basis: admission === undefined ? "worst_rise" as const : "admission_rise" as const }),
    ...(ordinaryPeak === undefined ? {} : { ordinary_peak_fraction: ordinaryPeak }),
    ...(heldShare === undefined ? {} : { held_share: heldShare }),
    counts,
  };
}

interface LatchState { latched: boolean; belowSince?: number }
/** One reading against a pair: set at or above high; once set, release only after the whole dwell below low. */
function stepLatch(state: LatchState, share: number, at: number, pair: HeapHoldPair): LatchState {
  if (!state.latched) return share >= pair.high ? { latched: true } : { latched: false };
  if (share >= pair.low) return { latched: true };
  const since = state.belowSince ?? at;
  return at - since >= pair.dwell_ms ? { latched: false } : { latched: true, belowSince: since };
}

/** Parse `daemonMemory.heapAdmissionHold` fail-closed: anything but an explicit `enforce` is shadow. */
export function parseHeapAdmissionHoldMode(daemonMemory: unknown): { mode: HeapAdmissionHoldMode; error?: string } {
  if (daemonMemory === undefined || daemonMemory === null) return { mode: "shadow" };
  const section = typeof daemonMemory === "object" ? (daemonMemory as Record<string, unknown>).heapAdmissionHold : undefined;
  if (section === undefined) return { mode: "shadow" };
  const raw = typeof section === "object" && section !== null ? (section as Record<string, unknown>).mode : undefined;
  const mode = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).value : raw;
  if (mode === "enforce" || mode === "shadow") return { mode };
  return { mode: "shadow", error: `daemonMemory.heapAdmissionHold.mode must be shadow or enforce, got ${JSON.stringify(mode)}` };
}

export function readHeapAdmissionHoldMode(
  policyYamlPath: string, read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): { mode: HeapAdmissionHoldMode; error?: string } {
  try {
    const raw = parseYaml(read(policyYamlPath)) as unknown;
    return parseHeapAdmissionHoldMode(typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).daemonMemory : undefined);
  } catch (error) {
    return { mode: "shadow", error: String((error as Error)?.message ?? error).slice(0, 200) };
  }
}

export interface HeapAdmissionHoldVerdict {
  control: "HEAP";
  detail: string;
  episode: number;
}
export interface HeapAdmissionHoldLatch {
  read(surface: string, sample: NearLimitSample | undefined): HeapAdmissionHoldVerdict | undefined;
  /** True once per surface per latch episode: the one held read that writes the surface's row. */
  firstHeld(surface: string): boolean;
  readiness(): HeapHoldReadiness;
  latched(): boolean;
}
export interface HeapAdmissionHoldOptions {
  mode?: HeapAdmissionHoldMode;
  modeError?: string;
  readTrace: () => HeapHoldTrace | undefined;
  clock: Clock;
  log: (step: string, fields: Record<string, unknown>) => void;
  guard?: number;
}

/** W1-T11383 — the per-boot latch. No timer: readiness is derived at creation, then on a read once
 *  HEAP_PROPOSAL_EVERY_MS has passed and at each release. A restart starts a new process and a clear latch. */
export function createHeapAdmissionHold(opts: HeapAdmissionHoldOptions): HeapAdmissionHoldLatch {
  const mode = opts.mode ?? "shadow";
  const guard = opts.guard ?? HEAP_LIMIT_EXIT_FRACTION;
  let bootKey: string | undefined;
  let readiness: HeapHoldReadiness = { verdict: "NOT READY", missing: ["trace_unread"], counts: heapHoldReadiness(undefined).counts };
  let derivedAt = -Infinity;
  let latch: LatchState = { latched: false };
  let pinned: { pair: HeapHoldPair; live: boolean; at: number } | undefined;
  let episode = 0;
  let surfaces = new Set<string>();
  const emit = (step: string, fields: Record<string, unknown>): void => {
    try { opts.log(step, fields); }
    catch (error) { void error; /* The report sink failed; a row must never decide admission. */ }
  };
  const derive = (reason: "boot" | "hourly" | "release"): void => {
    derivedAt = opts.clock.now();
    let trace: HeapHoldTrace | undefined;
    try { trace = opts.readTrace(); }
    catch (error) { void error; trace = undefined; /* An unreadable trace is the named trace_unread item. */ }
    const previous = readiness.verdict;
    readiness = heapHoldReadiness(trace, guard, { bootKey });
    if (reason !== "release" || readiness.verdict !== previous) {
      emit("daemon.heap_admission_hold_readiness", { reason: reason === "release" ? "verdict_change" : reason,
        verdict_changed: readiness.verdict !== previous, mode, ...(opts.modeError ? { mode_error: opts.modeError } : {}),
        guard, ...readiness });
    }
  };
  derive("boot");
  const transition = (kind: "latched" | "released", surface: string, share: number): void => {
    emit("daemon.heap_admission_hold", { transition: kind, shadow: !pinned!.live, mode, verdict: readiness.verdict, surface,
      reading: share, episode, ...pinned!.pair });
  };
  return {
    read(surface, sample) {
      if (sample?.boot_key) bootKey = sample.boot_key;
      if (opts.clock.now() - derivedAt >= HEAP_PROPOSAL_EVERY_MS) derive("hourly");
      const share = shareOf(sample);
      if (share !== undefined && sample) {
        if (!latch.latched) {
          const pair = readiness.pair;
          if (pair && share >= pair.high) {
            latch = { latched: true };
            episode++;
            surfaces = new Set();
            pinned = { pair, live: mode === "enforce" && readiness.verdict === "READY", at: sample.at };
            transition("latched", surface, share);
          }
        } else if (pinned) {
          latch = stepLatch(latch, share, sample.at, pinned.pair);
          if (!latch.latched) {
            transition("released", surface, share);
            pinned = undefined;
            derive("release");
          }
        }
      }
      if (!latch.latched || !pinned?.live) return undefined;
      const { high, low, dwell_ms } = pinned.pair;
      return { control: "HEAP", episode,
        detail: `heap latched at ${high.toFixed(4)} of its limit; releases below ${low.toFixed(4)} held ${dwell_ms} ms` };
    },
    firstHeld(surface) {
      if (surfaces.has(surface)) return false;
      surfaces.add(surface);
      return true;
    },
    readiness: () => readiness,
    latched: () => latch.latched,
  };
}
