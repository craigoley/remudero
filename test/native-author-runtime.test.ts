import assert from 'node:assert/strict';
import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const runtime = await import(pathToFileURL(join(process.cwd(), 'scripts/lib/native-author-runtime.mjs')).href);
const manifest = { version: 1, thresholdMs: 10_000, files: { 'test/a.test.ts': 1000, 'test/b.test.ts': 3000 } };
const profile = { at: new Date().toISOString(), files: { 'test/a.test.ts': 1200, 'test/b.test.ts': 3500 } };

test('native runtime deadline fit prices unknown files positively and distinguishes the exact budget boundary', () => {
  const files = ['test/a.test.ts', 'test/b.test.ts', 'test/unknown.test.ts'];
  const options = { workers: 1, now: 1000, deadline: 1_000_000, staticReserveMs: 0 };
  const fit = runtime.runtimeDeadlineFit(files, manifest, profile, options);
  assert.equal(fit.fits, true); assert.ok(fit.unknownMs >= 3500);
  assert.equal(fit.unmeasuredLedgerFiles, 1); assert.equal(fit.estimatedFiles, 1);
  assert.equal(fit.measuredFiles, 2); assert.ok(fit.requiredMs > fit.predictedMs);
  assert.equal(runtime.runtimeDeadlineFit(files, manifest, profile, { ...options, deadline: options.now + fit.requiredMs }).fits, true);
  assert.equal(runtime.runtimeDeadlineFit(files, manifest, profile, { ...options, deadline: options.now + fit.requiredMs - 1 }).fits, false);
  const beforeStatic = runtime.runtimeDeadlineFit(files, manifest, profile, { ...options, staticReserveMs: 900_000 });
  assert.equal(beforeStatic.requiredMs - fit.requiredMs, 900_000);
  assert.ok(runtime.runtimeDeadlineFit(files, manifest, profile, { ...options, workers: 2 }).predictedMs < fit.predictedMs);
});

test('native runtime deadline fit refuses invalid pool bounds and an empty timing corpus', () => {
  for (const workers of [0, -1, 5, NaN, 1.5]) assert.throws(() => runtime.runtimeDeadlineFit(
    ['test/a.test.ts'], manifest, profile, { workers, deadline: 100_000, now: 0 }), /invalid/);
  assert.throws(() => runtime.runtimeDeadlineFit([], manifest, profile, { workers: 1, deadline: 100_000 }), /invalid/);
  assert.throws(() => runtime.runtimeDeadlineFit(['test/a.test.ts'], manifest, { files: {} }, { workers: 1, deadline: 100_000 }), /no native/);
});

test('native timing sample spans the ledger rather than choosing only its cheapest files', () => {
  const files = Array.from({ length: 100 }, (_, n) => `test/f${String(n).padStart(3, '0')}.test.ts`);
  const ledger = { files: Object.fromEntries(files.map((file, n) => [file, n * 100])) };
  const samples = runtime.runtimeSamples(files, ledger);
  assert.equal(samples.length, 32); assert.ok(samples.includes(files[99]!));
  assert.ok(samples.some((file: string) => ledger.files[file] > 5000));
  assert.deepEqual(runtime.runtimeSamples([], ledger), []);
  assert.throws(() => runtime.runtimeSamples(files, ledger, 0), /positive/);
});

test('native timing calibration binds inherited heap-only NODE_OPTIONS without changing author admission', async (t) => {
  const { makeRuntimeFixture } = await import('#test/helpers/native-runtime-fixture.js');
  const { calibrateAuthorRuntime } = await import('#scripts/calibrate-author-runtime.mjs');
  const { main } = await import('#scripts/preflight-author.mjs');
  const f = makeRuntimeFixture(); t.after(() => f.cleanup());
  const prior = process.env.NODE_OPTIONS;
  try {
    // Keep the scoped harness's old-space ceiling; reproduce the deployed semi-space setting.
    process.env.NODE_OPTIONS = '--max-old-space-size=512 --max-semi-space-size=16';
    let observed: { path: string; head: string } | undefined;
    assert.doesNotThrow(() => { observed = calibrateAuthorRuntime({ root: f.dir }); },
      'the real calibration must represent heap-only options rather than classify them as instrumentation');
    assert.ok(observed);
    const parsed = JSON.parse(readFileSync(observed.path, 'utf8'));
    assert.equal(parsed.format, 'rmd-native-author-runtime-v2');
    assert.deepEqual(parsed.bindings.memoryOptions, { maxOldSpaceSizeMiB: 512, maxSemiSpaceSizeMiB: 16 });
    assert.equal(parsed.bindings.instrumentation, 'none');
    const bindings = runtime.runtimeBindings(f.dir, observed.head);
    assert.equal(runtime.readRuntimeProfile(f.dir, observed.path, bindings).assurance, 'runtime-sample-only');
    const select = () => ({ fullRun: false, suites: ['test/a.test.ts', 'test/b.test.ts'], reasons: ['physical fixture'] });
    assert.equal(main(['--runtime-profile', observed.path, '--deadline', new Date(Date.now() + 60_000).toISOString()],
      { root: f.dir, select }), 1);
    const refused = JSON.parse(readFileSync(join(f.dir, 'coverage/preflight-author.json'), 'utf8'));
    assert.equal(refused.runtimeAdmission.fits, false);
    assert.equal(refused.runtimeAdmission.stage, 'before-static');
    assert.equal(readFileSync(observed.path, 'utf8'), JSON.stringify(parsed, null, 2) + '\n',
      'using a timing profile must not rewrite its observations');
  } finally {
    if (prior === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = prior;
  }
});

test('native timing profiles refuse changed memory settings and unmodelled NODE_OPTIONS', async (t) => {
  const { makeRuntimeFixture } = await import('#test/helpers/native-runtime-fixture.js');
  const { calibrateAuthorRuntime } = await import('#scripts/calibrate-author-runtime.mjs');
  const f = makeRuntimeFixture(); t.after(() => f.cleanup());
  const prior = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = '--max-old-space-size=512 --max-semi-space-size=16';
    let observed: { path: string; head: string } | undefined;
    assert.doesNotThrow(() => { observed = calibrateAuthorRuntime({ root: f.dir }); });
    assert.ok(observed);
    const options = (NODE_OPTIONS: string) => runtime.runtimeBindings(f.dir, observed!.head,
      { ...process.env, NODE_OPTIONS });
    const initial = options(process.env.NODE_OPTIONS);
    assert.deepEqual(options('  --max-semi-space-size=16   --max-old-space-size=512  '), initial,
      'an equivalent ordering is the same memory context');
    for (const value of ['--max-old-space-size=511 --max-semi-space-size=16',
      '--max-old-space-size=512 --max-semi-space-size=8', '', '--max-semi-space-size=16']) {
      assert.throws(() => runtime.readRuntimeProfile(f.dir, observed!.path, options(value)), /binding mismatch/);
    }
    for (const value of ['--experimental-test-coverage', '--require=./anything.cjs', '--inspect',
      '--max-old-space-size=512 --trace-gc', '--max-semi-space-size=16 --max-semi-space-size=16',
      '--max-semi-space-size=0', '--max-old-space-size=-1', '--max-old-space-size=1.5',
      '--max-old-space-size=9007199254740992', '--max-semi-space-size="16"', '--max-semi-space-size 16']) {
      assert.throws(() => options(value), /not modelled|invalid|unsupported|duplicate/,
        'unknown, ambiguous, malformed and instrumented options must retain their refusal: ' + value);
    }
    const original = readFileSync(observed.path, 'utf8'), parsed = JSON.parse(original);
    writeFileSync(observed.path, JSON.stringify({ ...parsed, format: 'rmd-native-author-runtime-v1' }));
    assert.throws(() => runtime.readRuntimeProfile(f.dir, observed!.path, initial), /binding mismatch/);
    writeFileSync(observed.path, original);
    assert.equal(runtime.readRuntimeProfile(f.dir, observed.path, initial).author, 'not-proven');
  } finally {
    if (prior === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = prior;
  }
});

test('native runtime profile rereads real closed evidence and rejects stale, corrupt and foreign bindings', async (t) => {
  const { makeRuntimeFixture } = await import('./helpers/native-runtime-fixture.js');
  const f = makeRuntimeFixture(); t.after(() => f.cleanup());
  const { calibrateAuthorRuntime } = await import(pathToFileURL(join(process.cwd(), 'scripts/calibrate-author-runtime.mjs')).href);
  const observed = calibrateAuthorRuntime({ root: f.dir });
  const bindings = runtime.runtimeBindings(f.dir, f.git('rev-parse', 'HEAD'));
  const original = readFileSync(observed.path, 'utf8'), parsed = JSON.parse(original);
  assert.equal(runtime.readRuntimeProfile(f.dir, observed.path, bindings).samples.length, 2);
  const rewrite = (value: unknown) => writeFileSync(observed.path, JSON.stringify(value));
  for (const change of [
    { format: 'foreign' }, { at: 'not-a-date' }, { at: new Date(Date.now() + 60_000).toISOString() },
    { at: new Date(Date.now() - runtime.RUNTIME_PROFILE_MAX_AGE_MS - 60_000).toISOString() },
    { concurrency: 0 }, { artifacts: [] }, { samples: [] }, { files: {} },
  ]) { rewrite({ ...parsed, ...change }); assert.throws(() => runtime.readRuntimeProfile(f.dir, observed.path, bindings)); }
  rewrite(parsed);
  const durations = parsed.artifacts.find((row: { name: string }) => row.name === 'durations');
  assert.equal(runtime.closedDurationEvidence(f.dir, durations.path, parsed.samples, bindings).state, 'complete');
  assert.throws(() => runtime.closedDurationEvidence(f.dir, durations.path, ['test/a.test.ts'], bindings), /incomplete physical/);
  const profileLink = join(f.dir, 'coverage', 'profile-link.json');
  symlinkSync(observed.path, profileLink);
  assert.throws(() => runtime.readRuntimeProfile(f.dir, 'coverage/profile-link.json', bindings));
  unlinkSync(profileLink);
  assert.throws(() => runtime.readRuntimeProfile(f.dir, join(f.dir, 'outside-profile.json'), bindings), /owned coverage/);
  const outsideArtifact = join(f.dir, 'outside.json'), redirect = join(f.dir, 'coverage', 'redirect');
  writeFileSync(outsideArtifact, '{}');
  symlinkSync(f.dir, redirect);
  assert.throws(() => runtime.closedDurationEvidence(f.dir, 'coverage/redirect/outside.json', parsed.samples, bindings), /owned coverage/);
  unlinkSync(redirect);
  const durationLink = join(f.dir, 'coverage', 'duration-link.json');
  symlinkSync(join(f.dir, durations.path), durationLink);
  assert.throws(() => runtime.closedDurationEvidence(f.dir, 'coverage/duration-link.json', parsed.samples, bindings));
  unlinkSync(durationLink);
  const oversized = join(f.dir, 'coverage', 'oversized.json');
  writeFileSync(oversized, Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.throws(() => runtime.closedDurationEvidence(f.dir, 'coverage/oversized.json', parsed.samples, bindings), /oversized/);
  const nativeRow = parsed.artifacts.find((row: { name: string }) => row.name === 'native');
  const nativePath = join(f.dir, nativeRow.path), nativeOriginal = readFileSync(nativePath, 'utf8');
  for (const change of [{ status: 1 }, { signal: 'SIGTERM' }, { error: { code: 'fixture-error' } },
    { outputComplete: false }, { observedBytes: 0 }, { storedBytes: 0 }]) {
    const text = JSON.stringify({ ...JSON.parse(nativeOriginal), ...change }); writeFileSync(nativePath, text);
    rewrite({ ...parsed, artifacts: parsed.artifacts.map((row: { name: string }) => row.name !== 'native' ? row :
      { ...row, bytes: Buffer.byteLength(text), sha256: runtime.digest(text) }) });
    assert.throws(() => runtime.readRuntimeProfile(f.dir, observed.path, bindings), /incomplete or unsuccessful/);
  }
  writeFileSync(nativePath, nativeOriginal); rewrite(parsed);
  assert.throws(() => runtime.readRuntimeProfile(f.dir, observed.path, { ...bindings, head: 'f'.repeat(40) }), /binding mismatch/);
  const stdout = parsed.artifacts.find((row: { name: string }) => row.name === 'stdout');
  writeFileSync(join(f.dir, stdout.path), 'truncated');
  assert.throws(() => runtime.readRuntimeProfile(f.dir, observed.path, bindings), /hash mismatch/);
  assert.throws(() => runtime.runtimeBindings(f.dir, 'bad'), /unresolved/);
  assert.throws(() => runtime.runtimeBindings(f.dir, bindings.head, { NODE_OPTIONS: '--experimental-test-coverage' }), /instrumentation/);
  // A second real fixture produces a failed native outcome; it never becomes pricing evidence.
  const broken = makeRuntimeFixture(true); t.after(() => broken.cleanup());
  assert.throws(() => calibrateAuthorRuntime({ root: broken.dir }), /failed or incomplete/);
});
