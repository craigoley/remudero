# status-board.ts comment forensics

The measured forensics, incidents and design arguments that were removed from `src/lib/status-board.ts` when its comments were compacted to the plain-language standard.

Each section below carries the removed block VERBATIM, under a heading naming the symbol it
explained, and the code keeps a one-line `Why:` pointer wherever the history mattered. Nothing
here was rewritten: this is the original text, so a reader chasing a bound or an incident reads
what the author of that bound actually wrote.

Line numbers are positions in `src/lib/status-board.ts` at the merge base of the compaction PR.

## File header — the module's own doctrine

Removed from lines 1-43.

```
/**
 * lib/status-board.ts — `rmd status` (W1-T279 half 1 + W1-T280 half 2, MASTER-PLAN §7/§5D).
 *
 * ONE READ MODEL, TWO RENDERERS. {@link buildStatusBoard} returns a plain data object
 * ({@link StatusBoardModel}); the text renderer ({@link renderStatusBoardText}) and `--json`
 * (a bare `JSON.stringify` of the same model, run-task.ts's `statusCommand`) both project THAT
 * — no second derivation, so the console's future Now tab (fb-1784770111145-cf7c24) can never
 * disagree with the terminal (the W1-T262 one-coherent-story discipline, applied to this
 * surface).
 *
 * TWO HALVES, ONE MODEL. LIVENESS/LATCHES/LAST CYCLE (W1-T279) are LOCAL TRUTH ONLY,
 * OFFLINE-SAFE — the filesystem, the ledger, or a launchd process query injected by the
 * caller, never a blocking network call; the `origin/main` comparison is a LOCAL
 * `git rev-parse` (no `git fetch`). BLOCKERS BY CLASS/QUEUE HEAD/INBOX/HEADROOM (W1-T280) are
 * DERIVED — some still ledger/plan-local (the dispatch circuit breaker, headroom telemetry),
 * others need a live merge-state read (QUEUE HEAD's dispatch eligibility, INBOX's dep-merged
 * predicate, and — since W1-T306 — BLOCKERS' own `blocked_pr` class: a PR the ledger once
 * disposed as blocked is re-checked against live GitHub state every render, never printed on
 * the ledger's word alone), which go through the SAME batched {@link GitHub} gateway every
 * other command already reads through. GITHUB IS
 * DECORATION, NEVER A GATE (see {@link StatusBoardDeps.github}): a gateway failure — or none
 * configured at all — degrades ONLY the sections/rows that actually needed it to a stated
 * `unknownReason`, never a throw, never a silently-empty section indistinguishable from
 * "nothing to report". Where a fact cannot be resolved (a pid unreadable, `origin/main`
 * unresolvable, no `daemon.boot` line yet, no headroom telemetry yet) the model carries an
 * explicit `"unknown"` / absent field, never a zero or a healthy-looking default rendered as
 * fact (the W1-T262 honesty rule: an unknown that LOOKS healthy is exactly the ~17h
 * DEPLOY_FAILED-invisible failure this task exists to retire).
 *
 * RENDERS, NEVER SENSES. Every fact this module reports is already written down somewhere —
 * fleet-control.ts's STOP/PAUSE/QUIET_HOURS flags, deployer.ts's DEPLOY_FAILED/DEPLOY_AUTO
 * markers, inflight-lock.ts's per-task locks, fleet-control.ts's pending kicks/drain-now
 * markers, daemon.ts's own `daemon.boot`/`daemon.summary`/`daemon.headroom` ledger lines +
 * `detectDaemonCrashLoop`, status.ts's dispatch-circuit-breaker/GitHub-projection signals,
 * sweep.ts's already-named PR disposition/reason (the W1-T186 named-reason doctrine — this
 * module RENDERS that vocabulary and mints none of its own), and config.ts's headroom-governor
 * switch. This module reads and assembles; it invents no new sensor.
 *
 * NEXT ACTION TABLES are POLICY AS DATA (rule 2): each section's `nextAction` is picked by
 * scanning an ordered list of `{applies, action}` rules and taking the FIRST match — a new
 * condition is a new table row, never a new branch buried in a renderer. No rule matches, no
 * line: a board that always prints advice trains the operator to skip it.
 */
```

## node:fs default import

Removed from lines 47-54.

```
// Imported as the module's DEFAULT export (a plain, mutable object), not as named bindings
// (`import { existsSync } from "node:fs"`) — the same load-bearing reason status.ts's own header
// comment documents: ESM named-export bindings off `node:fs` are non-configurable, so a test
// spying via `node:test`'s `mock.method` cannot intercept a call already bound to a named import
// at load time. Calling `fs.existsSync(...)` as a property access AT CALL TIME (never
// destructured to a local const) keeps every call a live lookup on this same mutable object, so
// a TOCTOU-race test (a marker present at `existsSync` but gone by `statSync`) can actually
// simulate it.
```

## ServiceKind — resident versus interval

Removed from lines 135-141.

```
/** `"daemon"`/`"serve"` are RESIDENT (launchd `KeepAlive`) — `running` means "is the process up
 *  right now", and a `false` between events genuinely means dead. `"deploy-supervisor"` is an
 *  INTERVAL job (launchd `StartInterval`, W1-T… supervisor plist): launchd spawns ONE
 *  `rmd deploy-run`, it runs for well under a second, and exits — `running: false` is its
 *  NORMAL resting state between ticks, not a symptom. A binary running/not-running render
 *  can't tell those two "false" cases apart; {@link ServiceKind} lets the caller pick the right
 *  question for each row. */
```

## ServiceLivenessRow — which fields belong to which service

Removed from lines 148-158.

```
/** One LIVENESS row. `bootedAt`/`bootedAgeMs`/`headSha` are populated ONLY for `"daemon"` — the
 *  only service that logs a `daemon.boot` heartbeat to the ledger today (W1-T126); `serve`
 *  carries none of the three, which the text renderer shows as "unknown", never a fabricated
 *  zero. `tickAt`/`tickAgeMs`/`tickStep`/`lastExitCode`/`overdueThresholdMs` are populated ONLY
 *  for `"deploy-supervisor"` — recency comes from the ledger (every `rmd deploy-run` cycle logs
 *  a `deploy.*` line, even a same-head no-op logs `deploy.skip`; see deployer.ts's
 *  `runDeployCycle` — exactly parallel to `daemon.boot` for the daemon, no new sensor invented,
 *  per this module's own RENDERS-NEVER-SENSES rule); `lastExitCode` comes from the CLI layer's
 *  own `launchctl list <label>` read (its `Status` column — see run-task.ts's `queryService`),
 *  the same fact the W1-T301 rationale used by hand (`launchctl list` showing `LAST EXIT 0`) —
 *  never re-derived by guessing from the ledger step name. */
```

## ServiceLivenessRow.sensed

Removed from lines 163-173.

```
  /**
   * False iff the LAUNCHD SENSOR ITSELF could not be asked at all — `launchctl` absent
   * (ENOENT — every non-macOS host, W1-T2450) — as opposed to launchctl running and giving a
   * real "not loaded"/"no tick" answer. Defaults to `true` (the old, sensor-implicit
   * behaviour) when the caller's `queryService` doesn't report it, so every pre-existing
   * caller keeps reading exactly as before. `false` is the ONE bit `running: false` alone
   * could never carry: "I have no sensor here" vs "the answer is no" (recon rationale Q1) —
   * see {@link livenessState}, which reads it BEFORE falling into the resident/interval
   * running-vs-stopped logic below, so an absent sensor renders `"unknown"`, never a
   * confidently wrong `"stopped"`.
   */
```

## LivenessState

Removed from lines 195-202.

```
/** The liveness states a service can be in, replacing the old binary running/not-running
 *  render that made a healthy idle-between-ticks supervisor and a genuinely dead one print the
 *  identical "not running" line (the bug W1-T301 exists to retire). Resident services only
 *  ever report `"running"`/`"stopped"`/`"unknown"`; interval services add `"idle"` (mid-tick or
 *  fresh since its last tick) and `"overdue"` (no tick recently enough, or its last exit was
 *  nonzero). `"unknown"` (W1-T2450) is neither: it means the launchd sensor itself could not be
 *  asked (no `launchctl` on this host) — a stated "I don't know", never a fabricated `"stopped"`
 *  that happens to share `running: false` with a real one. */
```

## LatchRow.superseded — the stale DEPLOY_FAILED instruction

Removed from lines 250-264.

```
  /**
   * Why this latch's RECORD is still worth showing while its INSTRUCTION no longer applies —
   * present only on a latch whose condition has been overtaken by events.
   *
   * TODAY THIS IS `DEPLOY_FAILED` AND ONLY IT. Nothing ever unlinks `state/DEPLOY_FAILED`
   * (deployer.ts writes it at two failure sites; `unlinkSync` there touches only the deploy
   * marker and the idle-deferred clock), so the alert is permanent until an operator removes the
   * file by hand — and its next action kept saying "re-deploy once fixed" long after origin/main
   * had moved past the head that failed. Measured on the mini: a latch 1h52m old naming
   * `86f3955`, by then an ancestor of both the running sha and origin/main, on a clean checkout.
   *
   * THE RECORD IS KEPT DELIBERATELY. A deploy that failed is a fact; the defect is the advice
   * attached to it. This is #1639's shape for LAST CLOSED CYCLE applied one block down: keep the
   * row, drop the instruction, say why.
   */
```

## LastCycleSection.supersededByTs — the 524-summary census

Removed from lines 290-297.

```
  /**
   * The newest `daemon.*` ledger activity STRICTLY AFTER this cycle closed, when there is any —
   * evidence the loop kept working since. A cycle only CLOSES when the loop stops, so a healthy
   * daemon writes no summary at all and this block would otherwise pin to the last abnormal stop
   * and imply it was current. MEASURED across all 524 `daemon.summary` rows: 312 `blocked`, 131
   * `error`, 56 `headroom_exhausted`, 23 `paused`, 1 `stopped`, 1 `max_reached` — NOT ONE says
   * "completed normally", because that row does not exist.
   */
```

## IndeterminateBlocker

Removed from lines 321-330.

```
/** This task's most recent dispatch was flagged INDETERMINATE (the ledger's own
 *  `dispatch.indeterminate` line — daemon.ts/drain.ts's existing `isIndeterminate` gate,
 *  itself either a GitHub-read failure or a ledger-count regression) — a PURE ledger read, so
 *  it renders regardless of GitHub reachability (the daemon already ledgers this; "visible to
 *  nobody without a ledger dig" is the falsifier this class exists to retire). `ghWindowNote`
 *  is ENRICHED, opportunistically, with the classified GitHub failure reason (status.ts's
 *  `StatusProjection.unavailableReason`, from the SAME batched `projectPlan` pass QUEUE
 *  HEAD/INBOX read) when a reachable gateway confirms the read is STILL indeterminate right
 *  now; otherwise it names the ledger fact alone — either way, "the gateway could not decide"
 *  never reads as "the task is broken". */
```

## BlockersSection — why blocked_pr is re-derived

Removed from lines 364-370.

```
/** `circuit_broken` and `indeterminate` are PURE ledger reads — ALWAYS present in full
 *  regardless of GitHub reachability (GitHub only ever ENRICHES `indeterminate`'s note, never
 *  gates its presence). `blocked_pr` (W1-T306) is DIFFERENT: it is a claim about NOW, so its
 *  rows are re-derived against live GitHub merge state every render — never the raw ledger
 *  replay `sweep.disposed` alone would give. See status-board.ts's own header doc: GitHub is
 *  decoration, never a gate — but decoration for `blocked_pr` means "unverified", not
 *  "present the ledger's stale opinion anyway". */
```

## QueueHeadRefusedRow

Removed from lines 406-414.

```
/**
 * W1-T1205: one task `runnableCandidates` (drain.ts) — the SAME selector {@link QueueHeadRow}s
 * above are built from — REFUSED, with the reason it refused for, so the row is named on this
 * surface rather than vanishing from it with no trace beyond a ledger row (design (ii): "show
 * both and label them"). Deliberately scoped to `"run-branch-already-pushed"` only (see {@link
 * QueueHeadSection.refused}'s own doc for why the other {@link DispatchFilterReason}s are not
 * duplicated here) — `reason` still carries the full union type so a caller can render it
 * without a second enum, but this section's own derivation never pushes anything else onto it.
 */
```

## QueueHeadRefusedRow.reason — why the union was not widened

Removed from lines 418-427.

```
  /**
   * W1-T2415: the {@link DispatchFilterReason} union PLUS `"circuit-broken"` — widened HERE and
   * nowhere else, deliberately. A seventh arm on the union itself would move `IdleReasonTally`
   * (a `Record` over it), `tallyDispatchFilters`'s own literal, and every consumer that switches
   * on it — and it would contradict that union's own doc, which says the circuit "already
   * ledgers itself through its own dedicated `onXxx` callback". This takes the doc at its word:
   * the breaker reaches this surface through `onCircuitBreak`, exactly as `runDaemon`
   * (daemon.ts) already collects ids for `StarvationCensus` with `circuitBrokenThisTick`, and
   * only this section's own row type learns the extra literal.
   */
```

## QueueHeadSection.refused — the deliberate scope

Removed from lines 444-463.

```
  /**
   * W1-T1205 (rationale (2)/(3)): tasks the dispatcher's OWN eligibility chain
   * (`isDispatchEligible`, drain.ts) refuses for a reason this board can now name — never a
   * second, silent list. Before this task `hasPushedRunBranch` was not part of the predicate set
   * {@link deriveQueueHead} bound, so `rows` could (and, measured live, did) advertise tasks
   * dispatch would refuse; this closes exactly that gap by binding the SAME `hasPushedRunBranch`
   * predicate the real dispatcher applies and naming what it excludes, rather than only widening
   * `rows` silently.
   *
   * SCOPED TO `"run-branch-already-pushed"`, NOT EVERY {@link DispatchFilterReason} — deliberate,
   * not an oversight (design's own NOT-IN-SCOPE discipline): `"already-merged"` is DONE, not
   * refused; `"verify-not-auto"` is PERMANENTLY parked and already has its own surface (W1-T507's
   * console panel, cited not re-filed); `"blocked"`/`"unmet-deps"`/`"continued-this-pass"` were
   * never part of THIS defect's measured symptom (rationale (2)'s empty-intersection reproduction
   * was entirely `hasPushedRunBranch`-driven) and widening the surface to them is a different,
   * unfiled change. Empty when nothing was excluded for this reason — never a placeholder row.
   * Capped at {@link IDLE_REASON_ID_CAP} entries (drain.ts's OWN bound for exactly this "how many
   * ids to name" question, reused rather than a second constant) — see {@link
   * QueueHeadSection.refusedTruncated} for the count this drops.
   */
```

## QueueHeadSection.stall — and the two silent cases

Removed from lines 473-484.

```
  /**
   * W1-T450: `rows` naming ELIGIBLE candidates renders identically whether they are about to
   * dispatch or have been sitting untouched for an hour — a daemon failing every pass looks
   * calm. Present ONLY when `rows` is non-empty AND the newest `run.start` already read (across
   * ANY task, not just these candidates) is older than {@link QueueHeadStall.boundMs}.
   *
   * SILENT, NOT JUST ABSENT, IN THE OTHER TWO CASES. An EMPTY queue never gets a `stall` —
   * `nothing dispatchable` is the honest idle state this defect is not (design (i)). An
   * UNREADABLE cadence — no ledger, no parseable `run.start`, or fewer than two dispatches ever
   * recorded to learn a gap from — also never gets one: an unknown answer must not render as a
   * finding (design (iv)).
   */
```

## HeadroomSection.degraded — the two states `found: false` conflated

Removed from lines 546-564.

```
  /**
   * The newest `daemon.headroom.degraded` line, when one is in the window — the governor
   * announcing that it CANNOT READ usage and has stopped dispatching (daemon.ts's park:
   * `consecutiveUnreadable > unreadableDegradedLimit` ⇒ log, sleep, `continue`).
   *
   * WHY THIS FIELD EXISTS. Without it `found` is false in two completely different states —
   * "no daemon has ticked yet" and "a daemon is ticking and will never produce a
   * `daemon.headroom` row" — and {@link HEADROOM_NEXT_ACTIONS}' first rung reported the
   * reassuring one for both: "it appears after the daemon's first tick". A permanent park
   * rendered as an in-progress start-up. The two are distinguishable from the ledger and
   * always were: the parked daemon writes `daemon.headroom.degraded` every tick while blind.
   *
   * THE LINE CARRIES ITS OWN DURATION, which is why one line is enough and no history is
   * needed: `consecutive_unreadable` × `poll_interval_ms` states how long the blindness has
   * lasted (ledger.ts's own note records observed counters of 4..42 at 60 000 ms). That also
   * survives rotation — `daemon.headroom.degraded` is in {@link RENDER_RELEVANT_LEDGER_STEPS}
   * with a 30-minute window, and while blind it re-fires every tick (median gap 2.32 min), so
   * a live episode always has a line inside the window.
   */
```

## CacheHitSection

Removed from lines 581-589.

```
/**
 * W1-T929: the cache-hit ratio (feedback fb-1785237559155-feef92, MASTER-PLAN §8A), per run and
 * per task class, over the SAME read ledger window {@link buildStatusBoard}'s other sections
 * already opened — `found: false` when nothing in that window carries usable cache-token data
 * yet (mirrors digest.ts's `DigestSummary.cacheHit` soft-compose discard, design note (iv)).
 * `totals` is digest.ts's own {@link CacheHitTotals}, computed by its {@link
 * aggregateCacheHitTotals}: ONE traversal, so `rmd status` and the daily digest can never
 * disagree on WHICH lines count.
 */
```

## LearningsInjectionSection

Removed from lines 595-602.

```
/**
 * W1-T940: LEARNINGS INJECTION DROP PRESSURE (feedback fb-1785237596465-45d06d, MASTER-PLAN
 * §8A) — the SAME read ledger window {@link buildStatusBoard}'s other sections already opened,
 * aggregated by digest.ts's {@link aggregateLearningsInjection}: ONE traversal, so `rmd status`
 * can never disagree with the digest on which `learnings.injected` rows count. `found: false`
 * when the window carries no `learnings.injected` rows at all (design note (iv) — a spawn-free
 * window renders explicit absence, never a fabricated `dropped: 0`).
 */
```

## CostAnomalyRow

Removed from lines 608-616.

```
/**
 * W1-T931 COST-ANOMALY SENTINEL (fb-1785237559155-feef92, item 4) — one un-dismissed
 * `cost.anomaly` ledger row (`src/lib/cost-anomaly.ts`'s `recordCostAnomalies`, hung off
 * `src/lib/sweep.ts`'s `runSweep`): a run that cost more than `multiplier` times its own task
 * CLASS's median, over a class with at least the policy's minimum sample count. Names every fact
 * the task's own acceptance criterion asks for — the run, its class, its cost, and the median it
 * exceeded — and NOTHING more: this row REPORTS ONLY (design note v), the same "renders, never
 * senses, never acts" discipline this module's own header states for every other section.
 */
```

## ImageDriftRow

Removed from lines 629-637.

```
/**
 * W1-T1021 IMAGE DRIFT — the newest un-dismissed `daemon.image_drift` ledger row
 * (`src/lib/image-drift.ts`'s `checkImageDrift`, ledgered by `serviceFreshnessGate` in
 * `src/run-task.ts` beside `daemon.tree_dirty`/`daemon.stale_code`): a baked path
 * (`deploy/entrypoint.sh` or `deploy/Dockerfile`) changed on `main` AFTER the running
 * container's own image was built, so the image cannot pick it up on a mount-side freshness
 * restart the way `src/`/`test/`/`node_modules` do. Names the two shas a human needs to judge
 * it — the image's own build sha and the baked commit it is missing.
 */
```

## MergeHeldRow — a hold is not a blocker

Removed from lines 645-652.

```
/**
 * W1-T1000003 — A MERGE HOLD ENGAGED BY AN OPERATOR (review.ts's `automergeHoldFromLedger`,
 * written by W1-T1000002's `automerge.hold_engaged`/`automerge.hold_released` ledger rows).
 * NOT a blocker (design fence (ii) of the task record): a blocker is something ELSE stopping
 * progress the operator would want fixed; a hold is the operator's OWN standing refusal to let
 * anything merge, so it renders here, in the escalation surface, never re-derived from check or
 * review fields — see {@link deriveMergeHeld}'s own doc for the reader it consumes verbatim.
 */
```

## NeedsMeSection and TokenFallbackRow

Removed from lines 670-687.

```
/**
 * NEEDS ME — the board's own escalation surface (distinct from `rmd serve`'s HTML "Needs me"
 * panel, which is task-escalation-driven; design note (viii) scopes this task to EXACTLY the
 * console surfaces `rmd status` text and `--json` project, "the whole surface here"). Today
 * carries the cost-anomaly rows W1-T931 shipped plus W1-T1021's image-drift finding plus
 * W1-T1000003's merge-hold rows; a future sentinel is a new field here, not a new section.
 */
/**
 * THE FLEET IS RUNNING ON THE FALLBACK TOKEN RIGHT NOW — the newest `github_app.token_refresh_failed`
 * is newer than the newest `github_app.token_refreshed` (or there has never been a success), so
 * `refreshInstallationToken` left `process.env.GH_TOKEN` exactly as it found it and every `gh` spawn
 * since is billing the PERSONAL token's buckets instead of the installation's.
 *
 * DELIBERATELY A CURRENT-STATE READ, NOT A COUNT OF HISTORICAL FAILURES. The exchange retries on the
 * `REFRESH_MARGIN_MS` cadence, so an isolated failure followed by a success is the system working and
 * must render nothing; only a failure that is still the LAST word means the fallback is standing.
 * Same "latest wins" comparison {@link ImageDriftRow} already gets from `isNewer`.
 */
```

## UncreditedBuildRow — warn, never credit

Removed from lines 697-705.

```
/**
 * W1-T2392: one merged BUILD that names a task in its own prose and that no credit surface
 * claimed — `StatusProjection.uncreditedBuild`, carried through verbatim rather than re-derived.
 *
 * WARN, NEVER CREDIT. `uncreditedBuildWarning` (status.ts) deliberately does not credit from prose:
 * a task credited wrongly is never built at all, which is strictly worse than one credited late.
 * This row is a REPORT of that warning and changes no disposition — the projection it reads is the
 * same object every other consumer sees, and nothing here writes back to it.
 */
```

## StatusBoardDeps.queryService

Removed from lines 749-759.

```
  /**
   * Per-service running/pid(+ for `"deploy-supervisor"`, its last completed run's exit code).
   * `launchctl print`/`launchctl list` live at the CLI layer (run-task.ts's own
   * `queryLaunchdServiceSensed`/`queryLaunchdListStatusSensed` + `DAEMON_LABEL`/`SERVE_LABEL`/
   * `SUPERVISOR_LABEL`) — this module never shells to launchd itself (Rule 16: lib/ stays a thin,
   * injectable seam over that). Required; no default exists inside lib/. `lastExitCode` is
   * `undefined` when unknown (never bootstrapped, or the query failed) — the caller must not
   * fabricate a healthy-looking `0`. `sensed` (W1-T2450) is `false` iff `launchctl` itself could
   * not be invoked at all (ENOENT — no launchd on this host); omitted/`true` reads exactly as
   * before this field existed — see {@link ServiceLivenessRow.sensed}.
   */
```

## StatusBoardDeps.readPushedRunBranches

Removed from lines 823-834.

```
  /**
   * W1-T1205: raw `git ls-remote --heads origin 'run-*'` output, parsed by drain.ts's {@link
   * runBranchTaskIds} into the SAME `hasPushedRunBranch` predicate the real dispatcher binds
   * (`DrainDeps.readPushedRunBranches`/`DaemonDeps.readPushedRunBranches`) — QUEUE HEAD needs its
   * OWN reader rather than sharing a closure with either, because it is a separate, unbatched
   * call site (design (i): "pass the SAME OPTIONS the dispatcher passes", not the same call).
   * Defaults to a real `git ls-remote` in `repoDir` (mirrors {@link resolveOriginMainSha}'s own
   * "lib/ shells git directly" precedent immediately below this field) — LIVE, no-fetch, git
   * PROTOCOL (never the REST/GraphQL budget), measured at 199 ms for 46 refs (drain.ts's own
   * doc). Returns `""` (never throws) when it cannot be read (no git, no remote, offline),
   * degrading `hasPushedRunBranch` to "nothing observed pushed" rather than blocking the board.
   */
```

## StatusBoardDeps.readSharedPauseState

Removed from lines 836-847.

```
  /**
   * W1-T2264: read of the fleet-wide shared PAUSE hold (fleet-control.ts's `sharedPauseRef`) — a
   * git ref that {@link buildLatchRows}'s STATIC_LATCHES loop cannot see, because every one of
   * those rows is sourced from `fs.existsSync` on a local path. Exactly ONE `git ls-remote`
   * (fleet-control.ts's `readSharedPause`) — matching the task's own cost bound: never the second
   * round trip `checkSharedPause`'s anchor lookup would cost, and never `checkSharedPause` itself,
   * whose "local first" fold would render the SAME hold this board's own local PAUSE row already
   * shows (see {@link buildLatchRows}'s dedup). Defaults to a real read via
   * `realSharedPauseGitDeps(repoDir)`. Returns `"unreachable"` (never throws) when origin cannot be
   * reached — the same fail-soft direction `readSharedPause` itself already keeps: an unreachable
   * remote is never read as `"absent"`.
   */
```

## StatusBoardDeps.readDispatchClaims

Removed from lines 849-862.

```
  /**
   * W1-T2270: read of every currently-held PER-TASK dispatch claim (dispatch-claim.ts's
   * `dispatchClaimRef`, `refs/rmd-dispatch/<taskId>`) — a git ref namespace {@link buildLatchRows}'s
   * STATIC_LATCHES loop cannot see for the same reason it could not see `refs/rmd-pause/hold`
   * before W1-T2264: every one of those rows is sourced from `fs.existsSync` on a local path.
   * `decideDispatchClaimRelease` refuses a time-based expiry on the stated ground that a stranded
   * claim is "a visible ref an operator can drop" — this is the read that makes it actually
   * visible, so that premise stops being false. Exactly ONE `git ls-remote` against the whole
   * namespace (never one round trip per task, and never the anchor decode a HOLDER's pid/host
   * would cost — see {@link DispatchClaimsRead}'s own doc). Defaults to a real read via
   * `defaultReadDispatchClaims`. Returns `{status: "unreachable"}` (never throws) when origin
   * cannot be reached — an unreachable remote is reported as UNDETERMINED, never as "no claim
   * held" and never as a specific task's claim (Q3's same fail-closed direction, applied here).
   */
```

## defaultReadSharedPauseState — the `.git` guard

Removed from lines 894-904.

```
/**
 * Real default for {@link StatusBoardDeps.readSharedPauseState} — see that field's own doc.
 *
 * GUARDED ON `.git` EXISTING FIRST (a synchronous, local, no-subprocess `fs.existsSync` — never a
 * second round trip, and never a second git invocation either), so a `repoDir` that is not a git
 * checkout at all (no remote could ever exist to be unreachable) reads as `"absent"` rather than
 * `"unreachable"`. This is NOT the same failure this function's OWN `readSharedPause` already
 * fails soft on: a checkout that IS real but cannot currently reach `origin` still reads
 * `"unreachable"` exactly as designed (Q3: an unreachable remote is never scored `"absent"`) —
 * this guard only keeps "there is no repo here" from being misread as "the remote is down".
 */
```

## DispatchClaimsRead

Removed from lines 910-923.

```
/**
 * W1-T2270: every currently-held `refs/rmd-dispatch/<taskId>` claim (dispatch-claim.ts), read via
 * exactly ONE `git ls-remote origin 'refs/rmd-dispatch/*'` — the same cost profile
 * {@link defaultReadSharedPauseState} already keeps for the singleton PAUSE ref, applied to a
 * NAMESPACE instead of one ref because a dispatch claim is per-task, not fleet-wide.
 *
 * `"unreachable"` on a nonzero exit — an unreadable remote is a FAILED READ, never scored
 * `"clear"` (the identical fail-closed direction {@link decideDispatchClaim} itself takes, and
 * {@link readSharedPause}'s own UNREACHABLE-MEANS-HELD precedent). `"clear"` on exit 0 with no
 * matching ref at all. `holder` is the anchor's own sha — never a second round trip to decode the
 * pid/host {@link gitDispatchClaimReserver}'s `mintAnchor` embeds in the commit message, mirroring
 * this file's OWN SHARED_PAUSE row (which also skips that second round trip) and reusing the exact
 * word `decideDispatchClaim`'s own refusal message already gives that sha: "holder".
 */
```

## newestDaemonActivityAfter — the ten-hour window

Removed from lines 1018-1023.

```
/**
 * The newest `daemon.*` ledger activity strictly after `sinceTs` — prefix-matched exactly as
 * `deriveLastPoll` (daemon-health.ts) already matches, NEVER on a step name. That prefix is why
 * LIVENESS stayed correct through a ten-hour window in which LAST CYCLE was pinned to a stopped
 * cycle: the two derivations read the same ledger and only one of them tracked the daemon.
 */
```

## deployFailedConsequence — the two kinds

Removed from lines 1127-1150.

```
/** Ordered by operational urgency — also the order rows render in (most-actionable first). */
/**
 * What a DEPLOY_FAILED latch actually MEANS, branched on the `kind` the deployer already wrote.
 *
 * THE TWO KINDS DID DIFFERENT THINGS AND MUST NOT SHARE A SENTENCE. `DeployFailureKind`
 * (`deployer.ts`) is exactly `dirty-tree-conflict | health-check-rollback`, and `deps.resetHard` has
 * exactly ONE call site — the health-check arm of `runDeployCycle`, which resets and then
 * `kickstart`s. The dirty-tree arm returns immediately after `deps.alert`, BEFORE `pullFf` is
 * reached: nothing is pulled, nothing is reset, and the daemon is still on the head it already had.
 * Telling that operator the checkout "was rolled back" and is "running the PRIOR head" is false
 * twice over — there is no prior head for it to be on — and it sends the diagnosis toward a deploy
 * that ran when the real situation is uncommitted files in the install checkout.
 *
 * A MISSING OR UNRECOGNISED `kind` RENDERS NEITHER SENTENCE. Asserting one of two incompatible
 * facts on no evidence is the defect being fixed, not a fallback for it — so an alert file from an
 * older build degrades to naming what is known and explicitly withholding the rest. This mirrors
 * `realDeployDeps.lastFailedKind`, which already answers `undefined` for exactly this input and says
 * why in its own comment: "absent/legacy/corrupt ⇒ reason not recorded, never a guess".
 *
 * THE DEPLOYER'S MESSAGE IS APPENDED VERBATIM ON EVERY ARM. For a dirty-tree abort it carries the
 * conflicting paths as PROSE (`… conflict with the fast-forward: <paths>`) — that list is the single
 * most actionable thing on the row, it already reaches the operator today, and no rewrite of the
 * clause in front of it may drop or truncate it.
 */
```

## buildLatchRows — the shared-PAUSE dedup

Removed from lines 1265-1277.

```
  // Shared cross-host PAUSE hold (W1-T2264) — `refs/rmd-pause/hold`, a git ref every row above is
  // blind to, because every one of them is sourced from `fs.existsSync` on a local path. Read via
  // exactly ONE `ls-remote` (never a second round trip for attribution — that stays behind the
  // optional `ageMs`, which simply reads "unknown" here, same as an inflight/kick row with no
  // cheap age available).
  //
  // DEDUP, LOCAL FIRST (mirrors fleet-control.ts's OWN `checkSharedPause` precedence, design (i)
  // there): `rmd pause` on THIS host writes the local PAUSE flag AND best-effort pushes this same
  // ref, so a host that paused itself would otherwise render its own hold twice — once as the
  // PAUSE row above, once as this one. Skip the read entirely once a local PAUSE row already
  // rendered: cheaper (no network call at all) and correct (the local row already tells this
  // host's own story; a second host's hold, if one also stands, is that OTHER host's board to
  // show).
```

## the held dispatch-claim row's truth value (W1-T2446)

Removed from lines 1309-1316.

```
      // W1-T2446: "WITH NO LANDED WORK OBSERVED" was asserted UNCONDITIONALLY for every held
      // claim — nothing on this path ever consulted merge credit, so for a task whose work HAD
      // landed (W1-T2424) the board kept saying it had not. `isMerged` is the SAME projection
      // `deriveQueueHead`/`deriveInbox` already build in this same render (`projections.get(id)
      // ?.merged === true`) — no new probe, no new read, threaded in rather than re-derived.
      // This ONLY corrects the sentence's truth value: it names the claim as stale rather than
      // asserting it is live, and still `git push origin :<ref>` — the OPERATOR arm, unchanged.
      // No drop is issued from here; this row still only reads and reports.
```

## deriveCircuitBrokenBlockers — the two skips

Removed from lines 1630-1646.

```
/** W1-T2335: skips a task `isDispatchEligible` (drain.ts) has ALREADY refused two guards before
 *  it ever reaches the breaker check — plan-declared `status: "blocked"` (:527, whether or not
 *  it carries W1-T1287's `retirement:`) and a task the batched projection already credits
 *  MERGED (:504), copying the identical skip {@link deriveIndeterminateBlockers} performs on
 *  the very next lines rather than inventing a second one. Neither `plan` nor `projections` is
 *  read to CHANGE any dispatch decision — `dispatchesWithoutNewOwnedPr`/`isDispatchBreakerTripped`
 *  stay untouched, so the row RETURNS byte-identical the moment the task's status returns to a
 *  dispatchable one. With no plan/no projections in hand (an unreadable plan or an unreachable
 *  GitHub gateway) this renders exactly as it does today — degrading toward today, never toward
 *  silence (design (iv)): the renderer cannot know a task is withdrawn without a plan to ask. */
// W1-T2383 rank 3: EXPORTED so the guard above (`isQueueDispatchRunStart` inside
// `distinctDispatchedTaskIds`) is provable against this fold's REAL output rather than asserted
// from source text — the same reason W1-T1047 exported `deriveDispatchCadence`. Behaviour
// unchanged; nothing outside a test calls it.
/** W1-T2415: ONE wording for the breaker's own reset condition, shared by the BLOCKERS class and
 *  the QUEUE HEAD refusal row. Extracted rather than copied — two surfaces describing one
 *  breaker in two sentences is how they drift. */
```

## deriveBlockedPrBlockers — the W1-T309 multi-dispatch seam

Removed from lines 1743-1763.

```
/** `rawBlockedPrCandidates` RE-DERIVED against LIVE GitHub state (W1-T306 design (2): "a PR
 *  that is merged or closed is NOT a blocker … whatever the ledger still says about it; merge
 *  state is the authority") — via a DIRECT `github.prByRef(row.prNumber)` lookup on EACH
 *  candidate's OWN PR number, never through a task's derived {@link StatusProjection}.
 *
 *  W1-T309: the prior implementation matched against the batched `projectPlan` projections
 *  keyed by TASK id, which carry only that task's LATEST `pr.opened` line (status.ts's
 *  `lastPrOpened`, "last one wins" — see `deriveStatus` rung (a)). A task dispatched more than
 *  once opens a NEW PR each time; once a later dispatch opens PR #B, the task's projection
 *  resolves against #B only, and an EARLIER PR #A that sweep once disposed "blocked" becomes
 *  permanently unreachable through that projection — #A is never the task's "own" result and
 *  never lands in any projection's `prNumber` either, so live confirmation that #A later merged
 *  or was closed (abandoned) had nowhere to register. Every W1-T306 test happened to give each
 *  disposed PR number as the SAME number the owning task's single projection resolved to (via
 *  its lone `pr:` field or lone `pr.opened` line) — a shape multi-dispatch production tasks
 *  don't share, which is exactly the seam those passing tests never exercised. Querying the
 *  candidate's PR number directly needs no plan/projection at all, matching this module's own
 *  documented claim that BLOCKERS is unaffected by a missing plan (see {@link
 *  StatusBoardDeps.plan}'s doc) — a claim the projection-keyed implementation did not honor.
 *  ONLY called once the caller has already confirmed `github` is live and reachable this cycle
 *  — see `deriveBlockers`'s unverified branch for the "cannot be read" case. */
```

## the cost-anomaly fold — deduped by run_id

Removed from lines 2165-2179.

```
/**
 * W1-T931: this board's own read of `cost.anomaly` ledger rows — never a re-derivation of the
 * detector's own math (that lives entirely in `src/lib/cost-anomaly.ts`; this module only
 * RENDERS the vocabulary `sweep.ts` already ledgered, per this file's own header doctrine).
 *
 * DEDUPED BY `run_id`, LAST ONE WINS. `recordCostAnomalies`'s own idempotency (one row per run
 * id, proven at the unit level) assumes a single, sequential reader of a single ledger snapshot;
 * `runSweepLightPass` fans `runSweep` out across every open PR CONCURRENTLY (W1-T463), each with
 * its OWN ledger read, so two overlapping calls in the same tick can each observe the ledger
 * before the other's write lands and both append a `cost.anomaly` row for the same run. That is
 * a cosmetic duplicate-WRITE risk this board does not attempt to close (no new cross-call lock —
 * out of this task's scope), but a duplicate-READ risk this render trivially can: collapsing to
 * one row per run id here means an operator never sees the SAME run named twice in NEEDS ME
 * regardless of how many `cost.anomaly` lines it actually accumulated.
 */
```

## buildStatusBoard — why the board reads rotations

Removed from lines 2373-2381.

```
  // W1: THE BOARD MUST READ ROTATIONS, NOT ONE FILE. `readLedgerLines` opens exactly one path, and
  // `rotateLedger` sheds a step COMPLETELY when it is in no retention set — MEASURED, `daemon.summary`
  // had 0 live rows against 524 in rotations, which is why LAST CLOSED CYCLE rendered
  // `no cycle recorded` on a host with 524 recorded cycles.
  //
  // THE PREDICATE NAMES ONLY THE STEPS THAT ARE ACTUALLY SHED. Six of the board's steps are present
  // in the live file, so they need no rotation at all; these three are the measured blind set, and
  // every rung reading them takes the NEWEST row rather than a count, so stopping early is exact
  // rather than approximate.
```

## SECTION_RULE_WIDTH

Removed from lines 2540-2546.

```
/** The width every one of the ten section rules below was already hand-typed at (measured,
 *  not assumed — see the task rationale's SURFACE 2 correction: all ten, one true width, never
 *  ten different ones). Pinned here rather than wired to `terminalWidth()` so this render stays
 *  exactly what it is today regardless of the real terminal's column count — a live-width
 *  divider is future work this task deliberately leaves alone (NOT IN SCOPE: no change to what
 *  the board SAYS, and byte-identical-when-off is the load-bearing constraint this pin keeps
 *  true even when colour IS on, since `sectionRule` itself never paints). */
```

## renderLearningsInjectionBlock — the seven refusal reasons

Removed from lines 2822-2842.

```
/**
 * W1-T940 — the drop-pressure lines: `matched`/`dropped`/`rows` totals, every distinct
 * `budget_chars` value seen (design note (i): NOT averaged into one number, so a mid-window
 * constant change stays visible), and any `global_refused_reason` strings NAMED VERBATIM on
 * their own line, deduped with a count — never folded into `dropped` (design note (iii): a
 * refusal is a layer contributing ZERO entries, a drop is a ranked entry losing a tie). `found:
 * false` renders explicit absence rather than a fabricated `dropped: 0` (design note (iv)).
 *
 * W1-T1251 — `loadGlobalArtifact` (learnings.ts) returns SEVEN distinct failure reasons, of
 * which exactly ONE ("global artifact not found") is the ruled-on §6-DEFERRED-TRANSPORT state —
 * a designed, non-fatal absence nothing has provisioned yet — and six are REAL problems with an
 * artifact that DOES exist, including the hash-mismatch tamper signal. Printing every one of
 * them behind the single word `refused:` reports an expected absence and a hand-edited artifact
 * in the same vocabulary. `classifyGlobalArtifactRefusal` (learnings.ts, the ONE producer of
 * this discriminant) splits `globalRefusedReasons`' keys into the two lines below — the reason
 * TEXT itself is unchanged/verbatim either way, only which line it renders on differs, so this
 * reads apart from a genuine refusal without touching run-task.ts's per-row logging at all (no
 * new ledger field, no new I/O — see the task record's design note (iv)/(iii)). A tampered or
 * malformed artifact keeps the word `refused` and stays on the FIRST, prominent line exactly as
 * before; the designed absence moves to its own line, named as what it is.
 */
```

## renderStatusBoardText and the operator-message standard

Removed from lines 2915-2945.

```
/** The text projection of {@link StatusBoardModel} — every field it prints comes off the model
 *  passed in, never a fresh read, so `--json` and the default text output can never disagree
 *  (they are the SAME derivation, rendered twice); this function is the ONLY thing this task
 *  changes about that projection, and the JSON path (`statusCommand`'s `--json`, a bare
 *  `JSON.stringify` of the same model) never calls it, so the JSON projection is untouched by
 *  anything below.
 *
 *  `opts.colourEnabled` defaults to {@link colourEnabled}'s real `process.env`/`process.stdout`
 *  read — the ONE call site in this module that reads either — so a real terminal run picks up
 *  `NO_COLOR`/`FORCE_COLOR`/its own TTY-ness automatically, while a test (or any other caller)
 *  can pin the flag explicitly instead of mutating global state. With colour disabled (the
 *  default in this suite's own non-TTY `node --test` processes, and always when forced) the
 *  output is BYTE-IDENTICAL to what this function rendered before this task — every `paint`
 *  call returns its input unchanged, and `sectionRule` never emits colour at all. */
// ── OPERATOR MESSAGE STANDARD — the board's presence projection (W1-T2806) ──────────────────
//
// docs/operator-message-standard.md is NORMATIVE and names `renderStatusBoardText` as its FIRST
// surface, on the reasoning that the board already carries a next-action slot. It did; nothing
// read it through the standard's own checker. `escalate.ts` was the only module that ever called
// {@link checkOperatorMessage}, so the surface an operator reads first was the surface the
// presence check never saw.
//
// WHAT THIS IS NOT. It is not a readability score, a length bound or a vocabulary rule — the
// standard forbids any of those being added in its name, because this repo cannot compute reader
// comprehension honestly. It checks PRESENCE of four slots and nothing else. It also does not
// certify that any board message is TRUE: the standard's own opening records a `NextActionRule`
// whose action slot is filled and whose sentence is false anyway.
//
// AND IT NEVER WITHHOLDS. `operator-message.ts` states the fallback is the hazard and fails toward
// DELIVERY. No row is hidden, reordered or truncated because its projection is incomplete; the
// board renders in full and one footer line records what was missing.
```

## projectBoardSectionSafe — the throw that escaped every guard

Removed from lines 3023-3039.

```
/**
 * {@link projectBoardSection} under the same guard the check already has (W1-T2826).
 *
 * checkBoardSectionSafe covers checkOperatorMessage and nothing else, because it receives a message
 * that is ALREADY projected. The projection ran one frame out, in the argument expression feeding
 * {@link boardMessageFooter}, inside a renderStatusBoardText that has no try of its own — so a
 * throw raised while projecting escaped every guard on the path and the operator got no board at
 * all, which is precisely what checkBoardSectionSafe's doc promises can never happen.
 *
 * It is reachable rather than theoretical: seven of the ten block renderers read `nextAction`
 * before the projection does, but cacheHit, learningsInjection and needsMe do not, so a section
 * object whose `nextAction` throws reaches sectionNextAction with the render already complete.
 *
 * Returns `undefined` for a section it could not project — the same distinction the check itself
 * draws. An unreadable section is omitted from the footer, never reported as incomplete, because
 * "could not be read" and "was read and found thin" are different facts.
 */
```

