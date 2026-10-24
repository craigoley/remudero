import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {getHeapStatistics} from 'node:v8';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {ownedFixtureDir} from '#test/helpers/owned-fixture-dir.js';
import {makeRuntimeFixture} from '#test/helpers/native-runtime-fixture.js';
import {REPO_ROOT} from '#test/helpers/repo-root.js';

type Budget = {minimumFreeBytes: number; scratchBytes: number; allocationRequirementBytes: number};
type Admission = {state: string; minimumFreeBytes: number; reasons: string[]; pressure: string;
  allocations: {key: string; path: string; state: string; freeBytes: number | null}[]};
type AdmissionOptions = {platform?: string; scratch?: string; minimumFreeBytes?: number; statfs?: Function; spawn?: Function};
type EntryDeps = {admitHost: (stage: string) => unknown};
const admissionModule = '#scripts/lib/mac-author-admission.mjs';
const {boundedAuthorWorkload, boundedAuthorWorkloadFromArgv, readMacAuthorAdmission, guardedAuthorEntry} = await import(admissionModule) as {
  boundedAuthorWorkload: (scratchMiB: number) => Budget;
  boundedAuthorWorkloadFromArgv: (argv: string[]) => Budget | undefined;
  readMacAuthorAdmission: (root: string, options?: AdmissionOptions) => Admission;
  guardedAuthorEntry: (argv: string[], options: {root: string; readAdmission?: (root: string, options?: AdmissionOptions) => Admission;
    runAuthor: (argv: string[], deps: EntryDeps) => number; reportRefusal?: (root: string, admission: Admission) => void}) => number;
};
const authorModule = '#scripts/preflight-author.mjs';
const {boundedAuthorCaptureClosure, finishBoundedAuthorScratch, main, requireBoundedAuthorHost} = await import(authorModule) as {
  boundedAuthorCaptureClosure: (path: string) => {state: string};
  finishBoundedAuthorScratch: (scratch: {release: () => void}, closed: boolean) => {state: string};
  requireBoundedAuthorHost: (options?: {platform?: string; heapLimitBytes?: number}) => void;
  main: (argv: string[], options: {root: string; select: () => {fullRun: boolean; suites: string[]; reasons: string[]};
    admitHost: (stage: string) => unknown}) => number;
};

test('ordinary author admission prices declared bounded scratch and outputs below the full coverage reserve', () => {
  const budget = boundedAuthorWorkload(256);
  assert.equal(budget.allocationRequirementBytes, 4 * 1024 ** 3 + 2 * budget.scratchBytes + 32 * 8 * 1024 ** 2 + 16 * 1024 ** 2);
  assert.equal(budget.minimumFreeBytes, Math.max(10 * 1024 ** 3, budget.allocationRequirementBytes));
  const deps = {platform: 'darwin' as const, statfs: () => ({bavail: 12 * 1024 ** 3, bsize: 1}),
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

test('bounded ordinary author uses the governed ten-GiB floor through the actual entry', t => {
  const floor = 10 * 1024 ** 3, observations: Admission[] = [], phases: string[] = [];
  const readAdmission = (root: string, options?: AdmissionOptions) => {
    const result = readMacAuthorAdmission(root, {...options, platform: 'darwin',
      statfs: () => ({bavail: 12 * 1024 ** 3, bsize: 1}), spawn: () => ({status: 0, stdout: '1'})});
    observations.push(result); return result;
  };
  const args = ['--bounded-scratch-mib=64'];
  assert.equal(guardedAuthorEntry(args, {root: '/workspace', readAdmission, runAuthor: (seen, deps) => {
    assert.deepEqual(seen, args);
    for (const phase of ['census-precheck', 'static-preflight', 'affected-tests']) {deps.admitHost(phase); phases.push(phase);}
    return 19;
  }}), 19);
  assert.deepEqual(phases, ['census-precheck', 'static-preflight', 'affected-tests']);
  assert.equal(observations.length, 4);
  for (const value of observations) {
    assert.equal(value.minimumFreeBytes, floor);
    assert.deepEqual(value.allocations.map(row => row.path), ['/workspace', '/tmp']);
    assert.ok(value.allocations.every(row => row.state === 'observed' && row.freeBytes === 12 * 1024 ** 3));
  }
  assert.ok(readFileSync(join(REPO_ROOT, 'scripts/preflight-author.mjs'), 'utf8')
    .includes('process.exitCode = guardedAuthorEntry(argv, {root: REPO_ROOT,'), 'the shipped CLI must call this entry');
  // The actual native volume/ordinary phase integration is Mac-only; algorithm controls above run everywhere.
  if (process.platform !== 'darwin') return;
  const fixture = makeRuntimeFixture(); t.after(() => fixture.cleanup());
  const packages = Object.fromEntries(['tsx', 'typescript', '@commitlint/cli'].map(name =>
    [`node_modules/${name}`, {version: JSON.parse(readFileSync(join(fixture.dir, 'node_modules', name, 'package.json'), 'utf8')).version}]));
  writeFileSync(join(fixture.dir, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages}));
  fixture.git('add', 'package-lock.json'); fixture.git('commit', '-m', 'test: lock ten GiB entry fixture');
  const code = guardedAuthorEntry(args, {root: fixture.dir, readAdmission,
    runAuthor: (argv, deps) => main(argv, {root: fixture.dir, ...deps,
      select: () => ({fullRun: false, suites: ['test/a.test.ts', 'test/b.test.ts'], reasons: ['real governed entry fixture']})})});
  const receipt = JSON.parse(readFileSync(join(fixture.dir, 'coverage/preflight-author.json'), 'utf8'));
  assert.equal(code, 0, JSON.stringify(receipt)); assert.equal(receipt.verdict, 'passed');
  assert.equal(receipt.resourceBudget.minimumFreeBytes, floor);
  assert.ok(receipt.steps.some((row: {name: string; ok: boolean}) => row.name === 'affected-tests' && row.ok));
  assert.equal(receipt.resourceBudget.cleanup, 'closed-and-removed');
});

test('bounded ordinary author refuses below-floor and unknown allocation evidence', () => {
  const floor = 10 * 1024 ** 3;
  const cases: {path: string; stats: () => {bavail: number; bsize: number}}[] = [];
  for (const path of ['/workspace', '/tmp']) for (const stats of [
    () => ({bavail: floor - 1, bsize: 1}), () => ({bavail: NaN, bsize: 1}),
    () => ({bavail: -12 * 1024 ** 3, bsize: -1}), () => ({bavail: floor, bsize: 0}),
    () => ({bavail: 1.5, bsize: floor}), () => ({bavail: Number.MAX_SAFE_INTEGER, bsize: 4096}),
    () => {throw Object.assign(new Error('denied'), {code: 'EACCES'});}
  ]) cases.push({path, stats});
  for (const item of cases) {
    let started = 0; let refused: Admission | undefined;
    const code = guardedAuthorEntry(['--bounded-scratch-mib=256'], {root: '/workspace',
      readAdmission: (root, options) => readMacAuthorAdmission(root, {...options, platform: 'darwin',
        statfs: (path: string) => path === item.path ? item.stats() : {bavail: floor, bsize: 1},
        spawn: () => ({status: 0, stdout: '1'})}),
      runAuthor: () => {started++; return 0;}, reportRefusal: (_root, result) => {refused = result;}});
    assert.equal(code, 3); assert.equal(started, 0); assert.ok(refused);
    assert.equal(refused.allocations.length, 2);
    assert.ok(refused.reasons.some(reason => reason.startsWith(item.path === '/workspace' ? 'workspaceFreeBytes:' : 'scratchFreeBytes:')));
  }
  for (const result of [{status: 0, stdout: '2'}, {status: 0, stdout: '4'}, {status: 0, stdout: 'invalid'},
    {status: 1, stdout: '1'}, {status: null, stdout: '1', signal: 'SIGTERM'}, {status: 0, stdout: '1', error: new Error('probe')}]) {
    assert.equal(guardedAuthorEntry(['--bounded-scratch-mib=256'], {root: '/workspace',
      readAdmission: (root, options) => readMacAuthorAdmission(root, {...options, platform: 'darwin',
        statfs: () => ({bavail: floor, bsize: 1}), spawn: () => result}),
      runAuthor: () => {throw new Error('refused phase started');}, reportRefusal: () => {}}), 3);
  }
  for (const argv of [['--bounded-scratch-mib=0'], ['--bounded-scratch-mib=257'],
    ['--bounded-scratch-mib=64', '--bounded-scratch-mib=256']])
    assert.throws(() => guardedAuthorEntry(argv, {root: '/workspace',
      readAdmission: () => {throw new Error('invalid declaration reached filesystem');}, runAuthor: () => 0}), /16 through 256|only once/);
});

test('ten-GiB bounded author preserves unbounded coverage and validation compatibility', () => {
  const full = 20 * 1024 ** 3;
  for (const argv of [[], ['--', '--bounded-scratch-mib=256']]) {
    assert.equal(guardedAuthorEntry(argv, {root: '/workspace',
      readAdmission: (root, options) => readMacAuthorAdmission(root, {...options, platform: 'darwin',
        statfs: () => ({bavail: full - 1, bsize: 1}), spawn: () => ({status: 0, stdout: '1'})}),
      runAuthor: () => {throw new Error('unbounded author admitted below20GiB');}, reportRefusal: () => {}}), 3);
  }
  const raw = readFileSync(join(REPO_ROOT, 'src/lib/ci-parity.ts'), 'utf8');
  assert.ok(raw.includes('20 * 1024 ** 3'), 'independent full coverage reserve remains in its maintained implementation');
  const linux = readMacAuthorAdmission('/workspace', {platform: 'linux',
    statfs: () => {throw new Error('Mac allocation read on Linux');}, spawn: () => {throw new Error('Mac probe on Linux');}});
  assert.equal(linux.state, 'not-applicable');
  const caps = boundedAuthorWorkload(256) as Budget & {workers: number; heapMiB: number; semiSpaceMiB: number;
    stepRuntimeMs: number; stepOutputBytes: number; maximumPhases: number};
  assert.deepEqual([caps.workers, caps.heapMiB, caps.semiSpaceMiB, caps.stepRuntimeMs, caps.stepOutputBytes, caps.maximumPhases],
    [1, 1024, 16, 120000, 8 * 1024 ** 2, 32]);
});

test('the ten-GiB author floor has load-bearing entry and refusal controls', t => {
  const {dir} = ownedFixtureDir(t, 'ten-gib-author-controls');
  const source = readFileSync(join(REPO_ROOT, 'scripts/lib/mac-author-admission.mjs'), 'utf8');
  const floorLine = 'Math.max(MAC_BOUNDED_AUTHOR_MINIMUM_BYTES, allocationRequirementBytes)';
  const entryLine = 'const budget = boundedAuthorWorkloadFromArgv(argv);';
  assert.equal(source.split(floorLine).length, 2); assert.equal(source.split(entryLine).length, 2);
  for (const [name, bytes, status] of [['current', source, 0],
    ['removed-floor', source.replace(floorLine, 'allocationRequirementBytes'), 1],
    ['removed-entry', source.replace(entryLine, 'const budget = undefined;'), 1]] as const) {
    const path = join(dir, name + '.mjs'); writeFileSync(path, bytes);
    const code = 'import assert from "node:assert/strict";import {boundedAuthorWorkload,guardedAuthorEntry,readMacAuthorAdmission} from ' +
      JSON.stringify(pathToFileURL(path).href) + ';assert.equal(boundedAuthorWorkload(256).minimumFreeBytes,10737418240);' +
      'let started=0;const run=(free)=>guardedAuthorEntry(["--bounded-scratch-mib=256"],{root:"/w",' +
      'readAdmission:(root,options)=>readMacAuthorAdmission(root,{...options,platform:"darwin",statfs:()=>({bavail:free,bsize:1}),' +
      'spawn:()=>({status:0,stdout:"1"})}),runAuthor:()=>{started++;return 0},reportRefusal:()=>{}});' +
      'assert.equal(run(12*1024**3),0);assert.equal(started,1);assert.equal(run(10*1024**3-1),3);assert.equal(started,1);';
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code],
      {cwd: REPO_ROOT, env: process.env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 ** 2});
    assert.equal(child.status, status, name + ': ' + child.stderr);
  }
  // This invokes the real statfs and sysctl defaults; it starts no compiler/test child or author main.
  const observed = readMacAuthorAdmission(REPO_ROOT, {minimumFreeBytes: boundedAuthorWorkload(256).minimumFreeBytes});
  if (process.platform === 'darwin') {
    assert.equal(observed.allocations.length, 2);
    assert.ok(observed.allocations.every(row => row.state === 'observed' && Number.isSafeInteger(row.freeBytes)));
    assert.ok(['normal', 'warning', 'critical'].includes(observed.pressure));
  } else assert.equal(observed.state, 'not-applicable');
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

test('bounded author validates real V8 young-generation overhead with its 1-GiB old-space cap', () => {
  const code = 'import {requireBoundedAuthorHost} from "#scripts/preflight-author.mjs";' +
    'import {getHeapStatistics} from "node:v8";requireBoundedAuthorHost({platform:"darwin"});' +
    'console.log(getHeapStatistics().heap_size_limit);';
  const run = (semi: number) => spawnSync(process.execPath, ['--max-old-space-size=1024',
    `--max-semi-space-size=${semi}`, '--import', 'tsx', '--input-type=module', '-e', code],
  {cwd: REPO_ROOT, env: process.env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 ** 2});
  const bounded = run(16);
  assert.equal(bounded.status, 0, bounded.stderr);
  assert.ok(Number(bounded.stdout.trim()) <= 1088 * 1024 ** 2);
  const excessive = run(64);
  assert.equal(excessive.status, 1);
  assert.match(excessive.stderr, /actual V8 heap ceiling/);
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

test('the ordinary bounded author uses its real fixed volume and records natural native child closure',
  {skip: process.platform !== 'darwin' ? 'native hdiutil qualification requires Mac; no Linux volume claim' : false}, t => {
  const fixture = makeRuntimeFixture(); t.after(() => fixture.cleanup());
  const packages = Object.fromEntries(['tsx', 'typescript', '@commitlint/cli'].map(name =>
    [`node_modules/${name}`, {version: JSON.parse(readFileSync(join(fixture.dir, 'node_modules', name, 'package.json'), 'utf8')).version}]));
  writeFileSync(join(fixture.dir, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages}));
  const staticPath = join(fixture.dir, 'src/run-task.ts');
  writeFileSync(staticPath, 'import {getHeapStatistics} from "node:v8";\n' + readFileSync(staticPath, 'utf8') +
    'writeFileSync("coverage/fixture-heap-limit",String(getHeapStatistics().heap_size_limit));\n');
  fixture.git('add', 'package-lock.json', 'src/run-task.ts'); fixture.git('commit', '-m', 'test: lock bounded author fixture tools');
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
  assert.ok(Number(readFileSync(join(fixture.dir, 'coverage/fixture-heap-limit'), 'utf8')) <= 1088 * 1024 ** 2,
    'the real ordinary static child inherits the declared V8 generation bounds');
  assert.equal(existsSync(receipt.resourceBudget.scratch.dir), false);
});

test('a real failed ordinary bounded author keeps its failed verdict and closes only its own scratch',
  {skip: process.platform !== 'darwin' ? 'native hdiutil qualification requires Mac; no Linux volume claim' : false}, t => {
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

test('ordinary bounded author stops real oversized native output and preserves the failed phase',
  {skip: process.platform !== 'darwin' ? 'native hdiutil qualification requires Mac; no Linux volume claim' : false}, t => {
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
