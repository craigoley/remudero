#!/usr/bin/env node
// scripts/mutation-ratchet.mjs
//
// Mutation-testing ratchet gate (W1-T96, MASTER-PLAN §5 tier 2, quality gate 2/4). Scores a
// Stryker JSON report and blocks a change that weakens the suite's ability to catch bugs.
//
// INVARIANT: score = 100 * (killed + timeout) / (killed + timeout + survived + noCoverage).
//   Falsifier: parseMutationTotals's tests in test/mutation-ratchet.test.ts.
// INVARIANT: Killed/Timeout count as caught; Survived/NoCoverage as valid-but-uncaught;
//   CompileError/RuntimeError/Ignored are excluded from both. Falsifier: tallyMutants's tests.
// INVARIANT: a report is valid only if every file it declares mutated caught at least one mutant.
//   Falsifier: test/mutation-report-validity.test.ts.
// INVARIANT: the nightly's mutate scope always excludes test/** and stays distinct from the PR
//   gate's own scope. Falsifier: test/the-nightly-ratchet-never-runs-on-the-nights-it-is-needed.test.ts.
// INVARIANT: the recorded baseline only ratchets upward -- a run scoring below it fails, one at or
//   above it passes. Falsifier: evaluateRatchet's tests in test/mutation-ratchet.test.ts.
//
// Six CLI modes share this file: the default ratchet, --changed-files (path filter), --resolve-
// scope, --nightly-scope, --nightly-plan and --nightly-ratchet. Each mode's own comment in main()
// below states its flags; docs/forensics/mutation-ratchet.md archives the design history and
// incidents behind each.
// Why: the full per-mode usage docs and the W1-T2524/W1-T133 incident history are archived in
// docs/forensics/mutation-ratchet.md#module-header.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from "./lib/argv.mjs";
import { REPO_ROOT } from './lib/repo-root.mjs';

// The paths that can move src/lib/classify.ts's mutation score live in DATA
// (scripts/mutation-relevant-paths.json), not in this script -- adding one is a data-file edit
// only, kept in sync BY HAND with stryker.conf.json's `mutate` glob.
// Why: docs/forensics/mutation-ratchet.md#default_relevant_paths_file.
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RELEVANT_PATHS_FILE = join(__dirname, 'mutation-relevant-paths.json');

/** Read the paths-list JSON data file at the given path (default: the real production list). */
export function loadRelevantPaths(filePath = DEFAULT_RELEVANT_PATHS_FILE) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

// The production list, read once at import time from the data file above. --relevant-paths
// lets a test point at an isolated seeded fixture COPY, without touching this file or the data.
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

// ── W1-T133: nightly scope resolution + deterministic sampling ─────────────────────────────
//
// The PR gate's mutate scope comes from stryker.conf.json; the nightly's wider one lives in its
// own data file, scripts/mutation-nightly-scope.json, so the two never share a config. Both
// resolve through resolveMutateScope(), which hard-excludes `test/**` UNCONDITIONALLY.
// Why: docs/forensics/mutation-ratchet.md#nightly-scope-resolution.
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
 * Deterministically partition `files` into `ceil(files.length / cap)` round-robin groups (a true
 * partition: every group's union reproduces `files` exactly) and return the group for `nightIndex`.
 * Same inputs always return the same sample, rotating through every group as `nightIndex` advances.
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
 * Tally one file's mutant statuses -- the single home for Stryker's status vocabulary, shared by
 * parseMutationTotals() and evaluateReportValidity() so "caught" and "valid" cannot drift between
 * the score and the guard. Killed/Timeout are CAUGHT; Survived/NoCoverage are valid-but-uncaught;
 * CompileError/RuntimeError/Ignored are excluded from both.
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
// A VALIDITY GUARD, NOT A QUALITY FLOOR: it says only that the test command exercised every file
// this run declared mutated, nothing about test quality. A file with at least one valid mutant
// and ZERO caught ones is UNREACHED, categorically, with no threshold to fit (a fitted bound is
// this repo's most-repeated defect: W1-T312, W1-T380, W1-T382). Judged over THIS run's own
// mutate list, so Stryker's `incremental` accumulation across nights cannot stale-judge old files.
// TRAP: an all-equivalent-mutants file looks identical to an unreached one; the guard cannot tell
// them apart, so it names the file and mutant count for a human to settle. Falsifier:
// test/mutation-report-validity.test.ts.
// Why: docs/forensics/mutation-ratchet.md#run-validity-guard.

/**
 * Normalize a report key / mutate-scope entry to one comparable form.
 * @param {string} p
 */
function normalizeReportPath(p) {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Decide whether a Stryker report is a VALID measurement -- whether the test command actually
 * reached the files this run mutated. See the run-validity guard section above.
 * @param {{files?: Record<string, {mutants?: Array<{status?: string}>}>}} report
 * @param {readonly string[] | undefined} mutateScope the files this run asked Stryker to mutate;
 *   when omitted, every file in the report is judged instead (reported as `scopeSource`).
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
// Stryker's `commandRunner.command` is ONE command for a whole run with no per-file hook, so the
// nightly runs one invocation per mutated file, derived from that file's own DIRECT test importers
// (never transitive -- MEASURED: transitive reachability is nearly the whole suite for the median
// module). This makes the nightly's score a LOWER BOUND on the true mutation score, stated here
// and in the workflow's own output.
// Why: docs/forensics/mutation-ratchet.md#per-file-test-mapping.

const RELATIVE_IMPORT_RE = /from\s+["'](\.[^"']*)["']/g;

/**
 * Resolve a relative import specifier in `fromFile` to a member of `knownModules`. TypeScript
 * imports siblings with a `.js` suffix (NodeNext), rewritten here before matching.
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
 * PURE apart from the injected reader, so a test can drive it against a synthetic tree.
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
 * Does `testSource` assert on the mutated module's OWN SOURCE TEXT (as opposed to importing it)?
 * Stryker mutates a file by rewriting it, so a test pinning that literal text cannot pass in the
 * sandbox for any mutant -- the dry run aborts the config. Discriminated by the extension: an
 * import resolves through the compiled `.js` specifier, a source read names the `.ts` file.
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

/**
 * Decide which of tonight's sampled files this run can honestly measure, naming why each excluded
 * one was dropped. The budget is a COST CEILING (cost is dominated by the SLOWEST importer file,
 * not by importer count, MEASURED), not a quality detector; every exclusion carries a reason.
 * @param {readonly string[]} sample tonight's sampled modules
 * @param {Map<string, string[]>} importers from deriveDirectImporters
 * @param {{commandBudgetMs: number, measure: (testFiles: readonly string[]) => {ms: number, ok: boolean, timedOut: boolean}}} opts
 * @returns {{included: Array<{file: string, testFiles: string[], ms: number}>, excluded: Array<{file: string, reason: string}>}}
 */
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
 * `incremental` is deliberately ABSENT: the old single-run nightly set it true and its valid-
 * mutant count grew across two nights of a rotating sample (MEASURED), so the score was neither a
 * sample nor a tree score. The PR gate's own stryker.conf.json is unaffected -- one required
 * check, one fixed scope, so accumulation cannot distort it there.
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
 * Merge per-file Stryker reports into one: a DISJOINT UNION of the `files` maps, never a
 * flattened score, so evaluateReportValidity()'s per-file judging still works. A path in two
 * reports is a real plan defect and is returned as a named collision rather than overwritten.
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
 * `scorePct` ABSENT is a legitimate "no baseline yet". `scorePct` PRESENT but not a number is a
 * config defect and THROWS rather than silently no-op-ing -- the caller must fail the run before
 * printing anything that claims to enforce a baseline. Same distinction
 * scripts/claude-md-budget-ratchet.mjs draws for `capBytes`.
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
// A test for a mutated file OUTSIDE stryker.conf.json's commandRunner.command is invisible to
// mutation testing while visible to every other gate. On BLOCKED, this names the test files the
// command runner actually executed beside the files the report scored, so the mismatch is
// readable from the failure.
// Why: docs/forensics/mutation-ratchet.md#w1-t2524-name-the-blocked-runs-blind-spot.

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

// ── W1-T2707: the verdict emission (MASTER-PLAN D-10) ─────────────────────────────────────
//
// Every reader of `mutation.ratchet_verdict` is built and wired (retro.ts's builder and lifetime
// rung, replay.ts, cost-anomaly.ts) and NOTHING wrote one, so D-10 read "N=0 verdicts, NO POSITIVE
// CONTROL" for six retro cycles -- not "zero escapes", but no population to count. This script is
// the only process holding a parsed Stryker report, so the emission happens here or is
// reconstructed later as a different claim.
//
// ONE LINE PER REAL PR-GATE RUN. `--changed-files` emits NOTHING in either verdict: it reads no
// report, so a line from it would manufacture a verdict from a run that scored nothing. NIGHTLY
// emits nothing either -- different scope, different baseline, and D-10 asks about the PR gate
// (W1-T133 owns the nightly split).
//
// THE LINE SHAPE IS retro.ts's. `mutationGateVerdictLine` cannot be imported -- CI runs this file
// as plain `node` -- so the shape is rebuilt and PINNED: the falsifier deep-equals the two, which
// reds if either drifts.

/** The ledger step, duplicated from retro.ts's `MUTATION_GATE_VERDICT_STEP` for the reason above.
 *  The falsifier pins the two together. */
export const RATCHET_VERDICT_STEP = 'mutation.ratchet_verdict';

/**
 * Where to record the verdict: `--ledger <path>`, else `RMD_ROOT` (the env fleet-heartbeat.sh
 * already uses for this), else NOWHERE.
 *
 * NO AMBIENT DEFAULT, and that is the point. The first draft also read ~/.config/remudero and fell
 * back to ~/Remudero. MEASURED: this repo's suite spawns this CLI dozens of times per run, so on
 * any host with a config every spawn appended to the operator's REAL ledger -- 35 junk lines
 * before the sweep caught it. The write is opt-in; silence is correct when nobody opted in.
 */
export function resolveLedgerPath(env, opts = {}) {
  if (opts.ledger) return { path: opts.ledger, source: 'flag' };
  if (env.RMD_ROOT) return { path: join(env.RMD_ROOT, 'state', 'ledger.ndjson'), source: 'env' };
  return { path: undefined, source: 'unconfigured' };
}

/** Build (never write) the verdict line. Field-for-field `mutationGateVerdictLine`'s shape. */
export function ratchetVerdictLine(input) {
  return {
    run_id: input.runId,
    task_id: input.taskId ?? 'mutation-ratchet',
    step: RATCHET_VERDICT_STEP,
    ...(input.prUrl ? { pr_url: input.prUrl } : {}),
    conclusion: input.conclusion,
    killed: input.killed,
    survived: input.survived,
    timeout: input.timeout,
    no_coverage: input.noCoverage,
  };
}

/** This run's identity. The gate has no Remudero run_id -- it is a required check on every PR, not
 *  an `rmd`-dispatched run -- so an Actions run id, then the head sha, then git's own HEAD. */
export function resolveVerdictRunId(env, spawn = spawnSync) {
  if (env.GITHUB_RUN_ID) return env.GITHUB_RUN_ID;
  if (env.GITHUB_SHA) return env.GITHUB_SHA;
  const res = spawn('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (res.error) throw res.error;
  return ((res.stdout ?? '').trim()) || 'unknown';
}

/** `<server>/<owner>/<repo>/pull/<n>` when this is a pull_request run, else undefined. */
export function resolveVerdictPrUrl(env) {
  const m = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? '');
  if (!m || !env.GITHUB_REPOSITORY) return undefined;
  return `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/pull/${m[1]}`;
}

/** Append exactly one verdict line in appendLedger's record shape (`ts` and `host` first, then the
 *  line). A ledger that cannot be written is a LOST MEASUREMENT, not a failed build -- so the
 *  failure is returned and printed with its reason, never thrown and never swallowed. */
export function emitRatchetVerdict(input, deps) {
  const line = ratchetVerdictLine(input);
  const record = { ts: deps.now(), host: deps.host(), ...line };
  try {
    deps.mkdir(dirname(deps.ledgerPath), { recursive: true });
    deps.append(deps.ledgerPath, JSON.stringify(record) + '\n');
    return { emitted: true, line: record };
  } catch (err) {
    deps.log(`mutation-ratchet: verdict NOT recorded (${deps.ledgerPath}): ${err.message}`);
    return { emitted: false, reason: err.message };
  }
}

/**
 * Decide and record one verdict: resolve where it goes, and emit it there.
 *
 * EXPORTED WITH INJECTED DEPS so BOTH arms are reachable. As an inline closure the catch below
 * could not be driven: {@link emitRatchetVerdict} contains the WRITE failure and returns rather
 * than throwing, so nothing reached the arm guarding the steps before it -- which is the arm a
 * missing import once hit, crashing this gate after it had printed its verdict. diff-coverage
 * flagged it as an added line with no covering test and was right.
 *
 * Every failure here is returned and reported, never thrown: the gate's exit code is not a
 * ledger's to veto.
 */
export function recordRatchetVerdict(conclusion, totals, deps) {
  try {
    const { path: ledgerPath, source } = deps.resolveLedger();
    // Nobody asked for a ledger: there is nothing to record to, and saying so on every PR would be
    // noise on a gate whose stdout is pinned byte-for-byte by its own suite.
    if (!ledgerPath) return { recorded: false, reason: 'unconfigured' };
    const res = deps.emit(
      { runId: deps.runId(), prUrl: deps.prUrl(), conclusion, ...totals },
      { ...deps.io, ledgerPath },
    );
    if (res.emitted) {
      // stderr, never stdout: this gate's stdout is pinned byte-for-byte by
      // test/a-test-outside-strykers-command-is-invisible.test.ts (W1-T2524 criteria 3 and 4), and
      // a verdict record is not part of the score it reports.
      deps.log(`mutation-ratchet: verdict ${conclusion} recorded to ${ledgerPath} (via ${source})`);
    }
    return { recorded: !!res.emitted, ledgerPath, source };
  } catch (err) {
    deps.log(`mutation-ratchet: verdict NOT recorded: ${err.message}`);
    return { recorded: false, reason: err.message };
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
      ledger: { type: 'string' },
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

  // Scope-resolution introspection mode (W1-T133): resolve an arbitrary `{mutate: [...]}` config's
  // scope against a candidate list with the SAME resolveMutateScope() used elsewhere, so a test can
  // point it at stryker.conf.json or scripts/mutation-nightly-scope.json and prove the two scopes
  // are DISTINCT. Never touches Stryker or a report; exits 0 once it prints.
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

  // Nightly scope+sample mode (W1-T133): resolve the nightly mutate glob against a candidate file
  // list and deterministically sample to the config's fileCap for --night-index, writing the
  // sample to $GITHUB_OUTPUT `mutate`. Always exits 0 -- it only decides scope.
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

    const repoRoot = REPO_ROOT;
    const importers = deriveDirectImporters(matched, testFiles, (p) =>
      readFileSync(join(repoRoot, p), 'utf8'),
    );

    // A REAL run of the candidate's own test command on unmutated source, killed at the budget --
    // NOT Stryker's dry run, which mutates an INSTRUMENTED copy: a test pinning the module's
    // literal source passes here and fails there. `readsMutatedModuleSource` above is that check.
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

  // Nightly ratchet mode (W1-T133): compares a completed nightly run against the "nightly" section
  // of scripts/mutation-baseline.json (a sibling of the PR-gate's own fields). Degrades LOUDLY on
  // every failure path -- there is no code path here that reaches exit 0 without a real comparison.
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

    // Validity BEFORE the score comparison: a number computed over files the runner never reached
    // describes the runner, not the suite, so it is refused by name rather than compared to a
    // floor -- the same polarity as `rmd ledger-grep`'s zero-archive verdict.
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
    // A run that judged NOTHING is a vacuous pass, not a pass -- every sampled file can be excluded
    // (no importer, over budget, red on unmutated source), leaving a report-wide 100% over an empty
    // set, the same shape as a diff-coverage OK with no instrumented records. Refuse it by name.
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

  // W1-T2707: one line per REAL PR-gate run, on BOTH conclusions. The decision lives in the
  // exported recordRatchetVerdict; this closure only supplies the process-level deps.
  const recordVerdict = (conclusion) =>
    recordRatchetVerdict(
      conclusion,
      {
        killed: actual.killed,
        survived: actual.survived,
        timeout: actual.timeout,
        noCoverage: actual.noCoverage,
      },
      {
        resolveLedger: () => resolveLedgerPath(process.env, { ledger: values.ledger }),
        runId: () => resolveVerdictRunId(process.env),
        prUrl: () => resolveVerdictPrUrl(process.env),
        emit: emitRatchetVerdict,
        io: {
          now: () => new Date().toISOString(),
          host: () => hostname(),
          mkdir: mkdirSync,
          append: appendFileSync,
          log: (msg) => console.error(msg),
        },
        log: (msg) => console.error(msg),
      },
    );

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

    recordVerdict('failure');
    process.exitCode = 1;
    return;
  }

  recordVerdict('success');
  console.log('mutation-ratchet: OK -- at or above baseline.');
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/mutation-ratchet.mjs ...`), never on import.
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
