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
export const MAC_AUTHOR_MEASURED_PEAK_BYTES = Object.freeze({
  entry: 256 * 1024 ** 2,
  'static-preflight': 256 * 1024 ** 2,
  'affected-tests-per-worker': 256 * 1024 ** 2,
});
const SIZED_SELECTIONS = new Set(['plan-only', 'affected-narrow', 'affected-floor']);

/** The disk reserve one author phase needs: the OS floor plus a safety factor over that phase's measured peak,
 * never above the 20 GiB full-run reserve. A full fallback, an unknown selection or an unmeasured phase keeps
 * the full reserve, so the bound only ever relaxes where a measurement backs it. */
export function macAuthorReserveBytes({stage, selection, workers} = {}) {
  const full = {bytes: MAC_AUTHOR_FREE_RESERVE_BYTES, basis: 'existing-20GiB'};
  const peak = MAC_AUTHOR_MEASURED_PEAK_BYTES;
  let measured;
  if (stage === 'entry') measured = peak.entry;
  else if (!SIZED_SELECTIONS.has(selection)) return full;
  else if (stage === 'static-preflight') measured = peak['static-preflight'];
  else if (stage === 'affected-tests' && Number.isSafeInteger(workers) && workers >= 1)
    measured = peak['affected-tests-per-worker'] * workers;
  if (!Number.isSafeInteger(measured) || measured <= 0) return full;
  const bytes = MAC_AUTHOR_OS_FLOOR_BYTES + MAC_AUTHOR_PEAK_SAFETY_FACTOR * measured;
  return bytes >= full.bytes ? full : {bytes, basis: `measured-${stage}`};
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
    pressure: 'unknown', reasons: []};
  const below = allocations ? `below-${reserveBasis ?? 'bounded-profile'}-reserve`
    : minimumFreeBytes === MAC_AUTHOR_FREE_RESERVE_BYTES ? 'below-existing-20GiB-reserve'
    : reserveBasis ? `below-${reserveBasis}-reserve` : 'below-bounded-job-reserve';
  const targets = allocations ? allocations.map(row => [row.key, row.path, row.minimumFreeBytes])
    : [['workspaceFreeBytes', root, minimumFreeBytes], ['scratchFreeBytes', scratch, minimumFreeBytes]];
  for (const [key, path, required] of targets) {
    const label = allocations ? `allocation:${key}` : key;
    try {
      const fs = statfs(path), bytes = fs.bavail * fs.bsize;
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid filesystem capacity');
      if (allocations) result.allocationFreeBytes[key] = bytes; else result[key] = bytes;
      if (bytes < required) result.reasons.push(`${label}:${below}`);
    } catch (error) {
      result.reasons.push(`${label}:unavailable:${error.code ?? error.message}`);
    }
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
 * when it genuinely applies to `context` (and `bound`); otherwise it keeps that existing reserve and says why. */
export function requireMacAuthorCapacity(root, stage, readAdmission = readMacAuthorAdmission, workload = undefined) {
  const {boundedProfile, context, bound, ...sizing} = workload ?? {};
  const bounded = workload && Object.hasOwn(workload, 'boundedProfile')
    ? boundedAuthorRequirement(boundedProfile, {context, bound}) : undefined;
  let admission;
  if (bounded?.state === 'bounded') {
    admission = readAdmission(root, {reserveBasis: 'bounded-profile',
      minimumFreeBytes: Math.max(...bounded.filesystems.map(row => row.minimumFreeBytes)),
      allocations: bounded.filesystems.map(({key, path, minimumFreeBytes}) => ({key, path, minimumFreeBytes}))});
  } else {
    const reserve = macAuthorReserveBytes({stage, ...sizing});
    admission = readAdmission(root, {minimumFreeBytes: reserve.bytes, reserveBasis: reserve.basis});
  }
  if (bounded) admission = {...admission, boundedProfile: bounded};
  if (admission.state !== 'admitted' && admission.state !== 'not-applicable')
    throw new MacAuthorCapacityRefusal(stage, admission);
  return {stage, ...admission};
}

/** The CLI boundary is guarded; direct main() fixtures remain explicit algorithm tests.
 * --help/--dry-run are read-only and never acquire a slot or start static/test work.
 * The entry check reserves only what selection and the census need; each heavy phase is
 * admitted again, against the reserve its own selection requires, once that selection is known. */
export function guardedAuthorEntry(argv, {root, readAdmission = readMacAuthorAdmission,
  runAuthor, reportRefusal = reportMacAuthorRefusal} = {}) {
  if (argv.some(arg => ['--help', '-h', '--dry-run'].includes(arg))) return runAuthor(argv);
  const entry = macAuthorReserveBytes({stage: 'entry'});
  const admission = readAdmission(root, {minimumFreeBytes: entry.bytes, reserveBasis: entry.basis});
  if (admission.state === 'admitted' || admission.state === 'not-applicable')
    return runAuthor(argv, {admitHost: (stage, workload) => requireMacAuthorCapacity(root, stage, readAdmission, workload)});
  reportRefusal(root, admission);
  return 3;
}

/** A refusal deliberately produces no author assurance. Never reuse an old PASS receipt. */
function reportMacAuthorRefusal(root, admission) {
  console.error(`author preflight NOT_RUN: ${JSON.stringify(admission)}`);
  console.error('No slot, static checks, tests, dependency installation, cleanup or process termination started.');
  console.error(`Any older ${root}/coverage/preflight-author.json is NOT evidence for this invocation.`);
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
  if (samples.some(row => !row || ![row.at, row.freePlusInactiveBytesApprox, row.swapins, row.swapouts].every(n => Number.isFinite(n) && n >= 0) ||
    ![row.freePlusInactiveBytesApprox, row.swapins, row.swapouts].every(Number.isSafeInteger) ||
    ![4096, 16384, 65536].includes(row.pageBytes))) return {state: 'not-run', reasons: ['samples:invalid']};
  for (const [i, row] of samples.entries()) {
    if (!['normal', 'warning'].includes(row?.pressure)) reasons.push('pressure:critical-or-unknown');
    if (row.freePlusInactiveBytesApprox < minimumHeadroomBytes) reasons.push('memory:below-focused-budget-and-reserve');
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
  return {state: reasons.length ? 'not-run' : 'admitted', reasons: [...new Set(reasons)],
    minimumHeadroomBytes, spanMs};
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
