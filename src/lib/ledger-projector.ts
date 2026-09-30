/**
 * The ledger projector: tails one instance's ledger into its read model (Phase 1 design §1.1–§1.3;
 * P1-02). The ledger stays authoritative and the read model is rebuildable from it (W1-T3196).
 *
 * It reads every rotation form a union reader must read: the live file, dated and part-numbered
 * archives, gzip or plain (`ledgerRotationEntries`). A row's identity is its exact line, keyed on
 * its own `ts` so inserts land near the B-tree's right edge (a random key cost 151 s against 6.1 s
 * on the fleet host). Rows and the checkpoint covering them commit in one fenced transaction, so a
 * crash at any point resumes to exactly what a clean rebuild produces.
 */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { systemClock, type Clock } from "./clock.js";
import { DECISION_RELEVANT_LEDGER_STEPS, MODEL_ATTRIBUTION_LEDGER_STEPS, RENDER_RELEVANT_LEDGER_STEPS } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { ledgerRotationEntries, type LedgerCorpusEntry } from "./ledger-union.js";
import { openReadModel, withWriteTransaction, type ReadModelDb, type ReadModelLease } from "./read-model-db.js";
import { REPO_ROW_PROJECTION } from "./repo-ledger-index.js";

export const LEDGER_PROJECTOR_SCHEMA_VERSION = 1;
/** A row stamped further ahead of ingest time than this is quarantined, not applied (design §1.2). */
export const FUTURE_ROW_TOLERANCE_MS = 5 * 60_000;
/** The live file is read in pieces of this size, one transaction each (design §1.1). */
export const DEFAULT_CHUNK_BYTES = 8 << 20;
/** A directory mtime younger than this may still move within the same timestamp tick. */
export const DIR_GATE_SETTLE_MS = 2_000;
/** A closed gate re-lists after this long anyway: a directory whose mtime failed to move never hides a rotation for good. */
export const DIR_GATE_RELIST_MS = 60_000;
/** The fewest lines a tick's first transaction applies, so a collapsed rate estimate still moves a backlog. */
export const MIN_TRANSACTION_LINES = 64;
const FINGERPRINT_BYTES = 4_096;
/**
 * An archive checkpoint names its bytes, never its inode: a deleted archive's inode is recycled, so
 * a new file can arrive with an old name, inode and size. A read archive's `fp` is `head:<sha1>`;
 * one stopped mid-file is `partial:<decompressed length>:<sha1>`, its `off` into the decompressed text.
 */
const ARCHIVE_HEAD = "head:";
const PARTIAL_ARCHIVE = "partial:";
const STEP_KEY = '"step":"';

export const LEDGER_PROJECTOR_DDL = `
  CREATE TABLE IF NOT EXISTS source_file(name TEXT PRIMARY KEY, ino TEXT NOT NULL, size INTEGER NOT NULL,
    off INTEGER NOT NULL, fp TEXT) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS seen(ts_ms INTEGER NOT NULL, h INTEGER NOT NULL, PRIMARY KEY(ts_ms, h)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS fact(seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, ts_ms INTEGER NOT NULL, step TEXT NOT NULL,
    task_id TEXT, run_id TEXT, body TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS fact_task ON fact(task_id, seq) WHERE task_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS quarantine(ts_ms INTEGER NOT NULL, h INTEGER NOT NULL, ts TEXT NOT NULL, step TEXT NOT NULL,
    ingested_ms INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(ts_ms, h)) WITHOUT ROWID;
  INSERT OR IGNORE INTO meta(k, v) VALUES('generation', '0');
`;

/** Opens (or creates) one instance's projector read model under `stateDir` (core's, design §1.7). */
export function openProjectorReadModel(stateDir: string, instance: string, clock?: Clock, generation?: string | null): ReadModelDb {
  return openReadModel({ stateDir, instance, schemaVersion: LEDGER_PROJECTOR_SCHEMA_VERSION, ddl: LEDGER_PROJECTOR_DDL, ...(clock ? { clock } : {}), ...(generation !== undefined ? { generation } : {}) });
}

/** The steps the fact store keeps (design §3.5 `FACT_STEPS`); every other row is identity-only. */
export function isFactStep(step: string): boolean {
  return DECISION_RELEVANT_LEDGER_STEPS.has(step) || RENDER_RELEVANT_LEDGER_STEPS.has(step)
    || MODEL_ATTRIBUTION_LEDGER_STEPS.has(step) || step === "worker.assignment" || step.startsWith("panel.");
}

/** Row identity: `(ts_ms, first 8 bytes of sha1(line))`, the exact-line equivalence W1-T4820 uses. */
export function ledgerLineIdentity(line: string): { ts: string; tsMs: number; h: bigint } {
  const end = line.startsWith('{"ts":"') ? line.indexOf('"', 7) : -1;
  const ts = end > 7 ? line.slice(7, end) : "";
  const parsed = ts ? Date.parse(ts) : Number.NaN;
  return { ts, tsMs: Number.isFinite(parsed) ? parsed : 0, h: createHash("sha1").update(line).digest().readBigInt64BE(0) };
}

/**
 * A table the projector maintains beside `fact`, fed each fresh line whose text carries one of its
 * `markers`, inside the transaction that checkpoints that line (design D3/D4). A projection whose
 * `version` a store has not built is rebuilt from the ledger: the store forgets every file it read.
 */
export interface LedgerRowProjection {
  name: string;
  version: number;
  tables: readonly string[];
  ddl: string;
  markers: readonly string[];
  apply(db: ReadModelDb, line: string, id: { ts: string; tsMs: number; h: bigint }, parse: () => Record<string, unknown> | undefined): void;
}

/** Every projection a store carries; a view that needs a table no projection keeps adds one here. */
export const LEDGER_ROW_PROJECTIONS: readonly LedgerRowProjection[] = [REPO_ROW_PROJECTION];

export interface LedgerProjectorOptions {
  /** The instance's state dir: the one holding its live ledger and rotation archives. */
  ledgerDir: string;
  db: ReadModelDb;
  lease: ReadModelLease;
  clock?: Clock;
  factStep?: (step: string) => boolean;
  chunkBytes?: number;
  /** Runs inside each transaction after its rows and before its checkpoint (the crash tests' seam). */
  beforeCheckpoint?: (source: string) => void;
  /** Runs after an archive descriptor is opened and identified, before its contents are read. */
  beforeArchiveRead?: (path: string) => void;
  projections?: readonly LedgerRowProjection[];
}

export interface ProjectorTickResult {
  /** False when the directory-mtime gate skipped the rotation listing. */
  listed: boolean;
  archivesRead: number;
  liveBytes: number;
  /** True when the live file was replaced (a rotation) and re-read from byte 0. */
  liveRestarted: boolean;
  lines: number;
  fresh: number;
  duplicates: number;
  facts: number;
  quarantined: number;
  torn: number;
  transactions: number;
  /** Archives that could not be read this tick; each is retried on the next one. */
  unread: string[];
  /** True when the tick stopped at its budget with rows still to apply: the next tick resumes. */
  pending: boolean;
  /** Source bytes (compressed, for an archive) this tick consumed, and those still unapplied when it stopped. */
  sourceBytes: number;
  backlogBytes: number;
}

export interface LedgerProjector {
  /**
   * Applies what the ledger has beyond the checkpoints. With `budgetMs`, no new transaction starts
   * once the budget is spent (the first always runs), and each is sized from the measured rows per
   * ms to fit what is left, so a backlog becomes many short ticks. Without it, everything is applied.
   */
  tick(budget?: { budgetMs: number }): ProjectorTickResult;
}

interface Checkpoint {
  ino: string;
  size: number;
  off: number;
  fp: string | null;
}

/** Hash of the first and last {@link FINGERPRINT_BYTES} before `upTo`: a replaced file fails it. */
function fingerprint(fd: number, upTo: number): string {
  const hash = createHash("sha1");
  for (const from of [0, Math.max(0, upTo - FINGERPRINT_BYTES)]) {
    const len = Math.min(FINGERPRINT_BYTES, upTo - from);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, from);
    hash.update(buf);
  }
  return hash.digest("hex");
}

/** Hash of an archive's first {@link FINGERPRINT_BYTES}: with its size, the identity of an immutable file. */
function headFingerprint(fd: number, size: number): string {
  const buf = Buffer.alloc(Math.min(FINGERPRINT_BYTES, size));
  readSync(fd, buf, 0, buf.length, 0);
  return createHash("sha1").update(buf).digest("hex");
}

function parseRow(line: string): Record<string, unknown> | undefined {
  try {
    const row: unknown = JSON.parse(line);
    return row !== null && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : undefined;
  } catch {
    // deliberate: a malformed complete line is counted torn by the caller, as the union reader does.
    return undefined;
  }
}

export function createLedgerProjector(opts: LedgerProjectorOptions): LedgerProjector {
  const { db, lease, ledgerDir } = opts;
  const clock = opts.clock ?? systemClock;
  const factStep = opts.factStep ?? isFactStep;
  const chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const projections = opts.projections ?? LEDGER_ROW_PROJECTIONS;
  let projectionsBuilt = false;
  const sql = {
    seen: db.prepare("INSERT OR IGNORE INTO seen(ts_ms, h) VALUES(?, ?)"),
    fact: db.prepare("INSERT INTO fact(ts, ts_ms, step, task_id, run_id, body) VALUES(?, ?, ?, ?, ?, ?)"),
    quarantine: db.prepare("INSERT INTO quarantine(ts_ms, h, ts, step, ingested_ms, body) VALUES(?, ?, ?, ?, ?, ?)"),
    checkpoint: db.prepare(`INSERT INTO source_file(name, ino, size, off, fp) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET ino = excluded.ino, size = excluded.size, off = excluded.off, fp = excluded.fp`),
    generation: db.prepare("UPDATE meta SET v = CAST(v AS INTEGER) + 1 WHERE k = 'generation'"),
    checkpoints: db.prepare("SELECT name, ino, size, off, fp FROM source_file"),
    forget: db.prepare("DELETE FROM source_file WHERE name = ?"),
  };
  let gateMtimeMs: number | undefined;
  let listedAt = Number.NEGATIVE_INFINITY;
  /** Rows applied per ms in the last timed transaction; unknown until one took measurable time. */
  let linesPerMs: number | undefined;
  let deadline = Number.POSITIVE_INFINITY;

  /** Out of budget: every tick applies at least one transaction, so a backlog always moves. */
  function spent(c: ProjectorTickResult): boolean {
    return c.transactions > 0 && clock.now() >= deadline;
  }

  /** Where the next transaction ends: the whole range, or as many lines as fit what is left of the budget. */
  function rangeEnd(buf: Buffer, from: number, to: number, c: ProjectorTickResult): number {
    if (linesPerMs === undefined || deadline === Number.POSITIVE_INFINITY) return to;
    let lines = Math.max(c.transactions === 0 ? MIN_TRANSACTION_LINES : 1, Math.floor(linesPerMs * (deadline - clock.now())));
    let at = from;
    while (lines-- > 0) {
      const nl = buf.indexOf(0x0a, at);
      if (nl < 0 || nl >= to) return to;
      at = nl + 1;
    }
    return at;
  }

  /** Creates each projection's tables; one this store has not built empties the store so the tick re-reads it all. */
  function buildProjections(): void {
    const stale = projections.filter((p) => db.prepare("SELECT v FROM meta WHERE k = ?").get(`projection:${p.name}`)?.v !== String(p.version));
    if (stale.length > 0) {
      withWriteTransaction(db, lease, () => {
        for (const p of projections) db.exec(p.ddl);
        if (Number(db.prepare("SELECT count(*) AS n FROM source_file").get()?.n) > 0) {
          for (const table of ["seen", "fact", "quarantine", "source_file", ...projections.flatMap((p) => p.tables)]) db.exec(`DELETE FROM ${table}`);
        }
        for (const p of stale) db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(`projection:${p.name}`, String(p.version));
      });
    }
    projectionsBuilt = true;
  }

  function applyText(text: string, now: number, c: ProjectorTickResult): void {
    for (let start = 0, nl = text.indexOf("\n"); nl >= 0; start = nl + 1, nl = text.indexOf("\n", start)) {
      const line = text.slice(start, nl).trim();
      if (!line) continue;
      c.lines++;
      const id = ledgerLineIdentity(line);
      if (sql.seen.run(id.tsMs, id.h).changes === 0) {
        c.duplicates++;
        continue;
      }
      c.fresh++;
      const at = line.indexOf(STEP_KEY);
      const scanned = at < 0 ? "" : line.slice(at + STEP_KEY.length, line.indexOf('"', at + STEP_KEY.length));
      if (id.tsMs > now + FUTURE_ROW_TOLERANCE_MS) {
        sql.quarantine.run(id.tsMs, id.h, id.ts, scanned, now, line);
        c.quarantined++;
        continue;
      }
      let parsed: { row?: Record<string, unknown> } | undefined;
      const parse = (): Record<string, unknown> | undefined => (parsed ??= { row: parseRow(line) }).row;
      for (const p of projections) if (p.markers.some((marker) => line.includes(marker))) p.apply(db, line, id, parse);
      // A second `"step":"` means the first may be nested, so only a parse can name the row's step.
      const ambiguous = at >= 0 && line.includes(STEP_KEY, at + STEP_KEY.length);
      if (!ambiguous && !(at >= 0 && factStep(scanned))) continue;
      const row = parse();
      if (!row) {
        c.torn++;
        continue;
      }
      if (typeof row.step !== "string" || !factStep(row.step)) continue;
      const task = typeof row.task_id === "string" ? row.task_id : typeof row.task === "string" ? row.task : null;
      sql.fact.run(id.ts, id.tsMs, row.step, task, typeof row.run_id === "string" ? row.run_id : null, line);
      c.facts++;
    }
  }

  function commit(source: string, c: ProjectorTickResult, apply: () => void, checkpoint: Checkpoint): void {
    const started = clock.now();
    const linesBefore = c.lines;
    withWriteTransaction(db, lease, () => {
      apply();
      opts.beforeCheckpoint?.(source);
      sql.checkpoint.run(source, checkpoint.ino, checkpoint.size, checkpoint.off, checkpoint.fp);
      sql.generation.run();
    });
    c.transactions++;
    // A transaction too fast to time is measured as 1 ms: skipping it would pin a collapsed estimate forever.
    if (c.lines > linesBefore) linesPerMs = (c.lines - linesBefore) / Math.max(1, clock.now() - started);
  }

  /** The decompressed length of an archive stopped mid-file; undefined for one read whole. */
  function partialLength(prev: Checkpoint): number | undefined {
    return prev.fp !== null && prev.fp.startsWith(PARTIAL_ARCHIVE) ? Number(prev.fp.slice(PARTIAL_ARCHIVE.length).split(":")[0]) : undefined;
  }

  /** Whether a checkpoint describes these bytes: same size and head. A checkpoint without a head is re-read once. */
  function sameArchive(prev: Checkpoint, head: string, size: number): boolean {
    return prev.size === size && prev.fp !== null && (prev.fp === `${ARCHIVE_HEAD}${head}` || (prev.fp.startsWith(PARTIAL_ARCHIVE) && prev.fp.endsWith(`:${head}`)));
  }

  /** The part of an archive not yet applied, in source bytes; a partial one is prorated. */
  function archiveBacklog(prev: Checkpoint | undefined, head: string, size: number): number {
    if (!prev || !sameArchive(prev, head, size)) return size;
    const length = partialLength(prev);
    return length === undefined ? 0 : Math.round(size * (1 - prev.off / length));
  }

  function ingestArchive(entry: LedgerCorpusEntry, known: Map<string, Checkpoint>, now: number, c: ProjectorTickResult): boolean {
    const name = basename(entry.path);
    let data: Buffer;
    let ino: string;
    let size: number;
    let head: string;
    let fd: number | undefined;
    const prev = known.get(name);
    try {
      fd = openSync(entry.path, "r");
      const st = fstatSync(fd, { bigint: true });
      ino = String(st.ino);
      size = Number(st.size);
      head = headFingerprint(fd, size);
      if (archiveBacklog(prev, head, size) === 0) return true; // a rotation is immutable once named
      if (spent(c)) {
        c.pending = true;
        c.backlogBytes += archiveBacklog(prev, head, size);
        return false;
      }
      opts.beforeArchiveRead?.(entry.path);
      const raw = readFileSync(fd);
      data = entry.form === "gzip" ? gunzipSync(raw) : raw;
      if (data.length > 0 && data[data.length - 1] !== 0x0a) data = Buffer.concat([data, Buffer.from("\n")]);
    } catch (error) {
      // Named in `unread` and retried next tick: a vanished or half-readable archive never wedges the tail.
      c.unread.push(`${name}: ${(error as Error).message}`);
      return false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const partial = prev !== undefined && partialLength(prev) !== undefined && sameArchive(prev, head, size) ? prev : undefined;
    let off = partial ? partial.off : 0;
    do {
      if (spent(c)) {
        c.pending = true;
        c.backlogBytes += Math.round(size * (1 - off / data.length));
        return false;
      }
      const from = off;
      const to = rangeEnd(data, from, data.length, c);
      const done = to >= data.length;
      commit(name, c, () => applyText(data.toString("utf8", from, to), now, c), done ? { ino, size, off: size, fp: `${ARCHIVE_HEAD}${head}` } : { ino, size, off: to, fp: `${PARTIAL_ARCHIVE}${data.length}:${head}` });
      c.sourceBytes += Math.round(size * ((to - from) / Math.max(1, data.length)));
      off = to;
    } while (off < data.length);
    c.archivesRead++;
    return true;
  }

  function listRotations(known: Map<string, Checkpoint>, now: number, c: ProjectorTickResult): void {
    const dirMtimeMs = statSync(ledgerDir).mtimeMs;
    if (gateMtimeMs !== undefined && dirMtimeMs === gateMtimeMs && now - listedAt < DIR_GATE_RELIST_MS) return;
    c.listed = true;
    listedAt = now;
    const names = readdirSync(ledgerDir);
    let complete = true;
    for (const entry of ledgerRotationEntries(names, ledgerDir)) complete = ingestArchive(entry, known, now, c) && complete;
    const present = new Set(names);
    const gone = [...known.keys()].filter((name) => !present.has(name));
    if (gone.length > 0) withWriteTransaction(db, lease, () => gone.forEach((name) => sql.forget.run(name)));
    // Close the gate only on a settled mtime: a change inside the same timestamp tick would not move it.
    gateMtimeMs = complete && now - dirMtimeMs > DIR_GATE_SETTLE_MS ? dirMtimeMs : undefined;
  }

  function tailLive(known: Map<string, Checkpoint>, now: number, c: ProjectorTickResult): void {
    const path = join(ledgerDir, LEDGER_FILENAME);
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // no live file yet: nothing to tail
      throw error;
    }
    try {
      const st = fstatSync(fd, { bigint: true });
      const ino = String(st.ino);
      const size = Number(st.size);
      const prev = known.get(LEDGER_FILENAME);
      if (prev && prev.ino === ino && prev.off === size) return;
      // A rotation replaces the live file by rename (a new inode); a same-inode rewrite fails the fingerprint.
      const resumable = prev !== undefined && prev.ino === ino && prev.off <= size && prev.fp === fingerprint(fd, prev.off);
      let off = resumable ? prev.off : 0;
      c.liveRestarted = prev !== undefined && !resumable;
      for (let want = chunkBytes; off < size;) {
        if (spent(c)) {
          c.pending = true;
          c.backlogBytes += size - off;
          break;
        }
        const buf = Buffer.alloc(Math.min(want, size - off));
        readSync(fd, buf, 0, buf.length, off);
        const lastNl = buf.lastIndexOf(0x0a);
        if (lastNl < 0) {
          if (off + buf.length >= size) break; // a torn tail waits for its writer's newline
          want *= 2;
          continue;
        }
        const end = rangeEnd(buf, 0, lastNl + 1, c);
        const next = off + end;
        commit(LEDGER_FILENAME, c, () => applyText(buf.toString("utf8", 0, end), now, c), { ino, size, off: next, fp: fingerprint(fd, next) });
        c.liveBytes += end;
        c.sourceBytes += end;
        off = next;
        want = chunkBytes;
      }
    } finally {
      closeSync(fd);
    }
  }

  return {
    tick(budget?: { budgetMs: number }): ProjectorTickResult {
      if (!projectionsBuilt) buildProjections();
      const now = clock.now();
      deadline = budget ? now + budget.budgetMs : Number.POSITIVE_INFINITY;
      const c: ProjectorTickResult = {
        listed: false, archivesRead: 0, liveBytes: 0, liveRestarted: false, lines: 0, fresh: 0, duplicates: 0,
        facts: 0, quarantined: 0, torn: 0, transactions: 0, unread: [], pending: false, sourceBytes: 0, backlogBytes: 0,
      };
      const known = new Map<string, Checkpoint>();
      for (const row of sql.checkpoints.all()) {
        known.set(String(row.name), { ino: String(row.ino), size: Number(row.size), off: Number(row.off), fp: row.fp === null ? null : String(row.fp) });
      }
      listRotations(known, now, c);
      tailLive(known, now, c);
      return c;
    },
  };
}

/** An order-independent digest of everything the projector derived: two stores built from the
 *  same ledger by any path (rebuild, resume, incremental) digest equal. */
export function readModelDigest(db: ReadModelDb): string {
  const hash = createHash("sha256");
  const queries = [
    "SELECT 'seen' AS t, ts_ms, h FROM seen ORDER BY ts_ms, h",
    "SELECT 'fact' AS t, ts, step, task_id, run_id, body FROM fact ORDER BY ts_ms, body",
    "SELECT 'quarantine' AS t, ts_ms, h, step, body FROM quarantine ORDER BY ts_ms, h",
  ];
  for (const query of queries) {
    for (const row of db.prepare(query, { bigInts: true }).iterate()) {
      hash.update(JSON.stringify(row, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)));
      hash.update("\n");
    }
  }
  return hash.digest("hex");
}
