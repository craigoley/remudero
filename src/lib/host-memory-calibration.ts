import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeAtomic } from "./fs-race-safe.js";
import type { PeakSample } from "./host-memory-learning.js";
import { parseProcStat, type WorkerClass } from "./host-memory-ledger.js";

export const JOINT_MODEL = "independent-empirical-convolution-v1";
/** PROPOSAL: upper rounding bounds quantization error by16MiB per live claim. */
export const JOINT_BIN_MIB = 16;
/** BACKSTOP: a synchronous start must fall back instead of expanding an exponential convolution. */
const CONVOLUTION_OPS = 250_000;
/** The acceptance's future outcome window and qualification history, not a polling cadence. */
export const BACKTEST_WINDOW_MS = 30 * 60_000;
export const CALIBRATION_DAY_MS = 24 * 60 * 60_000;
/** PRIMARY CONTROL, proposed: over4minutes between heartbeat readings is unknown coverage (the default poll is60s). */
export const OBSERVATION_MAX_GAP_MS = 4 * 60_000;
/** BACKSTOP: pending forecasts normally cover only30minutes; overload is named and never drops a start. */
const PENDING_MAX = 4096;
/** BACKSTOP: bounds each passive JSON read and its retained outcome population. */
const STATE_BYTES_MAX = 8 * 1024 * 1024;
const OUTCOMES_MAX = 16_384;
export const CALIBRATION_DIR = "memory-calibration";
let calibrationSink: ((stateDir: string, at: number, report: ReturnType<typeof calibrationReport>) => void) | undefined;
export function installCalibrationSink(sink: typeof calibrationSink): void { calibrationSink = sink; }

export interface JointMember { workerClass: WorkerClass; residentRssMib: number; own: boolean; released?: boolean }
export type JointEstimate = { kind: "joint"; hostMib: number; ownMib: number; quantile: number; model: typeof JOINT_MODEL }
  | { kind: "fallback"; reason: string };

/** Marginal independence is a MODEL to back-test, not a claim about correlated workload tails. */
export function jointMemoryClaim(members: readonly JointMember[], samples: readonly PeakSample[], now: number, quantile = 0.95): JointEstimate {
  if (!(quantile >= 0.5 && quantile < 1) || !Number.isFinite(now)) return { kind: "fallback", reason: "invalid quantile or clock" };
  const live = members.filter(m => !m.released), minimum = Math.ceil(1 / (1 - quantile) - 1e-8);
  if (live.length > 32) return { kind: "fallback", reason: "too many concurrent claims" };
  const populations = new Map<WorkerClass, number[]>();
  for (const member of live) {
    if (!Number.isFinite(member.residentRssMib) || member.residentRssMib < 0) return { kind: "fallback", reason: "resident RSS unavailable" };
    const peaks = samples.filter(s => s.workerClass === member.workerClass && s.measurementBasis === "concurrent-rss" &&
      !s.testFile && Number.isFinite(s.peakMib) && s.peakMib > 0 && s.at <= now && s.at >= now - CALIBRATION_DAY_MS)
      .sort((a, b) => a.at - b.at).slice(-128).map(s => s.peakMib);
    if (peaks.length < minimum) return { kind: "fallback", reason: `few concurrent-RSS samples: ${member.workerClass}` };
    populations.set(member.workerClass, peaks);
  }
  let operations = 0;
  const convolve = (own: boolean): number | undefined => {
    let distribution = new Map<number, number>([[0, 1]]);
    for (const member of live.filter(m => !own || m.own)) {
      const peaks = populations.get(member.workerClass)!;
      const marginal = new Map<number, number>();
      for (const peak of peaks) {
        const bin = Math.ceil(Math.max(0, peak - member.residentRssMib) / JOINT_BIN_MIB);
        marginal.set(bin, (marginal.get(bin) ?? 0) + 1 / peaks.length);
      }
      const next = new Map<number, number>();
      for (const [a, p] of distribution) for (const [b, q] of marginal) {
        if (++operations > CONVOLUTION_OPS) return undefined;
        next.set(a + b, (next.get(a + b) ?? 0) + p * q);
      }
      distribution = next;
    }
    let total = 0;
    for (const [value, probability] of [...distribution].sort(([a], [b]) => a - b)) {
      total += probability;
      if (total + 1e-12 >= quantile) return value * JOINT_BIN_MIB;
    }
    return undefined;
  };
  const hostMib = convolve(false), ownMib = convolve(true);
  return hostMib === undefined || ownMib === undefined ? { kind: "fallback", reason: "bounded convolution unavailable" }
    : { kind: "joint", hostMib, ownMib, quantile, model: JOINT_MODEL };
}

export interface MemoryForecast {
  id: string; at: number; generation: string; scenario: string; model: string; quantile: number;
  projectedMib: number; initialMib: number; basis: "cgroup-current-mib";
}
export interface MemoryObservation { at: number; mib: number | null; peakMib?: number | null; generation: string; reason?: string }
export interface MemoryOutcome extends MemoryForecast { closedAt: number; windowPeakUpperBoundMib: number | null; upperBoundExceedsForecast: boolean | null; complete: boolean; reason?: string }
export interface CalibrationState {
  version: 1; startedAt: number; coveredSince: number; lastAt: number; generation: string;
  observations: MemoryObservation[]; outcomes: MemoryOutcome[]; issues: Array<{ at: number; reason: string }>;
}

export function gradeMemoryForecast(forecast: MemoryForecast, observations: readonly MemoryObservation[], now: number): MemoryOutcome | undefined {
  const end = forecast.at + BACKTEST_WINDOW_MS;
  if (now < end) return undefined;
  const after = observations.filter(o => o.at >= end).sort((a, b) => a.at - b.at)[0];
  const rows = [{ at: forecast.at, mib: forecast.initialMib, generation: forecast.generation },
    ...observations.filter(o => o.at > forecast.at && o.at < end), ...(after ? [after] : [])].sort((a, b) => a.at - b.at);
  // The unchanged cgroup's lifetime high-water mark conservatively bounds this window too.
  // It may overstate this window; periodic memory.current alone cannot prove absence of a short peak.
  const measured = rows.flatMap(o => o.mib === null ? [] : [o.mib]);
  if (after?.peakMib !== null && after?.peakMib !== undefined) measured.push(after.peakMib);
  const windowPeakUpperBoundMib = measured.length ? Math.max(...measured) : null;
  const reason = !after || after.at - end > OBSERVATION_MAX_GAP_MS ? "missing closing observation"
    : rows.some(o => o.generation !== forecast.generation) ? "generation changed"
      : rows.some((o, i) => o.mib === null || (i > 0 && o.at - rows[i - 1]!.at > OBSERVATION_MAX_GAP_MS)) ? "observation gap or unreadable charge"
        : !after || after.peakMib == null || observations.some((o, i) => o.at >= forecast.at && o.at <= after.at &&
          (o.peakMib == null || o.peakMib < (o.mib ?? 0) || (i > 0 && observations[i - 1]!.peakMib != null && o.peakMib < observations[i - 1]!.peakMib!)))
          ? "kernel high-water coverage unavailable or reset"
          : forecast.scenario === "unknown" ? "unknown scenario" : undefined;
  return { ...forecast, closedAt: now, windowPeakUpperBoundMib, upperBoundExceedsForecast: windowPeakUpperBoundMib === null ? null : windowPeakUpperBoundMib > forecast.projectedMib,
    complete: reason === undefined, ...(reason ? { reason } : {}) };
}

export function calibrationReport(state: CalibrationState, now: number, quantile = 0.95, maxMissRate = 0.05) {
  const closed = state.outcomes.filter(o => o.at >= now - CALIBRATION_DAY_MS && o.at + BACKTEST_WINDOW_MS <= now);
  const scenarios = Object.fromEntries([...new Set(closed.map(o => o.scenario))].map(scenario => {
    const rows = closed.filter(o => o.scenario === scenario), valid = rows.filter(o => o.complete && o.model === JOINT_MODEL && o.quantile === quantile &&
      o.windowPeakUpperBoundMib !== null && o.upperBoundExceedsForecast === (o.windowPeakUpperBoundMib > o.projectedMib));
    return [scenario, { forecasts: rows.length, complete: valid.length, unknown: rows.length - valid.length,
      upperBoundExceedances: rows.filter(o => o.upperBoundExceedsForecast === true).length, exceedanceRateUpperBound: valid.length ? valid.filter(o => o.upperBoundExceedsForecast).length / valid.length : null }];
  }));
  const reasons = state.issues.filter(i => i.at >= now - CALIBRATION_DAY_MS).map(i => i.reason);
  if (now - state.coveredSince < CALIBRATION_DAY_MS || now - state.startedAt < CALIBRATION_DAY_MS) reasons.push("less than24h continuous coverage");
  if (now < state.lastAt || now - state.lastAt > OBSERVATION_MAX_GAP_MS) reasons.push("stale observation store");
  if (!closed.length) reasons.push("no closed forecast positive control");
  const latest = state.observations.at(-1);
  if (!latest || latest.mib === null || latest.at !== state.lastAt || latest.generation !== state.generation) reasons.push("no current readable observation positive control");
  if (!(quantile >= 0.5 && quantile < 1 && maxMissRate >= 0 && maxMissRate <= 1)) reasons.push("invalid qualification policy");
  for (const [scenario, s] of Object.entries(scenarios)) {
    if (s.unknown || s.complete < Math.ceil(1 / (1 - quantile) - 1e-8) || s.exceedanceRateUpperBound === null || s.exceedanceRateUpperBound > maxMissRate) reasons.push(`unqualified scenario: ${scenario}`);
  }
  return { model: JOINT_MODEL, quantile, maxMissRate,
    rateKind: "conservative-upper-bound-exceedances-not-confirmed-window-misses" as const,
    basis: "cgroup.current plus unchanged-generation monotonic lifetime memory.peak upper bound; may overstate the30minute window, never reset by this collector",
    coveredSince: state.coveredSince, lastAt: state.lastAt, scenarios, qualified: reasons.length === 0, reasons };
}

export interface CalibrationIo {
  read: (path: string) => string; write: (path: string, text: string) => void;
  publish: (path: string, text: string) => void; list: (path: string) => string[]; remove: (path: string) => void;
}

const defaultIo: CalibrationIo = {
  read: path => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > STATE_BYTES_MAX) throw new Error("calibration state too large or not regular");
      const bytes = Buffer.alloc(stat.size + 1); let used = 0;
      for (;;) { const n = readSync(fd, bytes, used, bytes.length - used, used); if (n === 0) break; used += n; if (used === bytes.length) break; }
      if (used !== stat.size || fstatSync(fd).size !== stat.size) throw new Error("calibration file changed during read");
      return bytes.subarray(0, used).toString("utf8");
    }
    finally { closeSync(fd); }
  },
  write: (path, text) => { mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 }); writeAtomic(path, text, { mode: 0o600, tmpTag: "calibration" }); },
  publish: (path, text) => {
    const staging = join(dirname(dirname(path)), "staging");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); mkdirSync(staging, { recursive: true, mode: 0o700 });
    const stage = join(staging, randomUUID() + ".json");
    try {
      writeFileSync(stage, text, { flag: "wx", mode: 0o600, flush: true });
      linkSync(stage, path); // Atomic create-only publication: the collector never sees a half-written forecast.
    } finally {
      try { unlinkSync(stage); } catch { /* Only this private stage; an interrupted cleanup cannot erase a published forecast. */ }
    }
  },
  list: path => readdirSync(path), remove: path => unlinkSync(path),
};

export const calibrationStatePath = (stateDir: string): string => join(stateDir, CALIBRATION_DIR, "state.json");
const pendingDir = (stateDir: string): string => join(stateDir, CALIBRATION_DIR, "pending");
const publishErrorPath = (stateDir: string): string => join(stateDir, CALIBRATION_DIR, "publish-error.json");
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const forecastIdentity = (o: MemoryForecast): string => JSON.stringify([o.generation, o.id, o.at]);
const forecastKey = (o: MemoryForecast): string => createHash("sha256").update(forecastIdentity(o)).digest("hex");
const validForecast = (o: MemoryForecast): boolean => o !== null && typeof o === "object" &&
  [o.at, o.projectedMib, o.initialMib].every(finite) && o.quantile >= 0.5 && o.quantile < 1 &&
  typeof o.id === "string" && o.id.length > 0 && typeof o.generation === "string" && o.generation.length > 0 &&
  ["serve-steady", "serve-stopped", "serve-cold-start", "unknown"].includes(o.scenario) &&
  [JOINT_MODEL, "legacy-one-tail-fallback", "unavailable"].includes(o.model) && o.basis === "cgroup-current-mib";

export function readCalibrationState(stateDir: string, io: Pick<CalibrationIo, "read"> = defaultIo): CalibrationState {
  const raw = JSON.parse(io.read(calibrationStatePath(stateDir))) as CalibrationState;
  if (raw?.version !== 1 || ![raw.startedAt, raw.coveredSince, raw.lastAt].every(finite) || typeof raw.generation !== "string" ||
      !Array.isArray(raw.observations) || !Array.isArray(raw.outcomes) || !Array.isArray(raw.issues)) throw new Error("invalid calibration state");
  if (raw.outcomes.length > OUTCOMES_MAX) throw new Error("calibration outcome backstop exceeded");
  if (raw.startedAt > raw.lastAt || raw.coveredSince > raw.lastAt) throw new Error("invalid calibration coverage clock");
  if (raw.observations.some(o => !o || !finite(o.at) || !(o.mib === null || finite(o.mib)) || !(o.peakMib == null || finite(o.peakMib)) || typeof o.generation !== "string") ||
      raw.outcomes.some(o => !validForecast(o) || !finite(o.closedAt) || o.closedAt < o.at + BACKTEST_WINDOW_MS || o.closedAt > raw.lastAt ||
        !(o.windowPeakUpperBoundMib === null || finite(o.windowPeakUpperBoundMib)) || typeof o.complete !== "boolean" ||
        !(o.upperBoundExceedsForecast === null || typeof o.upperBoundExceedsForecast === "boolean") || o.upperBoundExceedsForecast !== (o.windowPeakUpperBoundMib === null ? null : o.windowPeakUpperBoundMib > o.projectedMib)) ||
      raw.issues.some(i => !i || !finite(i.at) || typeof i.reason !== "string")) throw new Error("invalid calibration population");
  if (new Set(raw.outcomes.map(forecastIdentity)).size !== raw.outcomes.length) throw new Error("duplicate calibration outcomes");
  try {
    const fault = JSON.parse(io.read(publishErrorPath(stateDir)));
    if (!finite(fault.at)) throw new Error("invalid calibration publication failure");
    raw.issues.push({ at: fault.at, reason: "forecast publication failed" });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return raw;
}

function publishForecast(stateDir: string, forecast: MemoryForecast, io: CalibrationIo): void {
  if (!validForecast(forecast)) throw new Error("invalid forecast");
  let names: string[] = [];
  try { names = io.list(pendingDir(stateDir)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (names.length >= PENDING_MAX) throw new Error("calibration prediction backlog full");
  const key = forecastKey(forecast);
  try { io.publish(join(pendingDir(stateDir), key + ".json"), JSON.stringify(forecast)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (io.read(join(pendingDir(stateDir), key + ".json")) !== JSON.stringify(forecast)) throw new Error("forecast identity collision");
  }
}

export function publishMemoryForecast(stateDir: string, forecast: MemoryForecast, io: CalibrationIo = defaultIo): void {
  try { publishForecast(stateDir, forecast, io); }
  catch (error) {
    // A failed start receipt is not silently omitted from qualification. The ledger caller also records the error.
    try { io.write(publishErrorPath(stateDir), JSON.stringify({ at: forecast.at })); }
    catch { /* If the whole store is unavailable, its freshness/coverage guard must refuse. */ }
    throw error;
  }
}

/** One daemon heartbeat owns this collector; children only publish immutable forecast receipts. No new timer/lock. */
export function collectMemoryCalibration(stateDir: string, observation: MemoryObservation, io: CalibrationIo = defaultIo): ReturnType<typeof calibrationReport> {
  const now = observation.at;
  let state: CalibrationState;
  try { state = readCalibrationState(stateDir, io); }
  catch {
    // An absent, reset or corrupt store restarts coverage NOW; no earlier history is certified by the replacement.
    state = { version: 1, startedAt: now, coveredSince: now, lastAt: now, generation: observation.generation, observations: [], outcomes: [], issues: [] };
  }
  if (now < state.lastAt || now - state.lastAt > OBSERVATION_MAX_GAP_MS || state.generation !== observation.generation ||
      observation.mib === null || state.observations.at(-1)?.mib === null) state.coveredSince = now;
  state.generation = observation.generation; state.lastAt = now;
  state.observations = [...state.observations.filter(o => o.at >= now - BACKTEST_WINDOW_MS - 2 * OBSERVATION_MAX_GAP_MS), observation];
  state.outcomes = state.outcomes.filter(o => o.at >= now - CALIBRATION_DAY_MS);
  const consumed: string[] = [], known = new Set(state.outcomes.map(forecastIdentity));
  const issue = (reason: string) => { state.issues = [...state.issues.filter(i => i.reason !== reason && i.at >= now - CALIBRATION_DAY_MS), { at: now, reason }]; };
  let names: string[] = [];
  try { names = io.list(pendingDir(stateDir)); } catch (error) {
    // Only first-boot ENOENT is ordinary absence. Later loss or read failure is recorded as unqualified coverage.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || state.startedAt !== now) issue("pending store missing or unreadable");
  }
  if (names.length > PENDING_MAX) issue("pending backlog exceeded");
  for (const name of names.slice(0, PENDING_MAX)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) { issue("unknown pending entry"); continue; }
    const path = join(pendingDir(stateDir), name);
    try {
      const forecast = JSON.parse(io.read(path)) as MemoryForecast;
      if (!validForecast(forecast) || forecast.at > now || name !== forecastKey(forecast) + ".json") throw new Error("invalid forecast");
      const result = gradeMemoryForecast(forecast, state.observations, now);
      if (result) {
        const identity = forecastIdentity(forecast);
        if (!known.has(identity)) { state.outcomes.push(result); known.add(identity); }
        consumed.push(path);
      }
    } catch {
      // Keep the unreadable receipt and mark the whole qualification unknown, not an omitted successful start.
      issue("pending forecast unreadable");
    }
  }
  if (state.outcomes.length > OUTCOMES_MAX) { state.outcomes = state.outcomes.slice(-OUTCOMES_MAX); state.coveredSince = now; issue("outcome population truncated"); }
  state.issues = state.issues.filter(i => i.at >= now - CALIBRATION_DAY_MS);
  io.write(calibrationStatePath(stateDir), JSON.stringify(state));
  // Persist BEFORE consuming receipts: a crash replays/deduplicates, never erases an ungraded prediction.
  for (const path of consumed) try { io.remove(path); } catch { /* Already graded durably; the next pass deduplicates. */ }
  const report = calibrationReport(state, now);
  calibrationSink?.(stateDir, now, report);
  return report;
}

export function kernelMemoryObservation(at: number, read: (path: string) => string = path => readFileSync(path, "utf8")): MemoryObservation {
  try {
    const text = read("/sys/fs/cgroup/memory.current").trim();
    const peak = read("/sys/fs/cgroup/memory.peak").trim();
    const init = parseProcStat(read("/proc/1/stat"));
    if (!init) throw new Error("unknown cgroup generation");
    const generation = createHash("sha256").update(read("/proc/sys/kernel/random/boot_id") + read("/proc/self/cgroup") + init.start).digest("hex");
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || !/^\d+$/.test(peak) ||
        !Number.isSafeInteger(Number(peak)) || Number(peak) < Number(text)) throw new Error("invalid cgroup charge or high-water mark");
    return { at, mib: Number(text) / 1024 ** 2, peakMib: Number(peak) / 1024 ** 2, generation };
  } catch { return { at, mib: null, generation: "unreadable", reason: "kernel charge, high-water mark or generation unreadable" }; }
}
