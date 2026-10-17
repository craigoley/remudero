import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {copyFileSync, readFileSync, realpathSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {test, type TestContext} from 'node:test';
import {gitRepo} from '#test/helpers/git-repo.js';
// @ts-expect-error -- operator ESM diagnostics are independently source-mapped.
import {checkAuthorCheckout} from '#scripts/lib/author-checkout-preconditions.mjs';
// @ts-expect-error -- shared with the dependency-free operator launcher.
import {remainingSubprocessTimeout, spawnWithinBudget} from '#scripts/lib/bounded-subprocess.mjs';

const upstream = 'https://github.com/craigoley/remudero.git';
function fixture(t: Pick<TestContext, 'after'>) {
  const repo = gitRepo({scope: t, seedCommit: false, kind: 'checkout-controls'});
  const root = repo.dir, git = repo.git;
  git('commit', '--quiet', '--allow-empty', '-m', 'fixture base ' + randomUUID());
  const head = git('rev-parse', 'HEAD'); git('remote', 'add', 'origin', upstream); git('update-ref', 'refs/remotes/origin/main', head);
  const deps = {dependency: () => ({state: 'present', dependencyRoot: root, assurance: 'synthetic dependency observation'})};
  const check = (extra = {}, injected = {}) => checkAuthorCheckout(root, {head, upstream, ...extra}, {...deps, ...injected});
  return {root, git, head, check};
}
test('checkout diagnostic reads a real clean Git fixture without granting execution or author PASS', t => {
  const {root, check} = fixture(t), before = readFileSync(join(root, '.git/config'));
  const r = check(); assert.equal(r.state, 'ready'); assert.equal(r.executionAllowed, false); assert.equal(r.authorPass, false);
  assert.equal(r.upstreamFreshnessVerified, false); assert(readFileSync(join(root, '.git/config')).equals(before));
});
test('checkout diagnostic refuses the actual detached donor origin and missing main before expensive tests', t => {
  const {root, git, check} = fixture(t); git('remote', 'set-url', 'origin', root); git('update-ref', '-d', 'refs/remotes/origin/main');
  const r = check(); assert.equal(r.state, 'blocked'); assert(r.failures.some((x: {code: string}) => x.code === 'wrong-or-missing-upstream'));
  assert(r.failures.some((x: {code: string}) => x.code === 'missing-origin-main'));
});
test('checkout diagnostic resolves a real HEAD-only bundle without inventing its branch name', t => {
  const {root, git, head, check} = fixture(t), path = join(root, '.git/head.bundle'); git('bundle', 'create', path, 'HEAD');
  const r = check({bundles: [{path, head}]}); assert.equal(r.state, 'ready');
  const b = r.observations.find((x: {kind: string}) => x.kind === 'bundle'); assert.deepEqual(b.matches, [{head, ref: 'HEAD'}]); assert.equal(b.imported, false);
});
test('checkout diagnostic rejects an incremental bundle whose parent commit is genuinely absent', t => {
  const f = fixture(t), other = fixture(t), parent = f.head;
  f.git('commit', '--quiet', '--allow-empty', '-m', 'incremental child'); const child = f.git('rev-parse', 'HEAD'), path = join(f.root, '.git/increment.bundle');
  f.git('bundle', 'create', path, 'HEAD', '^' + parent);
  // The unrelated fixture cannot supply the excluded prerequisite.
  other.git('commit', '--quiet', '--allow-empty', '-m', 'unrelated');
  const r = other.check({bundles: [{path, head: child}]}); assert.equal(r.state, 'blocked');
  assert(r.failures.some((x: {code: string}) => x.code === 'bundle-invalid-or-prerequisite-missing'));
});
test('checkout diagnostic refuses wrong bundle and head identities, dirty files and missing dependencies', t => {
  const {root, check} = fixture(t); assert.equal(check({head: 'a'.repeat(40)}).state, 'blocked');
  writeFileSync(join(root, 'unpublished.txt'), 'keep me'); assert.equal(check().state, 'blocked');
  const r = check({}, {dependency: () => ({state: 'unavailable'})}); assert.equal(r.state, 'unknown');
});
test('checkout diagnostic preserves unknown subprocess failures instead of treating absence as ready', t => {
  const {check} = fixture(t); for (const response of [{status: null, signal: 'SIGTERM'}, {status: 1}, {error: new Error('no git')}]) {
    const r = check({}, {spawn: () => response}); assert.equal(r.state, 'unknown'); assert.equal(r.executionAllowed, false);
  }
  assert.equal(check({upstream: 'https://token@github.com/craigoley/remudero.git'}).state, 'blocked');
});
test('checkout diagnostic really checks installed metadata on its default dependency seam', t => {
  const {root, head} = fixture(t), r = checkAuthorCheckout(root, {head, upstream});
  assert.equal(r.state, 'unknown'); assert(r.failures.some((x: {code: string}) => x.code === 'dependency-metadata-or-tools-unavailable'));
});
test('subprocess timeout floors fractional elapsed time and charges one fixed envelope only once', () => {
  assert.equal(remainingSubprocessTimeout(10.1, 100, 10.6), 99);
  assert.equal(remainingSubprocessTimeout(10.1, 100, 20.6, 10), 79);
  for (const args of [[0, 0, 0], [0, 100, -1], [NaN, 100, 1], [0, 100, 100], [0, 100, 99.9], [0, Infinity, 1], [0, 100, 1, -1]]) {
    assert.throws(() => remainingSubprocessTimeout(...args));
  }
});
test('subprocess timeout reaches the real Node spawn with a valid integer timeout', () => {
  const r = spawnWithinBudget(process.execPath, ['-e', 'process.stdout.write("closed")'],
    {startedMono: performance.now(), budgetMs: 10000, encoding: 'utf8'});
  assert.equal(r.status, 0); assert.equal(r.error, undefined); assert.equal(r.stdout, 'closed');
});
test('subprocess timeout refuses zero or override before reaching its child seam', () => {
  let calls = 0; const run = () => { calls++; return {}; };
  assert.throws(() => spawnWithinBudget('unused', [], {startedMono: performance.now() - 100, budgetMs: 1}, run));
  assert.throws(() => spawnWithinBudget('unused', [], {startedMono: performance.now(), budgetMs: 1000, timeout: 0}, run));
  assert.throws(() => spawnWithinBudget('unused', [], {startedMono: performance.now(), budgetMs: 1000, shell: true}, run)); assert.equal(calls, 0);
});
test('checkout CLI rejects incomplete input before any gate or worker starts', () => {
  const r = spawnSync(process.execPath, ['scripts/check-author-checkout.mjs', '--bundle', '/missing'], {encoding: 'utf8'});
  assert.equal(r.status, 2); assert.match(r.stderr, /checkout diagnostic unavailable/);
});
test('checkout CLI has real ready blocked unknown and help outcomes without borrowing a test PASS', t => {
  const f = fixture(t);
  const run = (args: string[]) => spawnSync(process.execPath, ['scripts/check-author-checkout.mjs', '--root', f.root,
    '--head', f.git('rev-parse', 'HEAD'), '--upstream', upstream, ...args], {encoding: 'utf8'});
  assert.equal(run([]).status, 2, 'missing dependency metadata is unknown, not ready');
  copyFileSync('package-lock.json', join(f.root, 'package-lock.json'));
  writeFileSync(join(f.root, '.gitignore'), 'node_modules\n');
  symlinkSync(realpathSync('node_modules'), join(f.root, 'node_modules'), 'dir');
  f.git('add', 'package-lock.json', '.gitignore'); f.git('commit', '--quiet', '-m', 'fixture dependencies');
  const ready = run([]); assert.equal(ready.status, 0, ready.stderr + ready.stdout); assert.equal(JSON.parse(ready.stdout).executionAllowed, false);
  const bundle = join(f.root, '.git/current.bundle'); f.git('bundle', 'create', bundle, 'HEAD');
  assert.equal(run(['--bundle', bundle, '--bundle-head', f.git('rev-parse', 'HEAD')]).status, 0);
  f.git('remote', 'set-url', 'origin', f.root); assert.equal(run([]).status, 3);
  assert.equal(spawnSync(process.execPath, ['scripts/check-author-checkout.mjs', '--help'], {encoding: 'utf8'}).status, 0);
});
test('checkout diagnostics refuse malformed or changed bundle and environment evidence', t => {
  const f = fixture(t); assert.equal(f.check({bundles: [{}]}).state, 'blocked');
  assert.equal(f.check({bundles: [{path: f.root, head: f.head}]}).state, 'blocked');
  assert.equal(f.check({bundles: [{path: join(f.root, 'absent'), head: f.head}]}).state, 'unknown');
  const path = join(f.root, '.git/known.bundle'); f.git('bundle', 'create', path, 'HEAD');
  assert.equal(f.check({bundles: [{path, head: 'b'.repeat(40)}]}).state, 'blocked');
  const old = process.env.GIT_INDEX_FILE; process.env.GIT_INDEX_FILE = '/not-our-index';
  try { assert.equal(f.check().state, 'blocked'); } finally { if (old === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = old; }
  // Default positive controls retain tmp-hygiene's dead-push and no-background-GC entries.
  // Appending any other entry must still refuse before the subprocess seam is reached.
  const count = process.env.GIT_CONFIG_COUNT, at = Number(count ?? '0');
  const key = 'GIT_CONFIG_KEY_' + at, value = 'GIT_CONFIG_VALUE_' + at;
  process.env.GIT_CONFIG_COUNT = String(at + 1); process.env[key] = 'core.sshCommand'; process.env[value] = 'untrusted';
  let calls = 0;
  try {
    const refused = f.check({}, {spawn: () => { calls++; throw Error('must not execute'); }});
    assert.equal(refused.state, 'blocked'); assert.equal(refused.failures[0].code, 'git-environment-override'); assert.equal(calls, 0);
  } finally {
    delete process.env[key]; delete process.env[value];
    if (count === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT = count;
  }
  let changed = false;
  const r = f.check({bundles: [{path, head: f.head}]}, {spawn: (file: string, args: string[], options: object) => {
    const out = spawnWithinBudget(file, args, options);
    if (args.includes('verify')) { writeFileSync(path, 'changed after verification'); changed = true; }
    return out;
  }});
  assert(changed); assert.equal(r.state, 'unknown'); assert(r.failures.some((x: {code: string}) => x.code === 'bundle-changed'));
});
test('checkout diagnostics detect a changing source and sanitize failed observations', t => {
  const f = fixture(t); let reads = 0;
  const r = f.check({}, {spawn: (file: string, args: string[], options: object) => {
    const out = spawnWithinBudget(file, args, options);
    if (args.at(-1) === 'HEAD' && ++reads === 2) return {...out, stdout: 'b'.repeat(40)};
    return out;
  }});
  assert.equal(r.state, 'unknown'); assert(r.failures.some((x: {code: string}) => x.code === 'source-changed-during-observation'));
});
