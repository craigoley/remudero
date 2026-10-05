#!/usr/bin/env node
// Author-time feedback, not a substitute for the required hosted full-suite/coverage verdict.
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { affectedSelectionOrFull, readAffectedSuitesInput } from '../src/lib/affected-suites.ts';
import { listTestFiles } from './test-tier-manifest.mjs';
import { isMainModule, parseArgv } from './lib/argv.mjs';
import { REPO_ROOT } from './lib/repo-root.mjs';

export function authorEnvironment(parent) {
  const env = { ...parent, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: '' };
  // Git's repository-local environment overrides cwd, including in test subprocesses.
  // Keep transport/auth settings, but never certify a foreign HEAD, index or object store.
  for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR',
    'GIT_NAMESPACE', 'GIT_QUARANTINE_PATH', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_NO_REPLACE_OBJECTS',
    'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE', 'GIT_INTERNAL_SUPER_PREFIX']) delete env[key];
  return env;
}

export function verifiedSuites(root, suites) {
  return [...new Set(suites)].sort().map((suite) => {
    const path = resolve(root, suite);
    if (!/^test\/.*\.test\.ts$/.test(suite) || !path.startsWith(resolve(root) + sep) ||
        !lstatSync(path).isFile()) throw new Error(`unverified test target: ${suite}`);
    return suite;
  });
}

export function completeTestResult(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return result.status === 0 && !result.signal && !result.error &&
    /^# tests [1-9][0-9]*$/m.test(output) && /^# pass [1-9][0-9]*$/m.test(output) && /^# fail 0$/m.test(output);
}

export function main(argv, { root = REPO_ROOT, spawn = spawnSync,
  select = (changed) => affectedSelectionOrFull(changed, () => readAffectedSuitesInput(root, changed)) } = {}) {
  const { values, helpRequested } = parseArgv(argv, {
    'dry-run': { type: 'boolean' },
  }, { allowPositionals: false, helpText: 'preflight-author.mjs [--dry-run]: fresh-base affected tests + default static preflight; full hosted CI remains required.' });
  if (helpRequested) return 0;
  const startedAt = Date.now();
  const receipt = { version: 1, assurance: 'author-only', hostedFullSuiteAndCoverage: 'required-pending',
    node: process.version, dryRun: Boolean(values['dry-run']), steps: [], suites: [] };
  const run = (file, args, extra = {}) => spawn(file, args, {
    cwd: root, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024,
    env: authorEnvironment(process.env), ...extra,
  });
  const git = (args) => {
    const result = run('git', args);
    if (result.status !== 0 || result.error || result.signal) {
      throw new Error(`git ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.signal}`);
    }
    return result.stdout;
  };
  const report = (name, result, ok) => {
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    receipt.steps.push({ name, ok, exitCode: result.status, signal: result.signal ?? null });
  };
  try {
    const pinnedNode = readFileSync(join(root, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
    if (process.versions.node !== pinnedNode) throw new Error(`Node ${pinnedNode} required; got ${process.versions.node}`);
    if (git(['status', '--porcelain', '--untracked-files=normal']).trim()) {
      throw new Error('commit the author tree first; an uncommitted or untracked change is not covered by its HEAD receipt');
    }
    git(['fetch', 'origin', 'main']);
    receipt.headSha = git(['rev-parse', 'HEAD']).trim();
    receipt.baseSha = git(['rev-parse', 'origin/main']).trim();
    if (![receipt.headSha, receipt.baseSha].every((sha) => /^[a-f0-9]{40}$/.test(sha))) throw new Error('unresolved head or base SHA');
    receipt.changedFiles = git(['diff', '--name-only', '-z', `${receipt.baseSha}...${receipt.headSha}`]).split('\0').filter(Boolean);
    if (receipt.changedFiles.length === 0) throw new Error('empty author diff: nothing to verify');
    const selection = select(receipt.changedFiles);
    receipt.selection = selection.fullRun || selection.suites.length === 0 ? 'full-fallback' : 'affected-floor';
    receipt.reasons = selection.reasons;
    if (!selection.fullRun && selection.suites.length === 0) receipt.reasons = [...selection.reasons, 'empty affected floor: refusing a zero-test green'];
    receipt.suites = verifiedSuites(root, receipt.selection === 'full-fallback' ? listTestFiles(root) : selection.suites);
    if (receipt.suites.length === 0) throw new Error('no verified test files in the checkout');
    console.log(`author selection: ${receipt.selection}, ${receipt.suites.length} suite(s); head=${receipt.headSha}, base=${receipt.baseSha}`);
    if (!values['dry-run']) {
      const census = run(process.execPath, [join(root, 'scripts/census-precheck.mjs'), '--base', receipt.baseSha]);
      const censusOk = census.status === 0 && !census.signal && !census.error;
      report('census-precheck', census, censusOk);
      if (census.status === 2 || census.signal || census.error || census.status === null) {
        throw new Error('census precheck could not measure the author tree; expensive validation was not started');
      }
      if (censusOk) {
        const staticResult = run(process.execPath, ['--import', 'tsx', join(root, 'src/run-task.ts'), 'preflight',
          '--from', receipt.baseSha, '--summary-file', join(root, 'coverage/preflight-author-static.json')]);
        report('static-preflight', staticResult, staticResult.status === 0 && !staticResult.signal && !staticResult.error);
        // No whole-suite retry or instrumentation. A missing target/summary is a refusal, never green.
        const tests = run(process.execPath, ['--test', '--test-reporter=tap', `--test-concurrency=${Math.min(4, availableParallelism())}`,
          '--import', 'tsx', '--import', './test/setup/tmp-hygiene.ts', ...receipt.suites]);
        report('affected-tests', tests, completeTestResult(tests));
      }
      if (git(['rev-parse', 'HEAD']).trim() !== receipt.headSha || git(['status', '--porcelain', '--untracked-files=normal']).trim()) {
        throw new Error('the author tree changed during verification; receipt refused');
      }
    }
    receipt.verdict = values['dry-run'] ? 'not-run' : receipt.steps.every((step) => step.ok) ? 'passed' : 'failed';
  } catch (error) {
    receipt.verdict = 'refused';
    receipt.error = error.message;
    console.error(`author preflight REFUSED: ${error.message}`);
  }
  receipt.durationMs = Date.now() - startedAt;
  try {
    mkdirSync(join(root, 'coverage'), { recursive: true });
    writeFileSync(join(root, 'coverage/preflight-author.json'), JSON.stringify(receipt, null, 2) + '\n');
  } catch (error) {
    console.error(`author receipt could not be written: ${error.message}`);
    return 1;
  }
  console.log(`author verdict: ${receipt.verdict}; hosted full-suite/coverage remains REQUIRED, not proven by this run`);
  return ['passed', 'not-run'].includes(receipt.verdict) ? 0 : 1;
}

if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
