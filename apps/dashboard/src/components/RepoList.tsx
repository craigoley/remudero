import { useRepos } from "../hooks/useRepos";
import type { RepoAction, RepoHealthStatus } from "../types/repo";
import { RepoCard } from "./RepoCard";

const FILTERS: readonly (RepoHealthStatus | "all")[] = ["all", "healthy", "degraded", "error", "unknown"];

export function RepoList({
  onSelect,
  onAction,
}: {
  readonly onSelect: (repoId: string) => void;
  readonly onAction: (repoId: string, action: RepoAction) => void;
}) {
  const { repos, search, filter, sort, setFilter, update } = useRepos();
  return (
    <section className="repo-list" aria-labelledby="repo-list-heading">
      <div className="repo-list__toolbar">
        <div>
          <h2 id="repo-list-heading">Connected repositories</h2>
          <p className="muted">One card per repo. Unknown values stay visible until the daemon reports them.</p>
        </div>
        <label>
          <span className="visually-hidden">Search repositories</span>
          <input
            aria-label="Search repositories"
            type="search"
            placeholder="Search repos"
            value={search}
            onChange={(event) => setFilter({ search: event.target.value })}
          />
        </label>
      </div>
      <div className="repo-list__filters" role="group" aria-label="Repository filters">
        <label>
          Health
          <select value={filter} onChange={(event) => setFilter({ filter: event.target.value as RepoHealthStatus | "all" })}>
            {FILTERS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label>
          Sort
          <select value={sort} onChange={(event) => setFilter({ sort: event.target.value as "name" | "health" | "queuedtasks" | "last_run" })}>
            <option value="name">Name</option>
            <option value="health">Health</option>
            <option value="queuedtasks">Queued tasks</option>
            <option value="last_run">Last run</option>
          </select>
        </label>
      </div>
      {repos.length === 0 ? (
        <div className="empty-state" role="status">
          <strong>No repositories match this view.</strong>
          <span>Connect a GitHub account or clear the search and health filter.</span>
        </div>
      ) : (
        <div className="repo-grid">
          {repos.map((repo) => (
            <RepoCard
              key={repo.id}
              repo={repo}
              onSelect={onSelect}
              onToggle={(candidate) => update(candidate.id, { active: !candidate.active })}
              onAction={(candidate, action) => onAction(candidate.id, action)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
