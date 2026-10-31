import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { makeTempDir } from '#src/lib/tmp.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
type ModuleVerdict = { verdict: string; stage?: string; message?: string };
const gate = await import(pathToFileURL(join(root, 'scripts/diff-coverage.mjs')).href) as {
  changedSourceFiles: (diff: string) => string[];
  classifyTypeOnlyModule: (file: string, read?: (file: string) => string) => ModuleVerdict;
  classifyMissingSourceCoverage: (diff: string, hits: Map<string, Map<number, number>>) => { gaps: string[]; undecidable: unknown[] };
};
const change = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-export const nativeValue = 6;\n+export const nativeValue = 7;\n`;
const own = 'scripts/lib/native-coverage-control.mjs';
const neighbour = 'SF:scripts/lib/neighbour.mjs\nDA:1,9\nend_of_record\n';

test('native coverage population includes scripts and src MJS without widening TypeScript or fixture scope', () => {
  const files = ['src/a.ts', 'scripts/lib/reader.mjs', 'scripts/tool.mjs', 'src/native.mjs', 'test/fixture.mjs', 'docs/example.mjs', 'scripts/types.ts', 'src/view.tsx'];
  assert.deepEqual(gate.changedSourceFiles(files.map(change).join('')), ['scripts/lib/reader.mjs', 'scripts/tool.mjs', 'src/a.ts', 'src/native.mjs']);
  assert.deepEqual(gate.changedSourceFiles('--- a/scripts/gone.mjs\n+++ /dev/null\n'), []);
});

test('native MJS cannot claim a TypeScript-erasure exemption and unread source remains undecidable', () => {
  assert.equal(gate.classifyTypeOnlyModule('scripts/lib/typed.mjs', () => 'export type Hidden = string;').verdict, 'emits-code');
  assert.equal(gate.classifyTypeOnlyModule('scripts/lib/comment.mjs', () => '// no TypeScript erasure here\n').verdict, 'emits-code');
  assert.equal(gate.classifyTypeOnlyModule('src/types.ts', () => 'export type Preserved = string;').verdict, 'type-only');
  assert.deepEqual(gate.classifyTypeOnlyModule('scripts/lib/unreadable.mjs', () => { throw new Error('controlled read failure'); }),
    { verdict: 'undecidable', stage: 'read', message: 'controlled read failure' });
});

test('the actual corpus producer requires its own canonical SF rather than neighbouring evidence', () => {
  const producer = 'scripts/lib/read-map-corpus.mjs';
  assert.deepEqual(gate.classifyMissingSourceCoverage(change(producer), new Map([['scripts/lib/neighbour.mjs', new Map([[1, 9]])]])),
    { gaps: [producer], undecidable: [] });
  assert.deepEqual(gate.classifyMissingSourceCoverage(change(producer), new Map([[producer, new Map([[1, 1]])]])),
    { gaps: [], undecidable: [] });
});

test('the dependency-free real CLI blocks removed own SF and zero own DA while preserving other SF bytes', () => {
  const fixture = makeTempDir('native-sf-proof');
  try {
    mkdirSync(join(fixture, 'scripts/lib'), { recursive: true });
    for (const file of ['scripts/diff-coverage.mjs', 'scripts/lib/argv.mjs', 'scripts/lib/lcov.mjs']) {
      copyFileSync(join(root, file), join(fixture, file));
    }
    writeFileSync(join(fixture, own), 'export const nativeValue = 7;\n');
    writeFileSync(join(fixture, 'change.diff'), change(own));
    assert.equal(existsSync(join(fixture, 'node_modules')), false);
    const cases = [
      { label: 'positive own SF', block: `SF:${own}\nDA:1,1\nend_of_record\n`, expected: 0 },
      { label: 'own SF removed', block: '', expected: 1 },
      { label: 'own DA zero', block: `SF:${own}\nDA:1,0\nend_of_record\n`, expected: 1 },
      { label: 'absolute SF is not canonical identity', block: `SF:${join(fixture, own)}\nDA:1,1\nend_of_record\n`, expected: 1 },
      { label: 'file URL SF is not canonical identity', block: `SF:${pathToFileURL(join(fixture, own)).href}\nDA:1,1\nend_of_record\n`, expected: 1 },
      { label: 'restored own SF', block: `SF:${own}\nDA:1,1\nend_of_record\n`, expected: 0 },
    ];
    for (const row of cases) {
      const report = row.block + neighbour;
      writeFileSync(join(fixture, 'proof.lcov'), report);
      const result = spawnSync(process.execPath, ['scripts/diff-coverage.mjs', '--lcov', 'proof.lcov', '--diff', 'change.diff'],
        { cwd: fixture, encoding: 'utf8', timeout: 10_000, maxBuffer: 1 << 20 });
      assert.ifError(result.error);
      assert.equal(result.signal, null, row.label);
      assert.equal(result.status, row.expected, row.label + '\n' + result.stdout + result.stderr);
      if (row.label === 'own SF removed') assert.match(result.stderr, /have no SF record/);
      assert.equal(readFileSync(join(fixture, 'proof.lcov'), 'utf8'), report, 'gate does not rewrite either SF block');
      assert.equal(report.slice(row.block.length), neighbour, 'neighbouring SF bytes stay identical in every control');
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
