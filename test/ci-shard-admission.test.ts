import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { parse } from 'yaml';

const root = process.cwd();
const script = join(root, 'scripts/ci-shard-admission.mjs');
const { requiresSetup } = (existsSync(script) ? await import(pathToFileURL(script).href) : {}) as {
  requiresSetup: (files: unknown, opts: { event: string; shard: string; live: string }) => boolean;
};
type Step = { name?: string; id?: string; uses?: string; if?: string; run?: string };
const ci = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')).jobs.ci as { if?: string; steps: Step[] };

test('CI admission skips setup only on the seven idle source PR shards and fails closed elsewhere', () => {
  const opts = { event: 'pull_request', shard: '2', live: '0' };
  for (let shard = 2; shard <= 8; shard++) assert.equal(requiresSetup(['src/lib/leaf.ts'], { ...opts, shard: String(shard) }), false);
  for (const files of [undefined, [], [null], [''], ['test/a.test.ts'], ['test/setup/helper.ts'], ['docs/x.md'], ['plan/tasks.yaml']]) {
    assert.equal(requiresSetup(files, opts), true);
  }
  for (const event of ['push', 'merge_group', 'workflow_dispatch', '']) assert.equal(requiresSetup(['src/a.ts'], { ...opts, event }), true);
  for (const shard of ['1', '', '0', '9', 'unknown']) assert.equal(requiresSetup(['src/a.ts'], { ...opts, shard }), true);
  for (const live of ['1', '', 'unknown']) assert.equal(requiresSetup(['src/a.ts'], { ...opts, live }), true);
});

function runStep(step: Step, setup: string) {
  const fixture = mkdtempSync(join(tmpdir(), 'rmd-ci-admission-'));
  mkdirSync(join(fixture, 'bin'));
  for (const binary of ['node', 'npm', 'npx']) writeFileSync(join(fixture, 'bin', binary), '#!/bin/sh\necho called >> calls\necho SOURCE\n', { mode: 0o755 });
  writeFileSync(join(fixture, 'admission-files.txt'), 'src/leaf.ts\n');
  const body = step.run!.replaceAll('${{ steps.admission.outputs.setup }}', setup).replaceAll('${{ matrix.shard }}', '2');
  const result = spawnSync('bash', ['-eo', 'pipefail', '-c', body], { cwd: fixture, encoding: 'utf8', env: {
    ...process.env, PATH: `${join(fixture, 'bin')}:${process.env.PATH}`, GITHUB_BASE_REF: '',
    GITHUB_OUTPUT: join(fixture, 'out'), GITHUB_STEP_SUMMARY: join(fixture, 'summary'),
  } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const calls = (() => { try { return readFileSync(join(fixture, 'calls'), 'utf8'); } catch { return ''; } })();
  return { fixture, calls };
}

test('CI idle shards run the actual install and classifier guards without dependencies or Chromium', () => {
  const install = ci.steps.find((step) => step.name === 'Install (clean, from lockfile)')!;
  const chromium = ci.steps.find((step) => step.run?.includes('npx playwright install chromium'))!;
  const classify = ci.steps.find((step) => step.id === 'classify')!;
  for (const step of [install, chromium, classify]) {
    assert.equal(runStep(step, 'false').calls, '', `${step.name}: idle source shard must spawn no dependency tool`);
    for (const admitted of ['true', '', 'unknown']) {
      assert.match(runStep(step, admitted).calls, /called/, `${step.name}: admitted or unreadable setup must actually run`);
    }
  }
  const skipped = runStep(classify, 'false');
  assert.equal(readFileSync(join(skipped.fixture, 'changed-files.txt'), 'utf8'), 'src/leaf.ts\n');
  assert.match(readFileSync(join(skipped.fixture, 'out'), 'utf8'), /class=SOURCE/);
  assert.equal(ci.if, undefined, 'the matrix check must still register');
  assert.equal(ci.steps.find((step) => step.name === 'Restore npm cache only for admitted work')?.if, "${{ steps.admission.outputs.setup != 'false' }}");
  // W1-T5697: the browser cache follows the browser admission, which equals setup on shards 2-8.
  assert.equal(ci.steps.find((step) => step.name === "Cache Playwright's Chromium download")?.if, "${{ steps.admission.outputs.browser != 'false' }}");
  const admission = ci.steps.findIndex((step) => step.id === 'admission');
  assert.ok(admission > 0 && admission < ci.steps.indexOf(install), 'admission must precede installation');
});

test('CI admission runs on pinned native Node before npm and treats unreadable diffs as work', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'rmd-ci-admission-cli-'));
  const run = (path: string) => spawnSync(process.execPath, [script, '--changed-files', path, '--shard', '2'], {
    encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', RMD_AFFECTED_SUITE_LIVE: '0' },
  });
  writeFileSync(join(fixture, 'changed'), 'src/leaf.ts\n');
  assert.equal(run(join(fixture, 'changed')).stdout.trim(), 'false');
  const unreadable = run(join(fixture, 'missing'));
  assert.equal(unreadable.status, 0);
  assert.equal(unreadable.stdout.trim(), 'true');
  assert.match(unreadable.stderr, /unreadable diff/);
});
