#!/usr/bin/env node
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

import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { dirname, join, posix, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RELEVANT_PATHS_FILE = join(__dirname, 'mutation-relevant-paths.json');

/** Read the paths-list JSON data file at the given path (default: the real production list). */
export function loadRelevantPaths(filePath = DEFAULT_RELEVANT_PATHS_FILE) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

// The production list, read once at import time from the JSON data file above. Exported (as
// before) so a test can prove the default itself is sourced from data; --relevant-paths lets a
// test point at an isolated seeded fixture COPY instead, without ever touching this file or
// scripts/mutation-relevant-paths.json.
export const MUTATION_RELEVANT_PATHS = loadRelevantPaths();

/**
 * Decide whether a diff's changed files can move src/lib/classify.ts's mutation score.
 * @param {readonly string[]} changedFiles
 * @param {readonly string[]} relevantPaths
 * @returns {{run: boolean, reason: string}}
 */
export function evaluatePathFilter(changedFiles, relevantPaths = MUTATION_RELEVANT_PATHS) {
  const relevant = new Set(relevantPaths);
  const matchedPath = changedFiles.find((path) => relevant.has(path));
  if (matchedPath !== undefined) {
    return { run: true, reason: `diff touches ${matchedPath}` };
  }
  return {
    run: false,
    reason: "no changed path can move src/lib/classify.ts's mutation score",
  };
}

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
const DEFAULT_NIGHTLY_SCOPE_FILE = join(__dirname, 'mutation-nightly-scope.json');

/** Read the nightly scope's DATA file (mutate glob + per-run file cap). */
export function loadNightlyScopeConfig(filePath = DEFAULT_NIGHTLY_SCOPE_FILE) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * Convert one glob pattern (`*` = within a path segment, `**` = across zero or more segments) to
 * an anchored RegExp. Deliberately hand-rolled (no added dependency) -- the patterns this project
 * needs are a small, fixed subset, and a bespoke matcher is directly unit-testable in isolation.
 * @param {string} pattern
 */
export function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++; // consume the 2nd '*'
      if (pattern[i + 1] === '/') {
        re += '(?:.*/)?';
        i++; // consume the following '/' too -- "**/*" means "this dir or any subdir"
      } else {
        re += '.*';
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Resolve which of `candidatePaths` are in-scope for mutation, given a flat glob-pattern array
 * (a `!`-prefixed entry is an exclusion, same convention as Stryker's own `mutate` option and
 * this project's stryker.conf.json). `test/**` is EXCLUDED unconditionally regardless of
 * `patterns` -- see the section comment above.
 * @param {readonly string[]} candidatePaths
 * @param {readonly string[]} patterns
 * @returns {string[]}
 */
export function resolveMutateScope(candidatePaths, patterns) {
  const includes = [];
  const excludes = ['test/**'];
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      excludes.push(pattern.slice(1));
    } else {
      includes.push(pattern);
    }
  }
  const includeRes = includes.map(globToRegExp);
  const excludeRes = excludes.map(globToRegExp);
  return candidatePaths.filter(
    (path) => includeRes.some((re) => re.test(path)) && !excludeRes.some((re) => re.test(path)),
  );
}

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
export function sampleForNight(files, cap, nightIndex) {
  const sorted = [...files].sort();
  if (sorted.length === 0) {
    return { sample: [], groupCount: 0, groupIndex: 0 };
  }
  const safeCap = Math.max(1, cap);
  const groupCount = Math.max(1, Math.ceil(sorted.length / safeCap));
  const groupIndex = ((nightIndex % groupCount) + groupCount) % groupCount;
  const sample = sorted.filter((_, i) => i % groupCount === groupIndex);
  return { sample, groupCount, groupIndex };
}

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
export function tallyMutants(mutants) {
  let killed = 0;
  let timeout = 0;
  let survived = 0;
  let noCoverage = 0;
  for (const mutant of mutants ?? []) {
    switch (mutant.status) {
      case 'Killed':
        killed += 1;
        break;
      case 'Timeout':
        timeout += 1;
        break;
      case 'Survived':
        survived += 1;
        break;
      case 'NoCoverage':
        noCoverage += 1;
        break;
      default:
        // CompileError / RuntimeError / Ignored -- not a valid mutant, excluded.
        break;
    }
  }
  return {
    killed,
    timeout,
    survived,
    noCoverage,
    caught: killed + timeout,
    validTotal: killed + timeout + survived + noCoverage,
  };
}

/**
 * Sum mutant statuses across every file in a Stryker JSON report and derive the overall
 * mutation score -- see tallyMutants() for the status vocabulary this shares with the validity
 * guard.
 * @param {{files?: Record<string, {mutants?: Array<{status?: string}>}>}} report
 */
export function parseMutationTotals(report) {
  let killed = 0;
  let timeout = 0;
  let survived = 0;
  let noCoverage = 0;
  const files = report.files ?? {};
  for (const filePath of Object.keys(files)) {
    const tally = tallyMutants(files[filePath].mutants ?? []);
    killed += tally.killed;
    timeout += tally.timeout;
    survived += tally.survived;
    noCoverage += tally.noCoverage;
  }
  const validTotal = killed + timeout + survived + noCoverage;
  return {
    scorePct: validTotal > 0 ? (100 * (killed + timeout)) / validTotal : 100,
    killed,
    timeout,
    survived,
    noCoverage,
    validTotal,
  };
}

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

/**
 * Normalize a report key / mutate-scope entry to one comparable form.
 * @param {string} p
 */
function normalizeReportPath(p) {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

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
export function evaluateReportValidity(report, mutateScope) {
  const files = report.files ?? {};
  const byPath = new Map(Object.keys(files).map((k) => [normalizeReportPath(k), files[k]]));

  const declared = (mutateScope ?? []).map(normalizeReportPath).filter(Boolean);
  const scopeSource = declared.length > 0 ? 'declared' : 'report';
  const candidates = scopeSource === 'declared' ? [...new Set(declared)] : [...byPath.keys()];

  const judged = [];
  const unreached = [];
  const noMutants = [];
  for (const file of candidates) {
    const tally = tallyMutants(byPath.get(file)?.mutants ?? []);
    if (tally.validTotal === 0) {
      // Absent from the report, or present with nothing valid to judge (a types-only module
      // yields no mutants). Not a reachability verdict either way -- counted separately so it is
      // visible rather than silently folded into "fine".
      noMutants.push(file);
      continue;
    }
    judged.push({ file, validTotal: tally.validTotal, caught: tally.caught });
    if (tally.caught === 0) unreached.push({ file, validTotal: tally.validTotal });
  }

  return { ok: unreached.length === 0, scopeSource, judged, unreached, noMutants };
}

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

const RELATIVE_IMPORT_RE = /from\s+["'](\.[^"']*)["']/g;

/**
 * Resolve a relative import specifier written in `fromFile` to a member of `knownModules`.
 * TypeScript source imports its own siblings with a `.js` suffix (NodeNext), so the suffix is
 * rewritten before matching. Returns undefined for anything outside the known set.
 * @param {string} spec
 * @param {string} fromFile POSIX-style repo-relative path
 * @param {ReadonlySet<string>} knownModules
 */
export function resolveImportTarget(spec, fromFile, knownModules) {
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  const candidate = joined.endsWith('.js') ? `${joined.slice(0, -3)}.ts` : joined.endsWith('.ts') ? joined : `${joined}.ts`;
  return knownModules.has(candidate) ? candidate : undefined;
}

/**
 * Build the module -> direct test importers map by parsing every test file's relative imports.
 * PURE apart from the injected reader, so a test can drive it against a synthetic tree instead of
 * this repo's real one.
 * @param {readonly string[]} srcModules repo-relative paths of the mutable modules
 * @param {readonly string[]} testFiles repo-relative paths of the test files
 * @param {(path: string) => string} readFile
 * @returns {Map<string, string[]>} module -> sorted importer list (absent when nothing imports it)
 */
export function deriveDirectImporters(srcModules, testFiles, readFile) {
  const known = new Set(srcModules);
  const out = new Map();
  for (const testFile of testFiles) {
    let source;
    try {
      source = readFile(testFile);
    } catch {
      // An unreadable test file contributes no edges. It cannot silently shrink the mapping into a
      // false pass: a module left with no importers is EXCLUDED and named by planNightlyRun below.
      continue;
    }
    const seen = new Set();
    for (const match of source.matchAll(RELATIVE_IMPORT_RE)) {
      const target = resolveImportTarget(match[1], testFile, known);
      if (target) seen.add(target);
    }
    for (const target of seen) {
      const list = out.get(target) ?? [];
      list.push(testFile);
      out.set(target, list);
    }
  }
  for (const [, list] of out) list.sort();
  return out;
}

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
export function readsMutatedModuleSource(modulePath, testSource) {
  const base = modulePath.replace(/^.*\//, '');
  if (!base.endsWith('.ts')) return false;
  // The basename as a STRING LITERAL, in either quote style. Anchored on the quote so `a-b.ts`
  // cannot be matched by a longer sibling literal that merely ends with it.
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`["'\`]${escaped}["'\`]`).test(testSource);
}

export function planNightlyRun(sample, importers, opts) {
  const included = [];
  const excluded = [];
  for (const file of sample) {
    const testFiles = importers.get(file) ?? [];
    if (testFiles.length === 0) {
      excluded.push({ file, reason: 'no test file imports it directly — nothing could kill a mutant in it' });
      continue;
    }
    // BEFORE `measure`, deliberately: this costs a string scan, `measure` costs a real test run.
    // It is also the only exclusion that `measure` structurally CANNOT reach -- see
    // `readsMutatedModuleSource` and the corrected comment at the --nightly-plan call site.
    const sourceReaders = opts.readFile
      ? testFiles.filter((t) => {
          let src;
          try {
            src = opts.readFile(t);
          } catch {
            // Unreadable importer: it contributed an edge, so it exists; treat it as NOT a source
            // reader rather than excluding the module on a read failure. A wrong guess here costs
            // one aborted config, which is the state before this check existed.
            return false;
          }
          return readsMutatedModuleSource(file, src);
        })
      : [];
    if (sourceReaders.length > 0) {
      excluded.push({
        file,
        reason:
          `${sourceReaders.length} of its ${testFiles.length} direct importer(s) assert on its own SOURCE TEXT ` +
          `(${sourceReaders.join(', ')}) — Stryker must rewrite that text to mutate it, so the dry run ` +
          'aborts the config before any mutant is scored; the tests are correct and this file cannot be measured',
      });
      continue;
    }
    const result = opts.measure(testFiles);
    if (result.timedOut) {
      excluded.push({
        file,
        reason:
          `its ${testFiles.length} direct importer(s) exceed the ${opts.commandBudgetMs}ms per-file command budget ` +
          '— every mutant pays that command again, so this file does not fit in a night',
      });
      continue;
    }
    if (!result.ok) {
      excluded.push({
        file,
        reason: `its ${testFiles.length} direct importer(s) do not pass on unmutated source, so no mutant verdict from them would mean anything`,
      });
      continue;
    }
    included.push({ file, testFiles, ms: result.ms });
  }
  return { included, excluded };
}

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
export function buildNightlyStrykerConfig(file, testFiles, opts) {
  return {
    packageManager: 'npm',
    testRunner: 'command',
    commandRunner: {
      command: `node --test --import tsx --import ./test/setup/tmp-hygiene.ts ${testFiles.join(' ')}`,
    },
    mutate: [file],
    tsconfigFile: 'tsconfig.stryker-unused.json',
    disableTypeChecks: '{src,test}/**/*.ts',
    reporters: ['clear-text', 'json'],
    jsonReporter: { fileName: opts.reportPath },
    tempDirName: opts.tempDirName,
    cleanTempDir: true,
    timeoutMS: 15000,
  };
}

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
export function mergeReports(reports) {
  const files = {};
  const collisions = [];
  let schemaVersion = '1.0';
  for (const report of reports) {
    if (report?.schemaVersion) schemaVersion = report.schemaVersion;
    for (const [path, entry] of Object.entries(report?.files ?? {})) {
      if (Object.prototype.hasOwnProperty.call(files, path)) {
        collisions.push(path);
        continue;
      }
      files[path] = entry;
    }
  }
  return { files, schemaVersion, collisions };
}

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
export function evaluateRatchet(actual, baseline, epsilon = 1e-9) {
  const violations = [];
  if (baseline.scorePct !== undefined && baseline.scorePct !== null && typeof baseline.scorePct !== 'number') {
    throw new Error(`'scorePct' must be a number, got ${JSON.stringify(baseline.scorePct)}`);
  }
  if (typeof baseline.scorePct === 'number' && actual.scorePct < baseline.scorePct - epsilon) {
    violations.push(
      `mutation score ${actual.scorePct.toFixed(2)}% < baseline ${baseline.scorePct.toFixed(2)}%`,
    );
  }
  return violations;
}

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

/**
 * Pull the individual `*.test.ts` file arguments out of a Stryker `commandRunner.command`
 * string. PURE string parsing -- no filesystem access -- so it is directly unit-testable against
 * any command string, real or fixture.
 * @param {string | undefined} command
 * @returns {string[]}
 */
export function extractCommandTestFiles(command) {
  return (command ?? '').split(/\s+/).filter((token) => /\.test\.ts$/.test(token));
}

/**
 * Read a Stryker config's `commandRunner.command` and return the test files it runs. Returns
 * `undefined` (never throws) when the config is missing or unreadable -- a BLOCKED run must still
 * print its score-vs-baseline verdict even if this best-effort enrichment cannot be produced.
 * @param {string} strykerConfigPath
 * @returns {string[] | undefined}
 */
export function readCommandRunnerTestFiles(strykerConfigPath) {
  try {
    const doc = JSON.parse(readFileSync(strykerConfigPath, 'utf8'));
    return extractCommandTestFiles(doc.commandRunner?.command);
  } catch {
    return undefined;
  }
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      report: { type: 'string', default: 'reports/mutation/mutation.json' },
      baseline: { type: 'string', default: 'scripts/mutation-baseline.json' },
      'stryker-config': { type: 'string', default: 'stryker.conf.json' },
      'changed-files': { type: 'string' },
      'relevant-paths': { type: 'string' },
      'nightly-scope': { type: 'boolean', default: false },
      'nightly-plan': { type: 'boolean', default: false },
      'nightly-ratchet': { type: 'boolean', default: false },
      'resolve-scope': { type: 'boolean', default: false },
      files: { type: 'string' },
      'test-files': { type: 'string' },
      'night-index': { type: 'string' },
      'scope-config': { type: 'string' },
      'mutate-scope': { type: 'string' },
      'plan-dir': { type: 'string' },
      'report-dir': { type: 'string' },
      config: { type: 'string' },
    },
  });

  // Scope-resolution introspection mode (W1-T133): resolve an arbitrary `{mutate: [...]}` JSON
  // config's scope against a candidate file list and print the result -- the SAME resolveMutateScope()
  // used by --nightly-scope above, generalized so it can be pointed at EITHER stryker.conf.json
  // (the PR gate's scope) or scripts/mutation-nightly-scope.json (the nightly scope), proving from
  // the real production files that the two resolve to DISTINCT scopes without duplicating any
  // glob-matching logic. Never touches Stryker or a report; exits 0 once it prints.
  if (values['resolve-scope']) {
    if (!values.files || !values.config) {
      console.error('mutation-ratchet: --resolve-scope requires --files <path> and --config <path>');
      process.exitCode = 1;
      return;
    }
    const candidates = readFileSync(values.files, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const configDoc = JSON.parse(readFileSync(values.config, 'utf8'));
    const matched = resolveMutateScope(candidates, configDoc.mutate ?? []);
    console.log(`mutation-ratchet: resolve-scope -- ${matched.length} matched from ${values.config}`);
    console.log(matched.join(','));
    process.exitCode = 0;
    return;
  }

  // Nightly scope+sample mode (W1-T133): given a candidate file list (the workflow lists src/**
  // itself -- this script never walks the filesystem, same "caller gathers, script decides"
  // split as --changed-files above), resolve the nightly mutate glob (scripts/mutation-nightly-
  // scope.json) against it and deterministically sample down to that config's fileCap for
  // --night-index. Writes the comma-joined sample to $GITHUB_OUTPUT `mutate` for the workflow's
  // `npx stryker run --mutate "..."` step. Always exits 0 -- this mode only DECIDES the scope; it
  // never runs Stryker and never compares a score, so it can never itself be the source of a
  // silent pass (see --nightly-ratchet below for the loud-failure half).
  if (values['nightly-scope']) {
    if (!values.files) {
      console.error('mutation-ratchet: --nightly-scope requires --files <candidate-file-list-path>');
      process.exitCode = 1;
      return;
    }
    const candidates = readFileSync(values.files, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const scopeConfig = loadNightlyScopeConfig(values['scope-config']);
    const matched = resolveMutateScope(candidates, scopeConfig.mutate ?? []);
    const cap = typeof scopeConfig.fileCap === 'number' ? scopeConfig.fileCap : matched.length;
    const nightIndex = Number.parseInt(values['night-index'] ?? '0', 10);
    const { sample, groupCount, groupIndex } = sampleForNight(matched, cap, nightIndex);

    console.log(
      `mutation-nightly-scope: night-index ${nightIndex} -> group ${groupIndex + 1}/${groupCount} -- ` +
        `${sample.length} file(s) sampled from ${matched.length} matched (cap ${cap})`,
    );
    console.log(sample.join(','));

    const out = process.env.GITHUB_OUTPUT;
    if (out) {
      appendFileSync(out, `mutate=${sample.join(',')}\n`);
    }

    process.exitCode = 0;
    return;
  }

  // Nightly PLAN mode: derive the per-file test mapping, decide what tonight can honestly measure,
  // and emit one Stryker config per included file. This is the half that fixes the runner; it
  // never reads a report and never compares a score.
  if (values['nightly-plan']) {
    if (!values.files || !values['test-files'] || !values['plan-dir']) {
      console.error(
        'mutation-ratchet: --nightly-plan requires --files <src-candidate-list>, --test-files <test-file-list> and --plan-dir <dir>',
      );
      process.exitCode = 1;
      return;
    }
    const readList = (p) =>
      readFileSync(p, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const candidates = readList(values.files);
    const testFiles = readList(values['test-files']);
    const scopeConfig = loadNightlyScopeConfig(values['scope-config']);
    const matched = resolveMutateScope(candidates, scopeConfig.mutate ?? []);
    const cap = typeof scopeConfig.fileCap === 'number' ? scopeConfig.fileCap : matched.length;
    const nightIndex = Number.parseInt(values['night-index'] ?? '0', 10);
    const { sample, groupCount, groupIndex } = sampleForNight(matched, cap, nightIndex);
    const commandBudgetMs =
      typeof scopeConfig.commandBudgetMs === 'number' ? scopeConfig.commandBudgetMs : 20000;

    const repoRoot = resolvePath(__dirname, '..');
    const importers = deriveDirectImporters(matched, testFiles, (p) =>
      readFileSync(join(repoRoot, p), 'utf8'),
    );

    // The measurement is a REAL run of the candidate's own test command on unmutated source, killed
    // at the budget.
    //
    // ⚠ IT IS NOT STRYKER'S DRY RUN. This comment used to claim it was "Stryker's dry run in all but
    // name", and that false premise is exactly why the source-text hazard stayed invisible for three
    // scheduled failures: this runs against the REAL file, while Stryker's dry run runs against an
    // INSTRUMENTED copy in a sandbox. A test asserting on the module's literal source passes here
    // and fails there, every time. `readsMutatedModuleSource` (above) is the check this one cannot
    // be: an un-instrumented run can never observe an instrumentation-sensitive failure.
    const measure = (files) => {
      const started = Date.now();
      const result = spawnSync(
        process.execPath,
        ['--test', '--import', 'tsx', '--import', './test/setup/tmp-hygiene.ts', ...files],
        { cwd: repoRoot, timeout: commandBudgetMs, stdio: 'ignore' },
      );
      return {
        ms: Date.now() - started,
        timedOut: result.signal !== null || result.error?.code === 'ETIMEDOUT',
        ok: result.status === 0,
      };
    };

    const plan = planNightlyRun(sample, importers, {
      commandBudgetMs,
      measure,
      readFile: (p) => readFileSync(join(repoRoot, p), 'utf8'),
    });

    console.log(
      `mutation-nightly-plan: night-index ${nightIndex} -> group ${groupIndex + 1}/${groupCount} -- ` +
        `${sample.length} sampled from ${matched.length} matched (cap ${cap}, command budget ${commandBudgetMs}ms)`,
    );
    console.log(
      `mutation-nightly-plan: ${plan.included.length} file(s) this run can honestly measure, ${plan.excluded.length} excluded`,
    );
    // No silent caps: every exclusion is named with its reason, so what the nightly did NOT measure
    // is as visible in the log as what it did.
    for (const e of plan.excluded) console.log(`  - EXCLUDED ${e.file}: ${e.reason}`);

    mkdirSync(values['plan-dir'], { recursive: true });
    const configPaths = [];
    for (const entry of plan.included) {
      const slug = entry.file.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const reportPath = posix.join(values['report-dir'] ?? 'reports/mutation/nightly', `${slug}.json`);
      const configPath = join(values['plan-dir'], `${slug}.stryker.json`);
      writeFileSync(
        configPath,
        `${JSON.stringify(
          buildNightlyStrykerConfig(entry.file, entry.testFiles, {
            reportPath,
            tempDirName: `.stryker-tmp-${slug}`,
          }),
          null,
          2,
        )}\n`,
      );
      configPaths.push(configPath);
      console.log(`  - ${entry.file}: ${entry.testFiles.length} importer(s), command ${entry.ms}ms -> ${configPath}`);
    }

    const out = process.env.GITHUB_OUTPUT;
    if (out) {
      appendFileSync(out, `configs=${configPaths.join(' ')}\n`);
      // `mutate` carries the INCLUDED files only, so the run-validity guard judges exactly what was
      // actually run rather than failing on files this plan already declined to measure.
      appendFileSync(out, `mutate=${plan.included.map((e) => e.file).join(',')}\n`);
      appendFileSync(out, `included=${plan.included.length}\n`);
    }

    process.exitCode = 0;
    return;
  }

  // Nightly ratchet mode (W1-T133): compares a completed nightly Stryker run against the
  // "nightly" section of scripts/mutation-baseline.json (a SIBLING of the PR-gate's root-level
  // fields -- reading/writing this section never touches the fields the PR-gate ratchet reads).
  // Degrades LOUDLY, never silently, on every failure path: a missing/non-numeric "nightly"
  // baseline section, an unreadable report file, a corrupt report file, or a below-baseline
  // score all exit non-zero with a NAMED reason -- there is no code path here that reaches a
  // zero exit without a real, valid, at-or-above-baseline comparison.
  if (values['nightly-ratchet']) {
    let baselineDoc;
    try {
      baselineDoc = JSON.parse(readFileSync(values.baseline, 'utf8'));
    } catch (err) {
      console.error(
        `mutation-ratchet: NIGHTLY BLOCKED -- baseline file unreadable/invalid at ${values.baseline} (${err.message})`,
      );
      process.exitCode = 1;
      return;
    }
    const nightlyBaseline = baselineDoc.nightly;
    if (!nightlyBaseline || typeof nightlyBaseline.scorePct !== 'number') {
      console.error(
        `mutation-ratchet: NIGHTLY BLOCKED -- ${values.baseline} has no "nightly" section with a numeric ` +
          'scorePct (bootstrap it explicitly -- a missing section must never silently pass)',
      );
      process.exitCode = 1;
      return;
    }

    let report;
    if (values['report-dir']) {
      // Per-file plan mode produces N reports. Merge them into the shape the rest of this mode
      // already reads -- a disjoint union that PRESERVES per-file outcome distributions, because
      // the validity guard below is computed from them.
      let reportFiles;
      try {
        reportFiles = readdirSync(values['report-dir'])
          .filter((n) => n.endsWith('.json'))
          .sort()
          .map((n) => join(values['report-dir'], n));
      } catch (err) {
        console.error(
          `mutation-ratchet: NIGHTLY BLOCKED -- report directory absent or unreadable at ${values['report-dir']} (${err.message}) -- ` +
            'treating an errored/missing run as a failure, never a silent pass',
        );
        process.exitCode = 1;
        return;
      }
      const parsed = [];
      for (const path of reportFiles) {
        try {
          parsed.push(JSON.parse(readFileSync(path, 'utf8')));
        } catch (err) {
          console.error(
            `mutation-ratchet: NIGHTLY BLOCKED -- per-file report unreadable at ${path} (${err.message})`,
          );
          process.exitCode = 1;
          return;
        }
      }
      const merged = mergeReports(parsed);
      if (merged.collisions.length > 0) {
        console.error(
          'mutation-ratchet: NIGHTLY BLOCKED -- two per-file reports claim the same mutated file, so one ' +
            'run\'s outcome would have silently replaced the other\'s: ' +
            merged.collisions.join(', '),
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        `mutation-ratchet: NIGHTLY merged ${parsed.length} per-file report(s) from ${values['report-dir']} -- ` +
          `${Object.keys(merged.files).length} mutated file(s)`,
      );
      report = merged;
    } else {
      try {
        report = JSON.parse(readFileSync(values.report, 'utf8'));
      } catch (err) {
        console.error(
          `mutation-ratchet: NIGHTLY BLOCKED -- Stryker report absent or unreadable at ${values.report} (${err.message}) -- ` +
            'treating an errored/missing run as a failure, never a silent pass',
        );
        process.exitCode = 1;
        return;
      }
    }

    const actual = parseMutationTotals(report);

    console.log(
      `mutation-ratchet: NIGHTLY score ${actual.scorePct.toFixed(2)}% (baseline ${nightlyBaseline.scorePct.toFixed(2)}%) -- ` +
        `${actual.killed} killed, ${actual.timeout} timeout, ${actual.survived} survived, ${actual.noCoverage} no-coverage`,
    );

    // Validity BEFORE the score comparison: if the test command never reached the mutated files,
    // the number above describes the runner, not the suite, and comparing it to any floor is
    // meaningless. Refuse by name rather than passing on a smaller/emptier answer -- the same
    // polarity as `rmd ledger-grep`'s zero-archive verdict.
    const mutateScope = (values['mutate-scope'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const validity = evaluateReportValidity(report, mutateScope);
    console.log(
      `mutation-ratchet: NIGHTLY validity -- scope from ${validity.scopeSource}, ` +
        `${validity.judged.length} file(s) judged, ${validity.unreached.length} with ZERO caught mutants, ` +
        `${validity.noMutants.length} with no valid mutants to judge`,
    );
    // A run that judged NOTHING is a vacuous pass, not a pass. Under the per-file plan every
    // sampled file can be excluded (no importer, over budget, red on unmutated source), which
    // leaves zero reports and a report-wide score of 100% over an empty set -- the same shape as a
    // diff-coverage OK with no instrumented records. Refuse it by name.
    if (validity.judged.length === 0) {
      console.error(
        'mutation-ratchet: NIGHTLY BLOCKED -- VACUOUS RUN: not one mutated file carried a single valid ' +
          'mutant, so every statement this job could make is true over an empty set. A score computed ' +
          'from nothing is not a smaller measurement, it is no measurement.',
      );
      process.exitCode = 1;
      return;
    }

    if (!validity.ok) {
      console.error(
        'mutation-ratchet: NIGHTLY BLOCKED -- INVALID RUN, not a low score. The file(s) below were ' +
          'mutated but NOTHING in them was caught (no mutant killed, none timed out), which means the ' +
          'configured test command never exercised them. A score computed over files no test reached ' +
          'measures the RUNNER, not the suite, so this is an error rather than a smaller number:',
      );
      for (const u of validity.unreached) {
        console.error(`  - ${u.file} -- ${u.validTotal} valid mutant(s), 0 caught`);
      }
      console.error(
        'mutation-ratchet: this is a VALIDITY guard, NOT a quality floor -- passing it says the runner ' +
          'reached the mutated files and says nothing about test quality. Fix stryker.conf.json\'s ' +
          "commandRunner.command so it runs tests that import the mutated files. Do NOT set " +
          "scripts/mutation-baseline.json's nightly.scorePct from a run that fails this.",
      );
      process.exitCode = 1;
      return;
    }

    const violations = evaluateRatchet(actual, nightlyBaseline);

    if (violations.length > 0) {
      console.error(
        'mutation-ratchet: NIGHTLY BLOCKED -- mutation score dropped below the recorded nightly baseline:',
      );
      for (const v of violations) console.error(`  - ${v}`);
      process.exitCode = 1;
      return;
    }

    console.log('mutation-ratchet: NIGHTLY OK -- at or above baseline.');
    process.exitCode = 0;
    return;
  }

  // Path-filter mode (W1-T108): decide, print, write $GITHUB_OUTPUT, exit 0 -- never touches
  // --report/--baseline, never shells out to Stryker, in EITHER branch. See the usage comment
  // at the top of this file.
  if (values['changed-files'] !== undefined) {
    const changedFiles = readFileSync(values['changed-files'], 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const relevantPaths = values['relevant-paths']
      ? loadRelevantPaths(values['relevant-paths'])
      : MUTATION_RELEVANT_PATHS;
    const { run, reason } = evaluatePathFilter(changedFiles, relevantPaths);

    if (run) {
      console.log(`mutation-ratchet: REQUIRED -- ${reason}`);
    } else {
      console.log(`mutation-ratchet: skip -- ${reason}`);
    }

    const out = process.env.GITHUB_OUTPUT;
    if (out) {
      appendFileSync(out, `matched=${run}\n`);
    }

    process.exitCode = 0;
    return;
  }

  const report = JSON.parse(readFileSync(values.report, 'utf8'));
  const baseline = JSON.parse(readFileSync(values.baseline, 'utf8'));
  const actual = parseMutationTotals(report);

  let violations;
  try {
    violations = evaluateRatchet(actual, baseline);
  } catch (err) {
    // Refuse before printing anything about a baseline -- a run that cannot determine its
    // threshold must never print "baseline <n>%" as if it were enforcing one.
    console.error(`mutation-ratchet: ${values.baseline}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `mutation-ratchet: score ${actual.scorePct.toFixed(2)}% (baseline ${(baseline.scorePct ?? 0).toFixed(2)}%) -- ` +
      `${actual.killed} killed, ${actual.timeout} timeout, ${actual.survived} survived, ${actual.noCoverage} no-coverage`,
  );

  if (violations.length > 0) {
    console.error('mutation-ratchet: BLOCKED -- mutation score dropped below the recorded baseline:');
    for (const v of violations) console.error(`  - ${v}`);

    // W1-T2524: name WHAT this run measured, so "the runner never ran your test" is readable from
    // the failure itself instead of requiring the author to already know the convention.
    const mutatedFilesScored = Object.keys(report.files ?? {});
    console.error(
      `mutation-ratchet: mutated files scored: ${mutatedFilesScored.length > 0 ? mutatedFilesScored.join(', ') : '(none)'}`,
    );
    const testFilesExecuted = readCommandRunnerTestFiles(values['stryker-config']);
    if (testFilesExecuted && testFilesExecuted.length > 0) {
      console.error(
        `mutation-ratchet: test files executed (commandRunner.command in ${values['stryker-config']}): ` +
          testFilesExecuted.join(', '),
      );
      console.error(
        'mutation-ratchet: a test for a mutated file above that is NOT in that list is invisible to ' +
          'this run -- move its assertions into a file that IS in the command, or add it there in a ' +
          'separate, config-only PR (stryker.conf.json is on the instrument surface, so it cannot ship ' +
          'beside a src/ change in the same PR).',
      );
    } else {
      console.error(
        `mutation-ratchet: could not read commandRunner.command from ${values['stryker-config']} -- ` +
          'unable to name the test files this run actually executed',
      );
    }

    process.exitCode = 1;
    return;
  }

  console.log('mutation-ratchet: OK -- at or above baseline.');
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/mutation-ratchet.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2));
}
