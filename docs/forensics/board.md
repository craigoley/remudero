# board.ts comment forensics

The measured forensics, incidents and design arguments that were removed from `src/lib/board.ts`
when its comments were compacted to the plain-language standard.

Each section below carries the removed block VERBATIM, under a heading naming the symbol it
explained, and the code keeps a one-line `// Why:` pointer wherever the history mattered. Nothing
here was rewritten: this is the original text, so a reader chasing a bound or an incident reads
what the author of that bound actually wrote.

Line numbers are positions in `src/lib/board.ts` at the merge base of the compaction PR (94ba42c).

## File header

Removed from lines 1-26.

```
/**
 * lib/board.ts — the read-only live board's daemon-side wiring (W3-T2, MASTER-PLAN §7 WS-5a).
 *
 * Narrow v0 vertical slice (the W3-T2 "Option A" decision): ONE daemon route pair — GET
 * /v1/status (REST snapshot) and GET /v1/status/stream (SSE, one `status` event per task
 * whose derived StatusProjection changes) — built entirely on top of the EXISTING mechanism
 * (lib/service.ts's Route/SseRoute) and the EXISTING projection logic (lib/status.ts's
 * projectPlan/deriveStatus). Zero new business logic: this module only wires those two
 * together and tails state/ledger.ndjson to know WHEN to recompute.
 *
 * "A ledger state flip appears in the UI within 2s of the write" (the task's acceptance
 * bar) drives the streaming design: the stream POLLS the ledger file every
 * {@link DEFAULT_POLL_MS} (250ms, comfortably under the 2s budget) rather than relying on
 * `fs.watch`, whose native change-event semantics are not portable across platforms/CI
 * runners (a missed/coalesced event there would silently blow the 2s bar). A poll only does
 * real work (re-deriving a task's status) when the ledger has grown since the last tick, and
 * only SENDS an event when that task's projection actually differs from the last one sent —
 * a state FLIP, not merely "the ledger was touched".
 *
 * Real `rmd serve` CLI wiring (registering these routes on a live createService(...)
 * instance, with a real ghGateway) is a later task's concern — the same split W3-T1a made
 * for the generic mechanism itself (see service.ts's header: "concrete routes... are
 * registered by a later task's real `rmd serve` wiring"). This module is proven directly
 * against a real HTTP server (test/board.test.ts), exactly like test/service.test.ts proves
 * the generic mechanism, with no CLI entry point required to exercise it.
 */
```

## BoardRow

Removed from lines 53-66.

```
/**
 * One board row: a {@link StatusProjection} enriched with the two plan-`Task` fields the FIND
 * layer (W1-T157) needs but {@link StatusProjection} deliberately does not carry — `title`
 * (the search bar is over id + title) and `risk` (the risk facet) — plus `lastActivityAt`, the
 * ISO timestamp of the LAST ledger line naming this task (the `recency` sort key).
 *
 * WHY enrich HERE and not on {@link StatusProjection} itself: that interface is MIRRORED by
 * openapi/daemon.yaml's `StatusProjection` schema and consumed by src/lib/daemon.ts +
 * packages/api-client — widening it is a far larger blast radius than this one wire payload
 * needs. `title`/`risk` are a pure in-memory join off `deps.plan.byId` (already held), never a
 * new GitHub/ledger derivation. The SSE `status` stream keeps emitting the bare
 * {@link StatusProjection} (see {@link buildStatusStream}); ONLY this REST snapshot carries the
 * enrichment, and the shell backfills title/risk across subsequent SSE deltas (src/lib/serve.ts).
 */
```

## BoardRow.reviewState

Removed from lines 104-150.

```
  /**
   * W1-T914 (feedback fb-1784901239119-1be356 clause c / fb-1784919225707-0fab8b): the row's
   * OWN `remudero-review` three-state, so a PR whose review has not run stops rendering
   * identically to one that passed. Present only alongside {@link StatusProjection.prUrl} — a
   * row with no PR has no review to render.
   *
   *   "success"    — reviewed-green: the last posted `remudero-review` was a pass.
   *   "failure"    — reviewed-red: the last posted `remudero-review` was a fail.
   *   "pending"    — review-in-progress (W1-T913's detection-time post) — NEVER rendered as
   *                  "success"; that is the exact collapse this task exists to stop.
   *   "none"       — ABSENT, not merely unreviewed: no `remudero-review` status has ever posted
   *                  for this head (pre-W1-T913, or a genuinely unattended head). Per W1-T225's
   *                  ruling, absent is the WORST of the states — it renders as absent, never as
   *                  "pending" and never as green.
   *   "unreadable" — the GitHub read behind this value FAILED (rate limit, network, an
   *                  unresolvable head) — a CANNOT-READ, not a state GitHub actually reported.
   *                  Renders as unreadable (with the snapshot's own `generated_at` as its
   *                  last-known age), never silently folded into "none" or a stale green/red.
   *   "not-applicable" — (W1-T2235) the row's PR is MERGED or CLOSED: `remudero-review` watches
   *                  a check go pending -> success on a PR that is STILL OPEN, so a terminal PR's
   *                  combined status is history, not a value this feature has an opinion about.
   *                  Never a network call behind it, unlike every other value above — and never
   *                  folded into "none", which means "asked GitHub, nothing was posted": "none"
   *                  is a fact about a live PR, "not-applicable" is that the question doesn't
   *                  apply to this one.
   *
   * Bound to {@link GitHub.reviewState} (status.ts) — the SAME combined-status read
   * open-prs-rest.ts's `combinedStatusRestArgs` already documents and run-task.ts's sweep-side
   * `reviewStateFromRollup` already consumes — never a second, console-only derivation.
   */
```

## BoardSnapshot.blockedPrs

Removed from lines 180-190.

```
  /**
   * W1-T1006: THE SIXTH NEEDS-ME ROW SOURCE — a PR the sweep reconciler already disposed into a
   * non-progressing class (`blocked-fixable`/`blocked-ambiguous`/`conflicted`/`stale`), reaching
   * the console through this SAME snapshot (design (i): "one snapshot, one `generated_at`, and
   * the counts and rows can never disagree") rather than a second fetch the way NEEDS ME's
   * feedback/inbox rows arrive. Sourced VERBATIM from status-board.ts's `buildStatusBoard`
   * (its own `blockers.rows`, filtered to `kind === "blocked_pr"`) — see
   * {@link deriveBoardStatusSections} — NEVER a second derivation over the ledger; status-board.ts
   * itself is unread by this task. Always an array (`[]`, never `undefined`), so a render never
   * has to special-case "not fetched yet" — exactly like {@link tasks} above.
   */
```

## deriveBoardStatusSections

Removed from lines 277-318 (the 42-line block CLAUDE.md's own audit flagged as over the 40-line cap).

```
/**
 * W1-T1006: the sixth NEEDS-ME row source, reusing status-board.ts's `buildStatusBoard` VERBATIM
 * for the blocked-PR derivation — design (i)'s own text: "the data comes from `buildStatusBoard`'s
 * existing `blockers.rows` and NOT from a second derivation over the ledger", because
 * `status-board.ts` is READ, NOT CHANGED, by this task and none of its blockers-deriving
 * functions (`rawBlockedPrCandidates`/`deriveBlockedPrBlockers`/`deriveBlockers`) are exported —
 * `buildStatusBoard` is the only door in.
 *
 * `plan` IS DELIBERATELY OMITTED (never `deps.plan`) — this is the load-bearing choice, not an
 * oversight. `buildStatusBoard` unconditionally re-derives QUEUE HEAD/INBOX via its own INTERNAL
 * `projectPlanOnce`/`projectPlan` pass, which is a SECOND, genuinely duplicate batch of `github`
 * calls on top of the one {@link computeBoardSnapshot} already ran a few lines above — MEASURED:
 * test/board.test.ts's own cache-recompute suite counts `github.prByRef` calls as its "did a
 * real recompute happen" proxy, and passing `deps.plan` through doubled that count (2 vs the
 * expected 1) the first time this was wired, because a plan task's `pr:` field forces a
 * `prByRef` call on EVERY `projectPlan` pass. `deriveBlockers`'s `blocked_pr` class (the ONLY
 * class this board keeps, filtered below) needs no `projections` at all — only `indeterminate`
 * does — so `plan: undefined` makes `projectPlanOnce` short-circuit before touching `github` a
 * second time (see its own `if (!plan) return { unknownReason: … }` rung), while QUEUE
 * HEAD/INBOX degrade to a stated `unknownReason` this board never reads. `blockedPrs`' OWN
 * `github` calls (`deriveBlockedPrBlockers`'s per-PR-number `prByRef`, keyed off the ledger's
 * `sweep.disposed` lines, never off a task's `pr:` field) still run in full and are a genuinely
 * NEW read no earlier pass in this file makes — that cost is real and unavoidable, not a
 * duplicate of anything.
 *
 * EVERY OTHER SECTION `buildStatusBoard` computes (liveness/latches/queue head/inbox/headroom/
 * cache-hit/learnings-injection/needs-me-cost-anomaly) is irrelevant to this board and
 * deliberately starved of real IO here, so this call costs CPU only, never new file/process
 * reads beyond `blockedPrs`' own: `queryService` is an inert stub (LIVENESS is discarded),
 * `resolveOriginMainSha` is forced to `undefined` (skips a `git rev-parse` neither LATCHES' nor
 * BLOCKERS needs), `grepAnchorTrue`/`readProposalRegistry`/`readDraftCache` are inert (INBOX is
 * discarded regardless), and `readLedger` is overridden to hand back the SAME already-parsed
 * `lines` {@link computeBoardSnapshot} read above — never a second ledger file read.
 *
 * The `root`/`repoDir` strings below are never dereferenced by anything this board keeps: every
 * consumer that would use them (LATCHES' file reads, `tryLoadDefaultPlan`'s fallback for an
 * omitted `plan` — never reached since `github`/`readLedger` already resolve everything BLOCKERS
 * needs, the default `grepAnchorTrue`/`resolveOriginMainSha`) is stubbed out above or fails soft
 * to `undefined`/`[]`/`{}` on a path that cannot exist. A clearly-bogus sentinel, not `""`, so a
 * test run from a directory that happens to hold a real `state/`/`plan/` tree can never
 * accidentally pick up real files for a section this board discards anyway.
 */
```

## computeBoardSnapshot — reading the ledger once

Removed from lines 514-519.

```
  // READ THE LEDGER ONCE (W1-T184, extending W1-T187's same discipline): this function used
  // to read+parse the ledger TWICE — once inside `projectPlan` (itself already amortized to a
  // single read across every task, per that task's own header) and once more here for
  // `lastActivityByTask`. `liveRunSpend` below needs the same lines a third time. Read once and
  // hand `projectPlan` an overriding `readLedger` so its own internal amortization sees the SAME
  // already-parsed array, rather than re-reading a file that cannot have changed mid-call.
```

## isBlockedRow

Removed from lines 591-617.

```
/**
 * One STOPPED predicate, shared by the header tally and (textually mirrored) by the GLANCE strip's
 * own client-side recompute in serve.ts's `renderGlanceStrip`.
 *
 * WHY `status === "blocked"` ALONE WAS WRONG, measured. On 2026-08-03 at 02:22:47Z the live board
 * carried 318 rows, of which ZERO had `status === "blocked"` while TWO — W1-T288 and W1-T290 —
 * carried `needsHuman: true` with open escalation issues (#1161, #1158). Both were genuinely
 * stopped; neither was counted. `blocked` read 0 at the exact moment two things needed a human.
 * `status` never becomes `"blocked"` on that path: W1-T288 sat at `queued` (its dispatch circuit
 * breaker tripped) and W1-T290 at `running` (its PR was open with a failed review), because
 * `deriveStatus` sets `needsHuman` as a SEPARATE field beside `status`, never by overwriting it
 * (status.ts's two writers, at the `resolveEscalation` guard and the task-less-escalation loop).
 *
 * WHY THIS DOES NOT DOUBLE-COUNT AGAINST `needs me`. `needsHuman` is set ONLY by those two writers
 * and ONLY when `resolveEscalation` reports an OPEN escalation that no later `run.start` has
 * superseded — never for a merely slow or queued task. So the sets nest: every `needs me` row is a
 * `blocked` row, and `blocked` additionally holds plan-declared `status: "blocked"` tasks that have
 * no issue to click. `needs me` answers "what can I act on", `blocked` answers "what is stopped".
 *
 * NOT the five-state row BADGE. `statusColorKey` (serve.ts) deliberately renders a needs-human row
 * as "needs human" rather than "blocked" — one badge per row, needs-human winning. That is a
 * rendering choice about a single row and is left exactly as it is; this is a COUNT over rows, and
 * a count of stopped work legitimately spans both badges.
 */
```

## liveRunSpend

Removed from lines 636-656.

```
/**
 * LIVE ACCUMULATED SPEND/TURNS (W1-T184): sum `cost_usd`/`num_turns` over every
 * `implement.done`/`fix.done` line for `taskId` SINCE its latest `run.start` — mirroring {@link
 * deriveRunState}'s OWN reset rule (task_id + `run.start`/`verdict`, never `run_id`), not a
 * separate narrower one. A prior version of this scan required every summed line to carry the
 * SAME `run_id` as the `run.start` line — which silently dropped every cold fix-rung dispatch
 * (rmd sweep's `dispatchFix`/rmd fix's bootstrap, run-task.ts's `buildSweepEffects`): those stamp
 * their `fix.dispatch`/`fix.done` lines with the OUTER sweep/fix invocation's OWN pseudo `run_id`
 * ("SWEEP-<ts>"/"FIX-<ts>"), never the original run's — while still carrying the task's REAL
 * `task_id`, which is exactly what {@link deriveRunState} keys its own inFlight/phase scan on.
 * The result: a task correctly rendered `phase: "fix-rung"` (in flight) while its live spend
 * silently stayed frozen at the ORIGINAL run's total, invisible for the whole fix-rung duration —
 * the exact "tonight's post-merge burn was invisible on an open console" falsifier (two fix
 * rungs, ~1.24 USD/38 turns then ~1.30 USD/38 turns, ~2.54 USD/76 turns total, every line
 * present in the ledger as it happened). Deliberately narrow to those two step names (never a
 * blanket sum of every `cost_usd` field) — `budget.warning`/`verdict` lines log the RUNNING
 * TOTAL, not an incremental amount, so summing those too would double-count exactly the spend
 * `implement.done`/`fix.done` already report (verified against run-task.ts's own `log(...)` call
 * sites, not assumed). Returns undefined only when the task has no run currently in flight — the
 * phase/inFlight taxonomy above already guarantees one exists whenever this is called.
 */
```

## createBoardSnapshotCache / BoardSnapshotCache

Removed from lines 688-715.

```
/**
 * Memoized {@link computeBoardSnapshot} (W1-T184, the GET /v1/status recompute-cadence
 * criteria): a recompute (re-deriving every task's status — `projectPlan`'s O(tasks) `gh`/ledger
 * work) only happens when something the projection actually depends on has changed; an unchanged
 * input returns the SAME cached snapshot instantly, however many times `.get()` is called. This
 * is the fix for the 2026-07-20 latency outage (GET /v1/status at 58.7s/54.0s/34.5s, measured
 * with a ledger polled every {@link DEFAULT_POLL_MS} but never cached across requests). Because
 * every consumer here is synchronous (the real {@link GitHub} gateways shell `gh` via
 * `execFileSync`, which blocks Node's single event-loop thread for its whole duration), no two
 * recomputes can ever be truly concurrent — so this same memo also satisfies "N requests
 * arriving during a recompute window trigger ONE computation": by construction, every request
 * whose handler runs while the cache is still valid is a cache hit, and only ONE recompute ever
 * runs to produce the next one.
 *
 * NOT ledger-length-only, and DELIBERATELY NOT time/TTL-based either: a clock-based expiry
 * either recomputes needlessly often (a TTL short enough to catch a GitHub-only change quickly
 * defeats the whole point across a burst of poll ticks spaced at or above that TTL) or too
 * rarely (a TTL long enough to survive a poll burst misses a GitHub-only change for that whole
 * window) — and either way makes the cache's behavior a function of WALL-CLOCK TIMING, which a
 * test has no reliable way to pin down. The other material inputs are the live {@link GitHub}
 * gateway's OBSERVABLE HEALTH — `readFailed()`/`readTruncated()` — and W1-T2718's current open-PR
 * index. Any of them can change with NO new ledger line at all: the gateway can recover/fail, or
 * a PR can open, close or receive a new head before sweep records it. So the cache key is
 * `(ledger line count, gateway health, material open-index fingerprint)`: unchanged on all three
 * -> cache hit, no matter how much time passes or how many ticks land; any change -> exactly one
 * fresh recompute. Tests prove both GitHub-only cases (health recovery and an open-index change,
 * ledger untouched throughout) deterministically, with no sleep.
 */
```

## safeReadFailed

Removed from lines 720-730.

```
/**
 * `github.readFailed?.()` guarded (W1-T184 hardening): every OTHER {@link GitHub} method this
 * module calls into GitHub through is already wrapped where it matters (see
 * {@link decoratePrTitle}'s own note on why a defensive try/catch is load-bearing here, not
 * merely tidy) — this ONE call sat outside any guard, so a gateway that throws from
 * `readFailed()` itself (not merely a fail-soft null/false, the exact malformed-gateway shape
 * the RECENT feed's own throwing-gateway test already covers for `prByRef`) would blow up the
 * cache-key computation and 500 the WHOLE /v1/status request rather than degrade one field. Fails
 * CLOSED (treats an unreadable health signal as "GitHub is having a bad day") rather than open,
 * since the whole point of `readFailed()` is never to under-report an outage.
 */
```

## deriveReviewState

Removed from lines 739-757.

```
/**
 * W1-T914: the row's `reviewState` — bound to {@link GitHub.reviewState} (status.ts's
 * combined-status read), never a second derivation. Returns `undefined` for a row with no PR at
 * all (nothing to render), so the caller only ever sets {@link BoardRow.reviewState} when there
 * is something to say.
 *
 * THE THREE FAIL-SOFT CASES, KEPT DISTINCT ON PURPOSE (this task's whole point):
 *   - the gateway doesn't implement {@link GitHub.reviewState} at all (an older fixture/gateway)
 *     -> `"none"`: honestly unresolved, never a guessed pending or green.
 *   - the method itself returned a real value (INCLUDING its own `"none"` and, W1-T2235, its
 *     own `"not-applicable"` for a terminal row) -> that value, verbatim — this is the ONLY arm
 *     that can produce `"pending"`/`"success"`/`"failure"`/`"not-applicable"`.
 *   - the method returned `undefined` (its own read failed) OR THREW -> `"unreadable"` when
 *     `readFailed()` confirms GitHub is having a bad day, `"none"` otherwise (a `prUrl` this
 *     gateway simply cannot resolve a head for, e.g. it fell out of the batched index) — the
 *     SAME failure/absence split {@link safeReadFailed} already draws for the header tally, so
 *     a genuine outage never renders as "no review posted" and a merely-unresolvable PR never
 *     renders as "GitHub is down".
 */
```

## BOARD_IRRELEVANT_STEPS

Removed from lines 773-797.

```
/**
 * W1-T2919 — THE CACHE KEY WAS A LINE COUNT, SO EVERY HEARTBEAT INVALIDATED IT.
 *
 * `createBoardSnapshotCache` keyed on `(ledger line count, gateway health, open-index
 * fingerprint)`. The daemon appends `daemon.alive` on EVERY poll and the board gateway appends
 * `board_gateway.fetch_bytes` on every fetch, so each of those changed the count, invalidated the
 * snapshot, and made the next console read recompute `projectPlan` synchronously on the
 * single-threaded HTTP server. In steady state the console froze for about a second at least once
 * a minute with nothing on the board having changed — the operator experiences a "live" console as
 * periodically stalled.
 *
 * DECISION-RELEVANT IS DEFINED BY EXCLUSION, AND THAT DIRECTION IS THE WHOLE SAFETY ARGUMENT.
 * An INCLUSION list — "these steps may change a board row" — defaults a step nobody has added to
 * it yet to IRRELEVANT, so the day a new board-affecting step lands the console silently serves a
 * STALE board and nothing reddens. The exclusion below defaults a new step to relevant: the cache
 * invalidates, the projection recomputes, and the only thing lost is an optimisation. A drifting
 * enumeration is this repo's own recurring defect; this is the one arrangement of it where drift
 * costs performance instead of correctness.
 *
 * BOTH ENTRIES ARE MEASURED, NOT ASSUMED. Neither step is READ anywhere in the projection path:
 * `daemon.alive` has zero occurrences in board.ts/status.ts's projection, and every
 * `board_gateway.fetch_bytes` occurrence is a `log(...)` write or a comment about one — checked
 * against a control (`run.start`, a step that IS read, returns 43 hits across the same two files).
 * A step may only join this set on that same evidence.
 */
```

## RECAP_ACK_HEADER

Removed from lines 944-955.

```
/**
 * The request HEADER a caller sets to say "a HUMAN is looking at this response, mark it seen".
 * Absent ⇒ the request is an automatic poll and MUST NOT advance the marker.
 *
 * WHY A HEADER AND NOT `?ack=1`. A query param was this fix's first shape and it BROKE two shipped
 * first-paint tests: `test/serve.first-paint.test.ts` intercepts the poll with
 * `page.route("**' + '/v1/status")`, a Playwright glob that matches the bare path and NOT
 * `/v1/status?ack=1`, so the shell's very first fetch slipped past the interception those tests
 * exist to impose. Fourteen `/v1/status` sites across the suite are written against that same bare
 * path. A header carries the one bit without touching the URL, so the request line stays
 * byte-identical to what every existing caller, interception and hand-run `curl` already matches.
 */
```

## buildStatusRoute

Removed from lines 963-993.

```
/**
 * GET /v1/status — the board snapshot, read-scoped, memoized per {@link createBoardSnapshotCache}.
 * W1-T163: when `lastSeen` (lib/last-seen.ts) is supplied, a view also reads the calling token's
 * own recap off its CURRENT marker and folds it into the response.
 *
 * THE MARKER ADVANCES ONLY ON AN ACKNOWLEDGED VIEW, NOT ON EVERY REQUEST. W1-T163's
 * intent — "viewing the board advances the marker", so an immediate reload recaps nothing — is
 * correct and is PRESERVED: the shell sets {@link RECAP_ACK_HEADER} on exactly the one fetch per page load whose
 * recap it actually renders (its own `recapRendered` gate), so a reload still recaps nothing.
 *
 * WHAT WAS BROKEN. The advance was unconditional while the shell re-fetches this route every
 * `POLL_INTERVAL_MS` (3000ms, serve.ts). An automatic poll is indistinguishable from a human at
 * the wire, so a tab left open advanced its own marker every three seconds and its recap window
 * was permanently ~3s wide. Measured live 2026-08-03T02:22:47Z: `sinceCheckpoint`
 * 02:22:28.933Z against `generated_at` 02:22:47.152Z — an 18-second window — and `recap: []`.
 * The operator's actual use is a tab left open all evening, which is exactly the case that lost
 * every event it was built to show him.
 *
 * WHY AN OPT-IN REQUEST SIGNAL AND NOT THE ALTERNATIVES. A POST acknowledge would need WRITE scope, and the
 * operator's bookmark carries only the READ token — the one client that must be able to ack could
 * not. A second route duplicates the whole board handler and forces every existing caller to
 * choose. A client-side `document.hidden` check does not separate the two cases at all: a tab left
 * open while he is away is still visible. Advancing on `focus`/`visibilitychange` adds listeners
 * for an event a never-blurred tab never fires.
 *
 * THE DEFAULT IS DELIBERATELY "DO NOT ADVANCE". A caller that never acks accumulates recap rather
 * than losing it — too much history is a nuisance, none is the defect being fixed here.
 *
 * `lastSeen` is OPTIONAL and defaults to undefined (no recap at all) so a caller that hasn't wired
 * a store yet keeps today's exact response shape.
 */
```

## RECENT section header (GET /v1/recent)

Removed from lines 1022-1037.

```
// ── GET /v1/recent — the LEDGER-FIRST activity feed (W1-T184, W1-T153's RECENT section) ───────
//
// FIXTURE 1 (2026-07-20): RECENT used to be sourced from `computeBoardSnapshot`'s GitHub-derived
// terminal status, so a batched-gateway outage (the W1-T181 ENOBUFS incident) rendered "no
// recent outcomes yet" over a week containing ~100 merges — the ledger held every one of those
// merges the entire time. FIXTURE 2 (2026-07-20): a post-merge burn (two fix rungs, ~2.54 USD /
// 76 turns) was INVISIBLE on an open console even though every event was in the ledger as it
// happened, because RECENT only ever showed a task's FINAL state, never its per-event spend.
//
// THE FIX: RECENT is now an activity FEED over the ledger's own event classes — merges/verdicts
// (`verdict` lines), fix-rung outcomes (`fix.dispatch`/`fix.done`/`fix.exhausted`), escalations
// (`escalation.issue_opened`), and spend checkpoints (`implement.done`) — never routed through
// `deriveStatus`/`projectPlan`'s GitHub-gated precedence rungs at all. GitHub is consulted ONLY
// to DECORATE a row that already carries a PR link (the PR's title, via the SAME `prByRef` every
// other caller uses) — a failed/absent decoration marks the row `githubUnavailable`, it never
// removes it (see {@link decoratePrTitle}).
```

## OPERATOR_ACTION_STEPS

Removed from lines 1041-1068.

```
/**
 * The steps that record the daemon's RESOLUTION of an operator-initiated console action (W1-T266).
 *
 * WHY THIS SET EXISTS AT ALL. On 2026-07-31 the operator clicked Run on W1-T152, a task he had
 * credited as merged an hour earlier. The whole pipeline worked: the marker was written, the daemon
 * consumed it inside a minute, and refused it correctly — `console.kick_refused` at 11:18:10.571Z,
 * `reason: "already merged — stale kick"`. He saw NOTHING, and reported the console as broken. The
 * refusal was written to the ledger and then dropped by the `!task` guard in
 * {@link computeRecentActivity}, because the daemon stamps its OWN pseudo-id (`task_id: "DAEMON"`)
 * on every line it emits. `/v1/drain/kick` returns 200 for "marker dropped", so the POST genuinely
 * succeeded — the activity feed is the ONLY surface that can carry this.
 *
 * WHY AN ALLOWLIST RATHER THAN REMOVING THE `!task` GUARD. That guard is load-bearing. Measured
 * over the ledger unioned across all 661 rotations (4,156,857 lines spanning 411 hours):
 * `SWEEP` 600,281 lines (1,461/hour), `DAEMON` 169,860 (413/hour), `SERVE` 93,907 (228/hour).
 * DAEMON's own traffic is 71% `dispatch.indeterminate` (120,984 lines) plus board-gateway fetch
 * telemetry every 15 seconds. Dropping the guard would bury the feed.
 *
 * WHY THESE TWO STEPS AND NOTHING ELSE. Both are the daemon's answer to a click a human made, and
 * both are rare enough to cost nothing: over the same 411 hours the union holds FOUR
 * `console.kick_refused` lines in total — about 0.01/hour. `console.kick_requested` is deliberately
 * excluded: the button already shows the operator their own click through its arm-then-confirm
 * state, so echoing the request adds a row without adding information. The missing information was
 * always the RESOLUTION.
 *
 * These lines carry the real task id in `line.task` (the daemon's `log` closure owns `task_id`), so
 * {@link computeRecentActivity} reads the id from there for exactly these steps.
 */
```

## decoratePrTitle

Removed from lines 1131-1148.

```
/** GitHub DECORATION (never a gate, W1-T184's central rule): resolve `prUrl`'s title via the
 *  SAME `prByRef` every other precedence rung already calls — no new GitHub surface. A missing
 *  title (PR not found, or the gateway simply doesn't carry one) is silent (the row already
 *  renders fine ledger-only); a gateway that reports `readFailed()` marks the row explicitly,
 *  per W1-T181's marked-failure signal, so the operator sees "GitHub unreachable" rather than a
 *  row that merely looks a little sparser than usual. */
  // FAIL-SOFT BY CONSTRUCTION, not merely by convention: every real gateway's methods are
  // documented fail-soft (null on error, never a throw), but this decoration is the ONE place
  // in the codebase where a GitHub read result feeds straight into an HTTP response with no
  // caller-side derivation layer to absorb a surprise throw. A defensive try/catch here is the
  // difference between "one row degrades" and "the whole /v1/recent request 500s" — which would
  // itself reproduce the empty-RECENT fixture this task exists to fix, just via a crash instead
  // of an empty array. BOTH github calls below (`prByRef` AND `readFailed`) live inside this SAME
  // try — an earlier version only guarded `prByRef`, so a gateway that throws from `readFailed()`
  // itself (rather than merely reporting it, fail-soft) still 500'd the whole request and emptied
  // the feed, uncaught past this function's own return.
```

## boundedReason

Removed from lines 1162-1177.

```
/**
 * A refusal `reason`, bounded so ONE row cannot swallow the feed (W1-T266).
 *
 * NOT a hypothetical bound. `assertRunnable` refuses a blocked task by echoing the task's whole
 * blocked note, and the live ledger holds a real example: the `console.kick_refused` for W1-T201
 * at 2026-07-31T11:31:40.551Z carries a reason of roughly four thousand characters — the entire
 * FILED diagnosis, prior proof text and falsifiers. Rendered inline that is not an activity row,
 * it is a wall, and the trap this feature has to avoid is a feed the operator stops reading.
 *
 * Truncation is VISIBLE (a trailing ellipsis), never silent: a reason that has been cut must not
 * read as a reason that was short.
 */
```

## buildStatusStream — live spend over SSE

Removed from lines 1331-1338.

```
      // LIVE SPEND/TURNS OVER SSE (W1-T184 fix): the SSE payload used to be a bare
      // `deriveStatus(task, deps)` — never carrying `liveSpendUsd`/`liveTurns` at all, even
      // though this is the client's PRIMARY low-latency transport (the REST poll is a 3s
      // fallback/resync). Worse, the client's `ingestProjection` spreads each incoming SSE
      // payload over the previously-known row, so an SSE flip with no spend fields silently
      // WIPED whatever spend the last REST poll had shown — the "tonight's burn was invisible"
      // fixture reproduced by the fix rung's OWN status-changing ledger lines. Enrich the SAME
      // way `computeBoardSnapshot` does, off the SAME already-read `lines` this tick already has.
```
