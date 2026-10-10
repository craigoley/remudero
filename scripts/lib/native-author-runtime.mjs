import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { availableParallelism, cpus, hostname, release } from 'node:os';
import { listTestFiles, medianMeasuredDurationMs, predictMakespanMs, weightedDurationMs } from '../test-tier-manifest.mjs';

export const RUNTIME_PROFILE_FORMAT = 'rmd-native-author-runtime-v1';
export const AUTHOR_STATIC_RESERVE_MS = 15 * 60_000;
export const AUTHOR_SHUTDOWN_RESERVE_MS = 30_000;
export const AUTHOR_RUNTIME_SAFETY_FACTOR = 1.25;
export const RUNTIME_PROFILE_MAX_AGE_MS = 24 * 60 * 60_000;
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Native timing evidence has no authority to certify tests or change the admitted pool. */
export function runtimeBindings(root, head, env = process.env) {
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('runtime profile: unresolved source head');
  if (env.NODE_OPTIONS?.trim()) throw new Error('runtime profile: NODE_OPTIONS instrumentation is not modelled');
  if (sourceHead(root) !== head || execFileSync('git', ['status', '--porcelain'],
    { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim()) {
    throw new Error('runtime profile: source/runtime/corpus binding mismatch; committed inputs changed');
  }
  const inputTree = execFileSync('git', ['rev-parse', `${head}^{tree}`],
    { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim();
  if (!/^[a-f0-9]{40}$/.test(inputTree)) throw new Error('runtime profile: unresolved committed input tree');
  const files = listTestFiles(root).sort();
  const hashes = Object.fromEntries(['.nvmrc', 'package-lock.json', 'test/setup/tmp-hygiene.ts',
    'scripts/test-tier-manifest.json'].map((file) => [file, digest(readFileSync(join(root, file)))]));
  const corpusSha256 = digest(files.map((file) => `${file}:${digest(readFileSync(join(root, file)))}`).join('\n'));
  const tsx = JSON.parse(readFileSync(join(root, 'node_modules/tsx/package.json'), 'utf8')).version;
  const environmentSha256 = digest(JSON.stringify(Object.fromEntries(['TZ', 'LANG', 'LC_ALL', 'NODE_ENV']
    .map((key) => [key, env[key] ?? null]))));
  return { head, inputTree, platform: process.platform, arch: process.arch, node: process.version,
    host: hostname(), kernel: release(), cores: availableParallelism(), cpuModel: cpus()[0]?.model ?? 'unavailable',
    v8: process.versions.v8, loader: `tsx@${tsx}`, instrumentation: 'none',
    testIsolation: 'process', setup: './test/setup/tmp-hygiene.ts', environmentSha256,
    corpusSha256, corpusFiles: files.length, hashes };
}

export function runtimeSamples(files, manifest, count = 32) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('runtime sample count must be positive');
  const median = medianMeasuredDurationMs(manifest);
  const ordered = [...files].sort((a, b) => weightedDurationMs(a, manifest, median) -
    weightedDurationMs(b, manifest, median) || a.localeCompare(b));
  const n = Math.min(count, ordered.length);
  return [...new Set(Array.from({ length: n }, (_, i) => ordered[n === 1 ? 0 :
    Math.floor(i * (ordered.length - 1) / (n - 1))]))].sort();
}

function readArtifactBytes(root, path, maxBytes, oversizedMessage) {
  const absolute = resolve(root, path);
  const coverage = resolve(root, 'coverage');
  if (!absolute.startsWith(coverage + sep)) {
    throw new Error('runtime profile: evidence must be a regular file under owned coverage');
  }
  const ownedCoverage = realpathSync(coverage);
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') {
    throw new Error('runtime profile: no-follow/nonblocking reads unavailable');
  }
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    const canonical = realpathSync(absolute);
    const currentPath = lstatSync(absolute);
    if (!canonical.startsWith(ownedCoverage + sep) || !currentPath.isFile() ||
        currentPath.dev !== opened.dev || currentPath.ino !== opened.ino) {
      throw new Error('runtime profile: evidence must be a regular file under owned coverage');
    }
    if (!opened.isFile() || opened.size > maxBytes) throw new Error(oversizedMessage);

    // Read only the descriptor we validated, with a hard bound even if another process grows it.
    const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1));
    const chunks = [];
    let length = 0;
    while (length <= maxBytes) {
      const read = readSync(fd, chunk, 0, Math.min(chunk.length, maxBytes + 1 - length), null);
      if (read === 0) break;
      chunks.push(Buffer.from(chunk.subarray(0, read)));
      length += read;
    }
    if (length > maxBytes) throw new Error(oversizedMessage);
    const after = fstatSync(fd);
    if (after.size !== opened.size || length !== after.size ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error('runtime profile: evidence changed during its descriptor read');
    }
    return Buffer.concat(chunks, length);
  } finally {
    closeSync(fd);
  }
}

/** Re-read every closed capture, rather than trusting a success-shaped profile field. */
export function readRuntimeProfile(root, path, expected, now = Date.now()) {
  const profile = JSON.parse(readArtifactBytes(root, path, 2 * 1024 * 1024,
    'runtime profile: oversized evidence').toString('utf8'));
  const observed = profile.bindings;
  if (profile.format !== RUNTIME_PROFILE_FORMAT || !observed ||
      !/^[a-f0-9]{40}$/.test(observed.head) || !/^[a-f0-9]{40}$/.test(observed.inputTree) ||
      expected.head !== sourceHead(root) ||
      JSON.stringify({ ...observed, head: null }) !== JSON.stringify({ ...expected, head: null })) {
    throw new Error('runtime profile: source/runtime/corpus binding mismatch');
  }
  // Reuse timing only across metadata-only commits. The entire tracked tree remains
  // an input until a separately proved narrower dependency declaration can replace it.
  let observedTree;
  try { observedTree = execFileSync('git', ['rev-parse', `${observed.head}^{tree}`],
    { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim(); }
  catch { throw new Error('runtime profile: source/runtime/corpus binding mismatch; observed commit unavailable'); }
  if (observedTree !== observed.inputTree) throw new Error('runtime profile: source/runtime/corpus binding mismatch; observed inputs differ');
  const age = now - Date.parse(profile.at);
  if (!Number.isFinite(age) || age < 0 || age > RUNTIME_PROFILE_MAX_AGE_MS) throw new Error('runtime profile: stale or future observation');
  if (!Number.isSafeInteger(profile.concurrency) || profile.concurrency < 1 || profile.concurrency > 4) {
    throw new Error('runtime profile: invalid measured concurrency');
  }
  const artifacts = {};
  if (profile.artifacts?.length !== 4) throw new Error('runtime profile: missing closed capture');
  for (const row of profile.artifacts ?? []) {
    if (!['stdout', 'stderr', 'native', 'durations'].includes(row.name) || Object.hasOwn(artifacts, row.name)) throw new Error('runtime profile: duplicate or unexpected artifact');
    const bytes = readArtifactBytes(root, row.path, 100 * 1024 * 1024,
      'runtime profile: oversized capture artifact');
    if (bytes.length !== row.bytes || digest(bytes) !== row.sha256) throw new Error('runtime profile: artifact hash mismatch');
    artifacts[row.name] = bytes.toString('utf8');
  }
  if (!['stdout', 'stderr', 'native', 'durations'].every((name) => Object.hasOwn(artifacts, name))) {
    throw new Error('runtime profile: missing closed capture');
  }
  const native = JSON.parse(artifacts.native), duration = JSON.parse(artifacts.durations);
  if (native.status !== 0 || native.signal || native.error || native.outputComplete !== true ||
      native.observedBytes !== native.storedBytes || native.storedBytes !==
      Buffer.byteLength(artifacts.stdout) + Buffer.byteLength(artifacts.stderr)) {
    throw new Error('runtime profile: incomplete or unsuccessful native capture');
  }
  const output = artifacts.stdout + '\n' + artifacts.stderr;
  if (!/^# tests [1-9][0-9]*$/m.test(output) || !/^# pass [1-9][0-9]*$/m.test(output) ||
      !['fail', 'cancelled', 'todo'].every((key) => new RegExp(`^# ${key} 0$`, 'm').test(output))) {
    throw new Error('runtime profile: no complete successful test summary');
  }
  const files = Object.keys(duration.files ?? {}).sort();
  const physical = listTestFiles(root).sort(), known = new Set(physical);
  const manifest = JSON.parse(readFileSync(join(root, 'scripts/test-tier-manifest.json'), 'utf8'));
  if (duration.version !== 1 || files.length < Math.min(32, expected.corpusFiles) ||
      JSON.stringify(files) !== JSON.stringify(profile.samples) ||
      JSON.stringify(files) !== JSON.stringify(runtimeSamples(physical, manifest)) ||
      JSON.stringify(duration.files) !== JSON.stringify(profile.files) ||
      files.some((file) => !known.has(file) || !/^test\/.*\.test\.ts$/.test(file) ||
        !lstatSync(join(root, file)).isFile() || !Number.isFinite(duration.files[file]) || duration.files[file] <= 0)) {
    throw new Error('runtime profile: incomplete physical sample durations');
  }
  return { ...profile, assurance: 'runtime-sample-only', author: 'not-proven',
    timingCompatibility: { observedHead: observed.head, currentHead: expected.head,
    inputTree: expected.inputTree, reusedAcrossHeads: observed.head !== expected.head,
    assurance: 'timing-only; never author PASS' } };
}

/** Complete default author timing remains a separate, source-bound diagnostic artifact. */
export function closedDurationEvidence(root, path, expectedFiles, bindings) {
  const bytes = readArtifactBytes(root, path, 2 * 1024 * 1024,
    'runtime durations: oversized evidence');
  const evidence = JSON.parse(bytes);
  if (evidence.version !== 1 || JSON.stringify(Object.keys(evidence.files ?? {}).sort()) !==
      JSON.stringify([...expectedFiles].sort()) || Object.values(evidence.files ?? {}).some((ms) => !Number.isFinite(ms) || ms <= 0)) {
    throw new Error('runtime durations: incomplete physical file-wrapper evidence');
  }
  return { state: 'complete', path, bytes: bytes.length, sha256: digest(bytes), bindings,
    physicalFiles: expectedFiles.length, limits: 'Closed native wrapper durations, not a promoted runtime baseline, calibrated parallel scaling, resource peak or additional test assurance.' };
}

const quantile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((sorted.length - 1) * fraction)];
};

/** An estimate, not a finish promise. Unknown files are never priced at zero. */
export function runtimeDeadlineFit(files, manifest, profile, { workers, deadline, now = Date.now(),
  staticReserveMs = AUTHOR_STATIC_RESERVE_MS } = {}) {
  if (!files.length || !Number.isSafeInteger(workers) || workers < 1 || workers > 4 ||
      !Number.isFinite(deadline) || !Number.isFinite(now) || !Number.isSafeInteger(staticReserveMs) || staticReserveMs < 0) {
    throw new Error('runtime admission: invalid deadline, corpus or admitted workers');
  }
  const median = medianMeasuredDurationMs(manifest), entries = Object.entries(profile.files);
  if (!entries.length) throw new Error('runtime admission: no native measurements');
  const scale = Math.max(1, quantile(entries.map(([file, ms]) => ms / Math.max(1000,
    weightedDurationMs(file, manifest, median))), 0.9));
  const overheadMs = Math.ceil(Math.max(100, quantile(entries.map(([file, ms]) =>
    ms - weightedDurationMs(file, manifest, median) * scale), 0.9)));
  const unknownMs = Math.ceil(Math.max(median * scale + overheadMs, quantile(entries.map(([, ms]) => ms), 0.95)));
  const measured = new Set(entries.map(([file]) => file));
  const costs = Object.fromEntries(files.map((file) => [file, Math.ceil(Math.max(profile.files[file] ?? 0,
    Number.isFinite(manifest.files[file]) && manifest.files[file] > 0 ? manifest.files[file] * scale + overheadMs : unknownMs))]));
  const predictedMs = Math.ceil(predictMakespanMs(files, { ...manifest, files: costs }, workers) * AUTHOR_RUNTIME_SAFETY_FACTOR);
  const requiredMs = predictedMs + staticReserveMs + AUTHOR_SHUTDOWN_RESERVE_MS, availableMs = deadline - now;
  return { fits: requiredMs <= availableMs, kind: 'estimated-native-calibration', workers, deadline,
    availableMs, requiredMs, predictedMs, staticReserveMs, shutdownReserveMs: AUTHOR_SHUTDOWN_RESERVE_MS,
    safetyFactor: AUTHOR_RUNTIME_SAFETY_FACTOR, scale, overheadMs, unknownMs,
    measuredFiles: files.filter((file) => measured.has(file)).length, totalFiles: files.length,
    estimatedFiles: files.filter((file) => !measured.has(file)).length,
    unmeasuredLedgerFiles: files.filter((file) => !(manifest.files[file] > 0)).length,
    profileAt: profile.at, limits: 'Sample-calibrated estimate with explicit unmeasured costs; not full-corpus calibration, admission capacity, author assurance or a completion promise.' };
}

export function sourceHead(root) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim();
}
