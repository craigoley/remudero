import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

import { fixedClock, systemClock, type Clock } from "./clock.js";
import type { Escalation } from "./escalate.js";
import { slug as kebabSlug } from "./feedback-docket.js";
import { writeAtomic } from "./fs-race-safe.js";
import { runStepsEager, runStepsSyncOnly, type GardenCheckout, type GardenCheckoutAsync, type GardenWorkspacePort } from "./gardener.js";
import { runStepsAsync, step, type Steps } from "./git-push.js";
import { machineShardLandingRefusal, renderMachineShard } from "./machine-filing.js";
import { resolveRepoLayout } from "./repo-layout.js";

/**
 * lib/host-resource-gardener.ts (W1-T4804) — host disk, swap and inodes are seen BEFORE they run out.
 *
 * Every response so far came after a host filled (the Mac hit ENOSPC on 2026-09-24 and halted every
 * tool). The heartbeat (scripts/fleet-heartbeat.sh) now publishes swap, inodes, total size, the
 * janitor's latest result and the sizes of the known consumers. Each `heartbeat-<host>` branch is ONE
 * force-pushed commit, so it carries no history: this gardener keeps the history, one sample per new
 * beat, and reads a trend off it.
 *
 * PER HOST AND DEVICE it fits a Theil-Sen line (the median of pairwise slopes, so one outlier sample
 * cannot move it) over a window scaled to the series' own noise, and projects time-to-full. The
 * response is tiered against that host's OWN janitor cadence, never a fixed free-GB floor (a slowly
 * filling large disk would page early and a fast filling small one late): far beyond a few passes it
 * records only, inside a few passes it hands an incident to the SRE lane, and inside ONE pass — or
 * when the heartbeat went silent while the last samples were falling — it escalates, once per
 * episode. A fall is attributed to the consumer whose growth explains most of it; a consumer that
 * keeps growing across several janitor passes is filed once as a plan-only task.
 *
 * Time is read through the {@link Clock} port. Off switch: `state/HOST_RESOURCE_OFF`.
 */

export const HOST_RESOURCE = "host_resource";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Samples older than this age out (by time, never by count). */
export const SAMPLE_RETENTION_MS = 14 * DAY_MS;
/** The projection windows tried shortest first (hours), and the fewest points a fit may rest on. */
const WINDOWS_HOURS = [6, 12, 24, 48, 96, 168] as const;
const MIN_POINTS = 4;
const MAX_POINTS = 200;
/** A window is accepted once the fitted change across it stands this many noise-sigmas above the noise. */
const SIGNAL_SIGMAS = 3;
/** "Inside the next few janitor passes". */
export const NEAR_PASSES = 3;
/** The cadence assumed until two janitor passes have been seen, and its bounds (hours). */
const DEFAULT_CADENCE_H = 6;
const CADENCE_BOUNDS_H = [1, 48] as const;
/** A janitor pass that reclaimed less than this did nothing that matters (kb). */
const JANITOR_NOTHING_KB = 100 * 1024;
/** Attribution: the share of the fall a consumer must explain, its growth floor and the span it must keep growing over. */
const FILE_MIN_SHARE = 0.25;
const FILE_MIN_SPAN_H = 24;
const FILE_MIN_GROWTH_KB = 100 * 1024;
const FILE_MIN_JANITOR_PASSES = 2;
const ATTRIBUTION_MIN_WINDOW_H = 48;
const FILE_RETRY_MS = 6 * HOUR_MS;
const JUDGE_AFTER_MS = 7 * DAY_MS;
export const HOST_RESOURCE_MIN_INTERVAL_MS = 5 * 60_000;

export type Device = "root" | "state" | "swap" | "inodes";
export const DEVICES: readonly Device[] = ["root", "state", "swap", "inodes"];
export type Tier = "record" | "projected" | "escalate";

// ── samples ──────────────────────────────────────────────────────────────────────────────────

export interface HostSample {
  host: string;
  beatTs: string;
  tsMs: number;
  /** root_free_kb, root_total_kb, state_free_kb, swap_used_kb, swap_total_kb, inodes_free — only those read. */
  values: Record<string, number>;
  /** Consumer name → kb, only on the beats that measured them. */
  consumers: Record<string, number>;
  /** Published filesystem identities; absent in samples from older heartbeats. */
  devices?: Partial<Record<"root" | "state", string>>;
  consumerDevices?: Record<string, string>;
  janitorTs?: string;
  janitorFreedKb?: number;
  /** Per whole disk: busy %, await and tps averaged over the beat interval; only devices read. */
  io?: Record<string, IoReading>;
}

/** One block device over one beat interval, as the heartbeat published it. */
export interface IoReading {
  utilPct?: number;
  awaitMs?: number;
  tps?: number;
  /** What the disk backs: root, state, scratch, daemon (a daemon container's bind mount). */
  roles?: string[];
  /** The cgroups that read the most from this disk over the interval, most first. */
  readers?: IoReader[];
}

export interface IoReader {
  cgroup: string;
  readBytesPerS: number;
  readIops: number;
}

/** `key=value` lines of a published heartbeat. */
export function parseHeartbeatPayload(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  return out;
}

const digits = (v: string | undefined): number | undefined => (v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined);

/** `4MB`, `0GB`, `25GB` → kb; `57%` and anything else → undefined (never 0). */
export function parseSizeKb(v: string | undefined): number | undefined {
  const m = /^([0-9]+(?:\.[0-9]+)?)([KMGT]?)B$/.exec(v ?? "");
  if (!m) return undefined;
  const scale = { "": 1 / 1024, K: 1, M: 1024, G: 1024 ** 2, T: 1024 ** 3 }[m[2] as "" | "K" | "M" | "G" | "T"];
  return Math.round(Number(m[1]) * scale);
}

/** One heartbeat as a sample, or undefined when it carries no readable `beat_ts`. */
export function sampleFromPayload(host: string, payload: Record<string, string>): HostSample | undefined {
  const beatTs = payload["beat_ts"];
  const tsMs = beatTs === undefined ? NaN : Date.parse(beatTs);
  if (!Number.isFinite(tsMs)) return undefined;
  const values: Record<string, number> = {};
  const put = (key: string, v: number | undefined): void => {
    if (v !== undefined) values[key] = v;
  };
  put("root_free_kb", digits(payload["root_fs_free_kb"]));
  put("root_total_kb", digits(payload["root_fs_total_kb"]));
  // The state root is its own device only when it names a different one; else it double-reports root.
  const stateDevice = payload["state_fs_device"];
  if (stateDevice !== undefined && stateDevice !== "unknown" && stateDevice !== payload["root_fs_device"]) put("state_free_kb", digits(payload["state_fs_free_kb"]));
  put("swap_used_kb", digits(payload["swap_used_kb"]));
  put("swap_total_kb", digits(payload["swap_total_kb"]));
  put("inodes_free", digits(payload["root_fs_inodes_free"]));
  const consumers: Record<string, number> = {};
  const consumerDevices: Record<string, string> = {};
  for (const [key, raw] of Object.entries(payload)) {
    const m = /^consumer_(.+)_kb$/.exec(key);
    const kb = digits(raw);
    if (m && kb !== undefined) consumers[m[1]!] = kb;
    const deviceMatch = /^consumer_(.+)_device$/.exec(key);
    if (deviceMatch) consumerDevices[deviceMatch[1]!] = raw;
  }
  const janitorTs = payload["janitor_last_ts"];
  const freed = parseSizeKb(payload["janitor_last_freed"]);
  const io = ioFromPayload(payload);
  return {
    host,
    beatTs: fixedClock(tsMs).iso(),
    tsMs,
    values,
    consumers,
    devices: { root: payload["root_fs_device"], state: stateDevice },
    consumerDevices,
    ...(janitorTs && Number.isFinite(Date.parse(janitorTs)) ? { janitorTs } : {}),
    ...(freed !== undefined ? { janitorFreedKb: freed } : {}),
    ...(io ? { io } : {}),
  };
}

const decimal = (v: string | undefined): number | undefined => (v !== undefined && /^\d+(?:\.\d+)?$/.test(v) ? Number(v) : undefined);

/** The `io_<device>_*` keys of one beat; undefined when the beat measured no device. */
export function ioFromPayload(payload: Record<string, string>): Record<string, IoReading> | undefined {
  const devices = (payload["io_devices"] ?? "").split(",").filter((d) => /^[A-Za-z0-9._-]+$/.test(d));
  const out: Record<string, IoReading> = {};
  for (const device of devices) {
    const reading: IoReading = {};
    const utilPct = digits(payload[`io_${device}_util_pct`]);
    const awaitMs = decimal(payload[`io_${device}_await_ms`]);
    const tps = decimal(payload[`io_${device}_tps`]);
    if (utilPct !== undefined) reading.utilPct = Math.min(100, utilPct);
    if (awaitMs !== undefined) reading.awaitMs = awaitMs;
    if (tps !== undefined) reading.tps = tps;
    const roles = (payload[`io_${device}_roles`] ?? "").split(",").filter(Boolean);
    if (roles.length) reading.roles = roles;
    const readers = (payload[`io_${device}_readers`] ?? "").split(",").flatMap((entry) => {
      const [cgroup, bps, iops] = entry.split(":");
      const readBytesPerS = digits(bps);
      const readIops = decimal(iops);
      return cgroup && readBytesPerS !== undefined && readIops !== undefined ? [{ cgroup, readBytesPerS, readIops }] : [];
    });
    if (readers.length) reading.readers = readers;
    if (Object.keys(reading).length) out[device] = reading;
  }
  return Object.keys(out).length ? out : undefined;
}

export function samplesPath(stateDir: string): string {
  return join(stateDir, "host-resource-samples.ndjson");
}

export function readSamples(stateDir: string): HostSample[] {
  const path = samplesPath(stateDir);
  if (!existsSync(path)) return [];
  const out: HostSample[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line) as HostSample;
      if (typeof s.host === "string" && Number.isFinite(s.tsMs)) out.push(s);
    } catch (error) {
      // deliberate: a torn line (a crash mid-append) is dropped; every other sample still counts.
      void error;
    }
  }
  return out;
}

/** Append a sample only when its beat is NEWER than the host's latest stored one; age out old ones by time. */
export function appendNewSamples(stateDir: string, incoming: readonly HostSample[], nowMs: number): { appended: HostSample[]; all: HostSample[] } {
  const existing = readSamples(stateDir);
  const latest = new Map<string, number>();
  for (const s of existing) latest.set(s.host, Math.max(latest.get(s.host) ?? -Infinity, s.tsMs));
  const appended: HostSample[] = [];
  for (const s of [...incoming].sort((a, b) => a.tsMs - b.tsMs)) {
    if (s.tsMs <= (latest.get(s.host) ?? -Infinity)) continue;
    latest.set(s.host, s.tsMs);
    appended.push(s);
  }
  const cutoff = nowMs - SAMPLE_RETENTION_MS;
  const stale = existing.some((s) => s.tsMs < cutoff);
  const all = [...existing, ...appended].filter((s) => s.tsMs >= cutoff);
  const path = samplesPath(stateDir);
  if (stale) {
    writeAtomic(path, all.map((s) => JSON.stringify(s)).join("\n") + (all.length ? "\n" : ""));
  } else if (appended.length) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, appended.map((s) => JSON.stringify(s) + "\n").join(""));
  }
  return { appended, all };
}

// ── the projection ───────────────────────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Theil-Sen: the median of every pairwise slope, so a minority of outliers cannot move the line. */
export function theilSen(points: readonly Point[]): { slope: number; intercept: number } | undefined {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j]!.x - points[i]!.x;
      if (dx > 0) slopes.push((points[j]!.y - points[i]!.y) / dx);
    }
  }
  if (!slopes.length) return undefined;
  const slope = median(slopes);
  return { slope, intercept: median(points.map((p) => p.y - slope * p.x)) };
}

function thin<T>(xs: readonly T[], max: number): T[] {
  if (xs.length <= max) return [...xs];
  return Array.from({ length: max }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (max - 1))]!);
}

export interface Projection {
  /** Change of free space per hour; negative when falling. */
  slopePerHour: number;
  windowHours: number;
  spanHours: number;
  points: number;
  freeNow: number;
  /** Hours until free reaches 0; undefined unless the series is falling. */
  hoursToFull?: number;
}

/**
 * The robust slope of a free-space series over the SHORTEST trailing window whose fitted change stands
 * clear of that window's own noise (MAD of the residuals), else the longest window with enough points.
 * `points` are (epoch ms, free); the projection is anchored on the latest point.
 */
export function projectSeries(points: readonly Point[]): Projection | undefined {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const last = sorted[sorted.length - 1];
  if (!last) return undefined;
  let fallback: Projection | undefined;
  for (const windowHours of WINDOWS_HOURS) {
    const inWindow = thin(sorted.filter((p) => p.x >= last.x - windowHours * HOUR_MS), MAX_POINTS);
    if (inWindow.length < MIN_POINTS) continue;
    const x0 = inWindow[0]!.x;
    const local = inWindow.map((p) => ({ x: (p.x - x0) / HOUR_MS, y: p.y }));
    const fit = theilSen(local);
    if (!fit) continue;
    const spanHours = local[local.length - 1]!.x;
    const noise = 1.4826 * median(local.map((p) => Math.abs(p.y - (fit.intercept + fit.slope * p.x))));
    const projection: Projection = {
      slopePerHour: fit.slope,
      windowHours,
      spanHours,
      points: inWindow.length,
      freeNow: last.y,
      ...(fit.slope < 0 ? { hoursToFull: Math.max(0, last.y) / -fit.slope } : {}),
    };
    fallback = projection;
    if (spanHours > 0 && Math.abs(fit.slope) * spanHours >= SIGNAL_SIGMAS * noise) return projection;
  }
  return fallback;
}

/** The free-space reading of one device in one sample. */
export function freeOf(s: HostSample, device: Device): number | undefined {
  const v = s.values;
  switch (device) {
    case "root":
      return v["root_free_kb"];
    case "state":
      return v["state_free_kb"];
    case "inodes":
      return v["inodes_free"];
    case "swap": {
      const total = v["swap_total_kb"];
      const used = v["swap_used_kb"];
      return total !== undefined && used !== undefined && total > 0 && used <= total ? total - used : undefined;
    }
  }
}

/** The host's own janitor cadence in hours: the median gap between distinct janitor passes seen. */
export function janitorCadenceHours(samples: readonly HostSample[]): number {
  const passes = [...new Set(samples.map((s) => s.janitorTs).filter((t): t is string => t !== undefined).map((t) => Date.parse(t)))].sort((a, b) => a - b);
  if (passes.length < 3) return DEFAULT_CADENCE_H;
  const gaps = passes.slice(1).map((t, i) => (t - passes[i]!) / HOUR_MS);
  return Math.min(CADENCE_BOUNDS_H[1], Math.max(CADENCE_BOUNDS_H[0], median(gaps)));
}

/** The tier a projection earns against the host's janitor cadence; undefined when nothing is falling. */
export function tierFor(hoursToFull: number | undefined, cadenceHours: number): Tier | undefined {
  if (hoursToFull === undefined) return undefined;
  if (hoursToFull <= cadenceHours) return "escalate";
  if (hoursToFull <= NEAR_PASSES * cadenceHours) return "projected";
  return "record";
}

/** True when the heartbeat has been silent for well beyond its own observed cadence. */
export function heartbeatStale(samples: readonly HostSample[], nowMs: number): boolean {
  const ts = samples.map((s) => s.tsMs).sort((a, b) => a - b);
  const last = ts[ts.length - 1];
  if (last === undefined) return false;
  const recent = ts.slice(-20);
  const gaps = recent.slice(1).map((t, i) => (t - recent[i]!) / HOUR_MS);
  const cadence = gaps.length >= 2 ? median(gaps) : 0;
  return (nowMs - last) / HOUR_MS > Math.max(NEAR_PASSES * cadence, 0.5);
}

// ── attribution ──────────────────────────────────────────────────────────────────────────────

export interface Attribution {
  consumer: string;
  growthKbPerHour: number;
  /** growth ÷ the disk's fall — above 1 means the consumer grew faster than the disk fell (something else was freed). */
  share: number;
  spanHours: number;
  points: number;
  janitorPasses: number;
}

/** The consumer on this disk whose measured growth explains the most of its fall, or undefined. */
export function attributeGrowth(samples: readonly HostSample[], projection: Projection, device: "root" | "state"): Attribution | undefined {
  if (projection.slopePerHour >= 0 || !samples.length) return undefined;
  const latest = Math.max(...samples.map((s) => s.tsMs));
  const windowHours = Math.max(projection.windowHours, ATTRIBUTION_MIN_WINDOW_H);
  const inWindow = samples.filter((s) => s.tsMs >= latest - windowHours * HOUR_MS);
  const names = [...new Set(inWindow.flatMap((s) => Object.keys(s.consumers)))].sort();
  let best: Attribution | undefined;
  for (const consumer of names) {
    const pts = inWindow.filter((s) => {
      const disk = s.devices?.[device];
      return disk !== undefined && disk !== "unknown" && disk !== "" &&
        s.consumerDevices?.[consumer] === disk && s.consumers[consumer] !== undefined;
    }).map((s) => ({ x: s.tsMs / HOUR_MS, y: s.consumers[consumer]! }));
    if (pts.length < 3) continue;
    const fit = theilSen(thin(pts, MAX_POINTS));
    if (!fit || fit.slope <= 0) continue;
    if (!best || fit.slope > best.growthKbPerHour) {
      const passes = new Set(inWindow.map((s) => s.janitorTs).filter((t): t is string => t !== undefined)).size;
      best = { consumer, growthKbPerHour: fit.slope, share: fit.slope / -projection.slopePerHour, spanHours: pts[pts.length - 1]!.x - pts[0]!.x, points: pts.length, janitorPasses: passes };
    }
  }
  return best;
}

/** A consumer that keeps growing across janitor passes and explains a real share of the fall. */
export function isPersistentGrower(a: Attribution | undefined): a is Attribution {
  return (
    a !== undefined &&
    a.share >= FILE_MIN_SHARE &&
    a.spanHours >= FILE_MIN_SPAN_H &&
    a.points >= MIN_POINTS &&
    a.janitorPasses >= FILE_MIN_JANITOR_PASSES &&
    a.growthKbPerHour * a.spanHours >= FILE_MIN_GROWTH_KB
  );
}

// ── one host ─────────────────────────────────────────────────────────────────────────────────

export interface Finding {
  host: string;
  device: Device;
  projection: Projection;
  tier: Tier;
  cadenceHours: number;
  stale: boolean;
  /** The latest janitor pass reclaimed nothing while this device kept falling. */
  janitorIneffective: boolean;
  janitorFreedKb?: number;
  attribution?: Attribution;
}

/** Every device of one host whose free space is FALLING, with its tier; steady or rising series are silent. */
export function evaluateHost(host: string, allSamples: readonly HostSample[], nowMs: number): Finding[] {
  const samples = allSamples.filter((s) => s.host === host).sort((a, b) => a.tsMs - b.tsMs);
  const cadenceHours = janitorCadenceHours(samples);
  const stale = heartbeatStale(samples, nowMs);
  const lastJanitor = [...samples].reverse().find((s) => s.janitorFreedKb !== undefined);
  const out: Finding[] = [];
  for (const device of DEVICES) {
    const points = samples.flatMap((s) => {
      const y = freeOf(s, device);
      return y === undefined ? [] : [{ x: s.tsMs, y }];
    });
    const projection = projectSeries(points);
    if (!projection || projection.slopePerHour >= 0) continue;
    const base = tierFor(projection.hoursToFull, cadenceHours)!;
    const attribution = device === "root" || device === "state" ? attributeGrowth(samples, projection, device) : undefined;
    out.push({
      host,
      device,
      projection,
      tier: stale ? "escalate" : base,
      cadenceHours,
      stale,
      janitorIneffective: lastJanitor?.janitorFreedKb !== undefined && lastJanitor.janitorFreedKb < JANITOR_NOTHING_KB,
      ...(lastJanitor?.janitorFreedKb !== undefined ? { janitorFreedKb: lastJanitor.janitorFreedKb } : {}),
      ...(attribution ? { attribution } : {}),
    });
  }
  return out;
}

// ── block-device pressure ───────────────────────────────────────────────────────────────────

/**
 * The tiers a SUSTAINED busy fraction earns. Busy fraction ρ is the device's util over a beat. In
 * queueing terms a request waits about ρ/(1-ρ) times its own service time: at ρ 0.5 it waits as long
 * as it is served, at 0.75 three times as long, at 0.9 nine times. The tier rises with both how busy
 * the disk is and how long it stays that busy. A brief burst earns nothing, and a disk that is merely
 * busy for an hour is only recorded. The response backs off on its own: once the median falls, the
 * tier drops, and the episode ends when no window earns a tier.
 */
export const IO_TIERS: ReadonlyArray<{ tier: Tier; windowHours: number; busy: number }> = [
  { tier: "escalate", windowHours: 1, busy: 0.9 },
  { tier: "escalate", windowHours: 3, busy: 0.75 },
  { tier: "projected", windowHours: 1, busy: 0.75 },
  { tier: "projected", windowHours: 3, busy: 0.5 },
  { tier: "record", windowHours: 1, busy: 0.5 },
];
/** A window counts only when its samples cover most of it, so a sustained reading is never a burst. */
const IO_MIN_COVERAGE = 0.75;
const TIER_RANK: Record<Tier, number> = { record: 0, projected: 1, escalate: 2 };

export interface IoFinding {
  host: string;
  device: string;
  tier: Tier;
  /** The window that earned the tier, and the median busy fraction across it. */
  windowHours: number;
  busy: number;
  points: number;
  awaitMs?: number;
  tps?: number;
  roles: string[];
  /** Mean read rate per cgroup across the window, most first. */
  readers: IoReader[];
}

/** Every device of one host whose busy fraction stays high across a tier's window; idle or brief bursts are silent. */
export function evaluateIo(host: string, allSamples: readonly HostSample[], nowMs: number): IoFinding[] {
  const samples = allSamples.filter((s) => s.host === host).sort((a, b) => a.tsMs - b.tsMs);
  const last = samples[samples.length - 1];
  // A silent heartbeat is the disk-fill tiers' signal; stale pressure readings describe the past.
  if (!last || heartbeatStale(samples, nowMs)) return [];
  const devices = [...new Set(samples.flatMap((s) => Object.keys(s.io ?? {})))].sort();
  const out: IoFinding[] = [];
  for (const device of devices) {
    let best: IoFinding | undefined;
    for (const rule of IO_TIERS) {
      const from = last.tsMs - rule.windowHours * HOUR_MS;
      const inWindow = samples.filter((s) => s.tsMs > from && s.io?.[device]?.utilPct !== undefined);
      if (inWindow.length < MIN_POINTS) continue;
      const span = inWindow[inWindow.length - 1]!.tsMs - inWindow[0]!.tsMs;
      if (span < IO_MIN_COVERAGE * rule.windowHours * HOUR_MS) continue;
      const busy = median(inWindow.map((s) => s.io![device]!.utilPct! / 100));
      if (busy < rule.busy) continue;
      if (best && TIER_RANK[best.tier] >= TIER_RANK[rule.tier]) continue;
      const awaits = inWindow.flatMap((s) => (s.io![device]!.awaitMs === undefined ? [] : [s.io![device]!.awaitMs!]));
      const tps = inWindow.flatMap((s) => (s.io![device]!.tps === undefined ? [] : [s.io![device]!.tps!]));
      const sums = new Map<string, { bytes: number; iops: number }>();
      for (const s of inWindow) {
        for (const r of s.io![device]!.readers ?? []) {
          const acc = sums.get(r.cgroup) ?? { bytes: 0, iops: 0 };
          acc.bytes += r.readBytesPerS;
          acc.iops += r.readIops;
          sums.set(r.cgroup, acc);
        }
      }
      const readers = [...sums.entries()]
        .map(([cgroup, acc]) => ({ cgroup, readBytesPerS: acc.bytes / inWindow.length, readIops: acc.iops / inWindow.length }))
        .sort((a, b) => b.readBytesPerS - a.readBytesPerS || a.cgroup.localeCompare(b.cgroup))
        .slice(0, 5);
      best = {
        host,
        device,
        tier: rule.tier,
        windowHours: rule.windowHours,
        busy,
        points: inWindow.length,
        ...(awaits.length ? { awaitMs: median(awaits) } : {}),
        ...(tps.length ? { tps: median(tps) } : {}),
        roles: last.io?.[device]?.roles ?? [],
        readers,
      };
    }
    if (best) out.push(best);
  }
  return out;
}

/** `incident#<sha256 of host-io:<host>:<device>>`, distinct from the disk-fill incidents. */
export function ioIncidentOrigin(host: string, device: string): string {
  return `incident#${createHash("sha256").update(`host-io:${host}:${device}`).digest("hex")}`;
}

const fmtRate = (bytesPerS: number): string => (bytesPerS >= 1024 ** 2 ? `${(bytesPerS / 1024 ** 2).toFixed(1)} MB/s` : `${Math.round(bytesPerS / 1024)} KB/s`);

function ioEvidenceText(f: IoFinding): string {
  const roles = f.roles.length ? ` (backs ${f.roles.join(", ")})` : "";
  return [
    `Host ${f.host}, disk ${f.device}${roles}: busy ${Math.round(f.busy * 100)}% (median of ${f.points} beats across the last ${f.windowHours} h)` +
      `${f.awaitMs === undefined ? "" : `, await ${f.awaitMs.toFixed(0)} ms`}${f.tps === undefined ? "" : `, ${f.tps.toFixed(0)} tps`}.`,
    f.readers.length
      ? `Top readers: ${f.readers.map((r) => `${r.cgroup} ${fmtRate(r.readBytesPerS)} (${r.readIops.toFixed(0)} r/s)`).join("; ")}.`
      : "Top readers: none measured (cgroup io.stat unreadable on that host).",
  ].join("\n");
}

export function hostIoEscalation(f: IoFinding): Escalation {
  return {
    class: "BLOCKED",
    taskId: `host-io-${f.host}-${f.device}`,
    summary: `host ${f.host} disk ${f.device} has stayed saturated for ${f.windowHours} h`,
    detail: ioEvidenceText(f),
    options: [
      { label: "remove-io", detail: "move or stop the top reader's I/O on that disk (the disk itself is not upgraded)" },
      { label: "switch-off", detail: "touch state/HOST_RESOURCE_OFF to stop the gardener" },
    ],
    recommendation: "remove-io",
    headDedup: "independent",
  };
}

// ── the pass ─────────────────────────────────────────────────────────────────────────────────

export interface HeartbeatRead {
  host: string;
  payload: string;
}

export interface ConsumerFiling {
  host: string;
  device: Device;
  consumer: string;
  origin: string;
  attribution: Attribution;
}

export interface IncidentHandoff {
  /** A `FeedbackOrigin` of the `incident#<sha256>` shape (feedback.ts accepts no other). */
  origin: string;
  id: string;
  raw: string;
}

export interface HostResourcePorts {
  stateDir: string;
  clock?: Clock;
  log: (step: string, extra?: Record<string, unknown>) => void;
  /** The latest payload of every `heartbeat-*` branch. */
  readHeartbeats: () => HeartbeatRead[] | Promise<HeartbeatRead[]>;
  /** Hand an incident to the SRE lane's existing feedback path; absent, the tier only records. */
  handoff?: (h: IncidentHandoff) => void;
  /** The `incident#…` origins with open feedback, so an incident is never handed over twice. */
  openIncidentOrigins?: () => ReadonlySet<string>;
  escalate?: (e: Escalation) => string;
  /** Every `origin:` the plan already holds. */
  planOrigins: () => readonly string[];
  /** File a plan-only task for one persistent grower; returns the PR url. */
  fileConsumer?: (f: ConsumerFiling) => string | undefined | Promise<string | undefined>;
}

interface Episode {
  tier: Tier;
  handedOff?: string;
  escalatedAt?: string;
}

interface FiledRecord {
  at: string;
  url?: string;
  failedAt?: string;
  growthKbPerHourAtFiling?: number;
  judgedAt?: string;
}

interface GardenState {
  episodes: Record<string, Episode>;
  filed: Record<string, FiledRecord>;
  acrLogin: Record<string, { ts: string; result: "ok" | "failed"; escalatedAt?: string }>;
  stateBackup: Record<string, { ts: string; verdict: string; escalatedAt?: string }>;
}

export function hostResourceStatePath(stateDir: string): string {
  return join(stateDir, "host-resource-state.json");
}

export function hostResourceOffPath(stateDir: string): string {
  return join(stateDir, "HOST_RESOURCE_OFF");
}

function readState(stateDir: string): GardenState {
  const path = hostResourceStatePath(stateDir);
  if (!existsSync(path)) return { episodes: {}, filed: {}, acrLogin: {}, stateBackup: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<GardenState>;
    return { episodes: parsed.episodes ?? {}, filed: parsed.filed ?? {}, acrLogin: parsed.acrLogin ?? {}, stateBackup: parsed.stateBackup ?? {} };
  } catch (error) {
    // deliberate: an unreadable state file restarts every episode; the worst case is one repeat
    // handoff, which the open-feedback and plan-origin checks turn into a no-op.
    void error;
    return { episodes: {}, filed: {}, acrLogin: {}, stateBackup: {} };
  }
}

/** The origin a filed consumer task carries, and the one the gardener looks for in the plan. */
export function consumerOrigin(host: string, consumer: string): string {
  return `host-resource:${host}:${consumer}`;
}

/** `incident#<sha256 of host-resource:<host>:<device>>` — feedback.ts accepts only a hex fingerprint. */
export function incidentOrigin(host: string, device: Device): string {
  return `incident#${createHash("sha256").update(`host-resource:${host}:${device}`).digest("hex")}`;
}

const fmtHours = (h: number): string => (h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`);
const fmtKb = (kb: number): string => (Math.abs(kb) >= 1024 ** 2 ? `${(kb / 1024 ** 2).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`);
const unitOf = (device: Device): string => (device === "inodes" ? "inodes" : "kb");

function evidenceText(f: Finding): string {
  const p = f.projection;
  const free = f.device === "inodes" ? `${Math.round(p.freeNow)} inodes` : fmtKb(p.freeNow);
  const rate = f.device === "inodes" ? `${Math.round(-p.slopePerHour)} inodes/h` : `${fmtKb(-p.slopePerHour)}/h`;
  return [
    `Host ${f.host}, device ${f.device}: ${free} free, falling ${rate} (Theil-Sen over ${p.points} samples across ${fmtHours(p.spanHours)}); projected full in ${p.hoursToFull === undefined ? "never" : fmtHours(p.hoursToFull)}.`,
    `That host's janitor runs about every ${fmtHours(f.cadenceHours)}; the latest pass reclaimed ${f.janitorFreedKb === undefined ? "an unknown amount" : fmtKb(f.janitorFreedKb)}${f.janitorIneffective ? " — effectively nothing while the series kept falling" : ""}.`,
    ...(f.stale ? ["The host's heartbeat has gone silent while its samples were falling."] : []),
    ...(f.attribution ? [`Growth is attributed to ${f.attribution.consumer}: +${fmtKb(f.attribution.growthKbPerHour)}/h, ${(f.attribution.share * 100).toFixed(0)}% of the fall.`] : f.device === "root" || f.device === "state" ? [`unattributed: no measured consumer on ${f.device}`] : []),
  ].join("\n");
}

export function hostResourceEscalation(f: Finding): Escalation {
  return {
    class: "BLOCKED",
    taskId: `host-resource-${f.host}-${f.device}`,
    summary: `host ${f.host} ${f.device} is projected to fill ${f.stale ? "and its heartbeat has gone silent" : "inside one janitor pass"}`,
    detail: evidenceText(f),
    options: [
      { label: "free-space", detail: "free space on that host now (the attributed consumer first), then let the janitor cadence catch up" },
      { label: "switch-off", detail: "touch state/HOST_RESOURCE_OFF to stop the gardener" },
    ],
    recommendation: "free-space",
    headDedup: "independent",
  };
}

/** Render one persistent grower as a plan-only task record. */
export function consumerShardYaml(f: ConsumerFiling, taskId: string): string {
  const a = f.attribution;
  const file = "deploy/rmd-host-cleanup.sh";
  const rendered = renderMachineShard({
    taskId,
    title: `HOST ${f.host}: ${f.consumer} keeps growing (+${fmtKb(a.growthKbPerHour)}/h, ${(a.share * 100).toFixed(0)}% of the ${f.device} fall) across ${a.janitorPasses} janitor passes and no janitor rule reaps it`,
    origin: f.origin,
    files: [file],
    cost: (a.growthKbPerHour * 24) / 1024 ** 2,
    acceptance: [{ claim: `the janitor reaps ${f.consumer} on ${f.host}, so its growth rate stops being positive`, proof: `grep: ${f.consumer} in ${file}` }],
    note: `Filed by the host-resource gardener (W1-T4804). BEFORE: ${f.consumer} grew ${fmtKb(a.growthKbPerHour)}/h over ${fmtHours(a.spanHours)} (${a.points} samples) while the janitor ran ${a.janitorPasses} times. The gardener measures this consumer's growth rate again a week after filing and credits or debits the remedy by whether it stopped growing. MACHINE-AUTHORED — the machine-filing judge releases it or escalates it to a person.`,
  });
  if (rendered.refused) throw new Error(`host-resource gardener: drafted record refused by lint (${rendered.refused})`);
  return rendered.text;
}

/** File one persistent grower through a checkout: the shard alone, so the filing PR is plan-only. */
export function landConsumerShard(ws: GardenCheckout | GardenCheckoutAsync, mintTaskId: (branch?: string) => string, f: ConsumerFiling): string | undefined | Promise<string | undefined> {
  if (!ws.branch) throw new Error("host-resource gardener: filing workspace has no branch for task-id reservation");
  const taskId = mintTaskId(ws.branch);
  const contents = consumerShardYaml(f, taskId);
  const shardDir = join(resolveRepoLayout(ws.root).planDir, "tasks.d");
  const shardPath = join(shardDir, `${taskId}-${kebabSlug(`host-resource-${f.host}-${f.consumer}`, 72).replace(/-+$/, "")}.yaml`);
  mkdirSync(shardDir, { recursive: true });
  writeFileSync(shardPath, contents);
  const relPath = relative(ws.root, shardPath);
  const refused = machineShardLandingRefusal(ws.root, [relPath]);
  if (refused !== undefined) throw new Error(`host-resource gardener: drafted record failed lint-plan's machine-filing admission (${refused})`);
  const body = [
    "The host-resource gardener (W1-T4804) attributes a falling host disk to the consumer whose growth explains it.",
    "",
    `- **${f.consumer}** on \`${f.host}\` grows ${fmtKb(f.attribution.growthKbPerHour)}/h and no janitor rule reaps it.`,
    "",
    "## Acceptance",
    "- claim: the persistent grower is filed once as a parked task",
    `  proof: grep: ${f.origin} in ${relPath}`,
  ].join("\n");
  return ws.land({ paths: [relPath], title: `chore(plan): host ${f.host} ${f.consumer} keeps growing and no janitor rule reaps it`, body });
}

/** The production filer: a fresh checkout per filing, always disposed, the shard landed through it —
 *  synchronously over the CLI's port, awaited over the daemon's (W1-T5740). */
export function fileConsumerVia(openWorkspace: GardenWorkspacePort, mintTaskId: (branch?: string) => string): (f: ConsumerFiling) => string | undefined | Promise<string | undefined> {
  return (f) => runStepsEager(consumerFilingSteps(openWorkspace, mintTaskId, f));
}

function* consumerFilingSteps(openWorkspace: GardenWorkspacePort, mintTaskId: (branch?: string) => string, f: ConsumerFiling): Steps<string | undefined> {
  const ws = yield* step<GardenCheckout | GardenCheckoutAsync>(openWorkspace);
  try {
    return yield* step(() => landConsumerShard(ws, mintTaskId, f));
  } finally {
    yield* step(() => ws.dispose());
  }
}

export interface PassResult {
  ran: boolean;
  appended: number;
  findings: Finding[];
}

/** One pass: sample new beats, evaluate every host, act once per episode. */
export function runHostResourcePass(ports: HostResourcePorts): PassResult {
  return runStepsSyncOnly(hostResourcePassSteps(ports));
}

/** {@link runHostResourcePass} with heartbeat reads and filing awaited, for the daemon's async ports. */
export function runHostResourcePassAsync(ports: HostResourcePorts): Promise<PassResult> {
  return runStepsAsync(hostResourcePassSteps(ports));
}

function* hostResourcePassSteps(ports: HostResourcePorts): Steps<PassResult> {
  const clock = ports.clock ?? systemClock;
  if (existsSync(hostResourceOffPath(ports.stateDir))) return { ran: false, appended: 0, findings: [] };
  const nowMs = clock.now();
  const incoming: HostSample[] = [];
  const state = readState(ports.stateDir);
  const beats = yield* step(() => ports.readHeartbeats());
  for (const beat of beats) {
    const payload = parseHeartbeatPayload(beat.payload);
    const result = payload["acr_login_result"];
    const ts = payload["acr_login_ts"];
    const episode = state.acrLogin[beat.host];
    const refreshMs = Date.parse(ts ?? "");
    const previousMs = Date.parse(episode?.ts ?? "");
    const currentRefresh = !episode || refreshMs > previousMs || (refreshMs === previousMs && (result === "ok" || episode.result === result));
    if ((result === "failed" || result === "ok") && ts && Number.isFinite(refreshMs) && currentRefresh) {
      if (result === "ok") {
        if (episode?.escalatedAt) ports.log(`${HOST_RESOURCE}.acr_login_recovered`, { host: beat.host, ts });
        state.acrLogin[beat.host] = { ts, result };
      } else {
        const current = (state.acrLogin[beat.host] ??= { ts, result });
        current.ts = ts;
        current.result = result;
        if (!current.escalatedAt && ports.escalate) {
          const reason = payload["acr_login_reason"] || "registry refresh failed without a reason";
          const command = `az login && az acr login -n ${payload["acr_login_registry"] || "synthwatcholey0620"}`;
          const issueUrl = ports.escalate({
            class: "MANUAL",
            taskId: `host-acr-login-${beat.host}`,
            summary: `host ${beat.host} cannot refresh its registry login; baked deploys are blocked`,
            detail: `Host ${beat.host}, registry refresh ${ts}: ${reason}.\nRun on that host: ${command}`,
            options: [{ label: "az-login", detail: `authenticate on ${beat.host}: ${command}`, kind: { type: "operator-only" } }],
            recommendation: "az-login",
            headDedup: "independent",
          });
          current.escalatedAt = clock.iso();
          ports.log(`${HOST_RESOURCE}.acr_login_failed`, { host: beat.host, ts, reason, issue_url: issueUrl });
        }
      }
    }
    const backupVerdict = payload["backup_verdict"];
    const backupTs = payload["backup_ts"];
    const backupEpisode = state.stateBackup[beat.host];
    const backupMs = Date.parse(backupTs ?? "");
    if (backupTs && Number.isFinite(backupMs) && (!backupEpisode || backupMs >= Date.parse(backupEpisode.ts))) {
      if (backupVerdict === "ok") {
        if (backupEpisode?.escalatedAt) ports.log(`${HOST_RESOURCE}.state_backup_recovered`, { host: beat.host, ts: backupTs });
        state.stateBackup[beat.host] = { ts: backupTs, verdict: backupVerdict };
      } else if (backupVerdict?.startsWith("FAILED") || backupVerdict?.startsWith("STALE")) {
        const current = (state.stateBackup[beat.host] ??= { ts: backupTs, verdict: backupVerdict });
        current.ts = backupTs;
        current.verdict = backupVerdict;
        if (!current.escalatedAt && ports.escalate) {
          const issueUrl = ports.escalate({
            class: "MANUAL",
            taskId: `host-state-backup-${beat.host}`,
            summary: `host ${beat.host} has a failed or missing nightly state backup`,
            detail: `Host ${beat.host}, nightly snapshot ${backupTs}: ${backupVerdict}.\nOff-host: ${payload["backup_offhost"] || "unknown"}.\nInspect ~/reclaim.log and the snapshot receipt, repair the snapshot or Azure login failure, then rerun host-update.sh --reclaim-only.`,
            options: [{ label: "repair-backup", detail: `restore and verify the nightly state backup on ${beat.host}`, kind: { type: "operator-only" } }],
            recommendation: "repair-backup",
            headDedup: "independent",
          });
          current.escalatedAt = clock.iso();
          ports.log(`${HOST_RESOURCE}.state_backup_failed`, { host: beat.host, ts: backupTs, verdict: backupVerdict, offhost: payload["backup_offhost"], issue_url: issueUrl });
        }
      }
    }
    const sample = sampleFromPayload(beat.host, payload);
    if (sample) incoming.push(sample);
  }
  const { appended, all } = appendNewSamples(ports.stateDir, incoming, nowMs);
  if (appended.length) ports.log(`${HOST_RESOURCE}.sampled`, { appended: appended.length, hosts: [...new Set(appended.map((s) => s.host))].sort() });

  const findings = [...new Set(all.map((s) => s.host))].sort().flatMap((host) => evaluateHost(host, all, nowMs));
  const live = new Set<string>();
  for (const f of findings) {
    const key = `${f.host}:${f.device}`;
    live.add(key);
    const episode = (state.episodes[key] ??= { tier: f.tier });
    episode.tier = f.tier;
    const p = f.projection;
    const row = { host: f.host, device: f.device, tier: f.tier, hours_to_full: p.hoursToFull === undefined ? null : Math.round(p.hoursToFull * 10) / 10, slope_per_hour: Math.round(p.slopePerHour), unit: unitOf(f.device), cadence_hours: Math.round(f.cadenceHours * 10) / 10, stale: f.stale, attributed: f.attribution?.consumer ?? (f.device === "root" || f.device === "state" ? `unattributed: no measured consumer on ${f.device}` : null) };
    if (f.tier !== "record" && !episode.handedOff && ports.handoff) {
      const origin = incidentOrigin(f.host, f.device);
      if (!(ports.openIncidentOrigins?.() ?? new Set<string>()).has(origin)) {
        ports.handoff({ origin, id: `host-resource-${origin.slice("incident#".length, "incident#".length + 16)}`, raw: `host-resource:${f.host}:${f.device}\n\n${evidenceText(f)}` });
      }
      episode.handedOff = clock.iso();
      ports.log(`${HOST_RESOURCE}.projected`, row);
    }
    if (f.tier === "escalate" && !episode.escalatedAt && ports.escalate) {
      const issueUrl = ports.escalate(hostResourceEscalation(f));
      episode.escalatedAt = clock.iso();
      ports.log(`${HOST_RESOURCE}.escalated`, { ...row, issue_url: issueUrl });
    }
    const janitorKey = `${key}:janitor`;
    if (f.janitorIneffective) {
      live.add(janitorKey);
      if (!state.episodes[janitorKey]) {
        state.episodes[janitorKey] = { tier: "record" };
        ports.log(`${HOST_RESOURCE}.janitor_ineffective`, { ...row, janitor_freed_kb: f.janitorFreedKb ?? null });
      }
    }
    const a = f.attribution;
    if (isPersistentGrower(a) && ports.fileConsumer) {
      const origin = consumerOrigin(f.host, a.consumer);
      const rec = state.filed[origin];
      const failedAtMs = rec?.failedAt === undefined ? undefined : Date.parse(rec.failedAt);
      const retryOk = failedAtMs === undefined || nowMs - failedAtMs >= FILE_RETRY_MS;
      const alreadyFiled = rec !== undefined && rec.url !== undefined;
      if (!ports.planOrigins().includes(origin) && !alreadyFiled && retryOk) {
        try {
          const fileConsumer = ports.fileConsumer;
          const url = yield* step(() => fileConsumer({ host: f.host, device: f.device, consumer: a.consumer, origin, attribution: a }));
          if (url !== undefined) {
            state.filed[origin] = { at: clock.iso(), url, growthKbPerHourAtFiling: a.growthKbPerHour };
            ports.log(`${HOST_RESOURCE}.filed`, { ...row, consumer: a.consumer, growth_kb_per_hour: Math.round(a.growthKbPerHour), share: Math.round(a.share * 100) / 100, pr_url: url });
          }
        } catch (error) {
          state.filed[origin] = { at: rec?.at ?? clock.iso(), failedAt: clock.iso() };
          ports.log(`${HOST_RESOURCE}.file_failed`, { host: f.host, consumer: a.consumer, error: String((error as Error)?.message ?? error) });
        }
      }
    }
  }
  for (const f of [...new Set(all.map((s) => s.host))].sort().flatMap((host) => evaluateIo(host, all, nowMs))) {
    const key = `${f.host}:io:${f.device}`;
    live.add(key);
    const prior = state.episodes[key];
    const episode = (state.episodes[key] ??= { tier: f.tier });
    const row = { host: f.host, device: f.device, tier: f.tier, busy_pct: Math.round(f.busy * 100), window_hours: f.windowHours, await_ms: f.awaitMs === undefined ? null : Math.round(f.awaitMs), roles: f.roles, top_readers: f.readers.map((r) => r.cgroup) };
    if (!prior || prior.tier !== f.tier) ports.log(`${HOST_RESOURCE}.io_pressure`, row);
    episode.tier = f.tier;
    if (f.tier !== "record" && !episode.handedOff && ports.handoff) {
      const origin = ioIncidentOrigin(f.host, f.device);
      if (!(ports.openIncidentOrigins?.() ?? new Set<string>()).has(origin)) {
        ports.handoff({ origin, id: `host-io-${origin.slice("incident#".length, "incident#".length + 16)}`, raw: `host-io:${f.host}:${f.device}\n\n${ioEvidenceText(f)}` });
      }
      episode.handedOff = clock.iso();
    }
    if (f.tier === "escalate" && !episode.escalatedAt && ports.escalate) {
      const issueUrl = ports.escalate(hostIoEscalation(f));
      episode.escalatedAt = clock.iso();
      ports.log(`${HOST_RESOURCE}.io_escalated`, { ...row, issue_url: issueUrl });
    }
  }
  for (const key of Object.keys(state.episodes)) {
    const episode = state.episodes[key]!;
    const isJanitor = key.endsWith(":janitor");
    const isIo = key.includes(":io:");
    if (live.has(key) && (isJanitor || isIo || episode.tier !== "record")) continue;
    if (isIo) {
      ports.log(`${HOST_RESOURCE}.io_recovered`, { key });
      delete state.episodes[key];
      continue;
    }
    if (!isJanitor && (episode.handedOff || episode.escalatedAt)) ports.log(`${HOST_RESOURCE}.recovered`, { key });
    delete state.episodes[key];
  }
  judgeFiled(state, all, nowMs, ports);
  writeAtomic(hostResourceStatePath(ports.stateDir), JSON.stringify(state, null, 2) + "\n");
  if (appended.length) ports.log(`${HOST_RESOURCE}.pass`, { hosts: new Set(all.map((s) => s.host)).size, falling: findings.length, escalated: findings.filter((f) => f.tier === "escalate").length });
  return { ran: true, appended: appended.length, findings };
}

/** A week after filing, measure the consumer's growth again: the filed task is judged by that rate. */
function judgeFiled(state: GardenState, all: readonly HostSample[], nowMs: number, ports: HostResourcePorts): void {
  for (const [origin, rec] of Object.entries(state.filed)) {
    if (!rec.url || rec.judgedAt || rec.growthKbPerHourAtFiling === undefined || nowMs - Date.parse(rec.at) < JUDGE_AFTER_MS) continue;
    const [, host, consumer] = origin.split(":");
    const since = Date.parse(rec.at);
    const pts = all.filter((s) => s.host === host && s.tsMs >= since && s.consumers[consumer!] !== undefined).map((s) => ({ x: s.tsMs / HOUR_MS, y: s.consumers[consumer!]! }));
    const fit = pts.length >= 3 ? theilSen(thin(pts, MAX_POINTS)) : undefined;
    if (!fit) continue;
    const before = rec.growthKbPerHourAtFiling;
    const verdict = fit.slope <= 0 ? "stopped" : fit.slope < before / 2 ? "slowed" : "unchanged";
    rec.judgedAt = fixedClock(nowMs).iso();
    ports.log(`${HOST_RESOURCE}.consumer_judged`, { origin, growth_before_kb_per_hour: Math.round(before), growth_after_kb_per_hour: Math.round(fit.slope), verdict });
  }
}

/** The host-resource gardener on its own timer: never faster than {@link HOST_RESOURCE_MIN_INTERVAL_MS}. */
export function startHostResourceGardener(ports: HostResourcePorts, intervalMs: number): { stop: () => void } {
  const clock = ports.clock ?? systemClock;
  let running = false;
  let lastRunMs = -Infinity;
  function* guardedPass(): Steps<void> {
    try {
      yield* hostResourcePassSteps(ports);
    } catch (error) {
      ports.log(`${HOST_RESOURCE}.failed`, { error: String((error as Error)?.message ?? error), reason: "a pass that throws is logged and the next tick tries again" });
    } finally {
      running = false;
    }
  }
  const tick = (): void => {
    if (running || clock.now() - lastRunMs < HOST_RESOURCE_MIN_INTERVAL_MS) return;
    running = true;
    lastRunMs = clock.now();
    // Sync fixture ports still finish eagerly; async reads/filings hold the same guard to closure.
    void runStepsEager(guardedPass());
  };
  tick();
  const timer = setInterval(tick, Math.max(1_000, Math.min(intervalMs, HOST_RESOURCE_MIN_INTERVAL_MS)));
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/** Production heartbeat source: one `git fetch` of every `heartbeat-*` head, then each payload off its ref. */
export function gitHeartbeatSource(repoRoot: string): () => Promise<HeartbeatRead[]> {
  const execute = promisify(execFile);
  const git = (args: string[]) => execute("git", ["-C", repoRoot, ...args], { encoding: "utf8", timeout: 60_000 });
  return async () => {
    try {
      await git(["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/heartbeat-*:refs/remotes/origin/heartbeat-*"]);
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr;
      throw new Error(`fetching heartbeat branches failed: ${(stderr || String(error)).trim().slice(0, 200)}`, { cause: error });
    }
    const refs = (await git(["for-each-ref", "--format=%(refname)", "refs/remotes/origin/heartbeat-*"])).stdout.split("\n").filter(Boolean);
    const out: HeartbeatRead[] = [];
    for (const ref of refs) {
      try {
        const shown = await git(["show", `${ref}:heartbeat.txt`]);
        out.push({ host: ref.slice("refs/remotes/origin/heartbeat-".length), payload: shown.stdout });
      } catch (error) {
        const native = error as { code?: number | string; stderr?: string };
        // A branch without a published payload is absent. Corrupt refs, transport/spawn failures
        // and unreadable objects are NOT an empty heartbeat population: retain their native error.
        if (native.code === 128 && /^fatal: path 'heartbeat\.txt' does not exist in '/m.test(native.stderr ?? "")) {
          // Git can emit the SAME missing-path text for a dangling ref. Prove its tree is valid
          // before accepting an absent payload; cat-file's native refusal reaches the caller.
          await git(["cat-file", "-e", `${ref}^{tree}`]);
          continue;
        }
        throw error;
      }
    }
    return out;
  };
}
