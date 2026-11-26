/**
 * lib/progress-watchdog-drain-memo.ts — W1-T14920: THE WATCHDOG'S DRAIN READ PARSES EACH ROTATION ONCE.
 *
 * `rmd progress-watchdog --json` derives drainWaitS (W1-T11320) from every implement.done, verdict,
 * run.freshness_handoff and worker.recycle_yield row the ledger holds. Read with no `since` bound, the union
 * gunzipped every rotation on every 5-minute host watchdog tick: 275 rotations (1.2 GB compressed) on core,
 * about 110 s of CPU per tick (measured 2026-11-26). A rotation is written once, so its matching rows never
 * change: this file keeps them, per rotation path, with the rotation's size and mtime, and answers a matching
 * rotation without reading it. The live ledger is still read every time, and the union's own filters and dedupe
 * apply to the remembered rows, so the rows returned equal a whole read.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  readLedgerUnionRecordsSync,
  realLedgerFs,
  type LedgerCorpusEntry,
  type LedgerGrepFsDeps,
  type LedgerRotationRecords,
} from "./ledger-union.js";
import { writeAtomic } from "./fs-race-safe.js";

/** The steps the drain wait reads (src/lib/deployer.ts readImplementDurationsMs and readDrainWaitLanes). */
export const PROGRESS_WATCHDOG_DRAIN_STEPS = Object.freeze(["implement.done", "verdict", "run.freshness_handoff", "worker.recycle_yield"]);
/** The memo file, beside the ledger. Bump {@link DRAIN_MEMO_VERSION} when the steps or the row shape change. */
export const DRAIN_MEMO_FILENAME = "progress-watchdog-drain-rotations.json";
export const DRAIN_MEMO_VERSION = "w1-t14920.1";

interface DrainMemoEntry { size: number; mtimeMs: number; torn: number; rows: Array<Record<string, unknown>> }
interface DrainMemoFile { version: string; steps: string[]; entries: Record<string, DrainMemoEntry> }

function loadMemo(path: string, read: (path: string) => string): Record<string, DrainMemoEntry> {
  try {
    const parsed = JSON.parse(read(path)) as Partial<DrainMemoFile>;
    if (parsed.version !== DRAIN_MEMO_VERSION || JSON.stringify(parsed.steps) !== JSON.stringify(PROGRESS_WATCHDOG_DRAIN_STEPS)) return {};
    return parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {};
  } catch {
    return {}; // missing, unreadable or foreign: every rotation is parsed, and the file is rewritten
  }
}

/** The drain rows of `stateDir`'s ledger union, every rotation answered from the memo when its size and mtime match.
 *  `fs` is the union's own seam (its `statSync` gives each rotation's identity); `memoPath` defaults beside the ledger. */
export function readProgressWatchdogDrainRows(
  stateDir: string,
  fs: LedgerGrepFsDeps = realLedgerFs,
  memoPath: string = join(stateDir, DRAIN_MEMO_FILENAME),
): Array<Record<string, unknown>> {
  const stat = fs.statSync ?? ((path: string) => statSync(path));
  const previous = loadMemo(memoPath, (path) => readFileSync(path, "utf8"));
  const next: Record<string, DrainMemoEntry> = {};
  const steps = new Set<string>(PROGRESS_WATCHDOG_DRAIN_STEPS);
  let changed = false;
  const rotationRecords = (entry: LedgerCorpusEntry, parse: () => LedgerRotationRecords): LedgerRotationRecords => {
    let identity: { size: number; mtimeMs: number } | undefined;
    try {
      const s = stat(entry.path);
      identity = { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return parse(); // an unstattable rotation is read as the union reads it, and not remembered
    }
    const known = previous[entry.path];
    if (known && known.size === identity.size && known.mtimeMs === identity.mtimeMs) {
      next[entry.path] = known;
      return { rows: known.rows, torn: known.torn, tornLines: [] };
    }
    const read = parse();
    next[entry.path] = { ...identity, torn: read.torn, rows: read.rows.filter((row) => steps.has(String(row.step))) };
    changed = true;
    return read;
  };
  const rows = readLedgerUnionRecordsSync(stateDir, { step: [...PROGRESS_WATCHDOG_DRAIN_STEPS], rotationRecords }, fs).rows;
  if (changed || Object.keys(previous).some((path) => !(path in next))) {
    const text = JSON.stringify({ version: DRAIN_MEMO_VERSION, steps: [...PROGRESS_WATCHDOG_DRAIN_STEPS], entries: next } satisfies DrainMemoFile);
    try {
      writeAtomic(memoPath, text);
    } catch {
      // deliberate: an unwritable memo costs the next tick a full read, never this verdict
    }
  }
  return rows;
}
