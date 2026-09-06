# citation-anchor-census.mjs comment forensics

The measured incidents, design arguments and sourcing detail that were removed from
`scripts/citation-anchor-census.mjs` when its comments were compacted to the plain-language
standard (docs/comment-standard.md). Nothing was cut: each section below is the file's own prose,
verbatim, under a heading naming the symbol it explained. The file itself keeps a one-line
`// Why:` pointer to this page.

Line numbers below are positions in `scripts/citation-anchor-census.mjs` at the merge base of the
compaction PR (`origin/main` at 31e6d173152f3e6e8c8e4d4e80b83f41439c0a90).

## The file header (module purpose, W1-T2649)

Removed from lines 2-61.

```
// CITATION-ANCHOR CENSUS (W1-T2649, origin: followup#W1-T2481-1788113218856).
//
// ONE REPAIRED CITATION ANSWERS NOTHING ABOUT THE REST. W1-T2648 re-anchors ONE citation --
// W1-T2481's rationale names PR #3305 with no sha, no merge state and no date, so a later reader
// can neither re-derive nor falsify the "13 failing" figure it motivates. That single repair
// cannot say whether #3305 was a lapse or the visible edge of a habit. This script counts, so
// the plan does not have to guess: it walks the plan's task records (the monolith,
// MASTER-PLAN.md, and every plan/tasks.d/ shard), finds every `#NNNN` PR-number citation in
// rationale/design/note prose, and classifies each ANCHORED or ANCHORLESS.
//
// ANCHORED means the citation is accompanied, within a bounded prose window, by something
// IMMUTABLE: a git sha of >=7 hex characters, or an explicit merge-state word paired with a
// date. Both forms live in the ANCHOR_SHAPES table below, one row per shape -- mirroring the
// DATA-table discipline SUBSYSTEM_LEXICON / DATA_ARTIFACT_CLASSES / PROOF_PAYLOAD_SHAPES /
// ADVISORY_ROUTING_LEXICON already use in src/lib/task-linter.ts (see that file's module
// comment on ADVISORY_ROUTING_LEXICON for the precedent this design cites by name: a heuristic
// over prose earns its table only by publishing a MEASURED precision, never by assertion).
```

### Precision declared before the count is trusted

```
// PRECISION IS DECLARED BEFORE THE COUNT IS TRUSTED. FIXTURES below is a small, hand-labelled
// set lifted VERBATIM from this checkout's own live corpus, in both directions: two known-
// anchored quotes (plan/tasks.d/W1-T2648-*.yaml's rationale, itself illustrating the habit) and
// one known-anchorless quote -- #3305's ORIGINAL citation in plan/tasks.d/W1-T2481-*.yaml's
// rationale, the exact case this whole task exists to measure. measurePrecision() runs every
// fixture through the SAME classify path the census uses and the CLI prints the result ABOVE
// the count, every run -- a count printed without that line would be a feeling, not a
// measurement.
```

### ANCHOR_WINDOW's derivation

```
// THE WINDOW IS BOUNDED AND THE BOUND IS MEASURED, NOT GUESSED. ANCHOR_WINDOW=60 characters on
// each side of a `#NNNN` match was chosen against this checkout: the two known-anchored fixture
// distances are 4 and 46 characters, comfortably inside; MASTER-PLAN.md's own followup-log entry
// for #3305 carries a "RATIFIED 2026-08-31" trailer 296 characters away (would falsely anchor a
// citation whose OWN TEXT says "no sha, no merge state and no date" if the window reached that
// far) and an unrelated 13-digit followup-id timestamp 139 characters away (would falsely read
// as a sha under a naive hex scan -- see the ANCHOR_SHAPES sha row's own comment on why it
// requires a mixed digit+letter token, not a bare hex-alphabet run).
```

### The named residual (merge-state-plus-date is proximity, not semantics)

```
// A NAMED RESIDUAL, NOT A CLAIMED ZERO. The merge-state-plus-date shape is proximity-based, not
// semantic: a passage citing several PR numbers within one clause can attach a neighbour's
// merge word to the wrong number. Measured example: plan/tasks.d/W1-T1103-*.yaml reads
// "`#2032` IS STILL OPEN. `#2438` and `#2360` were closed by hand on 2026-08-23; `#2032` was
// not" -- the FIRST `#2032` sits close enough to "closed ... 2026-08-23" (which names #2438 and
// #2360, not #2032) to read ANCHORED despite the sentence explicitly saying #2032 is NOT closed.
// This is the same class of imprecision ADVISORY_ROUTING_LEXICON accepted and published (0.9%
// residual against a naive scan's 63%) rather than chasing to zero -- a census is a starting
// point an operator reviews, not a certified-perfect classification, and IT REPORTS, IT NEVER
// GATES (below), so a residual misclassification costs a reader's attention, never a CI run.
```

### Reports, never gates

```
// IT REPORTS AND IT DOES NOT GATE. `main()` exits 0 whenever it completes a census, however many
// citations are anchorless -- that restraint is a criterion this task's design states plainly,
// not a footnote: no lint check is added here, no check name is registered anywhere, and no
// existing check's behaviour changes. The ONLY non-zero exit is an operational failure to find
// the corpus at all (e.g. a bad --plan-tasks-dir), matching the "refuse rather than report
// success on an empty scan" discipline scripts/state-citation-check.mjs already keeps -- that
// is a failure to SCAN, never a verdict on what was found.
```

## ANCHOR_SHAPES's falsifier argument

Removed from lines 74-77 (the `{@link isAnchored}` JSDoc block).

```
 * DATA table -- one row per IMMUTABLE anchor SHAPE. A new shape is a new row; {@link isAnchored}
 * never changes (the falsifier proof for this task's DATA-table acceptance criterion is exactly
 * that: pass a caller-supplied table carrying one extra row and a previously-anchorless window
 * reclassifies, with zero edits to isAnchored itself).
```

The compacted comment keeps the falsifier as a direct pointer to the test
(`test/citation-anchor-census.test.ts`) that exercises exactly this: adding one `ANCHOR_SHAPES` row
reclassifies a seeded citation with zero edits to `isAnchored`.

## loadCorpus's field-scoping precedent

Removed from lines 142-147.

```
 * The corpus this census reads: the monolith (MASTER-PLAN.md, its whole body -- it has no
 * rationale:/design:/note: field structure of its own, it IS narrative prose end to end) plus
 * every plan/tasks.d/ shard's rationale, design and note fields (the fields this task's design
 * names, and the only free-text fields a filer actually writes into -- the same field scoping
 * ADVISORY_ROUTING_LEXICON's own module comment documents for {@link Task}, since `design:` is
 * dropped before parsing there and is read directly here instead, off the raw YAML).
```

## FIXTURES's sourcing detail

Removed from lines 190-197.

```
 * Hand-labelled fixtures, lifted VERBATIM from this checkout's live corpus, in BOTH directions.
 * A classifier that cannot separate these has not earned the right to report a total (this
 * task's design, stated plainly). Sources, so a reader can re-verify by hand without running
 * anything:
 *   - both ANCHORED quotes: plan/tasks.d/W1-T2648-*.yaml's rationale (itself illustrating the
 *     habit the plan already keeps).
 *   - the ANCHORLESS quote: plan/tasks.d/W1-T2481-*.yaml's rationale -- #3305's ORIGINAL
 *     citation, the exact case this task's title asks whether is an outlier or a class.
```
