/**
 * Bounded operator entry point for ledger archive compaction.
 *
 * `compactRotations` owns row-set preservation. This module owns the filesystem boundary the
 * compactor deliberately leaves to its caller: select a small oldest-first window, read plain or
 * gzip rotations, stage one replacement per UTC day atomically, and remove sources only after those writes.
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
import { compactRotations, compactedArchiveName, type LedgerCompactionResult } from "./ledger.js";
import { ledgerRotationEntries, rotationStampIso, type LedgerCorpusEntry } from "./ledger-union.js";
import { ledgerPathFor } from "./ledger-path.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
export const LEDGER_COMPACT_DEFAULT_OLDER_THAN_DAYS = 7;
// PRIMARY CONTROL: bounds the exact-row Set and gzip inputs held by one operator invocation.
export const LEDGER_COMPACT_MAX_SOURCES = 50;
/**
 * PRIMARY CONTROL: bound one archive's decompressed rows to 64 MiB. In the 2026-09-23 synthetic million-row
 * measurement, ten-way partitioning put each archive near 87 MiB and held peak RSS to 205-231 MiB;
 * one whole-million-row archive reached 752 MiB. Staying below one measured partition leaves room
 * for the reader's row objects under a 256 MiB per-read budget.
 */
export const LEDGER_COMPACT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
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
  gunzipSync: (content: Buffer, options?: { maxOutputLength?: number }) => Buffer;
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
  /** Test seam may lower the production ceiling, never raise it. */
  maxArchiveBytes?: number;
  out?: (line: string) => void;
  error?: (line: string) => void;
}

export interface LedgerCompactSelection {
  sources: LedgerCorpusEntry[];
  eligibleCount: number;
  unparseableAge: string[];
  /** Eligible source files withheld from this pass because the decompressed-byte budget was reached. */
  sizeSkippedCount?: number;
}

const realFs: LedgerCompactFs = {
  readdirSync: (dir) => readdirSync(dir),
  readFileSync: (path) => readFileSync(path),
  existsSync: (path) => existsSync(path),
  writeAtomic: (path, content) => writeAtomic(path, content, { tmpTag: "ledger-compact-tmp" }),
  rmSync: (path) => rmSync(path),
  gzipSync: (content) => gzipSync(content),
  gunzipSync: (content, options) => gunzipSync(content, options),
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
  sizeOf?: (path: string) => number,
  decompressedSizeOf?: (entry: LedgerCorpusEntry, maxArchiveBytes: number) => number,
  maxArchiveBytes = LEDGER_COMPACT_MAX_ARCHIVE_BYTES): LedgerCompactSelection {
  // This signature stays on two lines so type erasure cannot mark a parameter-only line uncovered.
  // Selection uses filename time only to avoid opening an unbounded candidate set before the cap.
  // A name with no trustworthy time is reported separately rather than guessed old or recent.
  const cutoffMs = now.getTime() - olderThanDays * DAY_MS;
  const [eligible, unparseableAge]: [LedgerCorpusEntry[], string[]] = [[], []];
  // Keep skipped names so a partial age classification is always visible in the command report.
  for (const entry of ledgerRotationEntries(names, stateDir)) {
    const stamp = compactionStamp(basename(entry.path));
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
  const measured = new Map<string, number>();
  const measure = (entry: LedgerCorpusEntry): number => {
    const cached = measured.get(entry.path);
    if (cached !== undefined) return cached;
    const bytes = decompressedSizeOf!(entry, maxArchiveBytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(`invalid decompressed size for ${entry.path}: ${bytes}`);
    }
    measured.set(entry.path, bytes);
    return bytes;
  };
  // Repair a legacy oversized merged output before steady new rotations can starve it forever.
  // The probe is bounded to one archive's ceiling plus one byte at a time. Once repaired, its
  // smaller pieces no longer qualify and normal rotation-first scheduling resumes.
  const repair = decompressedSizeOf
    ? eligible.find((entry) => merged.has(entry.path) && measure(entry) > maxArchiveBytes)
    : undefined;
  const candidates = repair ? [repair, ...eligible.filter((entry) => entry.path !== repair.path)]
    : rotations.length > 0 ? rotations : eligible;
  const sourceLimit = repair ? Math.min(cap, 2) : rotations.length > 0 ? cap : Math.min(cap, 2);
  const window = candidates.slice(0, sourceLimit);
  if (!decompressedSizeOf) return { sources: window, eligibleCount: eligible.length, unparseableAge };

  const sources: LedgerCorpusEntry[] = [];
  let selectedBytes = 0;
  let sizeSkippedCount = 0;
  let oversizedOnlySource = false;
  for (let index = 0; index < window.length; index += 1) {
    const entry = window[index]!;
    const bytes = measure(entry);
    if (sources.length === 0 && bytes > maxArchiveBytes) {
      // A legacy oversized archive is admitted alone so this pass can re-split it; it is never
      // combined with another source, and the write boundary below still caps every replacement.
      sources.push(entry);
      oversizedOnlySource = true;
      sizeSkippedCount = repair ? eligible.length - 1 : window.length - index - 1;
      break;
    }
    if (selectedBytes + bytes > maxArchiveBytes) {
      // Preserve oldest-first prefix selection. The remaining candidates are deferred, not silently
      // merged into an output whose next read would exceed the measured budget.
      sizeSkippedCount = window.length - index;
      break;
    }
    sources.push(entry);
    selectedBytes += bytes;
  }
  if (sizeSkippedCount > 0 && !oversizedOnlySource && sources.length === 1 && isArchivePart(sources[0]!.path)) {
    // A part emitted below is already deduped and under the ceiling. If its sibling cannot fit in
    // this pass, re-reading/re-writing this lone part cannot make progress; defer the whole prefix.
    sources.length = 0;
    sizeSkippedCount += 1;
  }
  return { sources, eligibleCount: eligible.length, unparseableAge, sizeSkippedCount };
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
function reportFor(
  mode: "dry-run" | "apply",
  olderThanDays: number,
  maxSources: number,
  eligibleCount: number,
  unparseableAgeCount: number,
  result: LedgerCompactionResult,
  sizeSkippedCount?: number,
): string {
  // These fields are the preview/apply audit contract.
  // The row counts come from exact compaction, never estimated bytes.
  // The archive name lets the operator verify the replacement before a real run.
  return JSON.stringify({
    mode, olderThanDays, maxSources, eligibleCount, unparseableAgeCount,
    sourceCount: result.sourceCount,
    rowsWritten: result.rowsWritten, duplicatesCollapsed: result.duplicatesCollapsed, archiveName: result.archiveName,
    archiveNames: result.archiveNames,
    ...(sizeSkippedCount && sizeSkippedCount > 0 ? { sizeSkippedCount } : {}),
  });
}

function decompressedSizeOf(fs: LedgerCompactFs, entry: LedgerCorpusEntry, maxArchiveBytes: number): number {
  try {
    if (entry.form === "plain") {
      return fs.sizeOf ? fs.sizeOf(entry.path) : fs.readFileSync(entry.path).byteLength;
    }
    const compressed = fs.readFileSync(entry.path);
    try {
      return fs.gunzipSync(compressed, { maxOutputLength: maxArchiveBytes + 1 }).byteLength;
    } catch (err) {
      if ((err as { code?: unknown })?.code === "ERR_BUFFER_TOO_LARGE") return maxArchiveBytes + 1;
      throw err;
    }
  } catch (err) {
    throw new Error(`cannot read the selected window — ${(err as Error)?.message ?? String(err)} (${entry.path})`);
  }
}

function splitArchiveBody(body: string, maxArchiveBytes: number): string[] {
  const rows = body.endsWith("\n") ? body.slice(0, -1).split("\n") : body.split("\n");
  if (rows.length === 1 && rows[0] === "") return [];
  const parts: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(row, "utf8") + 1;
    if (rowBytes > maxArchiveBytes) {
      throw new Error(`one ledger row is ${rowBytes} bytes, over the ${maxArchiveBytes}-byte archive ceiling`);
    }
    if (current.length > 0 && currentBytes + rowBytes > maxArchiveBytes) {
      parts.push(`${current.join("\n")}\n`);
      current = [];
      currentBytes = 0;
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  if (current.length > 0) parts.push(`${current.join("\n")}\n`);
  return parts;
}

function archivePartName(name: string, part: number): string {
  const suffix = `-part-${String(part).padStart(6, "0")}`;
  return name.replace(/\.ndjson(?:\.gz)?$/, `${suffix}.ndjson.gz`);
}

function archiveNameForChunk(baseName: string, body: string): string | undefined {
  const baseStamp = rotationStampIso(baseName);
  if (!baseStamp) return undefined;
  const baseMs = Date.parse(baseStamp);
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const line of body.split("\n")) {
    const match = /"ts":"([^"]+)"/.exec(line);
    const parsed = match ? Date.parse(match[1]!) : Number.NaN;
    if (Number.isFinite(parsed)) newestMs = Math.max(newestMs, Math.min(parsed, baseMs));
  }
  return compactedArchiveName(fixedClock(Number.isFinite(newestMs) ? newestMs : baseMs).iso());
}

function compactionStamp(name: string): string | undefined {
  return rotationStampIso(name.replace(/-part-\d+(?=\.ndjson(?:\.gz)?$)/, ""));
}

function isArchivePart(path: string): boolean {
  return /-part-\d+\.ndjson(?:\.gz)?$/.test(path);
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
  const maxArchiveBytes =
    deps.maxArchiveBytes !== undefined && Number.isSafeInteger(deps.maxArchiveBytes) && deps.maxArchiveBytes > 0
      ? Math.min(deps.maxArchiveBytes, LEDGER_COMPACT_MAX_ARCHIVE_BYTES)
      : LEDGER_COMPACT_MAX_ARCHIVE_BYTES;
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
      (entry, limit) => decompressedSizeOf(fs, entry, limit),
      maxArchiveBytes,
    );
  } catch (err) {
    log(`rmd ledger-compact: cannot list or size eligible archives in ${stateDir} — ${(err as Error)?.message ?? String(err)}`);
    return 1;
  }

  const entryByPath = new Map<string, LedgerCorpusEntry>();
  for (const entry of selection.sources) entryByPath.set(entry.path, entry);
  const selectedPaths = new Set(selection.sources.map((entry) => entry.path));
  const stagedPaths = new Set<string>();
  const staged: { name: string; body: string }[] = [];
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
        const parts = splitArchiveBody(body, maxArchiveBytes);
        const basePath = join(stateDir, name);
        parts.forEach((partBody, index) => {
          const isSplit = parts.length > 1;
          const isLast = index === parts.length - 1;
          const canUseBase =
            isSplit && isLast && (!fs.existsSync(basePath) || selectedPaths.has(basePath)) && !stagedPaths.has(basePath);
          let outputName = !isSplit || canUseBase ? name : "";
          if (outputName === "") {
            const timedName = archiveNameForChunk(name, partBody);
            const timedPath = timedName ? join(stateDir, timedName) : "";
            if (
              timedName && timedPath !== basePath && !stagedPaths.has(timedPath) &&
              (!fs.existsSync(timedPath) || selectedPaths.has(timedPath))
            ) {
              outputName = timedName;
            } else {
              let part = index + 1;
              do {
                outputName = archivePartName(name, part++);
              } while (fs.existsSync(join(stateDir, outputName)) || stagedPaths.has(join(stateDir, outputName)));
            }
          }
          const outputPath = join(stateDir, outputName);
          stagedPaths.add(outputPath);
          staged.push({ name: outputName, body: partBody });
        });
      },
      remove: (path) => removals.push(path),
      clock: fixedClock(now.getTime()),
    });
  } catch (err) {
    log(`rmd ledger-compact: cannot read the selected window — ${(err as Error)?.message ?? String(err)}`);
    return 1;
  }
  if (staged.length > 0) {
    // Report the actual per-day pieces (including collision-safe part names), not compactRotations'
    // unsplit base names.
    result = { ...result, archiveName: staged.at(-1)!.name, archiveNames: staged.map((entry) => entry.name) };
  }

  const mode = rest.includes("--dry-run") ? "dry-run" : "apply";
  const report = reportFor(
    mode,
    olderThanDays,
    maxSources,
    selection.eligibleCount,
    selection.unparseableAge.length,
    result,
    selection.sizeSkippedCount,
  );
  if (selection.unparseableAge.length > 0) {
    log(
      `rmd ledger-compact: skipped ${selection.unparseableAge.length} rotation(s) whose filename age is unreadable`,
    );
  }
  if (selection.sizeSkippedCount && selection.sizeSkippedCount > 0) {
    log(
      `rmd ledger-compact: deferred ${selection.sizeSkippedCount} eligible rotation(s) at the ${maxArchiveBytes}-byte decompressed archive ceiling`,
    );
  }
  if (staged.length === 0) {
    out(report);
    return 0;
  }

  // Every day's output is checked before ANY is written, so a refusal leaves the corpus untouched.
  for (const { name } of staged) {
    const targetPath = join(stateDir, name);
    if (fs.existsSync(targetPath) && !selectedPaths.has(targetPath)) {
      out(report);
      log(`rmd ledger-compact: refusing to overwrite unselected archive ${targetPath}`);
      return 1;
    }
  }
  if (mode === "dry-run") {
    out(report);
    return 0;
  }

  try {
    for (const { name, body } of staged) {
      const targetPath = join(stateDir, name);
      if (!fs.writeAtomic(targetPath, fs.gzipSync(Buffer.from(body, "utf8")))) {
        throw new Error(`atomic replacement withdrew before rename: ${targetPath}`);
      }
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
