# Forensics: src/lib/task-linter.ts

Every measured fact, incident and design argument the comments in `src/lib/task-linter.ts` used to
carry, archived VERBATIM when that file's comments were compacted to the plain-language standard.

Nothing here is a rule. The linter's behaviour lives in the code, and each block below is quoted
exactly as it stood on `origin/main` at `ea02cc83`, under a heading naming the symbol it explained.
The code keeps a one-line `Why:` pointer wherever the history still matters.

## module header

Base revision `ea02cc83`, line 30, 54 comment lines.

```
/**
 * Deterministic task linter (MASTER-PLAN §5C Layer A). NO LLM — a PURE function
 * over a loaded {@link Task}/{@link Plan}, no I/O, no side effects. Catches the
 * class of malformed task that reached a worker four times (W1-T6, W1-T9, and
 * W1-T12 twice-over) and burned budget before a human noticed: over-scoping
 * (Rule 19), headless-unfitness (Rule 18), vibe proofs, a proof that CANNOT
 * EXECUTE at all (the dead proof floor, moratorium finding 9, W1-T246), a
 * dialect-prefixed proof that promises executability but names no resolvable
 * artifact (the W1-T100 0/3, W1-T101), a proof that names a path OUTSIDE the
 * task's own declared `files:` (W1-T310 — the scope guard then refuses the
 * branch AFTER the work is done), an ALREADY-MERGED task's criteria being
 * amended with no follow-up filed in the same PR (W1-T180 — MERGED is terminal,
 * so the drain and the retro sweep both skip it and the amendment would
 * otherwise orphan silently), missing provenance (Rules 16/17), and a
 * ruling-shaped task (its `files:` includes DECISIONS.md) filed verify:auto —
 * a worker's proof that a ruling was WRITTEN is not an operator RATIFYING it
 * (W1-T326, #1302/#1303).
 *
 * Wired at TWO points, both FAIL-CLOSED — EXCEPT post-merge-amendment, which is
 * CI-only (see below):
 *   (i)  a CI check on any PR that edits plan/tasks.yaml (`rmd lint-plan`, see
 *        run-task.ts's `lintPlanCommand` + .github/workflows/ci.yml's `lint-plan`
 *        job, aggregated into the required `ci-gate` context). Only THIS call
 *        site supplies `opts.postMergeAmendment` (it alone has a `--base` diff
 *        and derived merge state to inject) — the check is a no-op wherever
 *        that context is absent.
 *   (ii) a PRE-DISPATCH guard in `rmd run-task` (and therefore `rmd drain`, which
 *        dispatches every task through the same `runTask` path) — a task that
 *        fails a BLOCKING check is NEVER dispatched: `verdict=blocked_illformed`,
 *        no worker spawned, no inflight lock even taken (see run-task.ts,
 *        `assertLintClean` called immediately after `assertRunnable`). Post-
 *        merge-amendment needs no wiring here: a MERGED task is never dispatched
 *        in the first place (the drain's own `if (isMerged(t.id)) continue`).
 *
 * A BLOCKING violation refuses dispatch. A WARN violation is visibility-only and
 * never blocks — budget-sanity always warns; proof-dialect and proof-resolvability
 * warn instead of blocking ONLY at the pre-dispatch call site (`opts.proofDialect:
 * "warn"` / `opts.proofResolvability: "warn"`, so the legacy backlog authored
 * before either check existed does not brick overnight), proof-dialect always
 * warns (regardless of that option) for a `unit test:` proof whose body reads as a
 * runtime narrative rather than a literal test-title substring, and proof-scope
 * (W1-T310) warns by default (`opts.proofScope`, default "warn") EXCEPT one
 * conjunction it auto-escalates to "block" (W1-T2287: mis-declared, absent at head,
 * `verify: auto` — see that check's own module comment for why), and
 * dispatch-priority (W1-T422) always warns, unconditionally, like budget-sanity.
 * advisory-routing (W1-T519) is WARN-only BY CONSTRUCTION — it carries no `opts` severity
 * knob at all, anywhere, the only violation family with that property: a task whose title,
 * rationale or note names a security-shaped weakness (auth, token/credential, secret,
 * sandbox/containment, route-scope enforcement, prompt-injection) draws a warn pointing at
 * SECURITY.md's private advisory path, because filing a task shard IS publishing the finding
 * on this public repo before any fix lands — but the fleet cannot itself act on a finding held
 * in a private advisory (loadPlan only reads plan/tasks.d/ on origin/main), so the routing
 * decision stays the operator's alone and this check can never withhold a task from dispatch.
 */
```

## SUBSYSTEM_LEXICON

Base revision `ea02cc83`, line 144, 12 comment lines.

```
/**
 * Known cross-cutting subsystem nouns, checked against acceptance criteria text
 * for a task that names a module OUTSIDE its `files:` list (or carries none at
 * all — W1-T12's original definition had no `files:` field). DATA, like the
 * headless-fitness lexicon below — it grows as the retro/Architect find a new
 * pattern, never by editing the check logic. Deliberately narrow: each entry is
 * a DISTINCTIVE noun for a real remudero subsystem, not a generic English word
 * (a naive "every src/lib basename as a keyword" scan false-positives on
 * ordinary prose — e.g. "plan/tasks.yaml" appears in nearly every task and
 * would spuriously tag the `plan` module; "reviewer"/"review-gate" would tag
 * `review` on W1-T3E's single-concern reviewer-rubric task).
 */
```

## subsystemsOf

Base revision `ea02cc83`, line 193, 24 comment lines.

```
/**
 * W1-T2525 — `ownFalsifierSlug`: THIS task's own shard filename slug (the same fact {@link
 * LintOpts.duplicateSlug} already carries for {@link duplicateTitleViolations}), so THIS task's
 * own falsifier can be told apart from an unrelated one: a `test/` path whose {@link
 * moduleIdFromPath} EQUALS the slug is
 * the task's own falsifier (the suite written to prove ITS acceptance criteria, named after the
 * task the house convention already uses); any other `test/` path is SOMEONE ELSE's test, or an
 * unrelated one, and now counts like an ordinary concern instead of being swept into the discount.
 *
 * WHY THIS EXISTS. {@link COMPANION_PATH_CLASSES}'s W1-T2543 discount is UNCONDITIONAL on path
 * class alone: ANY `test/` path is a candidate companion the moment some non-companion file
 * survives, with no check that the specific test belongs to THIS task's own change. That is exactly
 * right for the dominant shape (one source stem plus the suite written to prove it) but says nothing
 * about a task that lists a second, unrelated test file alongside — which still spans two concerns
 * and must still be refused (W1-T2525's rationale: "a task listing SOMEONE ELSE'S test file, or
 * several unrelated test files, is still spanning concerns").
 *
 * UNKNOWN SLUG (`undefined` — every caller before this task, and every caller that has no shard
 * filename to read, e.g. the pre-dispatch call site which never threads {@link
 * duplicateCorpusOpts}) ⇒ the W1-T2543 behaviour is kept BYTE FOR BYTE: any `test/` path is a
 * companion candidate, discounted subject to the vacuity guard below. Passing the slug only ever
 * NARROWS which companions are discounted — it can turn a discount into a count, never the reverse
 * — so a caller that supplies it can only make sizing STRICTER, never looser.
 */
```

## ownFalsifierRenameCandidates

Base revision `ea02cc83`, line 250, 31 comment lines.

```
/**
 * W1-T2814 — WHICH DECLARED COMPANION, IF IT WERE THIS TASK'S OWN FALSIFIER, WOULD REMOVE THE SPAN.
 *
 * PURELY DIAGNOSTIC. This decides what a violation's MESSAGE may offer; it is never consulted by
 * {@link sizingViolation}'s block/warn decision, and {@link subsystemsOf}'s carve-out is unchanged.
 * W1-T2525 narrowed that discount DELIBERATELY — a task listing someone else's test file is still
 * spanning concerns — and widening it here (fuzzy matching, prefix matching, "any single test
 * file") would be weakening a gate rather than explaining one.
 *
 * THE DEFECT THIS SERVES. `subsystemsOf`'s own-falsifier discount keys on STRING EQUALITY between
 * two names a filer chooses independently — the shard's filename slug and the test's
 * {@link moduleIdFromPath} — so a few words' difference defeats it and a one-source-one-test task
 * reads as spanning two concerns. MEASURED: W1-T2809's filing tripped
 * `[sizing] spans 2 distinct subsystems/concerns (census-discovery-is-blind-to-a-second-idiom,
 * ci-parity) at risk:medium` over exactly that shape, and renaming the shard so its slug matched
 * the test made it pass at `risk: medium` with no other change.
 *
 * AND WHY THE MESSAGE, NOT THE PREDICATE, IS THE FIX. The violation text names two exits — "raise
 * to risk:high or decompose". REGRADING SILENCES IT IDENTICALLY, and looks like the intended
 * remedy, so a lane that does not open `subsystemsOf` inflates the band and gets no signal it did
 * anything wrong: no second message, no warning, no ledger row. `risk` drives sizing exemptions,
 * dispatch ordering and effort routing, so anything reading that field downstream may be reading a
 * FILENAME MISMATCH encoded as real span.
 *
 * Returns the companion path(s) — in declaration order — for which
 * `subsystemsOf(task, …, moduleIdFromPath(path))` scores below 2, i.e. renaming the shard to that
 * module id would legitimately engage W1-T2525's discount. Empty when the slug is unknown (there
 * is nothing to rename toward), when no companion is declared, or when the span survives the
 * rename anyway — a task spanning two real source stems gets no such suggestion, which is what
 * keeps the third exit from becoming a dodge.
 */
```

## ownFalsifierRenameExit

Base revision `ea02cc83`, line 298, 13 comment lines.

```
/**
 * W1-T2814 — THE THIRD EXIT, WITH ITS CONDITION ATTACHED. Appended to the sizing block message
 * only when {@link ownFalsifierRenameCandidates} finds the rename would actually resolve the span,
 * so it is never a bare suggestion on a task spanning two real concerns.
 *
 * THE CONDITION IS NOT OPTIONAL, AND IT IS WHY THIS IS NOT ONE MORE SENTENCE. Advertising a rename
 * INVITES GAMING IT: read as "rename your shard to match your test", any task spanning two genuine
 * concerns could silence Rule 19 by renaming a file, and this text would have built the next silent
 * distortion while fixing the current one. So the exit states the property that makes the discount
 * legitimate — the named suite is the one written to prove THESE acceptance criteria — and names
 * the misuse outright, so a reader can tell "the carve-out applies to me" apart from "rename to
 * make this go away" without opening `subsystemsOf`.
 */
```

## sizingViolation

Base revision `ea02cc83`, line 325, 27 comment lines.

```
/** ≥2 subsystems while risk<high ⇒ a sizing violation (raise to high or decompose).
 *
 *  W1-T2503: `if (task.risk === "high") return undefined` used to be the WHOLE
 *  risk:high predicate — but the band conflates two meanings: Rule 19's SPAN
 *  measure (≥2 subsystems/concerns) or genuine BLAST RADIUS unrelated to span
 *  (a boot script, an auth path, a merge arm), and nothing recorded which.
 *  DECLARE, DO NOT REMOVE (the task's own rationale): a task the diff newly
 *  files or promotes to high (per `opts.riskTransition`, see that field's own
 *  doc for the exact contract) must now say which meaning its band carries via
 *  `task.band_meaning`; undeclared there ⇒ BLOCKED, naming both legal values
 *  rather than a bare rejection. `band_meaning: "blast-radius"` keeps today's
 *  exemption byte for byte (span left uncomputed, regardless of transition).
 *  `band_meaning: "span"` computes the subsystem count and REPORTS it
 *  (`severity: "warn"`) instead of skipping it — never a refusal, because a
 *  wide span is exactly what declaring "span" already admits.
 *
 *  `opts.riskTransition` ABSENT (no diff context at all — every call site of
 *  this function before this task, and every one of them still today:
 *  pre-dispatch's `assertLintClean`, whole-plan `lintPlan`, the retro
 *  plan-health sweep, inbox, panel-skill-run) ⇒ an undeclared band stays
 *  SILENT, exactly as before this task existed — none of those callers
 *  regress or newly block on the standing backlog. Present ⇒ an undeclared
 *  band on a task the diff FILED or MOVED to high (`baseTask` absent, or
 *  `baseTask.risk !== "high"`) blocks; on a task ALREADY high before the diff
 *  (`baseTask.risk === "high"` — the standing 824-task baseline) it only
 *  warns: reported, never refused, so no existing task blocks a PR on this
 *  alone and the count reduces at whatever pace an operator chooses. */
```

## HEADLESS_FORBIDDEN_LEXICON

Base revision `ea02cc83`, line 416, 46 comment lines.

```
// ── HEADLESS-FITNESS (Rule 18) ───────────────────────────────────────────────
//
// A forbidden live-context lexicon, held as DATA so it grows. Applied to every
// acceptance criterion of an auto-verify task — a headless worker has no TTY and
// no operator, so a criterion needing one can never pass (W1-T9's readline-
// reproduction death spiral; W1-T12's overnight-drain / launchctl-load / live-
// kill criteria).
//
// PRECISION vs RECALL (the #146 sweep, W1-T81): a naive whole-word-anywhere scan
// is wrong in BOTH directions on the SAME rule.
//   - FALSE POSITIVE #1 — negation: 'NO real overnight run' (W1-T12a) and 'NOT a
//     real launchctl load' (W1-T12b) contain a forbidden word but explicitly deny
//     the live action. A hit whose CLAUSE (bounded by . , ; : ( ) or an em-dash)
//     opens with a negation cue (no/not/never/without/non/isn't/doesn't/won't/
//     cannot/can't/nor) BEFORE the match does not flag.
//   - FALSE POSITIVE #2 — self-reference: W1-T20c's own criterion literally names
//     the lexicon ('a criterion containing overnight/launchctl/killed...') to
//     describe the CHECK, not to instruct a live action. Exempted by CONTENT
//     SHAPE, never a task-id allowlist (an id allowlist rots): (a) forbidden
//     terms directly enumerated back-to-back with a bare '/' between them (no
//     surrounding spaces) are a quoted/listed lexicon excerpt, not an
//     instruction; (b) a hit fully inside a quoted span ('...' or "...", the
//     quote not itself a contraction/possessive apostrophe) is a quoted excerpt
//     under discussion, not an instruction.
//   - FALSE POSITIVE #3 — missing ACTOR (the #268 sweep, W1-T118): a lexicon
//     word can name either a genuinely live action (W1-T12d's operator kill -9
//     on a real daemon) or a headless one (a test spawning its own child and
//     reaping it in-process, W1-T117) — SAME WORD, opposite fitness, because the
//     check matched vocabulary, not who/what the action is done TO. The
//     discriminator is SPAWN-OWNERSHIP: a lexicon row may carry an optional
//     `qualifier` pattern (see {@link LexiconEntry}); when the criterion's own
//     text (claim + proof together, unscoped by clause — ownership is usually
//     established earlier in the SAME criterion, often in a different clause,
//     e.g. 'fixture spawns...; ...killed') matches that pattern, the row does
//     NOT fire — the process/resource acted upon is CREATED BY THE TEST OR
//     FIXTURE, not pre-existing on the operator's machine, so the action is
//     headlessly performable. No qualifier, or no match ⇒ the row fires exactly
//     as before (DEFAULT ON FIRING: a false positive costs a reword, a false
//     negative costs a dispatched task that can never pass, the W1-T9 death
//     spiral) — W1-T12d's live-kill criterion names no ownership signal and
//     must keep flagging.
//   - FALSE NEGATIVE — the genuinely headless-unfit proofs the check was BUILT to
//     catch ('paste the red check, then revert' — the W1-T25 no_pr incident,
//     122 turns before verdict=no_pr) are PHRASES, not lexicon words, so the
//     original word-only lexicon never matched them. Phrase-level signals below
//     close this gap.
```

## LexiconEntry.qualifier

Base revision `ea02cc83`, line 466, 12 comment lines.

```
  /** SPAWN-OWNERSHIP qualifier (W1-T118, the #268 false positive) — OPTIONAL,
   *  scope-as-data, never a reason to delete the row. When present, a hit for
   *  THIS row is exempted (does not flag) if `qualifier` matches anywhere in the
   *  criterion's combined claim+proof text: the criterion's own words establish
   *  that the process/resource acted upon is CREATED BY THE TEST OR FIXTURE
   *  (spawns/seeds/fixture/in-process/test-spawned), not pre-existing on the
   *  operator's machine. Absent, or no match ⇒ the row fires unconditionally,
   *  exactly as before — DEFAULT ON FIRING: an ambiguous criterion (the term
   *  appears with no ownership signal either way) still flags, because a false
   *  positive costs a reword while a false negative costs a dispatched task
   *  that can never pass (the W1-T9 death spiral). See {@link
   *  SPAWN_OWNERSHIP_CUE} for the shared cue pattern most rows will reuse. */
```

## HEADLESS_FORBIDDEN_LEXICON phrase rows

Base revision `ea02cc83`, line 498, 13 comment lines.

```
  // Phrase-level live-demonstration signals (RECALL, the #146 sweep) — an
  // imperative demonstration no headless worker can perform, regardless of
  // whether any single WORD above appears: 'paste the <red|green|score|check>
  // [...], then revert' (W1-T25/26/28 pre-sweep), 'run against <a live/sandbox
  // repo>' (W1-T27 pre-sweep: 'run against remudero-sandbox'), and 'operator
  // observes'. NOT included: a bare 'screenshot' — checked against the LIVE
  // plan (255 tasks) before landing, it false-positived on W1-T153's Lighthouse
  // artifact (an AUTOMATED headless-browser capture attached to the PR, not a
  // live action) and on W1-T184's '(operator screenshot, 2026-07-20)' — a
  // FALSIFIER citing PAST evidence, not an instruction to the worker. The word
  // alone doesn't distinguish "a headless worker can produce this" from "a
  // human must be there" — exactly the false-positive failure mode this task
  // exists to fix, so it stays out until a precise phrase shape is found.
```

## proofDialectViolations

Base revision `ea02cc83`, line 684, 24 comment lines.

```
// ── PROOF-DIALECT (moratorium finding 9 — the dead proof floor) ─────────────
//
// remudero-review resolves a task's acceptance from tasks.yaml and EXECUTES
// each `proof:` — but only review.ts's own house dialect actually runs
// (`parseWhitelistedProof`: `unit test: <path-or-name>` / `grep: <pattern> in
// <path>`, plus two legacy strict shapes). Anything else is free prose: it
// never executes, degrades straight to the 0.6 keyword floor, and a task with
// ZERO executable proofs CAPS on review exactly like W1-T79 (PR #662) did — a
// two-step manual operator rescue (a worker cannot amend its own criteria,
// Standing rule 15). CENSUS at filing time: 45% of all plan proofs (390/861)
// cannot execute; 96 not-done tasks have zero executable proofs. The fix
// belongs at AUTHORING, not a third rescue lever on the review side — this
// check REUSES review.ts's own predicate (never a reimplementation that could
// drift from what the executor actually runs).
//
// W1-T277: a THIRD dialect, `demonstration: <what the operator must do>`,
// is also never executed — but unlike the free prose above, that is not a
// defect: it is an honest, on-the-record declaration that the proof is an
// operator action with no executable form and never will be (a chaos drill,
// a device recording, a live deploy). Legal ONLY on a `verify: human` task
// (where it lints clean); refused outright on `verify: auto` (where the
// identical prefix would be an escape hatch from the rule this check exists
// to enforce). See the dedicated block below, checked BEFORE the general
// dead-proof-floor logic.
```

## proofDialectViolations, the demonstration arm

Base revision `ea02cc83`, line 749, 12 comment lines.

```
    // W1-T277: `demonstration: <what the operator must do>` names an operator
    // action with no executable form and never will (a chaos drill, a device
    // recording, a live deploy) — it is a proof the harness DECLINES to check,
    // on the record, not one that failed to parse. Legal ONLY on a
    // verify:human task, where declining to execute it is the entire point
    // (lints clean, no violation at all — never even a warn). On a
    // verify:auto task the identical prefix is an escape hatch from the
    // executable-proof rule this check exists to enforce, so it is BLOCKED
    // unconditionally here — that asymmetry is the dialect's whole safety
    // property (W1-T277 design), so it holds regardless of `opts.proofDialect`
    // (the legacy-backlog warn-only rollout knob applies to proofs that FAIL
    // to parse, never to one that is illegal by construction).
```

## proofResolvabilityViolations

Base revision `ea02cc83`, line 812, 33 comment lines.

```
// ── PROOF-RESOLVABILITY (W1-T101 — a dialect prefix is a promise) ───────────
//
// proofDialectViolations (above, W1-T246) already refuses a dialect body that
// does not PARSE at all (a `grep:` proof with no `in <path>` clause, etc.) and
// WARNS when a `unit test:` body reads as a runtime narrative — but never
// BLOCKS the narrative case, because parseTestTarget (review.ts) deliberately
// treats ANY non-path `unit test:` body as a valid name-filtered proof, on the
// theory that the author's own prose might still match a real test's title.
// The W1-T100 ledger is the gap that permissiveness leaves open: proof_exec
// [not_executable x3] on two `unit test:`-prefixed proofs, each PARSING as
// "whitelisted", each resolving to ZERO real tests at review time — a prefix
// that PROMISED executability with a payload that could never resolve.
//
// This rule polices that PROMISE, independent of whether the payload happens
// to parse: a `unit test:`/`grep:` prefix commits the author to naming a
// RESOLVABLE artifact — a path-like token or an explicit `::test-name` token
// for `unit test:`, a pattern plus an `in <path>` clause for `grep:` (DATA,
// {@link PROOF_PAYLOAD_SHAPES} — companion rows to W1-T81's phrase signals and
// W1-T92's path classes; a new resolvable shape is a table row, zero engine
// changes). A proof with NO dialect prefix makes no such promise and is NEVER
// touched by this rule — prose is legitimate and keyword-bound by design; drop
// the prefix is always the other valid remedy.
//
// A `unit test:` body that carries neither anchor is refused ONLY when it also
// reads as a multi-clause SCENARIO NARRATIVE, never on a bare single-arrow
// phrase alone — this repo's OWN test titles idiomatically read `X -> Y` (187
// real `test("... -> ...")` titles in this suite, e.g. `test("decideAlert
// Disposition: critical severity -> escalate")`), so a lone arrow is not a red
// flag. What the W1-T100 corpus actually looks like is SEVERAL independent
// observations chained together (multiple comma-separated clauses, or a
// semicolon stacked on top of an enumerated clause) — a shape no single test
// title plausibly reads as. `grep:` carries no such exception: the dialect's
// own promise ("a pattern AND an `in <path>` clause") is unconditional.
```

## proofGrepSafetyViolations

Base revision `ea02cc83`, line 927, 51 comment lines.

```
// ── PROOF-GREP-SAFETY (W1-T287) ──────────────────────────────────────────────
//
// A `grep:` proof's pattern is compiled by `execWhitelistedProof` as
// `grep -arn -- <pattern> <path>` — a BASIC REGULAR EXPRESSION (BRE), not a fixed
// string. Nothing in the dialect docs, the authoring prompts, or CLAUDE.md says
// so, and guidance circulating in this project ("`grep -F` is case-sensitive")
// actively teaches the wrong model. The result is measurable: 1,952 verdicts in
// the unioned ledger carry a FAILED grep proof, including `grep: loadPolicy in
// src/lib/review.ts` failing four separate times on W1-T253.
//
// THE LIVE FIXTURE (PR #1071): a proof reading `grep: For a [call-site]
// violation in <path>` had `[call-site]` read as a CHARACTER CLASS matching one
// character from {c,a,l,-,s,i,t,e}. The pattern meant "For a X violation" and
// could never match the literal text. Its author verified locally with
// `grep -F` — a DIFFERENT MATCHER — and got a false green.
//
// THE SET IS MEASURED, NOT REMEMBERED. Determined by running both grep
// implementations on this host against two discriminators: (1) does `aXb` match
// the text `aQb`, which contains no `X`? (2) does `aXb` FAIL to match the
// literal text `aXb`? Either ⇒ `X` is a metacharacter. Results:
//
//   * . ^ $ [   metacharacters      ] ( ) { } + ? | \   literal-safe
//
// `(` is NOT a BRE metacharacter (it is an ERE one), which matters because
// PR #1071's own call-site proofs use `foo(` — rejecting it would break a rule
// that merged the same day. `]` alone is literal-safe on both implementations,
// so only `[` — which is what OPENS a bracket expression — is refused.
//
// IMPLEMENTATIONS DISAGREE, so the set is the UNION (⇒ the safe intersection of
// accepted patterns). BSD grep 2.6.0-FreeBSD reads a mid-pattern `^` as a
// literal; ugrep 7.5.0 (what `grep` actually resolves to on this host) reads it
// as an anchor everywhere. A pattern whose meaning depends on which binary the
// review host happens to run is not a proof, so anything special to EITHER is
// refused.
//
// SEVERITY IS SPLIT ON THE FAILURE MODE, and the split is what the retrofit
// measurement earned. Across all 313 tasks / 31 parseable `grep:` proofs:
//   - `[ * ^ $` can make a proof NEVER match its intended text — a silent
//     false FAIL, the #1071 class. Retrofit: 0 tasks. ⇒ BLOCK.
//   - `.` merely matches MORE than intended (`a.b` also matches `aQb`) — the
//     proof still finds its literal text, so the failure mode is over-breadth,
//     not a false fail. Retrofit: 4 tasks (W1-T254, W1-T266, W1-T275, W1-T284),
//     every one a dot inside an identifier (`panel-skills.js`,
//     `sweep.post_review.attempt`). ⇒ WARN, so working proofs are not stranded.
// Blocking `.` would have forced four rewrites of proofs that function; warning
// on `[` would have let the #1071 defect through again.
//
// AN ESCAPED METACHARACTER IS LEGITIMATE and is accepted: `\.` matches a literal
// dot and NOT any character (verified on both implementations). But a backslash
// that OPENS a BRE construct — `\(`, `\)`, `\{`, `\}` (grouping and intervals,
// both confirmed working) — is itself a metacharacter and is refused.
```

## BRE_WARNING_METACHARS

Base revision `ea02cc83`, line 983, 13 comment lines.

```
/** BRE metacharacters that do NOT silently strand a proof under the executor's own
 *  matcher, so they warn rather than block.
 *
 *  `.` only WIDENS a match: the proof still finds its own text (blocking it would
 *  strand the 4 tasks that use it).
 *
 *  `?` is the OPPOSITE shape and is here for a different reason. It is LITERAL in a
 *  BRE and a QUANTIFIER in an ERE, and the executor's argv is `grep -arn --` with no
 *  `-E`, so a bare `?` genuinely works TODAY — blocking it would refuse patterns that
 *  match. What it is not is portable: read by any ERE-defaulting grep the same pattern
 *  finds nothing and reports a clean zero. Measured on `logUnavailable?: Cause`, BRE
 *  matched and ERE missed. See {@link SINGLE_LITERAL_CLASS_CHARS} for why the remedy
 *  is `[?]` and never `\?`. */
```

## SINGLE_LITERAL_CLASS_CHARS

Base revision `ea02cc83`, line 998, 19 comment lines.

```
/** Characters for which `[X]` — a bracket holding exactly this one character and
 *  nothing else — is the SANCTIONED literal escape, exempt from `[`'s blocking rule.
 *
 *  WHY THE EXEMPTION EXISTS. Without it this linter forbids the only portable remedy
 *  for the very fragility it warns about: `[?]` tripped `[`'s block while the bare `?`
 *  it replaces passed clean, so the rule pushed authors toward the fragile form. The
 *  #1071 precedent (`[call-site]` read as a character class) is a DIFFERENT shape —
 *  several characters forming a real class — and stays blocked, because nothing about
 *  it is unambiguously a literal.
 *
 *  AND `\X` IS NOT AN ALTERNATIVE for the character that motivated this. `\?` is a
 *  quantifier in GNU BRE and a literal in an ERE — exactly inverted from bare `?` — so
 *  the obvious escape moves the failure rather than removing it. Only the bracket form
 *  is literal under both.
 *
 *  MEASURED, not assumed: every member below matched its literal text under BOTH
 *  `grep` and `grep -E` and matched nothing when the character was absent. `^` is
 *  DELIBERATELY EXCLUDED — `[^]` opens a NEGATED class rather than closing a literal
 *  one, and both engines error on it. */
```

## BRE_CONSTRUCT_AFTER_BACKSLASH

Base revision `ea02cc83`, line 1027, 23 comment lines.

```
/** Characters that become a BRE construct when a backslash precedes them —
 *  grouping, intervals, and GNU's optional-quantifier. `\.`-style escapes are NOT
 *  here: those are literals.
 *
 *  MEASURED on GNU grep 3.11 against a file holding `ab` and `a?b`, the same
 *  discipline {@link SINGLE_LITERAL_CLASS_CHARS} states for its own membership:
 *  BRE `a\?b` hits BOTH lines (2) — it is a QUANTIFIER, not an escaped literal —
 *  while BRE `a?b`, BRE `a[?]b` and ERE `a[?]b` each hit one. So the escape an
 *  author reaches for to make `?` literal is precisely the form that stops being
 *  literal, and it scored CLEAN here until this entry existed.
 *
 *  `?` IS ENGINE-DEPENDENT IN A WAY THE OTHER FOUR ARE NOT, and that is recorded
 *  rather than smoothed over: `\(`, `\)`, `\{` and `\}` are POSIX BRE constructs
 *  everywhere, whereas `\?` is a GNU extension. Only GNU grep was available to
 *  measure from — ugrep and BSD grep are both absent in the container this was
 *  derived in — so an implementation without the extension would read `\?` as a
 *  literal `?`. Blocking is still the right call in that case: an author who wants
 *  a literal `?` has `[?]`, which measured as literal under BOTH engines above, so
 *  the blocked form is one nobody needs on either.
 *
 *  RETROFIT, measured before this became blocking: ZERO `grep:` proofs across the
 *  whole plan carried `\?`, against a control of seven that carry some other
 *  backslash — so no existing proof newly fails. This entry is preventive. */
```

## proofGrepUnmatchableViolations

Base revision `ea02cc83`, line 1155, 37 comment lines.

```
// ── PROOF-GREP-UNMATCHABLE (W1-T1225 — a grep: pattern that can NEVER match) ─
//
// Nothing at filing time ever opens the file a `grep:` proof names, so a pattern that cannot match
// ANY single line of a file already on disk reads identically to a correct forward reference (the
// "not written yet" case CLAUDE.md protects). That indistinguishability is real for a HIT-COUNT
// check (zero is legitimately a forward reference — proof-name-resolution's own rule, below), but
// two subclasses are POSITIVE detections, not zeros: the phrase is present in the file but a line
// break falls inside it (grep is line-based and can never match, no matter how long the filer
// waits), or the phrase is present only under different capitalisation (grep has no case-fold by
// default). A genuine forward reference matches neither probe and stays silent.
//
// CONSUMES {@link classifyGrepZeroHit} (W1-T1224) instead of re-deriving line-seam / case-only
// detection here; that module is the SAME matcher `checkProofCommand` (run-task.ts) uses to
// explain a real zero-hit `grep:` run, so this filing-time check and that runtime diagnostic can
// never disagree about why a pattern misses.
//
// THE LINTER STAYS PURE. Like {@link proofNameResolutionViolations}'s `opts.resolveNameFilteredCandidates`
// and {@link callSiteViolations}'s `opts.moduleExists`, the file's own text arrives via an INJECTED
// reader on {@link LintOpts.readGrepProofFile} — no fs, no exec, in this module. Absent reader ⇒
// silent, exactly like every other injected-predicate check here.
//
// WARN, NEVER BLOCK, WITH NO SEVERITY OVERRIDE — the same posture {@link proofNameResolutionViolations}
// takes for the same reason (zero/mismatch is a heuristic about intent an author may deliberately
// want), plus one more: a warn that names the offending line is actionable; a block would refuse
// authoring a pattern this check cannot fully adjudicate (a pattern carrying a BRE metacharacter the
// display-only line locator below cannot always re-find, for instance).
//
// NOT folded into {@link lintTask}'s own aggregate, unlike every sibling injected-predicate check
// nearby — DELIBERATELY. Design (vi) (W1-T1225) scopes this check to ONE call site, the
// changed-tasks lint pass (`lintPlanCommand`'s `--base` branch, run-task.ts), and never a
// pre-dispatch guard, a whole-plan sweep, or the retro's plan-health pass — reading a `grep:`
// proof's named file is bounded by the diff there (a handful of files) and is NOT bounded anywhere
// `lintTask` is called generically. Gating solely on "reader absent ⇒ silent" would still be
// correct today (no other caller supplies one), but folding the push into `lintTask` would let any
// FUTURE caller light this check up by accident just by wiring the option — the exact "shipped
// dormant, wired later, by someone else" failure this task's own rationale (point 5) names.
// `lintPlanCommand` calls {@link proofGrepUnmatchableViolations} directly instead.
```

## proofEngineDivergenceViolations

Base revision `ea02cc83`, line 1316, 33 comment lines.

```
// ── PROOF-ENGINE-DIVERGENCE (W1-T2294 — a `grep:` pattern whose meaning depends on the
//    regex engine, nothing declares which one ran) ───────────────────────────────────
//
// The house `grep:` DIALECT (parseDialectGrep, review.ts) always compiles to `["-arn", "--",
// pattern, path]` — no `-E` anywhere reachable, so BRE and only BRE, author-unselectable. That
// arm can never diverge and is not this check's business (flagging it would fail patterns —
// `mergeConflict?:` among them — that are CORRECT under the engine that always actually runs).
//
// The LEGACY fenced `` `grep ...` `` shape (parseWhitelistedProof's `GREP_FENCE_RE` branch,
// review.ts) tokenises everything after `grep` as the author's own argv verbatim — `-E` is
// reachable there, and nothing inspects it: `proofGrepSafetyViolations` above matches `^grep:`
// before it does anything, so a backticked proof never reaches `breMetacharsIn` at all. That
// arm is flagged here via {@link WhitelistedProof.authorSelectedArgv} (review.ts), which is set
// ONLY by that branch — never re-derived from `args` shape, which is not reliably recoverable
// (a single-flag legacy invocation like `` `grep -arn -- pat path` `` has the identical `args`
// shape as the dialect form's own compiled argv).
//
// BEHAVIOURAL, NOT LEXICAL (design Q2): a pattern that is syntactically valid under BOTH engines
// and MEANS DIFFERENT THINGS — `mergeConflict?: MergeConflictEvidence` is the measured case, 2
// hits under BRE and 0 under ERE against src/lib/sweep.ts — carries nothing in its own text that
// distinguishes it from an ordinary pattern; only running it both ways does. So this check
// compiles the pattern as BOTH a BRE and an ERE and counts matching lines each way; the two
// engines agreeing is the common case and draws no report, and disagreeing is the exact
// condition the task's own title names.
//
// `?` MUST NOT move from `BRE_WARNING_METACHARS` above — see that constant's own comment. Under
// the dialect form's fixed BRE, `?` is literal and the pattern is correct; this check never
// touches the dialect arm at all, so the two checks cannot contradict each other about the same
// proof.
//
// PURE, same discipline as {@link proofGrepUnmatchableViolations} just above: no fs, no exec —
// the target file's text arrives via the SAME injected `opts.readGrepProofFile` reader (one
// contract, two consumers of the same fact "what does this path's text look like today").
```

## proofScopeViolations

Base revision `ea02cc83`, line 1468, 78 comment lines.

```
// ── PROOF-SCOPE (W1-T310 — a proof naming a path the task never declared) ───
//
// scopeGuardOutOfScopeFiles (run-task.ts) compares a branch's diff against the
// task's declared `files:` — EXACT Set membership, `declared.has(f)`, never a
// prefix or glob (read directly off that guard so this check can never
// disagree with it about what "in scope" means, design point 2). A proof
// naming a path outside that same declared set is therefore GUARANTEED to
// trip the guard once the work satisfying it is done — W1-T309's own
// postmortem: `files: [src/lib/status-board.ts]`, two of its three proofs
// named `test/status-blockers-live.test.ts`. ALL TWELVE tasks filed that day
// (W1-T298..W1-T309) carried the flaw and `lint-plan` passed every one of
// them — it validates proof SHAPE (proof-dialect) and RESOLVABILITY
// (proof-resolvability), never whether the artifact a proof names is inside
// the scope the SAME task declares.
//
// (W1-T2287) THE GUARD NO LONGER REFUSES, and the message below used to claim
// it does. W1-T309's own 106-turn / $4.36 postmortem WAS a refusal, at the
// time; the implement path's disposition since changed to push-and-flag:
// `scope_guard.overrun` is logged and the branch pushes anyway — "pushed and
// flagged rather than refused: the branch is the only evidence that separates
// a phantom revert from an under-declared files:, and a refusal reaped it"
// (run-task.ts's own ledger line at the `scopeGuardOutOfScopeFiles` call
// site). The consequence that IS real and IS a verdict, and that the old
// message never named: `judgeCriterion` (review.ts) grades a pure-path
// `unit test:` proof `not_yet_built` only when its path is a member of
// `ProofExecContext.forwardReferenceFiles`, built from (among other sources)
// this task's own declared `files:`. A path OUTSIDE `files:` can never take
// that carve-out, so if it is still absent when the PR is reviewed, the
// criterion grades `executed_fail` instead — overriding keyword coverage and
// failing the PR outright, not a refusal but a wrong verdict.
//
// REUSES parseWhitelistedProof (review.ts) — the SAME parse the reviewer's
// executor runs (design point 1) — so this check can never disagree with
// `rmd check-proof` about what a proof names. A proof that does not parse
// (free prose, a malformed dialect body — proof-dialect's concern) or that
// parses but names no path (a bare, name-filtered `unit test: <title>` —
// design point 4) is SILENT here: there is nothing to compare against
// `files:`.
//
// SEVERITY defaults to WARN, not block, and that is a measured call, not an
// oversight (design point 3: "recommend, with the count of existing tasks
// that would trip it, and let the operator rule"). Against the live plan at
// filing (338 tasks, 2026-08-03): 102 already carry this flaw. `lint-plan`
// runs CHANGED-TASKS-ONLY in CI, so a BLOCKING default would refuse merging
// any UNRELATED future edit to one of those 102 tasks until its `files:` is
// separately repaired. Worse, at the PRE-DISPATCH call site
// (`assertLintClean`) there is no severity override available to THIS task:
// this task's own declared `files:` is `[src/lib/task-linter.ts,
// test/lint-proof-scope.test.ts]` — adding one to run-task.ts's
// `preDispatchLint` object would itself be an out-of-declared-scope edit, the
// exact defect this check exists to catch. A BLOCKING default here would
// therefore immediately brick pre-dispatch (`blocked_illformed`) for those
// same 102 already-queued tasks the moment this merges, with no way for this
// PR to carve out the "legacy backlog must not brick overnight" exemption
// {@link proofResolvabilityViolations} and {@link proofDialectViolations}
// both used during their own rollout. `opts.proofScope` is the override knob
// — an operator can flip any call site (whole-plan, or just pre-dispatch, via
// a follow-up run-task.ts edit) to "block" with zero further engine changes,
// once the backlog is repaired or the risk is judged acceptable.
//
// (W1-T2287) ONE CONJUNCTION AUTO-ESCALATES TO "block" ANYWAY, measured at
// ZERO in the live plan today (see this task's own filing rationale): a
// mis-declared path that is ALSO absent at head AND whose task is
// `verify: auto` — the exact conjunction under which the grade above actually
// goes wrong, rather than merely looking untidy. `opts.moduleExists` (the SAME
// injected disk-existence predicate {@link callSiteViolations} already uses —
// this module stays pure, no fs of its own) answers "absent at head"; absent
// that predicate this check makes no attempt to escalate, exactly like every
// other injected-predicate check here — the plain "warn" default holds. A
// `verify: human` task never escalates regardless: `isDispatchEligible`
// (drain.ts) refuses it before the linter is ever consulted, so it can never
// reach the review that would grade it wrong. A path that EXISTS at head also
// never escalates: `judgeCriterion` never takes the forward-reference branch
// for an existing path, so the proof executes for real and is graded on its
// own merits — mis-declared but harmless, the 325-task `verify: auto`
// population an outright `block` default would otherwise have failed. An
// explicit `opts.proofScope` still wins outright over this computed value, in
// either direction — the operator override this module has always honoured.
```

## proofNameResolutionViolations

Base revision `ea02cc83`, line 1604, 37 comment lines.

```
// ── PROOF-NAME-RESOLUTION (W1-T488 — the literal-substring trap) ────────────
//
// A name-filtered `unit test: <title>` proof (parseTestTarget, review.ts) is NOT a regex against
// real test titles: `escapeRegExp` runs on the body FIRST, so `.` `(` `)` `[` `]` and every other
// regex metacharacter match only THEMSELVES. A title an author wrote with `.` standing in for a
// symbol resolves to ZERO real tests and reads `not_executable` — silently, with no error, and
// the criterion falls back to the keyword floor looking healthy. OBSERVED live (W1-T245/#651): 4
// of 5 proofs executed and the 5th used `.` for the parentheses in the test's own title.
//
// REUSES resolveNameFilteredCandidates (review.ts) — the SAME resolver `execWhitelistedProof`
// itself calls before ever spawning `node --test` — so this check can never disagree with the
// reviewer about what a proof's raw name resolves to (the same rule {@link proofScopeViolations}
// above already applies to proof-scope). NOT a reimplementation of that decision: `resolved` /
// `absent` / `unresolvable` are read verbatim off its return value.
//
// INJECTED, LIKE `opts.moduleExists` — resolveNameFilteredCandidates shells out to `grep` against
// a real checkout, and this module reads no disk (the same "no predicate ⇒ no opinion" contract
// {@link callSiteViolations} already uses). Absent `opts.resolveNameFilteredCandidates` this check
// is silent. NOT wired to any real call site by this task (`run-task.ts`'s pre-dispatch guard and
// `lintPlanCommand` are both outside this task's declared `files:`) — shipped here as a tested,
// directly callable function ready for that follow-up wiring, the same posture W1-T420's
// `learningDuplicateViolation` documents for its own out-of-scope gate.
//
// THE ZERO-MATCH WARN IS NARROWED, and that narrowing is a MEASURED call, not a guess (design
// point 3 required the measurement before shipping). A naive "WARN on every zero-resolution
// name-filtered proof" was run once against the live open queue (338 tasks, 2026-08-14): 251 of
// 319 open name-filtered proofs (78.7%) resolve to zero — almost all of them multi-clause SCENARIO
// NARRATIVES (`looksLikeScenarioNarrative`, defined above) that `proofDialectViolations` already
// warns about via a different signal, not the wildcard-confusion defect this check exists to
// name. Restricting to proofs that ALSO carry a regex metacharacter still left 145/319 (45.5%) —
// most of those narratives again, just ones that happen to contain a `.` or `(`. Restricting
// FURTHER to "contains a metacharacter AND does not read as a scenario narrative" — the same
// narrative guard {@link proofResolvabilityViolations} already exempts a single plausible test
// title from — cut it to 15/319 (4.7%), a high-precision set where the metacharacter is plausibly
// load-bearing punctuation inside an otherwise title-shaped body rather than narrative prose. That
// is the shape this check warns on. The MANY-match warn needed no such narrowing: it fired on
// 4/319 (1.25%) of the same corpus, so it is reported unconditionally.
```

## postMergeAmendmentViolations

Base revision `ea02cc83`, line 1706, 22 comment lines.

```
// ── POST-MERGE-AMENDMENT (§5C, W1-T180) ──────────────────────────────────────
//
// An amendment to an ALREADY-MERGED task's acceptance criteria is unreachable by
// every rung today: MERGED is terminal in the status layer (status.ts:696), the
// drain skips a merged id outright (drain.ts:88's `if (isMerged(t.id)) continue`),
// and the retro's plan-health sweep explicitly scopes itself away from a closed
// task (retro.ts:578). So a claim added to a merged task's criteria after the
// fact sits in the plan looking authoritative and is never dispatched, reviewed,
// or proven — the LIVE FIXTURE: PR #374 added two criteria to W1-T155 an hour
// forty-five minutes after PR #365 credited it merged, and every existing gate
// passed it clean. Standing rule 21 (MASTER-PLAN §12) names the house answer in
// prose — amending a merged task does not re-queue it; the amender owns filing
// the follow-up in the SAME PR — this check is what makes that answer CHECKED
// rather than merely conventional.
//
// THE INJECTION PROBLEM: merge state and the base-ref criteria set are I/O, and
// this module is documented as a PURE function over an already-loaded Task/Plan
// (module comment above) — so neither is fetched here. Both arrive through
// {@link LintOpts.postMergeAmendment}, populated by the CALLER (run-task.ts's
// `lintPlanCommand`, which already does the `--base` git-show read) from
// deriveStatus + the base plan snapshot. This check performs no I/O and imports
// neither status.ts nor any gh/exec surface.
```

## criterionKey

Base revision `ea02cc83`, line 1729, 29 comment lines.

```
/** Trim + collapse-whitespace normalized key for a criterion — keyed on the
 *  CLAIM ALONE (W1-T1098; was claim+proof, see W1-T1098's rationale). SET
 *  membership, not raw-list/positional equality, so reordering the
 *  `acceptance:` list or a pure formatting reflow never trips this check; a
 *  criterion whose claim text differs from every base-ref entry's claim
 *  counts as added-or-changed, regardless of what its proof says.
 *
 *  WHY CLAIM-ONLY: rule 21's own violation message names the harm it exists
 *  to prevent — a criterion that "would orphan silently" because MERGED is
 *  terminal and nothing re-queues the task. Rewording a proof orphans
 *  nothing: the CONTRACT the task promised (the claim) is unchanged, only
 *  how it is checked. Keying on claim+proof made a reworded proof on an
 *  already-merged task indistinguishable from a genuinely new criterion —
 *  `lint-plan` refused a proof rewrite with the same message it uses for an
 *  actual amendment, on a task nobody added a promise to.
 *
 *  WHAT THIS ALONE STOPS CATCHING (named, not hidden): a claim KEPT with its
 *  proof swapped for a WEAKER one — the discriminating `grep:` this task's own
 *  criterion once had, replaced by a whole-file `unit test:` that always
 *  passes — is invisible to THIS comparison, which is claim-only by design
 *  (see WHY CLAIM-ONLY above). `proof-dialect` and `proof-resolvability` (this
 *  file) and `executed_stale` (review.ts) each see PART of that gap — an
 *  unexecutable or non-discriminating proof — but none of them compares a NEW
 *  proof against the one it replaced. W1-T2254's {@link criteriaProofChanged},
 *  wired into {@link postMergeAmendmentViolations} as a REPORT (`severity:
 *  "warn"`, never a block — this function's own claim-added comparison stays
 *  exactly as documented above), is that comparison: a same-claim proof
 *  downgrade on an already-merged task is now named in the lint output, even
 *  though it still is not, and is not meant to be, blocked. */
```

## followUpTaskIdsCarrying

Base revision `ea02cc83`, line 1782, 25 comment lines.

```
/**
 * True iff every criterion in `added` is carried by at least one task in
 * `candidateTasks` — the follow-up escape hatch (W1-T180's design): the same PR
 * that amends a merged task's criteria also introduces a NEW task whose own
 * acceptance criteria include the amended ones, so the criteria have a home
 * that will actually be dispatched. Matched by {@link criterionKey} — claim
 * only, same as `criteriaAdded` — so the follow-up task's own proof wording
 * need not match verbatim. Vacuously true when `added` is empty (there
 * is nothing to carry). The caller supplies `candidateTasks` as the OTHER tasks
 * newly introduced by the same changed set — this function does no scoping of
 * its own.
 */
/**
 * W1-T2375 (extracted from #3091, which rebuilt the merged #3086 and carried this one increment):
 * WHICH of the follow-ups filed in this PR actually carry an added criterion — keyed on
 * {@link criterionKey}, the SAME normalisation {@link followUpCarriesCriteria} decides
 * `followUpFiled` with, so the message can never name a task the decision did not consider.
 *
 * MESSAGE PRECISION ONLY, AND THAT IS THE WHOLE CLAIM. No verdict moves: the refusal below fires
 * on `added.length > 0 && !escapeAvailable`, and neither term reads this. What it fixes is that
 * `ctx.followUpTaskIds` is EVERY new task in the PR (run-task.ts passes
 * `followUpTasks.map((t) => t.id)`), while `followUpFiled` is decided by which of them CARRY the
 * criteria — so a PR filing one carrying follow-up beside one unrelated new task names both, and
 * points the reader at a task that carries nothing.
 */
```

## followUpCarriesCriteria

Base revision `ea02cc83`, line 1814, 18 comment lines.

```
  // EVERY added criterion, not just one. The code here read `candidateTasks.some(t => t.acceptance
  // .some(...))` until 2026-08-26 -- at least ONE added criterion carried by at least one task --
  // while the doc above has always said "every criterion in `added`". The doc is what W1-T180 was
  // for: its own shard says the follow-up carries "the amended criteria", plural, and the whole
  // purpose is that the criteria have a home that will actually be dispatched. One carried
  // criterion gives the other four no home, so a PR could add five criteria to a MERGED task, carry
  // one, and pass -- the exact orphaning Rule 21 exists to stop, reached through its own escape.
  //
  // NOTHING WRITTEN ANYWHERE CHOSE `some`: the introducing commit (bd59a51d, W1-T180, #928) says
  // nothing about the quantifier, and the shard argues the other way.
  //
  // RETROFIT, MEASURED BEFORE THE CHANGE over all 823 plan commits: 93 criteria amendments, 4 with
  // a new task in the same PR, 34 adding more than one criterion, and exactly 1 that is both --
  // `1dd397fc` (#396) adding two to W1-T136 beside a new W1-T176, which carried NEITHER, so it
  // fails `some` AND `every` and was never permitted by the looseness. The only amendment where
  // this escape has ever actually fired is `13a73d57` (W1-T2327/W1-T2340), which carries its one
  // added criterion and passes under both readings. TIGHTENING REFUSES NOTHING THAT HAS EVER
  // HAPPENED.
```

## parentDispositionStated

Base revision `ea02cc83`, line 1844, 23 comment lines.

```
/**
 * Whether this PR has STATED the amended parent's disposition (W1-T2375). Two ways, and the
 * check accepts either without preferring one:
 *
 *   - FULLY SUPERSEDED — the parent is out of dispatch, `status: "blocked"`. This is the
 *     property {@link "./drain.js".isDispatchEligible} itself reads (`t.status === "blocked"`),
 *     and `drain.ts` references `retirement` ZERO times, so a `retirement:` field alone leaves
 *     the parent selectable. KEYED ON DISPATCHABILITY, NOT ON THE FIELD, deliberately: the
 *     2026-08-25 instance set `retirement: retired`, left `status: queued`, and was dispatched
 *     anyway — a field-keyed rule would have passed it and prevented nothing.
 *   - PARTLY SUPERSEDED — the parent stays dispatchable and its own prose carries
 *     {@link PARENT_SURVIVES_MARKER}, naming what remains.
 *
 * READS THE HEAD STATE, NOT THE DELTA. The question is "after this PR, is the disposition
 * answered", not "did this PR answer it" — a parent already blocked at the base ref cannot
 * orphan anything, and a second amendment to a parent that already states its survival should
 * not have to restate it. Both arms are therefore evaluated on `task`, with `baseTask` unused
 * here; it stays in the signature because a future arm that genuinely needs the delta should
 * not have to re-thread it.
 *
 * NEVER WRITES OR INFERS A DISPOSITION. A retirement is an operator act. This predicate only
 * reports whether the question has been answered; picking the answer is not its job.
 */
```

## blockedDispositionViolations

Base revision `ea02cc83`, line 1891, 33 comment lines.

```
/**
 * W1-T2487: A `status: "blocked"` task must NAME its disposition — one of {@link
 * RETIREMENT_REASONS} — the moment THIS DIFF is what puts it there. Fifty tasks on main carry
 * `status: blocked`; twenty-six name no `retirement:` at all, and nothing before this check ever
 * asked one to. W1-T2474 made the field LOAD-BEARING (drain now splits a retired task out of the
 * recoverable-blocker class by reading it), so an absent field is no longer untidiness — a
 * consumer that reads a field missing on more than half its population is not classifying, it is
 * defaulting.
 *
 * TRANSITION-SCOPED, NOT A THIRD SWEEP. `opts.blockedDisposition` is populated ONLY in
 * `lintPlanCommand`'s changed-tasks (`--base`) pass, exactly like {@link
 * PostMergeAmendmentContext} — the whole-plan pass (no `--base`) supplies no context at all, so
 * this function returns `[]` for EVERY task there, including the standing twenty-six. Refusing
 * them all at once would redden every PR that merely touches the plan until an operator
 * dispositions twenty-six pre-existing tasks — a demand this check has no standing to make (this
 * task's own rationale). Within the changed-tasks pass, two shapes:
 *
 *   - `ctx.baseTask` was ALSO `status: "blocked"` (the standing population, touched but not
 *     newly blocked by this diff) ⇒ reported, `severity: "warn"` — visible, never refused.
 *   - `ctx.baseTask` was anything else, or absent (a brand-new task filed straight into
 *     `blocked`) ⇒ THIS diff is what moves it into blocked ⇒ `severity: "block"`.
 *
 * NEVER WRITES OR INFERS A DISPOSITION — same discipline {@link parentDispositionStated}'s own
 * doc states in terms ("a retirement is an operator act. This predicate only ..."). This function
 * only ever READS `task.retirement`; nothing here sets it, guesses it, or defaults it, and a
 * blocked task that already names a legal value passes silently, untouched, at either severity.
 *
 * A VALUE OUTSIDE {@link RETIREMENT_REASONS} IS TREATED AS ABSENT, NOT PRESENT. `plan.ts`'s own
 * parser already throws `PlanError` on such a value at load time, so this arm is reached only by
 * a `Task` object built directly (by a future loader, or a test) — but "present" here means
 * "present AND legal", never merely "non-empty", so a bogus string cannot slip past as a
 * disposition either check ever intended to accept.
 */
```

## blockedRecordUnruledViolations

Base revision `ea02cc83`, line 1956, 33 comment lines.

```
// ── BLOCKED-RECORD DISPOSITION CENSUS (W1-T2634) ────────────────────────────────────────────────
//
// {@link blockedDispositionViolations} (W1-T2487, above) fires ONLY inside the changed-tasks
// (`--base`) pass, and even there only for a task THIS diff actually touches (its own module
// comment: "the whole-plan pass ... supplies no context at all, so this function returns [] for
// EVERY task there, including the standing twenty-six"). By design — refusing the whole standing
// population at once is the exact wedge W1-T2481 measured (13 permanently uneditable tombstones
// after PR #3305). But the result is that the STANDING population — every blocked record nobody's
// PR happens to touch this week — is invisible to every lint pass, and W1-T391, W1-T2474 and
// W1-T2481 each re-derived it BY HAND at three different shas and got three different numbers
// (31/32, 46/50, 13 wedged). A population that must be re-measured by a human to be discussed is a
// population nothing is tracking, and it silently regrows after every backfill.
//
// This check closes that gap without reopening the one the check above exists to avoid: it runs
// UNCONDITIONALLY, in EVERY lint pass — no `LintOpts` field, no base-ref context, so it fires just
// as well over `lintPlan`'s whole-plan sweep (the retro's periodic plan-health pass, W1-T20d, or
// `rmd lint-plan --all`) as it does inside a diff. It reads the LOADED `Task` object's own
// `status`/`retirement` fields — never raw plan text — so it measures the population the way a
// consumer (drain.ts's dispatch filter, daemon.ts's starvation census) actually sees it, not the
// way a grep over plan/tasks.yaml plus every tasks.d/*.yaml shard approximates it.
//
// WARN-ONLY BY CONSTRUCTION, exactly like {@link advisoryRoutingViolations}: there is no `LintOpts`
// knob anywhere to escalate this to `block`, and none should ever be added — this task's own
// rationale is explicit that a blocking arm over this exact population reproduces the W1-T2481
// wedge one field over, this time catching the legitimate `status: blocked` records too (W1-T391
// and W1-T10 are both correct as they stand, with no retirement).
//
// IT NAMES; IT DOES NOT RULE — it reads ONLY `task.status` and `task.retirement`, the two
// structured fields, and infers nothing from `note:`/`rationale:`/title prose. That lexicon-over-
// prose shortcut is the exact move W1-T391's withdrawn first implementation made (inferring a
// disposition from a 31-of-32 regularity), and it misfiled a legitimate operator-block that was
// already a fixture in that suite. The ruling belongs to an operator (W1-T2635); this check only
// names the record and stops.
```

## REPORTED_MERGED_FIELDS

Base revision `ea02cc83`, line 2083, 21 comment lines.

```
/** Fields on a merged task's shard that something ELSE in the system still reads
 *  AFTER the task merges (W1-T2254 rationale §Q1 (ii)) — a post-merge edit here
 *  silently changes live behaviour nobody signed off on: `status` feeds dispatch
 *  eligibility (drain.ts's `t.status === "blocked"` branch), `files` feeds
 *  W1-T171's overlap serialization (`partitionByFileOverlap`), `depends_on` feeds
 *  the DAG, `priority` feeds the dispatch comparator, `risk`/`verify`/`type`/
 *  `principles`/`budget_usd` each steer a lane/gate/spend cap, and `retirement`
 *  feeds the board's bucketing.
 *
 *  DELIBERATELY EXCLUDED, NAMED RATHER THAN LEFT IMPLICIT (§Q1 (iii)): `title`,
 *  `note` and `rationale` are prose an amendment is EXPECTED to touch — reporting
 *  them would fire on every legitimate rationale edit and get muted within a
 *  week. `hand_built` has exactly two mentions in `src/` (both in plan.ts, the
 *  interface declaration and the loader's own copy) and zero consumers — a field
 *  nothing reads cannot be poisoned, and reporting it would be pure noise. `id`,
 *  `repo`, `attempts`, `pr`, `prompt` and `context` are likewise left unreported:
 *  none of them has a documented post-merge consumer the way the ten below do.
 *
 *  The question a field must answer to be listed here is "does anything read
 *  this after the task merges", never "is this field conceptually final" — see
 *  §Q1 (iv). */
```

## postMergeAmendmentViolations, the aggregate doc

Base revision `ea02cc83`, line 2240, 18 comment lines.

```
/** Every acceptance criterion this PR adds or changes on an ALREADY-MERGED
 *  task, absent a follow-up task in the same PR to carry it. No {@link
 *  LintOpts.postMergeAmendment} at all ⇒ this check is skipped entirely (the
 *  pre-dispatch call site never dispatches a merged task in the first place,
 *  so it never supplies this context).
 *
 *  W1-T2254 widens this past the one BLOCKING case (a genuinely new/changed
 *  claim with no follow-up): three REPORT-ONLY, `severity: "warn"` checks run
 *  under the same three early exits (no context / unresolvable status / not
 *  merged) but are NOT gated by `followUpFiled` — that escape hatch is specific
 *  to the criteria-orphaning harm the BLOCK exists to prevent, and a warning
 *  never blocks a merge regardless, so there is nothing for it to escape. See
 *  {@link mergedFieldChangeViolations}, {@link criteriaRemoved} and {@link
 *  criteriaProofChanged} for what each reports and why it stays a report.
 *  W1-T2438 adds a FOURTH report under the same three early exits, gated on
 *  `ctx.merged`/`ctx.statusResolvable` exactly like the other three but reading
 *  no diff at all (unlike the three above, it is not comparing against
 *  `baseTask`/`baseAcceptance` — see {@link correctionWithoutPromptViolation}). */
```

## rulingVerifyViolation

Base revision `ea02cc83`, line 2357, 38 comment lines.

```
// ── RULING-VERIFY (W1-T326 — a ruling needs an operator, not a grep) ────────
//
// W1-T326's own shard set verify:auto with the note "the whole deliverable is
// text at known paths, so grep proofs execute against it directly and no
// operator need be present to judge them" — on a task whose SAME note says
// risk:high because "this writes a BINDING RULING on dispatch architecture."
// The proofs verified the ruling was WRITTEN, not that anyone RATIFIED it:
// #1302 merged in ten minutes and the operator overrode it in twenty-three
// more (#1303). isDispatchEligible (drain.ts) already refuses to dispatch any
// task whose `verify !== "auto"` — that enforcement lever is free and
// pre-existing; a ruling-shaped task at verify:human simply PARKS until the
// operator looks, which is the entire point. What was missing is only the
// rule that puts it there.
//
// TRIGGER A ONLY — `files:` contains "DECISIONS.md" (an exact entry, the
// literal repo-relative path this repo's single decision log lives at, per
// {@link isDataArtifact}'s own root-relative convention). A task whose
// declared write surface includes the decision log is ruling-shaped by
// construction, and A ALONE would have caught W1-T326 (its shard's `files:`
// named exactly this path). A mixed diff — other files alongside
// DECISIONS.md — still triggers: that is how the entry rides in unnoticed.
//
// TRIGGER B (a ruling-shaped TITLE, e.g. a bare `\bruling\b` word match) is
// the design's proposed belt for a ruling landing in some OTHER file (a
// MASTER-PLAN "ruling" section, a docs/ decision record) — DELIBERATELY NOT
// SHIPPED. Measured against the very task that files this check: W1-T353's
// own title reads "...deliverable is a RULING... a ruling-shaped task..." —
// describing the INCIDENT and the CHECK, not claiming its own diff (files:
// [src/lib/task-linter.ts, test/task-linter.test.ts], no DECISIONS.md) is a
// ruling — so a bare word match would misfire on the task introducing it, the
// same self-reference failure mode the headless-fitness lexicon special-cases
// for W1-T20c (see {@link HEADLESS_FORBIDDEN_LEXICON}'s FALSE POSITIVE #2
// above). No enumeration/quote-span exemption of that kind applies here (the
// title is one unquoted YAML string), so B cannot be stated precisely without
// either false-positiving on this task or growing bespoke self-reference
// carve-outs the design never asked for. The design's own fallback governs
// exactly this case: "if B proves too fuzzy to state without false positives,
// ship A alone and say so in the report" — done here.
```

## declaredScopeViolation

Base revision `ea02cc83`, line 2416, 32 comment lines.

```
// ── DECLARED SCOPE (W1-T504 — an undeclared files: lints clean and then serializes the fleet) ─
//
// 80 of 530 tasks carry an absent or empty `files:`, 13 of them minted unattended by triage.
// The linter never checked this: `overlappingPaths` (dispatch-overlap.ts) is fail-closed on an
// undeclared scope — it reports such a task as overlapping EVERY co-dispatched candidate — and
// `undeclaredScopeLast` (drain.ts, W1-T476) only demotes it to the end of its priority tier.
// Demotion is not containment: a demoted total-blocker that becomes the only eligible candidate
// still serializes everything behind it. This check closes that gap at the choke point that
// already exists — `assertLintClean` inside `runTask` refuses a task before any probe or spawn —
// by making a missing or empty `files:` a BLOCKING violation, the same severity shape
// {@link rulingVerifyViolation} established (a structural trigger, enforced by the linter,
// parked by the dispatcher). No dispatcher-side change is needed or made: a default-block check
// already reaches dispatch through `assertLintClean`, so teaching `isDispatchEligible` the same
// refusal would only duplicate it.
//
// THE PREDICATE IS `undeclaredScopeLast`'s OWN (`t.files === undefined || t.files.length === 0`),
// restated here rather than imported — drain.ts keeps no new dependency on this module, and the
// two can be pinned against each other by test rather than by coupling.
//
// W1-T1030 — DISPATCHER-UNREACHABLE EXEMPTION. The rule above is sound but its rationale is
// entirely about `overlappingPaths` at DISPATCH: `isDispatchEligible` (drain.ts) refuses at
// `t.verify !== "auto"` BEFORE any path is read, so a task that is not `verify: auto` never
// reaches `overlappingPaths` and cannot serialise the lane by an undeclared scope. Gating on
// `verify: human` rather than `type: manual` because `verify` is the exact field
// `isDispatchEligible` checks — `type: manual` is today a strict subset of it (see W1-T1030's
// rationale) but is a proxy that a future `type: manual, verify: auto` record would break. The
// 71 `implement/auto` records with no `files:` are untouched: this exemption checks `verify`,
// not `type`, so they still hit the `block` below exactly as before. The exemption is also
// SELF-LAPSING: it re-reads `task.verify` on every call, so the moment a task's record is
// re-banded to `verify: auto` (the sanctioned `deriveStatus` channel), the very next lint run
// — the changed-tasks CI pass that re-lints any touched record — sees `verify !== "human"` and
// the block re-applies with no separate bookkeeping.
```

## rule15FilingViolation

Base revision `ea02cc83`, line 2480, 50 comment lines.

```
// ── RULE-15 FILING (W1-T384 — a filing shape the review guard can only refuse) ─
//
// THE INCIDENT, TWICE IN THREE DAYS. #1295 (W1-T324's dispatched run) went green on
// 23 checks and was refused by `remudero-review` on Standing rule 15; #1416
// (W1-T369's) was refused the same way with 18 deleted `proof:` lines. Both closed
// unmerged; both were recovered by SPLITTING into a plan-only PR plus a code/test PR
// (#1298+#1299 and #1418+#1420), each recovery merging in about a quarter of an hour.
// The work was correct both times — only the PACKAGING was impossible.
//
// THE MECHANISM. `judgeReview` computes `planOnly = diffFiles.length > 0 &&
// diffFiles.every(isInPlanScope)`, then `criteriaTampered = !planOnly &&
// criterionFieldTampered(evidence.diff)`. Withdrawing or repairing a record
// NECESSARILY removes a `claim:`/`proof:` line, which is exactly what
// `criterionFieldTampered` fires on. So the moment ONE declared path falls outside
// `isInPlanScope`, the carve-out is gone and the PR is refused however good the work
// is. A dispatched worker gets one PR per run and cannot produce the split.
//
// WHY A LITERAL PATH AND NOT "ANY PLAN-SCOPE PATH" — MEASURED, per CLAUDE.md's rule
// that a bound must have observed the population it separates. Re-derived over all
// 425 task records at 1e952fc: FOUR declare `plan/tasks.yaml`. Two are plan-scope-only
// and clean (W1-T202, W1-T370 — W1-T370 also verify:human); two are MIXED at
// verify:auto (W1-T324, W1-T369) — exactly the two that lost dispatches. ZERO false
// positives. Broadening the first clause to "any `isInPlanScope` path" instead fires
// on 18 open records, 17 of them verify:auto, every one legitimate: `plan/policy.yaml`
// beside `src/lib/policy.ts` is an ordinary config-plus-reader pairing (W1-T252,
// W1-T264, W1-T318, W1-T320, W1-T325, W1-T330, W1-T344, W1-T378 among them) and none
// touches an acceptance criterion. `plan/policy.yaml` is in plan scope only because it
// starts with `plan/`. The narrow trigger is the one the evidence supports.
//
// IT GATES STRICTLY EARLIER THAN THE REVIEW GUARD, which is why it needs no reasoning
// about gaming. `criteriaTampered` keeps working byte-identically on everything that
// reaches review; this adds a refusal BEFORE dispatch and changes nothing about what
// the reviewer does. It is purely additive to rule 15's strength — there is no path by
// which it lets through something rule 15 previously caught.
//
// ONE TRIGGER ONLY, following {@link rulingVerifyViolation}'s own lesson: that check
// shipped trigger A alone and dropped a title-word trigger B because B false-positived
// on the very task introducing it. No second trigger is invented here either.
//
// W1-T399 — THE MONOLITH-ONLY TRIGGER WENT BLIND AS THE MONOLITH FROZE. PR #1060 stopped
// routing new filings into `plan/tasks.yaml`; a task now stores its record in its own
// `plan/tasks.d/<id>-<slug>.yaml` shard (of the last twenty merged implementation PRs,
// nineteen worked a shard task). The literal-path trigger above never saw any of them —
// a task declaring its OWN shard alongside an out-of-scope path has the identical
// `criteriaTampered` exposure as W1-T324/W1-T369 did declaring the monolith, but passed
// this check silently. Widened to also match a shard path — NOT to "any plan-scope path"
// (the measured rejection above still holds; `plan/policy.yaml` beside `src/lib/policy.ts`
// remains legitimate and untouched). Re-measured over all 442 task records at 9b6687b with
// the widened trigger: the monolith clause alone still fires once (unchanged); the shard
// clause adds ZERO newly-failing open records — no staging is needed.
```

## advisoryRoutingViolations

Base revision `ea02cc83`, line 2657, 40 comment lines.

```
// ── ADVISORY-ROUTING (W1-T519 — a security-shaped filing is PUBLISHED before it's fixed) ────
//
// SECURITY.md (W1-T23, #320) already routes OUTSIDE reporters to a private GitHub security
// advisory and says plainly "do not open a public issue" — but nothing tells the fleet's OWN
// filers (triage, a recon session, a retro) that the same rule applies to a task shard: filing a
// task IS publishing on this repo, world-readable the moment it merges, and it can name a
// precondition-measured weakness that is not yet fixed. loadPlan reads plan/tasks.d/ on
// origin/main, so the fleet cannot itself act on a finding held in a private advisory — any fix
// there is necessarily HUMAN-BUILT — which is why this check is a WARN, never a gate: it informs
// the operator's routing choice for THIS filing, it never makes that choice (see "WARN-ONLY BY
// CONSTRUCTION" below).
//
// PRECISION OVER RECALL, MEASURED. A naive single-word scan (auth/token/secret/sandbox/scope/
// route/grant) over the live corpus (546 task blocks — every plan/tasks.d/ shard plus the
// monolith, 2026-08-15) hits 345/546 (63%) — wallpaper, not a signal, because this repo
// legitimately uses "scope", "route", "session", "grant" and "tier" in ordinary, non-security
// senses dozens of times a week (a task's declared files: scope, an HTTP route, a review
// session, a duplicate-title grant match, a risk tier). Every entry below instead matches a
// PHRASE naming an actual weakness shape (a bypass, a leak, an unscoped reachable route) and
// never fires on a bare noun. Re-run over the SAME corpus with the phrase table below: 5/546
// (0.9%), every hit inspected and genuine — W1-T10's scoped-PAT injection, W1-T371/W1-T169's
// "token leak"/"leaked" write-token discussions, W1-T493's route-scope-enforcement audit, and
// this task's own rationale (which quotes "auth gap" describing W1-T493/495/500 — a legitimate
// hit, not a false one: this shard's own text genuinely discusses a security-shaped topic).
//
// FIELDS: title + rationale + note — the free-text prose fields a filer actually writes into.
// The task record that requested this check also names `design:`, but that field is DROPPED by
// the plan parser before a {@link Task} object exists (see {@link rawChangedTaskIds}'s own
// comment on the six fields the parser never carries into a parsed Task) — this module is a PURE
// function over an already-loaded Task (module comment, top of file), so there is no `design:`
// text here to match against. Matching only the fields the linter actually receives is the
// honest version of the rule; a follow-up teaching the parser to retain `design:` on Task would
// let this check see it too, with zero changes to the matcher table itself.
//
// WARN-ONLY BY CONSTRUCTION: severity is the literal "warn" below, with NO {@link LintOpts} knob
// anywhere — unlike proofDialect/proofResolvability there is deliberately no way to run this rule
// blocking, in any caller, so it can never stall dispatch, the changed-tasks gate, or a filing.
// The routing decision this warn informs is the operator's; starving the queue over an advisory
// judgment call would be the opposite failure this repo has already paid for once (a ruling
// dispatched instead of parked for a human, W1-T326/#1302 — see {@link rulingVerifyViolation}).
```

## duplicate-closure

Base revision `ea02cc83`, line 2794, 49 comment lines.

```
// ── DUPLICATE-CLOSURE AT KNOWLEDGE INTAKE (W1-T420, narrowed W1-T2486) ───────
//
// ONE PURE MODULE (src/lib/knowledge-dedup.ts's `bestNearDuplicate`), THREE CONSUMERS HERE,
// TWO SEVERITIES — matched to population size and false-positive cost (the W1-T352-vs-W1-T322
// calibration argument applied at filing time). Every consumer below passes its own corpus in
// (this module reads no disk, same purity contract `moduleExists` already keeps for
// `callSiteViolations`); the CALLER resolves `learnings/*.yaml` and `plan/tasks.yaml` + shards
// and injects the result.
//
// (i) `duplicateTitleViolations` — TASK-TITLE INTAKE, ADVISORY. Wired into `lintTask` via
//     `opts.openTaskTitles`, so it runs on every real lint pass once a caller supplies the
//     corpus. WARN-only, unconditionally (no severity override — the whole point of the
//     advisory posture is that it never blocks): title similarity is legitimately high for
//     sibling tasks in an arc (a W1-T369/T370-shaped pair would rightly score high), and a
//     false BLOCK at filing costs a whole re-file cycle. The warn is the pointer; the author
//     decides.
//
// (i-b) `unansweredDuplicateTitleViolations` (W1-T2486) — THE NARROW BLOCKING ARM, not a
//     promotion of (i). Promoting the whole check to `block` would refuse legitimate sibling
//     shards in the same arc (the W1-T369/T370 shape (i) exists to spare) — this arm fires only
//     on an UNANSWERED NEAR-CERTAIN match: score >= {@link NEAR_IDENTITY_DUPLICATE_CUTOFF} (well
//     above {@link DEFAULT_DUPLICATE_CUTOFF}'s "possibly related" line — see that constant's
//     measured sibling ceiling of 0.091) AND neither shard citing the other by either of (i)'s
//     own two additive answers: CITE the sibling in plan_refs, or SAY WHY IT DIFFERS in the
//     rationale. Either shard's exit clears it (`opts.openTaskRecords` carries what the OTHER
//     shard already said, since a plain id/text {@link OpenTaskTitleCorpus} entry cannot answer
//     that). W1-T403/W1-T1062 — byte-identical titles AND files:, both queued, neither citing
//     the other — is the fixture this arm exists to catch; it is exactly the escape the old
//     inbox.ts ratification comment named and could not close, because that check was, and (i)
//     still is, advisory-only.
//
// (ii) `learningDuplicateViolation` — LEARNINGS INTAKE, BLOCKING. NOT wired into `lintTask`
//      (a `Task` does not carry a learning's `fact`/`id` — there is nothing on `Task` to hang
//      this check off), and this task's own declared `files:` is
//      [src/lib/knowledge-dedup.ts, src/lib/task-linter.ts, test/knowledge-dedup.test.ts] —
//      wiring a live gate over `learnings/*.yaml` diffs would mean editing run-task.ts or a CI
//      workflow file, outside that declared scope. Shipped here as a tested, directly callable
//      function (test/knowledge-dedup.test.ts exercises it directly) ready for that follow-up
//      wiring, exactly as `postMergeAmendmentViolations` above documents its own CI-only call
//      site rather than pretending to own it. Population: single-digit additions per week
//      against ~35 active entries — tiny, and every catch saves permanent double context-tax.
//      ANSWERABLE (the W1-T365 exemption shape): a stated distinction naming the matched id
//      clears it — a refusal that cannot be answered would just relocate the judgment it
//      replaces.
//
// THE CUTOFF (both consumers default to `DEFAULT_DUPLICATE_CUTOFF`) is MEASURED, not asserted
// — see that constant's own doc comment in knowledge-dedup.ts and this PR's body for the full
// pairwise score distribution over the live learnings corpus and open task titles that the
// cutoff sits above.
```

## DUPLICATE_SLUG_SHINGLE_K

Base revision `ea02cc83`, line 2844, 21 comment lines.

```
/**
 * W1-T1076: the shingle width the OPEN-PR SLUG corpus is scored at — 2, deliberately NOT
 * {@link DEFAULT_SHINGLE_K}'s 3, and chosen per call exactly as `bestNearDuplicate`'s own
 * `opts.k` was built to allow.
 *
 * WHY A SEPARATE CONSTANT AND NOT THE MODULE DEFAULT. Re-derived on the real predicate against
 * origin/main over every shard in `plan/tasks.d/`, on the two pairs that were filed minutes apart
 * on 2026-08-20 and that nothing caught:
 *
 *   pair A (W1-T1070/W1-T1071)  slug k=3 = 0.111  MISSED   slug k=2 = 0.200  caught
 *   pair B (W1-T1074/W1-T1075)  slug k=3 = 1.000  caught   slug k=2 = 1.000  caught
 *
 * k=3 misses pair A outright. k=1 catches both and is unusable — the whole-plan false-positive
 * load at cutoff {@link DEFAULT_DUPLICATE_CUTOFF} reads 196 pairs at k=1 against 34 at k=2 and 5
 * at k=3 (re-derived, and every one of those counts moves as shards land — re-run it, never quote
 * it). k=2 is the honest middle and pair A sits EXACTLY on the cutoff there, which is stated
 * rather than smoothed over: this width catches that pair by the smallest possible margin.
 *
 * {@link DEFAULT_SHINGLE_K} itself is NOT changed — it is the measured default for the learnings
 * corpus and the title consumer, and moving it is explicitly not this task's to do.
 */
```

## planShardSlugCorpus

Base revision `ea02cc83`, line 2875, 12 comment lines.

```
/**
 * The SLUG corpus for {@link duplicateTitleViolations}, built from a set of changed-file paths.
 * Deduped by id, first path per id wins. PURE — the caller does the GitHub read and hands the
 * paths in, the same seam `opts.moduleExists` and `opts.resolveNameFilteredCandidates` already
 * use, so this module still never reaches disk or network.
 *
 * THE TEXT IS THE SLUG ALONE, NEVER SLUG-PLUS-TITLE. Joining the two is measurably WORSE, which
 * is counter-intuitive enough to be worth stating where an implementer will read it: at k=2 the
 * joined text scores 0.049 and 0.121 on the two pairs above, against the slug's own 0.200 and
 * 1.000. The house title style is long and deliberately distinctive prose, so it floods the
 * shingle set and dilutes the signal the short topical slug carries.
 */
```

## NEAR_IDENTITY_DUPLICATE_CUTOFF

Base revision `ea02cc83`, line 2941, 12 comment lines.

```
/**
 * The near-identity cutoff for {@link unansweredDuplicateTitleViolations}'s BLOCKING arm — well
 * above {@link DEFAULT_DUPLICATE_CUTOFF} (0.2, tuned to flag a merely POSSIBLE duplicate for the
 * warn-only check above) and well above the measured reworded-near-duplicate band that constant's
 * own doc comment reports (0.28-0.36). A genuine sibling pair's measured ceiling is 0.091 (same
 * doc comment); a "same lesson reworded" pair still tops out at 0.36. 0.9 sits far above both —
 * this arm is deliberately built to catch only a near-VERBATIM restatement (the W1-T403/W1-T1062
 * fixture scores a perfect 1.00, byte-identical titles), never a paraphrase or a legitimate
 * sibling, so raising the stakes to `block` never costs a false refusal against either measured
 * population. NOT a change to {@link DEFAULT_DUPLICATE_CUTOFF} itself, or to the scorer/shingle
 * width knowledge-dedup.ts owns — this is a SEPARATE, higher bar for a separate, narrower arm.
 */
```

## unansweredDuplicateTitleViolations

Base revision `ea02cc83`, line 2983, 13 comment lines.

```
/**
 * BLOCKING (the narrow arm, W1-T2486): this task scores >= {@link NEAR_IDENTITY_DUPLICATE_CUTOFF}
 * against some OTHER entry in `opts.openTaskRecords`, AND neither shard has answered — this task
 * does not cite the match (in `opts.taskPlanRefs` or its own `task.rationale`), and the matched
 * entry does not cite this task back (in ITS `planRefs`/`rationale`). Either citation, from either
 * side, clears it: a legitimate sibling pair that names its twin in plan_refs or explains the
 * difference in its rationale is UNTOUCHED by this arm, exactly as (i)'s own message already
 * promises. Absent `opts.openTaskRecords` ⇒ silent — same "no corpus, no opinion" contract
 * {@link duplicateTitleViolations} already uses for `opts.openTaskTitles`.
 *
 * NEVER answered by narrowing `files:` or deleting a proof: this predicate reads only the
 * citation surfaces above, so nothing else about either shard can clear it.
 */
```

## callSiteViolations

Base revision `ea02cc83`, line 3062, 31 comment lines.

```
/**
 * CALL-SITE (impl-DO) — "the code is REACHED, not merely that it exists".
 *
 * ELEVEN MEASURED INSTANCES IN THREE DAYS of code that merged green and nothing ever calls:
 * `console-freshness.ts` (111 lines, 83 of tests, `serve.ts` never imported it — the defect it
 * fixed is still on screen eight days later), `panel-skills.ts`, `panel-skill-run.ts`,
 * `runbook-coverage.ts`, `log-rotation.ts`, and PR #1066's auto-triage rung, whose producer
 * `daemonCommand` never supplied. Eighteen passing tests, three genuine diff-coverage blocks and a
 * green review, dead on arrival.
 *
 * WHY NO EXISTING GATE CATCHES IT (recon-DL): `lint-plan` never opens src/; `tsc` is satisfied
 * because a TEST is an importer; `coverage-ratchet` is satisfied because a unit test calling the
 * function directly covers 100% of it; `remudero-review` executes those same tests. Every gate asks
 * whether the code WORKS. None asks whether anything CALLS it.
 *
 * THE RULE. A task that will CREATE a src/ module must carry at least one acceptance criterion
 * whose proof demonstrates a CALL SITE in a DIFFERENT file: `grep: <symbol>( in <consumer path>`.
 *
 * ★ CALL vs MENTION, AND THE EXACT LIMIT OF WHAT THIS CHECKS. `grep: resolveFreshness in
 * src/lib/serve.ts` passes on a COMMENT — that is precisely how W1-T267's proof exited 0 against
 * entirely unbuilt work. `grep: resolveFreshness( in src/lib/serve.ts` demands the open paren, so
 * the pattern can only be satisfied by something shaped like an invocation. This check enforces
 * THE SHAPE OF THE PROOF, which is mechanically decidable. It does NOT and cannot verify that the
 * eventual grep hit is executable code rather than a comment containing `foo(` — that would need to
 * run the proof against a tree that does not exist yet. Saying so plainly is the point: this is the
 * honest weaker version, and what it cannot catch is a comment written to look like a call.
 *
 * MULTI-LINE CALLS ARE NOT A PRACTICAL RISK HERE, and that was measured rather than assumed: across
 * all of src/ at b5fd9cc there are 12,639 same-line `identifier(` occurrences and ONE split across a
 * newline (0.008%). A line-oriented grep for `foo(` therefore finds real call sites.
 */
```

## monolithFilingViolations

Base revision `ea02cc83`, line 3136, 28 comment lines.

```
/**
 * MONOLITH-FILING (impl-DS) — one storage convention for new tasks.
 *
 * PR #1060 redirected `rmd triage` to propose a new task as its own `plan/tasks.d/<id>-<slug>.yaml`
 * shard rather than appending to the 992 KB `plan/tasks.yaml` monolith. But that is ONLY A PROMPT
 * INSTRUCTION TO AN LLM: `decideTriage` (lib/triage.ts) filters `!f.startsWith("plan/")`, so a shard
 * passes AND so does a monolith append. #1060's own author flagged the gap — the prompt DIRECTS a
 * shard, the validator does not REQUIRE one, and a disobedient worker (or any hand-filing, or the
 * plan/architect lanes) still passes.
 *
 * THIS IS NOT A SIZE EMERGENCY, and the old framing should not be repeated. The 1 MiB buffer cliff
 * is gone (run-task.ts:589/:5298/:5500) and the monolith has essentially stopped growing: +303,798
 * bytes on 07-20, +3,666 on 07-30, ZERO on 07-31. The reason to enforce this is CONSISTENCY — one
 * storage convention the whole toolchain, the id minter and the conflict story can rely on.
 *
 * ID SETS, NEVER DIFF LINES. A reformat, a rename, a moved block or a whitespace change inside the
 * monolith leaves the id set untouched and cannot trip this. Only an id PRESENT in the monolith on
 * this branch and ABSENT from the monolith at the base ref is a violation.
 *
 * IT ALSO CATCHES THE REVERSE MIGRATION, which is more than the minimum asked for and costs nothing
 * extra: the base side is the base's MONOLITH blob specifically (not the merged base plan), so a
 * task moving from a shard INTO the monolith trips too — its id is absent from the base monolith.
 * A task moving the RIGHT way, monolith → shard, never trips: its id simply leaves the monolith.
 *
 * REQUIRES `--base`. "New" has no meaning without one, so {@link LintOpts.newMonolithIds} is
 * undefined in whole-plan mode and this check is silent there — the caller says so out loud rather
 * than letting a check that cannot run look like a check that passed.
 */
```

## lintTask

Base revision `ea02cc83`, line 3282, 15 comment lines.

```
/** Lint one task. Hard checks (sizing/headless-fitness/proof-shape/proof-dialect/
 *  proof-resolvability/post-merge-amendment/blocked-disposition/provenance/ruling-verify) always
 *  run — post-merge-amendment is a no-op absent `opts.postMergeAmendment`, and blocked-disposition
 *  (W1-T2487) is likewise a no-op absent `opts.blockedDisposition` — budget-sanity
 *  runs only when `opts.mountMaxTurns` is supplied, duplicate-title (W1-T420) is a
 *  no-op absent `opts.openTaskTitles`, its narrow blocking arm (W1-T2486) is a no-op absent
 *  `opts.openTaskRecords`, proof-name-resolution (W1-T488) is a no-op
 *  absent `opts.resolveNameFilteredCandidates`, and dispatch-priority (W1-T422) and
 *  advisory-routing (W1-T519) always run — advisory-routing is a no-op (empty array) only
 *  when the task's title/rationale/note match none of {@link ADVISORY_ROUTING_LEXICON}, and
 *  can never block (see {@link advisoryRoutingViolations}'s module comment). blocked-record-
 *  unruled (W1-T2634) also always runs, unconditionally, with no `opts` field at all — it names
 *  every `status: "blocked"` task lacking a legal `retirement:`, in every pass including a
 *  whole-plan `lintPlan` sweep, and — like advisory-routing — can never block (see {@link
 *  blockedRecordUnruledViolations}'s module comment). */
```

## rawChangedTaskIds

Base revision `ea02cc83`, line 3339, 15 comment lines.

```
/**
 * The task ids that are NEW or CHANGED between two plan snapshots (by deep
 * value, not reference) — a pure diff, no git I/O. This is what scopes the CI
 * check (`rmd lint-plan --base <ref>`) to the PR's OWN edit rather than the
 * whole historical queue: Layer A's CI half is "a CI check on any PR that
 * EDITS plan/tasks.yaml" (MASTER-PLAN §5C), so it lints the edit, not decades
 * of pre-existing debt — re-grading the WHOLE open queue is the retro's
 * separate, periodic plan-health sweep (W1-T20d), not every PR's gate.
 */
/**
 * W1-T428: split a raw plan yaml corpus into per-task RECORD blocks, keyed by id. A block runs
 * from its `- id:` line to the next one (or EOF), trimmed of trailing whitespace so a record
 * moved to a file's tail never differs by its final newline alone. Pure over the supplied text —
 * no disk, no git, the same contract as every other function in this file.
 */
```

## read-identity and root-containment

Base revision `ea02cc83`, line 3421, 12 comment lines.

```
// ── READ-IDENTITY & ROOT-CONTAINMENT (gate integrity, W1-T120) ──────────────
//
// A gate that reads a task/plan must be provably reading the RIGHT ONE — a silent
// wrong-file read is still green and still wrong (the #271 false-green: one
// checkout's `bin/rmd`, invoked with cwd inside a DIFFERENT work tree, linted the
// INSTALL tree's plan and never opened the file under test at all). These two pure
// helpers give `run-task.ts`'s `lint-plan`/`review` commands the vocabulary to (a)
// refuse an out-of-root `--plan` BY NAME instead of letting it fail downstream as a
// confusing base-resolution error, and (b) print the absolute path + content hash
// of the file actually opened, so a wrong-file run is visible in its own output
// instead of merely inferred from cwd. Both are pure string/hash logic over
// ALREADY-READ input — no filesystem I/O, consistent with this module's contract.
```

