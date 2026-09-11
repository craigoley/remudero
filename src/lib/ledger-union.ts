import { createReadStream as nodeCreateReadStream, existsSync as nodeExistsSync, readFileSync as nodeReadFileSync, readdirSync as nodeReaddirSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { addAbortSignal, type Readable } from "node:stream";
import { createGunzip, gunzipSync as nodeGunzipSync } from "node:zlib";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { NEVER_ROTATE_FILENAME } from "./log-rotation.js";

export interface LedgerGrepFsDeps {
  readdirSync: (dir: string) => string[];
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => Buffer;
  gunzipSync: (buf: Buffer) => Buffer;
}

const realLedgerFs: LedgerGrepFsDeps = {
  readdirSync: (dir) => nodeReaddirSync(dir),
  existsSync: (path) => nodeExistsSync(path),
  readFileSync: (path) => nodeReadFileSync(path),
  gunzipSync: (buf) => nodeGunzipSync(buf),
};

export interface LedgerUnionResult {
  stateDir: string;
  archiveFiles: string[];
  archiveCount: number;
  liveFileRead: boolean;
  unread: string[];
  unclassified?: string[];
  ok: boolean;
  matches: string[];
}

export interface LedgerUnionOptions {
  since?: string;
  sinceTs?: string;
  step?: string | readonly string[];
}

export type LedgerFileForm = "gzip" | "plain";

export interface LedgerCorpusEntry {
  path: string;
  form: LedgerFileForm;
}

export function ledgerLivePath(stateDir: string): string {
  return join(stateDir, LEDGER_FILENAME);
}

export function ledgerRotationEntries(names: string[], stateDir: string): LedgerCorpusEntry[] {
  return names
    .filter((n) => n.startsWith("ledger.") && n !== NEVER_ROTATE_FILENAME)
    .map((n): LedgerCorpusEntry | undefined => {
      if (n.endsWith(".ndjson.gz")) return { path: join(stateDir, n), form: "gzip" };
      if (n.endsWith(".ndjson")) return { path: join(stateDir, n), form: "plain" };
      return undefined;
    })
    .filter((e): e is LedgerCorpusEntry => e !== undefined)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function rotationStampIso(name: string): string | undefined {
  const m = /^ledger\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.ndjson(?:\.gz)?$/.exec(name);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : undefined;
}

const MAX_PATTERN_LENGTH = 200;

function sanitizeRegExp(pattern: string): string {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`rmd ledger-grep: pattern too long (${pattern.length} chars, max ${MAX_PATTERN_LENGTH})`);
  }
  if (/\([^()]*[+*][^()]*\)[+*]/.test(pattern)) {
    throw new Error(
      "rmd ledger-grep: pattern rejected — nested quantifiers like (a+)+ can cause catastrophic backtracking",
    );
  }
  return pattern;
}

function listedLedgerFiles(stateDir: string, fsDeps: Pick<LedgerGrepFsDeps, "readdirSync">): { rotations: LedgerCorpusEntry[]; unclassified: string[] } {
  let names: string[];
  try {
    names = fsDeps.readdirSync(stateDir);
  } catch {
    // deliberate: an absent or unreadable state directory is an empty corpus for best-effort readers.
    names = [];
  }
  const rotations = ledgerRotationEntries(names, stateDir);
  const rotationPaths = new Set(rotations.map((e) => e.path));
  const unclassified = names
    .filter((n) => n.startsWith("ledger.") && n !== NEVER_ROTATE_FILENAME)
    .map((n) => join(stateDir, n))
    .filter((p) => !rotationPaths.has(p));
  return { rotations, unclassified };
}

function sinceMs(opts: LedgerUnionOptions): number | undefined {
  const raw = opts.sinceTs ?? opts.since;
  if (raw === undefined) return undefined;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function rotationBeforeWindow(entry: LedgerCorpusEntry, minimumTs: number | undefined): boolean {
  if (minimumTs === undefined) return false;
  const stamp = rotationStampIso(basename(entry.path));
  if (stamp === undefined) return false;
  const stampMs = Date.parse(stamp);
  return !Number.isNaN(stampMs) && stampMs < minimumTs;
}

function recordMatchesFilters(row: Record<string, unknown>, opts: LedgerUnionOptions, minimumTs: number | undefined): boolean {
  if (minimumTs !== undefined) {
    const ts = row.ts;
    if (typeof ts !== "string" || Date.parse(ts) < minimumTs) return false;
  }
  if (opts.step !== undefined) {
    const step = row.step;
    if (typeof step !== "string") return false;
    if (typeof opts.step === "string") {
      if (step !== opts.step) return false;
    } else if (!opts.step.includes(step)) {
      return false;
    }
  }
  return true;
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  const parsed: unknown = JSON.parse(raw);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

export interface OpenLedgerUnionOptions extends LedgerUnionOptions {
  dedupe?: boolean;
  /** Cancels the active source and refuses to open a later rotation. An abort is never swallowed
   * by the best-effort corrupt-file boundary below. */
  signal?: AbortSignal;
  /**
   * Bound exact-line replay dedupe to the newest N distinct rows per `step`. This is the streaming
   * counterpart to `rotateLedger` retaining its newest N rows per step: an archived row can only
   * reappear in a later rotation while it remains inside that producer-side window. Callers must
   * pass the producer's exact retention width; this is not a general replacement for whole-corpus
   * dedupe over an arbitrary collection of files.
   */
  dedupeWindowPerStep?: number;
}

/** Stream-opening I/O. The third argument to {@link openLedgerUnion} exists so its cancellation
 * contract can prove the active readable was destroyed and no later file opened. */
export interface LedgerUnionStreamIO {
  readdirSync: (dir: string) => string[];
  existsSync: (path: string) => boolean;
  createReadStream: (path: string) => Readable;
}

const realLedgerUnionStreamIO: LedgerUnionStreamIO = {
  readdirSync: (dir) => nodeReaddirSync(dir),
  existsSync: (path) => nodeExistsSync(path),
  createReadStream: (path) => nodeCreateReadStream(path),
};

export async function* openLedgerUnion(
  stateDir: string,
  opts: OpenLedgerUnionOptions = {},
  io: LedgerUnionStreamIO = realLedgerUnionStreamIO,
): AsyncGenerator<Record<string, unknown>> {
  if (
    opts.dedupeWindowPerStep !== undefined &&
    (!Number.isInteger(opts.dedupeWindowPerStep) || opts.dedupeWindowPerStep < 1)
  ) {
    throw new TypeError(`openLedgerUnion: dedupeWindowPerStep must be a positive integer, got ${String(opts.dedupeWindowPerStep)}`);
  }
  if (opts.dedupe === false && opts.dedupeWindowPerStep !== undefined) {
    throw new TypeError("openLedgerUnion: dedupe=false and dedupeWindowPerStep are contradictory");
  }
  const { rotations } = listedLedgerFiles(stateDir, io);
  const livePath = ledgerLivePath(stateDir);
  const entries = [...rotations, { path: livePath, form: "plain" as const }];
  const seen = new Set<string>();
  const recentByStep = new Map<string, { order: string[]; next: number; seen: Set<string> }>();
  const minimumTs = sinceMs(opts);

  const replayedInsideWindow = (step: string, line: string): boolean => {
    const limit = opts.dedupeWindowPerStep;
    if (limit === undefined) return false;
    const recent = recentByStep.get(step) ?? { order: [], next: 0, seen: new Set<string>() };
    if (recent.seen.has(line)) return true;
    recent.seen.add(line);
    if (recent.order.length < limit) {
      recent.order.push(line);
    } else {
      const evicted = recent.order[recent.next];
      if (evicted !== undefined) recent.seen.delete(evicted);
      recent.order[recent.next] = line;
      recent.next = (recent.next + 1) % limit;
    }
    recentByStep.set(step, recent);
    return false;
  };

  for (const entry of entries) {
    opts.signal?.throwIfAborted();
    if (entry.path === livePath && !io.existsSync(entry.path)) continue;
    if (rotationBeforeWindow(entry, minimumTs)) continue;
    const source = io.createReadStream(entry.path);
    const gunzip = entry.form === "gzip" ? createGunzip() : undefined;
    const input = gunzip ? source.pipe(gunzip) : source;
    if (opts.signal) {
      addAbortSignal(opts.signal, source);
      if (gunzip) addAbortSignal(opts.signal, gunzip);
    }
    const rl = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const raw of rl) {
        opts.signal?.throwIfAborted();
        const line = String(raw).trim();
        if (!line) continue;
        if (opts.dedupe !== false && opts.dedupeWindowPerStep === undefined) {
          if (seen.has(line)) continue;
          seen.add(line);
        }
        let parsed: Record<string, unknown> | undefined;
        try {
          parsed = parseObject(line);
        } catch {
          // deliberate: a torn ledger line is dropped without aborting the stream.
          continue;
        }
        if (parsed === undefined || !recordMatchesFilters(parsed, opts, minimumTs)) continue;
        const step = typeof parsed.step === "string" ? parsed.step : "";
        if (replayedInsideWindow(step, line)) continue;
        yield parsed;
      }
    } catch (error) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? error;
      // deliberate: an unreadable file costs that file, not the whole best-effort stream.
      // Console-style readers are best effort; audit-style refusal is handled by resolveLedgerUnion.
    } finally {
      // Explicit ownership rather than relying only on async-iterator return semantics: timeout,
      // server close and stale-code exit all need the active descriptor/gunzip/readline released
      // before this generator can settle and before another rotation can open.
      rl.close();
      input.destroy();
      gunzip?.destroy();
      source.destroy();
    }
  }
}

export async function readLedgerUnionRecords(
  stateDir: string,
  opts: OpenLedgerUnionOptions = {},
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for await (const row of openLedgerUnion(stateDir, opts)) rows.push(row);
  return rows;
}

export interface LedgerUnionRawReadOptions extends LedgerUnionOptions {
  order?: "oldest-first" | "newest-first";
  liveFirst?: boolean;
  maxRotations?: number;
  pattern?: RegExp;
  dedupe?: boolean;
  requireArchives?: boolean;
  refuseIncomplete?: boolean;
}

export interface LedgerUnionRawRead {
  stateDir: string;
  archiveFiles: string[];
  archiveCount: number;
  liveFileRead: boolean;
  unread: string[];
  unclassified: string[];
  ok: boolean;
  rawLines: string[];
  filesRead: number;
}

function orderedEntries(rotations: LedgerCorpusEntry[], opts: LedgerUnionRawReadOptions): LedgerCorpusEntry[] {
  const ordered = opts.order === "newest-first"
    ? [...rotations].sort((a, b) => (a.path < b.path ? 1 : a.path > b.path ? -1 : 0))
    : rotations;
  return opts.maxRotations === undefined ? ordered : ordered.slice(0, opts.maxRotations);
}

export function readLedgerUnionRawLinesSync(
  stateDir: string,
  opts: LedgerUnionRawReadOptions = {},
  fsDeps: LedgerGrepFsDeps = realLedgerFs,
): LedgerUnionRawRead {
  const { rotations, unclassified } = listedLedgerFiles(stateDir, fsDeps);
  const archiveFiles = rotations.map((e) => e.path);
  const livePath = ledgerLivePath(stateDir);
  const liveFileRead = fsDeps.existsSync(livePath);
  const minimumTs = sinceMs(opts);
  const seen = new Set<string>();
  const rawLines: string[] = [];
  const unread: string[] = [];
  let filesRead = 0;

  // W1-T3335 — SCANNED, NOT SPLIT. This decoded each corpus file into one JS string and then
  // `split("\n")` it into an array of every line in that file. MEASURED on the live corpus
  // (919 files, 3.84 GB decompressed), one call each through resolveLedgerUnion:
  //
  //   sweep uncreditable-head   +585 MB    323 matches
  //   followup harvest        +3,804 MB  6,485 matches
  //   credit timestamps       +3,846 MB 24,611 matches
  //   authority table         +5,470 MB  9,115 matches
  //
  // Four callers, ~13.7 GB against an 8 GB heap cap — the daemon's abort. The first row is the
  // tell: 323 retained lines still cost 585 MB, so the driver is the per-file whole-string plus
  // split array, NOT what is kept. Scanning holds one file's decompressed buffer at a time.
  //
  // `buf.toString("utf8", start, end)` already yields an OWNED string, so the round-trip through
  // `Buffer.from(line)` that used to sever slice-retention here is no longer needed.
  const addBuffer = (buf: Buffer): void => {
    let start = 0;
    while (start < buf.length) {
      let end = buf.indexOf(0x0a, start);
      if (end === -1) end = buf.length;
      if (end > start) {
        const line = buf.toString("utf8", start, end).trim();
        if (line && (!opts.pattern || opts.pattern.test(line))) {
          if (opts.dedupe === false) {
            rawLines.push(line);
          } else if (!seen.has(line)) {
            seen.add(line);
            rawLines.push(line);
          }
        }
      }
      start = end + 1;
    }
  };

  const readEntry = (entry: LedgerCorpusEntry): void => {
    if (rotationBeforeWindow(entry, minimumTs)) return;
    try {
      const buf = fsDeps.readFileSync(entry.path);
      filesRead += 1;
      addBuffer(entry.form === "gzip" ? fsDeps.gunzipSync(buf) : buf);
    } catch {
      // deliberate: archive read failures are reported through unread rather than thrown.
      unread.push(entry.path);
    }
  };

  const readLive = (): void => {
    if (!liveFileRead) return;
    try {
      filesRead += 1;
      addBuffer(fsDeps.readFileSync(livePath));
    } catch {
      // deliberate: an unreadable live file is not an unread rotation and does not make the archive corpus partial.
      // Best-effort live read, matching the prior union readers' behavior.
    }
  };

  if (opts.requireArchives && archiveFiles.length === 0) {
    return { stateDir, archiveFiles, archiveCount: 0, liveFileRead, unread, unclassified, ok: false, rawLines: [], filesRead };
  }

  const rotationsToRead = orderedEntries(rotations, opts);
  if (opts.liveFirst) readLive();
  for (const entry of rotationsToRead) readEntry(entry);
  if (!opts.liveFirst) readLive();

  const ok = !(opts.refuseIncomplete && unread.length > 0);
  return {
    stateDir,
    archiveFiles,
    archiveCount: archiveFiles.length,
    liveFileRead,
    unread,
    unclassified,
    ok,
    rawLines: ok ? rawLines : [],
    filesRead,
  };
}

export interface LedgerUnionRecordReadOptions extends LedgerUnionRawReadOptions {
  readLiveRecords?: (path: string) => Iterable<Record<string, unknown>>;
  onRecord?: (row: Record<string, unknown>) => void;
  satisfied?: (stepsSeen: ReadonlySet<string>) => boolean;
}

export interface LedgerUnionRecordRead extends Omit<LedgerUnionRawRead, "rawLines"> {
  rows: Array<Record<string, unknown>>;
  torn: number;
}

export function readLedgerUnionRecordsSync(
  stateDir: string,
  opts: LedgerUnionRecordReadOptions = {},
  fsDeps: LedgerGrepFsDeps = realLedgerFs,
): LedgerUnionRecordRead {
  const { rotations, unclassified } = listedLedgerFiles(stateDir, fsDeps);
  const archiveFiles = rotations.map((e) => e.path);
  const livePath = ledgerLivePath(stateDir);
  const liveFileRead = opts.readLiveRecords !== undefined ? true : fsDeps.existsSync(livePath);
  const minimumTs = sinceMs(opts);
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  const unread: string[] = [];
  const stepsSeen = new Set<string>();
  let torn = 0;
  let filesRead = 0;

  const addRecord = (row: Record<string, unknown>, raw: string): void => {
    if (!recordMatchesFilters(row, opts, minimumTs)) return;
    if (opts.dedupe !== false) {
      if (seen.has(raw)) return;
      seen.add(raw);
    }
    opts.onRecord?.(row);
    rows.push(row);
    if (typeof row.step === "string") stepsSeen.add(row.step);
  };

  // W1-T3335 — SCANNED, NOT SPLIT. This decoded each corpus file into one JS string and then
  // `split("\n")` it into an array of every line in that file. MEASURED on the live corpus
  // (919 files, 3.84 GB decompressed), one call each through resolveLedgerUnion:
  //
  //   sweep uncreditable-head   +585 MB    323 matches
  //   followup harvest        +3,804 MB  6,485 matches
  //   credit timestamps       +3,846 MB 24,611 matches
  //   authority table         +5,470 MB  9,115 matches
  //
  // Four callers, ~13.7 GB against an 8 GB heap cap — the daemon's abort. The first row is the
  // tell: 323 retained lines still cost 585 MB, so the driver is the per-file whole-string plus
  // split array, NOT what is kept. Scanning holds one file's decompressed buffer at a time.
  const addBuffer = (buf: Buffer): void => {
    let start = 0;
    while (start < buf.length) {
      let end = buf.indexOf(0x0a, start);
      if (end === -1) end = buf.length;
      if (end > start) {
        const line = buf.toString("utf8", start, end).trim();
        if (line && (!opts.pattern || opts.pattern.test(line))) {
          try {
            const parsed = parseObject(line);
            if (parsed !== undefined) addRecord(parsed, line);
          } catch {
            // deliberate: a malformed row increments torn and the remaining corpus still parses.
            torn += 1;
          }
        }
      }
      start = end + 1;
    }
  };

  const readLive = (): boolean => {
    if (opts.readLiveRecords !== undefined) {
      filesRead += 1;
      for (const row of opts.readLiveRecords(livePath)) {
        addRecord(row, JSON.stringify(row));
      }
      return opts.satisfied?.(stepsSeen) ?? false;
    }
    if (!liveFileRead) return false;
    try {
      filesRead += 1;
      addBuffer(fsDeps.readFileSync(livePath));
      return opts.satisfied?.(stepsSeen) ?? false;
    } catch {
      // deliberate: an unreadable live file degrades to whatever rotations already supplied.
      return false;
    }
  };

  const readEntry = (entry: LedgerCorpusEntry): boolean => {
    if (rotationBeforeWindow(entry, minimumTs)) return false;
    try {
      const buf = fsDeps.readFileSync(entry.path);
      filesRead += 1;
      addBuffer(entry.form === "gzip" ? fsDeps.gunzipSync(buf) : buf);
      return opts.satisfied?.(stepsSeen) ?? false;
    } catch {
      // deliberate: archive read failures are surfaced in unread for callers that refuse partial coverage.
      unread.push(entry.path);
      return false;
    }
  };

  if (opts.requireArchives && archiveFiles.length === 0) {
    return { stateDir, archiveFiles, archiveCount: 0, liveFileRead, unread, unclassified, ok: false, rows: [], torn, filesRead };
  }

  const rotationsToRead = orderedEntries(rotations, opts);
  let stopped = opts.liveFirst ? readLive() : false;
  for (const entry of rotationsToRead) {
    if (stopped) break;
    stopped = readEntry(entry);
  }
  if (!opts.liveFirst && !stopped) readLive();

  const ok = !(opts.refuseIncomplete && unread.length > 0);
  return {
    stateDir,
    archiveFiles,
    archiveCount: archiveFiles.length,
    liveFileRead,
    unread,
    unclassified,
    ok,
    rows: ok ? rows : [],
    torn,
    filesRead,
  };
}

export function resolveLedgerUnion(
  stateDir: string,
  pattern: string | RegExp,
  fsDeps: LedgerGrepFsDeps = realLedgerFs,
  opts: LedgerUnionOptions = {},
): LedgerUnionResult {
  const re = pattern instanceof RegExp ? pattern : new RegExp(sanitizeRegExp(pattern));
  const read = readLedgerUnionRawLinesSync(
    stateDir,
    { ...opts, pattern: re, requireArchives: true, refuseIncomplete: true },
    fsDeps,
  );
  return {
    stateDir: read.stateDir,
    archiveFiles: read.archiveFiles,
    archiveCount: read.archiveCount,
    liveFileRead: read.liveFileRead,
    unread: read.unread,
    unclassified: read.unclassified,
    ok: read.ok,
    matches: read.rawLines,
  };
}
