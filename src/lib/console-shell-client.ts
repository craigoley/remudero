// @ts-nocheck -- see the file doc below ("untyped by necessity"): the BODY START/END-bracketed
// body must stay plain, unannotated browser JS, or it ships to the browser as a syntax error.
/**
 * lib/console-shell-client.ts — W1-T2902. The console shell's DOM-driving client code (event
 * wiring, `fetch("/v1/…")` calls, DOM rendering), moved out of a raw string inside
 * `renderShellHtml`'s template literal (invisible to `tsc`/eslint/coverage, per W1-T2731's own
 * header) into `bootConsoleShellClient`, a real, exported, directly-callable function.
 *
 * INVARIANT: `bootConsoleShellClient`'s own body, when this module loads normally, IS what runs
 * in the browser. `consoleShellClientSource()` (bottom of this file) does NOT embed it via
 * `Function.prototype.toString()` (the technique `renderConsoleShellScript`/console-shell-
 * script.ts uses) — this repo's `tsx`/esbuild collapses a transpiled function's `.toString()`
 * onto one line, which would break the dozens of existing tests that regex-extract a function
 * like `applyControlStatus` out of the rendered shell HTML by its original whitespace. Instead
 * it slices the body verbatim off THIS FILE'S OWN SOURCE TEXT, between the `BODY START`/`BODY
 * END` markers below — untyped BY NECESSITY, not oversight: any TS annotation inside them ships
 * unstripped. `resolveFreshness` keeps its original `.toString()` embedding (W1-T281) —
 * unaffected, since nothing greps its shape.
 *
 * FALSIFIER: test/console-shell-client.test.ts (parses the seam's output; calls the real
 * function under a DOM harness). Full design rationale and the incremental-retyping follow-up:
 * this task's own PR body.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveFreshness } from "./console-freshness.js";
import {
  escapeHtml,
  formatRelative,
  formatTimestamp,
  formatClock,
  formatElapsed,
  formatBytes,
  costLabel,
  taskWorkstream,
  statusColorKey,
  searchHaystack,
  isBlockedRow,
  cmpById,
  cmpByAge,
  cmpByRecency,
  fuzzyScore,
  facetValueMatches,
  withoutVolatile,
  parseSseFrame,
  askTypeFromEscalationTitle,
  nowSummaryText,
  usageWindowLabel,
  mergeHoldConfirmationText,
  mailboxEscalationClass,
  mailboxThreadKey,
  mailboxVisibleThreads,
  mailboxUnreadCount,
  mailboxMarkRead,
  mailboxMarkResolved,
  rowChevronHtml,
  rowDetailSkeletonHtml,
  planSectionRowHtml,
  needsMeSummaryText,
  needsMeBacklogSummaryText,
  upNextSummaryText,
  recentSummaryText,
  acceptedSummaryText,
  restSummaryText,
  selfMeasurementRowHtml,
  liveSpendHtml,
  workerStateHtml,
  decisionSummaryHtml,
  draftedTasksHtml,
  recentPrLinkHtml,
  recentSpendHtml,
  acceptanceRowHtml,
  depChainHtml,
  cardIssueLinkHtml,
  journeyHtml,
} from "./console-shell-script.js";

/**
 * The shell's entire client behaviour: auth-token bootstrap, polling/SSE ingestion, every row
 * renderer, the command palette, fleet-control wiring, drain/feedback/inbox actions — everything
 * that used to sit directly inside `renderShellHtml`'s `<script type="module">` tag below the
 * pure helpers. Runs in the browser ONLY (`document`/`window`/`fetch` are all browser globals);
 * `phaseElapsedThresholdsMs` and `resolveFreshness` are its only two inputs from outside the
 * script, exactly the two `renderShellHtml` used to splice into the string via `${…}`.
 *
 * DELIBERATELY UNTYPED SIGNATURE (no `: Record<string, number>` etc.) — see this file's header:
 * everything between the BODY START/END markers below must already be valid, unannotated
 * browser JS, because `consoleShellClientSource()` slices it out of THIS FILE'S OWN SOURCE TEXT
 * verbatim rather than stripping types from it. A type annotation inside this function would
 * ship to the browser as a syntax error.
 *
 * @param phaseElapsedThresholdsMs Per-phase elapsed-time anomaly thresholds
 *   (ServeDeps.phaseElapsedThresholdsMs, defaulting to DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS) —
 *   data embedded by the server, never a constant baked into this module.
 * @param resolveFreshness The REAL, unit-tested freshness model (lib/console-freshness.ts) —
 *   passed in rather than imported so the SAME function object a caller uses under test is the
 *   one running here, exactly as `renderShellHtml` used to splice its `.toString()` in directly.
 */
export function bootConsoleShellClient(phaseElapsedThresholdsMs, resolveFreshness) {
  // ⟪W1-T2902-BODY-START⟫ consoleShellClientSource(), below, slices this function's own body
  // (everything from just after this comment to just before the matching END marker) out of
  // this file's own source text — see this file's header for why. Do not remove either marker.
  // Bootstrap: the SAME `?token=` query-param convention apps/dashboard/src/main.ts uses —
  // this page itself already required a bearer header to load (service.ts gates every route,
  // GET / included), so whatever fetched this page already has a token; this just lets that
  // same token drive the page's own follow-up API calls.
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") ?? "";
  const authHeaders = { authorization: `Bearer ${token}` };

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
    return { authorization: `Bearer ${writeToken}` };
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
  // fact about itself. `performance.timeOrigin` is the navigation start; the `Date.now()` fallback
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
  const PHASE_ELAPSED_THRESHOLD_MS = phaseElapsedThresholdsMs;
  function phaseThresholdMs(phase) {
    return PHASE_ELAPSED_THRESHOLD_MS[phase] ?? PHASE_ELAPSED_THRESHOLD_MS.default ?? Infinity;
  }


  /** One Sections row (W1-T376): "<heading> — N of M filed tasks merged", NEVER a percentage
   *  (design note (iii): a 1-task section reading 100% the moment its single task merges would
   *  rank above a 74-task section still building out, inverting the truth -- see
   *  panel-graph.ts's computePlanSectionCounts doc). Pure string-building, no DOM beyond
   *  escapeHtml just above -- pulled out of the rendered shell and eval'd directly by
   *  test/plan-sections-render.test.ts, the same technique test/account-usage.test.ts already
   *  proved for usageWindowLabel. */

  // W1-T189: an OPTIONAL client-side timeout. Plain fetch has none of its own, so a backend
  // stall (W1-T187's 35-58s /v1/status latency) never rejects on its own -- it just hangs,
  // which is indistinguishable from "still loading" to every caller below. A caller that names
  // `timeoutMs` gets an abort (routed through the SAME catch/reject path as a network error or
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
      if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
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
      msg = "This action needs a trusted connection.\n"
          + "Open the console at its tailnet address and try again - the same action works there.\n"
          + "The link this tab was opened with can read the fleet and make routine changes, "
          + "but not this one.";
    } else if (status === 401 || status === 403) {
      // THE EXPECTED, RECURRING CASE. W1-T202 put the write token in sessionStorage on XSS
      // grounds, so it dies with the tab and with every browser restart -- by design. Tell the
      // operator how to get a new one; never weaken the storage, and never print a token.
      msg = "Not authorized to write (HTTP " + status + "). This tab has no valid write token — "
          + "they live in sessionStorage by design and are cleared when the tab or browser closes.\n"
          + "Click \"Request write access\" above, or run  rmd console-url --write  and paste the token it prints, then retry.";
    } else if (status === 0) {
      msg = "Write failed: could not reach the console service (" + path + ")."
          + (detail ? "\n" + detail : "");
    } else {
      msg = "Write failed: " + path + " returned HTTP " + status + "."
          + (detail ? "\n" + detail : "");
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
    "/v1/escalation/reply": { kind: "done", text: "Reply sent — filed to the thread, and now in the feedback queue for triage." }, // W1-T2497
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
    "/v1/policy/provider-routing": { kind: "done", text: "Provider routing override saved — effective on the next dispatch; no daemon or container restart is performed." },
    "/v1/policy/provider-routing/clear": { kind: "done", text: "Provider routing override cleared — the committed host policy returns on the next dispatch; no daemon or container restart is performed." },
    "/v1/merge-hold": { kind: "done", text: "Automatic-merge hold updated and read back from the durable ledger. The next snapshot shows the current decision." },
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
  function postJson(path, body, opts) {
    // fetch() rejects only on a NETWORK failure -- an HTTP 401/404/500 resolves normally, which is
    // why every call site discarding this result showed the operator nothing. Check .ok HERE, once,
    // so all twelve write controls are covered by one place rather than twelve patches.
    //
    // W1-T2301: opts.suppressAck lets ONE call site opt OUT of the automatic ack below -- for the
    // single caller (the answer submit handler's fail-open leg) that already knows this same click
    // is about to fire a SECOND postJson (the filing POST) whose own ack is the true one. Every other
    // call site passes nothing and is unaffected: the ok-path ack still fires from this one place for
    // all twelve OTHER write controls, and even the opted-out call still clears a stale error and
    // still runs showWriteError on failure (design (iv) -- suppressing an ack must never suppress the
    // error path a 401/500 needs).
    // impl-W1-T500: the paths below are the console's own HIGH-tier write routes (service.ts's
    // Route.tier "high", declared at panel-actions.ts's /v1/manual/approve + /v1/drain/kick +
    // /v1/drain/run, panel-graph.ts's /v1/inbox/approve, panel-skill-run.ts's /v1/skills/run). A
    // HIGH-tier call now costs one extra round trip -- POST the exact method+path+payload to
    // /v1/confirm, then replay THIS SAME call carrying the nonce it returns (X-Confirm-Nonce) --
    // design (ii)'s client half of W1-T404's second factor. Declared INSIDE this function, not as a
    // module-level const, so postJson stays the one self-contained unit
    // test/serve-write-errors.test.ts already extracts and sandboxes.
    var HIGH_TIER_WRITE_PATHS = ["/v1/manual/approve", "/v1/drain/kick", "/v1/drain/run", "/v1/inbox/approve", "/v1/skills/run", "/v1/policy/provider-routing", "/v1/policy/provider-routing/clear", "/v1/merge-hold"];
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
    var suppressAck = !!(opts && opts.suppressAck);
    return chain.then(function (res) {
      // impl-EA: the acknowledgement fires HERE, on the ok path only, for the same reason #1003 put
      // the .ok check here - one place covers all twelve write controls, so nobody has to remember
      // to add it to the thirteenth.
      if (res.ok) { clearWriteError(); if (!suppressAck) showWriteAck(path); return res; }
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
        catch (e) { detail = String(raw || "").slice(0, 200); /* not JSON -- fall back to the raw response text */ }
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
  const STATUS_LABELS = { running: "running", blocked: "blocked", "needs-human": "needs human", merged: "merged", queued: "queued" };
  function statusBadge(key) {
    return `<span class="status-dot status-${key}" aria-hidden="true"></span><span class="status-label status-${key}">${STATUS_LABELS[key]}</span>`;
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
    return ` <span class="review-dot review-${state}" aria-hidden="true"></span><span class="review-label review-${state}">${REVIEW_STATE_LABELS[state]}</span>`;
  }
  function prLink(t) {
    if (!t.prUrl) return "";
    const label = t.prNumber !== undefined ? `#${t.prNumber}` : t.prUrl;
    return ` · <a href="${t.prUrl}" target="_blank" rel="noreferrer">${label}</a>${reviewBadge(t.reviewState)}`;
  }

  // ── W1-T183: TIME RENDERING -- local + relative TOGETHER ('14:23:05 · 8s ago'), never a raw
  // ISO-8601-with-milliseconds string anywhere in the UI (the falsifier: a UTC millisecond stamp
  // forces the reader to do arithmetic to answer "is this recent"). Every place this shell used
  // to render `someDate.toISOString()`/a bare `generated_at` routes through this pair instead. ──
  /** `iso` -> "14:23:05 EDT · 8s ago" -- local wall-clock time WITH THE TIMEZONE LABELED (the
   *  reader's own zone) PLUS a relative offset, BOTH computed from the SAME `t` and the SAME
   *  `Date.now()` so the absolute stamp and the age can never contradict (fb-…c124f9's "impossible
   *  arithmetic"; the labeled zone removes the "is 12:03 UTC or local?" ambiguity). Mirrors the
   *  unit-tested `formatStamp` in lib/console-freshness.ts. Falls back to the raw string only when
   *  `iso` fails to parse (never silently swallowed). */

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
   * W1-T156 DOM-STABILITY: reconcile `list`'s children against `rows` (each a precomputed
   * {key, html, taskId?} triple) by KEY, not by wholesale innerHTML replacement. An unchanged
   * row's <li> is the SAME DOM node afterward (never destroyed/recreated) -- its own attributes
   * (and any DOM state a caller stamped on it, e.g. an active text selection anchored inside it)
   * survive an update cycle. Only a row whose rendered html actually differs from last time is
   * touched (and flashed); only keys no longer present are removed; new keys are inserted in
   * order. W1-T158: `taskId`, when present, is stamped as `data-task-id` -- the row-click
   * delegated handler's ONLY way to know which task a click landed on (a task's `key` is not
   * always the bare task id, e.g. NEEDS ME's `task:<id>`/`fbg:<id>` prefixes).
   *
   * W1-T222 DOM-STABILITY INTO EXPANSIONS: extends the SAME never-destroy-what-didn't-change
   * doctrine to an open inline detail card. AT MOST ONE `.row-detail[data-detail-for]` sibling
   * ever exists per list (the shell allows exactly one open card globally -- see expandRow/
   * collapseExpanded). It is found ONCE up front and then: (a) NEVER removed by the generic
   * stale-child sweep below, however this render's `rows` come out -- a background poll/SSE
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
        list.innerHTML = `<li class="empty">${escapeHtml(emptyText)}</li>`;
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
        // W1-T3184: the row still accepts plain pointer clicks, but the keyboard/disclosure state
        // belongs to the real chevron button in row.html. A list item with aria-expanded is still a
        // list item, not a disclosure widget, and axe reports that mismatch on live escalation rows.
        el.removeAttribute("tabindex");
        el.removeAttribute("aria-expanded");
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
      if (row.taskId !== undefined) {
        const controls = existingDetail && existingDetail.dataset.detailFor === row.key ? existingDetail.id : "";
        syncRowDisclosure(el, row.taskId, expandedRowKey === row.key, controls);
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
    // has now superseded. The old version of this cleanup only walked `existing` (keyed children),
    // so a skeleton <li> -- which never carries a data-key -- was never in that map and was
    // stranded in the DOM forever once real rows arrived (reproduced: #now-list/#rest-list still
    // held their initial skeleton <li>s alongside real content after the first successful paint).
    // W1-T222: an open detail card (`existingDetail`) is excluded from this sweep unconditionally
    // -- see the class doc above for why.
    for (const child of Array.from(list.children)) {
      if (child === existingDetail) continue;
      const key = child.dataset && child.dataset.key;
      if (key === undefined || !seen.has(key)) child.remove();
    }
  }

  function syncRowDisclosure(row, taskId, expanded, controls) {
    const btn = row.querySelector(".row-chevron");
    if (!btn) return;
    btn.setAttribute("aria-expanded", expanded ? "true" : "false");
    btn.setAttribute("aria-label", (expanded ? "Hide" : "Show") + " details for " + taskId);
    if (expanded && controls) btn.setAttribute("aria-controls", controls);
    else btn.removeAttribute("aria-controls");
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
    // recent live data. W1-T281: this calls the REAL, imported, unit-tested `resolveFreshness`
    // (lib/console-freshness.ts, embedded verbatim below this shell's boot -- see its own
    // definition) -- never a hand-copied re-derivation of its rule. If ANY transport (poll OR
    // SSE) delivered inside STALE_DATA_AGE_MS, resolveFreshness reports "live" and the banner is
    // refused. `connected` is always false here: this shell's own `lastLiveAt` clock (touched by
    // BOTH a poll success and an SSE data event, never by SSE transport-connectivity alone) is
    // already the single freshness signal — a merely-connected-but-idle SSE stream must still be
    // able to go stale over time, which is why this never re-derives `connected` from the SSE
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
    badge.textContent = `STALE — showing last known data as of ${asOf ? formatTimestamp(asOf) : "an earlier load"}`;
    document.getElementById("top-status").dataset.stale = "true";
  }
  function clearStale() {
    document.getElementById("stale-badge").hidden = true;
    delete document.getElementById("top-status").dataset.stale;
  }

  function summaryText(tasks) {
    const total = tasks.length;
    // fb-1784902052582-c124f9: the tally and the rendered rows derive from ONE query. "running"
    // uses the SAME predicate renderNow filters on (an in-flight run `phase`), never `status ===
    // "running"` — so the header count can never disagree with the NOW rows again.
    const running = tasks.filter((t) => t.phase).length;
    const queued = tasks.filter((t) => t.status === "queued").length;
    // 0-MERGED IS NOT A FACT DURING A GITHUB OUTAGE (fb-…c124f9): when merge-state is
    // unreachable (the SAME per-task `indeterminate` signal the gh banner keys on), the merged
    // tally is UNKNOWN, never rendered as `0`.
    const unreachable = tasks.some((t) => t.indeterminate);
    const mergedPart = unreachable
      ? "merged: unknown (GitHub unreachable)"
      : `${tasks.filter((t) => t.status === "merged" || t.status === "done").length} merged`;
    return `${total} tasks · ${running} running · ${mergedPart} · ${queued} queued`;
  }

  // ── W1-T156: the live task-status truth this shell renders from. SSE deltas AND poll
  // snapshots both funnel through ingestProjection -> tasksById, so every section render below
  // is driven from ONE source of truth regardless of which transport last updated a task. ─────
  const tasksById = new Map();
  let latestFeedbackEntries = [];
  let latestInboxDigests = { entries: [], omitted: 0 };
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
  let latestMergeHeld = []; // same atomic /v1/status projection; never inferred from UI/check state
  let latestPrQueue = { complete: false, rows: [], unavailableReason: "waiting for the first open-PR snapshot" };
  const prQueueFilters = { actionability: "all", review: "all", task: "all" };
  // W1-T3183: the ASK rows only (escalations, feedback, inbox, merge holds, blocked PRs) --
  // the verify:human backlog is deliberately EXCLUDED (it never needed a decision), so the
  // glance strip / tab title / arrival emphasis all read the ask count, never the blended one.
  let latestNeedsMeRows = []; // set by renderNeedsMe
  let latestDaemonHealth = null; // GET /v1/daemon-health's body
  let latestAccountUsage = null; // GET /v1/account-usage's body (account-usage.ts's AccountUsageSnapshot)
  let latestProviderRouting = null; // daemon-written routing decision + effective/default policy projection
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
      return {}; // storage disabled/blocked or the stored value is corrupt JSON -- default to no persisted prefs
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
    const el = document.getElementById(`${id}-summary`);
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
   *  absent one, collapsed iff `isEmpty` (design: "empty sections default collapsed... NEEDS ME
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
   *  `sectionDefaultsReady` so neither ever runs off the status-only pass's still-empty arrays. */
  function finishSectionRender(id, isEmpty, textFn) {
    if (!sectionDefaultsReady) return;
    setSectionSummary(id, textFn());
    ensureSectionDefault(id, isEmpty);
  }
  /** "12m ago"/"3h ago" for whichever of `items` carries the earliest parseable timestamp --
   *  `tsOf` reads whatever field that item type actually carries (never fabricated for a type
   *  that doesn't -- e.g. an inbox-ready proposal has no timestamp at all, so it is silently
   *  skipped for AGE purposes while still counting toward the header's own N). */
  /** Whichever of the five section bodies DOM-contains `el` -- expands it (never persisted: this
   *  is a navigational reveal, e.g. a dep-link/deep-link jump, not the operator's own layout
   *  preference) if it is currently collapsed. A jump/deep-link into a row that lives in a
   *  collapsed section must not land the operator on an invisible (`hidden`) target -- the exact
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

  /** A projection minus its VOLATILE, non-status fields -- `elapsedMs` (changes every second,
   *  rendered by the separate ticking timer below) and `lastActivityAt` (a board-only ledger
   *  timestamp, not part of the status taxonomy the operator is announced about). A row whose
   *  ONLY difference is one of these must not "flip" (re-render/flash/announce). */

  /**
   * Absorb one projection into `tasksById`. TWO transports feed this: the GET /v1/status poll
   * (a BoardRow -- carries `title`/`risk`/`lastActivityAt`) and the SSE `status` stream (a bare
   * StatusProjection -- does NOT). So we take `p` as the AUTHORITATIVE status taxonomy, but
   * BACKFILL only the three stable board-enrichment fields from the prior row when `p` lacks them
   * -- otherwise an SSE delta arriving after a poll would silently DROP a task's known title/risk
   * (and spuriously look like a content "flip", flashing/announcing every tick, purely because the
   * stringified before/after differ by the missing fields). We deliberately do NOT do a blanket
   * `{...prev, ...p}` merge: the SPARSE status fields (`phase`/`needsHuman`/`armedAwaitingMerge`/
   * `indeterminate`) must be able to CLEAR when a delta drops them, so `p` owns all of those.
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
      announce(`${merged.taskId} is now ${STATUS_LABELS[key]}${merged.phase ? ` (phase ${merged.phase})` : ""}`);
    }
    return changed;
  }

  // ── TRUST: "GitHub unreachable" -- DERIVED from the CURRENT snapshot's own per-task
  // `indeterminate`/source:"throttled" signal (W1-T119) every render, never a latched string a
  // later success forgets to clear (the operator-observed stale-banner-beside-live-data bug this
  // task's error-lifecycle section names). Clears the instant no task reports it. W1-T2218: this
  // banner used to stamp `new Date()` into a client-module variable and call it an outage START --
  // that is the BROWSER's clock at the first paint carrying any indeterminate task, never the
  // instant a read began failing and never a server fact (measured 17s off the real
  // `board_gateway.fetch_ok`, task rationale (2)). The label now asserts only what this page load
  // can actually see. NOT deleted -- the indeterminate signal still reaches the operator. ────────
  function updateGithubBanner(tasks) {
    const unreachable = tasks.some((t) => t.indeterminate);
    const banner = document.getElementById("gh-unreachable-banner");
    if (unreachable) {
      banner.hidden = false;
      banner.textContent =
        `GitHub unreachable — no GitHub read has completed since this page loaded (${formatTimestamp(PAGE_LOADED_ISO)}) — statuses may be stale`;
    } else {
      banner.hidden = true;
      banner.textContent = "";
    }
  }

  /** Repaints the task-driven sections (NOW/NEEDS ME/ACCEPTED/UP NEXT/RECENT/rest) from
   *  `tasksById` + the latest cached feedback/inbox/up-next/recent data -- the ONE function an
   *  SSE delta, a poll snapshot, AND the cache-restore path all funnel through, so they can never
   *  drift into different rendering codepaths. Every section render below is keyed/reconciled
   *  (never a wholesale innerHTML replace), so calling this on every SSE tick costs only the rows
   *  that actually changed. */
  function paintFromTasksById() {
    const tasks = Array.from(tasksById.values());
    const nowIds = renderNow(tasks);
    const needsMeIds = renderNeedsMe(tasks, latestFeedbackEntries, latestInboxReady, latestInboxDrafting);
    renderMergeHoldControls();
    renderPrQueue(latestPrQueue);
    renderMailbox(tasks, latestFeedbackEntries, latestInboxDigests);
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

  /** running/queued reuse the EXACT predicates summaryText/statusColorKey already use for the
   *  SAME words elsewhere on this page (never a second, disagreeing derivation); blocked uses
   *  isBlockedRow above, the mirror of board.ts's; needs-me is latestNeedsMeRows.length -- the
   *  SAME ask set (tasks.needsHuman + feedback grilling/proposed + inbox ready/drafting) the
   *  NEEDS ME section itself just rendered as asks (W1-T3183: the verify:human backlog is a
   *  separate, separately-counted population and is deliberately never part of this number), and
   *  a STRICT SUBSET of blocked by construction.
   *  merged-today/spend-today/spend-this-week come from latestSpend (GET /v1/status's "spend"
   *  field, board.ts's computeGlanceSpend) -- "…" (unknown, never a fabricated 0) until the
   *  first real snapshot has landed. W1-T2218: running gets the SAME "…"-until-known guard --
   *  `tasks.filter(...).length` is 0 both when tasksById is legitimately empty (a measured zero)
   *  and when no snapshot has ever landed (an unmeasured absence), and a bare .length cannot tell
   *  those apart. `tasksSnapshotKnown` (set beside latestSpend, above) carries that distinction. */
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
    document.title = n > 0 ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
  }

  /** ANOMALY EMPHASIS (criterion 3): the strip surfaces -- in the strip itself, not merely as an
   *  ordinary count -- (a) any NOW row currently past its own phase threshold (the SAME
   *  `.row.anomaly` class tickElapsed already toggles live, read back here rather than
   *  re-deriving a second elapsed/threshold comparison), and (b) any NEEDS ME row older than
   *  {@link NEEDS_ME_STALE_MS} (24h), using each row's own `ts` (task rows: escalationOpenedAt --
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
    el.textContent = `⚠ ${parts.join(" · ")}`;
  }

  /** `n` bytes -> "12.3 GB" -- the disk-free figure's own display formatter. */

  /** The daemon-health widget's LIVE next-poll countdown -- ticked off the SAME 1s interval
   *  tickElapsed already runs on (never a second clock), reading the `data-next-poll-at`
   *  attribute renderDaemonHealth stamps below. */
  function tickDaemonCountdown() {
    const el = document.getElementById("dh-next-poll");
    if (!el) return;
    const at = el.dataset.nextPollAt;
    if (!at) return;
    const ms = Date.parse(at) - Date.now();
    el.textContent = ms <= 0 ? "due now" : `in ${formatElapsed(ms)}`;
  }

  /** Renders GET /v1/daemon-health's body -- last poll, disk free, and rate-limit remaining are
   *  static per fetch; the next-poll countdown is stamped as a target instant (`data-next-poll-
   *  at`) and ticked live by {@link tickDaemonCountdown}. Every field renders "unknown" (never a
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

  /** W1-T2660: the CURRENT verb set {@link renderSelfMeasurement} looks for on GET
   *  /v1/self-measurement's rows -- mirrors MeasurementCadenceRunResult's own members
   *  (measurement-cadence.ts), `boardReview` excluded because that verb already owns its own
   *  row family and never rides this one (CADENCE_ROW_OWN_FAMILY_KEYS, same module). A hand-
   *  maintained list, on purpose, the same discipline ADOPTION_SHAPE4_PREDICATES keeps for its
   *  own declared population: extend it by hand when a new verb joins the cadence spine. The
   *  panel itself renders whatever a row actually carries even if a key here goes stale --
   *  see selfMeasurementFigure below -- so a forgotten edit here loses ONE row's label, never
   *  the whole panel. */
  const SELF_MEASUREMENT_VERBS = [
    { key: "ruleEfficacy", label: "rule efficacy" },
    { key: "verdictCalibration", label: "verdict calibration" },
    { key: "autonomyRate", label: "autonomy rate" },
    { key: "verbCensus", label: "verb census" },
    { key: "adoptionReport", label: "adoption report" },
    { key: "adoptionMint", label: "adoption mint" },
    { key: "proofDebtReport", label: "proof debt" },
    { key: "proofDebtMint", label: "proof debt mint" },
  ];

  /** One verb's latest value -> a headline figure string, generic over ANY shape the writer
   *  emits (design (ii): "renders whatever verbs the row carries and hides nothing it does not
   *  recognise") -- a REFUSED verb (`status === "refused"`) renders its OWN refusedReason,
   *  verbatim, never folded into the generic branch below (standing rule 22: a refusal is
   *  rendered as a refusal, never as a zero). Everything else renders its own scalar/array
   *  fields as "key value" pairs, skipping `status`/`refusedReason` themselves. */

  /** One verb's row: name, latest figure-or-refusal, as-of, previous figure (design (ii)'s ONE
   *  PANEL). `rows` is GET /v1/self-measurement's own `rows` array, already newest-first
   *  (latestMeasurementRows' own sort, measurement-cadence.ts) -- never re-sorted here. A verb
   *  absent from EVERY row in `rows` renders "never measured", never a bare 0 (standing rule
   *  22, the same discipline {@link renderDaemonHealth}'s "unknown" fields already follow). */

  /** Renders GET /v1/self-measurement's body -- the ONE console surface over
   *  `measurement_cadence.ran` rows (this task's own rationale (1)). `status: "unreadable"`
   *  renders the panel AS unreadable, never as a quietly-empty list -- the W1-T119 distinction
   *  {@link latestMeasurementRows}'s own doc states, mechanized here so a reader can never
   *  mistake "the ledger union could not be read" for "the fleet has never measured itself". An
   *  `ok` response with zero rows (a fresh state dir, or the cadence has genuinely never fired)
   *  falls straight through to selfMeasurementRowHtml's own "never measured" branch for every
   *  verb, with no separate empty-state branch needed here. */
  function renderSelfMeasurement(v) {
    const list = document.getElementById("self-measurement-list");
    if (!list) return;
    if (!v) {
      list.innerHTML = `<li class="empty self-measurement-unreadable" data-self-measurement="unreadable">UNREADABLE — the measurement ledger union could not be read (no response from GET /v1/self-measurement)</li>`;
      setGlanceValue("self-measurement-summary", "unreadable");
      return;
    }
    if (v.status === "unreadable") {
      const reason = v.reason ? v.reason : "no response from GET /v1/self-measurement";
      list.innerHTML = `<li class="empty self-measurement-unreadable" data-self-measurement="unreadable">UNREADABLE — the measurement ledger union could not be read (${escapeHtml(reason)})</li>`;
      setGlanceValue("self-measurement-summary", "unreadable");
      return;
    }
    const rows = v.rows || [];
    list.innerHTML = SELF_MEASUREMENT_VERBS.map((verb) => selfMeasurementRowHtml(verb, rows)).join("");
    setGlanceValue("self-measurement-summary", rows.length ? `as of ${formatTimestamp(rows[0].ts)}` : "never measured");
  }

  /** One usage window as "12% · resets 20:50:00 EDT". "unknown" -- NEVER "0%" -- whenever the
   *  server withheld the reading (account-usage.ts returns the window ABSENT rather than zero
   *  for every unknown case, so a falsy check here can never turn a real 0% into "unknown":
   *  a genuine zero arrives as the number 0 and `w.percentUsed != null` keeps it).
   *
   *  W1-T2434: `reason` -- `usageUnknownReason`, the SAME value `au-as-of` already rendered
   *  alone -- is carried here too, so "unknown" on the five-hour/seven-day fields says WHY
   *  ("unknown (too-old)") rather than a bare word indistinguishable from every other unknown
   *  cause. Render change only: the reason was already computed and already on the payload. */

  /** Local wall-clock with the zone labeled, for a FUTURE instant (a window reset) -- the
   *  relative half of formatTimestamp would read "3h ago" for something 3h away, so resets get
   *  their own formatter rather than a misleading reuse. */

  /** Renders GET /v1/account-usage's body -- WHICH account the fleet is spending and how much of
   *  each window is gone. Read fresh per poll, so an account switch shows up on the next refresh
   *  rather than at the next daemon restart.
   *
   *  THE STALENESS RULE, and why it is not the page's own STALE badge: `#stale-badge`/markStale
   *  is a WHOLE-PAGE claim driven by the board transport (poll/SSE liveness). This reading has a
   *  completely different clock -- ~/.claude.json's own `fetchedAtMs`, written by Claude Code and
   *  by nothing in this repo -- so raising the page badge for it would tell the operator the task
   *  board is stale when only the usage cache is. Instead the age is rendered inline, ALWAYS, and
   *  the server withholds the numbers entirely once they are too old, from a different account,
   *  or un-ageable (`usageUnknownReason`), at which point every window shows "unknown". */
  function renderAccountUsage(a) {
    // W1-T2434: identity is absent ONLY on the "unreadable" reason (readAccountUsageFile's own
    // catch loses both halves together -- see that function's doc); the other three reasons leave
    // email/uuid populated, so this fallback is reached only when the reason IS the identity loss.
    setGlanceValue(
      "au-account",
      a.accountEmail || a.accountUuid || (a.usageUnknownReason ? `unknown (${a.usageUnknownReason})` : "unknown"),
    );
    setGlanceValue("au-five-hour", usageWindowLabel(a.fiveHour, a.usageUnknownReason));
    setGlanceValue("au-seven-day", usageWindowLabel(a.sevenDay, a.usageUnknownReason));
    const gov =
      a.governor === "armed"
        ? "ARMED"
        : a.governor === "telemetry-only"
          ? "telemetry only"
          : "unknown";
    // The posture has its OWN as-of (the newest daemon.headroom line): a fleet that has not
    // ticked since the governor was flipped would otherwise report the pre-flip posture as
    // current. Ageing it inline is the whole guard.
    setGlanceValue("au-governor", a.governorAsOf ? `${gov} · ${formatRelative(a.governorAgeMs)}` : gov);
    // W1-T329: the two DISPATCH-DEFERRING governors -- "unknown" is the honest default (neither
    // governor ever logs "not deferring", only that it IS, so absence can never be shown as
    // healthy/under-ceiling -- see account-usage.ts's DispatchGovernorState doc). RENDER THE
    // NUMBERS, NOT JUST THE FLAG: "$152.28 of $150" told the operator what "deferred" alone could
    // not -- the OPERATOR COMPLAINT this task fixes was exactly "nothing stating that in console".
    setGlanceValue(
      "au-cost-governor",
      a.costGovernor === "deferred"
        ? `${costLabel(a.costGovernorObservedUsd)} of ${costLabel(a.costGovernorCeilingUsd)} · ${formatRelative(a.costGovernorAgeMs)}`
        : "unknown",
    );
    setGlanceValue(
      "au-queue-governor",
      a.queueGovernor === "deferred"
        ? `${a.queueGovernorObservedOpenCount} of ${a.queueGovernorWipLimit} open · ${formatRelative(a.queueGovernorAgeMs)}`
        : "unknown",
    );
    // W1-T333: the EFFECTIVE ceiling with its provenance -- never the bare number (design note i):
    // an overridden value shows the effective figure AND its committed default TOGETHER, so a
    // reader can see it was changed and from what; a value at default renders "(default)" so it
    // reads as distinguishable from an overridden one, never ambiguous between the two.
    if (a.dailyCostCeilingUsd != null) {
      const ceilingText =
        a.dailyCostCeilingProvenance === "overridden"
          ? `${costLabel(a.dailyCostCeilingUsd)} (overridden, default ${costLabel(a.dailyCostCeilingDefaultUsd)})`
          : `${costLabel(a.dailyCostCeilingUsd)} (default)`;
      setGlanceValue(
        "au-cost-ceiling",
        a.dailyCostCeilingFallbackReason ? `${ceilingText} — ${a.dailyCostCeilingFallbackReason}` : ceilingText,
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
        ? `${a.dailyCostCeilingAuditWho || "unknown"} set ${costLabel(a.dailyCostCeilingAuditFromUsd)} -> ${costLabel(a.dailyCostCeilingAuditToUsd)} (effective ${costLabel(a.dailyCostCeilingAuditEffectiveUsd)}) · ${formatTimestamp(a.dailyCostCeilingAuditAsOf)}`
        : "no override written",
    );
    setGlanceValue(
      "au-as-of",
      a.usageUnknownReason ? `unknown (${a.usageUnknownReason})` : formatTimestamp(a.usageAsOf),
    );
    setGlanceValue("au-measures", a.measures || "");
  }

  /** Render the daemon's last provider-routing decision. Missing, unreadable and stale data are
   *  named states; this panel never treats absent capacity as zero usage or available headroom. */
  function renderProviderRouting(p) {
    if (!p) return;
    let state = "unknown";
    if (p.state === "not-probed") state = "not probed";
    else if (p.state === "blocked") state = "blocked · " + (p.blockedReason || "unknown reason");
    else if (p.state === "selected") state = p.freshness === "stale" ? "stale last decision" : "selected";
    else if (p.reason) state = "unknown (" + p.reason + ")";
    setGlanceValue("pr-state", state);
    setGlanceValue("pr-reserve", typeof p.reservePercent === "number" ? p.reservePercent + "%" : "unknown");

    const selected = p.selected;
    const allocationKind = p.policy && p.policy.preference && p.policy.preference !== "automatic" ? "explicit" : "automatic";
    const allocationShare = selected && typeof selected.allocationSharePercent === "number"
      ? selected.allocationSharePercent.toFixed(1).replace(/.0$/, "") + "% " + allocationKind + " target share"
      : "";
    setGlanceValue(
      "pr-selected",
      selected
        ? [selected.provider, selected.accountLabel, selected.model, selected.effort, selected.tightestRemainingPercent + "% remaining", allocationShare]
            .filter(Boolean)
            .join(" · ")
        : p.state === "blocked"
          ? "none (headroom refusal)"
          : "unknown",
    );

    const providers = Array.isArray(p.providers) ? p.providers : [];
    const enabled = Array.isArray(p.enabledProviders) && p.enabledProviders.length
      ? "enabled " + p.enabledProviders.join(", ")
      : "unknown";
    setGlanceValue(
      "pr-providers",
      providers.length
        ? providers
            .map(function (provider) {
              const identity = [provider.provider, provider.accountLabel, provider.model, provider.effort].filter(Boolean).join(" ");
              if (!provider.readable) return identity + " unavailable (" + (provider.reason || "capacity-unreadable") + ")";
              const windows = (provider.windows || []).map(function (window) {
                return window.name + " " + window.usedPercent + "%" + (window.resetsAt ? " reset " + formatClock(window.resetsAt) : "");
              });
              const allocationWindows = (provider.allocationWindows || []).map(function (window) {
                return window.name + " " + window.usedPercent + "%" + (window.resetsAt ? " reset " + formatClock(window.resetsAt) : "");
              });
              return identity + (windows.length ? " · model headroom " + windows.join(", ") : " · model headroom unknown") +
                (allocationWindows.length ? " · provider allocation " + allocationWindows.join(", ") : "");
            })
            .join(" | ")
        : p.state === "not-probed"
          ? enabled + " · not probed"
        : enabled,
    );
    const codex = providers.find(function (provider) { return provider.provider === "codex"; });
    const decision = codex && codex.modelDecision;
    setGlanceValue(
      "pr-codex-models",
      decision
        ? decision.requestedCapability + "/" + decision.requestedEffort + " · " +
          (decision.options || []).map(function (option) {
            const headroom = (option.windows || []).length
              ? Math.min.apply(null, option.windows.map(function (window) { return 100 - window.usedPercent; })) + "% remaining"
              : "headroom unknown";
            return option.id + " " + (option.selected ? "selected" : option.eligible ? "eligible" : option.reason || "ineligible") +
              " · " + headroom + (option.accountDefault ? " · account default" : "") +
              (option.reason === "unmapped" ? " · promotion requires .remudero/mounts.yaml PR (proposal seed: " + option.id + ")" : "");
          }).join(" | ") + (decision.preferenceBypass ? " · preference bypass " + decision.preferenceBypass : "")
        : codex && !codex.readable
          ? "unavailable (" + (codex.reason || "capacity-unreadable") + ")"
          : "not observed",
    );
    setGlanceValue("pr-as-of", p.observedAt ? formatTimestamp(p.observedAt) : "unknown");
    const policy = p.policy;
    setGlanceValue(
      "pr-policy",
      policy
        ? [policy.provenance, policy.preference, policy.reservePercent + "% reserve", "routing " + (policy.routableProviders || []).join(", ")]
            .join(" · ") +
            (policy.codexModelPreference
              ? " · Codex " + policy.codexModelPreference.capability + "/" + policy.codexModelPreference.effort + "=" + policy.codexModelPreference.model
              : " · Codex model automatic") +
            (policy.fallback ? " · fallback " + policy.fallback.reason : "")
        : "unknown (daemon has not published policy)",
    );
    setGlanceValue(
      "pr-bypass",
      p.preferenceBypass ? p.preferenceBypass.provider + " · " + p.preferenceBypass.reason : "none",
    );
    setGlanceValue("pr-expires", policy && policy.overrideExpiresAt ? formatTimestamp(policy.overrideExpiresAt) : "not overridden");
  }

  function applyProviderPolicyControlGate() {
    const policy = latestProviderRouting && latestProviderRouting.policy;
    const committed = policy && policy.committed;
    const allowed = committed && Array.isArray(committed.enabledProviders) ? committed.enabledProviders : [];
    const locked = !hasWriteScope || !policy;
    const ids = [
      "provider-policy-preference",
      "provider-policy-reserve",
      "provider-policy-codex-model",
      "provider-policy-park-claude",
      "provider-policy-park-codex",
      "provider-policy-expiry",
      "provider-policy-apply-btn",
      "provider-policy-clear-btn",
    ];
    ids.forEach(function (id) {
      const element = document.getElementById(id);
      if (element) element.disabled = locked;
    });
    ["claude", "codex"].forEach(function (provider) {
      const element = document.getElementById("provider-policy-enabled-" + provider);
      if (element) element.disabled = locked || allowed.indexOf(provider) === -1;
    });
  }

  function renderProviderPolicyControl(p) {
    const status = document.getElementById("provider-policy-status");
    const policy = p && p.policy;
    if (!status || !policy) {
      if (status) status.textContent = "Policy unavailable — no override can be written until the daemon publishes its committed policy.";
      applyProviderPolicyControlGate();
      return;
    }
    const modelPolicy = policy.codexModelPreference
      ? " · Codex " + policy.codexModelPreference.capability + "/" + policy.codexModelPreference.effort + "=" + policy.codexModelPreference.model
      : " · Codex model automatic";
    status.textContent = policy.provenance === "overridden"
      ? "Current override: " + policy.preference + " · " + policy.reservePercent + "% reserve" + modelPolicy + " · expires " + formatTimestamp(policy.overrideExpiresAt)
      : "Current policy: committed default" + (policy.fallback ? " (override ignored: " + policy.fallback.reason + ")" : "");
    document.getElementById("provider-policy-enabled-claude").checked = (policy.enabledProviders || []).indexOf("claude") !== -1;
    document.getElementById("provider-policy-enabled-codex").checked = (policy.enabledProviders || []).indexOf("codex") !== -1;
    document.getElementById("provider-policy-preference").value = policy.preference || "automatic";
    document.getElementById("provider-policy-reserve").value = String(policy.reservePercent);
    const modelSelect = document.getElementById("provider-policy-codex-model");
    const codex = Array.isArray(p.providers) ? p.providers.find(function (provider) { return provider.provider === "codex"; }) : null;
    const decision = codex && codex.modelDecision;
    modelSelect.replaceChildren(new Option("Automatic mapped choice", ""));
    if (p.freshness === "fresh" && decision) {
      (decision.options || []).filter(function (option) { return option.mapped && option.eligible; }).forEach(function (option) {
        modelSelect.add(new Option(option.id + (option.selected ? " (selected)" : ""), option.id));
      });
    }
    if (policy.codexModelPreference && !Array.from(modelSelect.options).some(function (option) { return option.value === policy.codexModelPreference.model; })) {
      modelSelect.add(new Option(policy.codexModelPreference.model + " (current; inventory is not fresh/eligible)", policy.codexModelPreference.model));
    }
    modelSelect.value = policy.codexModelPreference ? policy.codexModelPreference.model : "";
    applyProviderPolicyControlGate();
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
        ? `current: ${costLabel(a.dailyCostCeilingUsd)} (overridden, default ${costLabel(a.dailyCostCeilingDefaultUsd)})`
        : `current: ${costLabel(a.dailyCostCeilingUsd)} (default)`;
  }

  /** Renders GET /v1/plan/view's body (W1-T315 + W1-T376): PROGRESS (done/in-flight/queued,
   *  GitHub-derived, never plan/tasks.yaml's own decorative `status:` field) + SECTIONS
   *  (per-section filed/merged COUNTS, never a percentage -- see `planSectionRowHtml`'s own
   *  doc) + the FRONTIER (the next candidates in the SAME order the dispatcher would take them,
   *  each carrying a machine-derived reason). `v.progress.unknown` renders the LAST-known
   *  counts (never a fabricated 0) with a stated banner naming why and how stale -- the same
   *  "unknown, never zero" discipline `renderDaemonHealth`/`renderAccountUsage` already
   *  follow for their own fields; `v.sections` rides the SAME reading (panel-graph.ts's
   *  computePlanSectionCounts), so it goes stale in lockstep with `v.progress` rather than
   *  independently. A held frontier row (`runnable: false`) renders WITH its reason, never
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
        unknownBanner.textContent = `UNKNOWN — GitHub could not be read (${p.unavailableReason || "unknown reason"})${p.asOf ? `; showing the last known counts, as of ${formatTimestamp(p.asOf)}` : " and no prior reading exists yet"}`;
      } else {
        unknownBanner.hidden = true;
      }
    }
    const sections = v.sections || [];
    const sectionsList = document.getElementById("plan-sections-list");
    if (sectionsList) {
      sectionsList.innerHTML = sections.length ? sections.map(planSectionRowHtml).join("") : '<li class="empty">no section data yet</li>';
    }
    setGlanceValue("plan-sections-summary", sections.length ? `${sections.length} shown` : "empty");
    const rows = v.frontier || [];
    const list = document.getElementById("plan-frontier-list");
    if (list) {
      list.innerHTML = rows.length
        ? rows
            .map(
              (r) =>
                `<li class="row plan-frontier-row"${r.runnable ? "" : ' data-held="true"'}>${statusBadge(r.runnable ? "queued" : "blocked")}<span class="task-id">${escapeHtml(r.id)}</span><span class="detail">${escapeHtml(r.title)} — ${escapeHtml(r.reason)}</span></li>`,
            )
            .join("")
        : '<li class="empty">nothing queued</li>';
    }
    setGlanceValue("plan-frontier-summary", rows.length ? `${rows.length} shown` : "empty");
  }

  /** The cache-restore path (W1-T154): ingest the cached snapshot's tasks/side-data and paint
   *  through the SAME `paintFromTasksById` a live update uses. */
  function paintSnapshot(snapshot) {
    for (const t of snapshot.tasks ?? []) ingestProjection(t);
    // W1-T159: restore the GLANCE strip's spend figures from the cache too -- otherwise a cold
    // reload would flash "…" for merged-today/spend-today/spend-this-week even while every OTHER
    // stale-but-real number (task counts) restores immediately from this SAME cached snapshot.
    latestSpend = snapshot.spend ?? null;
    tasksSnapshotKnown = true; // W1-T2218: a cache-restored snapshot is real data, not a guess
    latestBlockedPrs = snapshot.blockedPrs ?? [];
    latestBlockedPrsUnverifiedReason = snapshot.blockedPrsUnverifiedReason;
    latestMergeHeld = snapshot.mergeHeld ?? [];
    latestPrQueue = snapshot.prQueue ?? { complete: false, rows: [], unavailableReason: "queue snapshot unavailable" };
    latestFeedbackEntries = snapshot.feedbackEntries ?? [];
    latestInboxDigests = snapshot.inboxDigests ?? { entries: [], omitted: 0 };
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

  // ── NOW — in-flight runs, live phase + LIVE-TICKING elapsed (W1-T156) + LIVE spend/turns (W1-T184) ──
  // W1-T183: each in-flight row also carries its own phase's ANOMALY threshold
  // (data-threshold-ms) plus a hidden `.anomaly-flag` marker -- tickElapsed() below flips both
  // the marker and the row's own `.anomaly` class live, off the SAME ticking clock that already
  // drives the elapsed text, so a row that crosses its threshold mid-session is flagged without
  // waiting on the next status flip/re-render.
  // W1-T944: the NOW row's worker-liveness span, riding the SAME served BoardRow field
  // (workerState/workerStateSince) phase/elapsed/spend already ride -- no second fetch, no
  // client-side re-derivation of the state itself. Text always, never colour alone (design note
  // iv): every branch below renders a WORD, and quiet's word is a DURATION ("quiet Nm") aged by
  // tickElapsed() below off the SAME 1s clock elapsed already uses (design note ii). A row this
  // is called for is ALREADY known in-flight (nowRowHtml only calls it for a `t.phase` row --
  // design note v), so "no workerState" here means "no worker.state row yet", rendered as
  // "state unknown" (design note iii) rather than a blank or a healthy-looking default.
  function nowRowHtml(t) {
    const key = statusColorKey(t);
    const threshold = phaseThresholdMs(t.phase);
    return (
      `<span class="task-id">${escapeHtml(t.taskId)}</span>${statusBadge(key)}${liveIndicatorHtml()}` +
      `<span class="detail">phase: ${escapeHtml(t.phase)} · elapsed: <span class="elapsed" data-started="${escapeHtml(t.startedAt ?? "")}" data-threshold-ms="${threshold}">…</span>` +
      `<span class="anomaly-flag" hidden title="running longer than usual for this phase">⚠ long-running</span>` +
      `${workerStateHtml(t)}${liveSpendHtml(t)}${t.armedAwaitingMerge ? " · auto-merge armed" : ""}${prLink(t)}</span>` +
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

  /** Every `.elapsed[data-started]` span, wherever it lives, ticks off wall-clock time -- this
   *  runs independently of any row re-render, so elapsed advancing every second never counts as
   *  a "flip" (no flash, no aria announcement, no DOM node touched beyond this one text node).
   *  W1-T183 ADDENDUM: also re-evaluates that same span's own `data-threshold-ms` anomaly check
   *  every tick -- crossing the threshold toggles the row's `.anomaly` class AND its
   *  `.anomaly-flag` marker's visibility, but is deliberately NOT routed through
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
    // W1-T944: `.worker-quiet[data-worker-since]` ages "quiet Nm" the SAME way `.elapsed` ages
    // elapsed above -- off THIS same 1s clock (design note ii), never a second timer. A frozen
    // number here is exactly the "operator mistrusts the whole card" failure the design note
    // warns against.
    document.querySelectorAll(".worker-quiet[data-worker-since]").forEach((el) => {
      const since = el.getAttribute("data-worker-since");
      const quietMs = since ? now - Date.parse(since) : NaN;
      el.textContent = Number.isFinite(quietMs) ? `quiet ${formatElapsed(quietMs)}` : "quiet";
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
  function needsMeTaskRowHtml(t) {
    const ask = t.escalationTitle ? escapeHtml(t.escalationTitle) : "needs human attention (escalated)";
    const askType = askTypeFromEscalationTitle(t.escalationTitle);
    const askTypeBadge = askType
      ? `<span class="ask-type-badge ask-type-${askType}">${askType === "question" ? "Decide" : "Do"}</span>`
      : "";
    const unverifiedNote = t.escalationUnverified ? " · issue state unverified (showing to be safe)" : "";
    const viewIssueLink = t.escalationIssueUrl
      ? `<a href="${escapeHtml(t.escalationIssueUrl)}" target="_blank" rel="noopener noreferrer">view issue</a>`
      : "";
    const markHandledBtn = t.escalationIssueUrl
      ? `<button type="button" class="needs-me-mark-handled"${writeGateAttrs()} data-task-id="${escapeHtml(t.taskId)}" data-issue-url="${escapeHtml(t.escalationIssueUrl)}">Mark handled</button>`
      : "";
    return (
      `${statusBadge("needs-human")}${askTypeBadge}<span class="task-id">${escapeHtml(t.taskId)}</span><span class="detail">${ask}${unverifiedNote}${prLink(t)}</span>` +
      rowChevronHtml() +
      (viewIssueLink || markHandledBtn ? `<span class="btn-row">${viewIssueLink}${markHandledBtn}</span>` : "")
    );
  }
  // W1-T313: a decision card OPENS with the cached plain-language summary (headline / what
  // happened / the decision + labelled options) with the raw payload moved BYTE-IDENTICAL
  // behind a collapsed <details> -- the summarizer is NEVER invoked here (this function makes
  // zero network calls; the summary was written ONCE at creation time and is just read off
  // `e.summary`). `e.summary` absent or shaped wrong (fail-open: the same guard the server
  // itself already applied before persisting) degrades to exactly `rawHtml`, unchanged from
  // before this task -- the falsifier this bar exists for is a card whose FIRST text is the
  // raw payload; when a valid summary exists, the raw payload is never that first text again.
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
    const rawHtml = `<span class="detail">asks: ${escapeHtml(e.raw)}</span>`;
    return (
      `${statusBadge("needs-human")}<span class="task-id">feedback#${escapeHtml(e.id)}</span>` +
      decisionSummaryHtml(e, rawHtml) +
      `<form class="inline-action needs-me-answer" data-reply-to="${escapeHtml(e.id)}">` +
      `<label for="answer-${escapeHtml(e.id)}">Answer</label>` +
      `<input id="answer-${escapeHtml(e.id)}" type="text" required />` +
      `<button type="submit" class="needs-me-answer-submit" data-confirming="false" aria-pressed="false"${writeGateAttrs()}>Answer</button>` +
      `<button type="button" class="needs-me-answer-raw"${writeGateAttrs()}>File raw</button></form>`
    );
  }
  function needsMeProposedHtml(e) {
    const rawHtml = `<span class="detail">proposes: ${escapeHtml(e.raw)}</span>`;
    return (
      `${statusBadge("needs-human")}<span class="task-id">feedback#${escapeHtml(e.id)}</span>` +
      decisionSummaryHtml(e, rawHtml) +
      `<span class="btn-row"><button type="button" class="needs-me-decide"${writeGateAttrs()} data-id="${escapeHtml(e.id)}" data-decision="accept">Accept</button>` +
      `<button type="button" class="needs-me-decide"${writeGateAttrs()} data-id="${escapeHtml(e.id)}" data-decision="reject">Reject</button></span>`
    );
  }
  // W1-T193: a READY card renders what would ACTUALLY be filed -- the drafted task ids AND
  // titles (never just the opaque P## proposal id) -- with APPROVE and REFRAME wired to the
  // write-token API. APPROVE reuses fleet control's OWN arm-then-confirm discipline verbatim
  // (serve.ts's stop-btn handler, below) via the SAME data-confirming/8s-reset shape, with a
  // read-back of the drafted task ids in its armed label -- never a second confirm pattern.
  // REFRAME is a textarea (authored feedback captured VERBATIM), never a link to a terminal --
  // the wrong asymmetry (agreeing easy, disagreeing hard) a ratification gate must not have.
  function needsMeInboxHtml(p) {
    const draftedTasks = p.draftedTasks ?? [];
    const readBack = draftedTasks.length > 0 ? draftedTasks.map((t) => t.id).join(", ") : p.proposalId;
    return (
      `${statusBadge("needs-human")}<span class="task-id">${escapeHtml(p.proposalId)}</span><span class="detail">READY to ratify — ${escapeHtml(p.summary)}</span>` +
      draftedTasksHtml(draftedTasks) +
      `<span class="btn-row"><button type="button" class="proposal-approve-btn"${writeGateAttrs()} data-proposal-id="${escapeHtml(p.proposalId)}" data-read-back="${escapeHtml(readBack)}" data-confirming="false" aria-pressed="false">Approve</button></span>` +
      `<form class="inline-action needs-me-reframe" data-proposal-id="${escapeHtml(p.proposalId)}">` +
      `<label for="reframe-${escapeHtml(p.proposalId)}">Reframe (feedback)</label>` +
      `<textarea id="reframe-${escapeHtml(p.proposalId)}" rows="2" required placeholder="what should change…"></textarea>` +
      `<button type="submit"${writeGateAttrs()}>Reframe</button></form>`
    );
  }
  // W1-T193: a proposal legitimately mid-draft for minutes (W1-T192's daemon-side rung) must
  // never render as nothing -- indistinguishable from broken, the same bar W1-T156 set for
  // liveness -- so this names the state AND carries its spawn time, reusing the SAME live-
  // ticking .elapsed[data-started] span/tickElapsed() the NOW section already drives (one
  // implementation, never a second clock).
  function needsMeDraftingHtml(p) {
    return `${statusBadge("needs-human")}<span class="task-id">${escapeHtml(p.proposalId)}</span><span class="detail">DRAFTING — ${escapeHtml(p.summary)} · running <span class="elapsed" data-started="${escapeHtml(p.spawnedAt)}">…</span></span>`;
  }
  // W1-T507: the OTHER reason a row needs a person -- a task filed 'verify: human' in the plan
  // itself, never dispatched (isDispatchEligible/assertRunnable/task-linter.ts all exclude it
  // from machine attention on sight), so it never runs and never escalates. No action affordance
  // renders here on purpose: unlike an escalation row, there is no issue to view and no PR to
  // point at -- nothing in src/ has ever dispatched this task, so nothing exists yet to click.
  // This row's only job is making the queue itself visible, which is this task's whole point.
  function needsMeVerifyRowHtml(t) {
    return (
      `${statusBadge("needs-human")}<span class="ask-type-badge ask-type-verify">Verify</span>` +
      `<span class="task-id">${escapeHtml(t.taskId)}</span><span class="detail">awaiting human verification -- filed verify: human, never auto-dispatched</span>`
    );
  }
  function fleetMergeHold() {
    return latestMergeHeld.find((r) => r.prNumber === undefined);
  }
  function mergeHoldForPr(prNumber) {
    return latestMergeHeld.find((r) => r.prNumber === prNumber) || fleetMergeHold();
  }
  /** One PR-scoped control. Its action is derived only from the atomic mergeHeld projection;
   * neither branch performs a merge. */
  function mergeHoldActionHtml(prNumber, taskId) {
    const action = mergeHoldForPr(prNumber) ? "release" : "engage";
    const label = action === "release" ? "Release hold" : "Hold automatic merge";
    return (
      `<form class="merge-hold-action" data-scope="PR #${prNumber}" data-pr-number="${prNumber}"${taskId ? ` data-task-id="${escapeHtml(taskId)}"` : ""}>` +
      `<input type="text" required aria-label="Reason for ${action} on PR #${prNumber}" placeholder="reason required"${writeGateAttrs()} />` +
      `<button type="submit" data-action="${action}" data-confirming="false" aria-pressed="false"${writeGateAttrs()}>${label}</button></form>`
    );
  }
  /** Every currently-standing PR hold gets an attributable row and release affordance. The
   * fleet hold is rendered by the permanent fleet control immediately below this list. */
  function needsMeMergeHeldRowHtml(r) {
    const scope = r.prNumber === undefined ? "the whole fleet" : `PR #${r.prNumber}`;
    return (
      `${statusBadge("needs-human")}<span class="ask-type-badge ask-type-action">Hold</span>` +
      `<span class="task-id">${escapeHtml(scope)}</span><span class="detail">held by ${escapeHtml(r.by)} — ${escapeHtml(r.reason)}</span>` +
      (r.prNumber === undefined ? "" : mergeHoldActionHtml(r.prNumber, r.taskId))
    );
  }
  function renderMergeHoldControls() {
    const fleet = fleetMergeHold();
    const status = document.getElementById("merge-hold-fleet-status");
    const reason = document.getElementById("merge-hold-fleet-reason");
    const button = document.getElementById("merge-hold-fleet-btn");
    const locked = !hasWriteScope;
    if (status) status.textContent = fleet
      ? `HELD by ${fleet.by} — ${fleet.reason}`
      : "No fleet-wide automatic-merge hold is standing.";
    if (reason) { reason.disabled = locked; reason.title = locked ? "Read-only — enter a write token to enable this action" : ""; }
    if (button) {
      button.disabled = locked;
      button.title = locked ? "Read-only — enter a write token to enable this action" : "";
      button.dataset.action = fleet ? "release" : "engage";
      button.textContent = fleet ? "Release fleet hold" : "Engage fleet hold";
      button.dataset.confirming = "false";
      button.setAttribute("aria-pressed", "false");
    }
    const list = document.getElementById("merge-hold-current");
    if (list) {
      const prHolds = latestMergeHeld.filter((r) => r.prNumber !== undefined);
      list.innerHTML = prHolds.length
        ? prHolds.map((r) => `<li class="row" data-pr-number="${r.prNumber}">${needsMeMergeHeldRowHtml(r)}</li>`).join("")
        : '<li class="empty">no PR-scoped holds</li>';
    }
  }
  // W1-T1006: THE SIXTH NEEDS-ME KIND -- a PR the sweep reconciler already disposed into a
  // non-progressing class (blocked-fixable/blocked-ambiguous/conflicted/stale), with no
  // escalation issue required for it to be visible here at all (design (1)/(6): that gate is
  // the whole defect this task closes). disposition and reason render VERBATIM off the
  // ledger's own sweep.disposed line (design (ii), the W1-T186 named-reason doctrine --
  // status-board.ts's BlockedPrBlocker doc) -- no new taxonomy, no rewording, no collapsing
  // distinct families down to the disposition word alone. W1-T2719 adds only the existing
  // merge-hold engage/release verb; it does not add a merge action. No card link renders here
  // (design (v)): computeTaskCard 404s for any id the plan does not hold, and this
  // row's own taskId (when the ledger line even carried one) is not known to be one of the ones
  // that do -- so the pushed row below deliberately carries no taskId field at all (see
  // reconcileRows' own row.taskId !== undefined gate), which is what keeps this row un-
  // clickable rather than a 404 one click away.
  function needsMeBlockedPrRowHtml(r) {
    const prLabel = r.prUrl
      ? `<a href="${escapeHtml(r.prUrl)}" target="_blank" rel="noreferrer">PR #${r.prNumber}</a>`
      : `PR #${r.prNumber}`;
    return (
      `${statusBadge("needs-human")}<span class="ask-type-badge ask-type-blocked-pr">Blocked</span>` +
      `<span class="task-id">${prLabel}</span><span class="detail">${escapeHtml(r.disposition)} -- ${escapeHtml(r.reason)}</span>`
    );
  }
  // W1-T1006 design (iii): the SAME withholding distinction status-board.ts's own
  // blockedPrsUnverifiedReason already draws (live GitHub state could not be checked THIS
  // cycle -- withheld rather than replay possibly-stale history as current) rendered as its OWN
  // row, so an outage reads as "unverified", never as a healthy-looking empty group.
  function needsMeBlockedPrUnverifiedHtml(reason) {
    return (
      `${statusBadge("needs-human")}<span class="ask-type-badge ask-type-blocked-pr">Blocked</span>` +
      `<span class="detail">blocked-PR ledger entries unverified -- ${escapeHtml(reason)}</span>`
    );
  }
  // ── W1-T2718: one operator row per CURRENT open PR, rendered from BoardSnapshot.prQueue.
  // The queue class, disposition and reason are server facts from the atomic status snapshot;
  // this client only filters the rows already loaded and never re-derives actionability.
  const PR_QUEUE_CLASS_LABELS = {
    actionable: "actionable",
    active: "active",
    "ready-held": "ready or held",
    waiting: "waiting",
    unknown: "unknown",
  };
  function prQueueStatusBadge(row) {
    const color = row.queueClass === "actionable" ? "blocked" : row.queueClass === "active" ? "running" : row.queueClass === "ready-held" ? "merged" : row.queueClass === "unknown" ? "needs-human" : "queued";
    const label = PR_QUEUE_CLASS_LABELS[row.queueClass] || "unknown";
    return `<span class="status-dot status-${color}" aria-hidden="true"></span><span class="status-label status-${color}">${escapeHtml(label)}</span>`;
  }
  function prQueueRowHtml(row) {
    const pr = `<a href="${escapeHtml(row.prUrl)}" target="_blank" rel="noreferrer">PR #${row.prNumber}</a>`;
    const task = row.taskId ? `<span class="task-id">${escapeHtml(row.taskId)}</span>` : '<span class="task-id">unattributed</span>';
    const held = row.held ? '<span class="ask-type-badge ask-type-blocked-pr">merge held</span>' : "";
    const head = row.headSha ? row.headSha.slice(0, 12) : "head unavailable";
    const branch = row.headRefName ? ` · branch <strong>${escapeHtml(row.headRefName)}</strong>` : "";
    const observed = row.observedAt ? formatTimestamp(row.observedAt) : "not observed at the current head";
    return (
      `<details class="pr-queue-row queue-${escapeHtml(row.queueClass)}"><summary>${prQueueStatusBadge(row)}<span class="task-id">${pr}</span><span class="detail">${escapeHtml(row.title)} · ${task} · ${escapeHtml(row.disposition)} — ${escapeHtml(row.reason)}</span>${reviewBadge(row.reviewState)}${held}</summary>` +
      `<div class="pr-queue-transition"><span><strong>Latest exact-head transition:</strong> ${escapeHtml(row.disposition)} — ${escapeHtml(row.reason)}</span><span><strong>Observed:</strong> ${escapeHtml(observed)} · <strong>snapshot:</strong> ${escapeHtml(formatTimestamp(row.snapshotAt))}</span><span><strong>Head:</strong> ${escapeHtml(head)}${branch}</span></div></details>`
    );
  }
  function filteredPrQueueRows(rows) {
    return rows.filter((row) => {
      // An unknown classification is itself actionable evidence. It remains visible under every
      // filter so a narrow client-side view can never hide a row the server could not classify.
      if (row.queueClass === "unknown") return true;
      if (prQueueFilters.actionability !== "all" && row.queueClass !== prQueueFilters.actionability) return false;
      if (prQueueFilters.review !== "all" && row.reviewState !== prQueueFilters.review) return false;
      if (prQueueFilters.task === "unattributed" && row.taskId) return false;
      if (prQueueFilters.task !== "all" && prQueueFilters.task !== "unattributed" && row.taskId !== prQueueFilters.task) return false;
      return true;
    });
  }
  function syncPrQueueTaskFilter(rows) {
    const select = document.getElementById("pr-queue-task");
    if (!select) return;
    const taskIds = Array.from(new Set(rows.map((row) => row.taskId).filter(Boolean))).sort();
    select.innerHTML = '<option value="all">All tasks</option><option value="unattributed">Unattributed</option>' + taskIds.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("");
    if (prQueueFilters.task !== "all" && prQueueFilters.task !== "unattributed" && taskIds.indexOf(prQueueFilters.task) === -1) prQueueFilters.task = "all";
    select.value = prQueueFilters.task;
  }
  function renderPrQueue(queue) {
    const snapshot = queue && typeof queue === "object" ? queue : { complete: false, rows: [], unavailableReason: "queue snapshot unavailable" };
    const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
    const list = document.getElementById("pr-queue-list");
    const banner = document.getElementById("pr-queue-unavailable");
    const summary = document.getElementById("pr-queue-summary");
    if (!list || !banner || !summary) return;
    if (!snapshot.complete) {
      const lastGood = snapshot.lastGoodAt ? ` Last complete snapshot: ${formatTimestamp(snapshot.lastGoodAt)}.` : " No complete snapshot has been observed yet.";
      banner.hidden = false;
      banner.textContent = `Open-PR queue unavailable — ${snapshot.unavailableReason || "live GitHub state could not be verified"}.${lastGood}`;
      summary.textContent = "unverified";
      reconcileRows(list, [{ key: "queue-unavailable", html: '<span class="detail">Current queue withheld until a complete GitHub read succeeds.</span>' }]);
      return;
    }
    banner.hidden = true;
    banner.textContent = "";
    syncPrQueueTaskFilter(rows);
    const shown = filteredPrQueueRows(rows);
    const counts = rows.reduce((acc, row) => { acc[row.queueClass] = (acc[row.queueClass] || 0) + 1; return acc; }, {});
    summary.textContent = `${shown.length} of ${rows.length} · ${counts.actionable || 0} actionable · ${counts.active || 0} active · ${counts["ready-held"] || 0} ready/held · as of ${rows[0] ? formatTimestamp(rows[0].snapshotAt) : "now"}`;
    reconcileRows(list, shown.length ? shown.map((row) => ({ key: `pr:${row.prNumber}:${row.headSha || row.headRefName || "unknown"}`, html: prQueueRowHtml(row) })) : [{ key: "queue-empty", html: '<span class="detail">No pull requests match these filters.</span>' }]);
  }
  // ── MAILBOX (W1-T2497): same escalations, as threads, ADDITIVE alongside needs-me-list -- matched by (taskId, class) PREFIX.
  const MAILBOX_SENDER = { escalation: "Fleet", reply: "You", digest: "Daily digest" };
  function loadMailboxState() { try { const p = JSON.parse(localStorage.getItem("rmd-console-mailbox-v1")); return { read: Array.isArray(p && p.read) ? p.read : [], resolved: Array.isArray(p && p.resolved) ? p.resolved : [] }; } catch { return { read: [], resolved: [] }; /* corrupt/missing storage reads as empty, not an error */ } }
  function saveMailboxState(state) { try { localStorage.setItem("rmd-console-mailbox-v1", JSON.stringify(state)); } catch { /* full/blocked storage must not break the click */ } }
  function buildMailboxThreads(tasks, replies, digests) { if (!Array.isArray(tasks) || (replies !== undefined && replies !== null && !Array.isArray(replies))) return null; const safeReplies = Array.isArray(replies) ? replies : []; const digestEntries = Array.isArray(digests && digests.entries) ? digests.entries : []; const threads = []; for (const d of digestEntries) { if (!d || typeof d.ts !== "string" || typeof d.text !== "string") continue; threads.push({ threadId: "digest:" + d.ts, taskId: "Daily digest", escClass: "", digest: true, messages: [{ role: "digest", sender: MAILBOX_SENDER.digest, body: d.text, ts: d.ts }], latestTs: d.ts }); } for (const t of tasks) { if (!t || !t.needsHuman || !t.escalationTitle || !t.taskId) continue; const cls = mailboxEscalationClass(t.escalationTitle); const key = mailboxThreadKey(t.taskId, cls); const messages = [{ role: "escalation", sender: MAILBOX_SENDER.escalation, body: t.escalationTitle, ts: t.escalationOpenedAt || "" }]; for (const r of safeReplies) if (r && typeof r.thread_id === "string" && r.thread_id.indexOf(key) === 0) messages.push({ role: "reply", sender: MAILBOX_SENDER.reply, body: r.raw || "", ts: r.ts || "" }); messages.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)); threads.push({ threadId: key, taskId: t.taskId, escClass: cls, issueUrl: t.escalationIssueUrl, messages, latestTs: messages[messages.length - 1].ts }); } threads.sort((a, b) => (a.latestTs < b.latestTs ? 1 : a.latestTs > b.latestTs ? -1 : 0)); threads.digestOmitted = digests && typeof digests.omitted === "number" ? digests.omitted : 0; return threads; // one thread per mailbox source, latest-message order; shaped-wrong escalation feeds return null
  }
  function mailboxThreadsHtml(threads, readIds, omittedDigests) { if (!Array.isArray(threads)) return ""; const omitted = omittedDigests || 0; if (threads.length === 0) return omitted > 0 ? `<li class="mailbox-empty">${omitted} older daily digest${omitted === 1 ? "" : "s"} omitted</li>` : `<li class="mailbox-empty">no open threads</li>`; const read = new Set(readIds || []); const rows = threads.map((t) => { const unread = !read.has(t.threadId); const issueLink = t.issueUrl ? `<a href="${escapeHtml(t.issueUrl)}" target="_blank" rel="noopener noreferrer">view issue</a>` : ""; const messagesHtml = t.messages.map((m) => `<li class="mailbox-message mailbox-message-${m.role}"><span class="mailbox-sender">${escapeHtml(m.sender)}</span><span class="mailbox-body">${escapeHtml(m.body)}</span></li>`).join(""); const replyId = "mailbox-reply-" + t.threadId.replace(/[^A-Za-z0-9_-]/g, "-"); const replyForm = t.digest ? "" : `<form class="mailbox-reply" data-task-id="${escapeHtml(t.taskId)}" data-class="${escapeHtml(t.escClass)}"><label class="sr-only" for="${escapeHtml(replyId)}">Reply to ${escapeHtml(t.taskId)}</label><input id="${escapeHtml(replyId)}" type="text" placeholder="Reply…" /><button type="submit"${writeGateAttrs()}>Reply</button></form>`; return `<li class="mailbox-thread${unread ? " mailbox-thread-unread" : ""}" data-thread-id="${escapeHtml(t.threadId)}"><div class="mailbox-thread-head"><span class="task-id">${escapeHtml(t.taskId)}</span>${unread ? '<span class="mailbox-unread-dot" role="img" aria-label="unread thread"></span>' : ""}</div><ul class="mailbox-messages">${messagesHtml}</ul>` + `<span class="btn-row">${issueLink}<button type="button" class="mailbox-open"${unread ? "" : " disabled"} data-thread-id="${escapeHtml(t.threadId)}">Open</button><button type="button" class="mailbox-resolve" data-thread-id="${escapeHtml(t.threadId)}">Resolve</button></span>${replyForm}</li>`; }); const omittedHtml = omitted > 0 ? `<li class="mailbox-empty">${omitted} older daily digest${omitted === 1 ? "" : "s"} omitted</li>` : ""; return omittedHtml + rows.join(""); // ALREADY-BUILT threads as markup; shaped-wrong draws NOTHING
  }
  function mailboxHtml(tasks, replies, readIds, resolvedIds, includeResolved, existingRowsHtml, digests) { let inner = ""; try { const threads = buildMailboxThreads(tasks, replies, digests); inner = threads === null ? "" : mailboxThreadsHtml(mailboxVisibleThreads(threads, resolvedIds, includeResolved), readIds, threads.digestOmitted); } catch { inner = ""; /* unreachable feeds degrade to existingRowsHtml below, never a thrown error */ } return inner || existingRowsHtml || "";
  }
  let mailboxState = loadMailboxState();
  function renderMailbox(tasks, feedbackEntries, digests) { const el = document.getElementById("mailbox"); const list = document.getElementById("needs-me-list"); if (el) el.innerHTML = mailboxHtml(tasks, feedbackEntries, mailboxState.read, mailboxState.resolved, false, list ? list.innerHTML : "", digests); const badge = document.getElementById("mailbox-unread-count"); if (!badge) return; const threads = buildMailboxThreads(tasks, feedbackEntries, digests); const count = mailboxUnreadCount(threads === null ? [] : mailboxVisibleThreads(threads, mailboxState.resolved, false), mailboxState.read); badge.textContent = count > 0 ? String(count) : ""; }
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
      rows.push({ key: `task:${t.taskId}`, html: needsMeTaskRowHtml(t), taskId: t.taskId, ts: t.escalationOpenedAt ?? t.startedAt });
    }
    // W1-T507: a DISTINCT kind, grouped in its OWN pass immediately after the escalation rows
    // above -- never folded into the `needsHuman` loop, so an escalation row's own affordance
    // (view issue / mark handled) is untouched by this addition. Reaches this list via its OWN
    // sparse field (status.ts's projectPlan-level `verifyHumanPending`, set only once a task is
    // filed verify: human AND not yet credited merged) -- never a widened `needsHuman`, per this
    // task's design.
    // W1-T3183: this is the ONLY row kind carrying no actionable referent -- no issue URL, no PR,
    // no form, no button (needsMeVerifyRowHtml's own doc: "No action affordance renders here on
    // purpose"). `group: "backlog"` names that fact right where the row is built, off the SAME
    // `verifyHumanPending` field that already singles this loop out -- never a second classifier
    // that re-derives actionability from the rendered html and could disagree with the renderer.
    for (const t of tasks) {
      if (!t.verifyHumanPending) continue;
      shown.add(t.taskId);
      rows.push({ key: `verify:${t.taskId}`, html: needsMeVerifyRowHtml(t), taskId: t.taskId, group: "backlog" });
    }
    for (const e of feedbackEntries ?? []) {
      if (e.status === "grilling") rows.push({ key: `fbg:${e.id}`, html: needsMeGrillHtml(e), ts: e.ts });
      else if (e.status === "proposed") rows.push({ key: `fbp:${e.id}`, html: needsMeProposedHtml(e), ts: e.ts });
    }
    for (const p of inboxReady ?? []) rows.push({ key: `inbox:${p.proposalId}`, html: needsMeInboxHtml(p) });
    for (const p of inboxDrafting ?? []) rows.push({ key: `inbox-drafting:${p.proposalId}`, html: needsMeDraftingHtml(p), ts: p.spawnedAt });
    // W1-T1006: the sixth group, its OWN pass exactly like verifyHumanPending's above -- never
    // folded into the needsHuman loop, and reached via module state (latestBlockedPrs) rather
    // than a new parameter here, so every existing caller of renderNeedsMe is untouched.
    for (const r of latestBlockedPrs ?? []) rows.push({ key: `blocked-pr:${r.prNumber}`, html: needsMeBlockedPrRowHtml(r) + mergeHoldActionHtml(r.prNumber) });
    if (latestBlockedPrsUnverifiedReason) {
      rows.push({ key: "blocked-pr-unverified", html: needsMeBlockedPrUnverifiedHtml(latestBlockedPrsUnverifiedReason) });
    }
    // W1-T3183: TWO POPULATIONS, SEPARATED IN THE MARKUP -- an ask has a referent an operator can
    // act on now; the verify:human backlog has none (see the `group: "backlog"` push above). Each
    // gets its own list, own count, own reconcileRows call -- never one blended list wearing one
    // blended count. The backlog list is never collapsed, hidden or paginated (W1-T507's own
    // purpose survives): it always renders, right alongside the asks.
    const askRows = rows.filter((r) => r.group !== "backlog");
    const backlogRows = rows.filter((r) => r.group === "backlog");
    reconcileRows(document.getElementById("needs-me-list"), askRows, "nothing needs you right now");
    reconcileRows(document.getElementById("needs-me-backlog-list"), backlogRows, "no verify: human backlog");
    tickElapsed(); // paint the DRAFTING row's freshly-(re)rendered elapsed span immediately, same as renderNow does
    updateNeedsMeArrivalEmphasis(askRows);
    finishSectionRender("needs-me", askRows.length === 0 && backlogRows.length === 0, () => needsMeSummaryText(askRows));
    if (sectionDefaultsReady) setSectionSummary("needs-me-backlog", needsMeBacklogSummaryText(backlogRows));
    // W1-T159/W1-T3183: the GLANCE strip's needs-me count AND the tab-title badge both read THIS
    // exact ASK set (task escalations + feedback grilling/proposed + inbox ready/drafting) --
    // never a second, independently-derived needs-me tally, and never the verify:human backlog,
    // which never needed a decision and must never read as one more thing behind an alarm badge.
    latestNeedsMeRows = askRows;
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
      `${statusBadge("merged")}<span class="task-id">feedback#${escapeHtml(e.id)}</span><span class="detail">accepted: ${escapeHtml(e.raw)}</span>` +
      (e.proposal_pr ? ` <span class="btn-row"><a href="${escapeHtml(e.proposal_pr)}" target="_blank" rel="noopener noreferrer">proposal PR</a></span>` : "")
    );
  }
  /** W1-T285: ACCEPTED is the missing consumer of feedback's `accepted` status -- an entry
   *  disappearing from NEEDS ME (it no longer matches "grilling"/"proposed") is not the same as an
   *  operator being able to SEE what accepting it did. Reads off the SAME `feedbackEntries` NEEDS
   *  ME itself renders (the console's own data path, latestFeedbackEntries -- never a second fetch
   *  or a helper nothing calls), so an entry accepted by the button and one accepted by a merge
   *  (panel-graph.ts's reconcileFeedbackEntries, which persists the SAME "accepted" status) are
   *  indistinguishable here -- both are just a status === "accepted" row off the one feed. */
  function renderAccepted(feedbackEntries) {
    const rows = [];
    for (const e of feedbackEntries ?? []) {
      if (e.status === "accepted") rows.push({ key: `fba:${e.id}`, html: acceptedFeedbackHtml(e), ts: e.ts });
    }
    reconcileRows(document.getElementById("accepted-list"), rows, "nothing accepted yet");
    finishSectionRender("accepted", rows.length === 0, () => acceptedSummaryText(rows));
  }
  /** W1-T223: "a NEEDS ME item arriving while the section is collapsed must not be silently
   *  missed" -- gated on `sectionDefaultsReady` for the SAME reason `finishSectionRender` is (the
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
      html: `${statusBadge("queued")}<span class="task-id">${escapeHtml(c.id)}</span><span class="detail">${escapeHtml(c.title)} · ${(c.dependsOn ?? []).length} dep(s)</span><button type="button" class="up-next-run-btn"${writeGateAttrs()} data-task-id="${escapeHtml(c.id)}" data-confirming="false" aria-pressed="false">Run</button>${rowChevronHtml()}`,
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
   *  `formatElapsed`'s live countUP for an in-flight NOW row's own `elapsedMs`). */

  /** GitHub DECORATES: the PR link's label prefers the PR's own title (when GitHub resolved
   *  one); absent that, it degrades to the bare PR number/url -- never omits the link itself. */
  /** The PR link's label carries BOTH the number AND the title when GitHub resolved one
   *  ("#123 — the actual PR title") -- never the title ALONE (a bare title with no PR number
   *  reads ambiguously as free text, not a PR reference). Degrades to the bare number, then the
   *  raw url, as GitHub's decoration itself degrades -- the link is never omitted. */


  // W1-T141/W1-T435: the ONE-TAP OPERATOR VERDICT, on the RECENT feed's own terminal-outcome
  // rows -- "merged"/"verdict" (a review-derived merge or a classified blocked outcome, board.ts's
  // classifyLine) and "escalated" -- never a mid-rung row (fix/spend/run-started/run-refused),
  // which has no outcome yet for an operator to judge. `drainRunId` has no live producer of its
  // own (W1-T435 is entirely local-file: the ledger + plan/questions.ndjson, never a new
  // board.ts field) -- `taskId:ts` is this ONE feed event's own natural key (the SAME pair
  // `renderRecent`'s row `key` already uses), stable and unique per row without widening
  // RecentActivityEntry's shape.
  const DRAIN_FEEDBACK_VERBS = new Set(["merged", "verdict", "escalated"]);
  const DRAIN_FEEDBACK_VERDICT_LABEL = { good: "good", wrong: "wrong", "needs-follow-up": "needs follow-up" };
  function recentFeedbackHtml(e) {
    if (!DRAIN_FEEDBACK_VERBS.has(e.verb)) return "";
    const drainRunId = `${e.taskId}:${e.ts}`;
    const btns = Object.entries(DRAIN_FEEDBACK_VERDICT_LABEL)
      .map(([verdict, label]) => `<button type="button" class="drain-feedback-btn"${writeGateAttrs()} data-verdict="${verdict}">${escapeHtml(label)}</button>`)
      .join("");
    return (
      `<span class="drain-feedback" data-task-id="${escapeHtml(e.taskId)}" data-drain-run-id="${escapeHtml(drainRunId)}">` +
      `${btns}` +
      `<textarea class="drain-feedback-note" rows="1" placeholder="steering note (optional) -- quoted verbatim into the next fix attempt"${writeGateAttrs()}></textarea>` +
      `</span>`
    );
  }

  function recentRowHtml(e) {
    const key = RECENT_BADGE_KEY[e.verb] ?? "queued";
    const verbLabel = RECENT_VERB_LABEL[e.verb] ?? e.verb;
    const detail = e.detail ? ` (${escapeHtml(e.detail)})` : "";
    const unavailable = e.githubUnavailable ? ` · <span class="recent-gh-unavailable">GitHub unavailable</span>` : "";
    return (
      `${statusBadge(key)}<span class="task-id" data-verb="${escapeHtml(e.verb)}">${escapeHtml(e.taskId)}</span>` +
      `<span class="detail">` +
      `<span class="recent-verb">${escapeHtml(verbLabel)}</span>${detail} — ` +
      `<span class="recent-title">${escapeHtml(e.title)}</span>` +
      `${recentSpendHtml(e)}${recentPrLinkHtml(e)}${unavailable} · ` +
      `<time class="recent-ts" datetime="${escapeHtml(e.ts)}">${escapeHtml(formatAgo(e.ts))}</time>` +
      `</span>` +
      `${recentFeedbackHtml(e)}` +
      rowChevronHtml()
    );
  }

  function renderRecent(entries) {
    const list = entries ?? [];
    // Keyed on taskId+ts+index (never bare taskId): the SAME task can carry many rows over
    // time (a verdict, a fix outcome, a spend checkpoint, …) -- an activity FEED, not one row
    // per task (W1-T156's DOM-stability reconciliation needs a key unique PER ROW, not per task).
    const rows = list.map((e, i) => ({ key: `${e.taskId}:${e.ts}:${i}`, html: recentRowHtml(e), taskId: e.taskId }));
    reconcileRows(document.getElementById("recent-list"), rows, "no recent activity yet");
    finishSectionRender("recent", list.length === 0, () => recentSummaryText(list));
    return new Set(list.map((e) => e.taskId));
  }

  // ── W1-T163: "since you last checked" — a ONE-TIME recap, rendered off THIS page load's
  // FIRST /v1/status response and never again (see refreshAll's `recapRendered` gate, below).
  // Every subsequent poll's own `recap` field reflects an ALREADY-ADVANCED marker (board.ts
  // advances this token's marker on every view, per lib/last-seen.ts) — re-rendering off it would
  // make the section collapse to near-empty a few seconds after the operator opened the tab,
  // which is the opposite of "since you last checked". A plain `<a href="#task=...">` reuses the
  // SAME hash deep-link route `applyDeepLinkIfNeeded`/`deepLinkTaskId` already parse — no new
  // navigation mechanism. Unlike RECENT/NOW, this section is never DOM-reconciled afterward, so
  // a plain innerHTML build (not reconcileRows) is enough.
  const RECAP_KIND_LABEL = { merged: "merged", blocked: "blocked", escalated: "escalated", question_answered: "answered", retro: "retro run" };
  function recapRowHtml(e) {
    const label = RECAP_KIND_LABEL[e.kind] ?? e.kind;
    const detail = e.detail ? ` — ${escapeHtml(e.detail)}` : "";
    const name = e.taskCardLink
      ? `<a href="${escapeHtml(e.taskCardLink)}">${escapeHtml(e.title ? `${e.taskId} — ${e.title}` : e.taskId)}</a>`
      : escapeHtml(e.taskId);
    return `<li>${escapeHtml(label)}: ${name}${detail} · ${escapeHtml(formatAgo(e.ts))}</li>`;
  }
  // W1-T336: "recap" is hidden for TWO independent reasons that must never overwrite each
  // other -- its OWN content decision (recapWantsShow, set ONLY here, exactly as before this
  // task) and tab ownership (currentActiveTab, set only by applyActiveTab, below). Both are
  // combined here rather than either handler touching `hidden` alone, so a tab switch can hide
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
  // Client-side, instant, and URL-persisted. The FIND corpus is the WHOLE board (`findTasks`),
  // NOT just the "everything else" complement — the acceptance bar's facets (`needs-me`, plus
  // `status` values like running/merged that the priority sections above route away) must be able
  // to narrow to those tasks, and cmd+K must reach ANY task. The collapsed grouped-count line
  // still summarizes the complement (what is hidden below the four priority sections). The whole
  // view (search text + one value per facet + sort column/direction) round-trips through the URL
  // via history.replaceState, so a view is shareable/bookmarkable and survives reload.

  let findTasks = []; // the whole board — the searchable/filterable/sortable corpus

  // ── the ONE fuzzy scorer, shared by the FIND search bar AND the cmd+K palette ──────────────
  // Case-insensitive SUBSEQUENCE match over the haystack; returns null when the query is not a
  // subsequence (row hidden), else a score (higher = tighter, consecutive-run-weighted). An empty
  // query is a neutral match (score 0) — every row passes, natural order preserved.

  // ── FIND view state (mirrored to/from the URL) ────────────────────────────────────────────
  const FIND_FACET_GROUPS = ["status", "workstream", "risk", "hasPr", "needsMe"];
  const findState = {
    q: "",
    facets: { status: null, workstream: null, risk: null, hasPr: false, needsMe: false },
    sort: "id",
    dir: "asc",
  };

  /** Workstream = the id prefix before `-T` (verified convention: W1/W2/W3/W12) — pure string parse. */
  function passesSearch(t) {
    return fuzzyScore(findState.q, searchHaystack(t)) !== null;
  }
  /** Does task `t` match facet GROUP's value `value` (independent of what is currently selected)? */
  /** Does `t` satisfy a group's CURRENTLY-ACTIVE selection? (An unselected group matches everything.) */
  function facetActiveMatches(t, group) {
    const sel = findState.facets[group];
    if (group === "hasPr" || group === "needsMe") return sel ? facetValueMatches(t, group, true) : true;
    return sel ? facetValueMatches(t, group, sel) : true;
  }
  /** All active facets EXCEPT `exceptGroup` (used for a group's own live counts). */
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
  function cmpByStatus(a, b, dir) {
    const base = TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status);
    return dir === "desc" ? -base : base;
  }
  function findSortComparator(sort) {
    switch (sort) {
      case "status": return cmpByStatus;
      case "recency": return cmpByRecency;
      case "age": return cmpByAge;
      case "id":
      default: return cmpById;
    }
  }
  function normalizeFindSort(sort) {
    switch (sort) {
      case "status":
      case "recency":
      case "age":
      case "id":
        return sort;
      default:
        return "id";
    }
  }
  function sortFindRows(rows) {
    const cmp = findSortComparator(findState.sort);
    return rows.slice().sort((a, b) => cmp(a, b, findState.dir) || cmpById(a, b, "asc"));
  }

  // ── URL round-trip: own a small key set, ALWAYS preserving `token` (+ any other params) ────
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
    findState.sort = normalizeFindSort(p.get("sort"));
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
    return `<button type="button" class="facet-btn" data-group="${group}" data-value="${escapeHtml(value)}" aria-pressed="${active ? "true" : "false"}">${escapeHtml(label)} <span class="facet-count">(${facetCount(group, value === "" ? true : value)})</span></button>`;
  }
  function renderFacets() {
    const groups = [];
    for (const g of ["status", "workstream", "risk"]) {
      const opts = facetOptions(g);
      if (opts.length === 0) continue;
      const btns = opts.map((v) => facetBtnHtml(g, v, v, findState.facets[g] === v)).join("");
      groups.push(`<span class="facet-group"><span class="facet-group-label">${g}</span>${btns}</span>`);
    }
    // has-PR / needs-me are boolean toggles (a single value each).
    groups.push(`<span class="facet-group"><span class="facet-group-label">flags</span>${facetBtnHtml("hasPr", "", "has PR", findState.facets.hasPr)}${facetBtnHtml("needsMe", "", "needs me", findState.facets.needsMe)}</span>`);
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
      `${statusBadge(statusColorKey(t))}<span class="task-id">${escapeHtml(t.taskId)}</span>` +
      `<span class="detail">${escapeHtml(t.title ?? "")}${t.risk ? ` · risk: ${escapeHtml(t.risk)}` : ""}${prLink(t)}</span>` +
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
      `${filtered.length} match${filtered.length === 1 ? "" : "es"} of ${findTasks.length} task${findTasks.length === 1 ? "" : "s"}`;
  }
  /** Re-render the FIND view AND persist the new state to the URL (one call per interaction). */
  function applyFindState() {
    if (!document.getElementById("rest-detail").hidden) renderFindView();
    writeFindStateToUrl();
  }

  /** REST's summary derives from `complement` -- the SAME array `findTasks`/the FIND corpus is
   *  built from just below -- never a second filter pass. It summarizes the COMPLEMENT ("everything
   *  else" not already surfaced in one of the four priority sections above), which stays the
   *  right number even while the FIND search/facets narrow what actually RENDERS inside; that is
   *  a further, separately-labelled view (#find-count) over this same corpus, not a disagreement. */
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
    const key = normalizeFindSort(btn.dataset.sort);
    if (key !== btn.dataset.sort) return;
    if (findState.sort === key) findState.dir = findState.dir === "asc" ? "desc" : "asc";
    else { findState.sort = key; findState.dir = key === "recency" || key === "age" ? "desc" : "asc"; }
    applyFindState();
  });

  // Queue filters are a view over the already-loaded atomic /v1/status snapshot. They trigger
  // no fetch and no write; the next ordinary snapshot simply reuses the selected view.
  document.getElementById("pr-queue-actionability").addEventListener("change", (e) => {
    prQueueFilters.actionability = e.target.value;
    renderPrQueue(latestPrQueue);
  });
  document.getElementById("pr-queue-review").addEventListener("change", (e) => {
    prQueueFilters.review = e.target.value;
    renderPrQueue(latestPrQueue);
  });
  document.getElementById("pr-queue-task").addEventListener("change", (e) => {
    prQueueFilters.task = e.target.value;
    renderPrQueue(latestPrQueue);
  });

  // Restore FIND state from the URL BEFORE first paint, so a fresh navigation to a shared URL
  // renders that exact view with no interaction (and auto-expands the section so its rows show).
  readFindStateFromUrl();
  document.getElementById("find-search").value = findState.q;
  renderSortHeaders();
  if (findHasUrlState()) expandRest();

  // ── W1-T336/W1-T2718: the console tab bar is AUTHORITATIVE -- its OWN url state ────────────
  // Same idiom as FIND's round-trip just above -- URLSearchParams read fresh off
  // window.location.search, one key set, history.replaceState preserving token + every other
  // existing param -- a SEPARATE key ("tab") riding the page's ONE existing view-state
  // mechanism, never a second channel (no localStorage, no custom event). Selecting a tab still
  // issues no fetch, poll or gateway call -- it only flips each owned section's own `hidden`;
  // every section's own data keeps flowing (and its own badge/title effects keep firing)
  // regardless of which sections are currently shown.
  const CONSOLE_TABS = ["decisions", "queue", "now", "plan", "feed"];
  // Which tab owns each section, now that the tabs govern layout -- the single table the markup
  // above is a concrete rendering of (each owned section carries the SAME value as its own
  // data-owner-tab attribute). Kept here (not inferred from the DOM) so a reveal path
  // (jumpToTask/focusAndExpandTask, revealSectionOf, applyRecapVisibility, above) can look up a
  // section's owning tab without walking the tree.
  const SECTION_TAB_OWNER = {
    "mailbox-section": "decisions",
    "needs-me": "decisions",
    "pr-queue": "queue",
    now: "now",
    "up-next": "now",
    controls: "now",
    recap: "feed",
    accepted: "feed",
    recent: "feed",
    rest: "feed",
    "run-history": "feed",
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
      const sc = fuzzyScore(query, `${a.label} action`);
      if (sc !== null) out.push({ type: "action", id: a.id, label: a.label, score: sc });
    }
    for (const t of tasksById.values()) {
      const sc = fuzzyScore(query, searchHaystack(t));
      if (sc !== null) out.push({ type: "task", taskId: t.taskId, label: `${t.taskId} — ${t.title ?? ""}`, score: sc + 1 });
      if (t.prUrl) {
        const psc = fuzzyScore(query, `${t.taskId} pr ${t.prNumber ?? ""}`);
        if (psc !== null) out.push({ type: "pr", taskId: t.taskId, prUrl: t.prUrl, label: `Open PR ${t.prNumber !== undefined ? "#" + t.prNumber : t.prUrl} · ${t.taskId}`, score: psc });
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
      .map((r, i) => `<li class="cmdk-item${i === cmdkActive ? " active" : ""}" role="option" aria-selected="${i === cmdkActive}" data-i="${i}"><span class="cmdk-kind">${r.type === "action" ? "ACTION" : r.type === "pr" ? "PR" : "TASK"}</span> ${escapeHtml(r.label)}</li>`)
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
  // W1-T2302: one submission key PER answer form, keyed by replyTo, mirroring
  // answerConfirmTimers/answerExpansions's own per-replyTo discipline -- minted ONCE for
  // whichever submit episode is currently unresolved for a given grill (preview -> fail-open,
  // or preview -> arm -> confirm both read the SAME key back rather than minting a fresh one),
  // and sent to the server so a repeat POST /v1/feedback (a reload, a second tab, a stray
  // re-entrant click landing while the first request is still in flight) is recognised as the
  // SAME submission instead of filing a second durable entry. Cleared only once a filing POST
  // for that replyTo actually resolves.
  const answerSubmissionKeys = new Map();
  // W1-T2302: crypto.randomUUID when available (every modern browser), a Math.random fallback
  // otherwise -- either way this is an opaque per-submission identity, never derived from the
  // answer text itself (two deliberately separate submissions carrying identical text must
  // still each file as their own entry).
  function mintSubmissionKey() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return "sk-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  }
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
        // W1-T2302: read back the SAME key this submission was minted under (below, on the
        // click that armed it) rather than minting a fresh one -- confirm is the SECOND half of
        // ONE submission, not a new one.
        if (!answerSubmissionKeys.has(replyTo)) answerSubmissionKeys.set(replyTo, mintSubmissionKey());
        const submissionKey = answerSubmissionKeys.get(replyTo);
        resetAnswerButton(submitBtn);
        await postJson("/v1/feedback", { text: answer, replyTo, expansion, submissionKey });
        answerSubmissionKeys.delete(replyTo);
        input.value = "";
        refreshAll();
        return;
      }
      // First submit: PREVIEW the expansion -- FAIL-OPEN, never blocks filing on an expander
      // outage/timeout (this task's stated failure mode). W1-T2206: render the pending state for
      // the WHOLE call, and clear it on every exit below (expansion, no expansion, or a thrown/
      // rejected preview fetch) -- a pending state that survives a rejected fetch is a worse dead
      // button than the unguarded await it replaces.
      //
      // W1-T2301: this ONE call site's outcome branches below into either the fail-open leg (which
      // files on THIS SAME click) or the arm leg (which files nothing). postJson's automatic ack
      // cannot know which branch it is about to fall into -- it fires synchronously on the preview's
      // own 200, before either branch runs -- so it would paint "nothing is filed yet" even on the
      // fail-open leg that is about to file behind it (the defect this task closes). suppressAck
      // opts out of that automatic ack HERE; the arm leg below fires it manually, by hand, only once
      // it has confirmed (via the resolved expansion) that this really is the leg the text is true for.
      // W1-T2302: mint (or reuse, on a re-entrant click landing before the first request settles)
      // ONE key for this submission BEFORE either branch below can fire it -- both the fail-open
      // leg just past the preview and the arm's later confirm leg above read this SAME map entry.
      if (!answerSubmissionKeys.has(replyTo)) answerSubmissionKeys.set(replyTo, mintSubmissionKey());
      answerPending.add(replyTo);
      setAnswerPending(submitBtn, true);
      let expansion = null;
      try {
        const previewRes = await postJson("/v1/feedback/preview", { text: answer, replyTo }, { suppressAck: true });
        if (previewRes && previewRes.ok) {
          const previewBody = await previewRes.json();
          expansion = previewBody.expansion ?? null;
        }
      } catch {
        // preview fetch/parse failed -- fall open to the plain (no-preview) submit path below
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
        // W1-T2301: the filing POST below is NOT suppressed -- its own ok-path ack ("Answer
        // recorded.") is the true statement this leg leaves the operator with, and its own
        // not-ok-path showWriteError (unchanged, design (iv)) still speaks if the filing itself
        // fails, rather than leaving the operator with a stale ack painted by the preview above.
        // W1-T2302: the SAME key minted above the try/catch, so a repeat of THIS click is
        // recognised as the same submission instead of filing a second entry.
        const submissionKey = answerSubmissionKeys.get(replyTo);
        await postJson("/v1/feedback", { text: answer, replyTo, submissionKey });
        answerSubmissionKeys.delete(replyTo);
        input.value = "";
        refreshAll();
        return;
      }
      // ARM: the armed control shows the expansion's read-back AND states plainly that nothing
      // is filed yet and the NEXT click is the one that files -- design (iii), the exact
      // ambiguity the operator hit ("no idea if I still need to address this... or not").
      // W1-T2301: fire the preview's own WRITE_ACK text by hand -- this is the leg it is actually
      // true for (design (ii): the wording stays, unweakened, for the leg that really files
      // nothing). Same table, same showWriteAck, just invoked here instead of from postJson's
      // ok arm, which stayed suppressed above precisely so it could not fire early.
      showWriteAck("/v1/feedback/preview");
      answerExpansions.set(replyTo, expansion);
      submitBtn.dataset.confirming = "true";
      submitBtn.setAttribute("aria-pressed", "true");
      submitBtn.classList.add("confirming");
      submitBtn.classList.remove("lapsed");
      submitBtn.textContent =
        `Confirm: ${expansion.claim} (RECON ${expansion.recon.length}) — nothing filed yet, click to file`;
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
        approveBtn.textContent = `Confirm approve ${approveBtn.dataset.readBack}?`;
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

  // ── MAILBOX write-actions (W1-T2497) -- Open/Resolve are read-state, no write token needed. ──
  document.getElementById("mailbox").addEventListener("click", (e) => { const openBtn = e.target.closest(".mailbox-open"); const resolveBtn = e.target.closest(".mailbox-resolve"); if (openBtn) mailboxState = { ...mailboxState, read: mailboxMarkRead(mailboxState.read, openBtn.dataset.threadId) }; else if (resolveBtn) mailboxState = { ...mailboxState, resolved: mailboxMarkResolved(mailboxState.resolved, resolveBtn.dataset.threadId) }; else return; saveMailboxState(mailboxState); renderMailbox(Array.from(tasksById.values()), latestFeedbackEntries, latestInboxDigests); });
  document.getElementById("mailbox").addEventListener("submit", async (e) => { const replyForm = e.target.closest(".mailbox-reply"); if (!replyForm) return; e.preventDefault(); if (!hasWriteScope) return; const input = replyForm.querySelector("input"); const text = input.value.trim(); if (!text) return; await postJson("/v1/escalation/reply", { taskId: replyForm.dataset.taskId, class: replyForm.dataset.class, text }); input.value = ""; refreshAll(); });

  // ── W1-T2719: durable automatic-merge hold controls. One delegated listener serves the
  // permanent fleet form, current-held rows, and live blocked-PR rows. Confirmation text names
  // the exact action, scope and reason before the high-tier nonce round trip starts.
  document.addEventListener("submit", async (e) => {
    const form = e.target.closest && e.target.closest(".merge-hold-action");
    if (!form) return;
    e.preventDefault();
    if (!hasWriteScope) return;
    const input = form.querySelector("input");
    const reason = input && input.value.trim();
    if (!reason) {
      if (input) { input.setCustomValidity("A reason is required."); input.reportValidity(); }
      return;
    }
    input.setCustomValidity("");
    const button = form.querySelector("button[type=submit]");
    const action = button.dataset.action;
    const scope = form.dataset.scope;
    if (!window.confirm(mergeHoldConfirmationText(action, scope, reason))) return;
    const prNumber = form.dataset.prNumber ? Number(form.dataset.prNumber) : undefined;
    const taskId = form.dataset.taskId || undefined;
    const response = await postJson("/v1/merge-hold", {
      action,
      reason,
      ...(prNumber !== undefined ? { prNumber } : {}),
      ...(taskId ? { taskId } : {}),
    });
    if (response && response.ok) {
      input.value = "";
      await refreshAll();
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
      runBtn.textContent = `Confirm run ${runBtn.dataset.taskId}?`;
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
      btn.textContent = `Confirm: set ceiling to ${costLabel(usd)} (was ${was}) — effective next tick, no restart?`;
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
      btn.textContent = `Confirm: clear override — reverts to ${def} — effective next tick, no restart?`;
      clearTimeout(ceilingClearConfirmTimer);
      ceilingClearConfirmTimer = setTimeout(() => resetCeilingClearButton(), 8000);
      return;
    }
    resetCeilingClearButton();
    postJson("/v1/policy/daily-cost-ceiling/clear").then(refreshAll);
  });

  // ── live provider-routing policy — a bounded state override consumed by spawnWorker on each
  // dispatch. These controls never call provider capacity readers and never own daemon/container
  // lifecycle. The first click arms an exact payload; the second spends the high-tier nonce.
  function providerPolicyFormSignature() {
    return JSON.stringify({
      claude: document.getElementById("provider-policy-enabled-claude").checked,
      codex: document.getElementById("provider-policy-enabled-codex").checked,
      preference: document.getElementById("provider-policy-preference").value,
      reserve: document.getElementById("provider-policy-reserve").value,
      codexModel: document.getElementById("provider-policy-codex-model").value,
      parkClaude: document.getElementById("provider-policy-park-claude").value,
      parkCodex: document.getElementById("provider-policy-park-codex").value,
      expiry: document.getElementById("provider-policy-expiry").value,
    });
  }
  function buildProviderPolicyPayload() {
    const enabledProviders = [];
    if (document.getElementById("provider-policy-enabled-claude").checked) enabledProviders.push("claude");
    if (document.getElementById("provider-policy-enabled-codex").checked) enabledProviders.push("codex");
    const preference = document.getElementById("provider-policy-preference").value;
    const reservePercent = Number(document.getElementById("provider-policy-reserve").value);
    const expiryMinutes = Number(document.getElementById("provider-policy-expiry").value);
    const status = document.getElementById("provider-policy-status");
    if (!enabledProviders.length) { status.textContent = "Refused locally: keep at least one configured provider enabled."; return null; }
    if (preference !== "automatic" && enabledProviders.indexOf(preference) === -1) {
      status.textContent = "Refused locally: the preferred provider must remain enabled.";
      return null;
    }
    if (!Number.isFinite(reservePercent) || reservePercent < 0 || reservePercent > 50) {
      status.textContent = "Refused locally: reserve must be between 0% and 50%.";
      return null;
    }
    const now = Date.now();
    const expiresAt = new Date(now + expiryMinutes * 60 * 1000).toISOString();
    const parks = [];
    [["claude", "provider-policy-park-claude"], ["codex", "provider-policy-park-codex"]].forEach(function (entry) {
      const provider = entry[0];
      const minutes = Number(document.getElementById(entry[1]).value);
      if (minutes > 0 && enabledProviders.indexOf(provider) !== -1) {
        parks.push({ provider: provider, until: new Date(now + Math.min(minutes, expiryMinutes) * 60 * 1000).toISOString() });
      }
    });
    if (parks.length === enabledProviders.length) {
      status.textContent = "Refused locally: an override cannot park every enabled provider.";
      return null;
    }
    if (preference !== "automatic" && parks.some(function (park) { return park.provider === preference; })) {
      status.textContent = "Refused locally: the preferred provider cannot also be parked.";
      return null;
    }
    const model = document.getElementById("provider-policy-codex-model").value;
    let codexModelPreference = null;
    if (model) {
      const codex = latestProviderRouting && Array.isArray(latestProviderRouting.providers)
        ? latestProviderRouting.providers.find(function (provider) { return provider.provider === "codex"; })
        : null;
      const decision = codex && codex.modelDecision;
      const option = decision && (decision.options || []).find(function (candidate) { return candidate.id === model; });
      if (latestProviderRouting.freshness !== "fresh" || !decision || !option || !option.mapped || !option.eligible) {
        status.textContent = "Refused locally: choose only a fresh, mapped Codex model with headroom.";
        return null;
      }
      codexModelPreference = { capability: decision.requestedCapability, effort: decision.requestedEffort, model: model };
    }
    return { enabledProviders, preference, reservePercent, parks, codexModelPreference, expiresAt };
  }
  function applyProviderPolicyResponse(response) {
    if (!response || !response.policy || !latestProviderRouting) return;
    latestProviderRouting = Object.assign({}, latestProviderRouting, { policy: response.policy });
    renderProviderRouting(latestProviderRouting);
    renderProviderPolicyControl(latestProviderRouting);
  }
  let providerPolicyConfirmTimer;
  function resetProviderPolicyApplyButton() {
    const btn = document.getElementById("provider-policy-apply-btn");
    btn.dataset.confirming = "false";
    btn.dataset.armedSignature = "";
    btn.dataset.armedPayload = "";
    btn.setAttribute("aria-pressed", "false");
    btn.classList.remove("confirming");
    btn.textContent = "Apply policy";
    clearTimeout(providerPolicyConfirmTimer);
  }
  document.getElementById("provider-policy-apply-btn").addEventListener("click", () => {
    if (!hasWriteScope) return;
    const btn = document.getElementById("provider-policy-apply-btn");
    const signature = providerPolicyFormSignature();
    if (btn.dataset.confirming !== "true" || btn.dataset.armedSignature !== signature) {
      const payload = buildProviderPolicyPayload();
      if (!payload) return;
      btn.dataset.confirming = "true";
      btn.dataset.armedSignature = signature;
      btn.dataset.armedPayload = JSON.stringify(payload);
      btn.setAttribute("aria-pressed", "true");
      btn.classList.add("confirming");
      btn.textContent = "Confirm provider policy — effective next dispatch; no restart, recycle or deploy?";
      clearTimeout(providerPolicyConfirmTimer);
      providerPolicyConfirmTimer = setTimeout(() => resetProviderPolicyApplyButton(), 15000);
      return;
    }
    const payload = JSON.parse(btn.dataset.armedPayload);
    resetProviderPolicyApplyButton();
    postJson("/v1/policy/provider-routing", payload).then(function (res) {
      return res && res.ok ? res.json().then(applyProviderPolicyResponse) : undefined;
    });
  });
  let providerPolicyClearConfirmTimer;
  function resetProviderPolicyClearButton() {
    const btn = document.getElementById("provider-policy-clear-btn");
    btn.dataset.confirming = "false";
    btn.setAttribute("aria-pressed", "false");
    btn.classList.remove("confirming");
    btn.textContent = "Clear provider override";
    clearTimeout(providerPolicyClearConfirmTimer);
  }
  document.getElementById("provider-policy-clear-btn").addEventListener("click", () => {
    if (!hasWriteScope) return;
    const btn = document.getElementById("provider-policy-clear-btn");
    if (btn.dataset.confirming !== "true") {
      btn.dataset.confirming = "true";
      btn.setAttribute("aria-pressed", "true");
      btn.classList.add("confirming");
      btn.textContent = "Confirm clear — committed host policy returns next dispatch; no restart?";
      clearTimeout(providerPolicyClearConfirmTimer);
      providerPolicyClearConfirmTimer = setTimeout(() => resetProviderPolicyClearButton(), 15000);
      return;
    }
    resetProviderPolicyClearButton();
    postJson("/v1/policy/provider-routing/clear", {}).then(function (res) {
      return res && res.ok ? res.json().then(applyProviderPolicyResponse) : undefined;
    });
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
    // W1-T2409: the "ask" button lives beside the paste form and shares its hidden/shown state --
    // both are ways to OBTAIN a token, so both go away once one is already held and accepted.
    const requestBtn = document.getElementById("write-token-request-btn");
    if (hasWriteScope) {
      statusEl.textContent = "Write access enabled for this tab.";
      form.hidden = true;
      if (requestBtn) requestBtn.hidden = true;
      clearBtn.hidden = false;
    } else {
      statusEl.textContent = writeToken
        ? "That write token was not accepted — write actions stay unavailable."
        : "Read-only — write actions are unavailable. Request a write token for this tab, or paste one. Get one by running: rmd console-url --write";
      form.hidden = false;
      if (requestBtn) requestBtn.hidden = false;
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
        hasWriteScope = false; // probe failed -- default to the safe (no write affordance) state, never guess yes
      }
    }
    document.body.dataset.writeScopeResolved = "1";
    updateWriteTokenUi();
    applyControlStatus(lastControlStatus);
    applyProviderPolicyControlGate();
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
  // W1-T2409: the in-page "ask" -- GET /v1/console/write-grant with the read token this tab
  // already carries (authHeaders, the SAME header the shell's own bootstrap fetches use, NEVER
  // the URL). No pacing/retry/timeout added here: one round trip, resolved or failed immediately,
  // matching every other side-effect-free probe on this page (probeWriteScope, above).
  document.getElementById("write-token-request-btn").addEventListener("click", () => {
    const btn = document.getElementById("write-token-request-btn");
    const statusEl = document.getElementById("write-token-status");
    btn.disabled = true;
    fetch("/v1/console/write-grant", { headers: authHeaders })
      .then((res) => {
        if (!res.ok) throw new Error("write-grant request failed: HTTP " + res.status);
        return res.json();
      })
      .then((data) => {
        writeToken = String((data && data.token) || "");
        try {
          window.sessionStorage.setItem(WRITE_TOKEN_STORAGE_KEY, writeToken);
        } catch {
          // storage disabled/blocked -- same fallback the paste-form handler above already accepts:
          // the token still works for THIS page load via the in-memory 'writeToken', never a
          // fallback to the URL/a cookie/a second disk path.
        }
        return probeWriteScope();
      })
      .catch(() => {
        // Never a token in this branch -- writeToken is left exactly as it was. The paste form
        // stays visible as the fallback (updateWriteTokenUi's own doc, above).
        statusEl.textContent = "Could not request a write token for this tab — try again, or paste one below.";
      })
      .finally(() => {
        btn.disabled = false;
      });
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
        ? entries.map((e) => `${e.id ?? "?"} — ${e.status ?? ""}: ${e.raw ?? ""}`).join("\n")
        : "(inbox empty)";
    } catch (e) {
      body.textContent = `panel fetch failed: ${e}`;
    }
  });
  // ── W1-T222 INLINE DETAIL layer: the row-click task CARD, now a sibling <li> DIRECTLY BENEATH
  // the row that opened it -- never a scroll-away section. title/rationale/acceptance criteria/
  // dependency chain (each dep LINKED)/run history (cost + verdict)/PR + issue links -- from ONE
  // GET /v1/task?id= fetch, zero further GitHub calls (see lib/task-card.ts's header). Dep links
  // recurse through focusAndExpandTask, never a page navigation. Exactly ONE card is open at a
  // time, board-wide (opening a second closes the first) -- reconcileRows above is what keeps
  // that one open card glued to its own row across a background poll/SSE re-render.
  /** `live`, when present, is this task's CURRENT tasksById projection (needsHuman/
   *  escalationIssueUrl) -- the card's issue link and write action both key off it rather than
   *  off the TaskCard response, which carries no live escalation state of its own. */
  /**
   * W1-T222: "actions RENDER PER AUTH SCOPE -- a read-only bookmark shows no write affordances
   * at all, rather than showing them and failing on click" (standing rule 22). `hasWriteScope`
   * is resolved ONCE at boot (see the GET /v1/auth/scope probe near this shell's bootstrap) --
   * with a read-only token this always returns "", so the card carries zero write controls, not
   * a disabled/explained one (that richer "unavailable, here's why" treatment is W1-T202's own
   * job -- see this task's plan note on the two coordinating rather than colliding).
   */
  function cardActionsHtml(taskId, live) {
    if (!hasWriteScope) return "";
    if (!live || !live.needsHuman || !live.escalationIssueUrl) return "";
    return (
      `<p class="btn-row"><button type="button" class="card-mark-handled" data-task-id="${escapeHtml(taskId)}" data-issue-url="${escapeHtml(live.escalationIssueUrl)}">Mark handled</button></p>`
    );
  }
  function rowDetailBodyHtml(card, live) {
    const key = statusColorKey({ status: card.status, needsHuman: Boolean(live && live.needsHuman) });
    return (
      `<p class="row-detail-title">${escapeHtml(card.id)} — ${escapeHtml(card.title)}</p>` +
      `<p>${statusBadge(key)}${card.merged ? " ✓ merged" : ""}${prLink({ prUrl: card.prUrl, prNumber: card.prNumber })}</p>` +
      cardIssueLinkHtml(live) +
      (card.rationale ? `<p class="detail">${escapeHtml(card.rationale)}</p>` : '<p class="empty">no rationale recorded</p>') +
      `<h3>Acceptance criteria</h3>${
        card.acceptance.length ? `<ul class="row-list">${card.acceptance.map(acceptanceRowHtml).join("")}</ul>` : '<p class="empty">none recorded</p>'
      }` +
      `<h3>Dependency chain</h3>${depChainHtml(card.dependsOn)}` +
      `<h3>Run history</h3>${
        card.runs.length ? `<ul class="row-list">${card.runs.map(runRowHtml).join("")}</ul>` : '<p class="empty">no runs yet</p>'
      }` +
      cardActionsHtml(card.id, live) +
      // W1-T222: the full JOURNEY LAZY-LOADS INSIDE the expansion on demand -- it must not be
      // fetched merely because a card opened (design). toggleCardJourney (below) fetches GET
      // /v1/trace on this button's FIRST click only, caching the result in .card-journey-body.
      `<p><button type="button" class="card-journey-toggle" data-task-id="${escapeHtml(card.id)}" aria-expanded="false">Show journey</button></p>` +
      '<div class="card-journey-body" hidden></div>'
    );
  }
  /** W1-T200: a pre-data-only skeleton, cleared the instant loadRowDetail below actually renders
   *  (success OR failure) -- never left standing as decoration once real content exists. */
  async function loadRowDetail(taskId, detailEl) {
    let card;
    try {
      const data = await getJson(`/v1/task?id=${encodeURIComponent(taskId)}`);
      card = data.card;
    } catch (e) {
      if (detailEl.isConnected) detailEl.innerHTML = `<p class="empty">card fetch failed: ${escapeHtml(String(e))}</p>`;
      return;
    }
    // The operator may have collapsed this card (or opened a different one) while the fetch was
    // in flight -- collapseExpanded/expandRow already detached this exact node in that case, so
    // writing into it now would resurrect a stale card nobody asked to see. isConnected guards it.
    if (!detailEl.isConnected) return;
    const live = tasksById.get(taskId);
    detailEl.innerHTML = rowDetailBodyHtml(card, live);
  }

  // ── W1-T222 EXPAND/COLLAPSE: exactly ONE row's card open at a time, board-wide. `expandedRowKey`
  // is the owning row's OWN `data-key` (never a bare taskId -- RECENT's rows are keyed
  // `taskId:ts:i`, so several rows can share a taskId; expanding is always THIS row's own card). ──
  let expandedRowKey = null;

  function collapseExpanded() {
    if (expandedRowKey === null) return;
    const row = document.querySelector(`.row[data-key="${CSS.escape(expandedRowKey)}"]`);
    if (row) {
      syncRowDisclosure(row, row.dataset.taskId || "", false, "");
      row.removeAttribute("aria-expanded");
      row.removeAttribute("aria-controls");
    }
    const detailEl = document.querySelector(".row-detail[data-detail-for]");
    if (detailEl) detailEl.remove();
    expandedRowKey = null;
  }
  function expandRow(row, key, taskId) {
    expandedRowKey = key;
    const detailEl = document.createElement("li");
    detailEl.className = "row-detail";
    detailEl.dataset.detailFor = key;
    const detailId = `row-detail-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    detailEl.id = detailId;
    // Deliberately NO role="region" -- this <li> is a direct child of the SAME <ul> its row
    // lives in, and a widget/landmark role here would demote it out of the <ul>'s own required
    // listitem content model, exactly like role="button" would on the row itself (see
    // reconcileRows's own note). aria-controls on the row is the accessible link between them.
    detailEl.setAttribute("aria-label", `Detail for ${taskId}`);
    detailEl.innerHTML = rowDetailSkeletonHtml();
    row.after(detailEl); // W1-T222: DIRECTLY beneath the row -- never a scroll-away section.
    row.removeAttribute("aria-controls");
    syncRowDisclosure(row, taskId, true, detailId);
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
    return document.querySelector(`.row[data-task-id="${CSS.escape(taskId)}"]`);
  }
  /**
   * A dependency link / journey task link / `?task=<id>` deep link all land here: find that
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
  /**
   * W1-T2489: the SAME chain journeyHtml (below) already renders as nested <ul> text -- drawn
   * ALSO as an inline SVG node graph, over the identical { feedback, tasks } shape, no new
   * fetch, no new field, nothing GET /v1/trace (panel-graph.ts) doesn't already return. Returns
   * "" for an EMPTY graph (no feedback, no tasks) -- called on its own, with no wrapper, an empty
   * graph therefore draws NOTHING; journeyHtml's own unconditional text rendering just below is
   * what turns that "" into a real fallback rather than a blank panel.
   */
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
    getJson(`/v1/trace?id=${encodeURIComponent(btn.dataset.taskId)}`)
      .then((data) => {
        body.innerHTML = journeyHtml(data.chain);
        body.dataset.loaded = "true";
      })
      .catch((e) => {
        body.innerHTML = `<p class="empty">journey fetch failed: ${escapeHtml(String(e))}</p>`;
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
            // a network failure re-arms the buttons the SAME way a failed-but-answered write does,
            // just above -- either way a transient failure must never be a dead end.
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
    const rowDisclosure = e.target.closest(".row-chevron");
    if (rowDisclosure) {
      const row = rowDisclosure.closest(".row[data-task-id]");
      if (row) toggleRowDetail(row);
      return;
    }
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
  // W1-T222 legacy guard: rows no longer receive tabindex, so keyboard disclosure is native on
  // the chevron button. Keep this for cached/stale markup that may still focus a row.
  document.querySelector("main").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    if (!e.target.classList || !e.target.classList.contains("row") || !e.target.dataset.taskId) return;
    e.preventDefault(); // Space must not also scroll the page.
    toggleRowDetail(e.target);
  });

  // ── W1-T156 TRUST: freshness stamp + the poll's own error-state LIFECYCLE. A fetch failure is
  // TRANSIENT ("reconnecting…", the last-success time named) until ${STALE_ESCALATE_AFTER}
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

  // W1-T281/W1-T2902: the console's ONE freshness model (lib/console-freshness.ts's
  // `resolveFreshness`, shipped by W1-T262/#777) is bound here as a PARAMETER of this real,
  // unit-tested function -- consoleShellClientSource (lib/console-shell-client.ts) passes the
  // REAL import's `.toString()` as this argument when it flattens the shell for the browser, so
  // this shell can never again drift from the unit-tested rule the way it did for eight days
  // (the ONLY prior reference to it anywhere outside its own test was a COMMENT claiming to
  // "mirror" it -- serve.ts never actually called it, so the STALE badge and "live · updated Ns
  // ago" kept contradicting each other). Every freshness decision below (markStale's guard,
  // handlePollFailure's escalation) calls THIS.

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
    el.textContent = secs < 2 ? "updated just now" : `updated ${secs}s ago`;
  }

  // W1-T189 ONE TRUTH: an operator-observed contradiction -- "live · updated 8s ago" rendered
  // directly above "STALE — showing last known data" -- came from two indicators reading
  // DIFFERENT clocks: the freshness stamp tracks `lastLiveAt` (poll success OR SSE delta), while
  // this escalation used to track ONLY a raw consecutive-/v1/status-failure tally, blind to a
  // healthy SSE connection still delivering genuinely fresh rows. A board can be honestly LIVE
  // (via SSE) even while its own REST poll is failing outright -- so the STALE claim (not the
  // transient "reconnecting" one) must also require that NO live data of any kind is recent.
  // W1-T281: that requirement IS resolveFreshness's own rule -- called here directly (fed
  // `lastLiveAt`, never re-derived from the SSE transport's own "connected" bit -- see
  // markStale's doc for why a merely-connected-but-idle stream must still be able to go stale)
  // instead of a second, hand-inlined `dataIsStale` arithmetic check that could (and did) drift
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
      topStatus.textContent = `reconnecting… (last success ${lastSuccessAt ? `${formatElapsed(Date.now() - lastSuccessAt)} ago` : "never"})`;
      topStatus.dataset.pollState = "reconnecting";
    } else {
      // ESCALATED: N consecutive failures AND no live data (poll or SSE) recently either -- the
      // board itself is now visibly stamped stale, never silently old (reuses the cache-restore
      // path's own stale-badge mechanism), and never contradicted by a freshness stamp claiming
      // otherwise -- both now read `lastLiveAt`.
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
      // the recorded escalation path (pollFailures/stale-banner state), not a silent drop
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
    latestMergeHeld = statusSnap.mergeHeld ?? [];
    latestPrQueue = statusSnap.prQueue ?? { complete: false, rows: [], unavailableReason: "queue snapshot unavailable" };
    paintFromTasksById();
    // W1-T163: ONE-TIME, off this load's first snapshot only -- see renderRecapSection's doc for
    // why re-rendering off every later poll's own (by-then-mostly-consumed) recap would be wrong.
    if (!recapRendered) {
      recapRendered = true;
      renderRecapSection(statusSnap.recap);
    }

    try {
      // EVERY fetch in this Promise.all shares ONE convention: a per-endpoint failure degrades
      // to a last-known/empty shape and is isolated from every sibling -- it never breaks the
      // rest of this refresh (each `.catch` below carries its own one-line reminder of that,
      // rather than only this paragraph above them, so the reason travels with the code that
      // actually swallows the error).
      const [recentSnap, upNextSnap, feedbackSnap, digestSnap, inboxSnap, controlStatus, daemonHealth, accountUsage, providerRouting, planView, selfMeasurement] = await Promise.all([
        getJson("/v1/recent").catch(() => ({ entries: [] /* degrade to empty, isolated from every sibling */ })),
        getJson("/v1/drain/preview?max=5").catch(() => ({ cards: [] /* degrade to empty, isolated from every sibling */ })),
        getJson("/v1/feedback").catch(() => ({ entries: [] /* degrade to empty, isolated from every sibling */ })),
        getJson("/v1/inbox/digests").catch((error) => ({ entries: [], omitted: 0, reason: String(error && error.message ? error.message : error) /* degrade to empty, isolated from every sibling */ })),
        getJson("/v1/inbox").catch(() => ({ ready: [], drafting: [] /* degrade to empty, isolated from every sibling */ })),
        getJson("/v1/control/status").catch(() => ({ paused: false, stopped: false, quietHours: false /* degrade to the safe default, isolated from every sibling */ })),
        // W1-T159: the daemon-health widget's own fetch -- a fetch failure here must never break
        // the rest of the refresh (same catch-and-degrade convention as every sibling above); the
        // widget just keeps showing its last-known values (or "…" pre-first-success).
        getJson("/v1/daemon-health").catch(() => null /* keep the widget's last-known values */),
        // The ACCOUNT strip's own fetch, on the SAME refresh cycle and under the SAME
        // catch-and-degrade convention as every sibling above: a failure here leaves the strip
        // showing its last-known values (or "…" pre-first-success) and never breaks the refresh.
        getJson("/v1/account-usage").catch(() => null /* keep the strip's last-known values */),
        // Routing is a daemon-written projection. A read failure is isolated from every sibling
        // panel and leaves the last decision visible rather than inventing fresh headroom.
        getJson("/v1/provider-routing").catch(() => ({
          version: 1,
          state: "unknown",
          freshness: "unknown",
          reason: "unreadable",
        })),
        // W1-T315: the Plan tab's one fetch -- same catch-and-degrade convention as every
        // sibling above; a failure here leaves the tab showing its last-known values (or "…"
        // pre-first-success) and never breaks the rest of the refresh.
        getJson("/v1/plan/view").catch(() => null /* keep the Plan tab's last-known values */),
        // W1-T2660: the self-measurement panel's own fetch -- same catch-and-degrade convention
        // as every sibling above; a failure here leaves the panel showing its last-known values
        // (or empty pre-first-success) and never breaks the rest of the refresh. A SUCCESSFUL
        // fetch that reads status "unreadable" is NOT caught here -- it is a real response
        // renderSelfMeasurement itself renders as unreadable (see that function's own doc).
        getJson("/v1/self-measurement").catch(() => null /* fetch failed -- panel keeps its last-known rows */),
      ]);
      latestFeedbackEntries = feedbackSnap.entries ?? [];
      latestInboxDigests = digestSnap ?? { entries: [], omitted: 0 };
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
      if (providerRouting) {
        latestProviderRouting = providerRouting;
        renderProviderRouting(providerRouting);
        renderProviderPolicyControl(providerRouting);
      }
      if (planView) {
        latestPlanView = planView;
        renderPlanView(planView);
      }
      // W1-T2902: NO `if (selfMeasurement)` GUARD. `renderSelfMeasurement`'s own `!v` arm exists
      // for exactly this value -- the null `refreshAll` degrades an unreachable probe to -- and a
      // guard here made that arm unreachable, so a FAILED fetch silently left the panel showing
      // its last good rows. That is the one reading the W1-T119 distinction this panel prevents:
      // "the ledger union could not be read" rendered as "the fleet has never measured itself".
      // Pre-existing on main (the guard moved in verbatim with the extraction); the extraction is
      // what made it visible, since diff-coverage named the unreachable arm as uncovered.
      renderSelfMeasurement(selfMeasurement);
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
      document.getElementById("top-status").textContent = `updated ${formatTimestamp(statusSnap.generated_at ?? new Date().toISOString())}`;
      document.getElementById("top-status").dataset.pollState = "ok";
      clearStale(); // a completed live refresh always supersedes whatever the cache/failure-escalation painted

      writeSnapshotCache({
        generated_at: statusSnap.generated_at,
        tasks,
        spend: latestSpend,
        blockedPrs: latestBlockedPrs,
        blockedPrsUnverifiedReason: latestBlockedPrsUnverifiedReason,
        mergeHeld: latestMergeHeld,
        prQueue: latestPrQueue,
        recentEntries: latestRecentEntries,
        upNextCards: latestUpNextCards,
        feedbackEntries: latestFeedbackEntries,
        inboxDigests: latestInboxDigests,
        inboxReady: latestInboxReady,
        inboxDrafting: latestInboxDrafting,
        controlStatus,
      });
    } catch (e) {
      // the recorded escalation path (pollFailures/stale-banner state), not a silent drop
      handlePollFailure();
    }
  }

  // ── W1-T156 DELTA-DRIVEN SSE: consume GET /v1/status/stream via `fetch`, NOT the browser's
  // native EventSource -- EventSource cannot set an Authorization header, and this stream is
  // bearer-scoped exactly like every other /v1/* route (no query-token fallback; service.ts's
  // header only). Mirrors packages/api-client's own `subscribeStatus` byte-stream SSE parser
  // (the SAME `event:`/`data:` framing service.ts's openSse sends) rather than re-implementing
  // a second parser — this shell has no bundler to import that package from, so the same
  // technique is inlined here. Auto-reconnects with a short backoff on drop, and reports its
  // OWN connection lifecycle via `onState` ("connecting" | "connected" | "disconnected") so the
  // console can say so — never silently keep claiming "live" once the stream is gone. */

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
        // connection failed before it opened -- report it through the SAME onState lifecycle a
        // dropped stream reports through, never a silent drop.
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
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
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

  // W1-T222 DEEP-LINK: `?task=<id>` opens with that row expanded and scrolled into view,
  // replacing the bottom-panel anchor W1-T158 used as this console's addressable-single-task
  // target. Called explicitly from paintSnapshot/refreshAll/the SSE tick (every point that paints
  // FULL side-data: recent/up-next/feedback) -- deliberately NOT from refreshAll's own first,
  // status-only paintFromTasksById() pass, whose RECENT/UP NEXT lists are still empty: a task
  // that legitimately lives in one of those would be judged "not found yet" and force-surfaced
  // into "everything else" by focusAndExpandTask's own fallback instead, deep-linking the WRONG
  // <li> (a distinct node for the same task, in the wrong section). `deepLinkApplied` fires this
  // AT MOST once per page load: after that, the operator's own clicks own the expand/collapse
  // state.
  let deepLinkApplied = false;
  // W1-T144: the digest push (lib/digest.ts's consoleCardUrl) deep-links each escalation/
  // rundown line as `<base>/#task=<id>` — a HASH fragment, never sent to the server, so it
  // layers on the operator's already-token-bearing bookmarked URL. Read the SAME id the
  // `?task=` path reads: the hash wins when present (the fresh click), else the query param
  // (a bookmarked open-to-this-card URL). Percent-decoded to match consoleCardUrl's
  // encodeURIComponent. An id that matches no row is left to focusAndExpandTask, which
  // returns false and expands NOTHING (criterion 2's planted-probe rejection).
  function deepLinkTaskId() {
    const hash = window.location.hash || "";
    const m = hash.match(/^#task=(.+)$/);
    if (m) {
      try { return decodeURIComponent(m[1]); } catch { return m[1]; /* malformed percent-encoding -- use the raw hash text rather than nothing */ }
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
  );  // ⟪W1-T2902-BODY-END⟫
}

const BODY_START_MARKER = "⟪W1-T2902-BODY-START⟫";
const BODY_END_MARKER = "⟪W1-T2902-BODY-END⟫";

/**
 * `bootConsoleShellClient`'s own body, read off THIS MODULE'S SOURCE FILE ONCE at import time —
 * not `.toString()`'d off the function object (see this file's header for why: `tsx`/esbuild
 * collapses a transpiled function's whitespace on `.toString()`, and dozens of existing tests
 * regex-extract an individual function out of the rendered shell HTML by its original,
 * whitespace-preserved shape). Reading the source file directly sidesteps the transpiler
 * entirely, so what ships is byte-identical to what a human sees in this file.
 */
/**
 * Slice the browser body out of this module's own source text, between the two marker comments.
 * PURE and EXPORTED so its refusal arm is reachable from a test with ordinary input: as a bare
 * IIFE the throw could only fire in a build whose markers were already broken, i.e. never in a
 * passing tree, so `diff-coverage` named it uncovered and no in-place test could reach it.
 * A truncated or empty body shipped silently is the failure this refuses: the console would load
 * and simply stop working part-way through.
 */
export function sliceClientBody(ownSource: string): string {
  const startMarkerAt = ownSource.indexOf(BODY_START_MARKER);
  const endAt = ownSource.indexOf(BODY_END_MARKER);
  if (startMarkerAt === -1 || endAt === -1 || endAt < startMarkerAt) {
    throw new Error(
      "consoleShellClientSource: could not find bootConsoleShellClient's BODY START/END markers in " +
        "console-shell-client.ts's own source — did a marker comment get edited or removed?",
    );
  }
  // Skip past the REST of the start marker's own comment line (not just the marker token
  // itself) so the sliced body begins cleanly at its first real statement.
  const startAt = ownSource.indexOf("\n", startMarkerAt) + 1;
  return ownSource.slice(startAt, endAt);
}

const CLIENT_BODY_SOURCE: string = sliceClientBody(readFileSync(fileURLToPath(import.meta.url), "utf8"));

/**
 * `renderShellHtml`'s ONE named seam for this module (grepped by W1-T2902's own acceptance
 * criteria, exactly as `renderConsoleShellScript` is for the pure helpers). Wraps
 * {@link CLIENT_BODY_SOURCE} — `bootConsoleShellClient`'s own body, read verbatim off this
 * file — in an immediately-invoked function expression, called with the same two values
 * `renderShellHtml` used to splice into the string via `${…}`: `phaseElapsedThresholdsMs` as a
 * JSON literal, and `resolveFreshness` (lib/console-freshness.ts) as its OWN `.toString()`'d
 * source, the technique W1-T281 has always used for it (nothing greps its shape, so nothing
 * about its embedding needed to change).
 */
export function consoleShellClientSource(phaseElapsedThresholdsMs: Record<string, number>): string {
  return `(function (phaseElapsedThresholdsMs, resolveFreshness) {\n${CLIENT_BODY_SOURCE}\n})(${JSON.stringify(phaseElapsedThresholdsMs)}, ${resolveFreshness.toString()});`;
}
