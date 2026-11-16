import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';

type Reserve = {bytes: number; basis: string; row: string | null; measuredPeakBytes: number | null};
type Admission = {state: string; minimumFreeBytes: number; reserveBasis?: string; reasons: string[]} & Record<string, unknown>;
type Workload = {selection?: string; workers?: number; overCapacitySubset?: boolean};
type ReadAdmission = (root: string, options?: object) => Admission;
const admissionModule = '#scripts/lib/mac-author-admission.mjs';
const authorModule = '#scripts/preflight-author.mjs';
const {guardedAuthorEntry, macAuthorReserveBytes, readMacAuthorAdmission, requireMacAuthorCapacity,
  MacAuthorCapacityRefusal, MAC_AUTHOR_FREE_RESERVE_BYTES, MAC_AUTHOR_OS_FLOOR_BYTES, MAC_AUTHOR_PEAK_SAFETY_FACTOR,
  MAC_AUTHOR_MEASURED_PEAK_BYTES} = await import(admissionModule) as {
  guardedAuthorEntry: (argv: string[], options: {root: string; readAdmission: ReadAdmission;
    runAuthor: () => number}) => number;
  macAuthorReserveBytes: (workload: {stage: string} & Workload) => Reserve;
  readMacAuthorAdmission: ReadAdmission;
  requireMacAuthorCapacity: (root: string, stage: string, readAdmission: ReadAdmission, workload?: object) => Admission;
  MacAuthorCapacityRefusal: new (stage: string, admission: object) => Error & {stage: string; admission: Admission};
  MAC_AUTHOR_FREE_RESERVE_BYTES: number;
  MAC_AUTHOR_OS_FLOOR_BYTES: number;
  MAC_AUTHOR_PEAK_SAFETY_FACTOR: number;
  MAC_AUTHOR_MEASURED_PEAK_BYTES: Record<string, number>;
};
const {main} = await import(authorModule) as {
  main: (argv: string[], options: {root: string; select: (changed: string[]) => object;
    admitHost: (stage: string, workload?: Workload) => Admission | undefined}) => number;
};

const GiB = 1024 ** 3, MiB = 1024 ** 2;
const SIZED = ['plan-only', 'affected-narrow', 'affected-floor'];
const priced = (peak: number) => MAC_AUTHOR_OS_FLOOR_BYTES + MAC_AUTHOR_PEAK_SAFETY_FACTOR * peak;
/** A darwin host with `free` bytes on both volumes and normal memory pressure. */
const darwinAt = (free: number): ReadAdmission => (root, options = {}) =>
  readMacAuthorAdmission(root, {...options, platform: 'darwin', scratch: '/scratch',
    statfs: () => ({bavail: free, bsize: 1}), spawn: () => ({status: 0, stdout: '1\n'})});

/** The operator Mac's CLI bump on 2026-11-15: a lock change is a full fallback, and the rest is modelled. */
function fullFallbackRun(t: TestContext, free: number) {
  return import('#test/helpers/native-runtime-fixture.js').then(({makeRuntimeFixture}) => {
    const fixture = makeRuntimeFixture(); t.after(() => fixture.cleanup());
    const packages = Object.fromEntries(['tsx', 'typescript', '@commitlint/cli'].map(name =>
      [`node_modules/${name}`, {version: JSON.parse(readFileSync(join(fixture.dir, 'node_modules', name, 'package.json'), 'utf8')).version}]));
    writeFileSync(join(fixture.dir, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages}));
    fixture.git('add', 'package-lock.json'); fixture.git('commit', '-m', 'test: lock the native fixture tools');
    const seen: Array<{stage: string; workload: Workload; admission?: Admission}> = [];
    const errors: string[] = [];
    t.mock.method(console, 'error', (...parts: unknown[]) => { errors.push(parts.map(String).join(' ')); });
    t.mock.method(console, 'log', () => {});
    const status = main([], {root: fixture.dir,
      select: (changed: string[]) => changed.includes('package-lock.json')
        ? {fullRun: true, suites: [], reasons: ['full run: package-lock.json is outside what the selector models'], recentOnly: {floor: []}}
        : {fullRun: false, suites: ['test/a.test.ts'], reasons: ['fixture'], recentOnly: {floor: []}},
      admitHost: (stage, workload = {}) => {
        const row: {stage: string; workload: Workload; admission?: Admission} = {stage, workload};
        seen.push(row);
        row.admission = requireMacAuthorCapacity(fixture.dir, stage, darwinAt(free), workload);
        return row.admission;
      }});
    t.mock.restoreAll();
    const receipt = JSON.parse(readFileSync(join(fixture.dir, 'coverage/preflight-author.json'), 'utf8'));
    return {status, receipt, seen, errors};
  });
}

test('W1-T12953 criterion 1: a full-fallback static stage is priced by the static stage\'s own measured row', async (t) => {
  const row = MAC_AUTHOR_MEASURED_PEAK_BYTES['full-fallback-static-preflight'];
  assert.ok(row >= 216 * MiB, 'the row covers the 215.0 MiB measured on 2026-11-15');
  for (const selection of [...SIZED, 'full-fallback']) {
    const reserve = macAuthorReserveBytes({stage: 'static-preflight', selection, workers: 1});
    assert.equal(reserve.basis, 'measured-static-preflight', selection);
    assert.ok(reserve.bytes < MAC_AUTHOR_FREE_RESERVE_BYTES, selection);
  }
  assert.deepEqual(macAuthorReserveBytes({stage: 'static-preflight', selection: 'full-fallback', workers: 1}),
    {bytes: priced(row), basis: 'measured-static-preflight', row: 'full-fallback-static-preflight', measuredPeakBytes: row});
  // The CLI bump's case through the production run: 18,398,715,904 bytes free, refused before this task.
  const {status, receipt, seen} = await fullFallbackRun(t, 18_398_715_904);
  assert.equal(receipt.selectedArm, 'full-fallback', JSON.stringify(receipt.error));
  assert.equal(status, 3, 'a full fallback is never green');
  const staticRow = seen.find(row => row.stage === 'static-preflight');
  assert.equal(staticRow?.workload.selection, 'full-fallback');
  assert.equal(staticRow?.admission?.state, 'admitted');
  assert.equal(staticRow?.admission?.minimumFreeBytes, priced(row));
  assert.equal(receipt.steps.find((step: {name: string}) => step.name === 'static-preflight')?.ok, true, 'the static stage ran');
});

test('W1-T12953 criterion 2: a full fallback cut to a subset is priced by the workers that subset runs', async (t) => {
  const perWorker = MAC_AUTHOR_MEASURED_PEAK_BYTES['over-capacity-subset-tests-per-worker'];
  assert.ok(perWorker >= 139 * MiB, 'the row covers the 138.6 MiB measured on one worker on 2026-11-15');
  for (const workers of [1, 2, 4])
    assert.deepEqual(macAuthorReserveBytes({stage: 'affected-tests', selection: 'full-fallback', workers, overCapacitySubset: true}),
      {bytes: priced(perWorker * workers), basis: 'measured-affected-tests', row: 'over-capacity-subset-tests-per-worker',
        measuredPeakBytes: perWorker * workers});
  const {receipt, seen} = await fullFallbackRun(t, 16 * GiB);
  assert.deepEqual(receipt.partial.ran, ['test/a.test.ts'], 'the subset ran');
  assert.equal(receipt.partial.leftToCi, 1, 'and the rest of the suite was left to CI');
  const tests = seen.find(row => row.stage === 'affected-tests');
  assert.equal(tests?.workload.selection, 'full-fallback');
  assert.equal(tests?.workload.overCapacitySubset, true, 'the run says the full fallback was cut');
  const workers = tests?.workload.workers ?? 0;
  assert.ok(workers >= 1);
  assert.equal(tests?.admission?.state, 'admitted');
  assert.equal(tests?.admission?.minimumFreeBytes, priced(perWorker * workers));
  assert.equal(receipt.steps.find((step: {name: string}) => step.name === 'affected-tests-subset')?.ok, true);
});

test('W1-T12953 criterion 3: a capacity refusal names its reserve, the measurement and the admitting free bytes', async (t) => {
  const row = MAC_AUTHOR_MEASURED_PEAK_BYTES['full-fallback-static-preflight'];
  const free = 10 * GiB;
  const {status, receipt, errors} = await fullFallbackRun(t, free);
  assert.equal(status, 3);
  const refusal = receipt.hostCapacity.at(-1);
  assert.equal(refusal.stage, 'static-preflight');
  assert.deepEqual(refusal.reserve, {basis: 'measured-static-preflight', row: 'full-fallback-static-preflight',
    measuredPeakBytes: row, admittingFreeBytes: priced(row)});
  assert.ok(errors.includes(`Reserve applied: measured-static-preflight; measured row full-fallback-static-preflight, peak ${row} bytes; ` +
    `the run is admitted with ${priced(row)} bytes free on each filesystem checked.`), errors.join('\n'));
  // An unmeasured stage names the full reserve and says no measurement prices it.
  assert.throws(() => requireMacAuthorCapacity('/w', 'affected-tests', darwinAt(free), {selection: 'full-fallback', workers: 1}),
    (error: unknown) => {
      assert.ok(error instanceof MacAuthorCapacityRefusal);
      assert.deepEqual(error.admission.reserve, {basis: 'existing-20GiB', row: null, measuredPeakBytes: null});
      return true;
    });
  // The entry refusal names its own row.
  const lines: string[] = [];
  t.mock.method(console, 'error', (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); });
  assert.equal(guardedAuthorEntry([], {root: '/w', readAdmission: darwinAt(GiB), runAuthor: () => 0}), 3);
  t.mock.restoreAll();
  const entry = macAuthorReserveBytes({stage: 'entry'});
  assert.ok(lines.includes(`Reserve applied: measured-entry; measured row entry, peak ${entry.measuredPeakBytes} bytes; ` +
    `the run is admitted with ${entry.bytes} bytes free on each filesystem checked.`), lines.join('\n'));
});

test('W1-T12953 criterion 4: an unmeasured stage or selection keeps 20 GiB and no reserve falls below its measured price', () => {
  const full = {bytes: MAC_AUTHOR_FREE_RESERVE_BYTES, basis: 'existing-20GiB', row: null, measuredPeakBytes: null};
  for (const workload of [
    {stage: 'affected-tests', selection: 'full-fallback', workers: 1},
    {stage: 'affected-tests', selection: 'full-fallback', workers: 1, overCapacitySubset: false},
    {stage: 'affected-tests', selection: 'over-capacity', workers: 1, overCapacitySubset: true},
    {stage: 'static-preflight', selection: 'over-capacity', workers: 1},
    {stage: 'static-preflight', selection: 'a-selection-nobody-measured', workers: 1},
    {stage: 'static-preflight'},
    {stage: 'a-phase-nobody-measured', selection: 'full-fallback', workers: 1},
    {stage: 'affected-tests', selection: 'full-fallback', workers: 0, overCapacitySubset: true},
  ]) assert.deepEqual(macAuthorReserveBytes(workload), full, JSON.stringify(workload));
  for (const selection of [...SIZED, 'full-fallback', 'over-capacity'])
    for (const stage of ['entry', 'static-preflight', 'affected-tests'])
      for (const workers of [1, 2, 3, 8, 64])
        for (const overCapacitySubset of [true, false]) {
          const reserve = macAuthorReserveBytes({stage, selection, workers, overCapacitySubset});
          if (reserve.row === null) { assert.deepEqual(reserve, full); continue; }
          assert.equal(reserve.bytes, priced(reserve.measuredPeakBytes ?? 0));
          assert.ok((reserve.measuredPeakBytes ?? 0) >= MAC_AUTHOR_MEASURED_PEAK_BYTES[reserve.row]);
          assert.ok(reserve.bytes > MAC_AUTHOR_OS_FLOOR_BYTES && reserve.bytes < MAC_AUTHOR_FREE_RESERVE_BYTES);
        }
  // The plan-only and affected reserves are unchanged: 10 GiB plus twice 256 MiB per stage or worker.
  assert.equal(macAuthorReserveBytes({stage: 'static-preflight', selection: 'plan-only', workers: 1}).bytes, 11_274_289_152);
  assert.equal(macAuthorReserveBytes({stage: 'affected-tests', selection: 'plan-only', workers: 1}).bytes, 11_274_289_152);
  for (const selection of ['affected-narrow', 'affected-floor']) {
    assert.equal(macAuthorReserveBytes({stage: 'static-preflight', selection, workers: 1}).bytes, 11_274_289_152);
    assert.equal(macAuthorReserveBytes({stage: 'affected-tests', selection, workers: 4}).bytes, 12_884_901_888);
    assert.deepEqual(macAuthorReserveBytes({stage: 'affected-tests', selection, workers: 4, overCapacitySubset: true}),
      macAuthorReserveBytes({stage: 'affected-tests', selection, workers: 4}), 'the flag never changes a measured arm');
  }
});
