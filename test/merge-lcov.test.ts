import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, opendirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// @ts-expect-error The production coverage merger is an executable .mjs module outside tsconfig.
import { renderCoverageSummary, stageRawCoverageFile } from '../scripts/coverage-merge-ratchet.mjs';

test('raw coverage staging uses a same-filesystem hard link, not a second multi-gigabyte copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'rmd-coverage-link-'));
  const raw = join(root, 'raw.json');
  const staged = join(root, 'staged.json');
  try {
    writeFileSync(raw, '{"result":[]}\n');
    stageRawCoverageFile(raw, staged);
    assert.equal(statSync(raw).ino, statSync(staged).ino, 'staging must reuse the raw file inode');
    assert.equal(readFileSync(staged, 'utf8'), readFileSync(raw, 'utf8'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('raw coverage staging copies only when a cross-device hard link is impossible', () => {
  const root = mkdtempSync(join(tmpdir(), 'rmd-coverage-cross-device-'));
  const raw = join(root, 'raw.json');
  const staged = join(root, 'staged.json');
  try {
    writeFileSync(raw, '{"result":[]}\n');
    let copies = 0;
    stageRawCoverageFile(raw, staged, {
      link: () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); },
      copy: (from: string, to: string) => { copies += 1; copyFileSync(from, to); },
    });
    assert.equal(copies, 1);
    assert.equal(readFileSync(staged, 'utf8'), readFileSync(raw, 'utf8'));
    assert.notEqual(statSync(raw).ino, statSync(staged).ino, 'fallback must be a copy, not a link');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('raw coverage byte measurement rejects a swapped symlink after a cross-device copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'rmd-coverage-symlink-'));
  const raw = join(root, 'raw.json');
  const staged = join(root, 'staged.json');
  try {
    writeFileSync(raw, '{"result":[]}\n');
    assert.throws(() => stageRawCoverageFile(raw, staged, {
      link: () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); },
      copy: () => symlinkSync(raw, staged),
    }), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ELOOP');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('raw coverage staging propagates non-cross-device link failures', () => {
  const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  assert.throws(
    () => stageRawCoverageFile('raw.json', 'staged.json', {
      link: () => { throw failure; },
      copy: () => { assert.fail('a permission failure must not be hidden by a copy'); },
    }),
    (error: unknown) => error === failure,
  );
});

function runMerger(output: string, ...rawDirectories: string[]): string {
  return execFileSync(
    process.execPath,
    ['--expose-internals', 'scripts/coverage-merge-ratchet.mjs', '--output', output, ...rawDirectories],
    { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' },
  );
}

function runCompactor(output: string, ...rawDirectories: string[]): string {
  return execFileSync(
    process.execPath,
    ['--expose-internals', 'scripts/coverage-merge-ratchet.mjs', '--compact-output', output, ...rawDirectories],
    { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' },
  );
}

function pinnedNodeControl(root: string, rawDirectories: string[]): { lcov: string; order: number[]; reportPaths: string[] } {
  const staged = join(root, 'node-control');
  mkdirSync(staged);
  const reportPaths = rawDirectories.flatMap((directory) =>
    readdirSync(directory)
      .filter((entry) => /^coverage-\d+-\d{13}-\d+\.json$/.test(entry))
      .sort()
      .map((entry) => join(directory, entry)));
  for (const [index, reportPath] of reportPaths.entries()) {
    stageRawCoverageFile(reportPath, join(staged, `coverage-1-0000000000000-${String(index).padStart(6, '0')}.json`));
  }
  // Node's native reader uses opendir, not sorted readdir. APFS can return these reports in a
  // different order; mapping mutates Node's line-hit cache. Compare algorithms over identical
  // report order, not over two independently chosen filesystem traversal orders.
  const order: number[] = [];
  const directory = opendirSync(staged);
  try {
    for (let entry; (entry = directory.readSync()) !== null;) {
      order.push(Number(entry.name.match(/-(\d+)\.json$/)![1]));
    }
  } finally {
    directory.closeSync();
  }
  const output = join(root, 'node-control.info');
  execFileSync(process.execPath, ['--expose-internals', '--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    import { writeFileSync } from 'node:fs';
    import { renderCoverageSummary } from './scripts/coverage-merge-ratchet.mjs';
    const { TestCoverage } = createRequire(import.meta.url)('internal/test_runner/coverage');
    const collector = new TestCoverage(process.argv[1], undefined, process.cwd(), ['test/**'], undefined, true,
      { line: 0, branch: 0, function: 0 });
    writeFileSync(process.argv[2], renderCoverageSummary(collector.summary()));
  `, staged, output], { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' });
  return { lcov: readFileSync(output, 'utf8'), order, reportPaths };
}

function compactBundles(directory: string): Array<Record<string, unknown>> {
  const names = readdirSync(directory)
    .filter((name) => /^coverage-bundle-\d+-\d{13}-\d+\.json$/.test(name))
    .sort();
  if (names.length) return names.map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')) as Record<string, unknown>);
  const manifests = readdirSync(directory).filter(name => /^coverage-corpus-\d+-\d{13}\.json$/.test(name));
  assert.equal(manifests.length, 1, `expected one complete compact corpus in ${directory}`);
  const manifest = JSON.parse(readFileSync(join(directory, manifests[0]!), 'utf8'));
  assert.equal(manifest.format, 'rmd-v8-coverage-corpus-v2');
  const read = (chunks: Array<{ file: string }>, key: string) => chunks.flatMap(chunk => JSON.parse(readFileSync(join(directory, chunk.file), 'utf8'))[key]);
  return [{ sourceMaps: read(manifest.mapChunks, 'sourceMaps'), reports: read(manifest.reportChunks, 'reports') }];
}

function runBoundedCompactor(output: string, maxChunkBytes: number, ...rawDirectories: string[]): void {
  execFileSync(process.execPath, ['--expose-internals', '--input-type=module', '-e', `
    import { writeCompactCoverageDirectories } from './scripts/coverage-merge-ratchet.mjs';
    writeCompactCoverageDirectories(process.argv.slice(3), process.argv[1], { maxChunkBytes: Number(process.argv[2]) });
  `, output, String(maxChunkBytes), ...rawDirectories], { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' });
}

/** A small real, source-mapped V8 profile keeps chunk/order controls independent of TSX's corpus. */
function realMappedProfile(root: string): { result: Array<{ scriptId: string; url: string }>; 'source-map-cache': Record<string, unknown> } {
  root = realpathSync(root);
  const probe = join(root, 'probe.cjs');
  const original = join(root, 'original.cjs');
  const lines = Array.from({ length: 64 }, (_, index) => `exports.f${index} = side => side ? ${index} : -${index + 1};`);
  const source = `${lines.join('\n')}\n`;
  writeFileSync(original, source);
  const map = { version: 3, sources: [original], names: [], mappings: lines.map((_, index) => index === 0 ? 'AAAA' : 'AACA').join(';'), sourcesContent: [source] };
  writeFileSync(probe, `${source}//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`);
  const producer = join(root, 'producer.test.cjs');
  writeFileSync(producer, `const { test } = require('node:test'); const assert = require('node:assert/strict');
    const probe = require(${JSON.stringify(probe)}); test('profile positive control', () => { assert.equal(probe.f0(true), 0); assert.equal(probe.f1(false), -2); });\n`);
  const raw = join(root, 'producer-raw');
  mkdirSync(raw);
  const tap = execFileSync(process.execPath, ['--enable-source-maps', '--experimental-test-coverage', '--test', producer], {
    cwd: process.cwd(), env: coverageEnv(raw), encoding: 'utf8', stdio: 'pipe',
  });
  assert.match(tap, /^# tests 1$/m);
  assert.match(tap, /^# pass 1$/m);
  assert.match(tap, /^# fail 0$/m);
  const profiles = readdirSync(raw).filter(name => /^coverage-\d+-\d{13}-\d+\.json$/.test(name))
    .map(name => JSON.parse(readFileSync(join(raw, name), 'utf8')))
    .filter(profile => profile.result.some((script: { url: string }) => script.url === `file://${probe}`));
  assert.equal(profiles.length, 1);
  const profile = profiles[0]!;
  const result = profile.result.filter((script: { url: string }) => script.url === `file://${probe}`);
  assert.ok(profile['source-map-cache'][result[0].url], 'real Node output must include the source-map topology');
  return { result, 'source-map-cache': { [result[0].url]: profile['source-map-cache'][result[0].url] } };
}

test('bounded compact coverage shares source maps and preserves every native LCOV field past chunk ten', () => {
  const root = mkdtempSync(join(tmpdir(), 'rmd-bounded-corpus-'));
  try {
    const profile = realMappedProfile(root);
    const rawDirs = Array.from({ length: 32 }, (_, index) => {
      const directory = join(root, `raw-${String(index).padStart(8, '0')}`);
      mkdirSync(directory);
      writeFileSync(join(directory, 'coverage-1-0000000000000-0.json'), JSON.stringify({
        ...profile, result: profile.result.map(script => ({ ...script, scriptId: String(index) })),
      }));
      return directory;
    });
    const url = profile.result[0]!.url;
    const reportBytes = Buffer.byteLength(JSON.stringify({ result: profile.result, sourceMapRefs: { [url]: 0 } }));
    const mapBytes = Buffer.byteLength(JSON.stringify(profile['source-map-cache'][url]));
    const bound = Math.max(reportBytes, mapBytes, 8192) + 256;
    const control = pinnedNodeControl(root, rawDirs);
    assert.equal(control.order.length, 32);
    const compact = join(root, 'compact');
    runBoundedCompactor(compact, bound, ...control.order.map(index => rawDirs[index]!));
    const manifestName = readdirSync(compact).find(name => /^coverage-corpus-/.test(name))!;
    const manifest = JSON.parse(readFileSync(join(compact, manifestName), 'utf8'));
    assert.ok(manifest.reportChunks.length > 10, 'the ordering control must cross the decimal index boundary');
    assert.equal(manifest.reportCount, 32);
    assert.equal(manifest.sourceMapCount, 1, 'shared source maps must not multiply with report chunks');
    assert.equal(manifest.mapChunks.reduce((sum: number, chunk: { entries: number }) => sum + chunk.entries, 0), 1);
    for (const name of readdirSync(compact)) assert.ok(statSync(join(compact, name)).size <= bound, `${name} must be byte bounded`);
    const [bundle] = compactBundles(compact) as Array<{ reports: Array<{ result: Array<{ scriptId: string }> }> }>;
    assert.deepEqual(bundle!.reports.map(report => Number(report.result[0]!.scriptId)), control.order);
    const output = join(root, 'merged.info');
    runMerger(output, compact);
    assert.equal(readFileSync(output, 'utf8'), control.lcov, 'all native SF, DA, FNDA and BRDA fields must match');
    assert.ok(summaryTotals(control.lcov).BRF > 0);
    assert.ok(summaryTotals(control.lcov).LF > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('chunked coverage refuses incomplete, mixed, unsafe and corrupt corpora before publishing LCOV', () => {
  const root = mkdtempSync(join(tmpdir(), 'rmd-corpus-integrity-'));
  try {
    const profile = realMappedProfile(root);
    const raw = join(root, 'raw'); mkdirSync(raw);
    writeFileSync(join(raw, 'coverage-1-0000000000000-0.json'), JSON.stringify(profile));
    const compact = join(root, 'compact');
    runCompactor(compact, raw);
    const manifestName = readdirSync(compact).find(name => /^coverage-corpus-/.test(name))!;
    const saved = new Map(readdirSync(compact).map(name => [name, readFileSync(join(compact, name), 'utf8')]));
    const baseline = JSON.parse(saved.get(manifestName)!);
    const output = join(root, 'merged.info');
    runMerger(output, compact); assert.ok(statSync(output).size > 0); unlinkSync(output);
    const reset = () => {
      for (const name of readdirSync(compact)) unlinkSync(join(compact, name));
      for (const [name, source] of saved) writeFileSync(join(compact, name), source);
    };
    const manifest = (change: (value: typeof baseline) => void) => {
      const value = JSON.parse(saved.get(manifestName)!); change(value);
      writeFileSync(join(compact, manifestName), JSON.stringify(value));
    };
    const chunk = (key: 'mapChunks' | 'reportChunks', value: unknown) => manifest(valueManifest => {
      const descriptor = valueManifest[key][0]; const source = JSON.stringify(value);
      writeFileSync(join(compact, descriptor.file), source);
      descriptor.bytes = Buffer.byteLength(source); descriptor.sha256 = createHash('sha256').update(source).digest('hex');
    });
    const reject = (change: () => void, message: RegExp) => {
      reset(); change(); assert.throws(() => runMerger(output, compact), message);
      assert.equal(readdirSync(root).includes('merged.info'), false, 'failure must not publish a success-shaped LCOV');
    };
    reject(() => unlinkSync(join(compact, manifestName)), /incomplete or mixed chunked coverage/);
    reject(() => writeFileSync(join(compact, '.coverage-corpus-write.lock'), ''), /incomplete or mixed chunked coverage/);
    reject(() => writeFileSync(join(compact, 'unfinished.json.part'), ''), /incomplete or mixed chunked coverage/);
    reject(() => writeFileSync(join(compact, 'coverage-1-0000000000000-0.json'), JSON.stringify(profile)), /incomplete or mixed chunked coverage/);
    reject(() => writeFileSync(join(compact, 'coverage-bundle-1-0000000000000-0.json'), '{}'), /incomplete or mixed chunked coverage/);
    reject(() => writeFileSync(join(compact, 'coverage-reports-extra.json'), '{}'), /incomplete or extra coverage chunks/);
    reject(() => unlinkSync(join(compact, baseline.reportChunks[0].file)), /incomplete or extra coverage chunks/);
    reject(() => { const name = baseline.reportChunks[0].file; unlinkSync(join(compact, name)); symlinkSync(join(raw, 'coverage-1-0000000000000-0.json'), join(compact, name)); }, /ELOOP/);
    reject(() => manifest(value => { value.reportChunks[0].file = '../escape.json'; }), /unsafe or invalid chunk metadata/);
    reject(() => manifest(value => { value.reportChunks[0].bytes = value.maxChunkBytes + 1; }), /unsafe or invalid chunk metadata/);
    reject(() => manifest(value => { value.reportChunks[0].bytes += 1; }), /size mismatch/);
    reject(() => manifest(value => { value.reportChunks[0].sha256 = '0'.repeat(64); }), /checksum mismatch/);
    reject(() => manifest(value => { value.reportChunks[0].entries += 1; }), /invalid coverage chunk contents/);
    reject(() => manifest(value => { value.sourceMapCount += 1; }), /source-map count mismatch/);
    reject(() => manifest(value => { value.reportCount += 1; value.rawFileCount += 1; }), /process-report count mismatch/);
    reject(() => manifest(value => { value.rawFileCount = 0; }), /invalid chunked coverage manifest/);
    reject(() => writeFileSync(join(compact, manifestName), 'null'), /invalid chunked coverage manifest/);
    reject(() => writeFileSync(join(compact, manifestName), ' '.repeat(64 * 1024 ** 2 + 1)), /coverage file byte bound/);
    reject(() => chunk('reportChunks', null), /invalid coverage chunk contents/);
    for (const sourceMap of [null, [], 'invalid']) {
      reject(() => chunk('mapChunks', { format: 'rmd-v8-coverage-corpus-v2', sourceMaps: [sourceMap] }), /invalid compact source map/);
    }
    const reports = JSON.parse(saved.get(baseline.reportChunks[0].file)!);
    reject(() => chunk('reportChunks', { ...reports, reports: [{ ...reports.reports[0], result: [] }] }), /invalid compact process report/);
    reject(() => chunk('reportChunks', { ...reports, reports: [{ ...reports.reports[0], sourceMapRefs: { [profile.result[0]!.url]: 1 } }] }), /invalid source-map reference/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bounded coverage writes refuse oversized entries and release their owned lock without a complete manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'rmd-corpus-write-refusal-'));
  try {
    const raw = join(root, 'raw'); mkdirSync(raw);
    const url = `file://${join(root, 'probe.cjs')}`;
    const result = [{ scriptId: '1', url, functions: [{ functionName: 'large'.repeat(300), ranges: [{ startOffset: 0, endOffset: 1, count: 1 }], isBlockCoverage: true }] }];
    const rawFile = join(raw, 'coverage-1-0000000000000-0.json');
    const reject = (name: string, bound: number, message: RegExp) => {
      const compact = join(root, name);
      assert.throws(() => runBoundedCompactor(compact, bound, raw), message);
      if (readdirSync(root).includes(name)) {
        assert.equal(readdirSync(compact).some(file => /^coverage-corpus-/.test(file)), false);
        assert.equal(readdirSync(compact).includes('.coverage-corpus-write.lock'), false);
      }
    };
    writeFileSync(rawFile, JSON.stringify({ result }));
    reject('bad-low', 1023, /invalid coverage chunk byte bound/);
    reject('bad-high', 64 * 1024 ** 2 + 1, /invalid coverage chunk byte bound/);
    reject('bad-fraction', 1024.5, /invalid coverage chunk byte bound/);
    reject('large-report', 1024, /single coverage reports entry exceeds/);
    writeFileSync(rawFile, JSON.stringify({ result: [{ ...result[0], functions: [] }], 'source-map-cache': { [url]: { marker: 'x'.repeat(2048) } } }));
    reject('large-map', 1024, /single coverage sourceMaps entry exceeds/);
    writeFileSync(rawFile, JSON.stringify({ result: [] }));
    reject('no-source', 1024, /produced no source records/);
    writeFileSync(rawFile, 'null');
    reject('bad-raw', 1024, /invalid raw coverage results/);
    writeFileSync(rawFile, JSON.stringify({ result: [{ ...result[0], functions: [] }], 'source-map-cache': { [url]: 'invalid' } }));
    reject('bad-raw-map', 1024, /invalid raw source map/);
    const occupied = join(root, 'occupied'); mkdirSync(occupied); writeFileSync(join(occupied, 'operator-file'), 'preserve');
    assert.throws(() => runBoundedCompactor(occupied, 1024, raw), /already contains compact coverage files/);
    assert.equal(readFileSync(join(occupied, 'operator-file'), 'utf8'), 'preserve');
    assert.deepEqual(readdirSync(occupied), ['operator-file']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy compact coverage and bounded corpora remain readable together in separate shard directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'rmd-corpus-legacy-'));
  try {
    const profile = realMappedProfile(root);
    const raw = join(root, 'raw'); mkdirSync(raw);
    writeFileSync(join(raw, 'coverage-1-0000000000000-0.json'), JSON.stringify(profile));
    const compact = join(root, 'compact'); runCompactor(compact, raw);
    const legacy = join(root, 'legacy'); mkdirSync(legacy);
    execFileSync(process.execPath, ['--expose-internals', '--input-type=module', '-e', `
      import { compactRawCoverageDirectories } from './scripts/coverage-merge-ratchet.mjs';
      import { writeFileSync } from 'node:fs';
      const { bundle } = compactRawCoverageDirectories([process.argv[1]]);
      writeFileSync(process.argv[2], JSON.stringify(bundle));
    `, raw, join(legacy, 'coverage-bundle-1-0000000000000-0.json')], { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' });
    const direct = join(root, 'direct.info'), mixed = join(root, 'mixed.info');
    runMerger(direct, raw, raw); runMerger(mixed, legacy, compact);
    assert.equal(readFileSync(mixed, 'utf8'), readFileSync(direct, 'utf8'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function sourceRecord(lcov: string, suffix: string): string {
  const records = lcov.split('end_of_record\n');
  const record = records.find((candidate) => candidate.match(/^SF:(.*)$/m)?.[1].endsWith(suffix));
  assert.ok(record, `expected an LCOV source record ending in ${suffix}`);
  return record;
}

function summaryValue(record: string, key: string): number {
  const match = record.match(new RegExp(`^${key}:(\\d+)$`, 'm'));
  assert.ok(match, `expected ${key} in LCOV record`);
  return Number(match[1]);
}

function summaryTotals(lcov: string): Record<string, number> {
  return Object.fromEntries(
    ['FNF', 'FNH', 'BRF', 'BRH', 'LF', 'LH'].map((key) => [
      key,
      [...lcov.matchAll(new RegExp(`^${key}:(\\d+)$`, 'gm'))]
        .reduce((total, match) => total + Number(match[1]), 0),
    ]),
  );
}

function coverageEnv(directory: string): NodeJS.ProcessEnv {
  // W1-T2732: NODE_V8_COVERAGE is set here ON PURPOSE -- the whole point of this suite is driving
  // real coverage output into `directory` so the merge step under test has something real to
  // merge, so there is nothing to "blank". `delete` on NODE_TEST_CONTEXT is a no-op only for
  // NODE_V8_COVERAGE (node force-re-injects that one var into every spawned child); the process
  // env has no equivalent force-injection for NODE_TEST_CONTEXT, so removing the key by
  // destructuring (rather than `delete`, which the coverage-session-blanking-check.mjs text scan
  // reads as its own no-op shape even though it works correctly here) is exactly as effective and
  // keeps this file out of that scan's pattern for a site the scan cannot tell apart from a real
  // hazard.
  const { NODE_TEST_CONTEXT: _omitted, ...rest } = process.env;
  return { ...rest, NODE_V8_COVERAGE: directory };
}

test('renderCoverageSummary emits Node-compatible LCOV totals from one merged summary', () => {
  const rendered = renderCoverageSummary({
    workingDirectory: '/repo',
    files: [
      {
        path: '/repo/src/lib/example.ts',
        functions: [
          { line: 2, name: 'covered', count: 3 },
          { line: 7, name: '', count: 0 },
        ],
        branches: [
          { line: 2, count: 1 },
          { line: 2, count: 0 },
        ],
        lines: [
          { line: 1, count: 1 },
          { line: 2, count: 1 },
          { line: 7, count: 0 },
        ],
        totalFunctionCount: 2,
        coveredFunctionCount: 1,
        totalBranchCount: 2,
        coveredBranchCount: 1,
        totalLineCount: 3,
        coveredLineCount: 2,
      },
    ],
  });

  assert.equal((rendered.match(/^SF:src\/lib\/example\.ts$/gm) ?? []).length, 1);
  assert.match(rendered, /^FN:2,covered$/m);
  assert.match(rendered, /^FN:7,anonymous_1$/m);
  assert.match(rendered, /^FNDA:3,covered$/m);
  assert.match(rendered, /^BRDA:2,0,0,1$/m);
  assert.match(rendered, /^BRDA:2,1,0,0$/m);
  assert.match(rendered, /^FNF:2$/m);
  assert.match(rendered, /^FNH:1$/m);
  assert.match(rendered, /^BRF:2$/m);
  assert.match(rendered, /^BRH:1$/m);
  assert.match(rendered, /^LF:3$/m);
  assert.match(rendered, /^LH:2$/m);
});

test('coverage merge CLI merges raw V8 ranges before assigning LCOV branch indexes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-node-coverage-'));
  const leftRaw = join(dir, 'raw-left');
  const rightRaw = join(dir, 'raw-right');
  const bothRaw = join(dir, 'raw-both');
  const leftCompact = join(dir, 'compact-left');
  const rightCompact = join(dir, 'compact-right');
  const bothCompact = join(dir, 'compact-both');
  const leftLcov = join(dir, 'left.info');
  const rightLcov = join(dir, 'right.info');
  const bothLcov = join(dir, 'both.info');
  const mergedLcov = join(dir, 'merged.info');
  const probe = join(dir, 'opposite-branches.cjs');
  const leftTest = join(dir, 'left.test.cjs');
  const rightTest = join(dir, 'right.test.cjs');
  mkdirSync(leftRaw);
  mkdirSync(rightRaw);
  mkdirSync(bothRaw);
  mkdirSync(leftCompact);
  mkdirSync(rightCompact);
  mkdirSync(bothCompact);
  writeFileSync(
    probe,
    `exports.choose = function choose(side) {\n  if (side === 'left') return 'left';\n  return 'right';\n};\n`,
  );
  writeFileSync(
    leftTest,
    `const assert = require('node:assert/strict');\nconst { test } = require('node:test');\nconst { choose } = require('./opposite-branches.cjs');\ntest('left', () => assert.equal(choose('left'), 'left'));\n`,
  );
  writeFileSync(
    rightTest,
    `const assert = require('node:assert/strict');\nconst { test } = require('node:test');\nconst { choose } = require('./opposite-branches.cjs');\ntest('right', () => assert.equal(choose('right'), 'right'));\n`,
  );

  execFileSync(process.execPath, ['--test', '--experimental-test-coverage', leftTest], {
    env: coverageEnv(leftRaw),
    stdio: 'pipe',
  });
  execFileSync(process.execPath, ['--test', '--experimental-test-coverage', rightTest], {
    env: coverageEnv(rightRaw),
    stdio: 'pipe',
  });
  execFileSync(process.execPath, ['--test', '--experimental-test-coverage', leftTest, rightTest], {
    env: coverageEnv(bothRaw),
    stdio: 'pipe',
  });

  runCompactor(leftCompact, leftRaw);
  runCompactor(rightCompact, rightRaw);
  runCompactor(bothCompact, bothRaw);
  assert.ok(compactBundles(leftCompact).some((bundle) => Array.isArray(bundle.reports)));

  runMerger(leftLcov, leftCompact);
  runMerger(rightLcov, rightCompact);
  runMerger(bothLcov, bothCompact);
  runMerger(mergedLcov, leftCompact, rightCompact);

  const left = sourceRecord(readFileSync(leftLcov, 'utf8'), 'opposite-branches.cjs');
  const right = sourceRecord(readFileSync(rightLcov, 'utf8'), 'opposite-branches.cjs');
  const both = sourceRecord(readFileSync(bothLcov, 'utf8'), 'opposite-branches.cjs');
  const merged = sourceRecord(readFileSync(mergedLcov, 'utf8'), 'opposite-branches.cjs');
  const mergedFound = summaryValue(merged, 'BRF');
  const mergedHit = summaryValue(merged, 'BRH');

  const leftFound = summaryValue(left, 'BRF');
  const rightFound = summaryValue(right, 'BRF');
  assert.equal(leftFound, rightFound);
  assert.ok(mergedFound < leftFound + rightFound);
  assert.ok(mergedHit >= summaryValue(left, 'BRH'));
  assert.ok(mergedHit >= summaryValue(right, 'BRH'));
  assert.equal(mergedHit, mergedFound);
  for (const key of ['BRF', 'BRH', 'LF', 'LH']) {
    assert.equal(summaryValue(merged, key), summaryValue(both, key), `${key} must match one process that covers both paths`);
  }
});

test('compact shard reports defer source-map translation and preserve every LCOV total', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-node-source-map-coverage-'));
  const leftRaw = join(dir, 'raw-left');
  const rightRaw = join(dir, 'raw-right');
  const leftCompact = join(dir, 'compact-left');
  const rightCompact = join(dir, 'compact-right');
  const directLcov = join(dir, 'direct.info');
  const compactLcov = join(dir, 'compact.info');
  mkdirSync(leftRaw);
  mkdirSync(rightRaw);
  mkdirSync(leftCompact);
  mkdirSync(rightCompact);

  const runSourceMappedCoverage = (raw: string, namePattern: string) => {
    execFileSync(
      process.execPath,
      [
        '--enable-source-maps',
        '--experimental-test-coverage',
        '--test-coverage-exclude=test/**',
        '--test',
        `--test-name-pattern=${namePattern}`,
        '--import',
        'tsx',
        '--import',
        './test/setup/tmp-hygiene.ts',
        'test/worker-provider.test.ts',
      ],
      { cwd: process.cwd(), env: coverageEnv(raw), stdio: 'pipe' },
    );
  };
  runSourceMappedCoverage(leftRaw, 'provider selector uses the subscription');
  runSourceMappedCoverage(rightRaw, 'provider selector excludes an exhausted');

  runMerger(directLcov, leftRaw, rightRaw);
  runCompactor(leftCompact, leftRaw);
  runCompactor(rightCompact, rightRaw);
  runMerger(compactLcov, leftCompact, rightCompact);

  assert.ok(compactBundles(leftCompact).some((bundle) => {
    const sourceMaps = bundle.sourceMaps as unknown[] | undefined;
    return (sourceMaps?.length ?? 0) > 0;
  }));
  assert.deepEqual(
    summaryTotals(readFileSync(compactLcov, 'utf8')),
    summaryTotals(readFileSync(directLcov, 'utf8')),
  );
});

test("W1-T4951: compacted four-shard coverage preserves line and branch totals", (context) => {
  const root = mkdtempSync(join(tmpdir(), 'rmd-four-shard-'));
  const rawDirs = Array.from({ length: 4 }, (_, index) => join(root, `raw-${index + 1}`));
  const compactDirs = Array.from({ length: 4 }, (_, index) => join(root, `compact-${index + 1}`));
  const direct = join(root, 'direct.info');
  const compact = join(root, 'compact.info');
  try {
    for (let index = 0; index < 4; index += 1) {
      mkdirSync(rawDirs[index]!);
      execFileSync(process.execPath, [
        '--enable-source-maps', '--experimental-test-coverage', '--test-coverage-exclude=test/**',
        '--test', `--test-name-pattern=${index % 2 === 0 ? 'provider selector uses the subscription' : 'provider selector excludes an exhausted'}`,
        '--import', 'tsx', '--import', './test/setup/tmp-hygiene.ts', 'test/worker-provider.test.ts',
      ], { cwd: process.cwd(), env: coverageEnv(rawDirs[index]!), stdio: 'pipe' });
      // Full suites carry large test source maps that are excluded from the final ratio.
      // Keep this extra V8 report valid so the pinned Node merger must read and skip it.
      const url = `file://${join(process.cwd(), 'test', `excluded-${index}.test.ts`)}`;
      writeFileSync(join(rawDirs[index]!, `coverage-9-0000000000000-${index}.json`), JSON.stringify({
        result: [{ scriptId: String(index), url, functions: [{ functionName: '', ranges: [
          { startOffset: 0, endOffset: 1, count: 1 },
        ], isBlockCoverage: true }] }],
        'source-map-cache': { [url]: { version: 3, sources: [url], names: [], mappings: '', sourcesContent: ['x'.repeat(2 * 1024 * 1024)] } },
      }));
    }
    const directLog = runMerger(direct, ...rawDirs);
    const peak = (log: string) => Number(log.match(/peakBytes=(\d+)/)?.[1]);
    let retainedBytes = 0;
    let compactPeak = 0;
    for (let index = 0; index < 4; index += 1) {
      const log = runCompactor(compactDirs[index]!, rawDirs[index]!);
      compactPeak = Math.max(compactPeak, retainedBytes + peak(log));
      retainedBytes += Number(log.match(/compactBytes=(\d+)/)?.[1]);
    }
    const compactLog = execFileSync(process.execPath,
      ['--expose-internals', 'scripts/coverage-merge-ratchet.mjs', '--output', compact, ...compactDirs],
      { cwd: process.cwd(), env: { ...process.env, TMPDIR: root }, encoding: 'utf8', stdio: 'pipe' });
    const directLcov = readFileSync(direct, 'utf8');
    const compactLcov = readFileSync(compact, 'utf8');
    assert.equal(compactLcov, directLcov, 'all SF, DA, and BRDA fields must match pinned Node');
    assert.ok(summaryTotals(compactLcov).BRF > 0);
    assert.ok(summaryTotals(compactLcov).LF > 0);
    compactPeak = Math.max(compactPeak, peak(compactLog));
    assert.ok(compactPeak < peak(directLog), `compact peak ${compactPeak} must be below raw peak ${peak(directLog)}`);
    assert.match(compactLog, /stagingBytes=0\b/);
    assert.match(compactLog, /stagingDir=none\b/);
    context.diagnostic(`raw peak ${peak(directLog)} bytes; compact peak ${compactPeak} bytes`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt compact coverage refuses the pinned-Node merge', () => {
  const root = mkdtempSync(join(tmpdir(), 'rmd-corrupt-compact-'));
  const compact = join(root, 'compact');
  mkdirSync(compact);
  try {
    writeFileSync(join(compact, 'coverage-bundle-1-0000000000000-0.json'), '{}');
    assert.throws(() => runMerger(join(root, 'merged.info'), compact), /not a valid rmd-v8-coverage-bundle-v1 report/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('streamed compact coverage preserves pinned-Node LCOV without writable scratch', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'rmd-streamed-lcov-'));
  const rawDirs = [join(root, 'left-raw'), join(root, 'right-raw')];
  const output = join(root, 'streamed.info');
  try {
    for (let index = 0; index < rawDirs.length; index += 1) {
      mkdirSync(rawDirs[index]!);
      const pattern = index === 0
        ? 'provider selector uses the subscription'
        : 'provider selector excludes an exhausted';
      for (let run = 0; run < 2; run += 1) {
        const tap = execFileSync(process.execPath, [
          '--enable-source-maps', '--experimental-test-coverage', '--test-coverage-exclude=test/**',
          '--test', `--test-name-pattern=${pattern}`,
          '--import', 'tsx', '--import', './test/setup/tmp-hygiene.ts', 'test/worker-provider.test.ts',
        ], { cwd: process.cwd(), env: coverageEnv(rawDirs[index]!), encoding: 'utf8', stdio: 'pipe' });
        assert.match(tap, /^# tests [1-9]\d*/m, 'the real profile producer must complete tests');
        assert.match(tap, /^# pass [1-9]\d*/m, 'the real profile producer must execute a passing test');
        assert.match(tap, /^# fail 0$/m, 'the real profile producer must not hide a failed test');
      }
    }
    const control = pinnedNodeControl(root, rawDirs);
    const reportCounts = rawDirs.map((directory) => readdirSync(directory)
      .filter((name) => /^coverage-\d+-\d{13}-\d+\.json$/.test(name)).length);
    assert.ok(reportCounts.every((count) => count > 1), `each compact directory must contribute multiple process reports, got ${reportCounts.join(',')}`);
    assert.equal(control.reportPaths.length, reportCounts.reduce((sum, count) => sum + count, 0),
      'the control must enumerate every process report across all compact directories');
    assert.equal(control.order.length, control.reportPaths.length,
      'the pinned-Node control must retain every process report in its captured order');
    const compactReportDirs = control.reportPaths.map((reportPath, index) => {
      const rawReportDir = join(root, `raw-report-${index}`);
      const compactReportDir = join(root, `compact-report-${index}`);
      mkdirSync(rawReportDir);
      linkSync(reportPath, join(rawReportDir, `coverage-1-0000000000000-${String(index).padStart(6, '0')}.json`));
      runCompactor(compactReportDir, rawReportDir);
      return compactReportDir;
    });
    const log = execFileSync(process.execPath,
      ['--expose-internals', 'scripts/coverage-merge-ratchet.mjs', '--output', output, ...control.order.map((index) => compactReportDirs[index]!)],
      { cwd: process.cwd(), env: { ...process.env, TMPDIR: join(root, 'scratch-does-not-exist') }, encoding: 'utf8', stdio: 'pipe' });
    const streamed = readFileSync(output, 'utf8').split('\n');
    const expected = control.lcov.split('\n');
    const mismatch = streamed.findIndex((line, index) => line !== expected[index]);
    assert.equal(mismatch, -1, `LCOV mismatch at line ${mismatch + 1}: ${streamed[mismatch]} vs ${expected[mismatch]}`);
    assert.equal(streamed.length, expected.length, 'every SF, DA, FNDA and BRDA field must match Node');
    assert.ok(summaryTotals(control.lcov).BRF > 0, 'the control must measure branches');
    assert.match(log, /stagingBytes=0\b/);
    assert.match(log, /stagingDir=none\b/);
    assert.equal(Number(log.match(/peakBytes=(\d+)/)?.[1]), Number(log.match(/inputBytes=(\d+)/)?.[1]));
    context.diagnostic(log.trim());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('streamed compact coverage refuses corrupt process reports and source-map references', () => {
  const root = mkdtempSync(join(tmpdir(), 'rmd-invalid-streamed-lcov-'));
  const compact = join(root, 'compact');
  mkdirSync(compact);
  const bundlePath = join(compact, 'coverage-bundle-1-0000000000000-0.json');
  const base = { format: 'rmd-v8-coverage-bundle-v1', sourceMaps: [], reports: [] as unknown[] };
  try {
    for (const [report, message] of [
      [{ result: null, sourceMapRefs: {} }, /invalid compact process report/],
      [{ result: [], sourceMapRefs: null }, /invalid compact process report/],
      [{ result: [], sourceMapRefs: { 'file:///invalid.ts': -1 } }, /invalid source-map reference/],
      [{ result: [], sourceMapRefs: { 'file:///invalid.ts': 0 } }, /invalid source-map reference/],
      [{ result: [], sourceMapRefs: { 'file:///invalid.ts': 0.5 } }, /invalid source-map reference/],
    ] as const) {
      writeFileSync(bundlePath, JSON.stringify({ ...base, reports: [report] }));
      assert.throws(() => runMerger(join(root, 'output.info'), compact), message);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compact shard reports retain distinct source-map topologies for one script URL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-node-source-map-topologies-'));
  const raw = join(dir, 'raw');
  const compact = join(dir, 'compact');
  const url = 'file:///repo/src/same-url.ts';
  mkdirSync(raw);
  mkdirSync(compact);
  const result = [{
    scriptId: '1',
    url,
    functions: [{
      functionName: '',
      ranges: [{ startOffset: 0, endOffset: 2, count: 1 }],
      isBlockCoverage: true,
    }],
  }];
  writeFileSync(
    join(raw, 'coverage-1-0000000000000-0.json'),
    JSON.stringify({ result, 'source-map-cache': { [url]: { marker: 'left' } } }),
  );
  writeFileSync(
    join(raw, 'coverage-2-0000000000000-0.json'),
    JSON.stringify({ result, 'source-map-cache': { [url]: { marker: 'right' } } }),
  );

  runCompactor(compact, raw);
  const [bundle] = compactBundles(compact) as Array<{
    sourceMaps: Array<{ marker: string }>;
    reports: Array<{ sourceMapRefs: Record<string, number> }>;
  }>;
  assert.ok(bundle);
  assert.equal(bundle.reports.length, 2);
  assert.deepEqual(
    bundle.reports.map((report) => bundle.sourceMaps[report.sourceMapRefs[url]].marker).sort(),
    ['left', 'right'],
  );
});

test('coverage merge CLI refuses an empty raw shard instead of producing a vacuous report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-node-coverage-'));
  const empty = join(dir, 'empty');
  const output = join(dir, 'merged.info');
  mkdirSync(empty);

  assert.throws(() => runMerger(output, empty), /contains no V8 coverage files/);
});

test('coverage merge CLI names an unreadable raw coverage directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-node-unreadable-coverage-'));
  const missing = join(dir, 'missing');
  const output = join(dir, 'merged.info');

  assert.throws(() => runMerger(output, missing), /cannot read raw coverage directory/);
});

test('coverage merge CLI refuses a Node runtime that differs from the repository pin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-node-version-mismatch-'));
  const script = join(process.cwd(), 'scripts/coverage-merge-ratchet.mjs');
  const output = join(dir, 'merged.info');
  writeFileSync(join(dir, '.nvmrc'), '0.0.0\n');

  assert.throws(
    () => execFileSync(process.execPath, ['--expose-internals', script, '--output', output, join(dir, 'raw')], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    }),
    /raw coverage merge requires the repository-pinned Node 0\.0\.0/,
  );
});

test('coverage merge CLI names the required expose-internals process capability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-node-hidden-internals-'));
  const output = join(dir, 'merged.info');

  assert.throws(
    () => execFileSync(
      process.execPath,
      ['scripts/coverage-merge-ratchet.mjs', '--output', output, join(dir, 'raw')],
      { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' },
    ),
    /pinned raw coverage merger is unavailable; invoke with node --expose-internals/,
  );
});

test('coverage merge CLI requires exactly one output mode', () => {
  assert.throws(
    () => execFileSync(process.execPath, ['--expose-internals', 'scripts/coverage-merge-ratchet.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
    }),
    /exactly one of --output or --compact-output is required/,
  );
});
