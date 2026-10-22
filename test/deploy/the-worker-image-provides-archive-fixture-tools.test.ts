import { REPO_ROOT as __testRepoRoot } from "#test/helpers/repo-root.js";
/** @source-text-subject: deploy/Dockerfile runtime archive prerequisites. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RMD_TMP_PREFIX } from '#src/lib/tmp.js';

const REPO_ROOT = (__testRepoRoot + "/");

test('the worker image declares both archive tools and its real build checks refuse either missing binary', (t) => {
  const docker = readFileSync(join(REPO_ROOT, 'deploy/Dockerfile'), 'utf8').replace(/\\\r?\n/g, ' ');
  const layers = docker.split('\n').filter((line) => line.startsWith('RUN ') && /\bbubblewrap\b/.test(line));
  assert.equal(layers.length, 1, 'one canonical runtime-tool install layer');
  const checks = layers[0].replace(/^RUN\s+/, '').split(/\s+&&\s+/);
  const install = checks.find((command) => /^apt-get install\s/.test(command));
  assert.ok(install, 'the runtime layer must actually install its tools');
  for (const tool of ['zip', 'unzip']) assert.ok(install.split(/\s+/).includes(tool), `${tool} must be installed`);
  const archiveChecks = checks.filter((command) => /^(?:zip|unzip)\s/.test(command));
  assert.equal(archiveChecks.length, 2, 'both archive tools must be checked without a masking pipeline');
  assert.ok(archiveChecks.every((command) => !command.includes('|')));
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}floor-image-archive-tools-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'tools'); mkdirSync(bin);
  const tool = (name: string) => { writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); };
  tool('zip'); tool('unzip');
  // Run the source image's exact archive check commands; only their binaries are controlled.
  const run = () => spawnSync('/bin/sh', ['-e', '-c', archiveChecks.join(' && ')],
    { cwd: root, env: { ...process.env, PATH: bin }, encoding: 'utf8' });
  assert.equal(run().status, 0);
  for (const missing of ['zip', 'unzip']) {
    rmSync(join(bin, missing));
    const result = run();
    assert.equal(result.status, 127, result.stderr);
    assert.ok(result.stderr.includes(missing));
    tool(missing);
  }
  assert.equal(run().status, 0, 'restored toolchain must pass the same commands');
});
