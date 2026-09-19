# Repo dashboard research

Checked 2026-09-19 against public product documentation. This is a design input for the
`apps/dashboard` repo-management scaffold; it is not evidence that the current Remudero daemon
already exposes the repo or telemetry API named below.

## Observed patterns

| Product | Organization | Health and alerts | Repo-specific route/settings |
| --- | --- | --- | --- |
| [GitHub Copilot usage metrics](https://docs.github.com/en/copilot/how-tos/administer-copilot/view-usage-and-adoption) | Organization or enterprise insights dashboard with trend charts; the public docs describe aggregate and repository-level report data, not a repo-card UI. | Adoption, active users, language/model usage, and pull-request activity; repository rows are daily and inactive repos may be omitted. Data can lag by up to three UTC days. | Drill down through Insights/Copilot usage and export/API reports; repository-level reporting is documented as API-only in the metrics reference. |
| [Argo CD ApplicationSets](https://argo-cd.readthedocs.io/en/latest/user-guide/application-set-ui/) and [private repositories](https://argo-cd.readthedocs.io/en/release-3.4/user-guide/private-repositories/) | Searchable list with filters and a tile/table switch; filters include project, namespace, labels, and health. | Health and sync icons are repeated in the list/tree; the detail status bar summarizes health and condition severity. Conditions and events explain errors. | Selecting an item opens a detail view with summary, manifest, events, and preview. Repository credentials are configured through `Settings/Repositories`. |
| [Buildkite dashboard walkthrough](https://buildkite.com/docs/pipelines/dashboard-walkthrough) | Pipeline list with search, tags, active/archived state, and optional team filter; bookmarking keeps important pipelines visible. | Latest default-branch status icon, 30-build history, speed, reliability, and builds/week. Notifications can route failures to email, Slack, PagerDuty, GitHub, or webhooks. | Select a pipeline for build history and branches; settings are top-right and expose repository/default-branch configuration. |
| [Vercel projects](https://vercel.com/docs/projects) and [managing deployments](https://vercel.com/docs/deployments/managing-deployments) | Team dashboard lists projects; each project groups deployments and domains for one connected Git repository. | Production/pre-production deployment status, commit, URL, logs, analytics, and observability are shown inside the project. Deployments filter by branch, date, environment, and status. | Selecting a project opens its dashboard; settings cover domains, environment variables, deployment protection, and observability. |
| [Fly.io monitoring](https://fly.io/docs/monitoring/) and [logging overview](https://fly.io/docs/monitoring/logging-overview/) | Apps are the primary navigation unit; each app has its own dashboard and metrics tab. | Built-in Prometheus metrics, managed Grafana dashboards, live log tail, and searchable logs. The documented log search retention is seven days. | Open an app dashboard, then move into metrics, logs, or settings; programmatic logs are app-scoped. |

## Design decisions for Remudero

These decisions are inferred from the observed patterns and Remudero's existing API boundary:

1. Use a searchable, filterable list as the primary portfolio view, with responsive cards as the
   compact rendering. Argo CD and Buildkite show that status comparison and search matter more than
   a decorative grid alone.
2. Put one health badge, queued-task count, error rate, last-run timestamp, and alert summary on
   every card. Put models, seven-day tokens, seven-day cost, and trends in the detail view so the
   card stays scannable.
3. Make alerts actionable and repo-scoped. A warning belongs above the metrics and links to logs or
   settings; an absent read is `unknown`, never a green/zero value.
4. Route `/repos/:id` to the detail view and `/repos/:id/settings` to settings. This follows the
   project drill-down shape in Argo, Buildkite, Vercel, and Fly.io.
5. Keep OAuth, repo discovery, telemetry, settings persistence, logs, and dry-run execution behind
   typed endpoint placeholders until the daemon OpenAPI contract grows. The browser continues to
   call the api-client boundary; it does not hand-roll requests.

## Onboarding sequence

The scaffold follows the common source-control connection shape: authorize the provider, choose a
repository, configure behavior, run a safe preview, then activate. In this branch, the OAuth,
GitHub repository list, dry-run, and persistence steps are deliberately labeled placeholders. The
only live state change is an in-memory local repo record after explicit confirmation.
