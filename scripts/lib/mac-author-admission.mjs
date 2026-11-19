// Capacity admission for NEW Mac author jobs. No process control, cleanup, or Linux policy changes.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {statfsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {authorContextCompatibility} from './author-context-compatibility.mjs';

// Matches ci-parity's existing local coverage scratch reserve; this does not lower that gate.
export const MAC_AUTHOR_FREE_RESERVE_BYTES = 20 * 1024 ** 3;
// W1-T10947: the operator-approved floor for an EXPLICITLY bounded author profile (10737418240 bytes).
export const MAC_AUTHOR_BOUNDED_MINIMUM_BYTES = 10 * 1024 ** 3;

/** XNU's sysctl returns DISPATCH/NOTE flags (1,2,4), NOT its internal 0..4 pressure enum.
 * See apple-oss-distributions/xnu/bsd/kern/kern_memorystatus_notify.c. */
export function macPressureState(text) {
  const value = String(text).trim();
  return value === '1' ? 'normal' : value === '2' ? 'warning' : value === '4' ? 'critical' : 'unknown';
}

// W1-T10765: what macOS itself needs free while an author run is in flight. Swap grows in 1 GiB files on the
// same APFS container (6 GiB, 83% used, on the 16 GiB Mac mini on 2026-10-26), so this leaves room for it to double.
export const MAC_AUTHOR_OS_FLOOR_BYTES = 10 * 1024 ** 3;
export const MAC_AUTHOR_PEAK_SAFETY_FACTOR = 2;
// Measured, not estimated: the full author preflight's own disk growth (its TMPDIR, coverage/ and the tree
// outside node_modules, .git included), sampled every 5 s on 2026-10-26. Whole-run peaks: a plan-only run
// 150.7 MiB; an affected-narrow run of 280 suites on one worker 184.2 MiB. Each phase takes the larger
// whole-run peak, rounded up, so no phase is priced below a run that contains it. A phase or selection with
// no row here is unmeasured and keeps MAC_AUTHOR_FREE_RESERVE_BYTES.
// W1-T12953, sampled the same way on 2026-11-15: two full-fallback static stages grew 193.9 and 215.0 MiB, and
// the test stage of a 295-suite over-capacity subset of a full fallback grew 138.6 MiB on one worker.
export const MAC_AUTHOR_MEASURED_PEAK_BYTES = Object.freeze({
  entry: 256 * 1024 ** 2,
  'static-preflight': 256 * 1024 ** 2,
  'affected-tests-per-worker': 256 * 1024 ** 2,
  'full-fallback-static-preflight': 256 * 1024 ** 2,
  'over-capacity-subset-tests-per-worker': 256 * 1024 ** 2,
});
const SIZED_SELECTIONS = new Set(['plan-only', 'affected-narrow', 'affected-floor']);

/** The measured row that prices `stage` for this workload and how many times it applies, or undefined. */
function measuredReserveRow({stage, selection, workers, overCapacitySubset}) {
  if (stage === 'entry') return ['entry', 1];
  const perWorker = Number.isSafeInteger(workers) && workers >= 1;
  if (SIZED_SELECTIONS.has(selection)) {
    if (stage === 'static-preflight') return ['static-preflight', 1];
    if (stage === 'affected-tests' && perWorker) return ['affected-tests-per-worker', workers];
  } else if (selection === 'full-fallback') {
    if (stage === 'static-preflight') return ['full-fallback-static-preflight', 1];
    if (stage === 'affected-tests' && perWorker && overCapacitySubset === true)
      return ['over-capacity-subset-tests-per-worker', workers];
  }
  return undefined;
}

/** The disk reserve one author phase needs: the OS floor plus a safety factor over that phase's measured peak,
 * never above the 20 GiB full-run reserve. An unknown selection, an unmeasured phase or a full fallback's test
 * stage that runs whole keeps the full reserve, so the bound only ever relaxes where a measurement backs it.
 * `row` and `measuredPeakBytes` name the measurement behind the reserve (null when none applied). */
export function macAuthorReserveBytes(workload = {}) {
  const full = {bytes: MAC_AUTHOR_FREE_RESERVE_BYTES, basis: 'existing-20GiB', row: null, measuredPeakBytes: null};
  const found = measuredReserveRow(workload);
  if (!found) return full;
  const [row, times] = found, measured = MAC_AUTHOR_MEASURED_PEAK_BYTES[row] * times;
  if (!Number.isSafeInteger(measured) || measured <= 0) return full;
  const bytes = MAC_AUTHOR_OS_FLOOR_BYTES + MAC_AUTHOR_PEAK_SAFETY_FACTOR * measured;
  return bytes >= full.bytes ? full : {bytes, basis: `measured-${workload.stage}`, row, measuredPeakBytes: measured};
}

// W1-T10926 MEASURE FIRST: what each author stage's OWN process tree held in memory (summed RSS) and how far host swap
// grew while it ran, sampled every 5 s on the 16 GiB Mac mini on 2026-11-18 at origin/main 19628fb6dc:
// - entry: the selection's own peak (maxRSS 711950336 for W1-T13672's affected-narrow range, 373178368 for a plan-only
//   one) plus the census full pass it then runs (tree peak 1685078016 over 660 s; swap grew 268697600);
// - static-preflight: `run-task preflight` (rule checks and tsc), tree peak 3677274112 over 217 s, no swap growth;
// - affected-tests-per-worker: one worker over 60 suites of that narrow selection, tree peak 1817411584 over 307 s
//   (p90 of its samples 665 MiB), no swap growth.
// A stage or selection with no row here (a full fallback, an unknown selection) keeps the normal-only pressure rule.
export const MAC_AUTHOR_MEASURED_MEMORY_BYTES = Object.freeze({
  entry: Object.freeze({peakBytes: 711950336 + 1685078016, swapGrowthBytes: 268697600}),
  'static-preflight': Object.freeze({peakBytes: 3677274112, swapGrowthBytes: 0}),
  'affected-tests-per-worker': Object.freeze({peakBytes: 1817411584, swapGrowthBytes: 0}),
});

/** The measured memory `stage` needs for this workload (a test stage per worker it runs), or null when unmeasured. */
export function macAuthorMemoryNeed({stage, selection, workers} = {}) {
  let row, times = 1;
  if (stage === 'entry') row = 'entry';
  else if (SIZED_SELECTIONS.has(selection) && stage === 'static-preflight') row = 'static-preflight';
  else if (SIZED_SELECTIONS.has(selection) && stage === 'affected-tests' && Number.isSafeInteger(workers) && workers >= 1)
    [row, times] = ['affected-tests-per-worker', workers];
  const measured = row === undefined ? undefined : MAC_AUTHOR_MEASURED_MEMORY_BYTES[row];
  if (!measured) return null;
  return {row, workers: times, peakBytes: measured.peakBytes * times, swapGrowthBytes: measured.swapGrowthBytes * times};
}

/** What a refusal says about the reserve it applied: the basis, the measured row and peak behind it. */
function reserveRecord(reserve) {
  return {basis: reserve.basis, row: reserve.row, measuredPeakBytes: reserve.measuredPeakBytes};
}

/** `allocations` ([{key, path, minimumFreeBytes}]) replaces the workspace/scratch pair with one check per
 * allocation filesystem (W1-T10947); none may ask for less than the approved 10 GiB bounded minimum. */
export function readMacAuthorAdmission(root, {platform = process.platform, scratch = tmpdir(),
  statfs = statfsSync, spawn = spawnSync, minimumFreeBytes = MAC_AUTHOR_FREE_RESERVE_BYTES, reserveBasis,
  allocations} = {}) {
  if (platform !== 'darwin') return {state: 'not-applicable', platform, reasons: []};
  if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes <= 0) throw new Error('invalid author disk reserve');
  if (allocations !== undefined && (!Array.isArray(allocations) || !allocations.length || allocations.some(row =>
    typeof row?.key !== 'string' || !row.key || typeof row.path !== 'string' || !row.path ||
    !Number.isSafeInteger(row.minimumFreeBytes) || row.minimumFreeBytes < MAC_AUTHOR_BOUNDED_MINIMUM_BYTES)))
    throw new Error('invalid bounded author allocation reserve');
  const result = {state: 'not-run', platform, minimumFreeBytes, ...(reserveBasis ? {reserveBasis} : {}),
    workspaceFreeBytes: null, scratchFreeBytes: null, ...(allocations ? {allocationFreeBytes: {}} : {}),
    capacityChecks: [], pressure: 'unknown', reasons: []};
  const below = allocations ? `below-${reserveBasis ?? 'bounded-profile'}-reserve`
    : minimumFreeBytes === MAC_AUTHOR_FREE_RESERVE_BYTES ? 'below-existing-20GiB-reserve'
    : reserveBasis ? `below-${reserveBasis}-reserve` : 'below-bounded-job-reserve';
  const targets = allocations ? allocations.map(row => [row.key, row.path, row.minimumFreeBytes])
    : [['workspaceFreeBytes', root, minimumFreeBytes], ['scratchFreeBytes', scratch, minimumFreeBytes]];
  for (const [key, path, required] of targets) {
    const label = allocations ? `allocation:${key}` : key;
    let observed = null;
    try {
      const fs = statfs(path), bytes = fs.bavail * fs.bsize;
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid filesystem capacity');
      observed = bytes;
      if (allocations) result.allocationFreeBytes[key] = bytes; else result[key] = bytes;
      if (bytes < required) result.reasons.push(`${label}:${below}`);
    } catch (error) {
      result.reasons.push(`${label}:unavailable:${error.code ?? error.message}`);
    }
    result.capacityChecks.push({filesystem: label, requiredFreeBytes: required, observedFreeBytes: observed,
      shortfallBytes: observed === null ? null : Math.max(0, required - observed)});
  }
  try {
    const observed = spawn('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'],
      {encoding: 'utf8', timeout: 2000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe']});
    if (observed.status !== 0 || observed.signal || observed.error) throw new Error('pressure probe did not complete');
    result.pressure = macPressureState(observed.stdout);
  } catch (error) {
    // Failed bounded reads remain UNKNOWN, never a healthy or zero-cost measurement.
    result.reasons.push(`pressure:unavailable:${error.message}`);
  }
  if (result.pressure !== 'normal') result.reasons.push(`pressure:${result.pressure}`);
  result.state = result.reasons.length ? 'not-run' : 'admitted';
  return result;
}

export const BOUNDED_AUTHOR_PROFILE_FORMAT = 'rmd-bounded-author-profile-v1';
/** Every byte budget one allocation carries; a profile omitting any of them is not fully costed. */
export const BOUNDED_AUTHOR_BUDGET_KEYS = Object.freeze(['allocationBytes', 'scratchBytes', 'outputBytes',
  'nativeBytes', 'runtimeBytes', 'childClosureBytes']);
const SHA = /^[a-f0-9]{40}$/;
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The immutable dependency identity a bounded profile binds: a digest of the observed provenance. */
export function authorDependencyDigest(dependency) {
  return createHash('sha256').update(JSON.stringify(dependency)).digest('hex');
}

/** The binding a profile must carry for this observed context: committed head/tree and dependency digest. */
export function boundedAuthorProfileBinding(context) {
  return {head: context?.source?.head, tree: context?.source?.tree,
    dependencySha256: authorDependencyDigest(context?.dependency)};
}

function profileDefect(profile) {
  if (profile === undefined) return 'omitted';
  if (!plain(profile) || profile.format !== BOUNDED_AUTHOR_PROFILE_FORMAT)
    return `unknown-profile${typeof profile?.unreadable === 'string' ? `:unreadable:${profile.unreadable}` : ''}`;
  if (profile.bounded !== true || !plain(profile.budgets) || !Object.keys(profile.budgets).length) return 'unbounded-profile';
  for (const [name, budget] of Object.entries(profile.budgets)) {
    if (!plain(budget) || Object.keys(budget).length !== BOUNDED_AUTHOR_BUDGET_KEYS.length ||
        BOUNDED_AUTHOR_BUDGET_KEYS.some(key => !Number.isSafeInteger(budget[key]) || budget[key] < 0))
      return `unbounded-profile:${name}`;
  }
  return null;
}

function identityDefect(profile, context) {
  const source = context?.source, binding = profile.binding;
  if (!SHA.test(source?.head ?? '') || source.clean !== true || binding?.head !== source.head || binding?.tree !== source.tree)
    return 'stale-identity:source';
  if (context.dependency?.state !== 'present' || binding?.dependencySha256 !== authorDependencyDigest(context.dependency))
    return 'stale-identity:dependency';
  if (context.owner?.state !== 'held' || typeof context.owner.ownerNonce !== 'string') return 'stale-identity:owner';
  return null;
}

/**
 * W1-T10947: what an EXPLICIT bounded author profile requires of each filesystem its allocations
 * actually live on — max(10 GiB, every declared byte budget of every allocation on it). Only a profile
 * bound to the observed head/tree, dependency digest and held slot owner, with a budget for exactly
 * the observed allocations, applies; anything else is `not-applied` with its reason, and keeps the
 * existing reserve. The profile can never lower a filesystem below the 10 GiB minimum.
 */
export function boundedAuthorRequirement(profile, {context, bound} = {}) {
  const notApplied = reason => ({state: 'not-applied', reason});
  const defect = profileDefect(profile);
  if (defect) return notApplied(defect);
  if (!plain(context)) return notApplied('missing-allocation-evidence:no-context');
  const identity = identityDefect(profile, context);
  if (identity) return notApplied(identity);
  const observed = plain(context.allocations) ? Object.keys(context.allocations) : [];
  if (!observed.length) return notApplied('missing-allocation-evidence:none-observed');
  for (const name of observed) {
    const row = context.allocations[name];
    if (row?.state === 'unavailable' || typeof row?.path !== 'string' || !Number.isSafeInteger(row.dev))
      return notApplied(`missing-allocation-evidence:${name}`);
    if (!Object.hasOwn(profile.budgets, name)) return notApplied(`missing-allocation-evidence:${name}:no-budget`);
  }
  const undeclared = Object.keys(profile.budgets).find(name => !observed.includes(name));
  if (undeclared) return notApplied(`missing-allocation-evidence:${undeclared}:not-observed`);
  // The phase's slot was bound to one exact context; an observation that drifted from it is stale.
  if (bound !== undefined) {
    const verdict = authorContextCompatibility(bound, context);
    if (!verdict.compatible) return notApplied(`stale-identity:${verdict.mismatches.join('+')}`);
  }
  const filesystems = new Map();
  for (const name of observed.sort()) {
    const row = context.allocations[name];
    const fs = filesystems.get(row.dev) ?? {dev: row.dev, path: row.path, names: [], declaredBytes: 0n};
    fs.names.push(name);
    for (const key of BOUNDED_AUTHOR_BUDGET_KEYS) fs.declaredBytes += BigInt(profile.budgets[name][key]);
    filesystems.set(row.dev, fs);
  }
  const rows = [];
  for (const fs of filesystems.values()) {
    if (fs.declaredBytes > BigInt(Number.MAX_SAFE_INTEGER)) return notApplied(`unbounded-profile:overflow:${fs.names.join('+')}`);
    const declaredBytes = Number(fs.declaredBytes);
    rows.push({key: fs.names.join('+'), dev: fs.dev, path: fs.path, declaredBytes,
      minimumFreeBytes: Math.max(MAC_AUTHOR_BOUNDED_MINIMUM_BYTES, declaredBytes)});
  }
  return {state: 'bounded', ownerNonce: context.owner.ownerNonce, head: context.source.head, filesystems: rows};
}

export class MacAuthorCapacityRefusal extends Error {
  constructor(stage, admission) {
    super(`Mac author capacity NOT_RUN before ${stage}: ${JSON.stringify(admission)}`);
    this.stage = stage;
    this.admission = admission;
  }
}

/** `workload` ({selection, workers}) sizes the reserve (W1-T10765); without one a phase keeps the full reserve.
 * A workload carrying `boundedProfile` (W1-T10947) is priced by that profile on each allocation filesystem
 * when it genuinely applies to `context` (and `bound`); otherwise it keeps that existing reserve and says why.
 * W1-T10926: `memory` ({sample, wait, now, pastWaits}) makes a measured stage wait out memory pressure
 * (awaitMacAuthorMemory). It defaults on only with the native reader: a faked host reading is never paired with this
 * host's real memory, and `null` keeps the single-read rule. */
export function requireMacAuthorCapacity(root, stage, readAdmission = readMacAuthorAdmission, workload = undefined,
  memory = readAdmission === readMacAuthorAdmission ? macAuthorMemorySeams() : null) {
  const {boundedProfile, context, bound, ...sizing} = workload ?? {};
  const bounded = workload && Object.hasOwn(workload, 'boundedProfile')
    ? boundedAuthorRequirement(boundedProfile, {context, bound}) : undefined;
  let read, reserve;
  if (bounded?.state === 'bounded') {
    reserve = {basis: 'bounded-profile', row: null, measuredPeakBytes: null};
    read = () => readAdmission(root, {reserveBasis: 'bounded-profile',
      minimumFreeBytes: Math.max(...bounded.filesystems.map(row => row.minimumFreeBytes)),
      allocations: bounded.filesystems.map(({key, path, minimumFreeBytes}) => ({key, path, minimumFreeBytes}))});
  } else {
    reserve = macAuthorReserveBytes({stage, ...sizing});
    read = () => readAdmission(root, {minimumFreeBytes: reserve.bytes, reserveBasis: reserve.basis});
  }
  const readOnce = () => bounded ? {...read(), boundedProfile: bounded} : read();
  const admission = settleMacAuthorMemory(stage, readOnce(), readOnce, memory, macAuthorMemoryNeed({stage, ...sizing}));
  if (admission.state !== 'admitted' && admission.state !== 'not-applicable')
    throw new MacAuthorCapacityRefusal(stage, {...admission, reserve: reserveRecord(reserve)});
  return {stage, ...admission};
}

/** The CLI boundary is guarded; direct main() fixtures remain explicit algorithm tests.
 * --help/--dry-run are read-only and never acquire a slot or start static/test work.
 * The entry check reserves only what selection and the census need; each heavy phase is
 * admitted again, against the reserve its own selection requires, once that selection is known.
 * `recordEntry` is handed the entry's own final admission, waited or not (W1-T10926). */
export function guardedAuthorEntry(argv, {root, readAdmission = readMacAuthorAdmission,
  runAuthor, reportRefusal = reportMacAuthorRefusal,
  memory = readAdmission === readMacAuthorAdmission ? macAuthorMemorySeams() : null, recordEntry = () => {}} = {}) {
  if (argv.some(arg => ['--help', '-h', '--dry-run'].includes(arg))) return runAuthor(argv);
  const entry = macAuthorReserveBytes({stage: 'entry'});
  const read = () => readAdmission(root, {minimumFreeBytes: entry.bytes, reserveBasis: entry.basis});
  const admission = settleMacAuthorMemory('entry', read(), read, memory, macAuthorMemoryNeed({stage: 'entry'}));
  recordEntry(admission);
  if (admission.state === 'admitted' || admission.state === 'not-applicable')
    return runAuthor(argv, {admitHost: (stage, workload) => requireMacAuthorCapacity(root, stage, readAdmission, workload, memory)});
  reportRefusal(root, {...admission, reserve: reserveRecord(entry)});
  return 3;
}

/** A refusal whose every reason is the pressure flag (or its failed read): the one refusal a stage may wait out. */
const pressureOnly = admission => admission?.state === 'not-run' && Array.isArray(admission.reasons) &&
  admission.reasons.length > 0 && admission.reasons.every(reason => reason.startsWith('pressure:'));

/** W1-T10926: the admission a stage starts on. With no memory seams, no measured need, or a refusal that is not
 * pressure alone (a disk shortfall), the single read stands exactly as before. Otherwise the stage waits. */
function settleMacAuthorMemory(stage, admission, reread, memory, need) {
  if (!memory || !need || admission.state === 'not-applicable') return admission;
  if (admission.state !== 'admitted' && !pressureOnly(admission)) return admission;
  return awaitMacAuthorMemory(stage, need, admission, reread, memory);
}

/** A refusal deliberately produces no author assurance. Never reuse an old PASS receipt. */
function reportMacAuthorRefusal(root, admission) {
  const {summary, lines} = macAuthorRefusalReport('entry', admission);
  console.error(`author preflight NOT_RUN: ${JSON.stringify({...admission, ...summary})}`);
  for (const line of lines) console.error(line);
  console.error(`Any older ${root}/coverage/preflight-author.json is NOT evidence for this invocation.`);
}

// W1-T12297: the guarded janitor installed on the Mac agent account; only its dry run is ever named.
export const MAC_AUTHOR_JANITOR_DRY_RUN = '"$HOME/Library/Application Support/remudero/remudero-janitor.sh" --dry-run';
const REFUSAL_STAGE_WORK = {
  entry: 'No slot, static checks, tests, dependency installation, cleanup or process termination started.',
  'static-preflight': 'Author selection and the census precheck ran; static checks and tests did not start. ' +
    'No cleanup or process termination started.',
  'affected-tests': 'Author selection, the census precheck and static checks ran; tests did not start. ' +
    'No cleanup or process termination started.',
};

/** W1-T12297: what a capacity refusal at `stage` tells the operator. Disk guidance only when a
 * filesystem is short or unmeasured; a pressure-only refusal gets none. W1-T12953: it names the reserve
 * applied, the measurement behind it and the free bytes that would admit the run. */
export function macAuthorRefusalReport(stage, admission) {
  const capacityChecks = Array.isArray(admission?.capacityChecks) ? admission.capacityChecks : [];
  const diskShort = capacityChecks.some(row => row.observedFreeBytes === null || row.shortfallBytes > 0);
  const required = capacityChecks.map(row => row.requiredFreeBytes).filter(Number.isSafeInteger);
  const reserve = {basis: admission?.reserve?.basis ?? admission?.reserveBasis ?? null, row: admission?.reserve?.row ?? null,
    measuredPeakBytes: admission?.reserve?.measuredPeakBytes ?? null,
    admittingFreeBytes: required.length ? Math.max(...required) : admission?.minimumFreeBytes ?? null};
  const summary = {stage, authorWorkStarted: stage !== 'entry', capacityChecks, reserve, ...(diskShort ? {recoveryGuidance:
    {action: 'measure-free-space-again', dryRunCommand: MAC_AUTHOR_JANITOR_DRY_RUN, documentation: 'deploy/mac/JANITOR.md'}} : {})};
  const bytes = value => value === null ? 'unknown' : `${value} bytes`;
  const lines = capacityChecks.map(row => `Capacity ${row.filesystem}: required ${row.requiredFreeBytes} bytes; ` +
    `observed ${bytes(row.observedFreeBytes)}; shortfall ${bytes(row.shortfallBytes)}.`);
  lines.push(`Reserve applied: ${reserve.basis ?? 'unknown'}; ` + (reserve.row === null
    ? 'no recorded measurement prices this stage'
    : `measured row ${reserve.row}, peak ${reserve.measuredPeakBytes} bytes`) +
    `; the run is admitted with ${bytes(reserve.admittingFreeBytes)} free on each filesystem checked.`);
  const waited = admission?.pressureWait;
  if (waited) lines.push(`Memory wait: ${waited.waitedMs} ms of a ${waited.limitMs} ms limit (${waited.limitBasis}, ` +
    `${waited.pastWaits} past waits); ${waited.samples.length} samples; failed checks: ${waited.failedChecks.join(', ') || 'none'}.`);
  lines.push(REFUSAL_STAGE_WORK[stage] ?? `Author work started before ${stage}; no cleanup or process termination started.`);
  if (diskShort) lines.push(`Safe recovery: measure free space again, review ${MAC_AUTHOR_JANITOR_DRY_RUN}, ` +
    'and follow deploy/mac/JANITOR.md. Preflight deletes nothing.');
  return {summary, lines};
}

// POLICY ceilings for explicitly scoped tests, NOT a new full-author assurance class.
// The memory budget includes 512 MiB of V8 old space plus the same allowance for
// loader/native overhead; it is a planning allowance, not an RSS hard limit.
export const MAC_FOCUSED_LIMITS = Object.freeze({workers: 1, heapMiB: 512,
  memoryBudgetBytes: 1024 ** 3, reserveBytes: 2 * 1024 ** 3,
  runtimeMs: 120_000, scratchBytes: 256 * 1024 ** 2, files: 4,
  sampleIntervalMs: 5000, sampleCount: 3, maximumSampleSpanMs: 30_000,
  swapInBytesPerSecond: 64 * 1024});

/** Large scoped runs remain supported, but receive no warning-pressure exception. */
export function focusedMacWorkload({scratchBytes, runtimeMs, files} = {}) {
  const limit = MAC_FOCUSED_LIMITS;
  if (![scratchBytes, runtimeMs].every(n => Number.isSafeInteger(n) && n > 0) ||
      scratchBytes > limit.scratchBytes || runtimeMs > limit.runtimeMs ||
      !Array.isArray(files) || !files.length || files.length > limit.files ||
      new Set(files).size !== files.length || files.some(p => typeof p !== 'string' || !/^test\/[^\0\r\n]+\.test\.ts$/.test(p) ||
        /[*?\[\]{}]/.test(p) || p.split('/').some(part => part === '.' || part === '..'))) return null;
  return {kind: 'explicit-scoped-tests-only', workers: limit.workers, heapMiB: limit.heapMiB,
    memoryBudgetBytes: limit.memoryBudgetBytes, scratchBytes, runtimeMs, files: [...files]};
}

function validFocusedWorkload(workload) {
  if (!workload || typeof workload !== 'object') return false;
  const expected = focusedMacWorkload(workload);
  return expected && ['kind', 'workers', 'heapMiB', 'memoryBudgetBytes'].every(k => workload[k] === expected[k]);
}

/** Native vm_stat snapshot, never interval output (whose first row is cumulative).
 * Free+inactive is an explicitly approximate planning input, not MemAvailable or
 * Activity Monitor's percentage. Do not add purgeable/file-backed overlapping sets. */
export function parseMacVmSample(text) {
  const page = String(text).match(/^Mach Virtual Memory Statistics: \(page size of ([0-9]+) bytes\)\s*$/m);
  const pageBytes = Number(page?.[1]);
  if (![4096, 16384, 65536].includes(pageBytes)) throw new Error('unknown native VM page size');
  const count = label => {
    const lines = String(text).split('\n').filter(line => line.startsWith(`${label}:`));
    if (lines.length !== 1 || !/^.*: +[0-9]+\.$/.test(lines[0])) throw new Error(`missing or malformed VM counter: ${label}`);
    const value = Number(lines[0].slice(lines[0].indexOf(':') + 1).trim().slice(0, -1));
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid VM counter: ${label}`);
    return value;
  };
  const freePlusInactiveBytesApprox = (count('Pages free') + count('Pages inactive')) * pageBytes;
  if (!Number.isSafeInteger(freePlusInactiveBytesApprox)) throw new Error('invalid VM headroom');
  return {pageBytes, freePlusInactiveBytesApprox, swapins: count('Swapins'), swapouts: count('Swapouts')};
}

function boundedMacRead(spawn, file, args) {
  const r = spawn(file, args, {encoding: 'utf8', timeout: 2000, maxBuffer: 4096,
    stdio: ['ignore', 'pipe', 'pipe']});
  if (r.status !== 0 || r.signal || r.error) throw new Error('focused memory probe did not complete');
  return r.stdout;
}

export function readMacFocusedSample({spawn = spawnSync, now = () => performance.now()} = {}) {
  const vm = parseMacVmSample(boundedMacRead(spawn, '/usr/bin/vm_stat', []));
  const pressure = macPressureState(boundedMacRead(spawn, '/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']));
  return {...vm, pressure, at: now()};
}

export function judgeFocusedMacSamples(workload, samples) {
  const reasons = [], limit = MAC_FOCUSED_LIMITS;
  if (!validFocusedWorkload(workload)) reasons.push('workload:outside-focused-policy');
  if (!Array.isArray(samples) || samples.length !== limit.sampleCount) reasons.push('samples:incomplete');
  if (reasons.length) return {state: 'not-run', reasons};
  const minimumHeadroomBytes = workload.memoryBudgetBytes + limit.reserveBytes;
  const window = judgeMacSampleWindow(samples, minimumHeadroomBytes, 'memory:below-focused-budget-and-reserve');
  if (window.invalid) return {state: 'not-run', reasons: window.reasons};
  return {state: window.reasons.length ? 'not-run' : 'admitted', reasons: window.reasons, minimumHeadroomBytes, spanMs: window.spanMs};
}

/** The focused sampling rule over one window of samples (oldest first): every sample known pressure and at least
 * `minimumHeadroomBytes` free+inactive, a steady clock and page size, no new swap-out and swap-in under the ceiling. */
function judgeMacSampleWindow(samples, minimumHeadroomBytes, headroomReason) {
  const reasons = [], limit = MAC_FOCUSED_LIMITS;
  if (samples.some(row => !row || ![row.at, row.freePlusInactiveBytesApprox, row.swapins, row.swapouts].every(n => Number.isFinite(n) && n >= 0) ||
    ![row.freePlusInactiveBytesApprox, row.swapins, row.swapouts].every(Number.isSafeInteger) ||
    ![4096, 16384, 65536].includes(row.pageBytes))) return {invalid: true, reasons: ['samples:invalid']};
  for (const [i, row] of samples.entries()) {
    if (!['normal', 'warning'].includes(row?.pressure)) reasons.push('pressure:critical-or-unknown');
    if (row.freePlusInactiveBytesApprox < minimumHeadroomBytes) reasons.push(headroomReason);
    if (i) {
      const previous = samples[i - 1], ms = row.at - previous.at;
      if (ms < limit.sampleIntervalMs || ms > limit.maximumSampleSpanMs || row.pageBytes !== previous.pageBytes)
        reasons.push('samples:unstable-clock-or-page-size');
      if (row.swapins < previous.swapins || row.swapouts < previous.swapouts) reasons.push('samples:counter-reset');
      if (row.swapouts !== previous.swapouts) reasons.push('paging:new-swap-out');
      if ((row.swapins - previous.swapins) * row.pageBytes > limit.swapInBytesPerSecond * ms / 1000)
        reasons.push('paging:swap-in-above-focused-ceiling');
    }
  }
  const spanMs = samples.at(-1).at - samples[0].at;
  if (spanMs > limit.maximumSampleSpanMs) reasons.push('samples:observation-too-long');
  return {reasons: [...new Set(reasons)], spanMs};
}

/** `sysctl -n vm.swapusage`, e.g. "total = 8192.00M  used = 6620.56M  free = 1571.44M  (encrypted)". */
export function parseMacSwapUsage(text) {
  const field = name => {
    const match = String(text).match(new RegExp(`(?:^|\\s)${name} = ([0-9]+(?:\\.[0-9]+)?)([KMGT])(?:\\s|$)`));
    if (!match) throw new Error(`missing or malformed swap field: ${name}`);
    const bytes = Math.round(Number(match[1]) * 1024 ** ' KMGT'.indexOf(match[2]));
    if (!Number.isSafeInteger(bytes)) throw new Error(`invalid swap field: ${name}`);
    return bytes;
  };
  return {swapTotalBytes: field('total'), swapUsedBytes: field('used'), swapFreeBytes: field('free')};
}

/** One W1-T10926 memory sample: the focused vm_stat and pressure reading plus how much swap is still free. */
export function readMacMemorySample({spawn = spawnSync, now = () => performance.now()} = {}) {
  const sample = readMacFocusedSample({spawn, now});
  const swap = parseMacSwapUsage(boundedMacRead(spawn, '/usr/sbin/sysctl', ['-n', 'vm.swapusage']));
  return {...sample, swapFreeBytes: swap.swapFreeBytes, swapUsedBytes: swap.swapUsedBytes};
}

/**
 * W1-T10926: may the stage `need` prices start on these samples (oldest first)? The latest sample decides the rule:
 * - normal: its free+inactive covers the measured peak and free swap covers the measured swap growth;
 * - warning: the focused runner's sampled window (its last sampleCount samples), priced at the measured peak plus the
 *   focused reserve instead of the focused budget, with free swap covering the growth on every sample;
 * - critical or unknown: never.
 */
export function judgeMacAuthorMemory(need, samples) {
  const limit = MAC_FOCUSED_LIMITS, latest = Array.isArray(samples) ? samples.at(-1) : undefined;
  if (!['normal', 'warning'].includes(latest?.pressure))
    return {admit: false, under: latest?.pressure ?? 'unknown', reasons: [`pressure:${latest?.pressure ?? 'unknown'}`]};
  const swapShort = row => !(Number.isSafeInteger(row?.swapFreeBytes) && row.swapFreeBytes >= need.swapGrowthBytes);
  if (latest.pressure === 'normal') {
    const reasons = [];
    if (!(Number.isSafeInteger(latest.freePlusInactiveBytesApprox) && latest.freePlusInactiveBytesApprox >= need.peakBytes))
      reasons.push('memory:below-measured-peak');
    if (swapShort(latest)) reasons.push('swap:below-measured-growth');
    return {admit: reasons.length === 0, under: 'normal', reasons, minimumHeadroomBytes: need.peakBytes};
  }
  const window = samples.slice(-limit.sampleCount), minimumHeadroomBytes = need.peakBytes + limit.reserveBytes;
  const reasons = window.length < limit.sampleCount ? ['samples:incomplete']
    : judgeMacSampleWindow(window, minimumHeadroomBytes, 'memory:below-measured-peak-and-reserve').reasons;
  if (window.some(swapShort)) reasons.push('swap:below-measured-growth');
  return {admit: reasons.length === 0, under: 'warning', reasons, minimumHeadroomBytes};
}

/** The fewest past waits whose nearest-rank p90 is not simply the longest of them (ceil(0.9 n) < n first at n = 10). */
const P90_MIN_HISTORY = (() => { let n = 1; while (Math.ceil(0.9 * n) >= n) n++; return n; })();

/**
 * W1-T10926: how long a stage may wait for memory, from that stage's OWN earlier waits (`pastWaits`, ms): their p90,
 * never shorter than one focused sampling window so a warning can ever be judged. With too few waits for a p90 it
 * falls back to the focused sampling rule's own observation span. No fixed number of seconds is chosen here.
 */
export function macPressureWaitLimit(pastWaits) {
  const focused = MAC_FOCUSED_LIMITS, windowMs = (focused.sampleCount - 1) * focused.sampleIntervalMs;
  const waits = (Array.isArray(pastWaits) ? pastWaits : []).filter(ms => Number.isFinite(ms) && ms >= 0).sort((a, b) => a - b);
  if (waits.length < P90_MIN_HISTORY)
    return {limitMs: focused.maximumSampleSpanMs, basis: 'focused-sampling-span', pastWaits: waits.length, needed: P90_MIN_HISTORY};
  const p90Ms = waits[Math.ceil(0.9 * waits.length) - 1];
  return {limitMs: Math.max(windowMs, p90Ms), basis: 'p90-of-past-waits', pastWaits: waits.length, p90Ms};
}

/** The native seams of the W1-T10926 wait. `pastWaits(stage)` is the stage's own earlier waits (none by default). */
export function macAuthorMemorySeams({spawn = spawnSync, now = () => Date.now(), pastWaits = () => [],
  wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)} = {}) {
  return {sample: () => readMacMemorySample({spawn, now}), now, wait, pastWaits};
}

/**
 * W1-T10926: the stage starts on the first sample `judgeMacAuthorMemory` admits and a fresh disk and pressure read
 * still agrees with; until then it samples at the focused interval. A disk shortfall on the fresh read, or a sample
 * that cannot be read, refuses at once. Past the wait limit it refuses, naming every sample it took.
 * `pressureWait` is recorded only when the stage did not start on its first sample: that is a wait.
 */
function awaitMacAuthorMemory(stage, need, first, reread, {sample, wait, now, pastWaits}) {
  const startedAt = now(), samples = [];
  let latest = first, verdict = {reasons: []}, limit;
  const record = outcome => ({outcome, waitedMs: Math.max(0, now() - startedAt), limitMs: limit?.limitMs ?? null,
    limitBasis: limit?.basis ?? null, pastWaits: limit?.pastWaits ?? null, failedChecks: verdict.reasons,
    samples: samples.map(row => ({atMs: Math.max(0, row.at - startedAt), pressure: row.pressure,
      freePlusInactiveBytes: row.freePlusInactiveBytesApprox, swapFreeBytes: row.swapFreeBytes ?? null, swapouts: row.swapouts}))});
  const waited = outcome => samples.length > 1 ? {pressureWait: record(outcome)} : {};
  const refuse = (admission, reasons) => ({...admission, state: 'not-run', reasons: [...new Set(reasons)],
    memoryNeed: need, ...waited('refused')});
  for (;;) {
    try { samples.push(sample()); }
    catch (error) { return refuse(latest, [...latest.reasons, `memory-sample:unavailable:${error.message}`]); }
    verdict = judgeMacAuthorMemory(need, samples);
    if (verdict.admit) {
      latest = reread();
      if (latest.reasons.some(reason => !reason.startsWith('pressure:'))) return refuse(latest, latest.reasons);
      // A fresh warning only stands behind a sampled warning window; a fresh critical or unknown keeps the stage waiting.
      if (latest.pressure === 'normal' || (latest.pressure === 'warning' && verdict.under === 'warning'))
        return {...latest, state: 'admitted', reasons: [], memoryNeed: need, admittedUnder: verdict.under, ...waited('admitted')};
    }
    limit ??= macPressureWaitLimit(pastWaits(stage));
    if (now() - startedAt >= limit.limitMs)
      return {...refuse(latest, [...latest.reasons, ...verdict.reasons]), pressureWait: record('refused')};
    wait(MAC_FOCUSED_LIMITS.sampleIntervalMs);
  }
}

/** Opt-in seam used ONLY by the bounded low-footprint runner. The full-author
 * entrypoint never calls it, and readMacAuthorAdmission remains normal-only. */
export function readMacFocusedAdmission(root, {workload, spawn = spawnSync,
  now = () => performance.now(), wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  sample = () => readMacFocusedSample({spawn, now}), ...options} = {}) {
  const initial = readMacAuthorAdmission(root, {...options, spawn});
  if (!validFocusedWorkload(workload)) return {...initial, state: 'not-run',
    reasons: [...initial.reasons, 'workload:outside-focused-policy']};
  if (initial.state !== 'not-run' || initial.reasons.length !== 1 || initial.reasons[0] !== 'pressure:warning')
    return {...initial, workload};
  const samples = [];
  try {
    for (let i = 0; i < MAC_FOCUSED_LIMITS.sampleCount; i++) {
      if (i) wait(MAC_FOCUSED_LIMITS.sampleIntervalMs);
      samples.push(sample());
    }
    const measured = judgeFocusedMacSamples(workload, samples);
    // Disk and pressure can change while observing. Never rescue a later refusal.
    const fresh = readMacAuthorAdmission(root, {...options, spawn});
    const freshReasons = fresh.reasons.filter(reason => reason !== 'pressure:warning');
    const reasons = [...measured.reasons, ...freshReasons];
    return {...fresh, state: reasons.length ? 'not-run' : 'admitted', reasons, workload,
      focusedObservation: {...measured, samples}};
  } catch (error) {
    return {...initial, workload, reasons: [...initial.reasons, `focused-observation:unavailable:${error.message}`],
      focusedObservation: {state: 'not-run', samples}};
  }
}
