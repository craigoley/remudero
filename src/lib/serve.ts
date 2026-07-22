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
  buildEscalationMarkHandledRoute,
  buildPauseRoute,
  buildQuietHoursRoute,
  buildResumeRoute,
  buildStopRoute,
  type IssueCloser,
  type PanelActionDeps,
} from "./panel-actions.js";
import { buildPanelGraphRoutes, type PanelGraphDeps } from "./panel-graph.js";
import { buildTaskCardRoute } from "./task-card.js";

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
  /**
   * W1-T183: per-phase elapsed-time ANOMALY thresholds (ms), keyed by {@link Phase} (plus a
   * `default` fallback for a phase not listed) — DATA, not a constant baked into the row
   * template, so an operator (or a test) can tune "how long is too long" without a source
   * change. Defaults to {@link DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS} when omitted. Embedded
   * verbatim into the shell's own script (see {@link renderShellHtml}) — the anomaly check
   * itself runs client-side, over the SAME `elapsedMs`/`phase` fields NOW rows already render
   * (W1-T155), never a new server-side derivation.
   */
  phaseElapsedThresholdsMs?: Record<string, number>;
  /** Forwarded to `createService` — one ledger line per auth decision/SSE lifecycle/handler error. */
  log?: ServiceOptions["log"];
}

/** Matches {@link buildBatchedGithub}'s own default `ttlMs` (status.ts) — kept as one named
 *  constant here rather than a bare literal so the two stay visibly the same number. */
export const DEFAULT_BOARD_PREWARM_MS = 15_000;

/**
 * W1-T183 default anomaly thresholds — how long a phase normally takes before a still-running
 * row is worth a second look. NOT a liveness verdict (W1-T179 owns "is this actually running");
 * purely a visual "this one is taking unusually long" flag. Keyed by status.ts's {@link Phase}
 * union, plus `default` for any value not listed (defensive — Phase is a closed set today, but
 * the client-side check is written against an arbitrary string key, never a hard-coded switch).
 */
export const DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS: Record<string, number> = {
  recon: 15 * 60 * 1000,
  implement: 90 * 60 * 1000,
  review: 30 * 60 * 1000,
  "fix-rung": 45 * 60 * 1000,
  default: 60 * 60 * 1000,
};

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

export function renderShellHtml(phaseElapsedThresholdsMs: Record<string, number> = DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS): string {
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
  /* W1-T183: tightened section/heading chrome (1.5rem->1rem gap, 1rem->0.75rem vertical
     section padding, 0.5rem->0.35rem heading margin) -- every priority section above "everything
     else" (NOW/NEEDS ME/UP NEXT/RECENT) is frequently EMPTY on a quiet fleet, so their own chrome
     -- not row height -- was the dominant cost keeping a first screen under 15 rows. */
  main { max-width: 56rem; margin: 0 auto; display: flex; flex-direction: column; gap: 0.6rem; }
  h1 { font-size: 1.25rem; margin: 0.5rem 0; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-dim); margin: 0 0 0.25rem; }
  a { color: var(--accent); }
  code, .mono { font-family: var(--font-mono); }
  #top-status { color: var(--text-dim); font-size: 0.875rem; margin: 0; }
  /* W1-T183 round 2: the >=15-rows-above-the-fold bar was passing the SYNTHETIC (1-char-title)
     fixture but only barely clearing 15 against the REAL, realistic-title 218-task plan (measured
     exactly 15 -- a margin thin enough that a different browser's font metrics could tip it under).
     Section/toolbar chrome -- not row height -- was still the dominant remaining cost once "everything
     else" itself was visible, so this round tightens that chrome further for real headroom, not a
     razor's edge. */
  section.panel-section {
    background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 0.5rem 0.75rem;
  }
  .row-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }
  /* W1-T183 DENSITY + IA v2: one line per task by default -- id · status · phase · elapsed ·
     spend · PR/issue link -- truncated with an ellipsis rather than wrapping to a second line,
     so a first screen reads the fleet at a glance instead of scrolling card-shaped rows to find
     anything (the 2026-07-20 console v2 fixture this task falsifies). A row carrying a real
     inline FORM (NEEDS ME's approve/answer/accept-reject affordances) opts back into wrapping
     below -- an <input> cannot usefully truncate onto one line. */
  .row {
    display: flex; flex-wrap: nowrap; align-items: center; gap: 0.5rem;
    background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 6px;
    padding: 0.22rem 0.5rem; overflow: hidden;
  }
  .row > * { flex-shrink: 0; }
  .row:has(form), .row:has(.btn-row) { flex-wrap: wrap; overflow: visible; align-items: baseline; }
  .row .task-id { font-family: var(--font-mono); font-weight: 600; }
  .row .detail {
    color: var(--text-dim); font-size: 0.875rem; flex: 1 1 auto; min-width: 0; flex-shrink: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .row:has(form) .detail, .row:has(.btn-row) .detail {
    flex-basis: 100%; white-space: normal; overflow: visible; text-overflow: clip;
  }
  /* ANOMALY FLAG (W1-T183): a per-phase elapsed threshold exceeded -- never carried by colour
     alone, always paired with the "⚠ long-running" text+glyph marker (nowRowHtml/tickElapsed). */
  .row.anomaly { border-color: var(--status-needs-human); background: rgba(255, 184, 77, 0.1); }
  .anomaly-flag { color: var(--status-needs-human); font-weight: 700; }
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
  /* W1-T156: TRUST — the console must never lie about its own liveness. ─────────────────── */
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
    clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
  #trust-row { margin-top: 0.35rem; }
  .conn-badge {
    display: inline-flex; align-items: center; gap: 0.35em; padding: 0.15rem 0.55rem;
    border-radius: 999px; font-size: 0.75rem; font-weight: 600;
  }
  .conn-badge .dot { width: 0.5em; height: 0.5em; border-radius: 50%; background: currentColor; display: inline-block; }
  .conn-badge[data-state="connected"] { background: rgba(74, 222, 128, 0.15); color: var(--status-merged); }
  .conn-badge[data-state="connecting"] { background: rgba(163, 172, 194, 0.15); color: var(--text-dim); }
  .conn-badge[data-state="disconnected"] { background: rgba(255, 107, 107, 0.15); color: var(--status-blocked); }
  .conn-badge[data-state="connected"] .dot { animation: live-pulse 1.4s ease-in-out infinite; }
  @keyframes live-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  .gh-banner {
    background: rgba(255, 184, 77, 0.12); border: 1px solid var(--status-needs-human);
    color: var(--status-needs-human); padding: 0.5rem 0.75rem; border-radius: 8px; font-size: 0.85rem;
  }
  .live-indicator {
    width: 0.5em; height: 0.5em; border-radius: 50%; background: var(--status-running);
    display: inline-block; animation: live-pulse 1.2s ease-in-out infinite;
  }
  .live-badge-static {
    font-size: 0.65rem; font-weight: 700; letter-spacing: 0.03em; color: var(--status-running);
    border: 1px solid var(--status-running); border-radius: 4px; padding: 0 0.3em;
  }
  .row.flash { animation: row-flash 1.1s ease; }
  @keyframes row-flash { 0% { background: rgba(91, 157, 255, 0.35); } 100% { background: var(--bg-elevated); } }
  .row.flash-static { box-shadow: inset 3px 0 0 var(--accent); }
  @media (prefers-reduced-motion: reduce) {
    .conn-badge[data-state="connected"] .dot { animation: none; }
    .live-indicator { animation: none; }
    .row.flash { animation: none; background: var(--bg-elevated); }
    .skeleton-bar { animation: none; }
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
    border-radius: 6px; padding: 0.3rem 0.5rem; width: 100%; max-width: 24rem;
  }
  label { display: block; font-size: 0.875rem; color: var(--text-dim); margin: 0.25rem 0; }
  /* W1-T183 round 2: this label reuses W1-T156's existing .sr-only class (defined above) -- still
     in the a11y tree (for=/aria-label parity), just not eating a whole line above the fold for a
     control whose placeholder already names it. */
  form.inline-action { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; flex-basis: 100%; }
  form.inline-action input { flex: 1 1 12rem; width: auto; }
  .btn-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .counts { color: var(--text-dim); font-size: 0.9rem; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* W1-T157 FIND layer: faceted filters, sort headers, live counts ─────────────────────────── */
  .find-facets { display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; margin: 0.3rem 0; }
  .facet-group { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; }
  .facet-group-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-faint); margin-right: 0.15rem; }
  .facet-btn, .sort-header { font-size: 0.8rem; padding: 0.2rem 0.5rem; }
  .facet-count { color: var(--text-faint); font-variant-numeric: tabular-nums; }
  button[aria-pressed="true"] .facet-count { color: inherit; }
  .find-sort { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; margin: 0.2rem 0; }
  #find-count { margin: 0.15rem 0; font-size: 0.8rem; }
  /* W1-T157 cmd+K command palette overlay ──────────────────────────────────────────────────── */
  .cmdk-overlay {
    position: fixed; inset: 0; z-index: 50; background: rgba(4, 7, 12, 0.6);
    display: flex; align-items: flex-start; justify-content: center; padding: 12vh 1rem 1rem;
  }
  .cmdk-overlay[hidden] { display: none; }
  #cmdk-dialog {
    background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius);
    width: min(92vw, 40rem); max-height: 70vh; display: flex; flex-direction: column;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
  }
  #cmdk-input { margin: 0.75rem; width: auto; max-width: none; }
  .cmdk-results { list-style: none; margin: 0; padding: 0 0.5rem 0.5rem; overflow-y: auto; }
  .cmdk-item {
    padding: 0.5rem 0.6rem; border-radius: 6px; cursor: pointer; font-size: 0.9rem;
    display: flex; align-items: center; gap: 0.5rem; overflow-wrap: anywhere;
  }
  .cmdk-item.active, .cmdk-item:hover { background: var(--bg-elevated); }
  .cmdk-kind { font-size: 0.65rem; font-weight: 700; letter-spacing: 0.03em; color: var(--text-faint); border: 1px solid var(--border); border-radius: 4px; padding: 0 0.3em; }
  .cmdk-empty { padding: 0.6rem; color: var(--text-faint); font-size: 0.875rem; }
  /* W1-T158: DETAIL + JOURNEY layer. ────────────────────────────────────────────────────── */
  .row { cursor: pointer; }
  .row button, .row a, .row input, .row label, .row form { cursor: auto; }
  .row-journey-btn { margin-left: auto; font-size: 0.75rem; padding: 0.2rem 0.5rem; }
  h3 { font-size: 0.9rem; margin: 0.75rem 0 0.35rem; color: var(--text-dim); }
  #task-detail-body ul, #journey-body ul { list-style: none; margin: 0; padding: 0; }
  #task-detail-body li, #journey-body li { padding: 0.15rem 0; }
  #journey-body ul ul { padding-left: 1.25rem; }
  .card-dep-link, .journey-task-link { font-size: 0.85rem; padding: 0.2rem 0.5rem; }
  /* the failing/blocking step in a journey — the whole point of "walk backwards to the cause". */
  .journey-fail { color: var(--status-blocked); font-weight: 600; }
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
  <div class="btn-row" id="trust-row">
    <span id="connection-indicator" class="conn-badge" data-state="connecting" role="status" aria-live="polite">
      <span class="dot" aria-hidden="true"></span> connecting…
    </span>
    <span id="freshness" class="counts" aria-live="off"></span>
  </div>
  <span id="stale-badge" hidden>STALE — showing last known data</span>
  <div id="gh-unreachable-banner" class="gh-banner" hidden role="status" aria-live="polite"></div>
  <!-- W1-T156: a single dedicated aria-live region for status-change announcements -- screen
       reader users get "task flipped" news without a sighted user's visual flash/highlight. -->
  <div id="aria-announcer" class="sr-only" role="status" aria-live="polite"></div>
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
  <!-- W1-T183: EXPANDED BY DEFAULT. W1-T153's original v0 IA hid this whole corpus behind an
       "Expand" click, which is exactly what fails this task's own density/one-click bars against
       a realistic (mostly queued, low-activity) fleet: NOW/NEEDS ME/RECENT are near-empty and UP
       NEXT caps at 5, so under a couple hundred plain tasks a collapsed rest section left a first
       screen with a handful of rows, and any task living only in "everything else" needed an
       expand-THEN-click (two interactions) to reach its card. Rendering these as DENSE
       single-line rows (see .row-list .row CSS) removed the original space cost that motivated
       collapsing them, so the corpus now renders open -- "Collapse" remains available for anyone
       who wants the compact grouped-count summary instead. -->
  <div class="btn-row">
    <span id="rest-counts" class="counts">…</span>
    <button id="rest-toggle" type="button" aria-expanded="true" aria-controls="rest-detail">Collapse</button>
  </div>
  <div id="rest-detail">
    <!-- W1-T157 FIND layer: instant client-side fuzzy search (id + title), faceted filters with
         LIVE counts, sortable columns, all persisted to the URL (shareable / survives reload). -->
    <label for="find-search" class="sr-only">Search id or title</label>
    <input id="find-search" type="text" role="searchbox" aria-controls="rest-list" placeholder="fuzzy — e.g. W1-T157 or words from the title" />
    <div id="find-facets" class="find-facets" role="group" aria-label="Filters (live counts)"></div>
    <div id="find-sort" class="find-sort" role="group" aria-label="Sort">
      <span class="counts">Sort:</span>
      <button type="button" class="sort-header" data-sort="id" aria-pressed="false">id</button>
      <button type="button" class="sort-header" data-sort="status" aria-pressed="false">status</button>
      <button type="button" class="sort-header" data-sort="recency" aria-pressed="false">recency</button>
      <button type="button" class="sort-header" data-sort="age" aria-pressed="false">age</button>
    </div>
    <p id="find-count" class="counts" aria-live="polite"></p>
    <ul id="rest-list" class="row-list">${skeletonRows(5)}</ul>
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
  </div>
  <section id="panel" aria-label="Tool panel" hidden>
    <h2 id="panel-title"></h2>
    <div id="panel-controls"></div>
    <pre id="panel-body" class="mono"></pre>
  </section>
</section>

<!-- W1-T158: the DETAIL + JOURNEY layer. EVERY task row (NOW/NEEDS ME/UP NEXT/RECENT/rest)
     carries its own one-click "Journey" affordance (.row-journey-btn, keyed on that row's OWN
     task id) and is itself clickable to expand this card -- never a typed-id lookup. This
     RETIRES the v0 id-textbox "Plan→task→PR graph" panel (#359's own follow-on debt): the SAME
     GET /v1/trace route now backs #journey-view instead, reached only by an explicit per-row
     action or an in-card dependency link, never a free-text form. -->
<section id="task-detail" class="panel-section" aria-label="Task detail" hidden>
  <div class="btn-row">
    <h2 id="task-detail-title">Task</h2>
    <button id="task-detail-close" type="button">Close</button>
  </div>
  <div id="task-detail-body"></div>
</section>

<section id="journey-view" class="panel-section" aria-label="Journey" hidden>
  <div class="btn-row">
    <h2 id="journey-title">Journey</h2>
    <button id="journey-close" type="button">Close</button>
  </div>
  <div id="journey-body"></div>
</section>
</main>

<!-- W1-T157 cmd+K command palette: a global, additive modal (NOT a sixth section — the five-section
     order invariant stays intact). Opened by Cmd/Ctrl+K from ANY view via one document-level keydown
     listener; jumps to a task/PR or fires a fleet/panel action through the EXACT existing button. -->
<div id="cmdk-overlay" class="cmdk-overlay" hidden>
  <div id="cmdk-dialog" role="dialog" aria-modal="true" aria-label="Command palette">
    <input id="cmdk-input" type="text" autocomplete="off" aria-controls="cmdk-results" aria-label="Command palette search" placeholder="Jump to a task or PR, or run an action… (Esc to close)" />
    <ul id="cmdk-results" class="cmdk-results" role="listbox" aria-label="Command palette results"></ul>
  </div>
</div>

<script type="module">
  // Bootstrap: the SAME \`?token=\` query-param convention apps/dashboard/src/main.ts uses —
  // this page itself already required a bearer header to load (service.ts gates every route,
  // GET / included), so whatever fetched this page already has a token; this just lets that
  // same token drive the page's own follow-up API calls.
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") ?? "";
  const authHeaders = { authorization: \`Bearer \${token}\` };

  // W1-T156: read ONCE at load -- prefers-reduced-motion does not need live-tracking mid-
  // session for this shell's purposes, and a stable value keeps a row's rendered HTML (which
  // embeds the live-indicator markup) stable across re-renders instead of flapping.
  const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // W1-T183: per-phase elapsed ANOMALY thresholds -- DATA embedded by the server from
  // ServeDeps.phaseElapsedThresholdsMs (defaults to DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS),
  // never a constant baked into this template. A row's own phase looks itself up here (falling
  // back to "default") -- see phaseThresholdMs() below.
  const PHASE_ELAPSED_THRESHOLD_MS = ${JSON.stringify(phaseElapsedThresholdsMs)};
  function phaseThresholdMs(phase) {
    return PHASE_ELAPSED_THRESHOLD_MS[phase] ?? PHASE_ELAPSED_THRESHOLD_MS.default ?? Infinity;
  }

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

  // ── W1-T183: TIME RENDERING -- local + relative TOGETHER ('14:23:05 · 8s ago'), never a raw
  // ISO-8601-with-milliseconds string anywhere in the UI (the falsifier: a UTC millisecond stamp
  // forces the reader to do arithmetic to answer "is this recent"). Every place this shell used
  // to render \`someDate.toISOString()\`/a bare \`generated_at\` routes through this pair instead. ──
  function formatRelative(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
    if (ms < 1000) return "just now";
    const s = Math.floor(ms / 1000);
    if (s < 60) return \`\${s}s ago\`;
    const m = Math.floor(s / 60);
    if (m < 60) return \`\${m}m ago\`;
    const h = Math.floor(m / 60);
    if (h < 24) return \`\${h}h ago\`;
    const d = Math.floor(h / 24);
    return \`\${d}d ago\`;
  }
  /** \`iso\` -> "14:23:05 · 8s ago" -- local wall-clock time (the reader's own timezone) PLUS a
   *  relative offset from now, together, never either alone. Falls back to the raw string only
   *  when \`iso\` fails to parse (never silently swallowed). */
  function formatTimestamp(iso) {
    if (!iso) return "unknown";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return String(iso);
    const local = new Date(t).toLocaleTimeString();
    return \`\${local} · \${formatRelative(Date.now() - t)}\`;
  }

  // ── W1-T156 UI+TRUST: an animated per-row "in flight" indicator, replaced by a STATIC badge
  // (no animation at all -- not merely a slower one) under prefers-reduced-motion. ────────────
  function liveIndicatorHtml() {
    return REDUCED_MOTION
      ? '<span class="live-badge-static" aria-hidden="true">LIVE</span>'
      : '<span class="live-indicator" aria-hidden="true"></span>';
  }

  // ── a single aria-live region for status-change announcements (screen-reader parity with
  // the sighted in-place flash below) ─────────────────────────────────────────────────────────
  function announce(message) {
    document.getElementById("aria-announcer").textContent = message;
  }

  /**
   * Briefly highlight a row that just changed IN PLACE (an SSE/poll flip) -- never a re-created
   * node, just a transient visual cue on the SAME element. Under prefers-reduced-motion this is
   * a static, non-animated marker (a left accent bar) instead of the pulsing background animation.
   */
  function flashRow(el) {
    if (REDUCED_MOTION) {
      el.classList.add("flash-static");
      setTimeout(() => el.classList.remove("flash-static"), 1500);
    } else {
      el.classList.remove("flash");
      void el.offsetWidth; // force reflow so re-adding the class restarts the animation
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1200);
    }
  }

  /**
   * W1-T156 DOM-STABILITY: reconcile \`list\`'s children against \`rows\` (each a precomputed
   * {key, html, taskId?} triple) by KEY, not by wholesale innerHTML replacement. An unchanged
   * row's <li> is the SAME DOM node afterward (never destroyed/recreated) -- its own attributes
   * (and any DOM state a caller stamped on it, e.g. an active text selection anchored inside it)
   * survive an update cycle. Only a row whose rendered html actually differs from last time is
   * touched (and flashed); only keys no longer present are removed; new keys are inserted in
   * order. W1-T158: \`taskId\`, when present, is stamped as \`data-task-id\` -- the row-click
   * delegated handler's ONLY way to know which task a click landed on (a task's \`key\` is not
   * always the bare task id, e.g. NEEDS ME's \`task:<id>\`/\`fbg:<id>\` prefixes).
   */
  function reconcileRows(list, rows, emptyText) {
    if (rows.length === 0) {
      if (list.children.length !== 1 || !list.firstElementChild || !list.firstElementChild.classList.contains("empty")) {
        list.innerHTML = \`<li class="empty">\${escapeHtml(emptyText)}</li>\`;
      }
      return;
    }
    const existing = new Map();
    for (const child of Array.from(list.children)) {
      if (child.dataset && child.dataset.key !== undefined) existing.set(child.dataset.key, child);
    }
    let prev = null;
    const seen = new Set();
    for (const row of rows) {
      seen.add(row.key);
      let el = existing.get(row.key);
      const isNew = !el;
      if (!el) {
        el = document.createElement("li");
        el.className = "row";
        el.dataset.key = row.key;
      }
      if (row.taskId !== undefined) el.dataset.taskId = row.taskId;
      else delete el.dataset.taskId;
      if (el.dataset.html !== row.html) {
        el.innerHTML = row.html;
        el.dataset.html = row.html;
        if (!isNew) flashRow(el); // a genuine content CHANGE on an already-known row -- not a fresh insert.
      }
      const anchor = prev ? prev.nextSibling : list.firstChild;
      if (anchor !== el) list.insertBefore(el, anchor); // a no-op when el is already positioned correctly.
      prev = el;
    }
    // W1-T183: remove every child that is NOT one of this render's keyed rows -- including a
    // leftover UN-KEYED first-paint skeleton placeholder (W1-T154's skeletonRows) that real data
    // has now superseded. The old version of this cleanup only walked \`existing\` (keyed children),
    // so a skeleton <li> -- which never carries a data-key -- was never in that map and was
    // stranded in the DOM forever once real rows arrived (reproduced: #now-list/#rest-list still
    // held their initial skeleton <li>s alongside real content after the first successful paint).
    for (const child of Array.from(list.children)) {
      const key = child.dataset && child.dataset.key;
      if (key === undefined || !seen.has(key)) child.remove();
    }
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
    badge.textContent = \`STALE — showing last known data as of \${asOf ? formatTimestamp(asOf) : "an earlier load"}\`;
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

  // ── W1-T156: the live task-status truth this shell renders from. SSE deltas AND poll
  // snapshots both funnel through ingestProjection -> tasksById, so every section render below
  // is driven from ONE source of truth regardless of which transport last updated a task. ─────
  const tasksById = new Map();
  let latestFeedbackEntries = [];
  let latestInboxReady = [];
  let latestUpNextCards = [];
  let latestRecentEntries = [];

  /** A projection minus its VOLATILE, non-status fields -- \`elapsedMs\` (changes every second,
   *  rendered by the separate ticking timer below) and \`lastActivityAt\` (a board-only ledger
   *  timestamp, not part of the status taxonomy the operator is announced about). A row whose
   *  ONLY difference is one of these must not "flip" (re-render/flash/announce). */
  function withoutVolatile(p) {
    // W1-T184: liveSpendUsd/liveTurns tick upward as an in-flight run spends/turns, exactly
    // like elapsedMs ticks with wall-clock time -- neither is a genuine status "flip".
    const { elapsedMs, lastActivityAt, liveSpendUsd, liveTurns, ...rest } = p;
    return rest;
  }

  /**
   * Absorb one projection into \`tasksById\`. TWO transports feed this: the GET /v1/status poll
   * (a BoardRow -- carries \`title\`/\`risk\`/\`lastActivityAt\`) and the SSE \`status\` stream (a bare
   * StatusProjection -- does NOT). So we take \`p\` as the AUTHORITATIVE status taxonomy, but
   * BACKFILL only the three stable board-enrichment fields from the prior row when \`p\` lacks them
   * -- otherwise an SSE delta arriving after a poll would silently DROP a task's known title/risk
   * (and spuriously look like a content "flip", flashing/announcing every tick, purely because the
   * stringified before/after differ by the missing fields). We deliberately do NOT do a blanket
   * \`{...prev, ...p}\` merge: the SPARSE status fields (\`phase\`/\`needsHuman\`/\`armedAwaitingMerge\`/
   * \`indeterminate\`) must be able to CLEAR when a delta drops them, so \`p\` owns all of those.
   * Returns whether this is a GENUINE status flip vs. the prior known state (ignoring the volatile
   * fields); a first sighting (no prior entry) is never announced -- that is a paint, not a flip.
   */
  function ingestProjection(p) {
    const prev = tasksById.get(p.taskId);
    const merged = { ...p };
    if (prev) {
      if (merged.title === undefined) merged.title = prev.title;
      if (merged.risk === undefined) merged.risk = prev.risk;
      if (merged.lastActivityAt === undefined) merged.lastActivityAt = prev.lastActivityAt;
    }
    tasksById.set(p.taskId, merged);
    const changed = !prev || JSON.stringify(withoutVolatile(prev)) !== JSON.stringify(withoutVolatile(merged));
    if (changed && prev) {
      const key = statusColorKey(merged);
      announce(\`\${merged.taskId} is now \${STATUS_LABELS[key]}\${merged.phase ? \` (phase \${merged.phase})\` : ""}\`);
    }
    return changed;
  }

  // ── TRUST: "GitHub unreachable since <t>" -- DERIVED from the CURRENT snapshot's own
  // per-task \`indeterminate\`/source:"throttled" signal (W1-T119) every render, never a latched
  // string a later success forgets to clear (the operator-observed stale-banner-beside-live-data
  // bug this task's error-lifecycle section names). Clears the instant no task reports it. ─────
  let githubUnreachableSince = null;
  function updateGithubBanner(tasks) {
    const unreachable = tasks.some((t) => t.indeterminate);
    const banner = document.getElementById("gh-unreachable-banner");
    if (unreachable) {
      if (!githubUnreachableSince) githubUnreachableSince = new Date();
      banner.hidden = false;
      banner.textContent = \`GitHub unreachable since \${formatTimestamp(githubUnreachableSince.toISOString())} — statuses may be stale\`;
    } else {
      githubUnreachableSince = null;
      banner.hidden = true;
      banner.textContent = "";
    }
  }

  /** Repaints the task-driven sections (NOW/NEEDS ME/UP NEXT/RECENT/rest) from \`tasksById\` +
   *  the latest cached feedback/inbox/up-next/recent data -- the ONE function an SSE delta, a
   *  poll snapshot, AND the cache-restore path all funnel through, so they can never drift into
   *  different rendering codepaths. Every section render below is keyed/reconciled (never a
   *  wholesale innerHTML replace), so calling this on every SSE tick costs only the rows that
   *  actually changed. */
  function paintFromTasksById() {
    const tasks = Array.from(tasksById.values());
    const nowIds = renderNow(tasks);
    const needsMeIds = renderNeedsMe(tasks, latestFeedbackEntries, latestInboxReady);
    const upNextIds = renderUpNext(latestUpNextCards);
    const recentIds = renderRecent(latestRecentEntries);
    renderRest(tasks, new Set([...nowIds, ...needsMeIds, ...upNextIds, ...recentIds]));
    updateGithubBanner(tasks);
    document.getElementById("summary").textContent = summaryText(tasks);
  }

  /** The cache-restore path (W1-T154): ingest the cached snapshot's tasks/side-data and paint
   *  through the SAME \`paintFromTasksById\` a live update uses. */
  function paintSnapshot(snapshot) {
    for (const t of snapshot.tasks ?? []) ingestProjection(t);
    latestFeedbackEntries = snapshot.feedbackEntries ?? [];
    latestInboxReady = snapshot.inboxReady ?? [];
    latestUpNextCards = snapshot.upNextCards ?? [];
    latestRecentEntries = snapshot.recentEntries ?? [];
    paintFromTasksById();
    applyControlStatus(snapshot.controlStatus ?? { paused: false, stopped: false, quietHours: false });
  }

  // ── W1-158: an explicit one-click per-row Journey affordance -- keyed on THIS row's own
  // task id (never a typed id). Retires the v0 id-textbox "Plan→task→PR graph" panel. ──────────
  function journeyButtonHtml(taskId) {
    return \`<button type="button" class="row-journey-btn" data-task-id="\${escapeHtml(taskId)}" title="Open the provenance journey for \${escapeHtml(taskId)}">Journey</button>\`;
  }

  // ── NOW — in-flight runs, live phase + LIVE-TICKING elapsed (W1-T156) + LIVE spend/turns (W1-T184) ──
  // W1-T183: each in-flight row also carries its own phase's ANOMALY threshold
  // (data-threshold-ms) plus a hidden \`.anomaly-flag\` marker -- tickElapsed() below flips both
  // the marker and the row's own \`.anomaly\` class live, off the SAME ticking clock that already
  // drives the elapsed text, so a row that crosses its threshold mid-session is flagged without
  // waiting on the next status flip/re-render.
  function liveSpendHtml(t) {
    if (t.liveSpendUsd === undefined && t.liveTurns === undefined) return "";
    const turns = t.liveTurns !== undefined ? \` / \${t.liveTurns} turns\` : "";
    return \` · spend: \${costLabel(t.liveSpendUsd)}\${turns}\`;
  }
  function nowRowHtml(t) {
    const key = statusColorKey(t);
    const threshold = phaseThresholdMs(t.phase);
    return (
      \`<span class="task-id">\${escapeHtml(t.taskId)}</span>\${statusBadge(key)}\${liveIndicatorHtml()}\` +
      \`<span class="detail">phase: \${escapeHtml(t.phase)} · elapsed: <span class="elapsed" data-started="\${escapeHtml(t.startedAt ?? "")}" data-threshold-ms="\${threshold}">…</span>\` +
      \`<span class="anomaly-flag" hidden title="running longer than usual for this phase">⚠ long-running</span>\` +
      \`\${liveSpendHtml(t)}\${t.armedAwaitingMerge ? " · auto-merge armed" : ""}\${prLink(t)}</span>\` +
      journeyButtonHtml(t.taskId)
    );
  }
  function renderNow(tasks) {
    const inFlight = tasks.filter((t) => t.phase);
    const rows = inFlight.map((t) => ({ key: t.taskId, html: nowRowHtml(t), taskId: t.taskId }));
    reconcileRows(document.getElementById("now-list"), rows, "nothing in flight");
    tickElapsed(); // paint newly (re)rendered elapsed spans immediately, not after the next 1s tick
    return new Set(inFlight.map((t) => t.taskId));
  }

  /** Every \`.elapsed[data-started]\` span, wherever it lives, ticks off wall-clock time -- this
   *  runs independently of any row re-render, so elapsed advancing every second never counts as
   *  a "flip" (no flash, no aria announcement, no DOM node touched beyond this one text node).
   *  W1-T183 ADDENDUM: also re-evaluates that same span's own \`data-threshold-ms\` anomaly check
   *  every tick -- crossing the threshold toggles the row's \`.anomaly\` class AND its
   *  \`.anomaly-flag\` marker's visibility, but is deliberately NOT routed through
   *  ingestProjection/flashRow: it is volatile, tick-driven state, exactly like elapsed itself
   *  (see withoutVolatile's own note), never a "flip" that flashes or announces. */
  function tickElapsed() {
    const now = Date.now();
    document.querySelectorAll(".elapsed[data-started]").forEach((el) => {
      const started = el.getAttribute("data-started");
      const elapsedMs = started ? now - Date.parse(started) : NaN;
      el.textContent = started ? formatElapsed(elapsedMs) : "";
      const thresholdAttr = el.getAttribute("data-threshold-ms");
      const row = el.closest(".row");
      if (row && thresholdAttr !== null) {
        const anomalous = Number.isFinite(elapsedMs) && elapsedMs > Number(thresholdAttr);
        row.classList.toggle("anomaly", anomalous);
        const marker = row.querySelector(".anomaly-flag");
        if (marker) marker.hidden = !anomalous;
      }
    });
  }

  // ── NEEDS ME — escalations + inbox, one-line ask + action ───────────────────────────────
  // W1-T182: an ESCALATION row joins LIVE issue state (status.ts's escalationIssueUrl/
  // escalationTitle/escalationUnverified), never ledger history alone, and renders the
  // affordance an escalation actually supports -- "view issue" (a DIRECT link, never an input
  // soliciting a URL the ledger already holds) + "mark handled". There is NO Approve control
  // here: "approve" has no defined verb for an escalation of any class -- that word is reserved
  // for a P## ratification-inbox proposal (needsMeInboxHtml, below), the one item type it is
  // actually defined for.
  function needsMeTaskRowHtml(t) {
    const ask = t.escalationTitle ? escapeHtml(t.escalationTitle) : "needs human attention (escalated)";
    const unverifiedNote = t.escalationUnverified ? " · issue state unverified (showing to be safe)" : "";
    const viewIssueLink = t.escalationIssueUrl
      ? \`<a href="\${escapeHtml(t.escalationIssueUrl)}" target="_blank" rel="noopener noreferrer">view issue</a>\`
      : "";
    const markHandledBtn = t.escalationIssueUrl
      ? \`<button type="button" class="needs-me-mark-handled" data-task-id="\${escapeHtml(t.taskId)}" data-issue-url="\${escapeHtml(t.escalationIssueUrl)}">Mark handled</button>\`
      : "";
    return (
      \`\${statusBadge("needs-human")}<span class="task-id">\${escapeHtml(t.taskId)}</span><span class="detail">\${ask}\${unverifiedNote}\${prLink(t)}</span>\` +
      journeyButtonHtml(t.taskId) +
      (viewIssueLink || markHandledBtn ? \`<span class="btn-row">\${viewIssueLink}\${markHandledBtn}</span>\` : "")
    );
  }
  function needsMeGrillHtml(e) {
    return (
      \`\${statusBadge("needs-human")}<span class="task-id">feedback#\${escapeHtml(e.id)}</span><span class="detail">asks: \${escapeHtml(e.raw)}</span>\` +
      \`<form class="inline-action needs-me-answer" data-reply-to="\${escapeHtml(e.id)}">\` +
      \`<label for="answer-\${escapeHtml(e.id)}">Answer</label>\` +
      \`<input id="answer-\${escapeHtml(e.id)}" type="text" required />\` +
      \`<button type="submit">Answer</button></form>\`
    );
  }
  function needsMeProposedHtml(e) {
    return (
      \`\${statusBadge("needs-human")}<span class="task-id">feedback#\${escapeHtml(e.id)}</span><span class="detail">proposes: \${escapeHtml(e.raw)}</span>\` +
      \`<span class="btn-row"><button type="button" class="needs-me-decide" data-id="\${escapeHtml(e.id)}" data-decision="accept">Accept</button>\` +
      \`<button type="button" class="needs-me-decide" data-id="\${escapeHtml(e.id)}" data-decision="reject">Reject</button></span>\`
    );
  }
  function needsMeInboxHtml(p) {
    return (
      \`\${statusBadge("needs-human")}<span class="task-id">\${escapeHtml(p.proposalId)}</span><span class="detail">READY to ratify — \${escapeHtml(p.summary)}</span>\` +
      \`<span class="detail">run <code>rmd approve \${escapeHtml(p.proposalId)}</code> or <code>rmd reframe \${escapeHtml(p.proposalId)} --feedback "…"</code></span>\`
    );
  }
  function renderNeedsMe(tasks, feedbackEntries, inboxReady) {
    const rows = [];
    const shown = new Set();
    for (const t of tasks) {
      if (!t.needsHuman) continue;
      shown.add(t.taskId);
      rows.push({ key: \`task:\${t.taskId}\`, html: needsMeTaskRowHtml(t), taskId: t.taskId });
    }
    for (const e of feedbackEntries ?? []) {
      if (e.status === "grilling") rows.push({ key: \`fbg:\${e.id}\`, html: needsMeGrillHtml(e) });
      else if (e.status === "proposed") rows.push({ key: \`fbp:\${e.id}\`, html: needsMeProposedHtml(e) });
    }
    for (const p of inboxReady ?? []) rows.push({ key: \`inbox:\${p.proposalId}\`, html: needsMeInboxHtml(p) });
    reconcileRows(document.getElementById("needs-me-list"), rows, "nothing needs you right now");
    return shown;
  }

  // ── UP NEXT — the drain head, first ~5 runnable (W1-T140 preview/curation) ──────────────
  function renderUpNext(cards) {
    const head = (cards ?? []).slice(0, 5);
    const rows = head.map((c) => ({
      key: c.id,
      html: \`\${statusBadge("queued")}<span class="task-id">\${escapeHtml(c.id)}</span><span class="detail">\${escapeHtml(c.title)} · \${(c.dependsOn ?? []).length} dep(s)</span>\${journeyButtonHtml(c.id)}\`,
      taskId: c.id,
    }));
    reconcileRows(document.getElementById("up-next-list"), rows, "drain queue is empty");
    return new Set(head.map((c) => c.id));
  }

  // ── RECENT — a LEDGER-FIRST activity feed (W1-T184): merges/verdicts/fix outcomes/
  // escalations/spend, one row per ledger EVENT (not a task's final state) — GitHub only ever
  // DECORATES a row (the PR's title); an unreachable GitHub degrades that decoration, it never
  // removes the row (see lib/board.ts's computeRecentActivity for the full design rationale). ──

  const RECENT_VERB_LABEL = { merged: "merged", verdict: "verdict", fix: "fix", escalated: "escalated", spend: "spend" };
  // Reuses the board's existing status-dot palette (statusBadge/STATUS_LABELS above) rather than
  // inventing new colors for this feed's own vocabulary — merged/verdict map onto their obvious
  // counterparts; fix/spend read as "in progress" (running); escalated reads as needs-human.
  const RECENT_BADGE_KEY = { merged: "merged", verdict: "blocked", fix: "running", escalated: "needs-human", spend: "running" };

  /** "5m ago"/"2h ago"/"3d ago" -- RECENT's relative-timestamp column (a distinct concept from
   *  \`formatElapsed\`'s live countUP for an in-flight NOW row's own \`elapsedMs\`). */
  function formatAgo(ts) {
    const ms = Date.now() - Date.parse(ts);
    if (!Number.isFinite(ms)) return "";
    if (ms < 60_000) return "just now";
    const m = Math.floor(ms / 60_000);
    if (m < 60) return \`\${m}m ago\`;
    const h = Math.floor(m / 60);
    if (h < 24) return \`\${h}h ago\`;
    return \`\${Math.floor(h / 24)}d ago\`;
  }

  /** GitHub DECORATES: the PR link's label prefers the PR's own title (when GitHub resolved
   *  one); absent that, it degrades to the bare PR number/url -- never omits the link itself. */
  /** The PR link's label carries BOTH the number AND the title when GitHub resolved one
   *  ("#123 — the actual PR title") -- never the title ALONE (a bare title with no PR number
   *  reads ambiguously as free text, not a PR reference). Degrades to the bare number, then the
   *  raw url, as GitHub's decoration itself degrades -- the link is never omitted. */
  function recentPrLinkHtml(e) {
    if (!e.prUrl) return "";
    const num = e.prNumber !== undefined ? \`#\${e.prNumber}\` : null;
    const label = num && e.prTitle ? \`\${num} — \${e.prTitle}\` : e.prTitle || num || e.prUrl;
    return \` · <a class="recent-pr-link" href="\${e.prUrl}" target="_blank" rel="noreferrer">\${escapeHtml(label)}</a>\`;
  }

  function recentSpendHtml(e) {
    if (e.costUsd === undefined && e.numTurns === undefined) return "";
    const turns = e.numTurns !== undefined ? \` / \${e.numTurns} turns\` : "";
    return \` · <span class="recent-spend">spend: \${costLabel(e.costUsd)}\${turns}</span>\`;
  }

  function recentRowHtml(e) {
    const key = RECENT_BADGE_KEY[e.verb] ?? "queued";
    const verbLabel = RECENT_VERB_LABEL[e.verb] ?? e.verb;
    const detail = e.detail ? \` (\${escapeHtml(e.detail)})\` : "";
    const unavailable = e.githubUnavailable ? \` · <span class="recent-gh-unavailable">GitHub unavailable</span>\` : "";
    return (
      \`\${statusBadge(key)}<span class="task-id" data-verb="\${escapeHtml(e.verb)}">\${escapeHtml(e.taskId)}</span>\` +
      \`<span class="detail">\` +
      \`<span class="recent-verb">\${escapeHtml(verbLabel)}</span>\${detail} — \` +
      \`<span class="recent-title">\${escapeHtml(e.title)}</span>\` +
      \`\${recentSpendHtml(e)}\${recentPrLinkHtml(e)}\${unavailable} · \` +
      \`<time class="recent-ts" datetime="\${escapeHtml(e.ts)}">\${escapeHtml(formatAgo(e.ts))}</time>\` +
      \`</span>\` +
      journeyButtonHtml(e.taskId)
    );
  }

  function renderRecent(entries) {
    const list = entries ?? [];
    // Keyed on taskId+ts+index (never bare taskId): the SAME task can carry many rows over
    // time (a verdict, a fix outcome, a spend checkpoint, …) -- an activity FEED, not one row
    // per task (W1-T156's DOM-stability reconciliation needs a key unique PER ROW, not per task).
    const rows = list.map((e, i) => ({ key: \`\${e.taskId}:\${e.ts}:\${i}\`, html: recentRowHtml(e), taskId: e.taskId }));
    reconcileRows(document.getElementById("recent-list"), rows, "no recent activity yet");
    return new Set(list.map((e) => e.taskId));
  }

  // ── everything else — the FIND layer (W1-T157): fuzzy search + faceted filters + sort ─────
  //
  // Client-side, instant, and URL-persisted. The FIND corpus is the WHOLE board (\`findTasks\`),
  // NOT just the "everything else" complement — the acceptance bar's facets (\`needs-me\`, plus
  // \`status\` values like running/merged that the priority sections above route away) must be able
  // to narrow to those tasks, and cmd+K must reach ANY task. The collapsed grouped-count line
  // still summarizes the complement (what is hidden below the four priority sections). The whole
  // view (search text + one value per facet + sort column/direction) round-trips through the URL
  // via history.replaceState, so a view is shareable/bookmarkable and survives reload.

  let findTasks = []; // the whole board — the searchable/filterable/sortable corpus

  // ── the ONE fuzzy scorer, shared by the FIND search bar AND the cmd+K palette ──────────────
  // Case-insensitive SUBSEQUENCE match over the haystack; returns null when the query is not a
  // subsequence (row hidden), else a score (higher = tighter, consecutive-run-weighted). An empty
  // query is a neutral match (score 0) — every row passes, natural order preserved.
  function fuzzyScore(query, text) {
    const q = String(query ?? "").trim().toLowerCase();
    if (!q) return 0;
    const s = String(text ?? "").toLowerCase();
    let qi = 0, score = 0, lastHit = -2;
    for (let si = 0; si < s.length && qi < q.length; si++) {
      if (s[si] === q[qi]) {
        score += si === lastHit + 1 ? 3 : 1; // reward adjacent matches (a tighter run scores higher)
        lastHit = si;
        qi++;
      }
    }
    return qi === q.length ? score : null;
  }

  // ── FIND view state (mirrored to/from the URL) ────────────────────────────────────────────
  const FIND_FACET_GROUPS = ["status", "workstream", "risk", "hasPr", "needsMe"];
  const findState = {
    q: "",
    facets: { status: null, workstream: null, risk: null, hasPr: false, needsMe: false },
    sort: "id",
    dir: "asc",
  };

  /** Workstream = the id prefix before \`-T\` (verified convention: W1/W2/W3/W12) — pure string parse. */
  function taskWorkstream(id) {
    const i = String(id).indexOf("-T");
    return i > 0 ? id.slice(0, i) : id;
  }
  function searchHaystack(t) {
    return \`\${t.taskId} \${t.title ?? ""}\`;
  }
  function passesSearch(t) {
    return fuzzyScore(findState.q, searchHaystack(t)) !== null;
  }
  /** Does task \`t\` match facet GROUP's value \`value\` (independent of what is currently selected)? */
  function facetValueMatches(t, group, value) {
    if (group === "status") return statusColorKey(t) === value;
    if (group === "workstream") return taskWorkstream(t.taskId) === value;
    if (group === "risk") return (t.risk ?? "") === value;
    if (group === "hasPr") return !!t.prUrl;
    if (group === "needsMe") return !!t.needsHuman;
    return true;
  }
  /** Does \`t\` satisfy a group's CURRENTLY-ACTIVE selection? (An unselected group matches everything.) */
  function facetActiveMatches(t, group) {
    const sel = findState.facets[group];
    if (group === "hasPr" || group === "needsMe") return sel ? facetValueMatches(t, group, true) : true;
    return sel ? facetValueMatches(t, group, sel) : true;
  }
  /** All active facets EXCEPT \`exceptGroup\` (used for a group's own live counts). */
  function matchesAllFacets(t, exceptGroup) {
    for (const g of FIND_FACET_GROUPS) {
      if (g === exceptGroup) continue;
      if (!facetActiveMatches(t, g)) return false;
    }
    return true;
  }
  /** The rendered set: findTasks passing the search AND every active facet. */
  function findFiltered() {
    return findTasks.filter((t) => passesSearch(t) && matchesAllFacets(t, null));
  }

  // ── sort comparators — the client-side MIRROR of board.ts's exported, unit-tested spec
  // (compareById/compareByStatus/compareByRecency/compareByAge/sortBoardRows). Kept structurally
  // identical; a missing recency/age value sorts LAST in BOTH directions. ─────────────────────
  const TASK_STATUSES = ["queued", "recon", "prompted", "running", "review", "fixing", "diagnosing", "blocked", "merged", "done"];
  function cmpMissingLast(av, bv, dir) {
    if (av === undefined && bv === undefined) return 0;
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    return dir === "desc" ? bv - av : av - bv;
  }
  function cmpById(a, b, dir) {
    const base = a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
    return dir === "desc" ? -base : base;
  }
  function cmpByStatus(a, b, dir) {
    const base = TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status);
    return dir === "desc" ? -base : base;
  }
  function cmpByRecency(a, b, dir) {
    const av = a.lastActivityAt ? Date.parse(a.lastActivityAt) : undefined;
    const bv = b.lastActivityAt ? Date.parse(b.lastActivityAt) : undefined;
    return cmpMissingLast(av, bv, dir);
  }
  function cmpByAge(a, b, dir) {
    return cmpMissingLast(a.elapsedMs, b.elapsedMs, dir);
  }
  const FIND_COMPARATORS = { id: cmpById, status: cmpByStatus, recency: cmpByRecency, age: cmpByAge };
  function sortFindRows(rows) {
    const cmp = FIND_COMPARATORS[findState.sort] ?? cmpById;
    return rows.slice().sort((a, b) => cmp(a, b, findState.dir) || cmpById(a, b, "asc"));
  }

  // ── URL round-trip: own a small key set, ALWAYS preserving \`token\` (+ any other params) ────
  function findHasUrlState() {
    const p = new URLSearchParams(window.location.search);
    return ["q", "status", "workstream", "risk", "hasPr", "needsMe", "sort", "dir"].some((k) => p.has(k));
  }
  function readFindStateFromUrl() {
    const p = new URLSearchParams(window.location.search);
    findState.q = p.get("q") ?? "";
    findState.facets.status = p.get("status") || null;
    findState.facets.workstream = p.get("workstream") || null;
    findState.facets.risk = p.get("risk") || null;
    findState.facets.hasPr = p.get("hasPr") === "1";
    findState.facets.needsMe = p.get("needsMe") === "1";
    findState.sort = p.get("sort") || "id";
    findState.dir = p.get("dir") === "desc" ? "desc" : "asc";
  }
  function writeFindStateToUrl() {
    const p = new URLSearchParams(window.location.search); // preserve token + anything else already there
    const set = (k, v) => { if (v) p.set(k, v); else p.delete(k); };
    set("q", findState.q.trim());
    set("status", findState.facets.status);
    set("workstream", findState.facets.workstream);
    set("risk", findState.facets.risk);
    set("hasPr", findState.facets.hasPr ? "1" : "");
    set("needsMe", findState.facets.needsMe ? "1" : "");
    set("sort", findState.sort !== "id" ? findState.sort : ""); // omit defaults -> cleaner URLs that still round-trip
    set("dir", findState.dir !== "asc" ? findState.dir : "");
    const qs = p.toString();
    history.replaceState(null, "", (qs ? "?" + qs : window.location.pathname) + window.location.hash);
  }

  // ── faceted filter controls with LIVE counts ──────────────────────────────────────────────
  function facetOptions(group) {
    const seen = new Set();
    for (const t of findTasks) {
      if (group === "status") seen.add(statusColorKey(t));
      else if (group === "workstream") seen.add(taskWorkstream(t.taskId));
      else if (group === "risk") seen.add(t.risk ?? "");
    }
    return [...seen].filter(Boolean).sort();
  }
  /** How many rows WOULD remain if this facet value were the group's selection (search + OTHER facets + this value). */
  function facetCount(group, value) {
    return findTasks.filter((t) => passesSearch(t) && matchesAllFacets(t, group) && facetValueMatches(t, group, value)).length;
  }
  function facetBtnHtml(group, value, label, active) {
    return \`<button type="button" class="facet-btn" data-group="\${group}" data-value="\${escapeHtml(value)}" aria-pressed="\${active ? "true" : "false"}">\${escapeHtml(label)} <span class="facet-count">(\${facetCount(group, value === "" ? true : value)})</span></button>\`;
  }
  function renderFacets() {
    const groups = [];
    for (const g of ["status", "workstream", "risk"]) {
      const opts = facetOptions(g);
      if (opts.length === 0) continue;
      const btns = opts.map((v) => facetBtnHtml(g, v, v, findState.facets[g] === v)).join("");
      groups.push(\`<span class="facet-group"><span class="facet-group-label">\${g}</span>\${btns}</span>\`);
    }
    // has-PR / needs-me are boolean toggles (a single value each).
    groups.push(\`<span class="facet-group"><span class="facet-group-label">flags</span>\${facetBtnHtml("hasPr", "", "has PR", findState.facets.hasPr)}\${facetBtnHtml("needsMe", "", "needs me", findState.facets.needsMe)}</span>\`);
    document.getElementById("find-facets").innerHTML = groups.join("");
  }

  function renderSortHeaders() {
    for (const btn of document.querySelectorAll("#find-sort .sort-header")) {
      const active = btn.dataset.sort === findState.sort;
      btn.setAttribute("aria-pressed", active ? "true" : "false");
      const arrow = active ? (findState.dir === "desc" ? " ▼" : " ▲") : "";
      btn.textContent = btn.dataset.sort + arrow;
    }
  }

  function findRowHtml(t) {
    return (
      \`\${statusBadge(statusColorKey(t))}<span class="task-id">\${escapeHtml(t.taskId)}</span>\` +
      \`<span class="detail">\${escapeHtml(t.title ?? "")}\${t.risk ? \` · risk: \${escapeHtml(t.risk)}\` : ""}\${prLink(t)}</span>\` +
      // W1-T158: the journey affordance rides on T157's row renderer. The FIND corpus REPLACED the
      // old rest-list corpus, so this is re-applied here rather than kept on the renderer this
      // merge dropped.
      journeyButtonHtml(t.taskId)
    );
  }
  function renderFindView() {
    renderFacets();
    renderSortHeaders();
    const filtered = findFiltered();
    const sorted = sortFindRows(filtered);
    const rows = sorted.slice(0, 500).map((t) => ({ key: t.taskId, html: findRowHtml(t), taskId: t.taskId }));
    reconcileRows(document.getElementById("rest-list"), rows, "no matching tasks");
    document.getElementById("find-count").textContent =
      \`\${filtered.length} match\${filtered.length === 1 ? "" : "es"} of \${findTasks.length} task\${findTasks.length === 1 ? "" : "s"}\`;
  }
  /** Re-render the FIND view AND persist the new state to the URL (one call per interaction). */
  function applyFindState() {
    if (!document.getElementById("rest-detail").hidden) renderFindView();
    writeFindStateToUrl();
  }

  function renderRest(tasks, shownIds) {
    findTasks = tasks; // the FIND corpus is the whole board (see the section header note)
    // The collapsed grouped-count line still summarizes the COMPLEMENT — "everything else" not
    // already surfaced in one of the four priority sections above.
    const complement = tasks.filter((t) => !shownIds.has(t.taskId));
    const queued = complement.filter((t) => statusColorKey(t) === "queued").length;
    const merged = complement.filter((t) => statusColorKey(t) === "merged").length;
    const other = complement.length - queued - merged;
    document.getElementById("rest-counts").textContent = \`queued: \${queued} · merged: \${merged} · other: \${other} (\${complement.length} total)\`;
    if (!document.getElementById("rest-detail").hidden) renderFindView();
  }

  function expandRest() {
    const detail = document.getElementById("rest-detail");
    if (!detail.hidden) return;
    detail.hidden = false;
    const toggle = document.getElementById("rest-toggle");
    toggle.setAttribute("aria-expanded", "true");
    toggle.textContent = "Collapse";
    renderFindView();
  }
  document.getElementById("rest-toggle").addEventListener("click", () => {
    const detail = document.getElementById("rest-detail");
    const toggle = document.getElementById("rest-toggle");
    const expanded = !detail.hidden;
    detail.hidden = expanded;
    toggle.setAttribute("aria-expanded", String(!expanded));
    toggle.textContent = expanded ? "Expand" : "Collapse";
    if (!expanded) renderFindView();
  });
  document.getElementById("find-search").addEventListener("input", (e) => {
    findState.q = e.target.value;
    applyFindState();
  });
  document.getElementById("find-facets").addEventListener("click", (e) => {
    const btn = e.target.closest(".facet-btn");
    if (!btn) return;
    const g = btn.dataset.group;
    const v = btn.dataset.value;
    if (g === "hasPr" || g === "needsMe") findState.facets[g] = !findState.facets[g];
    else findState.facets[g] = findState.facets[g] === v ? null : v; // single-select: click again to clear
    applyFindState();
  });
  document.getElementById("find-sort").addEventListener("click", (e) => {
    const btn = e.target.closest(".sort-header");
    if (!btn) return;
    const key = btn.dataset.sort;
    if (findState.sort === key) findState.dir = findState.dir === "asc" ? "desc" : "asc";
    else { findState.sort = key; findState.dir = key === "recency" || key === "age" ? "desc" : "asc"; }
    applyFindState();
  });

  // Restore FIND state from the URL BEFORE first paint, so a fresh navigation to a shared URL
  // renders that exact view with no interaction (and auto-expands the section so its rows show).
  readFindStateFromUrl();
  document.getElementById("find-search").value = findState.q;
  renderSortHeaders();
  if (findHasUrlState()) expandRest();

  // ── cmd+K COMMAND PALETTE — global, reachable from every view ──────────────────────────────
  // Each action fires through the EXACT existing button (one implementation of each action, never
  // a copy) — including STOP's two-click confirm, which is NOT bypassed (a single palette STOP
  // only arms the confirm, exactly like a single click on the STOP button).
  const CMDK_ACTIONS = [
    { id: "pause", label: "Pause fleet", run: () => document.getElementById("pause-btn").click() },
    { id: "resume", label: "Resume fleet", run: () => document.getElementById("resume-btn").click() },
    { id: "stop", label: "STOP fleet", run: () => document.getElementById("stop-btn").click() },
    { id: "feedback", label: "Feedback inbox", run: () => document.getElementById("feedback-btn").click() },
    { id: "graph", label: "Plan→task→PR graph", run: () => document.getElementById("graph-btn").click() },
  ];
  let cmdkData = [];
  let cmdkActive = 0;

  function cmdkBuildResults(query) {
    const out = [];
    for (const a of CMDK_ACTIONS) {
      const sc = fuzzyScore(query, \`\${a.label} action\`);
      if (sc !== null) out.push({ type: "action", id: a.id, label: a.label, score: sc });
    }
    for (const t of tasksById.values()) {
      const sc = fuzzyScore(query, searchHaystack(t));
      if (sc !== null) out.push({ type: "task", taskId: t.taskId, label: \`\${t.taskId} — \${t.title ?? ""}\`, score: sc + 1 });
      if (t.prUrl) {
        const psc = fuzzyScore(query, \`\${t.taskId} pr \${t.prNumber ?? ""}\`);
        if (psc !== null) out.push({ type: "pr", taskId: t.taskId, prUrl: t.prUrl, label: \`Open PR \${t.prNumber !== undefined ? "#" + t.prNumber : t.prUrl} · \${t.taskId}\`, score: psc });
      }
    }
    out.sort((a, b) => b.score - a.score || String(a.label).localeCompare(String(b.label)));
    return out.slice(0, 40);
  }
  function cmdkRender(query) {
    cmdkData = cmdkBuildResults(query);
    cmdkActive = 0;
    const ul = document.getElementById("cmdk-results");
    if (cmdkData.length === 0) { ul.innerHTML = '<li class="cmdk-empty">no matches</li>'; return; }
    ul.innerHTML = cmdkData
      .map((r, i) => \`<li class="cmdk-item\${i === cmdkActive ? " active" : ""}" role="option" aria-selected="\${i === cmdkActive}" data-i="\${i}"><span class="cmdk-kind">\${r.type === "action" ? "ACTION" : r.type === "pr" ? "PR" : "TASK"}</span> \${escapeHtml(r.label)}</li>\`)
      .join("");
  }
  function cmdkMove(delta) {
    if (cmdkData.length === 0) return;
    cmdkActive = (cmdkActive + delta + cmdkData.length) % cmdkData.length;
    const items = document.querySelectorAll("#cmdk-results .cmdk-item");
    items.forEach((el, i) => {
      el.classList.toggle("active", i === cmdkActive);
      el.setAttribute("aria-selected", String(i === cmdkActive));
      if (i === cmdkActive) el.scrollIntoView({ block: "nearest" });
    });
  }
  function cmdkOpen() {
    const overlay = document.getElementById("cmdk-overlay");
    overlay.hidden = false;
    const input = document.getElementById("cmdk-input");
    input.value = "";
    cmdkRender("");
    input.focus();
  }
  function cmdkClose() {
    document.getElementById("cmdk-overlay").hidden = true;
  }
  function cmdkActivate(i) {
    const r = cmdkData[i];
    if (!r) return;
    if (r.type === "action") {
      const a = CMDK_ACTIONS.find((x) => x.id === r.id);
      cmdkClose();
      a.run();
    } else if (r.type === "pr") {
      cmdkClose();
      window.open(r.prUrl, "_blank", "noreferrer");
    } else {
      jumpToTask(r.taskId);
    }
  }
  /** "Jump to" a task: expand the section, filter the FIND search to its id, scroll + highlight. */
  function jumpToTask(taskId) {
    cmdkClose();
    expandRest();
    findState.q = taskId;
    document.getElementById("find-search").value = taskId;
    applyFindState();
    requestAnimationFrame(() => {
      const li = [...document.getElementById("rest-list").children].find((el) => el.dataset && el.dataset.key === taskId);
      if (li) {
        li.scrollIntoView({ block: "center" });
        flashRow(li);
      }
    });
  }
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault(); // never let the browser's own Cmd/Ctrl+K (address bar) swallow it
      if (document.getElementById("cmdk-overlay").hidden) cmdkOpen();
      else cmdkClose();
      return;
    }
    if (e.key === "Escape" && !document.getElementById("cmdk-overlay").hidden) cmdkClose();
  });
  document.getElementById("cmdk-input").addEventListener("input", (e) => cmdkRender(e.target.value));
  document.getElementById("cmdk-input").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); cmdkMove(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); cmdkMove(-1); }
    else if (e.key === "Enter") { e.preventDefault(); cmdkActivate(cmdkActive); }
  });
  document.getElementById("cmdk-results").addEventListener("click", (e) => {
    const li = e.target.closest(".cmdk-item");
    if (!li) return;
    cmdkActivate(Number(li.dataset.i));
  });
  document.getElementById("cmdk-overlay").addEventListener("click", (e) => {
    if (e.target.id === "cmdk-overlay") cmdkClose(); // click the backdrop to dismiss
  });

  // ── NEEDS ME row actions (event delegation — rows are re-rendered on every refresh) ─────
  document.getElementById("needs-me-list").addEventListener("submit", async (e) => {
    const answerForm = e.target.closest(".needs-me-answer");
    if (!answerForm) return;
    e.preventDefault();
    const replyTo = answerForm.dataset.replyTo;
    const answer = answerForm.querySelector("input").value.trim();
    await postJson("/v1/feedback", { text: answer, replyTo });
    refreshAll();
  });
  document.getElementById("needs-me-list").addEventListener("click", async (e) => {
    const decideBtn = e.target.closest(".needs-me-decide");
    const markHandledBtn = e.target.closest(".needs-me-mark-handled");
    if (decideBtn) {
      await postJson("/v1/feedback/decision", { id: decideBtn.dataset.id, decision: decideBtn.dataset.decision });
      refreshAll();
    } else if (markHandledBtn) {
      // W1-T182: the escalation's own issue_url rides on the row's data attribute -- never an
      // operator-typed input, since the ledger (and now the live join) already holds it.
      await postJson("/v1/escalation/mark-handled", { taskId: markHandledBtn.dataset.taskId, issueUrl: markHandledBtn.dataset.issueUrl });
      refreshAll();
    }
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
  // ── W1-T158 DETAIL layer: the row-click task CARD ───────────────────────────────────────────
  // title/rationale/acceptance criteria/dependency chain (each dep LINKED)/run history (cost +
  // verdict)/PR links -- from ONE GET /v1/task?id= fetch, zero further GitHub calls (see
  // lib/task-card.ts's header). Dep links recurse through openCard, never a page navigation.
  function costLabel(costUsd) {
    return typeof costUsd === "number" ? \`$\${costUsd.toFixed(3)}\` : "—";
  }
  function runRowHtml(run) {
    const pr = run.prUrl ? \` · <a href="\${escapeHtml(run.prUrl)}" target="_blank" rel="noreferrer">PR</a>\` : "";
    return \`<li><code>\${escapeHtml(run.runId)}</code> — \${escapeHtml(run.verdict ?? "no verdict yet")} · \${costLabel(run.costUsd)}\${pr}</li>\`;
  }
  function acceptanceRowHtml(c) {
    return \`<li><strong>\${escapeHtml(c.claim)}</strong><div class="detail">proof: \${escapeHtml(c.proof)}</div></li>\`;
  }
  function depChainHtml(deps) {
    if (!deps.length) return '<p class="empty">no dependencies</p>';
    return \`<ul class="row-list">\${deps
      .map((d) => \`<li><button type="button" class="card-dep-link" data-dep-id="\${escapeHtml(d)}">\${escapeHtml(d)}</button></li>\`)
      .join("")}</ul>\`;
  }
  function taskCardHtml(card) {
    const key = statusColorKey({ status: card.status, needsHuman: false });
    return (
      \`<p>\${statusBadge(key)}\${card.merged ? " ✓ merged" : ""}\${prLink({ prUrl: card.prUrl, prNumber: card.prNumber })}</p>\` +
      (card.rationale ? \`<p class="detail">\${escapeHtml(card.rationale)}</p>\` : '<p class="empty">no rationale recorded</p>') +
      \`<h3>Acceptance criteria</h3>\${
        card.acceptance.length ? \`<ul class="row-list">\${card.acceptance.map(acceptanceRowHtml).join("")}</ul>\` : '<p class="empty">none recorded</p>'
      }\` +
      \`<h3>Dependency chain</h3>\${depChainHtml(card.dependsOn)}\` +
      \`<h3>Run history</h3>\${
        card.runs.length ? \`<ul class="row-list">\${card.runs.map(runRowHtml).join("")}</ul>\` : '<p class="empty">no runs yet</p>'
      }\` +
      \`<p><button type="button" id="card-journey-btn" data-task-id="\${escapeHtml(card.id)}">Open journey</button></p>\`
    );
  }
  async function openCard(taskId) {
    const section = document.getElementById("task-detail");
    const title = document.getElementById("task-detail-title");
    const body = document.getElementById("task-detail-body");
    section.hidden = false;
    title.textContent = \`Task \${taskId}\`;
    body.textContent = "loading…";
    try {
      const data = await getJson(\`/v1/task?id=\${encodeURIComponent(taskId)}\`);
      const card = data.card;
      title.textContent = \`\${card.id} — \${card.title}\`;
      body.innerHTML = taskCardHtml(card);
    } catch (e) {
      body.textContent = \`card fetch failed: \${e}\`;
    }
    section.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  document.getElementById("task-detail-close").addEventListener("click", () => {
    document.getElementById("task-detail").hidden = true;
  });
  document.getElementById("task-detail-body").addEventListener("click", (e) => {
    const depBtn = e.target.closest(".card-dep-link");
    if (depBtn) { openCard(depBtn.dataset.depId); return; }
    const journeyBtn = e.target.closest("#card-journey-btn");
    if (journeyBtn) openJourney(journeyBtn.dataset.taskId);
  });

  // ── W1-T158 JOURNEY layer: rmd trace's own provenance chain (W1-T43), reached ONLY via a
  // per-row action or an in-card link -- never a typed id (the v0 panel this retires). Mirrors
  // apps/dashboard/src/main.ts's renderTraceGraph shape (the SAME GET /v1/trace response), plus
  // ONE addition: a run whose verdict starts with "blocked" is marked .journey-fail -- the
  // FAILING step an operator walks backwards from an outcome to find.
  function journeyRunHtml(run) {
    const failing = typeof run.verdict === "string" && run.verdict.startsWith("blocked");
    const marker = failing ? ' <span class="journey-fail">⛔ BLOCKING STEP</span>' : "";
    const pr = run.prUrl
      ? \`<ul><li><a href="\${escapeHtml(run.prUrl)}" target="_blank" rel="noreferrer">PR</a>\${run.prState ? \` [\${escapeHtml(run.prState)}]\` : ""} — sha \${escapeHtml(run.mergeSha ?? "(not merged yet)")}</li></ul>\`
      : "";
    // NOTE: the ".journey-fail" class lives ONLY on the marker <span> above, never also on this
    // wrapping <li> -- a caller counting ".journey-fail" elements must count exactly ONE per
    // failing run, not two nested matches for the same run.
    return \`<li>run \${escapeHtml(run.runId)}: \${escapeHtml(run.verdict ?? "no verdict yet")}\${marker}\${pr}</li>\`;
  }
  function journeyTaskHtml(t) {
    const runs = (t.runs ?? []).length ? \`<ul>\${t.runs.map(journeyRunHtml).join("")}</ul>\` : "<ul><li>(no runs yet)</li></ul>";
    return \`<li>task <button type="button" class="journey-task-link" data-task-id="\${escapeHtml(t.id)}">\${escapeHtml(t.id)}</button>: \${escapeHtml(t.title)}\${
      t.origin ? \` (origin: \${escapeHtml(t.origin)})\` : ""
    }\${runs}</li>\`;
  }
  function journeyHtml(chain) {
    const feedback = chain.feedback
      ? \`<p>feedback#\${escapeHtml(chain.feedback.id)} [\${escapeHtml(chain.feedback.status)}] — \${escapeHtml(chain.feedback.raw)}\${
          chain.feedback.proposalPr ? \` → <a href="\${escapeHtml(chain.feedback.proposalPr)}" target="_blank" rel="noreferrer">proposal PR</a>\` : ""
        }</p>\`
      : "";
    const tasks = (chain.tasks ?? []).length ? \`<ul>\${chain.tasks.map(journeyTaskHtml).join("")}</ul>\` : "<p>(no tasks yet)</p>";
    return \`<p>direction: \${escapeHtml(chain.direction)}</p>\${feedback}\${tasks}\`;
  }
  async function openJourney(id) {
    const section = document.getElementById("journey-view");
    const title = document.getElementById("journey-title");
    const body = document.getElementById("journey-body");
    section.hidden = false;
    title.textContent = \`Journey: \${id}\`;
    body.textContent = "loading…";
    try {
      const data = await getJson(\`/v1/trace?id=\${encodeURIComponent(id)}\`);
      body.innerHTML = journeyHtml(data.chain);
    } catch (e) {
      body.textContent = \`journey fetch failed: \${e}\`;
    }
    section.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  document.getElementById("journey-close").addEventListener("click", () => {
    document.getElementById("journey-view").hidden = true;
  });
  document.getElementById("journey-body").addEventListener("click", (e) => {
    const btn = e.target.closest(".journey-task-link");
    if (btn) openCard(btn.dataset.taskId);
  });

  // ── PER-ROW AFFORDANCE: every task row's own Journey button opens THAT row's journey; a
  // click anywhere else on a task row (never on an interior <a>/<button>/<input>/<form>/<label>,
  // so existing NEEDS ME approve/answer controls and PR links keep working unchanged) expands
  // that row's own card. Both are keyed on the row's OWN data-task-id -- never a typed id. ──────
  document.querySelector("main").addEventListener("click", (e) => {
    const journeyBtn = e.target.closest(".row-journey-btn");
    if (journeyBtn) {
      openJourney(journeyBtn.dataset.taskId);
      return;
    }
    if (e.target.closest("a, button, input, form, label")) return;
    const row = e.target.closest(".row[data-task-id]");
    if (row) openCard(row.dataset.taskId);
  });

  // ── W1-T156 TRUST: freshness stamp + the poll's own error-state LIFECYCLE. A fetch failure is
  // TRANSIENT ("reconnecting…", the last-success time named) until \${STALE_ESCALATE_AFTER}
  // CONSECUTIVE failures — only then does the board escalate to the stale/disconnected state
  // (reusing the SAME stale-badge/data-stale mechanism W1-T154's cache-restore already
  // established, so "data may be stale" has exactly ONE visual vocabulary regardless of WHICH
  // staleness caused it). The banner is DERIVED from poll state on every call, never a latched
  // string a later success forgets to clear — the falsifier this fixes: an operator-observed
  // "board fetch failed" banner that survived subsequent SUCCESSFUL polls beside live data. ────
  const STALE_ESCALATE_AFTER = 3;
  let pollFailures = 0;
  let lastSuccessAt = null;
  let lastLiveAt = null; // last successful data of ANY kind -- a poll success OR an SSE event.

  function touchFreshness() {
    lastLiveAt = Date.now();
  }
  function tickFreshness() {
    const el = document.getElementById("freshness");
    if (!lastLiveAt) {
      el.textContent = "";
      return;
    }
    const secs = Math.max(0, Math.round((Date.now() - lastLiveAt) / 1000));
    el.textContent = secs < 2 ? "updated just now" : \`updated \${secs}s ago\`;
  }

  function handlePollFailure() {
    pollFailures += 1;
    const topStatus = document.getElementById("top-status");
    if (pollFailures < STALE_ESCALATE_AFTER) {
      // TRANSIENT: last-known-good data stays on screen, UNMARKED -- only the top-status line
      // itself says "reconnecting", carrying the last-success time. Never a persistent error
      // banner; the very next successful poll below clears this unconditionally.
      topStatus.textContent = \`reconnecting… (last success \${lastSuccessAt ? \`\${formatElapsed(Date.now() - lastSuccessAt)} ago\` : "never"})\`;
      topStatus.dataset.pollState = "reconnecting";
    } else {
      // ESCALATED: N consecutive failures -- the board itself is now visibly stamped stale,
      // never silently old (reuses the cache-restore path's own stale-badge mechanism).
      topStatus.dataset.pollState = "stale";
      markStale(lastSuccessAt ? new Date(lastSuccessAt).toISOString() : undefined);
    }
  }

  // ── the poll loop: the fallback/resync transport, driving UP NEXT/RECENT/feedback/inbox/
  // fleet-control read-back (none of which the SSE stream below carries) plus a periodic
  // full-snapshot resync of the task-status truth. W1-T156 DELTA-DRIVEN: task-status ROW
  // updates are primarily driven by the SSE subscription below (subscribeStatusStream), which
  // patches ONE row in place per flip via the SAME ingestProjection/paintFromTasksById this poll
  // also funnels through -- so a poll landing on already-current data is a cheap no-op
  // (reconcileRows content-diffs), never a wholesale re-render.
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
      handlePollFailure();
      return;
    }
    pollFailures = 0;
    lastSuccessAt = Date.now();
    touchFreshness();
    const tasks = statusSnap.tasks ?? [];
    for (const t of tasks) ingestProjection(t);
    paintFromTasksById();

    try {
      const [recentSnap, upNextSnap, feedbackSnap, inboxSnap, controlStatus] = await Promise.all([
        getJson("/v1/recent").catch(() => ({ entries: [] })),
        getJson("/v1/drain/preview?max=5").catch(() => ({ cards: [] })),
        getJson("/v1/feedback").catch(() => ({ entries: [] })),
        getJson("/v1/inbox").catch(() => ({ ready: [] })),
        getJson("/v1/control/status").catch(() => ({ paused: false, stopped: false, quietHours: false })),
      ]);
      latestFeedbackEntries = feedbackSnap.entries ?? [];
      latestInboxReady = inboxSnap.ready ?? [];
      latestUpNextCards = upNextSnap.cards ?? [];
      latestRecentEntries = recentSnap.entries ?? [];
      paintFromTasksById(); // re-run NOW/NEEDS ME/rest now that feedback/inbox/up-next/recent are current
      applyControlStatus(controlStatus);
      document.getElementById("top-status").textContent = \`updated \${formatTimestamp(statusSnap.generated_at ?? new Date().toISOString())}\`;
      document.getElementById("top-status").dataset.pollState = "ok";
      clearStale(); // a completed live refresh always supersedes whatever the cache/failure-escalation painted

      writeSnapshotCache({
        generated_at: statusSnap.generated_at,
        tasks,
        recentEntries: latestRecentEntries,
        upNextCards: latestUpNextCards,
        feedbackEntries: latestFeedbackEntries,
        inboxReady: latestInboxReady,
        controlStatus,
      });
    } catch (e) {
      handlePollFailure();
    }
  }

  // ── W1-T156 DELTA-DRIVEN SSE: consume GET /v1/status/stream via \`fetch\`, NOT the browser's
  // native EventSource -- EventSource cannot set an Authorization header, and this stream is
  // bearer-scoped exactly like every other /v1/* route (no query-token fallback; service.ts's
  // header only). Mirrors packages/api-client's own \`subscribeStatus\` byte-stream SSE parser
  // (the SAME \`event:\`/\`data:\` framing service.ts's openSse sends) rather than re-implementing
  // a second parser — this shell has no bundler to import that package from, so the same
  // technique is inlined here. Auto-reconnects with a short backoff on drop, and reports its
  // OWN connection lifecycle via \`onState\` ("connecting" | "connected" | "disconnected") so the
  // console can say so — never silently keep claiming "live" once the stream is gone. */
  function parseSseFrame(frame) {
    let event;
    const dataLines = [];
    for (const line of frame.split("\\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
    }
    if (!event || dataLines.length === 0) return undefined;
    return { event, data: dataLines.join("\\n") };
  }

  function subscribeStatusStream(onEvent, onState) {
    let stopped = false;
    let controller;

    async function connectOnce() {
      controller = new AbortController();
      onState("connecting");
      let res;
      try {
        res = await fetch("/v1/status/stream", { headers: authHeaders, signal: controller.signal });
      } catch {
        if (!stopped) onState("disconnected");
        return;
      }
      if (!res.ok || !res.body) {
        onState("disconnected");
        return;
      }
      onState("connected");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep;
          while ((sep = buffer.indexOf("\\n\\n")) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const parsed = parseSseFrame(frame);
            if (parsed && parsed.event === "status") onEvent(JSON.parse(parsed.data));
          }
        }
      } catch {
        // aborted (unsubscribe) or the connection dropped -- either way, fall through below.
      }
      if (!stopped) onState("disconnected");
    }

    (async function loop() {
      while (!stopped) {
        await connectOnce();
        if (stopped) break;
        await new Promise((resolve) => setTimeout(resolve, 1500)); // brief backoff before reconnecting
      }
    })();

    return () => {
      stopped = true;
      controller?.abort();
    };
  }

  function setConnectionState(state) {
    const el = document.getElementById("connection-indicator");
    el.dataset.state = state;
    el.innerHTML =
      state === "connected"
        ? '<span class="dot" aria-hidden="true"></span> live'
        : state === "connecting"
          ? '<span class="dot" aria-hidden="true"></span> connecting…'
          : '<span class="dot" aria-hidden="true"></span> disconnected — reconnecting…';
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
  setInterval(tickElapsed, 1000);
  setInterval(tickFreshness, 1000);
  subscribeStatusStream(
    (projection) => {
      ingestProjection(projection);
      paintFromTasksById();
      touchFreshness();
    },
    (state) => setConnectionState(state),
  );
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
function buildShellRoute(phaseElapsedThresholdsMs: Record<string, number>): Route {
  return {
    method: "GET",
    path: "/",
    scope: "read",
    allowQueryToken: true,
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderShellHtml(phaseElapsedThresholdsMs));
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
    buildEscalationMarkHandledRoute(fleetControlDeps),
    ...buildPanelGraphRoutes(panelGraphDeps),
    buildTaskCardRoute(deps.board),
    buildShellRoute(deps.phaseElapsedThresholdsMs ?? DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS),
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

/** Loopback. The default bind: reachable from this machine and from nothing else. */
export const DEFAULT_SERVE_HOST = "127.0.0.1";

/**
 * Wildcard binds, refused by name. `server.listen(port)` with no host defaults to `::`, which
 * accepts from EVERY interface — which is what `rmd serve` actually did while printing
 * "listening on http://localhost:4317". Anyone on any network the host is attached to could
 * reach the console, and the only thing between them and fleet-control write actions was a
 * bearer token that the same command printed to a world-readable log.
 */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "*", ""]);

/**
 * Resolve the interface `rmd serve` binds to: `--host <addr>`, else `RMD_SERVE_HOST`, else
 * loopback. A wildcard is REFUSED rather than silently accepted — exposure must be a thing
 * someone typed, naming the interface they meant.
 *
 * Remote access is expressed by naming the interface, not by opening all of them. This fleet is
 * reached from the operator's phone over Tailscale, so the tailnet address is the correct value
 * here (`RMD_SERVE_HOST=100.x.y.z`) — that keeps the console on an authenticated, encrypted
 * overlay instead of on every coffee-shop LAN the laptop joins.
 */
export function resolveServeHosts(rest: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const idx = rest.indexOf("--host");
  const raw = idx >= 0 ? rest[idx + 1] : env.RMD_SERVE_HOST;
  if (raw === undefined) return [DEFAULT_SERVE_HOST];
  const hosts = raw
    .split(",")
    .map((h) => h.trim())
    .filter((h, i, all) => all.indexOf(h) === i);
  // An all-empty value (",", "  ") must not silently collapse to "listen nowhere" — that would
  // read as a working server that answers no one. Fall through to the wildcard check below,
  // which names the empty string, so the operator gets a message rather than a silent no-op.
  if (hosts.length === 0) hosts.push("");
  for (const host of hosts) assertBindableHost(host, raw);
  return hosts;
}

/**
 * SINGLE-HOST CONVENIENCE, retained because most callers want one address. Returns the FIRST
 * resolved host — never a wildcard, since {@link resolveServeHosts} has already refused those.
 */
export function resolveServeHost(rest: string[], env: NodeJS.ProcessEnv = process.env): string {
  return resolveServeHosts(rest, env)[0] as string;
}

function assertBindableHost(host: string, raw: string): void {
  if (WILDCARD_HOSTS.has(host)) {
    throw new Error(
      `--host ${JSON.stringify(raw)} binds EVERY interface. Name the interface(s) you mean ` +
        `(e.g. ${DEFAULT_SERVE_HOST} for local only, or "${DEFAULT_SERVE_HOST},<tailnet-ip>" ` +
        `to keep the console reachable locally AND from the phone).`,
    );
  }
  if (host.startsWith("--")) {
    throw new Error(`--host expects an address, got the flag ${JSON.stringify(raw)}`);
  }
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
 *
 * ROTATION (previously undocumented, which made it effectively absent — R-31). Because this is
 * create-once/read-thereafter, rotation is: stop `rmd serve`, delete the file, start it again.
 * The next start mints a fresh pair at 0600.
 *
 *     lsof -ti :4317 | xargs kill
 *     rm ~/Remudero/state/service-tokens.json
 *     rmd serve            # prints the new console URL
 *
 * Rotate whenever a token has been exposed — and note that MERELY RUNNING `rmd serve` used to
 * expose both, because it printed them to stdout, which under the operator's launch is
 * redirected to a world-readable `serve.log`. Any token that reached a log, a terminal
 * transcript, or a chat window is compromised and must be rotated, not merely un-shared.
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
