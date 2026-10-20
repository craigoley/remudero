import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { durableDependencyCredit } from '../../src/lib/status.js';
import { gitOrThrow } from './git.mjs';

// This is a consumer of a SAME-RUN trusted producer's output, not a new source of durable credit.
// The producer's digest/context must arrive separately from its artifact (job outputs).
export const CI_DEPENDENCY_EVIDENCE_SCHEMA = 'rmd-ci-dependency-evidence/v1';
export const CI_DEPENDENCY_EVIDENCE_MAX_BYTES = 65536;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (parent, child) => { const rel = relative(parent, child); return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel); };
const unknown = reason => ({ state: 'unknown', reason: 'CI dependency evidence: ' + reason });

/** No network, config discovery, mutation, fallback or durable-store read. Invalid input is UNKNOWN.
 * Job identity and digest are supplied by the trusted producer job, never read from the artifact
 * to decide what is expected. Real workflows must pin that producer to protected base code. */
export function readCiDependencyEvidence(path, expected) {
  const refuse = reason => ({ state: 'unknown', reason, dependencyEvidence: () => unknown(reason) });
  let fd;
  try {
    if (!object(expected) || expected.actions !== true ||
        typeof expected.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected.repository) ||
        !SHA.test(expected.head) || !SHA.test(expected.base) || !SHA.test(expected.producerSha) ||
        !/^[1-9][0-9]*$/.test(expected.runId) || !/^[1-9][0-9]*$/.test(expected.attempt) ||
        expected.producerJob !== 'commitlint' || !DIGEST.test(expected.digest) ||
        !Number.isSafeInteger(expected.nowMs) || !Number.isSafeInteger(expected.maxAgeMs) || expected.maxAgeMs <= 0 ||
        typeof path !== 'string' || !isAbsolute(path) || !isAbsolute(expected.runnerTemp) || !isAbsolute(expected.checkout)) {
      return refuse('invocation context unavailable or malformed');
    }
    const root = realpathSync(expected.runnerTemp), checkout = realpathSync(expected.checkout);
    const target = realpathSync(path);
    if (target !== resolve(path) || !inside(root, target) || inside(checkout, target)) return refuse('artifact is not a private runner-temporary regular path');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > CI_DEPENDENCY_EVIDENCE_MAX_BYTES || (stat.mode & 0o222) !== 0) {
      return refuse('artifact must be bounded, read-only and regular');
    }
    const bounded = Buffer.alloc(CI_DEPENDENCY_EVIDENCE_MAX_BYTES + 1);
    let length = 0;
    while (length < bounded.length) {
      const count = readSync(fd, bounded, length, bounded.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const bytes = bounded.subarray(0, length), after = fstatSync(fd);
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs ||
        bytes.length > CI_DEPENDENCY_EVIDENCE_MAX_BYTES ||
        createHash('sha256').update(bytes).digest('hex') !== expected.digest) return refuse('artifact bytes do not match the independent producer digest');
    const value = JSON.parse(bytes.toString('utf8'));
    if (!object(value) || value.schema !== CI_DEPENDENCY_EVIDENCE_SCHEMA || value.complete !== true ||
        value.repository !== expected.repository || value.head !== expected.head || value.base !== expected.base ||
        value.runId !== expected.runId || value.attempt !== expected.attempt ||
        value.producerSha !== expected.producerSha || value.producerJob !== expected.producerJob ||
        !Number.isSafeInteger(value.observedAtMs) || value.observedAtMs > expected.nowMs ||
        expected.nowMs - value.observedAtMs > expected.maxAgeMs ||
        !Array.isArray(value.taskIds) || value.taskIds.length > 32 || new Set(value.taskIds).size !== value.taskIds.length ||
        !value.taskIds.every(id => typeof id === 'string' && ID.test(id)) ||
        !object(value.credits) || Object.keys(value.credits).some(id => !value.taskIds.includes(id)) ||
        !Array.isArray(value.overrides) || value.overrides.some(row => !object(row) || !ID.test(row.task) ||
          !Number.isSafeInteger(row.pr) || row.pr <= 0 || row.action !== 'remove-credit')) {
      return refuse('incomplete, stale, foreign or malformed producer observation');
    }
    // The canonical verifier retains cross-source quarantine, URL/repo identity, MERGED-only
    // records and subtract-only rulings. Missing tasks remain unknown, never unmerged or zero.
    return { state: 'ready', dependencyEvidence: task => value.taskIds.includes(task.id)
      ? durableDependencyCredit(value.credits, task.id, expected.repository, value.overrides)
      : unknown('task outside the verified dependency closure') };
  } catch {
    return refuse('artifact unreadable or invalid');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Only the owning Actions checkout opts in. Fixture repos and ordinary local invocations
 * retain their existing native evidence; an opted-in checkout never falls back on refusal. */
export function ciDependencyEvidenceForInvocation(argv, env = process.env, cwd = process.cwd()) {
  if (!env.RMD_CI_DEPENDENCY_EVIDENCE || env.GITHUB_ACTIONS !== 'true' ||
      typeof env.GITHUB_WORKSPACE !== 'string' || resolve(cwd) !== resolve(env.GITHUB_WORKSPACE)) return undefined;
  try {
    const baseAt = argv.indexOf('--base');
    if (baseAt < 0 || !argv[baseAt + 1]) throw new Error('changed-task base required');
    const head = gitOrThrow(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd });
    const base = gitOrThrow(['rev-parse', '--verify', argv[baseAt + 1] + '^{commit}'], { cwd });
    if (gitOrThrow(['status', '--porcelain', '--untracked-files=no', '--', 'plan'], { cwd }) !== '') throw new Error('plan changed after checkout');
    return readCiDependencyEvidence(env.RMD_CI_DEPENDENCY_EVIDENCE, {
      actions: true, repository: env.GITHUB_REPOSITORY, head, base,
      producerSha: env.RMD_CI_DEPENDENCY_PRODUCER_SHA,
      runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, producerJob: 'commitlint',
      digest: env.RMD_CI_DEPENDENCY_DIGEST,
      nowMs: Date.now(), maxAgeMs: 2 * 60 * 60 * 1000,
      runnerTemp: env.RUNNER_TEMP, checkout: cwd,
    }).dependencyEvidence;
  } catch {
    return () => unknown('checkout or base unreadable or changed');
  }
}
