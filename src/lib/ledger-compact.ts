/**
 * Bounded operator entry point for ledger archive compaction.
 *
 * `compactRotations` owns row-set preservation. This module owns the filesystem boundary the
 * compactor deliberately leaves to its caller: select a small oldest-first window, read plain or
 * gzip rotations, stage the replacement atomically, and remove sources only after that write.
 * It is the bounded archive executor shared by the CLI and the daemon compaction rung; it is
 * never a rotation-path dependency.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { flagValue, unknownArgError } from "./cli-args.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { loadConfig } from "./config.js";
import { writeAtomic } from "./fs-race-safe.js";
import { compactRotations, type LedgerCompactionResult } from "./ledger.js";
import { ledgerRotationEntries, rotationStampIso, type LedgerCorpusEntry } from "./ledger-union.js";
import { ledgerPathFor } from "./ledger-path.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
export const LEDGER_COMPACT_DEFAULT_OLDER_THAN_DAYS = 7;
// PRIMARY CONTROL: bounds the exact-row Set and gzip inputs held by one operator invocation.
export const LEDGER_COMPACT_MAX_SOURCES = 50;
const LEDGER_COMPACT_MAX_OLDER_THAN_DAYS = 36_500;
const LEDGER_COMPACT_VALUE_FLAGS = ["--older-than", "--max-sources"];
const LEDGER_COMPACT_BOOL_FLAGS = ["--dry-run"];

function parseBoundedInteger(raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

export interface LedgerCompactFs {
  readdirSync: (dir: string) => string[];
  readFileSync: (path: string) => Buffer;
  existsSync: (path: string) => boolean;
  writeAtomic: (path: string, content: Buffer) => boolean;
  rmSync: (path: string) => void;
  gzipSync: (content: Buffer) => Buffer;
  gunzipSync: (content: Buffer) => Buffer;
}

export interface LedgerCompactCommandDeps {
  stateDir?: string;
  /** The time source, as the shared {@link Clock} port rather than a bare `() => Date`.
   *  src/lib/clock.ts is what that port exists for, and a new module has no legacy shape to keep. */
  clock?: Clock;
  fs?: LedgerCompactFs;
  out?: (line: string) => void;
  error?: (line: string) => void;
}

export interface LedgerCompactSelection {
  sources: LedgerCorpusEntry[];
  eligibleCount: number;
  unparseableAge: string[];
}

const realFs: LedgerCompactFs = {
  readdirSync: (dir) => readdirSync(dir),
  readFileSync: (path) => readFileSync(path),
  existsSync: (path) => existsSync(path),
  writeAtomic: (path, content) => writeAtomic(path, content, { tmpTag: "ledger-compact-tmp" }),
  rmSync: (path) => rmSync(path),
  gzipSync: (content) => gzipSync(content),
  gunzipSync: (content) => gunzipSync(content),
};

/** Select the oldest parseable rotations strictly older than the requested age. The hard source
 * ceiling bounds `compactRotations`' exact-row Set even when an operator supplies a larger flag. */
export function selectLedgerCompactionSources(
  names: string[], stateDir: string, olderThanDays: number, maxSources: number, now: Date): LedgerCompactSelection {
  // This signature stays on two lines so type erasure cannot mark a parameter-only line uncovered.
  // Selection uses filename time only to avoid opening an unbounded candidate set before the cap.
  // A name with no trustworthy time is reported separately rather than guessed old or recent.
  const cutoffMs = now.getTime() - olderThanDays * DAY_MS;
  const [eligible, unparseableAge]: [LedgerCorpusEntry[], string[]] = [[], []];
  // Keep skipped names so a partial age classification is always visible in the command report.
  for (const entry of ledgerRotationEntries(names, stateDir)) {
    const stamp = rotationStampIso(basename(entry.path));
    const stampMs = stamp === undefined ? Number.NaN : Date.parse(stamp);
    // Unparseable names cannot safely enter an age-based operator action.
    // Parseable names still must be strictly before the cutoff, never equal to it.
    if (!Number.isFinite(stampMs)) {
      unparseableAge.push(entry.path);
    } else if (stampMs < cutoffMs) {
      // Eligible rotations remain oldest-first because ledgerRotationEntries sorts by stamped path.
      // Selection records the manifest entry, not just its name, so the reader retains gzip/plain form.
      // The caller therefore never has to infer compression from contents.
      // Only this selected entry can reach the exact-row compactor below.
      eligible.push(entry);
    }
  }
  return { sources: eligible.slice(0, Math.min(maxSources, LEDGER_COMPACT_MAX_SOURCES)), eligibleCount: eligible.length, unparseableAge };
}
function reportFor(mode: "dry-run" | "apply", olderThanDays: number, maxSources: number, eligibleCount: number, unparseableAgeCount: number, result: LedgerCompactionResult): string {
  // These fields are the preview/apply audit contract.
  // The row counts come from exact compaction, never estimated bytes.
  // The archive name lets the operator verify the replacement before a real run.
  return JSON.stringify({
    mode, olderThanDays, maxSources, eligibleCount, unparseableAgeCount,
    sourceCount: result.sourceCount,
    rowsWritten: result.rowsWritten, duplicatesCollapsed: result.duplicatesCollapsed, archiveName: result.archiveName,
  });
}

/** `rmd ledger-compact`: bounded and exact in both preview and apply modes. */
export function ledgerCompactCommand(rest: string[], deps: LedgerCompactCommandDeps = {}): number {
  const log = deps.error ?? console.error;
  const out = deps.out ?? console.log;
  const badArg = unknownArgError("ledger-compact", rest, LEDGER_COMPACT_VALUE_FLAGS, LEDGER_COMPACT_BOOL_FLAGS);
  if (badArg) { log(badArg); return 2; }
  // Argument refusals stop before config or filesystem reads.
  // Exit 2 distinguishes invocation misuse from an archive or state failure.
  // All remaining paths have a valid and fully parsed invocation.
  // Filesystem failures below therefore use exit 1 instead.
  const olderThanPresent = rest.includes("--older-than");
  const maxSourcesPresent = rest.includes("--max-sources");
  const olderThanDays = olderThanPresent
    ? parseBoundedInteger(flagValue(rest, "--older-than"), 0, LEDGER_COMPACT_MAX_OLDER_THAN_DAYS)
    : LEDGER_COMPACT_DEFAULT_OLDER_THAN_DAYS;
  const maxSources = maxSourcesPresent
    ? parseBoundedInteger(flagValue(rest, "--max-sources"), 1, LEDGER_COMPACT_MAX_SOURCES)
    : LEDGER_COMPACT_MAX_SOURCES;
  if (olderThanDays === undefined || maxSources === undefined) {
    log(
      `rmd ledger-compact: --older-than must be an integer from 0 to ${LEDGER_COMPACT_MAX_OLDER_THAN_DAYS}; ` +
        `--max-sources must be an integer from 1 to ${LEDGER_COMPACT_MAX_SOURCES}`,
    );
    return 2;
  }

  const fs = deps.fs ?? realFs;
  let stateDir: string;
  try {
    stateDir = deps.stateDir ?? dirname(ledgerPathFor(loadConfig()));
  } catch (err) {
    log(`rmd ledger-compact: cannot resolve the state directory — ${(err as Error)?.message ?? String(err)}`);
    return 1;
  }

  let selection: LedgerCompactSelection;
  const now = (deps.clock ?? systemClock).date();
  try {
    selection = selectLedgerCompactionSources(
      fs.readdirSync(stateDir),
      stateDir,
      olderThanDays,
      maxSources,
      now,
    );
  } catch (err) {
    log(`rmd ledger-compact: cannot list ${stateDir} — ${(err as Error)?.message ?? String(err)}`);
    return 1;
  }

  const entryByPath = new Map<string, LedgerCorpusEntry>();
  for (const entry of selection.sources) entryByPath.set(entry.path, entry);
  let staged: { name: string; body: string } | undefined;
  const removals: string[] = [];
  let result: LedgerCompactionResult;
  try {
    result = compactRotations(selection.sources.map((entry) => entry.path), {
      readRows: (path) => {
        const entry = entryByPath.get(path);
        if (!entry) throw new Error(`selected source disappeared from the manifest: ${path}`);
        const raw = fs.readFileSync(path);
        const body = entry.form === "gzip" ? fs.gunzipSync(raw) : raw;
        return body.toString("utf8").split("\n");
      },
      write: (name, body) => {
        staged = { name, body };
      },
      remove: (path) => removals.push(path),
      clock: fixedClock(now.getTime()),
    });
  } catch (err) {
    log(`rmd ledger-compact: cannot read the selected window — ${(err as Error)?.message ?? String(err)}`);
    return 1;
  }

  const mode = rest.includes("--dry-run") ? "dry-run" : "apply";
  const report = reportFor(
    mode,
    olderThanDays,
    maxSources,
    selection.eligibleCount,
    selection.unparseableAge.length,
    result,
  );
  if (selection.unparseableAge.length > 0) {
    log(
      `rmd ledger-compact: skipped ${selection.unparseableAge.length} rotation(s) whose filename age is unreadable`,
    );
  }
  if (!staged) {
    out(report);
    return 0;
  }

  const targetPath = join(stateDir, staged.name);
  const selectedPaths = new Set(selection.sources.map((entry) => entry.path));
  if (fs.existsSync(targetPath) && !selectedPaths.has(targetPath)) {
    out(report);
    log(`rmd ledger-compact: refusing to overwrite unselected archive ${targetPath}`);
    return 1;
  }
  if (mode === "dry-run") {
    out(report);
    return 0;
  }

  try {
    const compressed = fs.gzipSync(Buffer.from(staged.body, "utf8"));
    if (!fs.writeAtomic(targetPath, compressed)) {
      throw new Error(`atomic replacement withdrew before rename: ${targetPath}`);
    }
    for (const path of removals) fs.rmSync(path);
  } catch (err) {
    log(`rmd ledger-compact: apply failed — ${(err as Error)?.message ?? String(err)}`);
    return 1;
  }
  out(report);
  return 0;
}
