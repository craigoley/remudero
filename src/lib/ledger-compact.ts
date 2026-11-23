/**
 * Bounded operator entry point for ledger archive compaction.
 *
 * `compactRotations` owns row-set preservation. This module owns the filesystem boundary the
 * compactor deliberately leaves to its caller: select a bounded window preferring shared days, read plain or
 * gzip rotations, publish replacements at unused paths (or, last, over a source whose rows are already published),
 * and remove sources only after those writes.
 * It is the bounded archive executor shared by the CLI and the daemon compaction rung; it is
 * never a rotation-path dependency.
 */
import { closeSync, constants, copyFileSync, existsSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { flagValue, unknownArgError } from "./cli-args.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { loadConfig } from "./config.js";
import { realWriteAtomicIo, writeAtomic, type WriteAtomicIo } from "./fs-race-safe.js";
import { compactRotations, compactedArchiveName, ledgerRotationLockPath, tryAcquireRotationLock, type LedgerCompactionResult } from "./ledger.js";
import { ledgerLivePath, ledgerRotationEntries, rotationStampIso, type LedgerCorpusEntry } from "./ledger-union.js";
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
const GZIP_ISIZE_BYTES = 4;
// Ten header bytes, at least two DEFLATE bytes, and eight trailer bytes.
const GZIP_MIN_BYTES = 20;
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
  /** Size from the last gzip member's trailer. Undefined when too short to read a trailer. */
  gzipTrailerSizeOf?: (path: string) => number | undefined;
  /** Cold storage: a merged source is MOVED, never deleted, until its retention lapses. */
  mkdirSync?: (dir: string) => void;
  renameSync?: (from: string, to: string) => void;
  /** Stamps a moved file with the move time, so retention counts from when it went cold. */
  touch?: (path: string, atMs: number) => void;
  mtimeMs?: (path: string) => number;
  /** W1-T13859: takes the ledger rotation lock for an apply; null when a live holder has it. Absent, an
   *  in-memory seam compacts without it, as before. */
  rotationLock?: (lockPath: string) => (() => void) | null;
  /** W1-T13859: atomically replaces a selected source in place with an output that keeps its name. Absent,
   *  `writeAtomic` does it. */
  replaceAtomic?: (path: string, content: Buffer) => boolean;
  /** W1-T13859: copies a source into cold storage before an output replaces it. Absent, the copy is written
   *  with `writeAtomic`. */
  copyFileSync?: (from: string, to: string) => void;
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
  /** W1-T13859: the caller already holds the ledger rotation lock for this pass (the worker's parent thread). */
  rotationLockHeld?: boolean;
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

const publishArchiveIo: WriteAtomicIo = {
  ...realWriteAtomicIo,
  writeFileSync: (...args) => realWriteAtomicIo.writeFileSync(...args),
  // Atomically name the complete stage only if the destination is still unused.
  renameSync: (stage, target) => {
    linkSync(stage, target);
    unlinkSync(stage);
  },
};

/** Replaces a selected source in place: the rename overwrites, so readers see the old file or the new one. */
const replaceArchiveIo: WriteAtomicIo = {
  ...realWriteAtomicIo,
  writeFileSync: (...args) => realWriteAtomicIo.writeFileSync(...args),
  renameSync: (...args) => realWriteAtomicIo.renameSync(...args),
};

function readGzipTrailerSize(path: string): number | undefined {
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    if (size < GZIP_MIN_BYTES) return undefined;
    const tail = Buffer.alloc(GZIP_ISIZE_BYTES);
    const bytes = readSync(fd, tail, 0, tail.length, size - tail.length);
    return bytes === tail.length ? tail.readUInt32LE(0) : undefined;
  } finally {
    closeSync(fd);
  }
}

const realFs: LedgerCompactFs = {
  readdirSync: (dir) => readdirSync(dir),
  readFileSync: (path) => readFileSync(path),
  existsSync: (path) => existsSync(path),
  writeAtomic: (path, content) => writeAtomic(path, content, { tmpTag: "ledger-compact-tmp", io: publishArchiveIo }),
  rmSync: (path) => rmSync(path),
  gzipSync: (content) => gzipSync(content),
  gunzipSync: (content, options) => gunzipSync(content, options),
  sizeOf: (path) => statSync(path).size,
  gzipTrailerSizeOf: readGzipTrailerSize,
  mkdirSync: (dir) => mkdirSync(dir, { recursive: true }),
  renameSync: (from, to) => renameSync(from, to),
  touch: (path, atMs) => utimesSync(path, atMs / 1000, atMs / 1000),
  mtimeMs: (path) => statSync(path).mtimeMs,
  rotationLock: (lockPath) => tryAcquireRotationLock(lockPath),
  replaceAtomic: (path, content) => writeAtomic(path, content, { tmpTag: "ledger-compact-tmp", io: replaceArchiveIo }),
  copyFileSync: (from, to) => copyFileSync(from, to, constants.COPYFILE_EXCL),
};

/** Select parseable rotations strictly older than the requested age, preferring shared UTC days. The hard source
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
  // Once repaired, smaller pieces no longer qualify and normal rotation-first scheduling resumes.
  const repair = decompressedSizeOf
    ? eligible.find((entry) => merged.has(entry.path) && measure(entry) > maxArchiveBytes)
    : undefined;
  const candidates = repair ? [repair, ...eligible.filter((entry) => entry.path !== repair.path)]
    : rotations.length > 0 ? rotations : eligible;
  const dayOf = (entry: LedgerCorpusEntry): string => compactionStamp(basename(entry.path))!.slice(0, 10);
  const dayCounts = new Map<string, number>();
  for (const entry of candidates) dayCounts.set(dayOf(entry), (dayCounts.get(dayOf(entry)) ?? 0) + 1);
  // Keep oldest-first order within each tier, without letting singleton days starve mergeable days.
  const preferred = repair ? candidates : [
    ...candidates.filter((entry) => dayCounts.get(dayOf(entry))! > 1),
    ...candidates.filter((entry) => dayCounts.get(dayOf(entry)) === 1),
  ];
  const sourceLimit = repair ? Math.min(cap, 2) : rotations.length > 0 ? cap : Math.min(cap, 2);
  const window = preferred.slice(0, sourceLimit);
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
      // Preserve the preferred candidate prefix. The remaining candidates are deferred, not silently
      // merged into an output whose next read would exceed the measured budget.
      sizeSkippedCount = window.length - index;
      break;
    }
    sources.push(entry);
    selectedBytes += bytes;
  }
  if (!repair && !oversizedOnlySource && sources.length < 2) {
    // W1-T13370: the walk above stops at the first overflow, so a large head archive that never pairs left one source,
    // declined as no-reduction on every pass. Outputs are per UTC day, so pack each day within the ceiling, skipping
    // overflows, and take the day that merges the most sources (ties: the oldest).
    const days = new Map<string, LedgerCorpusEntry[]>();
    for (const entry of preferred) days.set(dayOf(entry), [...(days.get(dayOf(entry)) ?? []), entry]);
    let best: LedgerCorpusEntry[] = [];
    for (const [, entries] of [...days].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const pack: LedgerCorpusEntry[] = [];
      let bytes = 0;
      for (const entry of entries) {
        if (pack.length >= sourceLimit) break;
        const size = measure(entry);
        if (bytes + size > maxArchiveBytes) continue;
        pack.push(entry);
        bytes += size;
      }
      if (pack.length > best.length) best = pack;
    }
    if (best.length >= 2) {
      return { sources: best, eligibleCount: eligible.length, unparseableAge, sizeSkippedCount: eligible.length - best.length };
    }
    // No day packs two: keep the walk's answer, so the command declines it as before.
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
  reason?: string,
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
    ...(reason ? { reason } : {}),
  });
}

function decompressedSizeOf(fs: LedgerCompactFs, entry: LedgerCorpusEntry, maxArchiveBytes: number): number {
  try {
    if (entry.form === "plain") {
      return fs.sizeOf ? fs.sizeOf(entry.path) : fs.readFileSync(entry.path).byteLength;
    }
    const trailerSize = fs.gzipTrailerSizeOf?.(entry.path);
    if (trailerSize !== undefined) return trailerSize;
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

function readCompactionBody(fs: LedgerCompactFs, entry: LedgerCorpusEntry, log: (line: string) => void): Buffer {
  const raw = fs.readFileSync(entry.path);
  if (entry.form === "plain") return raw;
  const trailerSize = raw.length >= GZIP_MIN_BYTES ? raw.readUInt32LE(raw.length - GZIP_ISIZE_BYTES) : undefined;
  const trailer = trailerSize === undefined ? "trailer unavailable" : `trailer ${trailerSize} bytes`;
  let body: Buffer;
  try {
    body = fs.gunzipSync(raw);
  } catch (err) {
    throw new Error(`${entry.path}: ${trailer}, inflated size unavailable — ${(err as Error)?.message ?? String(err)}`);
  }
  // Both ledger writers emit one member. The last member's size alone can undercount a hand-built archive.
  if (trailerSize !== body.byteLength) {
    log(`rmd ledger-compact: gzip size mismatch for ${entry.path} — ${trailer}, inflated ${body.byteLength} bytes`);
  }
  return body;
}

interface MeasuredArchive { size: number; mtimeMs: number; bytes: number; limit: number }

/**
 * W1-T13371: measured decompressed sizes, kept for the life of the process. In-process callers can reuse earlier
 * measurements. Nothing is written to the state dir: a pass that cannot reduce still writes nothing.
 */
const measuredArchives = new Map<string, MeasuredArchive>();

/**
 * W1-T13371: the oversized-repair probe gunzipped every merged archive on every pass. On the host (2026-11-17) that was
 * 79 archives of 45-65 MB, and passes of 9-183 s ran in the daemon cycle 42-48 times a day. A measurement is reused only
 * when the archive's path, compressed size and mtime are unchanged, and its byte count still answers the question at
 * this limit: exact when it was at or under the limit it was measured with, and only "over" otherwise.
 */
export function memoizedDecompressedSizeOf(fs: LedgerCompactFs, stateDir: string, names: readonly string[],
  measure: (entry: LedgerCorpusEntry, maxArchiveBytes: number) => number,
): (entry: LedgerCorpusEntry, maxArchiveBytes: number) => number {
  // Forget archives this state dir no longer holds, so the memo stays bounded by the corpus.
  const present = new Set(names.map((name) => join(stateDir, name)));
  for (const path of [...measuredArchives.keys()]) {
    if (dirname(path) === stateDir && !present.has(path)) measuredArchives.delete(path);
  }
  const identity = (path: string): { size: number; mtimeMs: number } | undefined => {
    if (!fs.sizeOf || !fs.mtimeMs) return undefined;
    try {
      return { size: fs.sizeOf(path), mtimeMs: fs.mtimeMs(path) };
    } catch {
      // deliberate: with no readable size and mtime there is no identity to match, so the caller measures again
      // and never trusts a remembered size; the read that follows reports a vanished archive in its own error.
      return undefined;
    }
  };
  return (entry, maxArchiveBytes) => {
    const id = identity(entry.path), seen = measuredArchives.get(entry.path);
    if (id && seen && seen.size === id.size && seen.mtimeMs === id.mtimeMs
      && (seen.bytes <= seen.limit || maxArchiveBytes <= seen.limit)) {
      return seen.bytes <= seen.limit ? seen.bytes : maxArchiveBytes + 1;
    }
    const bytes = measure(entry, maxArchiveBytes);
    if (id) measuredArchives.set(entry.path, { ...id, bytes: Math.min(bytes, maxArchiveBytes + 1), limit: maxArchiveBytes });
    else measuredArchives.delete(entry.path);
    return bytes;
  };
}

/** W1-T13371: an archive this process wrote is measured again, whatever its size and mtime now read. */
export function forgetMeasuredArchive(path: string): void {
  measuredArchives.delete(path);
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

  const mode = rest.includes("--dry-run") ? "dry-run" : "apply";
  const window: CompactWindow = { mode, olderThanDays, maxSources, maxArchiveBytes, stateDir, fs, now: (deps.clock ?? systemClock).date(), out, log };
  // W1-T13859: hold the rotation lock for a stable archive inventory, including while retiring sources.
  if (mode === "dry-run" || !fs.rotationLock || deps.rotationLockHeld) return compactWindow(window);
  const lock = takeCompactionRotationLock(stateDir, fs.rotationLock);
  if ("refused" in lock) {
    log(lock.refused);
    return 1;
  }
  try {
    return compactWindow(window);
  } finally {
    lock.release();
  }
}

/**
 * W1-T13859: take the ledger rotation lock for one compaction pass. The daemon's worker parent takes it on
 * the main thread, so a worker that is ended from outside cannot leave it held under a live pid.
 */
export function takeCompactionRotationLock(
  stateDir: string,
  take: (lockPath: string) => (() => void) | null = tryAcquireRotationLock,
): { release: () => void } | { refused: string } {
  let release: (() => void) | null;
  try {
    release = take(ledgerRotationLockPath(ledgerLivePath(stateDir)));
  } catch (err) {
    return { refused: `rmd ledger-compact: cannot take the ledger rotation lock in ${stateDir} — ${(err as Error)?.message ?? String(err)}` };
  }
  return release === null
    ? { refused: "rmd ledger-compact: a ledger rotation or a complete-ledger read holds the rotation lock; nothing was compacted" }
    : { release };
}

interface CompactWindow {
  mode: "dry-run" | "apply";
  olderThanDays: number;
  maxSources: number;
  maxArchiveBytes: number;
  stateDir: string;
  fs: LedgerCompactFs;
  now: Date;
  out: (line: string) => void;
  log: (line: string) => void;
}

function compactWindow({ mode, olderThanDays, maxSources, maxArchiveBytes, stateDir, fs, now, out, log }: CompactWindow): number {
  let selection: LedgerCompactSelection;
  try {
    const names = fs.readdirSync(stateDir);
    selection = selectLedgerCompactionSources(
      names,
      stateDir,
      olderThanDays,
      maxSources,
      now,
      fs.sizeOf,
      memoizedDecompressedSizeOf(fs, stateDir, names, (entry, limit) => decompressedSizeOf(fs, entry, limit)),
      maxArchiveBytes,
    );
  } catch (err) {
    log(`rmd ledger-compact: cannot list or size eligible archives in ${stateDir} — ${(err as Error)?.message ?? String(err)}`);
    return 1;
  }

  const entryByPath = new Map<string, LedgerCorpusEntry>();
  for (const entry of selection.sources) entryByPath.set(entry.path, entry);
  const stagedPaths = new Set<string>();
  const staged: StagedArchive[] = [];
  // A source can contain rows assigned to several outputs. Keep it readable until all are published.
  const available = (path: string) => !entryByPath.has(path) && !stagedPaths.has(path) && !fs.existsSync(path);
  // Windowed readers need a parseable timestamp at or after every row in the output.
  const laterUnusedName = (name: string): string => {
    let stamp = Date.parse(rotationStampIso(name)!);
    do {
      name = compactedArchiveName(fixedClock(++stamp).iso());
    } while (!available(join(stateDir, name)));
    return name;
  };
  const canonicalOutputName = (name: string): string | undefined => {
    const path = join(stateDir, name);
    if (available(path)) return name;
    // W1-T13859: an output keeps the name of the selected source it collides with, and replaces it once every
    // other output holding that source's rows is published. A stamp past the newest source reads, to an
    // analytics checkpoint that already folded that source, as unread rows, and they were counted twice.
    if (entryByPath.has(path) && !stagedPaths.has(path)) return name;
    if (!stagedPaths.has(path)) return undefined;
    return laterUnusedName(name);
  };
  const sourceLines = new Map<string, string[]>();
  let result: LedgerCompactionResult;
  try {
    result = compactRotations(selection.sources.map((entry) => entry.path), {
      readRows: (path) => {
        const entry = entryByPath.get(path);
        if (!entry) throw new Error(`selected source disappeared from the manifest: ${path}`);
        const body = readCompactionBody(fs, entry, log);
        const lines = body.toString("utf8").split("\n");
        // Kept to order a replacement after the outputs holding this source's rows, without a second read.
        sourceLines.set(path, lines);
        return lines;
      },
      write: (name, body) => {
        const parts = splitArchiveBody(body, maxArchiveBytes);
        parts.forEach((partBody, index) => {
          let outputName = index === parts.length - 1 ? canonicalOutputName(name) : undefined;
          const timedName = outputName === undefined ? archiveNameForChunk(name, partBody) : undefined;
          if (timedName && timedName !== name) outputName = canonicalOutputName(timedName);
          if (outputName === undefined) {
            let part = index + 1;
            do {
              outputName = archivePartName(name, part++);
            } while (!available(join(stateDir, outputName)));
          }
          const outputPath = join(stateDir, outputName);
          stagedPaths.add(outputPath);
          staged.push({ name: outputName, body: partBody, ...(entryByPath.has(outputPath) ? { replaces: outputPath } : {}) });
        });
      },
      clock: fixedClock(now.getTime()),
    });
  } catch (err) {
    log(`rmd ledger-compact: cannot read the selected window — ${(err as Error)?.message ?? String(err)}`);
    return 1;
  }
  const publishOrder = orderPublications(staged, (path) => sourceLines.get(path) ?? [], (entry) => {
    stagedPaths.delete(entry.replaces!);
    entry.name = laterUnusedName(entry.name);
    stagedPaths.add(join(stateDir, entry.name));
    delete entry.replaces;
  });
  sourceLines.clear();
  if (staged.length > 0) {
    // Report the actual per-day pieces (including collision-safe part names), not compactRotations'
    // unsplit base names.
    result = { ...result, archiveName: staged.at(-1)!.name, archiveNames: staged.map((entry) => entry.name) };
  }
  let reason: string | undefined;
  if (staged.length > 0 && staged.length >= selection.sources.length) {
    reason = `no-reduction — ${selection.sources.length} source archive(s) would produce ${staged.length} archive(s)`;
    // compactRotations has partitioned the rows; these are the actual outputs, including byte splits.
    // Decline before atomic writes or cold storage so source bytes and mtimes stay untouched.
    staged.length = 0;
    result = { sourceCount: 0, rowsWritten: 0, duplicatesCollapsed: 0, archiveName: "", archiveNames: [] };
  }

  const report = reportFor(
    mode,
    olderThanDays,
    maxSources,
    selection.eligibleCount,
    selection.unparseableAge.length,
    result,
    selection.sizeSkippedCount,
    reason,
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
  for (const { name, replaces } of staged) {
    const targetPath = join(stateDir, name);
    if (replaces === undefined && fs.existsSync(targetPath)) {
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
    // W1-T13333: a daemon pass runs beside the live daemon. Compress first, then check each name again, so an
    // archive that landed on an output name during the slow compression is refused, never replaced.
    const packed = publishOrder.map(({ name, body, replaces }) =>
      ({ targetPath: join(stateDir, name), replaces, bytes: fs.gzipSync(Buffer.from(body, "utf8")) }));
    const landed = packed.find(({ targetPath, replaces }) => replaces === undefined && fs.existsSync(targetPath));
    if (landed) throw new Error(`refusing to overwrite unselected archive ${landed.targetPath}`);
    for (const { targetPath, replaces, bytes } of packed) {
      forgetMeasuredArchive(targetPath);
      if (replaces !== undefined) coldCopy(fs, stateDir, replaces, now.getTime());
      const publish = replaces === undefined ? fs.writeAtomic : (fs.replaceAtomic ?? fs.writeAtomic);
      if (!publish(targetPath, bytes)) {
        throw new Error(`atomic replacement withdrew before rename: ${targetPath}`);
      }
    }
    const replaced = new Set(packed.flatMap(({ replaces }) => replaces ?? []));
    coldStore(fs, stateDir, [...entryByPath.keys()].filter((path) => !replaced.has(path)), now.getTime(), log);
  } catch (err) {
    log(`rmd ledger-compact: apply failed — ${(err as Error)?.message ?? String(err)}`);
    return 1;
  }
  out(report);
  return 0;
}

interface StagedArchive {
  name: string;
  body: string;
  /** The selected source this output replaces in place, keeping its name. */
  replaces?: string;
}

/**
 * W1-T13859: the order that keeps every row readable if a pass stops after any publication. New names go
 * first. An output that replaces a source goes only after every other output holding that source's rows; when
 * replacements wait on each other, one takes a later unused name instead (`rename`), as it did before.
 */
function orderPublications(
  staged: StagedArchive[],
  sourceLines: (path: string) => string[],
  rename: (entry: StagedArchive) => void,
): StagedArchive[] {
  const pending = staged.filter((entry) => entry.replaces !== undefined);
  if (pending.length === 0) return staged;
  const bodies = new Map(staged.map((entry) => [entry, new Set(entry.body.split("\n").filter((line) => line !== ""))]));
  const needs = new Map<StagedArchive, Set<StagedArchive>>();
  for (const entry of pending) {
    const lines = sourceLines(entry.replaces!).map((line) => line.trim()).filter((line) => line !== "");
    needs.set(entry, new Set(staged.filter((other) => other !== entry && lines.some((line) => bodies.get(other)!.has(line)))));
  }
  const order = staged.filter((entry) => entry.replaces === undefined);
  while (pending.length > 0) {
    const ready = pending.findIndex((entry) => [...needs.get(entry)!].every((other) => !pending.includes(other)));
    const [next] = pending.splice(ready === -1 ? 0 : ready, 1);
    if (ready === -1) rename(next!);
    order.push(next!);
  }
  return order;
}

/** W1-T13859: keep a replaced source recoverable in cold storage, as a moved one is. */
function coldCopy(fs: LedgerCompactFs, stateDir: string, path: string, nowMs: number): void {
  const { mkdirSync: mkdir, renameSync: rename, touch, mtimeMs } = fs;
  if (!mkdir || !rename || !touch || !mtimeMs) return;
  const coldDir = join(stateDir, LEDGER_COLD_STORE_DIRNAME);
  mkdir(coldDir);
  const target = coldTarget(fs, coldDir, path);
  if (fs.copyFileSync) fs.copyFileSync(path, target);
  else if (!fs.writeAtomic(target, fs.readFileSync(path))) throw new Error(`cannot copy ${path} into cold storage`);
  touch(target, nowMs);
}

function coldTarget(fs: LedgerCompactFs, coldDir: string, path: string): string {
  const original = join(coldDir, basename(path));
  let target = original;
  for (let copy = 1; fs.existsSync(target); copy += 1) target = `${original}.${copy}`;
  return target;
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
    const target = coldTarget(fs, coldDir, path);
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
