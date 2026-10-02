/**
 * The read-only repository portfolio surface for the console dashboard.
 * The instance registry supplies connected daemon repositories, including core; the separate
 * managed-repos file supplies issue-intake repositories. Never add core to managed-repos merely
 * to make a dashboard card appear: that would also opt its public issues into intake.
 *
 * Every figure is a trailing seven-day projection of the de-duplicated ledger (repo-ledger-index.ts):
 * - `errorrate` = failed / (succeeded + failed) runs. A run SUCCEEDED when its task took merge credit
 *   (`verdict.merged`, or a `verdict` of merged/already_satisfied/awaiting_merge). A run FAILED when its
 *   verdict is in {@link ERROR_VERDICTS}, unless the same task took merge credit afterwards (SUPERSEDED:
 *   counted in neither term). Held, transient and re-queued outcomes are in neither verdict set.
 * - `tokens7d` = input + output + cache-creation tokens; cache reads are `cache_read_tokens7d`. Each call is
 *   counted once: its `worker.attempt` receipt when the run wrote one, else the lane's own step row.
 * - `cash_usd_7d` (and `cost_7d`) sum only `billing_mode: api` calls. Subscription calls are usage, not
 *   dollars: `subscription` reports their calls, tokens and the latest provider window percentages.
 * - `modelsused` = provider-served models, else the canonical selected model (W1-T4478) of an assignment.
 * A row names its repository by its own `repo`, else through its run's `run.start` row; the instance's own
 * repository also owns every row that names none (its gardeners, sweeps and fix lanes).
 * `connected_at` and `settings` are NOT computed: no registry records a connection time, and no config key
 * holds a per-repo proof policy, pool size or alert threshold. `not_computed` says so per field.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import type { Route } from "./service.js";
import { sendJson } from "./panel-actions.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { RmdError } from "./errors.js";
import { pauseFilePath, stopFilePath } from "./fleet-control.js";
import { readIncidentLifecycleStore } from "./incident-lifecycle.js";
import { loadManagedRepos, type ManagedRepo } from "./managed-repos.js";
import { InstanceRegistryError, parseInstanceRegistry } from "./instance-registry.js";
import type { Plan } from "./plan.js";
import { threadStrictPlan } from "./thread-plan.js";
import { assignmentFacts, createRepoLedgerIndex, type RepoLedgerIndex } from "./repo-ledger-index.js";
import { DEFAULT_LIVENESS_BOUND_MS, isMergeCreditLine } from "./status.js";

export type RepoCondition = "healthy" | "degraded" | "down" | "paused" | "idle" | "unknown";

export interface RepoRunOutcomes {
  succeeded: number;
  failed: number;
  superseded: number;
}

export interface RepoDashboardHealth {
  /** Measurement state in the console's vocabulary: `verified` = computed from a present ledger. */
  status: "verified" | "unknown";
  condition: RepoCondition;
  reasons: string[];
  /** Open plan tasks: not merged, done, retired or merge-credited. */
  queuedtasks: number | null;
  /** The subset of `queuedtasks` whose plan status is `queued`. */
  queued: number | null;
  errorrate: number | null;
  runs7d: RepoRunOutcomes | null;
  last_run: string | null;
  /** The instance's open incidents; null for a repository this instance does not operate, or an unreadable store. */
  alerts: string[] | null;
}

/** One provider usage window as the router last read it on a worker assignment. */
export interface RepoSubscriptionWindow {
  provider: string;
  window: string | null;
  percent_used: number | null;
  resets_at: string | null;
  observed_at: string;
}

export interface RepoSubscriptionUsage {
  calls7d: number;
  tokens7d: number;
  /** The latest reading per provider window. Account-wide, not per repository. */
  windows: RepoSubscriptionWindow[];
}

export interface RepoDashboardTelemetry {
  measurementClass: "observed" | "not-collected";
  tokens7d: number | null;
  cache_read_tokens7d: number | null;
  cash_usd_7d: number | null;
  /** The same figure as `cash_usd_7d`: real API dollars only. */
  cost_7d: number | null;
  subscription: RepoSubscriptionUsage | null;
  modelsused: string[] | null;
}

export interface RepoDashboardSettings {
  proofpolicy: null;
  workerpoolsize: null;
  alertthreshold: null;
}

/** A path is relative to the instance's own `/v1/i/<instance>/` prefix. */
export interface RepoAction {
  id: "toggleonoff" | "viewlogs" | "configure" | "test_run";
  available: boolean;
  method?: "GET" | "POST";
  path?: string;
  scope?: "read" | "write";
  reason?: string;
}

export interface RepoDashboardEntry {
  id: string;
  reponame: string;
  repourl: string;
  connected_at: null;
  /** False when the instance is paused or stopped; null for a repository this instance does not operate. */
  active: boolean | null;
  managed: true;
  source: "managed-repos" | "instance-registry";
  health: RepoDashboardHealth;
  telemetry: RepoDashboardTelemetry;
  settings: RepoDashboardSettings;
  actions: RepoAction[];
  not_computed: { connected_at: string; settings: string };
}

export interface RepoDashboardResult {
  generated_at: string;
  source: "managed-repos" | "instance-registry" | "instance-registry+managed-repos";
  /** Absent only for standalone route callers that did not configure a registry read. */
  registry?: { state: "verified" } | { state: "unavailable"; reason: string };
  repos: RepoDashboardEntry[];
}

export const REPO_TELEMETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Task-attributable failures: verify-human-release.ts's FAILED_VERDICTS plus `failed`, a worker that
 *  ran and errored. Infrastructure and transient blocks (`blocked_transient`, `blocked_git_fetch`,
 *  `blocked_containment`, `blocked_isolation`, `blocked_inflight`, `pr_attribution_failed`, ...)
 *  are in neither set, so they move neither the numerator nor the denominator. */
export const ERROR_VERDICTS: ReadonlySet<string> = new Set([
  "blocked_ci",
  "blocked_review",
  "no_pr",
  "blocked_budget",
  "error_max_budget_usd",
  "blocked_illformed",
  "failed",
]);
export const SUCCESS_VERDICTS: ReadonlySet<string> = new Set(["merged", "already_satisfied", "awaiting_merge"]);

const NOT_COMPUTED = {
  connected_at: "no registry records when a repository was connected",
  settings: "no config key holds a per-repository proof policy, worker pool size or alert threshold",
} as const;
const MAX_ALERTS = 12;

type Row = Record<string, unknown>;

export interface RepoTelemetry {
  queuedtasks: number | null;
  queued: number | null;
  errorrate: number | null;
  runs7d: RepoRunOutcomes | null;
  last_run: string | null;
  tokens7d: number | null;
  cache_read_tokens7d: number | null;
  cash_usd_7d: number | null;
  subscription: RepoSubscriptionUsage | null;
  modelsused: string[] | null;
  /** What the shadow comparator judges a diff by (view-shadow.ts); only when asked for. */
  shadow?: RepoShadowFacts;
}

/** Per count its members (a task id, or `<task>#<ts>` for one row), per sum the rows it added, and `last_run`'s row. */
export interface RepoShadowFacts {
  counts: Record<string, string[]>;
  sums: Record<string, { rows: Array<[string, number]>; precision?: number }>;
  lastRun: string | null;
  /** The condition and reasons this repository's own signals give for other run counts. */
  condition?: (runs7d: RepoRunOutcomes) => { condition: RepoCondition; reasons: string[] };
}

/** What only the instance that operates a repository knows about it. */
export interface RepoInstanceSignals {
  paused: boolean;
  stopped: boolean;
  lastDaemonMs: number | null;
  alerts: string[] | null;
  alertsReason?: string;
}

/**
 * What one summary read from files beside its ledger and plan. Given back as `fileReads`, a second
 * evaluation replays these instead of reading the files again: the PAUSE marker a recycle holds for
 * seconds (2026-10-02T14:32:13Z) must not read paused on one side and running on the other.
 */
export interface RepoSummaryFileReads {
  /** The instance registry's text, null when it was unreadable; absent when no registry was read. */
  registry?: string | null;
  managed?: ManagedRepo[];
  /** The fleet-control markers and the incident store's alerts; the heartbeat stays the ledger's. */
  control?: Omit<RepoInstanceSignals, "lastDaemonMs">;
}

const UNKNOWN: RepoTelemetry = {
  queuedtasks: null, queued: null, errorrate: null, runs7d: null, last_run: null,
  tokens7d: null, cache_read_tokens7d: null, cash_usd_7d: null, subscription: null, modelsused: null,
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function namesRepo(value: string | undefined, repo: ManagedRepo): boolean {
  return value === `${repo.owner}/${repo.repo}` || value === repo.repo;
}

/** Worker rows carry `billing_mode` beside `total_cost_usd` (worker.ts's workerLedgerFields). A `verdict`
 *  restates its run's total and a `cost.anomaly` restates worker costs, so neither is a call. */
function isWorkerCostRow(row: Row): boolean {
  return row.step !== "cost.anomaly" && row.step !== "verdict" && str(row.billing_mode) !== undefined && typeof row.total_cost_usd === "number";
}

/** A canonical model id carries a version (`claude-sonnet-5-5`); a bare alias (`sonnet`) predates W1-T4478. */
function canonicalModel(v: unknown): string | undefined {
  const model = str(v)?.trim();
  return model && model.includes("-") && model.length <= 160 ? model : undefined;
}

/** The newest `daemon.*` heartbeat among rows, for callers that hand in rows rather than an index. */
export function lastDaemonHeartbeatMs(rows: readonly Row[]): number | null {
  let last: number | null = null;
  for (const row of rows) {
    if (typeof row.step !== "string" || !row.step.startsWith("daemon.")) continue;
    const ts = Date.parse(str(row.ts) ?? "");
    if (Number.isFinite(ts) && (last === null || ts > last)) last = ts;
  }
  return last;
}

/** Pure projection of one repository's telemetry. `ledger` undefined = no ledger source; `plan`
 *  undefined = no plan source. `own` = this instance operates the repository, so rows naming no
 *  repository are its own work. */
export function projectRepoTelemetry(
  repo: ManagedRepo,
  sources: { ledger?: readonly Row[]; plan?: Plan; nowMs: number; own?: boolean; members?: boolean },
): RepoTelemetry {
  const { plan, nowMs } = sources;
  if (!sources.ledger) return UNKNOWN;
  const seen = new Set<string>();
  // A row after `nowMs` changes nothing: the run-level passes below are unwindowed, so a later worker.attempt
  // would drop an in-window recon.done from a reader that merely read later (2026-10-01T18:27:18Z, W1-T5017).
  const ledger = sources.ledger.filter((row) => {
    if (Date.parse(str(row.ts) ?? "") > nowMs) return false;
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const runRepo = new Map<string, string>();
  const runTask = new Map<string, string>();
  const creditedAt = new Map<string, number>();
  for (const row of ledger) {
    const runId = str(row.run_id);
    const named = str(row.repo);
    if (row.step === "run.start" && runId && named) runRepo.set(runId, named);
    if (row.step === "run.start" && runId && str(row.task_id)) runTask.set(runId, str(row.task_id)!);
    const ts = Date.parse(str(row.ts) ?? "");
    if (isMergeCreditLine(row) && typeof row.task_id === "string" && Number.isFinite(ts)) {
      creditedAt.set(row.task_id, Math.max(ts, creditedAt.get(row.task_id) ?? -Infinity));
    }
  }
  const windowStart = nowMs - REPO_TELEMETRY_WINDOW_MS;
  const runsWithAttempt = new Set<string>();
  for (const row of ledger) if (row.step === "worker.attempt" && isWorkerCostRow(row)) runsWithAttempt.add(str(row.run_id) ?? "");
  let lastRunMs = -Infinity;
  let lastRun: string | null = null;
  let lastRunRow: string | null = null;
  const sumRows: Record<"tokens" | "cacheRead" | "cash" | "subTokens", Array<[string, number]>> = { tokens: [], cacheRead: [], cash: [], subTokens: [] };
  const subCallRows: string[] = [];
  const succeededTasks = new Set<string>();
  const failedRows: string[] = [];
  const supersededRows: string[] = [];
  let tokens = 0;
  let cacheRead = 0;
  let cash = 0;
  let subCalls = 0;
  let subTokens = 0;
  const windows = new Map<string, { ts: number; value: RepoSubscriptionWindow }>();
  const models = new Set<string>();
  for (const row of ledger) {
    const owner = str(row.repo) ?? runRepo.get(str(row.run_id) ?? "");
    if (!(namesRepo(owner, repo) || (sources.own === true && owner === undefined))) continue;
    const ts = Date.parse(str(row.ts) ?? "");
    if (!Number.isFinite(ts) || ts < windowStart || ts > nowMs) continue;
    const taskId = str(row.task_id) ?? `run:${str(row.run_id) ?? ts}`;
    const verdict = str(row.verdict) ?? "";
    if (isMergeCreditLine(row) || (row.step === "verdict" && SUCCESS_VERDICTS.has(verdict))) {
      succeededTasks.add(taskId);
      if (ts > lastRunMs) [lastRunMs, lastRun, lastRunRow] = [ts, str(row.ts)!, `${taskId}#${str(row.ts)}`];
    } else if (row.step === "verdict") {
      if (ts > lastRunMs) [lastRunMs, lastRun, lastRunRow] = [ts, str(row.ts)!, `${taskId}#${str(row.ts)}`];
      if (!ERROR_VERDICTS.has(verdict)) continue;
      ((creditedAt.get(taskId) ?? -Infinity) >= ts ? supersededRows : failedRows).push(`${taskId}#${str(row.ts)}`);
    } else if (row.step === "worker.assignment") {
      const facts = assignmentFacts(row);
      const model = canonicalModel(facts.model);
      if (model) models.add(model);
      for (const w of facts.windows) {
        const provider = str(w.provider);
        if (!provider) continue;
        const key = `${provider}|${str(w.name) ?? ""}`;
        if ((windows.get(key)?.ts ?? -Infinity) > ts) continue;
        const percent = typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent) ? w.usedPercent : null;
        const resets = typeof w.resetsAt === "number" ? fixedClock(w.resetsAt * 1000).iso() : str(w.resetsAt) ?? null;
        windows.set(key, { ts, value: { provider, window: str(w.name) ?? null, percent_used: percent, resets_at: resets, observed_at: str(row.ts)! } });
      }
    } else if (isWorkerCostRow(row)) {
      const served = canonicalModel(row.served_model);
      if (served) models.add(served);
      if (row.step !== "worker.attempt" && runsWithAttempt.has(str(row.run_id) ?? "")) continue;
      const t = (row.tokens && typeof row.tokens === "object" ? row.tokens : {}) as Row;
      const callTokens = num(t.input) + num(t.output) + num(t.cacheCreation);
      const rowId = `${str(row.task_id) ?? runTask.get(str(row.run_id) ?? "") ?? `run:${str(row.run_id)}`}#${String(row.step)}@${str(row.ts)}`;
      tokens += callTokens;
      cacheRead += num(t.cacheRead);
      sumRows.tokens.push([rowId, callTokens]);
      sumRows.cacheRead.push([rowId, num(t.cacheRead)]);
      if (row.billing_mode === "api") {
        cash += num(row.total_cost_usd);
        sumRows.cash.push([rowId, num(row.total_cost_usd)]);
        continue;
      }
      subCalls += 1;
      subTokens += callTokens;
      subCallRows.push(rowId);
      sumRows.subTokens.push([rowId, callTokens]);
    }
  }
  const open = plan?.tasks.filter((t) =>
    namesRepo(t.repo, repo) && t.status !== "merged" && t.status !== "done" && t.retirement === undefined
    && !creditedAt.has(t.id));
  const succeeded = succeededTasks.size;
  const failed = failedRows.length;
  const superseded = supersededRows.length;
  const shadow: RepoShadowFacts | undefined = sources.members !== true ? undefined : {
    counts: {
      "health.queuedtasks": (open ?? []).map((t) => t.id),
      "health.queued": (open ?? []).filter((t) => t.status === "queued").map((t) => t.id),
      "health.runs7d.succeeded": [...succeededTasks],
      "health.runs7d.failed": failedRows,
      "health.runs7d.superseded": supersededRows,
      "telemetry.subscription.calls7d": subCallRows,
    },
    sums: {
      "telemetry.tokens7d": { rows: sumRows.tokens },
      "telemetry.cache_read_tokens7d": { rows: sumRows.cacheRead },
      "telemetry.cash_usd_7d": { rows: sumRows.cash, precision: 0.01 },
      "telemetry.subscription.tokens7d": { rows: sumRows.subTokens },
    },
    lastRun: lastRunRow,
  };
  return {
    queuedtasks: open ? open.length : null,
    queued: open ? open.filter((t) => t.status === "queued").length : null,
    errorrate: succeeded + failed > 0 ? failed / (succeeded + failed) : null,
    runs7d: { succeeded, failed, superseded },
    last_run: lastRun,
    tokens7d: tokens,
    cache_read_tokens7d: cacheRead,
    cash_usd_7d: Math.round(cash * 100) / 100,
    subscription: {
      calls7d: subCalls,
      tokens7d: subTokens,
      windows: [...windows.values()].map((w) => w.value).sort((a, b) => `${a.provider}|${a.window}`.localeCompare(`${b.provider}|${b.window}`)),
    },
    modelsused: [...models].sort((a, b) => a.localeCompare(b)),
    ...(shadow ? { shadow } : {}),
  };
}

/** Operational condition from real signals; `reasons` names each signal that set it. */
export function deriveRepoCondition(t: RepoTelemetry, signals: RepoInstanceSignals | undefined, nowMs: number): { condition: RepoCondition; reasons: string[] } {
  if (t.runs7d === null) return { condition: "unknown", reasons: ["no ledger"] };
  const reasons: string[] = [];
  if (signals?.stopped || signals?.paused) return { condition: "paused", reasons: [signals.stopped ? "instance is stopped" : "instance is paused"] };
  if (signals) {
    const ageMs = signals.lastDaemonMs === null ? null : nowMs - signals.lastDaemonMs;
    if (ageMs === null || ageMs > DEFAULT_LIVENESS_BOUND_MS) {
      return { condition: "down", reasons: [signals.lastDaemonMs === null ? "no daemon heartbeat in the ledger" : `no daemon heartbeat since ${fixedClock(signals.lastDaemonMs).iso()}`] };
    }
    if (signals.alerts && signals.alerts.length > 0) reasons.push(`${signals.alerts.length} open incident(s)`);
  }
  const { succeeded, failed } = t.runs7d;
  if (failed > succeeded) reasons.push(`${failed} failed vs ${succeeded} succeeded runs in 7d`);
  if (reasons.length > 0) return { condition: "degraded", reasons };
  if (succeeded + failed === 0) return { condition: "idle", reasons: ["no finished run in 7d"] };
  return { condition: "healthy", reasons: [] };
}

function repoActions(own: boolean, signals: RepoInstanceSignals | undefined): RepoAction[] {
  const notOwn = "this instance does not operate the repository";
  const toggle: RepoAction = signals
    ? { id: "toggleonoff", available: true, method: "POST", path: signals.paused || signals.stopped ? "control/resume" : "control/pause", scope: "write" }
    : { id: "toggleonoff", available: false, reason: own ? "no fleet-control state was read for this instance" : notOwn };
  return [
    toggle,
    own ? { id: "viewlogs", available: true, method: "GET", path: "recent", scope: "read" } : { id: "viewlogs", available: false, reason: notOwn },
    { id: "configure", available: false, reason: NOT_COMPUTED.settings },
    { id: "test_run", available: false, reason: "core has no on-demand test-run endpoint" },
  ];
}

function toDashboardEntry(
  repo: ManagedRepo,
  t: RepoTelemetry,
  source: RepoDashboardEntry["source"],
  own: boolean,
  signals: RepoInstanceSignals | undefined,
  nowMs: number,
): RepoDashboardEntry {
  const id = `${repo.owner}/${repo.repo}`;
  const measured = t.runs7d !== null;
  const { condition, reasons } = deriveRepoCondition(t, signals, nowMs);
  return {
    id,
    reponame: repo.repo,
    repourl: `https://github.com/${id}`,
    connected_at: null,
    active: signals ? !(signals.paused || signals.stopped) : null,
    managed: true,
    source,
    health: {
      status: measured ? "verified" : "unknown",
      condition,
      reasons: signals?.alertsReason ? [...reasons, signals.alertsReason] : reasons,
      queuedtasks: t.queuedtasks,
      queued: t.queued,
      errorrate: t.errorrate,
      runs7d: t.runs7d,
      last_run: t.last_run,
      alerts: signals?.alerts ?? null,
    },
    telemetry: {
      measurementClass: measured ? "observed" : "not-collected",
      tokens7d: t.tokens7d,
      cache_read_tokens7d: t.cache_read_tokens7d,
      cash_usd_7d: t.cash_usd_7d,
      cost_7d: t.cash_usd_7d,
      subscription: t.subscription,
      modelsused: t.modelsused,
    },
    settings: { proofpolicy: null, workerpoolsize: null, alertthreshold: null },
    actions: repoActions(own, signals),
    not_computed: NOT_COMPUTED,
  };
}

/** How long one computed telemetry pass is served while its input stamps are unchanged; the seven-day window
 *  moves with the clock even when no input file does. */
export const REPO_TELEMETRY_CACHE_TTL_MS = 60_000;
/** PRIMARY CONTROL on recompute frequency: a pass younger than this is served even if an input stamp moved.
 *  The live ledger's stamp changes every 5-10s on the fleet (measured 2026-09-23), so stamp-keying alone missed
 *  on nearly every console poll; a telemetry figure 30s old is still an honest, age-marked answer. */
export const REPO_TELEMETRY_MIN_AGE_MS = 30_000;

const REPO_TELEMETRY_WORKER_KIND = "remudero-repo-telemetry" as const;

/** Plain data only: it crosses to the worker by structured clone. */
export interface RepoTelemetryRequest {
  kind: typeof REPO_TELEMETRY_WORKER_KIND;
  repos: ManagedRepo[];
  ledgerPath: string;
  planPath: string;
  nowMs: number;
  /** Index into `repos` of the repository this instance operates. */
  own?: number;
  /** The plan inputs' size and mtime: an unchanged stamp reuses the thread's last parse. */
  planStamp?: string;
  /** The instance's fleet-control root (PAUSE/STOP) and incident state directory. */
  controlRoot?: string;
  incidentsDir?: string;
  /** Also name each count's members, for the shadow comparator. */
  members?: boolean;
}

export interface RepoLedgerIndexMeta {
  filesRead: number;
  bytesRead: number;
  rows: number;
}

export type RepoTelemetryOutcome =
  | { ok: true; telemetry: RepoTelemetry[]; signals?: RepoInstanceSignals; index?: RepoLedgerIndexMeta }
  | { ok: false; reason: string };

type LedgerReader = (path: string) => readonly Row[] & { present?: boolean };

/** A plan or ledger read that failed: the console read cache reports its message as the staleness reason. */
export class RepoTelemetryUnavailableError extends RmdError {
  constructor(reason: string) {
    super("plan", 1, reason);
    this.name = "RepoTelemetryUnavailableError";
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readSignals(req: RepoTelemetryRequest, lastDaemonMs: number | null, control?: RepoSummaryFileReads["control"]): RepoInstanceSignals | undefined {
  if (req.own === undefined || req.controlRoot === undefined) return undefined;
  if (control) return { ...control, lastDaemonMs };
  const signals: RepoInstanceSignals = {
    paused: existsSync(pauseFilePath(req.controlRoot)),
    stopped: existsSync(stopFilePath(req.controlRoot)),
    lastDaemonMs,
    alerts: null,
  };
  if (req.incidentsDir === undefined) return signals;
  const store = readIncidentLifecycleStore(req.incidentsDir);
  if (!store.ok) return { ...signals, alertsReason: `incident store ${store.reason}` };
  signals.alerts = Object.values(store.store)
    .filter((r) => r.status !== "verified" && r.lastSeenMs >= req.nowMs - REPO_TELEMETRY_WINDOW_MS)
    .sort((a, b) => b.lastSeenMs - a.lastSeenMs)
    .slice(0, MAX_ALERTS)
    .map((r) => `${r.title} (${r.status}, ${r.count24h} in 24h)`.slice(0, 240));
  return signals;
}

const workerIndexes = new Map<string, RepoLedgerIndex>();
let planMemo: { key: string; plan: Plan } | undefined;

function loadPlanMemoized(path: string, stamp: string | undefined): Plan {
  const key = `${path}|${stamp}`;
  if (stamp !== undefined && planMemo?.key === key) return planMemo.plan;
  const plan = threadStrictPlan(path);
  planMemo = { key, plan };
  return plan;
}

/** The whole slow pass (ledger, plan, projection), run synchronously wherever it is called from. The default
 *  ledger read is this thread's incremental index; a failed read becomes a reason-carrying outcome, never a
 *  null field that reads as "no source". */
export function computeRepoTelemetrySync(
  req: RepoTelemetryRequest,
  readers: { readLedger?: LedgerReader; readPlan?: (path: string) => Plan; control?: RepoSummaryFileReads["control"] } = {},
): RepoTelemetryOutcome {
  let ledger: readonly Row[] | undefined;
  let lastDaemonMs: number | null = null;
  let index: RepoLedgerIndexMeta | undefined;
  try {
    if (readers.readLedger) {
      const read = readers.readLedger(req.ledgerPath);
      ledger = read.present === false ? undefined : read;
      lastDaemonMs = ledger ? lastDaemonHeartbeatMs(ledger) : null;
    } else {
      let idx = workerIndexes.get(req.ledgerPath);
      if (!idx) workerIndexes.set(req.ledgerPath, (idx = createRepoLedgerIndex(REPO_TELEMETRY_WINDOW_MS)));
      const pass = idx.refresh(req.ledgerPath, req.nowMs);
      ledger = pass.present ? pass.rows : undefined;
      lastDaemonMs = pass.lastDaemonMs ?? null;
      index = { filesRead: pass.filesRead, bytesRead: pass.bytesRead, rows: pass.rows.length };
    }
  } catch (err) {
    return { ok: false, reason: `ledger read failed: ${messageOf(err)}` };
  }
  if (ledger === undefined) return { ok: true, telemetry: req.repos.map(() => UNKNOWN), ...(index ? { index } : {}) };
  let plan: Plan | undefined;
  try {
    plan = readers.readPlan ? readers.readPlan(req.planPath) : loadPlanMemoized(req.planPath, req.planStamp);
  } catch (err) {
    return { ok: false, reason: `plan read failed: ${messageOf(err)}` };
  }
  const signals = readSignals(req, lastDaemonMs, readers.control);
  return {
    ok: true,
    telemetry: req.repos.map((repo, i) => projectRepoTelemetry(repo, { ledger, plan, nowMs: req.nowMs, own: i === req.own, members: req.members === true })),
    ...(signals ? { signals } : {}),
    ...(index ? { index } : {}),
  };
}

/** The worker branch's body, named so the parent can cover it: coverage instruments the parent thread only. */
export function serveRepoTelemetry(port: { on(event: "message", run: (msg: { id: number; req: RepoTelemetryRequest }) => void): unknown; postMessage(value: unknown): void } | null): void {
  port?.on("message", (msg) => {
    let outcome: RepoTelemetryOutcome;
    try {
      outcome = computeRepoTelemetrySync(msg.req);
    } catch (err) {
      outcome = { ok: false, reason: `repo telemetry failed: ${messageOf(err)}` };
    }
    port.postMessage({ id: msg.id, outcome });
  });
}

if (!isMainThread && (workerData as { kind?: unknown } | undefined)?.kind === REPO_TELEMETRY_WORKER_KIND) serveRepoTelemetry(parentPort);

/** One PERSISTENT worker per module URL, so its ledger index stays warm between passes and the serving event loop
 *  never parses the ledger. It respawns after it dies; every pending request settles exactly once. */
const telemetryWorkers = new Map<string, (req: RepoTelemetryRequest) => Promise<RepoTelemetryOutcome>>();

function startRepoTelemetryWorker(workerUrl: URL): (req: RepoTelemetryRequest) => Promise<RepoTelemetryOutcome> {
  let worker: Worker | undefined;
  let nextId = 1;
  const pending = new Map<number, (outcome: RepoTelemetryOutcome) => void>();
  const failAll = (from: Worker, reason: string): void => {
    if (from !== worker) return;
    for (const settle of pending.values()) settle({ ok: false, reason });
    pending.clear();
    worker = undefined;
  };
  const track = (): void => void (pending.size > 0 ? worker?.ref() : worker?.unref());
  return (req) =>
    new Promise((resolve) => {
      if (!worker) {
        try {
          const spawned = new Worker(workerUrl, { workerData: { kind: REPO_TELEMETRY_WORKER_KIND }, execArgv: process.execArgv });
          spawned.on("message", (msg: { id: number; outcome: RepoTelemetryOutcome }) => {
            const settle = pending.get(msg.id);
            pending.delete(msg.id);
            track();
            settle?.(msg.outcome);
          });
          spawned.on("error", (err) => failAll(spawned, `repo telemetry worker failed: ${messageOf(err)}`));
          spawned.on("exit", (code) => failAll(spawned, `repo telemetry worker exited with code ${code} before reporting`));
          worker = spawned;
        } catch (err) {
          resolve({ ok: false, reason: `repo telemetry worker could not start: ${messageOf(err)}` });
          return;
        }
      }
      const id = nextId++;
      pending.set(id, resolve);
      track();
      worker.postMessage({ id, req });
    });
}

/** Runs {@link computeRepoTelemetrySync} on the persistent worker for `workerUrl` (default: this module). */
export function computeRepoTelemetryOffThread(req: RepoTelemetryRequest, workerUrl?: URL): Promise<RepoTelemetryOutcome> {
  const url = workerUrl ?? new URL(import.meta.url);
  let run = telemetryWorkers.get(url.href);
  if (!run) telemetryWorkers.set(url.href, (run = startRepoTelemetryWorker(url)));
  return run(req);
}

async function statStamp(path: string): Promise<string> {
  try {
    const s = await stat(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch (err) {
    // An unstattable input is part of the key: the pass that reads it reports the read failure itself.
    return `unstattable:${(err as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
}

function statStampSync(path: string): string {
  try {
    const s = statSync(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch (err) {
    // An unstattable input is part of the key: the pass that reads it reports the read failure itself.
    return `unstattable:${(err as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
}

export interface RepoDashboardOptions {
  /** Repository root containing the managed-repos state file. */
  root: string;
  /** A validated gateway registry identity limits an instance route to its own ledger and plan. */
  instanceRepository?: ManagedRepo;
  /** The same repo-tracked registry path served by GET /v1/registry; optional for standalone callers. */
  repoRegistryPath?: string;
  /** The registry instance whose repository this serve operates when no `instanceRepository` is given. */
  ownInstance?: string;
  /** The instance's fleet-control root and incident state directory; absent = no pause or alert signals. */
  controlRoot?: string;
  incidentsDir?: string;
  /** Injectable clock for a stable generated_at and telemetry window in route tests. */
  clock?: Clock;
  /** The daemon ledger; omitted means every ledger-derived field stays null. */
  ledgerPath?: string;
  /** Defaults to `<root>/plan/tasks.yaml`; an unreadable plan makes the telemetry unavailable with its reason. */
  planPath?: string;
  /** Injected readers run the pass in-process; the defaults run it on a worker thread. */
  readLedger?: LedgerReader;
  readPlan?: (path: string) => Plan;
  /** Test seam: the module a spawned telemetry worker loads. */
  workerUrl?: URL;
  /** repoSummarySync also returns each own repository's {@link RepoShadowFacts}. */
  shadowMembers?: boolean;
  /** An earlier summary's file reads, replayed instead of reading those files now. */
  fileReads?: RepoSummaryFileReads;
}

type Identity = { repo: ManagedRepo; source: RepoDashboardEntry["source"]; own: boolean };
type RegistryRead = { state: "verified"; repos: Array<{ repo: ManagedRepo; name: string }> } | { state: "unavailable"; reason: string };
type Resolved = { identities: Identity[]; registry?: { state: "verified" } | { state: "unavailable"; reason: string }; managed: ManagedRepo[] };

/** An unreadable registry (`text` undefined) or a malformed one is unavailable with a reason. */
function parseRegistryRepos(text: string | undefined): RegistryRead {
  if (text === undefined) return { state: "unavailable", reason: "unreadable" };
  try {
    const parsed = parseInstanceRegistry(text);
    return {
      state: "verified",
      repos: parsed.instances.filter((instance) => instance.live).map((instance) => {
        const [owner, repo] = instance.repo.split("/");
        return { repo: { owner, repo }, name: instance.name };
      }),
    };
  } catch (error) {
    // Keep the known managed rows, but name the missing registry evidence. Never expose its
    // host path in a browser response or pretend core is absent from the fleet.
    return { state: "unavailable", reason: error instanceof InstanceRegistryError ? error.code : "unreadable" };
  }
}

function resolveIdentities(deps: RepoDashboardOptions, read: RegistryRead | undefined): Resolved {
  const managed = deps.instanceRepository ? [] : deps.fileReads?.managed ?? loadManagedRepos(deps.root);
  const registry: RegistryRead | undefined = deps.instanceRepository ? { state: "verified", repos: [{ repo: deps.instanceRepository, name: "" }] } : read;
  const byIdentity = new Map<string, Identity>();
  if (registry?.state === "verified") {
    for (const { repo, name } of registry.repos) {
      const key = `${repo.owner}/${repo.repo}`.toLowerCase();
      const own = deps.instanceRepository !== undefined || (deps.ownInstance !== undefined && name === deps.ownInstance);
      if (!byIdentity.has(key) || own) byIdentity.set(key, { repo, source: "instance-registry", own });
    }
  }
  for (const repo of managed) {
    const key = `${repo.owner}/${repo.repo}`.toLowerCase();
    if (!byIdentity.has(key)) byIdentity.set(key, { repo, source: "managed-repos", own: false });
  }
  return { identities: [...byIdentity.values()], ...(registry ? { registry: registry.state === "verified" ? { state: "verified" as const } : registry } : {}), managed };
}

function telemetryRequest(deps: RepoDashboardOptions, identities: Identity[], ledgerPath: string, planPath: string, planStamp: string, nowMs: number): RepoTelemetryRequest {
  const ownIndex = identities.findIndex((i) => i.own);
  return {
    kind: REPO_TELEMETRY_WORKER_KIND, repos: identities.map((i) => i.repo), ledgerPath, planPath, nowMs, planStamp,
    ...(ownIndex >= 0 ? { own: ownIndex } : {}),
    ...(deps.controlRoot !== undefined ? { controlRoot: deps.controlRoot } : {}),
    ...(deps.incidentsDir !== undefined ? { incidentsDir: deps.incidentsDir } : {}),
    ...(deps.shadowMembers ? { members: true } : {}),
  };
}

function dashboardResult(deps: RepoDashboardOptions, resolved: Resolved, outcome: RepoTelemetryOutcome | undefined, nowMs: number, onlyOwn: boolean): RepoDashboardResult {
  const { identities, registry } = resolved;
  const measured = outcome?.ok ? outcome : undefined;
  const rows = identities.map((identity, i) =>
    toDashboardEntry(identity.repo, measured?.telemetry[i] ?? UNKNOWN, identity.source, identity.own, identity.own ? measured?.signals : undefined, nowMs));
  return {
    generated_at: fixedClock(nowMs).iso(),
    source: deps.instanceRepository ? "instance-registry" : registry?.state === "verified" ? "instance-registry+managed-repos" : "managed-repos",
    ...(registry ? { registry } : {}),
    repos: onlyOwn ? rows.filter((_row, i) => identities[i].own) : rows,
  };
}

/**
 * `GET /v1/repos/summary`'s body computed synchronously in the calling thread, with the same identities,
 * telemetry and projection. The read-model worker calls it with `readLedger` over its `repo_row` table.
 * A failed telemetry pass is `{ ok: false, reason }`, where the route answers its read-cache error.
 */
export function repoSummarySync(deps: RepoDashboardOptions, nowMs: number):
  { ok: true; summary: RepoDashboardResult; shadow?: Record<string, RepoShadowFacts>; fileReads: RepoSummaryFileReads } | { ok: false; reason: string } {
  const planPath = deps.planPath ?? join(deps.root, "plan", "tasks.yaml");
  const replay = deps.fileReads;
  let text: string | undefined;
  if (deps.repoRegistryPath !== undefined && !deps.instanceRepository) {
    if (replay?.registry !== undefined) text = replay.registry ?? undefined;
    else {
      try {
        text = readFileSync(deps.repoRegistryPath, "utf8");
      } catch {
        // deliberate: an unreadable registry is named `unreadable` by parseRegistryRepos, as the route names it.
        text = undefined;
      }
    }
  }
  const resolved = resolveIdentities(deps, deps.repoRegistryPath !== undefined ? parseRegistryRepos(text) : undefined);
  const reads: RepoSummaryFileReads = { ...(deps.repoRegistryPath !== undefined && !deps.instanceRepository ? { registry: text ?? null } : {}), managed: resolved.managed };
  if (resolved.identities.length === 0 || deps.ledgerPath === undefined) return { ok: true, summary: dashboardResult(deps, resolved, undefined, nowMs, true), fileReads: reads };
  const planStamp = `${statStampSync(planPath)}|${statStampSync(join(dirname(planPath), "tasks.d"))}`;
  const request = telemetryRequest(deps, resolved.identities, deps.ledgerPath, planPath, planStamp, nowMs);
  const outcome = computeRepoTelemetrySync(request, { readLedger: deps.readLedger, readPlan: deps.readPlan, ...(replay?.control ? { control: replay.control } : {}) });
  if (!outcome.ok) return outcome;
  if (outcome.signals) {
    const { lastDaemonMs: _ledger, ...control } = outcome.signals;
    reads.control = control;
  }
  const shadow = Object.fromEntries(resolved.identities.flatMap((identity, i) => {
    const t = outcome.telemetry[i]!;
    const facts = identity.own ? t.shadow : undefined;
    const condition = (runs7d: RepoRunOutcomes): { condition: RepoCondition; reasons: string[] } => deriveRepoCondition({ ...t, runs7d }, outcome.signals, nowMs);
    return facts ? [[`${identity.repo.owner}/${identity.repo.repo}`, { ...facts, condition }]] : [];
  }));
  return { ok: true, summary: dashboardResult(deps, resolved, outcome, nowMs, true), ...(deps.shadowMembers ? { shadow } : {}), fileReads: reads };
}

/**
 * GET /v1/repos — connected instances plus the independent issue-intake managed set — and
 * GET /v1/repos/summary — the same projection for only the repository this instance operates, a few KB,
 * so a portfolio card needs neither the whole portfolio nor `/status`. Both share one cached pass.
 */
export function buildRepoDashboardRoutes(deps: RepoDashboardOptions): Route[] {
  const clock = deps.clock ?? systemClock;
  const planPath = deps.planPath ?? join(deps.root, "plan", "tasks.yaml");
  const inProcess = deps.readLedger !== undefined || deps.readPlan !== undefined;
  const compute = (req: RepoTelemetryRequest): Promise<RepoTelemetryOutcome> =>
    inProcess
      ? Promise.resolve(computeRepoTelemetrySync(req, { readLedger: deps.readLedger, readPlan: deps.readPlan }))
      : computeRepoTelemetryOffThread(req, deps.workerUrl);
  // ONE entry, keyed on every input's size and mtime, so the cache cannot grow with requests.
  let cached: { key: string; atMs: number; outcome: RepoTelemetryOutcome } | undefined;
  let inflight: { key: string; promise: Promise<{ atMs: number; outcome: RepoTelemetryOutcome }> } | undefined;
  const measure = async (identities: Identity[], ledgerPath: string): Promise<{ atMs: number; outcome: RepoTelemetryOutcome }> => {
    const repos = identities.map((i) => i.repo);
    const ownIndex = identities.findIndex((i) => i.own);
    const stamps = await Promise.all([ledgerPath, planPath, join(dirname(planPath), "tasks.d")].map(statStamp));
    const key = [repos.map((r) => `${r.owner}/${r.repo}`).join(","), ownIndex, ...stamps].join("|");
    const ageMs = cached ? clock.now() - cached.atMs : Number.POSITIVE_INFINITY;
    if (cached && (ageMs < REPO_TELEMETRY_MIN_AGE_MS || (cached.key === key && ageMs < REPO_TELEMETRY_CACHE_TTL_MS))) return cached;
    if (inflight && inflight.key === key) return inflight.promise;
    const atMs = clock.now();
    const promise = compute(telemetryRequest(deps, identities, ledgerPath, planPath, `${stamps[1]}|${stamps[2]}`, atMs)).then((outcome) => {
      cached = { key, atMs, outcome };
      return cached;
    });
    inflight = { key, promise };
    return promise.finally(() => {
      if (inflight?.promise === promise) inflight = undefined;
    });
  };
  const resolve = async (): Promise<Resolved> => {
    if (deps.instanceRepository || !deps.repoRegistryPath) return resolveIdentities(deps, undefined);
    let text: string | undefined;
    try {
      text = await readFile(deps.repoRegistryPath, "utf8");
    } catch {
      // deliberate: an unreadable registry is named `unreadable` by parseRegistryRepos, beside a malformed one.
      text = undefined;
    }
    return resolveIdentities(deps, parseRegistryRepos(text));
  };
  const project = async (onlyOwn: boolean): Promise<RepoDashboardResult> => {
    const resolved = await resolve();
    const measured = resolved.identities.length > 0 && deps.ledgerPath !== undefined ? await measure(resolved.identities, deps.ledgerPath) : undefined;
    if (measured && !measured.outcome.ok) throw new RepoTelemetryUnavailableError(measured.outcome.reason);
    return dashboardResult(deps, resolved, measured?.outcome, measured ? measured.atMs : clock.now(), onlyOwn);
  };
  return [
    { method: "GET", path: "/v1/repos", scope: "read", handler: async (_req, res) => sendJson(res, 200, await project(false)) },
    { method: "GET", path: "/v1/repos/summary", scope: "read", handler: async (_req, res) => sendJson(res, 200, await project(true)) },
  ];
}

/** GET /v1/repos alone, for standalone callers. */
export function buildRepoDashboardRoute(deps: RepoDashboardOptions): Route {
  return buildRepoDashboardRoutes(deps)[0];
}
