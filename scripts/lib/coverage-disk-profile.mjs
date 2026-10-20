import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, statfsSync } from 'node:fs';
import { MAC_AUTHOR_FREE_RESERVE_BYTES } from './mac-author-admission.mjs';

function validProfile(profile) {
  return profile && typeof profile === 'object' && !Array.isArray(profile) &&
    ['minimumFreeBytes', 'reservedBytes', 'estimatedPeakBytes'].every(key => Number.isSafeInteger(profile[key]) && profile[key] >= 0) &&
    profile.minimumFreeBytes >= MAC_AUTHOR_FREE_RESERVE_BYTES;
}

/** An omitted profile means the existing reserve only, not a claim of a zero-byte peak. */
export function coverageDiskProfile(file, { read = readSync } = {}) {
  if (file === undefined) return { mode: 'existing-floor-only', profile: {
    minimumFreeBytes: MAC_AUTHOR_FREE_RESERVE_BYTES, reservedBytes: 0, estimatedPeakBytes: 0,
  }, estimatedPeakBasis: 'not-supplied' };
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > 16384) throw new Error('disk profile must be a bounded regular JSON file');
    const bytes = Buffer.alloc(before.size + 1), count = read(fd, bytes, 0, bytes.length, 0), after = fstatSync(fd), path = lstatSync(file);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        path.isSymbolicLink() || path.dev !== before.dev || path.ino !== before.ino || path.uid !== before.uid)
      throw new Error('disk profile changed or was read incompletely');
    const profile = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    if (!validProfile(profile)) throw new Error('disk profile cannot lower the existing coverage reserve');
    return { mode: 'profiled', profile: { minimumFreeBytes: profile.minimumFreeBytes,
      reservedBytes: profile.reservedBytes, estimatedPeakBytes: profile.estimatedPeakBytes }, estimatedPeakBasis: 'declared-profile' };
  } finally { closeSync(fd); }
}

/** Check every allocation path, including an external TMPDIR. Unknown capacity never admits work. */
export function coverageDiskAdmission(paths, profile, { statfs = statfsSync } = {}) {
  if (!validProfile(profile) || !Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== 'string' || !path))
    return { state: 'unknown', reason: 'invalid disk profile or allocation paths', checks: [] };
  const checks = [...new Set(paths)].map(path => {
    try {
      const fs = statfs(path), availableBytes = fs.bavail * fs.bsize;
      if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) throw new Error('invalid filesystem capacity');
      return { path, availableBytes, state: BigInt(availableBytes) >= BigInt(profile.reservedBytes) + BigInt(profile.estimatedPeakBytes) + BigInt(profile.minimumFreeBytes)
        ? 'admitted' : 'not-run-disk-capacity' };
    } catch (error) { return { path, availableBytes: null, state: 'unknown', reason: error.code ?? error.message }; }
  });
  return { state: checks.some(item => item.state === 'unknown') ? 'unknown' :
    checks.some(item => item.state !== 'admitted') ? 'not-run-disk-capacity' : 'admitted', checks };
}
