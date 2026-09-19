import { useMemo } from "react";

import { repoStore, type RepoStore } from "../store/repos";
import type { RepoSettings } from "../types/repo";
import { useRepos } from "./useRepos";

export function useRepoSettings(repoId: string | null, store: RepoStore = repoStore) {
  const { allRepos } = useRepos(store);
  const repo = allRepos.find((candidate) => candidate.id === repoId) ?? null;
  const settings = repo?.settings ?? null;
  const updateSettings = useMemo(
    () => (patch: Partial<RepoSettings>) => {
      if (repoId !== null) store.update(repoId, { settings: patch });
    },
    [repoId, store],
  );
  return { settings, updateSettings, persisted: false };
}
