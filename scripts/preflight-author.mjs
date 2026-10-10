#!/usr/bin/env node
// Author-time feedback, not a substitute for the required hosted full-suite/coverage verdict.
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { affectedSelectionOrFull, changedSymbols, readAffectedSuitesInput, symbollessSourceFiles }
  from '../src/lib/affected-suites.ts';
import { callerReachableSuites } from '../src/lib/ci-parity.ts';
import { acquireTestSlot, lowPriorityCommand, TEST_FILE_PEAK_BYTES, testRunArgv } from '../src/lib/test-slot.ts';
import { listTestFiles } from './test-tier-manifest.mjs';
import { isMainModule, parseArgv } from './lib/argv.mjs';
import { REPO_ROOT } from './lib/repo-root.mjs';
import { captureStepSync, AUTHOR_OUTPUT_LIMIT_BYTES, AUTHOR_STEP_RUNTIME_MS } from './lib/author-step-capture.mjs';

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
  return result.status === 0 && !result.signal && !result.error && result.outputComplete !== false &&
    /^# tests [1-9][0-9]*$/m.test(output) && /^# pass [1-9][0-9]*$/m.test(output) && /^# fail 0$/m.test(output);
}

export function testSummary(output) {
  const fields = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
  const summary = Object.fromEntries(fields.map((field) => {
    const value = [...output.matchAll(new RegExp(`^# ${field} ([0-9]+)$`, 'gm'))].at(-1)?.[1];
    return [field, value === undefined ? null : Number(value)];
  }));
  return fields.every((field) => summary[field] !== null) ? summary : null;
}

/** The author selection for `changed` over `range` (`<base>...<head>`): the floor, plus the NARROW
 *  candidate (changed tests, suites naming a changed source symbol or its src/ caller, path readers,
 *  suites naming a changed file) whenever every changed source file names a symbol. A file whose
 *  hunks name none — an import-only edit, a deletion — leaves `narrow` absent, so the floor runs. */
export function authorSelection(root, changed, range, spawn = spawnSync) {
  return affectedSelectionOrFull(changed, () => {
    const scoped = (file, args, opts = {}) => {
      const result = spawn(file, args, { cwd: root, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024,
        env: authorEnvironment(process.env), ...opts });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
        ...(result.error ? { error: result.error.message } : {}), ...(result.signal ? { signal: result.signal } : {}) };
    };
    const diff = scoped('git', ['diff', '-U0', range, '--', 'src', 'scripts', 'bin']);
    if (diff.status !== 0) throw new Error(`git diff -U0 ${range} exited ${diff.status}: ${diff.stderr.trim().slice(0, 200)}`);
    const readFile = (path) => readFileSync(join(root, path), 'utf8');
    const symbolless = symbollessSourceFiles(changed, diff.stdout, readFile);
    if (symbolless.length > 0) return readAffectedSuitesInput(root, changed);
    const symbols = changedSymbols(diff.stdout, readFile);
    const symbolSuites = symbols.length === 0 ? [] : callerReachableSuites(symbols, root, scoped).suites;
    return readAffectedSuitesInput(root, changed, { symbolSuites });
  });
}

export function main(argv, { root = REPO_ROOT, spawn = spawnSync,
  select = (changed, range) => authorSelection(root, changed, range) } = {}) {
  const { values, helpRequested } = parseArgv(argv, {
    'dry-run': { type: 'boolean' },
  }, { allowPositionals: false, helpText: 'preflight-author.mjs [--dry-run]: fresh-base affected tests + default static preflight; full hosted CI remains required.' });
  if (helpRequested) return 0;
  const startedAt = Date.now();
  const receipt = { version: 1, assurance: 'author-only', hostedFullSuiteAndCoverage: 'required-pending',
    node: process.version, dryRun: Boolean(values['dry-run']), steps: [], suites: [] };
  let diagnosticsRoot;
  const run = (file, args, extra = {}) => spawn(file, args, {
    cwd: root, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024,
    env: authorEnvironment(process.env), ...extra,
  });
  const ensureDiagnostics = () => {
    if (!diagnosticsRoot) {
      mkdirSync(join(root, 'coverage'), { recursive: true });
      diagnosticsRoot = mkdtempSync(join(root, 'coverage', 'rmd-author-'));
    }
  };
  const progress = (currentStep) => {
    ensureDiagnostics();
    const path = join(diagnosticsRoot, 'progress.json');
    writeFileSync(path + '.next', JSON.stringify({ ...receipt, verdict: receipt.verdict ?? 'running',
      authorPid: process.pid, currentStep, updatedAt: new Date().toISOString() }) + '\n',
    { mode: 0o600, flag: 'wx', flush: true });
    renameSync(path + '.next', path);
  };
  const runStep = (name, args, file = process.execPath, childEnvironment = {}) => {
    progress({ name, outputLimitBytes: AUTHOR_OUTPUT_LIMIT_BYTES, runtimeLimitMs: AUTHOR_STEP_RUNTIME_MS });
    const logs = { stdoutPath: join(diagnosticsRoot, `${name}.stdout.log`),
      stderrPath: join(diagnosticsRoot, `${name}.stderr.log`) };
    // Injected spawn outcomes remain an explicit diagnostic seam; production owns live pipes.
    if (spawn !== spawnSync) return run(file, args, { env: { ...authorEnvironment(process.env), ...childEnvironment } });
    const resultPath = join(diagnosticsRoot, `${name}.native-result.json`);
    const result = captureStepSync(file, args, { cwd: root, env: { ...authorEnvironment(process.env), ...childEnvironment },
      ...logs, resultPath });
    return { ...result, capturedLogs: true, nativeResult: relative(root, resultPath) };
  };
  const git = (args) => {
    const result = run('git', args);
    if (result.status !== 0 || result.error || result.signal) {
      throw new Error(`git ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.signal}`);
    }
    return result.stdout;
  };
  const report = (name, result, ok, metadata = {}) => {
    ensureDiagnostics();
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const logs = { stdout: join(diagnosticsRoot, `${name}.stdout.log`), stderr: join(diagnosticsRoot, `${name}.stderr.log`) };
    if (!result.capturedLogs) {
      writeFileSync(logs.stdout, stdout, { mode: 0o600, flag: 'wx' });
      writeFileSync(logs.stderr, stderr, { mode: 0o600, flag: 'wx' });
    }
    receipt.steps.push({ name, ok, ...metadata, exitCode: result.status, signal: result.signal ?? null,
      error: result.error ? { message: result.error.message, code: result.error.code ?? null } : null,
      ...(name === 'affected-tests' ? { testSummary: testSummary(`${stdout}\n${stderr}`) } : {}),
      diagnostics: { stdout: relative(root, logs.stdout), stderr: relative(root, logs.stderr),
        stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
        ...(result.nativeResult ? { nativeResult: result.nativeResult } : {}),
        mayBeIncomplete: Boolean(result.error || result.signal || result.outputComplete === false) } });
    progress();
    // Keep terminal feedback small even for thousands of suites. Never rerun to recover output.
    console.log(`${name}: ${ok ? 'PASS' : 'FAIL'}; ${result.error || result.signal ? 'captured output (may be incomplete)' : 'complete output'}: ${relative(root, diagnosticsRoot)}`);
    const failures = stdout.split('\n').filter((line) => /^\s*not ok [0-9]+/.test(line));
    if (failures.length) console.log(failures.slice(0, 40).join('\n').slice(0, 4096));
    if (failures.length > 40) console.log(`additional failure titles in the saved log: ${failures.length - 40}`);
    process.stdout.write(stdout.slice(-4096));
    process.stderr.write(stderr.slice(-4096));
    if (result.error) console.error(`${name}: ${result.error.code ?? 'spawn-error'}: ${result.error.message}; captured logs may be incomplete`);
  };
  try {
    const pinnedNode = readFileSync(join(root, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
    if (process.versions.node !== pinnedNode) throw new Error(`Node ${pinnedNode} required; got ${process.versions.node}`);
    // Turning worktreeConfig on removes Git's main-worktree-only exception for these keys.
    // A suite can enable it midway through validation and poison every sibling checkout.
    // Admit the topology, never migrate an operator's shared Git configuration here.
    receipt.gitTopology = { state: 'unknown', reads: [] };
    const inside = git(['rev-parse', '--is-inside-work-tree']).trim();
    if (inside !== 'true') {
      if (inside === 'false') receipt.gitTopology.state = 'not-worktree';
      throw new Error('a readable Git working tree is required before author selection or validation');
    }
    const commonValue = (key, boolean = false) => {
      const result = run('git', ['config', '--local', ...(boolean ? ['--type=bool'] : []), '--get', key]);
      receipt.gitTopology.reads.push({ key, status: result.status, signal: result.signal ?? null,
        error: result.error?.message ?? null });
      if (result.error || result.signal || ![0, 1].includes(result.status) ||
          (result.status === 1 && result.stdout?.trim())) {
        const reason = result.error?.message ?? (result.signal ? `signal ${result.signal}`
          : result.stderr?.trim() || `exit ${result.status}`);
        throw new Error(`shared Git ${key} is unreadable: ${reason}`);
      }
      if (result.status === 1) return undefined;
      const value = result.stdout.trim();
      if (boolean && !['true', 'false'].includes(value)) throw new Error(`shared Git ${key} is ambiguous`);
      return value;
    };
    const bare = commonValue('core.bare', true), worktree = commonValue('core.worktree');
    receipt.gitTopology.sharedCoreBare = bare ?? 'absent';
    receipt.gitTopology.sharedCoreWorktree = worktree === undefined ? 'absent' : 'present';
    if (bare === 'true' || worktree !== undefined) {
      receipt.gitTopology.state = 'hazardous-common-config';
      throw new Error('shared Git core.bare=true or core.worktree requires an owned, idle worktreeConfig migration before author validation; this gate does not change shared configuration');
    }
    receipt.gitTopology.state = 'safe';
    if (git(['status', '--porcelain', '--untracked-files=normal']).trim()) {
      throw new Error('commit the author tree first; an uncommitted or untracked change is not covered by its HEAD receipt');
    }
    git(['fetch', 'origin', 'main']);
    receipt.headSha = git(['rev-parse', 'HEAD']).trim();
    receipt.baseSha = git(['rev-parse', 'origin/main']).trim();
    if (![receipt.headSha, receipt.baseSha].every((sha) => /^[a-f0-9]{40}$/.test(sha))) throw new Error('unresolved head or base SHA');
    // A boundary can hide historical controls or make git show render the whole tree.
    // A successful ordinary fetch does not prove it removed that boundary.
    receipt.gitHistory = { state: 'unknown' };
    const shallow = git(['rev-parse', '--is-shallow-repository']).trim();
    if (shallow === 'true') {
      receipt.gitHistory.state = 'shallow';
      throw new Error('complete Git history required before author selection or validation; inspect the owned checkout and run git fetch --unshallow before a distinct admitted run');
    }
    if (shallow !== 'false') throw new Error('Git history completeness is unavailable; author selection and expensive validation were not started');
    receipt.gitHistory.state = 'complete';
    receipt.changedFiles = git(['diff', '--name-only', '-z', `${receipt.baseSha}...${receipt.headSha}`]).split('\0').filter(Boolean);
    if (receipt.changedFiles.length === 0) throw new Error('empty author diff: nothing to verify');
    const selection = select(receipt.changedFiles, `${receipt.baseSha}...${receipt.headSha}`);
    // The narrow selection runs when it was computed and names a suite; else the floor; else all.
    const narrow = selection.fullRun ? undefined : selection.narrow;
    receipt.floorSize = selection.fullRun ? null : selection.suites.length;
    receipt.narrowSize = narrow === undefined ? null : narrow.length;
    receipt.selection = selection.fullRun ? 'full-fallback' : narrow?.length ? 'affected-narrow'
      : selection.suites.length > 0 ? 'affected-floor' : 'full-fallback';
    receipt.reasons = selection.reasons;
    if (!selection.fullRun && receipt.selection === 'full-fallback') receipt.reasons = [...selection.reasons, 'empty affected floor: refusing a zero-test green'];
    receipt.suites = verifiedSuites(root, receipt.selection === 'full-fallback' ? listTestFiles(root)
      : receipt.selection === 'affected-narrow' ? narrow : selection.suites);
    if (receipt.suites.length === 0) throw new Error('no verified test files in the checkout');
    console.log(`author selection: ${receipt.selection}, ${receipt.suites.length} suite(s) (floor ${receipt.floorSize ?? 'full'}, narrow ${receipt.narrowSize ?? 'none'}); head=${receipt.headSha}, base=${receipt.baseSha}`);
    if (!values['dry-run']) {
      const census = runStep('census-precheck', [join(root, 'scripts/census-precheck.mjs'), '--base', receipt.baseSha]);
      const censusOk = census.status === 0 && !census.signal && !census.error;
      report('census-precheck', census, censusOk);
      if (census.status === 2 || census.signal || census.error || census.status === null) {
        throw new Error('census precheck could not measure the author tree; expensive validation was not started');
      }
      if (censusOk) {
        // The cheap census runs first. One owner then admits BOTH expensive phases;
        // nested production checks borrow only its actual live ancestor lease.
        const slot = acquireTestSlot('preflight-author:static-and-affected', { perFileBytes: TEST_FILE_PEAK_BYTES });
        try {
          receipt.testSlot = { outcome: slot.outcome, concurrency: slot.concurrency, waitedMs: slot.waitedMs, note: slot.note };
          const staticCommand = lowPriorityCommand(process.execPath, ['--import', 'tsx',
            join(root, 'src/run-task.ts'), 'preflight', '--from', receipt.baseSha,
            '--summary-file', join(root, 'coverage/preflight-author-static.json')]);
          const staticResult = runStep('static-preflight', staticCommand.args, staticCommand.file, slot.childEnvironment);
          const staticOk = staticResult.status === 0 && !staticResult.signal && !staticResult.error;
          report('static-preflight', staticResult, staticOk, { priority: staticCommand.priority });
          // An unsuccessful static gate already makes this tree unpublishable. Keep its failed
          // receipt and selected floor, but don't spend another full run on known-doomed tests.
          if (staticOk) {
            // No whole-suite retry or instrumentation. A missing target/summary is a refusal, never green.
            // The host-wide test slot, a load-derived concurrency (never above the old 4) and nice (test-slot.ts).
            slot.refresh();
            const child = lowPriorityCommand(process.execPath, testRunArgv(['--test', '--test-reporter=tap',
              '--import', 'tsx', '--import', './test/setup/tmp-hygiene.ts', ...receipt.suites], Math.min(4, slot.concurrency)));
            const tests = runStep('affected-tests', child.args, child.file);
            report('affected-tests', tests, completeTestResult(tests));
          } else {
            receipt.affectedTestsNotRunReason = 'static-preflight did not succeed; see its native outcome';
            console.log('affected-tests: NOT RUN — static-preflight did not succeed; selected floor retained in the receipt');
          }
        } finally {
          slot.release();
        }
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
    if (diagnosticsRoot) {
      writeFileSync(join(diagnosticsRoot, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    }
    writeFileSync(join(root, 'coverage/preflight-author.json'), JSON.stringify(receipt, null, 2) + '\n');
    if (diagnosticsRoot) progress();
  } catch (error) {
    receipt.verdict = 'refused';
    receipt.error = `author receipt could not be written: ${error.message}`;
    console.error(receipt.error);
    if (diagnosticsRoot) {
      try { progress(); }
      catch (progressError) { console.error(`refused progress receipt unavailable: ${progressError.message}`); }
    }
    return 1;
  }
  console.log(`author verdict: ${receipt.verdict}; hosted full-suite/coverage remains REQUIRED, not proven by this run`);
  return ['passed', 'not-run'].includes(receipt.verdict) ? 0 : 1;
}

if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
