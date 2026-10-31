/**
 * The board projection inside the read model (Phase 1 design §3.5, §4.2; P1-10).
 *
 * It runs the board's own `projectPlan` over the fact store's full history, never a SQL port of it
 * (design D4). A task is re-derived only when something it depends on moved, and its projection is
 * persisted in `task_projection` with the stamp it was derived under, so reuse survives a restart.
 *
 * WHAT MOVES A TASK (the dirty-set rules, each one closing a gap the legacy memo in board.ts has):
 * - a fact row naming it in `task_id` OR `task` (the legacy stamp keys on `task_id ?? task` only,
 *   while `buildLedgerIndex` files the row under both);
 * - a cross-task row (`daemon.boot`, a `plan_only` `pr.opened`): each task whose reads of it (`environmentChangedSince`,
 *   `isPlanOnlyFilingPr`) it moves, as recorded and persisted (W1-T9719, {@link recordingCrossReads}); no record: all.
 * - its plan entry, its durable credit record, the credit overrides, the code;
 * - what it read from GitHub (W1-T6016): when the snapshot moves, each task's own GitHub reads are replayed against
 *   the new gateway, and only a task whose answers moved re-derives (see {@link githubDigest});
 * - the clock: every {@link BOARD_CLOCK_REDERIVE_MS}, a projection that ages with the clock or holds
 *   an independent-failure block (the 6 h environmental cooldown);
 * - the ledger's own clock: `orphanedRunIds` measures a lone `run.start` against the NEWEST row
 *   anywhere, so a task whose start is inside the liveness bound moves when any row lands.
 *
 * A no-reuse derive every {@link BOARD_ORACLE_INTERVAL_MS} diffs against the reused board, heals
 * what differs, and reports it: the rules above are measured, not assumed.
 *
 * WHAT IT HOLDS (W1-T9436): a re-derived task reads its own rows from the fact store, task by task, and they are
 * released with the update (`storeIndex`). The rows it keeps in memory are only those {@link BOARD_ROW_RETENTION}
 * holds for the now view's readers outside the derive: per key, never per row ever ingested (board:core held 663,486
 * entries on 2026-10-14). `keepEveryRow` keeps the old behaviour as an equality test's reference arm.
 *
 * WHAT IT DOES NOT RE-READ (W1-T9604): the whole-ledger step buckets and plan-only sets an index answers. Each is read
 * in full once and then extended from the rows the ingest reads anyway, so a build reads no step body it read before.
 * A row of a cached step deleted under it (an index-only count) or a store behind it drops the cache, and the oracle
 * audits it against a full read every pass; its `read_model.board_oracle` row carries what it read and reused.
 * W1-T9718: a pass audits one slice of {@link BOARD_ORACLE_SLICES} in turn ({@link boardOracleSliceOf}), every task healed
 * within {@link BOARD_ORACLE_RECURRENCE_MS}, and every non-plan projection; the rest are held. Both persist with the lease.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { projectionAgesWithTheClock } from "./board.js";
import { systemClock, type Clock } from "./clock.js";
import { tryEscalate, type EscalateDeps, type Escalation } from "./escalate.js";
import { PLAN_ONLY_REVIEW_MARKER_STEP } from "./ledger-carry.js";
import { factAliasReady, runWorkerRow } from "./ledger-projector.js";
import type { Plan, Task } from "./plan.js";
import { withWriteTransaction, type ReadModelDb, type ReadModelLease, type ReadModelStatement } from "./read-model-db.js";
import {
  buildLedgerIndex,
  DEFAULT_LIVENESS_BOUND_MS,
  defaultCreditOverridePath,
  defaultCreditStorePath,
  loadCreditStore,
  noteLedgerGeneration,
  openSiblingBuild,
  projectPlan,
  type CreditStore,
  type DeriveDeps,
  type GitHub,
  type LedgerIndex,
  type PrRef,
  type StatusProjection,
  taskIdFromRunBranch,
  WORKER_ACTIVITY_STAND_IN_STEP,
} from "./status.js";
import { utcDayWindowMs, utcWeekWindowMs } from "./time-window.js";

/** Bumped when this module's stamp or stored shape changes: every persisted projection then re-derives. */
export const BOARD_PROJECTION_VERSION = 3;
export const BOARD_CLOCK_REDERIVE_MS = 30_000;
export const BOARD_ORACLE_INTERVAL_MS = 10 * 60_000;
export const BOARD_DERIVE_DEBOUNCE_MS = 500;
/** W1-T6014: fact rows one `update` ingests at most. A cold store ingests across calls, each not deriving until the tail. */
export const BOARD_INGEST_CHUNK_ROWS = 5_000;
/** PRIMARY CONTROL (W1-T6467): the longest string value a projection's table shares; a longer one stays as parsed. */
export const BOARD_INTERN_MAX_CHARS = 96;
/** ...and the ms one `update`'s ingest runs for at most, so a slow disk ends a chunk early. */
export const BOARD_INGEST_CHUNK_MS = 250;
/** A drift found again this soon after a self-heal is a projection bug, not a blip: it escalates (as #8075's oracle). */
export const BOARD_ORACLE_RECURRENCE_MS = 24 * 60 * 60_000;
/** OPERATOR DECISION (W1-T9718), operator ruling 2026-10-17: six slices. At 10-minute passes every task is audited
 *  hourly, a recently healed one every pass; a pass reads ~1/N of a full re-derive (N=1 1,170 MB, N=6 290 MB offline). */
export const BOARD_ORACLE_SLICES = 6;
const ORACLE_SLICE_META = "board.oracle_slice";
/** Steps some task's derivation reads across the whole ledger, whatever task they name. */
export const BOARD_CROSS_TASK_STEPS: ReadonlySet<string> = new Set(["daemon.boot"]);
/** Fact steps no reader on the projection path (status.ts, board.ts, status-board.ts) names: 60% of the
 *  core's fact rows. They are never parsed; the newest `ts` among them rides a sentinel row, because
 *  `orphanedRunIds` reads the ledger's newest `ts` from every row. */
export const BOARD_UNREAD_STEPS: ReadonlySet<string> = new Set(["sweep.pass", "sweep.summary", "incident.event", "main.health.observed"]);
/** W1-T9357: blob fields no reader of a projection row reads (a read census of the now view over 836,723 rows found
 *  none): 36% of a core projection's kept field bytes. A row is kept without them for the life of the thread. */
export const BOARD_ROW_UNREAD_FIELDS: ReadonlySet<string> = new Set([
  "question", "benchmark_run", "stand_down_reason", "worker_assignment", "decision_verdict", "stderr_excerpt",
  "review_input_digest", "proof_exec", "changed_paths", "evaluator_provenance", "reviewer_code_provenance",
]);
const LATEST_TS_META = "board.latest_ts_ms";
/** The step of the one row per run that stands for its newest non-fact row (`run_activity`), so its liveness reads as legacy's. */
export const BOARD_RUN_ACTIVITY_STEP = "read_model.run_activity";
export const BOARD_PROJECTION_DDL = `CREATE TABLE IF NOT EXISTS task_projection(task_id TEXT PRIMARY KEY,
  stamp TEXT NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS board_oracle_run(at_ms INTEGER NOT NULL, outcome TEXT NOT NULL, mismatches INTEGER NOT NULL,
  healed INTEGER NOT NULL, issue_url TEXT);
  CREATE TABLE IF NOT EXISTS task_github_read(task_id TEXT PRIMARY KEY, digest TEXT NOT NULL, keys TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS task_cross_read(task_id TEXT PRIMARY KEY, keys TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS board_oracle_heal(task_id TEXT PRIMARY KEY, at_ms INTEGER NOT NULL) WITHOUT ROWID;`;

/** W1-T9604: what the step cache read and reused since the last `read_model.board_oracle` row, which carries it. */
export interface BoardStepReads {
  /** Indexes built over the store, each asking its steps and plan-only sets on demand. */
  indexes: number;
  /** Step buckets and plan-only sets read in full from the fact store: the reads, their rows and body bytes. */
  fullReads: number;
  fullRows: number;
  fullBytes: number;
  /** Rows the ingest had already read that extended a cached bucket or set: no store read of their own. */
  extendedRows: number;
  extendedBytes: number;
  /** Rows an index was handed from the cache without a store read, and their body bytes. */
  reusedRows: number;
  reusedBytes: number;
  /** Times the cache was dropped: a cached step's row deleted under it, a store behind it, the oracle's audit. */
  resets: { deleted: number; behind: number; audit: number };
  /** What the cache holds: steps; bucket rows and body bytes plus plan-only set entries and their string lengths. */
  held: { steps: number; rows: number; bytes: number };
}

export type Row = Record<string, unknown>;

/** Each dirty-set rule, switchable only so a measurement or a test can show what it closes. */
export interface BoardDirtRules {
  alias: boolean;
  crossTask: boolean;
  clock: boolean;
  ledgerClock: boolean;
  /** W1-T6016: a task re-derives when what it read from GitHub moved. */
  github: boolean;
}
const ALL_RULES: BoardDirtRules = { alias: true, crossTask: true, clock: true, ledgerClock: true, github: true };

export type BoardDirt = { all: true; reason: string } | { all: false; tasks: string[] };

/** Which tasks one fact row can move. */
export function boardDirtForRow(row: Row, rules: Pick<BoardDirtRules, "alias" | "crossTask"> = ALL_RULES): BoardDirt {
  if (rules.crossTask && typeof row.step === "string" && BOARD_CROSS_TASK_STEPS.has(row.step)) return { all: true, reason: row.step };
  if (rules.crossTask && row.step === "pr.opened" && row.plan_only === true) return { all: true, reason: "pr.opened plan_only" };
  const named = [row.task_id, row.task].filter((id): id is string => typeof id === "string" && id.length > 0);
  if (!rules.alias) return { all: false, tasks: named.slice(0, 1) };
  return { all: false, tasks: [...new Set(named)] };
}

/** The JSON a comparison sees: key-sorted, `undefined` dropped, and the clock-read `elapsedMs` removed. */
export function canonicalProjection(p: StatusProjection | undefined): string {
  if (p === undefined) return "absent";
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (key !== "elapsedMs") out[key] = sort((value as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(sort(p));
}

function differingFields(a: StatusProjection | undefined, b: StatusProjection | undefined): string[] {
  const left = (a ?? {}) as Record<string, unknown>;
  const right = (b ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((k) => k !== "elapsedMs");
  return keys.filter((k) => JSON.stringify(left[k]) !== JSON.stringify(right[k])).sort();
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** W1-T9718: the oracle slice of `of` that `taskId` belongs to, fixed by the id alone, so a rotation covers every task. */
export function boardOracleSliceOf(taskId: string, of: number): number {
  return of <= 1 ? 0 : Number.parseInt(sha1(taskId).slice(0, 8), 16) % of;
}

/** The default GitHub generation: the open PRs' identity and heads, and whether the read failed. */
export function githubGenerationOf(github: GitHub): string {
  const open = github.listOpenHeadBranches?.();
  const rows = open === undefined ? "none" : open === null ? "failed" : open.map((pr) => `${pr.number}:${pr.state}:${pr.headRefOid ?? ""}`).sort();
  return sha1(JSON.stringify([rows, github.readFailed?.() ?? false]));
}

/**
 * W1-T6016: WHICH GITHUB FACTS A TASK'S PROJECTION READ. The generation above only says the snapshot moved; folded
 * into every task's stamp it re-derived all of them (~4,085 on core, 17 s median a board stage on 2026-10-15) when
 * one PR's head moved. A task's GitHub dependency is instead, per task:
 * - every gateway call its derive made, with its arguments and its answer (a recording gateway, {@link
 *   recordingGithub}), replayed against the new gateway: `prByRef` of a ledger-named PR, `headRefName`/`prBody`/
 *   `changedFiles` of its trailer PR, `issueByUrl` of its escalation, and the batched trailer lookup;
 * - its slices of the open and merged lists `projectPlan` groups once per pass and hands each task through a
 *   closure no gateway call sees: open PRs its run branch owns or whose body names it (a superset of the trailer
 *   grouping), merged PRs its run branch owns;
 * - for a task the open-sibling observation runs on (declared files, neither merged nor open), that observation
 *   recomputed over the new open list;
 * - the facts no task owns, global: whether each list and the trailer lookup read at all, and the read failure.
 */
export interface GithubReadLog {
  keys: string[];
  answers: string[];
}

/** Gateway methods a replay never calls: they act (warm, seed, reset) or read the wall clock. A task that read one
 *  is re-derived whenever the snapshot moves. */
const GITHUB_UNREPLAYED: ReadonlySet<string> = new Set(["warm", "serveOffLoop", "seedBoardSnapshot", "resetFailureFlags", "factsAgeMs", "factsStale", "warmTelemetry"]);
/** The key a call of the function `mergedTrailerLookup()` returned is recorded under. */
const TRAILER_LOOKUP = "mergedTrailerLookup()";
const UNDEFINED_ARG = "\u0000undefined";
/** Every task-id-shaped token: the open slice's superset of `projectPlan`'s trailer grouping (TASK_ID_TRAILER_RE). */
export const TASK_TOKEN_RE = /W[0-9]+-T[0-9]+[A-Za-z]?/;

function readKey(method: string, args: readonly unknown[]): string {
  return `${method}\u0000${JSON.stringify(args, (_key, value: unknown) => (value === undefined ? UNDEFINED_ARG : value))}`;
}

function parseReadKey(key: string): { method: string; args: unknown[] } {
  const at = key.indexOf("\u0000");
  const args = JSON.parse(key.slice(at + 1), (_key, value: unknown) => (value === UNDEFINED_ARG ? undefined : value)) as unknown[];
  return { method: key.slice(0, at), args: Array.from(args) };
}

/** One answer as a comparable string; never throws. */
export function githubAnswerOf(value: unknown): string {
  if (value === undefined) return "u";
  if (typeof value === "function") return "f";
  try {
    return `j${JSON.stringify(value)}`;
  } catch (error) {
    // A value JSON cannot hold (a cycle, a BigInt) is not comparable: a unique answer equals no other, even its own
    // replay, so the task re-derives on every snapshot move rather than being reused on a guess.
    void error;
    return `x${randomUUID()}`;
  }
}

const thrownAnswer = (error: unknown): string => `t${error instanceof Error ? error.message : String(error)}`;

/** `github` with every method call recorded into the log `into` names (none: not recorded), answers unchanged. */
export function recordingGithub(github: GitHub, into: () => GithubReadLog | undefined): GitHub {
  const call = (method: string, fn: (...a: unknown[]) => unknown, self: unknown, args: unknown[]): unknown => {
    const log = into();
    if (!log) return Reflect.apply(fn, self, args);
    let result: unknown;
    try {
      result = Reflect.apply(fn, self, args);
    } catch (error) {
      log.keys.push(readKey(method, args));
      log.answers.push(thrownAnswer(error));
      throw error;
    }
    log.keys.push(readKey(method, args));
    log.answers.push(githubAnswerOf(result));
    return result;
  };
  const wrapped = new WeakMap<object, unknown>();
  return new Proxy(github, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      let wrapper = wrapped.get(value);
      if (wrapper === undefined) {
        wrapper = (...args: unknown[]): unknown => {
          const result = call(prop, value as (...a: unknown[]) => unknown, target, args);
          if (prop !== "mergedTrailerLookup" || typeof result !== "function") return result;
          const lookup = result as (taskId: string) => PrRef | null;
          return (taskId: string) => call(TRAILER_LOOKUP, lookup as (...a: unknown[]) => unknown, undefined, [taskId]);
        };
        wrapped.set(value, wrapper);
      }
      return wrapper;
    },
  });
}

/** One gateway's answers, computed once per snapshot and shared by every task's replay. */
export interface GithubView {
  readonly gateway: GitHub;
  readonly generation: string;
  readonly global: string;
  /** The open list `projectPlan` hands the open-sibling observation; undefined when absent or unread. */
  readonly openRows: PrRef[] | undefined;
  slice(half: "open" | "merged", taskId: string): string;
  answer(key: string): string;
}

export function githubViewOf(gateway: GitHub, generation: string): GithubView {
  // In `projectPlan`'s order: the merged list, its trailer lookup (only over a list that read), the open list.
  const merged = gateway.listMergedHeadBranches?.();
  const trailer = merged === undefined || merged === null ? undefined : gateway.mergedTrailerLookup?.();
  const open = gateway.listOpenHeadBranches?.();
  const state = (v: unknown): string => (v === undefined ? "absent" : v === null ? "failed" : "read");
  const global = JSON.stringify([state(merged), state(trailer), state(open), gateway.readFailed?.() ?? null, gateway.readFailureReason?.() ?? null]);
  const groups = { open: new Map<string, PrRef[]>(), merged: new Map<string, PrRef[]>() };
  const file = (half: "open" | "merged", owner: string, pr: PrRef): void => {
    const list = groups[half].get(owner);
    if (list) list.push(pr);
    else groups[half].set(owner, [pr]);
  };
  for (const pr of open ?? []) {
    const owners = new Set([taskIdFromRunBranch(pr.headRefName), ...((pr.body ?? "").match(new RegExp(TASK_TOKEN_RE.source, "g")) ?? [])]);
    for (const owner of owners) if (owner !== undefined) file("open", owner, pr);
  }
  for (const pr of merged ?? []) {
    const owner = taskIdFromRunBranch(pr.headRefName);
    if (owner !== undefined) file("merged", owner, pr);
  }
  const slices = new Map<string, string>();
  const answers = new Map<string, string>();
  let unreplayed = 0;
  const replay = (key: string): string => {
    const { method, args } = parseReadKey(key);
    if (GITHUB_UNREPLAYED.has(method)) return `n${++unreplayed}`;
    const fn = method === TRAILER_LOOKUP ? (typeof trailer === "function" ? trailer : undefined) : (gateway as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") return "a";
    try {
      return githubAnswerOf(Reflect.apply(fn as (...a: unknown[]) => unknown, method === TRAILER_LOOKUP ? undefined : gateway, args));
    } catch (error) {
      // Not erased: a throw is an answer of its own, distinct from every return, as the recording keeps it.
      return thrownAnswer(error);
    }
  };
  return {
    gateway, generation, global, openRows: open ?? undefined,
    slice(half, taskId) {
      const key = `${half}\u0000${taskId}`;
      let hit = slices.get(key);
      if (hit === undefined) slices.set(key, (hit = sha1((groups[half].get(taskId) ?? []).map(githubAnswerOf).join("\n"))));
      return hit;
    },
    answer(key) {
      let hit = answers.get(key);
      if (hit === undefined) {
        hit = replay(key);
        if (!hit.startsWith("n")) answers.set(key, hit);
      }
      return hit;
    },
  };
}

/** The open-sibling observation `projectPlan` attaches to `projection`'s task, recomputed over `view`; "-" when it
 *  does not run for this projection. */
function siblingAnswer(view: GithubView, task: Task | undefined, projection: StatusProjection): string {
  const files = task === undefined ? [] : task.files ?? [];
  if (task === undefined || files.length === 0 || projection.merged || projection.prState === "OPEN") return "-";
  const gateway = view.gateway;
  return githubAnswerOf(openSiblingBuild(task.id, files, view.openRows, gateway.changedFiles?.bind(gateway)) ?? null);
}

/** What `task`'s projection read from GitHub under `view`, as one digest: equal digests, equal GitHub inputs. */
export function githubDigest(view: GithubView, taskId: string, task: Task | undefined, projection: StatusProjection, answers: readonly string[]): string {
  return sha1(JSON.stringify([view.global, view.slice("open", taskId), view.slice("merged", taskId), siblingAnswer(view, task, projection), answers]));
}

/** W1-T9719: a read's key: a cross-task step's rows, one PR asked of the filing set, or the whole set (every filing). */
const CROSS_STEP = "step:";
const CROSS_FILING = "filing:";
const CROSS_FILING_ANY = "filing:*";

/** W1-T9719: `index`, recording into `into()` each ask of a {@link BOARD_CROSS_TASK_STEPS} step and of the plan-only
 *  filing set; its answers and `rows` are the index's own, so `projectPlan` takes it as its ledger's index. */
function recordingCrossReads(index: LedgerIndex, into: () => Set<string> | undefined): LedgerIndex {
  let filing: ReadonlySet<string> | undefined;
  return {
    rows: index.rows,
    byTask: index.byTask,
    byStep: {
      get: (step) => {
        if (BOARD_CROSS_TASK_STEPS.has(step)) into()?.add(`${CROSS_STEP}${step}`);
        return index.byStep.get(step);
      },
    },
    get planOnlyFilingPrUrls() {
      filing ??= new Proxy(index.planOnlyFilingPrUrls, {
        get(target, prop) {
          if (prop === "has") return (url: string): boolean => (into()?.add(`${CROSS_FILING}${url}`), target.has(url));
          into()?.add(CROSS_FILING_ANY);
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return filing;
    },
    get planOnlyReviewedHeads() {
      return index.planOnlyReviewedHeads;
    },
    latestTsMs: index.latestTsMs,
  };
}

export interface BoardProjectionOptions {
  db: ReadModelDb;
  /** Persistence needs the writer lease; without one the projection lives in memory only. */
  lease?: ReadModelLease;
  /** The instance's live ledger path: `projectPlan` resolves the credit store and overrides beside it. */
  ledgerPath: string;
  /** The reloaded plan snapshot (W1-T4481); a new object is diffed task by task. */
  readPlan: () => Plan;
  github: GitHub;
  /** The gateway each derive reads when the caller swaps a re-read snapshot in; `github` otherwise. */
  currentGithub?: () => GitHub;
  githubGeneration?: () => string;
  /** Read-only: the worker never writes the legacy credit store. */
  readCreditStore?: () => CreditStore;
  readCreditOverrideFile?: () => string;
  /** The serve checkout's head: a deploy re-derives every persisted projection. */
  codeVersion?: string;
  clock?: Clock;
  /** Further `projectPlan` inputs, such as `inflightHolder`. */
  deriveDeps?: Partial<DeriveDeps>;
  rules?: Partial<BoardDirtRules>;
  log?: (step: string, extra: Record<string, unknown>) => void;
  /** Names the escalation's task (`READ-MODEL-<INSTANCE>`, as the consistency oracle's). Omitted ⇒ `core`. */
  instance?: string;
  /** The oracle's last tier; without it a drift is healed and logged but never escalated. */
  escalation?: EscalateDeps;
  /** Fact rows one `update` ingests at most; {@link BOARD_INGEST_CHUNK_ROWS} when omitted. */
  ingestChunkRows?: number;
  /** The ms one `update`'s ingest runs for at most; {@link BOARD_INGEST_CHUNK_MS} when omitted. */
  ingestChunkMs?: number;
  /** False: rows keep their parsed strings (the arm an equality check compares the shared one against). */
  internStrings?: boolean;
  /** W1-T9436: true keeps every row, as before the retention rules (the arm an equality check compares against). */
  keepEveryRow?: boolean;
  /** W1-T9436, with `keepEveryRow` only: derive from the rows held in memory, never from the fact store (today's derive). */
  deriveFromRows?: boolean;
  /** Each ingest's fresh fact rows, in the order read: a feed that takes each row once (the now view's recent feed). */
  onIngest?: (rows: ReadonlyArray<Row>) => void;
  /** W1-T9718: the slices one oracle rotation audits in turn; {@link BOARD_ORACLE_SLICES} when omitted. */
  oracleSlices?: number;
}

/**
 * W1-T6467: replaces each TOP-LEVEL primitive string value of a freshly parsed row, at most
 * {@link BOARD_INTERN_MAX_CHARS} long, with the equal string `table` already holds (the first one seen), so a
 * projection keeps one copy of each repeated step name, task id or url instead of one per row. A value is only
 * ever replaced by one equal to it; objects, arrays, numbers, booleans, null and longer strings are left as
 * parsed, no object is shared, and key order does not change (an existing key is reassigned in place).
 */
/** `row` without {@link BOARD_ROW_UNREAD_FIELDS}, other keys in order; `row` itself when it holds none. A fresh
 *  object, never `delete`: deleting leaves the row in dictionary mode, which kept MORE (525 MB vs 504 MB). */
export function withoutUnreadFields(row: Row): Row {
  const keys = Object.keys(row);
  if (!keys.some((key) => BOARD_ROW_UNREAD_FIELDS.has(key))) return row;
  const kept: Row = {};
  for (const key of keys) if (!BOARD_ROW_UNREAD_FIELDS.has(key)) kept[key] = row[key];
  return kept;
}

export function internRowStrings(row: Row, table: Map<string, string>): Row {
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (typeof value !== "string" || value.length > BOARD_INTERN_MAX_CHARS) continue;
    const held = table.get(value);
    if (held === undefined) table.set(value, value);
    else row[key] = held;
  }
  return row;
}

/** `agree`; `transient` (gone on the recheck); `healed`; `escalated` (survived the heal, or recurred within 24 h). */
export type BoardOracleOutcome = "agree" | "transient" | "healed" | "escalated";

export interface BoardOracleResult {
  compared: number;
  mismatches: Array<{ taskId: string; fields: string[] }>;
  outcome: BoardOracleOutcome;
  escalationReasons: string[];
  /** The issue URL, null when nothing escalated, the escalation failed, or no path was supplied. */
  issueUrl: string | null;
  /** W1-T9718: which plan tasks this pass audited, sorted: its slice's, and those healed within the recurrence window. */
  slice: { index: number; of: number; audited: string[]; alwaysAudited: string[] };
}

export interface BoardUpdate {
  /** False when nothing moved, the debounce deferred the derive, or the ingest has not reached the store's tail. */
  derived: boolean;
  /** False while a cold ingest is between chunks: call `update` again to resume it. */
  caughtUp: boolean;
  deferred: boolean;
  newRows: number;
  /** Plan tasks re-derived this update, sorted; every other plan task was reused. */
  rederived: string[];
  reused: number;
  full: boolean;
  elapsedMs: number;
  oracle?: BoardOracleResult;
  crossTask?: BoardCrossTask;
}

/** W1-T9719: cross-task rows since the last derive, and the plan tasks they moved and left reused. */
export interface BoardCrossTask {
  rows: number;
  rederived: number;
  reused: number;
}

export interface BoardProjection {
  /** `readerNowMs`: the "now" the build's readers will use, so a windowed rule keeps their day and week (W1-T9436). */
  update(opts?: { force?: boolean; readerNowMs?: number }): BoardUpdate;
  projections(): ReadonlyMap<string, StatusProjection>;
  /** The credit store and override text the last update read: a second derivation replays them. */
  creditRead(): { credit: CreditStore; overrides: string };
  /** W1-T9436: the rows a retention rule holds (every row, with `keepEveryRow`), in ledger order. */
  rows(): ReadonlyArray<Row>;
  /** W1-T9436: a ledger index over `bound` whose task and step buckets the fact store answers on demand, for the
   *  readers that look rows up by task or step; drop it after the build that asked for it. */
  index(bound: ReadonlyArray<Row>): LedgerIndex;
  /** Distinct string values this projection's own table holds (W1-T6467); 0 before any ingest. */
  internedStrings(): number;
  /**
   * W1-T9403: what it keeps, counted as it ingests: the rows it holds (its sentinel aside), and the summed
   * length of each kept row's source text (a fact row's ledger body; a stand-in's source columns).
   */
  size(): { rows: number; keptBytes: number };
  /** Derives with no reuse, diffs it against the held board, and heals every mismatch. */
  oracle(): BoardOracleResult;
}

interface Held {
  stamp: string;
  projection: StatusProjection;
}

function readTextOr(path: string, fallback: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    // deliberate: an absent override record means "no overrides", exactly as loadCreditOverrides reads it.
    void error;
    return fallback;
  }
}

/** A row's place in `rows`: by its time, then by when it was offered (W1-T9436). Array order is exactly this order. */
type Ord = readonly [tsMs: number, ins: number];
const ordCompare = (a: Ord, b: Ord): number => a[0] - b[0] || a[1] - b[1];

/** What a retention rule may ask of a row beyond its fields. */
export interface BoardRowFacts {
  /** A run's stand-in (`run_activity` or `run_worker`), not a fact row. */
  readonly standIn: boolean;
  /** A `sweep.disposed` row re-emitting the disposition its PR's previous one recorded (the now view's `sweepRepeat`). */
  readonly repeat: boolean;
}

/** The reader windows a rule may key on: each is the reader's own definition of "today" or "this week", not a bound. */
export type BoardRetentionWindow = "utc-day" | "utc-day-text" | "iso-week";

/**
 * W1-T9436: one now-view reader's claim on board rows. `newest`/`first` hold one row per key (the last or first in
 * row order), `all` every row the key names, `run` a task's newest `run.start` and its rows after it, and `asof` the
 * row with the latest `ts` at or before the readers' now plus every row stamped after it (a reader asking "any row in
 * [from, now]"). A windowed rule keys per window and lets a window go once the readers' day or week has moved past it.
 */
export interface BoardRetentionRule {
  readonly reader: string;
  /** The steps whose rows the rule can hold; "*" for any step. */
  readonly steps: readonly string[] | "*";
  /** The fields the reader reads off a row this rule holds: the census's contract. */
  readonly fields: readonly string[];
  readonly kind: "newest" | "first" | "all" | "run" | "asof";
  readonly window?: BoardRetentionWindow;
  /** The key the rule holds `row` under; undefined when it does not hold it. */
  key(row: Row, facts: BoardRowFacts): string | undefined;
}

const HOLD_ENGAGED = "automerge.hold_engaged";
const HOLD_RELEASED = "automerge.hold_released";
const RUN_SPEND_STEPS: ReadonlySet<unknown> = new Set(["run.start", "verdict", "implement.done", "fix.done"]);
const taskKey = (row: Row): string | undefined => (typeof row.task_id === "string" ? row.task_id : undefined);
const prKey = (row: Row): string | undefined => (typeof row.pr_number === "number" ? String(row.pr_number) : undefined);
const runKey = (row: Row): string | undefined => (typeof row.run_id === "string" ? row.run_id : undefined);
const isHold = (row: Row): boolean => row.step === HOLD_ENGAGED || row.step === HOLD_RELEASED;
const isMerge = (row: Row): boolean => (row.step === "verdict" && row.verdict === "merged") || row.step === "verdict.merged";
/** The hold events `automergeHoldFromLedger` (review.ts) acts on: a confirmed human's engage with its actor and reason, or release. */
function actedHold(row: Row): boolean {
  if (row.authority !== "interactive-cli" && row.authority !== "console-confirmed") return false;
  if (row.step === HOLD_RELEASED) return true;
  return row.step === HOLD_ENGAGED && typeof row.by === "string" && typeof row.reason === "string" && row.by !== "" && row.reason !== "";
}

const windowRules = (window: BoardRetentionWindow, reader: string): BoardRetentionRule[] => [
  // A stand-in is the first row of its run's window when the run's fact rows all fall before it; the day is inside its
  // week, so the week's rule keeps the day's too.
  { reader: `${reader}: each run's first row in the window`, steps: "*", fields: ["run_id", "ts"], kind: "first", window, key: (row, f) => (f.standIn ? undefined : runKey(row)) },
  { reader: `${reader}: each run's first verdict in the window`, steps: ["verdict"], fields: ["run_id", "ts", "cost_usd", "task_id"], kind: "first", window, key: (row) => (row.step === "verdict" ? runKey(row) : undefined) },
  { reader: `${reader}: each run's first costed row in the window`, steps: "*", fields: ["run_id", "ts", "cost_usd", "task_id"], kind: "first", window, key: (row, f) => (!f.standIn && typeof row.cost_usd === "number" ? runKey(row) : undefined) },
  ...(window === "iso-week" ? [{
    reader: `${reader}: the stand-ins in the window`, steps: [BOARD_RUN_ACTIVITY_STEP, WORKER_ACTIVITY_STAND_IN_STEP], fields: ["run_id", "ts", "cost_usd", "task_id"], kind: "all" as const, window,
    key: (row: Row, f: BoardRowFacts) => (f.standIn && runKey(row) ? "stand-in" : undefined),
  }] : []),
];

/**
 * W1-T9436: the rows the now view walks outside the derive, per reader (the census in the task's rationale (b)).
 * Ingest keeps a row while some rule holds it and drops it once every rule that held it is superseded, so `rows()`
 * holds what these readers read and nothing else. A reader of a step no rule names fails the census test.
 */
export const BOARD_ROW_RETENTION: readonly BoardRetentionRule[] = [
  { reader: "lastActivityByTask (board.ts): each task's newest row", steps: "*", fields: ["task_id", "ts"], kind: "newest", key: (row) => taskKey(row) },
  { reader: "changedActivityByTask (now-view.ts): each task's newest row, sweep repeats excluded", steps: "*", fields: ["task_id", "ts"], kind: "newest", key: (row, f) => (f.repeat ? undefined : taskKey(row)) },
  { reader: "rawBlockedPrCandidates (status-board.ts): each PR's newest disposition", steps: ["sweep.disposed"], fields: ["pr_number", "disposition", "task_id", "reason", "pr_url", "ts"], kind: "newest", key: (row) => (row.step === "sweep.disposed" ? prKey(row) : undefined) },
  { reader: "nowActions (now-view.ts): each PR's newest disposition change", steps: ["sweep.disposed"], fields: ["pr_number", "disposition", "ts"], kind: "newest", key: (row, f) => (row.step === "sweep.disposed" && !f.repeat ? prKey(row) : undefined) },
  {
    reader: "derivePrQueue (board.ts): each PR head's newest disposition", steps: ["sweep.disposed"], fields: ["pr_number", "head_sha", "disposition", "reason", "task_id", "ts"], kind: "newest",
    key: (row) => (row.step === "sweep.disposed" && typeof row.pr_number === "number" && typeof row.head_sha === "string" ? `${row.pr_number}\u0000${row.head_sha}` : undefined),
  },
  { reader: "automergeHoldFromLedger (review.ts): each PR's and the fleet's last acted hold event", steps: [HOLD_ENGAGED, HOLD_RELEASED], fields: ["pr_number", "authority", "by", "reason", "hold_actor"], kind: "newest", key: (row) => (actedHold(row) ? (prKey(row) ?? "fleet") : undefined) },
  { reader: "deriveMergeHeld (status-board.ts): every PR a hold row names", steps: [HOLD_ENGAGED, HOLD_RELEASED], fields: ["pr_number"], kind: "newest", key: (row) => (isHold(row) ? prKey(row) : undefined) },
  { reader: "latestHoldTaskId (status-board.ts): each scope's newest engage naming a task", steps: [HOLD_ENGAGED], fields: ["pr_number", "task_id"], kind: "newest", key: (row) => (row.step === HOLD_ENGAGED && typeof row.task_id === "string" && row.task_id !== "" ? (prKey(row) ?? "fleet") : undefined) },
  { reader: "nowActions (now-view.ts): each PR's newest engage", steps: [HOLD_ENGAGED], fields: ["pr_number", "ts"], kind: "newest", key: (row) => (row.step === HOLD_ENGAGED ? prKey(row) : undefined) },
  { reader: "liveRunSpendByTask (status-stream-publisher.ts): each task's current run", steps: [...RUN_SPEND_STEPS] as string[], fields: ["task_id", "cost_usd", "num_turns"], kind: "run", key: (row) => (RUN_SPEND_STEPS.has(row.step) ? taskKey(row) : undefined) },
  { reader: "escalationClasses (now-decisions.ts): each task's newest escalation", steps: ["escalation.issue_opened"], fields: ["task_id", "class", "ts"], kind: "newest", key: (row) => (row.step === "escalation.issue_opened" ? taskKey(row) : undefined) },
  { reader: "projectFeedbackGates (human-gate.ts): each feedback's triage claims up to and after the readers' now", steps: ["triage.start"], fields: ["feedback_id", "ts"], kind: "asof", key: (row) => (row.step === "triage.start" && typeof row.feedback_id === "string" ? row.feedback_id : undefined) },
  { reader: "mergedTodayCount (now-view.ts): the day's merges, by their ts text", steps: ["verdict", "verdict.merged"], fields: ["verdict", "ts", "task_id", "pr_url", "run_id"], kind: "all", window: "utc-day-text", key: (row) => (isMerge(row) ? "merge" : undefined) },
  { reader: "mergedTodayCount (now-view.ts): each run's newest PR url", steps: ["pr.opened"], fields: ["run_id", "pr_url"], kind: "newest", key: (row) => (row.step === "pr.opened" && typeof row.pr_url === "string" ? runKey(row) : undefined) },
  { reader: "computeGlanceSpend (glance.ts): the day's merged verdicts", steps: ["verdict"], fields: ["verdict", "ts"], kind: "all", window: "utc-day", key: (row) => (row.step === "verdict" && row.verdict === "merged" ? "merge" : undefined) },
  ...windowRules("utc-day", "windowCostRows (sweep.ts) for the day's spend"),
  ...windowRules("iso-week", "windowCostRows (sweep.ts) for the week's spend"),
];

/** Fields a reader tests on every row before it looks at the step: `nowActions` and `automergeHoldFromLedger` scope by
 *  `pr_number` first. A read of one names no step's payload, so the census does not count it. */
export const BOARD_ROW_PROBE_FIELDS: ReadonlySet<string> = new Set(["pr_number"]);

function windowStartOf(window: BoardRetentionWindow, row: Row): number | undefined {
  if (typeof row.ts !== "string") return undefined;
  if (window === "utc-day-text") {
    const ms = Date.parse(`${row.ts.slice(0, 10)}T00:00:00.000Z`);
    return Number.isFinite(ms) ? ms : undefined;
  }
  const ms = Date.parse(row.ts);
  if (!Number.isFinite(ms)) return undefined;
  return window === "iso-week" ? utcWeekWindowMs(ms)[0] : utcDayWindowMs(ms)[0];
}

const currentWindowStart = (window: BoardRetentionWindow, nowMs: number): number => (window === "iso-week" ? utcWeekWindowMs(nowMs)[0] : utcDayWindowMs(nowMs)[0]);

/** W1-T9436: each kept `sweep.disposed` row's repeat judgement, made in full row order at ingest. */
const SWEEP_REPEATS = new WeakMap<object, boolean>();

/** Whether a kept `sweep.disposed` row repeats its PR's previous disposition, judged over every row the board ingested;
 *  undefined for a row the board did not judge (a board keeping every row, or any other array). */
export function boardSweepRepeat(row: object): boolean | undefined {
  return SWEEP_REPEATS.get(row);
}

/** W1-T9604: one fact row of a cached step, with the keys `stepFacts` orders by and its body's length. */
interface StepRow {
  readonly row: Row;
  readonly tsMs: number;
  readonly seq: number;
  readonly bytes: number;
  /** The `step` column: a plan-only row is filed by it. */
  readonly step: string;
}

/** W1-T9604: a cached step's rows in `stepFacts` order, never mutated once built (a later extension builds a new one). */
interface StepBucket {
  readonly rows: readonly Row[];
  readonly tsMs: readonly number[];
  readonly seqs: readonly number[];
  readonly bytes: number;
}

/** W1-T9604: the two plan-only sets, as `storeIndex`'s full read builds them; never mutated once handed out. */
interface PlanOnlySets {
  readonly filing: Set<string>;
  readonly reviewed: Map<string, Set<string>>;
  readonly rows: number;
  readonly bytes: number;
}

const PLAN_ONLY_STEPS: ReadonlySet<string> = new Set(["pr.opened", "review.posted", PLAN_ONLY_REVIEW_MARKER_STEP]);

/** W1-T9604: a set of fact rows as count, seq sum and ts_ms sum (each ts_ms reduced, so a sum stays an exact double). */
interface StepDigest {
  readonly n: number;
  readonly s: number;
  readonly t: number;
}
const DIGEST_MOD = 1_000_003;
const digestWith = (d: StepDigest, seq: number, tsMs: number): StepDigest => ({ n: d.n + 1, s: d.s + seq, t: d.t + (tsMs % DIGEST_MOD) });
const sameDigest = (a: StepDigest, b: StepDigest): boolean => a.n === b.n && a.s === b.s && a.t === b.t;

/** The digest of a cached bucket and the rows queued to extend it: the rows the store holds for it up to `lastSeq`. */
function bucketDigest(bucket: StepBucket, more: readonly StepRow[] = []): StepDigest {
  let [n, s, t] = [bucket.seqs.length + more.length, 0, 0];
  for (let at = 0; at < bucket.seqs.length; at++) [s, t] = [s + bucket.seqs[at]!, t + (bucket.tsMs[at]! % DIGEST_MOD)];
  for (const m of more) [s, t] = [s + m.seq, t + (m.tsMs % DIGEST_MOD)];
  return { n, s, t };
}

function noStepReads(): BoardStepReads {
  return {
    indexes: 0, fullReads: 0, fullRows: 0, fullBytes: 0, extendedRows: 0, extendedBytes: 0, reusedRows: 0, reusedBytes: 0,
    resets: { deleted: 0, behind: 0, audit: 0 }, held: { steps: 0, rows: 0, bytes: 0 },
  };
}

/** A NEW bucket: `bucket` with `more` merged in by (ts_ms, seq), never appended, as a late row can sort before held ones. */
function extendBucket(bucket: StepBucket, more: StepRow[]): StepBucket {
  const after = (a: { tsMs: number; seq: number }, tsMs: number, seq: number): boolean => a.tsMs > tsMs || (a.tsMs === tsMs && a.seq > seq);
  more.sort((a, b) => a.tsMs - b.tsMs || a.seq - b.seq);
  const rows: Row[] = [];
  const tsMs: number[] = [];
  const seqs: number[] = [];
  let at = 0;
  for (let i = 0; i < bucket.rows.length; i++) {
    while (at < more.length && !after(more[at]!, bucket.tsMs[i]!, bucket.seqs[i]!)) {
      const m = more[at++]!;
      rows.push(m.row);
      tsMs.push(m.tsMs);
      seqs.push(m.seq);
    }
    rows.push(bucket.rows[i]!);
    tsMs.push(bucket.tsMs[i]!);
    seqs.push(bucket.seqs[i]!);
  }
  for (; at < more.length; at++) {
    rows.push(more[at]!.row);
    tsMs.push(more[at]!.tsMs);
    seqs.push(more[at]!.seq);
  }
  return { rows, tsMs, seqs, bytes: more.reduce((sum, m) => sum + m.bytes, bucket.bytes) };
}

/** `sets` with the plan-only rows of `more` added: new sets, so an index holding the old ones keeps them as they were. */
function extendPlanOnly(sets: PlanOnlySets, more: readonly StepRow[]): PlanOnlySets {
  const filing = new Set(sets.filing);
  const reviewed = new Map(sets.reviewed);
  const copied = new Set<string>();
  let bytes = sets.bytes;
  for (const m of more) {
    bytes += m.bytes;
    const url = m.row.pr_url;
    if (typeof url !== "string") continue;
    if (m.step === "pr.opened") filing.add(url);
    else if (typeof m.row.head_sha === "string") {
      const held = reviewed.get(url);
      if (held && !copied.has(url)) reviewed.set(url, new Set(held).add(m.row.head_sha));
      else if (held) held.add(m.row.head_sha);
      else reviewed.set(url, new Set([m.row.head_sha]));
      copied.add(url);
    }
  }
  return { filing, reviewed, rows: sets.rows + more.length, bytes };
}

export function createBoardProjection(opts: BoardProjectionOptions): BoardProjection {
  const { db, lease } = opts;
  const clock = opts.clock ?? systemClock;
  const rules: BoardDirtRules = { ...ALL_RULES, ...opts.rules };
  const log = opts.log ?? (() => {});
  const readCredit = opts.readCreditStore ?? (() => loadCreditStore(defaultCreditStorePath(opts.ledgerPath)));
  const readOverrides = opts.readCreditOverrideFile ?? (() => readTextOr(defaultCreditOverridePath(opts.ledgerPath), ""));
  const gateway = (): GitHub => opts.currentGithub?.() ?? opts.github;
  const githubGeneration = opts.githubGeneration ?? (() => githubGenerationOf(gateway()));
  const chunkRows = opts.ingestChunkRows ?? BOARD_INGEST_CHUNK_ROWS;
  const chunkMs = opts.ingestChunkMs ?? BOARD_INGEST_CHUNK_MS;
  const keepAll = opts.keepEveryRow === true;
  const fromRows = keepAll && opts.deriveFromRows === true;
  // W1-T6467: this projection's own table, dropped with it; each views worker isolate builds its own.
  const strings = opts.internStrings === false ? undefined : new Map<string, string>();
  db.exec(BOARD_PROJECTION_DDL);
  const unread = [...BOARD_UNREAD_STEPS];
  const unreadSql = unread.map(() => "?").join(", ");
  const sql = {
    facts: db.prepare("SELECT seq, ts, ts_ms, step, body FROM fact WHERE seq > ? ORDER BY seq LIMIT ?"),
    upsert: db.prepare(`INSERT INTO task_projection(task_id, stamp, json) VALUES(?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET stamp = excluded.stamp, json = excluded.json`),
    remove: db.prepare("DELETE FROM task_projection WHERE task_id = ?"),
    upsertReads: db.prepare(`INSERT INTO task_github_read(task_id, digest, keys) VALUES(?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET digest = excluded.digest, keys = excluded.keys`),
    removeReads: db.prepare("DELETE FROM task_github_read WHERE task_id = ?"),
    upsertCross: db.prepare(`INSERT INTO task_cross_read(task_id, keys) VALUES(?, ?)
      ON CONFLICT(task_id) DO UPDATE SET keys = excluded.keys`),
    removeCross: db.prepare("DELETE FROM task_cross_read WHERE task_id = ?"),
    upsertHeal: db.prepare("INSERT INTO board_oracle_heal(task_id, at_ms) VALUES(?, ?) ON CONFLICT(task_id) DO UPDATE SET at_ms = excluded.at_ms"),
    removeHeal: db.prepare("DELETE FROM board_oracle_heal WHERE task_id = ?"),
    latest: db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
    taskFacts: db.prepare(`SELECT seq, ts_ms, step, body FROM fact WHERE task_id = ? AND seq <= ? AND step NOT IN (${unreadSql})
      UNION ALL SELECT f.seq, f.ts_ms, f.step, f.body FROM fact_alias a JOIN fact f ON f.seq = a.seq WHERE a.task = ? AND f.seq <= ? AND f.step NOT IN (${unreadSql})`),
    seqFact: db.prepare("SELECT seq, ts_ms, step, body FROM fact WHERE seq = ?"),
    stepFacts: db.prepare("SELECT seq, ts_ms, body FROM fact WHERE step = ? AND seq <= ? ORDER BY ts_ms, seq"),
    planOnlyFacts: db.prepare(`SELECT step, body FROM fact WHERE step IN ('pr.opened', 'review.posted', ?) AND seq <= ? AND json_type(body, '$.plan_only') = 'true'`),
    maxSeq: db.prepare("SELECT MAX(seq) AS seq FROM fact"),
    // Index-only (fact_step holds step, ts_ms and the rowid): what a deleted row would move, read without a body.
    stepDigest: db.prepare(`SELECT count(*) AS n, sum(seq) AS s, sum(ts_ms % ${DIGEST_MOD}) AS t FROM fact WHERE step = ? AND seq <= ?`),
    planOnlyDigest: db.prepare(`SELECT count(*) AS n, sum(seq) AS s, sum(ts_ms % ${DIGEST_MOD}) AS t FROM fact
      WHERE step IN ('pr.opened', 'review.posted', ?) AND seq <= ?`),
    runNewestFact: db.prepare(`SELECT MAX(ts_ms) AS ms FROM fact WHERE task_id = ? AND run_id = ? AND seq <= ? AND step NOT IN (${unreadSql})
      AND json_type(body, '$.task_id') = 'text'`),
  };
  const tableExists = (name: string): boolean => db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  /** A task's run stand-in sources, prepared once the store has their tables (a store built before them has none). */
  let taskRunSql: { worker?: ReadModelStatement; activity?: ReadModelStatement } | undefined;
  const taskRunStatements = (): { worker?: ReadModelStatement; activity?: ReadModelStatement } => {
    if (taskRunSql?.worker && taskRunSql.activity) return taskRunSql;
    taskRunSql = {
      ...(tableExists("run_worker") ? { worker: db.prepare("SELECT ts_ms, body, fields, seq FROM run_worker WHERE task_id = ?") } : {}),
      ...(tableExists("run_activity") ? { activity: db.prepare("SELECT run_id, ts, ts_ms, seq FROM run_activity WHERE task_id = ?") } : {}),
    };
    return taskRunSql;
  };
  const sentinel: Row = {};
  const rows: Row[] = [sentinel];
  const rowTsMs: number[] = [Number.NEGATIVE_INFINITY];
  /** Each kept row's order, its source-text length, and how many rules hold it (W1-T9436). */
  const kept = new Map<Row, { ord: Ord; bytes: number; holds: number; standIn?: { key: string; worker: boolean } }>();
  /** Rows every holder released since the last compaction; `rows` drops them at the end of the ingest. */
  const dropped = new Set<Row>();
  let ins = 0;
  // W1-T6253: every in-place change to `rows` (or the sentinel's ts) is a new generation, so an index held for the
  // old contents is never served for the new ones.
  let rowsGeneration = 0;
  const touched = (): void => noteLedgerGeneration(rows, ++rowsGeneration);
  touched();
  let lastSeq = 0;
  /** W1-T9403: the summed source-text length of every row in `rows` but the sentinel. */
  let keptBytes = 0;
  /** A first load spanning chunks: its rows are appended in seq order and sorted once, at the tail, as a one-call load. */
  let bulkOpen = false;
  let bulkOutOfOrder = false;
  /** Per `task|run`, the newest fact row's time, while a cold load has not yet read the run tables; a later run row asks the store. */
  let bulkNewestFactMs: Map<string, number> | undefined = new Map();
  let crossCount = 0;
  let crossSeq = 0;
  /** W1-T9719: per cross-task step its rows' count and newest seq; the plan-only filings' likewise, and their PRs. */
  const crossSteps = new Map<string, { count: number; seq: number }>();
  let filingCount = 0;
  let filingSeq = 0;
  const filingUrls = new Set<string>();
  let crossRowsPending = 0;
  let crossTotals: BoardCrossTask = { rows: 0, rederived: 0, reused: 0 };
  const taskCount = new Map<string, number>();
  const taskSeq = new Map<string, number>();
  const lastRunStartMs = new Map<string, number>();
  /** Per `task|run`, the KEPT row standing for its newest non-fact row, and for its worker rows. */
  const activityRows = new Map<string, Row>();
  const workerRows = new Map<string, Row>();
  const taskActivitySeq = new Map<string, number>();
  let activitySeq = 0;
  let activitySql: ReadModelStatement | undefined;
  const taskWorkerSeq = new Map<string, number>();
  let workerSeq = 0;
  let workerSql: ReadModelStatement | undefined;
  /** The newest parseable `ts` among every row the board ingested: `orphanedRunIds`'s ledger clock. */
  let latestParsedTsMs: number | undefined;
  /** Per PR, the newest `sweep.disposed` row's order and disposition: the repeat judgement's state. */
  const lastDisposition = new Map<number, { ord: Ord; disposition: unknown }>();
  /** Per rule, the rows it holds by key; per windowed rule, the window each key belongs to. */
  type Held1 = { row: Row; ord: Ord; window?: number };
  const ruleState = BOARD_ROW_RETENTION.map((rule) => ({
    rule,
    one: new Map<string, Held1>(),
    all: new Map<string, { window?: number; rows: Set<Row> }>(),
    runs: new Map<string, { anchor?: Held1; members: Held1[] }>(),
  }));
  /** The readers' "now": each windowed rule keeps from its day or week. Set by the first update, and never moved back. */
  let readerNowMs: number | undefined;
  const retainFrom = (): number => readerNowMs ?? clock.now();
  const onIngest = opts.onIngest;
  /** W1-T9604: each asked step's rows up to `lastSeq`, read in full once; the ingest queues its new rows in `stepPending`
   *  and the next ask merges them into a NEW array, so one handed out never changes. The plan-only sets likewise. */
  const stepCache = new Map<string, StepBucket>();
  const auditedSteps = new Set<string>();
  const stepPending = new Map<string, StepRow[]>();
  let planOnlyCache: PlanOnlySets | undefined;
  let planOnlyAudited = false;
  let planOnlyPending: StepRow[] = [];
  /** Every row of the three plan-only steps (plan-only or not) the cache's sets were read over, as the store digests it. */
  let planOnlyDigest: StepDigest | undefined;
  const cacheStrings = strings ? new Map<string, string>() : undefined;
  let stepReads = noStepReads();
  let lastCredit: { credit: CreditStore; overrides: string } = { credit: {}, overrides: "" };
  let latestTsMs = 0;
  const held = new Map<string, Held>();
  for (const r of db.prepare("SELECT task_id, stamp, json FROM task_projection").all()) {
    held.set(String(r.task_id), { stamp: String(r.stamp), projection: JSON.parse(String(r.json)) as StatusProjection });
  }
  /** W1-T6016: per held task, the GitHub reads its derive made and their digest under the gateway it read. Persisted
   *  beside the projection, so a restart replays them rather than re-deriving every task. */
  const githubReads = new Map<string, { keys: readonly string[]; digest: string }>();
  for (const r of db.prepare("SELECT task_id, digest, keys FROM task_github_read").all()) {
    githubReads.set(String(r.task_id), { digest: String(r.digest), keys: JSON.parse(String(r.keys)) as string[] });
  }
  const crossReads = new Map<string, readonly string[]>();
  for (const r of db.prepare("SELECT task_id, keys FROM task_cross_read").all()) crossReads.set(String(r.task_id), JSON.parse(String(r.keys)) as string[]);
  /** Tasks whose GitHub answers moved since their derive, kept until a derive takes them. */
  const githubStale = new Set<string>();
  let githubView: GithubView | undefined;
  let githubChecked: GithubView | undefined;
  const currentGithubView = (): GithubView => {
    const gw = gateway();
    const generation = githubGeneration();
    if (githubView?.gateway !== gw || githubView.generation !== generation) githubView = githubViewOf(gw, generation);
    return githubView;
  };
  // The newest row the persisted projections saw: the ledger-clock rule's baseline after a restart.
  let derivedLatestTsMs = Number(db.meta(LATEST_TS_META) ?? 0);
  const planHash = new WeakMap<Task, string>();
  let lastDeriveAt: number | undefined;
  let lastClockAt: number | undefined;
  let lastOracleAt: number | undefined;
  let pending = false;

  const noteParsedTs = (ts: unknown): void => {
    const ms = typeof ts === "string" ? Date.parse(ts) : Number.NaN;
    if (Number.isFinite(ms) && (latestParsedTsMs === undefined || ms > latestParsedTsMs)) latestParsedTsMs = ms;
  };

  function release(row: Row): void {
    const k = kept.get(row);
    if (!k || --k.holds > 0) return;
    kept.delete(row);
    dropped.add(row);
    keptBytes -= k.bytes;
    if (k.standIn) {
      const standing = k.standIn.worker ? workerRows : activityRows;
      if (standing.get(k.standIn.key) === row) standing.delete(k.standIn.key);
    }
  }

  /** Releases every windowed rule's rows of a window the readers' day or week has moved past, and each `asof` key's
   *  rows the readers' now has passed but its latest. */
  function releasePastWindows(): void {
    for (const state of ruleState) {
      const window = state.rule.window;
      if (state.rule.kind === "asof") {
        for (const set of state.all.values()) {
          const before = [...set.rows].filter((r) => Date.parse(r.ts as string) <= retainFrom());
          const latest = before.reduce<Row | undefined>((a, r) => (!a || Date.parse(r.ts as string) >= Date.parse(a.ts as string) ? r : a), undefined);
          for (const r of before) if (r !== latest) { set.rows.delete(r); release(r); }
        }
      }
      if (!window) continue;
      const from = currentWindowStart(window, retainFrom());
      for (const [key, h] of state.one) if (h.window !== undefined && h.window < from) { state.one.delete(key); release(h.row); }
      for (const [key, h] of state.all) if (h.window !== undefined && h.window < from) { state.all.delete(key); for (const row of h.rows) release(row); }
    }
  }

  /** The rules that take `row` now, and the rows each one lets go for it; the row is kept when any rule takes it. */
  function offer(row: Row, ord: Ord, facts: BoardRowFacts): number {
    if (keepAll) return 1;
    let holds = 0;
    const let_go: Row[] = [];
    for (const state of ruleState) {
      const { rule } = state;
      if (rule.steps !== "*" && !rule.steps.includes(row.step as string)) continue;
      const base = rule.key(row, facts);
      if (base === undefined) continue;
      let window: number | undefined;
      if (rule.window) {
        window = windowStartOf(rule.window, row);
        if (window === undefined || window < currentWindowStart(rule.window, retainFrom())) continue;
      }
      const key = window === undefined ? base : `${base}@${window}`;
      if (rule.kind === "asof") {
        const tsMs = typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
        if (!Number.isFinite(tsMs)) continue;
        const set = state.all.get(key) ?? state.all.set(key, { rows: new Set() }).get(key)!;
        set.rows.add(row);
        holds++;
        const before = [...set.rows].filter((r) => Date.parse(r.ts as string) <= retainFrom());
        const latest = before.reduce<Row | undefined>((a, r) => (!a || Date.parse(r.ts as string) >= Date.parse(a.ts as string) ? r : a), undefined);
        for (const r of before) if (r !== latest) { set.rows.delete(r); if (r === row) holds--; else let_go.push(r); }
      } else if (rule.kind === "all") {
        const set = state.all.get(key) ?? state.all.set(key, { ...(window !== undefined ? { window } : {}), rows: new Set() }).get(key)!;
        set.rows.add(row);
        holds++;
      } else if (rule.kind === "run") {
        const run = state.runs.get(key) ?? state.runs.set(key, { members: [] }).get(key)!;
        if (row.step === "run.start") {
          if (run.anchor && ordCompare(ord, run.anchor.ord) < 0) continue;
          if (run.anchor) let_go.push(run.anchor.row);
          run.anchor = { row, ord };
          run.members = run.members.filter((m) => ordCompare(m.ord, ord) > 0 || (let_go.push(m.row), false));
          holds++;
        } else if (run.anchor && ordCompare(ord, run.anchor.ord) > 0) {
          run.members.push({ row, ord });
          holds++;
        }
      } else {
        const was = state.one.get(key);
        const takes = !was || (rule.kind === "newest" ? ordCompare(ord, was.ord) > 0 : ordCompare(ord, was.ord) < 0);
        if (!takes) continue;
        if (was) let_go.push(was.row);
        state.one.set(key, { row, ord, ...(window !== undefined ? { window } : {}) });
        holds++;
      }
    }
    // The row is counted held before its predecessors are let go, so a row held twice over is never dropped early.
    if (holds > 0) kept.set(row, { ord, bytes: 0, holds });
    for (const old of let_go) release(old);
    return holds;
  }

  /** Takes a stand-in out of every rule holding it: a newer fact row (or stand-in) of its run now speaks for the run. */
  function withdraw(row: Row | undefined): void {
    if (!row || !kept.has(row)) return;
    const facts: BoardRowFacts = { standIn: true, repeat: false };
    for (const state of ruleState) {
      const { rule } = state;
      if (rule.steps !== "*" && !rule.steps.includes(row.step as string)) continue;
      const base = rule.key(row, facts);
      if (base === undefined) continue;
      const window: number | undefined = rule.window ? windowStartOf(rule.window, row) : undefined;
      const key: string = window === undefined ? base : `${base}@${window}`;
      if (state.one.get(key)?.row === row) state.one.delete(key);
      state.all.get(key)?.rows.delete(row);
    }
    const k = kept.get(row)!;
    k.holds = 1;
    release(row);
  }

  /** Places a held row by its time, after the rows of its instant (a bulk load appends and sorts at its tail). */
  function place(row: Row, tsMs: number, bytes: number, bulk: boolean): void {
    let at = rows.length;
    if (!bulk) while (rowTsMs[at - 1]! > tsMs) at--;
    rows.splice(at, 0, row);
    rowTsMs.splice(at, 0, tsMs);
    kept.get(row)!.bytes = bytes;
    keptBytes += bytes;
    if (strings) internRowStrings(row, strings);
    touched();
  }

  function sweepRepeatOf(row: Row, ord: Ord): boolean {
    if (row.step !== "sweep.disposed" || typeof row.pr_number !== "number") return false;
    const last = lastDisposition.get(row.pr_number);
    const repeat = last !== undefined && last.disposition === row.disposition;
    if (!last || ordCompare(ord, last.ord) > 0) lastDisposition.set(row.pr_number, { ord, disposition: row.disposition });
    return repeat;
  }

  /** Offers a run's stand-in; true when a rule keeps it. */
  function standIn(standing: Map<string, Row>, key: string, row: Row, tsMs: number, bytes: number): boolean {
    noteParsedTs(row.ts);
    latestTsMs = Math.max(latestTsMs, tsMs);
    const ord: Ord = [tsMs, ++ins];
    if (offer(row, ord, { standIn: true, repeat: false }) === 0) return false;
    if (keepAll) kept.set(row, { ord, bytes: 0, holds: 1 });
    kept.get(row)!.standIn = { key, worker: standing === workerRows };
    place(row, tsMs, bytes, false);
    standing.set(key, row);
    return true;
  }

  /** Each run's `worker.activity` rows stand as one row at the newest's time, carrying each field's newest value; true when one moved. */
  function ingestWorkers(): boolean {
    if (!workerSql) {
      if (!tableExists("run_worker")) return false;
      workerSql = db.prepare("SELECT task_id, run_id, ts_ms, body, fields, seq FROM run_worker WHERE seq > ? ORDER BY seq");
    }
    let moved = false;
    for (const r of workerSql.iterate(workerSeq)) {
      const [taskId, seq] = [String(r.task_id), Number(r.seq)];
      const key = `${taskId}|${String(r.run_id)}`;
      workerSeq = Math.max(workerSeq, seq);
      taskWorkerSeq.set(taskId, Math.max(taskWorkerSeq.get(taskId) ?? 0, seq));
      const [body, fields] = [String(r.body), String(r.fields)];
      const was = workerRows.get(key);
      // The new stand-in is offered before the old one goes, so a rule holding the old one moves to it.
      standIn(workerRows, key, { ...runWorkerRow(body, fields), step: WORKER_ACTIVITY_STAND_IN_STEP }, Number(r.ts_ms), body.length + fields.length);
      withdraw(was);
      moved = true;
    }
    return moved;
  }

  function newestFactMsOf(taskId: string, runId: string): number {
    const bulk = bulkNewestFactMs?.get(`${taskId}|${runId}`);
    if (bulkNewestFactMs) return bulk ?? Number.NEGATIVE_INFINITY;
    const r = sql.runNewestFact.get(taskId, runId, lastSeq, ...unread);
    return r?.ms === null || r?.ms === undefined ? Number.NEGATIVE_INFINITY : Number(r.ms);
  }

  /** Each run whose newest row of any step is newer than its newest fact row gets one row at that time, in time order; true when one moved. */
  function ingestActivity(): boolean {
    if (!activitySql) {
      if (!tableExists("run_activity")) return false;
      activitySql = db.prepare("SELECT task_id, run_id, ts, ts_ms, seq FROM run_activity WHERE seq > ? ORDER BY seq");
    }
    let moved = false;
    for (const r of activitySql.iterate(activitySeq)) {
      const [taskId, runId, tsMs, seq] = [String(r.task_id), String(r.run_id), Number(r.ts_ms), Number(r.seq)];
      activitySeq = Math.max(activitySeq, seq);
      const key = `${taskId}|${runId}`;
      taskActivitySeq.set(taskId, Math.max(taskActivitySeq.get(taskId) ?? 0, seq));
      moved = true;
      const was = activityRows.get(key);
      if (tsMs > newestFactMsOf(taskId, runId)) {
        const ts = String(r.ts);
        standIn(activityRows, key, { ts, step: BOARD_RUN_ACTIVITY_STEP, task_id: taskId, run_id: runId }, tsMs, ts.length + taskId.length + runId.length);
      }
      withdraw(was);
    }
    return moved;
  }

  function compact(): void {
    if (dropped.size === 0) return;
    let to = 1;
    for (let from = 1; from < rows.length; from++) {
      const row = rows[from]!;
      if (dropped.has(row)) continue;
      rows[to] = row;
      rowTsMs[to] = rowTsMs[from]!;
      to++;
    }
    rows.length = to;
    rowTsMs.length = to;
    dropped.clear();
    touched();
    // W1-T9436: the table keeps only the kept rows' values; each is already the table's own copy, so identity holds.
    if (strings) {
      const values: string[] = [];
      for (let at = 1; at < rows.length; at++) {
        for (const value of Object.values(rows[at]!)) if (typeof value === "string" && value.length <= BOARD_INTERN_MAX_CHARS) values.push(value);
      }
      strings.clear();
      for (const value of values) if (!strings.has(value)) strings.set(value, value);
    }
  }

  function ingest(limit: number, deadline = Number.POSITIVE_INFINITY): { fresh: number; caughtUp: boolean } {
    let fresh = 0;
    let cut = false;
    // The first load is sorted once; afterwards a live row a few ms early walks back a step or two.
    const bulk = lastSeq === 0 || bulkOpen;
    let outOfOrder = bulk && bulkOutOfOrder;
    const ingested: Row[] = [];
    for (const r of sql.facts.iterate(lastSeq, Number.isFinite(limit) ? limit : -1)) {
      if (fresh > 0 && clock.now() >= deadline) {
        cut = true;
        break;
      }
      const seq = Number(r.seq);
      lastSeq = seq;
      const tsMs = Number(r.ts_ms);
      fresh++;
      if (BOARD_UNREAD_STEPS.has(String(r.step))) {
        if (tsMs > latestTsMs) {
          sentinel.ts = String(r.ts);
          noteParsedTs(sentinel.ts);
          touched();
        }
        latestTsMs = Math.max(latestTsMs, tsMs);
        continue;
      }
      const body = String(r.body);
      const row = withoutUnreadFields(JSON.parse(body) as Row);
      noteParsedTs(row.ts);
      latestTsMs = Math.max(latestTsMs, tsMs);
      if (onIngest) ingested.push(row);
      // W1-T9604: a row of a cached step, or a plan-only row, extends the cache from this read; no index reads it again.
      const step = String(r.step);
      if (stepCache.has(step)) (stepPending.get(step) ?? stepPending.set(step, []).get(step)!).push({ row, tsMs, seq, bytes: body.length, step });
      if (planOnlyCache && PLAN_ONLY_STEPS.has(step)) {
        planOnlyDigest = digestWith(planOnlyDigest!, seq, tsMs);
        if (row.plan_only === true) planOnlyPending.push({ row, tsMs, seq, bytes: body.length, step });
      }
      const ord: Ord = [tsMs, ++ins];
      const repeat = keepAll ? false : sweepRepeatOf(row, ord);
      if (offer(row, ord, { standIn: false, repeat }) > 0) {
        if (keepAll) kept.set(row, { ord, bytes: 0, holds: 1 });
        else if (row.step === "sweep.disposed" && typeof row.pr_number === "number") SWEEP_REPEATS.set(row, repeat);
        if (bulk) outOfOrder ||= tsMs < rowTsMs[rows.length - 1]!;
        place(row, tsMs, body.length, bulk);
      }
      if (boardDirtForRow(row, rules).all) noteCrossRow(row, seq);
      const named = boardDirtForRow(row, { alias: rules.alias, crossTask: false });
      for (const id of named.all ? [] : named.tasks) {
        taskCount.set(id, (taskCount.get(id) ?? 0) + 1);
        taskSeq.set(id, seq);
      }
      if (row.step === "run.start" && typeof row.task_id === "string") {
        lastRunStartMs.set(row.task_id, Math.max(lastRunStartMs.get(row.task_id) ?? 0, tsMs));
      }
      if (typeof row.task_id === "string" && typeof row.run_id === "string") {
        const key = `${row.task_id}|${row.run_id}`;
        if (bulkNewestFactMs) bulkNewestFactMs.set(key, Math.max(bulkNewestFactMs.get(key) ?? Number.NEGATIVE_INFINITY, tsMs));
        const standing = activityRows.get(key);
        if (standing && kept.get(standing)!.ord[0] <= tsMs) {
          activityRows.delete(key);
          withdraw(standing);
        }
      }
    }
    if (onIngest && ingested.length > 0) onIngest(ingested);
    const caughtUp = !cut && fresh < limit;
    [bulkOpen, bulkOutOfOrder] = [bulk && !caughtUp, !caughtUp && outOfOrder];
    if (!caughtUp) {
      compact();
      pending = true;
      return { fresh, caughtUp };
    }
    compact();
    // Ledger order is time order, so a row is placed by its ts, not by when the projector read it.
    if (outOfOrder) {
      const order = rows.map((_, i) => i).sort((a, b) => rowTsMs[a]! - rowTsMs[b]!);
      const [sortedRows, sortedTs] = [order.map((i) => rows[i]!), order.map((i) => rowTsMs[i]!)];
      sortedRows.forEach((row, i) => { rows[i] = row; rowTsMs[i] = sortedTs[i]!; });
      touched();
    }
    const workers = ingestWorkers();
    const activity = ingestActivity();
    // The cold load's per-run times have served the run tables' first read; later rows ask the store.
    bulkNewestFactMs = undefined;
    compact();
    if (activity || workers || fresh > 0) pending = true;
    return { fresh, caughtUp };
  }

  const parse = (body: unknown): Row => withoutUnreadFields(JSON.parse(String(body)) as Row);

  function noteCrossRow(row: Row, seq: number): void {
    crossCount++;
    crossSeq = seq;
    if (lastDeriveAt !== undefined) crossRowsPending++;
    const step = String(row.step);
    if (BOARD_CROSS_TASK_STEPS.has(step)) {
      const held = crossSteps.get(step);
      crossSteps.set(step, { count: (held?.count ?? 0) + 1, seq });
      return;
    }
    filingCount++;
    filingSeq = seq;
    if (typeof row.pr_url === "string") filingUrls.add(row.pr_url);
  }

  function crossAnswer(key: string): string {
    if (key.startsWith(CROSS_STEP)) {
      const held = crossSteps.get(key.slice(CROSS_STEP.length));
      return `${held?.count ?? 0}:${held?.seq ?? 0}`;
    }
    if (key === CROSS_FILING_ANY) return `${filingCount}:${filingSeq}`;
    return filingUrls.has(key.slice(CROSS_FILING.length)) ? "1" : "0";
  }

  /** W1-T9719: `id`'s recorded cross-task answers now, its stamp's last part; with no record every cross-task row moves it. */
  function crossDigestOf(id: string): string {
    if (!rules.crossTask) return "-";
    const keys = crossReads.get(id);
    if (keys === undefined) return `u${crossCount}:${crossSeq}`;
    return keys.length === 0 ? "-" : sha1(keys.map(crossAnswer).join("\n"));
  }

  /** `step`'s rows up to `upTo`, read in full from the fact store. */
  function readStep(step: string, upTo: number): StepBucket {
    const rows: Row[] = [];
    const tsMs: number[] = [];
    const seqs: number[] = [];
    let bytes = 0;
    for (const r of sql.stepFacts.all(step, upTo)) {
      const body = String(r.body);
      rows.push(parse(body));
      tsMs.push(Number(r.ts_ms));
      seqs.push(Number(r.seq));
      bytes += body.length;
    }
    return { rows, tsMs, seqs, bytes };
  }

  /** The plan-only filing PRs and reviewed heads up to `upTo`, read in full from the fact store. */
  function readPlanOnly(upTo: number): PlanOnlySets {
    const filing = new Set<string>();
    const reviewed = new Map<string, Set<string>>();
    let [rows, bytes] = [0, 0];
    for (const r of sql.planOnlyFacts.iterate(PLAN_ONLY_REVIEW_MARKER_STEP, upTo)) {
      const body = String(r.body);
      [rows, bytes] = [rows + 1, bytes + body.length];
      const row = JSON.parse(body) as Row;
      if (typeof row.pr_url !== "string") continue;
      if (r.step === "pr.opened") filing.add(row.pr_url);
      else if (typeof row.head_sha === "string") reviewed.set(row.pr_url, (reviewed.get(row.pr_url) ?? new Set()).add(row.head_sha));
    }
    return { filing, reviewed, rows, bytes };
  }

  function dropStepCache(): void {
    stepCache.clear();
    auditedSteps.clear();
    stepPending.clear();
    planOnlyCache = undefined;
    planOnlyAudited = false;
    planOnlyPending = [];
    planOnlyDigest = undefined;
    cacheStrings?.clear();
  }

  /** The store's digest of `step`'s rows up to `lastSeq`, or of every row of the plan-only steps. */
  const storeDigest = (step: string | undefined): StepDigest => {
    const r = step === undefined ? sql.planOnlyDigest.get(PLAN_ONLY_REVIEW_MARKER_STEP, lastSeq) : sql.stepDigest.get(step, lastSeq);
    return { n: Number(r?.n ?? 0), s: Number(r?.s ?? 0), t: Number(r?.t ?? 0) };
  };

  /** W1-T9604: drops the cache when an index-only digest says a cached step's row was deleted under it (the consistency
   *  oracle's heal deletes corrupt or duplicate rows; facts otherwise only grow by seq), or the store reads behind it. */
  function checkStepCache(): void {
    if (stepCache.size === 0 && !planOnlyCache) return;
    const moved = [...stepCache].some(([step, bucket]) => !sameDigest(bucketDigest(bucket, stepPending.get(step)), storeDigest(step)))
      || (planOnlyDigest !== undefined && !sameDigest(planOnlyDigest, storeDigest(undefined)));
    const reason = moved ? "deleted" : Number(sql.maxSeq.get()?.seq ?? 0) < lastSeq ? "behind" : undefined;
    if (!reason) return;
    dropStepCache();
    stepReads.resets[reason]++;
  }

  /** `step`'s cached rows as of `upTo`: read in full at `lastSeq` on the first ask, so the ingest extends it from there. */
  function cachedStep(step: string, upTo: number): readonly Row[] {
    let bucket = stepCache.get(step);
    if (!bucket) {
      bucket = readStep(step, lastSeq);
      // Held across builds: equal strings shared (W1-T6467) in the cache's own table, not the kept rows' one.
      if (cacheStrings) for (const row of bucket.rows) internRowStrings(row as Row, cacheStrings);
      stepReads.fullReads++;
      [stepReads.fullRows, stepReads.fullBytes] = [stepReads.fullRows + bucket.rows.length, stepReads.fullBytes + bucket.bytes];
    } else {
      const more = stepPending.get(step) ?? [];
      const [held, heldBytes] = [bucket.rows.length, bucket.bytes];
      if (more.length > 0) bucket = extendBucket(bucket, more);
      stepPending.delete(step);
      [stepReads.extendedRows, stepReads.extendedBytes] = [stepReads.extendedRows + more.length, stepReads.extendedBytes + bucket.bytes - heldBytes];
      [stepReads.reusedRows, stepReads.reusedBytes] = [stepReads.reusedRows + held, stepReads.reusedBytes + heldBytes];
    }
    stepCache.set(step, bucket);
    if (upTo >= lastSeq) return bucket.rows;
    const seqs = bucket.seqs;
    return bucket.rows.filter((_, at) => seqs[at]! <= upTo);
  }

  /** The cached plan-only sets as of `upTo`; an index built before the cache moved past it reads its own in full. */
  function cachedPlanOnly(upTo: number): PlanOnlySets {
    if (!planOnlyCache) {
      planOnlyDigest = storeDigest(undefined);
      planOnlyCache = readPlanOnly(lastSeq);
      stepReads.fullReads++;
      [stepReads.fullRows, stepReads.fullBytes] = [stepReads.fullRows + planOnlyCache.rows, stepReads.fullBytes + planOnlyCache.bytes];
    } else {
      const [held, heldBytes] = [planOnlyCache.rows, planOnlyCache.bytes];
      if (planOnlyPending.length > 0) planOnlyCache = extendPlanOnly(planOnlyCache, planOnlyPending);
      [stepReads.extendedRows, stepReads.extendedBytes] = [stepReads.extendedRows + planOnlyPending.length, stepReads.extendedBytes + planOnlyCache.bytes - heldBytes];
      [stepReads.reusedRows, stepReads.reusedBytes] = [stepReads.reusedRows + held, stepReads.reusedBytes + heldBytes];
      planOnlyPending = [];
    }
    if (upTo >= lastSeq) return planOnlyCache;
    const own = readPlanOnly(upTo);
    stepReads.fullReads++;
    [stepReads.fullRows, stepReads.fullBytes] = [stepReads.fullRows + own.rows, stepReads.fullBytes + own.bytes];
    return own;
  }

  /** What the cache holds, queued rows included; the plan-only sets keep no row, so their entries are counted. */
  function heldStepCache(): BoardStepReads["held"] {
    let [rowCount, bytes] = [0, 0];
    for (const bucket of stepCache.values()) [rowCount, bytes] = [rowCount + bucket.rows.length, bytes + bucket.bytes];
    for (const more of [...stepPending.values(), planOnlyPending]) for (const m of more) [rowCount, bytes] = [rowCount + 1, bytes + m.bytes];
    for (const url of planOnlyCache?.filing ?? []) [rowCount, bytes] = [rowCount + 1, bytes + url.length];
    for (const [url, heads] of planOnlyCache?.reviewed ?? []) for (const head of heads) [rowCount, bytes] = [rowCount + 1, bytes + url.length + head.length];
    return { steps: stepCache.size, rows: rowCount, bytes };
  }

  /** Audits this slice and every new cache member against an uncached index at the same seq; a mismatch drops all. */
  function auditStepCache(fresh: LedgerIndex, index: number, of: number): {
    steps: number; rows: number; mismatches: string[]; slice: { index: number; of: number }; audited: number; held_back: number;
  } {
    // The audit's own look at the cache is not a build's: of its counts, only a reset it finds is kept.
    const counted = stepReads;
    stepReads = noStepReads();
    const mine = storeIndex(rows);
    const cachedSteps = [...stepCache.keys()].sort();
    const selected = cachedSteps.filter((step) => !auditedSteps.has(step) || boardOracleSliceOf(step, of) === index);
    const mismatches: string[] = [];
    let compared = 0;
    for (const step of selected) {
      const [have, want] = [mine.byStep.get(step) ?? [], fresh.byStep.get(step) ?? []];
      compared += want.length;
      if (have.length !== want.length || have.some((row, at) => JSON.stringify(row) !== JSON.stringify(want[at]))) mismatches.push(step);
      auditedSteps.add(step);
    }
    if (planOnlyCache && (!planOnlyAudited || boardOracleSliceOf("plan_only", of) === index)) {
      const sorted = (sets: Pick<LedgerIndex, "planOnlyFilingPrUrls" | "planOnlyReviewedHeads">): string => JSON.stringify([
        [...sets.planOnlyFilingPrUrls].sort(), [...sets.planOnlyReviewedHeads].map(([url, heads]) => [url, [...heads].sort()]).sort(),
      ]);
      if (sorted(mine) !== sorted(fresh)) mismatches.push("plan_only");
      planOnlyAudited = true;
    }
    if (mismatches.length > 0) {
      dropStepCache();
      stepReads.resets.audit++;
    }
    const found = stepReads.resets;
    stepReads = { ...counted, resets: { deleted: counted.resets.deleted + found.deleted, behind: counted.resets.behind + found.behind, audit: counted.resets.audit + found.audit } };
    return { steps: cachedSteps.length, rows: compared, mismatches, slice: { index, of }, audited: selected.length, held_back: cachedSteps.length - selected.length };
  }

  /**
   * W1-T9436: a ledger index whose task and step buckets are read on demand from the fact store, as
   * {@link buildLedgerIndex} would file them over every row: a task's rows by `fact_task` and `fact_alias`, with
   * its runs' stand-ins built as ingest builds them, in row order. Its rows are released with it, after the update.
   *
   * W1-T9604: `cached` (every index but the oracle's) takes its step buckets and plan-only sets from the projection's
   * step cache, which is read in full once and then extended by the rows the ingest reads; uncached, the index reads
   * them in full, as before, so the oracle derives from a read the cache never touched. `tally` counts what it reads.
   */
  function storeIndex(bound: ReadonlyArray<Row>, cached = true, tally?: { rows: number; bytes: number }): LedgerIndex {
    const upTo = lastSeq;
    if (cached) {
      stepReads.indexes++;
      checkStepCache();
    }
    const aliasReady = factAliasReady(db);
    let aliasSeqs: Map<string, number[]> | undefined;
    let last: { id: string; rows: Row[] } | undefined;
    const steps = new Map<string, readonly Row[]>();
    const runSql = taskRunStatements();
    let filing: Set<string> | undefined;
    let reviewed: Map<string, Set<string>> | undefined;
    const fullRead = (rowCount: number, bytes: number): void => {
      if (tally) [tally.rows, tally.bytes] = [tally.rows + rowCount, tally.bytes + bytes];
    };
    const counted = (body: unknown): string => {
      const text = String(body);
      fullRead(1, text.length);
      return text;
    };
    const fullStep = (step: string): readonly Row[] => {
      const own = readStep(step, upTo);
      fullRead(own.rows.length, own.bytes);
      return own.rows;
    };
    const taskBucket = (id: string): Row[] => {
      const facts: Array<{ row: Row; key: [number, number, number] }> = [];
      const source = aliasReady ? sql.taskFacts.iterate(id, upTo, ...unread, id, upTo, ...unread) : sql.taskFacts.iterate(id, upTo, ...unread, "\u0000", 0, ...unread);
      for (const r of source) facts.push({ row: parse(counted(r.body)), key: [Number(r.ts_ms), 0, Number(r.seq)] });
      if (!aliasReady) {
        if (!aliasSeqs) {
          // A store whose writer has not yet backfilled `fact_alias`: one scan of the fact bodies, held for this index only.
          aliasSeqs = new Map();
          for (const r of db.prepare(`SELECT seq, json_extract(body, '$.task') AS task FROM fact WHERE json_type(body, '$.task') = 'text'
            AND json_type(body, '$.task_id') = 'text' AND json_extract(body, '$.task') <> json_extract(body, '$.task_id')`).iterate()) {
            const list = aliasSeqs.get(String(r.task)) ?? aliasSeqs.set(String(r.task), []).get(String(r.task))!;
            list.push(Number(r.seq));
          }
        }
        for (const seq of aliasSeqs.get(id) ?? []) {
          const r = sql.seqFact.get(seq);
          if (r && seq <= upTo && !BOARD_UNREAD_STEPS.has(String(r.step))) facts.push({ row: parse(r.body), key: [Number(r.ts_ms), 0, seq] });
        }
      }
      const newest = new Map<string, number>();
      for (const f of facts) {
        if (f.row.task_id === id && typeof f.row.run_id === "string") newest.set(f.row.run_id, Math.max(newest.get(f.row.run_id) ?? Number.NEGATIVE_INFINITY, f.key[0]));
      }
      // Its runs' stand-ins, as ingest builds them: a run's worker rows always, its newest row only past its newest fact row.
      for (const r of runSql.worker?.iterate(id) ?? []) {
        facts.push({ row: { ...runWorkerRow(String(r.body), String(r.fields)), step: WORKER_ACTIVITY_STAND_IN_STEP }, key: [Number(r.ts_ms), 1, Number(r.seq)] });
      }
      for (const r of runSql.activity?.iterate(id) ?? []) {
        const [runId, tsMs] = [String(r.run_id), Number(r.ts_ms)];
        if (tsMs > (newest.get(runId) ?? Number.NEGATIVE_INFINITY)) facts.push({ row: { ts: String(r.ts), step: BOARD_RUN_ACTIVITY_STEP, task_id: id, run_id: runId }, key: [tsMs, 2, Number(r.seq)] });
      }
      facts.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
      return facts.map((f) => f.row);
    };
    const planOnly = (): void => {
      const sets = cached ? cachedPlanOnly(upTo) : readPlanOnly(upTo);
      if (!cached) fullRead(sets.rows, sets.bytes);
      [filing, reviewed] = [sets.filing, sets.reviewed];
    };
    return {
      rows: bound,
      byTask: { get: (id) => (last?.id === id ? last.rows : (last = { id, rows: taskBucket(id) }).rows) },
      byStep: {
        get: (step) => {
          let bucket = steps.get(step);
          if (!bucket) {
            bucket = BOARD_UNREAD_STEPS.has(step) ? [] : cached ? cachedStep(step, upTo) : fullStep(step);
            steps.set(step, bucket);
          }
          return bucket;
        },
      },
      get planOnlyFilingPrUrls() {
        if (!filing) planOnly();
        return filing!;
      },
      get planOnlyReviewedHeads() {
        if (!reviewed) planOnly();
        return reviewed!;
      },
      latestTsMs: latestParsedTsMs,
    };
  }

  function hashTask(task: Task): string {
    let h = planHash.get(task);
    if (h === undefined) planHash.set(task, (h = sha1(JSON.stringify(task))));
    return h;
  }

  /** One `projectPlan` pass and, per task it derived, the GitHub reads that derive made (W1-T6016): `projectPlan` asks
   *  `reuseProjection` of each task just before deriving it, so the log a refusal opens takes that task's reads. */
  function project(plan: Plan, credit: CreditStore, overrides: string, reuse?: (task: Task) => StatusProjection | undefined, index?: LedgerIndex): {
    projections: Map<string, StatusProjection>; reads: Map<string, GithubReadLog>; cross: Map<string, Set<string>>;
  } {
    const reads = new Map<string, GithubReadLog>();
    const cross = new Map<string, Set<string>>();
    let deriving: GithubReadLog | undefined;
    let crossDeriving: Set<string> | undefined;
    const deriveOrReuse = (task: Task): StatusProjection | undefined => {
      deriving = undefined;
      crossDeriving = undefined;
      const kept = reuse?.(task);
      if (kept !== undefined) return kept;
      deriving = { keys: [], answers: [] };
      reads.set(task.id, deriving);
      cross.set(task.id, (crossDeriving = new Set()));
      return undefined;
    };
    const deps: DeriveDeps = {
      ...opts.deriveDeps,
      ledgerPath: opts.ledgerPath,
      github: recordingGithub(gateway(), () => deriving),
      readLedger: () => rows,
      now: () => clock.now(),
      readCreditStore: () => credit,
      writeCreditStore: () => {},
      readCreditOverrideFile: () => overrides,
      skipUncreditedBuildWarning: true,
      ...(fromRows ? {} : { ledgerIndex: recordingCrossReads(index ?? storeIndex(rows), () => crossDeriving) }),
      reuseProjection: deriveOrReuse,
    };
    return { projections: projectPlan(plan, deps), reads, cross };
  }

  /** W1-T9719: keeps each of `ids`' recorded reads; a derive from rows in memory records none, so it keeps no record. */
  function keepCrossReads(cross: ReadonlyMap<string, ReadonlySet<string>>, ids: ReadonlySet<string>): void {
    for (const id of ids) {
      const keys = cross.get(id);
      if (keys === undefined || fromRows) crossReads.delete(id);
      else crossReads.set(id, [...keys].sort());
    }
  }

  /** Takes the GitHub reads of each task in `ids` the pass derived as its own, digested under `view`, the gateway the
   *  pass read. `reads` holds exactly the plan tasks the pass derived, each now held. */
  function keepReads(plan: Plan, view: GithubView, reads: ReadonlyMap<string, GithubReadLog>, ids: ReadonlySet<string>): void {
    for (const [id, log] of reads) {
      if (!ids.has(id)) continue;
      const h = held.get(id)!;
      githubStale.delete(id);
      // One entry per distinct read and answer: a derive asks `readFailed()` many times over.
      const seen = new Set<string>();
      const keys: string[] = [];
      const answers: string[] = [];
      log.keys.forEach((key, at) => {
        const pair = `${key}\u0001${log.answers[at]!}`;
        if (seen.has(pair)) return;
        seen.add(pair);
        keys.push(key);
        answers.push(log.answers[at]!);
      });
      githubReads.set(id, { keys, digest: githubDigest(view, id, plan.byId.get(id), h.projection, answers) });
    }
  }

  function persist(changed: ReadonlyArray<[string, Held]>, removed: readonly string[]): void {
    if (!lease) return;
    withWriteTransaction(db, lease, () => {
      for (const [id, h] of changed) {
        sql.upsert.run(id, h.stamp, JSON.stringify(h.projection));
        const reads = githubReads.get(id);
        if (reads) sql.upsertReads.run(id, reads.digest, JSON.stringify(reads.keys));
        else sql.removeReads.run(id);
        const crossKeys = crossReads.get(id);
        if (crossKeys) sql.upsertCross.run(id, JSON.stringify(crossKeys));
        else sql.removeCross.run(id);
      }
      for (const id of removed) {
        sql.remove.run(id);
        sql.removeReads.run(id);
        sql.removeCross.run(id);
      }
      sql.latest.run(LATEST_TS_META, String(latestTsMs));
    });
  }

  /** W1-T6016: the plan tasks whose GitHub answers moved since their derive, replayed against `view`. */
  function githubDirt(plan: Plan, view: GithubView): void {
    if (!rules.github || githubChecked === view) return;
    for (const task of plan.tasks) {
      const h = held.get(task.id);
      if (!h || githubStale.has(task.id)) continue;
      const reads = githubReads.get(task.id);
      if (!reads || githubDigest(view, task.id, task, h.projection, reads.keys.map((key) => view.answer(key))) !== reads.digest) githubStale.add(task.id);
    }
    githubChecked = view;
  }

  function inputs(): { plan: Plan; credit: CreditStore; overrides: string; stampOf: (id: string, task?: Task) => string } {
    const plan = opts.readPlan();
    const credit = readCredit();
    const overrides = readOverrides();
    lastCredit = { credit, overrides };
    // W1-T6016: no GitHub generation here: what each task read from GitHub is its own dirt (`githubDirt`).
    const global = sha1(JSON.stringify([BOARD_PROJECTION_VERSION, opts.codeVersion ?? "", sha1(overrides)]));
    const stampOf = (id: string, task?: Task): string =>
      `${global}|${task ? hashTask(task) : "-"}|${taskCount.get(id) ?? 0}:${taskSeq.get(id) ?? 0}:${taskActivitySeq.get(id) ?? 0}:${taskWorkerSeq.get(id) ?? 0}|${credit[id] ? sha1(JSON.stringify(credit[id])) : "-"}|${crossDigestOf(id)}`;
    return { plan, credit, overrides, stampOf };
  }

  // Heals the oracle recorded, newest last: persisted with the lease, so a recurrence is seen across a restart.
  const heals: number[] = db.prepare("SELECT at_ms FROM board_oracle_run WHERE healed > 0 ORDER BY at_ms").all().map((r) => Number(r.at_ms));
  const healedAt = new Map(db.prepare("SELECT task_id, at_ms FROM board_oracle_heal").all().map((r) => [String(r.task_id), Number(r.at_ms)] as const));
  const slices = Number.isFinite(opts.oracleSlices) && opts.oracleSlices! >= 1 ? Math.floor(opts.oracleSlices!) : BOARD_ORACLE_SLICES;
  const storedCursor = Number(db.meta(ORACLE_SLICE_META));
  let sliceCursor = Number.isSafeInteger(storedCursor) && storedCursor >= 0 ? storedCursor : 0;

  function diffAgainstHeld(fresh: ReadonlyMap<string, StatusProjection>): BoardOracleResult["mismatches"] {
    const mismatches: BoardOracleResult["mismatches"] = [];
    for (const id of new Set([...fresh.keys(), ...held.keys()])) {
      const want = fresh.get(id);
      const have = held.get(id)?.projection;
      if (canonicalProjection(want) !== canonicalProjection(have)) mismatches.push({ taskId: id, fields: differingFields(want, have) });
    }
    return mismatches.sort((a, b) => a.taskId.localeCompare(b.taskId));
  }

  function escalationFor(result: BoardOracleResult): Escalation {
    const name = opts.instance ?? "core";
    const sample = result.mismatches.slice(0, 10).map((m) => `- ${m.taskId}: ${m.fields.join(", ")}`);
    return {
      class: "MANUAL",
      taskId: `READ-MODEL-${name.toUpperCase()}`,
      summary: `read model ${name}: the board projection drifted from a no-reuse derive`,
      detail: [`${result.escalationReasons.join("; ")}.`, `Tasks whose reused projection differed (${result.mismatches.length}):`, ...sample].join("\n\n"),
      options: [
        { label: "find the missing dirty-set rule", detail: "A reused projection went stale: some input the stamp does not cover moved. The fields name what the reuse missed.", kind: { type: "operator-only" } },
        { label: "rebuild the read model", detail: "Run `rmd read-model rebuild`; the views keep serving until the new file passes its own check.", kind: { type: "operator-only" } },
      ],
      recommendation: "find the missing dirty-set rule",
      consequence: "The now view keeps healing the same drift every oracle pass, and serves it stale in between.",
    };
  }

  /** Tiers, as the consistency oracle's: recheck, heal, then escalate if the drift survives the heal or recurs within 24 h. */
  function oracleWith(plan: Plan, credit: CreditStore, overrides: string, stampOf: (id: string, task?: Task) => string): BoardOracleResult {
    const now = clock.now();
    const view = currentGithubView();
    const index = sliceCursor % slices;
    const expired = [...healedAt].filter(([, at]) => at < now - BOARD_ORACLE_RECURRENCE_MS).map(([id]) => id);
    for (const id of expired) healedAt.delete(id);
    const always = [...healedAt.keys()].filter((id) => plan.byId.has(id)).sort();
    const alwaysSet = new Set(always);
    const outside = slices === 1 ? undefined : (task: Task): StatusProjection | undefined =>
      (boardOracleSliceOf(task.id, slices) === index || alwaysSet.has(task.id) ? undefined : held.get(task.id)?.projection);
    const read = { projections: 0, rows: 0, bytes: 0 };
    // W1-T9604: the oracle derives from full reads the step cache never touched, and audits the cache against them.
    const uncached = (): LedgerIndex | undefined => (fromRows ? undefined : storeIndex(rows, false, read));
    const derive = (ledgerIndex?: LedgerIndex): ReturnType<typeof project> => {
      read.projections++;
      return project(plan, credit, overrides, outside, ledgerIndex ?? uncached());
    };
    const first = uncached();
    let pass = derive(first);
    const audited = [...pass.reads.keys()].filter((id) => plan.byId.has(id)).sort();
    let fresh = pass.projections;
    let mismatches = diffAgainstHeld(fresh);
    let outcome: BoardOracleOutcome = "agree";
    const reasons: string[] = [];
    let healedCount = 0;
    const audit = first ? auditStepCache(first, index, slices) : undefined;
    if (mismatches.length > 0) {
      pass = derive();
      fresh = pass.projections;
      mismatches = diffAgainstHeld(fresh);
      outcome = mismatches.length > 0 ? "healed" : "transient";
    }
    const healedNow: string[] = [];
    if (outcome === "healed") {
      keepCrossReads(pass.cross, new Set(mismatches.map((m) => m.taskId).filter((id) => fresh.has(id))));
      const healed: Array<[string, Held]> = [];
      for (const m of mismatches) {
        const want = fresh.get(m.taskId);
        if (want) healed.push([m.taskId, { stamp: stampOf(m.taskId, plan.byId.get(m.taskId)), projection: want }]);
      }
      const removed = mismatches.filter((m) => !fresh.has(m.taskId)).map((m) => m.taskId);
      for (const [id, h] of healed) held.set(id, h);
      for (const id of removed) held.delete(id);
      keepReads(plan, view, pass.reads, new Set(healed.map(([id]) => id)));
      for (const id of removed) {
        githubReads.delete(id);
        crossReads.delete(id);
      }
      persist(healed, removed);
      healedCount = mismatches.length;
      for (const [id] of healed) if (plan.byId.has(id)) healedNow.push(id);
      const survived = diffAgainstHeld(derive().projections);
      if (survived.length > 0) reasons.push(`${survived.length} task(s) still differ after the heal (${survived.slice(0, 5).map((m) => m.taskId).join(", ")})`);
      const prior = heals.filter((at) => at >= now - BOARD_ORACLE_RECURRENCE_MS);
      if (prior.length > 0) reasons.push(`the board drifted again within 24 h of an earlier self-heal (${prior.length} heal(s) in the window)`);
      heals.push(now);
    }
    if (reasons.length > 0) outcome = "escalated";
    lastOracleAt = now;
    sliceCursor++;
    for (const id of healedNow) healedAt.set(id, now);
    const compared = pass.reads.size + [...fresh.keys()].filter((id) => !plan.byId.has(id)).length;
    const slice = { index, of: slices, audited, alwaysAudited: always };
    const result: BoardOracleResult = { compared, mismatches, outcome, escalationReasons: reasons, issueUrl: null, slice };
    if (reasons.length > 0 && opts.escalation) result.issueUrl = tryEscalate(escalationFor(result), opts.escalation);
    if (lease && (outcome !== "agree" || slices > 1 || expired.length > 0)) {
      withWriteTransaction(db, lease, () => {
        if (outcome !== "agree") {
          db.prepare("INSERT INTO board_oracle_run(at_ms, outcome, mismatches, healed, issue_url) VALUES(?, ?, ?, ?, ?)")
            .run(now, outcome, mismatches.length, healedCount, result.issueUrl);
        }
        for (const id of healedNow) sql.upsertHeal.run(id, now);
        for (const id of expired) sql.removeHeal.run(id);
        if (slices > 1) sql.latest.run(ORACLE_SLICE_META, String(sliceCursor));
      });
    }
    // W1-T9604: what the step cache read and reused since the last oracle row, and its audit: the saving, measured.
    const stepCacheRow = fromRows ? {} : { step_cache: { ...stepReads, held: heldStepCache(), ...(audit ? { audit } : {}) } };
    stepReads = noStepReads();
    const crossTask = crossTotals;
    crossTotals = { rows: 0, rederived: 0, reused: 0 };
    log("read_model.board_oracle", {
      outcome, compared: result.compared, mismatches: mismatches.length, sample: mismatches.slice(0, 5),
      ...(reasons.length > 0 ? { reasons } : {}), ...(result.issueUrl ? { issue_url: result.issueUrl } : {}), ...stepCacheRow, cross_task: crossTask,
      slice: { index, of: slices, audited: audited.length, always_audited: always.length }, read,
    });
    return result;
  }

  return {
    update(options = {}): BoardUpdate {
      const startedAt = clock.now();
      const readers = options.readerNowMs ?? startedAt;
      if (!keepAll && (readerNowMs === undefined || readers > readerNowMs)) {
        readerNowMs = readers;
        releasePastWindows();
      }
      const { fresh: newRows, caughtUp } = ingest(chunkRows, startedAt + chunkMs);
      if (!caughtUp) return { derived: false, deferred: false, caughtUp, newRows, rederived: [], reused: 0, full: false, elapsedMs: clock.now() - startedAt };
      const now = clock.now();
      const oracleDue = lastOracleAt === undefined ? false : now - lastOracleAt >= BOARD_ORACLE_INTERVAL_MS;
      // The oracle runs right after a clock re-derive, so it never reports what the next 30 s tick would fix.
      const clockDue = rules.clock && (lastClockAt === undefined || now - lastClockAt >= BOARD_CLOCK_REDERIVE_MS || oracleDue);
      const { plan, credit, overrides, stampOf } = inputs();
      const stamps = new Map<string, string>();
      for (const task of plan.tasks) stamps.set(task.id, stampOf(task.id, task));
      const view = currentGithubView();
      githubDirt(plan, view);
      const moved = plan.tasks.some((t) => held.get(t.id)?.stamp !== stamps.get(t.id) || githubStale.has(t.id)) || held.size === 0;
      const idle: BoardUpdate = { derived: false, caughtUp, deferred: false, newRows, rederived: [], reused: plan.tasks.length, full: false, elapsedMs: 0 };
      if (!options.force && !moved && !pending && !clockDue && !oracleDue) return idle;
      if (!options.force && lastDeriveAt !== undefined && now - lastDeriveAt < BOARD_DERIVE_DEBOUNCE_MS) return { ...idle, deferred: true };
      // The ledger clock: a lone run.start inside the liveness bound can turn orphan as soon as any newer row lands.
      const ledgerClockDue = new Set<string>();
      if (rules.ledgerClock && latestTsMs > derivedLatestTsMs) {
        for (const [id, startMs] of lastRunStartMs) if (startMs + DEFAULT_LIVENESS_BOUND_MS > derivedLatestTsMs) ledgerClockDue.add(id);
      }
      const crossRows = crossRowsPending;
      let crossMoved = 0;
      if (crossRows > 0) {
        for (const task of plan.tasks) {
          const stamp = held.get(task.id)?.stamp;
          if (stamp !== undefined && stamp.slice(stamp.lastIndexOf("|") + 1) !== crossDigestOf(task.id)) crossMoved++;
        }
      }
      const rederived: string[] = [];
      const reuse = (task: Task): StatusProjection | undefined => {
        const h = held.get(task.id);
        const stale = !h || h.stamp !== stamps.get(task.id) || ledgerClockDue.has(task.id) || githubStale.has(task.id)
          || (clockDue && (projectionAgesWithTheClock(h.projection) || h.projection.independentFailureBlocked === true));
        if (!stale) return h.projection;
        rederived.push(task.id);
        return undefined;
      };
      const { projections: next, reads, cross } = project(plan, credit, overrides, reuse);
      const changed: Array<[string, Held]> = [];
      const planIds = new Set(plan.tasks.map((t) => t.id));
      const fresh = new Set(rederived);
      // W1-T9719: a re-derived task's stamp carries this derive's cross-task reads.
      keepCrossReads(cross, fresh);
      for (const [id, projection] of next) {
        const h = { stamp: fresh.has(id) ? stampOf(id, plan.byId.get(id)) : (stamps.get(id) ?? stampOf(id)), projection };
        if (!planIds.has(id) || fresh.has(id)) changed.push([id, h]);
        held.set(id, h);
      }
      const removed = [...held.keys()].filter((id) => !next.has(id));
      for (const id of removed) {
        held.delete(id);
        githubReads.delete(id);
        githubStale.delete(id);
        crossReads.delete(id);
      }
      keepReads(plan, view, reads, new Set(rederived));
      derivedLatestTsMs = latestTsMs;
      persist(changed, removed);
      pending = false;
      lastDeriveAt = now;
      crossRowsPending = 0;
      if (clockDue) lastClockAt = now;
      lastOracleAt ??= now;
      const result: BoardUpdate = {
        derived: true, caughtUp, deferred: false, newRows, rederived: rederived.sort(), reused: plan.tasks.length - rederived.length,
        full: rederived.length === plan.tasks.length, elapsedMs: 0,
      };
      if (crossRows > 0) {
        result.crossTask = { rows: crossRows, rederived: crossMoved, reused: plan.tasks.length - crossMoved };
        crossTotals = { rows: crossTotals.rows + crossRows, rederived: crossTotals.rederived + crossMoved, reused: crossTotals.reused + plan.tasks.length - crossMoved };
      }
      if (oracleDue) result.oracle = oracleWith(plan, credit, overrides, stampOf);
      result.elapsedMs = clock.now() - startedAt;
      return result;
    },
    projections: () => new Map([...held].map(([id, h]) => [id, h.projection])),
    rows: () => rows,
    index: (bound) => (fromRows ? buildLedgerIndex(bound) : storeIndex(bound)),
    internedStrings: () => strings?.size ?? 0,
    size: () => ({ rows: rows.length - 1, keptBytes }),
    creditRead: () => lastCredit,
    oracle(): BoardOracleResult {
      ingest(Number.POSITIVE_INFINITY);
      const { plan, credit, overrides, stampOf } = inputs();
      return oracleWith(plan, credit, overrides, stampOf);
    },
  };
}

export type BoardShadowClassification = "legacy_horizon" | "bug";

/** Every task a row older than `horizonTsMs` names, in `task_id` or `task`: what the legacy live-file board cannot see. */
export function rowsNamingTasksBefore(rows: ReadonlyArray<Row>, horizonTsMs: number): Set<string> {
  const older = new Set<string>();
  for (const row of rows) {
    const ms = typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
    if (!(ms < horizonTsMs)) continue;
    for (const id of [row.task_id, row.task]) if (typeof id === "string") older.add(id);
  }
  return older;
}

/**
 * Operator ruling Q1: the full-history board is the correct answer. A task that differs from the
 * legacy board (live file only) is `legacy_horizon` when a row older than the legacy horizon names
 * it; anything else is a `bug`, so a diff the horizon cannot explain is never waved through.
 */
export function classifyBoardShadowDiffs(
  fullHistory: ReadonlyMap<string, StatusProjection>,
  legacy: ReadonlyMap<string, StatusProjection>,
  rows: ReadonlyArray<Row>,
  legacyHorizonTsMs: number,
): Array<{ taskId: string; fields: string[]; classification: BoardShadowClassification }> {
  const older = rowsNamingTasksBefore(rows, legacyHorizonTsMs);
  const out: Array<{ taskId: string; fields: string[]; classification: BoardShadowClassification }> = [];
  for (const id of [...new Set([...fullHistory.keys(), ...legacy.keys()])].sort()) {
    const a = fullHistory.get(id);
    const b = legacy.get(id);
    if (canonicalProjection(a) === canonicalProjection(b)) continue;
    out.push({ taskId: id, fields: differingFields(a, b), classification: older.has(id) ? "legacy_horizon" : "bug" });
  }
  return out;
}
