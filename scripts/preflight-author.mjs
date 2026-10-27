#!/usr/bin/env node
// Author-time feedback, not a substitute for the required hosted full-suite/coverage verdict.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { affectedSelectionOrFull, buildAffectedSuitesGraph, changedSymbols, fullRunTrigger, isPlanOnlyDiff,
  planOnlySelectionOrFull, readAffectedSuitesInput, readPlanOnlyListing, symbollessSourceFiles } from '../src/lib/affected-suites.ts';
import { callerReachableSuites } from '../src/lib/ci-parity.ts';
import { admitStaticWork, enqueueTestSlot, lowPriorityCommand, memoryTestConcurrency, readHostLoad, readMemoryHeadroom,
  TEST_FILE_PEAK_BYTES, testRunArgv, testRunConcurrency, testSlotExecutionAllowed } from '../src/lib/test-slot.ts';
import { TYPECHECK_COLD_PEAK_BYTES } from '../src/lib/typecheck-buildinfo.ts';
import { listTestFiles, manifestEntryFor, medianMeasuredDurationMs, mergeDurations, reportManifestFallbacks, weightedDurationMs } from './test-tier-manifest.mjs';
import { closeJudgedRun, judgedNodeTestArgs, prepareJudgedRun } from './pure-test-pool.mjs';
import { isMainModule, parseArgv } from './lib/argv.mjs';
import { REPO_ROOT } from './lib/repo-root.mjs';
import { captureStepSync, AUTHOR_OUTPUT_LIMIT_BYTES, AUTHOR_STEP_RUNTIME_MS } from './lib/author-step-capture.mjs';
import { AUTHOR_RUNTIME_SAFETY_FACTOR, AUTHOR_SHUTDOWN_RESERVE_MS, runtimeBindings, readRuntimeProfile, runtimeDeadlineFit, closedDurationEvidence } from './lib/native-author-runtime.mjs';
import { authorDependencyProvenance, sameAuthorDependencyProvenance } from './lib/author-dependency-provenance.mjs';
import { accountAuthorPhases } from './lib/author-phase-accounting.mjs';
import { AUTHOR_WORKFLOW_CONTRACT_MAX_MS, AUTHOR_WORKFLOW_CONTRACT_SUITES, authorWorkflowContractInputs } from './lib/author-workflow-contract.mjs';
import { evaluateHeadIdentityGate } from './head-identity-gate.mjs';
import { guardedAuthorEntry, MacAuthorCapacityRefusal } from './lib/mac-author-admission.mjs';
import { scanRepo as scanCoverageBlanking } from './coverage-session-blanking-check.mjs';

/** The exit status of a run whose selection the host cannot carry: distinct from pass (0) and fail (1). */
export const OVER_CAPACITY_EXIT = 3;
/** The most test files an author run runs at once (the cap test-slot.ts has always applied here). */
export const AUTHOR_MAX_WORKERS = 4;
/** The author's suite slot asks for one worker; before admission the suites are priced at it. */
const AUTHOR_SLOT_CEILING = 1;
const AUTHOR_SUITE_LABEL = 'preflight-author:static-and-affected';
const AUTHOR_STATIC_LABEL = 'preflight-author:static';
/** BACKSTOP: a docs freshness failure must not wait through a heavy author phase. */
export const AUTHOR_DOCS_PRECHECK_MAX_MS = 30_000;
/** Only docs-index inputs and its executable contract; deletion/rename sides remain in the diff. */
export function authorDocsIndexInputs(changedFiles) {
  return changedFiles.filter(path => (path.startsWith('docs/') && (path.endsWith('.md') || path === 'docs/docs-index.json')) ||
    path.startsWith('scripts/generate-docs-index') || path === '.github/workflows/docs-index-check.yml' || path === 'package.json');
}
/** The share of the author step runtime one affected-test run may spend: the wall time an author waits. */
export const AUTHOR_WALL_SHARE = 1 / 16;
/** A suite is never priced below this, so an unmeasured file in an empty manifest is not free. */
export const AUTHOR_MIN_SUITE_COST_MS = 1000;

/** The test-slot readers' view of this host right now. */
export function readHostCapacityInputs() {
  const { cores, load1 } = readHostLoad();
  return { cores, load1, headroomBytes: readMemoryHeadroom() };
}

/**
 * W1-T7809 — what this host can carry, derived from the measured cores and load (testRunConcurrency),
 * the memory headroom (memoryTestConcurrency) and the author step runtime. There is no fixed suite count:
 * a larger host grants more workers and so a larger budget; a smaller or busier one grants fewer.
 * `slotConcurrency`, when the acquired test slot grants fewer workers, caps them further.
 */
export function hostBudget({ cores, load1, headroomBytes }, { stepRuntimeMs = AUTHOR_STEP_RUNTIME_MS,
  perFileBytes = TEST_FILE_PEAK_BYTES, slotConcurrency } = {}) {
  const cpuWorkers = testRunConcurrency({ cores, load1 }, 1);
  const memoryWorkers = memoryTestConcurrency(headroomBytes, perFileBytes);
  const workers = Math.max(1, Math.min(AUTHOR_MAX_WORKERS, cpuWorkers, memoryWorkers ?? Infinity,
    Number.isSafeInteger(slotConcurrency) && slotConcurrency >= 1 ? slotConcurrency : Infinity));
  const wallMs = Math.floor(stepRuntimeMs * AUTHOR_WALL_SHARE);
  return { workers, wallMs, budgetMs: workers * wallMs, wallShare: AUTHOR_WALL_SHARE,
    inputs: { cores, load1, headroomBytes: headroomBytes ?? null, perFileBytes, stepRuntimeMs,
      cpuWorkers, memoryWorkers: memoryWorkers ?? null, slotConcurrency: slotConcurrency ?? null } };
}

/** A validated native-profile run may spend its fixed remaining deadline, not a second
 *  unrelated wall-share budget. This changes time only: CPU/memory/lease workers stay intact.
 *  The caller uses this only AFTER readRuntimeProfile has validated closed current-tree evidence. */
export function deadlineHostBudget(budget, { deadline, now = Date.now() } = {}) {
  if (!Number.isFinite(deadline) || !Number.isFinite(now) ||
      !Number.isSafeInteger(budget.workers) || budget.workers < 1 || budget.workers > AUTHOR_MAX_WORKERS ||
      !Number.isSafeInteger(budget.inputs?.stepRuntimeMs) || budget.inputs.stepRuntimeMs <= 0) {
    throw new Error('deadline host budget: invalid fixed deadline or admitted capacity');
  }
  const wallMs = Math.max(0, Math.floor(Math.min(budget.inputs.stepRuntimeMs,
    deadline - now - AUTHOR_SHUTDOWN_RESERVE_MS)));
  return { ...budget, wallMs, budgetMs: budget.workers * wallMs, wallShare: null,
    source: 'validated-native-fixed-deadline',
    inputs: { ...budget.inputs, deadline, pricedAtMs: now, shutdownReserveMs: AUTHOR_SHUTDOWN_RESERVE_MS } };
}

/** The priced cost of `suites` in suite-milliseconds: each at its manifest duration, an unknown file at the
 *  manifest median, never below {@link AUTHOR_MIN_SUITE_COST_MS}; times the author runtime safety factor. */
export function priceSelection(suites, manifest) {
  const files = manifest?.files && typeof manifest.files === 'object' ? manifest : { files: {} };
  const median = medianMeasuredDurationMs(files);
  let unmeasured = 0, total = 0;
  for (const suite of suites) {
    if (!(manifestEntryFor(files, suite) > 0)) unmeasured += 1;
    total += Math.max(AUTHOR_MIN_SUITE_COST_MS, weightedDurationMs(suite, files, median));
  }
  return { suites: suites.length, unmeasured, medianMs: median, rawMs: total,
    costMs: Math.ceil(total * AUTHOR_RUNTIME_SAFETY_FACTOR), safetyFactor: AUTHOR_RUNTIME_SAFETY_FACTOR };
}

export function runtimeSelectionFit(files, manifest, profile, options) {
  reportManifestFallbacks(files, manifest);
  const current = mergeDurations(manifest, Object.fromEntries(files.map(file =>
    [file, manifestEntryFor(manifest, file)])));
  return runtimeDeadlineFit(files, current, profile, options);
}

/** Whether the priced selection fits the host budget. */
export function capacityVerdict(suites, manifest, budget) {
  const price = priceSelection(suites, manifest);
  return { fits: price.costMs <= budget.budgetMs, ...price, budgetMs: budget.budgetMs, workers: budget.workers,
    wallMs: budget.wallMs, wallShare: budget.wallShare, inputs: budget.inputs,
    budgetSource: budget.source ?? 'legacy-wall-share' };
}

/**
 * The narrow subset of an over-capacity selection that fits, ordered by reach: the changed tests, then the
 * narrow candidate, then (only for an import-graph floor, never a full fallback) the rest cheapest first.
 */
export function fittingSubset(suites, manifest, budget, { changed = [], narrow = [], includeRest = true } = {}) {
  const changedSet = new Set(changed), narrowSet = new Set(narrow);
  const tier = (suite) => (changedSet.has(suite) ? 0 : narrowSet.has(suite) ? 1 : 2);
  const cost = (suite) => priceSelection([suite], manifest).costMs;
  const ordered = [...suites].filter((suite) => includeRest || tier(suite) < 2)
    .sort((a, b) => tier(a) - tier(b) || cost(a) - cost(b) || a.localeCompare(b));
  const ran = [];
  let used = 0;
  for (const suite of ordered) {
    const next = cost(suite);
    if (used + next <= budget.budgetMs) { ran.push(suite); used += next; }
  }
  const kept = new Set(ran);
  return { ran: ran.sort(), skipped: [...suites].filter((suite) => !kept.has(suite)).sort(), costMs: used };
}

/**
 * W1-T9953 — a full fallback is never run whole: CI runs the full suite on every PR anyway, hours sooner.
 * The changed files that force a full run on their own are SET ASIDE; the partial candidate set is the
 * changed tests, the suites reaching a set-aside file through the import/named-path graph, and the
 * selection `select` gives for the modelled rest. Every other suite is CI's full run. A part that cannot be
 * read is named in `unavailable`, never silently empty.
 */
export function fullFallbackPartialSet({ root, changed, suites, fullRun, range, select,
  readInput = (files) => readAffectedSuitesInput(root, files) }) {
  const known = new Set(suites);
  const setAside = fullRun ? changed.filter((file) => fullRunTrigger([file], false) !== undefined) : [];
  const asideSet = new Set(setAside);
  const changedTests = changed.filter((file) => known.has(file));
  const unavailable = [];
  const setAsideReaders = [];
  if (setAside.length > 0) {
    try {
      const { importers } = buildAffectedSuitesGraph(readInput(setAside).files, setAside);
      const seen = new Set(), queue = [...setAside];
      while (queue.length > 0) {
        const file = queue.shift();
        if (seen.has(file)) continue;
        seen.add(file);
        if (known.has(file) && !asideSet.has(file)) setAsideReaders.push(file);
        for (const next of importers.get(file) ?? []) queue.push(next);
      }
    } catch (error) {
      unavailable.push(`set-aside readers could not be read: ${error.message}`);
    }
  }
  const rest = changed.filter((file) => !asideSet.has(file));
  let modelled = [];
  if (setAside.length > 0 && rest.length > 0) {
    try {
      const restSelection = select(rest, range);
      if (restSelection.fullRun) unavailable.push(`modelled rest fell back too: ${restSelection.reasons.join('; ')}`);
      else modelled = (restSelection.narrow?.length ? restSelection.narrow : restSelection.suites).filter((suite) => known.has(suite));
    } catch (error) {
      unavailable.push(`modelled rest could not be selected: ${error.message}`);
    }
  }
  const tiers = { changed: [...new Set(changedTests)].sort(), setAsideReaders: [...new Set(setAsideReaders)].sort(),
    modelled: [...new Set(modelled)].sort() };
  return { setAside, tiers, suites: [...new Set([...tiers.changed, ...tiers.setAsideReaders, ...tiers.modelled])].sort(),
    ...(unavailable.length > 0 ? { unavailable } : {}) };
}

/** The W1-T9953 sentence a full-fallback run prints, ran or not: what ran locally and what is CI's. */
export function partialSentence(ran, total, setAside) {
  return `full-fallback: PARTIAL — ran ${ran} of ${total} suite(s) chosen by reach and measured cost; CI's full run is the check for ${setAside.length > 0 ? setAside.join(', ') : 'the cause of the fallback'} and the other ${total - ran}`;
}

/** W1-T9919 — the line census-precheck prints when its suite child's time bound is the ONLY unmeasured cause
 *  (CENSUS_TIME_BOUND_LABEL in scripts/census-precheck.mjs). That backstop fires on a loaded, healthy host. */
export const CENSUS_TIME_BOUND_LINE = 'census-precheck: census suites NOT MEASURED (time bound) - ';

/** Whether a census-precheck result is the one unmeasured census an author run goes on past, as pre-push does:
 *  a complete exit 2 whose stderr has that line and no other NOT MEASURED or could-not-measure line. */
export function censusTimeBoundOnly(result) {
  if (result.status !== 2 || result.signal || result.error || result.outputComplete === false) return false;
  const lines = String(result.stderr ?? '').split('\n');
  return lines.some((line) => line.startsWith(CENSUS_TIME_BOUND_LINE)) &&
    !lines.some((line) => /^census-precheck: (?:.* NOT MEASURED - |could not measure)/.test(line));
}

export function authorEnvironment(parent) {
  const env = { ...parent, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: '' };
  // Git's repository-local environment overrides cwd, including in test subprocesses.
  // Keep transport/auth settings, but never certify a foreign HEAD, index or object store.
  for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR',
    'GIT_NAMESPACE', 'GIT_QUARANTINE_PATH', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_NO_REPLACE_OBJECTS',
    'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE', 'GIT_INTERNAL_SUPER_PREFIX']) delete env[key];
  return env;
}

export function verifiedSuites(root, suites) {
  return [...new Set(suites)].sort().map((suite) => {
    const path = resolve(root, suite);
    if (!/^test\/.*\.test\.ts$/.test(suite) || !path.startsWith(resolve(root) + sep) ||
        !lstatSync(path).isFile()) throw new Error(`unverified test target: ${suite}`);
    return suite;
  });
}

export function completeTestResult(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return result.status === 0 && !result.signal && !result.error && result.outputComplete !== false &&
    /^# tests [1-9][0-9]*$/m.test(output) && /^# pass [1-9][0-9]*$/m.test(output) && /^# fail 0$/m.test(output);
}

export function testSummary(output) {
  const fields = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
  const summary = Object.fromEntries(fields.map((field) => {
    const value = [...output.matchAll(new RegExp(`^# ${field} ([0-9]+)$`, 'gm'))].at(-1)?.[1];
    return [field, value === undefined ? null : Number(value)];
  }));
  return fields.every((field) => summary[field] !== null) ? summary : null;
}

/** The author selection for `changed` over `range` (`<base>...<head>`): the floor, plus the NARROW
 *  candidate (changed tests, suites naming a changed source symbol or its src/ caller, path readers,
 *  suites naming a changed file) whenever every changed source file names a symbol. A file whose
 *  hunks name none — an import-only edit, a deletion — leaves `narrow` absent, so the floor runs. */
export function authorSelection(root, changed, range, spawn = spawnSync) {
  // W1-T7809: a plan-only diff runs plan lint and the suites that read its shards, not every loadPlan caller.
  if (isPlanOnlyDiff(changed)) return planOnlySelectionOrFull(changed, () => readPlanOnlyListing(root, changed));
  return affectedSelectionOrFull(changed, () => {
    const scoped = (file, args, opts = {}) => {
      const result = spawn(file, args, { cwd: root, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024,
        env: authorEnvironment(process.env), ...opts });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
        ...(result.error ? { error: result.error.message } : {}), ...(result.signal ? { signal: result.signal } : {}) };
    };
    const diff = scoped('git', ['diff', '-U0', range, '--', 'src', 'scripts', 'bin']);
    if (diff.status !== 0) throw new Error(`git diff -U0 ${range} exited ${diff.status}: ${diff.stderr.trim().slice(0, 200)}`);
    const readFile = (path) => readFileSync(join(root, path), 'utf8');
    const symbolless = symbollessSourceFiles(changed, diff.stdout, readFile);
    if (symbolless.length > 0) return readAffectedSuitesInput(root, changed);
    const symbols = changedSymbols(diff.stdout, readFile);
    const symbolSuites = symbols.length === 0 ? [] : callerReachableSuites(symbols, root, scoped).suites;
    return readAffectedSuitesInput(root, changed, { symbolSuites });
  });
}

/** Judge the publication destination, never the local branch name. Unknown is not a pass.
 *  No automatic consumer supplies the target yet; measurement is scoped to explicit caller input.
 *  `git` is the author's checked, environment-scrubbed runner, pinned to this worktree. */
export function authorPublicationIdentity({ headRef, headSha, baseSha, publicationSha }, git) {
  const scope = { headRef: headRef ?? null, headSha, baseSha };
  const refuse = (message) => ({ ...scope, state: 'refused', message });
  if (publicationSha !== undefined && publicationSha !== headSha) {
    return refuse(`publication head ${publicationSha} is not the committed author HEAD ${headSha}; validate the tree that will be published`);
  }
  if (headRef === undefined) {
    let current = '';
    try { current = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(); } catch { /* the hint is advisory; the state stays unknown-target */ }
    const hint = current && current !== 'HEAD' ? `--head-ref ${current} --head-sha ${headSha}` : '--head-ref <destination branch>';
    return { ...scope, state: 'unknown-target', message: `publication target unknown; rerun with ${hint} before publication so a head-identity refusal is caught here, not by a hosted round; identity NOT verified` };
  }
  const branch = headRef.replace(/^refs\/heads\//, '');
  if (!branch || branch === 'HEAD' || (headRef.startsWith('refs/') && !headRef.startsWith('refs/heads/'))) {
    return refuse('--head-ref must name the destination branch, optionally prefixed with refs/heads/');
  }
  scope.headRef = branch;
  scope.targetRef = `refs/heads/${branch}`;
  try {
    git(['check-ref-format', scope.targetRef]);
    // Match head-identity-gate's author-message walk and diff, at the EXACT committed SHA.
    // No bare HEAD read: a refspec may publish another commit, which this author run cannot certify.
    const headCommitMessage = git(['log', '-1', '--first-parent', '--no-merges', '--format=%B', headSha]);
    if (!headCommitMessage.trim()) return refuse('cannot read the publication head author message');
    const changedPaths = git(['diff', '--name-only', '-z', '--no-renames', `${baseSha}...${headSha}`]).split('\0').filter(Boolean);
    const result = evaluateHeadIdentityGate({ headCommitMessage, headRef: branch, changedPaths });
    return { ...scope, state: result.ok ? 'passed' : 'refused', message: result.message };
  } catch (error) {
    return refuse(`publication identity could not be measured: ${error.message}`);
  }
}

export function main(argv, { root = REPO_ROOT, spawn = spawnSync,
  select = (changed, range) => authorSelection(root, changed, range), host, admitHost = () => undefined,
  testSlot = {} } = {}) {
  const { values, helpRequested } = parseArgv(argv, {
    'dry-run': { type: 'boolean' },
    deadline: { type: 'string' },
    'runtime-profile': { type: 'string' },
    'head-ref': { type: 'string' },
    'head-sha': { type: 'string' },
  }, { allowPositionals: false, helpText: 'preflight-author.mjs [--dry-run] [--head-ref <publication destination branch> [--head-sha <committed HEAD sha>]] [--deadline <ISO> --runtime-profile <path>]: fresh-base affected tests + default static preflight; unknown publication target is NOT identity assurance; full hosted CI remains required.' });
  if (helpRequested) return 0;
  const startedAt = Date.now();
  const receipt = { version: 1, assurance: 'author-only', hostedFullSuiteAndCoverage: 'required-pending',
    node: process.version, dryRun: Boolean(values['dry-run']), steps: [], suites: [] };
  let diagnosticsRoot;
  const deadline = values.deadline === undefined ? undefined : Date.parse(values.deadline);
  const run = (file, args, extra = {}) => spawn(file, args, {
    cwd: root, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024,
    env: authorEnvironment(process.env), ...extra,
  });
  const ensureDiagnostics = () => {
    if (!diagnosticsRoot) {
      mkdirSync(join(root, 'coverage'), { recursive: true });
      diagnosticsRoot = mkdtempSync(join(root, 'coverage', 'rmd-author-'));
    }
  };
  const progress = (currentStep) => {
    ensureDiagnostics();
    const path = join(diagnosticsRoot, 'progress.json');
    writeFileSync(path + '.next', JSON.stringify({ ...receipt, verdict: receipt.verdict ?? 'running',
      authorPid: process.pid, currentStep, updatedAt: new Date().toISOString() }) + '\n',
    { mode: 0o600, flag: 'wx', flush: true });
    renameSync(path + '.next', path);
  };
  const runStep = (name, args, file = process.execPath, childEnvironment = {}, phaseMaxMs = AUTHOR_STEP_RUNTIME_MS, heartbeat = undefined) => {
    const runtimeLimitMs = deadline === undefined ? phaseMaxMs :
      Math.min(phaseMaxMs, Math.max(1, deadline - Date.now() - AUTHOR_SHUTDOWN_RESERVE_MS));
    progress({ name, outputLimitBytes: AUTHOR_OUTPUT_LIMIT_BYTES, runtimeLimitMs });
    const logs = { stdoutPath: join(diagnosticsRoot, `${name}.stdout.log`),
      stderrPath: join(diagnosticsRoot, `${name}.stderr.log`) };
    // Injected spawn outcomes remain an explicit diagnostic seam; production owns live pipes.
    if (spawn !== spawnSync) return run(file, args, { env: { ...authorEnvironment(process.env), ...childEnvironment } });
    const resultPath = join(diagnosticsRoot, `${name}.native-result.json`);
    // W1-T9928: a slotted step's spooler beats the slot while this loop is blocked in spawnSync.
    const result = captureStepSync(file, args, { cwd: root, env: { ...authorEnvironment(process.env), ...childEnvironment }, trackParent: true,
      ...logs, resultPath, runtimeMs: runtimeLimitMs, ...(heartbeat ? { heartbeat } : {}) });
    return { ...result, capturedLogs: true, nativeResult: relative(root, resultPath) };
  };
  const git = (args) => {
    const result = run('git', args);
    if (result.status !== 0 || result.error || result.signal) {
      throw new Error(`git ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.signal}`);
    }
    return result.stdout;
  };
  const report = (name, result, ok, metadata = {}) => {
    ensureDiagnostics();
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const logs = { stdout: join(diagnosticsRoot, `${name}.stdout.log`), stderr: join(diagnosticsRoot, `${name}.stderr.log`) };
    if (!result.capturedLogs) {
      writeFileSync(logs.stdout, stdout, { mode: 0o600, flag: 'wx' });
      writeFileSync(logs.stderr, stderr, { mode: 0o600, flag: 'wx' });
    }
    receipt.steps.push({ name, ok, ...metadata, exitCode: result.status, signal: result.signal ?? null,
      durationMs: result.durationMs ?? null, startedAt: result.startedAt ?? null, finishedAt: result.finishedAt ?? null,
      error: result.error ? { message: result.error.message, code: result.error.code ?? null } : null,
      ...(name.startsWith('affected-tests') || name === 'workflow-contract-precheck'
        ? { testSummary: testSummary(`${stdout}\n${stderr}`) } : {}),
      diagnostics: { stdout: relative(root, logs.stdout), stderr: relative(root, logs.stderr),
        stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
        ...(result.nativeResult ? { nativeResult: result.nativeResult } : {}),
        mayBeIncomplete: Boolean(result.error || result.signal || result.outputComplete === false) } });
    progress();
    // Keep terminal feedback small even for thousands of suites. Never rerun to recover output.
    console.log(`${name}: ${!ok ? 'FAIL' : metadata.notMeasured ? 'NOT MEASURED' : 'PASS'}; ${result.error || result.signal ? 'captured output (may be incomplete)' : 'complete output'}: ${relative(root, diagnosticsRoot)}`);
    const failures = stdout.split('\n').filter((line) => /^\s*not ok [0-9]+/.test(line));
    const replay = (text, channel) => text.split('\n').map(line => `[author ${name} ${channel}] ${line}`).join('\n') + '\n';
    if (failures.length) console.log(replay(failures.slice(0, 40).join('\n').slice(0, 4096), 'failures'));
    if (failures.length > 40) console.log(`additional failure titles in the saved log: ${failures.length - 40}`);
    process.stdout.write(replay(stdout.slice(-4096), 'stdout'));
    process.stderr.write(replay(stderr.slice(-4096), 'stderr'));
    if (result.error) console.error(`${name}: ${result.error.code ?? 'spawn-error'}: ${result.error.message}; captured logs may be incomplete`);
  };
  try {
    if ((values.deadline === undefined) !== (values['runtime-profile'] === undefined) ||
        (deadline !== undefined && (!Number.isFinite(deadline) || deadline <= Date.now()))) {
      throw new Error('runtime admission requires a future ISO deadline and a native runtime profile together');
    }
    const pinnedNode = readFileSync(join(root, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
    if (process.versions.node !== pinnedNode) throw new Error(`Node ${pinnedNode} required; got ${process.versions.node}`);
    // Turning worktreeConfig on removes Git's main-worktree-only exception for these keys.
    // A suite can enable it midway through validation and poison every sibling checkout.
    // Admit the topology, never migrate an operator's shared Git configuration here.
    receipt.gitTopology = { state: 'unknown', reads: [] };
    const inside = git(['rev-parse', '--is-inside-work-tree']).trim();
    if (inside !== 'true') {
      if (inside === 'false') receipt.gitTopology.state = 'not-worktree';
      throw new Error('a readable Git working tree is required before author selection or validation');
    }
    const commonValue = (key, boolean = false) => {
      const result = run('git', ['config', '--local', ...(boolean ? ['--type=bool'] : []), '--get', key]);
      receipt.gitTopology.reads.push({ key, status: result.status, signal: result.signal ?? null,
        error: result.error?.message ?? null });
      if (result.error || result.signal || ![0, 1].includes(result.status) ||
          (result.status === 1 && result.stdout?.trim())) {
        const reason = result.error?.message ?? (result.signal ? `signal ${result.signal}`
          : result.stderr?.trim() || `exit ${result.status}`);
        throw new Error(`shared Git ${key} is unreadable: ${reason}`);
      }
      if (result.status === 1) return undefined;
      const value = result.stdout.trim();
      if (boolean && !['true', 'false'].includes(value)) throw new Error(`shared Git ${key} is ambiguous`);
      return value;
    };
    const bare = commonValue('core.bare', true), worktree = commonValue('core.worktree');
    receipt.gitTopology.sharedCoreBare = bare ?? 'absent';
    receipt.gitTopology.sharedCoreWorktree = worktree === undefined ? 'absent' : 'present';
    if (bare === 'true' || worktree !== undefined) {
      receipt.gitTopology.state = 'hazardous-common-config';
      throw new Error('shared Git core.bare=true or core.worktree requires an owned, idle worktreeConfig migration before author validation; this gate does not change shared configuration');
    }
    receipt.gitTopology.state = 'safe';
    if (git(['status', '--porcelain', '--untracked-files=normal']).trim()) {
      throw new Error('commit the author tree first; an uncommitted or untracked change is not covered by its HEAD receipt');
    }
    git(['fetch', 'origin', 'main']);
    receipt.headSha = git(['rev-parse', 'HEAD']).trim();
    receipt.baseSha = git(['rev-parse', 'origin/main']).trim();
    if (![receipt.headSha, receipt.baseSha].every((sha) => /^[a-f0-9]{40}$/.test(sha))) throw new Error('unresolved head or base SHA');
    // A boundary can hide historical controls or make git show render the whole tree.
    // A successful ordinary fetch does not prove it removed that boundary.
    receipt.gitHistory = { state: 'unknown' };
    const shallow = git(['rev-parse', '--is-shallow-repository']).trim();
    if (shallow === 'true') {
      receipt.gitHistory.state = 'shallow';
      throw new Error('complete Git history required before author selection or validation; inspect the owned checkout and run git fetch --unshallow before a distinct admitted run');
    }
    if (shallow !== 'false') throw new Error('Git history completeness is unavailable; author selection and expensive validation were not started');
    receipt.gitHistory.state = 'complete';
    receipt.publicationIdentity = authorPublicationIdentity({ headRef: values['head-ref'],
      publicationSha: values['head-sha'], headSha: receipt.headSha, baseSha: receipt.baseSha }, git);
    console.log(`publication identity: ${receipt.publicationIdentity.state}; ${receipt.publicationIdentity.message}`);
    if (receipt.publicationIdentity.state === 'refused') {
      receipt.affectedTestsNotRunReason = 'publication identity refused; no selection, dependency, census, heavy slot, static or test phase was started';
      throw new Error(receipt.publicationIdentity.message);
    }
    receipt.changedFiles = git(['diff', '--name-only', '-z', `${receipt.baseSha}...${receipt.headSha}`]).split('\0').filter(Boolean);
    if (receipt.changedFiles.length === 0) throw new Error('empty author diff: nothing to verify');
    receipt.affectedTestsNotRunReason = 'coverage blanking refused before selection; changed-test evidence must be readable';
    const changedTests = receipt.changedFiles.filter(file => file.startsWith('test/') && file.endsWith('.ts'))
      .filter(file => {
        try {
          lstatSync(join(root, file));
          return true;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          // A missing working-tree file is a deletion only with positive committed-tree evidence.
          if (git(['ls-tree', '--name-only', '-z', receipt.headSha, '--', file]) === '') return false;
          throw error;
        }
      });
    receipt.coverageBlankingPrecheck = scanCoverageBlanking(root, changedTests);
    if (receipt.coverageBlankingPrecheck.defects.length || receipt.coverageBlankingPrecheck.suspects.length) {
      throw new Error('coverage blanking refused before selection; see coverageBlankingPrecheck findings');
    }
    delete receipt.affectedTestsNotRunReason;
    const selection = select(receipt.changedFiles, `${receipt.baseSha}...${receipt.headSha}`);
    // The narrow selection runs when it was computed and names a suite; else the floor; else all.
    const narrow = selection.fullRun ? undefined : selection.narrow;
    receipt.floorSize = selection.fullRun ? null : selection.suites.length;
    receipt.narrowSize = narrow === undefined ? null : narrow.length;
    receipt.selection = selection.fullRun ? 'full-fallback' : selection.planOnly ? 'plan-only' : narrow?.length ? 'affected-narrow'
      : selection.suites.length > 0 ? 'affected-floor' : 'full-fallback';
    receipt.reasons = selection.reasons;
    if (!selection.fullRun && receipt.selection === 'full-fallback') receipt.reasons = [...selection.reasons, 'empty affected floor: refusing a zero-test green'];
    receipt.suites = verifiedSuites(root, receipt.selection === 'full-fallback' ? listTestFiles(root)
      : receipt.selection === 'affected-narrow' ? narrow : selection.suites);
    // A plan-only selection may name no suite: plan lint is then its whole check, and it says so.
    if (receipt.suites.length === 0 && receipt.selection !== 'plan-only') throw new Error('no verified test files in the checkout');
    console.log(`author selection: ${receipt.selection}, ${receipt.suites.length} suite(s) (floor ${receipt.floorSize ?? 'full'}, narrow ${receipt.narrowSize ?? 'none'}); head=${receipt.headSha}, base=${receipt.baseSha}`);
    // W1-T9953: name why, and set aside what forced it; the partial set is all that may run locally.
    let partial;
    if (receipt.selection === 'full-fallback') {
      for (const reason of receipt.reasons) console.log(`full-fallback because: ${reason}`);
      partial = fullFallbackPartialSet({ root, changed: receipt.changedFiles, suites: receipt.suites,
        fullRun: Boolean(selection.fullRun), range: `${receipt.baseSha}...${receipt.headSha}`, select });
      if (partial.unavailable) for (const why of partial.unavailable) console.log(`full-fallback partial set: ${why}`);
    }
    if (!values['dry-run']) {
      const dependencyBefore=authorDependencyProvenance(root);
      receipt.dependencyProvenance={before:dependencyBefore,assurance:'metadata/tool precheck, not cached-test permission'};
      if(dependencyBefore.state!=='present')throw new Error(`installed dependency precheck unavailable: ${dependencyBefore.reason}; expensive validation not started`);
      const census = runStep('census-precheck', [join(root, 'scripts/census-precheck.mjs'), '--base', receipt.baseSha]);
      const censusTimeBound = censusTimeBoundOnly(census);
      const censusOk = (census.status === 0 || censusTimeBound) && !census.signal && !census.error;
      report('census-precheck', census, censusOk, censusTimeBound ? { notMeasured: 'time-bound' } : {});
      if (censusTimeBound) {
        receipt.censusNotMeasured = { reason: 'time-bound', checkedBy: 'CI' };
        console.log('census suites NOT MEASURED (time bound) — CI runs them');
      } else if (census.status === 2 || census.signal || census.error || census.status === null) {
        throw new Error('census precheck could not measure the author tree; expensive validation was not started');
      }
      if (censusOk) {
        const workflowInputs = authorWorkflowContractInputs(receipt.changedFiles);
        receipt.workflowContractPrecheck = { required: workflowInputs.length > 0, inputs: workflowInputs, suites: [] };
        if (workflowInputs.length > 0) {
          const suites = verifiedSuites(root, AUTHOR_WORKFLOW_CONTRACT_SUITES);
          receipt.workflowContractPrecheck.suites = suites;
          // This fixed, cheap contract runs before any heavy admission or capacity truncation.
          // R-50 walks all workflows, including new names with no literal reader hit.
          const judged = prepareJudgedRun();
          const command = lowPriorityCommand(process.execPath, judgedNodeTestArgs(['--test', '--test-reporter=tap',
            '--test-concurrency=1', '--import', 'tsx', '--import', './test/setup/tmp-hygiene.ts', ...suites], judged.args));
          const result = runStep('workflow-contract-precheck', command.args, command.file, judged.env, AUTHOR_WORKFLOW_CONTRACT_MAX_MS);
          const judge = closeJudgedRun(judged, suites, { status: result.status ?? 1, root,
            role: 'workflow-contract-precheck', prefix: 'preflight-author' });
          const ok = completeTestResult(result) && judge.verdict.complete;
          report('workflow-contract-precheck', result, ok, { inputs: workflowInputs, suites,
            priority: command.priority, runtimeBoundMs: AUTHOR_WORKFLOW_CONTRACT_MAX_MS,
            judge: { complete: judge.verdict.complete, given: judge.verdict.given,
              reported: judge.verdict.reported, unreported: judge.verdict.missing.slice(0, 20),
              lastStarted: judge.verdict.lastStarted, exitSite: judge.verdict.exitSite } });
          if (!ok) {
            receipt.affectedTestsNotRunReason = 'workflow-contract-precheck did not succeed; no heavy slot/static/test phase was started';
            throw new Error('changed workflow inputs failed the cache/timeout contracts; see workflow-contract-precheck');
          }
        }
        const docsInputs = authorDocsIndexInputs(receipt.changedFiles);
        receipt.docsIndexPrecheck = { required: docsInputs.length > 0, inputs: docsInputs };
        if (docsInputs.length > 0) {
          // Execute the SAME governed package commands as hosted docs-index-check,
          // before claiming a heavyweight slot. Never fix generated output inside a gate.
          for (const script of ['docs-index:check', 'docs-index:check-paths']) {
            const name = `docs-index-precheck:${script}`, result = runStep(name, ['run', '--silent', script], 'npm', {}, AUTHOR_DOCS_PRECHECK_MAX_MS);
            const ok = result.status === 0 && !result.signal && !result.error && result.outputComplete !== false;
            report(name, result, ok, { inputs: docsInputs, runtimeBoundMs: AUTHOR_DOCS_PRECHECK_MAX_MS });
            if (!ok) {
              receipt.affectedTestsNotRunReason = `${name} did not succeed; no heavy slot/static/test phase was started`;
              throw new Error(`changed docs inputs failed ${script}; regenerate/repair the index on a separate committed tree`);
            }
          }
        }
        // The cheap census runs first. W1-T9951: the suite ticket is taken NOW, so it holds its place in
        // line while the static stage runs on its own memory admission; suites are admitted after it.
        const queue = enqueueTestSlot(AUTHOR_SUITE_LABEL, { ...testSlot, perFileBytes: TEST_FILE_PEAK_BYTES, maxConcurrency: AUTHOR_SLOT_CEILING });
        receipt.suiteQueue = { ticketed: queue.ticketed, positionAtEnqueue: queue.position ?? null, note: queue.note };
        let slot;
        let staticEndedAt;
        const admitSuites = () => {
          const waitStartedAt = Date.now();
          slot = queue.admit();
          receipt.testSlot = { outcome: slot.outcome, concurrency: slot.concurrency, waitedMs: slot.waitedMs, note: slot.note };
          receipt.suiteQueue = { ...receipt.suiteQueue, outcome: 'admitted', waitedMs: Date.now() - (staticEndedAt ?? waitStartedAt) };
          if (!testSlotExecutionAllowed(slot)) throw new Error(`author preflight NOT_RUN (${slot.note})`);
        };
        const cancelSuites = (reason) => {
          if (receipt.suiteQueue.outcome) return;
          queue.cancel(reason);
          receipt.suiteQueue = { ...receipt.suiteQueue, outcome: 'cancelled', reason };
        };
        try {
          let runtimeProfile, runtimeManifest;
          const admitRuntime = (stage, staticReserveMs, files = receipt.suites,
            workers = Math.min(AUTHOR_MAX_WORKERS, slot?.concurrency ?? AUTHOR_SLOT_CEILING)) => {
            if (deadline === undefined) return;
            // Before static no slot is held yet; the suites are priced at the ceiling the slot is asked for.
            if (stage !== 'before-static' && !['acquired', 'inherited'].includes(slot?.outcome)) throw new Error('runtime admission requires a real slot; unslotted fallback is not deadline-fit capacity');
            runtimeProfile ??= readRuntimeProfile(root, values['runtime-profile'], runtimeBindings(root, receipt.headSha, authorEnvironment(process.env)));
            // An empty full-fallback partial set runs no suite: the profile is still validated, nothing is priced.
            if (files.length === 0) return;
            runtimeManifest ??= JSON.parse(readFileSync(join(root, 'scripts/test-tier-manifest.json'), 'utf8'));
            const decision = runtimeSelectionFit(files, runtimeManifest, runtimeProfile, {
              workers, deadline, ...(staticReserveMs === undefined ? {} : { staticReserveMs }),
            });
            receipt.runtimeAdmission = { stage, profile: relative(root, resolve(root, values['runtime-profile'])), ...decision };
            progress({ name: 'runtime-admission', stage, fits: decision.fits });
            if (!decision.fits) throw new Error(`runtime deadline does not fit admitted ${decision.workers}-worker pool: need ${decision.requiredMs}ms, have ${decision.availableMs}ms; expensive phase not started`);
          };
          admitRuntime('before-static', undefined, partial ? partial.suites : receipt.suites);
          const staticCapacity = admitHost('static-preflight', { selection: receipt.selection, workers: 1 });
          if (staticCapacity) (receipt.hostCapacity ??= []).push(staticCapacity);
          // Its record names a cold tsc's peak; the nested typecheck sees this ancestor's record and inherits it.
          const staticAdmission = admitStaticWork(AUTHOR_STATIC_LABEL, { ...testSlot, memoryBytes: TYPECHECK_COLD_PEAK_BYTES });
          receipt.staticAdmission = { outcome: staticAdmission.outcome, waitedMs: staticAdmission.waitedMs, note: staticAdmission.note };
          let staticOk = false;
          let lintOk = true;
          try {
            if (!staticAdmission.executionAllowed) throw new Error(`author static stage NOT_RUN (${staticAdmission.note})`);
            const staticCommand = lowPriorityCommand(process.execPath, ['--import', 'tsx',
              join(root, 'src/run-task.ts'), 'preflight', '--from', receipt.baseSha,
              '--summary-file', join(root, 'coverage/preflight-author-static.json')]);
            const staticResult = runStep('static-preflight', staticCommand.args, staticCommand.file, staticAdmission.childEnvironment ?? {}, AUTHOR_STEP_RUNTIME_MS);
            staticOk = staticResult.status === 0 && !staticResult.signal && !staticResult.error;
            report('static-preflight', staticResult, staticOk, { priority: staticCommand.priority });
            // An unsuccessful static gate already makes this tree unpublishable. Keep its failed
            // receipt and selected floor, but don't spend another full run on known-doomed tests.
            // W1-T7809: a plan-only selection is plan lint first; a failed lint is as unpublishable as a failed static gate.
            if (staticOk && receipt.selection === 'plan-only') {
              const lint = runStep('lint-plan-fast', ['--import', 'tsx', join(root, 'scripts/lint-plan-offline.mjs'),
                '--base', 'origin/main', '--merge-base'], process.execPath, staticAdmission.childEnvironment ?? {}, AUTHOR_STEP_RUNTIME_MS);
              lintOk = lint.status === 0 && !lint.signal && !lint.error;
              report('lint-plan-fast', lint, lintOk);
            }
          } finally {
            staticAdmission.release();
            staticEndedAt = Date.now();
          }
          if (staticOk && lintOk) {
            const dependencyAfterStatic=authorDependencyProvenance(root);
            receipt.dependencyProvenance.afterStatic=dependencyAfterStatic;
            if(!sameAuthorDependencyProvenance(dependencyBefore,dependencyAfterStatic))throw new Error('installed dependency donor changed during static validation; tests not started');
            // W1-T9951: a selection naming no suite leaves the line; one that names suites waits its turn here.
            if ((partial ? partial.suites : receipt.suites).length === 0) cancelSuites('the selection names no suite');
            else admitSuites();
            // W1-T7809: price the selection against what this host can carry NOW, before spending it.
            let manifest = { files: {} };
            try { manifest = JSON.parse(readFileSync(join(root, 'scripts/test-tier-manifest.json'), 'utf8')); }
            catch (error) { receipt.manifestUnavailable = error.message; }
            const legacyBudget = hostBudget((host ?? readHostCapacityInputs)(), { slotConcurrency: slot?.concurrency ?? AUTHOR_SLOT_CEILING });
            // A deadline without a validated native profile was refused before static work.
            // Never expand workers or restart the deadline to admit a larger selection.
            const nativeBudget = runtimeProfile ? deadlineHostBudget(legacyBudget, { deadline }) : legacyBudget;
            // W1-T9953: a full fallback is priced against the HOST, never the deadline; a deadline may only shrink it.
            const budget = partial && nativeBudget.budgetMs > legacyBudget.budgetMs ? legacyBudget : nativeBudget;
            const executionWorkers = runtimeProfile ? budget.workers : Math.min(AUTHOR_MAX_WORKERS, slot?.concurrency ?? AUTHOR_SLOT_CEILING);
            receipt.executionWorkers = executionWorkers;
            const priced = partial ? partial.suites : receipt.suites;
            reportManifestFallbacks(priced, manifest);
            const verdict = capacityVerdict(priced, manifest, budget);
            receipt.capacity = verdict;
            let ranSuites = receipt.suites;
            let notRun = false;
            let partialSentenceAfterRun;
            if (partial) {
              // Changed tests, then set-aside readers, then the modelled rest, each cheapest first, within the budget.
              const subset = fittingSubset(partial.suites, manifest, budget, { changed: partial.tiers.changed,
                narrow: partial.tiers.setAsideReaders, includeRest: true });
              receipt.selectedArm = 'full-fallback';
              receipt.selection = 'over-capacity';
              const sentence = partialSentence(subset.ran.length, receipt.suites.length, partial.setAside);
              receipt.partial = { reasons: receipt.reasons, setAside: partial.setAside, tiers: partial.tiers,
                planned: subset.ran, ran: [], leftToCi: receipt.suites.length, costMs: subset.costMs,
                ...(partial.unavailable ? { unavailable: partial.unavailable } : {}) };
              if (subset.ran.length === 0) {
                notRun = true;
                receipt.affectedTestsNotRunReason = sentence;
                console.log(`affected-tests: NOT RUN — ${sentence}`);
              } else {
                ranSuites = subset.ran;
                receipt.tiered = { planned: subset.ran, ran: [], skipped: subset.skipped, costMs: subset.costMs };
                partialSentenceAfterRun = sentence;
                console.log(`full-fallback: SELECTED ${subset.ran.length} of ${receipt.suites.length} suite(s); execution pending`);
              }
            } else if (!verdict.fits) {
              const subset = fittingSubset(receipt.suites, manifest, budget, { changed: receipt.changedFiles,
                narrow: narrow ?? [], includeRest: receipt.selection !== 'full-fallback' });
              receipt.selectedArm = receipt.selection;
              receipt.selection = 'over-capacity';
              const inputs = JSON.stringify(verdict.inputs);
              if (subset.ran.length === 0) {
                notRun = true;
                receipt.affectedTestsNotRunReason = `over capacity: priced ${verdict.costMs}ms of suite work exceeds the host budget ${verdict.budgetMs}ms`;
                console.log(`affected-tests: NOT RUN — CI is the check (priced ${verdict.costMs}ms for ${verdict.suites} suite(s) > budget ${verdict.budgetMs}ms over ${verdict.workers} worker(s); inputs ${inputs})`);
              } else {
                ranSuites = subset.ran;
                receipt.tiered = { planned: subset.ran, ran: [], skipped: subset.skipped, costMs: subset.costMs };
                console.log(`affected-tests: over capacity (priced ${verdict.costMs}ms > budget ${verdict.budgetMs}ms; inputs ${inputs}); selected ${subset.ran.length} suite(s) that fit; execution pending, leaving ${subset.skipped.length} to CI: ${subset.skipped.slice(0, 20).join(', ')}${subset.skipped.length > 20 ? ', …' : ''}`);
              }
            }
            if (!notRun && ranSuites.length === 0) {
              receipt.affectedTestsNotRunReason = 'the plan-only selection named no suite; plan lint is its check';
              console.log('affected-tests: NOT RUN — the plan-only selection named no suite; lint-plan-fast is the check');
            } else if (!notRun) {
            const testsName = receipt.tiered ? 'affected-tests-subset' : 'affected-tests';
            admitRuntime('before-tests', 0, ranSuites, executionWorkers);
            // An over-capacity subset is sized by the arm it was cut from: a narrow arm's subset is narrower still.
            const testCapacity = admitHost('affected-tests', { selection: receipt.selectedArm ?? receipt.selection, workers: executionWorkers });
            if (testCapacity) (receipt.hostCapacity ??= []).push(testCapacity);
            // No whole-suite retry or instrumentation. A missing target/summary is a refusal, never green.
            // The host-wide test slot, a load-derived concurrency (never above the old 4) and nice (test-slot.ts).
            slot.refresh();
            const hasDurationReporter = existsSync(join(root, 'scripts/test-duration-reporter.mjs'));
            const durationArgs = !hasDurationReporter ? [] : ['--test-reporter-destination=stdout',
              `--test-reporter=${join(root, 'scripts/test-duration-reporter.mjs')}`,
              `--test-reporter-destination=${join(diagnosticsRoot, 'durations.json')}`];
            // Judged (scripts/pure-test-pool.mjs): a suite whose own child exits 0 part-way is reported
            // `ok` with a whole summary, so the step passes only when every suite reached its own summary.
            const judged = prepareJudgedRun();
            const child = lowPriorityCommand(process.execPath, testRunArgv(judgedNodeTestArgs(['--test', '--test-reporter=tap', ...durationArgs,
              '--import', 'tsx', '--import', './test/setup/tmp-hygiene.ts', ...ranSuites], judged.args), executionWorkers));
            const tests = runStep(testsName, child.args, child.file, judged.env, AUTHOR_STEP_RUNTIME_MS, slot.heartbeat);
            if (receipt.tiered) receipt.tiered.ran = [...ranSuites];
            if (receipt.partial) {
              receipt.partial.ran = [...ranSuites];
              receipt.partial.leftToCi = receipt.suites.length - ranSuites.length;
            }
            if (partialSentenceAfterRun) console.log(partialSentenceAfterRun);
            const judge = closeJudgedRun(judged, ranSuites, { status: tests.status ?? 1, root, role: testsName, prefix: 'preflight-author' });
            const testsOk = completeTestResult(tests) && judge.verdict.complete;
            report(testsName, tests, testsOk, { judge: { complete: judge.verdict.complete, given: judge.verdict.given,
              reported: judge.verdict.reported, unreported: judge.verdict.missing.slice(0, 20), lastStarted: judge.verdict.lastStarted,
              exitSite: judge.verdict.exitSite } });
            receipt.runtimeEvidence = { state: 'not-collected', reason: 'duration reporter unavailable in this root' };
            if (hasDurationReporter) {
              if (!testsOk) receipt.runtimeEvidence = { state: 'incomplete', reason: 'affected-tests did not complete successfully' };
              else {
                try {
                  receipt.runtimeEvidence = closedDurationEvidence(root, relative(root, join(diagnosticsRoot, 'durations.json')),
                    ranSuites, runtimeBindings(root, receipt.headSha, authorEnvironment(process.env)));
                } catch (error) {
                  // Timing is diagnostic, never author assurance or a zero-cost success estimate.
                  receipt.runtimeEvidence = { state: 'unavailable', reason: error.message };
                }
              }
            }
            }
          } else {
            const gate = staticOk ? 'lint-plan-fast' : 'static-preflight';
            cancelSuites(`${gate} did not succeed`);
            receipt.affectedTestsNotRunReason = `${gate} did not succeed; see its native outcome`;
            console.log(`affected-tests: NOT RUN — ${gate} did not succeed; selected floor retained in the receipt`);
          }
        } finally {
          cancelSuites('the author stage ended before suite admission');
          slot?.release();
        }
      }
      if (git(['rev-parse', 'HEAD']).trim() !== receipt.headSha || git(['status', '--porcelain', '--untracked-files=normal']).trim()) {
        throw new Error('the author tree changed during verification; receipt refused');
      }
      const dependencyAfter=authorDependencyProvenance(root);
      receipt.dependencyProvenance.after=dependencyAfter;
      if(!sameAuthorDependencyProvenance(dependencyBefore,dependencyAfter))throw new Error('installed dependency donor changed during author validation; receipt refused');
    }
    // An over-capacity run is never green: its tests were skipped, or only the subset that fits ran.
    receipt.verdict = values['dry-run'] ? 'not-run' : !receipt.steps.every((step) => step.ok) ? 'failed'
      : receipt.selection === 'over-capacity' ? 'over-capacity' : 'passed';
  } catch (error) {
    receipt.verdict = error instanceof MacAuthorCapacityRefusal ? 'over-capacity' : 'refused';
    if (error instanceof MacAuthorCapacityRefusal) {
      (receipt.hostCapacity ??= []).push({stage: error.stage, ...error.admission});
      receipt.affectedTestsNotRunReason = error.message;
    }
    receipt.error = error.message;
    console.error(`author preflight ${error instanceof MacAuthorCapacityRefusal ? 'NOT_RUN' : 'REFUSED'}: ${error.message}`);
  }
  receipt.durationMs = Date.now() - startedAt;
  receipt.phaseAccounting = accountAuthorPhases(receipt);
  try {
    mkdirSync(join(root, 'coverage'), { recursive: true });
    if (diagnosticsRoot) {
      writeFileSync(join(diagnosticsRoot, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    }
    writeFileSync(join(root, 'coverage/preflight-author.json'), JSON.stringify(receipt, null, 2) + '\n');
    if (diagnosticsRoot) progress();
  } catch (error) {
    receipt.verdict = 'refused';
    receipt.error = `author receipt could not be written: ${error.message}`;
    console.error(receipt.error);
    if (diagnosticsRoot) {
      try { progress(); }
      catch (progressError) { console.error(`refused progress receipt unavailable: ${progressError.message}`); }
    }
    return 1;
  }
  console.log(`author verdict: ${receipt.verdict}; hosted full-suite/coverage remains REQUIRED, not proven by this run`);
  return ['passed', 'not-run'].includes(receipt.verdict) ? 0 : receipt.verdict === 'over-capacity' ? OVER_CAPACITY_EXIT : 1;
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--low-footprint')) {
    const {runLowFootprintAuthor} = await import('./lib/author-low-footprint.mjs');
    process.exitCode = await runLowFootprintAuthor(argv, {
      root: REPO_ROOT, publicationIdentity: authorPublicationIdentity, authorEnvironment, completeTestResult,
    });
  } else process.exitCode = guardedAuthorEntry(argv, {root: REPO_ROOT, runAuthor: (args, deps) => main(args, deps)});
}
