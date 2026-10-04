import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { gitRepo } from './helpers/git-repo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/preflight-author.mjs');
const mod = await import(pathToFileURL(SCRIPT).href) as {
  verifiedSuites: (root: string, suites: string[]) => string[];
  completeTestResult: (result: { status: number | null; stdout?: string; signal?: string; error?: Error }) => boolean;
  main: (argv: string[], deps: { root: string; select?: (changed: string[]) => unknown }) => number;
};

function fixture() {
  const repo = gitRepo({ kind: 'author-preflight', seedCommit: false });
  const root = repo.dir;
  for (const path of ['test/setup', 'src', 'scripts']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, '.nvmrc'), process.versions.node + '\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules\ncoverage\n');
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'));
  writeFileSync(join(root, 'scripts/diff-class.mjs'), '// This fixture has no census path readers.\n');
  writeFileSync(join(root, 'test/setup/tmp-hygiene.ts'), 'export {};\n');
  writeFileSync(join(root, 'src/run-task.ts'), "console.log('fixture static preflight passed');\n");
  writeFileSync(join(root, 'src/leaf.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'test/leaf.test.ts'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/leaf.js'; test('leaf', () => assert.equal(value, 1));\n");
  writeFileSync(join(root, 'test/other.test.ts'), "import { test } from 'node:test'; test('unrelated', () => {});\n");
  const git = (...args: string[]) => repo.git(...args);
  git('add', '.');
  git('commit', '-m', 'test: baseline');
  git('remote', 'add', 'origin', root);
  git('checkout', '-b', 'run-unfiled-author-fixture');
  writeFileSync(join(root, 'src/leaf.ts'), 'export const value = 2;\n');
  writeFileSync(join(root, 'test/leaf.test.ts'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/leaf.js'; test('leaf', () => { assert.equal(value, 2); assert.equal(process.env.NODE_V8_COVERAGE, ''); });\n");
  git('add', '.');
  git('commit', '-m', 'fix: change the leaf');
  return { root, git, receipt: () => JSON.parse(readFileSync(join(root, 'coverage/preflight-author.json'), 'utf8')) };
}

test('author preflight runs real affected tests without coverage and records exact tree scope', () => {
  const f = fixture();
  assert.equal(mod.main([], { root: f.root }), 0);
  const receipt = f.receipt();
  assert.equal(receipt.verdict, 'passed');
  assert.equal(receipt.assurance, 'author-only');
  assert.equal(receipt.hostedFullSuiteAndCoverage, 'required-pending');
  assert.equal(receipt.headSha, f.git('rev-parse', 'HEAD'));
  assert.equal(receipt.baseSha, f.git('rev-parse', 'main'));
  assert.equal(receipt.selection, 'affected-floor');
  assert.deepEqual(receipt.suites, ['test/leaf.test.ts']);
  assert.deepEqual(receipt.steps.map((s: { ok: boolean }) => s.ok), [true, true]);
});

test('author preflight full fallback includes unrelated tests for unmodelled configuration', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'package-lock.json'), '{}\n');
  f.git('add', '.'); f.git('commit', '-m', 'test: change dependency inputs');
  assert.equal(mod.main([], { root: f.root }), 0);
  assert.equal(f.receipt().selection, 'full-fallback');
  assert.deepEqual(f.receipt().suites, ['test/leaf.test.ts', 'test/other.test.ts']);
});

test('author preflight refuses a real test failure and preserves its failed receipt', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'src/leaf.ts'), 'export const value = 3;\n');
  f.git('add', '.'); f.git('commit', '-m', 'test: break the leaf');
  assert.equal(mod.main([], { root: f.root }), 1);
  assert.equal(f.receipt().verdict, 'failed');
  assert.equal(f.receipt().steps[1].ok, false);
});

test('author preflight refuses dirty, stale-base, empty-diff, wrong-runtime and ghost-file claims', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'untracked.ts'), 'export {};');
  assert.equal(mod.main([], { root: f.root }), 1);
  assert.match(f.receipt().error, /uncommitted or untracked/);
  f.git('add', '.'); f.git('commit', '-m', 'test: track fixture');
  assert.equal(mod.main([], { root: f.root, select: () => ({ fullRun: false, suites: ['test/ghost.test.ts'], reasons: [] }) }), 1);
  assert.match(f.receipt().error, /ENOENT/);
  f.git('remote', 'set-url', 'origin', join(f.root, 'absent-origin'));
  assert.equal(mod.main([], { root: f.root }), 1);
  assert.match(f.receipt().error, /git fetch origin main failed/);
  f.git('remote', 'set-url', 'origin', f.root);
  f.git('checkout', 'main');
  assert.equal(mod.main([], { root: f.root }), 1);
  assert.match(f.receipt().error, /empty author diff/);
  writeFileSync(join(f.root, '.nvmrc'), '0.0.0\n');
  assert.equal(mod.main([], { root: f.root }), 1);
  assert.match(f.receipt().error, /Node 0.0.0 required/);
});

test('author preflight dry run never claims tests passed and empty selection falls back to all tests', () => {
  const f = fixture();
  assert.equal(mod.main(['--dry-run'], { root: f.root, select: () => ({ fullRun: false, suites: [], reasons: [] }) }), 0);
  assert.equal(f.receipt().verdict, 'not-run');
  assert.deepEqual(f.receipt().steps, []);
  assert.equal(f.receipt().selection, 'full-fallback');
  assert.equal(f.receipt().suites.length, 2);
  assert.match(f.receipt().reasons[0], /zero-test green/);
});

test('author preflight rejects green exit without a positive complete test summary', () => {
  assert.equal(mod.completeTestResult({ status: 0, stdout: '# tests 1\n# fail 0\n' }), true);
  for (const result of [
    { status: 0, stdout: 'ok 1 - test/ghost.test.ts' },
    { status: 0, stdout: '# tests 0\n# fail 0\n' },
    { status: 0, stdout: '# tests 1\n# fail 1\n' },
    { status: null, signal: 'SIGTERM', stdout: '# tests 1\n# fail 0\n' },
    { status: 1, stdout: '# tests 1\n# fail 0\n' },
    { status: 0, error: new Error('spawn failed'), stdout: '# tests 1\n# fail 0\n' },
  ]) assert.equal(mod.completeTestResult(result), false);
  const f = fixture();
  assert.deepEqual(mod.verifiedSuites(f.root, ['test/leaf.test.ts', 'test/leaf.test.ts']), ['test/leaf.test.ts']);
  assert.throws(() => mod.verifiedSuites(f.root, ['../outside.test.ts']), /unverified/);
});
