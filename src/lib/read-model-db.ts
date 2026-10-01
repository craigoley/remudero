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
import { basename, dirname, join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
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

/** `<stateDir>/read-model/<instance>.v<schemaVersion>.sqlite` — a schema bump is a new file. */
export function readModelPath(stateDir: string, instance: string, schemaVersion: number): string {
  if (!INSTANCE_NAME.test(instance)) {
    throw new ReadModelError("bad_instance", `instance name ${JSON.stringify(instance)} is not a safe file name`);
  }
  return join(stateDir, READ_MODEL_DIRNAME, `${instance}.v${schemaVersion}.sqlite`);
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

/** `marker`: the dirty marker this connection wrote and its close removes; only openReadModel's writer owns one. */
function wrap(raw: DatabaseSync, path: string, schemaVersion: number, readOnly: boolean, recoveredFrom?: ReadModelDb["recoveredFrom"], marker?: { path: string; unclean: boolean }): ReadModelDb {
  return {
    path,
    schemaVersion,
    readOnly,
    ...(recoveredFrom ? { recoveredFrom } : {}),
    ...(marker?.unclean ? { uncleanShutdown: true } : {}),
    exec: (sql) => raw.exec(sql),
    prepare: (sql, opts = {}) => {
      const statement: StatementSync = raw.prepare(sql);
      if (opts.bigInts) statement.setReadBigInts(true);
      return statement as unknown as ReadModelStatement;
    },
    meta: (key) => raw.prepare("SELECT v FROM meta WHERE k = ?").get(key)?.v as string | undefined,
    inTransaction: () => raw.isTransaction,
    close: () => {
      raw.close();
      if (marker) rmSync(marker.path, { force: true });
    },
  };
}

/**
 * Opens the connection; any failure throws. A writer runs NO integrity check here: `PRAGMA quick_check`
 * reads every page, 105 s for the 498 MB core file on the loaded host, so the open trusts SQLite's
 * own WAL recovery and the caller checks in the background after an unclean shutdown.
 */
function connect(path: string, readOnly: boolean): DatabaseSync {
  const { DatabaseSync: Database } = require("node:sqlite") as typeof import("node:sqlite");
  const raw = new Database(path, { readOnly, timeout: READ_MODEL_BUSY_TIMEOUT_MS });
  if (readOnly) return raw;
  try {
    raw.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY;
      PRAGMA journal_size_limit=${READ_MODEL_JOURNAL_SIZE_LIMIT_BYTES};`);
    return raw;
  } catch (error) {
    raw.close();
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
    mkdirSync(join(opts.stateDir, READ_MODEL_DIRNAME), { recursive: true });
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
