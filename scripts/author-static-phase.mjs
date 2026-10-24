#!/usr/bin/env node
/** Internal bounded-author tier runner; the ordinary/full preflight CLI is unchanged. */
import {writeFileSync, realpathSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {runPreflightFast, buildPreflightSummary} from '../src/lib/ci-parity.ts';
import {runPreflightCiChecks, runPreflightScopedDiffCoverage} from '../src/run-task.ts';
import {ownedStaticPhaseContext} from './lib/author-rule-owner.mjs';
import {REPO_ROOT} from './lib/repo-root.mjs';
import {isMainModule} from './lib/argv.mjs';

export function main(argv, {root = REPO_ROOT, fast = runPreflightFast,
  ciChecks = runPreflightCiChecks, coverage = runPreflightScopedDiffCoverage} = {}) {
  const {values} = parseArgs({args: argv, options: {phase: {type: 'string'}, 'summary-file': {type: 'string'}}});
  const runners = {'fast': fast, 'ci-checks': ciChecks, 'scoped-coverage': coverage};
  if (!Object.hasOwn(runners, values.phase) || !values['summary-file']) throw new Error('unknown bounded static tier or missing summary');
  const identity = ownedStaticPhaseContext(root), target = resolve(values['summary-file']);
  if (realpathSync(dirname(target)) !== identity.directory) throw new Error('static summary must belong to the live owner directory');
  const started = Date.now();
  let result;
  try { result = runners[values.phase](root); }
  catch (error) { result = {ok: false, steps: [{name: values.phase + ':invocation', ok: false, detail: error.message}]}; }
  // Final source/runtime/dependency verification is required even after an actual failed leaf.
  ownedStaticPhaseContext(root);
  const deferred = values.phase === 'fast' ? result.deferred ?? [] : [];
  const complete = result.ok === true && result.steps.length > 0 && result.steps.every(step => step.ok === true);
  const partial = !complete && deferred.length > 0 && result.steps.length > 0
    && result.steps.every(step => step.ok === true || deferred.includes(step.name));
  const summary = {...buildPreflightSummary({steps: result.steps, finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started, headSha: identity.head, args: argv}), phase: values.phase,
    ...(partial ? {ok: false, failed: 0, disposition: 'over-capacity', deferred} : {})};
  writeFileSync(target, JSON.stringify(summary, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  for (const step of result.steps) console.log(step.detail);
  console.log(`${values.phase}: ${partial ? 'OVER-CAPACITY; not PASS' : complete ? 'PASS' : 'FAIL'}; summary=${target}`);
  return complete ? 0 : partial ? 3 : 1;
}

if (isMainModule(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(`author static phase refused: ${error.message}`); process.exitCode = 1; }
}
