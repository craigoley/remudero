# mutation-ratchet.mjs forensics

The measured forensics, incident narratives and design arguments removed from
`scripts/mutation-ratchet.mjs` when its comments were compacted to the plain-language standard.
Every block below is the removed text verbatim, marker characters stripped and nothing else
changed. Headings name the symbol or section the text explained; the code keeps a one-line
`// Why:` pointer where the history mattered. Base revision: origin/main at
9391ac5647ed0c337eeedffd5ff7525a5d5022f9; the line numbers below are that revision's.

## Module header

### Base lines 2-110 — scripts/mutation-ratchet.mjs, the six CLI mode usage blocks and W1-T2524 note

```
// scripts/mutation-ratchet.mjs
//
// Mutation-testing ratchet gate (W1-T96, MASTER-PLAN §5 TIER 2, quality gate 2/4).
//
// Green tests that kill no mutants are theater -- a mutation score is the falsifier: it proves
// the test suite actually NOTICES when the source is deliberately broken. This script parses a
// Stryker JSON report (mutation-testing-report-schema, `reports/mutation/mutation.json` by
// default) and computes the overall mutation score (killed + timeout mutants, over all VALID
// mutants -- killed + timeout + survived + noCoverage; CompileError/RuntimeError/Ignored mutants
// are excluded from the denominator, matching Stryker's own scoring convention), then compares it
// against the recorded baseline (scripts/mutation-baseline.json by default). A run scoring BELOW
// the baseline is a test-suite-weakening change -- this script exits non-zero. A run AT or ABOVE
// baseline exits zero.
//
// Usage (ratchet mode -- compares a completed Stryker run against the baseline):
//   node scripts/mutation-ratchet.mjs [--report <path>] [--baseline <path>] [--stryker-config <path>]
//
// Defaults: --report reports/mutation/mutation.json, --baseline scripts/mutation-baseline.json,
// --stryker-config stryker.conf.json
//
// W1-T2524: when this mode BLOCKS, it also names the mutated files the report scored and (parsed
// from --stryker-config's own commandRunner.command) the test files the run actually executed --
// a test for a mutated file above that is NOT in that list is invisible to mutation testing while
// being perfectly visible to every other gate, and until this task the ONLY symptom was a
// collapsed score with no reason. A PASSING run's output, and the score/baseline comparison
// itself, are byte-for-byte unchanged -- this is purely additional BLOCKED-branch explanation.
//
// Usage (path-filter mode -- W1-T108, MASTER-PLAN §5C/§5A, decides whether the CI job needs to
// run Stryker at all for THIS diff):
//   node scripts/mutation-ratchet.mjs --changed-files <path> [--relevant-paths <json-file>]
//
// `--changed-files` points at a newline-delimited list of this PR's changed paths (e.g. the
// output of `git diff --name-only <base>...HEAD`). This mode NEVER reads --report/--baseline
// and NEVER shells out to Stryker -- it only decides and prints a reason, then exits 0
// regardless of the decision (a "skip" verdict is not a failure; it means this diff cannot
// possibly move src/lib/classify.ts's mutation score, so there is nothing to falsify). The
// caller (ci.yml's mutation-ratchet job) reads the `matched` $GITHUB_OUTPUT this mode writes and
// gates the actual `npx stryker run` step on it -- same always-registers-but-internally-scoped
// shape as `containment-probe` (see ci.yml). The paths list itself is DATA:
// scripts/mutation-relevant-paths.json, a plain JSON array read by loadRelevantPaths() -- not a
// literal embedded in this script. `--relevant-paths <json-file>` optionally points path-filter
// mode at a DIFFERENT json file instead of the production default, purely so a test can prove the
// filter is driven by that external data (swap in a seeded list, decision flips) without touching
// this script's logic OR the production data file; CI itself never passes it.
//
// Usage (scope-resolution introspection mode -- W1-T133, test-and-audit only, never used by CI):
//   node scripts/mutation-ratchet.mjs --resolve-scope --files <candidate-list-path> --config <json-file>
//
// Resolves ANY `{mutate: [...]}`-shaped JSON file's scope (stryker.conf.json, scripts/mutation-
// nightly-scope.json, or a test fixture) against a candidate list and prints the match -- lets a
// test prove the PR and nightly scopes are DISTINCT straight from the real production configs.
//
// Usage (nightly scope+sample mode -- W1-T133, .github/workflows/mutation-nightly.yml, decides
// WHICH files the nightly full-scope run mutates tonight):
//   node scripts/mutation-ratchet.mjs --nightly-scope --files <candidate-list-path>
//     --night-index <n> [--scope-config <json-file>]
//
// `--files` is a newline-delimited candidate file list (the workflow lists src/** itself; this
// script never walks the filesystem). The nightly mutate glob + per-run file cap live in
// scripts/mutation-nightly-scope.json (DATA, read by loadNightlyScopeConfig(); `--scope-config`
// overrides it for tests only). resolveMutateScope() matches candidates against that glob
// (hard-excluding test/** unconditionally) and sampleForNight() deterministically samples the
// match down to the cap for `--night-index` -- same inputs always produce the same sample, and
// consecutive night-index values rotate through the whole matched set. Writes the sample as a
// comma-joined `mutate` $GITHUB_OUTPUT for the workflow's `npx stryker run --mutate "..."` step.
// Always exits 0 -- this mode only decides scope, it never runs Stryker or compares a score.
//
// Usage (nightly ratchet mode -- W1-T133, run AFTER the nightly Stryker run completes):
//   node scripts/mutation-ratchet.mjs --nightly-ratchet [--report <path>] [--baseline <path>]
//     [--mutate-scope <comma-separated file list>]
//
// Compares the nightly Stryker report against the "nightly" section of scripts/mutation-
// baseline.json (a sibling of the PR-gate's own root-level fields -- untouched by this mode).
// Degrades LOUDLY on every failure path (missing/non-numeric nightly baseline section, unreadable
// or corrupt report, below-baseline score) -- never a silent pass.
//
// `--mutate-scope` is the RUN-VALIDITY guard's input: the files this run asked Stryker to mutate
// (the nightly passes its own --nightly-scope output straight through). Before comparing any
// score, this mode refuses a report in which a mutated file caught NOTHING -- see the
// "Run-validity guard" section comment further down for why that is a validity check and
// emphatically NOT a quality floor. This guard runs in --nightly-ratchet mode ONLY; the PR gate
// (ci.yml's mutation-ratchet job) invokes the default --report/--baseline mode, whose behaviour is
// unchanged.
//
// Usage (nightly PLAN mode -- W1-T133 runner fix, decides which files tonight can HONESTLY
// measure and emits one Stryker config per file):
//   node scripts/mutation-ratchet.mjs --nightly-plan --files <candidate-list-path>
//     --night-index <n> --plan-dir <dir> [--scope-config <json-file>]
//
// The nightly used to override `--mutate` while leaving stryker.conf.json's `commandRunner.command`
// alone, so it mutated files no test in that command imports. Plan mode fixes that by deriving,
// per mutated file, the test files that DIRECTLY import it, and writing a Stryker config whose
// command runs exactly those. Stryker gives no per-file command hook -- `commandRunner.command` is
// one command for a whole run -- so this necessarily means one `npx stryker run` per file, and one
// report per file for --report-dir below to merge.
//
// Usage (nightly ratchet mode -- W1-T133, run AFTER the nightly Stryker run(s) complete):
//   node scripts/mutation-ratchet.mjs --nightly-ratchet [--report <path> | --report-dir <dir>]
//     [--baseline <path>] [--mutate-scope <comma-separated file list>]
//
// `--report-dir` merges every per-file report plan mode produced. The merge is a DISJOINT UNION of
// the reports' `files` maps and never flattens to a single score, because the run-validity guard
// reads per-file outcome distributions and is the only thing currently keeping this job honest.
//
// The pure functions below (parseMutationTotals, tallyMutants, evaluateReportValidity,
// evaluateRatchet, evaluatePathFilter, resolveMutateScope, sampleForNight, deriveDirectImporters,
// planNightlyRun, buildNightlyStrykerConfig, mergeReports) are exported so the falsifier fixture
// test can exercise the CLI process directly (spawn + exit code) as well as the
// parsing/comparison/scope-resolution logic in isolation.
```

## DEFAULT_RELEVANT_PATHS_FILE

### Base lines 118-127 — DATA, not control flow, and not even embedded

```
// DATA, not control flow, and not even embedded in THIS script (W1-T108): the exhaustive set of
// paths that can move src/lib/classify.ts's mutation score -- the mutated file itself, its test,
// and this gate's own machinery (Stryker config, this script, the recorded baseline) -- lives in
// scripts/mutation-relevant-paths.json, a plain JSON array, not a JS literal in this file. That
// means "adding a path row" is purely a data-file edit: zero changes to this script, zero changes
// to evaluatePathFilter's logic, and (unlike an array literal embedded here) it is not even
// possible to conflate "editing the paths list" with "editing the script" -- they are different
// files. Kept in sync BY HAND with stryker.conf.json's `mutate` glob; widening that glob later
// means widening this JSON array too (the "one-line glob change" the ci.yml mutation-ratchet
// comment already calls out).
```

## MUTATION_RELEVANT_PATHS

### Base lines 136-139 — The production list, read once at import

```
// The production list, read once at import time from the JSON data file above. Exported (as
// before) so a test can prove the default itself is sourced from data; --relevant-paths lets a
// test point at an isolated seeded fixture COPY instead, without ever touching this file or
// scripts/mutation-relevant-paths.json.
```

## Nightly scope resolution

### Base lines 160-175 — W1-T133: nightly full-scope scope resolution

```
// ── W1-T133: nightly full-scope scope resolution + deterministic sampling ──────────────────
//
// The PR gate (ci.yml's mutation-ratchet job, unchanged by this task) reads its mutate scope
// straight from stryker.conf.json's own `mutate` array (today: exactly src/lib/classify.ts). The
// nightly workflow (.github/workflows/mutation-nightly.yml) needs a DIFFERENT, much wider scope
// (the whole src/** tree) without ever touching that PR-gate config -- so its scope lives in its
// own sibling data file, scripts/mutation-nightly-scope.json, read by loadNightlyScopeConfig()
// below. Both scopes are plain glob arrays (Stryker's own `!`-prefixed-entry-is-an-exclusion
// convention), resolved against a candidate file list by the SAME resolveMutateScope() function --
// this is what lets a test prove the two scopes are DISTINCT without duplicating glob-matching
// logic per caller.
//
// resolveMutateScope() hard-excludes `test/**` UNCONDITIONALLY, regardless of what the glob
// patterns passed in say -- a defense-in-depth invariant (not merely a convention encoded in
// data) that a test file is never a mutation target in either scope, even if
// mutation-nightly-scope.json were ever misconfigured to include one.
```

## sampleForNight

### Base lines 240-252 — Deterministically partition files into ceil groups

```
/**
 * Deterministically partition `files` into `ceil(files.length / cap)` round-robin groups (by
 * sorted index modulo group count -- a true partition, so the union of every group across a full
 * cycle reproduces `files` exactly with zero overlap) and return the one group selected for
 * `nightIndex`. Same `files`/`cap`/`nightIndex` ALWAYS returns the same sample -- this is the
 * "deterministic mutant budget/sample" the nightly design calls for: a fixed, reproducible subset
 * runs each night, and consecutive nightIndex values rotate through every group, covering the
 * whole matched set once every `groupCount` nights.
 * @param {readonly string[]} files
 * @param {number} cap
 * @param {number} nightIndex
 * @returns {{sample: string[], groupCount: number, groupIndex: number}}
 */
```

## tallyMutants

### Base lines 265-275 — Tally one file's mutant statuses. The SINGLE home

```
/**
 * Tally one file's mutant statuses. The SINGLE home for this project's reading of Stryker's
 * status vocabulary -- both parseMutationTotals() (whole-report score) and
 * evaluateReportValidity() (per-file reachability) accumulate over this, so "what counts as
 * caught" and "what counts as valid" cannot drift between the score and the guard.
 *
 * Killed and Timeout are CAUGHT (a test noticed). Survived and NoCoverage are valid-but-uncaught.
 * CompileError/RuntimeError/Ignored are not valid mutants and are excluded from both, matching
 * Stryker's own scoring convention -- they are not a statement about test-suite quality.
 * @param {ReadonlyArray<{status?: string}>} mutants
 */
```

## Run-validity guard

### Base lines 340-381 — Run-validity guard: did the test command REACH

```
// ── Run-validity guard: did the test command REACH the files this run mutated? ─────────────
//
// THIS IS A VALIDITY GUARD, NOT A QUALITY FLOOR, and the distinction is the whole point. It needs
// no measured baseline to justify, which is exactly why it can ship while the nightly's runner is
// still wrong. Passing it says ONLY that the test command exercised the mutated files at all; it
// says NOTHING about how good the tests are. The floor is scripts/mutation-baseline.json's
// `nightly.scorePct`, it is a bootstrap zero with `capturedAt: null`, and a run that passes THIS
// guard is still not evidence for setting it.
//
// THE DEFECT IT REFUSES TO CERTIFY. .github/workflows/mutation-nightly.yml overrides Stryker's
// `--mutate` glob (a rotating sample from all of src/**) but NOT stryker.conf.json's
// `commandRunner.command`, which runs two test files. So the nightly mutates files no test in its
// own runner imports, nothing can kill those mutants by construction, and the resulting score
// describes the runner rather than the suite. Nine scheduled runs concluded `success` that way.
//
// WHY THE PREDICATE IS PER-FILE AND NOT PER-MUTANT. The obvious per-mutant field does not exist
// here. MEASURED against real Stryker 9.6.1 output from this repo's own command runner: in a run
// whose mutated file NO test imports, every mutant still carries `testsCompleted: 1` (the command
// runner counts the whole command as one test), `coveredBy` and `killedBy` are absent entirely,
// and `NoCoverage` is never emitted -- the nightly's own log reads `0 no-coverage` beside 27,017
// survived. So no schema field distinguishes "reached by a test" from "no test ran against this
// file at all"; the only observable that does is the file's OUTCOME distribution.
//
// CATEGORICAL, NOT A RATIO. A file with at least one valid mutant and ZERO caught ones (nothing
// killed, nothing timed out) is UNREACHED. That is a categorical fact with no threshold to fit --
// deliberately, because a bound fitted to one observed population is this repo's most-repeated
// defect (W1-T312, W1-T380, W1-T382) and here only the BROKEN population has ever been observed.
//
// THE ONE THING IT CANNOT DISTINGUISH, stated rather than hidden: a legitimately equivalent
// mutant -- one with no observable behaviour -- also survives, and this guard cannot tell a file
// whose mutants are ALL equivalent from a file no test reached. Nothing in the report can, given
// the absent coverage fields above. What that costs is bounded: the misjudged file would have to
// have every one of its mutants equivalent, and the consequence is a spurious issue on a workflow
// that is deliberately NOT a required check, never a blocked PR. The refusal names each file and
// its mutant count so a human can settle it in seconds.
//
// SCOPED TO THIS RUN'S MUTATE LIST, which is also what makes it immune to Stryker's `incremental:
// true` accumulation: the nightly's report carries files from earlier nights (it grew 25,223 ->
// 27,017 valid mutants across two nights of a supposedly rotating 15-file sample), so a
// whole-report predicate would judge stale files forever. Judging only the files this run declared
// it was mutating keeps the guard reading tonight's sample. The accumulation remains a real defect
// for the SCORE -- untouched here, and out of scope for this one concern.
```

## evaluateReportValidity

### Base lines 391-401 — Decide whether a Stryker report is a VALID measurement

```
/**
 * Decide whether a Stryker report is a VALID measurement -- i.e. whether the test command
 * actually reached the files this run mutated. See the section comment above for why this is not
 * a quality floor and what it deliberately cannot distinguish.
 *
 * @param {{files?: Record<string, {mutants?: Array<{status?: string}>}>}} report
 * @param {readonly string[] | undefined} mutateScope the files this run asked Stryker to mutate.
 *   When omitted, every file in the report is judged instead -- reported as `scopeSource` rather
 *   than assumed, because under `incremental: true` those are not the same set.
 * @returns {{ok: boolean, scopeSource: 'declared'|'report', judged: Array<{file: string, validTotal: number, caught: number}>, unreached: Array<{file: string, validTotal: number}>, noMutants: string[]}}
 */
```

## Per-file test mapping

### Base lines 429-448 — The per-file test mapping: which tests can kill

```
// ── The per-file test mapping: which tests can kill a mutant in which module ───────────────
//
// THE PROBLEM IT SOLVES. Stryker's `commandRunner.command` is ONE command for a whole run, with no
// per-file hook, so a single invocation cannot run a different test set per mutated file. The
// nightly's old shape -- one run, a wide `--mutate`, a two-file command -- therefore mutated files
// nothing in its own command imports. The fix is one invocation per mutated file, each with a
// command derived from that file's own test importers.
//
// THE CONVENTION IS ALREADY LATENT, NOT DECLARED. MEASURED over this tree: of 109 non-test modules
// under src/**, 107 (98%) have at least one test file that imports them DIRECTLY; the median is 3
// importers and 64% have 5 or fewer. Only src/lib/dispatch-governor.ts and src/spike.ts have none.
// So nothing needs a new naming rule -- the import graph already answers the question.
//
// DIRECT IMPORTS ONLY, AND THE COST IS REAL. A mutant killed by a test that reaches the module
// INDIRECTLY registers as surviving here, which deflates the score. Following transitive edges
// instead is not an option: MEASURED, the median module is transitively reachable from 166 of the
// 358 test files (median gap of 159 over direct), so a transitive mapping IS the full suite and
// re-inherits the arithmetic that killed the naive design. **The nightly's score under this
// mapping is therefore a LOWER BOUND on the true mutation score**, and that is stated in the
// workflow header and in this mode's own output rather than left for a reader to discover.
```

## resolveImportTarget

### Base lines 452-459 — Resolve a relative import specifier written in fromFile

```
/**
 * Resolve a relative import specifier written in `fromFile` to a member of `knownModules`.
 * TypeScript source imports its own siblings with a `.js` suffix (NodeNext), so the suffix is
 * rewritten before matching. Returns undefined for anything outside the known set.
 * @param {string} spec
 * @param {string} fromFile POSIX-style repo-relative path
 * @param {ReadonlySet<string>} knownModules
 */
```

## deriveDirectImporters

### Base lines 466-474 — Build the module -> direct test importers map

```
/**
 * Build the module -> direct test importers map by parsing every test file's relative imports.
 * PURE apart from the injected reader, so a test can drive it against a synthetic tree instead of
 * this repo's real one.
 * @param {readonly string[]} srcModules repo-relative paths of the mutable modules
 * @param {readonly string[]} testFiles repo-relative paths of the test files
 * @param {(path: string) => string} readFile
 * @returns {Map<string, string[]>} module -> sorted importer list (absent when nothing imports it)
 */
```

## planNightlyRun

### Base lines 502-526 — Decide which of tonight's sampled files this run

```
/**
 * Decide which of tonight's sampled files this run can honestly measure, and why each excluded one
 * was dropped.
 *
 * THE BUDGET IS A COST CEILING, NOT A DETECTOR, and the distinction matters because this repo has
 * repeatedly shipped bounds that fired on healthy conditions (W1-T312, W1-T380, W1-T382). Nothing
 * here classifies a file as good or bad; it decides only what fits in a night. With the command
 * runner, a file costs `mutants x command-wall-clock / concurrency`, so the command's wall clock is
 * the whole cost driver.
 *
 * IT MEASURES RATHER THAN COUNTING IMPORTERS, and that is an evidence-driven choice, not a
 * preference. MEASURED on this tree, importer count barely predicts command time -- real sets of 3,
 * 4, 5, 6, 7, 8 and 11 importers timed at 15.6s, 1.3s, 16.4s, 2.8s, 19.2s, 16.9s and 6.4s. `node
 * --test` runs files concurrently, so the cost is dominated by the SLOWEST file in the set, not by
 * how many there are. An importer-count cap would therefore exclude cheap modules and admit
 * expensive ones. Measuring the command once per candidate, killed at the budget, costs at most
 * `fileCap x commandBudgetMs` per night and answers the real question.
 *
 * NO SILENT CAPS: every exclusion is returned with a named reason and printed by the caller.
 *
 * @param {readonly string[]} sample tonight's sampled modules
 * @param {Map<string, string[]>} importers from deriveDirectImporters
 * @param {{commandBudgetMs: number, measure: (testFiles: readonly string[]) => {ms: number, ok: boolean, timedOut: boolean}}} opts
 * @returns {{included: Array<{file: string, testFiles: string[], ms: number}>, excluded: Array<{file: string, reason: string}>}}
 */
```

## readsMutatedModuleSource

### Base lines 527-558 — Does testSource read the mutated module's OWN SOURCE TEXT

```
/**
 * Does `testSource` read the mutated module's OWN SOURCE TEXT?
 *
 * WHY THIS IS AN EXCLUSION AND NOT A BUG TO FIX IN THE TEST. Stryker mutates a file by REWRITING
 * it: the sandbox copy carries `stryMutAct_*` switches, and a default parameter becomes
 * `= stryMutAct_9fa48("0") ? ["Stryker was here"] : (...)`. A test that asserts on that file's
 * literal text therefore CANNOT pass in the sandbox, by construction and for every mutant --
 * Stryker's dry run aborts the whole config before a single mutant is scored. Nothing about the
 * test is wrong; a byte-identical-signature pin is a legitimate thing to assert. The two facts are
 * simply incompatible, so the honest move is to decline to measure the module and NAME why.
 *
 * MEASURED, the incident this closes: mutation-nightly failed 2026-08-29, 08-31 and 09-02 on
 * `cli-args.ts`, `triage.ts` and `cli-args.ts` again -- three nights, two modules, one shape. The
 * job alternated red/green because the nightly sample rotates by day-of-year, so the failure fired
 * whenever the rotation reached an affected file. 26 of this tree's 150 mutation candidates have a
 * direct test importer that reads their own source.
 *
 * THE DISCRIMINATOR IS THE EXTENSION, and it is exact in this codebase rather than a guess: an
 * IMPORT resolves through the compiled specifier (`../src/lib/cli-args.js`), while a SOURCE READ
 * names the TypeScript file (`join(libDir, "cli-args.ts")`). Measured on the three known-failing
 * pairs: `.ts` literals 3, 2 and 2; on a control importer that does not read source, 0.
 *
 * RESIDUE, stated rather than implied. This is a text check, not a parser -- the same posture the
 * rest of this file's heuristics already take. A test that builds the path dynamically is a FALSE
 * NEGATIVE and would still abort its config; a test that merely mentions `<name>.ts` in a string
 * is a FALSE POSITIVE and costs an unmeasured module. Both err toward measuring LESS, which is the
 * safe direction for a score this workflow already documents as a lower bound.
 *
 * @param {string} modulePath repo-relative path of the module being mutated
 * @param {string} testSource the importing test file's source
 * @returns {boolean}
 */
```

## buildNightlyStrykerConfig

### Base lines 626-641 — The Stryker config for one mutated file. PURE

```
/**
 * The Stryker config for one mutated file. PURE -- returns the object, writes nothing.
 *
 * `incremental` is deliberately ABSENT (Stryker defaults it off). The old single-run nightly set
 * `incremental: true` with a restored cache, which made its report ACCUMULATE across nights: the
 * valid-mutant count grew 25,223 -> 27,017 over two nights of a supposedly rotating sample, so the
 * number was neither a sample score nor a tree score. Under per-file invocations it would be worse
 * still, since each file's run would carry the others' state. What is lost is the cache that let a
 * night finish in ~2 minutes by re-running almost nothing -- which was only ever cheap because it
 * was measuring almost nothing. The PR gate's own stryker.conf.json keeps its incremental cache;
 * it is a required check with a real wall-clock ceiling and a single fixed scope, so accumulation
 * cannot distort it the same way.
 * @param {string} file
 * @param {readonly string[]} testFiles
 * @param {{reportPath: string, tempDirName: string}} opts
 */
```

## mergeReports

### Base lines 660-671 — Merge per-file Stryker reports into one report

```
/**
 * Merge per-file Stryker reports into one report the ratchet can read.
 *
 * A DISJOINT UNION of the `files` maps, NEVER a flattened score. evaluateReportValidity() judges
 * per-file outcome distributions, and that guard is the only thing currently stopping this job
 * certifying a run in which nothing was tested — so collapsing the reports into a single number
 * here would quietly delete it. A path appearing in two reports is a real defect in the plan (each
 * file is meant to be mutated exactly once), so it is returned as a named collision rather than
 * silently overwritten.
 * @param {ReadonlyArray<{files?: Record<string, unknown>}>} reports
 * @returns {{files: Record<string, unknown>, schemaVersion: string, collisions: string[]}}
 */
```

## evaluateRatchet

### Base lines 689-704 — Compare an actual mutation score against a recorded baseline

```
/**
 * Compare an actual mutation score against a recorded baseline.
 *
 * `scorePct` ABSENT (undefined/null) is a legitimate, honest "no baseline yet" contract and is
 * left alone. `scorePct` PRESENT but not a number (e.g. a hand-edit that quotes the value) is a
 * DIFFERENT thing: a declared baseline that cannot be compared against. That must REFUSE, not
 * silently no-op -- same distinction scripts/claude-md-budget-ratchet.mjs's `evaluateRatchet`
 * draws for `capBytes`, and the one this file's OWN nightly arm (see `--nightly-ratchet` above,
 * `typeof nightlyBaseline.scorePct !== 'number'`) already enforces for the identical field. This
 * throws rather than returning a violation because it is a config defect, not a score-floor
 * breach; the caller is expected to catch it and fail the run before it prints anything claiming
 * to enforce a baseline.
 *
 * @returns {string[]} human-readable violations; empty means the ratchet is satisfied.
 * @throws {Error} if `scorePct` is present and not a number.
 */
```

## W1-T2524: name the BLOCKED run's blind spot

### Base lines 718-728 — A test for a mutated file sitting OUTSIDE

```
// ── W1-T2524: name the BLOCKED run's blind spot ─────────────────────────────────────────────
//
// A test for a mutated file sitting OUTSIDE stryker.conf.json's commandRunner.command is
// invisible to mutation testing while being perfectly visible to every other gate -- the ONLY
// symptom, until now, was a collapsed score with no reason (MEASURED, 2026-08-30: 38.91% against
// a 75.92% baseline, entirely explained by a third classify.ts test living in a file the runner
// never ran). The fix is a report change, not a redesign: on BLOCKED, name the test files the
// command runner actually executed (parsed from the SAME stryker.conf.json the CI job itself
// invokes) beside the mutated files the report actually scored, so "your tests were not in this
// set" is readable straight from the failure. This adds NO src/ edit and touches no evaluation
// logic -- it only prints more when a run was already going to fail.
```

## resolve-scope mode banner (main)

### Base lines 781-786 — Scope-resolution introspection mode (W1-T133)

```
  // Scope-resolution introspection mode (W1-T133): resolve an arbitrary `{mutate: [...]}` JSON
  // config's scope against a candidate file list and print the result -- the SAME resolveMutateScope()
  // used by --nightly-scope above, generalized so it can be pointed at EITHER stryker.conf.json
  // (the PR gate's scope) or scripts/mutation-nightly-scope.json (the nightly scope), proving from
  // the real production files that the two resolve to DISTINCT scopes without duplicating any
  // glob-matching logic. Never touches Stryker or a report; exits 0 once it prints.
```

## nightly-scope mode banner (main)

### Base lines 805-812 — Nightly scope+sample mode (W1-T133): given a candidate

```
  // Nightly scope+sample mode (W1-T133): given a candidate file list (the workflow lists src/**
  // itself -- this script never walks the filesystem, same "caller gathers, script decides"
  // split as --changed-files above), resolve the nightly mutate glob (scripts/mutation-nightly-
  // scope.json) against it and deterministically sample down to that config's fileCap for
  // --night-index. Writes the comma-joined sample to $GITHUB_OUTPUT `mutate` for the workflow's
  // `npx stryker run --mutate "..."` step. Always exits 0 -- this mode only DECIDES the scope; it
  // never runs Stryker and never compares a score, so it can never itself be the source of a
  // silent pass (see --nightly-ratchet below for the loud-failure half).
```

## planNightlyRun's measure() comment (main)

### Base lines 875-883 — The measurement is a REAL run of the candidate's

```
    // The measurement is a REAL run of the candidate's own test command on unmutated source, killed
    // at the budget.
    //
    // ⚠ IT IS NOT STRYKER'S DRY RUN. This comment used to claim it was "Stryker's dry run in all but
    // name", and that false premise is exactly why the source-text hazard stayed invisible for three
    // scheduled failures: this runs against the REAL file, while Stryker's dry run runs against an
    // INSTRUMENTED copy in a sandbox. A test asserting on the module's literal source passes here
    // and fails there, every time. `readsMutatedModuleSource` (above) is the check this one cannot
    // be: an un-instrumented run can never observe an instrumentation-sensitive failure.
```

## nightly-ratchet mode banner (main)

### Base lines 949-955 — Nightly ratchet mode (W1-T133): compares a completed

```
  // Nightly ratchet mode (W1-T133): compares a completed nightly Stryker run against the
  // "nightly" section of scripts/mutation-baseline.json (a SIBLING of the PR-gate's root-level
  // fields -- reading/writing this section never touches the fields the PR-gate ratchet reads).
  // Degrades LOUDLY, never silently, on every failure path: a missing/non-numeric "nightly"
  // baseline section, an unreadable report file, a corrupt report file, or a below-baseline
  // score all exit non-zero with a NAMED reason -- there is no code path here that reaches a
  // zero exit without a real, valid, at-or-above-baseline comparison.
```

## Validity-before-score comment (main)

### Base lines 1043-1046 — Validity BEFORE the score comparison: if the test

```
    // Validity BEFORE the score comparison: if the test command never reached the mutated files,
    // the number above describes the runner, not the suite, and comparing it to any floor is
    // meaningless. Refuse by name rather than passing on a smaller/emptier answer -- the same
    // polarity as `rmd ledger-grep`'s zero-archive verdict.
```

## Vacuous-run comment (main)

### Base lines 1057-1060 — A run that judged NOTHING is a vacuous pass

```
    // A run that judged NOTHING is a vacuous pass, not a pass. Under the per-file plan every
    // sampled file can be excluded (no importer, over budget, red on unmutated source), which
    // leaves zero reports and a report-wide score of 100% over an empty set -- the same shape as a
    // diff-coverage OK with no instrumented records. Refuse it by name.
```

