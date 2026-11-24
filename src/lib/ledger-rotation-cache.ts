/**
 * W1-T14635: a standby reads the rotated ledger before it is promoted, so its boot reads only the live file.
 *
 * A rotation is never rewritten in place, so its rows are the same before and after the hand-over. This cache keeps,
 * for each rotation a union read has parsed, only the rows of the steps that read asked for, keyed by the file's
 * identity (path, size, mtime) and that step filter. A rotation written after the warm read, or one whose identity
 * changed, is a miss and is parsed from disk; the live file never passes through the hook. The cache reads nothing
 * itself: an existing union reader passes {@link LedgerRotationCache.hook} as its `rotationRecords`. `dispose` drops
 * every kept row.
 */
import { statSync } from "node:fs";
import type { LedgerRotationHook, LedgerRotationRecords } from "./ledger-union.js";

export interface LedgerRotationCache {
  /** The `rotationRecords` hook for a union read of `step`, answering an unchanged rotation from the cache. */
  hook: (step: string | readonly string[] | undefined) => LedgerRotationHook;
  /** Rotations answered from the cache, and rotations parsed from disk, since the cache was made. */
  counts: () => { hits: number; misses: number };
  dispose: () => void;
}

export function createLedgerRotationCache(stat: (path: string) => { size: number; mtimeMs: number } = statSync): LedgerRotationCache {
  const kept = new Map<string, LedgerRotationRecords>();
  let hits = 0;
  let misses = 0;
  const hook = (step: string | readonly string[] | undefined): LedgerRotationHook => {
    const steps = step === undefined ? undefined : new Set(typeof step === "string" ? [step] : step);
    const filterKey = steps === undefined ? "*" : [...steps].sort().join(",");
    return (entry, parse) => {
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
    };
  };
  return { hook, counts: () => ({ hits, misses }), dispose: () => kept.clear() };
}
