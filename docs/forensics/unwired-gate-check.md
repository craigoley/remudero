# unwired-gate-check.mjs comment forensics

The measured incidents, design arguments and rejected alternatives that were removed from
`scripts/unwired-gate-check.mjs` when its comments were compacted to the plain-language standard
(docs/comment-standard.md). Nothing was cut: each section below is the file's own prose, verbatim,
under a heading naming the symbol it explained. The file itself keeps a one-line `// Why:` (or
inline citation) pointer wherever the history mattered.

Line numbers below are positions in `scripts/unwired-gate-check.mjs` at the merge base of the
compaction PR (`origin/main` at 94ba42cfba8513ed739f8b153246d42ede4b1bd6).

## The file header

Removed from lines 2-60.

```
// scripts/unwired-gate-check.mjs
//
// UNWIRED-GATE GUARD (W1-T2735).
//
// THE PROPERTY: a gate-shaped instrument that nothing invokes is not a gate. It is a file that
// reads like enforcement to every later session, answers correctly when a human runs it by hand,
// and refuses nothing. `scripts/credit-surface-gate.mjs` is the measured exemplar -- it exists to
// refuse an implementation PR credited on NEITHER the `Remudero-Task:` trailer nor a run-shaped
// head, its own suite covers exactly that case, and on 2026-09-02 a PR with a bare `Task:` trailer
// and a `codex/` head reached review with the gate unwired. A human caught it by reading the body.
//
// THE MECHANISM, which is why this is a CLASS and not two accidents: Rule 25's instrument
// isolation refuses a PR that edits both a detector and the workflow invoking it, so a producer
// task must fence the wiring out. Both producers did, correctly and in writing -- W1-T2292
// criterion 7 ("no caller is edited by this task") and W1-T1214 design (v) (defers "wiring this
// script into a CI workflow step (a separate PR ...)"). Neither successor was ever filed. The
// fence is right; nothing noticed that the follow-through never happened. Per CLAUDE.md's own
// preamble, the remedy for a rule violated silently and repeatedly is to make something REFUSE it.
//
// THE PREDICATE IS THE NAME, NOT THE DIRECTORY. A tracked `scripts/` executable whose basename
// ends `-check.<ext>` or `-gate.<ext>` has CLAIMED to be a gate, and this guard holds it to that
// claim. Everything else under `scripts/` is out of scope by construction: `mount-headroom-sweep`
// and `plan-state-claims` are operator-run analysis tools, `shell-screenshot` is a dev utility,
// and `host-parity.ts` is imported programmatically rather than invoked -- none claimed to be a
// gate, none should be a required check, and a directory-wide predicate would report all four.
//
// WIRED means the basename appears in an EXECUTABLE position: the value of a `run:`, `uses:`,
// `entrypoint:`, `args:` or `cmd:` key in a parsed `.github/workflows/*.yml`, or a value in
// `package.json`'s `scripts` map. The workflow files are parsed with the `yaml` dependency rather
// than read as text, because a COMMENT IS NOT AN INVOCATION -- this guard's own CI job names three
// sibling scripts in its explanatory comment, and a text search credited every one of them as
// wired. A commented-out step likewise no longer exists after parsing. Job and step `name:` fields
// are prose and are excluded for the same reason. The match itself requires the position not be
// preceded by a name character, so `foo-check.mjs` is never credited by a mention of
// `bar-foo-check.mjs`.
//
// THE ALLOWANCE IS RECORDED INLINE AND MAY ONLY SHRINK. Wiring the four current offenders at once
// is a different task with a different blast radius (the blanking check alone reports 19 live
// findings, which W1-T2732 owns), so they are recorded here with a reason each and the guard is
// green on the tree it lands in. A NEWLY added gate-shaped script enters at zero allowance and is
// refused immediately -- there is no verb to add one, only an edit a reviewer sees. An entry whose
// script has since been wired, or which names a script that no longer exists, is ITSELF reported:
// a stale allowance is how a ratchet quietly stops ratcheting.
//
// The allowance is deliberately NOT a `scripts/*-baseline.json` file, which is the house idiom for
// the ratchets: that path is in the reviewer's `INSTRUMENT_SURFACE` (src/lib/review.ts), so a PR
// draining one entry would trip the very Rule 25 entanglement that produced this class.
//
// WHAT THIS CANNOT CATCH -- stated so no reader mistakes a clean run for proof of enforcement: a
// script that really is in a `run:` step, but whose step is never reached or whose exit code is
// discarded (a job with an `if:` that is always false, a step with `continue-on-error: true`, a
// command ending `|| true`), reads as WIRED here. Parsing removes the comment and commented-out
// cases; it cannot decide reachability. This guard proves a gate sits in an EXECUTABLE position,
// not that its refusal is honoured. It raises the floor from "nothing invokes this" to "something
// runs it".
//
// Usage:
//   node scripts/unwired-gate-check.mjs
// Exits 1 and names every offending path; exits 0 ("clean") otherwise.
```

WHY THIS MATTERS. `scripts/credit-surface-gate.mjs` is the measured exemplar: both producer tasks
(W1-T2292 criterion 7, W1-T1214 design (v)) correctly fenced their own wiring out of scope and
filed no successor to do it, so the gate sat unwired until a PR with a bare `Task:` trailer and a
`codex/` head reached review on 2026-09-02 and a human caught it by reading the body. The fix Rule
25 forces — a producer task must fence wiring out of its own diff — is right; nothing noticed the
follow-through never happened, which is why this guard exists rather than a retro note. The
allowance is deliberately not a `scripts/*-baseline.json` file because that path sits in the
reviewer's `INSTRUMENT_SURFACE` (src/lib/review.ts): draining an entry there would trip the exact
Rule 25 entanglement this guard exists to route around.

## NPM_CHECK_SHAPED_RE

Removed from lines 109-125.

```
// ── R-46: the SAME hazard, one level up -- an npm SCRIPT NAME can claim to be a gate too ───────
//
// {@link GATE_SHAPED_RE} judges a tracked `scripts/` FILE's basename. That predicate is blind to
// `docs-index:check-paths`: its underlying file, `scripts/generate-docs-index.mjs`, does not end
// in `-check.mjs`/`-gate.mjs` -- the CLAIM to be a gate lives in the npm alias name
// (`package.json`'s `"docs-index:check-paths": "node scripts/generate-docs-index.mjs
// --check-paths"`), not the file it runs. R-46 (docs/audits/recon-2026-09-05.md) measured exactly
// this: `docs-index:check-paths` failed at HEAD and was invoked by no workflow, and this guard's
// own file-basename predicate could not see it (`git grep -n docs-index -- .github/` = 0, yet
// `isGateShaped("scripts/generate-docs-index.mjs")` is false).
//
// THE PREDICATE IS THE NAME, SAME AS ABOVE, ONLY NOW IT IS THE PACKAGE.JSON KEY. A hyphen or colon
// is required before the `check` suffix, so bare `"check"` (the repo's own aggregate runner,
// `node scripts/check.mjs`) is not swept in -- the identical hyphen-guard reasoning
// {@link GATE_SHAPED_RE} already applies to `scripts/check.mjs`/`scripts/gate.mjs`. A trailing
// `-<word>` (`:check-paths`) is also check-shaped: the generator's OWN two flags are
// `--check`/`--check-paths`, and both are exactly the shape this predicate exists to catch.
```

MEASURED (R-46, docs/audits/recon-2026-09-05.md): `docs-index:check-paths` failed at HEAD and was
invoked by no workflow, and `git grep -n docs-index -- .github/` returned zero hits while
`isGateShaped("scripts/generate-docs-index.mjs")` read `false` — the file-basename predicate could
not see the failure because the claim to be a gate lives in the npm alias name, not the file it
runs.

## NPM_SCRIPT_ALLOWANCE

Removed from lines 136-147.

```
/**
 * THE RECORDED ALLOWANCE for check-shaped npm SCRIPT NAMES -- the sibling of {@link ALLOWANCE},
 * same shrink-only contract, same written-reason requirement, keyed by `npmScript` (a
 * `package.json` scripts key) rather than a tracked file path. Measured against the real tree
 * 2026-09-05: of 14 check-shaped npm script names, 6 are wired (`api-client:check`,
 * `no-hand-rolled-fetch:check`, `unwired-gate:check`, `mkdtemp-callsite-check`,
 * `task-id-existence:check`, and `docs-index:check`/`docs-index:check-paths` as of THIS PR's own
 * `.github/workflows/docs-index-check.yml`), and the 7 below are not -- each is a DIFFERENT
 * generator's own staleness/consistency check, tested at the unit level but invoked by no CI job,
 * and wiring any one of them is a separate, single-concern PR (widening this allowance list is
 * the visible edit a reviewer sees when that happens; there is no verb that appends to it).
 */
```

MEASURED 2026-09-05, against the real tree: of 14 check-shaped npm script names, 6 were already
wired (`api-client:check`, `no-hand-rolled-fetch:check`, `unwired-gate:check`,
`mkdtemp-callsite-check`, `task-id-existence:check`, and `docs-index:check`/`docs-index:check-paths`
as of that PR's own `.github/workflows/docs-index-check.yml`). The remaining 7, recorded in the
allowance, are each a different generator's own staleness/consistency check: unit-tested but
invoked by no CI job, and wiring any one of them is a separate, single-concern PR.

## collectWiringText

Removed from lines 330-346 (the JSDoc; the function body was unchanged).

```
/**
 * Every text an invocation can live in: the executable positions of each parsed
 * `.github/workflows/*.yml`, plus every VALUE in `package.json`'s `scripts` map.
 *
 * The workflows are PARSED, not read as text. A text search over the raw file credits a script
 * named in a comment -- measured while building this guard: its own CI job comment names
 * `credit-surface-gate.mjs`, `coverage-session-blanking-check.mjs` and
 * `tracked-source-write-check.mjs`, and the text form reported the first of them as newly wired.
 * A comment is not an invocation, and neither is a commented-out step.
 *
 * `package.json` KEYS are excluded for the same reason: an npm script NAMED
 * `state-citation-check` whose body runs something else would otherwise credit itself.
 *
 * A workflow that fails to parse THROWS naming the file rather than contributing nothing -- a
 * silently empty wiring text would report every gate-shaped script as unwired at once, which is
 * loud, but a parse error the operator can read is better than a wall of false violations.
 */
```

MEASURED while building this guard: its own CI job comment names `credit-surface-gate.mjs`,
`coverage-session-blanking-check.mjs` and `tracked-source-write-check.mjs`, and a first-draft text
search over the raw workflow file reported `credit-surface-gate.mjs` as newly wired purely on that
basis — a false WIRED. Parsing the YAML instead drops comments and commented-out steps outright.

## GATE_SHAPED_RE

Removed from lines 68-71.

```
/**
 * The gate-shape predicate, applied to a BASENAME. A hyphen is required before the suffix, so
 * `scripts/check.mjs` -- the repo's own aggregate runner -- is not swept in by its bare name.
 */
```

## ALLOWANCE

Removed from lines 77-82.

```
/**
 * THE RECORDED ALLOWANCE. Every entry is a gate-shaped script that is unwired TODAY and whose
 * wiring is owned elsewhere. It may only shrink: delete a row when its script is wired, and this
 * guard will report the row if you forget. There is no verb that appends to it -- adding a row is
 * an edit a reviewer reads, which is the whole point.
 */
```

## NPM_SCRIPT_IDENT_RE

Removed from lines 128-134.

```
/** Characters that can appear inside an npm script name -- wider than a file basename's
 *  {@link isWired} boundary class because npm script names use `:` as a namespace separator
 *  (`docs-index:check`) as well as `-`. Used to stop a shorter script name being credited by a
 *  longer sibling's mention, e.g. `docs-index:check` must never be "wired" merely because
 *  `docs-index:check-paths` appears in a `run:` step -- the identical hazard the file-basename
 *  {@link isWired} guards against for `foo-check.mjs` vs. `bar-foo-check.mjs`. */
```

## listNpmScriptNames

Removed from lines 203-205.

```
/** The `package.json` scripts map's keys, tolerating a missing/unparseable file the same way
 *  {@link collectWiringText} already does for its own read of the same file (an absent or broken
 *  package.json has no scripts to judge, not a throw). */
```

## isNpmScriptWired

Removed from lines 216-226.

```
/**
 * Npm-script-name occurrence at a position not preceded OR FOLLOWED by an npm-script-name
 * character -- the two-sided version of {@link isWired}'s one-sided guard, needed because a
 * check-shaped name can be a PREFIX of a longer sibling's name (`docs-index:check` is a prefix of
 * `docs-index:check-paths`), not merely a suffix of one (`foo-check.mjs` inside
 * `bar-foo-check.mjs`, the case {@link isWired} was built for). Reuses the SAME wiring text
 * {@link collectWiringText} already builds (every workflow's executable strings plus every
 * `package.json` script's VALUE) -- an npm-run invocation and a compound script that chains
 * `npm run <name>` both live there; a script's own KEY is never part of that text, so a script
 * cannot self-credit.
 */
```

## scanNpmScripts

Removed from lines 238-241.

```
/**
 * The npm-script-name judgement, over an injectable tree -- the sibling of {@link scanRepo},
 * same `unwired`/`stale` shape and the same shrink-only contract for its allowance.
 */
```

## listTrackedScripts

Removed from lines 275-285.

```
/** Tracked `scripts/` executables, via `git ls-files` -- the tracked set is the subject, and this
 *  keeps untracked scratch out of scope with no separate exclusion list.
 *
 *  Retries a CLEAN nonzero exit up to twice more, a short beat apart, before throwing: a
 *  same-process `git ls-files` is read-only and never fails on a healthy repo, so a failure here
 *  is either genuinely no-repo (this loop still throws, just after `attempts` tries -- unchanged
 *  for `listTrackedScripts` called against a real non-repo directory) or a TRANSIENT race with
 *  another `git` process sharing this checkout (a momentary `index.lock`, the exact shape
 *  test/setup/tmp-hygiene.ts's own module comment (W1-T1217) already measured and fenced for a
 *  clone racing a background `gc --auto` in this same suite). `spawn` is injectable so a test can
 *  simulate that race deterministically rather than needing a genuinely flaky host. */
```

## isWired

Removed from lines 377-381.

```
/**
 * Basename occurrence at a position not preceded by a name character, so `foo-check.mjs` is never
 * credited by a mention of `bar-foo-check.mjs`. A plain `includes` would silently over-credit the
 * shorter of any two scripts sharing a suffix.
 */
```

## scanRepo

Removed from lines 393-398.

```
/**
 * The whole judgement, over an injectable tree. Returns both directions the allowance can be
 * wrong: `unwired` (a gate-shaped script nothing invokes and nothing has recorded) and `stale` (a
 * recorded entry whose script is now wired, or has been deleted) -- because an allowance that only
 * ever grows is not a ratchet.
 */
```

## main

Removed from lines 426-432.

```
/**
 * The CLI's whole behaviour, injectable exactly like scripts/tracked-source-write-check.mjs's own
 * `main` (same shape, same reason): every collaborator carries a real default, so the entry point
 * below stays a bare `main()` call while a test drives BOTH the clean and the violation-found path
 * in-process. It RETURNS the exit code rather than assigning it, so a fixture's outcome can never
 * leak into the real `node --test` runner's `process.exitCode`.
 */
```
