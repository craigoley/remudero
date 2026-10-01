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
import { ghIssueGateway, tryEscalate, type EscalateDeps } from "./escalate.js";
import { createInstancesView } from "./instances-view.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { FUTURE_ROW_TOLERANCE_MS, LEDGER_PROJECTOR_SCHEMA_VERSION, createLedgerProjector, openProjectorReadModel, type LedgerProjector, type ProjectorTickResult } from "./ledger-projector.js";
import { createNavBadgeReadModelView } from "./nav-badge-view.js";
import { createNowView } from "./now-view.js";
import {
  ORACLE_DEFAULT_WINDOW_MS,
  ORACLE_DRIFT_INTERVAL_MS,
  ORACLE_INGEST_SETTLE_MS,
  ORACLE_SLICE_BUDGET_MS,
  advanceOracleSlice,
  consistencyCheckDue,
  nextOracleSlice,
  recordIngestMark,
  retryOracleSlice,
  runConsistencyCheck,
  settledIngestMark,
  type IngestMark,
  type OracleWindow,
} from "./read-model-consistency.js";
import {
  READ_MODEL_DIRNAME,
  READ_MODEL_LEASE_TTL_MS,
  ReadModelError,
  acquireLease,
  attachReadModel,
  currentReadModelPath,
  openReadModel,
  peekLease,
  quickCheckReadModel,
  releaseLease,
  withWriteTransaction,
  type ReadModelDb,
  type ReadModelLease,
} from "./read-model-db.js";
import { threadSlowLane, type SlowLane, type SlowLaneBodies, type SlowLaneConfig } from "./read-model-slow-lane.js";
import { readModelCommand } from "./read-model-cli.js";
import { createRepositoriesReadModelView } from "./repositories-view.js";
import { createViewShadow, readShadowEvidence, sqliteShadowStore, storedShadowReadiness, type ShadowLegacy, type ShadowReadiness, type ShadowRequest, type ShadowSample, type ViewShadow } from "./view-shadow.js";
import { oldestAsOf, viewEtag, type ViewBody, type ViewBodyEntry, type ViewSource } from "./views.js";
import { describeSource, judgeSource, type SourcePhase } from "./view-freshness.js";

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
/**
 * The share of one lease-renewal interval a pass over every instance may spend projecting. Each
 * instance's tick budget is this share split among them, so a backlog of any size is applied in
 * short ticks and every lease is renewed on schedule between them.
 */
export const READ_MODEL_PASS_SHARE = 0.5;
/** BACKSTOP: the oracle thread's heap; a slice that outgrows it kills that thread, never serve's. */
export const READ_MODEL_ORACLE_HEAP_MB = 1_024;
const READ_MODEL_ORACLE_KIND = "remudero-read-model-oracle" as const;
/**
 * The share of each pass kept for view bodies, and of worker time they may take: a view that cost
 * `c` ms is not rebuilt for `c / share` ms. Measured on the host's core ledger as three instances,
 * `now` cost 0.6-1.4 s per instance whenever a generation moved and nav-badge ~130 ms even idle,
 * so unbudgeted bodies alone held ticks of 2-4 s beside a catch-up.
 */
export const READ_MODEL_VIEW_SHARE = 0.4;
/** Work outstanding without a commit for this long is stalled; serve watches silent workers too. */
export const READ_MODEL_STALL_MS = 60_000;
/**
 * A clean open is checked this long after it, then again at this cadence. The oracle compares rows
 * in recent windows only; quick_check reads every page, so it alone sees a damaged b-tree, freelist
 * or old page no query has touched yet.
 */
export const READ_MODEL_INTEGRITY_INTERVAL_MS = 24 * 3_600_000;
const READ_MODEL_INTEGRITY_KIND = "remudero-read-model-integrity" as const;

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
  /** GET /v1/views/events' kill switch (view-events.ts); absent reads `off`, so push is dark until switched on. */
  push?: "on" | "off";
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
  const obj = (raw ?? {}) as { projector?: unknown; views?: unknown; push?: unknown };
  const views: Record<string, ReadModelViewMode> = {};
  for (const [name, mode] of Object.entries(typeof obj.views === "object" && obj.views !== null ? obj.views : {})) {
    if (mode !== "serve" && mode !== "shadow" && mode !== "off") return { ok: false, reason: `view ${name} has mode ${JSON.stringify(mode)}` };
    views[name] = mode;
  }
  const projector = obj.projector ?? "on";
  if (projector !== "on" && projector !== "off") return { ok: false, reason: `projector has mode ${JSON.stringify(projector)}` };
  if (obj.push !== undefined && obj.push !== "on" && obj.push !== "off") return { ok: false, reason: `push has mode ${JSON.stringify(obj.push)}` };
  return { ok: true, switches: { projector, views, ...(obj.push !== undefined ? { push: obj.push } : {}) }, mtimeMs };
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
  /** Present while one of its oracle slices is running. */
  checking?: true;
  /** Present while a backlog is being applied: how far behind, and the ETA measured at `at`. */
  catchUp?: { rowsBehind: number; etaMs: number; at: number };
}

export type ReadModelBodyEntry = ViewBodyEntry;

export type ReadModelWorkerMessage =
  | { type: "body"; entry: ReadModelBodyEntry }
  | { type: "state"; at: number; instances: ReadModelInstanceState[]; switches: ReadModelSwitches }
  | { type: "log"; step: string; extra: Record<string, unknown> }
  /** A key the slow lane's view no longer has (a page that emptied): serve forgets its body. */
  | { type: "drop"; view: string; key: string }
  /** Each non-ledger source's latest reading, posted once per tick when one changed: a body whose data did not move is not re-posted, but its sources still age. */
  | { type: "sources"; sources: ViewSource[] }
  /** The heartbeat inside a long tick: `open` before a store's open (its quick_check), `opened` with what it took, `commit` per applied transaction. */
  | { type: "progress"; instance: string; phase: "open" | "opened" | "commit"; ms?: number; rows?: number };

export interface ReadModelViewContext {
  now: number;
  instances: ReadonlyArray<{ state: ReadModelInstanceState; db?: ReadModelDb; lease?: ReadModelLease }>;
  switches?: ReadModelSwitches;
  /** Each shadowed view's diff counters and cutover readiness (view-shadow.ts). */
  shadow?: ShadowReadiness[];
}

/** A view the worker materializes. `materialize` returns one body per key (`""` when unkeyed). */
export interface ReadModelView {
  name: string;
  version: number;
  materialize(ctx: ReadModelViewContext): Array<{ key: string; data: unknown; sources: ViewSource[] }>;
  /** Work ahead of `materialize`, one bounded step per `more()`; false while some remains, and no body is built before it is done. */
  prepare?(ctx: ReadModelViewContext, more: () => boolean): boolean;
  /** The shadow comparator's legacy side for one key, computed in the worker beside the view's body. */
  legacy?(key: string, now: number, data: unknown): ShadowLegacy | undefined;
  /** Its bodies are per instance: each instance's is built, timed and paced as a unit of its own. */
  perInstance?: boolean;
}

/** Why a projector that is not fresh is not: the structured half of its `reason`. */
function ledgerPhase(state: ReadModelInstanceState): SourcePhase {
  if (state.lease === "elsewhere") return "elsewhere";
  if (state.failures > 0) return "failed";
  if (state.catchUp) return "catching_up";
  return state.tickedAt === undefined ? "warming" : "behind";
}

/** The `ledger:<i>` source every read-model view carries: stale while its projector is behind, with why and, catching up, when it is done. */
export function ledgerSource(state: ReadModelInstanceState, now: number, staleMs: number = READ_MODEL_LEDGER_STALE_MS): ViewSource {
  const base = describeSource({ name: `${LEDGER_SOURCE_PREFIX}${state.instance}`, asOf: state.newestTs, state: "fresh", budgetMs: staleMs });
  const behindMs = state.tickedAt === undefined ? undefined : Math.max(0, now - state.tickedAt);
  const lag = behindMs === undefined ? {} : { lagMs: behindMs };
  const eta = state.catchUp ? { etaMs: Math.max(0, state.catchUp.etaMs - (now - state.catchUp.at)) } : {};
  const stale = (reason: string): ViewSource => ({ ...base, state: "stale", reason, phase: ledgerPhase(state), ...lag, ...eta });
  if (behindMs === undefined) return stale(state.reason ?? "projector has not ticked yet");
  if (behindMs > staleMs) return stale(`projector ${Math.round(behindMs / 1000)} s behind${state.reason ? `: ${state.reason}` : ""}`);
  if (state.reason) return stale(state.reason);
  return { ...base, ...lag };
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
  /** How old an ingest mark must be before the oracle compares the rows below it. */
  ingestSettleMs?: number;
  /** One slice's time budget; the measured rows per ms turn it into a row count. */
  oracleSliceBudgetMs?: number;
  /** Each instance's projector budget per tick; derived from the lease timing when absent. */
  tickBudgetMs?: number;
  /** A whole pass's budget: projection, then view bodies in what is left of it. */
  passBudgetMs?: number;
  /** Where slices run; in this thread by default, on the oracle's own thread inside serve's worker. */
  oracleRunner?: ReadModelOracle;
  /** Where the background integrity check runs; in this thread by default, on a thread of its own inside serve's worker. */
  integrityCheck?: (request: IntegrityRequest, done: (result: IntegrityResult) => void) => void;
}

export interface IntegrityRequest {
  instance: string;
  stateDir: string;
  ledgerDir: string;
  dbPath: string;
}

/** `rebuild`: what `rmd read-model rebuild` answered for a corrupt file; absent when the file was healthy or unreadable. */
export type IntegrityResult = { ok: true; ms: number } | { ok: false; corrupt: boolean; error: string; ms: number; rebuild?: { code: number; output: string[] } };

/**
 * quick_check on a connection of its own; a corrupt file is rebuilt into a new generation and the
 * pointer flipped (`rmd read-model rebuild`), whose fence sends the projector to the new file.
 */
export function checkReadModelIntegrity(
  request: IntegrityRequest,
  clock: Clock = systemClock,
  rebuild: (request: IntegrityRequest) => { code: number; output: string[] } = (r) => {
    const output: string[] = [];
    const sink = (line: string): void => void output.push(line);
    const code = readModelCommand(["rebuild", "--instance", r.instance, "--ledger-dir", r.ledgerDir], { stateDir: r.stateDir, clock, out: sink, error: sink });
    return { code, output };
  },
): IntegrityResult {
  const started = clock.now();
  const check = quickCheckReadModel(request.dbPath);
  if (check.ok) return { ok: true, ms: clock.now() - started };
  return { ...check, ms: clock.now() - started, ...(check.corrupt ? { rebuild: rebuild(request) } : {}) };
}

/** One thread per check, which exits when done: a check is rare, and one that dies is reported, never hung on. */
export function threadIntegrityCheck(workerUrl?: URL): NonNullable<ReadModelTickerOptions["integrityCheck"]> {
  return (request, done) => {
    let settled = false;
    let failure = "";
    const thread = new Worker(workerUrl ?? new URL(import.meta.url), { workerData: { kind: READ_MODEL_INTEGRITY_KIND, request }, execArgv: process.execArgv });
    thread.unref();
    thread.on("message", (result: IntegrityResult) => {
      settled = true;
      done(result);
    });
    thread.on("error", (error) => void (failure = `: ${error.message}`));
    thread.on("exit", (code) => {
      if (!settled) done({ ok: false, corrupt: false, error: `the integrity thread exited with code ${code}${failure}`, ms: 0 });
    });
  };
}

/** One oracle slice: everything a thread needs to attach to the store and check it. */
export interface OracleSliceRequest {
  instance: string;
  stateDir: string;
  ledgerDir: string;
  dbPath: string;
  lease: { name: string; holder: string; ttlMs: number };
  window: OracleWindow;
  mark: IngestMark;
}

/** `died`: the slice never finished (its thread ran out of memory or exited), so it is retried smaller, never skipped. */
export type OracleSliceResult = { ok: true; rows: number; elapsedMs: number } | { ok: false; error: string; leaseLost: boolean; died?: true };

/** Runs oracle slices. `done` is called exactly once, before `run` returns or later. */
export interface ReadModelOracle {
  run(request: OracleSliceRequest, done: (result: OracleSliceResult) => void): void;
  close(): void;
}

/** One slice against an open store, under the request's lease holder; every failure becomes a result. */
export function checkOracleSlice(db: ReadModelDb, request: OracleSliceRequest, clock: Clock, escalation?: EscalateDeps): OracleSliceResult {
  try {
    const run = runConsistencyCheck({
      db, ledgerDir: request.ledgerDir, instance: request.instance, metricLedgerPath: join(request.stateDir, LEDGER_FILENAME),
      lease: { ...request.lease, clock }, clock, window: request.window, ingestMark: request.mark, ...(escalation ? { escalation } : {}),
    });
    return { ok: true, rows: run.ledgerRows, elapsedMs: run.elapsedMs };
  } catch (error) {
    return { ok: false, error: (error as Error).message, leaseLost: error instanceof ReadModelError && error.reason === "lease_lost" };
  }
}

/** Slices run in the calling thread, on the ticker's own connection: `done` is called before `run` returns. */
export function inProcessOracle(dbFor: (request: OracleSliceRequest) => ReadModelDb | undefined, clock: Clock, escalation?: EscalateDeps): ReadModelOracle {
  return {
    run: (request, done) => {
      const db = dbFor(request);
      done(db ? checkOracleSlice(db, request, clock, escalation) : { ok: false, error: `no open store for ${request.instance}`, leaseLost: false });
    },
    close: () => {},
  };
}

/**
 * Slices run on a thread of their own with their own connection, so however long one takes, the
 * projector's ticks go on. A slice cost 0.03-1.9 s on the fleet host, but one that healed held the
 * projector's thread 19.5 min on 2026-09-30, and every view went stale behind it. The thread is
 * spawned on first use and again after it dies; a slice in flight when it dies fails, never hangs.
 */
export function threadOracle(opts: { workerUrl?: URL; escalationRepository?: string; log: (step: string, extra: Record<string, unknown>) => void }): ReadModelOracle {
  let worker: Worker | undefined;
  let pending: { id: number; done: (result: OracleSliceResult) => void } | undefined;
  let seq = 0;
  const settle = (result: OracleSliceResult): void => {
    const waiting = pending;
    pending = undefined;
    waiting?.done(result);
  };
  const spawn = (): Worker => {
    const data: ReadModelOracleData = { kind: READ_MODEL_ORACLE_KIND, ...(opts.escalationRepository ? { escalationRepository: opts.escalationRepository } : {}) };
    const spawned = new Worker(opts.workerUrl ?? new URL(import.meta.url), { workerData: data, execArgv: process.execArgv, resourceLimits: { maxOldGenerationSizeMb: READ_MODEL_ORACLE_HEAP_MB } });
    spawned.unref();
    spawned.on("message", (msg: { type?: string; id?: number; result?: OracleSliceResult }) => {
      if (msg.type === "done" && msg.id === pending?.id) settle(msg.result!);
    });
    spawned.on("error", (error) => opts.log("read_model.oracle_failed", { error: String(error?.message ?? error) }));
    spawned.on("exit", (code) => {
      if (worker !== spawned) return;
      worker = undefined;
      settle({ ok: false, error: `the oracle thread exited with code ${code}`, leaseLost: false, died: true });
    });
    return spawned;
  };
  return {
    run: (request, done) => {
      worker ??= spawn();
      pending = { id: ++seq, done };
      worker.postMessage({ type: "check", id: pending.id, request });
    },
    close: () => {
      pending = undefined;
      const running = worker;
      worker = undefined;
      void running?.terminate();
    },
  };
}

interface ReadModelOracleData {
  kind: typeof READ_MODEL_ORACLE_KIND;
  escalationRepository?: string;
}

/** The oracle thread's body: attach to each store once, run each slice, post its result. */
export function runReadModelOracleWorker(
  port: { on(event: "message", run: (msg: { type?: string; id?: number; request?: OracleSliceRequest }) => void): unknown; postMessage(value: unknown): void },
  data: ReadModelOracleData,
  clock: Clock = systemClock,
): void {
  const stores = new Map<string, ReadModelDb>();
  const [owner, repo] = data.escalationRepository?.split("/") ?? [];
  port.on("message", (msg) => {
    if (msg.type !== "check" || !msg.request) return;
    const request = msg.request;
    let result: OracleSliceResult;
    try {
      let db = stores.get(request.dbPath);
      if (!db) stores.set(request.dbPath, (db = attachReadModel(request.dbPath, LEDGER_PROJECTOR_SCHEMA_VERSION)));
      const escalation = owner && repo ? { issues: ghIssueGateway(owner, repo), ledgerPath: join(request.stateDir, LEDGER_FILENAME), runId: READ_MODEL_WORKER_KIND } : undefined;
      result = checkOracleSlice(db, request, clock, escalation);
    } catch (error) {
      result = { ok: false, error: `the oracle could not attach to ${request.dbPath}: ${(error as Error).message}`, leaseLost: false };
    }
    port.postMessage({ type: "done", id: msg.id, result });
  });
}

export interface ReadModelTicker {
  /** Opens every instance's DB and takes its lease before the first tick, then posts the state. */
  start(): void;
  tick(): void;
  /** Compares one sampled shadow request against the latest body; false when there was nothing to compare. */
  shadow(request: ShadowRequest): boolean;
  /** Releases every held lease and closes every DB; returns how many leases were released. */
  release(): number;
  /** Takes every key of a view the slow lane built: each is served like a materialized body, and a key not among them is dropped. */
  accept(built: SlowLaneBodies): void;
}

/** One view, or one instance's share of a per-instance view: the unit the pass budgets, times and paces. */
interface ViewUnit {
  view: ReadModelView;
  slot?: Slot;
  /** What its last build took; absent until it has run once. */
  costMs?: number;
  /** Not rebuilt before this: its last cost divided by {@link READ_MODEL_VIEW_SHARE}. */
  dueAt: number;
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
  /** When this slot's newest ingest mark was taken; a new one is due half a settle period later. */
  markAt?: number;
  /** Present while a backlog is being applied over several ticks; the oracle waits until it clears. */
  catchUp?: { startedAt: number; ticks: number; maxTickMs: number; lines: number; sourceBytes: number; loggedAt: number };
  /** Present while work is outstanding and nothing commits: the watchdog's episode. */
  stall?: { since: number; generation: number; reopened: boolean; escalated: boolean };
  /** The next background integrity check: at once after an unclean shutdown, else on the interval. */
  integrity?: { at: number; reason: string; running: boolean };
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
  const settleMs = opts.ingestSettleMs ?? ORACLE_INGEST_SETTLE_MS;
  const sliceBudgetMs = opts.oracleSliceBudgetMs ?? ORACLE_SLICE_BUDGET_MS;
  const oracle = opts.oracleRunner ?? inProcessOracle((request) => slots.find((slot) => slot.db?.path === request.dbPath)?.db, clock, opts.escalation);
  const integrityCheck = opts.integrityCheck ?? ((request, done) => done(checkReadModelIntegrity(request, clock)));
  /** The slot whose slice is running; one at a time across every instance. */
  let checking: Slot | undefined;
  const passMs = opts.passBudgetMs ?? READ_MODEL_LEASE_RENEW_MS * READ_MODEL_PASS_SHARE;
  const budgetMs = opts.tickBudgetMs ?? (passMs * (1 - READ_MODEL_VIEW_SHARE)) / Math.max(1, opts.instances.length);
  /** A view unit measured over this runs in a tick of its own, so it never lands on top of a projection. */
  const soloMs = passMs * READ_MODEL_VIEW_SHARE;
  const switchesPath = readModelSwitchesPath(opts.stateDir);
  const slots: Slot[] = opts.instances.map((instance) => ({
    instance,
    state: { instance: instance.name, generation: 0, lease: "none", failures: 0, newestTs: null },
    renewedAt: 0,
    backoffUntil: 0,
    checkAfter: 0,
    checkPending: false,
  }));
  const units = views.flatMap((view): ViewUnit[] => (view.perInstance ? slots.map((slot) => ({ view, slot, dueAt: 0 })) : [{ view, dueAt: 0 }]));
  let lastSolo = false;
  const lastEtag = new Map<string, string>();
  const latest = new Map<string, ViewBody>();
  const clocks = new Map<string, { key: string; source: ViewSource }>();
  let clocksMoved = false;
  let comparator: { db: ReadModelDb; shadow: ViewShadow } | undefined;
  let deferredLoggedAt = Number.NEGATIVE_INFINITY;
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
      const opening = clock.now();
      opts.post({ type: "progress", instance: slot.instance.name, phase: "open" });
      slot.db = openProjectorReadModel(opts.stateDir, slot.instance.name, clock);
      slot.ino = fileIno(slot.db.path);
      opts.post({ type: "progress", instance: slot.instance.name, phase: "opened", ms: clock.now() - opening });
      if (slot.db.uncleanShutdown) slot.integrity = { at: now, reason: "unclean shutdown", running: slot.integrity?.running ?? false };
      slot.integrity ??= { at: now + READ_MODEL_INTEGRITY_INTERVAL_MS, reason: "periodic", running: false };
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
        onCommit: (_source, rows) => opts.post({ type: "progress", instance: slot.instance.name, phase: "commit", rows }),
      });
    }
    slot.lease = got.lease;
    slot.renewedAt = now;
    slot.state.lease = "held";
    delete slot.state.heldBy;
    return true;
  }

  /** A tick that stopped at its budget leaves the instance stale with its backlog and ETA; the last one ledgers the whole catch-up. */
  function trackCatchUp(slot: Slot, result: ProjectorTickResult, started: number, ended: number): void {
    if (!result.pending && !slot.catchUp) return;
    const instance = slot.instance.name;
    const run = (slot.catchUp ??= { startedAt: started, ticks: 0, maxTickMs: 0, lines: 0, sourceBytes: 0, loggedAt: Number.NEGATIVE_INFINITY });
    run.ticks++;
    run.maxTickMs = Math.max(run.maxTickMs, ended - started);
    run.lines += result.lines;
    run.sourceBytes += result.sourceBytes;
    if (!result.pending) {
      log("read_model.caught_up", { instance, ms: ended - run.startedAt, ticks: run.ticks, maxTickMs: run.maxTickMs, rows: run.lines, budgetMs });
      slot.catchUp = undefined;
      delete slot.state.catchUp;
      return;
    }
    const rowsBehind = Math.round((result.backlogBytes * run.lines) / Math.max(1, run.sourceBytes));
    const etaMs = Math.round((result.backlogBytes * Math.max(1, ended - run.startedAt)) / Math.max(1, run.sourceBytes));
    slot.state.reason = `catching up: about ${rowsBehind} rows (${result.backlogBytes} bytes) behind, done in about ${Math.ceil(etaMs / 1000)} s`;
    slot.state.catchUp = { rowsBehind, etaMs, at: ended };
    if (ended - run.loggedAt < READ_MODEL_LEDGER_STALE_MS) return;
    run.loggedAt = ended;
    log("read_model.catch_up", { instance, rowsBehind, bytesBehind: result.backlogBytes, etaMs, ticks: run.ticks, maxTickMs: run.maxTickMs, budgetMs });
  }

  function tickSlot(slot: Slot, now: number): void {
    try {
      if (!ensureLease(slot, now)) return;
      if (now >= slot.integrity!.at && !slot.integrity!.running) startIntegrity(slot, now);
      const result = slot.projector!.tick({ budgetMs });
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
      trackCatchUp(slot, result, now, tickedAt);
      slot.backoffUntil = 0;
      // A tick that read archives, restarted the live file or needed several chunks was catching up.
      const caughtUp = result.archivesRead === 0 && !result.liveRestarted && result.transactions <= 1 && result.unread.length === 0;
      if (opts.oracle !== "off") {
        if (slot.markAt === undefined || tickedAt - slot.markAt >= settleMs / 2) slot.markAt = recordIngestMark(db, slot.lease!, tickedAt, settleMs);
        slot.checkPending = caughtUp && now >= slot.checkAfter && (!nextOracleSlice(db, now, windowMs, sliceBudgetMs).startsCycle || consistencyCheckDue(db, now));
      }
      watchProgress(slot, tickedAt, result.pending || result.unread.length > 0);
    } catch (error) {
      // failSlot logs it, backs this instance off, and closes the slot on a lost lease.
      failSlot(slot, now, error);
      watchProgress(slot, now, true);
    }
  }

  /**
   * The watchdog: a tick that committed, or had nothing left to do, is progress. Outstanding work
   * with no commit for {@link READ_MODEL_STALL_MS} ledgers the stall and reopens the store; the
   * same again without progress escalates through the oracle's path, once per episode.
   */
  function watchProgress(slot: Slot, now: number, outstanding: boolean): void {
    const generation = slot.state.generation;
    if (!outstanding || (slot.stall && generation > slot.stall.generation)) {
      if (slot.stall?.reopened) log("read_model.unstalled", { instance: slot.instance.name, stalledMs: now - slot.stall.since });
      slot.stall = outstanding ? { since: now, generation, reopened: false, escalated: false } : undefined;
      return;
    }
    const stall = (slot.stall ??= { since: now, generation, reopened: false, escalated: false });
    const stalledMs = now - stall.since;
    const extra = { instance: slot.instance.name, stalledMs, generation, reason: slot.state.reason ?? "work outstanding" };
    if (stalledMs >= READ_MODEL_STALL_MS && !stall.reopened) {
      stall.reopened = true;
      log("read_model.stalled", extra);
      closeSlot(slot);
    } else if (stalledMs >= 2 * READ_MODEL_STALL_MS && !stall.escalated) {
      stall.escalated = true;
      const issueUrl = opts.escalation ? tryEscalate({
        class: "MANUAL",
        taskId: `READ-MODEL-${slot.instance.name.toUpperCase()}`,
        summary: `read model ${slot.instance.name} has stopped advancing`,
        detail: `The projector has had work outstanding for ${Math.round(stalledMs / 1000)} s with no commit, and reopening its store did not help. Last reason: ${extra.reason}.`,
        options: [
          { label: "rebuild the read model", detail: "Run `rmd read-model rebuild`; the views keep serving the old file until the new one passes its check.", kind: { type: "operator-only" } },
          { label: "restart serve", detail: "Recycle the serve container; the projector resumes from its checkpoints.", kind: { type: "operator-only" } },
        ],
        recommendation: "restart serve",
        consequence: "Every view that reads this instance stays stale until the projector advances.",
      }, opts.escalation) : null;
      log("read_model.stall_escalated", { ...extra, issueUrl });
    }
  }

  /** Started, never waited for: the projector ticks on beside it, and a corrupt file's rebuild flips the pointer under it. */
  function startIntegrity(slot: Slot, now: number): void {
    const integrity = slot.integrity!;
    const instance = slot.instance.name;
    integrity.running = true;
    log("read_model.integrity_started", { instance, reason: integrity.reason });
    integrityCheck({ instance, stateDir: opts.stateDir, ledgerDir: slot.instance.ledgerDir, dbPath: slot.db!.path }, (result) => {
      Object.assign(integrity, { running: false, at: clock.now() + READ_MODEL_INTEGRITY_INTERVAL_MS, reason: "periodic" });
      log(result.ok ? "read_model.integrity_ok" : "read_model.integrity_failed", { instance, startedAt: now, ...result });
    });
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
   * Starts one slice of the oracle's rolling cycle on the oracle runner: by the lease holder only,
   * never beside a rebuild, and only below an ingest mark a settle period old. The projector keeps
   * ticking while it runs; the next slice waits in proportion to what this one cost.
   */
  function startCheck(slot: Slot, now: number): void {
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
      // Only rows the projector had applied a settle period ago are compared: a late row is never drift.
      const mark = settledIngestMark(db, now, settleMs);
      if (mark === undefined) {
        slot.checkAfter = now + settleMs;
        return log("read_model.consistency_deferred", { instance, reason: `no ingest mark is ${settleMs} ms old yet`, retryInMs: settleMs });
      }
      const slice = nextOracleSlice(db, now, windowMs, sliceBudgetMs);
      const lease = slot.lease!;
      checking = slot;
      slot.state.checking = true;
      oracle.run(
        { instance, stateDir: opts.stateDir, ledgerDir: slot.instance.ledgerDir, dbPath: db.path, lease: { name: lease.name, holder: lease.holder, ttlMs: lease.ttlMs }, window: slice.window, mark },
        (result) => finishCheck(slot, db, slice, now, result),
      );
    } catch (error) {
      // failSlot logs it, backs this instance off, and closes the slot on a lost lease.
      failSlot(slot, now, error);
    }
  }

  function finishCheck(slot: Slot, db: ReadModelDb, slice: ReturnType<typeof nextOracleSlice>, started: number, result: OracleSliceResult): void {
    checking = undefined;
    delete slot.state.checking;
    const now = clock.now();
    const instance = slot.instance.name;
    try {
      if (!result.ok && result.leaseLost) throw new ReadModelError("lease_lost", result.error);
      if (!result.ok) {
        slot.checkAfter = now + ORACLE_DRIFT_INTERVAL_MS;
        log("read_model.consistency_failed", { instance, window: [slice.window.t0, slice.window.t1], error: result.error, retryInMs: ORACLE_DRIFT_INTERVAL_MS });
      }
      // A slot reopened meanwhile plans its next slice afresh from its own store.
      if (slot.db !== db || slot.lease === undefined) return;
      if (!result.ok && result.died) retryOracleSlice(db, slot.lease, slice);
      else advanceOracleSlice(db, slot.lease, slice, result.ok ? { rows: result.rows, ms: result.elapsedMs } : undefined);
      slot.checkAfter = Math.max(slot.checkAfter, now + (now - started) / READ_MODEL_CHECK_SHARE);
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

  /** A view's prepare steps until `deadline`; the first is always allowed, so every build makes progress. */
  function stepsUntil(deadline: number): () => boolean {
    let first = true;
    return () => {
      const allowed = first || clock.now() < deadline;
      first = false;
      return allowed;
    };
  }

  /** One materialized body: its source readings are noted, and it is persisted and posted only when its ETag moved. */
  function publish(name: string, version: number, key: string, data: unknown, sources: ViewSource[], generation: number): void {
    for (const source of sources) {
      if (source.name.startsWith(LEDGER_SOURCE_PREFIX)) continue;
      const reading = JSON.stringify({ ...source, lagMs: undefined });
      if (clocks.get(source.name)?.key === reading) continue;
      clocks.set(source.name, { key: reading, source });
      clocksMoved = true;
    }
    const stale = sources.some((source) => source.state !== "fresh");
    const etag = viewEtag(name, version, stale, data);
    const id = `${name}\u0000${key}`;
    if (lastEtag.get(id) === etag) return;
    const body: ViewBody = { view: name, version, generatedAt: clock.iso(), asOf: oldestAsOf(sources), stale, sources, data };
    const entry: ReadModelBodyEntry = { view: name, key, version, generation, etag, body };
    if (switches.projector === "on") persist(entry);
    lastEtag.set(id, etag);
    latest.set(id, body);
    opts.post({ type: "body", entry });
  }

  /** Every key this view has served: this run's and, from the home store, an earlier run's. */
  function knownKeys(view: string): Set<string> {
    const keys = new Set([...lastEtag.keys()].filter((id) => id.startsWith(`${view}\u0000`)).map((id) => id.slice(view.length + 1)));
    const db = slots[0]?.db;
    for (const row of db ? db.prepare("SELECT key FROM view_body WHERE view = ?").all(view) : []) keys.add(String(row.key));
    return keys;
  }

  /** A key a view no longer has: forgotten here, deleted from the store, and dropped from serve's memory. */
  function drop(view: string, key: string): void {
    const id = `${view}\u0000${key}`;
    lastEtag.delete(id);
    latest.delete(id);
    const home = slots[0];
    if (switches.projector === "on" && home?.db && home.lease) {
      const db = home.db;
      withWriteTransaction(db, home.lease, () => db.prepare("DELETE FROM view_body WHERE view = ? AND key = ?").run(view, key));
    }
    opts.post({ type: "drop", view, key });
  }

  function build(unit: ViewUnit, now: number, ctx: ReadModelViewContext, generation: number, allowanceMs: number): void {
    const { view } = unit;
    const started = clock.now();
    let ready = true;
    try {
      const scoped = unit.slot ? { ...ctx, instances: ctx.instances.filter(({ state }) => state === unit.slot!.state) } : ctx;
      ready = view.prepare?.(scoped, stepsUntil(started + allowanceMs)) ?? true;
      for (const { key, data, sources } of ready ? view.materialize(scoped) : []) publish(view.name, view.version, key, data, sources, generation);
    } catch (error) {
      log("read_model.materialize_failed", { view: view.name, error: (error as Error).message });
    }
    const finished = clock.now();
    unit.costMs = finished - started;
    unit.dueAt = ready ? finished + unit.costMs / READ_MODEL_VIEW_SHARE : finished;
    if (unit.costMs > passMs) log("read_model.slow_view", { view: view.name, ...(unit.slot ? { instance: unit.slot.instance.name } : {}), ms: unit.costMs, passMs });
  }

  const dueUnits = (now: number): ViewUnit[] => units.filter((unit) => switches.views[unit.view.name] !== "off" && unit.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);

  /**
   * Builds the due view units, oldest first, in what is left of the pass that began at `tickStart`.
   * A unit starts only if its last cost fits what is left; one never measured starts only while this
   * phase has spent nothing, so it overshoots by itself at most once and is measured from then on.
   */
  function materialize(now: number, tickStart: number, only?: ViewUnit): void {
    const home = slots[0]?.db;
    const shadow = home ? storedShadowReadiness(home, now) : undefined;
    const ctx: ReadModelViewContext = { now, switches, instances: slots.map((slot) => ({ state: slot.state, ...(slot.db ? { db: slot.db } : {}), ...(slot.lease ? { lease: slot.lease } : {}) })), ...(shadow ? { shadow } : {}) };
    const generation = slots.reduce((sum, slot) => sum + slot.state.generation, 0);
    if (only) return build(only, now, ctx, generation, soloMs);
    const left = passMs - (clock.now() - tickStart);
    let spent = 0;
    const deferred: string[] = [];
    for (const unit of dueUnits(now)) {
      if (stopRequested()) return;
      const fits = unit.costMs === undefined ? spent === 0 : unit.costMs <= soloMs && spent + unit.costMs <= left;
      if (!fits) {
        deferred.push(unit.slot ? `${unit.view.name}@${unit.slot.instance.name}` : unit.view.name);
        continue;
      }
      const before = clock.now();
      build(unit, now, ctx, generation, Math.min(soloMs, left - spent));
      spent += clock.now() - before;
    }
    if (deferred.length > 0 && now - deferredLoggedAt >= READ_MODEL_LEDGER_STALE_MS) {
      deferredLoggedAt = now;
      log("read_model.materialize_deferred", { ms: spent, budgetMs: Math.max(0, left), deferred });
    }
  }

  const postState = (now: number): void => {
    if (clocksMoved) {
      clocksMoved = false;
      opts.post({ type: "sources", sources: [...clocks.values()].map((clock) => clock.source) });
    }
    opts.post({ type: "state", at: now, instances: slots.map((slot) => ({ ...slot.state })), switches });
  };

  return {
    start(): void {
      const now = clock.now();
      reloadSwitches(now);
      if (switches.projector === "on") {
        for (const slot of slots) {
          try {
            ensureLease(slot, now);
          } catch (error) {
            // failSlot logs it and backs this instance off; its first tick retries the open.
            failSlot(slot, now, error);
          }
        }
      }
      postState(now);
    },
    tick(): void {
      const now = clock.now();
      reloadSwitches(now);
      // The oracle's slices wait while any instance is still applying a backlog.
      const due = switches.projector === "on" && checking === undefined && !slots.some((slot) => slot.catchUp)
        ? slots.find((slot) => slot.checkPending && now >= slot.checkAfter)
        : undefined;
      // A slice is started, never waited for: on the oracle's thread it runs while this tick projects.
      if (due) startCheck(due, now);
      // A view too big to share a pass gets a tick of its own, never two in a row, so the projector keeps moving.
      const solo = lastSolo ? undefined : dueUnits(now).find((unit) => (unit.costMs ?? 0) > soloMs);
      lastSolo = solo !== undefined;
      if (solo) {
        materialize(now, now, solo);
        return postState(now);
      }
      if (switches.projector === "off") {
        for (const slot of slots) slot.state.reason = "projector switched off";
      } else {
        for (const slot of slots) {
          if (stopRequested()) return;
          if (now >= slot.backoffUntil) tickSlot(slot, clock.now());
        }
      }
      materialize(now, now);
      postState(now);
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
    accept(built: SlowLaneBodies): void {
      const mode = switches.views[built.view];
      if (mode !== "shadow" && mode !== "serve") return;
      const generation = slots.reduce((sum, slot) => sum + slot.state.generation, 0);
      try {
        for (const { key, data, sources } of built.bodies) publish(built.view, built.version, key, data, sources, generation);
        const keep = new Set(built.bodies.map((body) => body.key));
        for (const key of knownKeys(built.view)) if (!keep.has(key)) drop(built.view, key);
      } catch (error) {
        log("read_model.materialize_failed", { view: built.view, error: (error as Error).message });
      }
    },
    release(): number {
      oracle.close();
      checking = undefined;
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
  /** The repo and host instance registries the `instances` view joins with the mounts (instances-view.ts). */
  registry?: { repoPath?: string; hostPath?: string };
  /** `[0]` is set by the main thread to ask for a stop; `[1]` by the worker once its leases are released. */
  signal: SharedArrayBuffer;
  /** `owner/name` the oracle's escalations are filed on; the worker builds its own issue gateway. */
  escalationRepository?: string;
  /** The slow lane's units (read-model-slow-lane.ts); absent, no slow lane runs. */
  slowLane?: SlowLaneConfig;
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
  let slowLane: SlowLane | undefined;
  const post = (m: ReadModelWorkerMessage): void => {
    if (m.type === "state") slowLane?.lease(m.instances[0]?.lease === "held");
    port.postMessage(m);
  };
  if (data.slowLane) slowLane = threadSlowLane({ config: data.slowLane, log: (step, extra) => post({ type: "log", step, extra }), onBodies: (built) => ticker.accept(built) });
  const now = createNowView({ instances: data.instances, ledgerSource, clock, log: (step, extra) => post({ type: "log", step, extra }) });
  const oracleRunner = threadOracle({ ...(data.escalationRepository ? { escalationRepository: data.escalationRepository } : {}), log: (step, extra) => post({ type: "log", step, extra }) });
  const instances = createInstancesView({ instances: data.instances, ...data.registry, ledgerSource });
  const ticker = createReadModelTicker({
    stateDir: data.stateDir, instances: data.instances, tickMs: data.tickMs, clock, stopRequested, post, views: [...READ_MODEL_VIEWS, now, instances], oracleRunner,
    integrityCheck: threadIntegrityCheck(), ...(escalation ? { escalation } : {}),
  });
  let timer: NodeJS.Timeout | undefined;
  let started = false;
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    slowLane?.close();
    const released = ticker.release();
    port.postMessage({ type: "log", step: "read_model.stopped", extra: { released } } satisfies ReadModelWorkerMessage);
    Atomics.store(signal, 1, 1);
    Atomics.notify(signal, 1);
    port.close();
  };
  const loop = (): void => {
    if (!stopRequested()) {
      try {
        // The leases are taken before the first tick's work, so a long first tick never delays them.
        if (!started) {
          started = true;
          ticker.start();
        }
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
if (!isMainThread && (workerData as { kind?: unknown } | undefined)?.kind === READ_MODEL_ORACLE_KIND && parentPort) {
  runReadModelOracleWorker(parentPort, workerData as ReadModelOracleData);
}
if (!isMainThread && (workerData as { kind?: unknown } | undefined)?.kind === READ_MODEL_INTEGRITY_KIND && parentPort) {
  parentPort.postMessage(checkReadModelIntegrity((workerData as { request: IntegrityRequest }).request));
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

/**
 * When each instance's lease holder last committed or renewed: every fenced write and every renewal
 * stamps `expires_ms` as that moment plus the TTL. A released or absent lease is no evidence at all.
 */
export function committedTickTimes(stateDir: string, instances: readonly ReadModelInstance[]): Map<string, number> {
  const times = new Map<string, number>();
  for (const { name } of instances) {
    try {
      const lease = peekLease(currentReadModelPath(stateDir, name, LEDGER_PROJECTOR_SCHEMA_VERSION));
      if (lease) times.set(name, lease.expiresMs - READ_MODEL_LEASE_TTL_MS);
    } catch {
      continue; // no DB file yet, or an unreadable pointer: that instance's warm bodies stay "warming"
    }
  }
  return times;
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
  /** Re-reads the committed bodies the worker has not replaced; a promoted standby calls it, so it never serves its boot-time copies. */
  reload(): number;
  /** Hands one sampled shadow request to the worker, which diffs it off serve's main thread. */
  shadow(request: ShadowRequest): void;
  /** While started, offers `sample` every key of each view switched `shadow` on each switch recheck; its throttle keeps one per sample period. */
  driveShadow(sample: ShadowSample): void;
  /** Calls `listener` with each body the worker posts, after it is stored; returns the unsubscribe. */
  onBody(listener: (entry: ReadModelBodyEntry) => void): () => void;
}

export interface ReadModelWorkerOptions {
  stateDir: string;
  instances: readonly ReadModelInstance[];
  tickMs?: number;
  registry?: ReadModelWorkerData["registry"];
  stopWaitMs?: number;
  workerUrl?: URL;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  escalationRepository?: string;
  every?: (run: () => void, ms: number) => () => void;
  /** What the silent-worker watchdog measures against. */
  clock?: Clock;
  slowLane?: SlowLaneConfig;
  /** Sees each worker message after the handle has applied it. */
  observe?: (msg: ReadModelWorkerMessage) => void;
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
  const sourceClocks = new Map<string, ViewSource>();
  let switches = DEFAULT_READ_MODEL_SWITCHES;
  let at: number | undefined;
  const home = opts.instances[0]?.name ?? "core";
  const warm = loadCommittedViewBodies(opts.stateDir, home);
  for (const entry of warm.bodies) bodies.set(readModelBodyKey(entry.view, entry.key), entry);
  opts.log?.("read_model.warm_boot", { bodies: warm.bodies.length, ...(warm.reason ? { reason: warm.reason } : {}) });
  /** Keys the running worker has posted: newer than anything committed, so a reload leaves them alone. */
  const posted = new Set<string>();
  let committedAt = committedTickTimes(opts.stateDir, opts.instances);
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
  let driven: ShadowSample | undefined;

  let worker: Worker | undefined;
  let signal: Int32Array | undefined;
  let stopping = false;
  let deaths = 0;
  let respawnTimer: NodeJS.Timeout | undefined;
  const clock = opts.clock ?? systemClock;
  /** When the running worker last said anything; a worker that ticks posts its state four times a second. */
  let heardAt = clock.now();
  let silenceLogged = false;
  let recycles = 0;
  /** What the worker last said it was doing, and the slowest store open it has reported. */
  let phase: { instance: string; phase: string } | undefined;
  let slowestOpenMs = 0;

  /**
   * The silent-worker watchdog. A worker blocked in a call, or whose loop died without an exit,
   * posts nothing, and every view goes stale while its last state still reads "held". A worker
   * making progress is never silent: it posts a heartbeat per committed transaction and around
   * each store open. Silence for {@link READ_MODEL_STALL_MS} is ledgered with the phase it was
   * last in; silence for twice that, doubling with each recycle, terminates it (exit code 1) and
   * the exit handler respawns it. A store open, one sync quick_check, is given twice the slowest
   * open the worker has reported, since killing it only starts the same open again.
   */
  const watchWorker = (): void => {
    const running = worker;
    if (!running) return;
    const silentMs = clock.now() - heardAt;
    const last = phase ? { phase: phase.phase, instance: phase.instance } : {};
    if (silentMs >= READ_MODEL_STALL_MS && !silenceLogged) {
      silenceLogged = true;
      opts.log?.("read_model.worker_silent", { silentMs, recycles, ...last });
    }
    const boundMs = Math.max(2 * READ_MODEL_STALL_MS * 2 ** recycles, phase?.phase === "open" ? 2 * slowestOpenMs : 0);
    if (silentMs < boundMs) return;
    recycles++;
    opts.log?.("read_model.worker_recycled", { silentMs, recycles, boundMs, ...last });
    void running.terminate();
  };

  const bodyListeners = new Set<(entry: ReadModelBodyEntry) => void>();
  const onMessage = (msg: ReadModelWorkerMessage): void => {
    heardAt = clock.now();
    silenceLogged = false;
    if (msg.type === "progress") phase = { instance: msg.instance, phase: msg.phase };
    else if (msg.type !== "log") phase = undefined;
    if (msg.type === "body") {
      bodies.set(readModelBodyKey(msg.entry.view, msg.entry.key), msg.entry);
      posted.add(readModelBodyKey(msg.entry.view, msg.entry.key));
      for (const listener of bodyListeners) listener(msg.entry);
    } else if (msg.type === "log") opts.log?.(msg.step, msg.extra);
    else if (msg.type === "drop") bodies.delete(readModelBodyKey(msg.view, msg.key));
    else if (msg.type === "sources") {
      for (const source of msg.sources) sourceClocks.set(source.name, source);
    } else if (msg.type === "progress") {
      if (msg.phase === "opened") slowestOpenMs = Math.max(slowestOpenMs, msg.ms ?? 0);
    } else {
      at = msg.at;
      switches = msg.switches;
      deaths = 0;
      for (const state of msg.instances) instances.set(state.instance, state);
    }
    opts.observe?.(msg);
  };

  const spawn = (): void => {
    const shared = new SharedArrayBuffer(8);
    const data: ReadModelWorkerData = {
      kind: READ_MODEL_WORKER_KIND, stateDir: opts.stateDir, instances: [...opts.instances], tickMs: opts.tickMs ?? READ_MODEL_TICK_MS, signal: shared, ...(opts.registry ? { registry: opts.registry } : {}),
      ...(opts.escalationRepository ? { escalationRepository: opts.escalationRepository } : {}),
      ...(opts.slowLane ? { slowLane: opts.slowLane } : {}),
    };
    const spawned = new Worker(opts.workerUrl ?? new URL(import.meta.url), { workerData: data, execArgv: process.execArgv });
    signal = new Int32Array(shared);
    worker = spawned;
    heardAt = clock.now();
    phase = undefined;
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
      if (!source.name.startsWith(LEDGER_SOURCE_PREFIX)) return judgeSource(sourceClocks.get(source.name) ?? source, now);
      const instance = source.name.slice(LEDGER_SOURCE_PREFIX.length);
      const state = instances.get(instance);
      if (state?.tickedAt !== undefined) return ledgerSource(state, now);
      const committed = committedAt.get(instance);
      if (committed !== undefined && now - committed <= READ_MODEL_LEDGER_STALE_MS) {
        return describeSource({ name: source.name, asOf: source.asOf, state: "fresh", lagMs: Math.max(0, now - committed) });
      }
      return state ? ledgerSource(state, now) : { ...describeSource(source), state: "stale", phase: "warming", reason: "read model warming: this body was committed before serve started" };
    }),
    reload: () => {
      const again = loadCommittedViewBodies(opts.stateDir, home);
      committedAt = committedTickTimes(opts.stateDir, opts.instances);
      let replaced = 0;
      for (const entry of again.bodies) {
        const key = readModelBodyKey(entry.view, entry.key);
        if (posted.has(key) || bodies.get(key)?.etag === entry.etag) continue;
        bodies.set(key, entry);
        replaced++;
      }
      opts.log?.("read_model.reloaded", { bodies: again.bodies.length, replaced, ...(again.reason ? { reason: again.reason } : {}) });
      return replaced;
    },
    switches: () => mainSwitches,
    shadow: (request) => worker?.postMessage({ type: "shadow", ...request }),
    driveShadow: (sample) => void (driven = sample),
    onBody: (listener) => {
      bodyListeners.add(listener);
      return () => bodyListeners.delete(listener);
    },
    start: () => {
      if (worker || stopping) return;
      spawn();
      stopSwitchWatch = (opts.every ?? everyUnref)(() => {
        refreshSwitches();
        watchWorker();
        for (const entry of bodies.values()) if (mainSwitches.views[entry.view] === "shadow") driven?.(entry.view, entry.key, new URLSearchParams(entry.key), true);
      }, READ_MODEL_SWITCH_RECHECK_MS);
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
