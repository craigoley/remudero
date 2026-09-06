# Forensics: src/lib/feedback.ts

Every measured fact, incident and design argument the comments in `src/lib/feedback.ts` used to
carry, archived VERBATIM when that file's comments were compacted to the plain-language standard
(`docs/comment-standard.md`).

Nothing here is a rule. `feedback.ts`'s behaviour lives in the code and its tests, and each block
below is quoted exactly as it stood on `origin/main` at `49e429e3`, under a heading naming the
symbol it explained. The code keeps a one-line `// Why:` pointer wherever that history still
matters.

---

## Module header

`src/lib/feedback.ts:11-45` at `49e429e3`, 35 comment lines.

```
/**
 * `plan/feedback/` — the durable, diffable feedback inbox (MASTER-PLAN §7B, W1-T40).
 *
 * "Today the harness has no front door: every piece of operator feedback goes chat with an
 * external Architect... FEEDBACK IS AN ARTIFACT, NOT A COMMAND. `plan/feedback/` is a durable,
 * diffable inbox — one entry per item: `{id, ts, raw text, attachments[] (multimodal —
 * screenshots, terminal dumps, links), origin: cli|ui|issue, status:
 * new|grilling|proposed|accepted|rejected, proposal_pr}`. Captured async by `rmd feedback`
 * (W1-T40); never lost in a chat scrollback." [MASTER-PLAN §7B]
 *
 * This module's WRITE is plain filesystem I/O, no network, no LLM call — `rmd feedback`
 * always returns instantly and always works offline; that promise never changes. What DOES
 * follow the write, since W1-T243, is a best-effort attempt to LAND the entry onto
 * `origin/main` (see {@link "./feedback-landing.js".landFeedback}) — without it, `rmd triage`
 * (which deliberately reads from a fresh `origin/main` worktree, never a possibly-stale
 * `repoRoot`) could never see a freshly captured entry until a human hand-landed it via a
 * manual `git add`+commit+PR. Landing is swallowed on any failure (offline, no `gh`, no
 * network) — the local write already IS the durable buffer; landing merely gets the entry to
 * `origin/main` sooner. The INTAKE LOOP that reads this inbox and moves entries through
 * `grilling`/`proposed` (`rmd triage`, W1-T41) is a separate task; this module exposes
 * {@link setFeedbackStatus} as the write primitive that worker will call, but ships no CLI
 * surface for it — the inbox itself is browsable with plain `ls`/`cat`/`git diff` on
 * `plan/feedback/*.yaml`, which is the point of "diffable" (no bespoke reader required).
 *
 * ONE FILE PER ENTRY (not one big YAML list): matches "one entry per item" literally, and keeps
 * concurrent captures (an operator and the daemon both running `rmd feedback` at once) from
 * racing on a shared file — each entry only ever touches its own path.
 *
 * IMAGE ATTACHMENTS ARE WORKER-READABLE — VERIFIED, not assumed (LEARNINGS.md "Agent SDK tools &
 * the feedback front door"): a probe captured an entry with `--attach <png>`, then opened the
 * copied `plan/feedback/attachments/<id>/…` file with the Read tool and got back an accurate
 * description of its shapes/colors/text — confirming a triage worker (W1-T41) can act on a
 * screenshot attachment directly, with no OCR/vision wiring needed on this module's side; a
 * "terminal dump" attachment is plain text and needed no such probe.
 */
```

## FeedbackOrigin

`src/lib/feedback.ts:52-64` at `49e429e3`, 13 comment lines.

```
/**
 * `FeedbackOrigin` is the named closed enum above PLUS `issue#<n>`, `alert#<id>` and
 * `repair#<surface>` — machine-origin provenance for one specific managed-repo GitHub issue
 * (W1-T57), one specific GitHub alert (code-scanning/Dependabot/secret-scanning; W1-T56,
 * MASTER-PLAN §5D/§7B: "machine-origin feedback... flows through the §7B feedback inbox
 * (`origin: alert#<id>` / `origin: issue#<n>`)"), or one classified `sweep.disposed` surface
 * that RECURRED at or above policy threshold (W1-T905, "repair the instance, file the class" —
 * fb-1784842083584-6cc22a's second half: `src/lib/sweep.ts`'s `dueRepairFilings`, wired via
 * `SweepDeps.captureRepairFeedback` in `src/run-task.ts`'s `buildSweepEffects`). This is a
 * DIFFERENT axis than the named enum's "issue" value (a human capturing feedback that
 * references remudero's own tracker) — `issue#<n>`/`alert#<id>`/`repair#<surface>` instead name
 * WHICH managed-repo issue, alert, or classified surface produced this entry, so `rmd trace`
 * (W1-T43) can point straight back at it.
 */
```

## FEEDBACK_STATUSES

`src/lib/feedback.ts:88-101` at `49e429e3`, 14 comment lines.

```
/**
 * The status lifecycle a feedback entry moves through (§7B: capture -> triage -> gate), PLUS
 * `answered` (W1-T2278): the state a `grilling` entry advances to the moment a `replyTo` names
 * it and that reply is captured. This is a SEPARATE arm from the triage lifecycle's own
 * `grilling` -> `proposed` advance (a grill answer is not itself a proposal) — both are reachable
 * from `grilling`, and {@link setFeedbackStatus}'s own contract already leaves "which transition
 * is legal" to the caller, not to this list. `answered` is a genuine CLOSED state for the
 * question/answer exchange: once set, a second `replyTo` naming the same entry is refused for
 * exactly the same reason a `proposed`/`accepted`/`rejected` target already is (not parked at
 * `grilling`) — see `buildSubmitFeedbackRoute` in panel-graph.ts, the only place this status is
 * ever written, and always because an operator's own reply text just arrived, never on a timer
 * or a scheduler (W1-T2244 pins (ix)/(x): nothing here manufactures a decision on the operator's
 * behalf).
 */
```

## FeedbackEntry.reply_to

`src/lib/feedback.ts:113-123` at `49e429e3`, 11 comment lines.

```
  /**
   * The id of the `grilling` entry THIS entry answers, when this entry was captured via
   * `POST /v1/feedback`'s `replyTo` (W1-T2278) — carried as a FIELD on the record, the same way
   * every other edge on this entry (`proposal_pr`, `upstream.pr_url`) is a field rather than
   * prose folded into `raw`. `null` for a submission carrying no reply reference — the
   * unchanged, pre-W1-T2278 shape. Set ONCE at capture time and never revised afterward: an
   * answer never gets re-parented. Optional (like `summary`/`expansion`/`upstream` below) so
   * every FeedbackEntry fixture predating this task stays a valid literal with no edit required;
   * a written-by-{@link captureFeedback} entry always carries it explicitly (`null` when absent),
   * never `undefined`.
   */
```

## FeedbackEntry.answered_by

`src/lib/feedback.ts:125-132` at `49e429e3`, 8 comment lines.

```
  /**
   * The id of the entry that answered THIS one — the reverse edge of `reply_to` (W1-T2278), so a
   * thread is enumerable from the ANSWERED end too, not only by reading a reply's own
   * `reply_to`. Set exactly once, by {@link setFeedbackStatus} in the same call that advances
   * this entry to `status: "answered"`; `null`/absent otherwise (every entry never replied to,
   * which is every entry captured before this task and every entry that is not itself parked
   * `grilling` and answered).
   */
```

## FeedbackEntry.summary

`src/lib/feedback.ts:136-144` at `49e429e3`, 9 comment lines.

```
  /**
   * A machine-written plain-language decision card, generated ONCE when this entry is set to
   * `status: proposed` (see {@link proposeFeedbackWithSummary}) and cached here thereafter — a
   * console render NEVER invokes the summarizer (W1-T313). `null` until proposed, or when a
   * summarizer failed/was unavailable/returned a record that failed
   * {@link validateDecisionSummary}: the raw `raw` text above stays byte-identical and
   * renderable either way — fail-open, never lossy (MASTER-PLAN §7B amendment; the entry shape
   * gains this ONE field, every existing consumer of the other fields is untouched).
   */
```

## FeedbackEntry.expansion

`src/lib/feedback.ts:146-152` at `49e429e3`, 7 comment lines.

```
  /**
   * The four-section CLAIM/EVIDENCE/RECON/FALSIFYING CHECK expansion of `raw` (W1-T350),
   * generated at PREVIEW time (before this entry ever existed) and attached at capture — never
   * regenerated on render, exactly `summary`'s own discipline above. `undefined`/`null` for
   * every entry captured without a preview (the CLI, machine-origin intake, or the console's
   * own file-raw escape) — `raw` stays byte-identical and renderable either way.
   */
```

## FeedbackEntry.upstream

`src/lib/feedback.ts:154-163` at `49e429e3`, 10 comment lines.

```
  /**
   * Present ONLY when a home-repo pointer (W1-T397, `.remudero/home-repo.json`) is configured
   * AND this checkout is not itself the home repo — the no-pointer case and the
   * local-checkout-IS-home case both leave this key ABSENT, so the entry stays byte-identical
   * to a pre-W1-T397 capture either way (design point iv: upstreaming a self-target must be a
   * true no-op). `status: "landed"` once a PR against the home repo carries this entry;
   * `"unreachable"` when the attempt failed for any reason (network, `gh`, or even a
   * malformed pointer file) — the entry is captured LOCALLY either way, never dropped, and
   * `error` names why so a failure is greppable straight out of the entry file.
   */
```

## FeedbackEntry.submission_key

`src/lib/feedback.ts:171-181` at `49e429e3`, 11 comment lines.

```
  /**
   * W1-T2302: the console-minted per-submission key `POST /v1/feedback` carried on this
   * capture, when the caller supplied one — the identity a REPEAT of this exact submission (a
   * reload, a second tab, a retried fetch) is recognised BY, distinct from `id` (a fresh id is
   * still minted every capture; this is a separate field precisely because re-using `id` for
   * dedup would OVERWRITE the entry, see {@link captureFeedback}'s doc). A DURABLE field on the
   * entry rather than a second store: readable by the same {@link listFeedback} every other
   * caller already runs, survives a daemon restart, and needs nothing new to go stale. `null`/
   * absent for every entry captured without one (the CLI, machine-origin intake, or a console
   * call that predates this task) — `raw` and every other field stay byte-identical either way.
   */
```

## FeedbackEntry.thread_id

`src/lib/feedback.ts:183-194` at `49e429e3`, 12 comment lines.

```
  /**
   * W1-T2496: the escalation thread id (`inbox-thread.ts`'s {@link deriveThreadId}) this entry
   * REPLIES TO, when captured via `POST /v1/escalation/reply` (panel-actions.ts). This is a
   * DIFFERENT edge than `reply_to` above — `reply_to` names another `plan/feedback/<id>.yaml`
   * entry parked `grilling` (the W1-T2278 grill-answer flow); `thread_id` names a thread in
   * `inbox-thread.ts`'s own JSONL store, which an ESCALATION (`escalate.ts`, never a feedback
   * entry) opened. Carrying it as a field — not folded into `raw` prose — is what makes this
   * entry findable by thread the same way `rmd trace`/a future console can already find one by
   * `reply_to`/`submission_key`: a plain field scan, no bespoke parser. `null`/absent for every
   * entry captured without one (every caller predating this task, and every entry this task's
   * own route does not touch) — `raw` and every other field stay byte-identical either way.
   */
```

## Decision summaries banner

`src/lib/feedback.ts:198-206` at `49e429e3`, 9 comment lines.

```
// ── Decision summaries (W1-T313) ─────────────────────────────────────────────
//
// "every decision surface renders raw triage-architect analysis" (operator directive,
// fb-1784770111145-cf7c24): a triage proposal and an escalation both carry engineering prose
// written for a machine/plan reader, not the console the operator actually rules from. A
// DecisionSummary is a small, STRUCTURED record — never a blob of prose — so a renderer can
// lay it out and {@link validateDecisionSummary} can bound it before anything trusts it.
// Written ONCE at creation time by the producer (a feedback proposal here, an escalation in
// escalate.ts) and cached with the artifact; a render path NEVER calls the summarizer again.
```

## Real decision-summary rung banner

`src/lib/feedback.ts:313-325` at `49e429e3`, 13 comment lines.

```
// ── Real decision-summary rung — routed via mounts.yaml, never a hard-coded model id ────────
//
// Mirrors risk-judge.ts's testable split exactly: a pure prompt builder + a pure spawn-args
// builder are unit-tested; the actual spawn ({@link realDecisionSummarizer}) is untested by
// unit, like every other real spawn in worker.ts — {@link buildDecisionSummaryPrompt} and
// {@link validateDecisionSummary} carry the testable contract.
//
// {@link resolveDecisionSummaryMount} reuses risk-judge.ts's `resolveRiskJudgeMount` rather
// than adding a new mounts.yaml row: it already scans the WHOLE routing table for the
// cheapest configured tier with no hardcoded model name — exactly "the cheapest correct host"
// the design calls for, and a decision summary is the same shape of cheap, structured,
// no-tool judgment call the risk judge already is (VERIFIED at source before reuse, per this
// task's own design note).
```

## Feedback expansions banner

`src/lib/feedback.ts:392-405` at `49e429e3`, 14 comment lines.

```
// ── Feedback expansions (W1-T350) ────────────────────────────────────────────
//
// "Whenever I submit feedback in the console, it probably needs to go through an interpreter —
// that will translate my simple feedback into an actual prompt that can be sent to the agent"
// (operator directive, oper#needs-me-filings-2026-08-04). The precedent corpus (14 feedback
// entries landed 2026-08-03/04) writes an ALL-CAPS falsifiable headline, measured evidence with
// verbatim figures/symbols/PR numbers, then two literal markers — "RECON:" and "Falsifying
// check:" — naming what a downstream pass must establish and what would retire the entry. A
// FeedbackExpansion is that skeleton as FOUR NAMED, independently-validated fields — never raw
// prose with embedded markers a reader has to parse back out — mirroring DecisionSummary's own
// "a validator can check" discipline above. `evidence` and `recon` may legitimately be EMPTY:
// the honesty constraint is that a specific the operator did not verify belongs under `recon`
// as a directive, never invented into `evidence` as a stated fact — a short operator note may
// carry no measured evidence at all.
```

## realFeedbackExpander

`src/lib/feedback.ts:565-577` at `49e429e3`, 13 comment lines.

```
/**
 * Wire a real {@link FeedbackExpanderDeps.expand} to an actual worker spawn — mirrors
 * {@link realDecisionSummarizer} exactly. Untested by unit (it shells out via the SDK, same as
 * every other real spawn in worker.ts).
 *
 * NO PRODUCTION CALLER WIRES THIS YET — this task builds the testable seam only, exactly the
 * W1-T313→W1-T348 precedent (a validated, injectable rung ships first; wiring a real default
 * into `rmd serve`'s boot path — mounts.yaml resolution, a rendered worker settings file — is a
 * follow-up once the round trip above is proven). `PanelGraphDeps.expandFeedback` is optional
 * for exactly this reason: undefined in production today means POST /v1/feedback/preview
 * always resolves `{ expansion: null }`, which is itself the documented fail-open behavior, not
 * a broken state.
 */
```

## Upstream home-repo routing banner

`src/lib/feedback.ts:700-718` at `49e429e3`, 19 comment lines.

```
// ── Upstream home-repo routing (W1-T397) ─────────────────────────────────────
//
// "an instance working on another codebase that finds a defect in rmd ITSELF files that
// defect into that other codebase's plan/feedback/, where nobody who maintains rmd will ever
// read it" (task rationale). `.remudero/home-repo.json` names the ONE repo `rmd feedback`
// reports upstream TO — the inverse of `.remudero/managed-repos.json` (WHICH repos this
// instance is responsible FOR). It reuses that file's validation discipline (fail loud on a
// malformed pointer, {@link loadHomeRepoPointer}) and its safe-empty default: a MISSING file
// means no pointer is configured, which resolves to today's local-only behavior — nothing
// regresses for the home instance itself, which never needs to ship this file at all.
//
// TRANSPORT (design point ii) is a pull request against the home repo adding this ONE entry's
// YAML under `plan/feedback/`, built entirely via `gh api` against the home repo's GitHub
// remote — never a local clone of it, since this checkout may share no git history with home
// at all. It NEVER blocks or fails capture (design point iii): the entry is always written to
// THIS checkout's own `plan/feedback/` first (unchanged from today); the upstream attempt only
// ever adds an `upstream` field to that same local entry recording what happened, success or
// failure, and is never allowed to escape {@link captureFeedback} as a thrown error.
```

## CaptureFeedbackOptions.expansion

`src/lib/feedback.ts:907-915` at `49e429e3`, 9 comment lines.

```
  /**
   * W1-T350: the four-section expansion of `raw`, already produced and confirmed by the
   * caller (the console's own preview→arm→confirm round trip, panel-graph.ts) BEFORE this
   * capture ever runs. `undefined`/omitted (every non-console caller: the CLI, machine-origin
   * intake) or `null` (the console's own file-raw escape, or a confirm whose preview never
   * produced one) both leave the entry's `expansion` at `null` — `raw` is byte-identical and
   * files unchanged either way. This function never generates one itself: expansion is a
   * PREVIEW-time concern, never something a plain capture call triggers on its own.
   */
```

## CaptureFeedbackOptions.replyTo

`src/lib/feedback.ts:917-924` at `49e429e3`, 8 comment lines.

```
  /**
   * W1-T2278: the id of the `grilling` entry this capture answers, ALREADY VALIDATED by the
   * caller (panel-graph.ts's `buildSubmitFeedbackRoute` reads the target and confirms it is
   * parked `grilling` before this function ever runs — this function itself does no such
   * lookup, mirroring `expansion` above: the caller assembles and validates, this module only
   * stores). `undefined`/omitted leaves `reply_to: null` on the written entry — a submission
   * carrying no reply reference is byte-identical to today's shape plus this one added field.
   */
```

## CaptureFeedbackOptions.threadId

`src/lib/feedback.ts:926-935` at `49e429e3`, 10 comment lines.

```
  /**
   * W1-T2496: the escalation thread id (`inbox-thread.ts`'s {@link deriveThreadId}) this capture
   * answers, ALREADY VALIDATED by the caller (panel-actions.ts's `buildEscalationReplyRoute`
   * confirms a thread by this id already carries at least one message before this function ever
   * runs — this function itself does no such lookup, mirroring `replyTo` above: the caller
   * validates, this module only stores). `undefined`/omitted leaves `thread_id: null` on the
   * written entry — a submission carrying no thread reference is byte-identical to today's shape
   * plus this one added field.
   */
```

## CaptureFeedbackOptions.submissionKey

`src/lib/feedback.ts:943-955` at `49e429e3`, 13 comment lines.

```
  /**
   * W1-T2302: a per-submission key minted by the CALLER (the console, `POST /v1/feedback`) that
   * identifies ONE operator submit action — never derived from `raw` (two deliberately separate
   * submissions carrying identical text must still each file, design point (iv), which a
   * text-derived key could not tell apart). When given and an entry ALREADY carries this exact
   * key ({@link findFeedbackBySubmissionKey}), this call is a REPEAT of a submission that already
   * filed: it returns that existing entry completely UNTOUCHED — no write, no re-land, no
   * re-upstream-attempt — even when that entry's `status` has since moved on from `new` (the
   * trap named in this function's own doc: re-using `id` for this purpose would silently reset
   * an already-triaged entry). `undefined` (every non-console caller, and a console call with no
   * key) always files a fresh entry, exactly today's behavior.
   */
```

## captureFeedback

`src/lib/feedback.ts:973-997` at `49e429e3`, 25 comment lines.

```
/**
 * Capture one feedback item: writes `plan/feedback/<id>.yaml` with `status: new`, copying any
 * local-path attachments alongside it. The write itself is synchronous filesystem I/O only —
 * no network, no LLM — so a headless `rmd feedback` call still returns effectively immediately
 * (ASYNC CAPTURE: the operator is never blocked waiting on triage, which runs later and
 * separately, W1-T41).
 *
 * Immediately after the write, this ALSO attempts to LAND the entry onto `origin/main` via the
 * ONE choke point {@link landFeedback} (W1-T243) — every caller of this function inherits the
 * bridge by construction, with no per-call-site wiring. Landing is best-effort and NEVER
 * throws: a failure here (offline, no `gh`, no network) never fails the capture — the write
 * above already is the durable record; landing merely gets it onto `origin/main` sooner so
 * `rmd triage` can act on it without a human hand-landing it first.
 *
 * After the local write and the local landing attempt, this ALSO checks for a home-repo
 * pointer (W1-T397, {@link loadHomeRepoPointer}) and, when one is configured and this checkout
 * is not itself the home repo, attempts to open a pull request against the home repo carrying
 * this same entry ({@link openUpstreamFeedbackPr}) — so an instance working on a DIFFERENT
 * codebase files an rmd defect where an rmd maintainer will actually read it, instead of into
 * that codebase's own `plan/feedback/`. Like landing, this is best-effort and NEVER throws:
 * any failure (no pointer, self-target, network, `gh`, even a malformed pointer file) leaves
 * the entry captured locally with an `upstream` field recording what happened — never dropped,
 * never blocking the run that produced it. This step takes no lock and writes nothing outside
 * this one entry file: a reporting-only instance needs no arbiter.
 */
```

## setFeedbackStatus

`src/lib/feedback.ts:1083-1110` at `49e429e3`, 28 comment lines.

```
/**
 * Move a feedback entry to a new lifecycle status (the write primitive `rmd triage`, W1-T41,
 * uses to mark `grilling`/`proposed`, and the gate uses to mark `accepted`/`rejected`). Rejects
 * an unknown status; does not otherwise constrain which transition is legal — the state machine
 * that decides WHEN each transition is appropriate belongs to the intake loop that calls this,
 * not to the inbox's storage layer.
 *
 * `opts.land`, when passed, routes the write itself through {@link landFeedbackStatusContent}
 * INSTEAD OF the normal local `writeFileSync` (W1-T191, write site 2) — deliberately, not an
 * add-on: `id`'s entry is already TRACKED in git (it was captured+landed+merged earlier), so a
 * normal local write here would leave it `M`-modified in `checkCliFreshness`'s `git status
 * --porcelain` — the exact "checkout dirties, auto-sync switches itself off" defect this task
 * removes — even though `landFeedback`'s bridge would separately get the SAME content onto
 * `origin/main`. See {@link "./feedback-landing.js".landContent}'s doc for why landing
 * afterward doesn't undo a local write's dirt (the bridge never touches the working tree
 * either way, by design).
 *
 * This is OPT-IN, not automatic for every caller, unlike `captureFeedback`'s unconditional
 * `landFeedback` call: `rmd triage` (run-task.ts) calls this against a worker's OWN worktree
 * and immediately `git add`+commit+push+`gh pr create`s it for real, so it needs the REAL
 * local write (that commit reads the working tree) and must never take this branch. The ONE
 * caller this exists for is the console's `POST /v1/feedback/decision` route
 * (panel-graph.ts), which writes straight against the daemon's own checkout and has no commit
 * path of its own — that route passes `{ land: {} }` explicitly. Trade-off: a caller that
 * reads `root`'s own `plan/feedback/<id>.yaml` again right after (e.g. the console's own list)
 * won't see the flip until this checkout's next self-sync past the landing PR's merge — out of
 * scope for this task's acceptance bar (a clean tree, not read-your-own-write).
 */
```

## setFeedbackStatus, opts.answeredBy

`src/lib/feedback.ts:1119-1126` at `49e429e3`, 8 comment lines.

```
    /**
     * W1-T2278: the id of the entry that just answered THIS one — passed ONLY by
     * `buildSubmitFeedbackRoute` (panel-graph.ts) in the same call that advances a `grilling`
     * target to `status: "answered"`. `undefined` (every other caller — `rmd triage`, the
     * accept/reject decision route) leaves whatever this entry already had, mirroring
     * `summary`'s own "unset means untouched" discipline immediately below.
     */
```
