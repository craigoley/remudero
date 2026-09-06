# panel-graph.ts comment forensics

The measured forensics, incidents and design arguments that were removed from
`src/lib/panel-graph.ts` when its comments were compacted to the plain-language standard
(docs/comment-standard.md).

Each section below carries the removed block verbatim, under a heading naming the symbol it
explained, and the code keeps a one-line `Why:` pointer wherever the history mattered. Nothing
here was rewritten: this is the original text, so a reader chasing an incident or a design
argument reads what the author actually wrote.

Line numbers are positions in `src/lib/panel-graph.ts` at the merge base of the compaction PR.

## File header — the module's own doctrine

Removed from lines 1-62.

```
/**
 * lib/panel-graph.ts — the control panel's plan→task→PR graph + INTERACTIVE plan adjustment
 * (W3-T6, MASTER-PLAN §7B).
 *
 * §7B: "the panel renders the traceability graph (W1-T43) and becomes the interactive front
 * door: submit feedback (origin=ui), answer grills, accept or reject proposals... — all through
 * the api-client (§7A), the daemon still the sole writer." Built the SAME way lib/panel-actions.ts
 * (W3-T5) built the fleet-control write side: a thin Route layer over EXISTING mechanism —
 * lib/feedback.ts's inbox (capture/list/setFeedbackStatus) and lib/trace.ts's pure chain
 * builder/renderer (W1-T43, `rmd trace`) — plus the SAME `panel.*` ledger-attribution primitive
 * W3-T5 introduced (`appendPanelLedger`, exported from lib/panel-actions.ts so this module never
 * re-derives it). Real `rmd serve` CLI wiring (registering these routes on a live
 * createService() instance) is later work, same split every prior W3-T* panel task's header
 * documents.
 *
 * SIX ROUTES:
 *   - GET  /v1/feedback           — the inbox list (read-scoped).
 *   - POST /v1/feedback           — submit feedback, ALWAYS origin=ui (write-scoped). See
 *     `buildSubmitFeedbackRoute`'s doc comment for how this doubles as "answer a grill". Accepts
 *     an optional, re-validated `expansion` (W1-T350) — the four-section CLAIM/EVIDENCE/RECON/
 *     FALSIFYING CHECK skeleton the console read back from the preview route below and the
 *     operator confirmed — stored alongside `raw`, never in place of it.
 *   - POST /v1/feedback/preview   — expand a draft into that same four-section skeleton WITHOUT
 *     filing anything (write-scoped: a real cheap-mount model call). See
 *     `buildPreviewFeedbackRoute`'s doc comment for the fail-open contract.
 *   - GET  /v1/trace              — the plan→task→PR provenance graph for one id, task or
 *     feedback (read-scoped). Mirrors `rmd trace <id>`'s own two-entry-point resolution
 *     (run-task.ts's `traceCommand`) exactly, over the SAME lib/trace.ts primitives.
 *   - POST /v1/feedback/decision  — accept or reject a `proposed` entry (write-scoped).
 *   - GET  /v1/drain/preview      — the would-drain queue as ordered task cards (W1-T140,
 *     read-scoped). Reloads the plan fresh (same "never stale" discipline as `/v1/trace`),
 *     re-derives merged status from GitHub via the SAME `projectPlan`/`DeriveDeps` board.ts's
 *     `GET /v1/status` route already uses (zero new derivation logic), and renders
 *     `drain.ts`'s `buildDrainPreview` — the SAME builder `rmd drain --dry-run` will grow to
 *     share, never a second preview implementation.
 *
 * ANSWERING A GRILL (v1 scope). The actual interactive grill DELIVERY mechanism (AskUserQuestion
 * / a needs-human issue, reusing §4's escalation machinery) is explicitly OUT of this task's
 * depends_on — lib/triage.ts's own header says so: "the actual grill mechanics... are W1-T42's
 * job, not this task's." W1-T42 is not built yet, and a `grilling` feedback entry today persists
 * no queryable "open question" field for a client to render (the triage worker's question only
 * ever lands in a commit message, lib/triage.ts's `triageCommitMessage`). Rather than invent a
 * second, parallel answer-delivery primitive ahead of W1-T42 (a widened blast radius this task's
 * acceptance bar does not ask for — it tests feedback→proposal→PR and accept/reject, not grill
 * delivery), this module treats a grill ANSWER as what it already is per §7B's own framing:
 * "FEEDBACK IS AN ARTIFACT" — `POST /v1/feedback`'s optional `replyTo` field captures the
 * operator's answer as a FRESH feedback entry (still origin=ui), prefixed so its provenance back
 * to the parked entry is legible to the next triage pass, and re-enters the SAME capture → triage
 * pipeline every other feedback item does. `replyTo` is validated against a REAL `grilling`
 * entry (404/400 otherwise) so it can only ever be used to answer something actually parked.
 * W1-T2278: the edge is now durable structure, not only prose — the reply carries `reply_to` as
 * a field, and the SAME handler call advances the target from `grilling` to `answered` with
 * `answered_by` naming the reply, so the thread is enumerable from either end and a second
 * `replyTo` at the same target is refused for real (see `buildSubmitFeedbackRoute`'s own doc).
 *
 * RE-PRIORITIZE (design doc, not acceptance bar). MASTER-PLAN §7B's design prose also names
 * "re-prioritize" as a future panel action. plan/tasks.yaml carries NO priority/ordering field
 * anywhere in the codebase today (lib/plan.ts's `Task` has none) — adding one is a plan-schema
 * change with its own blast radius (the linter, the drain's dispatch order, the task doc), not a
 * one-route add-on to this module. Out of scope here, same as this task's other explicitly-
 * deferred siblings (lib/triage.ts's grill mechanics, lib/board.ts's un-rendered design panels).
 */
```

## PanelGraphDeps — per-field design rationale

Removed from lines 144-211 (interior comments of the `PanelGraphDeps` interface).

```
  /** Repo root — where plan/feedback/ lives (lib/feedback.ts's `feedbackDir`). */
  root: string;
  /**
   * `plan/tasks.yaml`'s path. Unlike lib/board.ts's `BoardDeps` (a `Plan` snapshot the caller
   * refreshes on its own schedule), GET /v1/trace reloads this fresh on EVERY request — it must
   * see tasks a `rmd triage` proposal PR merges into plan/tasks.yaml after the daemon boots,
   * exactly like `rmd trace`'s own CLI path (run-task.ts's `traceCommand`) does with its own
   * `loadPlan` call.
   */
  planPath: string;
  ledgerPath: string;
  /** GitHub PR lookups the trace chain needs (lib/trace.ts's `TraceGithub`) — injected so tests never touch the network, same split every other `github`-shaped dep in this codebase follows. */
  github: TraceGithub;
  /**
   * The status-derivation GitHub gateway (status.ts's `GitHub`, DIFFERENT from
   * `github`/`TraceGithub` above — verified from source, not assumed: `projectPlan`'s
   * `DeriveDeps` needs `prByRef`/`findMergedByTrailer`/`headRefName`/`prBody`, a
   * distinct shape from `TraceGithub`'s single `prView`). Backs GET /v1/drain/preview's
   * merged-set derivation — the SAME projection board.ts's GET /v1/status already uses.
   */
  statusGithub: GitHub;
  /**
   * config.root — where `state/inbox-proposals.json` + `state/inbox-drafts.json` live
   * (W1-T110's ACTIVE-proposal registry + draft cache, `rmd inbox`'s own paths, run-task.ts's
   * `inboxCommand`). This is `config.root`, NOT `root` above (`root` is the REPO checkout
   * plan/feedback/ lives under) — the SAME config-vs-repo split lib/serve.ts's own header
   * documents for `fleetControlRoot`/`questionsRoot`; `rmd serve` wires this to the SAME
   * `fleetControlRoot` it already resolves as config.root.
   */
  inboxRoot: string;
  /**
   * W1-T193: the gateway POST /v1/inbox/approve and POST /v1/inbox/reframe hand off to —
   * see {@link RatifyCliGateway}'s own doc for why this is a detached CLI spawn rather than a
   * synchronous re-implementation of `rmd approve`'s git/gh side effects.
   */
  ratify: RatifyCliGateway;
  /**
   * Best-effort git-land the status flip POST /v1/feedback/decision just wrote, right after
   * `setFeedbackStatus` writes it (W1-T191, write site 2) — WITHOUT this, an operator's
   * accept/reject click leaves a tracked modification in `root`, the SAME checkout the daemon
   * runs from, which is exactly what makes `checkCliFreshness` refuse every non-exempt `rmd`
   * verb once that checkout also falls behind origin/main. Omitted (undefined, the default) in
   * a test that isn't exercising this — no git ever runs, so existing coverage of this route
   * is unaffected. Real callers (`rmd serve`) always pass `{}` so the real `landFeedback`
   * bridge fires with real git/gh.
   */
  feedbackLand?: LandFeedbackOpts;
  /**
   * W1-T350: the feedback-expansion rung POST /v1/feedback/preview calls — {@link
   * FeedbackExpanderDeps.expand} injected directly (not the whole deps object, so a test wires
   * a bare function like every other injected judge in this codebase). `undefined` (no
   * production caller wires a real one yet — see feedback.ts's `realFeedbackExpander` doc for
   * why) makes the preview route resolve `{ expansion: null }` unconditionally — the SAME
   * fail-open degrade an expander throw/invalid-response produces, so "unconfigured" and
   * "outage" read identically to the console.
   */
  expandFeedback?: FeedbackExpanderDeps["expand"];
  /**
   * W1-T364: injectable `Policy` for POST /v1/policy/daily-cost-ceiling(/clear) — the SAME
   * `deps.policy ??` seam `account-usage.ts`'s `AccountUsageDeps.policy` and run-task.ts's
   * `dailyCostCeilingReloader` already offer (test/config-reader-seams.test.ts's structural
   * lock), so a test supplies a fixture `Policy` (e.g. a tightened `sweep.dailyCostCeilingUsd`
   * bound) without touching the installed `plan/policy.yaml`. Defaults to
   * {@link import("./policy.js").loadDefaultPolicy} when omitted — the SAME memoized load
   * `buildAccountUsageRoute` defaults to, so the console's read and write surfaces never disagree
   * about the committed bound within one `rmd serve` process.
   */
  policy?: Policy;
```

## ReconciledFeedbackEntry and reconcileFeedbackEntries

Removed from lines 216-267.

```
/**
 * A reconciled {@link FeedbackEntry} as GET /v1/feedback returns it — `unverified` is a READ-TIME
 * decoration only (never written to `plan/feedback/<id>.yaml`), so the on-disk schema stays exactly
 * the §7B shape. `discharged`/`dischargeUndecidable` (W1-T1257) are `unverified`'s twin: sparse,
 * read-time-only flags — present only when true, absent (never `false`) otherwise — layered by
 * {@link decorateFeedbackDischarge} AFTER this reconcile, never in place of it. Both `unverified`
 * and a discharge flag can be true on the SAME entry at once (an unreadable proposal-merge state
 * says nothing about whether its filed tasks separately merged); neither ever changes `status`.
 */
export type ReconciledFeedbackEntry = FeedbackEntry & {
  unverified?: true;
  discharged?: true;
  dischargeUndecidable?: true;
};

/**
 * W1-T257: MERGING THE PROPOSAL PR IS THE DECISION. A `proposed` entry whose `proposal_pr` has
 * MERGED already got its operator decision the moment the gate landed it — a second manual
 * Accept adds nothing, so this reconciles it to the EXISTING terminal status `accepted` (never a
 * new enum member) rather than leaving it to render forever in NEEDS ME's Accept/Reject queue
 * (serve.ts's `renderNeedsMe`/`needsMeProposedHtml`, which key off `status === "proposed"` alone).
 *
 * Runs on every GET /v1/feedback read (the SAME read that feeds NEEDS ME), so it is idempotent
 * and self-healing for entries ALREADY stuck on disk — no separate sweep/backfill needed. Every
 * lookup goes through the injected, already-batched `statusGithub` (status.ts's `GitHub`, the SAME
 * gateway GET /v1/drain/preview's merged-set derivation uses) — one shared `gh pr list` fetch
 * backs every entry checked here, never a fetch per row.
 *
 * - No `proposal_pr` (null/unset) — never queried, entry passes through untouched (stays
 *   `proposed`, the acceptance falsifier: a live decision must never be swept off the board).
 * - `proposal_pr` resolves MERGED — persisted to `accepted` via `lib/feedback.ts`'s
 *   `setFeedbackStatus` (the sole writer), reflected in the returned copy.
 * - `proposal_pr` resolves OPEN or CLOSED (not merged) — stays `proposed` untouched; a
 *   CLOSED-unmerged proposal is a separate rejected/abandoned call, not this task's concern.
 * - `proposal_pr` resolves to nothing AND the read itself genuinely FAILED
 *   (`statusGithub.readFailed?.()`) — stays `proposed`, decorated `unverified: true` (fail-safe,
 *   inverse of W1-T182's merged-count direction: hiding a possibly-live decision is worse than
 *   showing a resolved one).
 */
export function reconcileFeedbackEntries(
  root: string,
  entries: FeedbackEntry[],
  statusGithub: GitHub,
  // W1-T191 SITE 3 (impl-EP). #966 wired the bridge at the DECISION route only; this reconcile path
  // was 208 lines above it in the same file and kept taking `setFeedbackStatus`'s raw-write branch
  // straight into the daemon's own checkout. It fires whenever a proposal PR merges, inside the
  // long-lived `rmd serve` process — which is how `plan/feedback/fb-…5ac4ca.yaml` came to sit
  // modified 63 seconds after PR #1058 merged, and how 107 deploys were aborted on a dirty tree.
  //
  // OPTIONAL, and absent means UNCHANGED. Every caller that passes a WORKTREE root
  // (`run-task.ts`'s triage lane, twice) legitimately wants the local write and must keep it, so the
  // option is passed at the site that needs it rather than flipped as a default.
  land?: LandFeedbackOpts,
): ReconciledFeedbackEntry[] {
```

## decorateFeedbackDischarge

Removed from lines 279-288.

```
/**
 * W1-T1257: layer `discharged`/`dischargeUndecidable` onto every ALREADY-{@link
 * reconcileFeedbackEntries}'d entry — see lib/trace.ts's `feedbackDischargeState` for the
 * three-valued predicate this reads off (its own `not_discharged` arm needs no flag: absence
 * IS "not discharged", the same sparse-boolean shape `unverified` already uses). Reloads no PRs
 * of its own: `plan` is the SAME fresh-loaded snapshot this route already reads, and `statusGithub`
 * is the SAME batched gateway `reconcileFeedbackEntries`/`GET /v1/drain/preview` already share —
 * `findMergedByTrailer`/`findMergedByHeadBranch` resolve off that one fetch, never a second one.
 * A discharged entry's `status:` byte is untouched — this never calls `setFeedbackStatus`.
 */
```

## validateSubmitFeedback

Removed from lines 343-361.

```
/**
 * `attachments`, if present, must be http(s) LINKS only — never a local file path. A path typed
 * into a browser form field would resolve against the DAEMON's filesystem (lib/feedback.ts's
 * `resolveAttachments`), not the operator's own machine, which is confusing at best and a path-
 * disclosure/read hazard at worst for a network-facing route. FAIL LOUD before any capture.
 *
 * `expansion`, if present, is the four-section {@link FeedbackExpansion} the console read back
 * from POST /v1/feedback/preview and the operator CONFIRMED (W1-T350) — re-validated here
 * rather than trusted verbatim (the same "never trust a value read back off the wire" posture
 * every other body field on this route already gets), so a malformed/tampered expansion is
 * rejected loud rather than silently stored. Omitting it entirely is the file-raw escape (design
 * (iv)): the entry captures exactly as it did before this task.
 *
 * `submissionKey`, if present, is the per-submission key the console mints once per submit
 * action (W1-T2302) — an opaque string, never re-validated against any shape beyond
 * "non-empty" (unlike `expansion`, this one carries no structure to check: its only job is to
 * be comparable). Omitting it is every caller that predates this task: always a fresh capture,
 * exactly today's behavior.
 */
```

## buildSubmitFeedbackRoute

Removed from lines 400-434.

```
/**
 * POST /v1/feedback — write-scoped. Captures a new `plan/feedback/<id>.yaml` entry with
 * `origin: ui` ALWAYS (never taken from the request body — the panel is the one caller this
 * route serves, and the whole point of the acceptance bar is that a panel submission is
 * distinguishable from a `cli`/`issue` one). Ledgers `panel.feedback_submitted`.
 *
 * `replyTo`, when given, must name an existing entry parked `grilling` (404/400 otherwise) —
 * this is "answer a grill" v1 (see this module's header for why): the answer is captured as a
 * FRESH feedback entry, prefixed with a human-readable back-reference so the next triage pass
 * can see what it's answering, and re-enters the same capture → triage pipeline every other
 * feedback item does.
 *
 * W1-T2278: THE EDGE IS NOW DURABLE ON BOTH ENDS, not only inside the reply's own `raw` prose.
 * The new entry carries `reply_to: <target id>` as a field (`captureFeedback`'s `replyTo` opt),
 * and — in the SAME handler, after that capture succeeds — the target itself is advanced from
 * `grilling` to `answered` with `answered_by: <this entry's id>` (`setFeedbackStatus`'s new
 * `answeredBy` opt), so a thread is walkable from either end: forward via the answer's
 * `reply_to`, backward via the question's `answered_by`. This transition is caused ONLY by an
 * operator's own reply text landing here — never a scheduler, never a timer (W1-T2244 pins
 * (ix)/(x)) — and it is the ONLY code path in the tree that ever writes `status: "answered"`.
 * Once a target is `answered`, a second `replyTo` naming it is refused by the SAME
 * not-parked-at-`grilling` check just below, now naming the real terminal state instead of a
 * `grilling` that never moved.
 *
 * W1-T2302: `submissionKey`, when present, is checked FIRST, before anything else runs — a
 * repeat POST carrying a key that already filed answers immediately with the entry that filing
 * already produced (200, `entry` unchanged) and does NOTHING else: no `replyTo` re-validation,
 * no second {@link captureFeedback} write, no second `setFeedbackStatus` reply-target
 * transition, no second `panel.feedback_submitted` ledger line. This is deliberately a route-
 * level check (not left to `captureFeedback`'s own never-clobber guard alone): the reply-target
 * transition and the ledger line are THIS route's own side effects, and a recognised repeat must
 * skip both, not merely avoid re-writing the entry file (design point (v) — a recognised repeat
 * must never re-attempt a transition the target's own refusal would otherwise turn into an
 * operator-visible error).
 */
```

## buildPreviewFeedbackRoute

Removed from lines 511-528.

```
/**
 * POST /v1/feedback/preview — write-scoped (a real cheap-mount model call, operator-initiated,
 * never a passive read): runs the feedback-expansion rung (feedback.ts's `expandFeedbackDraft`)
 * over the operator's DRAFT and returns the four-section {@link FeedbackExpansion} it produced.
 * FILES NOTHING — no `plan/feedback/<id>.yaml`, no ledger line, no status transition; this is
 * the PREVIEW SEAM the console's arm-then-confirm read-back shows before POST /v1/feedback ever
 * runs (this task's design (i)/(ii)).
 *
 * `replyTo`, when present, is validated the SAME way POST /v1/feedback validates it (must name a
 * real `grilling` entry) so a preview can never arm a Confirm that the eventual submission would
 * then reject.
 *
 * FAIL-OPEN, every direction: `deps.expandFeedback` left unset (no production caller wires a
 * real one yet), a rung that throws or times out, or a response {@link validateFeedbackExpansion}
 * rejects, all resolve `{ expansion: null }` with a 200 — NEVER a 5xx. The console's own
 * fallback on `expansion: null` is to file the plain submission unchanged (this task's stated
 * failure mode), and it can only do that if this route never errors on an expander outage.
 */
```

## GET /v1/plan/view — the section design header

Removed from lines 724-746.

```
// ── GET /v1/plan/view — progress (done/in-flight/queued) + frontier (W1-T315) ─────────────────
//
// PROGRESS is derived from projectPlan's SAME GitHub-derived projection GET /v1/drain/preview
// (just above) and GET /v1/status already use — a task whose yaml `status:` still says
// `queued` while its PR is merged counts as DONE here, never off that decorative field
// (W1-T280's own harvest: W1-T279 read `queued`/`attempts: 0` while PR #1062 had already
// merged). A gateway that could not be read (`github.readFailed()`) never renders a zero: the
// LAST successfully-observed reading rides forward from an in-memory cache, stamped UNKNOWN
// with the age it was last true (W1-T262's "unknown, never zero" rule) — resolved through the
// ONE `projectPlan()` call the route below makes for the whole plan, never a second per-task
// read (see `computePlanProgress`'s own doc for why it cannot become one, however it's called).
//
// FRONTIER binds drain.ts's OWN `runnableCandidates` (the exact selector the dispatcher itself
// calls) rather than re-deriving file-order/eligibility here — a board that computed its own
// order could disagree with the daemon, and a frontier that disagrees with what runs next is
// worse than none. Every row states a reason DERIVED from the same predicate that classified
// it (file-order head / a NAMED unmet dependency / the streak breaker's own reset condition) —
// never a hand-written blurb that can drift. A held task renders AS held, with its reason,
// rather than being silently omitted (design: "NOT-RUNNABLE IS INFORMATION, NOT ABSENCE").
//
// OUT OF SCOPE, OWNED ELSEWHERE (this task's own design): live run rows / daemon / deploy state
// (the Now tab, status-board.ts) and any write action on a frontier row (W1-T260's Run button)
// — this view only ever RENDERS, never dispatches.
```

## PlanProgress, PlanProgressCache and computePlanProgress

Removed from lines 750-800 (interior field comments and the two function/type docs).

```
  /**
   * Present unless this is the FIRST-EVER reading and it happened to land during an outage
   * (nothing to fall back on yet) — sparse, the same "absent means unknown, never a fabricated
   * 0" convention every other darkness-fallback field in this codebase (status.ts's
   * `githubUnobservableSince`) already follows.
   */
  done?: number;
  inFlight?: number;
  queued?: number;
  total?: number;
  /**
   * True when THIS reading is a carried-forward last-known value because the GitHub gateway
   * could not be read this cycle — `unavailableReason` names why, `asOf` names when the
   * numbers were last actually true.
   */
  unknown: boolean;
  /**
   * ISO-8601 timestamp the counts are current as of — the fresh derivation time when `unknown`
   * is false, or the LAST successful derivation's own timestamp when `unknown` is true, so a
   * caller can render "last known Ns ago" rather than an age-less number.
   */
  asOf?: string;
  unavailableReason?: string;

/**
 * The single {@link PlanProgress} reading a caller last SUCCESSFULLY observed — a long-lived
 * server's in-memory snapshot, the aggregate-level counterpart to status.ts's
 * `DeriveDeps.previousProjection` (which carries the same "last known, under darkness" fact
 * per task). One instance per `rmd serve` process lifetime, created once by the route builder
 * and closed over by its handler — never persisted to disk: a process restart starting with no
 * last-known reading (falling back to `unknown` with no numbers at all) is the same fail-soft
 * direction every other in-memory-only cache in this codebase already takes (status.ts's
 * `DispatchBreakerCache`).
 */

/**
 * Compute {@link PlanProgress} from an ALREADY-DERIVED projection (the caller's ONE
 * `projectPlan()` call — see this section's header) — this function itself makes NO GitHub
 * call beyond consulting `github.readFailed()`/`readFailureReason()`, so it cannot become a
 * second per-task fetch path however it is called, satisfying "the counts resolve through ONE
 * batched call rather than one per task" by construction rather than by convention.
 */
```

## FrontierReasonKind, FrontierRow, frontierFilterReason and buildPlanFrontier

Removed from lines 828-925 (interface/type docs plus the two function docs and their inline
comments).

```
/** Why a frontier row is where it is — the shapes acceptance names (file-order head / a named
 *  unmet dependency / a named blocker with breaker ETA) plus the one further NOT-RUNNABLE hold
 *  the design's own prose names (a `blocked` task) — never a hand-written catch-all beyond these
 *  four. `"verify-human"` remains a member of this type (nothing new to classify — {@link
 *  frontierFilterReason} already told them apart) but never reaches a {@link FrontierRow}:
 *  `verify:human` tasks are PERMANENTLY parked, not temporarily held, so they are excluded from
 *  the frontier entirely rather than rendered — see {@link buildPlanFrontier}'s own doc. */

  /** Machine-derived, built from the SAME fact that classified this row — never a hand-written
   *  blurb that can drift from it (see this section's header). */

/**
 * Reason text for a task {@link runnableCandidates} declined via one of the four named {@link
 * DispatchFilterReason}s — `undefined` for `"already-merged"` AND for `"verify-not-auto"`, both
 * excluded from the frontier entirely by the caller. A DONE task is not part of "what's next" (it
 * is `PlanProgress.done`); a `verify:human` task is PERMANENTLY parked — it never becomes
 * runnable on its own, an operator must act on it directly, and it already renders under `need
 * you (verify != auto)` in the pinned header (idle-reasons-panel.ts) — so keeping it here too is
 * duplication with a worse label, and it is deliberately never routed through the needs-me/
 * escalation arc either (daemon.ts, auto-triage.ts exclude it from idle escalation for the same
 * reason: "permanently needs a human, waiting never helps"). `unmetDependencies` is re-consulted
 * here (a pure DAG walk, never a GitHub read) to NAME which id(s) — the same primitive
 * `isDispatchEligible` itself already called to produce this exact verdict, so this only
 * re-derives WHICH ids it would name, never the verdict itself.
 */

  // W1-T2675: SKIPPED, NOT GUESSED AT — this function's only caller already documents exactly this
  // case ("A task neither eligible nor named by one of the remaining filter reasons (e.g. in-flight
  // under an open PR, or an indeterminate GitHub read) is Now-tab territory ... and is skipped here,
  // never guessed at"). Without this arm the reason falls through to the trailing "unmet-deps" catch-
  // all below and renders as `blocked on unmet dependencies: (none resolved)` — a sentence that is
  // false in both halves, and the W1-T2636 defect shape repeated on a new member.

/**
 * The next `limit` frontier rows in the SAME order the dispatcher would actually take them:
 * binds `runnableCandidates` (drain.ts) for BOTH the ordering and the eligibility verdict —
 * this function never re-derives either. A row that IS the next runnable candidate carries
 * `runnable: true` with a `"file-order"` reason naming its rank; a row `runnableCandidates`
 * declined for a TEMPORARY reason (`unmet-dependency`, `circuit-breaker`, `blocked`) is rendered
 * too (`runnable: false`), never omitted, with the reason the SAME eligibility chain actually
 * stopped it for (design: "NOT-RUNNABLE IS INFORMATION, NOT ABSENCE"). Two kinds are excluded
 * from the frontier's row budget entirely, never merely de-prioritised within it: DONE tasks
 * (`"already-merged"` — the frontier answers "what's next", not "what already landed", that's
 * `PlanProgress.done`) and PERMANENTLY-parked `verify:human` tasks (`"verify-not-auto"` — they
 * never become runnable on their own, and already render, with a better label, under `need you
 * (verify != auto)` in the pinned header; see {@link frontierFilterReason}). A task neither
 * eligible nor named by one of the remaining filter reasons (e.g. in-flight under an open PR, or
 * an indeterminate GitHub read) is Now-tab territory — live run/deploy state is explicitly out of
 * THIS view's scope (this section's header) — and is skipped here, never guessed at.
 */

  // W1-T2675: APPENDED LAST so no positional caller shifts. Without it this view cannot tell a
  // task whose merge credit simply has not been read from one that genuinely has none, and would
  // render the first as an ordinary runnable candidate — inviting exactly the rebuild the dispatch
  // refusal exists to prevent. Omitted ⇒ unchanged behaviour, as before it existed.

  // A LARGE limit (never the caller's `limit`): this ONE `runnableCandidates` call must
  // classify EVERY non-merged task so the dispatchOrder walk below can find each one's verdict,
  // however many held rows sit ahead of the runnable ones the caller asked to see — ordering
  // and eligibility are never re-derived a second time for the truncated view.
```

## Per-section filed/merged counts — the section design header, and the individual symbol docs

Removed from lines 965-1090 (the section header, plus `readPlanRefs`, `classifyPlanRef`,
`resolveSectionHeading`, `PlanSectionCount`, `PlanSectionCache` and `computePlanSectionCounts`).

```
// ── Per-section filed/merged counts (W1-T376) ──────────────────────────────────────────────
//
// plan_refs IS POLYMORPHIC (design (i)): a task's plan_refs entries are one of FIVE kinds --
// section refs (`§5C`), a second section spelling (`MASTER-PLAN#5C`), task-id refs pointing at
// ANOTHER task (`W1-T325`), retro proposals (`P22`), and workstreams (`WS-7`). Only the two
// section-shaped kinds carry a heading to resolve; the other three must contribute NOTHING to a
// section's counts, or a task-id ref would fabricate a section that does not exist.
//
// plan.ts's `Task` type does NOT carry `plan_refs` (it is declarative, architect-only provenance
// metadata -- see plan.ts's own header on `origin`/`rationale`), and this task's own `files:`
// scope does not include plan.ts, so `readPlanRefs` below re-parses the SAME already-local
// tasks.yaml + tasks.d/*.yaml files {@link loadPlan} just read, pulling ONLY `id` and
// `plan_refs` -- never a new GitHub call, never a plan.ts schema change.

/** `id -> plan_refs` for every task in `planPath` (tasks.yaml + its `tasks.d/*.yaml` shards, the
 *  SAME files {@link loadPlan} reads) -- a narrow, best-effort SECOND parse of local files just
 *  for this one declarative field (see this section's header for why it cannot come from {@link
 *  Task} itself). A file that fails to read or parse is skipped, never thrown -- this is a
 *  rendering aid layered on top of the load-bearing validation {@link loadPlan} already did. */

/** Classify one `plan_refs` entry into the five kinds design note (i) documents. Only
 *  `"section"` carries a `token` -- the ref text with its `§`/`MASTER-PLAN#` prefix stripped --
 *  for {@link resolveSectionHeading} to join against plan-index.json's headings. */

/** Resolve a stripped section token ("5C", "7", "Self-improvement") to its plan-index.json
 *  heading (design (ii)). plan-index.json's headings carry the number as a TEXT PREFIX ("5C.
 *  Task pre-flight: the plan gate") with no `§` anywhere in the file, so the primary join
 *  matches the heading's own leading token -- everything before its FIRST `.` -- against the
 *  (already-stripped) ref token, EXACTLY, never a prefix match (a prefix match here would let
 *  token "5" wrongly match heading "5C. ..."). One ref is word-shaped ("§Self-improvement", no
 *  leading digit, so it has no leading-token-before-a-dot to match at all) -- the fallback is a
 *  case-insensitive heading-PREFIX match, tried only once the exact-token pass finds nothing. */

/** One MASTER-PLAN section's filed/merged breakdown -- rendered as a PAIR, never a percentage
 *  (design (iii): a percentage ranks a 1-task section above a 74-task one the moment its single
 *  task merges, inverting the truth). */

/** The last-computed {@link PlanSectionCount}s -- the per-section counterpart of {@link
 *  PlanProgressCache}, carried forward under the SAME darkness reading (design (v)): a caller
 *  passes {@link computePlanProgress}'s own `unknown` flag in rather than re-deriving it, so the
 *  sections never attempt a fresh read the whole-plan progress itself could not make. */

/**
 * Per-section filed/merged counts (W1-T376), derived from the SAME `projection` the caller
 * already resolved (never a second GitHub read) and gated by `progressUnknown` -- the SAME
 * darkness flag {@link computePlanProgress} just computed off the SAME projection, so a GitHub
 * outage renders the LAST-known section breakdown (or none, on a first-ever outage), never a
 * fabricated zero (design (v)). A task's "done" comes from `projection`, never from its own
 * decorative `status:` field (design (iv), the SAME rule {@link computePlanProgress} follows).
 * Falsifier (design (vi)): a task-id/`Pnn`/`WS-n` ref contributes to no section, and a task
 * resolving to two distinct sections increments BOTH.
 */
```

## InboxDraftedTask, InboxDraftingItem, InboxNotReadyItem and draftedTaskSummaries

Removed from lines 1180-1230.

```
/** One task the drafted fragment would file — id + title, so a READY card shows what would
 *  ACTUALLY be filed rather than an opaque proposal id (W1-T193 design: "RENDER THE DRAFT'S
 *  SUBSTANCE, not just its existence" — the operator approves a KNOWN change, never a token). */

/** One proposal currently mid-draft (W1-T193): the daemon's draft rung (W1-T192,
 *  buildInboxDraftHook) has an Architect worker running for it RIGHT NOW. `spawnedAt` is the
 *  ISO timestamp it was spawned at — a card must never render nothing during this legitimately
 *  multi-minute window (indistinguishable from broken otherwise), the same bar W1-T156 set for
 *  liveness. */

/** One NOT-READY proposal, as GET /v1/inbox renders it (W1-T2604, finding (i): "the not-ready
 *  reason is computed and not surfaced"). `reasons` is the EXACT {@link PredicateFailure}[]
 *  classifyProposal already computed — never re-derived, never summarized to a bare
 *  `"not_ready"` string — so an operator viewing the inbox itself sees WHY, without first
 *  having to attempt (and be refused by) an approve. This is deliberately a SEPARATE array from
 *  `ready`/`drafting`, never a merged/actionable card: presence here implies no affordance
 *  (no approve/reframe/decline button is implied), so surfacing it does not reintroduce the
 *  "approval fatigue" the READY-only list originally existed to cure (see this route's own
 *  doc). DEFERRED-WITH-TRIGGER proposals are deliberately still excluded here — that state
 *  names an unfired trigger, not a failing predicate, a distinct concern this finding never
 *  targeted. */

/** The drafted fragment's task ids + titles. A READY classification's fragment has ALREADY
 *  passed classifyProposal's own parse+lint checks (a fragment that failed either would have
 *  classified not_ready instead, never ready), so this re-parse is expected to always succeed
 *  — the catch is defense-in-depth (never assume two derivations of the same text agree
 *  forever), not an expected-failure path. Exported so that defense-in-depth branch is directly
 *  unit-testable — the READY path it guards against never exercises it in practice by design. */
```

## classifyAllProposals

Removed from lines 1240-1286 (the function doc and its two inline comments).

```
/**
 * Shared read + classify step every /v1/inbox* route needs (GET /v1/inbox classifies every
 * proposal to render the list; POST /v1/inbox/approve and /v1/inbox/reframe classify just the
 * one they're asked about, but need the SAME registry/draft-cache/ledger/in-flight facts to do
 * it correctly — e.g. the conflict predicate needs every OTHER open proposal id). Assembled in
 * ONE place so the write routes can never drift from what GET /v1/inbox just rendered.
 *
 * `loadPlanFn` defaults to {@link loadPlan} (the working-tree read, torn-read-guarded per
 * W1-T2220 remedy (a) — "usually not partial", the right cost for a render). The write-scoped,
 * tier-HIGH `POST /v1/inbox/approve` gate below passes {@link loadPlanAtRef} instead — remedy
 * (c), "cannot be partial" — since GET /v1/inbox and POST /v1/inbox/reframe never gate an
 * irreversible action on `classifications` the way approve does (design note (iv): splitting
 * the remedy by call site is the point, not a single mechanism for all three).
 */

  // W1-T510: absence from `projection` cannot happen for any id `classifyProposal`'s own
  // `unmetOutsideDeps` can name here — `projectPlan` derives one entry per `plan.tasks` (see
  // its own loop, lib/status.ts), the EXACT SAME `plan` this `projection` and `ctx.plan` both
  // come from, so an id genuinely absent from the plan already fails via `unmetDependencies`'s
  // `!d` branch and never reaches `isMerged`/`depsUnobservable` at all. `?? false` here is
  // therefore never an absent-as-unmerged conflation — it is dead code on a present entry.

  // W1-T190: the console must never offer the ratify affordance on a proposal the
  // ledger already carries `ratify.approved` for, even when the registry entry itself
  // still looks READY (a drifted write) — re-derived from the ledger on every request,
  // never trusted from the registry's own state.
```

## buildInboxRoute and its registry-healing write

Removed from lines 1304-1368.

```
/**
 * GET /v1/inbox — read-scoped. The ratification inbox's (W1-T110, lib/inbox.ts) READY and
 * DRAFTING tiers — the same tiering `rmd inbox` prints, computed the SAME way
 * (classifyProposal, a pure function, over the ACTIVE-proposal registry + draft cache + a real
 * ReadinessContext), but over HTTP for the shell's NEEDS ME section. DEFERRED-WITH-TRIGGER
 * proposals are deliberately never returned here (inbox.ts's whole point: only what is
 * genuinely actionable — or, since W1-T193, genuinely IN PROGRESS — is ever surfaced, "the
 * cure for approval fatigue"). NOT-READY proposals ride along too, as of W1-T2604, but in
 * their OWN `notReady` array — see {@link InboxNotReadyItem}'s own doc for why that is not the
 * same thing as re-offering them as actionable and does not reintroduce approval fatigue;
 * `ratified`/`retired`/`declined` proposals stay excluded from every array here (each already
 * has, or needs, no further screen real estate: ratified because it is already filed, retired/
 * declined because an operator or the classifier has already disposed of it).
 *
 * `rmd approve <id>` / `rmd reframe <id>` (W1-T111) and `rmd decline` (W1-T2604) are wired from
 * the card as of W1-T193/W1-T2604 — see `buildApproveProposalRoute`/`buildReframeProposalRoute`/
 * `buildDeclineProposalRoute` below — over the SAME write-token scope every other panel write
 * action uses, never a second auth story.
 */

      // W1-T190 (round 2): a proposal classified "ratified" here is DETECTED off the
      // ledger, never trusted from the registry's own (possibly drifted) copy — but
      // detection alone leaves the drifted row sitting in state/inbox-proposals.json
      // forever. Heal it on this read: prune every ledger-ratified proposal from the
      // registry file so any OTHER consumer of it (one that does not itself call
      // classifyProposal) sees the corrected state too, not just this request's in-memory
      // override. A no-op write when nothing needs healing (the common, already-clean
      // path never touches disk).
      //
      // W1-T240: this route runs inside the long-lived serve daemon, so its heal write is
      // one of FOUR independent read-modify-writers of this same file (the other three are
      // `rmd inbox`/`rmd approve`/`rmd reframe`, run-task.ts) racing it with no mutual
      // exclusion. Reapply the (already-derived, ledger-sourced) prunedIds set against a
      // FRESH read under lock — never blind-write the `proposals` array this handler read
      // at the top of the request, which a concurrent CLI writer could have changed by now
      // — see lib/inbox.ts's `updateProposalRegistry` doc for the lost-update/torn-file
      // hazard this guards against.
```

## RatifyCliGateway, ratifyCliGateway and buildApproveProposalRoute

Removed from lines 1385-1465.

```
/**
 * The real side effects `rmd approve`/`rmd reframe` (run-task.ts's `approveCommand`/
 * `reframeCommand`) drive: git clone/worktree/branch/push, `gh pr create`, a poll for CI green,
 * the remudero-review judge, and arming auto-merge — a multi-minute pipeline. Blocking an HTTP
 * response on all of that risks a request that never returns, and this codebase has no
 * existing "detached background op" pattern to build a native re-implementation on. So this
 * gateway does exactly what an operator's own terminal would do: spawns the REAL `bin/rmd
 * approve <id>` / `bin/rmd reframe <id> --feedback <text>` CLI as a detached, unref'd child
 * process — never awaited — reusing 100% of the already-tested, gate-safe CLI flow with zero
 * duplicated logic. The HTTP response below confirms only that the run was HANDED OFF, not
 * that it completed; the resulting PR (once one exists) surfaces through the console's own
 * NOW/RECENT sections via their existing ledger-driven polling, same as any other in-flight
 * run — see this module's PR body for the fuller reversibility note.
 */

/** Real {@link RatifyCliGateway}: shells out to the repo's OWN `bin/rmd`, matching exactly what
 *  `rmd approve <id>` / `rmd reframe <id> --feedback "<text>"` do from a terminal. stdout/
 *  stderr are appended to a per-call log file under `<logDir>` (there is no operator terminal
 *  watching this run) rather than discarded, so a spawn that fails loud still leaves a trace. */

/**
 * POST /v1/inbox/approve — write-scoped. The console's APPROVE affordance: re-classifies the
 * named proposal LIVE (the SAME `classifyProposal` call GET /v1/inbox just rendered from —
 * never a cached/stale verdict) and REFUSES with 409 anything not currently READY, naming why
 * ({@link refusalReason}) — "no action is offered that the backend would refuse" (acceptance
 * 6) enforced server-side, not merely by the card only rendering the button for a READY item
 * (a race between the last poll and the operator's confirm click is otherwise possible). A
 * READY proposal hands off to {@link RatifyCliGateway.approve} — see that interface's doc for
 * why this is a detached CLI spawn, never a synchronous git/gh pipeline inside this handler.
 * Ledgers `panel.proposal_approve_requested` immediately (before the spawn even resolves), so
 * the operator's action is attributed the instant it is accepted, distinct from the spawned
 * run's OWN later `ratify.approved` ledger line.
 */

      // W1-T2220: this gate is the ONE call site among classifyAllProposals's three consumers
      // that hands off to an irreversible detached spawn on `classifications`, so it alone reads
      // the plan via loadPlanAtRef (remedy (c), "cannot be partial") rather than loadPlan's
      // default stat/read/stat retry (remedy (a), "usually not partial") — see that function's
      // own doc and classifyAllProposals's.
```

## buildReframeProposalRoute

Removed from lines 1501-1510.

```
/**
 * POST /v1/inbox/reframe — write-scoped. The console's REFRAME affordance: captures the
 * operator's feedback VERBATIM (never summarized/trimmed beyond the empty-body check) and
 * hands off to {@link RatifyCliGateway.reframe}. Valid for ANY proposal currently in the
 * ACTIVE registry, WHATEVER its current classification — reframe is feedback, never a
 * ratification, and `rmd reframe` itself places no readiness precondition on it (inbox.ts's
 * own doc: "Valid for ANY proposal already in the registry, whatever its current
 * classification"). Ledgers `panel.proposal_reframe_requested` (carrying the feedback text)
 * immediately.
 */
```

## buildDeclineProposalRoute

Removed from lines 1544-1578.

```
/**
 * POST /v1/inbox/decline — write-scoped. W1-T2604: the console inbox's missing THIRD verb —
 * "the console inbox can only say yes, so every proposal it cannot ratify stays forever". Until
 * this route existed, the ONLY way a READY proposal left the registry was `rmd approve`'s own
 * one-bit contract ("valid ONLY for a currently-READY proposal"), so a proposal that is
 * self-withdrawn, refused, already satisfied on main, or a duplicate had no path out except
 * being approved into a task nobody wants.
 *
 * THIS IS AN OPERATOR ACT, NEVER AN INFERENCE. `classifyProposal` never reads a proposal's own
 * title/summary prose to decide this — that text is drafted by a worker and never ratified by
 * anyone, so a keyword rule ("WITHDRAWN" in the title) would let a worker retire its own
 * proposal by phrasing, exactly the authority boundary `rmd approve`'s design already holds.
 * The ONLY way a proposal classifies `declined` is THIS route recording it: one ledger line,
 * `panel.proposal_declined`, carrying the operator's own `reason` VERBATIM (never summarized,
 * mirroring `POST /v1/inbox/reframe`'s own "captures feedback verbatim" discipline) and the
 * panel's bearer as `origin` — the same attribution shape every other panel write uses.
 *
 * A DECLINE IS NOT A DELETE. Exactly like a `retired` classification (W1-T2451), the proposal
 * stays in `state/inbox-proposals.json` untouched — {@link pruneRatifiedProposals} only ever
 * prunes `ratified` proposals, never `declined` ones — so the registry keeps a record of the
 * finding and why it was refused, rather than growing back the P19-shaped silent-drop problem
 * a delete would reintroduce. `classifyProposal` (inbox.ts) checks the ledger's decline receipt
 * immediately after its ratified check and BEFORE every other predicate, so a declined proposal
 * can never again render ready/not_ready/deferred/drafting, no matter what its own predicates
 * would otherwise say — see that function's own doc.
 *
 * NO PLAN TASK, NO BRANCH. Unlike approve/reframe, this handler never calls
 * {@link RatifyCliGateway} at all — there is no `rmd decline` CLI to spawn, no git/gh side
 * effect of any kind, so declining can never file the very work it is refusing.
 *
 * Valid for ANY proposal currently in the ACTIVE registry that is not ALREADY ratified or
 * already declined (409 either way, naming which) — like `reframe`, a decline is not gated on
 * the proposal currently classifying READY, since a stuck not-ready duplicate is exactly as
 * much the "stays forever" defect as a stuck ready one.
 */
```

## Daily-cost-ceiling routes — the section design header

Removed from lines 1615-1637.

```
// ── POST /v1/policy/daily-cost-ceiling, POST /v1/policy/daily-cost-ceiling/clear ────────────
// W1-T364: THE OPERATOR'S OWN WRITE CONTROL over the daily-cost-ceiling override (W1-T332's
// store) — before this route existed, the ONLY writer of `state/DAILY_COST_CEILING_OVERRIDE`
// was the store's own unit test, so the value the operator most plausibly wants to move under
// pressure (it fired for the first time ever this week and stopped dispatch for ~40 minutes)
// still required a PR and a deploy, the exact thing OPERATOR RULING 2026-08-04 (policy.ts's own
// header) exists to end.
//
// GATED ON W1-T363 (now shipped, #1410, verified from source): `dailyCostCeilingReloader`
// (run-task.ts) resolves the EFFECTIVE ceiling through `resolveDailyCostCeiling` freshly on
// EVERY tick, never a cached/boot-time value, so a write through this route takes effect on the
// daemon's very next tick — no restart required. Landing this route before W1-T363 would have
// been a write surface over a value nothing enforced, the display-vs-enforcement lie this task's
// own design note names.
//
// ONE ROUTE, ONE CONTROL, THE STORE'S OWN VALIDATION (design note i): neither handler below
// duplicates `writeDailyCostCeilingOverride`'s bounds check — a `PolicyError` it throws maps
// straight to a 400 carrying its own message, never a second hand-rolled range check that could
// drift from the committed `policy.bounds["sweep.dailyCostCeilingUsd"]` row.
//
// `deps.root` (never `inboxRoot`) is the SAME `repoRoot` `dailyCostCeilingReloader` resolves
// `state/` against — the same root every other route in this module already reads/writes
// against, never a second, independently-resolved root for this one store.
```

## ledgerCeilingAudit

Removed from lines 1649-1659.

```
/**
 * Ledgers the who/from/to/effective audit trail for one console write to the daily-cost-ceiling
 * override (ledger.ts's `appendDailyCostCeilingOverrideAudit`, W1-T333's `console.
 * ceiling_override_written` step, the primitive that function's own doc names THIS route as the
 * intended caller of) — shared by the set and clear handlers below so the two routes can never
 * record it two different ways. `fromUsd` is the EFFECTIVE value immediately before this write
 * (never the raw override-file content), so a write that follows a fallback-from-malformed read
 * still records an accurate "from". `taskId: "_console"` matches the sentinel
 * test/ledger-render-retention.test.ts's own coverage of this primitive already uses; `who` is
 * the SAME `bearerTokenId` hash every other panel write route ledgers as `origin`.
 */
```
