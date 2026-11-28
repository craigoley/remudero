/**
 * lib/flow-snapshot.ts — W1-T15009: EACH INSTANCE PUBLISHES A FLOW SNAPSHOT of its open pull requests by stage.
 *
 * No single place sizes the build, review and fix lanes, and nothing compares one instance's backlog with another's.
 * The allocation that will (W1-T15010) needs each instance's flow in one place. This module writes it: one JSON file
 * per instance under `flow-snapshot/`, beside the `review-demand/` rows (host-memory-priority.ts) in the same shared
 * host directory, replaced atomically on every sweep pass.
 *
 * (1) STAGES count EVERY owner. W1-T4465 keeps operator pull requests out of the build gate, but they still occupy the
 *     review and fix lanes, so the flow counts fleet and operator heads alike, each in its own column.
 * (2) THROUGHPUT is measured, never configured: completions per lane kind over the trailing day (a build pull request
 *     opened, a terminal review posted, a fix round finished) and merges per hour with the p50 open-to-merge lead time
 *     over the trailing week. The live ledger rotates within the hour, so each pass folds what it sees into a small
 *     instance-local history file, and every window is reported with the hours it actually covers.
 * (3) RUNNABLE work is the daemon's own last `lane.idle_changed` count of dispatchable tasks, with the time it was seen.
 *
 * OBSERVATION ONLY: nothing reads the snapshot to decide anything yet. {@link publishFlowSnapshot} never throws.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { fixedClock, systemClock, type Clock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";
import { defaultInstance, type LedgerInstance } from "./host-memory-ledger.js";
import { isMergedLedgerRow, prUrlKey } from "./ledger-carry.js";
import { resolveTestSlotDir } from "./test-slot.js";

export const FLOW_SNAPSHOT_SUBDIR = "flow-snapshot";
export const FLOW_SNAPSHOT_STEP = "flow.snapshot";
export const FLOW_SNAPSHOT_HISTORY_FILE = "flow-snapshot-history.json";
const HOUR_MS = 3_600_000;
/** The design's windows: lane completions over the trailing day, merges and lead time over the trailing week. */
export const FLOW_COMPLETION_WINDOW_MS = 24 * HOUR_MS;
export const FLOW_MERGE_WINDOW_MS = 7 * 24 * HOUR_MS;

export type FlowStage = "checks_running" | "awaiting_review" | "failing" | "ready";
export type FlowOwner = "fleet" | "operator";
export type FlowLane = "build" | "review" | "fix";

/** One open pull request as the sweep's board holds it, with its owner already decided by the sweep's own rule. */
export interface FlowBoardPr {
  prUrl: string;
  checksState: "green" | "red" | "pending" | "none";
  reviewState: "success" | "failure" | "pending" | "none";
  owner: FlowOwner;
  createdAt?: string;
}

export type FlowStageCounts = Record<FlowStage, number>;

export interface FlowSnapshot {
  schema: 1;
  instance: string;
  instanceHostUnique: boolean;
  publishedAt: string;
  stages: Record<FlowOwner, FlowStageCounts>;
  open: Record<FlowOwner, number> & { total: number };
  runnableTasks: number | null;
  runnableObservedAt: string | null;
  completions: Record<FlowLane, number> & { windowHours: number };
  merges: { windowHours: number; count: number; perHour: number | null; p50LeadTimeMs: number | null; leadTimeSamples: number };
  historySince: string;
}

/** The instance-local fold that outlives the live ledger's rotation. Keys dedupe a row seen on many passes. */
interface FlowHistory {
  schema: 1;
  sinceMs: number;
  events: Record<FlowLane, Array<[string, number]>>;
  merges: Array<[string, number]>;
  opened: Record<string, number>;
}

export interface FlowSnapshotOptions {
  /** The shared host directory. Default: `<test slot dir>/host-memory`, where the review demand rows live. */
  location?: () => { dir: string; scope: "host" | "local" };
  root?: string;
  instance?: (root: string) => LedgerInstance;
  clock?: Clock;
  /** The instance-local history file. Default: beside the instance's ledger. */
  historyPath?: string;
  write?: (path: string, content: string) => void;
  read?: (path: string) => string;
  log?: (event: Record<string, unknown>) => void;
}

/** The stage a head is in: a red required check or a failed review is the fix lane's, green and passed is ready. */
export function flowStageOf(pr: Pick<FlowBoardPr, "checksState" | "reviewState">): FlowStage {
  if (pr.checksState === "red" || pr.reviewState === "failure") return "failing";
  if (pr.checksState !== "green") return "checks_running";
  return pr.reviewState === "success" ? "ready" : "awaiting_review";
}

const tsMs = (row: Readonly<Record<string, unknown>>): number => (typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN);

function prKeyOf(row: Readonly<Record<string, unknown>>): string | undefined {
  return prUrlKey(row.pr_url) ?? (typeof row.pr_number === "number" ? `#${row.pr_number}` : undefined);
}

/** The lane a ledger row completes, if any: a build's pull request, a terminal review, a finished fix round. */
function completedLane(row: Readonly<Record<string, unknown>>): FlowLane | undefined {
  if (row.step === "pr.opened") return row.lane === "run-task" ? "build" : undefined;
  if (row.step === "review.posted") return row.state === "success" || row.state === "failure" ? "review" : undefined;
  return row.step === "fix.done" ? "fix" : undefined;
}

function emptyHistory(now: number): FlowHistory {
  return { schema: 1, sinceMs: now, events: { build: [], review: [], fix: [] }, merges: [], opened: {} };
}

function parsedHistory(text: string, now: number): FlowHistory {
  const raw = JSON.parse(text) as Partial<FlowHistory>;
  if (raw?.schema !== 1 || !Number.isFinite(raw.sinceMs) || !raw.events || !Array.isArray(raw.merges) || !raw.opened) return emptyHistory(now);
  return raw as FlowHistory;
}

/** PURE: fold the live rows and the board into the history, pruned to the design's windows. */
export function foldFlowHistory(
  history: FlowHistory, lines: ReadonlyArray<Readonly<Record<string, unknown>>>, board: readonly FlowBoardPr[], now: number,
): FlowHistory {
  const events = { build: new Map(history.events.build), review: new Map(history.events.review), fix: new Map(history.events.fix) };
  const merges = new Map(history.merges);
  const opened = new Map(Object.entries(history.opened));
  for (const pr of board) {
    const key = prUrlKey(pr.prUrl) ?? pr.prUrl;
    const created = pr.createdAt === undefined ? Number.NaN : Date.parse(pr.createdAt);
    if (Number.isFinite(created) && !opened.has(key)) opened.set(key, created);
  }
  for (const row of lines) {
    const at = tsMs(row);
    if (!Number.isFinite(at)) continue;
    const lane = completedLane(row);
    if (lane) events[lane].set(`${row.step}|${row.ts}|${row.run_id ?? ""}|${row.pr_url ?? row.pr_number ?? ""}`, at);
    const key = prKeyOf(row);
    if (key === undefined) continue;
    if (row.step === "pr.opened" && !opened.has(key)) opened.set(key, at);
    if (isMergedLedgerRow(row) && !merges.has(key)) {
      const mergedAt = typeof row.merged_at === "string" ? Date.parse(row.merged_at) : Number.NaN;
      merges.set(key, Number.isFinite(mergedAt) ? mergedAt : at);
    }
  }
  const onBoard = new Set(board.map((pr) => prUrlKey(pr.prUrl) ?? pr.prUrl));
  const within = (windowMs: number) => (entry: [string, number]) => now - entry[1] <= windowMs;
  return {
    schema: 1,
    sinceMs: history.sinceMs,
    events: {
      build: [...events.build].filter(within(FLOW_COMPLETION_WINDOW_MS)),
      review: [...events.review].filter(within(FLOW_COMPLETION_WINDOW_MS)),
      fix: [...events.fix].filter(within(FLOW_COMPLETION_WINDOW_MS)),
    },
    merges: [...merges].filter(within(FLOW_MERGE_WINDOW_MS)),
    opened: Object.fromEntries([...opened].filter(([key, at]) => onBoard.has(key) || merges.has(key) || now - at <= FLOW_MERGE_WINDOW_MS)),
  };
}

/** The daemon's last count of dispatchable tasks, from its own `lane.idle_changed` rows. */
function lastRunnable(lines: ReadonlyArray<Readonly<Record<string, unknown>>>): { count: number; at: string } | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const row = lines[i]!;
    if (row.step === "lane.idle_changed" && typeof row.dispatchable === "number" && typeof row.ts === "string") {
      return { count: row.dispatchable, at: row.ts };
    }
  }
  return undefined;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const hours = (ms: number): number => Math.round((ms / HOUR_MS) * 1000) / 1000;

/** PURE: the snapshot one pass publishes, from its board, its live rows and the folded history. */
export function buildFlowSnapshot(
  board: readonly FlowBoardPr[], lines: ReadonlyArray<Readonly<Record<string, unknown>>>, history: FlowHistory,
  instance: LedgerInstance, now: number, iso: string,
): FlowSnapshot {
  const zero = (): FlowStageCounts => ({ checks_running: 0, awaiting_review: 0, failing: 0, ready: 0 });
  const stages: Record<FlowOwner, FlowStageCounts> = { fleet: zero(), operator: zero() };
  for (const pr of board) stages[pr.owner][flowStageOf(pr)] += 1;
  const fleet = board.filter((pr) => pr.owner === "fleet").length;
  const covered = Math.max(0, now - history.sinceMs);
  const mergeWindowMs = Math.min(FLOW_MERGE_WINDOW_MS, covered);
  const leadTimes = history.merges.flatMap(([key, mergedMs]) => {
    const openedMs = history.opened[key];
    return openedMs !== undefined && mergedMs >= openedMs ? [mergedMs - openedMs] : [];
  });
  const runnable = lastRunnable(lines);
  return {
    schema: 1,
    instance: instance.name,
    instanceHostUnique: instance.hostUnique,
    publishedAt: iso,
    stages,
    open: { fleet, operator: board.length - fleet, total: board.length },
    runnableTasks: runnable?.count ?? null,
    runnableObservedAt: runnable?.at ?? null,
    completions: {
      windowHours: hours(Math.min(FLOW_COMPLETION_WINDOW_MS, covered)),
      build: history.events.build.length, review: history.events.review.length, fix: history.events.fix.length,
    },
    merges: {
      windowHours: hours(mergeWindowMs),
      count: history.merges.length,
      perHour: mergeWindowMs > 0 ? history.merges.length / (mergeWindowMs / HOUR_MS) : null,
      p50LeadTimeMs: median(leadTimes),
      leadTimeSamples: leadTimes.length,
    },
    historySince: fixedClock(history.sinceMs).iso(),
  };
}

function defaultLocation(): { dir: string; scope: "host" | "local" } {
  const slot = resolveTestSlotDir();
  return { dir: join(slot.dir, "host-memory"), scope: slot.scope === "configured" || slot.scope === "host-scratch" ? "host" : "local" };
}

/** One instance's file name: its instance name, with anything outside a safe set replaced. */
export function flowSnapshotFileName(instance: string): string {
  return `${instance.replace(/[^A-Za-z0-9._-]/g, "_") || "_"}.json`;
}

/**
 * Publish this instance's flow snapshot, replacing its previous one, and fold its history. Called from each sweep pass.
 * NEVER throws: a failure logs one diagnostic and returns undefined, and the sweep proceeds unchanged.
 */
export function publishFlowSnapshot(
  board: readonly FlowBoardPr[], lines: ReadonlyArray<Readonly<Record<string, unknown>>>, ledgerPath: string,
  opts: FlowSnapshotOptions = {},
): FlowSnapshot | undefined {
  try {
    const root = opts.root ?? join(homedir(), "Remudero");
    const instance = (opts.instance ?? defaultInstance)(root);
    const clock = opts.clock ?? systemClock;
    const now = clock.now();
    const write = opts.write ?? ((target: string, content: string) => {
      mkdirSync(dirname(target), { recursive: true });
      writeAtomic(target, content);
    });
    const read = opts.read ?? ((path: string) => readFileSync(path, "utf8"));
    const historyPath = opts.historyPath ?? join(dirname(ledgerPath), FLOW_SNAPSHOT_HISTORY_FILE);
    let prior: FlowHistory;
    try {
      prior = parsedHistory(read(historyPath), now);
    } catch (error) {
      void error; // No history yet, or a torn one: the fold starts over and says so through `historySince`.
      prior = emptyHistory(now);
    }
    const history = foldFlowHistory(prior, lines, board, now);
    const snapshot = buildFlowSnapshot(board, lines, history, instance, now, clock.iso());
    write(historyPath, `${JSON.stringify(history)}\n`);
    write(join((opts.location ?? defaultLocation)().dir, FLOW_SNAPSHOT_SUBDIR, flowSnapshotFileName(instance.name)), `${JSON.stringify(snapshot)}\n`);
    return snapshot;
  } catch (error) {
    try {
      opts.log?.({ event: "flow.snapshot_error", reason: String((error as Error)?.message ?? error).slice(0, 160) });
    } catch (logError) {
      void logError; // The diagnostic of a diagnostic: the sweep must not hear of it.
    }
    return undefined;
  }
}
