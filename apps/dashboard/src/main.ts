// apps/dashboard/src/main.ts
//
// The control panel's browser entry point: the W3-T2 read-only live board (GET /v1/status +
// GET /v1/status/stream) plus the W3-T5 human-in-the-loop WRITE actions (MASTER-PLAN §7
// "editing capability tiers" -- answer questions, approve MANUAL items, Pause/Resume/STOP,
// quiet-hours toggle). Both talk to the daemon ONLY via @remudero/api-client (MASTER-PLAN
// §7A; scripts/no-hand-rolled-fetch-check.mjs enforces zero direct fetch/axios/XHR calls
// here) -- the write actions call the SAME client instance the board reads from, since
// DaemonClientOptions carries one token and the daemon's write scope is a superset of read
// (src/lib/service.ts).
//
// v0 narrow slice: task states + the six panel-action controls, wired to global fleet
// actions and free-text task-id/answer/issue-url forms (there is no rendered question/MANUAL
// BACKLOG to click an item in yet -- W3-T2 explicitly deferred that listing, and rendering it
// is this task's own dependency's concern, not this one's; see this task's PR body). The
// other MASTER-PLAN §7 design panels (plan-doc render, worker stream tails, DECISIONS feed,
// cost meter) remain explicit follow-on work.
//
// W3-T6 (MASTER-PLAN §7B) adds the plan->task->PR graph + interactive plan adjustment: the
// feedback inbox (`renderInbox`/`refreshInbox`), submit feedback / answer a grill (the SAME
// form, via a `replyTo` field a "Answer" button on a `grilling` row populates), accept/reject
// a `proposed` entry, and the provenance graph for any task or feedback id (`renderTraceGraph`,
// over `rmd trace`'s own chain, W1-T43). "Re-prioritize" (the design doc's fourth interactive
// action) has no backing mechanism anywhere in the plan schema yet (lib/plan.ts's `Task` names
// no priority/ordering field) -- out of scope here, same split lib/panel-graph.ts's own header
// documents.
//
// Connection config (baseUrl/token) has no real UI yet -- read from `?daemon=`/`?token=`
// query params. This is a placeholder wired for local/tailnet testing, not a production
// credential story (a bearer token belongs in a query string even less than in
// localStorage) -- real auth UX is later work. The token must be WRITE-scoped for the
// controls below to succeed; a read-only token still loads the board but every action gets a
// 403 from the daemon, surfaced in `#controls-status` like any other action failure.
// Wiring the daemon to actually SERVE this static page over Tailscale is itself deferred
// follow-on work; today the page is opened directly against a daemon reachable at `?daemon=`.
import {
  createDaemonClient,
  type DaemonClient,
  type FeedbackEntry,
  type StatusProjection,
  type StatusSnapshot,
  type TraceChain,
} from "@remudero/api-client/client";

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

// ── W3-T5: human-in-the-loop panel actions ──────────────────────────────────────────────────

/** Get a required control element by id, or throw -- these ids are hard-coded in index.html, so a missing one is a wiring bug, not a runtime condition to swallow. */
function requiredEl<T extends HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`wireControls: missing #${id} -- index.html/main.ts drifted`);
  return el as T;
}

/** Render the outcome of one panel action into the status line: success is quiet-but-visible, failure names what failed and why (FAIL LOUD -- the same discipline the daemon-side routes hold). */
function showResult(status: HTMLElement, action: string, outcome: { ok: true } | { ok: false; error: Error }): void {
  if (outcome.ok) {
    status.textContent = `${action}: done.`;
    status.dataset.state = "ok";
  } else {
    status.textContent = `${action} FAILED: ${outcome.error.message}`;
    status.dataset.state = "error";
  }
}

/**
 * Wrap an action handler: run it, report success/failure via {@link showResult}, and never let
 * a rejected promise escape as an unhandled rejection (a click is user input, not a place to
 * crash the page). `onSuccess` (e.g. clearing a form) only runs when the daemon call actually
 * succeeded -- a failed submit must leave the operator's input in place to retry, not silently
 * discard it.
 */
function runAction(status: HTMLElement, action: string, fn: () => Promise<unknown>, onSuccess?: () => void): void {
  void fn()
    .then(() => {
      showResult(status, action, { ok: true });
      onSuccess?.();
    })
    .catch((error: unknown) => showResult(status, action, { ok: false, error: error instanceof Error ? error : new Error(String(error)) }));
}

/**
 * Wire the fleet-control buttons, the quiet-hours toggle, and the answer/approve forms in
 * `doc` to `client`'s write methods (W3-T5). Pure DOM wiring -- every actual daemon call goes
 * through `client`, never a hand-rolled HTTP call of its own (scripts/no-hand-rolled-fetch-check.mjs).
 */
export function wireControls(doc: Document, client: DaemonClient): void {
  const status = requiredEl<HTMLElement>(doc, "controls-status");
  const reasonInput = requiredEl<HTMLInputElement>(doc, "control-reason");

  requiredEl<HTMLButtonElement>(doc, "pause-btn").addEventListener("click", () => {
    runAction(status, "Pause", () => client.pauseFleet(reasonInput.value.trim() || undefined));
  });
  requiredEl<HTMLButtonElement>(doc, "resume-btn").addEventListener("click", () => {
    runAction(status, "Resume", () => client.resumeFleet());
  });
  requiredEl<HTMLButtonElement>(doc, "stop-btn").addEventListener("click", () => {
    runAction(status, "STOP", () => client.stopFleet(reasonInput.value.trim() || undefined));
  });

  const quietHoursToggle = requiredEl<HTMLInputElement>(doc, "quiet-hours-toggle");
  quietHoursToggle.addEventListener("change", () => {
    runAction(status, "Quiet hours", () => client.setQuietHours(quietHoursToggle.checked));
  });

  requiredEl<HTMLFormElement>(doc, "answer-question-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const taskId = requiredEl<HTMLInputElement>(doc, "answer-task-id");
    const answer = requiredEl<HTMLInputElement>(doc, "answer-text");
    runAction(
      status,
      "Answer",
      () => client.answerQuestion(taskId.value, answer.value),
      () => {
        taskId.value = "";
        answer.value = "";
      },
    );
  });

  requiredEl<HTMLFormElement>(doc, "approve-manual-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const taskId = requiredEl<HTMLInputElement>(doc, "approve-task-id");
    const issueUrl = requiredEl<HTMLInputElement>(doc, "approve-issue-url");
    runAction(
      status,
      "Approve",
      () => client.approveManualItem(taskId.value, issueUrl.value),
      () => {
        taskId.value = "";
        issueUrl.value = "";
      },
    );
  });
}

// ── W3-T6: the plan→task→PR graph + interactive plan adjustment (MASTER-PLAN §7B) ──────────
//
// The panel's front door onto the feedback inbox (plan/feedback/, W1-T40) and the provenance
// graph (`rmd trace`, W1-T43) — submit feedback (always origin=ui), answer a grill (the SAME
// submit form, via `replyTo`), accept/reject a `proposed` entry, and render the plan→task→PR
// chain for any task or feedback id. Every write goes through the SAME api-client instance
// wireControls already uses (DaemonClientOptions carries one token; the daemon's write scope
// is a superset of read).

/** Escape untrusted text (a feedback entry's own free-form `raw`) before it lands in innerHTML. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** One inbox row: id/status/origin/raw, plus whatever action its status affords. */
function inboxRowHtml(entry: FeedbackEntry): string {
  const actions: string[] = [];
  if (entry.status === "proposed") {
    actions.push(`<button type="button" class="decide-accept" data-id="${entry.id}">Accept</button>`);
    actions.push(`<button type="button" class="decide-reject" data-id="${entry.id}">Reject</button>`);
  }
  if (entry.status === "grilling") {
    actions.push(`<button type="button" class="answer-grill" data-id="${entry.id}">Answer</button>`);
  }
  return (
    `<li data-feedback-id="${entry.id}">` +
    `<strong>${entry.id}</strong> [${entry.status}, origin=${entry.origin}] — ${escapeHtml(entry.raw)}` +
    (entry.proposal_pr ? ` <a href="${entry.proposal_pr}" target="_blank" rel="noreferrer">proposal PR</a>` : "") +
    (actions.length ? ` ${actions.join(" ")}` : "") +
    `</li>`
  );
}

/** Full inbox render: one `<li>` per entry, oldest first (the order the daemon already returns them in). */
export function renderInbox(root: HTMLElement, entries: FeedbackEntry[]): void {
  root.innerHTML = entries.length ? `<ul>${entries.map(inboxRowHtml).join("")}</ul>` : "<p>(inbox is empty)</p>";
}

/** One `TraceRun` node — a `<li>`, its PR (if any) nested beneath it. */
function traceRunHtml(run: TraceChain["tasks"][number]["runs"][number]): string {
  const verdict = run.verdict ? `verdict=${run.verdict}` : "no verdict yet";
  const pr = run.prUrl
    ? `<ul><li><a href="${run.prUrl}" target="_blank" rel="noreferrer">PR</a>${run.prState ? ` [${run.prState}]` : ""} — sha ${run.mergeSha ?? "(not merged yet)"}</li></ul>`
    : "";
  return `<li>run ${run.runId}: ${verdict}${pr}</li>`;
}

/** One `TraceTaskNode` — a `<li>` naming the task, its runs nested beneath it. */
function traceTaskHtml(task: TraceChain["tasks"][number]): string {
  const runs = task.runs.length ? `<ul>${task.runs.map(traceRunHtml).join("")}</ul>` : "<ul><li>(no runs yet)</li></ul>";
  return `<li>task ${task.id}: ${escapeHtml(task.title)}${task.origin ? ` (origin: ${task.origin})` : ""}${runs}</li>`;
}

/** Render a {@link TraceChain} as a nested `<ul>` — the panel's plan→task→PR graph. */
export function renderTraceGraph(root: HTMLElement, chain: TraceChain): void {
  const tasks = chain.tasks.length ? `<ul>${chain.tasks.map(traceTaskHtml).join("")}</ul>` : "<p>(no tasks yet)</p>";
  const feedback = chain.feedback
    ? `<p>feedback#${chain.feedback.id} [${chain.feedback.status}] — ${escapeHtml(chain.feedback.raw)}${
        chain.feedback.proposalPr ? ` → <a href="${chain.feedback.proposalPr}" target="_blank" rel="noreferrer">proposal PR</a>` : ""
      }</p>`
    : "";
  root.innerHTML = `<p>direction: ${chain.direction}</p>${feedback}${tasks}`;
}

/** Fetch the current inbox and render it into `#inbox-list`, wiring each row's accept/reject/answer buttons. */
async function refreshInbox(doc: Document, client: DaemonClient, status: HTMLElement): Promise<void> {
  const inboxRoot = requiredEl<HTMLElement>(doc, "inbox-list");
  const { entries } = await client.listFeedback();
  renderInbox(inboxRoot, entries);

  inboxRoot.querySelectorAll<HTMLButtonElement>(".decide-accept, .decide-reject").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id ?? "";
      const decision = btn.classList.contains("decide-accept") ? "accept" : "reject";
      runAction(status, `Decide ${id}`, () => client.decideProposal(id, decision), () => void refreshInbox(doc, client, status));
    });
  });
  inboxRoot.querySelectorAll<HTMLButtonElement>(".answer-grill").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id ?? "";
      const replyTo = requiredEl<HTMLInputElement>(doc, "submit-feedback-reply-to");
      const banner = requiredEl<HTMLElement>(doc, "submit-feedback-reply-banner");
      const cancel = requiredEl<HTMLButtonElement>(doc, "submit-feedback-cancel-reply");
      replyTo.value = id;
      banner.textContent = `Answering feedback#${id} — your text below is submitted as an answer.`;
      banner.hidden = false;
      cancel.hidden = false;
    });
  });
}

/** Wire the feedback-inbox + submit-feedback + trace-graph controls in `doc` to `client` (W3-T6). */
export function wireFeedbackPanel(doc: Document, client: DaemonClient): void {
  const status = requiredEl<HTMLElement>(doc, "feedback-status");
  void refreshInbox(doc, client, status);

  requiredEl<HTMLButtonElement>(doc, "submit-feedback-cancel-reply").addEventListener("click", () => {
    requiredEl<HTMLInputElement>(doc, "submit-feedback-reply-to").value = "";
    requiredEl<HTMLElement>(doc, "submit-feedback-reply-banner").hidden = true;
    requiredEl<HTMLButtonElement>(doc, "submit-feedback-cancel-reply").hidden = true;
  });

  requiredEl<HTMLFormElement>(doc, "submit-feedback-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = requiredEl<HTMLInputElement>(doc, "submit-feedback-text");
    const attachment = requiredEl<HTMLInputElement>(doc, "submit-feedback-attachment");
    const replyTo = requiredEl<HTMLInputElement>(doc, "submit-feedback-reply-to");
    const banner = requiredEl<HTMLElement>(doc, "submit-feedback-reply-banner");
    const cancel = requiredEl<HTMLButtonElement>(doc, "submit-feedback-cancel-reply");
    runAction(
      status,
      "Submit feedback",
      () =>
        client.submitFeedback(text.value, {
          attachments: attachment.value.trim() ? [attachment.value.trim()] : undefined,
          replyTo: replyTo.value.trim() || undefined,
        }),
      () => {
        text.value = "";
        attachment.value = "";
        replyTo.value = "";
        banner.hidden = true;
        cancel.hidden = true;
        void refreshInbox(doc, client, status);
      },
    );
  });

  requiredEl<HTMLFormElement>(doc, "trace-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const idInput = requiredEl<HTMLInputElement>(doc, "trace-id");
    const graphRoot = requiredEl<HTMLElement>(doc, "trace-graph");
    runAction(status, "Trace", async () => {
      const { chain } = await client.getTrace(idInput.value.trim());
      renderTraceGraph(graphRoot, chain);
    });
  });
}

if (typeof document !== "undefined") {
  const root = document.getElementById("board");
  if (root) void boot(root);
  if (document.getElementById("controls")) {
    wireControls(document, createDaemonClient(readConfig()));
  }
  if (document.getElementById("feedback")) {
    wireFeedbackPanel(document, createDaemonClient(readConfig()));
  }
}
