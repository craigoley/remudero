import assert from 'node:assert/strict';
import {test} from 'node:test';

type Reserve = {bytes: number; basis: string};
type Admission = {state: string; minimumFreeBytes: number; reserveBasis?: string; reasons: string[]};
type Workload = {selection?: string; workers?: number};
const admissionModule = '#scripts/lib/mac-author-admission.mjs';
const {guardedAuthorEntry, macAuthorReserveBytes, readMacAuthorAdmission, MacAuthorCapacityRefusal,
  MAC_AUTHOR_FREE_RESERVE_BYTES, MAC_AUTHOR_OS_FLOOR_BYTES} = await import(admissionModule) as {
  guardedAuthorEntry: (argv: string[], options: {root: string; readAdmission: (root: string, options?: object) => Admission;
    runAuthor: (argv: string[], deps: {admitHost: (stage: string, workload?: Workload) => Admission}) => number;
    reportRefusal?: () => void}) => number;
  macAuthorReserveBytes: (workload: {stage: string} & Workload) => Reserve;
  readMacAuthorAdmission: (root: string, options?: object) => Admission;
  MacAuthorCapacityRefusal: new (stage: string, admission: object) => Error & {stage: string};
  MAC_AUTHOR_FREE_RESERVE_BYTES: number;
  MAC_AUTHOR_OS_FLOOR_BYTES: number;
};

const GiB = 1024 ** 3;
const normal = () => ({status: 0, stdout: '1\n'});
/** A darwin host with `free` bytes on both volumes and normal memory pressure. */
const host = (free: number) => (root: string, options: object = {}) =>
  readMacAuthorAdmission(root, {...options, platform: 'darwin', scratch: '/scratch',
    statfs: () => ({bavail: free, bsize: 1}), spawn: normal});
const quiet = () => {};

// The Mac mini on 2026-10-26: one changed plan shard, 16 GB free, refused NOT_RUN on the 20 GiB reserve.
test("W1-T10765: a plan-only selection is admitted below 20 GiB free when its measured peak fits", () => {
  const seen: Admission[] = [];
  const status = guardedAuthorEntry([], {root: '/w', readAdmission: host(16 * GiB), reportRefusal: quiet,
    runAuthor: (_argv, {admitHost}) => {
      seen.push(admitHost('static-preflight', {selection: 'plan-only', workers: 1}));
      seen.push(admitHost('affected-tests', {selection: 'plan-only', workers: 1}));
      return 0;
    }});
  assert.equal(status, 0, 'the entry check admitted the run');
  assert.deepEqual(seen.map(a => a.state), ['admitted', 'admitted']);
  for (const a of seen) {
    assert.ok(a.minimumFreeBytes < MAC_AUTHOR_FREE_RESERVE_BYTES, `sized below the full reserve: ${a.minimumFreeBytes}`);
    assert.ok(a.minimumFreeBytes > MAC_AUTHOR_OS_FLOOR_BYTES, 'and always above the OS floor');
    assert.match(a.reserveBasis ?? '', /^measured-/);
  }
  // A sized reserve still refuses a disk that cannot hold it, and says which reserve it applied.
  assert.throws(() => guardedAuthorEntry([], {root: '/w', readAdmission: host(16 * GiB), reportRefusal: quiet,
    runAuthor: (_argv, {admitHost}) => { admitHost('affected-tests', {selection: 'plan-only', workers: 64}); return 0; }}),
  (error: unknown) => error instanceof MacAuthorCapacityRefusal && error.stage === 'affected-tests');
  const tight = host(MAC_AUTHOR_OS_FLOOR_BYTES)('/w', {minimumFreeBytes: macAuthorReserveBytes({stage: 'static-preflight',
    selection: 'plan-only'}).bytes, reserveBasis: 'measured-static-preflight'});
  assert.equal(tight.state, 'not-run');
  assert.deepEqual(tight.reasons, ['workspaceFreeBytes:below-measured-static-preflight-reserve',
    'scratchFreeBytes:below-measured-static-preflight-reserve']);
});

test("W1-T10765: a full or unmeasured selection still requires 20 GiB", () => {
  for (const workload of [{selection: 'full-fallback', workers: 1}, {selection: 'over-capacity', workers: 1},
    {selection: 'a-selection-nobody-measured', workers: 1}, {}, undefined]) {
    for (const stage of ['static-preflight', 'affected-tests']) {
      assert.deepEqual(macAuthorReserveBytes({stage, ...workload}), {bytes: MAC_AUTHOR_FREE_RESERVE_BYTES, basis: 'existing-20GiB'},
        `${stage} ${JSON.stringify(workload)}`);
      assert.throws(() => guardedAuthorEntry([], {root: '/w', readAdmission: host(16 * GiB), reportRefusal: quiet,
        runAuthor: (_argv, {admitHost}) => { admitHost(stage, workload); return 0; }}),
      (error: unknown) => error instanceof MacAuthorCapacityRefusal && error.stage === stage);
    }
  }
  assert.equal(macAuthorReserveBytes({stage: 'a-phase-nobody-measured', selection: 'plan-only', workers: 1}).bytes,
    MAC_AUTHOR_FREE_RESERVE_BYTES);
  // No measured workload, however wide, is ever asked for more than the full-run reserve.
  assert.equal(macAuthorReserveBytes({stage: 'affected-tests', selection: 'affected-floor', workers: 1_000}).bytes,
    MAC_AUTHOR_FREE_RESERVE_BYTES);
  let ran = false;
  guardedAuthorEntry([], {root: '/w', readAdmission: host(MAC_AUTHOR_FREE_RESERVE_BYTES), reportRefusal: quiet,
    runAuthor: (_argv, {admitHost}) => { admitHost('static-preflight', {selection: 'full-fallback'}); ran = true; return 0; }});
  assert.equal(ran, true, 'exactly the full reserve still admits a full run');
});
