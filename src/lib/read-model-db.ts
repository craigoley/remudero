/**
 * The read model's node:sqlite adapter (Phase 1 design §1.4, §1.6, §2; P1-01).
 *
 * Every read-model module opens SQLite through this file only. node:sqlite is experimental on
 * Node 22, so a Node upgrade that changes its API breaks this one file and its own test, loudly.
 * The file holds: the per-instance path, the pragmas, the schema meta, corrupt-file recovery, and
 * the writer lease whose fence is re-checked inside every write transaction.
 */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { threadId } from "node:worker_threads";
import { systemClock, type Clock } from "./clock.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";

const require = createRequire(import.meta.url);

export const READ_MODEL_DIRNAME = "read-model";
/** BACKSTOP: how long a connection waits on another's write lock before SQLITE_BUSY (design §2). */
export const READ_MODEL_BUSY_TIMEOUT_MS = 5_000;
/** PRIMARY CONTROL: the size a checkpointed WAL is truncated back to; without it the WAL keeps a
 *  rebuild's high-water mark (105 MB measured on the host, design §2). */
export const READ_MODEL_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
export const READ_MODEL_LEASE_TTL_MS = 20_000;
export const PROJECTOR_LEASE_NAME = "projector";

/** SQLite result codes this adapter treats as "the file is not a usable database". */
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const BASE_DDL = `
  CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS lease(name TEXT PRIMARY KEY, holder TEXT NOT NULL, pid INTEGER NOT NULL,
    host TEXT NOT NULL, acquired_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL) WITHOUT ROWID;
`;

export type ReadModelErrorReason = "bad_instance" | "schema_mismatch" | "lease_lost" | "bad_pointer";

export class ReadModelError extends RmdError {
  readonly reason: ReadModelErrorReason;
  constructor(reason: ReadModelErrorReason, message: string, details: Record<string, unknown> = {}) {
    super("read-model", GENERIC_EXIT_CODE, `read model ${reason}: ${message}`, { reason, ...details });
    this.reason = reason;
  }
}

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

/** The statement surface callers see: node:sqlite's own types never leave this file. */
export interface ReadModelStatement {
  run(...params: SqlValue[]): { changes: number };
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
  iterate(...params: SqlValue[]): Iterable<SqlRow>;
}

export interface ReadModelDb {
  readonly path: string;
  readonly schemaVersion: number;
  readonly readOnly: boolean;
  /** Set when open found an unusable file and moved it aside before creating a fresh one. */
  readonly recoveredFrom?: { corruptPath: string; reason: string };
  /** A writer found the previous writer's dirty marker: it never closed, so the caller checks integrity in the background. */
  readonly uncleanShutdown?: boolean;
  exec(sql: string): void;
  /** `bigInts` reads every INTEGER column as a bigint (64-bit identity hashes need it). */
  prepare(sql: string, opts?: { bigInts?: boolean }): ReadModelStatement;
  meta(key: string): string | undefined;
  inTransaction(): boolean;
  close(): void;
}

export interface ReadModelOpenOptions {
  /** The state dir the read model lives under (design §1.7: core's, for every instance). */
  stateDir: string;
  instance: string;
  schemaVersion: number;
  /** The caller's own tables. Applied idempotently on every writable open. */
  ddl?: string;
  readOnly?: boolean;
  clock?: Clock;
  /** Opens this generation's file instead of the one the pointer names (a rebuild's side file);
   *  `null` opens the un-generationed file, the one in use before any rebuild published a pointer. */
  generation?: string | null;
}

/**
 * `<stateDir>:<dir>`: the DB files of THAT state dir live in `<dir>` (deploy/scratch-mounts.sh binds
 * the scratch disk there). Keyed by state dir, so a test or a worker with its own state dir is never
 * redirected; the switch and sources files stay in `<stateDir>/read-model` on the persistent disk.
 */
export const READ_MODEL_DB_DIR_ENV = "RMD_READ_MODEL_DB_DIR";

/** Where one state dir's DB files, pointer and generations live. */
export function readModelDbDir(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const mapping = env[READ_MODEL_DB_DIR_ENV] ?? "";
  const at = mapping.indexOf(":");
  if (at > 0 && resolve(mapping.slice(0, at)) === resolve(stateDir) && mapping.length > at + 1) return mapping.slice(at + 1);
  return join(stateDir, READ_MODEL_DIRNAME);
}

/**
 * The persistent `<stateDir>/read-model` serve publishes a view's sources file into, from the dir
 * holding the DB: the inverse of {@link readModelDbDir}. A mapped scratch dir answers its state
 * dir's, so a view reading beside its DB never looks on scratch for a file serve wrote to state.
 */
export function readModelSidecarDir(dbDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const mapping = env[READ_MODEL_DB_DIR_ENV] ?? "";
  const at = mapping.indexOf(":");
  if (at > 0 && mapping.length > at + 1 && resolve(mapping.slice(at + 1)) === resolve(dbDir)) return join(mapping.slice(0, at), READ_MODEL_DIRNAME);
  return dbDir;
}

/** `<db dir>/<instance>.v<schemaVersion>.sqlite` — a schema bump is a new file. */
export function readModelPath(stateDir: string, instance: string, schemaVersion: number): string {
  if (!INSTANCE_NAME.test(instance)) {
    throw new ReadModelError("bad_instance", `instance name ${JSON.stringify(instance)} is not a safe file name`);
  }
  return join(readModelDbDir(stateDir), `${instance}.v${schemaVersion}.sqlite`);
}

/** `<instance>.v<N>.g<generation>.sqlite`: a rebuild writes a NEW file and never renames over an open one. */
export function readModelGenerationPath(stateDir: string, instance: string, schemaVersion: number, generation: string): string {
  if (!/^\d{1,16}$/.test(generation)) throw new ReadModelError("bad_pointer", `generation ${JSON.stringify(generation)} is not a number`);
  return join(dirname(readModelPath(stateDir, instance, schemaVersion)), `${instance}.v${schemaVersion}.g${generation}.sqlite`);
}

/** The pointer file naming the generation every reader and the worker open. */
export function readModelPointerPath(stateDir: string, instance: string, schemaVersion: number): string {
  return readModelPath(stateDir, instance, schemaVersion).replace(/\.sqlite$/, ".current");
}

/** The file the pointer names, or the un-generationed path when no rebuild has published one. */
export function currentReadModelPath(stateDir: string, instance: string, schemaVersion: number): string {
  const pointer = readModelPointerPath(stateDir, instance, schemaVersion);
  if (!existsSync(pointer)) return readModelPath(stateDir, instance, schemaVersion);
 const named = readFileSync(pointer, "utf8").trim();
  const prefix = `${instance}.v${schemaVersion}.g`;
  const suffix = ".sqlite";
  const candidate = named.startsWith(prefix) && named.endsWith(suffix)
    ? named.slice(prefix.length, -suffix.length)
    : undefined;
  const generation = candidate !== undefined && /^\d{1,16}$/.test(candidate) ? candidate : undefined;
  if (generation === undefined) throw new ReadModelError("bad_pointer", `${pointer} names ${JSON.stringify(named.slice(0, 80))}, not a generation of ${instance} v${schemaVersion}`, { pointer });
  return readModelGenerationPath(stateDir, instance, schemaVersion, generation);
}

/**
 * Points every future open at `generation`: temp file, fsync, rename, directory fsync. The POINTER
 * is what gets renamed; no database file is ever renamed over one another connection holds open,
 * because its `-wal`/`-shm` siblings resolve by path and would be shared with the new file.
 */
export function publishReadModelGeneration(stateDir: string, instance: string, schemaVersion: number, generation: string): string {
  const target = readModelGenerationPath(stateDir, instance, schemaVersion, generation);
  const pointer = readModelPointerPath(stateDir, instance, schemaVersion);
  const tmp = `${pointer}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, `${basename(target)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, pointer);
  const dirFd = openSync(dirname(pointer), "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  return target;
}

function sqliteErrcode(error: unknown): number | undefined {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" ? code : undefined;
}

/** `<db>.dirty`: written by a writable open, removed by its close; one left behind names an unclean shutdown. */
export function readModelDirtyMarkerPath(path: string): string {
  return `${path}.dirty`;
}

function identifyLockFailure(error: unknown, path: string, connection: string, readOnly: boolean): void {
  const code = sqliteErrcode(error);
  if (error instanceof Error && code !== undefined && [5, 6].includes(code & 0xff)) {
    error.message += ` [connection=${connection}/${readOnly ? "reader" : "writer"} pid=${process.pid} thread=${threadId} path=${path}]`;
  }
}

/** `marker`: the dirty marker this connection wrote and its close removes; only openReadModel's writer owns one. */
function wrap(raw: DatabaseSync, path: string, schemaVersion: number, readOnly: boolean, recoveredFrom?: ReadModelDb["recoveredFrom"], marker?: { path: string; unclean: boolean }): ReadModelDb {
  let reader: DatabaseSync | undefined;
  const connection = randomUUID();
  const checked = <T>(target: DatabaseSync, operation: () => T): T => {
    try {
      return operation();
    } catch (error) {
      identifyLockFailure(error, path, connection, target !== raw || readOnly);
      throw error;
    }
  };
  const reading = (): DatabaseSync => readOnly || path === ":memory:" ? raw : (reader ??= connect(path, true));
  const db: ReadModelDb = {
    path,
    schemaVersion,
    readOnly,
    ...(recoveredFrom ? { recoveredFrom } : {}),
    ...(marker?.unclean ? { uncleanShutdown: true } : {}),
    exec: (sql) => {
      const command = sql.trim().replace(/;$/, "").trim();
      const beginRead = /^BEGIN(?: DEFERRED)?(?: TRANSACTION)?$/i.test(command);
      const endRead = /^(?:COMMIT|END|ROLLBACK)(?: TRANSACTION)?$/i.test(command) && reader?.isTransaction && !raw.isTransaction;
      const target = beginRead ? reading() : endRead ? reader! : raw;
      checked(target, () => target.exec(sql));
    },
    prepare: (sql, opts = {}) => {
      const statement: StatementSync = checked(raw, () => raw.prepare(sql));
      if (opts.bigInts) statement.setReadBigInts(true);
      let readStatement: StatementSync | undefined;
      // Transaction reads see their own writes; PRAGMAs describe the writer's configuration.
      const forRead = (): { target: DatabaseSync; statement: StatementSync } => {
        const target = raw.isTransaction || /^\s*PRAGMA\b/i.test(sql) ? raw : reading();
        if (target === raw) return { target, statement };
        if (!readStatement) {
          readStatement = checked(target, () => target.prepare(sql));
          if (opts.bigInts) readStatement.setReadBigInts(true);
        }
        return { target, statement: readStatement };
      };
      return {
        run: (...params) => checked(raw, () => statement.run(...params)) as { changes: number },
        get: (...params) => {
          const read = forRead();
          return checked(read.target, () => read.statement.get(...params)) as SqlRow | undefined;
        },
        all: (...params) => {
          const read = forRead();
          return checked(read.target, () => read.statement.all(...params)) as SqlRow[];
        },
        iterate: function* (...params) {
          const read = forRead();
          const iterator = checked(read.target, () => read.statement.iterate(...params));
          try {
            for (;;) {
              const next = checked(read.target, () => iterator.next());
              if (next.done) return;
              yield next.value as SqlRow;
            }
          } finally {
            checked(read.target, () => iterator.return?.());
          }
        },
      };
    },
    meta: (key) => db.prepare("SELECT v FROM meta WHERE k = ?").get(key)?.v as string | undefined,
    inTransaction: () => raw.isTransaction || (reader?.isTransaction ?? false),
    close: () => {
      reader?.close();
      raw.close();
      if (marker) rmSync(marker.path, { force: true });
    },
  };
  return db;
}

/**
 * Opens the connection; any failure throws. A writer runs NO integrity check here: `PRAGMA quick_check`
 * reads every page, 105 s for the 498 MB core file on the loaded host, so the open trusts SQLite's
 * own WAL recovery and the caller checks in the background after an unclean shutdown.
 */
function connect(path: string, readOnly: boolean): DatabaseSync {
  const { DatabaseSync: Database } = require("node:sqlite") as typeof import("node:sqlite");
  const connection = randomUUID();
  let raw: DatabaseSync | undefined;
  try {
    raw = new Database(path, { readOnly, timeout: READ_MODEL_BUSY_TIMEOUT_MS });
    if (!readOnly) raw.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY;
      PRAGMA journal_size_limit=${READ_MODEL_JOURNAL_SIZE_LIMIT_BYTES};`);
    return raw;
  } catch (error) {
    raw?.close();
    identifyLockFailure(error, path, connection, readOnly);
    throw error;
  }
}

/** An in-memory database behind the same surface, for a check that must recompute a projection without touching the store. */
export function openScratchReadModel(): ReadModelDb {
  const { DatabaseSync: Database } = require("node:sqlite") as typeof import("node:sqlite");
  return wrap(new Database(":memory:"), ":memory:", 0, false, undefined);
}

/** Moves an unusable file (and its WAL and shared-memory siblings) aside, never deleting it. */
function moveAside(path: string, clock: Clock): string {
  const corruptPath = `${path}.corrupt-${clock.now()}`;
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(path + suffix)) renameSync(path + suffix, corruptPath + suffix);
  }
  return corruptPath;
}

/**
 * Opens one instance's read model. A writable open creates the directory, applies the pragmas and
 * the DDL, and stamps `meta.schema_version`. A corrupt or foreign file is renamed to
 * `.corrupt-<ms>` and replaced by an empty one, because the read model is rebuildable (design §2).
 */
export function openReadModel(opts: ReadModelOpenOptions): ReadModelDb {
  const readOnly = opts.readOnly ?? false;
  const clock = opts.clock ?? systemClock;
  const path = opts.generation === undefined
    ? currentReadModelPath(opts.stateDir, opts.instance, opts.schemaVersion)
    : opts.generation === null
      ? readModelPath(opts.stateDir, opts.instance, opts.schemaVersion)
      : readModelGenerationPath(opts.stateDir, opts.instance, opts.schemaVersion, opts.generation);
  let raw: DatabaseSync;
  let recoveredFrom: ReadModelDb["recoveredFrom"];
  if (readOnly) {
    raw = connect(path, true);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    try {
      raw = connect(path, false);
    } catch (error) {
      const code = sqliteErrcode(error);
      if (code !== SQLITE_CORRUPT && code !== SQLITE_NOTADB) throw error;
      recoveredFrom = { corruptPath: moveAside(path, clock), reason: (error as Error).message };
      raw = connect(path, false);
    }
  }
  const marker = readOnly ? undefined : { path: readModelDirtyMarkerPath(path), unclean: existsSync(readModelDirtyMarkerPath(path)) };
  if (marker) writeFileSync(marker.path, `${process.pid}\n`, { flush: true });
  const db = wrap(raw, path, opts.schemaVersion, readOnly, recoveredFrom, marker);
  if (!readOnly) {
    immediate(db, () => db.exec(`${BASE_DDL} ${opts.ddl ?? ""}
      INSERT OR IGNORE INTO meta(k, v) VALUES('schema_version', '${opts.schemaVersion}');`));
  }
  const stored = db.meta("schema_version");
  if (stored !== String(opts.schemaVersion)) {
    db.close();
    throw new ReadModelError("schema_mismatch", `${path} holds schema ${stored}, expected ${opts.schemaVersion}`, { path, stored });
  }
  return db;
}

/**
 * The integrity check the open no longer runs, on its own read-only connection so a writer keeps
 * committing beside it. `corrupt` separates a damaged file (rebuild it) from one that could not be read
 * at all (busy, missing: ask again later); a rebuild of a healthy-but-unreadable file would be waste.
 */
export function quickCheckReadModel(path: string): { ok: true } | { ok: false; corrupt: boolean; error: string } {
  let raw: DatabaseSync | undefined;
  try {
    raw = connect(path, true);
    const problems = raw.prepare("PRAGMA quick_check").all().map((row) => String(row.quick_check));
    return problems.length === 1 && problems[0] === "ok" ? { ok: true } : { ok: false, corrupt: true, error: `quick_check: ${problems.slice(0, 5).join("; ")}` };
  } catch (error) {
    const code = sqliteErrcode(error);
    return { ok: false, corrupt: code === SQLITE_CORRUPT || code === SQLITE_NOTADB, error: (error as Error).message };
  } finally {
    raw?.close();
  }
}

/**
 * Attaches a second connection to a store another connection already manages (the oracle's
 * thread beside the projector's): no directory, no DDL, no quick_check and never a recovery, so it
 * can never move a live file aside. Writes still go through a lease's fence.
 */
export function attachReadModel(path: string, schemaVersion: number): ReadModelDb {
  const { DatabaseSync: Database } = require("node:sqlite") as typeof import("node:sqlite");
  const db = wrap(new Database(path, { timeout: READ_MODEL_BUSY_TIMEOUT_MS }), path, schemaVersion, false);
  const stored = db.meta("schema_version");
  if (stored !== String(schemaVersion)) {
    db.close();
    throw new ReadModelError("schema_mismatch", `${path} holds schema ${stored}, expected ${schemaVersion}`, { path, stored });
  }
  return db;
}

export interface ReadModelLease {
  readonly name: string;
  readonly holder: string;
  readonly ttlMs: number;
  readonly clock: Clock;
}

export type LeaseAcquisition =
  | { ok: true; lease: ReadModelLease }
  | { ok: false; heldBy: string; pid: number; host: string; expiresMs: number };

/**
 * Takes the named writer lease when it is absent, expired, or already this holder's (a renewal).
 * The read and the write share one `BEGIN IMMEDIATE`, so two contenders cannot both win.
 */
export function acquireLease(
  db: ReadModelDb,
  opts: { name?: string; holder?: string; ttlMs?: number; clock?: Clock } = {},
): LeaseAcquisition {
  const lease: ReadModelLease = {
    name: opts.name ?? PROJECTOR_LEASE_NAME,
    holder: opts.holder ?? randomUUID(),
    ttlMs: opts.ttlMs ?? READ_MODEL_LEASE_TTL_MS,
    clock: opts.clock ?? systemClock,
  };
  return immediate(db, (): LeaseAcquisition => {
    const now = lease.clock.now();
    const row = db.prepare("SELECT holder, pid, host, expires_ms FROM lease WHERE name = ?").get(lease.name);
    if (row && row.holder !== lease.holder && Number(row.expires_ms) > now) {
      return { ok: false, heldBy: String(row.holder), pid: Number(row.pid), host: String(row.host), expiresMs: Number(row.expires_ms) };
    }
    db.prepare(`INSERT INTO lease(name, holder, pid, host, acquired_ms, expires_ms) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, pid = excluded.pid, host = excluded.host,
        acquired_ms = CASE WHEN lease.holder = excluded.holder THEN lease.acquired_ms ELSE excluded.acquired_ms END,
        expires_ms = excluded.expires_ms`).run(lease.name, lease.holder, process.pid, hostname(), now, now + lease.ttlMs);
    return { ok: true, lease };
  });
}

/** Reads the named lease of any read-model file without joining its schema checks: the reaper asks
 *  whether a superseded generation still has a live holder before it deletes the file. */
export function peekLease(path: string, name: string = PROJECTOR_LEASE_NAME): { holder: string; expiresMs: number } | undefined {
  const raw = connect(path, true);
  try {
    const row = raw.prepare("SELECT holder, expires_ms FROM lease WHERE name = ?").get(name);
    return row ? { holder: String(row.holder), expiresMs: Number(row.expires_ms) } : undefined;
  } finally {
    raw.close();
  }
}

/** Gives the lease up (serve's SIGTERM path) so a successor takes it at once. False if not ours. */
export function releaseLease(db: ReadModelDb, lease: ReadModelLease): boolean {
  return db.prepare("DELETE FROM lease WHERE name = ? AND holder = ?").run(lease.name, lease.holder).changes > 0;
}

/**
 * Runs `fn` inside `BEGIN IMMEDIATE` behind the lease's fence (design §1.3). The first statement
 * renews the lease only if this holder still owns it. Zero rows means another writer took it, so
 * the transaction rolls back and throws `lease_lost` before `fn` writes anything.
 */
export function withWriteTransaction<T>(db: ReadModelDb, lease: ReadModelLease, fn: () => T): T {
  return immediate(db, () => {
    const fenced = db
      .prepare("UPDATE lease SET expires_ms = ? WHERE name = ? AND holder = ?")
      .run(lease.clock.now() + lease.ttlMs, lease.name, lease.holder);
    if (fenced.changes === 0) {
      throw new ReadModelError("lease_lost", `holder ${lease.holder} no longer owns the ${lease.name} lease`, { holder: lease.holder });
    }
    return fn();
  });
}

/** One `BEGIN IMMEDIATE` transaction: commits what `fn` returns, rolls back what it throws. */
function immediate<T>(db: ReadModelDb, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.inTransaction()) db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * A producer's persisted output, one row per (instance, name) (arch Phase 4 D10, W1-T5055): the slow lane's
 * analytics refresh writes each instance's `console-v1`, `signals` and `usage-v1` here, so a view answers from
 * the rows after a restart. A failed refresh sets `error` and leaves the last committed `as_of` and `body`.
 */
export const SOURCE_SNAPSHOT_DDL = `CREATE TABLE IF NOT EXISTS source_snapshot(instance TEXT NOT NULL, name TEXT NOT NULL,
  as_of TEXT, body TEXT, error TEXT, error_ms INTEGER, PRIMARY KEY(instance, name)) WITHOUT ROWID;`;

/** One producer run for one instance: every name it produced with their shared source time, or why it failed. */
export type SourceSnapshotWrite =
  | { instance: string; ok: true; asOf: string; bodies: ReadonlyArray<{ name: string; body: unknown }> }
  | { instance: string; ok: false; names: readonly string[]; error: string; atMs: number };

/**
 * Commits one producer run in one fenced transaction: a complete snapshot and its source time land together or
 * not at all, and a failure records why without touching the snapshot it keeps.
 */
export function writeSourceSnapshot(db: ReadModelDb, lease: ReadModelLease, write: SourceSnapshotWrite): void {
  withWriteTransaction(db, lease, () => {
    if (write.ok) {
      const upsert = db.prepare(`INSERT INTO source_snapshot(instance, name, as_of, body, error, error_ms) VALUES(?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(instance, name) DO UPDATE SET as_of = excluded.as_of, body = excluded.body, error = NULL, error_ms = NULL`);
      for (const { name, body } of write.bodies) upsert.run(write.instance, name, write.asOf, JSON.stringify(body));
      return;
    }
    const failed = db.prepare(`INSERT INTO source_snapshot(instance, name, as_of, body, error, error_ms) VALUES(?, ?, NULL, NULL, ?, ?)
      ON CONFLICT(instance, name) DO UPDATE SET error = excluded.error, error_ms = excluded.error_ms`);
    for (const name of write.names) failed.run(write.instance, name, write.error, write.atMs);
  });
}

/** One persisted source snapshot's state, without its body. */
export interface SourceSnapshotState {
  instance: string;
  asOf: string | null;
  error: string | null;
  errorMs: number | null;
}

/** Every instance's row of `name`, bodies left unread: a reader parses a body only when its `asOf` moved. */
export function sourceSnapshotStates(db: ReadModelDb, name: string): SourceSnapshotState[] {
  return db.prepare("SELECT instance, as_of, error, error_ms FROM source_snapshot WHERE name = ? ORDER BY instance").all(name).map((row) => ({
    instance: String(row.instance),
    asOf: row.as_of === null ? null : String(row.as_of),
    error: row.error === null ? null : String(row.error),
    errorMs: row.error_ms === null ? null : Number(row.error_ms),
  }));
}

/** The committed body of one instance's `name`, parsed; undefined when none was ever committed. */
export function readSourceSnapshotBody(db: ReadModelDb, instance: string, name: string): unknown {
  const body = db.prepare("SELECT body FROM source_snapshot WHERE instance = ? AND name = ?").get(instance, name)?.body;
  return body === null || body === undefined ? undefined : JSON.parse(String(body));
}

/**
 * The agent view's fold state per instance (arch Phase 4 §7.1, W1-T5051): `state_json` is the fold of every
 * `fact` row through `last_seq`, so a restart folds only the rows after it instead of the whole store.
 */
export const AGENT_FOLD_DDL = "CREATE TABLE IF NOT EXISTS agent_fold(instance TEXT PRIMARY KEY, last_seq INTEGER NOT NULL, state_json TEXT NOT NULL) WITHOUT ROWID;";

/** One instance's committed fold: the state, and the last fact `seq` it consumed. */
export interface AgentFoldRecord {
  lastSeq: number;
  stateJson: string;
}

/** The committed fold of `instance`; undefined when none was ever committed (or the store predates the table). */
export function readAgentFold(db: ReadModelDb, instance: string): AgentFoldRecord | undefined {
  if (db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'agent_fold'").get() === undefined) return undefined;
  const row = db.prepare("SELECT last_seq, state_json FROM agent_fold WHERE instance = ?").get(instance);
  return row === undefined ? undefined : { lastSeq: Number(row.last_seq), stateJson: String(row.state_json) };
}

/**
 * Commits a fold state and the fact position it consumed in one fenced transaction: both land or neither does,
 * and a writer that lost its lease writes nothing, so the committed pair stays the last whole one.
 */
export function writeAgentFold(db: ReadModelDb, lease: ReadModelLease, instance: string, record: AgentFoldRecord): void {
  withWriteTransaction(db, lease, () => {
    db.exec(AGENT_FOLD_DDL);
    db.prepare(`INSERT INTO agent_fold(instance, last_seq, state_json) VALUES(?, ?, ?)
      ON CONFLICT(instance) DO UPDATE SET last_seq = excluded.last_seq, state_json = excluded.state_json`).run(instance, record.lastSeq, record.stateJson);
  });
}

/** Fact `seq` one fold step reads, so a large delta spreads over several passes. */
export const AGENT_FOLD_CHUNK = 5_000;
/** A fold still catching up commits at least once per this many chunks, so a restart mid-delta re-reads at most these. */
export const AGENT_FOLD_COMMIT_CHUNKS = 20;
const AGENT_FOLD_STATE_VERSION = 1;

interface AgentFoldEntry {
  tsMs: number;
  seq: number;
  row: Record<string, unknown>;
}

interface AgentFoldState {
  /** Every fact through this `seq` is folded. */
  seq: number;
  entries: AgentFoldEntry[];
  /** The `seq` of the pair last committed to `agent_fold`, and whether rows were folded since. */
  committed: number;
  dirty: boolean;
}

/** One instance's store as the fold sees it; without a lease the fold advances in memory only. */
export interface AgentFoldSlot {
  instance: string;
  db: ReadModelDb;
  lease?: ReadModelLease;
  log?: (step: string, extra: Record<string, unknown>) => void;
}

/** The `panel.*` facts of each instance, folded incrementally and persisted in `agent_fold` (arch Phase 4 §7.1). */
export interface AgentFolds {
  /** Folds one chunk per `more()`; true once the fold holds the store's newest fact. */
  advance(slot: AgentFoldSlot, more: () => boolean): boolean;
  /** The folded rows, oldest first (by `ts`, then `seq`), with every remaining fact folded first. */
  current(slot: AgentFoldSlot): { seq: number; rows: Array<Record<string, unknown>>; newestTsMs: number };
}

/** The committed fold, or an empty one when none was committed, it has another version, or the store shrank under it. */
function loadAgentFold(db: ReadModelDb, instance: string, max: number): AgentFoldState {
  const record = readAgentFold(db, instance);
  if (record !== undefined && record.lastSeq <= max) {
    const state = JSON.parse(record.stateJson) as { version?: number; entries?: AgentFoldEntry[] };
    if (state.version === AGENT_FOLD_STATE_VERSION && Array.isArray(state.entries)) return { seq: record.lastSeq, entries: state.entries, committed: record.lastSeq, dirty: false };
  }
  return { seq: 0, entries: [], committed: 0, dirty: false };
}

/**
 * The per-store folds. A step reads only facts past the fold's `seq`; the state and the `seq` it consumed are
 * committed together once caught up, or every {@link AGENT_FOLD_COMMIT_CHUNKS} chunks while catching up. A refused
 * commit (a lost lease) is logged and the in-memory fold carries on; the committed pair stays the last whole one.
 * `onStep` sees each step's range and the rows it read.
 */
export function createAgentFolds(opts: { chunk?: number; onStep?: (step: { instance: string; from: number; through: number; rows: number }) => void } = {}): AgentFolds {
  const chunk = opts.chunk ?? AGENT_FOLD_CHUNK;
  const span = AGENT_FOLD_COMMIT_CHUNKS * chunk;
  const folds = new WeakMap<ReadModelDb, AgentFoldState>();
  const foldOf = (slot: AgentFoldSlot): { fold: AgentFoldState; max: number } => {
    const max = Number(slot.db.prepare("SELECT coalesce(max(seq), 0) AS m FROM fact").get()?.m);
    let fold = folds.get(slot.db);
    if (!fold || max < fold.seq) folds.set(slot.db, (fold = loadAgentFold(slot.db, slot.instance, max)));
    return { fold, max };
  };
  const step = (slot: AgentFoldSlot, fold: AgentFoldState, through: number, max: number): void => {
    const fresh = slot.db.prepare("SELECT seq, ts_ms, body FROM fact WHERE seq > ? AND seq <= ? AND step LIKE 'panel.%' ORDER BY seq").all(fold.seq, through);
    opts.onStep?.({ instance: slot.instance, from: fold.seq, through, rows: fresh.length });
    for (const fact of fresh) fold.entries.push({ tsMs: Number(fact.ts_ms), seq: Number(fact.seq), row: JSON.parse(String(fact.body)) as Record<string, unknown> });
    if (fresh.length > 0) fold.entries.sort((a, b) => a.tsMs - b.tsMs || a.seq - b.seq);
    fold.seq = through;
    fold.dirty ||= fresh.length > 0;
    if (!fold.dirty || slot.lease === undefined || (through < max && through - fold.committed < span)) return;
    try {
      writeAgentFold(slot.db, slot.lease, slot.instance, { lastSeq: fold.seq, stateJson: JSON.stringify({ version: AGENT_FOLD_STATE_VERSION, entries: fold.entries }) });
      fold.committed = fold.seq;
      fold.dirty = false;
    } catch (error) {
      slot.log?.("agent.fold_commit_failed", { instance: slot.instance, seq: fold.seq, committed: fold.committed, error: (error as Error).message });
    }
  };
  return {
    advance: (slot, more) => {
      const { fold, max } = foldOf(slot);
      while (fold.seq < max) {
        if (!more()) return false;
        step(slot, fold, Math.min(max, fold.seq + chunk), max);
      }
      return true;
    },
    current: (slot) => {
      const { fold, max } = foldOf(slot);
      if (max > fold.seq) step(slot, fold, max, max);
      return { seq: fold.seq, rows: fold.entries.map((entry) => entry.row), newestTsMs: fold.entries.at(-1)?.tsMs ?? Number.NEGATIVE_INFINITY };
    },
  };
}

/** The worker's one set of folds, shared by the agent view and the nav badge so neither counts past the other. */
export const AGENT_FOLDS: AgentFolds = createAgentFolds();
