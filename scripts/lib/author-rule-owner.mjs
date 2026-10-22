/** Rule results belong to one live author invocation, never a cross-run test cache. */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync,
  readlinkSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_SLOT_DIR_ENV, TEST_SLOT_PARENT_ENV, testSlotHasAncestor, testSlotProcessFacts } from '../../src/lib/test-slot.ts';
import { AUTHOR_CAPTURE_PARENT_ENV } from './author-step-capture.mjs';

export const AUTHOR_RULE_OWNER_ENV = 'RMD_AUTHOR_RULE_OWNER';
const KEYS = ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo', 'suites', 'topLevel'];
const REPORTER = fileURLToPath(new URL('./author-rule-native-reporter.mjs', import.meta.url));
const ruleArgv = (concurrency) => ['--test', `--test-concurrency=${concurrency}`, '--experimental-test-isolation=process',
  '--test-reporter=tap', '--test-reporter-destination=stdout', '--import', 'tsx',
  '--import', './test/setup/tmp-hygiene.ts'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonHash = (value) => digest(JSON.stringify(value));
const within = (file, root) => file === root || file.startsWith(root + sep);
// A spooler supplies a new cancellation PID at each process edge. Validate its exact
// immediate-parent binding separately; every other string input remains in the fingerprint.
// The marker grants no test-slot or result authority; live owner ancestry is checked below.
const hashEnvironment = (environment) => {
  const parent = environment[AUTHOR_CAPTURE_PARENT_ENV];
  if (parent !== undefined && (process.ppid <= 0 || parent !== String(process.ppid)))
    throw new Error('unverified immediate capture parent');
  return jsonHash(Object.entries(environment).filter(([key, value]) =>
    key !== AUTHOR_CAPTURE_PARENT_ENV && typeof value === 'string').sort(([a], [b]) => a.localeCompare(b)));
};

/** Native fixtures have private admission; only actual static descendants borrow the author. */
export function authorRuleTestEnvironment(environment) {
  return { ...environment, [TEST_SLOT_PARENT_ENV]: undefined, [TEST_SLOT_DIR_ENV]: undefined,
    [AUTHOR_CAPTURE_PARENT_ENV]: undefined };
}

function git(root, args) {
  const child = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  if (child.status !== 0 || child.signal || child.error) throw new Error('rule-owner Git identity unavailable');
  return child.stdout.trim();
}

/** Stream complete package bytes. A lockfile alone cannot qualify a resolved dependency graph.
 * Bounds refuse consolidation before tests; no file type, unreadable node or foreign link is omitted. */
export function dependencyGraphDigest(root) {
  const modules = realpathSync(join(root, 'node_modules'));
  const packages = [join(realpathSync(root), 'packages'), join(dirname(modules), 'packages')];
  const hash = createHash('sha256');
  const seen = new Set();
  const buffer = Buffer.alloc(64 * 1024);
  let files = 0;
  let bytes = 0;
  const visit = (file) => {
    const info = lstatSync(file);
    hash.update(file).update('\0').update(String(info.mode)).update('\0');
    if (info.isSymbolicLink()) {
      hash.update('link\0').update(readlinkSync(file)).update('\0');
      const target = realpathSync(file);
      if (!within(target, modules) && !packages.some((scope) => within(target, scope))) throw new Error('dependency link leaves package graph');
      if (!seen.has(target)) visit(target);
    } else if (info.isDirectory()) {
      if (seen.has(file)) return;
      seen.add(file);
      hash.update('directory\0');
      for (const child of readdirSync(file).sort()) visit(join(file, child));
    } else if (info.isFile()) {
      if (seen.has(file)) return;
      seen.add(file);
      files += 1;
      bytes += info.size;
      if (files > 100000 || bytes > 2 * 1024 ** 3) throw new Error('dependency closure exceeds bound');
      hash.update('file\0').update(String(info.size)).update('\0');
      const fd = openSync(file, 'r');
      try {
        let n;
        while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, n));
      } finally { closeSync(fd); }
    } else throw new Error('dependency graph has unsupported file type');
  };
  visit(modules);
  return { sha256: hash.digest('hex'), files, bytes };
}

function manifest(root, files) {
  if (!files.length || new Set(files).size !== files.length) throw new Error('empty or duplicate rule-owner manifest');
  return files.map((file) => {
    const full = resolve(root, file);
    if (!/^test\/.*\.test\.ts$/.test(file) || !within(full, root)
      || !lstatSync(full).isFile() || realpathSync(full) !== full) throw new Error('unverified physical rule-owner suite');
    return { file, sha256: digest(readFileSync(full)) };
  });
}

function context(root, environment, rules, affected, concurrency) {
  if (git(root, ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('rule-owner source is dirty');
  const head = git(root, ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('rule-owner head unavailable');
  const node = realpathSync(process.execPath);
  const environmentHash = hashEnvironment(environment);
  return { contextVersion: 2, captureParentPolicy: 'verified-immediate-parent-or-absent',
    root, head, tree: git(root, ['rev-parse', 'HEAD^{tree}']), node,
    nodeVersion: process.version, nodeSha256: digest(readFileSync(node)), environmentHash,
    nativeEnvironmentHash: hashEnvironment(authorRuleTestEnvironment(environment)),
    ruleArgvHash: jsonHash(ruleArgv(concurrency)), ruleManifest: manifest(root, rules),
    affectedManifest: manifest(root, affected), dependencies: dependencyGraphDigest(root) };
}

function save(file, value, initial = false) {
  if (initial) writeFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
  else {
    writeFileSync(file + '.next', JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(file + '.next', file);
  }
}

/** Missing native completions, zero assertions or inconsistent cumulative units are refusals.
 * A genuine positive file can retain platform skips; those counts are never invented or dropped. */
export function certifyRuleNativeSummary(file, events, exit) {
  if (exit !== 0) throw new Error('native rule child failed');
  const summaries = events.filter((event) => event.type === 'test:summary').map((event) => event.data);
  if (summaries.length !== 2) throw new Error('missing or duplicate native rule summary');
  const row = summaries.find((value) => value.file === file);
  const cumulative = summaries.find((value) => value.file === undefined);
  if (!row || !cumulative || row.success !== true || cumulative.success !== true
    || KEYS.some((key) => !Number.isSafeInteger(row.counts?.[key]) || row.counts[key] < 0
      || row.counts[key] !== cumulative.counts?.[key])
    || row.counts.passed <= 0 || row.counts.tests <= 0 || row.counts.failed !== 0 || row.counts.cancelled !== 0)
    throw new Error('foreign, empty, skipped-only or incomplete native rule summary');
  return row.counts;
}

/** Called after cheap census and real shared-slot admission. An unqualified graph keeps the
 * original full execution; once owned rules start, failure or mutation can never fall back green. */
export function createAuthorRuleOwner({ root, directory, head, rules, affected, environment, concurrency }) {
  root = realpathSync(root);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('unqualified rule concurrency');
  const facts = testSlotProcessFacts(process.pid);
  if (!facts) throw new Error('author process start identity unavailable');
  const owner = { version: 1, root, head, pid: process.pid, start: facts.start, host: hostname(),
    nonce: randomUUID(), phase: 'prepared', rules, affected, concurrency, results: [] };
  const file = join(directory, 'rule-owner.json');
  const descriptor = JSON.stringify({ file, pid: owner.pid, start: owner.start, nonce: owner.nonce });
  const childEnvironment = { ...environment, [AUTHOR_RULE_OWNER_ENV]: descriptor };
  owner.context = context(root, childEnvironment, rules, affected, concurrency);
  if (owner.context.head !== head) throw new Error('rule-owner source head moved');
  save(file, owner, true);
  return { file, descriptor, childEnvironment };
}

function readOwner(root) {
  const raw = process.env[AUTHOR_RULE_OWNER_ENV];
  if (!raw) return undefined;
  const descriptor = JSON.parse(raw);
  if (process.env.NODE_TEST_CONTEXT && descriptor.pid !== process.pid) return undefined;
  const file = resolve(descriptor.file);
  const physical = realpathSync(file);
  if (physical !== file || !within(file, join(realpathSync(root), 'coverage')) || lstatSync(file).size > 2 * 1024 * 1024)
    throw new Error('foreign rule-owner receipt');
  const owner = JSON.parse(readFileSync(file, 'utf8'));
  const facts = testSlotProcessFacts(owner.pid);
  if (owner.version !== 1 || owner.root !== realpathSync(root) || owner.host !== hostname()
    || owner.pid !== descriptor.pid || owner.start !== descriptor.start || owner.nonce !== descriptor.nonce
    || !facts || facts.start !== owner.start
    || (owner.pid !== process.pid && !testSlotHasAncestor(owner.pid)))
    throw new Error('stale or foreign rule-owner process');
  return { file, owner };
}

export function beginOwnedRuleResults(root, rules) {
  const read = readOwner(root);
  if (!read) return undefined;
  const { owner, file } = read;
  if (owner.phase !== 'prepared') throw new Error('rule owner already started; refusing another execution');
  if (JSON.stringify(owner.rules) !== JSON.stringify(rules)) throw new Error('required rule manifest differs');
  const actual = context(owner.root, process.env, owner.rules, owner.affected, owner.concurrency);
  if (jsonHash(actual) !== jsonHash(owner.context)) return undefined;
  owner.phase = 'running'; save(file, owner);
  return {
    run(suite) {
      if (!rules.includes(suite) || owner.results.some((result) => result.suite === suite)) throw new Error('duplicate or foreign rule execution');
      const eventFile = join(dirname(file), `rule-${owner.results.length}.ndjson`);
      const argv = [...ruleArgv(owner.concurrency), '--test-reporter=' + REPORTER, '--test-reporter-destination=' + eventFile, suite];
      const child = spawnSync(process.execPath, argv, { cwd: root, env: authorRuleTestEnvironment(process.env), stdio: 'inherit' });
      const result = { suite, exit: child.status, signal: child.signal ?? null, complete: false, eventFile,
        argvHash: jsonHash(argv), error: child.error?.code ?? null };
      owner.results.push(result); save(file, owner);
      try {
        if (child.error || child.signal || lstatSync(eventFile).size > 1024 * 1024) throw new Error('native rule completion unavailable');
        const bytes = readFileSync(eventFile);
        result.nativeCounts = certifyRuleNativeSummary(resolve(root, suite), bytes.toString('utf8').trim().split('\n').map(JSON.parse), child.status);
        result.eventSha256 = digest(bytes); result.complete = true;
      } catch (error) { result.refusal = error.message; }
      save(file, owner);
      return result.complete ? 0 : 1;
    },
    finish() {
      const unchanged = jsonHash(context(owner.root, process.env, owner.rules, owner.affected, owner.concurrency)) === jsonHash(owner.context);
      owner.phase = unchanged && owner.results.length === rules.length && owner.results.every((row) => row.complete)
        ? 'complete' : 'failed';
      save(file, owner);
      return owner.phase === 'complete' ? 0 : 1;
    },
  };
}

/** Attribute the actual same-owner native result to the affected obligation. Every remaining
 * affected suite still runs; a fully overlapping selection retains the original native run. */
export function qualifiedAffectedRules(handle, root, environment, affected) {
  const prior = process.env[AUTHOR_RULE_OWNER_ENV];
  process.env[AUTHOR_RULE_OWNER_ENV] = handle.descriptor;
  let read;
  try { read = readOwner(root); }
  finally {
    if (prior === undefined) delete process.env[AUTHOR_RULE_OWNER_ENV];
    else process.env[AUTHOR_RULE_OWNER_ENV] = prior;
  }
  if (!read || read.file !== handle.file) throw new Error('author rule owner unavailable');
  const { owner } = read;
  if (owner.phase === 'prepared') return { remaining: affected, reused: [], reason: 'rule context did not qualify' };
  if (owner.phase !== 'complete') throw new Error('failed or incomplete rule owner');
  if (JSON.stringify(owner.affected) !== JSON.stringify(affected)
    || jsonHash(context(owner.root, environment, owner.rules, affected, owner.concurrency)) !== jsonHash(owner.context))
    throw new Error('author rule-owner context changed');
  for (const result of owner.results) {
    const bytes = readFileSync(result.eventFile);
    if (digest(bytes) !== result.eventSha256) throw new Error('native rule receipt changed');
    certifyRuleNativeSummary(resolve(root, result.suite), bytes.toString('utf8').trim().split('\n').map(JSON.parse), result.exit);
  }
  const reused = owner.results.filter((result) => affected.includes(result.suite));
  const remaining = affected.filter((suite) => !reused.some((result) => result.suite === suite));
  if (!remaining.length) {
    // The verified affected manifest is nonempty. Keep one actual native file,
    // while the other same-invocation completions retain their original evidence.
    const witness = affected[0];
    return { remaining: [witness], reused: reused.filter((result) => result.suite !== witness),
      reason: 'retain one real positive affected native run' };
  }
  return { remaining, reused, reason: 'actual same-author native rule completions' };
}

/** Restrict qualified work to the verified capacity selection, retaining an explicit native file. */
export function admittedAffectedRules(qualified, admitted) {
  const population = [...qualified.remaining, ...qualified.reused.map((result) => result.suite)];
  if (!Array.isArray(admitted) || !admitted.length || new Set(admitted).size !== admitted.length
    || admitted.some((suite) => !population.includes(suite)))
    throw new Error('admitted rule selection must be a nonempty unique subset of qualified affected files');
  const files = new Set(admitted);
  const remaining = qualified.remaining.filter((suite) => files.has(suite));
  const reused = qualified.reused.filter((result) => files.has(result.suite));
  if (!remaining.length) {
    const witness = admitted[0];
    return { remaining: [witness], reused: reused.filter((result) => result.suite !== witness),
      reason: 'retain one real positive admitted native run' };
  }
  return { ...qualified, remaining, reused };
}
