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
//   node scripts/mutation-ratchet.mjs [--report <path>] [--baseline <path>]
//
// Defaults: --report reports/mutation/mutation.json, --baseline scripts/mutation-baseline.json
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
// The pure functions below (parseMutationTotals, tallyMutants, evaluateReportValidity,
// evaluateRatchet, evaluatePathFilter, resolveMutateScope, sampleForNight) are exported so the
// falsifier fixture test can exercise the CLI process directly (spawn + exit code) as well as the
// parsing/comparison/scope-resolution logic in isolation.

import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
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

/**
 * Compare an actual mutation score against a recorded baseline.
 * @returns {string[]} human-readable violations; empty means the ratchet is satisfied.
 */
export function evaluateRatchet(actual, baseline, epsilon = 1e-9) {
  const violations = [];
  if (typeof baseline.scorePct === 'number' && actual.scorePct < baseline.scorePct - epsilon) {
    violations.push(
      `mutation score ${actual.scorePct.toFixed(2)}% < baseline ${baseline.scorePct.toFixed(2)}%`,
    );
  }
  return violations;
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      report: { type: 'string', default: 'reports/mutation/mutation.json' },
      baseline: { type: 'string', default: 'scripts/mutation-baseline.json' },
      'changed-files': { type: 'string' },
      'relevant-paths': { type: 'string' },
      'nightly-scope': { type: 'boolean', default: false },
      'nightly-ratchet': { type: 'boolean', default: false },
      'resolve-scope': { type: 'boolean', default: false },
      files: { type: 'string' },
      'night-index': { type: 'string' },
      'scope-config': { type: 'string' },
      'mutate-scope': { type: 'string' },
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
  const violations = evaluateRatchet(actual, baseline);

  console.log(
    `mutation-ratchet: score ${actual.scorePct.toFixed(2)}% (baseline ${(baseline.scorePct ?? 0).toFixed(2)}%) -- ` +
      `${actual.killed} killed, ${actual.timeout} timeout, ${actual.survived} survived, ${actual.noCoverage} no-coverage`,
  );

  if (violations.length > 0) {
    console.error('mutation-ratchet: BLOCKED -- mutation score dropped below the recorded baseline:');
    for (const v of violations) console.error(`  - ${v}`);
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
