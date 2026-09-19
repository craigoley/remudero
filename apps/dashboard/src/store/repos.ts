import type { Repo, RepoHealthStatus, RepoSettings } from "../types/repo";

export type RepoSort = "name" | "health" | "queuedtasks" | "last_run";

export interface RepoStoreState {
  readonly repos: readonly Repo[];
  readonly search: string;
  readonly filter: RepoHealthStatus | "all";
  readonly sort: RepoSort;
  readonly selectedRepoId: string | null;
}

export type RepoStoreAction =
  | { readonly type: "list"; readonly repos: readonly Repo[] }
  | { readonly type: "filter"; readonly search?: string; readonly filter?: RepoHealthStatus | "all"; readonly sort?: RepoSort }
  | { readonly type: "select"; readonly repoId: string | null }
  | { readonly type: "update"; readonly repoId: string; readonly patch: RepoPatch };

export interface RepoPatch {
  readonly active?: boolean;
  readonly health?: Partial<Repo["health"]>;
  readonly telemetry?: Repo["telemetry"];
  readonly settings?: Partial<RepoSettings>;
  readonly task_types?: Repo["task_types"];
}

export const EMPTY_REPO_STORE: RepoStoreState = {
  repos: [],
  search: "",
  filter: "all",
  sort: "name",
  selectedRepoId: null,
};

function updateRepo(repo: Repo, patch: RepoPatch): Repo {
  return {
    ...repo,
    ...(patch.active === undefined ? {} : { active: patch.active }),
    ...(patch.health === undefined ? {} : { health: { ...repo.health, ...patch.health } }),
    ...(patch.telemetry === undefined ? {} : { telemetry: patch.telemetry }),
    ...(patch.settings === undefined ? {} : { settings: { ...repo.settings, ...patch.settings } }),
    ...(patch.task_types === undefined ? {} : { task_types: patch.task_types }),
  };
}

export function reduceRepoStore(state: RepoStoreState, action: RepoStoreAction): RepoStoreState {
  switch (action.type) {
    case "list":
      return {
        ...state,
        repos: [...action.repos],
        selectedRepoId:
          state.selectedRepoId !== null && action.repos.some((repo) => repo.id === state.selectedRepoId)
            ? state.selectedRepoId
            : action.repos[0]?.id ?? null,
      };
    case "filter":
      return {
        ...state,
        ...(action.search === undefined ? {} : { search: action.search }),
        ...(action.filter === undefined ? {} : { filter: action.filter }),
        ...(action.sort === undefined ? {} : { sort: action.sort }),
      };
    case "select":
      return { ...state, selectedRepoId: action.repoId };
    case "update":
      return {
        ...state,
        repos: state.repos.map((repo) => (repo.id === action.repoId ? updateRepo(repo, action.patch) : repo)),
      };
  }
}

const HEALTH_ORDER: Record<RepoHealthStatus, number> = { error: 0, degraded: 1, unknown: 2, healthy: 3 };

export function selectRepos(state: RepoStoreState): readonly Repo[] {
  const query = state.search.trim().toLowerCase();
  return [...state.repos]
    .filter((repo) => state.filter === "all" || repo.health.status === state.filter)
    .filter((repo) => query === "" || `${repo.reponame} ${repo.repourl}`.toLowerCase().includes(query))
    .sort((a, b) => {
      if (state.sort === "health") return HEALTH_ORDER[a.health.status] - HEALTH_ORDER[b.health.status];
      if (state.sort === "queuedtasks") return (b.health.queuedtasks ?? -1) - (a.health.queuedtasks ?? -1);
      if (state.sort === "last_run") return (b.health.last_run ?? "").localeCompare(a.health.last_run ?? "");
      return a.reponame.localeCompare(b.reponame);
    });
}

export class RepoStore {
  private state: RepoStoreState;
  private readonly listeners = new Set<() => void>();

  constructor(initial: RepoStoreState = EMPTY_REPO_STORE) {
    this.state = initial;
  }

  getState = (): RepoStoreState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispatch(action: RepoStoreAction): void {
    this.state = reduceRepoStore(this.state, action);
    for (const listener of this.listeners) listener();
  }

  list(repos: readonly Repo[]): void {
    this.dispatch({ type: "list", repos });
  }

  filter(value: { readonly search?: string; readonly filter?: RepoHealthStatus | "all"; readonly sort?: RepoSort }): void {
    this.dispatch({ type: "filter", ...value });
  }

  select(repoId: string | null): void {
    this.dispatch({ type: "select", repoId });
  }

  update(repoId: string, patch: RepoPatch): void {
    this.dispatch({ type: "update", repoId, patch });
  }
}

export function createRepoStore(initialRepos: readonly Repo[] = []): RepoStore {
  const store = new RepoStore();
  if (initialRepos.length > 0) store.list(initialRepos);
  return store;
}

export const repoStore = createRepoStore();
