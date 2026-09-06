# diff-coverage.mjs forensics

The measured forensics, incident narratives and design arguments removed from
`scripts/diff-coverage.mjs` when its comments were compacted to the plain-language standard.
Every block below is the removed text verbatim, marker characters stripped and nothing else
changed. Headings name the symbol or section the text explained; the code keeps a one-line
`// Why:` pointer where the history mattered. Base revision: origin/main at
1aec2871bc4d380d1f6bfbd558d32226287729ab; the line numbers below are that revision's.

## Module header

### Base lines 2-39 — the gate's relationship to coverage-ratchet.mjs, the DA:0/relocation design, usage

```
// scripts/diff-coverage.mjs
//
// Per-diff coverage gate (W1-T212, recon R-12, MASTER-PLAN §5 TIER 2 gate 1b).
//
// scripts/coverage-ratchet.mjs's floor is aggregate-only: it sums LF/LH/BRF/BRH across every
// file record in the lcov report and compares two scalars against a recorded baseline. That is
// diff-blind BY DESIGN (test/coverage-ratchet.test.ts's PLAN-ONLY FALSIFIER proves it never reads
// which files a PR touched) -- which means new code with ZERO covering tests merges freely as
// long as the codebase-wide aggregate stays above the floor. The larger remudero grows, the less
// any single untested addition can move that aggregate, so the floor's protection erodes over
// time even though its own tests never change.
//
// This script is a SEPARATE, diff-scoped check that closes that hole without touching the
// aggregate ratchet: it reads the SAME lcov report the aggregate ratchet already produces (no new
// tooling -- the node --test lcov reporter already emits one SF:/DA: record per file, which is
// exactly why the aggregate has to sum them) plus a unified diff, and fails when the diff ADDS a
// line under a file lcov instruments (a `DA:<line>,<hits>` record exists for it) that lcov
// recorded as NEVER HIT (`hits === 0`). A line the diff adds that lcov never instruments at all
// (a comment, a blank line, a brace -- no DA: record for that line) makes no coverage claim
// either way, so it is silently skipped: this gate only polices lines lcov itself considers
// coverable, and only lines the diff itself added (an already-uncovered pre-existing line is the
// aggregate ratchet's problem, not a new regression this diff introduced).
//
// W1-T2325: a "the diff itself added" line and a PRE-EXISTING line that merely moved during a
// restructure both show up as a `+`, and only the first of those is actually this diff's problem.
// computeRelocatedLines (below) recovers the discriminator -- identical text on the diff's own
// `-` side -- and treats a match as exempt, the same way the process-boundary and type-only
// carve-outs already are, never a bypass on the genuinely-new case.
//
// Usage:
//   node scripts/diff-coverage.mjs --lcov <path> --diff <path>
//
// Defaults: --lcov coverage/lcov.info; --diff reads the unified diff from stdin if omitted.
//
// The pure functions below (parseLcovHitsByFile, reconcileDuplicateFunctionDeclarations,
// addedLinesByFile, findUncoveredAddedLines) are exported so a falsifier fixture test can exercise
// the CLI process directly (spawn + exit code) as well as the parsing/comparison logic in
// isolation, the same split coverage-ratchet.mjs uses.
```

## parseLcovHitsByFile

### Base lines 49-67 — SF: block merge and the W1-T2276 corrupted-merge measurement

```
/**
 * Parse an lcov report into `Map<filePath, Map<lineNumber, hitCount>>` -- one inner map per
 * `SF:`/`end_of_record` block, populated from that block's `DA:<line>,<hits>` records.
 *
 * MULTIPLE `SF:<path>` BLOCKS FOR THE SAME FILE ARE MERGED, NEVER LAST-WINS-REPLACED (W1-T2276).
 * `--experimental-test-coverage`'s own multi-process merge can emit a SECOND, MALFORMED record
 * for a file -- observed on `src/lib/ledger.ts`: a test file that cannot report its own coverage
 * at all (a `startOffset` crash, zero-byte lcov standalone) instead contributes a shifted copy of
 * ANOTHER module's function table when merged with any sibling, with every `FN:` declaration line
 * exactly 3 lines above its true position. Before this fix, a second `SF:` line for a path already
 * seen replaced `current` with a brand-new empty map, so whichever block the reporter happened to
 * write LAST silently discarded the other block's `DA:` data outright -- measured: 99 lines a
 * single clean process reports as executed (nonzero `DA:`) read `DA:<line>,0` in the merged
 * report, over an IDENTICAL 1,510-line `DA:` line-number set (nothing phantom was added to the
 * denominator; real hits were simply overwritten by a later, zero-valued duplicate). Reusing the
 * SAME per-line map across every `SF:<path>` block for that path turns the DA: reconciliation
 * below into the fix, rather than requiring a second pass.
 * @param {string} lcovText
 */
```

## FN: record parsing

### Base lines 83-92 — multi-function declaration lines and the source-map decl artifact

```
      // FN:<line>,<name> — a function DECLARED at <line>. Under --enable-source-maps the
      // tsx-compiled map scores declaration lines DA:0 even when the function body is fully
      // covered (observed: FN:62 with FNDA:11 beside DA:62,0) — FNDA is the truth for them.
      //
      // ONE LINE CAN DECLARE SEVERAL FUNCTIONS, so this is a LIST, never a single name (W1-T481).
      // Measured on a full-suite lcov: 282 (file, line) keys carry more than one FN record against
      // 4,042 distinct keys — about one declaration line in fourteen. The shape is always the same,
      // an exported function sharing its line with an anonymous callback (`buildAccountUsageRoute`
      // with `anonymous_14`; `runAlertLane` with `anonymous_12`). Keyed last-wins, the line resolved
      // to the anonymous one and an entered function was reported as never entered.
```

## FNDA: record parsing

### Base lines 100-105 — any-non-zero merge, the duplicate-pair measurement

```
      // ANY-NON-ZERO, never last-wins. The same (file, name) pair recurs throughout a merged
      // full-suite lcov (measured: 1,362 duplicate pairs, 48 of them with more than one NON-ZERO
      // value — `findMergedByTrailer` carries both FNDA:79 and FNDA:1089), so a later FNDA:0 would
      // erase an earlier real call count. This is deliberately NOT an arithmetic: the sole consumer
      // is declEntered, which asks only `was this function ever entered`, so summing or maxing would
      // invent a call count nothing reads.
```

## DA: record parsing

### Base lines 111-117 — any-higher-wins and what the W1-T2276 corruption erased

```
      // ANY-HIGHER-WINS, never last-wins (W1-T2276, same ANY-NON-ZERO shape FNDA: above already
      // uses for exactly this reason). A duplicate `DA:<line>,<hits>` for a line already seen in
      // this file's OTHER `SF:` block(s) can only ever be evidence -- some process really did
      // execute that line N times -- so keeping the larger of the two counts can never invent a
      // false claim of coverage; overwriting a real, nonzero count with a later, zero-valued
      // duplicate (last-wins, the pre-fix behaviour) is what erased 99 genuinely-covered lines to
      // `DA:<line>,0` in the corrupted merge this task measured.
```

## reconcileDuplicateFunctionDeclarations

### Base lines 131-151 — the third (file, name) reconciliation and the 16-pair, 3-line-offset measurement

```
/**
 * THE THIRD (file, name) RECONCILIATION, BESIDE `fnLines`'s per-line name LIST and `fnHits`'s
 * ANY-NON-ZERO merge above (W1-T2276): a merged lcov can carry the SAME function name declared at
 * TWO DIFFERENT lines in one file -- not "one line declares several functions" (a legitimate,
 * different shape those two mitigations already handle, W1-T481), but one function whose `FN:`
 * record itself was emitted twice, at two different line numbers, by two different processes'
 * merged coverage. Observed on `src/lib/ledger.ts`: 16 function names each carrying two `FN:`
 * records, every one of the 16 pairs exactly 3 lines apart (`rotateLedger` at both 1095 and 1098;
 * `appendLedger`, uncorrupted, carries exactly one). Mutates `fnLines` (`Map<path, Map<declLine,
 * name[]>>`) IN PLACE, same shape as `dedupeRollupByLatestAttempt` (src/lib/sweep.ts): group by
 * key -- here `(path, name)` -- and collapse every duplicate group down to exactly one entry.
 *
 * The kept line is the LARGEST of the duplicate's declared lines. This is not an arbitrary
 * tie-break: every corrupted pair measured has the malformed record 3 lines ABOVE the function's
 * true declaration (this task's own title), so the true line is always the larger one; a name
 * that legitimately appears at only one line is untouched either way. The smaller (phantom) line's
 * entry is removed for that name only -- never the whole line, which may still legitimately carry
 * OTHER function names (W1-T481) -- so a function whose real declaration coincidentally shares a
 * line with a phantom duplicate is unaffected.
 * @param {Map<string, Map<number, string[]>>} fnLines
 */
```

## isTypeOnlyModule

### Base lines 291-312 — why this is transpiled rather than text-scanned, and the fails-closed posture

```
/**
 * W1-T2570: does this file transpile to NOTHING EXECUTABLE?
 *
 * "No `SF:` record" has TWO causes and the gate used to treat them as one:
 *   1. no shard imported the file — the real vacuity hazard, and failing closed on it is right;
 *      sharding is exactly what makes it material (#1399).
 *   2. THE FILE COMPILES TO NOTHING, so there was no instrumentation to emit.
 * A pure type module hits case 2 and got case 1's verdict, under a message — "coverage would
 * otherwise pass vacuously" — that is exactly backwards for it. Nothing passed vacuously; there
 * was nothing to measure.
 *
 * ⚠ TRANSPILED, NEVER TEXT-SCANNED, AND THAT DISTINCTION IS LOAD-BEARING. A first pass at this
 * census read source text for `function`/`class`/`=>` and wrongly called `src/lib/proof-grammar.ts`
 * type-only; it is 1,423 bytes of real emitted code and must keep requiring an SF record. Only
 * transpiling separates them. MEASURED on main: `workflow-run.ts`, `merge-state.ts`,
 * `run-result.ts` and `supersession.ts` all emit 0 bytes, against `proof-grammar.ts` at 1,423 and
 * `sweep.ts` at 136,412.
 *
 * FAILS CLOSED ON ANY DOUBT. An unreadable file, a syntax error, or an esbuild that cannot load
 * all answer "not type-only", so the file keeps its coverage requirement. A carve-out that widened
 * itself on an error would be strictly worse than the false block it exists to remove.
 */
```

## findMissingSourceCoverage

### Base lines 330-337 — why the type-only exclusion is a deliberate architectural pattern, not a rare shape

```
/**
 * Changed source files absent from the merged LCOV surface, EXCLUDING those that emit no runtime
 * code at all (W1-T2570 — see {@link isTypeOnlyModule} for why a text scan cannot do this).
 *
 * The type-only files on main exist deliberately to cut dependency cycles (.dependency-cruiser.cjs
 * `no-circular`), so this is not a rare shape that could be refactored away — it is a pattern the
 * repo's own architecture rules produce.
 */
```

## computeRelocatedLines

### Base lines 343-379 — the three bounds and the run-length collision-rate measurement

```
/**
 * A RELOCATION, not an addition: a contiguous run of added lines whose trimmed text matches an
 * unconsumed, equally contiguous run of removed lines in the SAME diff (W1-T2325). The header
 * comment above already settles the policy question -- "an already-uncovered pre-existing line is
 * the aggregate ratchet's problem, not a new regression this diff introduced)" -- and a line that
 * merely moved to a new offset during a restructure IS pre-existing text by that definition, even
 * though the diff can only ever show it as a `+`. This function recovers the ONLY evidence that
 * distinguishes the two cases: identical text on the `-` side of the SAME changeset.
 *
 * THREE BOUNDS keep this from becoming a bypass (see the shard's design, Q3):
 *
 * (i) CONSUME-ONCE. Each removed line matches AT MOST ONE added line -- `consumed` below is a
 * per-file Set of removed-array indices, checked before every candidate match. Duplicating an
 * untested block three times exempts only the first copy; the other two have no unconsumed
 * counterpart left and still block (relocated-duplicate.diff/.lcov fixture).
 *
 * (ii) A RUN, NOT A LINE. `MIN_RELOCATION_RUN` lines of identical, line-number-contiguous text are
 * required before a match counts at all -- a lone `return;` or `const x = 0;` collides with base
 * text by coincidence far too often to trust. This was MEASURED, not picked by taste: scanning
 * src/run-task.ts (29,352 lines) for non-trivial trimmed-text runs that recur anywhere else in the
 * same file, the coincidental-collision rate falls from 1,065/15,376 (~6.9%) at a 1-line run to
 * 77/7,510 (~1.0%) at 5 lines -- a single line is roughly 7x more likely to be a coincidence than a
 * genuine relocation than a 5-line run is.
 *
 * (iii) GREEDY, LONGEST-FIRST, LEFT TO RIGHT. For each added line not yet claimed by an earlier
 * match, every unconsumed removed line with matching text is tried as a possible run start, and the
 * LONGEST resulting contiguous match wins (ties keep the first candidate found). This makes the
 * match deterministic and biases toward the strongest evidence rather than the first coincidence.
 *
 * Every accepted line pairs 1:1 with exactly one counterpart old-line number, so the caller can
 * print the exact counterpart per Q3(iii) of the design ("PRINT EVERY EXEMPTION, naming the
 * counterpart") -- never just "this file had a relocation somewhere".
 * @param {Map<string, Map<number, string>>} added
 * @param {Map<string, Map<number, string>>} removed
 * @param {{minRun?: number}} [opts]
 * @returns {Map<string, Map<number, {counterpartLine: number, runLength: number}>>}
 */
```

## isNonExecutableLine's type-only-import carve-out

### Base lines 444-448 — why a type-only import is safe to recognise per-line with no surrounding context

```
  // A type-only import (`import type { X } from "...";`) is erased COMPLETELY at transpile --
  // it is unambiguous (unlike a value import, which runs for its side effects) and carries no
  // runtime code under any circumstance, so it is safe to recognise per-line with no surrounding
  // context (see computeTypeOnlyRanges below for the analogous interface/type-literal BODY case,
  // which needs brace-matching context to distinguish from a real object literal).
```

## computeTypeOnlyRanges

### Base lines 453-472 — the W1-T171 false block and why a bare member line needs brace-matching context

```
/**
 * The line ranges of a TypeScript `interface`/object-`type` declaration -- W1-T171's
 * dispatch-overlap.ts (a brand-new file whose whole surface is `export interface`/`import type`)
 * false-blocked here first: an interface body compiles to ZERO runtime JS, so under
 * `--enable-source-maps` every one of its member lines still gets a `DA:<line>,0` record (lcov
 * "instruments" a line that literally cannot execute, the same source-map artifact
 * `isNonExecutableLine`'s comment/blank carve-out above already documents for a file's leading
 * doc comment) -- no amount of additional test writing can ever turn that 0 into a positive hit,
 * so treating it as a real coverage gap would block the PR forever. Unlike the comment/blank
 * cases, a bare line like `task: string;` is NOT safely recognisable in isolation (an object
 * literal property or a class field initializer can look identical) -- it is only safe once we
 * know, from the surrounding brace structure, that it sits inside an `interface X { ... }` or
 * `type X = { ... }` declaration, never inside a runtime value. This mirrors
 * `computeBoundaryRanges`'s brace-matching shape exactly (same repo-wide uniform-indent brace
 * style), just with no directive required: an interface/type-literal body can NEVER carry
 * business logic, so -- unlike `// diff-cov: process-boundary` -- there is no misuse risk in
 * exempting it unconditionally.
 * @param {string} fileText
 * @returns {Array<{start: number, end: number, reason: string, kind: 'type-only'}>}
 */
```

## computeBoundaryRanges

### Base lines 502-528 — the two exempt boundary shapes and the fail-closed misuse posture

```
/**
 * Recognise the `// diff-cov: process-boundary — <reason>` directive and return the source
 * regions it exempts (W1-T221, fb-1784807764940-ce2404 + W1-T79/PR#662). Glue that lives at a
 * process boundary cannot carry a `DA:<line>,N>0` hit without actually forking a subprocess, so
 * the diff gate would block it forever. Two boundary shapes qualify:
 *   - RE-EXEC/EXIT: `spawnSync(process.execPath, ...)` then `process.exit(...)` -- you cannot
 *     unit-test a `process.exit` or a re-exec without forking (W1-T221 / PR #662).
 *   - WORKER SPAWN: a thin wrapper `return spawnWorker(buildXArgs(opts))` -- the codebase's
 *     canonical "the arg-builder carries the testable read-only contract; the spawn wrapper is
 *     untested by design because it shells out via the Agent SDK" pattern (spawnSpecialistWorker,
 *     spawnReconSpecialist; W1-T83 / PR #698). The tested contract is the arg-builder; the
 *     one-line spawn delegation around it is the irreducible boundary.
 * This lets an author mark ONE such function, and only such a function: the directive is honoured
 * only when it immediately precedes a declaration whose body (a) contains a process-boundary
 * call and (b) is small (<= MAX_BOUNDARY_EXEC_LINES executable lines). Anything else is an
 * INVALID directive that fails the gate CLOSED (a directive can never hide business logic --
 * misuse blocks the PR harder, not softer), and every honoured exemption is logged by main()
 * so no line is ever silently waved through. Note the boundary call must be DIRECT: a function
 * that calls `spawnReconSpecialist` (itself a wrapper) rather than `spawnWorker` is NOT exempt --
 * it must earn coverage, because such a caller typically carries real orchestration logic.
 *
 * The exempt region runs from the declaration line to the first `}` at the declaration's own
 * indent -- reliable given the repo's uniform brace style. Reads the checked-out file because
 * the diff carries only added lines, not the surrounding declaration/close.
 * @param {string} fileText
 * @returns {{ranges: Array<{start:number,end:number,reason:string,directiveLine:number}>, errors: Array<{directiveLine:number,message:string}>}}
 */
```

## findUncoveredAddedLines's declEntered rescue

### Base lines 606-611 — why the shared-declaration-line rescue is permissive with no strictness cost

```
    // A declaration line is covered when ANY function declared there was entered (W1-T481).
    // PERMISSIVE IS RIGHT HERE AND COSTS NO STRICTNESS: an unentered function that merely shares
    // its declaration line still has its own DA records for its BODY, which are judged
    // independently, so this rescues one line and lets no uncovered code through. The strict
    // reading would block a genuinely-covered exported function because an anonymous callback
    // happens to share its line — the false positive this exists to fix.
```

## Self-describing failures (the check-run annotation channel)

### Base lines 627-651 — why the channel is the annotation, not output.summary, and why it is opt-in

```
// ── SELF-DESCRIBING FAILURES (the check-run annotation channel) ──────────────
//
// WHY THIS EXISTS. A red run's uncovered-line list lived ONLY in the job log, and the log blob is
// unreachable from a diagnosing agent: `GET /actions/jobs/<id>/logs` 302s to
// `productionresultssa11.blob.core.windows.net`, which a proxied environment refuses (measured: the
// CONNECT tunnel returns 403), and the blob is ~12MB against execFileSync's 1MB default buffer.
// Meanwhile the check-run itself carried ONE annotation reading, in full, `Process completed with
// exit code 1.` -- so #2828 sat 13 hours and #2895 could not be diagnosed at all.
//
// THE CHANNEL IS THE ANNOTATION, NOT `output.summary`. A job cannot write `output.summary` (that
// field belongs to whoever created the check run -- Actions itself -- and is empty on every run
// here, measured). What a job CAN write with no extra token or permission is a workflow command,
// which GitHub turns into a check-run annotation readable at
// `GET /repos/<o>/<r>/check-runs/<id>/annotations` -- an endpoint that returns 200 through the same
// proxy that 403s the blob. `%0A` encoding keeps the whole list inside ONE annotation message.
// $GITHUB_STEP_SUMMARY is written too (same shape scripts/test-with-retry.mjs already uses) so the
// list is also on the run page for a human; that channel has no REST endpoint, so it is a
// convenience, never the fix.
//
// OPT-IN, AND DELIBERATELY NOT `GITHUB_ACTIONS`. This job runs the whole suite to produce its lcov,
// and test/{coverage-ratchet,diff-coverage}.test.ts spawn THIS script over BLOCKING fixtures with
// no `env` override -- so a `GITHUB_ACTIONS`-gated emit would publish fixture failures as real
// annotations and make this instrument untrustworthy exactly where it is meant to be trusted.
// `RMD_CI_REPORT` is set per-STEP on the two gate steps in ci.yml (never job-wide, which would
// reach the test step too), so only a real gate invocation reports.
```

## main()'s relocation and directive-resolution comments

### Base lines 710-713 and 716-721 — the relocation carve-out and directive/type-only resolution scope

```
  // W1-T2325: an added line whose identical text was REMOVED elsewhere in the SAME diff is
  // pre-existing text that merely moved, not a new regression -- see computeRelocatedLines for the
  // consume-once / contiguous-run bounds that keep this from becoming a bypass. Derived entirely
  // from the diff's own `+`/`-` lines, no second coverage run.
```

```
  // Resolve `// diff-cov: process-boundary` directives PLUS automatic type-only-declaration
  // ranges (interface/type-literal bodies -- see computeTypeOnlyRanges), but ONLY for files that
  // actually have an uncovered added line -- an unused directive on an otherwise-clean file
  // exempts nothing and is left unvalidated. A malformed/abused directive on a file WITH
  // violations fails the gate CLOSED; type-only ranges need no directive (no misuse risk -- an
  // interface/type-literal body can never carry business logic).
```
