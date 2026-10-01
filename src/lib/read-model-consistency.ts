/**
 * The read model's consistency oracle (Phase 1 design §4; P1-05). The ledger stays authoritative:
 * this recomputes a CLOSED window from the ledger union and compares it with what the projector
 * holds, row for row, then answers drift with a tiered, self-healing response.
 *
 * - Positive control: the union read must have opened every rotation form the directory holds for
 *   the window, and the window must hold at least one ledger row. A blind read throws; it never
 *   reports agreement.
 * - Drift the projector owns (a missing identity, a missing or corrupted fact) is rechecked, then
 *   healed by rebuilding the window's rows from the ledger, then escalated if it survives the
 *   rebuild or recurs after an earlier one.
 * - A row the projector holds but the ledger lost is never "fixed": it is the first evidence of a
 *   real ledger loss (the rotation rename sliver, or a power loss), so it escalates (risk 4).
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { tryEscalate, type EscalateDeps, type Escalation } from "./escalate.js";
import { appendLedger } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { LEDGER_ROW_PROJECTIONS, isFactStep, ledgerLineIdentity, type LedgerRowProjection } from "./ledger-projector.js";
import { ledgerRotationEntries, realLedgerFs, rotationStampIso, type LedgerGrepFsDeps } from "./ledger-union.js";
import { openScratchReadModel, withWriteTransaction, type ReadModelDb, type ReadModelLease } from "./read-model-db.js";

export const READ_MODEL_CONSISTENCY_STEP = "read_model.consistency";
export const READ_MODEL_SELF_HEALED_STEP = "read_model.self_healed";
/** The window closes this long before now, so only the documented late rows can still move it. */
export const ORACLE_CLOSED_LAG_MS = 10 * 60_000;
/**
 * A window is CLOSED by ingest position, not by event time: rows arrive more than a day late (a
 * late-cut rotation), so an event-time edge alone saw them as drift. The oracle compares only rows
 * at file positions the projector had applied by an {@link IngestMark} at least this old.
 */
export const ORACLE_INGEST_SETTLE_MS = 10 * 60_000;
export const ORACLE_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** A drift that comes back within this long after a self-heal is a projection bug, not a blip. */
export const ORACLE_RECURRENCE_MS = 24 * 60 * 60_000;
const SAMPLE_LIMIT = 5;

const SPAN_DDL = "CREATE TABLE IF NOT EXISTS oracle_span(name TEXT PRIMARY KEY, size INTEGER NOT NULL, min_ts INTEGER NOT NULL, max_ts INTEGER NOT NULL) WITHOUT ROWID";

/** Each archive's recorded row-time span; empty before the first check that held the lease. */
function readSpans(db: ReadModelDb): Map<string, OracleFileSpan> {
  const exists = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'oracle_span'").get();
  if (!exists) return new Map();
  return new Map(db.prepare("SELECT name, size, min_ts, max_ts FROM oracle_span").all()
    .map((row) => [String(row.name), { name: String(row.name), size: Number(row.size), minTs: Number(row.min_ts), maxTs: Number(row.max_ts) }]));
}

const CONSISTENCY_DDL = `CREATE TABLE IF NOT EXISTS consistency_run(id INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL,
  t0 INTEGER NOT NULL, t1 INTEGER NOT NULL, outcome TEXT NOT NULL, ledger_rows INTEGER NOT NULL, missing INTEGER NOT NULL,
  ledger_lost INTEGER NOT NULL, fact_missing INTEGER NOT NULL, fact_corrupt INTEGER NOT NULL, healed INTEGER NOT NULL, lost_fp TEXT)`;

export class ReadModelConsistencyError extends RmdError {
  constructor(message: string, details: Record<string, unknown>) {
    super("read-model", GENERIC_EXIT_CODE, `read model oracle_blind: ${message}`, { reason: "oracle_blind", ...details });
  }
}

export type LedgerForm = "gzip" | "plain" | "live";

export interface OracleFormRead {
  form: LedgerForm;
  /** Files of this form the oracle's own listing says could hold rows in the window. */
  expected: number;
  read: number;
  lines: number;
}

export interface OracleWindow {
  t0: number;
  t1: number;
}

interface IdentityKey {
  tsMs: number;
  h: bigint;
}

/** The row-time span of one archive, as the oracle last read it; valid while its size is unchanged. */
export interface OracleFileSpan {
  name: string;
  size: number;
  minTs: number;
  maxTs: number;
}

export interface WindowComparison {
  window: OracleWindow;
  forms: OracleFormRead[];
  /** Files read, and archives skipped because their recorded span misses the window. */
  files: { read: number; skipped: number };
  /** Spans of archives this read learned. */
  spans: OracleFileSpan[];
  ledgerRows: number;
  storeRows: number;
  expectedFacts: number;
  /** In the ledger, absent from the projection. */
  missing: string[];
  /** Held by the projection, absent from every rotation form of the ledger (risk 4). */
  ledgerLost: string[];
  factMissing: string[];
  /** `fact.seq` of rows whose body or derived columns no ledger row explains. */
  factCorrupt: number[];
  /** Row-projection tables (`repo_row`, `instance_heartbeat`): rows the window's lines should have put there and did not. */
  projectionMissing: string[];
  /** Windowed projection rows no ledger line explains; each is deleted by a heal, except a row the ledger lost. */
  projectionExtra: Array<{ table: string; tsMs: number; h: bigint }>;
  quarantined: ReadonlySet<string>;
  /** Window rows found only past the mark's positions: not yet compared either way. */
  unsettled: ReadonlySet<string>;
  lines: Map<string, string>;
  ids: Map<string, IdentityKey>;
}

/** One projector checkpoint, as `source_file` holds it. */
export interface IngestCheckpoint {
  name: string;
  ino: string;
  size: number;
  off: number;
  fp: string | null;
}

/** The projector's checkpoints at one moment: every ledger byte below them had been applied by `atMs`. */
export interface IngestMark {
  atMs: number;
  files: IngestCheckpoint[];
}

const PARTIAL_ARCHIVE = "partial:";
const INGEST_MARKS_KEY = "oracle_ingest_marks";

/** The store's checkpoints now, as a mark. */
export function readIngestMark(db: ReadModelDb, atMs: number): IngestMark {
  const files = db.prepare("SELECT name, ino, size, off, fp FROM source_file").all()
    .map((row) => ({ name: String(row.name), ino: String(row.ino), size: Number(row.size), off: Number(row.off), fp: row.fp === null ? null : String(row.fp) }));
  return { atMs, files };
}

function storedMarks(db: ReadModelDb): IngestMark[] {
  try {
    const marks = JSON.parse(db.meta(INGEST_MARKS_KEY) ?? "[]") as unknown;
    return Array.isArray(marks) ? marks.filter((m): m is IngestMark => Number.isFinite((m as IngestMark)?.atMs) && Array.isArray((m as IngestMark).files)) : [];
  } catch {
    // deliberate: unparseable marks are none; the next check records a fresh one and waits a settle period.
    return [];
  }
}

/** The newest recorded mark at least {@link ORACLE_INGEST_SETTLE_MS} old; undefined while none has settled. */
export function settledIngestMark(db: ReadModelDb, now: number, settleMs: number = ORACLE_INGEST_SETTLE_MS): IngestMark | undefined {
  return storedMarks(db).filter((m) => m.atMs <= now - settleMs).sort((a, b) => b.atMs - a.atMs)[0];
}

/**
 * Records the store's checkpoints as a mark, at most once per half settle period, and keeps only the
 * newest settled mark beside the younger ones: a bounded list whatever the cadence. Returns when the
 * newest mark was taken.
 */
export function recordIngestMark(db: ReadModelDb, lease: ReadModelLease, now: number, settleMs: number = ORACLE_INGEST_SETTLE_MS): number {
  const marks = storedMarks(db);
  const newest = Math.max(...marks.map((m) => m.atMs));
  if (newest > now - settleMs / 2) return newest;
  const settled = settledIngestMark(db, now, settleMs);
  const kept = marks.filter((m) => m.atMs > now - settleMs).concat(settled ? [settled] : [], [readIngestMark(db, now)]);
  withWriteTransaction(db, lease, () => db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(INGEST_MARKS_KEY, JSON.stringify(kept)));
  return now;
}

/**
 * How many leading bytes of a file's (decompressed) text the mark covers. A checkpoint under the
 * file's own name covers its offset (live, or an archive stopped mid-file) or all of it (an archive
 * of the same size); an archive the mark never named is covered up to the live checkpoint's offset
 * when it is the live file renamed by a rotation (the same inode); anything else is not covered.
 */
function markedLength(own: IngestCheckpoint | undefined, live: IngestCheckpoint | undefined, name: string, ino: string | undefined, rawSize: number, dataLength: number): number {
  if (name === LEDGER_FILENAME) return own !== undefined && own.ino === ino ? Math.min(own.off, dataLength) : 0;
  if (own !== undefined && own.size === rawSize) return own.fp !== null && own.fp.startsWith(PARTIAL_ARCHIVE) ? Math.min(own.off, dataLength) : dataLength;
  return live !== undefined && live.ino === ino ? Math.min(live.off, dataLength) : 0;
}

function isoAt(ms: number): string {
  return fixedClock(ms).iso();
}

function keyOf(id: IdentityKey): string {
  return `${id.tsMs}:${id.h}`;
}

function newlines(buf: Buffer): number {
  let n = 0;
  for (let at = buf.indexOf(0x0a); at >= 0; at = buf.indexOf(0x0a, at + 1)) n++;
  return n;
}

function formOf(path: string): LedgerForm {
  if (basename(path) === LEDGER_FILENAME) return "live";
  return path.endsWith(".gz") ? "gzip" : "plain";
}

/** The fact columns the projector derives from one line, or undefined when it keeps no fact. */
export function factColumns(line: string, factStep: (step: string) => boolean): { step: string; task: string | null; run: string | null } | undefined {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    // deliberate: an unparseable line is never a fact, exactly as the projector counts it torn.
    return undefined;
  }
  const r = row as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || typeof r.step !== "string" || !factStep(r.step)) return undefined;
  const task = typeof r.task_id === "string" ? r.task_id : typeof r.task === "string" ? r.task : null;
  return { step: r.step, task, run: typeof r.run_id === "string" ? r.run_id : null };
}

/** A line's own `ts` in ms, 0 when it has none: such a line falls in no window, as the projector keys it. */
function lineTs(line: string): number {
  const end = line.startsWith('{"ts":"') ? line.indexOf('"', 7) : -1;
  const ms = end > 7 ? Date.parse(line.slice(7, end)) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Reads the files that can hold the window's rows and compares them with the store. Throws
 * {@link ReadModelConsistencyError} when the positive control fails: a file it planned to read
 * went unread, or the window read zero ledger rows.
 */

export function compareWindow(db: ReadModelDb, ledgerDir: string, window: OracleWindow, opts: CompareOptions = {}): WindowComparison {
  // One read snapshot of the store, pinned BEFORE the files are read: a projector writing from
  // another connection meanwhile can add rows the files are then read after, never before.
  const pinned = !db.inTransaction();
  if (pinned) {
    db.exec("BEGIN");
    db.prepare("SELECT count(*) AS n FROM meta").get();
  }
  try {
    return compareSnapshot(db, ledgerDir, window, opts);
  } finally {
    if (pinned && db.inTransaction()) db.exec("COMMIT");
  }
}

interface CompareOptions {
  factStep?: (step: string) => boolean;
  fs?: LedgerGrepFsDeps;
  projections?: readonly LedgerRowProjection[];
  mark?: IngestMark;
  spans?: ReadonlyMap<string, OracleFileSpan>;
}

function compareSnapshot(db: ReadModelDb, ledgerDir: string, window: OracleWindow, opts: CompareOptions): WindowComparison {
  const factStep = opts.factStep ?? isFactStep;
  const base = opts.fs ?? realLedgerFs;
  // Without a mark the store's own checkpoints close the window: nothing it has not reached is compared.
  const mark = opts.mark ?? readIngestMark(db, Number.POSITIVE_INFINITY);
  const byName = new Map(mark.files.map((cp) => [cp.name, cp]));
  const spans = opts.spans ?? new Map<string, OracleFileSpan>();
  // The files that can hold the window's rows: every archive rotated at or after its start whose
  // recorded span (an archive is immutable once named) meets the window or is not known yet, and the
  // live file. The control's own listing, independent of the reader's seam: what SHOULD be read.
  const listing = readdirSync(ledgerDir);
  let skipped = 0;
  const expected = ledgerRotationEntries(listing, ledgerDir).filter((entry) => {
    const name = basename(entry.path);
    const stamp = rotationStampIso(name);
    if (stamp !== undefined && Date.parse(stamp) < window.t0) return false;
    const span = spans.get(name);
    const size = statSync(entry.path, { throwIfNoEntry: false })?.size;
    if (span === undefined || span.size !== size || (span.maxTs >= window.t0 && span.minTs <= window.t1)) return true;
    skipped++;
    return false;
  }).map((entry) => entry.path);
  if (listing.includes(LEDGER_FILENAME)) expected.push(join(ledgerDir, LEDGER_FILENAME));
  const read = new Set<string>();
  const unread: string[] = [];
  const lineCount: Record<LedgerForm, number> = { gzip: 0, plain: 0, live: 0 };
  const learned: OracleFileSpan[] = [];
  // The reader lists through its own seam; a file the control expects that the reader never listed is unread.
  const listedByReader = new Set(base.readdirSync(ledgerDir));
  const lines = new Map<string, string>();
  const ids = new Map<string, IdentityKey>();
  const settledKeys = new Set<string>();
  const unsettledKeys = new Set<string>();
  for (const path of expected) {
    let data: Buffer;
    let rawSize: number;
    try {
      if (!listedByReader.has(basename(path))) throw new Error("the reader never listed it");
      const raw = base.readFileSync(path);
      rawSize = raw.length;
      data = formOf(path) === "gzip" ? base.gunzipSync(raw) : raw;
    } catch (error) {
      // A file that vanished since the listing (compaction moved it aside) was not skipped; any other failure blinds the check.
      if (base.existsSync(path)) unread.push(`${path}: ${(error as Error).message}`);
      continue;
    }
    read.add(path);
    const name = basename(path);
    const marked = markedLength(byName.get(name), byName.get(LEDGER_FILENAME), name, statSync(path, { bigint: true, throwIfNoEntry: false })?.ino.toString(), rawSize, data.length);
    let minTs = Number.POSITIVE_INFINITY;
    let maxTs = Number.NEGATIVE_INFINITY;
    for (let start = 0; start < data.length;) {
      const nl = data.indexOf(0x0a, start);
      const end = nl < 0 ? data.length : nl;
      const line = data.toString("utf8", start, end).trim();
      const at = start;
      start = end + 1;
      if (!line) continue;
      lineCount[formOf(path)]++;
      const ms = lineTs(line);
      minTs = Math.min(minTs, ms);
      maxTs = Math.max(maxTs, ms);
      if (ms < window.t0 || ms > window.t1) continue;
      const id = ledgerLineIdentity(line);
      const key = keyOf(id);
      lines.set(key, line);
      ids.set(key, { tsMs: id.tsMs, h: id.h });
      // A row counts as settled if ANY copy of it sits below the mark; a late copy elsewhere is harmless.
      (at < marked ? settledKeys : unsettledKeys).add(key);
    }
    if (name !== LEDGER_FILENAME && !spans.has(name)) learned.push({ name, size: rawSize, minTs: Number.isFinite(minTs) ? minTs : 0, maxTs: Number.isFinite(maxTs) ? maxTs : 0 });
  }
  const forms = (["gzip", "plain", "live"] as const).map((form): OracleFormRead => ({
    form,
    expected: expected.filter((p) => formOf(p) === form).length,
    read: [...read].filter((p) => formOf(p) === form).length,
    lines: lineCount[form],
  }));
  if (unread.length > 0) {
    const blind = [...new Set(unread.map((u) => formOf(u.split(": ")[0]!)))];
    throw new ReadModelConsistencyError(`the union read left the ${blind.join(" and ")} form unread: ${unread.slice(0, SAMPLE_LIMIT).map((p) => basename(p)).join(", ")}`, { forms, unread });
  }
  const unsettled = new Set([...unsettledKeys].filter((key) => !settledKeys.has(key)));
  if (lines.size === 0) {
    throw new ReadModelConsistencyError(`the window ${isoAt(window.t0)}..${isoAt(window.t1)} read zero ledger rows`, { forms });
  }
  const stored = new Set<string>();
  for (const row of db.prepare("SELECT ts_ms, h FROM seen WHERE ts_ms BETWEEN ? AND ?", { bigInts: true }).iterate(window.t0, window.t1)) {
    stored.add(keyOf({ tsMs: Number(row.ts_ms), h: row.h as bigint }));
  }
  const quarantined = new Set<string>();
  for (const row of db.prepare("SELECT ts_ms, h FROM quarantine WHERE ts_ms BETWEEN ? AND ?", { bigInts: true }).iterate(window.t0, window.t1)) {
    quarantined.add(keyOf({ tsMs: Number(row.ts_ms), h: row.h as bigint }));
  }
  const missing = [...lines.keys()].filter((key) => !stored.has(key) && !unsettled.has(key));
  const ledgerLost = [...stored].filter((key) => !lines.has(key));
  const lost = new Set(ledgerLost);
  const wantFacts = new Map<string, string>();
  for (const [key, line] of lines) {
    if (!quarantined.has(key) && !unsettled.has(key) && factColumns(line, factStep)) wantFacts.set(key, line);
  }
  const matched = new Set<string>();
  const factCorrupt: number[] = [];
  const facts = db.prepare("SELECT seq, ts, step, task_id, run_id, body FROM fact WHERE ts_ms BETWEEN ? AND ?").iterate(window.t0, window.t1);
  for (const row of facts) {
    const body = String(row.body);
    const id = ledgerLineIdentity(body);
    const key = keyOf(id);
    const cols = factColumns(body, factStep);
    const exact = wantFacts.get(key) === body && !matched.has(key) && cols !== undefined && row.ts === id.ts
      && row.step === cols.step && row.task_id === cols.task && row.run_id === cols.run;
    if (exact) matched.add(key);
    else if (!lost.has(key) && !unsettled.has(key)) factCorrupt.push(Number(row.seq));
  }
  const factMissing = [...wantFacts.keys()].filter((key) => !matched.has(key));
  const settled = [...lines].filter(([key]) => !quarantined.has(key) && !unsettled.has(key));
  const projected = compareProjections(db, window, settled, new Set([...lost, ...unsettled]), opts.projections ?? LEDGER_ROW_PROJECTIONS);
  return {
    window, forms, files: { read: read.size, skipped }, spans: learned, ledgerRows: lines.size, storeRows: stored.size, expectedFacts: wantFacts.size,
    missing, ledgerLost, factMissing, factCorrupt, ...projected, quarantined, unsettled, lines, ids,
  };
}

function tableColumns(db: ReadModelDb, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
}

function canonicalRow(row: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(row).sort().map((k) => [k, typeof row[k] === "bigint" ? String(row[k]) : row[k]]));
}

function applyProjections(db: ReadModelDb, projections: readonly LedgerRowProjection[], lines: ReadonlyArray<readonly [string, string]>): void {
  for (const [, line] of lines) {
    let parsed: { row?: Record<string, unknown> } | undefined;
    const parse = (): Record<string, unknown> | undefined => (parsed ??= { row: parseLine(line) }).row;
    for (const p of projections) if (p.markers.some((marker) => line.includes(marker))) p.apply(db, line, ledgerLineIdentity(line), parse);
  }
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const row = JSON.parse(line) as unknown;
    return row !== null && typeof row === "object" ? row as Record<string, unknown> : undefined;
  } catch {
    // deliberate: an unparseable line projects nothing, exactly as the projector skips it.
    return undefined;
  }
}

/**
 * Recomputes each row projection over the window's lines in a scratch database, with the projector's
 * own `apply`, and compares it with the store. A table keyed on `(ts_ms, h)` is compared row for row
 * inside the window; any other table (an aggregate such as a heartbeat) is seeded with the stored rows
 * first, so drift means the window's lines would still move it.
 */
function compareProjections(
  db: ReadModelDb,
  window: OracleWindow,
  lines: ReadonlyArray<readonly [string, string]>,
  lost: ReadonlySet<string>,
  projections: readonly LedgerRowProjection[],
): Pick<WindowComparison, "projectionMissing" | "projectionExtra"> {
  const projectionMissing: string[] = [];
  const projectionExtra: WindowComparison["projectionExtra"] = [];
  const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)));
  const built = projections.filter((p) => p.tables.every((table) => present.has(table)));
  if (built.length === 0) return { projectionMissing, projectionExtra };
  const scratch = openScratchReadModel();
  try {
    const windowed = new Map<string, boolean>();
    for (const p of built) {
      scratch.exec(p.ddl);
      for (const table of p.tables) {
        const columns = tableColumns(db, table);
        windowed.set(table, columns.includes("ts_ms") && columns.includes("h"));
        if (windowed.get(table)) continue;
        const insert = scratch.prepare(`INSERT OR REPLACE INTO ${table}(${columns.join(", ")}) VALUES(${columns.map(() => "?").join(", ")})`);
        for (const row of db.prepare(`SELECT * FROM ${table}`, { bigInts: true }).all()) insert.run(...columns.map((c) => row[c]));
      }
    }
    applyProjections(scratch, built, lines);
    for (const [table, keyed] of windowed) {
      const range = keyed ? " WHERE ts_ms BETWEEN ? AND ?" : "";
      const args = keyed ? [window.t0, window.t1] : [];
      const stored = db.prepare(`SELECT * FROM ${table}${range}`, { bigInts: true }).all(...args);
      const want = scratch.prepare(`SELECT * FROM ${table}${range}`, { bigInts: true }).all(...args);
      const have = new Set(stored.map(canonicalRow));
      const expected = new Set(want.map(canonicalRow));
      for (const row of want) if (!have.has(canonicalRow(row))) projectionMissing.push(`${table} ${keyed ? `${row.ts_ms}:${row.h}` : canonicalRow(row)}`);
      if (!keyed) continue;
      for (const row of stored) {
        const id = { tsMs: Number(row.ts_ms), h: row.h as bigint };
        if (!expected.has(canonicalRow(row)) && !lost.has(keyOf(id))) projectionExtra.push({ table, ...id });
      }
    }
  } finally {
    scratch.close();
  }
  return { projectionMissing, projectionExtra };
}

function projectionDrift(c: WindowComparison): number {
  return c.missing.length + c.factMissing.length + c.factCorrupt.length + c.projectionMissing.length + c.projectionExtra.length;
}

/** Rebuilds the window's projector rows from the ledger: inserts what is missing, deletes what no
 *  ledger row explains. Rows the ledger lost are left in place as evidence. */
function healWindow(db: ReadModelDb, lease: ReadModelLease, c: WindowComparison, factStep: (step: string) => boolean, projections: readonly LedgerRowProjection[]): number {
  return withWriteTransaction(db, lease, () => {
    const drop = db.prepare("DELETE FROM fact WHERE seq = ?");
    const seen = db.prepare("INSERT OR IGNORE INTO seen(ts_ms, h) VALUES(?, ?)");
    const fact = db.prepare("INSERT INTO fact(ts, ts_ms, step, task_id, run_id, body) VALUES(?, ?, ?, ?, ?, ?)");
    let changed = 0;
    for (const seq of c.factCorrupt) changed += drop.run(seq).changes;
    for (const key of c.missing) {
      const id = c.ids.get(key)!;
      changed += seen.run(id.tsMs, id.h).changes;
    }
    for (const key of c.factMissing) {
      const line = c.lines.get(key)!;
      const cols = factColumns(line, factStep)!;
      fact.run(ledgerLineIdentity(line).ts, c.ids.get(key)!.tsMs, cols.step, cols.task, cols.run, line);
      changed++;
    }
    if (c.projectionMissing.length + c.projectionExtra.length > 0) {
      for (const row of c.projectionExtra) changed += db.prepare(`DELETE FROM ${row.table} WHERE ts_ms = ? AND h = ?`).run(row.tsMs, row.h).changes;
      const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)));
      applyProjections(db, projections.filter((p) => p.tables.every((table) => present.has(table))), [...c.lines].filter(([key]) => !c.quarantined.has(key) && !c.unsettled.has(key)));
      changed += c.projectionMissing.length;
    }
    db.prepare("UPDATE meta SET v = CAST(v AS INTEGER) + 1 WHERE k = 'generation'").run();
    return changed;
  });
}

export type ConsistencyOutcome = "agree" | "transient" | "healed" | "drift" | "escalated" | "ledger_lost_known";

export interface ConsistencyRun {
  instance: string;
  outcome: ConsistencyOutcome;
  window: OracleWindow;
  forms: OracleFormRead[];
  ledgerRows: number;
  /** The comparison the outcome rests on: after the recheck, before any heal. */
  mismatches: { missing: number; ledgerLost: number; factMissing: number; factCorrupt: number; projectionMissing: number; projectionExtra: number };
  healedRows: number;
  /** Window rows past the ingest mark, left for a later check. */
  unsettled: number;
  /** Files the last comparison read, and archives it skipped by their recorded span. */
  files: { read: number; skipped: number };
  escalationReasons: string[];
  /** The issue URL, null when escalation failed or no escalation path was supplied. */
  issueUrl: string | null;
  sample: string[];
  elapsedMs: number;
}

export interface ConsistencyCheckOptions {
  db: ReadModelDb;
  ledgerDir: string;
  instance: string;
  /** Where the metric rows go: core's ledger (serve never writes into another daemon's state tree). */
  metricLedgerPath: string;
  /** Only a lease holder heals and keeps the recurrence history; without one the check reports. */
  lease?: ReadModelLease;
  escalation?: EscalateDeps;
  clock?: Clock;
  windowMs?: number;
  /** An explicit closed window (a rolling slice), in place of the one `windowMs` ends at now. */
  window?: OracleWindow;
  factStep?: (step: string) => boolean;
  fs?: LedgerGrepFsDeps;
  /** The row projections the store carries; defaults to the projector's own list. */
  projections?: readonly LedgerRowProjection[];
  /** Only rows below these positions are compared; defaults to the store's checkpoints now. */
  ingestMark?: IngestMark;
}

function lostFingerprint(keys: string[]): string {
  return createHash("sha1").update([...keys].sort().join("\n")).digest("hex").slice(0, 16);
}

function history(db: ReadModelDb): Array<{ atMs: number; outcome: string; healed: number; lostFp: string | null }> {
  const exists = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'consistency_run'").get();
  if (!exists) return [];
  return db.prepare("SELECT at_ms, outcome, healed, lost_fp FROM consistency_run ORDER BY id").all()
    .map((row) => ({ atMs: Number(row.at_ms), outcome: String(row.outcome), healed: Number(row.healed), lostFp: row.lost_fp === null ? null : String(row.lost_fp) }));
}

/** The schedule hook's two tiers: hourly after an agreement, sooner while the last run found anything. */
export const ORACLE_AGREE_INTERVAL_MS = 60 * 60_000;
export const ORACLE_DRIFT_INTERVAL_MS = 10 * 60_000;

/**
 * WHERE THE ORACLE RUNS. Serve's read-model worker asks this before starting a cycle of
 * {@link nextOracleSlice} row-count slices, each run on the oracle's own thread while the projector
 * keeps ticking. On a copy of the host's core ledger one 7-day check took 5-9 s and ~660 MB RSS; a
 * fixed day slice took 1.0-3.3 s (66k-160k rows) and ~165 MB. The
 * full corpus (10.1 s, 730 MB RSS on the same copy) runs only by hand, as the check inside
 * `rmd read-model rebuild --window-days <n>`. Due when no run is recorded, an hour after an
 * agreement, and ten minutes after any other outcome, so a drift is rechecked sooner.
 */
export function consistencyCheckDue(db: ReadModelDb, now: number): boolean {
  const last = history(db).at(-1);
  if (!last) return true;
  return now - last.atMs >= (last.outcome === "agree" ? ORACLE_AGREE_INTERVAL_MS : ORACLE_DRIFT_INTERVAL_MS);
}

/**
 * The rate a first slice is sized from, before any is measured: a day slice of the host's core
 * ledger held 66k-160k rows and took 1.0-3.3 s, about 50 rows per ms.
 */
export const ORACLE_SEED_ROWS_PER_MS = 50;
/** A slice's time budget: one read-model pass (the lease renewal's 5 s times the pass share 0.5). */
export const ORACLE_SLICE_BUDGET_MS = 2_500;
const SLICE_CURSOR_KEY = "oracle_slice";

/**
 * A cycle's fixed `end`, and `next`: the newest instant (inclusive) no slice of this cycle has
 * checked yet. `rowsPerMs` is the measured rate the next slice is sized from; it outlives a cycle.
 */
export interface OracleSliceCursor {
  end: number;
  next: number;
  rowsPerMs: number;
}

/**
 * The next slice of the rolling cycle, sized by ROW COUNT, not by a fixed day: it holds as many
 * of the store's rows as the measured `rowsPerMs` checks in `budgetMs`, so a busy day splits and
 * quiet days merge. Slice `[t0, next]` is followed by one ending at `t0 - 1`, so a cycle tiles
 * `[end - windowMs, end]` with no gap and no overlap. A finished, absent or unreadable cursor starts
 * a new cycle ending at the closed-window edge.
 */
export function nextOracleSlice(
  db: ReadModelDb,
  now: number,
  windowMs: number = ORACLE_DEFAULT_WINDOW_MS,
  budgetMs: number = ORACLE_SLICE_BUDGET_MS,
): { window: OracleWindow; cursor: OracleSliceCursor; startsCycle: boolean; targetRows: number } {
  let stored: Partial<OracleSliceCursor> | null = null;
  try {
    stored = JSON.parse(db.meta(SLICE_CURSOR_KEY) ?? "null") as Partial<OracleSliceCursor> | null;
  } catch {
    // deliberate: an unparseable cursor starts a new cycle, which re-covers every row.
    stored = null;
  }
  const rate = stored && Number.isFinite(stored.rowsPerMs) && stored.rowsPerMs! > 0 ? stored.rowsPerMs! : ORACLE_SEED_ROWS_PER_MS;
  const valid = stored !== null && Number.isFinite(stored.end) && Number.isFinite(stored.next) && stored.next! >= stored.end! - windowMs && stored.next! <= stored.end!;
  const cursor: OracleSliceCursor = valid ? { end: stored!.end!, next: stored!.next!, rowsPerMs: rate } : { end: now - ORACLE_CLOSED_LAG_MS, next: now - ORACLE_CLOSED_LAG_MS, rowsPerMs: rate };
  const floor = cursor.end - windowMs;
  const targetRows = Math.max(1, Math.floor(rate * budgetMs));
  const edge = db.prepare("SELECT ts_ms FROM seen WHERE ts_ms BETWEEN ? AND ? ORDER BY ts_ms DESC LIMIT 1 OFFSET ?").get(floor, cursor.next, targetRows - 1);
  const t0 = edge === undefined ? floor : Number(edge.ts_ms);
  return { window: { t0, t1: cursor.next }, cursor, startsCycle: !valid, targetRows };
}

/**
 * Records that the slice ran: the cycle moves past its oldest instant, and the rate the next slice
 * is sized from moves halfway to what this one measured (rows compared per ms it took). The lease's
 * fence keeps a stale worker from moving it.
 */
export function advanceOracleSlice(db: ReadModelDb, lease: ReadModelLease, slice: { cursor: OracleSliceCursor; window: OracleWindow }, measured?: { rows: number; ms: number }): void {
  const seen = measured && measured.rows > 0 && measured.ms > 0 ? measured.rows / measured.ms : undefined;
  const rowsPerMs = seen === undefined ? slice.cursor.rowsPerMs : (slice.cursor.rowsPerMs + seen) / 2;
  const next = JSON.stringify({ end: slice.cursor.end, next: slice.window.t0 - 1, rowsPerMs });
  withWriteTransaction(db, lease, () => db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(SLICE_CURSOR_KEY, next));
}

/** A slice that could not finish (its thread died) is tried again, at half the rate: a smaller slice. */
export function retryOracleSlice(db: ReadModelDb, lease: ReadModelLease, slice: { cursor: OracleSliceCursor }): void {
  const again = JSON.stringify({ ...slice.cursor, rowsPerMs: slice.cursor.rowsPerMs / 2 });
  withWriteTransaction(db, lease, () => db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(SLICE_CURSOR_KEY, again));
}

function escalationFor(run: ConsistencyRun, detail: string[]): Escalation {
  return {
    class: "MANUAL",
    taskId: metricBase(run.instance).task_id,
    summary: `read model ${run.instance} disagrees with its ledger`,
    detail: [`${run.escalationReasons.join("; ")}.`, ...detail].join("\n\n"),
    options: [
      { label: "investigate the ledger", detail: "A row the read model holds is absent from every rotation form: find the loss (the rotation rename sliver, a power loss) before any rebuild erases the evidence.", kind: { type: "operator-only" } },
      { label: "rebuild the read model", detail: "Run `rmd read-model rebuild` to rebuild the store from the ledger; the views keep serving the old file until the new one passes its own check.", kind: { type: "operator-only" } },
    ],
    recommendation: run.mismatches.ledgerLost > 0 ? "investigate the ledger" : "rebuild the read model",
    consequence: "The views keep serving the drifting projection, and the read-model source stays marked stale until this is resolved.",
  };
}

/**
 * One oracle run. Tiers, by recurrence: a clean window agrees; a mismatch is rechecked (a late row
 * or the rename sliver); drift that persists is healed by rebuilding the window (lease holders
 * only); drift that survives the heal, or recurs within {@link ORACLE_RECURRENCE_MS} of an earlier
 * heal, escalates. A row the ledger lost escalates once per distinct set, and is never healed.
 */
export function runConsistencyCheck(opts: ConsistencyCheckOptions): ConsistencyRun {
  try {
    return runOnce(opts);
  } catch (error) {
    // A blind oracle still leaves its metric row, then fails loudly: it never reports agreement.
    if (error instanceof ReadModelConsistencyError) {
      appendLedger(opts.metricLedgerPath, { ...metricBase(opts.instance), step: READ_MODEL_CONSISTENCY_STEP, check: "ingestion", outcome: "blind", reason: error.message });
    }
    throw error;
  }
}

function metricBase(instance: string): { run_id: string; task_id: string; instance: string } {
  return { run_id: `read-model-${instance}`, task_id: `READ-MODEL-${instance.toUpperCase()}`, instance };
}

function runOnce(opts: ConsistencyCheckOptions): ConsistencyRun {
  const clock = opts.clock ?? systemClock;
  const factStep = opts.factStep ?? isFactStep;
  const started = clock.now();
  const t1 = started - ORACLE_CLOSED_LAG_MS;
  const window = opts.window ?? { t0: t1 - (opts.windowMs ?? ORACLE_DEFAULT_WINDOW_MS), t1 };
  const projections = opts.projections ?? LEDGER_ROW_PROJECTIONS;
  const spans = readSpans(opts.db);
  const learned: OracleFileSpan[] = [];
  const compare = (): WindowComparison => {
    const out = compareWindow(opts.db, opts.ledgerDir, window, { factStep, projections, spans, ...(opts.fs ? { fs: opts.fs } : {}), ...(opts.ingestMark ? { mark: opts.ingestMark } : {}) });
    for (const span of out.spans) spans.set(span.name, span);
    learned.push(...out.spans);
    return out;
  };
  let c = compare();
  let outcome: ConsistencyOutcome = "agree";
  let healedRows = 0;
  const reasons: string[] = [];
  const clean = (x: WindowComparison): boolean => projectionDrift(x) === 0 && x.ledgerLost.length === 0;
  if (!clean(c)) {
    c = compare();
    outcome = clean(c) ? "transient" : "drift";
  }
  const past = history(opts.db);
  const lostFp = c.ledgerLost.length > 0 ? lostFingerprint(c.ledgerLost) : null;
  if (outcome === "drift" && lostFp !== null) {
    if (past.some((row) => row.lostFp === lostFp)) outcome = "ledger_lost_known";
    else reasons.push(`${c.ledgerLost.length} row(s) the projector holds are absent from every ledger rotation form`);
  }
  if (outcome !== "transient" && projectionDrift(c) > 0 && opts.lease) {
    healedRows = healWindow(opts.db, opts.lease, c, factStep, projections);
    outcome = "healed";
    const after = compare();
    if (projectionDrift(after) > 0) reasons.push(`${projectionDrift(after)} projection mismatch(es) survived a rebuild of the window`);
    else if (past.some((row) => row.healed > 0 && row.atMs >= started - ORACLE_RECURRENCE_MS)) reasons.push("the projection drifted again within 24 h of an earlier self-heal");
  }
  if (reasons.length > 0) outcome = "escalated";
  const sample = [...c.missing, ...c.ledgerLost, ...c.factMissing].slice(0, SAMPLE_LIMIT).map((key) => c.lines.get(key) ?? `seen ${key}`)
    .concat(c.projectionMissing.slice(0, SAMPLE_LIMIT).map((row) => `missing ${row}`))
    .concat(c.factCorrupt.slice(0, SAMPLE_LIMIT).map((seq) => `fact seq ${seq}`));
  const run: ConsistencyRun = {
    instance: opts.instance, outcome, window, forms: c.forms, ledgerRows: c.ledgerRows,
    mismatches: { missing: c.missing.length, ledgerLost: c.ledgerLost.length, factMissing: c.factMissing.length, factCorrupt: c.factCorrupt.length,
      projectionMissing: c.projectionMissing.length, projectionExtra: c.projectionExtra.length },
    healedRows, unsettled: c.unsettled.size, files: c.files, escalationReasons: reasons, issueUrl: null, sample, elapsedMs: 0,
  };
  if (reasons.length > 0 && opts.escalation) run.issueUrl = tryEscalate(escalationFor(run, sample.map((s) => `\`${s.slice(0, 300)}\``)), opts.escalation);
  if (opts.lease) {
    // A lost set is remembered only once an issue names it, so a failed escalation is retried next run.
    const escalatedFp = outcome === "ledger_lost_known" || run.issueUrl !== null ? lostFp : null;
    const listed = new Set(readdirSync(opts.ledgerDir));
    withWriteTransaction(opts.db, opts.lease, () => {
      opts.db.exec(CONSISTENCY_DDL);
      opts.db.exec(SPAN_DDL);
      const upsert = opts.db.prepare("INSERT INTO oracle_span(name, size, min_ts, max_ts) VALUES(?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET size = excluded.size, min_ts = excluded.min_ts, max_ts = excluded.max_ts");
      for (const span of learned) upsert.run(span.name, span.size, span.minTs, span.maxTs);
      const drop = opts.db.prepare("DELETE FROM oracle_span WHERE name = ?");
      for (const name of spans.keys()) if (!listed.has(name)) drop.run(name);
      opts.db.prepare(`INSERT INTO consistency_run(at_ms, t0, t1, outcome, ledger_rows, missing, ledger_lost, fact_missing, fact_corrupt, healed, lost_fp)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(started, window.t0, window.t1, outcome, c.ledgerRows, c.missing.length,
        c.ledgerLost.length, c.factMissing.length, c.factCorrupt.length, healedRows, escalatedFp);
    });
  }
  run.elapsedMs = clock.now() - started;
  const metric = metricBase(opts.instance);
  appendLedger(opts.metricLedgerPath, {
    ...metric, step: READ_MODEL_CONSISTENCY_STEP, check: "ingestion", outcome, window: [isoAt(window.t0), isoAt(window.t1)],
    compared: c.ledgerRows, unsettled: c.unsettled.size, files: c.files, mismatches: run.mismatches, forms: c.forms, elapsed_ms: run.elapsedMs, sample: sample.map((s) => s.slice(0, 200)),
    ...(opts.ingestMark ? { ingest_mark_age_ms: started - opts.ingestMark.atMs } : {}),
    ...(run.issueUrl ? { issue_url: run.issueUrl } : {}),
  });
  if (healedRows > 0) appendLedger(opts.metricLedgerPath, { ...metric, step: READ_MODEL_SELF_HEALED_STEP, window: [window.t0, window.t1], healed_rows: healedRows });
  return run;
}
