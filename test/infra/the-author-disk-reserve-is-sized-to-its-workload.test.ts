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

test("W1-T10947: unbounded profiles, full coverage, missing allocation evidence and stale identity retain their existing refusals", async (t) => {
  const contextModule = '#scripts/lib/author-context-compatibility.mjs';
  const coverageModule = '#scripts/lib/coverage-disk-profile.mjs';
  const preflightModule = '#scripts/preflight-author.mjs';
  const {requireMacAuthorCapacity, boundedAuthorProfileBinding, BOUNDED_AUTHOR_PROFILE_FORMAT,
    MAC_AUTHOR_BOUNDED_MINIMUM_BYTES} = await import(admissionModule);
  const {AUTHOR_CONTEXT_FORMAT} = await import(contextModule);
  const {coverageDiskAdmission, coverageDiskProfile} = await import(coverageModule);
  const {readAuthorProfile} = await import(preflightModule);
  const {ownedFixtureDir} = await import('#test/helpers/owned-fixture-dir.js');
  const {mkdirSync, writeFileSync} = await import('node:fs');
  const {join} = await import('node:path');
  const {dir} = ownedFixtureDir(t, 'bounded-author-refusals');
  const allocation = (path: string, dev: number) => ({path, dev, ino: dev * 10, fsType: 1, blockSize: 4096, blocks: 1e6});
  const context = {format: AUTHOR_CONTEXT_FORMAT, source: {head: 'a'.repeat(40), tree: 'b'.repeat(40), clean: true},
    dependency: {state: 'present', dependencyRoot: '/deps', dev: 1, ino: 2},
    owner: {state: 'held', path: '/slot.json', pid: 7, processStart: 'start', ownerNonce: 'owner-1'},
    allocations: {diagnostics: allocation('/w/coverage', 1), scratch: allocation('/scratch', 2), workspace: allocation('/w', 1)}};
  const budget = {allocationBytes: GiB, scratchBytes: 0, outputBytes: 0, nativeBytes: 0, runtimeBytes: 0, childClosureBytes: 0};
  const genuine = {format: BOUNDED_AUTHOR_PROFILE_FORMAT, bounded: true, binding: boundedAuthorProfileBinding(context),
    budgets: {diagnostics: budget, scratch: budget, workspace: budget}};
  const run = (boundedProfile: unknown, ctx: unknown = context, bound: unknown = ctx) =>
    requireMacAuthorCapacity('/w', 'affected-tests', host(16 * GiB), {selection: 'full-fallback', workers: 1, boundedProfile, context: ctx, bound});
  // Positive control: the same 16 GiB host admits a genuine bounded profile at its 10 GiB minimum.
  const admitted = run(genuine);
  assert.equal(admitted.state, 'admitted'); assert.equal(admitted.minimumFreeBytes, MAC_AUTHOR_BOUNDED_MINIMUM_BYTES);
  const {budgets} = genuine, {childClosureBytes: _dropped, ...uncosted} = budget;
  const missing = join(dir, 'absent.json');
  const cases: Array<[string, unknown, unknown?, unknown?]> = [
    ['omitted', undefined],
    ['unknown-profile', {...genuine, format: 'rmd-bounded-author-profile-v0'}],
    ['unknown-profile:unreadable:ENOENT', readAuthorProfile(dir, missing)],
    ['unbounded-profile', {...genuine, bounded: false}],
    ['unbounded-profile', {...genuine, budgets: {}}],
    ['unbounded-profile:scratch', {...genuine, budgets: {...budgets, scratch: uncosted}}],
    ['unbounded-profile:scratch', {...genuine, budgets: {...budgets, scratch: {...budget, runtimeBytes: -1}}}],
    ['unbounded-profile:overflow:diagnostics+workspace', {...genuine, budgets: {...budgets,
      diagnostics: {...budget, allocationBytes: Number.MAX_SAFE_INTEGER}, workspace: {...budget, allocationBytes: Number.MAX_SAFE_INTEGER}}}],
    ['missing-allocation-evidence:no-context', genuine, null],
    ['missing-allocation-evidence:none-observed', genuine, {...context, allocations: {}}],
    ['missing-allocation-evidence:scratch', genuine, {...context, allocations: {...context.allocations,
      scratch: {state: 'unavailable', reason: 'ENOENT'}}}],
    ['missing-allocation-evidence:diagnostics:no-budget', {...genuine, budgets: {scratch: budget, workspace: budget}}],
    ['missing-allocation-evidence:extra:not-observed', {...genuine, budgets: {...budgets, extra: budget}}],
    ['stale-identity:source', {...genuine, binding: {...genuine.binding, head: 'c'.repeat(40)}}],
    ['stale-identity:source', {...genuine, binding: {...genuine.binding, tree: 'c'.repeat(40)}}],
    ['stale-identity:source', genuine, {...context, source: {...context.source, clean: false}}],
    ['stale-identity:dependency', genuine, {...context, dependency: {...context.dependency, ino: 3}}],
    ['stale-identity:owner', genuine, {...context, owner: null}],
    ['stale-identity:owner', genuine, context, {...context, owner: {...context.owner, ownerNonce: 'owner-0'}}],
    ['stale-identity:allocation:scratch', genuine, context, {...context, allocations: {...context.allocations,
      scratch: allocation('/scratch', 3)}}],
  ];
  for (const [reason, profile, ...rest] of cases) {
    assert.throws(() => run(profile, ...rest), (error: unknown) => {
      assert.ok(error instanceof MacAuthorCapacityRefusal, reason);
      const admission = (error as unknown as {admission: Admission & {boundedProfile: object}}).admission;
      assert.deepEqual(admission.boundedProfile, {state: 'not-applied', reason}, reason);
      assert.equal(admission.minimumFreeBytes, MAC_AUTHOR_FREE_RESERVE_BYTES, reason);
      assert.deepEqual(admission.reasons, ['workspaceFreeBytes:below-existing-20GiB-reserve',
        'scratchFreeBytes:below-existing-20GiB-reserve'], reason);
      return true;
    }, reason);
  }
  // Full coverage keeps its own 20 GiB floor: neither a 10 GiB coverage profile nor an author profile lowers it.
  assert.equal(coverageDiskProfile().profile.minimumFreeBytes, MAC_AUTHOR_FREE_RESERVE_BYTES);
  mkdirSync(join(dir, 'coverage'));
  for (const [name, body] of [['ten.json', {minimumFreeBytes: MAC_AUTHOR_BOUNDED_MINIMUM_BYTES, reservedBytes: 0, estimatedPeakBytes: 0}],
    ['author.json', genuine]] as const) {
    writeFileSync(join(dir, 'coverage', name), JSON.stringify(body));
    assert.throws(() => coverageDiskProfile(join(dir, 'coverage', name)), /existing coverage reserve/);
  }
  assert.equal(coverageDiskAdmission(['/w'], {minimumFreeBytes: MAC_AUTHOR_BOUNDED_MINIMUM_BYTES, reservedBytes: 0,
    estimatedPeakBytes: 0}, {statfs: () => ({bavail: 16 * GiB, bsize: 1})}).state, 'unknown');
});
