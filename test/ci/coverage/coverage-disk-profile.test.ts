import assert from 'node:assert/strict';
import { appendFileSync, fstatSync, mkdirSync, readSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ownedFixtureDir } from '#test/helpers/owned-fixture-dir.js';
// @ts-expect-error Exercise the real plain-JavaScript coverage entry points.
import { coverageDiskAdmission, coverageDiskProfile } from '#scripts/lib/coverage-disk-profile.mjs';
// @ts-expect-error Exercise profile propagation at the real CLI boundary.
import { main } from '#scripts/coverage-batches.mjs';
// @ts-expect-error Exercise refusal at the real local CLI entry point.
import { main as localMain } from '#scripts/diff-coverage-local.mjs';

const floor = 20 * 1024 ** 3;
const profile = { minimumFreeBytes: floor, reservedBytes: 1024, estimatedPeakBytes: 2048 };

test('coverage disk profile preserves the existing floor and distinguishes unspecified peak from measured zero', async t => {
  const { dir } = ownedFixtureDir(t, 'coverage-disk-profile');
  const file = join(dir, 'profile.json'); writeFileSync(file, JSON.stringify({ ...profile, ignored: 'not forwarded' }));
  assert.deepEqual(coverageDiskProfile(file), { mode: 'profiled', profile, estimatedPeakBasis: 'declared-profile' });
  assert.deepEqual(coverageDiskProfile(), { mode: 'existing-floor-only', profile: {
    minimumFreeBytes: floor, reservedBytes: 0, estimatedPeakBytes: 0,
  }, estimatedPeakBasis: 'not-supplied' });
  let calls = 0;
  const status = await main(['--batch-size', '1', '--disk-profile', file, 'test/coverage-batches.test.ts'], {
    run: async (opts: Record<string, unknown>) => {
      calls++; assert.deepEqual(opts.diskProfile, profile); assert.equal(opts.diskProfileMode, 'profiled');
      assert.equal(opts.estimatedPeakBasis, 'declared-profile'); return { status: 75 };
    },
  });
  assert.equal(status, 75); assert.equal(calls, 1);
  await main(['--batch-size', '1', 'test/coverage-batches.test.ts'], { run: async (opts: Record<string, unknown>) => {
    calls++; assert.equal(opts.diskProfileMode, 'existing-floor-only'); assert.equal(opts.estimatedPeakBasis, 'not-supplied');
    return { status: 75 };
  } });
  assert.equal(calls, 2);
  const errors: string[] = [];
  assert.equal(localMain(['--disk-profile', file, 'test/coverage-batches.test.ts'], {
    error: (text: string) => errors.push(text), runInstrumentedTests: () => assert.fail('unbatched profile must refuse before tests'),
  }), 1);
  assert.match(errors.join('\n'), /requires --batch-size/);
});

test('coverage disk profiles refuse lower floors malformed fields and nonregular or oversized inputs', t => {
  const { dir } = ownedFixtureDir(t, 'coverage-disk-profile-invalid'), file = join(dir, 'profile');
  for (const value of [null, [], {}, { ...profile, minimumFreeBytes: floor - 1 }, { ...profile, reservedBytes: -1 },
    { ...profile, estimatedPeakBytes: 0.5 }, { ...profile, reservedBytes: Number.MAX_SAFE_INTEGER + 1 }]) {
    writeFileSync(file, JSON.stringify(value)); assert.throws(() => coverageDiskProfile(file), /existing coverage reserve/);
  }
  writeFileSync(file, '{'); assert.throws(() => coverageDiskProfile(file), SyntaxError);
  writeFileSync(file, ''); assert.throws(() => coverageDiskProfile(file), /bounded regular/);
  writeFileSync(file, Buffer.alloc(16385, ' ')); assert.throws(() => coverageDiskProfile(file), /bounded regular/);
  mkdirSync(join(dir, 'directory')); assert.throws(() => coverageDiskProfile(join(dir, 'directory')), /bounded regular/);
  symlinkSync(file, join(dir, 'link')); assert.throws(() => coverageDiskProfile(join(dir, 'link')));
  assert.throws(() => coverageDiskProfile(join(dir, 'missing')), { code: 'ENOENT' });
});

test('coverage disk profile reads are bounded identity pinned and close on incomplete or failed reads', t => {
  const { dir } = ownedFixtureDir(t, 'coverage-disk-profile-read'), file = join(dir, 'profile.json');
  const write = () => writeFileSync(file, JSON.stringify(profile)); write();
  let fd = -1;
  assert.throws(() => coverageDiskProfile(file, { read(opened: number) { fd = opened; return 0; } }), /incompletely/);
  assert.throws(() => fstatSync(fd), { code: 'EBADF' });
  assert.throws(() => coverageDiskProfile(file, { read(opened: number, bytes: Buffer, offset: number, length: number, position: number) {
    assert.ok(length <= 16385); const count = readSync(opened, bytes, offset, length, position);
    renameSync(file, file + '.old'); write(); return count;
  } }), /changed/);
  assert.throws(() => coverageDiskProfile(file, { read(opened: number, bytes: Buffer, offset: number, length: number, position: number) {
    const count = readSync(opened, bytes, offset, length, position); appendFileSync(file, ' '); return count;
  } }), /changed/);
  const failure = new Error('read refused');
  assert.throws(() => coverageDiskProfile(file, { read(opened: number) { fd = opened; throw failure; } }), failure);
  assert.throws(() => fstatSync(fd), { code: 'EBADF' });
});

test('coverage disk admission checks every allocation filesystem and refuses unknown or invalid capacity', () => {
  const calls: string[] = [];
  const statfs = (path: string) => { calls.push(path); return { bavail: floor + (path === '/scratch' ? 3071 : 3072), bsize: 1 }; };
  const refused = coverageDiskAdmission(['/workspace', '/scratch', '/workspace'], profile, { statfs });
  assert.equal(refused.state, 'not-run-disk-capacity'); assert.deepEqual(calls, ['/workspace', '/scratch']);
  assert.equal(refused.checks[0].state, 'admitted'); assert.equal(refused.checks[1].state, 'not-run-disk-capacity');
  assert.equal(coverageDiskAdmission(['/workspace'], profile, { statfs }).state, 'admitted');
  for (const bavail of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(coverageDiskAdmission(['/workspace'], profile, { statfs: () => ({ bavail, bsize: 1 }) }).state, 'unknown');
  const unknown = coverageDiskAdmission(['/workspace'], profile, { statfs: () => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); } });
  assert.equal(unknown.state, 'unknown'); assert.equal(unknown.checks[0].reason, 'EACCES');
  for (const bad of [null, {}, { ...profile, reservedBytes: -1 }, { ...profile, minimumFreeBytes: 0 }])
    assert.equal(coverageDiskAdmission(['/workspace'], bad, { statfs }).state, 'unknown');
  assert.equal(coverageDiskAdmission([], profile, { statfs }).state, 'unknown');
  assert.equal(coverageDiskAdmission([''], profile, { statfs }).state, 'unknown');
  assert.equal(coverageDiskAdmission(['/workspace'], { ...profile, reservedBytes: Number.MAX_SAFE_INTEGER }, { statfs }).state, 'not-run-disk-capacity');
});
