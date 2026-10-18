/**
 * lib/daemon-footprint.ts — the daemon's own rolling rss+swap samples, kept in memory and persisted in its state
 * directory so they survive a restart.
 *
 * OBSERVED 2026-10-11 13:07-14:35Z on the core instance: the memory budget split the daemon's growth at the median of
 * its samples on only 6 of 274 shadow verdicts. Every other row read "all typical: 1-4 daemon sample row(s)". The
 * samples were read back from the LIVE ledger's tail, which rotates every 35-60 min, filtered to the daemon's current
 * pid, which changes on a restart about hourly, while `daemon.alive` rows came only every 3-10 min. The six the split
 * needs were rarely there. The same heartbeats, kept here across rotations and restarts, number at least 8 in the hour
 * before every one of those 274 verdicts.
 *
 * The daemon records one sample on each memory reading its heartbeat already takes (`daemon.alive`, or `daemon.tick`
 * while idle): no new timer. The budget reads the samples here (host-memory-shadow.ts): in-process from memory, and
 * from the persisted file in any other process of the instance (a review or garden child). Samples older than
 * {@link FOOTPRINT_RETAIN_MS} are dropped on each write.
 *
 * NEVER IN THE PATH. A failed load starts empty; a failed persist keeps the samples in memory and is reported to the
 * caller, which only logs it. A reader that cannot parse the file says so; it never reads an empty series as flat.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeAtomic } from "./fs-race-safe.js";
import { systemClock } from "./clock.js";
import { collectMemoryCalibration, kernelMemoryObservation } from "./host-memory-calibration.js";

export const DAEMON_FOOTPRINT_FILE = "daemon-footprint.json";
/** The window the budget reads (host-memory-shadow.ts's last hour). */
export const FOOTPRINT_RETAIN_MS = 60 * 60_000;
/** W1-T9982: how long a generation's boot-growth entry is kept: the window the heap-ceiling learning uses
 *  (daemon-memory-policy.ts's HEAP_SAMPLE_RETAIN_MS, which imports this module, so a test pins the two equal). */
export const BOOT_GROWTH_RETAIN_MS = 7 * 24 * 60 * 60_000;
/** BACKSTOP on samples kept: a heartbeat a minute for an hour, twice over. */
export const FOOTPRINT_MAX_SAMPLES = 120;

/** One reading of the daemon main process: its rss plus its swap, and which process it was. */
export interface FootprintSample {
  at: number;
  bytes: number;
  pid: number;
  /** W1-T9982: the daemon generation's start (ms since epoch). Every container generation is pid 123, so the pid cannot
   *  tell boots apart. Absent on a sample written before this field: an unknown generation. */
  boot?: number;
}

/** W1-T9982: what one daemon generation's footprint did: where it began, its peak, and how long after boot it peaked.
 *  Kept for the window the heap-ceiling learning already uses ({@link BOOT_GROWTH_RETAIN_MS}). */
export interface BootGrowth {
  boot: number;
  first_bytes: number;
  peak_bytes: number;
  peak_uptime_ms: number;
}

export interface DaemonFootprintIo {
  observeCalibration?: (stateDir: string, at: number) => void;
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
}

const realIo: DaemonFootprintIo = {
  observeCalibration: (stateDir, at) => { collectMemoryCalibration(stateDir, kernelMemoryObservation(at)); },
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, content) => void writeAtomic(path, content, { tmpTag: "footprint-tmp" }),
};

export function daemonFootprintPath(stateDir: string): string {
  return join(stateDir, DAEMON_FOOTPRINT_FILE);
}

function isSample(value: unknown): value is FootprintSample {
  const s = value as Partial<FootprintSample> | null;
  return typeof s === "object" && s !== null && [s.at, s.bytes, s.pid].every((n) => typeof n === "number" && Number.isFinite(n)) &&
    (s.boot === undefined || (typeof s.boot === "number" && Number.isFinite(s.boot)));
}

function isBootGrowth(value: unknown): value is BootGrowth {
  const b = value as Partial<BootGrowth> | null;
  return typeof b === "object" && b !== null &&
    [b.boot, b.first_bytes, b.peak_bytes, b.peak_uptime_ms].every((n) => typeof n === "number" && Number.isFinite(n));
}

/** The persisted boot-growth entries, oldest boot first. A file from before them holds none; a foreign shape is named. */
export function parseBootGrowth(text: string): BootGrowth[] | { unread: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    void error; // A torn or foreign file: named, never read as "no earlier boot".
    return { unread: "unparseable" };
  }
  const boots = (parsed as { boots?: unknown } | null)?.boots;
  if (boots === undefined) return [];
  if (!Array.isArray(boots)) return { unread: "boots is not an array" };
  return boots.filter(isBootGrowth).sort((a, b) => a.boot - b.boot);
}

/** `boots` with `sample` folded in: its generation's first reading, and its peak and when (uptime) it peaked. Entries
 *  older than the heap-ceiling learning's window are dropped, the sample's own generation never. */
export function noteBootGrowth(boots: readonly BootGrowth[], sample: FootprintSample): BootGrowth[] {
  const boot = sample.boot;
  const kept = boots.filter((b) => b.boot === boot || sample.at - b.boot <= BOOT_GROWTH_RETAIN_MS);
  if (boot === undefined) return kept;
  const own = kept.find((b) => b.boot === boot);
  if (!own) return [...kept, { boot, first_bytes: sample.bytes, peak_bytes: sample.bytes, peak_uptime_ms: Math.max(0, sample.at - boot) }];
  return sample.bytes > own.peak_bytes
    ? kept.map((b) => (b === own ? { ...b, peak_bytes: sample.bytes, peak_uptime_ms: Math.max(0, sample.at - boot) } : b))
    : kept;
}

/** The persisted samples, oldest first, or why they cannot be shown. */
export function parseDaemonFootprint(text: string): FootprintSample[] | { unread: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    void error; // A torn or foreign file: named, never read as an empty series.
    return { unread: "unparseable" };
  }
  const samples = (parsed as { samples?: unknown } | null)?.samples;
  if (!Array.isArray(samples)) return { unread: "no samples array" };
  return samples.filter(isSample).sort((a, b) => a.at - b.at);
}

function errnoOrMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : String((error as Error)?.message ?? error).slice(0, 120);
}

export interface DaemonFootprint {
  readonly path: string;
  /** Add one sample, drop the expired ones, persist. Returns the persist error, if any; the sample is kept either way. */
  record(sample: FootprintSample): { persisted: true; reason?: string } | { persisted: false; reason: string };
  samples(): readonly FootprintSample[];
  /** W1-T9982: one entry per daemon generation, this one included once it has a sample. */
  boots(): readonly BootGrowth[];
}

/** The daemon's store: loaded from `path` once (so a restart keeps the last hour), then held in memory. `boot` is this
 *  generation's start (default: now, as the store is made at daemon boot), stamped on every sample recorded without one. */
export function createDaemonFootprint(
  path: string, io: DaemonFootprintIo = realIo, opts: { boot?: number } = {},
): DaemonFootprint {
  const boot = opts.boot ?? systemClock.now();
  let held: FootprintSample[] = [];
  let bootsHeld: BootGrowth[] = [];
  try {
    const text = io.readFile(path);
    const loaded = parseDaemonFootprint(text);
    if (Array.isArray(loaded)) held = loaded;
    const loadedBoots = parseBootGrowth(text);
    if (Array.isArray(loadedBoots)) bootsHeld = loadedBoots;
  } catch (error) {
    void error; // No file yet (a first boot) or unreadable: start empty; the next record writes it.
  }
  return {
    path,
    record(given) {
      const sample: FootprintSample = given.boot === undefined ? { ...given, boot } : given;
      held = [...held.filter((s) => sample.at - s.at <= FOOTPRINT_RETAIN_MS && s.at <= sample.at), sample]
        .slice(-FOOTPRINT_MAX_SAMPLES);
      bootsHeld = noteBootGrowth(bootsHeld, sample);
      try {
        io.writeFile(path, `${JSON.stringify({ samples: held, boots: bootsHeld })}\n`);
      } catch (error) {
        return { persisted: false, reason: errnoOrMessage(error) };
      }
      try { io.observeCalibration?.(dirname(path), sample.at); }
      catch (error) { return { persisted: true, reason: `calibration:${errnoOrMessage(error)}` }; }
      return { persisted: true };
    },
    samples: () => held,
    boots: () => bootsHeld,
  };
}

let installed: DaemonFootprint | undefined;

/** The daemon installs its store once, so a verdict taken in the daemon's own process reads it from memory. */
export function installDaemonFootprint(store: DaemonFootprint | undefined): void {
  installed = store;
}

/** The instance's daemon samples: from memory when this process holds the store for `stateDir`, else from its file. */
export function readDaemonFootprint(
  stateDir: string,
  readFile: (path: string) => string = realIo.readFile,
): { samples: FootprintSample[]; boots: BootGrowth[]; source: "memory" | "file" } | { unread: string } {
  const path = daemonFootprintPath(stateDir);
  if (installed && installed.path === path) return { samples: [...installed.samples()], boots: [...installed.boots()], source: "memory" };
  let text: string;
  try {
    text = readFile(path);
  } catch (error) {
    // No file (the daemon has not sampled yet) or unreadable: the budget names it and reads the ledger tail instead.
    return { unread: errnoOrMessage(error) };
  }
  const parsed = parseDaemonFootprint(text);
  if (!Array.isArray(parsed)) return parsed;
  const boots = parseBootGrowth(text);
  return Array.isArray(boots) ? { samples: parsed, boots, source: "file" } : boots;
}
