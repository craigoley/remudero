/**
 * The read-only managed-repository portfolio surface for the console dashboard.
 *
 * Each field is filled only from a source the daemon already holds (W1-T4103):
 * - `errorrate`, `last_run`: the repository's `verdict` rows (see {@link ERROR_VERDICTS}).
 * - `queuedtasks`: the repository's plan tasks with no merge credit in the ledger.
 * - `tokens7d`, `cost_7d`: the repository's worker rows inside the trailing seven days.
 * A row names its repository by its own `repo`, else through its run's `run.start` row.
 * `connected_at`, `active` and every setting stay `null`: the managed-repos file records only
 * identities and no config key holds a per-repo policy, pool size or alert threshold. An
 * unavailable source leaves its fields `null`, never `0`.
 */

import { join } from "node:path";
import type { Route } from "./service.js";
import { sendJson } from "./panel-actions.js";
import { systemClock, type Clock } from "./clock.js";
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

/** GET /v1/repos — the validated, read-only managed-repo portfolio. */
export function buildRepoDashboardRoute(deps: {
  /** Repository root containing the managed-repos state file. */
  root: string;
  /** Injectable clock for a stable generated_at and telemetry window in route tests. */
  clock?: Clock;
  /** The daemon ledger; omitted means every ledger-derived field stays null. */
  ledgerPath?: string;
  /** Defaults to `<root>/plan/tasks.yaml`; an unreadable plan leaves `queuedtasks` null. */
  planPath?: string;
  /** Defaults to the bounded newest-first union of the live ledger and its rotations. */
  readLedger?: (path: string) => readonly Row[] & { present?: boolean };
  readPlan?: (path: string) => Plan;
}): Route {
  const clock = deps.clock ?? systemClock;
  const readLedger = deps.readLedger ?? ((path: string) => readLedgerUnionBounded(path));
  const readPlan = deps.readPlan ?? ((path: string) => loadPlan(path));
  const planPath = deps.planPath ?? join(deps.root, "plan", "tasks.yaml");
  return {
    method: "GET",
    path: "/v1/repos",
    scope: "read",
    handler: (_req, res) => {
      const managed = loadManagedRepos(deps.root);
      let ledger: readonly Row[] | undefined;
      let plan: Plan | undefined;
      if (managed.length > 0 && deps.ledgerPath !== undefined) {
        const read = readLedger(deps.ledgerPath);
        ledger = read.present === false ? undefined : read;
        try {
          plan = readPlan(planPath);
        } catch {
          // An unreadable plan leaves queuedtasks null (unknown), never a zero count.
          plan = undefined;
        }
      }
      const nowMs = clock.now();
      const repos = managed.map((repo) => toDashboardEntry(repo, projectRepoTelemetry(repo, { ledger, plan, nowMs })));
      const body: RepoDashboardResult = {
        generated_at: clock.iso(),
        source: "managed-repos",
        repos,
      };
      sendJson(res, 200, body);
    },
  };
}
