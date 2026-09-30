/**
 * The read-model worker: serve's one worker_thread that runs the ledger projector for every
 * registry instance and materializes view bodies (Phase 1 design D1, D5, §1.4, §1.7, §5; P1-03).
 *
 * Each instance (core, console, site) has its own ledger dir and its own DB file, all under core's
 * `state/read-model/`. The worker holds each DB's writer lease, renews it, and releases it when
 * serve stops. Serve's main thread never opens SQLite on a request: it receives finished bodies by
 * `postMessage` and keeps them in memory. At construction it reads the last committed bodies once,
 * so a restarted serve answers before the worker's first tick.
 *
 * THIS FILE IS LOADED TWICE, as console-projection-worker.ts is: `workerData.kind` gates the worker
 * branch. The branch body is {@link runReadModelWorker}, named so a test can run it in-process,
 * where coverage is recorded.
 */
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { FUTURE_ROW_TOLERANCE_MS, LEDGER_PROJECTOR_SCHEMA_VERSION, createLedgerProjector, openProjectorReadModel, type LedgerProjector } from "./ledger-projector.js";
import { createNavBadgeReadModelView } from "./nav-badge-view.js";
import {
  READ_MODEL_DIRNAME,
  ReadModelError,
  acquireLease,
  openReadModel,
  releaseLease,
  withWriteTransaction,
  type ReadModelDb,
  type ReadModelLease,
} from "./read-model-db.js";
import { createNowView } from "./now-view.js";
import { createRepositoriesReadModelView } from "./repositories-view.js";
import { oldestAsOf, viewEtag, type ViewBody, type ViewBodyEntry, type ViewSource } from "./views.js";

const READ_MODEL_WORKER_KIND = "remudero-read-model" as const;
/** The SSE publisher's cadence (design §1.1). */
export const READ_MODEL_TICK_MS = 250;
/** The lease is renewed this often; its expiry is `READ_MODEL_LEASE_TTL_MS` (20 s). */
export const READ_MODEL_LEASE_RENEW_MS = 5_000;
/** A projector whose last good tick is older than this makes its `ledger:<i>` source stale (§3.2). */
export const READ_MODEL_LEDGER_STALE_MS = 10_000;
/** How often a running worker re-reads the switch file (design §5). */
export const READ_MODEL_SWITCH_RECHECK_MS = 5_000;
/** BACKSTOP: the ceiling of a failing instance's doubling back-off; a success resets it. */
export const READ_MODEL_MAX_BACKOFF_MS = 60_000;
/** BACKSTOP: how long a stopping serve waits for the worker to release its leases. */
export const READ_MODEL_STOP_WAIT_MS = 2_000;
export const READ_MODEL_SWITCHES_FILE = "switches.json";

const VIEW_BODY_DDL = `CREATE TABLE IF NOT EXISTS view_body(view TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL,
  generation INTEGER NOT NULL, etag TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(view, key)) WITHOUT ROWID;`;

export interface ReadModelInstance {
  name: string;
  /** The instance's state dir: the one holding its live ledger and rotation archives. */
  ledgerDir: string;
  /** `owner/name`, the plan path and core's feedback root: the now view's inputs (now-view.ts). */
  repo?: string;
  planPath?: string;
  feedbackRoot?: string;
}

export type ReadModelViewMode = "serve" | "shadow" | "off";

export interface ReadModelSwitches {
  projector: "on" | "off";
  views: Record<string, ReadModelViewMode>;
}

export const DEFAULT_READ_MODEL_SWITCHES: ReadModelSwitches = { projector: "on", views: {} };

export function readModelSwitchesPath(stateDir: string): string {
  return join(stateDir, READ_MODEL_DIRNAME, READ_MODEL_SWITCHES_FILE);
}

/**
 * Reads the kill-switch file. An absent file is the defaults. A file that exists but does not
 * parse is `{ ok: false }` with its reason, so the caller keeps the switches it last read: an
 * operator's half-written "off" must never read as "on".
 */
export function readReadModelSwitches(path: string): { ok: true; switches: ReadModelSwitches; mtimeMs: number } | { ok: false; reason: string } {
  let text: string;
  let mtimeMs: number;
  let fd: number | undefined;
  try {
    // Open once, then inspect and read that same file descriptor. A stat(path) followed by
    // readFile(path) lets a path/symlink swap redirect the read after the metadata check.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) return { ok: false, reason: "switch file unreadable: not a regular file" };
    text = readFileSync(fd, "utf8");
    const after = fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      return { ok: false, reason: "switch file changed while being read" };
    }
    mtimeMs = Number(before.mtimeNs) / 1_000_000;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, switches: DEFAULT_READ_MODEL_SWITCHES, mtimeMs: 0 };
    return { ok: false, reason: `switch file unreadable: ${(error as Error).message}` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `switch file is not JSON: ${(error as Error).message}` };
  }
  const obj = (raw ?? {}) as { projector?: unknown; views?: unknown };
  const views: Record<string, ReadModelViewMode> = {};
  for (const [name, mode] of Object.entries(typeof obj.views === "object" && obj.views !== null ? obj.views : {})) {
    if (mode !== "serve" && mode !== "shadow" && mode !== "off") return { ok: false, reason: `view ${name} has mode ${JSON.stringify(mode)}` };
    views[name] = mode;
  }
  const projector = obj.projector ?? "on";
  if (projector !== "on" && projector !== "off") return { ok: false, reason: `projector has mode ${JSON.stringify(projector)}` };
  return { ok: true, switches: { projector, views }, mtimeMs };
}

/** One instance's projector, as the worker last saw it. Posted to the main thread every tick. */
export interface ReadModelInstanceState {
  instance: string;
  /** When the last tick completed; absent before the first. */
  tickedAt?: number;
  generation: number;
  lease: "held" | "elsewhere" | "none";
  heldBy?: string;
  /** Why the last tick did not run or failed; absent after a good tick. */
  reason?: string;
  failures: number;
  /** The `ts` of the newest applied (not quarantined) row. */
  newestTs: string | null;
}

export type ReadModelBodyEntry = ViewBodyEntry;

export type ReadModelWorkerMessage =
  | { type: "body"; entry: ReadModelBodyEntry }
  | { type: "state"; at: number; instances: ReadModelInstanceState[]; switches: ReadModelSwitches }
  | { type: "log"; step: string; extra: Record<string, unknown> };

export interface ReadModelViewContext {
  now: number;
  instances: ReadonlyArray<{ state: ReadModelInstanceState; db?: ReadModelDb }>;
  switches?: ReadModelSwitches;
}

/** A view the worker materializes. `materialize` returns one body per key (`""` when unkeyed). */
export interface ReadModelView {
  name: string;
  version: number;
  materialize(ctx: ReadModelViewContext): Array<{ key: string; data: unknown; sources: ViewSource[] }>;
}

const LEDGER_SOURCE_PREFIX = "ledger:";

/** The `ledger:<i>` source every read-model view carries: stale while its projector is behind. */
export function ledgerSource(state: ReadModelInstanceState, now: number, staleMs: number = READ_MODEL_LEDGER_STALE_MS): ViewSource {
  const name = `${LEDGER_SOURCE_PREFIX}${state.instance}`;
  if (state.tickedAt === undefined) return { name, asOf: state.newestTs, state: "stale", reason: state.reason ?? "projector has not ticked yet" };
  const behindMs = now - state.tickedAt;
  if (behindMs > staleMs) return { name, asOf: state.newestTs, state: "stale", reason: `projector ${Math.round(behindMs / 1000)} s behind${state.reason ? `: ${state.reason}` : ""}` };
  if (state.reason) return { name, asOf: state.newestTs, state: "stale", reason: state.reason };
  return { name, asOf: state.newestTs, state: "fresh" };
}

/** The read model's own status, one body per serve: what each projector has applied and who holds it. */
export const readModelStatusView: ReadModelView = {
  name: "read-model",
  version: 1,
  materialize: ({ now, instances }) => [{
    key: "",
    data: {
      instances: instances.map(({ state, db }) => ({
        instance: state.instance,
        generation: state.generation,
        lease: state.lease,
        ...(state.heldBy ? { heldBy: state.heldBy } : {}),
        quarantined: db ? Number(db.prepare("SELECT count(*) AS n FROM quarantine").get()?.n ?? 0) : 0,
        ...(state.reason ? { reason: state.reason } : {}),
      })),
    },
    sources: instances.map(({ state }) => ledgerSource(state, now)),
  }],
};

/** Every view the worker materializes; later Phase 1 views register here. */
export const READ_MODEL_VIEWS: readonly ReadModelView[] = [createNavBadgeReadModelView(ledgerSource), createRepositoriesReadModelView(ledgerSource), readModelStatusView];

export interface ReadModelTickerOptions {
  /** Core's state dir: every instance's DB lives under its `read-model/` (design §1.7). */
  stateDir: string;
  /** The first instance is home: its DB also stores the view bodies. */
  instances: readonly ReadModelInstance[];
  post: (message: ReadModelWorkerMessage) => void;
  clock?: Clock;
  holder?: string;
  views?: readonly ReadModelView[];
  tickMs?: number;
  /** Checked between instances and inside every projector transaction, so a stop lands mid-rebuild. */
  stopRequested?: () => boolean;
}

export interface ReadModelTicker {
  tick(): void;
  /** Releases every held lease and closes every DB; returns how many leases were released. */
  release(): number;
}

class ReadModelStopRequested extends RmdError {
  constructor() {
    super("read-model", GENERIC_EXIT_CODE, "the read-model worker is stopping");
  }
}

interface Slot {
  instance: ReadModelInstance;
  state: ReadModelInstanceState;
  db?: ReadModelDb;
  lease?: ReadModelLease;
  projector?: LedgerProjector;
  /** The inode `db` was opened on: `rmd read-model rebuild` renames a new file over the path. */
  ino?: string;
  renewedAt: number;
  backoffUntil: number;
}

function fileIno(path: string): string | undefined {
  try {
    return String(statSync(path, { bigint: true }).ino);
  } catch {
    // deliberate: a path with no file reads as replaced, and the reopen that follows creates it.
    return undefined;
  }
}

/** The worker's per-tick work, runnable in any thread. Every instance fails and backs off alone. */
export function createReadModelTicker(opts: ReadModelTickerOptions): ReadModelTicker {
  const clock = opts.clock ?? systemClock;
  const holder = opts.holder ?? randomUUID();
  const views = opts.views ?? READ_MODEL_VIEWS;
  const tickMs = opts.tickMs ?? READ_MODEL_TICK_MS;
  const stopRequested = opts.stopRequested ?? (() => false);
  const switchesPath = readModelSwitchesPath(opts.stateDir);
  const slots: Slot[] = opts.instances.map((instance) => ({
    instance,
    state: { instance: instance.name, generation: 0, lease: "none", failures: 0, newestTs: null },
    renewedAt: 0,
    backoffUntil: 0,
  }));
  const lastEtag = new Map<string, string>();
  let switches = DEFAULT_READ_MODEL_SWITCHES;
  let switchesMtimeMs = -1;
  let switchesCheckedAt = Number.NEGATIVE_INFINITY;

  const log = (step: string, extra: Record<string, unknown>): void => opts.post({ type: "log", step, extra });

  function reloadSwitches(now: number): void {
    if (now - switchesCheckedAt < READ_MODEL_SWITCH_RECHECK_MS) return;
    switchesCheckedAt = now;
    const read = readReadModelSwitches(switchesPath);
    if (!read.ok) return log("read_model.switch_unreadable", { reason: read.reason, kept: switches });
    if (read.mtimeMs === switchesMtimeMs) return;
    switchesMtimeMs = read.mtimeMs;
    switches = read.switches;
  }

  /** Drops the connection, its projector and its lease; the next tick reopens the file by path. */
  function closeSlot(slot: Slot): void {
    slot.db?.close();
    slot.db = undefined;
    slot.projector = undefined;
    slot.lease = undefined;
    slot.ino = undefined;
  }

  function ensureLease(slot: Slot, now: number): boolean {
    if (slot.db && fileIno(slot.db.path) !== slot.ino) {
      // A rebuild swapped a new file in: this connection still reads the old inode, and a write
      // through it could land in a WAL the new file now shares. Close it before opening the new one.
      log("read_model.reopened", { instance: slot.instance.name, reason: "the file was replaced" });
      closeSlot(slot);
    }
    if (!slot.db) {
      slot.db = openProjectorReadModel(opts.stateDir, slot.instance.name, clock);
      slot.ino = fileIno(slot.db.path);
    }
    if (slot.lease && now - slot.renewedAt < READ_MODEL_LEASE_RENEW_MS) return true;
    const got = acquireLease(slot.db, { holder, clock });
    if (!got.ok) {
      slot.lease = undefined;
      Object.assign(slot.state, { lease: "elsewhere", heldBy: `${got.pid}@${got.host}`, reason: `lease held by pid ${got.pid} on ${got.host}` });
      return false;
    }
    if (!slot.projector) {
      const db = slot.db;
      withWriteTransaction(db, got.lease, () => db.exec(VIEW_BODY_DDL));
      slot.projector = createLedgerProjector({
        ledgerDir: slot.instance.ledgerDir, db, lease: got.lease, clock,
        beforeCheckpoint: () => {
          if (stopRequested()) throw new ReadModelStopRequested();
        },
      });
    }
    slot.lease = got.lease;
    slot.renewedAt = now;
    slot.state.lease = "held";
    delete slot.state.heldBy;
    return true;
  }

  function tickSlot(slot: Slot, now: number): void {
    try {
      if (!ensureLease(slot, now)) return;
      const result = slot.projector!.tick();
      const db = slot.db!;
      const newest = db.prepare("SELECT max(ts_ms) AS m FROM seen WHERE ts_ms > 0 AND ts_ms <= ?").get(now + FUTURE_ROW_TOLERANCE_MS)?.m;
      Object.assign(slot.state, { tickedAt: now, generation: Number(db.meta("generation")), failures: 0, newestTs: newest == null ? null : fixedClock(Number(newest)).iso() });
      delete slot.state.reason;
      if (result.unread.length > 0) slot.state.reason = `unread archives: ${result.unread.join("; ")}`;
      slot.backoffUntil = 0;
    } catch (error) {
      if (error instanceof ReadModelStopRequested) return;
      if (error instanceof ReadModelError && error.reason === "lease_lost") {
        // Another writer fenced this one off, usually a rebuild about to swap the file: reopen by path.
        closeSlot(slot);
        slot.state.lease = "none";
      }
      slot.state.failures++;
      const backoffMs = Math.min(tickMs * 2 ** slot.state.failures, READ_MODEL_MAX_BACKOFF_MS);
      slot.backoffUntil = now + backoffMs;
      slot.state.reason = `tick failed: ${(error as Error).message}`;
      log("read_model.tick_failed", { instance: slot.instance.name, error: (error as Error).message, failures: slot.state.failures, backoffMs });
    }
  }

  function persist(entry: ReadModelBodyEntry): void {
    const home = slots[0];
    if (home === undefined || home.db === undefined || home.lease === undefined) return;
    const db = home.db;
    withWriteTransaction(db, home.lease, () => db.prepare(`INSERT INTO view_body(view, key, version, generation, etag, body) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(view, key) DO UPDATE SET version = excluded.version, generation = excluded.generation, etag = excluded.etag, body = excluded.body`)
      .run(entry.view, entry.key, entry.version, entry.generation, entry.etag, JSON.stringify(entry.body)));
  }

  function materialize(now: number): void {
    const ctx: ReadModelViewContext = { now, switches, instances: slots.map((slot) => ({ state: slot.state, ...(slot.db ? { db: slot.db } : {}) })) };
    const generation = slots.reduce((sum, slot) => sum + slot.state.generation, 0);
    for (const view of views) {
      if (switches.views[view.name] === "off") continue;
      try {
        for (const { key, data, sources } of view.materialize(ctx)) {
          const stale = sources.some((source) => source.state !== "fresh");
          const etag = viewEtag(view.name, view.version, stale, data);
          const id = `${view.name}\u0000${key}`;
          if (lastEtag.get(id) === etag) continue;
          const body: ViewBody = { view: view.name, version: view.version, generatedAt: clock.iso(), asOf: oldestAsOf(sources), stale, sources, data };
          const entry: ReadModelBodyEntry = { view: view.name, key, version: view.version, generation, etag, body };
          if (switches.projector === "on") persist(entry);
          lastEtag.set(id, etag);
          opts.post({ type: "body", entry });
        }
      } catch (error) {
        log("read_model.materialize_failed", { view: view.name, error: (error as Error).message });
      }
    }
  }

  return {
    tick(): void {
      const now = clock.now();
      reloadSwitches(now);
      if (switches.projector === "off") {
        for (const slot of slots) slot.state.reason = "projector switched off";
      } else {
        for (const slot of slots) {
          if (stopRequested()) return;
          if (now >= slot.backoffUntil) tickSlot(slot, now);
        }
      }
      materialize(now);
      opts.post({ type: "state", at: now, instances: slots.map((slot) => ({ ...slot.state })), switches });
    },
    release(): number {
      let released = 0;
      for (const slot of slots) {
        try {
          if (slot.db && slot.lease && releaseLease(slot.db, slot.lease)) released++;
        } catch (error) {
          log("read_model.release_failed", { instance: slot.instance.name, error: (error as Error).message });
        }
        closeSlot(slot);
      }
      return released;
    },
  };
}

export interface ReadModelWorkerData {
  kind: typeof READ_MODEL_WORKER_KIND;
  stateDir: string;
  instances: ReadModelInstance[];
  tickMs: number;
  /** `[0]` is set by the main thread to ask for a stop; `[1]` by the worker once its leases are released. */
  signal: SharedArrayBuffer;
}

/** The worker branch's body: tick on a timer until asked to stop, then release and signal. */
export function runReadModelWorker(
  port: { on(event: "message", run: (msg: { type?: string }) => void): unknown; postMessage(value: unknown): void; close(): void },
  data: ReadModelWorkerData,
  clock: Clock = systemClock,
): void {
  const signal = new Int32Array(data.signal);
  const stopRequested = (): boolean => Atomics.load(signal, 0) === 1;
  const post = (m: ReadModelWorkerMessage): void => port.postMessage(m);
  const now = createNowView({ instances: data.instances, ledgerSource, clock, log: (step, extra) => post({ type: "log", step, extra }) });
  const ticker = createReadModelTicker({ stateDir: data.stateDir, instances: data.instances, tickMs: data.tickMs, clock, stopRequested, post, views: [...READ_MODEL_VIEWS, now] });
  let timer: NodeJS.Timeout | undefined;
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    const released = ticker.release();
    port.postMessage({ type: "log", step: "read_model.stopped", extra: { released } } satisfies ReadModelWorkerMessage);
    Atomics.store(signal, 1, 1);
    Atomics.notify(signal, 1);
    port.close();
  };
  const loop = (): void => {
    if (!stopRequested()) {
      try {
        ticker.tick();
      } catch (error) {
        port.postMessage({ type: "log", step: "read_model.tick_failed", extra: { error: (error as Error).message } } satisfies ReadModelWorkerMessage);
      }
    }
    if (stopRequested()) return finish();
    timer = setTimeout(loop, data.tickMs);
  };
  port.on("message", (msg) => {
    if (msg.type !== "stop") return;
    Atomics.store(signal, 0, 1);
    finish();
  });
  loop();
}

if (!isMainThread && (workerData as { kind?: unknown } | undefined)?.kind === READ_MODEL_WORKER_KIND && parentPort) {
  runReadModelWorker(parentPort, workerData as ReadModelWorkerData);
}

/** The last committed bodies, read once at construction through a read-only connection. */
export function loadCommittedViewBodies(stateDir: string, home: string): { bodies: ReadModelBodyEntry[]; reason?: string } {
  let db: ReadModelDb | undefined;
  try {
    db = openReadModel({ stateDir, instance: home, schemaVersion: LEDGER_PROJECTOR_SCHEMA_VERSION, readOnly: true });
    const rows = db.prepare("SELECT view, key, version, generation, etag, body FROM view_body").all();
    return {
      bodies: rows.map((row) => ({
        view: String(row.view), key: String(row.key), version: Number(row.version), generation: Number(row.generation), etag: String(row.etag), body: JSON.parse(String(row.body)) as ViewBody,
      })),
    };
  } catch (error) {
    return { bodies: [], reason: `no committed view bodies: ${(error as Error).message}` };
  } finally {
    db?.close();
  }
}

export interface ReadModelWorkerHandle {
  /** Keyed `<view>\u0000<key>`; loaded from the DB at construction, then replaced by each posted body. */
  readonly bodies: ReadonlyMap<string, ReadModelBodyEntry>;
  /** Each instance's last posted state, and the switches the worker last read. */
  state(): { at?: number; instances: ReadonlyMap<string, ReadModelInstanceState>; switches: ReadModelSwitches; warmBoot?: string };
  body(view: string, key?: string): ReadModelBodyEntry | undefined;
  /** A body's sources re-judged against the latest instance states: a stalled worker cannot
   *  keep a stored "fresh", and a body loaded at boot is stale until its instance ticks. */
  judge(sources: readonly ViewSource[], now: number): ViewSource[];
  /** The switch file as the MAIN thread last read it, so the kill switch works with the worker down. */
  switches(): ReadModelSwitches;
  start(): void;
  /** Asks the worker to release its leases and waits, bounded, for it. True when it confirmed. */
  stop(): boolean;
}

export interface ReadModelWorkerOptions {
  stateDir: string;
  instances: readonly ReadModelInstance[];
  tickMs?: number;
  stopWaitMs?: number;
  workerUrl?: URL;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** Runs the switch re-read on a cadence and returns its stop; defaults to an unref'd interval. */
  every?: (run: () => void, ms: number) => () => void;
}

function everyUnref(run: () => void, ms: number): () => void {
  const timer = setInterval(run, ms);
  timer.unref();
  return () => clearInterval(timer);
}

export function readModelBodyKey(view: string, key = ""): string {
  return `${view}\u0000${key}`;
}

/** Serve's side: warm bodies now, one worker on `start()`, respawned with back-off if it dies. */
export function createReadModelWorker(opts: ReadModelWorkerOptions): ReadModelWorkerHandle {
  const bodies = new Map<string, ReadModelBodyEntry>();
  const instances = new Map<string, ReadModelInstanceState>();
  let switches = DEFAULT_READ_MODEL_SWITCHES;
  let at: number | undefined;
  const home = opts.instances[0]?.name ?? "core";
  const warm = loadCommittedViewBodies(opts.stateDir, home);
  for (const entry of warm.bodies) bodies.set(readModelBodyKey(entry.view, entry.key), entry);
  opts.log?.("read_model.warm_boot", { bodies: warm.bodies.length, ...(warm.reason ? { reason: warm.reason } : {}) });
  const switchesPath = readModelSwitchesPath(opts.stateDir);
  let mainSwitches = DEFAULT_READ_MODEL_SWITCHES;
  const refreshSwitches = (): void => {
    const read = readReadModelSwitches(switchesPath);
    if (read.ok) mainSwitches = read.switches;
    else opts.log?.("read_model.switch_unreadable", { reason: read.reason, kept: mainSwitches });
  };
  refreshSwitches();
  let stopSwitchWatch: () => void = () => {};

  let worker: Worker | undefined;
  let signal: Int32Array | undefined;
  let stopping = false;
  let deaths = 0;
  let respawnTimer: NodeJS.Timeout | undefined;

  const onMessage = (msg: ReadModelWorkerMessage): void => {
    if (msg.type === "body") bodies.set(readModelBodyKey(msg.entry.view, msg.entry.key), msg.entry);
    else if (msg.type === "log") opts.log?.(msg.step, msg.extra);
    else {
      at = msg.at;
      switches = msg.switches;
      deaths = 0;
      for (const state of msg.instances) instances.set(state.instance, state);
    }
  };

  const spawn = (): void => {
    const shared = new SharedArrayBuffer(8);
    const data: ReadModelWorkerData = { kind: READ_MODEL_WORKER_KIND, stateDir: opts.stateDir, instances: [...opts.instances], tickMs: opts.tickMs ?? READ_MODEL_TICK_MS, signal: shared };
    const spawned = new Worker(opts.workerUrl ?? new URL(import.meta.url), { workerData: data, execArgv: process.execArgv });
    signal = new Int32Array(shared);
    worker = spawned;
    spawned.unref();
    spawned.on("message", onMessage);
    spawned.on("error", (error) => opts.log?.("read_model.worker_failed", { error: String(error?.message ?? error) }));
    spawned.on("exit", (code) => {
      if (worker !== spawned || stopping) return;
      worker = undefined;
      deaths++;
      const delayMs = Math.min((opts.tickMs ?? READ_MODEL_TICK_MS) * 2 ** deaths, READ_MODEL_MAX_BACKOFF_MS);
      opts.log?.("read_model.worker_exited", { code, deaths, respawnInMs: delayMs });
      respawnTimer = setTimeout(spawn, delayMs);
      respawnTimer.unref();
    });
  };

  return {
    bodies,
    state: () => ({ ...(at === undefined ? {} : { at }), instances, switches, ...(warm.reason ? { warmBoot: warm.reason } : {}) }),
    body: (view, key = "") => bodies.get(readModelBodyKey(view, key)),
    judge: (sources, now) => sources.map((source) => {
      if (!source.name.startsWith(LEDGER_SOURCE_PREFIX)) return source;
      const state = instances.get(source.name.slice(LEDGER_SOURCE_PREFIX.length));
      return state ? ledgerSource(state, now) : { ...source, state: "stale", reason: "read model warming: this body was committed before serve started" };
    }),
    switches: () => mainSwitches,
    start: () => {
      if (worker || stopping) return;
      spawn();
      stopSwitchWatch = (opts.every ?? everyUnref)(refreshSwitches, READ_MODEL_SWITCH_RECHECK_MS);
    },
    stop: () => {
      stopping = true;
      stopSwitchWatch();
      clearTimeout(respawnTimer);
      const running = worker;
      worker = undefined;
      if (!running || !signal) return false;
      Atomics.store(signal, 0, 1);
      running.postMessage({ type: "stop" });
      const waited = Atomics.wait(signal, 1, 0, opts.stopWaitMs ?? READ_MODEL_STOP_WAIT_MS);
      void running.terminate();
      opts.log?.("read_model.stop", { confirmed: waited !== "timed-out" });
      return waited !== "timed-out";
    },
  };
}
