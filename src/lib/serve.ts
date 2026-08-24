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

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { createOrReadExclusive } from "./fs-race-safe.js";
import {
  assertWriteTiersComplete,
  createConfirmNonceStore,
  createService,
  makeConfirmNonceRoute,
  type ConfirmNonceStore,
  type Method,
  type Route,
  type Scope,
  type ServiceOptions,
  type ServiceTokens,
  type SseRoute,
} from "./service.js";
import { buildRecentRoute, buildStatusRoute, buildStatusStream, DEFAULT_POLL_MS, type BoardDeps } from "./board.js";
import type { GitHub } from "./status.js";
import {
  buildAnswerQuestionRoute,
  buildApproveManualRoute,
  buildControlStatusRoute,
  buildDrainFeedbackRoute,
  buildDrainNowRoute,
  buildEscalationMarkHandledRoute,
  buildKickRoute,
  buildPauseRoute,
  buildQuietHoursRoute,
  buildResumeRoute,
  buildStopRoute,
  sendJson,
  type ControlStatusDeps,
  type IssueCloser,
  type PanelActionDeps,
} from "./panel-actions.js";
import { buildPanelGraphRoutes, ratifyCliGateway, type PanelGraphDeps } from "./panel-graph.js";
import { buildPanelSkillsRoutes } from "./panel-skills.js";
import { buildPanelSkillRunRoutes } from "./panel-skill-run.js";
import { buildTaskCardRoute } from "./task-card.js";
import { buildAddOperatorNoteRoute, buildListOperatorNotesRoute } from "./operator-notes.js";
import { createLastSeenStore, lastSeenPath, type LastSeenStore } from "./last-seen.js";
import { buildDaemonHealthRoute, type DaemonHealthDeps } from "./daemon-health.js";
import { buildAccountUsageRoute, type AccountUsageDeps } from "./account-usage.js";
import { buildAnalyticsRoute, type AnalyticsRouteDeps } from "./analytics-route.js";
import { resolveFreshness } from "./console-freshness.js";
import { readIdleReasons, renderIdleReasonsHtml } from "./idle-reasons-panel.js";
import { readLedgerLines } from "./status.js";

/** Default `rmd serve` port — matches apps/dashboard/src/main.ts's own `?daemon=` default (`http://localhost:4317`), so the shipped dashboard points at a served daemon out of the box. */
export const DEFAULT_SERVE_PORT = 4317;

export interface ServeDeps {
  /** Injectable ONLY so a unit test can pin the captured sha; real callers omit it and get
   *  {@link resolveConsoleSha}, resolved once at server start. */
  consoleSha?: string;
  board: BoardDeps;
  /**
   * `plan/feedback/` + `plan/tasks.yaml` root and GitHub trace gateway (panel-graph.ts).
   * Deliberately `Omit<..., "inboxRoot">` — {@link buildServeRoutes} supplies `inboxRoot`
   * itself (= `fleetControlRoot`, config.root) the SAME way it already splits `fleetControlRoot`
   * vs `questionsRoot` for panel-actions.ts, so a `ServeDeps` caller names each root exactly
   * once, never a duplicate that could drift from `fleetControlRoot`.
   *
   * `ratify` is likewise OPTIONAL here (W1-T193): {@link buildServeRoutes} defaults it to a REAL
   * {@link ratifyCliGateway} rooted at `panelGraph.root` + `<fleetControlRoot>/state/logs` when
   * the caller doesn't supply one — the same "the assembler wires the real gateway, a test
   * injects a fake" split `inboxRoot` above already follows, so `rmd serve`'s own CLI wiring
   * (run-task.ts's `serveCommand`) never has to construct this gateway itself, and a test can
   * still inject a fake by supplying `ratify` explicitly.
   */
  panelGraph: Omit<PanelGraphDeps, "inboxRoot" | "ratify"> & { ratify?: PanelGraphDeps["ratify"] };
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
  /**
   * W1-T163: the per-token "since you last checked" marker store (lib/last-seen.ts), shared with
   * `rmd digest`'s own marker-aware send (lib/digest.ts's `sendMarkerAwareDigest`) so a pushed
   * digest and the console's pulled recap read/advance the SAME per-token state — "push and pull
   * tell one story." OPTIONAL here the same way `panelGraph.ratify` is (see that field's own
   * doc): {@link buildServeRoutes} defaults it to a REAL store rooted at `<fleetControlRoot>/
   * state/last-seen.json` when the caller doesn't supply one, so `rmd serve`'s CLI wiring never
   * has to construct it itself, and a test can still inject a fake by supplying it explicitly.
   */
  lastSeen?: LastSeenStore;
  /**
   * W1-T159: the GLANCE layer's daemon-health widget deps (disk-free path + injectable
   * statfs/gh-exec/clock — see daemon-health.ts's own doc for each field's real source).
   * OPTIONAL and defaults to `diskPath: fleetControlRoot` with the real `fs.statfsSync`/real
   * `gh api rate_limit` when the caller doesn't supply one — the SAME "the assembler wires the
   * real gateway, a test injects a fake" split every other optional ServeDeps field already
   * follows (see `panelGraph.ratify`/`lastSeen`'s own docs, above).
   */
  daemonHealth?: Omit<DaemonHealthDeps, "ledgerPath" | "diskPath"> & { diskPath?: string };
  /**
   * W1-T288: GET /v1/control/status's daemon-liveness verdict deps (injectable ledger reader /
   * clock / liveness bound — see panel-actions.ts's `ControlStatusDeps` for each field's real
   * source). OPTIONAL and defaults to the real `readLedgerLines`/`Date.now`/
   * `DEFAULT_LIVENESS_BOUND_MS` when the caller doesn't supply one, the SAME "the assembler
   * wires the real thing, a test injects a fake" split `daemonHealth` above already follows.
   */
  controlStatus?: Omit<ControlStatusDeps, "root" | "ledgerPath">;
  /**
   * The ACCOUNT strip's deps (see account-usage.ts's header). OPTIONAL and defaults to the real
   * `~/.claude.json` + `Date.now`, exactly like `daemonHealth` above — the assembler wires the
   * real reader, a test injects a captured one. The `ledgerPath` half is always the console's own,
   * never a caller's, so the governor posture can never come from a different ledger than the
   * rest of the page.
   */
  accountUsage?: Omit<AccountUsageDeps, "ledgerPath">;
  /**
   * W1-T477: `GET /v1/analytics`'s deps (see analytics-route.ts's header). OPTIONAL and defaults
   * to a real rotation-union read against the real filesystem, the same "the assembler wires the
   * real thing, a test injects a fake" split every other optional field here already follows. The
   * `ledgerPath` half is always the console's own — see {@link accountUsage}'s doc immediately
   * above for why that is never a caller-supplied override.
   */
  analytics?: Omit<AnalyticsRouteDeps, "ledgerPath">;
  /**
   * W1-T371: additive tailnet-identity auth — forwarded verbatim to `createService`'s
   * `identity` option (see service.ts's {@link IdentityAuth} for the two gates it enforces).
   * OPTIONAL and omitted by default: an install that never sets `config.serve.identityCapability`
   * (see serveCommand, run-task.ts) gets identity never consulted at all — byte-for-byte the
   * pre-W1-T371 token-only behavior, so a Tailscale failure (or simply never opting in) degrades
   * to the token rather than locking the operator out.
   */
  identity?: ServiceOptions["identity"];
  /**
   * W1-T500: the {@link ConfirmNonceStore} both `POST /v1/confirm` (mounted by
   * {@link buildServeRoutes}) and `createService`'s own dispatch (`enforceWriteTiers`'s HIGH-tier
   * check) must consult -- the SAME instance, or a route issuing into one store and a dispatch
   * consuming from another would refuse every nonce it just issued. {@link buildServeServer}
   * resolves this ONCE (a fresh {@link createConfirmNonceStore} when omitted) and threads that one
   * instance to both. OPTIONAL here the same way `lastSeen` above is: a test can inject its own to
   * assert on a known nonce; `rmd serve`'s own CLI wiring never has to construct one itself.
   */
  confirmNonces?: ConfirmNonceStore;
  /**
   * W1-T945: `GET /v1/peek`'s read root + liveness predicate. `root` defaults to
   * `fleetControlRoot` (config.root) — the SAME root W1-T942's tail writer resolves
   * `state/runs/<runId>.tail` against (`buildWorkerStateSensor`, run-task.ts), never a second
   * root. `isLive` defaults to a predicate that never claims LIVE, so a caller that omits it (a
   * bare test) gets an honest FINISHED rather than a fabricated liveness signal. Real wiring
   * (`serveCommand`, run-task.ts) always supplies `isLive` as a closure over the REAL
   * `liveInflightRuns` — the SAME pid-checked read every other liveness decision in this
   * codebase uses (design note ii), never a second definition of "in flight" declared here.
   */
  peek?: { root?: string; isLive?: (runId: string) => boolean };
}

/** Matches {@link buildBatchedGithub}'s own default `ttlMs` (status.ts) — kept as one named
 *  constant here rather than a bare literal so the two stay visibly the same number. */
export const DEFAULT_BOARD_PREWARM_MS = 15_000;

/**
 * W1-T999 — the serve board gateway's poll TTL, DERIVED FROM THE SWEEP DISTRIBUTION rather than
 * matching {@link buildBatchedGithub}'s bare 15s default the way {@link DEFAULT_BOARD_PREWARM_MS}
 * does. THE INCIDENT: `serveCommand` (run-task.ts) built its board gateway at that bare 15s
 * default against an always-on console, re-asking roughly ten times per sweep pass for an answer
 * that could not have changed between asks — 423 of 423 board fetches in the incident log failed,
 * retrying into the very secondary rate limit that outage held open for two hours.
 *
 * THE NUMBER. Re-measured at filing: the sweep's median pass is 2.6 minutes (156_000 ms) and its
 * p90 is 17 minutes. 150_000 ms sits AT (just under) the median — the board is never more than one
 * sweep behind while re-asking roughly once per sweep instead of ten times, and staying well under
 * the p90 keeps the board from reading as dead through the long tail. A round number was
 * deliberately NOT chosen; this is the median rounded down to keep the "never worse than one
 * sweep late" property exact rather than approximate.
 *
 * `serveCommand` threads this into BOTH `buildBatchedGithub`'s `ttlMs` and this module's own
 * `ServeDeps.boardGithubRefreshMs` (see {@link buildServeServer}), so the gateway's cache staleness
 * bound and the background prewarm cadence that re-warms it stay the SAME number rather than
 * drifting apart the way two independent literals would.
 */
export const DEFAULT_BOARD_POLL_TTL_MS = 150_000;

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
 * GATE {@link prewarmBoardGithub} ON A CONNECTED CLIENT — the fix for the zero-viewer burn.
 *
 * WHAT WENT WRONG. W1-T154 wired the pre-warm timer UNCONDITIONALLY at `buildServeServer`, and
 * its own doc argued that was the point: "the gateway never goes cold again waiting on a request
 * to trigger its own refetch", client-independent by design. The cost of that design was never
 * bounded. `warm()` resolves to a `gh pr list --state all --limit 1000` — a GraphQL call — so a
 * `serve` process with NOBODY WATCHING still billed one every 15s, forever.
 *
 * MEASURED, 2026-07-28: a serve process left running unwatched for ~5.6 days issued 60 GraphQL
 * pr-list calls in the 17:26:08Z–17:46Z window against the daemon's 16 — 78.9% of ALL GraphQL
 * traffic on the account. At 4/min = 240/hr that projects to ~3,100 points/hour against a
 * 5,000/hour budget, roughly 62% of the entire allowance, spent rendering a board no human had
 * open. That exhaustion blinded the sweep for 22 consecutive minutes and delayed a PR review by
 * ~13 minutes.
 *
 * WHY THIS SEAM. `rmd serve` ALREADY has an exact notion of "a client is connected", and it is
 * not a heuristic: service.ts calls {@link SseRoute.subscribe} once per SSE connection and
 * invokes the unsubscribe it returns from that request's own `close` event. Refcounting those
 * two edges is therefore the connection count, not a proxy for it — no new tracking layer, no
 * heartbeat, no socket bookkeeping of our own.
 *
 * THE CONTRACT, precisely:
 *   - zero clients            -> no timer, and `warm()` is never called at all
 *   - 0 -> 1 clients          -> warm ONCE immediately, then every `refreshMs`
 *   - 1 -> 2 clients          -> nothing changes; ONE timer serves every viewer
 *   - last client disconnects -> `clearInterval`, no dangling handle
 *   - reconnect after idle    -> warms immediately again, exactly like the first connect
 *
 * DELIBERATE BEHAVIOUR CHANGE, stated rather than hidden: the BOOT-time warm is gone. A
 * `GET /v1/status` that arrives before any SSE client has connected now pays its own fetch on
 * the request path, which is what W1-T154 originally set out to avoid. That is a first-request
 * latency cost, never a correctness one — `buildBatchedGithub` fetches lazily on demand and
 * `warm()` only forces that same `index()` early. Paying it on the rare
 * request-before-any-viewer is the entire point: the alternative is paying it 5,760 times a day
 * for nobody.
 */
export function gatePrewarmOnClients(
  route: SseRoute,
  github: GitHub,
  refreshMs: number = DEFAULT_BOARD_PREWARM_MS,
): { route: SseRoute; stop: () => void } {
  let clients = 0;
  let stopPrewarm: (() => void) | undefined;

  const stop = (): void => {
    stopPrewarm?.();
    stopPrewarm = undefined;
  };

  return {
    stop,
    route: {
      ...route,
      subscribe: (send) => {
        const unsubscribe = route.subscribe(send);
        clients += 1;
        // 0 -> 1 ONLY. A second viewer must not start a second timer (which would double the
        // very call rate this exists to bound) and must not re-warm off-cadence.
        if (clients === 1) stopPrewarm = prewarmBoardGithub(github, refreshMs);
        let released = false;
        return () => {
          // service.ts invokes this exactly once per connection, but a defensive latch keeps a
          // double-release from underflowing the count — a negative count would never reach 0
          // again and would strand the timer running with zero viewers, which is the bug.
          if (released) return;
          released = true;
          unsubscribe();
          clients -= 1;
          if (clients === 0) stop();
        };
      },
    },
  };
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
 * W1-T336: the priority order above is now expressed by WHICH TAB a section renders under
 * (Decisions/Now/Plan/Feed), not by its position on one continuous scroll — NEEDS ME is
 * Decisions' whole content; NOW/UP NEXT/Fleet control sit together under Now; RECENT/everything-
 * else/the "more tools" panel sit together under Feed. See SECTION_TAB_OWNER (this shell's own
 * script) for the exact table, and each section's own \`data-owner-tab\` attribute in the
 * template for the concrete rendering of it — DOCUMENT ORDER stays exactly as listed above
 * (test/serve.test.ts's own structural check polices it), ownership is expressed purely by that
 * attribute, never by moving a section into a per-tab container.
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

export function renderShellHtml(
  phaseElapsedThresholdsMs: Record<string, number> = DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS,
  consoleSha: string = CONSOLE_SHA_UNKNOWN,
  // impl-FC: the WHY-IDLE panel, rendered SERVER-SIDE by buildShellRoute and spliced in as a static
  // fragment. Appended last and defaulted to "" so every existing caller and test is unaffected,
  // and so the client script below is untouched -- byte-identical to main, deliberately.
  idleReasonsHtml: string = "",
): string {
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
  .row:has(form), .row:has(.btn-row), .row:has(.drain-feedback) { flex-wrap: wrap; overflow: visible; align-items: baseline; }
  .row .task-id { font-family: var(--font-mono); font-weight: 600; }
  .row .detail {
    color: var(--text-dim); font-size: 0.875rem; flex: 1 1 auto; min-width: 0; flex-shrink: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .row:has(form) .detail, .row:has(.btn-row) .detail, .row:has(.drain-feedback) .detail {
    flex-basis: 100%; white-space: normal; overflow: visible; text-overflow: clip;
  }
  /* W1-T435: the RECENT feed's one-tap operator verdict + steering note -- wraps onto its own
     full-width line below the detail text (the SAME "flex-basis: 100%" treatment a form/btn-row
     already gets above), so it never forces the row into horizontal overflow at a narrow viewport. */
  .drain-feedback { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; margin-top: 0.15rem; }
  .drain-feedback-note {
    flex: 1 1 160px; min-width: 120px; max-width: 100%; font: inherit; font-size: 0.8rem;
    resize: vertical; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px;
    padding: 0.15rem 0.35rem;
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
  /* W1-T914: the review three-state dot/label, mirroring .status-dot/.status-label's own
     swatch-then-matching-text convention rather than a new pattern. Reuses the SAME status
     color variables (never new ones) — success=merged-green, failure=blocked-red,
     pending=running-blue, unreadable=needs-human-amber (an outage is attention-worthy, same as
     a stopped task); "none" (absent) gets the neutral queued-grey, never green or blue. */
  .review-dot { display: inline-block; width: 0.5em; height: 0.5em; border-radius: 50%; margin: 0 0.15em; }
  .review-label { font-size: 0.75rem; font-weight: 600; background: none; }
  .review-dot.review-success { background: var(--status-merged); }
  .review-dot.review-failure { background: var(--status-blocked); }
  .review-dot.review-pending { background: var(--status-running); }
  .review-dot.review-none { background: var(--status-queued); }
  .review-dot.review-unreadable { background: var(--status-needs-human); }
  .review-label.review-success { color: var(--status-merged); }
  .review-label.review-failure { color: var(--status-blocked); }
  .review-label.review-pending { color: var(--status-running); }
  .review-label.review-none { color: var(--status-queued); }
  .review-label.review-unreadable { color: var(--status-needs-human); }
  .empty { color: var(--text-faint); font-size: 0.875rem; }
  /* W1-T154: first-paint skeleton — a pulsing placeholder bar, never a blank/empty block. */
  .row.skeleton { opacity: 0.7; }
  .skeleton-bar {
    display: inline-block; width: 100%; height: 0.9rem; border-radius: 4px;
    background: linear-gradient(90deg, var(--bg-elevated) 25%, var(--border) 37%, var(--bg-elevated) 63%);
    background-size: 400% 100%; animation: skeleton-pulse 1.4s ease infinite;
  }
  @keyframes skeleton-pulse { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
  /* W1-T159 GLANCE LAYER: the pinned summary strip + daemon-health widget -- dense, phone-first,
     never a fixed-width table (the same v0 lesson W1-T153's own header already names). */
  .glance-strip, .daemon-health {
    display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; margin: 0.4rem 0; padding: 0.5rem 0.65rem;
    background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius);
  }
  .glance-counts { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; }
  .glance-item { display: inline-flex; align-items: baseline; gap: 0.3em; font-size: 0.85rem; }
  .glance-label { color: var(--text-faint); }
  .glance-value { font-family: var(--font-mono); color: var(--text); font-weight: 600; }
  /* The ACCOUNT strip's scope note — deliberately quiet and full-width-wrapping: it is a caveat
     ("whole account, not just the fleet"), not a metric, and must never read as one more number. */
  .glance-scope { flex-basis: 100%; }
  .glance-scope .glance-label { font-size: 0.75rem; font-style: italic; }
  .glance-anomaly {
    margin: 0.4rem 0 0; padding: 0.3rem 0.6rem; border-radius: 6px; font-size: 0.85rem; font-weight: 600;
    background: rgba(255, 107, 107, 0.14); color: var(--status-blocked); border: 1px solid var(--status-blocked);
  }
  /* W1-T336: the four-tab console bar -- pinned directly under the glance strip (the header
     block, above), a plain role="tablist" of role="tab" buttons that is now AUTHORITATIVE: every
     one of the nine \`[data-owner-tab]\` sections below is hidden by the script's own
     applyActiveTab whenever its owner isn't the active tab (see SECTION_TAB_OWNER).
     SIZING, REVISED -- W1-T183's lesson is KEPT, its application here is corrected. The rule
     above this one used to read \`font-size: 0.65rem; line-height: 1; padding: 0 0.35rem;
     border: none\`, and its comment said it was "Sized like FIND's own .sort-header buttons".
     IT WAS NOT: .facet-btn/.sort-header are \`font-size: 0.8rem; padding: 0.2rem 0.5rem\` and
     inherit the base \`button\` border, so the tab bar was substantially SMALLER than the idiom
     it named -- measured headlessly, a 10.41px-tall bar carrying the console's only navigation
     between its four views, under a 339.86px pinned header, at a font 76% of the .glance-item
     labels above it. W1-T183's point -- that TOOLBAR CHROME, not row height, decides how many
     rows clear the fold -- is real and is why this stays a compact toolbar idiom rather than
     becoming default button chrome (\`padding: 0.4rem 0.75rem\`). What that lesson never
     licensed is chrome so small it stops reading as a control: the fold discipline was applied
     to these four buttons and not to the 21 metric fields pinned above them, so the bar was
     compressed to save space the header then spent many times over. This adopts .sort-header's
     ACTUAL metrics and matches .glance-item's font size exactly, so the navigation is no longer
     smaller than the labels it navigates. MEASURED COST, headlessly, not estimated: the bar goes
     10.41px -> 27.41px, +17.00px of chrome ONCE for the whole page (the pinned header above it is
     unchanged at 339.86px, and no section moves tabs). */
  .console-tabs { display: flex; flex-wrap: wrap; gap: 0.25rem; margin: 0; }
  .tab-btn { font-size: 0.85rem; padding: 0.2rem 0.5rem; }
  .tab-btn[aria-selected="true"] { background: var(--accent); color: #04101f; border-color: var(--accent); }
  /* impl-DY: the header write-state badge. Colour is a SECONDARY cue only -- the text states the
     capability outright, so this reads correctly to a colour-blind operator and in a screenshot. */
  .write-state-badge {
    margin: 0.35rem 0 0; padding: 0.3rem 0.6rem; border-radius: 6px; font-size: 0.85rem; font-weight: 600;
    border: 1px solid transparent;
  }
  .write-state-badge[data-write-state="read-only"], .write-state-badge[data-write-state="rejected"] {
    background: rgba(255, 107, 107, 0.14); color: var(--status-blocked); border-color: var(--status-blocked);
  }
  .write-state-badge[data-write-state="write"] {
    background: rgba(87, 214, 140, 0.14); color: var(--status-merged); border-color: var(--status-merged);
  }
  .write-state-badge[data-write-state="unknown"] { opacity: 0.7; }
  /* W1-T346: the NEEDS ME ask-type badge -- an ACTION row (something to DO) reads distinctly
     from a QUESTION row (something to DECIDE); colour is a secondary cue only, the text itself
     ("Do"/"Decide") states the ask outright. */
  .ask-type-badge {
    display: inline-block; margin-right: 0.35em; padding: 0.05rem 0.4rem; border-radius: 999px;
    font-size: 0.7rem; font-weight: 700; border: 1px solid transparent; vertical-align: middle;
  }
  .ask-type-badge.ask-type-action {
    background: rgba(255, 184, 77, 0.16); color: var(--status-needs-human); border-color: var(--status-needs-human);
  }
  .ask-type-badge.ask-type-question {
    background: rgba(87, 214, 140, 0.14); color: var(--status-merged); border-color: var(--status-merged);
  }
  /* W1-T507: the human-verify-pending badge -- SAME pill shape as the ask-type badges above,
     a DISTINCT colour (the queued tone) so a verify:human row reads as its own kind rather
     than as an escalation (which keeps the amber ask-type-action/needs-human tone). */
  .ask-type-badge.ask-type-verify {
    background: rgba(163, 172, 194, 0.16); color: var(--status-queued); border-color: var(--status-queued);
  }
  /* W1-T1006: the blocked-PR badge -- SAME pill shape, the "blocked" tone (distinct from both
     the amber escalation/action tone and the queued verify tone) so a sweep-disposed PR reads
     as its own kind. */
  .ask-type-badge.ask-type-blocked-pr {
    background: rgba(255, 107, 107, 0.14); color: var(--status-blocked); border-color: var(--status-blocked);
  }
  #stale-badge {
    display: inline-block; margin: 0.25rem 0 0; padding: 0.15rem 0.5rem; border-radius: 999px;
    font-size: 0.75rem; font-weight: 600; background: var(--status-needs-human); color: #241a02;
  }
  /* W1-T287: the author \`display\` above beats the UA sheet's own \`[hidden] { display: none }\`
     regardless of specificity, so markStale/clearStale flipping the \`hidden\` attribute
     (serve.ts ~1344-1350) changed nothing on screen -- the badge painted even while hidden.
     Same guard as .cmdk-overlay[hidden] below: hidden must win. */
  #stale-badge[hidden] { display: none; }
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
  /* A FAILED WRITE, not a degraded read: red rather than the gh-banner's amber, so the two are
     never confused at a glance. Same box metrics, so it drops into the same header slot. */
  .write-error {
    background: rgba(255, 107, 107, 0.12); border-color: var(--status-blocked);
    color: var(--status-blocked); white-space: pre-line;
  }
  /* impl-EA: a SUCCEEDED write. Green for a completed action; the gh-banner amber is kept for one
     that was only REQUESTED - the fleet has not acted yet and may still refuse. Colour is a
     SECONDARY cue only; the text says which, so this reads correctly in a screenshot. */
  .write-ack { white-space: pre-line; }
  .write-ack[data-ack-kind="done"] {
    background: rgba(87, 214, 140, 0.12); border-color: var(--status-merged); color: var(--status-merged);
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
  /* W1-T193: the proposal-card APPROVE button's arm-then-confirm state -- same visual language
     as STOP's own .confirming (an unmissable state change), a distinct (non-danger) accent since
     approving is not a destructive action the way STOP is. */
  button.proposal-approve-btn.confirming { background: var(--accent); color: #04101f; border-color: var(--accent); }
  /* W1-T2206: the Answer control's PENDING (preview in flight) and LAPSED (expired-arm) states.
     .pending rides on button:disabled's own dimming above, plus a wait cursor; .lapsed gets a
     distinct, non-armed accent so an expired arm is never visually mistaken for a fresh one. */
  .needs-me-answer-submit.pending { cursor: wait; }
  .needs-me-answer-submit.lapsed { border-color: var(--status-blocked); color: var(--status-blocked); }
  /* fb-…9daa9b: the UP NEXT write-actions (per-row Run + Drain now) — same arm-then-confirm
     visual language as APPROVE (a non-destructive accent), sized to sit inside a task row. */
  .up-next-run-btn { padding: 0.15rem 0.5rem; font-size: 0.8rem; margin-left: 0.4rem; flex: 0 0 auto; }
  .up-next-run-btn.confirming, #drain-now-btn.confirming { background: var(--accent); color: #04101f; border-color: var(--accent); }
  .up-next-actions { margin-bottom: 0.5rem; }
  #drain-now-btn { font-size: 0.85rem; padding: 0.25rem 0.6rem; }
  input[type="text"], input[type="url"] {
    font: inherit; background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 0.3rem 0.5rem; width: 100%; max-width: 24rem;
  }
  textarea {
    font: inherit; background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 0.3rem 0.5rem; width: 100%; max-width: 28rem; resize: vertical;
  }
  label { display: block; font-size: 0.875rem; color: var(--text-dim); margin: 0.25rem 0; }
  /* W1-T183 round 2: this label reuses W1-T156's existing .sr-only class (defined above) -- still
     in the a11y tree (for=/aria-label parity), just not eating a whole line above the fold for a
     control whose placeholder already names it. */
  form.inline-action { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; flex-basis: 100%; }
  form.inline-action input, form.inline-action textarea { flex: 1 1 12rem; width: auto; }
  .btn-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  /* W1-T193: a READY card's drafted-task list -- "render the draft's substance, not just its
     existence" (design). */
  .drafted-tasks { flex-basis: 100%; margin: 0.15rem 0 0.15rem 1.1rem; padding: 0; font-size: 0.875rem; color: var(--text-dim); }
  .drafted-tasks li { list-style: disc; }
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
  /* W1-T222: the INLINE DETAIL layer. Every task row is itself the expand trigger -- a right-
     edge chevron is the visible affordance (the row LOOKS expandable, not merely IS), flipping
     direction with the row's own aria-expanded so the toggle state is legible without reading
     the card beneath it. */
  .row { cursor: pointer; }
  .row button, .row a, .row input, .row label, .row form { cursor: auto; }
  .row-chevron {
    margin-left: auto; font-size: 0.9rem; color: var(--text-faint);
    transition: transform 0.15s ease; display: inline-block;
  }
  .row[aria-expanded="true"] .row-chevron { transform: rotate(90deg); color: var(--accent); }
  @media (prefers-reduced-motion: reduce) {
    .row-chevron { transition: none; }
  }
  /* W1-T223: every section collapses, and the WHOLE HEADER is the trigger -- a real <button>
     wrapped in its own <h2> (the WAI-ARIA disclosure pattern), so it keeps native Enter/Space +
     click for free AND still reads as a heading for screen-reader heading navigation. Same
     click/keyboard/chevron-flip gesture as a row (W1-T222), so the console has ONE expand
     interaction rather than two that differ by region. The summary line stays visible in BOTH
     states -- collapsing a section must never also hide the one line that answers its question. */
  .panel-section > h2 { margin: 0 0 0.25rem; }
  .section-header {
    display: flex; align-items: center; gap: 0.5rem; width: 100%;
    background: none; border: none; padding: 0; margin: 0;
    font: inherit; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-dim);
    text-align: left; cursor: pointer;
  }
  .section-summary {
    font-size: 0.8rem; font-weight: 400; text-transform: none; letter-spacing: normal;
    color: var(--text-dim); flex: 1 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .section-chevron {
    margin-left: auto; font-size: 0.9rem; color: var(--text-faint);
    transition: transform 0.15s ease; display: inline-block; flex-shrink: 0;
  }
  .section-header[aria-expanded="true"] .section-chevron { transform: rotate(90deg); color: var(--accent); }
  @media (prefers-reduced-motion: reduce) {
    .section-chevron { transition: none; }
  }
  /* NEEDS ME: an item arriving while the section is COLLAPSED must not be silently missed --
     collapsing must never become a way to miss the thing the console exists to surface, so the
     header itself carries emphasis until the operator actually expands it. */
  .section-header.section-emphasis {
    border: 1px solid var(--status-needs-human); border-radius: 6px; padding: 0.2rem 0.4rem;
    background: rgba(255, 184, 77, 0.12);
  }
  .section-header.section-emphasis .section-summary { color: var(--status-needs-human); font-weight: 600; }
  /* the card itself: a distinct sibling <li>, indented + accent-bordered so it visibly BELONGS
     to the row directly above it rather than reading as one more row in the same list. */
  .row-detail {
    cursor: auto; background: var(--bg-card); border: 1px solid var(--accent);
    border-radius: 6px; padding: 0.6rem 0.75rem 0.75rem; margin: -0.1rem 0 0 0.75rem;
  }
  .row-detail-title { font-weight: 700; margin: 0 0 0.35rem; }
  h3 { font-size: 0.9rem; margin: 0.75rem 0 0.35rem; color: var(--text-dim); }
  .row-detail ul { list-style: none; margin: 0; padding: 0; }
  .row-detail li { padding: 0.15rem 0; }
  .row-detail .card-journey-body ul ul { padding-left: 1.25rem; }
  .card-dep-link, .journey-task-link, .card-journey-toggle { font-size: 0.85rem; padding: 0.2rem 0.5rem; }
  .card-journey-body { margin-top: 0.35rem; }
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
  <!-- impl-DY: the WRITE-STATE badge. The write token lives in sessionStorage (W1-T202, XSS grounds), so
       it dies with every tab and every browser restart, and the only statement of that fact used to live in
       #write-token-status inside the Fleet-control section - the ELEVENTH section on the page, far below
       NEEDS ME. An operator clicking "Mark handled" never saw it and read a disabled button as a broken
       one, twice. This says the same thing where the click happens.
       It renders from hasWriteScope, which is the PROBE result (GET /v1/auth/scope with the held token),
       never "a token string is present" - a stale or wrong token reads REJECTED here, not green. -->
  <p id="write-state-badge" class="write-state-badge" role="status" aria-live="polite" data-write-state="unknown">checking write access…</p>
  <!-- W1-T159 GLANCE LAYER: a pinned summary strip -- running/needs-me/blocked/queued/
       merged-today/spend-today/spend-this-week, EVERY number traceable to a named ledger/API
       source (GET /v1/status's counts+spend, the same combined NEEDS ME set the section below
       renders from) -- plus an anomaly banner (a NOW row past its phase threshold, or a NEEDS ME
       item open over 24h) so the strip answers "is everything okay?", not only "how many". See
       renderGlanceStrip/updateGlanceAnomaly, below. -->
  <section id="glance" class="glance-strip" aria-label="At a glance">
    <div id="glance-counts" class="glance-counts">
      <span class="glance-item"><span class="glance-label">running</span><span class="glance-value" id="glance-running">…</span></span>
      <span class="glance-item"><span class="glance-label">needs me</span><span class="glance-value" id="glance-needs-me">…</span></span>
      <span class="glance-item"><span class="glance-label">blocked</span><span class="glance-value" id="glance-blocked">…</span></span>
      <span class="glance-item"><span class="glance-label">queued</span><span class="glance-value" id="glance-queued">…</span></span>
      <span class="glance-item"><span class="glance-label">merged today</span><span class="glance-value" id="glance-merged-today">…</span></span>
      <span class="glance-item"><span class="glance-label">spend today</span><span class="glance-value" id="glance-spend-today">…</span></span>
      <span class="glance-item"><span class="glance-label">spend this week</span><span class="glance-value" id="glance-spend-week">…</span></span>
    </div>
    <p id="glance-anomaly" class="glance-anomaly" role="status" aria-live="polite" hidden></p>
  </section>
  <!-- W1-T159: daemon-health widget -- last poll, a LIVE next-poll countdown, disk free, and
       GitHub core rate-limit remaining, each from its own named source (GET /v1/daemon-health;
       see daemon-health.ts's header). A placeholder value here would fail this task's own
       acceptance bar, so every value starts "…" (unknown) until the first real response lands,
       never a fabricated number. -->
  <section id="daemon-health" class="daemon-health" aria-label="Daemon health">
    <span class="glance-item"><span class="glance-label">last poll</span><span class="glance-value" id="dh-last-poll">…</span></span>
    <span class="glance-item"><span class="glance-label">next poll</span><span class="glance-value" id="dh-next-poll">…</span></span>
    <span class="glance-item"><span class="glance-label">disk free</span><span class="glance-value" id="dh-disk-free">…</span></span>
    <span class="glance-item"><span class="glance-label">rate limit</span><span class="glance-value" id="dh-rate-limit">…</span></span>
    ${idleReasonsHtml}
  </section>
  <!-- ACCOUNT strip: WHICH Anthropic account the fleet is spending, and how much of each usage
       window is gone (GET /v1/account-usage; see account-usage.ts's header for why usage comes
       from ~/.claude.json's cachedUsageUtilization and NOT from the daemon.headroom ledger line).
       Same box metrics and the same .glance-item idiom as the two strips above, so it drops into
       the header without a new layout. Every value starts "…" and renders "unknown" — never 0% —
       when its own source could not be read; "usage as of" is always shown, even when fresh,
       because a percentage nobody refreshes is worse than no percentage. -->
  <section id="account-usage" class="daemon-health" aria-label="Anthropic account usage">
    <span class="glance-item"><span class="glance-label">account</span><span class="glance-value" id="au-account">…</span></span>
    <span class="glance-item"><span class="glance-label">5h window</span><span class="glance-value" id="au-five-hour">…</span></span>
    <span class="glance-item"><span class="glance-label">7d window</span><span class="glance-value" id="au-seven-day">…</span></span>
    <span class="glance-item"><span class="glance-label">governor</span><span class="glance-value" id="au-governor">…</span></span>
    <!-- W1-T329: the two DISPATCH-DEFERRING governors (cost ceiling, WIP/queue ceiling). Sibling
         slots on the SAME strip as "governor" (the headroom governor's own posture) above --
         extending the existing surface rather than a new panel, per this task's own design note:
         "that is the surface that already answers 'may the fleet work'". -->
    <span class="glance-item"><span class="glance-label">cost governor</span><span class="glance-value" id="au-cost-governor">…</span></span>
    <span class="glance-item"><span class="glance-label">queue governor</span><span class="glance-value" id="au-queue-governor">…</span></span>
    <!-- W1-T333: the EFFECTIVE daily cost ceiling with its provenance (never the bare number --
         design note i), and the newest console write's who/when/from/to audit trail (the
         operator's stated audit requirement). Sibling slots on the SAME strip, same reason
         cost/queue governor above are: "that is the surface that already answers 'may the fleet
         work'". -->
    <span class="glance-item"><span class="glance-label">cost ceiling</span><span class="glance-value" id="au-cost-ceiling">…</span></span>
    <span class="glance-item"><span class="glance-label">ceiling override</span><span class="glance-value" id="au-cost-ceiling-audit">…</span></span>
    <span class="glance-item"><span class="glance-label">usage as of</span><span class="glance-value" id="au-as-of">…</span></span>
    <span class="glance-item glance-scope"><span class="glance-label" id="au-measures"></span></span>
  </section>
  <!-- Rendered SERVER-SIDE from the sha captured at start: a static span, deliberately NOT a
       client-script field, so this carries no risk to the template literal below. -->
  <section id="console-version" class="daemon-health" aria-label="Console build">
    <span class="glance-item"><span class="glance-label">console build</span><span class="glance-value" id="console-sha">${consoleSha.slice(0, 12)}</span></span>
  </section>
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
  <div id="write-error-banner" class="gh-banner write-error" hidden role="alert" aria-live="assertive"></div>
  <!-- impl-EA: a SUCCESSFUL write's acknowledgement. PR #1003 made a FAILED write visible; a
       successful one still produced no change the operator could see, because refreshAll re-reads a
       15s-TTL gateway and the row re-renders identically. He clicked Mark handled three more times
       on an action that had already worked. role=status (polite), not alert: success must not
       interrupt, and it is a SEPARATE element from the error banner - a green box and a red box in
       one element would make "did it work" a question of which paint landed last. -->
  <div id="write-ack-banner" class="gh-banner write-ack" hidden role="status" aria-live="polite" data-ack-kind=""></div>
  <!-- W1-T156: a single dedicated aria-live region for status-change announcements -- screen
       reader users get "task flipped" news without a sighted user's visual flash/highlight. -->
  <div id="aria-announcer" class="sr-only" role="status" aria-live="polite"></div>
</header>

<!-- W1-T336: THE TABS ARE NOW AUTHORITATIVE -- third and last shard split out of W1-T314.
     W1-T334 built this bar as a scaffold that governed nothing but its own (still-empty) Plan
     panel; W1-T335 gave every serve suite a shared reachSection helper that tolerates either
     shape. This shard is what makes the bar real: every one of the nine sections below carries
     a \`data-owner-tab\` naming which tab governs it, and the script's own applyActiveTab hides
     every section whose owner isn't the active tab -- never a second copy, never rebuilt, never
     re-fetched. SECTION_TAB_OWNER (this shell's own script, near SECTION_IDS) is the single
     table this markup is a rendering of.
     DOCUMENT ORDER IS DELIBERATELY UNCHANGED from the pre-tab flat shell (still NOW, NEEDS ME,
     ACCEPTED, UP NEXT, RECENT, rest, controls, more -- test/serve.test.ts's own structural check
     polices this order and is NOT one of this task's own files to edit) -- ownership is
     expressed by the attribute below, never by re-parenting a section into a per-tab container,
     which is also why NOW and UP NEXT can sit on the SAME tab while NEEDS ME (a DIFFERENT tab)
     still renders between them in the markup.
     THE GLANCE STRIP -- the whole pinned header block closed just above (glance/daemon-health/
     account-usage/console-version, plus the write-state/connection/staleness status line) --
     stays OUTSIDE and ABOVE this bar, never inside a tab: it is the cross-tab "is anything on
     fire" answer, unmoved by this shard (design note "what does not move").
     A SECTION'S OWN visibility logic is UNTOUCHED: \`recap\`'s own \`hidden\` (set once, for
     "nothing to recap") is a SEPARATE concern from tab ownership -- see applyRecapVisibility,
     below, which combines the two without either ever overwriting the other. Every section
     below is the EXACT node W1-T156 already patches in place -- nothing here moves it, splits
     it, or wraps it in new DOM. -->
<div id="console-tabs" class="console-tabs" role="tablist" aria-label="Console view">
  <button type="button" class="tab-btn" id="tab-decisions" role="tab" data-tab="decisions" aria-selected="true">Decisions</button>
  <button type="button" class="tab-btn" id="tab-now" role="tab" data-tab="now" aria-selected="false">Now</button>
  <button type="button" class="tab-btn" id="tab-plan" role="tab" data-tab="plan" aria-selected="false" aria-controls="tab-plan-panel">Plan</button>
  <button type="button" class="tab-btn" id="tab-feed" role="tab" data-tab="feed" aria-selected="false">Feed</button>
</div>
<!-- W1-T315: progress (done/in-flight/queued, GitHub-derived, never plan/tasks.yaml's own
     decorative status field) + the frontier (the next candidates in the SAME order the
     dispatcher would take them, each carrying a machine-derived reason). One fetch,
     GET /v1/plan/view -- see renderPlanView's own doc below for the full contract. -->
<section id="tab-plan-panel" class="panel-section" aria-label="Plan" hidden>
  <h2><span>Plan</span></h2>
  <section id="plan-progress" class="daemon-health" aria-label="Progress">
    <span class="glance-item"><span class="glance-label">done</span><span class="glance-value" id="plan-progress-done">…</span></span>
    <span class="glance-item"><span class="glance-label">in-flight</span><span class="glance-value" id="plan-progress-inflight">…</span></span>
    <span class="glance-item"><span class="glance-label">queued</span><span class="glance-value" id="plan-progress-queued">…</span></span>
    <span class="glance-item"><span class="glance-label">as of</span><span class="glance-value" id="plan-progress-asof">…</span></span>
  </section>
  <div id="plan-progress-unknown" class="gh-banner" hidden role="status" aria-live="polite"></div>
  <!-- W1-T376: per-section filed/merged COUNTS, joined off the SAME plan_refs the route already
       resolved -- rendered as a filed-versus-merged PAIR, deliberately never a percentage (a
       1-task section reading 100% the moment it merges would rank above a 74-task section still
       building out; see panel-graph.ts's computePlanSectionCounts doc for the full rationale). -->
  <h3>Sections <span id="plan-sections-summary" class="section-summary"></span></h3>
  <ol id="plan-sections-list" class="row-list"></ol>
  <h3>Frontier <span id="plan-frontier-summary" class="section-summary"></span></h3>
  <ol id="plan-frontier-list" class="row-list"></ol>
</section>

<section id="recap" class="panel-section" aria-label="Since you last checked" data-owner-tab="feed" hidden>
  <h2><span>Since you last checked</span></h2>
  <ul id="recap-list" class="row-list"></ul>
</section>

<section id="now" class="panel-section" aria-label="Now" data-owner-tab="now">
  <h2><button type="button" class="section-header" id="now-toggle" aria-expanded="true" aria-controls="now-body">
    <span>Now</span><span class="section-summary" id="now-summary">…</span><span class="section-chevron" aria-hidden="true">›</span>
  </button></h2>
  <div id="now-body">
    <ul id="now-list" class="row-list">${skeletonRows(2)}</ul>
  </div>
</section>

<!-- DECISIONS: the needs-me set alone -- W1-T257's merged-proposal reconciler and the
     escalation-lifecycle reconciler already run ahead of this render (GET /v1/feedback,
     status.ts's deriveStatus), so an item they have already resolved never reaches
     renderNeedsMe's own needsHuman/grilling/proposed filter in the first place. This tab adds
     NO third staleness rule of its own -- it renders exactly the set those two verdicts leave
     pending, same as today, just gated to its own tab now instead of the flat stack. -->
<section id="needs-me" class="panel-section" aria-label="Needs me" data-owner-tab="decisions">
  <h2><button type="button" class="section-header" id="needs-me-toggle" aria-expanded="true" aria-controls="needs-me-body">
    <span>Needs me</span><span class="section-summary" id="needs-me-summary">…</span><span class="section-chevron" aria-hidden="true">›</span>
  </button></h2>
  <div id="needs-me-body">
    <ul id="needs-me-list" class="row-list">${skeletonRows(2)}</ul>
  </div>
</section>

<!-- W1-T285: "accepted" is a real feedback status (set by NEEDS ME's own Accept button AND by a
     proposal PR merging, panel-graph.ts's reconcileFeedbackEntries) but until this section existed
     it had NO consumer -- an accepted entry just stopped matching NEEDS ME's grilling/proposed
     filter and vanished with no downstream trace. This section is that consumer: it renders the
     SAME latestFeedbackEntries NEEDS ME already receives (never a second, parallel fetch), so an
     entry accepted by the button and one accepted by a merge are indistinguishable here -- both are
     just status === "accepted" rows off the one feed. Owned by FEED, not Decisions: a resolved
     decision is archaeology, and Decisions' own criterion is that a resolved item is FILTERED OUT,
     never merely sorted into a sibling section of the same tab. -->
<section id="accepted" class="panel-section" aria-label="Accepted" data-owner-tab="feed">
  <h2><button type="button" class="section-header" id="accepted-toggle" aria-expanded="true" aria-controls="accepted-body">
    <span>Accepted</span><span class="section-summary" id="accepted-summary">…</span><span class="section-chevron" aria-hidden="true">›</span>
  </button></h2>
  <div id="accepted-body">
    <ul id="accepted-list" class="row-list">${skeletonRows(1)}</ul>
  </div>
</section>

<section id="up-next" class="panel-section" aria-label="Up next" data-owner-tab="now">
  <h2><button type="button" class="section-header" id="up-next-toggle" aria-expanded="true" aria-controls="up-next-body">
    <span>Up next</span><span class="section-summary" id="up-next-summary">…</span><span class="section-chevron" aria-hidden="true">›</span>
  </button></h2>
  <div id="up-next-body">
    <!-- W1-T202: starts DISABLED (the safe default -- no write affordance renders armed until a
         client-held write token actually proves out; see probeWriteScope/applyControlStatus). -->
    <div class="up-next-actions"><button type="button" id="drain-now-btn" data-confirming="false" aria-pressed="false" disabled title="Read-only — enter a write token to enable this action">Gather now</button></div>
    <ul id="up-next-list" class="row-list">${skeletonRows(3)}</ul>
  </div>
</section>

<section id="recent" class="panel-section" aria-label="Recent" data-owner-tab="feed">
  <h2><button type="button" class="section-header" id="recent-toggle" aria-expanded="true" aria-controls="recent-body">
    <span>Recent</span><span class="section-summary" id="recent-summary">…</span><span class="section-chevron" aria-hidden="true">›</span>
  </button></h2>
  <div id="recent-body">
    <ul id="recent-list" class="row-list">${skeletonRows(3)}</ul>
  </div>
</section>

<section id="rest" class="panel-section" aria-label="Everything else" data-owner-tab="feed">
  <h2><button type="button" class="section-header" id="rest-toggle" aria-expanded="true" aria-controls="rest-detail">
    <span>Everything else</span><span class="section-summary" id="rest-summary">…</span><span class="section-chevron" aria-hidden="true">›</span>
  </button></h2>
  <!-- W1-T183: EXPANDED BY DEFAULT while non-empty (W1-T223 formalizes this per-section, below:
       every section defaults collapsed ONLY while genuinely empty). W1-T153's original v0 IA hid
       this whole corpus behind an "Expand" click, which is exactly what fails this task's own
       density/one-click bars against a realistic (mostly queued, low-activity) fleet: NOW/NEEDS
       ME/RECENT are near-empty and UP NEXT caps at 5, so under a couple hundred plain tasks a
       collapsed rest section left a first screen with a handful of rows, and any task living only
       in "everything else" needed an expand-THEN-click (two interactions) to reach its card.
       Rendering these as DENSE single-line rows (see .row-list .row CSS) removed the original
       space cost that motivated collapsing them, so a non-empty corpus still renders open --
       the header remains available for anyone who wants the compact grouped-count summary instead. -->
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

<section id="controls" class="panel-section" aria-label="Fleet control" data-owner-tab="now">
  <h2>Fleet control</h2>
  <!-- W1-T202: the write token lives HERE, client-side only (sessionStorage), never in the URL --
       the bookmark's own \`?token=\` carries only the read token (see this shell's bootstrap,
       below). Every write affordance on this page starts DISABLED with a stated reason (standing
       rule 22) and is re-enabled by probeWriteScope only once a client-held write token actually
       proves out against GET /v1/auth/scope -- never merely because one was typed. -->
  <div id="write-token-panel" class="write-token-panel">
    <p id="write-token-status" role="status" aria-live="polite" class="counts">Read-only — write actions are unavailable. Enter a write token to enable them for this tab. Get one by running: rmd console-url --write</p>
    <form id="write-token-form" class="inline-action">
      <label for="write-token-input">Write token</label>
      <input id="write-token-input" type="password" autocomplete="off" placeholder="paste write token" />
      <button type="submit">Enable write access</button>
    </form>
    <button id="write-token-clear-btn" type="button" hidden>Clear write token</button>
  </div>
  <label for="reason">Reason (optional, for Pause/STOP)</label>
  <input id="reason" type="text" />
  <div class="btn-row">
    <button id="pause-btn" type="button" aria-pressed="false" disabled title="Read-only — enter a write token to enable this action">Pause</button>
    <button id="resume-btn" type="button" aria-pressed="false" disabled title="Read-only — enter a write token to enable this action">Resume</button>
    <button id="stop-btn" type="button" class="danger" aria-pressed="false" disabled title="Read-only — enter a write token to enable this action">STOP</button>
    <label style="display:flex; align-items:center; gap:0.35rem; margin:0;">
      <input id="quiet-hours" type="checkbox" disabled title="Read-only — enter a write token to enable this action" /> Quiet hours
    </label>
  </div>
  <p id="controls-status" role="status" aria-live="polite" class="counts"></p>
  <!-- W1-T364: the operator's own write control over the daily cost ceiling override (W1-T332's
       state/DAILY_COST_CEILING_OVERRIDE store), gated on W1-T363 (shipped, #1410) so a write here
       is actually enforced by the daemon's very next tick, never a display-only value. Arm-then-
       confirm like STOP/Drain now above -- never a bare Confirm (design note ii) -- and the
       read-back in the armed label states the restart truth verified from source: the daemon's
       reloader re-resolves the ceiling fresh every tick, so no restart is needed. The current
       effective value renders beside the control from GET /v1/account-usage's own
       resolveDailyCostCeiling-derived payload (renderCostCeilingControl, below) -- never a second
       derivation (design note iii); the ACCOUNT strip above shows the SAME fields. -->
  <label for="cost-ceiling-input">Daily cost ceiling ($)</label>
  <div class="btn-row" id="cost-ceiling-row">
    <input id="cost-ceiling-input" type="number" step="0.01" min="0" disabled title="Read-only — enter a write token to enable this action" />
    <button id="cost-ceiling-set-btn" type="button" data-confirming="false" aria-pressed="false" disabled title="Read-only — enter a write token to enable this action">Set ceiling</button>
    <button id="cost-ceiling-clear-btn" type="button" data-confirming="false" aria-pressed="false" disabled title="Read-only — enter a write token to enable this action">Clear override</button>
  </div>
  <p id="cost-ceiling-status" role="status" aria-live="polite" class="counts"></p>
</section>

<section id="more" class="panel-section" aria-label="More tools" data-owner-tab="feed">
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

<!-- W1-T222: the DETAIL layer is now INLINE, not a bottom panel. This RETIRES W1-T158's
     #task-detail/#journey-view panel-section pair (standing rule 21 successor, not an amendment
     -- see this task's own plan note) -- reaching a task's detail must not mean leaving its row.
     EVERY task row (NOW/NEEDS ME/UP NEXT/RECENT/rest) is itself the expand trigger (a right-edge
     chevron is the visible affordance; the whole row is the hit target); its own card is inserted
     as a sibling <li class="row-detail"> DIRECTLY BENEATH that row by reconcileRows/expandRow
     below, never a scroll-away section. The full journey (rmd trace, the SAME GET /v1/trace route
     W1-T158 used) lazy-loads INSIDE that card on demand (.card-journey-toggle), never eagerly. -->
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

  // W1-T202: the WRITE token never rides the URL -- the read token above is enough to boot the
  // board (every GET on this page uses authHeaders), and a write action needs a SEPARATE token
  // the operator has pasted into THIS TAB once, held only in sessionStorage (dies with the tab --
  // W1-T202's own decision doc: the safest default, given this task's origin was a write bearer
  // token leaked into a world-readable serve.log). Never written back into the URL, a ledger
  // line, or a log line -- writeAuthHeaders/postJson below are the ONLY two places this value is
  // read for an outbound request, and neither ever touches the browser history/location API or logs it.
  const WRITE_TOKEN_STORAGE_KEY = "rmd-console-write-token";
  function readStoredWriteToken() {
    try {
      return window.sessionStorage.getItem(WRITE_TOKEN_STORAGE_KEY) || "";
    } catch {
      return ""; // storage disabled/blocked -- fall back to no write token, never throw.
    }
  }
  let writeToken = readStoredWriteToken();
  function writeAuthHeaders() {
    return { authorization: \`Bearer \${writeToken}\` };
  }

  // W1-T222: "actions RENDER PER AUTH SCOPE" (cardActionsHtml, below) needs to know WHICH scope
  // this page's own WRITE token actually carries. Resolved at boot AND re-resolved every time the
  // client-held write token changes (probeWriteScope, defined near the fleet-control wiring below)
  // -- a plain GET, side-effect-free, so probing it costs nothing beyond one extra round trip and
  // never risks a spurious write. Starts false (the safe default: no write affordance renders
  // until proven otherwise), matching standing rule 22.
  let hasWriteScope = false;
  // W1-T202: the last REAL fleet-control status this shell has fetched (GET /v1/control/status) --
  // re-applied by probeWriteScope when the write token changes, so a write-scope flip alone never
  // has to wait for the next poll tick to re-render the fleet-control buttons correctly. Never
  // written to except by applyControlStatus itself, which always receives a real fetched status.
  let lastControlStatus = { paused: false, stopped: false, quietHours: false };
  // W1-T202: has the FIRST real GET /v1/status ever landed? probeWriteScope/the write-token
  // clear handler both re-run paintFromTasksById off tasksById to re-gate NEEDS ME/UP NEXT rows
  // -- but BEFORE any real data has landed, tasksById is legitimately empty, and reconcileRows
  // would (correctly, off that empty state) render the "honest empty" markup, wiping out the
  // W1-T200 first-paint skeleton the static HTML ships ahead of schedule. Gating on this flag
  // keeps a write-scope flip that resolves before the first poll a no-op render-wise -- the
  // skeleton stays exactly as authored until refreshAll's own first real paint takes over.
  let firstStatusLoaded = false;
  /** W1-T202: the inline "disabled + why" attributes every ROW-level write affordance (NEEDS ME,
   *  UP NEXT) carries when hasWriteScope is false -- the richer disabled/explained treatment
   *  cardActionsHtml's own doc reserves for this task (that function still hides its own button
   *  entirely -- unchanged, W1-T222's own job; this is everywhere else, standing rule 22). */
  function writeGateAttrs() {
    return hasWriteScope ? "" : ' disabled title="Read-only — enter a write token to enable this action"';
  }

  // W1-T156: read ONCE at load -- prefers-reduced-motion does not need live-tracking mid-
  // session for this shell's purposes, and a stable value keeps a row's rendered HTML (which
  // embeds the live-indicator markup) stable across re-renders instead of flapping.
  const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // W1-T2218: WHEN THIS PAGE LOADED -- read ONCE, and the ONE clock reading the shell can state as
  // fact about itself. \`performance.timeOrigin\` is the navigation start; the \`Date.now()\` fallback
  // covers an environment that does not expose it. This is NOT an outage start (the thing the old
  // banner stamped and could not know) -- it is the boundary of what this page has observed, which
  // is exactly what the banner claims.
  const PAGE_LOADED_ISO = new Date(
    typeof performance !== "undefined" && typeof performance.timeOrigin === "number" ? performance.timeOrigin : Date.now(),
  ).toISOString();

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

  /** One Sections row (W1-T376): "<heading> — N of M filed tasks merged", NEVER a percentage
   *  (design note (iii): a 1-task section reading 100% the moment its single task merges would
   *  rank above a 74-task section still building out, inverting the truth -- see
   *  panel-graph.ts's computePlanSectionCounts doc). Pure string-building, no DOM beyond
   *  escapeHtml just above -- pulled out of the rendered shell and eval'd directly by
   *  test/plan-sections-render.test.ts, the same technique test/account-usage.test.ts already
   *  proved for usageWindowLabel. */
  function planSectionRowHtml(s) {
    return \`<li class="row plan-section-row"><span class="task-id">\${escapeHtml(s.heading)}</span><span class="detail">\${s.merged} of \${s.filed} filed tasks merged</span></li>\`;
  }

  // W1-T189: an OPTIONAL client-side timeout. Plain fetch has none of its own, so a backend
  // stall (W1-T187's 35-58s /v1/status latency) never rejects on its own -- it just hangs,
  // which is indistinguishable from "still loading" to every caller below. A caller that names
  // \`timeoutMs\` gets an abort (routed through the SAME catch/reject path as a network error or
  // an HTTP error status) once that budget elapses, rather than waiting on a request that may
  // never settle. Callers that omit it (panel/card/journey, all interactive one-shot fetches) are
  // unchanged -- this is additive, not a behavior change to every getJson call site.
  // extraHeaders rides ON TOP of authHeaders for the one caller that needs to say something
  // about the request itself (the recap acknowledgement below). It is a HEADER and not a query
  // param on purpose: every /v1/status interception in the suite matches the BARE path, so a
  // query string would slip past them -- see board.ts's RECAP_ACK_HEADER doc.
  async function getJson(path, { timeoutMs, extraHeaders } = {}) {
    const controller = new AbortController();
    const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const headers = extraHeaders ? Object.assign({}, authHeaders, extraHeaders) : authHeaders;
      const res = await fetch(path, { headers, signal: controller.signal });
      if (!res.ok) throw new Error(\`GET \${path} -> \${res.status}\`);
      return await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  // W1-T202: every WRITE POST uses the client-held write token, never the URL's read token --
  // the whole point of this task. A caller with no write token sends an empty bearer and gets the
  // SAME 401 service.ts already returns for any unrecognized token; the UI never lets that fire
  // from a live click (every write control starts/re-renders disabled until hasWriteScope is true).
  // THE SURFACE for a failed write. Deliberately a BANNER, not console.error: the operator is
  // looking at the page, not at devtools -- a silent log is what made every write control here
  // indistinguishable from success on a 401/404/500 (recon-BV).
  // NOTE ON ESCAPING: this whole script is inside a TS template literal, so this function uses
  // string concatenation and single quotes ONLY -- no backtick, no dollar-brace. See CLAUDE.md.
  function showWriteError(path, status, detail, needsTrusted) {
    var el = document.getElementById("write-error-banner");
    if (!el) return;
    var msg;
    if (status === 403 && needsTrusted) {
      // THE REFUSAL THAT USED TO MISDIRECT. The token is valid and this tab really can write --
      // this one action asks for more than the link it was opened with carries. Sending the
      // person for a fresh token (the branch below) hands them another one that fails the same
      // way, which is worse than saying nothing. Name the consequence and the remedy, never the
      // predicate: see DECISIONS.md's vocabulary ruling for the register.
      msg = "This action needs a trusted connection.\\n"
          + "Open the console at its tailnet address and try again - the same action works there.\\n"
          + "The link this tab was opened with can read the fleet and make routine changes, "
          + "but not this one.";
    } else if (status === 401 || status === 403) {
      // THE EXPECTED, RECURRING CASE. W1-T202 put the write token in sessionStorage on XSS
      // grounds, so it dies with the tab and with every browser restart -- by design. Tell the
      // operator how to get a new one; never weaken the storage, and never print a token.
      msg = "Not authorized to write (HTTP " + status + "). This tab has no valid write token — "
          + "they live in sessionStorage by design and are cleared when the tab or browser closes.\\n"
          + "Run  rmd console-url --write  and open the URL it prints, then retry.";
    } else if (status === 0) {
      msg = "Write failed: could not reach the console service (" + path + ")."
          + (detail ? "\\n" + detail : "");
    } else {
      msg = "Write failed: " + path + " returned HTTP " + status + "."
          + (detail ? "\\n" + detail : "");
    }
    el.textContent = msg;
    el.hidden = false;
  }
  function clearWriteError() {
    var el = document.getElementById("write-error-banner");
    if (el) { el.hidden = true; el.textContent = ""; }
  }
  // impl-EA: WHAT A 200 ACTUALLY MEANS, per write route. Two different truths live behind one status
  // code and conflating them would replace a silent success with a confident lie:
  //
  //   done      - the console service ITSELF performed the action before replying. Mark handled has
  //               already closed the issue; pause/resume/stop/quiet-hours have already written the
  //               fleet-control state the daemon reads; a decision/approve/reframe/answer has already
  //               been persisted. "Done" is true at the moment the operator reads it.
  //   requested - the service recorded an INTENT and nothing more. /v1/drain/kick and /v1/drain/run
  //               drop a marker file; the daemon picks it up at its NEXT poll and runs it through
  //               assertRunnable, which can refuse outright (console.kick_refused appears in this
  //               repo's own ledger). The outcome arrives minutes later, asynchronously, and the
  //               console cannot observe it here. Saying "done" for these would be false.
  //
  // A route absent from this table gets the neutral "recorded" wording rather than an invented
  // claim - unknown is reported as unknown, never upgraded to "done".
  const WRITE_ACK = {
    "/v1/escalation/mark-handled": { kind: "done", text: "Marked handled — the escalation issue is closed. The row clears on the next refresh." },
    "/v1/feedback/decision": { kind: "done", text: "Decision recorded — the entry moves out of NEEDS ME on the next refresh." },
    "/v1/inbox/approve": { kind: "done", text: "Proposal approved — the drafted tasks are filed." },
    "/v1/inbox/reframe": { kind: "done", text: "Reframe recorded — your wording is saved against the proposal." },
    "/v1/feedback": { kind: "done", text: "Answer recorded." },
    // W1-T350: a preview FILES NOTHING -- distinct wording so this never reads as "recorded"
    // (the neutral fallback every unlisted write route gets would say exactly that).
    "/v1/feedback/preview": { kind: "done", text: "Preview generated — nothing is filed yet. Review it, then submit again to confirm and file." },
    "/v1/control/pause": { kind: "done", text: "Fleet PAUSED — no new task will be dispatched until you resume." },
    "/v1/control/resume": { kind: "done", text: "Fleet RESUMED — dispatch is live again." },
    "/v1/control/stop": { kind: "done", text: "Fleet STOPPED — dispatch is halted until you resume." },
    "/v1/quiet-hours": { kind: "done", text: "Quiet hours updated." },
    "/v1/drain/kick": { kind: "requested", text: "Run REQUESTED — not started yet. The daemon picks this up at its next poll and can still refuse it (for example a task that is not runnable). Watch RECENT for the outcome." },
    "/v1/drain/run": { kind: "requested", text: "Drain REQUESTED — not started yet. The daemon runs one dispatch cycle at its next poll. Watch RECENT for the outcome." },
    // W1-T364: the store's write completes synchronously (writeDailyCostCeilingOverride runs
    // before the route replies) and dailyCostCeilingReloader re-resolves it fresh every tick
    // (W1-T363) -- "done" is accurate, and the wording states the no-restart truth rather than
    // leaving the operator to guess whether a live daemon needs a restart to see it.
    "/v1/policy/daily-cost-ceiling": { kind: "done", text: "Daily cost ceiling updated — effective on the daemon's next tick, no restart needed." },
    "/v1/policy/daily-cost-ceiling/clear": { kind: "done", text: "Daily cost ceiling override cleared — reverted to the committed default, effective on the daemon's next tick, no restart needed." },
    // W1-T435: the ledger write (appendPanelLedger) completes before the route replies -- "done" is
    // accurate. A wrong/needs-follow-up verdict's note also steers the fix rung's next attempt
    // (operatorVerdictEvidence, lib/sweep.ts); a good verdict is recorded for the learning limb only.
    "/v1/drain/feedback": { kind: "done", text: "Feedback recorded. A wrong/needs-follow-up verdict's note also steers the next fix attempt." },
  };
  // Long enough to read a two-line message without hunting for it, short enough that it never
  // becomes furniture the operator stops seeing. Cleared by the next write either way.
  const WRITE_ACK_MS = 12000;
  var writeAckTimer;
  function showWriteAck(path) {
    var el = document.getElementById("write-ack-banner");
    if (!el) return;
    var ack = WRITE_ACK[path] || { kind: "requested", text: "Recorded — the console accepted this request." };
    el.dataset.ackKind = ack.kind;
    el.textContent = ack.text;
    el.hidden = false;
    clearTimeout(writeAckTimer);
    writeAckTimer = setTimeout(clearWriteAck, WRITE_ACK_MS);
  }
  function clearWriteAck() {
    var el = document.getElementById("write-ack-banner");
    if (el) { el.hidden = true; el.textContent = ""; el.dataset.ackKind = ""; }
    clearTimeout(writeAckTimer);
  }
  function postJson(path, body) {
    // fetch() rejects only on a NETWORK failure -- an HTTP 401/404/500 resolves normally, which is
    // why every call site discarding this result showed the operator nothing. Check .ok HERE, once,
    // so all twelve write controls are covered by one place rather than twelve patches.
    //
    // impl-W1-T500: the five paths below are the console's own HIGH-tier write routes (service.ts's
    // Route.tier "high", declared at panel-actions.ts's /v1/manual/approve + /v1/drain/kick +
    // /v1/drain/run, panel-graph.ts's /v1/inbox/approve, panel-skill-run.ts's /v1/skills/run). A
    // HIGH-tier call now costs one extra round trip -- POST the exact method+path+payload to
    // /v1/confirm, then replay THIS SAME call carrying the nonce it returns (X-Confirm-Nonce) --
    // design (ii)'s client half of W1-T404's second factor. Declared INSIDE this function, not as a
    // module-level const, so postJson stays the one self-contained unit
    // test/serve-write-errors.test.ts already extracts and sandboxes.
    var HIGH_TIER_WRITE_PATHS = ["/v1/manual/approve", "/v1/drain/kick", "/v1/drain/run", "/v1/inbox/approve", "/v1/skills/run"];
    var payload = JSON.stringify(body ?? {});
    var doWrite = function (nonce) {
      var headers = { ...writeAuthHeaders(), "content-type": "application/json" };
      if (nonce) headers["x-confirm-nonce"] = nonce;
      return fetch(path, { method: "POST", headers: headers, body: payload });
    };
    // A confirm request that itself fails (401/403/500/network) is returned/rejected AS-IS into the
    // exact same .then/.catch below a direct write failure already goes through -- one error path,
    // never a second one a HIGH-tier route would need its own banner wording for.
    var chain = HIGH_TIER_WRITE_PATHS.indexOf(path) !== -1
      ? fetch("/v1/confirm", {
          method: "POST",
          headers: { ...writeAuthHeaders(), "content-type": "application/json" },
          body: JSON.stringify({ method: "POST", path: path, payload: payload }),
        }).then(function (res) {
          if (!res.ok) return res;
          return res.json().then(function (confirmed) { return doWrite(confirmed.nonce); });
        })
      : doWrite(undefined);
    return chain.then(function (res) {
      // impl-EA: the acknowledgement fires HERE, on the ok path only, for the same reason #1003 put
      // the .ok check here - one place covers all twelve write controls, so nobody has to remember
      // to add it to the thirteenth.
      if (res.ok) { clearWriteError(); showWriteAck(path); return res; }
      clearWriteAck(); // a failure must never leave a stale "done" from the previous write on screen
      // Surface the server's own message when it supplies one; fall back to the bare status.
      return res.text().then(function (raw) {
        var detail = "";
        var needsTrusted = "";
        try {
          var j = JSON.parse(raw);
          detail = (j && (j.error || j.message)) ? String(j.error || j.message) : "";
          // W1-T500 left this body unread: the server names what the action needs, and the
          // client threw it away, so a refusal on a valid token read as a missing token.
          needsTrusted = (j && j.required_tier) ? String(j.required_tier) : "";
        }
        catch (e) { detail = String(raw || "").slice(0, 200); }
        showWriteError(path, res.status, detail, needsTrusted);
        return res;
      }, function () { showWriteError(path, res.status, ""); return res; });
    }, function (err) {
      clearWriteAck();
      showWriteError(path, 0, String((err && err.message) || err || ""));
      throw err;
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
  // ── W1-T914 (fb-1784901239119-1be356 clause c / fb-1784919225707-0fab8b): the review
  // three-state, rendered right beside the PR link so a PR whose review has not run stops
  // looking identical to one that passed. FIVE distinct labels/classes — "pending" is NEVER
  // rendered with the "success" class or label, and an absent review ("none") is never rendered
  // as "pending" either (W1-T225: absent is the worst of the states, not a friendlier one). ──
  const REVIEW_STATE_LABELS = {
    success: "review passed",
    failure: "review failed",
    pending: "review pending",
    none: "not yet reviewed",
    unreadable: "review status unreadable",
  };
  function reviewBadge(state) {
    if (!state || !REVIEW_STATE_LABELS[state]) return "";
    return \` <span class="review-dot review-\${state}" aria-hidden="true"></span><span class="review-label review-\${state}">\${REVIEW_STATE_LABELS[state]}</span>\`;
  }
  function prLink(t) {
    if (!t.prUrl) return "";
    const label = t.prNumber !== undefined ? \`#\${t.prNumber}\` : t.prUrl;
    return \` · <a href="\${t.prUrl}" target="_blank" rel="noreferrer">\${label}</a>\${reviewBadge(t.reviewState)}\`;
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
  /** \`iso\` -> "14:23:05 EDT · 8s ago" -- local wall-clock time WITH THE TIMEZONE LABELED (the
   *  reader's own zone) PLUS a relative offset, BOTH computed from the SAME \`t\` and the SAME
   *  \`Date.now()\` so the absolute stamp and the age can never contradict (fb-…c124f9's "impossible
   *  arithmetic"; the labeled zone removes the "is 12:03 UTC or local?" ambiguity). Mirrors the
   *  unit-tested \`formatStamp\` in lib/console-freshness.ts. Falls back to the raw string only when
   *  \`iso\` fails to parse (never silently swallowed). */
  function formatTimestamp(iso) {
    if (!iso) return "unknown";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return String(iso);
    const local = new Date(t).toLocaleTimeString(undefined, { timeZoneName: "short" });
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
   *
   * W1-T222 DOM-STABILITY INTO EXPANSIONS: extends the SAME never-destroy-what-didn't-change
   * doctrine to an open inline detail card. AT MOST ONE \`.row-detail[data-detail-for]\` sibling
   * ever exists per list (the shell allows exactly one open card globally -- see expandRow/
   * collapseExpanded). It is found ONCE up front and then: (a) NEVER removed by the generic
   * stale-child sweep below, however this render's \`rows\` come out -- a background poll/SSE
   * tick emptying or reshuffling this whole section must not collapse an operator's open card;
   * (b) re-homed to stay the immediate next sibling of its OWNING row as that row moves (e.g.
   * RECENT prepending a fresh event), so "beneath its own row" keeps holding after a reorder.
   * Its own content is never touched here -- only loadRowDetail (below) ever writes into it,
   * so a selection/focus anchored inside it survives an update cycle exactly like an unchanged
   * row's own DOM identity already did before this task.
   */
  function reconcileRows(list, rows, emptyText) {
    const existingDetail = Array.from(list.children).find((c) => c.dataset && c.dataset.detailFor !== undefined);
    if (rows.length === 0) {
      if (existingDetail) {
        for (const child of Array.from(list.children)) {
          if (child !== existingDetail) child.remove();
        }
        return;
      }
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
      if (row.taskId !== undefined) {
        el.dataset.taskId = row.taskId;
        // W1-T222: expand affordance lives on the ROW ELEMENT ITSELF, never inside its diffed
        // html -- aria-expanded must survive a content re-render untouched (see class doc above),
        // so it is only ever INITIALIZED here, never reset. Deliberately NO role="button": this
        // <li> legitimately carries its OWN real interactive descendants (a PR link, NEEDS ME's
        // mark-handled button, …), and a widget role on an ancestor of another focusable control
        // is an axe-flagged "nested-interactive" a11y violation (also demotes the <li> out of the
        // <ul>'s own required listitem content model — a SECOND violation from the same cause).
        // tabindex + aria-expanded alone still give the row its own stop in the tab order with a
        // legible expand state, without claiming a role it cannot honestly hold.
        el.setAttribute("tabindex", "0");
        if (!el.hasAttribute("aria-expanded")) el.setAttribute("aria-expanded", "false");
      } else {
        delete el.dataset.taskId;
        el.removeAttribute("tabindex");
        el.removeAttribute("aria-expanded");
        el.removeAttribute("aria-controls");
      }
      if (el.dataset.html !== row.html) {
        el.innerHTML = row.html;
        el.dataset.html = row.html;
        if (!isNew) flashRow(el); // a genuine content CHANGE on an already-known row -- not a fresh insert.
      }
      const anchor = prev ? prev.nextSibling : list.firstChild;
      if (anchor !== el) list.insertBefore(el, anchor); // a no-op when el is already positioned correctly.
      prev = el;
      if (existingDetail && existingDetail.dataset.detailFor === row.key) {
        if (el.nextSibling !== existingDetail) list.insertBefore(existingDetail, el.nextSibling);
        prev = existingDetail;
      }
    }
    // W1-T183: remove every child that is NOT one of this render's keyed rows -- including a
    // leftover UN-KEYED first-paint skeleton placeholder (W1-T154's skeletonRows) that real data
    // has now superseded. The old version of this cleanup only walked \`existing\` (keyed children),
    // so a skeleton <li> -- which never carries a data-key -- was never in that map and was
    // stranded in the DOM forever once real rows arrived (reproduced: #now-list/#rest-list still
    // held their initial skeleton <li>s alongside real content after the first successful paint).
    // W1-T222: an open detail card (\`existingDetail\`) is excluded from this sweep unconditionally
    // -- see the class doc above for why.
    for (const child of Array.from(list.children)) {
      if (child === existingDetail) continue;
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
    // MUTUALLY EXCLUSIVE WITH LIVE/FRESH (fb-…c124f9): a STALE banner can never co-display with
    // recent live data. W1-T281: this calls the REAL, imported, unit-tested \`resolveFreshness\`
    // (lib/console-freshness.ts, embedded verbatim below this shell's boot -- see its own
    // definition) -- never a hand-copied re-derivation of its rule. If ANY transport (poll OR
    // SSE) delivered inside STALE_DATA_AGE_MS, resolveFreshness reports "live" and the banner is
    // refused. \`connected\` is always false here: this shell's own \`lastLiveAt\` clock (touched by
    // BOTH a poll success and an SSE data event, never by SSE transport-connectivity alone) is
    // already the single freshness signal — a merely-connected-but-idle SSE stream must still be
    // able to go stale over time, which is why this never re-derives \`connected\` from the SSE
    // transport's own connection state (unlike resolveFreshness's own doc example). At a cold
    // cache-restore lastLiveAt is null and pollFailures is 0, so resolveFreshness reports
    // "reconnecting" (not "live") and the cached data IS honestly shown as stale.
    if (resolveFreshness({
      lastLiveMs: lastLiveAt,
      nowMs: Date.now(),
      connected: false,
      pollFailures,
      asOf: asOf ?? null,
      staleAfterMs: STALE_DATA_AGE_MS,
      failuresBeforeStale: STALE_ESCALATE_AFTER,
    }).mode === "live") return;
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
    // fb-1784902052582-c124f9: the tally and the rendered rows derive from ONE query. "running"
    // uses the SAME predicate renderNow filters on (an in-flight run \`phase\`), never \`status ===
    // "running"\` — so the header count can never disagree with the NOW rows again.
    const running = tasks.filter((t) => t.phase).length;
    const queued = tasks.filter((t) => t.status === "queued").length;
    // 0-MERGED IS NOT A FACT DURING A GITHUB OUTAGE (fb-…c124f9): when merge-state is
    // unreachable (the SAME per-task \`indeterminate\` signal the gh banner keys on), the merged
    // tally is UNKNOWN, never rendered as \`0\`.
    const unreachable = tasks.some((t) => t.indeterminate);
    const mergedPart = unreachable
      ? "merged: unknown (GitHub unreachable)"
      : \`\${tasks.filter((t) => t.status === "merged" || t.status === "done").length} merged\`;
    return \`\${total} tasks · \${running} running · \${mergedPart} · \${queued} queued\`;
  }

  // ── W1-T156: the live task-status truth this shell renders from. SSE deltas AND poll
  // snapshots both funnel through ingestProjection -> tasksById, so every section render below
  // is driven from ONE source of truth regardless of which transport last updated a task. ─────
  const tasksById = new Map();
  let latestFeedbackEntries = [];
  let latestInboxReady = [];
  let latestInboxDrafting = [];
  let latestUpNextCards = [];
  let latestRecentEntries = [];
  // W1-T159 GLANCE LAYER state -- see renderGlanceStrip/updateTabTitle/updateGlanceAnomaly and
  // renderDaemonHealth, below, for where each is read/written.
  let latestSpend = null; // GET /v1/status's { mergedToday, spendTodayUsd, spendWeekUsd } (board.ts's computeGlanceSpend)
  // W1-T2218: has a REAL /v1/status snapshot (cache-restored or freshly fetched) ever landed?
  // Flips true at the SAME two sites latestSpend above does (paintSnapshot's cache restore,
  // refreshAll's live poll success) -- never a third, independently-timed toggle. Lets
  // glance-running fall back to "…" (never a fabricated 0) before the first snapshot, exactly
  // like the latestSpend guard three lines below it in renderGlanceStrip.
  let tasksSnapshotKnown = false;
  // W1-T1006: NEEDS ME's sixth row source, riding the SAME GET /v1/status response every other
  // board.ts-sourced field above does (board.ts's BoardSnapshot.blockedPrs/
  // blockedPrsUnverifiedReason) -- never a second fetch, so this can never drift from tasks'
  // own generated_at. Read directly inside renderNeedsMe (module state, the SAME pattern
  // latestFeedbackEntries/latestInboxReady/latestInboxDrafting already use) rather than a new
  // renderNeedsMe parameter, so its existing call sites are untouched.
  let latestBlockedPrs = [];
  let latestBlockedPrsUnverifiedReason;
  let latestNeedsMeRows = []; // set by renderNeedsMe -- the SAME combined NEEDS ME rows the section itself renders
  let latestDaemonHealth = null; // GET /v1/daemon-health's body
  let latestAccountUsage = null; // GET /v1/account-usage's body (account-usage.ts's AccountUsageSnapshot)
  let latestPlanView = null; // GET /v1/plan/view's body (panel-graph.ts's { progress, sections, frontier }, W1-T315 + W1-T376)
  const BASE_TITLE = document.title;
  const NEEDS_ME_STALE_MS = 24 * 60 * 60 * 1000; // criterion 3's ">24h" anomaly-emphasis bound

  // ── W1-T223: SECTION COLLAPSE + SUMMARY -- every one of the five sections collapses, and its
  // header carries an ALWAYS-VISIBLE one-line summary derived from the SAME array its own
  // render*() below already built the rows from (never a second query over tasksById/latest* --
  // standing rule 22: a header claiming a different count than its own rows is a surface
  // disagreeing with itself, the W1-T181 "merged 0 of 160" outage being what that looks like when
  // it fails). Collapse state is a layout preference ONLY -- persisted client-side (standing rule
  // 24: no credential in persisted state) -- and is applied in two layers: an explicit persisted
  // preference (set ONLY by the operator's own click, below) always wins; absent one, each section
  // defaults ONCE per page load to collapsed iff it is genuinely empty at that point (this is the
  // whole of "NEEDS ME auto-expands when non-empty" -- it is not a special case, just this same
  // rule applied to the one section that is rarely empty on a busy fleet). ──────────────────────
  const SECTION_IDS = ["now", "needs-me", "accepted", "up-next", "recent", "rest"];
  const SECTION_BODY_ID = { now: "now-body", "needs-me": "needs-me-body", accepted: "accepted-body", "up-next": "up-next-body", recent: "recent-body", rest: "rest-detail" };
  const SECTION_TOGGLE_ID = { now: "now-toggle", "needs-me": "needs-me-toggle", accepted: "accepted-toggle", "up-next": "up-next-toggle", recent: "recent-toggle", rest: "rest-toggle" };
  const SECTION_PREFS_KEY = "rmd-console-sections-v1";
  function loadSectionPrefs() {
    try {
      const raw = localStorage.getItem(SECTION_PREFS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }
  let sectionPrefs = loadSectionPrefs(); // {sectionId: collapsed:boolean} -- ONLY ever written by an explicit operator toggle, below
  const sectionDefaulted = new Set(); // sections whose one-time auto default has already been applied THIS page load
  // NEEDS ME emphasis: null until this section's first REAL render this page load (never flags
  // emphasis off that first sighting -- there is no "arrival" to react to yet, just a paint).
  // Thereafter, a row key present now but absent from the last-known set is a genuine new arrival.
  let needsMeKnownKeys = null;
  // Gates ensureSectionDefault/summary text until the console has a FULL real picture (mirrors
  // applyDeepLinkIfNeeded's own "never off the status-only first pass" discipline, below) -- the
  // status-only pass's RECENT/UP NEXT/feedback/inbox arrays are still their initial empty [],
  // and defaulting (or summarizing) off THAT would be exactly the "second, disagreeing derivation"
  // this task exists to forbid. Until then the header keeps its honest "…" (never a skeleton).
  let sectionDefaultsReady = false;

  function setSectionSummary(id, text) {
    const el = document.getElementById(\`\${id}-summary\`);
    if (el) el.textContent = text;
  }
  function applySectionCollapsed(id, collapsed) {
    const body = document.getElementById(SECTION_BODY_ID[id]);
    const toggle = document.getElementById(SECTION_TOGGLE_ID[id]);
    if (!body || !toggle) return;
    body.hidden = collapsed;
    toggle.setAttribute("aria-expanded", String(!collapsed));
  }
  function setSectionCollapsed(id, collapsed, { persist } = { persist: false }) {
    applySectionCollapsed(id, collapsed);
    if (persist) {
      sectionPrefs = { ...sectionPrefs, [id]: collapsed };
      try {
        localStorage.setItem(SECTION_PREFS_KEY, JSON.stringify(sectionPrefs));
      } catch {
        /* a full/blocked localStorage must not break the toggle itself -- the preference just
           won't survive a reload, which is strictly better than throwing out of a click handler. */
      }
    }
  }
  /** Applied ONCE per section per page load -- an explicit persisted preference always wins;
   *  absent one, collapsed iff \`isEmpty\` (design: "empty sections default collapsed... NEEDS ME
   *  auto-expands when non-empty" -- the SAME rule, not two). Never re-applied after this: once a
   *  section's state is established (by default or by the operator), later data changes must not
   *  silently re-collapse or re-expand it out from under an operator who is looking at it -- see
   *  needsMeSummaryText's own "emphasis, never a forced reopen" doctrine, below. */
  function ensureSectionDefault(id, isEmpty) {
    if (sectionDefaulted.has(id)) return;
    sectionDefaulted.add(id);
    const collapsed = Object.prototype.hasOwnProperty.call(sectionPrefs, id) ? sectionPrefs[id] : isEmpty;
    applySectionCollapsed(id, collapsed);
  }
  /** The tail end of every render*() below: update the header's summary line (from the SAME rows
   *  the caller just built) and let this section settle its one-time default -- both gated on
   *  \`sectionDefaultsReady\` so neither ever runs off the status-only pass's still-empty arrays. */
  function finishSectionRender(id, isEmpty, textFn) {
    if (!sectionDefaultsReady) return;
    setSectionSummary(id, textFn());
    ensureSectionDefault(id, isEmpty);
  }
  /** "12m ago"/"3h ago" for whichever of \`items\` carries the earliest parseable timestamp --
   *  \`tsOf\` reads whatever field that item type actually carries (never fabricated for a type
   *  that doesn't -- e.g. an inbox-ready proposal has no timestamp at all, so it is silently
   *  skipped for AGE purposes while still counting toward the header's own N). */
  function oldestAgoText(items, tsOf) {
    let oldest;
    for (const it of items) {
      const raw = tsOf(it);
      if (!raw) continue;
      const t = Date.parse(raw);
      if (!Number.isFinite(t)) continue;
      if (oldest === undefined || t < oldest) oldest = t;
    }
    return oldest === undefined ? null : formatAgo(new Date(oldest).toISOString());
  }
  function isSameLocalDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function nowSummaryText(inFlight) {
    if (inFlight.length === 0) return "nothing in flight";
    const ago = oldestAgoText(inFlight, (t) => t.startedAt);
    return \`\${inFlight.length} running\${ago ? \` · oldest \${ago}\` : ""}\`;
  }
  function needsMeSummaryText(rows) {
    if (rows.length === 0) return "nothing needs you";
    const ago = oldestAgoText(rows, (r) => r.ts);
    return \`\${rows.length} open\${ago ? \` · oldest \${ago}\` : ""}\`;
  }
  function upNextSummaryText(head) {
    if (head.length === 0) return "nothing waiting to gather";
    const more = head.length > 1 ? \` (+\${head.length - 1} more)\` : "";
    return \`next: \${head[0].id}\${more}\`;
  }
  function recentSummaryText(list) {
    if (list.length === 0) return "no recent activity yet";
    const landedToday = list.filter((e) => e.verb === "merged" && isSameLocalDay(new Date(e.ts), new Date())).length;
    return \`\${landedToday} landed today · last \${formatAgo(list[0].ts)}\`;
  }
  /** Whichever of the five section bodies DOM-contains \`el\` -- expands it (never persisted: this
   *  is a navigational reveal, e.g. a dep-link/deep-link jump, not the operator's own layout
   *  preference) if it is currently collapsed. A jump/deep-link into a row that lives in a
   *  collapsed section must not land the operator on an invisible (\`hidden\`) target -- the exact
   *  new failure mode collapsing these four sections at all would otherwise introduce. */
  function revealSectionOf(el) {
    for (const id of SECTION_IDS) {
      const body = document.getElementById(SECTION_BODY_ID[id]);
      if (body && body.contains(el)) {
        // W1-T336: the section's own collapse state is only HALF of "reveal" now -- its whole
        // panel can also be behind a tab that isn't active. applyActiveTab is defined below this
        // function (hoisted); SECTION_TAB_OWNER is declared further down too, both safe to
        // reference here since every call into revealSectionOf happens well after boot.
        const tab = SECTION_TAB_OWNER[id];
        if (tab) applyActiveTab(tab);
        if (body.hidden) setSectionCollapsed(id, false, { persist: false });
        return;
      }
    }
  }
  function wireSectionToggle(id, onExpand) {
    const toggle = document.getElementById(SECTION_TOGGLE_ID[id]);
    if (!toggle) return;
    toggle.addEventListener("click", () => {
      const expandedNow = toggle.getAttribute("aria-expanded") === "true";
      setSectionCollapsed(id, expandedNow, { persist: true }); // flip: collapse iff it WAS expanded
      toggle.classList.remove("section-emphasis"); // any pending NEEDS ME emphasis clears on interaction
      if (!expandedNow && onExpand) onExpand();
    });
  }

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

  // ── TRUST: "GitHub unreachable" -- DERIVED from the CURRENT snapshot's own per-task
  // \`indeterminate\`/source:"throttled" signal (W1-T119) every render, never a latched string a
  // later success forgets to clear (the operator-observed stale-banner-beside-live-data bug this
  // task's error-lifecycle section names). Clears the instant no task reports it. W1-T2218: this
  // banner used to stamp \`new Date()\` into a client-module variable and call it an outage START --
  // that is the BROWSER's clock at the first paint carrying any indeterminate task, never the
  // instant a read began failing and never a server fact (measured 17s off the real
  // \`board_gateway.fetch_ok\`, task rationale (2)). The label now asserts only what this page load
  // can actually see. NOT deleted -- the indeterminate signal still reaches the operator. ────────
  function updateGithubBanner(tasks) {
    const unreachable = tasks.some((t) => t.indeterminate);
    const banner = document.getElementById("gh-unreachable-banner");
    if (unreachable) {
      banner.hidden = false;
      banner.textContent =
        \`GitHub unreachable — no GitHub read has completed since this page loaded (\${formatTimestamp(PAGE_LOADED_ISO)}) — statuses may be stale\`;
    } else {
      banner.hidden = true;
      banner.textContent = "";
    }
  }

  /** Repaints the task-driven sections (NOW/NEEDS ME/ACCEPTED/UP NEXT/RECENT/rest) from
   *  \`tasksById\` + the latest cached feedback/inbox/up-next/recent data -- the ONE function an
   *  SSE delta, a poll snapshot, AND the cache-restore path all funnel through, so they can never
   *  drift into different rendering codepaths. Every section render below is keyed/reconciled
   *  (never a wholesale innerHTML replace), so calling this on every SSE tick costs only the rows
   *  that actually changed. */
  function paintFromTasksById() {
    const tasks = Array.from(tasksById.values());
    const nowIds = renderNow(tasks);
    const needsMeIds = renderNeedsMe(tasks, latestFeedbackEntries, latestInboxReady, latestInboxDrafting);
    renderAccepted(latestFeedbackEntries);
    const upNextIds = renderUpNext(latestUpNextCards);
    const recentIds = renderRecent(latestRecentEntries);
    renderRest(tasks, new Set([...nowIds, ...needsMeIds, ...upNextIds, ...recentIds]));
    updateGithubBanner(tasks);
    document.getElementById("summary").textContent = summaryText(tasks);
  }

  // ── W1-T159 GLANCE LAYER: the pinned summary strip, the browser-tab needs-me badge, and the
  // daemon-health widget. EVERY number here is read off data ALREADY fetched for the sections
  // above (GET /v1/status's tasks/counts/spend, the combined NEEDS ME row set) or the daemon-
  // health route below -- never a second, independently-derived count. ──────────────────────

  function setGlanceValue(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(text);
  }

  /** THE STOPPED PREDICATE, mirroring board.ts's exported isBlockedRow EXACTLY. It cannot be
   *  imported -- this script is a string in the server module -- so it is duplicated here
   *  deliberately and locked by a source-text test, because the strip is the number the operator
   *  actually READS: board.ts's counts.blocked has no consumer on this page, so fixing only the
   *  server field would have changed nothing he can see. A task with an open, unsuperseded
   *  escalation is STOPPED even though its own status is still "queued" or "running". */
  function isBlockedRow(t) {
    return t.status === "blocked" || t.needsHuman === true;
  }

  /** running/queued reuse the EXACT predicates summaryText/statusColorKey already use for the
   *  SAME words elsewhere on this page (never a second, disagreeing derivation); blocked uses
   *  isBlockedRow above, the mirror of board.ts's; needs-me is latestNeedsMeRows.length -- the
   *  SAME combined set (tasks.needsHuman + feedback grilling/proposed + inbox ready/drafting) the
   *  NEEDS ME section itself just rendered, and a STRICT SUBSET of blocked by construction.
   *  merged-today/spend-today/spend-this-week come from latestSpend (GET /v1/status's "spend"
   *  field, board.ts's computeGlanceSpend) -- "…" (unknown, never a fabricated 0) until the
   *  first real snapshot has landed. W1-T2218: running gets the SAME "…"-until-known guard --
   *  \`tasks.filter(...).length\` is 0 both when tasksById is legitimately empty (a measured zero)
   *  and when no snapshot has ever landed (an unmeasured absence), and a bare .length cannot tell
   *  those apart. \`tasksSnapshotKnown\` (set beside latestSpend, above) carries that distinction. */
  function renderGlanceStrip(tasks) {
    setGlanceValue("glance-running", tasksSnapshotKnown ? tasks.filter((t) => t.phase).length : "…");
    setGlanceValue("glance-needs-me", latestNeedsMeRows.length);
    setGlanceValue("glance-blocked", tasks.filter(isBlockedRow).length);
    setGlanceValue("glance-queued", tasks.filter((t) => t.status === "queued").length);
    setGlanceValue("glance-merged-today", latestSpend ? latestSpend.mergedToday : "…");
    setGlanceValue("glance-spend-today", latestSpend ? costLabel(latestSpend.spendTodayUsd) : "…");
    setGlanceValue("glance-spend-week", latestSpend ? costLabel(latestSpend.spendWeekUsd) : "…");
  }

  /** The browser TAB TITLE carries the needs-me count (task design note) -- updated every time
   *  latestNeedsMeRows changes (an SSE needs-human flip included: subscribeStatusStream's own
   *  handler funnels through ingestProjection -> paintFromTasksById -> renderNeedsMe -> here). */
  function updateTabTitle() {
    const n = latestNeedsMeRows.length;
    document.title = n > 0 ? \`(\${n}) \${BASE_TITLE}\` : BASE_TITLE;
  }

  /** ANOMALY EMPHASIS (criterion 3): the strip surfaces -- in the strip itself, not merely as an
   *  ordinary count -- (a) any NOW row currently past its own phase threshold (the SAME
   *  \`.row.anomaly\` class tickElapsed already toggles live, read back here rather than
   *  re-deriving a second elapsed/threshold comparison), and (b) any NEEDS ME row older than
   *  {@link NEEDS_ME_STALE_MS} (24h), using each row's own \`ts\` (task rows: escalationOpenedAt --
   *  see renderNeedsMe's own note on why never startedAt). Never force-reopens a collapsed
   *  section (same "emphasis, never a forced reopen" doctrine as updateNeedsMeArrivalEmphasis) --
   *  this only ever touches the strip's own banner. */
  function updateGlanceAnomaly() {
    const anomalousNow = document.querySelectorAll("#now-list li.row.anomaly").length > 0;
    const now = Date.now();
    const staleNeedsMe = latestNeedsMeRows.some((r) => {
      if (!r.ts) return false;
      const t = Date.parse(r.ts);
      return Number.isFinite(t) && now - t > NEEDS_ME_STALE_MS;
    });
    const el = document.getElementById("glance-anomaly");
    if (!el) return;
    if (!anomalousNow && !staleNeedsMe) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    const parts = [];
    if (anomalousNow) parts.push("a run is past its phase threshold");
    if (staleNeedsMe) parts.push("a needs-me item has waited over 24h");
    el.hidden = false;
    el.textContent = \`⚠ \${parts.join(" · ")}\`;
  }

  /** \`n\` bytes -> "12.3 GB" -- the disk-free figure's own display formatter. */
  function formatBytes(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "unknown";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return \`\${v.toFixed(1)} \${units[i]}\`;
  }

  /** The daemon-health widget's LIVE next-poll countdown -- ticked off the SAME 1s interval
   *  tickElapsed already runs on (never a second clock), reading the \`data-next-poll-at\`
   *  attribute renderDaemonHealth stamps below. */
  function tickDaemonCountdown() {
    const el = document.getElementById("dh-next-poll");
    if (!el) return;
    const at = el.dataset.nextPollAt;
    if (!at) return;
    const ms = Date.parse(at) - Date.now();
    el.textContent = ms <= 0 ? "due now" : \`in \${formatElapsed(ms)}\`;
  }

  /** Renders GET /v1/daemon-health's body -- last poll, disk free, and rate-limit remaining are
   *  static per fetch; the next-poll countdown is stamped as a target instant (\`data-next-poll-
   *  at\`) and ticked live by {@link tickDaemonCountdown}. Every field renders "unknown" (never a
   *  placeholder number) when its own source could not be read this fetch (h.<field> absent). */
  function renderDaemonHealth(h) {
    setGlanceValue("dh-last-poll", h.lastPollTs ? formatRelative(h.lastPollAgeMs) : "unknown");
    const nextPollEl = document.getElementById("dh-next-poll");
    if (nextPollEl) {
      if (h.nextPollAt) {
        nextPollEl.dataset.nextPollAt = h.nextPollAt;
        tickDaemonCountdown();
      } else {
        delete nextPollEl.dataset.nextPollAt;
        nextPollEl.textContent = "unknown";
      }
    }
    setGlanceValue("dh-disk-free", h.diskFreeBytes != null ? formatBytes(h.diskFreeBytes) : "unknown");
    setGlanceValue("dh-rate-limit", h.rateLimitRemaining != null ? String(h.rateLimitRemaining) : "unknown");
  }

  /** One usage window as "12% · resets 20:50:00 EDT". "unknown" -- NEVER "0%" -- whenever the
   *  server withheld the reading (account-usage.ts returns the window ABSENT rather than zero
   *  for every unknown case, so a falsy check here can never turn a real 0% into "unknown":
   *  a genuine zero arrives as the number 0 and \`w.percentUsed != null\` keeps it). */
  function usageWindowLabel(w) {
    if (!w || w.percentUsed == null) return "unknown";
    const pct = \`\${w.percentUsed}%\`;
    return w.resetsAt ? \`\${pct} · resets \${formatClock(w.resetsAt)}\` : pct;
  }

  /** Local wall-clock with the zone labeled, for a FUTURE instant (a window reset) -- the
   *  relative half of formatTimestamp would read "3h ago" for something 3h away, so resets get
   *  their own formatter rather than a misleading reuse. */
  function formatClock(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return String(iso);
    return new Date(t).toLocaleTimeString(undefined, { timeZoneName: "short" });
  }

  /** Renders GET /v1/account-usage's body -- WHICH account the fleet is spending and how much of
   *  each window is gone. Read fresh per poll, so an account switch shows up on the next refresh
   *  rather than at the next daemon restart.
   *
   *  THE STALENESS RULE, and why it is not the page's own STALE badge: \`#stale-badge\`/markStale
   *  is a WHOLE-PAGE claim driven by the board transport (poll/SSE liveness). This reading has a
   *  completely different clock -- ~/.claude.json's own \`fetchedAtMs\`, written by Claude Code and
   *  by nothing in this repo -- so raising the page badge for it would tell the operator the task
   *  board is stale when only the usage cache is. Instead the age is rendered inline, ALWAYS, and
   *  the server withholds the numbers entirely once they are too old, from a different account,
   *  or un-ageable (\`usageUnknownReason\`), at which point every window shows "unknown". */
  function renderAccountUsage(a) {
    setGlanceValue("au-account", a.accountEmail || a.accountUuid || "unknown");
    setGlanceValue("au-five-hour", usageWindowLabel(a.fiveHour));
    setGlanceValue("au-seven-day", usageWindowLabel(a.sevenDay));
    const gov =
      a.governor === "armed"
        ? "ARMED"
        : a.governor === "telemetry-only"
          ? "telemetry only"
          : "unknown";
    // The posture has its OWN as-of (the newest daemon.headroom line): a fleet that has not
    // ticked since the governor was flipped would otherwise report the pre-flip posture as
    // current. Ageing it inline is the whole guard.
    setGlanceValue("au-governor", a.governorAsOf ? \`\${gov} · \${formatRelative(a.governorAgeMs)}\` : gov);
    // W1-T329: the two DISPATCH-DEFERRING governors -- "unknown" is the honest default (neither
    // governor ever logs "not deferring", only that it IS, so absence can never be shown as
    // healthy/under-ceiling -- see account-usage.ts's DispatchGovernorState doc). RENDER THE
    // NUMBERS, NOT JUST THE FLAG: "$152.28 of $150" told the operator what "deferred" alone could
    // not -- the OPERATOR COMPLAINT this task fixes was exactly "nothing stating that in console".
    setGlanceValue(
      "au-cost-governor",
      a.costGovernor === "deferred"
        ? \`\${costLabel(a.costGovernorObservedUsd)} of \${costLabel(a.costGovernorCeilingUsd)} · \${formatRelative(a.costGovernorAgeMs)}\`
        : "unknown",
    );
    setGlanceValue(
      "au-queue-governor",
      a.queueGovernor === "deferred"
        ? \`\${a.queueGovernorObservedOpenCount} of \${a.queueGovernorWipLimit} open · \${formatRelative(a.queueGovernorAgeMs)}\`
        : "unknown",
    );
    // W1-T333: the EFFECTIVE ceiling with its provenance -- never the bare number (design note i):
    // an overridden value shows the effective figure AND its committed default TOGETHER, so a
    // reader can see it was changed and from what; a value at default renders "(default)" so it
    // reads as distinguishable from an overridden one, never ambiguous between the two.
    if (a.dailyCostCeilingUsd != null) {
      const ceilingText =
        a.dailyCostCeilingProvenance === "overridden"
          ? \`\${costLabel(a.dailyCostCeilingUsd)} (overridden, default \${costLabel(a.dailyCostCeilingDefaultUsd)})\`
          : \`\${costLabel(a.dailyCostCeilingUsd)} (default)\`;
      setGlanceValue(
        "au-cost-ceiling",
        a.dailyCostCeilingFallbackReason ? \`\${ceilingText} — \${a.dailyCostCeilingFallbackReason}\` : ceilingText,
      );
    } else {
      setGlanceValue("au-cost-ceiling", "unknown");
    }
    // W1-T333: THE AUDIT TRAIL -- who/when/from/to and the resulting effective value, off the
    // newest console.ceiling_override_written ledger line. Absent means never overridden through
    // the console at all -- stated plainly, never left blank -- which is exactly what makes a
    // value "at default because never overridden" distinguishable from one "at default because a
    // real override just vanished" (the store's own documented disappearance case: the store
    // alone cannot tell those two apart, only this ledger-derived trail can).
    setGlanceValue(
      "au-cost-ceiling-audit",
      a.dailyCostCeilingAuditAsOf
        ? \`\${a.dailyCostCeilingAuditWho || "unknown"} set \${costLabel(a.dailyCostCeilingAuditFromUsd)} -> \${costLabel(a.dailyCostCeilingAuditToUsd)} (effective \${costLabel(a.dailyCostCeilingAuditEffectiveUsd)}) · \${formatTimestamp(a.dailyCostCeilingAuditAsOf)}\`
        : "no override written",
    );
    setGlanceValue(
      "au-as-of",
      a.usageUnknownReason ? \`unknown (\${a.usageUnknownReason})\` : formatTimestamp(a.usageAsOf),
    );
    setGlanceValue("au-measures", a.measures || "");
  }

  /** W1-T364: the daily-cost-ceiling WRITE control's own current-state readout, in the "Fleet
   *  control" panel beside the Set/Clear buttons (design note iii) -- driven off the SAME GET
   *  /v1/account-usage payload renderAccountUsage above already rendered into the ACCOUNT strip,
   *  never a second fetch or a second derivation. Kept deliberately separate from
   *  renderAccountUsage itself (rather than folded in) so a caller that only wants the ACCOUNT
   *  strip's read side is unaffected by this control's own DOM ids. */
  function renderCostCeilingControl(a) {
    const el = document.getElementById("cost-ceiling-status");
    if (!el) return;
    if (a.dailyCostCeilingUsd == null) {
      el.textContent = "current ceiling: unknown";
      return;
    }
    el.textContent =
      a.dailyCostCeilingProvenance === "overridden"
        ? \`current: \${costLabel(a.dailyCostCeilingUsd)} (overridden, default \${costLabel(a.dailyCostCeilingDefaultUsd)})\`
        : \`current: \${costLabel(a.dailyCostCeilingUsd)} (default)\`;
  }

  /** Renders GET /v1/plan/view's body (W1-T315 + W1-T376): PROGRESS (done/in-flight/queued,
   *  GitHub-derived, never plan/tasks.yaml's own decorative \`status:\` field) + SECTIONS
   *  (per-section filed/merged COUNTS, never a percentage -- see \`planSectionRowHtml\`'s own
   *  doc) + the FRONTIER (the next candidates in the SAME order the dispatcher would take them,
   *  each carrying a machine-derived reason). \`v.progress.unknown\` renders the LAST-known
   *  counts (never a fabricated 0) with a stated banner naming why and how stale -- the same
   *  "unknown, never zero" discipline \`renderDaemonHealth\`/\`renderAccountUsage\` already
   *  follow for their own fields; \`v.sections\` rides the SAME reading (panel-graph.ts's
   *  computePlanSectionCounts), so it goes stale in lockstep with \`v.progress\` rather than
   *  independently. A held frontier row (\`runnable: false\`) renders WITH its reason, never
   *  omitted -- "not-runnable is information, not absence" (this task's own design). */
  function renderPlanView(v) {
    if (!v) return;
    const p = v.progress || {};
    setGlanceValue("plan-progress-done", p.done != null ? String(p.done) : "unknown");
    setGlanceValue("plan-progress-inflight", p.inFlight != null ? String(p.inFlight) : "unknown");
    setGlanceValue("plan-progress-queued", p.queued != null ? String(p.queued) : "unknown");
    setGlanceValue("plan-progress-asof", p.asOf ? formatTimestamp(p.asOf) : "unknown");
    const unknownBanner = document.getElementById("plan-progress-unknown");
    if (unknownBanner) {
      if (p.unknown) {
        unknownBanner.hidden = false;
        unknownBanner.textContent = \`UNKNOWN — GitHub could not be read (\${p.unavailableReason || "unknown reason"})\${p.asOf ? \`; showing the last known counts, as of \${formatTimestamp(p.asOf)}\` : " and no prior reading exists yet"}\`;
      } else {
        unknownBanner.hidden = true;
      }
    }
    const sections = v.sections || [];
    const sectionsList = document.getElementById("plan-sections-list");
    if (sectionsList) {
      sectionsList.innerHTML = sections.length ? sections.map(planSectionRowHtml).join("") : '<li class="empty">no section data yet</li>';
    }
    setGlanceValue("plan-sections-summary", sections.length ? \`\${sections.length} shown\` : "empty");
    const rows = v.frontier || [];
    const list = document.getElementById("plan-frontier-list");
    if (list) {
      list.innerHTML = rows.length
        ? rows
            .map(
              (r) =>
                \`<li class="row plan-frontier-row"\${r.runnable ? "" : ' data-held="true"'}>\${statusBadge(r.runnable ? "queued" : "blocked")}<span class="task-id">\${escapeHtml(r.id)}</span><span class="detail">\${escapeHtml(r.title)} — \${escapeHtml(r.reason)}</span></li>\`,
            )
            .join("")
        : '<li class="empty">nothing queued</li>';
    }
    setGlanceValue("plan-frontier-summary", rows.length ? \`\${rows.length} shown\` : "empty");
  }

  /** The cache-restore path (W1-T154): ingest the cached snapshot's tasks/side-data and paint
   *  through the SAME \`paintFromTasksById\` a live update uses. */
  function paintSnapshot(snapshot) {
    for (const t of snapshot.tasks ?? []) ingestProjection(t);
    // W1-T159: restore the GLANCE strip's spend figures from the cache too -- otherwise a cold
    // reload would flash "…" for merged-today/spend-today/spend-this-week even while every OTHER
    // stale-but-real number (task counts) restores immediately from this SAME cached snapshot.
    latestSpend = snapshot.spend ?? null;
    tasksSnapshotKnown = true; // W1-T2218: a cache-restored snapshot is real data, not a guess
    latestBlockedPrs = snapshot.blockedPrs ?? [];
    latestBlockedPrsUnverifiedReason = snapshot.blockedPrsUnverifiedReason;
    latestFeedbackEntries = snapshot.feedbackEntries ?? [];
    latestInboxReady = snapshot.inboxReady ?? [];
    latestInboxDrafting = snapshot.inboxDrafting ?? [];
    latestUpNextCards = snapshot.upNextCards ?? [];
    latestRecentEntries = snapshot.recentEntries ?? [];
    // W1-T223: the cache-restore path carries FULL side-data (see the deep-link comment just
    // below) -- safe to let every section settle its one-time default/summary off THIS paint.
    sectionDefaultsReady = true;
    paintFromTasksById();
    applyControlStatus(snapshot.controlStatus ?? { paused: false, stopped: false, quietHours: false });
    // W1-T222: the cache-restore path already carries FULL side-data (recent/up-next/feedback),
    // unlike refreshAll's own first (status-only) pass below -- safe to attempt the deep link here.
    applyDeepLinkIfNeeded();
  }

  // ── W1-T222: the right-edge chevron -- the VISIBLE affordance that a row expands inline. Its
  // direction is driven purely by the row's own aria-expanded (CSS above), never baked into this
  // markup, so re-rendering a row's content (a status flip) never has to know its expand state.
  function rowChevronHtml() {
    return '<span class="row-chevron" aria-hidden="true">›</span>';
  }

  // ── NOW — in-flight runs, live phase + LIVE-TICKING elapsed (W1-T156) + LIVE spend/turns (W1-T184) ──
  // W1-T183: each in-flight row also carries its own phase's ANOMALY threshold
  // (data-threshold-ms) plus a hidden \`.anomaly-flag\` marker -- tickElapsed() below flips both
  // the marker and the row's own \`.anomaly\` class live, off the SAME ticking clock that already
  // drives the elapsed text, so a row that crosses its threshold mid-session is flagged without
  // waiting on the next status flip/re-render.
  function liveSpendHtml(t) {
    // NO DATA YET, never zeros (fb-1784902052582-c124f9): an in-flight run that has logged no
    // spend/turns line yet reads "no data yet", not "$0.000 / 0 turns" as fact.
    if (t.liveSpendPending) return \` · spend: <span class="spend-pending">no data yet</span>\`;
    if (t.liveSpendUsd === undefined && t.liveTurns === undefined) return "";
    const turns = t.liveTurns !== undefined ? \` / \${t.liveTurns} turns\` : "";
    return \` · spend: \${costLabel(t.liveSpendUsd)}\${turns}\`;
  }
  // W1-T944: the NOW row's worker-liveness span, riding the SAME served BoardRow field
  // (workerState/workerStateSince) phase/elapsed/spend already ride -- no second fetch, no
  // client-side re-derivation of the state itself. Text always, never colour alone (design note
  // iv): every branch below renders a WORD, and quiet's word is a DURATION ("quiet Nm") aged by
  // tickElapsed() below off the SAME 1s clock elapsed already uses (design note ii). A row this
  // is called for is ALREADY known in-flight (nowRowHtml only calls it for a \`t.phase\` row --
  // design note v), so "no workerState" here means "no worker.state row yet", rendered as
  // "state unknown" (design note iii) rather than a blank or a healthy-looking default.
  function workerStateHtml(t) {
    if (t.workerState === "quiet") {
      const since = escapeHtml(t.workerStateSince ?? "");
      return \` · worker: <span class="worker-state worker-quiet" data-worker-since="\${since}">quiet …</span>\`;
    }
    if (t.workerState === "working" || t.workerState === "tool-executing") {
      return \` · worker: <span class="worker-state">\${escapeHtml(t.workerState)}</span>\`;
    }
    return \` · worker: <span class="worker-state worker-unknown">state unknown</span>\`;
  }
  function nowRowHtml(t) {
    const key = statusColorKey(t);
    const threshold = phaseThresholdMs(t.phase);
    return (
      \`<span class="task-id">\${escapeHtml(t.taskId)}</span>\${statusBadge(key)}\${liveIndicatorHtml()}\` +
      \`<span class="detail">phase: \${escapeHtml(t.phase)} · elapsed: <span class="elapsed" data-started="\${escapeHtml(t.startedAt ?? "")}" data-threshold-ms="\${threshold}">…</span>\` +
      \`<span class="anomaly-flag" hidden title="running longer than usual for this phase">⚠ long-running</span>\` +
      \`\${workerStateHtml(t)}\${liveSpendHtml(t)}\${t.armedAwaitingMerge ? " · auto-merge armed" : ""}\${prLink(t)}</span>\` +
      rowChevronHtml()
    );
  }
  function renderNow(tasks) {
    const inFlight = tasks.filter((t) => t.phase);
    const rows = inFlight.map((t) => ({ key: t.taskId, html: nowRowHtml(t), taskId: t.taskId }));
    reconcileRows(document.getElementById("now-list"), rows, "nothing in flight");
    tickElapsed(); // paint newly (re)rendered elapsed spans immediately, not after the next 1s tick
    finishSectionRender("now", inFlight.length === 0, () => nowSummaryText(inFlight));
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
    // W1-T944: \`.worker-quiet[data-worker-since]\` ages "quiet Nm" the SAME way \`.elapsed\` ages
    // elapsed above -- off THIS same 1s clock (design note ii), never a second timer. A frozen
    // number here is exactly the "operator mistrusts the whole card" failure the design note
    // warns against.
    document.querySelectorAll(".worker-quiet[data-worker-since]").forEach((el) => {
      const since = el.getAttribute("data-worker-since");
      const quietMs = since ? now - Date.parse(since) : NaN;
      el.textContent = Number.isFinite(quietMs) ? \`quiet \${formatElapsed(quietMs)}\` : "quiet";
    });
    // W1-T159: the GLANCE strip's anomaly banner and the daemon-health countdown both tick off
    // this SAME 1s clock -- never a second setInterval. The NOW-row anomaly flags above can flip
    // between paints purely from wall-clock time passing (a run crossing its threshold with no
    // new ledger line at all), so the banner is re-evaluated every tick too, not only on a paint.
    updateGlanceAnomaly();
    tickDaemonCountdown();
  }

  // ── NEEDS ME — escalations + inbox, one-line ask + action ───────────────────────────────
  // W1-T182: an ESCALATION row joins LIVE issue state (status.ts's escalationIssueUrl/
  // escalationTitle/escalationUnverified), never ledger history alone, and renders the
  // affordance an escalation actually supports -- "view issue" (a DIRECT link, never an input
  // soliciting a URL the ledger already holds) + "mark handled". There is NO Approve control
  // here: "approve" has no defined verb for an escalation of any class -- that word is reserved
  // for a P## ratification-inbox proposal (needsMeInboxHtml, below), the one item type it is
  // actually defined for.
  //
  // W1-T346: every escalation is one of two ASKS -- an ACTION the operator must PERFORM, or a
  // QUESTION the operator must ANSWER (escalate.ts's classifyAsk, MASTER-PLAN §4). This row
  // reads the CLASS straight off escalationTitle's own "[CLASS] taskId: summary" prefix --
  // escalate.ts has rendered that prefix on every issue since W1-T8, so no new plumbing is
  // needed to reach it here. GRILL classifies "question" (definitional, matching classifyAsk
  // exactly); every other named class (MANUAL, BLOCKED, HARD_STOP) defaults to "action" here --
  // this row never sees the options a BLOCKED/HARD_STOP escalation carries (classifyAsk's own
  // options-shape test lives at escalate() time, off a full Escalation; this render path only
  // ever gets the class), so it applies classifyAsk's OWN documented default for an
  // undecidable case: presenting a question as an action costs one wasted read, while
  // presenting an action as a question hides real work. A row with no recognizable class (no
  // escalationTitle at all -- the generic-ask fallback below) renders NO badge at all, BYTE-
  // IDENTICAL to before this task.
  function askTypeFromEscalationTitle(title) {
    const m = title ? /^\\[(\\w+)\\]/.exec(title) : null;
    if (!m) return undefined;
    return m[1] === "GRILL" ? "question" : "action";
  }
  function needsMeTaskRowHtml(t) {
    const ask = t.escalationTitle ? escapeHtml(t.escalationTitle) : "needs human attention (escalated)";
    const askType = askTypeFromEscalationTitle(t.escalationTitle);
    const askTypeBadge = askType
      ? \`<span class="ask-type-badge ask-type-\${askType}">\${askType === "question" ? "Decide" : "Do"}</span>\`
      : "";
    const unverifiedNote = t.escalationUnverified ? " · issue state unverified (showing to be safe)" : "";
    const viewIssueLink = t.escalationIssueUrl
      ? \`<a href="\${escapeHtml(t.escalationIssueUrl)}" target="_blank" rel="noopener noreferrer">view issue</a>\`
      : "";
    const markHandledBtn = t.escalationIssueUrl
      ? \`<button type="button" class="needs-me-mark-handled"\${writeGateAttrs()} data-task-id="\${escapeHtml(t.taskId)}" data-issue-url="\${escapeHtml(t.escalationIssueUrl)}">Mark handled</button>\`
      : "";
    return (
      \`\${statusBadge("needs-human")}\${askTypeBadge}<span class="task-id">\${escapeHtml(t.taskId)}</span><span class="detail">\${ask}\${unverifiedNote}\${prLink(t)}</span>\` +
      rowChevronHtml() +
      (viewIssueLink || markHandledBtn ? \`<span class="btn-row">\${viewIssueLink}\${markHandledBtn}</span>\` : "")
    );
  }
  // W1-T313: a decision card OPENS with the cached plain-language summary (headline / what
  // happened / the decision + labelled options) with the raw payload moved BYTE-IDENTICAL
  // behind a collapsed <details> -- the summarizer is NEVER invoked here (this function makes
  // zero network calls; the summary was written ONCE at creation time and is just read off
  // \`e.summary\`). \`e.summary\` absent or shaped wrong (fail-open: the same guard the server
  // itself already applied before persisting) degrades to exactly \`rawHtml\`, unchanged from
  // before this task -- the falsifier this bar exists for is a card whose FIRST text is the
  // raw payload; when a valid summary exists, the raw payload is never that first text again.
  function decisionSummaryHtml(e, rawHtml) {
    const s = e && e.summary;
    if (
      !s ||
      typeof s.headline !== "string" ||
      typeof s.decision !== "string" ||
      !Array.isArray(s.options) ||
      s.options.length < 2
    ) {
      return rawHtml;
    }
    const optionsHtml = s.options
      .map((o) => \`<li><strong>\${escapeHtml(o.label)}</strong> — \${escapeHtml(o.consequence)}</li>\`)
      .join("");
    return (
      \`<div class="decision-summary">\` +
      \`<p class="decision-headline">\${escapeHtml(s.headline)}</p>\` +
      (s.what_happened ? \`<p class="decision-what-happened">\${escapeHtml(s.what_happened)}</p>\` : "") +
      \`<p class="decision-decision">\${escapeHtml(s.decision)}</p>\` +
      \`<ul class="decision-options">\${optionsHtml}</ul>\` +
      \`</div>\` +
      \`<details class="decision-raw"><summary>Show raw</summary>\${rawHtml}</details>\`
    );
  }
  // W1-T350: the Answer form is the ONE console control that submits raw operator text to
  // POST /v1/feedback, so it is "the console's own... submit control" this task's design (ii)
  // converts to arm-then-confirm with a read-back. First submit PREVIEWS (POST
  // /v1/feedback/preview) and, when an expansion comes back, ARMS the submit button with a
  // read-back of it — never files on that click. A second submit (data-confirming==="true")
  // files WITH the previewed expansion attached. When the preview yields no expansion (unset/
  // outage/timeout — the fail-open falsifier), the FIRST click files immediately, unchanged
  // from before this task: never a single-click submit of an unseen rewrite, but never a
  // second click required for a plain, un-expandable answer either. "File raw" is the escape
  // (design (iv)) — one deliberate click away, always skips the preview entirely.
  // W1-T2206: the preview leg used to be an unguarded await with no spinner, no disable and no
  // label change -- the button read as dead for the whole model call, a second click launched a
  // SECOND paid preview, and the 8s arm expired silently. The submit handler below now renders a
  // pending state for that whole call (disabled + "Expanding your answer…"), refuses re-entry
  // per replyTo while pending, states plainly on the armed control that nothing is filed yet,
  // and widens+surfaces the arm's expiry. See the handler's own comments for the per-leg detail.
  function needsMeGrillHtml(e) {
    const rawHtml = \`<span class="detail">asks: \${escapeHtml(e.raw)}</span>\`;
    return (
      \`\${statusBadge("needs-human")}<span class="task-id">feedback#\${escapeHtml(e.id)}</span>\` +
      decisionSummaryHtml(e, rawHtml) +
      \`<form class="inline-action needs-me-answer" data-reply-to="\${escapeHtml(e.id)}">\` +
      \`<label for="answer-\${escapeHtml(e.id)}">Answer</label>\` +
      \`<input id="answer-\${escapeHtml(e.id)}" type="text" required />\` +
      \`<button type="submit" class="needs-me-answer-submit" data-confirming="false" aria-pressed="false"\${writeGateAttrs()}>Answer</button>\` +
      \`<button type="button" class="needs-me-answer-raw"\${writeGateAttrs()}>File raw</button></form>\`
    );
  }
  function needsMeProposedHtml(e) {
    const rawHtml = \`<span class="detail">proposes: \${escapeHtml(e.raw)}</span>\`;
    return (
      \`\${statusBadge("needs-human")}<span class="task-id">feedback#\${escapeHtml(e.id)}</span>\` +
      decisionSummaryHtml(e, rawHtml) +
      \`<span class="btn-row"><button type="button" class="needs-me-decide"\${writeGateAttrs()} data-id="\${escapeHtml(e.id)}" data-decision="accept">Accept</button>\` +
      \`<button type="button" class="needs-me-decide"\${writeGateAttrs()} data-id="\${escapeHtml(e.id)}" data-decision="reject">Reject</button></span>\`
    );
  }
  // W1-T193: a READY card renders what would ACTUALLY be filed -- the drafted task ids AND
  // titles (never just the opaque P## proposal id) -- with APPROVE and REFRAME wired to the
  // write-token API. APPROVE reuses fleet control's OWN arm-then-confirm discipline verbatim
  // (serve.ts's stop-btn handler, below) via the SAME data-confirming/8s-reset shape, with a
  // read-back of the drafted task ids in its armed label -- never a second confirm pattern.
  // REFRAME is a textarea (authored feedback captured VERBATIM), never a link to a terminal --
  // the wrong asymmetry (agreeing easy, disagreeing hard) a ratification gate must not have.
  function draftedTasksHtml(draftedTasks) {
    if (!draftedTasks || draftedTasks.length === 0) return "";
    return (
      \`<ul class="drafted-tasks">\` +
      draftedTasks.map((t) => \`<li><span class="task-id">\${escapeHtml(t.id)}</span> \${escapeHtml(t.title)}</li>\`).join("") +
      \`</ul>\`
    );
  }
  function needsMeInboxHtml(p) {
    const draftedTasks = p.draftedTasks ?? [];
    const readBack = draftedTasks.length > 0 ? draftedTasks.map((t) => t.id).join(", ") : p.proposalId;
    return (
      \`\${statusBadge("needs-human")}<span class="task-id">\${escapeHtml(p.proposalId)}</span><span class="detail">READY to ratify — \${escapeHtml(p.summary)}</span>\` +
      draftedTasksHtml(draftedTasks) +
      \`<span class="btn-row"><button type="button" class="proposal-approve-btn"\${writeGateAttrs()} data-proposal-id="\${escapeHtml(p.proposalId)}" data-read-back="\${escapeHtml(readBack)}" data-confirming="false" aria-pressed="false">Approve</button></span>\` +
      \`<form class="inline-action needs-me-reframe" data-proposal-id="\${escapeHtml(p.proposalId)}">\` +
      \`<label for="reframe-\${escapeHtml(p.proposalId)}">Reframe (feedback)</label>\` +
      \`<textarea id="reframe-\${escapeHtml(p.proposalId)}" rows="2" required placeholder="what should change…"></textarea>\` +
      \`<button type="submit"\${writeGateAttrs()}>Reframe</button></form>\`
    );
  }
  // W1-T193: a proposal legitimately mid-draft for minutes (W1-T192's daemon-side rung) must
  // never render as nothing -- indistinguishable from broken, the same bar W1-T156 set for
  // liveness -- so this names the state AND carries its spawn time, reusing the SAME live-
  // ticking .elapsed[data-started] span/tickElapsed() the NOW section already drives (one
  // implementation, never a second clock).
  function needsMeDraftingHtml(p) {
    return \`\${statusBadge("needs-human")}<span class="task-id">\${escapeHtml(p.proposalId)}</span><span class="detail">DRAFTING — \${escapeHtml(p.summary)} · running <span class="elapsed" data-started="\${escapeHtml(p.spawnedAt)}">…</span></span>\`;
  }
  // W1-T507: the OTHER reason a row needs a person -- a task filed 'verify: human' in the plan
  // itself, never dispatched (isDispatchEligible/assertRunnable/task-linter.ts all exclude it
  // from machine attention on sight), so it never runs and never escalates. No action affordance
  // renders here on purpose: unlike an escalation row, there is no issue to view and no PR to
  // point at -- nothing in src/ has ever dispatched this task, so nothing exists yet to click.
  // This row's only job is making the queue itself visible, which is this task's whole point.
  function needsMeVerifyRowHtml(t) {
    return (
      \`\${statusBadge("needs-human")}<span class="ask-type-badge ask-type-verify">Verify</span>\` +
      \`<span class="task-id">\${escapeHtml(t.taskId)}</span><span class="detail">awaiting human verification -- filed verify: human, never auto-dispatched</span>\`
    );
  }
  // W1-T1006: THE SIXTH NEEDS-ME KIND -- a PR the sweep reconciler already disposed into a
  // non-progressing class (blocked-fixable/blocked-ambiguous/conflicted/stale), with no
  // escalation issue required for it to be visible here at all (design (1)/(6): that gate is
  // the whole defect this task closes). disposition and reason render VERBATIM off the
  // ledger's own sweep.disposed line (design (ii), the W1-T186 named-reason doctrine --
  // status-board.ts's BlockedPrBlocker doc) -- no new taxonomy, no rewording, no collapsing
  // distinct families down to the disposition word alone. No action affordance renders here,
  // same discipline as needsMeVerifyRowHtml just above: nothing in src/ offers a console verb
  // for this row yet (design note (vii), an operator ruling, not this task's to make). No card
  // link either (design (v)): computeTaskCard 404s for any id the plan does not hold, and this
  // row's own taskId (when the ledger line even carried one) is not known to be one of the ones
  // that do -- so the pushed row below deliberately carries no taskId field at all (see
  // reconcileRows' own row.taskId !== undefined gate), which is what keeps this row un-
  // clickable rather than a 404 one click away.
  function needsMeBlockedPrRowHtml(r) {
    const prLabel = r.prUrl
      ? \`<a href="\${escapeHtml(r.prUrl)}" target="_blank" rel="noreferrer">PR #\${r.prNumber}</a>\`
      : \`PR #\${r.prNumber}\`;
    return (
      \`\${statusBadge("needs-human")}<span class="ask-type-badge ask-type-blocked-pr">Blocked</span>\` +
      \`<span class="task-id">\${prLabel}</span><span class="detail">\${escapeHtml(r.disposition)} -- \${escapeHtml(r.reason)}</span>\`
    );
  }
  // W1-T1006 design (iii): the SAME withholding distinction status-board.ts's own
  // blockedPrsUnverifiedReason already draws (live GitHub state could not be checked THIS
  // cycle -- withheld rather than replay possibly-stale history as current) rendered as its OWN
  // row, so an outage reads as "unverified", never as a healthy-looking empty group.
  function needsMeBlockedPrUnverifiedHtml(reason) {
    return (
      \`\${statusBadge("needs-human")}<span class="ask-type-badge ask-type-blocked-pr">Blocked</span>\` +
      \`<span class="detail">blocked-PR ledger entries unverified -- \${escapeHtml(reason)}</span>\`
    );
  }
  function renderNeedsMe(tasks, feedbackEntries, inboxReady, inboxDrafting) {
    const rows = [];
    const shown = new Set();
    for (const t of tasks) {
      if (!t.needsHuman) continue;
      shown.add(t.taskId);
      // W1-T159: the escalation's OWN open time (escalationOpenedAt), not the triggering run's
      // startedAt -- those name DIFFERENT events (a run can start hours before the escalation
      // that follows it fires), and the GLANCE strip's own >24h anomaly emphasis needs the real
      // one. Falls back to startedAt only for a row with no escalationOpenedAt at all (should not
      // happen for a real needsHuman row, but never let a missing field erase the row's age).
      rows.push({ key: \`task:\${t.taskId}\`, html: needsMeTaskRowHtml(t), taskId: t.taskId, ts: t.escalationOpenedAt ?? t.startedAt });
    }
    // W1-T507: a DISTINCT kind, grouped in its OWN pass immediately after the escalation rows
    // above -- never folded into the \`needsHuman\` loop, so an escalation row's own affordance
    // (view issue / mark handled) is untouched by this addition. Reaches this list via its OWN
    // sparse field (status.ts's projectPlan-level \`verifyHumanPending\`, set only once a task is
    // filed verify: human AND not yet credited merged) -- never a widened \`needsHuman\`, per this
    // task's design.
    for (const t of tasks) {
      if (!t.verifyHumanPending) continue;
      shown.add(t.taskId);
      rows.push({ key: \`verify:\${t.taskId}\`, html: needsMeVerifyRowHtml(t), taskId: t.taskId });
    }
    for (const e of feedbackEntries ?? []) {
      if (e.status === "grilling") rows.push({ key: \`fbg:\${e.id}\`, html: needsMeGrillHtml(e), ts: e.ts });
      else if (e.status === "proposed") rows.push({ key: \`fbp:\${e.id}\`, html: needsMeProposedHtml(e), ts: e.ts });
    }
    for (const p of inboxReady ?? []) rows.push({ key: \`inbox:\${p.proposalId}\`, html: needsMeInboxHtml(p) });
    for (const p of inboxDrafting ?? []) rows.push({ key: \`inbox-drafting:\${p.proposalId}\`, html: needsMeDraftingHtml(p), ts: p.spawnedAt });
    // W1-T1006: the sixth group, its OWN pass exactly like verifyHumanPending's above -- never
    // folded into the needsHuman loop, and reached via module state (latestBlockedPrs) rather
    // than a new parameter here, so every existing caller of renderNeedsMe is untouched.
    for (const r of latestBlockedPrs ?? []) rows.push({ key: \`blocked-pr:\${r.prNumber}\`, html: needsMeBlockedPrRowHtml(r) });
    if (latestBlockedPrsUnverifiedReason) {
      rows.push({ key: "blocked-pr-unverified", html: needsMeBlockedPrUnverifiedHtml(latestBlockedPrsUnverifiedReason) });
    }
    reconcileRows(document.getElementById("needs-me-list"), rows, "nothing needs you right now");
    tickElapsed(); // paint the DRAFTING row's freshly-(re)rendered elapsed span immediately, same as renderNow does
    updateNeedsMeArrivalEmphasis(rows);
    finishSectionRender("needs-me", rows.length === 0, () => needsMeSummaryText(rows));
    // W1-T159: the GLANCE strip's needs-me count AND the tab-title badge both read THIS exact
    // set (task escalations + feedback grilling/proposed + inbox ready/drafting) -- never a
    // second, independently-derived needs-me tally that could disagree with the section itself.
    latestNeedsMeRows = rows;
    renderGlanceStrip(tasks);
    updateTabTitle();
    updateGlanceAnomaly();
    return shown;
  }
  /** W1-T285: ACCEPTED's one row template -- deliberately the SAME shape as needsMeProposedHtml
   *  (statusBadge + task-id + detail + optional proposal-PR link) minus the now-irrelevant
   *  Accept/Reject buttons, so an operator recognizes it as "the thing I just accepted", not a
   *  brand-new, unfamiliar row kind. */
  function acceptedFeedbackHtml(e) {
    return (
      \`\${statusBadge("merged")}<span class="task-id">feedback#\${escapeHtml(e.id)}</span><span class="detail">accepted: \${escapeHtml(e.raw)}</span>\` +
      (e.proposal_pr ? \` <span class="btn-row"><a href="\${escapeHtml(e.proposal_pr)}" target="_blank" rel="noopener noreferrer">proposal PR</a></span>\` : "")
    );
  }
  function acceptedSummaryText(rows) {
    if (rows.length === 0) return "nothing accepted yet";
    const ago = oldestAgoText(rows, (r) => r.ts);
    return \`\${rows.length} accepted\${ago ? \` · most recent \${ago}\` : ""}\`;
  }
  /** W1-T285: ACCEPTED is the missing consumer of feedback's \`accepted\` status -- an entry
   *  disappearing from NEEDS ME (it no longer matches "grilling"/"proposed") is not the same as an
   *  operator being able to SEE what accepting it did. Reads off the SAME \`feedbackEntries\` NEEDS
   *  ME itself renders (the console's own data path, latestFeedbackEntries -- never a second fetch
   *  or a helper nothing calls), so an entry accepted by the button and one accepted by a merge
   *  (panel-graph.ts's reconcileFeedbackEntries, which persists the SAME "accepted" status) are
   *  indistinguishable here -- both are just a status === "accepted" row off the one feed. */
  function renderAccepted(feedbackEntries) {
    const rows = [];
    for (const e of feedbackEntries ?? []) {
      if (e.status === "accepted") rows.push({ key: \`fba:\${e.id}\`, html: acceptedFeedbackHtml(e), ts: e.ts });
    }
    reconcileRows(document.getElementById("accepted-list"), rows, "nothing accepted yet");
    finishSectionRender("accepted", rows.length === 0, () => acceptedSummaryText(rows));
  }
  /** W1-T223: "a NEEDS ME item arriving while the section is collapsed must not be silently
   *  missed" -- gated on \`sectionDefaultsReady\` for the SAME reason \`finishSectionRender\` is (the
   *  status-only first pass's feedback/inbox rows are not real yet, so treating them as "arrivals"
   *  would flag emphasis off data that was never actually absent). Never force-reopens the section
   *  -- an operator's own collapse (explicit or defaulted) is respected; this only makes the
   *  header itself carry emphasis until they act on it. */
  function updateNeedsMeArrivalEmphasis(rows) {
    if (!sectionDefaultsReady) return;
    const keys = new Set(rows.map((r) => r.key));
    const isFirstRealRender = needsMeKnownKeys === null;
    const hasNewArrival = !isFirstRealRender && [...keys].some((k) => !needsMeKnownKeys.has(k));
    needsMeKnownKeys = keys;
    if (!hasNewArrival) return;
    const toggle = document.getElementById("needs-me-toggle");
    if (toggle && toggle.getAttribute("aria-expanded") === "false") {
      toggle.classList.add("section-emphasis");
      announce("Needs me: a new item needs your attention.");
    }
  }

  // ── UP NEXT — the drain head, first ~5 runnable (W1-T140 preview/curation) ──────────────
  function renderUpNext(cards) {
    const head = (cards ?? []).slice(0, 5);
    const rows = head.map((c) => ({
      key: c.id,
      html: \`\${statusBadge("queued")}<span class="task-id">\${escapeHtml(c.id)}</span><span class="detail">\${escapeHtml(c.title)} · \${(c.dependsOn ?? []).length} dep(s)</span><button type="button" class="up-next-run-btn"\${writeGateAttrs()} data-task-id="\${escapeHtml(c.id)}" data-confirming="false" aria-pressed="false">Run</button>\${rowChevronHtml()}\`,
      taskId: c.id,
    }));
    reconcileRows(document.getElementById("up-next-list"), rows, "nothing waiting to gather");
    finishSectionRender("up-next", head.length === 0, () => upNextSummaryText(head));
    return new Set(head.map((c) => c.id));
  }

  // ── RECENT — a LEDGER-FIRST activity feed (W1-T184): merges/verdicts/fix outcomes/
  // escalations/spend, one row per ledger EVENT (not a task's final state) — GitHub only ever
  // DECORATES a row (the PR's title); an unreachable GitHub degrades that decoration, it never
  // removes the row (see lib/board.ts's computeRecentActivity for the full design rationale). ──

  // "Run refused"/"Run started" (W1-T266) are spelled out rather than abbreviated like the rest:
  // they answer a button the OPERATOR pressed, so the row has to read as a reply to him, not as
  // one more machine event. Every other verb describes something the fleet did on its own.
  const RECENT_VERB_LABEL = { merged: "merged", verdict: "verdict", fix: "fix", escalated: "escalated", spend: "spend", "run-refused": "Run refused", "run-started": "Run started" };
  // Reuses the board's existing status-dot palette (statusBadge/STATUS_LABELS above) rather than
  // inventing new colors for this feed's own vocabulary — merged/verdict map onto their obvious
  // counterparts; fix/spend read as "in progress" (running); escalated reads as needs-human.
  // A refused Run reuses "blocked" — it is the one row here that means "your click did nothing".
  const RECENT_BADGE_KEY = { merged: "merged", verdict: "blocked", fix: "running", escalated: "needs-human", spend: "running", "run-refused": "blocked", "run-started": "running" };

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

  // W1-T141/W1-T435: the ONE-TAP OPERATOR VERDICT, on the RECENT feed's own terminal-outcome
  // rows -- "merged"/"verdict" (a review-derived merge or a classified blocked outcome, board.ts's
  // classifyLine) and "escalated" -- never a mid-rung row (fix/spend/run-started/run-refused),
  // which has no outcome yet for an operator to judge. \`drainRunId\` has no live producer of its
  // own (W1-T435 is entirely local-file: the ledger + plan/questions.ndjson, never a new
  // board.ts field) -- \`taskId:ts\` is this ONE feed event's own natural key (the SAME pair
  // \`renderRecent\`'s row \`key\` already uses), stable and unique per row without widening
  // RecentActivityEntry's shape.
  const DRAIN_FEEDBACK_VERBS = new Set(["merged", "verdict", "escalated"]);
  const DRAIN_FEEDBACK_VERDICT_LABEL = { good: "good", wrong: "wrong", "needs-follow-up": "needs follow-up" };
  function recentFeedbackHtml(e) {
    if (!DRAIN_FEEDBACK_VERBS.has(e.verb)) return "";
    const drainRunId = \`\${e.taskId}:\${e.ts}\`;
    const btns = Object.entries(DRAIN_FEEDBACK_VERDICT_LABEL)
      .map(([verdict, label]) => \`<button type="button" class="drain-feedback-btn"\${writeGateAttrs()} data-verdict="\${verdict}">\${escapeHtml(label)}</button>\`)
      .join("");
    return (
      \`<span class="drain-feedback" data-task-id="\${escapeHtml(e.taskId)}" data-drain-run-id="\${escapeHtml(drainRunId)}">\` +
      \`\${btns}\` +
      \`<textarea class="drain-feedback-note" rows="1" placeholder="steering note (optional) -- quoted verbatim into the next fix attempt"\${writeGateAttrs()}></textarea>\` +
      \`</span>\`
    );
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
      \`\${recentFeedbackHtml(e)}\` +
      rowChevronHtml()
    );
  }

  function renderRecent(entries) {
    const list = entries ?? [];
    // Keyed on taskId+ts+index (never bare taskId): the SAME task can carry many rows over
    // time (a verdict, a fix outcome, a spend checkpoint, …) -- an activity FEED, not one row
    // per task (W1-T156's DOM-stability reconciliation needs a key unique PER ROW, not per task).
    const rows = list.map((e, i) => ({ key: \`\${e.taskId}:\${e.ts}:\${i}\`, html: recentRowHtml(e), taskId: e.taskId }));
    reconcileRows(document.getElementById("recent-list"), rows, "no recent activity yet");
    finishSectionRender("recent", list.length === 0, () => recentSummaryText(list));
    return new Set(list.map((e) => e.taskId));
  }

  // ── W1-T163: "since you last checked" — a ONE-TIME recap, rendered off THIS page load's
  // FIRST /v1/status response and never again (see refreshAll's \`recapRendered\` gate, below).
  // Every subsequent poll's own \`recap\` field reflects an ALREADY-ADVANCED marker (board.ts
  // advances this token's marker on every view, per lib/last-seen.ts) — re-rendering off it would
  // make the section collapse to near-empty a few seconds after the operator opened the tab,
  // which is the opposite of "since you last checked". A plain \`<a href="#task=...">\` reuses the
  // SAME hash deep-link route \`applyDeepLinkIfNeeded\`/\`deepLinkTaskId\` already parse — no new
  // navigation mechanism. Unlike RECENT/NOW, this section is never DOM-reconciled afterward, so
  // a plain innerHTML build (not reconcileRows) is enough.
  const RECAP_KIND_LABEL = { merged: "merged", blocked: "blocked", escalated: "escalated", question_answered: "answered", retro: "retro run" };
  function recapRowHtml(e) {
    const label = RECAP_KIND_LABEL[e.kind] ?? e.kind;
    const detail = e.detail ? \` — \${escapeHtml(e.detail)}\` : "";
    const name = e.taskCardLink
      ? \`<a href="\${escapeHtml(e.taskCardLink)}">\${escapeHtml(e.title ? \`\${e.taskId} — \${e.title}\` : e.taskId)}</a>\`
      : escapeHtml(e.taskId);
    return \`<li>\${escapeHtml(label)}: \${name}\${detail} · \${escapeHtml(formatAgo(e.ts))}</li>\`;
  }
  // W1-T336: "recap" is hidden for TWO independent reasons that must never overwrite each
  // other -- its OWN content decision (recapWantsShow, set ONLY here, exactly as before this
  // task) and tab ownership (currentActiveTab, set only by applyActiveTab, below). Both are
  // combined here rather than either handler touching \`hidden\` alone, so a tab switch can hide
  // a genuinely-populated recap without lying about its content, and a later empty recap can
  // still hide itself even while its own tab is active.
  let recapWantsShow = false;
  function applyRecapVisibility() {
    const section = document.getElementById("recap");
    if (!section) return;
    section.hidden = !recapWantsShow || SECTION_TAB_OWNER.recap !== currentActiveTab;
  }
  function renderRecapSection(recap) {
    const list = document.getElementById("recap-list");
    if (!document.getElementById("recap") || !list) return;
    if (!Array.isArray(recap) || recap.length === 0) {
      recapWantsShow = false;
      applyRecapVisibility();
      return;
    }
    list.innerHTML = recap.map(recapRowHtml).join("");
    recapWantsShow = true;
    applyRecapVisibility();
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
      // W1-T222: the expand chevron rides on T157's row renderer, same as every other section --
      // "everything else" is a W1-T158 drill target too, never a second-class list.
      rowChevronHtml()
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

  /** REST's summary derives from \`complement\` -- the SAME array \`findTasks\`/the FIND corpus is
   *  built from just below -- never a second filter pass. It summarizes the COMPLEMENT ("everything
   *  else" not already surfaced in one of the four priority sections above), which stays the
   *  right number even while the FIND search/facets narrow what actually RENDERS inside; that is
   *  a further, separately-labelled view (#find-count) over this same corpus, not a disagreement. */
  function restSummaryText(complement) {
    if (complement.length === 0) return "nothing else to show";
    const queued = complement.filter((t) => statusColorKey(t) === "queued").length;
    const merged = complement.filter((t) => statusColorKey(t) === "merged").length;
    const other = complement.length - queued - merged;
    return \`queued: \${queued} · merged: \${merged} · other: \${other} (\${complement.length} total)\`;
  }
  function renderRest(tasks, shownIds) {
    findTasks = tasks; // the FIND corpus is the whole board (see the section header note)
    const complement = tasks.filter((t) => !shownIds.has(t.taskId));
    finishSectionRender("rest", complement.length === 0, () => restSummaryText(complement));
    if (!document.getElementById("rest-detail").hidden) renderFindView();
  }

  function expandRest() {
    const detail = document.getElementById("rest-detail");
    if (!detail.hidden) return;
    setSectionCollapsed("rest", false, { persist: false });
    renderFindView();
  }
  wireSectionToggle("rest", () => renderFindView());
  wireSectionToggle("now");
  wireSectionToggle("needs-me");
  wireSectionToggle("accepted");
  wireSectionToggle("up-next");
  wireSectionToggle("recent");
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

  // ── W1-T336: the four-tab console bar is now AUTHORITATIVE -- its OWN url state ────────────
  // Same idiom as FIND's round-trip just above -- URLSearchParams read fresh off
  // window.location.search, one key set, history.replaceState preserving token + every other
  // existing param -- a SEPARATE key ("tab") riding the page's ONE existing view-state
  // mechanism, never a second channel (no localStorage, no custom event). Selecting a tab still
  // issues no fetch, poll or gateway call -- it only flips each owned section's own \`hidden\`;
  // every section's own data keeps flowing (and its own badge/title effects keep firing)
  // regardless of which sections are currently shown.
  const CONSOLE_TABS = ["decisions", "now", "plan", "feed"];
  // Which tab owns each section, now that the tabs govern layout -- the single table the markup
  // above is a concrete rendering of (each owned section carries the SAME value as its own
  // data-owner-tab attribute). Kept here (not inferred from the DOM) so a reveal path
  // (jumpToTask/focusAndExpandTask, revealSectionOf, applyRecapVisibility, above) can look up a
  // section's owning tab without walking the tree.
  const SECTION_TAB_OWNER = {
    "needs-me": "decisions",
    now: "now",
    "up-next": "now",
    controls: "now",
    recap: "feed",
    accepted: "feed",
    recent: "feed",
    rest: "feed",
    more: "feed",
  };
  // The single source of truth for "which tab is active right now" -- read by applyRecapVisibility
  // (above) so recap's own content-hidden decision and tab ownership never fight over one
  // attribute. Written ONLY by applyActiveTab, immediately below.
  let currentActiveTab = "decisions";
  function readTabFromUrl() {
    const p = new URLSearchParams(window.location.search);
    const t = p.get("tab");
    if (CONSOLE_TABS.includes(t)) return t;
    // A bare FIND deep link (search/facet/sort, no explicit ?tab=) used to render its target row
    // directly in the flat shell; #rest now lives under Feed, so an old-style FIND link must
    // default there too -- this task's own falsifier is "any firehose row reachable today that
    // cannot be reached after the change," and a bookmarked search is exactly such a row.
    return findHasUrlState() ? "feed" : "decisions";
  }
  function writeTabToUrl(tab) {
    const p = new URLSearchParams(window.location.search); // preserve token + anything else already there
    if (tab && tab !== "decisions") p.set("tab", tab);
    else p.delete("tab"); // omit the default -> cleaner URLs that still round-trip, same convention as sort/dir
    const qs = p.toString();
    history.replaceState(null, "", (qs ? "?" + qs : window.location.pathname) + window.location.hash);
  }
  function applyActiveTab(tab, { persist } = { persist: true }) {
    currentActiveTab = tab;
    for (const btn of document.querySelectorAll("#console-tabs .tab-btn")) {
      btn.setAttribute("aria-selected", btn.dataset.tab === tab ? "true" : "false");
    }
    document.getElementById("tab-plan-panel").hidden = tab !== "plan";
    for (const [id, owner] of Object.entries(SECTION_TAB_OWNER)) {
      if (id === "recap") continue; // recap's own content decision combines with tab ownership in applyRecapVisibility, never here directly
      const el = document.getElementById(id);
      if (el) el.hidden = owner !== tab;
    }
    applyRecapVisibility();
    if (persist) writeTabToUrl(tab);
  }
  document.getElementById("console-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-btn");
    if (!btn) return;
    applyActiveTab(btn.dataset.tab);
  });
  // Restore the active tab from the URL BEFORE first paint, same reasoning as FIND above: a
  // shared/reloaded ?tab= link renders that exact view with no interaction. persist:false --
  // reading state must never itself rewrite the URL.
  applyActiveTab(readTabFromUrl(), { persist: false });

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
    // W1-T336: jumpToTask always lands in the rest/FIND corpus (the whole board, regardless of
    // which OTHER section a task also appears in) -- that corpus is owned by Feed, so the jump
    // must activate that tab too, or expandRest below clears #rest-detail's own hidden while
    // #rest itself stays hidden (its OWN owner-tab mismatch) and the row it "reveals" is
    // invisible anyway.
    applyActiveTab(SECTION_TAB_OWNER.rest);
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
  // W1-T350: one confirm-arm timer + one cached expansion PER answer form (a shared single
  // timer/cache, STOP's own shape, would misfire if two grill answers were mid-preview at
  // once) -- keyed by replyTo, mirroring approveConfirmTimers's own per-proposalId keying.
  const answerConfirmTimers = new Map();
  const answerExpansions = new Map();
  // W1-T2206: replyTo keys with a preview currently in flight -- membership (not a single
  // shared flag) is what keeps two DIFFERENT grill answers mid-preview at once independent,
  // matching answerConfirmTimers/answerExpansions's own per-replyTo discipline. This set is
  // also the re-entry guard the submit handler below checks in JS (see that comment for why
  // "disabled" alone is not enough).
  const answerPending = new Set();
  // W1-T2206 design (i): the pending state must be VISIBLE for the whole preview call --
  // disabled (so it doubles as the in-flight guard's own attribute) plus a plain-language label
  // naming what is happening. A text-label swap is chosen over a spinner: it is the SAME idiom
  // every other control in this file already uses for state (armed labels, DRAFTING, etc.), adds
  // no new CSS/animation surface, and needs no REDUCED_MOTION branch (W1-T156) since nothing
  // animates.
  function setAnswerPending(btn, pending) {
    btn.disabled = pending;
    btn.classList.toggle("pending", pending);
    btn.setAttribute("aria-busy", pending ? "true" : "false");
    if (pending) {
      btn.classList.remove("lapsed");
      btn.textContent = "Expanding your answer…";
      announce("Expanding your answer — this takes a few seconds.");
    }
  }
  // W1-T2206 design (iv): a lapsed 8s(→30s, see the timer below) arm resets SILENTLY today,
  // reading identically to a never-armed button -- the operator's next click then buys a THIRD
  // model call instead of filing what he thinks he already confirmed. "expired" marks that
  // distinctly (a ".lapsed" class + a label naming what happened) so it is never presented as a
  // fresh, un-clicked "Answer".
  function resetAnswerButton(btn, opts) {
    const expired = !!(opts && opts.expired);
    btn.dataset.confirming = "false";
    btn.setAttribute("aria-pressed", "false");
    btn.classList.remove("confirming");
    btn.classList.toggle("lapsed", expired);
    btn.textContent = expired ? "Answer (expired — click to retry)" : "Answer";
    const form = btn.closest(".needs-me-answer");
    const replyTo = form && form.dataset.replyTo;
    if (replyTo) {
      clearTimeout(answerConfirmTimers.get(replyTo));
      answerConfirmTimers.delete(replyTo);
      answerExpansions.delete(replyTo);
    }
  }
  document.getElementById("needs-me-list").addEventListener("submit", async (e) => {
    const answerForm = e.target.closest(".needs-me-answer");
    const reframeForm = e.target.closest(".needs-me-reframe");
    // W1-T202 defense-in-depth: the submit button itself carries 'disabled' while read-only
    // (writeGateAttrs), but a disabled submit button does not stop Enter-key implicit submission
    // in every engine -- never let a stale/read-only session's keystroke reach postJson.
    if (!hasWriteScope) { e.preventDefault(); return; }
    if (answerForm) {
      e.preventDefault();
      const replyTo = answerForm.dataset.replyTo;
      const input = answerForm.querySelector("input");
      const answer = input.value.trim();
      if (!answer) return;
      const submitBtn = answerForm.querySelector(".needs-me-answer-submit");
      // W1-T2206 design (ii): the pending state below IS the in-flight guard, but W1-T202's own
      // note is that "disabled" alone does not stop every engine's Enter-key implicit submit --
      // so a click/Enter landing on THIS replyTo while its preview is still resolving must
      // refuse in JS too, starting no second paid preview and filing nothing. Keyed per replyTo
      // so a second, DIFFERENT grill answer mid-preview stays fully independent.
      if (answerPending.has(replyTo)) return;
      // W1-T350: a SECOND submit while armed files WITH the expansion the first submit already
      // read back -- the round trip's whole point (never file an unseen rewrite).
      if (submitBtn.dataset.confirming === "true") {
        const expansion = answerExpansions.get(replyTo) ?? null;
        resetAnswerButton(submitBtn);
        await postJson("/v1/feedback", { text: answer, replyTo, expansion });
        input.value = "";
        refreshAll();
        return;
      }
      // First submit: PREVIEW the expansion -- FAIL-OPEN, never blocks filing on an expander
      // outage/timeout (this task's stated failure mode). W1-T2206: render the pending state for
      // the WHOLE call, and clear it on every exit below (expansion, no expansion, or a thrown/
      // rejected preview fetch) -- a pending state that survives a rejected fetch is a worse dead
      // button than the unguarded await it replaces.
      answerPending.add(replyTo);
      setAnswerPending(submitBtn, true);
      let expansion = null;
      try {
        const previewRes = await postJson("/v1/feedback/preview", { text: answer, replyTo });
        if (previewRes && previewRes.ok) {
          const previewBody = await previewRes.json();
          expansion = previewBody.expansion ?? null;
        }
      } catch {
        expansion = null;
      } finally {
        answerPending.delete(replyTo);
        setAnswerPending(submitBtn, false);
      }
      if (!expansion) {
        // W1-T2206 design (v): fail-open files on this ONE click with no confirm ever shown --
        // it must never borrow the armed vocabulary below, so an operator who just watched a
        // filing happen can tell it apart from a preview that armed instead.
        submitBtn.textContent = "Filed (no expansion available)";
        await postJson("/v1/feedback", { text: answer, replyTo });
        input.value = "";
        refreshAll();
        return;
      }
      // ARM: the armed control shows the expansion's read-back AND states plainly that nothing
      // is filed yet and the NEXT click is the one that files -- design (iii), the exact
      // ambiguity the operator hit ("no idea if I still need to address this... or not").
      answerExpansions.set(replyTo, expansion);
      submitBtn.dataset.confirming = "true";
      submitBtn.setAttribute("aria-pressed", "true");
      submitBtn.classList.add("confirming");
      submitBtn.classList.remove("lapsed");
      submitBtn.textContent =
        \`Confirm: \${expansion.claim} (RECON \${expansion.recon.length}) — nothing filed yet, click to file\`;
      clearTimeout(answerConfirmTimers.get(replyTo));
      // W1-T2206 design (iv): 8000ms (STOP/APPROVE/RUN/etc.'s shared window, all one-line
      // confirms) is shorter than the four-section expansion W1-T350 requires the operator to
      // READ before confirming -- the common case was a confirm click landing AFTER expiry,
      // silently buying a THIRD model call instead of filing. Widened to 30s to survive that
      // read, and the expiry itself is made VISIBLE (resetAnswerButton's "expired" state) so a
      // lapsed arm is never presented as a fresh, un-clicked one either way.
      answerConfirmTimers.set(
        replyTo,
        setTimeout(() => resetAnswerButton(submitBtn, { expired: true }), 30000),
      );
    } else if (reframeForm) {
      // W1-T193: REFRAME captures the operator's own words VERBATIM -- a textarea, not a link
      // to a terminal (the wrong asymmetry: agreeing easy, disagreeing hard). Wired to the
      // SAME write-token API POST /v1/inbox/approve uses, valid for the proposal WHATEVER its
      // current classification (rmd reframe's own contract -- never gated on still being READY).
      e.preventDefault();
      const proposalId = reframeForm.dataset.proposalId;
      const textarea = reframeForm.querySelector("textarea");
      const feedback = textarea.value.trim();
      if (!feedback) return;
      await postJson("/v1/inbox/reframe", { proposalId, feedback });
      textarea.value = "";
      refreshAll();
    }
  });
  // W1-T193: one confirm-arm timer PER proposal (a shared single timer, STOP's own shape,
  // would misfire if two proposal cards were armed at once) -- keyed by proposalId, mirroring
  // stopConfirmTimer's 8s reset exactly.
  const approveConfirmTimers = new Map();
  function resetApproveButton(btn) {
    btn.dataset.confirming = "false";
    btn.setAttribute("aria-pressed", "false");
    btn.classList.remove("confirming");
    btn.textContent = "Approve";
    clearTimeout(approveConfirmTimers.get(btn.dataset.proposalId));
    approveConfirmTimers.delete(btn.dataset.proposalId);
  }
  document.getElementById("needs-me-list").addEventListener("click", async (e) => {
    const decideBtn = e.target.closest(".needs-me-decide");
    const markHandledBtn = e.target.closest(".needs-me-mark-handled");
    const approveBtn = e.target.closest(".proposal-approve-btn");
    const rawBtn = e.target.closest(".needs-me-answer-raw");
    // W1-T202 defense-in-depth (see the submit handler above for why this exists alongside the
    // 'disabled' attribute already on each of these three buttons).
    if (!hasWriteScope && (decideBtn || markHandledBtn || approveBtn || rawBtn)) return;
    if (rawBtn) {
      // W1-T350: THE ESCAPE (design (iv)) -- one deliberate click, ALWAYS skips the preview and
      // files the plain submission, exactly the pre-this-task behavior. Never armed, never a
      // confirm -- distinct from Answer's own arm-then-confirm above.
      const form = rawBtn.closest(".needs-me-answer");
      const replyTo = form.dataset.replyTo;
      const input = form.querySelector("input");
      const answer = input.value.trim();
      if (!answer) return;
      resetAnswerButton(form.querySelector(".needs-me-answer-submit"));
      await postJson("/v1/feedback", { text: answer, replyTo });
      input.value = "";
      refreshAll();
    } else if (decideBtn) {
      await postJson("/v1/feedback/decision", { id: decideBtn.dataset.id, decision: decideBtn.dataset.decision });
      refreshAll();
    } else if (markHandledBtn) {
      // W1-T182: the escalation's own issue_url rides on the row's data attribute -- never an
      // operator-typed input, since the ledger (and now the live join) already holds it.
      await postJson("/v1/escalation/mark-handled", { taskId: markHandledBtn.dataset.taskId, issueUrl: markHandledBtn.dataset.issueUrl });
      refreshAll();
    } else if (approveBtn) {
      // W1-T193: APPROVE reuses fleet control's OWN arm-then-confirm discipline VERBATIM
      // (stop-btn's handler, below) -- a single click ARMS and does not act; a second click
      // within the window acts; the armed label reads back the drafted task ids being
      // approved (never a bare "Confirm?" -- the read-back belongs IN the confirm step).
      if (approveBtn.dataset.confirming !== "true") {
        approveBtn.dataset.confirming = "true";
        approveBtn.setAttribute("aria-pressed", "true");
        approveBtn.classList.add("confirming");
        approveBtn.textContent = \`Confirm approve \${approveBtn.dataset.readBack}?\`;
        clearTimeout(approveConfirmTimers.get(approveBtn.dataset.proposalId));
        approveConfirmTimers.set(
          approveBtn.dataset.proposalId,
          setTimeout(() => resetApproveButton(approveBtn), 8000),
        );
        return;
      }
      const proposalId = approveBtn.dataset.proposalId;
      resetApproveButton(approveBtn);
      await postJson("/v1/inbox/approve", { proposalId });
      refreshAll();
    }
  });

  // ── UP NEXT write-actions (fb-1784988460437-9daa9b): Run a queued task, Drain now ──────
  // Both reuse fleet control's OWN arm-then-confirm discipline (stop-btn, below): a single
  // click ARMS + reads back what it will do; a second click within 8s acts. Run is delegated
  // off #up-next-list (rows are reconciled), keyed by taskId so two armed rows never collide.
  // The API only DROPS a marker; the daemon dispatches (assertRunnable-gated) and its ANSWER —
  // "Run started", or "Run refused" carrying the refusal's own reason — lands in the RECENT feed
  // (board.ts's OPERATOR_ACTION_STEPS).
  // THIS COMMENT USED TO BE FALSE, and the falsehood cost a live incident: it asserted the refusal
  // surfaced "never silently" while computeRecentActivity's pseudo-id guard dropped every
  // DAEMON-stamped line before it could reach the UI. On 2026-07-31 a Run on an already-merged
  // W1-T152 was refused at 11:18:10.571Z and the operator saw nothing. W1-T266 made it true.
  const kickConfirmTimers = new Map();
  function resetRunButton(btn) {
    btn.dataset.confirming = "false";
    btn.setAttribute("aria-pressed", "false");
    btn.classList.remove("confirming");
    btn.textContent = "Run";
    clearTimeout(kickConfirmTimers.get(btn.dataset.taskId));
    kickConfirmTimers.delete(btn.dataset.taskId);
  }
  document.getElementById("up-next-list").addEventListener("click", async (e) => {
    const runBtn = e.target.closest(".up-next-run-btn");
    if (!runBtn) return;
    if (!hasWriteScope) return; // W1-T202 defense-in-depth alongside runBtn's own 'disabled'
    e.stopPropagation(); // never let a Run click also expand the row
    if (runBtn.dataset.confirming !== "true") {
      runBtn.dataset.confirming = "true";
      runBtn.setAttribute("aria-pressed", "true");
      runBtn.classList.add("confirming");
      runBtn.textContent = \`Confirm run \${runBtn.dataset.taskId}?\`;
      clearTimeout(kickConfirmTimers.get(runBtn.dataset.taskId));
      kickConfirmTimers.set(runBtn.dataset.taskId, setTimeout(() => resetRunButton(runBtn), 8000));
      return;
    }
    const taskId = runBtn.dataset.taskId;
    resetRunButton(runBtn);
    await postJson("/v1/drain/kick", { taskId });
    refreshAll();
  });
  let drainConfirmTimer;
  function resetDrainButton() {
    const btn = document.getElementById("drain-now-btn");
    btn.dataset.confirming = "false";
    btn.setAttribute("aria-pressed", "false");
    btn.classList.remove("confirming");
    btn.textContent = "Gather now";
    clearTimeout(drainConfirmTimer);
  }
  document.getElementById("drain-now-btn").addEventListener("click", () => {
    if (!hasWriteScope) return; // W1-T202 defense-in-depth alongside this button's own 'disabled'
    const btn = document.getElementById("drain-now-btn");
    if (btn.dataset.confirming !== "true") {
      btn.dataset.confirming = "true";
      btn.setAttribute("aria-pressed", "true");
      btn.classList.add("confirming");
      btn.textContent = "Confirm gather now?";
      clearTimeout(drainConfirmTimer);
      drainConfirmTimer = setTimeout(() => resetDrainButton(), 8000);
      return;
    }
    resetDrainButton();
    postJson("/v1/drain/run").then(refreshAll);
  });

  // ── W1-T364: the daily-cost-ceiling WRITE control -- arm-then-confirm like STOP/Drain now
  // above (design note ii: "never a bare Confirm"), the read-back IN the armed label carrying the
  // new value, what it was, and the restart truth verified from source at implement time:
  // dailyCostCeilingReloader (run-task.ts) re-resolves the ceiling fresh on EVERY daemon tick
  // (W1-T363), so a write here needs no restart -- unlike a committed plan/policy.yaml edit,
  // which loadDefaultPolicy memoizes for the process lifetime (plan/policy.yaml's own comment on
  // that row). Set RE-ARMS (rather than confirming stale) if the input value changes between the
  // two clicks, so editing the number after arming can never fire the earlier figure.
  let ceilingSetConfirmTimer;
  function resetCeilingSetButton() {
    const btn = document.getElementById("cost-ceiling-set-btn");
    btn.dataset.confirming = "false";
    btn.dataset.armedUsd = "";
    btn.setAttribute("aria-pressed", "false");
    btn.classList.remove("confirming");
    btn.textContent = "Set ceiling";
    clearTimeout(ceilingSetConfirmTimer);
  }
  document.getElementById("cost-ceiling-set-btn").addEventListener("click", () => {
    if (!hasWriteScope) return; // W1-T202 defense-in-depth alongside this button's own 'disabled'
    const btn = document.getElementById("cost-ceiling-set-btn");
    const input = document.getElementById("cost-ceiling-input");
    const raw = input.value.trim();
    const usd = Number(raw);
    if (!raw || !Number.isFinite(usd)) return; // nothing typed / not a number -- never arm on garbage
    if (btn.dataset.confirming !== "true" || btn.dataset.armedUsd !== String(usd)) {
      btn.dataset.confirming = "true";
      btn.dataset.armedUsd = String(usd);
      btn.setAttribute("aria-pressed", "true");
      btn.classList.add("confirming");
      const was = latestAccountUsage && latestAccountUsage.dailyCostCeilingUsd != null ? costLabel(latestAccountUsage.dailyCostCeilingUsd) : "unknown";
      btn.textContent = \`Confirm: set ceiling to \${costLabel(usd)} (was \${was}) — effective next tick, no restart?\`;
      clearTimeout(ceilingSetConfirmTimer);
      ceilingSetConfirmTimer = setTimeout(() => resetCeilingSetButton(), 8000);
      return;
    }
    resetCeilingSetButton();
    postJson("/v1/policy/daily-cost-ceiling", { usd }).then(refreshAll);
  });
  let ceilingClearConfirmTimer;
  function resetCeilingClearButton() {
    const btn = document.getElementById("cost-ceiling-clear-btn");
    btn.dataset.confirming = "false";
    btn.setAttribute("aria-pressed", "false");
    btn.classList.remove("confirming");
    btn.textContent = "Clear override";
    clearTimeout(ceilingClearConfirmTimer);
  }
  document.getElementById("cost-ceiling-clear-btn").addEventListener("click", () => {
    if (!hasWriteScope) return; // W1-T202 defense-in-depth alongside this button's own 'disabled'
    const btn = document.getElementById("cost-ceiling-clear-btn");
    if (btn.dataset.confirming !== "true") {
      btn.dataset.confirming = "true";
      btn.setAttribute("aria-pressed", "true");
      btn.classList.add("confirming");
      const def = latestAccountUsage && latestAccountUsage.dailyCostCeilingDefaultUsd != null ? costLabel(latestAccountUsage.dailyCostCeilingDefaultUsd) : "the committed default";
      btn.textContent = \`Confirm: clear override — reverts to \${def} — effective next tick, no restart?\`;
      clearTimeout(ceilingClearConfirmTimer);
      ceilingClearConfirmTimer = setTimeout(() => resetCeilingClearButton(), 8000);
      return;
    }
    resetCeilingClearButton();
    postJson("/v1/policy/daily-cost-ceiling/clear").then(refreshAll);
  });

  // ── fleet control READ-BACK (W1-T153): render the ACTIVE mode, never stateless buttons ──
  // W1-T202: ALSO the write-lock read-back for these five controls -- 'locked' composes with the
  // mode-derived disable so a write-scope flip (probeWriteScope, below) and a mode flip (a real
  // GET /v1/control/status fetch) never fight over the same '.disabled' bit.
  function applyControlStatus(status) {
    // recon-blackout rec-2: THREE FORMERLY-IDENTICAL STATES, THREE SENTENCES. A stale heartbeat is
    // evidence the daemon is DOWN; an absent or unreadable ledger is evidence of nothing at all.
    // Both used to print "fleet liveness not observed", so the console could decline to say the
    // fleet was alive but could never say it was dead, and could never say why. Keyed off the
    // reason the route now always sends (panel-actions.ts's DaemonLivenessReason), never
    // re-derived here. Every unknown names its own cause — the shape rmd status already uses when
    // it prints an unknown section beside the reason it could not compute it, not an empty one.
    //
    // DECLARED INSIDE THIS FUNCTION, DELIBERATELY. test/control-status-daemon-liveness.test.ts
    // lifts applyControlStatus out of the rendered HTML by regex (its clientFn helper) and evaluates
    // that ONE function in a sandbox, so anything it reads from an enclosing scope is a
    // ReferenceError there — three of that suite's tests went red on exactly that when this table
    // sat one scope out. A helper an extracted function needs must live inside it.
    const LIVENESS_TEXT = {
      "fresh-poll": "fleet is running",
      "last-poll-stale": "fleet is DOWN — no daemon heartbeat inside the liveness bound",
      "no-daemon-activity": "fleet is DOWN — the ledger records no daemon activity at all",
      "ledger-empty": "fleet liveness unknown — the ledger is empty, so there is no evidence either way",
      "ledger-absent": "fleet liveness unknown — no ledger file at the configured path",
      "ledger-unreadable": "fleet liveness unknown — the ledger could not be read",
    };
    lastControlStatus = status;
    const pauseBtn = document.getElementById("pause-btn");
    const resumeBtn = document.getElementById("resume-btn");
    const stopBtn = document.getElementById("stop-btn");
    const quietHours = document.getElementById("quiet-hours");
    const drainBtn = document.getElementById("drain-now-btn");
    // W1-T364: the ceiling control's own three write-gated elements, on the SAME static
    // fleet-control row gating surface as pause/resume/stop/quiet-hours/drain above.
    const ceilingInput = document.getElementById("cost-ceiling-input");
    const ceilingSetBtn = document.getElementById("cost-ceiling-set-btn");
    const ceilingClearBtn = document.getElementById("cost-ceiling-clear-btn");
    const locked = !hasWriteScope;
    const lockTitle = "Read-only — enter a write token to enable this action";
    pauseBtn.setAttribute("aria-pressed", String(status.paused));
    pauseBtn.classList.toggle("active", status.paused);
    pauseBtn.disabled = locked || status.paused || status.stopped;
    stopBtn.setAttribute("aria-pressed", String(status.stopped));
    stopBtn.classList.toggle("active", status.stopped);
    stopBtn.disabled = locked;
    resumeBtn.disabled = locked || (!status.paused && !status.stopped);
    resumeBtn.setAttribute("aria-pressed", String(!status.paused && !status.stopped && false));
    quietHours.disabled = locked;
    quietHours.checked = status.quietHours;
    if (drainBtn) drainBtn.disabled = locked;
    if (ceilingInput) ceilingInput.disabled = locked;
    if (ceilingSetBtn) ceilingSetBtn.disabled = locked;
    if (ceilingClearBtn) ceilingClearBtn.disabled = locked;
    pauseBtn.title = locked ? lockTitle : "";
    resumeBtn.title = locked ? lockTitle : "";
    stopBtn.title = locked ? lockTitle : "";
    quietHours.title = locked ? lockTitle : "";
    if (drainBtn) drainBtn.title = locked ? lockTitle : "";
    if (ceilingInput) ceilingInput.title = locked ? lockTitle : "";
    if (ceilingSetBtn) ceilingSetBtn.title = locked ? lockTitle : "";
    if (ceilingClearBtn) ceilingClearBtn.title = locked ? lockTitle : "";
    // W1-T288: STOP/PAUSE win over liveness. With neither flag set, 'fleet is running' is gated
    // on a real ledger heartbeat GET /v1/control/status carries, never inferred from the mere
    // absence of a stop/pause flag file -- a crashed daemon leaves no stop flag behind, so that
    // absence alone used to render identically to a healthy fleet.
    //
    // recon-blackout rec-2 refines that: W1-T288's "third answer" was still ONE bucket holding two unlike
    // things -- 'the daemon ran and stopped' and 'I have no ledger to look at' both landed on the
    // same sentence. The reason code splits them, so DOWN is now sayable and every unknown names
    // its cause. The trailing || keeps the pre-recon-blackout rec-2 sentence for a response carrying no reason
    // at all, so a client loaded against an older server degrades to what it always said.
    const detail = status.stopped
      ? status.stopDetail
      : status.paused
        ? status.pauseDetail
        : LIVENESS_TEXT[status.daemonLiveReason] || "fleet liveness not observed";
    document.getElementById("controls-status").textContent =
      detail ?? (status.stopped ? "stopped" : status.paused ? "paused" : status.daemonLive ? "running" : "unobserved");
  }

  // ── STOP requires an explicit second click ("Confirm STOP") — never a single click ──────
  let stopConfirmTimer;
  document.getElementById("stop-btn").addEventListener("click", () => {
    if (!hasWriteScope) return; // W1-T202 defense-in-depth alongside this button's own 'disabled'
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
    if (!hasWriteScope) return; // W1-T202 defense-in-depth alongside this button's own 'disabled'
    postJson("/v1/control/pause", { reason: document.getElementById("reason").value || undefined }).then(refreshAll);
  });
  document.getElementById("resume-btn").addEventListener("click", () => {
    if (!hasWriteScope) return; // W1-T202 defense-in-depth alongside this button's own 'disabled'
    postJson("/v1/control/resume").then(refreshAll);
  });
  document.getElementById("quiet-hours").addEventListener("change", (e) => {
    if (!hasWriteScope) return; // W1-T202 defense-in-depth alongside this control's own 'disabled'
    postJson("/v1/quiet-hours", { enabled: e.target.checked }).then(refreshAll);
  });

  // ── W1-T202: the write-token entry/clear UI -- the ONLY place a write token is ever accepted
  // from the operator. Submitting stores it in sessionStorage (never the URL/history, never a
  // ledger line, never a log line) and re-probes scope immediately; clearing drops it and reverts
  // every write affordance to its disabled/explained state WITHOUT a reload. ──────────────────
  function updateWriteTokenUi() {
    const statusEl = document.getElementById("write-token-status");
    const form = document.getElementById("write-token-form");
    const clearBtn = document.getElementById("write-token-clear-btn");
    if (hasWriteScope) {
      statusEl.textContent = "Write access enabled for this tab.";
      form.hidden = true;
      clearBtn.hidden = false;
    } else {
      statusEl.textContent = writeToken
        ? "That write token was not accepted — write actions stay unavailable."
        : "Read-only — write actions are unavailable. Enter a write token to enable them for this tab. Get one by running: rmd console-url --write";
      form.hidden = false;
      clearBtn.hidden = true;
    }
    paintWriteStateBadge();
  }
  // impl-DY: THREE states, never two. "no token" and "token rejected" are different problems with different
  // remedies, and collapsing them is what misled the operator - he HAD set a token, so being told to set one
  // read as the console being broken. Driven off hasWriteScope (the probe result) plus whether a token is
  // held, so a token that is present but not ACCEPTED renders REJECTED, never enabled.
  function paintWriteStateBadge() {
    const badge = document.getElementById("write-state-badge");
    if (!badge) return;
    if (hasWriteScope) {
      badge.dataset.writeState = "write";
      badge.textContent = "Write access enabled — Accept, Reject, Mark handled, Run, Gather and fleet control are live.";
    } else if (writeToken) {
      badge.dataset.writeState = "rejected";
      badge.textContent = "Write token REJECTED — every write control is disabled. Clear it and paste a current one from: rmd console-url --write";
    } else {
      badge.dataset.writeState = "read-only";
      badge.textContent = "READ-ONLY — no write token in this tab, so every write control is disabled. Get one with: rmd console-url --write";
    }
  }
  // W1-T202: re-resolves hasWriteScope off the CURRENT client-held write token (never the URL) --
  // called at boot and every time that token changes, since it can now change mid-session with no
  // reload. Re-applies BOTH gating surfaces (the static fleet-control row via applyControlStatus,
  // the dynamic NEEDS ME/UP NEXT rows via paintFromTasksById re-running writeGateAttrs) so a flip
  // takes effect immediately rather than waiting for the next poll tick.
  async function probeWriteScope() {
    if (!writeToken) {
      hasWriteScope = false;
    } else {
      try {
        const res = await fetch("/v1/auth/scope", { headers: writeAuthHeaders() });
        hasWriteScope = res.ok;
      } catch {
        hasWriteScope = false;
      }
    }
    document.body.dataset.writeScopeResolved = "1";
    updateWriteTokenUi();
    applyControlStatus(lastControlStatus);
    if (firstStatusLoaded) paintFromTasksById(); // else: the W1-T200 skeleton is already correct — see firstStatusLoaded's own doc
  }
  document.getElementById("write-token-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("write-token-input");
    const value = input.value.trim();
    input.value = "";
    if (!value) return;
    writeToken = value;
    try {
      window.sessionStorage.setItem(WRITE_TOKEN_STORAGE_KEY, writeToken);
    } catch {
      // storage disabled/blocked -- the token still works for THIS page load via the in-memory
      // 'writeToken' above; it just will not survive a reload. Never fall back to the URL/a cookie.
    }
    probeWriteScope();
  });
  document.getElementById("write-token-clear-btn").addEventListener("click", () => {
    writeToken = "";
    try {
      window.sessionStorage.removeItem(WRITE_TOKEN_STORAGE_KEY);
    } catch {
      // storage disabled/blocked -- writeToken is already cleared in memory, which is what
      // every outbound request and every render actually reads.
    }
    hasWriteScope = false;
    document.body.dataset.writeScopeResolved = "1";
    updateWriteTokenUi();
    applyControlStatus(lastControlStatus);
    if (firstStatusLoaded) paintFromTasksById(); // else: the W1-T200 skeleton is already correct — see firstStatusLoaded's own doc
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
  // ── W1-T222 INLINE DETAIL layer: the row-click task CARD, now a sibling <li> DIRECTLY BENEATH
  // the row that opened it -- never a scroll-away section. title/rationale/acceptance criteria/
  // dependency chain (each dep LINKED)/run history (cost + verdict)/PR + issue links -- from ONE
  // GET /v1/task?id= fetch, zero further GitHub calls (see lib/task-card.ts's header). Dep links
  // recurse through focusAndExpandTask, never a page navigation. Exactly ONE card is open at a
  // time, board-wide (opening a second closes the first) -- reconcileRows above is what keeps
  // that one open card glued to its own row across a background poll/SSE re-render.
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
  /** \`live\`, when present, is this task's CURRENT tasksById projection (needsHuman/
   *  escalationIssueUrl) -- the card's issue link and write action both key off it rather than
   *  off the TaskCard response, which carries no live escalation state of its own. */
  function cardIssueLinkHtml(live) {
    if (!live || !live.escalationIssueUrl) return "";
    return \`<p><a href="\${escapeHtml(live.escalationIssueUrl)}" target="_blank" rel="noopener noreferrer">view issue</a></p>\`;
  }
  /**
   * W1-T222: "actions RENDER PER AUTH SCOPE -- a read-only bookmark shows no write affordances
   * at all, rather than showing them and failing on click" (standing rule 22). \`hasWriteScope\`
   * is resolved ONCE at boot (see the GET /v1/auth/scope probe near this shell's bootstrap) --
   * with a read-only token this always returns "", so the card carries zero write controls, not
   * a disabled/explained one (that richer "unavailable, here's why" treatment is W1-T202's own
   * job -- see this task's plan note on the two coordinating rather than colliding).
   */
  function cardActionsHtml(taskId, live) {
    if (!hasWriteScope) return "";
    if (!live || !live.needsHuman || !live.escalationIssueUrl) return "";
    return (
      \`<p class="btn-row"><button type="button" class="card-mark-handled" data-task-id="\${escapeHtml(taskId)}" data-issue-url="\${escapeHtml(live.escalationIssueUrl)}">Mark handled</button></p>\`
    );
  }
  function rowDetailBodyHtml(card, live) {
    const key = statusColorKey({ status: card.status, needsHuman: Boolean(live && live.needsHuman) });
    return (
      \`<p class="row-detail-title">\${escapeHtml(card.id)} — \${escapeHtml(card.title)}</p>\` +
      \`<p>\${statusBadge(key)}\${card.merged ? " ✓ merged" : ""}\${prLink({ prUrl: card.prUrl, prNumber: card.prNumber })}</p>\` +
      cardIssueLinkHtml(live) +
      (card.rationale ? \`<p class="detail">\${escapeHtml(card.rationale)}</p>\` : '<p class="empty">no rationale recorded</p>') +
      \`<h3>Acceptance criteria</h3>\${
        card.acceptance.length ? \`<ul class="row-list">\${card.acceptance.map(acceptanceRowHtml).join("")}</ul>\` : '<p class="empty">none recorded</p>'
      }\` +
      \`<h3>Dependency chain</h3>\${depChainHtml(card.dependsOn)}\` +
      \`<h3>Run history</h3>\${
        card.runs.length ? \`<ul class="row-list">\${card.runs.map(runRowHtml).join("")}</ul>\` : '<p class="empty">no runs yet</p>'
      }\` +
      cardActionsHtml(card.id, live) +
      // W1-T222: the full JOURNEY LAZY-LOADS INSIDE the expansion on demand -- it must not be
      // fetched merely because a card opened (design). toggleCardJourney (below) fetches GET
      // /v1/trace on this button's FIRST click only, caching the result in .card-journey-body.
      \`<p><button type="button" class="card-journey-toggle" data-task-id="\${escapeHtml(card.id)}" aria-expanded="false">Show journey</button></p>\` +
      '<div class="card-journey-body" hidden></div>'
    );
  }
  /** W1-T200: a pre-data-only skeleton, cleared the instant loadRowDetail below actually renders
   *  (success OR failure) -- never left standing as decoration once real content exists. */
  function rowDetailSkeletonHtml() {
    return (
      '<div aria-busy="true">' +
      '<div class="skeleton-bar"></div><div class="skeleton-bar"></div><div class="skeleton-bar"></div>' +
      "</div>"
    );
  }
  async function loadRowDetail(taskId, detailEl) {
    let card;
    try {
      const data = await getJson(\`/v1/task?id=\${encodeURIComponent(taskId)}\`);
      card = data.card;
    } catch (e) {
      if (detailEl.isConnected) detailEl.innerHTML = \`<p class="empty">card fetch failed: \${escapeHtml(String(e))}</p>\`;
      return;
    }
    // The operator may have collapsed this card (or opened a different one) while the fetch was
    // in flight -- collapseExpanded/expandRow already detached this exact node in that case, so
    // writing into it now would resurrect a stale card nobody asked to see. isConnected guards it.
    if (!detailEl.isConnected) return;
    const live = tasksById.get(taskId);
    detailEl.innerHTML = rowDetailBodyHtml(card, live);
  }

  // ── W1-T222 EXPAND/COLLAPSE: exactly ONE row's card open at a time, board-wide. \`expandedRowKey\`
  // is the owning row's OWN \`data-key\` (never a bare taskId -- RECENT's rows are keyed
  // \`taskId:ts:i\`, so several rows can share a taskId; expanding is always THIS row's own card). ──
  let expandedRowKey = null;

  function collapseExpanded() {
    if (expandedRowKey === null) return;
    const row = document.querySelector(\`.row[data-key="\${CSS.escape(expandedRowKey)}"]\`);
    if (row) {
      row.setAttribute("aria-expanded", "false");
      row.removeAttribute("aria-controls");
    }
    const detailEl = document.querySelector(".row-detail[data-detail-for]");
    if (detailEl) detailEl.remove();
    expandedRowKey = null;
  }
  function expandRow(row, key, taskId) {
    expandedRowKey = key;
    row.setAttribute("aria-expanded", "true");
    const detailEl = document.createElement("li");
    detailEl.className = "row-detail";
    detailEl.dataset.detailFor = key;
    const detailId = \`row-detail-\${key.replace(/[^a-zA-Z0-9_-]/g, "-")}\`;
    detailEl.id = detailId;
    // Deliberately NO role="region" -- this <li> is a direct child of the SAME <ul> its row
    // lives in, and a widget/landmark role here would demote it out of the <ul>'s own required
    // listitem content model, exactly like role="button" would on the row itself (see
    // reconcileRows's own note). aria-controls on the row is the accessible link between them.
    detailEl.setAttribute("aria-label", \`Detail for \${taskId}\`);
    row.setAttribute("aria-controls", detailId);
    detailEl.innerHTML = rowDetailSkeletonHtml();
    row.after(detailEl); // W1-T222: DIRECTLY beneath the row -- never a scroll-away section.
    loadRowDetail(taskId, detailEl);
  }
  /** Enter/Space (keydown) and a plain click on a row both funnel here -- re-toggling the SAME
   *  row collapses it; toggling a DIFFERENT row closes whichever was open first (only one at a
   *  time). Focus is never programmatically moved by either branch, so it stays exactly where
   *  the operator put it (the row itself) across the toggle, per this task's own a11y bar. */
  function toggleRowDetail(row) {
    const key = row.dataset.key;
    const taskId = row.dataset.taskId;
    if (!taskId) return;
    if (expandedRowKey === key) {
      collapseExpanded();
      return;
    }
    collapseExpanded();
    expandRow(row, key, taskId);
  }
  function findRowByTaskId(taskId) {
    return document.querySelector(\`.row[data-task-id="\${CSS.escape(taskId)}"]\`);
  }
  /**
   * A dependency link / journey task link / \`?task=<id>\` deep link all land here: find that
   * task's OWN row wherever it currently lives and expand its card there -- never a bare id
   * lookup with no row to anchor to. If no section currently renders a row for it (most likely
   * because it is buried in "everything else"), force it into view the SAME way the cmd+K
   * palette's jumpToTask already does: expand "everything else" and search for the exact id
   * (a literal id is always its own fuzzy-match subsequence, so this is guaranteed to surface
   * exactly that one task). Returns whether a row was found.
   */
  function focusAndExpandTask(taskId) {
    let row = findRowByTaskId(taskId);
    if (!row) {
      expandRest();
      findState.q = taskId;
      document.getElementById("find-search").value = taskId;
      applyFindState();
      row = findRowByTaskId(taskId);
    }
    if (!row) return false;
    // W1-T223: the row's own SECTION can now be collapsed (previously only "everything else"
    // could be) -- reveal it first, or this would land the operator on a hidden target.
    revealSectionOf(row);
    if (expandedRowKey !== row.dataset.key) {
      collapseExpanded();
      expandRow(row, row.dataset.key, taskId);
    }
    row.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return true;
  }

  // ── W1-T222 JOURNEY (rmd trace's own provenance chain, W1-T43) -- LAZY, INSIDE the open card,
  // reached ONLY via that card's own toggle or a dependency/journey-task link -- never a typed
  // id, never its own bottom panel (the v0 panel W1-T158 retired, and the ONE this task retires
  // in turn). Mirrors apps/dashboard/src/main.ts's renderTraceGraph shape (the SAME GET
  // /v1/trace response), plus ONE addition: a run whose verdict starts with "blocked" is marked
  // .journey-fail -- the FAILING step an operator walks backwards from an outcome to find.
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
  function toggleCardJourney(btn) {
    const body = btn.closest(".row-detail")?.querySelector(".card-journey-body");
    if (!body) return;
    const expanded = btn.getAttribute("aria-expanded") === "true";
    if (expanded) {
      btn.setAttribute("aria-expanded", "false");
      btn.textContent = "Show journey";
      body.hidden = true;
      return;
    }
    btn.setAttribute("aria-expanded", "true");
    btn.textContent = "Hide journey";
    body.hidden = false;
    if (body.dataset.loaded === "true") return; // fetched once per card open; re-toggling just shows/hides it.
    body.setAttribute("aria-busy", "true");
    body.innerHTML = '<div class="skeleton-bar"></div>';
    getJson(\`/v1/trace?id=\${encodeURIComponent(btn.dataset.taskId)}\`)
      .then((data) => {
        body.innerHTML = journeyHtml(data.chain);
        body.dataset.loaded = "true";
      })
      .catch((e) => {
        body.innerHTML = \`<p class="empty">journey fetch failed: \${escapeHtml(String(e))}</p>\`;
      })
      .finally(() => body.removeAttribute("aria-busy"));
  }

  // ── ROW CLICK/KEYBOARD delegation (main), event delegation since every list re-renders on
  // every refresh. Checked in order: an in-card action (dep link / journey toggle / mark
  // handled) first -- these ARE inside "a, button, input, form, label" so they must be matched
  // before that generic bail-out below, exactly as W1-T158's per-row Journey button was. Then
  // the generic bail-out (existing NEEDS ME approve/answer controls and PR links keep working
  // unchanged). Only then: a plain click anywhere else on a task row toggles ITS OWN card. ──────
  document.querySelector("main").addEventListener("click", (e) => {
    // W1-T435: the RECENT feed's one-tap operator verdict + steering note. Matched FIRST (like
    // every other in-row control above) -- a click on the note textarea itself is not a button/
    // link/input the generic bail-out below would catch, so without this branch it would fall
    // through to the plain-row-toggle at the bottom and collapse/expand the card mid-typing.
    // The success/failure NARRATIVE is the shared write-ack banner (postJson's own showWriteAck/
    // showWriteError, WRITE_ACK's "/v1/drain/feedback" entry) -- this handler only manages the
    // per-row button-disable state, never a second acknowledgement surface.
    const feedbackWrap = e.target.closest(".drain-feedback");
    if (feedbackWrap) {
      const feedbackBtn = e.target.closest(".drain-feedback-btn");
      if (feedbackBtn && hasWriteScope && !feedbackBtn.disabled) {
        const taskId = feedbackWrap.dataset.taskId;
        const drainRunId = feedbackWrap.dataset.drainRunId;
        const verdict = feedbackBtn.dataset.verdict;
        const noteEl = feedbackWrap.querySelector(".drain-feedback-note");
        const note = noteEl && noteEl.value.trim() ? noteEl.value.trim() : undefined;
        feedbackWrap.querySelectorAll(".drain-feedback-btn").forEach((b) => (b.disabled = true));
        postJson("/v1/drain/feedback", { taskId, verdict, drainRunId, ...(note ? { note } : {}) })
          .then((res) => {
            if (res.ok && noteEl) noteEl.disabled = true;
            // a failed write (401/404/500) re-arms the buttons so a transient failure isn't a dead end.
            if (!res.ok) feedbackWrap.querySelectorAll(".drain-feedback-btn").forEach((b) => (b.disabled = false));
          })
          .catch(() => {
            feedbackWrap.querySelectorAll(".drain-feedback-btn").forEach((b) => (b.disabled = false));
          });
      }
      return; // never let a click anywhere in this control (including the textarea) toggle the row
    }
    const depBtn = e.target.closest(".card-dep-link");
    if (depBtn) { focusAndExpandTask(depBtn.dataset.depId); return; }
    const journeyTaskLink = e.target.closest(".journey-task-link");
    if (journeyTaskLink) { focusAndExpandTask(journeyTaskLink.dataset.taskId); return; }
    const journeyToggle = e.target.closest(".card-journey-toggle");
    if (journeyToggle) { toggleCardJourney(journeyToggle); return; }
    const markHandledBtn = e.target.closest(".card-mark-handled");
    if (markHandledBtn) {
      // W1-T202 defense-in-depth: cardActionsHtml already renders NO button at all when
      // !hasWriteScope (W1-T222's own, unchanged, hide-entirely treatment), so this only ever
      // guards a stale scope flip between render and click.
      if (!hasWriteScope) return;
      postJson("/v1/escalation/mark-handled", { taskId: markHandledBtn.dataset.taskId, issueUrl: markHandledBtn.dataset.issueUrl }).then(refreshAll);
      return;
    }
    if (e.target.closest("a, button, input, form, label")) return;
    const row = e.target.closest(".row[data-task-id]");
    if (row) toggleRowDetail(row);
  });
  // W1-T222: Enter/Space toggle -- ONLY when the ROW ITSELF is the keydown target (a nested
  // control, e.g. the mark-handled button, already handles its own Enter/Space via native click
  // semantics, which the click listener above already routes correctly).
  document.querySelector("main").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    if (!e.target.classList || !e.target.classList.contains("row") || !e.target.dataset.taskId) return;
    e.preventDefault(); // Space must not also scroll the page.
    toggleRowDetail(e.target);
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
  const POLL_INTERVAL_MS = 3000; // the SAME cadence refreshAll is scheduled at, below.
  // W1-T189: how long with NO live data from ANY source (poll success or SSE delta) before the
  // board is genuinely stale. Anchored to the SAME N-failures-at-the-poll-cadence budget the
  // original counter approximated, but now measured against actual elapsed time rather than a
  // raw tally that is blind to a healthy SSE connection.
  const STALE_DATA_AGE_MS = STALE_ESCALATE_AFTER * POLL_INTERVAL_MS;
  // W1-T189: bounds a single /v1/status fetch so a genuine backend stall (W1-T187) still lands
  // in this SAME failure lifecycle instead of hanging past every poll tick with no indication.
  const STATUS_FETCH_TIMEOUT_MS = 8000;
  let pollFailures = 0;
  let lastSuccessAt = null;
  let lastLiveAt = null; // last successful data of ANY kind -- a poll success OR an SSE event.
  let recapRendered = false; // W1-T163: renders off THIS page load's FIRST /v1/status only -- see renderRecapSection's own doc.

  // W1-T281: the console's ONE freshness model (lib/console-freshness.ts's \`resolveFreshness\`,
  // shipped by W1-T262/#777) EMBEDDED VERBATIM -- this is \`resolveFreshness.toString()\` off the
  // REAL import above, not a hand-typed copy, so this shell can never again drift from the
  // unit-tested rule the way it did for eight days (the ONLY prior reference to it anywhere
  // outside its own test was a COMMENT claiming to "mirror" it -- serve.ts never actually called
  // it, so the STALE badge and "live · updated Ns ago" kept contradicting each other). Every
  // freshness decision below (markStale's guard, handlePollFailure's escalation) calls THIS.
  const resolveFreshness = ${resolveFreshness.toString()};

  function touchFreshness() {
    lastLiveAt = Date.now();
    // Fresh data just landed from SOME transport (poll success or SSE delta) ⇒ the pane is no
    // longer stale (fb-…c124f9): clear any lingering STALE banner, even a cache-seeded one that a
    // poll never cleared because only the SSE was delivering — the exact "STALE beside live ·
    // updated Ns ago" co-display the operator screenshotted. ONE clock (lastLiveAt) now both
    // raises (markStale's guard) and lowers the banner, so the two can never contradict.
    clearStale();
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

  // W1-T189 ONE TRUTH: an operator-observed contradiction -- "live · updated 8s ago" rendered
  // directly above "STALE — showing last known data" -- came from two indicators reading
  // DIFFERENT clocks: the freshness stamp tracks \`lastLiveAt\` (poll success OR SSE delta), while
  // this escalation used to track ONLY a raw consecutive-/v1/status-failure tally, blind to a
  // healthy SSE connection still delivering genuinely fresh rows. A board can be honestly LIVE
  // (via SSE) even while its own REST poll is failing outright -- so the STALE claim (not the
  // transient "reconnecting" one) must also require that NO live data of any kind is recent.
  // W1-T281: that requirement IS resolveFreshness's own rule -- called here directly (fed
  // \`lastLiveAt\`, never re-derived from the SSE transport's own "connected" bit -- see
  // markStale's doc for why a merely-connected-but-idle stream must still be able to go stale)
  // instead of a second, hand-inlined \`dataIsStale\` arithmetic check that could (and did) drift
  // from the tested module.
  function handlePollFailure() {
    pollFailures += 1;
    const topStatus = document.getElementById("top-status");
    const freshness = resolveFreshness({
      lastLiveMs: lastLiveAt,
      nowMs: Date.now(),
      connected: false,
      pollFailures,
      asOf: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : null,
      staleAfterMs: STALE_DATA_AGE_MS,
      failuresBeforeStale: STALE_ESCALATE_AFTER,
    });
    if (freshness.mode !== "stale") {
      // TRANSIENT: last-known-good data stays on screen, UNMARKED -- only the top-status line
      // itself says "reconnecting", carrying the last-success time. Never a persistent error
      // banner; the very next successful poll below clears this unconditionally.
      topStatus.textContent = \`reconnecting… (last success \${lastSuccessAt ? \`\${formatElapsed(Date.now() - lastSuccessAt)} ago\` : "never"})\`;
      topStatus.dataset.pollState = "reconnecting";
    } else {
      // ESCALATED: N consecutive failures AND no live data (poll or SSE) recently either -- the
      // board itself is now visibly stamped stale, never silently old (reuses the cache-restore
      // path's own stale-badge mechanism), and never contradicted by a freshness stamp claiming
      // otherwise -- both now read \`lastLiveAt\`.
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
      // W1-T163 MARKER, ACKNOWLEDGED VIEWS ONLY: the x-rmd-recap-ack header tells board.ts a HUMAN
      // is about to see this recap, and it rides on exactly the fetch whose recap this page renders
      // (the recapRendered gate below). Every later poll omits it, so a tab left open no longer
      // marks the evening seen three seconds at a time. The URL stays BARE "/v1/status" so every
      // shipped page.route("**/v1/status") interception still matches it.
      statusSnap = await getJson("/v1/status", {
        timeoutMs: STATUS_FETCH_TIMEOUT_MS,
        extraHeaders: recapRendered ? undefined : { "x-rmd-recap-ack": "1" },
      });
    } catch (e) {
      handlePollFailure();
      return;
    }
    pollFailures = 0;
    lastSuccessAt = Date.now();
    touchFreshness();
    firstStatusLoaded = true;
    const tasks = statusSnap.tasks ?? [];
    for (const t of tasks) ingestProjection(t);
    // W1-T159: "spend" rides on this SAME /v1/status response (board.ts's computeGlanceSpend) --
    // no extra round trip for merged-today/spend-today/spend-this-week.
    latestSpend = statusSnap.spend ?? null;
    tasksSnapshotKnown = true; // W1-T2218: mirrors latestSpend's own write site, immediately above
    // W1-T1006: the blocked-PR queue rides this SAME /v1/status response too (board.ts's
    // BoardSnapshot.blockedPrs/blockedPrsUnverifiedReason) -- no second fetch, one snapshot.
    latestBlockedPrs = statusSnap.blockedPrs ?? [];
    latestBlockedPrsUnverifiedReason = statusSnap.blockedPrsUnverifiedReason;
    paintFromTasksById();
    // W1-T163: ONE-TIME, off this load's first snapshot only -- see renderRecapSection's doc for
    // why re-rendering off every later poll's own (by-then-mostly-consumed) recap would be wrong.
    if (!recapRendered) {
      recapRendered = true;
      renderRecapSection(statusSnap.recap);
    }

    try {
      const [recentSnap, upNextSnap, feedbackSnap, inboxSnap, controlStatus, daemonHealth, accountUsage, planView] = await Promise.all([
        getJson("/v1/recent").catch(() => ({ entries: [] })),
        getJson("/v1/drain/preview?max=5").catch(() => ({ cards: [] })),
        getJson("/v1/feedback").catch(() => ({ entries: [] })),
        getJson("/v1/inbox").catch(() => ({ ready: [], drafting: [] })),
        getJson("/v1/control/status").catch(() => ({ paused: false, stopped: false, quietHours: false })),
        // W1-T159: the daemon-health widget's own fetch -- a fetch failure here must never break
        // the rest of the refresh (same catch-and-degrade convention as every sibling above); the
        // widget just keeps showing its last-known values (or "…" pre-first-success).
        getJson("/v1/daemon-health").catch(() => null),
        // The ACCOUNT strip's own fetch, on the SAME refresh cycle and under the SAME
        // catch-and-degrade convention as every sibling above: a failure here leaves the strip
        // showing its last-known values (or "…" pre-first-success) and never breaks the refresh.
        getJson("/v1/account-usage").catch(() => null),
        // W1-T315: the Plan tab's one fetch -- same catch-and-degrade convention as every
        // sibling above; a failure here leaves the tab showing its last-known values (or "…"
        // pre-first-success) and never breaks the rest of the refresh.
        getJson("/v1/plan/view").catch(() => null),
      ]);
      latestFeedbackEntries = feedbackSnap.entries ?? [];
      latestInboxReady = inboxSnap.ready ?? [];
      latestInboxDrafting = inboxSnap.drafting ?? [];
      latestUpNextCards = upNextSnap.cards ?? [];
      latestRecentEntries = recentSnap.entries ?? [];
      if (daemonHealth) {
        latestDaemonHealth = daemonHealth;
        renderDaemonHealth(daemonHealth);
      }
      if (accountUsage) {
        latestAccountUsage = accountUsage;
        renderAccountUsage(accountUsage);
        renderCostCeilingControl(accountUsage);
      }
      if (planView) {
        latestPlanView = planView;
        renderPlanView(planView);
      }
      // W1-T223: ONLY here (never off the status-only pass above) -- see finishSectionRender's
      // own doc for why defaulting/summarizing off still-empty feedback/inbox/up-next/recent
      // arrays would be exactly the "second, disagreeing derivation" this task forbids.
      sectionDefaultsReady = true;
      paintFromTasksById(); // re-run NOW/NEEDS ME/rest now that feedback/inbox/up-next/recent are current
      // W1-T222: ONLY here (never off the status-only pass above) -- a task that legitimately
      // lives in RECENT/UP NEXT would otherwise be judged "not found yet" before those resolve
      // and get force-surfaced into "everything else" by focusAndExpandTask's own fallback,
      // deep-linking the WRONG row (a distinct <li> for the same task, in the wrong section).
      applyDeepLinkIfNeeded();
      applyControlStatus(controlStatus);
      document.getElementById("top-status").textContent = \`updated \${formatTimestamp(statusSnap.generated_at ?? new Date().toISOString())}\`;
      document.getElementById("top-status").dataset.pollState = "ok";
      clearStale(); // a completed live refresh always supersedes whatever the cache/failure-escalation painted

      writeSnapshotCache({
        generated_at: statusSnap.generated_at,
        tasks,
        spend: latestSpend,
        blockedPrs: latestBlockedPrs,
        blockedPrsUnverifiedReason: latestBlockedPrsUnverifiedReason,
        recentEntries: latestRecentEntries,
        upNextCards: latestUpNextCards,
        feedbackEntries: latestFeedbackEntries,
        inboxReady: latestInboxReady,
        inboxDrafting: latestInboxDrafting,
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

  // W1-T222/W1-T202: resolve write scope at boot off whatever write token sessionStorage already
  // held (probeWriteScope, defined with the write-token-form/clear-btn wiring above) -- and
  // re-resolve it again every time that token changes, since it is no longer fixed for the life
  // of the page load the way the URL's read token is.
  probeWriteScope();

  // W1-T222 DEEP-LINK: \`?task=<id>\` opens with that row expanded and scrolled into view,
  // replacing the bottom-panel anchor W1-T158 used as this console's addressable-single-task
  // target. Called explicitly from paintSnapshot/refreshAll/the SSE tick (every point that paints
  // FULL side-data: recent/up-next/feedback) -- deliberately NOT from refreshAll's own first,
  // status-only paintFromTasksById() pass, whose RECENT/UP NEXT lists are still empty: a task
  // that legitimately lives in one of those would be judged "not found yet" and force-surfaced
  // into "everything else" by focusAndExpandTask's own fallback instead, deep-linking the WRONG
  // <li> (a distinct node for the same task, in the wrong section). \`deepLinkApplied\` fires this
  // AT MOST once per page load: after that, the operator's own clicks own the expand/collapse
  // state.
  let deepLinkApplied = false;
  // W1-T144: the digest push (lib/digest.ts's consoleCardUrl) deep-links each escalation/
  // rundown line as \`<base>/#task=<id>\` — a HASH fragment, never sent to the server, so it
  // layers on the operator's already-token-bearing bookmarked URL. Read the SAME id the
  // \`?task=\` path reads: the hash wins when present (the fresh click), else the query param
  // (a bookmarked open-to-this-card URL). Percent-decoded to match consoleCardUrl's
  // encodeURIComponent. An id that matches no row is left to focusAndExpandTask, which
  // returns false and expands NOTHING (criterion 2's planted-probe rejection).
  function deepLinkTaskId() {
    const hash = window.location.hash || "";
    const m = hash.match(/^#task=(.+)$/);
    if (m) {
      try { return decodeURIComponent(m[1]); } catch { return m[1]; }
    }
    return params.get("task");
  }
  function applyDeepLinkIfNeeded() {
    if (deepLinkApplied) return;
    const fromHash = /^#task=/.test(window.location.hash || "");
    const taskId = deepLinkTaskId();
    if (!taskId) { deepLinkApplied = true; return; }
    // PLANTED-PROBE REJECTION (W1-T144 criterion 2): a HASH deep-link (a digest console
    // link) for an id the board does not KNOW must open NOTHING — never
    // focusAndExpandTask's find-fallback, which would force-surface a fabricated
    // "everything else" row for a non-existent task. Once the id is known-absent (the board
    // has painted real data, not just the status-only first pass), the probe is terminally
    // rejected, not retried. The ?task= bookmark path keeps its existing force-surface
    // behavior — a bookmark names a task the operator believes exists.
    if (fromHash && !tasksById.has(taskId)) {
      if (tasksById.size > 0) deepLinkApplied = true; // known-absent -> reject; else wait for real data
      return;
    }
    if (focusAndExpandTask(taskId)) deepLinkApplied = true; // else: no matching row THIS paint -- retry next paint.
  }
  // W1-T144: a hash change AFTER load (the operator taps a second digest link while the
  // console is already open) re-arms and applies the new target immediately — the query-
  // param path only ever fires once per page load, but a hash link is a live navigation.
  window.addEventListener("hashchange", () => {
    if (/^#task=/.test(window.location.hash || "")) {
      deepLinkApplied = false;
      applyDeepLinkIfNeeded();
    }
  });

  // FIRST PAINT, before any network round trip completes (W1-T154): a last-snapshot cache from
  // a previous load, stamped STALE — or, with no cache at all (a true cold start), the skeleton
  // the static HTML above already ships. Either way, never a blank page.
  const cachedSnapshot = readSnapshotCache();
  if (cachedSnapshot) {
    paintSnapshot(cachedSnapshot);
    markStale(cachedSnapshot.generated_at);
  }
  refreshAll();
  setInterval(refreshAll, POLL_INTERVAL_MS);
  setInterval(tickElapsed, 1000);
  setInterval(tickFreshness, 1000);
  subscribeStatusStream(
    (projection) => {
      ingestProjection(projection);
      paintFromTasksById();
      touchFreshness();
      applyDeepLinkIfNeeded(); // W1-T222: a no-op once already applied (see applyDeepLinkIfNeeded's own doc).
    },
    (state) => setConnectionState(state),
  );
</script>
</body>
</html>
`;
}

/** What {@link resolveConsoleSha} reports when the sha genuinely cannot be resolved. */
export const CONSOLE_SHA_UNKNOWN = "unknown";

/**
 * The sha of the CODE THIS CONSOLE PROCESS LOADED — resolved ONCE, from the directory the running
 * module was loaded from (`import.meta.url`), never from cwd and NEVER re-read per request.
 *
 * WHY THAT MATTERS MORE THAN IT LOOKS. `rmd serve` loads its code once via tsx and the deploy
 * supervisor's console restart sits behind a short-circuit a manual checkout pull consumes, so the
 * console can serve days-old code against a current checkout — observed running 3f6a1d1 while the
 * checkout was a0d96a9, and serving 2026-07-29 code through every merge for two days. A version
 * re-read from the checkout at request time would ALWAYS match the checkout and therefore always
 * look current: it would rebuild the very bug this exists to detect. Captured at start, it cannot.
 *
 * This mirrors the daemon's `bootHeadSha` (PR #1054, src/run-task.ts) exactly in intent — the
 * loaded module's own directory — adjusted for depth: that call site is `src/run-task.ts` and
 * walks up two levels; this file is `src/lib/serve.ts` and therefore walks up three.
 *
 * NEVER FATAL. Every failure mode (no git, no repo, detached, git absent from PATH) returns
 * {@link CONSOLE_SHA_UNKNOWN}. The console is the operator's live diagnostic surface; a console
 * that will not start is strictly worse than one that cannot name its own sha.
 */
export function resolveConsoleSha(
  exec: (dir: string) => string = (dir) =>
    execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).toString(),
): string {
  try {
    const moduleDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const sha = exec(moduleDir).trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : CONSOLE_SHA_UNKNOWN;
  } catch {
    return CONSOLE_SHA_UNKNOWN;
  }
}

/**
 * W1-T2229: `bootSha` (captured once, {@link resolveConsoleSha}) vs `currentSha` (the SAME
 * primitive called again, fresh, at the moment this runs) — the whole trigger design (i) asks
 * for: a comparison, never a timer. {@link CONSOLE_SHA_UNKNOWN} on EITHER side means "can't
 * tell", and an unresolved sha is never read as evidence of drift — a transient git failure (no
 * git on PATH, detached HEAD, an unreadable repo) degrades to "assume fresh", never to an exit
 * decided on a guess. Design (vi)'s pin — "a console whose boot sha still matches the tree never
 * exits" — holds for the degenerate case where both sides independently failed to resolve, too:
 * `unknown === unknown` is EQUAL, not stale.
 */
export function isConsoleCodeStale(bootSha: string, currentSha: string): boolean {
  if (bootSha === CONSOLE_SHA_UNKNOWN || currentSha === CONSOLE_SHA_UNKNOWN) return false;
  return bootSha !== currentSha;
}

/** {@link gateStaleCodeExit}'s constructor deps — every side effect injectable, same discipline
 *  {@link gatePrewarmOnClients} already follows for this module's other refcount gate. */
export interface StaleCodeExitDeps {
  /** The sha captured at boot — {@link ServeDeps.consoleSha} ?? {@link resolveConsoleSha}(),
   *  resolved ONCE by the caller and handed in, never re-resolved by this gate. */
  bootSha: string;
  /** Re-resolve the CURRENT on-disk sha, fresh, uncached — defaults to {@link resolveConsoleSha}
   *  itself (the identical primitive, called again). Injectable so a test never shells to git. */
  resolveCurrentSha?: () => string;
  /** Ends the process — defaults to `process.exit`. Injectable so a test observes the call
   *  instead of the test runner actually dying under it. */
  exit?: (code: number) => void;
  /** One ledger line naming the decision, mirroring {@link ServiceOptions.log}. */
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

/** What {@link gateStaleCodeExit} hands back — a wrapper for the console's ONE SSE route and a
 *  wrapper for each HIGH-tier write route, both feeding the SAME internal decision. */
export interface StaleCodeExitGate {
  /** Wrap the console's SSE route so every open/close edge is refcounted against this gate too —
   *  a SECOND, independent tap on the identical subscribe/unsubscribe edges
   *  {@link gatePrewarmOnClients} already refcounts (rationale (4)), never a new tracking layer. */
  wrapSse(route: SseRoute): SseRoute;
  /** Wrap a HIGH-tier write route so its full request lifetime — call-in to the response actually
   *  finishing or the connection closing — counts as in-flight. */
  wrapWrite(route: Route): Route;
}

/**
 * W1-T2229 design: the console notices its OWN code is stale and ends its own process — at a
 * moment that costs nothing, never on a schedule. `RestartPolicy: unless-stopped` (rationale (2),
 * unchanged by this task) restarts on a CLEAN exit, so `exit(0)` here is what turns "a merged fix
 * reaches this console" from "a human restarts it" into "the next time nobody is watching and
 * nothing is writing, it restarts itself."
 *
 * THE DECISION POINT FIRES ONLY AT THE TWO EDGES THAT CAN NEWLY SATISFY BOTH CONDITIONS — an SSE
 * client disconnecting, or a HIGH-tier write finishing — NEVER on an interval (design (i)).
 * Between those edges nothing calls {@link isConsoleCodeStale} at all: an idle console with a
 * viewer still attached, or one mid-write, is never even asked the question, so the sha is
 * re-resolved (a `git rev-parse`, not free) only at the instant an exit is actually a candidate.
 *
 * THE TWO CONDITIONS ARE AND-ED (design (iii)), and this gate is why: zero SSE subscribers with a
 * write still in flight must not exit mid-write (rationale (6): this module drains nothing, so an
 * exit today would drop the request and orphan a spawn already handed off), and zero in-flight
 * writes with a viewer still watching must not exit out from under an operator for no reason
 * (rationale (5): a quiet stream is not an idle process, but neither is a watched one).
 *
 * NOT COVERED, NAMED RATHER THAN GLOSSED (design (iv)): a detached spawn (`ratify.approve`) that
 * outlives the HTTP request which triggered it reads zero on {@link wrapWrite}'s counter the
 * moment that request returns, even while the spawned work continues outside it. Whether the exit
 * must also wait on such a handoff is the one genuinely open question design (iv) names and this
 * shard does not settle — this gate covers exactly the in-flight HTTP request, nothing broader.
 */
export function gateStaleCodeExit(deps: StaleCodeExitDeps): StaleCodeExitGate {
  const resolveCurrentSha = deps.resolveCurrentSha ?? resolveConsoleSha;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? (() => {});
  let clients = 0;
  let inFlightWrites = 0;

  const maybeExit = (): void => {
    if (clients !== 0 || inFlightWrites !== 0) return;
    const currentSha = resolveCurrentSha();
    if (!isConsoleCodeStale(deps.bootSha, currentSha)) return;
    log("serve.stale_code_exit", { bootSha: deps.bootSha, currentSha, clients, inFlightWrites });
    exit(0);
  };

  return {
    wrapSse(route) {
      return {
        ...route,
        subscribe: (send) => {
          const unsubscribe = route.subscribe(send);
          clients += 1;
          let released = false;
          return () => {
            // Same defensive latch gatePrewarmOnClients's own release carries — a double-release
            // from service.ts must not underflow the count past whatever remains connected.
            if (released) return;
            released = true;
            unsubscribe();
            clients -= 1;
            maybeExit();
          };
        },
      };
    },
    wrapWrite(route) {
      return {
        ...route,
        handler: (req, res, ctx) => {
          inFlightWrites += 1;
          let released = false;
          const release = (): void => {
            if (released) return;
            released = true;
            inFlightWrites -= 1;
            maybeExit();
          };
          // "finish" (the response flushed) and "close" (the connection dropped before it did,
          // e.g. a client abort) both mean the request is DONE from this gate's point of view —
          // covering both means a handler that throws before writing anything is still covered:
          // createService's own dispatch catches that throw and sends a 500, which still fires
          // "finish". A handler that never responds at all leaves the count at 1 forever, which
          // is the safe direction — this gate never exits while it cannot prove the write ended.
          res.once("finish", release);
          res.once("close", release);
          return route.handler(req, res, ctx);
        },
      };
    },
  };
}

/**
 * `GET /v1/version` — read-scoped, and the value is the one captured at server start (a closure
 * over `sha`, not a fresh resolution). READ scope deliberately: a commit sha is not a secret, and
 * requiring the WRITE token would make the operator's staleness check need his most privileged
 * credential. The payload carries the sha and nothing else — no token, no path, no config.
 */
export function buildVersionRoute(sha: string): Route {
  return {
    method: "GET",
    path: "/v1/version",
    scope: "read",
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ sha }));
    },
  };
}

/**
 * `GET /` — the shell above, read-scoped like every other route on this surface, but ALSO
 * accepting the token via `?token=` (allowQueryToken). A browser NAVIGATION to `/?token=<read>`
 * cannot set an `Authorization` header, so without this the shell would 401 and never load — the
 * page's OWN follow-up `/v1/*` fetches then carry the header (those routes stay header-only). This
 * closes the W1-T139 bootstrap paradox: the auth spec was satisfied against header-sending fetch
 * clients and unreachable by the one client that matters, the browser opening the URL.
 */
function buildShellRoute(
  phaseElapsedThresholdsMs: Record<string, number>,
  consoleSha: string,
  // W1-…/impl-FC: the WHY-IDLE panel's inputs. Appended LAST and defaulted so no positional caller
  // shifts. `readLedger` is the same `readLedgerLines` the board's routes already use — one ledger
  // read path, never a second.
  idle: { ledgerPath?: string; readLedger?: (p: string) => ReadonlyArray<Record<string, unknown>>; now?: () => Date } = {},
): Route {
  return {
    method: "GET",
    path: "/",
    scope: "read",
    allowQueryToken: true,
    handler: (_req, res) => {
      // PER REQUEST, deliberately: the shell re-renders on every page load, so the panel is fresh
      // without touching the client script (which lives in a template literal and has broken the
      // last five PRs that edited it). A read failure degrades to UNKNOWN, never to zero.
      let panel: string;
      try {
        const read = idle.readLedger ?? readLedgerLines;
        const lines = idle.ledgerPath ? read(idle.ledgerPath) : [];
        panel = renderIdleReasonsHtml(
          idle.ledgerPath
            ? readIdleReasons(lines, idle.now?.() ?? new Date())
            : { kind: "unknown", why: "the console was assembled without a ledger path" },
        );
      } catch (e) {
        panel = renderIdleReasonsHtml({ kind: "unknown", why: `ledger unreadable: ${String((e as Error)?.message ?? e)}` });
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderShellHtml(phaseElapsedThresholdsMs, consoleSha, panel));
    },
  };
}

/**
 * `GET /v1/auth/scope` — W1-T222's write-scope PROBE, nothing else. A plain, side-effect-free
 * GET gated `scope: "write"`: it 200s for a write-token caller and 403s (service.ts's own
 * unwritten-through mechanism) for a read-only one — the shell's inline detail card uses that
 * boolean, resolved once at boot, to decide whether it renders ANY write affordance at all
 * (cardActionsHtml's own doc: standing rule 22, "an action the viewer cannot take must not be
 * rendered as available"). Deliberately the smallest thing that answers "which scope am I" —
 * W1-T202 (not yet built) is where the shell's write-CREDENTIAL channel itself gets redesigned;
 * this route only ever tells a caller what it already proved by the token it sent.
 */
function buildAuthScopeRoute(): Route {
  return {
    method: "GET",
    path: "/v1/auth/scope",
    scope: "write",
    // W1-T404: LOW — a side-effect-free probe of "do I have write scope at all", the least
    // consequential thing a write token can do (rationale note: worth settling whether this
    // needs write scope at all; unchanged by this task either way).
    tier: "low",
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ scope: "write" }));
    },
  };
}

/**
 * W1-T945: the run-id SHAPE `readWorkerTail` (run-task.ts) validates BEFORE building a path —
 * duplicated here rather than imported, because serve.ts is a lib module and run-task.ts is the
 * CLI entrypoint that imports FROM lib/*, never the reverse (this file's own module header); the
 * one property design note (vi) needs on BOTH sides of that boundary is declared once per side
 * rather than smuggling a lib->entrypoint cycle into a security-relevant check. Accepts exactly
 * the id shapes run-task.ts actually mints (`${taskId}-${Date.now()}`, `RETRO-<ms>`,
 * `review-PR<n>-<ms>`, `SERVE-<ms>`, …) — letters, digits, `-`, `_` only, so no id can contain a
 * `/` or a `.` and therefore cannot escape `state/runs/`.
 */
const PEEK_RUN_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;

function isValidPeekRunId(id: string): boolean {
  return PEEK_RUN_ID_SHAPE.test(id);
}

/** Mirrors run-task.ts's `WORKER_TAIL_MAX_LINES`/`WORKER_TAIL_MAX_BYTES` (duplicated for the
 *  same lib/entrypoint-direction reason as {@link PEEK_RUN_ID_SHAPE}, above) — the response is
 *  capped in BOTH dimensions regardless of what `?lines=` asks for (design note v). */
const PEEK_MAX_LINES = 500;
const PEEK_MAX_BYTES = 64 * 1024;
const PEEK_DEFAULT_LINES = 50;

/**
 * `GET /v1/peek?runId=<id>[&lines=<n>]` — read-scoped, W1-T945: the console's read-only tail
 * reader, the FIRST HTTP route in this codebase to serve raw worker output (design note vi).
 * Inherits this surface's EXISTING auth/nonce/localhost-binding wholesale — mounted in
 * {@link buildServeRoutes} exactly like every other route, no new listener, no new auth path
 * (design note v). The run id is validated against {@link isValidPeekRunId} BEFORE any path is
 * built — an invalid shape 400s and never reaches a `readFileSync` call at all. A validly-shaped
 * but unknown/absent tail 200s with a NAMED `reason` (design note iv) — never a silent empty
 * body, matching `readWorkerTail`'s own honest-emptiness contract (run-task.ts). `deps.isLive` is
 * INJECTED, never a second liveness definition here: the real wiring (`serveCommand`) passes a
 * closure over the SAME `liveInflightRuns` read every other liveness decision in this codebase
 * uses (design note ii). No parameter this handler reads writes to, signals, resumes or kills
 * anything (design note i) — `lines` only bounds how much of the read-only file comes back, and
 * both `runId`/`lines` are the ONLY two query params this handler ever consults.
 */
export function buildPeekRoute(deps: { root: string; isLive: (runId: string) => boolean }): Route {
  return {
    method: "GET",
    path: "/v1/peek",
    scope: "read",
    handler: (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const runId = url.searchParams.get("runId");
      if (!runId || !runId.trim()) {
        sendJson(res, 400, { error: "invalid_request", detail: "?runId=<run-id> is required" });
        return;
      }
      if (!isValidPeekRunId(runId)) {
        sendJson(res, 400, { error: "invalid_request", detail: `'${runId}' is not a valid run id` });
        return;
      }
      const live = deps.isLive(runId);
      const linesRaw = url.searchParams.get("lines");
      const requested = linesRaw === null ? PEEK_DEFAULT_LINES : Number(linesRaw);
      const maxLines = Number.isInteger(requested) && requested > 0 ? Math.min(requested, PEEK_MAX_LINES) : PEEK_DEFAULT_LINES;

      const tailPath = join(deps.root, "state", "runs", `${runId}.tail`);
      let raw: string;
      try {
        raw = readFileSync(tailPath, "utf8");
      } catch {
        sendJson(res, 200, { runId, live, found: false, lines: [], reason: `no tail recorded for ${runId}` });
        return;
      }
      const split = raw.split("\n");
      if (split.length > 0 && split[split.length - 1] === "") split.pop();
      let lines = split.length > maxLines ? split.slice(split.length - maxLines) : split;
      while (lines.length > 0 && Buffer.byteLength(lines.join("\n"), "utf8") > PEEK_MAX_BYTES) {
        lines = lines.slice(1);
      }
      sendJson(res, 200, { runId, live, found: true, lines });
    },
  };
}

/**
 * W1-T493 design (i): the completeness ratchet for SCOPE, `writeRoutesMissingTier`-shaped
 * (service.ts, W1-T404) but over `scope` rather than `tier`. `scope` is REQUIRED on both `Route`
 * and `SseRoute` (service.ts), so a TypeScript-checked route literal can never appear here — an
 * unclassified route fails to COMPILE, the strongest ratchet there is (see
 * test/route-scope-matrix.test.ts's own compile-time proof of that). This is the runtime
 * backstop for the one thing the compiler cannot see: an entry assembled through a widened or
 * cast array (an `as Route`, a spread from an untyped source) that slips an invalid `scope` past
 * it. Empty ⇒ every entry in `entries` declares one of the two real `Scope` values — proving the
 * FIELD is present, never that enforcement matches it; test/route-scope-matrix.test.ts is the
 * suite that separately drives the REAL assembled table (this function's real caller,
 * {@link buildServeRoutes}, plus the one mounted SSE stream) through `createService` itself.
 */
export function routesMissingScopeClassification(
  entries: readonly { method?: Method; path: string; scope: Scope }[],
): string[] {
  return entries
    .filter((r) => r.scope !== "read" && r.scope !== "write")
    .map((r) => (r.method ? `${r.method} ${r.path}` : `GET ${r.path} (sse)`));
}

/**
 * design (iii-a)'s shape, copied: run {@link routesMissingScopeClassification} and FAIL THE
 * CALLER (throw) rather than merely reporting. Extracted here, callable directly, so its throw
 * branch is unit-testable without needing the real assembled table (which never triggers it,
 * `scope` being required on the type) to somehow go missing a classification.
 */
export function assertRoutesScopeComplete(entries: readonly { method?: Method; path: string; scope: Scope }[]): void {
  const missing = routesMissingScopeClassification(entries);
  if (missing.length > 0) {
    throw new Error(`route(s) with no declared Scope: ${missing.join(", ")}`);
  }
}

/** Every REST route `rmd serve` registers — board, panel actions (two-root split, see module header), panel graph, and the shell. Reused verbatim from each module's own exported builder. */
export function buildServeRoutes(deps: ServeDeps): Route[] {
  // CAPTURED ONCE, HERE. buildServeRoutes runs exactly once per `rmd serve` process, so this is
  // server start; both the shell span and GET /v1/version close over this one value and neither
  // ever re-resolves it. See resolveConsoleSha for why re-reading per request would be worse
  // than not reporting at all.
  const consoleSha = deps.consoleSha ?? resolveConsoleSha();
  const fleetControlDeps: PanelActionDeps = { root: deps.fleetControlRoot, ledgerPath: deps.ledgerPath, issues: deps.issues };
  const questionDeps: PanelActionDeps = { root: deps.questionsRoot, ledgerPath: deps.ledgerPath, issues: deps.issues };
  // W1-T288: the SAME fleetControlDeps root/ledgerPath, plus the (optional, injectable)
  // liveness-verdict deps -- never a second root, never a second ledger read primitive.
  const controlStatusDeps: ControlStatusDeps = { ...fleetControlDeps, ...deps.controlStatus };
  // panel-graph's GET /v1/inbox needs config.root (inbox-proposals.json/inbox-drafts.json live
  // under state/, same as fleet-control's own flags) -- `fleetControlRoot` IS config.root
  // (module header), so it is the same root, never a THIRD independently-resolved path.
  // W1-T193: `ratify` defaults to a REAL ratifyCliGateway (see ServeDeps.panelGraph's own doc)
  // when the caller doesn't inject one -- rmd serve's own CLI wiring relies on this default;
  // a test supplies `ratify` explicitly to inject a fake instead.
  const panelGraphDeps = {
    ...deps.panelGraph,
    inboxRoot: deps.fleetControlRoot,
    ratify: deps.panelGraph.ratify ?? ratifyCliGateway(deps.panelGraph.root, join(deps.fleetControlRoot, "state", "logs")),
  };

  const lastSeen = deps.lastSeen ?? createLastSeenStore(lastSeenPath(deps.fleetControlRoot));
  // W1-T500: SAME instance `createService`'s dispatch consults (see ServeDeps.confirmNonces's own
  // doc for why that has to be true) -- {@link buildServeServer} resolves this once and threads it
  // through `deps.confirmNonces`, so a direct `buildServeRoutes` caller (a test) that omits it still
  // gets a route that issues real nonces, just not ones any dispatch is wired to consume.
  const confirmNonces = deps.confirmNonces ?? createConfirmNonceStore();
  const daemonHealthDeps: DaemonHealthDeps = {
    ledgerPath: deps.ledgerPath,
    diskPath: deps.daemonHealth?.diskPath ?? deps.fleetControlRoot,
    statfs: deps.daemonHealth?.statfs,
    exec: deps.daemonHealth?.exec,
    now: deps.daemonHealth?.now,
    defaultPollIntervalMs: deps.daemonHealth?.defaultPollIntervalMs,
  };

  // W1-T333: `root` defaults to the SAME fleetControlRoot every other console write surface
  // already resolves `state/` against (daemonHealthDeps.diskPath above follows the identical
  // "assembler wires the real root, a test injects its own" split).
  //
  // W1-T997: `accountFilePath` is likewise RESOLVED here rather than left undefined — see
  // {@link resolveAccountFilePath}'s own doc for the precedence and for why an install that sets
  // neither an explicit override nor RMD_ACCOUNT_FILE_PATH renders byte-identical to before this
  // task (the console still reads `readAccountUsageFile`'s own `homedir()` default).
  const accountUsageDeps: AccountUsageDeps = {
    ...deps.accountUsage,
    ledgerPath: deps.ledgerPath,
    root: deps.accountUsage?.root ?? deps.fleetControlRoot,
    accountFilePath: resolveAccountFilePath(deps.accountUsage?.accountFilePath),
  };

  const routes = [
    buildStatusRoute(deps.board, lastSeen),
    buildRecentRoute(deps.board),
    buildDaemonHealthRoute(daemonHealthDeps),
    buildAccountUsageRoute(accountUsageDeps),
    buildControlStatusRoute(controlStatusDeps),
    buildPauseRoute(fleetControlDeps),
    buildResumeRoute(fleetControlDeps),
    buildStopRoute(fleetControlDeps),
    buildQuietHoursRoute(fleetControlDeps),
    buildAnswerQuestionRoute(questionDeps),
    buildApproveManualRoute(fleetControlDeps),
    buildEscalationMarkHandledRoute(fleetControlDeps),
    // W1-T164: operator guidance notes — console-editable, provenance-stamped, task-scoped.
    // Rooted at `questionsRoot` (repoRoot) — the SAME durable, gitignored `plan/` store
    // worker.ts's question channel already reads/writes (see operator-notes.ts's module doc).
    buildAddOperatorNoteRoute({ root: deps.questionsRoot, ledgerPath: deps.ledgerPath }),
    buildListOperatorNotesRoute({ root: deps.questionsRoot }),
    // Console UP NEXT write-actions (fb-1784988460437-9daa9b): Run a queued task, Drain now.
    buildKickRoute(fleetControlDeps),
    buildDrainNowRoute(fleetControlDeps),
    // recon-ER: the post-drain rundown's one-tap verdict (W1-T141). Declared, aggregated into
    // buildPanelActionRoutes, and covered by six tests that stand up a REAL server and get real
    // 200s from it -- but never mounted here, so POST /v1/drain/feedback 404'd on every running
    // console since W1-T141 landed. That is why `operator_feedback` occurs ZERO times across the
    // ledger's 663-file union: not the unbuilt learning limb downstream (W1-T87/T88), which is
    // real but cannot be the binding constraint -- nothing upstream of it could ever fire.
    //
    // Third instance of one class: GET /v1/skills (W1-T284), POST /v1/skills/run (impl-EQ), this.
    // `assertDeclaredRoutesAreMounted` (test/route-registration.test.ts) is the check that ends it.
    //
    // `fleetControlDeps` and not a new root: the handler's only dep is `ledgerPath`
    // (ledgerPanelAction, panel-actions.ts:134), which is identical across both PanelActionDeps
    // instances built above -- so this route reads no root at all and cannot be misrooted.
    buildDrainFeedbackRoute(fleetControlDeps),
    ...buildPanelGraphRoutes(panelGraphDeps),
    // W1-T284: the skills-panel button SET, read-scoped -- was built (lib/panel-skills.ts,
    // W3-T8) but never wired into the real route table, so GET /v1/skills 404'd on every
    // running console. `questionsRoot` IS repoRoot (see that field's own doc, above) and
    // `.remudero/skills/` lives under repo root (lib/skill.ts's `skillsDir`), so it is the
    // same root buildAddOperatorNoteRoute already uses, never a new one.
    ...buildPanelSkillsRoutes({ root: deps.questionsRoot }),
    // impl-EQ: the WRITE half of the same panel, and the same defect W1-T284 fixed for the read
    // half one module earlier — `buildPanelSkillRunRoutes` (lib/panel-skill-run.ts, W3-T8 round 3)
    // had no caller anywhere in src/, so POST /v1/skills/run 404'd on every running console while
    // twelve tests exercised a route the server never mounted.
    //
    // IT DOES NOT SPAWN. Exactly one skill+mode is wired, `{ skill: "plan", mode: "clarify" }` (the
    // Refine button); every other combination is refused with a 400 that names what is unwired. The
    // wired path is a synchronous filesystem+ledger op — load the plan, lint the task, ground it
    // against the "plan" skill's own registry-declared `grounding_sources`, capture a `grilling`
    // feedback entry, ledger `panel.skill_invoked`. No worker, no spend.
    //
    // `panelGraphDeps` is passed WHOLE and deliberately: this module needs the same `root`,
    // `planPath`, `ledgerPath` and `feedbackLand` that POST /v1/feedback/decision already uses, and
    // production sets `panelGraph.root` and `questionsRoot` to the SAME `repoRoot` (run-task.ts) —
    // so the skills registry and the feedback write resolve under one root, and the grill lands on
    // the bot branch instead of dirtying the daemon's checkout.
    ...buildPanelSkillRunRoutes(panelGraphDeps),
    buildTaskCardRoute(deps.board),
    // W1-T477: the operator's four analytics questions, aggregated over the rotation union — see
    // analytics-route.ts's module header for the reader discipline and scope.
    buildAnalyticsRoute({ ...deps.analytics, ledgerPath: deps.ledgerPath }),
    buildAuthScopeRoute(),
    buildShellRoute(deps.phaseElapsedThresholdsMs ?? DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS, consoleSha, {
      ledgerPath: deps.ledgerPath,
    }),
    buildVersionRoute(consoleSha),
    // W1-T945: read-only run-tail reader — root defaults to fleetControlRoot (= config.root, the
    // same root the tail writer resolves state/runs/<runId>.tail against); isLive defaults to
    // "never live" so a caller that omits it (a bare test) never fabricates liveness.
    buildPeekRoute({ root: deps.peek?.root ?? deps.fleetControlRoot, isLive: deps.peek?.isLive ?? (() => false) }),
    // W1-T500: the nonce-issuance route design (iv)'s second factor needs to exist AT ALL -- built
    // (service.ts, W1-T404) and exported, but mounted nowhere until now, which is why every
    // HIGH-tier write was one flag flip away from a `confirm_nonce_required` with no way to
    // satisfy it. `scope: "write"` (its own declared shape) means `assertWriteTiersComplete` below
    // requires a `tier` too -- makeConfirmNonceRoute deliberately declares none of its own
    // (service.ts's own doc: "requesting a nonce for an action grants nothing by itself"), so this
    // is the one route mounted here rather than reused verbatim -- LOW, the same bookkeeping-grade
    // consequence buildAuthScopeRoute above already claims for the least consequential thing a
    // write token can do.
    { ...makeConfirmNonceRoute(confirmNonces), tier: "low" as const },
  ];

  // W1-T404 design (iii): `ci-parity:drift`-shaped completeness, run inside the PRODUCT function
  // (this one), not merely a test — a write-scoped route added here with no declared tier fails
  // the build rather than defaulting quietly. See `assertWriteTiersComplete`'s own doc.
  assertWriteTiersComplete(routes);
  // W1-T493 design (i): the same shape, over `scope`. Never fires today (`scope` is required on
  // the `Route` type, so an unclassified literal cannot compile) — kept here anyway, beside its
  // tier sibling, as the runtime backstop for whatever the compiler cannot see. See
  // `assertRoutesScopeComplete`'s own doc.
  assertRoutesScopeComplete(routes);

  return routes;
}

/**
 * Build (but do not `.listen()`) the full `rmd serve` HTTP server — one call, every route wired.
 * `deps.board.github`'s background TTL refresh (W1-T154) runs ONLY while at least one console is
 * connected — see {@link gatePrewarmOnClients} for the zero-viewer burn that gate exists to stop.
 * It is also stopped unconditionally when the returned server `close`s, so a server torn down
 * with a viewer still attached leaves no timer behind.
 */
export function buildServeServer(deps: ServeDeps): Server {
  const prewarm = gatePrewarmOnClients(
    buildStatusStream(deps.board, deps.pollMs ?? DEFAULT_POLL_MS),
    deps.board.github,
    deps.boardGithubRefreshMs ?? DEFAULT_BOARD_PREWARM_MS,
  );
  // W1-T500: resolved ONCE, here, and threaded to BOTH `buildServeRoutes` (the mounted
  // `POST /v1/confirm` route's issuing store, via `deps.confirmNonces` below) and `createService`
  // (the `enforceWriteTiers` HIGH-tier dispatch check's consuming store) -- the one shared
  // instance ServeDeps.confirmNonces's own doc requires; resolving it independently in each place
  // (each defaulting on its own) would issue nonces into a store the dispatch never consults.
  const confirmNonces = deps.confirmNonces ?? createConfirmNonceStore();
  // W1-T2229: resolved ONCE, here, and threaded through to `buildServeRoutes` below (explicitly,
  // via the spread) so `GET /v1/version` and the shell's "console build" chip report the EXACT
  // sha {@link gateStaleCodeExit} is comparing against — never a second independent resolution
  // that could drift from the one the exit decision uses.
  const consoleSha = deps.consoleSha ?? resolveConsoleSha();
  const staleExit = gateStaleCodeExit({ bootSha: consoleSha, log: deps.log });
  const routes = buildServeRoutes({ ...deps, consoleSha, confirmNonces }).map((route) =>
    // rationale (7): HIGH-tier IS the write-consequence set this task must respect — the same
    // five paths (`/v1/manual/approve`, `/v1/drain/kick`, `/v1/drain/run`, `/v1/inbox/approve`,
    // `/v1/skills/run`) `HIGH_TIER_WRITE_PATHS` names client-side, read here off the route table's
    // own declared `tier` (already asserted complete, above in `buildServeRoutes`) rather than a
    // second hard-coded path list that could drift from it.
    route.tier === "high" ? staleExit.wrapWrite(route) : route,
  );
  const server = createService({
    tokens: deps.tokens,
    identity: deps.identity,
    routes,
    sse: [staleExit.wrapSse(prewarm.route)],
    log: deps.log,
    confirmNonces,
    // W1-T404 design (iii), turned on LAST (design iii, this task): a no-op until now for want of
    // the two other pieces this task adds -- the issuing route (buildServeRoutes, above) and the
    // console's own client round trip (postJson, above). Both now real: a HIGH-tier write from a
    // credential whose granted tier reaches HIGH (tailnet identity, unraised, still "high") is
    // refused without a nonce and satisfied with one; the bearer write token stays PINNED at "low"
    // (W1-T404's own ruling, not raised here) and so never reaches a MIDDLE or HIGH route at all,
    // nonce or not -- see ServiceOptions.enforceWriteTiers's own doc and bearerTokenProvider's.
    enforceWriteTiers: true,
  });
  server.on("close", prewarm.stop);
  return server;
}

// ── CLI glue: port + token resolution (kept here, not run-task.ts, so both are unit-testable
// as pure/near-pure functions rather than only exercisable through the live CLI) ────────────

/**
 * `--port <n>` if present, else `configPort` (the `serve.port` field an install may pin —
 * W1-T152, so the launchd unit and a hand-run `rmd serve` agree on ONE port without the
 * operator retyping a flag), else {@link DEFAULT_SERVE_PORT}. BOTH sources are validated as an
 * integer 1-65535 — a garbage config value must fail as loudly as a garbage flag, not silently
 * fall through to the default and bind a port nobody's bookmark points at. Throws (never
 * returns an invalid port) so the CLI can fail loud before any bind attempt.
 */
export function resolveServePort(rest: string[], configPort?: number): number {
  const idx = rest.indexOf("--port");
  const raw = idx >= 0 ? rest[idx + 1] : configPort;
  if (raw === undefined) return DEFAULT_SERVE_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    const source = idx >= 0 ? "--port" : "config serve.port";
    throw new Error(`${source} must be an integer 1-65535, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Loopback. The default bind: reachable from this machine and from nothing else. UNCHANGED by
 *  this task — see {@link resolveServeHosts}'s own doc for why the default stays exactly this,
 *  containerized or not: "exposure must be typed, never inherited" (R-4) applies here too. */
export const DEFAULT_SERVE_HOST = "127.0.0.1";

/**
 * W1-T915: the one wildcard spelling {@link assertBindableHost} will accept — and ONLY when the
 * caller also names {@link CONTAINER_NETWORK_ENV} — because it is the one that matches the actual
 * defect. `remudero-serve` runs in a container with no published port: `DEFAULT_SERVE_HOST`
 * (loopback) answers neither Docker's `-p` NAT nor a sibling container (the Cloudflare Tunnel
 * client the 2026-08-14 DECISIONS.md ruling puts on this same box), because both reach a
 * container over ITS interface inside the container's own network namespace, never over its
 * loopback. `0.0.0.0` there is the address that namespace needs to gain.
 *
 * This is deliberately NOT what {@link WILDCARD_HOSTS}'s existing refusal is about. That refusal
 * guards a BARE HOST, where "every interface" means every network the host's own NIC joins — home
 * wifi, a coffee-shop LAN, whatever's plugged in, with a bearer token as the only thing standing
 * between a stranger on that LAN and a write route. Inside a container, "every interface" is
 * bounded by Docker's own network isolation to that container's namespace; nothing here publishes
 * a port to the host's other networks or to the public internet on its own — that stays an
 * operator act (`docker run -p`, or co-locating the tunnel client). So the container's namespace
 * gains an address; nothing wider does, and never silently: see {@link CONTAINER_NETWORK_ENV}.
 */
export const CONTAINER_ALL_INTERFACES_HOST = "0.0.0.0";

/**
 * The env var that must be set to exactly {@link CONTAINER_NETWORK_VALUE} before
 * {@link assertBindableHost} will accept {@link CONTAINER_ALL_INTERFACES_HOST} as a `--host`/
 * `RMD_SERVE_HOST` value — same shape as {@link TRUSTED_PROXY_TAILSCALE}'s single accepted value,
 * refused for anything else (an unset var, a typo, `"1"`, `"true"`) rather than treated as a
 * loose boolean. Deliberately a SEPARATE knob from the host value itself, not folded into it:
 * typing `--host 0.0.0.0` alone must keep failing exactly as loudly as before (the existing
 * `resolveServeHost`/`resolveServeHosts` wildcard tests assert this, unchanged by this task), so
 * a template copy-paste or a fat-fingered address can never silently open every interface on a
 * bare host. Only a caller who names BOTH "I mean 0.0.0.0" (the host value) AND "I am declaring a
 * container's own network namespace, not a host's" (this var) gets through — exposure stays
 * something someone typed, it just now takes two independent things typed together instead of
 * being permanently unreachable no matter how deliberately they were typed.
 */
export const CONTAINER_NETWORK_ENV = "RMD_SERVE_NETWORK";

/** The only value {@link CONTAINER_NETWORK_ENV} accepts. See that constant's own doc. */
export const CONTAINER_NETWORK_VALUE = "container";

/**
 * Wildcard binds, refused by name — UNLESS `host` is exactly {@link CONTAINER_ALL_INTERFACES_HOST}
 * and `allowContainerWildcard` says the caller declared {@link CONTAINER_NETWORK_ENV}. Plain
 * `server.listen(port)` with no host defaults to `::`, which accepts from EVERY interface — which
 * is what `rmd serve` actually did while printing "listening on http://localhost:4317". On a bare
 * host anyone on any network that host is attached to could reach the console, and the only thing
 * between them and fleet-control write actions was a bearer token the same command printed to a
 * world-readable log. `::`, `*` and `""` stay refused unconditionally: only `0.0.0.0`, and only
 * with the explicit container declaration, is the one case this task carves out — see
 * {@link CONTAINER_ALL_INTERFACES_HOST}'s doc for why that specific pairing is safe.
 */
export const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "*", ""]);

function assertBindableHost(host: string, raw: string, allowContainerWildcard: boolean): void {
  if (allowContainerWildcard && host === CONTAINER_ALL_INTERFACES_HOST) return;
  if (WILDCARD_HOSTS.has(host)) {
    throw new Error(
      `--host ${JSON.stringify(raw)} binds EVERY interface. Name the interface(s) you mean ` +
        `(e.g. ${DEFAULT_SERVE_HOST} for local only, or "${DEFAULT_SERVE_HOST},<tailnet-ip>" ` +
        `to keep the console reachable locally AND from the phone) — or, inside a container with ` +
        `no published port, set ${CONTAINER_NETWORK_ENV}=${CONTAINER_NETWORK_VALUE} alongside ` +
        `${JSON.stringify(CONTAINER_ALL_INTERFACES_HOST)} to declare that "every interface" means ` +
        `only this container's own network namespace (W1-T915).`,
    );
  }
  if (host.startsWith("--")) {
    throw new Error(`--host expects an address, got the flag ${JSON.stringify(raw)}`);
  }
}

/**
 * Resolve the interface `rmd serve` binds to: `--host <addr>`, else `RMD_SERVE_HOST`, else
 * `configHost` (config.json's `serve.host` — W1-T152, so a launchd unit and a hand-run serve
 * agree without the operator retyping the address), else loopback. A wildcard is REFUSED rather
 * than silently accepted — exposure must be a thing someone typed, naming the interface they
 * meant — with exactly one carve-out (W1-T915): `0.0.0.0` is accepted when
 * `env[CONTAINER_NETWORK_ENV] === CONTAINER_NETWORK_VALUE`, because inside a container that value
 * names the container's own network namespace, not "every network this host is attached to". The
 * DEFAULT (`raw === undefined`, nobody named anything) is UNCHANGED — still always loopback,
 * containerized or not: R-4 ("exposure must be typed, never inherited") applies to the carve-out
 * exactly as it applies to every other interface this function resolves. `remudero-serve` closes
 * the measured defect by SETTING `RMD_SERVE_HOST=0.0.0.0` and `RMD_SERVE_NETWORK=container` in
 * its own launch config — an operator/deploy act, same as every other `RMD_SERVE_HOST` value —
 * not by this function inventing a default nobody typed.
 *
 * Remote access is expressed by naming the interface, not by opening all of them. This fleet is
 * reached from the operator's phone over Tailscale, so the tailnet address is the correct value
 * here (`RMD_SERVE_HOST=100.x.y.z`) — that keeps the console on an authenticated, encrypted
 * overlay instead of on every coffee-shop LAN the laptop joins.
 */
export function resolveServeHosts(rest: string[], env: NodeJS.ProcessEnv = process.env, configHost?: string): string[] {
  const idx = rest.indexOf("--host");
  const raw = idx >= 0 ? rest[idx + 1] : (env.RMD_SERVE_HOST ?? configHost);
  if (raw === undefined) return [DEFAULT_SERVE_HOST];
  const hosts = raw
    .split(",")
    .map((h) => h.trim())
    .filter((h, i, all) => all.indexOf(h) === i);
  // An all-empty value (",", "  ") must not silently collapse to "listen nowhere" — that would
  // read as a working server that answers no one. Fall through to the wildcard check below,
  // which names the empty string, so the operator gets a message rather than a silent no-op.
  if (hosts.length === 0) hosts.push("");
  const allowContainerWildcard = env[CONTAINER_NETWORK_ENV] === CONTAINER_NETWORK_VALUE;
  for (const host of hosts) assertBindableHost(host, raw, allowContainerWildcard);
  return hosts;
}

/**
 * SINGLE-HOST CONVENIENCE, retained because most callers want one address. Returns the FIRST
 * resolved host — never an UNDECLARED wildcard, since {@link resolveServeHosts} has already
 * refused those; it CAN return {@link CONTAINER_ALL_INTERFACES_HOST} when the caller explicitly
 * declared {@link CONTAINER_NETWORK_ENV} (W1-T915), the one wildcard spelling that is no longer
 * unconditionally refused.
 */
export function resolveServeHost(rest: string[], env: NodeJS.ProcessEnv = process.env): string {
  return resolveServeHosts(rest, env)[0] as string;
}

/**
 * W1-T997: the env var an operator sets to point `GET /v1/account-usage` at a readable copy of
 * `~/.claude.json` — see {@link resolveAccountFilePath}'s own doc for why this exists at all.
 */
export const ACCOUNT_FILE_PATH_ENV = "RMD_ACCOUNT_FILE_PATH";

/**
 * W1-T997: resolve the path `GET /v1/account-usage` reads for the console's usage panel.
 *
 * THE DEFECT THIS CLOSES. `readAccountUsageFile` (account-usage.ts) defaults to
 * `join(homedir(), ".claude.json")`, and `AccountUsageDeps.accountFilePath` already exists to
 * override that default — but nothing upstream of {@link buildServeRoutes} ever supplied a
 * value, so every request resolved under the SERVE process's own home, which is where
 * `remudero-serve`'s container mounts `~/.claude/` (a directory) but not the sibling
 * `~/.claude.json` FILE that sits beside it outside every mount. The panel therefore always read
 * `unreadable`, even though the identical file exists, fresh, in `remudero-daemon`.
 *
 * SAME PRECEDENCE SHAPE {@link resolveServeHosts} already uses for `--host` — explicit override
 * first, then an env var, then the default — minus the CLI-flag and config-file tiers: argv
 * parsing and `config.json` reading both live in run-task.ts's `serveCommand`, which this task
 * (W1-T997) deliberately does not touch (raised to `risk: high` specifically so the reader and
 * this wiring stay one shard rather than splitting a supplier from nothing to supply). An
 * explicit caller override (`ServeDeps.accountUsage.accountFilePath` — the SAME "an assembler
 * wires the real thing, a test injects a fake" seam every other optional field on that type
 * already follows) stands in for the flag tier; {@link ACCOUNT_FILE_PATH_ENV} stands in for the
 * config tier: an operator sets it directly in the deployment environment, entirely outside this
 * file and the CLI parser. Neither set ⇒ `undefined`,
 * which is exactly what flowed through before this task — `readAccountUsageFile`'s OWN default
 * parameter resolves it, so an install that sets neither renders BYTE-IDENTICAL to today.
 *
 * CONTAINMENT (design note iv): this only ever WIDENS what the route may READ, never what it may
 * write — `readAccountUsageFile` opens the path with `readFileSync` and projects a handful of
 * scalar fields out of it (see that function's own doc); nothing here grants the console write
 * access to the operator's Claude Code state or serializes any key beyond the ones already
 * named there.
 */
export function resolveAccountFilePath(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return explicit ?? env[ACCOUNT_FILE_PATH_ENV];
}

/**
 * The only `serve.trustedProxy` value {@link resolveServeIdentity} accepts today: the operator
 * declaring that Tailscale Serve (see service.ts's `IdentityAuth` doc) is the process
 * terminating on the trusted loopback address. Any other declared value names a proxy this
 * codebase cannot verify strips identity headers the way Serve does, so it is refused rather
 * than silently trusted (W1-T398).
 */
export const TRUSTED_PROXY_TAILSCALE = "tailscale";

/**
 * W1-T371/W1-T398: resolve the additive tailnet-identity option, or `undefined` when the
 * operator hasn't opted in. `identityCapability` (config.json's `serve.identityCapability`) is
 * the ONLY source for the capability name — no `--flag`/env override, unlike port/host: the ACL
 * app-capability name is an install-level constant chosen once against the operator's own
 * Tailscale policy, not something a single invocation varies. Undefined input (the default,
 * unconfigured install) returns `undefined` REGARDLESS of `trustedProxy` — identity is never
 * consulted, byte-for-byte the pre-W1-T371 behavior, and the off-by-default path gains no new
 * required field.
 *
 * `trustedLocalAddress` is always {@link DEFAULT_SERVE_HOST} (loopback) — matching Tailscale's
 * own documented guidance that a backend trusting Serve's identity headers should listen ONLY
 * on localhost ("it's best practice to only have the service listen on localhost... [otherwise]
 * any user that can call your service directly... could trivially provide their own values for
 * these HTTP headers", https://tailscale.com/kb/1312/serve). This is independent of whatever
 * `rmd serve` itself binds via `RMD_SERVE_HOST`/`resolveServeHosts` — those are this Node
 * process's own direct-connection interfaces, not `tailscale serve`'s proxy target, which is
 * operator-machine deployment config (com.remudero.serve.plist) outside this repo.
 *
 * W1-T398: enabling `identityCapability` used to inherit that loopback-trust assumption
 * silently — nothing recorded WHICH proxy the operator meant to be listening there, so pointing
 * any OTHER reverse proxy (nginx, Caddy, a cloud load balancer's local target) at the same
 * address turns gate 1 (service.ts's interface check) into a no-op while gate 2's header check
 * loses the only thing that made it safe (Serve stripping client-supplied headers). Whether the
 * process on that address really is Serve is NOT OBSERVABLE from inside this one — shelling a
 * `tailscale` binary would prove a daemon is running, never that it's the listener in question
 * — so this cannot VERIFY the topology, only require the operator to STATE it:
 *   - `trustedProxy` absent while `identityCapability` is set: REFUSED at startup. A config that
 *     never declares which proxy it trusts no longer silently inherits one.
 *   - `trustedProxy === "tailscale"` ({@link TRUSTED_PROXY_TAILSCALE}): the declared, supported
 *     case — resolves exactly as it did before W1-T398.
 *   - any other `trustedProxy` value: a named opt-out, REFUSED for now, naming what would have
 *     to be true (a header-stripping guarantee equivalent to Serve's) for it to be safe.
 * An install that never sets `identityCapability` never reaches any of this: this function
 * still returns `undefined` for it without ever inspecting `trustedProxy`.
 */
export function resolveServeIdentity(
  identityCapability: string | undefined,
  trustedProxy: string | undefined,
): ServiceOptions["identity"] {
  if (!identityCapability) return undefined;
  if (!trustedProxy) {
    throw new Error(
      `config serve.identityCapability is set ("${identityCapability}") but serve.trustedProxy is ` +
        `not. Tailnet-identity auth trusts whichever process is terminating on the loopback address ` +
        `gate 1 checks against, and nothing declares which one this install means. Add ` +
        `"trustedProxy": "${TRUSTED_PROXY_TAILSCALE}" next to identityCapability in config.json if ` +
        `Tailscale Serve is that process (the supported, documented case).`,
    );
  }
  if (trustedProxy !== TRUSTED_PROXY_TAILSCALE) {
    throw new Error(
      `config serve.trustedProxy ${JSON.stringify(trustedProxy)} is not a supported value. Only ` +
        `"${TRUSTED_PROXY_TAILSCALE}" is accepted today — gate 2 (service.ts's capability check) is ` +
        `only as sound as its assumption that the process on the trusted loopback address strips ` +
        `client-supplied identity headers the way Tailscale Serve does, and nothing in this codebase ` +
        `can verify that of a different proxy. Front this with Tailscale Serve, or unset ` +
        `identityCapability and rely on the bearer token instead.`,
    );
  }
  return { trustedLocalAddress: DEFAULT_SERVE_HOST, capability: identityCapability };
}

// ── SERVICE LIFECYCLE (W1-T152) ───────────────────────────────────────────────────────────
//
// What changes when the console stops being a foreground process someone babysits and becomes
// a launchd job that is expected to survive kills, reboots and the operator being 3000 miles
// away. Each helper below is one incident, kept PURE-ish (injected clock / injected git / plain
// paths) so it is provable without a live service:
//
//   listenWithReapWait  — the kill→relaunch EADDRINUSE race that produced a silent outage
//   ensureLogFileMode   — R-5, a bearer token found in a world-readable serve.log
//   offMainNotice       — a console serving branch code lies to the operator (W1-T255 posture:
//                         it SAYS SO, LOUDLY, and keeps serving — a service never exit-1s on
//                         tree state, which is what crash-looped the daemon after #707)

/** How many times {@link listenWithReapWait} retries a bind that loses the port race, and how
 *  long it waits between tries — 20 × 500ms = a 10s reap window, comfortably inside launchd's
 *  60s ThrottleInterval, so a genuinely stuck port still surfaces as a real error rather than
 *  being papered over forever. */
export const DEFAULT_BIND_ATTEMPTS = 20;
export const DEFAULT_BIND_RETRY_MS = 500;

/**
 * Bind, WAITING OUT a port the previous process has not released yet.
 *
 * THE INCIDENT: `kill $(lsof -ti :4317)` followed immediately by a relaunch raced — the new
 * process hit EADDRINUSE, died into an unread log, the OLD process kept serving stale code,
 * and when it finally exited the console was down with nothing listening. Every layer of that
 * was silent. Under launchd the same race is REAL and more likely, not less: `kickstart -k`
 * SIGKILLs and relaunches immediately, and a relaunch that dies on EADDRINUSE burns a
 * ThrottleInterval before anyone finds out.
 *
 * So an in-use port is treated as a TRANSIENT condition to wait out (the old owner is being
 * reaped), not a fatal one — but only for a bounded window, and only for EADDRINUSE: any other
 * listen error (EACCES on a privileged port, EADDRNOTAVAIL for a tailnet address that isn't up
 * yet) is rethrown immediately, because retrying those just delays a real diagnosis. `onRetry`
 * is how the caller makes the wait AUDIBLE — the silence is what made the original outage
 * expensive.
 */
export async function listenWithReapWait(
  listen: () => Promise<void>,
  opts: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (attempt: number, err: NodeJS.ErrnoException) => void;
  } = {},
): Promise<void> {
  const attempts = opts.attempts ?? DEFAULT_BIND_ATTEMPTS;
  const delayMs = opts.delayMs ?? DEFAULT_BIND_RETRY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      await listen();
      return;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EADDRINUSE" || attempt >= attempts) throw err;
      opts.onRetry?.(attempt, err);
      await sleep(delayMs);
    }
  }
}

/**
 * Force mode 0600 on the console's log files, creating them if absent (R-5, standing rule 24).
 *
 * launchd creates `StandardOutPath`/`StandardErrorPath` at its own umask — 0644 — and serve's
 * startup banner prints the READ bearer token, so the default is a token in a world-readable
 * file that outlives the process. That already happened once and cost a token rotation. Both
 * the `--write` install path and serve's own boot call this: pre-creating at 0600 wins the
 * common case (launchd appends to the existing file, keeping the mode), and the boot-time call
 * repairs a file launchd got to first.
 *
 * BEST-EFFORT BY CONSTRUCTION: a chmod failure returns the path in `failed` and NEVER throws —
 * a service that refuses to start because it could not tighten a log file has turned a hygiene
 * problem into an outage (the W1-T255 posture, applied to file state instead of tree state).
 */
export function ensureLogFileMode(paths: string[], mode: number = 0o600): { secured: string[]; failed: string[] } {
  const secured: string[] = [];
  const failed: string[] = [];
  for (const p of paths) {
    try {
      mkdirSync(dirname(p), { recursive: true });
      closeSync(openSync(p, "a", mode));
      chmodSync(p, mode); // FORCE — `openSync` only applies `mode` when it CREATES the file.
      const actual = statSync(p).mode & 0o777;
      if (actual === mode) secured.push(p);
      else failed.push(p);
    } catch {
      failed.push(p);
    }
  }
  return { secured, failed };
}

/** The branch a console is allowed to serve without comment. */
export const SERVE_EXPECTED_BRANCH = "main";

/**
 * The LOUD non-fatal notice a console prints when its checkout is not on `main` — or `null`
 * when it is (and when the branch can't be read at all, which is not evidence of anything).
 *
 * THE INCIDENT: `rmd serve` launched off a feature branch keeps serving that branch's code
 * after the checkout returns to main, because tsx loads the module graph once. Three
 * stale-code incidents in one day traced to it, and the operator had no way to tell from the
 * board that he was looking at un-shipped code.
 *
 * WHY A NOTICE AND NOT A REFUSAL. W1-T152 originally specified "REFUSES to bind when not on
 * main, exit non-zero". W1-T255 (#726) then established the opposite for services, the hard
 * way: the daemon's dirty-tree refusal exit-1'd on every launchd restart and took the whole
 * automation down for hours. A KeepAlive'd unit turns ANY startup refusal into a crash-loop,
 * and a crash-looping console is strictly worse than a console that is honest about which
 * branch it serves — the operator reattaching from a phone needs a surface that answers.
 * So: assess, say so in the log every boot, and serve. (Amended in plan/tasks.yaml with this
 * citation rather than implemented against the older wording.)
 */
export function offMainNotice(branch: string | null): string | null {
  if (branch === null || branch === SERVE_EXPECTED_BRANCH) return null;
  return (
    `### rmd serve — WARNING: this checkout is on branch '${branch}', not '${SERVE_EXPECTED_BRANCH}'. ` +
    `The console is serving code that is NOT what the fleet ships, and tsx loads the module graph ` +
    `ONCE — returning the checkout to '${SERVE_EXPECTED_BRANCH}' will NOT change what this process ` +
    `serves. Restart it (launchctl kickstart -k gui/$UID/com.remudero.serve) from ` +
    `'${SERVE_EXPECTED_BRANCH}'. Serving anyway: a service never refuses to start over tree state (W1-T255).`
  );
}

/** The checkout's current branch, or `null` when it can't be read (detached HEAD, no git, a
 *  worktree mid-operation) — `null` is "don't know", never "off main", so {@link offMainNotice}
 *  stays silent rather than crying wolf. `git` is injectable for tests. */
export function currentBranch(repoDir: string, git?: (args: string[]) => string): string | null {
  const run = git ?? ((args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }));
  try {
    const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    return branch === "" || branch === "HEAD" ? null : branch;
  } catch {
    return null;
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
 *
 * CodeQL js/file-system-race, round 4 (alert #61): the `wx` attempt and the EEXIST fallback
 * read both go through the shared `createOrReadExclusive` helper (fs-race-safe.ts) — the same
 * one config.ts's `loadConfig` uses — rather than a fourth open-coded copy of this exact
 * create-or-read shape.
 */
export function resolveServiceTokens(configRoot: string): ServiceTokens {
  const p = serviceTokensPath(configRoot);
  mkdirSync(dirname(p), { recursive: true });
  const result = createOrReadExclusive(p, 0o600);
  if (result.created) {
    try {
      const created: ServiceTokens = { read: randomBytes(32).toString("hex"), write: randomBytes(32).toString("hex") };
      writeSync(result.fd, JSON.stringify(created, null, 2) + "\n");
      return created;
    } finally {
      closeSync(result.fd);
    }
  }
  return JSON.parse(result.raw) as ServiceTokens;
}

/** `existsSync` re-export point kept trivial — used only by test fixtures wanting to assert the tokens file's persistence without importing node:fs directly for that one check. */
export function serviceTokensFileExists(configRoot: string): boolean {
  return existsSync(serviceTokensPath(configRoot));
}
