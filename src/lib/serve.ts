/**
 * lib/serve.ts — `rmd serve`'s assembler: the FRONT DOOR (W1-T139, MASTER-PLAN §7/§7B).
 *
 * board.ts's own header named exactly this gap: "Real `rmd serve` CLI wiring (registering
 * these routes on a live createService(...) instance, with a real ghGateway) is a later
 * task's concern" — panel-actions.ts and panel-graph.ts's headers say the same. That later
 * task is this one. This module wires ZERO new business logic — it is a thin layer over the
 * FOUR already-proven modules (service.ts's mechanism, board.ts's read side, panel-actions.ts's
 * write side, panel-graph.ts's graph) plus one new thing this task actually owns: a minimal
 * HTML shell at `GET /` and the tiny bit of CLI glue (port resolution, token persistence) a
 * launchable command needs. Every route below is REUSED verbatim from its own module's
 * exported builder — never reimplemented (task design note).
 *
 * TWO ROOTS, ONE `PanelActionDeps` SHAPE (verified from source, not assumed): panel-actions.ts's
 * six routes all take a `PanelActionDeps` with a single `root` field, but that field backs TWO
 * genuinely different filesystem locations elsewhere in this codebase:
 *   - `requestPause`/`requestStop`/`resumeFleet`/`setQuietHours` (fleet-control.ts) read/write
 *     `<root>/state/{STOP,PAUSE,QUIET_HOURS}` — and MUST agree with what `rmd daemon`/`rmd
 *     drain` check (`stopDetail(config.root)` etc., run-task.ts's daemonCommand) or a panel
 *     STOP would write a flag file the real daemon never looks at.
 *   - `appendQuestionAnswer` (worker.ts, only `buildAnswerQuestionRoute` calls it) writes
 *     `<root>/plan/questions.ndjson` — and MUST agree with where `appendQuestion` (the QUESTION
 *     side of the SAME contract, run-task.ts) writes, which is `repoRoot` (the git tree), not
 *     `config.root` — else "THE ANSWER FLOWS TO THE ARCHITECT" (panel-actions.ts's own header)
 *     would silently land in a file nothing reads.
 * `config.root` and `repoRoot` are NOT the same directory by default (config.root defaults to
 * `~/Remudero`, a workspace; repoRoot is the git checkout serve runs from) — one shared `root`
 * cannot satisfy both correctly. Since every `build*Route` function takes its own independent
 * `PanelActionDeps`, {@link buildServeRoutes} passes TWO differently-rooted instances: a
 * `fleetControlRoot`-rooted one for pause/resume/stop/quiet-hours/approve-manual, and a
 * `questionsRoot`-rooted one for answer-question alone — both share the SAME `ledgerPath`
 * (every module's `panel.*`/`daemon.*` ledger lines always live under config.root, unambiguous
 * everywhere else in this codebase).
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { Server } from "node:http";
import { createService, type Route, type ServiceOptions, type ServiceTokens } from "./service.js";
import { buildRecentRoute, buildStatusRoute, buildStatusStream, DEFAULT_POLL_MS, type BoardDeps } from "./board.js";
import type { GitHub } from "./status.js";
import {
  buildAnswerQuestionRoute,
  buildApproveManualRoute,
  buildControlStatusRoute,
  buildPauseRoute,
  buildQuietHoursRoute,
  buildResumeRoute,
  buildStopRoute,
  type IssueCloser,
  type PanelActionDeps,
} from "./panel-actions.js";
import { buildPanelGraphRoutes, type PanelGraphDeps } from "./panel-graph.js";

/** Default `rmd serve` port — matches apps/dashboard/src/main.ts's own `?daemon=` default (`http://localhost:4317`), so the shipped dashboard points at a served daemon out of the box. */
export const DEFAULT_SERVE_PORT = 4317;

export interface ServeDeps {
  board: BoardDeps;
  /**
   * `plan/feedback/` + `plan/tasks.yaml` root and GitHub trace gateway (panel-graph.ts).
   * Deliberately `Omit<..., "inboxRoot">` — {@link buildServeRoutes} supplies `inboxRoot`
   * itself (= `fleetControlRoot`, config.root) the SAME way it already splits `fleetControlRoot`
   * vs `questionsRoot` for panel-actions.ts, so a `ServeDeps` caller names each root exactly
   * once, never a duplicate that could drift from `fleetControlRoot`.
   */
  panelGraph: Omit<PanelGraphDeps, "inboxRoot">;
  /** `<root>/state/ledger.ndjson` — SAME path board.ts tails and every panel route ledgers into. */
  ledgerPath: string;
  /** `gh issue close` gateway shared by every panel-actions write route that needs it. */
  issues: IssueCloser;
  /** Fleet-control flag-file root — MUST equal the `config.root` `rmd daemon`/`rmd drain` check (see module header). */
  fleetControlRoot: string;
  /** `plan/questions.ndjson` root — MUST equal the `repoRoot` `appendQuestion` writes into (see module header). */
  questionsRoot: string;
  tokens: ServiceTokens;
  /** Board SSE poll pace; defaults to board.ts's own `DEFAULT_POLL_MS` (250ms, the W3-T2 2s acceptance bar). */
  pollMs?: number;
  /**
   * W1-T154: how often {@link prewarmBoardGithub}'s background timer re-warms `board.github`.
   * Defaults to {@link DEFAULT_BOARD_PREWARM_MS} (matches `buildBatchedGithub`'s own default TTL
   * in status.ts, so the background refresh lands right as the gateway's cache would otherwise
   * go stale). Only meaningful for a gateway implementing {@link GitHub.warm}; a no-op otherwise.
   */
  boardGithubRefreshMs?: number;
  /** Forwarded to `createService` — one ledger line per auth decision/SSE lifecycle/handler error. */
  log?: ServiceOptions["log"];
}

/** Matches {@link buildBatchedGithub}'s own default `ttlMs` (status.ts) — kept as one named
 *  constant here rather than a bare literal so the two stay visibly the same number. */
export const DEFAULT_BOARD_PREWARM_MS = 15_000;

/**
 * PRE-WARM (W1-T154, MASTER-PLAN §7/§7B): call `github.warm()` (if it has one — status.ts's
 * `buildBatchedGithub` does) SYNCHRONOUSLY, before {@link buildServeServer}'s caller ever
 * `.listen()`s — so the board's underlying `gh pr list` fetch has already happened by BOOT,
 * and the FIRST `GET /v1/status` a real client sends resolves against an already-warm in-memory
 * index with zero additional GitHub fetches on the request path (the task's own falsifier: "a
 * first request that triggers the cold fetch FAILS"). Then schedules a background timer that
 * calls `warm()` again every `refreshMs` — the gateway never goes cold again waiting on a
 * request to trigger its own refetch. `.unref()`'d so this never keeps a short-lived process
 * (a test, a one-shot script) alive; {@link buildServeServer} wires the returned `stop` function
 * to the server's own `close` event so the timer doesn't outlive it.
 */
export function prewarmBoardGithub(github: GitHub, refreshMs: number = DEFAULT_BOARD_PREWARM_MS): () => void {
  github.warm?.();
  const timer = setInterval(() => github.warm?.(), refreshMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * The operator-console HTML shell (W1-T153: "replace the flat file-order table with
 * operator-priority sections + a real design system"). NOT apps/dashboard's full SPA — that
 * page's own header already documents why it stays a separate, later-wired artifact ("Wiring
 * the daemon to actually SERVE this directory as static files... is explicit follow-on work").
 *
 * INFORMATION ARCHITECTURE, top to bottom — file order appears NOWHERE (task design note):
 *   1. NOW        — in-flight runs (a live `phase` + elapsed), from GET /v1/status.
 *   2. NEEDS ME    — needs-human escalations (StatusProjection.needsHuman) + the feedback
 *      inbox's actionable entries (grilling/proposed, GET /v1/feedback) + W1-T110's READY
 *      ratification proposals (GET /v1/inbox) — one-line ask + action affordance each.
 *   3. UP NEXT     — the drain head, first ~5 of GET /v1/drain/preview (W1-T140), in
 *      plannedSequence order.
 *   4. RECENT      — last ~10 merges/blocks with PR links, GET /v1/recent (board.ts, reusing
 *      W1-T141's `merged`/`blocked` outcome vocabulary — see board.ts's header for why this
 *      route exists instead of querying a live DrainSummary).
 *   5. everything else, COLLAPSED behind grouped counts (queued: N, merged: N, other: N) with
 *      an expand + filter/search over the remaining GET /v1/status tasks.
 * Fleet control (Pause/Resume/STOP/quiet-hours) and an auxiliary "more tools" panel (submit
 * feedback, plan→task→PR graph) follow below the five sections.
 *
 * SCOPE NOTE (W1-T110/W1-T111 split): a READY inbox proposal's "action" is the exact `rmd
 * approve`/`rmd reframe` command text, not a button — `approveProposal`/`reframeProposal`
 * (lib/inbox.ts) need a real git/gh `RatifyGateway`, and wiring that as a WRITE route is its
 * own concern (a ratification write surface), not this task's one concern (shell IA/design).
 * See GET /v1/inbox's own doc comment (panel-graph.ts).
 *
 * DESIGN SYSTEM: dark theme (default, no light/auto toggle in v0 — "applied by default"
 * satisfies the acceptance bar without prefers-color-scheme's extra state to keep distinct-
 * and-consistent across), five distinct CSS-custom-property status color tokens reused
 * EVERYWHERE a state appears (never an inline color — see `.status-dot`/`.status-label`),
 * monospace task ids, phone-first responsive (a single fluid column, no fixed-width table —
 * the v0 shell's `<table>` was exactly what produced horizontal scroll at 390px). Every
 * interactive control is a real `<button>`/`<input>`/`<label>` (never a clickable `<div>`),
 * kept for the Lighthouse/axe a11y bar (test/serve.shell-ux.test.ts).
 *
 * FLEET-CONTROL READ-BACK (task design note): the shell reads GET /v1/control/status
 * (panel-actions.ts, this task's own new route — no route exposed the tri-state before) and
 * renders the ACTIVE mode's control visibly active/disabled — never identical button states
 * across paused/running/stopped ("should I try clicking start?"). STOP requires an explicit
 * second click ("Confirm STOP") before it POSTs — never a single click.
 *
 * Uses bearer auth exactly like every other route on this surface (there is no unauthenticated
 * route in service.ts's model — `GET /` is `scope: "read"` like everything else; the reader
 * must already carry a token, same `?token=` query-param convention apps/dashboard's own
 * `main.ts` uses).
 *
 * W1-T154 ADDENDUM (first-paint perf, separable from the above IA/design work): the initial
 * markup below ships a SKELETON (see `skeletonRows`) in every row-list, never a bare "loading…"
 * text block. The page's own script then paints, in order: (1) a last-snapshot cache from
 * localStorage if one exists, stamped STALE via `#stale-badge`/`top-status`'s `data-stale`
 * attribute, swapped for live data the instant it arrives; (2) `GET /v1/status` ALONE, painting
 * NOW + the `#summary` line immediately — never gated behind the other five endpoints
 * (progressive load); (3) those other five, completing the picture. See `refreshAll`'s own
 * comment for the full sequencing.
 */
/**
 * W1-T154: the initial-paint placeholder for a row list with no data yet — a REAL skeleton (a
 * distinct, visually-pulsing "content is coming" marker), never the bare "loading…" text a
 * screen-reader-silent, visually-empty-looking block the acceptance bar's falsifier names
 * ("never a blank 'loading…' block"). `aria-hidden` because the page's `#top-status` (aria-live)
 * is the one accessible loading announcement — these rows are a purely visual placeholder.
 */
function skeletonRows(n: number): string {
  return Array.from({ length: n }, () => '<li class="row skeleton" aria-hidden="true"><span class="skeleton-bar"></span></li>').join("");
}

export function renderShellHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Remudero — the operator console</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0e14;
    --bg-elevated: #12161f;
    --bg-card: #171c27;
    --border: #262c3a;
    --text: #e6e9ef;
    --text-dim: #a7b0c2;
    --text-faint: #8b93a8;
    --accent: #5b9dff;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --status-running: #4db8ff;
    --status-blocked: #ff6b6b;
    --status-needs-human: #ffb84d;
    --status-merged: #4ade80;
    --status-queued: #a3acc2;
    --radius: 10px;
    --gap: 12px;
  }
  * { box-sizing: border-box; }
  html, body { max-width: 100vw; overflow-x: hidden; }
  body {
    margin: 0; padding: var(--gap) var(--gap) 3rem;
    background: var(--bg); color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.4;
  }
  main { max-width: 56rem; margin: 0 auto; display: flex; flex-direction: column; gap: 1.5rem; }
  h1 { font-size: 1.25rem; margin: 0.5rem 0; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-dim); margin: 0 0 0.5rem; }
  a { color: var(--accent); }
  code, .mono { font-family: var(--font-mono); }
  #top-status { color: var(--text-dim); font-size: 0.875rem; margin: 0; }
  section.panel-section {
    background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 1rem;
  }
  .row-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .row {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem;
    background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 8px;
    padding: 0.5rem 0.75rem; overflow-wrap: anywhere;
  }
  .row .task-id { font-family: var(--font-mono); font-weight: 600; }
  .row .detail { color: var(--text-dim); font-size: 0.875rem; flex-basis: 100%; }
  .status-dot { display: inline-block; width: 0.6em; height: 0.6em; border-radius: 50%; margin-right: 0.15em; }
  .status-label { font-size: 0.8rem; font-weight: 600; background: none; }
  /* the DOT is a filled swatch (background); the LABEL is text colored to match (never a
     filled background behind it — same-color text-on-background is an invisible-text bug). */
  .status-dot.status-running { background: var(--status-running); }
  .status-dot.status-blocked { background: var(--status-blocked); }
  .status-dot.status-needs-human { background: var(--status-needs-human); }
  .status-dot.status-merged { background: var(--status-merged); }
  .status-dot.status-queued { background: var(--status-queued); }
  .status-label.status-running { color: var(--status-running); }
  .status-label.status-blocked { color: var(--status-blocked); }
  .status-label.status-needs-human { color: var(--status-needs-human); }
  .status-label.status-merged { color: var(--status-merged); }
  .status-label.status-queued { color: var(--status-queued); }
  .empty { color: var(--text-faint); font-size: 0.875rem; }
  /* W1-T154: first-paint skeleton — a pulsing placeholder bar, never a blank/empty block. */
  .row.skeleton { opacity: 0.7; }
  .skeleton-bar {
    display: inline-block; width: 100%; height: 0.9rem; border-radius: 4px;
    background: linear-gradient(90deg, var(--bg-elevated) 25%, var(--border) 37%, var(--bg-elevated) 63%);
    background-size: 400% 100%; animation: skeleton-pulse 1.4s ease infinite;
  }
  @keyframes skeleton-pulse { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
  #stale-badge {
    display: inline-block; margin: 0.25rem 0 0; padding: 0.15rem 0.5rem; border-radius: 999px;
    font-size: 0.75rem; font-weight: 600; background: var(--status-needs-human); color: #241a02;
  }
  button {
    font: inherit; background: var(--bg-elevated); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 0.4rem 0.75rem; cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  button[aria-pressed="true"], button.active { background: var(--accent); color: #04101f; border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.danger { border-color: var(--status-blocked); color: var(--status-blocked); }
  button.danger.confirming { background: var(--status-blocked); color: #200404; }
  input[type="text"], input[type="url"] {
    font: inherit; background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 0.4rem 0.5rem; width: 100%; max-width: 24rem;
  }
  label { display: block; font-size: 0.875rem; color: var(--text-dim); margin: 0.35rem 0; }
  form.inline-action { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; flex-basis: 100%; }
  form.inline-action input { flex: 1 1 12rem; width: auto; }
  .btn-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .counts { color: var(--text-dim); font-size: 0.9rem; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (min-width: 900px) {
    main { max-width: 64rem; }
  }
</style>
</head>
<body>
<main>
<header>
  <h1>Remudero — the operator console</h1>
  <p id="top-status" role="status" aria-live="polite">loading…</p>
  <p id="summary" class="counts" aria-live="polite"></p>
  <span id="stale-badge" hidden>STALE — showing last known data</span>
</header>

<section id="now" class="panel-section" aria-label="Now">
  <h2>Now</h2>
  <ul id="now-list" class="row-list">${skeletonRows(2)}</ul>
</section>

<section id="needs-me" class="panel-section" aria-label="Needs me">
  <h2>Needs me</h2>
  <ul id="needs-me-list" class="row-list">${skeletonRows(2)}</ul>
</section>

<section id="up-next" class="panel-section" aria-label="Up next">
  <h2>Up next</h2>
  <ul id="up-next-list" class="row-list">${skeletonRows(3)}</ul>
</section>

<section id="recent" class="panel-section" aria-label="Recent">
  <h2>Recent</h2>
  <ul id="recent-list" class="row-list">${skeletonRows(3)}</ul>
</section>

<section id="rest" class="panel-section" aria-label="Everything else">
  <h2>Everything else</h2>
  <div class="btn-row">
    <span id="rest-counts" class="counts">…</span>
    <button id="rest-toggle" type="button" aria-expanded="false" aria-controls="rest-detail">Expand</button>
  </div>
  <div id="rest-detail" hidden>
    <label for="rest-filter">Filter by task id</label>
    <input id="rest-filter" type="text" placeholder="e.g. W1-T" />
    <ul id="rest-list" class="row-list"></ul>
  </div>
</section>

<section id="controls" class="panel-section" aria-label="Fleet control">
  <h2>Fleet control</h2>
  <label for="reason">Reason (optional, for Pause/STOP)</label>
  <input id="reason" type="text" />
  <div class="btn-row">
    <button id="pause-btn" type="button" aria-pressed="false">Pause</button>
    <button id="resume-btn" type="button" aria-pressed="false">Resume</button>
    <button id="stop-btn" type="button" class="danger" aria-pressed="false">STOP</button>
    <label style="display:flex; align-items:center; gap:0.35rem; margin:0;">
      <input id="quiet-hours" type="checkbox" /> Quiet hours
    </label>
  </div>
  <p id="controls-status" role="status" aria-live="polite" class="counts"></p>
</section>

<section id="more" class="panel-section" aria-label="More tools">
  <h2>More tools</h2>
  <div class="btn-row">
    <!-- IN-SHELL PANELS, not page hops: a browser NAVIGATION to a header-only /v1 route cannot
         send the Authorization header, so a bare anchor click 401s (the #339 bootstrap-paradox
         at the LINK layer). These fetch WITH the header the page already carries. -->
    <button id="feedback-btn" type="button">Feedback inbox</button>
    <button id="graph-btn" type="button">Plan→task→PR graph</button>
  </div>
  <section id="panel" aria-label="Tool panel" hidden>
    <h2 id="panel-title"></h2>
    <div id="panel-controls"></div>
    <pre id="panel-body" class="mono"></pre>
  </section>
</section>
</main>

<script type="module">
  // Bootstrap: the SAME \`?token=\` query-param convention apps/dashboard/src/main.ts uses —
  // this page itself already required a bearer header to load (service.ts gates every route,
  // GET / included), so whatever fetched this page already has a token; this just lets that
  // same token drive the page's own follow-up API calls.
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") ?? "";
  const authHeaders = { authorization: \`Bearer \${token}\` };

  function escapeHtml(text) {
    return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  async function getJson(path) {
    const res = await fetch(path, { headers: authHeaders });
    if (!res.ok) throw new Error(\`GET \${path} -> \${res.status}\`);
    return res.json();
  }
  function postJson(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  }

  // ── the five-state status color taxonomy (W1-T153 design system) — ONE mapping, reused
  // everywhere a task's state renders (NOW/NEEDS ME/UP NEXT/RECENT/rest), never re-derived. ──
  function statusColorKey(t) {
    if (t.needsHuman) return "needs-human";
    if (t.status === "merged" || t.status === "done") return "merged";
    if (t.status === "blocked") return "blocked";
    if (t.status === "queued") return "queued";
    return "running";
  }
  const STATUS_LABELS = { running: "running", blocked: "blocked", "needs-human": "needs human", merged: "merged", queued: "queued" };
  function statusBadge(key) {
    return \`<span class="status-dot status-\${key}" aria-hidden="true"></span><span class="status-label status-\${key}">\${STATUS_LABELS[key]}</span>\`;
  }
  function formatElapsed(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return \`\${h}h\${m % 60}m\`;
    if (m > 0) return \`\${m}m\${s % 60}s\`;
    return \`\${s}s\`;
  }
  function prLink(t) {
    if (!t.prUrl) return "";
    const label = t.prNumber !== undefined ? \`#\${t.prNumber}\` : t.prUrl;
    return \` · <a href="\${t.prUrl}" target="_blank" rel="noreferrer">\${label}</a>\`;
  }

  // ── W1-T154: first-paint-is-never-cold — a last-snapshot cache (localStorage, survives a
  // reload/relaunch of THIS browser) painted INSTANTLY, before any network round trip, stamped
  // STALE; the static skeleton above already covers the true cold-start case (no cache at all).
  const SNAPSHOT_CACHE_KEY = "rmd-console-snapshot-v1";

  function readSnapshotCache() {
    try {
      const raw = localStorage.getItem(SNAPSHOT_CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null; // storage disabled/corrupt — the cache is a nicety, never load-bearing.
    }
  }
  function writeSnapshotCache(snapshot) {
    try {
      localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify(snapshot));
    } catch {
      // quota exceeded/disabled — silently skip; next reload just sees the skeleton instead.
    }
  }
  function markStale(asOf) {
    const badge = document.getElementById("stale-badge");
    badge.hidden = false;
    badge.textContent = \`STALE — showing last known data as of \${asOf ?? "an earlier load"}\`;
    document.getElementById("top-status").dataset.stale = "true";
  }
  function clearStale() {
    document.getElementById("stale-badge").hidden = true;
    delete document.getElementById("top-status").dataset.stale;
  }

  function summaryText(tasks) {
    const total = tasks.length;
    const merged = tasks.filter((t) => t.status === "merged" || t.status === "done").length;
    const running = tasks.filter((t) => t.status === "running").length;
    const queued = tasks.filter((t) => t.status === "queued").length;
    return \`\${total} tasks · \${running} running · \${merged} merged · \${queued} queued\`;
  }

  /** Repaints EVERY section from one composite snapshot — the single function the cache-restore
   *  path and a completed live refresh both funnel through, so "instant paint from cache" and
   *  "a live refresh" can never drift into two different rendering codepaths. */
  function paintSnapshot(snapshot) {
    const tasks = snapshot.tasks ?? [];
    const nowIds = renderNow(tasks);
    const needsMeIds = renderNeedsMe(tasks, snapshot.feedbackEntries ?? [], snapshot.inboxReady ?? []);
    const upNextIds = renderUpNext(snapshot.upNextCards ?? []);
    const recentIds = renderRecent(snapshot.recentEntries ?? []);
    renderRest(tasks, new Set([...nowIds, ...needsMeIds, ...upNextIds, ...recentIds]));
    applyControlStatus(snapshot.controlStatus ?? { paused: false, stopped: false, quietHours: false });
    document.getElementById("summary").textContent = summaryText(tasks);
  }

  // ── NOW — in-flight runs, live phase + elapsed ──────────────────────────────────────────
  function renderNow(tasks) {
    const inFlight = tasks.filter((t) => t.phase);
    const list = document.getElementById("now-list");
    list.innerHTML = inFlight.length
      ? inFlight
          .map((t) => {
            const key = statusColorKey(t);
            return \`<li class="row"><span class="task-id">\${escapeHtml(t.taskId)}</span>\${statusBadge(key)}<span class="detail">phase: \${escapeHtml(t.phase)} · elapsed: \${formatElapsed(t.elapsedMs)}\${t.armedAwaitingMerge ? " · auto-merge armed" : ""}</span></li>\`;
          })
          .join("")
      : '<li class="empty">nothing in flight</li>';
    return new Set(inFlight.map((t) => t.taskId));
  }

  // ── NEEDS ME — escalations + inbox, one-line ask + action ───────────────────────────────
  function renderNeedsMe(tasks, feedbackEntries, inboxReady) {
    const rows = [];
    const shown = new Set();
    for (const t of tasks) {
      if (!t.needsHuman) continue;
      shown.add(t.taskId);
      rows.push(
        \`<li class="row">\${statusBadge("needs-human")}<span class="task-id">\${escapeHtml(t.taskId)}</span><span class="detail">needs human attention (escalated)</span>\` +
          \`<form class="inline-action needs-me-approve" data-task-id="\${escapeHtml(t.taskId)}">\` +
          \`<label for="issue-\${escapeHtml(t.taskId)}">Issue URL</label>\` +
          \`<input id="issue-\${escapeHtml(t.taskId)}" type="url" placeholder="https://github.com/.../issues/…" required />\` +
          \`<button type="submit">Approve</button></form></li>\`,
      );
    }
    for (const e of feedbackEntries ?? []) {
      if (e.status === "grilling") {
        rows.push(
          \`<li class="row">\${statusBadge("needs-human")}<span class="task-id">feedback#\${escapeHtml(e.id)}</span><span class="detail">asks: \${escapeHtml(e.raw)}</span>\` +
            \`<form class="inline-action needs-me-answer" data-reply-to="\${escapeHtml(e.id)}">\` +
            \`<label for="answer-\${escapeHtml(e.id)}">Answer</label>\` +
            \`<input id="answer-\${escapeHtml(e.id)}" type="text" required />\` +
            \`<button type="submit">Answer</button></form></li>\`,
        );
      } else if (e.status === "proposed") {
        rows.push(
          \`<li class="row">\${statusBadge("needs-human")}<span class="task-id">feedback#\${escapeHtml(e.id)}</span><span class="detail">proposes: \${escapeHtml(e.raw)}</span>\` +
            \`<span class="btn-row"><button type="button" class="needs-me-decide" data-id="\${escapeHtml(e.id)}" data-decision="accept">Accept</button>\` +
            \`<button type="button" class="needs-me-decide" data-id="\${escapeHtml(e.id)}" data-decision="reject">Reject</button></span></li>\`,
        );
      }
    }
    for (const p of inboxReady ?? []) {
      rows.push(
        \`<li class="row">\${statusBadge("needs-human")}<span class="task-id">\${escapeHtml(p.proposalId)}</span><span class="detail">READY to ratify — \${escapeHtml(p.summary)}</span>\` +
          \`<span class="detail">run <code>rmd approve \${escapeHtml(p.proposalId)}</code> or <code>rmd reframe \${escapeHtml(p.proposalId)} --feedback "…"</code></span></li>\`,
      );
    }
    document.getElementById("needs-me-list").innerHTML = rows.length ? rows.join("") : '<li class="empty">nothing needs you right now</li>';
    return shown;
  }

  // ── UP NEXT — the drain head, first ~5 runnable (W1-T140 preview/curation) ──────────────
  function renderUpNext(cards) {
    const list = document.getElementById("up-next-list");
    const head = (cards ?? []).slice(0, 5);
    list.innerHTML = head.length
      ? head
          .map(
            (c) =>
              \`<li class="row">\${statusBadge("queued")}<span class="task-id">\${escapeHtml(c.id)}</span><span class="detail">\${escapeHtml(c.title)} · \${(c.dependsOn ?? []).length} dep(s)</span></li>\`,
          )
          .join("")
      : '<li class="empty">drain queue is empty</li>';
    return new Set(head.map((c) => c.id));
  }

  // ── RECENT — last ~10 merges/blocks, PR-linked ───────────────────────────────────────────
  function renderRecent(entries) {
    const list = document.getElementById("recent-list");
    list.innerHTML = (entries ?? []).length
      ? entries
          .map(
            (e) =>
              \`<li class="row">\${statusBadge(e.outcome === "blocked" ? "blocked" : "merged")}<span class="task-id">\${escapeHtml(e.taskId)}</span><span class="detail">\${escapeHtml(e.outcome)}\${prLink(e)}</span></li>\`,
          )
          .join("")
      : '<li class="empty">no recent outcomes yet</li>';
    return new Set((entries ?? []).map((e) => e.taskId));
  }

  // ── everything else — COLLAPSED counts + expand + filter/search ─────────────────────────
  let restTasks = [];
  function renderRestList(filterText) {
    const needle = (filterText ?? "").trim().toLowerCase();
    const filtered = needle ? restTasks.filter((t) => t.taskId.toLowerCase().includes(needle)) : restTasks;
    const list = document.getElementById("rest-list");
    list.innerHTML = filtered.length
      ? filtered
          .slice(0, 200)
          .map((t) => \`<li class="row">\${statusBadge(statusColorKey(t))}<span class="task-id">\${escapeHtml(t.taskId)}</span></li>\`)
          .join("")
      : '<li class="empty">no matching tasks</li>';
  }
  function renderRest(tasks, shownIds) {
    restTasks = tasks.filter((t) => !shownIds.has(t.taskId));
    const queued = restTasks.filter((t) => statusColorKey(t) === "queued").length;
    const merged = restTasks.filter((t) => statusColorKey(t) === "merged").length;
    const other = restTasks.length - queued - merged;
    document.getElementById("rest-counts").textContent = \`queued: \${queued} · merged: \${merged} · other: \${other} (\${restTasks.length} total)\`;
    if (!document.getElementById("rest-detail").hidden) renderRestList(document.getElementById("rest-filter").value);
  }
  document.getElementById("rest-toggle").addEventListener("click", () => {
    const detail = document.getElementById("rest-detail");
    const toggle = document.getElementById("rest-toggle");
    const expanded = !detail.hidden;
    detail.hidden = expanded;
    toggle.setAttribute("aria-expanded", String(!expanded));
    toggle.textContent = expanded ? "Expand" : "Collapse";
    if (!expanded) renderRestList(document.getElementById("rest-filter").value);
  });
  document.getElementById("rest-filter").addEventListener("input", (e) => renderRestList(e.target.value));

  // ── NEEDS ME row actions (event delegation — rows are re-rendered on every refresh) ─────
  document.getElementById("needs-me-list").addEventListener("submit", async (e) => {
    const approveForm = e.target.closest(".needs-me-approve");
    const answerForm = e.target.closest(".needs-me-answer");
    if (approveForm) {
      e.preventDefault();
      const taskId = approveForm.dataset.taskId;
      const issueUrl = approveForm.querySelector("input").value.trim();
      await postJson("/v1/manual/approve", { taskId, issueUrl });
      refreshAll();
    } else if (answerForm) {
      e.preventDefault();
      const replyTo = answerForm.dataset.replyTo;
      const answer = answerForm.querySelector("input").value.trim();
      await postJson("/v1/feedback", { text: answer, replyTo });
      refreshAll();
    }
  });
  document.getElementById("needs-me-list").addEventListener("click", async (e) => {
    const btn = e.target.closest(".needs-me-decide");
    if (!btn) return;
    await postJson("/v1/feedback/decision", { id: btn.dataset.id, decision: btn.dataset.decision });
    refreshAll();
  });

  // ── fleet control READ-BACK (W1-T153): render the ACTIVE mode, never stateless buttons ──
  function applyControlStatus(status) {
    const pauseBtn = document.getElementById("pause-btn");
    const resumeBtn = document.getElementById("resume-btn");
    const stopBtn = document.getElementById("stop-btn");
    const quietHours = document.getElementById("quiet-hours");
    pauseBtn.setAttribute("aria-pressed", String(status.paused));
    pauseBtn.classList.toggle("active", status.paused);
    pauseBtn.disabled = status.paused || status.stopped;
    stopBtn.setAttribute("aria-pressed", String(status.stopped));
    stopBtn.classList.toggle("active", status.stopped);
    resumeBtn.disabled = !status.paused && !status.stopped;
    resumeBtn.setAttribute("aria-pressed", String(!status.paused && !status.stopped && false));
    quietHours.checked = status.quietHours;
    const detail = status.stopped ? status.stopDetail : status.paused ? status.pauseDetail : "fleet is running";
    document.getElementById("controls-status").textContent = detail ?? (status.stopped ? "stopped" : status.paused ? "paused" : "running");
  }

  // ── STOP requires an explicit second click ("Confirm STOP") — never a single click ──────
  let stopConfirmTimer;
  document.getElementById("stop-btn").addEventListener("click", () => {
    const btn = document.getElementById("stop-btn");
    if (btn.dataset.confirming !== "true") {
      btn.dataset.confirming = "true";
      btn.classList.add("confirming");
      btn.textContent = "Confirm STOP?";
      clearTimeout(stopConfirmTimer);
      stopConfirmTimer = setTimeout(() => resetStopButton(), 8000);
      return;
    }
    resetStopButton();
    postJson("/v1/control/stop", { reason: document.getElementById("reason").value || undefined }).then(refreshAll);
  });
  function resetStopButton() {
    const btn = document.getElementById("stop-btn");
    btn.dataset.confirming = "false";
    btn.classList.remove("confirming");
    btn.textContent = "STOP";
    clearTimeout(stopConfirmTimer);
  }
  document.getElementById("pause-btn").addEventListener("click", () => {
    postJson("/v1/control/pause", { reason: document.getElementById("reason").value || undefined }).then(refreshAll);
  });
  document.getElementById("resume-btn").addEventListener("click", () => {
    postJson("/v1/control/resume").then(refreshAll);
  });
  document.getElementById("quiet-hours").addEventListener("change", (e) => {
    postJson("/v1/quiet-hours", { enabled: e.target.checked }).then(refreshAll);
  });

  // ── the auxiliary tool panels (unchanged mechanism from the v0 shell — in-shell, never a
  // navigation to a header-only route) ──────────────────────────────────────────────────────
  function openPanel(title) {
    document.getElementById("panel-title").textContent = title;
    document.getElementById("panel-controls").innerHTML = "";
    document.getElementById("panel").hidden = false;
    document.getElementById("panel-body").textContent = "loading…";
  }
  document.getElementById("feedback-btn").addEventListener("click", async () => {
    openPanel("Feedback inbox");
    const body = document.getElementById("panel-body");
    try {
      const data = await getJson("/v1/feedback");
      const entries = data.entries ?? [];
      body.textContent = entries.length
        ? entries.map((e) => \`\${e.id ?? "?"} — \${e.status ?? ""}: \${e.raw ?? ""}\`).join("\\n")
        : "(inbox empty)";
    } catch (e) {
      body.textContent = \`panel fetch failed: \${e}\`;
    }
  });
  document.getElementById("graph-btn").addEventListener("click", () => {
    openPanel("Plan→task→PR graph");
    const controls = document.getElementById("panel-controls");
    controls.innerHTML =
      '<label for="trace-id">task or feedback id</label><input id="trace-id" type="text" /> <button id="trace-btn" type="button">Trace</button>';
    const body = document.getElementById("panel-body");
    body.textContent = "enter an id and click Trace";
    document.getElementById("trace-btn").addEventListener("click", async () => {
      const id = document.getElementById("trace-id").value.trim();
      if (!id) { body.textContent = "an id is required"; return; }
      body.textContent = "loading…";
      try {
        const data = await getJson(\`/v1/trace?id=\${encodeURIComponent(id)}\`);
        body.textContent = JSON.stringify(data.chain ?? data, null, 2);
      } catch (e) {
        body.textContent = \`panel fetch failed: \${e}\`;
      }
    });
  });

  // ── the poll loop: one refresh drives NOW/NEEDS ME/UP NEXT/RECENT/rest + fleet-control
  // read-back. v0: polls (same rationale the original shell documented for GET /v1/status —
  // native EventSource cannot carry an Authorization header); @remudero/api-client's
  // subscribeStatus already implements real SSE consumption for a client that wants it.
  //
  // W1-T154 PROGRESSIVE LOAD: /v1/status is fetched ALONE first, and NOW + the summary line
  // render off it IMMEDIATELY — never gated behind the other five endpoints below. A single
  // fetch-everything-then-render-anything pattern is exactly the falsifier the task's own
  // acceptance text names ("a single blocking full-board fetch that renders nothing until all N
  // rows are ready FAILS"). top-status's final "updated" text (and the stale-cache swap it
  // implies) still lands only once every section has repainted — unchanged from before this
  // task, and load-bearing for callers that wait on it as "the refresh is fully done". ─────────
  async function refreshAll() {
    let statusSnap;
    try {
      statusSnap = await getJson("/v1/status");
    } catch (e) {
      document.getElementById("top-status").textContent = \`refresh failed: \${e}\`;
      return;
    }
    const tasks = statusSnap.tasks ?? [];
    const nowIds = renderNow(tasks);
    renderNeedsMe(tasks, [], []); // tasks-only pass now; the full pass (below) adds feedback/inbox rows
    document.getElementById("summary").textContent = summaryText(tasks);

    try {
      const [recentSnap, upNextSnap, feedbackSnap, inboxSnap, controlStatus] = await Promise.all([
        getJson("/v1/recent").catch(() => ({ entries: [] })),
        getJson("/v1/drain/preview?max=5").catch(() => ({ cards: [] })),
        getJson("/v1/feedback").catch(() => ({ entries: [] })),
        getJson("/v1/inbox").catch(() => ({ ready: [] })),
        getJson("/v1/control/status").catch(() => ({ paused: false, stopped: false, quietHours: false })),
      ]);
      const needsMeIds = renderNeedsMe(tasks, feedbackSnap.entries, inboxSnap.ready);
      const upNextIds = renderUpNext(upNextSnap.cards);
      const recentIds = renderRecent(recentSnap.entries);
      renderRest(tasks, new Set([...nowIds, ...needsMeIds, ...upNextIds, ...recentIds]));
      applyControlStatus(controlStatus);
      document.getElementById("top-status").textContent = \`updated \${statusSnap.generated_at ?? new Date().toISOString()}\`;
      clearStale(); // a completed live refresh always supersedes whatever the cache painted

      writeSnapshotCache({
        generated_at: statusSnap.generated_at,
        tasks,
        recentEntries: recentSnap.entries,
        upNextCards: upNextSnap.cards,
        feedbackEntries: feedbackSnap.entries,
        inboxReady: inboxSnap.ready,
        controlStatus,
      });
    } catch (e) {
      document.getElementById("top-status").textContent = \`refresh failed: \${e}\`;
    }
  }

  // FIRST PAINT, before any network round trip completes (W1-T154): a last-snapshot cache from
  // a previous load, stamped STALE — or, with no cache at all (a true cold start), the skeleton
  // the static HTML above already ships. Either way, never a blank page.
  const cachedSnapshot = readSnapshotCache();
  if (cachedSnapshot) {
    paintSnapshot(cachedSnapshot);
    markStale(cachedSnapshot.generated_at);
  }
  refreshAll();
  setInterval(refreshAll, 3000);
</script>
</body>
</html>
`;
}

/**
 * `GET /` — the shell above, read-scoped like every other route on this surface, but ALSO
 * accepting the token via `?token=` (allowQueryToken). A browser NAVIGATION to `/?token=<read>`
 * cannot set an `Authorization` header, so without this the shell would 401 and never load — the
 * page's OWN follow-up `/v1/*` fetches then carry the header (those routes stay header-only). This
 * closes the W1-T139 bootstrap paradox: the auth spec was satisfied against header-sending fetch
 * clients and unreachable by the one client that matters, the browser opening the URL.
 */
function buildShellRoute(): Route {
  return {
    method: "GET",
    path: "/",
    scope: "read",
    allowQueryToken: true,
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderShellHtml());
    },
  };
}

/** Every REST route `rmd serve` registers — board, panel actions (two-root split, see module header), panel graph, and the shell. Reused verbatim from each module's own exported builder. */
export function buildServeRoutes(deps: ServeDeps): Route[] {
  const fleetControlDeps: PanelActionDeps = { root: deps.fleetControlRoot, ledgerPath: deps.ledgerPath, issues: deps.issues };
  const questionDeps: PanelActionDeps = { root: deps.questionsRoot, ledgerPath: deps.ledgerPath, issues: deps.issues };
  // panel-graph's GET /v1/inbox needs config.root (inbox-proposals.json/inbox-drafts.json live
  // under state/, same as fleet-control's own flags) -- `fleetControlRoot` IS config.root
  // (module header), so it is the same root, never a THIRD independently-resolved path.
  const panelGraphDeps = { ...deps.panelGraph, inboxRoot: deps.fleetControlRoot };

  return [
    buildStatusRoute(deps.board),
    buildRecentRoute(deps.board),
    buildControlStatusRoute(fleetControlDeps),
    buildPauseRoute(fleetControlDeps),
    buildResumeRoute(fleetControlDeps),
    buildStopRoute(fleetControlDeps),
    buildQuietHoursRoute(fleetControlDeps),
    buildAnswerQuestionRoute(questionDeps),
    buildApproveManualRoute(fleetControlDeps),
    ...buildPanelGraphRoutes(panelGraphDeps),
    buildShellRoute(),
  ];
}

/**
 * Build (but do not `.listen()`) the full `rmd serve` HTTP server — one call, every route wired.
 * ALSO pre-warms `deps.board.github` (W1-T154) — synchronously, before this function returns —
 * and starts its background TTL refresh, stopped when the returned server `close`s.
 */
export function buildServeServer(deps: ServeDeps): Server {
  const server = createService({
    tokens: deps.tokens,
    routes: buildServeRoutes(deps),
    sse: [buildStatusStream(deps.board, deps.pollMs ?? DEFAULT_POLL_MS)],
    log: deps.log,
  });
  const stopPrewarm = prewarmBoardGithub(deps.board.github, deps.boardGithubRefreshMs ?? DEFAULT_BOARD_PREWARM_MS);
  server.on("close", stopPrewarm);
  return server;
}

// ── CLI glue: port + token resolution (kept here, not run-task.ts, so both are unit-testable
// as pure/near-pure functions rather than only exercisable through the live CLI) ────────────

/**
 * `--port <n>` if present (validated: an integer 1-65535), else {@link DEFAULT_SERVE_PORT}.
 * Throws (never returns an invalid port) so the CLI can fail loud before any bind attempt.
 */
export function resolveServePort(rest: string[]): number {
  const idx = rest.indexOf("--port");
  if (idx < 0) return DEFAULT_SERVE_PORT;
  const raw = rest[idx + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`--port must be an integer 1-65535, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Where `rmd serve`'s generated bearer tokens persist across restarts (config.root, like every other `<root>/state/*` control file). */
export function serviceTokensPath(configRoot: string): string {
  return join(configRoot, "state", "service-tokens.json");
}

/**
 * Load `rmd serve`'s bearer tokens, generating + persisting them on first run. A bearer token
 * must stay STABLE across daemon restarts (a client — apps/dashboard's `?token=` param, a
 * saved curl command — would otherwise silently break every relaunch), so this is create-once,
 * read-thereafter, using the SAME exclusive-create discipline config.ts's `loadConfig` already
 * established for its own first-run file (`openSync(p, "wx")` folds the existence check and
 * the create into one atomic syscall — no TOCTOU window for a second `rmd serve` racing this
 * one's first launch to clobber the other's tokens).
 */
export function resolveServiceTokens(configRoot: string): ServiceTokens {
  const p = serviceTokensPath(configRoot);
  mkdirSync(dirname(p), { recursive: true });
  let fd: number | undefined;
  try {
    fd = openSync(p, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  if (fd !== undefined) {
    try {
      const created: ServiceTokens = { read: randomBytes(32).toString("hex"), write: randomBytes(32).toString("hex") };
      writeSync(fd, JSON.stringify(created, null, 2) + "\n");
      return created;
    } finally {
      closeSync(fd);
    }
  }
  const readFd = openSync(p, "r");
  try {
    return JSON.parse(readFileSync(readFd, "utf8")) as ServiceTokens;
  } finally {
    closeSync(readFd);
  }
}

/** `existsSync` re-export point kept trivial — used only by test fixtures wanting to assert the tokens file's persistence without importing node:fs directly for that one check. */
export function serviceTokensFileExists(configRoot: string): boolean {
  return existsSync(serviceTokensPath(configRoot));
}
