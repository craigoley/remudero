import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
// @ts-ignore executable mjs modules have no declaration files.
import * as tiers from '#scripts/test-tier-manifest.mjs';
// @ts-ignore executable mjs modules have no declaration files.
import { runNativeTests } from '#scripts/native-test-run.mjs';
// @ts-ignore executable mjs modules have no declaration files.
import { runCensusSuitesViaChild } from '#scripts/census-precheck.mjs';
// @ts-ignore executable mjs modules have no declaration files.
import { runRuleSuites } from '#scripts/list-rule-suites.mjs';
import { REPO_ROOT } from '#test/helpers/repo-root.js';

const bounded = (args: string[], root: string, manifest: object) => {
  const api = tiers as { boundedNodeTestArgs?: (args: string[], root: string, manifest: object) => string[] };
  assert.equal(typeof api.boundedNodeTestArgs, 'function', 'native child argv must carry a per-test deadline');
  return api.boundedNodeTestArgs!(args, root, manifest);
};

test('native test deadlines derive from selected durations and preserve explicit positive bounds', () => {
  const manifest = { thresholdMs: 5000, files: { 'test/slow.test.ts': 9000, 'test/unselected.test.ts': 1_000_000 } };
  const args = ['--test', '--test-reporter=tap', 'test/slow.test.ts'];
  assert.deepEqual(bounded(args, REPO_ROOT, manifest), ['--test-timeout=216000', ...args]);
  assert.deepEqual(bounded(['--test', 'test/new.test.ts'], REPO_ROOT, manifest),
    ['--test-timeout=120000', '--test', 'test/new.test.ts']);
  for (const explicit of [['--test-timeout=8000'], ['--test-timeout', '8000']]) {
    const given = ['--test', ...explicit, 'test/slow.test.ts'];
    assert.deepEqual(bounded(given, REPO_ROOT, manifest), given);
  }
  for (const invalid of ['0', '-1', 'Infinity', 'wat']) {
    assert.throws(() => bounded(['--test', `--test-timeout=${invalid}`], REPO_ROOT, manifest), /positive/);
  }
  assert.deepEqual(bounded(['scripts/ordinary.mjs'], REPO_ROOT, manifest), ['scripts/ordinary.mjs']);
  assert.deepEqual(bounded(['--test', join(REPO_ROOT, 'test/slow.test.ts')], REPO_ROOT, manifest),
    ['--test-timeout=216000', '--test', join(REPO_ROOT, 'test/slow.test.ts')]);
});

test('native rule-suite children keep their population and reporter while gaining per-test deadlines', () => {
  const calls: string[][] = [];
  const result = runRuleSuites(REPO_ROOT, ((_file: string, args: string[]) => {
    calls.push(args);
    return { status: 0 };
  }) as typeof spawnSync);
  assert.equal(result, 0);
  assert.ok(calls.length > 100, 'positive control: inspected the actual rule population');
  for (const args of calls) {
    assert.ok(args.some(arg => /^--test-timeout=[1-9][0-9]*$/.test(arg)), args.join(' '));
    assert.ok(args.includes('--test-reporter=spec'));
    assert.equal(args.filter(arg => arg.endsWith('.test.ts')).length, 1);
  }
});

test('native npm census entrypoints derive deadlines without changing their targets', () => {
  const scripts = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts;
  const commands = Object.entries(scripts).filter(([name, command]) => name.startsWith('census:') && String(command).includes('--test '));
  assert.ok(commands.length >= 25, 'positive control: all existing raw npm test censuses remain executable');
  for (const [name, command] of commands) {
    assert.ok(String(command).startsWith('node scripts/native-test-run.mjs --test '), name);
    assert.match(String(command), /--import tsx --import \.\/test\/setup\/tmp-hygiene\.ts test\/.*\.test\.ts$/);
  }
});

test('native census precheck bounds argv before either its real or injected runner', () => {
  const stopped = new Error('captured bounded argv before execution');
  assert.throws(() => runCensusSuitesViaChild({ root: REPO_ROOT, files: ['test/cycle-ratchet.test.ts'],
    priority: { wrap: (_file: string, args: string[]) => {
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts/test-tier-manifest.json'), 'utf8'));
      const expected = bounded(['--test', 'test/cycle-ratchet.test.ts'], REPO_ROOT, manifest)[0];
      assert.ok(args.includes(expected));
      assert.ok(args.includes('--test-reporter=tap'));
      assert.equal(args.at(-1), 'test/cycle-ratchet.test.ts');
      throw stopped;
    } } }), error => error === stopped);
});

test('the native launcher preserves explicit limits, failure statuses and spawn failures', () => {
  const args = ['--test', '--test-timeout=8000', '--test-reporter=tap', 'test/example.test.ts'];
  const run = (_file: string, actual: string[]) => {
    assert.deepEqual(actual, args);
    return { status: 7 };
  };
  assert.equal(runNativeTests(args, { run }), 7);
  assert.equal(runNativeTests(args, { run: () => ({ status: null, signal: 'SIGTERM' }) }), 1);
  const error = new Error('fixture spawn failure');
  assert.throws(() => runNativeTests(args, { run: () => ({ error }) }), value => value === error);
  assert.throws(() => runNativeTests(['ordinary.mjs']), /requires --test/);
});

test('the native timeout argv runs a real child and preserves complete passing and failing summaries', () => {
  const root = mkdtempSync(join(tmpdir(), 'rmd-native-timeout-'));
  try {
    const file = join(root, 'real.test.mjs');
    for (const passing of [true, false]) {
      writeFileSync(file, `import test from 'node:test'; import assert from 'node:assert/strict'; test('real child', () => assert.equal(${passing}, true));\n`);
      const args = bounded(['--test', '--test-reporter=tap', file], root, { files: {} });
      // Bounded before launch, including when testing a tree where the implementation is absent.
      assert.ok(args.some((arg: string) => arg.startsWith('--test-timeout=')));
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      env.NODE_V8_COVERAGE = '';
      const result = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/native-test-run.mjs'), ...args],
        { cwd: root, env, encoding: 'utf8', timeout: 120000 });
      assert.equal(result.status, passing ? 0 : 1, result.stderr);
      assert.match(result.stdout, /# tests 1\b/);
      assert.match(result.stdout, passing ? /# fail 0\b/ : /# fail 1\b/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
