// Read-only phase observations. Never admission, policy tuning, cleanup or test verdicts.
import {closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statfsSync} from 'node:fs';
import {resourceUsage} from 'node:process';
import {dirname} from 'node:path';

const integer = n => Number.isSafeInteger(n) && n >= 0;
const identity = st => `${st.dev}:${st.ino}`;
function boundedText(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 1024) throw new Error('resource-file-not-bounded-regular');
    const bytes = Buffer.alloc(1025), size = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd), named = lstatSync(path);
    if (size > 1024 || identity(before) !== identity(after) || identity(after) !== identity(named))
      throw new Error('resource-file-unavailable-or-replaced');
    return bytes.subarray(0, size).toString('utf8').trim();
  } finally { closeSync(fd); }
}
function unsigned(text) {
  if (!/^(0|[1-9][0-9]*)$/.test(text) || !integer(Number(text))) throw new Error('invalid-resource-counter');
  return Number(text);
}

export function sampleAuthorResources({platform = process.platform, usage = resourceUsage,
  cgroupRoot = '/sys/fs/cgroup', selfCgroup = '/proc/self/cgroup'} = {}) {
  const result = {version: 1, observerMaxRSSBytes: null, observerScope: 'capture-helper-lifetime-only',
    cgroup: {state: 'unavailable', identity: null, currentBytes: null, lifetimePeakBytes: null,
      basis: 'current-cgroup-and-descendants-lifetime; not stage peak'}, reasons: []};
  try {
    const rss = usage().maxRSS;
    if (!integer(rss) || !integer(rss * 1024)) throw new Error('invalid-observer-rss');
    result.observerMaxRSSBytes = rss * 1024; // Node/libuv reports KiB on supported platforms.
  } catch { result.reasons.push('observer-resource-usage-unavailable'); }
  if (platform !== 'linux') { result.reasons.push('cgroup-v2-not-this-platform'); return result; }
  try {
    // Only the namespace's own cgroup root. A host path is not a workload measurement.
    if (boundedText(selfCgroup) !== '0::/') throw new Error('exclusive-cgroup-namespace-root-unavailable');
    const before = lstatSync(cgroupRoot);
    if (!before.isDirectory() || before.isSymbolicLink() || realpathSync(cgroupRoot) !== cgroupRoot)
      throw new Error('cgroup-root-not-literal');
    const current = unsigned(boundedText(`${cgroupRoot}/memory.current`));
    const peak = unsigned(boundedText(`${cgroupRoot}/memory.peak`));
    const after = lstatSync(cgroupRoot);
    if (identity(before) !== identity(after) || peak < current) throw new Error('cgroup-identity-or-counter-changed');
    result.cgroup = {...result.cgroup, state: 'observed', identity: identity(after), currentBytes: current,
      lifetimePeakBytes: peak, source: cgroupRoot === '/sys/fs/cgroup' && selfCgroup === '/proc/self/cgroup'
        ? 'native-own-namespace-root' : 'explicit-fixture-root'};
  } catch (error) { result.reasons.push(error.code ?? error.message); }
  return result;
}

export function authorResourceEvidence(before, after, output = {}) {
  const a = before?.cgroup, b = after?.cgroup;
  const compatible = a?.state === 'observed' && b?.state === 'observed' &&
    typeof a.identity === 'string' && a.identity.length > 0 && a.identity === b.identity &&
    ['native-own-namespace-root', 'explicit-fixture-root'].includes(a.source) && a.source === b.source &&
    [a.currentBytes, b.currentBytes, a.lifetimePeakBytes, b.lifetimePeakBytes].every(integer) &&
    a.lifetimePeakBytes >= a.currentBytes && b.lifetimePeakBytes >= b.currentBytes &&
    b.lifetimePeakBytes >= a.lifetimePeakBytes;
  return {version: 1, sampling: 'phase-boundaries', workloadPeakBytes: null,
    workloadPeakState: 'unavailable-no-per-stage-kernel-peak',
    cgroupPeakLifetimeUpperBoundBytes: compatible ? b.lifetimePeakBytes : null,
    cgroupCurrentObservedMaxBytes: compatible ? Math.max(a.currentBytes, b.currentBytes) : null,
    memoryScope: compatible ? b.basis : 'unavailable-or-changed-cgroup',
    observerMaxRSSBytes: integer(after?.observerMaxRSSBytes) ? after.observerMaxRSSBytes : null,
    observerScope: 'capture-helper-lifetime-only; not child or process-tree peak',
    outputObservedBytes: integer(output.observedBytes) ? output.observedBytes : null,
    outputStoredBytes: integer(output.storedBytes) ? output.storedBytes : null,
    outputBasis: 'capture stream bytes; not unique disk allocation',
    samples: [before, after], admissionAuthorized: false, policyChanged: false};
}

export function pinAuthorScratch(path) {
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(path) !== path)
    throw new Error('scratch-resource-root-not-literal-directory');
  return {path, identity: identity(st), separateVolumeRoot: lstatSync(dirname(path)).dev !== st.dev};
}

export function sampleAuthorScratch(pin) {
  const result = {state: 'unavailable', volumeUsedBytes: null, availableBytes: null,
    identity: pin?.identity ?? null, separateVolumeRoot: pin?.separateVolumeRoot === true,
    basis: 'filesystem containing pinned scratch root; not per-directory or APFS unique bytes'};
  try {
    const before = lstatSync(pin.path);
    if (!before.isDirectory() || before.isSymbolicLink() || realpathSync(pin.path) !== pin.path ||
        identity(before) !== pin.identity) throw new Error('scratch-resource-identity-changed');
    const fs = statfsSync(pin.path), after = lstatSync(pin.path);
    const used = (fs.blocks - fs.bfree) * fs.bsize, available = fs.bavail * fs.bsize;
    if (identity(after) !== pin.identity || !integer(used) || !integer(available))
      throw new Error('scratch-resource-counter-unavailable');
    return {...result, state: 'observed', volumeUsedBytes: used, availableBytes: available};
  } catch (error) { return {...result, reason: error.code ?? error.message}; }
}

export function authorScratchEvidence(samples, {childClosureProven = false, cleanup = 'unknown'} = {}) {
  const first = samples[0], last = samples.at(-1);
  const complete = samples.length >= 2 && samples.every(s => s.state === 'observed' &&
    s.identity === first.identity && integer(s.volumeUsedBytes));
  const separateVolume = complete && samples.every(s => s.separateVolumeRoot === true);
  return {version: 1, sampling: 'phase-boundaries; may miss transient growth', samples,
    completeness: complete ? 'boundary-observations-only' : 'unavailable-or-partial',
    observedMaxVolumeUsedBytes: complete ? Math.max(...samples.map(s => s.volumeUsedBytes)) : null,
    volumeAttribution: separateVolume ? 'separate-filesystem-root' : 'shared-or-unproven-filesystem',
    boundaryGrowthBytes: separateVolume ? last.volumeUsedBytes - first.volumeUsedBytes : null,
    retainedVolumeUsedBytesAtChildClosure: separateVolume && childClosureProven ? last.volumeUsedBytes : null,
    childClosureProven, cleanup, physicalReclaimedBytes: null, admissionAuthorized: false};
}
