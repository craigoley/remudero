/** @source-text-subject: .github/workflows/ci.yml and coverage-nightly.yml pinned floor contract. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
// @ts-expect-error TS7016: the dependency-free executable has no TS declarations.
import { context, produce, validateFloor, selectFloor, verifyPin, finalizePin, main, MAX_AGE_MS, waitForPinArtifact } from '#scripts/coverage-floor.mjs';
import { gitRepo } from '#test/helpers/git-repo.js';
import { ghShim } from '#test/helpers/gh-shim.js';
// @ts-expect-error TS7016: the repository-root executable has no TS declarations.
import { REPO_ROOT } from '#scripts/lib/repo-root.mjs';

const NOW = Date.now();
const LCOV = 'SF:src/control.ts\nDA:1,1\nLF:1\nLH:1\nBRDA:1,0,0,1\nBRF:1\nBRH:1\nend_of_record\n';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function shell(root: string, file: string, args: string[]) {
  const r = spawnSync(file, args, { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
function fixture(t: { after(fn: () => void): void }) {
  const repo = gitRepo({ kind: 'floor-control', seedCommit: false });
  const root = repo.dir;
  t.after(() => repo.cleanup());
  const put = (path: string, value: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), value); };
  for (const path of ['package-lock.json', '.nvmrc', 'package.json', 'scripts/coverage-merge-ratchet.mjs',
    'scripts/coverage-floor.mjs', 'scripts/coverage-baseline.json', 'scripts/test-tier-manifest.mjs',
    'scripts/pure-test-pool.mjs', 'test/setup/tmp-hygiene.ts']) {
    mkdirSync(join(root, path, '..'), { recursive: true }); cpSync(join(REPO_ROOT, path), join(root, path));
  }
  for (const path of ['.github/workflows/ci.yml', '.github/workflows/coverage-nightly.yml',
    'scripts/test-with-retry.mjs', 'tsconfig.json']) {
    mkdirSync(join(root, path, '..'), { recursive: true }); cpSync(join(REPO_ROOT, path), join(root, path));
  }
  for (const path of ['scripts/lib/argv.mjs', 'scripts/lib/repo-root.mjs']) {
    mkdirSync(join(root, path, '..'), { recursive: true }); cpSync(join(REPO_ROOT, path), join(root, path));
  }
  put('.nvmrc', process.versions.node + '\n');
  const suites = Array.from({ length: 16 }, (_, n) => `test/control-${n}.test.ts`);
  for (const suite of suites) put(suite, 'export {};\n');
  repo.git('add', '.'); repo.git('commit', '-qm', 'full floor corpus');
  repo.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const env = { ...process.env, GITHUB_REPOSITORY: 'fixture/repo', GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: 'refs/heads/main', RMD_AFFECTED_SUITE_LIVE: '1' };
  for (let n = 1; n <= 8; n++) {
    const dir = `coverage-shards/coverage-shard-${n}`;
    put(`${dir}/suites`, suites.slice((n - 1) * 2, n * 2).join('\n') + '\n');
    put(`${dir}/test-exit`, '0\n'); put(`${dir}/selection`, 'all\n');
  }
  const current = context(root, env); const floor = produce(root, join(root, 'coverage-shards'), LCOV, env, NOW);
  const run = { id: 101, run_attempt: 1, head_sha: current.head, head_branch: 'main', event: 'schedule',
    path: '.github/workflows/coverage-nightly.yml', status: 'completed', conclusion: 'success', repository: { id: 17 },
    updated_at: new Date(NOW).toISOString() };
  const artifact = { id: 77, name: 'coverage-nightly', expired: false, size_in_bytes: 1,
    workflow_run: { id: 101, repository_id: 17, head_sha: current.head }, created_at: new Date(NOW).toISOString(), digest: '' };
  const archiveDir = join(root, 'archive'); mkdirSync(archiveDir);
  const archive = () => {
    writeFileSync(join(archiveDir, 'lcov.info'), LCOV);
    writeFileSync(join(archiveDir, 'coverage-floor.json'), JSON.stringify(floor));
    rmSync(join(root, 'floor.zip'), { force: true });
    shell(archiveDir, 'zip', ['-q', join(root, 'floor.zip'), 'lcov.info', 'coverage-floor.json']);
    const data = readFileSync(join(root, 'floor.zip')); artifact.size_in_bytes = data.length; artifact.digest = `sha256:${digest(data)}`; return data;
  };
  const data = archive(); const calls: string[][] = [];
  const transport = (args: string[], binary = false) => {
    calls.push(args);
    if (args[1].includes('/workflows/')) return JSON.stringify({ workflow_runs: args[1].includes('coverage-nightly') ? [run] : [] });
    if (args[1].includes('/runs/')) return JSON.stringify({ artifacts: [artifact] });
    assert.equal(binary, true); return data;
  };
  const prEnv = { ...env, GITHUB_RUN_ID: '202', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge' };
  return { root, git: repo.git, put, suites, env, prEnv, current, floor, run, artifact, archive, transport, calls, pin: join(root, 'pin') };
}

test('a complete fresh successful floor admits one immutable pin, not a second lookup after tests', (t) => {
  const f = fixture(t);
  assert.equal(validateFloor(f.root, f.floor, LCOV, f.run, f.artifact, f.current, NOW), true);
  const pin = selectFloor(f.root, f.pin, f.prEnv, f.transport, NOW);
  assert.equal(pin.mode, 'eligible'); assert.equal(f.calls.length, 4);
  assert.equal(verifyPin(f.root, f.pin, f.prEnv, NOW).floor.run, '101');
  writeFileSync(join(f.pin, 'lcov.info'), LCOV.replace('DA:1,1', 'DA:1,0'));
  assert.throws(() => verifyPin(f.root, f.pin, f.prEnv, NOW), /digest mismatch/);
  assert.equal(f.calls.length, 4, 'verification must never pick another provider artifact');
});

test('flag off, push and merge group choose full without a GitHub read', (t) => {
  const f = fixture(t);
  for (const env of [{ ...f.prEnv, RMD_AFFECTED_SUITE_LIVE: '0' }, { ...f.prEnv, GITHUB_EVENT_NAME: 'push' },
    { ...f.prEnv, GITHUB_EVENT_NAME: 'merge_group' }]) {
    assert.equal(selectFloor(f.root, f.pin, env, () => { throw new Error('must not read'); }, NOW).mode, 'all');
    assert.equal(verifyPin(f.root, f.pin, env, NOW).mode, 'all');
  }
});

test('completed-red and missing artifacts produce a named full fallback before narrowing', (t) => {
  const f = fixture(t); f.run.conclusion = 'failure';
  const red = selectFloor(f.root, f.pin, f.prEnv, f.transport, NOW);
  assert.equal(red.mode, 'all'); assert.match(red.reason, /not successful/);
  const missing = selectFloor(f.root, f.pin, f.prEnv, () => JSON.stringify({ workflow_runs: [] }), NOW);
  assert.equal(missing.mode, 'all'); assert.match(missing.reason, /no successful producer candidates/);
});

test('producer refuses red exits, incomplete union, duplicate suites, ghost paths and narrowed measurements', (t) => {
  const f = fixture(t); const make = () => produce(f.root, join(f.root, 'coverage-shards'), LCOV, f.env, NOW);
  for (const [file, text, error] of [['test-exit', '1\n', /nonzero/], ['selection', 'narrow\n', /partial/],
    ['suites', 'test/ghost.test.ts\n', /unverified/], ['suites', f.suites[0] + '\n' + f.suites[0], /duplicate/],
    ['suites', f.suites[0] + '\n', /incomplete/]] as const) {
    const path = 'coverage-shards/coverage-shard-1/' + file; const before = readFileSync(join(f.root, path), 'utf8');
    f.put(path, text); assert.throws(make, error); f.put(path, before);
  }
  assert.equal(make().shards.length, 8);
  assert.throws(() => produce(f.root, join(f.root, 'coverage-shards'), '', f.env, NOW), /LCOV/);
});

test('age boundary is inclusive, expired and future timestamps refuse', (t) => {
  const f = fixture(t);
  assert.equal(validateFloor(f.root, f.floor, LCOV, f.run, f.artifact, f.current, NOW + MAX_AGE_MS), true);
  assert.throws(() => validateFloor(f.root, f.floor, LCOV, f.run, f.artifact, f.current, NOW + MAX_AGE_MS + 1), /expired/);
  assert.throws(() => validateFloor(f.root, f.floor, LCOV, f.run, f.artifact, f.current, NOW - 1), /future/);
});

test('runtime, attempt, repository, source tree, policy and content identities are mandatory', (t) => {
  const f = fixture(t); const check = (floor = f.floor, run = f.run, artifact = f.artifact, ctx = f.current) => validateFloor(f.root, floor, LCOV, run, artifact, ctx, NOW);
  for (const change of [{ node: process.version === 'v24.21.0' ? 'v22.22.3' : 'v24.21.0' }, { attempt: 2 }, { repository: 'other/repo' }, { tree: '0'.repeat(40) },
    { policyDigest: 'other' }, { lcovDigest: '0'.repeat(64) }, { version: 0 }, { shards: [] }])
    assert.throws(() => check({ ...f.floor, ...change }));
  assert.throws(() => check(f.floor, { ...f.run, conclusion: 'failure' }), /successful/);
  assert.throws(() => check(f.floor, f.run, { ...f.artifact, expired: true }), /identity/);
  assert.throws(() => check(f.floor, f.run, f.artifact, { ...f.current, node: 'different' }), /runtime/);
  assert.equal(check(), true, 'positive control sees the actual matching corpus');
});

test('a merge-group floor requires its measured tree on protected main, not only a green run', (t) => {
  const f = fixture(t); f.put('test/unmerged.test.ts', 'export {};'); f.git('add', 'test');
  f.git('commit', '-qm', 'unmerged tree');
  const floor = { ...f.floor, head: shell(f.root, 'git', ['rev-parse', 'HEAD']), tree: shell(f.root, 'git', ['rev-parse', 'HEAD^{tree}']), event: 'merge_group', ref: 'refs/heads/gh-readonly-queue/main/group' };
  const run = { ...f.run, path: '.github/workflows/ci.yml', event: 'merge_group', head_sha: floor.head };
  const artifact = { ...f.artifact, name: 'coverage-merged', workflow_run: { ...f.artifact.workflow_run, head_sha: floor.head } };
  assert.throws(() => validateFloor(f.root, floor, LCOV, run, artifact, f.current, NOW), /protected main ancestry/);
});

test('the real helper CLI refuses a ghost pin and execution identity drift', (t) => {
  const f = fixture(t);
  selectFloor(f.root, f.pin, { ...f.prEnv, RMD_AFFECTED_SUITE_LIVE: '0' }, f.transport, NOW);
  const cli = (dir: string, env = f.prEnv) => spawnSync(process.execPath, ['scripts/coverage-floor.mjs', 'mode', dir], { cwd: f.root, env, encoding: 'utf8' });
  assert.equal(cli(f.pin).status, 0);
  assert.notEqual(cli(join(f.root, 'ghost')).status, 0);
  assert.notEqual(cli(f.pin, { ...f.prEnv, GITHUB_RUN_ATTEMPT: '2' }).status, 0);
  const actual = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/coverage-floor.mjs'), 'mode', join(f.root, 'ghost')],
    { cwd: REPO_ROOT, env: f.prEnv, encoding: 'utf8' });
  assert.notEqual(actual.status, 0);
  assert.match(actual.stderr, /coverage-floor: REFUSED:.*ENOENT/);
});

test('the committed producer entry preserves red diagnostics and rejects unreadable exits', (t) => {
  const f = fixture(t); f.put('produced/lcov.info', LCOV);
  assert.equal(main(['record', join(f.root, 'produced'), join(f.root, 'produced/lcov.info')], f.env, f.root), 0);
  const file = join(f.root, 'produced/coverage-floor.json');
  assert.equal(validateFloor(f.root, JSON.parse(readFileSync(file, 'utf8')), LCOV, f.run, f.artifact, f.current), true);
  f.put('coverage-shards/coverage-shard-2/test-exit', '1\n');
  assert.equal(main(['record', join(f.root, 'produced'), join(f.root, 'produced/lcov.info')], f.env, f.root), 0);
  const red = readFileSync(file, 'utf8');
  assert.equal(JSON.parse(red).version, 0);
  assert.throws(() => validateFloor(f.root, JSON.parse(red), LCOV, f.run, f.artifact, f.current), /legacy/);
  f.put('coverage-shards/coverage-shard-2/test-exit', 'unreadable\n');
  assert.throws(() => main(['record', join(f.root, 'produced'), join(f.root, 'produced/lcov.info')], f.env, f.root), /unreadable producer exits/);
  assert.equal(readFileSync(file, 'utf8'), red, 'an unreadable exit must not replace the diagnostic record');
});

test('the committed consumer entry shares one verified decision and refuses shard disagreement', (t) => {
  const f = fixture(t); const output: string[] = [];
  t.mock.method(console, 'log', (value: string) => output.push(value));
  assert.equal(main(['select', f.pin], { ...f.prEnv, RMD_AFFECTED_SUITE_LIVE: '0' }, f.root), 0);
  assert.match(output.pop()!, /live flag off/);
  assert.equal(main(['mode', f.pin], f.prEnv, f.root), 0); assert.equal(output.pop(), 'all');
  assert.equal(main(['shard', f.pin, '1'], f.prEnv, f.root), 0); assert.equal(output.length, 0);
  selectFloor(f.root, f.pin, f.prEnv, f.transport);
  assert.throws(() => main(['shard', f.pin, '1'], f.prEnv, f.root), /unfinalized/);
  f.put('candidates.txt', f.suites.join('\n') + '\n');
  assert.equal(main(['finalize', f.pin, join(f.root, 'candidates.txt')], f.prEnv, f.root), 0);
  output.pop();
  const pinned = verifyPin(f.root, f.pin, f.prEnv);
  for (let n = 1; n <= 8; n++) {
    assert.equal(main(['shard', f.pin, String(n)], f.prEnv, f.root), 0);
    assert.deepEqual(output.pop()!.split('\n'), pinned.shards[n - 1]);
    f.put(`observed-shards/coverage-shard-${n}/selection`, 'narrow\n');
  }
  assert.equal(main(['verify-shards', f.pin, join(f.root, 'observed-shards')], f.prEnv, f.root), 0);
  f.put('observed-shards/coverage-shard-3/selection', 'all\n');
  assert.throws(() => main(['verify-shards', f.pin, join(f.root, 'observed-shards')], f.prEnv, f.root), /shards disagree/);
  assert.throws(() => main(['shard', f.pin, '9'], f.prEnv, f.root), /invalid shard/);
  assert.throws(() => main(['unknown', f.pin], f.prEnv, f.root), /expected produce/);
  assert.equal(f.calls.length, 4, 'entry consumers never replace the admitted provider artifact');
});

test('one finalized selection covers all eight shards and an empty narrow shard makes the whole run full', (t) => {
  const f = fixture(t); selectFloor(f.root, f.pin, f.prEnv, f.transport, NOW);
  // Real duration allocator and verified files, not eight synthetic nonempty answers.
  const candidates = join(f.root, 'candidates.txt'); writeFileSync(candidates, f.suites.join('\n') + '\n');
  const pin = finalizePin(f.root, f.pin, candidates, f.prEnv);
  assert.equal(pin.mode, 'narrow'); assert.deepEqual(new Set(pin.shards.flat()), new Set(f.suites));
  assert.equal(verifyPin(f.root, f.pin, f.prEnv, NOW).shards.length, 8);
  selectFloor(f.root, f.pin, f.prEnv, f.transport, NOW); writeFileSync(candidates, f.suites[0] + '\n');
  const full = finalizePin(f.root, f.pin, candidates, f.prEnv);
  assert.equal(full.mode, 'all'); assert.match(full.reason, /global full fallback/);
});

test('GitHub outage, archive digest mismatch and legacy uploads cannot authorize narrowing', (t) => {
  const f = fixture(t);
  const unavailable = selectFloor(f.root, f.pin, f.prEnv, () => { throw new Error('transport unavailable'); }, NOW);
  assert.equal(unavailable.mode, 'all'); assert.match(unavailable.reason, /transport unavailable/);
  f.artifact.digest = 'sha256:' + '0'.repeat(64);
  assert.match(selectFloor(f.root, f.pin, f.prEnv, f.transport, NOW).reason, /archive digest mismatch/);
});


test('red nightly measurements still upload diagnostics with an explicitly inadmissible producer record', (t) => {
  const f = fixture(t); f.put('coverage-shards/coverage-shard-2/test-exit', '1\n');
  f.put('measurement/lcov.info', LCOV);
  const recorded = spawnSync(process.execPath, ['scripts/coverage-floor.mjs', 'record', 'measurement', 'measurement/lcov.info'], { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
  const receipt = JSON.parse(readFileSync(join(f.root, 'measurement/coverage-floor.json'), 'utf8'));
  assert.equal(receipt.version, 0); assert.match(receipt.reason, /red measurement/);
  assert.throws(() => validateFloor(f.root, receipt, LCOV, f.run, f.artifact, f.current, NOW), /legacy/);
});

test('an unsafe archive and a missing runtime identity select full with bounded transport calls', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'archive/extra'), 'not an allowed floor entry');
  shell(join(f.root, 'archive'), 'zip', ['-q', join(f.root, 'floor.zip'), 'extra']);
  const data = readFileSync(join(f.root, 'floor.zip')); f.artifact.digest = 'sha256:' + digest(data);
  const unsafe = (args: string[], binary = false) => binary ? data : f.transport(args);
  const decision = selectFloor(f.root, f.pin, f.prEnv, unsafe, NOW);
  assert.equal(decision.mode, 'all'); assert.match(decision.reason, /unsafe archive entries/);
  assert.ok(f.calls.length <= 4);
  selectFloor(f.root, f.pin, { ...f.prEnv, RMD_AFFECTED_SUITE_LIVE: '0' }, f.transport, NOW);
  const missing = { ...f.prEnv, GITHUB_RUN_ID: '203' };
  assert.throws(() => verifyPin(f.root, f.pin, missing, NOW), /execution mismatch/);
});


test('a positive-looking but truncated or malformed LCOV is not a complete floor', (t) => {
  const f = fixture(t);
  for (const lcov of [LCOV.replace('end_of_record', ''), LCOV.replace('DA:1,1\n', ''), LCOV.replace('BRF:1', 'BRF:2'), LCOV.replace('LH:1', 'LH:2')])
    assert.throws(() => produce(f.root, join(f.root, 'coverage-shards'), lcov, f.env, NOW), /LCOV/);
  assert.equal(produce(f.root, join(f.root, 'coverage-shards'), LCOV, f.env, NOW).corpus.sources, 1);
});


test('producer source identity cannot certify an uncommitted tracked-tree mutation', (t) => {
  const f = fixture(t); f.put(f.suites[0], 'export const changed = true;\n');
  assert.throws(() => produce(f.root, join(f.root, 'coverage-shards'), LCOV, f.env, NOW), /tree is dirty/);
});

test('coverage-policy identity follows the actual committed producer and loader definitions', (t) => {
  const f = fixture(t);
  assert.equal(validateFloor(f.root, f.floor, LCOV, f.run, f.artifact, f.current, NOW), true);
  const workflow = '.github/workflows/coverage-nightly.yml';
  const before = readFileSync(join(f.root, workflow), 'utf8');
  f.put(workflow, before.replace('--enable-source-maps', '--no-enable-source-maps'));
  f.git('add', workflow); f.git('commit', '-qm', 'change actual instrumentation policy');
  const changed = context(f.root, f.prEnv);
  assert.notEqual(changed.policyDigest, f.current.policyDigest);
  assert.throws(() => validateFloor(f.root, f.floor, LCOV, f.run, f.artifact, changed, NOW), /coverage policy/);
});

test('the real producer CLI and all eight pinned consumers preserve one decision and reject disagreement', (t) => {
  const f = fixture(t);
  const cli = (args: string[], env = f.prEnv) => spawnSync(process.execPath,
    ['scripts/coverage-floor.mjs', ...args], { cwd: f.root, env, encoding: 'utf8' });
  f.put('produced/lcov.info', LCOV);
  const recorded = cli(['record', 'produced', 'produced/lcov.info'], f.env);
  assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
  const produced = JSON.parse(readFileSync(join(f.root, 'produced/coverage-floor.json'), 'utf8'));
  assert.equal(produced.version, 1); assert.equal(produced.shards.length, 8);
  assert.equal(validateFloor(f.root, produced, LCOV, f.run, f.artifact, f.current), true);
  selectFloor(f.root, f.pin, f.prEnv, f.transport);
  const unfinalized = cli(['shard', f.pin, '1']);
  assert.notEqual(unfinalized.status, 0); assert.match(unfinalized.stderr, /unfinalized/);
  f.put('candidates.txt', f.suites.join('\n') + '\n');
  const finalized = cli(['finalize', f.pin, 'candidates.txt']);
  assert.equal(finalized.status, 0, finalized.stdout + finalized.stderr);
  const selected: string[] = [];
  for (let n = 1; n <= 8; n++) {
    const shard = cli(['shard', f.pin, String(n)]);
    assert.equal(shard.status, 0, shard.stdout + shard.stderr);
    selected.push(...shard.stdout.trim().split('\n'));
    f.put(`observed-shards/coverage-shard-${n}/selection`, 'narrow\n');
  }
  assert.equal(new Set(selected).size, f.suites.length);
  assert.deepEqual(new Set(selected), new Set(f.suites));
  assert.notEqual(cli(['shard', f.pin, '0']).status, 0);
  const matching = cli(['verify-shards', f.pin, 'observed-shards']);
  assert.equal(matching.status, 0, matching.stdout + matching.stderr);
  f.put('observed-shards/coverage-shard-3/selection', 'all\n');
  const mismatch = cli(['verify-shards', f.pin, 'observed-shards']);
  assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /shards disagree/);
  assert.equal(f.calls.length, 4, 'consumers verify the shared pin without another provider lookup');
});

test('the actual workflow owner executes the real helper and selector with only synthetic GitHub transport', (t) => {
  const f = fixture(t);
  // A real unknown-path change must retain global full selection after a valid floor admission.
  f.put('operator-change.txt', 'unknown selector input\n');
  f.git('add', 'operator-change.txt'); f.git('commit', '-qm', 'unknown change');
  const doc = parseYaml(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
  const owner = doc.jobs['squash-trailer-gate'].steps.find((s: { name?: string }) =>
    s.name === 'Pin one verified historical coverage floor before any narrowing');
  assert.ok(owner?.run, 'the actual single owner must exist');
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(f.root, 'node_modules'), 'dir');
  const bin = join(f.root, 'bin'); mkdirSync(bin); symlinkSync(process.execPath, join(bin, 'node'));
  const gh = ghShim([
    { when: '/workflows/coverage-nightly.yml/', stdout: JSON.stringify({ workflow_runs: [f.run] }) },
    { when: '/workflows/ci.yml/', stdout: JSON.stringify({ workflow_runs: [] }) },
    { when: '/runs/101/artifacts', stdout: JSON.stringify({ artifacts: [f.artifact] }) },
    { when: '/artifacts/77/zip', stdoutFile: join(f.root, 'floor.zip') },
    { when: '', stderr: 'unexpected floor transport', exit: 97 },
  ]);
  t.after(() => rmSync(gh.dir, { recursive: true, force: true }));
  f.put('owner.sh', owner.run);
  const env = { ...f.prEnv, PATH: bin + ':' + gh.dir + ':' + process.env.PATH, RUNNER_TEMP: f.root,
    GITHUB_WORKSPACE: REPO_ROOT };
  const run = spawnSync('bash', ['--noprofile', '--norc', '-e', 'owner.sh'], { cwd: f.root, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /fresh complete compatible floor/);
  assert.match(run.stdout, /live coverage selection -> FULL/);
  const pin = verifyPin(f.root, join(f.root, 'coverage-floor-pin'), f.prEnv);
  assert.equal(pin.mode, 'all'); assert.match(pin.reason, /selector did not produce a verified narrow set/);
  const calls = gh.calls();
  assert.equal(calls.length, 4, 'one bounded floor selection, no later replacement');
  const consumer = spawnSync(process.execPath, ['scripts/coverage-floor.mjs', 'mode', 'coverage-floor-pin'],
    { cwd: f.root, env, encoding: 'utf8' });
  assert.equal(consumer.status, 0, consumer.stderr); assert.equal(consumer.stdout.trim(), 'all');
  assert.deepEqual(gh.calls(), calls);
});

test('the actual merged-floor owner preserves legacy staging and emits only after a successful full merge-group ratchet', (t) => {
  const doc = parseYaml(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
  const steps = doc.jobs['coverage-ratchet-required'].steps;
  const owner = steps.find((s: { name?: string }) => s.name?.startsWith('Coverage ratchet ('));
  const stage = steps.find((s: { name?: string }) => s.name?.startsWith('Stage the merged lcov'));
  assert.ok(owner?.run && stage?.run);
  assert.ok(owner.run.includes('${{ steps.coverage-artifact.outputs.class }}'));
  const body = owner.run.replace('${{ steps.coverage-artifact.outputs.class }}', 'SOURCE');
  for (const [event, hasCoverage, gradeExit, hasFloor] of [
    ['merge_group', true, 0, true], ['pull_request', true, 0, false],
    ['push', false, 0, false], ['merge_group', true, 1, false],
  ] as const) {
    const f = fixture(t);
    if (hasCoverage) f.put('coverage/lcov.info', LCOV);
    const bin = join(f.root, 'bin'); mkdirSync(bin);
    const nodePath = "'" + process.execPath.replace(/'/g, "'\\''") + "'";
    // Only the existing absolute-floor grader is controlled. The new producer runs
    // its real executable against the committed corpus and all eight shard receipts.
    f.put('bin/node', `#!/usr/bin/env bash\nif [ "$1" = scripts/coverage-ratchet.mjs ]; then exit "${gradeExit}"; fi\nexec ${nodePath} "$@"\n`);
    chmodSync(join(bin, 'node'), 0o755);
    const env = { ...f.env, GITHUB_EVENT_NAME: event, RMD_AFFECTED_SUITE_LIVE: '0',
      GITHUB_STEP_SUMMARY: join(f.root, 'step-summary'), PATH: `${bin}:${process.env.PATH}` };
    const result = spawnSync('bash', ['-e', '-c', body], { cwd: f.root, env, encoding: 'utf8' });
    assert.equal(result.status, gradeExit, result.stdout + result.stderr);
    if (gradeExit === 0) {
      const staged = spawnSync('bash', ['-e', '-c', stage.run], { cwd: f.root, env, encoding: 'utf8' });
      assert.equal(staged.status, 0, staged.stdout + staged.stderr);
      if (hasCoverage) assert.equal(readFileSync(join(f.root, 'coverage-merged-artifact/lcov.info'), 'utf8'), LCOV);
      else assert.equal(readFileSync(join(f.root, 'coverage-merged-artifact/skipped'), 'utf8'), 'skipped\n');
    }
    const recordPath = join(f.root, 'coverage-merged-artifact/coverage-floor.json');
    assert.equal(existsSync(recordPath), hasFloor, `${event}/${gradeExit} floor qualification`);
    if (hasFloor) {
      const record = JSON.parse(readFileSync(recordPath, 'utf8'));
      assert.equal(record.version, 1); assert.equal(record.event, 'merge_group');
      assert.equal(record.shards.length, 8);
    }
  }
});


test('coverage pin readiness overlaps setup, bounds API reads and refuses missing or ambiguous publication', () => {
  const env = { GITHUB_REPOSITORY: 'fixture/repo', GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: 'd'.repeat(40), RMD_COVERAGE_RUN_HEAD: 'a'.repeat(40) };
  const artifact = { id: 77, name: 'coverage-floor-pin-2', expired: false, size_in_bytes: 10,
    digest: 'sha256:' + 'b'.repeat(64), workflow_run: { id: 101, head_sha: env.RMD_COVERAGE_RUN_HEAD } };
  let time = 0; const reads: number[] = [];
  const clock = { now: () => time, sleep: (ms: number) => { time += ms; } };
  const transport = (args: string[]) => {
    reads.push(time);
    assert.equal(args[1], 'repos/fixture/repo/actions/runs/101/artifacts?name=coverage-floor-pin-2&per_page=2');
    return JSON.stringify(reads.length === 3 ? { total_count: 1, artifacts: [artifact] } : { total_count: 0, artifacts: [] });
  };
  assert.equal(waitForPinArtifact(REPO_ROOT, env, transport, clock), '77');
  assert.deepEqual(reads, [0, 180_000, 360_000]);
  time = 0; reads.length = 0;
  assert.throws(() => waitForPinArtifact(REPO_ROOT, env, () => { reads.push(time); return JSON.stringify({ total_count: 0, artifacts: [] }); }, clock), /timed out inside the shard budget/);
  assert.deepEqual(reads, [0, 180_000, 360_000, 540_000]); assert.equal(time, 600_000);
  for (const response of [ {}, { total_count: 1, artifacts: [] }, { total_count: 2, artifacts: [artifact, artifact] },
    ...[{ name: 'coverage-floor-pin-1' }, { expired: true }, { id: 0 }, { size_in_bytes: 0 }, { digest: '' },
      { workflow_run: { id: 102, head_sha: env.RMD_COVERAGE_RUN_HEAD } }, { workflow_run: { id: 101, head_sha: 'c'.repeat(40) } }]
      .map(change => ({ total_count: 1, artifacts: [{ ...artifact, ...change }] })) ]) {
    assert.throws(() => waitForPinArtifact(REPO_ROOT, env, () => JSON.stringify(response), clock), /response|mismatch/);
  }
  assert.throws(() => waitForPinArtifact(REPO_ROOT, { ...env, GITHUB_RUN_ATTEMPT: '' }, transport, clock), /current repository/);
  assert.throws(() => waitForPinArtifact(REPO_ROOT, env, () => { throw Error('GitHub unavailable'); }, clock), /GitHub unavailable/);
});

test('coverage pin readiness uses the real CLI transport and refuses nonzero transport output', t => {
  const env = { ...process.env, GITHUB_REPOSITORY: 'fixture/repo', GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: 'd'.repeat(40), RMD_COVERAGE_RUN_HEAD: 'a'.repeat(40) };
  const artifact = { id: 77, name: 'coverage-floor-pin-2', expired: false, size_in_bytes: 10,
    digest: 'sha256:' + 'b'.repeat(64), workflow_run: { id: 101, head_sha: env.RMD_COVERAGE_RUN_HEAD } };
  for (const fail of [false, true]) {
    const shim = ghShim([{ when: 'api repos/fixture/repo/actions/runs/101/artifacts',
      stdout: JSON.stringify({ total_count: 1, artifacts: [artifact] }), exit: fail ? 2 : 0 }]);
    t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, ['scripts/coverage-floor.mjs', 'wait-pin'], {
      cwd: REPO_ROOT, env: { ...env, PATH: `${shim.dir}:${process.env.PATH ?? ''}` }, encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.status, fail ? 1 : 0, result.stderr);
    if (fail) assert.match(result.stderr, /REFUSED/); else assert.equal(result.stdout.trim(), '77');
  }
});
