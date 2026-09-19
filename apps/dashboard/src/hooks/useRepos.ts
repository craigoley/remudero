import { useSyncExternalStore } from "react";

import { repoStore, selectRepos, type RepoStore } from "../store/repos";

export function useRepos(store: RepoStore = repoStore) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const repos = selectRepos(state);
  const selectedRepo = state.repos.find((repo) => repo.id === state.selectedRepoId) ?? null;
  return {
    ...state,
    allRepos: state.repos,
    repos,
    selectedRepo,
    list: store.list.bind(store),
    setFilter: store.filter.bind(store),
    select: store.select.bind(store),
    update: store.update.bind(store),
  };
}
