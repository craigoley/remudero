import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// @ts-expect-error The production coverage merger is an executable .mjs module outside tsconfig.
import { renderCoverageSummary } from '../scripts/coverage-merge-ratchet.mjs';

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

function compactBundles(directory: string): Array<Record<string, unknown>> {
  const names = readdirSync(directory)
    .filter((name) => /^coverage-bundle-\d+-\d{13}-\d+\.json$/.test(name))
    .sort();
  assert.ok(names.length > 0, `expected compact coverage bundles in ${directory}`);
  return names.map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')) as Record<string, unknown>);
}

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
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_V8_COVERAGE: directory };
  delete env.NODE_TEST_CONTEXT;
  return env;
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
