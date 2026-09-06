# diff-class.mjs forensics

The measured forensics, incident narratives and design arguments removed from
`scripts/diff-class.mjs` when its comments were compacted to the plain-language standard. Every
block below is the removed text verbatim; headings name the symbol or section it explained. The
code keeps a one-line `// Why:` pointer where the history mattered. Base revision: `origin/main` at
1aec2871bc4d380d1f6bfbd558d32226287729ab; the line numbers below are that revision's.

## Module header

### Base lines 2-55 — scripts/diff-class.mjs, the three-class rationale and three CLI mode usage blocks

```
// scripts/diff-class.mjs — W1-T2428: the fast-lane classifier.
//
// A plan-only or docs-only diff cannot fail `ci`'s Typecheck/Test or `coverage-ratchet`'s
// coverage collection — no `src/**` or `test/**` file moved. Measured 2026-08-27: plan-only is
// 36 of 60 recent merges (60%) and 58.7% of CI spend, at a mean 1,873s each (`ci` 685s +
// `coverage-ratchet` 1,187s). This script answers ONE question — "what class is this diff?" —
// so a CI job can skip the suites that cannot fail on it, WITHOUT ever skipping the job itself
// (see plan/tasks.d/W1-T2428-*.yaml's Q4: a job that stops REGISTERING deadlocks merge forever;
// the fix is always a step-level bash guard inside a job that still runs).
//
// THE CLASS COMES FROM THE REAL PREDICATE, NEVER A FOURTH REIMPLEMENTATION. `isInPlanScope`
// (src/lib/plan-architect.ts) is already canonical — it is what the sweep computes `planOnly`
// from for the reviewer (W1-T205), and its own doc says it is the WIDEST correct definition of
// plan scope (it includes `docs/ORIENTATION.md`, regenerated FROM `MASTER-PLAN.md` by `rmd
// retro`). This script imports that function directly; a bash reimplementation of scope rules
// would be a fourth predicate, drifting from the three (`isInPlanScope`, `nonPlanFilesInDiff`,
// `TASKS_SHARD_PATH_RE`) that already disagree with each other today (see the task's rationale,
// Q1) — one more disagreeing definition is not the fix.
//
// THREE CLASSES:
//   PLAN_ONLY — every changed file is in plan scope (`isInPlanScope`).
//   DOCS_ONLY — every changed file is EITHER in plan scope OR under `docs/`.
//   SOURCE    — anything else, including an empty or undeterminable file list. A diff carrying
//               ONE path outside plan-or-docs scope is SOURCE, whatever else it also carries —
//               there is no "mostly plan" class.
//
// FAIL CLOSED. `classify()` never throws: an unreadable file list, an internal error, or an
// empty file list all resolve to SOURCE (never PLAN_ONLY — an empty list read as "nothing to
// check" would be catastrophically wrong on a truncated `git diff`/paginated file list). The CLI
// (`main`) mirrors this at the process boundary: it always exits 0 and always prints exactly one
// recognized class token on stdout, so a caller's bash guard never has to special-case a crash.
//
// USAGE (CI, via `node --import tsx scripts/diff-class.mjs`, the same tsx binding
// scripts/acceptance-author-gate.mjs uses for a `.mjs` file importing a `.ts` module):
//   node --import tsx scripts/diff-class.mjs --changed-files <path>   (path to a newline-
//     separated file list, e.g. `git diff --name-only <base>...HEAD > changed-files.txt`; `-`
//     reads the list from stdin)
//   node --import tsx scripts/diff-class.mjs --list-plan-reading-suites   (prints, one per line,
//     every test/**/*.test.ts file the PLAN-ONLY/DOCS-ONLY fast lane must still run — see
//     `planReadingSuiteFiles` below)
//   node --import tsx scripts/diff-class.mjs --list-census-suites --changed-files <path>
//     (W1-T2680: prints every suite that WALKS a population the changed files belong to, or READS
//     one of them as text — the suites a `git grep -l <symbol>` caller sweep cannot reach BY
//     CONSTRUCTION, because a census names none of the symbols any particular diff touches)
//
// OUTPUT (classify mode): stdout carries EXACTLY one line — the class token (`PLAN_ONLY`,
// `DOCS_ONLY`, or `SOURCE`). The human-readable reason goes to stderr, so a bash guard can do
// `CLASS="$(node --import tsx scripts/diff-class.mjs --changed-files f.txt)"` and get a clean
// value with nothing else to strip. Exit code is always 0 in this mode.
//
// OUTPUT (--list-plan-reading-suites mode): stdout carries one repo-relative test file path per
// line, sorted. On any enumeration error, prints NOTHING and exits 1 — a caller reading zero
// lines from a nonzero exit must fail closed (run the FULL suite), never trust an empty list as
// "no suites matter".
```

## planReadingSuiteFiles

### Base lines 171-182 — the 94-file plan-reading set doc

```
/**
 * THE 94-FILE PLAN-READING SET, ENUMERATED FROM THE TREE — never a hand-copied list (acceptance
 * criterion 5). Walks `test/**\/*.test.ts` and returns every file (repo-relative, POSIX
 * separators, sorted) that BOTH reads a repo-root file (`hasRepoRootConstant`) AND names a plan
 * or docs path (`namesPlanOrDocsPath`) — the intersection the task's rationale (Q1) measures at
 * 94 files, with two controls proven in test/fast-lane-classifier.test.ts: `plan-proposals.test.ts`
 * (reads `MASTER-PLAN.md` off `REPO_ROOT`) is IN the intersection; `sweep.test.ts` (a pure-source
 * suite with no repo-root constant at all) is NOT.
 *
 * Directory-only, not recursive into `test/helpers`/`test/setup` — those are shared fixtures, not
 * suites `npm test`'s own `test/**\/*.test.ts` glob would select either way.
 */
```

### Base lines 190-209 — why the `hasRepoRootConstant` conjunct was dropped, inside the function body

```
    // W1-T2428 (the `ci` half): NAMING A PLAN/DOCS PATH IS THE WHOLE PREDICATE. The
    // `hasRepoRootConstant(content) &&` conjunct that stood here was MEASURED under-inclusive and
    // is removed rather than widened, because no source-shape spelling separates the set:
    //
    //   With a malformed plan staged (a shard duplicating an existing id) and the 106 suites this
    //   conjunct EXCLUDED run to completion — 2,425 tests, every chunk carrying its own `# tests`
    //   summary, against a baseline of 0 failures on a WELL-FORMED plan — SIX suite files failed:
    //   credited-proof-visibility-seam-defaults, learnings-injection-w1t6, merged-claim-audit,
    //   mounts-wiring, retro, task-linter. Every one of them can fail on a plan-only diff and
    //   every one was being skipped.
    //
    //   WIDENING THE CONJUNCT DOES NOT FIX IT. Four of the six reach the repo root through
    //   `new URL(..., import.meta.url)` rather than a `REPO_ROOT` constant, so adding that idiom
    //   recovers four — but `credited-proof-visibility-seam-defaults` carries NO root-reaching
    //   idiom at all and still fails, and `sweep.test.ts` carries the SAME `import.meta.url` idiom
    //   while genuinely not caring about the plan. The spelling and the property are independent.
    //
    // DROPPING THE CONJUNCT CAPTURES 6 OF 6 and costs 158 suites of 802 — the lane still skips
    // 80%. That trade is the direction this function's own doc already names: over-including runs
    // one extra harmless suite, under-including silently drops one that CAN fail, "which is the
    // failure mode this whole classifier exists to avoid".
```

## enumeratesPopulation (the removed glob clause)

### Base lines 237-253 — orphaned doc explaining the verb, including the removed bare-glob clause

```
/**
 * Whether `content` ENUMERATES A POPULATION of repo files — the shape that makes a suite
 * unreachable from any symbol a diff changes, because it names none of them.
 *
 * `execFileSync("git", ...)` ALONE IS NOT THIS, and that distinction is the whole difficulty.
 * test/serve.test.ts shells git six times — `init`, `config`, `add`, `commit` — against a
 * per-test tmpdir fixture, and it is an ordinary suite this verb must NOT list. What separates a
 * census is enumeration OF THE TREE: `ls-files`, a directory read, or a real glob call.
 *
 * A BARE `src/**`-SHAPED STRING IS NOT ENUMERATION EITHER, and a clause matching one was tried and
 * REMOVED: MEASURED, it fired on `a-printed-remedy-is-never-applied.test.ts` for the string
 * a `node --test` command string carrying a recursive test glob — a COMMAND that suite asserts
 * about, not a population it walks. (Written as prose deliberately: a star-star-slash inside a
 * block comment CLOSES it, which is how this very comment first broke the file.) Every
 * genuine walker in this repo reaches the tree through one of the three calls above, so the glob
 * clause bought nothing and cost a false positive on every `src/` change.
 */
```

## withoutRelativePathLiterals

### Base lines 254-271 — the measured 128/82/54 hit-count table for arm (a)'s two subtractions

```
/**
 * `content` reduced to the text where NAMING AN AREA MEANS SOMETHING: relative path literals
 * (`"../src/lib/x.js"`) and comments both removed.
 *
 * THIS IS WHAT KEEPS ARM (a) FROM ANSWERING "THE WHOLE TEST DIRECTORY", and both halves were
 * MEASURED necessary against the real tree of 1,084 suites, for a `src/lib/` change:
 *
 *   raw `content.includes("src/")`            128 of 1,084 — every file imports from `../src/...`
 *   minus relative path literals               82
 *   minus comments as well                     54
 *
 * A census names its population as a BARE path in CODE — `join(REPO_ROOT, "src")`, `"src/*.ts"`
 * passed to `git ls-files`. The `../` spelling is an import, and a `src/lib/x.ts` inside a doc
 * comment is prose: `a-printed-remedy-is-never-applied.test.ts` and
 * `a-count-assertion-names-its-members.test.ts` were both listed for every `src/` change on the
 * strength of a comment alone, which is the "hands you the whole directory" failure this task's
 * own falsifier names.
 */
```

## sourceTextPathsRead

### Base lines 287-303 — the doc's incident and the in-body note on fixture-string false positives

```
/**
 * Every repo-relative source path this test file READS AS TEXT — `readFileSync` over a path
 * spelled inside the file. This is the SECOND census shape and it is not optional: acceptance
 * criterion 2 names test/mounts-wiring.test.ts, which enumerates NOTHING. It reads
 * `../src/run-task.ts` as a string and asserts on its SHAPE, so a diff that changes that file's
 * shape breaks it while naming no symbol the suite mentions. Measured on this repo the same day
 * this verb was built: two suites of exactly this shape (console-stopped-counts, decision-summary)
 * went red in CI on a diff whose prescribed caller sweep had run green over 45 files.
 */
export function sourceTextPathsRead(content) {
  const paths = new Set();
  // ONLY paths spelled INSIDE a readFileSync call. Collecting every path-shaped literal in the
  // file and merely REQUIRING a readFileSync somewhere was tried and MEASURED wrong: it listed
  // test/sweep.test.ts — the negative control this task's criterion 3 names — because that suite
  // carries `"src/config.ts"` and `"src/lib/widget.ts"` as FIXTURE DATA, fake paths fed to a
  // conflict-resolution helper, and never reads either. A path in a fixture is an argument to the
  // code under test; a path in `readFileSync` is a dependency on the tree. Only the second is this.
```

## censusSuiteFiles

### Base lines 315-333 — the asymmetry argument and the empty-set behavior note

```
/**
 * THE ANSWER TO "WHICH SUITES DOES MY DIFF JOIN, THAT NAME NONE OF ITS SYMBOLS" — enumerated from
 * the tree at run time, never from a registry. A census added tomorrow is found tomorrow; a
 * hardcoded list rots the moment someone adds one, which is the failure mode W1-T2521 already
 * names for census gates.
 *
 * A suite is listed when it is relevant to the CHANGED AREAS by either arm:
 *   (a) it ENUMERATES a population and names an area the diff touched, or
 *   (b) it READS AS TEXT a specific file the diff changed.
 *
 * Arm (b) is exact (a path match), so it cannot over-include. Arm (a) is deliberately the looser
 * one, and it is bounded by the area check rather than by cleverness: over-listing runs one extra
 * suite, under-listing is the silent miss this verb exists to end — the same asymmetry
 * `planReadingSuiteFiles` above already resolved in the same direction, for the same reason.
 *
 * An EMPTY changed-file set yields an EMPTY list (criterion 5): with no areas, nothing is relevant.
 * That is NOT a fail-closed case like `classify()`'s — this verb ADDS suites to a run, so an empty
 * answer costs nothing, while "every suite" would be the whole directory and no answer at all.
 */
```

## main's plan-reading-root flag

### Base lines 371-377 — why the test-only enumeration-root override exists

```
      // TEST-ONLY: overrides the enumeration root passed to planReadingSuiteFiles(). ci.yml never
      // passes this flag (it always enumerates the real repo tree); it exists so
      // test/fast-lane-classifier.test.ts can drive main()'s own --list-plan-reading-suites catch
      // block (below) as a REAL subprocess, by pointing it at a directory that does not exist, and
      // so genuinely throws — without chmod'ing a file under the real test/ dir, which
      // test/host-capability-fixtures.test.ts ratchets against a declared allowlist this task's
      // file scope (W1-T1227) does not include.
```
