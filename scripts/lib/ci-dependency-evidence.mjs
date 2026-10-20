import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { durableDependencyCredit, loadCreditOverrides, refusesAsPlanOnly } from '../../src/lib/status.js';
import { loadPlanAtRef } from '../../src/lib/plan.js';
import { ghJson } from '../../src/lib/worker.js';
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
        expected.repository.split('/').some(part => part === '.' || part === '..') ||
        ![expected.head, expected.base, expected.producerSha].every(value => typeof value === 'string' && SHA.test(value)) ||
        ![expected.runId, expected.attempt].every(value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) ||
        expected.producerJob !== 'commitlint' || !DIGEST.test(expected.digest) ||
        !Number.isSafeInteger(expected.nowMs) || expected.nowMs < 0 || !Number.isSafeInteger(expected.maxAgeMs) || expected.maxAgeMs <= 0 ||
        typeof path !== 'string' || !isAbsolute(path) || !isAbsolute(expected.runnerTemp) || !isAbsolute(expected.checkout)) {
      return refuse('invocation context unavailable or malformed');
    }
    const root = realpathSync(expected.runnerTemp), checkout = realpathSync(expected.checkout);
    const target = realpathSync(path);
    if (target !== resolve(path) || !inside(root, target) || inside(checkout, target)) return refuse('artifact is not a private runner-temporary regular path');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
        !Number.isSafeInteger(value.observedAtMs) || value.observedAtMs < 0 || value.observedAtMs > expected.nowMs ||
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
    const base = argv.includes('--merge-base')
      ? gitOrThrow(['merge-base', argv[baseAt + 1], head], { cwd })
      : gitOrThrow(['rev-parse', '--verify', argv[baseAt + 1] + '^{commit}'], { cwd });
    const planAt = argv.indexOf('--plan');
    if (planAt >= 0 && (!argv[planAt + 1] || resolve(cwd, argv[planAt + 1]) !== resolve(cwd, 'plan/tasks.yaml'))) throw new Error('receipt is for the canonical plan only');
    if (gitOrThrow(['status', '--porcelain', '--untracked-files=all', '--', 'plan'], { cwd }) !== '' ||
        gitOrThrow(['ls-files', '--others', '--ignored', '--exclude-standard', '--', 'plan'], { cwd }) !== '') throw new Error('plan changed after checkout');
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

/** Read only the changed machine filings' dependency closure from immutable Git objects. */
export function ciDependencyClosure(checkout, head, base) {
  const git = args => gitOrThrow(args, { cwd: checkout });
  const at = ref => loadPlanAtRef(checkout, 'plan/tasks.yaml', ref);
  const plan = at(head), before = at(base), ids = new Set();
  const pending = plan.tasks.filter(task => task.author_class === 'machine' &&
    !(task.status === 'blocked' && task.retirement !== undefined) &&
    JSON.stringify(task) !== JSON.stringify(before.byId.get(task.id))).flatMap(task => task.depends_on ?? []);
  while (pending.length) {
    const id = pending.pop();
    if (ids.has(id)) continue;
    if (!ID.test(id) || ids.size >= 32) throw new Error('CI dependency closure unavailable or exceeds the consumer bound');
    const task = plan.byId.get(id);
    if (!task) throw new Error('CI dependency task absent from committed plan');
    ids.add(id); pending.push(...(task.depends_on ?? []));
  }
  const overrides = [];
  for (const ref of new Set([base, head])) {
    if (!git(['ls-tree', '--name-only', ref, 'plan/credit-overrides.yaml'])) continue;
    let reading;
    const parsed = loadCreditOverrides(() => git(['show', ref + ':plan/credit-overrides.yaml']), state => { reading = state; });
    if (reading?.state !== 'present' || parsed.refused.length ||
        parsed.rows.some(row => !ID.test(row.task) || !Number.isSafeInteger(row.pr) || row.pr < 1)) {
      throw new Error('CI dependency override ruling unreadable or malformed');
    }
    overrides.push(...parsed.rows);
  }
  return { plan, taskIds: [...ids].sort(), overrides };
}

/** SAME-RUN, GET-only observation; never writes a native credit store or infers MERGED from a search hit. */
export async function produceCiDependencyEvidence(context, { request = path => ghJson(['api', '--method', 'GET', path]),
  closure = ciDependencyClosure, git = args => gitOrThrow(args, { cwd: context.checkout }) } = {}) {
  if (!object(context) || context.actions !== true ||
      typeof context.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository) ||
      context.repository.split('/').some(part => part === '.' || part === '..') ||
      ![context.head, context.base, context.producerSha].every(value => typeof value === 'string' && SHA.test(value)) ||
      context.producerSha !== context.base || context.producerJob !== 'commitlint' ||
      ![context.runId, context.attempt].every(value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) ||
      !isAbsolute(context.checkout ?? '') || !Number.isSafeInteger(context.nowMs) || context.nowMs < 0) {
    throw new Error('CI dependency producer context unavailable or malformed');
  }
  if (git(['rev-parse', '--verify', 'HEAD^{commit}']) !== context.head ||
      git(['rev-parse', '--verify', context.base + '^{commit}']) !== context.base) {
    throw new Error('CI dependency checkout identity changed');
  }
  const { plan, taskIds, overrides } = closure(context.checkout, context.head, context.base);
  const credits = {};
  for (const id of taskIds) {
    const candidates = new Set();
    for (const term of [`"Remudero-Task: ${id}" in:body`, `head:run-${id}-`]) {
      const query = encodeURIComponent(`repo:${context.repository} is:pr is:merged ${term}`);
      const found = await request(`search/issues?q=${query}&per_page=100`);
      if (!object(found) || found.incomplete_results !== false || !Array.isArray(found.items) ||
          !Number.isSafeInteger(found.total_count) || found.total_count !== found.items.length || found.total_count > 100 ||
          found.items.some(row => !object(row) || !Number.isSafeInteger(row.number) || row.number < 1 || !object(row.pull_request))) {
        throw new Error('CI dependency search incomplete or malformed');
      }
      for (const item of found.items) candidates.add(item.number);
    }
    const record = {};
    for (const number of [...candidates].sort((a, b) => b - a)) {
      const pr = await request(`repos/${context.repository}/pulls/${number}`);
      if (!object(pr) || pr.number !== number || pr.merged !== true || pr.state !== 'closed' ||
          typeof pr.merged_at !== 'string' || !Number.isFinite(Date.parse(pr.merged_at)) || Date.parse(pr.merged_at) > context.nowMs ||
          pr.html_url !== `https://github.com/${context.repository}/pull/${number}` ||
          pr.base?.repo?.full_name?.toLowerCase() !== context.repository.toLowerCase() || pr.base?.ref !== 'main' ||
          !SHA.test(pr.merge_commit_sha ?? '') || typeof pr.body !== 'string' || typeof pr.head?.ref !== 'string') continue;
      const sources = [];
      if (new RegExp(`^Remudero-Task: ${id}$`, 'm').test(pr.body)) sources.push('trailer');
      if (new RegExp(`^run-${id}-[0-9]+$`).test(pr.head.ref)) sources.push('head-branch');
      if (!sources.length) continue;
      try { git(['merge-base', '--is-ancestor', pr.merge_commit_sha, context.base]); }
      catch { continue; } // Not proven in this protected base; a later run can observe it.
      // GitHub's files endpoint exposes at most 3,000 files, 100 per page; partial files cannot grant credit.
      if (!Number.isSafeInteger(pr.changed_files) || pr.changed_files < 1 || pr.changed_files > 3000) continue;
      const paths = [];
      for (let page = 1; page <= Math.ceil(pr.changed_files / 100); page++) {
        const files = await request(`repos/${context.repository}/pulls/${number}/files?per_page=100&page=${page}`);
        if (!Array.isArray(files) || files.length !== Math.min(100, pr.changed_files - paths.length) ||
            files.some(file => !object(file) || typeof file.filename !== 'string' || !file.filename)) {
          throw new Error('CI dependency changed-file evidence incomplete');
        }
        paths.push(...files.map(file => file.filename));
      }
      if (new Set(paths).size !== paths.length || refusesAsPlanOnly(plan.byId.get(id), paths)) continue;
      for (const source of sources) if (!record[source]) record[source] = {
        source, prUrl: pr.html_url, prNumber: number, prState: 'MERGED',
      };
      if (record.trailer && record['head-branch']) break;
    }
    credits[id] = record;
  }
  const value = { schema: CI_DEPENDENCY_EVIDENCE_SCHEMA, complete: true, repository: context.repository,
    head: context.head, base: context.base, producerSha: context.producerSha, producerJob: context.producerJob,
    runId: context.runId, attempt: context.attempt, observedAtMs: context.nowMs, taskIds, credits, overrides };
  const bytes = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(bytes) > CI_DEPENDENCY_EVIDENCE_MAX_BYTES) throw new Error('CI dependency artifact exceeds the consumer byte bound');
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex'), producerSha: context.producerSha };
}
