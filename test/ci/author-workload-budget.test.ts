import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {getHeapStatistics} from 'node:v8';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {ownedFixtureDir} from '#test/helpers/owned-fixture-dir.js';
import {makeRuntimeFixture} from '#test/helpers/native-runtime-fixture.js';
import {REPO_ROOT} from '#test/helpers/repo-root.js';

type Budget = {minimumFreeBytes: number; scratchBytes: number};
const admissionModule = '#scripts/lib/mac-author-admission.mjs';
const {boundedAuthorWorkload, boundedAuthorWorkloadFromArgv, readMacAuthorAdmission} = await import(admissionModule) as {
  boundedAuthorWorkload: (scratchMiB: number) => Budget;
  boundedAuthorWorkloadFromArgv: (argv: string[]) => Budget | undefined;
  readMacAuthorAdmission: (root: string, options?: {platform?: string; minimumFreeBytes?: number;
    statfs?: Function; spawn?: Function}) => {state: string; reasons: string[]};
};
const authorModule = '#scripts/preflight-author.mjs';
const {boundedAuthorCaptureClosure, finishBoundedAuthorScratch, main, requireBoundedAuthorHost} = await import(authorModule) as {
  boundedAuthorCaptureClosure: (path: string) => {state: string};
  finishBoundedAuthorScratch: (scratch: {release: () => void}, closed: boolean) => {state: string};
  requireBoundedAuthorHost: (options?: {platform?: string; heapLimitBytes?: number}) => void;
  main: (argv: string[], options: {root: string; select: () => {fullRun: boolean; suites: string[]; reasons: string[]};
    admitHost: () => unknown}) => number;
};

test('ordinary author admission prices declared bounded scratch and outputs below the full coverage reserve', () => {
  const budget = boundedAuthorWorkload(256);
  assert.equal(budget.minimumFreeBytes, 4 * 1024 ** 3 + 2 * budget.scratchBytes + 32 * 8 * 1024 ** 2 + 16 * 1024 ** 2);
  const deps = {platform: 'darwin' as const, statfs: () => ({bavail: 8 * 1024 ** 3, bsize: 1}),
    spawn: () => ({status: 0, stdout: '1'})};
  assert.equal(readMacAuthorAdmission('/w', deps).state, 'not-run');
  assert.equal(readMacAuthorAdmission('/w', {...deps, minimumFreeBytes: budget.minimumFreeBytes}).state, 'admitted');
  const tooSmall = readMacAuthorAdmission('/w', {...deps, minimumFreeBytes: budget.minimumFreeBytes,
    statfs: () => ({bavail: budget.minimumFreeBytes - 1, bsize: 1})});
  assert.equal(tooSmall.state, 'not-run');
  assert.ok(tooSmall.reasons.some((x: string) => x.includes('below-bounded-job-reserve')));
  for (const pressure of ['2', '4', 'invalid']) assert.equal(readMacAuthorAdmission('/w', {...deps,
    minimumFreeBytes: budget.minimumFreeBytes, spawn: () => ({status: 0, stdout: pressure})}).state, 'not-run');
});

test('bounded author CLI spellings share one budget and refuse duplicates and unbounded declarations', () => {
  assert.deepEqual(boundedAuthorWorkloadFromArgv(['--bounded-scratch-mib', '256']),
    boundedAuthorWorkloadFromArgv(['--bounded-scratch-mib=256']));
  assert.equal(boundedAuthorWorkloadFromArgv([]), undefined);
  assert.equal(boundedAuthorWorkloadFromArgv(['--', '--bounded-scratch-mib=256']), undefined);
  assert.throws(() => boundedAuthorWorkloadFromArgv(['--bounded-scratch-mib', '16', '--bounded-scratch-mib=256']), /only once/);
  assert.throws(() => boundedAuthorWorkloadFromArgv(['--bounded-scratch-mib']), /16 through 256/);
  for (const mib of [0, 15, 257, 0.5, NaN, Infinity]) assert.throws(() => boundedAuthorWorkload(mib));
});

test('bounded author runtime refuses unknown or excessive heap and does not claim Node heap is RSS', () => {
  for (const heapLimitBytes of [0, NaN, Infinity, 2 * 1024 ** 3])
    assert.throws(() => requireBoundedAuthorHost({platform: 'darwin', heapLimitBytes}), /actual V8 heap/);
  assert.throws(() => requireBoundedAuthorHost({platform: 'linux', heapLimitBytes: 512 * 1024 ** 2}), /Linux\/hosted admission is unchanged/);
  requireBoundedAuthorHost({platform: 'darwin', heapLimitBytes: getHeapStatistics().heap_size_limit});
});

test('a missing, malformed or unrelated capture receipt cannot authorize bounded author scratch cleanup', t => {
  const {dir} = ownedFixtureDir(t, 'author-budget-closure');
  const path = join(dir, 'native.json');
  assert.equal(boundedAuthorCaptureClosure(path).state, 'unknown');
  writeFileSync(path, '{'); assert.equal(boundedAuthorCaptureClosure(path).state, 'unknown');
  writeFileSync(path, JSON.stringify({parentTracking: {ownerPid: -1, childPid: null}}));
  assert.equal(boundedAuthorCaptureClosure(path).state, 'unknown');
  writeFileSync(path, JSON.stringify({status: null, error: {code: 'ENOENT'}, spawnCloseCode: -2,
    parentTracking: {ownerPid: process.pid, childPid: null}}));
  assert.equal(boundedAuthorCaptureClosure(path).state, 'closed');
});

test('bounded author help is read only and advertises ordinary selection with resource limits', () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'scripts/preflight-author.mjs'),
    '--bounded-scratch-mib=256', '--help'], {cwd: REPO_ROOT, env: process.env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 ** 2});
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /bounded-scratch-mib/);
  assert.match(child.stdout, /120s\/8MiB and one worker/);
});

test('bounded author unknown closure and failed detach preserve their volume and refuse cleanup', () => {
  let released = 0;
  const scratch = {release: () => {released++;}};
  assert.equal(finishBoundedAuthorScratch(scratch, false).state, 'retained-child-closure-unproven');
  assert.equal(released, 0);
  assert.equal(finishBoundedAuthorScratch({release: () => {throw new Error('busy volume');}}, true).state, 'retained-detach-failed');
  assert.equal(finishBoundedAuthorScratch(scratch, true).state, 'closed-and-removed');
  assert.equal(released, 1);
});

test('bounded author closure probes retain a live native group until that exact child exits', {timeout: 20000}, async t => {
  if (process.platform === 'win32') return;
  const {dir} = ownedFixtureDir(t, 'author-budget-live-group');
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], {detached: true, stdio: 'ignore'});
  let exited = false;
  const closed = once(child, 'exit').then(() => {exited = true;});
  t.after(async () => {if (!exited) {child.kill('SIGTERM'); await closed;}});
  await once(child, 'spawn');
  const path = join(dir, 'native.json');
  writeFileSync(path, JSON.stringify({parentTracking: {ownerPid: process.pid, childPid: child.pid}}));
  assert.equal(boundedAuthorCaptureClosure(path).state, 'unknown');
  child.kill('SIGTERM'); await closed;
  assert.equal(boundedAuthorCaptureClosure(path).state, 'closed');
});

test('the ordinary bounded author uses its real fixed volume and records natural native child closure', t => {
  if (process.platform !== 'darwin') {
    assert.throws(() => requireBoundedAuthorHost(), /native Mac volume/);
    return;
  }
  const fixture = makeRuntimeFixture(); t.after(() => fixture.cleanup());
  const packages = Object.fromEntries(['tsx', 'typescript', '@commitlint/cli'].map(name =>
    [`node_modules/${name}`, {version: JSON.parse(readFileSync(join(fixture.dir, 'node_modules', name, 'package.json'), 'utf8')).version}]));
  writeFileSync(join(fixture.dir, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages}));
  fixture.git('add', 'package-lock.json'); fixture.git('commit', '-m', 'test: lock bounded author fixture tools');
  const result = main(['--bounded-scratch-mib=64'], {root: fixture.dir,
    select: () => ({fullRun: false, suites: ['test/a.test.ts', 'test/b.test.ts'], reasons: ['real bounded author fixture']}),
    admitHost: () => ({state: 'admitted', fixtureOnly: true})});
  const receipt = JSON.parse(readFileSync(join(fixture.dir, 'coverage/preflight-author.json'), 'utf8'));
  assert.equal(result, 0, JSON.stringify(receipt));
  assert.equal(receipt.verdict, 'passed');
  assert.equal(receipt.resourceBudget.cleanup, 'closed-and-removed');
  assert.equal(receipt.resourceBudget.childProcessGroupsClosed, true);
  assert.equal(receipt.resourceBudget.stepOutputBytes, 8 * 1024 ** 2);
  assert.equal(receipt.resourceBudget.stepRuntimeMs, 120000);
  assert.equal(receipt.executionWorkers, 1);
  assert.ok(receipt.resourceBudget.completedPhaseCaptures >= 2);
  assert.equal(existsSync(receipt.resourceBudget.scratch.dir), false);
});

test('a real failed ordinary bounded author keeps its failed verdict and closes only its own scratch', t => {
  if (process.platform !== 'darwin') {
    assert.throws(() => requireBoundedAuthorHost(), /native Mac volume/);
    return;
  }
  const fixture = makeRuntimeFixture(true); t.after(() => fixture.cleanup());
  const packages = Object.fromEntries(['tsx', 'typescript', '@commitlint/cli'].map(name =>
    [`node_modules/${name}`, {version: JSON.parse(readFileSync(join(fixture.dir, 'node_modules', name, 'package.json'), 'utf8')).version}]));
  writeFileSync(join(fixture.dir, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages}));
  fixture.git('add', 'package-lock.json'); fixture.git('commit', '-m', 'test: lock failed bounded author tools');
  const result = main(['--bounded-scratch-mib', '64'], {root: fixture.dir,
    select: () => ({fullRun: false, suites: ['test/b.test.ts'], reasons: ['real failed bounded author fixture']}),
    admitHost: () => ({state: 'admitted', fixtureOnly: true})});
  const receipt = JSON.parse(readFileSync(join(fixture.dir, 'coverage/preflight-author.json'), 'utf8'));
  assert.equal(result, 1);
  assert.equal(receipt.verdict, 'failed');
  assert.equal(receipt.steps.find((row: {name: string}) => row.name === 'affected-tests').ok, false);
  assert.equal(receipt.resourceBudget.cleanup, 'closed-and-removed');
  assert.equal(existsSync(receipt.resourceBudget.scratch.dir), false);
});

test('ordinary bounded author stops real oversized native output and preserves the failed phase', t => {
  if (process.platform !== 'darwin') return;
  const fixture = makeRuntimeFixture(); t.after(() => fixture.cleanup());
  const packages = Object.fromEntries(['tsx', 'typescript', '@commitlint/cli'].map(name =>
    [`node_modules/${name}`, {version: JSON.parse(readFileSync(join(fixture.dir, 'node_modules', name, 'package.json'), 'utf8')).version}]));
  writeFileSync(join(fixture.dir, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages}));
  writeFileSync(join(fixture.dir, 'src/run-task.ts'), 'process.stdout.write(Buffer.alloc(9*1024**2,120));\n');
  fixture.git('add', '.'); fixture.git('commit', '-m', 'test: emit oversized native diagnostics');
  const result = main(['--bounded-scratch-mib', '64'], {root: fixture.dir,
    select: () => ({fullRun: false, suites: ['test/a.test.ts'], reasons: ['oversized native output fixture']}),
    admitHost: () => ({state: 'admitted', fixtureOnly: true})});
  const receipt = JSON.parse(readFileSync(join(fixture.dir, 'coverage/preflight-author.json'), 'utf8'));
  const phase = receipt.steps.find((row: {name: string}) => row.name === 'static-preflight');
  assert.equal(result, 1);
  assert.equal(receipt.verdict, 'failed');
  assert.equal(phase.error.code, 'ERR_AUTHOR_OUTPUT_LIMIT');
  assert.ok(phase.diagnostics.stdoutBytes + phase.diagnostics.stderrBytes <= 8 * 1024 ** 2);
  assert.equal(receipt.resourceBudget.cleanup, 'closed-and-removed');
});
