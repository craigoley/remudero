#!/usr/bin/env node
// Closed native sample timing only; never an author PASS or a new test runner.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { acquireTestSlot, lowPriorityCommand, testRunArgv } from '../src/lib/test-slot.ts';
import { listTestFiles } from './test-tier-manifest.mjs';
import { authorEnvironment, completeTestResult } from './preflight-author.mjs';
import { captureStepSync } from './lib/author-step-capture.mjs';
import { digest, RUNTIME_PROFILE_FORMAT, runtimeBindings, runtimeSamples, readRuntimeProfile, sourceHead } from './lib/native-author-runtime.mjs';
import { REPO_ROOT } from './lib/repo-root.mjs';
import { isMainModule, parseArgv } from './lib/argv.mjs';

export function calibrateAuthorRuntime({ root = REPO_ROOT } = {}) {
  const env = authorEnvironment(process.env), head = sourceHead(root);
  const clean = () => {
    const result = spawnSync('git', ['status', '--porcelain'], { cwd: root, env, encoding: 'utf8' });
    if (result.status !== 0 || result.error || result.signal || result.stdout.trim()) throw new Error('calibration requires a clean committed source tree');
    if (sourceHead(root) !== head) throw new Error('calibration source changed');
  };
  clean();
  if (readFileSync(join(root, '.nvmrc'), 'utf8').trim().replace(/^v/, '') !== process.versions.node) {
    throw new Error('calibration requires the pinned native Node version');
  }
  const bindings = runtimeBindings(root, head, env), files = listTestFiles(root).sort();
  const manifest = JSON.parse(readFileSync(join(root, 'scripts/test-tier-manifest.json'), 'utf8'));
  const samples = runtimeSamples(files, manifest);
  if (!samples.length) throw new Error('calibration has no physical samples');
  mkdirSync(join(root, 'coverage'), { recursive: true });
  const dir = mkdtempSync(join(root, 'coverage/rmd-native-runtime-'));
  const paths = { stdout: join(dir, 'sample.stdout.log'), stderr: join(dir, 'sample.stderr.log'),
    native: join(dir, 'sample.native-result.json'), durations: join(dir, 'durations.json') };
  const slot = acquireTestSlot('native-author-runtime:sample');
  try {
    if (!['acquired', 'inherited'].includes(slot.outcome)) throw new Error('calibration requires an admitted host-wide slot');
    const concurrency = Math.min(4, slot.concurrency);
    const command = lowPriorityCommand(process.execPath, testRunArgv(['--test', '--test-reporter=tap',
      '--test-reporter-destination=stdout', `--test-reporter=${join(root, 'scripts/test-duration-reporter.mjs')}`,
      `--test-reporter-destination=${paths.durations}`, '--import', 'tsx', '--import', './test/setup/tmp-hygiene.ts', ...samples], concurrency));
    const result = captureStepSync(command.file, command.args, { cwd: root, env,
      stdoutPath: paths.stdout, stderrPath: paths.stderr, resultPath: paths.native, runtimeMs: 20 * 60_000 });
    if (!completeTestResult(result)) throw new Error(`native calibration failed or incomplete; evidence retained in ${relative(root, dir)}`);
    clean();
    const durations = JSON.parse(readFileSync(paths.durations, 'utf8'));
    const profile = { format: RUNTIME_PROFILE_FORMAT, at: new Date().toISOString(), bindings,
      samples, concurrency, slot: { outcome: slot.outcome, note: slot.note }, files: durations.files,
      artifacts: Object.entries(paths).map(([name, path]) => ({ name, path: relative(root, path),
        bytes: readFileSync(path).length, sha256: digest(readFileSync(path)) })),
      assurance: 'runtime-sample-only', author: 'not-proven', sourceChanged: false };
    const path = join(dir, 'profile.json');
    writeFileSync(path, JSON.stringify(profile, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    readRuntimeProfile(root, path, bindings);
    return { path, head, samples: samples.length, concurrency, author: 'not-proven' };
  } finally { slot.release(); }
}

export function main(argv) {
  const { helpRequested } = parseArgv(argv, {}, { allowPositionals: false,
    helpText: 'calibrate-author-runtime.mjs: bounded native sample timing in an admitted slot; not author assurance.' });
  if (helpRequested) return 0;
  try { console.log(JSON.stringify(calibrateAuthorRuntime())); return 0; }
  catch (error) { console.error(`native runtime calibration REFUSED: ${error.message}`); return 1; }
}
if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
