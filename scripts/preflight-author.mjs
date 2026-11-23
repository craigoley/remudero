#!/usr/bin/env node
// Author-time feedback, not a substitute for the required hosted full-suite/coverage verdict.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { affectedSelectionOrFull, buildAffectedSuitesGraph, changedSymbols, fullRunTrigger, isPlanOnlyDiff,
  planOnlySelectionOrFull, readAffectedSuitesInput, readPlanOnlyListing, symbollessSourceFiles } from '../src/lib/affected-suites.ts';
import { authorCiSplit, callerReachableSuites, readAuthorCiContract } from '../src/lib/ci-parity.ts';
import { authorTestRunnerArgs } from '../src/lib/test-run-timeout.ts';
import { admitStaticWork, enqueueTestSlot, lowPriorityCommand, memoryTestConcurrency, readHostLoad, readMemoryHeadroom,
  readVmStat, TEST_FILE_PEAK_BYTES, testRunArgv, testRunConcurrency, testSlotExecutionAllowed } from '../src/lib/test-slot.ts';
import { TYPECHECK_COLD_PEAK_BYTES } from '../src/lib/typecheck-buildinfo.ts';
import { configPath } from '../src/lib/config.ts';
import { appendLedger, deriveLedgerActor } from '../src/lib/ledger.ts';
import { ledgerPathFor } from '../src/lib/ledger-path.ts';
import { runBranchTaskId } from '../src/lib/remedy-effect.ts';
import { boundedNodeTestArgs, listTestFiles, manifestEntryFor, medianMeasuredDurationMs, mergeDurations, reportManifestFallbacks, weightedDurationMs } from './test-tier-manifest.mjs';
import { closeJudgedRun, judgedNodeTestArgs, prepareJudgedRun } from './pure-test-pool.mjs';
import { isMainModule, parseArgv } from './lib/argv.mjs';
import { REPO_ROOT } from './lib/repo-root.mjs';
import { captureStepSync, AUTHOR_OUTPUT_LIMIT_BYTES, AUTHOR_STEP_RUNTIME_MS } from './lib/author-step-capture.mjs';
import { AUTHOR_RUNTIME_SAFETY_FACTOR, AUTHOR_SHUTDOWN_RESERVE_MS, runtimeBindings, readRuntimeProfile, runtimeDeadlineFit, closedDurationEvidence } from './lib/native-author-runtime.mjs';
import { authorDependencyProvenance, reprimeOwnSeedMaterialization, sameAuthorDependencyProvenance } from './lib/author-dependency-provenance.mjs';
import { AUTHOR_CONTEXT_FORMAT, observeAuthorContext, requireAuthorContext } from './lib/author-context-compatibility.mjs';
import { homedir, tmpdir } from 'node:os';
import { accountAuthorPhases } from './lib/author-phase-accounting.mjs';
import { AUTHOR_WORKFLOW_CONTRACT_MAX_MS, AUTHOR_WORKFLOW_CONTRACT_SUITES, authorWorkflowContractInputs } from './lib/author-workflow-contract.mjs';
import { evaluateHeadIdentityGate } from './head-identity-gate.mjs';
import { guardedAuthorEntry, MacAuthorCapacityRefusal, macAuthorMemorySeams, macAuthorRefusalReport, readMacAuthorAdmission } from './lib/mac-author-admission.mjs';
import { readBoundedJsonFile } from './lib/coverage-disk-profile.mjs';
import { scanRepo as scanCoverageBlanking } from './coverage-session-blanking-check.mjs';
import { authorPushEligibility, failingTestsFromTap, preexistingReds, PUSH_STAGES } from './lib/author-push-eligibility.mjs';
export { authorPushEligibility, failingTestsFromTap, preexistingReds } from './lib/author-push-eligibility.mjs';

/** The exit status of a run whose selection the host cannot carry: distinct from pass (0) and fail (1). */
export const OVER_CAPACITY_EXIT = 3;
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

/** The test-slot readers' view of this host right now. On darwin the memory reading is the same
 *  vm_stat report test-slot admission reads (W1-T11891), so pre-admission sizing is never blind there. */
export function readHostCapacityInputs({ platform = process.platform, vmStat = readVmStat, load = readHostLoad,
  readFile = undefined } = {}) {
  const { cores, load1 } = load();
  return { cores, load1, headroomBytes: readMemoryHeadroom(readFile, { platform, vmStat }) };
}

const positiveInteger = (n) => Number.isSafeInteger(n) && n >= 1;

/**
 * W1-T7809 — what this host can carry, derived from the measured cores and load (testRunConcurrency),
 * the memory headroom (memoryTestConcurrency) and the author step runtime. There is no fixed suite count
 * and no fixed worker ceiling (W1-T11891): a larger host grants more workers, a smaller or busier one fewer.
 * `slotConcurrency` caps them further. Unmeasured memory is ONE worker, unless `slotAcquired` says the
 * slot's grant was measured at admission: only that real grant may stand in for the memory bound.
 */
export function hostBudget({ cores, load1, headroomBytes }, { stepRuntimeMs = AUTHOR_STEP_RUNTIME_MS,
  perFileBytes = TEST_FILE_PEAK_BYTES, slotConcurrency, slotAcquired = false } = {}) {
  const cpuWorkers = testRunConcurrency({ cores, load1 }, 1);
  const memoryWorkers = memoryTestConcurrency(headroomBytes, perFileBytes) ?? null;
  const slot = positiveInteger(slotConcurrency) ? slotConcurrency : null;
  const acquired = slotAcquired === true && slot !== null;
  const memoryBound = memoryWorkers ?? (acquired ? slot : 1);
  const bounds = [['cpu', cpuWorkers], ['memory', memoryBound], ['slot', slot ?? Infinity]];
  const workers = Math.max(1, Math.min(...bounds.map(([, n]) => n)));
  const boundBy = bounds.find(([, n]) => n === workers)?.[0] ?? 'cpu';
  const wallMs = Math.floor(stepRuntimeMs * AUTHOR_WALL_SHARE);
  return { workers, wallMs, budgetMs: workers * wallMs, wallShare: AUTHOR_WALL_SHARE,
    inputs: { cores, load1, headroomBytes: headroomBytes ?? null, perFileBytes, stepRuntimeMs,
      cpuWorkers, memoryWorkers, slotConcurrency: slotConcurrency ?? null, slotAcquired: acquired, boundBy,
      memoryBound: memoryWorkers !== null ? 'measured' : acquired ? 'acquired-slot-grant' : 'unmeasured-one-worker' } };
}

/** Why `budget`'s workers are outside its own measured bounds, or undefined (W1-T11891). `grant` is the
 *  slot now held: a budget priced against another grant is stale. */
function outsideMeasuredBounds(budget, grant) {
  const { cpuWorkers, memoryWorkers, slotConcurrency, slotAcquired } = budget.inputs ?? {};
  const workers = budget.workers;
  if (!positiveInteger(workers) || !positiveInteger(cpuWorkers) || typeof slotAcquired !== 'boolean' ||
      (memoryWorkers !== null && !positiveInteger(memoryWorkers)) ||
      (slotConcurrency !== null && !positiveInteger(slotConcurrency)) ||
      (slotAcquired && slotConcurrency === null)) return 'missing or malformed measured bound';
  if (slotAcquired && grant !== slotConcurrency) return 'stale slot grant';
  if (workers > cpuWorkers) return 'workers exceed the measured CPU bound';
  if (memoryWorkers !== null && workers > memoryWorkers) return 'workers exceed the measured memory bound';
  if (slotConcurrency !== null && workers > slotConcurrency) return 'workers exceed the slot grant';
  if (memoryWorkers === null && !slotAcquired && workers !== 1) return 'unmeasured memory admits one worker before a slot';
  return undefined;
}

/** A validated native-profile run may spend its fixed remaining deadline, not a second
 *  unrelated wall-share budget. This changes time only: CPU/memory/lease workers stay intact.
 *  The caller uses this only AFTER readRuntimeProfile has validated closed current-tree evidence. */
export function deadlineHostBudget(budget, { deadline, now = Date.now(), grant } = {}) {
  const outside = outsideMeasuredBounds(budget, grant);
  if (!Number.isFinite(deadline) || !Number.isFinite(now) || outside !== undefined ||
      !Number.isSafeInteger(budget.inputs?.stepRuntimeMs) || budget.inputs.stepRuntimeMs <= 0) {
    throw new Error(`deadline host budget: invalid fixed deadline or admitted capacity${outside ? ` (${outside})` : ''}`);
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

/** W1-T11940 — the line census-precheck prints when --skip-when-unread skips its full pass
 *  (CENSUS_FULL_PASS_SKIPPED_LABEL in scripts/census-precheck.mjs). */
export const CENSUS_FULL_PASS_SKIPPED_LINE = 'census-precheck: full pass SKIPPED (no census-read file changed) - ';

/** W1-T12511 — the author's census step runs the census COUNTS only: the census suites and the instrument-surface
 *  child are left to the required ci.yml jobs authorCiSplit names. When a job it names cannot be confirmed in
 *  ci.yml (`countsOnly` false), the step keeps the W1-T11940 full pass, skipped only when no census read changed. */
export function authorCensusPrecheckArgs(root, baseSha, countsOnly = true) {
  return [join(root, 'scripts/census-precheck.mjs'), '--base', baseSha, countsOnly ? '--counts-only' : '--skip-when-unread'];
}

/** The receipt line naming each check the author path left to CI, and the job and required check that run it. */
export function leftToCiLine(rows) {
  return `left to CI: ${rows.length === 0 ? 'nothing (no ci.yml job confirmed)' : rows.map((r) => `${r.job} (${r.ciJob} as ${r.ciCheck})`).join(', ')}`;
}

/** Whether the census step skipped its full pass, and the counts it relied on, read from its own stdout line. */
export function censusFullPassNote(result) {
  const line = String(result?.stdout ?? '').split('\n').find((l) => l.startsWith(CENSUS_FULL_PASS_SKIPPED_LINE));
  if (result?.status !== 0 || result.signal || result.error || line === undefined) return { skipped: false };
  return { skipped: true, reliedOn: line.slice(CENSUS_FULL_PASS_SKIPPED_LINE.length).trim() };
}

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

/** W1-T12842 — the ledger step each author run appends, one row per run, so the scout can count refusals and failures. */
export const AUTHOR_VERDICT_STEPS = Object.freeze({ passed: 'author_preflight.passed', failed: 'author_preflight.failed',
  refused: 'author_preflight.refused' });
/** The closed list a refused or NOT_RUN row's `refusal_class` comes from, so equal causes cluster. */
export const AUTHOR_REFUSAL_CLASSES = Object.freeze(['node-version', 'dependency-precheck', 'static-wait-bound',
  'test-slot-wait-bound', 'census-time-bound', 'lint-plan', 'affected-tests', 'disk-reserve', 'memory-pressure',
  'census-precheck', 'static-preflight', 'other']);
/** BACKSTOP: how long the row's child may take before it is killed. The verdict is printed before it starts. */
export const AUTHOR_VERDICT_WRITE_BOUND_MS = 30_000;
const AUTHOR_VERDICT_ROW_FLAG = '--append-author-verdict-row';
/** A refusal that names its class where it is raised; the message is the one the run always printed. */
const refusal = (refusalClass, message) => Object.assign(new Error(message), { refusalClass });

function capacityRefusalClass(reasons) {
  // A disk shortfall prevents admission even when pressure is also high.
  if (reasons.some((reason) => /^(?:workspaceFreeBytes|scratchFreeBytes|allocation:[^:]+):below-[^:]+-reserve$/.test(reason))) {
    return 'disk-reserve';
  }
  if (reasons.some((reason) => /^(?:pressure:(?:warning|critical|critical-or-unknown)|memory:below-measured-peak(?:-and-reserve)?|swap:below-measured-growth)$/.test(reason))) {
    return 'memory-pressure';
  }
  return 'other';
}

function staticFailureMetadata(path) {
  try {
    const summary = JSON.parse(readFileSync(path, 'utf8'));
    const failedCheck = Array.isArray(summary?.steps)
      ? summary.steps.find((step) => step?.ok === false && typeof step.name === 'string' && step.name)?.name : undefined;
    return failedCheck ? { failedCheck } : {};
  } catch (error) {
    return { failureNameUnavailable: error.message };
  }
}

/** The branch a run's row names: the declared publication target, else the checked-out branch; null when unreadable. */
export function authorHeadRef(root, declared, spawn = spawnSync) {
  if (typeof declared === 'string' && declared) return declared.replace(/^refs\/heads\//, '');
  const result = spawn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000,
    env: authorEnvironment(process.env) });
  const branch = result?.status === 0 && !result.error ? String(result.stdout ?? '').trim() : '';
  return branch && branch !== 'HEAD' ? branch : null;
}

/**
 * W1-T12842 — the one ledger row an author run appends, built from the receipt the run already computed.
 * A run that may push is `passed`, one that reached its end with a failed step is `failed`, every other is `refused`.
 * `first_step` is the first failed step, else the stage the run stopped before. Every refused row and every failed
 * row whose tests never ran carries a `refusal_class` from the failed gate, capacity reasons, or the refusal site.
 * `failed_check` names the failed gate's suite or check when the child recorded it. A dry run has no row.
 */
export function authorVerdictRow(receipt, { exitCode = null, headRef, refusalClass, refusalStage, capacityReasons, entryCapacity } = {}) {
  if (receipt.dryRun) return undefined;
  const steps = receipt.steps ?? [];
  const outcome = receipt.verdict === 'passed' || (receipt.verdict === 'over-capacity' && receipt.pushEligible === true) ? 'passed'
    : receipt.verdict === 'failed' ? 'failed' : 'refused';
  const ran = (name) => steps.some((step) => step.name === name || (name === 'affected-tests' && step.name === 'affected-tests-subset'));
  const failed = steps.find((step) => step.ok !== true);
  const censusTimeBound = steps.some((step) => step.name === 'census-precheck' && step.notMeasured === 'time-bound');
  const atSite = refusalClass !== undefined;
  const firstStep = outcome === 'passed' ? null : failed?.name ?? refusalStage ?? PUSH_STAGES.find((name) => !ran(name))
    ?? (atSite ? 'receipt' : censusTimeBound ? 'census-precheck' : 'affected-tests');
  const gateClass = ['census-precheck', 'static-preflight'].includes(failed?.name) ? failed.name : undefined;
  const reasons = Array.isArray(capacityReasons) ? capacityReasons.map(String) : [];
  const derivedClass = gateClass ?? (outcome === 'failed' ? (failed?.name === 'lint-plan-fast' ? 'lint-plan' : 'other')
    : reasons.length > 0 ? capacityRefusalClass(reasons)
      : atSite ? (AUTHOR_REFUSAL_CLASSES.includes(refusalClass) ? refusalClass : 'other')
        : ran('affected-tests') && censusTimeBound ? 'census-time-bound' : receipt.verdict === 'over-capacity' ? 'affected-tests' : 'other');
  const classed = outcome === 'refused' || (outcome === 'failed' && !ran('affected-tests'));
  const branch = typeof headRef === 'function' ? headRef() : headRef;
  const head = typeof branch === 'string' && branch ? branch : null;
  const waits = [receipt.staticAdmission?.waitedMs, Math.max(receipt.suiteQueue?.waitedMs ?? 0, receipt.testSlot?.waitedMs ?? 0)];
  // W1-T10926: each stage that waited out memory pressure, so a later run can derive its wait limit from these.
  const pressureWaits = [['entry', entryCapacity], ...(receipt.hostCapacity ?? []).map((row) => [row?.stage, row])]
    .filter(([stage, row]) => typeof stage === 'string' && Number.isFinite(row?.pressureWait?.waitedMs))
    .map(([stage, { pressureWait }]) => ({ stage, waited_ms: pressureWait.waitedMs, outcome: pressureWait.outcome,
      limit_ms: pressureWait.limitMs, limit_basis: pressureWait.limitBasis }));
  return {
    run_id: `author-preflight-${Date.parse(receipt.startedAt) || 0}`,
    task_id: (head && runBranchTaskId(head)?.taskId) || 'CLI',
    step: AUTHOR_VERDICT_STEPS[outcome],
    verdict: receipt.verdict ?? null, exit_code: exitCode, push_eligible: receipt.pushEligible === true,
    head_ref: head, head_sha: receipt.headSha ?? null, first_step: firstStep,
    ...(classed ? { refusal_class: derivedClass } : {}),
    ...(classed && gateClass && failed.failedCheck ? { failed_check: failed.failedCheck } : {}),
    ...(reasons.length > 0 ? { capacity_reasons: reasons } : {}),
    ...(receipt.failureAttribution?.counts ? { failing_at_head: receipt.failureAttribution.counts.failingAtHead,
      failing_also_at_base: receipt.failureAttribution.counts.alsoFailingAtBase,
      failing_only_at_head: receipt.failureAttribution.counts.failingOnlyAtHead,
      failing_unattributed: receipt.failureAttribution.counts.unattributed,
      ...(Array.isArray(receipt.failureAttribution.tests) ? { preexisting_reds: preexistingReds(receipt) } : {}) } : {}),
    wall_ms: receipt.durationMs ?? null,
    admission_wait_ms: waits.reduce((sum, ms) => sum + (Number.isFinite(ms) && ms > 0 ? ms : 0), 0),
    ...(pressureWaits.length > 0 ? { pressure_waits: pressureWaits } : {}),
    selection: receipt.selectedArm ?? receipt.selection ?? null,
  };
}

/** Where this session's ledger root is configured: the instance config's `root`, as `rmd` resolves it. A test-runner
 *  process and a session with no instance config have none; nothing is created to find out. */
export function configuredAuthorLedger({ testRunner = Boolean(process.env.NODE_TEST_CONTEXT), configFile = configPath() } = {}) {
  if (testRunner) return { reason: 'a test-runner process has no configured ledger' };
  let config;
  try { config = JSON.parse(readFileSync(configFile, 'utf8')); }
  catch (error) {
    return { reason: error.code === 'ENOENT' ? `no instance config at ${configFile}` : `instance config unreadable: ${error.code ?? error.message}` };
  }
  const root = typeof config?.root === 'string' && config.root ? config.root : join(homedir(), 'Remudero');
  return isAbsolute(root) ? { root } : { reason: `instance config root is not an absolute path: ${root}` };
}

/** One row through the repo's ledger writer, into a `state/` that already exists: a missing state mount is never
 *  created. `tty` is the author's own terminal reading, which a child with piped stdin cannot take. */
export function appendAuthorVerdictRow({ root, line, tty } = {}, { append = appendLedger, clock } = {}) {
  if (!Object.values(AUTHOR_VERDICT_STEPS).includes(line?.step)) return { written: false, reason: 'not an author verdict row' };
  const path = ledgerPathFor({ root });
  let state;
  try { state = statSync(dirname(path)); }
  catch (error) { return { written: false, reason: `no state directory at ${dirname(path)} (${error.code ?? error.message})` }; }
  if (!state.isDirectory()) return { written: false, reason: `no state directory at ${dirname(path)}` };
  // The ceiling keeps this writer from ever starting a rotation: its bounded child may be killed part-way.
  append(path, line, { ceilingBytes: Number.MAX_SAFE_INTEGER, actor: () => deriveLedgerActor(process.env, tty === true),
    ...(clock ? { clock } : {}) });
  return { written: true, path };
}

/** The bounded child's whole run: one row read from `input`, one JSON result line on stdout. */
export function runAuthorVerdictRowChild(input) {
  let result;
  try { result = appendAuthorVerdictRow(JSON.parse(input)); }
  catch (error) { result = { written: false, reason: error?.message ?? String(error) }; }
  console.log(JSON.stringify(result));
  return 0;
}

/** The append, run in a child so it can be bounded: a ledger on a hung mount must never hang the preflight. */
export function appendAuthorVerdictRowBounded(line, root, { boundMs = AUTHOR_VERDICT_WRITE_BOUND_MS, spawn = spawnSync } = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), AUTHOR_VERDICT_ROW_FLAG], {
    cwd: REPO_ROOT, encoding: 'utf8', input: JSON.stringify({ root, line, tty: process.stdin.isTTY === true }),
    timeout: boundMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  if (child.error?.code === 'ETIMEDOUT') return { written: false, reason: `the write did not finish within ${boundMs} ms` };
  if (child.error || child.signal || child.status !== 0) {
    return { written: false, reason: `the ledger writer ended ${child.signal ?? child.status}: ${String(child.error?.message ?? child.stderr ?? '').trim().slice(-300)}` };
  }
  return JSON.parse(child.stdout.trim().split('\n').at(-1));
}

/**
 * W1-T12842 — append this run's row to the configured ledger.
 * INVARIANT the-verdict-never-depends-on-the-ledger: nothing here is thrown, and the result is never read by the
 * verdict. A ledger that is missing, unwritable or slow costs one stderr line saying the row was not written.
 */
export function recordAuthorVerdict(receipt, { ledger = configuredAuthorLedger, append = appendAuthorVerdictRowBounded,
  log = (line) => console.error(line), boundMs = AUTHOR_VERDICT_WRITE_BOUND_MS, ...context } = {}) {
  const notWritten = (reason) => ({ written: false, reason });
  if (receipt.dryRun) return notWritten('a dry run is read-only and appends nothing');
  let result;
  try {
    const target = ledger();
    const row = typeof target?.root === 'string' ? authorVerdictRow(receipt, context) : undefined;
    result = row ? append(row, target.root, { boundMs }) : notWritten(target?.reason ?? 'no ledger root is configured');
    if (result?.written !== true) result = notWritten(result?.reason ?? 'the writer gave no result');
    else log(`author preflight: verdict row ${row.step} written to ${result.path}`);
  } catch (error) {
    result = notWritten(error?.message ?? String(error));
  }
  if (!result.written) log(`author preflight: verdict row NOT written to the ledger (${result.reason}); the verdict and exit code are unaffected`);
  return result;
}

/** The one exit of an author run: print the verdict, fix the exit code, and only then try the ledger row. */
export function concludeAuthorRun(receipt, { announce = true, ...context } = {}) {
  if (announce) {
    console.log(`author verdict: ${receipt.verdict}; hosted full-suite/coverage remains REQUIRED, not proven by this run`);
    console.log(`author push-eligible: ${receipt.pushEligible}; ${receipt.pushEligibleReason}`);
  }
  const exitCode = ['passed', 'not-run'].includes(receipt.verdict) ? 0 : receipt.verdict === 'over-capacity' ? OVER_CAPACITY_EXIT : 1;
  recordAuthorVerdict(receipt, { ...context, exitCode });
  return exitCode;
}

/** W1-T10926 — this host's earlier memory-pressure waits for `stage` (ms), from the rows its author runs appended.
 *  No configured ledger, or one that cannot be read, is no history: the wait limit then falls back to its sampling rule. */
export function authorPressureWaitHistory(stage, { ledger = configuredAuthorLedger, read = (path) => readFileSync(path, 'utf8'),
  log = (line) => console.error(line) } = {}) {
  const target = (ledger ?? configuredAuthorLedger)();
  if (typeof target?.root !== 'string') return [];
  let text;
  try { text = read(ledgerPathFor({ root: target.root })); }
  catch (error) {
    log(`author preflight: no pressure-wait history read (${error.code ?? error.message}); the ${stage} wait limit uses its sampling rule`);
    return [];
  }
  const waits = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"pressure_waits"')) continue;
    let row;
    try { row = JSON.parse(line); }
    catch { continue; } // A torn line names no wait; only whole rows are history.
    for (const wait of Array.isArray(row?.pressure_waits) ? row.pressure_waits : []) {
      if (wait?.stage === stage && Number.isFinite(wait.waited_ms) && wait.waited_ms >= 0) waits.push(wait.waited_ms);
    }
  }
  return waits;
}

/** The script's entry. A capacity refusal at entry never reaches `main`, so its row is appended here. */
export function runGuardedAuthor(argv, { root = REPO_ROOT, runAuthor = main, readAdmission = readMacAuthorAdmission,
  verdictLedger = {}, memory = readAdmission === readMacAuthorAdmission
    ? macAuthorMemorySeams({ pastWaits: (stage) => authorPressureWaitHistory(stage, { ledger: verdictLedger.ledger }) }) : null } = {}) {
  const startedAt = Date.now();
  let reached = false, admission, entryCapacity;
  const exitCode = guardedAuthorEntry(argv, { root, readAdmission: (...args) => (admission = readAdmission(...args)), memory,
    recordEntry: (settled) => { entryCapacity = settled; },
    runAuthor: (args, deps) => { reached = true; return runAuthor(args, { ...deps, verdictLedger: { ...verdictLedger, entryCapacity } }); } });
  if (!reached) {
    const declared = argv.find((arg) => arg.startsWith('--head-ref='))?.slice('--head-ref='.length)
      ?? (argv.includes('--head-ref') ? argv[argv.indexOf('--head-ref') + 1] : undefined);
    recordAuthorVerdict({ verdict: 'over-capacity', pushEligible: false, dryRun: false, steps: [],
      startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt },
    { ...verdictLedger, exitCode, refusalClass: 'other', refusalStage: 'entry', capacityReasons: (entryCapacity ?? admission)?.reasons, entryCapacity,
      headRef: () => authorHeadRef(root, declared) });
  }
  return exitCode;
}

/** W1-T12166 — the inputs every stage result depends on. The head names the tree, the rules and this script. */
export function authorStageReuseKey(receipt) {
  return { headSha: receipt.headSha ?? null, baseSha: receipt.baseSha ?? null, node: receipt.node ?? null,
    dependency: receipt.dependencyProvenance?.before ?? null,
    selection: receipt.selectedArm ?? receipt.selection ?? null, suites: receipt.suites ?? null };
}

/** Whether one stage of the last receipt passed and was measured. A test stage counts only when every
 *  selected suite ran and passed: an over-capacity subset is never reused. */
function stagePassedAndMeasured(step, previous) {
  if (step.ok !== true || step.notMeasured || step.exitCode !== 0 || step.signal || step.error ||
      step.diagnostics?.mayBeIncomplete !== false) return false;
  if (!step.name.startsWith('affected-tests')) return true;
  const summary = step.testSummary;
  return step.name === 'affected-tests' && previous.tiered === undefined && previous.partial === undefined &&
    Array.isArray(previous.suites) && previous.suites.length > 0 && step.judge?.complete === true &&
    summary?.pass > 0 && summary.fail === 0 && summary.cancelled === 0;
}

/** A stage failure or admission refusal does not invalidate the stages measured before it. */
function stoppedAtStageOrAdmission(previous) {
  const steps = previous.steps;
  if (typeof previous.error !== 'string' || !Array.isArray(steps) || steps.length === 0) return false;
  if (previous.verdict === 'over-capacity') {
    const capacity = previous.hostCapacity?.at(-1);
    return capacity?.state === 'not-run' && typeof capacity.stage === 'string' &&
      previous.error.startsWith(`Mac author capacity NOT_RUN before ${capacity.stage}: `);
  }
  if (previous.verdict !== 'refused') return false;
  if (steps.at(-1)?.ok === false) return true;
  const staticNote = previous.staticAdmission?.note;
  if (previous.staticAdmission?.outcome === 'slot' && typeof staticNote === 'string' &&
      previous.error === `author static stage NOT_RUN (${staticNote})`) return true;
  const slotNote = previous.testSlot?.note;
  return previous.error === `author preflight NOT_RUN (${slotNote})` && typeof slotNote === 'string' &&
    slotNote.startsWith('NOT_RUN:');
}

/**
 * W1-T12166 — the stages of the last receipt of this checkout that a new run need not run again.
 * OBSERVED 2026-11-10..13: 11 Azure preflights failed only on suites that pass alone, and each second run
 * repeated 15 to 20 minutes of census and static work on the same commit.
 * RULE: reuse only when the last run completed or stopped at a failed stage or admission, its dependency record
 * did not change while it ran, and the head, base, Node version, dependency record and selection are all the
 * same. Reuse the stages in their order and stop at the first one that failed, did not run or was not measured:
 * every later stage runs.
 */
export function reusableAuthorStages(previous, current) {
  const none = (reason) => ({ state: 'none', reason, stages: [] });
  if (!previous || previous.unreadable) return none(`no readable last receipt (${previous?.unreadable ?? 'absent'})`);
  if (typeof previous.startedAt !== 'string') return none('the last receipt names no run start time');
  const stageRefusal = stoppedAtStageOrAdmission(previous);
  if (previous.dryRun !== false || (previous.error !== undefined && !stageRefusal) ||
      (!['passed', 'failed', 'over-capacity'].includes(previous.verdict) && !stageRefusal)) {
    return none(`the last run ended ${previous.verdict ?? 'running'}${previous.error ? `: ${previous.error}` : ''}`);
  }
  const record = previous.dependencyProvenance;
  if (!sameAuthorDependencyProvenance(record?.before, record?.after)) return none('the last run has no unchanged dependency record');
  const before = authorStageReuseKey(previous), now = authorStageReuseKey(current);
  const differs = Object.keys(now).find((field) => now[field] === null || JSON.stringify(before[field]) !== JSON.stringify(now[field]));
  if (differs) return none(`${differs} differs from the last run`);
  const stages = [];
  for (const step of previous.steps ?? []) {
    if (!stagePassedAndMeasured(step, previous)) break;
    stages.push(step);
  }
  return { state: stages.length ? 'reused' : 'none', reason: stages.length ? `same head, base, node, dependency and selection as the run of ${previous.startedAt}`
    : 'the first stage of the last run did not pass or was not measured', runStartedAt: previous.startedAt, stages };
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

/** W1-T10947: an unreadable profile is an UNKNOWN one (its reason kept), never an absent or a bounded one. */
export function readAuthorProfile(root, path) {
  try { return readBoundedJsonFile(resolve(root, path)); }
  catch (error) { return { unreadable: String(error.code ?? error.message) }; }
}

/** The time `files` took at the head: their own durations when all are recorded, else the whole stage's. */
export function headFilesMs(durations, files, stageMs) {
  const own = files.map((file) => durations?.files?.[file]);
  return own.length > 0 && own.every((ms) => Number.isFinite(ms) && ms >= 0) ? own.reduce((sum, ms) => sum + ms, 0) : stageMs;
}

const ATTRIBUTION_LABELS = Object.freeze({ 'also-red': 'also red at the base on this host', 'only-head': 'red only at the head' });
const ATTRIBUTION_PRINT_MAX = 200;

function linkAttributionDependencies(dir, tmpRoot, nodeModules, mergeBase, probe) {
  const destination = join(dir, 'node_modules');
  try {
    symlinkSync(nodeModules, destination, 'dir');
    return;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const tracked = probe(['ls-tree', '--name-only', mergeBase, '--', 'node_modules']);
  if (tracked?.status !== 0 || typeof tracked.stdout !== 'string' || tracked.stdout.trim() !== '') {
    throw new Error('the base dependency destination is tracked or could not be checked');
  }
  const entry = lstatSync(destination);
  if (entry.isSymbolicLink() && realpathSync(destination) === realpathSync(nodeModules)) return;
  if (!entry.isDirectory()) throw new Error('the base dependency destination is not the author donor or a checkout directory');
  // A post-checkout hook can prime this new worktree. Keep those dependencies in the
  // same private scratch root until its ordinary cleanup, and run with the head donor.
  renameSync(destination, join(tmpRoot, 'checkout-node-modules'));
  symlinkSync(nodeModules, destination, 'dir');
}

/**
 * W1-T13215 — say which of the head's failing tests the change caused, by running only their files again at the merge
 * base in a scratch worktree that is removed whatever happens. INVARIANT a-failure-the-change-caused-is-never-pre-existing:
 * `also-red` needs a COMPLETED base run of the same file that reported that title failing; a test that passes at the
 * base, and one in a file the base does not hold, are `only-head`; every other doubt (no merge base, a different
 * lockfile, no worktree, a run cut short, no summary, a failure the output does not name) is `unattributed` with its
 * reason. Nothing here reads or sets the verdict. `git(args)` and `runBase({ file, args, cwd, boundMs })` are the seams.
 */
export function attributeFailures({ root, baseSha, headSha, failing, unnamed = 0, headMs, ceilingMs = AUTHOR_STEP_RUNTIME_MS,
  git, runBase, runnerArgs, tmp = tmpdir, nodeModules = join(root, 'node_modules') }) {
  const tests = failing.map((test) => ({ file: test.file, title: test.title }));
  const open = () => tests.filter((test) => test.state === undefined);
  const mark = (list, state, reason) => { for (const test of list) Object.assign(test, { state, reason }); };
  const settle = (cleanup = { removed: true }, base = {}) => {
    const count = (state) => tests.filter((test) => test.state === state).length + (state === 'unattributed' ? unnamed : 0);
    return { tests, unnamed, base, cleanup, counts: { failingAtHead: tests.length + unnamed, alsoFailingAtBase: count('also-red'),
      failingOnlyAtHead: count('only-head'), unattributed: count('unattributed') } };
  };
  const probe = (args) => { const result = git(args); return result?.error || result?.signal ? undefined : result; };
  mark(open().filter((test) => test.file === null), 'unattributed', 'the failing test names no file in this checkout');
  const mergeBase = open().length === 0 ? undefined : probe(['merge-base', baseSha, headSha]);
  const mb = String(mergeBase?.stdout ?? '').trim();
  if (open().length > 0 && (mergeBase?.status !== 0 || !mb)) {
    mark(open(), 'unattributed', 'the merge base of the head and origin/main could not be read');
    return settle();
  }
  for (const file of new Set(open().map((test) => test.file))) {
    const held = probe(['cat-file', '-e', `${mb}:${file}`]);
    if (held === undefined) mark(open().filter((test) => test.file === file), 'unattributed', 'the merge base could not be searched for this file');
    else if (held.status !== 0) mark(open().filter((test) => test.file === file), 'only-head', 'the file is not in the merge base');
  }
  if (open().length === 0) return settle();
  const lock = probe(['diff', '--quiet', mb, headSha, '--', 'package-lock.json']);
  if (lock?.status !== 0) {
    mark(open(), 'unattributed', lock?.status === 1 ? 'package-lock.json differs between the merge base and the head, so the head\'s dependencies are not the base\'s'
      : 'the lockfile of the merge base and the head could not be compared');
    return settle();
  }
  const files = [...new Set(open().map((test) => test.file))];
  const boundMs = Math.ceil(Math.min(ceilingMs, Number.isFinite(headMs) && headMs > 0 ? headMs : ceilingMs));
  let tmpRoot, dir, added = false, base = { mergeBase: mb, boundMs, files };
  try {
    tmpRoot = mkdtempSync(join(tmp(), 'rmd-author-base-'));
    dir = join(tmpRoot, 'base');
    const add = probe(['worktree', 'add', '--detach', dir, mb]);
    added = add?.status === 0;
    if (!added) mark(open(), 'unattributed', `the scratch worktree could not be created: ${String(add?.stderr ?? 'git did not run').trim().slice(0, 200)}`);
    else {
      linkAttributionDependencies(dir, tmpRoot, nodeModules, mb, probe);
      const command = lowPriorityCommand(process.execPath, runnerArgs(files, dir));
      const result = runBase({ file: command.file, args: command.args, cwd: dir, boundMs }) ?? {};
      const summary = testSummary(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
      if (result.error || result.signal || result.status === null || result.status === undefined || result.outputComplete === false) {
        const cause = result.signal ?? result.error?.code ?? result.error?.message ?? 'no exit status';
        mark(open(), 'unattributed', `the base run was cut short (${cause}) at its bound of ${boundMs}ms`);
      } else if (summary === null) mark(open(), 'unattributed', 'the base run reported no test summary');
      else {
        const named = failingTestsFromTap(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, dir);
        base = { ...base, summary };
        for (const test of open()) {
          const here = named.filter((other) => other.file === test.file);
          if (here.some((other) => other.title === test.title)) mark([test], 'also-red', 'reported failing in a completed base run of the same file');
          else if (here.some((other) => other.fileLevel)) mark([test], 'unattributed', 'the file failed as a whole at the base');
          else if (named.length < summary.fail) mark([test], 'unattributed', 'the base run failed tests its output does not name');
          else mark([test], 'only-head', 'not failing in a completed base run of the same file');
        }
      }
    }
  } catch (error) {
    mark(open(), 'unattributed', `the base run could not be set up: ${error?.message ?? error}`);
  }
  let cleanup = { removed: true };
  if (added) {
    const removal = probe(['worktree', 'remove', '--force', dir]);
    if (removal?.status !== 0) cleanup = { removed: false, reason: String(removal?.stderr ?? 'git did not run').trim().slice(0, 200) };
  }
  if (tmpRoot) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); }
    catch (error) { cleanup = { removed: false, reason: cleanup.reason ?? error.message }; }
    if (cleanup.removed && existsSync(tmpRoot)) cleanup = { removed: false, reason: 'the scratch directory is still present' };
  }
  if (!cleanup.removed && added) probe(['worktree', 'prune']);
  return settle({ ...cleanup, ...(tmpRoot ? { path: tmpRoot } : {}) }, base);
}

/** The lines an author run prints for an attribution: one per failing test, then the four counts. */
export function attributionLines(result) {
  const shown = result.tests.slice(0, ATTRIBUTION_PRINT_MAX).map((test) => `author attribution: ${test.file ?? '(no file)'} :: ${test.title}: ${
    ATTRIBUTION_LABELS[test.state] ?? `unattributed: ${test.reason}`}`);
  const { counts } = result;
  return [...shown, ...(result.tests.length > shown.length ? [`author attribution: ${result.tests.length - shown.length} more failing test(s) are in the receipt`] : []),
    ...(result.unnamed > 0 ? [`author attribution: ${result.unnamed} failing test(s) the output does not name: unattributed`] : []),
    ...(result.cleanup.removed ? [] : [`author attribution: scratch worktree ${result.cleanup.path ?? ''} was NOT removed (${result.cleanup.reason}); remove it by hand`]),
    `author attribution: failing at the head ${counts.failingAtHead}; also failing at the base ${counts.alsoFailingAtBase}; failing only at the head ${
      counts.failingOnlyAtHead}; unattributed ${counts.unattributed}`];
}

/**
 * W1-T13736 — whether a run on a Node other than the .nvmrc pin re-runs itself under an installed pin. Candidates, in
 * order: ~/.local/opt/node-v<pin>, its nodejs.org archive form node-v<pin>-<platform>-<arch>, then nvm's
 * versions/node/v<pin>; the first that exists and whose own --version reads v<pin> is chosen. INVARIANT
 * never-another-node: nothing here downloads or installs a Node, a candidate reading another version is never chosen,
 * and when this process already is the chosen install (the re-run child) it refuses, so the re-run happens at most once.
 */
export function pinnedNodeReexec({ pin, current, env = process.env, home = homedir(), platform = process.platform,
  arch = process.arch, execPath = process.execPath, exists = existsSync, spawn = spawnSync,
  versionOf = (path) => spawn(path, ['--version'], { encoding: 'utf8' }).stdout?.trim(), realpath = realpathSync }) {
  const nvmDir = env.NVM_DIR || join(home, '.nvm');
  const candidates = [join(home, '.local/opt', `node-v${pin}`, 'bin/node'),
    join(home, '.local/opt', `node-v${pin}-${platform}-${arch}`, 'bin/node'), join(nvmDir, 'versions/node', `v${pin}`, 'bin/node')];
  const file = `node-v${pin}-${platform}-${arch}.tar.gz`, dist = `https://nodejs.org/dist/v${pin}`;
  const sum = { darwin: 'shasum -a 256 -c -', linux: 'sha256sum -c -' }[platform];
  const install = env.NVM_DIR || exists(join(home, '.nvm', 'nvm.sh'))
    ? `nvm install ${pin} (nvm checks the download against the release's SHASUMS256.txt)`
    : sum ? `cd "$(mktemp -d)" && curl -fsSLO ${dist}/${file} && curl -fsSLO ${dist}/SHASUMS256.txt && ` +
      `grep ' ${file}$' SHASUMS256.txt | ${sum} && mkdir -p "$HOME/.local/opt" && tar -xzf ${file} -C "$HOME/.local/opt"`
      : `the nodejs.org release for ${platform}-${arch} from ${dist}/ checked against its SHASUMS256.txt`;
  // W1-T13720: name the remedy. On the fleet host the units converge installs the pin and raises
  // host-node-behind while it cannot; a bare version pair sent every lane to guess.
  const remedy = `On the fleet host the units converge (deploy/install-host-units.sh --install) installs the .nvmrc pin and raises the ` +
    `host-node-behind alert while it cannot; read its host-node: journal lines. Elsewhere, install Node ${pin}: ${install}; ` +
    `the author preflight then re-runs itself under it`;
  const prefix = `Node ${pin} required; got ${current}. `;
  const misread = [];
  for (const path of candidates) {
    if (!exists(path)) continue;
    const read = versionOf(path);
    if (read !== `v${pin}`) { misread.push(`${path} reads ${read || 'no version'}`); continue; }
    if (realpath(path) === realpath(execPath)) {
      return { candidates, refuse: `${prefix}This Node (${execPath}) is the install at ${path}, whose --version reads v${pin}; ` +
        `it is not re-run again. ${remedy}` };
    }
    return { candidates, reexec: path };
  }
  return { candidates, refuse: prefix + (misread.length ? `Not run: ${misread.join('; ')}. ` : '') + remedy };
}

/**
 * W1-T13774 — the npm CLI of the Node running this script, so a step's `npm run` and the package script's own
 * `node` both run on it. MEASURED 2026-11-18 on the operator Mac: with PATH unchanged, the pinned Node running the
 * pinned npm-cli.js still ran the script's `node` from PATH (another version), so the step also puts `binDir` first
 * on its child's PATH. The install is the directory above the bin directory, as nodejs.org archives, nvm and
 * Homebrew lay it out. An install without the CLI is refused, naming the path looked for; npm from PATH is never
 * the fallback, since it may belong to another Node.
 */
export function npmUnderRunningNode({ execPath = process.execPath, exists = existsSync } = {}) {
  const binDir = dirname(execPath), install = dirname(binDir);
  const cli = join(install, 'lib/node_modules/npm/bin/npm-cli.js');
  if (!exists(cli)) {
    return { refuse: `the running Node (${execPath}) has no npm CLI at ${cli}; reinstall the Node at ${install} from a release ` +
      `that carries lib/node_modules/npm (the nodejs.org archive and an nvm install both do), then re-run the author preflight. ` +
      `npm from PATH is not run: it may belong to another Node` };
  }
  return { file: execPath, args: [cli], binDir };
}

export function main(argv, { root = REPO_ROOT, spawn = spawnSync,
  select = (changed, range) => authorSelection(root, changed, range), host, admitHost = () => undefined,
  testSlot = {}, enqueueTestSlot: enqueueSuiteSlot = enqueueTestSlot, verdictLedger = {}, pinnedNode: pinnedNodeLocation = {}, npmCli: npmCliLocation = {} } = {}) {
  const { values, helpRequested } = parseArgv(argv, {
    'dry-run': { type: 'boolean' },
    deadline: { type: 'string' },
    'runtime-profile': { type: 'string' },
    'author-profile': { type: 'string' },
    'head-ref': { type: 'string' },
    'head-sha': { type: 'string' },
  }, { allowPositionals: false, helpText: 'preflight-author.mjs [--dry-run] [--head-ref <publication destination branch> [--head-sha <committed HEAD sha>]] [--deadline <ISO> --runtime-profile <path>] [--author-profile <bounded profile JSON>]: fresh-base affected tests + default static preflight; unknown publication target is NOT identity assurance; full hosted CI remains required.' });
  if (helpRequested) return 0;
  const startedAt = Date.now();
  const receipt = { version: 1, assurance: 'author-only', hostedFullSuiteAndCoverage: 'required-pending',
    startedAt: new Date(startedAt).toISOString(), node: process.version, dryRun: Boolean(values['dry-run']), steps: [], suites: [] };
  // W1-T12166: the last receipt of this checkout, read before this run replaces it.
  let previous;
  try { previous = JSON.parse(readFileSync(join(root, 'coverage/preflight-author.json'), 'utf8')); }
  catch (error) { previous = { unreadable: String(error.code ?? error.message) }; }
  let reusable = [];
  let diagnosticsRoot;
  // W1-T12842: the class and stage the refusal site named, when the run ends at one.
  let refusedAt = {};
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
  const runStep = (name, args, file = process.execPath, childEnvironment = {}, phaseMaxMs = AUTHOR_STEP_RUNTIME_MS, heartbeat = undefined, cwd = root) => {
    const runtimeLimitMs = deadline === undefined ? phaseMaxMs :
      Math.min(phaseMaxMs, Math.max(1, deadline - Date.now() - AUTHOR_SHUTDOWN_RESERVE_MS));
    progress({ name, outputLimitBytes: AUTHOR_OUTPUT_LIMIT_BYTES, runtimeLimitMs });
    const logs = { stdoutPath: join(diagnosticsRoot, `${name}.stdout.log`),
      stderrPath: join(diagnosticsRoot, `${name}.stderr.log`) };
    // Injected spawn outcomes remain an explicit diagnostic seam; production owns live pipes.
    if (spawn !== spawnSync) return run(file, args, { cwd, env: { ...authorEnvironment(process.env), ...childEnvironment } });
    const resultPath = join(diagnosticsRoot, `${name}.native-result.json`);
    // W1-T9928: a slotted step's spooler beats the slot while this loop is blocked in spawnSync.
    const result = captureStepSync(file, args, { cwd, env: { ...authorEnvironment(process.env), ...childEnvironment }, trackParent: true,
      ...logs, resultPath, runtimeMs: runtimeLimitMs, ...(heartbeat ? { heartbeat } : {}) });
    // A group that is not proven closed keeps its owner's slot: the finalizers below consult this list.
    if (!result.groupClosed) (receipt.unclosedGroups ??= []).push(name);
    return { ...result, capturedLogs: true, nativeResult: relative(root, resultPath) };
  };
  /** Free a slot or admission only once every native group run under this author is proven closed. */
  const releaseWhenClosed = (holder, what) => {
    if (receipt.unclosedGroups?.length) {
      receipt.slotRetained = { holder: what, unclosedGroups: [...receipt.unclosedGroups] };
      return;
    }
    holder?.release();
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
  /** W1-T12166: take the next reusable stage when it is `name`; any other stage ends reuse for this run. */
  const reuseStage = (name) => {
    if (reusable[0]?.name !== name) {
      reusable = [];
      return undefined;
    }
    const prior = reusable.shift();
    const reused = prior.reused ?? { runStartedAt: receipt.stageReuse.runStartedAt, measuredAt: prior.startedAt ?? receipt.stageReuse.runStartedAt,
      durationMs: prior.durationMs ?? null };
    receipt.steps.push({ ...prior, durationMs: null, reused });
    receipt.stageReuse.reused.push(name);
    progress();
    console.log(`${name}: REUSED; it passed in the run of ${reused.runStartedAt} on the same head, base, node, dependency and selection`);
    return prior;
  };
  try {
    if ((values.deadline === undefined) !== (values['runtime-profile'] === undefined) ||
        (deadline !== undefined && (!Number.isFinite(deadline) || deadline <= Date.now()))) {
      throw new Error('runtime admission requires a future ISO deadline and a native runtime profile together');
    }
    const pinnedNode = readFileSync(join(root, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
    // W1-T13736: off the pin, re-run this script under an installed pin with the same flags, arguments and environment.
    if (process.versions.node !== pinnedNode) {
      const located = pinnedNodeReexec({ spawn, ...pinnedNodeLocation, pin: pinnedNode, current: process.versions.node });
      if (located.refuse !== undefined) throw refusal('node-version', located.refuse);
      console.log(`author preflight: Node ${process.versions.node} is not the .nvmrc pin ${pinnedNode}; re-running under Node ${pinnedNode} at ${located.reexec}`);
      const child = spawn(located.reexec, [...process.execArgv, fileURLToPath(import.meta.url), ...argv], { stdio: 'inherit', env: process.env });
      if (child.error) throw new Error(`the re-run under Node ${pinnedNode} (${located.reexec}) could not start: ${child.error.message}`);
      if (child.signal) throw new Error(`the re-run under Node ${pinnedNode} (${located.reexec}) ended by signal ${child.signal}`);
      return child.status;
    }
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
      let dependencyBefore=authorDependencyProvenance(root);
      // W1-T11468: a checkout's own seed materialization behind its lockfile is re-primed once, then re-checked.
      const reprime=reprimeOwnSeedMaterialization(root,dependencyBefore,{run});
      if(reprime){dependencyBefore=reprime.after;console.log(`dependency re-prime: exit ${reprime.record.status}; ${reprime.record.firstLine}`);}
      receipt.dependencyProvenance={before:dependencyBefore,...(reprime?{reprime:reprime.record}:{}),assurance:'metadata/tool precheck, not cached-test permission'};
      if(dependencyBefore.state!=='present')throw refusal('dependency-precheck',`installed dependency precheck unavailable: ${dependencyBefore.reason}; expensive validation not started`);
      // Production phases only: an injected spawn is a diagnostic seam with no native slot to bind.
      const nativeBoundary = spawn === spawnSync;
      const sourceBefore = nativeBoundary ? observeAuthorContext({ root, git, dependency: () => dependencyBefore }).source : undefined;
      let boundContext;
      // The acquired test slot; assigned at admission, read when the native context is observed.
      let slot;
      const observeContext = () => observeAuthorContext({ root, git, slot,
        allocations: { diagnostics: diagnosticsRoot, scratch: tmpdir(), workspace: root } });
      /** The exact head/tree, dependencies, slot owner and allocation filesystems the phase is bound to. */
      const requireNativeContext = (intent) => {
        if (!nativeBoundary) return;
        try {
          if (!boundContext) {
            const first = observeContext();
            boundContext = { format: AUTHOR_CONTEXT_FORMAT, source: sourceBefore, dependency: dependencyBefore,
              owner: first.owner, allocations: first.allocations };
            requireAuthorContext(boundContext, first, intent);
          } else requireAuthorContext(boundContext, observeContext(), intent);
        } catch (error) {
          receipt.affectedTestsNotRunReason = `${error.message}; no native phase was started or reused`;
          throw error;
        }
        receipt.nativeContext = { format: AUTHOR_CONTEXT_FORMAT, intent, compatible: true, head: boundContext.source.head,
          tree: boundContext.source.tree, ownerNonce: boundContext.owner.ownerNonce,
          allocations: Object.keys(boundContext.allocations) };
      };
      const { stages, ...stageReuse } = reusableAuthorStages(previous, receipt);
      receipt.stageReuse = { ...stageReuse, reused: [] };
      reusable = stages;
      console.log(`stage reuse: ${stageReuse.state}; ${stageReuse.reason}`);
      // A reused census passed measured: it was never time-bound and its full-pass note is the one it printed.
      // W1-T12511: what this run leaves to CI, confirmed against this tree's ci.yml; the static child derives the same split.
      const ciSplit = authorCiSplit(readAuthorCiContract(root));
      receipt.leftToCi = ciSplit.leftToCi;
      receipt.authorPathKept = ciSplit.kept;
      console.log(leftToCiLine(ciSplit.leftToCi));
      for (const { job, reason } of ciSplit.kept) console.log(`kept on the author path: ${job} — ${reason}`);
      const censusReused = Boolean(reuseStage('census-precheck'));
      const census = censusReused ? { status: 0 } : runStep('census-precheck', authorCensusPrecheckArgs(root, receipt.baseSha, ciSplit.censusCountsOnly));
      receipt.censusFullPass = censusReused ? previous.censusFullPass ?? { skipped: false } : censusFullPassNote(census);
      if (receipt.censusFullPass.skipped) console.log(`census full pass SKIPPED - ${receipt.censusFullPass.reliedOn}`);
      const censusTimeBound = censusTimeBoundOnly(census);
      const censusOk = (census.status === 0 || censusTimeBound) && !census.signal && !census.error;
      const failedSuite = !censusOk && /^  census-suite: (test\/.+?) fails — /m.exec(census.stderr ?? '')?.[1];
      if (!censusReused) report('census-precheck', census, censusOk, censusTimeBound ? { notMeasured: 'time-bound' }
        : failedSuite ? { failedCheck: failedSuite } : {});
      if (censusTimeBound) {
        receipt.censusNotMeasured = { reason: 'time-bound', checkedBy: 'CI' };
        console.log('census suites NOT MEASURED (time bound) — CI runs them');
      } else if (census.status === 2 || census.signal || census.error || census.status === null) {
        throw new Error('census precheck could not measure the author tree; expensive validation was not started');
      }
      if (censusOk) {
        const workflowInputs = authorWorkflowContractInputs(receipt.changedFiles);
        receipt.workflowContractPrecheck = { required: workflowInputs.length > 0, inputs: workflowInputs, suites: [] };
        if (workflowInputs.length > 0) receipt.workflowContractPrecheck.suites = verifiedSuites(root, AUTHOR_WORKFLOW_CONTRACT_SUITES);
        if (workflowInputs.length > 0 && !reuseStage('workflow-contract-precheck')) {
          const suites = receipt.workflowContractPrecheck.suites;
          // This fixed, cheap contract runs before any heavy admission or capacity truncation.
          // R-50 walks all workflows, including new names with no literal reader hit.
          const judged = prepareJudgedRun();
          const command = lowPriorityCommand(process.execPath, judgedNodeTestArgs(authorTestRunnerArgs(boundedNodeTestArgs(['--test', '--test-reporter=tap',
            '--test-concurrency=1', '--import', 'tsx', '--import', './test/setup/tmp-hygiene.ts', ...suites], root), suites, undefined), judged.args));
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
            if (reuseStage(`docs-index-precheck:${script}`)) continue;
            const name = `docs-index-precheck:${script}`;
            // W1-T13774: npm and the package script's own `node` run on this Node, never on PATH's first one.
            const npm = npmUnderRunningNode(npmCliLocation);
            if (npm.refuse !== undefined) {
              report(name, { status: null, error: new Error(npm.refuse) }, false, { inputs: docsInputs, runtimeBoundMs: AUTHOR_DOCS_PRECHECK_MAX_MS });
              receipt.affectedTestsNotRunReason = `${name} did not succeed; no heavy slot/static/test phase was started`;
              throw new Error(npm.refuse);
            }
            const parentPath = authorEnvironment(process.env).PATH;
            const result = runStep(name, [...npm.args, 'run', '--silent', script], npm.file,
              { PATH: parentPath ? npm.binDir + delimiter + parentPath : npm.binDir }, AUTHOR_DOCS_PRECHECK_MAX_MS);
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
        // W1-T11891: no fixed author ceiling. The slot request is the measured pre-admission width (CPU, and
        // memory incl. darwin vm_stat): an unmeasured memory reading asks for one worker, never more.
        const requested = hostBudget((host ?? readHostCapacityInputs)());
        const queue = enqueueSuiteSlot(AUTHOR_SUITE_LABEL, { ...testSlot, perFileBytes: TEST_FILE_PEAK_BYTES, maxConcurrency: requested.workers });
        receipt.suiteQueue = { ticketed: queue.ticketed, positionAtEnqueue: queue.position ?? null, note: queue.note,
          requestedWorkers: requested.workers, requestedBoundBy: requested.inputs.boundBy };
        // W1-T11915 criterion 4: retain the ticket's arrival identity and add the selection's known price
        // before static work starts, so every heartbeat can report the same price used by capacityVerdict.
        let manifest = { files: {} };
        try { manifest = JSON.parse(readFileSync(join(root, 'scripts/test-tier-manifest.json'), 'utf8')); }
        catch (error) { receipt.manifestUnavailable = error.message; }
        const priced = partial ? partial.suites : receipt.suites;
        queue.setPrice(priceSelection(priced, manifest).costMs);
        let staticEndedAt;
        const admitSuites = () => {
          const waitStartedAt = Date.now();
          slot = queue.admit();
          receipt.testSlot = { outcome: slot.outcome, concurrency: slot.concurrency, waitedMs: slot.waitedMs, note: slot.note };
          receipt.suiteQueue = { ...receipt.suiteQueue, outcome: 'admitted', waitedMs: Date.now() - (staticEndedAt ?? waitStartedAt) };
          if (!testSlotExecutionAllowed(slot)) throw refusal('test-slot-wait-bound', `author preflight NOT_RUN (${slot.note})`);
          // Bind head/tree, dependencies, the slot's owner nonce and every allocation before work starts.
          requireNativeContext('start');
        };
        const cancelSuites = (reason) => {
          if (receipt.suiteQueue.outcome) return;
          queue.cancel(reason);
          receipt.suiteQueue = { ...receipt.suiteQueue, outcome: 'cancelled', reason };
        };
        try {
          let runtimeProfile, runtimeManifest;
          // `admittedWorkers` is the measured bound the width must sit within: the pre-admission request
          // before static, the exact acquired grant once a slot is held (rechecked, never assumed).
          const admitRuntime = (stage, staticReserveMs, files = receipt.suites,
            workers = requested.workers, admittedWorkers = workers) => {
            if (deadline === undefined) return;
            // Before static the slot is not held yet; price suites at the capacity the measured host can grant.
            if (stage !== 'before-static' && !['acquired', 'inherited'].includes(slot?.outcome)) throw new Error('runtime admission requires a real slot; unslotted fallback is not deadline-fit capacity');
            runtimeProfile ??= readRuntimeProfile(root, values['runtime-profile'], runtimeBindings(root, receipt.headSha, authorEnvironment(process.env)));
            // An empty full-fallback partial set runs no suite: the profile is still validated, nothing is priced.
            if (files.length === 0) return;
            runtimeManifest ??= JSON.parse(readFileSync(join(root, 'scripts/test-tier-manifest.json'), 'utf8'));
            const decision = runtimeSelectionFit(files, runtimeManifest, runtimeProfile, {
              workers, admittedWorkers, deadline, ...(staticReserveMs === undefined ? {} : { staticReserveMs }),
            });
            receipt.runtimeAdmission = { stage, profile: relative(root, resolve(root, values['runtime-profile'])), ...decision };
            progress({ name: 'runtime-admission', stage, fits: decision.fits });
            if (!decision.fits) throw new Error(`runtime deadline does not fit admitted ${decision.workers}-worker pool: need ${decision.requiredMs}ms, have ${decision.availableMs}ms; expensive phase not started`);
          };
          admitRuntime('before-static', undefined, partial ? partial.suites : receipt.suites);
          // W1-T12166: a reused static stage takes no host capacity and no static admission.
          const staticReused = Boolean(reuseStage('static-preflight'));
          const staticCapacity = staticReused ? undefined : admitHost('static-preflight', { selection: receipt.selection, workers: 1 });
          if (staticCapacity) (receipt.hostCapacity ??= []).push(staticCapacity);
          // Its record names a cold tsc's peak; the nested typecheck sees this ancestor's record and inherits it.
          const staticAdmission = staticReused ? { outcome: 'reused', executionAllowed: true, waitedMs: 0, note: 'static-preflight reused', release() {} }
            : admitStaticWork(AUTHOR_STATIC_LABEL, { ...testSlot, memoryBytes: TYPECHECK_COLD_PEAK_BYTES });
          receipt.staticAdmission = { outcome: staticAdmission.outcome, waitedMs: staticAdmission.waitedMs, note: staticAdmission.note };
          let staticOk = staticReused;
          let lintOk = true;
          try {
            if (!staticAdmission.executionAllowed) throw refusal('static-wait-bound', `author static stage NOT_RUN (${staticAdmission.note})`);
            if (!staticReused) {
              // A per-run summary cannot name a check from an earlier run if the child exits before writing it.
              const staticSummaryPath = join(diagnosticsRoot, 'preflight-author-static.json');
              const staticCommand = lowPriorityCommand(process.execPath, ['--import', 'tsx',
                join(root, 'src/run-task.ts'), 'preflight', '--from', receipt.baseSha,
                '--summary-file', staticSummaryPath]);
              const censusAnswer = { RMD_AUTHOR_CENSUS_ANSWERED: `${receipt.headSha}:${censusTimeBound ? 'time-bound' : 'ok'}` };
              const staticResult = runStep('static-preflight', staticCommand.args, staticCommand.file, { ...(staticAdmission.childEnvironment ?? {}), ...censusAnswer }, AUTHOR_STEP_RUNTIME_MS);
              staticOk = staticResult.status === 0 && !staticResult.signal && !staticResult.error;
              report('static-preflight', staticResult, staticOk, { priority: staticCommand.priority,
                ...(staticResult.status === 1 && !staticResult.signal && !staticResult.error ? staticFailureMetadata(staticSummaryPath) : {}) });
            }
            // An unsuccessful static gate already makes this tree unpublishable. Keep its failed
            // receipt and selected floor, but don't spend another full run on known-doomed tests.
            // W1-T7809: a plan-only selection is plan lint first; a failed lint is as unpublishable as a failed static gate.
            if (staticOk && receipt.selection === 'plan-only' && !reuseStage('lint-plan-fast')) {
              const lint = runStep('lint-plan-fast', ['--import', 'tsx', join(root, 'scripts/lint-plan-offline.mjs'),
                '--base', 'origin/main', '--merge-base'], process.execPath, staticAdmission.childEnvironment ?? {}, AUTHOR_STEP_RUNTIME_MS);
              lintOk = lint.status === 0 && !lint.signal && !lint.error;
              report('lint-plan-fast', lint, lintOk);
            }
          } finally {
            releaseWhenClosed(staticAdmission, 'static-admission');
            staticEndedAt = Date.now();
          }
          if (staticOk && lintOk) {
            const dependencyAfterStatic=authorDependencyProvenance(root);
            receipt.dependencyProvenance.afterStatic=dependencyAfterStatic;
            if(!sameAuthorDependencyProvenance(dependencyBefore,dependencyAfterStatic))throw new Error('installed dependency donor changed during static validation; tests not started');
            // W1-T12166: a test stage that ran every selected suite green on these inputs is not run again.
            const testsReused = Boolean(reuseStage('affected-tests'));
            if (testsReused) cancelSuites('affected-tests reused: every selected suite passed in the last run');
            else {
              // W1-T9951: a selection naming no suite leaves the line; one that names suites waits its turn here.
              if ((partial ? partial.suites : receipt.suites).length === 0) cancelSuites('the selection names no suite');
              else admitSuites();
              // W1-T7809: price the selection against what this host can carry NOW, before spending it.
              // W1-T11891: only a real acquired grant is execution capacity; its width is the measured bound.
              const slotAcquired = slot?.outcome === 'acquired' && testSlotExecutionAllowed(slot);
              const legacyBudget = hostBudget((host ?? readHostCapacityInputs)(), { slotConcurrency: slot?.concurrency, slotAcquired });
              // A deadline without a validated native profile was refused before static work.
              // Never expand workers or restart the deadline to admit a larger selection.
              const nativeBudget = runtimeProfile ? deadlineHostBudget(legacyBudget, { deadline, grant: slot?.concurrency }) : legacyBudget;
              // W1-T9953: a full fallback is priced against the HOST, never the deadline; a deadline may only shrink it.
              const budget = partial && nativeBudget.budgetMs > legacyBudget.budgetMs ? legacyBudget : nativeBudget;
              const executionWorkers = budget.workers;
              receipt.executionWorkers = executionWorkers;
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
              admitRuntime('before-tests', 0, ranSuites, executionWorkers, slot.concurrency);
              // An over-capacity subset is sized by the arm it was cut from: a narrow arm's subset is narrower still.
              // W1-T10947: an explicit bounded profile is priced against the context this slot was bound to.
              // W1-T12953: a full fallback cut to fewer suites is priced by the workers that subset runs.
              const testCapacity = admitHost('affected-tests', { selection: receipt.selectedArm ?? receipt.selection, workers: executionWorkers,
                ...(ranSuites.length < receipt.suites.length ? { overCapacitySubset: true } : {}),
                ...(values['author-profile'] === undefined ? {} : { boundedProfile: readAuthorProfile(root, values['author-profile']),
                  context: boundContext ? observeContext() : undefined, bound: boundContext }) });
              if (testCapacity) (receipt.hostCapacity ??= []).push(testCapacity);
              // No whole-suite retry or instrumentation. A missing target/summary is a refusal, never green.
              // The host-wide test slot, its measured CPU/memory grant (no fixed ceiling) and nice (test-slot.ts).
              slot.refresh();
              // The suites start only under the very context the slot was bound to; anything else is NOT_RUN.
              requireNativeContext('start');
              const hasDurationReporter = existsSync(join(root, 'scripts/test-duration-reporter.mjs'));
              const durationArgs = !hasDurationReporter ? [] : ['--test-reporter-destination=stdout',
                `--test-reporter=${join(root, 'scripts/test-duration-reporter.mjs')}`,
                `--test-reporter-destination=${join(diagnosticsRoot, 'durations.json')}`];
              // Judged (scripts/pure-test-pool.mjs): a suite whose own child exits 0 part-way is reported
              // `ok` with a whole summary, so the step passes only when every suite reached its own summary.
              const judged = prepareJudgedRun();
              const child = lowPriorityCommand(process.execPath, testRunArgv(judgedNodeTestArgs(authorTestRunnerArgs(boundedNodeTestArgs(['--test', '--test-reporter=tap', ...durationArgs,
                '--import', 'tsx', '--import', './test/setup/tmp-hygiene.ts', ...ranSuites], root, manifest), ranSuites, manifest), judged.args), executionWorkers));
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
              // W1-T13215: only a run that ended with failing tests is compared with the merge base; the verdict never reads it.
              const headSummary = testSummary(`${tests.stdout ?? ''}\n${tests.stderr ?? ''}`);
              if (headSummary?.fail > 0) {
                try {
                  const named = failingTestsFromTap(`${tests.stdout ?? ''}\n${tests.stderr ?? ''}`, root);
                  let durations;
                  try { durations = JSON.parse(readFileSync(join(diagnosticsRoot, 'durations.json'), 'utf8')); } catch (error) { durations = { unreadable: String(error.code ?? error.message) }; }
                  const attribution = attributeFailures({ root, baseSha: receipt.baseSha, headSha: receipt.headSha, failing: named,
                    unnamed: Math.max(0, headSummary.fail - named.length),
                    headMs: headFilesMs(durations, [...new Set(named.map((test) => test.file))], tests.durationMs),
                    git: (args) => run('git', args), runnerArgs: (files, dir) => authorTestRunnerArgs(['--test', '--test-reporter=tap',
                      '--test-concurrency=1', '--import', 'tsx', ...(existsSync(join(dir, 'test/setup/tmp-hygiene.ts')) ? ['--import', './test/setup/tmp-hygiene.ts'] : []),
                      ...files], files, manifest),
                    runBase: ({ file, args, cwd, boundMs }) => runStep('affected-tests-base', args, file, {}, boundMs, slot.heartbeat, cwd) });
                  receipt.failureAttribution = { counts: attribution.counts, base: attribution.base, cleanup: attribution.cleanup,
                    tests: attribution.tests.map(({ file, title, state, reason }) => ({ file, title, state, reason })) };
                  for (const line of attributionLines(attribution)) console.log(line);
                } catch (error) {
                  receipt.failureAttribution = { error: `the attribution could not be made: ${error?.message ?? error}` };
                  console.log(`author attribution: NOT MADE (${receipt.failureAttribution.error}); the verdict is unaffected`);
                }
              }
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
            }
          } else {
            const gate = staticOk ? 'lint-plan-fast' : 'static-preflight';
            cancelSuites(`${gate} did not succeed`);
            receipt.affectedTestsNotRunReason = `${gate} did not succeed; see its native outcome`;
            console.log(`affected-tests: NOT RUN — ${gate} did not succeed; selected floor retained in the receipt`);
          }
        } finally {
          cancelSuites('the author stage ended before suite admission');
          releaseWhenClosed(slot, 'test-slot');
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
    refusedAt = { refusalClass: error.refusalClass ?? 'other', ...(error instanceof MacAuthorCapacityRefusal
      ? { refusalStage: error.stage, capacityReasons: error.admission?.reasons } : {}) };
    // A failed early precheck exits before the normal end-of-run provenance read. Record it here so a
    // later same-input retry can reuse only the measured prefix when the dependency donor stayed stable.
    if (receipt.dependencyProvenance?.before && receipt.dependencyProvenance.after === undefined) {
      try { receipt.dependencyProvenance.after = authorDependencyProvenance(root); }
      catch (provenanceError) {
        receipt.dependencyProvenance.after = { state: 'unavailable', reason: provenanceError.message };
      }
    }
    let refusalLines = [];
    if (error instanceof MacAuthorCapacityRefusal) {
      const { summary, lines } = macAuthorRefusalReport(error.stage, error.admission);
      (receipt.hostCapacity ??= []).push({stage: error.stage, ...error.admission, ...summary});
      receipt.affectedTestsNotRunReason = error.message;
      refusalLines = lines;
    }
    receipt.error = error.message;
    console.error(`author preflight ${error instanceof MacAuthorCapacityRefusal ? 'NOT_RUN' : 'REFUSED'}: ${error.message}`);
    for (const line of refusalLines) console.error(line);
  }
  // W1-T11914: the one place a caller reads "may I push?"; derived from the verdict just set, never an input to it.
  Object.assign(receipt, authorPushEligibility(receipt));
  receipt.durationMs = Date.now() - startedAt;
  receipt.phaseAccounting = accountAuthorPhases(receipt);
  const rowContext = { ...verdictLedger, ...refusedAt,
    headRef: () => authorHeadRef(root, values['head-ref'] ?? receipt.publicationIdentity?.headRef, spawn) };
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
    Object.assign(receipt, authorPushEligibility(receipt));
    console.error(receipt.error);
    if (diagnosticsRoot) {
      try { progress(); }
      catch (progressError) { console.error(`refused progress receipt unavailable: ${progressError.message}`); }
    }
    return concludeAuthorRun(receipt, { ...rowContext, refusalClass: refusedAt.refusalClass ?? 'other', announce: false });
  }
  return concludeAuthorRun(receipt, rowContext);
}

// diff-cov: process-boundary — the CLI guard only hands argv to the row child, the low-footprint author or the guarded entry, each tested where it is defined.
if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv[0] === AUTHOR_VERDICT_ROW_FLAG) process.exitCode = runAuthorVerdictRowChild(readFileSync(0, 'utf8'));
  else if (argv.includes('--low-footprint')) {
    const {runLowFootprintAuthor} = await import('./lib/author-low-footprint.mjs');
    process.exitCode = await runLowFootprintAuthor(argv, {
      root: REPO_ROOT, publicationIdentity: authorPublicationIdentity, authorEnvironment, completeTestResult,
    });
  } else process.exitCode = runGuardedAuthor(argv);
}
