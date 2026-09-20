import type { Repo, RepoAction } from "../types/repo";

function healthLabel(repo: Repo): string {
  if (repo.health.status === "unknown") return "Unknown";
  return repo.health.status[0].toUpperCase() + repo.health.status.slice(1);
}

function errorRateLabel(errorRate: number | null): string {
  return errorRate === null ? "—" : `${Math.round(errorRate * 100)}%`;
}

export function RepoCard({
  repo,
  onSelect,
  onToggle,
  onAction,
}: {
  readonly repo: Repo;
  readonly onSelect: (repoId: string) => void;
  readonly onToggle: (repo: Repo) => void;
  readonly onAction: (repo: Repo, action: RepoAction) => void;
}) {
  return (
    <article className="repo-card" data-testid={`repo-card-${repo.id}`}>
      <div className="repo-card__heading">
        <div>
          <button className="repo-card__name" type="button" onClick={() => onSelect(repo.id)}>
            {repo.reponame}
          </button>
          <a className="repo-card__url" href={repo.repourl} target="_blank" rel="noreferrer">
            {repo.repourl}
          </a>
        </div>
        <span className={`health-badge health-badge--${repo.health.status}`} role="status">
          {healthLabel(repo)}
        </span>
      </div>

      {repo.health.alerts.length > 0 ? (
        <ul className="repo-card__alerts" aria-label={`${repo.reponame} alerts`}>
          {repo.health.alerts.slice(0, 2).map((alert) => (
            <li className={`alert alert--${alert.severity}`} key={alert.id}>
              {alert.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="repo-card__quiet">No active alerts</p>
      )}

      <dl className="repo-card__metrics">
        <div>
          <dt>Queued tasks</dt>
          <dd>{repo.health.queuedtasks ?? "—"}</dd>
        </div>
        <div>
          <dt>Error rate</dt>
          <dd>{errorRateLabel(repo.health.errorrate)}</dd>
        </div>
        <div>
          <dt>Last run</dt>
          <dd>{repo.health.last_run === null ? "—" : new Date(repo.health.last_run).toLocaleString()}</dd>
        </div>
      </dl>

      <div className="repo-card__footer">
        <span className={`repo-activity ${repo.active ? "repo-activity--on" : "repo-activity--off"}`}>
          {repo.active ? "Active" : "Inactive"}
        </span>
        <div className="repo-card__actions" aria-label={`${repo.reponame} actions`}>
          <button type="button" onClick={() => onToggle(repo)}>
            {repo.active ? "Turn off" : "Turn on"}
          </button>
          <button type="button" onClick={() => onAction(repo, "configure")}>Configure</button>
          <button type="button" onClick={() => onAction(repo, "test_run")}>Test run</button>
        </div>
      </div>
    </article>
  );
}
