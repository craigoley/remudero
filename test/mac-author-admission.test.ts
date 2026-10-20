import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync, statfsSync} from 'node:fs';
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
    const status = main([], {root: fixture.dir,
      select: () => ({fullRun: false, suites: ['test/a.test.ts', 'test/b.test.ts'], reasons: ['physical fixture']}),
      admitHost: (stage: string) => {
        if (stage === refusedStage) throw new MacAuthorCapacityRefusal(stage, {state: 'not-run', pressure: 'warning'});
        return {stage, state: 'admitted'};
      }});
    assert.equal(status, 3);
    const receipt = JSON.parse(readFileSync(join(fixture.dir, 'coverage/preflight-author.json'), 'utf8'));
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
