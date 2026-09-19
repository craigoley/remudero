export const REPO_HEALTH_STATUSES = ["healthy", "degraded", "error", "unknown"] as const;
export type RepoHealthStatus = (typeof REPO_HEALTH_STATUSES)[number];

export const PROOF_POLICIES = ["strict", "balanced", "permissive"] as const;
export type ProofPolicy = (typeof PROOF_POLICIES)[number];

export const REPO_TASK_TYPES = ["bugs", "chores", "features", "perf"] as const;
export type RepoTaskType = (typeof REPO_TASK_TYPES)[number];

export type RepoAction = "toggleon/off" | "configure" | "viewlogs" | "test_run";

export interface RepoAlert {
  readonly id: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly created_at: string;
}

export interface RepoHealth {
  readonly status: RepoHealthStatus;
  readonly queuedtasks: number | null;
  /** A fraction from 0 to 1, or null when the source did not provide a measurement. */
  readonly errorrate: number | null;
  readonly last_run: string | null;
  readonly alerts: readonly RepoAlert[];
}

export interface RepoTelemetryPoint {
  readonly day: string;
  readonly tokens: number;
  readonly cost: number;
}

export interface RepoTelemetry {
  readonly tokens7d: number | null;
  readonly modelsused: readonly string[];
  readonly cost7d: number | null;
  readonly points: readonly RepoTelemetryPoint[];
  readonly observed_at: string | null;
}

export interface RepoSettings {
  readonly proofpolicy: ProofPolicy;
  readonly workerpoolsize: number;
  readonly alertthreshold: number;
}

export interface Repo {
  readonly id: string;
  readonly reponame: string;
  readonly repourl: string;
  readonly connected_at: string;
  readonly active: boolean;
  readonly health: RepoHealth;
  readonly telemetry: RepoTelemetry;
  readonly settings: RepoSettings;
  readonly actions: readonly RepoAction[];
  readonly task_types: readonly RepoTaskType[];
}

export const UNKNOWN_REPO_TELEMETRY: RepoTelemetry = {
  tokens7d: null,
  modelsused: [],
  cost7d: null,
  points: [],
  observed_at: null,
};

export const DEFAULT_REPO_SETTINGS: RepoSettings = {
  proofpolicy: "balanced",
  workerpoolsize: 2,
  alertthreshold: 0.1,
};

export function makeRepo(input: Pick<Repo, "id" | "reponame" | "repourl"> & Partial<Omit<Repo, "id" | "reponame" | "repourl">>): Repo {
  return {
    id: input.id,
    reponame: input.reponame,
    repourl: input.repourl,
    connected_at: input.connected_at ?? new Date(0).toISOString(),
    active: input.active ?? false,
    health: input.health ?? {
      status: "unknown",
      queuedtasks: null,
      errorrate: null,
      last_run: null,
      alerts: [],
    },
    telemetry: input.telemetry ?? UNKNOWN_REPO_TELEMETRY,
    settings: input.settings ?? DEFAULT_REPO_SETTINGS,
    actions: input.actions ?? ["toggleon/off", "configure", "viewlogs", "test_run"],
    task_types: input.task_types ?? [],
  };
}
