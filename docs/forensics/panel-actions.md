# panel-actions.ts comment forensics

The measured forensics, incidents and design arguments that were removed from
`src/lib/panel-actions.ts` when its comments were compacted to the plain-language standard
(docs/comment-standard.md).

Each section below carries the removed block verbatim, under a heading naming the symbol it
explained, and the code keeps a one-line `Why:`/`// Why:` pointer wherever the history mattered.
Nothing here was rewritten: this is the original text, so a reader chasing an incident or a
design argument reads what the author actually wrote.

Line numbers are positions in `src/lib/panel-actions.ts` at the merge base of the compaction PR
(49e429e3).

## Module header

Removed from lines 1-40.

```
/**
 * lib/panel-actions.ts — the control panel's human-in-the-loop WRITE actions (W3-T5,
 * MASTER-PLAN §7 "editing capability tiers" — human-in-the-loop actions).
 *
 * §7: "answer questions (QUESTION contract), approve MANUAL queue items, Pause/Resume
 * (drain-and-hold)/STOP, quiet-hours toggle — writes go through the api-client's write
 * scope, ledgered with the panel's bearer." This module is that write-scope business
 * logic, built the SAME way lib/board.ts built the read side (W3-T2): a thin Route layer
 * over EXISTING mechanism (lib/service.ts's Route, lib/fleet-control.ts's flag files,
 * worker.ts's plan/questions.ndjson store) plus one new primitive this task actually owns
 * — the `panel.*` ledger lines that make every action attributable. Real `rmd serve` CLI
 * wiring (registering these routes on a live createService() instance) is later work, same
 * split board.ts's header documents.
 *
 * "THE ANSWER FLOWS TO THE ARCHITECT" (§7). `buildAnswerQuestionRoute` writes the operator's
 * answer to TWO places, both durable: `plan/questions.ndjson` (worker.ts's
 * `appendQuestionAnswer` — the SAME store the QUESTION contract already writes into, so an
 * answer is never a side channel only this route knows about) and the `panel.*` ledger line
 * below (the SAME provenance stream retro.ts's Architect already reads for corrective-task
 * filing). See `buildAnswerQuestionRoute`'s own doc comment for the full walk-through.
 *
 * ROUTING IS EXACT-MATCH ONLY (service.ts v0 — no path params), so every route below takes
 * its target (a task id, an issue URL) in the POST body rather than the URL path.
 *
 * WHO DID THIS (the origin field). §9/WS-9's acceptance bar is "ledger entries originating
 * from the client's bearer token." `ServiceTokens` (service.ts) is v0 — one shared write
 * token, not a per-panel-install identity — so there is no separate "user id" to log. The
 * bearer token itself IS the caller's proof of identity; what these handlers log as
 * `origin` is a SHA-256 id derived from it (`bearerTokenId` below), never the raw secret —
 * the ledger is an append-only, UI-rendered, tailed-by-SSE stream (lib/board.ts), so writing
 * a live credential into it would leak the credential to every reader. A hash is still a
 * stable per-token id: two calls with the same bearer produce the same `origin`, so a panel
 * (or a future second identified caller) is distinguishable across ledger lines without ever
 * being reversible back to the secret.
 *
 * FAIL LOUD ON BAD INPUT (Standing rule: validate before any write/spawn — the `rmd stop`
 * unknown-subcommand hazard in LEARNINGS.md). Every handler parses + validates the JSON body
 * BEFORE touching fleet-control's flag files, the GitHub issue gateway, or the ledger — a
 * malformed request performs NO side effect, ever, and gets a 400 with a specific reason.
 */
```

## PanelActionDeps — threadStorePath and interpretReplyDeps

Removed from lines 82-101.

```
  /**
   * W1-T2496: path to the JSONL thread store `buildEscalationReplyRoute` reads/appends through
   * (`inbox-thread.ts`'s {@link ThreadStoreDeps.threadStorePath}, the SAME store `escalate.ts`'s
   * own OPTIONAL best-effort write already targets, W1-T2494). OPTIONAL on this type for the
   * same reason `escalate.ts`'s own field is: every route in this module PREDATING this task
   * builds a `PanelActionDeps` literal with no such field, and that must keep compiling and
   * behaving exactly as before. Unset here means `buildEscalationReplyRoute` can never find an
   * existing thread to reply to, so it refuses every reply loud (see that route's own doc) —
   * a missing wire is a refusal, never a silent unattached filing.
   */
  threadStorePath?: string;
  /**
   * W1-T2499: rules {@link buildEscalationReplyRoute} hands `interpretReply` (reply-interpreter.ts)
   * to decide whether a reply is UNDERSTOOD or leaves an unresolved ambiguity worth asking about.
   * OPTIONAL for the exact reason `threadStorePath` above is: every route built before this task
   * (and every caller of this one that never sets it) must keep compiling and behaving exactly as
   * before — unset means `interpretReply` runs with its own default (`rules: []`), which is always
   * `"understood"`, so an unconfigured deploy never asks anything and this route's prior behaviour
   * is unchanged bit for bit.
   */
  interpretReplyDeps?: InterpretReplyDeps;
```

## bearerTokenId

Removed from lines 110-121.

```
/**
 * A stable, non-reversible id for the bearer token that authenticated this request — see the
 * module header's "WHO DID THIS" note. Returns the literal `"unknown"` only if service.ts
 * somehow routed here with no Authorization header at all, which the scope check upstream
 * already rules out for a write-scoped route; kept as a fallback string rather than a throw so
 * a handler bug elsewhere never turns into a 500 on this line specifically.
 */
export function bearerTokenId(req: IncomingMessage): string {
  const header = req.headers.authorization;
  const token = header ? /^Bearer (.+)$/.exec(header)?.[1] : undefined;
  // W1-T163: the SAME hash lib/last-seen.ts's LastSeenStore keys its per-token marker by — one
  // "raw bearer -> stable id" algorithm, not two independently-maintained copies of it.
  if (!token) return "unknown";
```

## readJsonBody

Removed from lines 128-130.

```
  // W1-T500: the dispatch may already have drained this stream for a HIGH-tier nonce check (see
  // service.ts's RAW_BODY_CACHE). Reading it again would wait on an ended stream forever, which is
  // what hung every HIGH-tier route the first time enforcement was switched on.
```

## appendPanelLedger

Removed from lines 176-181.

```
/**
 * Ledger one panel action, keyed by `ledgerPath` alone (not the full `PanelActionDeps`) so
 * lib/panel-graph.ts's feedback/trace/decision routes -- which have no `issues` gateway to
 * satisfy `PanelActionDeps` -- can ledger through the SAME primitive rather than re-deriving
 * the `run_id`/shape convention a second time.
 */
```

## jsonAction

Removed from lines 191-197.

```
/**
 * Wrap a route body: parse JSON, run `validate` (return an error string to FAIL LOUD with a
 * 400 before any side effect, or the validated input to proceed), then run `act`. Centralizes
 * the parse-validate-act-respond shape every handler below shares, so each route definition is
 * just its own validation + effect, not a rebuilt copy of this plumbing. Shared with
 * lib/panel-graph.ts (W3-T6) -- same discipline, same helper, never a second copy.
 */
```

## FleetControlStatus.daemonLive and DaemonLivenessReason

Removed from lines 229-278.

```
  /**
   * W1-T288: is a daemon actually alive, evidenced by a recent `daemon.*` ledger heartbeat
   * within the liveness bound (the SAME bound W1-T179 already uses for a task row's "running"
   * determination — status.ts's `DEFAULT_LIVENESS_BOUND_MS`, never a second one)? `true` when a
   * heartbeat lands inside that window; OMITTED (never a fabricated `false`) when there is no
   * heartbeat at all or the last one has aged past the bound — liveness is then simply NOT
   * OBSERVED, the same fail-soft shape `deployer.ts`'s own liveness field already uses ("Omitted
   * ⇒ liveness is simply not observed"). The three flags above are a CLAIM ("no one asked me to
   * stop"); this field is EVIDENCE of activity — a crashed daemon leaves no stop flag behind, so
   * without this field the flags alone render identically for "running" and "crashed".
   *
   * recon-blackout rec-2: `false` IS NOW A REAL ANSWER. It used to be `true`-or-omitted, which meant a dead
   * daemon and a missing ledger were one indistinguishable state — see {@link
   * deriveDaemonLiveness} for the evidence each verdict now requires. Omitted still means "not
   * observed", but {@link FleetControlStatus.daemonLiveReason} always says WHY.
   */
  daemonLive?: boolean;
  /**
   * recon-blackout rec-2: the EVIDENCE behind `daemonLive`, always present — including on the `true` path, so
   * a reader never has to infer which branch produced the verdict. This is what stops an
   * unobserved liveness from rendering as a bare shrug: every unknown names its own cause, the
   * shape `rmd status` already uses when it prints "unknown — GitHub gateway unreachable" beside
   * a next action rather than an empty section. See {@link DaemonLivenessReason}.
   */
  daemonLiveReason: DaemonLivenessReason;
}

/**
 * recon-blackout rec-2: why {@link FleetControlStatus.daemonLive} says what it says. THE POINT IS THAT THREE
 * FORMERLY-IDENTICAL STATES ARE NOW THREE ANSWERS — a stale poll is evidence the daemon is DOWN,
 * whereas an absent or unreadable ledger is evidence of NOTHING, and the operator needs both.
 *
 *  - `fresh-poll`         → live TRUE.  A `daemon.*` line inside the liveness bound.
 *  - `last-poll-stale`    → live FALSE. A `daemon.*` line exists and has aged past the bound:
 *                           the daemon ran and stopped. This is the verdict that did not exist.
 *  - `no-daemon-activity` → live FALSE. The ledger is present, readable and NON-EMPTY, yet holds
 *                           no `daemon.*` line at all. `ledger.ndjson` is `NEVER_ROTATE_FILENAME`
 *                           and `rotateLedger` retains up to MAX_RETAINED_LINES_PER_STEP newest
 *                           lines PER STEP, so a daemon that had ever polled would still be
 *                           represented here — its total absence beside other traffic is real
 *                           evidence, not a gap.
 *  - `ledger-empty`       → live UNDEFINED. Present and readable but with no lines at all: a
 *                           fresh install has nothing to say either way, so claiming FALSE here
 *                           would be inventing evidence.
 *  - `ledger-absent`      → live UNDEFINED. No file at `ledgerPath` — a wrong/unmounted path or
 *                           an install that has never run. Says nothing about the daemon.
 *  - `ledger-unreadable`  → live UNDEFINED. The file is there and the read THREW (permissions,
 *                           I/O). Previously this escaped the handler and became a 500 through
 *                           `createService`'s catch, so the panel showed nothing at all.
 */
```

## deriveDaemonLiveness

Removed from lines 293-324 (the function doc and the trailing inline comment).

```
/**
 * recon-blackout rec-2: the liveness taxonomy, split out as a PURE function so the three-way distinction is
 * falsifiable without standing up a server — the handler below is then only wiring plus the one
 * thing a pure function cannot model, a read that throws.
 *
 * PRESENCE IS READ DEFENSIVELY, and that is load-bearing. `readLedgerLines` attaches a
 * non-enumerable `present` (status.ts), but `LedgerReader` — the injectable seam every test and
 * several production callers use — is typed `(path) => Array<Record<string, unknown>>`, so an
 * injected reader's result has `present === undefined`. Only an EXPLICIT `false` may be read as
 * "absent"; `undefined` means the reader did not report presence, and the verdict then rests on
 * the lines themselves exactly as it did before this change. That is what keeps every existing
 * injected-fake test asserting the same verdicts it always did.
 *
 * `deriveLastPoll` is imported from daemon-health.ts, not reimplemented — the same discipline
 * W1-T288 established, so this route and GET /v1/daemon-health can never disagree about which
 * ledger line counts as a heartbeat or how recent "recent" is.
 */
export function deriveDaemonLiveness(
  lines: ReadonlyArray<Record<string, unknown>>,
  nowMs: number,
  livenessBoundMs: number,
): DaemonLivenessVerdict {
  if ((lines as { present?: boolean }).present === false) return { reason: "ledger-absent" };
  const poll = deriveLastPoll(lines);
  if (poll.lastPollTs) {
    const ageMs = Math.max(0, nowMs - Date.parse(poll.lastPollTs));
    return ageMs <= livenessBoundMs ? { live: true, reason: "fresh-poll" } : { live: false, reason: "last-poll-stale" };
  }
  // No heartbeat. Whether that is EVIDENCE or merely SILENCE turns on whether the ledger had
  // anything else to say — see DaemonLivenessReason for why a non-empty ledger with no `daemon.*`
  // line is a real negative rather than a gap.
```

## ControlStatusDeps

Removed from lines 329-338.

```
  /** Ledger reader; defaults to reading + parsing NDJSON from disk — mirrors daemon-health.ts's
   *  own `DaemonHealthDeps.readLedger` (same injectable shape, never a second copy of the read). */
  readLedger?: LedgerReader;
  /** Clock; defaults to `Date.now`. Injectable so a test can assert an exact liveness boundary
   *  without a real sleep (mirrors `DaemonHealthDeps.now`/status.ts's `DeriveDeps.now`). */
  now?: () => number;
  /** LIVENESS BOUND (W1-T179 design (ii), REUSED not reinvented): defaults to
   *  {@link DEFAULT_LIVENESS_BOUND_MS} — see that constant's own doc for why a second,
   *  differently-tuned threshold here would let this surface and the task-row surface disagree. */
  livenessBoundMs?: number;
```

## buildControlStatusRoute

Removed from lines 341-370.

```
/**
 * GET /v1/control/status — read-scoped. W1-T153's fleet-control READ-BACK: the shell must
 * derive its Pause/Resume/STOP/quiet-hours button states from the ACTUAL fleet-control flag
 * files (fleet-control.ts's isPaused/isStopped/isQuietHours), never render stateless buttons
 * that invite discovery-by-actuation ("should I try clicking start?" on a STOP'd fleet). No
 * route on this surface exposed the tri-state before this task — every prior panel-actions.ts
 * route only ever returned the flag ITS OWN write just flipped, never the full current state.
 *
 * W1-T288: also carries `daemonLive`, derived from the SAME `daemon.*`-prefixed ledger heartbeat
 * `daemon-health.ts`'s `deriveLastPoll` already computes for GET /v1/daemon-health — imported,
 * not reimplemented, so this route and that one can never disagree about what "recent" means.
 * The ledger is read ONCE per request by this route (no call out to the daemon-health route
 * itself — that would be the double-fetch the task's design note rules out).
 */
export function buildControlStatusRoute(deps: ControlStatusDeps): Route {
  return {
    method: "GET",
    path: "/v1/control/status",
    scope: "read",
    handler: (_req, res) => {
      const now = deps.now ?? Date.now;
      const readLedger = deps.readLedger ?? readLedgerLines;
      const livenessBoundMs = deps.livenessBoundMs ?? DEFAULT_LIVENESS_BOUND_MS;
      // recon-blackout rec-2: a read that THROWS (permissions, I/O) used to escape this handler and become a
      // 500 through createService's catch, so the whole panel vanished over one unreadable file.
      // Caught HERE rather than inside `readLedgerLines`, deliberately: that reader has ~50 call
      // sites including the dispatch circuit breaker, where swallowing an I/O error would silently
      // reset a bound instead of failing loudly. This is a RENDERING concern and stays local to
      // the rendering route — the same split `buildShellRoute`'s idle panel already draws when it
      // degrades its own read to UNKNOWN rather than to zero.
```

## buildAnswerQuestionRoute

Removed from lines 496-511.

```
/**
 * POST /v1/questions/answer — answer a QUESTION-contract entry, write-scoped. THE ANSWER
 * FLOWS TO THE ARCHITECT two ways, both written before the 200 response:
 *   1. `appendQuestionAnswer` (worker.ts) writes the answer into `plan/questions.ndjson` —
 *      the SAME durable, diffable, append-only store `appendQuestion` already writes the
 *      QUESTION into (MASTER-PLAN §7: "Question store: plan/questions.ndjson (durable,
 *      diffable), surfaced in clients + the daily digest count") — so the answer lands in
 *      the one channel every future question consumer (the Architect's triage/retro loop) is
 *      already scoped to watch, not a side record only this route knows about.
 *   2. The `panel.question_answered` ledger line below is the SAME provenance stream the
 *      Architect's retro (retro.ts) already reads for corrective-task filing — durable,
 *      queryable, and carrying the caller's `origin` for accountability.
 * The `plan/questions.ndjson` write is BEST-EFFORT non-blocking (worker.ts's contract — a
 * write failure there never throws); ledgering still records the answer either way, so a
 * degraded filesystem never silently drops the operator's action.
 */
```

## buildApproveManualRoute

Removed from lines 547-553.

```
/**
 * POST /v1/manual/approve — check off a MANUAL-queue item, write-scoped. §4: "the MANUAL queue
 * doubles as the human's to-do list — rendered in the control panel with check-off (= closing
 * the issue)"; closing the `escalation-manual`-labeled GitHub issue (escalate.ts) IS the
 * check-off. Closes the issue FIRST, then ledgers — a close that throws (bad URL, `gh`
 * failure) never produces a false "approved" ledger line.
 */
```

## buildEscalationMarkHandledRoute

Removed from lines 584-596.

```
/**
 * POST /v1/escalation/mark-handled (W1-T182) — the NEEDS ME affordance an ESCALATION row
 * actually supports, distinct from `/v1/manual/approve`'s MANUAL-queue check-off: "approve" has
 * no defined verb for an escalation of ANY class (BLOCKED/MANUAL/HARD_STOP/GRILL), because
 * escalate.ts's own issue body already says so ("closing this issue does not resolve the
 * underlying block by itself — act on it, then resume via `rmd drain`"). This route is
 * deliberately named "mark handled", not "approve" or "resolve" — closing the issue is real
 * (it is what clears the row via {@link resolveEscalation}'s live join, status.ts), but the name
 * must not imply the underlying block is fixed, the same honesty bar the issue body itself sets.
 * A SEPARATE route from `/v1/manual/approve` (rather than a relabel) so that route's existing
 * `panel.manual_approved` semantics — and apps/dashboard's own "Approve a MANUAL item" form,
 * which posts to it — are untouched.
 */
```

## buildEscalationReplyRoute

Removed from lines 639-673.

```
/**
 * POST /v1/escalation/reply (W1-T2496) — the prose-reply affordance neither
 * `/v1/questions/answer` (a structured QUESTION contract) nor `/v1/escalation/mark-handled`
 * (a dismiss, carrying no words) is: a human answering an ESCALATION in the human's own
 * sentence, the way one replies to an email rather than filling a form. Forty console routes
 * shipped before this one and none of them was a reply (this task's own title) — this is that
 * fortieth-plus route.
 *
 * THE THREAD, NEVER A NEW CHANNEL. `taskId`/`class`/`cause`/`prRef` are the exact
 * {@link ThreadIdentity} `escalate.ts` already raises this concern under (its own dedup key —
 * see inbox-thread.ts's module doc), so this route DERIVES the same thread id from them
 * ({@link deriveThreadId}) rather than accepting one the caller minted or typed. A THREAD THAT
 * HAS NEVER RECEIVED A MESSAGE IS REFUSED (400): naming an escalation that was never actually
 * raised — or a store this checkout cannot read — is refused loud, never silently filed as
 * feedback with nothing to attach it to, which is the exact "unattached feedback" failure mode
 * this task exists to close. `deps.threadStorePath` unset (no wiring yet) is the SAME refusal:
 * this route can never confirm a thread it cannot read, so it never guesses.
 *
 * THE ENTRY IS A PLAIN `plan/feedback/<id>.yaml` RECORD — {@link captureFeedback} (feedback.ts),
 * the SAME writer `rmd feedback`/the console's own `POST /v1/feedback` already use, carrying
 * the derived thread id as feedback.ts's `thread_id` field. Nothing here mints a second store, a
 * second status lifecycle, or a second triage path: `rmd triage` (W1-T41) already reads every
 * entry this writes, origin-agnostically — exactly the discipline MASTER-PLAN §5D rules ("one
 * inbox, one triage discipline, whatever the source").
 *
 * A REPLY IS AN INPUT, NEVER A COMMAND — the hard line this task exists to hold (rationale,
 * plan/tasks.d). This handler calls exactly THREE things: {@link appendThreadMessage} (record
 * the reply on its thread), {@link captureFeedback} (file it where triage already looks), and
 * `ledgerPanelAction` (attribute it). It never touches `deps.issues` (no GitHub issue comment,
 * close, or create — commenting back on an issue stays `issues-intake`'s own forbidden ground),
 * never `fleet-control.ts`'s `requestKick`/`requestDrainNow`/`requestPause`/`resumeFleet` (no
 * dispatch), and never a ratify gateway (no merge arm, no proposal ratified). `classifyProposal`
 * and `rmd triage`'s own tiering are what decide what this reply BECOMES; this route only makes
 * them consider it, exactly like every other `origin: ui` feedback entry captured today.
 */
```

## recordRiskOverride — section header, RiskOverrideRecordInput, validateRiskOverrideRecord, and the function doc

Removed from lines 739-819.

```
// ── recordRiskOverride — an operator's record of a risk-judge escalation override (W1-T2244) ──
//
// THE GAP THIS CLOSES. A CAPPED verdict's own escape hatch — `rmd review <pr>
// --override-capped-by <name> --override-capped-reason <text>` — writes an attributable,
// calibratable `automerge.capped_override_granted` row (run-task.ts). The risk judge's own
// escape hatch is the words "merge it by hand" (escalate.ts's `namesOperatorOnlyAct`): an
// operator acting on a risk-judge escalation today can produce, at most,
// `panel.escalation_marked_handled` — an issue-close bookkeeping row with no verdict, no
// confidence, no disposition and no reason, so a calibrator reading it learns a button was
// pressed and nothing about whether the judge was right. This function is the missing producer.
//
// NOT A MOUNTED ROUTE, DELIBERATELY. Every other write action in this module is a `Route`
// (method + path + handler) because it is reachable today from a live `rmd serve` console. This
// task's scope is the RECORD PRIMITIVE ONLY — the writer, the head-bound reader
// (`ledger.ts`'s {@link import("./ledger.js").riskOverrideFromLedger}), and the never-rotated
// registration (`RISK_OVERRIDE_RECORDED_STEP` in `DECISION_RELEVANT_LEDGER_STEPS`) — never the
// transport that calls it. A CLI flag (the `--override-capped-by` shape) or a panel route can
// call this function later; wiring either is a separate concern from making the record
// possible at all.
//
// RECORDS, NEVER GRANTS (design ix/x). This never closes the escalation issue itself
// (`/v1/escalation/mark-handled` already owns that check-off) and nothing in this codebase may
// read the row it writes to decide whether to dispatch or merge — the escalation still blocks
// and auto-merge still refuses no matter what this writes. See `riskOverrideFromLedger`'s own
// doc for that boundary.

/**
 * The operator-supplied half of a risk-override record — the escalation it answers (task id,
 * issue url, head sha), the judge's own verdict and confidence (copied VERBATIM off the
 * `risk_judge.decision`/`risk_judge.escalated` line being responded to, never re-derived), the
 * operator's disposition, and a closed-set reason class plus optional free text alongside it.
 */
export interface RiskOverrideRecordInput {
  taskId: string;
  issueUrl: string;
  headSha: string;
  verdict: RiskJudgeVerdictLabel;
  confidence: number;
  disposition: RiskOverrideDisposition;
  reasonClass: RiskOverrideReasonClass;
  reason?: string;
}

function validateRiskOverrideRecord(body: unknown): { error: string } | RiskOverrideRecordInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.taskId !== "string" || !body.taskId.trim()) return { error: "taskId is required" };
  if (typeof body.issueUrl !== "string" || !body.issueUrl.trim()) return { error: "issueUrl is required" };
  if (typeof body.headSha !== "string" || !body.headSha.trim()) return { error: "headSha is required" };
  if (body.verdict !== "low" && body.verdict !== "high") return { error: 'verdict must be one of "low", "high"' };
  if (typeof body.confidence !== "number" || !Number.isFinite(body.confidence) || body.confidence < 0 || body.confidence > 1) {
    return { error: "confidence must be a number between 0 and 1" };
  }
  if (typeof body.disposition !== "string" || !(RISK_OVERRIDE_DISPOSITIONS as readonly string[]).includes(body.disposition)) {
    return { error: `disposition must be one of ${RISK_OVERRIDE_DISPOSITIONS.join(", ")}` };
  }
  // The closed-set gate the design (vii) exists for: an unrecognised reasonClass is refused
  // HERE, before any write, never coerced or accepted as free text alongside a guessed class.
  if (typeof body.reasonClass !== "string" || !(RISK_OVERRIDE_REASON_CLASSES as readonly string[]).includes(body.reasonClass)) {
    return { error: `reasonClass must be one of ${RISK_OVERRIDE_REASON_CLASSES.join(", ")}` };
  }
  if (body.reason !== undefined && typeof body.reason !== "string") return { error: "reason must be a string" };
  return {
    taskId: body.taskId,
    issueUrl: body.issueUrl,
    headSha: body.headSha,
    verdict: body.verdict as RiskJudgeVerdictLabel,
    confidence: body.confidence,
    disposition: body.disposition as RiskOverrideDisposition,
    reasonClass: body.reasonClass as RiskOverrideReasonClass,
    reason: body.reason as string | undefined,
  };
}

export type RiskOverrideRecordResult = { ok: true } | { ok: false; error: string };

/**
 * Record how an operator handled a risk-judge escalation. FAIL LOUD, the same discipline every
 * route in this module already follows (module header): a malformed input is REFUSED and writes
 * NOTHING — an unrecognised `reasonClass` can never sneak a polluting row past validation, and a
 * caller can tell "refused" from "recorded" without inspecting the ledger.
 */
```

## buildDrainFeedbackRoute

Removed from lines 850-854 and 876-888.

```
  /** W1-T435: the STEERING NOTE — quoted verbatim into the next fix-rung dispatch by
   *  `operatorVerdictEvidence` (lib/sweep.ts) when `verdict` is `wrong`/`needs-follow-up`.
   *  Optional (a bare tap carries no note); a `good` verdict's note, if any, is still recorded
   *  for the learning limb but `operatorVerdictEvidence` never quotes it — praise never re-arms. */
  note?: string;
```

```
/**
 * POST /v1/drain/feedback — the post-drain rundown's one-tap operator verdict (W1-T141),
 * write-scoped. Tapping a rundown line's good/wrong/needs-follow-up, plus an OPTIONAL
 * steering note (W1-T435), writes an `operator_feedback` ledger record
 * `{taskId, verdict, drain_run_id, note, ts}` via `appendPanelLedger` — the SAME write path
 * every other panel action funnels through, never a second ledger writer. `note` is ledgered
 * VERBATIM, never truncated/paraphrased here — `MAX_STEERING_NOTE_CHARS` above is a request-size
 * refusal, not an in-flight edit. This is the labeled human signal the learning limb (W1-T87
 * success-mining, W1-T88 contradiction-detection) consumes: a judged outcome, not just a merge
 * count — and, for `wrong`/`needs-follow-up`, the fix rung's own steering input
 * (`operatorVerdictEvidence`, lib/sweep.ts): W1-T141's route finally gets both its writer and
 * its reader.
 */
```

## POST /v1/drain/kick + /v1/drain/run — section header

Removed from lines 908-915.

```
// ── POST /v1/drain/kick + /v1/drain/run (console UP NEXT write-actions) ──────
// fb-1784988460437-9daa9b. Both write a marker the daemon consumes at its next
// poll (never process management here) and ledger the console as actor (the
// arm-identity, applied at BIRTH — the origin is stamped into the marker now and
// carried to the daemon's consume-time outcome line). assertRunnable still gates
// on the daemon side, so a verify:human/blocked/stale-merged target is refused
// there with its named reason (rendered back via the ledger stream), not here —
// this endpoint only records the operator's intent.
```

## buildKickRoute

Removed from lines 929-934.

```
/**
 * POST /v1/drain/kick — the per-row "Run" button. Writes `KICK_REQUESTED-<taskId>`;
 * the daemon dispatches THAT task by id through its normal `assertRunnable`-gated path
 * at the next poll. Write-scoped; ledgers `console.kick_requested` (the birth line,
 * console as actor). The dispatch/refusal OUTCOME is the daemon's own consume-time line.
 */
```

## buildDrainNowRoute

Removed from lines 951-955.

```
/**
 * POST /v1/drain/run — the "Drain now" button. Writes `DRAIN_REQUESTED`; the daemon
 * runs one dispatch cycle immediately at its next poll. Write-scoped; ledgers
 * `console.drain_requested` (console as actor). No body required.
 */
```

## buildMergeHoldRoute

Removed from lines 1015-1019.

```
/**
 * Apply or release the EXISTING durable operator merge hold. HIGH tier means service.ts consumes
 * a fresh exact-payload confirmation nonce before this handler can parse or write anything.
 * Releasing only removes the refusal; this route never arms or performs a merge.
 */
```

## buildPanelActionRoutes

Removed from lines 1041-1058.

```
/**
 * Every panel write route, for a caller registering the full set at once.
 *
 * NOT THE PRODUCTION WIRING, AND DO NOT MAKE IT SO. `rmd serve` deliberately imports the ten
 * singular builders and calls them one at a time (serve.ts's `buildServeRoutes`) because they do
 * NOT all take the same deps: `buildAnswerQuestionRoute` is given a `questionDeps` rooted at
 * `questionsRoot`, while the rest take `fleetControlDeps` rooted at `fleetControlRoot`. This
 * function has only ONE `deps` to give, so mounting it wholesale would silently re-root
 * POST /v1/questions/answer onto the wrong directory. The original "(`rmd serve` wiring, later
 * work)" note on this doc invited exactly that; it is withdrawn.
 *
 * So this is a DECLARATION, not a registration — and the two lists drifted apart in silence
 * until recon-ER: this one carried `buildDrainFeedbackRoute` and serve.ts did not, so
 * POST /v1/drain/feedback 404'd on every running console while six tests POSTed to a server
 * built from THIS list and got real 200s. What keeps them in step now is
 * test/route-registration.test.ts, which requires every route declared anywhere in src/lib —
 * this list included — to answer on the real assembled server.
 */
```

## W1-T2696 — answering an escalation from the ping (section header)

Removed from lines 1086-1097.

```
// ── W1-T2696: answering an escalation from the ping ──────────────────────────
//
// Two routes, both selfAuthenticated (W1-T2568's seam): the operator's phone carries no bearer
// token, so the link's signature IS the authority and the handler verifies it itself.
//
// WHY THE GET NEVER CONSUMES. iMessage generates a preview for a URL it sends, which fetches it.
// A GET that consumed the link would burn every ping before the operator ever tapped it. So the
// GET verifies and renders a confirm page with no side effect, and only the POST consumes.
//
// INVARIANT: nothing is executed before signature, expiry and single-use all pass, and each
// refusal is ledgered with which one failed.
// FALSIFIER: test/escalation-answer-links.test.ts.
```

## EscalationLinkDeps.secret and .consume

Removed from lines 1103-1120.

```
  /**
   * Resolved LAZILY, on the first request that needs it — never when routes are assembled.
   *
   * TRAP: `loadEscalationLinkSecret` creates the secret on first read, so calling it at assembly
   * time makes standing up a server write a file. test/console-write-entry.test.ts asserts that
   * obtaining a grant creates no path under the root, and caught exactly that.
   *
   * Throwing here is a refusal, not a crash: the handler catches it and answers 503.
   */
  readonly secret: () => string;
  readonly now: () => number;
  /**
   * How the single-use marker is claimed. Injectable — and appended LAST so no positional caller
   * shifts — so a test can drive the check-then-act WINDOW deterministically, the same reason
   * fs-race-safe.ts's own {@link FsRaceSyscalls} exists. The losing arm is otherwise reachable
   * only by a real race between two taps.
   */
  readonly consume?: (root: string, signature: string) => boolean;
```

## buildEscalationLinkConfirmRoute

Removed from lines 1157-1162.

```
/**
 * GET /v1/escalation/answer — verify and show, never act.
 *
 * A refusal renders its reason so the operator learns whether the ping went stale, was already
 * answered, or did not verify at all.
 */
```

## buildEscalationLinkAnswerRoute

Removed from lines 1202-1208, plus three inline comments in its body (the "thread, never a direct
call" note, the "checked before consumed" note, and the "claimed before the append" note).

```
/**
 * POST /v1/escalation/answer — verify, claim the single-use marker, then execute.
 *
 * The marker is claimed BEFORE the option runs. Two taps racing therefore cannot both execute:
 * the loser's exclusive-create fails and it is refused `already-used`. The cost of that order is
 * that an option which throws has still burned its link, which is the right way round — a second
 * automatic execution of a fleet-halting option is worse than an operator re-raising it.
 */
```

```
      // The answer is recorded as a REPLY on the escalation's own thread — design (ii)'s "the
      // existing reply route" — never a direct call to the option's route. A link therefore
      // captures a decision; it never itself runs a skill or halts the fleet, which is what keeps
      // a one-tap grant proportionate to what a phone can safely carry.
```

```
      // CHECKED BEFORE THE LINK IS CONSUMED, deliberately. A refusal here is a wiring or store
      // fault, not the operator's doing, so burning their single-use link over it would cost them
      // the only answer path they had. Only once the answer can actually be recorded is the
      // marker claimed.
```

```
      // Claimed BEFORE the append, so two taps racing cannot both record: the loser's
      // exclusive-create fails and it is refused.
```
