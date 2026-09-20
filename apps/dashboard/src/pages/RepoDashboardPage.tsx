import { useState } from "react";

import { REPO_API_ENDPOINTS } from "../api/repoTelemetry";
import { RepoDetail } from "../components/RepoDetail";
import { RepoList } from "../components/RepoList";
import { useRepos } from "../hooks/useRepos";
import type { RepoAction } from "../types/repo";
import { navigate } from "./navigation";

export function RepoDashboardPage({ repoId = null }: { readonly repoId?: string | null }) {
  const { allRepos, select, update } = useRepos();
  const selected = repoId === null ? null : allRepos.find((repo) => repo.id === repoId) ?? null;
  const [notice, setNotice] = useState<string | null>(null);

  const action = (id: string, kind: RepoAction) => {
    if (kind === "toggleon/off") update(id, { active: !(allRepos.find((repo) => repo.id === id)?.active ?? false) });
    if (kind === "configure") navigate(`/repos/${id}/settings`);
    if (kind === "viewlogs") setNotice(`Log API placeholder — ${REPO_API_ENDPOINTS.logs.replace(":id", id)} is not wired yet.`);
    if (kind === "test_run") setNotice(`Dry-run API placeholder — ${REPO_API_ENDPOINTS.dryRun.replace(":id", id)} is not wired yet.`);
  };

  if (selected !== null) {
    return (
      <div className="repo-page">
      <div className="page-toolbar">
          <button type="button" onClick={() => navigate("/repos")}>← All repositories</button>
          <button type="button" onClick={() => navigate(`/repos/${selected.id}/settings`)}>Settings</button>
      </div>
        {notice === null ? null : <p className="inline-notice" role="status">{notice}</p>}
        <RepoDetail repo={selected} onAction={(kind) => action(selected.id, kind)} />
      </div>
    );
  }

  return (
    <div className="repo-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Repo management</p>
          <h1>Repositories</h1>
          <p className="muted">A portfolio view for connected repos, health, worker settings, and spend telemetry.</p>
        </div>
        <button type="button" onClick={() => navigate("/onboard")}>Connect repository</button>
      </div>
      {notice === null ? null : <p className="inline-notice" role="status">{notice}</p>}
      <RepoList onSelect={(id) => { select(id); navigate(`/repos/${id}`); }} onAction={action} />
    </div>
  );
}
