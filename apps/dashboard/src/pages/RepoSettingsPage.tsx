import { useState } from "react";

import { REPO_API_ENDPOINTS } from "../api/repoTelemetry";
import { useRepoSettings } from "../hooks/useRepoSettings";
import { useRepos } from "../hooks/useRepos";
import type { ProofPolicy } from "../types/repo";
import { navigate } from "./navigation";

export function RepoSettingsPage({ repoId }: { readonly repoId: string }) {
  const { allRepos } = useRepos();
  const repo = allRepos.find((candidate) => candidate.id === repoId) ?? null;
  const { settings, updateSettings } = useRepoSettings(repoId);
  const [notice, setNotice] = useState<string | null>(null);
  if (repo === null || settings === null) {
    return <p className="empty-state" role="status">Repository not found in local state. Reconnect it from onboarding.</p>;
  }

  return (
    <div className="repo-page">
      <div className="page-toolbar">
        <button type="button" onClick={() => navigate(`/repos/${repo.id}`)}>← {repo.reponame}</button>
      </div>
      <section className="settings-panel" aria-labelledby="repo-settings-heading">
        <p className="eyebrow">Repository settings</p>
        <h1 id="repo-settings-heading">{repo.reponame}</h1>
        <p className="muted">These controls update the local scaffold. Persistence is reserved for the settings API.</p>
        {notice === null ? null : <p className="inline-notice" role="status">{notice}</p>}
        <form onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const workerPoolSize = Number(form.get("workerpoolsize"));
          const alertThreshold = Number(form.get("alertthreshold"));
          if (!Number.isInteger(workerPoolSize) || workerPoolSize < 1 || workerPoolSize > 32) {
            setNotice("Worker pool size must be a whole number from 1 to 32.");
            return;
          }
          if (!Number.isFinite(alertThreshold) || alertThreshold < 0 || alertThreshold > 100) {
            setNotice("Alert threshold must be between 0 and 100 percent.");
            return;
          }
          updateSettings({
            proofpolicy: form.get("proofpolicy") as ProofPolicy,
            workerpoolsize: workerPoolSize,
            alertthreshold: alertThreshold / 100,
          });
          setNotice("Saved locally. The daemon endpoint is not wired yet.");
        }}>
          <label>
            Proof policy
            <select name="proofpolicy" defaultValue={settings.proofpolicy}>
              <option value="strict">Strict</option>
              <option value="balanced">Balanced</option>
              <option value="permissive">Permissive</option>
            </select>
          </label>
          <label>
            Worker pool size
            <input name="workerpoolsize" type="number" min="1" max="32" defaultValue={settings.workerpoolsize} />
          </label>
          <label>
            Alert threshold (%)
            <input name="alertthreshold" type="number" min="0" max="100" step="1" defaultValue={settings.alertthreshold * 100} />
          </label>
          <button type="submit">Save settings</button>
        </form>
        <p className="source-note">Placeholder: <code>{REPO_API_ENDPOINTS.settings.replace(":id", repo.id)}</code></p>
      </section>
    </div>
  );
}
