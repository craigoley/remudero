# Forensics — `src/lib/plan-pr-emitter.ts`

A verbatim archive of the comment blocks compacted out of `src/lib/plan-pr-emitter.ts` when its
comments were shortened to the plain-language standard (`docs/comment-standard.md`). Each heading
names the symbol the block explained. Nothing here is edited: the fenced text is the removed block
exactly as it stood, comment markers included. The source file keeps a one-line `Why:` pointer
wherever the history mattered, and those pointers cite this page.

Base revision: origin/main at `49e429e305c662712b2ee5d653613357a2e03c40`; every line number below
is that revision's.

## File header — the three incidents that forced this module into existence

Removed from lines 1-53.

```
/**
 * lib/plan-pr-emitter.ts — the shared gate-contract module for every MACHINE flow that
 * opens a "plan PR" (W1-T136; `rmd retro` and `rmd approve` today, more later).
 *
 * WHY THIS EXISTS. Two flows independently reinvented commit/PR-body hygiene and both
 * tripped the same CI gate stack (commitlint header+body limits, `plan-index:check`
 * staleness, and `remudero-review`'s fail-closed-on-no-Acceptance-block behavior):
 *
 *   - #287 (retro): `retroCommand` edited MASTER-PLAN.md without regenerating
 *     `plan/plan-index.json`, so `plan-index:check` redded; it also emitted a
 *     non-conventional-commit-type message. Needed two hand-fixes to merge.
 *   - #387 (approve): `approveCommand` (a) spliced a 673-character `stampLine`
 *     VERBATIM, unwrapped, into the commit body -> commitlint `body-max-line-length`
 *     failure; (b) opened a PR body with NO Acceptance section at all ->
 *     `remudero-review` failed CLOSED ("no acceptance criteria to judge"). Needed the
 *     same two-hand fix.
 *   - #394 (a hand-authored filing PR): an Acceptance header that was not BARE on its
 *     own line (`## Acceptance criteria and how each is proved`) was NOT recognized by
 *     {@link "./review.js".parseAcceptanceBlock} and self-posted a RED review — proof
 *     that "looks like an Acceptance block" is not the same as "IS an Acceptance block".
 *
 * The fix is ONE shared, independently-tested module every plan-PR-opening flow calls,
 * so the gate contract lives in one place instead of per-site discipline. It provides
 * six primitives:
 *
 *   1. Acceptance-block RENDERING — {@link renderAcceptanceBlock} — the missing
 *      counterpart to `parseAcceptanceBlock`, guaranteed to round-trip through it.
 *   2. "Ensure judgeable" REPAIR — {@link ensureJudgeableBody} — never clobbers a HEALTHY
 *      Acceptance block; repairs one that is absent OR present-but-unparseable (a criterion
 *      resolving with an empty proof — see {@link bodyNeedsAcceptanceRepair}).
 *   3. Filing-PR Acceptance auto-authorship — {@link filingAcceptanceCriteria} — a PR
 *      that FILES a new task cannot cite that task's own (not-yet-existing) acceptance
 *      criteria, so it needs criteria about the filing itself.
 *   4. Gate-compliant commit-message assembly — {@link buildPlanPrCommitMessage} — wraps
 *      {@link "./commit-message.js".shapeCommitMessage} (never reimplemented) and adds an
 *      OPTIONAL task-id trailer (see the correctness rule below).
 *   5. PR-body assembly — {@link buildPlanPrBody} — intro + a rendered Acceptance block +
 *      an optional trailer, guaranteed judgeable by construction.
 *   6. Plan-index regeneration — {@link regeneratePlanIndexFile} /
 *      {@link regeneratePlanIndexAndCommit} — mirrors {@link "./orientation.js".regenerateOrientation}'s
 *      write/add/diff-cached-quiet/commit-if-changed pattern, for `plan/plan-index.json`
 *      (the #287 fix), invoking `scripts/generate-plan-index.mjs` (never reimplementing
 *      its parsing).
 *
 * THE CORRECTNESS RULE (not just style): a plan-FILING PR — one that introduces a NEW
 * task into `plan/tasks.yaml` that did not exist on `origin/main` — must NEVER carry a
 * `Remudero-Task: <id>` trailer. `findMergedByTrailer` (lib/status.ts) searches merged
 * PRs for that trailer and marks the named task DONE; a filing PR only ADDS the task, it
 * does not implement it, so crediting it would permanently mark a brand-new,
 * never-built task complete. Every function here that emits a trailer takes the task id
 * as an OPTIONAL argument for exactly this reason: omit it for a filing PR, supply it
 * for a real implementing PR.
 */
```

## `renderAcceptanceBlock` — the two bullet shapes and the pipe-truncation mechanism

Removed from lines 71-89.

```
/**
 * Render a BARE `Acceptance:` header (nothing else on that line, per the #394 lesson —
 * `parseAcceptanceBlock`'s header regex requires the line to be otherwise empty) followed
 * by CONTIGUOUS bullets, one criterion each, with no blank or prose line between the header
 * and the bullets (the #394 lesson, again — any such line terminates the block early).
 * Guaranteed to round-trip through `parseAcceptanceBlock` with `criteria.length` matching.
 *
 * TWO BULLET SHAPES, chosen per criterion, both of which that parser accepts: the house
 * `- <claim> | <proof>` single line, and — whenever either side contains a `|` of its own —
 * the `- claim: "<claim>"` / indented `  proof: "<proof>"` pair, which carries no separator
 * for the parser to split at. Round-tripping is the whole contract of this function, and a
 * pipe in a claim broke it silently: the criterion still parsed, so nothing failed, but its
 * proof arrived as prose and the criterion fell to the keyword floor.
 *
 * Throws on an empty `criteria` list: an empty Acceptance block is unjudgeable by
 * construction (`parseAcceptanceBlock` would return `[]`, which fails CLOSED in
 * `judgeReview`), so a caller bug here must surface immediately rather than silently ship
 * an unjudgeable PR.
 */
```

## `renderAcceptanceBlock`'s pipe-shape branch — why the split direction matters

Removed from lines 100-106.

```
    // A `|` ANYWHERE in the claim or the proof cannot ride the single-line ` | ` form: the parser
    // splits that line at a separator, so a pipe in the claim either truncates it (before
    // `acceptanceSeparator` scanned from the right) or, in the proof, moves the split INTO the
    // proof and demotes both halves. Emit the OTHER shape `parseAcceptanceBlock` accepts — a
    // `claim:` bullet with an indented `proof:` continuation — where nothing is split at all.
    // Both sides are quoted so `stripQuotes` returns exactly what was passed in, rather than
    // eating a claim's own leading and trailing quote characters.
```

## `bodyNeedsAcceptanceRepair` — the measured false-healthy rate and the W1-T2316 truncation case

Removed from lines 130-166.

```
/**
 * TRUE when a body's Acceptance block needs the repair below — the single definition of
 * "defective", so the repair and its callers can never drift apart on what triggers it.
 *
 * WHY THIS IS NOT `parseAcceptanceBlock(body).length === 0`. That was the original trigger, and it
 * is OFF BY ONE from the defect it exists to catch. `parseAcceptanceBlock` ends the block at the
 * first indented line that is not `proof:`, so a bullet whose text wraps — or one written in the
 * `- **"claim"** — prose` shape with no `|` separator and no `proof:` continuation — pushes ONE
 * criterion with an EMPTY proof and silently discards every bullet after it. Parsed length is 1,
 * not 0, so the repair declined to fire on exactly the shape it was built for.
 *
 * MEASURED over the 100 most recent PRs at 5ea9172: 67 carry a healthy block, 11 carry no block at
 * all (the only case the old trigger caught), and **22 parse to a criterion with an empty proof** —
 * every one of them `parsed=1 empty=1`. The missed shape is twice as common as the caught one.
 *
 * W1-T2316 — AN EMPTY PROOF IS NOT THE WHOLE SIGNAL AFTER ALL, because a wrap can truncate a block
 * WITHOUT leaving an empty proof behind. `- <claim> | <proof>` resolves its proof from the `|` on
 * the SAME physical line, so the first bullet in a wrapped block can parse with a perfectly real,
 * non-empty proof — and then the very next physical line (an indented continuation the parser does
 * not recognise, because the current criterion already has a proof) ends the block, discarding
 * every bullet after it. `parsed.some((c) => !c.proof)` never sees this: every criterion that DID
 * parse has a proof, so `bodyNeedsAcceptanceRepair` returned false and a five-criterion block that
 * parsed to one read HEALTHY. This is the shape rationale (1)/(4) of W1-T2316 measured directly:
 * `bulletsWritten: 5, criteriaParsed: 1`, no empty proof among the one that parsed.
 *
 * THE OLD OBJECTION TO "FEWER CRITERIA THAN WERE WRITTEN" NO LONGER APPLIES, because the count it
 * worried about inventing already exists, computed from the SAME body being checked, with no
 * outside record required. {@link "./review.js".acceptanceBlockDiagnostics} counts `bulletsWritten`
 * with the parser's OWN bullet regex and reports `truncatedAtBullet` — the index of the first
 * bullet the parser did not reach — so "fewer criteria parsed than bullets written" is read off the
 * text itself, never guessed from the author's intent and never dependent on
 * {@link renderAcceptanceBlock} having produced the body in the first place.
 *
 * {@link "./review.js".parseAcceptanceBlock} is NOT changed. It must stay permissive — making it throw would fail
 * bodies that merge today (any with trailing prose under the block) and move a hard failure into the
 * gate, where the author is already gone. The parser keeps its contract; the repair widens.
 */
```

## `ACCEPTANCE_HEADER_RE` — why the repair needs its own header demotion

Removed from lines 177-192.

```
/**
 * The header regex {@link "./review.js".parseAcceptanceBlock} matches, mirrored here for ONE purpose: to demote a
 * defective header so the parser walks PAST it to the repaired block appended below. It requires the
 * line to be ONLY the header, so appending a suffix is sufficient to stop it matching — no content is
 * removed and the author's original text stays verbatim and readable.
 *
 * WHY THE REPAIR NEEDS THIS AT ALL, which is the half the trigger widening exposed. `ensureJudgeableBody`
 * APPENDS its fallback, and the parser stops at the FIRST header it finds. That is fine for the case the
 * repair was built for — a body with NO block, where there is nothing earlier to stop at. It is NOT fine
 * for a body whose block is PRESENT BUT DEFECTIVE: the parser reaches the broken bullets first, resolves
 * the same empty-proof criterion, and never sees the appended block. Widening the trigger without this
 * would have produced a guard that edits a PR body, logs `acceptance.repaired`, and leaves the body
 * exactly as unjudgeable as before — worse than not firing, because it claims a repair that did not
 * happen. Verified before writing this: the appended-only form returned
 * `[{claim:"…wraps it onto a second", proof:""}]` from the REPAIRED body.
 */
```

## `renderChangedFilesBlock` — the 2026-08-31 staleness incidents

Removed from lines 296-318.

```
/**
 * W1-T2535 — RENDER the changed-files section from the diff instead of restating it in prose.
 *
 * THE PATTERN, NOT AN INCIDENT. Every "exactly N files" or scope sentence in a PR body is
 * `git diff --name-only` restated by hand, and it goes stale the moment anything is added to the
 * diff — after which `bodyContradictsDiff` is CORRECT to refuse a body that was true when written.
 * MEASURED 2026-08-31, the same claim failing for all three kinds of author in one day: fleet
 * workers (#3365, #3378, each after recording a size ceiling), a careful hand-edit (a seven-PR
 * batch that added the ceiling line and left every body untouched), and #3388 — whose entire
 * subject is this detector, refused by it.
 *
 * THE PRECEDENT IS EXACT. {@link renderAcceptanceBlock} exists because hand-written acceptance
 * blocks kept failing to parse: the identical failure mode, on the identical surface, solved by
 * GENERATING the section rather than asking authors to get it right. There was no equivalent for
 * changed files, and that is precisely the section still failing.
 *
 * WHY THIS IS STRUCTURAL RATHER THAN A BETTER WARNING (#3377 and #3388 both shipped warnings, and
 * both were mitigations): a block rendered FROM the diff cannot contradict the diff, because it IS
 * the diff. There is no claim left to go stale.
 *
 * EMITS NO COUNT. A count is a second assertion about the same list, and the list is already
 * present and countable — writing both is how the two drift. The paths ARE the claim.
 */
```

## `regeneratePlanIndexFile` — the macOS symlink trap behind the #287 incident

Removed from lines 474-480.

```
  // realpathSync: the script's own "run as main" guard
  // (`import.meta.url === pathToFileURL(process.argv[1]).href`) compares a RESOLVED URL
  // against argv[1]'s literal path. If `worktreePath` sits under a symlink (e.g. macOS's
  // `/tmp` -> `/private/tmp`, which any temp-dir-rooted worktree could), an unresolved
  // scriptPath never matches and `main()` silently never runs — exit 0, nothing written,
  // and the STALE index survives (the exact #287 failure this module exists to prevent).
  // Resolving here makes the primitive correct regardless of where `worktreePath` lives.
```

## Section 7 header — the ratification-PR GraphQL incident

Removed from lines 531-540.

```
// ── 7. Ratification PR — REST create + resumption probe (W1-T903) ───────────────────────────
//
// `rmd approve`'s ratification PR used to open over `gh pr create`, which is GraphQL — an
// exhausted GraphQL budget stranded an already-pushed ratification branch with no PR, and the
// naive re-run pushed a SECOND branch rather than finishing the first. Both primitives below are
// a PURE TRANSPORT SWAP at this ONE site: `openPlanPr` (run-task.ts) already authors an explicit
// `--title` and `--body` (buildPlanPrBody + filingAcceptanceCriteria above), so unlike the four
// `--fill` sites this module's header doc excludes, no body has to be invented to make the swap.
// `fetch` is the SAME {@link GhApiFetcher} `fetchOpenPrsRest` (open-prs-rest.ts) already takes,
// reused unchanged rather than re-derived — real callers pass `ghJson` (lib/worker.ts).
```

## Section 8 header — the four `bodyContradictsDiff` retro incidents

Removed from lines 593-628.

```
// ── 8. Retro changeset-claim reconciliation (W1-T911) ───────────────────────────────────────
//
// `retroCommand` (run-task.ts) spawns the Architect worker, which edits MASTER-PLAN.md, pushes,
// and OPENS THE PR — writing a body whose changeset claim is TRUE at that instant (the diff
// really is one file). Only AFTER the worker returns does the harness commit
// `docs/ORIENTATION.md` (regenerateOrientation) and `plan/plan-index.json`
// (regeneratePlanIndexAndCommit) into that SAME PR, widening the diff the body already
// described. `bodyContradictsDiff` (review.ts) then reads the widened diff against the
// now-stale body and refuses it — four real instances (#974, #1685, #1943, #1944), the last two
// 23 minutes apart with a byte-identical "exactly one file" failure. The claim's author (the
// Architect) cannot be the one to fix this: it does not exist anymore by the time the body goes
// stale, and it never knew what the harness would append after it returned.
//
// This is a PURE reconciler — no git, no network, no I/O — taking the body and the paths the
// caller already computed (run-task.ts reads them via `gh pr diff --name-only`, after both
// harness commits land). It repairs ONLY the two arms `bodyContradictsDiff` actually keys on
// (that function's own doc forbids guessing at prose beyond them):
//
//   (a) a stated file COUNT ("exactly N files[: a, b]") that disagrees with the real changeset.
//       Repaired by replacing the whole count-shaped claim with a sentence that ENUMERATES the
//       real paths and states no count at all — never a recomputed number, which would just be
//       the same defect wearing a new number the next time the harness regenerates a different
//       arity of companion file. See {@link retroChangesetSentence}.
//   (b) a "no <path>" DENIAL for a path the diff actually carries — what #1943 tripped by
//       writing "No docs/ORIENTATION.md" while carrying it. Repaired by DROPPING that specific
//       denial (never rewriting it into a new claim, which could itself go stale). A denial the
//       diff does NOT refute — "no src/" on a genuinely plan-only retro — is TRUE and SURVIVES:
//       it is the reader's real assurance the retro carried no code, so only a denial the diff
//       actually contradicts is ever touched.
//
// Deliberately NOT built on top of `bodyContradictsDiff`'s own detection regexes (imported or
// otherwise): sharing symbols would let a future widening of the detector silently change what
// this rewrites without either side noticing. The two are held together by a FALSIFIER instead
// (test/retro-changeset-claim.test.ts drives the real `bodyContradictsDiff` over this function's
// output and requires it to fall silent), which is the same discipline run-task.ts's prior
// arm-(a)-only rung (W1-T908) already used.
```
