/**
 * The read-only managed-repository portfolio surface for the console dashboard.
 *
 * This route deliberately reports only what the daemon can observe today: the validated
 * validated managed-repository manifest set. A repository being listed there is not proof that GitHub
 * OAuth completed, that a worker is active, or that health/telemetry/settings have a value. Those
 * fields stay explicit `null`/`unknown` until their durable sources and refresh semantics exist.
 */

import type { Route } from "./service.js";
import { sendJson } from "./panel-actions.js";
import { loadManagedRepos } from "./managed-repos.js";

export interface RepoDashboardHealth {
  status: "unknown";
  queuedtasks: null;
  errorrate: null;
  last_run: null;
  alerts: null;
}

export interface RepoDashboardTelemetry {
  tokens7d: null;
  modelsused: [];
  cost_7d: null;
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

function toDashboardEntry(owner: string, repo: string): RepoDashboardEntry {
  const id = `${owner}/${repo}`;
  return {
    id,
    reponame: repo,
    repourl: `https://github.com/${id}`,
    connected_at: null,
    active: null,
    managed: true,
    source: "managed-repos",
    health: {
      status: "unknown",
      queuedtasks: null,
      errorrate: null,
      last_run: null,
      alerts: null,
    },
    telemetry: {
      tokens7d: null,
      modelsused: [],
      cost_7d: null,
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
  /** Repository root containing the managed-repository manifest. */
  root: string;
  /** Injectable clock for a stable generated_at in route tests. */
  now?: () => number;
}): Route {
  return {
    method: "GET",
    path: "/v1/repos",
    scope: "read",
    handler: (_req, res) => {
      const repos = loadManagedRepos(deps.root).map(({ owner, repo }) => toDashboardEntry(owner, repo));
      const body: RepoDashboardResult = {
        generated_at: new Date((deps.now ?? Date.now)()).toISOString(),
        source: "managed-repos",
        repos,
      };
      sendJson(res, 200, body);
    },
  };
}
