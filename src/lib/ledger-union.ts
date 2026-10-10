import { closeSync as nodeCloseSync, createReadStream as nodeCreateReadStream, existsSync as nodeExistsSync, fstatSync, mkdirSync as nodeMkdirSync, openSync as nodeOpenSync, readFileSync as nodeReadFileSync, readSync as nodeReadSync, readdirSync as nodeReaddirSync, renameSync as nodeRenameSync, statSync as nodeStatSync, unlinkSync as nodeUnlinkSync, writeFileSync as nodeWriteFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { isMainThread, parentPort, threadId, Worker, workerData, type MessagePort } from "node:worker_threads";
import { addAbortSignal, type Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { pipeline } from "node:stream/promises";
import { mkdir as nodeMkdir, readFile as nodeReadFile, readdir as nodeReaddir, rename as nodeRename, unlink as nodeUnlink, writeFile as nodeWriteFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createGunzip, gunzip as nodeGunzip, gunzipSync as nodeGunzipSync } from "node:zlib";
import {
  LEDGER_CARRIED_PREFIX_SUFFIX,
  LEDGER_FILENAME,
  LEDGER_RETAINED_STEPS_SUFFIX,
  LEDGER_ROTATION_LOCK_SUFFIX,
  LEDGER_STAGE_TAGS,
} from "./ledger-path.js";
import { NEVER_ROTATE_FILENAME } from "./log-rotation.js";

const gunzipAsync = promisify(nodeGunzip);

/**
 * NDJSON rows from a byte stream, split on LF only (a CR before it is dropped). `node:readline` was
 * the splitter here, but from Node 24 it also breaks lines on U+2028 and U+2029, which JSON leaves
 * unescaped, so a valid row carrying either character read as two damaged ones and was dropped from
 * every union read. The decoder keeps a multi-byte character whole across a chunk boundary.
 */
export async function* ndjsonLines(input: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const line = (text: string): string => (text.endsWith("\r") ? text.slice(0, -1) : text);
  for await (const chunk of input) {
    pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let start = 0;
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n", start)) {
      yield line(pending.slice(start, newline));
      start = newline + 1;
    }
    pending = pending.slice(start);
  }
  pending += decoder.end();
  if (pending) yield line(pending);
}

export interface LedgerGrepFsDeps {
  readdirSync: (dir: string) => string[];
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => Buffer;
  gunzipSync: (buf: Buffer) => Buffer;
  /** Only {@link createIncrementalLedgerUnion} reads these; omitted, it uses the real file system. */
  statSync?: (path: string) => { ino: number; size: number; mtimeMs: number };
  /** Bytes `[start, end)` of `path`, or fewer when the file is shorter. */
  readRangeSync?: (path: string, start: number, end: number) => Buffer;
}

function readRangeSync(path: string, start: number, end: number): Buffer {
  const fd = nodeOpenSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(Math.max(0, end - start));
    let at = 0;
    while (at < buf.length) {
      const read = nodeReadSync(fd, buf, at, buf.length - at, start + at);
      if (read === 0) break;
      at += read;
    }
    return buf.subarray(0, at);
  } finally {
    nodeCloseSync(fd);
  }
}

export const realLedgerFs: Required<LedgerGrepFsDeps> = {
  readdirSync: (dir) => nodeReaddirSync(dir),
  existsSync: (path) => nodeExistsSync(path),
  readFileSync: (path) => nodeReadFileSync(path),
  gunzipSync: (buf) => nodeGunzipSync(buf),
  statSync: (path) => nodeStatSync(path),
  readRangeSync,
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
  /** Record readers drop rows stamped earlier; the raw-line readers only skip rotations cut earlier. */
  since?: string;
  sinceTs?: string;
  /** Exact match on the row's `step` field ({@link stepMatches}), honoured by EVERY union reader (W1-T4710). */
  step?: string | readonly string[];
}

export type LedgerFileForm = "gzip" | "plain";

export interface LedgerMalformedRowFinding {
  path: string;
  form: LedgerFileForm | "live";
  rowOrdinal: number;
  kind: "invalid-json" | "non-object" | "live-torn-tail";
  resumeOffset?: number;
  /** Canonical leading ledger timestamp, when even a damaged row preserves it. Never raw text. */
  timestamp?: string;
  /** The damaged row's first readable `task_id`/`run_id` values: bounded id tokens, never raw text. */
  taskId?: string;
  runId?: string;
  /** Every distinct plan-task id (`W<n>-T<n>`) the damaged text names, so a per-task reader can
   * tell a row that could be its own from an unrelated one without seeing the text. */
  namedTaskIds?: string[];
}

export interface LedgerMalformedSource {
  path: string;
  form: LedgerFileForm;
  count: number;
  firstRowOrdinal: number;
  lastRowOrdinal: number;
}

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

const LEDGER_STAGE_SUFFIX = new RegExp(`\\.(?:${LEDGER_STAGE_TAGS.join("|")})-\\d+-[0-9a-f-]{36}$`);

// A rotation's own transient files: its lock, and `<ledger file>.<known tag>-<pid>-<uuid>` stages.
function isRotationOwnFile(name: string): boolean {
  if (name === `${LEDGER_FILENAME}${LEDGER_ROTATION_LOCK_SUFFIX}`) return true;
  const m = LEDGER_STAGE_SUFFIX.exec(name);
  if (!m) return false;
  const base = name.slice(0, m.index);
  return base === LEDGER_FILENAME || rotationStampIso(base) !== undefined;
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
    .filter((n) => n !== `${LEDGER_FILENAME}${LEDGER_CARRIED_PREFIX_SUFFIX}` && n !== `${LEDGER_FILENAME}${LEDGER_RETAINED_STEPS_SUFFIX}`)
    .filter((n) => !isRotationOwnFile(n))
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

function stepMatches(row: Record<string, unknown>, want: LedgerUnionOptions["step"]): boolean {
  if (want === undefined) return true;
  const step = row.step;
  if (typeof step !== "string") return false;
  return typeof want === "string" ? step === want : want.includes(step);
}

function recordMatchesFilters(row: Record<string, unknown>, opts: LedgerUnionOptions, minimumTs: number | undefined): boolean {
  if (minimumTs !== undefined) {
    const ts = row.ts;
    if (typeof ts !== "string" || Date.parse(ts) < minimumTs) return false;
  }
  return stepMatches(row, opts.step);
}

/** W1-T4710 — the raw-line form of {@link stepMatches}: a substring pre-check on the JSON-encoded
 *  step name rejects most lines unparsed, then the exact match decides. A torn line has no
 *  verifiable step, so it never survives a step filter. */
function rawLineStepFilter(want: LedgerUnionOptions["step"]): ((line: string) => boolean) | undefined {
  if (want === undefined) return undefined;
  const needles = (typeof want === "string" ? [want] : want).map((step) => JSON.stringify(step));
  return (line) => {
    if (!needles.some((needle) => line.includes(needle))) return false;
    try {
      const row = parseObject(line);
      return row !== undefined && stepMatches(row, want);
    } catch {
      // deliberate: an unparseable line cannot prove its step, so a step-filtered read excludes it.
      return false;
    }
  };
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  const parsed: unknown = JSON.parse(raw);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/** A damaged archive row can still carry a bounded timestamp if its canonical leading field
 * survived. Keep only this scalar, never the offending line. */
function damagedRowIdentity(line: string): Pick<LedgerMalformedRowFinding, "taskId" | "runId" | "namedTaskIds"> {
  const taskId = /"task_id":"([A-Za-z0-9._:-]{1,160})"/.exec(line)?.[1];
  const runId = /"run_id":"([A-Za-z0-9._:-]{1,160})"/.exec(line)?.[1];
  const named = [...new Set(line.match(/(?<![A-Za-z0-9])W\d+-T\d+/g) ?? [])].sort();
  return { ...(taskId ? { taskId } : {}), ...(runId ? { runId } : {}), ...(named.length ? { namedTaskIds: named } : {}) };
}

function leadingTimestamp(line: string): { timestamp?: string } {
  const match = /^\{"ts":"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)"/.exec(line);
  if (!match || !Number.isFinite(Date.parse(match[1])) || new Date(match[1]).toISOString() !== match[1]) return {};
  return { timestamp: match[1] };
}

/** Parses `buf`'s NDJSON lines from byte `start`, at most `maxLines` of them; `next` is where to resume. */
function scanLedgerBuffer(
  buf: Buffer,
  pattern: RegExp | undefined,
  onRow: (row: Record<string, unknown>, line: string) => void,
  start = 0,
  maxLines = Number.POSITIVE_INFINITY,
  onBad?: (line: string) => void,
  /** A line this answers true for is never parsed: an exact replay costs a Set lookup, not a JSON.parse. */
  skip?: (line: string) => boolean,
): { bad: number; next: number } {
  let bad = 0;
  let lines = 0;
  while (start < buf.length && lines < maxLines) {
    let end = buf.indexOf(0x0a, start);
    if (end === -1) end = buf.length;
    if (end > start) {
      lines += 1;
      const line = buf.toString("utf8", start, end).trim();
      if (line && (!pattern || pattern.test(line)) && !skip?.(line)) {
        try {
          const parsed = parseObject(line);
          if (parsed !== undefined) onRow(parsed, line);
        } catch {
          // deliberate: a malformed row increments torn and the remaining corpus still parses.
          bad += 1;
          onBad?.(line);
        }
      }
    }
    start = end + 1;
  }
  return { bad, next: start };
}

export interface OpenLedgerUnionOptions extends LedgerUnionOptions {
  dedupe?: boolean;
  /** Excludes the mutable live ledger from this scan. Archive-only audit readers use this so
   * callers can overlay the current live file at decision time instead of freezing it at boot. */
  includeLive?: boolean;
  /** Reports an unread ARCHIVE to an audit caller. The ordinary stream remains best-effort: it
   * yields every later readable source, while the caller decides whether partial history is safe
   * for its decision. A missing or unreadable live file is deliberately not reported here. */
  onUnreadArchive?: (path: string) => void;
  /** A live read failure is not an empty corpus to an audited projection. Ordinary readers may omit this. */
  onUnreadLive?: (path: string) => void;
  /** Metadata only: never pass the offending NDJSON text to an audit or public projection. */
  onMalformedRow?: (finding: LedgerMalformedRowFinding) => void;
  /** Called only for a row that survived the union's exact replay dedupe. The normalized raw
   * line lets a bounded audit projection seed a later live-file overlay without reserializing
   * JSON and changing its identity. Under a per-step window, `fingerprint` is the line's
   * {@link fingerprintLedgerLine}, the one the window kept: a caller that keeps lines past the row
   * keeps that, because the line pins the whole decoded chunk it was sliced from. */
  onAcceptedRecord?: (row: Record<string, unknown>, raw: string, fingerprint?: string) => void;
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
  /** Resume after an immutable rotation already represented by a checkpoint. */
  afterRotation?: string;
  /** Inclusive upper bound for archive enumeration; pair with afterRotation for one-source batches. */
  throughRotation?: string;
  /** Resume the mutable live ledger at a byte offset when it has only grown. */
  liveStartOffset?: number;
  /** Start one rotation at a DECOMPRESSED byte offset: the archive holding a rotated live file's unread tail. */
  rotationStartOffset?: { name: string; offset: number };
  /** After the live file is read whole: the inode read and the absolute offset its read ended at. */
  onLiveRead?: (read: { ino?: number; endOffset: number }) => void;
  /** Seed the bounded replay window without persisting raw ledger lines. */
  dedupeSeed?: readonly { step: string; fingerprint: string }[];
  /** Asked after each ROTATION is fully read (never the live file): true ends the stream there, so
   *  a caller with a time budget stops on a rotation boundary it can resume from via `afterRotation`. */
  stopAfterRotation?: (path: string) => boolean;
}

/** Bytes of `input` from `offset` on. */
async function* skipBytes(input: AsyncIterable<Buffer | string>, offset: number): AsyncGenerator<Buffer> {
  let skip = offset;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (skip >= bytes.length) {
      skip -= bytes.length;
      continue;
    }
    yield skip > 0 ? bytes.subarray(skip) : bytes;
    skip = 0;
  }
}

/** The sha256 of each DECOMPRESSED byte range of one ledger file, streamed; undefined where the file is shorter. */
export async function ledgerFileRangeDigests(
  path: string,
  form: LedgerFileForm,
  ranges: ReadonlyArray<{ start: number; end: number }>,
): Promise<Array<string | undefined>> {
  const hashes = ranges.map(() => createHash("sha256"));
  const last = Math.max(0, ...ranges.map((range) => range.end));
  let at = 0;
  const source = nodeCreateReadStream(path);
  const input: Readable = form === "gzip" ? source.pipe(createGunzip()) : source;
  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      ranges.forEach((range, index) => {
        const from = Math.max(range.start, at);
        const to = Math.min(range.end, at + chunk.length);
        if (from < to) hashes[index]!.update(chunk.subarray(from - at, to - at));
      });
      at += chunk.length;
      if (at >= last) break;
    }
  } finally {
    input.destroy();
    source.destroy();
  }
  return ranges.map((range, index) => (range.end <= at ? hashes[index]!.digest("hex") : undefined));
}

export function fingerprintLedgerLine(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Stream-opening I/O. The third argument to {@link openLedgerUnion} exists so its cancellation
 * contract can prove the active readable was destroyed and no later file opened. */
export interface LedgerUnionStreamIO {
  readdirSync: (dir: string) => string[];
  existsSync: (path: string) => boolean;
  createReadStream: (path: string, options?: { start?: number }) => Readable;
}

const realLedgerUnionStreamIO: LedgerUnionStreamIO = {
  readdirSync: (dir) => nodeReaddirSync(dir),
  existsSync: (path) => nodeExistsSync(path),
  createReadStream: (path, options) => nodeCreateReadStream(path, options),
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
  const resumedRotations = opts.afterRotation === undefined
    ? rotations
    : rotations.filter((entry) => basename(entry.path) > opts.afterRotation!);
  const selectedRotations = opts.throughRotation === undefined
    ? resumedRotations
    : resumedRotations.filter((entry) => basename(entry.path) <= opts.throughRotation!);
  const entries = opts.includeLive === false ? selectedRotations : [...selectedRotations, { path: livePath, form: "plain" as const }];
  const seen = new Set<string>();
  const recentByStep = new Map<string, { order: string[]; next: number; seen: Set<string> }>();
  if (opts.dedupeSeed !== undefined) {
    for (const seed of opts.dedupeSeed) {
      const recent = recentByStep.get(seed.step) ?? { order: [], next: 0, seen: new Set<string>() };
      if (recent.seen.has(seed.fingerprint)) continue;
      recent.seen.add(seed.fingerprint);
      if (recent.order.length < (opts.dedupeWindowPerStep ?? Number.MAX_SAFE_INTEGER)) recent.order.push(seed.fingerprint);
      else recent.order[recent.next] = seed.fingerprint;
      recentByStep.set(seed.step, recent);
    }
  }
  const minimumTs = sinceMs(opts);
  const stepNeedles = opts.step === undefined || opts.onMalformedRow !== undefined ? undefined
    : (typeof opts.step === "string" ? [opts.step] : opts.step).map((step) => JSON.stringify(step));

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
    let source: Readable | undefined;
    let gunzip: ReturnType<typeof createGunzip> | undefined;
    let input: Readable | undefined;
    let archiveUnread = false;
    let rowOrdinal = 0;
    let pendingLiveBad: LedgerMalformedRowFinding | undefined;
    let liveBytes = Math.max(0, opts.liveStartOffset ?? 0);
    let lastLineStartOffset = liveBytes;
    let lastLiveByte: number | undefined;
    let liveIno: number | undefined;
    try {
      const liveStartOffset = entry.path === livePath && opts.liveStartOffset !== undefined
        ? Math.max(0, opts.liveStartOffset)
        : undefined;
      source = io.createReadStream(
        entry.path,
        liveStartOffset === undefined ? undefined : { start: liveStartOffset },
      );
      if (entry.path === livePath) source.once("open", (fd: number) => { liveIno = fstatSync(fd).ino; });
      if (entry.path === livePath) source.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const newline = bytes.lastIndexOf(0x0a);
        if (newline >= 0) lastLineStartOffset = liveBytes + newline + 1;
        liveBytes += bytes.length;
        if (bytes.length > 0) lastLiveByte = bytes[bytes.length - 1];
      });
      // `error` is otherwise only observable through readline's async iterator. Keep this
      // explicit so an audited reader can refuse a partial archive corpus rather than treating
      // a silently skipped rotation as proof that old attempts never happened.
      source.once("error", () => {
        archiveUnread = true;
      });
      gunzip = entry.form === "gzip" ? createGunzip() : undefined;
      if (gunzip) gunzip.once("error", () => {
        archiveUnread = true;
      });
      input = gunzip ? source.pipe(gunzip) : source;
      if (opts.signal) {
        addAbortSignal(opts.signal, source);
        if (gunzip) addAbortSignal(opts.signal, gunzip);
      }
      const skip = opts.rotationStartOffset?.name === basename(entry.path) ? opts.rotationStartOffset.offset : 0;
      for await (const raw of ndjsonLines(skip > 0 ? skipBytes(input, skip) : input)) {
        opts.signal?.throwIfAborted();
        rowOrdinal += 1;
        if (pendingLiveBad) {
          opts.onMalformedRow?.(pendingLiveBad);
          pendingLiveBad = undefined;
        }
        const line = String(raw).trim();
        if (!line) continue;
        // A line naming no wanted step can neither be yielded nor (with no malformed-row audit) be reported,
        // so it is never parsed: a step-filtered stream parses its own rows, not the corpus.
        if (stepNeedles !== undefined && !stepNeedles.some((needle) => line.includes(needle))) continue;
        let parsed: Record<string, unknown> | undefined;
        let badKind: LedgerMalformedRowFinding["kind"] | undefined;
        try {
          parsed = parseObject(line);
        } catch {
          // The malformed-row callback below carries this failure as source-quality evidence;
          // later valid rows still need to be read from the same archive.
          badKind = "invalid-json";
        }
        if (parsed === undefined) {
          const finding: LedgerMalformedRowFinding = {
            path: entry.path,
            form: entry.path === livePath ? "live" : entry.form,
            rowOrdinal,
            kind: badKind ?? "non-object",
            ...(entry.path === livePath ? {} : leadingTimestamp(line)),
            ...damagedRowIdentity(line),
          };
          if (entry.path === livePath) pendingLiveBad = finding;
          else opts.onMalformedRow?.(finding);
          continue;
        }
        // Filter BEFORE dedupe: identical lines filter identically, so a row the filter drops never needs a
        // sighting, and the Set holds the stream's own rows rather than every line of the corpus.
        if (!recordMatchesFilters(parsed, opts, minimumTs)) continue;
        if (opts.dedupe !== false && opts.dedupeWindowPerStep === undefined) {
          if (seen.has(line)) continue;
          seen.add(line);
        }
        const step = typeof parsed.step === "string" ? parsed.step : "";
        const fingerprint = opts.dedupeWindowPerStep === undefined ? undefined : fingerprintLedgerLine(line);
        if (fingerprint !== undefined && replayedInsideWindow(step, fingerprint)) continue;
        opts.onAcceptedRecord?.(parsed, line, fingerprint);
        yield parsed;
      }
      if (pendingLiveBad) opts.onMalformedRow?.(lastLiveByte !== 0x0a
        ? { ...pendingLiveBad, kind: "live-torn-tail", resumeOffset: lastLineStartOffset }
        : pendingLiveBad);
      if (entry.path === livePath && !archiveUnread) opts.onLiveRead?.({ ino: liveIno, endOffset: liveBytes });
    } catch (error) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? error;
      // deliberate: an unreadable file costs that file, not the whole best-effort stream.
      // Console-style readers are best effort; audit-style refusal is handled by resolveLedgerUnion.
      archiveUnread = true;
    } finally {
      if (entry.path !== livePath && archiveUnread) opts.onUnreadArchive?.(entry.path);
      if (entry.path === livePath && archiveUnread) opts.onUnreadLive?.(entry.path);
      // Explicit ownership rather than relying only on async-iterator return semantics: timeout,
      // server close and stale-code exit all need the active descriptor and gunzip released before
      // this generator can settle and before another rotation can open.
      input?.destroy();
      gunzip?.destroy();
      source?.destroy();
    }
    if (entry.path !== livePath && opts.stopAfterRotation?.(entry.path)) return;
  }
}

/** Result of {@link auditLedgerUnion}. Unlike {@link openLedgerUnion}, this names every unread
 * archive and retains no corpus rows. It is for a decision that may only use rotated history when
 * the whole archive side was readable; its callback is the bounded projection. */
export interface AuditedLedgerUnionResult {
  stateDir: string;
  archiveFiles: string[];
  archiveCount: number;
  unread: string[];
  malformed: LedgerMalformedSource[];
  unclassified: string[];
  records: number;
  ok: boolean;
}

export interface AuditedLedgerUnionOptions extends LedgerUnionOptions {
  /** Required: exact replay dedupe must remain bounded to the producer retention width. */
  dedupeWindowPerStep: number;
  /** Opt in only for benchmark/public completeness. Operational history keeps its prior posture. */
  strictMalformed?: boolean;
  onRecord: (row: Record<string, unknown>, raw: string) => void;
}

/**
 * Stream every archive through a caller-owned bounded projection. The live file is intentionally
 * excluded: a long-lived decision gate overlays it freshly for each consultation, while the
 * immutable archive scan happens once at boot. An unread archive makes `ok` false even though
 * readable earlier files were offered to `onRecord`; callers MUST discard that partial projection.
 */
export async function auditLedgerUnion(
  stateDir: string,
  opts: AuditedLedgerUnionOptions,
  io: LedgerUnionStreamIO = realLedgerUnionStreamIO,
): Promise<AuditedLedgerUnionResult> {
  const { rotations, unclassified } = listedLedgerFiles(stateDir, io);
  const unread: string[] = [];
  const malformedByPath = new Map<string, LedgerMalformedSource>();
  let records = 0;
  if (rotations.length === 0) {
    return { stateDir, archiveFiles: [], archiveCount: 0, unread, malformed: [], unclassified, records, ok: false };
  }
  for await (const row of openLedgerUnion(
    stateDir,
    {
      ...opts,
      includeLive: false,
      onUnreadArchive: (path) => unread.push(path),
      onMalformedRow: (finding) => {
        if (finding.form === "live") return;
        const previous = malformedByPath.get(finding.path);
        if (previous) {
          previous.count += 1;
          previous.lastRowOrdinal = finding.rowOrdinal;
        } else {
          malformedByPath.set(finding.path, { path: finding.path, form: finding.form,
            count: 1, firstRowOrdinal: finding.rowOrdinal, lastRowOrdinal: finding.rowOrdinal });
        }
      },
      onAcceptedRecord: (accepted, raw) => {
        records += 1;
        opts.onRecord(accepted, raw);
      },
    },
    io,
  )) {
    // The callback above receives raw identity only after the union's dedupe accepts this row.
    // Keep consuming so its stream owns all file descriptors until the audit settles.
    void row;
  }
  return {
    stateDir,
    archiveFiles: rotations.map((entry) => entry.path),
    archiveCount: rotations.length,
    unread,
    malformed: [...malformedByPath.values()],
    unclassified,
    records,
    ok: unread.length === 0 && (!opts.strictMalformed || malformedByPath.size === 0),
  };
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
  /** Open only rotations stamped within this many ms of the NEWEST rotation's stamp. A rotation's
   *  stamp is when it was cut, so every row it holds is at or before it, and one stamped before the
   *  window holds nothing inside it. Anchored on the corpus, not the wall clock, so an idle host still
   *  reads its last week. Rows are NOT filtered: a retained row older than the window stays. */
  rotationWindowMs?: number;
  /** With {@link rotationWindowMs}: the newest this-many rotations are read even when stamped before the
   *  window — a FLOOR that only ever adds files, so a host rotating once a week keeps its last month. */
  minRotations?: number;
  pattern?: RegExp;
  /** Keeps only the lines it accepts, tested before dedupe, so a narrow caller retains only its own rows. */
  keep?: (line: string) => boolean;
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
  const windowed = opts.rotationWindowMs === undefined ? ordered : withinRotationWindow(ordered, opts.rotationWindowMs, opts.minRotations ?? 0);
  return opts.maxRotations === undefined ? windowed : windowed.slice(0, opts.maxRotations);
}

function stampMsOf(entry: LedgerCorpusEntry): number {
  const stamp = rotationStampIso(basename(entry.path));
  return stamp === undefined ? Number.NaN : Date.parse(stamp);
}

function withinRotationWindow(entries: LedgerCorpusEntry[], windowMs: number, minRotations: number): LedgerCorpusEntry[] {
  const stamps = entries.map(stampMsOf).filter((ms) => !Number.isNaN(ms));
  if (stamps.length === 0) return entries;
  const start = stamps.reduce((a, b) => Math.max(a, b)) - windowMs;
  const newest = new Set(entries.map((e) => e.path).sort().reverse().slice(0, minRotations));
  // An unparseable name cannot be placed in time, so it is read rather than guessed old.
  return entries.filter((entry) => newest.has(entry.path) || !(stampMsOf(entry) < start));
}

/**
 * The newest stamp among the rotations a {@link LedgerUnionRawReadOptions.rotationWindowMs} read of `stateDir`
 * leaves out, or -Infinity when it reads them all. A row of a step no rotation retains sits in one file, at or
 * before that file's stamp, so the window's rows of such a step are exactly those stamped after this.
 */
export function rotationWindowExcludedThroughMs(stateDir: string, windowMs: number, minRotations: number, fsDeps: Pick<LedgerGrepFsDeps, "readdirSync"> = realLedgerFs): number {
  const { rotations } = listedLedgerFiles(stateDir, fsDeps);
  const read = new Set(withinRotationWindow(rotations, windowMs, minRotations).map((entry) => entry.path));
  return Math.max(Number.NEGATIVE_INFINITY, ...rotations.filter((entry) => !read.has(entry.path)).map(stampMsOf));
}

/** The line-matching half every raw union read shares: the pattern, step and keep filters and the exact-line dedupe,
 *  accumulated into `rawLines` one buffer (or one slice of one) at a time. */
function rawLineCollector(opts: LedgerUnionRawReadOptions): { rawLines: string[]; scan: (buf: Buffer, start?: number, maxLines?: number) => number } {
  const stepFilter = rawLineStepFilter(opts.step);
  const seen = new Set<string>();
  const rawLines: string[] = [];
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
  const scan = (buf: Buffer, start = 0, maxLines = Number.POSITIVE_INFINITY): number => {
    let lines = 0;
    while (start < buf.length && lines < maxLines) {
      let end = buf.indexOf(0x0a, start);
      if (end === -1) end = buf.length;
      lines += 1;
      if (end > start) {
        const line = buf.toString("utf8", start, end).trim();
        if (line && (!opts.pattern || opts.pattern.test(line)) && (!stepFilter || stepFilter(line)) && (!opts.keep || opts.keep(line))) {
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
    return start;
  };
  return { rawLines, scan };
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
  const { rawLines, scan } = rawLineCollector(opts);
  const unread: string[] = [];
  let filesRead = 0;

  const readEntry = (entry: LedgerCorpusEntry): void => {
    if (rotationBeforeWindow(entry, minimumTs)) return;
    try {
      const buf = fsDeps.readFileSync(entry.path);
      filesRead += 1;
      scan(entry.form === "gzip" ? fsDeps.gunzipSync(buf) : buf);
    } catch {
      // deliberate: archive read failures are reported through unread rather than thrown.
      unread.push(entry.path);
    }
  };

  const readLive = (): void => {
    if (!liveFileRead) return;
    try {
      filesRead += 1;
      scan(fsDeps.readFileSync(livePath));
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

/** Yields the event loop between slices of one file's lines. */
const yieldTurn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * {@link readLedgerUnionRawLinesSync} off the event loop: the same files in the same order, the same filters and
 * dedupe ({@link rawLineCollector}) and the same `unread`/`ok` contract. Each file is read and decompressed by
 * libuv's pool, and its lines are scanned {@link LEDGER_ROTATION_LOAD_LINES_PER_TURN} at a time with the loop
 * yielded between slices, so a corpus of hundreds of rotations never holds the loop for one whole file.
 */
export async function readLedgerUnionRawLinesAsync(stateDir: string, opts: LedgerUnionRawReadOptions = {}): Promise<LedgerUnionRawRead> {
  const { rotations, unclassified } = listedLedgerFiles(stateDir, realLedgerFs);
  const archiveFiles = rotations.map((e) => e.path);
  const livePath = ledgerLivePath(stateDir);
  const liveFileRead = nodeExistsSync(livePath);
  const minimumTs = sinceMs(opts);
  const { rawLines, scan } = rawLineCollector(opts);
  const unread: string[] = [];
  let filesRead = 0;

  const scanInSlices = async (buf: Buffer): Promise<void> => {
    for (let at = 0; at < buf.length; ) {
      at = scan(buf, at, LEDGER_ROTATION_LOAD_LINES_PER_TURN);
      await yieldTurn();
    }
  };

  const readEntry = async (entry: LedgerCorpusEntry): Promise<void> => {
    if (rotationBeforeWindow(entry, minimumTs)) return;
    let buf: Buffer;
    try {
      const raw = await nodeReadFile(entry.path);
      filesRead += 1;
      buf = entry.form === "gzip" ? await gunzipAsync(raw) : raw;
    } catch {
      // deliberate: archive read failures are reported through unread rather than thrown, as the sync read does.
      unread.push(entry.path);
      return;
    }
    await scanInSlices(buf);
  };

  const readLive = async (): Promise<void> => {
    if (!liveFileRead) return;
    let buf: Buffer;
    try {
      filesRead += 1;
      buf = await nodeReadFile(livePath);
    } catch {
      // deliberate: an unreadable live file is not an unread rotation, exactly as in the sync read.
      return;
    }
    await scanInSlices(buf);
  };

  if (opts.requireArchives && archiveFiles.length === 0) {
    return { stateDir, archiveFiles, archiveCount: 0, liveFileRead, unread, unclassified, ok: false, rawLines: [], filesRead };
  }

  const rotationsToRead = orderedEntries(rotations, opts);
  if (opts.liveFirst) await readLive();
  for (const entry of rotationsToRead) await readEntry(entry);
  if (!opts.liveFirst) await readLive();

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
  /** Supplies a rotation's records in place of parsing it here; see {@link createLedgerRotationMemo}. */
  rotationRecords?: LedgerRotationHook;
  /** Supplies the live file's records and torn lines in place of reading it whole here, under the same
   *  failure contract (a throw is an unread live file); see {@link createIncrementalLedgerUnion}. */
  liveRecords?: (path: string) => LedgerRotationRecords;
  /** Receives the raw text of each unparseable row counted in `torn`, so a caller can judge what it lost. */
  onTorn?: (raw: string) => void;
}

/** One rotation's parsed rows, in file order, and its unparseable-line count. */
export interface LedgerRotationRecords {
  rows: Array<Record<string, unknown>>;
  torn: number;
  /** The raw text of each torn line, replayed to a union read's `onTorn`. */
  tornLines: string[];
}

/** `parse` is the union's own read of `entry`; the hook may call it, or answer without reading. */
export type LedgerRotationHook = (entry: LedgerCorpusEntry, parse: () => LedgerRotationRecords) => LedgerRotationRecords;

/** One union read's view of a {@link createLedgerRotationMemo}. */
export interface LedgerRotationMemoPass {
  rotationRecords: LedgerRotationHook;
  /** Rotations this pass found unmemoized and read as EMPTY; hand them to `load`, then read again. */
  missing: () => LedgerCorpusEntry[];
  /** True when no rotation was missing — the pass's rows are the union's — and prunes every memoized
   *  rotation this pass did not touch. False means this pass's rows must be discarded. */
  complete: () => boolean;
}

/** A rotation memo: `pass` answers one union read from it, and `load` fills what a pass found missing. */
export interface LedgerRotationMemo {
  /** `parseMissing` parses an unmemoized rotation inline and keeps it, so a pass after a rotation costs that rotation, not the union. */
  pass: (opts?: { parseMissing?: boolean }) => LedgerRotationMemoPass;
  load: (entries: readonly LedgerCorpusEntry[]) => Promise<void>;
  size: () => number;
  retention: () => { archives: number; rows: number; tornRows: number; failedArchives: number;
    digestHits?: number; digestMisses?: number; digestOutcomes?: Record<string, number>; digestErrors?: Record<string, string> };
  reportRetention: (stateDir: string, instance?: string, log?: MemoRetentionLog) => void;
}

type MemoRetentionLog = (step: string, extra: Record<string, unknown>) => void;
type MemoRetentionContext = { thread: string; lane?: "fast" | "heavy"; log: MemoRetentionLog; instances: readonly { name: string; ledgerDir: string }[] };
let memoRetentionContext: MemoRetentionContext | undefined;

export function setLedgerMemoRetentionContext(context: MemoRetentionContext | undefined): void {
  memoRetentionContext = context;
}

/** Lines one turn of the event loop parses while {@link createLedgerRotationMemo} loads a rotation. */
export const LEDGER_ROTATION_LOAD_LINES_PER_TURN = 10_000;

type MemoEntry = { key: string; read?: LedgerRotationRecords };

const ROTATION_DIGEST_CODEC = "rotation-digest-codec";
type DigestCodecRequest = { id: number; operation: "parse" | "stringify"; value: unknown };
type DigestCodecReply = { id: number; value?: unknown; error?: string };

export function replyToRotationDigestRequest(
  { id, operation, value }: DigestCodecRequest,
  port: Pick<MessagePort, "postMessage"> = parentPort!,
): void {
  try {
    let result: unknown;
    if (operation === "stringify") result = JSON.stringify(value);
    else {
      const digest = JSON.parse(value as string);
      const read = digest?.read;
      if (digest?.schema === 1 && read && Array.isArray(read.rows) &&
          read.rows.every((row: unknown) => row !== null && typeof row === "object" && !Array.isArray(row)) &&
          Number.isSafeInteger(read.torn) && read.torn >= 0 && Array.isArray(read.tornLines) &&
          read.tornLines.length === read.torn && read.tornLines.every((line: unknown) => typeof line === "string")) {
        result = digest;
      }
    }
    port.postMessage({ id, value: result } satisfies DigestCodecReply);
  } catch (error) {
    port.postMessage({ id, error: (error as Error).name } satisfies DigestCodecReply);
  }
}

export function registerRotationDigestCodec(
  port: Pick<MessagePort, "on" | "postMessage"> | null,
  kind: unknown,
): void {
  if (port && kind === ROTATION_DIGEST_CODEC) {
    port.on("message", (request: DigestCodecRequest) => replyToRotationDigestRequest(request, port));
  }
}

registerRotationDigestCodec(parentPort, workerData?.kind);

let digestCodecWorker: Worker | undefined;
let digestCodecId = 0;
const digestCodecPending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function rotationDigestCodec<T>(operation: DigestCodecRequest["operation"], value: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!digestCodecWorker) {
      const spawned = new Worker(new URL(import.meta.url), {
        execArgv: ["--import", "tsx"], workerData: { kind: ROTATION_DIGEST_CODEC },
      });
      digestCodecWorker = spawned;
      const failed = (error: Error): void => {
        if (digestCodecWorker !== spawned) return;
        digestCodecWorker = undefined;
        for (const pending of digestCodecPending.values()) pending.reject(error);
        digestCodecPending.clear();
      };
      spawned.on("message", (reply: DigestCodecReply) => {
        const pending = digestCodecPending.get(reply.id)!;
        digestCodecPending.delete(reply.id);
        if (digestCodecPending.size === 0) spawned.unref();
        if (reply.error) pending.reject(Object.assign(new Error("rotation digest codec failed"), { name: reply.error }));
        else pending.resolve(reply.value);
      });
      spawned.on("error", failed);
      spawned.on("exit", (code) => failed(new Error(`rotation digest codec exited: ${code}`)));
    }
    const id = ++digestCodecId;
    const target = digestCodecWorker;
    digestCodecPending.set(id, { resolve: (result) => resolve(result as T), reject });
    target.ref();
    try {
      target.postMessage({ id, operation, value } satisfies DigestCodecRequest);
    } catch (error) {
      const reason = error;
      digestCodecPending.delete(id);
      if (digestCodecPending.size === 0) target.unref();
      reject(reason);
    }
  });
}

/**
 * Memoizes each rotation's `reduce`d records by path, size and mtime. A rotation is written once, so a
 * repeated union read parses only the live file: re-parsing ~150 immutable archives per request held
 * `rmd serve`'s event loop for 4.6 s, one 34 MB archive alone for 3.7 s (2026-09-24). A pass never parses a
 * rotation: it reports it `missing`, and `load` decompresses off the loop and parses in bounded slices.
 * `reduce` must satisfy reduce(a ++ b) = reduce(reduce(a) ++ b), since a rotation is reduced slice by slice.
 * Rows are read with no `pattern`. A rotation whose load failed is parsed inline, as an unmemoized read is.
 */
export function createLedgerRotationMemo(
  reduce: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>,
  io: {
    statKey?: (path: string) => string;
    readFile?: (path: string) => Promise<Buffer>;
    yieldTurn?: () => Promise<void>;
    /** Only lines matching this are parsed by `load`; `reduce` must drop every row it would reject. */
    pattern?: RegExp;
    holder?: string;
    /** Bump the version whenever the reducer or its input pattern changes. W1-T6263. */
    durableDigest?: { reducerVersion: string };
    writeRetention?: (path: string, row: { run_id: string; task_id: string; step: string; [key: string]: unknown }) => void;
  } = {},
): LedgerRotationMemo {
  if (io.durableDigest && (!io.holder || !io.durableDigest.reducerVersion)) {
    throw new Error("rotation digests require a holder and reducer version");
  }
  const statKey = io.statKey ?? ((path: string) => {
    const stat = nodeStatSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  });
  const readFile = io.readFile ?? ((path: string) => nodeReadFile(path));
  const yieldTurn = io.yieldTurn ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  let memo = new Map<string, MemoEntry>();
  const loading = new Map<string, Promise<void>>();
  const reported = new Map<string, string>();
  let digestHits = 0, digestMisses = 0;
  const digestOutcomes: Record<string, number> = {};
  const digestErrors: Record<string, string> = {};
  const digestStateDirs = new Set<string>();
  const outcome = (kind: string, error?: unknown): void => {
    digestOutcomes[kind] = (digestOutcomes[kind] ?? 0) + 1;
    if (error !== undefined) digestErrors[kind] = String(error);
  };
  const digestDirectory = (stateDir: string): string => join(stateDir, "cache", "rotation-digests", encodeURIComponent(io.holder!).replaceAll(".", "%2E"));
  const digestPath = (entry: LedgerCorpusEntry): string => join(digestDirectory(dirname(entry.path)), `${basename(entry.path)}.json`);
  const readDigest = async (entry: LedgerCorpusEntry, key: string): Promise<LedgerRotationRecords | undefined> => {
    let raw: Buffer;
    try {
      raw = await nodeReadFile(digestPath(entry));
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code ?? (error as Error).name;
      outcome(reason === "ENOENT" ? "missing" : "unreadable", reason);
      return undefined;
    }
    let digest: Record<string, unknown> | undefined;
    try {
      digest = await rotationDigestCodec<Record<string, unknown> | undefined>("parse", raw.toString("utf8"));
    } catch (error) {
      const reason = (error as Error).name;
      outcome("corrupt", reason);
      return undefined;
    }
    if (!digest) {
      outcome("corrupt");
      return undefined;
    }
    if (digest.holder !== io.holder || digest.archive !== basename(entry.path) || digest.key !== key) {
      outcome("identity");
      return undefined;
    }
    if (digest.reducerVersion !== io.durableDigest!.reducerVersion) {
      outcome("version");
      return undefined;
    }
    digestHits++;
    return digest.read as LedgerRotationRecords;
  };
  const writeDigest = async (entry: LedgerCorpusEntry, key: string, read: LedgerRotationRecords): Promise<void> => {
    const path = digestPath(entry);
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await nodeMkdir(dirname(path), { recursive: true, mode: 0o700 });
      const text = await rotationDigestCodec<string>("stringify", { schema: 1, holder: io.holder,
        reducerVersion: io.durableDigest!.reducerVersion, archive: basename(entry.path), key, read });
      await nodeWriteFile(temp, text,
      { flag: "wx", mode: 0o600, flush: true });
      await nodeRename(temp, path);
      outcome("written");
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code ?? (error as Error).name;
      outcome("writeFailed", reason);
    } finally {
      try {
        await nodeUnlink(temp);
      } catch (error) {
        const reason = (error as NodeJS.ErrnoException).code ?? (error as Error).name;
        if (reason !== "ENOENT") outcome("cleanupFailed", reason);
      }
    }
  };
  const pruneDigests = async (stateDir: string): Promise<void> => {
    try {
      const names = await nodeReaddir(stateDir);
      const archives = new Set(ledgerRotationEntries(names, stateDir).map((entry) => `${basename(entry.path)}.json`));
      for (const name of await nodeReaddir(digestDirectory(stateDir))) {
        if (!name.endsWith(".json") || archives.has(name)) continue;
        await nodeUnlink(join(digestDirectory(stateDir), name));
        outcome("pruned");
      }
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code ?? (error as Error).name;
      outcome(reason === "ENOENT" ? "pruneAbsent" : "pruneFailed", reason);
    }
  };

  const loadOne = async (entry: LedgerCorpusEntry): Promise<void> => {
    let key = "";
    try {
      key = statKey(entry.path);
      if (io.durableDigest) {
        const digest = await readDigest(entry, key);
        if (digest) {
          memo.set(entry.path, { key, read: digest });
          return;
        }
        digestMisses++;
      }
      let rows: Array<Record<string, unknown>> = [];
      let torn = 0;
      const tornLines: string[] = [];
      if (io.readFile) {
        // Preserve the existing injected-buffer seam; real files use bounded streaming below.
        const raw = await readFile(entry.path);
        const buf = entry.form === "gzip" ? await gunzipAsync(raw) : raw;
        for (let at = 0; at < buf.length; ) {
          const slice: Array<Record<string, unknown>> = [];
          const scanned = scanLedgerBuffer(buf, io.pattern, (row) => slice.push(row), at, LEDGER_ROTATION_LOAD_LINES_PER_TURN, (line) => tornLines.push(line));
          torn += scanned.bad;
          at = scanned.next;
          rows = reduce([...rows, ...slice]);
          await yieldTurn();
        }
      } else {
        const consume = async (input: AsyncIterable<Buffer | string>): Promise<void> => {
          let slice: Array<Record<string, unknown>> = [];
          let lines = 0;
          const flush = async (): Promise<void> => {
            rows = reduce([...rows, ...slice]);
            slice = [];
            lines = 0;
            await yieldTurn();
          };
          for await (const raw of ndjsonLines(input)) {
            // Match scanLedgerBuffer's LF framing, whitespace, non-object and pattern semantics.
            if (raw.length === 0) continue;
            lines++;
            const line = raw.trim();
            if (line && (!io.pattern || io.pattern.test(line))) {
              try {
                const parsed = parseObject(line);
                if (parsed !== undefined) slice.push(parsed);
              } catch {
                // deliberate: malformed JSON remains torn evidence, not a missing or valid row;
                // retain its exact text for the union caller's onTorn provenance check.
                torn++;
                tornLines.push(line);
              }
            }
            if (lines === LEDGER_ROTATION_LOAD_LINES_PER_TURN) await flush();
          }
          if (lines > 0) await flush();
        };
        const source = nodeCreateReadStream(entry.path);
        // pipeline propagates source/decompressor errors and closes both on failure; no partial
        // memo is installed. Keep the existing failed-marker/inline-retry behavior below.
        if (entry.form === "gzip") await pipeline(source, createGunzip(), consume);
        else await pipeline(source, consume);
      }
      const read = { rows, torn, tornLines };
      memo.set(entry.path, { key, read });
      if (io.durableDigest) await writeDigest(entry, key, read);
    } catch {
      // deliberate: a failed load leaves a keyed marker, so the next pass parses this rotation inline and a
      // corrupt archive still lands in the union's `unread` exactly as it would without a memo.
      memo.set(entry.path, { key });
    }
  };

  const result: LedgerRotationMemo = {
    size: () => memo.size,
    reportRetention: (stateDir, instance, log) => {
      if (!io.holder) return;
      const context = memoRetentionContext;
      const identity = {
        thread: context?.thread ?? (isMainThread ? "main" : `worker-${threadId}`),
        ...(context?.lane ? { lane: context.lane } : {}),
        holder: io.holder,
        instance: instance ?? context?.instances.find((i) => i.ledgerDir === stateDir)?.name ?? (basename(stateDir) === "state" ? basename(dirname(stateDir)) : basename(stateDir)),
      };
      const emit = log ?? context?.log;
      if (!emit && !io.writeRetention) return;
      const counts = result.retention();
      const key = JSON.stringify([identity.thread, identity.lane, identity.holder, identity.instance]);
      const signature = JSON.stringify(counts);
      if (reported.get(key) === signature) return;
      // An empty first observation is the baseline, not a retention change worth a ledger write.
      // If a previously non-empty memo later drains to zero, its changed signature is still emitted.
      const emptyBaseline = reported.get(key) === undefined && counts.archives === 0 && counts.rows === 0 &&
        counts.tornRows === 0 && counts.failedArchives === 0;
      if (emptyBaseline) {
        reported.set(key, signature);
        return;
      }
      const extra = { ...identity, ...counts };
      if (emit) emit("read_model.memo_retention", extra);
      else io.writeRetention!(join(stateDir, LEDGER_FILENAME), { run_id: "memo-retention", task_id: "SERVE", step: "read_model.memo_retention", ...extra });
      reported.set(key, signature);
    },
    retention: () => {
      let rows = 0, tornRows = 0, failedArchives = 0;
      for (const entry of memo.values()) {
        if (!entry.read) { failedArchives++; continue; }
        rows += entry.read.rows.length;
        tornRows += entry.read.torn;
      }
      return { archives: memo.size, rows, tornRows, failedArchives,
        ...(io.durableDigest ? { digestHits, digestMisses, digestOutcomes: { ...digestOutcomes }, digestErrors: { ...digestErrors } } : {}) };
    },
    load: async (entries) => {
      if (io.durableDigest) {
        for (const entry of entries) digestStateDirs.add(dirname(entry.path));
        for (const stateDir of digestStateDirs) await pruneDigests(stateDir);
      }
      for (const entry of entries) {
        const pending = loading.get(entry.path) ?? loadOne(entry).finally(() => loading.delete(entry.path));
        loading.set(entry.path, pending);
        await pending;
      }
    },
    pass: (passOpts = {}) => {
      const touched = new Map<string, MemoEntry>();
      const missing: LedgerCorpusEntry[] = [];
      const rotationRecords: LedgerRotationHook = (entry, parse) => {
        let key: string;
        try {
          key = statKey(entry.path);
        } catch {
          // deliberate: an unstattable rotation is read uncached, so its own read failure still reaches `unread`.
          return parse();
        }
        const hit = memo.get(entry.path);
        if (hit?.key === key && hit.read) {
          touched.set(entry.path, hit);
          return hit.read;
        }
        if (hit?.key !== key && !passOpts.parseMissing) {
          missing.push(entry);
          return { rows: [], torn: 0, tornLines: [] };
        }
        const parsed = parse();
        const fresh = { key, read: { rows: reduce(parsed.rows), torn: parsed.torn, tornLines: parsed.tornLines } };
        memo.set(entry.path, fresh);
        touched.set(entry.path, fresh);
        return fresh.read;
      };
      return {
        rotationRecords,
        missing: () => [...missing],
        complete: () => {
          if (missing.length === 0) memo = touched;
          return missing.length === 0;
        },
      };
    },
  };
  return result;
}

type LedgerSighting = string | Record<string, unknown>;

/**
 * W1-T4820 — EXACT REPLAY DEDUPE THAT COSTS LESS THAN THE PARSE IT SAVES. A replayed row is a byte
 * copy, so it shares its original's `ts`; sightings are bucketed on that short key and compared as
 * whole lines only inside a bucket. A parsed row is serialised only when its bucket is non-empty.
 * MEASURED on a copy of the fleet host's seven-day window (1,087,846 archived lines, 725,963
 * distinct): no dedupe 2.3–3.0 s, a Set of whole lines 2.9–4.5 s, this 2.0–2.2 s.
 */
function firstKey(row: Record<string, unknown>): string | undefined {
  for (const key in row) return key;
  return undefined;
}

function createLedgerLineSeen(): { has: (line: string) => boolean; add: (sighting: LedgerSighting) => boolean } {
  const byTs = new Map<string, LedgerSighting[]>();
  const untimed = new Set<string>();
  const text = (bucket: LedgerSighting[], i: number): string => {
    const entry = bucket[i];
    if (typeof entry === "string") return entry;
    const line = JSON.stringify(entry);
    bucket[i] = line;
    return line;
  };
  const tsOf = (sighting: LedgerSighting): string | undefined => {
    // A parsed row keys like the line it serialises to: on `ts` only when `ts` is its first field.
    if (typeof sighting !== "string") return firstKey(sighting) === "ts" && typeof sighting.ts === "string" ? sighting.ts : undefined;
    if (!sighting.startsWith('{"ts":"')) return undefined;
    const end = sighting.indexOf('"', 7);
    return end > 7 ? sighting.slice(7, end) : undefined;
  };
  const find = (sighting: LedgerSighting): { bucket?: LedgerSighting[]; hit: boolean; line?: string; ts?: string } => {
    const ts = tsOf(sighting);
    if (ts === undefined) {
      const line = typeof sighting === "string" ? sighting : JSON.stringify(sighting);
      return { hit: untimed.has(line), line };
    }
    const bucket = byTs.get(ts);
    if (bucket === undefined) return { hit: false, ts };
    const line = typeof sighting === "string" ? sighting : JSON.stringify(sighting);
    for (let i = 0; i < bucket.length; i++) if (text(bucket, i) === line) return { bucket, hit: true, line, ts };
    return { bucket, hit: false, line, ts };
  };
  return {
    has: (line) => find(line).hit,
    add: (sighting) => {
      const found = find(sighting);
      if (found.hit) return false;
      if (found.ts === undefined) untimed.add(found.line as string);
      else if (found.bucket) found.bucket.push(sighting);
      else byTs.set(found.ts, [sighting]);
      return true;
    },
  };
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
  const seen = createLedgerLineSeen();
  const rows: Array<Record<string, unknown>> = [];
  const unread: string[] = [];
  const stepsSeen = new Set<string>();
  let torn = 0;
  let filesRead = 0;

  // A buffer row arrives with its raw line; a live or memoized row arrives parsed, and is serialised only
  // if another row shares its `ts`.
  const addRecord = (row: Record<string, unknown>, raw?: string): void => {
    if (!recordMatchesFilters(row, opts, minimumTs)) return;
    if (opts.dedupe !== false && !seen.add(raw ?? row)) return;
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
  // W1-T4820: a replayed archive line is skipped BEFORE its parse, so dedupe makes the union cheaper, not dearer.
  const skipSeen = opts.dedupe === false ? undefined : (line: string): boolean => seen.has(line);
  const scanBuffer = (buf: Buffer, onRow: (row: Record<string, unknown>, line: string) => void, onBad = opts.onTorn): number =>
    scanLedgerBuffer(buf, opts.pattern, onRow, 0, Number.POSITIVE_INFINITY, onBad, skipSeen).bad;
  const addBuffer = (buf: Buffer): void => {
    torn += scanBuffer(buf, addRecord);
  };

  const readLive = (): boolean => {
    if (opts.readLiveRecords !== undefined) {
      filesRead += 1;
      for (const row of opts.readLiveRecords(livePath)) addRecord(row);
      return opts.satisfied?.(stepsSeen) ?? false;
    }
    if (!liveFileRead) return false;
    try {
      filesRead += 1;
      if (opts.liveRecords) {
        const read = opts.liveRecords(livePath);
        torn += read.torn;
        for (const line of read.tornLines) opts.onTorn?.(line);
        for (const row of read.rows) addRecord(row);
      } else {
        addBuffer(fsDeps.readFileSync(livePath));
      }
      return opts.satisfied?.(stepsSeen) ?? false;
    } catch {
      // Best-effort readers retain rotations; strict readers must not call a failed live read
      // a complete corpus. The final `ok` decision below uses this same unread list.
      if (opts.refuseIncomplete) unread.push(livePath);
      return false;
    }
  };

  const parseEntry = (entry: LedgerCorpusEntry): LedgerRotationRecords => {
    const buf = fsDeps.readFileSync(entry.path);
    const rows: Array<Record<string, unknown>> = [];
    const tornLines: string[] = [];
    const bad = scanBuffer(entry.form === "gzip" ? fsDeps.gunzipSync(buf) : buf, (row) => rows.push(row), (line) => tornLines.push(line));
    return { rows, torn: bad, tornLines };
  };

  const readEntry = (entry: LedgerCorpusEntry): boolean => {
    if (rotationBeforeWindow(entry, minimumTs)) return false;
    try {
      if (opts.rotationRecords) {
        const read = opts.rotationRecords(entry, () => parseEntry(entry));
        filesRead += 1;
        torn += read.torn;
        for (const line of read.tornLines) opts.onTorn?.(line);
        for (const row of read.rows) addRecord(row);
        return opts.satisfied?.(stepsSeen) ?? false;
      }
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

/**
 * W1-T4567 — {@link readLedgerUnionRecordsSync} over EVERY rotation, answered from a
 * {@link createLedgerRotationMemo}: a repeated request parses only the live file, because a rotation is
 * written once. The first request, and any request after a new rotation lands, loads what the memo is
 * missing off the event loop (`load`) and reads again. `status.ts`'s `readLedgerUnionMemoized` is the
 * same loop for the capped board window; this one keeps the full corpus a durable history needs.
 */
export async function readLedgerUnionRecordsMemoized(
  stateDir: string,
  memo: LedgerRotationMemo,
  opts: LedgerUnionRecordReadOptions = {},
  fsDeps: LedgerGrepFsDeps = realLedgerFs,
): Promise<LedgerUnionRecordRead> {
  let pass = memo.pass();
  let read = readLedgerUnionRecordsSync(stateDir, { ...opts, rotationRecords: pass.rotationRecords }, fsDeps);
  while (!pass.complete()) {
    await memo.load(pass.missing());
    pass = memo.pass();
    read = readLedgerUnionRecordsSync(stateDir, { ...opts, rotationRecords: pass.rotationRecords }, fsDeps);
  }
  memo.reportRetention(stateDir);
  return read;
}

/** What one {@link ledgerRotationDigests} hook did, so a caller can prove a repeat read decompressed nothing. */
export interface LedgerRotationDigestCounts {
  /** Rotations answered from a digest written by an earlier read. */
  hits: number;
  /** Rotations read, decompressed and parsed here (and digested for the next read). */
  parsed: number;
  /** Digests that could not be written; the rows were still returned. */
  writeFailed: number;
  /** Digests of rotations that no longer exist, removed. */
  pruned: number;
}

/**
 * A SYNCHRONOUS, DURABLE {@link LedgerRotationHook} for a reader in a short-lived process. A garden pass is a
 * fresh child process every time (W1-T5114), so an in-memory {@link createLedgerRotationMemo} never hits there,
 * and each pass gunzipped and parsed every archived rotation again. OBSERVED 2026-10-09 on the fleet host: 423
 * archives (178 MB gzipped, ~3.8 GB decompressed) per ci-friction pass, every 60 s. A rotation is written once,
 * so its `reduce`d rows are kept on disk, keyed by the rotation's name, size and mtime, in the same store and
 * format as the async memo's durable digests (cache/rotation-digests/<holder>/<rotation>.json). A later read
 * decompresses only a rotation it has not seen; a damaged, foreign or stale digest is re-parsed and replaced.
 *
 * The rotation is parsed here in full, never through the union's `parse`, whose `pattern` and replay-skip
 * would make the digest depend on that one read's options. `reduce` must keep every row the union read's
 * own filters (`step`, `since`) would keep from that rotation; it may drop the rest. Bump `reducerVersion`
 * whenever `reduce` changes.
 */
export function ledgerRotationDigests(
  stateDir: string,
  reduce: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>,
  opts: { holder: string; reducerVersion: string },
  fsDeps: LedgerGrepFsDeps = realLedgerFs,
): { rotationRecords: LedgerRotationHook; counts: () => LedgerRotationDigestCounts } {
  if (!opts.holder || !opts.reducerVersion) throw new Error("rotation digests require a holder and reducer version");
  const counts: LedgerRotationDigestCounts = { hits: 0, parsed: 0, writeFailed: 0, pruned: 0 };
  const directory = join(stateDir, "cache", "rotation-digests", encodeURIComponent(opts.holder).replaceAll(".", "%2E"));
  const pathOf = (entry: LedgerCorpusEntry): string => join(directory, `${basename(entry.path)}.json`);
  try {
    const live = new Set(ledgerRotationEntries(fsDeps.readdirSync(stateDir), stateDir).map((entry) => `${basename(entry.path)}.json`));
    for (const name of fsDeps.readdirSync(directory)) {
      if (!name.endsWith(".json") || live.has(name)) continue;
      nodeUnlinkSync(join(directory, name));
      counts.pruned += 1;
    }
  } catch {
    // deliberate: no digest directory yet (or an unlistable one) leaves nothing to prune; reads still work.
  }
  const cached = (entry: LedgerCorpusEntry, key: string): LedgerRotationRecords | undefined => {
    let digest: Record<string, unknown>;
    try {
      digest = JSON.parse(fsDeps.readFileSync(pathOf(entry)).toString("utf8")) as Record<string, unknown>;
    } catch {
      // deliberate: an absent or unparseable digest is a miss, and the rotation itself is read.
      return undefined;
    }
    const read = digest?.read as LedgerRotationRecords | undefined;
    const valid = digest?.schema === 1 && digest.holder === opts.holder && digest.reducerVersion === opts.reducerVersion &&
      digest.archive === basename(entry.path) && digest.key === key && read !== undefined && Array.isArray(read.rows) &&
      read.rows.every((row) => row !== null && typeof row === "object" && !Array.isArray(row)) &&
      Number.isSafeInteger(read.torn) && Array.isArray(read.tornLines) && read.tornLines.length === read.torn &&
      read.tornLines.every((line) => typeof line === "string");
    return valid ? read : undefined;
  };
  const rotationRecords: LedgerRotationHook = (entry) => {
    const stat = nodeStatSync(entry.path);
    const key = `${stat.size}:${stat.mtimeMs}`;
    const hit = cached(entry, key);
    if (hit) {
      counts.hits += 1;
      return hit;
    }
    const buf = fsDeps.readFileSync(entry.path);
    const rows: Array<Record<string, unknown>> = [];
    const tornLines: string[] = [];
    const torn = scanLedgerBuffer(entry.form === "gzip" ? fsDeps.gunzipSync(buf) : buf, undefined, (row) => rows.push(row), 0,
      Number.POSITIVE_INFINITY, (line) => tornLines.push(line)).bad;
    const read: LedgerRotationRecords = { rows: reduce(rows), torn, tornLines };
    counts.parsed += 1;
    const path = pathOf(entry);
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      nodeMkdirSync(directory, { recursive: true, mode: 0o700 });
      nodeWriteFileSync(temp, JSON.stringify({ schema: 1, holder: opts.holder, reducerVersion: opts.reducerVersion,
        archive: basename(entry.path), key, read }), { flag: "wx", mode: 0o600 });
      nodeRenameSync(temp, path);
    } catch {
      // deliberate: an unwritable digest costs the next read a parse, never this read its rows.
      counts.writeFailed += 1;
      try { nodeUnlinkSync(temp); } catch { /* deliberate: no temp file was left */ }
    }
    return read;
  };
  return { rotationRecords, counts: () => ({ ...counts }) };
}

/** Bytes before the live file's read watermark that must still match before only its tail is read. */
const LIVE_ANCHOR_BYTES = 64;

interface IncrementalLiveState {
  ino: number;
  /** End of the last complete line read; a line still being written is re-read on the next call. */
  committed: number;
  anchor: Buffer;
  read: LedgerRotationRecords;
}

interface IncrementalUnionState {
  rotations: Map<string, { key: string; read: LedgerRotationRecords }>;
  live?: IncrementalLiveState;
  last?: { signature: string; result: LedgerUnionRecordRead };
}

/**
 * {@link readLedgerUnionRecordsSync} for a LONG-LIVED reader that asks the same step-filtered question again and
 * again, with the same answer. OBSERVED 2026-10-10 on the fleet host: the daemon's dispatch selection read the
 * whole corpus (446 rotations, 3.97 M lines, 1.78 GB decompressed) and parsed every line, on every tick and
 * every lane refill, to keep 61,803 rows. Here:
 *  - an unchanged ledger (every rotation's size and mtime, the live file's inode, size and mtime) returns the
 *    previous result and reads nothing;
 *  - a rotation is parsed at most once, reduced to the wanted steps, and kept in memory and as a durable
 *    {@link ledgerRotationDigests} digest, so a restarted process reads digests rather than archives;
 *  - the live file is read from where the last call stopped, while its inode holds and the bytes just before
 *    that point are unchanged; anything else re-reads it from the start.
 * The union itself (order, replay dedupe, `ok` and `unread`) is still {@link readLedgerUnionRecordsSync}'s.
 * Only `step`, `refuseIncomplete` and `requireArchives` are cached; any other option reads uncached. The
 * returned `rows` array is frozen and shared between calls: a caller must not mutate it or its rows.
 */
export function createIncrementalLedgerUnion(
  opts: { holder: string; reducerVersion: string },
  fsDeps: LedgerGrepFsDeps = realLedgerFs,
): (stateDir: string, readOpts?: LedgerUnionRecordReadOptions) => LedgerUnionRecordRead {
  const statSync = fsDeps.statSync ?? realLedgerFs.statSync;
  const readRange = fsDeps.readRangeSync ?? realLedgerFs.readRangeSync;
  const states = new Map<string, IncrementalUnionState>();
  return (stateDir, readOpts = {}) => {
    const { step, refuseIncomplete, requireArchives, ...rest } = readOpts;
    if (step === undefined || Object.values(rest).some((value) => value !== undefined)) {
      return readLedgerUnionRecordsSync(stateDir, readOpts, fsDeps);
    }
    const steps = typeof step === "string" ? [step] : [...step];
    const stateKey = JSON.stringify([stateDir, steps, refuseIncomplete === true, requireArchives === true]);
    const state: IncrementalUnionState = states.get(stateKey) ?? { rotations: new Map() };
    states.set(stateKey, state);

    const { rotations, unclassified } = listedLedgerFiles(stateDir, fsDeps);
    const keys = new Map<string, string>();
    for (const entry of rotations) {
      try {
        const stat = statSync(entry.path);
        keys.set(entry.path, `${stat.size}:${stat.mtimeMs}`);
      } catch {
        // deliberate: an unstattable rotation is never memoized; the union's own read reports it unread.
      }
    }
    const livePath = ledgerLivePath(stateDir);
    let liveKey: string | undefined = "absent";
    try {
      if (fsDeps.existsSync(livePath)) {
        const stat = statSync(livePath);
        liveKey = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      }
    } catch {
      // deliberate: an unstattable live file is never a cache hit; the union's own read decides what it costs.
      liveKey = undefined;
    }
    const signature = JSON.stringify([unclassified, rotations.map((entry) => [entry.path, keys.get(entry.path) ?? null]), liveKey ?? null]);
    if (liveKey !== undefined && state.last?.signature === signature) return state.last.result;

    const reduce = (rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> => rows.filter((row) => stepMatches(row, steps));
    let digests: ReturnType<typeof ledgerRotationDigests> | undefined;
    const kept = new Map<string, { key: string; read: LedgerRotationRecords }>();
    const rotationRecords: LedgerRotationHook = (entry, parse) => {
      const key = keys.get(entry.path);
      if (key === undefined) return parse();
      const hit = state.rotations.get(entry.path);
      if (hit?.key === key) {
        kept.set(entry.path, hit);
        return hit.read;
      }
      digests ??= ledgerRotationDigests(stateDir, reduce, { holder: opts.holder, reducerVersion: `${opts.reducerVersion}:${steps.join(",")}` }, fsDeps);
      const read = digests.rotationRecords(entry, parse);
      kept.set(entry.path, { key, read });
      return read;
    };

    const scan = (buf: Buffer): LedgerRotationRecords => {
      const rows: Array<Record<string, unknown>> = [];
      const tornLines: string[] = [];
      const torn = scanLedgerBuffer(buf, undefined, (row) => void (stepMatches(row, steps) && rows.push(row)), 0,
        Number.POSITIVE_INFINITY, (line) => tornLines.push(line)).bad;
      return { rows, torn, tornLines };
    };
    const liveRecords = (path: string): LedgerRotationRecords => {
      const stat = statSync(path);
      const prior = state.live !== undefined && state.live.ino === stat.ino && stat.size >= state.live.committed ? state.live : undefined;
      let start = prior ? prior.committed - prior.anchor.length : 0;
      let buf = readRange(path, start, stat.size);
      let base = prior;
      if (prior && !buf.subarray(0, prior.anchor.length).equals(prior.anchor)) {
        base = undefined;
        start = 0;
        buf = readRange(path, 0, stat.size);
      }
      const body = base ? buf.subarray(base.anchor.length) : buf;
      const complete = body.subarray(0, body.lastIndexOf(0x0a) + 1);
      const added = scan(complete);
      const read: LedgerRotationRecords = base
        ? { rows: [...base.read.rows, ...added.rows], torn: base.read.torn + added.torn, tornLines: [...base.read.tornLines, ...added.tornLines] }
        : added;
      const committed = (base ? base.committed : 0) + complete.length;
      const anchorFrom = Math.max(0, committed - LIVE_ANCHOR_BYTES) - start;
      state.live = { ino: stat.ino, committed, anchor: Buffer.from(buf.subarray(Math.max(0, anchorFrom), committed - start)), read };
      // A final line with no newline yet is read, exactly as a whole-file read reads it, but never committed.
      const fragment = scan(body.subarray(complete.length));
      if (fragment.rows.length === 0 && fragment.torn === 0) return read;
      return { rows: [...read.rows, ...fragment.rows], torn: read.torn + fragment.torn, tornLines: [...read.tornLines, ...fragment.tornLines] };
    };

    const result = readLedgerUnionRecordsSync(stateDir, { step, refuseIncomplete, requireArchives, rotationRecords, liveRecords }, fsDeps);
    Object.freeze(result.rows);
    state.rotations = kept;
    state.last = result.unread.length === 0 ? { signature, result } : undefined;
    return result;
  };
}

export function resolveLedgerUnion(
  stateDir: string,
  pattern: string | RegExp,
  fsDeps: LedgerGrepFsDeps = realLedgerFs,
  opts: LedgerUnionOptions = {},
): LedgerUnionResult {
  return ledgerUnionResultOf(readLedgerUnionRawLinesSync(stateDir, resolveUnionReadOptions(pattern, opts), fsDeps));
}

/** {@link resolveLedgerUnion} off the event loop ({@link readLedgerUnionRawLinesAsync}): the same answer. */
export async function resolveLedgerUnionAsync(stateDir: string, pattern: string | RegExp, opts: LedgerUnionOptions = {}): Promise<LedgerUnionResult> {
  return ledgerUnionResultOf(await readLedgerUnionRawLinesAsync(stateDir, resolveUnionReadOptions(pattern, opts)));
}

function resolveUnionReadOptions(pattern: string | RegExp, opts: LedgerUnionOptions): LedgerUnionRawReadOptions {
  const re = pattern instanceof RegExp ? pattern : new RegExp(sanitizeRegExp(pattern));
  return { ...opts, pattern: re, requireArchives: true, refuseIncomplete: true };
}

function ledgerUnionResultOf(read: LedgerUnionRawRead): LedgerUnionResult {
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
