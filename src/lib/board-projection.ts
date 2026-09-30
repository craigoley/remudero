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
 * - a cross-task row (`daemon.boot`, a `plan_only` `pr.opened`): every task, because
 *   `environmentChangedSince`, `lifetimeDispatchTally` and `isPlanOnlyFilingPr` read them whole-ledger;
 * - its plan entry, its durable credit record, the credit overrides, the GitHub generation, the code;
 * - the clock: every {@link BOARD_CLOCK_REDERIVE_MS}, a projection that ages with the clock or holds
 *   an independent-failure block (the 6 h environmental cooldown);
 * - the ledger's own clock: `orphanedRunIds` measures a lone `run.start` against the NEWEST row
 *   anywhere, so a task whose start is inside the liveness bound moves when any row lands.
 *
 * A no-reuse derive every {@link BOARD_ORACLE_INTERVAL_MS} diffs against the reused board, heals
 * what differs, and reports it: the rules above are measured, not assumed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { projectionAgesWithTheClock } from "./board.js";
import { systemClock, type Clock } from "./clock.js";
import { tryEscalate, type EscalateDeps, type Escalation } from "./escalate.js";
import type { Plan, Task } from "./plan.js";
import { withWriteTransaction, type ReadModelDb, type ReadModelLease } from "./read-model-db.js";
import {
  DEFAULT_LIVENESS_BOUND_MS,
  defaultCreditOverridePath,
  defaultCreditStorePath,
  loadCreditStore,
  projectPlan,
  type CreditStore,
  type DeriveDeps,
  type GitHub,
  type StatusProjection,
} from "./status.js";

/** Bumped when this module's stamp or stored shape changes: every persisted projection then re-derives. */
export const BOARD_PROJECTION_VERSION = 1;
export const BOARD_CLOCK_REDERIVE_MS = 30_000;
export const BOARD_ORACLE_INTERVAL_MS = 10 * 60_000;
export const BOARD_DERIVE_DEBOUNCE_MS = 500;
/** A drift found again this soon after a self-heal is a projection bug, not a blip: it escalates (as #8075's oracle). */
export const BOARD_ORACLE_RECURRENCE_MS = 24 * 60 * 60_000;
/** Steps some task's derivation reads across the whole ledger, whatever task they name. */
export const BOARD_CROSS_TASK_STEPS: ReadonlySet<string> = new Set(["daemon.boot"]);
/** Fact steps no reader on the projection path (status.ts, board.ts, status-board.ts) names: 60% of the
 *  core's fact rows. They are never parsed; the newest `ts` among them rides a sentinel row, because
 *  `orphanedRunIds` reads the ledger's newest `ts` from every row. */
export const BOARD_UNREAD_STEPS: ReadonlySet<string> = new Set(["sweep.pass", "sweep.summary", "incident.event", "main.health.observed"]);
const LATEST_TS_META = "board.latest_ts_ms";

export const BOARD_PROJECTION_DDL = `CREATE TABLE IF NOT EXISTS task_projection(task_id TEXT PRIMARY KEY,
  stamp TEXT NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS board_oracle_run(at_ms INTEGER NOT NULL, outcome TEXT NOT NULL, mismatches INTEGER NOT NULL,
  healed INTEGER NOT NULL, issue_url TEXT);`;

export type Row = Record<string, unknown>;

/** Each dirty-set rule, switchable only so a measurement or a test can show what it closes. */
export interface BoardDirtRules {
  alias: boolean;
  crossTask: boolean;
  clock: boolean;
  ledgerClock: boolean;
}
const ALL_RULES: BoardDirtRules = { alias: true, crossTask: true, clock: true, ledgerClock: true };

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

/** The default GitHub generation: the open PRs' identity and heads, and whether the read failed. */
export function githubGenerationOf(github: GitHub): string {
  const open = github.listOpenHeadBranches?.();
  const rows = open === undefined ? "none" : open === null ? "failed" : open.map((pr) => `${pr.number}:${pr.state}:${pr.headRefOid ?? ""}`).sort();
  return sha1(JSON.stringify([rows, github.readFailed?.() ?? false]));
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
}

export interface BoardUpdate {
  /** False when nothing moved, or the debounce deferred the derive. */
  derived: boolean;
  deferred: boolean;
  newRows: number;
  /** Plan tasks re-derived this update, sorted; every other plan task was reused. */
  rederived: string[];
  reused: number;
  full: boolean;
  elapsedMs: number;
  oracle?: BoardOracleResult;
}

export interface BoardProjection {
  update(opts?: { force?: boolean }): BoardUpdate;
  projections(): ReadonlyMap<string, StatusProjection>;
  /** The fact rows the board derives from, in ledger order. */
  rows(): ReadonlyArray<Row>;
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

export function createBoardProjection(opts: BoardProjectionOptions): BoardProjection {
  const { db, lease } = opts;
  const clock = opts.clock ?? systemClock;
  const rules: BoardDirtRules = { ...ALL_RULES, ...opts.rules };
  const log = opts.log ?? (() => {});
  const readCredit = opts.readCreditStore ?? (() => loadCreditStore(defaultCreditStorePath(opts.ledgerPath)));
  const readOverrides = opts.readCreditOverrideFile ?? (() => readTextOr(defaultCreditOverridePath(opts.ledgerPath), ""));
  const githubGeneration = opts.githubGeneration ?? (() => githubGenerationOf(opts.github));
  db.exec(BOARD_PROJECTION_DDL);
  const sql = {
    facts: db.prepare("SELECT seq, ts, ts_ms, step, body FROM fact WHERE seq > ? ORDER BY seq"),
    upsert: db.prepare(`INSERT INTO task_projection(task_id, stamp, json) VALUES(?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET stamp = excluded.stamp, json = excluded.json`),
    remove: db.prepare("DELETE FROM task_projection WHERE task_id = ?"),
    latest: db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
  };
  const sentinel: Row = {};
  const rows: Row[] = [sentinel];
  const rowTsMs: number[] = [Number.NEGATIVE_INFINITY];
  let lastSeq = 0;
  let crossCount = 0;
  let crossSeq = 0;
  const taskCount = new Map<string, number>();
  const taskSeq = new Map<string, number>();
  const lastRunStartMs = new Map<string, number>();
  let latestTsMs = 0;
  const held = new Map<string, Held>();
  for (const r of db.prepare("SELECT task_id, stamp, json FROM task_projection").all()) {
    held.set(String(r.task_id), { stamp: String(r.stamp), projection: JSON.parse(String(r.json)) as StatusProjection });
  }
  // The newest row the persisted projections saw: the ledger-clock rule's baseline after a restart.
  let derivedLatestTsMs = Number(db.meta(LATEST_TS_META) ?? 0);
  const planHash = new WeakMap<Task, string>();
  let lastDeriveAt: number | undefined;
  let lastClockAt: number | undefined;
  let lastOracleAt: number | undefined;
  let pending = false;

  function ingest(): number {
    let fresh = 0;
    let outOfOrder = false;
    // The first load is sorted once; afterwards a live row a few ms early walks back a step or two.
    const bulk = lastSeq === 0;
    for (const r of sql.facts.iterate(lastSeq)) {
      const seq = Number(r.seq);
      lastSeq = seq;
      const tsMs = Number(r.ts_ms);
      fresh++;
      if (BOARD_UNREAD_STEPS.has(String(r.step))) {
        if (tsMs > latestTsMs) sentinel.ts = String(r.ts);
        latestTsMs = Math.max(latestTsMs, tsMs);
        continue;
      }
      const row = JSON.parse(String(r.body)) as Row;
      let at = rows.length;
      if (bulk) outOfOrder ||= tsMs < rowTsMs[at - 1]!;
      else while (rowTsMs[at - 1]! > tsMs) at--;
      rows.splice(at, 0, row);
      rowTsMs.splice(at, 0, tsMs);
      latestTsMs = Math.max(latestTsMs, tsMs);
      const dirt = boardDirtForRow(row, rules);
      if (dirt.all) {
        crossCount++;
        crossSeq = seq;
      } else {
        for (const id of dirt.tasks) {
          taskCount.set(id, (taskCount.get(id) ?? 0) + 1);
          taskSeq.set(id, seq);
        }
      }
      if (row.step === "run.start" && typeof row.task_id === "string") {
        lastRunStartMs.set(row.task_id, Math.max(lastRunStartMs.get(row.task_id) ?? 0, tsMs));
      }
    }
    // Ledger order is time order, so a row is placed by its ts, not by when the projector read it.
    if (outOfOrder) {
      const order = rows.map((_, i) => i).sort((a, b) => rowTsMs[a]! - rowTsMs[b]!);
      const [sortedRows, sortedTs] = [order.map((i) => rows[i]!), order.map((i) => rowTsMs[i]!)];
      sortedRows.forEach((row, i) => { rows[i] = row; rowTsMs[i] = sortedTs[i]!; });
    }
    if (fresh > 0) pending = true;
    return fresh;
  }

  function hashTask(task: Task): string {
    let h = planHash.get(task);
    if (h === undefined) planHash.set(task, (h = sha1(JSON.stringify(task))));
    return h;
  }

  function project(plan: Plan, credit: CreditStore, overrides: string, reuse?: (task: Task) => StatusProjection | undefined): Map<string, StatusProjection> {
    const deps: DeriveDeps = {
      ...opts.deriveDeps,
      ledgerPath: opts.ledgerPath,
      github: opts.github,
      readLedger: () => rows,
      now: () => clock.now(),
      readCreditStore: () => credit,
      writeCreditStore: () => {},
      readCreditOverrideFile: () => overrides,
      skipUncreditedBuildWarning: true,
      ...(reuse ? { reuseProjection: reuse } : {}),
    };
    return projectPlan(plan, deps);
  }

  function persist(changed: ReadonlyArray<[string, Held]>, removed: readonly string[]): void {
    if (!lease) return;
    withWriteTransaction(db, lease, () => {
      for (const [id, h] of changed) sql.upsert.run(id, h.stamp, JSON.stringify(h.projection));
      for (const id of removed) sql.remove.run(id);
      sql.latest.run(LATEST_TS_META, String(latestTsMs));
    });
  }

  function inputs(): { plan: Plan; credit: CreditStore; overrides: string; stampOf: (id: string, task?: Task) => string } {
    const plan = opts.readPlan();
    const credit = readCredit();
    const overrides = readOverrides();
    const global = sha1(JSON.stringify([BOARD_PROJECTION_VERSION, opts.codeVersion ?? "", crossCount, crossSeq, githubGeneration(), sha1(overrides)]));
    const stampOf = (id: string, task?: Task): string =>
      `${global}|${task ? hashTask(task) : "-"}|${taskCount.get(id) ?? 0}:${taskSeq.get(id) ?? 0}|${credit[id] ? sha1(JSON.stringify(credit[id])) : "-"}`;
    return { plan, credit, overrides, stampOf };
  }

  // Heals the oracle recorded, newest last: persisted with the lease, so a recurrence is seen across a restart.
  const heals: number[] = db.prepare("SELECT at_ms FROM board_oracle_run WHERE healed > 0 ORDER BY at_ms").all().map((r) => Number(r.at_ms));

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
    let fresh = project(plan, credit, overrides);
    let mismatches = diffAgainstHeld(fresh);
    let outcome: BoardOracleOutcome = "agree";
    const reasons: string[] = [];
    let healedCount = 0;
    if (mismatches.length > 0) {
      fresh = project(plan, credit, overrides);
      mismatches = diffAgainstHeld(fresh);
      outcome = mismatches.length > 0 ? "healed" : "transient";
    }
    if (outcome === "healed") {
      const healed: Array<[string, Held]> = [];
      for (const m of mismatches) {
        const want = fresh.get(m.taskId);
        if (want) healed.push([m.taskId, { stamp: stampOf(m.taskId, plan.byId.get(m.taskId)), projection: want }]);
      }
      const removed = mismatches.filter((m) => !fresh.has(m.taskId)).map((m) => m.taskId);
      for (const [id, h] of healed) held.set(id, h);
      for (const id of removed) held.delete(id);
      persist(healed, removed);
      healedCount = mismatches.length;
      const survived = diffAgainstHeld(project(plan, credit, overrides));
      if (survived.length > 0) reasons.push(`${survived.length} task(s) still differ after the heal (${survived.slice(0, 5).map((m) => m.taskId).join(", ")})`);
      const prior = heals.filter((at) => at >= now - BOARD_ORACLE_RECURRENCE_MS);
      if (prior.length > 0) reasons.push(`the board drifted again within 24 h of an earlier self-heal (${prior.length} heal(s) in the window)`);
      heals.push(now);
    }
    if (reasons.length > 0) outcome = "escalated";
    lastOracleAt = now;
    const result: BoardOracleResult = { compared: fresh.size, mismatches, outcome, escalationReasons: reasons, issueUrl: null };
    if (reasons.length > 0 && opts.escalation) result.issueUrl = tryEscalate(escalationFor(result), opts.escalation);
    if (lease && outcome !== "agree") {
      withWriteTransaction(db, lease, () => {
        db.prepare("INSERT INTO board_oracle_run(at_ms, outcome, mismatches, healed, issue_url) VALUES(?, ?, ?, ?, ?)")
          .run(now, outcome, mismatches.length, healedCount, result.issueUrl);
      });
    }
    log("read_model.board_oracle", {
      outcome, compared: result.compared, mismatches: mismatches.length, sample: mismatches.slice(0, 5),
      ...(reasons.length > 0 ? { reasons } : {}), ...(result.issueUrl ? { issue_url: result.issueUrl } : {}),
    });
    return result;
  }

  return {
    update(options = {}): BoardUpdate {
      const startedAt = clock.now();
      const newRows = ingest();
      const now = clock.now();
      const oracleDue = lastOracleAt === undefined ? false : now - lastOracleAt >= BOARD_ORACLE_INTERVAL_MS;
      // The oracle runs right after a clock re-derive, so it never reports what the next 30 s tick would fix.
      const clockDue = rules.clock && (lastClockAt === undefined || now - lastClockAt >= BOARD_CLOCK_REDERIVE_MS || oracleDue);
      const { plan, credit, overrides, stampOf } = inputs();
      const stamps = new Map<string, string>();
      for (const task of plan.tasks) stamps.set(task.id, stampOf(task.id, task));
      const moved = plan.tasks.some((t) => held.get(t.id)?.stamp !== stamps.get(t.id)) || held.size === 0;
      const idle: BoardUpdate = { derived: false, deferred: false, newRows, rederived: [], reused: plan.tasks.length, full: false, elapsedMs: 0 };
      if (!options.force && !moved && !pending && !clockDue && !oracleDue) return idle;
      if (!options.force && lastDeriveAt !== undefined && now - lastDeriveAt < BOARD_DERIVE_DEBOUNCE_MS) return { ...idle, deferred: true };
      // The ledger clock: a lone run.start inside the liveness bound can turn orphan as soon as any newer row lands.
      const ledgerClockDue = new Set<string>();
      if (rules.ledgerClock && latestTsMs > derivedLatestTsMs) {
        for (const [id, startMs] of lastRunStartMs) if (startMs + DEFAULT_LIVENESS_BOUND_MS > derivedLatestTsMs) ledgerClockDue.add(id);
      }
      const rederived: string[] = [];
      const reuse = (task: Task): StatusProjection | undefined => {
        const h = held.get(task.id);
        const stale = !h || h.stamp !== stamps.get(task.id) || ledgerClockDue.has(task.id)
          || (clockDue && (projectionAgesWithTheClock(h.projection) || h.projection.independentFailureBlocked === true));
        if (!stale) return h.projection;
        rederived.push(task.id);
        return undefined;
      };
      const next = project(plan, credit, overrides, reuse);
      const changed: Array<[string, Held]> = [];
      const planIds = new Set(plan.tasks.map((t) => t.id));
      for (const [id, projection] of next) {
        const h = { stamp: stamps.get(id) ?? stampOf(id), projection };
        if (!planIds.has(id) || rederived.includes(id)) changed.push([id, h]);
        held.set(id, h);
      }
      const removed = [...held.keys()].filter((id) => !next.has(id));
      for (const id of removed) held.delete(id);
      derivedLatestTsMs = latestTsMs;
      persist(changed, removed);
      pending = false;
      lastDeriveAt = now;
      if (clockDue) lastClockAt = now;
      lastOracleAt ??= now;
      const result: BoardUpdate = {
        derived: true, deferred: false, newRows, rederived: rederived.sort(), reused: plan.tasks.length - rederived.length,
        full: rederived.length === plan.tasks.length, elapsedMs: 0,
      };
      if (oracleDue) result.oracle = oracleWith(plan, credit, overrides, stampOf);
      result.elapsedMs = clock.now() - startedAt;
      return result;
    },
    projections: () => new Map([...held].map(([id, h]) => [id, h.projection])),
    rows: () => rows,
    oracle(): BoardOracleResult {
      ingest();
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
