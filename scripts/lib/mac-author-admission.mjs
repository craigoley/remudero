// Capacity admission for NEW Mac author jobs. No process control, cleanup, or Linux policy changes.
import {spawnSync} from 'node:child_process';
import {statfsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';

// Matches ci-parity's existing local coverage scratch reserve; this does not lower that gate.
export const MAC_AUTHOR_FREE_RESERVE_BYTES = 20 * 1024 ** 3;

/** Opt-in ordinary author budget. These are declared limits, not learned peak
 * measurements. Each phase is bounded and fixtures use a fixed native volume;
 * workspace diagnostics are separately bounded by phase count and output size.
 * Full ci-parity coverage retains its own independent 20-GiB admission policy. */
export function boundedAuthorWorkload(scratchMiB) {
  if (!Number.isSafeInteger(scratchMiB) || scratchMiB < 16 || scratchMiB > 256)
    throw new TypeError('bounded author scratch must be an integer from 16 through 256 MiB');
  const scratchBytes = scratchMiB * 1024 ** 2;
  const stepOutputBytes = 8 * 1024 ** 2, maximumPhases = 32;
  return Object.freeze({kind: 'bounded-ordinary-mac-author', workers: 1, heapMiB: 1024, semiSpaceMiB: 16,
    scratchBytes, stepOutputBytes, stepRuntimeMs: 120_000, maximumPhases,
    systemReserveBytes: 4 * 1024 ** 3, metadataReserveBytes: 16 * 1024 ** 2,
    minimumFreeBytes: 4 * 1024 ** 3 + 2 * scratchBytes + maximumPhases * stepOutputBytes + 16 * 1024 ** 2});
}

/** Parse both Node CLI spellings once, before choosing the real admission seam.
 * A duplicate never lets the admitted budget differ from the executing budget. */
export function boundedAuthorWorkloadFromArgv(argv) {
  const beforeSeparator = argv.slice(0, argv.includes('--') ? argv.indexOf('--') : argv.length);
  const flags = beforeSeparator.flatMap((value, i) => value === '--bounded-scratch-mib'
    ? [{value: beforeSeparator[i + 1]}] : value.startsWith('--bounded-scratch-mib=')
      ? [{value: value.slice('--bounded-scratch-mib='.length)}] : []);
  if (!flags.length) return undefined;
  if (flags.length !== 1) throw new TypeError('bounded author scratch may be declared only once');
  return boundedAuthorWorkload(Number(flags[0].value));
}

/** XNU's sysctl returns DISPATCH/NOTE flags (1,2,4), NOT its internal 0..4 pressure enum.
 * See apple-oss-distributions/xnu/bsd/kern/kern_memorystatus_notify.c. */
export function macPressureState(text) {
  const value = String(text).trim();
  return value === '1' ? 'normal' : value === '2' ? 'warning' : value === '4' ? 'critical' : 'unknown';
}

export function readMacAuthorAdmission(root, {platform = process.platform, scratch = tmpdir(),
  statfs = statfsSync, spawn = spawnSync, minimumFreeBytes = MAC_AUTHOR_FREE_RESERVE_BYTES} = {}) {
  if (platform !== 'darwin') return {state: 'not-applicable', platform, reasons: []};
  if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes <= 0) throw new Error('invalid author disk reserve');
  const result = {state: 'not-run', platform, minimumFreeBytes,
    workspaceFreeBytes: null, scratchFreeBytes: null, pressure: 'unknown', reasons: []};
  for (const [key, path] of [['workspaceFreeBytes', root], ['scratchFreeBytes', scratch]]) {
    try {
      const fs = statfs(path), bytes = fs.bavail * fs.bsize;
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid filesystem capacity');
      result[key] = bytes;
      if (bytes < minimumFreeBytes) result.reasons.push(`${key}:${minimumFreeBytes === MAC_AUTHOR_FREE_RESERVE_BYTES
        ? 'below-existing-20GiB-reserve' : 'below-bounded-job-reserve'}`);
    } catch (error) {
      result.reasons.push(`${key}:unavailable:${error.code ?? error.message}`);
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

export class MacAuthorCapacityRefusal extends Error {
  constructor(stage, admission) {
    super(`Mac author capacity NOT_RUN before ${stage}: ${JSON.stringify(admission)}`);
    this.stage = stage;
    this.admission = admission;
  }
}

export function requireMacAuthorCapacity(root, stage, readAdmission = readMacAuthorAdmission) {
  const admission = readAdmission(root);
  if (admission.state !== 'admitted' && admission.state !== 'not-applicable')
    throw new MacAuthorCapacityRefusal(stage, admission);
  return {stage, ...admission};
}

/** Wait only for a not-yet-started phase in this invocation. No check is retried,
 * capacity threshold changed, foreign process controlled or new lease acquired. */
export const MAC_AUTHOR_PHASE_WAIT_MS = 120_000;
const pauseAdmission = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function waitForMacAuthorCapacity(root, stage, readAdmission = readMacAuthorAdmission,
  {waitBoundMs = MAC_AUTHOR_PHASE_WAIT_MS, pollMs = 2000, now = () => performance.now(),
    pause = pauseAdmission, refresh = () => {}} = {}) {
  if (!Number.isSafeInteger(waitBoundMs) || waitBoundMs < 0 || waitBoundMs > MAC_AUTHOR_PHASE_WAIT_MS ||
      !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 2000)
    throw new TypeError('invalid bounded author phase admission wait');
  const started = now();
  if (!Number.isFinite(started)) throw new TypeError('invalid monotonic admission clock');
  const observations = [];
  let previous = started;
  // The probe count is bounded even if an injected clock or pause never advances.
  const maxReads = Math.ceil(waitBoundMs / pollMs) + 1;
  for (let read = 0; read < maxReads; read++) {
    const admission = readAdmission(root), at = now();
    if (!Number.isFinite(at) || at < previous) throw new TypeError('invalid monotonic admission clock');
    previous = at;
    const waitedMs = at - started;
    const result = {stage, ...admission, waitBoundMs, waitedMs, observations: [...observations]};
    if (admission.state === 'admitted' || admission.state === 'not-applicable') return result;
    observations.push({waitedMs, state: admission.state, reasons: admission.reasons ?? []});
    if (waitedMs >= waitBoundMs || read + 1 === maxReads)
      throw new MacAuthorCapacityRefusal(stage, {...admission, waitBoundMs, waitedMs, observations});
    refresh();
    pause(Math.min(pollMs, waitBoundMs - waitedMs));
  }
}

/** The CLI boundary is guarded; direct main() fixtures remain explicit algorithm tests.
 * --help/--dry-run are read-only and never acquire a slot or start static/test work. */
export function guardedAuthorEntry(argv, {root, readAdmission = readMacAuthorAdmission,
  runAuthor, reportRefusal = reportMacAuthorRefusal, phaseWaitMs = MAC_AUTHOR_PHASE_WAIT_MS} = {}) {
  if (argv.some(arg => ['--help', '-h', '--dry-run'].includes(arg))) return runAuthor(argv);
  const admission = readAdmission(root);
  if (admission.state === 'admitted' || admission.state === 'not-applicable')
    return runAuthor(argv, {admitHost: (stage, options) => waitForMacAuthorCapacity(root, stage, readAdmission,
      {waitBoundMs: phaseWaitMs, refresh: options?.refresh})});
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
