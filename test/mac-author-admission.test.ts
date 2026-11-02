import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, readdirSync, statfsSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
type Admission = {state: string; minimumFreeBytes: number; workspaceFreeBytes: number | null;
  scratchFreeBytes: number | null; pressure: string; reasons: string[]};
type AdmissionOptions = {platform?: string; scratch?: string; statfs?: Function; spawn?: Function};
type AuthorEntryOptions = {root: string; readAdmission: () => {state: string};
  runAuthor: (argv: string[], deps: {admitHost: (stage: string) => unknown}) => number;
  reportRefusal?: () => void};
const admissionModule = '#scripts/lib/mac-author-admission.mjs';
const {guardedAuthorEntry, MAC_AUTHOR_FREE_RESERVE_BYTES, MacAuthorCapacityRefusal,
  macPressureState, readMacAuthorAdmission} = await import(admissionModule) as {
  MAC_AUTHOR_FREE_RESERVE_BYTES: number;
  macPressureState: (text: string) => string;
  readMacAuthorAdmission: (root: string, options?: AdmissionOptions) => Admission;
  MacAuthorCapacityRefusal: new (stage: string, admission: {state: string; pressure?: string}) => Error & {stage: string};
  guardedAuthorEntry: (argv: string[], options: AuthorEntryOptions) => number;
};

const ample = () => ({bavail: 30 * 1024 ** 3, bsize: 1});
const normal = () => ({status: 0, stdout: '1\n'});
test('Mac author admission requires BOTH volumes above the existing reserve and normal pressure', () => {
  const calls: string[] = [];
  const statfs = (path: string) => { calls.push(path); return ample(); };
  const observed = readMacAuthorAdmission('/workspace', {platform: 'darwin', scratch: '/scratch', statfs, spawn: normal});
  assert.equal(observed.state, 'admitted'); assert.deepEqual(calls, ['/workspace', '/scratch']);
  assert.equal(observed.minimumFreeBytes, 20 * 1024 ** 3);
  for (const low of ['/workspace', '/scratch']) {
    const refused = readMacAuthorAdmission('/workspace', {platform: 'darwin', scratch: '/scratch',
      statfs: (p: string) => ({bavail: MAC_AUTHOR_FREE_RESERVE_BYTES - (p === low ? 1 : 0), bsize: 1}), spawn: normal});
    assert.equal(refused.state, 'not-run');
    assert.equal(refused.reasons.length, 1);
  }
  assert.equal(readMacAuthorAdmission('/workspace', {platform: 'darwin', scratch: '/scratch',
    statfs: () => ({bavail: MAC_AUTHOR_FREE_RESERVE_BYTES, bsize: 1}), spawn: normal}).state, 'admitted');
});

test('Mac pressure uses the userspace dispatch flags, not the internal kernel enum', () => {
  assert.equal(macPressureState('1\n'), 'normal');
  assert.equal(macPressureState('2'), 'warning'); assert.equal(macPressureState('4'), 'critical');
  for (const text of ['', '0', '3', '1 2', '9', 'NaN']) assert.equal(macPressureState(text), 'unknown');
  for (const value of ['2', '4', '0', '3', 'bad']) {
    const r = readMacAuthorAdmission('/w', {platform: 'darwin', statfs: ample,
      spawn: () => ({status: 0, stdout: value})});
    assert.equal(r.state, 'not-run');
  }
});

test('Mac author admission retains UNKNOWN on missing, malformed and bounded probe failures', () => {
  for (const statfs of [() => { throw Object.assign(new Error('denied'), {code: 'EACCES'}); },
    () => ({bavail: -1, bsize: 4096}), () => ({bavail: Number.MAX_SAFE_INTEGER, bsize: 4096})]) {
    const r = readMacAuthorAdmission('/w', {platform: 'darwin', statfs, spawn: normal});
    assert.equal(r.state, 'not-run'); assert.equal(r.workspaceFreeBytes, null);
  }
  const outcomes = [{status: 1, stdout: '1'}, {status: null, signal: 'SIGTERM', stdout: '1'},
    {status: 0, stdout: '1', error: new Error('truncated')}, {status: 0, stdout: ''}];
  for (const result of outcomes) assert.equal(readMacAuthorAdmission('/w', {platform: 'darwin',
    statfs: ample, spawn: () => result}).state, 'not-run');
  let bounded = false;
  readMacAuthorAdmission('/w', {platform: 'darwin', statfs: ample,
    spawn: (file: string, args: string[], opts: {timeout: number; maxBuffer: number}) => {
      assert.equal(file, '/usr/sbin/sysctl'); assert.deepEqual(args, ['-n', 'kern.memorystatus_vm_pressure_level']);
      assert.equal(opts.timeout, 2000); assert.equal(opts.maxBuffer, 4096); bounded = true;
      throw new Error('deadline');
    }});
  assert.equal(bounded, true);
});

test('Mac capacity refusal starts NO author work and read-only help/dry-run do not require capacity', () => {
  let started = 0, refused = 0;
  const deps = {root: '/w', runAuthor: () => { started++; return 17; },
    readAdmission: () => ({state: 'not-run'}), reportRefusal: () => { refused++; }};
  assert.equal(guardedAuthorEntry([], deps), 3); assert.equal(started, 0); assert.equal(refused, 1);
  for (const arg of ['--help', '-h', '--dry-run']) assert.equal(guardedAuthorEntry([arg], deps), 17);
  assert.equal(started, 3);
  for (const state of ['admitted', 'not-applicable'])
    assert.equal(guardedAuthorEntry([], {...deps, readAdmission: () => ({state})}), 17);
  assert.equal(started, 5); assert.equal(refused, 1);
});

test('non-Mac author admission leaves existing Linux and hosted policies unchanged', () => {
  const never = () => { throw new Error('native Mac probe invoked on another platform'); };
  assert.deepEqual(readMacAuthorAdmission('/w', {platform: 'linux', statfs: never, spawn: never}),
    {state: 'not-applicable', platform: 'linux', reasons: []});
});

test('Mac admission is freshly checked after slot waiting and before a later heavy phase', () => {
  let reads = 0;
  assert.throws(() => guardedAuthorEntry([], {root: '/w',
    readAdmission: () => ++reads === 1 ? {state: 'admitted'} : {state: 'not-run', reasons: ['changed']},
    runAuthor: (_argv: string[], deps: {admitHost: (stage: string) => unknown}) => {
      deps.admitHost('static-preflight'); return 0;
    },
  }), (error: unknown) => error instanceof MacAuthorCapacityRefusal && error.stage === 'static-preflight');
  assert.equal(reads, 2, 'the CLI observation must not authorize work after a wait');
});

test('Mac author phase refusals save OVER-CAPACITY, start no refused phase, and release the slot', async (t) => {
  const {makeRuntimeFixture} = await import('#test/helpers/native-runtime-fixture.js');
  const authorModule = '#scripts/preflight-author.mjs';
  const {main} = await import(authorModule) as {
    main: (argv: string[], options: {root: string; select: () => {fullRun: boolean; suites: string[]; reasons: string[]};
      admitHost: (stage: string) => {stage: string; state: string}}) => number;
  };
  const {resolveTestSlotDir} = await import('#src/lib/test-slot.js');
  for (const refusedStage of ['static-preflight', 'affected-tests']) {
    const fixture = makeRuntimeFixture(); t.after(() => fixture.cleanup());
    // This tiny Git/Node fixture uses these three tools, not the application's
    // SDK/browser dependency graph. Lock their actual installed versions so an
    // unrelated application dependency update cannot prevent reaching the guard.
    const packages = Object.fromEntries(['tsx', 'typescript', '@commitlint/cli'].map(name =>
      [`node_modules/${name}`, {version: JSON.parse(readFileSync(join(fixture.dir, 'node_modules', name, 'package.json'), 'utf8')).version}]));
    writeFileSync(join(fixture.dir, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages}));
    fixture.git('add', 'package-lock.json'); fixture.git('commit', '-m', 'test: lock the native fixture tools');
    const status = main([], {root: fixture.dir,
      select: () => ({fullRun: false, suites: ['test/a.test.ts', 'test/b.test.ts'], reasons: ['physical fixture']}),
      admitHost: (stage: string) => {
        if (stage === refusedStage) throw new MacAuthorCapacityRefusal(stage, {state: 'not-run', pressure: 'warning'});
        return {stage, state: 'admitted'};
      }});
    const receipt = JSON.parse(readFileSync(join(fixture.dir, 'coverage/preflight-author.json'), 'utf8'));
    assert.equal(status, 3, JSON.stringify(receipt));
    assert.equal(receipt.verdict, 'over-capacity'); assert.equal(receipt.hostCapacity.at(-1).stage, refusedStage);
    assert.equal(receipt.steps.some((row: {name: string}) => row.name === 'affected-tests'), false);
    assert.equal(existsSync(join(fixture.dir, 'coverage/static-started')), refusedStage === 'affected-tests');
    assert.deepEqual(readdirSync(resolveTestSlotDir().dir).filter(name => /^slot-[0-9]+\.json$/.test(name)), []);
  }
});

test('Mac capacity default seam really reads the native volume and pressure without starting work', () => {
  const result = readMacAuthorAdmission(process.cwd());
  if (process.platform !== 'darwin') { assert.equal(result.state, 'not-applicable'); return; }
  const fs = statfsSync(process.cwd());
  assert.ok(typeof result.workspaceFreeBytes === 'number' && Number.isSafeInteger(result.workspaceFreeBytes));
  assert.ok(Math.abs(result.workspaceFreeBytes - fs.bavail * fs.bsize) < 1024 ** 3);
  const pressure = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], {encoding: 'utf8', timeout: 2000});
  assert.equal(pressure.status, 0); assert.notEqual(macPressureState(pressure.stdout), 'unknown');
  assert.ok(['normal', 'warning', 'critical'].includes(result.pressure), 'native readings are known, not assumed unchanged across two probes');
});

test('focused Mac admission accepts a costed warning only with quiet paging and measured headroom', async () => {
  const {focusedMacWorkload, judgeFocusedMacSamples} = await import(admissionModule);
  const workload = focusedMacWorkload({scratchBytes: 64 * 1024 ** 2, runtimeMs: 30_000, files: ['test/a.test.ts']});
  assert.equal(workload.workers, 1); assert.equal(workload.heapMiB, 512);
  const samples = [0, 5000, 10_000].map(at => ({at, pressure: 'warning', pageBytes: 16384,
    freePlusInactiveBytesApprox: 4 * 1024 ** 3, swapins: 100, swapouts: 200}));
  assert.equal(judgeFocusedMacSamples(workload, samples).state, 'admitted');
  for (const pressure of ['critical', 'unknown'])
    assert.equal(judgeFocusedMacSamples(workload, samples.map(s => ({...s, pressure}))).state, 'not-run');
  const replaceLast = (change: object) => [...samples.slice(0, -1), {...samples[2], ...change}];
  for (const change of [{swapouts: 201}, {swapins: 1000}, {swapins: 99}, {swapouts: 199},
    {freePlusInactiveBytesApprox: 3 * 1024 ** 3 - 1}, {pageBytes: 4096}, {at: 4999}, {at: 40_000},
    {swapins: NaN}, {pressure: 'unknown'}])
    assert.equal(judgeFocusedMacSamples(workload, replaceLast(change)).state, 'not-run', JSON.stringify(change));
  assert.equal(judgeFocusedMacSamples(workload, samples.slice(1)).state, 'not-run');
  assert.equal(judgeFocusedMacSamples(workload, [null, ...samples.slice(1)]).state, 'not-run');
  assert.equal(judgeFocusedMacSamples(null, samples).state, 'not-run');
  // Check every interval: a burst hidden by a quiet final interval must still refuse.
  assert.equal(judgeFocusedMacSamples(workload, samples.map((s, i) => ({...s, swapins: i ? 200 : 100}))).state, 'not-run');
});

test('focused warning eligibility cannot be used for full, oversized or multi-worker jobs', async () => {
  const {focusedMacWorkload, judgeFocusedMacSamples} = await import(admissionModule);
  const input = {scratchBytes: 64 * 1024 ** 2, runtimeMs: 30_000, files: ['test/a.test.ts']};
  for (const change of [{runtimeMs: 120_001}, {scratchBytes: 256 * 1024 ** 2 + 1},
    {files: []}, {files: Array(5).fill('test/a.test.ts')}, {runtimeMs: NaN}])
    assert.equal(focusedMacWorkload({...input, ...change}), null);
  const workload = focusedMacWorkload(input);
  assert.equal(judgeFocusedMacSamples({...workload, workers: 2}, []).state, 'not-run');
  assert.equal(judgeFocusedMacSamples({...workload, heapMiB: 513}, []).state, 'not-run');
  // The full gate's production seam remains normal-only even with a bounded disk reserve.
  assert.equal(readMacAuthorAdmission('/w', {platform: 'darwin', statfs: ample,
    spawn: () => ({status: 0, stdout: '2'})}).state, 'not-run');
});

test('focused Mac sampling parses actual page size and refuses absent or duplicate counters', async () => {
  const {parseMacVmSample} = await import(admissionModule);
  const text = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 5.\nPages inactive: 7.\nSwapins: 100.\nSwapouts: 200.\n';
  assert.deepEqual(parseMacVmSample(text), {pageBytes: 16384, freePlusInactiveBytesApprox: 12 * 16384, swapins: 100, swapouts: 200});
  for (const broken of [text.replace('Swapins: 100.\n', ''), text + 'Swapins: 1.\n',
    text.replace('100.', '-1.'), text.replace('16384', '0'), text.replace('200.', '9007199254740992.')])
    assert.throws(() => parseMacVmSample(broken));
});

test('focused Mac reader never rescues disk, unknown or critical refusals and rechecks after sampling', async () => {
  const {focusedMacWorkload, readMacFocusedAdmission} = await import(admissionModule);
  const workload = focusedMacWorkload({scratchBytes: 64 * 1024 ** 2, runtimeMs: 30_000, files: ['test/a.test.ts']});
  let time = 0, reads = 0, flag = '2';
  const deps = {platform: 'darwin', scratch: '/s', statfs: ample, workload,
    spawn: () => ({status: 0, stdout: flag}), now: () => time, wait: (ms: number) => {time += ms;},
    sample: () => {reads++; return {at: time, pressure: 'warning', pageBytes: 16384,
      freePlusInactiveBytesApprox: 4 * 1024 ** 3, swapins: 100, swapouts: 200};}};
  assert.equal(readMacFocusedAdmission('/w', deps).state, 'admitted'); assert.equal(reads, 3);
  for (const pressure of ['4', 'bad']) {
    reads = 0; flag = pressure;
    assert.equal(readMacFocusedAdmission('/w', deps).state, 'not-run'); assert.equal(reads, 0);
  }
  reads = 0; flag = '2';
  assert.equal(readMacFocusedAdmission('/w', {...deps, statfs: () => ({bavail: 1, bsize: 1})}).state, 'not-run');
  assert.equal(reads, 0);
  assert.equal(readMacFocusedAdmission('/w', {...deps, sample: () => {throw new Error('probe unavailable');}}).state, 'not-run');
  const moved = readMacFocusedAdmission('/w', {...deps, sample: () => {
    reads++; if (reads === 3) flag = '4';
    return {at: time, pressure: 'warning', pageBytes: 16384, freePlusInactiveBytesApprox: 4 * 1024 ** 3, swapins: 100, swapouts: 200};
  }});
  assert.equal(moved.state, 'not-run');
});

test('focused default Mac probe really reads native counters without allocating a workload', async () => {
  if (process.platform !== 'darwin') return;
  const {readMacFocusedSample} = await import(admissionModule);
  const sample = readMacFocusedSample();
  assert.ok([4096, 16384, 65536].includes(sample.pageBytes));
  assert.ok(Number.isSafeInteger(sample.swapins));
  assert.ok(Number.isSafeInteger(sample.swapouts));
  assert.ok(['normal', 'warning', 'critical'].includes(sample.pressure));
});

test('focused native probes are bounded and fail closed on spawn, timeout and malformed data', async () => {
  const {readMacFocusedSample} = await import(admissionModule);
  for (const response of [{status: 1, stdout: ''}, {status: 0, stdout: '', error: new Error('read failed')},
    {status: null, stdout: '', signal: 'SIGTERM'}, {status: 0, stdout: 'not vm_stat'}])
    assert.throws(() => readMacFocusedSample({spawn: (_file: string, _args: string[], options: {timeout: number; maxBuffer: number}) => {
      assert.equal(options.timeout, 2000); assert.equal(options.maxBuffer, 4096); return response;
    }}));
  const workload = {kind: 'explicit-scoped-tests-only', workers: 1, heapMiB: 512, memoryBudgetBytes: 1024 ** 3,
    scratchBytes: 64 * 1024 ** 2, runtimeMs: 30_000, files: ['test/a.test.ts']};
  const {readMacFocusedAdmission} = await import(admissionModule);
  const result = readMacFocusedAdmission('/w', {workload, platform: 'darwin', statfs: ample,
    spawn: () => ({status: 0, stdout: '2'}), wait: () => {throw new Error('sampling interrupted');},
    sample: () => ({at: 0, pressure: 'warning', pageBytes: 16384, freePlusInactiveBytesApprox: 4 * 1024 ** 3, swapins: 0, swapouts: 0})});
  assert.equal(result.state, 'not-run');
  assert.ok(result.reasons.some((reason: string) => reason.includes('sampling interrupted')));
});

test("W1-T10947: a genuine bounded profile requires the larger of 10 GiB and all declared allocations on each actual filesystem", async (t) => {
  const contextModule = '#scripts/lib/author-context-compatibility.mjs';
  const preflightModule = '#scripts/preflight-author.mjs';
  const {boundedAuthorRequirement, boundedAuthorProfileBinding, requireMacAuthorCapacity,
    MAC_AUTHOR_BOUNDED_MINIMUM_BYTES, BOUNDED_AUTHOR_PROFILE_FORMAT} = await import(admissionModule);
  const {observeAuthorContext} = await import(contextModule);
  const {readAuthorProfile} = await import(preflightModule);
  const {ownedFixtureDir} = await import('#test/helpers/owned-fixture-dir.js');
  const GiB = 1024 ** 3, MiB = 1024 ** 2;
  assert.equal(MAC_AUTHOR_BOUNDED_MINIMUM_BYTES, 10737418240);
  // Real directories, really observed: dev/ino/realpath come from this host's own filesystem.
  const {dir} = ownedFixtureDir(t, 'bounded-author-profile');
  mkdirSync(join(dir, 'workspace', 'coverage'), {recursive: true}); mkdirSync(join(dir, 'scratch'));
  const slot = {outcome: 'acquired', childEnvironment: {RMD_TEST_SLOT_PARENT: JSON.stringify({nonce: 'owner-1',
    pid: process.pid, start: 'fixture-start', path: join(dir, 'slot.json')})}};
  const context = observeAuthorContext({root: join(dir, 'workspace'), slot,
    git: (args: string[]) => args[0] === 'status' ? '' : args[1] === 'HEAD' ? 'a'.repeat(40) : 'b'.repeat(40),
    dependency: () => ({state: 'present', dependencyRoot: '/deps', dev: 1, ino: 2}),
    allocations: {workspace: join(dir, 'workspace'), diagnostics: join(dir, 'workspace', 'coverage'), scratch: join(dir, 'scratch')}});
  const devs = new Set(Object.values(context.allocations as Record<string, {dev?: number}>).map(row => row.dev));
  assert.equal(devs.size, 1, JSON.stringify(context.allocations));
  const budget = (n: number, rest = n) => ({allocationBytes: n, scratchBytes: rest, outputBytes: rest,
    nativeBytes: rest, runtimeBytes: rest, childClosureBytes: rest});
  const profile = (budgets: object, of = context) => ({format: BOUNDED_AUTHOR_PROFILE_FORMAT, bounded: true,
    binding: boundedAuthorProfileBinding(of), budgets});
  // A profile read through the CLI's own bounded reader is the profile written.
  const small = profile({workspace: budget(MiB), diagnostics: budget(MiB), scratch: budget(MiB)});
  writeFileSync(join(dir, 'profile.json'), JSON.stringify(small));
  assert.deepEqual(readAuthorProfile(dir, 'profile.json'), small);
  // Small declared allocations: the 10 GiB minimum is the larger, on the one real filesystem they share.
  const floor = boundedAuthorRequirement(small, {context, bound: context});
  assert.equal(floor.state, 'bounded', JSON.stringify(floor));
  assert.deepEqual(floor.filesystems.map((row: {key: string; declaredBytes: number; minimumFreeBytes: number}) =>
    [row.key, row.declaredBytes, row.minimumFreeBytes]), [['diagnostics+scratch+workspace', 18 * MiB, 10 * GiB]]);
  // Large declared allocations: every budget of every allocation on that filesystem is summed and wins.
  const large = profile({workspace: budget(GiB), diagnostics: budget(GiB), scratch: budget(GiB, 0)});
  assert.equal(boundedAuthorRequirement(large, {context, bound: context}).filesystems[0].minimumFreeBytes, 13 * GiB);
  // Two actual filesystems: each is priced by ITS OWN allocations and read independently.
  const split = {...context, allocations: {...context.allocations,
    scratch: {...context.allocations.scratch, dev: context.allocations.scratch.dev + 1}}};
  const diag = split.allocations.diagnostics.path, scratch = split.allocations.scratch.path;
  const workload = {selection: 'full-fallback', workers: 1, boundedProfile: profile(large.budgets, split), context: split, bound: split};
  const reader = (free: Record<string, number>, calls: string[] = [], pressure = '1') => (root: string, options: object) =>
    readMacAuthorAdmission(root, {...options, platform: 'darwin', spawn: () => ({status: 0, stdout: pressure}),
      statfs: (p: string) => { calls.push(p); if (!(p in free)) throw Object.assign(new Error('io'), {code: 'EIO'}); return {bavail: free[p], bsize: 1}; }} as AdmissionOptions);
  const calls: string[] = [];
  const admitted = requireMacAuthorCapacity('/w', 'affected-tests', reader({[diag]: 12 * GiB, [scratch]: 10 * GiB}, calls), workload);
  assert.equal(admitted.state, 'admitted', JSON.stringify(admitted));
  assert.deepEqual(calls, [diag, scratch], 'one independent read per actual filesystem');
  assert.equal(admitted.reserveBasis, 'bounded-profile'); assert.equal(admitted.minimumFreeBytes, 12 * GiB);
  assert.deepEqual(admitted.allocationFreeBytes, {'diagnostics+workspace': 12 * GiB, scratch: 10 * GiB});
  assert.deepEqual(admitted.boundedProfile.filesystems.map((row: {key: string; minimumFreeBytes: number}) =>
    [row.key, row.minimumFreeBytes]), [['diagnostics+workspace', 12 * GiB], ['scratch', 10 * GiB]]);
  // Without the profile the same host keeps the 20 GiB full-run reserve and is refused.
  assert.throws(() => requireMacAuthorCapacity('/w', 'affected-tests', (root: string, options: object) =>
    readMacAuthorAdmission(root, {...options, platform: 'darwin', spawn: normal, statfs: () => ({bavail: 12 * GiB, bsize: 1})} as AdmissionOptions),
  {selection: 'full-fallback', workers: 1}), MacAuthorCapacityRefusal);
  const refusal = (free: Record<string, number>, pressure = '1') => {
    try { requireMacAuthorCapacity('/w', 'affected-tests', reader(free, [], pressure), workload); }
    catch (error) { assert.ok(error instanceof MacAuthorCapacityRefusal); return (error as unknown as {admission: Admission}).admission.reasons; }
    assert.fail('admitted');
  };
  assert.deepEqual(refusal({[diag]: 12 * GiB - 1, [scratch]: 10 * GiB}), ['allocation:diagnostics+workspace:below-bounded-profile-reserve']);
  assert.deepEqual(refusal({[diag]: 12 * GiB, [scratch]: 10 * GiB - 1}), ['allocation:scratch:below-bounded-profile-reserve']);
  assert.deepEqual(refusal({[diag]: 12 * GiB}), ['allocation:scratch:unavailable:EIO']);
  // Memory pressure and UNKNOWN refusals are untouched by the bounded route.
  assert.deepEqual(refusal({[diag]: 12 * GiB, [scratch]: 10 * GiB}, '2'), ['pressure:warning']);
  assert.deepEqual(refusal({[diag]: 12 * GiB, [scratch]: 10 * GiB}, 'bad'), ['pressure:unknown']);
  // No allocation reserve below the approved 10 GiB minimum reaches the reader.
  assert.throws(() => readMacAuthorAdmission('/w', {platform: 'darwin', statfs: ample, spawn: normal,
    allocations: [{key: 'x', path: '/x', minimumFreeBytes: 10 * GiB - 1}]} as AdmissionOptions), /invalid bounded author allocation reserve/);
});
