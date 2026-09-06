# risk-judge.ts forensics

The measured forensics, incident narratives and design arguments removed from
`src/lib/risk-judge.ts` when its comments were compacted to the plain-language standard.
Every block below is the removed text verbatim, marker characters stripped and nothing
else changed. Headings name the symbol the text explained; the code keeps a one-line
`Why:` pointer where the history mattered. Base revision: origin/main at
c185258e295d83d32371612edc2c39bde5d0fd4e; the line numbers below are that revision's.

## Module header

### Base lines 5-63 — Risk judge — P34 clause (b)…

Risk judge — P34 clause (b), MASTER-PLAN §4B/§9, W1-T248.

A lightweight judge ON THE DISPATCH PATH that assesses each CANDIDATE CHANGE
(never the static `task.risk` field — that field is a SIZING artifact set by
subsystem-span counting, W1-T5/§9, and says nothing about a change's danger;
{@link RiskJudgeInput} has no field that could carry it, so a caller cannot
leak it in even by mistake, the same by-construction discipline
flight-judge.ts uses for the worker's own narration).

DECISION SHAPE: low-risk-and-confident PROCEEDS; high-risk OR
LOW-CONFIDENCE ESCALATES for manual input with the OBSERVED blocker named
(the W1-T186 emitter discipline: name what was actually observed, never an
inferred symptom). Judgment (the verdict) and action (proceed/escalate) are
kept SEPARATE — {@link planRiskJudgeAction} is a pure function, so the
verdict->action mapping is unit-testable with no LLM call inside it at all
(Standing rule 12, mirroring flight-judge.ts's `planJudgeAction` and
risk-score.ts's `planRiskGate`).

JUDGE-UNAVAILABLE (a spawn error, a timeout, an unparseable response) falls
back to ESCALATE and NEVER silent-proceeds — the cannot-observe->wait
polarity (W1-T130), applied to the judge itself. This is enforced inside
{@link assessRisk} itself (not left to callers to remember), so every reuse
site — dispatch today, P28's graduated auto-ratification tomorrow — gets
the fail-closed guarantee for free.

STABLE ON UNCHANGED INPUT (W1-T178 doctrine, applied here as: the SAME
candidate change assessed twice yields the SAME verdict): a live judge is
an LLM call and cannot be trusted to reproduce bit-for-bit, so
{@link assessRisk} accepts an optional {@link RiskJudgeCache} keyed on a
canonical serialization of the input ({@link canonicalRiskJudgeInputKey}) —
once a candidate change has been judged, re-assessing the IDENTICAL input
returns the cached verdict rather than risking a flapped re-judgment
(mirrors review.ts's W1-T178 verdict-stability rule: a prior verdict is
reused unless the input actually changed).

VERDICT + REASONS + CONFIDENCE are ledgered VERBATIM per decision (round
ii) — {@link runRiskJudge} writes one `risk_judge.decision` ledger line
carrying all three fields untouched, so a numeric confidence threshold can
be derived from accumulated data later.

MOUNT: the judge runs on the CHEAPEST configured tier (haiku-class)
resolved from mounts.yaml (W1-T5) — {@link resolveRiskJudgeMount} scans the
routing table's own data (`tiers`/`efforts` orderings + every configured
mount) rather than hardcoding a model name, so it stays correct as the
table's lineup shifts (mirrors mounts.ts's own "the ordering is what
matters, not the absolute lineup" design).

REUSABLE BY CONSTRUCTION (for P28's graduated auto-ratification):
{@link assessRisk}'s interface takes `{change, gatesState, planContext}`
and returns `{verdict, reasons, confidence}` with NO dispatch-only
coupling — it never imports escalate.ts, run-task.ts, or anything
dispatch-specific. The dispatch-specific orchestration (ledgering, calling
escalate.ts) lives one layer up in {@link runRiskJudge}, which takes those
as INJECTED dependencies (mirrors flight-judge.ts's `FlightJudgeDeps`
injection point) — a second caller (P28) can reuse {@link assessRisk}
directly, or wrap it in its own orchestrator, without carrying any of this
module's dispatch-path assumptions.

## RiskJudgeChangeView

### Base lines 94-114 — A BOUNDED, REST-sourced view…

A BOUNDED, REST-sourced view of the change's ACTUAL diff shape (W1-T1031 — "round 2" of
W1-T454's Option A, Option B having shipped as #1740). Distinct from {@link
RiskJudgeChange.files}, which is the caller's DECLARED file list (a shard's `files:`, or
whatever a caller supplies) — this task's own measurement found that list insufficient: a
description that correctly NAMES the defect it removes reads to the judge exactly like a
description that INTRODUCES one, because nothing about the change's real shape was ever
shown (10/75 `risk_judge.decision` rows escalated, 9 merged anyway, none prevented anything;
three same-day escalations on implementations whose descriptions named their own subject).

CAPPED at {@link RISK_JUDGE_CHANGE_VIEW_FILE_CAP} files via {@link boundRiskJudgeChangeView}
— design clause (iii): "a judge that times out on large changes is worse than one that
misreads small ones", so the bound is the deliverable, not the diff. `truncated` says so
honestly when the cap actually fired, the same discipline {@link evidenceQualifiedReason}
already applies to the judge's own output — never a silent drop.

STILL NOT A DIFF. `buildRiskJudgePrompt`'s "no patch, no hunks, no code" instruction
(W1-T454) stays true with this field populated — see that function's own doc. This task
does not touch {@link evidenceQualifiedReason}: a bounded view is still not the whole
patch, and the reason text must keep saying so (design clause vii).

## RISK_JUDGE_CHANGE_VIEW_FILE_CAP

### Base lines 122-133 — The file-count cap {@link boundRiskJudgeChangeView}…

The file-count cap {@link boundRiskJudgeChangeView} enforces. The judge's mount resolves to
the CHEAPEST configured tier ({@link resolveRiskJudgeMount}) — this repo's own mounts.yaml
puts that floor at 40,000 tokens of context (haiku/low). One rendered line per file
(`path: +N/-M`) runs well under 100 characters even for a long path, so 60 files caps this
section at roughly 6,000 characters — under 2,000 tokens, a small fraction of the floor —
while comfortably covering every shard this fleet has filed (`files:` in plan/tasks.d/ is
almost always 1-4 paths; W1-T1031's own declared list is 3). A PR that genuinely touches
more than 60 files (a vendored dependency bump, a mass rename) is exactly the shape a
line-count summary stops being useful for anyway — the honest `truncated` flag is preferable
to either silently dropping files or letting one outlier PR inflate every prompt after it.

## RiskJudgeInput

### Base lines 178-189 — The reusable input shape…

The reusable input shape (acceptance criterion 6): `{change, gatesState, planContext}`.

`prNumber`/`headSha` (W1-T970) are OPTIONAL and dispatch-only — never rendered into the
judge's prompt ({@link buildRiskJudgePrompt} reads only `change`/`gatesState`/`planContext`,
unchanged) and never required by a reuse site (P28's caller simply omits them, exactly as
acceptance-6's "callable with only {change, gatesState, planContext}" test already pins).
They exist so {@link runRiskJudge} can write a SHA-KEYED `risk_judge.escalated` row: the
sweep's arming predicate (src/lib/sweep.ts's `priorActionsFromLedger`) has no other way to
learn which PR/head a refusal binds to, and a refusal it cannot bind to a head is a refusal
the next sweep pass silently erases. THE CALLER MUST SUPPLY THE HEAD IT ACTUALLY ASSESSED —
never a re-read at write time — because a refusal keyed to a head the judge never saw is
worse than none.

## MALFORMED_RESPONSE_VERDICT

### Base lines 368-381 — FAIL-CLOSED default once every…

FAIL-CLOSED default once every bounded retry ({@link RISK_JUDGE_MAX_ATTEMPTS},
{@link realRiskJudge}) has still produced no parseable `RISK_VERDICT` — mirrors
flight-judge.ts's `FAIL_CLOSED_VERDICT` and review.ts's "never silently proceed" doctrine: an
unreadable judge response is itself evidence the decision needs a human, not a reason to wave
it through. `confidence: 0` (never 1, W1-T2212 design (iv)) — this judge never READ a verdict,
so it must use the SAME "never assume high confidence that was never stated" default
{@link parseRiskJudgeResponse}'s own parsed path already uses for an absent
`RISK_CONFIDENCE`, not the opposite extreme. The reasons text names this a MALFORMED RESPONSE
explicitly, apart from an adverse judgment (acceptance criterion 6) — the exact confusion
issue #2696's title (`ESCALATED (high, confidence 1.00)`) caused when this was 1. Distinct from
{@link FAIL_CLOSED_VERDICT} above (the OLD one-shot contract's unchanged fallback): ONLY
{@link realRiskJudge}'s bound-exhausted branch ever returns this one.

## evidenceQualifiedReason

### Base lines 409-426 — W1-T454: {@link RiskJudgeChange}…

W1-T454: {@link RiskJudgeChange} carries only a free-text `description` and a
`files` path list — never a patch — so every reason a LIVE judge call produces is
necessarily an INFERENCE from that text, not an observation of code. Issue #1723
printed four such inferences in the grammar of observations ('Unspent nonces ARE
never deleted') against a diff that refuted every one, because nothing forced the
printed reason to say what it actually rests on. This wraps each reason with its
true evidence basis BY CONSTRUCTION — a deterministic string transform downstream
of the judge's own text, not a prompt instruction it could ignore or comply with
inconsistently — so the text a human reads in the escalation is honest even when
the judge's own prose is not.

The internal fail-closed reasons ({@link FAIL_CLOSED_VERDICT}, {@link MALFORMED_RESPONSE_VERDICT}
and the catch branch in {@link assessRisk}, all prefixed "judge ...") are exempt: they already
truthfully name their OWN basis — the judge's unavailability or unparseable
output — not a claim about the change, so qualifying them again would be noise
at best and misleading at worst (they have nothing to do with the description).

## RiskJudgeSpend

### Base lines 566-578 — W1-T2383 (rank 1) — WHAT ONE…

W1-T2383 (rank 1) — WHAT ONE RISK-JUDGE JUDGMENT COST, carried from the spawn that paid it to
the `risk_judge.decision` row that reports it.

THE ROW EXISTS AND THE FIGURE DOES NOT: measured 2026-08-27, 276 risk-judge rows (249 decisions,
27 escalations) carry no cost and no mount, so {@link resolveRiskJudgeMount}'s DELIBERATE choice
of the cheapest configured tier is a design decision whose consequence nobody can read. This
type is what makes it readable; it changes no verdict, no threshold and no mount.

THE CAP RIDES BESIDE THE COUNT, never instead of it — the same W1-T2238/W1-T303 discipline
`WorkerResult.maxTurns` already records: a historical row must stay checkable against its own
cap after `mounts.yaml` moves.

## realRiskJudge

### Base lines 802-818 — Build a `judge` function…

Build a `judge` function ({@link RiskJudgeDeps.judge}) wired to a real spawn — the production
wiring for {@link assessRisk}/{@link runRiskJudge}.

THE RETRY RE-REQUESTS, IT NEVER RE-ASKS (W1-T2212 design (ii)): {@link buildRiskJudgeSpawnArgs}
is called EXACTLY ONCE, before the loop, and the SAME resulting args value (prompt included)
is handed to `spawn` on every attempt — nothing about the request varies between them. Only
{@link RiskJudgeParseOutcome}'s `unparseable` arm is reachable from `parseRiskJudgeResponse`
({@link parseRiskJudgeResponse}) is retried, bounded at {@link RISK_JUDGE_MAX_ATTEMPTS}
(design iii); a PARSED verdict — `low` or `high` — returns immediately on the FIRST attempt
and is never retried (design vi: "No retry on any parsed verdict, adverse or not"). At the
bound, {@link MALFORMED_RESPONSE_VERDICT} is returned — still fail-closed to ESCALATE, exactly
as a single unparseable response always has. `opts.log`, when supplied, ledgers one row per
attempt (design iii: "each attempt writes its own ledger row so the count is auditable after
the fact rather than inferred") — optional and no-op by default so an existing caller that
supplies no `log` is byte-identical to before this parameter existed.
