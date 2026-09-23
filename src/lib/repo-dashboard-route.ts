/**
 * The read-only managed-repository portfolio surface for the console dashboard.
 *
 * Each field is filled only from a source the daemon already holds (W1-T4103):
 * - `errorrate`, `last_run`: the repository's `verdict` rows (see {@link ERROR_VERDICTS}).
 * - `queuedtasks`: the repository's plan tasks with no merge credit in the ledger.
 * - `tokens7d`, `cost_7d`: the repository's worker rows inside the trailing seven days.
 * A row names its repository by its own `repo`, else through its run's `run.start` row.
 * `connected_at`, `active` and every setting stay `null`: the managed-repos file records only
 * identities and no config key holds a per-repo policy, pool size or alert threshold. An absent
 * ledger leaves its fields `null`, never `0`; a FAILED plan or ledger read is unavailable with its reason.
 */

import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import type { Route } from "./service.js";
import { sendJson } from "./panel-actions.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { RmdError } from "./errors.js";
import { loadManagedRepos, type ManagedRepo } from "./managed-repos.js";
import { loadPlan, type Plan } from "./plan.js";
import { isMergeCreditLine, readLedgerUnionBounded } from "./status.js";

export interface RepoDashboardHealth {
  status: "unknown";
  queuedtasks: number | null;
  errorrate: number | null;
  last_run: string | null;
  alerts: null;
}

export interface RepoDashboardTelemetry {
  tokens7d: number | null;
  modelsused: [];
  cost_7d: number | null;
}

export interface RepoDashboardSettings {
  proofpolicy: null;
  workerpoolsize: null;
  alertthreshold: null;
}

export interface RepoDashboardEntry {
  id: string;
  reponame: string;
  repourl: string;
  connected_at: null;
  active: null;
  managed: true;
  source: "managed-repos";
  health: RepoDashboardHealth;
  telemetry: RepoDashboardTelemetry;
  settings: RepoDashboardSettings;
}

export interface RepoDashboardResult {
  generated_at: string;
  source: "managed-repos";
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

type Row = Record<string, unknown>;

export interface RepoTelemetry {
  queuedtasks: number | null;
  errorrate: number | null;
  last_run: string | null;
  tokens7d: number | null;
  cost_7d: number | null;
}

const UNKNOWN: RepoTelemetry = { queuedtasks: null, errorrate: null, last_run: null, tokens7d: null, cost_7d: null };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function namesRepo(value: string | undefined, repo: ManagedRepo): boolean {
  return value === `${repo.owner}/${repo.repo}` || value === repo.repo;
}

/** Worker rows carry `billing_mode` beside `total_cost_usd` (worker.ts's workerLedgerFields). A
 *  `cost.anomaly` row restates worker costs; a `verdict` row never reaches this test (see caller). */
function isWorkerCostRow(row: Row): boolean {
  return row.step !== "cost.anomaly" && str(row.billing_mode) !== undefined && typeof row.total_cost_usd === "number";
}

function tokenTotal(row: Row): number {
  const t = row.tokens;
  if (!t || typeof t !== "object") return 0;
  const tokens = t as Row;
  return num(tokens.input) + num(tokens.output) + num(tokens.cacheRead) + num(tokens.cacheCreation);
}

/** Pure projection of one repository's telemetry. `ledger` undefined = no ledger source; `plan`
 *  undefined = no plan source. */
export function projectRepoTelemetry(
  repo: ManagedRepo,
  sources: { ledger?: readonly Row[]; plan?: Plan; nowMs: number },
): RepoTelemetry {
  const { ledger, plan, nowMs } = sources;
  if (!ledger) return UNKNOWN;
  const runRepo = new Map<string, string>();
  const credited = new Set<string>();
  for (const row of ledger) {
    const runId = str(row.run_id);
    const named = str(row.repo);
    if (row.step === "run.start" && runId && named) runRepo.set(runId, named);
    if (isMergeCreditLine(row) && typeof row.task_id === "string") credited.add(row.task_id);
  }
  const windowStart = nowMs - REPO_TELEMETRY_WINDOW_MS;
  let lastRunMs = -Infinity;
  let lastRun: string | null = null;
  let errors = 0;
  let decided = 0;
  let tokens = 0;
  let cost = 0;
  for (const row of ledger) {
    const owner = str(row.repo) ?? runRepo.get(str(row.run_id) ?? "");
    if (!namesRepo(owner, repo)) continue;
    const ts = Date.parse(str(row.ts) ?? "");
    if (!Number.isFinite(ts)) continue;
    const inWindow = ts >= windowStart && ts <= nowMs;
    if (row.step === "verdict") {
      if (ts > lastRunMs) [lastRunMs, lastRun] = [ts, str(row.ts)!];
      const verdict = str(row.verdict) ?? "";
      if (inWindow && ERROR_VERDICTS.has(verdict)) errors += 1;
      if (inWindow && (ERROR_VERDICTS.has(verdict) || SUCCESS_VERDICTS.has(verdict))) decided += 1;
    } else if (inWindow && isWorkerCostRow(row)) {
      // `else`: a verdict row restates its run's worker total, so it never adds to the sum.
      tokens += tokenTotal(row);
      cost += num(row.total_cost_usd);
    }
  }
  const open = plan?.tasks.filter((t) =>
    namesRepo(t.repo, repo) && t.status !== "merged" && t.status !== "done" && t.retirement === undefined
    && !credited.has(t.id));
  return {
    queuedtasks: open ? open.length : null,
    errorrate: decided > 0 ? errors / decided : null,
    last_run: lastRun,
    tokens7d: tokens,
    cost_7d: cost,
  };
}

function toDashboardEntry(repo: ManagedRepo, t: RepoTelemetry): RepoDashboardEntry {
  const id = `${repo.owner}/${repo.repo}`;
  return {
    id,
    reponame: repo.repo,
    repourl: `https://github.com/${id}`,
    connected_at: null,
    active: null,
    managed: true,
    source: "managed-repos",
    health: {
      status: "unknown",
      queuedtasks: t.queuedtasks,
      errorrate: t.errorrate,
      last_run: t.last_run,
      alerts: null,
    },
    telemetry: {
      tokens7d: t.tokens7d,
      modelsused: [],
      cost_7d: t.cost_7d,
    },
    settings: {
      proofpolicy: null,
      workerpoolsize: null,
      alertthreshold: null,
    },
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
}

export type RepoTelemetryOutcome = { ok: true; telemetry: RepoTelemetry[] } | { ok: false; reason: string };

type LedgerReader = (path: string) => readonly Row[] & { present?: boolean };

/** A plan or ledger read that failed: the console read cache reports its message as the staleness reason. */
export class RepoTelemetryUnavailableError extends RmdError {
  constructor(reason: string) {
    super("plan", 1, reason);
    this.name = "RepoTelemetryUnavailableError";
  }
}

function isRepoTelemetryRequest(v: unknown): v is RepoTelemetryRequest {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === REPO_TELEMETRY_WORKER_KIND;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The whole slow pass (ledger union, plan, projection), run synchronously wherever it is called from. A failed
 *  read becomes a reason-carrying outcome, never a null field that reads as "no source". */
export function computeRepoTelemetrySync(
  req: RepoTelemetryRequest,
  readers: { readLedger?: LedgerReader; readPlan?: (path: string) => Plan } = {},
): RepoTelemetryOutcome {
  let ledger: readonly Row[] | undefined;
  try {
    const read = (readers.readLedger ?? readLedgerUnionBounded)(req.ledgerPath);
    ledger = read.present === false ? undefined : read;
  } catch (err) {
    return { ok: false, reason: `ledger read failed: ${messageOf(err)}` };
  }
  if (ledger === undefined) return { ok: true, telemetry: req.repos.map(() => UNKNOWN) };
  let plan: Plan | undefined;
  try {
    plan = (readers.readPlan ?? loadPlan)(req.planPath);
  } catch (err) {
    return { ok: false, reason: `plan read failed: ${messageOf(err)}` };
  }
  return { ok: true, telemetry: req.repos.map((repo) => projectRepoTelemetry(repo, { ledger, plan, nowMs: req.nowMs })) };
}

/** The worker branch's body, named so the parent can cover it: coverage instruments the parent thread only. */
export function postRepoTelemetryWorkerResponse(port: { postMessage: (value: unknown) => void } | null, req: RepoTelemetryRequest): void {
  port?.postMessage(computeRepoTelemetrySync(req));
}

if (!isMainThread && isRepoTelemetryRequest(workerData)) postRepoTelemetryWorkerResponse(parentPort, workerData);

/** Runs {@link computeRepoTelemetrySync} on a worker thread so the serving event loop never parses the ledger. Every
 *  terminal path resolves exactly once, and a dead worker is an unavailable outcome with its reason. */
export function computeRepoTelemetryOffThread(req: RepoTelemetryRequest, workerUrl?: URL): Promise<RepoTelemetryOutcome> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(workerUrl ?? new URL(import.meta.url), { workerData: req, execArgv: process.execArgv });
    } catch (err) {
      resolve({ ok: false, reason: `repo telemetry worker could not start: ${messageOf(err)}` });
      return;
    }
    let settled = false;
    const settle = (outcome: RepoTelemetryOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
      void worker.terminate();
    };
    worker.once("message", (msg: RepoTelemetryOutcome) => settle(msg));
    worker.once("error", (err) => settle({ ok: false, reason: `repo telemetry worker failed: ${messageOf(err)}` }));
    worker.once("exit", (code) => settle({ ok: false, reason: `repo telemetry worker exited with code ${code} before reporting` }));
  });
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

/** GET /v1/repos — the validated, read-only managed-repo portfolio. */
export function buildRepoDashboardRoute(deps: {
  /** Repository root containing the managed-repos state file. */
  root: string;
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
}): Route {
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
  const measure = async (repos: ManagedRepo[], ledgerPath: string): Promise<{ atMs: number; outcome: RepoTelemetryOutcome }> => {
    const stamps = await Promise.all([ledgerPath, planPath, join(dirname(planPath), "tasks.d")].map(statStamp));
    const key = [repos.map((r) => `${r.owner}/${r.repo}`).join(","), ...stamps].join("|");
    const ageMs = cached ? clock.now() - cached.atMs : Number.POSITIVE_INFINITY;
    if (cached && (ageMs < REPO_TELEMETRY_MIN_AGE_MS || (cached.key === key && ageMs < REPO_TELEMETRY_CACHE_TTL_MS))) return cached;
    if (inflight && inflight.key === key) return inflight.promise;
    const atMs = clock.now();
    const promise = compute({ kind: REPO_TELEMETRY_WORKER_KIND, repos, ledgerPath, planPath, nowMs: atMs }).then((outcome) => {
      cached = { key, atMs, outcome };
      return cached;
    });
    inflight = { key, promise };
    return promise.finally(() => {
      if (inflight?.promise === promise) inflight = undefined;
    });
  };
  return {
    method: "GET",
    path: "/v1/repos",
    scope: "read",
    handler: async (_req, res) => {
      const managed = loadManagedRepos(deps.root);
      const measured = managed.length > 0 && deps.ledgerPath !== undefined ? await measure(managed, deps.ledgerPath) : undefined;
      if (measured && !measured.outcome.ok) throw new RepoTelemetryUnavailableError(measured.outcome.reason);
      const telemetry = measured?.outcome.ok ? measured.outcome.telemetry : managed.map(() => UNKNOWN);
      const body: RepoDashboardResult = {
        generated_at: measured ? fixedClock(measured.atMs).iso() : clock.iso(),
        source: "managed-repos",
        repos: managed.map((repo, i) => toDashboardEntry(repo, telemetry[i])),
      };
      sendJson(res, 200, body);
    },
  };
}
