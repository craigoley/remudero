import { useState } from "react";

import { REPO_API_ENDPOINTS } from "../api/repoTelemetry";
import { useRepoSettings } from "../hooks/useRepoSettings";
import { useRepoTelemetry } from "../hooks/useRepoTelemetry";
import type { RepoAction } from "../types/repo";
import type { Repo } from "../types/repo";

function money(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(2)}`;
}

export function RepoDetail({
  repo,
  onAction,
}: {
  readonly repo: Repo;
  readonly onAction: (action: RepoAction) => void;
}) {
  const telemetry = useRepoTelemetry(repo.id);
  const { settings, updateSettings } = useRepoSettings(repo.id);
  const [message, setMessage] = useState<string | null>(null);
  const currentTelemetry = telemetry.response?.telemetry ?? repo.telemetry;
  return (
    <section className="repo-detail" aria-labelledby="repo-detail-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Repository detail</p>
          <h2 id="repo-detail-heading">{repo.reponame}</h2>
          <a href={repo.repourl} target="_blank" rel="noreferrer">{repo.repourl}</a>
        </div>
        <span className={`health-badge health-badge--${repo.health.status}`}>{repo.health.status}</span>
      </div>

      {message === null ? null : <p className="inline-notice" role="status">{message}</p>}
      <div className="detail-grid">
        <section className="detail-panel" aria-labelledby="detail-health-heading">
          <h3 id="detail-health-heading">Health</h3>
          <dl className="metric-list">
            <div><dt>Queued tasks</dt><dd>{repo.health.queuedtasks ?? "—"}</dd></div>
            <div><dt>Error rate</dt><dd>{repo.health.errorrate === null ? "—" : `${Math.round(repo.health.errorrate * 100)}%`}</dd></div>
            <div><dt>Last run</dt><dd>{repo.health.last_run ?? "—"}</dd></div>
          </dl>
          {repo.health.alerts.length === 0 ? <p className="muted">No active alerts.</p> : (
            <ul className="alert-list">{repo.health.alerts.map((alert) => <li key={alert.id}>{alert.message}</li>)}</ul>
          )}
        </section>

        <section className="detail-panel" aria-labelledby="detail-telemetry-heading">
          <h3 id="detail-telemetry-heading">Telemetry · last 7 days</h3>
          {telemetry.loading ? <p className="muted">Loading telemetry…</p> : null}
          {telemetry.response?.status === "unavailable" ? (
            <p className="unknown-state" role="status">Telemetry unavailable — {telemetry.response.reason}</p>
          ) : null}
          {telemetry.error === null ? null : <p className="error-text" role="alert">Telemetry read failed — {telemetry.error}</p>}
          <dl className="metric-list">
            <div><dt>Tokens</dt><dd>{currentTelemetry.tokens7d ?? "—"}</dd></div>
            <div><dt>Spend</dt><dd>{money(currentTelemetry.cost7d)}</dd></div>
            <div><dt>Models</dt><dd>{currentTelemetry.modelsused.length === 0 ? "—" : currentTelemetry.modelsused.join(", ")}</dd></div>
          </dl>
          <div className="trend-bars" aria-label="Token spend trend">
            {currentTelemetry.points.map((point) => <span key={point.day} style={{ height: `${Math.max(4, Math.min(100, point.tokens / 100))}%` }} title={`${point.day}: ${point.tokens} tokens`} />)}
          </div>
          <p className="source-note">Source placeholder: <code>{REPO_API_ENDPOINTS.telemetry}</code></p>
        </section>

        <section className="detail-panel" aria-labelledby="detail-settings-heading">
          <h3 id="detail-settings-heading">Settings</h3>
          {settings === null ? <p className="muted">No settings loaded.</p> : (
            <dl className="metric-list">
              <div><dt>Proof policy</dt><dd>{settings.proofpolicy}</dd></div>
              <div><dt>Worker pool</dt><dd>{settings.workerpoolsize}</dd></div>
              <div><dt>Alert threshold</dt><dd>{Math.round(settings.alertthreshold * 100)}%</dd></div>
            </dl>
          )}
          <button type="button" onClick={() => {
            updateSettings({ proofpolicy: settings?.proofpolicy === "strict" ? "balanced" : "strict" });
            setMessage("Settings updated in local state; persistence endpoint is still pending.");
          }}>Toggle proof policy</button>
        </section>
      </div>

      <div className="repo-detail__actions" aria-label="Repository actions">
        <button type="button" onClick={() => onAction("viewlogs")}>View logs</button>
        <button type="button" onClick={() => onAction("test_run")}>Run dry-run test</button>
        <button type="button" onClick={() => onAction("toggleon/off")}>{repo.active ? "Turn off" : "Turn on"}</button>
      </div>
      <p className="source-note">Settings endpoint placeholder: <code>{REPO_API_ENDPOINTS.settings.replace(":id", repo.id)}</code></p>
    </section>
  );
}
