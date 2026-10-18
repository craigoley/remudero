/**
 * The read model's node:sqlite adapter (Phase 1 design §1.4, §1.6, §2; P1-01).
 *
 * Every read-model module opens SQLite through this file only. node:sqlite is experimental on
 * Node 22, so a Node upgrade that changes its API breaks this one file and its own test, loudly.
 * The file holds: the per-instance path, the pragmas, the schema meta, corrupt-file recovery, and
 * the writer lease whose fence is re-checked inside every write transaction.
 */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, opendirSync, readFileSync, readlinkSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { SHARE_ENV, threadId, Worker } from "node:worker_threads";
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
  transactionObservation?: ReadModelTransactionObservationOptions;
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

export interface ReadModelProcessIdentity {
  pid: number;
  bootId: string;
  pidNamespace: string;
  startTicks: string;
}
type ProcessInspection = { status: "identified"; identity: ReadModelProcessIdentity } | { status: "missing" | "unknown" };

/** Linux identities are comparable only in the same boot and PID namespace. Other platforms are unknown. */
function inspectReadModelProcess(pid: number): ProcessInspection {
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const pidNamespace = readlinkSync(`/proc/${pid}/ns/pid`);
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (!bootId || !pidNamespace || !startTicks || !/^\d+$/.test(startTicks)) return { status: "unknown" };
    return { status: "identified", identity: { pid, bootId, pidNamespace, startTicks } };
  } catch (error) {
    // Procfs may hide a live foreign UID. Only ESRCH confirms absence within the caller's namespace.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try { process.kill(pid, 0); }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code === "ESRCH") return { status: "missing" }; }
    }
    return { status: "unknown" };
  }
}

export function readModelProcessIdentity(): ReadModelProcessIdentity | undefined {
  const read = inspectReadModelProcess(process.pid);
  return read.status === "identified" ? read.identity : undefined;
}

type TransactionRecord = {
  connection: string; transaction: string; recorder: string; label: string; pid: number; thread: number;
  identity?: ReadModelProcessIdentity; recordedState: "attempting" | "recorded-acquired" | "released";
  attemptedAt: number; acquiredAt?: number; updatedAt: number;
};
export interface ReadModelTransactionObservationOptions {
  label?: string;
  identity?: () => ReadModelProcessIdentity | undefined;
  clock?: Clock;
  /** Diagnostic seams never replace SQLite, its timeout, or its ordering. */
  publish?: (file: string, record: TransactionRecord) => void;
  remove?: (file: string) => void;
  report?: (step: string, extra: Record<string, unknown>) => void;
}
export interface ReadModelTransactionInventory {
  asOf: number;
  state: "observed" | "none-recorded" | "unknown";
  complete: boolean;
  inspected: number;
  unknownRecords: number;
  truncated: boolean;
  records: Array<TransactionRecord & {
    state: "attempting" | "recorded-acquired" | "stale" | "unknown";
    recordAgeMs: number;
    lockOwnership: "unverified";
  }>;
}
const TRANSACTION_RECORD_BYTES = 4096; // PRIMARY CONTROL: bounds each diagnostic read and write.
const TRANSACTION_INVENTORY_LIMIT = 128; // PRIMARY CONTROL: bounds a failure's filesystem inventory.

export function readModelTransactionDir(path: string): string {
  return join(readModelSidecarDir(dirname(path)), `${basename(path)}.transactions`);
}

// One bounded publisher per JS isolate. Shared snapshots coalesce updates without waiting on disk or ACKs.
const TRANSACTION_WRITER_SOURCE = String.raw`
const {parentPort,workerData}=require('node:worker_threads');
const fs=require('node:fs');const {dirname}=require('node:path');
const wake=new Int32Array(workerData.wake),entries=new Map();let scheduled=false;
function identity(){try{
 const pid=process.pid,bootId=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
 const pidNamespace=fs.readlinkSync('/proc/'+pid+'/ns/pid'),stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');
 const startTicks=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
 return bootId&&pidNamespace&&/^\d+$/.test(startTicks)?{pid,bootId,pidNamespace,startTicks}:undefined;
}catch{
 // Missing procfs identity stays absent, so inventories report unknown rather than trusting a PID.
 return undefined;}}
const ownIdentity=identity();
function schedule(){if(!scheduled){scheduled=true;setImmediate(pump);}}
function pump(){
 scheduled=false;const observed=Atomics.load(wake,0);
 for(const [id,e] of entries){
  const c=e.control,v=Atomics.load(c,0);if((v&1)||v===e.seen&&!Atomics.load(c,2))continue;
  const length=Atomics.load(c,1),body=Buffer.from(e.bytes.subarray(0,length));
  if(v!==Atomics.load(c,0))continue;
  let failed=false;
  try{
   if(e.seen<0)fs.mkdirSync(dirname(e.file),{recursive:true,mode:0o700});
   if(length){
    const record=JSON.parse(body.toString('utf8'));if(e.defaultIdentity)record.identity=ownIdentity;
    if(record.recordedState==='released'){
     let existing;try{const st=fs.statSync(e.file);if(st.size>4096)throw Error('oversize');existing=JSON.parse(fs.readFileSync(e.file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
     if(existing?.recorder===record.recorder){
      publish(e.file,record);if(!Atomics.load(c,5))fs.rmSync(e.file,{force:true});
     }
    }else publish(e.file,record);
   }
  }catch(error){
   // The failed ACK carries the errno; a failed publication is never reported as an empty inventory.
   failed=true;e.failureCode=typeof error.code==='string'?error.code:'publication_failed';
  }
  e.seen=v;Atomics.store(c,4,failed?1:0);Atomics.store(c,3,v);
  const closed=!!Atomics.load(c,2)&&v===Atomics.load(c,0);if(closed)entries.delete(id);
  parentPort.postMessage({id,failed,closed,reason:failed?e.failureCode:undefined});
 }
 const waiting=Atomics.waitAsync(wake,0,observed);
 if(waiting.async)waiting.value.then(schedule);else schedule();
}
function publish(file,record){
 const body=JSON.stringify(record);if(Buffer.byteLength(body)>4096)throw Error('oversize');
 fs.mkdirSync(dirname(file),{recursive:true,mode:0o700});const tmp=file+'.tmp';
 try{fs.writeFileSync(tmp,body,{mode:0o600});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}
}
parentPort.on('message',e=>{
 if(entries.size>=128){parentPort.postMessage({id:e.id,failed:true,closed:true});return;}
 entries.set(e.id,{...e,control:new Int32Array(e.memory,0,8),bytes:new Uint8Array(e.memory,32),seen:-1});schedule();
});
`;
type TransactionPublication = {
  id: string; file: string; memory: SharedArrayBuffer; control: Int32Array; bytes: Uint8Array;
  current?: TransactionRecord; failure: (reason?: string) => void;
};
let transactionWriter: {
  worker: Worker; wake: Int32Array; entries: Map<string, TransactionPublication>;
  waiters: Set<() => void>; failed: boolean;
} | undefined;

function transactionPublisher(file: string, failure: (reason?: string) => void, defaultIdentity: boolean): TransactionPublication {
  if (!transactionWriter) {
    const wake = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(TRANSACTION_WRITER_SOURCE, { eval: true, execArgv: [], env: SHARE_ENV, workerData: { wake: wake.buffer },
      resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4, stackSizeMb: 1 } });
    const owner = transactionWriter = { worker, wake, entries: new Map<string, TransactionPublication>(), waiters: new Set<() => void>(), failed: false as boolean };
    worker.on("message", (message: { id: string; failed: boolean; closed: boolean; reason?: string }) => {
      const entry = owner.entries.get(message.id);
      if (message.failed) entry?.failure(message.reason);
      if (message.closed) owner.entries.delete(message.id);
      for (const waiter of owner.waiters) waiter();
      if (!owner.entries.size) { if (transactionWriter === owner) transactionWriter = undefined; void worker.terminate(); }
    });
    const failed = (): void => {
      owner.failed = true;
      for (const entry of owner.entries.values()) { Atomics.store(entry.control, 4, 1); entry.failure(); }
      for (const waiter of owner.waiters) waiter();
    };
    worker.on("error", failed); worker.on("exit", () => { if (owner.entries.size) failed(); }); worker.unref();
  }
  const owner = transactionWriter;
  if (owner.failed) throw new Error("transaction publisher stopped");
  if (owner.entries.size >= TRANSACTION_INVENTORY_LIMIT) throw new Error("transaction publisher capacity reached");
  const memory = new SharedArrayBuffer(32 + TRANSACTION_RECORD_BYTES);
  const entry = { id: randomUUID(), file, memory, control: new Int32Array(memory, 0, 8), bytes: new Uint8Array(memory, 32), failure };
  Atomics.store(entry.control, 3, -2);
  owner.entries.set(entry.id, entry);
  owner.worker.postMessage({ id: entry.id, file, memory, defaultIdentity });
  return entry;
}

function queueTransaction(entry: TransactionPublication, record: TransactionRecord, keepReleased = false): void {
  const bytes = Buffer.from(JSON.stringify(record));
  if (bytes.length > TRANSACTION_RECORD_BYTES) throw new Error("oversized transaction observation");
  entry.current = record;
  Atomics.add(entry.control, 0, 1); entry.bytes.set(bytes); Atomics.store(entry.control, 1, bytes.length);
  Atomics.store(entry.control, 5, keepReleased ? 1 : 0); Atomics.add(entry.control, 0, 1);
  const owner = transactionWriter;
  if (owner?.failed || owner?.entries.get(entry.id) !== entry) throw new Error("transaction publisher unavailable");
  Atomics.add(owner.wake, 0, 1); Atomics.notify(owner.wake, 0);
}

/** Optional diagnostic barrier for tests/tools; production SQLite callers never await it. */
export function flushReadModelTransactions(): Promise<void> {
  const owner = transactionWriter;
  if (!owner) return Promise.resolve();
  const goals = [...owner.entries.values()].map(entry => ({ entry, version: Atomics.load(entry.control, 0) }));
  return new Promise((resolve, reject) => {
    owner.worker.ref();
    const done = (error?: Error): void => {
      clearTimeout(timer); owner.waiters.delete(check); if (!owner.waiters.size) owner.worker.unref();
      if (error) reject(error); else resolve();
    };
    const check = (): void => {
      if (owner.failed) return done(new Error("transaction publisher stopped"));
      if (goals.every(({ entry, version }) => ((Atomics.load(entry.control, 3) - version) >>> 0) < 0x80000000
        && (!Atomics.load(entry.control, 2) || !owner.entries.has(entry.id)))) done();
    };
    const timer = setTimeout(() => done(new Error("transaction publication observation expired")), 10_000);
    owner.waiters.add(check); check();
  });
}

/** One bounded record per connection. It is an observation, never authority to reclaim a lock. */
export function createReadModelTransactionRecorder(path: string, connection: string, opts: ReadModelTransactionObservationOptions = {}) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(connection)) throw new Error("invalid transaction observation connection");
  const file = join(readModelTransactionDir(path), `${connection}.json`), recorder = randomUUID();
  let current: TransactionRecord | undefined, publication: TransactionPublication | undefined;
  let reported = false;
  const failure = (reason = "diagnostic_failed"): void => {
    if (reported) return; reported = true;
    try {
      const extra = { connection, pid: process.pid, thread: threadId, path, release: "unverified", reason };
      if (opts.report) opts.report("read_model.holder_record_failed", extra);
      else process.stderr.write(`${JSON.stringify({ step: "read_model.holder_record_failed", ...extra })}\n`);
    } catch { /* Diagnostic sinks cannot change SQL behavior. */ }
  };
  const diagnostic = (fn: () => void): void => {
    try { fn(); } catch (error) {
      const reason = String((error as NodeJS.ErrnoException)?.code ?? "diagnostic_failed").slice(0, 40);
      failure(reason);
    }
  };
  diagnostic(() => { if (!opts.publish) publication = transactionPublisher(file, failure, !opts.identity); });
  const publish = (record: TransactionRecord, keepReleased = false): void => {
    if (opts.publish) opts.publish(file, record);
    else if (publication) queueTransaction(publication, record, keepReleased);
    else throw new Error("transaction publication unavailable");
  };
  const now = (): number => (opts.clock ?? systemClock).now();
  let identityRead = false, identity: ReadModelProcessIdentity | undefined;
  const release = (nonce: string): void => {
    diagnostic(() => {
      if (current?.transaction !== nonce) return;
      if (opts.publish && readTransactionRecord(file).transaction !== nonce) return;
      current = { ...current, recordedState: "released", updatedAt: now() };
      if (opts.remove) {
        try { opts.remove(file); }
        catch { publish(current, true); throw new Error("transaction retirement unverified"); }
      }
      publish(current);
      if (opts.publish && !opts.remove) rmSync(file, { force: true });
      current = undefined;
    });
  };
  const observer: { attempt(caller?: (...args: never[]) => unknown): string; acquired(nonce: string): void;
    release(nonce: string): void; close(): void } = {
    attempt(caller: (...args: never[]) => unknown = observer.attempt): string {
      const nonce = randomUUID();
      diagnostic(() => {
        if (!identityRead) { identity = opts.identity?.(); identityRead = true; }
        // Function references survive bundling; adapter filenames do not. Trim the outer transaction helper first.
        const site: { stack?: string } = {};
        Error.captureStackTrace(site, withWriteTransaction);
        if (site.stack === undefined || !site.stack.includes("\n")) Error.captureStackTrace(site, acquireLease);
        if (site.stack === undefined || !site.stack.includes("\n")) Error.captureStackTrace(site, caller);
        const label = site.stack?.split("\n")[1]?.trim().split(" (")[0];
        current = { connection, transaction: nonce, recorder, label: (opts.label ?? label ?? "unlabeled").slice(0, 120),
          pid: process.pid, thread: threadId, identity, recordedState: "attempting", attemptedAt: now(), updatedAt: now() };
        publish(current);
      });
      return nonce;
    },
    acquired(nonce: string): void {
      diagnostic(() => {
        if (current?.transaction !== nonce) return;
        current = { ...current, recordedState: "recorded-acquired", acquiredAt: now(), updatedAt: now() };
        publish(current);
      });
    },
    release,
    close(): void {
      if (current) release(current.transaction);
      diagnostic(() => {
        if (!publication) return;
        Atomics.add(publication.control, 0, 1); Atomics.store(publication.control, 2, 1); Atomics.add(publication.control, 0, 1);
        const owner = transactionWriter;
        if (owner?.entries.get(publication.id) === publication) {
          if (owner.failed) { owner.entries.delete(publication.id); if (!owner.entries.size) transactionWriter = undefined; }
          else { Atomics.add(owner.wake, 0, 1); Atomics.notify(owner.wake, 0); }
        }
      });
    },
  };
  return observer;
}

function readTransactionRecord(file: string): TransactionRecord {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    if (size > TRANSACTION_RECORD_BYTES) throw new Error("oversized transaction record");
    const bytes = Buffer.alloc(TRANSACTION_RECORD_BYTES + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > TRANSACTION_RECORD_BYTES) throw new Error("growing transaction record");
    const value = JSON.parse(bytes.subarray(0, count).toString("utf8")) as TransactionRecord;
    if (!value || typeof value.connection !== "string" || value.connection.length > 80 || typeof value.transaction !== "string" || value.transaction.length > 80
      || typeof value.recorder !== "string" || value.recorder.length > 80
      || typeof value.label !== "string" || value.label.length > 120 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isSafeInteger(value.thread)
      || !["attempting", "recorded-acquired", "released"].includes(value.recordedState)
      || !Number.isFinite(value.attemptedAt) || !Number.isFinite(value.updatedAt)
      || (value.acquiredAt !== undefined && !Number.isFinite(value.acquiredAt))
      || (value.recordedState === "recorded-acquired" && value.acquiredAt === undefined)) throw new Error("malformed transaction record");
    // Select fields: no unbounded or unrelated fields from an inventory file enter an error or ledger.
    const i = value.identity;
    const identity = i && Number.isSafeInteger(i.pid) && typeof i.bootId === "string" && i.bootId.length <= 80
      && typeof i.pidNamespace === "string" && i.pidNamespace.length <= 80 && typeof i.startTicks === "string" && i.startTicks.length <= 40
      ? { pid: i.pid, bootId: i.bootId, pidNamespace: i.pidNamespace, startTicks: i.startTicks } : undefined;
    return { connection: value.connection, transaction: value.transaction, recorder: value.recorder, label: value.label, pid: value.pid, thread: value.thread,
      identity, recordedState: value.recordedState, attemptedAt: value.attemptedAt, acquiredAt: value.acquiredAt, updatedAt: value.updatedAt };
  } finally { closeSync(fd); }
}

/** Bounded, best-effort inventory. Empty means none recorded; it never proves there is no SQLite writer. */
export function readReadModelTransactions(path: string | undefined, opts: { processIdentity?: (pid: number) => ProcessInspection; clock?: Clock } = {}): ReadModelTransactionInventory {
  const asOf = (opts.clock ?? systemClock).now();
  const result: ReadModelTransactionInventory = { asOf, state: "unknown", complete: true, inspected: 0, unknownRecords: 0, truncated: false, records: [] };
  let dir: ReturnType<typeof opendirSync> | undefined;
  try {
    if (!path || path === ":memory:") throw new Error("no persistent database inventory");
    const inspect = opts.processIdentity ?? inspectReadModelProcess;
    const own = inspect(process.pid);
    // The publisher thread runs concurrently with this scan: a record it finishes publishing mid-scan can be
    // missed by the directory walk yet look settled afterwards. Entries pending at scan start stay unknown.
    const pendingAtStart = new Set<string>();
    for (const entry of transactionWriter?.entries.values() ?? []) {
      if (Atomics.load(entry.control, 0) !== Atomics.load(entry.control, 3) || Atomics.load(entry.control, 4)) pendingAtStart.add(entry.id);
    }
    dir = opendirSync(readModelTransactionDir(path));
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      if (++result.inspected > TRANSACTION_INVENTORY_LIMIT) { result.truncated = true; result.complete = false; break; }
      if (!entry.name.endsWith(".json")) { result.complete = false; result.unknownRecords++; continue; }
      try {
        if (!entry.isFile()) throw new Error("not a regular transaction record");
        const record = readTransactionRecord(join(dir.path, entry.name));
        let state: ReadModelTransactionInventory["records"][number]["state"] = "unknown";
        const id = record.identity;
        if (id && id.pid === record.pid && own.status === "identified" && id.bootId === own.identity.bootId && id.pidNamespace === own.identity.pidNamespace) {
          const current = inspect(id.pid);
          if (current.status === "missing") state = "stale";
          else if (current.status === "identified" && current.identity.bootId === id.bootId && current.identity.pidNamespace === id.pidNamespace
            && current.identity.startTicks === id.startTicks && record.recordedState !== "released") state = record.recordedState;
        }
        result.records.push({ ...record, state, recordAgeMs: Math.max(0, asOf - record.updatedAt), lockOwnership: "unverified" });
        result.records.sort((a, b) => (a.acquiredAt ?? a.attemptedAt) - (b.acquiredAt ?? b.attemptedAt) || a.connection.localeCompare(b.connection));
        result.records.length = Math.min(3, result.records.length);
      } catch {
        // An unreadable entry makes the inventory incomplete, never evidence of absence.
        result.unknownRecords++; result.complete = false;
      }
    }
    for (const entry of transactionWriter?.entries.values() ?? []) {
      if (dirname(entry.file) !== readModelTransactionDir(path)) continue;
      const pending = Atomics.load(entry.control, 0) !== Atomics.load(entry.control, 3);
      if (!pending && !Atomics.load(entry.control, 4) && !pendingAtStart.has(entry.id)) continue;
      result.complete = false; result.unknownRecords++;
      if (entry.current) {
        const record = { ...entry.current, identity: entry.current.identity ?? (own.status === "identified" ? own.identity : undefined) };
        result.records = result.records.filter(r => r.connection !== record.connection);
        result.records.push({ ...record, state: "unknown", recordAgeMs: Math.max(0, asOf - record.updatedAt), lockOwnership: "unverified" });
        result.records.sort((a, b) => (a.acquiredAt ?? a.attemptedAt) - (b.acquiredAt ?? b.attemptedAt) || a.connection.localeCompare(b.connection));
        result.records.length = Math.min(3, result.records.length);
      }
    }
    result.state = !result.complete ? "unknown" : result.records.length ? "observed" : "none-recorded";
  } catch {
    // A missing or unreadable directory leaves the inventory unknown rather than none-recorded.
    result.complete = false;
  }
  finally { try { dir?.closeSync(); } catch {
    // Failed traversal close invalidates the inventory completeness it would otherwise claim.
    result.complete = false; result.state = "unknown";
  } }
  return result;
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

/** Finite adapter operations identify the failing call, never its SQL or the blocking owner. */
type LockOperation = "connect" | "exec.begin-immediate" | "exec.begin-read" | "exec.commit" | "exec.rollback" | "exec"
  | "prepare" | "run" | "get" | "all" | "iterate" | "iterate-next" | "iterate-return" | "read-route";

function identifyLockFailure(error: unknown, path: string, connection: string, readOnly: boolean, operation: LockOperation): void {
  const code = sqliteErrcode(error);
  if (error instanceof Error && code !== undefined && [5, 6].includes(code & 0xff)) {
    error.message += ` [connection=${connection}/${readOnly ? "reader" : "writer"} pid=${process.pid} thread=${threadId} path=${path}] [operation=${operation}]`;
    const transactions = readReadModelTransactions(path);
    Object.assign(error, { readModelTransactions: transactions });
    error.message += ` [readModelTransactions=${JSON.stringify(transactions)}]`;
  }
}

/** `marker`: the dirty marker this connection wrote and its close removes; only openReadModel's writer owns one. */
function wrap(raw: DatabaseSync, path: string, schemaVersion: number, readOnly: boolean, recoveredFrom?: ReadModelDb["recoveredFrom"], marker?: { path: string; unclean: boolean }, observation?: ReadModelTransactionObservationOptions): ReadModelDb {
  let reader: DatabaseSync | undefined;
  const connection = randomUUID();
  const recorder = readOnly || path === ":memory:" ? undefined : createReadModelTransactionRecorder(path, connection, observation);
  let transaction: string | undefined;
  const checked = <T>(target: DatabaseSync, operation: () => T, label: LockOperation = "read-route"): T => {
    try {
      return operation();
    } catch (error) {
      identifyLockFailure(error, path, connection, target !== raw || readOnly, label);
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
      const label: LockOperation = /^BEGIN IMMEDIATE(?: TRANSACTION)?$/i.test(command) ? "exec.begin-immediate"
        : beginRead ? "exec.begin-read" : /^(?:COMMIT|END)(?: TRANSACTION)?$/i.test(command) ? "exec.commit"
        : /^ROLLBACK(?: TRANSACTION)?$/i.test(command) ? "exec.rollback" : "exec";
      const writeBegin = target === raw && /^BEGIN (?:IMMEDIATE|EXCLUSIVE)(?: TRANSACTION)?$/i.test(command);
      // A nested/failed BEGIN must not overwrite evidence of an existing successful transaction.
      const attempt = writeBegin && !raw.isTransaction ? recorder?.attempt(db.exec) : undefined;
      if (attempt) transaction = attempt;
      checked(target, () => target.exec(sql), label);
      if (attempt) recorder?.acquired(attempt);
      if (target === raw && transaction && !raw.isTransaction) { recorder?.release(transaction); transaction = undefined; }
    },
    prepare: (sql, opts = {}) => {
      const statement: StatementSync = checked(raw, () => raw.prepare(sql), "prepare");
      if (opts.bigInts) statement.setReadBigInts(true);
      let readStatement: StatementSync | undefined;
      let tempSchemaVersion: number | undefined;
      let readsTemp = false;
      // Transaction reads see their own writes; PRAGMAs describe the writer's configuration.
      const forRead = (): { target: DatabaseSync; statement: StatementSync } => {
        const target = raw.isTransaction || /^\s*(?:PRAGMA|EXPLAIN)\b/i.test(sql) ? raw : reading();
        if (target === raw) return { target, statement };
        const version = Number(checked(raw, () => raw.prepare("PRAGMA temp.schema_version").get()?.schema_version));
        if (version !== tempSchemaVersion) {
          const hasTemp = checked(raw, () => raw.prepare("SELECT 1 FROM temp.sqlite_schema WHERE type IN ('table', 'view') LIMIT 1").get()) !== undefined;
          // SQLite's plan resolves aliases, views and shadowing; database 1 is connection-local TEMP.
          const plan = hasTemp ? checked(raw, () => raw.prepare(`EXPLAIN ${sql}`).all()) : [];
          readsTemp = plan.some((row) => row.opcode === "Transaction" && row.p1 === 1)
            && !plan.some((row) => row.opcode === "Transaction" && row.p2 !== 0);
          tempSchemaVersion = version;
        }
        if (readsTemp) return { target: raw, statement };
        if (!readStatement) {
          readStatement = checked(target, () => target.prepare(sql), "prepare");
          if (opts.bigInts) readStatement.setReadBigInts(true);
        }
        return { target, statement: readStatement };
      };
      return {
        run: (...params) => checked(raw, () => statement.run(...params), "run") as { changes: number },
        get: (...params) => {
          const read = forRead();
          return checked(read.target, () => read.statement.get(...params), "get") as SqlRow | undefined;
        },
        all: (...params) => {
          const read = forRead();
          return checked(read.target, () => read.statement.all(...params), "all") as SqlRow[];
        },
        iterate: function* (...params) {
          const read = forRead();
          const iterator = checked(read.target, () => read.statement.iterate(...params), "iterate");
          try {
            for (;;) {
              const next = checked(read.target, () => iterator.next(), "iterate-next");
              if (next.done) return;
              yield next.value as SqlRow;
            }
          } finally {
            checked(read.target, () => iterator.return?.(), "iterate-return");
          }
        },
      };
    },
    meta: (key) => db.prepare("SELECT v FROM meta WHERE k = ?").get(key)?.v as string | undefined,
    inTransaction: () => raw.isTransaction || (reader?.isTransaction ?? false),
    close: () => {
      reader?.close();
      raw.close();
      if (transaction) { recorder?.release(transaction); transaction = undefined; }
      recorder?.close();
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
    identifyLockFailure(error, path, connection, readOnly, "connect");
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
  const db = wrap(raw, path, opts.schemaVersion, readOnly, recoveredFrom, marker, opts.transactionObservation);
  try {
    if (!readOnly) {
      immediate(db, () => db.exec(`${BASE_DDL} ${opts.ddl ?? ""}
        INSERT OR IGNORE INTO meta(k, v) VALUES('schema_version', '${opts.schemaVersion}');`));
    }
    const stored = db.meta("schema_version");
    if (stored !== String(opts.schemaVersion)) {
      throw new ReadModelError("schema_mismatch", `${path} holds schema ${stored}, expected ${opts.schemaVersion}`, { path, stored });
    }
    return db;
  } catch (error) {
    try { db.close(); } catch { /* Preserve the opening failure; close must also retire its observer. */ }
    throw error;
  }
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
export function attachReadModel(path: string, schemaVersion: number, observation?: ReadModelTransactionObservationOptions): ReadModelDb {
  const { DatabaseSync: Database } = require("node:sqlite") as typeof import("node:sqlite");
  const db = wrap(new Database(path, { timeout: READ_MODEL_BUSY_TIMEOUT_MS }), path, schemaVersion, false, undefined, undefined, observation);
  try {
    const stored = db.meta("schema_version");
    if (stored !== String(schemaVersion)) throw new ReadModelError("schema_mismatch", `${path} holds schema ${stored}, expected ${schemaVersion}`, { path, stored });
    return db;
  } catch (error) {
    try { db.close(); } catch { /* Retire diagnostics without replacing the schema/read failure. */ }
    throw error;
  }
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
