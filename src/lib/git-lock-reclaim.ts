/**
 * Stale git maintenance leftovers, found and removed before a fetch (incident 2026-10-06).
 *
 * A `git gc` killed mid-run (a container recycle on 2026-09-29) left `objects/maintenance.lock`,
 * `gc.pid`, `gc.log.lock` and a ref `.lock` in serve's gateway repo. Every later fetch's
 * `git maintenance run --auto` found the lock and silently did nothing for a week, while small
 * fetches unpacked as loose objects: 40,208 of them, 1.54 GiB, on the root disk. `gc.log` strands a
 * store the same way, because git refuses automatic gc while it exists.
 *
 * A leftover is removed only when BOTH hold:
 *   - it is older than {@link STALE_GIT_LOCK_AGE_MS}, so a lock a live fetch or gc just took is
 *     never touched;
 *   - no git gc/maintenance/repack/prune process is alive on this host, and `gc.pid`, when present,
 *     names another host or a pid that is not a live git process.
 * When the process list cannot be read, nothing is removed: "could not look" is not "nobody is there".
 *
 * Everything here is async (fs/promises and execFile with a timeout): serve's loop never waits on it.
 */
import { execFile } from "node:child_process";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join, relative } from "node:path";

/** A maintenance leftover younger than this is presumed to belong to a live git command. A gc on
 *  serve's repo takes seconds to minutes; the stranding leftovers were a week old. */
export const STALE_GIT_LOCK_AGE_MS = 60 * 60_000;
/** BACKSTOP on the process listing. */
export const PROCESS_LIST_TIMEOUT_MS = 10_000;

/** Files under the common git dir whose presence blocks automatic maintenance or a later git command. */
export const GIT_MAINTENANCE_LEFTOVERS = ["objects/maintenance.lock", "gc.pid", "gc.log.lock", "gc.log", "packed-refs.lock", "index.lock"] as const;

/** A git process that may own a maintenance lock. Matched against a whole `ps` args line. */
const MAINTENANCE_PROCESS = /(^|[\s/])git\s(.*\s)?(gc|maintenance|repack|prune|pack-refs)(\s|$)/;

export interface ProcessEntry {
  pid: number;
  args: string;
}

/** Every process on this host, from `ps`, off the loop. */
export function listProcesses(): Promise<ProcessEntry[]> {
  return new Promise((resolvePromise, reject) => {
    execFile("ps", ["-eo", "pid=,args="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: PROCESS_LIST_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err);
      else resolvePromise(parseProcessList(stdout));
    });
  });
}

export function parseProcessList(stdout: string): ProcessEntry[] {
  return stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), args: match[2] }));
}

export interface StaleLockReclaimOptions {
  ageMs?: number;
  now?: () => number;
  hostname?: () => string;
  listProcesses?: () => Promise<ProcessEntry[]>;
  remove?: (path: string) => Promise<void>;
}

export interface ReclaimedLock {
  path: string;
  age_ms: number;
  why: string;
}

export interface StaleLockReclaim {
  removed: ReclaimedLock[];
  /** Stale leftovers that were present and deliberately kept, and why. Absent when nothing was refused. */
  refused?: { paths: string[]; reason: string };
  /** Removals that were attempted and failed. */
  failed?: Array<{ path: string; error: string }>;
}

async function refLocks(gitDir: string): Promise<string[]> {
  const entries = await readdir(join(gitDir, "refs"), { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".lock")).map((entry) => relative(gitDir, join(entry.parentPath, entry.name)));
}

/** Remove the stale maintenance leftovers in `gitDir` (a repo's COMMON git dir); see the module doc for the rules. */
export async function reclaimStaleGitLocks(gitDir: string, opts: StaleLockReclaimOptions = {}): Promise<StaleLockReclaim> {
  const ageMs = opts.ageMs ?? STALE_GIT_LOCK_AGE_MS;
  const now = (opts.now ?? Date.now)();
  const stale: Array<{ path: string; age_ms: number }> = [];
  for (const path of [...GIT_MAINTENANCE_LEFTOVERS, ...(await refLocks(gitDir))]) {
    const info = await stat(join(gitDir, path)).catch(() => undefined);
    if (info !== undefined && now - info.mtimeMs >= ageMs) stale.push({ path, age_ms: Math.round(now - info.mtimeMs) });
  }
  if (stale.length === 0) return { removed: [] };
  const paths = stale.map((entry) => entry.path);
  let processes: ProcessEntry[];
  try {
    processes = await (opts.listProcesses ?? listProcesses)();
  } catch (err) {
    return { removed: [], refused: { paths, reason: `process list unavailable, so a live gc cannot be ruled out: ${err instanceof Error ? err.message : String(err)}` } };
  }
  const live = processes.find((entry) => MAINTENANCE_PROCESS.test(entry.args));
  if (live !== undefined) return { removed: [], refused: { paths, reason: `live git maintenance process ${live.pid}: ${live.args}` } };
  const here = (opts.hostname ?? hostname)();
  let gcPidWhy = "";
  if (paths.includes("gc.pid")) {
    const [pidText = "", owner = ""] = (await readFile(join(gitDir, "gc.pid"), "utf8").catch(() => "")).trim().split(/\s+/);
    const pid = Number(pidText);
    if (owner === here && processes.some((entry) => entry.pid === pid && /(^|[\s/])git(\s|$)/.test(entry.args))) {
      return { removed: [], refused: { paths, reason: `gc.pid names live git process ${pid} on this host` } };
    }
    gcPidWhy = owner === here ? `; gc.pid names pid ${pidText}, not a live git process` : `; gc.pid names pid ${pidText} on host ${owner || "(unrecorded)"}, not this host ${here}`;
  }
  const remove = opts.remove ?? ((path: string) => rm(path, { force: true }));
  const result: StaleLockReclaim = { removed: [] };
  for (const entry of stale) {
    try {
      await remove(join(gitDir, entry.path));
      result.removed.push({ ...entry, why: `older than ${ageMs} ms with no live git maintenance process${entry.path === "gc.pid" ? gcPidWhy : ""}` });
    } catch (err) {
      (result.failed ??= []).push({ path: entry.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
