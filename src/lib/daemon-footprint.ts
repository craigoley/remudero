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
import { join } from "node:path";

import { writeAtomic } from "./fs-race-safe.js";

export const DAEMON_FOOTPRINT_FILE = "daemon-footprint.json";
/** The window the budget reads (host-memory-shadow.ts's last hour). */
export const FOOTPRINT_RETAIN_MS = 60 * 60_000;
/** BACKSTOP on samples kept: a heartbeat a minute for an hour, twice over. */
export const FOOTPRINT_MAX_SAMPLES = 120;

/** One reading of the daemon main process: its rss plus its swap, and which process it was. */
export interface FootprintSample {
  at: number;
  bytes: number;
  pid: number;
}

export interface DaemonFootprintIo {
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
}

const realIo: DaemonFootprintIo = {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, content) => void writeAtomic(path, content, { tmpTag: "footprint-tmp" }),
};

export function daemonFootprintPath(stateDir: string): string {
  return join(stateDir, DAEMON_FOOTPRINT_FILE);
}

function isSample(value: unknown): value is FootprintSample {
  const s = value as Partial<FootprintSample> | null;
  return typeof s === "object" && s !== null && [s.at, s.bytes, s.pid].every((n) => typeof n === "number" && Number.isFinite(n));
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
  record(sample: FootprintSample): { persisted: true } | { persisted: false; reason: string };
  samples(): readonly FootprintSample[];
}

/** The daemon's store: loaded from `path` once (so a restart keeps the last hour), then held in memory. */
export function createDaemonFootprint(path: string, io: DaemonFootprintIo = realIo): DaemonFootprint {
  let held: FootprintSample[] = [];
  try {
    const loaded = parseDaemonFootprint(io.readFile(path));
    if (Array.isArray(loaded)) held = loaded;
  } catch (error) {
    void error; // No file yet (a first boot) or unreadable: start empty; the next record writes it.
  }
  return {
    path,
    record(sample) {
      held = [...held.filter((s) => sample.at - s.at <= FOOTPRINT_RETAIN_MS && s.at <= sample.at), sample]
        .slice(-FOOTPRINT_MAX_SAMPLES);
      try {
        io.writeFile(path, `${JSON.stringify({ samples: held })}\n`);
        return { persisted: true };
      } catch (error) {
        return { persisted: false, reason: errnoOrMessage(error) };
      }
    },
    samples: () => held,
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
): { samples: FootprintSample[]; source: "memory" | "file" } | { unread: string } {
  const path = daemonFootprintPath(stateDir);
  if (installed && installed.path === path) return { samples: [...installed.samples()], source: "memory" };
  let text: string;
  try {
    text = readFile(path);
  } catch (error) {
    // No file (the daemon has not sampled yet) or unreadable: the budget names it and reads the ledger tail instead.
    return { unread: errnoOrMessage(error) };
  }
  const parsed = parseDaemonFootprint(text);
  return Array.isArray(parsed) ? { samples: parsed, source: "file" } : parsed;
}
