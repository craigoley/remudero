import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// @ts-expect-error The production LCOV merger is an executable .mjs module outside tsconfig.
import { mergeLcovReports, parseLcovReport, renderMergedLcov } from '../scripts/merge-lcov.mjs';
// @ts-expect-error The production coverage gate is an executable .mjs module outside tsconfig.
import { parseLcovTotals } from '../scripts/coverage-ratchet.mjs';

const SHARD_ONE = `TN:
SF:src/lib/example.ts
FN:2,covered
FN:7,uncovered
FNDA:3,covered
FNDA:0,uncovered
FNF:2
FNH:1
BRDA:2,0,0,1
BRDA:2,0,1,-
BRF:2
BRH:1
DA:1,1
DA:2,1
DA:7,0
LF:3
LH:2
end_of_record
`;

const SHARD_TWO = `TN:
SF:src/lib/example.ts
FN:2,covered
FN:7,uncovered
FNDA:0,covered
FNDA:4,uncovered
FNF:2
FNH:1
BRDA:2,0,0,0
BRDA:2,0,1,2
BRF:2
BRH:1
DA:1,0
DA:2,2
DA:7,5
LF:3
LH:2
end_of_record
TN:
SF:src/lib/second.ts
FN:1,second
FNDA:1,second
FNF:1
FNH:1
BRF:0
BRH:0
DA:1,1
LF:1
LH:1
end_of_record
`;

test('merge-lcov unions shard hit state and recomputes totals without duplicate source records', () => {
  const merged = mergeLcovReports([parseLcovReport(SHARD_ONE), parseLcovReport(SHARD_TWO)]);
  const rendered = renderMergedLcov(merged);

  assert.equal((rendered.match(/^SF:src\/lib\/example\.ts$/gm) ?? []).length, 1);
  assert.match(rendered, /^FNDA:3,covered$/m);
  assert.match(rendered, /^FNDA:4,uncovered$/m);
  assert.match(rendered, /^BRDA:2,0,0,1$/m);
  assert.match(rendered, /^BRDA:2,0,1,2$/m);
  assert.match(rendered, /^FNF:2$/m);
  assert.match(rendered, /^FNH:2$/m);
  assert.match(rendered, /^LF:3$/m);
  assert.match(rendered, /^LH:3$/m);

  assert.deepEqual(parseLcovTotals(rendered), {
    linesPct: 100,
    branchesPct: 100,
    lf: 4,
    lh: 4,
    brf: 2,
    brh: 2,
    skippedRecords: 0,
  });
});

test('merge-lcov reconciles duplicate function declarations to the largest source line', () => {
  const duplicate = `TN:
SF:src/lib/example.ts
FN:4,moved
FN:7,moved
FNDA:1,moved
FNF:2
FNH:1
BRF:0
BRH:0
DA:7,1
LF:1
LH:1
end_of_record
`;
  const rendered = renderMergedLcov(mergeLcovReports([parseLcovReport(duplicate)]));
  assert.doesNotMatch(rendered, /^FN:4,moved$/m);
  assert.match(rendered, /^FN:7,moved$/m);
  assert.match(rendered, /^FNF:1$/m);
});

test('merge-lcov preserves distinct branch keys that compare numerically equal', () => {
  const leadingZero = `TN:
SF:src/lib/example.ts
BRDA:2,0,0,1
BRDA:02,0,0,2
BRF:2
BRH:2
DA:2,1
LF:1
LH:1
end_of_record
`;

  const rendered = renderMergedLcov(mergeLcovReports([parseLcovReport(leadingZero)]));
  assert.match(rendered, /^BRDA:2,0,0,1$/m);
  assert.match(rendered, /^BRDA:02,0,0,2$/m);
  assert.match(rendered, /^BRF:2$/m);
  assert.match(rendered, /^BRH:2$/m);
});

test('merge-lcov CLI refuses an empty shard instead of producing a vacuous report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rmd-merge-lcov-'));
  const empty = join(dir, 'empty.info');
  const output = join(dir, 'merged.info');
  writeFileSync(empty, '');

  assert.throws(
    () =>
      execFileSync(process.execPath, ['scripts/merge-lcov.mjs', '--output', output, empty], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    /contains no source records/,
  );
});

test('merge-lcov CLI writes the same canonical report as the module API', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rmd-merge-lcov-'));
  const one = join(dir, 'one.info');
  const two = join(dir, 'two.info');
  const output = join(dir, 'merged.info');
  writeFileSync(one, SHARD_ONE);
  writeFileSync(two, SHARD_TWO);

  execFileSync(process.execPath, ['scripts/merge-lcov.mjs', '--output', output, one, two], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
  });

  assert.equal(
    readFileSync(output, 'utf8'),
    renderMergedLcov(mergeLcovReports([parseLcovReport(SHARD_ONE), parseLcovReport(SHARD_TWO)])),
  );
});
