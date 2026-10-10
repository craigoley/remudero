import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
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
  const files = listTestFiles(root).sort();
  const hashes = Object.fromEntries(['.nvmrc', 'package-lock.json', 'test/setup/tmp-hygiene.ts',
    'scripts/test-tier-manifest.json'].map((file) => [file, digest(readFileSync(join(root, file)))]));
  const corpusSha256 = digest(files.map((file) => `${file}:${digest(readFileSync(join(root, file)))}`).join('\n'));
  const tsx = JSON.parse(readFileSync(join(root, 'node_modules/tsx/package.json'), 'utf8')).version;
  const environmentSha256 = digest(JSON.stringify(Object.fromEntries(['TZ', 'LANG', 'LC_ALL', 'NODE_ENV']
    .map((key) => [key, env[key] ?? null]))));
  return { head, platform: process.platform, arch: process.arch, node: process.version,
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

function artifactPath(root, path) {
  const absolute = resolve(root, path);
  if (!absolute.startsWith(resolve(root, 'coverage') + sep) || !lstatSync(absolute).isFile() ||
      !realpathSync(absolute).startsWith(realpathSync(join(root, 'coverage')) + sep)) {
    throw new Error('runtime profile: evidence must be a regular file under owned coverage');
  }
  return absolute;
}

/** Re-read every closed capture, rather than trusting a success-shaped profile field. */
export function readRuntimeProfile(root, path, expected, now = Date.now()) {
  const absolute = artifactPath(root, path);
  if (lstatSync(absolute).size > 2 * 1024 * 1024) throw new Error('runtime profile: oversized evidence');
  const profile = JSON.parse(readFileSync(absolute, 'utf8'));
  if (profile.format !== RUNTIME_PROFILE_FORMAT || JSON.stringify(profile.bindings) !== JSON.stringify(expected)) {
    throw new Error('runtime profile: source/runtime/corpus binding mismatch');
  }
  const age = now - Date.parse(profile.at);
  if (!Number.isFinite(age) || age < 0 || age > RUNTIME_PROFILE_MAX_AGE_MS) throw new Error('runtime profile: stale or future observation');
  if (!Number.isSafeInteger(profile.concurrency) || profile.concurrency < 1 || profile.concurrency > 4) {
    throw new Error('runtime profile: invalid measured concurrency');
  }
  const artifacts = {};
  for (const row of profile.artifacts ?? []) {
    if (artifacts[row.name]) throw new Error('runtime profile: duplicate artifact');
    const file = artifactPath(root, row.path), bytes = readFileSync(file);
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
  return profile;
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
