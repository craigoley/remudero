# coverage-session-blanking-check.mjs comment forensics

The measured incidents, design arguments and rejected alternatives that were removed from
`scripts/coverage-session-blanking-check.mjs` when its comments were compacted to the
plain-language standard (docs/comment-standard.md). Nothing was cut: each section below is the
file's own prose, verbatim, under a heading naming the symbol it explained. The file itself keeps
a one-line `// Why:` pointer wherever the history mattered.

Line numbers below are positions in `scripts/coverage-session-blanking-check.mjs` at the merge
base of the compaction PR (`origin/main` at 73c3c4cc513cd1064b256e76523d0a8169cb17d3).

## The file header

Removed from lines 2-62.

```
// scripts/coverage-session-blanking-check.mjs
//
// COVERAGE-SESSION-BLANKING GUARD (W1-T2292).
//
// THE PROPERTY. A parent running under `--experimental-test-coverage` sets `NODE_V8_COVERAGE` on
// itself, and node's OWN `child_process` module force-injects that variable into every spawned
// child regardless of the `env` option handed to `spawnSync`/`execFileSync` -- even a hand-built
// `{ PATH, HOME }` still carries it. An enrolled Node child collects coverage on whatever source
// IT imports and writes its own function/line table into the PARENT's coverage directory. The
// lcov merge key is the ABSOLUTE PATH, so a child that imports the same file the parent's test
// suite already covers merges its own (often much sparser, or import-time-only) hit counts into
// that ONE `SF:` block -- duplicate `FN:` records, split hit counts, and (measured on
// src/lib/ledger.ts) `diff-coverage` naming a genuinely-covered range as uncovered because the
// merged block's evidence no longer agrees with itself.
//
// `delete env.NODE_V8_COVERAGE` READS as an opt-out and IS NOT ONE -- it deletes the key from the
// object handed to `env`, but node re-injects it before the child ever sees that object. The two
// forms that actually work are naming the key with a value node will not override:
// `env.NODE_V8_COVERAGE = undefined` or `env.NODE_V8_COVERAGE = ""` (equivalently, the same two
// values written inline as an object-literal property). `src/lib/review.ts`'s proof executor
// already uses `NODE_V8_COVERAGE: undefined` and documents the force-injection in its own comment
// -- this check accepts both forms, and flags only `delete`, never a preference between them.
//
// TWO THINGS THIS SCANS FOR, DIFFERENT IN KIND:
//
//   (a) A DEFINITE DEFECT, decidable from source text alone: `delete <expr>.NODE_V8_COVERAGE`
//       (or the bracket form) ANYWHERE in a tracked test/**/*.ts file. This form is always wrong
//       -- there is no context in which it does what its own name suggests -- so every occurrence
//       is reported, unconditionally.
//   (b) A STRONG SUSPICION, not a proof: a local env object (`const childEnv = { ...process.env
//       ... }`-shaped -- i.e. NOT `process.env` itself, mutating the real process environment is
//       a different, rarer hazard this check does not adjudicate) that deletes `NODE_TEST_CONTEXT`
//       -- this repo's own marker for "I am spawning a nested `node --test` runner" -- without
//       ALSO blanking `NODE_V8_COVERAGE` (by either accepted form, anywhere against that same
//       identifier) in the same file. Stripping the nested-runner marker and blanking the
//       coverage session are two halves of the same hygiene; ten test files do the first today
//       and this is the check that says the second went missing.
//
// WHAT THIS SCAN CANNOT SEE -- STATED HERE, AND ECHOED IN THE CLI'S OWN OUTPUT ON EVERY RUN
// (clean or not), so a clean run is never mistaken for a clearance:
//
//   - a spawn with NO `env` option at all -- the COMMONEST shape, which inherits the parent's
//     environment (including `NODE_V8_COVERAGE`) by default. A text scan cannot tell a spawned
//     Node child (which collects coverage) from a `git`/`gh`/shell child (which does not) among
//     the 200+ test files that call `spawnSync`/`execFileSync`, so this shape is UNREACHABLE by
//     this scan and is never reported, positive or negative.
//   - an env object assembled at runtime, or spread out of a shared helper, where no
//     `NODE_TEST_CONTEXT`/`NODE_V8_COVERAGE` literal appears at the call site itself.
//   - a spawn routed through a wrapper, where the env is built one layer away from the call.
//   - anything outside `test/` (this check's own subject, matching this repo's `*-check.mjs`
//     family, is the same tracked-`test/**/*.ts` corpus scripts/tracked-source-write-check.mjs
//     scans -- see that file for why `git ls-files`, never a raw directory walk).
//
// So this scan PROVES PRESENCE of a defect, and (b) only ever a suspicion; it never proves
// ABSENCE of one. It does not edit any caller -- naming the rule and making a violation visible
// is the whole deliverable; fixing the sites this run flags is separate, one-concern work.
//
// Usage:
//   node scripts/coverage-session-blanking-check.mjs
// Exits 1 and names every file:line/finding it found; exits 0 ("clean") otherwise -- and prints
// the blind-spot statement above either way.
```

WHY THIS MATTERS. MEASURED on `src/lib/ledger.ts`: the lcov merge from an enrolled nested Node
child made a genuinely-covered range read uncovered because the merged block's evidence no longer
agreed with itself — `diff-coverage` named it a new gap. `src/lib/review.ts`'s proof executor
already uses the accepted `NODE_V8_COVERAGE: undefined` form and documents the force-injection in
its own comment, so this check's two accepted forms match that precedent rather than inventing a
third. As of the file's own writing, ten test files stripped `NODE_TEST_CONTEXT` without also
blanking `NODE_V8_COVERAGE` — the population rule (b) exists to keep visible; the live count moves
as callers are fixed, so it is not restated in the code, only here.

## blankNonCode (the empty-string carve-out)

Removed from the block above `if (end !== i + 1) {` inside `blankNonCode`, originally 6 lines:

```
      // An EMPTY string literal (`""`/`''`, opening quote immediately followed by its own
      // closing quote) is left VISIBLE rather than blanked -- unlike every other string, its two
      // characters ARE the whole meaningful token this scan needs to see: the accepted
      // `NODE_V8_COVERAGE = ""` blanking form (rationale §0) is indistinguishable from any other
      // string content once blanked, and this is the one shape where "a string literal" and "a
      // piece of code this check must read" are the same three characters.
```

The reasoning survives in the compacted 3-line form in the code; nothing measured or historical
was in this block beyond the invariant itself, so no separate archive entry is needed for its
content beyond this verbatim copy.

## The hand-rolled comment/string-stripping banner

Removed from above `skipString`, originally 5 lines:

```
// ── tiny hand-rolled comment/string stripping -- same discipline, same reason, as
// scripts/tracked-source-write-check.mjs's own `blankNonCode`: locate real CODE tokens only, so a
// call name or variable that merely appears inside a string or a comment (this file's own module
// doc above quotes `delete env.NODE_V8_COVERAGE` in prose; test/ledger-rotation.test.ts quotes the
// identical shape in a comment recording the same lesson) is never mistaken for a real one. ─────
```

The illustrative examples (this file's own module doc, and test/ledger-rotation.test.ts's comment)
both quote the exact string `delete env.NODE_V8_COVERAGE` in prose, which is precisely the shape
`blankNonCode` exists to blank out before any regex runs over the source — the worked example of
the invariant the compacted comment now states directly.

## process.env exemption (inside scanSource)

Removed from above `if (ident === "process") continue;`, originally 4 lines:

```
    // `delete process.env.NODE_TEST_CONTEXT` mutates the REAL process environment, not a "child
    // env object" -- test/check-proof-executor-parity.test.ts does exactly this (and restores it
    // in a `finally`) around a call whose spawn inherits `process.env` BY DESIGN, never a copy.
    // That is a different hazard in a different shape; this rule does not adjudicate it.
```

The citation to `test/check-proof-executor-parity.test.ts` survives in the compacted 2-line form
in the code, since it names a concrete exemplar a later reader would otherwise have to rediscover.

## listTrackedTestFiles

Removed from lines 234-237:

```
/** Every file `git ls-files` reports as TRACKED under `test/` (resolved against `repoRoot`),
 *  filtered to `.ts` -- same predicate, same reason, as tracked-source-write-check.mjs's own
 *  `listTrackedTestFiles`: the guard's subject is a TRACKED file, so `git ls-files` is both the
 *  more faithful read and the one that keeps untracked scratch out of scope for free. */
```

## blankedIdentifiers

Removed from lines 174-180:

```
/**
 * Every identifier this file blanks `NODE_V8_COVERAGE` for, by either accepted form:
 *   - an assignment against the identifier: `ident.NODE_V8_COVERAGE = undefined` / `= ""` / `= ''`
 *   - an inline object-literal property inside that identifier's OWN `const`/`let` declaration:
 *     `const ident = { ...process.env, NODE_V8_COVERAGE: undefined }`
 * Both forms are accepted with no preference between them (rationale §0) -- only `delete` is not.
 */
```

## scanSource

Removed from lines 200-206:

```
/**
 * Scan one already-read source file's TEXT for both findings. Pure -- no fs access -- so tests
 * can feed synthetic fixtures directly. `relPath` is used only to label findings.
 * Returns `{ defects, suspects }`:
 *   - `defects`: `{ file, line, expr }[]` -- rule (a), a `delete <expr>.NODE_V8_COVERAGE`.
 *   - `suspects`: `{ file, line, ident }[]` -- rule (b), an unblanked `NODE_TEST_CONTEXT` strip.
 */
```

## main

Removed from lines 283-288:

```
/**
 * The CLI's whole behaviour, injectable exactly like scripts/tracked-source-write-check.mjs's own
 * `main` (same shape, same reason): every collaborator carries a real default, so the actual CLI
 * entry point stays a bare `main()` call while a test can drive both the clean and the
 * finding-found path in-process.
 */
```

## Other compacted doc comments

`skipString`, `blankNonCode` (its own top-level doc), `lineOf`, `matchBraceClose`, `scanRepo` and
`BLIND_SPOTS` each carried a short doc comment that was shortened for length alone — no measured
fact, incident or design argument beyond the invariant already restated in the compacted form, so
none carries a separate archive entry or inline pointer.
