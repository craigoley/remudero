import { createReadStream as nodeCreateReadStream, existsSync as nodeExistsSync, readFileSync as nodeReadFileSync, readdirSync as nodeReaddirSync, statSync as nodeStatSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { addAbortSignal, type Readable } from "node:stream";
import { readFile as nodeReadFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createGunzip, gunzip as nodeGunzip, gunzipSync as nodeGunzipSync } from "node:zlib";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { NEVER_ROTATE_FILENAME } from "./log-rotation.js";

const gunzipAsync = promisify(nodeGunzip);

export interface LedgerGrepFsDeps {
  readdirSync: (dir: string) => string[];
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => Buffer;
  gunzipSync: (buf: Buffer) => Buffer;
}

export const realLedgerFs: LedgerGrepFsDeps = {
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
   * JSON and changing its identity. */
  onAcceptedRecord?: (row: Record<string, unknown>, raw: string) => void;
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
  /** Seed the bounded replay window without persisting raw ledger lines. */
  dedupeSeed?: readonly { step: string; fingerprint: string }[];
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
    let rl: ReturnType<typeof createInterface> | undefined;
    let archiveUnread = false;
    let rowOrdinal = 0;
    let pendingLiveBad: LedgerMalformedRowFinding | undefined;
    let liveBytes = Math.max(0, opts.liveStartOffset ?? 0);
    let lastLineStartOffset = liveBytes;
    let lastLiveByte: number | undefined;
    try {
      const liveStartOffset = entry.path === livePath && opts.liveStartOffset !== undefined
        ? Math.max(0, opts.liveStartOffset)
        : undefined;
      source = io.createReadStream(
        entry.path,
        liveStartOffset === undefined ? undefined : { start: liveStartOffset },
      );
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
      rl = createInterface({ input, crlfDelay: Infinity });
      for await (const raw of rl) {
        opts.signal?.throwIfAborted();
        rowOrdinal += 1;
        if (pendingLiveBad) {
          opts.onMalformedRow?.(pendingLiveBad);
          pendingLiveBad = undefined;
        }
        const line = String(raw).trim();
        if (!line) continue;
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
        if (opts.dedupe !== false && opts.dedupeWindowPerStep === undefined) {
          if (seen.has(line)) continue;
          seen.add(line);
        }
        if (!recordMatchesFilters(parsed, opts, minimumTs)) continue;
        const step = typeof parsed.step === "string" ? parsed.step : "";
        if (replayedInsideWindow(step, opts.dedupeSeed === undefined ? line : fingerprintLedgerLine(line))) continue;
        opts.onAcceptedRecord?.(parsed, line);
        yield parsed;
      }
      if (pendingLiveBad) opts.onMalformedRow?.(lastLiveByte !== 0x0a
        ? { ...pendingLiveBad, kind: "live-torn-tail", resumeOffset: lastLineStartOffset }
        : pendingLiveBad);
    } catch (error) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? error;
      // deliberate: an unreadable file costs that file, not the whole best-effort stream.
      // Console-style readers are best effort; audit-style refusal is handled by resolveLedgerUnion.
      archiveUnread = true;
    } finally {
      if (entry.path !== livePath && archiveUnread) opts.onUnreadArchive?.(entry.path);
      if (entry.path === livePath && archiveUnread) opts.onUnreadLive?.(entry.path);
      // Explicit ownership rather than relying only on async-iterator return semantics: timeout,
      // server close and stale-code exit all need the active descriptor/gunzip/readline released
      // before this generator can settle and before another rotation can open.
      rl?.close();
      input?.destroy();
      gunzip?.destroy();
      source?.destroy();
    }
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
  const stepFilter = rawLineStepFilter(opts.step);
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
        if (line && (!opts.pattern || opts.pattern.test(line)) && (!stepFilter || stepFilter(line))) {
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
  /** Supplies a rotation's records in place of parsing it here; see {@link createLedgerRotationMemo}. */
  rotationRecords?: LedgerRotationHook;
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
  pass: () => LedgerRotationMemoPass;
  load: (entries: readonly LedgerCorpusEntry[]) => Promise<void>;
  size: () => number;
}

/** Lines one turn of the event loop parses while {@link createLedgerRotationMemo} loads a rotation. */
export const LEDGER_ROTATION_LOAD_LINES_PER_TURN = 10_000;

type MemoEntry = { key: string; read?: LedgerRotationRecords };

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
  } = {},
): LedgerRotationMemo {
  const statKey = io.statKey ?? ((path: string) => {
    const stat = nodeStatSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  });
  const readFile = io.readFile ?? ((path: string) => nodeReadFile(path));
  const yieldTurn = io.yieldTurn ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  let memo = new Map<string, MemoEntry>();
  const loading = new Map<string, Promise<void>>();

  const loadOne = async (entry: LedgerCorpusEntry): Promise<void> => {
    let key = "";
    try {
      key = statKey(entry.path);
      const raw = await readFile(entry.path);
      const buf = entry.form === "gzip" ? await gunzipAsync(raw) : raw;
      let rows: Array<Record<string, unknown>> = [];
      let torn = 0;
      const tornLines: string[] = [];
      for (let at = 0; at < buf.length; ) {
        const slice: Array<Record<string, unknown>> = [];
        const scanned = scanLedgerBuffer(buf, undefined, (row) => slice.push(row), at, LEDGER_ROTATION_LOAD_LINES_PER_TURN, (line) => tornLines.push(line));
        torn += scanned.bad;
        at = scanned.next;
        rows = reduce([...rows, ...slice]);
        await yieldTurn();
      }
      memo.set(entry.path, { key, read: { rows, torn, tornLines } });
    } catch {
      // deliberate: a failed load leaves a keyed marker, so the next pass parses this rotation inline and a
      // corrupt archive still lands in the union's `unread` exactly as it would without a memo.
      memo.set(entry.path, { key });
    }
  };

  return {
    size: () => memo.size,
    load: async (entries) => {
      for (const entry of entries) {
        const pending = loading.get(entry.path) ?? loadOne(entry).finally(() => loading.delete(entry.path));
        loading.set(entry.path, pending);
        await pending;
      }
    },
    pass: () => {
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
        if (hit?.key !== key) {
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
      addBuffer(fsDeps.readFileSync(livePath));
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
  return read;
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
