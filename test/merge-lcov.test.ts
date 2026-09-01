import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// @ts-expect-error The production coverage merger is an executable .mjs module outside tsconfig.
import { renderCoverageSummary } from '../scripts/merge-lcov.mjs';

function runMerger(output: string, ...rawDirectories: string[]): string {
  return execFileSync(
    process.execPath,
    ['--expose-internals', 'scripts/merge-lcov.mjs', '--output', output, ...rawDirectories],
    { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' },
  );
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

test('merge-lcov CLI merges raw V8 ranges before assigning LCOV branch indexes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-node-coverage-'));
  const leftRaw = join(dir, 'raw-left');
  const rightRaw = join(dir, 'raw-right');
  const bothRaw = join(dir, 'raw-both');
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

  runMerger(leftLcov, leftRaw);
  runMerger(rightLcov, rightRaw);
  runMerger(bothLcov, bothRaw);
  runMerger(mergedLcov, leftRaw, rightRaw);

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

test('merge-lcov CLI refuses an empty raw shard instead of producing a vacuous report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-node-coverage-'));
  const empty = join(dir, 'empty');
  const output = join(dir, 'merged.info');
  mkdirSync(empty);

  assert.throws(() => runMerger(output, empty), /contains no V8 coverage files/);
});
