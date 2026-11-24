/**
 * W1-T14635: a standby reads the rotated ledger before it is promoted, so its boot reads only the live file.
 *
 * A rotation is never rewritten in place, so its rows are the same before and after the hand-over. This cache keeps,
 * for each rotation it has read, only the rows of the steps a read asked for, keyed by the file's identity (path,
 * size, mtime) and that step filter. A rotation written after the warm read, or one whose identity changed, is a miss
 * and is read from disk; the live file is never cached. `dispose` drops every kept row.
 */
import { statSync } from "node:fs";
import { readLedgerUnionRecordsSync, type LedgerRotationRecords } from "./ledger-union.js";

export interface LedgerRotationCache {
  /** {@link readLedgerUnionRecordsSync}, with each rotation answered from the cache when it is unchanged. */
  read: typeof readLedgerUnionRecordsSync;
  /** Rotations answered from the cache, and rotations read from disk, since the cache was made. */
  counts: () => { hits: number; misses: number };
  dispose: () => void;
}

export function createLedgerRotationCache(stat: (path: string) => { size: number; mtimeMs: number } = statSync): LedgerRotationCache {
  const kept = new Map<string, LedgerRotationRecords>();
  let hits = 0;
  let misses = 0;
  const read: typeof readLedgerUnionRecordsSync = (stateDir, opts = {}, fsDeps) => {
    // A caller that supplies its own rotation records, or reshapes rows as they are parsed, is passed through untouched.
    if (opts.rotationRecords !== undefined || opts.projectRotationLine !== undefined) return readLedgerUnionRecordsSync(stateDir, opts, fsDeps);
    const steps = opts.step === undefined ? undefined : new Set(typeof opts.step === "string" ? [opts.step] : opts.step);
    const filterKey = steps === undefined ? "*" : [...steps].sort().join(",");
    return readLedgerUnionRecordsSync(stateDir, {
      ...opts,
      rotationRecords: (entry, parse) => {
        const id = stat(entry.path);
        const key = `${entry.path}\0${id.size}\0${id.mtimeMs}\0${filterKey}`;
        const hit = kept.get(key);
        if (hit !== undefined) {
          hits += 1;
          return hit;
        }
        misses += 1;
        const parsed = parse();
        const records = steps === undefined ? parsed
          : { ...parsed, rows: parsed.rows.filter((row) => typeof row.step === "string" && steps.has(row.step)) };
        kept.set(key, records);
        return records;
      },
    }, fsDeps);
  };
  return { read, counts: () => ({ hits, misses }), dispose: () => kept.clear() };
}
