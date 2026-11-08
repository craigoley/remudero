import { readFileSync } from "node:fs";
import { getHeapStatistics } from "node:v8";
import { systemClock, type Clock } from "./clock.js";
import { FOOTPRINT_MAX_SAMPLES } from "./daemon-footprint.js";
import {
  HEAP_LIMIT_EXIT_FRACTION, HEAP_SAMPLE_RETAIN_MS, HEAP_SAMPLE_MIN_GAP_MS,
  HEAP_SAMPLE_PERSIST_GAP_MS, HEAP_PROPOSAL_EVERY_MS, readDaemonMemory, quantileOf,
  type DaemonMemoryReading, type HeapSampleIo,
} from "./daemon-memory-policy.js";
import { writeAtomic } from "./fs-race-safe.js";

export const NEAR_HEAP_FILE = "daemon-heap-near-limit.json";
/** BACKSTOP: at most one summary per raw-ring slot, even under a restart storm. */
export const NEAR_LIMIT_MAX_BOOTS = FOOTPRINT_MAX_SAMPLES;
/** BACKSTOP: two MiB bounds both the load and the serialized store. */
export const NEAR_LIMIT_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** BACKSTOP: a boot cannot emit more transition rows than the raw ring holds. */
export const NEAR_LIMIT_MAX_ROWS_PER_BOOT = FOOTPRINT_MAX_SAMPLES;
/** BACKSTOP: coalesce reads within one millisecond or the preceding read's cost, whichever is larger. */
export const NEAR_LIMIT_READ_BACKSTOP_MS = 1;
const PROCESS_BOOT_START = systemClock.now() - Math.round(process.uptime() * 1_000);

export interface NearLimitWork {
  active: number;
  admitted: number;
  in_flight_tasks: number;
  in_flight_reviews: number;
  detached_sweep_actions: number;
}
export interface NearLimitSample extends NearLimitWork {
  at: number;
  boot_key: string;
  surface: string;
  used_bytes?: number;
  limit_bytes?: number;
  rss_bytes?: number;
  swap_bytes?: number;
  budget_bytes?: number;
  memory_psi?: { some_avg10?: number; full_avg10?: number };
  elapsed_ms?: number;
}
interface HeapChange {
  from: NearLimitSample;
  to: NearLimitSample;
  rise_bytes: number;
  rise_fraction: number;
  elapsed_ms: number;
  bytes_per_second: number;
}
interface BootSummary {
  boot_key: string;
  last: NearLimitSample;
  peak?: NearLimitSample;
  worst_rise?: HeapChange;
  admission_rise?: HeapChange;
  largest_recovery?: HeapChange;
  clean_close: boolean;
  final_gap: "unmeasured" | "clean_close";
  transition_rows: number;
  suppressed_transitions: number;
  last_transition_at?: number;
  last_band?: number;
}
interface Trace {
  samples: NearLimitSample[];
  boots: BootSummary[];
  unread?: string;
}
export interface NearLimitHeapTelemetry {
  recordNearLimitHeapSample(surface: string, work: NearLimitWork): NearLimitSample | undefined;
  close(): void;
}
export interface NearLimitHeapOptions {
  path: string;
  clock?: Clock;
  pid?: number;
  bootStart?: number;
  heap?: () => { used_heap_size: number; heap_size_limit: number };
  memory?: () => Partial<DaemonMemoryReading>;
  pressure?: () => string;
  io?: HeapSampleIo;
  log?: (step: string, fields: Record<string, unknown>) => void;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const onlyKeys = (value: object, keys: readonly string[]): boolean => Object.keys(value).every(key => keys.includes(key));
const share = (s: NearLimitSample): number | undefined =>
  s.used_bytes !== undefined && s.limit_bytes !== undefined && s.limit_bytes > 0 ? s.used_bytes / s.limit_bytes : undefined;
const band = (s: NearLimitSample): number | undefined => {
  const fraction = share(s);
  return fraction === undefined ? undefined : Math.min(4, Math.floor(fraction / (HEAP_LIMIT_EXIT_FRACTION / 4)));
};
function validSample(s: NearLimitSample | undefined): s is NearLimitSample {
  return !!s && finite(s.at) && typeof s.boot_key === "string" && s.boot_key.length <= 80 &&
    typeof s.surface === "string" && s.surface.length <= 128 &&
    onlyKeys(s, ["at", "boot_key", "surface", "active", "admitted", "in_flight_tasks", "in_flight_reviews",
      "detached_sweep_actions", "used_bytes", "limit_bytes", "rss_bytes", "swap_bytes", "budget_bytes", "memory_psi", "elapsed_ms"]) &&
    (s.memory_psi === undefined || (s.memory_psi !== null && typeof s.memory_psi === "object" &&
      onlyKeys(s.memory_psi, ["some_avg10", "full_avg10"]))) &&
    [s.active, s.admitted, s.in_flight_tasks, s.in_flight_reviews, s.detached_sweep_actions].every(finite) &&
    [s.used_bytes, s.limit_bytes, s.rss_bytes, s.swap_bytes, s.budget_bytes, s.elapsed_ms,
      s.memory_psi?.some_avg10, s.memory_psi?.full_avg10].every(n => n === undefined || finite(n));
}
function validBoot(b: BootSummary): boolean {
  return !!b && validSample(b.last) && b.boot_key === b.last.boot_key && typeof b.clean_close === "boolean" &&
    onlyKeys(b, ["boot_key", "last", "peak", "worst_rise", "admission_rise", "largest_recovery", "clean_close", "final_gap",
      "transition_rows", "suppressed_transitions", "last_transition_at", "last_band"]) &&
    finite(b.transition_rows) && b.transition_rows <= NEAR_LIMIT_MAX_ROWS_PER_BOOT && finite(b.suppressed_transitions) &&
    (b.last_transition_at === undefined || finite(b.last_transition_at)) &&
    (b.last_band === undefined || (Number.isInteger(b.last_band) && b.last_band >= 0 && b.last_band <= 4)) &&
    b.final_gap === (b.clean_close ? "clean_close" : "unmeasured") &&
    (b.peak === undefined || (validSample(b.peak) && b.peak.boot_key === b.boot_key)) &&
    [b.worst_rise, b.admission_rise, b.largest_recovery].every(p => p === undefined ||
      (p !== null && validSample(p.from) && validSample(p.to) && p.from.boot_key === b.boot_key && p.to.boot_key === b.boot_key &&
        onlyKeys(p, ["from", "to", "rise_bytes", "rise_fraction", "elapsed_ms", "bytes_per_second"]) &&
        [p.rise_bytes, p.rise_fraction, p.elapsed_ms, p.bytes_per_second].every(finite)));
}
function change(from: NearLimitSample, to: NearLimitSample): HeapChange | undefined {
  const a = share(from), b = share(to), elapsed = to.at - from.at;
  if (from.boot_key !== to.boot_key || elapsed <= 0 || a === undefined || b === undefined) return undefined;
  const bytes = Math.abs(to.used_bytes! - from.used_bytes!);
  return { from, to, rise_bytes: bytes, rise_fraction: bytes / to.limit_bytes!, elapsed_ms: elapsed,
    bytes_per_second: bytes * 1_000 / elapsed };
}

/** Report-only trace. No caller receives a hold, a proposed ceiling or a growth flag. */
export function createNearLimitHeapTelemetry(opts: NearLimitHeapOptions) {
  const clock = opts.clock ?? systemClock;
  const bootKey = `${opts.pid ?? process.pid}:${opts.bootStart ?? PROCESS_BOOT_START}`;
  const io = opts.io ?? {
    readFile: (path: string) => readFileSync(path, "utf8"),
    writeFile: (path: string, content: string) => { writeAtomic(path, content, { tmpTag: "heap-near-limit-tmp" }); },
  };
  let trace: Trace = { samples: [], boots: [] };
  let failureReported = false;
  const emit = (step: string, fields: Record<string, unknown>): void => {
    try { opts.log?.(step, fields); }
    catch (error) { void error; /* The report sink failed; observations must never affect work. */ }
  };
  const failed = ({ reason }: { reason: unknown }): void => {
    if (failureReported) return;
    failureReported = true;
    emit("daemon.heap_near_limit_persist_failed", { boot_key: bootKey, path: opts.path, reason: String(reason).slice(0, 160) });
  };
  try {
    const text = io.readFile(opts.path);
    if (Buffer.byteLength(text) > NEAR_LIMIT_MAX_FILE_BYTES) throw Error("file exceeds byte backstop");
    let parsed: Trace;
    try { parsed = JSON.parse(text); }
    catch (error) { void error; throw Error("unparseable"); }
    if (!parsed || !Array.isArray(parsed.samples) || !Array.isArray(parsed.boots)) throw Error("invalid trace");
    for (const boot of parsed.boots) {
      if (boot && typeof boot === "object" && !Object.hasOwn(boot, "clean_close")) {
        boot.clean_close = false;
        boot.final_gap = "unmeasured";
      }
    }
    if (!parsed.samples.every(validSample) || !parsed.boots.every(validBoot)) throw Error("invalid trace");
    const allowed = new Set(["samples", "boots", "unread"]);
    if (Object.keys(parsed).some(key => !allowed.has(key)) ||
      (parsed.unread !== undefined && (typeof parsed.unread !== "string" || parsed.unread.length > 160))) throw Error("invalid trace fields");
    trace = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      trace.unread = String((error as Error)?.message ?? error).slice(0, 160);
      failed({ reason: trace.unread });
    }
  }
  const trim = (at: number): void => {
    trace.samples = trace.samples.filter(s => s.at <= at && at - s.at <= HEAP_SAMPLE_RETAIN_MS).slice(-FOOTPRINT_MAX_SAMPLES);
    trace.boots = trace.boots.filter(b => b.last.at <= at && at - b.last.at <= HEAP_SAMPLE_RETAIN_MS).slice(-NEAR_LIMIT_MAX_BOOTS);
    for (const boot of trace.boots) {
      for (const key of ["worst_rise", "admission_rise", "largest_recovery"] as const) {
        if (boot[key] && at - boot[key]!.from.at > HEAP_SAMPLE_RETAIN_MS) delete boot[key];
      }
      if (boot.peak && at - boot.peak.at > HEAP_SAMPLE_RETAIN_MS) delete boot.peak;
    }
  };
  trim(clock.now());
  const priorBoot = trace.boots.find(b => b.boot_key === bootKey);
  let previous = priorBoot?.last;
  let nextReadAt = -Infinity, lastPersist = -Infinity, lastProposal = -Infinity;
  let lastRow = priorBoot?.last_transition_at ?? -Infinity;
  let previousBand = priorBoot?.last_band;
  let rows = priorBoot?.transition_rows ?? 0, suppressed = priorBoot?.suppressed_transitions ?? 0;
  const flush = (): void => {
    lastPersist = clock.now();
    try {
      trim(lastPersist);
      const text = `${JSON.stringify(trace)}\n`;
      if (Buffer.byteLength(text) > NEAR_LIMIT_MAX_FILE_BYTES) throw Error("trace exceeds byte backstop");
      io.writeFile(opts.path, text);
    } catch (error) { failed({ reason: error }); }
  };
  const shadow = (at: number): void => {
    lastProposal = at;
    const boots = trace.boots;
    const rises = boots.flatMap(b => b.worst_rise ? [b.worst_rise] : []);
    const worst = rises.reduce<HeapChange | undefined>((best, p) => !best || p.rise_fraction > best.rise_fraction ? p : best, undefined);
    const peak = Math.max(-Infinity, ...boots.flatMap(b => b.peak && share(b.peak) !== undefined ? [share(b.peak)!] : []));
    const admission = Math.max(-Infinity, ...boots.flatMap(b => b.admission_rise ? [b.admission_rise.rise_fraction] : []));
    const recovery = Math.max(-Infinity, ...boots.flatMap(b => b.largest_recovery ? [b.largest_recovery.rise_bytes] : []));
    const pairs = trace.samples.flatMap((s, i, all) => {
      const prior = all[i - 1];
      const p = prior && change(prior, s);
      return p && s.used_bytes! > prior.used_bytes! ? [p.rise_bytes] : [];
    });
    const p99 = quantileOf(pairs, 0.99);
    emit("daemon.heap_hold_shadow", { shadow: true, report_only: true, boot_key: bootKey, at,
      ...(worst ? { worst_rise_bytes: worst.rise_bytes, rise_bytes_per_second: worst.bytes_per_second }
        : { worst_rise_unlearned: "no same-boot rise", rise_rate_unlearned: "no same-boot rise" }),
      ...(p99 === undefined ? { p99_rise_unlearned: "no retained same-boot rise" } : { p99_rise_bytes: p99 }),
      ...(Number.isFinite(peak) ? { peak_fraction: peak, reserve_fraction: HEAP_LIMIT_EXIT_FRACTION - peak }
        : { peak_unlearned: "no readable heap", reserve_unlearned: "no readable heap" }),
      ...(Number.isFinite(recovery) ? { recovery_bytes: recovery } : { recovery_unlearned: "no same-boot recovery" }),
      ...(worst && Number.isFinite(admission)
        ? { candidate_high_fraction: HEAP_LIMIT_EXIT_FRACTION - worst.rise_fraction - admission }
        : { candidate_high_unlearned: worst ? "no rise following admission" : "no same-boot rise" }),
      ...(trace.unread === undefined ? {} : { trace_unread: trace.unread }),
    });
  };
  const read = <T>(reader: () => T): T | undefined => {
    try { return reader(); }
    catch (error) { failed({ reason: error }); return undefined; }
  };
  return {
    recordNearLimitHeapSample(surface: string, work: NearLimitWork): NearLimitSample | undefined {
      const at = clock.now();
      if (previous && at >= previous.at && at < nextReadAt) return previous;
      const heap = read(opts.heap ?? getHeapStatistics);
      const memory = read(opts.memory ?? readDaemonMemory);
      const pressure = read(opts.pressure ?? (() => readFileSync("/sys/fs/cgroup/memory.pressure", "utf8")));
      const psi: NonNullable<NearLimitSample["memory_psi"]> = {};
      for (const key of ["some", "full"] as const) {
        const match = pressure?.match(new RegExp(`^${key} avg10=([0-9.]+) `, "m"));
        if (match && finite(Number(match[1]))) psi[`${key}_avg10`] = Number(match[1]);
      }
      const sample: NearLimitSample = { at, boot_key: bootKey, surface: surface.slice(0, 128), ...work };
      const fields = { used_bytes: heap?.used_heap_size, limit_bytes: heap?.heap_size_limit,
        rss_bytes: memory?.rss_bytes, swap_bytes: memory?.swap_bytes, budget_bytes: memory?.budget_bytes };
      for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
        if (finite(fields[key]) && ((key !== "limit_bytes" && key !== "budget_bytes") || fields[key]! > 0)) sample[key] = fields[key];
      }
      if (Object.keys(psi).length) sample.memory_psi = psi;
      if (previous && previous.at <= at) sample.elapsed_ms = at - previous.at;
      nextReadAt = at + Math.max(NEAR_LIMIT_READ_BACKSTOP_MS, clock.now() - at);
      trim(at);
      let boot = trace.boots.find(b => b.boot_key === bootKey);
      if (!boot) {
        boot = { boot_key: bootKey, last: sample, clean_close: false, final_gap: "unmeasured",
          transition_rows: rows, suppressed_transitions: suppressed };
        trace.boots.push(boot);
      }
      boot.clean_close = false; boot.final_gap = "unmeasured";
      const pair = previous && change(previous, sample);
      if (pair && sample.used_bytes! > previous!.used_bytes!) {
        if (!boot.worst_rise || pair.rise_fraction > boot.worst_rise.rise_fraction) boot.worst_rise = pair;
        if (sample.admitted > 0 &&
          (!boot.admission_rise || pair.rise_fraction > boot.admission_rise.rise_fraction)) boot.admission_rise = pair;
      } else if (pair && sample.used_bytes! < previous!.used_bytes! &&
        (!boot.largest_recovery || pair.rise_bytes > boot.largest_recovery.rise_bytes)) boot.largest_recovery = pair;
      if (share(sample) !== undefined && (!boot.peak || share(sample)! > share(boot.peak)!)) boot.peak = sample;
      boot.last = sample;
      trace.samples.push(sample);
      trim(at);
      const nextBand = band(sample);
      const transition = nextBand !== undefined && previousBand !== undefined && nextBand !== previousBand;
      const rising = transition && nextBand! > previousBand!;
      if (transition) {
        if (at - lastRow >= HEAP_SAMPLE_MIN_GAP_MS && rows < NEAR_LIMIT_MAX_ROWS_PER_BOOT) {
          emit("daemon.heap_near_limit", { ...sample, report_only: true, band: nextBand, previous_band: previousBand, suppressed });
          lastRow = at; rows++; suppressed = 0;
        } else suppressed = Math.min(Number.MAX_SAFE_INTEGER, suppressed + 1);
      }
      if (nextBand !== undefined) previousBand = nextBand;
      boot.transition_rows = rows; boot.suppressed_transitions = suppressed;
      if (Number.isFinite(lastRow)) boot.last_transition_at = lastRow;
      if (previousBand !== undefined) boot.last_band = previousBand;
      previous = sample;
      if (rising || at - lastPersist >= HEAP_SAMPLE_PERSIST_GAP_MS) flush();
      if (at - lastProposal >= HEAP_PROPOSAL_EVERY_MS) shadow(at);
      return sample;
    },
    flush,
    close(): void {
      const boot = trace.boots.find(b => b.boot_key === bootKey);
      if (boot) { boot.clean_close = true; boot.final_gap = "clean_close"; }
      flush();
    },
    snapshot: (): Trace => structuredClone(trace),
  };
}
