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
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { ghIssueGateway, type EscalateDeps } from "./escalate.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { FUTURE_ROW_TOLERANCE_MS, LEDGER_PROJECTOR_SCHEMA_VERSION, createLedgerProjector, openProjectorReadModel, type LedgerProjector } from "./ledger-projector.js";
import { createNavBadgeReadModelView } from "./nav-badge-view.js";
import { createNowView } from "./now-view.js";
import {
  ORACLE_DEFAULT_WINDOW_MS,
  ORACLE_DRIFT_INTERVAL_MS,
  advanceOracleSlice,
  consistencyCheckDue,
  nextOracleSlice,
  runConsistencyCheck,
} from "./read-model-consistency.js";
import {
  READ_MODEL_DIRNAME,
  READ_MODEL_LEASE_TTL_MS,
  ReadModelError,
  acquireLease,
  currentReadModelPath,
  openReadModel,
  peekLease,
  releaseLease,
  withWriteTransaction,
  type ReadModelDb,
  type ReadModelLease,
} from "./read-model-db.js";
import { createRepositoriesReadModelView } from "./repositories-view.js";
import { createViewShadow, readShadowEvidence, sqliteShadowStore, type ShadowLegacy, type ShadowReadiness, type ShadowRequest, type ViewShadow } from "./view-shadow.js";
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
/** The share of worker time the oracle's slices may take: the next slice waits cost / share. */
export const READ_MODEL_CHECK_SHARE = 0.02;

const VIEW_BODY_DDL = `CREATE TABLE IF NOT EXISTS view_body(view TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL,
  generation INTEGER NOT NULL, etag TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(view, key)) WITHOUT ROWID;`;

export interface ReadModelInstance {
  name: string;
  /** The instance's state dir: the one holding its live ledger and rotation archives. */
  ledgerDir: string;
  /** Inputs for the per-instance now view. */
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
 * Reads the kill-switch file. An absent file is the defaults, every view dark, with `absent` saying
 * so. A file that exists but does not parse is `{ ok: false }` with its reason: the worker keeps the
 * projector switch it last read, and serve's routes go dark, so a half-written "off" never reads as "on".
 */
export function readReadModelSwitches(path: string): { ok: true; switches: ReadModelSwitches; mtimeMs: number; absent?: string } | { ok: false; reason: string } {
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, switches: DEFAULT_READ_MODEL_SWITCHES, mtimeMs: 0, absent: `no switch file at ${path}` };
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
  /** Each shadowed view's diff counters and cutover readiness (view-shadow.ts). */
  shadow?: ShadowReadiness[];
}

/** A view the worker materializes. `materialize` returns one body per key (`""` when unkeyed). */
export interface ReadModelView {
  name: string;
  version: number;
  materialize(ctx: ReadModelViewContext): Array<{ key: string; data: unknown; sources: ViewSource[] }>;
  /** The shadow comparator's legacy side for one key, computed in the worker beside the view's body. */
  legacy?(key: string, now: number, data: unknown): ShadowLegacy | undefined;
}

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
  materialize: ({ now, instances, shadow }) => [{
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
      ...(shadow && shadow.length > 0 ? { shadow } : {}),
    },
    sources: instances.map(({ state }) => ledgerSource(state, now)),
  }],
};

/** Every view the worker materializes; later Phase 1 views register here. */
export const READ_MODEL_VIEWS: readonly ReadModelView[] = [createNavBadgeReadModelView(ledgerSource), createRepositoriesReadModelView(ledgerSource), readModelStatusView];

const LEDGER_SOURCE_PREFIX = "ledger:";

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
  /** Where the consistency oracle's escalations go; without it drift is still healed and recorded. */
  escalation?: EscalateDeps;
  consistencyWindowMs?: number;
  /** "off" leaves every tick to the projector: a suite that pins what each tick projects. */
  oracle?: "on" | "off";
}

export interface ReadModelTicker {
  tick(): void;
  /** Compares one sampled shadow request against the latest body; false when there was nothing to compare. */
  shadow(request: ShadowRequest): boolean;
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
  /** A check that could not run (blind, deferred behind a rebuild) is not asked again before this. */
  checkAfter: number;
  /** Set by a caught-up projector tick when a slice is due; the NEXT tick runs it instead of projecting. */
  checkPending: boolean;
}

/**
 * `rmd read-model rebuild` projects into a new generation file beside the one the pointer names and
 * holds that file's lease; after the flip it holds the old one's for a TTL. So any other file of
 * this instance with a live lease names a rebuild in flight. An unreadable one counts only while it
 * is younger than a lease TTL (one being created); an older one is debris the reaper owns.
 */
function rebuildHolder(stateDir: string, instance: string, now: number): string | undefined {
  const current = currentReadModelPath(stateDir, instance, LEDGER_PROJECTOR_SCHEMA_VERSION);
  const prefix = `${instance}.v${LEDGER_PROJECTOR_SCHEMA_VERSION}.`;
  for (const name of readdirSync(dirname(current))) {
    const path = join(dirname(current), name);
    if (!name.startsWith(prefix) || !name.endsWith(".sqlite") || path === current) continue;
    try {
      const lease = peekLease(path);
      if (lease && lease.expiresMs > now) return lease.holder;
    } catch (error) {
      if (now - statSync(path).mtimeMs < READ_MODEL_LEASE_TTL_MS) return `${name} (unreadable: ${(error as Error).message})`;
    }
  }
  return undefined;
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
  const windowMs = opts.consistencyWindowMs ?? ORACLE_DEFAULT_WINDOW_MS;
  const switchesPath = readModelSwitchesPath(opts.stateDir);
  const slots: Slot[] = opts.instances.map((instance) => ({
    instance,
    state: { instance: instance.name, generation: 0, lease: "none", failures: 0, newestTs: null },
    renewedAt: 0,
    backoffUntil: 0,
    checkAfter: 0,
    checkPending: false,
  }));
  const lastEtag = new Map<string, string>();
  const latest = new Map<string, ViewBody>();
  let comparator: { db: ReadModelDb; shadow: ViewShadow } | undefined;
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
      if (slot.state.heldBy !== `${got.pid}@${got.host}`) log("read_model.lease_elsewhere", { instance: slot.instance.name, heldBy: got.heldBy, pid: got.pid, host: got.host, expiresMs: got.expiresMs });
      Object.assign(slot.state, { lease: "elsewhere", heldBy: `${got.pid}@${got.host}`, reason: `lease held by pid ${got.pid} on ${got.host}` });
      return false;
    }
    if (slot.state.lease !== "held") log("read_model.lease_acquired", { instance: slot.instance.name, holder, was: slot.state.lease });
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
      // Stamped when the tick COMPLETED: a catch-up tick is judged from its end, not from its start.
      const tickedAt = clock.now();
      if (tickedAt - now > READ_MODEL_LEDGER_STALE_MS) {
        log("read_model.slow_tick", { instance: slot.instance.name, ms: tickedAt - now, transactions: result.transactions, archivesRead: result.archivesRead, liveRestarted: result.liveRestarted });
      }
      Object.assign(slot.state, { tickedAt, generation: Number(db.meta("generation")), failures: 0, newestTs: newest == null ? null : fixedClock(Number(newest)).iso() });
      delete slot.state.reason;
      if (result.unread.length > 0) slot.state.reason = `unread archives: ${result.unread.join("; ")}`;
      slot.backoffUntil = 0;
      // A tick that read archives, restarted the live file or needed several chunks was catching up.
      const caughtUp = result.archivesRead === 0 && !result.liveRestarted && result.transactions <= 1 && result.unread.length === 0;
      slot.checkPending = opts.oracle !== "off" && caughtUp && now >= slot.checkAfter && (!nextOracleSlice(db, now, windowMs).startsCycle || consistencyCheckDue(db, now));
    } catch (error) {
      // failSlot logs it, backs this instance off, and closes the slot on a lost lease.
      failSlot(slot, now, error);
    }
  }

  function failSlot(slot: Slot, now: number, error: unknown): void {
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

  /**
   * One slice of the oracle's rolling cycle, as a tick of its own: the projector does not run in it.
   * By the lease holder only, never beside a rebuild; the next is paced by what this one cost.
   */
  function checkSlot(slot: Slot, now: number): void {
    slot.checkPending = false;
    try {
      if (!ensureLease(slot, now)) return;
      const db = slot.db!;
      const instance = slot.instance.name;
      const rebuild = rebuildHolder(opts.stateDir, instance, now);
      if (rebuild !== undefined) {
        slot.checkAfter = now + ORACLE_DRIFT_INTERVAL_MS;
        return log("read_model.consistency_deferred", { instance, reason: `a rebuild holds ${rebuild}`, retryInMs: ORACLE_DRIFT_INTERVAL_MS });
      }
      const { window, cursor } = nextOracleSlice(db, now, windowMs);
      try {
        runConsistencyCheck({
          db, ledgerDir: slot.instance.ledgerDir, instance, metricLedgerPath: join(opts.stateDir, LEDGER_FILENAME), lease: slot.lease!, clock, window,
          ...(opts.escalation ? { escalation: opts.escalation } : {}),
        });
      } catch (error) {
        if (error instanceof ReadModelError && error.reason === "lease_lost") throw error;
        slot.checkAfter = now + ORACLE_DRIFT_INTERVAL_MS;
        log("read_model.consistency_failed", { instance, window: [window.t0, window.t1], error: (error as Error).message, retryInMs: ORACLE_DRIFT_INTERVAL_MS });
      }
      advanceOracleSlice(db, slot.lease!, cursor);
      const finished = clock.now();
      slot.checkAfter = Math.max(slot.checkAfter, finished + (finished - now) / READ_MODEL_CHECK_SHARE);
    } catch (error) {
      // failSlot logs it, backs this instance off, and closes the slot on a lost lease.
      failSlot(slot, now, error);
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

  function viewShadow(): ViewShadow | undefined {
    const home = slots[0];
    if (home?.db === undefined || home.lease === undefined) return undefined;
    if (comparator?.db !== home.db) {
      comparator = { db: home.db, shadow: createViewShadow({
        clock, log, store: sqliteShadowStore(home.db, home.lease),
        evidence: (input) => readShadowEvidence(slots.flatMap((slot) => (slot.db ? [slot.db] : [])), input),
      }) };
    }
    return comparator.shadow;
  }

  function materialize(now: number): void {
    const shadow = comparator?.shadow.readiness();
    const ctx: ReadModelViewContext = { now, switches, instances: slots.map((slot) => ({ state: slot.state, ...(slot.db ? { db: slot.db } : {}) })), ...(shadow ? { shadow } : {}) };
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
          latest.set(id, body);
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
      const due = switches.projector === "on" ? slots.find((slot) => slot.checkPending) : undefined;
      if (due) {
        checkSlot(due, now);
      } else if (switches.projector === "off") {
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
    shadow(request: ShadowRequest): boolean {
      const body = latest.get(`${request.view}\u0000${request.key}`);
      try {
        const legacy = request.legacy
          ?? (body ? views.find((view) => view.name === request.view)?.legacy?.(request.key, clock.now(), body.data) : undefined);
        const shadow = body && legacy ? viewShadow() : undefined;
        if (!body || !legacy || !shadow) return false;
        shadow.compare({ view: request.view, key: request.key, requests: request.requests, legacy, body });
        return true;
      } catch (error) {
        log("view.shadow_failed", { view: request.view, key: request.key, error: (error as Error).message });
        return false;
      }
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
  /** `owner/name` the oracle's escalations are filed on; the worker builds its own issue gateway. */
  escalationRepository?: string;
}

/** The worker branch's body: tick on a timer until asked to stop, then release and signal. */
export function runReadModelWorker(
  port: { on(event: "message", run: (msg: { type?: string }) => void): unknown; postMessage(value: unknown): void; close(): void },
  data: ReadModelWorkerData,
  clock: Clock = systemClock,
): void {
  const signal = new Int32Array(data.signal);
  const stopRequested = (): boolean => Atomics.load(signal, 0) === 1;
  const [owner, repo] = data.escalationRepository?.split("/") ?? [];
  const escalation = owner && repo ? { issues: ghIssueGateway(owner, repo), ledgerPath: join(data.stateDir, LEDGER_FILENAME), runId: READ_MODEL_WORKER_KIND } : undefined;
  const post = (m: ReadModelWorkerMessage): void => port.postMessage(m);
  const now = createNowView({ instances: data.instances, ledgerSource, clock, log: (step, extra) => post({ type: "log", step, extra }) });
  const ticker = createReadModelTicker({
    stateDir: data.stateDir, instances: data.instances, tickMs: data.tickMs, clock, stopRequested, post, views: [...READ_MODEL_VIEWS, now], ...(escalation ? { escalation } : {}),
  });
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
    if (msg.type === "shadow") return void ticker.shadow(msg as unknown as ShadowRequest);
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
  /** Re-judge persisted sources against the latest worker state. */
  judge(sources: readonly ViewSource[], now: number): ViewSource[];
  /** The switch file as the main thread last read it. */
  switches(): ReadModelSwitches;
  start(): void;
  /** Asks the worker to release its leases and waits, bounded, for it. True when it confirmed. */
  stop(): boolean;
  /** Hands one sampled shadow request to the worker, which diffs it off serve's main thread. */
  shadow(request: ShadowRequest): void;
}

export interface ReadModelWorkerOptions {
  stateDir: string;
  instances: readonly ReadModelInstance[];
  tickMs?: number;
  stopWaitMs?: number;
  workerUrl?: URL;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  escalationRepository?: string;
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
  let darkReason: string | undefined;
  const refreshSwitches = (): void => {
    const read = readReadModelSwitches(switchesPath);
    mainSwitches = read.ok ? read.switches : { projector: mainSwitches.projector, views: {} };
    const reason = read.ok ? read.absent : read.reason;
    if (reason !== undefined && reason !== darkReason) opts.log?.(read.ok ? "read_model.switch_absent" : "read_model.switch_unreadable", { reason, views: "dark" });
    darkReason = reason;
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
    const data: ReadModelWorkerData = {
      kind: READ_MODEL_WORKER_KIND, stateDir: opts.stateDir, instances: [...opts.instances], tickMs: opts.tickMs ?? READ_MODEL_TICK_MS, signal: shared,
      ...(opts.escalationRepository ? { escalationRepository: opts.escalationRepository } : {}),
    };
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
    shadow: (request) => worker?.postMessage({ type: "shadow", ...request }),
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
