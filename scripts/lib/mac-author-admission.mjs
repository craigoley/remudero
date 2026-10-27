// Capacity admission for NEW Mac author jobs. No process control, cleanup, or Linux policy changes.
import {spawnSync} from 'node:child_process';
import {statfsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';

// Matches ci-parity's existing local coverage scratch reserve; this does not lower that gate.
export const MAC_AUTHOR_FREE_RESERVE_BYTES = 20 * 1024 ** 3;

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

export function readMacAuthorAdmission(root, {platform = process.platform, scratch = tmpdir(),
  statfs = statfsSync, spawn = spawnSync, minimumFreeBytes = MAC_AUTHOR_FREE_RESERVE_BYTES, reserveBasis} = {}) {
  if (platform !== 'darwin') return {state: 'not-applicable', platform, reasons: []};
  if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes <= 0) throw new Error('invalid author disk reserve');
  const result = {state: 'not-run', platform, minimumFreeBytes, ...(reserveBasis ? {reserveBasis} : {}),
    workspaceFreeBytes: null, scratchFreeBytes: null, pressure: 'unknown', reasons: []};
  for (const [key, path] of [['workspaceFreeBytes', root], ['scratchFreeBytes', scratch]]) {
    try {
      const fs = statfs(path), bytes = fs.bavail * fs.bsize;
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid filesystem capacity');
      result[key] = bytes;
      if (bytes < minimumFreeBytes) result.reasons.push(`${key}:${minimumFreeBytes === MAC_AUTHOR_FREE_RESERVE_BYTES
        ? 'below-existing-20GiB-reserve' : reserveBasis ? `below-${reserveBasis}-reserve` : 'below-bounded-job-reserve'}`);
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

/** `workload` ({selection, workers}) sizes the reserve (W1-T10765); without one a phase keeps the full reserve. */
export function requireMacAuthorCapacity(root, stage, readAdmission = readMacAuthorAdmission, workload = undefined) {
  const reserve = macAuthorReserveBytes({stage, ...workload});
  const admission = readAdmission(root, {minimumFreeBytes: reserve.bytes, reserveBasis: reserve.basis});
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
