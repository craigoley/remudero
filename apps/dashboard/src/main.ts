// apps/dashboard/src/main.ts
//
// The read-only live board's browser entry point (W3-T2, MASTER-PLAN §7 shell 0). Renders
// the task/ledger-state snapshot from GET /v1/status and keeps it live via GET
// /v1/status/stream -- both via @remudero/api-client, the ONLY way this file talks to the
// daemon (MASTER-PLAN §7A; scripts/no-hand-rolled-fetch-check.mjs enforces zero direct
// fetch/axios/XHR calls here).
//
// v0 narrow slice (the W3-T2 decision): task states only. The other MASTER-PLAN §7 design
// panels (plan-doc render, worker stream tails, DECISIONS feed, escalation inbox, question
// backlog, cost meter) are explicit follow-on work, not this file's concern.
//
// Connection config (baseUrl/token) has no real UI yet -- read from `?daemon=`/`?token=`
// query params. This is a placeholder wired for local/tailnet testing, not a production
// credential story (a bearer token belongs in a query string even less than in
// localStorage) -- W3-T5's human-in-the-loop actions tier is where real auth UX lands.
// Wiring the daemon to actually SERVE this static page over Tailscale is itself deferred
// follow-on work; today the page is opened directly against a daemon reachable at `?daemon=`.
import { createDaemonClient, type StatusProjection, type StatusSnapshot } from "@remudero/api-client/client";

function readConfig(): { baseUrl: string; token: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    baseUrl: params.get("daemon") ?? "http://localhost:4317",
    token: params.get("token") ?? "",
  };
}

function statusLabel(p: StatusProjection): string {
  return p.merged ? `${p.status} ✓` : p.status;
}

function prCell(p: StatusProjection): string {
  if (!p.prUrl) return "";
  const label = p.prNumber !== undefined ? `#${p.prNumber}` : p.prUrl;
  return `<a href="${p.prUrl}" target="_blank" rel="noreferrer">${label}</a>`;
}

function rowHtml(p: StatusProjection): string {
  return `<td>${p.taskId}</td><td>${statusLabel(p)}</td><td>${prCell(p)}</td>`;
}

/** Full initial render: one row per task in the snapshot, sorted by task id. */
export function render(root: HTMLElement, tasks: StatusProjection[]): void {
  const sorted = [...tasks].sort((a, b) => a.taskId.localeCompare(b.taskId));
  const rows = sorted.map((p) => `<tr data-task-id="${p.taskId}">${rowHtml(p)}</tr>`).join("");
  root.innerHTML = `<table><thead><tr><th>Task</th><th>Status</th><th>PR</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** A live `status` event: update the one row it names in place (insert if new). */
export function applyUpdate(root: HTMLElement, projection: StatusProjection): void {
  const body = root.querySelector("tbody");
  if (!body) return;
  const existing = body.querySelector<HTMLTableRowElement>(`tr[data-task-id="${projection.taskId}"]`);
  if (existing) {
    existing.innerHTML = rowHtml(projection);
    return;
  }
  const row = document.createElement("tr");
  row.dataset.taskId = projection.taskId;
  row.innerHTML = rowHtml(projection);
  body.appendChild(row);
}

/** Boot the board into `root`: initial snapshot, then live updates. Returns an unsubscribe. */
export async function boot(root: HTMLElement): Promise<() => void> {
  const client = createDaemonClient(readConfig());
  const snapshot: StatusSnapshot = await client.getStatus();
  render(root, snapshot.tasks);
  return client.subscribeStatus((projection) => applyUpdate(root, projection));
}

if (typeof document !== "undefined") {
  const root = document.getElementById("board");
  if (root) void boot(root);
}
