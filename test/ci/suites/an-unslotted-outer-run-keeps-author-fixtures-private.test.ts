import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireTestSlot } from '#src/lib/test-slot.js';
import { ownedFixtureDir } from '#test/helpers/owned-fixture-dir.js';
import { REPO_ROOT } from '#test/helpers/repo-root.js';

test('author fixtures remain private when an outer run has no admitted parent slot', async (t) => {
  // Model only the observed admission shape in an OWNED directory. The enclosing
  // native author still owns its real host admission; no production slot is read.
  const scratch = ownedFixtureDir(t, 'author-fixture-slot-regression');
  const busyDir = join(scratch.dir, 'busy-configured-pool');
  const lease = acquireTestSlot('author-fixture-regression-owned-busy-slot', {
    dir: busyDir, slots: 1, waitBoundMs: 0, load: () => ({ cores: 8, load1: 0 }),
    memoryHeadroom: () => 8 * 1024 ** 3, log: () => {},
  });
  assert.equal(lease.outcome, 'acquired', lease.note);
  t.after(() => lease.release());
  const holderPath = join(busyDir, 'slot-1.json');
  assert.equal(JSON.parse(readFileSync(holderPath, 'utf8')).pid, process.pid);

  const env = { ...process.env, RMD_TEST_SLOT_DIR: busyDir, RMD_TEST_SLOTS: '1',
    NODE_TEST_CONTEXT: undefined, RMD_TEST_SLOT_PARENT: undefined,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const child = spawn(process.execPath, ['--max-old-space-size=512', '--import', 'tsx',
    '--test', '--test-reporter=tap', '--test-concurrency=1',
    '--test-name-pattern=author deadline admission refuses a too-small real slot budget before starting static work',
    '--import', './test/setup/tmp-hygiene.ts', 'test/author-preflight.test.ts'],
  { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', coupled = false, overbound = false, timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 65_000);
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 70_000);
  const capture = (chunk: Buffer) => {
    if (Buffer.byteLength(output) + chunk.length > 1024 ** 2) {
      overbound = true; child.kill('SIGTERM'); return;
    }
    output += chunk.toString('utf8');
    if (!coupled && /"step"\s*:\s*"test_slot[.](?:waiting|queued)"[^\n]*"label"\s*:\s*"native-author-runtime:sample"/.test(output)) {
      coupled = true;
      // Let the unchanged child finish so the deletion control fails a named
      // assertion with complete TAP, rather than certifying a timeout as a result.
      lease.release();
    }
  };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => { clearTimeout(timer); clearTimeout(killTimer); });
  scratch.until(closed);
  const result = await closed;
  assert.equal(overbound, false, 'the private child output stayed within its byte bound');
  assert.equal(timedOut, false, 'the physical author fixture completed inside its deadline');
  assert.equal(result.signal, null, output.slice(-3000));
  assert.equal(result.code, 0, output.slice(-3000));
  assert.match(output, /(?:^|\n)# tests [1-9][0-9]*(?:\r?\n)/);
  assert.match(output, /(?:^|\n)# pass [1-9][0-9]*(?:\r?\n)/);
  assert.match(output, /(?:^|\n)# fail 0(?:\r?\n)/);
  assert.match(output, /(?:^|\n)ok [0-9]+ - author deadline admission refuses a too-small real slot budget before starting static work/);
  assert.equal(coupled, false, 'the real author fixture must not queue behind the configured outer pool without a parent lease');
  assert.equal(existsSync(holderPath), true, 'the unrelated fixture holder remains owned and held');
  assert.equal(JSON.parse(readFileSync(holderPath, 'utf8')).pid, process.pid);
});
