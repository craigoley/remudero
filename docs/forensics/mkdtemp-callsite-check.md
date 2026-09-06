# mkdtemp-callsite-check.mjs comment forensics

The measured incidents, design arguments and citations that were removed from
`scripts/mkdtemp-callsite-check.mjs` when its comments were compacted to the plain-language
standard (docs/comment-standard.md). Nothing was cut: each section below is the file's own prose,
verbatim, under a heading naming the symbol it explained. The file itself keeps a one-line
`// Why:` pointer where the history mattered.

Line numbers below are positions in `scripts/mkdtemp-callsite-check.mjs` at the merge base of the
compaction PR (`origin/main` at 31e6d173152f3e6e8c8e4d4e80b83f41439c0a90).

## The file header

Removed from lines 2-42.

```
// scripts/mkdtemp-callsite-check.mjs
//
// BARE-PREFIX MKDTEMP CALLSITE CHECK (W1-T2773).
//
// THE PROPERTY: a temp dir the boot sweep (`src/lib/tmp.ts`'s `sweepStaleTempDirs`) can reap.
// The sweep reaps only names beginning with `rmd-` (RMD_TMP_PREFIX), so a `mkdtempSync(join(
// tmpdir(), "sweep-reentry-"))` dir is invisible to it. Every such callsite is a small,
// permanent leak — 4 dirs per run of `test/a-bound-that-stops-waiting-does-not-stop-the-work
// .test.ts` in the measurement that motivated this rule, across ~1020 sites on 2026-09-03.
//
// WHY A STATIC AST CHECK, NOT A RUNTIME WRAP. The earlier fix wrapped `fs.mkdtempSync` in
// `src/lib/tmp.ts` at module load. `tmp.ts` is a LEAF (only `src/run-task.ts` and
// `src/lib/worker-provider.ts` import it), so a bare `node --test <file>` never loads it and
// the wrap never fires — the falsifier proved that. This check reads the CALLSITE, not the
// import graph, so a callsite added tomorrow is refused whether or not any wrapper is loaded.
//
// WHAT THIS SCANS: every tracked `.ts` / `.mjs` under `src/`, `scripts/`, `test/` (via
// `git ls-files`, never a raw directory walk — same discipline as
// `scripts/tracked-source-write-check.mjs`, W1-T2291). For each call to `mkdtempSync`, the
// first argument is resolved as far as a static, best-effort expression walk can take it.
// Accepted:
//   - `join(tmpdir(), "rmd-*")`                  — a literal beginning with `rmd-`
//   - `join(tmpdir(), \`${RMD_TMP_PREFIX}foo-\`)` — the sanctioned constant
//   - the callsite's `<file><TAB><observed-prefix>` is on `hooks/mkdtemp-allowlist.txt`
// Refused: anything else, INCLUDING a variable prefix — the rule reads the AST, not the
// runtime value, so a variable prefix cannot be statically proven reapable and fails closed.
//
// WHAT THIS CANNOT CATCH — stated so no reader mistakes a clean run for proof of absence: a
// prefix assembled at RUNTIME (a function return, a computed string), a callsite reached
// through an injected seam, or a `mkdtempSync` called by a child process the check does not
// see. This is a static check, not a runtime one; it raises the cost of the accident, it
// does not prove the tree has no leak.
//
// EXIT CODES:
//   0 = clean (no refused callsite)
//   1 = one or more refused callsites; each printed with the message shape the operator
//       directive names — see PRINT below.
//
// Injectable for tests: pass `{ scan: (root) => scan(root), out: (s) => …, err: (s) => … }`.
// The exported `checkMkdtempCallsites(rootDir, opts)` returns a summary object callers can
// assert against without spawning a process.
```

WHY THIS MATTERS. MEASURED: the leak this rule catches cost 4 directories per run of
`test/a-bound-that-stops-waiting-does-not-stop-the-work.test.ts` alone, across roughly 1020
bare-prefix sites counted on 2026-09-03 — the population `hooks/mkdtemp-allowlist.txt` exists to
carry while W1-T2775's migration retires them one tranche at a time. The static-AST design choice
was not the first fix: an earlier attempt wrapped `fs.mkdtempSync` inside `src/lib/tmp.ts` at
module load, but `tmp.ts` is a leaf module (only `src/run-task.ts` and
`src/lib/worker-provider.ts` import it), so a bare `node --test <file>` run — the shape most of
this repo's suites use — never loads it and the wrap never fires. That gap was proven by a
falsifier, not inferred. Reading the callsite's own AST instead of relying on any wrapper being
loaded closes it: a callsite added tomorrow is refused whether or not the import graph happens to
reach `tmp.ts`. The "WHAT THIS SCANS" paragraph also cites W1-T2291 — the task that established
`git ls-files`, never a raw directory walk, as this repo's scanning discipline, matching
`scripts/tracked-source-write-check.mjs`.

## RMD_TMP_PREFIX

Removed from lines 49-51:

```
/** The one sanctioned prefix constant. Kept as a literal here rather than imported from
 *  `src/lib/tmp.ts` so the check has no production-code dependency at load time (same
 *  discipline as `test/setup/reapable-prefix.ts`'s own `RMD_TMP_PREFIX` mirror). */
```

Shortened for length; the precedent it cites (`test/setup/reapable-prefix.ts` keeps its own mirror
of the constant for the same reason) carries no separate measurement or incident beyond the
invariant kept in the compacted one-line form.

## SANCTIONED_PREFIX_IDENTS

Removed from lines 54-56:

```
/** The one sanctioned constant NAME callers may spell inside a template literal. Kept in a
 *  Set for O(1) lookup and to mark it as the ONLY admitted identifier — a future task adding
 *  a second sanctioned prefix adds both the constant and its name here in one commit. */
```

The forward-looking instruction (a second sanctioned prefix needs both the constant and its name
added here, in one commit) survives in the compacted one-line form.

## classifyMkdtempFirstArg (inline comments)

Removed from above the `join(` match (line 166), the two branch comments at lines 177 and 180, the
three-line comment at lines 183-185, and the two comments at lines 188 and 191:

```
  // Must be `join(tmpdir(), <prefix>)`
```
```
  // sanctioned literal: "rmd-…" or 'rmd-…'
```
```
  // sanctioned template: `${RMD_TMP_PREFIX}…`
```
```
  // sanctioned template whose LITERAL head begins with `rmd-` (before any `${...}`) — the
  // reapability property is the same: the resulting dir name starts with `rmd-` at runtime
  // regardless of what the interpolation is.
```
```
  // any other literal is a bare prefix
```
```
  // template literal that doesn't start with a sanctioned constant
```

The first, second, third, fifth and sixth restated what the function's own JSDoc already listed
per return value and carried no separate fact; they are cut, not compacted, since the invariant
survives in the JSDoc summary. The fourth (the literal-head interpolation invariant) is not
redundant with the JSDoc — it survives in the compacted one-line form in the code.

## extractMkdtempPrefix

Removed from lines 196-200:

```
/**
 * Resolve the prefix text that identifies one allowlist exemption. This intentionally consumes
 * the same full first-argument expression as {@link classifyMkdtempFirstArg}: identity comes from
 * the observed callsite, never from a stale allowlist row or its former line number.
 */
```

The invariant (identity comes from the observed callsite, never a stale allowlist row) survives in
the compacted form; the extra clause "or its former line number" is dropped as redundant with
"stale allowlist row".

## stringAndCommentRanges

Removed from lines 227-235:

```
/**
 * The set of [start,end) offsets in `text` that are inside a string, template literal, or
 * `//`/`/* *​/` comment. A `mkdtempSync` occurrence inside one of these is NOT a real callsite
 * — it is code text quoted for humans (a doc-comment example, an error message, a test
 * fixture-string). Without this the scanner false-positives on every place the codebase
 * DISCUSSES bare-prefix callsites, including this rule's own test file and its own
 * INSTRUMENT_SURFACE excuse. The primitives (`skipString`) already know how to walk one
 * string; here we walk them ALL, once per file, and return the exclusion ranges.
 */
```

The invariant (a `mkdtempSync` occurrence inside a string/comment is not a real callsite) survives
in the compacted form. The specific examples this block named — this rule's own test file, and
`src/lib/review.ts`'s `INSTRUMENT_SURFACE` excuse string — are the concrete cases
`test/mkdtemp-callsite-check.test.ts`'s "occurrence inside a string literal or comment is NOT a
callsite" test exercises; the falsifier is that test, unchanged by this compaction.

## loadAllowlist

Removed from lines 287-290:

```
/** Load the on-disk allowlist as a Set of `<repo-relative-path><TAB><observed-prefix>` entries. Blank lines
 *  and lines starting with `#` are comments. Every entry must carry a reason (a `#` suffix on
 *  the same line, or an immediately preceding `#`-comment line — checked separately by test).
 *  A missing file is treated as empty (bootstrap case), never as an error. */
```

The invariant that every entry must carry a reason, and that this is checked by a separate test,
survives in the compacted form; the detail of exactly which two syntactic shapes count as a reason
(a trailing `#` suffix, or an immediately preceding `#`-comment line) is left to that test itself
to define, since restating it here duplicated the test's own assertions.

## formatRefusal

Removed from lines 342-344:

```
/** Format one refused row as the exact message the operator directive names — audience is a
 *  human who authored the bare form an hour ago and does not yet know this repo has a
 *  reapability discipline. Names the fix, not the rule. */
```

The design argument — the message's audience is a human who just wrote the offending line and does
not yet know this repo's reapability discipline exists, so it must name the fix rather than the
rule — is a usability rationale with no separate measurement; "names the fix, not the rule"
survives in the compacted one-line form.

## Other compacted doc comments

`ALLOWLIST_PATH`'s doc carried a measured fact — "ships with ~1015 pre-existing exemptions" — moved
above under "ALLOWLIST_PATH" for its own accounting:

```
/** The on-disk allowlist path, relative to the repo root. Load-bearing artifact for a rule
 *  that ships with ~1015 pre-existing exemptions; see W1-T2775 for the tranche migration
 *  that retires it. */
```

MEASURED: `hooks/mkdtemp-allowlist.txt` carried roughly 1015 pre-existing exemptions as of this
rule's introduction (W1-T2773); W1-T2775 is the tracked follow-up that migrates them out in
tranches rather than in one pass. The compacted form keeps the citation (W1-T2775) and drops the
specific count, which moves stale the moment the migration lands its first tranche and is recorded
here instead.

The two section-divider banners — `// ── the classification the rule turns on ──…` above
`classifyMkdtempFirstArg` and `// ── the scan ──…` above the `MKDTEMP_RE` declaration — were pure
visual dividers with no falsifier, trap, or citation of their own, and were dropped rather than
kept in shortened form. `scanFile`'s doc comment was shortened for length alone, with the same
invariant (occurrences inside strings/comments are excluded) restated inline.
