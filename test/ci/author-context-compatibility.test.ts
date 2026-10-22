import { REPO_ROOT as __workspaceRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL as __workspaceUrl } from "node:url";
const __workspaceRootUrl = __workspaceUrl(__workspaceRoot + "/");
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {ownedFixtureDir} from '#test/helpers/owned-fixture-dir.js';
type NativeScriptCoverage = {url: string; functions: Array<{functionName: string; ranges: Array<{count: number}>}>};
type ContextReport = {state: string; scope: string; probesRun: boolean; reason?: string; childClosure?: string;
  observations?: Record<string, {supported: boolean; logicalBytes?: number; pathAllocatedBytes?: number}>;
  requiredFullSuitesRemain?: string[]};
const subject = '#scripts/lib/author-context-compatibility.mjs';
type ContextModule = {
  contextProbeSource: (input: {requirements: string[]; volume?: string; processFactsUrl?: string}) => string;
  declaredScopedRequirements: (root: string, files: string[]) => unknown;
  qualifyScopedContext: (input: {root: string; files: string[]; volume?: string; env?: NodeJS.ProcessEnv; launch?: string[]}) => ContextReport;
  nativeContextProbe: (input: {requirements: string[]; volume: string; processFactsUrl?: string}) => Promise<{
    observations: Record<string, {supported: boolean; reason?: string}>; temporaryProbeRemoved: boolean}>;
};
let contextProbeSource: ContextModule['contextProbeSource'];
let declaredScopedRequirements: ContextModule['declaredScopedRequirements'];
let qualifyScopedContext: ContextModule['qualifyScopedContext'];
let nativeContextProbe: ContextModule['nativeContextProbe'];
let contextLoaded = false;
async function loadContextImplementation() {
  assert.ok(fs.existsSync(join(__workspaceRoot, 'scripts/lib/author-context-compatibility.mjs')),
    'this source tree must contain the native compatibility implementation');
  if (contextLoaded) return;
  ({contextProbeSource, declaredScopedRequirements, qualifyScopedContext, nativeContextProbe} =
    await import(subject) as ContextModule);
  contextLoaded = true;
}

test('scoped compatibility refuses a stale declaration instead of running an incompatible suite', async t => {
  await loadContextImplementation();
  const {dir} = ownedFixtureDir(t, 'compat-stale');
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'test/merge-lcov.test.ts'), 'changed suite witness');
  assert.throws(() => declaredScopedRequirements(dir, ['test/merge-lcov.test.ts']), /witness changed.*UNKNOWN/);
});

test('a directory cannot masquerade as a regular declaration witness', async t => {
  await loadContextImplementation();
  const {dir} = ownedFixtureDir(t, 'compat-invalid-witness');
  mkdirSync(join(dir, 'test/merge-lcov.test.ts'), {recursive: true});
  assert.throws(() => declaredScopedRequirements(dir, ['test/merge-lcov.test.ts']), /bounded regular suite/);
});

test('undeclared scoped suites make no universal compatibility claim', async () => {
  await loadContextImplementation();
  const row = qualifyScopedContext({root: process.cwd(), files: ['test/unlisted.test.ts']});
  assert.equal(row.state, 'no-special-requirements-declared');
  assert.equal(row.probesRun, false);
  assert.match(row.scope, /no universal compatibility claim/);
});

test('a context probe refuses an unknown requirement before starting a child', async () => {
  await loadContextImplementation();
  assert.throws(() => contextProbeSource({requirements: ['new-unknown-capability']}), /unknown context capability/);
});

test('the real context probe observes sparse allocation without allocating the logical payload in memory', async t => {
  await loadContextImplementation();
  const {dir} = ownedFixtureDir(t, 'compat-real-sparse');
  const row = qualifyScopedContext({root: process.cwd(), files: ['test/merge-lcov.test.ts'], volume: dir, env: process.env});
  const observation = row.observations?.['sparse-manifest'];
  assert.ok(observation, 'positive control: the real child reported its filesystem');
  assert.equal(observation.logicalBytes, 64 * 1024 ** 2 + 1);
  assert.ok(typeof observation.pathAllocatedBytes === 'number');
  assert.equal(observation.supported, observation.pathAllocatedBytes <= 64 * 1024);
  assert.equal(row.state, observation.supported ? 'qualified' : 'refused');
  assert.deepEqual(row.requiredFullSuitesRemain, ['test/merge-lcov.test.ts']);
});

test('the real context probe observes selected shell stdin and preserves the required suite', async t => {
  await loadContextImplementation();
  const {dir} = ownedFixtureDir(t, 'compat-real-shell');
  const files = ['test/mac-janitor-dependency-health.test.ts'];
  const row = qualifyScopedContext({root: process.cwd(), files, volume: dir, env: process.env});
  assert.equal(row.observations?.['shell-input']?.supported, true);
  assert.equal(row.state, 'qualified');
  assert.deepEqual(row.requiredFullSuitesRemain, files);
});

test('native child coverage instruments the actual compatibility implementation', async t => {
  await loadContextImplementation();
  const {dir} = ownedFixtureDir(t, 'compat-real-child-coverage');
  const coverage = join(dir, 'v8');
  mkdirSync(coverage);
  const row = qualifyScopedContext({root: process.cwd(), files: ['test/mac-janitor-dependency-health.test.ts'],
    volume: dir, env: {...process.env, NODE_V8_COVERAGE: coverage}});
  assert.equal(row.state, 'qualified');
  const reports = readdirSync(coverage).filter(name => /^coverage-.*\.json$/.test(name));
  assert.ok(reports.length > 0, 'positive control: the real child emitted V8 coverage');
  const expected = new URL("scripts/lib/author-context-compatibility.mjs", __workspaceRootUrl).href;
  const scripts = reports.flatMap(name => (JSON.parse(readFileSync(join(coverage, name), 'utf8')) as {result: NativeScriptCoverage[]}).result)
    .filter(script => script.url === expected);
  assert.ok(scripts.length > 0, 'native coverage must name the actual implementation module, not only eval text');
  assert.ok(scripts.some(script => script.functions.some(fn => fn.functionName === 'nativeContextProbe'
    && fn.ranges.some(range => range.count > 0))), 'the actual default probe body must execute');
});

test('a selected shell that cannot read its input refuses context before the suite', async t => {
  await loadContextImplementation();
  const {dir} = ownedFixtureDir(t, 'compat-unavailable-shell');
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'bash'), '#!/bin/sh\nexit 23\n', {mode: 0o755});
  const row = qualifyScopedContext({root: process.cwd(), files: ['test/mac-janitor-dependency-health.test.ts'],
    volume: dir, env: {...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`}});
  assert.equal(row.state, 'refused');
  assert.equal(row.observations?.['shell-input']?.supported, false);
  assert.equal(row.childClosure, 'closed');
});

test('a denied dependency fixture write remains unsupported and releases its private probe', async t => {
  await loadContextImplementation();
  const {dir} = ownedFixtureDir(t, 'compat-write-refusal');
  const original = fs.writeFileSync;
  let denied = false;
  const write = t.mock.method(fs, 'writeFileSync', ((...args: Parameters<typeof fs.writeFileSync>) => {
    if (String(args[0]).startsWith(dir + '/') && String(args[0]).includes('/node_modules/')) {
      denied = true;
      throw Object.assign(new Error('synthetic denied fixture write'), {code: 'EACCES'});
    }
    return Reflect.apply(original, fs, args);
  }) as typeof fs.writeFileSync);
  syncBuiltinESMExports();
  try {
    const row = await nativeContextProbe({requirements: ['dependency-fixture-write'], volume: dir});
    assert.equal(denied, true, 'the default probe reached the denied write');
    assert.deepEqual(row.observations['dependency-fixture-write'], {supported: false, reason: 'EACCES'});
    assert.equal(row.temporaryProbeRemoved, true);
  } finally { write.mock.restore(); syncBuiltinESMExports(); }
});

test('real fixture writes are measured in the actual context and never waive the owning suite', async t => {
  await loadContextImplementation();
  const {dir} = ownedFixtureDir(t, 'compat-real-fixture-write');
  const files = ['test/workspace-usage.test.ts'];
  const row = qualifyScopedContext({root: process.cwd(), files, volume: dir, env: process.env});
  const supported = row.observations?.['dependency-fixture-write']?.supported;
  assert.equal(typeof supported, 'boolean', 'the native child must report its actual write result');
  assert.equal(row.state, supported ? 'qualified' : 'refused');
  assert.deepEqual(row.requiredFullSuitesRemain, files);
});

test('actual self-process identity visibility determines context qualification', async t => {
  await loadContextImplementation();
  const {dir} = ownedFixtureDir(t, 'compat-real-process');
  const files = ['test/coverage-batches.test.ts'];
  const row = qualifyScopedContext({root: process.cwd(), files, volume: dir, env: process.env});
  const supported = row.observations?.['process-start']?.supported;
  assert.equal(typeof supported, 'boolean', 'the actual maintained process probe must report its result');
  assert.equal(row.state, supported ? 'qualified' : 'refused');
  assert.deepEqual(row.requiredFullSuitesRemain, files);
});

test('the real context probe reports a missing launch executable as unknown and retains all required suites', async t => {
  await loadContextImplementation();
  const {dir} = ownedFixtureDir(t, 'compat-missing-launch');
  const files = ['test/merge-lcov.test.ts'];
  const row = qualifyScopedContext({root: process.cwd(), files, volume: dir, env: process.env, launch: [join(dir, 'absent-executable')]});
  assert.equal(row.state, 'refused');
  assert.ok(row.reason, 'refusal must name its reason');
  assert.match(row.reason, /probe-unavailable:ENOENT/);
  assert.deepEqual(row.requiredFullSuitesRemain, files);
});

test('malformed native probe output is refused instead of being a successful context', async t => {
  await loadContextImplementation();
  const {dir} = ownedFixtureDir(t, 'compat-unreadable-child');
  const row = qualifyScopedContext({root: process.cwd(), files: ['test/merge-lcov.test.ts'], volume: dir,
    env: process.env, launch: [process.execPath, '-e', 'process.stdout.write("{")', '--']});
  assert.equal(row.state, 'refused');
  assert.equal(row.reason, 'native-context-probe-unreadable');
  assert.equal(row.childClosure, 'closed');
});

test('valid JSON without completed probe cleanup cannot qualify a context', async t => {
  await loadContextImplementation();
  const {dir} = ownedFixtureDir(t, 'compat-incomplete-child');
  const row = qualifyScopedContext({root: process.cwd(), files: ['test/merge-lcov.test.ts'], volume: dir,
    env: process.env, launch: [process.execPath, '-e', 'console.log(JSON.stringify({version:1,temporaryProbeRemoved:false}))', '--']});
  assert.equal(row.state, 'refused');
  assert.equal(row.reason, 'native-context-probe-incomplete');
  assert.equal(row.childClosure, 'closed');
});

test('a signaled context probe retains an unproven closure result for the runner', async t => {
  await loadContextImplementation();
  const {dir} = ownedFixtureDir(t, 'compat-signaled-child');
  const row = qualifyScopedContext({root: process.cwd(), files: ['test/merge-lcov.test.ts'], volume: dir,
    env: process.env, launch: [process.execPath, '-e', 'process.kill(process.pid,"SIGTERM")', '--']});
  assert.equal(row.state, 'refused');
  assert.ok(row.reason, 'refusal must name its reason');
  assert.match(row.reason, /probe-unavailable:SIGTERM/);
  assert.equal(row.childClosure, 'unproven');
});

test('an unqualified fixture loader cannot masquerade as a compatible context', async t => {
  await loadContextImplementation();
  const {dir} = ownedFixtureDir(t, 'compat-missing-process-source');
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'test/coverage-batches.test.ts'), 'testSlotProcessFacts(process.pid)!.start');
  const row = qualifyScopedContext({root: dir, files: ['test/coverage-batches.test.ts'], volume: dir, env: process.env});
  assert.equal(row.state, 'refused');
  assert.ok(row.reason, 'refusal must name its reason');
  assert.match(row.reason, /native-context-probe-unavailable/);
  assert.deepEqual(row.requiredFullSuitesRemain, ['test/coverage-batches.test.ts']);
  assert.equal(row.childClosure, 'closed');
});

test('the maintained scoped runner qualifies context after containment controls and before starting the suite', async () => {
  await loadContextImplementation();
  const source = readFileSync('scripts/lib/author-low-footprint.mjs', 'utf8');
  const control = source.indexOf("throw new Error('native write containment control failed')");
  const qualify = source.indexOf('receipt.contextCompatibility = qualifyScopedContext(');
  const suite = source.indexOf('judged = prepareJudgedRun(');
  assert.ok(control >= 0 && qualify > control && suite > qualify);
  assert.match(source, /contextCompatibility.state === 'refused'/);
  assert.match(source, /required full suites remain/);
});
