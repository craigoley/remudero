/**
 * Bounded operator entry point for ledger archive compaction.
 *
 * `compactRotations` owns row-set preservation. This module owns the filesystem boundary the
 * compactor deliberately leaves to its caller: select a small oldest-first window, read plain or
 * gzip rotations, stage the replacement atomically, and remove sources only after that write.
 * It is the bounded archive executor shared by the CLI and the daemon compaction rung; it is
 * never a rotation-path dependency.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
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
const LEDGER_COMPACT_VALUE_FLAGS = ["--older-than", "--older-than-hours", "--max-sources"];
/** An archive this many times the typical rotation's size is a previous pass's output (one pass
 *  merges up to {@link LEDGER_COMPACT_MAX_SOURCES} rotations; rotations are cut at one size). */
export const MERGED_ARCHIVE_SIZE_FACTOR = 4;
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
  /** Bytes on disk. Absent, every archive is treated alike, as before W1-T4262. */
  sizeOf?: (path: string) => number;
  /** Cold storage: a merged source is MOVED, never deleted, until its retention lapses. */
  mkdirSync?: (dir: string) => void;
  renameSync?: (from: string, to: string) => void;
  /** Stamps a moved file with the move time, so retention counts from when it went cold. */
  touch?: (path: string, atMs: number) => void;
  mtimeMs?: (path: string) => number;
}

/** Where merged sources go instead of being deleted; a union read lists only `ledger.*` names, so
 *  this directory is never scanned. */
export const LEDGER_COLD_STORE_DIRNAME = "ledger-superseded";
/** Operator ruling 2026-09-23: a merged source stays recoverable for 30 days, then is deleted —
 *  its rows already live in the compacted archive. */
export const LEDGER_COLD_STORE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
  sizeOf: (path) => statSync(path).size,
  mkdirSync: (dir) => mkdirSync(dir, { recursive: true }),
  renameSync: (from, to) => renameSync(from, to),
  touch: (path, atMs) => utimesSync(path, atMs / 1000, atMs / 1000),
  mtimeMs: (path) => statSync(path).mtimeMs,
};

/** Select the oldest parseable rotations strictly older than the requested age. The hard source
 * ceiling bounds `compactRotations`' exact-row Set even when an operator supplies a larger flag. */
export function selectLedgerCompactionSources(
  names: string[], stateDir: string, olderThanDays: number, maxSources: number, now: Date,
  sizeOf?: (path: string) => number): LedgerCompactSelection {
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
  const cap = Math.min(maxSources, LEDGER_COMPACT_MAX_SOURCES);
  // W1-T4262: a previous pass's output is re-read whole by every pass that picks it, so ordinary
  // rotations go first; outputs merge with each other, two at a time, only once none are left.
  const merged = mergedArchives(ledgerRotationEntries(names, stateDir), sizeOf);
  const rotations = eligible.filter((e) => !merged.has(e.path));
  const sources = rotations.length > 0 ? rotations.slice(0, cap) : eligible.slice(0, Math.min(cap, 2));
  return { sources, eligibleCount: eligible.length, unparseableAge };
}

/** Archives far larger than the median rotation: earlier passes' outputs. */
function mergedArchives(entries: LedgerCorpusEntry[], sizeOf: ((path: string) => number) | undefined): Set<string> {
  if (!sizeOf || entries.length === 0) return new Set();
  const sizes = entries.map((e) => {
    try {
      return { path: e.path, size: sizeOf(e.path) };
    } catch {
      // deliberate: an archive gone between listing and sizing is ordinary rotation churn; it counts
      // as an ordinary rotation, and the read that follows reports it in the command's own error.
      return { path: e.path, size: 0 };
    }
  });
  const sorted = sizes.map((x) => x.size).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return new Set(sizes.filter((x) => x.size > MERGED_ARCHIVE_SIZE_FACTOR * median).map((x) => x.path));
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
  const olderThanHoursPresent = rest.includes("--older-than-hours");
  const maxSourcesPresent = rest.includes("--max-sources");
  const hours = olderThanHoursPresent ? parseBoundedInteger(flagValue(rest, "--older-than-hours"), 0, LEDGER_COMPACT_MAX_OLDER_THAN_DAYS * 24) : undefined;
  const olderThanDays = olderThanPresent && olderThanHoursPresent
    ? undefined
    : olderThanHoursPresent
      ? (hours === undefined ? undefined : hours / 24)
      : olderThanPresent
        ? parseBoundedInteger(flagValue(rest, "--older-than"), 0, LEDGER_COMPACT_MAX_OLDER_THAN_DAYS)
        : LEDGER_COMPACT_DEFAULT_OLDER_THAN_DAYS;
  const maxSources = maxSourcesPresent
    ? parseBoundedInteger(flagValue(rest, "--max-sources"), 1, LEDGER_COMPACT_MAX_SOURCES)
    : LEDGER_COMPACT_MAX_SOURCES;
  if (olderThanDays === undefined || maxSources === undefined) {
    log(
      `rmd ledger-compact: --older-than must be an integer from 0 to ${LEDGER_COMPACT_MAX_OLDER_THAN_DAYS} (or --older-than-hours, not both); ` +
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
      fs.sizeOf,
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
    coldStore(fs, stateDir, removals, now.getTime(), log);
  } catch (err) {
    log(`rmd ledger-compact: apply failed — ${(err as Error)?.message ?? String(err)}`);
    return 1;
  }
  out(report);
  return 0;
}

/** Move each merged source into {@link LEDGER_COLD_STORE_DIRNAME}, then delete cold files past
 *  {@link LEDGER_COLD_STORE_RETENTION_MS}. A seam without the move falls back to deleting, as before. */
export function coldStore(fs: LedgerCompactFs, stateDir: string, sources: readonly string[], nowMs: number, log: (line: string) => void): void {
  const { mkdirSync: mkdir, renameSync: rename, touch, mtimeMs } = fs;
  if (!mkdir || !rename || !touch || !mtimeMs) {
    for (const path of sources) fs.rmSync(path);
    return;
  }
  const coldDir = join(stateDir, LEDGER_COLD_STORE_DIRNAME);
  mkdir(coldDir);
  for (const path of sources) {
    const target = join(coldDir, basename(path));
    rename(path, target);
    touch(target, nowMs);
  }
  let pruned = 0;
  for (const name of fs.readdirSync(coldDir)) {
    const path = join(coldDir, name);
    if (nowMs - mtimeMs(path) > LEDGER_COLD_STORE_RETENTION_MS) {
      fs.rmSync(path);
      pruned++;
    }
  }
  if (pruned > 0) log(`rmd ledger-compact: deleted ${pruned} cold-stored source(s) past the 30-day retention in ${coldDir}`);
}
